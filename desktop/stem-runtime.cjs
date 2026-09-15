'use strict'

const { spawn } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_CACHE_MAX_BYTES = 1024 * 1024 * 1024
const STEM_NAMES = ['drums', 'bass', 'vocals', 'other']

function existingFile(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  try {
    const resolved = fs.realpathSync.native(candidate)
    return fs.statSync(resolved).isFile() ? resolved : null
  } catch {
    return null
  }
}

function externalProcessPath(candidate, packaged) {
  if (!packaged) return candidate
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

function defaultAppInfo() {
  try {
    const { app } = require('electron')
    return {
      isPackaged: Boolean(app?.isPackaged),
      userDataPath: app?.getPath?.('userData'),
      appDataPath: app?.getPath?.('appData'),
      exePath: app?.getPath?.('exe'),
      resourcesPath: process.resourcesPath,
    }
  } catch {
    return {}
  }
}

function resolvePaths(options = {}) {
  const appInfo = { ...defaultAppInfo(), ...(options.appInfo || {}) }
  const modelCandidates = [
    options.modelPath,
    process.env.WAVEFORGE_HTDEMUCS_MODEL,
    options.modelsPath && path.join(options.modelsPath, 'htdemucs.onnx'),
    appInfo.userDataPath && path.join(appInfo.userDataPath, 'models', 'htdemucs.onnx'),
    appInfo.resourcesPath && path.join(appInfo.resourcesPath, 'models', 'htdemucs.onnx'),
  ]
  const modelPath = modelCandidates.map(existingFile).find(candidate => (
    candidate && (typeof options.isModelTrusted !== 'function' || options.isModelTrusted(candidate))
  )) || null
  const modelDir = modelPath ? path.dirname(modelPath) : (options.modelsPath || null)
  const runtimeCandidates = [
    options.runtimePath,
    process.env.WAVEFORGE_HTDEMUCS_RUNTIME,
    modelDir && path.join(modelDir, 'runtime'),
    appInfo.resourcesPath && path.join(appInfo.resourcesPath, 'python-embed'),
  ].filter(Boolean).map(candidate => path.resolve(candidate))
  const pythonCandidates = [
    options.pythonPath,
    process.env.WAVEFORGE_HTDEMUCS_PYTHON,
    ...runtimeCandidates.map(runtime => path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'bin/python3')),
  ]
  const pythonPath = pythonCandidates.map(existingFile).find(candidate => (
    candidate && (typeof options.isRuntimeTrusted !== 'function' || options.isRuntimeTrusted(candidate))
  )) || null
  const runnerCandidate = options.runnerPath || path.join(__dirname, 'workers', 'htdemucs_runner.py')
  const runnerPath = existingFile(externalProcessPath(runnerCandidate, appInfo.isPackaged))
  const ffmpegPath = existingFile(options.ffmpegPath || process.env.WAVEFORGE_FFMPEG_PATH)
  return { modelPath, pythonPath, runnerPath, ffmpegPath, appInfo }
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

class StemRuntime {
  constructor(options = {}) {
    this.options = options
    this.paths = resolvePaths(options)
    const userDataPath = this.paths.appInfo.userDataPath || os.tmpdir()
    this.cacheDir = path.resolve(options.cachePath || path.join(userDataPath, 'analysis-cache', 'stems'))
    this.tempDir = path.join(this.cacheDir, '.tmp')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.cacheMaxBytes = options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES
    this.spawn = options.spawn || spawn
    this.workerInterpreterArgs = options.workerInterpreterArgs || ['-u']
    this.queue = []
    this.active = null
    this.worker = null
    this.workerReady = null
    this.workerBuffer = ''
    this.workerPending = new Map()
    this.sequence = 0
    this.closed = false
    fs.mkdirSync(this.tempDir, { recursive: true })
  }

  getStatus() {
    this.paths = resolvePaths(this.options)
    return {
      available: Boolean(this.paths.modelPath && this.paths.pythonPath && this.paths.runnerPath),
      modelPath: this.paths.modelPath,
      pythonPath: this.paths.pythonPath,
      runnerPath: this.paths.runnerPath,
      reason: !this.paths.modelPath ? 'model-not-found'
        : !this.paths.pythonPath ? 'runtime-not-found'
          : !this.paths.runnerPath ? 'runner-not-found' : null,
    }
  }

  async separate(request = {}, control = {}) {
    if (this.closed) throw new Error('Stem runtime is shut down')
    const status = this.getStatus()
    // Missing optional model/runtime is a normal product fallback, not an exception.
    if (!status.available) return null
    const normalized = this._validateRequest(request)
    const cacheKey = this._cacheKey(normalized)
    const cached = this._readCache(cacheKey)
    if (cached) return { ...cached, cached: true, requestId: normalized.requestId }
    const [result] = await this._enqueue({ requests: [normalized], cacheKeys: [cacheKey], requestId: normalized.requestId }, control)
    return result
  }

  async separatePair(request = {}, control = {}) {
    if (this.closed) throw new Error('Stem runtime is shut down')
    const status = this.getStatus()
    if (!status.available) return null
    const requestId = typeof request.requestId === 'string' && request.requestId ? request.requestId : crypto.randomUUID()
    const source = this._validateRequest({ ...request.source, requestId: `${requestId}:source` })
    const target = this._validateRequest({ ...request.target, requestId: `${requestId}:target` })
    const requests = [source, target]
    const cacheKeys = requests.map(item => this._cacheKey(item))
    const results = requests.map((item, index) => {
      const cached = this._readCache(cacheKeys[index])
      return cached ? { ...cached, cached: true, requestId: item.requestId } : null
    })
    const missingIndexes = results.map((result, index) => result ? -1 : index).filter(index => index >= 0)
    if (!missingIndexes.length) return { requestId, source: results[0], target: results[1] }
    const missingRequests = missingIndexes.map(index => requests[index])
    const missingCacheKeys = missingIndexes.map(index => cacheKeys[index])
    const generated = await this._enqueue({ requests: missingRequests, cacheKeys: missingCacheKeys, requestId }, control)
    missingIndexes.forEach((index, generatedIndex) => { results[index] = generated[generatedIndex] })
    return { requestId, source: results[0], target: results[1] }
  }

  _enqueue(jobInput, control = {}) {
    return new Promise((resolve, reject) => {
      const job = { ...jobInput, resolve, reject, settled: false }
      this.queue.push(job)
      if (control.signal) {
        const abort = () => this.cancel(job.requestId)
        job.abortSignal = control.signal
        job.abortListener = abort
        if (control.signal.aborted) abort()
        else control.signal.addEventListener('abort', abort, { once: true })
      }
      this._drain()
    })
  }

  cancel(requestId) {
    if (typeof requestId !== 'string' || !requestId) return false
    const queuedIndex = this.queue.findIndex(job => job.requestId === requestId || job.requests.some(request => request.requestId === requestId))
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1)
      this._settle(job, new Error('Stem separation cancelled'))
      return true
    }
    if (this.active && (this.active.requestId === requestId || this.active.requests.some(request => request.requestId === requestId))) {
      this.active.cancelled = true
      this.worker?.kill()
      return true
    }
    return false
  }

  getCacheStats() {
    let count = 0
    let size = 0
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      try { count++; size += directorySize(path.join(this.cacheDir, entry.name)) } catch {}
    }
    return { count, size, totalSize: size, maxBytes: this.cacheMaxBytes, cachePath: this.cacheDir }
  }

  async clearCache() {
    const protectedKeys = new Set([
      ...this.queue.flatMap(job => job.cacheKeys),
      ...(this.active?.cacheKeys || []),
    ])
    let cleared = 0
    for (const entry of fs.readdirSync(this.tempDir, { withFileTypes: true })) {
      const target = path.join(this.tempDir, entry.name)
      if (this.active?.tempRunDir === target) continue
      try { fs.rmSync(target, { recursive: entry.isDirectory(), force: true }) } catch {}
    }
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp' || protectedKeys.has(entry.name)) continue
      fs.rmSync(path.join(this.cacheDir, entry.name), { recursive: true, force: true })
      cleared++
    }
    return { success: true, cleared, skippedActive: protectedKeys.size }
  }

  cleanupCache(now = Date.now()) {
    const protectedKeys = new Set([
      ...this.queue.flatMap(job => job.cacheKeys),
      ...(this.active?.cacheKeys || []),
    ])
    const entries = []
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      const target = path.join(this.cacheDir, entry.name)
      if (protectedKeys.has(entry.name)) continue
      try {
        const stats = fs.statSync(target)
        if (now - stats.mtimeMs > this.cacheTtlMs) {
          fs.rmSync(target, { recursive: true, force: true })
          continue
        }
        entries.push({ target, mtimeMs: stats.mtimeMs, size: directorySize(target) })
      } catch { /* Concurrent cleanup or an incomplete directory. */ }
    }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    entries.sort((left, right) => left.mtimeMs - right.mtimeMs)
    for (const entry of entries) {
      if (total <= this.cacheMaxBytes) break
      fs.rmSync(entry.target, { recursive: true, force: true })
      total -= entry.size
    }
  }

  shutdown() {
    this.closed = true
    for (const job of this.queue.splice(0)) this._settle(job, new Error('Stem runtime shut down'))
    if (this.active) this.active.cancelled = true
    if (this.worker) {
      try { this.worker.stdin.write(`${JSON.stringify({ type: 'shutdown', id: 'shutdown' })}\n`) } catch { /* Worker already exited. */ }
      this.worker.stdin.end()
      this.worker.kill()
    }
    this.worker = null
    this.workerReady = null
    this._rejectWorkerPending(new Error('Stem runtime shut down'))
  }

  _validateRequest(request) {
    const inputPath = existingFile(request.inputPath || request.audioPath)
    if (!inputPath) throw new Error('Stem input audio does not exist')
    if (typeof this.options.isInputAllowed !== 'function' || !this.options.isInputAllowed(inputPath)) {
      throw new Error('Stem input audio is not authorized')
    }
    const mode = String(request.mode || request.position || 'head').toLowerCase()
    if (mode !== 'head' && mode !== 'tail') throw new Error("Stem mode must be 'head' or 'tail'")
    const duration = Number(request.duration ?? request.durationSeconds ?? 40)
    if (!Number.isFinite(duration) || duration <= 0 || duration > 40) {
      throw new Error('Stem duration must be > 0 and <= 40 seconds')
    }
    const startTime = request.startTime === undefined || request.startTime === null
      ? null
      : Number(request.startTime)
    if (startTime !== null && (!Number.isFinite(startTime) || startTime < 0)) {
      throw new Error('Stem startTime must be a finite non-negative number')
    }
    const requestId = typeof request.requestId === 'string' && request.requestId
      ? request.requestId
      : crypto.randomUUID()
    return { inputPath, mode, duration, startTime, requestId }
  }

  _cacheKey(request) {
    const input = fs.statSync(request.inputPath)
    const model = fs.statSync(this.paths.modelPath)
    const runner = fs.statSync(this.paths.runnerPath)
    return crypto.createHash('sha256').update(JSON.stringify({
      version: 3,
      inputPath: request.inputPath,
      inputSize: input.size,
      inputMtimeMs: input.mtimeMs,
      modelPath: this.paths.modelPath,
      modelSize: model.size,
      modelMtimeMs: model.mtimeMs,
      runnerSize: runner.size,
      runnerMtimeMs: runner.mtimeMs,
      mode: request.mode,
      duration: request.duration,
      startTime: request.startTime,
    })).digest('hex')
  }

  _readCache(cacheKey) {
    const directory = path.join(this.cacheDir, cacheKey)
    const manifestPath = path.join(directory, 'manifest.json')
    try {
      const stats = fs.statSync(directory)
      if (Date.now() - stats.mtimeMs > this.cacheTtlMs) {
        fs.rmSync(directory, { recursive: true, force: true })
        return null
      }
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (manifest.cacheKey !== cacheKey || !STEM_NAMES.every(name => existingFile(manifest.files?.[name]))) return null
      const now = new Date()
      fs.utimesSync(directory, now, now)
      return manifest
    } catch {
      fs.rmSync(directory, { recursive: true, force: true })
      return null
    }
  }

  _drain() {
    if (this.active || this.closed) return
    const job = this.queue.shift()
    if (!job) return
    this.active = job
    this._run(job).then(
      result => this._settle(job, null, result),
      error => this._settle(job, error),
    ).finally(() => {
      if (this.active === job) this.active = null
      this._drain()
    })
  }

  _settle(job, error, result) {
    if (job.settled) return
    job.settled = true
    if (job.abortSignal && job.abortListener) job.abortSignal.removeEventListener('abort', job.abortListener)
    if (error) job.reject(error)
    else job.resolve(result)
  }

  async _run(job) {
    this.cleanupCache()
    const runDir = fs.mkdtempSync(path.join(this.tempDir, 'run-'))
    job.tempRunDir = runDir
    const configs = job.requests.map((request, index) => {
      const outputDir = path.join(runDir, `output-${index}`)
      fs.mkdirSync(outputDir)
      return {
        inputPath: request.inputPath,
        modelPath: this.paths.modelPath,
        outputDir,
        mode: request.mode,
        duration: request.duration,
        startTime: request.startTime,
        ffmpegPath: this.paths.ffmpegPath,
      }
    })
    try {
      const payload = configs.length === 1
        ? { type: 'separate', config: configs[0] }
        : { type: 'separate_pair', configs }
      let rawResults
      try {
        rawResults = await this._workerRequest(payload, job)
      } catch (error) {
        if (job.cancelled) throw new Error('Stem separation cancelled')
        throw error
      }
      if (job.cancelled) throw new Error('Stem separation cancelled')
      const results = Array.isArray(rawResults) ? rawResults : [rawResults]
      return results.map((result, index) => this._publishResult(
        result,
        configs[index].outputDir,
        job.cacheKeys[index],
        job.requests[index],
      ))
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true })
      job.tempRunDir = null
    }
  }

  _publishResult(result, outputDir, cacheKey, request) {
    if (!result?.validation?.lengthsMatch || !result?.validation?.finite) {
      throw new Error('HTDemucs runner returned an invalid manifest')
    }
    const destination = path.join(this.cacheDir, cacheKey)
    fs.rmSync(destination, { recursive: true, force: true })
    fs.renameSync(outputDir, destination)
    const files = Object.fromEntries(STEM_NAMES.map(name => [name, path.join(destination, `${name}.wav`)]))
    const manifest = {
      ...result,
      cacheKey,
      cached: false,
      requestId: request.requestId,
      files,
      manifestPath: path.join(destination, 'manifest.json'),
    }
    fs.writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2))
    this.cleanupCache()
    return manifest
  }

  async _ensureWorker() {
    if (this.worker && this.workerReady) return this.workerReady
    if (this.closed) throw new Error('Stem runtime is shut down')
    this.paths = resolvePaths(this.options)
    if (!this.paths.modelPath || !this.paths.pythonPath || !this.paths.runnerPath) {
      throw new Error('HTDemucs runtime is unavailable')
    }
    const child = this.spawn(this.paths.pythonPath, [...this.workerInterpreterArgs, this.paths.runnerPath, '--serve', '--model', this.paths.modelPath], {
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
    child.once('exit', code => this._workerExited(new Error(`HTDemucs worker exited (${code}): ${this.lastWorkerError || 'no error output'}`), readyReject))
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
        readyReject(new Error(message.error || 'HTDemucs worker failed to initialize'))
        continue
      }
      const pending = this.workerPending.get(message.id)
      if (!pending) continue
      this.workerPending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.type === 'error') pending.reject(new Error(message.error || 'HTDemucs worker error'))
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

  async _workerRequest(payload, job) {
    await this._ensureWorker()
    const id = `stem-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerPending.delete(id)
        reject(new Error(`Stem separation timed out after ${this.timeoutMs}ms`))
        this.worker?.kill()
      }, this.timeoutMs)
      timer.unref?.()
      this.workerPending.set(id, { resolve, reject, timer })
      try {
        this.worker.stdin.write(`${JSON.stringify({ ...payload, id })}\n`)
      } catch (error) {
        clearTimeout(timer)
        this.workerPending.delete(id)
        reject(error)
      }
      if (job.cancelled) this.worker?.kill()
    })
  }
}

let singleton = null

function getStemRuntime(options = {}) {
  if (!singleton) singleton = new StemRuntime(options)
  return singleton
}

function setupStemIPC(ipcMain, options = {}) {
  const runtime = getStemRuntime(options)
  ipcMain.handle('stem:separate', (_event, request) => runtime.separate(request))
  ipcMain.handle('stem:separatePair', (_event, request) => runtime.separatePair(request))
  ipcMain.handle('stem:status', () => runtime.getStatus())
  ipcMain.handle('stem:cancel', (_event, requestId) => runtime.cancel(requestId))
  ipcMain.handle('stem:clearCache', () => runtime.clearCache())
  return runtime
}

function cleanupStemRuntime() {
  singleton?.shutdown()
  singleton = null
}

module.exports = {
  StemRuntime,
  getStemRuntime,
  setupStemIPC,
  cleanupStemRuntime,
  resolvePaths,
}
