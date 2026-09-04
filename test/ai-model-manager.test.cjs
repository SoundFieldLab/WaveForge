'use strict'

const assert = require('assert')
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
      net: { request: () => { throw new Error('network is not used by this test') } },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const manager = require('../desktop/ai-model-manager.cjs')
Module._load = originalLoad

test('DJTransGAN optional asset identity is pinned', () => {
  assert.equal(manager._assetInfo.repoRef, '64228931f3b4514f289fbbbc0e5675adb57aeb88')
  assert.equal(manager._assetInfo.repoArchiveBytes, 72523006)
  assert.equal(manager._assetInfo.repoArchiveSha256, 'c2a938c0868e83c85d7c1c6c8408b7335d7b6906dd6f0180b9e22efbd8616894')
  assert.equal(manager._assetInfo.weightsBytes, 139935693)
  assert.equal(manager._assetInfo.weightsSha256, '495987d70bd873fb94838b3af705be85d368a6639659f2ffcc2b05a9740e8fd2')
})

test('DJTransGAN archive extraction rejects path traversal entries', () => {
  const root = path.join(os.tmpdir(), 'waveforge-dj-stage')
  assert.doesNotThrow(() => manager._assertSafeArchive({ getEntries: () => [{ entryName: 'repo/djtransgan/model.py' }] }, root))
  assert.throws(() => manager._assertSafeArchive({ getEntries: () => [{ entryName: '../payload.py' }] }, root), /不安全路径/)
})
