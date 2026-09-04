/**
 * test/resampler.test.ts —— 多相 sinc 重采样单测
 * 数值容差说明：频率测量用零交叉法（精度 <0.1%）；能量/RMS 与恒等断言用 1e-3 级容差，
 * 对应重采样应保持正弦幅度与频率的物理约束。
 */
import { describe, it, expect } from 'vitest'
import { Resampler } from '../src/dsp/Resampler'

/** 生成正弦测试信号（确定性：纯 Math.sin） */
function sine(fs: number, freq: number, seconds: number, amp = 1): Float32Array {
  const n = Math.round(fs * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

/**
 * 插值过零法估计频率：对每对相邻符号变化样本线性插值出过零时刻，
 * 用中间区间的过零时刻差求频率（消除 ±1 过零计数量化误差，纯正弦精度 <0.05%）。
 */
function estimateFreq(x: Float32Array, fs: number): number {
  const times: number[] = []
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1] < 0) !== (x[i] < 0)) {
      // 线性插值过零时刻（样本单位）
      times.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]))
    }
  }
  const a = Math.floor(times.length * 0.2)
  const b = Math.floor(times.length * 0.8)
  const intervals = b - a
  if (intervals < 2) return 0
  return intervals / 2 / ((times[b] - times[a]) / fs)
}

function rms(x: Float32Array, from = 0, to = x.length): number {
  let s = 0
  const n = to - from
  for (let i = from; i < to; i++) s += x[i] * x[i]
  return Math.sqrt(s / n)
}

describe('Resampler', () => {
  it('44.1kHz→48kHz 保持 440Hz 正弦频率（±0.5Hz）', () => {
    const input = sine(44100, 440, 1)
    const rs = new Resampler(44100, 48000)
    const out = rs.process(input)
    // 重采样是带限插值，频率应精确保持；零交叉估计误差 <0.1%，取 ±0.5Hz 容差
    expect(estimateFreq(out, 48000)).toBeGreaterThan(439.5)
    expect(estimateFreq(out, 48000)).toBeLessThan(440.5)
  })

  it('48kHz→44.1kHz 降采样同样保持 440Hz（±0.5Hz）', () => {
    const input = sine(48000, 440, 1)
    const rs = new Resampler(48000, 44100)
    const out = rs.process(input)
    expect(estimateFreq(out, 44100)).toBeGreaterThan(439.5)
    expect(estimateFreq(out, 44100)).toBeLessThan(440.5)
  })

  it('能量守恒：重采样前后 RMS 误差 <1%（正弦带限插值保持幅度）', () => {
    const input = sine(44100, 440, 1, 0.5)
    const rs = new Resampler(44100, 48000)
    const out = rs.process(input)
    const rmsIn = rms(input, Math.floor(input.length * 0.1), Math.floor(input.length * 0.9))
    const rmsOut = rms(out, Math.floor(out.length * 0.1), Math.floor(out.length * 0.9))
    // 中间 80% 区间测 RMS，排除边缘效应；允许 1% 相对误差
    expect(Math.abs(rmsOut / rmsIn - 1)).toBeLessThan(0.01)
  })

  it('44.1kHz→44.1kHz 恒等（逐样本 ±1e-6）', () => {
    const input = sine(44100, 997, 1) // 非整周期频率，避免巧合
    const rs = new Resampler(44100, 44100)
    const out = rs.process(input)
    expect(out.length).toBe(input.length)
    let maxDiff = 0
    for (let i = 0; i < input.length; i++) {
      const d = Math.abs(out[i] - input[i])
      if (d > maxDiff) maxDiff = d
    }
    // 相位 f=0 时内核在整数偏移处 sinc=0，仅中心抽头=1 → 逐样本恒等
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it('流式分块处理与一次性处理在公共区间逐样本一致（<1e-6）', () => {
    const input = sine(44100, 440, 1)
    const whole = new Resampler(44100, 48000).process(input)
    const rs = new Resampler(44100, 48000)
    const out = new Float32Array(whole.length)
    let written = 0
    const chunk = 997 // 非整除数，检验任意分块边界
    for (let off = 0; off < input.length; off += chunk) {
      const part = input.subarray(off, Math.min(off + chunk, input.length))
      written += rs.processStreaming(part, out.subarray(written))
    }
    // 流式只输出内核窗口完全覆盖的输出；公共前缀应与一次性结果逐样本一致
    expect(written).toBeGreaterThan(whole.length - 64)
    let maxDiff = 0
    for (let i = 0; i < written; i++) {
      const d = Math.abs(out[i] - whole[i])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it('quality 0 与 quality 10 均能正确保持频率（质量仅影响阻带/相位精度）', () => {
    const input = sine(44100, 440, 1)
    for (const q of [0, 10]) {
      const out = new Resampler(44100, 48000, 1, q).process(input)
      expect(estimateFreq(out, 48000)).toBeGreaterThan(439.5)
      expect(estimateFreq(out, 48000)).toBeLessThan(440.5)
    }
  })

  it('非法采样率抛 Error', () => {
    expect(() => new Resampler(0, 48000)).toThrow('invalid sample rate')
    expect(() => new Resampler(44100, -1)).toThrow('invalid sample rate')
    expect(() => new Resampler(NaN, 48000)).toThrow('invalid sample rate')
  })

  it('立体声交错（channels=2）：逐通道结果与单声道一致', () => {
    // 构造交错立体声：左 440Hz、右 880Hz；重采样后各通道应与单声道重采样一致
    const n = 44100
    const inter = new Float32Array(n * 2)
    const monoL = new Float32Array(n)
    const monoR = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const lv = Math.sin((2 * Math.PI * 440 * i) / 44100)
      const rv = Math.sin((2 * Math.PI * 880 * i) / 44100)
      inter[i * 2] = lv
      inter[i * 2 + 1] = rv
      monoL[i] = lv
      monoR[i] = rv
    }
    const rsS = new Resampler(44100, 48000, 2, 8)
    const outS = rsS.process(inter)
    const outL = new Resampler(44100, 48000, 1, 8).process(monoL)
    const outR = new Resampler(44100, 48000, 1, 8).process(monoR)
    // 输出长度 = 帧数×通道
    expect(outS.length).toBe(outL.length * 2)
    let maxDL = 0
    let maxDR = 0
    for (let i = 0; i < outL.length; i++) {
      const dl = Math.abs(outS[i * 2] - outL[i])
      const dr = Math.abs(outS[i * 2 + 1] - outR[i])
      if (dl > maxDL) maxDL = dl
      if (dr > maxDR) maxDR = dr
    }
    // 同内核、同相位（共享比例）→ 每通道与单声道逐样本一致
    expect(maxDL).toBeLessThan(1e-6)
    expect(maxDR).toBeLessThan(1e-6)
  })

  it('reset 后流式状态清空，输出从头开始', () => {
    const input = sine(44100, 440, 1)
    const rs = new Resampler(44100, 48000)
    const a = new Float32Array(4800)
    const b = new Float32Array(4800)
    rs.processStreaming(input.subarray(0, 4410), a)
    rs.reset()
    rs.processStreaming(input.subarray(0, 4410), b)
    let maxDiff = 0
    for (let i = 0; i < b.length; i++) {
      const d = Math.abs(a[i] - b[i])
      if (d > maxDiff) maxDiff = d
    }
    expect(maxDiff).toBeLessThan(1e-7)
  })
})