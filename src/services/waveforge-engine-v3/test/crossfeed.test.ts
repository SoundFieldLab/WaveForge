import { describe, expect, it } from 'vitest'
import { Crossfeed } from '../src/dsp/Crossfeed'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'

const settings = { enabled: true, amount: 0.8, cutoffHz: 700, delayMs: 0.2 }

describe('耳机交叉馈送', () => {
  it('关闭时逐位直通；左声道低频经延时馈入右声道', () => {
    const dsp = new Crossfeed(48000)
    const l = new Float32Array(4096).fill(0.2)
    const r = new Float32Array(4096)
    dsp.processStereo(l, r)
    expect(l[0]).toBeCloseTo(0.2, 6)
    expect(r.every((sample) => sample === 0)).toBe(true)
    dsp.setParams(settings)
    dsp.processStereo(l, r)
    expect(r[0]).toBe(0)
    expect(r[1000]).toBeGreaterThan(0.02)
    expect(l[1000] + r[1000]).toBeCloseTo(0.2, 4)
  })

  it('不同分块方式输出一致，重置后没有旧信号串入', () => {
    const a = new Crossfeed(48000)
    const b = new Crossfeed(48000)
    a.setParams(settings)
    b.setParams(settings)
    const source = Float32Array.from({ length: 1031 }, (_, i) => i % 17 === 0 ? 0.3 : 0)
    const al = new Float32Array(source), ar = new Float32Array(1031)
    const bl = new Float32Array(source), br = new Float32Array(1031)
    a.processStereo(al, ar)
    for (let i = 0; i < source.length; i += 37) b.processStereo(bl.subarray(i, i + 37), br.subarray(i, i + 37))
    expect(bl).toEqual(al)
    expect(br).toEqual(ar)
    b.reset()
    const silenceL = new Float32Array(256), silenceR = new Float32Array(256)
    b.processStereo(silenceL, silenceR)
    expect(silenceL.every((v) => v === 0)).toBe(true)
    expect(silenceR.every((v) => v === 0)).toBe(true)
  })

  it('引擎快照和分享串保留交叉馈送参数', () => {
    const params = createDefaultParams(48000)
    params.crossfeed = { ...settings }
    expect(decodeShareCode(encodeShareCode(params)).crossfeed).toEqual(settings)
    params.eq.enabled = false
    params.limiter.enabled = false
    const engine = new EngineV3(48000)
    engine.setParams(params)
    const l = new Float32Array(2048).fill(0.2), r = new Float32Array(2048)
    const outL = new Float32Array(2048), outR = new Float32Array(2048)
    engine.process([l, r], [outL, outR])
    expect(outR[1024]).toBeGreaterThan(0.02)
  })

  it('旧快照缺少字段时关闭并清空状态，重新启用不泄漏旧串音', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    params.crossfeed = { ...settings }
    engine.setParams(params)
    const firstL = new Float32Array(2048).fill(0.2)
    engine.process([firstL, new Float32Array(2048)], [new Float32Array(2048), new Float32Array(2048)])
    const legacy: import('../src/types').V3EngineParams = { ...params }
    delete legacy.crossfeed
    engine.setParams(legacy)
    const stopped = new Float32Array(2048)
    engine.process([new Float32Array(2048), new Float32Array(2048)], [new Float32Array(2048), stopped])
    expect(stopped.slice(1024).every(sample => sample === 0)).toBe(true)
    engine.setParams(params)
    engine.reset() // 曲目边界收敛到最新配置并清理历史，与全新引擎对拍。
    const actualR = new Float32Array(128)
    engine.process([new Float32Array(128).fill(0.2), new Float32Array(128)], [new Float32Array(128), actualR])
    const fresh = new EngineV3(48000)
    fresh.setParams(params)
    const expectedR = new Float32Array(128)
    fresh.process([new Float32Array(128).fill(0.2), new Float32Array(128)], [new Float32Array(128), expectedR])
    expect(actualR).toEqual(expectedR)
  })
})
