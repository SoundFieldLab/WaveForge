/**
 * StretchLgplAdapter 单元测试（LGPL-2.1 链接适配器）
 * 物理意义（SoundTouch 语义）：
 *  - tempo = 播放速度 → 时长伸缩 rate 映射为 tempo=1/rate：rate=2 → 输出总时长 ≈ 输入×2；
 *  - semitones=+10（v2 范围上限）、rate=1 → 440Hz 变 ≈784Hz（时长不变），用 FFT 峰值验证；
 *  - 确定性：同输入同输出（位级一致，已实测原始库确定）；
 *  - 每个用例创建独立适配器实例（避免用例间状态污染）；
 *  - 未安装 soundtouchjs 时 createStretchLgplAdapter() 返回 null → 整组跳过。
 * 注意：输出总时长包含"尾部冲刷零样本"的伸缩结果（冲刷是输入的一部分），
 * 因此断言用 总喂入量 × rate（±8%）。
 */
import { describe, it, expect } from 'vitest'
import { createStretchLgplAdapter, type StretchLgplAdapter } from '../src/dsp/StretchLgplAdapter'
import { fft } from '../src/dsp/fft'

const FS = 48000
// 顶层 await 探测可用性（模块加载期即完成，skipIf 才能正确求值）
const available: StretchLgplAdapter | null = await createStretchLgplAdapter()

function sine(freq: number, n: number, amp = 0.5): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS)
  return x
}

/** 喂入信号 + 尾部零样本冲刷，返回累计输出（左声道）与总喂入帧数 */
function runAll(ad: StretchLgplAdapter, l: Float32Array, flushSec = 0.8): { out: Float32Array; fed: number } {
  const chunks: Float32Array[] = []
  const B = 480
  const total = l.length + Math.round(flushSec * FS)
  for (let off = 0; off < total; off += B) {
    const len = Math.min(B, total - off)
    const cl = new Float32Array(len)
    const cr = new Float32Array(len)
    for (let i = 0; i < len; i++) {
      const src = off + i
      cl[i] = src < l.length ? l[src] : 0
      cr[i] = src < l.length ? l[src] : 0
    }
    const out = ad.processStereo(cl, cr)
    chunks.push(out.l)
  }
  let totalLen = 0
  for (const c of chunks) totalLen += c.length
  const acc = new Float32Array(totalLen)
  let p = 0
  for (const c of chunks) {
    acc.set(c, p)
    p += c.length
  }
  return { out: acc, fed: total }
}

/** FFT 峰值频率（Hz） */
function peakFreq(x: Float32Array): number {
  const N = 8192
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  for (let i = 0; i < Math.min(x.length, N); i++) re[i] = x[i]
  fft(re, im, false)
  let best = 0
  let bestV = 0
  for (let k = 1; k < N / 2; k++) {
    const v = Math.hypot(re[k], im[k])
    if (v > bestV) {
      bestV = v
      best = k
    }
  }
  return (best * FS) / N
}

describe.skipIf(!available)('StretchLgplAdapter（LGPL-2.1 链接适配器）', () => {
  it('available=true，且 rate=2 时输出总时长 ≈ 喂入×2（±8%）', async () => {
    const ad = (await createStretchLgplAdapter())!
    expect(ad.available).toBe(true)
    ad.setParams(0, 2)
    const { out, fed } = runAll(ad, sine(440, FS)) // 1s + 0.8s 冲刷
    expect(out.length).toBeGreaterThan(fed * 2 * 0.92)
    expect(out.length).toBeLessThan(fed * 2 * 1.08)
  })

  it('semitones=+10（上限）、rate=1 → 440Hz 变 ≈784Hz（时长 ≈ 喂入×1 ±8%）', async () => {
    const ad = (await createStretchLgplAdapter())!
    ad.setParams(10, 1) // 440×2^(10/12) = 783.99Hz
    const { out, fed } = runAll(ad, sine(440, FS))
    expect(out.length).toBeGreaterThan(fed * 0.92)
    expect(out.length).toBeLessThan(fed * 1.08)
    const f = peakFreq(out)
    expect(Math.abs(f - 784)).toBeLessThan(30)
  })

  it('semitones=0、rate=1 → 频率保持 440Hz', async () => {
    const ad = (await createStretchLgplAdapter())!
    ad.setParams(0, 1)
    const { out } = runAll(ad, sine(440, FS))
    const f = peakFreq(out)
    expect(Math.abs(f - 440)).toBeLessThan(20)
  })

  it('确定性：同输入同输出（位级一致）', async () => {
    const ad1 = (await createStretchLgplAdapter())!
    const ad2 = (await createStretchLgplAdapter())!
    ad1.setParams(-2, 1.2)
    ad2.setParams(-2, 1.2)
    const x = sine(330, FS * 0.5)
    const o1 = runAll(ad1, x).out
    const o2 = runAll(ad2, x).out
    expect(o1.length).toBe(o2.length)
    for (let i = 0; i < o1.length; i++) {
      expect(o1[i]).toBe(o2[i])
    }
  })

  it('reset 后重新处理与全新实例一致', async () => {
    const fresh = (await createStretchLgplAdapter())!
    fresh.setParams(0, 1.5)
    const a = runAll(fresh, sine(220, FS * 0.5)).out
    fresh.reset()
    fresh.setParams(0, 1.5)
    const b = runAll(fresh, sine(220, FS * 0.5)).out
    expect(a.length).toBe(b.length)
    for (let i = 0; i < a.length; i++) expect(a[i]).toBe(b[i])
  })
})
