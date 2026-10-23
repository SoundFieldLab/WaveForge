/**
 * PitchYin —— YIN 基频检测（自研，公开算法）
 *
 * 出处/许可：YIN（de Cheveigné & Kawahara, "YIN, a fundamental frequency estimator",
 * IEEE Trans. Speech Audio Process. 2002）为公开论文算法；本实现为独立重写。
 * 参考：research/docs/音频算法技术文档.md §10.1。
 *
 * 算法步骤（与论文一致）：
 *  1. 差分函数 d(τ) = Σ_j (x[j] − x[j+τ])²，所有 τ 共用长度为 w−τmax 的分析窗；
 *  2. CMND 累积均值归一化：d'(τ) = d(τ) / ((1/τ)·Σ_{j=1..τ} d(j))，消除高阶谐波偏置；
 *  3. 绝对阈值（默认 0.1）：找第一个低于阈值的谷点；
 *  4. 抛物线插值求亚采样精度周期 τ* ⇒ f0 = fs/τ*。
 *  搜索区间 τ∈[fs/maxHz, fs/minHz]（默认 minHz=40、maxHz=2000）。
 *
 * 关于 usePrevious："上一帧 f0 ±20% 邻域约束"需跨帧状态；本函数为无状态纯函数
 * （同输入同输出），不引入全局状态以保证确定性。参数保留用于契约兼容：
 * 调用方若需帧间平滑，可自行保存上一帧 f0 并在返回前做邻域校验。
 * 确定性：无 Math.random / Date / console；内部用 Float64Array 累加避免精度损失。
 */
export interface YinOptions {
  /** CMND 绝对阈值，默认 0.1 */
  threshold?: number
  /** 最低基频 Hz，默认 40 */
  minHz?: number
  /** 最高基频 Hz，默认 2000 */
  maxHz?: number
  /** 上一帧邻域约束（见文件头说明：无状态实现，保留参数） */
  usePrevious?: boolean
}

const TAU_MIN_DEFAULT_HZ = 2000
const TAU_MAX_DEFAULT_HZ = 40

/** 返回基频 Hz；未检出（噪声/静音/长度不足）返回 -1。 */
export function yinPitch(mono: Float32Array, fs: number, opts?: YinOptions): number {
  if (!Number.isFinite(fs) || fs <= 0) throw new Error('invalid sample rate')
  const threshold = opts?.threshold ?? 0.1
  const minHz = opts?.minHz ?? TAU_MAX_DEFAULT_HZ
  const maxHz = opts?.maxHz ?? TAU_MIN_DEFAULT_HZ
  if (!Number.isFinite(minHz) || !Number.isFinite(maxHz) || minHz <= 0 || maxHz <= 0 || minHz > maxHz ||
      !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) return -1
  // usePrevious 参数：无状态纯函数不支持跨帧约束（见文件头），引用一次避免误用告警
  if (opts?.usePrevious === true) {
    // 保持契约兼容；行为与 false 一致（确定性优先）
  }

  const w = mono.length
  // 最小可用窗长：至少覆盖两倍最大周期 + 少量余量
  const tauMax = Math.min(Math.floor(fs / minHz), Math.floor(w / 2) - 1)
  const tauMin = Math.max(2, Math.ceil(fs / maxHz))
  if (w < 32 || tauMax < tauMin || tauMax < 2) return -1

  // 静音/直流保护：能量过低直接返回 -1（避免 0/0 → NaN）
  let energy = 0
  let sum = 0
  for (let i = 0; i < w; i++) {
    const sample = mono[i]
    if (!Number.isFinite(sample)) return -1
    energy += sample * sample
    sum += sample
  }
  // 纯直流没有基频；对极低音量信号以方差（而非绝对幅度）作静音门。
  if ((energy - sum * sum / w) / w < 1e-12) return -1

  // 1) CMND 的累积均值必须包含 τ=1..τmin-1；从 τmin 起算会使
  //    第一个允许的延迟错误地固定为 1，导致高频/窄区间完全无法检测。
  const d = new Float64Array(tauMax + 1)
  const lim = w - tauMax // 所有延迟采用同一分析窗，避免大延迟因样本更少而虚假变小
  for (let tau = 1; tau <= tauMax; tau++) {
    let s = 0
    for (let j = 0; j < lim; j++) {
      const diff = mono[j] - mono[j + tau]
      s += diff * diff
    }
    d[tau] = s
  }

  // 2) CMND：d'(τ) = d(τ)·τ / cumsum(d(1..τ))
  const cmnd = new Float64Array(tauMax + 1)
  let cum = 0
  for (let tau = 1; tau <= tauMax; tau++) {
    cum += d[tau]
    cmnd[tau] = cum > 0 ? (d[tau] * tau) / cum : 1
  }

  // 3) 绝对阈值找第一个低于阈值的延迟，再顺坡下行到第一个谷底
  let tau0 = -1
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] < threshold) {
      tau0 = tau
      break
    }
  }
  if (tau0 < 0) return -1 // 无周期成分（如噪声）→ 未检出

  // YIN 取第一个低于阈值的局部谷底，而不是跨到 2τ0 的全局最低点：
  // 后者常把单音选成两倍周期（半频八度误判）。
  let best = tau0
  while (best < tauMax && cmnd[best + 1] < cmnd[best]) best++

  // 4) 抛物线插值（三点拟合求亚采样最小点）
  let delta = 0
  if (best > tauMin && best < tauMax) {
    const a = cmnd[best - 1]
    const b = cmnd[best]
    const c = cmnd[best + 1]
    const denom = a - 2 * b + c
    if (denom > 1e-12) delta = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / denom))
  }
  const f0 = fs / (best + delta)
  return Number.isFinite(f0) && f0 >= minHz && f0 <= maxHz ? f0 : -1
}