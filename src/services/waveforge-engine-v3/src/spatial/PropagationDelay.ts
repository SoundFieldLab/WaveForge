import { allocBuffer, normalizePrecision, type AudioBuffer, type Precision } from '../dsp/audioBuffer'

/**
 * 对象传播延迟：双耳共用，细小位移平滑跟随，大幅跳位以双读头淡变。
 * 可选内部精度：float64 时延迟线为 Float64Array（信号路径缓冲跟随后端精度）。
 */
export class PropagationDelay {
  private precision: Precision
  private ring: AudioBuffer
  private readonly fadeSamples: number
  private readonly jumpThreshold: number
  private pos = 0
  private current = NaN
  private target = 0
  private fadeFrom = 0
  private fadeTo = 0
  private fadeRemaining = 0
  private motionStep = 0
  private motionRemaining = 0

  constructor(private readonly sampleRate: number, precision: Precision = 'float32') {
    this.precision = normalizePrecision(precision)
    // 距离契约为 0..200m；环长按采样率计算，避免高采样率下截短远处传播时间。
    this.ring = allocBuffer(Math.ceil(sampleRate * 200 / 343) + 2, this.precision)
    this.fadeSamples = Math.max(1, Math.round(sampleRate * 0.025))
    this.jumpThreshold = sampleRate * 0.002
  }

  /** 切换延迟线精度（幂等）：重建零状态延迟线并 reset。 */
  setPrecision(p: Precision): void {
    const next = normalizePrecision(p)
    if (next === this.precision) return
    this.precision = next
    this.ring = allocBuffer(this.ring.length, next)
    this.reset()
  }

  setDistance(distance: number, radialVelocity = 0): void {
    const meters = Number.isFinite(distance) ? Math.min(200, Math.max(0, distance)) : 0
    this.target = meters * this.sampleRate / 343
    if (!Number.isFinite(this.current)) this.current = this.target
    const speed = Number.isFinite(radialVelocity) ? Math.min(342, Math.max(-342, radialVelocity)) : 0
    // 恒速声源的到达时间方程：dt_emit/dt_recv = c/(c+v)。
    // 仅向前预测 100ms，控制消息断流后停止运动，不会无限漂移。
    this.motionStep = speed / (343 + speed)
    this.motionRemaining = speed === 0 ? 0 : Math.round(this.sampleRate * 0.1)
  }

  process(buffer: AudioBuffer): void {
    for (let i = 0; i < buffer.length; i++) {
      this.ring[this.pos] = buffer[i]
      const moving = this.motionRemaining > 0
      if (moving) {
        this.motionRemaining--
        this.target = Math.min(this.ring.length - 2, Math.max(0, this.target + this.motionStep))
      }
      if (this.fadeRemaining === 0) {
        const error = this.target - this.current
        if (Math.abs(error) > this.jumpThreshold && !moving) {
          this.fadeFrom = this.current
          this.fadeTo = this.target
          this.fadeRemaining = this.fadeSamples
        } else {
          // 细小位移的读头速度变化不超过 ±2%；不在控制消息边界跳读样本。
          const maxStep = moving ? Math.max(0.02, Math.abs(this.motionStep)) : 0.02
          this.current += Math.min(maxStep, Math.max(-maxStep, error))
        }
      }
      if (this.fadeRemaining > 0) {
        const mix = 1 - this.fadeRemaining / this.fadeSamples
        buffer[i] = this.read(this.fadeFrom) * (1 - mix) + this.read(this.fadeTo) * mix
        if (--this.fadeRemaining === 0) this.current = this.fadeTo
      } else buffer[i] = this.read(this.current)
      if (++this.pos === this.ring.length) this.pos = 0
    }
  }

  private read(delay: number): number {
    let at = this.pos - delay
    if (at < 0) at += this.ring.length
    const first = Math.floor(at)
    const fraction = at - first
    const second = first + 1 === this.ring.length ? 0 : first + 1
    return this.ring[first] * (1 - fraction) + this.ring[second] * fraction
  }

  reset(): void {
    this.ring.fill(0)
    this.pos = 0
    this.current = this.target
    this.fadeRemaining = 0
    this.motionRemaining = 0
  }
}