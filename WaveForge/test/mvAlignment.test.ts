import { describe, it, expect } from 'vitest'
import { detectOffsetFromSubtitles, detectOffsetFromBeats, MIN_ALIGNMENT_CONFIDENCE } from '../src/services/mvAlignment'
import type { LyricLine } from '../src/services/musicApi'
import type { BilibiliSubtitleLine } from '../src/services/bilibiliApi'

function lyric(timeMs: number, text: string): LyricLine {
  return { time: timeMs, text }
}

function sub(from: number, content: string): BilibiliSubtitleLine {
  return { from, to: from + 3, content }
}

describe('detectOffsetFromSubtitles', () => {
  it('完美对齐（无前摇）：偏移 ≈ 0', () => {
    const songLyrics = [lyric(10_000, '第一句歌词'), lyric(15_000, '第二句歌词'), lyric(20_000, '第三句歌词'), lyric(25_000, '第四句歌词')]
    const subLines = [sub(10, '第一句歌词'), sub(15, '第二句歌词'), sub(20, '第三句歌词'), sub(25, '第四句歌词')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.method).toBe('subtitle')
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
    expect(Math.abs(result!.offsetSeconds)).toBeLessThan(0.2)
  })

  it('MV 带 4s 前摇：偏移 ≈ +4', () => {
    const songLyrics = [lyric(10_000, '第一句歌词'), lyric(15_000, '第二句歌词'), lyric(20_000, '第三句歌词'), lyric(25_000, '第四句歌词')]
    const subLines = [sub(14, '第一句歌词'), sub(19, '第二句歌词'), sub(24, '第三句歌词'), sub(29, '第四句歌词')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.offsetSeconds).toBeCloseTo(4, 0)
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
  })

  it('匹配太少（<3 行）→ null', () => {
    const songLyrics = [lyric(10_000, '第一句歌词'), lyric(15_000, '第二句歌词'), lyric(20_000, '第三句歌词')]
    const subLines = [sub(10, '第一句歌词'), sub(99, '完全不相关的内容')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('偏移离散度过大（翻唱/混剪）→ null', () => {
    const songLyrics = [lyric(10_000, '第一句歌词'), lyric(15_000, '第二句歌词'), lyric(20_000, '第三句歌词'), lyric(25_000, '第四句歌词')]
    // 各行偏移 0/4/-3/8 互相矛盾
    const subLines = [sub(10, '第一句歌词'), sub(19, '第二句歌词'), sub(17, '第三句歌词'), sub(33, '第四句歌词')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('完全对不上 → null', () => {
    const songLyrics = [lyric(10_000, '第一句歌词'), lyric(15_000, '第二句歌词'), lyric(20_000, '第三句歌词')]
    const subLines = [sub(5, '别的歌的歌词甲'), sub(9, '别的歌的歌词乙'), sub(13, '别的歌的歌词丙')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('标点/大小写差异不影响匹配', () => {
    const songLyrics = [lyric(10_000, 'Hello, World!'), lyric(15_000, 'Say It Again'), lyric(20_000, 'Never Give Up')]
    const subLines = [sub(16, 'hello world'), sub(21, 'say it again'), sub(26, 'never give up')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.offsetSeconds).toBeCloseTo(6, 0)
  })
})

describe('detectOffsetFromBeats', () => {
  /** 真实节拍有节奏起伏（非完美均匀网格），加 ±0.05s 抖动更贴近 beat 分析输出 */
  function steadyBeats(start: number, count: number, interval = 0.5): number[] {
    let phase = 0
    return Array.from({ length: count }, (_, i) => {
      phase += interval + Math.sin(i * 1.7) * 0.05
      return start + phase
    })
  }

  it('同曲同速 +5s 偏移：offset ≈ 5、高置信', () => {
    const songBeats = steadyBeats(1, 80)
    const mvBeats = songBeats.map((t) => t + 5)
    const result = detectOffsetFromBeats(songBeats, mvBeats)
    expect(result).not.toBeNull()
    expect(result!.method).toBe('beat')
    expect(result!.offsetSeconds).toBeCloseTo(5, 0)
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
  })

  it('半拍相位差（+0.45s）：仍能锁定偏移', () => {
    const songBeats = steadyBeats(1, 80)
    const mvBeats = songBeats.map((t) => t + 0.45)
    const result = detectOffsetFromBeats(songBeats, mvBeats)
    expect(result).not.toBeNull()
    expect(Math.abs(result!.offsetSeconds - 0.45)).toBeLessThan(0.1)
  })

  it('不同速度（现场版变速）→ null', () => {
    // 真实歌曲 ~2.5 分钟：5% 变速累计漂移 7s+，节拍下标差随时间漂移 → 一致性不足被拒
    const songBeats = steadyBeats(1, 300)
    const mvBeats = songBeats.map((t) => t * 1.05 + 3)
    expect(detectOffsetFromBeats(songBeats, mvBeats)).toBeNull()
  })

  it('完全不同曲目 → null', () => {
    const songBeats = steadyBeats(1, 80)
    // 伪随机但不相关的节拍
    const mvBeats = Array.from({ length: 60 }, (_, i) => (i * 0.73 + 0.31) % 40)
    expect(detectOffsetFromBeats(songBeats, mvBeats)).toBeNull()
  })

  it('节拍过少 → null', () => {
    expect(detectOffsetFromBeats([1, 2, 3, 4], [1.5, 2.5, 3.5])).toBeNull()
  })
})
