import { describe, expect, it } from 'vitest'
import { CrosstalkCancellation } from '../CrosstalkCancellation'

const fs = 48_000
const delayMs = 0.25
const cutoffHz = 1_800
const amount = 0.8
const crossGain = amount * 0.65

function crossPath(input: Float32Array, delay = delayMs, cutoff = cutoffHz): Float32Array {
  const delaySamples = delay * fs / 1000
  const whole = Math.floor(delaySamples), fraction = delaySamples - whole
  const pole = Math.exp(-2 * Math.PI * cutoff / fs)
  const output = new Float32Array(input.length)
  let low = 0
  for (let i = 0; i < input.length; i++) {
    const a = input[i - whole] ?? 0
    const b = input[i - whole - 1] ?? 0
    const delayed = a + (b - a) * fraction
    low = pole * low + (1 - pole) * delayed
    output[i] = low
  }
  return output
}

function speakerModel(left: Float32Array, right: Float32Array): [Float32Array, Float32Array] {
  const crossR = crossPath(right), crossL = crossPath(left)
  return [
    Float32Array.from(left, (sample, i) => sample + crossGain * crossR[i]),
    Float32Array.from(right, (sample, i) => sample + crossGain * crossL[i]),
  ]
}

function rms(input: Float32Array, start = 8192): number {
  let sum = 0
  for (let i = start; i < input.length; i++) sum += input[i] * input[i]
  return Math.sqrt(sum / (input.length - start))
}

function cueError(actual: [Float32Array, Float32Array], expected: [Float32Array, Float32Array], start = 8192): number {
  let sum = 0
  for (let channel = 0; channel < 2; channel++) {
    for (let i = start; i < actual[channel].length; i++) {
      const difference = actual[channel][i] - expected[channel][i]
      sum += difference * difference
    }
  }
  return Math.sqrt(sum / (2 * (actual[0].length - start)))
}

function stereoLag(left: Float32Array, right: Float32Array, start = 8192, maxLag = 16): number {
  let bestLag = 0, bestCorrelation = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let cross = 0, leftEnergy = 0, rightEnergy = 0
    for (let i = start + maxLag; i < left.length - maxLag; i++) {
      const j = i + lag
      cross += left[i] * right[j]
      leftEnergy += left[i] * left[i]
      rightEnergy += right[j] * right[j]
    }
    const correlation = cross / Math.sqrt(leftEnergy * rightEnergy)
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag }
  }
  return bestLag
}

function makeCueSignal(length: number): [Float32Array, Float32Array] {
  let state = 0x12345678
  const source = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    source[i] = ((state / 0x1_0000_0000) * 2 - 1) * 0.15
  }
  const left = source
  const right = new Float32Array(length)
  const itdSamples = 7, rightGain = 0.55
  for (let i = itdSamples; i < length; i++) right[i] = left[i - itdSamples] * rightGain
  return [left, right]
}

describe('CrosstalkCancellation LCC', () => {
  it('匹配双音箱模型后，输入的 ITD 与 ILD 线索误差都显著下降', () => {
    const [sourceL, sourceR] = makeCueSignal(24_000)
    const targetItd = stereoLag(sourceL, sourceR)
    const targetIld = 20 * Math.log10(rms(sourceL) / rms(sourceR))
    const untreated = speakerModel(sourceL, sourceR)

    const processedL = sourceL.slice(), processedR = sourceR.slice()
    const processor = new CrosstalkCancellation(fs)
    processor.setParams({ enabled: true, amount, delayMs, cutoffHz })
    processor.processStereo(processedL, processedR)
    const corrected = speakerModel(processedL, processedR)

    const untreatedItdError = Math.abs(stereoLag(...untreated) - targetItd)
    const correctedItdError = Math.abs(stereoLag(...corrected) - targetItd)
    const untreatedIld = 20 * Math.log10(rms(untreated[0]) / rms(untreated[1]))
    const correctedIld = 20 * Math.log10(rms(corrected[0]) / rms(corrected[1]))
    const untreatedIldError = Math.abs(untreatedIld - targetIld)
    const correctedIldError = Math.abs(correctedIld - targetIld)

    expect(correctedItdError).toBeLessThanOrEqual(untreatedItdError)
    expect(cueError(corrected, [sourceL, sourceR])).toBeLessThan(cueError(untreated, [sourceL, sourceR]) * 0.05)
    expect(untreatedIldError).toBeGreaterThan(0.05)
    expect(correctedIldError).toBeLessThan(untreatedIldError * 0.1)
  })

  it('超额输出时使用联动峰值保护，且保持瞬时声道比值', () => {
    const left = Float32Array.from({ length: 4096 }, (_, i) => (i % 2 ? 1 : -1) * 1.6)
    const right = left.slice()
    const processor = new CrosstalkCancellation(fs)
    processor.setParams({ enabled: true, amount: 1, delayMs: 0.02, cutoffHz: 5_000 })
    processor.processStereo(left, right)

    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
    expect(Math.max(...left.map(Math.abs), ...right.map(Math.abs))).toBeLessThanOrEqual(1)
    for (let i = 0; i < left.length; i++) {
      expect(right[i]).toBeCloseTo(left[i], 6)
    }
  })

  it('停用后完全旁路，非法参数回退并保持有限稳定输出', () => {
    const inputL = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.2) * 0.1)
    const inputR = Float32Array.from(inputL, value => value * -0.4)
    const left = inputL.slice(), right = inputR.slice()
    const processor = new CrosstalkCancellation(fs)
    processor.setParams({ enabled: false, amount: Number.NaN, delayMs: Number.POSITIVE_INFINITY, cutoffHz: Number.NaN })
    processor.processStereo(left, right)
    expect(left).toEqual(inputL)
    expect(right).toEqual(inputR)

    processor.setParams({ enabled: true, amount: Number.POSITIVE_INFINITY, delayMs: Number.NaN, cutoffHz: Number.NaN })
    processor.processStereo(left, right)
    expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true)
  })
})
