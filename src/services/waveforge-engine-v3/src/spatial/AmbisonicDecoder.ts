import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'
import type { VirtualSpeaker } from './types'

/** 明确标记的格式；不根据普通 PCM 声道数猜测 Ambisonics。 */
export type SpatialInputFormat = 'channels' | 'ambix' | 'ambix1' | 'ambix2' | 'ambix3' | 'fuma'
export const MAX_AMBISONIC_ORDER = 3
export const FOA_SPEAKERS: VirtualSpeaker[] = [-135, -45, 45, 135].flatMap((azimuthDeg, index) =>
  [-35.2643897, 35.2643897].map((elevationDeg, height) => ({ channel: index * 2 + height,
    azimuthDeg, elevationDeg, distance: 1, gain: 1, size: 0, id: `foa-${index}-${height}` })))

const FORMAT_ORDER = { ambix: 1, ambix1: 1, ambix2: 2, ambix3: 3, fuma: 1 } as const
const FUMA_TO_ACN = [0, 3, 1, 2] as const
const inputCount = (order: number): number => (order + 1) ** 2

function orderForFormat(format: SpatialInputFormat): number {
  if (!Object.prototype.hasOwnProperty.call(FORMAT_ORDER, format)) throw new TypeError('Select an explicit ambix* or fuma Ambisonics format')
  return FORMAT_ORDER[format as keyof typeof FORMAT_ORDER]
}

/** Gauss-Legendre × 等间距方位角求积，阶数 N 使用 (N+1)×(2N+2) 个方向。 */
function samplingLayout(z: readonly number[], weights: readonly number[]): { speakers: VirtualSpeaker[]; weights: number[] } {
  const speakers: VirtualSpeaker[] = [], result: number[] = []
  const azimuths = 2 * z.length
  for (let ring = 0; ring < z.length; ring++) {
    for (let az = 0; az < azimuths; az++) {
      const channel = speakers.length
      speakers.push({ channel, azimuthDeg: az * 360 / azimuths - 180,
        elevationDeg: Math.asin(z[ring]) * 180 / Math.PI, distance: 1,
        gain: 1, size: 0, id: `hoa${z.length - 1}-${ring}-${az}` })
      result.push(weights[ring] / (2 * azimuths))
    }
  }
  return { speakers, weights: result }
}
const HOA2 = samplingLayout([-Math.sqrt(3 / 5), 0, Math.sqrt(3 / 5)], [5 / 9, 8 / 9, 5 / 9])
const zOuter = Math.sqrt((3 + 2 * Math.sqrt(6 / 5)) / 7)
const zInner = Math.sqrt((3 - 2 * Math.sqrt(6 / 5)) / 7)
const weightOuter = (18 - Math.sqrt(30)) / 36, weightInner = (18 + Math.sqrt(30)) / 36
const HOA3 = samplingLayout([-zOuter, -zInner, zInner, zOuter], [weightOuter, weightInner, weightInner, weightOuter])
const LAYOUTS = [[], FOA_SPEAKERS, HOA2.speakers, HOA3.speakers] as const
const WEIGHTS = [[], Array(8).fill(1 / 8), HOA2.weights, HOA3.weights] as const

/** 与 decoder.channels 顺序一致；FOA=8，二阶=18，三阶=32。请勿修改返回布局。 */
export function getAmbisonicSpeakers(format: SpatialInputFormat): readonly VirtualSpeaker[] {
  return LAYOUTS[orderForFormat(format)]
}

/** 声场旋转：yaw 正值转向右方，pitch 正值向上；阶增益用于声场方向性缩放。 */
export interface AmbisonicTransform {
  yawDeg?: number
  pitchDeg?: number
  rollDeg?: number
  /** ACN 球谐各阶的线性增益（0..3 阶），缺省为 1；允许范围 -4..4。 */
  orderGains?: readonly number[]
}

/** ACN/SN3D 实球谐；坐标 +X 前、+Y 左、+Z 上，无 Condon-Shortley 相位。 */
function harmonics(x: number, y: number, z: number, result: Float64Array): void {
  result[0] = 1
  result[1] = y; result[2] = z; result[3] = x
  result[4] = Math.sqrt(3) * x * y
  result[5] = Math.sqrt(3) * y * z
  result[6] = (3 * z * z - 1) / 2
  result[7] = Math.sqrt(3) * x * z
  result[8] = Math.sqrt(3) * (x * x - y * y) / 2
  result[9] = Math.sqrt(5 / 8) * (3 * x * x * y - y * y * y)
  result[10] = Math.sqrt(15) * x * y * z
  result[11] = Math.sqrt(3 / 8) * y * (5 * z * z - 1)
  result[12] = z * (5 * z * z - 3) / 2
  result[13] = Math.sqrt(3 / 8) * x * (5 * z * z - 1)
  result[14] = Math.sqrt(15) / 2 * z * (x * x - y * y)
  result[15] = Math.sqrt(5 / 8) * (x * x * x - 3 * x * y * y)
}

/**
 * 1..3 阶 ACN/SN3D 解码。FOA 保持已有 8 方向；HOA 使用满秩球面求积布局，
 * 保留全部 9/16 个球谐分量。FuMa 仅支持 WXYZ 一阶，W×√2 转成 SN3D。
 * 所有缓冲与默认矩阵在构造时准备；decode 不分配，变换须在控制路径 setTransform。
 */
export class AmbisonicDecoder {
  /** 输出缓冲精度：float64 时解码结果直接落双精度，不再先量化到 Float32。 */
  private precision: Precision
  private output: AudioBuffer[] = []
  private views: AudioBuffer[][] = []
  private activeOrder = 1
  get channels(): readonly AudioBuffer[] { return this.views[this.activeOrder] }
  left: AudioBuffer = new Float32Array(0)
  right: AudioBuffer = new Float32Array(0)
  private readonly matrices = LAYOUTS.map(layout => layout.map(() => new Float64Array(16)))
  private readonly fromMatrices = LAYOUTS.map(layout => layout.map(() => new Float64Array(16)))
  private readonly stereoLeft = new Float64Array(16)
  private readonly stereoRight = new Float64Array(16)
  private readonly fromStereoLeft = new Float64Array(16)
  private readonly fromStereoRight = new Float64Array(16)
  private readonly scratch = new Float64Array(16)
  private readonly samples = new Float64Array(16)
  private readonly gains = new Float64Array([1, 1, 1, 1])
  private cy = 1; private sy = 0
  private cp = 1; private sp = 0
  private cr = 1; private sr = 0
  private readonly fadeSamples: number
  /** 最近一个输出样本使用的矩阵混合位置；-1 表示下一样本从旧有效矩阵开始。 */
  private fadePosition: number
  private started = false

  constructor(sampleRate = 48000, precision: Precision = 'float32') {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('Ambisonics sample rate must be finite and positive')
    this.precision = normalizePrecision(precision)
    this.allocateOutput()
    this.fadeSamples = Math.max(1, Math.round(sampleRate * 0.02))
    this.fadePosition = this.fadeSamples
    this.setTransform({})
  }

  /** 当前输出缓冲精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换输出缓冲精度（幂等）：32×128 输出、left/right 与 channels 视图按新精度重建；
   * 随后 reset 清空输出（矩阵/变换系数不变）。默认 float32 路径逐位不变。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.allocateOutput()
    this.reset()
  }

  private allocateOutput(): void {
    this.output = Array.from({ length: 32 }, () => allocBuffer(128, this.precision))
    this.views = [[], this.output.slice(0, 8), this.output.slice(0, 18), this.output]
    this.left = allocBuffer(128, this.precision)
    this.right = allocBuffer(128, this.precision)
  }

  /** 修改预分配矩阵，不改变 HRTF 的虚拟扬声器方向。逆旋转采样实现整个声场的旋转。 */
  setTransform(transform: AmbisonicTransform): void {
    const yaw = transform.yawDeg ?? 0, pitch = transform.pitchDeg ?? 0, roll = transform.rollDeg ?? 0
    if (![yaw, pitch, roll].every(Number.isFinite)) throw new RangeError('Ambisonics rotation must be finite')
    for (let degree = 0; degree <= 3; degree++) {
      const gain = transform.orderGains?.[degree] ?? 1
      if (!Number.isFinite(gain) || Math.abs(gain) > 4) throw new RangeError('Ambisonics order gain must be finite within -4..4')
    }
    // 快速连续改参从最近输出所用的有效矩阵继续，不回到上一次目标或上一次起点。
    if (this.started) this.snapshotEffectiveMatrix()
    this.cy = Math.cos(yaw * Math.PI / 180); this.sy = Math.sin(yaw * Math.PI / 180)
    this.cp = Math.cos(pitch * Math.PI / 180); this.sp = Math.sin(pitch * Math.PI / 180)
    this.cr = Math.cos(roll * Math.PI / 180); this.sr = Math.sin(roll * Math.PI / 180)
    for (let degree = 0; degree <= 3; degree++) this.gains[degree] = transform.orderGains?.[degree] ?? 1
    for (let order = 1; order <= 3; order++) {
      const layout = LAYOUTS[order]
      for (let speaker = 0; speaker < layout.length; speaker++) {
        this.evaluate(layout[speaker].azimuthDeg, layout[speaker].elevationDeg)
        const matrix = this.matrices[order][speaker]
        for (let channel = 0; channel < inputCount(order); channel++) {
          const degree = Math.floor(Math.sqrt(channel))
          matrix[channel] = this.scratch[channel] * (2 * degree + 1) * WEIGHTS[order][speaker] * this.gains[degree]
        }
      }
    }
    this.evaluate(-45, 0)
    for (let channel = 0; channel < 16; channel++) this.stereoLeft[channel] = this.scratch[channel] * Math.SQRT1_2 * this.gains[Math.floor(Math.sqrt(channel))]
    this.evaluate(45, 0)
    for (let channel = 0; channel < 16; channel++) this.stereoRight[channel] = this.scratch[channel] * Math.SQRT1_2 * this.gains[Math.floor(Math.sqrt(channel))]
    this.fadePosition = this.started ? -1 : this.fadeSamples
  }

  private snapshotEffectiveMatrix(): void {
    const mix = Math.max(0, this.fadePosition) / this.fadeSamples
    for (let order = 1; order <= 3; order++) {
      for (let speaker = 0; speaker < this.matrices[order].length; speaker++) {
        const from = this.fromMatrices[order][speaker], target = this.matrices[order][speaker]
        for (let channel = 0; channel < inputCount(order); channel++) from[channel] += mix * (target[channel] - from[channel])
      }
    }
    for (let channel = 0; channel < 16; channel++) {
      this.fromStereoLeft[channel] += mix * (this.stereoLeft[channel] - this.fromStereoLeft[channel])
      this.fromStereoRight[channel] += mix * (this.stereoRight[channel] - this.fromStereoRight[channel])
    }
  }

  /** 音频流边界：立即同步到目标矩阵，清空输出；下一次初始配置不需要淡变。 */
  reset(): void {
    this.started = false
    this.fadePosition = this.fadeSamples
    this.left.fill(0); this.right.fill(0)
    for (const channel of this.output) channel.fill(0)
  }

  private evaluate(azimuthDeg: number, elevationDeg: number): void {
    const az = azimuthDeg * Math.PI / 180, el = elevationDeg * Math.PI / 180
    const x = Math.cos(el) * Math.cos(az), y = -Math.cos(el) * Math.sin(az), z = Math.sin(el)
    // Inverse yaw -> inverse pitch -> inverse roll. Positive yaw rotates a front source to UI right.
    const x1 = this.cy * x - this.sy * y, y1 = this.sy * x + this.cy * y
    const x2 = this.cp * x1 + this.sp * z, z2 = -this.sp * x1 + this.cp * z
    harmonics(x2, this.cr * y1 + this.sr * z2, -this.sr * y1 + this.cr * z2, this.scratch)
  }

  decode(inputs: readonly AudioBuffer[], offset: number, count: number, format: SpatialInputFormat): void {
    const order = orderForFormat(format), expected = inputCount(order)
    if (inputs.length !== expected) throw new RangeError(`${format} requires exactly ${expected} channels; received ${inputs.length}`)
    if (!Number.isInteger(offset) || !Number.isInteger(count) || offset < 0 || count < 0 || count > 128) {
      throw new RangeError('Ambisonics block must use integer offset/count and count must be within 0..128')
    }
    for (let channel = 0; channel < inputs.length; channel++) {
      if (!inputs[channel] || inputs[channel].length < offset + count) throw new RangeError(`Ambisonics channel ${channel} is shorter than offset + count`)
    }
    this.activeOrder = order
    const output = this.views[order], matrix = this.matrices[order], fromMatrix = this.fromMatrices[order]
    if (count > 0) this.started = true
    const fadingCount = Math.min(count, Math.max(0, this.fadeSamples - this.fadePosition - 1))
    let i = 0
    for (; i < fadingCount; i++) {
      if (this.fadePosition < this.fadeSamples) this.fadePosition++
      const mix = this.fadePosition / this.fadeSamples
      const fading = mix < 1
      for (let channel = 0; channel < expected; channel++) {
        const acn = format === 'fuma' ? FUMA_TO_ACN[channel] : channel
        const sample = inputs[channel][offset + i]
        this.samples[acn] = Number.isFinite(sample) ? sample * (format === 'fuma' && channel === 0 ? Math.SQRT2 : 1) : 0
      }
      let left = 0, right = 0
      for (let channel = 0; channel < expected; channel++) {
        const l = fading ? this.fromStereoLeft[channel] + mix * (this.stereoLeft[channel] - this.fromStereoLeft[channel]) : this.stereoLeft[channel]
        const r = fading ? this.fromStereoRight[channel] + mix * (this.stereoRight[channel] - this.fromStereoRight[channel]) : this.stereoRight[channel]
        left += this.samples[channel] * l
        right += this.samples[channel] * r
      }
      this.left[i] = left; this.right[i] = right
      for (let speaker = 0; speaker < output.length; speaker++) {
        let value = 0
        for (let channel = 0; channel < expected; channel++) {
          const coefficient = fading ? fromMatrix[speaker][channel] + mix * (matrix[speaker][channel] - fromMatrix[speaker][channel]) : matrix[speaker][channel]
          value += this.samples[channel] * coefficient
        }
        output[speaker][i] = value
      }
    }
    // 稳态不需要逐系数判断淡变；保留每个输出的声道累加次序与当前精度的写回。
    if (i < count) this.fadePosition = this.fadeSamples
    const samples = this.samples, stereoLeft = this.stereoLeft, stereoRight = this.stereoRight
    const fuma = format === 'fuma'
    for (; i < count; i++) {
      for (let channel = 0; channel < expected; channel++) {
        const acn = fuma ? FUMA_TO_ACN[channel] : channel
        const sample = inputs[channel][offset + i]
        samples[acn] = Number.isFinite(sample) ? sample * (fuma && channel === 0 ? Math.SQRT2 : 1) : 0
      }
      let left = 0, right = 0
      for (let channel = 0; channel < expected; channel++) {
        left += samples[channel] * stereoLeft[channel]
        right += samples[channel] * stereoRight[channel]
      }
      this.left[i] = left; this.right[i] = right
      for (let speaker = 0; speaker < output.length; speaker++) {
        const row = matrix[speaker]
        let value = 0
        for (let channel = 0; channel < expected; channel++) value += samples[channel] * row[channel]
        output[speaker][i] = value
      }
    }
  }
}
