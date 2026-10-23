import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { AmbisonicDecoder, type SpatialInputFormat } from '../AmbisonicDecoder'

// 冻结本次优化前的逐样本 decode 公式；只复用未改动的矩阵生成与状态变换。
interface DecodeState {
  activeOrder: number; started: boolean; fadePosition: number; fadeSamples: number
  views: Float32Array[][]; matrices: Float64Array[][]; fromMatrices: Float64Array[][]
  samples: Float64Array; stereoLeft: Float64Array; stereoRight: Float64Array
  fromStereoLeft: Float64Array; fromStereoRight: Float64Array
  left: Float32Array; right: Float32Array
}
const formatOrder = { ambix: 1, ambix1: 1, ambix2: 2, ambix3: 3, fuma: 1 } as const
const fumaToAcn = [0, 3, 1, 2]
class FrozenDecoder extends AmbisonicDecoder {
  override decode(inputs: readonly Float32Array[], offset: number, count: number, format: SpatialInputFormat): void {
    const state = this as unknown as DecodeState
    if (format === 'channels') throw new TypeError('explicit format required')
    const order = formatOrder[format], expected = (order + 1) ** 2
    state.activeOrder = order
    const output = state.views[order], matrix = state.matrices[order], fromMatrix = state.fromMatrices[order]
    if (count > 0) state.started = true
    for (let i = 0; i < count; i++) {
      if (state.fadePosition < state.fadeSamples) state.fadePosition++
      const mix = state.fadePosition / state.fadeSamples
      const fading = mix < 1
      for (let channel = 0; channel < expected; channel++) {
        const acn = format === 'fuma' ? fumaToAcn[channel] : channel
        const sample = inputs[channel][offset + i]
        state.samples[acn] = Number.isFinite(sample) ? sample * (format === 'fuma' && channel === 0 ? Math.SQRT2 : 1) : 0
      }
      let left = 0, right = 0
      for (let channel = 0; channel < expected; channel++) {
        const l = fading ? state.fromStereoLeft[channel] + mix * (state.stereoLeft[channel] - state.fromStereoLeft[channel]) : state.stereoLeft[channel]
        const r = fading ? state.fromStereoRight[channel] + mix * (state.stereoRight[channel] - state.fromStereoRight[channel]) : state.stereoRight[channel]
        left += state.samples[channel] * l; right += state.samples[channel] * r
      }
      state.left[i] = left; state.right[i] = right
      for (let speaker = 0; speaker < output.length; speaker++) {
        let value = 0
        for (let channel = 0; channel < expected; channel++) {
          const coefficient = fading ? fromMatrix[speaker][channel] + mix * (matrix[speaker][channel] - fromMatrix[speaker][channel]) : matrix[speaker][channel]
          value += state.samples[channel] * coefficient
        }
        output[speaker][i] = value
      }
    }
  }
}
function inputPlanes(channels: number): Float32Array[] {
  let state = 0x7afe1234
  return Array.from({ length: channels }, () => Float32Array.from({ length: 400 }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return (state / 0x80000000 - 1) * 0.2
  }))
}
function compare(actual: AmbisonicDecoder, frozen: AmbisonicDecoder): void {
  expect(Buffer.from(actual.left.buffer).equals(Buffer.from(frozen.left.buffer))).toBe(true)
  expect(Buffer.from(actual.right.buffer).equals(Buffer.from(frozen.right.buffer))).toBe(true)
  expect(actual.channels.length).toBe(frozen.channels.length)
  actual.channels.forEach((plane, channel) => {
    expect(Buffer.from(plane.buffer).equals(Buffer.from(frozen.channels[channel].buffer))).toBe(true)
  })
}
describe('HOA steady decode preserves the frozen sample arithmetic', () => {
  it.each(['ambix', 'ambix1', 'ambix2', 'ambix3', 'fuma'] as const)('%s is bit exact through offsets, nonfinite input, fades and reset', format => {
    for (const sampleRate of [44100, 48000, 96000, 192000]) {
      const actual = new AmbisonicDecoder(sampleRate), frozen = new FrozenDecoder(sampleRate)
      const inputs = inputPlanes((formatOrder[format] + 1) ** 2)
      inputs[0][16] = NaN; inputs[1][45] = Infinity; inputs[2][90] = -Infinity; inputs[3][31] = -0
      for (let block = 0; block < 75; block++) {
        if ([2, 3, 5, 24, 25, 46].includes(block)) {
          const transform = { yawDeg: block * 17, pitchDeg: -block * 1.3, rollDeg: block * 2.1,
            orderGains: [0.8, -0.9, 1.3, 0.5] }
          actual.setTransform(transform); frozen.setTransform(transform)
        }
        if (block === 47) { actual.reset(); frozen.reset() }
        const count = [128, 0, 1, 37, 119, 73][block % 6]
        const offset = block % 59
        actual.decode(inputs, offset, count, format); frozen.decode(inputs, offset, count, format)
        compare(actual, frozen)
      }
    }
  })
  it('keeps the old effective matrix when switching format during a fade', () => {
    const actual = new AmbisonicDecoder(48000), frozen = new FrozenDecoder(48000)
    const formats = ['ambix3', 'fuma', 'ambix2', 'ambix', 'ambix3'] as const
    for (let block = 0; block < 40; block++) {
      const format = formats[block % formats.length], inputs = inputPlanes((formatOrder[format] + 1) ** 2)
      if (block % 3 === 0) {
        actual.setTransform({ yawDeg: block * 13, pitchDeg: block * 2 })
        frozen.setTransform({ yawDeg: block * 13, pitchDeg: block * 2 })
      }
      actual.decode(inputs, 17, 128, format); frozen.decode(inputs, 17, 128, format)
      compare(actual, frozen)
    }
  })
  it.skipIf(!process.env.HSE_HOA_BENCH)('records identical-workload steady decode microbenchmarks', () => {
    const results: unknown[] = []
    for (const format of ['ambix1', 'ambix2', 'ambix3', 'fuma'] as const) {
      const inputs = inputPlanes((formatOrder[format] + 1) ** 2)
      const frozen = new FrozenDecoder(192000), current = new AmbisonicDecoder(192000)
      const run = (decoder: AmbisonicDecoder, blocks: number): number => {
        const start = performance.now()
        for (let block = 0; block < blocks; block++) decoder.decode(inputs, block % 128, 128, format)
        return (performance.now() - start) / blocks
      }
      run(frozen, 2000); run(current, 2000)
      const old: number[] = [], next: number[] = []
      for (let repeat = 0; repeat < 7; repeat++) {
        if (repeat % 2 === 0) { old.push(run(frozen, 6000)); next.push(run(current, 6000)) }
        else { next.push(run(current, 6000)); old.push(run(frozen, 6000)) }
      }
      old.sort((a,b) => a-b); next.sort((a,b) => a-b)
      results.push({ format, blocksPerTrial: 6000, trials: 7, frozenMs: old, currentMs: next, speedup: old[3] / next[3] })
      compare(current, frozen)
    }
    const path = '.verification/spatial-steady-20261019'
    mkdirSync(path, { recursive: true })
    writeFileSync(`${path}/hoa-${process.env.HSE_HOA_BENCH}.json`, JSON.stringify({ date: new Date().toISOString(), results }, null, 2))
    console.log(JSON.stringify(results))
  })
})
