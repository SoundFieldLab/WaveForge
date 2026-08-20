/**
 * sphereMath 球面几何纯函数单测（node 环境，无 DOM）
 *
 * 注意：文件用 .tsx 后缀是因为 vitest.config.ts 对 ui/ 目录只收集
 * `ui/**\/*.test.tsx`（纯逻辑测试无需 jsdom，环境沿用全局 node）。
 *
 * 覆盖（验收要求）：正前 0°→(0,0,1)、正右 90°→(1,0,0)、天顶→(0,1,0)、
 * 往返一致；另补：正左/正后/天底、越界 wrap/钳制、滚轮调距钳制。
 */
import { describe, expect, it } from 'vitest'
import {
  adjustDistance,
  azElToPosition,
  positionToAzEl,
  wrapDeg,
  DISTANCE_STEP,
  MAX_DISTANCE,
  MIN_DISTANCE,
} from './sphereMath'

/** 逐分量近似断言（坐标单位球量级，容差 1e-9） */
function expectPos(actual: { x: number; y: number; z: number }, x: number, y: number, z: number): void {
  expect(actual.x).toBeCloseTo(x, 9)
  expect(actual.y).toBeCloseTo(y, 9)
  expect(actual.z).toBeCloseTo(z, 9)
}

describe('azElToPosition（方位角/仰角 → 单位球坐标）', () => {
  it('正前 az=0 → (0, 0, 1)', () => {
    expectPos(azElToPosition(0, 0), 0, 0, 1)
  })

  it('正右 az=90 → (1, 0, 0)', () => {
    expectPos(azElToPosition(90, 0), 1, 0, 0)
  })

  it('正左 az=-90 → (-1, 0, 0)', () => {
    expectPos(azElToPosition(-90, 0), -1, 0, 0)
  })

  it('正后 az=180 → (0, 0, -1)', () => {
    expectPos(azElToPosition(180, 0), 0, 0, -1)
  })

  it('天顶 el=90 → (0, 1, 0)', () => {
    expectPos(azElToPosition(0, 90), 0, 1, 0)
  })

  it('天底 el=-90 → (0, -1, 0)', () => {
    expectPos(azElToPosition(0, -90), 0, -1, 0)
  })

  it('方位角越界 wrap：az=270 与 az=-90 同向（正左）', () => {
    expectPos(azElToPosition(270, 0), -1, 0, 0)
    expectPos(azElToPosition(-270, 0), 1, 0, 0)
  })

  it('仰角越界钳制 [-90, 90]', () => {
    expectPos(azElToPosition(0, 120), 0, 1, 0)
    expectPos(azElToPosition(0, -120), 0, -1, 0)
  })

  it('任意点模长 ≈ 1（单位球面）', () => {
    for (const [az, el] of [[37, 22], [-120, -45], [200, 60], [-5, 88]] as const) {
      const p = azElToPosition(az, el)
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(1, 9)
    }
  })
})

describe('positionToAzEl（单位球坐标 → 方位角/仰角）', () => {
  it('正前 (0,0,1) → az=0, el=0', () => {
    expect(positionToAzEl(0, 0, 1)).toEqual({ azDeg: 0, elDeg: 0 })
  })

  it('正右 (1,0,0) → az=90', () => {
    expect(positionToAzEl(1, 0, 0).azDeg).toBeCloseTo(90, 9)
  })

  it('正左 (-1,0,0) → az=-90', () => {
    expect(positionToAzEl(-1, 0, 0).azDeg).toBeCloseTo(-90, 9)
  })

  it('正后 (0,0,-1) → |az|=180（-180..180 区间表示）', () => {
    expect(Math.abs(positionToAzEl(0, 0, -1).azDeg)).toBeCloseTo(180, 9)
  })

  it('天顶 (0,1,0) → el=90', () => {
    expect(positionToAzEl(0, 1, 0).elDeg).toBeCloseTo(90, 9)
  })

  it('y 越界（拖拽射线浮点误差）钳制 [-1,1]，不产生 NaN', () => {
    const a = positionToAzEl(0, 1.5, 0)
    expect(a.elDeg).toBeCloseTo(90, 9)
    expect(Number.isNaN(a.elDeg)).toBe(false)
    const b = positionToAzEl(0, -2, 0)
    expect(b.elDeg).toBeCloseTo(-90, 9)
    expect(Number.isNaN(b.elDeg)).toBe(false)
  })
})

describe('往返一致（azElToPosition ↔ positionToAzEl）', () => {
  it('典型方位/仰角网格往返误差 ≈ 0', () => {
    for (let az = -170; az <= 180; az += 30) {
      for (let el = -80; el <= 80; el += 20) {
        const p = azElToPosition(az, el)
        const back = positionToAzEl(p.x, p.y, p.z)
        // 方位角在 -180/180 边界取等效表示，先归一
        const azNorm = (az + 180) % 360 - 180
        expect(back.azDeg).toBeCloseTo(azNorm, 9)
        expect(back.elDeg).toBeCloseTo(el, 9)
      }
    }
  })

  it('越界输入（az=270、el=120）往返取等效方向', () => {
    const p = azElToPosition(270, 120)
    const back = positionToAzEl(p.x, p.y, p.z)
    expect(back.azDeg).toBeCloseTo(-90, 9)
    expect(back.elDeg).toBeCloseTo(90, 9)
  })
})

describe('wrapDeg（角度归一 [-180, 180)）', () => {
  it('区间内不变', () => {
    expect(wrapDeg(0)).toBe(0)
    expect(wrapDeg(90)).toBe(90)
    expect(wrapDeg(-170)).toBe(-170)
    expect(wrapDeg(180)).toBe(-180)
  })

  it('越界取模（180 系角度取 -180 等效表示）', () => {
    expect(wrapDeg(450)).toBe(90)
    expect(wrapDeg(-450)).toBe(-90)
    expect(wrapDeg(540)).toBe(-180)
    expect(wrapDeg(-540)).toBe(-180)
  })
})

describe('adjustDistance（滚轮调距）', () => {
  it('上滚（delta=-0.5）推远 0.5m', () => {
    expect(adjustDistance(1, DISTANCE_STEP)).toBe(1.5)
    expect(adjustDistance(1, -DISTANCE_STEP)).toBe(0.5)
  })

  it('钳制下界 0.5m', () => {
    expect(adjustDistance(0.2, -DISTANCE_STEP)).toBe(MIN_DISTANCE)
    expect(adjustDistance(MIN_DISTANCE, -DISTANCE_STEP)).toBe(MIN_DISTANCE)
  })

  it('钳制上界 10m', () => {
    expect(adjustDistance(9.8, DISTANCE_STEP)).toBe(MAX_DISTANCE)
    expect(adjustDistance(MAX_DISTANCE, DISTANCE_STEP)).toBe(MAX_DISTANCE)
  })

  it('取整到 0.1m（浮点长尾不污染持久化参数）', () => {
    expect(adjustDistance(1.03, DISTANCE_STEP)).toBe(1.5)
    expect(adjustDistance(1.04, -DISTANCE_STEP)).toBe(0.5)
  })
})
