import { SampleRamp } from './SampleRamp'
import type { AudioBuffer } from './audioBuffer'
/**
 * WaveForge v3 —— 前瞻限幅器（Lookahead Limiter + True Peak）
 *
 * 概念来源：《音频算法技术文档.md》§3.3 —— 输入延迟 L → 检测窗峰值 →
 * 平滑增益 g = min(1, 10^(thresholdDb/20)/peak)，施加到延迟后的音频上（brickwall 零过冲）；
 * 真峰值检测采用 ITU-R BS.1770 的 4× 过采样思路（窗函数 sinc 插值取峰）。本文件为自研实现。
 *
 * 时序（流式逐样本）：在输入时刻 idx 已知 x[0..idx]，输出 y[idx] = x[idx−L]·g[idx]。
 * 检测窗覆盖延迟线内的信号；真峰值 sinc 插值需等待右侧样本，额外保留 7 样本的
 * 检测历史。增益提前按 attack 平滑；在输出点再按该样本/插值核峰值约束钳位，
 * 防止不足一个 attack 时间的孤立瞬态穿过限幅阈值。
 *
 * lookahead < 7 样本时没有足够未来样本保证插值真峰值，仅保证数字采样峰值。
 * 延迟线 / 检测队列 / 插值历史均预分配，process 内零分配。
 */

import type { LimiterSettings } from '../types'

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function onePoleCoef(timeMs: number, fs: number): number {
  const ms = Math.max(timeMs, 0.05)
  return 1 - Math.exp(-1 / ((ms / 1000) * fs))
}

export class Limiter {
  private readonly thresholdRamp: SampleRamp
  private readonly lookaheadRamp: SampleRamp
  private readonly attackRamp: SampleRamp
  private readonly releaseRamp: SampleRamp
  private readonly enabledRamp: SampleRamp
  private readonly truePeakRamp: SampleRamp
  private enableWarmup = 0
  private fs: number
  private enabled = true
  private thresholdLin = Math.pow(10, -1 / 20)
  private lookahead = 0
  private attackCoef = 0
  private releaseCoef = 0
  private truePeak = false

  // 延迟线（尺寸 lookahead+1，读取最旧样本 = 延迟 L）
  private delayL = new Float32Array(1)
  private delayR = new Float32Array(1)
  // 插值核覆盖到的输入样本共享峰值约束，输出时作为平滑包络的安全上界
  private tpDelay = new Float64Array(1)
  private delayW = 0

  // 单调递减队列（环形）—— 滑动窗口峰值检测
  private qIdx = new Float64Array(8)
  private qVal = new Float64Array(8)
  private qHead = 0
  private qTail = 0
  private qLen = 0
  private qCap = 8

  // 真峰值：每通道 8 样本历史（环形）+ 3 相位 × 8 taps 插值系数
  private histL = new Float32Array(8)
  private histR = new Float32Array(8)
  private histW = 0
  private interp = new Float32Array(24)

  private gain = 1
  private reductionDb = 0
  private sampleIndex = 0

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.thresholdRamp = new SampleRamp(fs, this.thresholdLin)
    this.lookaheadRamp = new SampleRamp(fs, 0)
    this.attackRamp = new SampleRamp(fs, 0)
    this.releaseRamp = new SampleRamp(fs, 0)
    this.enabledRamp = new SampleRamp(fs, 1)
    this.truePeakRamp = new SampleRamp(fs, 0)
    // 固定容量保留输入历史；改前瞻只移动读点，不清空音频管线。
    const size = Math.max(1, Math.floor(fs * 0.1) + 1)
    this.delayL = new Float32Array(size); this.delayR = new Float32Array(size)
    this.tpDelay = new Float64Array(size + 8)
    this.qCap = size + 8
    this.qIdx = new Float64Array(this.qCap); this.qVal = new Float64Array(this.qCap)
    this.applyParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
  }

  setParams(p: LimiterSettings): void {
    this.applyParams(p)
  }

  /** 阈值、时间系数、前瞻读点与开关逐样本 20ms 渐变；固定容量保留历史 */
  private applyParams(p: LimiterSettings): void {
    const wasEnabled = this.enabled
    this.enabled = p.enabled
    this.thresholdLin = Math.pow(10, clamp(p.thresholdDb, -60, 0) / 20)
    this.lookahead = Math.max(0, Math.min(Math.round((p.lookaheadMs * this.fs) / 1000), Math.floor(this.fs * 0.1)))
    this.attackCoef = onePoleCoef(p.attackMs, this.fs)
    this.releaseCoef = onePoleCoef(p.releaseMs, this.fs)
    this.truePeak = p.truePeak

    this.thresholdRamp.set(this.thresholdLin)
    this.lookaheadRamp.set(this.lookahead)
    this.attackRamp.set(this.attackCoef); this.releaseRamp.set(this.releaseCoef)
    this.enabledRamp.set(this.enabled ? 1 : 0)
    this.truePeakRamp.set(this.truePeak ? 1 : 0)
    if (this.enabled && !wasEnabled) {
      this.qHead = this.qTail = this.qLen = 0
      this.enableWarmup = this.lookahead
    }
    // 4× 过采样 sinc 插值系数（Blackman 窗，3 相位 × 8 taps，窗支撑 [-5, 5]）
    if (this.truePeak) {
      for (let ph = 0; ph < 3; ph++) {
        const frac = (ph + 1) / 4
        let sum = 0
        for (let k = -4; k <= 3; k++) {
          const x = frac - k
          const sx = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
          const u = (x + 5) / 10
          const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
          this.interp[ph * 8 + (k + 4)] = sx * w
          sum += sx * w
        }
        // 各相位直流增益为 1，避免持续信号被插值核的增益误差误压限
        for (let t = 0; t < 8; t++) this.interp[ph * 8 + t] /= sum
      }
    }
  }

  /** 就地处理立体声（l/r 原地改写）。输出相对输入延迟 lookahead 样本。 */
  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    const n = Math.min(l.length, r.length)
    const dsize = this.delayL.length
    const interp = this.interp
    const histL = this.histL
    const histR = this.histR
    for (let i = 0; i < n; i++) {
      const xl = l[i]
      const xr = r[i]
      const idx = this.sampleIndex
      const thr = this.thresholdRamp.next(), delay = this.lookaheadRamp.next()
      const attack = this.attackRamp.next(), release = this.releaseRamp.next()
      const tpMix = this.truePeakRamp.next(), tp = tpMix > 0
      let wet = this.enabledRamp.current()
      if (this.enableWarmup > 0) this.enableWarmup--
      else wet = this.enabledRamp.next()
      // 停用时仍保留延迟/插值历史，下一次启用不吐旧音频。
      if (!this.enabled && wet === 0) {
        this.delayL[this.delayW] = xl; this.delayR[this.delayW] = xr
        this.delayW = (this.delayW + 1) % dsize
        histL[this.histW] = xl; histR[this.histW] = xr; this.histW = (this.histW + 1) & 7
        this.sampleIndex++; this.reductionDb = 0
        continue
      }


      // 1) 4× 过采样历史写入（位置 idx−7..idx）
      histL[this.histW] = xl
      histR[this.histW] = xr
      this.histW = (this.histW + 1) & 7

      // 2) 数字峰值立即入队；插值位置 idx−3+frac，完整核覆盖 idx−7..idx。
      // 检测结果按到达时间入队，额外保留 7 样本，不能把当前数字峰值误标成 idx−3。
      let det = Math.max(Math.abs(xl), Math.abs(xr))
      const tpSize = this.tpDelay.length
      this.tpDelay[idx % tpSize] = 0
      if (tp) {
        const w = this.histW
        let interpolated = 0
        for (let ph = 0; ph < 3; ph++) {
          const off = ph * 8
          let sL = 0
          let sR = 0
          for (let t = 0; t < 8; t++) {
            const c = interp[off + t]
            const si = (w + t) & 7
            sL += c * histL[si]
            sR += c * histR[si]
          }
          interpolated = Math.max(interpolated, Math.abs(sL), Math.abs(sR))
        }
        det = Math.max(det, det + tpMix * (interpolated - det))
        // 让插值峰值约束核内所有样本。L>=7 时这些样本均尚未输出。
        for (let t = 0; t < 8 && t <= idx; t++) {
          const slot = (idx - t) % tpSize
          if (interpolated > this.tpDelay[slot]) this.tpDelay[slot] = interpolated
        }
      }
      this.popStale(idx - Math.ceil(Math.max(delay, this.lookahead)) - (tp ? 7 : 0))
      this.pushBack(idx, det)

      // 3) 延迟线写入
      this.delayL[this.delayW] = xl
      this.delayR[this.delayW] = xr
      this.delayW = (this.delayW + 1) % dsize

      // 4) 目标增益 = min(1, 阈值/峰值)，attack/release 一阶平滑
      const peak = this.qLen > 0 ? this.qVal[this.qHead] : 0
      const target = Math.min(1, thr / Math.max(peak, 1e-12))
      if (target < this.gain) this.gain += attack * (target - this.gain)
      else this.gain += release * (target - this.gain)

      // 5) 输出时的硬上界保证任意 attack/lookahead 组合都不会漏掉数字峰值。
      // 钳位写回包络状态，随后按 release 恢复，避免每次瞬态后立即弹回。
      const read = (this.delayW - 1 - delay + dsize) % dsize
      const read0 = Math.floor(read), fraction = read - read0, read1 = (read0 + 1) % dsize
      const outL = this.delayL[read0] + fraction * (this.delayL[read1] - this.delayL[read0])
      const outR = this.delayR[read0] + fraction * (this.delayR[read1] - this.delayR[read0])
      let outputPeak = Math.max(Math.abs(outL), Math.abs(outR))
      const outputIndex = idx - Math.floor(delay)
      if (tp && delay >= 7 && outputIndex >= 0) {
        const interpolated = Math.max(this.tpDelay[outputIndex % tpSize],
          outputIndex > 0 ? this.tpDelay[(outputIndex - 1) % tpSize] : 0)
        outputPeak = Math.max(outputPeak, outputPeak + tpMix * (interpolated - outputPeak))
      }
      this.gain = Math.min(this.gain, thr / Math.max(outputPeak, 1e-12))
      l[i] = xl + wet * (outL * this.gain - xl)
      r[i] = xr + wet * (outR * this.gain - xr)
      this.sampleIndex++
    }
    this.reductionDb = 20 * Math.log10(this.gain)
  }

  /** 弹出窗口外（索引 < oldest）的队首过期项 */
  private popStale(oldest: number): void {
    while (this.qLen > 0 && this.qIdx[this.qHead] < oldest) {
      this.qHead = (this.qHead + 1) % this.qCap
      this.qLen--
    }
  }

  /** 单调递减入队（相等值保留最新） */
  private pushBack(idx: number, val: number): void {
    while (this.qLen > 0) {
      const t = (this.qTail - 1 + this.qCap) % this.qCap
      if (this.qVal[t] > val) break
      this.qTail = t
      this.qLen--
    }
    this.qIdx[this.qTail] = idx
    this.qVal[this.qTail] = val
    this.qTail = (this.qTail + 1) % this.qCap
    this.qLen++
  }

  /** 当前增益衰减 dB（<= 0） */
  getReductionDb(): number {
    return this.reductionDb
  }

  /** 引入的延迟（样本数）= lookahead 样本 */
  getLatencySamples(): number {
    return this.lookahead
  }

  reset(): void {
    this.thresholdRamp.reset(); this.lookaheadRamp.reset(); this.attackRamp.reset(); this.releaseRamp.reset()
    this.enabledRamp.reset(); this.truePeakRamp.reset(); this.enableWarmup = 0
    this.delayL.fill(0)
    this.delayR.fill(0)
    this.tpDelay.fill(0)
    this.delayW = 0
    this.qHead = 0
    this.qTail = 0
    this.qLen = 0
    this.histL.fill(0)
    this.histR.fill(0)
    this.histW = 0
    this.gain = 1
    this.reductionDb = 0
    this.sampleIndex = 0
  }
}

