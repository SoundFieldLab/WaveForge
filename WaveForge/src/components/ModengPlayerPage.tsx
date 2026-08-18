import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Languages,
  MessageCircle,
  MoreHorizontal,
  Music,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import { hasTrueWordTiming, prepareLyricWords } from '../utils/lyricWordTiming'
import { getAgentTintColor, getAppleMusicSettings } from '../services/appleMusic'
import AppleCoverFx from './AppleCoverFx'

const hexToRgba = (hex: string, alpha: number) => {
  const match = hex.match(/^#([\da-f]{6})$/i)?.[1]
  if (!match) return hex
  const red = Number.parseInt(match.slice(0, 2), 16)
  const green = Number.parseInt(match.slice(2, 4), 16)
  const blue = Number.parseInt(match.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

interface ModengPlayerPageProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  playerTheme: 'dark' | 'light'
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  /** Apple Music 命中的高清封面（优先显示 + 启用律动粒子动效） */
  appleCoverUrl?: string
  trackId?: string | number
  translationEnabled?: boolean
  romanEnabled?: boolean
  isTransitioning?: boolean
  onSeek?: (time: number) => void
  onPlayPause?: () => void
  onPrevious?: () => void
  onNext?: () => void
  volume?: number
  onVolumeChange?: (volume: number) => void
  playMode?: 'sequential' | 'shuffle' | 'repeat'
  onPlayModeChange?: (mode: 'sequential' | 'shuffle' | 'repeat') => void
  duration?: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 非当前行：距离当前行越远越淡、越糊（对照真实截图标定）
const LINE_FADE = [0.6, 0.5, 0.42, 0.34, 0.28, 0.22, 0.17]
const LINE_BLUR = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5]

const FONT_STACK =
  "-apple-system, 'SF Pro Display', 'PingFang SC', 'PingFang TC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"

interface SizedWord {
  text: string
  startTime: number // 绝对秒
  endTime: number
  whitespace: boolean
}

const buildLineWords = (line: LyricLine): SizedWord[] => {
  if (!hasTrueWordTiming(line)) return []
  return prepareLyricWords(line).map(word => {
    const whitespace = /^\s+$/u.test(word.word)
    const start = line.time + Math.max(0, word.startTime) / 1000
    return {
      text: word.word,
      startTime: start,
      endTime: whitespace ? start : start + Math.max(0.001, word.duration) / 1000,
      whitespace,
    }
  })
}

export default function ModengPlayerPage({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  playerTheme,
  songTitle,
  songArtist,
  coverUrl,
  appleCoverUrl,
  isTransitioning,
  onSeek,
  onPlayPause,
  onPrevious,
  onNext,
  volume = 1,
  onVolumeChange,
  playMode = 'sequential',
  onPlayModeChange,
  duration = 0,
}: ModengPlayerPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 1312, height: 951 })

  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 基准画布 1312×951（LyricsBlossom 真实窗口尺寸），整体等比缩放
  const s = size.height / 951
  const dark = playerTheme !== 'light'

  const lineH = 94 * s
  const currentY = size.height * 0.383
  const leftPad = 52 * s
  const coverSize = 476 * s
  const rightX = Math.max(size.width * 0.49, leftPad + coverSize + 60 * s)

  const lineWords = useMemo(() => lyrics.map(buildLineWords), [lyrics])

  // 对唱歌词：演唱者数量 ≥2 时按 ttm:agent 着色（Apple 风格）
  const appleAgentCount = useMemo(
    () => new Set(lyrics.map(line => line.agent).filter(Boolean)).size,
    [lyrics],
  )
  const appleDuetColorsEnabled = useMemo(() => getAppleMusicSettings().duetColors, [])
  const agentTintOf = (agent: string | undefined) =>
    appleDuetColorsEnabled && appleAgentCount >= 2 && agent
      ? getAgentTintColor(agent, appleAgentCount, dark)
      : undefined
  /** 非当前行颜色：对唱行带演唱者色相 */
  const duetLineColor = (agent: string | undefined, fade: number) => {
    const tint = agentTintOf(agent)
    return tint ? hexToRgba(tint, fade) : undefined
  }
  /** 当前行未唱色：对唱行带演唱者色相（弱化） */
  const duetUnsungColor = (agent: string | undefined) => {
    const tint = agentTintOf(agent)
    return tint ? hexToRgba(tint, dark ? 0.5 : 0.42) : undefined
  }

  // 逐词混色端点（逆向 mixColor：ARGB 逐通道插值的 Web 等价；对唱行从演唱者色向白/黑插值）
  const parseRgba = (color: string): { r: number; g: number; b: number; a: number } => {
    const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
    if (!match) return { r: 255, g: 255, b: 255, a: 1 }
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    }
  }
  const unsungColor = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.38)'
  const mixWordColor = (t: number, agent?: string) => {
    const tint = duetUnsungColor(agent)
    if (!tint) {
      return dark
        ? `rgba(255,255,255,${(0.45 + 0.55 * t).toFixed(3)})`
        : `rgba(0,0,0,${(0.38 + 0.54 * t).toFixed(3)})`
    }
    const from = parseRgba(tint)
    const to = dark ? { r: 255, g: 255, b: 255, a: 1 } : { r: 12, g: 12, b: 16, a: 0.92 }
    const channel = (start: number, end: number) => Math.round(start + (end - start) * t)
    return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${(from.a + (to.a - from.a) * t).toFixed(3)})`
  }

  // ---- 时间驱动：rAF 推进逐词混色 / 进度条 / 时间标签 ----
  const wordColorRefs = useRef(new Map<string, HTMLSpanElement>())
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const elapsedRef = useRef<HTMLSpanElement | null>(null)
  const remainRef = useRef<HTMLSpanElement | null>(null)
  const durationRef = useRef(duration)
  durationRef.current = duration

  useEffect(() => {
    let raf = 0
    let anchorTime = 0
    let anchorWall = performance.now()
    let playing = false

    const paint = (now: number) => {
      const t = now + timeOffset
      const line = lyrics[currentIndex]
      if (line) {
        const words = lineWords[currentIndex] || []
        if (words.length > 0) {
          words.forEach((word, wordIndex) => {
            if (word.whitespace) return
            const el = wordColorRefs.current.get(`w${currentIndex}-${wordIndex}`)
            if (!el) return
            const span = Math.max(0.001, word.endTime - word.startTime)
            el.style.color = mixWordColor(clamp01((t - word.startTime) / span), line.agent)
          })
        } else {
          const el = wordColorRefs.current.get(`l${currentIndex}`)
          if (el) el.style.color = mixWordColor(clamp01((t - line.time) / 0.3), line.agent)
        }
      }
      const dur = durationRef.current
      const clampedNow = Math.min(t, dur > 0 ? dur : t)
      if (progressFillRef.current) {
        progressFillRef.current.style.width = dur > 0 ? `${clamp01(clampedNow / dur) * 100}%` : '0%'
      }
      if (elapsedRef.current) elapsedRef.current.textContent = formatTime(clampedNow)
      if (remainRef.current) remainRef.current.textContent = `-${formatTime(Math.max(0, dur - clampedNow))}`
    }

    const tick = (wall: number) => {
      const extrapolated = playing ? (wall - anchorWall) / 1000 : 0
      paint(anchorTime + extrapolated)
      raf = playing ? requestAnimationFrame(tick) : 0
    }

    const sync = () => {
      const snapshot = playbackTimeStore.getSnapshot()
      anchorTime = snapshot.currentTime
      anchorWall = performance.now()
      playing = snapshot.isPlaying
      if (snapshot.duration > 0) durationRef.current = snapshot.duration
      paint(anchorTime)
      if (playing && !raf) raf = requestAnimationFrame(tick)
    }

    sync()
    const unsubscribe = playbackTimeStore.subscribe(sync)
    return () => {
      unsubscribe()
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
  }, [currentIndex, lyrics, lineWords, playbackTimeStore, timeOffset])

  // ---- 拖拽（进度条 / 音量） ----
  const dragBar = (event: React.PointerEvent<HTMLDivElement>, onFrac: (frac: number) => void) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const apply = (clientX: number) => onFrac(clamp01((clientX - rect.left) / rect.width))
    apply(event.clientX)
    const move = (e: PointerEvent) => apply(e.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- 主题色 ----
  const c = dark
    ? {
        base: '#1c1c1e',
        lineSung: '#ffffff',
        lineUnsungCurrent: 'rgba(255,255,255,0.45)',
        title: '#ffffff',
        sub: 'rgba(255,255,255,0.5)',
        dim: 'rgba(255,255,255,0.4)',
        barTrack: 'rgba(255,255,255,0.25)',
        barFill: 'rgba(255,255,255,0.75)',
        volTrack: 'rgba(255,255,255,0.3)',
        volFill: 'rgba(255,255,255,0.6)',
        chip: 'rgba(255,255,255,0.12)',
        placeholder: '#48484a',
        placeholderIcon: 'rgba(255,255,255,0.28)',
        overlay: 'linear-gradient(180deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.42) 100%)',
        coverShadow: '0 24px 60px rgba(0,0,0,0.45)',
      }
    : {
        base: '#f5f5f7',
        lineSung: '#111114',
        lineUnsungCurrent: 'rgba(0,0,0,0.38)',
        title: '#1c1c1e',
        sub: 'rgba(0,0,0,0.5)',
        dim: 'rgba(0,0,0,0.4)',
        barTrack: 'rgba(0,0,0,0.15)',
        barFill: 'rgba(0,0,0,0.65)',
        volTrack: 'rgba(0,0,0,0.18)',
        volFill: 'rgba(0,0,0,0.5)',
        chip: 'rgba(0,0,0,0.08)',
        placeholder: '#d8d8dc',
        placeholderIcon: 'rgba(0,0,0,0.25)',
        overlay: 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.10) 55%, rgba(255,255,255,0.42) 100%)',
        coverShadow: '0 24px 60px rgba(0,0,0,0.18)',
      }

  const lineFadeFor = (distance: number) =>
    LINE_FADE[Math.min(Math.abs(distance) - 1, LINE_FADE.length - 1)] ?? 0.15
  const lineColor = (distance: number, agent?: string) => {
    const fade = lineFadeFor(distance)
    const tint = duetLineColor(agent, fade)
    if (tint) return tint
    return dark ? `rgba(255,255,255,${fade})` : `rgba(20,20,24,${Math.min(1, fade + 0.08)})`
  }
  const lineBlur = (distance: number) => {
    const d = Math.abs(distance)
    if (d === 0) return 0
    return (LINE_BLUR[Math.min(d - 1, LINE_BLUR.length - 1)] ?? 9) * s
  }

  const scrollOffset = currentY - (currentIndex + 0.5) * lineH
  const VolumeIcon = volume <= 0.001 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 overflow-hidden select-none"
      style={{
        background: c.base,
        fontFamily: FONT_STACK,
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
      } as React.CSSProperties}
    >
      <style>{`
        @keyframes modeng-beat-pulse {
          0%   { opacity: 0.05; transform: scale(1); }
          10%  { opacity: 0.11; transform: scale(1.05); }
          35%  { opacity: 0.08; transform: scale(1.02); }
          70%  { opacity: 0.055; transform: scale(1.0); }
          100% { opacity: 0.05; transform: scale(1); }
        }
        @keyframes modeng-cover-breathe {
          0%   { transform: scale(1); }
          50%  { transform: scale(1.012); }
          100% { transform: scale(1); }
        }
        @keyframes modeng-cover-beat {
          0%   { transform: scale(1); }
          12%  { transform: scale(1.018); }
          40%  { transform: scale(1.004); }
          100% { transform: scale(1); }
        }
      `}</style>

      {/* 律动背景：封面强模糊 + 纵向渐暗 + 节拍光晕（时间驱动脉冲）。
          Apple 高置信命中时优先用 AM 高清封面做模糊源（与参考软件/Apple Music 动态封面一致），
          否则用平台封面。 */}
      {appleCoverUrl || coverUrl ? (
        <img
          src={appleCoverUrl || coverUrl}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            transform: 'scale(1.25)',
            filter: `blur(${80 * s}px) brightness(${dark ? 0.68 : 1.02}) saturate(0.95)`,
          }}
        />
      ) : null}
      <div className="absolute inset-0" style={{ background: c.overlay }} />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(circle at ${((leftPad + coverSize / 2) / Math.max(1, size.width)) * 100}% 37%, ${dark ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.7)'} 0%, transparent 62%)`,
          animation: isPlaying ? 'modeng-beat-pulse 1.2s cubic-bezier(0.42,0,0.58,1) infinite' : 'none',
          opacity: isPlaying ? undefined : 0.05,
        }}
      />

      <div
        className="absolute inset-0"
        style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 0.45s cubic-bezier(0.42,0,0.58,1)' }}
      >
        {/* ---- 左栏：封面 + 信息 + 控制条 ---- */}
        <div className="absolute top-0 bottom-0" style={{ left: leftPad, width: coverSize }}>
          {/* 封面（Apple 命中时优先用 Apple 高清封面 + 律动粒子动效） */}
          <div
            className="absolute overflow-hidden"
            style={{
              top: 113 * s,
              width: coverSize,
              height: coverSize,
              borderRadius: 14 * s,
              boxShadow: c.coverShadow,
              background: c.placeholder,
              animation: Boolean(appleCoverUrl) && isPlaying
                ? 'modeng-cover-breathe 6s cubic-bezier(0.42,0,0.58,1) infinite, modeng-cover-beat 1.2s cubic-bezier(0.42,0,0.58,1) infinite'
                : undefined,
            }}
          >
            {appleCoverUrl || coverUrl ? (
              <img
                src={appleCoverUrl || coverUrl}
                alt={songTitle}
                draggable={false}
                className="h-full w-full object-cover"
                style={{ animation: Boolean(appleCoverUrl) && isPlaying ? 'modeng-cover-breathe 6s cubic-bezier(0.42,0,0.58,1) infinite' : undefined }}
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center">
                <Music style={{ width: 190 * s, height: 190 * s, color: c.placeholderIcon }} strokeWidth={1.4} />
              </div>
            )}
            <AppleCoverFx
              enabled={Boolean(appleCoverUrl)}
              isPlaying={isPlaying}
              size={coverSize}
              radius={14 * s}
              accentColor={dark ? '#ffffff' : '#e8682f'}
            />
          </div>

          {/* 标题 / 艺人 + 更多按钮 */}
          <div className="absolute flex items-start justify-between" style={{ top: 641 * s, width: coverSize }}>
            <div className="min-w-0">
              <div
                className="truncate font-bold"
                style={{ color: c.title, fontSize: 19 * s, lineHeight: `${25 * s}px` }}
              >
                {songTitle}
              </div>
              <div className="truncate" style={{ color: c.sub, fontSize: 15 * s, lineHeight: `${21 * s}px` }}>
                {songArtist}
              </div>
            </div>
            <button
              type="button"
              aria-label="更多"
              className="flex items-center justify-center rounded-full shrink-0"
              style={{ width: 36 * s, height: 36 * s, background: c.chip, color: c.title, marginTop: 2 * s }}
            >
              <MoreHorizontal style={{ width: 16 * s, height: 16 * s }} />
            </button>
          </div>

          {/* 进度条 */}
          <div
            className="absolute cursor-pointer"
            style={{ top: 702 * s, width: coverSize, height: 12 * s }}
            onPointerDown={event => {
              if (!onSeek || durationRef.current <= 0) return
              dragBar(event, frac => onSeek(frac * durationRef.current))
            }}
          >
            <div
              className="absolute left-0 right-0 rounded-full"
              style={{ top: 4.5 * s, height: 3 * s, background: c.barTrack }}
            />
            <div
              ref={progressFillRef}
              className="absolute left-0 rounded-full"
              style={{ top: 4.5 * s, height: 3 * s, background: c.barFill, width: '0%' }}
            />
          </div>

          {/* 时间 */}
          <div
            className="absolute flex justify-between"
            style={{ top: 719 * s, width: coverSize, color: c.dim, fontSize: 10.5 * s }}
          >
            <span ref={elapsedRef}>0:00</span>
            <span ref={remainRef}>-0:00</span>
          </div>

          {/* 播放控制 */}
          <div
            className="absolute flex items-center justify-between"
            style={{ top: 752 * s, width: coverSize, height: 32 * s }}
          >
            <button
              type="button"
              aria-label="随机播放"
              onClick={() => onPlayModeChange?.(playMode === 'shuffle' ? 'sequential' : 'shuffle')}
              style={{ color: playMode === 'shuffle' ? c.title : c.dim }}
            >
              <Shuffle style={{ width: 16 * s, height: 16 * s }} />
            </button>
            <div className="flex items-center" style={{ gap: 46 * s }}>
              <button type="button" aria-label="上一首" onClick={onPrevious} style={{ color: c.title }}>
                <SkipBack style={{ width: 30 * s, height: 30 * s }} fill="currentColor" strokeWidth={0} />
              </button>
              <button type="button" aria-label="播放/暂停" onClick={onPlayPause} style={{ color: c.title }}>
                {isPlaying ? (
                  <Pause style={{ width: 32 * s, height: 32 * s }} fill="currentColor" strokeWidth={0} />
                ) : (
                  <Play style={{ width: 32 * s, height: 32 * s }} fill="currentColor" strokeWidth={0} />
                )}
              </button>
              <button type="button" aria-label="下一首" onClick={onNext} style={{ color: c.title }}>
                <SkipForward style={{ width: 30 * s, height: 30 * s }} fill="currentColor" strokeWidth={0} />
              </button>
            </div>
            <button
              type="button"
              aria-label="循环播放"
              onClick={() => onPlayModeChange?.(playMode === 'repeat' ? 'sequential' : 'repeat')}
              style={{ color: playMode === 'repeat' ? c.title : c.dim }}
            >
              <Repeat style={{ width: 16 * s, height: 16 * s }} />
            </button>
          </div>

          {/* 音量 */}
          <div className="absolute flex items-center" style={{ top: 828 * s, width: coverSize, gap: 10 * s }}>
            <VolumeX style={{ width: 15 * s, height: 15 * s, color: c.dim, visibility: 'hidden' }} />
            <div
              className="relative flex-1 cursor-pointer"
              style={{ height: 12 * s }}
              onPointerDown={event => dragBar(event, frac => onVolumeChange?.(frac))}
            >
              <div
                className="absolute left-0 right-0 rounded-full"
                style={{ top: 4.5 * s, height: 3 * s, background: c.volTrack }}
              />
              <div
                className="absolute left-0 rounded-full"
                style={{ top: 4.5 * s, height: 3 * s, background: c.volFill, width: `${clamp01(volume) * 100}%` }}
              />
            </div>
            <VolumeIcon style={{ width: 15 * s, height: 15 * s, color: c.dim }} />
          </div>

          {/* 页脚 */}
          <div
            className="absolute flex items-center justify-between"
            style={{ top: 898 * s, width: Math.max(coverSize, size.width - leftPad * 2) }}
          >
            <div className="flex items-center" style={{ gap: 8 * s, color: c.dim }}>
              <span
                className="rounded-full flex items-center justify-center"
                style={{ width: 16 * s, height: 16 * s, background: c.chip }}
              >
                <Music style={{ width: 9 * s, height: 9 * s }} />
              </span>
              <span style={{ fontSize: 10 * s }}>WaveForge · 摩登</span>
            </div>
            <div className="flex items-center" style={{ gap: 12 * s }}>
              <button
                type="button"
                aria-label="翻译"
                className="flex items-center justify-center rounded-lg"
                style={{ width: 28 * s, height: 28 * s, background: c.chip, color: c.sub }}
              >
                <Languages style={{ width: 14 * s, height: 14 * s }} />
              </button>
              <button
                type="button"
                aria-label="评论"
                className="flex items-center justify-center rounded-lg"
                style={{ width: 28 * s, height: 28 * s, background: c.chip, color: c.sub }}
              >
                <MessageCircle style={{ width: 14 * s, height: 14 * s }} />
              </button>
            </div>
          </div>
        </div>

        {/* ---- 右栏：逐词歌词 ---- */}
        <div className="absolute top-0 bottom-0 right-0 overflow-hidden" style={{ left: rightX }}>
          <div
            style={{
              transform: `translateY(${scrollOffset}px)`,
              transition: 'transform 0.3s cubic-bezier(0.42,0,0.58,1)',
            }}
          >
            {lyrics.map((line, index) => {
              const distance = index - currentIndex
              const isCurrent = distance === 0
              const words = lineWords[index]
              const lineBaseColor = isCurrent
                ? (duetUnsungColor(line.agent) ?? c.lineUnsungCurrent)
                : lineColor(distance, line.agent)
              const wordInitialColor = duetUnsungColor(line.agent) ?? unsungColor
              return (
                <div
                  key={`${line.time}-${index}`}
                  onClick={() => onSeek?.(line.time)}
                  className="cursor-pointer whitespace-nowrap"
                  style={{
                    height: lineH,
                    display: 'flex',
                    alignItems: 'center',
                    fontSize: (isCurrent ? 46 : 38) * s,
                    fontWeight: isCurrent ? 700 : 600,
                    color: lineBaseColor,
                    filter: lineBlur(distance) > 0 ? `blur(${lineBlur(distance)}px)` : undefined,
                    opacity: Math.abs(distance) > 7 ? 0 : 1,
                    transition:
                      'font-size 0.32s cubic-bezier(0.4,0,0.2,1), color 0.32s cubic-bezier(0.4,0,0.2,1), filter 0.32s cubic-bezier(0.4,0,0.2,1), opacity 0.32s cubic-bezier(0.42,0,0.58,1)',
                    letterSpacing: 0.5 * s,
                    transform: 'translateZ(0)',
                  }}
                >
                  {words && words.length > 0 ? (
                    words.map((word, wordIndex) =>
                      word.whitespace ? (
                        <span key={`ws-${wordIndex}`} style={{ whiteSpace: 'pre' }}>{word.text}</span>
                      ) : (
                        <span
                          key={`w-${wordIndex}`}
                          ref={el => {
                            if (el) wordColorRefs.current.set(`w${index}-${wordIndex}`, el)
                            else wordColorRefs.current.delete(`w${index}-${wordIndex}`)
                          }}
                          className="inline-block"
                          style={{ color: wordInitialColor }}
                        >
                          {word.text}
                        </span>
                      ),
                    )
                  ) : (
                    <span
                      ref={el => {
                        if (el) wordColorRefs.current.set(`l${index}`, el)
                        else wordColorRefs.current.delete(`l${index}`)
                      }}
                      className="inline-block"
                      style={{ color: wordInitialColor }}
                    >
                      {line.text}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
