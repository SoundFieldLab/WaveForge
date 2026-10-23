import { describe, expect, it, vi } from 'vitest'
import { Convolver } from '../../dsp/Convolver'
import { BinauralConvolver } from '../BinauralConvolver'

function compareWithTwoConvolvers(irLength: number, split: number[], computePartition = 512): void {
  const irL = Float32Array.from({ length: irLength }, (_, i) => Math.exp(-i / 150) * Math.sin(i * 0.23) * 0.08)
  const irR = Float32Array.from({ length: irLength }, (_, i) => Math.exp(-i / 160) * Math.cos(i * 0.19) * 0.07)
  const dual = new BinauralConvolver(computePartition, 512)
  const refL = new Convolver(48000, { partitionSize: 512, dePeriodize: false })
  const refR = new Convolver(48000, { partitionSize: 512, dePeriodize: false })
  dual.loadIR(irL, irR)
  refL.loadIR(irL)
  refR.loadIR(irR)
  const n = 4096
  const sourceL = Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(i * 0.11))
  const sourceR = sourceL.slice()
  // 首 1024 样本共源，随后右耳去相关，再恢复共源：必须保存分离前的历史。
  for (let i = 1024; i < 2048; i++) sourceR[i] = 0.2 * Math.sin((i - 3) * 0.11)
  const actualL = sourceL.slice()
  const actualR = sourceR.slice()
  const expectedL = sourceL.slice()
  const expectedR = sourceR.slice()
  const silenceL = new Float32Array(n)
  const silenceR = new Float32Array(n)
  let offset = 0
  let cursor = 0
  while (offset < n) {
    const end = Math.min(n, offset + split[cursor++ % split.length])
    dual.processStereo(actualL.subarray(offset, end), actualR.subarray(offset, end))
    refL.processStereo(expectedL.subarray(offset, end), silenceL.subarray(offset, end))
    refR.processStereo(silenceR.subarray(offset, end), expectedR.subarray(offset, end))
    offset = end
  }
  let error = 0
  for (let i = 0; i < n; i++) {
    error = Math.max(error, Math.abs(actualL[i] - expectedL[i]), Math.abs(actualR[i] - expectedR[i]))
  }
  expect(error).toBeLessThan(1e-6)
  dual.reset()
  const impulseL = new Float32Array(1024)
  const impulseR = new Float32Array(1024)
  impulseL[0] = 1
  impulseR[0] = 1
  dual.processStereo(impulseL, impulseR)
  expect(Math.max(...impulseL.subarray(0, 512))).toBe(0)
  expect(Math.max(...impulseR.subarray(0, 512))).toBe(0)
}

describe('BinauralConvolver 双耳共享输入频谱', () => {
  it('同容量 HRIR 重装不重新分配类型数组，输出与全新卷积器一致', () => {
    const first = Float32Array.from({ length: 279 }, (_, i) => 0.1 * Math.exp(-i / 80))
    const next = Float32Array.from(first, (value, i) => value * Math.cos(i * 0.12))
    const dual = new BinauralConvolver(128, 512)
    dual.loadIR(first, first, true)
    dual.processStereo(new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.1))
    let allocations = 0
    const track = <T extends typeof Float32Array | typeof Float64Array>(constructor: T): T => new Proxy(constructor, {
      construct(target, args) { allocations++; return Reflect.construct(target, args) },
    })
    vi.stubGlobal('Float32Array', track(Float32Array))
    vi.stubGlobal('Float64Array', track(Float64Array))
    try {
      dual.loadIR(next, first, true)
      expect(allocations).toBe(0)
    } finally { vi.unstubAllGlobals() }
    const reference = new BinauralConvolver(128, 512)
    reference.loadIR(next, first, true)
    const inputL = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * 0.11) * 0.2)
    const inputR = Float32Array.from(inputL, (_, i) => Math.cos(i * 0.13) * 0.1)
    const actualL = inputL.slice(), actualR = inputR.slice()
    const expectedL = inputL.slice(), expectedR = inputR.slice()
    dual.processStereo(actualL, actualR)
    reference.processStereo(expectedL, expectedR)
    expect(actualL).toEqual(expectedL)
    expect(actualR).toEqual(expectedR)
  })

  it('128 计算分区保留 512 样本输出对齐，短 HRIR 与原卷积结果一致', () => {
    compareWithTwoConvolvers(279, [128], 128)
  })
  it('短计算分区在长 IR 和不规则调用长度下保留双耳历史与 reset 语义', () => {
    compareWithTwoConvolvers(701, [1, 127, 513, 47], 128)
  })
  it('单分区在共源、分源、再共源之间与两个独立卷积器对拍', () => {
    compareWithTwoConvolvers(139, [128])
  })
  it('多分区和不规则块长下保持独立耳卷积语义', () => {
    compareWithTwoConvolvers(701, [1, 127, 513, 47])
  })
})
