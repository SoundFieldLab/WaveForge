/**
 * Apple Music 动态封面图层（React 版）。
 *
 * 图层叠加式设计（与 LX-TA 同思路，规避"AM 封面顶替平台封面"的历史冲突）：
 * - 动态封面可用且播放成功 → <video> 图层盖在静态封面之上（poster 用 AM 预览帧或平台封面）
 * - 无动态封面 / 播放失败 / 开关关闭 → 不渲染视频，下层的平台静态封面直接露出
 * AM 数据永远不写回封面字段，显示封面链路与本组件完全隔离。
 *
 * HLS 播放：Chromium 无原生 HLS → 懒加载 hls.js 走 MSE；缓冲压小（封面场景省内存）。
 */
import { useEffect, useRef, useState } from 'react'

interface AnimatedArtworkCoverProps {
  /** 动态封面 HLS 地址（null/空 = 不渲染视频层） */
  videoUrl: string | null
  /** AM 预览帧（poster 兜底顺序：预览帧 → 调用方传入的静态封面 → 无） */
  posterUrl?: string | null
  staticCoverUrl?: string | null
  /** 是否激活（页面可见/启用时才挂视频，节省资源） */
  active?: boolean
  className?: string
  style?: React.CSSProperties
  /** 视频加载/播放失败回调（父层可据此记录并停止重试） */
  onError?: () => void
  objectFit?: 'cover' | 'contain'
}

const isHlsSource = (source: string) => /\.m3u8(?:$|[?#])/i.test(source)

export default function AnimatedArtworkCover({
  videoUrl,
  posterUrl,
  staticCoverUrl,
  active = true,
  className,
  style,
  onError,
  objectFit = 'cover',
}: AnimatedArtworkCoverProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [failed, setFailed] = useState(false)
  // src 变化重置失败标记（换歌后允许重新尝试）
  useEffect(() => { setFailed(false) }, [videoUrl])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !active || !videoUrl || failed) return
    if (!isHlsSource(videoUrl)) {
      video.src = videoUrl
      void video.play().catch(() => { /* 静默 */ })
      return
    }
    let destroyed = false
    let engine: { destroy: () => void } | null = null
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')
    if (nativeHls) {
      video.src = videoUrl
      void video.play().catch(() => { /* 静默 */ })
      return
    }
    void import('hls.js').then(({ default: Hls }) => {
      if (destroyed || !Hls.isSupported()) {
        if (!destroyed) {
          video.src = videoUrl
          void video.play().catch(() => { /* 静默 */ })
        }
        return
      }
      const instance = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 12, backBufferLength: 0 })
      engine = instance
      instance.on(Hls.Events.ERROR, (_event: string, data: { fatal?: boolean }) => {
        if (data.fatal) {
          setFailed(true)
          onError?.()
        }
      })
      instance.on(Hls.Events.MANIFEST_PARSED, () => { void video.play().catch(() => { /* 静默 */ }) })
      instance.loadSource(videoUrl)
      instance.attachMedia(video)
    }).catch(() => { setFailed(true) })
    return () => {
      destroyed = true
      engine?.destroy()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoUrl, active, failed, onError])

  if (!active || !videoUrl || failed) return null
  return (
    <video
      ref={videoRef}
      key={videoUrl}
      className={className}
      style={{ ...style, objectFit }}
      poster={posterUrl || staticCoverUrl || undefined}
      muted
      loop
      playsInline
      autoPlay
      preload="auto"
      disablePictureInPicture
      onError={() => { setFailed(true); onError?.() }}
    />
  )
}
