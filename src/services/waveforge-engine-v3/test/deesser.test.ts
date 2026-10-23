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
    // reduction=22·7/8≈19dB，g≈0.11；一阶交叉(4.8k)仍保留低频支路，8k 有明显衰减
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
    // 分带残差干声同相，幅度差 <0.1dB
    const dbDelta = Math.abs(20 * Math.log10(rms(l) / rms(inL)))
    expect(dbDelta).toBeLessThan(0.1)
  })

  it('分带无衰减时逐样本恒等（低阈值未触发/ratio=1，避免全通相位混合）', () => {
    for (const settings of [{ thresholdDb: 0, ratio: 8 }, { thresholdDb: -70, ratio: 1 }]) {
      const d = new Deesser(FS)
      d.setParams(makeSettings({ ...settings, mix: 0.5, centerHz: 6000 }))
      const l = makeSine(12000, 3000, 0.2)
      const r = makeSine(12000, 6000, 0.1)
      const originalL = l.slice()
      const originalR = r.slice()
      d.processStereo(l, r)
      expect(l).toEqual(originalL)
      expect(r).toEqual(originalR)
    }
  })

  it('高频衰减时低频波形仍与干声同相（旧 LR4 全通相移会造成干湿梳状抵消）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ centerHz: 6000, thresholdDb: -50, mix: 0.5 }))
    const n = FS
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const low = 0.25 * Math.sin(2 * Math.PI * 200 * i / FS)
      const sib = 0.45 * Math.sin(2 * Math.PI * 6000 * i / FS)
      l[i] = r[i] = low + sib
    }
    const input = l.slice()
    d.processStereo(l, r)
    const start = n / 2
    let lowIn = 0, lowOut = 0, highIn = 0, highOut = 0
    for (let i = start; i < n; i++) {
      const a = 2 * Math.PI * 200 * i / FS
      const b = 2 * Math.PI * 6000 * i / FS
      lowIn += input[i] * Math.sin(a)
      lowOut += l[i] * Math.sin(a)
      highIn += input[i] * Math.sin(b)
      highOut += l[i] * Math.sin(b)
    }
    expect(Math.abs(lowOut / lowIn - 1)).toBeLessThan(0.01)
    expect(highOut / highIn).toBeLessThan(0.8)
  })

  it('旁路后重启不会用旧齿音包络衰减静音后的低电平片段', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ splitBand: false, centerHz: 6000 }))
    const hot = makeSine(10000, 6000, 0.5)
    d.processStereo(hot, hot.slice())
    d.setParams(makeSettings({ enabled: false, splitBand: false }))
    d.processStereo(new Float32Array(10000), new Float32Array(10000))
    d.setParams(makeSettings({ splitBand: false, centerHz: 6000 }))
    const quiet = makeSine(4096, 6000, 0.001)
    const l = quiet.slice(), r = quiet.slice()
    d.processStereo(l, r)
    expect(l).toEqual(quiet)
    expect(r).toEqual(quiet)
  })

  it('交叉频率的部分干湿混合无深陷（互补一阶分带，3600Hz 幅度保留）', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ centerHz: 6000, q: 0.7, thresholdDb: -70, ratio: 100, attackMs: 1, releaseMs: 80, splitBand: true, mix: 2 / 3 }))
    const n = FS
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const v = 0.1 * Math.sin(2 * Math.PI * 3600 * i / FS) + 0.6 * Math.sin(2 * Math.PI * 6000 * i / FS)
      l[i] = r[i] = v
    }
    d.processStereo(l, r)
    let sin = 0, cos = 0
    for (let i = n / 2; i < n; i++) {
      const angle = 2 * Math.PI * 3600 * i / FS
      sin += l[i] * Math.sin(angle)
      cos += l[i] * Math.cos(angle)
    }
    const gain = Math.hypot(sin, cos) * 2 / (n / 2) / 0.1
    expect(gain).toBeGreaterThan(0.55) // 原 LP4 残差此处约 -65dB 的深陷
    expect(gain).toBeLessThanOrEqual(1.01)
  })

  it('反相立体声齿音不会在侧链单声道求和时消失', () => {
    const d = new Deesser(FS)
    d.setParams(makeSettings({ splitBand: false, centerHz: 6000 }))
    const n = 24000
    const dry = makeSine(n, 6000, 0.4)
    const l = dry.slice()
    const r = dry.map((v) => -v)
    d.processStereo(l, r)
    expect(rms(l.subarray(n / 2)) / rms(dry.subarray(n / 2))).toBeLessThan(0.5)
    expect(rms(r.subarray(n / 2)) / rms(dry.subarray(n / 2))).toBeLessThan(0.5)
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
