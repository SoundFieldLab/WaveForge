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

/** 环绕/后环绕声道在 HSE 上混输出中的索引（HSE 顺序见 StereoUpmixer）。 */
const TAP_SPECS: Record<DecorrelationLayout, readonly { channel: number; delayMs: number; gain: number }[]> = {
  '51': [
    { channel: 4, delayMs: 8.5, gain: 0.28 },
    { channel: 5, delayMs: 12.5, gain: 0.28 },
  ],
  '514': [
    { channel: 4, delayMs: 8.5, gain: 0.28 },
    { channel: 5, delayMs: 12.5, gain: 0.28 },
    // 顶置层只有 3kHz 以上高频派生，补一点更短延迟的反射让上方也有房间感。
    { channel: 6, delayMs: 4.5, gain: 0.1 },
    { channel: 7, delayMs: 6.5, gain: 0.1 },
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
    // 4 只顶置（TFL/TFR/TRL/TRR）用更短延迟的独立反射，避免上方只剩高频派生。
    { channel: 8, delayMs: 4.5, gain: 0.1 },
    { channel: 9, delayMs: 6.5, gain: 0.1 },
    { channel: 10, delayMs: 9.5, gain: 0.09 },
    { channel: 11, delayMs: 12.5, gain: 0.09 },
  ],
}

const MAX_DELAY_MS = 25
/** 去相关副本的高通拐点：避免把低频整体灌到后方，只保留空间线索。 */
const HIGHPASS_HZ = 180
/** 上混最多 12 声道；状态按声道索引放在定长数组里，热路径零分配。 */
const MAX_CHANNELS = 16
const MAX_TAPS = 8

export class StereoDecorrelator {
  readonly sampleRate: number
  private readonly ring: Float32Array
  private readonly hpAlpha: number
  private readonly hpState = new Float64Array(MAX_CHANNELS)
  /** 当前布局的 tap 表（channel/delay/gain 已含 amount 预乘），避免每样本查对象。 */
  private readonly tapChannel = new Int32Array(MAX_TAPS)
  private readonly tapDelay = new Int32Array(MAX_TAPS)
  private readonly tapGain = new Float64Array(MAX_TAPS)
  private tapCount = 0
  private writeIndex = 0

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('sampleRate must be finite and positive')
    this.sampleRate = sampleRate
    const maxDelaySamples = Math.max(1, Math.ceil((MAX_DELAY_MS / 1000) * sampleRate))
    this.ring = new Float32Array(maxDelaySamples + 1)
    this.hpAlpha = 1 - Math.exp((-2 * Math.PI * Math.min(HIGHPASS_HZ, sampleRate * 0.45)) / sampleRate)
  }

  reset(): void {
    this.ring.fill(0)
    this.hpState.fill(0)
    this.tapCount = 0
    this.writeIndex = 0
  }

  /**
   * 就地给环绕声道加入去相关副本。amount=0 时不写 ring，保持逐样本旁路；
   * layout=null（custom/真实多声道）不处理。
   */
  process(channels: readonly AudioBuffer[], left: AudioBuffer, right: AudioBuffer, frameCount: number,
    layout: DecorrelationLayout | null, amount: number): void {
    const normalized = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0
    if (layout === null || normalized <= 0) return
    const requested = Number.isFinite(frameCount) ? Math.floor(frameCount) : 0
    const frames = Math.max(0, Math.min(requested, left.length, right.length))
    if (frames === 0) return
    this.prepareTaps(layout, normalized)
    const taps = this.tapCount
    const ring = this.ring
    const ringLength = ring.length
    const alpha = this.hpAlpha
    const hp = this.hpState
    const tapChannel = this.tapChannel
    const tapDelay = this.tapDelay
    const tapGain = this.tapGain
    let write = this.writeIndex

    for (let i = 0; i < frames; i++) {
      const mid = (left[i] + right[i]) * 0.5
      ring[write] = Number.isFinite(mid) ? mid : 0
      for (let t = 0; t < taps; t++) {
        const channel = tapChannel[t]
        const target = channels[channel]
        if (!target || i >= target.length) continue
        // 延迟读指针只做一次加法回绕，避免每样本取模。
        let read = write - tapDelay[t]
        if (read < 0) read += ringLength
        const delayed = ring[read]
        const low = hp[channel] + alpha * (delayed - hp[channel])
        hp[channel] = low
        target[i] += (delayed - low) * tapGain[t]
      }
      if (++write === ringLength) write = 0
    }
    this.writeIndex = write
  }

  /** 布局/强度变化时刷新 tap 表（gain 预乘 amount，热路径不再逐样本乘）。 */
  private prepareTaps(layout: DecorrelationLayout, amount: number): void {
    const specs = TAP_SPECS[layout]
    for (let i = 0; i < specs.length; i++) {
      this.tapChannel[i] = specs[i].channel
      this.tapDelay[i] = Math.max(1, Math.round((specs[i].delayMs / 1000) * this.sampleRate))
      this.tapGain[i] = specs[i].gain * amount
    }
    this.tapCount = specs.length
  }
}
