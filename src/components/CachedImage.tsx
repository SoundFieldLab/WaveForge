import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { imageCache } from '../utils/imageCache'
import { getArtworkEpoch, getArtworkCacheKey, getResolvedArtworkUrl, preloadArtwork, subscribeArtworkEpoch } from '../services/artworkLoader'
import type { ArtworkPriority, ArtworkRole } from '../services/artwork'
import type { MusicPlatform } from '../services/platforms'

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
  draggable,
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
      if (!retainPrevious) setImageSrc('')
      setError(true)
      setLoading(false)
    })
  }, [artworkEpoch, isVisible, lazy, normalizedSrc, cacheKey, platform, priority, retries, retainPrevious, role, size])

  const handleError = (event: React.SyntheticEvent<HTMLImageElement, Event>) => {
    setError(true)
    if (!retainPrevious) setImageSrc('')
    onError?.(event)
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
