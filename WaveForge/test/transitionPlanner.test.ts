import { describe, it, expect } from 'vitest'
import { planTransition } from '../src/audio/transitionPlanner.ts'
import type { TrackAnalysis } from '../src/audio/types'

/**
 * 构造一份可用的 TrackAnalysis 基线：120 秒、BPM 120、完整节拍/重拍网格、
 * 高置信度。具体用例通过 overrides 覆盖字段制造降级场景。
 */
function makeAnalysis(trackKey: string, overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  const beats: number[] = []
  const downbeats: number[] = []
  const beatConfidence: number[] = []
  const downbeatConfidence: number[] = []
  const beatFeatures: TrackAnalysis['beatFeatures'] = []
  for (let i = 0; i <= 240; i += 1) {
    const time = i * 0.5 // 每 0.5s 一个节拍
    beats.push(time)
    beatConfidence.push(1)
    if (i % 4 === 0) {
      downbeats.push(time)
      downbeatConfidence.push(1)
    }
    beatFeatures.push({
      beatIndex: i,
      time,
      loudness: 0.7,
      rms: 0.1,
      chroma: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      timbre: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      vocalness: 0.5,
      energy: 0.8,
    })
  }

  const base: TrackAnalysis = {
    schemaVersion: 1,
    trackKey,
    duration: 120,
    provider: 'beat_this',
    beats,
    downbeats,
    beatConfidence,
    downbeatConfidence,
    estimatedBpm: 120,
    confidence: 0.9,
    sections: [],
    beatFeatures,
    introSilence: 0,
    outroSilence: 0,
    analysisVersion: 'v1',
    createdAt: 0,
    lastAccessAt: 0,
  }
  return { ...base, ...overrides }
}

const SOURCE = makeAnalysis('netease-source')
const TARGET = makeAnalysis('netease-target')

const SMART_SETTINGS = { beatMatching: true, skipSilence: false }

describe('planTransition（过渡计划降级逻辑）', () => {
  it('完整可靠节拍网格 + 相同 BPM 时使用智能渲染策略', () => {
    const plan = planTransition(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered')
    expect(plan.strategy).toBe('smart-rendered')
    expect(plan.fallbackReason).toBeUndefined()
    expect(plan.beatCount).toBeGreaterThan(0)
    expect(plan.sourceBpm).toBe(120)
    expect(plan.targetBpm).toBe(120)
    expect(plan.sourceBeatTimes?.length).toBe(plan.beatCount + 1)
    expect(plan.targetBeatTimes?.length).toBe(plan.beatCount + 1)
    expect(plan.tempoRamp.length).toBe(plan.beatCount)
    expect(plan.gainCurve.source.length).toBe(Math.max(32, plan.beatCount * 16))
    expect(plan.gainCurve.target.length).toBe(Math.max(32, plan.beatCount * 16))
  })

  it('beatMatching 关闭时降级为 beat-crossfade，reason 为禁用提示', () => {
    const plan = planTransition(SOURCE, TARGET, { beatMatching: false, skipSilence: false })
    expect(plan.strategy).toBe('beat-crossfade')
    expect(plan.fallbackReason).toContain('Beat matching is disabled')
    expect(plan.djEffects).toBeUndefined()
  })

  it('BPM 差超限（>5）时降级为 fixed-crossfade', () => {
    const source = makeAnalysis('netease-source', { estimatedBpm: 120 })
    const target = makeAnalysis('netease-target', { estimatedBpm: 100 })
    const plan = planTransition(source, target, SMART_SETTINGS)
    expect(plan.strategy).toBe('fixed-crossfade')
    expect(plan.fallbackReason).toContain('BPM difference')
    expect(plan.sourceBpm).toBe(120)
    expect(plan.targetBpm).toBe(100)
  })

  it('BPM 差恰好在限内（<=5）不降级', () => {
    const source = makeAnalysis('netease-source', { estimatedBpm: 120 })
    const target = makeAnalysis('netease-target', { estimatedBpm: 118 })
    const plan = planTransition(source, target, SMART_SETTINGS)
    expect(plan.strategy).toBe('beat-crossfade')
    expect(plan.fallbackReason).toBeUndefined()
  })

  it('无节拍网格时降级为 fixed-crossfade，reason 为网格不可用', () => {
    const empty = { beats: [], downbeats: [], beatConfidence: [], downbeatConfidence: [] }
    const source = makeAnalysis('netease-source', empty)
    const target = makeAnalysis('netease-target', empty)
    const plan = planTransition(source, target, SMART_SETTINGS)
    expect(plan.strategy).toBe('fixed-crossfade')
    expect(plan.fallbackReason).toContain('Reliable beat/downbeat features')
  })

  it('低置信度（0.4）且无网格时降级为 fixed-crossfade', () => {
    const empty = { beats: [], downbeats: [], beatConfidence: [], downbeatConfidence: [], confidence: 0.4 }
    const plan = planTransition(
      makeAnalysis('netease-source', empty),
      makeAnalysis('netease-target', empty),
      SMART_SETTINGS,
    )
    expect(plan.strategy).toBe('fixed-crossfade')
    expect(plan.fallbackReason).toContain('Reliable beat/downbeat features')
  })

  it('负置信度被 clamp 到 0', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { confidence: -5 }),
      makeAnalysis('netease-target', { confidence: -5 }),
      SMART_SETTINGS,
    )
    expect(plan.confidence).toBe(0)
  })

  it('超高置信度被 clamp 到 1', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { confidence: 5 }),
      makeAnalysis('netease-target', { confidence: 5 }),
      SMART_SETTINGS,
    )
    expect(plan.confidence).toBe(1)
  })

  it('confidence 始终位于 [0,1] 区间', () => {
    for (const conf of [-1, 0, 0.3, 0.9, 1, 2]) {
      const plan = planTransition(
        makeAnalysis('netease-source', { confidence: conf }),
        makeAnalysis('netease-target', { confidence: conf }),
        SMART_SETTINGS,
      )
      expect(plan.confidence).toBeGreaterThanOrEqual(0)
      expect(plan.confidence).toBeLessThanOrEqual(1)
    }
  })
})

describe('planTransition（safeBpm 边界钳制）', () => {
  it('BPM 缺失（0）时回退为默认 120', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { estimatedBpm: 0 }),
      makeAnalysis('netease-target', { estimatedBpm: 120 }),
      SMART_SETTINGS,
    )
    expect(plan.sourceBpm).toBe(120)
  })

  it('BPM 非数字（NaN）时回退为默认 120', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { estimatedBpm: Number.NaN }),
      makeAnalysis('netease-target', { estimatedBpm: 120 }),
      SMART_SETTINGS,
    )
    expect(plan.sourceBpm).toBe(120)
  })

  it('BPM 低于下限时钳制到 40', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { estimatedBpm: 20 }),
      makeAnalysis('netease-target', { estimatedBpm: 120 }),
      SMART_SETTINGS,
    )
    expect(plan.sourceBpm).toBe(40)
  })

  it('BPM 高于上限时钳制到 240', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { estimatedBpm: 500 }),
      makeAnalysis('netease-target', { estimatedBpm: 120 }),
      SMART_SETTINGS,
    )
    expect(plan.sourceBpm).toBe(240)
  })

  it('BPM 处于正常范围时保持不变', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { estimatedBpm: 128 }),
      makeAnalysis('netease-target', { estimatedBpm: 96 }),
      SMART_SETTINGS,
    )
    expect(plan.sourceBpm).toBe(128)
    expect(plan.targetBpm).toBe(96)
  })
})

describe('planTransition（时间窗口与时长）', () => {
  it('minDuration/maxDuration 被钳制在 [1,20] 且 min<=max', () => {
    const plan = planTransition(SOURCE, TARGET, {
      ...SMART_SETTINGS,
      minDuration: 99,
      maxDuration: 0,
    })
    // 钳制后 min=20, max=20，beatCount 相应为最大合法值 32
    expect(plan.beatCount).toBe(32)
    const planDuration = plan.beatCount * (60 / ((plan.sourceBpm + plan.targetBpm) / 2))
    expect(planDuration).toBeLessThanOrEqual(20)
  })

  it('skipSilence 开启时目标窗口跳过 intro 静音段', () => {
    const plan = planTransition(SOURCE, makeAnalysis('netease-target', { introSilence: 8 }), {
      ...SMART_SETTINGS,
      skipSilence: true,
    })
    expect(plan.targetStartTime).toBeGreaterThanOrEqual(8)
  })

  it('节拍选择落在默认拍数集合内', () => {
    for (const bpm of [60, 120, 180]) {
      const plan = planTransition(
        makeAnalysis('netease-source', { estimatedBpm: bpm }),
        makeAnalysis('netease-target', { estimatedBpm: bpm }),
        SMART_SETTINGS,
      )
      expect([8, 16, 24, 32]).toContain(plan.beatCount)
    }
  })

  it('生成的 id 包含来源与目标曲目键', () => {
    const plan = planTransition(SOURCE, TARGET, SMART_SETTINGS)
    expect(plan.id).toContain('netease-source')
    expect(plan.id).toContain('netease-target')
    expect(plan.sourceTrackKey).toBe('netease-source')
    expect(plan.targetTrackKey).toBe('netease-target')
  })

  it('不同 analysisVersion 时标记 mixed-analysis', () => {
    const plan = planTransition(
      makeAnalysis('netease-source', { analysisVersion: 'v1' }),
      makeAnalysis('netease-target', { analysisVersion: 'v2' }),
      SMART_SETTINGS,
    )
    expect(plan.analysisVersion).toBe('mixed-analysis')
  })

  it('相同 analysisVersion 时沿用该版本号', () => {
    const plan = planTransition(SOURCE, TARGET, SMART_SETTINGS)
    expect(plan.analysisVersion).toBe('v1')
  })
})
