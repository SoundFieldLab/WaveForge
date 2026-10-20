import { describe, expect, it } from 'vitest'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'
import { EngineV3 } from '../src/engine/EngineV3'

describe('PEQ 滤波器类型', () => {
  it.each([24, 64])('%i 段自定义频段进入实际链路且可通过分享串恢复', (count) => {
    const params = createDefaultParams(48000)
    params.eq.bandCount = count
    params.eq.qCompensation = false
    params.limiter.enabled = false
    params.eq.proBands = Array.from({ length: count }, () => ({ frequency: 1000, gain: 0, q: 2 }))
    params.eq.proBands[count - 1].type = 'notch'
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.eq.bandCount).toBe(count)
    expect(decoded.eq.proBands).toHaveLength(count)
    const engine = new EngineV3(48000)
    engine.setParams(decoded)
    const tone = Float32Array.from({ length: 4096 }, (_, index) => 0.2 * Math.sin(2 * Math.PI * 1000 * index / 48000))
    const output = new Float32Array(tone.length)
    engine.process([tone, tone], [output, new Float32Array(tone.length)])
    let power = 0
    for (let i = 2048; i < output.length; i++) power += output[i] * output[i]
    expect(Math.sqrt(power / 2048)).toBeLessThan(0.01)
  })
  it('分享串保留每段滤波器类型，并兼容旧的省略 type 形状', () => {
    const params = createDefaultParams(48000)
    const types = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass'] as const
    params.eq.proBands = types.map((type, i) => ({
      frequency: 80 * (i + 1),
      gain: i - 3,
      q: 0.7 + i * 0.1,
      type,
    }))
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.eq.proBands.map((band) => band.type)).toEqual(types)

    const legacy = createDefaultParams(48000)
    legacy.eq.proBands = [{ frequency: 1000, gain: 3, q: 1.1 }]
    const legacyDecoded = decodeShareCode(encodeShareCode(legacy))
    expect(legacyDecoded.eq.proBands[0]).toEqual({ frequency: 1000, gain: 3, q: 1.1 })
  })

  it('非法滤波器类型回落为安全的峰值类型', () => {
    const params = createDefaultParams(48000)
    params.eq.proBands = [{ frequency: 1000, gain: 3, q: 1.1, type: 'javascript:alert(1)' as unknown as 'peaking' }]
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.eq.proBands[0].type).toBe('peaking')
  })
})
