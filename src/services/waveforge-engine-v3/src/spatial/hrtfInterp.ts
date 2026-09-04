/**
 * hrtfInterp —— 球谐（Spherical Harmonics）HRTF 插值（HSE v3 空间音频）
 *
 * 规划书 §4.1：球谐插值，保证任意角度的平滑过渡（替代波 1 的最近邻网格查表）。
 * 算法：**实球谐基展开 + 最小二乘拟合**（时间域逐样本拟合）：
 *   - 阶数 L=3，共 (3+1)²=16 个实球谐基函数（Y00, Y1-1..Y11, Y2-2..Y22, Y3-3..Y33）；
 *   - 对每个样本索引 t（0..hrirLength-1），把网格各方向的 HRIR 样本值视为球面
 *     标量场 f(az_i, el_i)（i=0..N-1，N=72×14=1008）→ 最小二乘解 16 个系数：
 *        c(t) = argmin_c Σ_i ( Σ_k c_k·Y_k(az_i, el_i) − f_i(t) )²
 *     正规方程 (AᵀA)·c = Aᵀ·f，伪逆 P = (AᵀA)⁻¹·Aᵀ（16×N）一次性预计算；
 *   - 任意角度求值：算 16 个基函数在该角度的值 y_k → 每样本 out[t] = Σ_k c_k[t]·y_k，
 *     求值路径 O(16·hrirLength)（两耳 2×16×256 ≈ 8K 乘加/方向），setConfig 时调用
 *     （非热路径）；系数拟合一次性（模块级缓存，按 grid 身份/尺寸 + 阶数）。
 *
 * 拟合残差实测（KEMAR 真实网格 72×14×256，48kHz，L=3）：
 *   - 全网格平均绝对误差 ≈ 1.65% 峰值（整体量级正确）；
 *   - 逐方向最大误差（对 t 取 max）：中位数 ≈ 34% 峰值，p90 ≈ 59%，最坏 ≈ 120% 峰值
 *     （集中在高仰角 el=40° 附近方位——冲激型 HRIR 的起始沿在球面上移动极快，
 *     L=3 截断产生吉布斯振铃；这是时间域 SH 拟合的固有物理残差，非实现缺陷）。
 *   已实测 L=4（25 基）仅把最大误差从 120% 降到 113%、均值 1.65%→1.56%，
 *   收敛由冲激起始沿主导，提阶收益可忽略——故保持规划书默认 L=3（求值预算 O(16·hrirLen)）。
 *
 * 归一化约定与方位角约定（与网格一致）：
 *   - az=0 正前、az>0 右、el=0 水平、el>0 上（x=前，y=右，z=上）；
 *   - 实球谐采用标准正交基（含 Condon-Shortley 相因子，见 shBasis 注释公式）。
 *
 * 边缘行为：
 *   - az 任意值 wrap 到 [-180, 180)（基函数对 az 周期 360°，wrap 仅为文档化语义）；
 *   - el clamp 到网格仰角范围 [el[0], el[last]]（拟合仅覆盖网格仰角带）。
 *
 * 确定性：同输入同输出（全部 f64 固定顺序累加，无随机/无时间依赖）。
 * 与 Rust 侧 rust/hrtf-core/src/lib.rs 的 SH 插值逐位对齐（同基函数公式、同伪逆求法、
 * 同运算顺序）——WASM 后端数值对拍的算法基准即本模块。
 */

import type { HrtfGrid } from './types'

/** 球谐阶数 L=3（规划书 §4.1 默认；与 Rust 侧 SH_ORDER 一致） */
const SH_ORDER = 3
/** 基函数数 = (L+1)² = 16 */
const SH_BASIS_COUNT = (SH_ORDER + 1) * (SH_ORDER + 1)

// 基函数常量（表达式结构与 Rust 侧 hrtf-core/src/lib.rs 的 sh_basis 常量逐位一致）
const PI = Math.PI
const SQRT2 = Math.SQRT2
const K0 = 0.5 / Math.sqrt(PI) // Y00 归一化 √(1/4π)
const K1 = Math.sqrt(3 / (4 * PI)) // Y1m 归一化 √(3/4π)（含 √2 因子合并，见 shBasis）
const K2 = Math.sqrt(5 / (16 * PI)) // Y2,0 归一化
const K3 = Math.sqrt(7 / (16 * PI)) // Y3,0 归一化
const C21 = 3 * SQRT2 * Math.sqrt(15 / (8 * PI)) // Y2,±1 中 3·√2·K21
const C22 = 3 * SQRT2 * Math.sqrt(15 / (32 * PI)) // Y2,±2 中 3·√2·K22
const C31 = 1.5 * SQRT2 * Math.sqrt(21 / (32 * PI)) // Y3,±1 中 (3/2)·√2·K31
const C32 = 15 * SQRT2 * Math.sqrt(105 / (32 * PI)) // Y3,±2 中 15·√2·K32
const C33 = 15 * SQRT2 * Math.sqrt(35 / (64 * PI)) // Y3,±3 中 15·√2·K33

/**
 * 计算 (azDeg, elDeg) 处 16 个实球谐基函数值（写入 out[0..16]）。
 *
 * 约定：u = cos(el)（= sinθ_colat）、v = sin(el)（= cosθ_colat）、
 * ca/sa = cos/sin(az)。标准实球谐（Condon-Shortley 相因子在内）：
 *   Y1,-1 = −√2·K11·sinφ·P₁¹ = −K1·sa·u         （√2·K11 ≡ K1）
 *   Y1,0  = K1·v
 *   Y1,1  = −K1·ca·u
 *   Y2,-2 = √2·K22·sin2φ·P₂² = C22·s2·u²        （P₂² = 3u²）
 *   Y2,-1 = √2·K21·sinφ·P₂¹ = −C21·sa·v·u       （P₂¹ = −3vu）
 *   Y2,0  = K2·(3v²−1)/2
 *   Y3,-3 = √2·K33·sin3φ·P₃³ = −C33·s3·u³       （P₃³ = −15u³）
 *   Y3,-2 = √2·K32·sin2φ·P₃² = C32·s2·v·u²      （P₃² = 15vu²）
 *   Y3,-1 = √2·K31·sinφ·P₃¹ = −C31·sa·(5v²−1)·u （P₃¹ = −(3/2)(5v²−1)u）
 *   Y3,0  = K3·(5v³−3v)/2
 * 其余 (m>0) 把 sin 换 cos。表达式结构与 Rust 侧逐位一致（同运算顺序）。
 */
function shBasis(azDeg: number, elDeg: number, out: Float64Array): void {
  const phi = (azDeg * PI) / 180
  const th = (elDeg * PI) / 180
  const u = Math.cos(th)
  const v = Math.sin(th)
  const ca = Math.cos(phi)
  const sa = Math.sin(phi)
  const c2 = ca * ca - sa * sa // cos(2φ)
  const s2 = 2 * sa * ca // sin(2φ)
  const c3 = c2 * ca - s2 * sa // cos(3φ) = cos(2φ)cosφ − sin(2φ)sinφ
  const s3 = s2 * ca + c2 * sa // sin(3φ) = sin(2φ)cosφ + cos(2φ)sinφ
  const u2 = u * u
  const u3 = u2 * u
  const v2 = v * v
  const v3 = v2 * v

  out[0] = K0
  out[1] = -K1 * sa * u
  out[2] = K1 * v
  out[3] = -K1 * ca * u
  out[4] = C22 * s2 * u2
  out[5] = -C21 * sa * v * u
  out[6] = K2 * (3 * v2 - 1) * 0.5
  out[7] = -C21 * ca * v * u
  out[8] = C22 * c2 * u2
  out[9] = -C33 * s3 * u3
  out[10] = C32 * s2 * v * u2
  out[11] = -C31 * sa * (5 * v2 - 1) * u
  out[12] = K3 * (5 * v3 - 3 * v) * 0.5
  out[13] = -C31 * ca * (5 * v2 - 1) * u
  out[14] = C32 * c2 * v * u2
  out[15] = -C33 * c3 * u3
}

/**
 * 原地高斯-若尔当求逆（部分主元，n 阶方阵，行主序 f64）。
 * 步骤与 Rust 侧 invert_matrix 逐位一致：扩增 [M|I] → 逐列选主元换行 →
 * 归一化主元行 → 消去其余行 → 提取右半。确定性：同输入必同输出。
 *
 * 奇异矩阵防御（O1 审计 P1）：主元 d = aug[col*w+col] 在除零前检查
 * |d| < 1e-12 → 抛错（AᵀA 秩亏）。退化场景：网格方向数 N < 基函数数 16
 * 时（如 1×1 网格 N=1），AᵀA 必然秩亏（rank ≤ N < 16）→ 抛错而非静默
 * 产出 NaN（原实现 d=0 时 0/0=NaN 污染全矩阵 → 后续 SH 系数全 NaN →
 * 卷积输出全 NaN 静音）。阈值 1e-12 与 Rust 侧一致（f64 数值量级）。
 */
function invertGaussJordan(n: number, m: Float64Array): void {
  const w = 2 * n
  const aug = new Float64Array(n * w)
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) aug[r * w + c] = m[r * n + c]
    aug[r * w + n + r] = 1
  }
  for (let col = 0; col < n; col++) {
    // 部分主元：列 col 及以下绝对值最大行
    let piv = col
    let best = Math.abs(aug[col * w + col])
    for (let r = col + 1; r < n; r++) {
      const a = Math.abs(aug[r * w + col])
      if (a > best) {
        best = a
        piv = r
      }
    }
    if (piv !== col) {
      for (let c = 0; c < w; c++) {
        const t = aug[col * w + c]
        aug[col * w + c] = aug[piv * w + c]
        aug[piv * w + c] = t
      }
    }
    // 归一化主元行——除零前防御（O1 审计 P1）：部分主元后主元仍近 0
    // ⇒ 矩阵奇异（AᵀA 秩亏），抛错而非 0/0=NaN 污染全矩阵。
    const d = aug[col * w + col]
    if (Math.abs(d) < 1e-12) {
      throw new Error('球谐拟合：网格方向数不足/退化（AᵀA 秩亏）')
    }
    for (let c = 0; c < w; c++) aug[col * w + c] /= d
    // 消去其余行
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = aug[r * w + col]
      if (f === 0) continue
      for (let c = 0; c < w; c++) aug[r * w + c] -= f * aug[col * w + c]
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) m[r * n + c] = aug[r * w + n + c]
  }
}

/** 模块级拟合缓存内容（一次拟合，多次求值） */
interface ShFitCache {
  /** 方向数 N = azCount·elCount（伪逆第二维） */
  dirCount: number
  /** 网格尺寸指纹（防同一对象原地改尺寸后缓存失配） */
  azCount: number
  elCount: number
  hrirLength: number
  /** 伪逆 P = (AᵀA)⁻¹·Aᵀ（16×N，行主序 f64） */
  pinv: Float64Array
  /** 每耳每样本 SH 系数 c_k[t]（16×hrirLength，行主序 f64） */
  coeffsL: Float64Array
  coeffsR: Float64Array
}

/** 模块级缓存：按 grid 对象身份缓存（WeakMap，网格可被 GC） */
const fitCache = new WeakMap<HrtfGrid, ShFitCache>()

/**
 * 拟合一次网格：伪逆 + 每耳每样本 SH 系数（纯函数，确定性）。
 * 复杂度：伪逆 (AᵀA)⁻¹Aᵀ 一次（16×16 求逆 + 16×16×N 乘加），
 * 系数 2×16×N×hrirLength 乘加 ≈ 8M（一次拟合 <20ms，非热路径）。
 */
function fitShCoefficients(grid: HrtfGrid): ShFitCache {
  const azCount = grid.azimuths.length
  const elCount = grid.elevations.length
  const hrirLength = grid.hrirLength
  const nd = azCount * elCount
  const nb = SH_BASIS_COUNT

  // A：N×16（行主序 f64），每行 = 网格某方向上的 16 个基函数值
  const a = new Float64Array(nd * nb)
  const b = new Float64Array(nb)
  let d = 0
  for (let e = 0; e < elCount; e++) {
    for (let i = 0; i < azCount; i++) {
      shBasis(grid.azimuths[i], grid.elevations[e], b)
      for (let k = 0; k < nb; k++) a[d * nb + k] = b[k]
      d++
    }
  }

  // G = AᵀA（16×16）
  const g = new Float64Array(nb * nb)
  for (let k = 0; k < nb; k++) {
    for (let m = 0; m < nb; m++) {
      let s = 0
      for (let d2 = 0; d2 < nd; d2++) s += a[d2 * nb + k] * a[d2 * nb + m]
      g[k * nb + m] = s
    }
  }
  invertGaussJordan(nb, g)

  // P = G⁻¹·Aᵀ（16×N）
  const pinv = new Float64Array(nb * nd)
  for (let k = 0; k < nb; k++) {
    for (let d2 = 0; d2 < nd; d2++) {
      let s = 0
      for (let m = 0; m < nb; m++) s += g[k * nb + m] * a[d2 * nb + m]
      pinv[k * nd + d2] = s
    }
  }

  // 每耳每样本系数 c_k[t] = Σ_d P[k][d]·f(d,t)（f = 网格 HRIR 平面数组）
  const fitEar = (plane: Float32Array): Float64Array => {
    const coeffs = new Float64Array(nb * hrirLength)
    for (let k = 0; k < nb; k++) {
      for (let t = 0; t < hrirLength; t++) {
        let s = 0
        for (let d2 = 0; d2 < nd; d2++) s += pinv[k * nd + d2] * plane[d2 * hrirLength + t]
        coeffs[k * hrirLength + t] = s
      }
    }
    return coeffs
  }
  return { dirCount: nd, azCount, elCount, hrirLength, pinv, coeffsL: fitEar(grid.left), coeffsR: fitEar(grid.right) }
}

/** 取拟合缓存（命中校验尺寸，失配重拟合） */
function getShFit(grid: HrtfGrid): ShFitCache {
  const cached = fitCache.get(grid)
  if (
    cached &&
    cached.azCount === grid.azimuths.length &&
    cached.elCount === grid.elevations.length &&
    cached.hrirLength === grid.hrirLength &&
    cached.dirCount === grid.azimuths.length * grid.elevations.length
  ) {
    return cached
  }
  const fresh = fitShCoefficients(grid)
  fitCache.set(grid, fresh)
  return fresh
}

/**
 * 球谐插值：按目标方向 (azimuthDeg, elevationDeg) 写 HRIR 对到 outL/outR
 * （长度必须 = grid.hrirLength）。任意角度平滑过渡（非网格点也可求值）。
 */
export function sphericalHrtf(grid: HrtfGrid, azimuthDeg: number, elevationDeg: number, outL: Float32Array, outR: Float32Array): void {
  if (outL.length !== grid.hrirLength || outR.length !== grid.hrirLength) {
    throw new Error(`sphericalHrtf: 输出长度必须等于 hrirLength（${grid.hrirLength}），实际 L=${outL.length} R=${outR.length}`)
  }
  const cache = getShFit(grid)
  const hl = cache.hrirLength
  const nb = SH_BASIS_COUNT

  // 边缘行为：az wrap 到 [-180, 180)；el clamp 到网格仰角范围
  const azs = grid.azimuths
  const els = grid.elevations
  const az = ((((azimuthDeg + 180) % 360) + 360) % 360) - 180
  const el = Math.min(els[els.length - 1], Math.max(els[0], elevationDeg))

  const y = new Float64Array(nb)
  shBasis(az, el, y)
  const evalEar = (coeffs: Float64Array, out: Float32Array): void => {
    for (let t = 0; t < hl; t++) {
      let s = 0
      for (let k = 0; k < nb; k++) s += coeffs[k * hl + t] * y[k]
      out[t] = s // f64 → f32（与 Rust 侧同语义）
    }
  }
  evalEar(cache.coeffsL, outL)
  evalEar(cache.coeffsR, outR)
}
