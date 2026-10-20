/** Float32 PCM to signed 16-bit with optional TPDF dither and first-order noise shaping. */
export type QuantizationMode = 'plain' | 'tpdf' | 'noiseShaped'

export class Pcm16Quantizer {
  private seed: number
  private error = 0

  constructor(private readonly mode: QuantizationMode = 'tpdf', seed = 0x12345678) {
    this.seed = seed >>> 0 || 1
  }

  private random(): number {
    let x = this.seed
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x >>> 0
    return this.seed / 0x100000000
  }

  process(sample: number): number {
    const input = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
    const noise = this.mode === 'plain' ? 0 : (this.random() - this.random()) / 32768
    const shaped = input + (this.mode === 'noiseShaped' ? 0.85 * this.error : 0) + noise
    const output = Math.max(-32768, Math.min(32767, Math.round(shaped * 32768)))
    // Clipping discards feedback so it cannot leak into the following unclipped signal.
    this.error = output === -32768 || output === 32767 ? 0 : input - output / 32768
    return output
  }

  reset(): void { this.error = 0 }
}
