import type { AudioBuffer } from './audioBuffer'
/** 耳机交叉馈送：对侧声道低通、短延时并小幅混入，保持立体声左右对称。 */
export interface CrossfeedSettings {
  enabled: boolean
  amount: number
  cutoffHz: number
  delayMs: number
}

export class Crossfeed {
  private readonly fs: number
  private readonly historyL: Float64Array
  private readonly historyR: Float64Array
  private pos = 0
  private lowL = 0
  private lowR = 0
  private pole = 0
  private gain = 0
  private delay = 1
  private enabled = false

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    const capacity = Math.max(3, Math.ceil(fs * 0.001) + 2)
    this.historyL = new Float64Array(capacity)
    this.historyR = new Float64Array(capacity)
    this.setParams({ enabled: false, amount: 0.3, cutoffHz: 700, delayMs: 0.2 })
  }

  setParams(p: CrossfeedSettings): void {
    const clamp = (x: number, lo: number, hi: number, fallback: number) =>
      Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback
    if (p.enabled !== this.enabled) this.reset()
    this.enabled = p.enabled === true
    this.gain = clamp(p.amount, 0, 1, 0.3) * 0.35
    this.pole = Math.exp(-2 * Math.PI * clamp(p.cutoffHz, 100, Math.min(3000, this.fs * 0.45), 700) / this.fs)
    this.delay = Math.max(1, Math.min(this.historyL.length - 2,
      Math.round(clamp(p.delayMs, 0, 1, 0.2) * this.fs / 1000)))
  }

  processStereo(l: AudioBuffer, r: AudioBuffer): void {
    if (!this.enabled || this.gain === 0) return
    const length = this.historyL.length
    const own = 1 / (1 + this.gain)
    for (let i = 0, n = Math.min(l.length, r.length); i < n; i++) {
      const li = l[i], ri = r[i]
      this.lowL = this.pole * this.lowL + (1 - this.pole) * li
      this.lowR = this.pole * this.lowR + (1 - this.pole) * ri
      this.historyL[this.pos] = this.lowL
      this.historyR[this.pos] = this.lowR
      const delayed = (this.pos - this.delay + length) % length
      l[i] = (li + this.gain * this.historyR[delayed]) * own
      r[i] = (ri + this.gain * this.historyL[delayed]) * own
      this.pos = (this.pos + 1) % length
    }
  }

  reset(): void {
    this.historyL.fill(0)
    this.historyR.fill(0)
    this.lowL = 0
    this.lowR = 0
    this.pos = 0
  }

  getLatencySamples(): number { return 0 }
}

