/**
 * ReverbSimple 单元测试（模块 10：Freeverb 类算法混响）
 *
 * 物理意义注记：
 *  - wet=0 时应为纯干声（恒等），验证干路与混音路径；
 *  - 冲激响应能量包络应单调衰减且不发散（梳状反馈 <1 的稳定性）；
 *  - 干湿功率比：对宽带输入，干/湿两路近似不相关，混合功率应满足
 *    P_mix ≈ dry²·P_dry + wet²·P_wet（±10%）；
 *  - type 表：hall 长尾、room 短尾（同参数下衰减速度可区分）；
 *  - width=0 时湿路单声道化（左右输出一致）。
 */
import { describe, it, expect } from 'vitest'
import { ReverbSimple } from '../src/dsp/ReverbSimple'

const FS = 48000

/** 确定性 LCG 白噪声（均匀 -1..1）；不用 Math.random 以保持可复现 */
function lcgNoise(n: number, seed: number): Float32Array {
  const x = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    x[i] = (s / 4294967296) * 2 - 1
  }
  return x
}

/** 20ms 窗 RMS 包络（dB） */
function rmsEnvelopeDb(x: Float32Array, fs: number, winMs = 20): Float32Array {
  const win = Math.max(1, Math.round((winMs / 1000) * fs))
  const nBlocks = Math.floor(x.length / win)
  const env = new Float32Array(nBlocks)
  for (let b = 0; b < nBlocks; b++) {
    let s = 0
    for (let i = b * win; i < (b + 1) * win; i++) s += x[i] * x[i]
    const rms = Math.sqrt(s / win)
    env[b] = rms > 1e-12 ? 20 * Math.log10(rms) : -200
  }
  return env
}

function baseParams(over: Partial<Parameters<ReverbSimple['setParams']>[0]> = {}) {
  return {
    roomSize: 0.5,
    damping: 0.5,
    wet: 1,
    dry: 0,
    preDelayMs: 0,
    width: 1,
    type: 'hall' as const,
    ...over,
  }
}

/** 流式分块处理冲激，返回整段输出 */
function processImpulse(rev: ReverbSimple, n: number): { l: Float32Array; r: Float32Array } {
  const outL = new Float32Array(n)
  const outR = new Float32Array(n)
  const blk = 128
  for (let off = 0; off < n; off += blk) {
    const len = Math.min(blk, n - off)
    const l = new Float32Array(len)
    const r = new Float32Array(len)
    if (off === 0) l[0] = 1
    rev.processStereo(l, r)
    outL.set(l, off)
    outR.set(r, off)
  }
  return { l: outL, r: outR }
}

describe('ReverbSimple', () => {
  it('wet=0 时输出=干声（恒等，±1e-6）', () => {
    const rev = new ReverbSimple(FS)
    rev.setParams(baseParams({ wet: 0, dry: 1 }))
    const N = 2048
    const l = new Float32Array(N)
    const r = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 500 * i) / FS)
      r[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / FS)
    }
    const l0 = new Float32Array(l)
    const r0 = new Float32Array(r)
    rev.processStereo(l, r)
    for (let i = 0; i < N; i++) {
      expect(Math.abs(l[i] - l0[i])).toBeLessThan(1e-6)
      expect(Math.abs(r[i] - r0[i])).toBeLessThan(1e-6)
    }
  })

  it('冲激响应能量包络单调衰减（无发散），尾部落到峰值以下 >40dB', () => {
    const rev = new ReverbSimple(FS)
    rev.setParams(baseParams({ roomSize: 0.7, damping: 0.4, wet: 1, dry: 0 }))
    const n = Math.round(1.5 * FS)
    const { l } = processImpulse(rev, n)
    const env = rmsEnvelopeDb(l, FS)
    // 包络峰值位置
    let peak = 0
    for (let i = 1; i < env.length; i++) if (env[i] > env[peak]) peak = i
    // 峰值之后单调不升（允许 ±1dB 抖动——多梳状回声叠加的微小起伏）
    for (let i = peak + 1; i < env.length - 1; i++) {
      expect(env[i + 1]).toBeLessThanOrEqual(env[i] + 1.0)
    }
    expect(env[env.length - 1]).toBeLessThan(env[peak] - 40)
    // 无发散：全程幅度有界
    let maxAbs = 0
    for (let i = 0; i < n; i++) {
      const a = Math.abs(l[i])
      if (a > maxAbs) maxAbs = a
    }
    expect(maxAbs).toBeLessThan(4)
  })

  it('干湿功率比接近设定（±10%）：P_mix ≈ dry²·P_dry + wet²·P_wet', () => {
    // 宽带白噪声：干/湿路不相关 → 混合功率线性相加
    const x = lcgNoise(2 * FS, 12345)
    const measure = (dry: number, wet: number): number => {
      const rev = new ReverbSimple(FS)
      rev.setParams(baseParams({ dry, wet, width: 1, roomSize: 0.6, damping: 0.3 }))
      const out = new Float32Array(x.length)
      const blk = 512
      for (let off = 0; off < x.length; off += blk) {
        const len = Math.min(blk, x.length - off)
        const l = new Float32Array(len)
        const r = new Float32Array(len)
        l.set(x.subarray(off, off + len))
        rev.processStereo(l, r)
        out.set(l, off)
      }
      // 只测稳态段（跳过前 0.5s 冲激响应填充期）
      const start = Math.floor(0.5 * FS)
      let s = 0
      for (let i = start; i < x.length; i++) s += out[i] * out[i]
      return s / (x.length - start)
    }
    const pDry = measure(1, 0)
    const pWet = measure(0, 1)
    const pMix = measure(0.7, 0.3)
    const expected = 0.7 * 0.7 * pDry + 0.3 * 0.3 * pWet
    expect(Math.abs(pMix - expected) / expected).toBeLessThan(0.1)
  })

  it('type 表：hall 尾音长于 room（同 wet/roomSize 参数下）', () => {
    const n = Math.round(1.0 * FS)
    const hall = new ReverbSimple(FS)
    hall.setParams(baseParams({ type: 'hall' }))
    const { l: lHall } = processImpulse(hall, n)
    const room = new ReverbSimple(FS)
    room.setParams(baseParams({ type: 'room' }))
    const { l: lRoom } = processImpulse(room, n)
    const envHall = rmsEnvelopeDb(lHall, FS)
    const envRoom = rmsEnvelopeDb(lRoom, FS)
    const at = Math.floor(0.5 * FS / ((20 / 1000) * FS)) // 0.5s 处
    // hall 0.5s 处能量应明显高于 room（hall 表反馈更强）
    expect(envHall[at]).toBeGreaterThan(envRoom[at] + 5)
  })

  it('width=0 时湿路单声道化（相同输入 → 左右输出一致）', () => {
    const rev = new ReverbSimple(FS)
    rev.setParams(baseParams({ width: 0, wet: 1, dry: 0 }))
    const n = Math.round(0.8 * FS)
    const blk = 128
    for (let off = 0; off < n; off += blk) {
      const len = Math.min(blk, n - off)
      const l = new Float32Array(len)
      const r = new Float32Array(len)
      if (off === 0) {
        l[0] = 1
        r[0] = 1
      }
      rev.processStereo(l, r)
      for (let i = 0; i < len; i++) {
        expect(Math.abs(l[i] - r[i])).toBeLessThan(1e-6)
      }
    }
  })

  it('preDelay 生效：冲激在 preDelay 前无湿输出', () => {
    const rev = new ReverbSimple(FS)
    rev.setParams(baseParams({ preDelayMs: 20, wet: 1, dry: 0 }))
    const n = Math.round(0.3 * FS)
    const { l } = processImpulse(rev, n)
    const pd = Math.round(0.02 * FS) // 960 样本
    // preDelay 内（且早于第一个梳状回声）应基本为 0
    for (let i = 0; i < pd; i++) {
      expect(Math.abs(l[i])).toBeLessThan(1e-9)
    }
    // preDelay 之后应出现能量
    let afterPeak = 0
    for (let i = pd; i < pd + 2000; i++) {
      const a = Math.abs(l[i])
      if (a > afterPeak) afterPeak = a
    }
    expect(afterPeak).toBeGreaterThan(1e-4)
  })

  it('非法采样率抛错', () => {
    expect(() => new ReverbSimple(0)).toThrow()
    expect(() => new ReverbSimple(-48000)).toThrow()
  })
});
