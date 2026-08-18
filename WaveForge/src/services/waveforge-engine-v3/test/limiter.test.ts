/**
 * Limiter 单元测试 —— 技术文档 §3.3 / API_SPEC 模块 7
 * 物理意义：前瞻限幅器保证输出峰值不超过阈值（brickwall 零过冲）；
 * 真峰值模式用 4× 过采样检测采样点之间的过冲。
 */
import { describe, expect, it } from 'vitest'
import { Limiter } from '../src/dsp/Limiter'

const FS = 48000

function makeSine(n: number, f: number, amp: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / FS)
  return x
}

function peak(x: Float32Array): number {
  let m = 0
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i])
    if (a > m) m = a
  }
  return m
}

function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

const settings = (over: Partial<import('../src/types').LimiterSettings> = {}): import('../src/types').LimiterSettings => ({
  enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true, ...over,
})

describe('Limiter', () => {
  it('3kHz 正弦 0dBFS、threshold -1dBFS → 输出峰值 ≤ -0.95dBFS（±0.1dB）', () => {
    for (const truePeak of [false, true]) {
      const lim = new Limiter(FS)
      lim.setParams(settings({ truePeak }))
      const n = 96000
      const inL = makeSine(n, 3000, 1.0)
      const inR = inL.slice()
      const l = inL.slice()
      const r = inR.slice()
      lim.processStereo(l, r)
      // 稳态段峰值（跳过预卷 L 样本）
      const half = Math.floor(n / 2)
      const pk = peak(l.subarray(half))
      const limit = Math.pow(10, -0.95 / 20) * Math.pow(10, 0.1 / 20) // -0.95dBFS + 0.1dB 容差
      expect(pk).toBeLessThanOrEqual(limit)
      // 信号仍是正弦（RMS 量级 ≈ 0.7071·0.8913 ≈ 0.63）
      const outRms = rms(l.subarray(half))
      expect(outRms).toBeGreaterThan(0.5)
      expect(outRms).toBeLessThan(0.7)
    }
  })

  it('enabled=false 直通且无衰减', () => {
    const lim = new Limiter(FS)
    lim.setParams(settings({ enabled: false }))
    const n = 4800
    const inL = makeSine(n, 3000, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    lim.processStereo(l, r)
    expect(l).toEqual(inL)
    expect(r).toEqual(inR)
    expect(lim.getReductionDb()).toBe(0)
  })

  it('突然方波无过冲超阈值（lookahead 预压生效）', () => {
    const lim = new Limiter(FS)
    lim.setParams(settings({}))
    const n = 96000 // 2s：让释放（150ms）在真峰值插值过冲造成的增益下探后充分恢复
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = i < 9600 ? 0.001 : 1.0 // 静音后突然 0dBFS 方波（阶跃）
      l[i] = v
      r[i] = v
    }
    lim.processStereo(l, r)
    // 全输出峰值不超过 -0.9dBFS（-1dBFS + 0.1dB 容差）
    const pk = peak(l)
    expect(pk).toBeLessThanOrEqual(Math.pow(10, -0.9 / 20))
    // 稳态段输出 ≈ -1dBFS
    const steadyDb = 20 * Math.log10(Math.abs(l[n - 1000]))
    expect(Math.abs(steadyDb + 1)).toBeLessThan(0.1)
  })

  it('getLatencySamples = lookahead 样本数', () => {
    const lim = new Limiter(FS)
    lim.setParams(settings({ lookaheadMs: 5 }))
    expect(lim.getLatencySamples()).toBe(240) // 5ms @ 48k
    lim.setParams(settings({ lookaheadMs: 0 }))
    expect(lim.getLatencySamples()).toBe(0)
  })

  it('真峰值模式压制采样点之间的过冲（16kHz 0dBFS：数字采样峰值 0.866，真实峰值 1.0）', () => {
    const n = 24000
    const inL = makeSine(n, 16000, 1.0)
    const inR = inL.slice()
    // 数字峰值模式：max|sample| = 0.866 < 阈值 → 不触发限幅
    const limD = new Limiter(FS)
    limD.setParams(settings({ truePeak: false }))
    const l1 = inL.slice()
    const r1 = inR.slice()
    limD.processStereo(l1, r1)
    const pkD = peak(l1.subarray(Math.floor(n / 2)))
    expect(pkD).toBeGreaterThan(0.85) // 数字峰值模式下过冲未被压制
    // 真峰值模式：4× 过采样检测到 ~1.0 → 输出数字峰值被压到 ≈0.77-0.81
    const limT = new Limiter(FS)
    limT.setParams(settings({ truePeak: true }))
    const l2 = inL.slice()
    const r2 = inR.slice()
    limT.processStereo(l2, r2)
    const pkT = peak(l2.subarray(Math.floor(n / 2)))
    expect(pkT).toBeLessThan(0.86)
    expect(pkT).toBeLessThan(pkD - 0.01)
  })

  it('reset 后重新处理结果一致（确定性）', () => {
    const lim = new Limiter(FS)
    lim.setParams(settings({}))
    const n = 24000
    const inL = makeSine(n, 3000, 0.9)
    const inR = inL.slice()
    const l1 = inL.slice()
    const r1 = inR.slice()
    lim.processStereo(l1, r1)
    const ref = l1.slice()
    lim.reset()
    const l2 = inL.slice()
    const r2 = inR.slice()
    lim.processStereo(l2, r2)
    expect(l2).toEqual(ref)
  })
})
