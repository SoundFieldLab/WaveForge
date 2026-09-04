/**
 * LoudnessComp —— 等响度补偿（模块 12）
 *
 * 出处/许可：等响度曲线概念源自 ISO 226:2003（人耳频率灵敏度随音量变化）；
 * 本实现使用简化的 1/3 倍频程近似增益表（技术文档 §6，v2 兼容语义），
 * 并采用 RBJ Audio EQ Cookbook（Robert Bristow-Johnson，公开公式）的
 * shelf/peaking biquad 拟合。注意：表数据为"ISO 226 简化近似（v2 兼容）"，
 * 正式发布前可与官方 ISO 226 表核对。本实现为自研 TS 代码。
 *
 * 实现要点：
 *  - 1/3 倍频程"等响度近似"增益表：低频 0–12dB、高频 0–6dB，随 volumePercent
 *    线性变化，100% 时 0dB、中频（1kHz 附近）保持 0dB。
 *    v2 语义：低频系数 0.35、高频系数 0.15（100Hz 与 10kHz 处相对灵敏度），
 *    归一化后 w(100Hz)=1.0、w(10kHz)=0.15/0.35≈0.43，故低频最大提升=maxBoostDb、
 *    高频最大提升≈0.43·maxBoostDb（maxBoostDb=12 时 ≈5.1dB≈"0–6dB"）。
 *  - 拟合：固定 low shelf 120Hz Q0.707 + high shelf 12kHz Q0.707 +
 *    中频 peaking（auto/preset 从候选频点按 |增益| 选取至多 4 段；
 *    custom 直接用用户中频 bands），总段数 2–6。
 *  - 增益平滑：各段目标增益经一阶低通（smoothingSeconds）逐块平滑，
 *    系数在平滑增益变化时重算，避免切换爆音。
 *  - mode：auto=音量线性等响度；preset=固定场景曲线；custom=用户曲线。
 *
 * 确定性：同输入同参数必同输出；无随机、无 Date、无 console。
 */

import type { CompensationMode } from '../types'

/** 等响度补偿参数（v2 兼容） */
export interface LoudnessCompParams {
  volumePercent: number
  maxBoostDb: number
  preset: string
  bands: { frequency: number; gain: number }[]
  mode: CompensationMode
  smoothingSeconds: number
}

/** RBJ biquad 系数 */
interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

// 1/3 倍频程中心频率（31 段，20Hz–20kHz）
const THIRD_OCTAVE_FREQS = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
]

// 中频 peaking 候选频点（auto/preset 拟合用）
const PEAKING_CANDIDATES = [315, 630, 1000, 1600, 2500, 4000, 6300]

// 场景预设曲线（v2 兼容 id：flat/bass/vocal/warm/bright/night；控制点 频率→dB）
const PRESET_CURVES: Record<string, Array<[number, number]>> = {
  flat: [],
  bass: [
    [63, 6], [100, 5], [160, 4], [250, 2.5], [400, 1.5], [630, 0.5], [1000, 0], [2000, 0], [4000, -0.5], [8000, -1],
    [12000, -1.5],
  ],
  vocal: [
    [100, 0], [200, 0.5], [400, 1.5], [800, 2.5], [1000, 3], [2000, 3.5], [3000, 3], [5000, 2], [8000, 1], [12000, 0.5],
  ],
  warm: [
    [63, 2], [100, 2.5], [200, 3], [400, 2.5], [800, 1.5], [1600, 0.5], [3000, 0], [6000, -1], [10000, -1.5],
    [16000, -2],
  ],
  bright: [
    [63, 0], [200, 0], [500, 0.5], [1000, 1], [2000, 1.5], [4000, 2.5], [6300, 3], [10000, 3], [16000, 2.5],
  ],
  night: [
    [63, 4], [100, 3.5], [200, 2.5], [400, 1.5], [800, 0.5], [1600, 0], [3000, -1], [6000, -2], [10000, -2.5],
    [16000, -3],
  ],
}

// 最大段数：2 shelf + 4 peaking
const MAX_BANDS = 6

export class LoudnessComp {
  private readonly fs: number

  // 当前目标参数（setParams 计算）
  private mode: CompensationMode = 'auto'
  private volumePercent = 100
  private maxBoostDb = 12
  private preset = 'flat'
  private smoothingSeconds = 0.2
  private targetGains: Float64Array = new Float64Array(MAX_BANDS)
  private targetFreqs: Float64Array = new Float64Array(MAX_BANDS)
  private targetTypes: Int32Array = new Int32Array(MAX_BANDS) // 0=low shelf,1=high shelf,2=peaking
  private currentGains: Float64Array = new Float64Array(MAX_BANDS)

  // 内部 biquad 链（6 段，0 增益时为恒等）；左右声道各自独立状态，
  // 避免"一链两声道"时另一声道的处理污染本声道滤波器状态（等效频率翻倍失真）。
  private bq: Array<{ c: BiquadCoeffs; z1: number; z2: number }> = []
  private bqR: Array<{ c: BiquadCoeffs; z1: number; z2: number }> = []

  constructor(fs: number) {
    if (fs <= 0 || !Number.isFinite(fs)) {
      throw new Error('invalid sample rate')
    }
    this.fs = fs
    for (let i = 0; i < MAX_BANDS; i++) {
      this.bq.push({ c: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, z1: 0, z2: 0 })
      this.bqR.push({ c: { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }, z1: 0, z2: 0 })
    }
    // 初始为恒等链（0 增益），与 currentGains=0 一致
    for (let i = 0; i < MAX_BANDS; i++) {
      this.bq[i].c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
      this.bqR[i].c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
    }
  }

  setParams(p: LoudnessCompParams): void {
    this.mode = p.mode === 'auto' || p.mode === 'preset' || p.mode === 'custom' ? p.mode : 'auto'
    this.volumePercent = clamp(p.volumePercent, 0, 100)
    this.maxBoostDb = clamp(p.maxBoostDb, 0, 24)
    this.preset = typeof p.preset === 'string' ? p.preset : 'flat'
    this.smoothingSeconds = clamp(p.smoothingSeconds, 0.01, 10)

    const bands = Array.isArray(p.bands) ? p.bands : []
    const targets = this.computeTargets(bands)
    // 写入目标（频率/类型随目标一起）
    this.targetGains.set(targets.gains)
    this.targetFreqs.set(targets.freqs)
    this.targetTypes.set(targets.types)
  }

  /** 就地处理立体声；6 段 biquad 级联 + 逐块增益平滑 */
  processStereo(l: Float32Array, r: Float32Array): void {
    const B = Math.min(l.length, r.length)
    // 逐块平滑增益（一阶低通，时间常数 smoothingSeconds）
    const alpha = 1 - Math.exp(-B / (this.smoothingSeconds * this.fs))
    for (let i = 0; i < MAX_BANDS; i++) {
      const target = this.targetGains[i]
      const current = this.currentGains[i]
      if (current !== target) {
        let g = current + alpha * (target - current)
        if (Math.abs(g - target) < 1e-9) g = target
        this.currentGains[i] = g
        this.recomputeCoeffs(i, g)
      }
    }

    for (let i = 0; i < B; i++) {
      const xl = l[i]
      const xr = r[i]
      let yl = xl
      let yr = xr
      for (let k = 0; k < MAX_BANDS; k++) {
        yl = this.biquadStep(this.bq[k], yl)
        yr = this.biquadStep(this.bqR[k], yr)
      }
      l[i] = yl
      r[i] = yr
    }
  }

  reset(): void {
    for (let i = 0; i < MAX_BANDS; i++) {
      this.bq[i].z1 = 0
      this.bq[i].z2 = 0
      this.bqR[i].z1 = 0
      this.bqR[i].z2 = 0
      this.currentGains[i] = this.targetGains[i]
      this.recomputeCoeffs(i, this.targetGains[i])
    }
  }

  // ---------------------------------------------------------------- 内部

  /** 按模式计算目标曲线并拟合为 2–6 段 */
  private computeTargets(bands: { frequency: number; gain: number }[]): {
    gains: Float64Array
    freqs: Float64Array
    types: Int32Array
  } {
    const gains = new Float64Array(MAX_BANDS)
    const freqs = new Float64Array(MAX_BANDS)
    const types = new Int32Array(MAX_BANDS)
    let n = 0

    if (this.mode === 'custom') {
      // custom：低/高频段增益取用户低/高频 bands 均值；中频直接用用户 bands 做 peaking
      const low = bands.filter((b) => b.frequency <= 250)
      const high = bands.filter((b) => b.frequency >= 6000)
      const mid = bands.filter((b) => b.frequency > 250 && b.frequency < 6000)
      const lowGain = low.length > 0 ? average(low.map((b) => clamp(b.gain, -24, 24))) : 0
      const highGain = high.length > 0 ? average(high.map((b) => clamp(b.gain, -24, 24))) : 0
      if (Math.abs(lowGain) >= 0.25) {
        gains[n] = lowGain
        freqs[n] = 120
        types[n] = 0
        n++
      }
      if (Math.abs(highGain) >= 0.25) {
        gains[n] = highGain
        freqs[n] = 12000
        types[n] = 1
        n++
      }
      // 中频 peaking（按 |增益| 降序取至多 4 段，再按频率升序排列）
      const picked = mid
        .filter((b) => Math.abs(clamp(b.gain, -24, 24)) >= 0.25)
        .map((b) => ({ f: clamp(b.frequency, 20, 20000), g: clamp(b.gain, -24, 24) }))
        .sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || a.f - b.f)
        .slice(0, 4)
        .sort((a, b) => a.f - b.f)
      for (const pk of picked) {
        gains[n] = pk.g
        freqs[n] = pk.f
        types[n] = 2
        n++
      }
      return { gains, freqs, types }
    }

    // auto / preset：先构造 1/3 倍频程目标表
    const table = new Float64Array(THIRD_OCTAVE_FREQS.length)
    if (this.mode === 'preset') {
      const curve = PRESET_CURVES[this.preset] || PRESET_CURVES.flat
      for (let i = 0; i < THIRD_OCTAVE_FREQS.length; i++) {
        table[i] = interpLogCurve(THIRD_OCTAVE_FREQS[i], curve)
      }
    } else {
      // auto：ISO 226 简化近似（v2 兼容），随音量线性
      const v = this.volumePercent / 100
      for (let i = 0; i < THIRD_OCTAVE_FREQS.length; i++) {
        table[i] = this.maxBoostDb * (1 - v) * autoWeight(THIRD_OCTAVE_FREQS[i])
      }
    }

    // 固定 2 shelf
    const lowGain = table[THIRD_OCTAVE_FREQS.indexOf(100)]
    const highGain = table[THIRD_OCTAVE_FREQS.indexOf(10000)]
    if (Math.abs(lowGain) >= 0.25) {
      gains[n] = lowGain
      freqs[n] = 120
      types[n] = 0
      n++
    }
    if (Math.abs(highGain) >= 0.25) {
      gains[n] = highGain
      freqs[n] = 12000
      types[n] = 1
      n++
    }
    // 中频 peaking 候选
    const picked: Array<{ f: number; g: number }> = []
    for (const f of PEAKING_CANDIDATES) {
      const g = table[THIRD_OCTAVE_FREQS.indexOf(f)]
      if (Math.abs(g) >= 0.25) picked.push({ f, g })
    }
    picked.sort((a, b) => Math.abs(b.g) - Math.abs(a.g) || a.f - b.f)
    const top = picked.slice(0, 4).sort((a, b) => a.f - b.f)
    for (const pk of top) {
      gains[n] = pk.g
      freqs[n] = pk.f
      types[n] = 2
      n++
    }
    return { gains, freqs, types }
  }

  /** 按当前平滑增益重算某段 biquad 系数 */
  private recomputeCoeffs(idx: number, gainDb: number): void {
    const f = this.targetFreqs[idx]
    const type = this.targetTypes[idx]
    const c =
      type === 0
        ? designShelf(true, f, gainDb, this.fs)
        : type === 1
          ? designShelf(false, f, gainDb, this.fs)
          : designPeaking(f, gainDb, 1.0, this.fs)
    this.bq[idx].c = c
    this.bqR[idx].c = c
  }

  /** TDF2 一步 */
  private biquadStep(b: { c: BiquadCoeffs; z1: number; z2: number }, x: number): number {
    const y = b.c.b0 * x + b.z1
    b.z1 = b.c.b1 * x - b.c.a1 * y + b.z2
    b.z2 = b.c.b2 * x - b.c.a2 * y
    return y
  }
}

// ---------------------------------------------------------------- 工具

function clamp(v: number, lo: number, hi: number): number {
  // 拒绝 NaN/Infinity：非法参数回落默认值（否则平滑系数/滤波器系数 NaN → 全链 NaN）
  if (!Number.isFinite(v)) return lo
  return v < lo ? lo : v > hi ? hi : v
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0
  let s = 0
  for (const v of arr) s += v
  return s / arr.length
}

/**
 * auto 模式 1/3 倍频程权重 w(f)（ISO 226 简化近似，v2 兼容）：
 *  - f ≤ 100Hz：1.0（低频全提升，→ 最大 boost = maxBoostDb，即"0–12dB"）
 *  - 100Hz→250Hz：对数线性 1.0→0
 *  - 250Hz–2kHz：0（中频参考区，1kHz 处为 0dB）
 *  - 2kHz→10kHz：对数线性 0→0.15/0.35≈0.43（高频最大提升 ≈0.43·maxBoostDb≈"0–6dB"）
 *  - f ≥ 10kHz：0.43
 */
function autoWeight(f: number): number {
  if (f <= 100) return 1.0
  if (f < 250) {
    const t = (Math.log10(f) - Math.log10(100)) / (Math.log10(250) - Math.log10(100))
    return 1 - t
  }
  if (f < 2000) return 0
  if (f < 10000) {
    const t = (Math.log10(f) - Math.log10(2000)) / (Math.log10(10000) - Math.log10(2000))
    return 0.15 / 0.35 * t
  }
  return 0.15 / 0.35
}

/** 控制点对数线性插值（频带外取端点值） */
function interpLogCurve(f: number, pts: Array<[number, number]>): number {
  if (pts.length === 0) return 0
  if (pts.length === 1) return pts[0][1]
  const sorted = [...pts].sort((a, b) => a[0] - b[0])
  if (f <= sorted[0][0]) return sorted[0][1]
  if (f >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1]
  for (let i = 0; i < sorted.length - 1; i++) {
    const [f0, g0] = sorted[i]
    const [f1, g1] = sorted[i + 1]
    if (f >= f0 && f <= f1) {
      if (f === f0) return g0
      if (f === f1) return g1
      const t = (Math.log10(f) - Math.log10(f0)) / (Math.log10(f1) - Math.log10(f0))
      return g0 + t * (g1 - g0)
    }
  }
  return 0
}

// ---------------------------------------------------------------- RBJ 设计

/** RBJ peaking：A=10^(g/40)，α=sin(w0)/(2Q)。f0 必须 < fs/2（越界钳到 0.45·fs，防极点出圆 NaN） */
function designPeaking(f0: number, gainDb: number, q: number, fs: number): BiquadCoeffs {
  const f = Math.min(Math.max(f0, 1), fs * 0.45)
  const a = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f) / fs
  const alpha = Math.sin(w0) / (2 * q)
  const cw = Math.cos(w0)
  const b0 = 1 + alpha * a
  const b1 = -2 * cw
  const b2 = 1 - alpha * a
  const a0 = 1 + alpha / a
  const a1 = -2 * cw
  const a2 = 1 - alpha / a
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/**
 * RBJ shelf（isLow=true 低架 / false 高架），S=1（默认斜率）：α = sin(w0)/2·√2。
 * 说明：v2 兼容语义固定 S=1（对应 Q≈0.707 的一阶型架式），故签名不含 Q。
 */
function designShelf(isLow: boolean, f0: number, gainDb: number, fs: number): BiquadCoeffs {
  const f = Math.min(Math.max(f0, 1), fs * 0.45) // 越界钳制（12kHz 架在 fs=8k 下必 NaN）
  const a = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * f) / fs
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2
  const cw = Math.cos(w0)
  const sa = Math.sqrt(a)
  if (isLow) {
    const b0 = a * ((a + 1) - (a - 1) * cw + 2 * sa * alpha)
    const b1 = 2 * a * ((a - 1) - (a + 1) * cw)
    const b2 = a * ((a + 1) - (a - 1) * cw - 2 * sa * alpha)
    const a0 = (a + 1) + (a - 1) * cw + 2 * sa * alpha
    const a1 = -2 * ((a - 1) + (a + 1) * cw)
    const a2 = (a + 1) + (a - 1) * cw - 2 * sa * alpha
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
  }
  const b0 = a * ((a + 1) + (a - 1) * cw + 2 * sa * alpha)
  const b1 = -2 * a * ((a - 1) + (a + 1) * cw)
  const b2 = a * ((a + 1) + (a - 1) * cw - 2 * sa * alpha)
  const a0 = (a + 1) - (a - 1) * cw + 2 * sa * alpha
  const a1 = 2 * ((a - 1) - (a + 1) * cw)
  const a2 = (a + 1) - (a - 1) * cw - 2 * sa * alpha
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}