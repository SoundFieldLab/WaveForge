'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isAllowedUpdateUrl,
  validateUpdateRequest,
  assertSafeZipEntries,
} = require('../desktop/update-manager.cjs')

const HASH = 'a'.repeat(64)

test('update URLs are restricted to audited HTTPS release hosts', () => {
  assert.equal(isAllowedUpdateUrl('https://github.com/SoundFieldLab/WaveForge/releases/download/v1/app.exe'), true)
  assert.equal(isAllowedUpdateUrl('https://ghproxy.net/https://github.com/SoundFieldLab/WaveForge/releases/download/v1/app.exe'), true)
  assert.equal(isAllowedUpdateUrl('https://gitee.com/kirito666233/wave-forge/releases/download/v1/app.exe'), true)
  assert.equal(isAllowedUpdateUrl('http://github.com/example.exe'), false)
  assert.equal(isAllowedUpdateUrl('https://github.com.evil.example/app.exe'), false)
  assert.equal(isAllowedUpdateUrl('file:///C:/Windows/System32/calc.exe'), false)
})

test('update requests require a full SHA-256 digest', () => {
  const officialZip = 'https://github.com/SoundFieldLab/WaveForge/releases/download/v1/file.zip'
  assert.deepEqual(validateUpdateRequest([officialZip], HASH), [officialZip])
  assert.throws(() => validateUpdateRequest([officialZip], ''), /SHA-256/)
  assert.throws(() => validateUpdateRequest([officialZip], 'abc'), /SHA-256/)
  assert.throws(() => validateUpdateRequest(['https://evil.example/file.zip'], HASH), /允许/)
  // host 在白名单内但仓库不是官方的：拒绝（防任意仓库附件伪装成更新包）
  assert.throws(() => validateUpdateRequest(['https://github.com/evil/repo/releases/download/v1/file.zip'], HASH), /允许/)
})

test('zip validation rejects traversal, absolute paths and oversized archives', () => {
  const zip = entries => ({ getEntries: () => entries.map(([entryName, size]) => ({ entryName, header: { size } })) })
  assert.doesNotThrow(() => assertSafeZipEntries(zip([['app.asar', 10], ['assets/a.js', 20]]), 'C:/safe'))
  assert.throws(() => assertSafeZipEntries(zip([['../escape.exe', 1]]), 'C:/safe'), /不安全路径/)
  assert.throws(() => assertSafeZipEntries(zip([['/absolute.exe', 1]]), 'C:/safe'), /不安全路径/)
  assert.throws(() => assertSafeZipEntries(zip([['huge.bin', 513 * 1024 * 1024]]), 'C:/safe'), /体积/)
})
