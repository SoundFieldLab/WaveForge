/**
 * analyticHrtf 单元测试（合成 HRTF 网格生成器）
 *
 * 断言要点：
 *  - 网格形状/布局（72 方位 × 14 仰角 × 256 样本，行主序）；
 *  - 确定性（同参数两次调用逐位相同——对拍/回归的前提）；
 *  - ITD 方向：az>0 右耳为近耳（峰值索引更小），az<0 反之；
 *  - ITD 量级：az=90° 达 Woodworth 最大值 ≈ (a/c)(1+π/2)·fs（48kHz ≈ 31.5 样本），
 *    明显大于 az=30°（≈12.5 样本），且远小于 hrirLength（256）——
 *    注：Woodworth 全模型 (sinθ+θ) 在 90° 处为 2.571×(a/c)，故上限取 (a/c)(1+π/2)·fs
 *    而非 sinθ 近似下的 a/c·fs（后者仅对小角度成立）。
 */
import { describe, it, expect } from 'vitest'
import { generateAnalyticHrtfGrid } from '../analyticHrtf'

const FS = 48000
const HRIR = 256

/** 取 (el, az) 处的左右耳 HRIR（行主序 [elIdx·azCount + azIdx]） */
function hrirAt(
  grid: ReturnType<typeof generateAnalyticHrtfGrid>,
  az: number,
  el: number,
): { l: Float32Array; r: Float32Array } {
  const azIdx = grid.azimuths.indexOf(az)
  const elIdx = grid.elevations.indexOf(el)
  expect(azIdx).toBeGreaterThanOrEqual(0)
  expect(elIdx).toBeGreaterThanOrEqual(0)
  const base = (elIdx * grid.azimuths.length + azIdx) * grid.hrirLength
  return {
    l: grid.left.subarray(base, base + grid.hrirLength),
    r: grid.right.subarray(base, base + grid.hrirLength),
  }
}

/** 峰值索引（|h| 最大处） */
function peakIndex(h: Float32Array): number {
  let pi = 0
  let pv = -1
  for (let i = 0; i < h.length; i++) {
    const v = Math.abs(h[i])
    if (v > pv) {
      pv = v
      pi = i
    }
  }
  return pi
}

/** 逐位比较两个 Float32Array */
function bitwiseEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

describe('generateAnalyticHrtfGrid：形状与布局', () => {
  it('网格尺寸与字段', () => {
    const g = generateAnalyticHrtfGrid(FS)
    expect(g.sampleRate).toBe(FS)
    expect(g.azimuths).toHaveLength(72)
    expect(g.elevations).toHaveLength(14)
    expect(g.azimuths[0]).toBe(-180)
    expect(g.azimuths[71]).toBe(175)
    expect(g.elevations[0]).toBe(-40)
    expect(g.elevations[13]).toBe(90)
    expect(g.hrirLength).toBe(HRIR)
    expect(g.left.length).toBe(14 * 72 * HRIR)
    expect(g.right.length).toBe(14 * 72 * HRIR)
  })

  it('确定性：同参数两次调用逐位相同（纯函数）', () => {
    const a = generateAnalyticHrtfGrid(FS)
    const b = generateAnalyticHrtfGrid(FS)
    expect(bitwiseEqual(a.left, b.left)).toBe(true)
    expect(bitwiseEqual(a.right, b.right)).toBe(true)
    expect(a.azimuths).toEqual(b.azimuths)
  })

  it('数值全部有限且非全零', () => {
    const g = generateAnalyticHrtfGrid(FS)
    let anyNonZero = false
    let bad = 0
    for (let i = 0; i < g.left.length; i++) {
      if (!Number.isFinite(g.left[i]) || !Number.isFinite(g.right[i])) bad++
      if (g.left[i] !== 0 || g.right[i] !== 0) anyNonZero = true
    }
    expect(bad).toBe(0)
    expect(anyNonZero).toBe(true)
  })
})

describe('ITD 方向与量级', () => {
  it('az=+30：右耳（近耳）峰值索引更小，偏移 ≈ (a/c)(sin30°+30°)·fs', () => {
    const g = generateAnalyticHrtfGrid(FS)
    const { l, r } = hrirAt(g, 30, 0)
    const pL = peakIndex(l)
    const pR = peakIndex(r)
    expect(pR).toBeLessThan(pL) // 右侧声源：右耳先达
    // 理论 ITD = (0.0875/343)(sin30° + π/6) ≈ 0.2611ms ≈ 12.53 样本（分数延迟，峰值落在邻近样本）
    expect(pL - pR).toBeGreaterThanOrEqual(8)
    expect(pL - pR).toBeLessThanOrEqual(18)
  })

  it('az=-30：左耳（近耳）峰值索引更小', () => {
    const g = generateAnalyticHrtfGrid(FS)
    const { l, r } = hrirAt(g, -30, 0)
    const pL = peakIndex(l)
    const pR = peakIndex(r)
    expect(pL).toBeLessThan(pR)
    expect(pR - pL).toBeGreaterThanOrEqual(8)
    expect(pR - pL).toBeLessThanOrEqual(18)
  })

  it('az=0：两耳对称（峰值索引相同）', () => {
    const g = generateAnalyticHrtfGrid(FS)
    const { l, r } = hrirAt(g, 0, 0)
    expect(peakIndex(r)).toBe(peakIndex(l))
  })

  it('最大 ITD 合理：az=90° 最大（Woodworth 上限 ≈ (a/c)(1+π/2)·fs），小于 hrirLength', () => {
    const g = generateAnalyticHrtfGrid(FS)
    const at30 = hrirAt(g, 30, 0)
    const at90 = hrirAt(g, 90, 0)
    const offset30 = Math.abs(peakIndex(at30.r) - peakIndex(at30.l))
    const offset90 = Math.abs(peakIndex(at90.r) - peakIndex(at90.l))
    // az=90° 达到 (a/c)(1+π/2)·fs ≈ 31.5 样本（48kHz）
    expect(offset90).toBeGreaterThan(offset30)
    expect(offset90).toBeGreaterThanOrEqual(27)
    expect(offset90).toBeLessThanOrEqual(36)
    // 远小于窗长（保证 HRIR 不出窗）
    expect(offset90).toBeLessThan(HRIR / 2)
  })
})
