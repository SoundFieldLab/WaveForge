import type { AudioBuffer } from './audioBuffer'
/**
 * WaveForge v3 —— 动态压缩器（v2 兼容语义 + 软拐点 knee）
 *
 * 概念来源：《音频算法技术文档.md》§3（包络检测 + dB 域压缩曲线 + makeup 补偿），
 * 软拐点采用行业标准公式（DAW 压缩器通用形式）；本文件为自研实现。
 *
 * 信号流：
 *   1. 立体声联合包络：e[n] = max(|L|,|R|)；
 *   2. 平滑：attack（默认 10ms）/ release（默认 150ms）一阶峰值跟随；
 *   3. dB 域软拐点曲线：levelDb = 20·log10(env)，
 *      - level < thr − knee/2        → 无压缩
 *      - thr − knee/2 ≤ level ≤ thr + knee/2 → reduction = (1−1/R)·x²/(2·knee)，x = level − thr + knee/2
 *      - level > thr + knee/2        → reduction = (level − thr)·(1 − 1/R)
 *      （knee=0 退化为硬拐点）
 *   4. 增益：g = 10^(−reduction/20)·10^(makeupDb/20)·outputGain。
 */

import type { CompressorSettings } from '../types'

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

function onePoleCoef(timeMs: number, fs: number, floorMs: number): number {
  const ms = Number.isFinite(timeMs) ? Math.max(timeMs, floorMs) : floorMs
  return 1 - Math.exp(-1 / ((ms / 1000) * fs))
}

export class Compressor {
  private fs: number
  private enabled = true
  private mode: 'downward' | 'upward' = 'downward'
  private thresholdDb = -20
  private ratio = 4
  private kneeDb = 6
  private attackCoef = 0
  private releaseCoef = 0
  private makeupLin = 1
  private outputGain = 1
  private kneeStartLin = 0
  private kneeEndLin = 0
  private upwardMaxGainDb = 24
  private env = 0
  private reductionDb = 0

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.applyParams({ enabled: true, thresholdDb: -20, ratio: 4, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 0, outputGain: 1 })
  }

  setParams(p: CompressorSettings): void {
    this.applyParams(p)
  }

  /** 参数即时生效：钳制 + 系数重算；包络状态保留（避免参数变化时爆音） */
  private applyParams(p: CompressorSettings): void {
    const activating = !this.enabled && p.enabled
    this.enabled = p.enabled
    this.mode = p.mode === 'upward' ? 'upward' : 'downward'
    this.thresholdDb = clamp(Number.isFinite(p.thresholdDb) ? p.thresholdDb : -20, -80, 0)
    this.ratio = clamp(Number.isFinite(p.ratio) ? p.ratio : 4, 1, 100)
    this.kneeDb = clamp(Number.isFinite(p.kneeDb) ? p.kneeDb : 6, 0, 40)
    this.kneeStartLin = Math.pow(10, (this.thresholdDb - this.kneeDb * 0.5) / 20)
    this.kneeEndLin = Math.pow(10, (this.thresholdDb + this.kneeDb * 0.5) / 20)
    this.upwardMaxGainDb = clamp(Number.isFinite(p.upwardMaxGainDb) ? p.upwardMaxGainDb! : 24, 0, 36)
    const transientPreserve = clamp(Number.isFinite(p.transientPreserve) ? p.transientPreserve! : 0, 0, 1)
    const baseAttackMs = Number.isFinite(p.attackMs) ? p.attackMs : 10
    this.attackCoef = onePoleCoef(baseAttackMs * (1 + 4 * transientPreserve), this.fs, 0.05)
    this.releaseCoef = onePoleCoef(Number.isFinite(p.releaseMs) ? p.releaseMs : 150, this.fs, 0.05)
    this.makeupLin = Math.pow(10, clamp(Number.isFinite(p.makeupDb) ? p.makeupDb : 0, -24, 24) / 20)
    this.outputGain = clamp(Number.isFinite(p.outputGain) ? p.outputGain : 1, 0, 2)
    if (activating) this.reset()
  }

  /** 就地处理立体声（l/r 原地改写） */
  processStereo(l: AudioBuffer, r: AudioBuffer, sampleCount = Math.min(l.length, r.length)): void {
    if (!this.enabled) {
      this.reductionDb = 0
      return
    }
    const n = Math.max(0, Math.min(sampleCount, l.length, r.length))
    const attack = this.attackCoef
    const release = this.releaseCoef
    const thr = this.thresholdDb
    const ratio = this.ratio
    const knee = this.kneeDb
    const invRatio = 1 - 1 / ratio
    const kneeHalf = knee * 0.5
    const twoKnee = 2 * knee
    const gainScale = this.makeupLin * this.outputGain
    const kneeStartLin = this.kneeStartLin
    for (let i = 0; i < n; i++) {
      // 1) 立体声联合包络（峰值检测）
      const xl = l[i]
      const xr = r[i]
      const e = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr)
      if (e > this.env) this.env += attack * (e - this.env)
      else this.env += release * (e - this.env)
      if (this.mode === 'upward' && this.env === 0) {
        this.reductionDb = 0
        l[i] = xl * gainScale
        r[i] = xr * gainScale
        continue
      }
      // 向下模式在阈值以上衰减；向上模式在阈值以下提升低电平。
      // 两种模式共用包络、软拐点和时间常数，参数切换不会改变状态连续性。
      const upward = this.mode === 'upward'
      if ((!upward && this.env <= kneeStartLin) || (upward && this.env >= this.kneeEndLin) || invRatio === 0) {
        this.reductionDb = 0
        l[i] = xl * gainScale
        r[i] = xr * gainScale
        continue
      }
      const levelDb = 20 * Math.log10(this.env)
      let changeDb: number
      if (upward) {
        const distance = thr - levelDb
        if (knee <= 0 || levelDb < thr - kneeHalf) changeDb = distance * invRatio
        else {
          const x = thr + kneeHalf - levelDb
          changeDb = (invRatio * x * x) / twoKnee
        }
        changeDb = Math.min(changeDb, this.upwardMaxGainDb)
        // getReductionDb 的约定是 <=0；向上增益以正值内部计算后取负。
        this.reductionDb = changeDb > 0 ? -changeDb : 0
      } else {
        if (knee <= 0 || levelDb > thr + kneeHalf) changeDb = (levelDb - thr) * invRatio
        else {
          const x = levelDb - (thr - kneeHalf)
          changeDb = (invRatio * x * x) / twoKnee
        }
        this.reductionDb = -changeDb
      }
      // 3) makeup + outputGain 补偿
      const g = Math.pow(10, (upward ? changeDb : -changeDb) / 20) * gainScale
      l[i] = xl * g
      r[i] = xr * g
    }
  }

  /** 当前增益衰减 dB（<= 0，不含 makeup/outputGain） */
  getReductionDb(): number {
    return this.reductionDb
  }

  reset(): void {
    this.env = 0
    this.reductionDb = 0
  }
}

