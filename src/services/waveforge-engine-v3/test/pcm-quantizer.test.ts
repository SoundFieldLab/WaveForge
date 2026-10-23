import { describe, expect, it } from 'vitest'
import { Pcm16Quantizer } from '../src/dsp/PcmQuantizer'

describe('PCM16 降位深', () => {
  it('饱和输出与非法输入保持在 Int16 范围', () => {
    const q = new Pcm16Quantizer('noiseShaped')
    expect(q.process(-2)).toBe(-32768)
    expect(q.process(2)).toBe(32767)
    expect(q.process(Number.NaN)).toBeGreaterThanOrEqual(-32768)
    expect(q.process(Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(32767)
  })

  it('TPDF 在子 LSB 电平下解除固定量化值，种子确保结果可复现', () => {
    const sample = 0.25 / 32768
    const a = new Pcm16Quantizer('tpdf', 42)
    const b = new Pcm16Quantizer('tpdf', 42)
    const values = Array.from({ length: 4096 }, () => a.process(sample))
    expect(values).toEqual(Array.from({ length: 4096 }, () => b.process(sample)))
    expect(new Set(values).size).toBeGreaterThan(1)
    expect(values.reduce((sum, value) => sum + value, 0) / values.length).toBeCloseTo(0.25, 1)
    expect(new Pcm16Quantizer('plain').process(sample)).toBe(0)
  })

  it('一阶整形降低低频量化误差', () => {
    const input = 0.234567
    const tpdf = new Pcm16Quantizer('tpdf', 99)
    const shaped = new Pcm16Quantizer('noiseShaped', 99)
    const n = 32768
    const errorA = new Float64Array(n)
    const errorB = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      errorA[i] = tpdf.process(input) / 32768 - input
      errorB[i] = shaped.process(input) / 32768 - input
    }
    const lowBandPower = (errors: Float64Array) => {
      let sum = 0
      for (let i = 32; i < n; i++) {
        let average = 0
        for (let j = 0; j < 32; j++) average += errors[i - j]
        sum += average * average
      }
      return sum / (n - 32)
    }
    expect(lowBandPower(errorB)).toBeLessThan(lowBandPower(errorA) * 0.5)
  })
})
