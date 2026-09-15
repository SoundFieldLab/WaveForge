/**
 * 全局图片缓存管理器
 * 用于存储已经加载成功的图片 URL，避免重复加载
 */

interface ImageCacheEntry {
  proxyUrl: string // 代理后的 URL
  loadedAt: number // 加载时间戳
}

function releaseEntry(entry: ImageCacheEntry | undefined): void {
  if (entry?.proxyUrl.startsWith('blob:')) URL.revokeObjectURL(entry.proxyUrl)
}

class ImageCacheManager {
  private cache: Map<string, ImageCacheEntry> = new Map()
  // 图床 URL 是内容寻址（内容变即换 URL），条目无需按时间过期，只做容量淘汰，
  // 避免会话内反复重取导致封面闪烁与请求浪费。
  private maxAge = 1000 * 60 * 60 * 24 * 30
  private readonly maxEntries = 800

  /**
   * 获取缓存的图片 URL
   */
  get(originalUrl: string): string | null {
    const entry = this.cache.get(originalUrl)
    if (!entry) return null

    // 检查是否过期
    if (Date.now() - entry.loadedAt > this.maxAge) {
      this.cache.delete(originalUrl)
      releaseEntry(entry)
      return null
    }

    return entry.proxyUrl
  }

  /**
   * 缓存图片 URL
   */
  set(originalUrl: string, proxyUrl: string): void {
    if (!originalUrl || !proxyUrl) return
    this.cleanup()
    const previous = this.cache.get(originalUrl)
    this.cache.delete(originalUrl)
    if (previous?.proxyUrl !== proxyUrl) releaseEntry(previous)
    this.cache.set(originalUrl, {
      proxyUrl,
      loadedAt: Date.now()
    })
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      this.cache.delete(oldestKey)
    }
  }

  /**
   * 预加载图片
   * 返回 Promise，在图片加载完成后 resolve
   */
  preload(proxyUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to load image'))
      img.src = proxyUrl
    })
  }

  /**
   * 清除过期缓存
   */
  cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.loadedAt > this.maxAge) {
        this.cache.delete(key)
        releaseEntry(entry)
      }
    }
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size
  }

  clear(): void {
    this.cache.forEach(releaseEntry)
    this.cache.clear()
  }

}

// 导出单例
export const imageCache = new ImageCacheManager()
