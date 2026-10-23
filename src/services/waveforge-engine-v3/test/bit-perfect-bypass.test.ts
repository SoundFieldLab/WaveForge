import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

describe('HSE 引擎逐样本直通', () => {
  it('即使效果和限幅器开启，仍逐位复制 Float32 输入', () => {
    const params = createDefaultParams(48000)
    params.bitPerfectBypass = true
    params.eq.proBands[0].gain = 12
    params.compressor.enabled = true
    params.limiter.enabled = true
    const engine = new EngineV3(48000)
    engine.setParams(params)
    const left = Float32Array.from([0, -0, 0.75, -0.5, 1])
    const right = Float32Array.from([0.1, 0.2, 0.3, 0.4, 0.5])
    const outL = new Float32Array(left.length)
    const outR = new Float32Array(right.length)
    engine.process([left, right], [outL, outR])
    expect(new Uint32Array(outL.buffer)).toEqual(new Uint32Array(left.buffer))
    expect(new Uint32Array(outR.buffer)).toEqual(new Uint32Array(right.buffer))
    expect(decodeShareCode(encodeShareCode(params)).bitPerfectBypass).toBe(true)
  })

  it('从直通退出后重置历史状态并恢复处理', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.limiter.enabled = false
    params.bitPerfectBypass = true
    params.eq.proBands[0].gain = 12
    engine.setParams(params)
    const input = new Float32Array(512).fill(0.2)
    const bypassed = new Float32Array(512)
    engine.process([input, input], [bypassed, new Float32Array(512)])
    expect(bypassed[511]).toBe(input[511])
    engine.setParams({ ...params, bitPerfectBypass: false })
    const processed = new Float32Array(512)
    engine.process([input, input], [processed, new Float32Array(512)])
    expect(processed.every(Number.isFinite)).toBe(true)
  })

  it('双声道输出遇到 5.1 输入时保留中心声道内容', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.bitPerfectBypass = true
    engine.setParams(params)
    const channels = [0, 0, 0.2, 0, 0, 0].map((value) => new Float32Array(32).fill(value))
    const left = new Float32Array(32)
    const right = new Float32Array(32)
    engine.process(channels, [left, right])
    expect(left[0]).toBeCloseTo(0.2 * Math.SQRT1_2, 5)
    expect(right[0]).toBeCloseTo(left[0], 5)
  })
})
