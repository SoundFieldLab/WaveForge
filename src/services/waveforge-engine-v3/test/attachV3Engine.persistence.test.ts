// @vitest-environment jsdom
//
// 超时说明：jsdom 环境下本文件每个用例都经 vi.resetModules() + 动态 import 重建整条 HSE 模块图，
// 全量并发跑时首轮 transform/import 会与其它测试文件争抢 CPU，单用例耗时可能远超默认 5s；
// 这里只放宽单用例超时，断言强度不变（真实功能挂起仍会被 20s 抓到）。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V3EngineParams } from '../src/types'

const soundTouchMock = vi.hoisted(() => ({
  register: vi.fn(),
  nodes: [] as Array<{ dispatchEvent(event: Event): boolean; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@soundtouchjs/audio-worklet', () => ({
  SoundTouchNode: class extends EventTarget {
    static register = soundTouchMock.register
    readonly pitchSemitones = { setTargetAtTime: vi.fn() }
    readonly playbackRate = { setTargetAtTime: vi.fn() }
    readonly connect = vi.fn()
    readonly disconnect = vi.fn()
    constructor() { super(); soundTouchMock.nodes.push(this) }
  },
}))

type AudioNodeStub = {
  connect: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  onaudioprocess?: (event: {
    inputBuffer: { getChannelData(channel: number): Float32Array }
    outputBuffer: { getChannelData(channel: number): Float32Array }
  }) => void
}

type AudioGraphStub = {
  audioContext: {
    sampleRate: number
    currentTime: number
    createGain: ReturnType<typeof vi.fn>
    createScriptProcessor: ReturnType<typeof vi.fn>
  }
  masterGain: AudioNodeStub
  analyser: AudioNodeStub
}

type PersistedBridge = ReturnType<typeof import('../attachV3Engine')['getV3Bridge']> & {
  getMasterSnapshot(): V3EngineParams | null
  setMasterSnapshot(params: V3EngineParams | null): void
  getSaveState(): 'saved' | 'pending' | 'error'
  subscribeSaveState(listener: () => void): () => void
  saveNow(): boolean
}

/** 单用例超时：模块重建 + 并发 transform 下首轮动态 import 可超过默认 5s。 */
const IMPORT_TIMEOUT = 20_000

const cleanupTasks: Array<() => void> = []

function makeNode(): AudioNodeStub {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function makeGraph(sampleRate = 48_000): AudioGraphStub {
  const masterGain = makeNode()
  const analyser = makeNode()
  const createScriptProcessor = vi.fn(() => makeNode())
  return {
    audioContext: { sampleRate, currentTime: 0, createScriptProcessor, createGain: vi.fn(() => ({
      ...makeNode(), gain: { value: 1, setTargetAtTime: vi.fn(), cancelAndHoldAtTime: vi.fn(),
        cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    })) },
    masterGain,
    analyser,
  }
}

async function loadFusion() {
  vi.resetModules()
  return import('../attachV3Engine')
}

async function attachFresh() {
  const fusion = await loadFusion()
  const graph = makeGraph()
  await fusion.attachV3Engine(graph as never)
  cleanupTasks.push(fusion.detachV3Engine)
  return {
    fusion,
    graph,
    bridge: fusion.getV3Bridge() as PersistedBridge,
  }
}

describe('HSE 融合层参数持久化', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.useFakeTimers()
    soundTouchMock.register.mockReset()
    soundTouchMock.nodes.length = 0
  })

  afterEach(() => {
    cleanupTasks.splice(0).reverse().forEach((cleanup) => cleanup())
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('曲目 ReplayGain 标签随模式选择更新，切歌清除旧增益且不入持久化', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    const initial = bridge.getParams()
    bridge.setParams({ ...initial, loudnessNormalization: { ...initial.loudnessNormalization,
      enabled: true, useRealtimeMeter: false, replayGainMode: 'track' } })
    fusion.setV3TrackReplayGainTags({ REPLAYGAIN_TRACK_GAIN: '-5.50 dB', REPLAYGAIN_ALBUM_GAIN: '-2.00 dB' })
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-5.5)
    const current = bridge.getParams()
    bridge.setParams({ ...current, loudnessNormalization: { ...current.loudnessNormalization, replayGainMode: 'album' } })
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-2)
    expect(bridge.saveNow()).toBe(true)
    expect(JSON.parse(localStorage.getItem('waveforge:v3-params') || '{}').loudnessNormalization.replayGainDb).toBeNull()
    fusion.setV3TrackReplayGainTags(null)
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBeNull()
  })

  it('参数变更经历 pending，防抖保存后变为 saved 并通知订阅者', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    // attach 会为初始快照排队一次保存；先落盘，确保本用例观察的是后续变更。
    expect(bridge.saveNow()).toBe(true)
    const states: string[] = []
    const unsubscribe = bridge.subscribeSaveState(() => states.push(bridge.getSaveState()))

    const next = bridge.getParams()
    next.bassEnhancer.enabled = true
    bridge.setParams(next)

    expect(bridge.getSaveState()).toBe('pending')
    expect(states).toEqual(['pending'])
    vi.advanceTimersByTime(399)
    expect(bridge.getSaveState()).toBe('pending')
    expect(JSON.parse(localStorage.getItem('waveforge:v3-params') || '{}').bassEnhancer.enabled).toBe(false)
    vi.advanceTimersByTime(1)
    expect(bridge.getSaveState()).toBe('saved')
    expect(states).toEqual(['pending', 'saved'])

    const stored = JSON.parse(localStorage.getItem('waveforge:v3-params') || 'null') as V3EngineParams & { __masterSnapshot?: unknown }
    expect(stored.bassEnhancer.enabled).toBe(true)
    expect(stored.__masterSnapshot).toBeNull()
    expect(localStorage.length).toBe(1)

    unsubscribe()
    const later = bridge.getParams()
    later.bassEnhancer.enabled = false
    bridge.setParams(later)
    expect(bridge.saveNow()).toBe(true)
    expect(states).toEqual(['pending', 'saved'])
    fusion.detachV3Engine()
  })

  it('写入失败进入 error，恢复存储后 saveNow 可重试回 saved', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    expect(bridge.saveNow()).toBe(true)
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const states: string[] = []
    const unsubscribe = bridge.subscribeSaveState(() => states.push(bridge.getSaveState()))
    cleanupTasks.push(unsubscribe)

    const next = bridge.getParams()
    next.reverb.enabled = true
    bridge.setParams(next)
    expect(bridge.getSaveState()).toBe('pending')
    expect(bridge.saveNow()).toBe(false)
    expect(bridge.getSaveState()).toBe('error')
    expect(states).toEqual(['pending', 'error'])

    setItem.mockRestore()
    expect(bridge.saveNow()).toBe(true)
    expect(bridge.getSaveState()).toBe('saved')
    expect(states).toEqual(['pending', 'error', 'saved'])
    expect(JSON.parse(localStorage.getItem('waveforge:v3-params') || '{}').reverb.enabled).toBe(true)

    fusion.detachV3Engine()
  })

  it('重载模块后恢复旁路快照，系统音量通道与效果恢复参数保持独立', { timeout: IMPORT_TIMEOUT }, async () => {
    let loaded = await attachFresh()
    const { bridge } = loaded
    const current = bridge.getParams()
    const manualGain = -24
    const masterSnapshot = {
      ...current,
      customized: false,
      bassEnhancer: { ...current.bassEnhancer, enabled: true },
      reverb: { ...current.reverb, enabled: true },
      loudnessNormalization: {
        ...current.loudnessNormalization,
        enabled: true,
        useRealtimeMeter: false,
        externalGainDb: manualGain,
      },
    }
    const bypass = {
      ...masterSnapshot,
      bassEnhancer: { ...masterSnapshot.bassEnhancer, enabled: false },
      reverb: { ...masterSnapshot.reverb, enabled: false },
    }

    bridge.setMasterSnapshot(masterSnapshot)
    bridge.setParams(bypass)
    expect(bridge.getSaveState()).toBe('pending')
    expect(bridge.saveNow()).toBe(true)

    // 系统音量属于独立的 loudnessCompensation 通道，应同步到旁路快照而不改手动增益。
    loaded.fusion.setV3SystemVolume(42)
    expect(bridge.getParams().loudnessCompensation.volumePercent).toBe(42)
    expect(bridge.getMasterSnapshot()?.loudnessCompensation.volumePercent).toBe(42)
    expect(bridge.getMasterSnapshot()?.loudnessNormalization.externalGainDb).toBe(manualGain)
    expect(bridge.saveNow()).toBe(true)
    loaded.fusion.detachV3Engine()

    loaded = await attachFresh()
    const restored = loaded.bridge
    const restoredParams = restored.getParams()
    const restoredSnapshot = restored.getMasterSnapshot()

    expect(restoredParams.bassEnhancer.enabled).toBe(false)
    expect(restoredParams.reverb.enabled).toBe(false)
    expect(restoredParams.loudnessCompensation.volumePercent).toBe(42)
    expect(restoredParams.loudnessNormalization.externalGainDb).toBe(manualGain)
    expect(restoredSnapshot?.bassEnhancer.enabled).toBe(true)
    expect(restoredSnapshot?.reverb.enabled).toBe(true)
    expect(restoredSnapshot?.loudnessCompensation.volumePercent).toBe(42)
    expect(restoredSnapshot?.loudnessNormalization.externalGainDb).toBe(manualGain)
    expect(restoredSnapshot?.sampleRate).toBe(48_000)

    // 使用真实控制器操作重载后的桥，验证已保存旁路态可继续调音和恢复。
    const [{ renderHook, act }, { useV3Params }] = await Promise.all([
      import('@testing-library/react/pure'),
      import('../ui/hooks'),
    ])
    const control = renderHook(() => useV3Params(restored))
    cleanupTasks.push(control.unmount)
    expect(control.result.current.masterEnabled).toBe(false)
    act(() => control.result.current.patch({
      loudnessNormalization: { externalGainDb: -18 },
    }, { markCustomized: false }))
    expect(control.result.current.masterEnabled).toBe(false)
    expect(restored.getMasterSnapshot()?.loudnessNormalization.externalGainDb).toBe(-18)

    act(() => control.result.current.setMasterEnabled(true))
    expect(control.result.current.masterEnabled).toBe(true)
    expect(restored.getMasterSnapshot()).toBeNull()
    expect(restored.getParams().bassEnhancer.enabled).toBe(true)
    expect(restored.getParams().reverb.enabled).toBe(true)
    expect(restored.getParams().loudnessNormalization.externalGainDb).toBe(-18)
    expect(restored.getParams().loudnessCompensation.volumePercent).toBe(42)
    expect(restored.getSaveState()).toBe('pending')
    expect(restored.saveNow()).toBe(true)
    expect(JSON.parse(localStorage.getItem('waveforge:v3-params') || '{}').__masterSnapshot).toBeNull()

    loaded.fusion.detachV3Engine()
  })

  it('SoundTouch 双支路先预热再交叉淡化，快速重新启用不会被旧关闭定时器拆除', { timeout: IMPORT_TIMEOUT }, async () => {
    soundTouchMock.register.mockResolvedValue(undefined)
    const { bridge, graph } = await attachFresh()
    const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
    const active = bridge.getParams(); active.pitch.enabled = true; active.pitch.semitones = 3
    bridge.setParams(active); await flush()
    expect(graph.audioContext.createGain).toHaveBeenCalledTimes(2)
    const [dry, wet] = graph.audioContext.createGain.mock.results.map(result => result.value)
    expect(wet.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
    soundTouchMock.nodes[0].dispatchEvent(new CustomEvent('metrics', { detail: { framesBuffered: 0 } }))
    expect(wet.gain.linearRampToValueAtTime).not.toHaveBeenCalled()
    soundTouchMock.nodes[0].dispatchEvent(new CustomEvent('metrics', { detail: { framesBuffered: 128 } }))
    const ready = 0.02
    expect(dry.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, ready)
    expect(wet.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, ready)
    // 非 pitch 参数更新不会取消预热阶段的自动化。
    const changed = bridge.getParams(); changed.bassEnhancer.enabled = true
    bridge.setParams(changed); await flush()
    expect(wet.gain.linearRampToValueAtTime).toHaveBeenCalledTimes(1)
    const inactive = bridge.getParams(); inactive.pitch.enabled = false
    bridge.setParams(inactive); await flush()
    expect(soundTouchMock.nodes[0].disconnect).not.toHaveBeenCalled()
    expect(wet.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.02)
    bridge.setParams(active); await flush(); vi.advanceTimersByTime(50)
    expect(soundTouchMock.nodes[0].disconnect).not.toHaveBeenCalled()
    expect(wet.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(1, ready)
    bridge.setParams(inactive); await flush(); vi.advanceTimersByTime(50)
    expect(soundTouchMock.nodes[0].disconnect).toHaveBeenCalledTimes(1)
    expect(dry.disconnect).toHaveBeenCalled(); expect(wet.disconnect).toHaveBeenCalled()
  })

  /** 宿主下发 spy：EngineV3Host.prototype.setParams 即「主线程引擎 + worklet postMessage」。 */
  async function hostSetParamsSpy() {
    const { EngineV3Host } = await import('../src/index')
    return vi.spyOn(EngineV3Host.prototype, 'setParams')
  }

  it('applyScene 与 setParams 走同一提交路径：宿主下发 + 持久化（不再绕过 worklet 下发）', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    expect(bridge.saveNow()).toBe(true)
    const hostSetParams = await hostSetParamsSpy()

    // applyScene 内部调用桥的 setParams → 桥内快照 → 引擎 → submit 钩子。
    // 旧实现 applyScene 走的是未包装的桥实例，宿主下发与持久化都被绕过。
    bridge.applyScene('pop')
    expect(bridge.getParams().sceneId).toBe('pop')
    expect(hostSetParams).toHaveBeenCalled()
    const submitted = hostSetParams.mock.calls.at(-1)![0] as V3EngineParams
    expect(submitted.sceneId).toBe('pop')
    expect(submitted.eq.proBands[0].gain).not.toBe(0)

    expect(bridge.getSaveState()).toBe('pending')
    vi.advanceTimersByTime(400)
    expect(bridge.getSaveState()).toBe('saved')
    expect(JSON.parse(localStorage.getItem('waveforge:v3-params') || '{}').sceneId).toBe('pop')
    fusion.detachV3Engine()
  })

  it('曲目 ReplayGain 注入经宿主统一下发（切歌不绕过 worklet 参数同步）', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    const initial = bridge.getParams()
    bridge.setParams({
      ...initial,
      loudnessNormalization: {
        ...initial.loudnessNormalization,
        enabled: true, useRealtimeMeter: false, replayGainMode: 'track',
      },
    })
    expect(bridge.saveNow()).toBe(true)
    const hostSetParams = await hostSetParamsSpy()

    fusion.setV3TrackReplayGainTags({ REPLAYGAIN_TRACK_GAIN: '-5.50 dB' })
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-5.5)
    expect(hostSetParams).toHaveBeenCalled()
    const submitted = hostSetParams.mock.calls.at(-1)![0] as V3EngineParams
    expect(submitted.loudnessNormalization.replayGainDb).toBe(-5.5)
    fusion.detachV3Engine()
  })

  it('快速连续切歌：ReplayGain 注入值变化不会被值相等短路吞掉', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    const initial = bridge.getParams()
    bridge.setParams({
      ...initial,
      loudnessNormalization: {
        ...initial.loudnessNormalization,
        enabled: true, useRealtimeMeter: false, replayGainMode: 'track',
      },
    })
    expect(bridge.saveNow()).toBe(true)
    const hostSetParams = await hostSetParamsSpy()

    fusion.setV3TrackReplayGainTags({ REPLAYGAIN_TRACK_GAIN: '-3.00 dB' })
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-3)
    expect(hostSetParams).toHaveBeenCalledTimes(1)

    // 第二次切歌（同一轮事件循环内）注入值变化：key 必变，不能被短路。
    fusion.setV3TrackReplayGainTags({ REPLAYGAIN_TRACK_GAIN: '-7.50 dB' })
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-7.5)
    expect(hostSetParams).toHaveBeenCalledTimes(2)
    const submitted = hostSetParams.mock.calls.at(-1)![0] as V3EngineParams
    expect(submitted.loudnessNormalization.replayGainDb).toBe(-7.5)

    // 注入值相同的重复提交仍短路（不重复下发/持久化）。
    fusion.setV3TrackReplayGainTags({ REPLAYGAIN_TRACK_GAIN: '-7.50 dB' })
    expect(hostSetParams).toHaveBeenCalledTimes(2)
    fusion.detachV3Engine()
  })

  it('IR 去重按引用标识：同参数换另一份 IR 重新下发，同一引用仍短路', { timeout: IMPORT_TIMEOUT }, async () => {
    const { fusion, bridge } = await attachFresh()
    expect(bridge.saveNow()).toBe(true)
    const hostSetParams = await hostSetParamsSpy()

    const base = bridge.getParams()
    const irA = Float32Array.from([0.5, 0.25, -0.125])
    const irB = Float32Array.from([0.5, 0.25, -0.125]) // 内容与 A 相同，引用不同
    bridge.setParams({
      ...base,
      reverb: {
        ...base.reverb, enabled: true, mode: 'convolution',
        convolution: { ...base.reverb.convolution, ir: irA, irName: 'a.wav' },
      },
    })
    expect(hostSetParams).toHaveBeenCalledTimes(1)
    expect(bridge.getParams().reverb.convolution.ir).toBe(irA)

    // 同一份 IR 引用 + 参数未变：短路，不再重复下发。
    bridge.setParams(bridge.getParams())
    expect(hostSetParams).toHaveBeenCalledTimes(1)

    // 同参数换另一份 IR（内容相同）：旧「ir-present」哨兵会误判重复，必须重新下发。
    const withA = bridge.getParams()
    bridge.setParams({
      ...withA,
      reverb: {
        ...withA.reverb,
        convolution: { ...withA.reverb.convolution, ir: irB, irName: 'b.wav' },
      },
    })
    expect(hostSetParams).toHaveBeenCalledTimes(2)
    expect(bridge.getParams().reverb.convolution.ir).toBe(irB)

    // 换回 A 也是另一次提交（token 变化），随后同引用再次短路。
    const withB = bridge.getParams()
    bridge.setParams({
      ...withB,
      reverb: { ...withB.reverb, convolution: { ...withB.reverb.convolution, ir: irA, irName: 'a.wav' } },
    })
    expect(hostSetParams).toHaveBeenCalledTimes(3)
    bridge.setParams(bridge.getParams())
    expect(hostSetParams).toHaveBeenCalledTimes(3)
    fusion.detachV3Engine()
  })

  it('SoundTouch Worklet 注册失败后，下一次 pitch 参数更新会重新注册', { timeout: IMPORT_TIMEOUT }, async () => {
    soundTouchMock.register.mockRejectedValueOnce(new Error('temporary load failure'))
      .mockResolvedValueOnce(undefined)
    const { bridge } = await attachFresh()
    const flushMicrotasks = async () => {
      for (let i = 0; i < 8; i++) await Promise.resolve()
    }

    const first = bridge.getParams()
    first.pitch.enabled = true
    first.pitch.semitones = 2
    bridge.setParams(first)
    await flushMicrotasks()
    expect(soundTouchMock.register).toHaveBeenCalledTimes(1)
    expect(soundTouchMock.nodes).toHaveLength(0)

    const retry = bridge.getParams()
    retry.pitch.semitones = 3
    bridge.setParams(retry)
    expect(soundTouchMock.register).toHaveBeenCalledTimes(2)
    await flushMicrotasks()
    expect(soundTouchMock.nodes).toHaveLength(1)
  })
})
