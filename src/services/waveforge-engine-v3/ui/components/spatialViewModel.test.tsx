import { describe, expect, it } from 'vitest'
import { frameSpatialScene, fromScene, sourceReadout, toScene, fitSceneDistance, layoutSpatialLabels } from './spatialViewModel'

const listener = { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 }
describe('三维声场的方向和尺度契约', () => {
  it('第一人称朝向 -Z，音频前方 +Z 映射到前方，右侧仍为 +X', () => {
    expect(toScene({ x: 2, y: 1.6, z: 4 })).toEqual([2, 1.6, -4])
    const position = { x: -3, y: 2.4, z: 7 }
    const [x, y, z] = toScene(position)
    expect(fromScene({ x, y, z })).toEqual(position)
  })
  it('方向提示相对听者朝向，距离包含高度', () => {
    expect(sourceReadout({ x: 3, y: 1.6, z: 0 }, listener).direction).toBe('右侧')
    expect(sourceReadout({ x: 3, y: 1.6, z: 0 }, { ...listener, yaw: 90 }).direction).toBe('前方')
    expect(sourceReadout({ x: 0, y: 4.6, z: 4 }, listener).distance).toBeCloseTo(5)
    expect(sourceReadout({ x: -3, y: 1.6, z: -3 }, listener).direction).toBe('左后方')
  })
  it('全景边界包含远处声源与移动后的听者，不固定为原点 20m 盒子', () => {
    const points = [{ id: 'far', position: { x: 40, y: 8, z: 25 }, gain: 1, size: 0 }]
    const frame = frameSpatialScene(points, { ...listener, position: { x: -12, y: 1.6, z: -8 } })
    expect(frame.minX).toBeLessThan(-12); expect(frame.maxX).toBeGreaterThan(40)
    expect(frame.minZ).toBeLessThan(-25); expect(frame.maxZ).toBeGreaterThan(8)
    expect(frame.maxY).toBeGreaterThan(8); expect(frame.gridStep).toBe(5)
    expect(frame.radius).toBeGreaterThan(25)
  })
  it('窄窗口自动拉远取景，移动听者后仍能得到有限的全景距离', () => {
    const frame = frameSpatialScene([{ id: 'a', position: { x: -5, y: 2, z: 10 }, gain: 1, size: 0 }], listener)
    const wide = fitSceneDistance(frame, [0.7, 0.38, 1.25], Math.PI * 42 / 180, 2.5)
    const narrow = fitSceneDistance(frame, [0.7, 0.38, 1.25], Math.PI * 42 / 180, 0.7)
    expect(narrow).toBeGreaterThan(wide)
    expect(Number.isFinite(wide) && wide > 1).toBe(true)
  })
  it('拥挤标注保留选中项，其他标注避让且不越过视口', () => {
    const anchors = [
      { id: 'a', x: 120, y: 100, width: 100, height: 40, selected: true },
      { id: 'b', x: 120, y: 105, width: 100, height: 40 },
      { id: 'c', x: 135, y: 95, width: 100, height: 40 },
    ]
    const placements = layoutSpatialLabels(anchors, { width: 400, height: 300 })
    expect(placements.get('a')).toEqual({ x: 0, y: 0 })
    const positioned = anchors.map(a => ({ ...a, x: a.x + placements.get(a.id)!.x, y: a.y + placements.get(a.id)!.y }))
    for (const a of positioned) {
      expect(a.x).toBeGreaterThanOrEqual(8); expect(a.x + a.width).toBeLessThanOrEqual(392)
      expect(a.y).toBeGreaterThanOrEqual(8); expect(a.y + a.height).toBeLessThanOrEqual(292)
      for (const b of positioned) if (a.id !== b.id) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true)
    }
  })
})
