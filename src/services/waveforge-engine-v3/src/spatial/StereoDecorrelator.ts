/**
 * StereoDecorrelator —— headLocked 虚拟扬声器环绕声道的早期反射式去相关。
 *
 * 矩阵上混的 SL/SR/BL/BR 来自 L−R 差分；单声道或高度相关的节目会让这些声道
 * 接近静音。本处理器把 mid=(L+R)/2 的短延迟副本（左右不同延迟、低增益、轻高通）
 * 叠加到环绕声道，让相关内容也有非相干的后方/侧方反射线索。
 *
 * 它不是音源分离：不改变 StereoUpmixer 的矩阵契约，也不用于真实多声道输入或
 * custom 双扬声器布局。默认 amount=0 时逐样本旁路。
 */

import type { AudioBuffer } from '../dsp/audioBuffer'

export type DecorrelationLayout = '51' | '514' | '71' | '714'

interface DecorrelationTap {
  channel: number
  delaySamples: number
  gain: number
}

/** 环绕/后环绕声道在 HSE 上混输出中的索引（HSE 顺序见 StereoUpmixer）。 */
const TAP_SPECS: Record<DecorrelationLayout, readonly { channel: number; delayMs: number; gain: number }[]> = {
  '51': [
    { channel: 4, delayMs: 8.5, gain: 0.28 },
    { channel: 5, delayMs: 12.5, gain: 0.28 },
  ],
  '514': [
    { channel: 4, delayMs: 8.5, gain: 0.28 },
    { channel: 5, delayMs: 12.5, gain: 0.28 },
  ],
  '71': [
    { channel: 4, delayMs: 7.5, gain: 0.22 },
    { channel: 5, delayMs: 11.5, gain: 0.22 },
    { channel: 6, delayMs: 15.5, gain: 0.18 },
    { channel: 7, delayMs: 19.5, gain: 0.18 },
  ],
  '714': [
    { channel: 4, delayMs: 7.5, gain: 0.22 },
    { channel: 5, delayMs: 11.5, gain: 0.22 },
    { channel: 6, delayMs: 15.5, gain: 0.18 },
    { channel: 7, delayMs: 19.5, gain: 0.18 },
  ],
}

const MAX_DELAY_MS = 25
/** 去相关副本的高通拐点：避免把低频整体灌到后方，只保留空间线索。 */
const HIGHPASS_HZ = 180

export class StereoDecorrelator {
  readonly sampleRate: number
  private readonly ring: Float32Array
  private readonly maxDelaySamples: number
  private readonly hpAlpha: number
  private readonly taps: Record<DecorrelationLayout, readonly DecorrelationTap[]>
  private writeIndex = 0
  private readonly hpState = new Map<number, number>()

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be finite and positive')
    this.sampleRate = sampleRate
    this.maxDelaySamples = Math.max(1, Math.ceil((MAX_DELAY_MS / 1000) * sampleRate))
    this.ring = new Float32Array(this.maxDelaySamples + 1)
    this.hpAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(HIGHPASS_HZ, sampleRate * 0.45)) / sampleRate)
    this.taps = {
      '51': this.buildTaps('51'), '514': this.buildTaps('514'),
      '71': this.buildTaps('71'), '714': this.buildTaps('714'),
    }
  }

  reset(): void {
    this.ring.fill(0)
    this.writeIndex = 0
    this.hpState.clear()
  }

  /**
   * 就地给环绕声道加入去相关副本。amount=0 时不写 ring，保持逐样本旁路；
   * layout=null（custom/真实多声道）不处理。
   */
  process(channels: readonly AudioBuffer[], left: AudioBuffer, right: AudioBuffer, frameCount: number,
    layout: DecorrelationLayout | null, amount: number): void {
    const normalized = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
    if (layout === null || normalized <= 0) return
    const taps = this.taps[layout]
    const requested = Number.isFinite(frameCount) ? Math.floor(frameCount) : 0
    const count = Math.max(0, Math.min(requested, left.length, right.length))
    const ringLength = this.ring.length

    for (let i = 0; i < count; i++) {
      const mid = (left[i] + right[i]) * 0.5
      this.ring[this.writeIndex] = Number.isFinite(mid) ? mid : 0
      for (const tap of taps) {
        const target = channels[tap.channel]
        if (!target || i >= target.length) continue
        const delayed = this.ring[(this.writeIndex - tap.delaySamples + ringLength) % ringLength]
        const previous = this.hpState.get(tap.channel) ?? 0
        const low = previous + this.hpAlpha * (delayed - previous)
        this.hpState.set(tap.channel, low)
        target[i] += (delayed - low) * normalized * tap.gain
      }
      this.writeIndex = (this.writeIndex + 1) % ringLength
    }
  }

  private buildTaps(layout: DecorrelationLayout): readonly DecorrelationTap[] {
    return TAP_SPECS[layout].map((tap) => ({
      channel: tap.channel,
      delaySamples: Math.max(1, Math.round((tap.delayMs / 1000) * this.sampleRate)),
      gain: tap.gain,
    }))
  }
}
