import { describe, expect, it } from 'vitest'
import { RoomSim } from '../roomSim'
import type { VirtualSpeaker } from '../types'

describe('RoomSim 镜像源反射时序', () => {
  it('紧凑 HRIR 能量/主峰线索与完整 HRIR 产生逐位一致的反射', () => {
    const speaker: VirtualSpeaker = {
      channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1,
      gain: 1, size: 0,
    }
    const params = {
      width: 5, height: 3, depth: 4, reflectivity: 0.5, earlyOrders: 2, rt60: 0.5,
    }
    const left = Float32Array.of(0.1, 0.8, 0.2, 0)
    const right = Float32Array.of(0, 0.2, 0.7, 0.1)
    const raw = new RoomSim(48000, [speaker], params, 1, () => ({ left, right }), 512)
    const compact = new RoomSim(48000, [speaker], params, 1, () => ({
      peakL: 1, peakR: 2,
      energyL: left.reduce((sum, v) => sum + v * v, 0),
      energyR: right.reduce((sum, v) => sum + v * v, 0),
    }), 512)
    const impulse = new Float32Array(4096)
    impulse[0] = 1
    const render = (room: RoomSim) => {
      const l = new Float32Array(4096)
      const r = new Float32Array(4096)
      room.beginBlock(4096)
      room.early(0, impulse, impulse, 4096)
      room.lateAndMix(l, r, 4096)
      return { l, r }
    }
    expect(render(compact)).toEqual(render(raw))
  })

  it('声源移动后继承 FDN 尾音与已在传播的早反射', () => {
    const speaker: VirtualSpeaker = {
      id: 'source', channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0,
    }
    const moved = { ...speaker, distance: 1.2 }
    const params = { width: 5, height: 3, depth: 4, reflectivity: 0.5, earlyOrders: 1, rt60: 0.5 }
    const before = new RoomSim(48000, [speaker], params, 1)
    const impulse = new Float32Array(128)
    impulse[0] = 1
    before.beginBlock(128)
    before.early(0, impulse, impulse, 128)
    const seedL = Float32Array.from(impulse)
    const seedR = Float32Array.from(impulse)
    before.lateAndMix(seedL, seedR, 128)

    const after = new RoomSim(48000, [moved], params, 1, undefined, 0, before)
    const fresh = new RoomSim(48000, [moved], params, 1)
    const silence = new Float32Array(1024)
    const tailL = new Float32Array(1024)
    const tailR = new Float32Array(1024)
    after.beginBlock(1024)
    after.early(0, silence, silence, 1024)
    after.lateAndMix(tailL, tailR, 1024)
    const emptyL = new Float32Array(1024)
    const emptyR = new Float32Array(1024)
    fresh.beginBlock(1024)
    fresh.early(0, silence, silence, 1024)
    fresh.lateAndMix(emptyL, emptyR, 1024)
    expect(emptyL.every(value => value === 0)).toBe(true)
    expect(tailL.some(value => Math.abs(value) > 1e-4)).toBe(true)
    expect(tailR.some(value => Math.abs(value) > 1e-4)).toBe(true)
  })

  it('仅更新几何时晚期混响状态与不移动的参考处理器连续一致', () => {
    const speaker: VirtualSpeaker = {
      id: 'source', channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0,
    }
    const params = { width: 5, height: 3, depth: 4, reflectivity: 0.5, earlyOrders: 0, rt60: 0.5 }
    const before = new RoomSim(48000, [speaker], params, 1)
    const reference = new RoomSim(48000, [speaker], params, 1)
    const impulse = new Float32Array(128)
    impulse[0] = 1
    for (const room of [before, reference]) {
      room.beginBlock(128)
      room.early(0, impulse, impulse, 128)
      room.lateAndMix(Float32Array.from(impulse), Float32Array.from(impulse), 128)
    }
    const after = new RoomSim(48000, [{ ...speaker, distance: 1.2 }], params, 1, undefined, 0, before)
    const actualL = new Float32Array(512)
    const actualR = new Float32Array(512)
    const expectedL = new Float32Array(512)
    const expectedR = new Float32Array(512)
    after.beginBlock(512)
    reference.beginBlock(512)
    after.lateAndMix(actualL, actualR, 512)
    reference.lateAndMix(expectedL, expectedR, 512)
    expect(actualL).toEqual(expectedL)
    expect(actualR).toEqual(expectedR)
    expect(actualL.some(value => value !== 0)).toBe(true)
  })

  it('第一道反射在直达与镜像路程差对应的时间到达，最长延迟不串到当前样本', () => {
    const speaker: VirtualSpeaker = {
      channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0,
    }
    const fs = 48000
    const room = new RoomSim(fs, [speaker], {
      width: 5, height: 3, depth: 4, reflectivity: 0.5, earlyOrders: 1, rt60: 0.5,
    }, 1)
    const input = new Float32Array(1024)
    input[0] = 1
    const outputL = new Float32Array(input.length)
    const outputR = new Float32Array(input.length)
    room.beginBlock(input.length)
    room.early(0, input, input, input.length)
    room.lateAndMix(outputL, outputR, input.length)
    // 正前 1m，前墙镜像路径 3m，额外 2m → round(2/c·fs)=280 样本。
    const firstArrival = Math.round(2 / 343 * fs)
    expect(outputL.subarray(0, firstArrival).every(value => value === 0)).toBe(true)
    expect(outputR.subarray(0, firstArrival).every(value => value === 0)).toBe(true)
    const expectedFrontWall = (0.5 / 3) * (1 - Math.exp(-2 * Math.PI * 4000 / fs))
    expect(outputL[firstArrival]).toBeCloseTo(expectedFrontWall, 5)
    expect(outputL.every(Number.isFinite) && outputR.every(Number.isFinite)).toBe(true)
  })

  it('镜像方向双耳线索独立于直达声，并与卷积延迟对齐', () => {
    const speaker: VirtualSpeaker = {
      channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0,
    }
    const seen: number[] = []
    const room = new RoomSim(48000, [speaker], {
      width: 100, height: 100, depth: 4, reflectivity: 0.5, earlyOrders: 1, rt60: 0.5,
    }, 1, (az) => {
      seen.push(az)
      return { left: Float32Array.of(1, 0, 0, 0), right: Float32Array.of(0, 0, 0, 1) }
    }, 512)
    const input = new Float32Array(1024)
    input[0] = 1
    const left = new Float32Array(1024)
    const right = new Float32Array(1024)
    room.beginBlock(input.length)
    room.early(0, input, input, input.length)
    room.lateAndMix(left, right, input.length)
    const arrival = 512 + Math.round(2 / 343 * 48000)
    expect(left.subarray(0, arrival).every(v => v === 0)).toBe(true)
    expect(right.subarray(0, arrival + 3).every(v => v === 0)).toBe(true)
    expect(left[arrival]).toBeGreaterThan(0.01)
    expect(right[arrival]).toBe(0)
    expect(right[arrival + 3]).toBeCloseTo(left[arrival], 6)
    expect(seen.some(az => az < -45) && seen.some(az => az > 45)).toBe(true)
  })

  it('靠左墙的首个反射使用左侧镜像方向的双耳能量比', () => {
    const speaker: VirtualSpeaker = {
      channel: 0, azimuthDeg: -90, elevationDeg: 0, distance: 1, gain: 1, size: 0,
    }
    const room = new RoomSim(48000, [speaker], {
      width: 4, height: 100, depth: 100, reflectivity: 0.5, earlyOrders: 1, rt60: 0.5,
    }, 1, az => az < 0
      ? { left: Float32Array.of(2), right: Float32Array.of(1) }
      : { left: Float32Array.of(1), right: Float32Array.of(2) })
    const input = new Float32Array(1024)
    input[0] = 1
    const left = new Float32Array(1024)
    const right = new Float32Array(1024)
    room.beginBlock(input.length)
    room.early(0, input, input, input.length)
    room.lateAndMix(left, right, input.length)
    const arrival = Math.round(2 / 343 * 48000)
    expect(left[arrival]).toBeGreaterThan(0)
    expect(left[arrival] / right[arrival]).toBeCloseTo(2, 5)
  })
})
