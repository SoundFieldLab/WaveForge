/**
 * Matrix / phase-decoding stereo upmixer for headphone or downstream spatial paths.
 *
 * This derives center, surround, rear, height, and LFE channels from a stereo program.
 * It cannot recover discrete stems or prove that a mono source contains real spatial
 * information. For L=R, the difference-derived surround/rear channels are silent; the
 * height layer still carries the high band of the coherent program so a mono source
 * keeps an elevated front image.
 *
 * Channel orders follow WAVE convention (7.1.4 adds TFL/TFR/TRL/TRR after 7.1).
 */

import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'

export type StereoUpmixLayout = '5.1' | '7.1' | '5.1.4' | '7.1.4'

export interface StereoUpmixerOptions {
  layout: StereoUpmixLayout
  sampleRate: number
  /** Maximum block length. Output buffers are allocated once at construction. */
  blockSize: number
  /** 输出声道缓冲精度（缺省 float32；EngineV3 float64 模式传 'float64'）。 */
  precision?: Precision
}

const LFE_CUTOFF_HZ = 120
const LFE_GAIN = 0.25
/**
 * 顶置层取 3 kHz 以上的高频带：HRTF 的仰角线索主要落在高频，而人声基频/主体
 * 留在正面，避免把整段人声拉到头顶。前顶置保留左右高频，后顶置取高频差分
 * （与前顶置不同源），形成上方包围而非简单复制地面层。
 */
const HEIGHT_CROSSOVER_HZ = 3000
const HEIGHT_FRONT_GAIN = 0.35
const HEIGHT_REAR_GAIN = 0.4

const CHANNEL_ORDERS: Record<StereoUpmixLayout, readonly string[]> = {
  '5.1': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'],
  '7.1': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'],
  '5.1.4': ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'TFL', 'TFR', 'TRL', 'TRR'],
  '7.1.4': ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR', 'TFL', 'TFR', 'TRL', 'TRR'],
}

/**
 * Reusable block processor. Channel order is 5.1: FL, FR, FC, LFE, SL, SR;
 * 7.1: FL, FR, FC, LFE, BL, BR, SL, SR; 5.1.4/7.1.4 append TFL, TFR, TRL, TRR.
 *
 * Output is matrix-derived, not discrete multichannel. `process` reuses the same
 * channel buffers on every call and zeroes any unused tail after a short block.
 * Every extracted channel's HSE downmix contribution is subtracted from FL/FR:
 * C/SL/SR use 1/sqrt(2), BL/BR use 0.5, LFE uses 0.25 and each height channel 0.5.
 * A corresponding downmix reconstructs the input instead of duplicating program level.
 */
export class StereoUpmixer {
  readonly layout: StereoUpmixLayout
  readonly sampleRate: number
  readonly blockSize: number
  readonly channelOrder: readonly string[]
  /** 输出声道缓冲：类型跟随内部精度（float64 模式为 Float64Array）。 */
  readonly outputChannels: AudioBuffer[]
  readonly description = 'Matrix-derived output; not discrete multichannel.'

  private precision: Precision
  private readonly lfeAlpha: number
  private lfeStage1 = 0
  private lfeStage2 = 0
  /** 顶置层 2 阶高通（左右独立状态；非 .4 布局不参与运算，5.1/7.1 输出逐位不变）。 */
  private readonly heightLayer: boolean
  private readonly heightBase: number
  private readonly hpB0: number
  private readonly hpB1: number
  private readonly hpB2: number
  private readonly hpA1: number
  private readonly hpA2: number
  private hpX1L = 0
  private hpX2L = 0
  private hpY1L = 0
  private hpY2L = 0
  private hpX1R = 0
  private hpX2R = 0
  private hpY1R = 0
  private hpY2R = 0

  constructor(options: StereoUpmixerOptions) {
    const { layout, sampleRate, blockSize } = options
    const order = CHANNEL_ORDERS[layout]
    if (order === undefined) throw new RangeError('layout must be 5.1, 7.1, 5.1.4 or 7.1.4')
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be finite and positive')
    if (!Number.isInteger(blockSize) || blockSize <= 0) throw new RangeError('blockSize must be a positive integer')

    this.layout = layout
    this.sampleRate = sampleRate
    this.blockSize = blockSize
    this.precision = normalizePrecision(options.precision)
    this.channelOrder = Object.freeze([...order])
    this.outputChannels = this.channelOrder.map(() => allocBuffer(blockSize, this.precision))
    this.lfeAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(LFE_CUTOFF_HZ, sampleRate * 0.45)) / sampleRate)
    this.heightLayer = layout === '5.1.4' || layout === '7.1.4'
    this.heightBase = this.channelOrder.length - 4
    // RBJ cookbook 2 阶高通（Q=1/sqrt(2)）；系数与状态无关，构造期一次算好。
    const w0 = 2 * Math.PI * Math.min(HEIGHT_CROSSOVER_HZ, sampleRate * 0.45) / sampleRate
    const cosW = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
    const a0 = 1 + alpha
    this.hpB0 = (1 + cosW) / 2 / a0
    this.hpB1 = -(1 + cosW) / a0
    this.hpB2 = this.hpB0
    this.hpA1 = (-2 * cosW) / a0
    this.hpA2 = (1 - alpha) / a0
  }

  /** 当前输出声道缓冲精度。 */
  getPrecision(): Precision {
    return this.precision
  }

  /**
   * 切换输出声道缓冲精度（幂等）：按新精度重建声道缓冲并 reset。
   * 输出仍由调用方按 AudioBuffer 消费；float32 默认行为不变。
   */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    const buffers: AudioBuffer[] = this.channelOrder.map(() => allocBuffer(this.blockSize, next))
    for (let i = 0; i < buffers.length; i++) this.outputChannels[i] = buffers[i]
    this.reset()
  }

  /**
   * Decode up to one block. A short input pair processes the shorter length and
   * clears the rest of the output. Non-finite samples become silence. Finite
   * Float32 input and residual fronts are not clipped or globally attenuated.
   */
  process(left: AudioBuffer, right: AudioBuffer, frameCount?: number): AudioBuffer[] {
    const requested = frameCount === undefined
      ? Math.min(left.length, right.length, this.blockSize)
      : (Number.isFinite(frameCount) ? Math.floor(frameCount) : 0)
    const count = Math.max(0, Math.min(requested, left.length, right.length, this.blockSize))
    const out = this.outputChannels
    const heights = this.heightLayer
    const heightBase = this.heightBase

    for (let channel = 0; channel < out.length; channel++) out[channel].fill(0)

    for (let i = 0; i < count; i++) {
      const l = finiteSample(left[i])
      const r = finiteSample(right[i])
      const mid = (l + r) * 0.5
      const side = (l - r) * 0.5
      const oppositeSide = side === 0 ? 0 : -side

      out[2][i] = mid
      out[3][i] = this.filterLfe(mid) * LFE_GAIN

      if (this.layout === '5.1' || this.layout === '5.1.4') {
        out[4][i] = side * 0.5
        out[5][i] = oppositeSide * 0.5
      } else {
        // Side and rear are two gain-scaled matrix decodes of the stereo phase
        // difference. They remain derived channels, not independent source stems.
        out[4][i] = side * 0.25
        out[5][i] = oppositeSide * 0.25
        out[6][i] = side * 0.5
        out[7][i] = oppositeSide * 0.5
      }

      let heightL = 0
      let heightR = 0
      if (heights) {
        const highLeft = this.filterHeightL(l)
        const highRight = this.filterHeightR(r)
        const highSide = (highLeft - highRight) * 0.5
        out[heightBase][i] = highLeft * HEIGHT_FRONT_GAIN
        out[heightBase + 1][i] = highRight * HEIGHT_FRONT_GAIN
        out[heightBase + 2][i] = highSide * HEIGHT_REAR_GAIN
        out[heightBase + 3][i] = -highSide * HEIGHT_REAR_GAIN
        // 与 HSE 下混矩阵一致：每只高度声道同侧各计 0.5。
        heightL = (out[heightBase][i] + out[heightBase + 2][i]) * 0.5
        heightR = (out[heightBase + 1][i] + out[heightBase + 3][i]) * 0.5
      }

      // Subtract the contributions of the actual Float32 extracted samples,
      // so quantization cannot turn a full-strength upmix into a second copy
      // of the original program when HSE folds the virtual channels down.
      const common = out[2][i] * Math.SQRT1_2 + out[3][i] * 0.25
      const surroundL = this.layout === '5.1' || this.layout === '5.1.4'
        ? out[4][i] * Math.SQRT1_2
        : out[6][i] * Math.SQRT1_2 + out[4][i] * 0.5
      const surroundR = this.layout === '5.1' || this.layout === '5.1.4'
        ? out[5][i] * Math.SQRT1_2
        : out[7][i] * Math.SQRT1_2 + out[5][i] * 0.5
      out[0][i] = l - common - surroundL - heightL
      out[1][i] = r - common - surroundR - heightR
    }

    return out
  }

  reset(): void {
    this.lfeStage1 = 0
    this.lfeStage2 = 0
    this.hpX1L = 0
    this.hpX2L = 0
    this.hpY1L = 0
    this.hpY2L = 0
    this.hpX1R = 0
    this.hpX2R = 0
    this.hpY1R = 0
    this.hpY2R = 0
    for (let channel = 0; channel < this.outputChannels.length; channel++) this.outputChannels[channel].fill(0)
  }

  private filterLfe(input: number): number {
    this.lfeStage1 += this.lfeAlpha * (input - this.lfeStage1)
    this.lfeStage2 += this.lfeAlpha * (this.lfeStage1 - this.lfeStage2)
    return this.lfeStage2
  }

  private filterHeightL(input: number): number {
    const y = this.hpB0 * input + this.hpB1 * this.hpX1L + this.hpB2 * this.hpX2L
      - this.hpA1 * this.hpY1L - this.hpA2 * this.hpY2L
    this.hpX2L = this.hpX1L
    this.hpX1L = input
    this.hpY2L = this.hpY1L
    this.hpY1L = y
    return y
  }

  private filterHeightR(input: number): number {
    const y = this.hpB0 * input + this.hpB1 * this.hpX1R + this.hpB2 * this.hpX2R
      - this.hpA1 * this.hpY1R - this.hpA2 * this.hpY2R
    this.hpX2R = this.hpX1R
    this.hpX1R = input
    this.hpY2R = this.hpY1R
    this.hpY1R = y
    return y
  }
}

function finiteSample(value: number): number {
  return Number.isFinite(value) ? value : 0
}
