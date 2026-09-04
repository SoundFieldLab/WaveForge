'use strict'

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const test = require('node:test')
const Module = require('module')

const originalLoad = Module._load
Module._load = function mockedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: { getPath: name => name === 'exe' ? path.join(os.tmpdir(), 'WaveForge.exe') : os.tmpdir() },
      BrowserWindow: { getAllWindows: () => [] },
      net: { request: () => { throw new Error('network is not used by unit tests') } },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const manager = require('../desktop/stem-model-manager.cjs')
Module._load = originalLoad

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-stem-model-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('manifest pins HTDemucs and runtime with mirror-first URLs', () => {
  const manifest = manager._manifest
  assert.equal(manifest.version, 1)
  assert.match(manifest.mirrors[0], /^https:\/\/hf-mirror\.com\//)
  const model = manifest.assets.find(asset => asset.name === 'htdemucs')
  const runtime = manifest.assets.find(asset => asset.name === 'runtime')
  assert.equal(model.bytes, 108644650)
  assert.equal(model.sha256, '099b5be76c1f6922124d07f850250f39d1f33f254a0b8cc90f4ec0dfd0912329')
  assert.equal(runtime.bytes, 35633855)
  assert.equal(runtime.sha256, '50a5829ac928071ab2eecaf2667e5dab9c3af2b4b44fb5bb4b7acfb9863cdacd')
})

test('verify requires both exact byte length and sha256', async t => {
  const root = tempRoot(t)
  const file = path.join(root, 'asset.bin')
  const bytes = Buffer.from('verified-model-asset')
  fs.writeFileSync(file, bytes)
  const asset = {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
  assert.equal(await manager.verify(file, asset), true)
  assert.equal(await manager.verify(file, { ...asset, bytes: bytes.length + 1 }), false)
  assert.equal(await manager.verify(file, { ...asset, sha256: '0'.repeat(64) }), false)
})

test('safe zip entries must remain inside the staging directory', () => {
  const root = path.join(os.tmpdir(), 'waveforge-stem-stage')
  assert.doesNotThrow(() => manager.assertSafeZip({
    getEntries: () => [{ entryName: 'runtime/python.exe' }, { entryName: 'runtime/Lib/site.py' }],
  }, root))
  assert.throws(() => manager.assertSafeZip({
    getEntries: () => [{ entryName: '../outside.exe' }],
  }, root), /Unsafe archive entry/)
  assert.throws(() => manager.assertSafeZip({
    getEntries: () => [{ entryName: 'runtime/../../outside.exe' }],
  }, root), /Unsafe archive entry/)
})

test('status exposes a normal optional fallback when assets are absent', () => {
  const status = manager.snapshot()
  assert.equal(typeof status.installed, 'boolean')
  assert.equal(typeof status.modelReady, 'boolean')
  assert.equal(typeof status.runtimeReady, 'boolean')
  assert.equal(status.download.status, 'idle')
})
