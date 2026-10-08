import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import {
  detectOffsetFromSubtitles,
  detectOffsetFromBeats,
  ensureMvAlignment,
  firstLyricTime,
  getMvAlignment,
  getMvAlignmentFor,
  MIN_ALIGNMENT_CONFIDENCE,
  mvAlignmentInputSignature,
  pickLiveCompensationAnchor,
  pickMusicAnchor,
  resetMvAlignmentCachesForTests,
  shouldRejectAlignmentFor,
} from '../src/services/mvAlignment'
import { autoMixAnalysisService } from '../src/services/autoMixAnalysisService'
import * as autoMixModule from '../src/services/autoMixAnalysisService'
import { detectLiveMusicEntry, detectMusicStart } from '../src/services/autoMixAnalysisService'
import { buildEnvelopeAlignment } from '../src/services/mvAlignment'
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

describe('alignment hardening（5АМ 错位回归）', () => {
  const baseInput = {
    songKey: 'hardening-key',
    songTitle: '5АМ',
    songArtists: ['АДЛИН'],
    songDuration: 137.6,
    songUrl: 'http://audio/song',
    bvid: 'BV-hardening',
    cid: 1,
    videoUrl: 'http://audio/mv',
    candidateType: 'other',
  }

  it('other 候选节拍路径跑过仍失败 → 不做补偿兜底（自由播放）', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue({ beats: [] } as any)
    const decodeAudioUrl = vi.spyOn(autoMixModule, 'decodeAudioUrl').mockResolvedValue({ buffer: {} } as any)

    const result = await ensureMvAlignment({ ...baseInput, candidateType: 'other' })

    expect(result).toBeNull()
    expect(analyze).toHaveBeenCalled() // 节拍路径真正跑过（歌曲+MV 音频 URL 齐备）
    expect(decodeAudioUrl).not.toHaveBeenCalled() // 信号链已裁决对不上 → 补偿被闸门拦下
  })

  it('节拍路径没跑过（blob 歌曲）→ 仍允许补偿兜底', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue({ beats: [] } as any)
    const decodeAudioUrl = vi.spyOn(autoMixModule, 'decodeAudioUrl').mockResolvedValue({ buffer: {} } as any)

    await ensureMvAlignment({ ...baseInput, songUrl: 'blob:http://127.0.0.1/local-song', candidateType: 'other' })

    expect(decodeAudioUrl).toHaveBeenCalled()
  })

  it('歌曲侧节拍优先复用 automix trackKey 缓存，不按 songKey 重复分析', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    const automixCached = {
      trackKey: 'app-track-key',
      duration: 137.6,
      beats: Array.from({ length: 32 }, (_, i) => i * 0.5),
      estimatedBpm: 120,
      provider: 'beat_this',
      rmsEnvelope: Array.from({ length: 100 }, () => 0.5),
    }
    const getCached = vi.spyOn(autoMixAnalysisService, 'getCached').mockResolvedValue(automixCached as any)
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue({ beats: [] } as any)

    await ensureMvAlignment({ ...baseInput, trackKey: 'app-track-key' })

    expect(getCached).toHaveBeenCalledWith('app-track-key')
    expect(analyze).toHaveBeenCalledTimes(1) // 只剩 MV 侧分析
    expect(String(analyze.mock.calls[0]?.[0]?.trackKey)).toContain('mv-align-video:')
  })

  it('歌曲分析时长与元数据明显不符（脏缓存/错源）→ 拒用不比对', async () => {
    vi.spyOn(bilibiliApi, 'getBilibiliSubtitles').mockResolvedValue({ code: 0, subtitles: [] })
    // 实测脏数据：过渡竞态把上一首 162.2s 的分析缓存在 5АМ（137.6s）的 songKey 下
    const poisoned = {
      trackKey: 'app-track-key',
      duration: 162.2,
      beats: Array.from({ length: 32 }, (_, i) => i * 0.5),
      estimatedBpm: 115.38,
      provider: 'browser-fallback',
      rmsEnvelope: Array.from({ length: 100 }, () => 0.5),
    }
    vi.spyOn(autoMixAnalysisService, 'getCached').mockResolvedValue(poisoned as any)
    const analyze = vi.spyOn(autoMixAnalysisService, 'analyze').mockResolvedValue({ beats: [] } as any)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await ensureMvAlignment({ ...baseInput, trackKey: 'app-track-key' })

    expect(result).toBeNull()
    expect(log).toHaveBeenCalledWith('[MvAlign]', expect.stringContaining('时长不符'))
    expect(analyze).not.toHaveBeenCalled()
  })

  it('迁移：丢弃不可信的 live-vocal 旧缓存，live/cover 与其他方法保留', () => {
    localStorage.setItem('waveforge:mv-alignments:v2-seconds', JSON.stringify({
      'k|BV-legacy': { offsetSeconds: 12.16, confidence: 0.55, method: 'live-vocal', ts: Date.now() },
      'k|BV-other': { offsetSeconds: 9, confidence: 0.55, method: 'live-vocal', candidateType: 'other', ts: Date.now() },
      'k|BV-live': { offsetSeconds: 1.4, confidence: 0.55, method: 'live-vocal', candidateType: 'live', ts: Date.now() },
      'k|BV-beat': { offsetSeconds: 0.4, confidence: 1, method: 'beat', ts: Date.now() },
    }))
    resetMvAlignmentCachesForTests()

    expect(getMvAlignment('k', 'BV-legacy')).toBeNull() // 旧记录无候选类型，无法自证清白
    expect(getMvAlignment('k', 'BV-other')).toBeNull()
    expect(getMvAlignment('k', 'BV-live')).not.toBeNull()
    expect(getMvAlignment('k', 'BV-beat')).not.toBeNull()
  })
})

describe('envelope alignment gate（包络峰突出度闸门，Одна 回归）', () => {
  // 50fps、30s 的确定性包络：不规则的能量起伏（非周期），便于相关峰唯一
  function irregularEnvelope(frames: number): number[] {
    const rms: number[] = []
    let state = 0x12345678
    for (let i = 0; i < frames; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0
      const noise = (state % 1000) / 1000
      const pulse = (i % 173 < 12 ? 1 : 0) * (0.6 + noise * 0.4) + (i % 397 < 30 ? 0.8 : 0)
      rms.push(Math.min(1, 0.05 + noise * 0.2 + pulse))
    }
    return rms
  }

  it('同录音位移 3s：峰唯一 → offset≈3、突出度达标', () => {
    const song = irregularEnvelope(1500)
    const mv = song.map((value, i) => (i >= 150 ? song[i - 150] : 0.05))
    const result = autoMixModule.envelopeOffsetOf(mv, song, 50)
    expect(result.offset).toBeGreaterThan(2.5)
    expect(result.offset).toBeLessThan(3.5)
    expect(result.peak).toBeGreaterThanOrEqual(0.6)
    expect(result.prominence).toBeGreaterThanOrEqual(autoMixModule.ENVELOPE_PROMINENCE_MIN)
    expect(buildEnvelopeAlignment(result.offset, result.peak, result.prominence)).not.toBeNull()
  })

  it('周期结构（每 5s 重复）：±2s 外存在等高峰 → 突出度≈0 → 拒绝对齐', () => {
    // 每 5s 一个脉冲；mv 位移 1s。相关峰在 1±5k s 全部等高——argmax 落在哪个等价峰
    // 是扫描顺序决定的（实测落到 -24s，差 25s）——绝对峰值再高也不可信。
    const frames = 2000
    const song = Array.from({ length: frames }, (_, i) => (i % 250 < 6 ? 1 : 0.05))
    const mv = song.map((value, i) => (i >= 50 ? song[i - 50] : 0.05)) // 位移 1s
    const result = autoMixModule.envelopeOffsetOf(mv, song, 50)
    // argmax 必落在某个等价峰上（≡ +1s mod 5s），但不保证是 +1s 本身
    const equivalentMod = ((result.offset - 1) % 5 + 5) % 5
    expect(Math.min(equivalentMod, 5 - equivalentMod)).toBeLessThan(0.3)
    expect(result.peak).toBeGreaterThanOrEqual(0.6)
    expect(result.prominence).toBeLessThan(autoMixModule.ENVELOPE_PROMINENCE_MIN)
    expect(buildEnvelopeAlignment(result.offset, result.peak, result.prominence)).toBeNull()
  })

  it('真实偏移不落在 0.1s 网格上（0.16s）：仍能找到真峰（回归：取样降采样把峰腰斩到 0.485）', () => {
    // 真实数据实测：ラグトレイン 官方 PV 与平台曲目同一母带、偏移 0.16s，
    // 旧实现（每 5 帧取样降采样 + 0.25s 网格 + 半帧精化 NaN）只得 0.485@1.8s，
    // 被同一性规则误判"不同源"。这里用音符级起伏包络复现该偏移。
    const song = irregularEnvelope(1500)
    const mv = song.map((value, i) => (i >= 8 ? song[i - 8] : 0.05)) // 0.16s @50fps
    const result = autoMixModule.envelopeOffsetOf(mv, song, 50)
    expect(result.peak).toBeGreaterThanOrEqual(0.9)
    expect(Math.abs(result.offset - 0.16)).toBeLessThanOrEqual(0.02)
    expect(result.prominence).toBeGreaterThanOrEqual(autoMixModule.ENVELOPE_PROMINENCE_MIN)
  })

  it('非网格偏移 + 不同内容 → 峰仍低（抗混叠不会把不相关内容拉高）', () => {
    const song = irregularEnvelope(1500)
    // 独立噪声包络（不同种子、无共享脉冲结构）＝"另一条不相关的音频"
    const other: number[] = []
    let state = 0x9e3779b9
    for (let i = 0; i < 1500; i += 1) {
      state = (state * 1103515245 + 12345) >>> 0
      other.push(0.05 + ((state % 1000) / 1000) * 0.2)
    }
    const result = autoMixModule.envelopeOffsetOf(other, song, 50)
    expect(result.peak).toBeLessThan(0.8)
  })

  it('buildEnvelopeAlignment 分级：双门槛 + 置信度随证据伸缩', () => {
    // 峰值不足
    expect(buildEnvelopeAlignment(1, 0.55, 0.3)).toBeNull()
    // 突出度不足（Одна 型：绝对峰值够高、argmax 是抛硬币）
    expect(buildEnvelopeAlignment(-1.8, 0.67, 0.03)).toBeNull()
    // 偏移越界
    expect(buildEnvelopeAlignment(50, 0.9, 0.3)).toBeNull()
    // 干净匹配：封顶 0.8
    const clean = buildEnvelopeAlignment(3.0, 0.95, 0.4)
    expect(clean).toMatchObject({ method: 'envelope', offsetSeconds: 3, confidence: 0.8, prominence: 0.4 })
    // 温和匹配：可信但不满分（旧版硬编码 0.55）
    const modest = buildEnvelopeAlignment(1.5, 0.7, 0.12)
    expect(modest?.confidence).toBeCloseTo(0.4 + 0.1 + 0.24, 5)
    expect(modest?.confidence).toBeGreaterThanOrEqual(0.5)
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

  it('跳过日文/繁体署名行（ヒビカセ 回归：作詞 不在旧白名单里被当成首句）', () => {
    const lyrics = [
      lyric(0, 'ヒビカセ - Reol'),
      lyric(9.39, '作詞：れをる'),
      lyric(18.79, '作曲：ギガP'),
      lyric(28.19, '真夜中に告ぐ 音の警告'),
    ]

    // 旧实现只认简体「作词」→ 返回 9.39（现场版补偿的歌词锚因此 +22.6s 超限放弃）
    expect(firstLyricTime(lyrics)).toBeCloseTo(28.19, 2)
  })

  it('跳过「作詞・作曲：」叠写署名与英文署名行', () => {
    const lyrics = [
      lyric(1, '作詞・作曲：ギガP'),
      lyric(2, 'Lyrics: Reol'),
      lyric(3, '編曲：ギガP'),
      lyric(15.5, '本当の歌詞はここから'),
    ]

    expect(firstLyricTime(lyrics)).toBeCloseTo(15.5, 2)
  })
})

describe('pickLiveCompensationAnchor（包络 > 音乐入口 > 歌词）', () => {
  const envelope = { offsetSeconds: 6.9, confidence: 0.69, method: 'envelope' as const, prominence: 0.1 }

  it('包络互相关过闸门时优先于入口锚', () => {
    const picked = pickLiveCompensationAnchor({ envelope, firstVocal: 28.19, mvMusicStart: 19.84, musicAnchors: [6.88, 6.82, 6.8] })
    expect(picked?.anchor).toBe('包络')
    expect(picked?.alignment.offsetSeconds).toBeCloseTo(6.9, 2)
  })

  it('无包络时优先音乐入口锚（多探测器共识，ヒビカセ：p60 −18.8 迟到，p35/abs 一致 +6.9）', () => {
    const picked = pickLiveCompensationAnchor({ envelope: null, firstVocal: 28.19, mvMusicStart: 19.84, musicAnchors: [-18.8, 6.88, 6.82] })
    expect(picked?.anchor).toBe('音乐入口')
    expect(picked?.alignment.offsetSeconds).toBeGreaterThan(6.5)
    expect(picked?.alignment.offsetSeconds).toBeLessThan(7)
    expect(picked?.alignment.method).toBe('live-vocal')
  })

  it('音乐入口锚不可用 → 退回歌词锚（实测最差，仅兜底）', () => {
    const picked = pickLiveCompensationAnchor({ envelope: null, firstVocal: 28.19, mvMusicStart: 31.98, musicAnchors: [null, null, null] })
    expect(picked?.anchor).toBe('歌词')
    expect(picked?.alignment.offsetSeconds).toBeCloseTo(3.79, 2)
  })

  it('全部锚点不可用/超限 → null（自由播放）', () => {
    expect(pickLiveCompensationAnchor({ envelope: null, firstVocal: null, mvMusicStart: 32, musicAnchors: [null] })).toBeNull()
    expect(pickLiveCompensationAnchor({ envelope: null, firstVocal: 5, mvMusicStart: 60, musicAnchors: [30] })).toBeNull()
  })
})

describe('pickMusicAnchor（音乐入口锚：多探测器共识）', () => {
  it('多数一致 → 取一致簇（ヒビカセ：p60 −18.8 超限被弃，p35/abs 一致落在 +6.9）', () => {
    const picked = pickMusicAnchor([-18.8, 6.88, 6.82], -18.8)
    expect(picked).not.toBeNull()
    expect(picked!).toBeGreaterThan(6.5)
    expect(picked!).toBeLessThan(7)
  })

  it('无一致簇 → 退回首选（p60）', () => {
    expect(pickMusicAnchor([-10, 5, null], -10)).toBeCloseTo(-10, 5)
  })

  it('首选超限 → 用其它在范围内的候选；全空 → null', () => {
    expect(pickMusicAnchor([-30, null, 7], -30)).toBeCloseTo(7, 5)
    expect(pickMusicAnchor([null, null, null], null)).toBeNull()
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
