import { describe, expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { RoomSim, type RoomSimParams } from '../roomSim'
import type { VirtualSpeaker } from '../types'

const speakers: VirtualSpeaker[] = Array.from({ length: 8 }, (_, channel) => ({
  channel, azimuthDeg: channel * 45 - 180, elevationDeg: channel % 2 ? 15 : -10,
  distance: 1.3, gain: 1, size: 0,
}))
const params: RoomSimParams = {
  width: 6, height: 3, depth: 5, reflectivity: 0.6, earlyOrders: 3,
  rt60: 1.1, spectralEarly: true,
}
function hrir(azimuth: number) {
  const angle = azimuth * Math.PI / 180
  return {
    left: Float32Array.from({ length: 256 }, (_, i) => Math.exp(-i / 40) * Math.cos(i * .39 + angle) * .1),
    right: Float32Array.from({ length: 256 }, (_, i) => Math.exp(-i / 45) * Math.sin(i * .31 - angle) * .1),
  }
}
function median(values: number[]) {
  return values.sort((a, b) => a - b)[values.length >> 1]
}

// 显式启用的诊断微基准；只报告测量，不以宿主机器墙钟速度作为测试门槛。
describe.skipIf(process.env.RUN_ROOM_BENCH !== '1')('完整三阶频谱房间微基准', () => {
  for (const mono of [false, true]) for (const rate of [48000, 96000, 192000]) it(`${rate}Hz ${mono ? '共同输入' : '独立输入'} prepared 接管与 8 声源稳态`, () => {
    const producer = new RoomSim(rate, speakers, params, .7, hrir)
    const prepared = producer.createPreparedEarlyTransfer()!
    expect(prepared.speakers).toHaveLength(8)
    const adoption: number[] = []
    let room = producer
    for (let repeat = 0; repeat < 15; repeat++) {
      const transfer = structuredClone(prepared)
      const started = performance.now()
      room = new RoomSim(rate, speakers, params, .7, undefined, 0, undefined, true, undefined, transfer)
      adoption.push(performance.now() - started)
    }
    const inputL = Float32Array.from({ length: 128 }, (_, i) => .1 * Math.sin(i * .21))
    const inputR = Float32Array.from({ length: 128 }, (_, i) => .1 * Math.cos(i * .17))
    const wetL = new Float32Array(128), wetR = new Float32Array(128)
    const early: number[] = [], late: number[] = []
    for (let run = 0; run < 7; run++) {
      let started = performance.now()
      for (let block = 0; block < 120; block++) {
        room.beginBlock(128)
        for (let source = 0; source < 8; source++) room.early(source, inputL, mono ? inputL : inputR, 128)
      }
      const elapsed = performance.now() - started
      if (run > 1) early.push(elapsed / 120)
      started = performance.now()
      for (let block = 0; block < 500; block++) {
        wetL.set(inputL); wetR.set(inputR)
        room.lateAndMix(wetL, wetR, 128)
      }
      if (run > 1) late.push((performance.now() - started) / 500)
    }
    expect(wetL.every(Number.isFinite) && wetR.every(Number.isFinite)).toBe(true)
    process.stdout.write(JSON.stringify({ rate, mono, adoptionMedianMs: median(adoption.slice(3)),
      earlyMedianMsPer128: median(early), lateMedianMsPer128: median(late),
      partitions: prepared.speakers.map(s => s?.partitionCount),
      activePartitions: prepared.speakers.map(s => s?.activePartitions.length) }) + '\n')
  })
})
