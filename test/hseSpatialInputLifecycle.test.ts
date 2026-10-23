// @vitest-environment jsdom

/**
 * HSE 多声道输入的融合层生命周期回归：
 * 1) 多声道源解码后注入 multichannelAuto/layout，切回普通立体声时必须回滚（不残留 5.1/7.1 布局）；
 * 2) 非 WAV 提示走 info toast，不中断播放；
 * 3) pitch 激活 + 多声道时只有前 L/R 进 SoundTouch，其余离散平面按原索引旁通。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hrtfMock = vi.hoisted(() => ({ readActiveHrtf: vi.fn(async () => null), saveActiveHrtf: vi.fn(async () => undefined) }))
vi.mock('../src/services/waveforge-engine-v3/ui/hrtfStore', () => hrtfMock)

const soundTouchMock = vi.hoisted(() => ({ register: vi.fn(async () => undefined), instances: [] as any[] }))
vi.mock('@soundtouchjs/audio-worklet', () => ({
  SoundTouchNode: class extends EventTarget {
    static register = soundTouchMock.register
    pitchSemitones = { setTargetAtTime: vi.fn() }
    playbackRate = { setTargetAtTime: vi.fn() }
    connect = vi.fn()
    disconnect = vi.fn()
    options: any
    constructor(options: any) { super(); this.options = options; soundTouchMock.instances.push(this) }
  },
}))

import { attachV3Engine, detachV3Engine, getV3Bridge } from '../src/services/waveforge-engine-v3/attachV3Engine'
import { EngineV3Host, createDefaultParams } from '../src/services/waveforge-engine-v3/src/index'

function fakeNode(kind: string, extra: Record<string, unknown> = {}) {
  const node: any = {
    kind, connections: [] as any[], disconnected: false, ...extra,
    connect(dest: any, out = 0, inp = 0) { node.connections.push({ dest, out, inp }); return dest },
    disconnect() { node.connections = []; node.disconnected = true },
    gain: { value: 1, setValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), cancelAndHoldAtTime: vi.fn() },
    channelCountMode: 'max', channelInterpretation: 'discrete',
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }
  return node
}

let capturedOptions: any = null

async function attachForTest() {
  const created: any[] = []
  const make = (kind: string, extra: Record<string, unknown> = {}) => { const node = fakeNode(kind, extra); created.push(node); return node }
  const context: any = {
    sampleRate: 48000, currentTime: 0, destination: make('destination'),
    createGain: () => make('gain'),
    createChannelSplitter: (channels: number) => make('splitter', { channels }),
    createChannelMerger: (channels: number) => make('merger', { channels }),
    createScriptProcessor: () => make('script'),
  }
  const masterGain = fakeNode('master')
  const analyser = fakeNode('analyser')
  capturedOptions = null
  await attachV3Engine({
    audioContext: context as never, masterGain: masterGain as never, analyser: analyser as never,
    configureDiscreteInput: (enabled: boolean, options?: any) => { if (enabled) capturedOptions = options },
  } as never)
  return { created, masterGain, analyser }
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

const multichannelInfo = (channels: number, layout: string) => ({
  sampleRate: 48000, channels, inputFormat: 'channels', layout,
  channelLabels: Array.from({ length: channels }, (_, i) => 'ch' + i),
  sourceChannelLabels: Array.from({ length: channels }, (_, i) => 'ch' + i),
  channelMap: Array.from({ length: channels }, (_, i) => i), warnings: [],
})

describe('HSE 多声道输入生命周期', () => {
  beforeEach(() => {
    hrtfMock.readActiveHrtf.mockImplementation(async () => null)
    soundTouchMock.register.mockImplementation(async () => undefined)
    soundTouchMock.instances.length = 0
    localStorage.clear()
  })
  afterEach(() => {
    detachV3Engine()
    capturedOptions = null
    soundTouchMock.instances.length = 0
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('多声道解码注入自动布局，切回立体声（null）时回滚并通知 2 声道', async () => {
    await attachForTest()
    const bridge = getV3Bridge()
    bridge.setParams(createDefaultParams(48000))
    expect(capturedOptions).toBeTypeOf('object')
    const before = JSON.parse(JSON.stringify(bridge.getParams().spatial.instant))
    expect(before.multichannelAuto).toBe(false)
    const channelCountSpy = vi.spyOn(EngineV3Host.prototype, 'setSpatialInputChannelCount')
    capturedOptions.onSourceDecoded(multichannelInfo(8, '71'))
    expect(bridge.getParams().spatial.instant.multichannelAuto).toBe(true)
    expect(bridge.getParams().spatial.instant.multichannelLayout).toBe('71')
    expect(channelCountSpy).toHaveBeenCalledWith(8)
    capturedOptions.onSourceDecoded(null)
    expect(bridge.getParams().spatial.instant.multichannelAuto).toBe(before.multichannelAuto)
    expect(bridge.getParams().spatial.instant.multichannelLayout).toBe(before.multichannelLayout)
    expect(channelCountSpy).toHaveBeenCalledWith(2)
    channelCountSpy.mockRestore()
  })

  it('声源/目标声道标签随参数下发到多声道输入层，清空后回落 mask', async () => {
    await attachForTest()
    const bridge = getV3Bridge()
    const base = createDefaultParams(48000)
    bridge.setParams({ ...base, spatial: { ...base.spatial,
      sourceChannelLabels: ['FL', 'FR', 'SL', 'SR'], targetChannelLabels: ['SR', 'SL', 'FR', 'FL'] } })
    expect(capturedOptions.sourceChannelLabels).toEqual(['FL', 'FR', 'SL', 'SR'])
    expect(capturedOptions.targetChannelLabels).toEqual(['SR', 'SL', 'FR', 'FL'])
    const cleared = bridge.getParams()
    bridge.setParams({ ...cleared, spatial: { ...cleared.spatial, sourceChannelLabels: [] } })
    expect(capturedOptions.sourceChannelLabels).toBeUndefined()
  })

  it('非 WAV 源提示走 info toast，不产生 error', async () => {
    await attachForTest()
    const toasts: any[] = []
    const listener = (event: Event) => toasts.push((event as CustomEvent).detail)
    window.addEventListener('showToast', listener)
    capturedOptions.onSourceWarning('非 WAV 源提示')
    window.removeEventListener('showToast', listener)
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toBe('非 WAV 源提示')
    expect(toasts[0].type).toBe('info')
  })

  it('pitch 激活 + 多声道：只有前 L/R 进 SoundTouch，其余平面按原索引旁通进 engine', async () => {
    const { created, masterGain } = await attachForTest()
    const bridge = getV3Bridge()
    bridge.setParams(createDefaultParams(48000))
    capturedOptions.onSourceDecoded(multichannelInfo(8, '71'))
    const params = bridge.getParams()
    bridge.setParams({ ...params, pitch: { ...params.pitch, enabled: true, semitones: 0, rate: 1.5 } })
    await flush()
    const soundtouch = soundTouchMock.instances.at(-1)
    expect(soundtouch).toBeTruthy()
    expect(soundtouch.options.outputChannelCount).toBe(2)
    const split = created.filter(node => node.kind === 'splitter' && node.channels === 8)[0]
    const front = created.filter(node => node.kind === 'merger' && node.channels === 2)[0]
    const processedFront = created.filter(node => node.kind === 'splitter' && node.channels === 2)[0]
    const merge = created.filter(node => node.kind === 'merger' && node.channels === 8)[0]
    expect(split && front && processedFront && merge).toBeTruthy()
    expect(split.connections).toEqual(expect.arrayContaining([
      { dest: front, out: 0, inp: 0 }, { dest: front, out: 1, inp: 1 },
    ]))
    expect(front.connections[0]).toEqual({ dest: soundtouch, out: 0, inp: 0 })
    expect(soundtouch.connect.mock.calls[0][0]).toBe(processedFront)
    expect(processedFront.connections).toEqual(expect.arrayContaining([
      { dest: merge, out: 0, inp: 0 }, { dest: merge, out: 1, inp: 1 },
    ]))
    for (let channel = 2; channel < 8; channel++) {
      expect(split.connections).toEqual(expect.arrayContaining([{ dest: merge, out: channel, inp: channel }]))
    }
    expect(split.connections.every(connection => connection.dest !== soundtouch)).toBe(true)
    expect(masterGain.connections).toEqual(expect.arrayContaining([{ dest: split, out: 0, inp: 0 }]))
  })
})
