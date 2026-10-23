/**
 * WaveForge 音频效果引擎 v3 —— 频谱分析器（SpectrumAnalyzer）
 *
 * 出处/许可：自研实现；特征公式参考 meyda(MIT) extractors（rms/zcr/spectralCentroid/
 *   spectralRolloff/spectralFlatness/spectralCrest，技术文档 §12 / 映射表 #14）；
 *   FFT 内核使用自研 dsp/fft（kissfft 蝶形思路，BSD-3）。纯 TS、零运行时依赖。
 *
 * 用途：频谱可视化、引擎 getAnalysis 的特征统计、听力分析演示的频域依据。
 * 行为：processStereo 将 L+jR 打包做一次 Hann 窗复 FFT，再由镜像 bin 合并双声道功率，
 *   就地写 rawFFT 幅度谱 sqrt((|XL|²+|XR|²)/2)（N/2+1 bins，不改变 UI 的 N/2 缩放约定）；
 *   同帧计算双声道 RMS / 平均过零计数 / 质心 / 滚降 / 平坦度 / 峰值比。
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
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    if (!Number.isInteger(fftSize) || fftSize < 2 || fftSize > 0x40000000 || (fftSize & (fftSize - 1)) !== 0) {
      throw new Error('invalid fftSize: must be a power of two')
    }
    this.fftSize = fftSize
    this.binCount = fftSize / 2 + 1
    this.window = hannWindow(fftSize)
    this.binFreqs = frequencyBins(fftSize, fs)
    this.real = new Float32Array(fftSize)
    this.imag = new Float32Array(fftSize)
    this.magnitudes = new Float32Array(this.binCount)
    // 在构造阶段预热 twiddle 缓存，首个音频块也不分配 FFT 工作表。
    fft(this.real, this.imag, false)
  }

  /** 双声道平均功率分析；不足 fftSize 的部分及缺失声道按静音补零，不修改输入。 */
  processStereo(l: Float32Array, r: Float32Array): void {
    const n = this.fftSize
    const real = this.real
    const imag = this.imag
    const takeL = Math.min(l.length, n)
    const takeR = Math.min(r.length, n)
    const take = Math.max(takeL, takeR)
    let sumSquares = 0
    let crossings = 0
    for (let i = 0; i < n; i++) {
      const left = i < takeL ? l[i] : 0
      const right = i < takeR ? r[i] : 0
      real[i] = left * this.window[i]
      imag[i] = right * this.window[i]
      sumSquares += left * left + right * right
      if (i > 0) {
        if (i < takeL && (l[i - 1] >= 0) !== (left >= 0)) crossings++
        if (i < takeR && (r[i - 1] >= 0) !== (right >= 0)) crossings++
      }
    }
    fft(real, imag, false)

    // Z=FFT(L+jR)。镜像 bin 配对的平方和消去互相关项：
    // (|Z[k]|²+|Z[-k]|²)/4 = (|XL[k]|²+|XR[k]|²)/2。
    // 同相/反相等幅输入都保持原单声道 rawFFT 标度，不会因下混抵消或无故 +3dB。
    const mags = this.magnitudes
    for (let k = 0; k < this.binCount; k++) {
      const mirror = k === 0 ? 0 : n - k
      mags[k] = 0.5 * Math.hypot(real[k], imag[k], real[mirror], imag[mirror])
    }

    this.rms = take > 0 ? Math.sqrt(sumSquares / (2 * take)) : 0
    this.zcr = crossings * 0.5
    this.centroidHz = spectralCentroid(mags, this.binFreqs)
    this.rolloffHz = spectralRolloff(mags, this.binFreqs, 0.95)
    this.flatness = spectralFlatness(mags)
    this.crest = spectralCrest(mags)
  }

  /** N/2+1 个幅度谱 bin（内部缓冲的只读视图） */
  getMagnitudes(): Float32Array {
    return this.magnitudes
  }

  /** 默认返回独立快照；实时轮询可传 output 复用，避免分配而不改变旧调用方的所有权语义。 */
  getFeatures(output?: SpectralFeatures): SpectralFeatures {
    const out = output ?? { rms: 0, zcr: 0, centroidHz: 0, rolloffHz: 0, flatness: 0, crest: 0 }
    out.rms = this.rms
    out.zcr = this.zcr
    out.centroidHz = this.centroidHz
    out.rolloffHz = this.rolloffHz
    out.flatness = this.flatness
    out.crest = this.crest
    return out
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
