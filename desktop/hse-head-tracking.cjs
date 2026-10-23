'use strict'

// 仅用户在主应用显式选择设备后授权；不持久化、不枚举后自动挑选。
function createHseHeadTrackingController({ getWindow, isTrusted, showMessageBox, createBridge }) {
  let bridge = null
  let bridgeWork = Promise.resolve()
  let error = ''
  let pending = null
  let generation = 0
  const serialGrants = new Set()
  const bluetoothGrants = new Set()

  function state() {
    return { running: Boolean(bridge), wsUrl: 'ws://127.0.0.1:8989/pose', udpPort: 9000, ...(error ? { error } : {}) }
  }

  function queueBridge(work) {
    const result = bridgeWork.then(work, work)
    bridgeWork = result.catch(() => {})
    return result
  }

  function startBridge() {
    const requestedGeneration = generation
    return queueBridge(async () => {
      if (requestedGeneration !== generation || !isTrusted(getWindow()?.webContents)) return state()
      if (bridge) return state()
      error = ''
      try {
        const created = await createBridge({ onError: cause => { error = `头追桥运行失败：${cause.message}` } })
        if (requestedGeneration !== generation || !isTrusted(getWindow()?.webContents)) await created.close()
        else bridge = created
      } catch (cause) {
        error = cause.code === 'EADDRINUSE'
          ? '头追桥端口已被占用（UDP 9000 / WebSocket 8989），请停止其他桥后重试'
          : `头追桥启动失败：${cause.message}`
      }
      return state()
    })
  }

  function stopBridge() {
    generation++
    return queueBridge(async () => {
      const previous = bridge
      bridge = null
      if (previous) await previous.close()
      error = ''
      return state()
    })
  }

  function shutdown() {
    generation++
    if (pending) finish(pending)
    serialGrants.clear()
    bluetoothGrants.clear()
    const previous = bridge
    bridge = null
    // Electron 退出事件不等待 Promise；立即调用 close 先清定时器/关 sockets。
    if (previous) void previous.close().catch(() => {})
  }

  function serialKey(device) {
    return typeof device?.portId === 'string' && device.portId ? device.portId : ''
  }

  function canUseSerial(details) {
    const win = getWindow()
    if (details?.deviceType !== 'serial' || !isTrusted(win?.webContents)) return false
    let expectedOrigin
    try { expectedOrigin = new URL(win.webContents.getURL()).origin } catch { return false }
    const origin = details.origin
    const originMatches = expectedOrigin === 'null'
      ? origin === 'file://' || origin === 'file:///' : origin === expectedOrigin
    return originMatches && serialGrants.has(serialKey(details.device))
  }

  function finish(request, selected = '') {
    if (pending !== request) return
    pending = null
    clearTimeout(request.timeout)
    clearTimeout(request.scanTimer)
    const device = request.devices.find(item => item.id === selected)
    const approved = device && isTrusted(request.webContents) ? device.id : ''
    if (approved && request.kind === 'serial') serialGrants.add(approved)
    if (approved && request.kind === 'bluetooth') bluetoothGrants.add(approved)
    try { request.callback(approved) } catch { /* 窗口销毁时 Chromium 可能已取消请求 */ }
  }

  async function choose(request) {
    if (pending !== request || request.showing) return
    request.showing = true
    const choices = request.devices.slice(0, 12)
    try {
      const result = await showMessageBox(getWindow(), {
        type: 'question', title: request.kind === 'serial' ? 'HSE 选择头追串口' : 'HSE 选择蓝牙头追设备',
        message: '请选择本次使用的头部追踪设备',
        detail: choices.length ? '仅连接你选中的设备。本次授权随主窗口关闭或导航失效。'
          : '未发现匹配设备。请检查电源、连接及服务 UUID，再重新扫描。',
        buttons: ['取消', ...choices.map(item => item.label), ...(request.kind === 'bluetooth' ? ['继续扫描'] : [])],
        defaultId: 0, cancelId: 0, noLink: true,
      })
      request.showing = false
      if (pending !== request) return
      if (request.kind === 'bluetooth' && result.response === choices.length + 1) {
        request.scanTimer = setTimeout(() => void choose(request), 1500)
      } else finish(request, choices[result.response - 1]?.id)
    } catch { finish(request) }
  }

  function select(kind, event, devices, webContents, callback) {
    event.preventDefault() // Electron 的 BLE 默认行为会自动选择首台设备，必须始终阻止。
    if (!isTrusted(webContents)) { callback(''); return }
    const normalized = devices.map(device => ({
      id: kind === 'serial' ? device.portId : device.deviceId,
      label: String(kind === 'serial' ? (device.displayName || device.portName || device.portId)
        : (device.deviceName || device.deviceId)).replace(/[\x00-\x1f]/g, '').slice(0, 120),
    })).filter(device => typeof device.id === 'string' && device.id)
    if (kind === 'bluetooth' && pending?.kind === kind && pending.webContents === webContents) {
      pending.devices = normalized
      return
    }
    if (pending) finish(pending)
    const request = { kind, callback, webContents, devices: normalized, showing: false }
    pending = request
    request.timeout = setTimeout(() => finish(request), 60000)
    if (kind === 'bluetooth') request.scanTimer = setTimeout(() => void choose(request), 1500)
    else void choose(request)
  }

  function installSession(targetSession) {
    targetSession.on('select-serial-port', (event, ports, contents, callback) => select('serial', event, ports, contents, callback))
    targetSession.setBluetoothPairingHandler?.(async (details, callback) => {
      const contents = getWindow()?.webContents
      if (!isTrusted(contents) || details.frame !== contents.mainFrame || !bluetoothGrants.has(details.deviceId)) { callback({ confirmed: false }); return }
      const canConfirm = details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin'
      try {
        const result = await showMessageBox(getWindow(), {
          type: 'question', title: 'HSE 蓝牙配对',
          message: canConfirm ? '是否允许配对选中的蓝牙头追设备？' : '此设备需要输入配对码',
          detail: details.pairingKind === 'confirmPin' ? `请核对设备显示的配对码：${details.pin}`
            : canConfirm ? String(details.deviceId || '') : '请先在 Windows 蓝牙设置中完成配对，再重新连接。',
          buttons: canConfirm ? ['取消', '确认配对'] : ['关闭'], defaultId: 0, cancelId: 0, noLink: true,
        })
        callback({ confirmed: canConfirm && result.response === 1 && isTrusted(contents) && bluetoothGrants.has(details.deviceId) })
      } catch { callback({ confirmed: false }) }
    })
  }

  function attachWindow(win) {
    const contents = win.webContents
    contents.on('select-bluetooth-device', (event, devices, callback) => select('bluetooth', event, devices, contents, callback))
    const cleanup = () => {
      if (pending?.webContents === contents) finish(pending)
      shutdown()
    }
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) cleanup()
    })
    contents.once('destroyed', cleanup)
    contents.on('render-process-gone', cleanup)
  }

  return { state, startBridge, stopBridge, shutdown, canUseSerial, installSession, attachWindow }
}

module.exports = { createHseHeadTrackingController }
