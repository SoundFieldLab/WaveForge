import { describe, it, expect, vi } from 'vitest'
import { AudioResampler, convertToS16Le, float32ToS16LePcm } from '../src/services/audioResample'

/** 生成交错立体声正弦波（左声道 sin，右声道 -sin） */
function makeSine(frequency: number, sampleRate: number, seconds: number): Float32Array {
  const frames = Math.floor(sampleRate * seconds)
  const out = new Float32Array(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    const v = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.5
    out[i * 2] = v
    out[i * 2 + 1] = -v
  }
  return out
}

/** 统计零交叉次数估算频率（输入为单声道样本序列） */
function estimateFrequency(samples: Float32Array, sampleRate: number): number {
  let crossings = 0
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings += 1
  }
  return crossings / 2 / (samples.length / sampleRate)
}

/** 取交错立体声的左声道 */
function leftChannel(interleaved: Float32Array): Float32Array {
  const frames = interleaved.length / 2
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) out[i] = interleaved[i * 2]
  return out
}

/** 优化前的直接计算实现，用于锁定分块输出和数值结果。 */
class ReferenceAudioResampler {
  private readonly ratio: number
  private tails: Float32Array[] = []
  private totalInput = 0
  private outPosition = 0

  constructor(inputRate: number, outputRate: number, private readonly channels: number) {
    this.ratio = inputRate / outputRate
  }

  process(input: Float32Array): Float32Array {
    const frameCount = input.length / this.channels
    const tailLen = this.tails.length === this.channels ? this.tails[0].length : 0
    const total = tailLen + frameCount
    const channelsData: Float32Array[] = []
    for (let c = 0; c < this.channels; c += 1) {
      const data = new Float32Array(total)
      if (tailLen > 0) data.set(this.tails[c])
      for (let i = 0; i < frameCount; i += 1) data[tailLen + i] = input[i * this.channels + c]
      channelsData.push(data)
    }

    this.totalInput += frameCount
    const nextOut = Math.floor(Math.max(0, this.totalInput - 18) / this.ratio)
    const out = new Float32Array(Math.max(0, nextOut - this.outPosition) * this.channels)
    const windowBase = this.totalInput - frameCount - tailLen
    for (let o = 0; o < out.length / this.channels; o += 1) {
      const windowPos = (this.outPosition + o) * this.ratio - windowBase
      const center = Math.floor(windowPos)
      for (let c = 0; c < this.channels; c += 1) {
        let sum = 0
        for (let k = -15; k <= 16; k += 1) {
          const idx = center + k
          if (idx < 0 || idx >= total) continue
          const x = windowPos - idx
          const sincX = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
          const wx = (x + 16) / 32
          const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * wx) + 0.08 * Math.cos(4 * Math.PI * wx)
          sum += channelsData[c][idx] * sincX * window
        }
        out[o * this.channels + c] = sum
      }
    }
    this.outPosition = nextOut
    const keep = Math.min(total, 32)
    this.tails = channelsData.map((data) => data.subarray(total - keep).slice())
    return out
  }
}

describe('AudioResampler（窗函数 sinc 重采样）', () => {
  it('采样率相同时直接透传', () => {
    const resampler = new AudioResampler(44100, 44100, 2)
    expect(resampler.needsResample).toBe(false)
    const input = new Float32Array([0.1, -0.2, 0.3, -0.4])
    expect(resampler.process(input)).toBe(input)
  })

  it('48k -> 44.1k：输出帧数按比例', () => {
    const resampler = new AudioResampler(48000, 44100, 2)
    const input = makeSine(1000, 48000, 1) // 48000 帧
    const out = resampler.process(input)
    const expected = Math.floor(48000 * (44100 / 48000))
    // 流式实现每块尾部留 TAPS+2 帧余量给下一块插值（连续流总时长正确）
    expect(out.length / 2).toBeGreaterThanOrEqual(expected - 30)
    expect(out.length / 2).toBeLessThanOrEqual(expected + 1)
  })

  it('48k -> 44.1k：1000Hz 正弦频率保持', () => {
    const resampler = new AudioResampler(48000, 44100, 2)
    const input = makeSine(1000, 48000, 2)
    const out = resampler.process(input)
    const freq = estimateFrequency(leftChannel(out), 44100)
    expect(freq).toBeGreaterThan(950)
    expect(freq).toBeLessThan(1050)
  })

  it('跨块调用保持连续（块边界无跳变）', () => {
    const resampler = new AudioResampler(48000, 44100, 2)
    const input = makeSine(440, 48000, 1)
    const half = input.length / 2
    const first = resampler.process(input.slice(0, half))
    const second = resampler.process(input.slice(half))
    const combined = new Float32Array(first.length + second.length)
    combined.set(first, 0)
    combined.set(second, first.length)
    const mono = leftChannel(combined)
    // 边界处不应出现断崖（相邻样本差 < 0.5）
    const boundaryIndex = first.length / 2
    const boundaryGap = Math.abs(mono[boundaryIndex] - mono[boundaryIndex - 1])
    expect(boundaryGap).toBeLessThan(0.5)
    // 整体频率仍正确
    const freq = estimateFrequency(mono, 44100)
    expect(freq).toBeGreaterThan(420)
    expect(freq).toBeLessThan(460)
  })

  it('跨块每块输出帧数正确（tail 重复计入导致每块只出几十帧的回归）', () => {
    const resampler = new AudioResampler(48000, 44100, 2)
    const block = makeSine(440, 48000, 0.2) // 9600 帧
    const out1 = resampler.process(block)
    const out2 = resampler.process(block)
    const out3 = resampler.process(block)
    // 每块应产出约 9600 * 44100/48000 ≈ 8819 帧（±50），而不是几十帧
    const expected = Math.floor(9600 * (44100 / 48000))
    for (const [label, out] of [['out1', out1], ['out2', out2], ['out3', out3]] as const) {
      expect(out.length / 2).toBeGreaterThanOrEqual(expected - 60)
      expect(out.length / 2).toBeLessThanOrEqual(expected + 60)
    }
  })

  it('reset 后重新开始', () => {
    const resampler = new AudioResampler(48000, 44100, 2)
    resampler.process(makeSine(1000, 48000, 0.5))
    resampler.reset()
    const out = resampler.process(makeSine(1000, 48000, 0.5))
    expect(out.length).toBeGreaterThan(0)
  })

  it('固定小块流与原始窗函数 sinc 实现逐样本一致', () => {
    const input = makeSine(997, 48000, 0.25)
    const optimized = new AudioResampler(48000, 44100, 2)
    const reference = new ReferenceAudioResampler(48000, 44100, 2)
    let offset = 0
    for (const frames of [1, 17, 128, 509, 64, 1024, 7, 333, 2048, 4096]) {
      if (offset >= input.length) break
      const end = Math.min(input.length, offset + frames * 2)
      expect(optimized.process(input.subarray(offset, end))).toEqual(reference.process(input.subarray(offset, end)))
      offset = end
    }
    if (offset < input.length) {
      expect(optimized.process(input.subarray(offset))).toEqual(reference.process(input.subarray(offset)))
    }
  })

  it('process 热路径不再计算 sin/cos 系数', () => {
    const input = makeSine(440, 48000, 0.1)
    const resampler = new AudioResampler(48000, 44100, 2)
    const sin = vi.spyOn(Math, 'sin')
    const cos = vi.spyOn(Math, 'cos')
    resampler.process(input)
    expect(sin).not.toHaveBeenCalled()
    expect(cos).not.toHaveBeenCalled()
    sin.mockRestore()
    cos.mockRestore()
  })
})

describe('convertToS16Le（float32 -> s16le）', () => {
  const readI16 = (buf: Uint8Array, offset: number) => new DataView(buf.buffer).getInt16(offset, true)

  it('字节序为小端且长度正确', () => {
    const buf = convertToS16Le(new Float32Array([0, 0]))
    expect(buf.length).toBe(4)
    expect(readI16(buf, 0)).toBe(0)
    expect(readI16(buf, 2)).toBe(0)
  })

  it('+1 映射为 0x7fff，-1 映射为 0x8000', () => {
    const buf = convertToS16Le(new Float32Array([1, -1]))
    expect(readI16(buf, 0)).toBe(0x7fff)
    expect(readI16(buf, 2)).toBe(-0x8000)
  })

  it('超出范围被钳制', () => {
    const buf = convertToS16Le(new Float32Array([1.5, -1.5]))
    expect(readI16(buf, 0)).toBe(0x7fff)
    expect(readI16(buf, 2)).toBe(-0x8000)
  })
})

describe('float32ToS16LePcm（组合封装）', () => {
  const readI16 = (buf: Uint8Array, offset: number) => new DataView(buf.buffer).getInt16(offset, true)

  it('同采样率：直接转换', () => {
    const buf = float32ToS16LePcm(new Float32Array([0.5, -0.5]), 44100, 44100, 2)
    expect(buf.length).toBe(4)
    expect(readI16(buf, 0)).toBeGreaterThan(16000)
  })

  it('48k -> 44.1k：输出为 s16le 且长度正确', () => {
    const buf = float32ToS16LePcm(makeSine(1000, 48000, 0.5), 48000, 44100, 2)
    const expectedFrames = Math.floor(48000 * 0.5 * (44100 / 48000))
    // 流式实现每块尾部留 TAPS+2 帧余量给下一块插值
    expect(buf.length / 4).toBeGreaterThanOrEqual(expectedFrames - 30)
    expect(buf.length / 4).toBeLessThanOrEqual(expectedFrames + 1)
  })
})
