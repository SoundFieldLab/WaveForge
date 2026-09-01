'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const fsp = require('fs/promises')
const os = require('os')
const path = require('path')
const { resolvePaths: resolveStemPaths } = require('./stem-runtime.cjs')
const { realFilePath, isPathInside } = require('./audio-download.cjs')

const RUNNER_VERSION = 'track-stem-runner-v2'
const SAMPLE_RATE = 44_100
const CORE_SECONDS = 20
const DEFAULT_CONTEXT_SECONDS = 2
const DEFAULT_CHUNK_SECONDS = 5
const DEFAULT_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000
const DEFAULT_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const STEM_NAMES = ['drums', 'bass', 'vocals', 'other']

function existingFile(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  try {
    const resolved = fs.realpathSync.native(candidate)
    return fs.statSync(resolved).isFile() ? resolved : null
  } catch { return null }
}

function directorySize(directory) {
  let total = 0
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) total += directorySize(target)
    else if (entry.isFile()) total += fs.statSync(target).size
  }
  return total
}

function atomicWriteJson(target, value) {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2))
  try { fs.renameSync(temporary, target) } catch (error) {
    fs.rmSync(target, { force: true })
    fs.renameSync(temporary, target)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function resolveTrackStemPaths(options = {}) {
  const runnerPath = options.runnerPath || path.join(__dirname, 'workers', 'track_stem_runner.py')
  return resolveStemPaths({ ...options, runnerPath })
}

class TrackStemRuntime {
  constructor(options = {}) {
    this.options = options
    this.paths = resolveTrackStemPaths(options)
    const userDataPath = this.paths.appInfo.userDataPath || os.tmpdir()
    this.cacheDir = path.resolve(options.cachePath || path.join(userDataPath, 'analysis-cache', 'track-stems'))
    this.tempDir = path.join(this.cacheDir, '.tmp')
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.decoderPythonPath = existingFile(options.decoderPythonPath || process.env.WAVEFORGE_DECODER_PYTHON)
    this.spawn = options.spawn || spawn
    this.queue = []
    this.pendingTasks = new Map()
    this.trackGenerations = new Map()
    this.active = null
    this.worker = null
    this.workerReady = null
    this.workerBuffer = ''
    this.workerPending = new Map()
    this.sequence = 0
    this.closed = false
    fs.mkdirSync(this.tempDir, { recursive: true })
  }

  status() {
    this.paths = resolveTrackStemPaths(this.options)
    const reason = !this.paths.modelPath ? 'model-not-found'
      : !this.paths.pythonPath ? 'runtime-not-found'
        : !this.paths.runnerPath ? 'runner-not-found' : null
    return {
      available: !reason,
      reason,
      modelPath: this.paths.modelPath,
      pythonPath: this.paths.pythonPath,
      runnerPath: this.paths.runnerPath,
      workerReady: Boolean(this.worker && this.workerReady),
      active: this.active ? this._publicJob(this.active) : null,
      queued: this.queue.map(job => this._publicJob(job)),
      cacheMaxBytes: this.cacheMaxBytes,
      cacheTtlMs: this.cacheTtlMs,
      runnerVersion: RUNNER_VERSION,
    }
  }

  getStatus() { return this.status() }

  async materialize(request = {}) {
    if (this.closed) throw new Error('Track stem runtime is shut down')
    const status = this.status()
    if (!status.available) return null
    const normalized = this._normalizeRequest(request)
    this._activateGeneration(normalized.trackId, normalized.generationToken)
    const cacheKey = this._cacheKey(normalized)
    const manifest = this._readManifest(cacheKey, normalized)
    const tasks = this._planTasks(normalized, manifest)
    if (!tasks.length) return { ...manifest, cached: true, requestId: normalized.requestId }
    const results = await Promise.all(tasks.map(task => this._enqueue(task, normalized, cacheKey)))
    this._assertCurrent(normalized)
    return {
      ...this._readManifest(cacheKey, normalized),
      cached: results.every(result => result.cached),
      requestId: normalized.requestId,
    }
  }

  ensureWindow(request = {}) {
    const priority = request.priority ?? 1_000_000
    const requestedStart = Number(request.start ?? request.startSeconds ?? request.window?.start ?? 0)
    if (this.active && this.active.priority <= priority) {
      const activeEnd = this.active.coreStart + this.active.coreDuration
      const coversRequested = requestedStart >= this.active.coreStart && requestedStart < activeEnd
      if (!coversRequested) this.cancel({ requestId: this.active.requestId })
    }
    const window = request.window || {
      start: request.start ?? request.startSeconds,
      duration: request.duration ?? request.durationSeconds,
      end: request.end ?? request.endSeconds,
    }
    return this.materialize({ ...request, windows: [window], priority })
  }

  cancel(selector) {
    const match = typeof selector === 'string'
      ? job => job.requestId === selector || job.trackId === selector
      : job => (!selector?.requestId || job.requestId === selector.requestId)
        && (!selector?.trackId || job.trackId === selector.trackId)
        && (!selector?.generationToken || job.generationToken === String(selector.generationToken))
    let cancelled = false
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]
      if (!match(job)) continue
      this.queue.splice(index, 1)
      this.pendingTasks.delete(job.taskKey)
      job.reject(new Error('Track stem request cancelled'))
      cancelled = true
    }
    if (this.active && match(this.active)) {
      this.active.cancelled = true
      try { this.worker?.kill() } catch { /* worker may already be exiting */ }
      cancelled = true
    }
    return cancelled
  }

  getCacheStats() {
    let count = 0
    let size = 0
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      count += 1
      try { size += directorySize(path.join(this.cacheDir, entry.name)) } catch { /* concurrent cleanup */ }
    }
    return { count, size, maxBytes: this.cacheMaxBytes, cachePath: this.cacheDir }
  }

  async clearCache() {
    for (const job of [...this.queue]) this.cancel({ requestId: job.requestId })
    const activePromise = this.active?.promise
    if (this.active) this.cancel({ requestId: this.active.requestId })
    if (activePromise) await activePromise.catch(() => undefined)
    let cleared = 0
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      fs.rmSync(path.join(this.cacheDir, entry.name), { recursive: true, force: true })
      cleared++
    }
    return { success: true, cleared }
  }

  cleanupCache(now = Date.now()) {
    const entries = []
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      const target = path.join(this.cacheDir, entry.name)
      try {
        const stats = fs.statSync(target)
        if (now - stats.mtimeMs > this.cacheTtlMs) {
          fs.rmSync(target, { recursive: true, force: true })
          continue
        }
        entries.push({ target, size: directorySize(target), mtimeMs: stats.mtimeMs })
      } catch { /* A concurrent cleanup may remove an entry. */ }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const entry of entries) {
      if (total <= this.cacheMaxBytes) break
      fs.rmSync(entry.target, { recursive: true, force: true })
      total -= entry.size
    }
  }

  async readChunk(filePath) {
    const resolved = realFilePath(filePath)
    const cacheRoot = fs.realpathSync.native(this.cacheDir)
    if (!resolved || !isPathInside(cacheRoot, resolved) || path.extname(resolved).toLowerCase() !== '.wav') {
      throw new Error('Track stem chunk path is outside the cache')
    }
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid track stem chunk')
    const buffer = await fsp.readFile(resolved)
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  }

  shutdown() {
    if (this.closed) return
    this.closed = true
    for (const job of this.queue.splice(0)) {
      this.pendingTasks.delete(job.taskKey)
      job.reject(new Error('Track stem runtime shut down'))
    }
    if (this.active) this.active.cancelled = true
    const worker = this.worker
    this.worker = null
    if (worker) {
      try { worker.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n') } catch { /* exited */ }
      const timer = setTimeout(() => { if (!worker.killed) worker.kill() }, 1000)
      timer.unref?.()
    }
    this._rejectWorkerPending(new Error('Track stem worker shut down'))
  }

  _normalizeRequest(request) {
    const inputPath = existingFile(request.inputPath || request.audioPath)
    if (!inputPath) throw new Error('Track stem input audio does not exist')
    if (typeof this.options.isInputAllowed !== 'function' || !this.options.isInputAllowed(inputPath)) {
      throw new Error('Track stem input audio is not authorized')
    }
    const trackId = String(request.trackId || inputPath)
    const generationToken = String(request.generationToken ?? request.generation ?? 'default')
    const requestId = String(request.requestId || crypto.randomUUID())
    const chunkSeconds = Number(request.chunkSeconds ?? DEFAULT_CHUNK_SECONDS)
    if (chunkSeconds !== 5 && chunkSeconds !== 10) throw new Error('chunkSeconds must be 5 or 10')
    const sampleRate = Number(request.sampleRate ?? SAMPLE_RATE)
    if (sampleRate !== SAMPLE_RATE) throw new Error(`sampleRate must be ${SAMPLE_RATE}`)
    const contextSeconds = Number(request.contextSeconds ?? DEFAULT_CONTEXT_SECONDS)
    if (!Number.isFinite(contextSeconds) || contextSeconds < 0 || contextSeconds > 10) {
      throw new Error('contextSeconds must be between 0 and 10')
    }
    const rawWindows = Array.isArray(request.windows) ? request.windows : [request.window || request]
    if (rawWindows.length === 0 || rawWindows.length > 32) throw new Error('Track stem request supports 1..32 windows')
    let totalDuration = 0
    const windows = rawWindows.map((window, index) => {
      const start = Number(window.start ?? window.startSeconds ?? window.startTime ?? 0)
      const explicitDuration = window.duration ?? window.durationSeconds
      const duration = explicitDuration === undefined
        ? Number(window.end ?? window.endSeconds ?? window.endTime) - start
        : Number(explicitDuration)
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > 6 * 60 * 60) {
        throw new Error(`window ${index} must have a non-negative start and duration in (0, 21600]`)
      }
      totalDuration += duration
      return { start, duration }
    })
    if (totalDuration > 6 * 60 * 60) throw new Error('Track stem request total duration exceeds 21600 seconds')
    return {
      inputPath, trackId, generationToken, requestId, chunkSeconds, sampleRate, contextSeconds, windows,
      priority: Number.isFinite(Number(request.priority)) ? Number(request.priority) : 0,
    }
  }

  _activateGeneration(trackId, generationToken) {
    const previous = this.trackGenerations.get(trackId)
    if (previous === generationToken) return
    this.trackGenerations.set(trackId, generationToken)
    for (let index = this.queue.length - 1; index >= 0; index--) {
      const job = this.queue[index]
      if (job.trackId !== trackId || job.generationToken === generationToken) continue
      this.queue.splice(index, 1)
      this.pendingTasks.delete(job.taskKey)
      job.reject(new Error('Track stem request is stale'))
    }
    if (this.active?.trackId === trackId && this.active.generationToken !== generationToken) {
      this.active.cancelled = true
      try { this.worker?.kill() } catch { /* worker may already be exiting */ }
    }
  }

  _assertCurrent(request) {
    if (this.closed || this.trackGenerations.get(request.trackId) !== request.generationToken) {
      throw new Error('Track stem request is stale')
    }
  }

  _cacheKey(request) {
    const input = fs.statSync(request.inputPath)
    const model = fs.statSync(this.paths.modelPath)
    return crypto.createHash('sha256').update(JSON.stringify({
      inputPath: request.inputPath,
      inputSize: input.size,
      inputMtimeMs: input.mtimeMs,
      modelPath: this.paths.modelPath,
      modelSize: model.size,
      modelMtimeMs: model.mtimeMs,
      runnerVersion: RUNNER_VERSION,
      sampleRate: request.sampleRate,
      chunkSeconds: request.chunkSeconds,
      contextSeconds: request.contextSeconds,
      coreSeconds: CORE_SECONDS,
    })).digest('hex')
  }

  _emptyManifest(cacheKey, request) {
    const directory = path.join(this.cacheDir, cacheKey)
    return {
      version: 1,
      cacheKey,
      inputPath: request.inputPath,
      modelPath: this.paths.modelPath,
      runnerVersion: RUNNER_VERSION,
      sampleRate: request.sampleRate,
      channels: 2,
      chunkSeconds: request.chunkSeconds,
      contextSeconds: request.contextSeconds,
      chunks: [],
      completedCores: [],
      manifestPath: path.join(directory, 'manifest.json'),
    }
  }

  _readManifest(cacheKey, request) {
    const manifest = this._emptyManifest(cacheKey, request)
    const directory = path.dirname(manifest.manifestPath)
    try {
      const stats = fs.statSync(directory)
      if (Date.now() - stats.mtimeMs > this.cacheTtlMs) {
        fs.rmSync(directory, { recursive: true, force: true })
        return manifest
      }
      const cached = JSON.parse(fs.readFileSync(manifest.manifestPath, 'utf8'))
      if (cached.cacheKey !== cacheKey || !Array.isArray(cached.chunks)) throw new Error('invalid manifest')
      cached.chunks = cached.chunks.filter(chunk => STEM_NAMES.every(name => existingFile(chunk.files?.[name])))
      const now = new Date()
      fs.utimesSync(directory, now, now)
      return cached
    } catch {
      return manifest
    }
  }

  _planTasks(request, manifest) {
    const tasks = []
    const covered = new Set(manifest.chunks.map(chunk => `${chunk.startSeconds}:${chunk.frames}`))
    const completed = new Set((manifest.completedCores || []).map(core => `${core.start}:${core.duration}`))
    for (const window of request.windows) {
      const end = window.start + window.duration
      for (let start = window.start; start < end - 1e-9; start += CORE_SECONDS) {
        const duration = Math.min(CORE_SECONDS, end - start)
        if (completed.has(`${start}:${duration}`)) continue
        let complete = true
        const expectedFrames = Math.round(duration * request.sampleRate)
        const chunkFrames = request.chunkSeconds * request.sampleRate
        for (let offset = 0; offset < expectedFrames; offset += chunkFrames) {
          const frames = Math.min(chunkFrames, expectedFrames - offset)
          if (!covered.has(`${start + offset / request.sampleRate}:${frames}`)) complete = false
        }
        if (!complete) tasks.push({ coreStart: start, coreDuration: duration })
      }
    }
    return tasks
  }

  _enqueue(task, request, cacheKey) {
    const taskKey = `${cacheKey}:${request.trackId}:${request.generationToken}:${task.coreStart}:${task.coreDuration}`
    const existing = this.pendingTasks.get(taskKey)
    if (existing) return existing.promise
    let resolve
    let reject
    const promise = new Promise((accept, decline) => { resolve = accept; reject = decline })
    const job = {
      ...task, taskKey, cacheKey, resolve, reject, promise,
      inputPath: request.inputPath,
      trackId: request.trackId,
      generationToken: request.generationToken,
      requestId: request.requestId,
      priority: request.priority,
      chunkSeconds: request.chunkSeconds,
      sampleRate: request.sampleRate,
      contextSeconds: request.contextSeconds,
      sequence: this.sequence++,
      cancelled: false,
    }
    this.pendingTasks.set(taskKey, job)
    this.queue.push(job)
    this.queue.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
    this._drain()
    return promise
  }

  _drain() {
    if (this.active || this.closed) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    this._run(job).then(job.resolve, job.reject).finally(() => {
      this.pendingTasks.delete(job.taskKey)
      if (this.active === job) this.active = null
      this._drain()
    })
  }

  async _run(job) {
    this.cleanupCache()
    const directory = path.join(this.cacheDir, job.cacheKey)
    fs.mkdirSync(directory, { recursive: true })
    const result = await this._workerRequest({
      type: 'separate',
      inputPath: job.inputPath,
      outputDir: directory,
      coreStart: job.coreStart,
      coreDuration: job.coreDuration,
      contextSeconds: job.contextSeconds,
      chunkSeconds: job.chunkSeconds,
      sampleRate: job.sampleRate,
      ffmpegPath: this.paths.ffmpegPath,
      decoderPythonPath: this.decoderPythonPath,
    })
    if (job.cancelled || this.trackGenerations.get(job.trackId) !== job.generationToken) {
      throw new Error('Track stem request is stale or cancelled')
    }
    if (!result.validation?.lengthsMatch || !result.validation?.finite || !result.validation?.reconstructsMix) {
      throw new Error('Track stem worker returned invalid output')
    }
    const manifest = this._readManifest(job.cacheKey, job)
    const byId = new Map(manifest.chunks.map(chunk => [chunk.id, chunk]))
    for (const chunk of result.chunks) byId.set(chunk.id, chunk)
    manifest.chunks = [...byId.values()].sort((left, right) => left.startSeconds - right.startSeconds)
    const completedCores = new Map((manifest.completedCores || []).map(core => [`${core.start}:${core.duration}`, core]))
    completedCores.set(`${job.coreStart}:${job.coreDuration}`, {
      start: job.coreStart,
      duration: job.coreDuration,
      materializedDuration: result.coreDuration ?? job.coreDuration,
    })
    manifest.completedCores = [...completedCores.values()].sort((left, right) => left.start - right.start)
    manifest.updatedAt = new Date().toISOString()
    atomicWriteJson(manifest.manifestPath, manifest)
    this.cleanupCache()
    return { ...result, cached: false }
  }

  async _ensureWorker() {
    if (this.worker && this.workerReady) return this.workerReady
    if (this.closed) throw new Error('Track stem runtime is shut down')
    this.paths = resolveTrackStemPaths(this.options)
    if (!this.paths.modelPath) throw new Error('HTDemucs model not found')
    if (!this.paths.pythonPath || !this.paths.runnerPath) throw new Error('Track stem worker runtime not found')
    const child = this.spawn(this.paths.pythonPath, ['-u', this.paths.runnerPath, '--model', this.paths.modelPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1' },
    })
    this.worker = child
    this.workerBuffer = ''
    let readyResolve
    let readyReject
    this.workerReady = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
    child.stdout.on('data', data => this._handleWorkerData(data, readyResolve, readyReject))
    child.stderr.on('data', data => { this.lastWorkerError = data.toString().trim() })
    child.once('error', error => this._workerExited(error, readyReject))
    child.once('exit', code => this._workerExited(new Error(`Track stem worker exited (${code}): ${this.lastWorkerError || 'no error output'}`), readyReject))
    return this.workerReady
  }

  _handleWorkerData(data, readyResolve, readyReject) {
    this.workerBuffer += data.toString()
    const lines = this.workerBuffer.split(/\r?\n/)
    this.workerBuffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (message.type === 'ready') {
        readyResolve(message)
        continue
      }
      if (message.type === 'fatal') {
        readyReject(new Error(message.error || 'Track stem worker failed to initialize'))
        continue
      }
      const pending = this.workerPending.get(message.id)
      if (!pending) continue
      this.workerPending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.type === 'error') pending.reject(new Error(message.error || 'Track stem worker error'))
      else pending.resolve(message.result)
    }
  }

  _workerExited(error, readyReject) {
    readyReject?.(error)
    this.worker = null
    this.workerReady = null
    this._rejectWorkerPending(error)
  }

  _rejectWorkerPending(error) {
    for (const pending of this.workerPending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.workerPending.clear()
  }

  async _workerRequest(payload) {
    await this._ensureWorker()
    const id = `track-stem-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerPending.delete(id)
        reject(new Error(`Track stem inference timed out after ${this.timeoutMs}ms`))
        this.worker?.kill()
      }, this.timeoutMs)
      timer.unref?.()
      this.workerPending.set(id, { resolve, reject, timer })
      try { this.worker.stdin.write(JSON.stringify({ ...payload, id }) + '\n') } catch (error) {
        clearTimeout(timer)
        this.workerPending.delete(id)
        reject(error)
      }
    })
  }

  _publicJob(job) {
    return {
      requestId: job.requestId,
      trackId: job.trackId,
      generationToken: job.generationToken,
      coreStart: job.coreStart,
      coreDuration: job.coreDuration,
      priority: job.priority,
    }
  }
}

let singleton = null

function getTrackStemRuntime(options = {}) {
  if (!singleton) singleton = new TrackStemRuntime(options)
  return singleton
}

function setupTrackStemIPC(ipcMain, options = {}) {
  const runtime = getTrackStemRuntime(options)
  ipcMain.handle('track-stem:status', () => runtime.status())
  ipcMain.handle('track-stem:materialize', (_event, request) => runtime.materialize(request))
  ipcMain.handle('track-stem:ensureWindow', (_event, request) => runtime.ensureWindow(request))
  ipcMain.handle('track-stem:cancel', (_event, selector) => runtime.cancel(selector))
  ipcMain.handle('track-stem:readChunk', (_event, filePath) => runtime.readChunk(filePath))
  ipcMain.handle('track-stem:getCacheStats', () => runtime.getCacheStats())
  ipcMain.handle('track-stem:clearCache', () => runtime.clearCache())
  return runtime
}

function cleanupTrackStemRuntime() {
  singleton?.shutdown()
  singleton = null
}

module.exports = {
  TrackStemRuntime,
  getTrackStemRuntime,
  setupTrackStemIPC,
  cleanupTrackStemRuntime,
  resolveTrackStemPaths,
  RUNNER_VERSION,
  SAMPLE_RATE,
  CORE_SECONDS,
}
