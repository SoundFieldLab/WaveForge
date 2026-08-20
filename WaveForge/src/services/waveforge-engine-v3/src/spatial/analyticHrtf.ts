/**
 * analyticHrtf —— 合成 HRTF 网格生成器（KEMAR 实测数据缺失时的兜底数据源）
 *
 * 模型（简化球头模型，全部确定性，无随机性、无时间依赖）：
 *  1. ITD（到达时间差，Woodworth 模型；头半径 a=0.0875m、声速 c=343m/s）：
 *        θ = |azimuth|（弧度，0°=正前方）
 *        θ ≤ 90°：ITD = (a/c)·(sinθ + θ)
 *        θ > 90°：ITD = (a/c)·(π − θ + sinθ)      ← 分半球公式
 *     近耳（同侧）不延迟；远耳（对侧）延迟 ITD 秒，按 fs 换算为样本数。
 *     90° 时 ITD 最大 ≈ (a/c)(1+π/2) ≈ 0.656ms（48kHz ≈ 31.5 样本）；
 *     180°（正后方）两侧对称，ITD = 0（ITD 模型固有的前后混淆，符合简化模型预期）。
 *  2. ILD（球头阴影）：对侧耳幅度增益 1/(1+sin²(θ/2))（0°→1.0，180°→约 −6dB），
 *     并对对侧耳 HRIR 施加一阶低通（fc = 12000·cos²(θ/2) + 150 Hz，随 θ 增大高频衰减加剧）
 *     模拟"对侧耳高频阴影"。
 *  3. HRIR 构造：带限 sinc 脉冲（理想低通冲激响应核，截止 fc=min(14000, 0.45·fs) Hz，
 *     离散峰值 2fc/fs）按 ITD 分数样本延迟（sinc 核采样即分数延迟内插），
 *     乘 Hann 窗（256 点，中心 127.5）截断，峰值后按 τ=1ms 短指数衰减整形（无噪声）；
 *     以近耳峰值归一（两耳共用同一归一因子，幅度差保留 ILD 语义）。
 *  4. 方向约定：az>0 为右侧 → 右耳为近耳（HRIR 峰值索引更小）、左耳为远耳（峰值索引更大）；
 *     az<0 反之；az=0 两耳同（右耳按"近"处理，与 az>0 约定连续）。
 *
 * 网格规格（与 SpatialBackend 契约一致，语言中立供 Rust/WASM 对拍）：
 *   azimuths：-180..175 步长 5（72 个）；elevations：-40..90 步长 10（14 个）；
 *   hrirLength：任意采样率统一 256；left/right 行主序 [elIdx·azCount + azIdx]。
 */

import type { HrtfGrid } from './types'

/** 头半径（米） */
const HEAD_RADIUS = 0.0875
/** 声速（m/s） */
const SPEED_OF_SOUND = 343
/** HRIR 长度（样本，任意采样率统一） */
const HRIR_LENGTH = 256
/** 方位角网格：-180..175 步长 5 */
const AZ_COUNT = 72
const AZ_STEP = 5
/** 仰角网格：-40..90 步长 10 */
const EL_COUNT = 14
const EL_STEP = 10
/** sinc 核截止频率上限（Hz，听感宽带） */
const SINC_FC_MAX = 14000
/** 尾部指数衰减时间常数（秒） */
const TAIL_TAU_SECONDS = 0.001

/** Woodworth ITD（秒），分半球公式（θ 为弧度，0°=正前方） */
function woodworthItdSeconds(theta: number): number {
  if (theta <= Math.PI / 2) {
    return (HEAD_RADIUS / SPEED_OF_SOUND) * (Math.sin(theta) + theta)
  }
  return (HEAD_RADIUS / SPEED_OF_SOUND) * (Math.PI - theta + Math.sin(theta))
}

/**
 * 带限 sinc 脉冲（理想低通核）：以 delaySamples 为中心的 256 点窗内采样的
 * 分数延迟脉冲（Hann 窗 + 峰值后指数衰减整形）。
 */
function buildHrir(delaySamples: number, fc: number, fs: number): Float32Array {
  const h = new Float32Array(HRIR_LENGTH)
  const tau = TAIL_TAU_SECONDS * fs
  for (let n = 0; n < HRIR_LENGTH; n++) {
    const x = n - delaySamples
    // 理想低通冲激响应 h(t)=sin(2π·fc·t)/(π·t) 的离散采样；x=0 处取极限 2fc
    let v: number
    if (x === 0) {
      v = (2 * fc) / fs
    } else {
      v = Math.sin((2 * Math.PI * fc * x) / fs) / (Math.PI * x)
    }
    // Hann 窗（中心 127.5），截断 sinc 无限长拖尾
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (HRIR_LENGTH - 1))
    h[n] = v * w
    // 尾部短指数衰减整形（峰值后，τ≈1ms）
    if (n > delaySamples) {
      h[n] *= Math.exp(-(n - delaySamples) / tau)
    }
  }
  return h
}

/** 一阶低通（就地）：y[n] = y[n−1] + a·(x[n]−y[n−1])，a = 1−exp(−2π·fc/fs) */
function onePoleLowpassInPlace(x: Float32Array, fc: number, fs: number): void {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / fs)
  let y = 0
  for (let i = 0; i < x.length; i++) {
    y += a * (x[i] - y)
    x[i] = y
  }
}

function maxAbs(x: Float32Array): number {
  let m = 0
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i])
    if (v > m) m = v
  }
  return m
}

/**
 * 生成合成 HRTF 网格（纯函数、确定性：同参数两次调用结果逐位相同）。
 * 传入采样率仅用于 ITD 样本数换算与滤波器系数；hrirLength 恒为 256。
 */
export function generateAnalyticHrtfGrid(sampleRate: number): HrtfGrid {
  const azimuths: number[] = []
  for (let a = 0; a < AZ_COUNT; a++) azimuths.push(-180 + a * AZ_STEP)
  const elevations: number[] = []
  for (let e = 0; e < EL_COUNT; e++) elevations.push(-40 + e * EL_STEP)

  const left = new Float32Array(EL_COUNT * AZ_COUNT * HRIR_LENGTH)
  const right = new Float32Array(EL_COUNT * AZ_COUNT * HRIR_LENGTH)

  // sinc 核截止频率：不超过 0.45·fs（防混叠），上限 14kHz
  const fc = Math.min(SINC_FC_MAX, 0.45 * sampleRate)
  // 近耳脉冲中心（窗中心 127.5 附近）
  const center = Math.floor(HRIR_LENGTH / 2)

  for (let elIdx = 0; elIdx < EL_COUNT; elIdx++) {
    for (let azIdx = 0; azIdx < AZ_COUNT; azIdx++) {
      const az = azimuths[azIdx]
      const theta = Math.abs(az) * (Math.PI / 180)

      // ITD（秒 → 样本数）；远耳延迟钳制在窗内（极高采样率下防出窗）
      const itdSamples = woodworthItdSeconds(theta) * sampleRate
      const farDelay = Math.min(center + itdSamples, HRIR_LENGTH - 2)

      // 对侧耳阴影：幅度 + 高频一阶低通（随 θ 增大更暗）
      const shadowGain = 1 / (1 + Math.sin(theta / 2) ** 2)
      const shadowFc = 12000 * Math.cos(theta / 2) ** 2 + 150

      // az≥0 右耳为近耳（az=0 与 az>0 约定连续）
      const nearIsRight = az >= 0

      const nearH = buildHrir(center, fc, sampleRate)
      const farH = buildHrir(farDelay, fc, sampleRate)
      // 两耳共用近耳峰值归一因子（幅度差保留 ILD 语义）
      const peakNear = maxAbs(nearH)
      const norm = peakNear > 1e-12 ? 1 / peakNear : 1
      for (let i = 0; i < HRIR_LENGTH; i++) {
        nearH[i] *= norm
        farH[i] *= norm
      }
      // 对侧耳：高频阴影低通 + 幅度衰减
      onePoleLowpassInPlace(farH, shadowFc, sampleRate)
      for (let i = 0; i < HRIR_LENGTH; i++) farH[i] *= shadowGain

      const base = (elIdx * AZ_COUNT + azIdx) * HRIR_LENGTH
      if (nearIsRight) {
        right.set(nearH, base)
        left.set(farH, base)
      } else {
        left.set(nearH, base)
        right.set(farH, base)
      }
    }
  }

  return {
    sampleRate,
    azimuths,
    elevations,
    hrirLength: HRIR_LENGTH,
    left,
    right,
  }
}
