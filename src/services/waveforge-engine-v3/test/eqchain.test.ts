/**
 * eqchain.test.ts —— EqChain.ts 单元测试（20 段级联 + Q 补偿）
 * 数值容差说明：
 *  - 控制点误差 <0.1dB（物理意义：补偿后级联响应与目标曲线之差小于 1.2% 幅度）；
 *  - 全 0dB 平直 ±0.02dB（0dB peaking 恒为单位增益，浮点误差可忽略）。
 */
import { describe, it, expect } from 'vitest'
import { EqChain } from '../src/dsp/EqChain'
import type { EqBandParam } from '../src/dsp/EqChain'

const FS = 48000

/** 生成间隔 1/2 octave（×2^0.5）的相邻 peaking 段，全部 +6dB、Q=1.5 */
function halfOctaveBoostBands(count: number, start = 1000): EqBandParam[] {
  const bands: EqBandParam[] = []
  for (let i = 0; i < count; i++) {
    bands.push({ frequency: start * Math.pow(2, i / 2), gain: 6, q: 1.5 })
  }
  return bands
}

/** 确定性 LCG（测试内生成伪随机噪声，避免依赖 Math.random） */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 0xffffffff) * 2 - 1
  }
}

describe('EqChain Q 补偿', () => {
  it('相邻 peaking 同 +6dB（Q1.5、间隔 1/2 octave）：开启补偿后控制点误差 <0.1dB', () => {
    const bands = halfOctaveBoostBands(9) // 1000Hz..~16kHz
    const chain = new EqChain(FS, 20)
    chain.setQCompensation(true)
    chain.setBands(bands)
    const freqs = bands.map((b) => b.frequency)
    const resp = chain.responseAt(freqs)
    const target = Math.pow(10, 6 / 20) // 线性目标 1.9953
    for (let i = 0; i < freqs.length; i++) {
      const errDb = Math.abs(20 * Math.log10(resp[i] / target))
      expect(errDb).toBeLessThan(0.1)
    }
  })

  it('不开启补偿时，同场景控制点误差明显 >0.1dB（证明补偿确实起作用）', () => {
    const bands = halfOctaveBoostBands(9)
    const chain = new EqChain(FS, 20)
    chain.setQCompensation(false)
    chain.setBands(bands)
    const freqs = bands.map((b) => b.frequency)
    const resp = chain.responseAt(freqs)
    const target = Math.pow(10, 6 / 20)
    let maxErrDb = 0
    for (let i = 0; i < freqs.length; i++) {
      maxErrDb = Math.max(maxErrDb, Math.abs(20 * Math.log10(resp[i] / target)))
    }
    expect(maxErrDb).toBeGreaterThan(0.1)
  })

  it('全 0dB → 响应平直 ±0.02dB（任意频点线性幅度≈1）', () => {
    const chain = new EqChain(FS, 20)
    chain.setQCompensation(true)
    chain.setBands([{ frequency: 1000, gain: 0, q: 1.1 }]) // 其余段默认 0dB
    const freqs = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    const resp = chain.responseAt(freqs)
    for (let i = 0; i < freqs.length; i++) {
      expect(Math.abs(20 * Math.log10(resp[i]))).toBeLessThan(0.02)
    }
  })
})

describe('EqChain 时域处理', () => {
  it('20 段级联处理白噪声不产生 NaN/Inf（随机增益+补偿开启）', () => {
    const chain = new EqChain(FS, 20)
    const rnd = lcg(42)
    const bands: EqBandParam[] = []
    // 随机 20 段：频率覆盖 20Hz..16kHz，增益 ±12dB，Q 0.5..8
    for (let i = 0; i < 20; i++) {
      const f = 20 * Math.pow(2, (i / 19) * 9.64) // ~20..16000Hz
      bands.push({ frequency: f, gain: rnd() * 12, q: 0.5 + rnd() * 7.5 })
    }
    chain.setQCompensation(true)
    chain.setBands(bands)

    const n = 4096
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    const rnd2 = lcg(7)
    for (let i = 0; i < n; i++) {
      l[i] = rnd2()
      r[i] = rnd2()
    }
    chain.processStereo(l, r)
    for (let i = 0; i < n; i++) {
      expect(Number.isFinite(l[i])).toBe(true)
      expect(Number.isFinite(r[i])).toBe(true)
    }
  })

  it('process 与 processBlock 输出一致', () => {
    const chain = new EqChain(FS, 20)
    chain.setBands(halfOctaveBoostBands(6))
    const n = 1024
    const input = new Float32Array(n)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 250 * i) / FS) * 0.4
    chain.processBlock(input, out)
    chain.reset()
    for (let i = 0; i < n; i++) {
      expect(Math.abs(out[i] - chain.process(input[i]))).toBeLessThan(1e-6)
    }
  })
})

describe('EqChain 边界', () => {
  it('fs<=0 抛 Error("invalid sample rate")', () => {
    expect(() => new EqChain(0)).toThrow('invalid sample rate')
    expect(() => new EqChain(-48000)).toThrow('invalid sample rate')
  })

  it('bandCount 默认为 20；少于 bandCount 的段自动补直通（0dB）', () => {
    const chain = new EqChain(FS) // 默认 20
    chain.setBands([{ frequency: 1000, gain: 6, q: 1 }])
    // 只 boost 1kHz 一段：远离中心处应接近 0dB
    expect(Math.abs(20 * Math.log10(chain.responseAt([100])[0]))).toBeLessThan(0.5)
    // 中心处 ≈ +6dB
    const atCenter = 20 * Math.log10(chain.responseAt([1000])[0])
    expect(Math.abs(atCenter - 6)).toBeLessThan(0.1)
  })
})
