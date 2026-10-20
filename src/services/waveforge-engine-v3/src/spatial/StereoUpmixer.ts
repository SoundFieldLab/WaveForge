/**
 * Matrix / phase-decoding stereo upmixer for headphone or downstream spatial paths.
 *
 * This derives center, surround, rear, and LFE channels from a stereo program. It
 * cannot recover discrete stems or prove that a mono source contains real spatial
 * information. For L=R, the difference-derived surround channels are silent.
 */

import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'

export type StereoUpmixLayout = '5.1' | '7.1'

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
 * Reusable block processor. Channel order is 5.1: FL, FR, FC, LFE, SL, SR;
 * 7.1: FL, FR, FC, LFE, BL, BR, SL, SR.
 *
 * Output is matrix-derived, not discrete multichannel. `process` reuses the same
 * channel buffers on every call and zeroes any unused tail after a short block.
 * Every extracted channel's HSE downmix contribution is subtracted from FL/FR:
 * C/SL/SR use 1/sqrt(2), BL/BR use 0.5 and LFE uses 0.25. A corresponding
 * downmix reconstructs the input instead of duplicating program level.
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

  constructor(options: StereoUpmixerOptions) {
    const { layout, sampleRate, blockSize } = options
    if (layout !== '5.1' && layout !== '7.1') throw new RangeError('layout must be 5.1 or 7.1')
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be finite and positive')
    if (!Number.isInteger(blockSize) || blockSize <= 0) throw new RangeError('blockSize must be a positive integer')

    this.layout = layout
    this.sampleRate = sampleRate
    this.blockSize = blockSize
    this.precision = normalizePrecision(options.precision)
    this.channelOrder = Object.freeze(layout === '5.1'
      ? ['FL', 'FR', 'FC', 'LFE', 'SL', 'SR']
      : ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
    this.outputChannels = this.channelOrder.map(() => allocBuffer(blockSize, this.precision))
    this.lfeAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(LFE_CUTOFF_HZ, sampleRate * 0.45)) / sampleRate)
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

    for (let channel = 0; channel < out.length; channel++) out[channel].fill(0)

    for (let i = 0; i < count; i++) {
      const l = finiteSample(left[i])
      const r = finiteSample(right[i])
      const mid = (l + r) * 0.5
      const side = (l - r) * 0.5
      const oppositeSide = side === 0 ? 0 : -side

      out[2][i] = mid
      out[3][i] = this.filterLfe(mid) * LFE_GAIN

      if (this.layout === '5.1') {
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

      // Subtract the contributions of the actual Float32 extracted samples,
      // so quantization cannot turn a full-strength upmix into a second copy
      // of the original program when HSE folds the virtual channels down.
      const common = out[2][i] * Math.SQRT1_2 + out[3][i] * 0.25
      const surroundL = this.layout === '5.1'
        ? out[4][i] * Math.SQRT1_2
        : out[6][i] * Math.SQRT1_2 + out[4][i] * 0.5
      const surroundR = this.layout === '5.1'
        ? out[5][i] * Math.SQRT1_2
        : out[7][i] * Math.SQRT1_2 + out[5][i] * 0.5
      out[0][i] = l - common - surroundL
      out[1][i] = r - common - surroundR
    }

    return out
  }

  reset(): void {
    this.lfeStage1 = 0
    this.lfeStage2 = 0
    for (let channel = 0; channel < this.outputChannels.length; channel++) this.outputChannels[channel].fill(0)
  }

  private filterLfe(input: number): number {
    this.lfeStage1 += this.lfeAlpha * (input - this.lfeStage1)
    this.lfeStage2 += this.lfeAlpha * (this.lfeStage1 - this.lfeStage2)
    return this.lfeStage2
  }
}

function finiteSample(value: number): number {
  return Number.isFinite(value) ? value : 0
}