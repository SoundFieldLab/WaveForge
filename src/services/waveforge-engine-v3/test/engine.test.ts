/**
 * EngineV3 引擎总成单元测试（F1）
 *
 * 断言物理意义说明：
 *  - 零输入零输出：全链滤波/动态模块在零输入零状态时输出必须为静音；
 *  - 确定性：同输入同参数两次处理逐样本一致（引擎无随机/无时间依赖）；
 *  - 限幅峰值约束：0dBFS 正弦经 -1dBFS 前瞻限幅器后峰值 ≤ 阈值 + 0.1dB 容差；
 *  - 数值容差取 1e-3~1e-6 量级（浮点累加误差），dB 类断言用 0.1dB 容差。
 */

import { describe, it, expect } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { SCENE_PRESETS } from '../src/engine/ScenePresets'
import { createDefaultParams, PRO_EQ_DEFAULT_BANDS } from '../src/types'
import type { V3EngineParams } from '../src/types'

/** 确定性伪随机序列（LCG，避免 Math.random） */
function lcg(seed: number, n: number): Float32Array {
  const out = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    out[i] = (s / 0xffffffff) * 2 - 1
  }
  return out
}

describe('EngineV3 链确定性', () => {
  it('零输入产生零输出', () => {
    const engine = new EngineV3(48000)
    const z1 = new Float32Array(128)
    const z2 = new Float32Array(128)
    const o1 = new Float32Array(128)
    const o2 = new Float32Array(128)
    engine.process([z1, z2], [o1, o2])
    for (let i = 0; i < 128; i++) {
      expect(Math.abs(o1[i])).toBeLessThan(1e-6)
      expect(Math.abs(o2[i])).toBeLessThan(1e-6)
    }
  })

  it('同输入同参数两次处理结果逐样本一致', () => {
    const fs = 44100
    const n = 1024
    const e1 = new EngineV3(fs)
    const e2 = new EngineV3(fs)
    const noise = lcg(12345, n)
    const L1 = new Float32Array(n)
    const R1 = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      L1[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / fs) + 0.2 * noise[i]
      R1[i] = 0.6 * Math.sin((2 * Math.PI * 554 * i) / fs) + 0.2 * noise[i]
    }
    const L2 = new Float32Array(L1)
    const R2 = new Float32Array(R1)
    const oa = new Float32Array(n)
    const ob = new Float32Array(n)
    const oc = new Float32Array(n)
    const od = new Float32Array(n)
    e1.process([L1, R1], [oa, ob])
    e2.process([L2, R2], [oc, od])
    for (let i = 0; i < n; i++) {
      expect(oa[i]).toBeCloseTo(oc[i], 6)
      expect(ob[i]).toBeCloseTo(od[i], 6)
    }
  })

  it('reset 后可继续处理且无异常', () => {
    const engine = new EngineV3(48000)
    const n = 128
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    const o1 = new Float32Array(n)
    const o2 = new Float32Array(n)
    engine.process([L, R], [o1, o2])
    engine.reset()
    engine.process([L, R], [o1, o2])
    for (let i = 0; i < n; i++) {
      expect(Math.abs(o1[i])).toBeLessThan(1e-6)
    }
  })
})

describe('EngineV3 参数鲁棒性', () => {
  it('场景/极端参数切换不产生 NaN/Infinity', () => {
    const engine = new EngineV3(48000)
    const n = 512
    const noise = lcg(99, n)
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      L[i] = 0.5 * noise[i]
      R[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 48000) + 0.2 * noise[i]
    }
    const o1 = new Float32Array(n)
    const o2 = new Float32Array(n)

    // 全部 11 个场景快照
    const paramsList: V3EngineParams[] = SCENE_PRESETS.map((sc) => sc.params)

    // 极端参数：全模块开启 + 极限值（仍在契约允许范围内）
    const extreme = createDefaultParams(48000)
    extreme.eq.enabled = true
    extreme.eq.bandCount = 20
    extreme.eq.proBands = PRO_EQ_DEFAULT_BANDS.map((f, i) => ({
      frequency: f,
      gain: i % 2 === 0 ? 12 : -12,
      q: 0.3,
    }))
    extreme.eq.qCompensation = true
    extreme.deesser.enabled = true
    extreme.deesser.centerHz = 4000
    extreme.deesser.q = 0.2
    extreme.deesser.thresholdDb = -60
    extreme.deesser.ratio = 20
    extreme.compressor.enabled = true
    extreme.compressor.thresholdDb = -60
    extreme.compressor.ratio = 20
    extreme.compressor.kneeDb = 0
    extreme.compressor.attackMs = 0.1
    extreme.compressor.releaseMs = 500
    extreme.nightMode.enabled = true
    extreme.nightMode.amount = 10
    extreme.bassEnhancer.enabled = true
    extreme.bassEnhancer.cutoffHz = 200
    extreme.bassEnhancer.harmonicType = 'atan'
    extreme.bassEnhancer.harmonicGain = 1
    extreme.bassEnhancer.mix = 1
    extreme.bassEnhancer.levelDb = 6
    extreme.reverb.enabled = true
    extreme.reverb.mode = 'algorithmic'
    extreme.reverb.algorithmic.type = 'hall'
    extreme.reverb.algorithmic.roomSize = 0.95
    extreme.reverb.algorithmic.damping = 0.1
    extreme.reverb.algorithmic.wet = 0.8
    extreme.reverb.algorithmic.dry = 0.5
    extreme.reverb.algorithmic.preDelayMs = 30
    extreme.reverb.algorithmic.width = 2
    extreme.surround3d.enabled = true
    extreme.surround3d.speed = 2
    extreme.surround3d.angle = 90
    extreme.loudnessCompensation.enabled = true
    extreme.loudnessCompensation.mode = 'custom'
    extreme.loudnessCompensation.bands = [
      { frequency: 60, gain: 12 },
      { frequency: 250, gain: 6 },
      { frequency: 1000, gain: 0 },
      { frequency: 8000, gain: 6 },
    ]
    extreme.loudnessCompensation.volumePercent = 10
    extreme.loudnessCompensation.maxBoostDb = 12
    extreme.loudnessCompensation.smoothingSeconds = 0.05
    extreme.loudnessNormalization.enabled = true
    extreme.loudnessNormalization.targetLufs = -14
    extreme.loudnessNormalization.maxGainDb = 9
    extreme.loudnessNormalization.minGainDb = -9
    extreme.loudnessNormalization.useRealtimeMeter = true
    extreme.limiter.enabled = true
    extreme.limiter.thresholdDb = -0.1
    extreme.limiter.lookaheadMs = 10
    extreme.limiter.attackMs = 0.1
    extreme.limiter.releaseMs = 300
    extreme.limiter.truePeak = true
    extreme.ieq.enabled = true
    extreme.ieq.strength = 1
    extreme.ieq.targetCurve = 'bright'
    extreme.ieq.timeConstantSec = 0.1
    extreme.stereoWidth = 2
    extreme.pitch.voiceBalance = 1
    paramsList.push(extreme)

    for (const p of paramsList) {
      engine.setParams(p)
      engine.process([L, R], [o1, o2])
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(o1[i])).toBe(true)
        expect(Number.isFinite(o2[i])).toBe(true)
      }
    }
  })

  it('应用场景快照不修改传入参数，处理输出有效', () => {
    for (const sc of SCENE_PRESETS) {
      const engine = new EngineV3(48000)
      const before = JSON.stringify(sc.params)
      engine.setParams(sc.params)
      const after = JSON.stringify(sc.params)
      expect(after).toBe(before)
      const n = 512
      const noise = lcg(7, n)
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        L[i] = 0.4 * noise[i]
        R[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / 48000) + 0.2 * noise[i]
      }
      const o1 = new Float32Array(n)
      const o2 = new Float32Array(n)
      engine.process([L, R], [o1, o2])
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(o1[i])).toBe(true)
        expect(Number.isFinite(o2[i])).toBe(true)
      }
    }
  })
})

describe('EngineV3 限幅与统计', () => {
  it('0dBFS 正弦输出峰值不超过 -1dBFS 阈值 + 0.1dB', () => {
    const engine = new EngineV3(48000)
    const n = 48000 // 1s，足够越过限幅器 attack
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = Math.sin((2 * Math.PI * 3000 * i) / 48000) // 0dBFS
      L[i] = x
      R[i] = x
    }
    const o1 = new Float32Array(n)
    const o2 = new Float32Array(n)
    engine.process([L, R], [o1, o2])
    let peak = 0
    for (let i = 0; i < n; i++) {
      const a = Math.abs(o1[i])
      const b = Math.abs(o2[i])
      if (a > peak) peak = a
      if (b > peak) peak = b
    }
    const thresholdPeak = Math.pow(10, -1 / 20) // -1dBFS 的线性峰值
    const tolerance = Math.pow(10, 0.1 / 20) // +0.1dB 容差
    expect(peak).toBeLessThanOrEqual(thresholdPeak * tolerance + 1e-4)
    // 且确实被限制（远小于 1.0）
    expect(peak).toBeLessThan(0.99)
  })

  it('stats 更新：处理 2s 音频后响度/峰值统计为有限值，限幅衰减 <= 0', () => {
    const engine = new EngineV3(48000)
    const n = 48000 * 2
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000)
      L[i] = x
      R[i] = x
    }
    const o1 = new Float32Array(n)
    const o2 = new Float32Array(n)
    engine.process([L, R], [o1, o2])
    const st = engine.getStats()
    expect(Number.isFinite(st.lufsIntegrated)).toBe(true)
    expect(Number.isFinite(st.lufsMomentary)).toBe(true)
    expect(Number.isFinite(st.peakDb)).toBe(true)
    expect(Number.isFinite(st.truePeakDb)).toBe(true)
    expect(st.limiterReductionDb).toBeLessThanOrEqual(0)
    expect(st.engineLatencySamples).toBeGreaterThanOrEqual(0)
    // 1kHz 0.5 幅度正弦：样本峰值 ≈ -6dBFS；K 加权/真峰值测量可能引入 ±1dB 偏移，
    // 故用宽区间 [-8, -4] 断言（物理意义：峰值统计量级正确且有限）
    expect(st.peakDb).toBeGreaterThan(-8)
    expect(st.peakDb).toBeLessThan(-4)
  })

  it('latency 计算：默认 ≥ 限幅器前瞻样本；禁用限幅器+无混响 = 0', () => {
    const engine = new EngineV3(48000)
    const lat = engine.getLatencySamples()
    expect(lat).toBeGreaterThanOrEqual(Math.round(48000 * 0.005) - 1)
    const p = createDefaultParams(48000)
    p.limiter.enabled = false
    p.reverb.enabled = false
    engine.setParams(p)
    expect(engine.getLatencySamples()).toBe(0)
  })
})

describe('EngineV3 分析', () => {
  it('getAnalysis：处理足够音频后返回 1025 bin 频谱与特征', () => {
    const engine = new EngineV3(48000)
    const n = 48000 // 1s
    const L = new Float32Array(n)
    const R = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / 48000)
      L[i] = x
      R[i] = x
    }
    const o1 = new Float32Array(n)
    const o2 = new Float32Array(n)
    engine.process([L, R], [o1, o2])
    const a = engine.getAnalysis()
    expect(a.spectrum).not.toBeNull()
    expect(a.spectrum!.length).toBe(1025) // 2048/2+1
    expect(a.features).not.toBeNull()
    // 1kHz 单音 → 频谱质心应接近 1000Hz（±40% 宽容差，Hann 泄漏影响）
    expect(a.features!.centroidHz).toBeGreaterThan(600)
    expect(a.features!.centroidHz).toBeLessThan(1600)
    // 单音 → 频谱平坦度远小于 1（接近 0）
    expect(a.features!.flatness).toBeLessThan(0.5)
    expect(Number.isFinite(a.features!.rms)).toBe(true)
    expect(Number.isFinite(a.features!.zcr)).toBe(true)
    expect(Number.isFinite(a.features!.rolloffHz)).toBe(true)
    expect(Number.isFinite(a.features!.crest)).toBe(true)
  })

  it('getAnalysis：未处理任何音频时返回 null', () => {
    const engine = new EngineV3(48000)
    const a = engine.getAnalysis()
    expect(a.spectrum).toBeNull()
    expect(a.features).toBeNull()
  })
})

describe('EngineV3 辅助', () => {
  it('getStretch 返回变速/变调处理器', () => {
    const engine = new EngineV3(48000)
    const st = engine.getStretch()
    expect(st).toBeDefined()
    expect(typeof st.setParams).toBe('function')
    expect(typeof st.reset).toBe('function')
    st.setParams({ semitones: 0, rate: 1 })
  })

  it('单声道通道数（channelCount=1）处理不抛异常且输出有限', () => {
    const engine = new EngineV3(48000, 1)
    const n = 256
    const noise = lcg(5, n)
    const L = new Float32Array(n)
    for (let i = 0; i < n; i++) L[i] = 0.5 * noise[i]
    const o = new Float32Array(n)
    engine.process([L], [o])
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(o[i])).toBe(true)
    }
  })
})
