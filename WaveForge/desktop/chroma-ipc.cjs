'use strict'

const { discoverDevices: discoverRazerDevices } = require('./razer-device-discovery.cjs')
const { inspectChromaAppList, launchChromaAppListRepair } = require('./chroma-app-list-repair.cjs')

const DEFAULT_BASE_URL = 'http://localhost:54235/razer/chromasdk'
const DEVICE_SPECS = Object.freeze({
  keyboard: { length: 132, rows: 6, columns: 22, effect: 'CHROMA_CUSTOM' },
  mouse: { length: 63, rows: 9, columns: 7, effect: 'CHROMA_CUSTOM2' },
  mousepad: { length: 20, rows: 1, columns: 20, effect: 'CHROMA_CUSTOM' },
  headset: { length: 5, rows: 1, columns: 5, effect: 'CHROMA_CUSTOM' },
  keypad: { length: 20, rows: 4, columns: 5, effect: 'CHROMA_CUSTOM' },
  chromalink: { length: 5, rows: 1, columns: 5, effect: 'CHROMA_CUSTOM' },
})

const REGISTRATION = Object.freeze({
  title: 'WaveForge',
  description: 'WaveForge music visualization and ambient lighting integration',
  author: { name: 'WaveForge', contact: 'https://github.com/WaveForge' },
  device_supported: Object.keys(DEVICE_SPECS),
  category: 'application',
})

function cleanBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function makeDeviceState() {
  return Object.fromEntries(Object.keys(DEVICE_SPECS).map((name) => [name, {
    available: false,
    enabled: true,
    effectCreated: false,
    failures: 0,
    zones: DEVICE_SPECS[name].length,
  }]))
}

function normalizeColors(device, input) {
  const spec = DEVICE_SPECS[device]
  if (!spec) return null

  let values
  if (Array.isArray(input) || ArrayBuffer.isView(input)) {
    values = Array.from(input)
  } else if (input && typeof input === 'object') {
    const keys = Object.keys(input).filter((key) => key !== 'length')
    if (keys.length !== spec.length) return null
    values = []
    for (let index = 0; index < spec.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(input, String(index))) return null
      values.push(input[index])
    }
  } else {
    return null
  }

  if (values.length !== spec.length || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    return null
  }
  return values.map((value) => value >>> 0)
}

function resampleColors(colors, targetLength) {
  if (colors.length === targetLength) return colors.slice()
  const output = new Array(targetLength)
  for (let index = 0; index < targetLength; index += 1) {
    const source = Math.round(index * (colors.length - 1) / Math.max(1, targetLength - 1))
    output[index] = colors[source]
  }
  return output
}

function shapeColors(device, colors, zones) {
  const spec = DEVICE_SPECS[device]
  const values = zones && zones !== colors.length ? resampleColors(colors, zones) : colors
  if (spec.rows === 1) return values.slice()
  const rows = []
  for (let row = 0; row < spec.rows; row += 1) {
    rows.push(values.slice(row * spec.columns, (row + 1) * spec.columns))
  }
  return rows
}

class ChromaRestService {
  constructor(options = {}) {
    this.baseUrl = cleanBaseUrl(options.baseUrl || process.env.WAVEFORGE_CHROMA_BASE_URL)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new TypeError('ChromaRestService requires fetch')

    const timers = options.timers || {}
    this.setTimeout = timers.setTimeout || globalThis.setTimeout
    this.clearTimeout = timers.clearTimeout || globalThis.clearTimeout
    this.now = timers.now || Date.now
    this.heartbeatIntervalMs = timers.heartbeatIntervalMs || 5000
    this.retryIntervalMs = timers.retryIntervalMs || 5000
    this.frameIdleMs = timers.frameIdleMs || 5000
    this.requestTimeoutMs = timers.requestTimeoutMs || 1500
    this.sessionReadyDelaysMs = Array.isArray(timers.sessionReadyDelaysMs)
      ? timers.sessionReadyDelaysMs
      : [40, 80, 160, 320, 640]
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
    this.discoverDevices = typeof options.discoverDevices === 'function' ? options.discoverDevices : discoverRazerDevices
    this.repairBasePath = options.repairBasePath || null
    this.inspectAppListImpl = options.inspectAppList || inspectChromaAppList
    this.launchRepairImpl = options.launchRepair || launchChromaAppListRepair
    this.mockReady = options.mockReady || null

    const testOverride = Boolean(options.baseUrl || process.env.WAVEFORGE_CHROMA_BASE_URL || process.env.WAVEFORGE_CHROMA_MOCK === '1')
    this.state = {
      active: false,
      platformSupported: process.platform === 'win32' || testOverride,
      synapseFound: false,
      registered: false,
      sdkVersion: null,
      sessionUri: null,
      sessionId: null,
      lastHeartbeatAt: null,
      devices: makeDeviceState(),
      hardwareDevices: [],
      deviceDiscoveryError: null,
      lastDeviceScanAt: null,
      appListHealth: null,
      lastError: null,
      logs: [],
    }
    this.heartbeatTimer = null
    this.retryTimer = null
    this.watchdogTimer = null
    this.activationPromise = null
    this.lastFrameAt = 0
    this.streaming = false
    this.disposed = false
    this.devicePumps = Object.fromEntries(Object.keys(DEVICE_SPECS).map((name) => [name, { inFlight: false, pending: null }]))
  }

  getStatus() {
    return JSON.parse(JSON.stringify(this.state))
  }

  emitStatus() {
    this.onStatus(this.getStatus())
  }

  log(level, message) {
    this.state.logs.push({ at: new Date(this.now()).toISOString(), level, message: String(message) })
    if (this.state.logs.length > 100) this.state.logs.splice(0, this.state.logs.length - 100)
  }

  setError(error, context) {
    const message = error instanceof Error ? error.message : String(error)
    this.state.lastError = context ? `${context}: ${message}` : message
    this.log('error', this.state.lastError)
    this.emitStatus()
  }

  async request(url, init = {}) {
    let controller = null
    let timeout = null
    let signal
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      signal = AbortSignal.timeout(this.requestTimeoutMs)
    } else if (typeof AbortController !== 'undefined') {
      controller = new AbortController()
      signal = controller.signal
      timeout = this.setTimeout(() => controller.abort(), this.requestTimeoutMs)
    }

    try {
      const response = await this.fetchImpl(url, {
        ...init,
        signal,
        headers: { 'content-type': 'application/json', ...(init.headers || {}) },
      })
      const text = await response.text()
      let body = {}
      if (text) {
        try { body = JSON.parse(text) } catch { throw new Error(`invalid JSON response (${response.status})`) }
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}${body.message ? `: ${body.message}` : ''}`)
      if (typeof body.result === 'number' && body.result !== 0) {
        throw new Error(`Chroma result ${body.result}${body.error || body.message ? `: ${body.error || body.message}` : ''}`)
      }
      return body
    } finally {
      if (timeout) this.clearTimeout(timeout)
    }
  }

  schedule(name, delay, callback) {
    if (this[name]) this.clearTimeout(this[name])
    this[name] = this.setTimeout(() => {
      this[name] = null
      callback()
    }, delay)
    if (this[name] && typeof this[name].unref === 'function') this[name].unref()
  }

  async activate() {
    if (this.disposed) throw new Error('Chroma service is disposed')
    if (!this.state.platformSupported) {
      this.setError('Razer Chroma is only supported on Windows', 'activate')
      return this.getStatus()
    }
    this.state.active = true
    this.emitStatus()
    await Promise.all([this.scanHardwareDevices(), this.inspectAppList()])
    if (this.state.registered) return this.getStatus()
    if (this.activationPromise) return this.activationPromise

    this.activationPromise = this.registerSession().finally(() => { this.activationPromise = null })
    return this.activationPromise
  }

  sleep(delay) {
    return new Promise((resolve) => this.setTimeout(resolve, delay))
  }

  async waitForSessionReady(sessionUri) {
    let lastError = null
    for (const delay of this.sessionReadyDelaysMs) {
      if (!this.state.active) throw new Error('Chroma activation cancelled')
      if (delay > 0) await this.sleep(delay)
      try {
        const response = await this.request(`${sessionUri}/heartbeat`, { method: 'PUT', body: '{}' })
        this.state.lastHeartbeatAt = this.now()
        return response
      } catch (error) {
        lastError = error
      }
    }
    throw lastError || new Error('Chroma session endpoint did not become ready')
  }

  async registerSession() {
    let pendingSessionUri = null
    try {
      if (this.mockReady) {
        const mockBaseUrl = await this.mockReady
        if (mockBaseUrl) this.baseUrl = cleanBaseUrl(mockBaseUrl)
      }
      let sdkInfo = null
      try {
        sdkInfo = await this.request(this.baseUrl, { method: 'GET' })
        this.state.sdkVersion = String(sdkInfo.version || sdkInfo.core || sdkInfo.device || '') || null
      } catch {
        // Older Chroma services may not expose the version endpoint; registration remains authoritative.
      }
      const response = await this.request(this.baseUrl, {
        method: 'POST',
        body: JSON.stringify(REGISTRATION),
      })
      if (!response.uri || response.sessionid === undefined || response.sessionid === null) {
        throw new Error('registration response omitted uri/sessionid')
      }
      const sessionUri = String(response.uri).replace(/\/+$/, '')
      pendingSessionUri = sessionUri
      await this.waitForSessionReady(sessionUri)
      if (!this.state.active) {
        try { await this.request(sessionUri, { method: 'DELETE' }) } catch { /* Activation was cancelled. */ }
        return this.getStatus()
      }
      this.state.synapseFound = true
      this.state.registered = true
      this.state.sessionUri = sessionUri
      this.state.sessionId = response.sessionid
      this.state.lastError = null
      const previousDevices = this.state.devices
      this.state.devices = makeDeviceState()
      for (const device of Object.keys(DEVICE_SPECS)) {
        this.state.devices[device].enabled = previousDevices[device]?.enabled !== false
      }
      this.log('info', `registered Chroma session ${response.sessionid}${this.state.sdkVersion ? ` (SDK ${this.state.sdkVersion})` : ''}`)
      this.emitStatus()
      this.scheduleHeartbeat()
      this.scheduleWatchdog()
    } catch (error) {
      if (pendingSessionUri) {
        try { await this.request(pendingSessionUri, { method: 'DELETE' }) } catch { /* Endpoint may never have opened. */ }
      }
      this.state.synapseFound = false
      this.state.registered = false
      this.setError(error, 'registration failed')
      if (this.state.active) this.scheduleRetry()
    }
    return this.getStatus()
  }

  scheduleRetry() {
    if (!this.state.active || this.disposed) return
    this.schedule('retryTimer', this.retryIntervalMs, () => {
      if (this.state.active && !this.state.registered) void this.activate()
    })
  }

  scheduleHeartbeat() {
    if (!this.state.active || !this.state.registered) return
    this.schedule('heartbeatTimer', this.heartbeatIntervalMs, async () => {
      if (!this.state.active || !this.state.registered) return
      try {
        await this.request(`${this.state.sessionUri}/heartbeat`, { method: 'PUT', body: '{}' })
        this.state.lastHeartbeatAt = this.now()
        this.state.lastError = null
        this.emitStatus()
      } catch (error) {
        this.state.registered = false
        this.state.synapseFound = false
        this.setError(error, 'heartbeat failed')
        this.scheduleRetry()
        return
      }
      this.scheduleHeartbeat()
    })
  }

  scheduleWatchdog() {
    if (!this.state.active) return
    this.schedule('watchdogTimer', this.frameIdleMs, () => {
      if (this.streaming && this.now() - this.lastFrameAt >= this.frameIdleMs) {
        this.streaming = false
        for (const pump of Object.values(this.devicePumps)) pump.pending = null
        this.log('info', 'frame stream idle; pending frames discarded while session remains active')
      }
      this.scheduleWatchdog()
    })
  }

  async inspectAppList() {
    try {
      this.state.appListHealth = await this.inspectAppListImpl()
    } catch (error) {
      this.state.appListHealth = { corrupted: false, error: error instanceof Error ? error.message : String(error) }
    }
    this.emitStatus()
    return this.getStatus()
  }

  async launchAppListRepair() {
    const result = await this.launchRepairImpl(this.repairBasePath)
    if (result.outcome === 'succeeded') {
      this.log('info', `Chroma app-list repair completed; removed ${result.report.removed.length} stale WaveForge entries`)
      await this.inspectAppList()
    } else if (result.outcome === 'uac-cancelled') {
      this.log('warn', 'Chroma app-list repair cancelled at the Windows UAC prompt')
    } else {
      this.log('error', `Chroma app-list repair failed (${result.outcome}): ${result.error}`)
    }
    this.emitStatus()
    return { ...result, status: this.getStatus() }
  }

  async scanHardwareDevices() {
    try {
      const result = await this.discoverDevices()
      const devices = Array.isArray(result) ? result : result?.devices
      this.state.hardwareDevices = Array.isArray(devices) ? devices : []
      this.state.deviceDiscoveryError = Array.isArray(result) ? null : result?.diagnostic || null
    } catch (error) {
      this.state.hardwareDevices = []
      this.state.deviceDiscoveryError = error instanceof Error ? error.message : String(error)
    }
    this.state.lastDeviceScanAt = this.now()
    this.emitStatus()
    return this.getStatus()
  }

  async refreshDevices() {
    await this.scanHardwareDevices()
    if (!this.state.registered) return this.getStatus()
    await Promise.all(Object.keys(DEVICE_SPECS).map(async (device) => {
      const state = this.state.devices[device]
      try {
        await this.request(`${this.state.sessionUri}/${device}`, {
          method: 'PUT',
          body: JSON.stringify({ effect: 'CHROMA_NONE' }),
        })
        state.available = true
        state.effectCreated = false
        state.failures = 0
      } catch (error) {
        this.recordDeviceFailure(device, error, 'probe')
      }
    }))
    this.emitStatus()
    return this.getStatus()
  }

  recordDeviceFailure(device, error, operation) {
    const state = this.state.devices[device]
    state.failures += 1
    if (state.failures >= 3) state.available = false
    this.state.lastError = `${device} ${operation} failed: ${error instanceof Error ? error.message : String(error)}`
    this.log('error', this.state.lastError)
  }

  async setDeviceEnabled(device, enabled) {
    if (!DEVICE_SPECS[device]) return this.getStatus()
    const state = this.state.devices[device]
    state.enabled = enabled === true
    state.failures = 0
    this.devicePumps[device].pending = null
    if (!state.enabled && this.state.registered) {
      try {
        await this.request(`${this.state.sessionUri}/${device}`, {
          method: 'PUT',
          body: JSON.stringify({ effect: 'CHROMA_NONE' }),
        })
        state.available = true
        state.effectCreated = false
      } catch (error) {
        this.recordDeviceFailure(device, error, 'disable')
      }
    }
    this.emitStatus()
    return this.getStatus()
  }

  submitFrame(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false
    const allowedKeys = new Set(['device', 'colors', 'release'])
    if (Object.keys(payload).some((key) => !allowedKeys.has(key))) return false
    if (payload.release === true) {
      void this.deactivate()
      return true
    }
    if (payload.release !== undefined && payload.release !== false) return false
    if (typeof payload.device !== 'string' || !DEVICE_SPECS[payload.device]) return false
    const colors = normalizeColors(payload.device, payload.colors)
    if (!colors || !this.state.active || !this.state.registered) return false

    const device = payload.device
    this.lastFrameAt = this.now()
    this.streaming = true
    this.devicePumps[device].pending = colors
    void this.drainDevice(device)
    return true
  }

  async drainDevice(device) {
    const pump = this.devicePumps[device]
    if (pump.inFlight) return
    pump.inFlight = true
    try {
      while (pump.pending && this.state.active && this.state.registered) {
        const colors = pump.pending
        pump.pending = null
        const deviceState = this.state.devices[device]
        if (!deviceState.enabled || deviceState.failures >= 3) continue
        try {
          const send = () => this.request(`${this.state.sessionUri}/${device}`, {
            method: 'PUT',
            body: JSON.stringify({ effect: DEVICE_SPECS[device].effect, param: shapeColors(device, colors, deviceState.zones) }),
          })
          try {
            await send()
          } catch (error) {
            const legacyMousepad = device === 'mousepad'
              && deviceState.zones === 20
              && /expecting an array of 15|result 87/i.test(error instanceof Error ? error.message : String(error))
            if (!legacyMousepad) throw error
            deviceState.zones = 15
            this.log('info', 'mousepad negotiated legacy 15-zone layout')
            await send()
          }
          deviceState.effectCreated = true
          deviceState.available = true
          deviceState.failures = 0
          this.state.lastError = null
        } catch (error) {
          this.recordDeviceFailure(device, error, 'frame')
          this.emitStatus()
        }
      }
    } finally {
      pump.inFlight = false
      if (pump.pending && this.state.active && this.state.registered) void this.drainDevice(device)
    }
  }

  async deactivate() {
    this.state.active = false
    for (const name of ['heartbeatTimer', 'retryTimer', 'watchdogTimer']) {
      if (this[name]) this.clearTimeout(this[name])
      this[name] = null
    }
    for (const pump of Object.values(this.devicePumps)) pump.pending = null
    const sessionUri = this.state.sessionUri
    if (sessionUri) {
      try { await this.request(sessionUri, { method: 'DELETE' }) } catch (error) { this.log('error', `session release failed: ${error.message}`) }
    }
    this.streaming = false
    this.lastFrameAt = 0
    this.state.synapseFound = false
    this.state.registered = false
    this.state.sessionUri = null
    this.state.sessionId = null
    this.state.lastHeartbeatAt = null
    for (const device of Object.keys(DEVICE_SPECS)) {
      const enabled = this.state.devices[device]?.enabled !== false
      this.state.devices[device] = { ...makeDeviceState()[device], enabled }
    }
    this.emitStatus()
    return this.getStatus()
  }

  async dispose() {
    if (this.disposed) return
    await this.deactivate()
    this.disposed = true
  }
}

function setupChromaIpc({ ipcMain, getMainWindow, baseUrl, fetchImpl, timers, discoverDevices, repairBasePath, inspectAppList, launchRepair } = {}) {
  if (!ipcMain) throw new TypeError('setupChromaIpc requires ipcMain')
  let mock = null
  if (process.env.WAVEFORGE_CHROMA_MOCK === '1') {
    mock = require('./chroma-mock.cjs').startChromaMock()
    baseUrl = mock.baseUrl
  }

  const mockReady = mock ? mock.ready.then(() => mock.baseUrl) : null
  const service = new ChromaRestService({
    baseUrl,
    fetchImpl,
    timers,
    discoverDevices,
    repairBasePath,
    inspectAppList,
    launchRepair,
    mockReady,
    onStatus: (status) => {
      const win = typeof getMainWindow === 'function' ? getMainWindow() : null
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed?.()) {
        win.webContents.send('chroma:status', status)
      }
    },
  })

  const handlers = {
    'chroma:activate': () => service.activate(),
    'chroma:deactivate': () => service.deactivate(),
    'chroma:get-status': () => service.getStatus(),
    'chroma:refresh-devices': () => service.refreshDevices(),
    'chroma:scan-hardware': () => service.scanHardwareDevices(),
    'chroma:inspect-app-list': () => service.inspectAppList(),
    'chroma:repair-app-list': () => service.launchAppListRepair(),
    'chroma:set-device-enabled': (_event, device, enabled) => service.setDeviceEnabled(device, enabled),
  }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  const frameListener = (_event, payload) => { service.submitFrame(payload) }
  ipcMain.on('chroma:frame', frameListener)

  return {
    service,
    mock,
    dispose: async () => {
      for (const channel of Object.keys(handlers)) {
        try { ipcMain.removeHandler(channel) } catch { /* Electron may already be shutting down. */ }
      }
      if (typeof ipcMain.removeListener === 'function') ipcMain.removeListener('chroma:frame', frameListener)
      else ipcMain.removeAllListeners('chroma:frame')
      await service.dispose()
      if (mock) await mock.stop()
    },
  }
}

module.exports = { setupChromaIpc, ChromaRestService, DEVICE_SPECS }
