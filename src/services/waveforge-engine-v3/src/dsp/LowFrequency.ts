import type { AudioBuffer } from './audioBuffer'
import { Biquad } from './biquad'

/** 混合式次声高通：二阶 Butterworth HPF，开关按 20ms 渐变以避免瞬态突变。 */
export class SubsonicHighpass {
  private readonly highpassL: Biquad
  private readonly highpassR: Biquad
  private readonly mixAlpha: number
  private targetMix = 0
  private mix = 0
  private cutoffHz = 20

  constructor(private readonly sampleRate: number) {
    if (!(sampleRate > 0) || !Number.isFinite(sampleRate)) throw new Error('invalid sample rate')
    this.mixAlpha = 1 - Math.exp(-1 / (sampleRate * 0.02))
    this.highpassL = new Biquad('highpass', this.cutoffHz, Math.SQRT1_2, 0, sampleRate)
    this.highpassR = new Biquad('highpass', this.cutoffHz, Math.SQRT1_2, 0, sampleRate)
  }

  setParams(enabled: boolean, cutoffHz: number): void {
    this.targetMix = enabled === true ? 1 : 0
    const cutoff = Number.isFinite(cutoffHz) ? Math.min(Math.max(cutoffHz, 10), Math.min(40, this.sampleRate * 0.45)) : 20
    if (cutoff !== this.cutoffHz) {
      this.cutoffHz = cutoff
      this.highpassL.setParams('highpass', cutoff, Math.SQRT1_2, 0)
      this.highpassR.setParams('highpass', cutoff, Math.SQRT1_2, 0)
    }
  }

  processStereo(left: AudioBuffer, right: AudioBuffer): void {
    if (left.length !== right.length) throw new Error('subsonic highpass: L/R length mismatch')
    if (this.targetMix === 0 && this.mix < 1e-7) return
    for (let i = 0; i < left.length; i++) {
      this.mix += this.mixAlpha * (this.targetMix - this.mix)
      const l = left[i]
      const r = right[i]
      left[i] = l + this.mix * (this.highpassL.process(l) - l)
      right[i] = r + this.mix * (this.highpassR.process(r) - r)
    }
  }

  reset(): void {
    this.highpassL.reset()
    this.highpassR.reset()
    this.mix = 0
  }
}
