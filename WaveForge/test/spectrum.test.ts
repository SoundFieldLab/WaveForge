import { describe, it, expect } from 'vitest'
import {
  spectrumDbMap,
  applyAttackDecay,
  compressSpectrumBands,
  buildLogBandEdges,
  SPECTRUM_MIN_FREQ,
  SPECTRUM_MAX_FREQ,
} from '../src/utils/spectrum'

describe('spectrumDbMap（dB 地板/天花板映射）', () => {
  it('静音（0）映射为 0', () => {
    expect(spectrumDbMap(0)).toBe(0)
  })

  it('低于 -72dB 地板的微小幅度映射为 0', () => {
    // 10^(-72/20) ≈ 2.51e-4
    expect(spectrumDbMap(0.0001)).toBe(0)
  })

  it('高于 -12dB 天花板的强信号映射为 1', () => {
    // 10^(-12/20) ≈ 0.251
    expect(spectrumDbMap(1)).toBe(1)
    expect(spectrumDbMap(0.5)).toBe(1)
  })

  it('地板与天花板之间单调递增', () => {
    let previous = -1
    for (let i = 1; i <= 20; i += 1) {
      const v = spectrumDbMap(i / 200)
      expect(v).toBeGreaterThanOrEqual(previous)
      previous = v
    }
  })

  it('超过 1 的输入被钳制', () => {
    expect(spectrumDbMap(1.9)).toBe(1)
    expect(spectrumDbMap(-0.5)).toBe(0)
  })
})

describe('applyAttackDecay（逐频段 attack/decay 平滑）', () => {
  it('上升快：从 0 到 1 一个周期内接近目标', () => {
    const prev = new Float32Array([0])
    const next = new Float32Array([1])
    const out = applyAttackDecay(prev, next, 0.5, 0.5)
    expect(out[0]).toBeGreaterThan(0.4)
    expect(out[0]).toBeLessThan(0.6)
  })

  it('回落慢：从 1 到 0 只下降部分幅度', () => {
    const prev = new Float32Array([1])
    const next = new Float32Array([0])
    const out = applyAttackDecay(prev, next, 0.1, 0.35)
    // decay=0.35：新值 = 1 + (0-1)*0.35 = 0.65
    expect(Math.abs(out[0] - 0.65)).toBeLessThan(0.001)
  })

  it('attack 快于 decay：能量上升跟随更快', () => {
    const prev = new Float32Array([0])
    const rise = applyAttackDecay(prev, new Float32Array([1]), 0.8, 0.4)
    const fall = applyAttackDecay(new Float32Array([1]), new Float32Array([0]), 0.8, 0.4)
    // 上升 0.8 > 下降 0.4（从 1 掉到 0.6）
    expect(rise[0]).toBeGreaterThan(fall[0])
  })

  it('长度以两者最小值为准', () => {
    const out = applyAttackDecay(new Float32Array([0, 0, 0]), new Float32Array([1, 1]), 0.5, 0.5)
    expect(out.length).toBe(2)
  })
})

describe('compressSpectrumBands（频段压缩）', () => {
  it('24 段压成 12 段：长度正确', () => {
    const input = new Float32Array(24).fill(0.5)
    const out = compressSpectrumBands(input, 12)
    expect(out.length).toBe(12)
  })

  it('全 0 输入输出全 0', () => {
    const out = compressSpectrumBands(new Float32Array(24), 12)
    expect(Array.from(out).every((v) => v === 0)).toBe(true)
  })

  it('均匀输入压缩后保持均匀', () => {
    const out = compressSpectrumBands(new Float32Array(24).fill(0.6), 12)
    expect(Math.abs(out[0] - 0.6)).toBeLessThan(1e-6)
    expect(Math.abs(out[11] - 0.6)).toBeLessThan(1e-6)
  })

  it('峰值被保留在对应压缩段内', () => {
    const input = new Float32Array(24)
    input[6] = 1
    const out = compressSpectrumBands(input, 12)
    // per = 24/12 = 2：原始段 6 落在压缩段 [6/2, 8/2) = 第 3 段
    expect(out[3]).toBeGreaterThan(0)
    expect(out[0]).toBe(0)
  })
})

describe('buildLogBandEdges（对数频段边界）', () => {
  it('首尾与频率范围一致', () => {
    const edges = buildLogBandEdges(24)
    expect(edges[0]).toBeCloseTo(SPECTRUM_MIN_FREQ)
    expect(edges[24]).toBeCloseTo(SPECTRUM_MAX_FREQ)
  })

  it('边界严格递增且为 25 个（24 段）', () => {
    const edges = buildLogBandEdges(24)
    expect(edges.length).toBe(25)
    for (let i = 1; i < edges.length; i += 1) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1])
    }
  })

  it('对数分布：低频段间距小、高频段间距大', () => {
    const edges = buildLogBandEdges(24)
    const lowGap = edges[1] - edges[0]
    const highGap = edges[24] - edges[23]
    expect(highGap).toBeGreaterThan(lowGap * 3)
  })
})
