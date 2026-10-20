import { describe, expect, it, vi } from 'vitest'
import { TsConvolverBackend } from '../TsConvolverBackend'
import { generateAnalyticHrtfGrid } from '../analyticHrtf'

function backend(convolution: 'partitioned' | 'time') {
  const value = new TsConvolverBackend()
  value.loadHrtf(generateAnalyticHrtfGrid(48000))
  value.setConfig({ roomAmount: 0, distanceModel: 'inverse', hrtfInterp: 'spherical', masterGain: 1, speakers: [
    { channel: 0, azimuthDeg: -30, elevationDeg: 0, distance: 1, gain: .6, size: 0 },
    { channel: 1, azimuthDeg: 30, elevationDeg: 0, distance: 1, gain: .6, size: 0 },
  ], amount: .7, room: 'off', convolution })
  return value
}

describe('空间后端短块工作视图', () => {
  it.each(['partitioned', 'time'] as const)('%s稳态在不同短块长间切换不创建typed-array视图', mode => {
    const value = backend(mode)
    const counts = [128, 17, 31, 64, 1, 127]
    const inputs = counts.map(count => new Float32Array(count).fill(.02))
    const outputs = counts.map(count => [new Float32Array(count), new Float32Array(count)])
    for (let block = 0; block < 20; block++)
      value.processStereo(inputs[0], inputs[0], outputs[0][0], outputs[0][1])
    const views = vi.spyOn(Float32Array.prototype, 'subarray')
    try {
      for (let round = 0; round < 3; round++) for (let at = 0; at < counts.length; at++)
        value.processStereo(inputs[at], inputs[at], outputs[at][0], outputs[at][1])
      expect(views).not.toHaveBeenCalled()
    } finally { views.mockRestore() }
  })
  it.each(['partitioned', 'time'] as const)('%s短块、先扩容大块再回短块均与逐样本输出一致', mode => {
    const actual = backend(mode), reference = backend(mode)
    const left = Float32Array.from({ length: 3079 }, (_, i) => Math.sin(i * .083) * .05)
    const right = Float32Array.from(left, (value, i) => value * Math.cos(i * .017))
    const result = [new Float32Array(left.length), new Float32Array(left.length)]
    const expected = [new Float32Array(left.length), new Float32Array(left.length)]
    const lengths = [128, 17, 1024, 31, 64, 1, 127]
    let pos = 0, block = 0
    while (pos < left.length) {
      const n = Math.min(lengths[block++ % lengths.length], left.length - pos)
      actual.processStereo(left.subarray(pos, pos + n), right.subarray(pos, pos + n),
        result[0].subarray(pos, pos + n), result[1].subarray(pos, pos + n))
      pos += n
    }
    for (let i = 0; i < left.length; i++)
      reference.processStereo(left.subarray(i, i + 1), right.subarray(i, i + 1),
        expected[0].subarray(i, i + 1), expected[1].subarray(i, i + 1))
    expect(result).toEqual(expected)
  })
})
