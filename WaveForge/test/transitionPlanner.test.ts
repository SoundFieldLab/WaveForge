import { describe, it, expect } from 'vitest'
import { planTransition, planTransitionV2 } from '../src/audio/transitionPlanner.ts'
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

  describe('响度补偿（gainOffsetDb）', () => {
    it('无 LUFS 数据时不补偿', () => {
      const plan = planTransition(SOURCE, TARGET, SMART_SETTINGS)
      expect(plan.gainOffsetDb).toBe(0)
    })

    it('target 更轻 → 正补偿（抬高目标，钳制 3.5dB）', () => {
      const plan = planTransition(
        makeAnalysis('netease-source', { integratedLufs: -14 }),
        makeAnalysis('netease-target', { integratedLufs: -18 }),
        SMART_SETTINGS,
      )
      expect(plan.gainOffsetDb).toBe(3.5)
    })

    it('target 更响 → 负补偿（压低目标，钳制 -3.5dB）', () => {
      const plan = planTransition(
        makeAnalysis('netease-source', { integratedLufs: -18 }),
        makeAnalysis('netease-target', { integratedLufs: -14 }),
        SMART_SETTINGS,
      )
      expect(plan.gainOffsetDb).toBe(-3.5)
    })

    it('补偿被钳制在 ±3.5dB', () => {
      const plan = planTransition(
        makeAnalysis('netease-source', { integratedLufs: -10 }),
        makeAnalysis('netease-target', { integratedLufs: -25 }),
        SMART_SETTINGS,
      )
      expect(plan.gainOffsetDb).toBe(3.5)
      const plan2 = planTransition(
        makeAnalysis('netease-source', { integratedLufs: -25 }),
        makeAnalysis('netease-target', { integratedLufs: -10 }),
        SMART_SETTINGS,
      )
      expect(plan2.gainOffsetDb).toBe(-3.5)
    })

    it('补偿值并入计划 id（缓存键随补偿变化）', () => {
      const planA = planTransition(
        makeAnalysis('netease-source', { integratedLufs: -14 }),
        makeAnalysis('netease-target', { integratedLufs: -18 }),
        SMART_SETTINGS,
      )
      const planB = planTransition(SOURCE, TARGET, SMART_SETTINGS)
      expect(planA.id).not.toBe(planB.id)
      expect(planA.id).toContain('3.5:')
      expect(planB.id).toContain('0.0:')
    })
  })
})

describe('planTransitionV2（AutoMix 增强版）', () => {
  it('完整网格 + 同 BPM 时使用 smart-rendered-v2 策略且带 v2 编排', () => {
    const plan = planTransitionV2(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered-v2')
    expect(plan.strategy).toBe('smart-rendered-v2')
    expect(plan.fallbackReason).toBeUndefined()
    expect(plan.rendererVersion).toContain('v2')
    expect(plan.v2).toBeDefined()
    expect(plan.v2?.choreography).toBeDefined()
    expect(plan.v2?.intensity).toBe('standard')
    expect(plan.djEffects).toBeDefined()
    expect(plan.id).toContain('smart-rendered-v2')
  })

  it('高能量（energy 0.8 / BPM 差 0）编排为 energetic：含 riser/鼓点/tempo ramp', () => {
    const plan = planTransitionV2(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered-v2')
    const choreography = plan.v2?.choreography
    expect(choreography?.style).toBe('energetic')
    expect(choreography?.riser).toBe(true)
    expect(choreography?.drumFill).toBe(true)
    expect(choreography?.tempoRampUp).toBe(true)
    expect(choreography?.drumFillBeats).toBeGreaterThan(0)
  })

  it('低能量编排为 atmospheric（reverbDip 开启，无鼓点）', () => {
    const lowEnergy = (trackKey: string) => makeAnalysis(trackKey, {
      beatFeatures: makeAnalysis(trackKey).beatFeatures.map(frame => ({ ...frame, energy: 0.1 })),
    })
    const plan = planTransitionV2(lowEnergy('netease-source'), lowEnergy('netease-target'), SMART_SETTINGS, 'smart-rendered-v2')
    expect(plan.v2?.choreography?.style).toBe('atmospheric')
    expect(plan.v2?.choreography?.reverbDip).toBe(true)
    expect(plan.v2?.choreography?.drumFill).toBe(false)
  })

  it('强度档位随设置传递', () => {
    const strong = planTransitionV2(SOURCE, TARGET, { ...SMART_SETTINGS, intensity: 'strong' }, 'smart-rendered-v2')
    expect(strong.v2?.intensity).toBe('strong')
    const subtle = planTransitionV2(SOURCE, TARGET, { ...SMART_SETTINGS, intensity: 'subtle' }, 'smart-rendered-v2')
    expect(subtle.v2?.intensity).toBe('subtle')
    // 强度影响 id（缓存键隔离）
    expect(strong.id).not.toBe(subtle.id)
  })

  it('调性检测：chroma 数据可检出 key（C 大调 → camelot 8B）', () => {
    const plan = planTransitionV2(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered-v2')
    expect(plan.v2?.key?.source).toBeDefined()
    expect(plan.v2?.key?.source?.tonic).toBe(0)
    expect(plan.v2?.key?.source?.mode).toBe('major')
    expect(plan.v2?.key?.source?.camelot).toBe(8)
    // 两曲同调 → 兼容度 1.0
    expect(plan.v2?.choreography?.keyCompat).toBe(1)
  })

  it('无 chroma 数据时调性兼容度为中性（0.5）且不报错', () => {
    const noChroma = (trackKey: string) => makeAnalysis(trackKey, {
      beatFeatures: makeAnalysis(trackKey).beatFeatures.map(frame => ({ ...frame, chroma: [] })),
    })
    const plan = planTransitionV2(noChroma('netease-source'), noChroma('netease-target'), SMART_SETTINGS, 'smart-rendered-v2')
    expect(plan.v2?.key?.source).toBeUndefined()
    expect(plan.v2?.choreography?.keyCompat).toBe(0.5)
  })

  it('beatMatching 关闭时同样降级为 beat-crossfade', () => {
    const plan = planTransitionV2(SOURCE, TARGET, { beatMatching: false, skipSilence: false }, 'smart-rendered-v2')
    expect(plan.strategy).toBe('beat-crossfade')
    expect(plan.fallbackReason).toContain('Beat matching is disabled')
    expect(plan.v2?.choreography).toBeDefined() // 编排信息仍生成（供 UI 展示），但不触发渲染
    expect(plan.djEffects).toBeUndefined()
  })

  it('BPM 差 15~100 时走特效过渡（withoutBeatGrid），不降级', () => {
    const plan = planTransitionV2(
      makeAnalysis('netease-source', { estimatedBpm: 120 }),
      makeAnalysis('netease-target', { estimatedBpm: 100 }),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.strategy).toBe('smart-rendered-v2')
    expect(plan.fallbackReason).toBeUndefined()
    expect(plan.v2?.withoutBeatGrid).toBe(true)
    expect(plan.v2?.choreography?.style).toBe('atmospheric')
    expect(plan.v2?.choreography?.drumFill).toBe(false)
  })

  it('BPM 差 >100 时降级为 fixed-crossfade', () => {
    const plan = planTransitionV2(
      makeAnalysis('netease-source', { estimatedBpm: 200 }),
      makeAnalysis('netease-target', { estimatedBpm: 90 }),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.strategy).toBe('fixed-crossfade')
    expect(plan.fallbackReason).toContain('BPM difference')
  })

  it('v2 与 v1 的计划 id 互相隔离（含强度/版本），v1 计划不带 v2 字段', () => {
    const v1 = planTransition(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered')
    const v2 = planTransitionV2(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered-v2')
    expect(v1.id).not.toBe(v2.id)
    expect(v1.id).not.toContain('smart-rendered-v2')
    expect(v2.id).toContain('smart-rendered-v2')
    expect(v1.v2).toBeUndefined()
    expect(v1.rendererVersion).toContain('pitch-preserving-beatgrid-djfx')
    expect(v2.rendererVersion).toContain('automix-v2')
  })
})

/** 按指定 BPM 构造完整节拍/重拍网格的分析对象（用于整数倍 BPM 部分同步测试） */
function makeBpmAnalysis(trackKey: string, bpm: number, duration = 120): TrackAnalysis {
  const interval = 60 / bpm
  const count = Math.floor(duration / interval)
  const base = makeAnalysis(trackKey)
  const beats: number[] = []
  const downbeats: number[] = []
  const beatConfidence: number[] = []
  const downbeatConfidence: number[] = []
  const beatFeatures: TrackAnalysis['beatFeatures'] = []
  for (let i = 0; i <= count; i += 1) {
    const time = i * interval
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
  return {
    ...base,
    beats,
    downbeats,
    beatConfidence,
    downbeatConfidence,
    beatFeatures,
    estimatedBpm: bpm,
    duration,
  }
}

describe('planTransitionV2 部分同步（整数倍 BPM 跳拍对齐，Apple 专利）', () => {
  it('140↔70（2 倍速）：快曲网格跳拍对齐（ps2），走完整智能混音', () => {
    const plan = planTransitionV2(
      makeBpmAnalysis('netease-source', 140),
      makeBpmAnalysis('netease-target', 70),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.strategy).toBe('smart-rendered-v2')
    expect(plan.fallbackReason).toBeUndefined()
    expect(plan.v2?.withoutBeatGrid).toBe(false)
    expect(plan.v2?.partialSyncN).toBe(2)
    expect(plan.id).toContain(':ps2')
    // 快曲对齐网格间隔 = 2 个 140BPM 拍 = 慢曲 70BPM 拍（~0.857s）
    expect(plan.sourceBeatTimes.length).toBe(plan.beatCount + 1)
    expect(plan.targetBeatTimes.length).toBe(plan.beatCount + 1)
    const sourceInterval = plan.sourceBeatTimes[1] - plan.sourceBeatTimes[0]
    const targetInterval = plan.targetBeatTimes[1] - plan.targetBeatTimes[0]
    expect(sourceInterval).toBeGreaterThan(0.8)
    expect(sourceInterval).toBeLessThan(0.92)
    expect(Math.abs(sourceInterval - targetInterval)).toBeLessThan(0.05)
  })

  it('60↔120（2 倍速，快曲是目标）：同样 ps2 对齐', () => {
    const plan = planTransitionV2(
      makeBpmAnalysis('netease-source', 60),
      makeBpmAnalysis('netease-target', 120),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.partialSyncN).toBe(2)
    expect(plan.v2?.withoutBeatGrid).toBe(false)
    expect(plan.strategy).toBe('smart-rendered-v2')
  })

  it('40↔120（3 倍速）：ps3', () => {
    const plan = planTransitionV2(
      makeBpmAnalysis('netease-source', 40),
      makeBpmAnalysis('netease-target', 120),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.partialSyncN).toBe(3)
    expect(plan.v2?.withoutBeatGrid).toBe(false)
  })

  it('容差内（138↔70≈1.97 倍）仍按 2 倍对齐', () => {
    const plan = planTransitionV2(
      makeBpmAnalysis('netease-source', 138),
      makeBpmAnalysis('netease-target', 70),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.partialSyncN).toBe(2)
  })

  it('BPM 差 15~100 且非整数倍（140↔88）：仍走特效过渡 withoutBeatGrid', () => {
    const plan = planTransitionV2(
      makeBpmAnalysis('netease-source', 140),
      makeBpmAnalysis('netease-target', 88),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.strategy).toBe('smart-rendered-v2')
    expect(plan.v2?.partialSyncN).toBeUndefined()
    expect(plan.v2?.withoutBeatGrid).toBe(true)
  })

  it('部分同步不触碰 v1：v1 计划 140↔70 不带 v2 字段（v1 逻辑零改动）', () => {
    const plan = planTransition(
      makeBpmAnalysis('netease-source', 140),
      makeBpmAnalysis('netease-target', 70),
      SMART_SETTINGS,
      'smart-rendered',
    )
    expect(plan.v2).toBeUndefined()
  })
})

const KRUM_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KRUM_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/** 构造指定主音/调性的分析对象：chroma 用 Krumhansl 轮廓旋转到主音 → detectKey 高置信度命中 */
function makeKeyAnalysis(trackKey: string, tonic: number, mode: 'major' | 'minor'): TrackAnalysis {
  const profile = mode === 'major' ? KRUM_MAJOR : KRUM_MINOR
  const chroma = Array.from({ length: 12 }, (_, pitch) => profile[(pitch + tonic) % 12])
  return makeAnalysis(trackKey, {
    beatFeatures: makeAnalysis(trackKey).beatFeatures.map(frame => ({ ...frame, chroma })),
  })
}

describe('planTransitionV2 谐波变调（目标窗口变调到源曲主音）', () => {
  it('同调（C 大调→C 大调）：不变调', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 0, 'major'),
      makeKeyAnalysis('netease-target', 0, 'major'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBeUndefined()
  })

  it('C 大调→D 大调（2 半音）：目标窗口变调 -2（对齐源曲主音）', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 0, 'major'),
      makeKeyAnalysis('netease-target', 2, 'major'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBe(-2)
    expect(plan.id).toContain(':pshift-2')
  })

  it('反向：D 大调→C 大调：目标窗口变调 +2', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 2, 'major'),
      makeKeyAnalysis('netease-target', 0, 'major'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBe(2)
  })

  it('C 大调→E 大调（4 半音）：超限不变调（避免失真）', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 0, 'major'),
      makeKeyAnalysis('netease-target', 4, 'major'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBeUndefined()
  })

  it('相对大小调（C 大调↔A 小调，同音集）：天然兼容不变调', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 0, 'major'),
      makeKeyAnalysis('netease-target', 9, 'minor'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBeUndefined()
  })

  it('不同调性非相对（C 大调→D 小调）：不变调（避免平行调冲突）', () => {
    const plan = planTransitionV2(
      makeKeyAnalysis('netease-source', 0, 'major'),
      makeKeyAnalysis('netease-target', 2, 'minor'),
      SMART_SETTINGS,
      'smart-rendered-v2',
    )
    expect(plan.v2?.pitchShiftSemitones).toBeUndefined()
  })

  it('低置信度（one-hot chroma，detectKey 置信度≈0.31<0.4）：不变调', () => {
    const plan = planTransitionV2(SOURCE, TARGET, SMART_SETTINGS, 'smart-rendered-v2')
    expect(plan.v2?.pitchShiftSemitones).toBeUndefined()
  })
})
