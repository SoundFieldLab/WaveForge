import { describe, expect, it } from 'vitest'
import { SubsonicHighpass } from '../src/dsp/LowFrequency'

function filteredRatio(frequency: number): number {
  const sampleRate = 48000
  const length = sampleRate * 2
  const inputL = new Float32Array(length)
  const inputR = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const sample = Math.sin((2 * Math.PI * frequency * i) / sampleRate)
    inputL[i] = sample
    inputR[i] = sample
  }
  const highpass = new SubsonicHighpass(sampleRate)
  highpass.setParams(true, 20)
  highpass.processStereo(inputL, inputR)
  let inputPower = 0
  let outputPower = 0
  for (let i = sampleRate; i < length; i++) {
    inputPower += Math.sin((2 * Math.PI * frequency * i) / sampleRate) ** 2
    outputPower += inputL[i] * inputL[i]
  }
  return Math.sqrt(outputPower / inputPower)
}

describe('SubsonicHighpass', () => {
  it('20Hz 高通抑制 5Hz 次声，同时保留 100Hz 低音', () => {
    expect(filteredRatio(5)).toBeLessThan(0.1)
    expect(filteredRatio(100)).toBeGreaterThan(0.98)
  })

  it('参数切换按 20ms 平滑，重置后仍产出有限样本', () => {
    const filter = new SubsonicHighpass(48000)
    const firstL = new Float32Array(128).fill(0.4)
    const firstR = new Float32Array(128).fill(-0.4)
    filter.setParams(true, 24)
    filter.processStereo(firstL, firstR)
    const previous = firstL[firstL.length - 1]
    filter.setParams(false, 24)
    const nextL = new Float32Array(128).fill(0.4)
    const nextR = new Float32Array(128).fill(-0.4)
    filter.processStereo(nextL, nextR)
    expect(Math.abs(nextL[0] - previous)).toBeLessThan(0.05)
    filter.reset()
    const resetL = new Float32Array(128).fill(0.2)
    const resetR = new Float32Array(128).fill(-0.2)
    filter.processStereo(resetL, resetR)
    expect(resetL.every(Number.isFinite)).toBe(true)
    expect(resetR.every(Number.isFinite)).toBe(true)
  })

  it('处理任意分块都得到相同输出', () => {
    const sampleRate = 48000
    const length = 1024
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      left[i] = Math.sin((2 * Math.PI * 17 * i) / sampleRate)
      right[i] = 0.7 * Math.sin((2 * Math.PI * 43 * i) / sampleRate)
    }
    const blockL = left.slice()
    const blockR = right.slice()
    const full = new SubsonicHighpass(sampleRate)
    const blocked = new SubsonicHighpass(sampleRate)
    full.setParams(true, 30)
    blocked.setParams(true, 30)
    full.processStereo(left, right)
    for (let offset = 0; offset < length; offset += 113) {
      const end = Math.min(length, offset + 113)
      blocked.processStereo(blockL.subarray(offset, end), blockR.subarray(offset, end))
    }
    for (let i = 0; i < length; i++) {
      expect(blockL[i]).toBeCloseTo(left[i], 6)
      expect(blockR[i]).toBeCloseTo(right[i], 6)
    }
  })
})
