/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn, spawnSync } = require('child_process')
const { AudioDownloadService } = require('./audio-download.cjs')
const automixLog = require('./automix-log.cjs')

const ANALYSIS_SCHEMA_VERSION = 2
const ANALYSIS_RUNTIME_VERSION = 'waveforge-analysis-ipc-v3'
const TRANSITION_RENDER_TTL_MS = 24 * 60 * 60 * 1000
const TRANSITION_RENDER_LIMIT_BYTES = 512 * 1024 * 1024
const TRACK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const TRACK_CACHE_LIMIT_BYTES = 512 * 1024 * 1024
const WORKER_TIMEOUT_MS = 300000 // 5 minutes
const WORKER_IDLE_SHUTDOWN_MS = 60000 // 1 minute
const PYTHON_DETECTION_FAILURE_TTL_MS = 60 * 1000
// 分析缓存 lastAccessAt 的落盘间隔：get 命中后仅在距上次落盘超过该阈值时才重写文件，
// 避免每次命中都原子重写整文件。1h 远小于 30d 的清理 TTL，不影响过期判断。
const LAST_ACCESS_FLUSH_INTERVAL_MS = 60 * 60 * 1000

function externalProcessPath(candidate, app) {
  if (!app.isPackaged) return candidate
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

function createAnalysisRuntime(app, ipcMain, getMainWindow, customCachePath = null) {
  const cacheRoot = customCachePath || path.resolve(app.getPath('userData'), 'analysis-cache')
  const trackRoot = path.join(cacheRoot, 'tracks')
  const legacyBeatRoot = path.join(cacheRoot, 'beat_analysis')
  const transitionRenderRoot = path.join(cacheRoot, 'transition-renders')
  const tempRoot = path.join(cacheRoot, 'temp')
  const jobs = new Map()
  
  console.log('📁 [AnalysisRuntime] 缓存根目录:', cacheRoot)
  
  // Initialize audio download service
  const audioDownload = new AudioDownloadService(tempRoot)
  
  // Python worker state
  let pythonWorker = null
  let workerReady = false
  let workerQueue = []
  let messageId = 0
  let pendingMessages = new Map()
  let workerIdleTimer = null
  let workerStarting = false
  let workerCapabilities = null
  let cachedPythonExecutable = null
  let pythonDetectionCompletedAt = 0
  // 崩溃退避：worker 异常退出后进入冷却期，期间不再反复 spawn，请求直接降级失败，
  // 避免「python 在但脚本坏」时每个请求都拉一个立刻死掉的子进程。
  const WORKER_RESTART_BASE_COOLDOWN_MS = 30 * 1000
  const WORKER_RESTART_MAX_COOLDOWN_MS = 5 * 60 * 1000
  let workerCrashCount = 0
  let workerRestartBlockedUntil = 0
  // 空闲主动关闭（非崩溃）不触发退避
  let workerIdleShutdown = false

  function ensureDirectories() {
    for (const directory of [trackRoot, legacyBeatRoot, transitionRenderRoot, tempRoot]) {
      fs.mkdirSync(directory, { recursive: true })
    }
  }
  
  function findPythonExecutable() {
    const now = Date.now()
    if (cachedPythonExecutable) return cachedPythonExecutable
    if (pythonDetectionCompletedAt && now - pythonDetectionCompletedAt < PYTHON_DETECTION_FAILURE_TTL_MS) {
      return null
    }

    // Probe once and cache the result. A status request used to launch every candidate
    // (usually seven short-lived console processes) each time this function ran.
    const candidates = [
      app.isPackaged
        ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
        : path.join(__dirname, '..', 'resources', 'python-embed', 'python.exe'),
      'python3',
      'python',
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'),
      'C:\\Python311\\python.exe',
      'C:\\Python310\\python.exe',
    ]

    pythonDetectionCompletedAt = now
    for (const candidate of [...new Set(candidates)]) {
      try {
        if (path.isAbsolute(candidate)) {
          if (!fs.existsSync(candidate)) continue
          cachedPythonExecutable = candidate
          return cachedPythonExecutable
        }
        const result = spawnSync(candidate, ['--version'], {
          timeout: 3000,
          windowsHide: true,
          stdio: 'ignore',
        })
        if (!result.error && result.status === 0) {
          cachedPythonExecutable = candidate
          return cachedPythonExecutable
        }
      } catch (e) {
        // Continue to next candidate
      }
    }

    return null
  }
  // 崩溃退避调度：每次异常退出把冷却时间指数翻倍（30s→60s→120s…，上限 5min）。
  function scheduleWorkerRestartBackoff() {
    workerCrashCount += 1
    const delay = Math.min(
      WORKER_RESTART_BASE_COOLDOWN_MS * Math.pow(2, Math.min(workerCrashCount - 1, 6)),
      WORKER_RESTART_MAX_COOLDOWN_MS
    )
    workerRestartBlockedUntil = Date.now() + delay
    console.error(`[AnalysisRuntime] worker 异常退出，${Math.round(delay / 1000)}s 内不再重启（连续失败 ${workerCrashCount} 次）`)
  }

  // 冷却期内的请求直接降级失败（而非无限排队等 5 分钟超时）。
  function failPendingRequests(error) {
    for (const [id, pending] of pendingMessages) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(error)
    }
    pendingMessages.clear()
    workerQueue = []
  }

  function startPythonWorker() {
    if (workerStarting || pythonWorker) return
    
    // 冷却期内不重启：直接降级，避免反复 spawn 立刻死掉的进程
    if (Date.now() < workerRestartBlockedUntil) {
      failPendingRequests(new Error('分析服务暂不可用，正在退避冷却中'))
      return
    }
    
    workerStarting = true
    const pythonExe = findPythonExecutable()
    
    if (!pythonExe) {
      console.error('Python executable not found')
      workerStarting = false
      failPendingRequests(new Error('Python executable not found'))
      return
    }
    
    const workerScript = externalProcessPath(path.join(__dirname, '..', 'server', 'analysis_worker.py'), app)
    
    if (!fs.existsSync(workerScript)) {
      console.error('Analysis worker script not found:', workerScript)
      workerStarting = false
      failPendingRequests(new Error('Analysis worker script not found'))
      return
    }
    
    const checkpointPath = app.isPackaged
      ? path.join(process.resourcesPath, 'beat-this', 'final0.ckpt')
      : path.join(__dirname, '..', 'resources', 'beat-this', 'final0.ckpt')
    if (!fs.existsSync(checkpointPath)) {
      console.error('Beat This checkpoint not found:', checkpointPath)
      workerStarting = false
      failPendingRequests(new Error('Required Beat This final0 model is missing'))
      return
    }

    console.log('Starting Python Beat This analysis worker...')
    pythonWorker = spawn(pythonExe, ['-u', workerScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', BEAT_THIS_CHECKPOINT: checkpointPath },
      windowsHide: true,
    })
    
    let buffer = ''
    
    pythonWorker.stdout.on('data', (data) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      
      for (const line of lines) {
        if (!line.trim()) continue
        
        try {
          const message = JSON.parse(line)
          handleWorkerMessage(message)
        } catch (e) {
          console.error('Failed to parse worker message:', line, e)
        }
      }
    })
    
    pythonWorker.stderr.on('data', (data) => {
      console.log('[Python Worker]', data.toString().trim())
    })
    
    pythonWorker.on('error', (error) => {
      console.error('Python worker error:', error)
      if (!workerIdleShutdown) scheduleWorkerRestartBackoff()
      workerIdleShutdown = false
      cleanupWorker()
    })
    
    pythonWorker.on('exit', (code) => {
      console.log('Python worker exited with code:', code)
      if (!workerIdleShutdown) scheduleWorkerRestartBackoff()
      workerIdleShutdown = false
      cleanupWorker()
    })
    
    workerStarting = false
  }
  
  function cleanupWorker() {
    workerReady = false
    workerStarting = false
    
    if (pythonWorker) {
      try {
        pythonWorker.kill()
      } catch (e) {
        // Ignore
      }
      pythonWorker = null
    }
    
    // Reject all pending messages
    for (const [id, pending] of pendingMessages) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(new Error('Worker terminated'))
    }
    pendingMessages.clear()
    workerQueue = []
    
    if (workerIdleTimer) {
      clearTimeout(workerIdleTimer)
      workerIdleTimer = null
    }
  }
  
  function handleWorkerMessage(message) {
    if (message.type === 'status' && !message.id) {
      // Initial status message
      console.log('Worker status:', message.data)
      workerCapabilities = message.data || null
      workerReady = workerCapabilities?.status === 'ready' && workerCapabilities?.beatThisAvailable === true
      if (!workerReady) {
        const reason = workerCapabilities?.error || 'Required Beat This model is unavailable'
        failPendingRequests(new Error(reason))
        return
      }
      // 成功就绪说明崩溃已恢复，重置退避计数与冷却
      workerCrashCount = 0
      workerRestartBlockedUntil = 0
      workerIdleShutdown = false
      processWorkerQueue()
      return
    }
    
    const pending = pendingMessages.get(message.id)
    if (!pending) {
      console.warn('Received message for unknown ID:', message.id)
      return
    }
    
    pendingMessages.delete(message.id)
    clearTimeout(pending.timeoutHandle)
    
    if (message.type === 'error') {
      pending.reject(new Error(message.error || 'Worker error'))
    } else {
      pending.resolve(message.data)
    }
    
    // Reset idle timer
    resetWorkerIdleTimer()
  }
  
  function sendToWorker(type, data) {
    return new Promise((resolve, reject) => {
      const id = `msg_${++messageId}`
      const message = { type, id, ...data }
      
      const timeoutHandle = setTimeout(() => {
        if (pendingMessages.has(id)) {
          pendingMessages.delete(id)
          workerQueue = workerQueue.filter(message => message.id !== id)
          reject(new Error('Worker request timeout'))
        }
      }, WORKER_TIMEOUT_MS)
      pendingMessages.set(id, { resolve, reject, timeoutHandle })
      
      if (!pythonWorker || !workerReady) {
        workerQueue.push(message)
        if (!pythonWorker && !workerStarting) {
          startPythonWorker()
        }
        return
      }
      
      try {
        pythonWorker.stdin.write(JSON.stringify(message) + '\n')
      } catch (e) {
        clearTimeout(timeoutHandle)
        pendingMessages.delete(id)
        reject(e)
      }
    })
  }
  
  function processWorkerQueue() {
    if (!pythonWorker || !workerReady || workerQueue.length === 0) return
    
    const messages = [...workerQueue]
    workerQueue = []
    
    for (const message of messages) {
      try {
        pythonWorker.stdin.write(JSON.stringify(message) + '\n')
      } catch (e) {
        const pending = pendingMessages.get(message.id)
        if (pending) {
          clearTimeout(pending.timeoutHandle)
          pending.reject(e)
          pendingMessages.delete(message.id)
        }
      }
    }
  }
  
  function resetWorkerIdleTimer() {
    if (workerIdleTimer) {
      clearTimeout(workerIdleTimer)
    }
    
    workerIdleTimer = setTimeout(() => {
      if (pendingMessages.size === 0) {
        console.log('Shutting down idle worker')
        workerIdleShutdown = true // 主动闲置关闭不算崩溃，不触发退避
        cleanupWorker()
      }
    }, WORKER_IDLE_SHUTDOWN_MS)
  }

  function cacheFile(root, key, extension = 'json') {
    const hash = crypto.createHash('sha256').update(String(key)).digest('hex')
    return path.join(root, `${hash}.${extension}`)
  }

  function isInsideCache(target) {
    const relative = path.relative(cacheRoot, path.resolve(target))
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  }

  function atomicWriteJson(target, value) {
    if (!isInsideCache(target)) throw new Error('cache target is outside analysis-cache')
    ensureDirectories()
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(value))
    fs.renameSync(temporary, target)
  }

  function readJson(target) {
    try { return JSON.parse(fs.readFileSync(target, 'utf8')) } catch { return null }
  }

  function versioned(value, defaults = {}) {
    return {
      ...value,
      ...defaults,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      analysisVersion: value.analysisVersion || 'unknown',
      rendererVersion: value.rendererVersion || 'unavailable',
      createdAt: Number(value.createdAt) || Date.now(),
      lastAccessAt: Date.now(),
    }
  }

  function cleanupRenderCache() {
    ensureDirectories()
    const now = Date.now()
    const files = fs.readdirSync(transitionRenderRoot, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const target = path.join(transitionRenderRoot, entry.name)
        const stat = fs.statSync(target)
        return { target, size: stat.size, accessedAt: stat.atimeMs || stat.mtimeMs }
      })
    for (const file of files) {
      if (now - file.accessedAt > TRANSITION_RENDER_TTL_MS && isInsideCache(file.target)) {
        try { fs.rmSync(file.target, { force: true }) } catch {}
      }
    }
    const remaining = files.filter(file => fs.existsSync(file.target)).sort((a, b) => b.accessedAt - a.accessedAt)
    let total = remaining.reduce((sum, file) => sum + file.size, 0)
    for (const file of remaining.reverse()) {
      if (total <= TRANSITION_RENDER_LIMIT_BYTES) break
      if (!isInsideCache(file.target)) continue
      try { fs.rmSync(file.target, { force: true }); total -= file.size } catch {}
    }
  }

  function cleanupJsonCache(root, maxAgeMs, maxBytes) {
    ensureDirectories()
    const now = Date.now()
    const files = fs.readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const target = path.join(root, entry.name)
        const stat = fs.statSync(target)
        return { target, size: stat.size, accessedAt: stat.mtimeMs }
      })

    for (const file of files) {
      if ((file.target.endsWith('.tmp') || now - file.accessedAt > maxAgeMs) && isInsideCache(file.target)) {
        try { fs.rmSync(file.target, { force: true }) } catch {}
      }
    }

    const remaining = files
      .filter(file => fs.existsSync(file.target))
      .sort((a, b) => b.accessedAt - a.accessedAt)
    let total = remaining.reduce((sum, file) => sum + file.size, 0)
    for (const file of remaining.reverse()) {
      if (total <= maxBytes) break
      if (!isInsideCache(file.target)) continue
      try { fs.rmSync(file.target, { force: true }); total -= file.size } catch {}
    }
  }

  function cleanupCaches() {
    audioDownload.cleanupOldFiles()
    cleanupJsonCache(trackRoot, TRACK_CACHE_TTL_MS, TRACK_CACHE_LIMIT_BYTES)
    cleanupJsonCache(legacyBeatRoot, TRACK_CACHE_TTL_MS, TRACK_CACHE_LIMIT_BYTES)
    cleanupRenderCache()
  }

  function runtimeStatus() {
    return {
      available: workerReady || pythonWorker !== null,
      provider: workerReady ? 'python-worker' : (pythonWorker ? 'python-starting' : 'not-started'),
      model: workerCapabilities?.beatThisAvailable ? 'beat_this-final0' : 'unavailable',
      version: ANALYSIS_RUNTIME_VERSION,
      reason: workerReady
        ? `Python worker with Beat This ${workerCapabilities.model || 'final0'} is ready`
        : (pythonWorker ? 'Python worker is starting...' : 'Python worker not started'),
      cacheRoot,
      pythonAvailable: findPythonExecutable() !== null
    }
  }

  ipcMain.handle('analysis:get-status', () => runtimeStatus())

  ipcMain.handle('analysis:get-cache-stats', () => {
    let fileCount = 0
    let totalSize = 0
    for (const root of [trackRoot, legacyBeatRoot]) {
      if (!fs.existsSync(root)) continue
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        try {
          totalSize += fs.statSync(path.join(root, entry.name)).size
          fileCount++
        } catch {}
      }
    }
    return { fileCount, totalSize, cachePath: cacheRoot }
  })

  ipcMain.handle('analysis:get-track', (_event, trackKey) => {
    if (typeof trackKey !== 'string') return null
    const normalizedTrackKey = trackKey.trim()
    if (!normalizedTrackKey || normalizedTrackKey.length > 256) return null
    const target = cacheFile(trackRoot, normalizedTrackKey)
    const value = readJson(target)
    if (!value || value.schemaVersion !== ANALYSIS_SCHEMA_VERSION) return null
    // 每次命中都原子重写整文件只为更新 lastAccessAt，会把磁盘 IO 放大到每次 get。
    // 改为仅当距上次落盘超过阈值时才写（清理逻辑按文件 mtime 判过期，
    // 阈值 1h 远小于 30d TTL，近期访问的文件不会被误删）。
    const lastFlushedAt = Number(value.lastAccessAt) || 0
    value.lastAccessAt = Date.now()
    if (Date.now() - lastFlushedAt > LAST_ACCESS_FLUSH_INTERVAL_MS) {
      try { atomicWriteJson(target, value) } catch {}
    }
    return value
  })

  ipcMain.handle('analysis:save-track', (_event, analysis) => {
    if (!analysis || typeof analysis.trackKey !== 'string' || !analysis.trackKey.trim() || analysis.trackKey.length > 256) {
      return { success: false, error: 'invalid analysis payload' }
    }
    const trackKey = analysis.trackKey.trim()
    atomicWriteJson(cacheFile(trackRoot, trackKey), versioned({ ...analysis, trackKey }))
    return { success: true }
  })

  ipcMain.handle('analysis:start-track', async (_event, input) => {
    if (!input || typeof input.trackKey !== 'string' || !input.trackKey.trim() || input.trackKey.length > 256) {
      return { status: 'failed', reason: 'A non-empty track key is required' }
    }
    if (typeof input.audioPath !== 'string' || !input.audioPath.trim()) {
      return { status: 'failed', reason: 'A non-empty audio path is required' }
    }
    const jobId = crypto.randomUUID()
    const trackKey = input.trackKey.trim()
    
    jobs.set(jobId, { 
      id: jobId, 
      status: 'pending', 
      createdAt: Date.now(), 
      input: { trackKey, audioPath: input?.audioPath, duration: input?.duration } 
    })
    
    const target = getMainWindow()
    
    // Check if we have cached analysis
    const cachedFile = cacheFile(trackRoot, trackKey)
    const cached = readJson(cachedFile)
    const requestedDuration = Number(input.duration) || 0
    const durationMatches = !requestedDuration || !Number(cached?.duration)
      || Math.abs(Number(cached.duration) - requestedDuration) < 2
    const signatureMatches = !input.sourceSignature || cached?.sourceSignature === input.sourceSignature
    if (cached && cached.schemaVersion === ANALYSIS_SCHEMA_VERSION && durationMatches && signatureMatches) {
      automixLog.log('analysis:cache-hit', `trackKey=${trackKey} beats=${Array.isArray(cached.beats) ? cached.beats.length : 0} confidence=${cached.confidence}`)
      if (target && !target.isDestroyed()) {
        target.webContents.send('analysis:progress', {
          jobId,
          trackKey,
          stage: 'completed',
          progress: 100,
          message: 'Using cached analysis'
        })
      }
      jobs.delete(jobId)
      return { jobId, status: 'completed', cached: true, result: cached }
    }
    
    // Start Python worker if needed
    if (!pythonWorker && !workerStarting) {
      startPythonWorker()
    }
    
    // Send progress: starting
    if (target && !target.isDestroyed()) {
      target.webContents.send('analysis:progress', {
        jobId,
        trackKey,
        stage: 'starting',
        progress: 0,
        message: 'Starting analysis...'
      })
    }
    
    try {
      jobs.set(jobId, { ...jobs.get(jobId), status: 'preparing' })
      if (target && !target.isDestroyed()) {
        target.webContents.send('analysis:progress', {
          jobId,
          trackKey,
          stage: 'preparing',
          progress: 10,
          message: 'Preparing audio file...'
        })
      }

      const audioPath = await audioDownload.prepareAudioFile(input.audioPath, trackKey)
      jobs.set(jobId, { ...jobs.get(jobId), status: 'analyzing' })
      if (target && !target.isDestroyed()) {
        target.webContents.send('analysis:progress', {
          jobId,
          trackKey,
          stage: 'analyzing',
          progress: 30,
          message: 'Analyzing beats and downbeats...'
        })
      }

      // The IPC promise now resolves only when the worker result is available.
      const result = await sendToWorker('analyze', {
        audioPath,
        trackKey,
        duration: input.duration,
        sourceSignature: input.sourceSignature
      })
      const hasUsableBeatThisResult = result?.provider === 'beat_this' &&
        result?.analysisVersion === 'beat-this-dsp-v1' &&
        Array.isArray(result?.beats) && result.beats.length >= 8 &&
        Array.isArray(result?.downbeats) && result.downbeats.length >= 2
      if (!hasUsableBeatThisResult) {
        const reason = result?.error || 'Beat This returned insufficient beat/downbeat data'
        automixLog.log('analysis:fail', `trackKey=${trackKey} error=${reason}`)
        throw new Error(reason)
      }
      automixLog.log('analysis:ok', [
        `trackKey=${trackKey}`,
        `provider=${result.provider}`,
        `beats=${Array.isArray(result.beats) ? result.beats.length : 0}`,
        `downbeats=${Array.isArray(result.downbeats) ? result.downbeats.length : 0}`,
        `bpm=${result.estimatedBpm}`,
        `confidence=${typeof result.confidence === 'number' ? Number(result.confidence).toFixed(3) : '?'}`,
        `beatFeatures=${Array.isArray(result.beatFeatures) ? result.beatFeatures.length : 0}`,
        `analysisVersion=${result.analysisVersion}`,
      ].join(' '))

      const analysis = versioned({
        ...result,
        trackKey,
        sourceSignature: input.sourceSignature,
      })
      // 空节拍结果（metadata-only 等解码失败降级）不落盘：持久化会让渲染端缓存命中
      // 直接返回 beats=0，把 m4a/aac 等格式的浏览器解码回退（唯一能解的路）永远挡掉，
      // 表现为"MV 背景永远对不上 / 歌曲永远无节拍"。空结果只返回给本次调用方。
      const hasUsableBeats = Array.isArray(result.beats) && result.beats.length >= 8 &&
        Array.isArray(result.downbeats) && result.downbeats.length >= 2
      if (hasUsableBeats) {
        atomicWriteJson(cachedFile, analysis)
      }
      jobs.set(jobId, { ...jobs.get(jobId), status: 'completed', result: analysis })
      if (target && !target.isDestroyed()) {
        target.webContents.send('analysis:progress', {
          jobId,
          trackKey,
          stage: 'completed',
          progress: 100,
          message: `Analysis complete: ${result.beats.length} beats, BPM: ${result.estimatedBpm || 0}`
        })
      }
      return { jobId, status: 'completed', result: analysis }
    } catch (error) {
      console.error('Analysis error:', error)
      jobs.set(jobId, { ...jobs.get(jobId), status: 'failed', error: error.message })
      if (target && !target.isDestroyed()) {
        target.webContents.send('analysis:progress', {
          jobId,
          trackKey,
          stage: 'failed',
          progress: 0,
          message: error.message
        })
      }
      return { jobId, status: 'failed', reason: error.message }
    } finally {
      jobs.delete(jobId)
    }
  })

  ipcMain.handle('analysis:cancel-job', (_event, jobId) => {
    if (typeof jobId === 'string') {
      const job = jobs.get(jobId)
      if (job) {
        job.status = 'cancelled'
      }
      jobs.delete(jobId)
    }
    return { success: true }
  })

  ipcMain.handle('analysis:clear-cache', () => {
    for (const root of [trackRoot, legacyBeatRoot]) {
      if (!isInsideCache(root)) return { success: false, error: 'invalid cache directory' }
      fs.rmSync(root, { recursive: true, force: true })
    }
    ensureDirectories()
    return { success: true }
  })
  
  // Cleanup on app quit
  const handleWillQuit = () => {
    clearInterval(cacheCleanupInterval)
    cleanupWorker()
  }
  app.once('will-quit', handleWillQuit)
  
  // Periodically enforce age and size limits for every analysis cache.
  const cacheCleanupInterval = setInterval(cleanupCaches, 60 * 60 * 1000)
  cacheCleanupInterval.unref?.()

  ensureDirectories()
  cleanupCaches()
  
  return { 
    cacheRoot, 
    runtimeStatus, 
    cleanupRenderCache,
    startPythonWorker,
    cleanupWorker,
    audioDownload
  }
}

module.exports = { createAnalysisRuntime }
