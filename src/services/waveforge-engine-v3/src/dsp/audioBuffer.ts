/** Numeric buffer accepted by the optional double precision engine path. */
export type AudioBuffer = Float32Array | Float64Array

/**
 * 内部处理精度（与 types.ts 的 InternalPrecision 同义；此文件不依赖上层类型，
 * 以免 DSP 模块反向 import 参数模型）。
 */
export type Precision = 'float32' | 'float64'

/** 精度归一化：未知/缺省值回退 float32，保证默认路径不变。 */
export function normalizePrecision(value: unknown): Precision {
  return value === 'float64' ? 'float64' : 'float32'
}

/**
 * 按精度分配同长缓冲。只允许在非实时路径（构造、loadIR/setPrecision、
 * 按需扩容）调用；逐块热路径必须复用已有缓冲，不得每次分配。
 */
export function allocBuffer(length: number, precision: Precision): AudioBuffer {
  return precision === 'float64' ? new Float64Array(length) : new Float32Array(length)
}

/** 双精度缓冲判定（非热路径使用；热路径不应做类型分支之外的分配）。 */
export function isDoubleBuffer(buffer: AudioBuffer): boolean {
  return buffer instanceof Float64Array
}
