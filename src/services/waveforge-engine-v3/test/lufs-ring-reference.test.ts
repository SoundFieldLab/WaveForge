import { describe, expect, it } from 'vitest'
import { LufsMeter } from '../src/dsp/LufsMeter'

type OldInterpolationState = { histFull: boolean; totalSamples: number; tpKernel: Float32Array;
  truePeak: number; updateTruePeakInterp(hist: Float32Array): void }

/** 独立保存原绝对样本索引公式，核对环游标优化的每次更新。 */
function installAbsoluteIndexReference(meter: LufsMeter) {
  const state = meter as unknown as OldInterpolationState
  state.updateTruePeakInterp = function (hist: Float32Array) {
    if (!this.histFull) return
    const t = this.totalSamples - 1 - 24
    if (t < 0) return
    for (let phi = 0; phi < 4; phi++) {
      let y = 0
      for (let j = 0; j < 48; j++) y += this.tpKernel[phi * 48 + j] * hist[((t - j + 23) % 48 + 48) % 48]
      if (y < 0) y = -y
      if (y > this.truePeak) this.truePeak = y
    }
  }
}

describe('真峰值环游标与原绝对索引公式逐位对照', () => {
  it.each([48000, 96000, 192000])('%iHz任意分块、跨环边界及reset均相同', rate => {
    const actual = new LufsMeter(rate), reference = new LufsMeter(rate)
    installAbsoluteIndexReference(reference)
    let random = 32893
    for (let pass = 0; pass < 2; pass++) {
      for (let block = 0; block < 120; block++) {
        const count = [1, 13, 47, 48, 49, 128, 129][block % 7]
        const left = new Float32Array(count), right = new Float32Array(count)
        for (let i = 0; i < count; i++) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0
          left[i] = (random / 0x100000000 - .5) * 1.8
          right[i] = Math.sin((block * 128 + i) * 1.143) * .7
        }
        actual.processStereo(left, right); reference.processStereo(left, right)
        expect(actual.getTruePeakDb()).toBe(reference.getTruePeakDb())
      }
      actual.reset(); reference.reset()
    }
  })
})
