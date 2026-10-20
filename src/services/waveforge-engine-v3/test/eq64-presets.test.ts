import { describe, expect, it } from 'vitest'
import { buildEq64Curve, EQ_64_Q } from '../src/engine/EqCurve64'
import { PRO_EQ_64_BANDS } from '../src/types'

describe('64 段 EQ 预设曲线', () => {
  it('平直预设展开为 64 段全 0、Q=8.9、20Hz–20kHz 对数递增', () => {
    const bands = buildEq64Curve([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(bands).toHaveLength(PRO_EQ_64_BANDS.length)
    expect(bands[0].frequency).toBeCloseTo(20, 1)
    expect(bands.at(-1)!.frequency).toBeCloseTo(20000, 0)
    expect(bands.every((band) => band.gain === 0)).toBe(true)
    expect(bands.every((band) => band.q === EQ_64_Q)).toBe(true)
    for (let i = 1; i < bands.length; i++) expect(bands[i].frequency).toBeGreaterThan(bands[i - 1].frequency)
  })

  it('trims 在目标频段产生窄带增量，且不产生 -0', () => {
    const gains = [3, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5]
    const base = buildEq64Curve(gains)
    const trimmed = buildEq64Curve(gains, [[315, -0.6], [12500, 0.8]])
    const nearest = (bands: ReturnType<typeof buildEq64Curve>, frequency: number) =>
      bands.reduce((best, band) =>
        Math.abs(Math.log(band.frequency / frequency)) < Math.abs(Math.log(best.frequency / frequency)) ? band : best)
    expect(nearest(trimmed, 315).gain).toBeLessThan(nearest(base, 315).gain)
    expect(nearest(trimmed, 12500).gain).toBeGreaterThan(nearest(base, 12500).gain)
    expect(trimmed.some((band) => Object.is(band.gain, -0))).toBe(false)
  })

  it('极端增益仍落在引擎可接受范围（±24dB）', () => {
    const bands = buildEq64Curve([24, -24, 24, -24, 24, -24, 24, -24, 24, -24])
    expect(bands.every((band) => Math.abs(band.gain) <= 24)).toBe(true)
  })
})
