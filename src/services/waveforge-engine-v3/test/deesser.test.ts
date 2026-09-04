/**
 * Deesser 单元测试 —— 技术文档 §4 / API_SPEC 模块 5
 * 物理意义：齿音（4–8kHz 频段能量爆发）被动态压低，而 200Hz 等非齿音频段不受影响。
 */
import { describe, expect, it } from 'vitest'
import { Deesser } from '../src/dsp/Deesser'

const FS = 48000

function makeSine(n: number, f: number, amp: number): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / FS)
  return x
}

function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / x.length)
}

function makeSettings(over: Partial<import('../src/types').DeesserSettings>): import('../src/types').DeesserSettings {
  return { enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1, ...over }
}

describe('Deesser', () => {
  it('8kHz 齿音频段正弦超阈值时输出明显衰减（>3dB，物理意义：齿音被压低）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ centerHz: 8000 }))
    const n = 48000 // 1s
    const inL = makeSine(n, 8000, 0.4)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    d.processStereo(l, r)
    // 取稳态段（跳过包络起振 ~100 样本）
    const half = Math.floor(n / 2)
    const ratio = rms(l.subarray(half)) / rms(inL.subarray(half))
    // 理论：带通中心 8kHz 完全通过 → env→0.16 → levelDb≈-8dB，超阈值 22dB，
    // reduction=22·7/8≈19dB，g≈0.11；LR-4 交叉(4.8k)下 8k 的低带残余 ≈0.06 → 输出 ≈ -24dB
    expect(ratio).toBeLessThan(0.6) // 至少 -4.4dB，满足 >3dB 要求
    expect(ratio).toBeGreaterThan(0.02) // 未被完全哑音（增益未过度）
  })

  it('200Hz 正弦不受影响（<0.1dB 变化，物理意义：非齿音频段保持原样）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({})) // 默认 centerHz=6000，阈值 -30dB
    const n = 48000
    const inL = makeSine(n, 200, 0.4)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    d.processStereo(l, r)
    // 侧链带通 6kHz/Q0.7 对 200Hz 衰减约 -27dB → 包络远低于阈值 → g=1；
    // 分带交叉 g=1 时为 LR-4 全通（幅度精确不变，仅相位旋转）→ 幅度差 <0.1dB
    const dbDelta = Math.abs(20 * Math.log10(rms(l) / rms(inL)))
    expect(dbDelta).toBeLessThan(0.1)
  })

  it('宽带式（splitBand=false）同样衰减', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ centerHz: 8000, splitBand: false }))
    const n = 48000
    const inL = makeSine(n, 8000, 0.4)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    d.processStereo(l, r)
    const half = Math.floor(n / 2)
    const ratio = rms(l.subarray(half)) / rms(inL.subarray(half))
    // 宽带式理论 g≈0.11 → -19dB
    expect(ratio).toBeLessThan(0.6)
  })

  it('enabled=false 输出=输入（恒等）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ enabled: false }))
    const n = 4800
    const inL = makeSine(n, 8000, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    d.processStereo(l, r)
    expect(l).toEqual(inL)
    expect(r).toEqual(inR)
  })

  it('mix=0 时输出=输入（干湿混合边界）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ centerHz: 8000, mix: 0 }))
    const n = 4800
    const inL = makeSine(n, 8000, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    d.processStereo(l, r)
    expect(l).toEqual(inL)
    expect(r).toEqual(inR)
  })
})
