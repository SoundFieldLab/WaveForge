import { describe, expect, it, vi } from 'vitest'
import { AmbisonicDecoder } from '../src/spatial/AmbisonicDecoder'
import { HeadPoseFilter } from '../src/spatial/HeadPose'
import { CrosstalkCancellation } from '../src/spatial/CrosstalkCancellation'
import { sofaDataToGrid } from '../src/spatial/HrtfDataset'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import { roomParamsFromPreset } from '../src/spatial/roomSim'

describe('空间扩展的真实信号路径', () => {
  it('AmbiX WYZX 与 FuMa WXYZ 转换到相同双耳和虚拟扬声器信号', () => {
    const a = new AmbisonicDecoder(), b = new AmbisonicDecoder()
    const w = new Float32Array(128).fill(0.1), x = new Float32Array(128).fill(0.04)
    const y = new Float32Array(128).fill(0.02), z = new Float32Array(128).fill(-0.01)
    a.decode([w, y, z, x], 0, 128, 'ambix')
    b.decode([Float32Array.from(w, v => v / Math.SQRT2), x, y, z], 0, 128, 'fuma')
    expect(a.left[127]).toBeGreaterThan(a.right[127])
    for (let channel = 0; channel < 8; channel++) expect(a.channels[channel][127]).toBeCloseTo(b.channels[channel][127], 7)
  })
  it('标记为 FOA 的四声道真实进入引擎八方向双耳渲染', () => {
    const engine = new EngineV3(48000), p = createDefaultParams(48000)
    p.spatial.mode = 'instant'; p.spatial.inputFormat = 'ambix'; p.spatial.instant.room = 'off'
    p.eq.enabled = false; p.limiter.enabled = false; engine.setParams(p)
    const input = Array.from({ length: 4 }, (_, channel) => Float32Array.from({ length: 8192 }, (_, i) => channel === 2 ? Math.sin(i * 0.1) * 0.02 : 0))
    const output = [new Float32Array(8192), new Float32Array(8192)]
    engine.process(input, output)
    expect(output[0].every(Number.isFinite)).toBe(true)
    expect(Math.max(...output[0].subarray(4096))).toBeGreaterThan(0.0001)
  })
  it('SOFA 方位、接收器顺序及分数样本 Delay 一起转换', () => {
    const data = { convention: 'SimpleFreeFieldHRIR', rate: 48000, measurements: 2, samples: 4,
      positions: [90, 0, 1, 270, 0, 1], ir: [1, 0, 0, 0, 0.5, 0, 0, 0, 0.4, 0, 0, 0, 0.8, 0, 0, 0],
      delays: [0.5, 1], receiverLeft: 1, sourceType: 'spherical', sourceUnits: 'degree, degree, metre', name: 'test.sofa' }
    const grid = sofaDataToGrid(data, 48000)
    expect(grid.rings![0].azimuths).toEqual([-90, 90])
    expect(grid.left[1]).toBeCloseTo(0.5, 7)
    expect(grid.right[0]).toBeCloseTo(0.5, 7)
    expect(grid.right[1]).toBeCloseTo(0.5, 7)
    expect(sofaDataToGrid(data, 96000).sampleRate).toBe(96000)
    expect(() => sofaDataToGrid({ ...data, ir: data.ir.map(() => NaN) }, 48000)).toThrow()
    expect(() => sofaDataToGrid({ ...data, convention: 'Other' }, 48000)).toThrow()
  })
  it('姿态跨 ±180° 沿短路径平滑，拒绝过期/非法样本，校准恢复零角', () => {
    const filter = new HeadPoseFilter()
    expect(filter.update({ yaw: 179, pitch: 0, roll: 0 }, 100)!.yaw).toBe(179)
    expect(Math.abs(filter.update({ yaw: -179, pitch: 0, roll: 0 }, 130)!.yaw)).toBeGreaterThan(175)
    expect(filter.update({ yaw: 0, pitch: 0, roll: 0 }, 120)).toBeNull()
    expect(filter.update({ yaw: NaN, pitch: 0, roll: 0 }, 140)).toBeNull()
    expect(filter.recenter()).toEqual({ yaw: 0, pitch: 0, roll: 0 })
    expect(filter.update({ yaw: -179, pitch: 0, roll: 0 }, 160)!.yaw).toBe(0)
  })
  it('头部姿态改变实际 HRTF 方位，头锁定模式保持方向', () => {
    const engine = new EngineV3(48000), p = createDefaultParams(48000)
    p.spatial.mode = 'instant'; p.spatial.instant.room = 'off'; engine.setParams(p)
    const backend = (engine as unknown as { _spatialBackend: { setConfig: (value: any) => void } })._spatialBackend
    const spy = vi.spyOn(backend, 'setConfig')
    engine.setSpatialHeadPose({ yaw: 30, pitch: 0, roll: 0 })
    expect(spy.mock.calls.at(-1)![0].speakers[0].azimuthDeg).toBeCloseTo(-60, 5)
    p.spatial.mode = 'headLocked'; engine.setParams(p)
    engine.setSpatialHeadPose({ yaw: 45, pitch: 0, roll: 0 })
    expect(spy.mock.calls.at(-1)![0].speakers[0].azimuthDeg).toBe(0)
  })
  it('房间尺寸改变实际尺寸与 RT60', () => {
    const a = roomParamsFromPreset('stage', 2, 1)!, b = roomParamsFromPreset('stage', 2, 2)!
    expect(b.width).toBe(a.width * 2); expect(b.rt60).toBeGreaterThan(a.rt60)
  })
  it('立体声残差环境扩散真实改变 PCM，同相单声道不凭空产生残差', () => {
    const render = (enabled: boolean, mono: boolean) => {
      const engine = new EngineV3(48000), p = createDefaultParams(48000)
      p.spatial.mode = 'instant'; p.spatial.instant.room = 'off'; p.spatial.ambience = { enabled, amount: 1 }
      p.eq.enabled = false; p.limiter.enabled = false; engine.setParams(p)
      const l = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * 0.07) * 0.1)
      const r = mono ? l : Float32Array.from(l, (_, i) => Math.cos(i * 0.09) * 0.08)
      const output = [new Float32Array(l.length), new Float32Array(l.length)]; engine.process([l, r], output)
      return output
    }
    const a = render(false, false), b = render(true, false)
    let difference = 0; for (let i = 4096; i < 8192; i++) difference = Math.max(difference, Math.abs(a[0][i] - b[0][i]))
    expect(difference).toBeGreaterThan(0.0001)
    expect(render(false, true)[0].slice(4096)).toEqual(render(true, true)[0].slice(4096))
  })
  it('串扰逆滤波在对应的双音箱声学模型中降低对耳泄漏', () => {
    const fs = 48000, cancellation = new CrosstalkCancellation(fs)
    cancellation.setParams({ enabled: true, amount: 0.8, delayMs: 0.25, cutoffHz: 1800 })
    const l = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i * 2 * Math.PI * 600 / fs) * 0.1)
    const r = new Float32Array(l.length); cancellation.processStereo(l, r)
    const pole = Math.exp(-2 * Math.PI * 1800 / fs), delay = 12, strength = 0.8 * 0.65
    let low = 0, cancelled = 0, unprocessed = 0
    for (let i = 0; i < l.length; i++) {
      low = pole * low + (1 - pole) * (l[i - delay] ?? 0)
      if (i > 24000) { cancelled += (r[i] + strength * low) ** 2; unprocessed += (strength * low) ** 2 }
    }
    expect(cancelled / unprocessed).toBeLessThan(0.001)
    expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true)
  })
})
