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
/** worker 启动（python + onnxruntime + 模型加载）的独立超时：本机实测 8–15s，
 *  初始化挂住时不能让它永远悬着（此时推理超时计时器还没建，首条请求会无限等待）。 */
const WORKER_START_TIMEOUT_MS = 60 * 1000
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
      this._killWorker(new Error('Track stem request cancelled'))
      cancelled = true
    }
    return cancelled
  }

  /**
   * 杀掉当前 worker 并**同步**清空引用。
   * kill() 返回到子进程真正 exit 之间，exitCode 仍是 null（进程还没退），只判 worker/exitCode
   * 会把这次调用当"worker 还活着"、返回已 resolve 的旧 workerReady，于是新请求被写进垂死进程的
   * stdin，随后随旧进程 exit 一起 reject（或挂到超时）。用户实测表现：拖动人声滑块/重试时
   * 分离任务静默失败——而每次 enable 都会换 generation 并 kill 上一次的 worker，正好步步踩中。
   */
  _killWorker(reason) {
    const worker = this.worker
    this.worker = null
    this.workerReady = null
    if (!worker) return
    try { worker.kill() } catch { /* worker may already be exiting */ }
    this._rejectWorkerPending(reason instanceof Error ? reason : new Error(String(reason || 'Track stem worker stopped')))
  }

  // getCacheStats 只保留一份（此前定义两次，后者静默覆盖前者；这份字段是超集且带 try/catch）
  getCacheStats() {
    let count = 0
    let size = 0
    for (const entry of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === '.tmp') continue
      try { count++; size += directorySize(path.join(this.cacheDir, entry.name)) } catch { /* concurrent cleanup */ }
    }
    return { count, size, totalSize: size, maxBytes: this.cacheMaxBytes, cachePath: this.cacheDir }
  }

  async clearCache() {
    const protectedKeys = new Set([
      ...this.queue.map(job => job.cacheKey),
      ...(this.active ? [this.active.cacheKey] : []),
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
      ...this.queue.map(job => job.cacheKey),
      ...(this.active ? [this.active.cacheKey] : []),
    ])
    for (const entry of fs.readdirSync(this.tempDir, { withFileTypes: true })) {
      const target = path.join(this.tempDir, entry.name)
      try { fs.rmSync(target, { recursive: entry.isDirectory(), force: true }) } catch {}
    }
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

  /**
   * 闲置回收：停掉常驻 worker，但保留 runtime 可再次按需拉起（与 shutdown 的区别是不置 closed）。
   * 用途：游戏模式冻结 / 长时间无分离任务——HTDemucs worker 常驻 torch + 模型权重是本软件
   * 最大的单块内存，而它只在需要分轨时才工作；下次任务由 _ensureWorker 自动重启。
   * 有在途任务或排队任务时不动（原则：还在被调用就不能停）。
   */
  stopIdleWorker() {
    if (this.closed) return false
    if (this.active || this.queue.length > 0) return false
    const worker = this.worker
    if (!worker) return false
    this.worker = null
    this.workerReady = null
    try { worker.stdin.write(JSON.stringify({ type: 'shutdown' }) + '\n') } catch { /* exited */ }
    const timer = setTimeout(() => { if (!worker.killed) worker.kill() }, 1000)
    timer.unref?.()
    this._rejectWorkerPending(new Error('Track stem worker stopped while idle'))
    return true
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
    this.workerReady = null
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
      this._killWorker(new Error('Track stem generation changed'))
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
    // killed 与 exitCode === null 都要判：kill() 之后到子进程真正 exit 之间 exitCode 仍是 null，
    // 单判 exitCode 会把垂死进程当存活、返回已 resolve 的旧 workerReady（见 _killWorker 注释）
    if (this.worker && this.worker.exitCode === null && !this.worker.killed && this.workerReady) return this.workerReady
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
    child.once('error', error => this._workerExited(child, error, readyReject))
    child.once('exit', code => this._workerExited(child, new Error(`Track stem worker exited (${code}): ${this.lastWorkerError || 'no error output'}`), readyReject))
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

  _workerExited(child, error, readyReject) {
    readyReject?.(error)
    // 只清理"当前 worker"的状态：旧 worker 被 kill 后可能已经拉起新 worker，
    // 无脑清空会把新 worker 的引用一起抹掉，随后 _ensureWorker 又会把请求写进已死进程
    if (this.worker !== child) return
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
    // 启动超时单独计时：原先的推理超时在 await _ensureWorker() 之后才创建，
    // worker 拉不起来（onnxruntime 初始化挂住/模型损坏）时首条请求会永远悬着，界面卡在"正在准备分轨"
    let startTimer = null
    try {
      await Promise.race([
        this._ensureWorker(),
        new Promise((_, reject) => {
          startTimer = setTimeout(() => {
            this._killWorker(new Error(`Track stem worker did not start within ${WORKER_START_TIMEOUT_MS}ms`))
            reject(new Error(`Track stem worker did not start within ${WORKER_START_TIMEOUT_MS}ms`))
          }, WORKER_START_TIMEOUT_MS)
          startTimer.unref?.()
        }),
      ])
    } finally {
      if (startTimer) clearTimeout(startTimer)
    }
    const id = `track-stem-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.workerPending.delete(id)
        reject(new Error(`Track stem inference timed out after ${this.timeoutMs}ms`))
        this._killWorker(new Error('Track stem inference timed out'))
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
  // 重任务（HTDemucs 分离/整曲物化）与清缓存加主窗来源校验；status/readChunk 只读放开
  // （readChunk 另有缓存根 + .wav 后缀 + 16MB 上限三重路径限定）。
  const guard = options.assertMainSender || ((event) => {
    if (!event?.sender) throw new Error('不允许的 IPC 请求来源')
  })
  const guarded = (handler) => (event, ...args) => {
    guard(event)
    return handler(...args)
  }
  ipcMain.handle('track-stem:status', () => runtime.status())
  ipcMain.handle('track-stem:materialize', guarded((request) => runtime.materialize(request)))
  ipcMain.handle('track-stem:ensureWindow', guarded((request) => runtime.ensureWindow(request)))
  ipcMain.handle('track-stem:cancel', guarded((selector) => runtime.cancel(selector)))
  ipcMain.handle('track-stem:readChunk', (_event, filePath) => runtime.readChunk(filePath))
  ipcMain.handle('track-stem:getCacheStats', () => runtime.getCacheStats())
  ipcMain.handle('track-stem:clearCache', guarded(() => runtime.clearCache()))
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
