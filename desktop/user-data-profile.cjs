'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const PRODUCT_PROFILE_NAME = 'WaveForge 澜音工坊'
const LEGACY_PROFILE_NAME = 'Electron'
const MIGRATION_VERSION = 1
const MIGRATION_MARKER = `.waveforge-profile-migration-v${MIGRATION_VERSION}.json`
const MIGRATION_LOCK = `.waveforge-profile-migration-v${MIGRATION_VERSION}.lock`
const MIGRATION_BACKUP = `.waveforge-profile-migration-v${MIGRATION_VERSION}-backup`
const DEV_ORIGIN_DIRECTORY = 'http_127.0.0.1_3000.indexeddb.leveldb'

const PRODUCT_FILES = [
  'config.json',
  'performance-settings.json',
  'shortcut-settings.json',
  'desktop-player-settings.json',
  'desktop-lyrics-settings.json',
  'taskbar-widget-settings.json',
  'remote-settings.json',
  'window-state.json',
  '.oobe-complete',
  'secure-credentials.json',
  'device-license.json',
  'qq-cookie.txt',
  'soda-qr-login.json',
  'apple-web-cookies.json',
  'Local State',
  'Preferences',
]

const PROFILE_GROUPS = [
  'Local Storage/leveldb',
  `IndexedDB/${DEV_ORIGIN_DIRECTORY}`,
  'Partitions/mineradio-qishui-auth-v6',
  'apple-bridge-profile',
]

function isFile(candidate, fsImpl = fs) {
  try { return fsImpl.statSync(candidate).isFile() } catch { return false }
}

function isDirectory(candidate, fsImpl = fs) {
  try { return fsImpl.statSync(candidate).isDirectory() } catch { return false }
}

function hasWaveForgeDevMarkers(candidate, fsImpl = fs) {
  try {
    const indexedDb = path.join(candidate, 'IndexedDB', DEV_ORIGIN_DIRECTORY)
    if (isDirectory(indexedDb, fsImpl)) return true
    return [
      'config.json',
      'desktop-player-settings.json',
      'apple-web-cookies.json',
      'remote-settings.json',
      'secure-credentials.json',
      'qq-cookie.txt',
      'soda-qr-login.json',
    ].some(name => isFile(path.join(candidate, name), fsImpl))
  } catch {
    return false
  }
}

function selectWaveForgeUserData({ appDataRoot, isPackaged, overridePath }) {
  const stable = path.resolve(appDataRoot, PRODUCT_PROFILE_NAME)
  if (isPackaged) return stable
  if (overridePath && path.isAbsolute(overridePath)) return path.resolve(overridePath)
  return stable
}

function hasActiveProfileLock(candidate, platform = process.platform, fsImpl = fs) {
  const levelDbLock = path.join(candidate, 'Local Storage', 'leveldb', 'LOCK')
  if (platform === 'win32' && fsImpl === fs && isFile(levelDbLock, fsImpl)) {
    const script = `$p=$env:WAVEFORGE_PROFILE_LOCK; try { $s=[System.IO.File]::Open($p,'Open','ReadWrite','None'); $s.Dispose(); exit 0 } catch { exit 1 }`
    const probe = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, WAVEFORGE_PROFILE_LOCK: levelDbLock },
    })
    return probe.status === 1
  }
  return ['SingletonLock', 'SingletonCookie', 'SingletonSocket']
    .some(name => fsImpl.existsSync(path.join(candidate, name)))
}

function shouldSkipProfileEntry(relativePath) {
  const name = path.basename(relativePath)
  return name === 'LOCK'
    || name === 'LOG'
    || name === 'LOG.old'
    || name.startsWith('Singleton')
    || name.endsWith('.tmp')
    || name.endsWith('-journal')
}

function copyTree(source, target, fsImpl = fs, relativePath = '') {
  const sourceStats = fsImpl.lstatSync(source)
  if (sourceStats.isSymbolicLink()) return
  if (shouldSkipProfileEntry(relativePath)) return
  if (sourceStats.isDirectory()) {
    fsImpl.mkdirSync(target, { recursive: true })
    for (const name of fsImpl.readdirSync(source)) {
      const childRelative = relativePath ? path.join(relativePath, name) : name
      copyTree(path.join(source, name), path.join(target, name), fsImpl, childRelative)
    }
    return
  }
  if (!sourceStats.isFile()) return
  fsImpl.mkdirSync(path.dirname(target), { recursive: true })
  fsImpl.copyFileSync(source, target)
}

function removeIfExists(candidate, fsImpl = fs) {
  if (fsImpl.existsSync(candidate)) fsImpl.rmSync(candidate, { recursive: true, force: true })
}

function moveExistingToBackup(target, backup, fsImpl = fs) {
  if (!fsImpl.existsSync(target)) return false
  if (!fsImpl.existsSync(backup)) {
    fsImpl.mkdirSync(path.dirname(backup), { recursive: true })
    fsImpl.renameSync(target, backup)
  } else {
    removeIfExists(target, fsImpl)
  }
  return true
}

function installFromLegacy(source, target, stagingRoot, backupRoot, relativePath, fsImpl = fs) {
  const sourcePath = path.join(source, relativePath)
  if (!fsImpl.existsSync(sourcePath)) return null
  const stagingPath = path.join(stagingRoot, relativePath)
  const targetPath = path.join(target, relativePath)
  const backupPath = path.join(backupRoot, relativePath)
  copyTree(sourcePath, stagingPath, fsImpl, relativePath)
  const replaced = moveExistingToBackup(targetPath, backupPath, fsImpl)
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true })
  fsImpl.renameSync(stagingPath, targetPath)
  return { path: relativePath.replaceAll('\\', '/'), replaced }
}

function migrateNetworkCookies(source, target, stagingRoot, backupRoot, fsImpl = fs) {
  const cookieFiles = ['Cookies', 'Cookies-wal', 'Cookies-shm']
  const available = cookieFiles.filter(name => fsImpl.existsSync(path.join(source, 'Network', name)))
  if (available.length === 0) return []
  const results = []
  for (const name of available) {
    const result = installFromLegacy(source, target, stagingRoot, backupRoot, path.join('Network', name), fsImpl)
    if (result) results.push(result)
  }
  return results
}

function normalizeMigratedConfig(stable, legacy, fsImpl = fs) {
  const configPath = path.join(stable, 'config.json')
  if (!isFile(configPath, fsImpl)) return
  try {
    const config = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'))
    const oldDefault = path.resolve(legacy, 'cache')
    if (typeof config.cachePath !== 'string' || path.resolve(config.cachePath) !== oldDefault) return
    config.cachePath = path.resolve(stable, 'cache')
    fsImpl.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  } catch { /* Invalid legacy config remains untouched for the normal loader to handle. */ }
}

function migrateLegacyWaveForgeProfile({ appDataRoot, isPackaged, overridePath, platform = process.platform, fsImpl = fs }) {
  const stable = path.resolve(appDataRoot, PRODUCT_PROFILE_NAME)
  const legacy = path.resolve(appDataRoot, LEGACY_PROFILE_NAME)
  const markerPath = path.join(stable, MIGRATION_MARKER)
  const lockPath = path.join(stable, MIGRATION_LOCK)
  const backupRoot = path.join(stable, MIGRATION_BACKUP)
  const stagingRoot = path.join(stable, `.waveforge-profile-migration-v${MIGRATION_VERSION}-staging`)

  if (isPackaged || platform !== 'win32' || (overridePath && path.isAbsolute(overridePath))) {
    return { userDataPath: selectWaveForgeUserData({ appDataRoot, isPackaged, overridePath }), status: 'skipped' }
  }
  fsImpl.mkdirSync(stable, { recursive: true })
  if (fsImpl.existsSync(markerPath)) return { userDataPath: stable, status: 'complete' }
  if (!hasWaveForgeDevMarkers(legacy, fsImpl)) return { userDataPath: stable, status: 'no-legacy-profile' }
  if (hasActiveProfileLock(legacy, platform, fsImpl) || hasActiveProfileLock(stable, platform, fsImpl)) {
    return { userDataPath: stable, status: 'profile-active' }
  }

  let lockFd
  try {
    lockFd = fs.openSync(lockPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') return { userDataPath: stable, status: 'migration-in-progress' }
    throw error
  }

  const migrated = []
  try {
    removeIfExists(stagingRoot, fsImpl)
    fsImpl.mkdirSync(stagingRoot, { recursive: true })
    for (const relativePath of PRODUCT_FILES) {
      const result = installFromLegacy(legacy, stable, stagingRoot, backupRoot, relativePath, fsImpl)
      if (result) migrated.push(result)
    }
    for (const relativePath of PROFILE_GROUPS) {
      const result = installFromLegacy(legacy, stable, stagingRoot, backupRoot, relativePath, fsImpl)
      if (result) migrated.push(result)
    }
    migrated.push(...migrateNetworkCookies(legacy, stable, stagingRoot, backupRoot, fsImpl))
    normalizeMigratedConfig(stable, legacy, fsImpl)
    const marker = {
      version: MIGRATION_VERSION,
      source: legacy,
      migratedAt: new Date().toISOString(),
      migrated,
      backup: fsImpl.existsSync(backupRoot) ? backupRoot : null,
    }
    const markerTemp = `${markerPath}.tmp`
    fsImpl.writeFileSync(markerTemp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
    fsImpl.renameSync(markerTemp, markerPath)
    return { userDataPath: stable, status: 'migrated', marker }
  } finally {
    removeIfExists(stagingRoot, fsImpl)
    try {
      if (lockFd !== undefined) fs.closeSync(lockFd)
    } finally {
      try { fs.unlinkSync(lockPath) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
  }
}

function prepareWaveForgeUserData(options) {
  return migrateLegacyWaveForgeProfile(options)
}

module.exports = {
  DEV_ORIGIN_DIRECTORY,
  MIGRATION_BACKUP,
  MIGRATION_MARKER,
  hasActiveProfileLock,
  hasWaveForgeDevMarkers,
  migrateLegacyWaveForgeProfile,
  prepareWaveForgeUserData,
  selectWaveForgeUserData,
}
