/**
 * controller —— 模式 C 相对方向计算单元测试
 *
 * 覆盖规划书 §4.3 公式的已知几何：正前/正右 90°/正上/45° 斜角/正后 ±180°、
 * 听者偏航旋转、听者位置偏移、源与听者重合（无 NaN）；
 * 以及世界漫游移动/旋转（moveListener / rotateListener / listenerForwardVector /
 * applyKeyboardMove）的键盘几何（yaw=0 → +Z 前方、yaw=90 → +X 右侧等）。
 */
import { describe, it, expect } from 'vitest'
import {
  computeRelativeDirection,
  computeTrajectoryPosition,
  moveListener,
  rotateListener,
  listenerForwardVector,
  applyKeyboardMove,
} from '../controller'
import type { ListenerState } from '../types'

/** 便捷构造：默认原点朝前（yaw=0）的听者 */
function listenerAt(
  position: { x: number; y: number; z: number },
  yaw = 0,
): ListenerState {
  return { position, yaw, pitch: 0, roll: 0 }
}

describe('controller：computeRelativeDirection 几何', () => {
  it('正前方：azimuth 0、elevation 0、distance 5', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 5 })
    expect(r.azimuthDeg).toBeCloseTo(0, 6)
    expect(r.elevationDeg).toBeCloseTo(0, 6)
    expect(r.distance).toBeCloseTo(5, 6)
  })

  it('正右 90°：源在 +x', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 5, y: 0, z: 0 })
    expect(r.azimuthDeg).toBeCloseTo(90, 6)
    expect(r.elevationDeg).toBeCloseTo(0, 6)
    expect(r.distance).toBeCloseTo(5, 6)
  })

  it('正上方：elevation 90（atan2(0, 0) = 0 → azimuth 0）', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 0, y: 5, z: 0 })
    expect(r.elevationDeg).toBeCloseTo(90, 6)
    expect(r.azimuthDeg).toBeCloseTo(0, 6)
    expect(r.distance).toBeCloseTo(5, 6)
  })

  it('正后方：源在 −z → azimuth ±180、elevation 0', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: -5 })
    expect(Math.abs(r.azimuthDeg)).toBeCloseTo(180, 6)
    expect(r.elevationDeg).toBeCloseTo(0, 6)
    expect(r.distance).toBeCloseTo(5, 6)
  })

  it('45° 斜角：源 (0, 5, 5) → elevation 45、azimuth 0、distance √50', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 0, y: 5, z: 5 })
    expect(r.elevationDeg).toBeCloseTo(45, 5)
    expect(r.azimuthDeg).toBeCloseTo(0, 5)
    expect(r.distance).toBeCloseTo(Math.sqrt(50), 5)
  })

  it('听者偏航旋转：yaw 30° → 正前声源 azimuth −30、右方声源 +60', () => {
    const l = listenerAt({ x: 0, y: 0, z: 0 }, 30)
    expect(computeRelativeDirection(l, { x: 0, y: 0, z: 5 }).azimuthDeg).toBeCloseTo(-30, 6)
    expect(computeRelativeDirection(l, { x: 5, y: 0, z: 0 }).azimuthDeg).toBeCloseTo(60, 6)
  })

  it('听者位置偏移 + 偏航：原点 (1,2,3)、源 (4,7,3)、yaw 15', () => {
    const r = computeRelativeDirection(listenerAt({ x: 1, y: 2, z: 3 }, 15), { x: 4, y: 7, z: 3 })
    // direction = (3, 5, 0)：atan2(3, 0) = 90 → 90 − 15 = 75
    expect(r.azimuthDeg).toBeCloseTo(75, 5)
    expect(r.distance).toBeCloseTo(Math.sqrt(34), 5)
    expect(r.elevationDeg).toBeCloseTo((Math.asin(5 / Math.sqrt(34)) * 180) / Math.PI, 5)
  })

  it('源与听者重合：方位/仰角 0、距离 0（无 NaN）', () => {
    const r = computeRelativeDirection(listenerAt({ x: 1, y: 1, z: 1 }), { x: 1, y: 1, z: 1 })
    expect(r.azimuthDeg).toBe(0)
    expect(r.elevationDeg).toBe(0)
    expect(r.distance).toBe(0)
    expect(Number.isFinite(r.azimuthDeg)).toBe(true)
    expect(Number.isFinite(r.elevationDeg)).toBe(true)
  })

  it('仰角为负：源在下方 → elevation −30', () => {
    const r = computeRelativeDirection(listenerAt({ x: 0, y: 0, z: 0 }), { x: 0, y: -2.5, z: 4.330 })
    expect(r.elevationDeg).toBeCloseTo(-30, 1) // asin(-0.5) ≈ −30（z 值 4.330 取近似）
    expect(r.distance).toBeCloseTo(5, 1)
  })
})

describe('controller：模式 C 世界漫游移动/旋转（纯函数）', () => {
  it('moveListener：世界坐标平移，朝向不变，原对象不可变', () => {
    const l = listenerAt({ x: 1, y: 2, z: 3 }, 30)
    const moved = moveListener(l, { x: 4, y: -1, z: 0.5 })
    expect(moved.position).toEqual({ x: 5, y: 1, z: 3.5 })
    expect(moved.yaw).toBe(30)
    expect(moved.pitch).toBe(0)
    expect(moved.roll).toBe(0)
    // 原对象未被修改（不可变语义）
    expect(l.position).toEqual({ x: 1, y: 2, z: 3 })
    expect(l.yaw).toBe(30)
  })

  it('rotateListener：yaw 增量 + 跨 ±180 折返（355°+10° → 5°）', () => {
    // 验收示例 355+10 → 5：365° 的正确 wrap 代表元是 5°（= 365−360）。
    // 注意：若按 −175 实现（= 365−540，即「mod 360 后平移 −180」），所有 yaw 都会
    // 被系统性平移 −180，破坏与 computeRelativeDirection / listenerForwardVector
    // 的方向约定（正前/正后互换），故此处按标准 [-180, 180) wrap 断言。
    const r = rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, 355), 10)
    expect(r.yaw).toBe(5)
    // 恒等旋转：yaw 不变（wrap 不引入偏移）
    expect(rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, 0), 0).yaw).toBe(0)
    expect(rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, 30), 0).yaw).toBe(30)
    // 跨 ±180 边界：170°+20° → −170°；−170°−20° → 170°
    expect(rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, 170), 20).yaw).toBe(-170)
    expect(rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, -170), -20).yaw).toBe(170)
    // 常规增量
    expect(rotateListener(listenerAt({ x: 0, y: 0, z: 0 }, 30), 60).yaw).toBe(90)
    // 原对象不可变
    const l = listenerAt({ x: 1, y: 2, z: 3 }, 355)
    rotateListener(l, 10)
    expect(l.yaw).toBe(355)
    expect(l.position).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('listenerForwardVector：yaw 0/90/180/−90 的水平面前向', () => {
    const f0 = listenerForwardVector(listenerAt({ x: 0, y: 0, z: 0 }, 0))
    expect(f0.x).toBeCloseTo(0, 10)
    expect(f0.z).toBeCloseTo(1, 10)
    const f90 = listenerForwardVector(listenerAt({ x: 0, y: 0, z: 0 }, 90))
    expect(f90.x).toBeCloseTo(1, 10)
    expect(f90.z).toBeCloseTo(0, 10)
    const f180 = listenerForwardVector(listenerAt({ x: 0, y: 0, z: 0 }, 180))
    expect(f180.x).toBeCloseTo(0, 10)
    expect(f180.z).toBeCloseTo(-1, 10)
    const fm90 = listenerForwardVector(listenerAt({ x: 0, y: 0, z: 0 }, -90))
    expect(fm90.x).toBeCloseTo(-1, 10)
    expect(fm90.z).toBeCloseTo(0, 10)
    // 单位长度
    const f = listenerForwardVector(listenerAt({ x: 0, y: 0, z: 0 }, 37))
    expect(Math.hypot(f.x, f.z)).toBeCloseTo(1, 10)
  })

  it('applyKeyboardMove：yaw=0 时 W → +Z、D → +X、A → −X、S → −Z', () => {
    const l = listenerAt({ x: 0, y: 1.6, z: 0 }, 0)
    const step = 2 * 0.1 // speed 2 m/s × dt 0.1s
    const key = (k: 'w' | 'a' | 's' | 'd' | 'q' | 'e') => ({ w: false, a: false, s: false, d: false, q: false, e: false, [k]: true })
    expect(applyKeyboardMove(l, key('w'), 2, 0.1).position).toEqual({ x: 0, y: 1.6, z: step })
    expect(applyKeyboardMove(l, key('s'), 2, 0.1).position).toEqual({ x: 0, y: 1.6, z: -step })
    expect(applyKeyboardMove(l, key('d'), 2, 0.1).position).toEqual({ x: step, y: 1.6, z: 0 })
    expect(applyKeyboardMove(l, key('a'), 2, 0.1).position).toEqual({ x: -step, y: 1.6, z: 0 })
  })

  it('applyKeyboardMove：yaw=90（朝 +X）时 W → +X、D → −Z', () => {
    const l = listenerAt({ x: 0, y: 1.6, z: 0 }, 90)
    const step = 2 * 0.1
    // 注：cos(90°) 的 f64 残差 ~6.1e-17，垂直分量断言放宽到 1e-10
    const w = applyKeyboardMove(l, { w: true, a: false, s: false, d: false, q: false, e: false }, 2, 0.1)
    expect(w.position.x).toBeCloseTo(step, 10)
    expect(w.position.y).toBe(1.6)
    expect(w.position.z).toBeCloseTo(0, 10)
    const d = applyKeyboardMove(l, { w: false, a: false, s: false, d: true, q: false, e: false }, 2, 0.1)
    expect(d.position.x).toBeCloseTo(0, 10)
    expect(d.position.y).toBe(1.6)
    expect(d.position.z).toBeCloseTo(-step, 10)
  })

  it('applyKeyboardMove：QE 升降（Q 升 +Y / E 降 −Y，与朝向无关）', () => {
    const l = listenerAt({ x: 0, y: 1.6, z: 0 }, 0)
    const step = 3 * 0.05 // speed 3 m/s × dt 0.05s
    expect(applyKeyboardMove(l, { w: false, a: false, s: false, d: false, q: true, e: false }, 3, 0.05).position).toEqual({
      x: 0,
      y: 1.6 + step,
      z: 0,
    })
    expect(applyKeyboardMove(l, { w: false, a: false, s: false, d: false, q: false, e: true }, 3, 0.05).position).toEqual({
      x: 0,
      y: 1.6 - step,
      z: 0,
    })
    // 组合：W+D+Q（水平斜向为向量和，不归一化；speed 2 × dt 0.1 → 步长 0.2）
    const combo = applyKeyboardMove(l, { w: true, a: false, s: false, d: true, q: true, e: false }, 2, 0.1)
    expect(combo.position).toEqual({ x: 0.2, y: 1.6 + 0.2, z: 0.2 })
    expect(combo.yaw).toBe(0)
    // 原对象不可变
    expect(l.position).toEqual({ x: 0, y: 1.6, z: 0 })
  })

  it('applyKeyboardMove 与 computeRelativeDirection 一致：移动后声源方位角符合几何', () => {
    // yaw=0 时 W 前进 2m（speed 2 × dt 1s），前方声源 (0,1.6,10) 距离缩短为 8m、方位 0
    const l = listenerAt({ x: 0, y: 1.6, z: 0 }, 0)
    const moved = applyKeyboardMove(l, { w: true, a: false, s: false, d: false, q: false, e: false }, 2, 1)
    const r = computeRelativeDirection(moved, { x: 0, y: 1.6, z: 10 })
    expect(r.distance).toBeCloseTo(8, 6)
    expect(r.azimuthDeg).toBeCloseTo(0, 6)
  })
})

describe('controller：computeTrajectoryPosition 声源轨迹线性插值', () => {
  it('多段线性插值：段内中点、1/4 点与跨段', () => {
    const kf = [
      { t: 0, position: { x: 0, y: 0, z: 0 } },
      { t: 2, position: { x: 4, y: 6, z: 8 } },
      { t: 6, position: { x: 8, y: 10, z: 12 } },
    ]
    // t=1：段 [0,2] 中点 → (2,3,4)
    expect(computeTrajectoryPosition(kf, 1)).toEqual({ x: 2, y: 3, z: 4 })
    // t=3：段 [2,6] 的 1/4 点 → x=4+(8-4)×0.25=5、y=6+(10-6)×0.25=7、z=8+(12-8)×0.25=9
    expect(computeTrajectoryPosition(kf, 3)).toEqual({ x: 5, y: 7, z: 9 })
    // t=4：段 [2,6] 中点 → (6,8,10)
    expect(computeTrajectoryPosition(kf, 4)).toEqual({ x: 6, y: 8, z: 10 })
  })

  it('越界夹取：t < 首帧 → 首位置；t > 末帧 → 末位置', () => {
    const kf = [
      { t: 1, position: { x: -3, y: 2, z: 5 } },
      { t: 3, position: { x: 9, y: -4, z: 1 } },
    ]
    expect(computeTrajectoryPosition(kf, 0)).toEqual({ x: -3, y: 2, z: 5 })
    expect(computeTrajectoryPosition(kf, 1)).toEqual({ x: -3, y: 2, z: 5 })
    expect(computeTrajectoryPosition(kf, 3)).toEqual({ x: 9, y: -4, z: 1 })
    expect(computeTrajectoryPosition(kf, 100)).toEqual({ x: 9, y: -4, z: 1 })
  })

  it('单关键帧：任意 t 恒返回该位置', () => {
    const kf = [{ t: 2, position: { x: 7, y: 8, z: 9 } }]
    expect(computeTrajectoryPosition(kf, 0)).toEqual({ x: 7, y: 8, z: 9 })
    expect(computeTrajectoryPosition(kf, 2)).toEqual({ x: 7, y: 8, z: 9 })
    expect(computeTrajectoryPosition(kf, 99)).toEqual({ x: 7, y: 8, z: 9 })
  })

  it('空数组：防御返回原点 {0,0,0}（无 NaN）', () => {
    expect(computeTrajectoryPosition([], 0)).toEqual({ x: 0, y: 0, z: 0 })
    expect(computeTrajectoryPosition([], 5)).toEqual({ x: 0, y: 0, z: 0 })
    const r = computeTrajectoryPosition([], 5)
    expect(Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)).toBe(true)
  })

  it('关键帧精确命中：返回该帧位置（无插值误差）', () => {
    const kf = [
      { t: 0, position: { x: 1, y: 2, z: 3 } },
      { t: 2, position: { x: 5, y: 6, z: 7 } },
      { t: 4, position: { x: 9, y: 10, z: 11 } },
    ]
    expect(computeTrajectoryPosition(kf, 2)).toEqual({ x: 5, y: 6, z: 7 })
  })

  it('防御排序：乱序关键帧与升序结果一致', () => {
    const kf = [
      { t: 6, position: { x: 8, y: 10, z: 12 } },
      { t: 0, position: { x: 0, y: 0, z: 0 } },
      { t: 2, position: { x: 4, y: 6, z: 8 } },
    ]
    expect(computeTrajectoryPosition(kf, 1)).toEqual({ x: 2, y: 3, z: 4 })
    expect(computeTrajectoryPosition(kf, 3)).toEqual({ x: 5, y: 7, z: 9 })
  })
})
