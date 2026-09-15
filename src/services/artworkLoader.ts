import { imageCache } from '../utils/imageCache'
import { indexedDBCache } from './indexedDBCache'
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
    if (/(^|\.)music\.126\.net$/i.test(host)) detected = 'netease'
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

export function getResolvedArtworkUrl(src: string, options: ResolveArtworkOptions = {}): string {
  return resolveArtworkUrl(src, options) || src
}

export function preloadArtwork(src: string, options: ArtworkLoadOptions = {}): Promise<string> {
  const url = getResolvedArtworkUrl(src, options)
  const sourceUrl = unwrapArtworkSource(src)
  if (!url) return Promise.reject(new Error('Artwork URL is empty'))
  const cacheKey = getArtworkCacheKey(src, options)
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

if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', refreshArtworkAfterAuthChange)
  window.addEventListener('online', clearArtworkFailures)
}
