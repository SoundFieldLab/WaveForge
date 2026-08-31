import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// node 测试环境无 window：seamlessJoinController 使用 window.setTimeout/clearTimeout。
// 用包装函数延迟解析 globalThis，保证 vi.useFakeTimers() 之后仍能拦截。
;(globalThis as Record<string, unknown>).window = {
  setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
  clearTimeout: (id: unknown) => globalThis.clearTimeout(id as number),
  requestAnimationFrame: (cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(performance.now()), 16),
  cancelAnimationFrame: (id: unknown) => globalThis.clearTimeout(id as number),
  clearInterval: (id: unknown) => globalThis.clearInterval(id as number),
  setInterval: (...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args),
}
;(globalThis as Record<string, unknown>).HTMLMediaElement = {
  HAVE_NOTHING: 0,
  HAVE_METADATA: 1,
  HAVE_CURRENT_DATA: 2,
  HAVE_FUTURE_DATA: 3,
  HAVE_ENOUGH_DATA: 4,
  NETWORK_EMPTY: 0,
}

// GaplessIntegration 依赖 AlbumGaplessService：mock 掉避免真实 DOM 依赖
vi.mock('../src/services/albumGapless', () => {
  class MockAlbumGaplessService {
    options: unknown
    constructor(options: unknown) { this.options = options }
    initAudioContext = vi.fn()
    setEnabled = vi.fn().mockReturnValue(true)
    setDirectJoinPreferred = vi.fn()
    schedulePreload = vi.fn().mockResolvedValue(true)
    getSongAlbumKey = vi.fn((song: { albumId?: string; albumCover?: string }) => song.albumId ? `${song.albumId}:${song.albumCover || ''}` : '')
    clearPreload = vi.fn()
    snapshot = () => ({ handoff: false, preload: { mixPending: false, mixStarted: false } })
  }
  return { AlbumGaplessService: MockAlbumGaplessService }
})

import { createSeamlessJoinController, type SeamlessJoinDeps } from '../src/services/gapless/seamlessJoinController'
import { GaplessIntegration } from '../src/services/gaplessIntegration'

function makeFakeAudio(overrides: Record<string, unknown> = {}) {
  return {
    src: 'blob:fake',
    error: null,
    readyState: 4,
    paused: true,
    currentTime: 0,
    duration: 240,
    seeking: false,
    buffered: { length: 1, end: () => 10 },
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    ...overrides,
  } as unknown as HTMLAudioElement
}

function makeDeps(overrides: Partial<ReturnType<typeof buildDeps>> = {}) {
  return buildDeps(overrides)
}

function buildDeps(overrides: Record<string, unknown> = {}) {
  const state: Record<string, unknown> = { boundaryTimer: null }
  const deps: SeamlessJoinDeps = {
    getActiveAudio: () => null,
    getStandbyAudio: () => null,
    getStandbyGain: () => null,
    setDeckGain: () => undefined,
    isGaplessEnabled: () => true,
    isTransitionRunning: () => false,
    hasActiveTransition: () => false,
    getRevision: () => 1,
    commitTransition: vi.fn(),
    startGaplessTransition: vi.fn(),
    resetGaplessIntegration: vi.fn(),
    setTransitionState: vi.fn(),
    setBoundaryTimer: (timer: number | null) => { state.boundaryTimer = timer },
    getBoundaryTimer: () => state.boundaryTimer as number | null,
  }
  return Object.assign(deps, overrides)
}

describe('SeamlessJoinController（专辑首选拼接）', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('专辑 + standby 就绪：scheduleBoundary 武装首选拼接', () => {
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    const standby = makeFakeAudio()
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => standby
    controller.scheduleBoundary({ active, remaining: 0.8, albumPlayback: true })
    // 首选路径会挂边界 timer（兜底）；armed 后 onEnded 走直接拼接
    expect(deps.getBoundaryTimer()).not.toBeNull()
    controller.cancelBoundaryTimer()
  })

  it('standby 未就绪（专辑场景兜底）：走 60ms 淡入淡出备选', () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    const standby = makeFakeAudio({ readyState: 0, buffered: { length: 0, end: () => 0 } })
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => standby
    controller.scheduleBoundary({ active, remaining: 0.5, albumPlayback: true })
    vi.advanceTimersByTime(501)
    expect(deps.startGaplessTransition).toHaveBeenCalledTimes(1)
  })

  it('ended 时首选拼接：commitTransition("gapless") 被调用', async () => {
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    // 模拟真实元素：play() 后 paused 变为 false
    const standby = makeFakeAudio({
      play: vi.fn().mockImplementation(function (this: HTMLAudioElement) {
        this.paused = false
        return Promise.resolve()
      }),
    })
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => standby
    controller.scheduleBoundary({ active, remaining: 0.8, albumPlayback: true })
    // 就绪（warmupDone 或实时缓冲均满足 standbySeamlessReady → 首选分支）
    const handled = controller.onEnded(standby)
    expect(handled).toBe(true)
    // onEnded 内部 await play()/waitForSeek：flush 微任务
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.commitTransition).toHaveBeenCalledWith('gapless', 0, 1)
    expect(deps.setTransitionState).toHaveBeenCalled()
  })

  it('ended 拼接等待 play 期间 reset：旧 continuation 不提交', async () => {
    let resolvePlay: (() => void) | null = null
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    const standby = makeFakeAudio({
      play: vi.fn().mockImplementation(function (this: HTMLAudioElement) {
        return new Promise<void>(resolve => {
          resolvePlay = () => {
            this.paused = false
            resolve()
          }
        })
      }),
    })
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => standby
    controller.scheduleBoundary({ active, remaining: 0.8, albumPlayback: true })
    expect(controller.onEnded(standby)).toBe(true)
    controller.reset()
    resolvePlay?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(deps.commitTransition).not.toHaveBeenCalled()
    expect(deps.setTransitionState).not.toHaveBeenCalledWith('running-transition', expect.anything())
  })

  it('ended 时 standby 无缓冲：返回 false 让调用方走备选', async () => {
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    const standby = makeFakeAudio({ buffered: { length: 0, end: () => 0 } })
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => standby
    controller.scheduleBoundary({ active, remaining: 0.8, albumPlayback: true })
    const handled = controller.onEnded(standby)
    expect(handled).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deps.commitTransition).not.toHaveBeenCalled()
  })

  it('未武装时 ended 不触发拼接', () => {
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    expect(controller.onEnded(makeFakeAudio())).toBe(false)
  })

  it('cancelBoundaryTimer 清除边界调度', () => {
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => makeFakeAudio()
    controller.scheduleBoundary({ active, remaining: 0.8, albumPlayback: true })
    expect(deps.getBoundaryTimer()).not.toBeNull()
    controller.cancelBoundaryTimer()
    expect(deps.getBoundaryTimer()).toBeNull()
  })

  it('reset 后兜底 timer 触发不再启动过渡（安全 no-op）', () => {
    vi.useFakeTimers()
    const deps = makeDeps()
    const controller = createSeamlessJoinController(deps)
    const active = makeFakeAudio()
    deps.getActiveAudio = () => active
    deps.getStandbyAudio = () => makeFakeAudio()
    controller.scheduleBoundary({ active, remaining: 0.5, albumPlayback: true })
    controller.reset()
    vi.advanceTimersByTime(5000)
    expect(deps.startGaplessTransition).not.toHaveBeenCalled()
    expect(deps.commitTransition).not.toHaveBeenCalled()
  })
})

describe('GaplessIntegration（同专辑判定与方案分流）', () => {
  function makeIntegration() {
    const integration = new GaplessIntegration({
      enabled: true,
      albumGaplessEnabled: true,
      getCurrentAudio: () => null,
      getCurrentTime: () => 0,
      getCurrentIndex: () => 0,
      getCurrentTrackKey: () => 'a',
      getTargetVolume: () => 1,
      setOutputGain: () => undefined,
      getOutputGain: () => 1,
      getPlayQueue: () => [],
      canAdvance: () => true,
      playAt: async () => true,
      prepareAudioUrl: async (song) => song.url,
    })
    return { integration, albumGapless: (integration as unknown as { albumGapless: { setDirectJoinPreferred: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn>; schedulePreload: ReturnType<typeof vi.fn> } }).albumGapless }
  }

  it('同专辑 + 开启专辑融合 → 调度尾部检测与 Equal Power 预载', async () => {
    const { integration, albumGapless } = makeIntegration()
    const result = await integration.prepareTransition({
      token: 1,
      currentIndex: 0,
      nextIndex: 1,
      currentSong: { key: 'a', url: 'u1', albumId: 'alb-1' },
      nextSong: { key: 'b', url: 'u2', albumId: 'alb-1' },
    })
    expect(result).toEqual({ success: true, mode: 'album-gapless' })
    expect(albumGapless.setDirectJoinPreferred).toHaveBeenCalledWith(false)
    expect(albumGapless.setEnabled).toHaveBeenCalledWith(true, null, 'alb-1:')
    expect(albumGapless.schedulePreload).toHaveBeenCalledWith(1, 1, expect.objectContaining({ key: 'b', url: 'u2' }))
  })

  it('跨专辑 → 普通无缝边界（直接拼接不武装）', async () => {
    const { integration, albumGapless } = makeIntegration()
    const result = await integration.prepareTransition({
      token: 1,
      currentIndex: 0,
      nextIndex: 1,
      currentSong: { key: 'a', url: 'u1', albumId: 'alb-1' },
      nextSong: { key: 'b', url: 'u2', albumId: 'alb-2' },
    })
    expect(result).toEqual({ success: false, mode: 'disabled' })
    expect(albumGapless.setDirectJoinPreferred).toHaveBeenCalledWith(false)
  })

  it('未开启专辑融合：同专辑也不走首选拼接', async () => {
    const integration = new GaplessIntegration({
      enabled: true,
      albumGaplessEnabled: false,
      getCurrentAudio: () => null,
      getCurrentTime: () => 0,
      getCurrentIndex: () => 0,
      getCurrentTrackKey: () => 'a',
      getTargetVolume: () => 1,
      setOutputGain: () => undefined,
      getOutputGain: () => 1,
      getPlayQueue: () => [],
      canAdvance: () => true,
      playAt: async () => true,
      prepareAudioUrl: async (song) => song.url,
    })
    const albumGapless = (integration as unknown as { albumGapless: { setDirectJoinPreferred: ReturnType<typeof vi.fn>; setEnabled: ReturnType<typeof vi.fn> } }).albumGapless
    await integration.prepareTransition({
      token: 1,
      currentIndex: 0,
      nextIndex: 1,
      currentSong: { key: 'a', url: 'u1', albumId: 'alb-1' },
      nextSong: { key: 'b', url: 'u2', albumId: 'alb-1' },
    })
    expect(albumGapless.setDirectJoinPreferred).toHaveBeenCalledWith(false)
  })

  it('关闭无缝衔接时直接 disabled', async () => {
    const integration = new GaplessIntegration({
      enabled: false,
      albumGaplessEnabled: true,
      getCurrentAudio: () => null,
      getCurrentTime: () => 0,
      getCurrentIndex: () => 0,
      getCurrentTrackKey: () => 'a',
      getTargetVolume: () => 1,
      setOutputGain: () => undefined,
      getOutputGain: () => 1,
      getPlayQueue: () => [],
      canAdvance: () => true,
      playAt: async () => true,
      prepareAudioUrl: async (song) => song.url,
    })
    const result = await integration.prepareTransition({
      token: 1,
      currentIndex: 0,
      nextIndex: 1,
      currentSong: { key: 'a', url: 'u1', albumId: 'alb-1' },
      nextSong: { key: 'b', url: 'u2', albumId: 'alb-1' },
    })
    expect(result.mode).toBe('disabled')
  })
})
