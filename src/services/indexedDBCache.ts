import type { MusicPlatform } from './platforms'
const DB_NAME = 'WaveForgeCache'
const DB_VERSION = 2
const COVER_STORE = 'covers'
const PLAYLIST_STORE = 'playlists'
const LYRICS_STORE = 'lyrics'
const METADATA_STORE = 'metadata'

const DAY = 24 * 60 * 60 * 1000
const COVER_TTL = 30 * DAY
const PLAYLIST_TTL = 60 * 60 * 1000
const LYRICS_TTL = 30 * DAY
// 缓存上限按 TV 性能模式动态取值（TV 存储小严格限制；PC 维持原值）
import { getCacheLimits } from '../tv/perfMode'
const limits = getCacheLimits
const MAX_COVERS = () => limits().coverCount
const MAX_COVER_BYTES = () => limits().idbCoverBytes
const MAX_PLAYLISTS = () => limits().playlistCount
const MAX_PLAYLIST_BYTES = () => limits().playlistBytes
const MAX_LYRICS = () => limits().lyricCount
const MAX_LYRICS_BYTES = () => limits().lyricBytes

interface CoverCacheItem {
  url: string
  data: Blob
  timestamp: number
  size: number
  accessCount: number
  lastAccess: number
}

interface DataCacheItem {
  id: string
  platform: MusicPlatform
  data: unknown
  timestamp: number
  lastAccess: number
  size: number
}

export interface IndexedDBCacheStats {
  coverCount: number
  coverSize: number
  playlistCount: number
  playlistSize: number
  lyricsCount: number
  lyricsSize: number
}

function serializedSize(value: unknown): number {
  return new Blob([JSON.stringify(value)]).size
}

class IndexedDBCache {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null
  // 修剪节流：全量扫描（游标遍历 + 排序）只在节流间隔内首次触发或数量超限时执行，
  // 避免每次写入都 O(n log n) 遍历整个 store。cleanupExpired/超限时强制立即修剪。
  private readonly ENFORCE_LIMIT_INTERVAL = 60 * 1000
  private lastEnforceLimitAt: Record<string, number> = {}

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)
      request.onerror = () => { this.initPromise = null; reject(request.error) }
      request.onblocked = () => { this.initPromise = null; reject(new Error('IndexedDB 升级被其他窗口阻塞')) }
      request.onsuccess = () => {
        this.db = request.result
        this.db.onversionchange = () => this.close()
        resolve()
      }
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(COVER_STORE)) {
          const store = db.createObjectStore(COVER_STORE, { keyPath: 'url' })
          store.createIndex('lastAccess', 'lastAccess')
        }
        if (!db.objectStoreNames.contains(PLAYLIST_STORE)) db.createObjectStore(PLAYLIST_STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(LYRICS_STORE)) db.createObjectStore(LYRICS_STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE, { keyPath: 'key' })
      }
    })
    return this.initPromise
  }

  private async store(name: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    await this.init()
    if (!this.db) throw new Error('IndexedDB 尚未初始化')
    return this.db.transaction(name, mode).objectStore(name)
  }

  private request<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'))
    })
  }

  async cacheCover(url: string, blob: Blob): Promise<void> {
    url = url.trim()
    if (!url) throw new Error('封面 URL 不能为空')
    if (blob.size > 10 * 1024 * 1024) return
    const now = Date.now()
    // 去重：同一 URL 已有未过期缓存时跳过写入。切歌/并发加载对同一封面重复
    // 命中这里时直接返回，避免每次切歌都对同一封面重复执行写事务与空间修剪。
    const readStore = await this.store(COVER_STORE, 'readonly')
    const existing = await this.request(readStore.get(url)) as CoverCacheItem | undefined
    if (existing && now - Math.max(existing.timestamp, existing.lastAccess || 0) <= COVER_TTL) return
    await this.enforceLimit(COVER_STORE, MAX_COVERS() - 1, MAX_COVER_BYTES() - blob.size, COVER_TTL)
    const writeStore = await this.store(COVER_STORE, 'readwrite')
    await this.request(writeStore.put({ url, data: blob, timestamp: now, size: blob.size, accessCount: 1, lastAccess: now } as CoverCacheItem))
  }

  /**
   * 以 Blob 形式读取封面缓存。调用方应使用 URL.createObjectURL 展示，
   * 避免反复生成并长期持有 base64 DataURL 大字符串导致内存膨胀。
   */
  async getCoverBlob(url: string): Promise<Blob | null> {
    url = url.trim()
    if (!url) return null
    const readStore = await this.store(COVER_STORE, 'readonly')
    const item = await this.request(readStore.get(url)) as CoverCacheItem | undefined
    if (!item) return null
    if (Date.now() - Math.max(item.timestamp, item.lastAccess || 0) > COVER_TTL) {
      const deleteStore = await this.store(COVER_STORE, 'readwrite')
      await this.request(deleteStore.delete(url))
      return null
    }
    item.lastAccess = Date.now()
    item.accessCount = (item.accessCount || 0) + 1
    const updateStore = await this.store(COVER_STORE, 'readwrite')
    await this.request(updateStore.put(item))
    return item.data
  }

  async getCachedCover(url: string): Promise<string | null> {
    url = url.trim()
    if (!url) return null
    const blob = await this.getCoverBlob(url)
    if (!blob) return null
    return new Promise(resolve => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  }

  async cachePlaylist(id: string, platform: MusicPlatform, data: unknown): Promise<void> {
    await this.cacheData(PLAYLIST_STORE, id, platform, data, MAX_PLAYLISTS(), MAX_PLAYLIST_BYTES(), PLAYLIST_TTL)
  }

  async getCachedPlaylist<T = unknown>(id: string, platform: MusicPlatform): Promise<T | null> {
    return this.getData<T>(PLAYLIST_STORE, id, platform, PLAYLIST_TTL)
  }

  async invalidatePlaylist(id: string, platform: MusicPlatform): Promise<void> {
    const store = await this.store(PLAYLIST_STORE, 'readwrite')
    await this.request(store.delete(`${platform}_${id.trim()}`))
  }

  async cacheLyrics(id: string, platform: MusicPlatform, data: unknown): Promise<void> {
    await this.cacheData(LYRICS_STORE, id, platform, data, MAX_LYRICS(), MAX_LYRICS_BYTES(), LYRICS_TTL)
  }

  async getCachedLyrics<T = unknown>(id: string, platform: MusicPlatform): Promise<T | null> {
    return this.getData<T>(LYRICS_STORE, id, platform, LYRICS_TTL)
  }

  private async cacheData(storeName: string, id: string, platform: MusicPlatform, data: unknown, maxCount: number, maxBytes: number, ttl: number): Promise<void> {
    id = id.trim()
    if (!id) throw new Error('缓存 ID 不能为空')
    const size = serializedSize(data)
    if (size > Math.min(maxBytes, 10 * 1024 * 1024)) return
    await this.enforceLimit(storeName, maxCount - 1, maxBytes - size, ttl)
    const now = Date.now()
    const item: DataCacheItem = { id: `${platform}_${id}`, platform, data, timestamp: now, lastAccess: now, size }
    const store = await this.store(storeName, 'readwrite')
    await this.request(store.put(item))
  }

  private async getData<T>(storeName: string, id: string, platform: MusicPlatform, ttl: number): Promise<T | null> {
    id = id.trim()
    if (!id) return null
    const store = await this.store(storeName, 'readwrite')
    const key = `${platform}_${id}`
    const item = await this.request(store.get(key)) as DataCacheItem | undefined
    if (!item) return null
    if (Date.now() - Math.max(item.timestamp, item.lastAccess || 0) > ttl) {
      const deleteStore = await this.store(storeName, 'readwrite')
      await this.request(deleteStore.delete(key))
      return null
    }
    item.lastAccess = Date.now()
    const updateStore = await this.store(storeName, 'readwrite')
    await this.request(updateStore.put(item))
    return item.data as T
  }

  private async readItems(storeName: string): Promise<Array<{ key: IDBValidKey; timestamp: number; lastAccess: number; size: number }>> {
    const store = await this.store(storeName, 'readonly')
    return new Promise((resolve, reject) => {
      const items: Array<{ key: IDBValidKey; timestamp: number; lastAccess: number; size: number }> = []
      const cursor = store.openCursor()
      cursor.onerror = () => reject(cursor.error)
      cursor.onsuccess = () => {
        const current = cursor.result
        if (!current) { resolve(items); return }
        const value = current.value
        items.push({ key: current.primaryKey, timestamp: Number(value.timestamp) || 0, lastAccess: Number(value.lastAccess) || Number(value.timestamp) || 0, size: Number(value.size) || serializedSize(value.data) })
        current.continue()
      }
    })
  }

  private async enforceLimit(storeName: string, maxCount: number, maxBytes: number, ttl: number, force = false): Promise<void> {
    const now = Date.now()
    const lastRun = this.lastEnforceLimitAt[storeName] || 0
    // 节流窗口内：先用 O(1) 的 count() 快速判断。数量未超限则不执行全量扫描，
    // 避免每次 set 都遍历整个 store（游标 + JSON 反序列化 + 排序）。
    if (!force && now - lastRun < this.ENFORCE_LIMIT_INTERVAL) {
      const countStore = await this.store(storeName, 'readonly')
      const count = await this.request(countStore.count())
      if (count <= maxCount) return
    }
    this.lastEnforceLimitAt[storeName] = now
    const items = await this.readItems(storeName)
    const remove = new Set<IDBValidKey>(items.filter(item => now - Math.max(item.timestamp, item.lastAccess) > ttl).map(item => item.key))
    let remaining = items.filter(item => !remove.has(item.key)).sort((a, b) => a.lastAccess - b.lastAccess)
    let bytes = remaining.reduce((sum, item) => sum + item.size, 0)
    while (remaining.length > maxCount || bytes > maxBytes) {
      const item = remaining.shift()
      if (!item) break
      remove.add(item.key)
      bytes -= item.size
    }
    if (remove.size) {
      const store = await this.store(storeName, 'readwrite')
      await Promise.all([...remove].map(key => this.request(store.delete(key))))
    }
  }

  async cleanupExpired(): Promise<void> {
    await this.enforceLimit(COVER_STORE, MAX_COVERS(), MAX_COVER_BYTES(), COVER_TTL, true)
    await this.enforceLimit(PLAYLIST_STORE, MAX_PLAYLISTS(), MAX_PLAYLIST_BYTES(), PLAYLIST_TTL, true)
    await this.enforceLimit(LYRICS_STORE, MAX_LYRICS(), MAX_LYRICS_BYTES(), LYRICS_TTL, true)
  }

  async getCacheStats(): Promise<IndexedDBCacheStats> {
    await this.cleanupExpired()
    const [covers, playlists, lyrics] = await Promise.all([this.readItems(COVER_STORE), this.readItems(PLAYLIST_STORE), this.readItems(LYRICS_STORE)])
    const sum = (items: Array<{ size: number }>) => items.reduce((total, item) => total + item.size, 0)
    return { coverCount: covers.length, coverSize: sum(covers), playlistCount: playlists.length, playlistSize: sum(playlists), lyricsCount: lyrics.length, lyricsSize: sum(lyrics) }
  }

  private async clearStore(name: string): Promise<void> {
    const store = await this.store(name, 'readwrite')
    await this.request(store.clear())
  }

  clearCovers(): Promise<void> { return this.clearStore(COVER_STORE) }
  clearPlaylists(): Promise<void> { return this.clearStore(PLAYLIST_STORE) }
  clearLyrics(): Promise<void> { return this.clearStore(LYRICS_STORE) }
  async clearAll(): Promise<void> { await Promise.all([this.clearCovers(), this.clearPlaylists(), this.clearLyrics()]) }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.initPromise = null
  }
}

export const indexedDBCache = new IndexedDBCache()
