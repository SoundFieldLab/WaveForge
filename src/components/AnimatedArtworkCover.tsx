/**
 * Apple Music 动态封面图层（React 版）。
 *
 * 静态封面由调用方始终打底；本组件只负责叠加动态媒体。HLS 实例仅在
 * URL 变化或组件卸载时销毁，离屏、页面隐藏等 inactive 状态只暂停播放。
 */
import { useEffect, useRef, useState } from 'react'

interface AnimatedArtworkCoverProps {
  videoUrl: string | null
  posterUrl?: string | null
  staticCoverUrl?: string | null
  active?: boolean
  className?: string
  style?: React.CSSProperties
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
  const activeRef = useRef(active)

  useEffect(() => {
    activeRef.current = active
    const video = videoRef.current
    if (!video || failed || !videoUrl) return
    if (active) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [active, failed, videoUrl])

  useEffect(() => {
    setFailed(false)
    const video = videoRef.current
    if (!video || !videoUrl) return

    let cancelled = false
    let engine: { destroy: () => void } | null = null
    const fail = (stage: string) => {
      if (cancelled) return
      console.warn(`[AppleMotion] 动态封面失败 stage=${stage}`)
      setFailed(true)
      onError?.()
    }
    const playWhenActive = () => {
      if (!cancelled && activeRef.current) void video.play().catch(() => fail('play'))
    }

    if (!isHlsSource(videoUrl)) {
      video.src = videoUrl
      playWhenActive()
    } else {
      const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') || video.canPlayType('application/x-mpegURL')
      if (nativeHls) {
        video.src = videoUrl
        playWhenActive()
      } else {
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled) return
          if (!Hls.isSupported()) {
            video.src = videoUrl
            playWhenActive()
            return
          }
          const instance = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 12, backBufferLength: 0 })
          engine = instance
          instance.on(Hls.Events.ERROR, (_event: string, data: { fatal?: boolean }) => {
            if (data.fatal) fail('hls-fatal')
          })
          instance.on(Hls.Events.MANIFEST_PARSED, playWhenActive)
          instance.loadSource(videoUrl)
          instance.attachMedia(video)
        }).catch(() => fail('hls-import'))
      }
    }

    return () => {
      cancelled = true
      engine?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoUrl, onError])

  if (!videoUrl || failed) return null
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
      preload="auto"
      disablePictureInPicture
      onError={() => {
        console.warn('[AppleMotion] 动态封面失败 stage=video-element')
        setFailed(true)
        onError?.()
      }}
    />
  )
}
