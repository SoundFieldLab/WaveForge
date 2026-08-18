import { useState, useEffect, useMemo, useRef, memo } from 'react'
import { imageCache } from '../utils/imageCache'
import { getProxiedImageUrl } from '../services/musicApi'

interface CachedImageProps {
  src: string
  alt: string
  className?: string
  fallback?: React.ReactNode
  onError?: (e: React.SyntheticEvent<HTMLImageElement, Event>) => void
  onLoad?: React.ReactEventHandler<HTMLImageElement>
  draggable?: boolean
  lazy?: boolean // 是否启用懒加载，默认 true
}

// 模块级共享加载去重：同一 URL 在同一时刻被多个 CachedImage 实例请求时，
// 只发起一次 Image 加载，其余实例复用同一个 Promise，避免每行重复下载封面。
type SharedLoad = Promise<string> // resolve 为已加载成功的代理 URL
const pendingImageLoads = new Map<string, SharedLoad>()

function loadImageShared(normalizedSrc: string): SharedLoad {
  const existing = pendingImageLoads.get(normalizedSrc)
  if (existing) return existing

  const load: SharedLoad = new Promise((resolve, reject) => {
    const img = new Image()
    const settle = (succeeded: boolean) => {
      // 加载完成后断开引用并释放解码图片，避免残留占用内存
      img.onload = null
      img.onerror = null
      img.src = ''
      if (succeeded) resolve(normalizedSrc)
      else reject(new Error('图片加载失败'))
    }
    img.onload = () => settle(true)
    img.onerror = () => settle(false)
    img.src = normalizedSrc
  })

  pendingImageLoads.set(normalizedSrc, load)
  // 加载结束后无论成败都从共享表移除，允许后续重新加载
  void load.then(
    () => { if (pendingImageLoads.get(normalizedSrc) === load) pendingImageLoads.delete(normalizedSrc) },
    () => { if (pendingImageLoads.get(normalizedSrc) === load) pendingImageLoads.delete(normalizedSrc) },
  )
  return load
}

/**
 * 带懒加载功能的图片组件
 * 1. 使用 IntersectionObserver 实现懒加载
 * 2. 通过代理服务器获取图片（解决跨域问题）
 * 3. 使用浏览器内存缓存，不使用 IndexedDB
 */
function CachedImage({ src, alt, className, fallback, onError, onLoad, draggable, lazy = true }: CachedImageProps) {
  const normalizedSrc = useMemo(() => {
    if (!src || src.trim() === '') return ''
    return getProxiedImageUrl(src) || src
  }, [src])
  const initialCachedSrc = normalizedSrc ? imageCache.get(normalizedSrc) || '' : ''
  const [imageSrc, setImageSrc] = useState<string>(initialCachedSrc)
  const [loading, setLoading] = useState(!initialCachedSrc)
  const [error, setError] = useState(false)
  const [isVisible, setIsVisible] = useState(!lazy)
  const cachedImageSrc = normalizedSrc ? imageCache.get(normalizedSrc) : null
  const displaySrc = normalizedSrc ? (cachedImageSrc || (imageSrc === normalizedSrc ? imageSrc : '')) : ''
  
  // 使用 ref 跟踪当前请求的 URL，避免竞态条件
  const currentLoadingUrlRef = useRef<string>('')
  // 图片容器的 ref，用于 IntersectionObserver
  const containerRef = useRef<HTMLDivElement>(null)

  // 懒加载：只在元素可见时才加载图片（可选）
  useEffect(() => {
    if (!lazy) {
      // 如果禁用懒加载，立即标记为可见
      setIsVisible(true)
      return
    }

    if (!containerRef.current) return

    // 图片已在内存缓存中（如其他列表项已加载同一封面），无需再创建 IO 实例观察
    if (normalizedSrc && imageCache.get(normalizedSrc)) {
      setIsVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            // 一旦可见就不再观察
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前50px开始加载
        threshold: 0.01
      }
    )

    observer.observe(containerRef.current)

    return () => {
      observer.disconnect()
    }
  }, [lazy, normalizedSrc])

  useEffect(() => {
    // 只有在可见时才加载图片
    if (!isVisible) return

    // 验证 URL 是否有效
    if (!normalizedSrc || normalizedSrc.trim() === '') {
      setImageSrc('') // 清空旧图片
      setLoading(false)
      setError(true)
      return
    }

    // 跳过无效的 QQ 音乐封面 URL（包含 M000.jpg 的是无效 URL）
    if (normalizedSrc.includes('M000.jpg') || normalizedSrc.endsWith('M000.jpg')) {
      setImageSrc('') // 清空旧图片
      setLoading(false)
      setError(true)
      return
    }

    const loadImage = async () => {
      // 标记当前正在加载的 URL
      currentLoadingUrlRef.current = normalizedSrc
      setError(false)

      try {
        // 先检查缓存
        const cachedUrl = imageCache.get(normalizedSrc)
        if (cachedUrl) {
          // 检查是否还是当前请求
          if (currentLoadingUrlRef.current !== normalizedSrc) return
          
          // 缓存命中 - 立即显示，不设置 loading 状态
          setImageSrc(cachedUrl)
          setLoading(false)
          return
        }

        // 缓存未命中 - 立即清空旧图片，避免显示错误的封面
        if (!lazy) {
          // 对于非懒加载的图片（如播放器封面），立即清空
          setImageSrc('')
        }
        setLoading(true)

        // src 已经是代理后的 URL，直接使用
        const imageUrl = normalizedSrc

        // 共享加载：同一 URL 并发请求时只发一次网络请求，完成后所有实例同时显示
        await loadImageShared(normalizedSrc)

        // 检查是否还是当前请求（防止竞态条件）
        if (currentLoadingUrlRef.current !== normalizedSrc) return

        // 缓存这个 URL
        imageCache.set(normalizedSrc, imageUrl)
        // 图片加载完成后才更新显示
        setImageSrc(imageUrl)
        setLoading(false)
      } catch (error) {
        if (currentLoadingUrlRef.current !== normalizedSrc) return
        console.error('❌ 加载图片失败:', normalizedSrc)
        setImageSrc('') // 加载失败时才清空
        setError(true)
        setLoading(false)
      }
    }

    void loadImage()
  }, [normalizedSrc, isVisible, lazy])

  const handleError = (e: React.SyntheticEvent<HTMLImageElement, Event>) => {
    setError(true)
    if (onError) {
      onError(e)
    }
  }

  // 如果出错且没有图片，显示 fallback
  if (error && !displaySrc && fallback) {
    return <div ref={containerRef}>{fallback}</div>
  }

  // 如果正在加载且还没有图片，显示 fallback（如果有）或占位符
  if (loading && !displaySrc) {
    if (fallback) {
      return <div ref={containerRef}>{fallback}</div>
    }
    return (
      <div ref={containerRef} className={className}>
        <div className="w-full h-full flex items-center justify-center bg-white/10">
          {/* 加载占位 */}
        </div>
      </div>
    )
  }

  // 如果 displaySrc 为空，显示 fallback 或占位符
  if (!displaySrc || displaySrc.trim() === '') {
    if (fallback) {
      return <div ref={containerRef}>{fallback}</div>
    }
    return (
      <div ref={containerRef} className={className}>
        <div className="w-full h-full flex items-center justify-center bg-white/10">
          {/* 空占位 */}
        </div>
      </div>
    )
  }

  return (
    <div ref={containerRef} className={`${className} overflow-hidden`}>
      <img
        draggable={draggable}
        onLoad={onLoad}
        src={displaySrc}
        alt={alt}
        loading={lazy ? 'lazy' : 'eager'}
        decoding="async"
        className="w-full h-full object-cover"
        onError={handleError}
        style={{
          opacity: 1,
          transition: 'opacity 0.2s ease-in-out'
        }}
      />
    </div>
  )
}

export default memo(CachedImage)