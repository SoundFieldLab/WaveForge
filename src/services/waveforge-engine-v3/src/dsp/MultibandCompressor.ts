import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from './audioBuffer'
import { Biquad } from './biquad'
import { Compressor } from './Compressor'
import type { MultibandCompressorSettings } from '../types'

/**
 * 三段动态压缩器：低/中/高三个互补频带各自检测和压缩，再按原相位路径相加。
 * 分频器使用低通 + 高通近似，处理中不创建逐样本对象；scratch 仅在块长增大或
 * 精度切换时扩容。
 *
 * 可选内部精度（setPrecision）：float64 时六个频带 scratch 分配为 Float64Array，
 * 分频/压缩/重组不再逐样本截断 float32；输入输出缓冲类型由调用方决定
 * （processStereo 接受 Float32Array 或 Float64Array）。默认 float32 完全不变。
 */
export class MultibandCompressor {
  private readonly fs: number
  private readonly lowPassL: Biquad
  private readonly lowPassR: Biquad
  private readonly highPassL: Biquad
  private readonly highPassR: Biquad
  private readonly low: Compressor
  private readonly mid: Compressor
  private readonly high: Compressor
  private precision: Precision = 'float32'
  private capacity = 0
  private lowL: AudioBuffer = new Float32Array(0)
  private lowR: AudioBuffer = new Float32Array(0)
  private midL: AudioBuffer = new Float32Array(0)
  private midR: AudioBuffer = new Float32Array(0)
  private highL: AudioBuffer = new Float32Array(0)
  private highR: AudioBuffer = new Float32Array(0)
  private enabled = false
  private finalGain = 1

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.lowPassL = new Biquad('lowpass', 180, 0.707, 0, fs)
    this.lowPassR = new Biquad('lowpass', 180, 0.707, 0, fs)
    this.highPassL = new Biquad('highpass', 4000, 0.707, 0, fs)
    this.highPassR = new Biquad('highpass', 4000, 0.707, 0, fs)
    this.low = new Compressor(fs)
    this.mid = new Compressor(fs)
    this.high = new Compressor(fs)
    this.ensureCapacity(128)
  }

  /** 当前内部精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换内部精度（幂等）：按新精度重新分配六个频带 scratch（保留已分配容量），
   * 并 reset 分频/压缩状态。处理输入输出缓冲类型由调用方给出，不受此设置限制。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.lowL = allocBuffer(this.capacity, next)
    this.lowR = allocBuffer(this.capacity, next)
    this.midL = allocBuffer(this.capacity, next)
    this.midR = allocBuffer(this.capacity, next)
    this.highL = allocBuffer(this.capacity, next)
    this.highR = allocBuffer(this.capacity, next)
    this.reset()
  }

  setParams(p: MultibandCompressorSettings, enabled: boolean, makeupDb = 0, outputGain = 1, transientPreserve = 0): void {
    const lowMid = this.clampFrequency(p.lowMidHz, 180)
    const midHigh = Math.max(lowMid + 20, this.clampFrequency(p.midHighHz, 4000))
    this.lowPassL.setParams('lowpass', lowMid, 0.707, 0)
    this.lowPassR.setParams('lowpass', lowMid, 0.707, 0)
    this.highPassL.setParams('highpass', midHigh, 0.707, 0)
    this.highPassR.setParams('highpass', midHigh, 0.707, 0)
    this.low.setParams({ enabled, mode: 'downward', transientPreserve, ...p.low, outputGain: 1 })
    this.mid.setParams({ enabled, mode: 'downward', transientPreserve, ...p.mid, outputGain: 1 })
    this.high.setParams({ enabled, mode: 'downward', transientPreserve, ...p.high, outputGain: 1 })
    const safeMakeup = Number.isFinite(makeupDb) ? Math.min(24, Math.max(-24, makeupDb)) : 0
    const safeOutput = Number.isFinite(outputGain) ? Math.min(2, Math.max(0, outputGain)) : 1
    this.finalGain = Math.pow(10, safeMakeup / 20) * safeOutput
    if (enabled !== this.enabled) this.reset()
    this.enabled = enabled
  }

  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    if (!this.enabled) return
    const n = Math.min(l.length, r.length)
    this.ensureCapacity(n)
    for (let i = 0; i < n; i++) {
      const inputL = l[i]
      const inputR = r[i]
      const lowL = this.lowPassL.process(inputL)
      const lowR = this.lowPassR.process(inputR)
      const highL = this.highPassL.process(inputL)
      const highR = this.highPassR.process(inputR)
      this.lowL[i] = lowL
      this.lowR[i] = lowR
      this.highL[i] = highL
      this.highR[i] = highR
      this.midL[i] = inputL - lowL - highL
      this.midR[i] = inputR - lowR - highR
    }
    this.low.processStereo(this.lowL, this.lowR, n)
    this.mid.processStereo(this.midL, this.midR, n)
    this.high.processStereo(this.highL, this.highR, n)
    for (let i = 0; i < n; i++) {
      l[i] = (this.lowL[i] + this.midL[i] + this.highL[i]) * this.finalGain
      r[i] = (this.lowR[i] + this.midR[i] + this.highR[i]) * this.finalGain
    }
  }

  reset(): void {
    this.lowPassL.reset(); this.lowPassR.reset(); this.highPassL.reset(); this.highPassR.reset()
    this.low.reset(); this.mid.reset(); this.high.reset()
    this.lowL.fill(0); this.lowR.fill(0); this.midL.fill(0); this.midR.fill(0); this.highL.fill(0); this.highR.fill(0)
  }

  private clampFrequency(value: number, fallback: number): number {
    const max = this.fs * 0.45
    return Math.min(max, Math.max(20, Number.isFinite(value) ? value : fallback))
  }

  private ensureCapacity(n: number): void {
    if (this.capacity >= n) return
    this.capacity = n
    this.lowL = allocBuffer(n, this.precision); this.lowR = allocBuffer(n, this.precision)
    this.midL = allocBuffer(n, this.precision); this.midR = allocBuffer(n, this.precision)
    this.highL = allocBuffer(n, this.precision); this.highR = allocBuffer(n, this.precision)
  }
}
