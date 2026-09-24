import { imageCache } from '../utils/imageCache'
import { indexedDBCache } from './indexedDBCache'
import { getApiBase } from './apiConfig'
import { resolveArtworkUrl, unwrapArtworkSource, getArtworkRoleSize, getArtworkSizeBucket, type ArtworkPriority, type ResolveArtworkOptions } from './artwork'

import type { MusicPlatform } from './platforms'

export interface ArtworkLoadOptions extends ResolveArtworkOptions {
  platform?: MusicPlatform
  priority?: ArtworkPriority
  retries?: number
}

const pendingLoads = new Map<string, Promise<string>>()
const pendingControllers = new Map<string, AbortController>()
const failedLoads = new Map<string, number>()
const FAILURE_TTL_MS = 15_000
const MAX_FAILED_LOADS = 256
const RETRY_DELAY_MS = 150
let artworkEpoch = 0
const epochListeners = new Set<() => void>()

function publishArtworkEpoch(): void {
  artworkEpoch += 1
  epochListeners.forEach(listener => listener())
}

export function getArtworkEpoch(): number {
  return artworkEpoch
}

export function subscribeArtworkEpoch(listener: () => void): () => void {
  epochListeners.add(listener)
  return () => epochListeners.delete(listener)
}

export function clearArtworkFailures(): void {
  failedLoads.clear()
  publishArtworkEpoch()
}

function rememberFailure(url: string): void {
  failedLoads.delete(url)
  failedLoads.set(url, Date.now())
  while (failedLoads.size > MAX_FAILED_LOADS) {
    const oldest = failedLoads.keys().next().value
    if (typeof oldest !== 'string') break
    failedLoads.delete(oldest)
  }
}

function loadDecoded(url: string, priority: ArtworkPriority, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.fetchPriority = priority === 'critical' ? 'high' : priority === 'deferred' ? 'low' : 'auto'
    let settled = false
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', abort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const abort = () => {
      finish(() => {
        image.src = ''
        reject(signal.reason || new DOMException('Artwork request aborted', 'AbortError'))
      })
    }
    signal.addEventListener('abort', abort, { once: true })
    image.onload = () => {
      const decoded = typeof image.decode === 'function' ? image.decode().catch(() => undefined) : Promise.resolve()
      void decoded.then(() => finish(() => {
        image.src = ''
        resolve(url)
      }))
    }
    image.onerror = () => finish(() => {
      image.src = ''
      reject(new Error('Artwork failed to load'))
    })
    image.src = url
  })
}

export function getArtworkCacheKey(input: string, options: ArtworkLoadOptions = {}): string | null {
  const source = unwrapArtworkSource(input)
  if (!/^https?:\/\//i.test(source)) return null
  let detected: string | null = null
  try {
    const host = new URL(source).hostname
    // 主机识别口径必须与 artwork.ts 的 resizeArtworkSource 一致（含 music.163.com），
    // 否则 music.163.com 的封面会被正确改尺寸、却在缓存键里落成 unknown 命名空间。
    if (/(^|\.)(music\.126\.net|music\.163\.com)$/i.test(host)) detected = 'netease'
    else if (/(^|\.)(y\.gtimg\.cn|qqmusic\.qq\.com)$/i.test(host)) detected = 'qq'
    else if (/(^|\.)(mzstatic\.com|apple\.com)$/i.test(host)) detected = 'apple'
    else if (/(^|\.)(kugou\.com|kgimg\.com)$/i.test(host)) detected = 'kugou'
  } catch {
    return null
  }
  const platform = options.platform || detected || 'unknown'
  const rendition = options.size ? getArtworkSizeBucket(options.size) : getArtworkRoleSize(options.role || 'player', options.cssPixels, options.dpr)
  return `artwork:v1:${platform}:${rendition}:${source}`
}

/**
 * 取色器（useColorThief/extractDominantColor）专用的持久化键。
 *
 * 取色路径拿到的是播放页封面地址 `currentTrack.coverUrl`，而它已经是
 * `resolveArtworkUrl(raw, { size: 500 })` 包装过的代理 URL。若直接拿该 URL 当
 * IndexedDB 键，会和 artworkLoader 按「原始地址」写的 `artwork:v1:...` 键分裂成
 * 两条记录：同一张封面在 500 条 / 256MB 的封面配额里占两份，且取色还要为它
 * 额外下载一遍（artworkLoader 已下载过一次）。
 *
 * 这里先归一化回原始地址、按同一 rendition 档位推导键，两种入口因此收敛到同一条记录。
 * 档位取 512（播放页封面档），与 CachedImage(role="player", size={512}) 一致。
 */
const COLOR_THIEF_ARTWORK_OPTIONS = { role: 'player', size: 512 } as const

export function getColorThiefArtworkKey(input: string): string | null {
  const resolved = resolveArtworkUrl(input, COLOR_THIEF_ARTWORK_OPTIONS)
  if (!resolved) return null
  return getArtworkCacheKey(resolved, COLOR_THIEF_ARTWORK_OPTIONS)
}

export function getResolvedArtworkUrl(src: string, options: ResolveArtworkOptions = {}): string {
  return resolveArtworkUrl(src, options) || src
}

export function preloadArtwork(src: string, options: ArtworkLoadOptions = {}): Promise<string> {
  const url = getResolvedArtworkUrl(src, options)
  const sourceUrl = unwrapArtworkSource(src)
  if (!url) return Promise.reject(new Error('Artwork URL is empty'))
  // 键必须按「解析后的地址」推导，不能按入参 src：
  // 调用方传入的既可能是原始地址（App 预加载），也可能是已代理的显示地址
  // （CachedImage 传 normalizedSrc），两者指向同一张图。只有先归一到解析结果，
  // 才能让预加载、渲染、取色三条路径命中同一条缓存记录；
  // 对已解析地址重复解析是幂等的（unwrapArtworkSource 会剥掉包装）。
  const cacheKey = getArtworkCacheKey(url, options)
  const memoryKey = cacheKey || url
  const cached = imageCache.get(memoryKey)
  if (cached) return Promise.resolve(cached)
  const failedAt = failedLoads.get(memoryKey) || 0
  if (Date.now() - failedAt < FAILURE_TTL_MS) return Promise.reject(new Error('Artwork is temporarily unavailable'))
  const existing = pendingLoads.get(memoryKey)
  if (existing) return existing

  const priority = options.priority || 'visible'
  const defaultRetries = priority === 'deferred' ? 0 : 1
  const attempts = Math.max(1, Math.min(2, (options.retries ?? defaultRetries) + 1))
  const startedAtEpoch = artworkEpoch
  const controller = new AbortController()
  const task = (async () => {
    let lastError: unknown
    try {
      const persisted = cacheKey ? await indexedDBCache.getCoverBlob(cacheKey) : null
      if (persisted) {
        const objectUrl = URL.createObjectURL(persisted)
        try {
          await loadDecoded(objectUrl, priority, controller.signal)
          if (startedAtEpoch === artworkEpoch) {
            imageCache.set(memoryKey, objectUrl)
            failedLoads.delete(memoryKey)
            return objectUrl
          }
          URL.revokeObjectURL(objectUrl)
        } catch (error) {
          URL.revokeObjectURL(objectUrl)
          throw error
        }
      }
    } catch {
      // IndexedDB or object URL failures fall back to the network path.
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        let loaded: string
        try {
          loaded = await loadDecoded(url, priority, controller.signal)
        } catch (proxyError) {
          if (controller.signal.aborted || !/^https?:\/\//i.test(sourceUrl) || sourceUrl === url) throw proxyError
          loaded = await loadDecoded(sourceUrl, priority, controller.signal)
        }
        if (startedAtEpoch === artworkEpoch) {
          imageCache.set(memoryKey, loaded)
          try {
            const response = await fetch(url)
            if (cacheKey && response.ok) await indexedDBCache.cacheCover(cacheKey, await response.blob())
          } catch {
            // Persistent caching is best effort and must not block display.
          }
        }
        failedLoads.delete(memoryKey)
        return loaded
      } catch (error) {
        lastError = error
        if (controller.signal.aborted) throw error
        if (attempt + 1 < attempts) await new Promise(resolve => window.setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
    if (startedAtEpoch === artworkEpoch) rememberFailure(memoryKey)
    throw lastError
  })()

  pendingControllers.set(memoryKey, controller)
  pendingLoads.set(memoryKey, task)
  void task.finally(() => {
    if (pendingLoads.get(memoryKey) === task) pendingLoads.delete(memoryKey)
    if (pendingControllers.get(memoryKey) === controller) pendingControllers.delete(memoryKey)
  }).catch(() => undefined)
  return task
}

function abortPendingArtworkLoads(): void {
  pendingControllers.forEach(controller => controller.abort())
  pendingControllers.clear()
  pendingLoads.clear()
}

export function refreshArtworkAfterAuthChange(): void {
  abortPendingArtworkLoads()
  failedLoads.clear()
  publishArtworkEpoch()
}

export function clearArtworkMemoryCache(): void {
  abortPendingArtworkLoads()
  failedLoads.clear()
  imageCache.clear()
  publishArtworkEpoch()
}

/**
 * 清空后端（3001）图片代理进程内的 LRU 缓存。
 *
 * 该缓存有 128MB 上限、6 小时 TTL，此前没有任何前端清理入口——用户在设置里
 * 「清理所有缓存」后，代理仍会直接回放旧封面。失败时静默降级：清理属于尽力而为，
 * 缓存会按 TTL 自行过期，不该因此让整个清理流程报错。
 */
export async function clearBackendImageCache(): Promise<void> {
  try {
    const response = await fetch(`${getApiBase()}/cache/image/clear`, { method: 'POST' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch {
    // 后端未运行/旧版本时忽略：本地缓存已清，代理缓存会随 TTL 过期
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', refreshArtworkAfterAuthChange)
  window.addEventListener('online', clearArtworkFailures)
}
