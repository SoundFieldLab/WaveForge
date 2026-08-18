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

class AudioDownloadService {
  constructor(tempRoot) {
    this.tempRoot = tempRoot
    this.activeDownloads = new Map()
    this.activeRequests = new Set()
    this.cacheIndex = new Map() // trackKey -> {filePath, size, timestamp, lastAccess}
    this.maxCacheSize = 2 * 1024 * 1024 * 1024 // 2GB
    this.cacheIndexFile = path.join(tempRoot, 'cache-index.json')
    this.ensureTempDir()
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
    const relative = path.relative(path.resolve(this.tempRoot), path.resolve(target))
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
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
   * Download audio from URL to cache
   * Returns path to downloaded file
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
    if (cached && fs.existsSync(cached.filePath)) {
      // Update last access time
      cached.lastAccess = Date.now()
      this.saveCacheIndex()
      console.log(`[AudioCache] Cache hit: ${trackKey}`)
      return cached.filePath
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
      const ext = this._getExtensionFromUrl(url)
      const cacheFile = path.join(this.tempRoot, `${hash}.${ext}`)

      // Check if already exists in cache
      if (fs.existsSync(cacheFile)) {
        console.log('[AudioCache] Using cached file:', cacheFile)
        
        // Add to cache index if not already there
        if (!this.cacheIndex.has(trackKey)) {
          const stats = fs.statSync(cacheFile)
          this.cacheIndex.set(trackKey, {
            trackKey,
            filePath: cacheFile,
            size: stats.size,
            timestamp: Date.now(),
            lastAccess: Date.now()
          })
          this.saveCacheIndex()
        }
        
        resolve(cacheFile)
        return
      }

      console.log('[AudioCache] Downloading audio from URL...')
      
      const protocol = url.startsWith('https') ? https : http
      const writeStream = fs.createWriteStream(cacheFile)
      let downloadedSize = 0
      let timeoutHandle
      let request
      let responseStream
      let settled = false

      const cleanup = (removePartial = false) => {
        if (timeoutHandle) clearTimeout(timeoutHandle)
        timeoutHandle = null
        this.activeRequests.delete(request)
        if (responseStream && !responseStream.destroyed) responseStream.destroy()
        if (request && !request.destroyed) request.destroy()
        if (!writeStream.destroyed) writeStream.destroy()
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
          }
        })

        response.on('aborted', () => fail(new Error('Download aborted')))
        response.on('error', fail)

        response.pipe(writeStream)

        writeStream.on('finish', () => {
          if (settled) return
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
          
          resolve(cacheFile)
        })

        writeStream.on('error', (error) => {
          fail(error)
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
        return fileURLToPath(urlOrPath)
      } catch {
        return null
      }
    }

    // Handle waveforge-media:// protocol
    if (urlOrPath.startsWith('waveforge-media://')) {
      return decodeURIComponent(urlOrPath.replace('waveforge-media://', ''))
    }

    // Check if it's already a local path
    if (fs.existsSync(urlOrPath)) {
      try {
        return fs.statSync(urlOrPath).isFile() ? path.resolve(urlOrPath) : null
      } catch {
        return null
      }
    }

    return null
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
    if (localPath && fs.existsSync(localPath) && fs.statSync(localPath).isFile()) {
      console.log('Using local file:', localPath)
      return localPath
    }

    // Remote URL, need to download
    if (urlOrPath.startsWith('http://') || urlOrPath.startsWith('https://')) {
      return await this.downloadForAnalysis(urlOrPath, trackKey)
    }

    throw new Error('Invalid audio path or URL')
  }
}

module.exports = { AudioDownloadService }
