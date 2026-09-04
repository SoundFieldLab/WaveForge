'use strict'

const fs = require('node:fs')
const path = require('node:path')

function hasWaveForgeDevMarkers(candidate, fsImpl = fs) {
  try {
    const hasConfig = fsImpl.existsSync(path.join(candidate, 'config.json'))
    const hasProductFile = ['desktop-player-settings.json', 'apple-web-cookies.json', 'remote-settings.json']
      .some(name => fsImpl.existsSync(path.join(candidate, name)))
    const indexedDb = path.join(candidate, 'IndexedDB')
    const hasDevOrigin = fsImpl.existsSync(indexedDb)
      && fsImpl.readdirSync(indexedDb).some(name => name.startsWith('http_127.0.0.1_3000'))
    return hasConfig && hasProductFile && hasDevOrigin
  } catch {
    return false
  }
}

function selectWaveForgeUserData({ appDataRoot, isPackaged, overridePath, fsImpl = fs }) {
  const stable = path.resolve(appDataRoot, 'WaveForge 澜音工坊')
  if (isPackaged) return stable
  if (overridePath && path.isAbsolute(overridePath)) return path.resolve(overridePath)
  const legacy = path.resolve(appDataRoot, 'Electron')
  return hasWaveForgeDevMarkers(legacy, fsImpl) ? legacy : stable
}

module.exports = { hasWaveForgeDevMarkers, selectWaveForgeUserData }
