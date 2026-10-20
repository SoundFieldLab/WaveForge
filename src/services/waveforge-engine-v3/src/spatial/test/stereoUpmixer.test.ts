import { describe, expect, it } from 'vitest'
import { StereoUpmixer } from '../StereoUpmixer'

describe('StereoUpmixer：矩阵立体声上混', () => {
  it('5.1 同相单声道分配到中心时从前方扣回，差分环绕静音且不标记为真实多声道', () => {
    const upmixer = new StereoUpmixer({ layout: '5.1', sampleRate: 48000, blockSize: 4 })
    const input = Float32Array.of(0.5, -0.5, 0.25, 0)

    const output = upmixer.process(input, input)

    expect(upmixer.channelOrder).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR'])
    expect(output[0][0]).toBeLessThan(input[0])
    expect(output[1][0]).toBeLessThan(input[0])
    expect(output[2]).toEqual(input)
    expectRoundTrip(upmixer, input, input)
    expect(output[4].every((sample) => sample === 0)).toBe(true)
    expect(output[5].every((sample) => sample === 0)).toBe(true)
    expect(upmixer.description.toLowerCase()).toContain('matrix-derived')
    expect(upmixer.description).toContain('not discrete multichannel')
  })

  it('反相立体声进入左右环绕而中心消隐；7.1 后环由差分矩阵派生', () => {
    const upmixer = new StereoUpmixer({ layout: '7.1', sampleRate: 48000, blockSize: 4 })
    const left = Float32Array.of(0.4, -0.2, 0.1, 0)
    const right = Float32Array.from(left, (sample) => -sample)

    const output = upmixer.process(left, right)

    expect(upmixer.channelOrder).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
    expect(output[2].every((sample) => sample === 0)).toBe(true)
    expect(output[4].some((sample) => sample !== 0)).toBe(true)
    expect(output[5].some((sample) => sample !== 0)).toBe(true)
    expect(output[6].some((sample) => sample !== 0)).toBe(true)
    expect(output[7].some((sample) => sample !== 0)).toBe(true)
  })

  it('LFE 从中心低频派生并衰减高频，分块处理保持滤波状态', () => {
    const upmixer = new StereoUpmixer({ layout: '5.1', sampleRate: 48000, blockSize: 128 })
    const low = new Float32Array(128)
    const high = new Float32Array(512)
    for (let i = 0; i < low.length; i++) {
      low[i] = Math.sin((2 * Math.PI * 60 * i) / 48000)
    }
    for (let i = 0; i < high.length; i++) {
      high[i] = Math.sin((2 * Math.PI * 1000 * i) / 48000)
    }

    const lowOut = upmixer.process(low, low)
    const lowLfeRms = rms(lowOut[3])
    const highProcessor = new StereoUpmixer({ layout: '5.1', sampleRate: 48000, blockSize: 128 })
    let highOut = highProcessor.outputChannels
    for (let offset = 0; offset < high.length; offset += 128) {
      highOut = highProcessor.process(high.subarray(offset, offset + 128), high.subarray(offset, offset + 128))
    }
    const highLfeRms = rms(highOut[3])

    expect(lowLfeRms).toBeGreaterThan(0.01)
    expect(highLfeRms).toBeLessThan(lowLfeRms * 0.2)

    const continuous = new StereoUpmixer({ layout: '5.1', sampleRate: 48000, blockSize: 128 })
    continuous.process(low, low)
    expect(continuous.process(low, low)[3].some((sample) => Math.abs(sample) > 0.01)).toBe(true)
  })

  it('输出缓冲预分配复用，异常浮点输入静音化且越界帧不污染结果', () => {
    const upmixer = new StereoUpmixer({ layout: '5.1', sampleRate: 48000, blockSize: 4 })
    const output = upmixer.outputChannels
    const first = upmixer.process(Float32Array.of(Number.NaN, Infinity, 0.5, 0.5), Float32Array.of(0.2, 0.2, -Infinity, 0.5))

    expect(first).toBe(output)
    expectRoundTrip(upmixer, Float32Array.of(0, 0, 0.5, 0.5), Float32Array.of(0.2, 0.2, 0, 0.5))
    expect(first.every((channel) => channel.every(Number.isFinite))).toBe(true)

    const short = upmixer.process(Float32Array.of(0.25), Float32Array.of(0.25))
    expect(short).toBe(output)
    expectRoundTrip(upmixer, Float32Array.of(0.25), Float32Array.of(0.25))
    expect(short.every(channel => channel.subarray(1).every(sample => sample === 0))).toBe(true)
  })

  it.each(['5.1', '7.1'] as const)('%s 单声道、反相、左右不相关噪声下混重建逐样本及总能量', layout => {
    const count = 4096
    const mono = Float32Array.from({ length: count }, (_, i) => 0.98 * Math.sin(2 * Math.PI * 60 * i / 48000))
    const anti = Float32Array.from(mono, value => -value)
    let seed = 7919
    const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) | 0; return seed / 2147483648 * 0.95 }
    const noiseL = Float32Array.from({ length: count }, noise)
    const noiseR = Float32Array.from({ length: count }, noise)
    for (const [left, right] of [[mono, mono], [mono, anti], [noiseL, noiseR]]) {
      const upmixer = new StereoUpmixer({ layout, sampleRate: 48000, blockSize: count })
      upmixer.process(left, right)
      expectRoundTrip(upmixer, left, right)
    }
  })

  it.each(['5.1', '7.1'] as const)('%s 多块与短尾块重建保留低频滤波状态，前声道无硬裁', layout => {
    const count = 1313
    // 大于常见 0dBFS 范围，确保分配/扣回本身没有削波；不假设上游先限幅。
    const left = Float32Array.from({ length: count }, (_, i) => 12 * Math.sin(2 * Math.PI * 47 * i / 48000))
    const right = Float32Array.from({ length: count }, (_, i) => 10 * Math.cos(2 * Math.PI * 113 * i / 48000))
    const whole = new StereoUpmixer({ layout, sampleRate: 48000, blockSize: count })
    const reference = whole.process(left, right)
    const split = new StereoUpmixer({ layout, sampleRate: 48000, blockSize: 128 })
    let inputEnergy = 0, reconstructedEnergy = 0
    let hasUnclippedFront = false
    for (let offset = 0; offset < count; offset += 128) {
      const l = left.subarray(offset, offset + 128), r = right.subarray(offset, offset + 128)
      const output = split.process(l, r)
      for (let channel = 0; channel < output.length; channel++) {
        expect(output[channel].subarray(0, l.length)).toEqual(reference[channel].subarray(offset, offset + l.length))
      }
      const reconstructed = expectRoundTrip(split, l, r)
      inputEnergy += energy(l) + energy(r)
      reconstructedEnergy += energy(reconstructed[0]) + energy(reconstructed[1])
      hasUnclippedFront ||= output[0].some(sample => Math.abs(sample) > 1)
    }
    expect(hasUnclippedFront).toBe(true)
    expect(reconstructedEnergy / inputEnergy).toBeCloseTo(1, 7)
  })
})

/** HSE 固定下混契约，按通道名定位，避免把模块7.1后环/侧环顺序混淆。 */
function expectRoundTrip(upmixer: StereoUpmixer, left: Float32Array, right: Float32Array): Float64Array[] {
  const output = upmixer.outputChannels
  const at = (name: string, i: number) => {
    const channel = upmixer.channelOrder.indexOf(name)
    return channel < 0 ? 0 : output[channel][i]
  }
  const reconstructed = [new Float64Array(left.length), new Float64Array(right.length)]
  for (let i = 0; i < left.length; i++) {
    const common = at('FC', i) * Math.SQRT1_2 + at('LFE', i) * 0.25
    reconstructed[0][i] = at('FL', i) + common + at('SL', i) * Math.SQRT1_2 + at('BL', i) * 0.5
    reconstructed[1][i] = at('FR', i) + common + at('SR', i) * Math.SQRT1_2 + at('BR', i) * 0.5
    expect(Math.abs(reconstructed[0][i] - left[i])).toBeLessThan(2e-6)
    expect(Math.abs(reconstructed[1][i] - right[i])).toBeLessThan(2e-6)
  }
  const originalEnergy = energy(left) + energy(right)
  if (originalEnergy) expect((energy(reconstructed[0]) + energy(reconstructed[1])) / originalEnergy).toBeCloseTo(1, 7)
  return reconstructed
}

function energy(buffer: Float32Array | Float64Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return sum
}

function rms(buffer: Float32Array | Float64Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i]
  return Math.sqrt(sum / buffer.length)
}
