import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { BinauralConvolver } from '../BinauralConvolver'

function medianMicroseconds(operation: () => void, iterations: number): number {
  for (let i = 0; i < 300; i++) operation()
  const elapsed: number[] = []
  for (let run = 0; run < 7; run++) {
    const started = performance.now()
    for (let i = 0; i < iterations; i++) operation()
    elapsed.push((performance.now() - started) * 1000 / iterations)
  }
  return elapsed.sort((a, b) => a - b)[3]
}

// 显式启用诊断；墙钟测量只报告，不用机器速度或调度抖动决定测试是否通过。
describe.skipIf(process.env.RUN_BINAURAL_BENCH !== '1')('双耳卷积 prepared 与 128 样本回调微基准', () => {
  for (const length of [350, 1024, 2048]) it(`${length} 点完整 IR`, () => {
    const irL = Float32Array.from({ length }, (_, i) => Math.exp(-i / 90) * Math.cos(i * .21) * .2)
    const irR = Float32Array.from(irL, (_, i) => Math.exp(-i / 97) * Math.sin(i * .19 + .1) * .18)
    const initial = BinauralConvolver.prepareIR(irL, irR, 128, 512)
    const target = BinauralConvolver.prepareIR(irR, irL, 128, 512)
    const convolver = new BinauralConvolver(128, 512)
    expect(convolver.loadPreparedIR(initial)).toBe(true)
    const inputL = new Float32Array(128), inputR = new Float32Array(128)
    const fill = (separate: boolean) => {
      for (let i = 0; i < 128; i++) {
        inputL[i] = Math.sin(i * .079) * .1
        inputR[i] = separate ? Math.cos(i * .081) * .1 : inputL[i]
      }
    }
    const loadUs = medianMicroseconds(() => { convolver.loadPreparedIR(initial) }, 1000)
    const updateUs = medianMicroseconds(() => { convolver.updatePreparedIR(target) }, 1000)
    const monoProcessUs = medianMicroseconds(() => { fill(false); convolver.processStereo(inputL, inputR) }, 10000)
    const separateProcessUs = medianMicroseconds(() => { fill(true); convolver.processStereo(inputL, inputR) }, 10000)
    const movingProcessUs = medianMicroseconds(() => {
      fill(true); convolver.updatePreparedIR(target); convolver.processStereo(inputL, inputR)
    }, 2000)
    expect(inputL.every(Number.isFinite) && inputR.every(Number.isFinite)).toBe(true)
    process.stdout.write(JSON.stringify({ length, partitionSize: 128, latencySamples: 512,
      loadUs, updateUs, monoProcessUs, separateProcessUs, movingProcessUs }) + '\n')
  }, 30000)
})
