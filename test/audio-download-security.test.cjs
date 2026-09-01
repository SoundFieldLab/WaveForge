'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { pathToFileURL } = require('url')
const { AudioDownloadService } = require('../desktop/audio-download.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-audio-path-test-'))
  const cache = path.join(root, 'cache')
  const outside = path.join(root, 'outside')
  fs.mkdirSync(outside)
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, cache, outside, service: new AudioDownloadService(cache) }
}

test('rejects unselected system paths, file URLs, and UNC paths', async t => {
  const { service } = fixture(t)
  const systemFile = process.execPath
  await assert.rejects(service.prepareAudioFile(systemFile, 'system-path'), /not authorized/)
  await assert.rejects(service.prepareAudioFile(pathToFileURL(systemFile).href, 'file-url'), /not authorized/)
  await assert.rejects(service.prepareAudioFile('\\\\localhost\\C$\\Windows\\win.ini', 'unc'), /Invalid audio path|not authorized/)
})

test('allows an explicitly selected local file by canonical path', async t => {
  const { outside, service } = fixture(t)
  const selected = path.join(outside, 'selected.wav')
  fs.writeFileSync(selected, 'audio')
  const authorized = service.authorizeLocalFile(selected)
  assert.equal(await service.prepareAudioFile(selected, 'selected'), authorized)
  assert.equal(await service.prepareAudioFile(pathToFileURL(selected).href, 'selected-url'), authorized)
})

test('allows files under the controlled cache root', async t => {
  const { cache, service } = fixture(t)
  const cached = path.join(cache, 'cached.wav')
  fs.writeFileSync(cached, 'audio')
  assert.equal(await service.prepareAudioFile(cached, 'cached'), fs.realpathSync.native(cached))
})

test('rejects a cache junction or symlink that resolves outside the cache', async t => {
  const { cache, outside, service } = fixture(t)
  const secret = path.join(outside, 'secret.wav')
  const link = path.join(cache, 'escape')
  fs.writeFileSync(secret, 'secret')
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`link creation is unavailable: ${error.code || error.message}`)
    return
  }
  const escaped = path.join(link, 'secret.wav')
  assert.equal(service.isInsideTempRoot(escaped), false)
  await assert.rejects(service.prepareAudioFile(escaped, 'escaped'), /not authorized/)
})

test('remote downloads are materialized inside the controlled cache', async t => {
  const { service } = fixture(t)
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'audio/wav' })
    response.end(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const downloaded = await service.prepareAudioFile(`http://127.0.0.1:${port}/track`, 'remote')
  assert.equal(service.isInsideTempRoot(downloaded), true)
  assert.equal(service.isInputAllowed(downloaded), true)
})
