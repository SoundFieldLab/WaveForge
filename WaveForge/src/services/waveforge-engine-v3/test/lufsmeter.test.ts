/**
 * LufsMeter 单元测试（模块 11：ITU-R BS.1770 响度测量）
 *
 * 物理意义注记：
 *  - 1kHz 满刻度单声道正弦：K 加权 1kHz 增益≈+0.7dB，-0.691 补偿后
 *    积分响度应 ≈ -3.01 LUFS（纯音 RMS = -3.01 dBFS）±0.5；
 *  - 静音：无块通过绝对门限 → 整合响度 NaN；
 *  - 门限：长静音段不拉低整合值（静音块被 -70 LUFS 绝对门限剔除）；
 *  - LRA：两电平节目（-3LU / -23LU 各 2s）→ 10/95 百分位差 ≈ 20 LU；
 *  - 真峰值：4× 过采样插值，正弦真峰值 ≈ 其幅度（略高于样本峰值）。
 */
import { describe, it, expect } from 'vitest'
import { LufsMeter } from '../src/dsp/LufsMeter'

function feed(m: LufsMeter, l: Float32Array, r: Float32Array, block = 4800): void {
  const n = l.length
  for (let off = 0; off < n; off += block) {
    const len = Math.min(block, n - off)
    m.processStereo(l.subarray(off, off + len), r.subarray(off, off + len))
  }
}

function sineMono(fs: number, freq: number, amp: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(fs * seconds))
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

function zeros(fs: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(fs * seconds))
}

describe('LufsMeter', () => {
  it('1kHz 满刻度单声道正弦 @48k：积分/瞬时/短时 ≈ -3.01 LUFS（±0.5）', () => {
    const m = new LufsMeter(48000)
    const l = sineMono(48000, 1000, 1.0, 4)
    feed(m, l, zeros(48000, 4))
    const integrated = m.getIntegratedLufs()
    const momentary = m.getMomentaryLufs()
    const shortTerm = m.getShortTermLufs()
    // 纯音能量参考：-0.691 + 10·log10(0.5·G²)，G=K加权 1kHz 增益 ≈ -3.05 LUFS
    expect(integrated).toBeGreaterThan(-3.6)
    expect(integrated).toBeLessThan(-2.5)
    expect(momentary).toBeGreaterThan(-3.6)
    expect(momentary).toBeLessThan(-2.5)
    expect(shortTerm).toBeGreaterThan(-3.6)
    expect(shortTerm).toBeLessThan(-2.5)
  })

  it('静音 → 整合/瞬时响度为 NaN，峰值为 -Infinity', () => {
    const m = new LufsMeter(48000)
    feed(m, zeros(48000, 2), zeros(48000, 2))
    expect(m.getIntegratedLufs()).toBeNaN()
    expect(m.getMomentaryLufs()).toBeNaN()
    expect(m.getShortTermLufs()).toBeNaN()
    expect(m.getPeakDb()).toBe(-Infinity)
    expect(m.getTruePeakDb()).toBe(-Infinity)
  })

  it('门限：6s 响音 + 6s 静音 → 整合响度不被静音拉低（≈响音电平）', () => {
    const m = new LufsMeter(48000)
    const loud = sineMono(48000, 1000, 1.0, 6)
    const z = zeros(48000, 6)
    const l = new Float32Array(loud.length + z.length)
    l.set(loud, 0)
    l.set(z, loud.length)
    feed(m, l, new Float32Array(l.length))
    const integrated = m.getIntegratedLufs()
    // 静音块被 -70 绝对门限剔除；边界过渡块仅轻微拉低（> -3.6 容差）
    expect(integrated).toBeGreaterThan(-3.7)
    expect(integrated).toBeLessThan(-2.5)
  })

  it('LRA：两电平节目（≈-3LU 与 ≈-23LU 各 2s）→ 10/95 百分位差 ≈ 20 LU（±2.5）', () => {
    const m = new LufsMeter(48000)
    const a = sineMono(48000, 1000, 1.0, 2) // ≈ -3 LUFS
    const b = sineMono(48000, 1000, 0.1, 2) // ≈ -23 LUFS
    const l = new Float32Array(a.length + b.length)
    l.set(a, 0)
    l.set(b, a.length)
    feed(m, l, new Float32Array(l.length))
    const lra = m.getLra()
    expect(lra).toBeGreaterThan(17.5)
    expect(lra).toBeLessThan(22.5)
  })

  it('峰值与真峰值：0.5 幅度正弦 → peakDb≈-6.02、truePeakDb≈-6.02 且 ≥ 样本峰值', () => {
    const m = new LufsMeter(48000)
    const l = sineMono(48000, 1000, 0.5, 2)
    feed(m, l, zeros(48000, 2))
    const peakDb = m.getPeakDb()
    const truePeakDb = m.getTruePeakDb()
    // 0.5 幅度 → 20·log10(0.5) = -6.0206 dBFS
    expect(Math.abs(peakDb - -6.0206)).toBeLessThan(0.1)
    // 真峰值（模拟域峰值）≈ 幅度 0.5，略高于或等于样本峰值
    expect(Math.abs(truePeakDb - -6.0206)).toBeLessThan(0.2)
    expect(truePeakDb).toBeGreaterThan(peakDb - 0.05)
  })

  it('44.1kHz 同样支持：1kHz 满刻度正弦 ≈ -3.01 LUFS（±0.5）', () => {
    const m = new LufsMeter(44100)
    const l = sineMono(44100, 1000, 1.0, 4)
    feed(m, l, zeros(44100, 4))
    const integrated = m.getIntegratedLufs()
    expect(integrated).toBeGreaterThan(-3.6)
    expect(integrated).toBeLessThan(-2.5)
  })

  it('其余采样率按 48k 系数近似：32000Hz 不抛错且结果合理（±1.7）', () => {
    const m = new LufsMeter(32000)
    const l = sineMono(32000, 1000, 1.0, 4)
    feed(m, l, zeros(32000, 4))
    const integrated = m.getIntegratedLufs()
    expect(Number.isFinite(integrated)).toBe(true)
    expect(integrated).toBeGreaterThan(-4.1)
    // 48k 系数近似使 1kHz 处高频 shelf 增益偏高约 +1.3dB（拐点随采样率缩放），
    // 按 API_SPEC"其余采样率近似"语义放宽上限
    expect(integrated).toBeLessThan(-1.2)
  })

  it('reset 后回到未测量状态', () => {
    const m = new LufsMeter(48000)
    const l = sineMono(48000, 1000, 1.0, 2)
    feed(m, l, zeros(48000, 2))
    expect(m.getIntegratedLufs()).not.toBeNaN()
    m.reset()
    expect(m.getIntegratedLufs()).toBeNaN()
    expect(m.getPeakDb()).toBe(-Infinity)
    // 重置后再次测量应可重复
    feed(m, l, zeros(48000, 2))
    expect(m.getIntegratedLufs()).toBeGreaterThan(-3.6)
  })

  it('非法采样率抛错', () => {
    expect(() => new LufsMeter(0)).toThrow()
    expect(() => new LufsMeter(-1)).toThrow()
  })
});
