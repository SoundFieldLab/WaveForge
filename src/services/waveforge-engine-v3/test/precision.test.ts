import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { createDefaultParams } from '../src/types'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { Convolver } from '../src/dsp/Convolver'
import { MultibandCompressor } from '../src/dsp/MultibandCompressor'
import { TsConvolverBackend } from '../src/spatial/TsConvolverBackend'
import { AmbisonicDecoder } from '../src/spatial/AmbisonicDecoder'

function feed(engine: EngineV3, frames: number) {
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const inputL = Float32Array.from({ length: frames }, (_, i) => Math.sin(i * 0.17) * 0.4)
  const inputR = Float32Array.from({ length: frames }, (_, i) => Math.cos(i * 0.11) * 0.3)
  engine.process([inputL, inputR], [left, right])
  return { left, right }
}

describe('可选双精度工作缓冲', () => {
  it('float64 模式使用 Float64 工作缓冲并保持有限输出', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.precision = 'float64'
    params.limiter.enabled = false
    params.eq.proBands[4] = { frequency: 500, gain: 9, q: 4 }
    params.eq.proBands[5] = { frequency: 1000, gain: -7, q: 3 }
    engine.setParams(params)
    const inputL = Float32Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.17) * 0.4)
    const inputR = Float32Array.from({ length: 128 }, (_, i) => Math.cos(i * 0.11) * 0.3)
    const outL = new Float32Array(128)
    const outR = new Float32Array(128)
    engine.process([inputL, inputR], [outL, outR])
    expect((engine as unknown as { _workL: unknown })._workL).toBeInstanceOf(Float64Array)
    expect(outL.every(Number.isFinite)).toBe(true)
    expect(outR.every(Number.isFinite)).toBe(true)
  })

  it('float64 模式空间输入/输出视图为 Float64Array，切回 float32 恢复', () => {
    const engine = new EngineV3(48000)
    const inner = engine as unknown as {
      _workL: unknown
      _spatialOutL: unknown
      _spatialOutR: unknown
      _spatialInputL: unknown
      _spatialInputR: unknown
      _spatialSide: unknown
      _spatialViews: Array<Array<unknown>>
      _spatialMultiViews: Array<Array<unknown>>
      _spatialViewsByChannelCount: Array<Array<Array<unknown>>>
      _spatialInputs: Array<unknown>
      _spatialBackend: { getPrecision?: () => string }
      _convolver: { getPrecision?: () => string }
      _multibandCompressor: { getPrecision?: () => string }
    }
    const params = createDefaultParams(48000)
    params.limiter.enabled = false
    params.spatial.mode = 'instant'
    params.spatial.instant.amount = 0.7
    params.compressor.enabled = true
    params.compressor.mode = 'multiband'
    params.precision = 'float64'
    engine.setParams(params)

    expect(inner._workL).toBeInstanceOf(Float64Array)
    expect(inner._spatialOutL).toBeInstanceOf(Float64Array)
    expect(inner._spatialOutR).toBeInstanceOf(Float64Array)
    expect(inner._spatialInputL).toBeInstanceOf(Float64Array)
    expect(inner._spatialInputR).toBeInstanceOf(Float64Array)
    expect(inner._spatialSide).toBeInstanceOf(Float64Array)
    expect(inner._spatialViews[128][0]).toBeInstanceOf(Float64Array)
    expect(inner._spatialViews[1][4]).toBeInstanceOf(Float64Array)
    expect(inner._spatialMultiViews[128][0]).toBeInstanceOf(Float64Array)
    expect(inner._spatialViewsByChannelCount[6][128][0]).toBeInstanceOf(Float64Array)
    expect(inner._spatialBackend.getPrecision?.()).toBe('float64')
    expect(inner._convolver.getPrecision?.()).toBe('float64')
    expect(inner._multibandCompressor.getPrecision?.()).toBe('float64')
    expect(engine.getStats().internalPrecision).toBe('float64')

    // 空间 + 多段压缩真实进入 PCM 且保持有限。
    const out = feed(engine, 512)
    expect(out.left.every(Number.isFinite)).toBe(true)
    expect(out.right.every(Number.isFinite)).toBe(true)

    params.precision = 'float32'
    engine.setParams(params)
    expect(inner._workL).toBeInstanceOf(Float32Array)
    expect(inner._spatialOutL).toBeInstanceOf(Float32Array)
    expect(inner._spatialViews[128][0]).toBeInstanceOf(Float32Array)
    expect(inner._spatialMultiViews[128][0]).toBeInstanceOf(Float32Array)
    expect(inner._spatialViewsByChannelCount[6][128][0]).toBeInstanceOf(Float32Array)
    expect(inner._spatialBackend.getPrecision?.()).toBe('float32')
    expect(inner._convolver.getPrecision?.()).toBe('float32')
    expect(inner._multibandCompressor.getPrecision?.()).toBe('float32')
    expect(engine.getStats().internalPrecision).toBe('float32')
    const out32 = feed(engine, 512)
    expect(out32.left.every(Number.isFinite)).toBe(true)
  })

  it('float64 下卷积 IR 预准备 transfer 与控制线程参照逐样本一致', () => {
    const fs = 48000
    const params = createDefaultParams(fs)
    params.precision = 'float64'
    params.limiter.enabled = false
    const ir = new Float32Array(4096)
    for (let i = 0; i < ir.length; i++) {
      ir[i] = (i === 0 ? 1 : 0) + 0.15 * Math.exp(-i / 700) * Math.sin(i * 0.13)
    }
    params.reverb.enabled = true
    params.reverb.mode = 'convolution'
    params.reverb.convolution = {
      ...params.reverb.convolution, ir, irName: 'precision-prepared-test', partitionSize: 256,
      dePeriodize: false, mix: 0.6, preDelayMs: 1,
    }
    const control = new EngineV3(fs)
    control.setParams(params)
    const prepared = control.createPreparedConvolverIRTransfer()
    expect(prepared).not.toBeNull()
    expect(prepared!.precision).toBe('float64')

    const worklet = new EngineV3(fs)
    worklet.setParams(params, [], prepared!)
    const inputL = new Float32Array(2048)
    const inputR = new Float32Array(2048)
    for (let i = 0; i < 2048; i++) {
      inputL[i] = 0.3 * Math.sin(i * 0.21) + 0.1 * Math.cos(i * 0.013)
      inputR[i] = 0.25 * Math.cos(i * 0.17) - 0.1 * Math.sin(i * 0.031)
    }
    const controlOut = [new Float32Array(2048), new Float32Array(2048)]
    const workletOut = [new Float32Array(2048), new Float32Array(2048)]
    control.process([inputL, inputR], controlOut)
    worklet.process([inputL, inputR], workletOut)
    expect(Array.from(workletOut[0])).toEqual(Array.from(controlOut[0]))
    expect(Array.from(workletOut[1])).toEqual(Array.from(controlOut[1]))
  })

  it('初始构造与精度切换各下发一次 setPrecision，重复同精度不再下发', () => {
    const backendSpy = vi.spyOn(TsConvolverBackend.prototype, 'setPrecision')
    const convolverSpy = vi.spyOn(Convolver.prototype, 'setPrecision')
    const multibandSpy = vi.spyOn(MultibandCompressor.prototype, 'setPrecision')
    const ambisonicSpy = vi.spyOn(AmbisonicDecoder.prototype, 'setPrecision')
    try {
      const engine = new EngineV3(48000)
      // 初始配置必须下发一次（默认 float32）。
      expect(backendSpy).toHaveBeenCalledTimes(1)
      expect(convolverSpy).toHaveBeenCalledTimes(1)
      expect(multibandSpy).toHaveBeenCalledTimes(1)
      expect(ambisonicSpy).toHaveBeenCalledTimes(1)
      expect(backendSpy).toHaveBeenLastCalledWith('float32')
      expect(engine.getStats().internalPrecision).toBe('float32')

      const params = createDefaultParams(48000)
      params.precision = 'float64'
      engine.setParams(params)
      expect(backendSpy).toHaveBeenCalledTimes(2)
      expect(backendSpy).toHaveBeenLastCalledWith('float64')
      expect(convolverSpy).toHaveBeenCalledTimes(2)
      expect(multibandSpy).toHaveBeenCalledTimes(2)
      expect(ambisonicSpy).toHaveBeenCalledTimes(2)

      // 相同精度重复 setParams 不重复下发。
      engine.setParams(params)
      expect(backendSpy).toHaveBeenCalledTimes(2)
      expect(convolverSpy).toHaveBeenCalledTimes(2)
      expect(multibandSpy).toHaveBeenCalledTimes(2)
      expect(ambisonicSpy).toHaveBeenCalledTimes(2)
    } finally {
      backendSpy.mockRestore()
      convolverSpy.mockRestore()
      multibandSpy.mockRestore()
      ambisonicSpy.mockRestore()
    }
  })

  it('float64 上混输出声道为 Float64Array，切回 float32 恢复', () => {
    const engine = new EngineV3(48000)
    const inner = engine as unknown as {
      _spatialBlockChannels: readonly unknown[] | null
      _upmix71Channels: readonly unknown[]
      _stereoUpmixer51: { getPrecision?: () => string }
      _stereoUpmixer71: { getPrecision?: () => string }
    }
    const params = createDefaultParams(48000)
    params.precision = 'float64'
    params.limiter.enabled = false
    params.spatial.mode = 'instant'
    params.spatial.instant.amount = 0.7
    params.spatial.inputFormat = 'stereo51'
    engine.setParams(params)
    expect(inner._stereoUpmixer51.getPrecision?.()).toBe('float64')
    expect(inner._stereoUpmixer71.getPrecision?.()).toBe('float64')
    feed(engine, 512)
    expect(inner._spatialBlockChannels).not.toBeNull()
    expect(inner._spatialBlockChannels!.every((channel) => channel instanceof Float64Array)).toBe(true)

    params.spatial.inputFormat = 'stereo71'
    engine.setParams(params)
    feed(engine, 512)
    expect(inner._upmix71Channels.length).toBe(8)
    expect(inner._upmix71Channels.every((channel) => channel instanceof Float64Array)).toBe(true)

    params.precision = 'float32'
    engine.setParams(params)
    feed(engine, 512)
    expect(inner._stereoUpmixer51.getPrecision?.()).toBe('float32')
    expect(inner._upmix71Channels.every((channel) => channel instanceof Float32Array)).toBe(true)
  })

  it('float64 下 Ambisonics（FOA/HOA）解码输出为 Float64Array，切回 float32 恢复', () => {
    const engine = new EngineV3(48000)
    const inner = engine as unknown as {
      _ambisonic: { getPrecision?: () => string; left: unknown; right: unknown; channels: readonly unknown[] }
      _spatialBlockChannels: readonly unknown[] | null
    }
    const params = createDefaultParams(48000)
    params.precision = 'float64'
    params.limiter.enabled = false
    params.spatial.mode = 'instant'
    params.spatial.instant.amount = 0.7
    params.spatial.inputFormat = 'ambix'
    engine.setParams(params)
    expect(inner._ambisonic.getPrecision?.()).toBe('float64')
    expect(inner._ambisonic.left).toBeInstanceOf(Float64Array)
    expect(inner._ambisonic.right).toBeInstanceOf(Float64Array)
    expect(inner._ambisonic.channels.every((channel) => channel instanceof Float64Array)).toBe(true)

    // 一阶 FOA：4 个输入声道解码为 8 个虚拟扬声器。
    const frames = 512
    const inputs = Array.from({ length: 4 }, (_, channel) =>
      Float32Array.from({ length: frames }, (_, i) => 0.2 * Math.sin(i * 0.11 + channel * 0.7)))
    const outL = new Float32Array(frames)
    const outR = new Float32Array(frames)
    engine.process(inputs, [outL, outR])
    expect(outL.every(Number.isFinite)).toBe(true)
    expect(inner._spatialBlockChannels).not.toBeNull()
    expect(inner._spatialBlockChannels!.every((channel) => channel instanceof Float64Array)).toBe(true)
    expect(engine.getStats().internalPrecision).toBe('float64')

    // 三阶 HOA：16 输入 → 32 个解码方向。
    params.spatial.inputFormat = 'ambix3'
    engine.setParams(params)
    const hoaInputs = Array.from({ length: 16 }, (_, channel) =>
      Float32Array.from({ length: frames }, (_, i) => 0.1 * Math.cos(i * 0.07 + channel * 0.3)))
    const hoaL = new Float32Array(frames)
    const hoaR = new Float32Array(frames)
    engine.process(hoaInputs, [hoaL, hoaR])
    expect(hoaL.every(Number.isFinite)).toBe(true)
    expect(inner._ambisonic.channels.length).toBe(32)
    expect(inner._ambisonic.channels.every((channel) => channel instanceof Float64Array)).toBe(true)

    params.precision = 'float32'
    engine.setParams(params)
    expect(inner._ambisonic.getPrecision?.()).toBe('float32')
    expect(inner._ambisonic.left).toBeInstanceOf(Float32Array)
    expect(inner._ambisonic.channels.every((channel) => channel instanceof Float32Array)).toBe(true)
    expect(engine.getStats().internalPrecision).toBe('float32')
  })

  it('float64 下更改卷积分区重建 Convolver 后仍保持 float64', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.precision = 'float64'
    const ir = new Float32Array([1, 0.2, 0, 0])
    params.reverb.enabled = true
    params.reverb.mode = 'convolution'
    params.reverb.convolution = { ...params.reverb.convolution, ir, partitionSize: 512, dePeriodize: false }
    engine.setParams(params)
    const inner = engine as unknown as { _convolver: { getPrecision?: () => string } }
    expect(inner._convolver.getPrecision?.()).toBe('float64')
    // 分区变化会重建 Convolver：新实例必须继承当前精度。
    params.reverb.convolution.partitionSize = 128
    engine.setParams(params)
    expect(inner._convolver.getPrecision?.()).toBe('float64')
    const out = feed(engine, 256)
    expect(out.left.every(Number.isFinite)).toBe(true)
  })

  it('切回 float32 会重建工作缓冲，精度设置可分享往返', () => {
    const engine = new EngineV3(48000)
    const params = createDefaultParams(48000)
    params.precision = 'float64'
    engine.setParams(params)
    const z = new Float32Array(32)
    engine.process([z, z], [new Float32Array(32), new Float32Array(32)])
    params.precision = 'float32'
    engine.setParams(params)
    engine.process([z, z], [new Float32Array(32), new Float32Array(32)])
    expect((engine as unknown as { _workL: unknown })._workL).toBeInstanceOf(Float32Array)
    expect(decodeShareCode(encodeShareCode(params)).precision).toBe('float32')
    params.precision = 'float64'
    expect(decodeShareCode(encodeShareCode(params)).precision).toBe('float64')
  })
})
