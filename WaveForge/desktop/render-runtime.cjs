const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { app } = require('electron')

/**
 * Render Runtime - Manages Python render worker for seamless transitions
 * Uses Pedalboard for high-quality pitch-preserving time stretching
 */

const WORKER_IDLE_TIMEOUT = 60_000 // 60 seconds
const RENDER_TIMEOUT = 120_000 // 2 minutes for complex renders
// IPC 整文件拷贝上限：render:readAudioFile 会把 WAV 整段 Buffer 穿过主进程 IPC 堆，
// 常规转换渲染（秒级过渡）远小于此值；超大渲染应走 render:getAudioUrl 流式 URL 路径。
const MAX_IPC_AUDIO_FILE_BYTES = 256 * 1024 * 1024

function externalProcessPath(candidate) {
  if (!app.isPackaged) return candidate
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

class RenderRuntime {
  constructor(customCachePath = null) {
    this.worker = null
    this.workerReady = false
    this.workerStartPromise = null
    this.pendingRequests = new Map()
    this.messageId = 0
    this.idleTimer = null
    this.cacheDir = null
    this.tempDir = null
    this.customCachePath = customCachePath
    
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
   * Render a transition
   */
  async renderTransition(plan, sourceAudioPath, targetAudioPath, progressCallback) {
    try {
      this._validateRenderInput(plan, sourceAudioPath, targetAudioPath)
      // Generate cache key
      const cacheKey = this._generateCacheKey(plan)
      const outputPath = path.join(this.cacheDir, `${cacheKey}.wav`)
      
      // Check cache
      if (fs.existsSync(outputPath)) {
        console.log('[Render Runtime] Using cached render:', cacheKey)
        const stats = fs.statSync(outputPath)
        if (!stats.isFile() || stats.size <= 44) {
          fs.rmSync(outputPath, { force: true })
        } else {
          // Windows may not update access time, so explicitly refresh mtime for LRU cleanup.
          const now = new Date()
          try { fs.utimesSync(outputPath, now, now) } catch {}
          return {
            success: true,
            outputPath,
            duration: plan.sourceEndTime - plan.sourceStartTime,
            cached: true,
            size: stats.size,
            stretchApplied: true,
            djEffectsApplied: plan.djEffects?.enabled === true,
            targetResumeTime: plan.targetEndTime,
            rendererVersion: plan.rendererVersion,
          }
        }
      }
      
      if (progressCallback) {
        progressCallback({ stage: 'rendering', progress: 0 })
      }
      
      // Render
      const result = await this._sendMessage('render', {
        plan,
        sourceAudioPath,
        targetAudioPath,
        outputPath
      })
      
      if (progressCallback) {
        progressCallback({ stage: 'complete', progress: 100 })
      }
      
      return {
        ...result,
        cached: false
      }
      
    } catch (error) {
      console.error('[Render Runtime] Render failed:', error)
      throw error
    }
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
    }
  }
  
  /**
   * Generate cache key for transition plan
   */
  _generateCacheKey(plan) {
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
      rendererVersion: plan.rendererVersion,
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
        fs.unlinkSync(path.join(this.cacheDir, file.name))
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
        const stats = fs.statSync(path.join(this.cacheDir, file.name))
        totalSize += stats.size
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

function getRenderRuntime(customCachePath = null) {
  if (!renderRuntime) {
    renderRuntime = new RenderRuntime(customCachePath)
  }
  return renderRuntime
}

// IPC handlers
function setupRenderIPC(ipcMain, customCachePath = null, toMediaUrl = null) {
  // Render transition
  ipcMain.handle('render:transition', async (event, plan, sourceAudioPath, targetAudioPath) => {
    const runtime = getRenderRuntime(customCachePath)
    return runtime.renderTransition(plan, sourceAudioPath, targetAudioPath)
  })
  
  // Prefer handing Chromium a validated local media URL so it can stream the WAV
  // directly instead of copying the complete file through the main-process IPC heap.
  ipcMain.handle('render:getAudioUrl', async (_event, filePath) => {
    try {
      if (typeof toMediaUrl !== 'function') throw new Error('Media URL provider is unavailable')
      const runtime = getRenderRuntime(customCachePath)
      return toMediaUrl(runtime.resolveRenderedAudioFile(filePath))
    } catch (error) {
      throw new Error(`Failed to create rendered audio URL: ${error.message}`)
    }
  })

  // Compatibility fallback for older renderers/preloads.
  ipcMain.handle('render:readAudioFile', async (event, filePath) => {
    try {
      const runtime = getRenderRuntime(customCachePath)
      const buffer = await runtime.readRenderedAudioFile(filePath)
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (error) {
      throw new Error(`Failed to read audio file: ${error.message}`)
    }
  })
  
  // Clear cache
  ipcMain.handle('render:clearCache', async () => {
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
}

module.exports = {
  getRenderRuntime,
  setupRenderIPC,
  cleanup
}
