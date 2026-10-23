import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

describe('左右声道校准', () => {
  it('左右增益按 dB 平滑应用，并在关闭后恢复直通', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.limiter.enabled = false
    params.channelCalibration = { enabled: true, leftDb: 6, rightDb: -6 }
    engine.setParams(params)
    const left = new Float32Array(fs).fill(0.1)
    const right = new Float32Array(fs).fill(0.1)
    const outL = new Float32Array(fs)
    const outR = new Float32Array(fs)
    engine.process([left, right], [outL, outR])
    expect(outL[fs - 1] / outR[fs - 1]).toBeCloseTo(4, 1)
    engine.setParams({ ...params, channelCalibration: { enabled: false, leftDb: 6, rightDb: -6 } })
    const plainL = new Float32Array(fs).fill(0.25)
    const plainR = plainL.slice()
    const plainOutL = new Float32Array(fs)
    const plainOutR = new Float32Array(fs)
    engine.process([plainL, plainR], [plainOutL, plainOutR])
    expect(plainOutL[0]).toBeGreaterThan(0.25)
    expect(plainOutR[0]).toBeLessThan(0.25)
    expect(plainOutL[fs - 1]).toBeCloseTo(0.25, 5)
    expect(plainOutR[fs - 1]).toBeCloseTo(0.25, 5)
  })

  it('分享串保留左右校准参数', () => {
    const params = createDefaultParams(48000)
    params.channelCalibration = { enabled: true, leftDb: 2.5, rightDb: -1.5 }
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.channelCalibration).toEqual(params.channelCalibration)
  })
})

