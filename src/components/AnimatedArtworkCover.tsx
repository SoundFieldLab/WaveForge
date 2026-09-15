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
  // onError 用 ref 持有：调用方常传内联箭头函数，若进依赖数组会导致
  // 父组件每次重渲染都销毁重建 HLS 引擎（封面闪烁、播放永远卡在首帧）。
  const onErrorRef = useRef(onError)

  useEffect(() => {
    onErrorRef.current = onError
  })

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
      onErrorRef.current?.()
    }
    const playWhenActive = () => {
      // play() 的偶发 rejection（src 交换窗口期等）不应永久判死整个封面；
      // 致命问题由 Hls ERROR 事件与 video 元素 onError 兜底（与 DynamicCover 行为一致）。
      if (!cancelled && activeRef.current) void video.play().catch(() => undefined)
    }

    if (!isHlsSource(videoUrl)) {
      video.src = videoUrl
      playWhenActive()
    } else {
      // ⚠️ 不要走 canPlayType 原生 HLS 捷径：新版 Chromium 对 vnd.apple.mpegurl
      // 返回 "maybe" 但实际不解复用，直接 src=m3u8 必然 MEDIA_ERR_SRC_NOT_SUPPORTED。
      // 一律 hls.js（MSE）——与验证可用的 DynamicCover 一致；仅真无 MSE 时才直连兜底。
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

    return () => {
      cancelled = true
      engine?.destroy()
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [videoUrl])

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
