/**
 * features —— 频谱/时域特征提取（自研，meyda(MIT) 概念参考）
 *
 * 出处/许可：特征定义参考 meyda（MIT）与 research/docs/音频算法技术文档.md §12；
 * 本文件为独立实现，无代码复制。常用特征：
 *  - RMS：√(mean(x²)) —— 能量/响度粗估；
 *  - ZCR 过零率：符号变化次数/(N−1) —— 噪声/清浊音判别；
 *  - 频谱质心：Σ(f·|X|)/Σ|X| —— 亮度/明暗感；
 *  - 频谱滚降：累积能量达 percentile（默认 95%）的频率；
 *  - 频谱平坦度：几何均值/算术均值（纯音≈0、噪声≈1）；
 *  - 频谱波峰因子：max/mean（峰值突出度）。
 *
 * 契约说明：
 *  - computeFeatures 的输入只含幅度谱与频率轴（无时域信号），因此 zcr 无法由频谱推导；
 *    zcr 置 0 并注释说明——调用方若需 ZCR 请对时域信号单独调用 computeZcr。
 *    同理 rms 若未在 FeatureInput 提供则置 0（需时域信号）。
 *  - 确定性：纯求和/比值运算，无 Math.random / Date / console；空输入返回 0 或安全默认值。
 */
import type { SpectralFeatures } from '../types'

export interface FeatureInput {
  /** 幅度谱（N/2+1 个 bin，含直流与 Nyquist） */
  magnitudes: Float32Array
  /** 各 bin 中心频率 Hz（与 magnitudes 等长） */
  binFreqs: Float32Array
  /** 时域 RMS（可选；由调用方用 computeRms 计算后传入） */
  rms?: number
}

/** 汇总特征（zcr 需时域信号，FeatureInput 不含时域 → 恒为 0，见文件头契约说明）。 */
export function computeFeatures(input: FeatureInput): SpectralFeatures {
  const mags = input.magnitudes
  const freqs = input.binFreqs
  return {
    rms: input.rms !== undefined ? input.rms : 0,
    zcr: 0, // 无法从幅度谱推导过零率；调用方需对时域信号单独 computeZcr
    centroidHz: spectralCentroid(mags, freqs),
    rolloffHz: spectralRolloff(mags, freqs),
    flatness: spectralFlatness(mags),
    crest: spectralCrest(mags),
  }
}

/** RMS：√(mean(x²))。空输入返回 0。 */
export function computeRms(x: Float32Array): number {
  const n = x.length
  if (n === 0) return 0
  let s = 0
  for (let i = 0; i < n; i++) s += x[i] * x[i]
  return Math.sqrt(s / n)
}

/** 过零率：相邻样本符号变化的次数 / (N−1)。0 视为正号。噪声 ≈0.5，正弦 ≈2f/fs。 */
export function computeZcr(x: Float32Array): number {
  const n = x.length
  if (n < 2) return 0
  let crossings = 0
  let prev = x[0] >= 0
  for (let i = 1; i < n; i++) {
    const cur = x[i] >= 0
    if (cur !== prev) crossings++
    prev = cur
  }
  return crossings / (n - 1)
}

/** 频谱质心 Hz：Σ(f·|X|)/Σ|X|。总能量为 0 时返回 0。 */
export function spectralCentroid(mags: Float32Array, freqs: Float32Array): number {
  const n = Math.min(mags.length, freqs.length)
  if (n === 0) return 0
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const m = mags[i]
    num += freqs[i] * m
    den += m
  }
  return den > 0 ? num / den : 0
}

/**
 * 频谱滚降 Hz：累积能量（幅度和）首次达到 percentile·total 处的频率（bin 间线性插值）。
 * percentile 默认 0.95（meyda 同语义）。总能量为 0 时返回 0。
 */
export function spectralRolloff(mags: Float32Array, freqs: Float32Array, percentile = 0.95): number {
  const n = Math.min(mags.length, freqs.length)
  if (n === 0) return 0
  const p = Math.min(1, Math.max(0, percentile))
  let total = 0
  for (let i = 0; i < n; i++) total += mags[i]
  if (total <= 0) return 0
  const target = p * total
  let cum = 0
  for (let i = 0; i < n; i++) {
    const prevCum = cum
    cum += mags[i]
    if (cum >= target) {
      // 线性插值到 bin 内
      const frac = cum - prevCum > 0 ? (target - prevCum) / (cum - prevCum) : 0
      if (i === 0) return freqs[0]
      return freqs[i - 1] + (freqs[i] - freqs[i - 1]) * frac
    }
  }
  return freqs[n - 1]
}

/** 频谱平坦度：几何均值/算术均值（exp(mean(log m)) / mean(m)）。任一 bin 为 0 → 0。 */
export function spectralFlatness(mags: Float32Array): number {
  const n = mags.length
  if (n === 0) return 0
  let logSum = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const m = mags[i]
    if (m <= 0) return 0 // 几何均值含 0 → 平坦度为 0（纯音/带隙）
    logSum += Math.log(m)
    sum += m
  }
  if (sum <= 0) return 0
  return Math.exp(logSum / n) / (sum / n)
}

/** 频谱波峰因子：max(|X|)/mean(|X|)。平坦谱 ≈1；单一强峰 >>1。 */
export function spectralCrest(mags: Float32Array): number {
  const n = mags.length
  if (n === 0) return 0
  let mx = 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const m = mags[i]
    if (m > mx) mx = m
    sum += m
  }
  const mean = sum / n
  return mean > 0 ? mx / mean : 0
}
