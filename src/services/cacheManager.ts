import type { MusicPlatform } from './platforms'
/**
 * 缓存管理服务
 * 用于管理歌单封面、歌单列表等数据的本地缓存
 */

import { indexedDBCache } from './indexedDBCache'
import { clearUserPlaylistsMemoryCache } from './playlistService'
import { getCacheLimits } from '../tv/perfMode'

interface CacheItem {
  data: any
  timestamp: number
  size: number // 字节
  accessCount?: number // 访问次数
  lastAccess?: number // 最后访问时间
}

interface CacheStats {
  coverCount: number
  coverSize: number
  playlistCount: number
  playlistSize: number
  errorLogCount: number
  errorLogSize: number
  totalSize: number
}

interface AutoClearSettings {
  enabled: boolean
  days: number  // 多少天后自动清理
  clearOnClose: boolean  // 关闭软件时清理
  targets: {
    covers: boolean
    playlists: boolean
    lyrics: boolean
    errorLogs: boolean
    audio: boolean
    analysis: boolean
    transitions: boolean
  }
}

class CacheManager {
  private cacheDir: string
  private readonly CACHE_VERSION = '1.0'
  private readonly AUTO_CLEAR_SETTINGS_KEY = 'autoClearSettings'
  private readonly LAST_CLEAR_TIME_KEY = 'lastClearTime'
  private readonly PENDING_CLOSE_CLEAR_KEY = 'pendingCloseCacheClear'
  
  constructor() {
    // 默认缓存目录
    this.cacheDir = localStorage.getItem('cacheDirectory') || this.getDefaultCacheDir()
    
    void this.initializeCleanup().catch(error => console.error('自动缓存清理失败:', error))
  }

  private async initializeCleanup(): Promise<void> {
    await indexedDBCache.cleanupExpired()
    const settings = this.getAutoClearSettings()
    if (localStorage.getItem(this.PENDING_CLOSE_CLEAR_KEY) === 'true') {
      await this.autoCleanCache(settings.targets)
      localStorage.removeItem(this.PENDING_CLOSE_CLEAR_KEY)
    }
    await this.checkAutoClear()
  }
  
  /**
   * 获取默认缓存目录
   */
  private getDefaultCacheDir(): string {
    // 浏览器环境使用 localStorage/IndexedDB
    return 'browser-cache'
  }
  
  /**
   * 设置缓存目录
   */
  setCacheDirectory(dir: string) {
    this.cacheDir = dir
    localStorage.setItem('cacheDirectory', dir)
  }
  
  /**
   * 获取缓存目录
   */
  getCacheDirectory(): string {
    return this.cacheDir
  }
  
  /**
   * 缓存歌单列表
   */
  async cachePlaylist(userId: string, platform: MusicPlatform, playlists: any[]) {
    userId = userId.trim()
    if (!userId) throw new Error('缓存用户 ID 不能为空')
    const key = `playlist_${platform}_${userId}`
    const data = JSON.stringify(playlists)
    const size = new Blob([data]).size
    
    const cacheItem: CacheItem = {
      data: playlists,
      timestamp: Date.now(),
      size
    }
    
    localStorage.setItem(key, JSON.stringify(cacheItem))
    console.log(`✅ 已缓存歌单列表: ${platform} ${userId}, 大小: ${this.formatSize(size)}`)
  }
  
  /**
   * 获取缓存的歌单列表
   */
  async getCachedPlaylist(userId: string, platform: MusicPlatform): Promise<any[] | null> {
    userId = userId.trim()
    if (!userId) return null
    const key = `playlist_${platform}_${userId}`
    const cached = localStorage.getItem(key)
    
    if (!cached) return null
    
    try {
      const cacheItem: CacheItem = JSON.parse(cached)
      
      // 检查是否过期（1小时 - 更短的过期时间以保证数据新鲜度）
      const age = Date.now() - cacheItem.timestamp
      if (age > 60 * 60 * 1000) {
        console.log('⚠️ 歌单缓存已过期（超过1小时），删除')
        localStorage.removeItem(key)
        return null
      }
      
      console.log(`✅ 从缓存加载歌单列表: ${platform} ${userId}（缓存${Math.round(age / 60000)}分钟前）`)
      return cacheItem.data
    } catch (error) {
      console.error('解析缓存失败:', error)
      return null
    }
  }
  
  /**
   * 缓存封面图片（使用 Base64）
   * 使用 LRU 策略，支持大图片缓存
   */
  async cacheCover(url: string, imageData: string) {
    url = url.trim()
    if (!url) throw new Error('封面缓存 URL 不能为空')
    const key = `cover_${this.hashUrl(url)}`
    const size = new Blob([imageData]).size
    
    const limits = getCacheLimits()
    const MAX_COVERS = limits.coverCount // 最多缓存的封面数（TV 按性能模式动态）
    const MAX_SIZE = limits.coverBytes // 封面总大小上限
    const MAX_SINGLE_IMAGE_SIZE = limits.singleImage // 单张图片最大
    
    // 如果单张图片超过 10MB，直接跳过缓存
    if (size > MAX_SINGLE_IMAGE_SIZE) {
      console.debug(`⏭️ 跳过缓存超大图片 (${this.formatSize(size)}): ${url.substring(0, 50)}...`)
      return
    }
    
    // 检查当前封面缓存数量和总大小
    const coverCount = this.getCoverCount()
    const currentSize = this.getTotalCoverSize()
    
    // 如果超过数量或大小限制，积极清理
    if (coverCount >= MAX_COVERS || currentSize + size > MAX_SIZE) {
      const cleanCount = Math.max(50, Math.floor(MAX_COVERS * 0.1)) // 至少清理 50 个或 10%
      console.log(`📦 封面缓存已达限制 (${coverCount}/${MAX_COVERS}, ${this.formatSize(currentSize)}/${this.formatSize(MAX_SIZE)})，清理 ${cleanCount} 个封面...`)
      this.cleanLRUCovers(cleanCount)
    }
    
    const cacheItem: CacheItem = {
      data: imageData,
      timestamp: Date.now(),
      size,
      accessCount: 1,
      lastAccess: Date.now()
    }
    
    try {
      localStorage.setItem(key, JSON.stringify(cacheItem))
      console.log(`✅ 已缓存封面 [${this.getCoverCount()}/${MAX_COVERS}]: ${url.substring(0, 50)}...`)
    } catch (error) {
      // localStorage 满了，激进清理
      console.warn('⚠️ 缓存空间不足，激进清理封面')
      this.cleanLRUCovers(Math.max(100, Math.floor(coverCount * 0.2))) // 清理至少 100 个或 20%
      
      // 重试一次
      try {
        localStorage.setItem(key, JSON.stringify(cacheItem))
        console.log(`✅ 已缓存封面（重试成功）: ${url.substring(0, 50)}...`)
      } catch (e) {
        // 彻底失败，静默忽略（不影响用户体验，只是没有缓存）
        console.debug('⏭️ 跳过缓存此封面，空间不足')
      }
    }
  }
  
  /**
   * 获取缓存的封面
   */
  async getCachedCover(url: string): Promise<string | null> {
    url = url.trim()
    if (!url) return null
    const key = `cover_${this.hashUrl(url)}`
    const cached = localStorage.getItem(key)
    
    if (!cached) return null
    
    try {
      const cacheItem: CacheItem = JSON.parse(cached)
      
      // 检查是否过期（30天）
      const age = Date.now() - cacheItem.timestamp
      if (age > 30 * 24 * 60 * 60 * 1000) {
        localStorage.removeItem(key)
        return null
      }
      
      // 更新访问统计（LRU）
      cacheItem.accessCount = (cacheItem.accessCount || 0) + 1
      cacheItem.lastAccess = Date.now()
      try {
        localStorage.setItem(key, JSON.stringify(cacheItem))
      } catch {
        // 忽略更新失败
      }
      
      return cacheItem.data
    } catch (error) {
      console.error('解析封面缓存失败:', error)
      return null
    }
  }
  
  /**
   * 记录错误日志
   */
  async logError(error: any) {
    const key = 'error_logs'
    const logs = this.getErrorLogs()
    
    const errorLog = {
      message: error?.message || String(error),
      stack: error?.stack,
      timestamp: Date.now(),
      url: window.location.href
    }
    
    logs.push(errorLog)
    
    // 只保留最近100条
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100)
    }
    
    const data = JSON.stringify(logs)
    const size = new Blob([data]).size
    
    const cacheItem: CacheItem = {
      data: logs,
      timestamp: Date.now(),
      size
    }
    
    localStorage.setItem(key, JSON.stringify(cacheItem))
  }
  
  /**
   * 获取错误日志
   */
  getErrorLogs(): any[] {
    const cached = localStorage.getItem('error_logs')
    if (!cached) return []
    
    try {
      const cacheItem: CacheItem = JSON.parse(cached)
      return cacheItem.data || []
    } catch {
      return []
    }
  }
  
  /**
   * 获取缓存统计
   */
  getCacheStats(): CacheStats {
    const stats: CacheStats = {
      coverCount: 0,
      coverSize: 0,
      playlistCount: 0,
      playlistSize: 0,
      errorLogCount: 0,
      errorLogSize: 0,
      totalSize: 0
    }
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) continue
      
      const value = localStorage.getItem(key)
      if (!value) continue
      
      try {
        const cacheItem: CacheItem = JSON.parse(value)
        const size = cacheItem.size || new Blob([value]).size
        
        let recognized = true
        if (key.startsWith('cover_')) {
          stats.coverCount++
          stats.coverSize += size
        } else if (key.startsWith('playlist_')) {
          stats.playlistCount++
          stats.playlistSize += size
        } else if (key === 'error_logs') {
          stats.errorLogCount = cacheItem.data?.length || 0
          stats.errorLogSize += size
        } else recognized = false

        if (recognized) stats.totalSize += size
      } catch {
        // 忽略非缓存项
      }
    }
    
    return stats
  }
  
  /**
   * 清理封面缓存
   */
  clearCovers() {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('cover_')) {
        keys.push(key)
      }
    }
    
    keys.forEach(key => localStorage.removeItem(key))
    console.log(`✅ 已清理 ${keys.length} 个封面缓存`)
  }
  
  /**
   * 清理歌单列表缓存
   */
  clearPlaylists() {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('playlist_')) {
        keys.push(key)
      }
    }
    
    keys.forEach(key => localStorage.removeItem(key))
    console.log(`✅ 已清理 ${keys.length} 个歌单列表缓存`)
  }
  
  /**
   * 清理错误日志
   */
  clearErrorLogs() {
    localStorage.removeItem('error_logs')
    console.log('✅ 已清理错误日志')
  }
  
  /**
   * 清理所有缓存
   */
  clearAll() {
    this.clearCovers()
    this.clearPlaylists()
    this.clearErrorLogs()
    console.log('✅ 已清理所有缓存')
  }
  
  /**
   * 清理旧的封面缓存
   */
  private cleanOldCovers(count: number) {
    const covers: Array<{ key: string, timestamp: number }> = []
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('cover_')) continue
      
      const value = localStorage.getItem(key)
      if (!value) continue
      
      try {
        const cacheItem: CacheItem = JSON.parse(value)
        covers.push({ key, timestamp: cacheItem.timestamp })
      } catch {}
    }
    
    // 按时间排序，删除最旧的
    covers.sort((a, b) => a.timestamp - b.timestamp)
    covers.slice(0, count).forEach(item => {
      localStorage.removeItem(item.key)
    })
  }
  
  /**
   * 使用 LRU 策略清理封面缓存
   * 基于访问频率和最后访问时间
   */
  private cleanLRUCovers(count: number) {
    const covers: Array<{ 
      key: string
      score: number // LRU 分数（越低越应该被清理）
    }> = []
    
    const now = Date.now()
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('cover_')) continue
      
      const value = localStorage.getItem(key)
      if (!value) continue
      
      try {
        const cacheItem: CacheItem = JSON.parse(value)
        const accessCount = cacheItem.accessCount || 1
        const lastAccess = cacheItem.lastAccess || cacheItem.timestamp
        const daysSinceAccess = (now - lastAccess) / (1000 * 60 * 60 * 24)
        
        // LRU 分数计算：访问次数越多分数越高，最后访问时间越近分数越高
        // 分数 = 访问次数 / (距离最后访问的天数 + 1)
        const score = accessCount / (daysSinceAccess + 1)
        
        covers.push({ key, score })
      } catch {}
    }
    
    // 按分数排序，删除分数最低的（最少使用的）
    covers.sort((a, b) => a.score - b.score)
    const toRemove = covers.slice(0, count)
    
    toRemove.forEach(item => {
      localStorage.removeItem(item.key)
    })
    
    console.log(`🗑️ 已清理 ${toRemove.length} 个最少使用的封面缓存`)
  }
  
  /**
   * 获取当前封面缓存数量
   */
  private getCoverCount(): number {
    let count = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('cover_')) {
        count++
      }
    }
    return count
  }
  
  /**
   * 获取当前封面缓存总大小
   */
  private getTotalCoverSize(): number {
    let totalSize = 0
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('cover_')) {
        const value = localStorage.getItem(key)
        if (value) {
          try {
            const cacheItem: CacheItem = JSON.parse(value)
            totalSize += cacheItem.size || 0
          } catch {}
        }
      }
    }
    return totalSize
  }
  
  /**
   * URL 哈希（简单实现）
   */
  private hashUrl(url: string): string {
    let hash = 0
    for (let i = 0; i < url.length; i++) {
      const char = url.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36)
  }
  
  /**
   * 格式化文件大小
   */
  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  }
  
  /**
   * 获取自动清理设置
   */
  getAutoClearSettings(): AutoClearSettings {
    const defaults: AutoClearSettings = {
      enabled: false,
      days: 14,
      clearOnClose: false,
      targets: { covers: true, playlists: false, lyrics: false, errorLogs: true, audio: false, analysis: false, transitions: false }
    }
    const saved = localStorage.getItem(this.AUTO_CLEAR_SETTINGS_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Partial<AutoClearSettings>
        return {
          enabled: parsed.enabled === true,
          days: Math.max(1, Math.min(365, Number(parsed.days) || defaults.days)),
          clearOnClose: parsed.clearOnClose === true,
          targets: {
            covers: parsed.targets?.covers !== false,
            playlists: parsed.targets?.playlists === true,
            lyrics: parsed.targets?.lyrics === true,
            errorLogs: parsed.targets?.errorLogs !== false,
            audio: parsed.targets?.audio === true,
            analysis: parsed.targets?.analysis === true,
            transitions: parsed.targets?.transitions === true,
          },
        }
      } catch {}
    }
    return defaults
  }
  
  /**
   * 保存自动清理设置
   */
  setAutoClearSettings(settings: AutoClearSettings) {
    const normalized: AutoClearSettings = {
      ...settings,
      days: Math.max(1, Math.min(365, Number(settings.days) || 14)),
      targets: { ...settings.targets },
    }
    localStorage.setItem(this.AUTO_CLEAR_SETTINGS_KEY, JSON.stringify(normalized))
    console.log('✅ 自动清理设置已保存:', normalized)
  }
  
  /**
   * 检查是否需要自动清理
   */
  async checkAutoClear(): Promise<void> {
    const settings = this.getAutoClearSettings()
    
    if (!settings.enabled) {
      return
    }
    
    const lastClearTime = localStorage.getItem(this.LAST_CLEAR_TIME_KEY)
    const now = Date.now()
    
    // 如果从未清理过，记录当前时间
    if (!lastClearTime) {
      localStorage.setItem(this.LAST_CLEAR_TIME_KEY, String(now))
      return
    }
    
    const parsedLastClearTime = Number(lastClearTime)
    if (!Number.isFinite(parsedLastClearTime) || parsedLastClearTime > now) {
      localStorage.setItem(this.LAST_CLEAR_TIME_KEY, String(now))
      return
    }
    const daysSinceLastClear = (now - parsedLastClearTime) / (1000 * 60 * 60 * 24)
    
    // 检查是否到达清理时间
    if (daysSinceLastClear >= settings.days) {
      console.log(`🗑️ 自动清理: 已超过 ${settings.days} 天，开始清理缓存...`)
      await this.autoCleanCache(settings.targets)
      localStorage.setItem(this.LAST_CLEAR_TIME_KEY, String(Date.now()))
    }
  }
  
  /**
   * 自动清理缓存
   */
  private async autoCleanCache(targets: AutoClearSettings['targets']): Promise<void> {
    let cleared = false
    
    if (targets.covers) {
      this.clearCovers()
      await indexedDBCache.clearCovers()
      cleared = true
    }
    
    if (targets.playlists) {
      this.clearPlaylists()
      clearUserPlaylistsMemoryCache()
      await indexedDBCache.clearPlaylists()
      cleared = true
    }

    if (targets.lyrics) {
      window.dispatchEvent(new Event('waveforge:lyrics-cache-cleared'))
      await indexedDBCache.clearLyrics()
      cleared = true
    }
    
    if (targets.errorLogs) {
      this.clearErrorLogs()
      cleared = true
    }

    if (targets.audio && window.electron?.audioDownload) {
      const result = await window.electron.audioDownload.clearCache()
      if (!result.success) throw new Error('音频缓存清理失败')
      cleared = true
    }

    if (targets.analysis && window.electron?.analysis) {
      const result = await window.electron.analysis.clearCache()
      if (!result.success) throw new Error(result.error || '分析缓存清理失败')
      cleared = true
    }

    if (targets.transitions && window.electron?.render) {
      window.dispatchEvent(new Event('waveforge:track-stem-cache-clearing'))
      const [renderResult, stemResult, trackStemResult] = await Promise.all([
        window.electron.render.clearCache(),
        window.electron.stems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
        window.electron.trackStems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
      ])
      if (!renderResult.success || !stemResult.success || !trackStemResult.success) {
        throw new Error('过渡或分轨缓存清理失败')
      }
      cleared = true
    }
    
    if (cleared) {
      console.log('✅ 自动清理完成')
    }
  }
  
  /**
   * 关闭软件时清理缓存
   */
  async clearOnClose(): Promise<void> {
    const settings = this.getAutoClearSettings()
    
    if (!settings.clearOnClose) {
      return
    }
    
    // beforeunload may interrupt asynchronous IndexedDB/IPC calls. This marker
    // guarantees the cleanup finishes on the next startup if that happens.
    localStorage.setItem(this.PENDING_CLOSE_CLEAR_KEY, 'true')
    await this.autoCleanCache(settings.targets)
    localStorage.removeItem(this.PENDING_CLOSE_CLEAR_KEY)
  }
  
  /**
   * 获取上次清理时间
   */
  getLastClearTime(): number | null {
    const saved = localStorage.getItem(this.LAST_CLEAR_TIME_KEY)
    const parsed = saved ? Number(saved) : NaN
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }
  
  /**
   * 获取距离下次清理的天数
   */
  getDaysUntilNextClear(): number | null {
    const settings = this.getAutoClearSettings()
    
    if (!settings.enabled) {
      return null
    }
    
    const lastClearTime = this.getLastClearTime()
    if (!lastClearTime) {
      return settings.days
    }
    
    const daysSinceLastClear = (Date.now() - lastClearTime) / (1000 * 60 * 60 * 24)
    const daysRemaining = settings.days - daysSinceLastClear
    
    return Math.max(0, Math.ceil(daysRemaining))
  }
}

// 导出单例
export const cacheManager = new CacheManager()
