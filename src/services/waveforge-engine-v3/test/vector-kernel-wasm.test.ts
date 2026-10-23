import { describe, expect, it } from 'vitest'
import {
  createComplexProductKernel,
  getComplexProductWasmModuleBytes,
  isWasmSimdKernelAvailable,
  UnrolledComplexProduct,
  WASM_SIMD_THRESHOLD_SAMPLES,
  WASM_SIMD_THRESHOLD_SAMPLES_F64,
} from '../src/index'
// 仅测试用的能力检测缓存重置钩子与视图分配诊断（不在公共出口导出）
import {
  __resetWasmKernelViewAllocationCountForTests,
  __resetWasmSimdKernelCacheForTests,
  getWasmKernelViewAllocationCount,
} from '../src/dsp/wasmSimdKernel'

// —— 参考实现（标量，独立于被测内核）——
function referenceFloat32(
  xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
  outR: Float32Array, outI: Float32Array, count: number,
  xrOffset: number, xiOffset: number, hrOffset: number, hiOffset: number,
): boolean {
  const n = Math.min(count, xr.length - xrOffset, xi.length - xiOffset, hr.length - hrOffset,
    hi.length - hiOffset, outR.length, outI.length)
  if (n <= 0) return false
  for (let i = 0; i < n; i++) {
    const a = xr[xrOffset + i], b = xi[xiOffset + i], c = hr[hrOffset + i], d = hi[hiOffset + i]
    // 逐次单精度舍入，等价于 f32x4 mul + sub/add
    outR[i] = Math.fround(Math.fround(a * c) - Math.fround(b * d))
    outI[i] = Math.fround(Math.fround(a * d) + Math.fround(b * c))
  }
  return true
}

function referenceFloat64(
  xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
  outR: Float64Array, outI: Float64Array, count: number,
  xrOffset: number, xiOffset: number, hrOffset: number, hiOffset: number,
): boolean {
  const n = Math.min(count, xr.length - xrOffset, xi.length - xiOffset, hr.length - hrOffset,
    hi.length - hiOffset, outR.length, outI.length)
  if (n <= 0) return false
  for (let i = 0; i < n; i++) {
    const a = xr[xrOffset + i], b = xi[xiOffset + i], c = hr[hrOffset + i], d = hi[hiOffset + i]
    outR[i] = a * c - b * d
    outI[i] = a * d + b * c
  }
  return true
}

/** 可复现的伪随机（xorshift32），避免测试对 Math.random 产生依赖。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

function randomFloat32(length: number, random: () => number): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = random() * 2 - 1
  return out
}

/** 8 种偏移组合（含 0 偏移、非对齐偏移、交错偏移）。 */
const OFFSET_COMBINATIONS: Array<[number, number, number, number]> = [
  [0, 0, 0, 0],
  [1, 2, 3, 4],
  [3, 0, 0, 0],
  [0, 5, 0, 0],
  [0, 0, 7, 0],
  [0, 0, 0, 11],
  [2, 4, 6, 8],
  [9, 9, 9, 9],
]

describe('WASM SIMD128 capability', () => {
  it('reports available in Node and compiles the generated module binary', () => {
    const bytes = getComplexProductWasmModuleBytes()
    // 自研模块必须能被本机 WebAssembly 编译并实例化（无 wabt/binaryen 参与）
    expect(bytes.length).toBeGreaterThan(0)
    expect(WebAssembly.validate(bytes)).toBe(true)
    expect(() => new WebAssembly.Module(bytes)).not.toThrow()
    // Node 24+ / Electron 42 均支持 SIMD128
    expect(isWasmSimdKernelAvailable()).toBe(true)
  })

  it('exposes thresholds used for the copy-versus-compute crossover', () => {
    expect(WASM_SIMD_THRESHOLD_SAMPLES).toBe(256)
    expect(WASM_SIMD_THRESHOLD_SAMPLES_F64).toBe(WASM_SIMD_THRESHOLD_SAMPLES * 2)
    expect(new UnrolledComplexProduct().backend).toBe('wasm-simd')
    expect(new UnrolledComplexProduct({ backend: 'typescript' }).backend).toBe('typescript')
  })
})

describe('WASM SIMD128 complex product', () => {
  it('matches the scalar reference for 8 offset combinations, tails and truncation', () => {
    const kernel = createComplexProductKernel({ wasmThreshold: 1, wasmThresholdF64: 1 })
    const random = makeRandom(0x1234abcd)
    const counts = [1, 2, 3, 4, 5, 6, 7, 8, 15, 16, 17, 63, 64, 65, 257, 1000, 4096]
    let comparisons = 0
    for (const count of counts) {
      for (const [xrOffset, xiOffset, hrOffset, hiOffset] of OFFSET_COMBINATIONS) {
        const length = count + 16
        const xr = randomFloat32(length, random)
        const xi = randomFloat32(length, random)
        const hr = randomFloat32(length, random)
        const hi = randomFloat32(length, random)
        const gotR = new Float32Array(length)
        const gotI = new Float32Array(length)
        const wantR = new Float32Array(length)
        const wantI = new Float32Array(length)
        expect(kernel.process(xr, xi, hr, hi, gotR, gotI, count, xrOffset, xiOffset, hrOffset, hiOffset)).toBe(true)
        expect(referenceFloat32(xr, xi, hr, hi, wantR, wantI, count, xrOffset, xiOffset, hrOffset, hiOffset)).toBe(true)
        for (let i = 0; i < length; i++) {
          // 逐样本 Float32 精确相等（含未被写入的 0 前缀区）
          if (!Object.is(gotR[i], wantR[i]) || !Object.is(gotI[i], wantI[i])) {
            throw new Error('f32 mismatch: count=' + count + ' offsets=' + [xrOffset, xiOffset, hrOffset, hiOffset].join(',') + ' index=' + i)
          }
        }
        comparisons++
      }
    }
    expect(comparisons).toBe(counts.length * OFFSET_COMBINATIONS.length)
  })

  it('truncates to the shortest available array and returns false for empty work', () => {
    const kernel = createComplexProductKernel({ wasmThreshold: 1 })
    const xr = Float32Array.from([1, 2, 3, 4, 5, 6])
    const xi = Float32Array.from([1, 1, 1, 1])
    const hr = Float32Array.from([2, 2, 2, 2, 2, 2, 2])
    const hi = Float32Array.from([0, 0, 0, 0, 0, 0])
    const outR = new Float32Array(6)
    const outI = new Float32Array(6)
    // xi 只剩 4 个可用样本 → n=4
    expect(kernel.process(xr, xi, hr, hi, outR, outI, 100)).toBe(true)
    expect(Array.from(outR.slice(0, 5))).toEqual([2, 4, 6, 8, 0])
    // outI = xr*hi + xi*hr = 0 + xi*2
    expect(Array.from(outI.slice(0, 5))).toEqual([2, 2, 2, 2, 0])
    // 偏移吃光可用长度 → n<=0
    expect(kernel.process(xr, xi, hr, hi, outR, outI, 100, 6, 0, 0, 0)).toBe(false)
    expect(kernel.process(xr, xi, hr, hi, outR, outI, 0)).toBe(false)
    expect(kernel.process(xr, xi, hr, hi, outR, outI, -8)).toBe(false)
    const empty = new Float32Array(0)
    expect(kernel.process(empty, empty, empty, empty, empty, empty, 8)).toBe(false)
  })

  it('keeps the forced TypeScript fallback bit-identical to the SIMD path', () => {
    const simdBound = createComplexProductKernel({ wasmThreshold: 1 })
    const fallback = createComplexProductKernel({ backend: 'typescript' })
    const legacyFacade = new UnrolledComplexProduct({ backend: 'typescript' })
    const random = makeRandom(0x5eed5eed)
    for (const count of [1024, 2048, 8192, 333, 77]) {
      for (const [xrOffset, xiOffset, hrOffset, hiOffset] of OFFSET_COMBINATIONS) {
        const length = count + 16
        const xr = randomFloat32(length, random)
        const xi = randomFloat32(length, random)
        const hr = randomFloat32(length, random)
        const hi = randomFloat32(length, random)
        const aR = new Float32Array(length)
        const aI = new Float32Array(length)
        const bR = new Float32Array(length)
        const bI = new Float32Array(length)
        const cR = new Float32Array(length)
        const cI = new Float32Array(length)
        simdBound.process(xr, xi, hr, hi, aR, aI, count, xrOffset, xiOffset, hrOffset, hiOffset)
        fallback.process(xr, xi, hr, hi, bR, bI, count, xrOffset, xiOffset, hrOffset, hiOffset)
        legacyFacade.process(xr, xi, hr, hi, cR, cI, count, xrOffset, xiOffset, hrOffset, hiOffset)
        expect(bR).toEqual(aR)
        expect(bI).toEqual(aI)
        expect(cR).toEqual(aR)
        expect(cI).toEqual(aI)
      }
    }
  })

  it('matches the double scalar reference on the f64x2 path', () => {
    const kernel = createComplexProductKernel({ wasmThreshold: 1, wasmThresholdF64: 1 })
    const random = makeRandom(0x0badf00d)
    for (const count of [1, 2, 3, 7, 8, 9, 128, 1025]) {
      for (const [xrOffset, xiOffset, hrOffset, hiOffset] of OFFSET_COMBINATIONS) {
        const length = count + 16
        const xr = Float64Array.from({ length }, () => random() * 2 - 1)
        const xi = Float64Array.from({ length }, () => random() * 2 - 1)
        const hr = Float64Array.from({ length }, () => random() * 2 - 1)
        const hi = Float64Array.from({ length }, () => random() * 2 - 1)
        const gotR = new Float64Array(length)
        const gotI = new Float64Array(length)
        const wantR = new Float64Array(length)
        const wantI = new Float64Array(length)
        expect(kernel.processDouble(xr, xi, hr, hi, gotR, gotI, count, xrOffset, xiOffset, hrOffset, hiOffset)).toBe(true)
        referenceFloat64(xr, xi, hr, hi, wantR, wantI, count, xrOffset, xiOffset, hrOffset, hiOffset)
        for (let i = 0; i < length; i++) {
          expect(Math.abs(gotR[i] - wantR[i])).toBeLessThanOrEqual(1e-12)
          expect(Math.abs(gotI[i] - wantI[i])).toBeLessThanOrEqual(1e-12)
        }
      }
    }
    const empty = new Float64Array(0)
    expect(kernel.processDouble(empty, empty, empty, empty, empty, empty, 4)).toBe(false)
  })

  it('falls back silently when WebAssembly is unavailable', () => {
    const original = (globalThis as Record<string, unknown>).WebAssembly
    try {
      ;(globalThis as Record<string, unknown>).WebAssembly = undefined
      // 重新探测：环境无 WASM 时应报告不可用并回退 TS（不抛异常）
      __resetWasmSimdKernelCacheForTests()
      expect(isWasmSimdKernelAvailable()).toBe(false)
      const kernel = createComplexProductKernel({ wasmThreshold: 1 })
      expect(kernel.backend).toBe('typescript')
      const xr = Float32Array.from([1, 2, 3, 4, 5])
      const xi = Float32Array.from([2, 3, 4, 5, 6])
      const hr = Float32Array.from([3, 4, 5, 6, 7])
      const hi = Float32Array.from([4, 5, 6, 7, 8])
      const outR = new Float32Array(5)
      const outI = new Float32Array(5)
      expect(kernel.process(xr, xi, hr, hi, outR, outI, 5)).toBe(true)
      const wantR = new Float32Array(5)
      const wantI = new Float32Array(5)
      referenceFloat32(xr, xi, hr, hi, wantR, wantI, 5, 0, 0, 0, 0)
      expect(outR).toEqual(wantR)
      expect(outI).toEqual(wantI)
    } finally {
      ;(globalThis as Record<string, unknown>).WebAssembly = original
      __resetWasmSimdKernelCacheForTests()
      expect(isWasmSimdKernelAvailable()).toBe(true)
    }
  })

  it('keeps copy-path view allocations flat once the views are warm', () => {
    const kernel = createComplexProductKernel({ wasmThreshold: 1 })
    const random = makeRandom(0x13572468)
    // 模拟 Convolver：同一批源数组、每分区不同偏移、输出缓冲固定
    for (const fftSize of [1024, 8192]) {
      const partitions = 18
      const length = fftSize * partitions
      const xr = randomFloat32(length, random)
      const xi = randomFloat32(length, random)
      const hr = randomFloat32(length, random)
      const hi = randomFloat32(length, random)
      const outR = new Float32Array(fftSize)
      const outI = new Float32Array(fftSize)
      __resetWasmKernelViewAllocationCountForTests()
      for (let p = 0; p < partitions; p++) {
        const offset = p * fftSize
        expect(kernel.process(xr, xi, hr, hi, outR, outI, fftSize, offset, offset, offset, offset)).toBe(true)
      }
      const warm = getWasmKernelViewAllocationCount()
      expect(warm).toBeGreaterThan(0)
      // 预热之后连续 100 次调用（遍历所有分区偏移）不得新增任何子视图
      for (let i = 0; i < 100; i++) {
        const offset = (i % partitions) * fftSize
        kernel.process(xr, xi, hr, hi, outR, outI, fftSize, offset, offset, offset, offset)
      }
      expect(getWasmKernelViewAllocationCount()).toBe(warm)
    }
  })

  it('rebuilds cached heap views after a memory grow and stays sample-exact', () => {
    const kernel = createComplexProductKernel({ wasmThreshold: 1 })
    const random = makeRandom(0x2468ace0)
    // 一次超大调用：6 个分区 × 1.2MB 远超初始 64KiB，强制 memory.grow / buffer 重建
    const big = 300000
    const bigXr = randomFloat32(big, random)
    const bigXi = randomFloat32(big, random)
    const bigHr = randomFloat32(big, random)
    const bigHi = randomFloat32(big, random)
    const bigOutR = new Float32Array(big)
    const bigOutI = new Float32Array(big)
    expect(kernel.process(bigXr, bigXi, bigHr, bigHi, bigOutR, bigOutI, big)).toBe(true)
    const wantR = new Float32Array(big)
    const wantI = new Float32Array(big)
    referenceFloat32(bigXr, bigXi, bigHr, bigHi, wantR, wantI, big, 0, 0, 0, 0)
    expect(bigOutR).toEqual(wantR)
    expect(bigOutI).toEqual(wantI)

    // grow 之后输出视图缓存已清空：重建一次后再调用不再新增分配
    const count = 1024
    const xr = randomFloat32(count, random)
    const xi = randomFloat32(count, random)
    const hr = randomFloat32(count, random)
    const hi = randomFloat32(count, random)
    const outR = new Float32Array(count)
    const outI = new Float32Array(count)
    const refR = new Float32Array(count)
    const refI = new Float32Array(count)
    __resetWasmKernelViewAllocationCountForTests()
    expect(kernel.process(xr, xi, hr, hi, outR, outI, count)).toBe(true)
    referenceFloat32(xr, xi, hr, hi, refR, refI, count, 0, 0, 0, 0)
    expect(outR).toEqual(refR)
    expect(outI).toEqual(refI)
    const rebuilt = getWasmKernelViewAllocationCount()
    expect(rebuilt).toBeGreaterThan(0)
    for (let i = 0; i < 50; i++) kernel.process(xr, xi, hr, hi, outR, outI, count)
    expect(getWasmKernelViewAllocationCount()).toBe(rebuilt)
    expect(outR).toEqual(refR)
  })

  it('is not more than 2x slower than the TypeScript path at count=8192', () => {
    const count = 8192
    const random = makeRandom(0xc0ffee)
    const xr = randomFloat32(count, random)
    const xi = randomFloat32(count, random)
    const hr = randomFloat32(count, random)
    const hi = randomFloat32(count, random)
    const outR = new Float32Array(count)
    const outI = new Float32Array(count)
    const simdKernel = createComplexProductKernel({ wasmThreshold: 1 })
    const tsKernel = createComplexProductKernel({ backend: 'typescript' })
    const measure = (run: () => void): number => {
      const iterations = 600
      for (let i = 0; i < 40; i++) run() // 预热
      const samples: number[] = []
      for (let round = 0; round < 5; round++) {
        const started = process.hrtime.bigint()
        for (let i = 0; i < iterations; i++) run()
        const finished = process.hrtime.bigint()
        samples.push(Number(finished - started) / 1e6)
      }
      samples.sort((a, b) => a - b)
      return samples[Math.floor(samples.length / 2)]
    }
    const simdMs = measure(() => { simdKernel.process(xr, xi, hr, hi, outR, outI, count) })
    const tsMs = measure(() => { tsKernel.process(xr, xi, hr, hi, outR, outI, count) })
    // 宽松门槛：只要 WASM 路径没有明显更慢即可（含 6 次 memcpy 的代价）
    expect(simdMs).toBeLessThan(tsMs * 2)
    expect(Number.isFinite(simdMs) && simdMs > 0).toBe(true)
  })
})
