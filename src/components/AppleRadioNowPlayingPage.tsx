import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import { ArrowLeft, Pause, Play, Radio, RotateCw, Volume2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import CachedImage from './CachedImage'

type Props = {
  song: Song
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playerTheme: 'light' | 'dark'
  status?: 'connecting' | 'playing' | 'reconnecting' | 'error'
  error?: string
  onBack: () => void
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onRetry: () => void
}

export default function AppleRadioNowPlayingPage({
  song,
  isPlaying,
  currentTime,
  duration,
  volume,
  playerTheme,
  status = 'playing',
  error,
  onBack,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onRetry,
}: Props) {
  const radio = song.appleRadio
  const motionRef = useRef<HTMLVideoElement | null>(null)
  const [motionFailed, setMotionFailed] = useState(false)
  const [motionEnabled] = useState(() => !(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false))
  const motionUrl = radio?.motionArtworkUrl
  const poster = radio?.motionPosterUrl || radio?.heroArtworkUrl || radio?.artworkUrl || song.album.picUrl
  const timeline = radio?.timeline || 'unknown'
  const isLive = timeline !== 'vod'
  const isDark = playerTheme === 'dark'

  useEffect(() => {
    const video = motionRef.current
    if (!video || !motionUrl || !motionEnabled || motionFailed || !Hls.isSupported()) return
    const hls = new Hls({ autoStartLoad: true, capLevelToPlayerSize: true, maxBufferLength: 8, backBufferLength: 0 })
    hls.loadSource(motionUrl)
    hls.attachMedia(video)
    hls.on(Hls.Events.MANIFEST_PARSED, () => { if (!document.hidden) void video.play().catch(() => undefined) })
    hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) setMotionFailed(true) })
    const onVisibilityChange = () => {
      if (document.hidden) video.pause()
      else void video.play().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      hls.destroy()
    }
  }, [motionEnabled, motionFailed, motionUrl])

  const statusLabel = status === 'connecting'
    ? '正在连接'
    : status === 'reconnecting'
      ? '正在重新连接'
      : status === 'error'
        ? '播放中断'
        : isLive ? '直播' : '节目回放'

  return (
    <div className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden ${isDark ? 'bg-[#08090d] text-white' : 'bg-[#f5f5f7] text-black'}`} data-apple-radio-player>
      {poster && <CachedImage src={poster} alt="" className="absolute inset-0 h-full w-full scale-110 opacity-30 blur-3xl" role="background" priority="deferred" />}
      <div className={`absolute inset-0 ${isDark ? 'bg-black/55' : 'bg-white/70'}`} />

      <header className="relative z-10 flex h-20 shrink-0 items-center justify-between px-5 md:px-10">
        <button type="button" onClick={onBack} className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'bg-white/10 hover:bg-white/16' : 'bg-black/8 hover:bg-black/12'}`} aria-label="返回 Apple Music 广播">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[#fa2d48]"><Radio className="h-4 w-4" />Apple Music 广播</div>
        <div className="h-10 w-10" />
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 items-center gap-8 overflow-y-auto px-6 pb-24 pt-3 md:grid-cols-[minmax(280px,520px)_minmax(280px,560px)] md:justify-center md:px-12">
        <div className="mx-auto w-full max-w-[520px]">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-white/5 shadow-2xl">
            {motionUrl && motionEnabled && !motionFailed ? (
              <video ref={motionRef} muted loop playsInline poster={poster || undefined} className="h-full w-full object-cover" />
            ) : poster ? (
              <CachedImage src={poster} alt={song.name} className="h-full w-full" role="hero" priority="critical" lazy={false} />
            ) : (
              <div className="flex h-full w-full items-center justify-center"><Radio className="h-24 w-24 opacity-25" /></div>
            )}
          </div>
        </div>

        <section className="min-w-0 text-center md:text-left">
          <div className="mb-4 flex justify-center md:justify-start">
            <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold ${status === 'error' ? 'bg-red-500/15 text-red-300' : 'bg-[#fa2d48]/15 text-[#ff6b7f]'}`}>
              <span className={`h-2 w-2 rounded-full ${status === 'error' ? 'bg-red-400' : 'bg-[#fa2d48]'}`} />{statusLabel}
            </span>
          </div>
          <h1 className="text-3xl font-bold leading-tight md:text-5xl">{song.name}</h1>
          <p className={`mt-3 text-base md:text-lg ${isDark ? 'text-white/62' : 'text-black/58'}`}>{radio?.showName || song.artists.map(artist => artist.name).join(', ')}</p>
          {radio?.description && <p className={`mx-auto mt-5 max-w-xl text-sm leading-7 md:mx-0 ${isDark ? 'text-white/48' : 'text-black/48'}`}>{radio.description}</p>}
          {radio?.airTime?.start && <p className={`mt-3 text-xs ${isDark ? 'text-white/35' : 'text-black/35'}`}>{new Date(radio.airTime.start).toLocaleString('zh-CN')}</p>}

          {status === 'error' && (
            <div className="mt-6">
              <p className="text-sm text-red-300/85">{error || 'Apple Music 电台播放失败'}</p>
              <button type="button" onClick={onRetry} className="mt-3 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-black"><RotateCw className="h-4 w-4" />重新连接</button>
            </div>
          )}

          {!isLive && duration > 0 && (
            <div className="mt-8">
              <input aria-label="节目进度" type="range" min={0} max={duration} step={0.1} value={Math.min(currentTime, duration)} onChange={event => onSeek(Number(event.target.value))} className="w-full accent-[#fa2d48]" />
              <div className={`mt-1 flex justify-between text-xs ${isDark ? 'text-white/35' : 'text-black/35'}`}><span>{formatTime(currentTime)}</span><span>{formatTime(duration)}</span></div>
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-5 md:justify-start">
            <button type="button" onClick={onPlayPause} disabled={status === 'connecting' || status === 'reconnecting'} className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-xl disabled:opacity-45" aria-label={isPlaying ? '暂停电台' : '播放电台'}>
              {isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-0.5 h-6 w-6 fill-current" />}
            </button>
            <label className="flex min-w-0 items-center gap-3" aria-label="电台音量"><Volume2 className="h-5 w-5 opacity-55" /><input type="range" min={0} max={1} step={0.01} value={volume} onChange={event => onVolumeChange(Number(event.target.value))} className="w-32 accent-[#fa2d48] md:w-44" /></label>
          </div>
        </section>
      </main>
    </div>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}
