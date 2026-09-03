import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  detectOffsetFromSubtitles,
  detectOffsetFromBeats,
  ensureMvAlignment,
  firstLyricTime,
  getMvAlignmentFor,
  MIN_ALIGNMENT_CONFIDENCE,
  mvAlignmentInputSignature,
  resetMvAlignmentCachesForTests,
  shouldRejectAlignmentFor,
} from '../src/services/mvAlignment'
import { autoMixAnalysisService } from '../src/services/autoMixAnalysisService'
import * as bilibiliApi from '../src/services/bilibiliApi'
import type { LyricLine } from '../src/services/musicApi'
import type { BilibiliSubtitleLine } from '../src/services/bilibiliApi'

function lyric(timeSeconds: number, text: string): LyricLine {
  return { time: timeSeconds, text }
}

function sub(from: number, content: string): BilibiliSubtitleLine {
  return { from, to: from + 3, content }
}

beforeEach(() => {
  localStorage.clear()
  resetMvAlignmentCachesForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('MV alignment negative cache', () => {
  const baseInput = {
    songKey: 'song-key',
    songTitle: 'Song',
    songArtists: ['Artist'],
    songDuration: 180,
    songUrl: 'http://audio/song-v1',
    bvid: 'BV-test',
    cid: 1,
    videoUrl: 'http://audio/mv-v1',
    candidateType: 'official',
  }

  it('deduplicates repeated failed alignment attempts for unchanged inputs', async () => {
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue(null)

    await expect(ensureMvAlignment(baseInput)).resolves.toBeNull()
    await expect(ensureMvAlignment(baseInput)).resolves.toBeNull()

    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight alignment across callers with independent abort signals', async () => {
    let resolveAnalysis: ((value: Awaited<ReturnType<typeof autoMixAnalysisService.analyze>>) => void) | undefined
    const pending = new Promise<Awaited<ReturnType<typeof autoMixAnalysisService.analyze>>>(resolve => {
      resolveAnalysis = resolve
    })
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockReturnValue(pending)
    const first = new AbortController()
    const second = new AbortController()

    const firstResult = ensureMvAlignment(baseInput, first.signal)
    const secondResult = ensureMvAlignment(baseInput, second.signal)
    first.abort()
    resolveAnalysis?.(null)

    await expect(firstResult).resolves.toBeNull()
    await expect(secondResult).resolves.toBeNull()
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('aligns Apple CENC tracks through lyrics and MV subtitles without decoding DRM audio', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({
      code: 0,
      subtitles: [{ id: 1, lan: 'zh-CN', lanDoc: '中文', isLock: false, subtitleUrl: '', cacheKey: 'sub-cache' }],
    } as any)
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitleJson').mockResolvedValue([
      sub(14, '第一句歌词'),
      sub(19, '第二句歌词'),
      sub(24, '第三句歌词'),
      sub(29, '第四句歌词'),
    ])
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze')

    const result = await ensureMvAlignment({
      ...baseInput,
      songUrl: 'blob:http://127.0.0.1/apple-hls',
      lyrics: [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词'), lyric(25, '第四句歌词')],
    })

    expect(result).toMatchObject({ method: 'subtitle', offsetSeconds: 4 })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('keeps an Apple CENC MV in free-play mode when no reliable subtitles exist', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze')

    await expect(ensureMvAlignment({
      ...baseInput,
      songUrl: 'blob:http://127.0.0.1/apple-hls',
      lyrics: [lyric(10, '第一句歌词')],
    })).resolves.toBeNull()

    expect(analyze).not.toHaveBeenCalled()
  })

  it('retries immediately when lyrics or stream URLs change', async () => {
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue(null)
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })

    await ensureMvAlignment(baseInput)
    await ensureMvAlignment({ ...baseInput, lyrics: [lyric(12, 'new lyric')] })
    await ensureMvAlignment({ ...baseInput, lyrics: [lyric(12, 'new lyric')], songUrl: 'http://audio/song-v2' })

    expect(analyze).toHaveBeenCalledTimes(3)
    expect(mvAlignmentInputSignature(baseInput)).not.toBe(mvAlignmentInputSignature({ ...baseInput, lyrics: [lyric(12, 'new lyric')] }))
  })

  it('keeps the shared alignment running when one caller is already aborted', async () => {
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue(null)
    const controller = new AbortController()
    controller.abort()

    await ensureMvAlignment(baseInput, controller.signal)
    await Promise.resolve()
    await ensureMvAlignment(baseInput)

    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('retries unchanged inputs after the short failure TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T00:00:00Z'))
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue(null)

    await ensureMvAlignment(baseInput)
    await ensureMvAlignment(baseInput)
    vi.advanceTimersByTime(30_001)
    await ensureMvAlignment(baseInput)

    expect(analyze).toHaveBeenCalledTimes(2)
  })

  it('discards a stale beat cache for a CC-mismatched other candidate', async () => {
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockImplementation(((input: any) => {
      if (String(input?.trackKey || '').startsWith('mv-align-video:')) {
        return Promise.resolve({ beats: [] }) as any
      }
      return Promise.resolve({ beats: [] }) as any
    }) as any)
    // 先以官方候选成功写入一条 beat 缓存（模拟旧版本/其它入口产生的可信记录）
    const poisoned = {
      songKey: 'villain-key',
      bvid: 'BV-villain',
      offsetSeconds: 9.86,
      confidence: 1,
      method: 'beat' as const,
      ts: Date.now(),
    }
    localStorage.setItem('waveforge:mv-alignments:v2-seconds', JSON.stringify({
      'villain-key|BV-villain': poisoned,
    }))
    resetMvAlignmentCachesForTests()
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitleJson').mockResolvedValue([])
    vi.spyOn(autoMixAnalysisService, 'getCached').mockResolvedValue(null)

    const result = await ensureMvAlignment({
      ...baseInput,
      songKey: 'villain-key',
      bvid: 'BV-villain',
      candidateType: 'other',
      ccVerification: 'mismatch',
    })

    expect(result).toBeNull()
    expect(String(analyze.mock.calls[0]?.[0]?.trackKey)).toContain('villain-key')
  })
})

describe('alignment cache trust gate（候选可信度闸门）', () => {
  const beatCache = { offsetSeconds: 9.86, confidence: 1, method: 'beat' as const }

  it('rejects a beat-only cache for other + cc=mismatch, accepts official or subtitle results', () => {
    expect(shouldRejectAlignmentFor(beatCache, { candidateType: 'other', ccVerification: 'mismatch' })).toBe(true)
    expect(shouldRejectAlignmentFor(beatCache, { candidateType: 'official', ccVerification: 'mismatch' })).toBe(false)
    expect(shouldRejectAlignmentFor(beatCache, { candidateType: 'other', ccVerification: 'unverified' })).toBe(false)
    expect(shouldRejectAlignmentFor({ ...beatCache, method: 'subtitle' }, { candidateType: 'other', ccVerification: 'mismatch' })).toBe(false)
    expect(shouldRejectAlignmentFor(null, { candidateType: 'other', ccVerification: 'mismatch' })).toBe(false)
  })

  it('getMvAlignmentFor hides a poisoned cache from fast-path readers', () => {
    localStorage.setItem('waveforge:mv-alignments:v2-seconds', JSON.stringify({
      'villain-key|BV-villain': { ...beatCache, ts: Date.now() },
    }))
    resetMvAlignmentCachesForTests()

    expect(getMvAlignmentFor('villain-key', 'BV-villain', { candidateType: 'other', ccVerification: 'mismatch' })).toBeNull()
    expect(getMvAlignmentFor('villain-key', 'BV-villain', { candidateType: 'other', ccVerification: 'unverified' })).not.toBeNull()
  })
})

describe('detectOffsetFromSubtitles', () => {
  it('完美对齐（无前摇）：偏移 ≈ 0', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词'), lyric(25, '第四句歌词')]
    const subLines = [sub(10, '第一句歌词'), sub(15, '第二句歌词'), sub(20, '第三句歌词'), sub(25, '第四句歌词')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.method).toBe('subtitle')
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
    expect(Math.abs(result!.offsetSeconds)).toBeLessThan(0.2)
  })

  it('MV 带 4s 前摇：偏移 ≈ +4', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词'), lyric(25, '第四句歌词')]
    const subLines = [sub(14, '第一句歌词'), sub(19, '第二句歌词'), sub(24, '第三句歌词'), sub(29, '第四句歌词')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.offsetSeconds).toBeCloseTo(4, 0)
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
  })

  it('翻译 CC（Villain 场景）：CC 为歌词中文翻译时仍可对齐', () => {
    // 英文原曲只挂中文翻译 CC：字幕时间 ↔ 歌词行（含 translation 字段）的翻译文本
    const songLyrics: Array<{ time: number; text: string; translation?: string }> = [
      { time: 9.5, text: 'I can feel the city breathing', translation: '我能感觉到城市在呼吸' },
      { time: 14.2, text: 'Waiting for the villain to rise', translation: '等待反派崛起' },
      { time: 19.0, text: 'Take the shot before the dawn', translation: '在黎明前开枪' },
      { time: 24.1, text: 'No surrender, no retreat', translation: '不投降 不后退' },
    ]
    const subLines = [
      sub(14.5, '我能感觉到城市在呼吸'),
      sub(19.2, '等待反派崛起'),
      sub(24.0, '在黎明前开枪'),
      sub(29.1, '不投降 不后退'),
    ]
    const result = detectOffsetFromSubtitles(songLyrics as any, subLines)
    expect(result).not.toBeNull()
    expect(result!.method).toBe('subtitle')
    expect(result!.offsetSeconds).toBeCloseTo(5, 0)
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
  })

  it('MV 比歌曲早 4s：保留负偏移 ≈ -4', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词'), lyric(25, '第四句歌词')]
    const subLines = [sub(6, '第一句歌词'), sub(11, '第二句歌词'), sub(16, '第三句歌词'), sub(21, '第四句歌词')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.offsetSeconds).toBeCloseTo(-4, 0)
    expect(result!.confidence).toBeGreaterThanOrEqual(MIN_ALIGNMENT_CONFIDENCE)
  })

  it('匹配太少（<3 行）→ null', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词')]
    const subLines = [sub(10, '第一句歌词'), sub(99, '完全不相关的内容')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('偏移离散度过大（翻唱/混剪）→ null', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词'), lyric(25, '第四句歌词')]
    // 各行偏移 0/4/-3/8 互相矛盾
    const subLines = [sub(10, '第一句歌词'), sub(19, '第二句歌词'), sub(17, '第三句歌词'), sub(33, '第四句歌词')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('完全对不上 → null', () => {
    const songLyrics = [lyric(10, '第一句歌词'), lyric(15, '第二句歌词'), lyric(20, '第三句歌词')]
    const subLines = [sub(5, '别的歌的歌词甲'), sub(9, '别的歌的歌词乙'), sub(13, '别的歌的歌词丙')]
    expect(detectOffsetFromSubtitles(songLyrics, subLines)).toBeNull()
  })

  it('标点/大小写差异不影响匹配', () => {
    const songLyrics = [lyric(10, 'Hello, World!'), lyric(15, 'Say It Again'), lyric(20, 'Never Give Up')]
    const subLines = [sub(16, 'hello world'), sub(21, 'say it again'), sub(26, 'never give up')]
    const result = detectOffsetFromSubtitles(songLyrics, subLines)
    expect(result).not.toBeNull()
    expect(result!.offsetSeconds).toBeCloseTo(6, 0)
  })
})

describe('firstLyricTime', () => {
  it('uses realistic second-based lyric timestamps and skips metadata', () => {
    const lyrics = [
      lyric(0, '作词：Vaundy'),
      lyric(0.8, '宮 - Vaundy'),
      lyric(24.94, '第一句真实歌词'),
      lyric(29.6, '第二句真实歌词'),
    ]

    expect(firstLyricTime(lyrics)).toBeCloseTo(24.94, 2)
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
