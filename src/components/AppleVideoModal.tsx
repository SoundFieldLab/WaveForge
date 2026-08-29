/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 音乐视频播放弹窗（站内直播，Cider 同款链路）
 *
 * 取流：webPlayback POST（MusicKit 对 music-videos 的播放路径与歌曲一致，
 * 传 salableAdamId=视频 id）；响应含视频 HLS 主清单 + Widevine EME keyURLs。
 * 播放：hls.js 挂到 <video>（attachAppleHls 已适配 HTMLMediaElement），
 * 复用与歌曲/电台完全相同的 EME license 协议（createAppleHlsConfig）。
 */
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, X, Play } from 'lucide-react'
import { resolveAppleNativeStream } from '../services/applePlayback'
import { attachAppleHls, detachAppleHls } from '../services/appleHlsPlayer'
import type { AppleWebItem } from '../services/appleWebService'

interface AppleVideoModalProps {
  item: AppleWebItem
  onClose: () => void
}

export default function AppleVideoModal({ item, onClose }: AppleVideoModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<'loading' | 'playing' | 'error'>('loading')
  const [error, setError] = useState('')
  const [manualPaused, setManualPaused] = useState(false)

  useEffect(() => {
    let cancelled = false
    setState('loading')
    setError('')
    ;(async () => {
      try {
        const stream = await resolveAppleNativeStream(item.playId || item.id)
        if (cancelled || !stream || !videoRef.current) {
          if (!cancelled && !stream) throw new Error('视频取流失败（可能需要订阅 Apple Music）')
          return
        }
        await attachAppleHls(videoRef.current, stream)
        if (cancelled) return
        try {
          await videoRef.current.play()
        } catch (autoplayError) {
          // 浏览器拦截自动播放（NotAllowedError）：保留原生控制条，用户可手动播放
          if (!(autoplayError instanceof Error && autoplayError.name === 'NotAllowedError')) throw autoplayError
        }
        if (cancelled) return
        setState('playing')
      } catch (playError) {
        if (cancelled) return
        setState('error')
        setError(playError instanceof Error ? playError.message : '视频播放失败')
      }
    })()
    return () => {
      cancelled = true
      detachAppleHls(videoRef.current)
    }
  }, [item])

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[180] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md md:p-10"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.96, opacity: 0 }}
          onClick={(event) => event.stopPropagation()}
          className="w-full max-w-4xl overflow-hidden rounded-2xl border border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
        >
          <div className="relative aspect-video w-full bg-black">
            <video
              ref={videoRef}
              controls
              autoPlay
              playsInline
              className="h-full w-full"
              onPause={() => setManualPaused(true)}
              onPlay={() => setManualPaused(false)}
            />
            {state === 'loading' && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
                <Loader2 className="h-8 w-8 animate-spin text-white/70" />
                <p className="text-sm text-white/60">正在加载视频（含授权校验）…</p>
              </div>
            )}
            {state === 'error' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 p-6 text-center">
                <p className="text-sm text-white/80">{error}</p>
                <button
                  type="button"
                  onClick={() => setState('loading')}
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
                  style={{ background: '#fa2d48', color: '#0a0f14' }}
                >
                  <Play className="h-4 w-4 fill-current" /> 重试
                </button>
              </div>
            )}
            {state === 'playing' && manualPaused && (
              <button
                type="button"
                aria-label="继续播放"
                onClick={() => { void videoRef.current?.play(); setManualPaused(false) }}
                className="absolute inset-0 flex items-center justify-center bg-black/30"
              >
                <span className="flex h-16 w-16 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur-md transition hover:bg-white/25">
                  <Play className="h-7 w-7 fill-current" />
                </span>
              </button>
            )}
          </div>
          <div className="flex items-start justify-between gap-4 p-5">
            <div className="min-w-0">
              <h3 className="truncate text-lg font-semibold">{item.name}</h3>
              <p className="mt-1 truncate text-sm text-white/50">{item.artistName || item.subtitle || 'Apple Music'}</p>
            </div>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/80 transition hover:bg-white/[0.16]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
