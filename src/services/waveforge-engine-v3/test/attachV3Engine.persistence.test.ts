// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V3EngineParams } from '../src/types'

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
    audioContext: { sampleRate, createScriptProcessor },
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
  })

  afterEach(() => {
    cleanupTasks.splice(0).reverse().forEach((cleanup) => cleanup())
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('参数变更经历 pending，防抖保存后变为 saved 并通知订阅者', async () => {
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

  it('写入失败进入 error，恢复存储后 saveNow 可重试回 saved', async () => {
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

  it('重载模块后恢复旁路快照，系统音量通道与效果恢复参数保持独立', async () => {
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
})
