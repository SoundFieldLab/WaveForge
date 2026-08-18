/**
 * test/features.test.ts —— 频谱/时域特征单测
 * 物理含义说明：
 *  - 白噪声（幅度谱平坦）→ 平坦度≈1、质心≈频谱中点、ZCR 高（≈0.5）；
 *  - 单音 → 平坦度≈0（<0.1）、质心≈音高频率、ZCR = 2f/fs（正弦每周期两次过零）。
 */
import { describe, it, expect } from 'vitest'
import {
  computeFeatures,
  computeRms,
  computeZcr,
  spectralCentroid,
  spectralRolloff,
  spectralFlatness,
  spectralCrest,
} from '../src/dsp/features'
import type { FeatureInput } from '../src/dsp/features'

const FS = 48000
const N = 2048 // 对应 FFT N/2+1 = 1025 个 bin

/** 平坦幅度谱（白噪声理想化） */
function flatMags(bins: number, value = 1): Float32Array {
  return new Float32Array(bins).fill(value)
}

/** 单一强峰幅度谱（纯音理想化） */
function peakMags(bins: number, peakBin: number): Float32Array {
  const m = new Float32Array(bins)
  m[peakBin] = 1
  return m
}

function binFreqs(bins: number, fs: number, n: number): Float32Array {
  const f = new Float32Array(bins)
  for (let i = 0; i < bins; i++) f[i] = (i * fs) / n
  return f
}

function sine(fs: number, freq: number, n: number, amp = 1): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

/** 确定性白噪声（LCG） */
function whiteNoise(n: number, seed = 7): Float32Array {
  const x = new Float32Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    x[i] = ((s >>> 8) / 0xffffff) * 2 - 1
  }
  return x
}

describe('features', () => {
  it('computeRms：正弦 RMS = A/√2（±1e-3）', () => {
    const x = sine(FS, 440, FS) // 1 秒，整数周期
    // 物理：正弦均值功率 = A²/2 → RMS = A/√2
    expect(Math.abs(computeRms(x) - 1 / Math.SQRT2)).toBeLessThan(1e-3)
  })

  it('computeZcr：正弦 ≈ 2f/fs；白噪声显著更高', () => {
    const tone = sine(FS, 440, FS)
    const zcrTone = computeZcr(tone)
    // 物理：每周期两次过零 → ZCR ≈ 2·440/48000
    expect(Math.abs(zcrTone - (2 * 440) / FS)).toBeLessThan(2e-3)
    const zcrNoise = computeZcr(whiteNoise(FS))
    // 噪声每样本约 50% 概率变号 → ZCR ≈ 0.5，明显大于正弦
    expect(zcrNoise).toBeGreaterThan(zcrTone * 5)
    expect(zcrNoise).toBeGreaterThan(0.3)
  })

  it('spectralCentroid：单峰 → 峰所在频率；平坦谱 → 频谱中点', () => {
    const bins = N / 2 + 1
    const freqs = binFreqs(bins, FS, N)
    const peakBin = 440 // 440Hz bin（23.4375Hz/bin → 440/23.4375 ≈ 18.77，取整 bin）
    const fPeak = freqs[peakBin]
    const c = spectralCentroid(peakMags(bins, peakBin), freqs)
    expect(Math.abs(c - fPeak)).toBeLessThan(1e-3)
    const cFlat = spectralCentroid(flatMags(bins), freqs)
    // 平坦谱质心 = 频率均值 = 中点
    const mid = (freqs[0] + freqs[bins - 1]) / 2
    expect(Math.abs(cFlat - mid)).toBeLessThan(1)
  })

  it('spectralRolloff：能量集中时滚降在峰附近；平坦谱约在 95% 位置', () => {
    const bins = N / 2 + 1
    const freqs = binFreqs(bins, FS, N)
    // 单峰：95% 能量在峰前累计 → 滚降 ≈ 峰频率（插值后略低于峰）
    const peakBin = 100
    const roll = spectralRolloff(peakMags(bins, peakBin), freqs, 0.95)
    expect(roll).toBeGreaterThan(freqs[peakBin - 1])
    expect(roll).toBeLessThanOrEqual(freqs[peakBin])
    // 平坦谱：95% 能量点 = 95% 频率跨度处
    const rollFlat = spectralRolloff(flatMags(bins), freqs, 0.95)
    expect(Math.abs(rollFlat - 0.95 * freqs[bins - 1]) / freqs[bins - 1]).toBeLessThan(0.01)
  })

  it('spectralFlatness：平坦谱 ≈1（>0.99）；单峰 ≈0（<0.1）', () => {
    const bins = N / 2 + 1
    // 物理：几何均值/算术均值；平坦 → 比值 1；单峰 → 几何均值趋 0
    expect(spectralFlatness(flatMags(bins))).toBeGreaterThan(0.99)
    expect(spectralFlatness(peakMags(bins, 50))).toBeLessThan(0.1)
    // 含 0 bin → 平坦度为 0（几何均值含 0）
    const m = new Float32Array(bins)
    m[0] = 1
    m[10] = 1
    expect(spectralFlatness(m)).toBe(0)
  })

  it('spectralCrest：平坦谱 ≈1；单峰 = 峰/均值（大值）', () => {
    const bins = N / 2 + 1
    expect(Math.abs(spectralCrest(flatMags(bins)) - 1)).toBeLessThan(1e-6)
    const m = peakMags(bins, 50)
    // 物理：max/mean，单峰时 = 1/(1/bins) = bins
    expect(Math.abs(spectralCrest(m) - bins)).toBeLessThan(1e-6)
  })

  it('computeFeatures：汇总各特征；rms 沿用调用方传入值', () => {
    const bins = N / 2 + 1
    const freqs = binFreqs(bins, FS, N)
    const input: FeatureInput = { magnitudes: peakMags(bins, 200), binFreqs: freqs, rms: 0.123 }
    const f = computeFeatures(input)
    expect(Math.abs(f.rms - 0.123)).toBeLessThan(1e-9) // 使用传入的时域 RMS
    expect(f.zcr).toBe(0) // 契约：zcr 需时域信号，幅度谱输入无法计算（见 features.ts 头注）
    expect(Math.abs(f.centroidHz - freqs[200])).toBeLessThan(1e-3)
    expect(f.rolloffHz).toBeGreaterThan(0)
    expect(f.flatness).toBeLessThan(0.1)
    expect(f.crest).toBeGreaterThan(1)
  })

  it('空输入安全：返回 0 或安全默认值（不 NaN/不抛）', () => {
    const empty = new Float32Array(0)
    expect(computeRms(empty)).toBe(0)
    expect(computeZcr(empty)).toBe(0)
    expect(spectralCentroid(empty, empty)).toBe(0)
    expect(spectralRolloff(empty, empty)).toBe(0)
    expect(spectralFlatness(empty)).toBe(0)
    expect(spectralCrest(empty)).toBe(0)
    const f = computeFeatures({ magnitudes: empty, binFreqs: empty })
    expect(Number.isNaN(f.centroidHz)).toBe(false)
  })
})
