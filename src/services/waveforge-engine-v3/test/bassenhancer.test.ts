/**
 * BassEnhancer 单元测试 —— 技术文档 §5 / API_SPEC 模块 8
 * 物理意义：虚拟低频通过非线性产生缺失基频的整数倍谐波（心理声学重建低音）；
 * 用直接 DFT 验证 60Hz 输入下输出含 120Hz（偶次）/ 180Hz（奇次）谐波。
 */
import { describe, expect, it } from 'vitest'
import { BassEnhancer } from '../src/dsp/BassEnhancer'
import type { BassEnhancerSettings, HarmonicType } from '../src/types'

const FS = 48000

function makeSine(n: number, f: number, amp: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / FS)
  return x
}

/** 直接 DFT（仅计算少量 bin）：输入为整数周期信号时 bin 精确（无泄漏） */
function dftMag(x: Float32Array, bin: number): number {
  const N = x.length
  const w = (2 * Math.PI * bin) / N
  let re = 0
  let im = 0
  for (let n = 0; n < N; n++) {
    const a = w * n
    re += x[n] * Math.cos(a)
    im -= x[n] * Math.sin(a)
  }
  return Math.sqrt(re * re + im * im)
}

const settings = (over: Partial<BassEnhancerSettings> = {}): BassEnhancerSettings => ({
  enabled: true, cutoffHz: 90, q: 0.7, harmonicType: 'odd', harmonicGain: 1, mix: 1, levelDb: 0, lowBoostDb: 0, ...over,
})

describe('BassEnhancer', () => {
  it('even 型：60Hz 基频 → 输出含 120Hz 二次谐波（FFT 验证，物理意义：缺失基频重建）', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({ harmonicType: 'even' }))
    const N = 16000
    const inL = makeSine(N, 60, 1.0)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    be.processStereo(l, r)
    // 取稳态段：后 8000 样本 = 恰好 10 个 60Hz 周期；bin = f·N/fs：60→10, 120→20, 180→30
    const seg = l.subarray(N - 8000)
    const a60 = dftMag(seg, 10)
    const a120 = dftMag(seg, 20)
    const a180 = dftMag(seg, 30)
    expect(a60).toBeGreaterThan(100) // 基频能量存在（DFT 幅度 = 幅度·N/2 ≈ 4000）
    expect(a120).toBeGreaterThan(a60 * 0.03) // 2 次谐波显著（全波整流理论比 ≈ 0.2）
    expect(a180).toBeLessThan(a60 * 0.01) // 偶次型几乎无 3 次谐波（偶对称）
  })

  it('odd 型：60Hz 基频 → 输出含 180Hz 三次谐波', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({ harmonicType: 'odd' }))
    const N = 16000
    const inL = makeSine(N, 60, 1.0)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    be.processStereo(l, r)
    const seg = l.subarray(N - 8000)
    const a60 = dftMag(seg, 10)
    const a120 = dftMag(seg, 20)
    const a180 = dftMag(seg, 30)
    expect(a60).toBeGreaterThan(100)
    expect(a180).toBeGreaterThan(a60 * 0.03) // 3 次谐波显著（x³ 理论比 ≈ 0.14）
    expect(a120).toBeLessThan(a60 * 0.01) // 奇次型几乎无 2 次谐波（奇函数）
  })

  it('无输入无输出（零输入 → 零输出）', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({}))
    const l = new Float32Array(4800)
    const r = new Float32Array(4800)
    be.processStereo(l, r)
    for (let i = 0; i < l.length; i++) {
      expect(l[i]).toBe(0)
      expect(r[i]).toBe(0)
    }
  })

  it('enabled=false 恒等', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({ enabled: false }))
    const n = 4800
    const inL = makeSine(n, 60, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    be.processStereo(l, r)
    expect(l).toEqual(inL)
    expect(r).toEqual(inR)
  })

  it('四种非线性类型均不产生 NaN/Infinity', () => {
    for (const t of ['odd', 'even', 'atan', 'soft'] as HarmonicType[]) {
      const be = new BassEnhancer(FS)
      be.setParams(settings({ harmonicType: t, levelDb: 6, harmonicGain: 1, mix: 1 }))
      const n = 4800
      const inL = makeSine(n, 60, 1.0)
      const inR = inL.slice()
      const l = inL.slice()
      const r = inR.slice()
      be.processStereo(l, r)
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) {
          throw new Error('non-finite output for type ' + t + ' at ' + i)
        }
      }
    }
  })

  it('harmonicGain=0 时输出=输入（谐波路径关闭）', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({ harmonicGain: 0 }))
    const n = 4800
    const inL = makeSine(n, 60, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    be.processStereo(l, r)
    // 谐波增益为 0 → 仅 dry，但滤波器状态可能残留极小数值；用容差
    let maxDiff = 0
    for (let i = 0; i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(l[i] - inL[i]))
    expect(maxDiff).toBeLessThan(1e-6)
  })

  it('lowBoostDb=+6 时低频带真实电平提升（harmonicGain=0，60Hz 稳态幅度≈×1.65）', () => {
    const be = new BassEnhancer(FS)
    be.setParams(settings({ harmonicGain: 0, lowBoostDb: 6 }))
    const n = 48000
    const l = makeSine(n, 60, 0.5)
    const r = l.slice()
    be.processStereo(l, r)
    // 跳过起始瞬态取稳态峰值：90Hz 低通在 60Hz 增益≈0.91、相移≈-60°，
    // 干声与低频带是向量和 |1 + (10^(6/20)−1)·0.91·e^(jφ)| ≈ 1.65 → 0.5×1.65 ≈ 0.825
    let peak = 0
    for (let i = 4800; i < n; i++) peak = Math.max(peak, Math.abs(l[i]))
    expect(peak).toBeGreaterThan(0.78)
    expect(peak).toBeLessThan(0.88)
  })

  it('lowBoostDb 越界钳制：+99→+12（幅度≈×3.3）、-99→-6（幅度≈×0.87），均无 NaN', () => {
    for (const [db, lo, hi] of [[99, 1.55, 1.78], [-99, 0.40, 0.47]] as Array<[number, number, number]>) {
      const be = new BassEnhancer(FS)
      be.setParams(settings({ harmonicGain: 0, lowBoostDb: db }))
      const n = 48000
      const l = makeSine(n, 60, 0.5)
      const r = l.slice()
      be.processStereo(l, r)
      let peak = 0
      let nonFinite = false
      for (let i = 4800; i < n; i++) {
        peak = Math.max(peak, Math.abs(l[i]))
        if (!Number.isFinite(l[i])) nonFinite = true
      }
      expect(nonFinite).toBe(false)
      expect(peak).toBeGreaterThan(lo)
      expect(peak).toBeLessThan(hi)
    }
  })
})
