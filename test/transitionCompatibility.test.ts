import { describe, it, expect } from 'vitest'
import { describeTransitionCompatibilityIssue } from '../src/hooks/useAudioPlayer.ts'
import type { TrackAnalysis } from '../src/audio/types'

/** 复用 planner 测试的构造思路：最小可用 TrackAnalysis 基线 */
function makeAnalysis(trackKey: string, overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    schemaVersion: 1,
    trackKey,
    duration: 120,
    provider: 'librosa-fallback',
    beats: [0, 1, 2],
    downbeats: [0],
    beatConfidence: [1, 1, 1],
    downbeatConfidence: [1],
    estimatedBpm: 120,
    confidence: 0.9,
    sections: [],
    beatFeatures: [],
    introSilence: 0,
    outroSilence: 0,
    analysisVersion: 'librosa-dsp-v3',
    createdAt: 0,
    lastAccessAt: 0,
    ...overrides,
  }
}

const STREAM_META = { url: 'http://x', trackKey: 'k', index: 0, duration: 120 }

describe('describeTransitionCompatibilityIssue（格式/一致性预检）', () => {
  it('正常立体声 + 时长一致 → 放行（null）', () => {
    const source = makeAnalysis('src', { audioFormat: { sampleRate: 44100, channels: 2 } })
    const target = makeAnalysis('tgt', { audioFormat: { sampleRate: 48000, channels: 2 } })
    expect(describeTransitionCompatibilityIssue(source, target, { ...STREAM_META, trackKey: 'src' }, { ...STREAM_META, trackKey: 'tgt' })).toBeNull()
  })

  it('任一侧为元数据降级 → 拦截', () => {
    const ok = makeAnalysis('ok')
    const meta = makeAnalysis('meta', { provider: 'metadata-only' })
    expect(describeTransitionCompatibilityIssue(meta, ok, { ...STREAM_META, trackKey: 'meta' }, { ...STREAM_META, trackKey: 'ok' })).toContain('元数据降级')
    expect(describeTransitionCompatibilityIssue(ok, meta, { ...STREAM_META, trackKey: 'ok' }, { ...STREAM_META, trackKey: 'meta' })).toContain('元数据降级')
  })

  it('分析时长与流时长偏差 >1.5s → 拦截（过期缓存/换源）', () => {
    const analysis = makeAnalysis('src', { duration: 130 })
    const issue = describeTransitionCompatibilityIssue(analysis, makeAnalysis('tgt'), { ...STREAM_META, trackKey: 'src' }, { ...STREAM_META, trackKey: 'tgt' })
    expect(issue).toContain('时长不一致')
  })

  it('时长偏差 ≤1.5s → 放行（元数据取整误差容忍）', () => {
    const analysis = makeAnalysis('src', { duration: 121 })
    expect(describeTransitionCompatibilityIssue(analysis, makeAnalysis('tgt'), { ...STREAM_META, trackKey: 'src' }, { ...STREAM_META, trackKey: 'tgt' })).toBeNull()
  })

  it('流时长未知（0/NaN）→ 不做时长拦截', () => {
    const analysis = makeAnalysis('src', { duration: 130 })
    expect(describeTransitionCompatibilityIssue(analysis, makeAnalysis('tgt'), { ...STREAM_META, trackKey: 'src', duration: 0 }, { ...STREAM_META, trackKey: 'tgt' })).toBeNull()
  })

  it('任一侧多声道（>2ch）→ 拦截', () => {
    const ok = makeAnalysis('ok', { audioFormat: { sampleRate: 44100, channels: 2 } })
    const surround = makeAnalysis('surround', { audioFormat: { sampleRate: 48000, channels: 6 } })
    expect(describeTransitionCompatibilityIssue(surround, ok, { ...STREAM_META, trackKey: 'surround' }, { ...STREAM_META, trackKey: 'ok' })).toContain('多声道')
    expect(describeTransitionCompatibilityIssue(ok, surround, { ...STREAM_META, trackKey: 'ok' }, { ...STREAM_META, trackKey: 'surround' })).toContain('多声道')
  })

  it('mono/立体声差异与采样率差异不拦截（渲染器已上混/重采样）', () => {
    const mono = makeAnalysis('mono', { audioFormat: { sampleRate: 44100, channels: 1 } })
    const stereo = makeAnalysis('stereo', { audioFormat: { sampleRate: 48000, channels: 2 } })
    expect(describeTransitionCompatibilityIssue(mono, stereo, { ...STREAM_META, trackKey: 'mono' }, { ...STREAM_META, trackKey: 'stereo' })).toBeNull()
  })

  it('audioFormat 缺失 → 不做声道拦截（旧缓存兼容）', () => {
    const a = makeAnalysis('a')
    const b = makeAnalysis('b')
    expect(describeTransitionCompatibilityIssue(a, b, { ...STREAM_META, trackKey: 'a' }, { ...STREAM_META, trackKey: 'b' })).toBeNull()
  })
})
