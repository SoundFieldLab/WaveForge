'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { hasWaveForgeDevMarkers, selectWaveForgeUserData } = require('../desktop/user-data-profile.cjs')

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-profile-'))
}

test('selects a marked legacy WaveForge development profile without copying it', () => {
  const root = fixture()
  const legacy = path.join(root, 'Electron')
  fs.mkdirSync(path.join(legacy, 'IndexedDB', 'http_127.0.0.1_3000.indexeddb.leveldb'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}')
  fs.writeFileSync(path.join(legacy, 'desktop-player-settings.json'), '{}')

  assert.equal(hasWaveForgeDevMarkers(legacy), true)
  assert.equal(selectWaveForgeUserData({ appDataRoot: root, isPackaged: false }), legacy)
  assert.equal(fs.existsSync(path.join(root, 'WaveForge 澜音工坊')), false)
  fs.rmSync(root, { recursive: true, force: true })
})

test('does not misidentify an unrelated Electron profile', () => {
  const root = fixture()
  const legacy = path.join(root, 'Electron')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'Preferences'), '{}')
  assert.equal(hasWaveForgeDevMarkers(legacy), false)
  assert.equal(selectWaveForgeUserData({ appDataRoot: root, isPackaged: false }), path.join(root, 'WaveForge 澜音工坊'))
  fs.rmSync(root, { recursive: true, force: true })
})

test('main process creates selected profile before setPath and launcher shares it with API services', () => {
  const root = path.resolve(__dirname, '..')
  const mainSource = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8')
  const launcherSource = fs.readFileSync(path.join(root, 'scripts/dev-electron.mjs'), 'utf8')
  const mkdirIndex = mainSource.indexOf("fs.mkdirSync(selectedUserDataPath, { recursive: true })")
  const setPathIndex = mainSource.indexOf("app.setPath('userData', selectedUserDataPath)")
  assert.ok(mkdirIndex >= 0 && setPathIndex > mkdirIndex)
  assert.match(launcherSource, /WAVEFORGE_USERDATA:\s*userDataRoot/)
  assert.match(launcherSource, /\.\.\.localServiceEnv/)
})

test('packaged builds always use the stable product profile and ignore overrides', () => {
  const root = fixture()
  const legacy = path.join(root, 'Electron')
  fs.mkdirSync(path.join(legacy, 'IndexedDB', 'http_127.0.0.1_3000.indexeddb.leveldb'), { recursive: true })
  fs.writeFileSync(path.join(legacy, 'config.json'), '{}')
  fs.writeFileSync(path.join(legacy, 'apple-web-cookies.json'), '{}')
  assert.equal(selectWaveForgeUserData({ appDataRoot: root, isPackaged: true, overridePath: legacy }), path.join(root, 'WaveForge 澜音工坊'))
  fs.rmSync(root, { recursive: true, force: true })
})
