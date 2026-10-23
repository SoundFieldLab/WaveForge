import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

describe('卷积分区延迟控制', () => {
  it('实际分区和延迟统计随设置切换，分享串保留低延迟选择', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.limiter.enabled = false
    params.reverb.enabled = true
    params.reverb.mode = 'convolution'
    params.reverb.convolution.ir = Float32Array.from([1, 0.5, 0.25])
    params.reverb.convolution.dePeriodize = false
    params.reverb.convolution.preDelayMs = 0
    params.reverb.convolution.partitionSize = 512
    engine.setParams(params)
    expect(engine.getLatencySamples()).toBe(512)
    params.reverb.convolution.partitionSize = 128
    engine.setParams(params)
    expect(engine.getLatencySamples()).toBe(128)
    expect(decodeShareCode(encodeShareCode(params)).reverb.convolution.partitionSize).toBe(128)
    const input = new Float32Array(512)
    input[0] = 0.5
    const left = new Float32Array(512)
    const right = new Float32Array(512)
    engine.process([input, input], [left, right])
    expect(left.every(Number.isFinite)).toBe(true)
  })
})
