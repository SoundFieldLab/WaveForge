import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransitionRenderer } from '../src/audio/TransitionRenderer.ts'
import type { TransitionPlan } from '../src/audio/types'

/**
 * TransitionRenderer 内存安全契约测试：
 * - 渲染产物缓存有硬上限（条目数 / 总字节 / TTL）
 * - 超限按最旧逐出，字节计数同步扣减
 * - 播放即删（one-shot）：playTransition 取出后立即释放缓存引用
 * - 取消/替换路径 stopPlayback 显式释放 buffer 引用
 */

function makeFakeAudioBuffer(length: number, channels = 2, sampleRate = 44100) {
  return {
    length,
    numberOfChannels: channels,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  } as unknown as AudioBuffer
}

function makePlan(id: string, bytes: number): TransitionPlan {
  // bytes 仅用于估算；此处构造一个最小的合法 plan
  void bytes
  return {
    id,
    sourceTrackKey: 'src',
    targetTrackKey: 'tgt',
    sourceStartTime: 0,
    sourceEndTime: 10,
    targetStartTime: 0,
    targetEndTime: 10,
    beatCount: 16,
    sourceBpm: 120,
    targetBpm: 120,
    tempoRamp: [],
    sourceDownbeatIndex: 0,
    targetDownbeatIndex: 0,
    gainCurve: { source: [], target: [] },
    confidence: 0.9,
    strategy: 'smart-rendered-v2',
    analysisVersion: 'v1',
    rendererVersion: 'automix-v2-dsp-r1',
  }
}

function makeFakeContext() {
  const sources = new Set<{
    buffer: AudioBuffer | null
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
  }>()
  const gains = new Set<{
    gain: { value: number; setValueAtTime: ReturnType<typeof vi.fn>; linearRampToValueAtTime: ReturnType<typeof vi.fn>; cancelScheduledValues: ReturnType<typeof vi.fn> }
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }>()
  return {
    sources,
    gains,
    destination: {},
    currentTime: 0,
    createBuffer: () => makeFakeAudioBuffer(44100),
    createGain: () => {
      const gain = {
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
        connect: vi.fn(),
        disconnect: vi.fn(),
      }
      gains.add(gain)
      return gain
    },
    createBufferSource: () => {
      const source = {
        buffer: null,
        stop: vi.fn(),
        disconnect: vi.fn(),
        connect: vi.fn(),
        start: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }
      sources.add(source)
      return source
    },
  } as unknown as AudioContext
}

describe('TransitionRenderer 渲染产物缓存内存安全', () => {
  let context: ReturnType<typeof makeFakeContext>
  let renderer: TransitionRenderer
  let clock: ReturnType<typeof vi.useFakeTimers>

  beforeEach(() => {
    clock = vi.useFakeTimers()
    context = makeFakeContext()
    renderer = new TransitionRenderer(context as unknown as AudioContext)
  })

  afterEach(() => {
    renderer.dispose()
    vi.useRealTimers()
  })

  it('缓存条目数上限（10）：超限逐出最旧，字节计数同步', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void; getCacheSize: () => number }
    for (let i = 0; i < 12; i += 1) {
      const buffer = makeFakeAudioBuffer(44100) // 1s stereo ≈ 352KB
      rendererAny.addToCache(makePlan(`plan-${i}`, 0), buffer)
    }
    expect(renderer.getCacheSize()).toBe(10)
    // 最旧的 2 条（plan-0、plan-1）已被逐出
    expect(renderer.getRendered('plan-0')).toBeNull()
    expect(renderer.getRendered('plan-1')).toBeNull()
    expect(renderer.getRendered('plan-11')).not.toBeNull()
  })

  it('缓存总字节上限（128MB）：单条超限不缓存，累计超限逐出', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    // 每条 40MB 立体声 buffer（~8 分钟时长等价）
    const big = makeFakeAudioBuffer(40 * 1024 * 1024 / 2 / 4, 2, 44100)
    rendererAny.addToCache(makePlan('huge-1', 0), big)
    rendererAny.addToCache(makePlan('huge-2', 0), big)
    rendererAny.addToCache(makePlan('huge-3', 0), big)
    rendererAny.addToCache(makePlan('huge-4', 0), big)
    // 3 条 = 120MB < 128MB；第 4 条加入前逐出最旧
    expect(renderer.getCacheSize()).toBe(3)
    expect(renderer.getRendered('huge-1')).toBeNull()
  })

  it('TTL 5 分钟到期后自动清理', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('ttl-plan', 0), makeFakeAudioBuffer(44100))
    expect(renderer.getRendered('ttl-plan')).not.toBeNull()
    vi.advanceTimersByTime(6 * 60 * 1000)
    expect(renderer.getRendered('ttl-plan')).toBeNull()
  })

  it('playTransition 一次性消费：取出后缓存立即删除，buffer 引用释放', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    const buffer = makeFakeAudioBuffer(44100)
    rendererAny.addToCache(makePlan('one-shot', 0), buffer)
    expect(renderer.getRendered('one-shot')).not.toBeNull()

    const result = await renderer.playTransition('one-shot', 0)
    expect(result).not.toBeNull()
    // 播放后缓存条目已删除，buffer 不再被缓存引用
    expect(renderer.getRendered('one-shot')).toBeNull()
    // 活跃 source 持有 buffer 引用；stopPlayback 时释放
    const source = [...context.sources][0]
    expect(source).toBeDefined()
    expect(source.buffer).not.toBeNull()
    renderer.stopPlayback()
    expect(source.buffer).toBeNull()
    expect(source.disconnect).toHaveBeenCalled()
  })

  it('clearCache / dispose 释放全部缓存与活跃播放', () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('a', 0), makeFakeAudioBuffer(44100))
    rendererAny.addToCache(makePlan('b', 0), makeFakeAudioBuffer(44100))
    expect(renderer.getCacheSize()).toBe(2)
    renderer.dispose()
    expect(renderer.getCacheSize()).toBe(0)
  })
})

describe('TransitionRenderer playTransition（事件驱动 handoff + 迟到保护）', () => {
  let context: ReturnType<typeof makeFakeContext>
  let renderer: TransitionRenderer

  beforeEach(() => {
    vi.useFakeTimers()
    context = makeFakeContext()
    renderer = new TransitionRenderer(context as unknown as AudioContext)
  })

  afterEach(() => {
    renderer.dispose()
    vi.useRealTimers()
  })

  it('ended 事件触发 onEnded 回调（事件驱动 handoff）', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    const plan = makePlan('handoff-plan', 0)
    rendererAny.addToCache(plan, makeFakeAudioBuffer(44100))
    let endedCalled = false
    const result = await renderer.playTransition('handoff-plan', 0, () => { endedCalled = true })
    expect(result).not.toBeNull()
    expect(result?.targetResumeTime).toBe(plan.targetEndTime)
    // 触发缓冲源 ended 事件 → onEnded 应被调用
    const source = [...context.sources][0]
    const endedHandler = source.addEventListener.mock.calls.find(([name]: [string]) => name === 'ended')
    expect(endedHandler).toBeDefined()
    const callback = endedHandler![1] as () => void
    callback()
    expect(endedCalled).toBe(true)
    expect(source.buffer).toBeNull()
    expect(source.disconnect).toHaveBeenCalled()
  })

  it('迟到保护：触发偏移超过缓冲 85% 时返回 tooLate 且不启动缓冲', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('late-plan', 0), makeFakeAudioBuffer(44100))
    // buffer.duration = 1s；sourceStartTime=0 → offset=0.95s > 0.85s
    const result = await renderer.playTransition('late-plan', 0.95)
    expect(result).not.toBeNull()
    expect(result?.tooLate).toBe(true)
    expect(context.sources.size).toBe(0) // 未创建缓冲源
  })

  it('正常触发时 tooLate 为 undefined 且缓冲源已启动', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    rendererAny.addToCache(makePlan('ok-plan', 0), makeFakeAudioBuffer(44100))
    const result = await renderer.playTransition('ok-plan', 0)
    expect(result?.tooLate).toBeUndefined()
    expect(context.sources.size).toBe(1)
    expect([...context.sources][0].start).toHaveBeenCalledWith(0, 0)
  })

  it('overlap handoff：请求 overlap 时创建过渡增益节点、尾段渐出、返回 overlap 窗口', async () => {
    const rendererAny = renderer as unknown as { addToCache: (p: TransitionPlan, b: AudioBuffer) => void }
    // 4 秒缓冲（buffer.duration=4s），overlap 2s ≤ 4×0.35=1.4s？→ 会被钳制到 1.4s
    const buffer = makeFakeAudioBuffer(4 * 44100)
    rendererAny.addToCache(makePlan('overlap-plan', 0), buffer)
    const result = await renderer.playTransition('overlap-plan', 0, undefined, { overlap: 2 })
    expect(result).not.toBeNull()
    // overlap 被钳制到缓冲时长 35%（1.4s），且返回给调用方
    expect(result?.overlap).toBeCloseTo(1.4, 3)
    // 创建了过渡增益节点：source → gain → destination
    expect(context.gains.size).toBe(1)
    const gain = [...context.gains][0]
    expect(gain.gain.linearRampToValueAtTime).toHaveBeenCalled()
    const source = [...context.sources][0]
    expect(source.connect).toHaveBeenCalledWith(gain)
    // 无 overlap 请求时不创建增益节点
    renderer.stopPlayback()
    rendererAny.addToCache(makePlan('no-overlap-plan', 0), makeFakeAudioBuffer(4 * 44100))
    await renderer.playTransition('no-overlap-plan', 0)
    expect(context.gains.size).toBe(1) // 仍是上一个的 1 个
    const latestSource = [...context.sources].at(-1)!
    expect(latestSource.connect).not.toHaveBeenCalledWith(gain)
  })
})

describe('TransitionRenderer DJTransGAN 可选性', () => {
  it('v2 aiMix=false 时 automation 与 60s 长混音均为零调用', async () => {
    const context = makeFakeContext() as unknown as AudioContext & { decodeAudioData: ReturnType<typeof vi.fn> }
    context.decodeAudioData = vi.fn().mockResolvedValue(makeFakeAudioBuffer(44100))
    const transition = vi.fn().mockResolvedValue({
      success: true,
      outputPath: 'D:/tmp/v2.wav',
      stretchApplied: true,
      djEffectsApplied: true,
    })
    const aiMixAutomation = vi.fn()
    const transitionAiMix = vi.fn()
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        audioDownload: {
          prepare: vi.fn(async (_url: string, trackKey: string) => `D:/tmp/${trackKey}.wav`),
        },
        render: {
          transition,
          aiMixAutomation,
          transitionAiMix,
          getAudioUrl: vi.fn().mockResolvedValue('waveforge-media://v2.wav'),
          readAudioFile: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        },
      },
      setTimeout,
    }
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as Response)

    try {
      const renderer = new TransitionRenderer(context)
      const plan = { ...makePlan('optional-ai-off', 0), v2: { aiMix: false } }
      await renderer.preRender({ sourceUrl: 'https://source', targetUrl: 'https://target', plan })
      expect(transition).toHaveBeenCalledTimes(1)
      expect(aiMixAutomation).not.toHaveBeenCalled()
      expect(transitionAiMix).not.toHaveBeenCalled()
      renderer.dispose()
    } finally {
      fetchStub.mockRestore()
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('v2 aiMix=false 且 stems 可用时把精炼计划发送到 Folia renderer', async () => {
    const context = makeFakeContext() as unknown as AudioContext & { decodeAudioData: ReturnType<typeof vi.fn> }
    context.decodeAudioData = vi.fn().mockResolvedValue(makeFakeAudioBuffer(44100))
    const transition = vi.fn().mockResolvedValue({ success: true, outputPath: 'D:/tmp/stem.wav', stretchApplied: true, djEffectsApplied: true })
    const points = (start: number, quiet = false) => Array.from({ length: 21 }, (_, i) => ({
      time: start + i * 0.5,
      db: quiet && i < 2 ? -70 : -12,
      activity: quiet && i < 2 ? 0 : 0.8,
    }))
    const artifact = (side: 'source' | 'target') => {
      const start = side === 'source' ? 0 : 0
      return {
        version: 1, engine: 'test', cacheKey: `${side}-key`, cached: false, requestId: side,
        startSeconds: start, duration: 10, sampleRate: 44100, channels: 2, frames: 441000,
        files: { drums: `${side}-d.wav`, bass: `${side}-b.wav`, vocals: `${side}-v.wav`, other: `${side}-o.wav` },
        evidence: { drums: points(start), bass: points(start), vocals: points(start, side === 'target'), other: points(start) },
        manifestPath: `${side}.json`,
      }
    }
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        audioDownload: { prepare: vi.fn(async (_url: string, trackKey: string) => `D:/tmp/${trackKey}.wav`) },
        stems: {
          status: vi.fn().mockResolvedValue({ available: true }),
          separate: vi.fn(async (request: { mode: string }) => artifact(request.mode === 'tail' ? 'source' : 'target')),
          cancel: vi.fn(),
        },
        render: {
          transition,
          aiMixAutomation: vi.fn(), transitionAiMix: vi.fn(),
          getAudioUrl: vi.fn().mockResolvedValue('waveforge-media://stem.wav'),
          readAudioFile: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        },
      }, setTimeout,
    }
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
    try {
      const renderer = new TransitionRenderer(context)
      const base = makePlan('stem-route', 0)
      const plan: TransitionPlan = {
        ...base,
        sourceBeatTimes: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
        targetBeatTimes: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10],
        v2: { aiMix: false, stemRequirement: { source: { role: 'tail', startTime: 0, duration: 10 }, target: { role: 'head', startTime: 0, duration: 10 }, model: 'htdemucs', modelVersion: 'test' } },
      }
      await renderer.preRender({ sourceUrl: 'https://source', targetUrl: 'https://target', plan })
      expect(transition).toHaveBeenCalledTimes(1)
      const sentPlan = transition.mock.calls[0][0] as TransitionPlan
      expect(sentPlan.v2?.stemChoreography).toBeDefined()
      expect(sentPlan.v2?.stemArtifacts?.source.cacheKey).toBe('source-key')
      expect(sentPlan.v2?.aiMix).toBe(false)
      expect(sentPlan.v2?.backend).toBe('folia-htdemucs')
      expect(sentPlan.rendererVersion).toContain('stems-v1')
      renderer.dispose()
    } finally {
      fetchStub.mockRestore()
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('DJ enabled on a short source skips Torch and routes directly to Folia', async () => {
    const context = makeFakeContext() as unknown as AudioContext & { decodeAudioData: ReturnType<typeof vi.fn> }
    context.decodeAudioData = vi.fn().mockResolvedValue(makeFakeAudioBuffer(44100))
    const transitionAiMix = vi.fn()
    const samples = Array.from({ length: 21 }, (_, i) => ({ time: i * 0.5, db: -12, activity: 0.8 }))
    const separate = vi.fn(async (request: { mode: string }) => {
      const side = request.mode === 'tail' ? 'source' : 'target'
      return {
        version: 1, engine: 'test', cacheKey: `${side}-key`, cached: false, requestId: side,
        startSeconds: 0, duration: 10, sampleRate: 44100, channels: 2, frames: 441000,
        files: { drums: `${side}-d.wav`, bass: `${side}-b.wav`, vocals: `${side}-v.wav`, other: `${side}-o.wav` },
        evidence: { drums: samples, bass: samples, vocals: samples, other: samples }, manifestPath: `${side}.json`,
      }
    })
    const transition = vi.fn().mockResolvedValue({ success: true, outputPath: 'D:/tmp/folia.wav', stretchApplied: true, djEffectsApplied: false, stemMixApplied: true, backend: 'folia-htdemucs', targetResumeTime: 10 })
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electron: {
        audioDownload: { prepare: vi.fn(async (_url: string, trackKey: string) => `D:/tmp/${trackKey}.wav`) },
        stems: { status: vi.fn().mockResolvedValue({ available: true }), separate, cancel: vi.fn() },
        render: {
          transition, transitionAiMix, aiMixAutomation: vi.fn(), aiMixStatus: vi.fn().mockResolvedValue({ available: true }),
          getAudioUrl: vi.fn().mockResolvedValue('waveforge-media://folia.wav'), readAudioFile: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        },
      }, setTimeout,
    }
    const fetchStub = vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) } as Response)
    try {
      const renderer = new TransitionRenderer(context)
      const plan: TransitionPlan = {
        ...makePlan('dj-short-folia', 0),
        sourceBeatTimes: Array.from({ length: 21 }, (_, i) => i * 0.5),
        targetBeatTimes: Array.from({ length: 21 }, (_, i) => i * 0.5),
        djEffects: { enabled: true, profile: 'smooth', intensity: 0.5, bassSwap: true, filterSweep: true, echoOut: false, sweepFx: false, echoDelayBeats: 0.5, echoFeedback: 0.2 },
        v2: { aiMix: true, backend: 'djtransgan', stemRequirement: { source: { role: 'tail', startTime: 0, duration: 10 }, target: { role: 'head', startTime: 0, duration: 10 }, model: 'htdemucs', modelVersion: 'test' } },
      }
      await renderer.preRender({ sourceUrl: 'https://source', targetUrl: 'https://target', plan })
      expect(transitionAiMix).not.toHaveBeenCalled()
      expect(separate).toHaveBeenCalledTimes(2)
      expect((transition.mock.calls[0][0] as TransitionPlan).v2?.backend).toBe('folia-htdemucs')
      renderer.dispose()
    } finally {
      fetchStub.mockRestore()
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

})
