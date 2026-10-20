import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import type { V3EngineParams } from '../src/types'

function run(p: V3EngineParams, l: Float32Array, r: Float32Array, sizes: number[]) {
  const engine = new EngineV3(p.sampleRate)
  engine.setParams(p)
  const outL = new Float32Array(l.length)
  const outR = new Float32Array(r.length)
  let offset = 0
  let block = 0
  while (offset < l.length) {
    const end = Math.min(l.length, offset + sizes[block++ % sizes.length])
    engine.process([l.subarray(offset, end), r.subarray(offset, end)],
      [outL.subarray(offset, end), outR.subarray(offset, end)])
    offset = end
  }
  return { outL, outR, stats: engine.getStats(), analysis: engine.getAnalysis() }
}

function error(a: Float32Array, b: Float32Array) {
  let e = 0
  for (let i = 0; i < a.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]))
  return e
}

describe('EngineV3 采样时钟与块长无关', () => {
  it('手动音量、旋转、IEQ 与限幅在整段/128/不规则尾块下逐样本一致', () => {
    const p = createDefaultParams(48000)
    p.loudnessNormalization = { ...p.loudnessNormalization, enabled: true, useRealtimeMeter: false,
      minGainDb: -60, externalGainDb: -6 }
    p.surround3d.enabled = true
    p.surround3d.speed = 2
    p.ieq.enabled = true
    p.eq.proBands[3].gain = 3
    const n = 48000 + 37
    const l = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(i * 0.1))
    const r = Float32Array.from({ length: n }, (_, i) => 0.15 * Math.sin(i * 0.03))
    const reference = run(p, l, r, [n])
    for (const sizes of [[128], [17, 513, 11, 64]]) {
      const actual = run(p, l, r, sizes)
      expect(error(actual.outL, reference.outL)).toBeLessThan(2e-6)
      expect(error(actual.outR, reference.outR)).toBeLessThan(2e-6)
      expect(error(actual.analysis.spectrum!, reference.analysis.spectrum!)).toBeLessThan(2e-4)
      expect(actual.stats.lufsIntegrated).toBeCloseTo(reference.stats.lufsIntegrated, 5)
    }
  })

  it('频谱和 IEQ 使用双声道功率，反相立体声不会被误判静音', () => {
    const p = createDefaultParams(48000)
    p.eq.enabled = false
    p.limiter.enabled = false
    p.ieq.enabled = true
    const l = Float32Array.from({ length: 8192 }, (_, i) => 0.1 * Math.sin(i * 0.13))
    const mono = run(p, l, l, [128])
    const anti = run(p, l, Float32Array.from(l, (x) => -x), [57, 19])
    expect(mono.analysis.features!.rms).toBeGreaterThan(0.03)
    expect(anti.analysis.features!.rms).toBeCloseTo(mono.analysis.features!.rms, 5)
    expect(error(anti.analysis.spectrum!, mono.analysis.spectrum!)).toBeLessThan(2e-4)
    expect(error(anti.outL, mono.outL)).toBeLessThan(2e-6)
  })

  it('reset 清除自动归一化旧曲目的目标增益', () => {
    const p = createDefaultParams(8000)
    p.eq.enabled = false
    p.limiter.enabled = false
    p.loudnessNormalization.enabled = true
    const reused = new EngineV3(8000)
    reused.setParams(p)
    const quiet = Float32Array.from({ length: 8000 }, (_, i) => 0.01 * Math.sin(i * 0.2))
    reused.process([quiet, quiet], [new Float32Array(8000), new Float32Array(8000)])
    reused.reset()
    const fresh = new EngineV3(8000)
    fresh.setParams(p)
    const input = Float32Array.from({ length: 700 }, (_, i) => 0.1 * Math.sin(i * 0.2))
    const a = new Float32Array(700)
    const b = new Float32Array(700)
    reused.process([input, input], [a, new Float32Array(700)])
    fresh.process([input, input], [b, new Float32Array(700)])
    expect(error(a, b)).toBeLessThan(1e-7)
  })

  it('自动归一化对输入测量，充分收敛到目标而非仅完成一半补偿', () => {
    const p = createDefaultParams(8000)
    p.eq.enabled = false
    p.limiter.enabled = false
    p.loudnessNormalization = { ...p.loudnessNormalization, enabled: true,
      targetLufs: -14, minGainDb: -20, maxGainDb: 20 }
    const n = 8000 * 18
    const l = Float32Array.from({ length: n }, (_, i) => 0.04 * Math.sin(2 * Math.PI * 1000 * i / 8000))
    const r = l.slice()
    const whole = run(p, l, r, [n])
    const blocks = run(p, l, r, [97, 31, 511])
    expect(error(whole.outL, blocks.outL)).toBeLessThan(2e-6)
    let power = 0
    for (let i = n - 8000; i < n; i++) power += whole.outL[i] ** 2
    const gainDb = 10 * Math.log10(power / 8000 / (0.04 ** 2 / 2))
    // 用未归一化的同采样率输入测量作为标准，避免依赖采样率 K 加权差异。
    const inputParams = createDefaultParams(8000)
    inputParams.eq.enabled = false
    inputParams.limiter.enabled = false
    const input = run(inputParams, l, r, [128])
    expect(gainDb).toBeCloseTo(-14 - input.stats.lufsIntegrated, 0)
  })
})
