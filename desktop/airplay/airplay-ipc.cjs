'use strict'
// ===== AirPlay 投送端 IPC 注册 =====
// 渲染进程通道（window.electron.airplay.*）：
//   list-devices / get-status / connect / disconnect / set-volume / set-metadata / set-progress
//   pcm（高频 send） / status（main -> renderer 状态推送）
// 全部通道要求主窗主 frame 来源：这些操作可连接局域网设备/推流/改系统播放路径，
// 无守卫时任意渲染层（含第三方 webview）都可驱动。
const { AirplaySenderService } = require('./airplay-sender-service.cjs')

function setupAirplayIpc({ ipcMain, getMainWindow, injectedAssertMainSender }) {
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
  // 注入版（main.cjs）额外校验主窗当前文档 URL：sender 相等不等于文档可信
  //（融合模式下主窗可能被导航到外部站点，页面仍持有受信来源身份）
  const assertMainSender = injectedAssertMainSender || ((event) => {
    const win = typeof getMainWindow === 'function' ? getMainWindow() : null
    if (!win || win.isDestroyed() || event?.sender !== win.webContents || event?.senderFrame !== win.webContents.mainFrame) {
      throw new Error('不允许的 IPC 请求来源')
    }
  })
  const guard = (handler) => (event, ...args) => {
    assertMainSender(event)
    return handler(...args)
  }

  ipcMain.handle('airplay:set-enabled', guard((_event, enabled) => {
    return service.setEnabled(enabled === true)
  }))
  ipcMain.handle('airplay:list-devices', guard(() => {
    service.ensureBrowsing()
    return service.listDevices()
  }))
  ipcMain.handle('airplay:get-status', guard(() => {
    return service.getStatus()
  }))
  ipcMain.handle('airplay:connect', guard((_event, deviceId, mode = 'auto') => {
    service.ensureBrowsing()
    return service.connect(deviceId, mode)
  }))
  ipcMain.handle('airplay:disconnect', guard(() => {
    service.disconnect()
    return { success: true }
  }))
  ipcMain.handle('airplay:set-volume', guard((_event, volume) => {
    service.setVolume(volume)
    return { success: true }
  }))
  ipcMain.handle('airplay:set-restore-volume', guard((_event, volume) => {
    service.setRestoreVolume(volume)
    return { success: true }
  }))
  ipcMain.handle('airplay:set-metadata', guard((_event, metadata) => {
    service.setMetadata(metadata || {})
    return { success: true }
  }))
  ipcMain.handle('airplay:set-progress', guard((_event, elapsed, duration) => {
    service.setProgress(Number(elapsed) || 0, Number(duration) || 0)
    return { success: true }
  }))
  ipcMain.handle('airplay:play-connect-sound', guard(() => {
    service.playConnectSound()
    return { success: true }
  }))
  ipcMain.on('airplay:pcm', (event, chunk) => {
    // 高频音频流：不抛错（invoke 语义），来源不符直接丢弃
    try { assertMainSender(event) } catch { return }
    service.sendPcm(chunk)
  })
  ipcMain.on('airplay:set-streaming', (event, streaming) => {
    try { assertMainSender(event) } catch { return }
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
