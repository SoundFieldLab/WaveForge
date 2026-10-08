import { memo, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { imageCache } from '../utils/imageCache'
import { getArtworkEpoch, getArtworkCacheKey, getResolvedArtworkUrl, preloadArtwork, subscribeArtworkEpoch } from '../services/artworkLoader'
import type { ArtworkPriority, ArtworkRole } from '../services/artwork'
import type { MusicPlatform } from '../services/platforms'
import { FrozenScope } from './frozenScope'

/**
 * 冻结态占位图：1×1 透明 GIF。
 *
 * 冻结的只是「已解码的大图」——把它换成 1×1 后，`<img>` 元素、DOM 结构与布局全部保留，
 * 只有那几百 KB~几 MB 的位图被释放；面板本来就不可见，视觉零变化。
 * 解冻时按 state 里的原 src 重新渲染，Chromium 从内存/磁盘缓存解码，不走网络。
 */
const FROZEN_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

// 模块级共享懒加载 observer：大列表（最近播放/歌单/探索封面墙）里数百张封面
// 若各自 new IntersectionObserver，滚动时每个 observer 都要参与交叉计算，是典型卡顿源。
// 收敛为单一 observer，所有懒加载封面注册到同一个实例，视觉效果完全不变。
// 延迟到首次真正需要时才创建：某些运行时（Electron 早期启动、测试环境注入 polyfill）
// 会在本模块加载之后才提供 IntersectionObserver，若在模块顶层直接判定会永久丢失懒加载能力。
const lazyObserverCallbacks = new WeakMap<Element, () => void>()
let sharedLazyObserver: IntersectionObserver | null = null

function getSharedLazyObserver(): IntersectionObserver | null {
  if (sharedLazyObserver) return sharedLazyObserver
  if (typeof IntersectionObserver === 'undefined') return null
  sharedLazyObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const callback = lazyObserverCallbacks.get(entry.target)
        if (callback) {
          lazyObserverCallbacks.delete(entry.target)
          callback()
        }
      }
    }
  }, { rootMargin: '160px', threshold: 0.01 })
  return sharedLazyObserver
}

/** 懒加载兜底：多久之后检查一次、检查几轮、多远才算「离视口不远」。 */
const LAZY_FALLBACK_DELAY_MS = 800
const LAZY_FALLBACK_MAX_ATTEMPTS = 6
const LAZY_FALLBACK_VIEWPORT_MARGIN = 1.2

/**
 * 元素是否在视口附近（横竖都算），用于兜底加载的判断。
 * 不可见（display:none 的冻结面板、visibility:hidden 的保活面板）一律按「不在视口」处理，
 * 等真正显示出来由 observer 触发，避免看不见的内容也去抢带宽。
 */
function isNearViewport(element: Element): boolean {
  const check = (element as Element & { checkVisibility?: (options?: { visibilityProperty?: boolean }) => boolean }).checkVisibility
  if (typeof check === 'function') {
    if (!check.call(element, { visibilityProperty: true })) return false
  } else if (element.getClientRects().length === 0) {
    // 没有 checkVisibility 且量不到盒模型：拿不到布局信息（无布局环境）时判不了远近，
    // 交给兜底放行，保住「observer 不派发也能加载」这条安全网。
    return true
  }
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return false
  const marginX = window.innerWidth * LAZY_FALLBACK_VIEWPORT_MARGIN
  const marginY = window.innerHeight * LAZY_FALLBACK_VIEWPORT_MARGIN
  return rect.bottom > -marginY && rect.top < window.innerHeight + marginY
    && rect.right > -marginX && rect.left < window.innerWidth + marginX
}

interface CachedImageProps {
  src: string
  alt: string
  className?: string
  fallback?: React.ReactNode
  onError?: (e: React.SyntheticEvent<HTMLImageElement, Event>) => void
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  draggable?: boolean
  lazy?: boolean
  role?: ArtworkRole
  size?: number
  priority?: ArtworkPriority
  retries?: number
  platform?: MusicPlatform
  retainPrevious?: boolean
  fit?: 'cover' | 'contain'
}

function CachedImage({
  src,
  alt,
  className,
  fallback,
  onError,
  onLoad,
  // 默认不可拖拽：封面在 Electron 里被拖出窗口是原生 image drag 行为（全局 CSS 也兜底禁用）
  draggable = false,
  lazy = true,
  role = 'card',
  size,
  priority,
  retries,
  platform,
  retainPrevious = false,
  fit = 'cover',
}: CachedImageProps) {
  const artworkEpoch = useSyncExternalStore(subscribeArtworkEpoch, getArtworkEpoch, getArtworkEpoch)
  // 冻结：所在面板不可见（被切走的平台面板 / 被播放页覆盖的整页）。
  // 只看这一个布尔量决定「是否释放位图」，不改动其余加载逻辑，冻结/解冻都不重建组件。
  const frozen = useContext(FrozenScope)
  const normalizedSrc = useMemo(
    () => src?.trim() ? getResolvedArtworkUrl(src, { role, size, platform }) : '',
    [platform, role, size, src],
  )
  // 缓存键必须由「解析后的地址」推导：preloadArtwork 收到的是 normalizedSrc，
  // 它内部同样按解析后地址算键。若这里用原始 src 算，两次推导出的 rendition 不同
  // （原始 src 可能未带/带有旧尺寸参数，解析后才是本次真正下载的档位），
  // 键永远对不上 → 同步命中内存缓存的快路径失效，重挂载时先闪占位符再补图。
  const cacheKey = useMemo(
    () => src?.trim() ? getArtworkCacheKey(normalizedSrc, { role, size, platform }) || normalizedSrc : '',
    [normalizedSrc, platform, role, size, src],
  )
  const cached = cacheKey ? imageCache.get(cacheKey) : null
  const [imageSrc, setImageSrc] = useState(cached || '')
  const [previousImageSrc, setPreviousImageSrc] = useState('')
  const [fadeIn, setFadeIn] = useState(false)
  const [loading, setLoading] = useState(Boolean(normalizedSrc && !cached))
  const [error, setError] = useState(!normalizedSrc)
  const [isVisible, setIsVisible] = useState(!lazy)
  const requestRef = useRef('')
  const containerRef = useRef<HTMLDivElement>(null)
  const displaySrc = imageSrc && (cacheKey
    ? imageSrc === cached || imageSrc === normalizedSrc || imageSrc.startsWith('blob:') || retainPrevious
    : retainPrevious || imageSrc === normalizedSrc)
    ? imageSrc
    : (cached || '')
  const wrapperPositionClass = /(?:^|\s)(?:absolute|fixed|sticky|static)(?:\s|$)/.test(className || '') ? '' : 'relative'

  useEffect(() => {
    const observer = getSharedLazyObserver()
    if (!lazy || (cacheKey && imageCache.get(cacheKey)) || !observer) {
      setIsVisible(true)
      return
    }
    const element = containerRef.current
    if (!element) return
    let active = true
    const reveal = () => { if (active) setIsVisible(true) }
    // 走共享 observer：只注册监听 + 回调，不重复创建 observer 实例
    lazyObserverCallbacks.set(element, reveal)
    observer.observe(element)
    // Electron/WebView 在复杂滚动容器或窗口刚恢复时可能不派发 intersection；
    // 不能让封面永久停留在占位符，超时后退化为主动加载。
    //
    // 但不能「到点就把整页封面一起放出去」：一次上百张会占满同源连接（浏览器每源 6 条），
    // 用户在看的那些封面只能排在后面——实测探索页 QQ 封面因此要等十几秒。
    // 所以兜底只在「元素确实在视口附近」时立刻加载；远端元素继续等 observer（滚动到附近会触发），
    // 最多重试若干轮后仍会强制放行，保证 observer 真坏了的极端环境下不会永远停在占位符。
    let fallbackAttempts = 0
    let fallbackTimer = 0
    const armFallback = () => {
      fallbackTimer = window.setTimeout(() => {
        if (!active) return
        const node = containerRef.current
        if (node && fallbackAttempts < LAZY_FALLBACK_MAX_ATTEMPTS && !isNearViewport(node)) {
          fallbackAttempts += 1
          armFallback()
          return
        }
        reveal()
      }, LAZY_FALLBACK_DELAY_MS)
    }
    armFallback()
    return () => {
      active = false
      lazyObserverCallbacks.delete(element)
      observer.unobserve(element)
      window.clearTimeout(fallbackTimer)
    }
  }, [lazy, normalizedSrc, cacheKey])

  useEffect(() => {
    const requestKey = `${artworkEpoch}:${normalizedSrc}`
    requestRef.current = requestKey
    if (!isVisible) return
    // 冻结期间不加载、不预取：面板不可见时的下载只会占带宽与内存。
    // frozen 进依赖：解冻后本 effect 重跑，命中 imageCache 走同步快路径恢复原图。
    if (frozen) return
    if (!normalizedSrc || normalizedSrc.includes('M000.jpg')) {
      if (!retainPrevious) setImageSrc('')
      setLoading(false)
      setError(true)
      return
    }

    const cachedUrl = cacheKey ? imageCache.get(cacheKey) : null
    if (cachedUrl) {
      setImageSrc(cachedUrl)
      setPreviousImageSrc('')
      setFadeIn(false)
      setLoading(false)
      setError(false)
      return
    }

    if (!retainPrevious) {
      // 先交给真实 img：Chromium HTTP cache 命中时可立即显示；loader 在后台
      // 负责 IndexedDB、解码、去重和重试，不把隐藏预解码变成首屏阻塞点。
      setImageSrc(normalizedSrc)
      setPreviousImageSrc('')
    } else if (imageSrc) {
      // 已有旧封面：保持旧图，等新图解码完成后交叉淡入。
      setPreviousImageSrc(imageSrc)
      setFadeIn(false)
    } else {
      // 冷加载没有任何可保留的旧图：同样先把 <img> 指到代理地址。
      // 之前这里刻意等 loader 全链（IDB→下载→解码）完成才首绘，导致 QQ/网易云/Apple
      // 这类 retainPrevious 页面冷启动时盯着占位符十几秒。
      // loader 命中 blob 时会做一次同像素的淡入替换，视觉不变。
      setImageSrc(normalizedSrc)
      setPreviousImageSrc('')
    }
    setLoading(true)
    setError(false)
    void preloadArtwork(normalizedSrc, {
      role,
      size,
      priority: priority || (lazy ? 'visible' : 'critical'),
      retries,
      platform,
    }).then(loadedUrl => {
      if (requestRef.current !== requestKey) return
      const oldUrl = retainPrevious && imageSrc && imageSrc !== loadedUrl ? imageSrc : ''
      setPreviousImageSrc(oldUrl)
      setImageSrc(loadedUrl)
      setFadeIn(Boolean(oldUrl))
      setLoading(false)
      if (oldUrl) {
        window.setTimeout(() => {
          if (requestRef.current === requestKey) setPreviousImageSrc('')
        }, 260)
      }
    }).catch(() => {
      if (requestRef.current !== requestKey) return
      // retainPrevious 只在「另有旧封面可继续显示」时保留当前图；仍指着刚失败的代理地址时清掉，
      // 让 fallback/占位符接管——否则浏览器的「破图 + alt 文本」会一直挂在页面上（fallback 分支永远走不到）。
      setImageSrc(current => (retainPrevious && current && current !== normalizedSrc ? current : ''))
      setError(true)
      setLoading(false)
    })
  }, [artworkEpoch, frozen, isVisible, lazy, normalizedSrc, cacheKey, platform, priority, retries, retainPrevious, role, size])

  const handleError = (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
    setError(true)
    setImageSrc(current => (retainPrevious && current && current !== normalizedSrc ? current : ''))
    onError?.(event)
  }

  // 冻结分支放在兜底渲染之前：只把 src 换成 1×1 透明图，释放已解码位图，
  // DOM/布局/类名与正常分支保持一致——面板不可见，视觉无差别；
  // 解冻后回到正常分支，用 state 里原有的 src 直接渲染（不闪占位符）。
  if (frozen) {
    return (
      <div ref={containerRef} className={`${className || ''} ${wrapperPositionClass} overflow-hidden`}>
        <img
          src={FROZEN_PIXEL}
          alt=""
          aria-hidden="true"
          className={`relative h-full w-full object-${fit}`}
        />
      </div>
    )
  }

  if ((error || loading) && !displaySrc && fallback) return <div ref={containerRef} className={className}>{fallback}</div>
  if (!displaySrc) {
    return (
      <div ref={containerRef} className={className}>
        <div className="w-full h-full flex items-center justify-center bg-white/10" />
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`${className || ''} ${wrapperPositionClass} overflow-hidden`}>
      {previousImageSrc && (
        <img
          draggable={draggable}
          src={previousImageSrc}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 h-full w-full object-${fit}`}
          style={{ opacity: fadeIn ? 0 : 1, transition: 'opacity 0.24s ease-in-out' }}
        />
      )}
      <img
        draggable={draggable}
        onLoad={onLoad}
        src={displaySrc}
        alt={alt}
        loading={lazy ? 'lazy' : 'eager'}
        fetchPriority={priority === 'critical' ? 'high' : priority === 'deferred' ? 'low' : 'auto'}
        decoding="async"
        className={`relative h-full w-full object-${fit}`}
        onError={handleError}
        style={{ opacity: previousImageSrc ? (fadeIn ? 1 : 0) : 1, transition: 'opacity 0.24s ease-in-out' }}
      />
    </div>
  )
}

export default memo(CachedImage)
