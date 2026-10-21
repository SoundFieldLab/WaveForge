import { describe, expect, it } from 'vitest'
import {
  Convolver,
  createComplexProductKernel,
  isWasmSimdKernelAvailable,
  TypeScriptComplexProductKernel,
  UnrolledComplexProduct,
} from '../src/index'

describe('TypeScript vectorized kernel', () => {
  it('matches scalar complex products, including tail lanes', () => {
    // 门面默认 'auto'：在支持 SIMD 的环境走 WASM，在无 WASM 环境走 TS；结果必须一致
    const kernel = new UnrolledComplexProduct()
    const xr = Float32Array.from([1, 2, 3, 4, 5, 6, 7])
    const xi = Float32Array.from([2, 3, 4, 5, 6, 7, 8])
    const hr = Float32Array.from([3, 4, 5, 6, 7, 8, 9])
    const hi = Float32Array.from([4, 5, 6, 7, 8, 9, 10])
    const outR = new Float32Array(7)
    const outI = new Float32Array(7)
    expect(kernel.process(xr, xi, hr, hi, outR, outI, xr.length)).toBe(true)
    for (let i = 0; i < xr.length; i++) {
      expect(outR[i]).toBeCloseTo(xr[i] * hr[i] - xi[i] * hi[i], 5)
      expect(outI[i]).toBeCloseTo(xr[i] * hi[i] + xi[i] * hr[i], 5)
    }
  })

  it('keeps vectorized and scalar partitioned convolution aligned', () => {
    const ir = Float32Array.from([0.8, 0.2, -0.1, 0.04, 0.01])
    const input = Float32Array.from({ length: 1024 }, (_, i) => Math.sin(i * 0.07) * 0.2)
    const vectorized = new Convolver(48000, { partitionSize: 64, dePeriodize: false, vectorized: true })
    const scalar = new Convolver(48000, { partitionSize: 64, dePeriodize: false, vectorized: false })
    vectorized.loadIR(ir)
    scalar.loadIR(ir)
    const a = vectorized.process(input)
    const b = scalar.process(input)
    let maxError = 0
    for (let i = 0; i < a.length; i++) maxError = Math.max(maxError, Math.abs(a[i] - b[i]))
    expect(maxError).toBeLessThan(2e-5)
  })

  it('exposes the auto-selected backend through the legacy facade', () => {
    const auto = new UnrolledComplexProduct()
    expect(auto.backend).toBe(isWasmSimdKernelAvailable() ? 'wasm-simd' : 'typescript')
    expect(new UnrolledComplexProduct({ backend: 'typescript' }).backend).toBe('typescript')
    expect(createComplexProductKernel({ backend: 'typescript' })).toBeInstanceOf(TypeScriptComplexProductKernel)
    // 默认阈值：小 count 仍然走 TS 分支，但结果与显式 TS 内核逐位一致
    const xr = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i))
    const xi = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i))
    const hr = Float32Array.from({ length: 64 }, (_, i) => Math.sin(i * 0.5))
    const hi = Float32Array.from({ length: 64 }, (_, i) => Math.cos(i * 0.5))
    const aR = new Float32Array(64)
    const aI = new Float32Array(64)
    const bR = new Float32Array(64)
    const bI = new Float32Array(64)
    auto.process(xr, xi, hr, hi, aR, aI, 64)
    new UnrolledComplexProduct({ backend: 'typescript' }).process(xr, xi, hr, hi, bR, bI, 64)
    expect(aR).toEqual(bR)
    expect(aI).toEqual(bI)
  })

  it('provides a float64 kernel with offsets and odd tails', () => {
    const kernel = createComplexProductKernel({ backend: 'typescript' })
    const length = 19
    const xr = Float64Array.from({ length }, (_, i) => Math.sin(i) * 0.5)
    const xi = Float64Array.from({ length }, (_, i) => Math.cos(i) * 0.5)
    const hr = Float64Array.from({ length }, (_, i) => Math.sin(i * 1.3))
    const hi = Float64Array.from({ length }, (_, i) => Math.cos(i * 1.3))
    const outR = new Float64Array(length)
    const outI = new Float64Array(length)
    expect(kernel.processDouble(xr, xi, hr, hi, outR, outI, 15, 3, 2, 1, 4)).toBe(true)
    for (let i = 0; i < 15; i++) {
      expect(outR[i]).toBeCloseTo(xr[3 + i] * hr[1 + i] - xi[2 + i] * hi[4 + i], 12)
      expect(outI[i]).toBeCloseTo(xr[3 + i] * hi[4 + i] + xi[2 + i] * hr[1 + i], 12)
    }
    expect(kernel.processDouble(xr, xi, hr, hi, outR, outI, 0)).toBe(false)
  })
})
