import type { AudioBuffer } from './audioBuffer'
/** 电平驱动的单段动态参数均衡：频段检测与立体声联动，固定 64 样本控制周期。 */
import { Biquad } from './biquad'

export interface DynamicEqBandSettings {
  enabled: boolean
  frequency: number
  q: number
  thresholdDb: number
  ratio: number
  maxReductionDb: number
  attackMs: number
  releaseMs: number
}

export interface DynamicEqSettings extends DynamicEqBandSettings {
  /** 2–8 个独立控制频段；省略时继续使用顶层单段参数。 */
  bands?: DynamicEqBandSettings[]
}

export class DynamicEq {
  private readonly detectorL: Biquad
  private readonly detectorR: Biquad
  private readonly filterL: Biquad
  private readonly filterR: Biquad
  private readonly fs: number
  private envelope = 0
  private gainDb = 0
  private controlCount = 0
  private threshold = -30
  private ratio = 4
  private depth = 12
  private attack = 0
  private release = 0
  private gainAttack = 0
  private gainRelease = 0
  private frequency = 1000
  private q = 1
  private enabled = false

  constructor(fs: number) {
    if (!(fs > 0) || !Number.isFinite(fs)) throw new Error('invalid sample rate')
    this.fs = fs
    this.detectorL = new Biquad('bandpass', 1000, 1, 0, fs)
    this.detectorR = new Biquad('bandpass', 1000, 1, 0, fs)
    this.filterL = new Biquad('peaking', 1000, 1, 0, fs)
    this.filterR = new Biquad('peaking', 1000, 1, 0, fs)
    this.setParams({ enabled: false, frequency: 1000, q: 1, thresholdDb: -30,
      ratio: 4, maxReductionDb: 12, attackMs: 10, releaseMs: 150 })
  }

  setParams(p: DynamicEqSettings): void {
    if (p.enabled !== this.enabled) this.reset()
    this.enabled = p.enabled === true
    const clamp = (x: number, lo: number, hi: number, fallback: number) =>
      Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback
    const frequency = clamp(p.frequency, 20, Math.min(20000, this.fs * 0.49), 1000)
    const q = clamp(p.q, 0.1, 18, 1)
    if (frequency !== this.frequency || q !== this.q) {
      this.frequency = frequency
      this.q = q
      this.detectorL.setParams('bandpass', frequency, q, 0)
      this.detectorR.setParams('bandpass', frequency, q, 0)
      this.detectorL.reset()
      this.detectorR.reset()
      this.envelope = 0
      this.filterL.setParams('peaking', frequency, q, this.gainDb)
      this.filterR.setParams('peaking', frequency, q, this.gainDb)
    }
    this.threshold = clamp(p.thresholdDb, -80, 0, -30)
    this.ratio = clamp(p.ratio, 1, 20, 4)
    this.depth = clamp(p.maxReductionDb, 0, 24, 12)
    const attackSeconds = Math.max(0.1, clamp(p.attackMs, 0.1, 500, 10)) / 1000
    const releaseSeconds = Math.max(0.1, clamp(p.releaseMs, 0.1, 3000, 150)) / 1000
    this.attack = Math.exp(-1 / (this.fs * attackSeconds))
    this.release = Math.exp(-1 / (this.fs * releaseSeconds))
    this.gainAttack = Math.exp(-64 / (this.fs * attackSeconds))
    this.gainRelease = Math.exp(-64 / (this.fs * releaseSeconds))
  }

  processStereo(l: AudioBuffer, r: AudioBuffer, sidechainL: AudioBuffer = l, sidechainR: AudioBuffer = r): void {
    if (!this.enabled) return
    const n = Math.min(l.length, r.length, sidechainL.length, sidechainR.length)
    for (let i = 0; i < n; i++) {
      const sensed = Math.max(Math.abs(this.detectorL.process(sidechainL[i])), Math.abs(this.detectorR.process(sidechainR[i])))
      const coeff = sensed > this.envelope ? this.attack : this.release
      this.envelope = coeff * this.envelope + (1 - coeff) * sensed
      if (this.controlCount++ === 63) {
        this.controlCount = 0
        const levelDb = 20 * Math.log10(Math.max(this.envelope, 1e-12))
        const target = -Math.min(this.depth, Math.max(0, levelDb - this.threshold) * (1 - 1 / this.ratio))
        const smoothing = target < this.gainDb ? this.gainAttack : this.gainRelease
        const next = this.gainDb * smoothing + target * (1 - smoothing)
        if (Math.abs(next - this.gainDb) > 0.0001) {
          this.gainDb = next
          this.filterL.setParams('peaking', this.frequency, this.q, next)
          this.filterR.setParams('peaking', this.frequency, this.q, next)
        }
      }
      l[i] = this.filterL.process(l[i])
      r[i] = this.filterR.process(r[i])
    }
  }

  getReductionDb(): number { return this.gainDb }

  reset(): void {
    this.detectorL.reset(); this.detectorR.reset()
    this.filterL.reset(); this.filterR.reset()
    this.envelope = 0
    this.gainDb = 0
    this.controlCount = 0
    this.filterL.setParams('peaking', this.frequency, this.q, 0)
    this.filterR.setParams('peaking', this.frequency, this.q, 0)
  }
}

/** 独立包络与增益状态的多段动态均衡；控制路径扩容，音频处理路径不分配。 */
export class DynamicEqBank {
  private readonly processors: DynamicEq[] = []
  private activeCount = 0
  private originalL = new Float64Array(128)
  private originalR = new Float64Array(128)

  constructor(private readonly fs: number) {
    this.processors.push(new DynamicEq(fs))
  }

  setParams(settings: DynamicEqSettings): void {
    const bands = settings.bands?.length ? settings.bands.slice(0, 8) : [settings]
    while (this.processors.length < bands.length) this.processors.push(new DynamicEq(this.fs))
    for (let index = 0; index < bands.length; index++) {
      this.processors[index].setParams({ ...bands[index], enabled: settings.enabled && bands[index].enabled })
    }
    for (let index = bands.length; index < this.activeCount; index++) this.processors[index].reset()
    this.activeCount = bands.length
  }

  processStereo(left: AudioBuffer, right: AudioBuffer): void {
    if (this.activeCount === 1) {
      this.processors[0].processStereo(left, right)
      return
    }
    const count = Math.min(left.length, right.length)
    if (this.originalL.length < count) {
      this.originalL = new Float64Array(count)
      this.originalR = new Float64Array(count)
    }
    for (let i = 0; i < count; i++) {
      this.originalL[i] = left[i]
      this.originalR[i] = right[i]
    }
    for (let index = 0; index < this.activeCount; index++) {
      this.processors[index].processStereo(left, right, this.originalL, this.originalR)
    }
  }

  getReductionDb(): number[] {
    const result: number[] = []
    for (let index = 0; index < this.activeCount; index++) result.push(this.processors[index].getReductionDb())
    return result
  }

  reset(): void {
    for (const processor of this.processors) processor.reset()
  }
}

