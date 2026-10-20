import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'

let Processor: new () => any
beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage(_value: unknown) {} } })
  vi.stubGlobal('sampleRate', 48000)
  Processor = (await import('../src/worklet/AudioEffectsProcessor')).AudioEffectsProcessor
})
afterAll(() => vi.unstubAllGlobals())

describe('音频线程遥测存储', () => {
  it('默认接口保持独立快照，显式target复用统计和频谱', () => {
    const engine = new EngineV3(48000)
    const tone = new Float32Array(128).fill(.05), output = [new Float32Array(128), new Float32Array(128)]
    for (let i = 0; i < 40; i++) engine.process([tone, tone], output)
    const stats = engine.getStats(), independent = engine.getStats()
    expect(independent).toEqual(stats); expect(independent).not.toBe(stats)
    expect(engine.getStats(stats)).toBe(stats)
    const analysis = engine.getAnalysis(), copy = engine.getAnalysis()
    const spectrum = analysis.spectrum, features = analysis.features
    expect(copy.spectrum).toEqual(spectrum); expect(copy.spectrum).not.toBe(spectrum)
    expect(engine.getAnalysis(analysis)).toBe(analysis)
    expect(analysis.spectrum).toBe(spectrum); expect(analysis.features).toBe(features)
  })
  it('真实处理器复用消息对象和typed-array，投递后的克隆不受后续覆盖影响', () => {
    const processor = new Processor()
    const sent: any[] = [], snapshots: any[] = []
    processor.port.postMessage = (value: unknown) => { sent.push(value); snapshots.push(structuredClone(value)) }
    const tone = new Float32Array(128).fill(.03), input = [[tone, tone]]
    const output = [[new Float32Array(128), new Float32Array(128)]]
    for (let i = 0; i < 30; i++) processor.process(input, output, {})
    const spectrum = sent[0].analysis.spectrum
    const first = structuredClone(snapshots[0])
    for (let i = 0; i < 60; i++) {
      tone.fill(.05 * Math.sin(i * .13))
      processor.process(input, output, {})
    }
    expect(sent).toHaveLength(3)
    expect(sent[1]).toBe(sent[0]); expect(sent[2]).toBe(sent[0])
    expect(sent[2].analysis.spectrum).toBe(spectrum)
    expect(snapshots[0]).toEqual(first)
    expect(snapshots[2].analysis.spectrum).not.toEqual(first.analysis.spectrum)
    expect(snapshots[2].timing.callbacks).toBe(30)
  })
})
