import { useMemo } from 'react'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { AudioPulseStore } from '../hooks/useAudioPulse'
import type { AudioAnalyzerStore } from '../hooks/useAudioAnalyzer'
import FoliaDioramaLyrics, { convertLyricsToFoliaLines } from './foliaDiorama/FoliaDioramaLyrics'

interface MultidimensionalLyricsProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  trackId?: string | number
  translationEnabled?: boolean
  romanEnabled?: boolean
  isTransitioning?: boolean
  onSeek?: (time: number) => void
  /** 音律脉冲（星河/光晕/阵型随音乐律动）。 */
  pulseStore?: AudioPulseStore
  /** 音频频段分析（波形河/节拍环）。 */
  analyzerStore?: AudioAnalyzerStore
}

export default function MultidimensionalLyrics({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  accentColor,
  songTitle,
  songArtist,
  songAlbum,
  coverUrl,
  trackId,
  translationEnabled = false,
  romanEnabled = false,
  isTransitioning = false,
  onSeek,
  pulseStore,
  analyzerStore,
}: MultidimensionalLyricsProps) {
  const lines = useMemo(() => convertLyricsToFoliaLines(lyrics), [lyrics])
  const trackKey = `${trackId ?? songTitle}:${songArtist}`
  const safeIndex = Math.max(0, Math.min(currentIndex, lines.length - 1))
  const activeNumber = String(safeIndex + 1).padStart(3, '0')
  const totalNumber = String(Math.max(1, lines.length)).padStart(3, '0')

  return (
    <div
      className="relative h-full min-h-[440px] w-full overflow-hidden bg-[#05060c] text-white"
      style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 320ms ease' }}
    >
      <FoliaDioramaLyrics
        lines={lines}
        currentIndex={safeIndex}
        playbackTimeStore={playbackTimeStore}
        timeOffset={timeOffset}
        isPlaying={isPlaying}
        accentColor={accentColor}
        trackKey={trackKey}
        translationEnabled={translationEnabled}
        romanEnabled={romanEnabled}
        onSeek={onSeek}
        pulseStore={pulseStore}
        analyzerStore={analyzerStore}
        coverUrl={coverUrl}
      />

      {/* 电影暗角：聚焦画面中心、压住四角，替代原先平铺直叙的满屏 3D */}
      <div
        className="pointer-events-none absolute inset-0 z-[5]"
        style={{ background: 'radial-gradient(ellipse 92% 82% at 50% 44%, transparent 54%, rgba(3,4,9,0.52) 100%)' }}
      />

      {/* 头部信息：克制的编辑式排版（移除水印式品牌角标与霓虹菱形） */}
      <div className="pointer-events-none absolute left-9 top-9 z-20 sm:left-12 sm:top-11">
        <div className="flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.42em] text-white/35">
          <span className="h-px w-9 bg-white/25" />
          多维 · Diorama
        </div>
        <h1 className="mt-3.5 max-w-[48vw] truncate text-2xl font-semibold tracking-[0.02em] text-white/90 sm:text-[27px]">{songTitle}</h1>
        <p className="mt-2 max-w-[48vw] truncate text-[12.5px] tracking-[0.05em] text-white/45 sm:text-[13px]">
          {songArtist}{songAlbum ? ` · ${songAlbum}` : ''}
        </p>
      </div>

      {/* 底部计数：细字重、右下角，与底部居中的字幕错开（移除 3D FLYTHROUGH 标语与渐变线） */}
      <div className="pointer-events-none absolute bottom-9 right-10 z-20 flex items-baseline gap-2.5 font-mono sm:bottom-11 sm:right-12">
        <span className="text-[22px] font-light tabular-nums tracking-[0.04em] text-white/80">{activeNumber}</span>
        <span className="text-[11px] tabular-nums tracking-[0.28em] text-white/28">/ {totalNumber}</span>
      </div>
    </div>
  )
}
