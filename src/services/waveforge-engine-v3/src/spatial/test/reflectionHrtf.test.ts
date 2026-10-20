import { describe, expect, it } from 'vitest'
import { RoomSim, type RoomSimParams } from '../roomSim'
import type { VirtualSpeaker } from '../types'

const fs = 48000
const speakers: VirtualSpeaker[] = [{ channel: 0, azimuthDeg: 0, elevationDeg: 0, distance: 1, gain: 1, size: 0 }]
const params: RoomSimParams = { width: 10, height: 10, depth: 10, reflectivity: 0.5, earlyOrders: 1, rt60: 0.4, spectralEarly: true }
const hrir = { left: new Float32Array([1, 0.5, -0.5]), right: new Float32Array([0.7, -0.4, 0.2]) }

function render(room: RoomSim, input: Float32Array, sizes: number[], right = input): [Float32Array, Float32Array] {
  const outL = new Float32Array(input.length), outR = new Float32Array(input.length)
  let offset = 0, block = 0
  while (offset < input.length) {
    const count = Math.min(sizes[block++ % sizes.length], input.length - offset)
    const part = input.subarray(offset, offset + count)
    room.beginBlock(count); room.early(0, part, right.subarray(offset, offset + count), count)
    const bus = room as unknown as { earlyL: Float32Array; earlyR: Float32Array }
    outL.set(bus.earlyL.subarray(0, count), offset); outR.set(bus.earlyR.subarray(0, count), offset)
    offset += count
  }
  return [outL, outR]
}

function manualImpulse(ir: Float32Array, length: number, directLatency = 0): Float32Array {
  const result = new Float32Array(length)
  const distances = [Math.sqrt(101), Math.sqrt(101), Math.sqrt(101), Math.sqrt(101), 11, 9]
  const pole = Math.exp(-2 * Math.PI * 4000 / fs)
  for (const distance of distances) {
    const delay = Math.round((distance - 1) * fs / 343) + directLatency
    const gain = 0.5 / distance
    let state = 0
    for (let i = 0; i < length - delay; i++) {
      state = (1 - pole) * (ir[i] ?? 0) + pole * state
      result[delay + i] += state * gain
    }
  }
  return result
}

describe('完整 HRIR 早期反射', () => {
  it('共享输入 FFT 与逐耳独立前向变换逐位相同，任意调用边界及非共轭预计算频谱也保持一致', () => {
    const producer = new RoomSim(fs, speakers, params, 1, () => hrir)
    const transfer = producer.createPreparedEarlyTransfer()!
    // 接管合同容许任意复数频谱；不能依赖生成器恰好产生共轭对称谱来丢弃半谱。
    transfer.speakers[0]!.irRealL[139] += .3
    transfer.speakers[0]!.irImagR[201] -= .2
    const make = () => new RoomSim(fs, speakers, params, 1, undefined, 0, undefined, true, undefined,
      structuredClone(transfer))
    const input = Float32Array.from({ length: 8192 }, (_, i) => .11 * Math.sin(.193 * i) + .03 * Math.cos(.071 * i))
    const zero = new Float32Array(input.length)
    const sizes = [1, 7, 197, 31, 63]
    const mono = render(make(), input, sizes)
    const leftOnly = render(make(), input, sizes, zero)
    const rightOnly = render(make(), zero, sizes, input)
    expect(mono[0]).toEqual(leftOnly[0])
    expect(mono[1]).toEqual(rightOnly[1])
  })

  it('相同/不同双耳输入在 FFT 分区中间切换、移动接管和 reset 保留逐耳历史', () => {
    const make = () => new RoomSim(fs, speakers, params, 1, () => hrir)
    const inputL = Float32Array.from({ length: 8192 }, (_, i) => .1 * Math.sin(i * .17))
    const inputR = Float32Array.from(inputL, (x, i) => i % 389 < 193 ? x : Math.cos(i * .23) * .1)
    const expected = render(make(), inputL, [128], inputR)
    const room = make()
    expect(render(room, inputL, [3, 79, 127, 197, 1], inputR)).toEqual(expected)
    room.reset()
    expect(render(room, inputL, [128], inputR)).toEqual(expected)

    const before = make()
    const split = 389 // 分区前五个输入不等、后续相等；接管不能错误地把分区标为相同。
    const first = render(before, inputL.subarray(0, split), [split], inputR.subarray(0, split))
    const transfer = new RoomSim(fs, speakers, params, 1, () => hrir).createPreparedEarlyTransfer()!
    const after = new RoomSim(fs, speakers, params, 1, undefined, 0, before, false, undefined, transfer)
    const rest = render(after, inputL.subarray(split), [7, 128, 31], inputR.subarray(split))
    for (let ear = 0; ear < 2; ear++) {
      const combined = new Float32Array(inputL.length)
      combined.set(first[ear]); combined.set(rest[ear], split)
      expect(combined).toEqual(expected[ear])
    }
  })

  it('完整双耳 IR 保留负瓣和峰后频谱，与手工六镜像卷积参考对齐', () => {
    const latency = 37
    const room = new RoomSim(fs, speakers, params, 1, () => hrir, latency)
    const input = new Float32Array(4096); input[0] = 1
    const output = render(room, input, [128])
    expect(room.earlyReflectionMode).toBe('spectral')
    expect(room.spectralFallbackReason).toBeNull()
    for (let ear = 0; ear < 2; ear++) {
      const expected = manualImpulse(ear === 0 ? hrir.left : hrir.right, input.length, latency)
      let maxError = 0
      for (let i = 0; i < input.length; i++) maxError = Math.max(maxError, Math.abs(expected[i] - output[ear][i]))
      expect(maxError).toBeLessThan(1e-6)
    }
  })

  it('相同能量和主峰但不同负瓣的 HRIR 在谱模式产生不同结果', () => {
    const a = new RoomSim(fs, speakers, params, 1, () => hrir)
    const b = new RoomSim(fs, speakers, params, 1, () => ({
      left: new Float32Array([1, -0.5, 0.5]), right: hrir.right,
    }))
    const impulse = new Float32Array(4096); impulse[0] = 1
    const first = render(a, impulse, [128]), second = render(b, impulse, [128])
    let difference = 0
    for (let i = 0; i < impulse.length; i++) difference += Math.abs(first[0][i] - second[0][i])
    expect(difference).toBeGreaterThan(0.01)
    expect(first[1]).toEqual(second[1])
  })

  it('跨不规则调用块长、零延迟直接头部和 reset 保持确定性', () => {
    const small: RoomSimParams = { ...params, width: 0.4, height: 0.4, depth: 0.4 }
    const make = () => new RoomSim(fs, speakers, small, 1, () => hrir)
    const input = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.17) * 0.1)
    const a = render(make(), input, [128]), room = make()
    const b = render(room, input, [1, 7, 31, 197, 64])
    for (let ear = 0; ear < 2; ear++)
      for (let i = 0; i < input.length; i++) expect(b[ear][i]).toBeCloseTo(a[ear][i], 7)
    room.reset()
    expect(render(room, input, [128])).toEqual(a)
  })

  it('控制线程准备的频谱和缓冲可转移接管，无需接收侧 HRIR 查询', () => {
    const producer = new RoomSim(fs, speakers, params, 1, () => hrir)
    const prepared = structuredClone(producer.createPreparedEarlyTransfer()!)
    let calls = 0
    const consumer = new RoomSim(fs, speakers, params, 1, () => { calls++; return hrir }, 0, undefined, true, undefined, prepared)
    expect(calls).toBe(0)
    expect(consumer.earlyReflectionMode).toBe('spectral')
    const input = Float32Array.from({ length: 4096 }, (_, i) => Math.cos(i * 0.21) * 0.1)
    expect(render(consumer, input, [128])).toEqual(render(producer, input, [128]))
    const stale = new RoomSim(fs, speakers, { ...params, width: 11 }, 1,
      () => { calls++; return hrir }, 0, undefined, true, undefined, prepared)
    expect(calls).toBeGreaterThan(0)
    expect(stale.earlyReflectionMode).toBe('spectral')
  })

  it('只收到 cues 时显式回退；默认快速模式输出保持一致', () => {
    const cues = { peakL: 0, peakR: 0, energyL: 1, energyR: 1 }
    const fallback = new RoomSim(fs, speakers, params, 1, () => cues)
    const fast = new RoomSim(fs, speakers, { ...params, spectralEarly: false }, 1, () => cues)
    expect(fallback.earlyReflectionMode).toBe('cues')
    expect(fallback.spectralFallbackReason).toContain('回退')
    expect(fallback.createPreparedEarlyTransfer()).toBeUndefined()
    const input = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.13))
    expect(render(fallback, input, [128])).toEqual(render(fast, input, [128]))
  })

  it('畸形预计算缓冲与越界分区会回退本地准备，不使处理器抛出', () => {
    const producer = new RoomSim(fs, speakers, params, 1, () => hrir)
    const original = producer.createPreparedEarlyTransfer()!
    const mutations = [
      (data: NonNullable<typeof original.speakers[0]>) => { data.partitionCount = 100000 },
      (data: NonNullable<typeof original.speakers[0]>) => { data.workReal = new Float32Array(3) },
      (data: NonNullable<typeof original.speakers[0]>) => { data.headL = new Float64Array(128) as unknown as Float32Array },
      (data: NonNullable<typeof original.speakers[0]>) => { data.activePartitions = new Int32Array([-1]) },
      (data: NonNullable<typeof original.speakers[0]>) => { data.activePartitions = new Int32Array([data.partitionCount]) },
      (data: NonNullable<typeof original.speakers[0]>) => { data.headR[0] = NaN },
    ]
    for (const mutate of mutations) {
      const prepared = structuredClone(original)
      mutate(prepared.speakers[0]!)
      let calls = 0
      const room = new RoomSim(fs, speakers, params, 1, () => { calls++; return hrir }, 0, undefined, true, undefined, prepared)
      expect(calls).toBeGreaterThan(0)
      expect(room.earlyReflectionMode).toBe('spectral')
      expect(room.spectralFallbackReason).toContain('无效')
      const impulse = new Float32Array(4096); impulse[0] = 1
      expect(render(room, impulse, [128])[0].every(Number.isFinite)).toBe(true)
    }
  })
})
