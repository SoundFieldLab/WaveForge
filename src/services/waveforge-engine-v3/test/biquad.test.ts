/**
 * biquad.test.ts —— biquad.ts 单元测试
 * 数值容差说明：
 *  - 幅度断言用 1e-4/1e-3 量级（物理意义：0dB 峰形滤波器应全频带单位增益；
 *    +6dB 峰形在中心频率幅度=10^(6/20)≈1.9953）。
 *  - shelf 抵消断言 ±0.05dB（物理意义：同频点同 Q 的 +g/−g 级联应还原平直）。
 */
import { describe, it, expect } from 'vitest'
import { Biquad, designBiquad } from '../src/dsp/biquad'
import type { BiquadType } from '../src/dsp/biquad'

const FS = 48000

describe('designBiquad / Biquad 幅频', () => {
  it('peaking 0dB 增益 → 全频带增益≈1（0dB 峰形滤波器数学上恒为平直）', () => {
    const c = designBiquad('peaking', 1000, 1, 0, FS)
    const bq = new Biquad()
    bq.setCoeffs(c)
    for (const f of [100, 1000, 5000, 15000]) {
      expect(Math.abs(bq.magnitudeAt(f, FS) - 1)).toBeLessThan(1e-4)
    }
  })

  it('peaking +6dB @1kHz Q1 → 中心频率幅度≈2（10^(6/20)=1.9953，±2%）', () => {
    const bq = new Biquad('peaking', 1000, 1, 6, FS)
    const mag = bq.magnitudeAt(1000, FS)
    expect(Math.abs(mag - 1.9953) / 1.9953).toBeLessThan(0.02)
  })

  it('lowpass 截止 1kHz @10kHz 衰减 >20dB（十倍频程外应深度衰减）', () => {
    const bq = new Biquad('lowpass', 1000, 0.707, 0, FS)
    expect(bq.magnitudeAt(10000, FS)).toBeLessThan(0.1) // 10^(-20/20)
  })

  it('low/high shelf 公式对称性：同频点同 Q 的 +g 与 −g 级联 ≈ 0dB', () => {
    const up = new Biquad('lowshelf', 200, 0.707, 6, FS)
    const dn = new Biquad('lowshelf', 200, 0.707, -6, FS)
    for (const f of [20, 60, 200, 1000, 8000]) {
      const mag = up.magnitudeAt(f, FS) * dn.magnitudeAt(f, FS)
      expect(Math.abs(20 * Math.log10(mag))).toBeLessThan(0.05)
    }
    const upH = new Biquad('highshelf', 5000, 0.707, 6, FS)
    const dnH = new Biquad('highshelf', 5000, 0.707, -6, FS)
    for (const f of [50, 1000, 5000, 10000, 20000]) {
      const mag = upH.magnitudeAt(f, FS) * dnH.magnitudeAt(f, FS)
      expect(Math.abs(20 * Math.log10(mag))).toBeLessThan(0.05)
    }
  })
})

describe('Biquad 时域（TDF2）', () => {
  it('处理正弦 10000 样本无发散、幅度稳定（滤波后幅度≈2 且前后段一致）', () => {
    const bq = new Biquad('peaking', 1000, 1, 6, FS)
    let maxAmp = 0
    let headMax = 0
    let tailMax = 0
    for (let i = 0; i < 10000; i++) {
      const x = Math.sin((2 * Math.PI * 1000 * i) / FS)
      const y = bq.process(x)
      expect(Number.isFinite(y)).toBe(true)
      const a = Math.abs(y)
      maxAmp = Math.max(maxAmp, a)
      if (i < 1000) headMax = Math.max(headMax, a)
      if (i >= 9000) tailMax = Math.max(tailMax, a)
    }
    expect(maxAmp).toBeLessThan(4) // 稳态增益约 2，含瞬态余量
    expect(tailMax).toBeGreaterThan(1) // 稳态幅度接近 2
    expect(tailMax / Math.max(headMax, 1e-9)).toBeGreaterThan(0.9) // 前后幅度一致（无发散/衰减）
  })

  it('processBlock 与逐样本 process 一致', () => {
    const bq = new Biquad('peaking', 1000, 1.2, 4, FS)
    const n = 512
    const input = new Float32Array(n)
    const out1 = new Float32Array(n)
    const out2 = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 300 * i) / FS) * 0.5
    bq.processBlock(input, out1)
    bq.reset()
    for (let i = 0; i < n; i++) out2[i] = bq.process(input[i])
    for (let i = 0; i < n; i++) {
      expect(Math.abs(out1[i] - out2[i])).toBeLessThan(1e-6)
    }
  })

  it('reset 清空状态（直流输入输出应为 0）', () => {
    const bq = new Biquad('peaking', 1000, 1, 6, FS)
    for (let i = 0; i < 100; i++) bq.process(0.5)
    bq.reset()
    expect(bq.process(0)).toBe(0)
  })
})

describe('边界', () => {
  it('fs<=0 抛 Error("invalid sample rate")', () => {
    expect(() => designBiquad('peaking', 1000, 1, 6, 0)).toThrow('invalid sample rate')
    expect(() => new Biquad('peaking', 1000, 1, 6, -1)).toThrow('invalid sample rate')
    expect(() => new Biquad().magnitudeAt(1000, 0)).toThrow('invalid sample rate')
  })

  it('所有采样率入口拒绝 NaN/Infinity', () => {
    for (const fs of [NaN, Infinity, -Infinity]) {
      expect(() => designBiquad('peaking', 1000, 1, 6, fs)).toThrow('invalid sample rate')
      expect(() => new Biquad('peaking', 1000, 1, 6, fs)).toThrow('invalid sample rate')
      expect(() => new Biquad().magnitudeAt(1000, fs)).toThrow('invalid sample rate')
    }
  })

  it('8 类滤波器的非有限 f/Q/gain 回退默认值，系数及后续样本不被污染', () => {
    const types: BiquadType[] = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass']
    for (const type of types) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const cases = [
          { input: [value, 1, 6], safe: [1000, 1, 6] },
          { input: [1000, value, 6], safe: [1000, 1, 6] },
          { input: [1000, 1, value], safe: [1000, 1, 0] },
        ]
        for (const { input, safe } of cases) {
          const coeffs = designBiquad(type, input[0], input[1], input[2], FS)
          expect(coeffs).toEqual(designBiquad(type, safe[0], safe[1], safe[2], FS))
          const bq = new Biquad(type, input[0], input[1], input[2], FS)
          for (let i = 0; i < 128; i++) expect(Number.isFinite(bq.process(i === 0 ? 0.5 : 0))).toBe(true)
          expect(bq.magnitudeAt(value, FS)).toBe(bq.magnitudeAt(1000, FS))
        }
      }
    }
  })

  it('setCoeffs 非有限值原子拒绝，不改写已有有效系数或状态', () => {
    const bq = new Biquad('peaking', 1000, 1, 6, FS)
    const ref = new Biquad('peaking', 1000, 1, 6, FS)
    bq.process(0.5)
    ref.process(0.5)
    for (const key of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const coeffs = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, [key]: value }
        expect(() => bq.setCoeffs(coeffs)).toThrow('invalid coefficients')
        expect(bq.process(0.1)).toBe(ref.process(0.1))
      }
    }
  })

  it('setParams 后幅频随之更新（参数即时生效）', () => {
    const bq = new Biquad('peaking', 1000, 1, 0, FS)
    expect(Math.abs(bq.magnitudeAt(1000, FS) - 1)).toBeLessThan(1e-4)
    bq.setParams('peaking', 1000, 1, 6)
    expect(Math.abs(bq.magnitudeAt(1000, FS) - 1.9953) / 1.9953).toBeLessThan(0.02)
  })
})
