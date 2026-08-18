/**
 * Compressor 单元测试 —— 技术文档 §3 / API_SPEC 模块 6
 * 物理意义：超过阈值部分按 ratio 衰减（斜率 1/ratio）；软拐点平滑过渡；
 * attack/release 时域平滑保证无咔哒。
 *
 * 说明：峰值跟随包络对正弦永远收敛到 ≈0.90（attack=10ms）/ ≈0.98（attack=1ms）
 * 而非 1.0（一阶包络的固有滞后，数值模拟验证），因此绝对电平断言用 attack=1ms
 * 并允许 ±0.5dB；"斜率 1/4"（规格核心）与 attack 无关，用默认 10ms 验证。
 */
import { describe, expect, it } from 'vitest'
import { Compressor } from '../src/dsp/Compressor'

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

const settings = (over: Partial<import('../src/types').CompressorSettings> = {}): import('../src/types').CompressorSettings => ({
  enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1, ...over,
})

describe('Compressor', () => {
  it('0dBFS 正弦（thr -20dB, ratio 4）稳态输出峰值 ≈ -15dBFS', () => {
    const c = new Compressor(FS)
    c.setParams(settings({ attackMs: 1 })) // 快 attack：包络收敛到 ≈0.98，稳态电平更接近 -15dBFS
    const n = 96000 // 2s，足够包络收敛
    const inL = makeSine(n, 100, 1.0)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    c.processStereo(l, r)
    const half = Math.floor(n / 2)
    const outDb = 20 * Math.log10(peak(l.subarray(half)))
    // 稳态输出 ≈ -20 + (0-(-20))/4 = -15dBFS（±0.5dB；包络滞后使实测 ≈ -14.9）
    expect(outDb).toBeCloseTo(-15, 0)
  })

  it('阈值以上斜率 ≈ 1/ratio（每 +4dB 输入只 +1dB 输出）', () => {
    const n = 96000
    const half = Math.floor(n / 2)
    const levels = [-10, -6, 0]
    const outs: number[] = []
    for (const db of levels) {
      const c = new Compressor(FS)
      c.setParams(settings())
      const amp = Math.pow(10, db / 20)
      const l = makeSine(n, 100, amp)
      const r = l.slice()
      c.processStereo(l, r)
      outs.push(20 * Math.log10(peak(l.subarray(half))))
    }
    // 输出 dB 随输入 dB 的斜率应为 1/4 = 0.25（容差 ±0.1）
    const s1 = (outs[1] - outs[0]) / (levels[1] - levels[0])
    const s2 = (outs[2] - outs[1]) / (levels[2] - levels[1])
    expect(s1).toBeGreaterThan(0.15)
    expect(s1).toBeLessThan(0.35)
    expect(s2).toBeGreaterThan(0.15)
    expect(s2).toBeLessThan(0.35)
  })

  it('软拐点：输入恰在阈值处产生部分压缩（knee=6dB）', () => {
    const c = new Compressor(FS)
    c.setParams(settings({ kneeDb: 6, attackMs: 1, releaseMs: 100 }))
    const n = 4800
    // DC 0.1 → 20·log10(0.1) = -20dB，恰在阈值
    const l = new Float32Array(n).fill(0.1)
    const r = new Float32Array(n).fill(0.1)
    c.processStereo(l, r)
    // 理论：x = 3，reduction = (1-1/4)·3²/(2·6) = 0.5625dB
    expect(c.getReductionDb()).toBeCloseTo(-0.5625, 1) // ±0.05dB
    const expected = 0.1 * Math.pow(10, -0.5625 / 20)
    expect(Math.abs(l[n - 1] - expected)).toBeLessThan(1e-4)
  })

  it('attack/release 时域平滑无跳变（逐样本增益变化 <0.3dB）', () => {
    const c = new Compressor(FS)
    c.setParams(settings({}))
    const n = 12000
    let maxDelta = 0
    let prev = 0
    const reds: number[] = []
    for (let i = 0; i < n; i++) {
      const v = i >= 2000 ? 1.0 : 0.001 // 静音后突然 0dBFS 阶跃
      const l = new Float32Array([v])
      const r = new Float32Array([v])
      c.processStereo(l, r)
      const red = c.getReductionDb()
      reds.push(red)
      if (i > 0) {
        const d = Math.abs(red - prev)
        if (d > maxDelta) maxDelta = d
      }
      prev = red
    }
    // 物理意义：增益曲线是连续斜坡（硬拐点阈值附近对数域斜率最大 ≈0.12dB/样本
    // ≈ 5.8dB/ms），无阶跃跳变 → 无可闻咔哒；真爆音会是数 dB 的单样本跳变
    expect(maxDelta).toBeLessThan(0.3)
    // 稳态接近 -15dB
    expect(reds[reds.length - 1]).toBeLessThan(-14)
    // attack 阶段单调加深（非递增方向单调）
    let monotonic = true
    for (let i = 2001; i < reds.length - 100; i++) {
      if (reds[i + 1] > reds[i] + 1e-6) {
        monotonic = false
        break
      }
    }
    expect(monotonic).toBe(true)
  })

  it('enabled=false 输出=输入（恒等）', () => {
    const c = new Compressor(FS)
    c.setParams(settings({ enabled: false }))
    const n = 4800
    const inL = makeSine(n, 100, 0.5)
    const inR = inL.slice()
    const l = inL.slice()
    const r = inR.slice()
    c.processStereo(l, r)
    expect(l).toEqual(inL)
    expect(r).toEqual(inR)
    expect(c.getReductionDb()).toBe(0)
  })

  it('makeup 补偿按 dB 线性作用于输出', () => {
    const c = new Compressor(FS)
    c.setParams(settings({ makeupDb: 6, attackMs: 1 }))
    const n = 96000
    const half = Math.floor(n / 2)
    const inL = makeSine(n, 100, 1.0)
    const l = inL.slice()
    const r = inL.slice()
    c.processStereo(l, r)
    const outDb = 20 * Math.log10(peak(l.subarray(half)))
    // 无 makeup 时 ≈ -14.9dBFS，+6dB makeup → ≈ -8.9dBFS（±0.5dB）
    expect(outDb).toBeCloseTo(-9, 0)
    // RMS 也同步提升 6dB
    const rmsDb = 20 * Math.log10(rms(l.subarray(half)) / 0.7071)
    expect(rmsDb).toBeCloseTo(-9, 0)
  })
})
