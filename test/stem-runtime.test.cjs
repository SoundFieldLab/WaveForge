'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { StemRuntime, resolvePaths } = require('../desktop/stem-runtime.cjs')

function fixtureRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-stem-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function makeFixture(t, runnerSource) {
  const root = fixtureRoot(t)
  const modelPath = path.join(root, 'htdemucs.onnx')
  const pythonPath = path.join(root, process.platform === 'win32' ? 'python.exe' : 'python3')
  const runnerPath = path.join(root, 'runner.js')
  const inputPath = path.join(root, 'input.wav')
  fs.writeFileSync(modelPath, 'model')
  fs.copyFileSync(process.execPath, pythonPath)
  fs.writeFileSync(runnerPath, runnerSource)
  fs.writeFileSync(inputPath, 'audio')
  return { root, modelPath, pythonPath, runnerPath, inputPath }
}

function runtimeOptions(fixture, extra = {}) {
  return { ...fixture, isInputAllowed: () => true, ...extra }
}

const SUCCESS_RUNNER = String.raw`
const fs = require('fs'); const path = require('path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.mkdirSync(config.outputDir, { recursive: true });
const files = {};
for (const name of ['drums','bass','vocals','other']) { files[name] = path.join(config.outputDir, name + '.wav'); fs.writeFileSync(files[name], 'wav-' + name); }
const manifest = { frames: 100, sampleRate: 44100, channels: 2, files, validation: { lengthsMatch: true, finite: true } };
fs.writeFileSync(path.join(config.outputDir, 'manifest.json'), JSON.stringify(manifest));
console.log(JSON.stringify(manifest));
`

test('resolvePaths reports a missing optional model', () => {
  const paths = resolvePaths({ modelPath: path.join(os.tmpdir(), 'definitely-missing-htdemucs.onnx'), appInfo: {} })
  assert.equal(paths.modelPath, null)
})

test('missing model returns null', async t => {
  const root = fixtureRoot(t)
  const inputPath = path.join(root, 'input.wav')
  fs.writeFileSync(inputPath, 'audio')
  const runtime = new StemRuntime({
    modelPath: path.join(root, 'missing.onnx'),
    pythonPath: process.execPath,
    runnerPath: __filename,
    cachePath: path.join(root, 'cache'),
    appInfo: {},
  })
  assert.equal(await runtime.separate({ inputPath, mode: 'head', duration: 1 }), null)
  runtime.shutdown()
})

test('separates once and returns a validated cache hit', async t => {
  const fixture = makeFixture(t, SUCCESS_RUNNER)
  const runtime = new StemRuntime(runtimeOptions(fixture, { cachePath: path.join(fixture.root, 'cache'), appInfo: {} }))
  const first = await runtime.separate({ inputPath: fixture.inputPath, mode: 'tail', duration: 2, requestId: 'first' })
  assert.equal(first.cached, false)
  assert.equal(first.requestId, 'first')
  assert.equal(first.frames, 100)
  assert.ok(Object.values(first.files).every(file => fs.existsSync(file)))
  const second = await runtime.separate({ inputPath: fixture.inputPath, mode: 'tail', duration: 2, requestId: 'second' })
  assert.equal(second.cached, true)
  assert.equal(second.requestId, 'second')
  assert.equal(second.cacheKey, first.cacheKey)
  runtime.shutdown()
})

test('queue is serial and queued jobs can be cancelled', async t => {
  const marker = path.join(os.tmpdir(), `waveforge-stem-marker-${process.pid}-${Date.now()}.txt`).replace(/\\/g, '\\\\')
  t.after(() => fs.rmSync(marker, { force: true }))
  const runner = String.raw`
const fs = require('fs'); const path = require('path');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
fs.appendFileSync('${marker}', 'start\n');
setTimeout(() => {
  fs.mkdirSync(config.outputDir, { recursive: true }); const files = {};
  for (const name of ['drums','bass','vocals','other']) { files[name] = path.join(config.outputDir, name + '.wav'); fs.writeFileSync(files[name], 'wav'); }
  const manifest = { files, validation: { lengthsMatch: true, finite: true } };
  fs.writeFileSync(path.join(config.outputDir, 'manifest.json'), JSON.stringify(manifest)); console.log(JSON.stringify(manifest));
}, 150);
`
  const fixture = makeFixture(t, runner)
  const secondInput = path.join(fixture.root, 'second.wav')
  fs.writeFileSync(secondInput, 'audio2')
  const runtime = new StemRuntime(runtimeOptions(fixture, { cachePath: path.join(fixture.root, 'cache'), appInfo: {} }))
  const first = runtime.separate({ inputPath: fixture.inputPath, duration: 1, requestId: 'active' })
  const second = runtime.separate({ inputPath: secondInput, duration: 1, requestId: 'queued' })
  assert.equal(runtime.cancel('queued'), true)
  await assert.rejects(second, /cancelled/)
  await first
  assert.equal(fs.readFileSync(marker, 'utf8').trim().split(/\r?\n/).length, 1)
  runtime.shutdown()
})

test('active job can be cancelled', async t => {
  const fixture = makeFixture(t, 'setTimeout(() => {}, 10000)')
  const runtime = new StemRuntime(runtimeOptions(fixture, { cachePath: path.join(fixture.root, 'cache'), timeoutMs: 5000, appInfo: {} }))
  const pending = runtime.separate({ inputPath: fixture.inputPath, duration: 1, requestId: 'cancel-me' })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(runtime.cancel('cancel-me'), true)
  await assert.rejects(pending, /cancelled/)
  runtime.shutdown()
})

test('ordinary stem rejects input without shared authorization', async t => {
  const fixture = makeFixture(t, SUCCESS_RUNNER)
  const runtime = new StemRuntime({ ...fixture, cachePath: path.join(fixture.root, 'cache'), appInfo: {} })
  await assert.rejects(runtime.separate({ inputPath: fixture.inputPath, duration: 1 }), /not authorized/)
  runtime.shutdown()
})

test('cache cleanup removes expired entries', t => {
  const fixture = makeFixture(t, SUCCESS_RUNNER)
  const cachePath = path.join(fixture.root, 'cache')
  const runtime = new StemRuntime(runtimeOptions(fixture, { cachePath, cacheMaxBytes: 1000, cacheTtlMs: 100, appInfo: {} }))
  const expired = path.join(cachePath, 'expired')
  fs.mkdirSync(expired)
  fs.writeFileSync(path.join(expired, 'data'), 'old')
  const stamp = new Date(Date.now() - 1000)
  fs.utimesSync(expired, stamp, stamp)
  runtime.cleanupCache()
  assert.equal(fs.existsSync(expired), false)
  runtime.shutdown()
})

test('cache cleanup enforces capacity oldest first', t => {
  const fixture = makeFixture(t, SUCCESS_RUNNER)
  const cachePath = path.join(fixture.root, 'cache')
  const runtime = new StemRuntime(runtimeOptions(fixture, { cachePath, cacheMaxBytes: 15, cacheTtlMs: 100000, appInfo: {} }))
  for (const [name, age] of [['old', 2000], ['new', 1000]]) {
    const directory = path.join(cachePath, name)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'data'), Buffer.alloc(10))
    const stamp = new Date(Date.now() - age)
    fs.utimesSync(directory, stamp, stamp)
  }
  runtime.cleanupCache()
  assert.equal(fs.existsSync(path.join(cachePath, 'old')), false)
  assert.equal(fs.existsSync(path.join(cachePath, 'new')), true)
  runtime.shutdown()
})
