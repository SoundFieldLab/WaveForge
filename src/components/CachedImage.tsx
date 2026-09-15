import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { imageCache } from '../utils/imageCache'
import { getArtworkEpoch, getArtworkCacheKey, getResolvedArtworkUrl, preloadArtwork, subscribeArtworkEpoch } from '../services/artworkLoader'
import type { ArtworkPriority, ArtworkRole } from '../services/artwork'
import type { MusicPlatform } from '../services/platforms'

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
  const cacheKey = useMemo(
    () => src?.trim() ? getArtworkCacheKey(src, { role, size, platform }) || normalizedSrc : '',
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
    if (!lazy || (cacheKey && imageCache.get(cacheKey)) || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true)
      return
    }
    const element = containerRef.current
    if (!element) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setIsVisible(true)
        observer.disconnect()
      }
    }, { rootMargin: '160px', threshold: 0.01 })
    observer.observe(element)
    // Electron/WebView 在复杂滚动容器或窗口刚恢复时可能不派发 intersection；
    // 不能让封面永久停留在占位符，超时后退化为主动加载。
    const fallbackTimer = window.setTimeout(() => setIsVisible(true), 800)
    return () => {
      observer.disconnect()
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
