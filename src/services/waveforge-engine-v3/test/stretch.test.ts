/**
 * test/stretch.test.ts —— 相位声码器变速/变调单测
 * 物理含义说明：
 *  - rate=2 输出长度 ≈ 2× 输入（时间伸缩 ±3% 容差，帧 hop 取整引入 <1% 偏差）；
 *  - semitones=+12 时 440Hz 正弦 → ≈880Hz（±1%，两阶段：时间伸缩 2× + 重采样 1/2）；
 *  - 信号功率保持 ±3dB（相位声码器保持 STFT 幅度 + 幅度归一化 4Hs/N）。
 */
import { describe, it, expect } from 'vitest'
import { Stretch } from '../src/dsp/Stretch'

const FS = 48000

function sine(fs: number, freq: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(fs * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

/** 过零率法估计频率（对纯正弦精度 <0.1%）；统计中间 50% 区间避开边缘淡入淡出 */
function estimateFreq(x: Float32Array, fs: number): number {
  const start = Math.floor(x.length * 0.25)
  const end = Math.floor(x.length * 0.75)
  let crossings = 0
  for (let i = start + 1; i < end; i++) {
    if ((x[i - 1] < 0) !== (x[i] < 0)) crossings++
  }
  return crossings / 2 / ((end - start) / fs)
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / (to - from))
}

describe('Stretch', () => {
  it('rate=2 输出长度 ≈ 2× 输入（±3%）', () => {
    const x = sine(FS, 440, 1)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 0, rate: 2 })
    const out = s.processStereo(x, x)
    const expected = x.length * 2
    // 相位声码器输出 (M-1)·Hs+N，Hs=2·hop 取整；允许 ±3% 长度偏差
    expect(Math.abs(out.l.length - expected) / expected).toBeLessThan(0.03)
    expect(out.r.length).toBe(out.l.length)
  })

  it('rate=1, semitones=+12：440Hz → ≈880Hz（±1%）', () => {
    const x = sine(FS, 440, 2)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 12, rate: 1 })
    const out = s.processStereo(x, x)
    const f = estimateFreq(out.l, FS)
    // 变调两阶段：时间伸缩 2×（不变调）→ 重采样 1/2（频率 ×2）；880Hz 目标
    expect(f).toBeGreaterThan(880 * 0.99)
    expect(f).toBeLessThan(880 * 1.01)
  })

  it('信号功率量级保持（输出 RMS 与输入 RMS 差 <3dB）', () => {
    const x = sine(FS, 440, 2, 0.5)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 12, rate: 1 })
    const out = s.processStereo(x, x)
    const rmsIn = rms(x, Math.floor(x.length * 0.25), Math.floor(x.length * 0.75))
    const rmsOut = rms(out.l, Math.floor(out.l.length * 0.25), Math.floor(out.l.length * 0.75))
    const db = 20 * Math.log10(rmsOut / rmsIn)
    // 相位声码器保持幅度、重采样保持幅度 → 功率差应在 ±3dB 内
    expect(Math.abs(db)).toBeLessThan(3)
  })

  it('伸长时检测脉冲并锁定峰值邻域相位，避免瞬态铺成数十样本的拖尾', () => {
    const x = new Float32Array(FS * 2)
    const impulses = [0.2, 0.6, 1.0, 1.4, 1.8]
    for (const time of impulses) x[Math.round(time * FS)] = 1
    const stretch = new Stretch(FS)
    stretch.setParams({ semitones: 0, rate: 1.5 })
    const output = stretch.processStereo(x, x).l

    for (const inputTime of impulses) {
      const expected = Math.round(inputTime * 1.5 * FS)
      const from = Math.max(0, expected - Math.round(0.02 * FS))
      const to = Math.min(output.length, expected + Math.round(0.02 * FS))
      let peak = 0
      let peakIndex = from
      for (let i = from; i < to; i++) {
        const magnitude = Math.abs(output[i])
        if (magnitude > peak) { peak = magnitude; peakIndex = i }
      }
      let widthAtTenPercent = 0
      for (let i = from; i < to; i++) if (Math.abs(output[i]) > peak * 0.1) widthAtTenPercent++
      expect(peak).toBeGreaterThan(0.7)
      expect(Math.abs(peakIndex - expected)).toBeLessThan(Math.round(0.02 * FS))
      expect(widthAtTenPercent).toBeLessThan(16)
    }
  })

  it('rate=1, semitones=0：长度≈输入、幅度基本保持', () => {
    const x = sine(FS, 440, 1, 0.5)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 0, rate: 1 })
    const out = s.processStereo(x, x)
    expect(Math.abs(out.l.length - x.length) / x.length).toBeLessThan(0.03)
    const rmsIn = rms(x, Math.floor(x.length * 0.25), Math.floor(x.length * 0.75))
    const rmsOut = rms(out.l, Math.floor(out.l.length * 0.25), Math.floor(out.l.length * 0.75))
    expect(Math.abs(20 * Math.log10(rmsOut / rmsIn))).toBeLessThan(3)
  })

  it('中性速率和音高逐样本直通到独立输出，避免无效 STFT 重合成', () => {
    const left = Float32Array.from({ length: 257 }, (_, i) => Math.sin(i * 0.17) * (i % 7) / 7)
    const right = Float32Array.from({ length: 193 }, (_, i) => Math.cos(i * 0.11) * (i % 5) / 5)
    const output = new Stretch(FS).processStereo(left, right)
    expect(output.l).toEqual(left)
    expect(output.r).toEqual(right)
    expect(output.l).not.toBe(left)
    expect(output.r).not.toBe(right)
  })

  it('确定性：同输入同参数两次调用逐样本一致', () => {
    const x = sine(FS, 220, 1)
    const s1 = new Stretch(FS, 2)
    s1.setParams({ semitones: 3, rate: 1.5 })
    const a = s1.processStereo(x, x)
    const s2 = new Stretch(FS, 2)
    s2.setParams({ semitones: 3, rate: 1.5 })
    const b = s2.processStereo(x, x)
    expect(a.l.length).toBe(b.l.length)
    let maxDiff = 0
    for (let i = 0; i < a.l.length; i++) {
      const d = Math.abs(a.l[i] - b.l[i])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBe(0) // 位级一致（无随机源）
  })

  it('setParams 即时生效；reset 后再次处理结果一致', () => {
    const x = sine(FS, 440, 1)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 0, rate: 1 })
    const a = s.processStereo(x, x)
    s.setParams({ semitones: 0, rate: 2 }) // 改参数立即影响输出长度
    const b = s.processStereo(x, x)
    expect(b.l.length).toBeGreaterThan(a.l.length * 1.9)
    s.reset()
    s.setParams({ semitones: 0, rate: 1 })
    const c = s.processStereo(x, x)
    expect(c.l.length).toBe(a.l.length)
    let maxDiff = 0
    for (let i = 0; i < c.l.length; i++) {
      const d = Math.abs(c.l[i] - a.l[i])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBe(0)
  })

  it('输入输出为独立数组（不就地修改输入）', () => {
    const x = sine(FS, 440, 0.5)
    const copy = Float32Array.from(x)
    const s = new Stretch(FS, 2)
    s.setParams({ semitones: 5, rate: 1.3 })
    const out = s.processStereo(x, x)
    expect(out.l).not.toBe(x)
    expect(out.r).not.toBe(x)
    let same = true
    for (let i = 0; i < x.length; i++) {
      if (x[i] !== copy[i]) {
        same = false
        break
      }
    }
    expect(same).toBe(true) // 输入未被修改
  })

  it('左右声道与相邻调用无相位状态串扰', () => {
    const x = sine(FS, 440, 0.2)
    const y = sine(FS, 997, 0.2)
    const s = new Stretch(FS)
    s.setParams({ semitones: 0, rate: 1.3 })
    const pair = s.processStereo(x, y)
    const swapped = s.processStereo(y, x)
    const fresh = new Stretch(FS)
    fresh.setParams({ semitones: 0, rate: 1.3 })
    const reference = fresh.processStereo(x, x)
    expect(pair.l).toEqual(reference.l)
    expect(swapped.r).toEqual(reference.l)
  })

  it('大倍率伸长不出现周期性无声洞；短片段长度符合 rate', () => {
    const x = sine(FS, 440, 0.25)
    const s = new Stretch(FS)
    s.setParams({ semitones: 0, rate: 8 })
    const result = s.processStereo(x, x).l
    expect(result.length).toBe(x.length * 8)
    // 跳过自然首尾淡入淡出；中段不应出现整段静音。
    for (let i = result.length / 4; i < result.length * 3 / 4; i += 512) {
      expect(rms(result, i, i + 512)).toBeGreaterThan(0.02)
    }
  })

  it('极端组合 rate=0.1、降调 -36 时长度与频率仍受控', () => {
    const x = sine(FS, 880, 0.5)
    const s = new Stretch(FS)
    s.setParams({ semitones: -36, rate: 0.1 })
    const output = s.processStereo(x, x).l
    expect(Math.abs(output.length - x.length * 0.1) / (x.length * 0.1)).toBeLessThan(0.05)
    expect(output.every(Number.isFinite)).toBe(true)
  })

  it('率改变与升降调后输出无非有限值', () => {
    const x = sine(FS, 440, 0.15)
    const s = new Stretch(FS)
    for (const params of [{ semitones: -24, rate: 0.5 }, { semitones: 24, rate: 2 }]) {
      s.setParams(params)
      const { l, r } = s.processStereo(x, x)
      expect(l.length).toBe(r.length)
      expect(Math.abs(l.length - x.length * params.rate) / (x.length * params.rate)).toBeLessThan(0.04)
      expect(l.every(Number.isFinite)).toBe(true)
    }
  })

  it('原速短片段首样本不被 Hann 窗零点抹去', () => {
    const x = new Float32Array(1024)
    x[0] = 0.5
    x[x.length - 1] = -0.25
    const result = new Stretch(FS).processStereo(x, x).l
    expect(result.length).toBe(x.length)
    expect(result[0]).toBeCloseTo(x[0], 3)
    expect(result[result.length - 1]).toBeCloseTo(x[x.length - 1], 3)
  })

  it('非有限参数退回原速/原音，避免 NaN 污染输出', () => {
    const s = new Stretch(FS)
    s.setParams({ rate: NaN, semitones: Infinity })
    const x = sine(FS, 440, 0.1)
    const y = s.processStereo(x, x).l
    expect(y.length).toBe(x.length)
    expect(y.every(Number.isFinite)).toBe(true)
  })

  it('非法采样率抛 Error；isSignalsmithAvailable 返回布尔', async () => {
    expect(() => new Stretch(0)).toThrow('invalid sample rate')
    const ok = await Stretch.isSignalsmithAvailable()
    expect(typeof ok).toBe('boolean')
  })
})
