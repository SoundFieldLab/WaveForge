/** 可重定向的逐样本线性渐变；第一帧使用原值，reset 收敛到最新目标。 */
export class SampleRamp {
  private value: number
  private target: number
  private increment = 0
  private remaining = 0
  private started = false
  private readonly samples: number
  constructor(sampleRate: number, initial: number, milliseconds = 20) {
    this.value = this.target = initial
    this.samples = Math.max(1, Math.round(sampleRate * milliseconds / 1000))
  }
  set(target: number): void {
    if (target === this.target) return
    this.target = target
    if (!this.started) { this.value = target; return }
    this.remaining = this.samples
    this.increment = (target - this.value) / this.remaining
  }
  next(): number {
    this.started = true
    const value = this.value
    if (this.remaining > 0) {
      this.value += this.increment
      if (--this.remaining === 0) this.value = this.target
    }
    return value
  }
  current(): number { return this.value }
  reset(): void { this.value = this.target; this.remaining = 0; this.started = false }
}
