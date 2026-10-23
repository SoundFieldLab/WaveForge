import { imageCache } from '../utils/imageCache'
import { indexedDBCache } from './indexedDBCache'
import { getApiBase } from './apiConfig'
import { resolveArtworkUrl, unwrapArtworkSource, getArtworkRoleSize, getArtworkSizeBucket, fallbackArtworkSources, type ArtworkPriority, type ResolveArtworkOptions } from './artwork'

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
// 缓存代次：只在真正作废缓存的事件（登录态变化、手动清缓存）上 bump。
// 失败重试的 epoch 脉冲只负责重触发加载 effect，不能作为缓存写入的门槛——
// 否则页面里有一张坏封面时，每轮重试脉冲都会把同时段加载成功的其他封面
// 判为「过期请求」而放弃写内存/IDB 缓存，反复重新下载。
let cacheGeneration = 0

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
  scheduleArtworkFailureRetry()
}

/**
 * 失败自愈：任何封面加载失败后按退避 bump 一次 artwork epoch。
 * 所有 CachedImage / epoch 订阅者会重跑加载 effect——成功条目走内存缓存短路（零成本），
 * 失败条目在 FAILURE_TTL 过期后真正重试。没有这一步， consumers 加载失败后
 * 若无 props 变化就永远停在占位符/黑底（实测播放页背景黑屏 1 分钟的根因之一）。
 * 轮次上限 3；距上一轮失败超过 5 分钟视为新一轮故障波，重新给满机会。
 */
const FAILURE_RETRY_DELAYS_MS = [5_000, 20_000, 45_000]
const FAILURE_RETRY_WAVE_RESET_MS = 300_000
let failureRetryRound = 0
let failureRetryTimer: number | null = null
let lastFailureWaveAt = 0

function scheduleArtworkFailureRetry(): void {
  if (typeof window === 'undefined') return
  const now = Date.now()
  if (now - lastFailureWaveAt > FAILURE_RETRY_WAVE_RESET_MS) failureRetryRound = 0
  lastFailureWaveAt = now
  if (failureRetryRound >= FAILURE_RETRY_DELAYS_MS.length) return
  if (failureRetryTimer !== null) return
  const delay = FAILURE_RETRY_DELAYS_MS[failureRetryRound]
  failureRetryRound += 1
  failureRetryTimer = window.setTimeout(() => {
    failureRetryTimer = null
    publishArtworkEpoch()
  }, delay)
}

/** 封面加载硬超时：本地代理高峰/并发挤压时 Image 可能长时间无响应，没有超时
 *  会把 pendingLoads 去重键上的所有后续调用（含组件退避重试）挂在同一条死链上永不返回。 */
const LOAD_TIMEOUT_MS = 10_000

function loadDecoded(url: string, priority: ArtworkPriority, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.fetchPriority = priority === 'critical' ? 'high' : priority === 'deferred' ? 'low' : 'auto'
    let settled = false
    let timer: number | null = null
    const cleanup = () => {
      image.onload = null
      image.onerror = null
      signal.removeEventListener('abort', abort)
      if (timer !== null) window.clearTimeout(timer)
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
    timer = window.setTimeout(() => {
      finish(() => {
        image.src = ''
        reject(new Error('Artwork load timed out'))
      })
    }, LOAD_TIMEOUT_MS)
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
  const priority = options.priority || 'visible'
  // critical 优先级豁免失败 TTL：切歌/进播放页是用户正盯着等的那张图，
  // 早期一次失败（服务预热/瞬时限流）不应把这次加载秒拒成「再等 4s 退避」——
  // 没有豁免时切歌后的首屏背景会持续显示上一曲画面（实测残留 4-6s）。
  const failedAt = failedLoads.get(memoryKey) || 0
  if (priority !== 'critical' && Date.now() - failedAt < FAILURE_TTL_MS) return Promise.reject(new Error('Artwork is temporarily unavailable'))
  const existing = pendingLoads.get(memoryKey)
  if (existing) return existing

  const defaultRetries = priority === 'deferred' ? 0 : 1
  const attempts = Math.max(1, Math.min(2, (options.retries ?? defaultRetries) + 1))

  // 缓存写入的代次快照：只在登录态变化/清缓存时作废在途写入；
  // 失败重试的 epoch 脉冲不在此列（见 cacheGeneration 注释）。
  const startedAtGeneration = cacheGeneration
  const controller = new AbortController()
  const task = (async () => {
    let lastError: unknown
    try {
      const persisted = cacheKey ? await indexedDBCache.getCoverBlob(cacheKey) : null
      if (persisted) {
        const objectUrl = URL.createObjectURL(persisted)
        try {
          await loadDecoded(objectUrl, priority, controller.signal)
          if (startedAtGeneration === cacheGeneration) {
            imageCache.set(memoryKey, objectUrl)
            failedLoads.delete(memoryKey)
            return objectUrl
          }
          URL.revokeObjectURL(objectUrl)
        } catch (error) {
          URL.revokeObjectURL(objectUrl)
          // blob 解码失败 = 缓存条目损坏：删掉它，否则 cacheCover 看到未过期条目会跳过
          // 重写，坏 blob 粘到 30 天 TTL——此后每次加载都白读 IDB、解码失败再落回网络。
          try {
            if (cacheKey) await indexedDBCache.deleteCover(cacheKey)
          } catch {
            // 清理失败不影响网络回退路径
          }
          throw error
        }
      }
    } catch {
      // IndexedDB or object URL failures fall back to the network path.
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let loaded: string | null = null
      let loadedFromUrl: string = url
      try {
        loaded = await loadDecoded(url, priority, controller.signal)
      } catch (renditionError) {
        lastError = renditionError
        if (controller.signal.aborted) throw renditionError
        // 档位 404 降档兜底：网易 param 档位可能大于原图（部分封面 1024 档 404，
        // 同 param 直连也一样 404）；QQ 部分专辑未生成 R800。逐级降档总有一档可用。
        const fallbackSources = fallbackArtworkSources(sourceUrl)
        for (const fallbackSource of fallbackSources) {
          if (controller.signal.aborted) throw renditionError
          const fallbackUrl = `${getApiBase()}/cover?url=${encodeURIComponent(fallbackSource)}`
          if (fallbackUrl === url) continue
          try {
            loaded = await loadDecoded(fallbackUrl, priority, controller.signal)
            loadedFromUrl = fallbackUrl
            break
          } catch {
            // 下一档候选
          }
        }
        if (loaded === null) {
          // 无降档候选或全部失败：回退到未代理的源地址（历史上存在的直连兜底）
          if (!/^https?:\/\//i.test(sourceUrl) || sourceUrl === url) throw renditionError
          // 直连兜底包独立 try：失败时恢复原错误走正常 attempt 重试与 rememberFailure，
          // 否则裸 throw 会逃出 for 循环（不重试、不记失败，永久失效封面每帧重跑全链路）
          try {
            loaded = await loadDecoded(sourceUrl, priority, controller.signal)
            loadedFromUrl = sourceUrl
          } catch {
            throw renditionError
          }
        }
      }
      if (loaded === null) throw new Error('Artwork failed to load')
      if (startedAtGeneration === cacheGeneration) imageCache.set(memoryKey, loaded)
      // 持久化单独包 try：它属 best effort，失败绝不能把已加载成功的图片拖进重试循环
      //（fall through 到下一 attempt 会把同一张封面再下载一遍）
      try {
        if (startedAtGeneration === cacheGeneration) {
          // cache: 'force-cache'：HTTP 缓存里已有这张图（刚被 Image 加载过）时直接取缓存 blob，
          // 避免为持久化把同一张封面再从网络完整下载一遍（封面墙/预取场景流量翻倍）。
          // 超时 + 受 controller 控制：此 await 在 return loaded 之前，挂起会卡住 preloadArtwork
          // 的 promise，pendingLoads 去重会让等同一封面的所有调用方一起卡死
          //
          // 必须取「实际加载成功的地址」：主档位 404 后经降档/直连成功时，原主档位
          // URL 在 HTTP 缓存里是失败响应，fetch 它 response.ok=false 会跳过持久化——
          // 降档封面因此永远进不了 IDB，每次会话都重跑整条降档链。
          const response = await fetch(loadedFromUrl, { cache: 'force-cache', priority: 'low', signal: controller.signal })
          if (cacheKey && response.ok) await indexedDBCache.cacheCover(cacheKey, await response.blob())
        }
      } catch {
        // Persistent caching is best effort and must not block display.
      }
      failedLoads.delete(memoryKey)
      return loaded
    }
    if (startedAtGeneration === cacheGeneration) rememberFailure(memoryKey)
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
  cacheGeneration += 1
  publishArtworkEpoch()
}

export function clearArtworkMemoryCache(): void {
  abortPendingArtworkLoads()
  failedLoads.clear()
  imageCache.clear()
  cacheGeneration += 1
  publishArtworkEpoch()
}

// 服务端缓存清理（图片代理 / 歌词 / 汽水解密）已迁到 services/serverCacheAdmin.ts：
// 那些缓存与封面无关，放在本文件里语义不符，且新增的「清理全部」需要一并触达。

if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', refreshArtworkAfterAuthChange)
  window.addEventListener('online', clearArtworkFailures)
}
