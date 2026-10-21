import { describe, expect, it, vi } from 'vitest'
import { TsConvolverBackend } from '../TsConvolverBackend'
import { createMeasuredHrtfGrid } from '../measuredHrtf'
import * as measuredInterpolation from '../measuredHrtfInterp'
import { prepareHrtfGrid } from '../HrtfDataset'
import type { SpatialRenderConfig } from '../types'

describe('直达声预准备接管不重复方向插值', () => {
  it('同采样率数据集保留逐位系数并独占复制，后续调用方修改不污染已准备数据', () => {
    const grid = createMeasuredHrtfGrid(48000)
    const prepared = prepareHrtfGrid(grid, 48000)
    expect(prepared.left).toEqual(grid.left); expect(prepared.right).toEqual(grid.right)
    expect(prepared.left.buffer).not.toBe(grid.left.buffer)
    expect(prepared.right.buffer).not.toBe(grid.right.buffer)
    const old = prepared.left[0]
    grid.left[0] += 0.5
    expect(prepared.left[0]).toBe(old)
  })
  it.each([48000, 96000])('同采样率和重采样路径均拒绝末端非法系数及静音方向（%i）', rate => {
    const grid = createMeasuredHrtfGrid(48000)
    grid.right[grid.right.length - 1] = NaN
    expect(() => prepareHrtfGrid(grid, rate)).toThrow()
    grid.right[grid.right.length - 1] = 0
    grid.left.fill(0, 0, grid.hrirLength); grid.right.fill(0, 0, grid.hrirLength)
    expect(() => prepareHrtfGrid(grid, rate)).toThrow('全静音方向')
  })
  it.each(['missing', 'length', 'nonfinite', 'silent', 'oversized'])('时域缓存%s无效时仍回退本地方向插值', invalid => {
    const producer = new TsConvolverBackend(), consumer = new TsConvolverBackend()
    const grid = createMeasuredHrtfGrid(48000)
    producer.loadHrtf(grid); consumer.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1, roomAmount: 0, speakers: [
      { id: 'L', channel: 0, azimuthDeg: -31, elevationDeg: 7, distance: 1, gain: 0.6, size: 0 },
    ], hrtfInterp: 'spherical', amount: 1, room: 'off' }
    producer.setConfig(config)
    const packet = structuredClone(producer.takePreparedRoomHrir(true)!)
    const hrirs = packet.direct!.hrirs!
    if (invalid === 'missing') delete packet.direct!.hrirs
    if (invalid === 'length') hrirs[0][1] = new Float32Array(1)
    if (invalid === 'nonfinite') hrirs[0][1][0] = NaN
    if (invalid === 'silent') hrirs[0][1].fill(0)
    if (invalid === 'oversized') packet.direct!.hrirs = Array.from({ length: 129 }, () => hrirs[0])
    consumer.primeRoomHrir(packet)
    const interpolation = vi.spyOn(measuredInterpolation, 'interpolateMeasuredHrtf')
    try { consumer.setConfig(config); expect(interpolation).toHaveBeenCalledOnce() }
    finally { interpolation.mockRestore() }
    const input = new Float32Array(128).fill(0.03)
    const actual = [new Float32Array(128), new Float32Array(128)]
    const expected = [new Float32Array(128), new Float32Array(128)]
    for (let block = 0; block < 20; block++) {
      consumer.processStereo(input, input, actual[0], actual[1])
      producer.processStereo(input, input, expected[0], expected[1])
      expect(actual).toEqual(expected)
    }
  })
  it('新建、连续移动、大小变化均接管精确时域IR，PCM与本地准备一致', () => {
    const grid = createMeasuredHrtfGrid(192000)
    const producer = new TsConvolverBackend(), consumer = new TsConvolverBackend(), reference = new TsConvolverBackend()
    for (const backend of [producer, consumer, reference]) backend.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1, roomAmount: 0, speakers: [
      { id: 'L', channel: 0, azimuthDeg: -31, elevationDeg: 7, distance: 1, gain: 0.6, size: 0 },
      { id: 'R', channel: 1, azimuthDeg: 42, elevationDeg: 13, distance: 1, gain: 0.6, size: 0.4 },
    ], hrtfInterp: 'spherical', amount: 1, room: 'off' }
    const input = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.07) * 0.03)
    const actual = [new Float32Array(128), new Float32Array(128)]
    const expected = [new Float32Array(128), new Float32Array(128)]
    for (let step = 0; step < 4; step++) {
      config.speakers[0].azimuthDeg += 5
      config.speakers[1].size += 0.05
      producer.setConfig(config)
      reference.setConfig(config)
      const packet = structuredClone(producer.takePreparedRoomHrir(true)!)
      consumer.primeRoomHrir(packet)
      const interpolation = vi.spyOn(measuredInterpolation, 'interpolateMeasuredHrtf')
      try {
        consumer.setConfig(config)
        expect(interpolation).not.toHaveBeenCalled()
      } finally { interpolation.mockRestore() }
      for (let block = 0; block < 20; block++) {
        consumer.processStereo(input, input, actual[0], actual[1])
        reference.processStereo(input, input, expected[0], expected[1])
        expect(actual).toEqual(expected)
      }
    }
  })
})
