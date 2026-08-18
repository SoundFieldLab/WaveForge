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

  it('非法采样率抛 Error；isSignalsmithAvailable 返回布尔', async () => {
    expect(() => new Stretch(0)).toThrow('invalid sample rate')
    const ok = await Stretch.isSignalsmithAvailable()
    expect(typeof ok).toBe('boolean')
  })
})
