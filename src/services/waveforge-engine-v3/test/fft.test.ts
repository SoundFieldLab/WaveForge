/**
 * fft.test.ts —— fft.ts 单元测试
 * 数值容差说明：浮点 FFT 误差来自逐级 float32 存储舍入，容差取 1e-6 量级
 * （物理意义：往返还原应达到 6 位有效数字以上）。
 */
import { describe, it, expect } from 'vitest'
import { fft, nextPow2, hannWindow, magnitudeSpectrum, frequencyBins } from '../src/dsp/fft'

describe('fft', () => {
  it('单位脉冲的幅度谱全为 1（N 点 DFT 的 |X[k]|=1，脉冲含全部频率分量且幅度相等）', () => {
    const n = 64
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    re[0] = 1
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    expect(mag.length).toBe(n / 2 + 1)
    for (let k = 0; k < mag.length; k++) {
      expect(Math.abs(mag[k] - 1)).toBeLessThan(1e-6)
    }
  })

  it('440Hz 正弦 @N=1024 fs=48000：峰值 bin 在 440Hz 附近（Δf=46.875Hz，期望 bin≈9.39）', () => {
    const n = 1024
    const fs = 48000
    const f = 440
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * f * i) / fs)
    fft(re, im, false)
    const mag = magnitudeSpectrum(re, im)
    let peak = 0
    let peakBin = 0
    for (let k = 0; k < mag.length; k++) {
      if (mag[k] > peak) {
        peak = mag[k]
        peakBin = k
      }
    }
    const expectedBin = Math.round((f * n) / fs) // 9
    expect(Math.abs(peakBin - expectedBin)).toBeLessThanOrEqual(1)
    // 单音 N 点 FFT 峰值幅度 ≈ N/2=512，远大于旁瓣
    expect(peak).toBeGreaterThan(300)
  })

  it('FFT→IFFT 往返误差 < 1e-6（复信号经正逆变换后应还原原样本）', () => {
    const n = 256
    const re = new Float32Array(n)
    const im = new Float32Array(n)
    let seed = 12345
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < n; i++) {
      re[i] = rnd() * 2 - 1
      im[i] = rnd() * 2 - 1
    }
    const re0 = Float32Array.from(re)
    const im0 = Float32Array.from(im)
    fft(re, im, false)
    fft(re, im, true)
    let maxErr = 0
    for (let i = 0; i < n; i++) {
      maxErr = Math.max(maxErr, Math.abs(re[i] - re0[i]), Math.abs(im[i] - im0[i]))
    }
    expect(maxErr).toBeLessThan(1e-6)
  })

  it('非 2 的幂长度抛错', () => {
    const re = new Float32Array(3)
    const im = new Float32Array(3)
    expect(() => fft(re, im, false)).toThrow()
    const re2 = new Float32Array(8)
    const im2 = new Float32Array(4)
    expect(() => fft(re2, im2, false)).toThrow()
  })

  it('nextPow2：大于等于 n 的最小 2 的幂', () => {
    expect(nextPow2(0)).toBe(1)
    expect(nextPow2(1)).toBe(1)
    expect(nextPow2(2)).toBe(2)
    expect(nextPow2(3)).toBe(4)
    expect(nextPow2(1000)).toBe(1024)
    expect(nextPow2(1024)).toBe(1024)
  })

  it('hannWindow：端点 0、对称、非负；奇数 N 中心恰为 1', () => {
    const n = 8
    const w = hannWindow(n)
    expect(w[0]).toBe(0)
    // 偶数 N 对称式 Hann 的最大值在中间两个采样，= 0.5·(1+cos(π/(N-1)))≈0.9505
    const mid = 0.5 * (1 + Math.cos(Math.PI / (n - 1)))
    expect(Math.abs(w[n / 2 - 1] - mid)).toBeLessThan(1e-6)
    expect(Math.abs(w[n / 2] - mid)).toBeLessThan(1e-6)
    for (let i = 0; i < n; i++) {
      expect(w[i]).toBeGreaterThanOrEqual(0)
      expect(Math.abs(w[i] - w[n - 1 - i])).toBeLessThan(1e-6)
    }
    // 奇数 N 时正中心采样值恰为 1
    const w9 = hannWindow(9)
    expect(Math.abs(w9[4] - 1)).toBeLessThan(1e-6)
  })

  it('frequencyBins：N 点 FFT、采样率 fs，返回 N/2+1 个 bin 中心频率', () => {
    const bins = frequencyBins(8, 8000)
    expect(Array.from(bins)).toEqual([0, 1000, 2000, 3000, 4000])
  })
})
