const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')
const automixLog = require('./automix-log.cjs')

/**
 * Render Runtime - Manages Python render worker for seamless transitions
 * Uses Pedalboard for high-quality pitch-preserving time stretching
 */

const WORKER_IDLE_TIMEOUT = 60_000 // 60 seconds
const RENDER_TIMEOUT = 120_000 // 2 minutes for complex renders
// AutoMix Enhanced（QQ 三档）后端契约版本：纳入 QQ 渲染缓存键，命中时校验，
// 渲染逻辑或 cue 时间轴语义变化时递增 → 旧产物自动失效重渲（P1-9）。
const QQ_AUTOMIX_ALGO_VERSION = 2
const QQ_AUTOMIX_TIERS = ['lite', 'advanced', 'extreme']
// Python worker stderr 日志转发匹配：三档链路关键字（qq-automix / fallback / cloud /
// match / lite / folia / noise / seam）+ 既有 v2/渲染关键字（P2-23）。
const PY_RENDER_LOG_PATTERN = /\[?v2\]?|qq-automix|fallback|cloud|match|lite|folia|noise|seam|render|stretch|transition|error|fail|complete|Beat|analysis/i
// IPC 整文件拷贝上限：render:readAudioFile 会把 WAV 整段 Buffer 穿过主进程 IPC 堆，
// 常规转换渲染（秒级过渡）远小于此值；超大渲染应走 render:getAudioUrl 流式 URL 路径。
const MAX_IPC_AUDIO_FILE_BYTES = 256 * 1024 * 1024

function fileIdentity(filePath) {
  try {
    const stat = fs.statSync(filePath)
    return { path: path.resolve(filePath), size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { path: path.resolve(String(filePath || '')), missing: true }
  }
}

function isValidWav(filePath, expectedDuration = null) {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < 44) return false
    const fd = fs.openSync(filePath, 'r')
    const header = Buffer.alloc(Math.min(stat.size, 1024 * 1024))
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0)
    fs.closeSync(fd)
    if (bytesRead < 44 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return false
    let offset = 12
    let sampleRate = 0
    let blockAlign = 0
    let dataSize = 0
    while (offset + 8 <= bytesRead) {
      const chunkId = header.toString('ascii', offset, offset + 4)
      const chunkSize = header.readUInt32LE(offset + 4)
      const dataOffset = offset + 8
      if (chunkId === 'fmt ' && chunkSize >= 16 && dataOffset + 16 <= bytesRead) {
        sampleRate = header.readUInt32LE(dataOffset + 4)
        blockAlign = header.readUInt16LE(dataOffset + 12)
      } else if (chunkId === 'data') {
        dataSize = chunkSize
        if (dataOffset + dataSize > stat.size + 1) return false
        break
      }
      offset = dataOffset + chunkSize + (chunkSize % 2)
    }
    if (!sampleRate || !blockAlign || dataSize <= 0) return false
    if (expectedDuration != null) {
      const duration = dataSize / (sampleRate * blockAlign)
      if (!Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.15) return false
    }
    return true
  } catch { return false }
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value))
    fs.renameSync(tempPath, filePath)
  } finally {
    try { fs.rmSync(tempPath, { force: true }) } catch {}
  }
}

function noGridResumeTime(plan) {
  return plan.targetStartTime + Math.min(
    plan.sourceEndTime - plan.sourceStartTime,
    plan.targetEndTime - plan.targetStartTime,
  )
}

function externalProcessPath(candidate) {
  if (!app.isPackaged) return candidate
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

class RenderRuntime {
  constructor(customCachePath = null, options = {}) {
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    this.pendingRequests = new Map()
    this.activeOutputPaths = new Set()
    // 在途去重（P2-22）：同一缓存键的并发渲染共享同一个 promise，避免同曲对
    // 重复渲染并互相覆盖输出（与 AiMixRuntime.inflightRenders 同一做法）。
    this.inflightRenders = new Map()
    this.messageId = 0
    this.idleTimer = null
    this.cacheDir = null
    this.tempDir = null
    this.customCachePath = customCachePath
    // 输入白名单（与 stem/track-stem 系同一口径）：传入 audioDownload.isInputAllowed，
    // 限定 sourceAudioPath/targetAudioPath 必须在音频缓存根内或经用户文件对话框授权。
    // 此前只查"存在且是文件"，渲染层被入侵后可把任意本机文件当音频读入并经
    // getAudioUrl/readAudioFile 读回（任意文件读外带通道）。
    this.isInputAllowed = typeof options.isInputAllowed === 'function' ? options.isInputAllowed : null

    this._initializeDirs()
  }
  
  _initializeDirs() {
    const userDataPath = app.getPath('userData')
    const basePath = this.customCachePath || path.join(userDataPath, 'analysis-cache')
    this.cacheDir = path.join(basePath, 'transition-renders')
    this.tempDir = path.join(basePath, 'temp')
    
    // Create directories
    for (const dir of [this.cacheDir, this.tempDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    
    console.log('[Render Runtime] Cache dir:', this.cacheDir)
  }
  
  /**
   * Get Python executable path (embedded or system)
   */
  _getPythonPath() {
    // Try embedded Python first
    if (app.isPackaged) {
      const embedPath = path.join(process.resourcesPath, 'python-embed', 'python.exe')
      if (fs.existsSync(embedPath)) {
        console.log('[Render Runtime] Using embedded Python:', embedPath)
        return embedPath
      }
    } else {
      // Development mode - check if embedded Python exists
      const devEmbedPath = path.join(__dirname, '..', 'resources', 'python-embed', 'python.exe')
      if (fs.existsSync(devEmbedPath)) {
        console.log('[Render Runtime] Using dev embedded Python:', devEmbedPath)
        return devEmbedPath
      }
    }
    
    // Fallback to system Python
    console.log('[Render Runtime] Using system Python')
    return process.platform === 'win32' ? 'py' : 'python3'
  }
  
  /**
   * Ensure worker is running
   */
  async ensureWorker() {
    if (this.worker && this.workerReady) {
      return true
    }
    if (this.workerStartPromise) return this.workerStartPromise

    const startPromise = new Promise((resolve, reject) => {
      let startupTimer = null
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        if (startupTimer) clearTimeout(startupTimer)
        if (error) reject(error)
        else resolve(true)
      }
      try {
        const workerPath = externalProcessPath(path.join(__dirname, 'workers', 'render_worker.py'))
        
        if (!fs.existsSync(workerPath)) {
          return reject(new Error(`Render worker not found: ${workerPath}`))
        }
        
        console.log('[Render Runtime] Spawning render worker:', workerPath)
        
        // Get Python executable (embedded or system)
        const pythonCmd = this._getPythonPath()
        
        const worker = spawn(pythonCmd, [workerPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
        this.worker = worker
        
        worker.on('error', (error) => {
          console.error('[Render Worker] Spawn error:', error)
          const wasCurrentWorker = this.worker === worker
          if (wasCurrentWorker) {
            this.workerReady = false
            this.worker = null
          }
          finish(error)
          if (wasCurrentWorker) this._rejectPendingRequests(error)
        })
        
        worker.on('exit', (code, signal) => {
          console.log(`[Render Worker] Exited with code ${code}, signal ${signal}`)
          const wasCurrentWorker = this.worker === worker
          if (wasCurrentWorker) {
            this.workerReady = false
            this.worker = null
          }
          const error = new Error(`Render worker exited (${code ?? signal ?? 'unknown'})`)
          finish(error)
          if (wasCurrentWorker) this._rejectPendingRequests(error)
        })
        
        // Handle stderr (logs)
        worker.stderr.on('data', (data) => {
          const message = data.toString().trim()
          console.log('[Render Worker]', message)
          // Python 渲染器日志转发到 automix 日志文件（拉伸/特效/错误等关键信息）。
          // P2-23：正则覆盖三档链路关键字；traceback 整段保留（不截断，否则报障拿不到
          // 根因），普通行仍限 300 字符防日志爆炸。
          if (!message) return
          if (/Traceback \(most recent call last\)/.test(message)) {
            automixLog.log('py-render-worker', message)
          } else {
            for (const line of message.split(/\r?\n/)) {
              if (!line || !PY_RENDER_LOG_PATTERN.test(line)) continue
              automixLog.log('py-render-worker', line.slice(0, 300))
            }
          }

          if (message.includes('Render worker ready')) {
            if (this.worker !== worker) return
            this.workerReady = true
            this._resetIdleTimer()
            finish()
          }
        })
        
        // Handle stdout (JSON responses)
        let buffer = ''
        worker.stdout.on('data', (data) => {
          buffer += data.toString()
          
          // Process complete JSON messages
          const lines = buffer.split('\n')
          buffer = lines.pop() // Keep incomplete line in buffer
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const message = JSON.parse(line)
                this._handleMessage(message)
              } catch (error) {
                console.error('[Render Worker] JSON parse error:', error, line)
              }
            }
          }
        })
        
        // Timeout for worker startup
        if (!settled) {
          startupTimer = setTimeout(() => {
            if (!this.workerReady) {
              const error = new Error('Render worker startup timeout')
              if (this.worker === worker) {
                this.worker = null
                this.workerReady = false
              }
              worker.kill()
              finish(error)
            }
          }, 10000)
        }
        
      } catch (error) {
        console.error('[Render Runtime] Worker spawn error:', error)
        finish(error)
      }
    })

    this.workerStartPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.workerStartPromise === startPromise) this.workerStartPromise = null
    }
  }

  _rejectPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }
  
  /**
   * Handle message from worker
   */
  _handleMessage(message) {
    const { type, id, data, error } = message
    
    if (type === 'status') {
      console.log('[Render Worker] Status:', data)
      return
    }
    
    if (!id) return
    
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    
    clearTimeout(pending.timeout)
    this.pendingRequests.delete(id)
    
    if (type === 'result') {
      pending.resolve(data)
    } else if (type === 'error') {
      pending.reject(new Error(error || 'Unknown worker error'))
    } else {
      pending.reject(new Error(`Unknown render worker response: ${String(type)}`))
    }
    if (this.pendingRequests.size === 0) this._resetIdleTimer()
  }
  
  /**
   * Send message to worker
   */
  /** 超时兜底：杀掉当前 worker（下一请求经 ensureWorker 重拉）。清理 pending 与就绪态。 */
  _killWorkerForTimeout() {
    try { this.worker?.kill() } catch { /* noop */ }
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Render worker killed after timeout'))
    }
    this.pendingRequests.clear()
  }

  async _sendMessage(type, params, timeout = RENDER_TIMEOUT) {
    await this.ensureWorker()
    if (!this.worker || !this.workerReady) throw new Error('Render worker is unavailable')
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    
    return new Promise((resolve, reject) => {
      const id = String(++this.messageId)
      const message = JSON.stringify({ type, id, params }) + '\n'
      
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        // 超时即杀 worker（对齐 stem-runtime）：Python 串行执行已超时的渲染会阻塞
        // 后续全部请求；且调用方 finally 已把 outputPath 移出保护集，worker 仍写该
        // 文件会与 clearCache 撞 EBUSY。杀掉后下一请求自动重拉 worker。
        this._killWorkerForTimeout()
        reject(new Error(`Render worker timeout (${timeout}ms)`))
        if (this.pendingRequests.size === 0) this._resetIdleTimer()
      }, timeout)
      
      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutId })
      
      this.worker.stdin.write(message, error => {
        if (!error) return
        const pending = this.pendingRequests.get(id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(id)
        pending.reject(error)
        if (this.pendingRequests.size === 0) this._resetIdleTimer()
      })
    })
  }
  
  /**
   * Reset idle timer
   */
  _resetIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    
    this.idleTimer = setTimeout(() => {
      if (this.pendingRequests.size > 0) return
      console.log('[Render Runtime] Worker idle timeout, shutting down')
      this.shutdown()
    }, WORKER_IDLE_TIMEOUT)
    this.idleTimer.unref?.()
  }
  
  /**
   * Render a transition（P2-22：同一缓存键的并发请求共享同一次渲染）
   */
  async renderTransition(plan, sourceAudioPath, targetAudioPath, progressCallback) {
    let cacheKey = null
    try { cacheKey = this._generateCacheKey(plan, sourceAudioPath, targetAudioPath) } catch { cacheKey = null }
    if (cacheKey && this.inflightRenders.has(cacheKey)) {
      automixLog.log('render:dedupe', `cacheKey=${cacheKey} 在途渲染去重`)
      return this.inflightRenders.get(cacheKey)
    }
    const promise = this._renderTransitionUncached(plan, sourceAudioPath, targetAudioPath, progressCallback)
    if (cacheKey) {
      this.inflightRenders.set(cacheKey, promise)
      promise.finally(() => {
        if (this.inflightRenders.get(cacheKey) === promise) this.inflightRenders.delete(cacheKey)
      }).catch(() => undefined)
    }
    return promise
  }

  async _renderTransitionUncached(plan, sourceAudioPath, targetAudioPath, progressCallback) {
    let activeOutputPath = null
    try {
      this._validateRenderInput(plan, sourceAudioPath, targetAudioPath)
      // Generate cache key
      const cacheKey = this._generateCacheKey(plan, sourceAudioPath, targetAudioPath)
      const outputPath = path.join(this.cacheDir, `${cacheKey}.wav`)
      const metaPath = `${outputPath}.json`
      activeOutputPath = outputPath
      this.activeOutputPaths.add(outputPath)
      automixLog.log('render:entry', [
        `strategy=${plan.strategy}`,
        `aiMix=${plan.v2?.aiMix === true}`,
        `beatCount=${plan.beatCount}`,
        `bpm=${plan.sourceBpm}->${plan.targetBpm}`,
        `window=${[plan.sourceStartTime, plan.sourceEndTime, plan.targetStartTime, plan.targetEndTime].map(v => Number(v).toFixed(1)).join('/')}`,
        `cacheKey=${cacheKey}`,
      ].join(' '))

      // Check cache
      if (fs.existsSync(outputPath) && fs.existsSync(metaPath)) {
        let meta = null
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch {}
        const expectedDuration = Number.isFinite(meta?.duration) ? meta.duration : null
        const expectedBackend = plan.strategy === 'smart-rendered-v2'
          ? (plan.v2?.backend || 'v2-dsp')
          : 'standard-v1'
        const expectedBeatProvider = plan.strategy === 'smart-rendered-v2'
          ? (plan.v2?.beatProvider || 'fallback')
          : null
        const cacheIdentityMatches = meta
          && meta.rendererVersion === plan.rendererVersion
          && meta.backend === expectedBackend
          && (expectedBeatProvider === null || meta.beatProvider === expectedBeatProvider)
        if (!cacheIdentityMatches || !isValidWav(outputPath, expectedDuration)) {
          fs.rmSync(outputPath, { force: true })
          fs.rmSync(metaPath, { force: true })
        } else {
          const stats = fs.statSync(outputPath)
          automixLog.log('render:cache-hit', `cacheKey=${cacheKey} size=${stats.size}`)
          console.log('[Render Runtime] Using cached render:', cacheKey)
          // Windows may not update access time, so explicitly refresh mtime for LRU cleanup.
          const now = new Date()
          try { fs.utimesSync(outputPath, now, now) } catch {}
          const targetResumeTime = Number.isFinite(meta.targetResumeTime)
            ? meta.targetResumeTime
            : plan.strategy === 'smart-rendered-v2' && plan.v2?.withoutBeatGrid === true
              ? noGridResumeTime(plan)
              : plan.targetEndTime
          return {
            success: true,
            outputPath,
            duration: meta.duration,
            cached: true,
            size: stats.size,
            stretchApplied: true,
            djEffectsApplied: meta.djEffectsApplied === true,
            stemMixApplied: meta.stemMixApplied === true,
            targetResumeTime,
            rendererVersion: plan.rendererVersion,
            backend: meta.backend,
            beatProvider: meta.beatProvider || undefined,
            }

        }
      }
      
      if (progressCallback) {
        progressCallback({ stage: 'rendering', progress: 0 })
      }
      
      // Render
      // v2 计划（smart-rendered-v2）走独立渲染函数 render_transition_v2（render_worker.py 内新增），
      // 与 v1 的 'render' 消息完全隔离；v1 路径一行未动。
      const messageType = plan.strategy === 'smart-rendered-v2'
        ? (plan.v2?.backend === 'folia-htdemucs' ? 'render_folia' : 'render_v2')
        : 'render'
      automixLog.log('render:dispatch', `messageType=${messageType}`)
      const result = await this._sendMessage(messageType, {
        plan,
        sourceAudioPath,
        targetAudioPath,
        outputPath
      })
      
      if (progressCallback) {
        progressCallback({ stage: 'complete', progress: 100 })
      }

      if (result?.success) {
        writeJsonAtomic(metaPath, {
          duration: result.duration,
          targetResumeTime: result.targetResumeTime,
          rendererVersion: result.rendererVersion || plan.rendererVersion,
          size: result.size,
          backend: result.backend || (plan.strategy === 'smart-rendered-v2' ? (plan.v2?.backend || 'v2-dsp') : 'standard-v1'),
          beatProvider: plan.strategy === 'smart-rendered-v2' ? (result.beatProvider || plan.v2?.beatProvider || 'fallback') : null,
          stemMixApplied: result.stemMixApplied === true,
          djEffectsApplied: result.djEffectsApplied === true,
        })
        automixLog.log('render:ok', `cacheKey=${cacheKey} duration=${result.duration} output=${result.outputPath}`)
      } else {
        automixLog.log('render:fail', `cacheKey=${cacheKey} error=${result?.error || 'unknown'}`)
      }

      return {
        ...result,
        cached: false
      }
      
    } catch (error) {
      automixLog.log('render:error', `strategy=${plan?.strategy} error=${String(error?.message || error)}`)
      console.error('[Render Runtime] Render failed:', error)
      throw error
    } finally {
      if (activeOutputPath) this.activeOutputPaths.delete(activeOutputPath)
    }
  }

  /**
   * AutoMix Enhanced 三档渲染（Lite / Advanced / Extreme）。
   *
   * 与 v1/v2 不同：切点/过渡时长由档位决定（云端档来自 QQ MixPlan + MIR，Lite 用本地窗口），
   * 因此输出不参与 plan 摘要缓存，按 (tier, 源/目标文件, 文末 mtime+size, window,
   * cue 时间轴, 算法版本) 生成独立缓存键；同一键的并发请求在途去重（P2-22）。
   */
  async renderQQAutoMix(options = {}) {
    const tier = String(options.tier || 'lite')
    if (!QQ_AUTOMIX_TIERS.includes(tier)) {
      throw new Error(`Unknown AutoMix Enhanced tier: ${tier}`)
    }
    const sourceAudioPath = options.sourceAudioPath
    const targetAudioPath = options.targetAudioPath
    if (!sourceAudioPath || !targetAudioPath) {
      throw new Error('sourceAudioPath and targetAudioPath are required')
    }
    // 输入白名单：与 _validateRenderInput 同口径（QQ 三档此前完全没校验输入来源）
    for (const [label, filePath] of [['source', sourceAudioPath], ['target', targetAudioPath]]) {
      const resolved = path.resolve(String(filePath))
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`${label} audio file does not exist`)
      }
      if (this.isInputAllowed && !this.isInputAllowed(resolved)) {
        throw new Error(`${label} audio file is not authorized for rendering`)
      }
    }
    const statSig = (file) => {
      try {
        const s = fs.statSync(file)
        return `${s.size}:${Math.round(s.mtimeMs)}`
      } catch {
        return 'missing'
      }
    }
    // 曲目身份（mid / 歌名 / 歌手 / 平台 id）参与缓存键：跨平台匹配结果或登录态变化后
    // 会重新渲染，避免把"未登录降级产物"当成云端档结果命中。
    const cookie = options.cookie || this._readQQCookie()
    const trackSig = [
      options.sourceMid || '', options.sourceTrackId || '', options.sourceTitle || '', options.sourceArtist || '',
      options.targetMid || '', options.targetTrackId || '', options.targetTitle || '', options.targetArtist || '',
      cookie ? 'qq-login' : 'no-login',
    ].join('~')
    // P1-9：cue 时间轴（前端下传）是唯一事实。三字段齐全且时长 >0 时参与缓存键
    // （不同时间轴不共享产物）；缺失/非法时保持既有行为（worker 自行决策时间轴）。
    const cueStart = Number.isFinite(options.cueTransitionStartSeconds) ? options.cueTransitionStartSeconds : null
    const cueDuration = Number.isFinite(options.cueTransitionDurationSeconds) ? options.cueTransitionDurationSeconds : null
    const cueTargetStart = Number.isFinite(options.cueTargetStartSeconds) ? options.cueTargetStartSeconds : null
    const cueApplied = cueStart !== null && cueDuration !== null && cueTargetStart !== null && cueDuration > 0
    const cueTimelineSig = cueApplied ? `cue=${cueStart}~${cueDuration}~${cueTargetStart}` : 'cue=auto'
    const windowSeconds = Number.isFinite(options.window) ? options.window : 12.0
    const cacheKey = crypto
      .createHash('sha1')
      .update([
        tier, sourceAudioPath, statSig(sourceAudioPath), targetAudioPath, statSig(targetAudioPath),
        trackSig, `window=${windowSeconds}`, `algo=${QQ_AUTOMIX_ALGO_VERSION}`, cueTimelineSig,
      ].join('|'))
      .digest('hex')
      .slice(0, 32)
    const outputPath = path.join(this.cacheDir, `qq-${tier}-${cacheKey}.wav`)
    const metaPath = `${outputPath}.json`
    // 在途去重（P2-22，写法同 AiMixRuntime.inflightRenders）：同曲对的并发请求共享同一次渲染
    const inflightKey = `qq:${cacheKey}`
    if (this.inflightRenders.has(inflightKey)) {
      automixLog.log('render:qq-dedupe', `tier=${tier} cacheKey=${cacheKey} 在途渲染去重`)
      return this.inflightRenders.get(inflightKey)
    }
    const promise = this._doRenderQQAutoMix({
      tier, sourceAudioPath, targetAudioPath, outputPath, metaPath, cacheKey, cookie,
      windowSeconds, cueStart, cueDuration, cueTargetStart, cueApplied, options,
    })
    this.inflightRenders.set(inflightKey, promise)
    promise.finally(() => {
      if (this.inflightRenders.get(inflightKey) === promise) this.inflightRenders.delete(inflightKey)
    }).catch(() => undefined)
    return promise
  }

  async _doRenderQQAutoMix(params) {
    const { tier, sourceAudioPath, targetAudioPath, outputPath, metaPath, cacheKey, cookie,
            windowSeconds, cueStart, cueDuration, cueTargetStart, cueApplied, options } = params
    this.activeOutputPaths.add(outputPath)
    automixLog.log('render:qq-entry', `tier=${tier} cacheKey=${cacheKey}`)
    try {
      if (fs.existsSync(outputPath) && fs.existsSync(metaPath)) {
        let meta = null
        try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) } catch {}
        // P1-9：命中需校验身份字段（对齐 v2 的 cacheIdentityMatches）——
        // effectiveTier 合法、rendererVersion 非空、算法版本与当前一致；
        // 任一缺失/不符即丢弃重渲（旧写入的产物不带 algoVersion，会先失效一次）。
        const cacheIdentityMatches = meta
          && typeof meta.effectiveTier === 'string' && QQ_AUTOMIX_TIERS.includes(meta.effectiveTier)
          && typeof meta.rendererVersion === 'string' && meta.rendererVersion.trim().length > 0
          && meta.algoVersion === QQ_AUTOMIX_ALGO_VERSION
        if (cacheIdentityMatches && isValidWav(outputPath, Number.isFinite(meta?.duration) ? meta.duration : null)) {
          const now = new Date()
          try { fs.utimesSync(outputPath, now, now) } catch {}
          automixLog.log('render:qq-cache-hit', `tier=${tier} effectiveTier=${meta.effectiveTier} cacheKey=${cacheKey}`)
          return { success: true, outputPath, ...meta, cached: true }
        }
        if (!cacheIdentityMatches) {
          automixLog.log('render:qq-cache-drop', `tier=${tier} cacheKey=${cacheKey} effectiveTier=${meta?.effectiveTier ?? 'missing'} rendererVersion=${meta?.rendererVersion ?? 'missing'} algoVersion=${meta?.algoVersion ?? 'missing'}`)
        }
        fs.rmSync(outputPath, { force: true })
        fs.rmSync(metaPath, { force: true })
      }

      const result = await this._sendMessage('render_qq_automix', {
        tier,
        sourceAudioPath,
        targetAudioPath,
        outputPath,
        sourceMid: options.sourceMid || '',
        targetMid: options.targetMid || '',
        sourceTitle: options.sourceTitle || '',
        sourceArtist: options.sourceArtist || '',
        sourceTrackId: options.sourceTrackId || '',
        targetTitle: options.targetTitle || '',
        targetArtist: options.targetArtist || '',
        targetTrackId: options.targetTrackId || '',
        cookie,
        window: windowSeconds,
        sampleRate: Number.isFinite(options.sampleRate) ? options.sampleRate : 44100,
        ...(cueApplied
          ? {
            cueTransitionStartSeconds: cueStart,
            cueTransitionDurationSeconds: cueDuration,
            cueTargetStartSeconds: cueTargetStart,
          }
          : {}),
      })
      if (result?.success) {
        writeJsonAtomic(metaPath, {
          duration: result.duration,
          tier,
          effectiveTier: result.effectiveTier || tier,
          fallback: result.fallback || null,
          backend: result.backend,
          rendererVersion: result.rendererVersion,
          transitionStartSeconds: result.transitionStartSeconds,
          transitionDurationSeconds: result.transitionDurationSeconds,
          targetStartSeconds: result.targetStartSeconds,
          sourceCutSeconds: result.sourceCutSeconds,
          techniques: Array.isArray(result.techniques) ? result.techniques : [],
          size: result.size,
          // P1-9 / P2-21：算法版本 + cue 时间轴 + 写盘诊断（缓存命中校验 / 削波排查）
          algoVersion: QQ_AUTOMIX_ALGO_VERSION,
          windowSeconds,
          cueTimeline: cueApplied
            ? { transitionStartSeconds: cueStart, transitionDurationSeconds: cueDuration, targetStartSeconds: cueTargetStart }
            : null,
          peak: Number.isFinite(result.peak) ? result.peak : null,
          softLimited: result.softLimited === true,
        })
        if (result.fallback) {
          automixLog.log('render:qq-fallback', `tier=${tier} -> ${result.effectiveTier} reason=${result.fallback.reason || ''}`)
        } else {
          automixLog.log('render:qq-ok', `tier=${tier} duration=${result.duration} output=${outputPath}`)
        }
      } else {
        automixLog.log('render:qq-fail', `tier=${tier} error=${result?.error || 'unknown'}`)
      }
      return { ...result, outputPath, cached: false }
    } finally {
      this.activeOutputPaths.delete(outputPath)
    }
  }

  /** QQ 登录票据（与 local-server 同一来源：userData/qq-cookie.txt）。 */
  _readQQCookie() {
    try {
      const cookiePath = path.join(app.getPath('userData'), 'qq-cookie.txt')
      if (fs.existsSync(cookiePath)) return fs.readFileSync(cookiePath, 'utf8').trim()
    } catch {}
    return ''
  }

  /**
   * AutoMix Enhanced 播放前规划：只取交接时间轴（切点 / 过渡时长 / 目标曲续播位置）。
   * 判定与降级规则同 renderQQAutoMix（未登录 / 跨平台匹配失败 → lite）。
   */
  async planQQAutoMix(options = {}) {
    const tier = ['lite', 'advanced', 'extreme'].includes(String(options.tier)) ? String(options.tier) : 'lite'
    const result = await this._sendMessage('plan_qq_automix', {
      tier,
      sourceAudioPath: options.sourceAudioPath,
      targetAudioPath: options.targetAudioPath,
      sourceMid: options.sourceMid || '',
      targetMid: options.targetMid || '',
      sourceTitle: options.sourceTitle || '',
      sourceArtist: options.sourceArtist || '',
      sourceTrackId: options.sourceTrackId || '',
      targetTitle: options.targetTitle || '',
      targetArtist: options.targetArtist || '',
      targetTrackId: options.targetTrackId || '',
      cookie: options.cookie || this._readQQCookie(),
      window: Number.isFinite(options.window) ? options.window : 12.0,
    })
    if (result?.fallback) {
      automixLog.log('plan:qq-fallback', `tier=${tier} -> ${result.effectiveTier} reason=${result.fallback.reason || ''}`)
    } else if (result?.success) {
      automixLog.log('plan:qq-ok', `tier=${tier} start=${result.transition_start_s} dur=${result.transition_duration_s}`)
    }
    return result || { success: false, error: 'no result' }
  }

  _validateRenderInput(plan, sourceAudioPath, targetAudioPath) {
    if (!plan || typeof plan !== 'object') throw new Error('A transition plan is required')
    for (const field of ['sourceTrackKey', 'targetTrackKey']) {
      if (typeof plan[field] !== 'string' || !plan[field].trim()) {
        throw new Error(`Transition plan requires a non-empty ${field}`)
      }
    }
    for (const field of ['sourceStartTime', 'sourceEndTime', 'targetStartTime', 'targetEndTime']) {
      if (!Number.isFinite(plan[field]) || plan[field] < 0) {
        throw new Error(`Transition plan has an invalid ${field}`)
      }
    }
    if (plan.sourceEndTime <= plan.sourceStartTime || plan.targetEndTime <= plan.targetStartTime) {
      throw new Error('Transition time ranges must have a positive duration')
    }
    for (const [label, filePath] of [['source', sourceAudioPath], ['target', targetAudioPath]]) {
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error(`${label} audio path is required`)
      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`${label} audio file does not exist`)
      }
      if (this.isInputAllowed && !this.isInputAllowed(resolved)) {
        throw new Error(`${label} audio file is not authorized for rendering`)
      }
    }
  }

  /**
   * Generate cache key for transition plan.
   * v1 字段集合保持历史不变；v2 额外纳入所有会改变听感的编排字段与 stem 指纹。
   * 两者都纳入源/目标文件身份：音质切换（重新转码）后文件字节变了，旧键会复用
   * 旧码率的 WAV（v1 此前没有身份字段）。
   */
  _generateCacheKey(plan, sourceAudioPath = null, targetAudioPath = null) {
    const key = JSON.stringify({
      sourceTrackKey: plan.sourceTrackKey,
      targetTrackKey: plan.targetTrackKey,
      sourceStartTime: plan.sourceStartTime,
      sourceEndTime: plan.sourceEndTime,
      targetStartTime: plan.targetStartTime,
      targetEndTime: plan.targetEndTime,
      beatCount: plan.beatCount,
      sourceBpm: plan.sourceBpm,
      targetBpm: plan.targetBpm,
      sourceBeatTimes: plan.sourceBeatTimes,
      targetBeatTimes: plan.targetBeatTimes,
      djEffects: plan.djEffects,
      sourceIdentity: sourceAudioPath ? fileIdentity(sourceAudioPath) : null,
      targetIdentity: targetAudioPath ? fileIdentity(targetAudioPath) : null,
      ...(plan.strategy === 'smart-rendered-v2'
        ? {
          v2: {
            intensity: plan.v2?.intensity || null,
            backend: plan.v2?.backend || null,
            beatProvider: plan.v2?.beatProvider || null,
            folia: plan.v2?.folia || null,
            choreography: plan.v2?.choreography || null,
            withoutBeatGrid: plan.v2?.withoutBeatGrid === true,
            partialSyncN: plan.v2?.partialSyncN || null,
            pitchShiftSemitones: plan.v2?.pitchShiftSemitones || null,
            targetVocalness: plan.v2?.targetVocalness || null,
            automation: plan.v2?.automation || null,
            stemChoreography: plan.v2?.stemChoreography || null,
            stemFingerprint: plan.v2?.stemFingerprint || null,
          },
          gainCurve: plan.gainCurve,
          gainOffsetDb: plan.gainOffsetDb || 0,
        }
        : {}),
      rendererVersion: plan.rendererVersion,
      ...(plan.strategy === 'smart-rendered-v2'
        ? {
          sourceIdentity: fileIdentity(sourceAudioPath),
          targetIdentity: fileIdentity(targetAudioPath),
        }
        : {}),
    })
    return crypto.createHash('sha256').update(key).digest('hex').substring(0, 16)
  }
  
  /**
   * Clear render cache
   */
  async clearCache() {
    try {
      const files = fs.readdirSync(this.cacheDir, { withFileTypes: true })
      let cleared = 0
      for (const file of files) {
        if (!file.isFile()) continue
        const target = path.join(this.cacheDir, file.name)
        if (this.activeOutputPaths.has(target)) continue
        fs.rmSync(target, { force: true })
        cleared++
      }
      
      console.log(`[Render Runtime] Cleared ${cleared} cached renders`)
      return { success: true, cleared }
      
    } catch (error) {
      console.error('[Render Runtime] Cache clear error:', error)
      throw error
    }
  }
  
  /**
   * Get cache statistics
   */
  async getCacheStats() {
    try {
      const files = fs.readdirSync(this.cacheDir, { withFileTypes: true })
      let totalSize = 0
      let count = 0
      
      for (const file of files) {
        if (!file.isFile()) continue
        const target = path.join(this.cacheDir, file.name)
        if (file.name.endsWith('.tmp') || this.activeOutputPaths.has(target)) continue
        totalSize += fs.statSync(target).size
        count++
      }
      
      return {
        count,
        size: totalSize,
        totalSize,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2)
      }
      
    } catch (error) {
      console.error('[Render Runtime] Cache stats error:', error)
      return { count: 0, size: 0, totalSize: 0, totalSizeMB: '0.00' }
    }
  }

  resolveRenderedAudioFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Rendered audio path is required')
    const resolved = path.resolve(filePath)
    const relative = path.relative(path.resolve(this.cacheDir), resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative) || path.extname(resolved).toLowerCase() !== '.wav') {
      throw new Error('Rendered audio path is outside the transition cache')
    }
    const stats = fs.statSync(resolved)
    if (!stats.isFile()) throw new Error('Rendered audio path is not a file')
    return resolved
  }

  async readRenderedAudioFile(filePath) {
    const resolved = this.resolveRenderedAudioFile(filePath)
    const stats = await fs.promises.stat(resolved)
    // 超限拒绝，避免大文件 Buffer 整段穿主进程 IPC 堆（应改用 render:getAudioUrl 流式 URL）
    if (stats.size > MAX_IPC_AUDIO_FILE_BYTES) {
      throw new Error(`Rendered audio file too large for IPC transfer (${stats.size} bytes)`)
    }
    return fs.promises.readFile(resolved)
  }
  
  /**
   * Shutdown worker
   */
  shutdown() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    
    const worker = this.worker
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    if (worker) {
      try {
        worker.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
        const forceKillTimer = setTimeout(() => {
          if (!worker.killed) worker.kill()
        }, 1000)
        forceKillTimer.unref?.()
      } catch (error) {
        console.error('[Render Runtime] Shutdown error:', error)
        if (!worker.killed) worker.kill()
      }
    }

    this._rejectPendingRequests(new Error('Worker shutdown'))
  }
}

// Singleton instance
let renderRuntime = null

function getRenderRuntime(customCachePath = null, options = {}) {
  if (!renderRuntime) {
    renderRuntime = new RenderRuntime(customCachePath, options)
  }
  return renderRuntime
}

// ─────────────────────────────────────────────────────────────────────────────
// AI 混音（DJTransGAN）运行时：独立 worker 进程，使用带 torch 的 AI Python
// （环境变量 WAVEFORGE_AI_MIX_PYTHON，或开发目录 DJTransGAN/.venv）。
// 协议与 RenderRuntime 一致；引擎未安装时 renderTransition 抛错，前端回退 DSP。
// ─────────────────────────────────────────────────────────────────────────────

const AI_WORKER_IDLE_TIMEOUT = 90_000
// torch 冷启动导入实测 ~15s（含首次建 pyc 缓存），15s 超时很容易误杀正常 worker
const AI_WORKER_STARTUP_TIMEOUT = 60_000

function aiPythonCandidates() {
  const candidates = []
  if (process.env.WAVEFORGE_AI_MIX_PYTHON) candidates.push(process.env.WAVEFORGE_AI_MIX_PYTHON)
  // 开发目录：D:\opencode\DJTransGAN\.venv\Scripts\python.exe（__dirname = WaveForge/desktop）
  candidates.push(path.join(__dirname, '..', '..', 'DJTransGAN', '.venv', 'Scripts', 'python.exe'))
  // 一键下载位置：应用安装目录/ai-mix-engine/python.exe（用户要求不占系统用户目录）
  if (app && app.getPath) candidates.push(path.join(path.dirname(app.getPath('exe')), 'ai-mix-engine', 'python.exe'))
  return candidates.filter(candidate => typeof candidate === 'string' && fs.existsSync(candidate))
}

class AiMixRuntime {
  constructor(customCachePath = null, options = {}) {
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    this.pendingRequests = new Map()
    this.messageId = 0
    this.idleTimer = null
    this.aiPython = null
    this.cacheDir = null
    this.tempDir = null
    this.customCachePath = customCachePath
    // 输入白名单：与 RenderRuntime 同一口径（见 RenderRuntime 构造函数注释）
    this.isInputAllowed = typeof options.isInputAllowed === 'function' ? options.isInputAllowed : null
    // 同 cacheKey 在途渲染去重：prepareAutoMix 可能因各种原因反复触发，
    // 同一对歌曲的 AI 渲染只跑一次，其余等待同一 promise。
    this.inflightRenders = new Map()
    this._initializeDirs()
  }

  _initializeDirs() {
    const userDataPath = app.getPath('userData')
    const basePath = this.customCachePath || path.join(userDataPath, 'analysis-cache')
    this.cacheDir = path.join(basePath, 'transition-renders')
    this.tempDir = path.join(basePath, 'temp')
    for (const dir of [this.cacheDir, this.tempDir]) {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    }
  }

  _resolveAiPython() {
    if (this.aiPython) return this.aiPython
    const candidates = aiPythonCandidates()
    this.aiPython = candidates[0] || null
    return this.aiPython
  }

  getAvailable() {
    return Boolean(this._resolveAiPython())
  }

  async ensureWorker() {
    if (this.worker && this.workerReady) return true
    if (this.workerStartPromise) return this.workerStartPromise

    const python = this._resolveAiPython()
    if (!python) {
      automixLog.log('aimix', 'AI 引擎未安装（无 torch Python）——前端将回退 DSP')
      throw new Error('AI 混音引擎未安装（需要 torch + DJTransGAN 预训练模型）')
    }
    automixLog.log('aimix', `spawn worker python=${python}`)

    const workerPath = externalProcessPath(path.join(__dirname, 'workers', 'djtransgan_worker.py'))
    const startPromise = new Promise((resolve, reject) => {
      let startupTimer = null
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        if (startupTimer) clearTimeout(startupTimer)
        if (error) reject(error)
        else resolve(true)
      }
      try {
        console.log('[AI Mix] Spawning worker with:', python)
        // 下载的模型仓库（应用安装目录/ai-mix-engine/DJTransGAN）优先作为 REPO_DIR；
        // 未下载时 worker 内部默认 D:\opencode\DJTransGAN（开发目录）
        const spawnEnv = { ...process.env }
        const downloadedRepo = path.join(path.dirname(app.getPath('exe')), 'ai-mix-engine', 'DJTransGAN')
        if (fs.existsSync(path.join(downloadedRepo, 'djtransgan', 'model', '__init__.py'))) {
          spawnEnv.WAVEFORGE_DJTRANSGAN_DIR = downloadedRepo
        }
        const worker = spawn(python, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: spawnEnv })
        this.worker = worker
        worker.on('error', (error) => {
          console.error('[AI Mix] Worker spawn error:', error)
          const wasCurrent = this.worker === worker
          if (wasCurrent) { this.workerReady = false; this.worker = null }
          finish(error)
          if (wasCurrent) this._rejectPendingRequests(error)
        })
        worker.on('exit', (code, signal) => {
          console.log(`[AI Mix] Worker exited (${code ?? signal ?? 'unknown'})`)
          const wasCurrent = this.worker === worker
          if (wasCurrent) { this.workerReady = false; this.worker = null }
          const error = new Error('AI Mix worker exited')
          finish(error)
          if (wasCurrent) this._rejectPendingRequests(error)
        })
        worker.stderr.on('data', (data) => {
          const message = data.toString().trim()
          console.log('[AI Mix]', message)
          // DJTransGAN worker 日志（模型加载/渲染进度/错误）转发到 automix 日志文件
          if (message && /model|render|mix|error|fail|traceback|torch|weight|beat|stretch/i.test(message)) {
            automixLog.log('py-aimix-worker', message.slice(0, 300))
          }
          if (message.includes('"type": "status"') || message.includes('ready')) {
            if (this.worker !== worker) return
            this.workerReady = true
            this._resetIdleTimer()
            finish()
          }
        })
        let buffer = ''
        worker.stdout.on('data', (data) => {
          buffer += data.toString()
          const lines = buffer.split('\n')
          buffer = lines.pop()
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const message = JSON.parse(line)
              if (message.type === 'status') {
                if (this.worker !== worker) return
                this.workerReady = true
                this._resetIdleTimer()
                finish()
                continue
              }
              this._handleMessage(message)
            } catch (error) {
              console.error('[AI Mix] JSON parse error:', error, line)
            }
          }
        })
        if (!settled) {
          startupTimer = setTimeout(() => {
            if (!this.workerReady) {
              if (this.worker === worker) { this.worker = null; this.workerReady = false }
              worker.kill()
              finish(new Error('AI Mix worker startup timeout'))
            }
          }, AI_WORKER_STARTUP_TIMEOUT)
        }
      } catch (error) {
        console.error('[AI Mix] Worker spawn error:', error)
        finish(error)
      }
    })
    this.workerStartPromise = startPromise
    try {
      return await startPromise
    } finally {
      if (this.workerStartPromise === startPromise) this.workerStartPromise = null
    }
  }

  _rejectPendingRequests(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  _handleMessage(message) {
    const { type, id, data, error } = message
    if (!id) return
    const pending = this.pendingRequests.get(id)
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pendingRequests.delete(id)
    if (type === 'result') pending.resolve(data)
    else pending.reject(new Error(error || 'Unknown AI Mix worker response'))
    if (this.pendingRequests.size === 0) this._resetIdleTimer()
  }

  async _sendMessage(type, params, timeout = 180_000) {
    await this.ensureWorker()
    if (!this.worker || !this.workerReady) throw new Error('AI Mix worker is unavailable')
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    return new Promise((resolve, reject) => {
      const id = String(++this.messageId)
      const message = JSON.stringify({ type, id, params }) + '\n'
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id)
        // 超时即杀 worker（对齐 stem-runtime/RenderRuntime）：超时任务占住串行
        // worker 会阻塞后续全部 AI Mix 渲染
        try { this.worker?.kill() } catch { /* noop */ }
        this.worker = null
        this.workerReady = false
        for (const [, pending] of this.pendingRequests) {
          clearTimeout(pending.timeout)
          pending.reject(new Error('AI Mix worker killed after timeout'))
        }
        this.pendingRequests.clear()
        reject(new Error(`AI Mix worker timeout (${timeout}ms)`))
      }, timeout)
      this.pendingRequests.set(id, { resolve, reject, timeout: timeoutId })
      this.worker.stdin.write(message, (error) => {
        if (!error) return
        const pending = this.pendingRequests.get(id)
        if (!pending) return
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(id)
        pending.reject(error)
        if (this.pendingRequests.size === 0) this._resetIdleTimer()
      })
    })
  }

  _resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pendingRequests.size > 0) return
      console.log('[AI Mix] Worker idle timeout, shutting down')
      this.shutdown()
    }, AI_WORKER_IDLE_TIMEOUT)
    this.idleTimer.unref?.()
  }

  /**
   * 渲染 AI 过渡：DJTransGAN 长混音（~60s 窗口）。
   * 模型自身窗口的起始/结束时间戳随结果返回（transitionStart / targetResumeTime），
   * 前端据此替换过渡窗口。AI 引擎不可用时抛错，由前端回退 DSP。
   */
  async renderTransition(plan, sourceAudioPath, targetAudioPath) {
    this._validateInput(plan, sourceAudioPath, targetAudioPath)
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      plan,
      sourceIdentity: fileIdentity(sourceAudioPath),
      targetIdentity: fileIdentity(targetAudioPath),
      rendererVersion: 'djtransgan-v3',
    })).digest('hex').substring(0, 16)
    const outputPath = path.join(this.cacheDir, `aimix-${cacheKey}.wav`)
    const metaPath = `${outputPath}.json`

    // 1) 磁盘缓存命中：AI 渲染耗时 5~10s，prepareAutoMix 可能反复触发同一对歌曲，
    //    缓存让后续触发即时返回（含 transitionStart/targetResumeTime）。
    if (fs.existsSync(outputPath) && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (Number.isFinite(meta.transitionStart)
          && Number.isFinite(meta.targetResumeTime)
          && Number.isFinite(meta.duration)
          && isValidWav(outputPath, meta.duration)) {
          automixLog.log('aimix:cache-hit', `cacheKey=${cacheKey}`)
          return { ...meta, outputPath, success: true, cached: true }
        }
      } catch { /* 元数据损坏则重新渲染 */ }
    }

    // 2) 在途去重：同一 cacheKey 的渲染共享同一个 promise
    if (this.inflightRenders.has(cacheKey)) {
      automixLog.log('aimix:dedupe', `cacheKey=${cacheKey} 在途渲染去重`)
      return this.inflightRenders.get(cacheKey)
    }

    const promise = this._doRender(plan, sourceAudioPath, targetAudioPath, outputPath, metaPath, cacheKey)
    this.inflightRenders.set(cacheKey, promise)
    promise.finally(() => {
      if (this.inflightRenders.get(cacheKey) === promise) this.inflightRenders.delete(cacheKey)
    }).catch(() => undefined)
    return promise
  }

  async _doRender(plan, sourceAudioPath, targetAudioPath, outputPath, metaPath, cacheKey) {
    automixLog.log('aimix:entry', `cacheKey=${cacheKey} srcEnd=${plan.sourceEndTime} tgtStart=${plan.targetStartTime}`)
    const result = await this._sendMessage('render', { plan, sourceAudioPath, targetAudioPath, outputPath })
    if (result?.success) {
      // 3) 落盘缓存元数据：后续命中直接返回，无需重渲染
      try {
        const meta = {
          transitionStart: result.transitionStart,
          targetResumeTime: result.targetResumeTime,
          duration: result.duration,
          rendererVersion: result.rendererVersion,
          sourceIdentity: fileIdentity(sourceAudioPath),
          targetIdentity: fileIdentity(targetAudioPath),
        }
        writeJsonAtomic(metaPath, meta)
      } catch { /* 缓存失败不影响播放 */ }
      automixLog.log('aimix:ok', `cacheKey=${cacheKey} duration=${result.duration} transitionStart=${result.transitionStart} targetResume=${result.targetResumeTime}`)
    } else {
      automixLog.log('aimix:fail', `cacheKey=${cacheKey} error=${result?.error || 'unknown'}`)
    }
    return { ...result, cached: false }
  }

  /**
   * 提取 AI 学到的推子/EQ 自动化参数（v2 短过渡用，与 60s 长混音无关）。
   * 同 cacheKey 去重 + 磁盘缓存；引擎不可用返回 success=false。
   */
  async getAutomation(plan, sourceAudioPath, targetAudioPath) {
    this._validateInput(plan, sourceAudioPath, targetAudioPath)
    const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
      plan,
      sourceIdentity: fileIdentity(sourceAudioPath),
      targetIdentity: fileIdentity(targetAudioPath),
      rendererVersion: 'djtransgan-automation-v3',
    })).digest('hex').substring(0, 16)
    const paramsPath = path.join(this.cacheDir, `aimix-${cacheKey}.params.json`)
    if (fs.existsSync(paramsPath)) {
      try {
        const params = JSON.parse(fs.readFileSync(paramsPath, 'utf8'))
        if (params.success) {
          automixLog.log('aimix:automation-cache-hit', `cacheKey=${cacheKey}`)
          return params
        }
      } catch { /* 缓存损坏则重新提取 */ }
    }
    if (this.inflightAutomation?.has(cacheKey)) return this.inflightAutomation.get(cacheKey)
    const promise = (async () => {
      automixLog.log('aimix:automation', `cacheKey=${cacheKey} srcEnd=${plan.sourceEndTime} tgtStart=${plan.targetStartTime}`)
      const result = await this._sendMessage('automation', { plan, sourceAudioPath, targetAudioPath })
      if (result?.success) {
        try { writeJsonAtomic(paramsPath, result) } catch { /* ignore */ }
      }
      return result
    })()
    if (!this.inflightAutomation) this.inflightAutomation = new Map()
    this.inflightAutomation.set(cacheKey, promise)
    promise.finally(() => {
      if (this.inflightAutomation.get(cacheKey) === promise) this.inflightAutomation.delete(cacheKey)
    }).catch(() => undefined)
    return promise
  }

  /** 引擎可用性文件级快检：与 ai-model-manager 的 installed 判定一致（与模型卡片同源），
   *  避免为开关状态冷启动 python+torch（导入需 ~15s，慢且容易超时误报未安装）；
   *  worker 在真正渲染时才拉起 */
  _fsEngineStatus() {
    try {
      const { getStatus } = require('./ai-model-manager.cjs')
      const s = getStatus()
      if (s.engineAvailable === true) {
        return { available: true, python: this._resolveAiPython(), repoDir: s.repoDir }
      }
      // 兜底：开发目录 .venv 方案（ai-model-manager 只认下载位置 ai-mix-engine）
      const python = this._resolveAiPython()
      if (python && !python.includes('ai-mix-engine')) {
        const venvRoot = path.dirname(path.dirname(python))
        const repoDir = path.join(__dirname, '..', '..', 'DJTransGAN')
        const weights = path.join(repoDir, 'pretrained', 'djtransgan_minmax.pt')
        if (fs.existsSync(path.join(venvRoot, 'Lib', 'site-packages', 'torch'))
          && fs.existsSync(path.join(repoDir, 'djtransgan', 'model', '__init__.py'))
          && fs.existsSync(weights) && fs.statSync(weights).size > 1024 * 1024) {
          return { available: true, python, repoDir }
        }
      }
      return { available: false, python, repoDir: null, reason: 'engine-not-found' }
    } catch {
      return { available: false, python: this._resolveAiPython(), repoDir: null, reason: 'status-check-error' }
    }
  }

  async getStatus() {
    const status = this._fsEngineStatus()
    automixLog.log('aimix:status', status.available
      ? 'available=true (files-ready)'
      : `available=false reason=${status.reason || 'engine-not-found'}`)
    return { available: status.available, python: status.python, repoDir: status.repoDir, reason: status.reason }
  }

  _validateInput(plan, sourceAudioPath, targetAudioPath) {
    if (!plan || typeof plan !== 'object') throw new Error('A transition plan is required')
    for (const field of ['sourceTrackKey', 'targetTrackKey']) {
      if (typeof plan[field] !== 'string' || !plan[field].trim()) {
        throw new Error(`Transition plan requires a non-empty ${field}`)
      }
    }
    for (const [label, filePath] of [['source', sourceAudioPath], ['target', targetAudioPath]]) {
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error(`${label} audio path is required`)
      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        throw new Error(`${label} audio file does not exist`)
      }
      if (this.isInputAllowed && !this.isInputAllowed(resolved)) {
        throw new Error(`${label} audio file is not authorized for rendering`)
      }
    }
  }

  shutdown() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    const worker = this.worker
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    if (worker) {
      try {
        worker.stdin.write(JSON.stringify({ type: 'exit' }) + '\n')
        const forceKillTimer = setTimeout(() => { if (!worker.killed) worker.kill() }, 1000)
        forceKillTimer.unref?.()
      } catch (error) {
        if (!worker.killed) worker.kill()
      }
    }
    this._rejectPendingRequests(new Error('AI Mix worker shutdown'))
  }
}

let aiMixRuntime = null

function getAiMixRuntime(customCachePath = null, options = {}) {
  if (!aiMixRuntime) aiMixRuntime = new AiMixRuntime(customCachePath, options)
  return aiMixRuntime
}

// IPC handlers
function setupAiMixIPC(ipcMain, customCachePath = null, options = {}) {
  const { assertMainSender = null } = options
  const guard = (event) => {
    if (typeof assertMainSender === 'function') assertMainSender(event)
  }
  ipcMain.handle('render:transitionAiMix', async (event, plan, sourceAudioPath, targetAudioPath) => {
    guard(event)
    const runtime = getAiMixRuntime(customCachePath, options)
    return runtime.renderTransition(plan, sourceAudioPath, targetAudioPath)
  })
  ipcMain.handle('render:aiMixStatus', async () => {
    const runtime = getAiMixRuntime(customCachePath, options)
    return runtime.getStatus()
  })
  ipcMain.handle('render:aiMixAutomation', async (event, plan, sourceAudioPath, targetAudioPath) => {
    guard(event)
    const runtime = getAiMixRuntime(customCachePath, options)
    return runtime.getAutomation(plan, sourceAudioPath, targetAudioPath)
  })
}

function cleanupAiMix() {
  if (aiMixRuntime) aiMixRuntime.shutdown()
}

// IPC handlers
function setupRenderIPC(ipcMain, customCachePath = null, toMediaUrl = null, options = {}) {
  const { assertMainSender = null } = options
  // 主窗校验：渲染通道可触发 Python worker 与大文件 IO，只允许主窗主 frame 调用
  const guard = (event) => {
    if (typeof assertMainSender === 'function') assertMainSender(event)
  }
  // Render transition
  ipcMain.handle('render:transition', async (event, plan, sourceAudioPath, targetAudioPath) => {
    guard(event)
    const runtime = getRenderRuntime(customCachePath, options)
    return runtime.renderTransition(plan, sourceAudioPath, targetAudioPath)
  })

  // AutoMix Enhanced 三档渲染（Lite / Advanced / Extreme）
  ipcMain.handle('render:qqAutomix', async (event, options_) => {
    guard(event)
    const runtime = getRenderRuntime(customCachePath, options)
    return runtime.renderQQAutoMix(options_ || {})
  })

  // AutoMix Enhanced 播放前规划（只取交接时间轴，不渲染）
  ipcMain.handle('render:qqAutomixCue', async (event, options_) => {
    guard(event)
    const runtime = getRenderRuntime(customCachePath, options)
    return runtime.planQQAutoMix(options_ || {})
  })

  // Prefer handing Chromium a validated local media URL so it can stream the WAV
  // directly instead of copying the complete file through the main-process IPC heap.
  ipcMain.handle('render:getAudioUrl', async (_event, filePath) => {
    try {
      if (typeof toMediaUrl !== 'function') throw new Error('Media URL provider is unavailable')
      const runtime = getRenderRuntime(customCachePath, options)
      return toMediaUrl(runtime.resolveRenderedAudioFile(filePath))
    } catch (error) {
      throw new Error(`Failed to create rendered audio URL: ${error.message}`)
    }
  })

  // Compatibility fallback for older renderers/preloads.
  ipcMain.handle('render:readAudioFile', async (event, filePath) => {
    guard(event)
    try {
      const runtime = getRenderRuntime(customCachePath, options)
      const buffer = await runtime.readRenderedAudioFile(filePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (error) {
      throw new Error(`Failed to read audio file: ${error.message}`)
    }
  })
  
  // Clear cache
  ipcMain.handle('render:clearCache', async (event) => {
    guard(event)
    const runtime = getRenderRuntime(customCachePath)
    return runtime.clearCache()
  })
  
  // Get cache stats
  ipcMain.handle('render:getCacheStats', async () => {
    const runtime = getRenderRuntime(customCachePath)
    return runtime.getCacheStats()
  })
}

// Cleanup on app quit
function cleanup() {
  if (renderRuntime) {
    renderRuntime.shutdown()
  }
  cleanupAiMix()
}

module.exports = {
  getRenderRuntime,
  setupRenderIPC,
  setupAiMixIPC,
  cleanup
}
