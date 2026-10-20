import { describe, expect, it } from 'vitest'
import { buildEq64Curve, EQ_64_Q, EQ_TRIM_HIGH_HZ, EQ_TRIM_LOW_HZ } from '../src/engine/EqCurve64'
import { PRO_EQ_64_BANDS } from '../src/types'

function nearest(bands: ReturnType<typeof buildEq64Curve>, frequency: number) {
  return bands.reduce((best, band) =>
    Math.abs(Math.log(band.frequency / frequency)) < Math.abs(Math.log(best.frequency / frequency)) ? band : best)
}

describe('64 段 EQ 预设曲线（音乐频点锚点）', () => {
  it('空锚点 = 64 段全平直，Q=8.9，20Hz–20kHz 对数递增', () => {
    const bands = buildEq64Curve([])
    expect(bands).toHaveLength(PRO_EQ_64_BANDS.length)
    expect(bands[0].frequency).toBeCloseTo(20, 1)
    expect(bands.at(-1)!.frequency).toBeCloseTo(20000, 0)
    expect(bands.every((band) => band.gain === 0)).toBe(true)
    expect(bands.every((band) => band.q === EQ_64_Q)).toBe(true)
    for (let i = 1; i < bands.length; i++) expect(bands[i].frequency).toBeGreaterThan(bands[i - 1].frequency)
  })

  it('30Hz 以下 / 16kHz 以上不做微调，可听区内按音乐频点锚点插值', () => {
    const bands = buildEq64Curve([[40, -6], [60, 3], [200, -1.5], [1000, 0], [3000, 2], [16000, 4]])
    for (const band of bands) {
      if (band.frequency < EQ_TRIM_LOW_HZ || band.frequency > EQ_TRIM_HIGH_HZ) expect(band.gain).toBe(0)
    }
    expect(nearest(bands, 60).gain).toBeGreaterThan(2.5)
    expect(nearest(bands, 200).gain).toBeCloseTo(-1.5, 0)
    expect(nearest(bands, 3000).gain).toBeGreaterThan(1.5)
    // 16kHz 以上不再微调：最后一个可听频段（约 14.4kHz）仍按 12.5k→16k 锚点插值抬升。
    expect(nearest(bands, 14000).gain).toBeGreaterThan(1)
  })

  it('支持 ±5dB 的激进预设，且不产生 -0', () => {
    const bands = buildEq64Curve([[55, 5], [4000, -5], [12500, 4]])
    expect(Math.max(...bands.map((band) => band.gain))).toBeGreaterThanOrEqual(4.5)
    expect(Math.min(...bands.map((band) => band.gain))).toBeLessThanOrEqual(-4.5)
    expect(bands.some((band) => Object.is(band.gain, -0))).toBe(false)
  })
})
