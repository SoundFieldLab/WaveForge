// 轻量高质量音频重采样（窗函数 sinc 插值）+ s16le 转换。
// 用途：AirPlay 投送要求 44.1kHz s16le 立体声 PCM，而 AudioContext 采样率
// 通常跟随输出设备（48kHz 常见），采集流需重采样到 44.1kHz。

/** 每侧 sinc 抽头数（共 2*TAPS 个抽头）。32 阶对音乐足够。 */
const TAPS = 16
const TAP_COUNT = TAPS * 2
const FALLBACK_PHASES = 2048

function sinc(value: number): number {
  if (Math.abs(value) < 1e-9) return 1
  const x = Math.PI * value
  return Math.sin(x) / x
}

/** Blackman 窗（-TAPS..TAPS 中心为 0） */
function blackman(value: number): number {
  const x = (value + TAPS) / (2 * TAPS)
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x)
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

function exactPhaseCount(inputRate: number, outputRate: number): number | null {
  if (Number.isInteger(inputRate) && Number.isInteger(outputRate) && inputRate > 0 && outputRate > 0) {
    const phases = outputRate / greatestCommonDivisor(inputRate, outputRate)
    if (phases <= 65536) return phases
  }
  return null
}

function buildCoefficientTable(phaseCount: number, ratio: number, exactPhases: boolean): Float64Array {
  const table = new Float64Array(phaseCount * TAP_COUNT)
  for (let phase = 0; phase < phaseCount; phase += 1) {
    const fraction = exactPhases ? (phase * ratio) % 1 : phase / phaseCount
    for (let k = -TAPS + 1; k <= TAPS; k += 1) {
      const x = fraction - k
      table[phase * TAP_COUNT + k + TAPS - 1] = sinc(x) * blackman(x)
    }
  }
  return table
}

/**
 * 流式窗函数 sinc 重采样器。
 * 输入输出均为交错（interleaved）Float32Array，支持任意通道数。
 * 跨 chunk 边界保持内部历史缓冲，可连续调用。
 */
export class AudioResampler {
  private readonly ratio: number
  private readonly phaseCount: number
  private readonly exactPhases: boolean
  private readonly coefficients: Float64Array
  /** 以全局输入帧位置寻址的交错环形缓冲；按最大输入块扩容后重复使用。 */
  private ring = new Float32Array(0)
  private ringFrames = 0
  /** 累计真实输入样本数 */
  private totalInput = 0
  /** 下一块输出的起始输出帧位置（上一块的 safe 上界） */
  private outPosition = 0

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
    private readonly channels = 2,
  ) {
    this.ratio = inputRate / outputRate
    const exactPhases = exactPhaseCount(inputRate, outputRate)
    this.exactPhases = exactPhases !== null
    this.phaseCount = exactPhases ?? FALLBACK_PHASES
    this.coefficients = buildCoefficientTable(this.phaseCount, this.ratio, this.exactPhases)
  }

  get needsResample(): boolean {
    return Math.abs(this.inputRate - this.outputRate) > 0.5
  }

  reset(): void {
    this.totalInput = 0
    this.outPosition = 0
  }

  /** 处理一个交错 PCM 块，返回重采样后的交错 PCM 块（可能为空数组表示本块不足以产出一个输出样本）。 */
  process(input: Float32Array): Float32Array {
    if (!this.needsResample || this.channels < 1 || input.length === 0) return input
    const ch = this.channels
    const frameCount = input.length / ch
    if (Math.floor(frameCount) !== frameCount) {
      throw new Error('输入长度必须是通道数的整数倍（交错 PCM）')
    }

    const blockStartInput = this.totalInput
    this.ensureRingCapacity(frameCount + TAP_COUNT + 4)
    for (let i = 0; i < frameCount; i += 1) {
      const ringOffset = ((blockStartInput + i) % this.ringFrames) * ch
      const inputOffset = i * ch
      for (let c = 0; c < ch; c += 1) this.ring[ringOffset + c] = input[inputOffset + c]
    }

    this.totalInput += frameCount
    // 留右侧 TAPS+2 帧余量；每块少出的尾部帧在下一块补齐。
    const nextOut = Math.floor(Math.max(0, this.totalInput - (TAPS + 2)) / this.ratio)
    const outFrames = Math.max(0, nextOut - this.outPosition)
    const out = new Float32Array(outFrames * ch)
    // 与旧实现相同，只允许读取上一块末尾保留的 32 帧历史。
    const oldestInput = Math.max(0, blockStartInput - TAP_COUNT)

    for (let o = 0; o < outFrames; o += 1) {
      const outputPosition = this.outPosition + o
      const inputPosition = outputPosition * this.ratio
      const center = Math.floor(inputPosition)
      const coefficientOffset = this.phaseForOutput(outputPosition, inputPosition - center) * TAP_COUNT
      for (let c = 0; c < ch; c += 1) {
        let sum = 0
        for (let k = -TAPS + 1; k <= TAPS; k += 1) {
          const idx = center + k
          if (idx < oldestInput || idx >= this.totalInput) continue
          sum += this.ring[(idx % this.ringFrames) * ch + c]
            * this.coefficients[coefficientOffset + k + TAPS - 1]
        }
        out[o * ch + c] = sum
      }
    }

    this.outPosition = nextOut
    return out
  }

  private phaseForOutput(outputPosition: number, fraction: number): number {
    if (!this.exactPhases) {
      return Math.min(this.phaseCount - 1, Math.round(fraction * (this.phaseCount - 1)))
    }
    return outputPosition % this.phaseCount
  }

  private ensureRingCapacity(requiredFrames: number): void {
    if (this.ringFrames >= requiredFrames) return
    let nextFrames = 64
    while (nextFrames < requiredFrames) nextFrames *= 2
    const next = new Float32Array(nextFrames * this.channels)
    const keepFrom = Math.max(0, this.totalInput - TAP_COUNT)
    for (let frame = keepFrom; frame < this.totalInput; frame += 1) {
      const oldOffset = this.ringFrames > 0 ? (frame % this.ringFrames) * this.channels : 0
      const nextOffset = (frame % nextFrames) * this.channels
      for (let c = 0; c < this.channels; c += 1) next[nextOffset + c] = this.ring[oldOffset + c]
    }
    this.ring = next
    this.ringFrames = nextFrames
  }
}

/**
 * 交错 float32（-1..1）转 16-bit 小端 PCM。
 * 注意：渲染进程 main world（contextIsolation + 无 nodeIntegration）没有 Buffer，
 * 必须用纯 TypedArray/DataView 实现，否则每次调用抛 ReferenceError 导致投送无声。
 */
export function convertToS16Le(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i]))
    const value = sample < 0 ? sample * 0x8000 : sample * 0x7fff
    view.setInt16(i * 2, Math.round(value), true)
  }
  return out
}

/**
 * 便捷封装：交错 float32 输入 -> 目标采样率 s16le PCM。
 * 采样率相同则直接转换，否则先重采样。
 */
export function float32ToS16LePcm(
  input: Float32Array,
  inputRate: number,
  outputRate: number,
  channels = 2,
  resampler?: AudioResampler,
): Uint8Array {
  const sampler = resampler || new AudioResampler(inputRate, outputRate, channels)
  const resampled = sampler.needsResample ? sampler.process(input) : input
  return convertToS16Le(resampled)
}
