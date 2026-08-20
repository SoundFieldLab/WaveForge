'use strict'
// ===== AirPlay 投送端 IPC 注册 =====
// 渲染进程通道（window.electron.airplay.*）：
//   list-devices / get-status / connect / disconnect / set-volume / set-metadata / set-progress
//   pcm（高频 send） / status（main -> renderer 状态推送）
const { AirplaySenderService } = require('./airplay-sender-service.cjs')

function setupAirplayIpc({ ipcMain, getMainWindow }) {
  const service = new AirplaySenderService({
    debug: process.env.WF_AIRPLAY_DEBUG === '1',
    onStatus: (status) => {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      if (win && !win.isDestroyed()) {
        win.webContents.send('airplay:status', status)
      }
    },
  })
  // 默认不开启设备发现：由设置-高级「AirPlay 投送」开关控制（airplay:set-enabled）

  ipcMain.handle('airplay:set-enabled', (_event, enabled) => {
    return service.setEnabled(enabled === true)
  })
  ipcMain.handle('airplay:list-devices', () => {
    service.ensureBrowsing()
    return service.listDevices()
  })
  ipcMain.handle('airplay:get-status', () => {
    return service.getStatus()
  })
  ipcMain.handle('airplay:connect', (_event, deviceId, mode = 'auto') => {
    service.ensureBrowsing()
    return service.connect(deviceId, mode)
  })
  ipcMain.handle('airplay:disconnect', () => {
    service.disconnect()
    return { success: true }
  })
  ipcMain.handle('airplay:set-volume', (_event, volume) => {
    service.setVolume(volume)
    return { success: true }
  })
  ipcMain.handle('airplay:set-restore-volume', (_event, volume) => {
    service.setRestoreVolume(volume)
    return { success: true }
  })
  ipcMain.handle('airplay:set-metadata', (_event, metadata) => {
    service.setMetadata(metadata || {})
    return { success: true }
  })
  ipcMain.handle('airplay:set-progress', (_event, elapsed, duration) => {
    service.setProgress(Number(elapsed) || 0, Number(duration) || 0)
    return { success: true }
  })
  ipcMain.handle('airplay:play-connect-sound', () => {
    service.playConnectSound()
    return { success: true }
  })
  ipcMain.on('airplay:pcm', (_event, chunk) => {
    service.sendPcm(chunk)
  })
  ipcMain.on('airplay:set-streaming', (_event, streaming) => {
    service.setStreaming(streaming === true)
  })

  return {
    service,
    dispose: () => {
      service.dispose()
      for (const channel of ['airplay:list-devices', 'airplay:get-status', 'airplay:connect', 'airplay:disconnect', 'airplay:set-volume', 'airplay:set-restore-volume', 'airplay:set-metadata', 'airplay:set-progress', 'airplay:play-connect-sound', 'airplay:set-enabled']) {
        try { ipcMain.removeHandler(channel) } catch { /* 忽略 */ }
      }
      ipcMain.removeAllListeners('airplay:pcm')
      ipcMain.removeAllListeners('airplay:set-streaming')
    },
  }
}

module.exports = { setupAirplayIpc }
