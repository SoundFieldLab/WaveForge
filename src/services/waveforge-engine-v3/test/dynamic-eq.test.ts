import { describe, expect, it } from 'vitest'
import { DynamicEq, DynamicEqBank } from '../src/dsp/DynamicEq'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

const fs = 48000
const settings = {
  enabled: true, frequency: 1000, q: 2, thresholdDb: -30,
  ratio: 4, maxReductionDb: 12, attackMs: 5, releaseMs: 50,
}

function sine(frequency: number, amplitude: number, length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) =>
    amplitude * Math.sin(2 * Math.PI * frequency * i / fs))
}

function rms(signal: Float32Array, start: number): number {
  let sum = 0
  for (let i = start; i < signal.length; i++) sum += signal[i] * signal[i]
  return Math.sqrt(sum / (signal.length - start))
}

describe('动态均衡', () => {
  it('两个频段独立检测并衰减，任意块长输出一致', () => {
    const configure = () => ({ ...settings, bands: [
      { ...settings, frequency: 1000 },
      { ...settings, frequency: 8000 },
    ] })
    const full = new DynamicEqBank(fs)
    const split = new DynamicEqBank(fs)
    full.setParams(configure())
    split.setParams(configure())
    const input = Float32Array.from({ length: fs }, (_, i) =>
      0.35 * Math.sin(2 * Math.PI * 1000 * i / fs) + 0.35 * Math.sin(2 * Math.PI * 8000 * i / fs))
    const fullL = input.slice(); const fullR = input.slice()
    const splitL = input.slice(); const splitR = input.slice()
    full.processStereo(fullL, fullR)
    for (let i = 0; i < input.length; i += 73) split.processStereo(splitL.subarray(i, i + 73), splitR.subarray(i, i + 73))
    expect(full.getReductionDb()).toHaveLength(2)
    expect(full.getReductionDb().every((db) => db < -3)).toBe(true)
    expect(splitL).toEqual(fullL)
    expect(splitR).toEqual(fullR)
    const params = createDefaultParams(fs)
    params.dynamicEq = configure()
    expect(decodeShareCode(encodeShareCode(params)).dynamicEq?.bands).toHaveLength(2)
  })

  it('重叠频段使用同一原始输入检测，前一段衰减不改变后一段阈值判断', () => {
    const bank = new DynamicEqBank(fs)
    bank.setParams({ ...settings, bands: [{ ...settings }, { ...settings }] })
    const left = sine(1000, 0.5, fs)
    const right = left.slice()
    bank.processStereo(left, right)
    const [first, second] = bank.getReductionDb()
    expect(first).toBeLessThan(-8)
    expect(second).toBeCloseTo(first, 4)
  })
  it('大音量目标频段降低增益，轻声和频带外基本直通', () => {
    const run = (frequency: number, amplitude: number) => {
      const dsp = new DynamicEq(fs)
      dsp.setParams(settings)
      const left = sine(frequency, amplitude, fs)
      const right = new Float32Array(left)
      const original = rms(left, fs / 2)
      dsp.processStereo(left, right)
      return { ratio: rms(left, fs / 2) / original, reduction: dsp.getReductionDb() }
    }
    const loud = run(1000, 0.5)
    const quiet = run(1000, 0.001)
    const outside = run(8000, 0.5)
    expect(loud.reduction).toBeLessThan(-8)
    expect(loud.ratio).toBeLessThan(0.6)
    expect(quiet.reduction).toBeCloseTo(0, 4)
    expect(quiet.ratio).toBeCloseTo(1, 3)
    expect(outside.ratio).toBeGreaterThan(0.95)
  })

  it('控制周期跨块连续，切块方式不影响输出', () => {
    const a = new DynamicEq(fs)
    const b = new DynamicEq(fs)
    a.setParams(settings)
    b.setParams(settings)
    const left = sine(1000, 0.4, 4096)
    const fullL = new Float32Array(left)
    const fullR = new Float32Array(left)
    a.processStereo(fullL, fullR)
    const splitL = new Float32Array(left)
    const splitR = new Float32Array(left)
    for (let i = 0; i < left.length; i += 73) {
      b.processStereo(splitL.subarray(i, i + 73), splitR.subarray(i, i + 73))
    }
    expect(splitL).toEqual(fullL)
    expect(splitR).toEqual(fullR)
  })

  it('引擎关闭、重新开启及重置后不携带旧频段检测状态', () => {
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.eq.enabled = false
    params.limiter.enabled = false
    params.dynamicEq = { ...settings }
    engine.setParams(params)
    const tone = sine(1000, 0.5, 8192)
    const output = new Float32Array(tone.length)
    engine.process([tone, tone], [output, new Float32Array(tone.length)])
    expect(rms(output, 4096)).toBeLessThan(rms(tone, 4096) * 0.6)

    engine.setParams({ ...params, dynamicEq: { ...settings, enabled: false } })
    engine.setParams(params)
    engine.reset()
    const fresh = new EngineV3(fs)
    fresh.setParams(params)
    const actual = new Float32Array(256)
    const expected = new Float32Array(256)
    engine.process([tone, tone], [actual, new Float32Array(256)])
    fresh.process([tone, tone], [expected, new Float32Array(256)])
    expect(actual).toEqual(expected)
  })

  it('分享串保留动态均衡参数', () => {
    const params = createDefaultParams(fs)
    params.dynamicEq = { ...settings }
    expect(decodeShareCode(encodeShareCode(params)).dynamicEq).toEqual(settings)
  })
})
