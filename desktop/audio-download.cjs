/**
 * Audio Download Service for Electron Main Process
 * Handles downloading audio from URLs for analysis with persistent cache
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const { fileURLToPath } = require('url')

function realFilePath(candidate) {
  if (!candidate || typeof candidate !== 'string') return null
  try {
    const resolved = fs.realpathSync.native(candidate)
    return fs.statSync(resolved).isFile() ? resolved : null
  } catch {
    return null
  }
}

function realDirectoryPath(candidate) {
  try {
    const resolved = fs.realpathSync.native(candidate)
    return fs.statSync(resolved).isDirectory() ? resolved : null
  } catch {
    return null
  }
}

function isPathInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

class AudioDownloadService {
  constructor(tempRoot) {
    this.tempRoot = path.resolve(tempRoot)
    this.activeDownloads = new Map()
    this.activeRequests = new Set()
    this.cacheIndex = new Map() // trackKey -> {filePath, size, timestamp, lastAccess}
    this.maxCacheSize = 2 * 1024 * 1024 * 1024 // 2GB
    this.cacheIndexFile = path.join(this.tempRoot, 'cache-index.json')
    this.ensureTempDir()
    this.realTempRoot = realDirectoryPath(this.tempRoot)
    if (!this.realTempRoot) throw new Error('Unable to initialize audio cache directory')
    this.authorizedLocalFiles = new Set()
    this.loadCacheIndex()
  }

  ensureTempDir() {
    if (!fs.existsSync(this.tempRoot)) {
      fs.mkdirSync(this.tempRoot, { recursive: true })
    }
  }

  /**
   * Load cache index from disk
   */
  loadCacheIndex() {
    try {
      if (fs.existsSync(this.cacheIndexFile)) {
        const data = fs.readFileSync(this.cacheIndexFile, 'utf8')
        const items = JSON.parse(data)
        const validItems = Array.isArray(items) ? items.filter(item => {
          if (!item || typeof item.trackKey !== 'string' || !item.trackKey.trim()) return false
          if (typeof item.filePath !== 'string' || !this.isInsideTempRoot(item.filePath)) return false
          if (!fs.existsSync(item.filePath)) return false
          try {
            const stat = fs.statSync(item.filePath)
            item.size = stat.size
            item.timestamp = Number(item.timestamp) || stat.mtimeMs
            item.lastAccess = Number(item.lastAccess) || item.timestamp
            return stat.isFile()
          } catch {
            return false
          }
        }) : []
        this.cacheIndex = new Map(validItems.map(item => [item.trackKey, item]))
        if (validItems.length !== (Array.isArray(items) ? items.length : 0)) this.saveCacheIndex()
        console.log(`[AudioCache] Loaded ${this.cacheIndex.size} cached files`)
      }
    } catch (error) {
      console.error('[AudioCache] Failed to load cache index:', error)
      this.cacheIndex = new Map()
    }
  }

  isInsideTempRoot(target) {
    const realTarget = realFilePath(target)
    return Boolean(realTarget && isPathInside(this.realTempRoot, realTarget))
  }

  authorizeLocalFile(candidate) {
    const realPath = realFilePath(candidate)
    if (!realPath) throw new Error('Selected audio file does not exist')
    this.authorizedLocalFiles.add(realPath)
    if (this.authorizedLocalFiles.size > 256) {
      this.authorizedLocalFiles.delete(this.authorizedLocalFiles.values().next().value)
    }
    return realPath
  }

  isInputAllowed(candidate) {
    const realPath = realFilePath(candidate)
    return Boolean(realPath && (
      isPathInside(this.realTempRoot, realPath) || this.authorizedLocalFiles.has(realPath)
    ))
  }

  clearLocalAuthorizations() {
    this.authorizedLocalFiles.clear()
  }

  /**
   * Save cache index to disk
   */
  saveCacheIndex() {
    try {
      const items = Array.from(this.cacheIndex.values())
      const temporaryPath = `${this.cacheIndexFile}.tmp`
      fs.writeFileSync(temporaryPath, JSON.stringify(items, null, 2), 'utf8')
      fs.renameSync(temporaryPath, this.cacheIndexFile)
    } catch (error) {
      console.error('[AudioCache] Failed to save cache index:', error)
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    const items = Array.from(this.cacheIndex.values())
    const totalSize = items.reduce((sum, item) => sum + item.size, 0)
    return {
      fileCount: items.length,
      totalSize,
      maxSize: this.maxCacheSize,
      files: items
    }
  }

  /**
   * Check and cleanup cache if over limit
   */
  checkAndCleanupCache() {
    const stats = this.getCacheStats()
    
    if (stats.totalSize > this.maxCacheSize) {
      console.log(`[AudioCache] Cache over limit (${this.formatSize(stats.totalSize)} / ${this.formatSize(this.maxCacheSize)}), cleaning up...`)
      
      // Sort by last access time (oldest first)
      const sortedFiles = stats.files.sort((a, b) => a.lastAccess - b.lastAccess)
      
      let freedSize = 0
      const targetFreeSize = stats.totalSize - (this.maxCacheSize * 0.8) // Clean to 80%
      
      for (const file of sortedFiles) {
        if (freedSize >= targetFreeSize) break
        
        this.deleteCacheFile(file.trackKey)
        freedSize += file.size
      }
      
      console.log(`[AudioCache] Cleanup complete, freed ${this.formatSize(freedSize)}`)
    }
  }

  /**
   * Delete a cached file
   */
  deleteCacheFile(trackKey) {
    const cached = this.cacheIndex.get(trackKey)
    if (!cached) return

    try {
      if (fs.existsSync(cached.filePath)) {
        fs.unlinkSync(cached.filePath)
      }
      this.cacheIndex.delete(trackKey)
      this.saveCacheIndex()
      console.log(`[AudioCache] Deleted: ${trackKey}`)
    } catch (error) {
      console.error('[AudioCache] Failed to delete file:', error)
    }
  }

  /**
   * Format file size
   */
  formatSize(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }

  /**
   * 只读缓存命中检查：已缓存返回路径，未缓存返回 null（**不触发下载**）。
   * 看歌等场景用它判断能否直接用本地缓存文件（mv-align 分析已下载同一音轨），
   * 命中即秒开，未命中则照旧走流式 URL（避免先整文件下载再播放的倒退）。
   */
  peekCached(trackKey) {
    if (typeof trackKey !== 'string' || !trackKey.trim()) return null
    const cached = this.cacheIndex.get(trackKey.trim())
    if (cached && this.isInsideTempRoot(cached.filePath)) return realFilePath(cached.filePath)
    return null
  }

  /**
   * 下载音频到本地缓存（供分析/渲染复用）：URL → 本地文件。
   * 与 downloadForAnalysis 相同，暴露给外部直接调用。
   */
  async downloadForAnalysis(url, trackKey, options = {}) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      throw new Error('Invalid audio URL')
    }
    if (typeof trackKey !== 'string' || !trackKey.trim() || trackKey.length > 256) {
      throw new Error('Invalid track key')
    }
    trackKey = trackKey.trim()
    const { timeout = 60000, maxSize = 100 * 1024 * 1024 } = options // 100MB max

    // Check if already in cache
    const cached = this.cacheIndex.get(trackKey)
    if (cached && this.isInsideTempRoot(cached.filePath)) {
      // 历史误命名（内容与扩展名不符，如 B 站 DASH 的 AAC/MP4 被存成 .mp3）
      // 会让 Python/librosa 永远解不开这个"假 mp3"。发现即作废重下，
      // 新文件按响应内容纠正扩展名。
      if (this._extensionMatchesContent(cached.filePath)) {
        // Update last access time
        cached.lastAccess = Date.now()
        this.saveCacheIndex()
        console.log(`[AudioCache] Cache hit: ${trackKey}`)
        return cached.filePath
      }
      console.warn(`[AudioCache] Cached file content mismatch (${cached.filePath}), re-downloading with correct extension`)
      this.deleteCacheFile(trackKey)
    }

    // Check if already downloading
    if (this.activeDownloads.has(trackKey)) {
      return await this.activeDownloads.get(trackKey)
    }

    const downloadPromise = this._performDownload(url, trackKey, timeout, maxSize)
    this.activeDownloads.set(trackKey, downloadPromise)

    try {
      const result = await downloadPromise
      return result
    } finally {
      this.activeDownloads.delete(trackKey)
    }
  }

  _performDownload(url, trackKey, timeout, maxSize) {
    return new Promise((resolve, reject) => {
      // Generate cache file path
      const hash = crypto.createHash('md5').update(trackKey).digest('hex')
      const urlExt = this._getExtensionFromUrl(url)
      const legacyCacheFile = path.join(this.tempRoot, `${hash}.${urlExt}`)

      // 兼容旧缓存：文件名与 URL 扩展名一致且内容与扩展名相符时直接复用。
      // 内容与扩展名不符的旧文件（如 MP4 音频被存成 .mp3）会被重新下载并纠正扩展名。
      if (this.isInsideTempRoot(legacyCacheFile) && this._extensionMatchesContent(legacyCacheFile)) {
        console.log('[AudioCache] Using cached file:', legacyCacheFile)

        // Add to cache index if not already there
        if (!this.cacheIndex.has(trackKey)) {
          const stats = fs.statSync(legacyCacheFile)
          this.cacheIndex.set(trackKey, {
            trackKey,
            filePath: legacyCacheFile,
            size: stats.size,
            timestamp: Date.now(),
            lastAccess: Date.now()
          })
          this.saveCacheIndex()
        }

        resolve(legacyCacheFile)
        return
      }

      console.log('[AudioCache] Downloading audio from URL...')

      const protocol = url.startsWith('https') ? https : http
      let writeStream = null
      let cacheFile = legacyCacheFile
      let downloadedSize = 0
      let timeoutHandle
      let request
      let responseStream
      let firstChunk = null
      let settled = false

      const cleanup = (removePartial = false) => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        timeoutHandle = null
        this.activeRequests.delete(request)
        if (responseStream && !responseStream.destroyed) responseStream.destroy()
        if (request && !request.destroyed) request.destroy()
        if (writeStream && !writeStream.destroyed) writeStream.destroy()
        if (removePartial) {
          try { fs.unlinkSync(cacheFile) } catch {}
        }
      }

      const fail = (error) => {
        if (settled) return
        settled = true
        cleanup(true)
        reject(error)
      }

      // 拿到响应头和首个数据块后再确定扩展名（文件魔数 → Content-Type → URL 兜底），
      // 然后创建写入流。B 站 DASH 音频轨是 AAC/MP4，此前被 URL 兜底默认存成 .mp3，
      // 导致 librosa/mpg123 解不开；按内容纠正为 .m4a 后问题消除。
      const beginWrite = (fallbackExt) => {
        if (settled || writeStream) return
        const magicExt = firstChunk ? this._extensionFromMagic(firstChunk) : null
        const headerExt = responseStream
          ? this._extensionFromContentType(responseStream.headers['content-type'])
          : null
        const ext = magicExt || headerExt || fallbackExt || 'mp3'
        const targetFile = path.join(this.tempRoot, `${hash}.${ext}`)
        cacheFile = targetFile

        if (fs.existsSync(targetFile)) {
          if (!this.isInsideTempRoot(targetFile)) {
            fail(new Error('Audio cache target escapes the cache directory'))
            return
          }
          fs.rmSync(targetFile, { force: true })
        }
        writeStream = fs.createWriteStream(targetFile, { flags: 'wx' })
        writeStream.on('finish', () => {
          if (settled) return
          if (downloadedSize === 0) {
            fail(new Error('Empty audio download'))
            return
          }
          settled = true
          cleanup(false)
          console.log(`[AudioCache] Downloaded ${this.formatSize(downloadedSize)} to cache`)

          // Add to cache index
          this.cacheIndex.set(trackKey, {
            trackKey,
            filePath: cacheFile,
            size: downloadedSize,
            timestamp: Date.now(),
            lastAccess: Date.now()
          })
          this.saveCacheIndex()

          // Check and cleanup if necessary
          this.checkAndCleanupCache()

          // 扩展名变化时清理同一 trackKey 的旧命名文件，避免孤儿文件堆积
          if (targetFile !== legacyCacheFile && fs.existsSync(legacyCacheFile)) {
            try { fs.unlinkSync(legacyCacheFile) } catch {}
          }

          resolve(cacheFile)
        })
        writeStream.on('error', fail)

        if (firstChunk) writeStream.write(firstChunk)
        responseStream.pipe(writeStream)
      }

      timeoutHandle = setTimeout(() => {
        fail(new Error('Download timeout'))
      }, timeout)

      request = protocol.get(url, (response) => {
        responseStream = response
        if (response.statusCode !== 200) {
          response.resume()
          fail(new Error(`HTTP ${response.statusCode}`))
          return
        }

        const contentLength = Number(response.headers['content-length'])
        if (Number.isFinite(contentLength) && contentLength > maxSize) {
          fail(new Error('File too large'))
          return
        }

        response.on('data', (chunk) => {
          if (settled) return
          downloadedSize += chunk.length
          if (downloadedSize > maxSize) {
            fail(new Error('File too large'))
            return
          }
          if (!firstChunk) {
            firstChunk = chunk
            beginWrite(urlExt)
          }
        })

        response.on('aborted', () => fail(new Error('Download aborted')))
        response.on('error', fail)
        // 空响应体也要收尾（创建文件后走 finish 的空文件校验）
        response.on('end', () => {
          if (!writeStream) beginWrite(urlExt)
        })
      })

      this.activeRequests.add(request)

      request.on('error', (error) => {
        fail(error)
      })

      request.setTimeout(timeout, () => {
        fail(new Error('Request timeout'))
      })
    })
  }

  _getExtensionFromUrl(url) {
    const match = url.match(/\.([a-z0-9]{2,4})(?:\?|$)/i)
    if (match) {
      return match[1].toLowerCase()
    }
    return 'mp3' // Default
  }

  /** 按文件头魔数识别真实音频格式；不认识返回 null */
  _extensionFromMagic(buffer) {
    if (!buffer || buffer.length < 4) return null
    const bytes = Buffer.from(buffer)
    // MP3: ID3 标签，或 MPEG 帧同步 0xFF Ex
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return 'mp3'
    if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) return 'mp3'
    // MP4/M4A: 'ftyp' 在偏移 4（B 站 DASH 音频轨即 AAC 封装的 fMP4）
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return 'm4a'
    // FLAC: 'fLaC'
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) return 'flac'
    // WAV: 'RIFF' .... 'WAVE'
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) return 'wav'
    // OGG: 'OggS'
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) return 'ogg'
    // M3U8 播放列表: '#EXT'
    if (bytes[0] === 0x23 && bytes[1] === 0x45 && bytes[2] === 0x58 && bytes[3] === 0x54) return 'm3u8'
    return null
  }

  /** 按响应 Content-Type 推断扩展名；不识别返回 null */
  _extensionFromContentType(contentType) {
    const ct = String(contentType || '').split(';')[0].trim().toLowerCase()
    const map = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/mp4a-latm': 'm4a',
      'audio/aac': 'aac',
      'audio/aacp': 'aac',
      'video/mp4': 'mp4',
      'audio/flac': 'flac',
      'audio/x-flac': 'flac',
      'audio/ogg': 'ogg',
      'application/ogg': 'ogg',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/x-mpegurl': 'm3u8',
      'application/vnd.apple.mpegurl': 'm3u8',
    }
    return map[ct] || null
  }

  /**
   * 校验文件内容与其扩展名是否相符。扩展名与魔数不一致（历史误命名）返回 false，
   * 触发重新下载并纠正扩展名；魔数不可识别时视为相符，避免无谓重下。
   */
  _extensionMatchesContent(filePath) {
    try {
      const fd = fs.openSync(filePath, 'r')
      const buf = Buffer.alloc(16)
      const read = fs.readSync(fd, buf, 0, 16, 0)
      fs.closeSync(fd)
      if (read < 4) return false
      const ext = path.extname(filePath).slice(1).toLowerCase()
      const magic = this._extensionFromMagic(buf.subarray(0, read))
      return magic === null || magic === ext
    } catch {
      return true
    }
  }

  /**
   * Clean up temporary files older than specified age
   * and enforce the persistent cache size limit.
   */
  cleanupOldFiles(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(0, maxAgeMs)
    let deletedCount = 0
    for (const [trackKey, entry] of this.cacheIndex) {
      if (!fs.existsSync(entry.filePath) || Number(entry.lastAccess || entry.timestamp || 0) < cutoff) {
        this.deleteCacheFile(trackKey)
        deletedCount++
      }
    }
    this.checkAndCleanupCache()
    return deletedCount
  }

  /**
   * Clean up all cached files when the user explicitly clears the cache.
   */
  cleanupAll() {
    if (!fs.existsSync(this.tempRoot)) return

    for (const request of this.activeRequests) request.destroy(new Error('Audio cache cleared'))
    this.activeRequests.clear()

    console.log('[AudioCache] Cleaning up all cached files...')
    const files = fs.readdirSync(this.tempRoot)
    let deletedCount = 0
    
    for (const file of files) {
      // Skip the cache index file
      if (file === 'cache-index.json') continue
      
      try {
        fs.unlinkSync(path.join(this.tempRoot, file))
        deletedCount++
      } catch (e) {
        // Ignore
      }
    }
    
    // Clear cache index
    this.cacheIndex.clear()
    this.saveCacheIndex()
    
    console.log(`[AudioCache] Cleaned up ${deletedCount} cached files`)
  }

  /**
   * Get local file path if it's a local file URL
   */
  getLocalPath(urlOrPath) {
    if (typeof urlOrPath !== 'string' || !urlOrPath.trim()) return null
    urlOrPath = urlOrPath.trim()

    // Handle file:// protocol
    if (urlOrPath.startsWith('file://')) {
      try {
        return realFilePath(fileURLToPath(urlOrPath))
      } catch {
        return null
      }
    }

    // Handle waveforge-media:// protocol
    if (urlOrPath.startsWith('waveforge-media://')) {
      try {
        return realFilePath(decodeURIComponent(urlOrPath.replace('waveforge-media://', '')))
      } catch {
        return null
      }
    }

    return realFilePath(urlOrPath)
  }

  /**
   * Prepare audio file for analysis
   * Returns local file path (either original or downloaded temp file)
   */
  async prepareAudioFile(urlOrPath, trackKey) {
    if (typeof trackKey !== 'string' || !trackKey.trim() || trackKey.length > 256) {
      throw new Error('Invalid track key')
    }
    // Try to get local path first
    if (typeof urlOrPath !== 'string' || !urlOrPath.trim()) {
      throw new Error('Invalid audio path or URL')
    }
    urlOrPath = urlOrPath.trim()
    const localPath = this.getLocalPath(urlOrPath)
    if (localPath && this.isInputAllowed(localPath)) {
      console.log('Using local file:', localPath)
      return localPath
    }

    // Remote URL, need to download
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      return await this.downloadForAnalysis(urlOrPath, trackKey)
    }

    if (localPath) throw new Error('Local audio file is not authorized')
    throw new Error('Invalid audio path or URL')
  }
}

module.exports = { AudioDownloadService, realFilePath, isPathInside }
