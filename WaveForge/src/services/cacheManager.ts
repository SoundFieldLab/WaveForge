/**
 * 缓存管理服务
 * 用于管理歌单封面、歌单列表等数据的本地缓存
 */

interface CacheItem {
  data: any
  timestamp: number
  size: number // 字节
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
    errorLogs: boolean
  }
}

class CacheManager {
  private cacheDir: string
  private readonly CACHE_VERSION = '1.0'
  private readonly AUTO_CLEAR_SETTINGS_KEY = 'autoClearSettings'
  private readonly LAST_CLEAR_TIME_KEY = 'lastClearTime'
  
  constructor() {
    // 默认缓存目录
    this.cacheDir = localStorage.getItem('cacheDirectory') || this.getDefaultCacheDir()
    
    // 检查是否需要自动清理
    this.checkAutoClear()
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
  async cachePlaylist(userId: string, platform: 'netease' | 'qq', playlists: any[]) {
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
  async getCachedPlaylist(userId: string, platform: 'netease' | 'qq'): Promise<any[] | null> {
    const key = `playlist_${platform}_${userId}`
    const cached = localStorage.getItem(key)
    
    if (!cached) return null
    
    try {
      const cacheItem: CacheItem = JSON.parse(cached)
      
      // 检查是否过期（7天）
      const age = Date.now() - cacheItem.timestamp
      if (age > 7 * 24 * 60 * 60 * 1000) {
        console.log('⚠️ 缓存已过期，删除')
        localStorage.removeItem(key)
        return null
      }
      
      console.log(`✅ 从缓存加载歌单列表: ${platform} ${userId}`)
      return cacheItem.data
    } catch (error) {
      console.error('解析缓存失败:', error)
      return null
    }
  }
  
  /**
   * 缓存封面图片（使用 Base64）
   */
  async cacheCover(url: string, imageData: string) {
    const key = `cover_${this.hashUrl(url)}`
    const size = new Blob([imageData]).size
    
    const cacheItem: CacheItem = {
      data: imageData,
      timestamp: Date.now(),
      size
    }
    
    try {
      localStorage.setItem(key, JSON.stringify(cacheItem))
      console.log(`✅ 已缓存封面: ${url.substring(0, 50)}...`)
    } catch (error) {
      // localStorage 满了，清理旧的封面
      console.warn('⚠️ 缓存空间不足，清理旧封面')
      this.cleanOldCovers(10)
      
      // 重试
      try {
        localStorage.setItem(key, JSON.stringify(cacheItem))
      } catch (e) {
        console.error('缓存封面失败:', e)
      }
    }
  }
  
  /**
   * 获取缓存的封面
   */
  async getCachedCover(url: string): Promise<string | null> {
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
      message: error.message || String(error),
      stack: error.stack,
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
        
        if (key.startsWith('cover_')) {
          stats.coverCount++
          stats.coverSize += size
        } else if (key.startsWith('playlist_')) {
          stats.playlistCount++
          stats.playlistSize += size
        } else if (key === 'error_logs') {
          stats.errorLogCount = cacheItem.data?.length || 0
          stats.errorLogSize += size
        }
        
        stats.totalSize += size
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
    const saved = localStorage.getItem(this.AUTO_CLEAR_SETTINGS_KEY)
    if (saved) {
      try {
        return JSON.parse(saved)
      } catch {}
    }
    
    // 默认设置
    return {
      enabled: false,
      days: 14,
      clearOnClose: false,
      targets: {
        covers: true,
        playlists: false,
        errorLogs: true
      }
    }
  }
  
  /**
   * 保存自动清理设置
   */
  setAutoClearSettings(settings: AutoClearSettings) {
    localStorage.setItem(this.AUTO_CLEAR_SETTINGS_KEY, JSON.stringify(settings))
    console.log('✅ 自动清理设置已保存:', settings)
  }
  
  /**
   * 检查是否需要自动清理
   */
  checkAutoClear() {
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
    
    const daysSinceLastClear = (now - parseInt(lastClearTime)) / (1000 * 60 * 60 * 24)
    
    // 检查是否到达清理时间
    if (daysSinceLastClear >= settings.days) {
      console.log(`🗑️ 自动清理: 已超过 ${settings.days} 天，开始清理缓存...`)
      this.autoCleanCache(settings.targets)
      localStorage.setItem(this.LAST_CLEAR_TIME_KEY, String(now))
    }
  }
  
  /**
   * 自动清理缓存
   */
  private autoCleanCache(targets: AutoClearSettings['targets']) {
    let cleared = false
    
    if (targets.covers) {
      this.clearCovers()
      cleared = true
    }
    
    if (targets.playlists) {
      this.clearPlaylists()
      cleared = true
    }
    
    if (targets.errorLogs) {
      this.clearErrorLogs()
      cleared = true
    }
    
    if (cleared) {
      console.log('✅ 自动清理完成')
    }
  }
  
  /**
   * 关闭软件时清理缓存
   */
  clearOnClose() {
    const settings = this.getAutoClearSettings()
    
    if (!settings.clearOnClose) {
      return
    }
    
    console.log('🗑️ 关闭时清理缓存...')
    this.autoCleanCache(settings.targets)
  }
  
  /**
   * 获取上次清理时间
   */
  getLastClearTime(): number | null {
    const saved = localStorage.getItem(this.LAST_CLEAR_TIME_KEY)
    return saved ? parseInt(saved) : null
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
