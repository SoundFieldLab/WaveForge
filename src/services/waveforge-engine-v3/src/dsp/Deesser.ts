import type { AudioBuffer } from './audioBuffer'
/**
 * WaveForge v3 —— 动态齿音抑制（De-esser）
 *
 * 概念来源：Stanford EE264 数字音频处理课程公开的 de-esser 设计思路
 *   （侧链带通提取齿音频段 → 包络检测 → dB 域阈值压缩 → 分带/宽带增益施加），
 *   以及《音频算法技术文档.md》§4；本文件为全新自研实现。
 *
 * 信号流：
 *   1. 侧链提取：左右分别经 RBJ 带通(centerHz, q)，避免反相齿音在单声道求和时抵消；
 *   2. 包络检测：左右带通能量平均后按 attack(默认 1ms)/release(默认 80ms) 平滑得到 env；
 *   3. dB 域阈值压缩：levelDb = 10·log10(env)，超过 thresholdDb 的部分按 ratio 衰减：
 *        reduction = (levelDb − thresholdDb)·(1 − 1/ratio)，g = 10^(−reduction/20)；
 *   4. 增益施加：
 *      - 分带式（splitBand=true，推荐）：互补一阶低通/高通，
 *        高频残差 x−LP(x) 按 g 衰减：out = x + (g−1)·(x−LP(x))。
 *        一阶 LP 相位至多旋转 90°，部分干湿混合不会在交叉点深陷；
 *        g=1 逐样本恒等，g=0 为低通结果。
 *      - 宽带式（splitBand=false）：整体乘以 g —— out = x·g；
 *   5. mix 干湿混合：out = x + mix·(processed − x)。
 */

import type { DeesserSettings } from '../types'

/** 数值钳制 */
function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

/** 一阶平滑系数：α = 1 − exp(−1/(τ·fs))，τ 由毫秒换算 */
function onePoleCoef(timeMs: number, fs: number, floorMs: number): number {
  const ms = Number.isFinite(timeMs) ? Math.max(timeMs, floorMs) : floorMs
  return 1 - Math.exp(-1 / ((ms / 1000) * fs))
}

/**
 * 内部 RBJ 双二阶滤波器（TDF2 结构）。
 * 本模块自包含实现（不依赖并行子代理的 dsp/biquad.ts），仅实现本模块需要的类型。
 */
class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private s1 = 0
  private s2 = 0

  /** 设计系数；type 支持 lowpass / highpass / bandpass（0dB 峰值增益） */
  design(type: 'lowpass' | 'highpass' | 'bandpass', f0: number, q: number, fs: number): void {
    const f = clamp(f0, Math.min(10, fs * 0.45), fs * 0.45)
    const qq = clamp(q, 0.05, 20)
    const w0 = (2 * Math.PI * f) / fs
    const cw = Math.cos(w0)
    const sw = Math.sin(w0)
    const alpha = sw / (2 * qq)
    let b0 = 0
    let b1 = 0
    let b2 = 0
    if (type === 'lowpass') {
      b0 = (1 - cw) / 2
      b1 = 1 - cw
      b2 = (1 - cw) / 2
    } else if (type === 'highpass') {
      b0 = (1 + cw) / 2
      b1 = -(1 + cw)
      b2 = (1 + cw) / 2
    } else {
      b0 = alpha
      b1 = 0
      b2 = -alpha
    }
    const ia0 = 1 / (1 + alpha)
    this.b0 = b0 * ia0
    this.b1 = b1 * ia0
    this.b2 = b2 * ia0
    this.a1 = -2 * cw * ia0
    this.a2 = (1 - alpha) * ia0
  }

  /** TDF2 处理单样本 */
  process(x: number): number {
    const y = this.b0 * x + this.s1
    this.s1 = this.b1 * x - this.a1 * y + this.s2
    this.s2 = this.b2 * x - this.a2 * y
    return y
  }

  reset(): void {
    this.s1 = 0
    this.s2 = 0
  }
}

class OnePoleLowpass {
  private b = 0
  private a1 = 0
  private prevInput = 0
  private prevOutput = 0

  design(cutoffHz: number, fs: number): void {
    const k = Math.tan(Math.PI * cutoffHz / fs)
    this.b = k / (1 + k)
    this.a1 = (k - 1) / (k + 1)
  }

  process(x: number): number {
    const y = this.b * (x + this.prevInput) - this.a1 * this.prevOutput
    this.prevInput = x
    this.prevOutput = y
    return y
  }

  reset(): void {
    this.prevInput = 0
    this.prevOutput = 0
  }
}

export class Deesser {
  private fs: number
  private enabled = true
  private centerHz = 6000
  private q = 0.7
  private thresholdDb = -30
  private thresholdPower = 0.001
  private ratio = 8
  private splitBand = true
  private mix = 1
  private attackCoef = 0
  private releaseCoef = 0
  private env = 0
  private readonly bpL = new Biquad()
  private readonly bpR = new Biquad()
  // 一阶互补分带：低通保留原相位参考，高通由原声减低通得到
  private readonly lpL = new OnePoleLowpass()
  private readonly lpR = new OnePoleLowpass()

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.applyParams({ enabled: true, centerHz: 6000, q: 0.7, thresholdDb: -30, ratio: 8, attackMs: 1, releaseMs: 80, splitBand: true, mix: 1 })
  }

  setParams(p: DeesserSettings): void {
    this.applyParams(p)
  }

  /** 参数即时生效：钳制 + 系数重算；包络状态保留（避免参数变化时爆音） */
  private applyParams(p: DeesserSettings): void {
    const activating = !this.enabled && p.enabled
    this.enabled = p.enabled
    this.centerHz = clamp(Number.isFinite(p.centerHz) ? p.centerHz : 6000, Math.min(100, this.fs * 0.45), this.fs * 0.45)
    this.q = clamp(Number.isFinite(p.q) ? p.q : 0.7, 0.1, 20)
    this.thresholdDb = clamp(Number.isFinite(p.thresholdDb) ? p.thresholdDb : -30, -80, 0)
    this.thresholdPower = Math.pow(10, this.thresholdDb / 10)
    this.ratio = clamp(Number.isFinite(p.ratio) ? p.ratio : 8, 1, 100)
    this.splitBand = p.splitBand
    this.mix = clamp(Number.isFinite(p.mix) ? p.mix : 1, 0, 1)
    this.attackCoef = onePoleCoef(Number.isFinite(p.attackMs) ? p.attackMs : 1, this.fs, 0.05)
    this.releaseCoef = onePoleCoef(Number.isFinite(p.releaseMs) ? p.releaseMs : 80, this.fs, 1)
    // 侧链带通：齿音频段
    this.bpL.design('bandpass', this.centerHz, this.q, this.fs)
    this.bpR.design('bandpass', this.centerHz, this.q, this.fs)
    // 截止取 centerHz·0.6；采样率较低时仍严格小于 Nyquist
    const xo = clamp(this.centerHz * 0.6, Math.min(2500, this.fs * 0.45), this.fs * 0.45)
    this.lpL.design(xo, this.fs)
    this.lpR.design(xo, this.fs)
    if (activating) this.reset()
  }

  /** 就地处理立体声（l/r 原地改写） */
  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    if (!this.enabled) return // 恒等直通
    const n = Math.min(l.length, r.length)
    const attack = this.attackCoef
    const release = this.releaseCoef
    const thresholdDb = this.thresholdDb
    const thresholdPower = this.thresholdPower
    const invRatio = 1 - 1 / this.ratio
    const mix = this.mix
    const split = this.splitBand
    for (let i = 0; i < n; i++) {
      const xl = l[i]
      const xr = r[i]
      // 1) 左右带通后取能量均值，同相输入保持旧触发电平，反相输入不抵消
      const sl = this.bpL.process(xl)
      const sr = this.bpR.process(xr)
      // 2) 平方包络 + attack/release 一阶平滑
      const p = 0.5 * (sl * sl + sr * sr)
      if (p > this.env) this.env += attack * (p - this.env)
      else this.env += release * (p - this.env)
      // 3) dB 域阈值压缩；低于阈值时避免逐样本对数/幂运算
      const over = this.env > thresholdPower ? 10 * Math.log10(this.env) - thresholdDb : 0
      const attenuation = over > 0 ? mix * (1 - Math.pow(10, -over * invRatio / 20)) : 0
      if (split) {
        // 滤波器始终跟踪输入，关闭衰减或重新触发时不会丢失低通历史
        const lowL = this.lpL.process(xl)
        const lowR = this.lpR.process(xr)
        l[i] = xl - attenuation * (xl - lowL)
        r[i] = xr - attenuation * (xr - lowR)
      } else {
        l[i] = xl * (1 - attenuation)
        r[i] = xr * (1 - attenuation)
      }
    }
  }

  reset(): void {
    this.env = 0
    this.bpL.reset()
    this.bpR.reset()
    this.lpL.reset()
    this.lpR.reset()
  }
}

