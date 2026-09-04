/**
 * sphereMath —— 3D 球形编辑器（SpatialSphereEditor）共用球面几何纯函数
 *
 * 规划书 §5.3 模式 B「3D 球形网格编辑器」：每只扬声器按 (方位角, 仰角) 投影到
 * 单位球面（半径 1 的声场球面），听者在球心。本模块只做角度 ↔ 坐标换算，
 * 不含任何 Three.js 依赖，可在 node 环境单测。
 *
 * 角度单位：度；坐标单位：单位球（半径 1）。约定与 2D 环形编辑器
 * （SpatialRingEditor）/引擎一致：
 *   - az = 0  正前（+Z）
 *   - az > 0  偏右（+X，右正）
 *   - el > 0  向上（+Y，仰角）
 *
 * 投影公式（方位角 az、仰角 el → 单位球坐标，由球面参数方程推导）：
 *   x = cos(el)·sin(az)
 *   y = sin(el)
 *   z = cos(el)·cos(az)
 *
 * 反解（单位球坐标 → 方位角/仰角）：
 *   az = atan2(x, z)   （wrap 到 [-180, 180)）
 *   el = asin(y)       （y 钳制 [-1, 1] 防浮点越界产生 NaN）
 *
 * 拖拽交互中「射线与球面交点 → 反解 (az, el)」即复用 positionToAzEl；
 * 滚轮调距走 adjustDistance（钳制 0.5..10m + 0.1 取整）。
 */

/** 单位球面上的三维坐标（半径 1） */
export interface SpherePos {
  x: number
  y: number
  z: number
}

/** 扬声器距离下界（米）——滚轮/精确输入共用钳制 */
export const MIN_DISTANCE = 0.5
/** 扬声器距离上界（米）——滚轮/精确输入共用钳制 */
export const MAX_DISTANCE = 10
/** 滚轮单步距离增量（米，规划书「clamp(dist ± 0.5, 0.5, 10)」） */
export const DISTANCE_STEP = 0.5

/** 度 → 弧度 */
const DEG = Math.PI / 180

/**
 * 角度 wrap 到 [-180, 180)（求余 + 平移，任意输入归一；atan2 返回值天然在
 * 此区间，本函数用于方位角越界输入归一，保证往返反解一致）
 */
export function wrapDeg(deg: number): number {
  return ((deg % 360) + 540) % 360 - 180
}

/**
 * 方位角/仰角（度）→ 单位球面坐标（半径 1）。
 * 方位角 wrap 到 [-180, 180)、仰角钳制 [-90, 90]——与 positionToAzEl 往返一致
 * （越界输入取最近等效方向）。
 * 公式：x = cos(el)·sin(az)、y = sin(el)、z = cos(el)·cos(az)。
 */
export function azElToPosition(azDeg: number, elDeg: number): SpherePos {
  const az = wrapDeg(azDeg) * DEG
  const el = Math.min(90, Math.max(-90, elDeg)) * DEG
  const ce = Math.cos(el)
  return {
    x: ce * Math.sin(az),
    y: Math.sin(el),
    z: ce * Math.cos(az),
  }
}

/**
 * 单位球面坐标 → 方位角/仰角（度）。
 * 逆公式：az = atan2(x, z)、el = asin(y)；y 钳制 [-1, 1] 防浮点越界 NaN；
 * 方位角 wrap 到 [-180, 180)。x²+y²+z² ≈ 1 时与 azElToPosition 往返一致。
 */
export function positionToAzEl(x: number, y: number, z: number): { azDeg: number; elDeg: number } {
  const azDeg = wrapDeg(Math.atan2(x, z) / DEG)
  const elDeg = Math.asin(Math.min(1, Math.max(-1, y))) / DEG
  return { azDeg, elDeg }
}

/**
 * 滚轮调距：当前距离 + 增量（每格 ±DISTANCE_STEP，deltaY<0 上滚 = 推远 +
 * 0.5、deltaY>0 下滚 = 拉近 −0.5），钳制 [MIN_DISTANCE, MAX_DISTANCE] 并取整
 * 到 0.1m（避免浮点长尾污染持久化参数）。
 */
export function adjustDistance(distance: number, delta: number): number {
  const next = Math.round((distance + delta) * 10) / 10
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, next))
}
