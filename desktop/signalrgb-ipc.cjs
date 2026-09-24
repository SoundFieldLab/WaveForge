'use strict'

const { SignalRgbEffectManager } = require('./signalrgb-effect-manager.cjs')

function setupSignalRgbIpc(options = {}) {
  const { ipcMain, getMainWindow, shell, guardTrustedIpc } = options
  if (!ipcMain) throw new TypeError('setupSignalRgbIpc requires ipcMain')

  const manager = options.manager || new SignalRgbEffectManager({
    ...options,
    onStatus: (status) => {
      if (typeof options.onStatus === 'function') options.onStatus(status)
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      if (win && !win.isDestroyed?.() && win.webContents && !win.webContents.isDestroyed?.()) {
        win.webContents.send('signalrgb:status', status)
      }
    },
  })

  const handlers = {
    'signalrgb:get-status': () => manager.getStatus(),
    'signalrgb:refresh': () => manager.refresh(),
    'signalrgb:install-effect': () => manager.installEffect(),
    'signalrgb:uninstall-effect': () => manager.uninstallEffect(),
    'signalrgb:apply-effect': () => manager.applyEffect(),
    'signalrgb:restore-effect': () => manager.restoreEffect(),
    'signalrgb:send-event': (_event, value, sendOptions) => manager.sendEvent(value, sendOptions),
    'signalrgb:open-signalrgb': async () => {
      await manager.refreshInstallation()
      const installation = (await manager.discoverInstallations())[0] || null
      const target = installation ? manager.path.join(installation.appPath, 'Signal-x64', 'SignalRgb.exe') : null
      if (target && shell && typeof shell.openPath === 'function') {
        const error = await shell.openPath(target)
        return { opened: !error, path: target, error: error || null }
      }
      return { opened: false, path: target, error: target ? null : 'SignalRGB installation not found' }
    },
  }

  // 同上：灯光效果通道会写/删文件，统一套来源校验；未提供守卫时保持原行为
  const guard = (handler) => (typeof guardTrustedIpc === 'function' ? guardTrustedIpc('privileged', handler) : handler)
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, guard(handler))
  return {
    manager,
    dispose() {
      for (const channel of Object.keys(handlers)) {
        try { ipcMain.removeHandler(channel) } catch { /* Electron may already be shutting down. */ }
      }
    },
  }
}

module.exports = { setupSignalRgbIpc }
