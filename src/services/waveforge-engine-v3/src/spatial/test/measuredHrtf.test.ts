import { describe, expect, it } from 'vitest'
import { createMeasuredHrtfGrid } from '../measuredHrtf'
import { interpolateMeasuredHrtf, nearestMeasuredIndex } from '../measuredHrtfInterp'
import { TsConvolverBackend } from '../TsConvolverBackend'
import { EngineV3 } from '../../engine/EngineV3'
import { createDefaultParams } from '../../types'
import type { HrtfGrid } from '../types'

function direction(grid: HrtfGrid, azimuth: number, elevation: number): number {
  const ring = grid.rings!.find(item => item.elevation === elevation)!
  return ring.offset + ring.azimuths.indexOf(azimuth)
}

function response(grid: HrtfGrid, azimuth: number, elevation: number): [Float32Array, Float32Array] {
  const left = new Float32Array(grid.hrirLength)
  const right = new Float32Array(grid.hrirLength)
  interpolateMeasuredHrtf(grid, azimuth, elevation, left, right)
  return [left, right]
}

function peakIndex(data: Float32Array): number {
  let index = 0
  for (let i = 1; i < data.length; i++) if (Math.abs(data[i]) > Math.abs(data[index])) index = i
  return index
}

function gainDbAt(hrir: Float32Array, frequency: number, sampleRate: number): number {
  let real = 0
  let imaginary = 0
  for (let i = 0; i < hrir.length; i++) {
    const phase = 2 * Math.PI * frequency * i / sampleRate
    real += hrir[i] * Math.cos(phase)
    imaginary -= hrir[i] * Math.sin(phase)
  }
  return 20 * Math.log10(Math.hypot(real, imaginary))
}

describe('MIT KEMAR 实测 HRTF', () => {
  it('HRIR 重采样保持频率增益，96kHz 不因系数密度翻倍而放大', () => {
    const original = response(createMeasuredHrtfGrid(44100), 0, 0)[0]
    for (const rate of [48000, 96000]) {
      const converted = response(createMeasuredHrtfGrid(rate), 0, 0)[0]
      for (const frequency of [250, 1000, 4000, 8000]) {
        expect(Math.abs(gainDbAt(converted, frequency, rate) - gainDbAt(original, frequency, 44100))).toBeLessThan(0.5)
      }
    }
  })
  it('保留 14 个原始不等距仰角环及 368 条测量，PCM 与档案值一致', () => {
    const grid = createMeasuredHrtfGrid(44100)
    expect(grid.source).toMatch(/MIT KEMAR/)
    expect(grid.rings).toHaveLength(14)
    expect(grid.rings![0].azimuths.slice(0, 4)).toEqual([-180, -174, -167, -161])
    expect(grid.rings!.find(ring => ring.elevation === 0)!.azimuths).toHaveLength(72)
    expect(grid.hrirLength).toBe(128)
    const front = direction(grid, 0, 0) * grid.hrirLength
    const right = direction(grid, 90, 0) * grid.hrirLength
    expect(grid.left[front]).toBe(5 / 32768)
    expect(grid.right[front]).toBe(5 / 32768)
    expect(grid.right[right + 5]).toBe(-20450 / 32768)
    expect(grid.left[right + 5]).toBe(-1 / 32768)
  })

  it('负方位交换双耳，正右声源的右耳主峰先于左耳', () => {
    const grid = createMeasuredHrtfGrid(44100)
    const [positiveL, positiveR] = response(grid, 90, 0)
    const [negativeL, negativeR] = response(grid, -90, 0)
    expect(positiveL).toEqual(negativeR)
    expect(positiveR).toEqual(negativeL)
    expect(peakIndex(positiveR)).toBeLessThan(peakIndex(positiveL))
  })

  it('前方 10kHz 响应接近原测量，避免旧解析 HRTF 的高频严重变暗', () => {
    const grid = createMeasuredHrtfGrid(44100)
    const [frontL, frontR] = response(grid, 0, 0)
    expect(frontL).toEqual(frontR)
    expect(gainDbAt(frontL, 10000, 44100)).toBeGreaterThan(-6)
    expect(gainDbAt(frontL, 1000, 44100)).toBeGreaterThan(-8)
  })

  it('测量点逐样本精确保留；不等距环的最近邻索引指向真实样本', () => {
    const grid = createMeasuredHrtfGrid(44100)
    for (const [azimuth, elevation] of [[0, 0], [90, 0], [-90, 0], [6, -40], [0, 90]]) {
      const index = direction(grid, azimuth, elevation) * grid.hrirLength
      const [left, right] = response(grid, azimuth, elevation)
      expect(left).toEqual(grid.left.subarray(index, index + grid.hrirLength))
      expect(right).toEqual(grid.right.subarray(index, index + grid.hrirLength))
      expect(nearestMeasuredIndex(grid, azimuth, elevation)).toBe(index / grid.hrirLength)
    }
    expect(nearestMeasuredIndex(grid, 10, -40)).toBe(direction(grid, 13, -40))
  })

  it('方向过渡与 ±180° 接缝连续，插值响应全部有限', () => {
    const grid = createMeasuredHrtfGrid(48000)
    for (const [azimuth, elevation] of [[2.5, 0], [42.5, 5], [179, -40], [-179, -40]]) {
      const [left, right] = response(grid, azimuth, elevation)
      expect(left.every(Number.isFinite)).toBe(true)
      expect(right.every(Number.isFinite)).toBe(true)
      expect(Math.max(...left.map(Math.abs), ...right.map(Math.abs))).toBeLessThan(2)
    }
    expect(response(grid, 180, 0)).toEqual(response(grid, -180, 0))
    const a = response(grid, 179.99, 0)
    const b = response(grid, -179.99, 0)
    let difference = 0
    for (let i = 0; i < grid.hrirLength; i++) difference += Math.abs(a[0][i] - b[0][i]) + Math.abs(a[1][i] - b[1][i])
    expect(difference).toBeLessThan(0.5)
  })

  it('后端的连续模式使用同一实测插值响应', () => {
    const grid = createMeasuredHrtfGrid(48000)
    const backend = new TsConvolverBackend()
    backend.loadHrtf(grid)
    backend.setConfig({ speakers: [], room: 'off', roomAmount: 0, amount: 1,
      distanceModel: 'inverse', hrtfInterp: 'spherical', convolution: 'partitioned', masterGain: 1 })
    const actual = backend.getHrir(42.5, 5)
    const [left, right] = response(grid, 42.5, 5)
    expect(actual.left).toEqual(left)
    expect(actual.right).toEqual(right)
  })

  it('EngineV3 默认装载实测网格，开启空间模式后处理结果有限且有声', () => {
    const engine = new EngineV3(48000)
    const backend = (engine as unknown as { _spatialBackend: TsConvolverBackend })._spatialBackend
    const [front] = response(createMeasuredHrtfGrid(48000), 0, 0)
    expect(backend.getHrir(0, 0).left).toEqual(front)
    const params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    params.spatial!.hrtfInterp = 'spherical'
    engine.setParams(params)
    const input = Float32Array.from({ length: 4096 }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 1000 * i / 48000))
    const outL = new Float32Array(input.length)
    const outR = new Float32Array(input.length)
    engine.process([input, input], [outL, outR])
    expect(outL.every(Number.isFinite) && outR.every(Number.isFinite)).toBe(true)
    expect(Math.max(...outL)).toBeGreaterThan(0.02)
    expect(Math.max(...outR)).toBeGreaterThan(0.02)
  })
})
