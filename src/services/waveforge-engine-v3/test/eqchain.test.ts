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

  it('关闭补偿恢复用户增益；再次开启从用户值迭代，不保留历史补偿', () => {
    const bands = halfOctaveBoostBands(9)
    const freqs = bands.map((b) => b.frequency)
    const chain = new EqChain(FS, 20)
    const raw = new EqChain(FS, 20)
    raw.setBands(bands)
    const rawResponse = raw.responseAt(freqs)

    chain.setBands(bands)
    chain.setQCompensation(true)
    const compensated = chain.responseAt(freqs)
    expect(Math.abs(20 * Math.log10(compensated[4] / rawResponse[4]))).toBeGreaterThan(0.1)

    chain.setQCompensation(false)
    const restored = chain.responseAt(freqs)
    for (let i = 0; i < freqs.length; i++) {
      expect(restored[i]).toBeCloseTo(rawResponse[i], 6)
    }

    chain.setQCompensation(true)
    const again = chain.responseAt(freqs)
    for (let i = 0; i < freqs.length; i++) {
      expect(again[i]).toBeCloseTo(compensated[i], 6)
    }
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

  it('左右独立：单侧脉冲不串音；分块等价双单声道；reset 清除两侧尾音', () => {
    const bands = [{ frequency: 1200, gain: 12, q: 1.1 }]
    const chain = new EqChain(FS, 1)
    const leftOnly = new EqChain(FS, 1)
    const rightOnly = new EqChain(FS, 1)
    for (const eq of [chain, leftOnly, rightOnly]) eq.setBands(bands)

    const l = new Float32Array(256)
    const r = new Float32Array(256)
    l[0] = 0.7
    r[100] = -0.35
    const expectedL = new Float32Array(l.length)
    const expectedR = new Float32Array(r.length)
    leftOnly.processBlock(l, expectedL)
    rightOnly.processBlock(r, expectedR)
    chain.processStereo(l.subarray(0, 128), r.subarray(0, 128))
    chain.processStereo(l.subarray(128), r.subarray(128))
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBeCloseTo(expectedL[i], 6)
      expect(r[i]).toBeCloseTo(expectedR[i], 6)
      if (i < 100) expect(r[i]).toBe(0)
    }

    chain.reset()
    const silenceL = new Float32Array(128)
    const silenceR = new Float32Array(128)
    chain.processStereo(silenceL, silenceR)
    expect(silenceL.every((x) => x === 0)).toBe(true)
    expect(silenceR.every((x) => x === 0)).toBe(true)
  })

  it.each([44100, 48000, 96000])('fs=%i：修改频段及切换补偿后，立体声仍等价两个独立单声道', (fs) => {
    const stereo = new EqChain(fs, 20)
    const monoL = new EqChain(fs, 20)
    const monoR = new EqChain(fs, 20)
    const chains = [stereo, monoL, monoR]
    const rnd = lcg(73)
    for (let stage = 0; stage < 4; stage++) {
      for (const chain of chains) {
        if (stage === 0) chain.setBands(halfOctaveBoostBands(9))
        if (stage === 1) chain.setQCompensation(true)
        if (stage === 2) chain.setQCompensation(false)
        if (stage === 3) chain.setBands([{ frequency: 250, gain: -9, q: 0.7 }])
      }
      const l = new Float32Array(257)
      const r = new Float32Array(257)
      for (let i = 0; i < l.length; i++) {
        l[i] = rnd() * 0.1
        r[i] = rnd() * 0.1
      }
      const expectedL = new Float32Array(l.length)
      const expectedR = new Float32Array(r.length)
      monoL.processBlock(l, expectedL)
      monoR.processBlock(r, expectedR)
      stereo.processStereo(l, r)
      for (let i = 0; i < l.length; i++) {
        expect(l[i]).toBeCloseTo(expectedL[i], 6)
        expect(r[i]).toBeCloseTo(expectedR[i], 6)
      }
    }
  })

  it('process 与 processBlock 输出一致', () => {
    const blockChain = new EqChain(FS, 20)
    const sampleChain = new EqChain(FS, 20)
    blockChain.setBands(halfOctaveBoostBands(6))
    sampleChain.setBands(halfOctaveBoostBands(6))
    const n = 1024
    const input = new Float32Array(n)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) input[i] = Math.sin((2 * Math.PI * 250 * i) / FS) * 0.4
    blockChain.processBlock(input, out)
    for (let i = 0; i < n; i++) {
      expect(Math.abs(out[i] - sampleChain.process(input[i]))).toBeLessThan(1e-6)
    }
  })

  it('新 EQ 系数切换时首样本与旧链连续，20ms 后完成交叉淡化', () => {
    const oldBands = halfOctaveBoostBands(0)
    const newBands = halfOctaveBoostBands(12)
    const changing = new EqChain(FS, 20)
    const oldReference = new EqChain(FS, 20)
    changing.setBands(oldBands)
    oldReference.setBands(oldBands)
    const warmupL = new Float32Array(2048)
    const warmupR = new Float32Array(2048)
    for (let i = 0; i < warmupL.length; i++) {
      warmupL[i] = warmupR[i] = 0.3 * Math.sin((2 * Math.PI * 1000 * i) / FS)
    }
    changing.processStereo(warmupL.slice(), warmupR.slice())
    oldReference.processStereo(warmupL.slice(), warmupR.slice())
    changing.setBands(newBands)

    const firstL = Float32Array.of(0.2)
    const firstR = Float32Array.of(0.2)
    const referenceL = Float32Array.of(0.2)
    const referenceR = Float32Array.of(0.2)
    changing.processStereo(firstL, firstR)
    oldReference.processStereo(referenceL, referenceR)
    expect(firstL[0]).toBeCloseTo(referenceL[0], 7)
    expect(firstR[0]).toBeCloseTo(referenceR[0], 7)

    const tailL = new Float32Array(Math.round(FS * 0.025))
    const tailR = new Float32Array(tailL.length)
    tailL.fill(0.2); tailR.fill(0.2)
    changing.processStereo(tailL, tailR)
    expect(tailL.every(Number.isFinite)).toBe(true)
    expect(tailR.every(Number.isFinite)).toBe(true)
    const afterFadeL = Float32Array.of(0.2)
    const afterFadeR = Float32Array.of(0.2)
    changing.processStereo(afterFadeL, afterFadeR)
    expect(afterFadeL[0]).toBeCloseTo(changing.process(0.2), 5)
  })

  it('交叉淡化期间连续收到新参数时延后应用最后一组，当前过渡不重启', () => {
    const flat = [{ frequency: 1000, gain: 0, q: 1 }]
    const boost = [{ frequency: 1000, gain: 18, q: 1 }]
    const cut = [{ frequency: 1000, gain: -18, q: 1 }]
    const changing = new EqChain(FS, 1)
    const reference = new EqChain(FS, 1)
    changing.setBands(flat)
    reference.setBands(flat)

    let sample = 0
    const nextInput = (): number => 0.25 * Math.sin((2 * Math.PI * 1000 * sample++) / FS)
    for (let i = 0; i < Math.round(FS * 0.025); i++) {
      const input = nextInput()
      changing.process(input)
      reference.process(input)
    }

    changing.setBands(boost)
    reference.setBands(boost)
    for (let i = 0; i < 240; i++) {
      const input = nextInput()
      expect(changing.process(input)).toBeCloseTo(reference.process(input), 12)
    }

    changing.setBands(cut)
    // The pending target cannot alter or restart the in-flight 20ms transition.
    for (let i = 240; i < Math.round(FS * 0.02); i++) {
      const input = nextInput()
      expect(changing.process(input)).toBeCloseTo(reference.process(input), 12)
    }

    // Applying the queued target begins from the exact state of the completed target chain.
    const boundaryInput = nextInput()
    expect(changing.process(boundaryInput)).toBeCloseTo(reference.process(boundaryInput), 12)
    expect(Number.isFinite(changing.process(nextInput()))).toBe(true)
  })
})

describe('EqChain 边界', () => {
  it('fs<=0 抛 Error("invalid sample rate")', () => {
    expect(() => new EqChain(0)).toThrow('invalid sample rate')
    expect(() => new EqChain(-48000)).toThrow('invalid sample rate')
  })

  it('拒绝非有限采样率与段数，避免无效系数或构造死循环', () => {
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() => new EqChain(invalid)).toThrow('invalid sample rate')
      expect(() => new EqChain(FS, invalid)).toThrow('invalid band count')
    }
  })

  it.each([false, true])('非有限频段参数回退默认值，补偿=%s 时响应及双声道均与有效参数一致', (compensation) => {
    for (const value of [NaN, Infinity, -Infinity]) {
      const malformed = new EqChain(FS, 3)
      const safe = new EqChain(FS, 3)
      malformed.setQCompensation(compensation)
      safe.setQCompensation(compensation)
      malformed.setBands([
        { frequency: value, gain: 6, q: 1.5 },
        { frequency: 2000, gain: value, q: 1.1 },
        { frequency: 4000, gain: -3, q: value },
      ])
      safe.setBands([
        { frequency: 1000, gain: 6, q: 1.5 },
        { frequency: 2000, gain: 0, q: 1.1 },
        { frequency: 4000, gain: -3, q: 1 },
      ])
      expect(malformed.responseAt([100, 1000, 4000, value])).toEqual(safe.responseAt([100, 1000, 4000, 1000]))
      const l = new Float32Array(512)
      const r = new Float32Array(512)
      l[0] = 0.5
      r[7] = -0.25
      const expectedL = l.slice()
      const expectedR = r.slice()
      malformed.processStereo(l, r)
      safe.processStereo(expectedL, expectedR)
      expect(l.every(Number.isFinite)).toBe(true)
      expect(r.every(Number.isFinite)).toBe(true)
      expect(l).toEqual(expectedL)
      expect(r).toEqual(expectedR)
    }
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

  it('架式滤波器开启 Q 补偿后保持用户设置的低频平台增益', () => {
    const chain = new EqChain(FS, 1)
    chain.setQCompensation(true)
    chain.setBands([{ frequency: 100, gain: 6, q: 0.707, type: 'lowshelf' }])
    const dbAt20Hz = 20 * Math.log10(chain.responseAt([20])[0])
    expect(dbAt20Hz).toBeGreaterThan(5.8)
    expect(dbAt20Hz).toBeLessThan(6.2)
  })

  it('支持每段独立滤波器类型，并保持块处理与逐样本一致', () => {
    const types = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass'] as const
    const bands = types.map((type, i) => ({ frequency: 120 + i * 900, gain: i % 2 ? -3 : 4, q: 0.8, type }))
    const block = new EqChain(FS, types.length)
    const sample = new EqChain(FS, types.length)
    block.setBands(bands)
    sample.setBands(bands)
    const left = Float32Array.from({ length: 513 }, (_, i) => Math.sin(i * 0.17) * 0.4)
    const right = Float32Array.from({ length: 513 }, (_, i) => Math.cos(i * 0.11) * 0.25)
    const expectedL = left.slice()
    const expectedR = right.slice()
    sample.processStereo(expectedL, expectedR)
    block.processStereo(left.subarray(0, 127), right.subarray(0, 127))
    block.processStereo(left.subarray(127, 384), right.subarray(127, 384))
    block.processStereo(left.subarray(384), right.subarray(384))
    expect(left).toEqual(expectedL)
    expect(right).toEqual(expectedR)
    expect(left.every(Number.isFinite)).toBe(true)
    expect(right.every(Number.isFinite)).toBe(true)
  })
})
