/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 播客节目播放页（网易云播客单集）。
 *
 * 为什么要独立页面：播客不是歌曲——没有歌词、没有 MV、没有「上一首/下一首」的专辑语义，
 * 也不该套用歌词页那套悬浮控件（主页/翻译/罗马音/MV 背景）。此前播客被归一到
 * 「纯音乐」分支，结果是 AlbumCoverPlayer 拿不到可用封面时只剩一块 "No Cover" 黑板，
 * 观感像坏掉（用户实测反馈）。
 *
 * 与 AppleRadioNowPlayingPage 的关系：两者都是「非歌曲」播放页，布局刻意保持同族
 * （方形封面 + 标题/所属节目 + 播放键 + 音效 + 设置 + 音量），但数据来源与语义各自独立：
 * 电台有 直播/节目回放 时间轴与电台简介，播客只有单集标题与所属播客名。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowLeft, AudioLines, Mic2, Pause, Play, Volume2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import CachedImage from './CachedImage'
import QuickSettings from './QuickSettings'

type Props = {
  song: Song
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  playerTheme: 'light' | 'dark'
  playbackTimeStore?: PlaybackTimeStore
  onBack: () => void
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onOpenSoundEffects?: (anchorRect?: DOMRect) => void
}

const fallbackSnapshotValue = { currentTime: 0, duration: 0, isPlaying: false }
const fallbackSnapshot = () => fallbackSnapshotValue
const fallbackSubscribe = () => () => undefined

export default function PodcastNowPlayingPage({
  song,
  isPlaying,
  currentTime,
  duration,
  volume,
  playerTheme,
  playbackTimeStore,
  onBack,
  onPlayPause,
  onSeek,
  onVolumeChange,
  onOpenSoundEffects,
}: Props) {
  const isDark = playerTheme === 'dark'
  // 节目所属播客名：服务端把节目放队列时写进了 album.name；没有就退到艺人数组
  const showName = song.album?.name?.trim() || song.artists.map(artist => artist.name).join(', ')
  const cover = song.album?.picUrl || ''

  const timeSnapshot = useSyncExternalStore(
    playbackTimeStore?.subscribe ?? fallbackSubscribe,
    playbackTimeStore?.getSnapshot ?? fallbackSnapshot,
  )
  const liveTime = timeSnapshot.currentTime > 0 ? timeSnapshot.currentTime : currentTime
  const liveDuration = timeSnapshot.duration > 0 && Number.isFinite(timeSnapshot.duration)
    ? timeSnapshot.duration
    : (Number.isFinite(duration) && duration > 0 ? duration : (song.duration > 0 ? song.duration / 1000 : 0))

  const [volumeOpen, setVolumeOpen] = useState(false)
  const volumeCloseTimer = useRef<number | null>(null)
  const volumeWrapRef = useRef<HTMLDivElement | null>(null)
  const clearVolumeCloseTimer = () => {
    if (volumeCloseTimer.current) window.clearTimeout(volumeCloseTimer.current)
    volumeCloseTimer.current = null
  }
  const scheduleVolumeClose = (delay = 3000) => {
    clearVolumeCloseTimer()
    volumeCloseTimer.current = window.setTimeout(() => setVolumeOpen(false), delay)
  }
  useEffect(() => () => clearVolumeCloseTimer(), [])
  useEffect(() => {
    if (!volumeOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (volumeWrapRef.current && !volumeWrapRef.current.contains(event.target as Node)) setVolumeOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [volumeOpen])

  const [scrubRatio, setScrubRatio] = useState<number | null>(null)
  const progressRef = useRef<HTMLDivElement | null>(null)
  const displayTime = scrubRatio !== null
    ? scrubRatio * liveDuration
    : Math.min(Math.max(liveTime, 0), liveDuration || liveTime)
  const seekFromClientX = (clientX: number) => {
    const rect = progressRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || liveDuration <= 0) return
    const ratio = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    setScrubRatio(ratio)
    onSeek(ratio * liveDuration)
  }

  return (
    <div className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden ${isDark ? 'bg-[#08090d] text-white' : 'bg-[#f5f5f7] text-black'}`} data-podcast-player>
      {cover && (
        <img
          src={cover}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-3xl"
          onError={event => { (event.currentTarget as HTMLImageElement).style.display = 'none' }}
        />
      )}
      <div className={`absolute inset-0 ${isDark ? 'bg-black/50' : 'bg-white/70'}`} />

      <header className="relative z-10 flex h-20 shrink-0 items-center justify-between px-5 md:px-10">
        {/* 返回：回主页（与电台页一致；右上角不再重复放主页按钮） */}
        <button type="button" onClick={onBack} className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'bg-white/10 hover:bg-white/16' : 'bg-black/8 hover:bg-black/12'}`} aria-label="返回">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase text-[#fa2d48]"><Mic2 className="h-4 w-4" />播客</div>
        <div className="h-10 w-10" />
      </header>

      <main className="relative z-10 grid min-h-0 flex-1 items-center gap-8 overflow-y-auto px-6 pb-24 pt-3 md:grid-cols-[minmax(280px,520px)_minmax(280px,560px)] md:justify-center md:px-12">
        <div className="mx-auto w-full max-w-[520px]">
          <div className="relative aspect-square overflow-hidden rounded-2xl bg-white/5 shadow-2xl">
            {cover
              ? <CachedImage src={cover} alt={song.name} className="h-full w-full" role="hero" priority="critical" lazy={false} />
              : <div className="flex h-full w-full items-center justify-center"><Mic2 className="h-24 w-24 opacity-25" /></div>}
          </div>
        </div>

        <section className="min-w-0 text-center md:text-left">
          <div className="mb-4 flex justify-center md:justify-start">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#fa2d48]/15 px-3 py-1.5 text-xs font-semibold text-[#ff6b7f]">
              <span className="h-2 w-2 rounded-full bg-[#fa2d48]" />单集节目
            </span>
          </div>
          {/* 节目名 + 所属播客名：播客没有歌词，这两行就是它全部的可读信息 */}
          <h1 className="text-3xl font-bold leading-tight md:text-5xl">{song.name}</h1>
          {showName && <p className={`mt-3 text-base md:text-lg ${isDark ? 'text-white/62' : 'text-black/58'}`}>{showName}</p>}

          {liveDuration > 0 && (
            <div className="mt-8">
              <div
                ref={progressRef}
                role="slider"
                aria-label="节目进度"
                aria-valuemin={0}
                aria-valuemax={Math.round(liveDuration)}
                aria-valuenow={Math.round(displayTime)}
                tabIndex={0}
                onKeyDown={event => {
                  if (event.key === 'ArrowLeft') { event.preventDefault(); onSeek(Math.max(0, displayTime - 10)) }
                  if (event.key === 'ArrowRight') { event.preventDefault(); onSeek(Math.min(liveDuration, displayTime + 10)) }
                }}
                onPointerDown={event => {
                  event.currentTarget.setPointerCapture?.(event.pointerId)
                  seekFromClientX(event.clientX)
                }}
                onPointerMove={event => { if (event.buttons & 1) seekFromClientX(event.clientX) }}
                onPointerUp={() => setScrubRatio(null)}
                onPointerCancel={() => setScrubRatio(null)}
                className="group/bar flex h-4 cursor-pointer items-center"
              >
                <div className={`relative h-1 w-full overflow-hidden rounded-full transition-[height] group-hover/bar:h-1.5 ${isDark ? 'bg-white/20' : 'bg-black/15'}`}>
                  <div className="h-full rounded-full bg-[#fa2d48]" style={{ width: `${liveDuration > 0 ? Math.min(100, (displayTime / liveDuration) * 100) : 0}%` }} />
                </div>
              </div>
              <div className={`mt-1 flex justify-between text-xs ${isDark ? 'text-white/35' : 'text-black/35'}`}>
                <span>{formatTime(displayTime)}</span>
                <span>{formatTime(liveDuration)}</span>
              </div>
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-3 md:justify-start">
            <button type="button" onClick={onPlayPause} className="flex h-14 w-14 items-center justify-center rounded-full bg-white text-black shadow-xl" aria-label={isPlaying ? '暂停' : '播放'}>
              {isPlaying ? <Pause className="h-6 w-6 fill-current" /> : <Play className="ml-0.5 h-6 w-6 fill-current" />}
            </button>
            {onOpenSoundEffects && (
              <button
                type="button"
                aria-label="音效"
                title="音效"
                onClick={event => onOpenSoundEffects(event.currentTarget.getBoundingClientRect())}
                className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              >
                <AudioLines className="h-5 w-5 opacity-55" />
              </button>
            )}
            {/* 设置：播客页专属入口（isPureMusic 让面板收敛掉歌词/MV 相关项） */}
            <QuickSettings
              playerTheme={playerTheme}
              isPureMusic
              triggerClassName={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              triggerWidth={40}
              triggerHeight={40}
              triggerIconSize={20}
              triggerIconColor={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'}
            />
            <div
              ref={volumeWrapRef}
              className="relative flex items-center"
              onMouseEnter={clearVolumeCloseTimer}
              onMouseLeave={() => scheduleVolumeClose(3000)}
            >
              <button
                type="button"
                onClick={() => { clearVolumeCloseTimer(); setVolumeOpen(open => !open) }}
                aria-label="音量"
                aria-expanded={volumeOpen}
                className={`flex h-10 w-10 items-center justify-center rounded-full ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/8'}`}
              >
                <Volume2 className="h-5 w-5 opacity-55" />
              </button>
              {volumeOpen && (
                <div className={`absolute left-full top-1/2 z-10 ml-3 flex -translate-y-1/2 items-center gap-3 rounded-full px-4 py-2.5 shadow-xl ${isDark ? 'bg-[#1b1d24]/95' : 'bg-white/95'}`}>
                  <input
                    aria-label="音量"
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={volume}
                    onChange={event => { onVolumeChange(Number(event.target.value)); clearVolumeCloseTimer() }}
                    className="w-36 accent-[#fa2d48]"
                  />
                  <span className={`w-9 text-right text-xs tabular-nums ${isDark ? 'text-white/55' : 'text-black/55'}`}>{Math.round(volume * 100)}%</span>
                </div>
              )}
            </div>
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
