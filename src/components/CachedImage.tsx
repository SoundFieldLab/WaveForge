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
    const fallbackTimer = window.setTimeout(reveal, 800)
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
      setPreviousImageSrc(imageSrc)
      setFadeIn(false)
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
