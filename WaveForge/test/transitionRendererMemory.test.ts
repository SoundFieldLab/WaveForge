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
