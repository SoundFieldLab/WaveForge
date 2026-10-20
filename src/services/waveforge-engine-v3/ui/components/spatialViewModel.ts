import type { AudioObject, ListenerState } from '../../src/spatial/types'

export type Point3 = { x: number; y: number; z: number }
export type ScenePoint = [number, number, number]

/** 音频使用右/上/前 +XYZ；Three 相机面向 -Z，显式翻转 Z 避免第一人称左右镜像。 */
export const toScene = (point: Point3): ScenePoint => [point.x, point.y, -point.z]
export const fromScene = (point: Point3): Point3 => ({ x: point.x, y: point.y, z: -point.z })

export function sourceReadout(source: Point3, listener: ListenerState) {
  const dx = source.x - listener.position.x, dy = source.y - listener.position.y, dz = source.z - listener.position.z
  const azimuth = ((Math.atan2(dx, dz) * 180 / Math.PI - listener.yaw + 540) % 360 + 360) % 360 - 180
  const direction = ['前方', '右前方', '右侧', '右后方', '后方', '左后方', '左侧', '左前方'][(Math.round(azimuth / 45) + 8) % 8]
  return { distance: Math.hypot(dx, dy, dz), azimuth, direction, height: dy }
}

/** 展示台自适应声源范围，仅提供坐标参照，不冒充 DSP 房间障碍物。 */
export function frameSpatialScene(sources: AudioObject[], listener: ListenerState) {
  const positions = [listener.position, ...sources.map(source => source.position)]
  const minX = Math.floor(Math.min(listener.position.x - 3, ...positions.map(point => point.x - 1.3)))
  const maxX = Math.ceil(Math.max(listener.position.x + 3, ...positions.map(point => point.x + 1.3)))
  const minZ = Math.floor(Math.min(-listener.position.z - 4, ...positions.map(point => -point.z - 1.3)))
  const maxZ = Math.ceil(Math.max(-listener.position.z + 3, ...positions.map(point => -point.z + 1.3)))
  const minY = Math.min(0, ...positions.map(point => point.y - 0.4))
  const maxY = Math.max(3, ...positions.map(point => point.y + 0.8))
  const width = maxX - minX, depth = maxZ - minZ
  return { minX, maxX, minZ, maxZ, width, depth, minY, maxY,
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] as ScenePoint,
    radius: Math.hypot(width, depth, maxY - minY) / 2,
    gridStep: Math.max(width, depth) > 30 ? 5 : Math.max(width, depth) > 16 ? 2 : 1 }
}

export type SpatialSceneFrame = ReturnType<typeof frameSpatialScene>

/** 按真实投影角度框住展示台，避免包围球取景留下过大的空白。 */
export function fitSceneDistance(frame: SpatialSceneFrame, direction: ScenePoint, verticalFov: number, aspect: number) {
  const length = Math.hypot(...direction), d = direction.map(value => value / length)
  const rx = d[2], rz = -d[0], rightLength = Math.hypot(rx, rz) || 1
  const right = [rx / rightLength, 0, rz / rightLength]
  const up = [d[1] * right[2], d[2] * right[0] - d[0] * right[2], -d[1] * right[0]]
  const tanY = Math.tan(verticalFov / 2), tanX = tanY * Math.max(0.1, aspect)
  let distance = 1
  const points: ScenePoint[] = []
  for (const x of [frame.minX, frame.maxX]) for (const z of [frame.minZ, frame.maxZ]) points.push([x, frame.minY, z])
  // 开放式示意台没有前墙/天花板，不把空的包围盒顶点也塞进取景范围。
  for (const x of [frame.minX, frame.maxX]) points.push([x, frame.maxY + 0.5, frame.minZ])
  points.push([frame.minX, (frame.maxY + 0.5) * 0.65, frame.maxZ])
  for (const [x, y, z] of points) {
    const p = [x - frame.center[0], y - frame.center[1], z - frame.center[2]]
    const dot = (basis: number[]) => p.reduce((sum, value, index) => sum + value * basis[index], 0)
    distance = Math.max(distance, dot(d) + Math.abs(dot(up)) / tanY, dot(d) + Math.abs(dot(right)) / tanX)
  }
  return distance * 1.06
}

export interface SpatialLabelBox { id: string; x: number; y: number; width: number; height: number; selected?: boolean }
/** 少量场景标注的屏幕避让；优先保留选中项，在视口内找最近的不重叠位置。 */
export function layoutSpatialLabels(anchors: SpatialLabelBox[], viewport: { width: number; height: number }, reserved: SpatialLabelBox[] = []) {
  const placed = [...reserved], result = new Map<string, { x: number; y: number }>()
  const area = (a: SpatialLabelBox, b: SpatialLabelBox) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) + 5)
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) + 5)
  for (const anchor of [...anchors].sort((a, b) => Number(!!b.selected) - Number(!!a.selected))) {
    let best = { ...anchor }, score = Infinity
    for (const dy of [0, -48, 48, -96, 96, -144, 144]) for (const dx of [0, -55, 55, -110, 110]) {
      const candidate = { ...anchor, x: Math.max(8, Math.min(viewport.width - anchor.width - 8, anchor.x + dx)), y: Math.max(8, Math.min(viewport.height - anchor.height - 8, anchor.y + dy)) }
      const cost = placed.reduce((sum, box) => sum + area(candidate, box) * 100, 0) + Math.hypot(candidate.x - anchor.x, candidate.y - anchor.y)
      if (cost < score) { score = cost; best = candidate }
    }
    placed.push(best); result.set(anchor.id, { x: best.x - anchor.x, y: best.y - anchor.y })
  }
  return result
}
