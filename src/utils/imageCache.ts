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
  // cleanup() 是 O(n) 全表扫描（上限 800 条），而 set() 会随每次新封面加载被调用；
  // 图床 URL 内容寻址、条目几乎不会自然过期，逐次全扫收益极低，改为每 64 次写入摊销一次。
  private readonly cleanupEveryWrites = 64
  private writesSinceCleanup = 0

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
    this.writesSinceCleanup += 1
    if (this.writesSinceCleanup >= this.cleanupEveryWrites) {
      this.writesSinceCleanup = 0
      this.cleanup()
    }
    const previous = this.cache.get(originalUrl)
    this.cache.delete(originalUrl)
    if (previous?.proxyUrl !== proxyUrl) releaseEntry(previous)
    this.cache.set(originalUrl, {
      proxyUrl,
      loadedAt: Date.now()
    })
    // 超限淘汰：必须与 get()/clear() 一样调用 releaseEntry，否则被淘汰的 blob: 条目
    // 不会 revokeObjectURL —— 底层 Blob（解码后的封面，通常数百 KB）会一直驻留到
    // 页面销毁，长时间浏览会持续累积。
    while (this.cache.size > this.maxEntries) {
      const oldestKey = this.cache.keys().next().value
      if (typeof oldestKey !== 'string') break
      releaseEntry(this.cache.get(oldestKey))
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
