'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { TrackStemRuntime } = require('../desktop/track-stem-runtime.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-track-stem-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const modelPath = path.join(root, 'htdemucs.onnx')
  const inputPath = path.join(root, 'track.wav')
  const runnerPath = path.join(root, 'runner.py')
  fs.writeFileSync(modelPath, 'model')
  fs.writeFileSync(inputPath, 'audio')
  fs.writeFileSync(runnerPath, 'runner')
  return { root, modelPath, inputPath, runnerPath, pythonPath: process.execPath }
}

class FakeRuntime extends TrackStemRuntime {
  constructor(options) {
    super({ ...options, isInputAllowed: options.isInputAllowed || (() => true) })
    this.started = []
    this.blockFirst = null
  }

  async _workerRequest(request) {
    this.started.push(request.coreStart)
    if (this.blockFirst && this.started.length === 1) await this.blockFirst
    const frames = Math.round(request.coreDuration * request.sampleRate)
    const chunkFrames = request.chunkSeconds * request.sampleRate
    const chunks = []
    for (let offset = 0; offset < frames; offset += chunkFrames) {
      const count = Math.min(chunkFrames, frames - offset)
      const start = request.coreStart + offset / request.sampleRate
      const id = `${Math.round(start * 1000).toString().padStart(12, '0')}-${count.toString().padStart(9, '0')}`
      const directory = path.join(request.outputDir, id)
      fs.mkdirSync(directory, { recursive: true })
      const files = {}
      for (const stem of ['drums', 'bass', 'vocals', 'other']) {
        files[stem] = path.join(directory, `${stem}.wav`)
        fs.writeFileSync(files[stem], `${stem}:${start}`)
      }
      chunks.push({ id, startSeconds: start, duration: count / request.sampleRate, frames: count, files })
    }
    return {
      chunks,
      validation: { lengthsMatch: true, finite: true, reconstructsMix: true },
    }
  }
}

test('missing model is reported and materialize returns null', async t => {
  const data = fixture(t)
  fs.rmSync(data.modelPath)
  const runtime = new TrackStemRuntime({ ...data, cachePath: path.join(data.root, 'cache'), appInfo: {} })
  assert.equal(runtime.status().reason, 'model-not-found')
  assert.equal(await runtime.materialize({ inputPath: data.inputPath, windows: [{ start: 0, duration: 5 }] }), null)
  runtime.shutdown()
})

test('cache key includes input/model metadata, sample rate and chunk size', t => {
  const data = fixture(t)
  const runtime = new FakeRuntime({ ...data, cachePath: path.join(data.root, 'cache'), appInfo: {} })
  const base = runtime._normalizeRequest({ inputPath: data.inputPath, windows: [{ start: 0, duration: 5 }] })
  const first = runtime._cacheKey(base)
  assert.notEqual(first, runtime._cacheKey({ ...base, chunkSeconds: 10 }))
  fs.appendFileSync(data.inputPath, 'changed')
  assert.notEqual(first, runtime._cacheKey(base))
  const beforeModel = runtime._cacheKey(base)
  fs.appendFileSync(data.modelPath, 'changed')
  assert.notEqual(beforeModel, runtime._cacheKey(base))
  runtime.shutdown()
})

test('materializes 20 second cores, writes an atomic manifest, and reuses cache', async t => {
  const data = fixture(t)
  const cachePath = path.join(data.root, 'cache')
  const runtime = new FakeRuntime({ ...data, cachePath, appInfo: {} })
  const request = {
    inputPath: data.inputPath,
    trackId: 'track',
    generationToken: 'g1',
    chunkSeconds: 5,
    windows: [{ start: 3, duration: 27 }],
  }
  const first = await runtime.materialize(request)
  assert.deepEqual(runtime.started, [3, 23])
  assert.equal(first.chunks.length, 6)
  assert.equal(first.chunks.at(-1).duration, 2)
  assert.equal(first.cached, false)
  assert.ok(fs.existsSync(first.manifestPath))
  assert.equal(JSON.parse(fs.readFileSync(first.manifestPath, 'utf8')).chunks.length, 6)
  assert.deepEqual(fs.readdirSync(path.dirname(first.manifestPath)).filter(name => name.endsWith('.tmp')), [])
  const second = await runtime.materialize({ ...request, requestId: 'cached' })
  assert.equal(second.cached, true)
  assert.equal(second.requestId, 'cached')
  assert.deepEqual(runtime.started, [3, 23])
  runtime.shutdown()
})

test('rejects renderer-provided input paths that were not authorized by audioDownload', async t => {
  const data = fixture(t)
  const runtime = new TrackStemRuntime({ ...data, cachePath: path.join(data.root, 'cache'), appInfo: {}, isInputAllowed: () => false })
  await assert.rejects(
    runtime.ensureWindow({ inputPath: data.inputPath, trackId: 'blocked', generationToken: 'g1', start: 0, duration: 5 }),
    /not authorized/,
  )
  runtime.shutdown()
})

test('readChunk only reads bounded WAV files inside the track-stem cache', async t => {
  const data = fixture(t)
  const cachePath = path.join(data.root, 'cache')
  const runtime = new FakeRuntime({ ...data, cachePath, appInfo: {} })
  const manifest = await runtime.ensureWindow({ inputPath: data.inputPath, trackId: 'read', generationToken: 'g1', start: 0, duration: 5 })
  const file = manifest.chunks[0].files.vocals
  const bytes = await runtime.readChunk(file)
  assert.ok(bytes.byteLength > 0)
  await assert.rejects(runtime.readChunk(path.join(data.root, 'outside.wav')), /outside the cache|ENOENT/)
  runtime.shutdown()
})

test('current window priority jumps queued work and queued requests cancel', async t => {
  const data = fixture(t)
  const runtime = new FakeRuntime({ ...data, cachePath: path.join(data.root, 'cache'), appInfo: {} })
  let release
  runtime.blockFirst = new Promise(resolve => { release = resolve })
  const background = runtime.materialize({
    inputPath: data.inputPath,
    trackId: 'track',
    generationToken: 'g1',
    requestId: 'background',
    priority: 1,
    windows: [{ start: 0, duration: 40 }],
  })
  const backgroundResult = background.then(() => 'completed', error => error.message)
  await new Promise(resolve => setImmediate(resolve))
  const current = runtime.ensureWindow({
    inputPath: data.inputPath,
    trackId: 'track',
    generationToken: 'g1',
    requestId: 'current',
    start: 100,
    duration: 5,
  })
  const cancelled = runtime.materialize({
    inputPath: data.inputPath,
    trackId: 'other',
    generationToken: 'g1',
    requestId: 'cancel-me',
    windows: [{ start: 60, duration: 5 }],
  })
  assert.equal(runtime.cancel('cancel-me'), true)
  await assert.rejects(cancelled, /cancelled/)
  release()
  await current
  assert.match(await backgroundResult, /cancelled/)
  assert.deepEqual(runtime.started, [0, 100])
  runtime.shutdown()
})

test('new generation rejects stale work without publishing its manifest', async t => {
  const data = fixture(t)
  const runtime = new FakeRuntime({ ...data, cachePath: path.join(data.root, 'cache'), appInfo: {} })
  let release
  runtime.blockFirst = new Promise(resolve => { release = resolve })
  const stale = runtime.materialize({
    inputPath: data.inputPath,
    trackId: 'track',
    generationToken: 'old',
    windows: [{ start: 0, duration: 5 }],
  })
  await new Promise(resolve => setImmediate(resolve))
  const current = runtime.materialize({
    inputPath: data.inputPath,
    trackId: 'track',
    generationToken: 'new',
    windows: [{ start: 20, duration: 5 }],
  })
  release()
  await assert.rejects(stale, /stale|cancelled/)
  const manifest = await current
  assert.deepEqual(manifest.chunks.map(chunk => chunk.startSeconds), [20])
  runtime.shutdown()
})
