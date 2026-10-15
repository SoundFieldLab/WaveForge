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

const AUDIO_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
const AUDIO_ACCEPT = 'audio/*,application/octet-stream;q=0.9,*/*;q=0.8'
const MAX_REDIRECTS = 5
const FORBIDDEN_COOLDOWN_MS = 30_000

function normalizeAudioUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid audio URL')
  let parsed
  try { parsed = new URL(value.trim()) } catch { throw new Error('Invalid audio URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid audio URL')
  // 只放行音乐 CDN 域名 + 本机 3001 代理（请求头注入令牌的合法链路）。
  // 此前仅查协议，渲染层被入侵后可让主进程 GET 任意 URL（探测内网/读回响应体）。
  const host = parsed.hostname.toLowerCase()
  const isLocalProxy = (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
    && (parsed.port === '3001' || (!parsed.port && parsed.protocol === 'http:'))
  if (!isLocalProxy && !isAllowedAudioDownloadHost(host)) {
    throw new Error('Audio download host is not allowed')
  }
  parsed.hash = ''
  return parsed.href
}

// 音频下载白名单：各音源 CDN/接口域。新增音源时在此登记，而不是放开校验。
// 例外的三类：① 本机 3001 代理（normalizeAudioUrl 里放行）；② requestFactory 注入
// （单测/内部 fetch 桩，allowAnyHost）；③ 环回地址上的本地测试服务器（安全测试用）。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function normalizeAudioUrlForService(value, allowAnyHost = false) {
  let parsed
  try { parsed = new URL(String(value).trim()) } catch { throw new Error('Invalid audio URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Invalid audio URL')
  const host = parsed.hostname.toLowerCase()
  if (!allowAnyHost) {
    // 环回只放行本机 3001 代理（带令牌头注入的合法链路）；无端口的 http 即 80 端口
    // 的任意本机 web 服务不该被主进程下载执行。单测走 requestFactory（allowAnyHost）。
    const isLocalProxy = LOOPBACK_HOSTS.has(host) && parsed.port === '3001'
    if (!isLocalProxy && !isAllowedAudioDownloadHost(host)) {
      throw new Error('Audio download host is not allowed')
    }
  }
  parsed.hash = ''
  return parsed.href
}
const ALLOWED_AUDIO_DOWNLOAD_SUFFIXES = [
  'qq.com',
  'qqmusic.qq.com',
  'gtimg.cn',
  'music.126.net',
  '163.com',
  'bilivideo.com',
  'bilivideo.cn',
  'bilibili.com',
  'hdslb.com',
  'qishui.com',
  'douyin.com',
  'bytecdn.cn',
  'bytedance.com',
  'zjcdn.com',
  'kugou.com',
  'kgimg.com',
]

function isAllowedAudioDownloadHost(host) {
  const name = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!name || name === 'localhost' || name.endsWith('.local')) return false
  return ALLOWED_AUDIO_DOWNLOAD_SUFFIXES.some(suffix => name === suffix || name.endsWith(`.${suffix}`))
}

function audioReferer(url) {
  const host = new URL(url).hostname.toLowerCase()
  if (host.includes('qq.com') || host.includes('qqmusic')) return 'https://y.qq.com/'
  if (host.includes('163.com') || host.includes('netease')) return 'https://music.163.com/'
  if (host.includes('bilibili') || host.includes('bilivideo')) return 'https://www.bilibili.com/'
  return undefined
}

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
  constructor(tempRoot, options = {}) {
    this.tempRoot = path.resolve(tempRoot)
    this.requestFactory = options.requestFactory || null
    this.logger = options.logger || ((message, details) => console.warn(message, details || ''))
    this.now = options.now || (() => Date.now())
    this.activeDownloads = new Map()
    this.forbiddenUntilByUrl = new Map()
    this.activeRequests = new Set()
    this.activeCacheFiles = new Set()
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
        
        if (this.deleteCacheFile(file.trackKey)) freedSize += file.size
      }
      
      console.log(`[AudioCache] Cleanup complete, freed ${this.formatSize(freedSize)}`)
    }
  }

  /**
   * Delete a cached file
   */
  deleteCacheFile(trackKey) {
    const cached = this.cacheIndex.get(trackKey)
    if (!cached) return false
    if (this.activeCacheFiles.has(path.resolve(cached.filePath))) return false

    try {
      if (fs.existsSync(cached.filePath)) {
        fs.unlinkSync(cached.filePath)
      }
      this.cacheIndex.delete(trackKey)
      this.saveCacheIndex()
      console.log(`[AudioCache] Deleted: ${trackKey}`)
      return true
    } catch (error) {
      console.error('[AudioCache] Failed to delete file:', error)
      return false
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
    if (typeof trackKey !== 'string' || !trackKey.trim() || trackKey.length > 256) {
      throw new Error('Invalid track key')
    }
    trackKey = trackKey.trim()
    const { timeout = 60000, maxSize = 100 * 1024 * 1024 } = options // 100MB max

    // Check if already in cache —— 必须排在 403 冷却检查之前：
    // 冷却按「URL」记录（典型：预热期拿到空 vkey URL 被上游 403）。文件已经缓存时
    // 根本不需要下载，若被 URL 冷却挡住，渲染/分析会在文件就绪的情况下依然拿不到
    // 路径（实测表现：快进/跳进度触发重新准备 → 整轮 render-fail → 永久回退固定交叉）。
    const cachedEntry = this.cacheIndex.get(trackKey)
    const cacheUsable = Boolean(
      cachedEntry
      && this.isInsideTempRoot(cachedEntry.filePath)
      && this._extensionMatchesContent(cachedEntry.filePath),
    )
    if (cacheUsable) {
      // Update last access time
      cachedEntry.lastAccess = Date.now()
      this.saveCacheIndex()
      console.log(`[AudioCache] Cache hit: ${trackKey}`)
      return cachedEntry.filePath
    }

    const canonicalUrl = normalizeAudioUrlForService(url, Boolean(this.requestFactory))
    const now = this.now()
    const forbiddenUntil = this.forbiddenUntilByUrl.get(canonicalUrl) || 0
    if (forbiddenUntil > now) {
      const error = new Error(`AUDIO_DOWNLOAD_403_COOLDOWN: retry after ${forbiddenUntil - now}ms`)
      error.statusCode = 403
      throw error
    }
    if (forbiddenUntil) this.forbiddenUntilByUrl.delete(canonicalUrl)

    if (cachedEntry) {
      // 历史误命名（内容与扩展名不符，如 B 站 DASH 的 AAC/MP4 被存成 .mp3）
      // 会让 Python/librosa 永远解不开这个"假 mp3"。发现即作废重下，
      // 新文件按响应内容纠正扩展名。
      console.warn(`[AudioCache] Cached file content mismatch (${cachedEntry.filePath}), re-downloading with correct extension`)
      this.deleteCacheFile(trackKey)
    }

    // Check if already downloading the same signed URL.
    const activeKey = `${trackKey}\n${canonicalUrl}`
    if (this.activeDownloads.has(activeKey)) {
      return await this.activeDownloads.get(activeKey)
    }

    const downloadPromise = this._performDownload(canonicalUrl, trackKey, timeout, maxSize)
    this.activeDownloads.set(activeKey, downloadPromise)

    try {
      const result = await downloadPromise
      return result
    } finally {
      this.activeDownloads.delete(activeKey)
    }
  }

  _performDownload(url, trackKey, timeout, maxSize) {
    return new Promise((resolve, reject) => {
      // Generate cache file path
      const hash = crypto.createHash('md5').update(`${trackKey}\n${url}`).digest('hex')
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
        if (responseStream && typeof responseStream.destroy === 'function' && !responseStream.destroyed) responseStream.destroy()
        if (request && typeof request.destroy === 'function' && !request.destroyed) request.destroy()
        if (writeStream && !writeStream.destroyed) writeStream.destroy()
        if (removePartial) {
          try { fs.unlinkSync(cacheFile) } catch {}
        }
        this.activeCacheFiles.delete(path.resolve(cacheFile))
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
        this.activeCacheFiles.add(path.resolve(cacheFile))

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

      const requestUrl = (currentUrl, redirectCount = 0) => {
        const parsed = new URL(currentUrl)
        const headers = {
          'User-Agent': AUDIO_USER_AGENT,
          Accept: AUDIO_ACCEPT,
        }
        // 本机服务（3001 代理的 QQ/B站 音频流）需要本机服务令牌：渲染层的请求由
        // Electron onBeforeSendHeaders 统一注入，但本模块跑在主进程（无 webContentsId
        // 拿不到注入），缺头一律 403 "Unauthorized local service request"（实测 MV 对齐
        // 的歌曲/MV 分析下载整批被 403 冷却 30s，节拍/包络分析被迫走浏览器兜底）。
        // 令牌与 local-server 同源（主进程 LOCAL_SERVICE_TOKEN），经环境变量传入。
        const requestHost = parsed.hostname.toLowerCase()
        const requestPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
        // 仅 3001（local-server）：令牌是本地服务的唯一凭据，发给本机任意端口的
        // 服务器等于把凭据交给不可信进程（测试服务器/其它本机应用都能收到）。
        if ((requestHost === 'localhost' || requestHost === '127.0.0.1' || requestHost === '[::1]' || requestHost === '::1') && requestPort === '3001') {
          const localToken = process.env.WAVEFORGE_LOCAL_TOKEN
          if (localToken) headers['X-WaveForge-Local-Token'] = localToken
        }
        const referer = audioReferer(currentUrl)
        if (referer) headers.Referer = referer
        const responseHandler = (response) => {
          responseStream = response
          const statusCode = Number(response.statusCode) || 0
          if ([301, 302, 303, 307, 308].includes(statusCode)) {
            const location = response.headers.location
            response.resume()
            this.activeRequests.delete(request)
            if (!location || redirectCount >= MAX_REDIRECTS) {
              fail(new Error('Audio download redirect limit exceeded'))
              return
            }
            // 逐跳重过 host 白名单：防止公网跳板 302 到内网/任意地址
            let nextUrl
            try {
              nextUrl = normalizeAudioUrl(new URL(location, currentUrl).href)
            } catch (error) {
              fail(new Error('Audio download redirected to a disallowed host'))
              return
            }
            requestUrl(nextUrl, redirectCount + 1)
            return
          }
          if (statusCode !== 200 && statusCode !== 206) {
            response.resume()
            if (statusCode === 403) {
              const forbiddenUntil = this.now() + FORBIDDEN_COOLDOWN_MS
              this.forbiddenUntilByUrl.set(url, forbiddenUntil)
              while (this.forbiddenUntilByUrl.size > 256) {
                this.forbiddenUntilByUrl.delete(this.forbiddenUntilByUrl.keys().next().value)
              }
              this.logger('[AudioCache] Download blocked', {
                trackKey,
                host: parsed.hostname,
                statusCode,
                cooldownMs: FORBIDDEN_COOLDOWN_MS,
              })
              const error = new Error('AUDIO_DOWNLOAD_HTTP_403: HTTP 403')
              error.statusCode = 403
              fail(error)
              return
            }
            const error = new Error(`AUDIO_DOWNLOAD_HTTP_${statusCode}: HTTP ${statusCode}`)
            error.statusCode = statusCode
            fail(error)
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
          response.on('end', () => {
            if (!writeStream) beginWrite(urlExt)
          })
        }
        const protocol = parsed.protocol === 'https:' ? https : http
        request = this.requestFactory
          ? this.requestFactory({ url: currentUrl, headers }, responseHandler)
          : protocol.get(currentUrl, { headers }, responseHandler)
        this.activeRequests.add(request)
        request.on('error', fail)
        request.setTimeout?.(timeout, () => fail(new Error('Request timeout')))
      }

      requestUrl(url)
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
   * 异步化 + 索引批量保存：原实现同步 readdirSync+逐文件 rmSync，且 deleteCacheFile
   * 每删一条就全量 saveCacheIndex 一次（N 条缓存 = N 次全量索引写盘），主线程长卡。
   */
  async cleanupOldFiles(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - Math.max(0, maxAgeMs)
    let deletedCount = 0
    for (const [trackKey, entry] of this.cacheIndex) {
      let stale = false
      try {
        stale = !(await fs.promises.stat(entry.filePath)).isFile()
          || Number(entry.lastAccess || entry.timestamp || 0) < cutoff
      } catch {
        stale = true
      }
      if (!stale) continue
      if (this.activeCacheFiles.has(path.resolve(entry.filePath))) continue
      try {
        await fs.promises.rm(entry.filePath, { force: true })
      } catch {}
      this.cacheIndex.delete(trackKey)
      deletedCount++
    }
    if (deletedCount > 0) this.saveCacheIndex()
    let indexedPaths
    try {
      indexedPaths = new Set(Array.from(this.cacheIndex.values(), entry => path.resolve(entry.filePath)))
      for (const entry of await fs.promises.readdir(this.tempRoot, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name === 'cache-index.json') continue
        const target = path.join(this.tempRoot, entry.name)
        const resolvedTarget = path.resolve(target)
        if (this.activeCacheFiles.has(resolvedTarget)) continue
        try {
          if (entry.name.endsWith('.tmp') || !indexedPaths.has(resolvedTarget)) await fs.promises.rm(target, { force: true })
        } catch {}
      }
    } catch {}
    this.checkAndCleanupCache()
    return deletedCount
  }

  /**
   * Clean up all cached files when the user explicitly clears the cache.
   * 异步化：同上，数千文件的一次性 unlink 会卡主线程。
   */
  async cleanupAll() {
    if (!fs.existsSync(this.tempRoot)) return

    for (const request of this.activeRequests) request.destroy(new Error('Audio cache cleared'))
    this.activeRequests.clear()

    console.log('[AudioCache] Cleaning up all cached files...')
    let files
    try {
      files = await fs.promises.readdir(this.tempRoot)
    } catch {
      return
    }
    let deletedCount = 0

    for (const file of files) {
      // Skip the cache index file
      if (file === 'cache-index.json') continue

      try {
        const target = path.join(this.tempRoot, file)
        if (this.activeCacheFiles.has(path.resolve(target))) continue
        await fs.promises.rm(target, { force: true })
        deletedCount++
      } catch (e) {
        // Ignore
      }
    }

    for (const [trackKey, entry] of this.cacheIndex) {
      let exists = true
      try { exists = (await fs.promises.stat(entry.filePath)).isFile() } catch { exists = false }
      if (!exists || this.activeCacheFiles.has(path.resolve(entry.filePath))) continue
      this.cacheIndex.delete(trackKey)
    }
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
