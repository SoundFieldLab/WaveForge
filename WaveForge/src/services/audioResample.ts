// 轻量高质量音频重采样（窗函数 sinc 插值）+ s16le 转换。
// 用途：AirPlay 投送要求 44.1kHz s16le 立体声 PCM，而 AudioContext 采样率
// 通常跟随输出设备（48kHz 常见），采集流需重采样到 44.1kHz。

/** 每侧 sinc 抽头数（共 2*TAPS 个抽头）。32 阶对音乐足够。 */
const TAPS = 16

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

/**
 * 流式窗函数 sinc 重采样器。
 * 输入输出均为交错（interleaved）Float32Array，支持任意通道数。
 * 跨 chunk 边界保持内部历史缓冲，可连续调用。
 */
export class AudioResampler {
  private readonly ratio: number
  /** 每通道上一次调用尾部保留的样本（含左右各 TAPS 的上下文，仅用于插值窗口，不参与输出位置累计） */
  private tails: Float32Array[] = []
  /** 累计真实输入样本数（不含重复计数的 tail） */
  private totalInput = 0
  /** 下一块输出的起始输出帧位置（上一块的 safe 上界） */
  private outPosition = 0

  constructor(
    private readonly inputRate: number,
    private readonly outputRate: number,
    private readonly channels = 2,
  ) {
    this.ratio = inputRate / outputRate
  }

  get needsResample(): boolean {
    return Math.abs(this.inputRate - this.outputRate) > 0.5
  }

  reset(): void {
    this.tails = []
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

    // 组装每通道插值窗口（历史尾部 + 新样本）。tail 仅提供插值上下文，
    // 输出位置严格按「真实输入流」累计推进（tail 不参与），并留右侧 TAPS+2 帧余量
    // 保证插值窗口右侧 tap 不越界；每块少出的尾部帧在下一块补齐。
    const tailLen = this.tails.length === ch ? this.tails[0].length : 0
    const total = tailLen + frameCount
    const channelsData: Float32Array[] = []
    for (let c = 0; c < ch; c += 1) {
      const buf = new Float32Array(total)
      if (tailLen > 0) buf.set(this.tails[c], 0)
      for (let i = 0; i < frameCount; i += 1) buf[tailLen + i] = input[i * ch + c]
      channelsData.push(buf)
    }

    this.totalInput += frameCount
    const nextOut = Math.floor(Math.max(0, this.totalInput - (TAPS + 2)) / this.ratio)
    const outFrames = Math.max(0, nextOut - this.outPosition)
    const out = new Float32Array(outFrames * ch)

    // 本块窗口覆盖的全局输入区间：[blockStartInput - tailLen, blockStartInput + frameCount]，
    // 窗口坐标 = 全局输入位置 - (blockStartInput - tailLen)
    const blockStartInput = this.totalInput - frameCount
    const windowBase = blockStartInput - tailLen

    for (let o = 0; o < outFrames; o += 1) {
      // 全局输入位置（float）→ 映射到本块窗口坐标
      const windowPos = (this.outPosition + o) * this.ratio - windowBase
      const center = Math.floor(windowPos)
      for (let c = 0; c < ch; c += 1) {
        const buf = channelsData[c]
        let sum = 0
        for (let k = -TAPS + 1; k <= TAPS; k += 1) {
          const idx = center + k
          if (idx < 0 || idx >= total) continue
          const x = windowPos - idx
          sum += buf[idx] * sinc(x) * blackman(x)
        }
        out[o * ch + c] = sum
      }
    }

    this.outPosition = nextOut
    // 保留尾部上下文（覆盖输入末尾前后的 TAPS 样本，供下一块插值）
    const keep = Math.min(total, TAPS * 2)
    this.tails = channelsData.map((buf) => buf.subarray(total - keep).slice())
    return out
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
