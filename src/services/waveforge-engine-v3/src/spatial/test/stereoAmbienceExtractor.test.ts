import { describe, expect, it } from 'vitest'
import { projectAmbienceToRearFoa, StereoAmbienceExtractor } from '../StereoAmbienceExtractor'

const fs = 48000
function noise(length: number, seed: number): Float32Array {
  let state = seed
  return Float32Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state / 0x1_0000_0000 - 0.5) * 0.4
  })
}
function render(left: Float32Array, right: Float32Array, sizes = [128]) {
  const processor = new StereoAmbienceExtractor({ sampleRate: fs })
  const output = Array.from({ length: 4 }, () => new Float32Array(left.length))
  const bufferReferences = { ...processor.buffers }
  let at = 0, block = 0
  while (at < left.length) {
    const count = Math.min(sizes[block++ % sizes.length], left.length - at)
    processor.process(left.subarray(at, at + count), right.subarray(at, at + count), count)
    output[0].set(processor.buffers.left.subarray(0, count), at)
    output[1].set(processor.buffers.right.subarray(0, count), at)
    output[2].set(processor.buffers.programmeLeft.subarray(0, count), at)
    output[3].set(processor.buffers.programmeRight.subarray(0, count), at)
    at += count
  }
  expect(processor.buffers.left).toBe(bufferReferences.left)
  expect(processor.buffers.right).toBe(bufferReferences.right)
  return { output, diffuseness: processor.diffuseness }
}
function energy(input: Float32Array, start = 12000): number {
  let sum = 0
  for (let i = start; i < input.length; i++) sum += input[i] ** 2
  return sum / (input.length - start)
}

describe('流式主成分环境残差提取', () => {
  it.each([1, -1, 0, 0.35])('固定声像单一信号 L/R=%s 不凭空制造环境声', ratio => {
    const left = noise(24000, 123), right = Float32Array.from(left, v => v * ratio)
    const { output } = render(left, right)
    expect(Math.max(...output[0].map(Math.abs), ...output[1].map(Math.abs))).toBeLessThan(1e-7)
    for (let i = 0; i < left.length; i++) {
      expect(output[2][i]).toBeCloseTo(left[i], 7)
      expect(output[3][i]).toBeCloseTo(right[i], 7)
    }
  })

  it('右侧硬 pan 单源也没有环境残差', () => {
    const { output } = render(new Float32Array(24000), noise(24000, 3434))
    expect(output[0].every(v => v === 0)).toBe(true)
    expect(output[1].every(v => v === 0)).toBe(true)
  })

  it('相关程度下降时，非相干残差能量与弥散度递增', () => {
    const a = noise(48000, 1525), b = noise(48000, 7222)
    const values = [0.99, 0.8, 0.4, 0].map(correlation => {
      const right = Float32Array.from(a, (v, i) => v * correlation + b[i] * Math.sqrt(1 - correlation ** 2))
      const result = render(a, right)
      return { energy: energy(result.output[0]) + energy(result.output[1]), diffuse: result.diffuseness }
    })
    for (let i = 1; i < values.length; i++) {
      expect(values[i].energy).toBeGreaterThan(values[i - 1].energy)
      expect(values[i].diffuse).toBeGreaterThan(values[i - 1].diffuse)
    }
    expect(values[3].diffuse).toBeGreaterThan(0.8)
  })

  it('共同主节目叠加独立噪声可拆出残差，且两部分重建输入', () => {
    const source = noise(48000, 555), a = noise(48000, 737), b = noise(48000, 982)
    const left = Float32Array.from(source, (v, i) => v + a[i] * 0.3)
    const right = Float32Array.from(source, (v, i) => v + b[i] * 0.3)
    const { output } = render(left, right)
    expect(energy(output[0]) + energy(output[1])).toBeGreaterThan(1e-5)
    expect(energy(output[2]) + energy(output[3])).toBeGreaterThan(energy(output[0]) + energy(output[1]))
    for (let i = 0; i < left.length; i++) {
      expect(output[0][i] + output[2][i]).toBeCloseTo(left[i], 7)
      expect(output[1][i] + output[3][i]).toBeCloseTo(right[i], 7)
    }
  })

  it('任意调用块长一致，固定输出缓冲保持复用', () => {
    const left = noise(18000, 412), right = noise(18000, 856)
    expect(render(left, right, [1, 7, 64, 31, 128]).output).toEqual(render(left, right).output)
  })

  it('拒绝非法长度，屏蔽非有限输入，reset 恢复初始状态', () => {
    const processor = new StereoAmbienceExtractor({ sampleRate: fs })
    expect(() => processor.process(new Float32Array(129), new Float32Array(129))).toThrow()
    expect(() => new StereoAmbienceExtractor({ sampleRate: NaN })).toThrow()
    processor.process(new Float32Array([NaN, 1, Infinity, -1]), new Float32Array([0, 1, 2, -1]))
    expect(processor.buffers.left.subarray(0, 4).every(Number.isFinite)).toBe(true)
    expect(processor.buffers.programmeRight[0]).toBe(0)
    expect(processor.buffers.programmeRight[2]).toBe(0)
    processor.reset()
    expect(processor.diffuseness).toBe(0)
    const input = noise(128, 717)
    processor.process(input, input)
    expect(processor.buffers.left.every(value => Math.abs(value) < 1e-7)).toBe(true)
  })

  it('FOA 投影使用明确的水平后方双平面波假设，垂直分量始终为零', () => {
    const output = [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)] as const
    projectAmbienceToRearFoa(new Float32Array([1, 0, 1]), new Float32Array([0, 1, 1]), output, 3)
    expect(output[0][0]).toBeCloseTo(Math.SQRT1_2, 7)
    expect(output[1][0]).toBeGreaterThan(0)
    expect(output[1][1]).toBeLessThan(0)
    expect(output[1][2]).toBe(0)
    expect(output[2]).toEqual(new Float32Array(3))
    expect(output[3][2]).toBeLessThan(0)
  })
})
