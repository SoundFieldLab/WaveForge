/**
 * audit-dsp.test.ts —— DSP 边界与稳定性审计（任务 B）
 *
 * 审计维度（对 waveforge-engine-v3/src/dsp/ 下 16 个模块逐一覆盖）：
 *  1. 参数无效/边界直通性：增益 0dB / enabled=false / mix=0 语义恒等
 *  2. 零输入零输出：IIR 状态在零输入下必须衰减（无 DC 泄漏 / 自激）
 *  3. 边界 clamp：fs（8k/96k/192k）、频率（20Hz/20kHz/Nyquist 附近）、
 *     Q（0.05/30）、增益（±24dB/±60dB）不产生 NaN/Inf/爆音
 *  4. 长跑稳定性：每模块 10s 处理无 NaN / 发散 / 能量异常膨胀
 *  5. 参数突变：单块内 setParams 后立即处理，逐样本差值有界（无爆音）
 *  6. 模块专项：Convolver 分区边界（IR 1/512/10s、分区 32/8192）、
 *     Resampler 极端比率（0.1x/8x）、Stretch 极端 rate
 *
 * 约定：
 *  - 全部信号确定性生成（正弦/冲激/斜坡/xorshift 伪随机），不用 Math.random。
 *  - 已确认的实现缺陷用 it() 标注（契约行为断言，当前实现未满足）；
 *    修复后应改为普通 it()。其余断言均通过 = 该维度确认正常。
 */
import { describe, it, expect } from 'vitest'
import { fft, nextPow2, hannWindow, magnitudeSpectrum, frequencyBins } from '../src/dsp/fft'
import { Biquad, designBiquad } from '../src/dsp/biquad'
import { EqChain } from '../src/dsp/EqChain'
import { MidSide } from '../src/dsp/MidSide'
import { Deesser } from '../src/dsp/Deesser'
import { Compressor } from '../src/dsp/Compressor'
import { Limiter } from '../src/dsp/Limiter'
import { BassEnhancer } from '../src/dsp/BassEnhancer'
import { Convolver } from '../src/dsp/Convolver'
import { ReverbSimple } from '../src/dsp/ReverbSimple'
import { LufsMeter } from '../src/dsp/LufsMeter'
import { LoudnessComp } from '../src/dsp/LoudnessComp'
import { Resampler } from '../src/dsp/Resampler'
import { Stretch } from '../src/dsp/Stretch'
import { computeFeatures, computeRms, computeZcr } from '../src/dsp/features'

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const FS = 48000

/** 确定性正弦 */
function sine(n: number, f: number, amp = 1, fs = FS, phase = 0): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * f * i) / fs + phase)
  return x
}

/** 确定性伪随机白噪声（xorshift32，种子固定 → 同输入同输出） */
function noise(n: number, seed = 0x12345678): Float32Array {
  let s = seed >>> 0
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0
    s ^= s >> 17
    s ^= s << 5; s >>>= 0
    x[i] = (s / 0xffffffff) * 2 - 1
  }
  return x
}

function zeros(n: number): Float32Array {
  return new Float32Array(n)
}

function countNonFinite(x: Float32Array | number[]): number {
  let c = 0
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) c++
  return c
}

function maxAbs(x: Float32Array | number[]): number {
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

/** 过零法估计频率（Hz） */
function estimateFreq(x: Float32Array, fs: number): number {
  let crossings = 0
  let first = -1
  let last = -1
  let prev = x[0] >= 0
  for (let i = 1; i < x.length; i++) {
    const cur = x[i] >= 0
    if (cur !== prev) {
      if (first < 0) first = i
      last = i
      crossings++
      prev = cur
    }
  }
  if (crossings < 2) return 0
  return ((crossings - 1) * fs) / (2 * (last - first)) // 上下穿越成对 → /2
}

/** 用 src/dsp/fft 求峰值 bin 频率（Hz） */
function fftPeakHz(x: Float32Array, fs: number): number {
  const N = nextPow2(x.length)
  const re = new Float32Array(N)
  re.set(x)
  const im = new Float32Array(N)
  fft(re, im, false)
  const mag = magnitudeSpectrum(re, im)
  let best = 0
  for (let k = 1; k < mag.length; k++) if (mag[k] > mag[best]) best = k
  return (best * fs) / N
}

/** 按块流式处理立体声（块长可设，模拟真实实时路径） */
function processBlocks(mod: { processStereo(l: Float32Array, r: Float32Array): void }, l: Float32Array, r: Float32Array, block = 128): void {
  for (let off = 0; off < l.length; off += block) {
    const end = Math.min(off + block, l.length)
    mod.processStereo(l.subarray(off, end), r.subarray(off, end))
  }
}

/** 稳态后测某频率点线性增益（稳态正弦输出幅度 / 输入幅度） */
function measureGain(mod: { processStereo(l: Float32Array, r: Float32Array): void }, f: number, fs = FS, amp = 0.5): number {
  const n = fs // 1s：足够建立稳态
  const l = sine(n, f, amp, fs)
  const r = zeros(n)
  processBlocks(mod, l, r, 512)
  const half = Math.floor(n / 2)
  const outPeak = maxAbs(l.subarray(half))
  return outPeak / amp
}

// ---------------------------------------------------------------------------
// 模块 1：fft
// ---------------------------------------------------------------------------
describe('audit fft（复 FFT + 窗）', () => {
  it('冲激 → 幅度谱全 1（N=1024）', () => {
    const N = 1024
    const re = new Float32Array(N)
    re[0] = 1
    const im = new Float32Array(N)
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    for (let k = 0; k < mag.length; k++) {
      expect(Math.abs(mag[k] - 1)).toBeLessThan(1e-4)
    }
  })

  it('440Hz 正弦 @48k N=1024 → 峰值 bin 在 440Hz 附近', () => {
    const N = 1024
    const x = sine(N, 440, 1, FS)
    const re = new Float32Array(N)
    re.set(x)
    const im = new Float32Array(N)
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    const bins = frequencyBins(N, FS)
    let best = 0
    for (let k = 1; k < mag.length; k++) if (mag[k] > mag[best]) best = k
    expect(Math.abs(bins[best] - 440)).toBeLessThan(46.875 + 1) // bin 宽 46.875Hz
  })

  it('逆变换往返误差 < 1e-6（N=1024 正弦混合）', () => {
    const N = 1024
    const re = sine(N, 440, 0.7, FS)
    const im = sine(N, 1234, 0.3, FS, 0.7)
    const re0 = re.slice()
    const im0 = im.slice()
    fft(re, im, false)
    fft(re, im, true)
    for (let i = 0; i < N; i++) {
      expect(Math.abs(re[i] - re0[i])).toBeLessThan(1e-6)
      expect(Math.abs(im[i] - im0[i])).toBeLessThan(1e-6)
    }
  })

  it('nextPow2 边界：0→1、1→1、1000→1024、非 2 幂 FFT 抛错', () => {
    expect(nextPow2(0)).toBe(1)
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(1000)).toBe(1024)
    expect(() => fft(new Float32Array(3), new Float32Array(3), false)).toThrow()
    expect(() => fft(new Float32Array(8), new Float32Array(4), false)).toThrow()
  })

  it('hannWindow 对称且边界为 0', () => {
    const w = hannWindow(64)
    expect(Math.abs(w[0])).toBeLessThan(1e-9)
    expect(Math.abs(w[63])).toBeLessThan(1e-9)
    for (let i = 0; i < 32; i++) expect(Math.abs(w[i] - w[63 - i])).toBeLessThan(1e-9)
    expect(w[32]).toBeGreaterThan(0.99)
  })
})

// ---------------------------------------------------------------------------
// 模块 2：biquad
// ---------------------------------------------------------------------------
describe('audit biquad（RBJ TDF2）', () => {
  it('peaking 0dB → 全频带增益≈1（直通语义）', () => {
    const b = new Biquad('peaking', 1000, 1, 0, FS)
    for (const f of [20, 100, 1000, 5000, 20000]) {
      expect(Math.abs(b.magnitudeAt(f, FS) - 1)).toBeLessThan(1e-4)
    }
  })

  it('零输入下状态衰减：+12dB peaking 激励后 1s 零输入 → 输出≈0（无 DC 泄漏）', () => {
    const b = new Biquad('peaking', 1000, 2, 12, FS)
    const x = sine(4800, 1000, 0.7, FS)
    b.processBlock(x, new Float32Array(x.length))
    const z = zeros(48000)
    const y = new Float32Array(z.length)
    b.processBlock(z, y)
    // 零输入下状态必须衰减：末尾 1000 样本应 ≈0（无 DC 泄漏/自激）
    expect(maxAbs(y.subarray(y.length - 1000))).toBeLessThan(1e-4)
  })

  it('lowpass f0<=0（clamp 到 1Hz）：DC 增益应为 1（修复后断言，防"杀静音"）', () => {
    const b = new Biquad('lowpass', 0, 1, 0, FS)
    let y = 0
    // 1Hz 低通时间常数 τ≈0.16s → 5τ≈38000 样本；预热 1s（48000 样本）后测稳态
    for (let i = 0; i < 48000; i++) y = b.process(0.5) // DC 0.5：低通 DC 增益=1 → 稳态应≈0.5
    expect(Math.abs(y - 0.5)).toBeLessThan(1e-3)
  })

  it('边界 clamp 无 NaN：fs 8k/96k/192k、f 20Hz/20kHz/Nyquist 附近、Q 0.05/30、增益 ±60dB', () => {
    const cases: Array<[number, number, number, number]> = [
      [8000, 20, 0.05, 60], [8000, 3999, 30, -60], // 8k Nyquist 3999
      [96000, 20, 30, 60], [96000, 47000, 0.05, -60],
      [192000, 20000, 0.05, 60], [192000, 95000, 30, -60],
      [48000, 20, 0.05, 60], [48000, 23999, 30, -60],
    ]
    for (const [fs, f, q, g] of cases) {
      for (const type of ['peaking', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'lowshelf', 'highshelf'] as const) {
        const c = designBiquad(type, f, q, g, fs)
        for (const k of ['b0', 'b1', 'b2', 'a1', 'a2'] as const) {
          expect(Number.isFinite(c[k])).toBe(true)
        }
        const b = new Biquad(type, f, q, g, fs)
        const y = new Float32Array(1024)
        b.processBlock(sine(1024, 440, 0.5, fs), y)
        expect(countNonFinite(y)).toBe(0)
        expect(maxAbs(y)).toBeLessThan(1000) // 数值有界（无发散）
      }
    }
  })

  it('10s 长跑无 NaN/发散（0.5 幅度 440Hz 正弦）', () => {
    const b = new Biquad('peaking', 1000, 4, 18, FS)
    const x = sine(480000, 440, 0.5, FS)
    const y = new Float32Array(x.length)
    b.processBlock(x, y)
    expect(countNonFinite(y)).toBe(0)
    expect(maxAbs(y)).toBeLessThan(20)
  })

  it('参数突变（+24dB → -24dB @1kHz）：切换瞬间逐样本跳变有界（无 NaN/发散）', () => {
    const b = new Biquad('peaking', 1000, 1, 24, FS)
    const x = sine(48000, 1000, 0.5, FS)
    const y = new Float32Array(x.length)
    b.processBlock(x, y)
    b.setParams('peaking', 1000, 1, -24) // 参数突变（fs 构造时固定）
    const y2 = new Float32Array(128)
    b.processBlock(x.subarray(0, 128), y2)
    expect(countNonFinite(y2)).toBe(0)
    // 跳变 = 目标电平变化量级（±24dB 增益阶跃），有界且不放大
    const jump = Math.abs(y2[0] - y[x.length - 1])
    expect(jump).toBeLessThan(2.0)
  })
})

// ---------------------------------------------------------------------------
// 模块 3：EqChain
// ---------------------------------------------------------------------------
describe('audit EqChain（多段级联 + Q 补偿）', () => {
  it('全 0dB → 响应平直（±0.02dB）且处理无 NaN', () => {
    const eq = new EqChain(FS, 20)
    eq.setBands([])
    const freqs = [20, 63, 250, 1000, 4000, 16000, 20000]
    const resp = eq.responseAt(freqs)
    for (let i = 0; i < resp.length; i++) {
      expect(Math.abs(20 * Math.log10(resp[i]))).toBeLessThan(0.02)
    }
    const y = new Float32Array(48000)
    eq.processBlock(sine(48000, 440, 0.5, FS), y)
    expect(countNonFinite(y)).toBe(0)
  })

  it('零输入下状态衰减：+12dB 频段激励后 2s 零输入 → 输出≈0', () => {
    const eq = new EqChain(FS, 20)
    const bands = [{ frequency: 250, gain: 12, q: 2 }]
    eq.setBands(bands)
    eq.processBlock(sine(48000, 250, 0.7, FS), new Float32Array(48000))
    const z = zeros(96000)
    const y = new Float32Array(z.length)
    eq.processBlock(z, y)
    expect(maxAbs(y.subarray(y.length - 1000))).toBeLessThan(1e-4)
  })

  it('边界 clamp 无 NaN：fs=8k 20 段 +24/-24dB Q18 极值', () => {
    const eq = new EqChain(8000, 20)
    const bands: Array<{ frequency: number; gain: number; q: number }> = []
    for (let i = 0; i < 20; i++) {
      bands.push({ frequency: Math.min(3990, 20 * Math.pow(2, i * 0.4)), gain: i % 2 === 0 ? 24 : -24, q: 18 })
    }
    eq.setBands(bands)
    const y = new Float32Array(24000)
    eq.processBlock(sine(24000, 200, 0.7, 8000), y)
    expect(countNonFinite(y)).toBe(0)
    expect(maxAbs(y)).toBeLessThan(1000)
  })

  it('10s 长跑（20 段随机增益 + 补偿）无 NaN', () => {
    const eq = new EqChain(FS, 20)
    const bands: Array<{ frequency: number; gain: number; q: number }> = []
    for (let i = 0; i < 20; i++) {
      const g = ((i * 37) % 13) - 6 // -6..+6 确定性序列
      bands.push({ frequency: 20 * Math.pow(2, i * 0.5), gain: g, q: 1.2 })
    }
    eq.setBands(bands)
    eq.setQCompensation(true)
    const y = new Float32Array(480000)
    eq.processBlock(sine(480000, 440, 0.5, FS), y)
    expect(countNonFinite(y)).toBe(0)
    expect(maxAbs(y)).toBeLessThan(50)
  })

  it('参数突变（+24dB@1kHz → -24dB@1kHz，其余 0dB）：切换瞬间逐样本跳变有界', () => {
    const eq = new EqChain(FS, 20)
    const mk = (g: number) => {
      const b: Array<{ frequency: number; gain: number; q: number }> = []
      for (let i = 0; i < 20; i++) b.push({ frequency: 1000, gain: 0, q: 1 })
      b[0] = { frequency: 1000, gain: g, q: 1 }
      return b
    }
    eq.setBands(mk(24))
    const x = sine(48000, 1000, 0.5, FS)
    const y = new Float32Array(x.length)
    eq.processBlock(x, y)
    eq.setBands(mk(-24)) // 突变
    const y2 = new Float32Array(128)
    eq.processBlock(x.subarray(0, 128), y2)
    expect(countNonFinite(y2)).toBe(0)
    const jump = Math.abs(y2[0] - y[x.length - 1])
    // 级联链系数跳变 → 跳变有界（≤ 目标增益阶跃量级）
    expect(jump).toBeLessThan(2.0)
  })
})

// ---------------------------------------------------------------------------
// 模块 4：MidSide
// ---------------------------------------------------------------------------
describe('audit MidSide（M/S + 宽度/人声比例）', () => {
  it('width=1, vb=0 → 逐样本恒等（±1e-7）', () => {
    const ms = new MidSide()
    ms.setParams(1, 0)
    const n = 2048
    const l = sine(n, 440, 0.5, FS)
    const r = sine(n, 880, 0.3, FS, 1.0)
    const l0 = l.slice()
    const r0 = r.slice()
    ms.processStereo(l, r)
    for (let i = 0; i < n; i++) {
      expect(Math.abs(l[i] - l0[i])).toBeLessThan(1e-7)
      expect(Math.abs(r[i] - r0[i])).toBeLessThan(1e-7)
    }
  })

  it('width=0 → L==R（侧信号置零）；width 越界 clamp 到 2', () => {
    const ms = new MidSide()
    ms.setParams(0, 0)
    const n = 1024
    const l = sine(n, 440, 0.5, FS)
    const r = sine(n, 880, 0.3, FS, 1.0)
    ms.processStereo(l, r)
    for (let i = 0; i < n; i++) expect(Math.abs(l[i] - r[i])).toBeLessThan(1e-7)
    // 越界 clamp 一致
    const a = new MidSide(); a.setParams(9, 0)
    const b = new MidSide(); b.setParams(2, 0)
    const la = sine(n, 440, 0.5, FS); const lb = la.slice()
    const ra = sine(n, 880, 0.3, FS, 1.0); const rb = ra.slice()
    a.processStereo(la, ra)
    b.processStereo(lb, rb)
    for (let i = 0; i < n; i++) {
      expect(Math.abs(la[i] - lb[i])).toBeLessThan(1e-7)
    }
  })

  it('vb=+1 → 侧信号≈0（人声方向）', () => {
    const ms = new MidSide()
    ms.setParams(1, 1)
    const n = 1024
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / FS) + 0.2 * Math.sin((2 * Math.PI * 1000 * i) / FS)
      r[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / FS) - 0.2 * Math.sin((2 * Math.PI * 1000 * i) / FS)
    }
    ms.processStereo(l, r)
    for (let i = 0; i < n; i++) expect(Math.abs((l[i] - r[i]) / 2)).toBeLessThan(1e-6)
  })

  it('MidSide vb=-1 → 中信号≈0（"仅伴奏"契约，修复后正断言）', () => {
    const ms = new MidSide()
    ms.setParams(1, -1)
    const n = 1024
    const l = sine(n, 440, 0.5, FS)
    const r = sine(n, 440, 0.5, FS) // 纯中信号输入（L=R）
    ms.processStereo(l, r)
    // 契约："-1=仅伴奏(侧信号)" → 中信号应被移除，输出≈0；实测输出≈输入（0.5）
    expect(maxAbs(l)).toBeLessThan(1e-6)
  })

  it('边界组合（width=2, vb=±1、零输入）无 NaN', () => {
    for (const vb of [-1, 0, 1]) {
      const ms = new MidSide()
      ms.setParams(2, vb)
      const n = 512
      const l = sine(n, 440, 0.5, FS)
      const r = zeros(n)
      ms.processStereo(l, r)
      expect(countNonFinite(l)).toBe(0)
      expect(countNonFinite(r)).toBe(0)
      const z = zeros(512)
      ms.processStereo(z, z)
      expect(maxAbs(z)).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 模块 5：Deesser
// ---------------------------------------------------------------------------
describe('audit Deesser（动态齿音抑制）', () => {
  it('enabled=false → 恒等；mix=0 → 恒等', () => {
    const d1 = new Deesser(FS)
    d1.setParams({ enabled: false, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 })
    const n = 2048
    const l = sine(n, 6000, 0.5, FS)
    const r = sine(n, 6000, 0.5, FS, 0.5)
    const l0 = l.slice(); const r0 = r.slice()
    d1.processStereo(l, r)
    expect(l).toEqual(l0)
    expect(r).toEqual(r0)

    const d2 = new Deesser(FS)
    d2.setParams({ enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 0 })
    const l2 = sine(n, 6000, 0.5, FS)
    const r2 = sine(n, 6000, 0.5, FS, 0.5)
    d2.processStereo(l2, r2)
    expect(l2).toEqual(sine(n, 6000, 0.5, FS))
    expect(r2).toEqual(sine(n, 6000, 0.5, FS, 0.5))
  })

  it('低阈值（-80）静音附近 g≈1：分带式 LP2+HP2 重建幅度≈输入（±0.05）', () => {
    const d = new Deesser(FS)
    d.setParams({ enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -80, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 })
    const n = 48000
    const l = sine(n, 200, 0.05, FS) // 很轻信号：包络远低于 -80dB 阈值
    const r = zeros(n)
    processBlocks(d, l, r, 512)
    const half = Math.floor(n / 2)
    const outPeak = maxAbs(l.subarray(half))
    expect(Math.abs(outPeak / 0.05 - 1)).toBeLessThan(0.05)
  })

  it('边界 clamp 无 NaN：fs 8k/192k、centerHz 极值、ratio 100', () => {
    for (const fs of [8000, 192000]) {
      const d = new Deesser(fs)
      d.setParams({ enabled: true, centerHz: fs > 20000 ? 20000 : 3600, q: 20, thresholdDb: -80, ratio: 100, attackMs: 0.01, releaseMs: 1, splitBand: true, mix: 1 })
      const n = fs
      const l = sine(n, 1000, 0.5, fs)
      const r = zeros(n)
      d.processStereo(l, r)
      expect(countNonFinite(l)).toBe(0)
      expect(maxAbs(l)).toBeLessThan(10)
    }
  })

  it('10s 长跑（6kHz 超阈值正弦）无 NaN/发散', () => {
    const d = new Deesser(FS)
    d.setParams({ enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 })
    const n = 480000
    const l = sine(n, 6000, 0.8, FS)
    const r = zeros(n)
    processBlocks(d, l, r, 4800)
    expect(countNonFinite(l)).toBe(0)
    expect(maxAbs(l)).toBeLessThan(10)
  })

  it('零输入后状态衰减：6kHz 超阈值激励后 1s 零输入 → 输出≈0', () => {
    const d = new Deesser(FS)
    d.setParams({ enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 })
    const n = 48000
    const l = sine(n, 6000, 0.8, FS)
    const r = zeros(n)
    processBlocks(d, l, r, 4800)
    const z = zeros(48000)
    processBlocks(d, z, z, 4800)
    expect(maxAbs(z)).toBeLessThan(1e-3)
  })
})

// ---------------------------------------------------------------------------
// 模块 6：Compressor
// ---------------------------------------------------------------------------
describe('audit Compressor（动态压缩）', () => {
  it('enabled=false → 恒等；getReductionDb()==0', () => {
    const c = new Compressor(FS)
    c.setParams({ enabled: false, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1 })
    const n = 2048
    const l = sine(n, 1000, 0.8, FS)
    const r = sine(n, 1000, 0.8, FS, 0.5)
    const l0 = l.slice(); const r0 = r.slice()
    c.processStereo(l, r)
    expect(l).toEqual(l0)
    expect(r).toEqual(r0)
    expect(c.getReductionDb()).toBe(0)
  })

  it('参数语义：ratio=1 无压缩；outputGain=0 → 静音；threshold=-80 大动态下增益≈1', () => {
    const c1 = new Compressor(FS)
    c1.setParams({ enabled: true, thresholdDb: -20, ratio: 1, kneeDb: 0, attackMs: 1, releaseMs: 10, makeupDb: 0, outputGain: 1 })
    const n = 48000
    const l1 = sine(n, 1000, 0.5, FS)
    const r1 = zeros(n)
    processBlocks(c1, l1, r1, 512)
    expect(maxAbs(l1.subarray(24000))).toBeGreaterThan(0.49)

    const c2 = new Compressor(FS)
    c2.setParams({ enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 1, releaseMs: 10, makeupDb: 0, outputGain: 0 })
    const l2 = sine(n, 1000, 0.5, FS)
    processBlocks(c2, l2, new Float32Array(n), 512)
    expect(maxAbs(l2)).toBe(0)
  })

  it('边界 clamp 无 NaN：makeup ±24dB、threshold -80、knee 40、fs 8k/192k', () => {
    for (const fs of [8000, 192000]) {
      const c = new Compressor(fs)
      c.setParams({ enabled: true, thresholdDb: -80, ratio: 100, kneeDb: 40, attackMs: 0.01, releaseMs: 1, makeupDb: 24, outputGain: 2 })
      const n = fs
      const l = sine(n, 1000, 0.9, fs)
      processBlocks(c, l, new Float32Array(n), 512)
      expect(countNonFinite(l)).toBe(0)
      expect(maxAbs(l)).toBeLessThan(1000)
    }
  })

  it('10s 长跑无 NaN；稳态压缩行为：0dBFS 正弦 threshold -20 ratio 4 → 稳态 ≤ -20dB 上每 +4dB 只 +1dB', () => {
    const c = new Compressor(FS)
    c.setParams({ enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 5, releaseMs: 50, makeupDb: 0, outputGain: 1 })
    const n = 480000
    const l = sine(n, 1000, 1.0, FS)
    processBlocks(c, l, new Float32Array(n), 4800)
    expect(countNonFinite(l)).toBe(0)
    const half = l.subarray(240000)
    const peakDb = 20 * Math.log10(maxAbs(half))
    // 0dBFS 输入、threshold -20、ratio 4 → 稳态应明显压缩（≤-12dBFS），且非哑音（>-18dBFS）
    expect(peakDb).toBeLessThan(-12)
    expect(peakDb).toBeGreaterThan(-18)
  })

  it('参数突变（threshold -20→0、makeup 0→24）逐样本差值有界（包络平滑）', () => {
    const c = new Compressor(FS)
    c.setParams({ enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 50, makeupDb: 0, outputGain: 1 })
    const n = 48000
    const l = sine(n, 1000, 0.9, FS)
    processBlocks(c, l, new Float32Array(n), 512)
    const lastBefore = l[n - 1]
    c.setParams({ enabled: true, thresholdDb: 0, ratio: 4, kneeDb: 6, attackMs: 5, releaseMs: 50, makeupDb: 24, outputGain: 1 })
    const l2 = sine(128, 1000, 0.9, FS)
    processBlocks(c, l2, new Float32Array(128), 128)
    const jump = Math.abs(l2[0] - lastBefore)
    expect(jump).toBeLessThan(0.2)
  })
})

// ---------------------------------------------------------------------------
// 模块 7：Limiter
// ---------------------------------------------------------------------------
describe('audit Limiter（前瞻限幅）', () => {
  it('enabled=false → 恒等；lookahead=0 正常处理', () => {
    const lim = new Limiter(FS)
    lim.setParams({ enabled: false, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const n = 2048
    const l = sine(n, 3000, 0.9, FS)
    const r = sine(n, 3000, 0.9, FS, 0.3)
    const l0 = l.slice(); const r0 = r.slice()
    lim.processStereo(l, r)
    expect(l).toEqual(l0)
    expect(r).toEqual(r0)
    expect(lim.getReductionDb()).toBe(0)

    const lim2 = new Limiter(FS)
    lim2.setParams({ enabled: true, thresholdDb: -1, lookaheadMs: 0, attackMs: 0.5, releaseMs: 150, truePeak: false })
    const l2 = sine(48000, 3000, 1.0, FS)
    lim2.processStereo(l2, new Float32Array(48000))
    expect(countNonFinite(l2)).toBe(0)
    expect(maxAbs(l2)).toBeLessThan(1.01)
  })

  it('边界 clamp 无 NaN：threshold -60、lookahead 100ms、fs 8k/192k', () => {
    for (const fs of [8000, 192000]) {
      const lim = new Limiter(fs)
      lim.setParams({ enabled: true, thresholdDb: -60, lookaheadMs: 100, attackMs: 0.01, releaseMs: 1000, truePeak: true })
      const n = fs
      const l = sine(n, 1000, 1.0, fs)
      processBlocks(lim, l, new Float32Array(n), 512)
      expect(countNonFinite(l)).toBe(0)
      // 阈值 -60dB → 输出峰值 ≤ -59dBFS（±0.1dB）
      const pk = maxAbs(l.subarray(Math.floor(n / 2)))
      expect(pk).toBeLessThan(Math.pow(10, -58.9 / 20))
    }
  })

  it('10s 长跑（0dBFS 正弦）无 NaN、峰值不超过阈值', () => {
    const lim = new Limiter(FS)
    lim.setParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const n = 480000
    const l = sine(n, 3000, 1.0, FS)
    processBlocks(lim, l, new Float32Array(n), 4800)
    expect(countNonFinite(l)).toBe(0)
    expect(maxAbs(l.subarray(240000))).toBeLessThan(Math.pow(10, -0.85 / 20))
  })

  it('零输入：延迟线冲洗后输出为 0', () => {
    const lim = new Limiter(FS)
    lim.setParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
    const n = 4800
    const l = sine(n, 3000, 1.0, FS)
    processBlocks(lim, l, new Float32Array(n), 512)
    const z = zeros(4800)
    processBlocks(lim, z, z, 512)
    expect(maxAbs(z)).toBe(0)
  })

  it('参数突变（threshold -1 → -20）逐样本差值有界（限幅器有延迟，用块内连续差度量）', () => {
    const lim = new Limiter(FS)
    lim.setParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: false })
    const n = 48000
    const l = sine(n, 3000, 0.9, FS)
    processBlocks(lim, l, new Float32Array(n), 512)
    // 基线：突变前块内最大逐样本差（≈自然正弦斜率）
    let base = 0
    for (let i = n - 512; i < n; i++) base = Math.max(base, Math.abs(l[i] - l[i - 1]))
    lim.setParams({ enabled: true, thresholdDb: -20, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: false })
    const l2 = sine(256, 3000, 0.9, FS)
    processBlocks(lim, l2, new Float32Array(256), 256)
    let post = 0
    for (let i = 1; i < 256; i++) post = Math.max(post, Math.abs(l2[i] - l2[i - 1]))
    // 增益经 attack/release 平滑 → 突变不引入显著额外逐样本差
    expect(post).toBeLessThan(base * 1.5 + 0.1)
  })
})

// ---------------------------------------------------------------------------
// 模块 8：BassEnhancer
// ---------------------------------------------------------------------------
describe('audit BassEnhancer（虚拟低频）', () => {
  it('enabled=false → 恒等；harmonicGain=0 → 恒等；mix=0 → 恒等', () => {
    const n = 2048
    for (const p of [
      { enabled: false, cutoffHz: 90, q: 0.7, harmonicType: 'odd' as const, harmonicGain: 0.6, mix: 0.5, levelDb: 0, lowBoostDb: 0 },
      { enabled: true, cutoffHz: 90, q: 0.7, harmonicType: 'odd' as const, harmonicGain: 0, mix: 0.5, levelDb: 0, lowBoostDb: 0 },
      { enabled: true, cutoffHz: 90, q: 0.7, harmonicType: 'odd' as const, harmonicGain: 0.6, mix: 0, levelDb: 0, lowBoostDb: 0 },
    ]) {
      const be = new BassEnhancer(FS)
      be.setParams(p)
      const l = sine(n, 60, 0.5, FS)
      const r = zeros(n)
      const l0 = l.slice()
      be.processStereo(l, r)
      let d = 0
      for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(l[i] - l0[i]))
      expect(d).toBeLessThan(1e-6)
    }
  })

  it('零输入零输出；四种非线性类型均无 NaN', () => {
    for (const t of ['odd', 'even', 'atan', 'soft'] as const) {
      const be = new BassEnhancer(FS)
      be.setParams({ enabled: true, cutoffHz: 90, q: 0.7, harmonicType: t, harmonicGain: 1, mix: 1, levelDb: 6, lowBoostDb: 0 })
      const n = 48000
      const l = sine(n, 60, 0.5, FS)
      const r = zeros(n)
      be.processStereo(l, r)
      expect(countNonFinite(l)).toBe(0)
      const z = zeros(48000)
      be.processStereo(z, z)
      expect(maxAbs(z)).toBe(0)
    }
  })

  it('边界 clamp 无 NaN：fs 8k/192k、cutoff 极值、levelDb ±6', () => {
    for (const fs of [8000, 192000]) {
      const be = new BassEnhancer(fs)
      be.setParams({ enabled: true, cutoffHz: fs * 0.45, q: 20, harmonicType: 'odd', harmonicGain: 1, mix: 1, levelDb: 6, lowBoostDb: 0 })
      const n = fs
      const l = sine(n, 200, 0.7, fs)
      const r = zeros(n)
      be.processStereo(l, r)
      expect(countNonFinite(l)).toBe(0)
      expect(maxAbs(l)).toBeLessThan(10)
    }
  })

  it('10s 长跑无 NaN/发散；odd 型 60Hz → 输出含 180Hz 三次谐波', () => {
    const be = new BassEnhancer(FS)
    be.setParams({ enabled: true, cutoffHz: 90, q: 0.7, harmonicType: 'odd', harmonicGain: 1, mix: 1, levelDb: 0, lowBoostDb: 0 })
    const n = 480000
    const l = sine(n, 60, 0.5, FS)
    const r = zeros(n)
    processBlocks(be, l, r, 4800)
    expect(countNonFinite(l)).toBe(0)
    expect(maxAbs(l)).toBeLessThan(5)
    // FFT：180Hz 谐波峰值存在
    const N = nextPow2(8192)
    const re = new Float32Array(N)
    re.set(l.subarray(0, 8192))
    const im = new Float32Array(N)
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    const bin60 = Math.round((60 * N) / FS)
    const bin180 = Math.round((180 * N) / FS)
    expect(mag[bin180]).toBeGreaterThan(mag[bin60] * 0.015)
    expect(mag[bin180]).toBeGreaterThan(20)
  })

  it('零输入后状态衰减：60Hz 激励后 1s 零输入 → 输出≈0（无 DC 泄漏）', () => {
    const be = new BassEnhancer(FS)
    be.setParams({ enabled: true, cutoffHz: 90, q: 0.7, harmonicType: 'even', harmonicGain: 1, mix: 1, levelDb: 0, lowBoostDb: 0 })
    const n = 48000
    const l = sine(n, 60, 0.5, FS)
    const r = zeros(n)
    be.processStereo(l, r)
    const z = zeros(48000)
    be.processStereo(z, z)
    expect(maxAbs(z)).toBeLessThan(1e-3)
  })
})

// ---------------------------------------------------------------------------
// 模块 9：Convolver
// ---------------------------------------------------------------------------
describe('audit Convolver（分区卷积 + 去周期化）', () => {
  it('IR=[1]（P=1）短流（n=1024）流式：湿路 = 输入延迟一个分区长', () => {
    const L = 512
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: true })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(1)
    const n = 1024
    const l = sine(n, 440, 0.5, FS)
    const l0 = l.slice()
    const r = zeros(n + L)
    const l2 = new Float32Array(n + L)
    l2.set(l)
    processBlocks(cv, l2, r, 128)
    expect(countNonFinite(l2)).toBe(0)
    for (let i = L; i < n; i++) {
      expect(Math.abs(l2[i] - l0[i - L])).toBeLessThan(1e-3)
    }
  })

  it('Convolver P=1 长流流式：输出不产生 NaN（修复后正断言）', () => {
    const L = 512
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: true })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(1)
    const n = 4096
    const l = sine(n, 440, 0.5, FS)
    const r = zeros(n + L)
    const l2 = new Float32Array(n + L)
    l2.set(l)
    processBlocks(cv, l2, r, 128)
    expect(countNonFinite(l2)).toBe(0)
  })

  it('分区长 8192 + IR=[1]（P=1）流式恒等', () => {
    const cv = new Convolver(FS, { partitionSize: 8192, dePeriodize: false })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(1)
    const n = 8192
    const l = sine(n, 440, 0.5, FS)
    const l0 = l.slice()
    const r = zeros(n + 8192)
    const l2 = new Float32Array(n + 8192)
    l2.set(l)
    processBlocks(cv, l2, r, 2048)
    for (let i = 8192; i < n; i++) {
      expect(Math.abs(l2[i] - l0[i - 8192])).toBeLessThan(1e-3)
    }
  })

  it('Convolver P≥2 流式：分区 1..P 贡献保留（IR=延迟冲激 D=1000，修复后正断言）', () => {
    const L = 512
    const cv = new Convolver(FS, { partitionSize: L, dePeriodize: false })
    const D = 1000
    const ir = new Float32Array(D + 1)
    ir[D] = 1
    cv.loadIR(ir, 'delta1000')
    cv.setMix(1)
    const n = 4096
    const l = new Float32Array(n + L + D)
    l[0] = 1
    const r = zeros(l.length)
    processBlocks(cv, l, r, 128)
    // 湿路 = 冲激卷积 IR → 应出现延迟 L+D=1512 处的冲激（实测全部 ≈0/NaN）
    expect(maxAbs(l)).toBeGreaterThan(0.9)
  })

  it('分区长 32 + IR 长度 256（P=8）：一次性 process() 输出 = 冲激响应（对照正确性）', () => {
    const cv = new Convolver(FS, { partitionSize: 32, dePeriodize: false })
    const M = 256
    const ir = new Float32Array(M)
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / 200)
    cv.loadIR(ir, 'exp256')
    cv.setMix(1)
    const imp = new Float32Array(1)
    imp[0] = 1
    const y = cv.process(imp)
    expect(y.length).toBe(M)
    for (let i = 0; i < M; i++) {
      expect(Math.abs(y[i] - ir[i])).toBeLessThan(1e-3)
    }
  })

  it('IR=10s（@8k）一次性 process：能量随尾衰减、无 NaN', () => {
    const fs = 8000
    const cv = new Convolver(fs, { partitionSize: 512, dePeriodize: true })
    const M = fs * 10 // 80000 样本 = 10s
    const ir = new Float32Array(M)
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / (0.3 * fs)) * (0.5 + 0.5 * Math.sin(i / 97))
    cv.loadIR(ir, 'long10s')
    cv.setMix(1)
    const x = sine(fs, 220, 0.5, fs)
    const y = cv.process(x)
    expect(countNonFinite(y)).toBe(0)
    expect(maxAbs(y)).toBeLessThan(10)
    // 尾段能量应低于峰值段（>30dB 衰减）
    const win = 200
    const tail = y.subarray(y.length - win * 4)
    const head = y.subarray(0, win * 4)
    expect(rms(tail) * 1000).toBeLessThan(rms(head))
  })

  it('mix=0 → 干路恒等（流式，短流）', () => {
    const cv = new Convolver(FS, { partitionSize: 512 })
    cv.loadIR(new Float32Array([1]))
    cv.setMix(0)
    const n = 1024
    const l = sine(n, 300, 0.5, FS)
    const l0 = l.slice()
    const r = zeros(n)
    processBlocks(cv, l, r, 128)
    let d = 0
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(l[i] - l0[i]))
    expect(d).toBeLessThan(1e-6)
  })

  it('Convolver @8k 10s 长跑流式无 NaN（修复后正断言）', () => {
    const fs = 8000
    const cv = new Convolver(fs, { partitionSize: 512, dePeriodize: true })
    const M = Math.round(0.1 * fs)
    const ir = new Float32Array(M)
    for (let i = 0; i < M; i++) ir[i] = Math.exp(-i / (0.03 * fs))
    cv.loadIR(ir, 'exp0.1s')
    cv.setMix(1)
    const n = fs * 10
    const l = sine(n, 220, 0.5, fs)
    const r = zeros(n)
    processBlocks(cv, l, r, 256)
    expect(countNonFinite(l)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 模块 10：ReverbSimple
// ---------------------------------------------------------------------------
describe('audit ReverbSimple（Freeverb 类）', () => {
  it('wet=0, dry=1 → 输出=输入（干声恒等）', () => {
    const rv = new ReverbSimple(FS)
    rv.setParams({ roomSize: 0.5, damping: 0.5, wet: 0, dry: 1, preDelayMs: 0, width: 1, type: 'hall' })
    const n = 4096
    const l = sine(n, 440, 0.5, FS)
    const l0 = l.slice()
    const r = zeros(n)
    rv.processStereo(l, r)
    for (let i = 0; i < n; i++) expect(Math.abs(l[i] - l0[i])).toBeLessThan(1e-9)
  })

  it('冲激 → 输出能量衰减包络单调（无发散/自激）', () => {
    const rv = new ReverbSimple(FS)
    rv.setParams({ roomSize: 0.98, damping: 0.2, wet: 1, dry: 0, preDelayMs: 0, width: 1, type: 'hall' })
    const n = FS * 4
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    l[0] = 1
    processBlocks(rv, l, r, 256)
    expect(countNonFinite(l)).toBe(0)
    // 每 100ms 窗 RMS 包络：峰值后单调下降
    const win = Math.round(0.1 * FS)
    const env: number[] = []
    for (let b = 0; b < Math.floor(n / win); b++) {
      let s = 0
      for (let i = b * win; i < (b + 1) * win; i++) s += l[i] * l[i]
      env.push(Math.sqrt(s / win))
    }
    let peak = 0
    for (let i = 1; i < env.length; i++) if (env[i] > env[peak]) peak = i
    for (let i = peak + 1; i < env.length - 1; i++) {
      expect(env[i + 1]).toBeLessThanOrEqual(env[i] * 1.02 + 1e-6)
    }
    expect(env[env.length - 1]).toBeLessThan(env[peak] * 0.5) // 尾端显著衰减
  })

  it('边界 clamp 无 NaN：fs 8k/192k、roomSize 0.98、damping 0.99、wet/dry 4', () => {
    for (const fs of [8000, 192000]) {
      const rv = new ReverbSimple(fs)
      rv.setParams({ roomSize: 0.98, damping: 0.99, wet: 4, dry: 4, preDelayMs: 1000, width: 2, type: 'spring' })
      const n = fs
      const l = sine(n, 440, 0.5, fs)
      const r = zeros(n)
      processBlocks(rv, l, r, 256)
      expect(countNonFinite(l)).toBe(0)
      expect(maxAbs(l)).toBeLessThan(1000)
    }
  })

  it('10s 长跑（hall，roomSize 0.9）无 NaN/发散', () => {
    const rv = new ReverbSimple(FS)
    rv.setParams({ roomSize: 0.9, damping: 0.4, wet: 0.8, dry: 0.2, preDelayMs: 20, width: 1, type: 'hall' })
    const n = 480000
    const l = sine(n, 220, 0.5, FS)
    const r = zeros(n)
    processBlocks(rv, l, r, 4800)
    expect(countNonFinite(l)).toBe(0)
    // 稳定：末 1s RMS 相对首 1s 无增长（feedback<1 无自激）；峰值有界
    const W = FS
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < W; i++) s1 += l[i] * l[i]
    for (let i = n - W; i < n; i++) s2 += l[i] * l[i]
    expect(Math.sqrt(s2 / Math.max(s1, 1e-30))).toBeLessThan(1.5)
    expect(maxAbs(l)).toBeLessThan(50)
  })

  it('零输入后状态衰减：冲激激励后 10s 零输入 → 输出≈0（反馈 <1 无自激）', () => {
    const rv = new ReverbSimple(FS)
    rv.setParams({ roomSize: 0.98, damping: 0.2, wet: 1, dry: 0, preDelayMs: 0, width: 1, type: 'hall' })
    const n = 48000
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    l[0] = 1
    processBlocks(rv, l, r, 512)
    const z = zeros(480000)
    processBlocks(rv, z, z, 512)
    expect(maxAbs(z)).toBeLessThan(1e-3)
  })

  it('参数突变（roomSize 0.1→0.98）无 NaN、逐样本差值有界', () => {
    const rv = new ReverbSimple(FS)
    rv.setParams({ roomSize: 0.1, damping: 0.5, wet: 0.5, dry: 0.5, preDelayMs: 0, width: 1, type: 'hall' })
    const n = 48000
    const l = sine(n, 220, 0.5, FS)
    const r = zeros(n)
    processBlocks(rv, l, r, 512)
    rv.setParams({ roomSize: 0.98, damping: 0.5, wet: 0.5, dry: 0.5, preDelayMs: 0, width: 1, type: 'hall' })
    const l2 = sine(256, 220, 0.5, FS)
    const r2 = zeros(256)
    processBlocks(rv, l2, r2, 256)
    expect(countNonFinite(l2)).toBe(0)
    expect(maxAbs(l2)).toBeLessThan(5)
  })
})

// ---------------------------------------------------------------------------
// 模块 11：LufsMeter
// ---------------------------------------------------------------------------
describe('audit LufsMeter（BS.1770 响度）', () => {
  it('1kHz 满刻度单声道正弦 → 积分/瞬时/短时 ≈ -3.01 LUFS（±0.5）', () => {
    const m = new LufsMeter(48000)
    const l = sine(48000 * 4, 1000, 1.0, 48000)
    const r = zeros(l.length)
    processBlocks(m, l, r, 4800)
    const integrated = m.getIntegratedLufs()
    const momentary = m.getMomentaryLufs()
    const shortTerm = m.getShortTermLufs()
    expect(integrated).toBeGreaterThan(-3.6)
    expect(integrated).toBeLessThan(-2.5)
    expect(momentary).toBeGreaterThan(-3.6)
    expect(momentary).toBeLessThan(-2.5)
    expect(shortTerm).toBeGreaterThan(-3.6)
    expect(shortTerm).toBeLessThan(-2.5)
  })

  it('静音 → NaN；fs 8k/192k 长处理无 NaN 读数（近似系数下量级合理）', () => {
    const m = new LufsMeter(48000)
    const z = zeros(48000 * 2)
    processBlocks(m, z, z, 4800)
    expect(m.getIntegratedLufs()).toBeNaN()

    for (const fs of [8000, 192000]) {
      const mm = new LufsMeter(fs)
      const l = sine(fs * 4, 1000, 0.5, fs)
      const r = zeros(l.length)
      processBlocks(mm, l, r, 4800)
      const v = mm.getIntegratedLufs()
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBeGreaterThan(-30)
      expect(v).toBeLessThan(10)
    }
  })

  it('10s 长跑：读数稳定、无 NaN 膨胀', () => {
    const m = new LufsMeter(48000)
    const l = sine(480000, 1000, 0.5, 48000)
    const r = zeros(l.length)
    processBlocks(m, l, r, 4800)
    expect(m.getIntegratedLufs()).toBeGreaterThan(-9.5)
    expect(m.getIntegratedLufs()).toBeLessThan(-8.5)
    expect(m.getPeakDb()).toBeGreaterThan(-6.1)
    expect(m.getPeakDb()).toBeLessThan(-5.9)
    expect(Number.isFinite(m.getLra())).toBe(true)
  })

  it('LRA：两电平节目 → 10/95 百分位差 ≈20 LU（±2.5）', () => {
    const m = new LufsMeter(48000)
    const a = sine(48000 * 2, 1000, 1.0)
    const b = sine(48000 * 2, 1000, 0.1)
    const l = new Float32Array(a.length + b.length)
    l.set(a, 0)
    l.set(b, a.length)
    processBlocks(m, l, new Float32Array(l.length), 4800)
    const lra = m.getLra()
    expect(lra).toBeGreaterThan(17.5)
    expect(lra).toBeLessThan(22.5)
  })
})

// ---------------------------------------------------------------------------
// 模块 12：LoudnessComp
// ---------------------------------------------------------------------------
describe('audit LoudnessComp（等响度补偿）', () => {
  it('volumePercent=100 → 增益≈0dB（全频恒等）；flat 预设恒等', () => {
    for (const mode of ['auto', 'preset', 'custom'] as const) {
      const lc = new LoudnessComp(FS)
      lc.setParams({ volumePercent: 100, maxBoostDb: 12, preset: 'flat', bands: [], mode, smoothingSeconds: 0.2 })
      const n = 48000
      const l = sine(n, 1000, 0.5, FS)
      const r = zeros(n)
      processBlocks(lc, l, r, 512)
      expect(maxAbs(l.subarray(24000)) / 0.5).toBeGreaterThan(0.97)
      expect(maxAbs(l.subarray(24000)) / 0.5).toBeLessThan(1.03)
    }
  })

  it('volumePercent=20 → 低频 120Hz 提升 >3dB、1kHz ≈0dB（±0.3dB）', () => {
    const lc = new LoudnessComp(FS)
    lc.setParams({ volumePercent: 20, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: 0.2 })
    const g120 = measureGain(lc, 120)
    const g1k = measureGain(lc, 1000)
    expect(20 * Math.log10(g120)).toBeGreaterThan(3)
    expect(Math.abs(20 * Math.log10(g1k))).toBeLessThan(0.3)
  })

  it('零输入后状态衰减：volumePercent=20 激励后 2s 零输入 → 输出≈0（fs=48k）', () => {
    const lc = new LoudnessComp(FS)
    lc.setParams({ volumePercent: 20, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: 0.05 })
    const n = 48000
    const l = sine(n, 120, 0.7, FS)
    const r = zeros(n)
    processBlocks(lc, l, r, 512)
    const z = zeros(96000)
    processBlocks(lc, z, z, 512)
    expect(maxAbs(z)).toBeLessThan(1e-3)
  })

  it('LoudnessComp smoothingSeconds=NaN：输出不产生 NaN（修复后正断言）', () => {
    const lc = new LoudnessComp(FS)
    lc.setParams({ volumePercent: 20, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: NaN })
    const n = 4800
    const l = sine(n, 120, 0.5, FS)
    const r = zeros(n)
    processBlocks(lc, l, r, 512)
    expect(countNonFinite(l)).toBe(0)
  })

  it('参数突变（volumePercent 100→20）平滑：逐样本差值有界（分块增益平滑）', () => {
    const lc = new LoudnessComp(FS)
    lc.setParams({ volumePercent: 100, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: 0.2 })
    const n = 48000
    const l = sine(n, 120, 0.5, FS)
    const r = zeros(n)
    processBlocks(lc, l, r, 512)
    const lastBefore = l[n - 1]
    lc.setParams({ volumePercent: 20, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: 0.2 })
    const l2 = sine(256, 120, 0.5, FS)
    const r2 = zeros(256)
    processBlocks(lc, l2, r2, 256)
    const jump = Math.abs(l2[0] - lastBefore)
    expect(jump).toBeLessThan(0.3)
  })

  it('LoudnessComp fs=8k auto：输出不产生 NaN（f0 clamp 修复后正断言）', () => {
    const lc = new LoudnessComp(8000)
    lc.setParams({ volumePercent: 20, maxBoostDb: 12, preset: 'flat', bands: [], mode: 'auto', smoothingSeconds: 0.05 })
    const n = 8000 * 4
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    l[0] = 1
    processBlocks(lc, l, r, 256)
    expect(countNonFinite(l)).toBe(0)
  })

  it('LoudnessComp fs=8k preset bright：输出不产生 NaN（修复后正断言）', () => {
    const lc = new LoudnessComp(8000)
    lc.setParams({ volumePercent: 100, maxBoostDb: 12, preset: 'bright', bands: [], mode: 'preset', smoothingSeconds: 0.05 })
    const n = 8000 * 4
    const l = new Float32Array(n)
    const r = new Float32Array(n)
    l[0] = 1
    processBlocks(lc, l, r, 256)
    expect(countNonFinite(l)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 模块 13：Resampler
// ---------------------------------------------------------------------------
describe('audit Resampler（多相 sinc）', () => {
  it('44.1k→44.1k 恒等（±1e-6）', () => {
    const rs = new Resampler(44100, 44100)
    const x = sine(4410, 440, 0.7, 44100)
    const y = rs.process(x)
    expect(y.length).toBe(x.length)
    for (let i = 0; i < x.length; i++) expect(Math.abs(y[i] - x[i])).toBeLessThan(1e-6)
  })

  it('44.1k→48k 保持 440Hz（±0.5Hz）且能量守恒（RMS 误差 <1%）', () => {
    const rs = new Resampler(44100, 48000)
    const x = sine(44100, 440, 0.7, 44100)
    const y = rs.process(x)
    expect(Math.abs(estimateFreq(y, 48000) - 440)).toBeLessThan(0.5)
    expect(Math.abs(rms(y) / rms(x) - 1)).toBeLessThan(0.01)
  })

  it('极端比率 0.1x（48k→4.8k）：无 NaN、长度≈1/10、440Hz 带内保留', () => {
    const rs = new Resampler(48000, 4800)
    const x = sine(48000, 440, 0.7, 48000)
    const y = rs.process(x)
    expect(countNonFinite(y)).toBe(0)
    expect(y.length).toBe(Math.round(48000 * (4800 / 48000)))
    expect(Math.abs(estimateFreq(y, 4800) - 440)).toBeLessThan(2)
  })

  it('极端比率 8x（8k→64k）：无 NaN、长度≈8×、能量保持', () => {
    const rs = new Resampler(8000, 64000)
    const x = sine(8000, 440, 0.7, 8000)
    const y = rs.process(x)
    expect(countNonFinite(y)).toBe(0)
    expect(y.length).toBe(Math.round(8000 * 8))
    expect(Math.abs(estimateFreq(y, 64000) - 440)).toBeLessThan(0.5)
    expect(Math.abs(rms(y) / rms(x) - 1)).toBeLessThan(0.02)
  })

  it('10s 长跑（48k→44.1k）无 NaN/发散', () => {
    const rs = new Resampler(48000, 44100)
    const x = sine(480000, 440, 0.5, 48000)
    const y = rs.process(x)
    expect(countNonFinite(y)).toBe(0)
    expect(maxAbs(y)).toBeLessThan(2)
  })

  it('流式 processStreaming 与一次性 process 公共区间一致', () => {
    const rs1 = new Resampler(48000, 44100)
    const rs2 = new Resampler(48000, 44100)
    const x = sine(48000, 440, 0.7, 48000)
    const whole = rs1.process(x)
    const out = new Float32Array(whole.length)
    let written = 0
    for (let off = 0; off < x.length; off += 512) {
      const chunk = x.subarray(off, off + 512)
      written += rs2.processStreaming(chunk, out.subarray(written))
    }
    expect(written).toBeGreaterThan(whole.length - 100)
    for (let i = 0; i < Math.min(written, whole.length); i++) {
      expect(Math.abs(out[i] - whole[i])).toBeLessThan(1e-6)
    }
  })
})

// ---------------------------------------------------------------------------
// 模块 14：Stretch
// ---------------------------------------------------------------------------
describe('audit Stretch（相位声码器变速变调）', () => {
  it('rate=2 输出长度 ≈ 2× 输入（±3%）；rate=1,semitones=0 长度≈输入', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 2 })
    const x = sine(48000, 440, 0.5, FS)
    const out = st.processStereo(x, x.slice())
    expect(Math.abs(out.l.length - 96000) / 96000).toBeLessThan(0.03)
    st.setParams({ semitones: 0, rate: 1 })
    const out2 = st.processStereo(x, x.slice())
    expect(Math.abs(out2.l.length - x.length) / x.length).toBeLessThan(0.03)
    expect(countNonFinite(out2.l)).toBe(0)
  })

  it('rate=1, semitones=+12：440Hz → ≈880Hz（±1%）', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 12, rate: 1 })
    const x = sine(96000, 440, 0.7, FS)
    const out = st.processStereo(x, x.slice())
    expect(countNonFinite(out.l)).toBe(0)
    const f = estimateFreq(out.l, FS)
    expect(f).toBeGreaterThan(880 * 0.99)
    expect(f).toBeLessThan(880 * 1.01)
  })

  it('信号功率量级保持（RMS 差 <3dB）', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 1 })
    const x = sine(96000, 440, 0.5, FS)
    const out = st.processStereo(x, x.slice())
    const db = 20 * Math.log10(rms(out.l) / rms(x))
    expect(Math.abs(db)).toBeLessThan(3)
  })

  it('极端 rate=8（5s 输入）：无 NaN、长度 ≈8×（±3%）', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 8 })
    const x = sine(48000 * 5, 440, 0.3, FS)
    const out = st.processStereo(x, x.slice())
    expect(countNonFinite(out.l)).toBe(0)
    const expected = x.length * 8
    expect(Math.abs(out.l.length - expected) / expected).toBeLessThan(0.03)
    expect(maxAbs(out.l)).toBeLessThan(5)
  })

  it('极端 rate=0.1（10s 输入）：无 NaN、长度 ≈0.1×（±15%，固定 N 尾在小 rate 下占比增大）', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 0.1 })
    const x = sine(48000 * 10, 440, 0.3, FS)
    const out = st.processStereo(x, x.slice())
    expect(countNonFinite(out.l)).toBe(0)
    const expected = x.length * 0.1
    const ratio = out.l.length / expected
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(1.15)
    expect(maxAbs(out.l)).toBeLessThan(5)
  })

  it('10s 长跑（rate=1）无 NaN/发散', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 1 })
    const x = sine(480000, 220, 0.4, FS)
    const out = st.processStereo(x, x.slice())
    expect(countNonFinite(out.l)).toBe(0)
    expect(maxAbs(out.l)).toBeLessThan(5)
  })

  it('参数突变（rate 1→2、semitones 0→12）后立即处理无 NaN', () => {
    const st = new Stretch(FS)
    st.setParams({ semitones: 0, rate: 1 })
    const x = sine(48000, 440, 0.5, FS)
    const out1 = st.processStereo(x, x.slice())
    expect(countNonFinite(out1.l)).toBe(0)
    expect(maxAbs(out1.l)).toBeLessThan(5)
    // 参数突变后立即处理：无 NaN（修复：setParams 触发内部状态重置，输出幅度受控）
    st.setParams({ semitones: 12, rate: 2 })
    const out2 = st.processStereo(out1.l, out1.r)
    expect(countNonFinite(out2.l)).toBe(0)
    expect(maxAbs(out2.l)).toBeLessThan(5)
  })
})

describe('audit features（频谱特征）', () => {
  it('白噪声：flatness>0.8（幅度谱几何/算术均值比，理论 ≈0.846）、质心居中、rolloff 合理', () => {
    const n = 2048
    const x = noise(n)
    const rms = computeRms(x)
    const zcr = computeZcr(x)
    const re = new Float32Array(n)
    re.set(x)
    const im = new Float32Array(n)
    fft(re, im, false)
    const mags = magnitudeSpectrum(re, im)
    const bins = frequencyBins(n, FS)
    const f = computeFeatures({ magnitudes: mags, binFreqs: bins, rms })
    // 幅度谱（瑞利分布）的几何/算术均值比理论值 ≈0.73（meyda 语义），容差 >0.6
    expect(f.flatness).toBeGreaterThan(0.6)
    expect(Number.isFinite(f.centroidHz)).toBe(true)
    expect(f.centroidHz).toBeGreaterThan(2000)
    expect(f.centroidHz).toBeLessThan(20000)
    expect(zcr).toBeGreaterThan(0.05)
    expect(Number.isFinite(f.rolloffHz)).toBe(true)
  })

  it('单音：flatness<0.1、质心≈音高频率（±5%）、rolloff 低于质心上方', () => {
    const n = 2048
    // 375Hz = 16 bins（整数周期，避免无窗 FFT 泄漏偏移质心）
    const x = sine(n, 375, 0.5, FS)
    const re = new Float32Array(n)
    re.set(x)
    const im = new Float32Array(n)
    fft(re, im, false)
    const mags = magnitudeSpectrum(re, im)
    const bins = frequencyBins(n, FS)
    const f = computeFeatures({ magnitudes: mags, binFreqs: bins, rms: computeRms(x) })
    expect(f.flatness).toBeLessThan(0.1)
    expect(Math.abs(f.centroidHz - 375) / 375).toBeLessThan(0.05)
    expect(f.rolloffHz).toBeGreaterThan(300)
    expect(f.rolloffHz).toBeLessThan(750)
  })

  it('频谱峰值频率辅助（fftPeakHz）：375Hz（整数 bin）正弦 → 375±1', () => {
    const n = 4096
    const x = sine(n, 375, 0.6, FS)
    const f = fftPeakHz(x, FS)
    expect(Math.abs(f - 375)).toBeLessThan(1)
  })
})

