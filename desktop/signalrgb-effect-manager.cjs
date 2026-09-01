'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const EFFECT_FILE = 'WaveForge.html'
const SIDECAR_FILE = 'WaveForge.waveforge.json'
const DEFAULT_LOCAL_API = 'http://127.0.0.1:16038/api/v1'
const DEFAULT_CANVAS_API = 'http://localhost:16034/canvas/event'
const EVENT_RE = /^(?:play|pause|stop|beat:(?:100|[1-9]?\d)|accent(?::(?:100|[1-9]?\d))?|theme:[0-9a-fA-F]{6}:[0-9a-fA-F]{6}|style:(?:spectrum-cycle|gradient-spectrum|wave|ripple|fire|rain|vu-meter|aurora|galaxy|bass-reactor|ambient|static)|section:(?:intro|verse|pre-chorus|chorus|bridge|outro|breakdown|drop|solo))$/

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function clone(value) { return JSON.parse(JSON.stringify(value)) }

function parseVersion(name) {
  const match = /^app-(\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)$/i.exec(name)
  if (!match) return null
  return { text: match[1], numbers: match[1].split(/[+-]/, 1)[0].split('.').map(Number) }
}

function compareVersions(a, b) {
  const length = Math.max(a.numbers.length, b.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] || 0) - (b.numbers[index] || 0)
    if (difference) return difference
  }
  return a.text.localeCompare(b.text, undefined, { numeric: true })
}

function unwrap(body) {
  let value = body
  for (let index = 0; index < 3; index += 1) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) break
    const key = ['data', 'result', 'payload'].find((candidate) => value[candidate] !== undefined)
    if (!key) break
    value = value[key]
  }
  return value
}

function toArray(value) {
  const unwrapped = unwrap(value)
  if (Array.isArray(unwrapped)) return unwrapped
  if (!unwrapped || typeof unwrapped !== 'object') return []
  for (const key of ['effects', 'layouts', 'items', 'list']) if (Array.isArray(unwrapped[key])) return unwrapped[key]
  return []
}

function itemId(item) {
  if (item === null || item === undefined) return null
  if (typeof item !== 'object') return String(item)
  const value = item.id ?? item.effectId ?? item.effect_id ?? item.uuid ?? item.value
  return value === null || value === undefined ? null : String(value)
}

function itemName(item) {
  if (item === null || item === undefined) return ''
  if (typeof item !== 'object') return String(item)
  return String(item.title ?? item.name ?? item.label ?? item.displayName ?? '')
}

class SignalRgbEffectManager {
  constructor(options = {}) {
    this.fs = options.fs || fs
    this.path = options.path || path
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new TypeError('SignalRgbEffectManager requires fetch')
    this.localApiBase = String(options.localApiBase || DEFAULT_LOCAL_API).replace(/\/+$/, '')
    this.canvasApiBase = String(options.canvasApiBase || DEFAULT_CANVAS_API).replace(/\/+$/, '')
    this.bundledEffectPath = options.bundledEffectPath || path.join(__dirname, 'assets', 'signalrgb', EFFECT_FILE)
    this.version = String(options.version || '1.0.0')
    this.roots = options.roots || [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'VortxEngine')]
    this.tempRoot = options.tempRoot || options.temp || os.tmpdir()
    this.platformSupported = options.platformSupported ?? (process.platform === 'win32' || Boolean(options.roots))
    this.requestTimeoutMs = Math.max(100, Number(options.requestTimeoutMs) || 1200)
    this.eventThrottleMs = Math.max(0, Number(options.eventThrottleMs) || 40)
    this.eventDedupeMs = Math.max(this.eventThrottleMs, Number(options.eventDedupeMs) || 250)
    this.allowGetFallback = options.allowGetFallback === true
    this.now = options.now || Date.now
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
    this.previousEffectId = null
    this.effects = []
    this.lastEventValue = null
    this.lastEventAt = 0
    this.lastEventAttemptAt = 0
    this.state = {
      platformSupported: this.platformSupported, installed: false, running: false,
      localApiAvailable: false, proAvailable: null, canvasEventAvailable: false,
      effectInstalled: false, effectPath: null, effectVersion: null, hash: null, effectHash: null,
      conflict: false, restartRequired: false, currentEffect: null, layout: null,
      layouts: [], lastEvent: null, errors: [], logs: [],
    }
  }

  getStatus() { return clone(this.state) }
  log(level, message) {
    this.state.logs.push({ at: new Date(this.now()).toISOString(), level, message: String(message) })
    if (this.state.logs.length > 100) this.state.logs.splice(0, this.state.logs.length - 100)
  }
  error(context, error) {
    const message = `${context}: ${error instanceof Error ? error.message : String(error)}`
    this.state.errors.push({ at: new Date(this.now()).toISOString(), message })
    if (this.state.errors.length > 50) this.state.errors.splice(0, this.state.errors.length - 50)
    this.log('error', message)
  }
  emit() { const status = this.getStatus(); this.onStatus(status); return status }

  async discoverInstallations() {
    const installations = []
    for (const root of this.roots) {
      let entries = []
      try { entries = await this.fs.promises.readdir(root, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const version = parseVersion(entry.name)
        if (!version) continue
        const appPath = this.path.resolve(root, entry.name)
        const effectDirectory = this.path.join(appPath, 'Signal-x64', 'Effects', 'Dynamic')
        try {
          const stat = await this.fs.promises.stat(effectDirectory)
          if (stat.isDirectory()) installations.push({ appPath, effectDirectory, version, mtimeMs: stat.mtimeMs })
        } catch { /* Ignore incomplete SignalRGB app directories. */ }
      }
    }
    installations.sort((left, right) => compareVersions(right.version, left.version) || right.mtimeMs - left.mtimeMs)
    return installations
  }

  managedPath(effectDirectory, fileName) {
    if (![EFFECT_FILE, SIDECAR_FILE].includes(fileName)) throw new Error('unsafe SignalRGB effect filename')
    const parent = this.path.resolve(effectDirectory)
    const target = this.path.resolve(parent, fileName)
    if (this.path.dirname(target) !== parent) throw new Error('unsafe SignalRGB effect path')
    return target
  }
  temporaryPath() {
    const parent = this.path.resolve(this.tempRoot)
    const target = this.path.resolve(parent, `${EFFECT_FILE}.${process.pid}.${this.now()}.tmp`)
    if (this.path.dirname(target) !== parent) throw new Error('unsafe temporary path')
    return target
  }

  async inspectInstallation(installation) {
    const effectPath = this.managedPath(installation.effectDirectory, EFFECT_FILE)
    const sidecarPath = this.managedPath(installation.effectDirectory, SIDECAR_FILE)
    let content = null
    let metadata = null
    try { content = await this.fs.promises.readFile(effectPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
    try { metadata = JSON.parse(await this.fs.promises.readFile(sidecarPath, 'utf8')) } catch { metadata = null }
    const hash = content ? sha256(content) : null
    const sidecarOwned = Boolean(metadata && metadata.owner === 'WaveForge' && metadata.file === EFFECT_FILE && /^[a-f0-9]{64}$/i.test(metadata.sha256 || ''))
    return { ...installation, effectPath, sidecarPath, content, metadata, hash,
      owned: Boolean(content && sidecarOwned && metadata.sha256.toLowerCase() === hash),
      conflict: Boolean(content && (!sidecarOwned || metadata.sha256.toLowerCase() !== hash)) }
  }

  async refreshInstallation() {
    const installations = await this.discoverInstallations()
    this.state.installed = installations.length > 0
    if (!installations.length) {
      Object.assign(this.state, { effectInstalled: false, effectPath: null, effectVersion: null, hash: null, effectHash: null, conflict: false, restartRequired: false })
      return null
    }
    const latest = await this.inspectInstallation(installations[0])
    let ownedElsewhere = false
    for (const installation of installations.slice(1)) if ((await this.inspectInstallation(installation)).owned) ownedElsewhere = true
    Object.assign(this.state, {
      effectInstalled: latest.owned, effectPath: latest.effectPath,
      effectVersion: latest.owned ? latest.metadata.version || null : null,
      hash: latest.hash, effectHash: latest.hash, conflict: latest.conflict,
      restartRequired: !latest.owned && ownedElsewhere,
    })
    return latest
  }

  async responseBody(response) {
    const text = await response.text()
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }
  async request(url, init = {}) {
    const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(this.requestTimeoutMs) : undefined
    return this.fetchImpl(url, { ...init, signal, headers: { accept: 'application/json', ...(init.headers || {}) } })
  }
  async probeEndpoint(name, endpoint) {
    try {
      const response = await this.request(`${this.localApiBase}/${endpoint}`)
      if (response.status === 403) return { name, forbidden: true, body: await this.responseBody(response) }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { name, available: true, body: await this.responseBody(response) }
    } catch (error) { return { name, error } }
  }

  async refresh() {
    this.state.errors = []
    try { await this.refreshInstallation() } catch (error) { this.error('installation scan', error) }
    const probes = await Promise.all([
      this.probeEndpoint('lighting', 'lighting'), this.probeEndpoint('effects', 'lighting/effects'),
      this.probeEndpoint('layouts', 'scenes/layouts'), this.probeEndpoint('layout', 'scenes/current_layout'),
    ])
    const available = probes.filter((probe) => probe.available)
    const forbidden = probes.filter((probe) => probe.forbidden)
    this.state.localApiAvailable = available.length > 0 || forbidden.length > 0
    this.state.running = this.state.localApiAvailable
    this.state.proAvailable = forbidden.length ? false : (available.length ? true : null)
    const effectsProbe = probes.find((probe) => probe.name === 'effects' && probe.available)
    const layoutsProbe = probes.find((probe) => probe.name === 'layouts' && probe.available)
    const layoutProbe = probes.find((probe) => probe.name === 'layout' && probe.available)
    const lightingProbe = probes.find((probe) => probe.name === 'lighting' && probe.available)
    this.effects = effectsProbe ? toArray(effectsProbe.body) : []
    this.state.layouts = layoutsProbe ? toArray(layoutsProbe.body) : []
    this.state.layout = layoutProbe ? unwrap(layoutProbe.body) : null
    const lighting = lightingProbe ? unwrap(lightingProbe.body) : null
    this.state.currentEffect = lighting && typeof lighting === 'object' ? lighting.effect ?? lighting.currentEffect ?? lighting.activeEffect ?? lighting : lighting
    for (const probe of probes) if (probe.error) this.log('debug', `${probe.name} unavailable: ${probe.error.message}`)
    return this.emit()
  }

  async installEffect() {
    if (!this.platformSupported) throw new Error('SignalRGB effects are only supported on Windows')
    const latest = await this.refreshInstallation()
    if (!latest) throw new Error('SignalRGB installation not found')
    const bundled = await this.fs.promises.readFile(this.bundledEffectPath)
    const bundledHash = sha256(bundled)
    if (latest.content) {
      if (!latest.owned) { this.state.conflict = true; this.emit(); throw new Error('WaveForge.html exists but is not owned by WaveForge') }
      if (latest.hash === bundledHash && latest.metadata.version === this.version) return this.emit()
    }
    await this.fs.promises.mkdir(latest.effectDirectory, { recursive: true })
    const temporary = this.temporaryPath()
    try {
      await this.fs.promises.mkdir(this.tempRoot, { recursive: true })
      await this.fs.promises.writeFile(temporary, bundled)
      await this.fs.promises.copyFile(temporary, latest.effectPath)
    } finally { await this.fs.promises.rm(temporary, { force: true }).catch(() => {}) }
    await this.fs.promises.writeFile(latest.sidecarPath, `${JSON.stringify({ owner: 'WaveForge', file: EFFECT_FILE, version: this.version, sha256: bundledHash }, null, 2)}\n`)
    this.log('info', `installed SignalRGB effect ${this.version}`)
    await this.refreshInstallation()
    return this.emit()
  }

  async uninstallEffect() {
    const latest = await this.refreshInstallation()
    if (!latest || (!latest.content && !latest.metadata)) return this.emit()
    if (!latest.owned) { this.state.conflict = Boolean(latest.content); this.emit(); throw new Error('refusing to remove an unowned or modified SignalRGB effect') }
    await this.fs.promises.rm(latest.effectPath)
    await this.fs.promises.rm(latest.sidecarPath)
    this.log('info', 'uninstalled SignalRGB effect')
    await this.refreshInstallation()
    return this.emit()
  }

  findWaveForgeEffect() { return this.effects.find((effect) => /waveforge/i.test(itemName(effect))) || null }
  currentEffectId() { return itemId(this.state.currentEffect) }
  async postEffect(effectId) {
    const encoded = encodeURIComponent(String(effectId))
    const candidates = [
      { url: `${this.localApiBase}/lighting/effects/${encoded}/apply`, body: null },
      { url: `${this.localApiBase}/lighting/effects/apply`, body: JSON.stringify({ id: effectId, effectId }) },
      { url: `${this.localApiBase}/effects/${encoded}/apply`, body: null },
    ]
    let lastError = null
    for (const candidate of candidates) {
      try {
        const response = await this.request(candidate.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: candidate.body })
        if (response.status === 403) { this.state.proAvailable = false; throw new Error('SignalRGB Pro is unavailable') }
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return this.responseBody(response)
      } catch (error) { lastError = error }
    }
    throw lastError || new Error('unable to apply SignalRGB effect')
  }
  async applyEffect() {
    await this.refresh()
    const effect = this.findWaveForgeEffect()
    if (!effect || !itemId(effect)) throw new Error('WaveForge effect not found in SignalRGB Local API')
    const current = this.currentEffectId()
    if (current && current !== itemId(effect)) this.previousEffectId = current
    await this.postEffect(itemId(effect))
    this.state.currentEffect = effect
    this.log('info', `applied SignalRGB effect ${itemId(effect)}`)
    return this.emit()
  }
  async restoreEffect() {
    if (!this.previousEffectId) return this.emit()
    const previous = this.previousEffectId
    await this.postEffect(previous)
    this.previousEffectId = null
    this.state.currentEffect = this.effects.find((effect) => itemId(effect) === previous) || { id: previous }
    this.log('info', `restored SignalRGB effect ${previous}`)
    return this.emit()
  }

  validateEvent(event) { return typeof event === 'string' && event.length <= 96 && EVENT_RE.test(event) }
  async sendEvent(event, options = {}) {
    if (!this.validateEvent(event)) throw new TypeError('invalid SignalRGB Canvas Event')
    const now = this.now()
    if (event === this.lastEventValue && now - this.lastEventAt < this.eventDedupeMs) return { sent: false, deduplicated: true, status: this.getStatus() }
    if (now - this.lastEventAttemptAt < this.eventThrottleMs) return { sent: false, throttled: true, status: this.getStatus() }
    this.lastEventAttemptAt = now
    const url = `${this.canvasApiBase}?sender=waveforge&event=${encodeURIComponent(event)}`
    let response
    let method = 'POST'
    try {
      response = await this.request(url, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: event })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (postError) {
      if (!(options.getFallback ?? this.allowGetFallback)) { this.state.canvasEventAvailable = false; this.error('canvas event', postError); this.emit(); throw postError }
      method = 'GET'
      response = await this.request(url, { method: 'GET' })
      if (!response.ok) throw new Error(`Canvas Event GET fallback HTTP ${response.status}`)
    }
    this.lastEventValue = event
    this.lastEventAt = now
    this.state.canvasEventAvailable = true
    this.state.lastEvent = { event, method, at: new Date(now).toISOString() }
    this.log('debug', `sent Canvas Event ${event} via ${method}`)
    return { sent: true, method, status: this.emit() }
  }
}

module.exports = { SignalRgbEffectManager, EFFECT_FILE, SIDECAR_FILE, EVENT_RE, sha256, parseVersion, compareVersions }
