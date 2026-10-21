import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../../engine/EngineV3'
import { createDefaultParams } from '../../types'
import { resolveMusicSourceRoute } from '../worldRouting'
import type { VirtualSpeaker } from '../types'

function renderedSpeakers(engine: EngineV3): VirtualSpeaker[] {
  return (engine as unknown as { _spatialBackend: { speakers: VirtualSpeaker[] } })._spatialBackend.speakers
}

describe('世界虚拟声源的节目输入路由', () => {
  it('旧默认 id 缺失 route 时保持固定输入，显式路由优先', () => {
    const source = { id: 'vocal', position: { x: 4, y: 1.6, z: 3 }, gain: 1, size: 0 }
    expect(resolveMusicSourceRoute(source)).toBe('l')
    expect(resolveMusicSourceRoute({ ...source, route: 'r' })).toBe('r')
    expect(resolveMusicSourceRoute({ ...source, id: 'new' })).toBe('r')
  })

  it('声源越过正前方只改变方向；左/右/双/侧路由都接入真实输入通道', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.spatial!.mode = 'world'
    params.spatial!.instant.room = 'off'
    params.spatial!.instant.roomAmount = 0
    params.spatial!.world.sources = [
      { id: 'moving', position: { x: -2, y: 1.6, z: 4 }, route: 'l', gain: 1, size: 0 },
      { id: 'right', position: { x: 2, y: 1.6, z: 4 }, route: 'r', gain: 1, size: 0 },
      { id: 'center', position: { x: 0, y: 1.6, z: 4 }, route: 'both', gain: 1, size: 0 },
      { id: 'side', position: { x: 0, y: 1.6, z: 6 }, route: 'side', gain: 1, size: 0,
        diffuse: 1, polarity: -1 },
    ]
    engine.setParams(params)
    expect(renderedSpeakers(engine).map((speaker) => speaker.channel)).toEqual([0, 1, 0, 1, 2])
    expect(renderedSpeakers(engine).every((speaker) => speaker.propagation === false)).toBe(true)
    expect(renderedSpeakers(engine)[4]).toMatchObject({ diffuse: 1, polarity: -1 })

    params.spatial!.world.sources[0].position.x = 2
    params.spatial!.world.propagation = true
    engine.setParams(params)
    expect(renderedSpeakers(engine).map((speaker) => speaker.channel)).toEqual([0, 1, 0, 1, 2])
    expect(renderedSpeakers(engine).every((speaker) => speaker.propagation === true)).toBe(true)
    expect(renderedSpeakers(engine)[0].azimuthDeg).toBeGreaterThan(0)

    const backend = (engine as unknown as { _spatialBackend: { processMulti: (...args: unknown[]) => void } })._spatialBackend
    const multi = vi.spyOn(backend, 'processMulti')
    const left = Float32Array.from({ length: 4096 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 997 * i / fs))
    const right = new Float32Array(left.length)
    const outL = new Float32Array(left.length)
    const outR = new Float32Array(left.length)
    engine.process([left, right], [outL, outR])
    expect(multi).toHaveBeenCalled()
    const sideInput = multi.mock.calls.at(-1)?.[0] as Float32Array[]
    expect(sideInput[2].some((sample) => Math.abs(sample) > 0.01)).toBe(true)
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite)).toBe(true)
    expect(outL.some((sample) => Math.abs(sample) > 0.01)).toBe(true)
  })
})
