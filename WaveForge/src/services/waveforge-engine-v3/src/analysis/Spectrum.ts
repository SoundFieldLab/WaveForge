/**
 * WaveForge 音频效果引擎 v3 —— 频谱分析器（SpectrumAnalyzer）
 *
 * 出处/许可：自研实现；特征公式参考 meyda(MIT) extractors（rms/zcr/spectralCentroid/
 *   spectralRolloff/spectralFlatness/spectralCrest，技术文档 §12 / 映射表 #14）；
 *   FFT 内核使用自研 dsp/fft（kissfft 蝶形思路，BSD-3）。纯 TS、零运行时依赖。
 *
 * 用途：频谱可视化、引擎 getAnalysis 的特征统计、听力分析演示的频域依据。
 * 行为：processStereo 取 L 通道前 fftSize 个样本，加 Hann 窗后做复 FFT，
 *   就地写幅度谱（N/2+1 bins）；同帧计算 RMS / 过零率 / 质心 / 滚降 / 平坦度 / 峰值比。
 * 性能：FFT 缓冲与幅度谱在构造时预分配，process 内零分配。
 */

import { fft, hannWindow, frequencyBins } from '../dsp/fft'
import type { SpectralFeatures } from '../types'

export class SpectrumAnalyzer {
  private readonly fftSize: number
  private readonly binCount: number // N/2+1
  private readonly window: Float32Array
  private readonly binFreqs: Float32Array
  private readonly real: Float32Array
  private readonly imag: Float32Array
  private readonly magnitudes: Float32Array
  private rms = 0
  private zcr = 0
  private centroidHz = 0
  private rolloffHz = 0
  private flatness = 0
  private crest = 0

  constructor(fftSize = 2048, fs: number) {
    if (!(fs > 0)) throw new Error('invalid sample rate')
    if (fftSize < 2 || (fftSize & (fftSize - 1)) !== 0) {
      throw new Error('invalid fftSize: must be a power of two')
    }
    this.fftSize = fftSize
    this.binCount = fftSize / 2 + 1
    this.window = hannWindow(fftSize)
    this.binFreqs = frequencyBins(fftSize, fs)
    this.real = new Float32Array(fftSize)
    this.imag = new Float32Array(fftSize)
    this.magnitudes = new Float32Array(this.binCount)
  }

  /** 就地分析（取 L 通道，Hann 窗；r 通道忽略） */
  processStereo(l: Float32Array, _r: Float32Array): void {
    const n = this.fftSize
    const real = this.real
    const take = Math.min(l.length, n)
    let i = 0
    for (; i < take; i++) real[i] = l[i] * this.window[i]
    for (; i < n; i++) real[i] = 0 // 不足 fftSize 的部分补零
    this.imag.fill(0)
    fft(real, this.imag, false)

    // 幅度谱（就地写入预分配缓冲；N/2+1 个 bin，含直流与 Nyquist）
    const mags = this.magnitudes
    for (let k = 0; k < this.binCount; k++) {
      const re = real[k]
      const im = this.imag[k]
      mags[k] = Math.sqrt(re * re + im * im)
    }

    // 时域特征（对实际取到的样本计算；count=0 时为空输入，特征置 0）
    this.rms = computeRms(l, take)
    this.zcr = computeZcr(l, take)
    this.centroidHz = spectralCentroid(mags, this.binFreqs)
    this.rolloffHz = spectralRolloff(mags, this.binFreqs, 0.95)
    this.flatness = spectralFlatness(mags)
    this.crest = spectralCrest(mags)
  }

  /** N/2+1 个幅度谱 bin（内部缓冲的只读视图） */
  getMagnitudes(): Float32Array {
    return this.magnitudes
  }

  getFeatures(): SpectralFeatures {
    return {
      rms: this.rms,
      zcr: this.zcr,
      centroidHz: this.centroidHz,
      rolloffHz: this.rolloffHz,
      flatness: this.flatness,
      crest: this.crest,
    }
  }

  reset(): void {
    this.magnitudes.fill(0)
    this.real.fill(0)
    this.imag.fill(0)
    this.rms = 0
    this.zcr = 0
    this.centroidHz = 0
    this.rolloffHz = 0
    this.flatness = 0
    this.crest = 0
  }
}

// ---------------------------------------------------------------------------
// meyda 式特征（自研实现，公式对齐 meyda(MIT) extractors）
// ---------------------------------------------------------------------------

/** RMS = sqrt(mean(x²))，取前 count 个样本；count<=0 返回 0 */
function computeRms(x: Float32Array, count: number): number {
  if (count <= 0) return 0
  let s = 0
  for (let i = 0; i < count; i++) s += x[i] * x[i]
  return Math.sqrt(s / count)
}

/** 过零率（符号变化次数，meyda 语义：返回计数而非归一化比率） */
function computeZcr(x: Float32Array, count: number): number {
  if (count <= 1) return 0
  let z = 0
  for (let i = 1; i < count; i++) {
    if ((x[i - 1] >= 0 && x[i] < 0) || (x[i - 1] < 0 && x[i] >= 0)) z++
  }
  return z
}

/** 频谱质心 Hz = Σ(f·|X|)/Σ|X|（meyda 一阶矩，bin 频率加权） */
function spectralCentroid(mags: Float32Array, freqs: Float32Array): number {
  let num = 0
  let den = 0
  for (let i = 0; i < mags.length; i++) {
    num += freqs[i] * mags[i]
    den += mags[i]
  }
  return den > 0 ? num / den : 0
}

/** 频谱滚降 Hz：累积能量达到 percentile（默认 0.95）处的频率 */
function spectralRolloff(mags: Float32Array, freqs: Float32Array, percentile = 0.95): number {
  let total = 0
  for (let i = 0; i < mags.length; i++) total += mags[i]
  if (total <= 0) return 0
  const threshold = percentile * total
  let acc = 0
  for (let i = 0; i < mags.length; i++) {
    acc += mags[i]
    if (acc >= threshold) return freqs[i]
  }
  return freqs[freqs.length - 1]
}

/**
 * 频谱平坦度 = 幅度谱几何均值 / 算术均值（meyda 语义：直接对幅度谱）。
 * 纯音→≈0（音调性强），白噪声→≈1（平坦）。零值 bin 用极小量 eps 保护 log。
 */
function spectralFlatness(mags: Float32Array): number {
  const n = mags.length
  if (n === 0) return 0
  const eps = 1e-12
  let logSum = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const m = mags[i]
    logSum += Math.log(m > 0 ? m : eps)
    sum += m
  }
  return sum > 0 ? (Math.exp(logSum / n) * n) / sum : 0
}

/** 频谱峰值比 crest = 峰值幅度 / 幅度谱 RMS（meyda 语义） */
function spectralCrest(mags: Float32Array): number {
  const n = mags.length
  if (n === 0) return 0
  let peak = -Infinity
  let sq = 0
  for (let i = 0; i < n; i++) {
    const m = mags[i]
    if (m > peak) peak = m
    sq += m * m
  }
  const rms = Math.sqrt(sq / n)
  return rms > 0 ? peak / rms : 0
}
