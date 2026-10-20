import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'

/** 提取窗口与滤波矩阵均逐样本更新，调用块长不会改变估计结果。 */
export interface StereoAmbienceOptions {
  sampleRate: number
  covarianceMs?: number
  smoothingMs?: number
  /** 输出缓冲精度（缺省 float32；空间后端 float64 模式传 'float64'）。 */
  precision?: Precision
}

export interface StereoAmbienceBuffers {
  /** 非相干残差；预分配 128 样本，只读取 process 返回的有效长度。 */
  left: AudioBuffer
  right: AudioBuffer
  /** 输入减去残差后的主节目；两部分相加重建经过有限输入保护的输入。 */
  programmeLeft: AudioBuffer
  programmeRight: AudioBuffer
}

const CAPACITY = 128
const finitePositive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须为正有限数`)
  return value
}

/**
 * 宽带主成分/弥散模型：R = P·vvᵀ + A·I。
 * 最大特征向量估计主节目方向；较小特征值估计等功率非相干底。
 * 残差矩阵为 I - (1-λmin/λmax)·vvᵀ，相当于该模型的 Wiener 环境估计。
 *
 * 两声道不能唯一确定真实环境场：非相干节目、声像运动和混响也可能被归入残差，
 * 不提供独立 stem 或真实三维声场重建；同相、反相和固定声像单源的秩一输入残差为零。
 */
export class StereoAmbienceExtractor {
  readonly buffers: StereoAmbienceBuffers = {
    left: new Float32Array(CAPACITY), right: new Float32Array(CAPACITY),
    programmeLeft: new Float32Array(CAPACITY), programmeRight: new Float32Array(CAPACITY),
  }
  private precision: Precision
  private readonly covarianceAlpha: number
  private readonly matrixAlpha: number
  private ll = 0
  private rr = 0
  private lr = 0
  private matrixLL = 0
  private matrixRR = 0
  private matrixLR = 0
  private initialized = false
  private diffuse = 0

  constructor(options: StereoAmbienceOptions) {
    const fs = finitePositive(options.sampleRate, '采样率')
    this.precision = normalizePrecision(options.precision)
    if (this.precision === 'float64') this.rebuildBuffers('float64')
    const covarianceMs = finitePositive(options.covarianceMs ?? 40, '协方差时间')
    const smoothingMs = finitePositive(options.smoothingMs ?? 10, '矩阵平滑时间')
    this.covarianceAlpha = -Math.expm1(-1000 / (fs * covarianceMs))
    this.matrixAlpha = -Math.expm1(-1000 / (fs * smoothingMs))
  }

  /** 较小/较大特征值之比，0=秩一主源，1=当前窗口内近似等功率非相干。 */
  get diffuseness(): number { return this.diffuse }

  /** 当前输出缓冲精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换输出缓冲精度（幂等）：按新精度重建四路缓冲并 reset 估计状态。
   * 输入本就接受 Float32/Float64，不受此设置限制。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.rebuildBuffers(next)
    this.reset()
  }

  private rebuildBuffers(precision: Precision): void {
    this.buffers.left = allocBuffer(CAPACITY, precision)
    this.buffers.right = allocBuffer(CAPACITY, precision)
    this.buffers.programmeLeft = allocBuffer(CAPACITY, precision)
    this.buffers.programmeRight = allocBuffer(CAPACITY, precision)
  }

  /**
   * 输入可为 Float32/64，输出缓冲反复复用。过大有限值限制到 ±1e6 防止平方溢出；
   * 任一声道 NaN/Infinity 时将该立体声样本同时置零，避免制造单边瞬态。
   */
  process(left: Float32Array | Float64Array, right: Float32Array | Float64Array,
    count = Math.min(left.length, right.length)): number {
    if (!Number.isInteger(count) || count < 0 || count > CAPACITY || count > left.length || count > right.length)
      throw new RangeError('环境提取每次处理长度必须为 0–128 且不超过输入长度')
    const out = this.buffers
    for (let i = 0; i < count; i++) {
      const valid = Number.isFinite(left[i]) && Number.isFinite(right[i])
      const l = valid ? Math.max(-1e6, Math.min(1e6, left[i])) : 0
      const r = valid ? Math.max(-1e6, Math.min(1e6, right[i])) : 0
      this.ll += this.covarianceAlpha * (l * l - this.ll)
      this.rr += this.covarianceAlpha * (r * r - this.rr)
      this.lr += this.covarianceAlpha * (l * r - this.lr)
      const trace = this.ll + this.rr
      if (trace > 1e-30) {
        const delta = Math.hypot(this.ll - this.rr, 2 * this.lr)
        const maximum = (trace + delta) * 0.5
        const minimum = Math.max(0, (trace - delta) * 0.5)
        let ratio = minimum / Math.max(maximum, 1e-30)
        // 数值消减误差不应把精确秩一输入误认成非相干底。
        if (ratio < 1e-10) ratio = 0
        this.diffuse = Math.min(1, ratio)
        let targetLL = 1, targetRR = 1, targetLR = 0
        if (delta > trace * 1e-12) {
          const contrast = 1 - this.diffuse
          const axis = (this.ll - this.rr) / delta
          targetLL -= contrast * (1 + axis) * 0.5
          targetRR -= contrast * (1 - axis) * 0.5
          targetLR = -contrast * this.lr / delta
        }
        if (!this.initialized) {
          this.matrixLL = targetLL; this.matrixRR = targetRR; this.matrixLR = targetLR
          this.initialized = true
        } else {
          this.matrixLL += this.matrixAlpha * (targetLL - this.matrixLL)
          this.matrixRR += this.matrixAlpha * (targetRR - this.matrixRR)
          this.matrixLR += this.matrixAlpha * (targetLR - this.matrixLR)
        }
      }
      const ambientL = this.matrixLL * l + this.matrixLR * r
      const ambientR = this.matrixLR * l + this.matrixRR * r
      out.left[i] = ambientL; out.right[i] = ambientR
      out.programmeLeft[i] = l - ambientL; out.programmeRight[i] = r - ambientR
    }
    return count
  }

  reset(): void {
    this.ll = this.rr = this.lr = this.matrixLL = this.matrixRR = this.matrixLR = this.diffuse = 0
    this.initialized = false
    this.buffers.left.fill(0); this.buffers.right.fill(0)
    this.buffers.programmeLeft.fill(0); this.buffers.programmeRight.fill(0)
  }
}

/**
 * 明确的虚拟布局假设：残差 L/R 作为水平面 ±110° 两个后方平面波。
 * 输出为预分配 AmbiX FOA（ACN/SN3D：W,Y,Z,X），不是从立体声逆推真实方向。
 * 采用 1/√2 总增益避免相关残差合成 W 时比单侧信号翻倍。
 */
export function projectAmbienceToRearFoa(left: Float32Array, right: Float32Array,
  output: readonly [Float32Array, Float32Array, Float32Array, Float32Array], count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > left.length || count > right.length ||
    output.some(channel => channel.length < count)) throw new RangeError('FOA 投影缓冲长度不足')
  const gain = Math.SQRT1_2, lateral = Math.sin(110 * Math.PI / 180), front = Math.cos(110 * Math.PI / 180)
  for (let i = 0; i < count; i++) {
    const l = Number.isFinite(left[i]) ? left[i] * gain : 0
    const r = Number.isFinite(right[i]) ? right[i] * gain : 0
    output[0][i] = l + r
    output[1][i] = lateral * (l - r)
    output[2][i] = 0
    output[3][i] = front * (l + r)
  }
}