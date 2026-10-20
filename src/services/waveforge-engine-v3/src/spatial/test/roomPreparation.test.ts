import { describe, expect, it, vi } from 'vitest'
import { TsConvolverBackend } from '../TsConvolverBackend'
import { createMeasuredHrtfGrid } from '../measuredHrtf'
import { BinauralConvolver } from '../BinauralConvolver'
import type { SpatialRenderConfig } from '../types'

describe('主线程准备房间 HRIR 线索', () => {
  it('精确线索跨线程后避免重复插值，并保持移动声源的 PCM 逐位一致', () => {
    const grid = createMeasuredHrtfGrid(96000)
    const producer = new TsConvolverBackend()
    const consumer = new TsConvolverBackend()
    const reference = new TsConvolverBackend()
    for (const backend of [producer, consumer, reference]) backend.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1,
      speakers: [{ id: 'moving', channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1, gain: 1, size: 0 }],
      room: 'hall', roomAmount: 0.5, amount: 0.5, hrtfInterp: 'spherical',
    }
    const tone = Float32Array.from({ length: 128 }, (_, i) => 0.1 * Math.sin(i * 0.13))
    const actualL = new Float32Array(128), actualR = new Float32Array(128)
    const expectedL = new Float32Array(128), expectedR = new Float32Array(128)
    for (let step = 0; step < 6; step++) {
      config.speakers[0].azimuthDeg += 0.8
      producer.setConfig(config)
      const prepared = producer.takePreparedRoomHrir(step === 0)
      expect(prepared?.entries.length).toBeGreaterThan(0)
      consumer.primeRoomHrir(structuredClone(prepared!))
      consumer.setConfig(config)
      // 消费者无需补算任何方向；不能只用有限输出掩盖未命中预计算的情况。
      expect(consumer.takePreparedRoomHrir()).toBeUndefined()
      reference.setConfig(config)
      for (let block = 0; block < 12; block++) {
        consumer.processStereo(tone, tone, actualL, actualR)
        reference.processStereo(tone, tone, expectedL, expectedR)
        expect(actualL).toEqual(expectedL)
        expect(actualR).toEqual(expectedR)
      }
    }
    const cold = new TsConvolverBackend()
    cold.loadHrtf(grid)
    cold.primeRoomHrir(producer.takePreparedRoomHrir(true)!)
    cold.setConfig(config)
    expect(cold.takePreparedRoomHrir()).toBeUndefined()
  })

  it('错误采样率、伪造生产端序号的条目或不同网格的数据不进入接收方缓存', () => {
    const grid = createMeasuredHrtfGrid(48000)
    const backend = new TsConvolverBackend()
    backend.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1,
      speakers: [{ channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1, gain: 1, size: 0 }],
      room: 'hall', roomAmount: 0.5, amount: 0.5, hrtfInterp: 'spherical',
    }
    backend.setConfig(config)
    const prepared = backend.takePreparedRoomHrir(true)!
    const cold = new TsConvolverBackend()
    cold.loadHrtf(grid)
    cold.primeRoomHrir({ ...prepared, sampleRate: 96000 })
    cold.primeRoomHrir({ ...prepared, revision: prepared.revision + 1 })
    cold.setConfig(config)
    expect(cold.takePreparedRoomHrir()?.entries.length).toBeGreaterThan(0)
    const otherGrid = { ...grid, left: grid.left.slice() }
    otherGrid.left[0] += 0.5
    const other = new TsConvolverBackend()
    other.loadHrtf(otherGrid)
    other.primeRoomHrir(prepared)
    other.setConfig(config)
    expect(other.takePreparedRoomHrir()?.entries.length).toBeGreaterThan(0)
  })

  it.each([[3, 1], [1, 3]])('两端相同网格装载次数不同 (%i/%i) 时映射为接收端本地缓存键', (producerLoads, consumerLoads) => {
    const grid = createMeasuredHrtfGrid(48000)
    const producer = new TsConvolverBackend(), consumer = new TsConvolverBackend()
    for (let i = 0; i < producerLoads; i++) producer.loadHrtf(grid)
    for (let i = 0; i < consumerLoads; i++) consumer.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1,
      speakers: [{ channel: 0, azimuthDeg: -22, elevationDeg: 13, distance: 1, gain: 1, size: 0 }],
      room: 'studio', roomAmount: 0.5, amount: 0.5, hrtfInterp: 'spherical',
    }
    producer.setConfig(config)
    const prepared = producer.takePreparedRoomHrir(true)!
    expect(prepared.revision).toBe(producerLoads)
    consumer.primeRoomHrir(structuredClone(prepared))
    consumer.setConfig(config)
    // 没有缓存 miss 新增条目，也没有直接 IR 回退重新准备。
    expect(consumer.takePreparedRoomHrir()).toBeUndefined()
    const transferredAgain = consumer.takePreparedRoomHrir(true)!
    expect(transferredAgain.revision).toBe(consumerLoads)
    expect(transferredAgain.entries.length).toBeGreaterThan(0)
    expect(transferredAgain.entries.every(([key]) => key.startsWith(`${consumerLoads}|spherical|`))).toBe(true)
  })

  it.each(['same-rate-rebuild', 'coalesced-grid-updates'] as const)('%s 的 direct 和 spectral 数据均实际接管，不回退 IR FFT/反射 HRIR 查询', scenario => {
    const grid = createMeasuredHrtfGrid(48000)
    const first = { ...grid, left: Float32Array.from(grid.left, value => value * 0.9), right: grid.right.slice() }
    const final = { ...grid, left: Float32Array.from(grid.left, value => value * 0.75), right: grid.right.slice() }
    const producer = new TsConvolverBackend(), consumer = new TsConvolverBackend(), reference = new TsConvolverBackend()
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1,
      speakers: [{ id: 'source', channel: 0, azimuthDeg: -28, elevationDeg: 9, distance: 1, gain: 1, size: 0 }],
      room: 'studio', roomAmount: 0.5, amount: 0.6, hrtfInterp: 'spherical',
      earlyReflectionOrders: 1, earlyReflectionModel: 'spectral',
    }
    producer.loadHrtf(grid)
    if (scenario === 'same-rate-rebuild') {
      producer.setConfig(config)
      producer.loadHrtf(grid, true)
      consumer.loadHrtf(grid)
      reference.loadHrtf(grid)
    } else {
      // 生产端两次更新，接收端只处理最后一条；实际数据仍完全相同。
      producer.loadHrtf(first, true); producer.loadHrtf(final, true)
      consumer.loadHrtf(grid); consumer.loadHrtf(final, true)
      reference.loadHrtf(final)
    }
    producer.setConfig(config)
    reference.setConfig(config)
    const payload = structuredClone(producer.takePreparedRoomHrir(true)!)
    expect(payload.early?.speakers[0]).toBeTruthy()
    expect(payload.direct?.entries).toHaveLength(1)
    consumer.primeRoomHrir(payload)
    const query = vi.spyOn(consumer, 'getHrir')
    const regularLoad = vi.spyOn(BinauralConvolver.prototype, 'loadIR')
    const regularUpdate = vi.spyOn(BinauralConvolver.prototype, 'updateIR')
    try {
      consumer.setConfig(config)
      expect(query).not.toHaveBeenCalled()
      expect(regularLoad).not.toHaveBeenCalled()
      expect(regularUpdate).not.toHaveBeenCalled()
      const internal = consumer as unknown as {
        convDual: Array<{ irRealL: Float32Array }>
        room: { states: Array<{ spectral: { data: unknown } }> }
      }
      expect(internal.convDual[0].irRealL).toBe(payload.direct!.entries[0][1].irRealL)
      expect(internal.room.states[0].spectral.data).toBe(payload.early!.speakers[0])
      const tone = Float32Array.from({ length: 128 }, (_, i) => 0.05 * Math.sin(i * 0.09))
      const actualL = new Float32Array(128), actualR = new Float32Array(128)
      const expectedL = new Float32Array(128), expectedR = new Float32Array(128)
      for (let block = 0; block < 16; block++) {
        consumer.processStereo(tone, tone, actualL, actualR)
        reference.processStereo(tone, tone, expectedL, expectedR)
        expect(actualL).toEqual(expectedL)
        expect(actualR).toEqual(expectedR)
      }
    } finally {
      query.mockRestore(); regularLoad.mockRestore(); regularUpdate.mockRestore()
    }
  })

  it('拒收非法生产端 revision，且不能把与声明 revision 不符的缓存键映射到本地', () => {
    const grid = createMeasuredHrtfGrid(48000)
    const producer = new TsConvolverBackend()
    producer.loadHrtf(grid)
    const config: SpatialRenderConfig = { distanceModel: 'inverse', convolution: 'partitioned', masterGain: 1,
      speakers: [{ channel: 0, azimuthDeg: -24, elevationDeg: 7, distance: 1, gain: 1, size: 0 }],
      room: 'studio', roomAmount: 0.5, amount: 0.5, hrtfInterp: 'spherical',
    }
    producer.setConfig(config)
    const prepared = producer.takePreparedRoomHrir(true)!
    for (const revision of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const consumer = new TsConvolverBackend()
      consumer.loadHrtf(grid)
      consumer.primeRoomHrir({ ...prepared, revision })
      const cached = consumer.takePreparedRoomHrir(true)
      expect(cached).toBeUndefined()
    }
    const consumer = new TsConvolverBackend()
    consumer.loadHrtf(grid); consumer.loadHrtf(grid)
    consumer.primeRoomHrir({ ...prepared, revision: prepared.revision + 5, early: undefined, direct: undefined })
    expect(consumer.takePreparedRoomHrir(true)).toBeUndefined()
  })
})
