/**
 * vectorKernel —— 分区卷积频域复数乘法的向量内核门面
 *
 * 出处/许可：
 *  - 纯 TypeScript 四路展开内核为本项目自研；WebAssembly SIMD128 后端见
 *    ./wasmSimdKernel.ts（自研，无第三方代码与第三方构建工具）。
 *  - 复数乘法语义固定为 outR = xr*hr - xi*hi、outI = xr*hi + xi*hr。
 *
 * 后端选择：
 *  - 默认 'auto'：WebAssembly + SIMD128 可用、且可用样本数达到阈值时走 f32x4 / f64x2
 *    原生向量内核；否则（环境不支持、或 count 太小拷贝不划算）走纯 TypeScript 路径。
 *  - 两条路径的浮点舍入完全一致（TS 侧用 Math.fround 逐步舍入匹配 f32x4），因此切换
 *    后端不改变输出样本，Convolver 的向量化/回退对比仍然逐位稳定。
 */

import {
  WASM_SIMD_THRESHOLD_SAMPLES,
  WASM_SIMD_THRESHOLD_SAMPLES_F64,
  isWasmSimdKernelAvailable,
  wasmComplexProductF32,
  wasmComplexProductF64,
} from './wasmSimdKernel'

/**
 * 复数乘法内核契约（分区卷积频域使用）。
 * process/processDouble 返回 false 表示「一个样本都没算」（n<=0），调用方需回退标量路径。
 */
export interface VectorComplexProduct {
  process(xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
    outR: Float32Array, outI: Float32Array, count: number,
    xrOffset?: number, xiOffset?: number, hrOffset?: number, hiOffset?: number): boolean
  /** 可选：Float64 工作缓冲的双精度版本（f64x2 SIMD / double TS 回退）。 */
  processDouble?(xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
    outR: Float64Array, outI: Float64Array, count: number,
    xrOffset?: number, xiOffset?: number, hrOffset?: number, hiOffset?: number): boolean
}

/** createComplexProductKernel() 的返回类型：双精度方法与后端标识总是存在。 */
export interface ComplexProductKernel extends VectorComplexProduct {
  /** 实际使用的后端（'wasm-simd' 表示 WASM 可用；极小 count 仍会走 TS 以避免拷贝开销）。 */
  readonly backend: 'wasm-simd' | 'typescript'
  processDouble(xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
    outR: Float64Array, outI: Float64Array, count: number,
    xrOffset?: number, xiOffset?: number, hrOffset?: number, hiOffset?: number): boolean
}

export interface ComplexProductKernelOptions {
  /** 'auto'（默认）自动选择；'typescript' 强制 TS（对比测试与不支持 WASM 的环境用）。 */
  backend?: 'auto' | 'typescript'
  /** 覆盖 f32 的 WASM 阈值（基准/测试用，默认 WASM_SIMD_THRESHOLD_SAMPLES）。 */
  wasmThreshold?: number
  /** 覆盖 f64 的 WASM 阈值（默认 WASM_SIMD_THRESHOLD_SAMPLES_F64）。 */
  wasmThresholdF64?: number
}

/** 与旧实现一致的可用样本数：count 与各数组剩余长度的最小值。 */
function resolveCount(count: number, xr: Float32Array | Float64Array, xrOffset: number,
  xi: Float32Array | Float64Array, xiOffset: number, hr: Float32Array | Float64Array, hrOffset: number,
  hi: Float32Array | Float64Array, hiOffset: number, outR: Float32Array | Float64Array,
  outI: Float32Array | Float64Array): number {
  return Math.min(count, xr.length - xrOffset, xi.length - xiOffset, hr.length - hrOffset,
    hi.length - hiOffset, outR.length, outI.length)
}

/**
 * 纯 TypeScript 内核：f32 四路展开 + Math.fround 逐步舍入（与 f32x4 逐位一致），
 * f64 双精度两路展开（与 f64x2 逐位一致）。用于小 count 与无 WASM 环境。
 */
export class TypeScriptComplexProductKernel implements ComplexProductKernel {
  readonly backend = 'typescript' as const

  process(xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
    outR: Float32Array, outI: Float32Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    const n = resolveCount(count, xr, xrOffset, xi, xiOffset, hr, hrOffset, hi, hiOffset, outR, outI)
    if (n <= 0) return false
    let i = 0
    for (; i + 4 <= n; i += 4) {
      const a0 = xr[xrOffset + i], a1 = xr[xrOffset + i + 1], a2 = xr[xrOffset + i + 2], a3 = xr[xrOffset + i + 3]
      const b0 = xi[xiOffset + i], b1 = xi[xiOffset + i + 1], b2 = xi[xiOffset + i + 2], b3 = xi[xiOffset + i + 3]
      const c0 = hr[hrOffset + i], c1 = hr[hrOffset + i + 1], c2 = hr[hrOffset + i + 2], c3 = hr[hrOffset + i + 3]
      const d0 = hi[hiOffset + i], d1 = hi[hiOffset + i + 1], d2 = hi[hiOffset + i + 2], d3 = hi[hiOffset + i + 3]
      outR[i] = Math.fround(Math.fround(a0 * c0) - Math.fround(b0 * d0))
      outR[i + 1] = Math.fround(Math.fround(a1 * c1) - Math.fround(b1 * d1))
      outR[i + 2] = Math.fround(Math.fround(a2 * c2) - Math.fround(b2 * d2))
      outR[i + 3] = Math.fround(Math.fround(a3 * c3) - Math.fround(b3 * d3))
      outI[i] = Math.fround(Math.fround(a0 * d0) + Math.fround(b0 * c0))
      outI[i + 1] = Math.fround(Math.fround(a1 * d1) + Math.fround(b1 * c1))
      outI[i + 2] = Math.fround(Math.fround(a2 * d2) + Math.fround(b2 * c2))
      outI[i + 3] = Math.fround(Math.fround(a3 * d3) + Math.fround(b3 * c3))
    }
    for (; i < n; i++) {
      const a = xr[xrOffset + i], b = xi[xiOffset + i], c = hr[hrOffset + i], d = hi[hiOffset + i]
      outR[i] = Math.fround(Math.fround(a * c) - Math.fround(b * d))
      outI[i] = Math.fround(Math.fround(a * d) + Math.fround(b * c))
    }
    return true
  }

  processDouble(xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
    outR: Float64Array, outI: Float64Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    const n = resolveCount(count, xr, xrOffset, xi, xiOffset, hr, hrOffset, hi, hiOffset, outR, outI)
    if (n <= 0) return false
    let i = 0
    for (; i + 2 <= n; i += 2) {
      const a0 = xr[xrOffset + i], a1 = xr[xrOffset + i + 1]
      const b0 = xi[xiOffset + i], b1 = xi[xiOffset + i + 1]
      const c0 = hr[hrOffset + i], c1 = hr[hrOffset + i + 1]
      const d0 = hi[hiOffset + i], d1 = hi[hiOffset + i + 1]
      outR[i] = a0 * c0 - b0 * d0
      outR[i + 1] = a1 * c1 - b1 * d1
      outI[i] = a0 * d0 + b0 * c0
      outI[i + 1] = a1 * d1 + b1 * c1
    }
    for (; i < n; i++) {
      const a = xr[xrOffset + i], b = xi[xiOffset + i], c = hr[hrOffset + i], d = hi[hiOffset + i]
      outR[i] = a * c - b * d
      outI[i] = a * d + b * c
    }
    return true
  }
}

/**
 * 自动后端：count 达阈值且 WASM SIMD 可用时走原生向量内核，否则回退 TS；
 * WASM 执行失败（内存 grow 异常等）时就地降级到 TS，保证音频不中断。
 */
class AutoComplexProductKernel implements ComplexProductKernel {
  readonly backend: 'wasm-simd' | 'typescript'
  private readonly typeScript = new TypeScriptComplexProductKernel()
  private readonly wasmThreshold: number
  private readonly wasmThresholdF64: number

  constructor(options?: ComplexProductKernelOptions) {
    const enabled = options?.backend !== 'typescript' && isWasmSimdKernelAvailable()
    this.backend = enabled ? 'wasm-simd' : 'typescript'
    this.wasmThreshold = Math.max(0, Math.floor(options?.wasmThreshold ?? WASM_SIMD_THRESHOLD_SAMPLES))
    this.wasmThresholdF64 = Math.max(0, Math.floor(options?.wasmThresholdF64 ?? WASM_SIMD_THRESHOLD_SAMPLES_F64))
  }

  process(xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
    outR: Float32Array, outI: Float32Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    const n = resolveCount(count, xr, xrOffset, xi, xiOffset, hr, hrOffset, hi, hiOffset, outR, outI)
    if (n <= 0) return false
    if (this.backend === 'wasm-simd' && n >= this.wasmThreshold) {
      if (wasmComplexProductF32(xr, xi, hr, hi, outR, outI, n, xrOffset, xiOffset, hrOffset, hiOffset)) return true
    }
    return this.typeScript.process(xr, xi, hr, hi, outR, outI, n, xrOffset, xiOffset, hrOffset, hiOffset)
  }

  processDouble(xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
    outR: Float64Array, outI: Float64Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    const n = resolveCount(count, xr, xrOffset, xi, xiOffset, hr, hrOffset, hi, hiOffset, outR, outI)
    if (n <= 0) return false
    if (this.backend === 'wasm-simd' && n >= this.wasmThresholdF64) {
      if (wasmComplexProductF64(xr, xi, hr, hi, outR, outI, n, xrOffset, xiOffset, hrOffset, hiOffset)) return true
    }
    return this.typeScript.processDouble(xr, xi, hr, hi, outR, outI, n, xrOffset, xiOffset, hrOffset, hiOffset)
  }
}

/**
 * 创建复数乘法内核：默认 'auto'（WASM SIMD 优先，自动回退 TS）。
 * 保留工厂函数是给 Convolver 的 float64 路径与探针/测试使用。
 */
export function createComplexProductKernel(options?: ComplexProductKernelOptions): ComplexProductKernel {
  // 强制 TS 时不需要探测 WASM（也避免在无 WASM 环境里做无用编译）
  if (options?.backend === 'typescript') return new TypeScriptComplexProductKernel()
  return new AutoComplexProductKernel(options)
}

/**
 * 历史门面：构造与方法签名与旧版纯 TS 四路展开内核 100% 兼容
 * （new UnrolledComplexProduct() / .process(...) 均不变），内部改为委托给
 * createComplexProductKernel() 自动选择后端。Convolver 无需改动即可受益。
 */
export class UnrolledComplexProduct implements ComplexProductKernel {
  private readonly kernel: ComplexProductKernel

  constructor(options?: ComplexProductKernelOptions) {
    this.kernel = createComplexProductKernel(options)
  }

  get backend(): 'wasm-simd' | 'typescript' {
    return this.kernel.backend
  }

  process(xr: Float32Array, xi: Float32Array, hr: Float32Array, hi: Float32Array,
    outR: Float32Array, outI: Float32Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    return this.kernel.process(xr, xi, hr, hi, outR, outI, count, xrOffset, xiOffset, hrOffset, hiOffset)
  }

  processDouble(xr: Float64Array, xi: Float64Array, hr: Float64Array, hi: Float64Array,
    outR: Float64Array, outI: Float64Array, count: number,
    xrOffset = 0, xiOffset = 0, hrOffset = 0, hiOffset = 0): boolean {
    return this.kernel.processDouble(xr, xi, hr, hi, outR, outI, count, xrOffset, xiOffset, hrOffset, hiOffset)
  }
}
