import { describe, expect, it } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams, DEFAULT_PROCESSING_ORDER } from '../src/types'

describe('HSE 音效处理顺序', () => {
  it('改变均衡器与压缩器的先后会改变实际音频，分享串保留顺序', () => {
    const fs = 48000
    const params = createDefaultParams(fs)
    params.limiter.enabled = false
    params.eq.proBands[5].gain = 12
    params.compressor = { ...params.compressor, enabled: true, thresholdDb: -40, ratio: 8, attackMs: 1, releaseMs: 50 }
    const tone = Float32Array.from({ length: fs }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 1000 * i / fs))
    const render = (order: typeof params.processingOrder) => {
      const engine = new EngineV3(fs)
      engine.setParams({ ...params, processingOrder: order })
      const left = new Float32Array(tone.length)
      engine.process([tone, tone], [left, new Float32Array(tone.length)])
      return left
    }
    const normal = render([...DEFAULT_PROCESSING_ORDER])
    const reversed = render(['compressor', 'eq', ...DEFAULT_PROCESSING_ORDER.filter((key) => key !== 'compressor' && key !== 'eq')])
    let difference = 0
    for (let i = fs / 2; i < fs; i++) difference += Math.abs(normal[i] - reversed[i])
    expect(difference / (fs / 2)).toBeGreaterThan(0.001)
    const decoded = decodeShareCode(encodeShareCode({ ...params, processingOrder: ['compressor', 'eq'] }))
    expect(decoded.processingOrder?.slice(0, 2)).toEqual(['compressor', 'eq'])
    expect(decoded.processingOrder).toHaveLength(DEFAULT_PROCESSING_ORDER.length)
  })
})
