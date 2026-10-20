import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDefaultParams } from '../src/types'
import { EngineV3Host } from '../src/integration/EngineV3Host'
import { TsConvolverBackend } from '../src/spatial/TsConvolverBackend'
import { generateAnalyticHrtfGrid } from '../src/spatial/analyticHrtf'
import { BinauralConvolver } from '../src/spatial/BinauralConvolver'

let Processor: new () => any
beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage() {} } })
  vi.stubGlobal('sampleRate', 48000)
  Processor = (await import('../src/worklet/AudioEffectsProcessor')).AudioEffectsProcessor
})
afterAll(() => vi.unstubAllGlobals())

describe('空间参数在真实处理器帧边界的合流', () => {
  it.each(['repeat', 'eq'])('非空间参数更新与头姿态合流仍立即旋转声场（%s）', update => {
    const processor = new Processor(), params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    const configure = vi.spyOn(TsConvolverBackend.prototype, 'setConfig')
    const frame = () => processor.process([[new Float32Array(128), new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)]], {})
    processor.port.onmessage({ data: { type: 'params', params } })
    frame()
    const initial = configure.mock.calls.at(-1)![0].speakers[0].azimuthDeg
    configure.mockClear()
    if (update === 'eq') params.eq.enabled = !params.eq.enabled
    processor.port.onmessage({ data: { type: 'params', params } })
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 30, pitch: 0, roll: 0 } } })
    frame()
    expect(configure).toHaveBeenCalledOnce()
    expect(configure.mock.calls[0][0].speakers[0].azimuthDeg).toBeCloseTo(initial - 30)
    configure.mockClear()
    processor.port.onmessage({ data: { type: 'params', params } })
    processor.port.onmessage({ data: { type: 'head-pose', pose: null } })
    frame()
    expect(configure).toHaveBeenCalledOnce()
    expect(configure.mock.calls[0][0].speakers[0].azimuthDeg).toBeCloseTo(initial)
    configure.mockRestore()
  })
  it.each([false, true])('参数和头姿态两个顺序均只提交最终配置，保留全部预准备数据（poseFirst=%s）', poseFirst => {
    const processor = new Processor()
    const params = createDefaultParams(48000), pose = { yaw: 20, pitch: -5, roll: 4 }
    const applyParams = vi.spyOn(processor.engine, 'setParams').mockImplementation(() => {})
    const applyPose = vi.spyOn(processor.engine, 'setSpatialHeadPose').mockImplementation(() => {})
    const paramMessage = { type: 'params', params, roomHrir: { tag: 'params' } }
    const poseMessage = { type: 'head-pose', pose, roomHrir: { tag: 'pose' } }
    for (const data of poseFirst ? [poseMessage, paramMessage] : [paramMessage, poseMessage]) processor.port.onmessage({ data })
    processor.process([Array.from({ length: 9 }, () => new Float32Array(128))], [[]], {})
    expect(applyParams).toHaveBeenCalledOnce()
    expect(applyParams.mock.calls[0][1]).toEqual((poseFirst ? [poseMessage, paramMessage] : [paramMessage, poseMessage]).map(message => message.roomHrir))
    expect(applyParams.mock.calls[0][3]).toEqual(pose)
    expect(applyPose).not.toHaveBeenCalled()
    expect(processor.engine.getStats().inputChannels).toBe(9)
  })
  it('HRTF、参数、姿态同帧到达时，最终数据集在配置前接管相应预计算数据', () => {
    const processor = new Processor(), params = createDefaultParams(48000)
    const applyParams = vi.spyOn(processor.engine, 'setParams').mockImplementation(() => {})
    const applyHrtf = vi.spyOn(processor.engine, 'setSpatialHrtf').mockImplementation(() => {})
    const grid = { source: 'frame-test' }
    processor.port.onmessage({ data: { type: 'spatial-hrtf', grid, roomHrir: { tag: 'new-grid' } } })
    processor.port.onmessage({ data: { type: 'params', params, roomHrir: { tag: 'final-params' } } })
    processor.port.onmessage({ data: { type: 'head-pose', pose: null, roomHrir: { tag: 'final-pose' } } })
    processor.process([], [[]], {})
    expect(applyParams.mock.calls[0][4]).toBe(true)
    expect(applyHrtf.mock.calls[0][0]).toBe(grid)
    expect(applyHrtf.mock.calls[0][1]).toEqual([{ tag: 'new-grid' }, { tag: 'final-params' }, { tag: 'final-pose' }])
  })
  it('帧边界复用预分配的房间线索缓冲，待处理列表与合并对象身份不变', () => {
    const processor = new Processor()
    const params = createDefaultParams(48000)
    const applyParams = vi.spyOn(processor.engine, 'setParams').mockImplementation(() => {})
    const roomBuffer = (processor as any).pendingRoomHrir
    const spatialRoomBuffer = (processor as any).pendingSpatialHrtfRoom
    const mergedBuffer = (processor as any).roomHrirFrame
    const frame = () => processor.process([[new Float32Array(128), new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)]], {})
    processor.port.onmessage({ data: { type: 'spatial-hrtf', grid: null, roomHrir: { tag: 'grid' } } })
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 12, pitch: 0, roll: 0 }, roomHrir: { tag: 'pose' } } })
    processor.port.onmessage({ data: { type: 'params', params, roomHrir: { tag: 'params' } } })
    frame()
    expect(applyParams.mock.calls[0][1]).toEqual([{ tag: 'grid' }, { tag: 'pose' }, { tag: 'params' }])
    expect(applyParams.mock.calls[0][1]).toBe(mergedBuffer) // 合并结果来自复用缓冲
    // 下一配置帧：待处理列表身份不变；合并缓冲仍是同一对象（只改 length/槽位）
    processor.port.onmessage({ data: { type: 'params', params, roomHrir: { tag: 'params-2' } } })
    frame()
    expect(applyParams.mock.calls[1][1]).toEqual([{ tag: 'params-2' }])
    expect(applyParams.mock.calls[1][1]).toBe(mergedBuffer)
    expect((processor as any).pendingRoomHrir).toBe(roomBuffer)
    expect((processor as any).pendingSpatialHrtfRoom).toBe(spatialRoomBuffer)
    expect((processor as any).roomHrirFrame).toBe(mergedBuffer)
    applyParams.mockRestore()
  })
  it('频谱反射主线程准备后接管不查询HRIR，输出与本地准备逐样本一致', () => {
    const a = new TsConvolverBackend(), b = new TsConvolverBackend(), grid = generateAnalyticHrtfGrid(48000)
    a.loadHrtf(grid); b.loadHrtf(grid)
    const config = { speakers: [{ channel: 0, id: 'L', azimuthDeg: -30, elevationDeg: 0, distance: 1, gain: 0.7, size: 0 }],
      room: 'studio' as const, roomAmount: 0.4, amount: 1, distanceModel: 'inverse' as const,
      hrtfInterp: 'nearest' as const, convolution: 'partitioned' as const, masterGain: 1,
      earlyReflectionOrders: 1, earlyReflectionModel: 'spectral' as const }
    a.setConfig(config)
    const prepared = a.takePreparedRoomHrir(true)!
    expect(prepared.early?.speakers[0]).toBeTruthy()
    b.primeRoomHrir(structuredClone(prepared))
    const queries = vi.spyOn(b, 'getHrir')
    const directFft = vi.spyOn(BinauralConvolver.prototype, 'loadIR')
    b.setConfig(config)
    expect(queries).not.toHaveBeenCalled()
    expect(prepared.direct?.entries).toHaveLength(1)
    expect(directFft).not.toHaveBeenCalled()
    directFft.mockRestore()
    const input = Float32Array.from({ length: 8192 }, (_, i) => Math.sin(i * 0.04) * 0.1)
    const aL = new Float32Array(8192), aR = new Float32Array(8192), bL = new Float32Array(8192), bR = new Float32Array(8192)
    a.processStereo(input, input, aL, aR); b.processStereo(input, input, bL, bR)
    expect(bL).toEqual(aL); expect(bR).toEqual(aR)
  })
  it('ScriptProcessor 兜底保留明确声明的16个离散输入平面', async () => {
    let script: any
    const engine = { connect() {}, disconnect() {}, channelInterpretation: 'speakers' as const }
    const host = new EngineV3Host({ mode: 'script' })
    host.setSpatialInputChannelCount(16)
    const params = createDefaultParams(48000); params.spatial!.inputFormat = 'ambix3'; params.spatial!.mode = 'instant'
    await host.attach({ audioContext: { sampleRate: 48000, createScriptProcessor: (_size, inputs) => {
      expect(inputs).toBeGreaterThanOrEqual(16); script = { ...engine }; return script
    } }, masterGain: engine, analyser: engine, inputChannels: 16 }, params)
    const input = Array.from({ length: 16 }, (_, channel) => new Float32Array(128).fill(channel / 100))
    const spy = vi.spyOn(host.engine, 'process')
    script.onaudioprocess({ inputBuffer: { getChannelData: (channel: number) => input[channel] },
      outputBuffer: { getChannelData: () => new Float32Array(128) } })
    expect(spy.mock.calls[0][0]).toHaveLength(16)
    expect(spy.mock.calls[0][0][15]).toBe(input[15])
    expect(host.engine.getStats().spatialInputFormatValid).toBe(true)
    host.dispose()
  })
})
