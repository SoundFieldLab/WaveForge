/**
 * biquad.ts —— RBJ 双二阶滤波器（系数设计 + TDF2 实现）
 *
 * 出处/许可：
 *  - 系数公式：Robert Bristow-Johnson《Cookbook formulae for audio EQ biquad filter
 *    coefficients》（RBJ Audio EQ Cookbook，公开公式）；
 *  - TDF2（转置直接 II 型）状态更新思路参考 DSPFilters（Vinnie Falco，MIT License，
 *    https://github.com/vinniefalco/DSPFilters）Biquad.h 的 State 实现；
 *  - 本实现为原创 TypeScript，仅按公开公式转录，未复制第三方代码。
 *
 * 约定：
 *  - 确定性：同输入同输出；无 Math.random / Date / console。
 *  - process / processBlock 内零分配；TDF2 状态为两个双精度标量。
 *  - fs<=0 抛 Error('invalid sample rate')；f0/Q/gain 做 clamp 防 NaN/Inf。
 */

export type BiquadType =
  | 'peaking'
  | 'lowshelf'
  | 'highshelf'
  | 'lowpass'
  | 'highpass'
  | 'bandpass'
  | 'notch'
  | 'allpass'

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * RBJ 系数设计（BLT 预畸变已内置在 w0 = 2π·f0/fs 中）。
 * f0 越界（<=0 或 >=fs/2）自动 clamp；q 必须 >0；gainDb 仅 peaking/shelf 使用。
 */
export function designBiquad(type: BiquadType, f0: number, q: number, gainDb: number, fs: number): BiquadCoeffs {
  if (!(fs > 0)) throw new Error('invalid sample rate')
  const nyq = fs / 2
  // 下限 10Hz：过低频率在 48k 采样下 BLT 系数病态（b≈0 杀静音 / 极点贴圆不稳定）——
  // 审计修复（原 clamp 1e-6 退化，1Hz 仍边缘；10Hz 与 Deesser 等内联实现一致）
  const f = Math.min(Math.max(f0, 10), nyq * (1 - 1e-9))
  const qq = Math.max(q, 1e-6)
  const g = Math.min(Math.max(gainDb, -60), 60)

  const w0 = (2 * Math.PI * f) / fs
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const alpha = sinw / (2 * qq) // 低通/高通/带通/陷波/全通共用

  let b0 = 0, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0
  switch (type) {
    case 'lowpass':
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'highpass':
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'bandpass': { // 常数 0dB 峰值增益型（RBJ 两种带通之一）
      b0 = alpha; b1 = 0; b2 = -alpha
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    }
    case 'notch':
      b0 = 1; b1 = -2 * cosw; b2 = 1
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'allpass':
      b0 = 1 - alpha; b1 = -2 * cosw; b2 = 1 + alpha
      a0 = 1 + alpha; a1 = -2 * cosw; a2 = 1 - alpha
      break
    case 'peaking': {
      const A = Math.pow(10, g / 40)
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
      break
    }
    case 'lowshelf': {
      const A = Math.pow(10, g / 40)
      const ashelf = (sinw / 2) * Math.SQRT2 // S=1（默认斜率）时 α = sin(w0)/2·√2
      const sqA = Math.sqrt(A)
      b0 = A * ((A + 1) - (A - 1) * cosw + 2 * sqA * ashelf)
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw)
      b2 = A * ((A + 1) - (A - 1) * cosw - 2 * sqA * ashelf)
      a0 = (A + 1) + (A - 1) * cosw + 2 * sqA * ashelf
      a1 = -2 * ((A - 1) + (A + 1) * cosw)
      a2 = (A + 1) + (A - 1) * cosw - 2 * sqA * ashelf
      break
    }
    case 'highshelf': {
      const A = Math.pow(10, g / 40)
      const ashelf = (sinw / 2) * Math.SQRT2
      const sqA = Math.sqrt(A)
      b0 = A * ((A + 1) + (A - 1) * cosw + 2 * sqA * ashelf)
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw)
      b2 = A * ((A + 1) + (A - 1) * cosw - 2 * sqA * ashelf)
      a0 = (A + 1) - (A - 1) * cosw + 2 * sqA * ashelf
      a1 = 2 * ((A - 1) - (A + 1) * cosw)
      a2 = (A + 1) - (A - 1) * cosw - 2 * sqA * ashelf
      break
    }
  }

  // 归一化（除以 a0）。a0 理论上恒 >0，防御性兜底为直通。
  if (!(a0 > 0) || !Number.isFinite(a0)) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
  const inv = 1 / a0
  return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv }
}

export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  /** TDF2 状态（双精度） */
  private s1 = 0
  private s2 = 0
  private readonly fs: number

  constructor(type?: BiquadType, f0?: number, q?: number, gainDb?: number, fs?: number) {
    const rate = fs ?? 48000
    if (!(rate > 0)) throw new Error('invalid sample rate')
    this.fs = rate
    this.reset()
    if (type !== undefined) {
      this.setParams(type, f0 ?? 1000, q ?? 1, gainDb ?? 0)
    }
  }

  setCoeffs(c: BiquadCoeffs): void {
    this.b0 = c.b0
    this.b1 = c.b1
    this.b2 = c.b2
    this.a1 = c.a1
    this.a2 = c.a2
  }

  /** 按 RBJ 公式重算系数（参数更新即时生效，状态保留） */
  setParams(type: BiquadType, f0: number, q: number, gainDb: number): void {
    this.setCoeffs(designBiquad(type, f0, q, gainDb, this.fs))
  }

  /** TDF2 处理单样本，返回 y（转置直接 II 型：状态转移在输出之后） */
  process(x: number): number {
    const y = this.b0 * x + this.s1
    this.s1 = this.b1 * x - this.a1 * y + this.s2
    this.s2 = this.b2 * x - this.a2 * y
    return y
  }

  processBlock(input: Float32Array, output: Float32Array): void {
    if (input.length !== output.length) throw new Error('biquad: input/output length mismatch')
    const { b0, b1, b2, a1, a2 } = this
    let s1 = this.s1
    let s2 = this.s2
    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      const y = b0 * x + s1
      s1 = b1 * x - a1 * y + s2
      s2 = b2 * x - a2 * y
      output[i] = y
    }
    this.s1 = s1
    this.s2 = s2
  }

  reset(): void {
    this.s1 = 0
    this.s2 = 0
  }

  /** 在给定频率处求 |H(e^{jw})|（线性幅度，单位增益），用于级联响应测量 */
  magnitudeAt(freqHz: number, fs: number): number {
    if (!(fs > 0)) throw new Error('invalid sample rate')
    const f = Math.min(Math.max(freqHz, 1e-6), (fs / 2) * (1 - 1e-9))
    const w = (2 * Math.PI * f) / fs
    const cw = Math.cos(w)
    const sw = Math.sin(w)
    const c2w = Math.cos(2 * w)
    const s2w = Math.sin(2 * w)
    // H(e^{jw}) = (b0 + b1·e^{-jw} + b2·e^{-j2w}) / (1 + a1·e^{-jw} + a2·e^{-j2w})
    const br = this.b0 + this.b1 * cw + this.b2 * c2w
    const bi = -(this.b1 * sw + this.b2 * s2w)
    const ar = 1 + this.a1 * cw + this.a2 * c2w
    const ai = -(this.a1 * sw + this.a2 * s2w)
    return Math.hypot(br, bi) / Math.hypot(ar, ai)
  }
}