import type { AudioBuffer } from './audioBuffer'

export type StereoRender = (left: AudioBuffer, right: AudioBuffer, offset?: number) => void

/**
 * 效果级两阶段过渡：10ms 退至直通，在零湿声处提交最新配置，再用 10ms 淡入。
 * 结构/滤波拓扑无需在音频中途突变；连续改参合流，不延长当前退场期限。
 * 构造时预分配所有 1..128 样本视图；稳态直接调用原 DSP。
 */
export class EffectTransition {
  private readonly halfFade: number
  private readonly left = new Float64Array(128)
  private readonly right = new Float64Array(128)
  private readonly views: Array<[Float64Array, Float64Array]> = []
  private readonly left32 = new Float32Array(128)
  private readonly right32 = new Float32Array(128)
  private readonly views32: Array<[Float32Array, Float32Array]> = []
  private started = false
  private enabled = false
  private mix = 0
  private step = 0
  private remaining = 0
  private warming = 0
  private pending: (() => void) | null = null
  private wanted = false
  private latency: (() => number) | undefined

  constructor(sampleRate: number) {
    this.halfFade = Math.max(1, Math.round(sampleRate * 0.01))
    for (let n = 0; n <= 128; n++) {
      this.views.push([this.left.subarray(0, n), this.right.subarray(0, n)])
      this.views32.push([this.left32.subarray(0, n), this.right32.subarray(0, n)])
    }
  }

  /** 已提交的启用状态；配置回调可据此清理停用期间冻结的历史。 */
  isEnabled(): boolean { return this.enabled }

  configure(enabled: boolean, apply: () => void, latency?: () => number): void {
    this.wanted = enabled
    this.latency = latency
    if (!this.started) {
      apply(); this.enabled = enabled; this.mix = enabled ? 1 : 0
      return
    }
    this.pending = apply
    if (this.mix === 0) { this.commit(); return }
    // 已经退场时只换目标；不让连续 60Hz 参数把退场永远推迟。
    if (this.step >= 0 || this.remaining === 0) {
      this.remaining = this.halfFade
      this.step = -this.mix / this.remaining
    }
  }

  /** 已自行平滑的数值参数无需退场；若正等待结构切换则覆盖为最新配置。 */
  update(apply: () => void): void {
    if (this.pending) this.pending = apply
    else apply()
  }

  private commit(): void {
    const apply = this.pending
    this.pending = null
    apply?.()
    this.enabled = this.wanted
    this.warming = this.enabled ? Math.max(0, Math.ceil(this.latency?.() ?? 0)) : 0
    this.remaining = this.enabled ? this.halfFade : 0
    this.step = this.enabled ? 1 / this.halfFade : 0
    this.mix = 0
  }

  process(left: AudioBuffer, right: AudioBuffer, render: StereoRender): void {
    this.started = true
    let offset = 0
    while (offset < left.length) {
      if (this.remaining === 0 && this.warming === 0 && !this.pending) {
        if (this.enabled) {
          // 正常 EngineV3 块长 <=128；过渡在块中结束时余段用预分配视图处理。
          if (offset === 0) render(left, right)
          else this.renderPart(left, right, offset, left.length - offset, render, false)
        }
        return
      }
      let count = Math.min(128, left.length - offset)
      if (this.warming > 0) count = Math.min(count, this.warming)
      else if (this.remaining > 0) count = Math.min(count, this.remaining)
      this.renderPart(left, right, offset, count, render, true)
      offset += count
      if (this.warming === 0 && this.remaining === 0 && this.pending) this.commit()
    }
  }

  private renderPart(left: AudioBuffer, right: AudioBuffer, offset: number, count: number,
    render: StereoRender, blending: boolean): void {
    const [l, r] = left instanceof Float32Array ? this.views32[count] : this.views[count]
    for (let i = 0; i < count; i++) { l[i] = left[offset + i]; r[i] = right[offset + i] }
    render(l, r, offset)
    for (let i = 0; i < count; i++) {
      const mix = blending ? this.mix : 1
      left[offset + i] += mix * (l[i] - left[offset + i])
      right[offset + i] += mix * (r[i] - right[offset + i])
      if (this.warming > 0) this.warming--
      else if (this.remaining > 0) {
        this.mix += this.step
        if (--this.remaining === 0) this.mix = this.step < 0 ? 0 : 1
      }
    }
  }

  /** 曲目/离线复位边界：提交最新配置并结束在途过渡。 */
  reset(): void {
    this.pending?.(); this.pending = null
    this.enabled = this.wanted; this.mix = this.enabled ? 1 : 0
    this.remaining = this.warming = 0; this.step = 0; this.started = false
  }
}
