/**
 * PV 歌词模式桥接层 —— 把 WaveForge 的歌词/分析数据归一化为 pv-tool 引擎可消费的结构。
 *
 * - WaveForge LyricLine.words（startTime/duration 均为相对行首毫秒）→ 引擎逐字（绝对秒）
 * - TrackAnalysis.beats（秒数组）+ beatFeatures（逐拍 energy）→ beatProvider 拍点数组（带能量）
 */
import type { LyricLine as WfLyricLine } from '../../services/musicApi'
import type { LyricLine as PvLyricLine, LyricWordTiming } from '../../vendor/pv/core/types'
import type { BeatTiming } from '../../vendor/pv/core/beatProvider'
import type { TrackAnalysis } from '../../audio/types'

/** WaveForge 歌词（逐字相对毫秒）→ 引擎歌词（逐字绝对秒） */
export function toPvLyrics(lyrics: WfLyricLine[]): PvLyricLine[] {
  return lyrics.map((line) => {
    let words: LyricWordTiming[] | undefined
    if (line.words && line.words.length > 0) {
      words = line.words.map((w) => {
        const start = line.time + w.startTime / 1000
        return {
          text: w.word,
          time: start,
          endTime: start + w.duration / 1000,
        }
      })
    }
    return {
      time: line.time,
      text: line.text,
      words,
      translation: line.translation,
      roman: line.roman,
    }
  })
}

/** TrackAnalysis → 拍点数组（拍点时间 + 能量，用于 getIntensity 的踩点/能量缩放） */
export function buildBeats(track: TrackAnalysis | null | undefined): BeatTiming[] {
  if (!track || !Array.isArray(track.beats)) return []
  const energyByIndex = new Map<number, number>()
  if (Array.isArray(track.beatFeatures)) {
    for (const f of track.beatFeatures) {
      if (Number.isFinite(f.energy)) energyByIndex.set(f.beatIndex, f.energy)
    }
  }
  return track.beats
    .map((t, i) => ({
      time: Number.isFinite(t) ? t : 0,
      energy: clamp01(energyByIndex.get(i) ?? 0.5),
    }))
    .filter(b => b.time > 0)
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}