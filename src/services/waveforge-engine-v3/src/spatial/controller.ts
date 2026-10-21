/**
 * 世界漫游几何/轨迹纯函数。世界坐标：+Z 前、+X 右、+Y 上；角度单位度。
 * 头朝向的世界变换为 Ry(yaw)·Rx(-pitch)·Rz(-roll)：yaw 正向右，pitch 正抬头，
 * roll 正表示朝 +Z 望去头向右（顺时针）倾斜。求声源方向时取逆变换，
 * 先平移到听者原点，再依次逆 yaw、pitch、roll，最后计算头部坐标的方位/仰角。
 * WASD 平移仍只用水平 yaw，避免抬头/侧倾改变原有键盘操作语义。
 */

import type { ListenerState } from './types'

type Position = { x: number; y: number; z: number }
type Keyframe = { t: number; position: Position }

/** 相对方向（方位角 [-180,180)，仰角 [-90,90]，距离米）。 */
export interface RelativeDirection {
  azimuthDeg: number
  elevationDeg: number
  distance: number
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI
// 与 normalizeSpatialSettings 的世界坐标界限一致；避免极大有限值生成无意义距离。
const MAX_WORLD_COORD = 1000

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function wrapAngle(value: number): number {
  return ((((value + 180) % 360) + 360) % 360) - 180
}

/** 实时路径：只写入预分配的 out，无分配；无效/重合的方向归零。 */
export function computeRelativeDirectionInto(
  listener: ListenerState,
  source: Position,
  out: RelativeDirection,
): RelativeDirection {
  const dx = source.x - listener.position.x
  const dy = source.y - listener.position.y
  const dz = source.z - listener.position.z
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz) ||
      Math.abs(source.x) > MAX_WORLD_COORD || Math.abs(source.y) > MAX_WORLD_COORD || Math.abs(source.z) > MAX_WORLD_COORD ||
      Math.abs(listener.position.x) > MAX_WORLD_COORD || Math.abs(listener.position.y) > MAX_WORLD_COORD ||
      Math.abs(listener.position.z) > MAX_WORLD_COORD ||
      !Number.isFinite(listener.yaw) || !Number.isFinite(listener.pitch) || !Number.isFinite(listener.roll)) {
    out.azimuthDeg = 0
    out.elevationDeg = 0
    out.distance = 0
    return out
  }
  const distance = Math.hypot(dx, dy, dz)
  if (!Number.isFinite(distance) || distance === 0) {
    out.azimuthDeg = 0
    out.elevationDeg = 0
    out.distance = 0
    return out
  }

  const yaw = listener.yaw * RAD
  const cosYaw = Math.cos(yaw)
  const sinYaw = Math.sin(yaw)
  const xYaw = cosYaw * dx - sinYaw * dz
  const zYaw = sinYaw * dx + cosYaw * dz

  const pitch = listener.pitch * RAD
  const cosPitch = Math.cos(pitch)
  const sinPitch = Math.sin(pitch)
  const yPitch = cosPitch * dy - sinPitch * zYaw
  const zPitch = sinPitch * dy + cosPitch * zYaw

  const roll = listener.roll * RAD
  const xHead = Math.cos(roll) * xYaw - Math.sin(roll) * yPitch
  const yHead = Math.sin(roll) * xYaw + Math.cos(roll) * yPitch

  out.azimuthDeg = wrapAngle(Math.atan2(xHead, zPitch) * DEG)
  out.elevationDeg = Math.atan2(yHead, Math.hypot(xHead, zPitch)) * DEG
  out.distance = distance
  return out
}

/** 分配一个结果对象的兼容接口；实时循环请复用 computeRelativeDirectionInto 的 out。 */
export function computeRelativeDirection(listener: ListenerState, source: Position): RelativeDirection {
  return computeRelativeDirectionInto(listener, source, { azimuthDeg: 0, elevationDeg: 0, distance: 0 })
}

/** 将关键帧的位置复制至 out；不暴露输入对象引用。 */
function copyPosition(frame: Keyframe, out: Position): Position {
  out.x = finite(frame.position.x)
  out.y = finite(frame.position.y)
  out.z = finite(frame.position.z)
  return out
}

/**
 * 实时路径：sortedKeys 按 t 升序（归一化后同 t 已去重）；越界夹取，段内线性插值。
 * 二分查找，不排序、不创建数组/对象；同 t 即使未经归一化也取最后一帧。
 */
export function sampleTrajectoryInto(sortedKeys: readonly Keyframe[], t: number, out: Position): Position {
  const count = sortedKeys.length
  if (count === 0) {
    out.x = 0
    out.y = 0
    out.z = 0
    return out
  }
  // 无效播放时刻停在轨迹开头；±Infinity 按前/后越界夹取。
  if (Number.isNaN(t) || t === -Infinity || t < sortedKeys[0].t) return copyPosition(sortedKeys[0], out)
  if (t >= sortedKeys[count - 1].t) return copyPosition(sortedKeys[count - 1], out)
  let low = 0
  let high = count
  while (low < high) {
    const mid = (low + high) >>> 1
    if (sortedKeys[mid].t <= t) low = mid + 1
    else high = mid
  }
  const before = sortedKeys[low - 1]
  const after = sortedKeys[low]
  const span = after.t - before.t
  if (!(span > 0)) return copyPosition(after, out)
  const u = (t - before.t) / span
  out.x = finite(before.position.x + (after.position.x - before.position.x) * u)
  out.y = finite(before.position.y + (after.position.y - before.position.y) * u)
  out.z = finite(before.position.z + (after.position.z - before.position.z) * u)
  return out
}

/** 兼容旧调用：乱序帧排序副本，按同 t 最后有效帧取样；输入/输出互不共享位置对象。 */
export function computeTrajectoryPosition(keyframes: Keyframe[], t: number): Position {
  const valid = keyframes.filter((frame) => frame && Number.isFinite(frame.t) && frame.position &&
    Number.isFinite(frame.position.x) && Number.isFinite(frame.position.y) && Number.isFinite(frame.position.z))
  const sorted = valid.sort((a, b) => a.t - b.t)
  return sampleTrajectoryInto(sorted, t, { x: 0, y: 0, z: 0 })
}

/** 世界坐标平移（米）：朝向不变；无效增量不传播 NaN，返回新对象。 */
export function moveListener(l: ListenerState, d: Position): ListenerState {
  return {
    position: {
      x: finite(finite(l.position.x) + finite(d.x)),
      y: finite(finite(l.position.y) + finite(d.y)),
      z: finite(finite(l.position.z) + finite(d.z)),
    },
    yaw: l.yaw,
    pitch: l.pitch,
    roll: l.roll,
  }
}

/** yaw 增量旋转：有效输入延续原有 [-180,180) wrap 与 pitch/roll 保持语义。 */
export function rotateListener(l: ListenerState, dYawDeg: number): ListenerState {
  const yaw = wrapAngle(finite(l.yaw) + finite(dYawDeg))
  return { position: { ...l.position }, yaw, pitch: l.pitch, roll: l.roll }
}

/** 水平面前向单位向量：yaw=0 朝 +Z，yaw=90 朝 +X。 */
export function listenerForwardVector(l: ListenerState): { x: number; z: number } {
  const yawRad = finite(l.yaw) * RAD
  return { x: Math.sin(yawRad), z: Math.cos(yawRad) }
}

/** WASD 按水平 yaw 前后左右，QE 沿世界 Y 升降；斜向不归一化。 */
export function applyKeyboardMove(
  l: ListenerState,
  keys: Record<'w' | 'a' | 's' | 'd' | 'q' | 'e', boolean>,
  speed: number,
  dt: number,
): ListenerState {
  const yawRad = finite(l.yaw) * RAD
  const fwdX = Math.sin(yawRad)
  const fwdZ = Math.cos(yawRad)
  const rightX = Math.cos(yawRad)
  const rightZ = -Math.sin(yawRad)
  const step = finite(speed * dt)
  let dx = 0
  let dy = 0
  let dz = 0
  if (keys.w) {
    dx += fwdX * step
    dz += fwdZ * step
  }
  if (keys.s) {
    dx -= fwdX * step
    dz -= fwdZ * step
  }
  if (keys.d) {
    dx += rightX * step
    dz += rightZ * step
  }
  if (keys.a) {
    dx -= rightX * step
    dz -= rightZ * step
  }
  if (keys.q) dy += step
  if (keys.e) dy -= step
  return moveListener(l, { x: dx, y: dy, z: dz })
}
