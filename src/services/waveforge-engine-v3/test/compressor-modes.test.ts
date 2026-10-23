import { describe, expect, it } from 'vitest'
import { Compressor } from '../src/dsp/Compressor'
import { MultibandCompressor } from '../src/dsp/MultibandCompressor'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

const fs = 48000

describe('压缩器模式', () => {
  it('向上压缩会提升阈值以下的弱声，向下压缩行为保持不变', () => {
    const up = new Compressor(fs)
    up.setParams({ enabled: true, mode: 'upward', thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 50, makeupDb: 0, outputGain: 1 })
    const down = new Compressor(fs)
    down.setParams({ enabled: true, mode: 'downward', thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 1, releaseMs: 50, makeupDb: 0, outputGain: 1 })
    const l = new Float32Array(fs)
    const r = new Float32Array(fs)
    l.fill(0.01); r.fill(0.01)
    const dl = l.slice(); const dr = r.slice()
    up.processStereo(l, r)
    down.processStereo(dl, dr)
    expect(Math.abs(l[fs - 1])).toBeGreaterThan(Math.abs(dl[fs - 1]) * 1.8)
    expect(up.getReductionDb()).toBeLessThan(0)
    expect(down.getReductionDb()).toBe(0)
  })

  it('向上模式处理静音保持有限，并限制弱声最大提升量', () => {
    const compressor = new Compressor(fs)
    compressor.setParams({ enabled: true, mode: 'upward', thresholdDb: -20, ratio: 4, kneeDb: 0,
      attackMs: 1, releaseMs: 50, makeupDb: 0, outputGain: 1, upwardMaxGainDb: 12 })
    const silentL = new Float32Array(128)
    const silentR = new Float32Array(128)
    compressor.processStereo(silentL, silentR)
    expect(silentL.every(Number.isFinite)).toBe(true)
    expect(silentR.every(Number.isFinite)).toBe(true)
    const quietL = new Float32Array(fs).fill(1e-6)
    const quietR = quietL.slice()
    compressor.processStereo(quietL, quietR)
    const gainDb = 20 * Math.log10(quietL[fs - 1] / 1e-6)
    expect(gainDb).toBeGreaterThan(10)
    expect(gainDb).toBeLessThanOrEqual(12.01)
  })

  it('多段压缩按分频工作，长块输出有限且可复位', () => {
    const mb = new MultibandCompressor(fs)
    const base = createDefaultParams(fs).compressor.multiband!
    mb.setParams(base, true)
    const l = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.31) * 0.6)
    const r = Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i * 0.17) * 0.4)
    mb.processStereo(l, r)
    expect(l.every(Number.isFinite)).toBe(true)
    expect(r.every(Number.isFinite)).toBe(true)
    mb.reset()
    const silenceL = new Float32Array(128)
    const silenceR = new Float32Array(128)
    mb.processStereo(silenceL, silenceR)
    expect(silenceL.every((value) => value === 0)).toBe(true)
  })

  it('多段模式把总输出增益应用于重组后的信号', () => {
    const multiband = new MultibandCompressor(fs)
    const settings = createDefaultParams(fs).compressor.multiband!
    multiband.setParams(settings, true, 0, 0)
    const left = new Float32Array(256).fill(0.1)
    const right = left.slice()
    multiband.processStereo(left, right)
    expect(left.every((sample) => sample === 0)).toBe(true)
    expect(right.every((sample) => sample === 0)).toBe(true)
  })

  it('分享串保留向上/多段模式及交叉频率', () => {
    const params = createDefaultParams(fs)
    params.compressor.enabled = true
    params.compressor.mode = 'multiband'
    params.compressor.multiband!.lowMidHz = 240
    params.compressor.multiband!.midHighHz = 5200
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.compressor.mode).toBe('multiband')
    expect(decoded.compressor.multiband?.lowMidHz).toBe(240)
    expect(decoded.compressor.multiband?.midHighHz).toBe(5200)
  })
})

