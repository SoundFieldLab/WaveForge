import type { AudioBuffer } from '../dsp/audioBuffer'

export interface SpeakerCancellationSettings { enabled: boolean; amount: number; delayMs: number; cutoffHz: number }

/**
 * 对称双音箱 LCC 近似：yL = xL - C(yR), yR = xR - C(yL)。
 * 以已经校正的另一声道形成递归逆滤波，抵消匹配模型中的交叉声路，
 * 让双耳电平差和到达时间差尽量接近输入线索。delay/cutoff/amount 描述
 * 用户设定的对称交叉声路模型；它们不是房间测量或听音位置校准值。
 */
export class CrosstalkCancellation {
  private readonly left: Float64Array
  private readonly right: Float64Array
  private position = 0
  private lowL = 0
  private lowR = 0
  private gain = 0
  private target = 0
  private delay = 1
  private delayTarget = 1
  private pole = 0
  private readonly alpha: number
  constructor(private readonly fs: number) {
    this.left = new Float64Array(Math.ceil(fs * 0.002) + 3)
    this.right = new Float64Array(this.left.length)
    this.alpha = 1 - Math.exp(-1 / (fs * 0.02))
  }
  setParams(settings?: SpeakerCancellationSettings): void {
    const clamp = (v: number | undefined, fallback: number, lo: number, hi: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback
    // amount 映射到保守的交叉声路幅度。|C| <= 0.65 使 Neumann 逆滤波
    // 收敛；该上限同时避免强反馈下的过大差分增益。
    const next = settings?.enabled ? clamp(settings.amount, 0.4, 0, 1) * 0.65 : 0
    if (this.target === 0 && next > 0 && this.gain < 1e-8) this.reset()
    this.target = next
    this.delayTarget = clamp(settings?.delayMs, 0.25, 0.02, 1.5) * this.fs / 1000
    this.pole = Math.exp(-2 * Math.PI * clamp(settings?.cutoffHz, 1800, 200, Math.min(5000, this.fs * 0.4)) / this.fs)
  }
  processStereo(left: AudioBuffer, right: AudioBuffer): void {
    if (this.target === 0 && this.gain < 1e-8) { this.gain = 0; return }
    const length = this.left.length
    for (let i = 0; i < left.length; i++) {
      this.gain += this.alpha * (this.target - this.gain)
      this.delay += this.alpha * (this.delayTarget - this.delay)
      const whole = Math.floor(this.delay), fraction = this.delay - whole
      const a = (this.position - whole + length) % length, b = (a - 1 + length) % length
      const delayedL = this.left[a] + (this.left[b] - this.left[a]) * fraction
      const delayedR = this.right[a] + (this.right[b] - this.right[a]) * fraction
      this.lowL = this.pole * this.lowL + (1 - this.pole) * delayedL
      this.lowR = this.pole * this.lowR + (1 - this.pole) * delayedR
      const rawL = left[i] - this.gain * this.lowR, rawR = right[i] - this.gain * this.lowL
      // Linked peak guard preserves the instantaneous L/R ratio and bounds the
      // feedback state. It is inactive at normal headroom levels.
      const peak = Math.max(Math.abs(rawL), Math.abs(rawR))
      const scale = peak > 1 ? 1 / peak : 1
      const l = rawL * scale, r = rawR * scale
      this.left[this.position] = l; this.right[this.position] = r
      left[i] = l; right[i] = r
      if (++this.position === length) this.position = 0
    }
  }
  reset(): void { this.left.fill(0); this.right.fill(0); this.position = 0; this.lowL = this.lowR = 0; this.gain = 0; this.delay = this.delayTarget }
}
