/**
 * WaveForge v3 —— 前瞻限幅器（Lookahead Limiter + True Peak）
 *
 * 概念来源：《音频算法技术文档.md》§3.3 —— 输入延迟 L → 检测窗峰值 →
 * 平滑增益 g = min(1, 10^(thresholdDb/20)/peak)，施加到延迟后的音频上（brickwall 零过冲）；
 * 真峰值检测采用 ITU-R BS.1770 的 4× 过采样思路（窗函数 sinc 插值取峰）。本文件为自研实现。
 *
 * 时序（流式逐样本）：在输入时刻 idx 已知 x[0..idx]，输出 y[idx] = x[idx−L]·g[idx]，
 *   g[idx] 由检测窗 [idx−L, idx]（真峰值模式为 [idx−L−3, idx−3]，检测值延迟 3 样本
 *   以便居中 sinc 插值）的峰值决定 —— 瞬时峰值在到达输出前约 L 个样本即被检测并
 *   预先压低增益，因此输出不会过冲，也不产生增益跳变咔哒声。
 *
 * 增益平滑：target < gain 时用 attack（快，默认 0.5ms），否则用 release（慢，默认 150ms）。
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
  private delayW = 0

  // 单调递减队列（环形）—— 滑动窗口峰值检测
  private qIdx = new Int32Array(8)
  private qVal = new Float32Array(8)
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
    this.applyParams({ enabled: true, thresholdDb: -1, lookaheadMs: 5, attackMs: 0.5, releaseMs: 150, truePeak: true })
  }

  setParams(p: LimiterSettings): void {
    this.applyParams(p)
  }

  /** 参数即时生效：钳制 + 系数重算；缓冲尺寸变化或从禁用切回启用时清空管线 */
  private applyParams(p: LimiterSettings): void {
    const wasEnabled = this.enabled
    this.enabled = p.enabled
    this.thresholdLin = Math.pow(10, clamp(p.thresholdDb, -60, 0) / 20)
    this.lookahead = Math.max(0, Math.min(Math.round((p.lookaheadMs * this.fs) / 1000), Math.floor(this.fs * 0.1)))
    this.attackCoef = onePoleCoef(p.attackMs, this.fs)
    this.releaseCoef = onePoleCoef(p.releaseMs, this.fs)
    this.truePeak = p.truePeak

    const size = Math.max(this.lookahead + 1, 1)
    const cap = Math.max(this.lookahead + 8, 8)
    if (size !== this.delayL.length || cap !== this.qCap) {
      this.delayL = new Float32Array(size)
      this.delayR = new Float32Array(size)
      this.qIdx = new Int32Array(cap)
      this.qVal = new Float32Array(cap)
      this.qCap = cap
      this.qHead = 0
      this.qTail = 0
      this.qLen = 0
      this.histL.fill(0)
      this.histR.fill(0)
      this.histW = 0
      this.gain = 1
      this.sampleIndex = 0
      this.reductionDb = 0
    }
    if (this.enabled && !wasEnabled) {
      // 禁用期间延迟线未更新，恢复时清空避免陈旧样本
      this.delayL.fill(0)
      this.delayR.fill(0)
      this.qHead = 0
      this.qTail = 0
      this.qLen = 0
      this.histL.fill(0)
      this.histR.fill(0)
      this.histW = 0
      this.gain = 1
      this.sampleIndex = 0
      this.reductionDb = 0
    }
    // 4× 过采样 sinc 插值系数（Blackman 窗，3 相位 × 8 taps，窗支撑 [-5, 5]）
    if (this.truePeak) {
      for (let ph = 0; ph < 3; ph++) {
        const frac = (ph + 1) / 4
        for (let k = -4; k <= 3; k++) {
          const x = frac - k
          const sx = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
          const u = (x + 5) / 10
          const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * u) + 0.08 * Math.cos(4 * Math.PI * u)
          this.interp[ph * 8 + (k + 4)] = sx * w
        }
      }
    }
  }

  /** 就地处理立体声（l/r 原地改写）。输出相对输入延迟 lookahead 样本。 */
  processStereo(l: Float32Array, r: Float32Array): void {
    if (!this.enabled) {
      this.reductionDb = 0
      return
    }
    const n = l.length
    const thr = this.thresholdLin
    const dsize = this.delayL.length
    const tp = this.truePeak
    const attack = this.attackCoef
    const release = this.releaseCoef
    const interp = this.interp
    const histL = this.histL
    const histR = this.histR
    for (let i = 0; i < n; i++) {
      const xl = l[i]
      const xr = r[i]
      const idx = this.sampleIndex

      // 1) 4× 过采样历史写入（位置 idx−7..idx）
      histL[this.histW] = xl
      histR[this.histW] = xr
      this.histW = (this.histW + 1) & 7

      // 2) 检测值：数字峰值 或 真峰值（4× sinc 插值，位置 p = idx−3）
      let det: number
      if (tp) {
        det = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr)
        if (idx >= 7) {
          const w = this.histW // 最旧样本位置（x[idx−7]）
          let vL = 0
          let vR = 0
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
            const aL = Math.abs(sL)
            const aR = Math.abs(sR)
            if (aL > vL) vL = aL
            if (aR > vR) vR = aR
          }
          if (vL > det) det = vL
          if (vR > det) det = vR
        }
        this.popStale(idx - 3 - this.lookahead)
        this.pushBack(idx - 3, det)
      } else {
        det = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr)
        this.popStale(idx - this.lookahead)
        this.pushBack(idx, det)
      }

      // 3) 延迟线写入
      this.delayL[this.delayW] = xl
      this.delayR[this.delayW] = xr
      this.delayW = (this.delayW + 1) % dsize

      // 4) 目标增益 = min(1, 阈值/峰值)，attack/release 一阶平滑
      const peak = this.qLen > 0 ? this.qVal[this.qHead] : 0
      const target = Math.min(1, thr / Math.max(peak, 1e-12))
      if (target < this.gain) this.gain += attack * (target - this.gain)
      else this.gain += release * (target - this.gain)

      // 5) 输出 = 延迟 L 样本 × 平滑增益
      l[i] = this.delayL[this.delayW] * this.gain
      r[i] = this.delayR[this.delayW] * this.gain
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
    this.delayL.fill(0)
    this.delayR.fill(0)
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
