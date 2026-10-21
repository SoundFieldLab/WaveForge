/**
 * fft.ts —— 基-2 复 FFT 与窗函数工具（自研实现）
 *
 * 出处/许可：
 *  - 蝶形分解（Cooley–Tukey 基-2 DIT）与位反转排列的算法思路参考 kissfft
 *    （Mark Borgerding，BSD-3-Clause，https://github.com/mborgerding/kissfft）；
 *  - 本文件为原创 TypeScript 实现，仅借鉴公开算法结构，未复制 kissfft 代码。
 *
 * 约定：
 *  - 纯函数、确定性：同输入同输出；无 Math.random / Date / console。
 *  - 原位处理：real/imag 直接作为工作缓冲；蝶形内部双精度累加，
 *    逆变换往返误差可达 1e-7 量级（N<=1024）。
 *  - 两种缓冲精度：real/imag 可为 Float32Array（默认信号路径）或
 *    Float64Array（float64 精度路径）。两路共用同一蝶形算法与写回顺序，
 *    Float32 路径与旧实现逐位一致；Float64 路径不再在每级蝶形写回时截断。
 *  - 零分配：twiddle 因子按 FFT 长度 N 做模块级缓存（首次调用后无堆分配；
 *    两种精度共用同一张 Float64 twiddle 表，不因精度切换重复分配）。
 */

import type { AudioBuffer } from './audioBuffer'

/** 模块级 twiddle 缓存：N → 各 stage 的 (cos θ, sin θ) 表（Float64Array，保证精度） */
const twiddleCache = new Map<number, Float64Array[]>()

/** 取 N 点 FFT 全部 stage 的 twiddle 表（θ_k = 2πk/len，仅存正向 cos/sin，逆变换取共轭） */
function getTwiddles(n: number): Float64Array[] {
  let stages = twiddleCache.get(n)
  if (stages !== undefined) return stages
  stages = []
  for (let len = 2; len <= n; len *= 2) {
    const half = len / 2
    const t = new Float64Array(half * 2)
    const step = (2 * Math.PI) / len
    for (let k = 0; k < half; k++) {
      t[2 * k] = Math.cos(step * k)
      t[2 * k + 1] = Math.sin(step * k)
    }
    stages.push(t)
  }
  twiddleCache.set(n, stages)
  return stages
}

/**
 * 原位基-2 复 FFT（Cooley–Tukey DIT，自研）。
 * real/imag 等长且为 2 的幂；inverse=true 时做逆变换并除以 N。
 * 长度非 2 的幂或两数组长度不一致时抛错。
 *
 * 精度：real/imag 可为 Float32Array 或 Float64Array。Float64 输入时蝶形
 * 结果原位写回双精度，不再每级截断 float32；Float32 输入的舍入位置与旧
 * 实现完全相同（逐位回归测试）。
 */
export function fft(real: AudioBuffer, imag: AudioBuffer, inverse: boolean): void {
  const n = real.length
  if (n !== imag.length) throw new Error('fft: real/imag length mismatch')
  // 位反转使用 32 位整数；过大长度必须显式拒绝，不能让位运算溢出后进入死循环。
  if (n === 0 || n > 0x40000000 || (n & (n - 1)) !== 0) {
    throw new Error('fft: length must be a power of two up to 2^30')
  }

  // 位反转排列：把输入按二进制位逆序重排，为后续蝶形做准备
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti
    }
  }

  const sign = inverse ? 1 : -1 // 逆变换 twiddle 取共轭（+j sin θ）
  const stages = getTwiddles(n)
  // 第一层每个分组只有一个蝶形；直接遍历相邻点，省去内层循环和重复查表。
  // 保留完整复乘（包括带符号的零），不能把它改成普通加减：
  // 有限输入在后续运算溢出时，0 × Infinity 的 NaN 语义也必须一致。
  if (n >= 2) {
    const wr = stages[0][0]
    const wi = sign * stages[0][1]
    for (let i = 0; i < n; i += 2) {
      const ur = real[i]
      const ui = imag[i]
      const vr = real[i + 1]
      const vi = imag[i + 1]
      const vrW = wr * vr - wi * vi
      const viW = wr * vi + wi * vr
      real[i] = ur + vrW
      imag[i] = ui + viW
      real[i + 1] = ur - vrW
      imag[i + 1] = ui - viW
    }
  }
  let stageIdx = 1
  for (let len = 4; len <= n; len *= 2) {
    const half = len / 2
    const t = stages[stageIdx++]
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = t[2 * k]
        const wi = sign * t[2 * k + 1]
        const ur = real[i + k]
        const ui = imag[i + k]
        const vr = real[i + k + half]
        const vi = imag[i + k + half]
        // 蝶形：u + w·v 与 u − w·v（双精度累加，写回 float32）
        const vrW = wr * vr - wi * vi
        const viW = wr * vi + wi * vr
        real[i + k] = ur + vrW
        imag[i + k] = ui + viW
        real[i + k + half] = ur - vrW
        imag[i + k + half] = ui - viW
      }
    }
  }

  if (inverse) {
    const inv = 1 / n
    for (let i = 0; i < n; i++) {
      real[i] *= inv
      imag[i] *= inv
    }
  }
}

/** 大于等于 n 的最小 2 的幂（有限 n<=1 返回 1；非有限/超出安全整数范围抛错）。 */
export function nextPow2(n: number): number {
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) throw new Error('nextPow2: invalid size')
  if (n <= 1) return 1
  // 不用 <<=：超过 2^30 时会绕回负数/0 并永远无法退出。
  // 逐次乘 2 也避免 log2 在恰好大于 2^k 的数值附近舍入到 k。
  let p = 1
  while (p < n) p *= 2
  return p
}

/** Hann 窗（对称式）：w[i] = 0.5·(1 − cos(2πi/(n−1)))，w[0]=0、中心=1、左右对称 */
export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n)
  if (n <= 1) {
    if (n === 1) w[0] = 1
    return w
  }
  const denom = n - 1
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom))
  }
  return w
}

/**
 * 由复频谱求幅度谱：|X[k]| = sqrt(re² + im²)，返回 N/2+1 个 bin（含直流与 Nyquist）。
 * 注：对实信号不做能量加倍，bin 值即该频率分量的线性幅度。
 */
export function magnitudeSpectrum(real: AudioBuffer, imag: AudioBuffer): Float32Array {
  if (real.length !== imag.length) throw new Error('fft: real/imag length mismatch')
  const half = real.length >> 1
  const out = new Float32Array(half + 1)
  for (let k = 0; k <= half; k++) {
    out[k] = Math.hypot(real[k], imag[k])
  }
  return out
}

/** 频率轴：N 点 FFT、采样率 fs，返回 N/2+1 个 bin 的中心频率（Hz） */
export function frequencyBins(n: number, fs: number): Float32Array {
  const half = n >> 1
  const out = new Float32Array(half + 1)
  for (let k = 0; k <= half; k++) {
    out[k] = (k * fs) / n
  }
  return out
}
