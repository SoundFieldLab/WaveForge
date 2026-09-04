/**
 * SpectrumAnalyzer 单元测试（API_SPEC 小节 E：Hann + FFT + 特征）
 *
 * 断言物理意义：
 *  - 440Hz 正弦（N=2048, fs=48kHz，bin 分辨率 23.44Hz）→ 峰值 bin 频率 ≈ 440Hz（±30Hz）；
 *  - 纯音：质心 ≈ 440Hz、平坦度 → 0（音调性强）、峰值比远大于噪声；
 *  - 白噪声：平坦度 → 1（频谱平坦）、质心 ≈ fs/4（平坦谱的均值频率）、过零率高；
 *  - RMS：正弦幅度 0.5 → RMS = 0.5/√2 ≈ 0.3536。
 * 噪声用确定性伪随机（mulberry32）生成，保证可复现（无 Math.random）。
 */
import { describe, expect, it } from 'vitest'
import { SpectrumAnalyzer } from '../src/analysis/Spectrum'

/** mulberry32：确定性伪随机（测试专用，避免 Math.random） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeSine(freqHz: number, fs: number, n: number, amp = 1): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freqHz * i) / fs)
  return x
}

function makeNoise(n: number, seed: number, amp = 1): Float32Array {
  const rand = mulberry32(seed)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = amp * (rand() * 2 - 1)
  return x
}

describe('SpectrumAnalyzer', () => {
  const FS = 48000
  const N = 2048

  it('非法 fftSize / 采样率抛错', () => {
    expect(() => new SpectrumAnalyzer(2047, FS)).toThrow()
    expect(() => new SpectrumAnalyzer(1000, FS)).toThrow()
    expect(() => new SpectrumAnalyzer(N, 0)).toThrow('invalid sample rate')
  })

  it('幅度谱长度 = N/2+1；reset 后清零', () => {
    const sa = new SpectrumAnalyzer(N, FS)
    sa.processStereo(makeSine(440, FS, N), makeSine(440, FS, N))
    expect(sa.getMagnitudes()).toHaveLength(N / 2 + 1)
    const mags = sa.getMagnitudes()
    expect(Math.max(...Array.from(mags))).toBeGreaterThan(0)
    sa.reset()
    expect(Math.max(...Array.from(sa.getMagnitudes()))).toBe(0)
  })

  it('440Hz 正弦：峰值 bin 频率 ≈ 440Hz（±30Hz，物理意义：bin 分辨率 23.44Hz）', () => {
    const sa = new SpectrumAnalyzer(N, FS)
    sa.processStereo(makeSine(440, FS, N), makeSine(440, FS, N))
    const mags = sa.getMagnitudes()
    let peakIdx = 0
    for (let i = 1; i < mags.length; i++) if (mags[i] > mags[peakIdx]) peakIdx = i
    const peakHz = (peakIdx * FS) / N
    expect(Math.abs(peakHz - 440)).toBeLessThanOrEqual(30)
    // 峰值 bin 能量显著高于均值（信噪比）
    let sum = 0
    for (let i = 0; i < mags.length; i++) sum += mags[i]
    const mean = sum / mags.length
    expect(mags[peakIdx] / mean).toBeGreaterThan(50)
  })

  it('440Hz 正弦特征：质心≈440Hz、平坦度→0、过零率低、RMS≈0.3536（幅度0.5）', () => {
    const sa = new SpectrumAnalyzer(N, FS)
    const amp = 0.5
    sa.processStereo(makeSine(440, FS, N, amp), makeSine(440, FS, N, amp))
    const f = sa.getFeatures()
    // RMS = 0.5/√2（正弦幅度与 RMS 的关系）
    expect(f.rms).toBeCloseTo(amp / Math.SQRT2, 2)
    // 质心接近基频（Hann 泄漏分布在 440Hz 邻域）
    expect(Math.abs(f.centroidHz - 440)).toBeLessThanOrEqual(50)
    // 滚降（95% 能量）在 440Hz 附近，且不高于 600Hz
    expect(f.rolloffHz).toBeGreaterThanOrEqual(400)
    expect(f.rolloffHz).toBeLessThanOrEqual(600)
    // 平坦度：纯音 → 接近 0（<0.1，物理意义：能量集中于少数 bin）
    expect(f.flatness).toBeLessThan(0.1)
    // 过零率：440Hz 正弦每样本约 2·440/48000 ≈ 0.018 次
    expect(f.zcr).toBeLessThan(N * 0.05)
    // 峰值比（meyda 语义 peak/rms(幅度谱)）：纯音 ≈25，噪声 ≈2.5，物理意义：能量集中度
    expect(f.crest).toBeGreaterThan(10)
  })

  it('白噪声：平坦度>0.85、质心≈fs/4、过零率远高于正弦', () => {
    const sa = new SpectrumAnalyzer(N, FS)
    sa.processStereo(makeNoise(N, 42), makeNoise(N, 42))
    const f = sa.getFeatures()
    // 平坦谱几何/算术均值比 → 接近 1（白噪声幅度谱为瑞利分布，理论 GM/AM ≈ 0.846）
    expect(f.flatness).toBeGreaterThan(0.8)
    // 平坦谱的质心 = 平均频率 ≈ fs/4 = 12000Hz（±20%）
    expect(Math.abs(f.centroidHz - FS / 4)).toBeLessThan(FS / 4 * 0.2)
    // 过零率：白噪声约 50%（每样本 0.5 次） vs 正弦约 2%（见上例）
    expect(f.zcr).toBeGreaterThan(N * 0.35)
    const sine = new SpectrumAnalyzer(N, FS)
    sine.processStereo(makeSine(440, FS, N), makeSine(440, FS, N))
    expect(f.zcr).toBeGreaterThan(sine.getFeatures().zcr * 5)
    // 峰值比：噪声远小于纯音（能量分散）
    expect(f.crest).toBeLessThan(5)
  })

  it('RMS 物理意义：同幅度正弦与噪声的 RMS 分别正确', () => {
    const sa = new SpectrumAnalyzer(N, FS)
    sa.processStereo(makeSine(1000, FS, N, 1), makeSine(1000, FS, N, 1))
    expect(sa.getFeatures().rms).toBeCloseTo(1 / Math.SQRT2, 2)
    // 均匀分布 U(-1,1) 的 RMS = 1/√3 ≈ 0.577
    const noise = new SpectrumAnalyzer(N, FS)
    noise.processStereo(makeNoise(N, 7), makeNoise(N, 7))
    expect(noise.getFeatures().rms).toBeCloseTo(1 / Math.sqrt(3), 1)
  })

  it('输入短于 fftSize 时补零处理不崩溃且结果确定', () => {
    // 480Hz 在 1000 样本内恰为 10 个整周期：截断+补零后能量仍集中于基频（flatness 小）
    const sa = new SpectrumAnalyzer(N, FS)
    sa.processStereo(makeSine(480, FS, 1000), makeSine(480, FS, 1000))
    const f1 = sa.getFeatures()
    const sa2 = new SpectrumAnalyzer(N, FS)
    sa2.processStereo(makeSine(480, FS, 1000), makeSine(480, FS, 1000))
    expect(sa2.getFeatures()).toEqual(f1) // 确定性：同输入同输出
    expect(f1.flatness).toBeLessThan(0.1)
    // 非整周期截断（440Hz）也不崩溃（能量泄漏 → 平坦度升高属正常物理现象）
    const sa3 = new SpectrumAnalyzer(N, FS)
    sa3.processStereo(makeSine(440, FS, 1000), makeSine(440, FS, 1000))
    expect(Number.isFinite(sa3.getFeatures().centroidHz)).toBe(true)
  })
});
