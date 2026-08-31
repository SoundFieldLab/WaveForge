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
    return fs.statSync(candidate).isFile() ? path.resolve(candidate) : null
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
    this.queue = []
    this.active = null
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
    return new Promise((resolve, reject) => {
      const job = { request: normalized, cacheKey, resolve, reject, child: null, settled: false }
      this.queue.push(job)
      if (control.signal) {
        const abort = () => this.cancel(normalized.requestId)
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
    const queuedIndex = this.queue.findIndex(job => job.request.requestId === requestId)
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1)
      this._settle(job, new Error('Stem separation cancelled'))
      return true
    }
    if (this.active?.request.requestId === requestId) {
      this.active.cancelled = true
      this.active.child?.kill()
      return true
    }
    return false
  }

  async clearCache() {
    for (const job of this.queue.splice(0)) this._settle(job, new Error('Stem cache cleared'))
    if (this.active) {
      this.active.cancelled = true
      this.active.child?.kill()
      const deadline = Date.now() + 3000
      while (this.active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    }
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
    if (this.active) {
      this.active.cancelled = true
      this.active.child?.kill()
    }
  }

  _validateRequest(request) {
    const inputPath = existingFile(request.inputPath || request.audioPath)
    if (!inputPath) throw new Error('Stem input audio does not exist')
    const mode = String(request.mode || request.position || 'head').toLowerCase()
    if (mode !== 'head' && mode !== 'tail') throw new Error("Stem mode must be 'head' or 'tail'")
    const duration = Number(request.duration ?? request.durationSeconds ?? 30)
    if (!Number.isFinite(duration) || duration <= 0 || duration > 30) {
      throw new Error('Stem duration must be > 0 and <= 30 seconds')
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
      version: 2,
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
    const outputDir = path.join(runDir, 'output')
    const configPath = path.join(runDir, 'config.json')
    fs.mkdirSync(outputDir)
    fs.writeFileSync(configPath, JSON.stringify({
      inputPath: job.request.inputPath,
      modelPath: this.paths.modelPath,
      outputDir,
      mode: job.request.mode,
      duration: job.request.duration,
      startTime: job.request.startTime,
      ffmpegPath: this.paths.ffmpegPath,
    }))
    try {
      const result = await this._spawnRunner(job, configPath)
      if (job.cancelled) throw new Error('Stem separation cancelled')
      const destination = path.join(this.cacheDir, job.cacheKey)
      fs.rmSync(destination, { recursive: true, force: true })
      fs.renameSync(outputDir, destination)
      const files = Object.fromEntries(STEM_NAMES.map(name => [name, path.join(destination, `${name}.wav`)]))
      const manifest = {
        ...result,
        cacheKey: job.cacheKey,
        cached: false,
        requestId: job.request.requestId,
        files,
        manifestPath: path.join(destination, 'manifest.json'),
      }
      fs.writeFileSync(manifest.manifestPath, JSON.stringify(manifest, null, 2))
      this.cleanupCache()
      return manifest
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true })
    }
  }

  _spawnRunner(job, configPath) {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const child = spawn(this.paths.pythonPath, [this.paths.runnerPath, configPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONNOUSERSITE: '1' },
      })
      job.child = child
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, this.timeoutMs)
      timer.unref?.()
      child.stdout.on('data', data => { stdout += data.toString() })
      child.stderr.on('data', data => { stderr += data.toString() })
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        job.child = null
        if (job.cancelled) return reject(new Error('Stem separation cancelled'))
        if (timedOut) return reject(new Error(`Stem separation timed out after ${this.timeoutMs}ms`))
        if (code !== 0) return reject(new Error(`HTDemucs runner failed (${code}): ${stderr.trim() || 'no error output'}`))
        try {
          const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
          const manifest = JSON.parse(line)
          if (!manifest.validation?.lengthsMatch || !manifest.validation?.finite) {
            throw new Error('HTDemucs runner returned an invalid manifest')
          }
          resolve(manifest)
        } catch (error) {
          reject(new Error(`Invalid HTDemucs runner output: ${error.message}`))
        }
      })
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
