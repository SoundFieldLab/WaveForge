/**
 * hrtfInterp.test.ts —— 球谐（SH）HRTF 插值（hrtfInterp.ts）单元测试
 *
 * 解码布局见 gridSource.ts 文件头注释——u32 头 + f32 数组）；缺失时整组跳过。
 *
 * 覆盖（规划书 §4.1）：
 *   ① 网格点还原：若干网格方向上 sphericalHrtf 输出与网格 HRIR 的差异。
 *     拟合非精确插值（最小二乘残差），断言取"量级"：
 *       - 平均绝对误差（对 t 取均值）< 0.10·网格峰值 —— 实测各方向 ≤ 3.0% 峰值；
 *       - 逐样本最大误差（对 t 取 max）< 1.20·网格峰值 —— 实测样本方向
 *         13.5%~89% 峰值，最坏方向（el=40° 高仰角附近）≈120% 峰值。
 *     拟合残差实测（L=3，KEMAR，48kHz）：全网格均值 1.65% 峰值、逐方向 max
 *     中位数 34% 峰值。残差来源：冲激型 HRIR 的起始沿随方位移动极快，L=3 截断
 *     产生吉布斯振铃——这是时间域 SH 拟合的固有物理残差。已实测 L=4（25 基）
 *     仅把全网格 max 120%→113%、mean 1.65%→1.56%，提阶收益可忽略，
 *     故保持规划书默认 L=3（求值预算 O(16·hrirLen)）。
 *   ② 平滑性：沿 az（el=0，基准 0°/-45°/90°）相邻角度输出的 L1 距离
 *     随角度差单调不减——实测 5°~30° 窗口严格递增；超过 ~45° 后因 ITD
 *     关于 0° 的对称性 L1 回落（如基准 -45°：60°=5.11 而 90°=4.62），
 *     故断言限定在 5°~30°。同时断言 L1(10°) < 8·√E（E = 基准方向 HRIR
 *     能量；实测 ≤ 3.1·√E，2.6× 余量）。
 *   ③ 确定性：同输入两次调用输出逐位相等。
 *   ④ wrap：az=185 ≡ -175（±180° 环绕等价；f64 三角参数约化差异容差 1e-6）。
 */
import { describe, expect, it } from 'vitest'
import { sphericalHrtf } from '../hrtfInterp'
import type { HrtfGrid } from '../types'

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
describe('sphericalHrtf 退化网格防御（O1 审计 P1：奇异矩阵 → 抛错防 NaN）', () => {
  it('1×1 网格（N=1 < 16）：sphericalHrtf 抛错（AᵀA 秩 1 < 16，主元近 0）', () => {
    const degenerate: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [0],
      elevations: [0],
      hrirLength: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    }
    const outL = new Float32Array(1)
    const outR = new Float32Array(1)
    // 1×1 → N=1：AᵀA = a·aᵀ（外积，秩 1）。首列消去后 15×15 余块全 0
    // → 第 2 主元 = 0 < 1e-12 → 抛错。f64 舍入下 ~1e-16 仍 < 阈值。
    expect(() => sphericalHrtf(degenerate, 0, 0, outL, outR)).toThrow(/退化|秩亏/)
  })

  it('3×3 网格（N=9 < 16）：sphericalHrtf 抛错（AᵀA 秩 ≤9 < 16，消去 9 步后余块全 0）', () => {
    const small: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [-90, 0, 90],
      elevations: [-30, 0, 30],
      hrirLength: 1,
      left: new Float32Array(9).fill(1),
      right: new Float32Array(9).fill(1),
    }
    const outL = new Float32Array(1)
    const outR = new Float32Array(1)
    // 3×3 → N=9 < 16：AᵀA 秩 ≤9。部分主元消去 9 步后 7×7 余块全 0
    // → 第 10 主元 ~1e-14 < 1e-12 → 抛错。
    expect(() => sphericalHrtf(small, 0, 0, outL, outR)).toThrow(/退化|秩亏/)
  })

  it('抛错后输出缓冲不被 NaN 污染（防御有效性：非静默产出 NaN）', () => {
    const degenerate: HrtfGrid = {
      sampleRate: 48000,
      azimuths: [0],
      elevations: [0],
      hrirLength: 1,
      left: new Float32Array([1]),
      right: new Float32Array([1]),
    }
    const outL = new Float32Array([0.5])
    const outR = new Float32Array([0.5])
    // 抛错 → 不写输出（调用方 catch 后缓冲保持原值 0.5，非 NaN）
    expect(() => sphericalHrtf(degenerate, 0, 0, outL, outR)).toThrow()
    expect(outL[0]).toBe(0.5) // 原值保留（未被 NaN 污染）
    expect(outR[0]).toBe(0.5)
  })
})
