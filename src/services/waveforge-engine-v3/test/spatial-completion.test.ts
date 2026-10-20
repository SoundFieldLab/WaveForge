import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams, type SpatialSettings } from '../src/types'
import { encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'
import { normalizeSpatialSettings } from '../src/spatial/normalizeSpatial'
import { PropagationDelay } from '../src/spatial/PropagationDelay'

function fixture(format: SpatialSettings['inputFormat'], amount = 1) {
  const engine = new EngineV3(48000), params = createDefaultParams(48000)
  params.eq.enabled = false; params.limiter.enabled = false
  params.spatial.mode = 'instant'; params.spatial.inputFormat = format
  params.spatial.instant.amount = amount; params.spatial.instant.room = 'off'
  engine.setParams(params)
  return { engine, params }
}

describe('空间补全的完整信号路径', () => {
  it.each([['ambix2', 9, 18], ['ambix3', 16, 32]] as const)('%s 的最高阶平面进入对应方向双耳渲染', (format, inputCount, outputCount) => {
    const { engine } = fixture(format)
    const backend = (engine as any)._spatialBackend
    expect(backend.speakers).toHaveLength(outputCount)
    const input = Array.from({ length: inputCount }, (_, channel) => Float32Array.from({ length: 8192 }, (_, i) =>
      channel === inputCount - 1 ? Math.sin(i * 0.05) * 0.02 : 0))
    const output = [new Float32Array(8192), new Float32Array(8192)]
    engine.process(input, output)
    expect(output.every(channel => channel.every(Number.isFinite))).toBe(true)
    expect(output.some(channel => channel.subarray(4096).some(value => Math.abs(value) > 1e-5))).toBe(true)
  })
  it.each(['stereo51', 'stereo71'] as const)('%s 上混真实进入湿路且任意分块一致，0强度保持原声', format => {
    const input = [Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * 0.04) * 0.05),
      Float32Array.from({ length: 8192 }, (_, i) => Math.cos(i * 0.06) * 0.04)]
    const whole = fixture(format).engine, chunks = fixture(format).engine
    const a = [new Float32Array(8192), new Float32Array(8192)], b = [new Float32Array(8192), new Float32Array(8192)]
    whole.process(input, a)
    for (let start = 0; start < 8192; start += 73) chunks.process(input.map(channel => channel.subarray(start, start + 73)), b.map(channel => channel.subarray(start, start + 73)))
    expect(a).toEqual(b)
    expect(a[0].every(Number.isFinite)).toBe(true)
    const upmixOff = fixture(format, 0).engine, ordinary = fixture('channels', 0).engine
    const c = [new Float32Array(8192), new Float32Array(8192)], d = c.map(channel => new Float32Array(channel.length))
    upmixOff.process(input, c); ordinary.process(input, d)
    expect(c).toEqual(d)
    expect(a[0].subarray(4096)).not.toEqual(c[0].subarray(4096))
  })
  it('格式与声道数不匹配时报告并回退，不抛出处理器异常；正确音源可随后恢复', () => {
    const { engine } = fixture('ambix3')
    const output = [new Float32Array(128), new Float32Array(128)]
    expect(() => engine.process([new Float32Array(128), new Float32Array(128)], output)).not.toThrow()
    expect(engine.getStats().spatialInputFormatValid).toBe(false)
    engine.process(Array.from({ length: 16 }, () => new Float32Array(128)), output)
    expect(engine.getStats().spatialInputFormatValid).toBe(true)
  })
  it('世界轨迹给每个声源设置真实径向速度，静止源与切向运动不叠加音高变化', () => {
    const { engine, params } = fixture('channels')
    params.spatial.mode = 'world'; params.spatial.world.propagation = true
    params.spatial.world.playhead = 1
    params.spatial.world.sources = [{ id: 'moving', position: { x: 0, y: 1.6, z: 10 }, gain: 1, size: 0, route: 'both' }]
    params.spatial.world.trajectories = [{ sourceId: 'moving', keyframes: [
      { t: 0, position: { x: 0, y: 1.6, z: 10 } }, { t: 2, position: { x: 0, y: 1.6, z: 30 } }] }]
    const spy = vi.spyOn((engine as any)._spatialBackend, 'setConfig')
    engine.setParams(params)
    // 模式变更经淡变在音频边界提交。
    engine.process([new Float32Array(2048), new Float32Array(2048)], [new Float32Array(2048), new Float32Array(2048)])
    const config = spy.mock.calls.at(-1)?.[0] as import('../src/spatial/types').SpatialRenderConfig
    expect(config.speakers[0].propagationVelocity).toBeCloseTo(10, 5)
    expect(config.dopplerVelocity).toBeUndefined()
  })
  it('恒速传播读头只产生一次符合到达时间公式的多普勒变化', () => {
    const fs = 48000, delay = new PropagationDelay(fs), length = 4000
    delay.setDistance(1, 34.3)
    const signal = Float32Array.from({ length }, (_, i) => 0.1 * Math.sin(i * 2 * Math.PI * 1100 / fs))
    delay.process(signal)
    const crossings: number[] = []
    for (let i = 1500; i < length - 1; i++) if (signal[i] < 0 && signal[i + 1] >= 0) crossings.push(i)
    const frequency = fs * (crossings.length - 1) / (crossings.at(-1)! - crossings[0])
    expect(frequency).toBeCloseTo(1000, -1)
  })
  it('高阶格式和三轴变换在持久化清洗与分享串中保留，数组快照隔离', () => {
    const { engine, params } = fixture('ambix3')
    params.spatial.ambisonicTransform = { yawDeg: 30, pitchDeg: -20, rollDeg: 10, orderGains: [1, 0.8, 0.6, 0.4] }
    const clean = normalizeSpatialSettings(params.spatial)
    expect(clean.ambisonicTransform).toEqual(params.spatial.ambisonicTransform)
    const roundtrip = decodeShareCode(encodeShareCode(params))
    expect(roundtrip.spatial.inputFormat).toBe('ambix3')
    expect(roundtrip.spatial.ambisonicTransform).toEqual(params.spatial.ambisonicTransform)
    engine.setParams(params)
    params.spatial.ambisonicTransform.orderGains[3] = 0
    expect((engine as any)._params.spatial.ambisonicTransform?.orderGains[3]).toBe(0.4)
  })
})
