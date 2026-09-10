'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  DEV_ORIGIN_DIRECTORY,
  MIGRATION_BACKUP,
  MIGRATION_MARKER,
  hasWaveForgeDevMarkers,
  prepareWaveForgeUserData,
  selectWaveForgeUserData,
} = require('../desktop/user-data-profile.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-profile-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function write(root, relativePath, content) {
  const target = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

function markedLegacy(root) {
  const legacy = path.join(root, 'Electron')
  write(legacy, path.join('IndexedDB', DEV_ORIGIN_DIRECTORY, 'CURRENT'), 'MANIFEST-000001\n')
  return legacy
}

test('recognizes the exact WaveForge development origin without requiring product files', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  assert.equal(hasWaveForgeDevMarkers(legacy), true)

  const lookalike = path.join(root, 'Lookalike')
  fs.mkdirSync(path.join(lookalike, 'IndexedDB', 'http_127.0.0.1_30000.indexeddb.leveldb'), { recursive: true })
  assert.equal(hasWaveForgeDevMarkers(lookalike), false)
})

test('migrates legacy login storage into the stable profile and keeps the source', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  const stable = path.join(root, 'WaveForge 澜音工坊')
  write(legacy, path.join('Local Storage', 'leveldb', '000003.ldb'), 'netease_cookie qq_cookie')
  write(legacy, 'config.json', JSON.stringify({ cachePath: path.join(legacy, 'cache') }))

  const result = prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' })

  assert.equal(result.status, 'migrated')
  assert.equal(result.userDataPath, stable)
  assert.equal(fs.readFileSync(path.join(stable, 'Local Storage', 'leveldb', '000003.ldb'), 'utf8'), 'netease_cookie qq_cookie')
  assert.equal(fs.existsSync(path.join(legacy, 'Local Storage', 'leveldb', '000003.ldb')), true)
  assert.equal(JSON.parse(fs.readFileSync(path.join(stable, 'config.json'), 'utf8')).cachePath, path.join(stable, 'cache'))
  assert.equal(fs.existsSync(path.join(stable, MIGRATION_MARKER)), true)
})

test('backs up conflicting stable data before restoring the legacy profile', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  const stable = path.join(root, 'WaveForge 澜音工坊')
  write(legacy, path.join('Local Storage', 'leveldb', '000003.ldb'), 'legacy-login')
  write(stable, path.join('Local Storage', 'leveldb', '000004.ldb'), 'new-empty-profile')

  const result = prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' })

  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(stable, 'Local Storage', 'leveldb', '000003.ldb'), 'utf8'), 'legacy-login')
  assert.equal(fs.readFileSync(path.join(stable, MIGRATION_BACKUP, 'Local Storage', 'leveldb', '000004.ldb'), 'utf8'), 'new-empty-profile')
})

test('completed migration is idempotent', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  const stable = path.join(root, 'WaveForge 澜音工坊')
  write(legacy, path.join('Local Storage', 'leveldb', '000003.ldb'), 'first')
  assert.equal(prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' }).status, 'migrated')
  const markerBefore = fs.readFileSync(path.join(stable, MIGRATION_MARKER), 'utf8')

  write(legacy, path.join('Local Storage', 'leveldb', '000003.ldb'), 'changed-later')
  write(legacy, path.join('Local Storage', 'leveldb', '000005.ldb'), 'new-later')
  const second = prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' })

  assert.equal(second.status, 'complete')
  assert.equal(fs.readFileSync(path.join(stable, 'Local Storage', 'leveldb', '000003.ldb'), 'utf8'), 'first')
  assert.equal(fs.existsSync(path.join(stable, 'Local Storage', 'leveldb', '000005.ldb')), false)
  assert.equal(fs.readFileSync(path.join(stable, MIGRATION_MARKER), 'utf8'), markerBefore)
})

test('does not write a completion marker when copying fails', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  const stable = path.join(root, 'WaveForge 澜音工坊')
  write(legacy, path.join('Local Storage', 'leveldb', '000003.ldb'), 'login')
  const failingFs = Object.create(fs)
  failingFs.copyFileSync = (source, target) => {
    if (source.endsWith('000003.ldb')) {
      const error = new Error('simulated copy failure')
      error.code = 'EIO'
      throw error
    }
    return fs.copyFileSync(source, target)
  }

  assert.throws(
    () => prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32', fsImpl: failingFs }),
    /simulated copy failure/,
  )
  assert.equal(fs.existsSync(path.join(stable, MIGRATION_MARKER)), false)
  assert.equal(fs.existsSync(path.join(stable, '.waveforge-profile-migration-v1.lock')), false)
})

test('defers migration while either profile has an active lock', (t) => {
  const root = fixture(t)
  const legacy = markedLegacy(root)
  write(legacy, 'SingletonLock', 'active')
  const result = prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' })
  assert.equal(result.status, 'profile-active')
  assert.equal(fs.existsSync(path.join(root, 'WaveForge 澜音工坊', MIGRATION_MARKER)), false)

  fs.rmSync(path.join(legacy, 'SingletonLock'))
  write(path.join(root, 'WaveForge 澜音工坊'), 'SingletonLock', 'active')
  const stableResult = prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' })
  assert.equal(stableResult.status, 'profile-active')
})

test('does not migrate unrelated profiles, packaged runs, or explicit overrides', (t) => {
  const root = fixture(t)
  const unrelated = path.join(root, 'Electron')
  write(unrelated, 'Preferences', '{}')
  const stable = path.join(root, 'WaveForge 澜音工坊')
  const override = path.join(root, 'CustomProfile')

  assert.equal(hasWaveForgeDevMarkers(unrelated), false)
  assert.deepEqual(
    prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, platform: 'win32' }),
    { userDataPath: stable, status: 'no-legacy-profile' },
  )
  assert.deepEqual(
    prepareWaveForgeUserData({ appDataRoot: root, isPackaged: true, overridePath: override, platform: 'win32' }),
    { userDataPath: stable, status: 'skipped' },
  )
  assert.deepEqual(
    prepareWaveForgeUserData({ appDataRoot: root, isPackaged: false, overridePath: override, platform: 'win32' }),
    { userDataPath: override, status: 'skipped' },
  )
  assert.equal(selectWaveForgeUserData({ appDataRoot: root, isPackaged: false }), stable)
})

test('launcher and main process prepare the profile before using it', () => {
  const root = path.resolve(__dirname, '..')
  const mainSource = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8')
  const launcherSource = fs.readFileSync(path.join(root, 'scripts/dev-electron.mjs'), 'utf8')
  const prepareMainIndex = mainSource.indexOf('const profilePreparation = prepareWaveForgeUserData(')
  const setPathIndex = mainSource.indexOf("app.setPath('userData', selectedUserDataPath)")
  const prepareLauncherIndex = launcherSource.indexOf('const profilePreparation = prepareWaveForgeUserData(')
  const readConfigIndex = launcherSource.indexOf("readFileSync(resolve(userDataRoot, 'config.json')")

  assert.ok(prepareMainIndex >= 0 && setPathIndex > prepareMainIndex)
  assert.ok(prepareLauncherIndex >= 0 && readConfigIndex > prepareLauncherIndex)
  assert.match(launcherSource, /WAVEFORGE_USERDATA:\s*userDataRoot/)
  assert.match(launcherSource, /WAVEFORGE_USER_DATA:\s*userDataRoot/)
})
