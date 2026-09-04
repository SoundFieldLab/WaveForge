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
  return v < lo ? lo : v > hi ? hi : v
}

function onePoleCoef(timeMs: number, fs: number, floorMs: number): number {
  const ms = Math.max(timeMs, floorMs)
  return 1 - Math.exp(-1 / ((ms / 1000) * fs))
}

export class Compressor {
  private fs: number
  private enabled = true
  private thresholdDb = -20
  private ratio = 4
  private kneeDb = 6
  private attackCoef = 0
  private releaseCoef = 0
  private makeupLin = 1
  private outputGain = 1
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
    this.enabled = p.enabled
    this.thresholdDb = clamp(p.thresholdDb, -80, 0)
    this.ratio = clamp(p.ratio, 1, 100)
    this.kneeDb = clamp(p.kneeDb, 0, 40)
    this.attackCoef = onePoleCoef(p.attackMs, this.fs, 0.05)
    this.releaseCoef = onePoleCoef(p.releaseMs, this.fs, 0.05)
    this.makeupLin = Math.pow(10, clamp(p.makeupDb, -24, 24) / 20)
    this.outputGain = clamp(p.outputGain, 0, 2)
  }

  /** 就地处理立体声（l/r 原地改写） */
  processStereo(l: Float32Array, r: Float32Array): void {
    if (!this.enabled) {
      this.reductionDb = 0
      return
    }
    const n = l.length
    const attack = this.attackCoef
    const release = this.releaseCoef
    const thr = this.thresholdDb
    const ratio = this.ratio
    const knee = this.kneeDb
    const invRatio = 1 - 1 / ratio
    const kneeHalf = knee * 0.5
    const twoKnee = 2 * knee
    const gainScale = this.makeupLin * this.outputGain
    for (let i = 0; i < n; i++) {
      // 1) 立体声联合包络（峰值检测）
      const xl = l[i]
      const xr = r[i]
      const e = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr)
      if (e > this.env) this.env += attack * (e - this.env)
      else this.env += release * (e - this.env)
      // 2) dB 域软拐点
      const levelDb = 20 * Math.log10(this.env + 1e-12)
      let reduction: number
      if (knee <= 0) {
        reduction = levelDb > thr ? (levelDb - thr) * invRatio : 0
      } else if (levelDb < thr - kneeHalf) {
        reduction = 0
      } else if (levelDb > thr + kneeHalf) {
        reduction = (levelDb - thr) * invRatio
      } else {
        const x = levelDb - (thr - kneeHalf)
        reduction = (invRatio * x * x) / twoKnee
      }
      this.reductionDb = -reduction
      // 3) makeup + outputGain 补偿
      const g = Math.pow(10, -reduction / 20) * gainScale
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
