import { describe, expect, it, vi } from 'vitest'
import {
  createFrameGate,
  createRafThrottle,
  frameIntervalMs,
  resolveFrameRateBridge,
  type FrameRateTarget,
} from '../src/utils/frameRateLimiter'

// 这些用例覆盖「帧率上限到底有没有生效」这件事的真实行为。
// 背景：Electron 的 webContents.setFrameRate 只对离屏渲染生效，普通窗口下是空操作
// （实测 setFrameRate(15/30/60/120/240) 全部无效，rAF 恒等于显示器刷新率），
// 所以帧率上限改由渲染层的 rAF 蹦床实现，必须用行为测试守住，源码文本断言测不出来。

const target = (hz: number, displayHz: number, enabled = true): FrameRateTarget => ({ enabled, hz, displayHz })

describe('frameIntervalMs（目标帧率 → 最小帧间隔）', () => {
  it('尚未取到目标时不限流，避免启动瞬间误伤高刷档', () => {
    expect(frameIntervalMs(null)).toBe(0)
  })

  it('目标不低于显示器刷新率时不限流：全局高刷档必须保持满帧', () => {
    expect(frameIntervalMs(target(240, 240))).toBe(0)
    expect(frameIntervalMs(target(240, 144))).toBe(0)
    expect(frameIntervalMs(target(360, 240))).toBe(0)
  })

  it('关闭高刷时在高刷屏上真的限到 60Hz 基准', () => {
    expect(frameIntervalMs(target(60, 144, false))).toBeCloseTo(1000 / 60, 6)
    expect(frameIntervalMs(target(60, 240, false))).toBeCloseTo(1000 / 60, 6)
  })

  it('60Hz 屏上关闭高刷无需限流（限流本身也达不到更低）', () => {
    expect(frameIntervalMs(target(60, 60, false))).toBe(0)
  })

  it('自定义档位按实际间隔限流', () => {
    expect(frameIntervalMs(target(120, 240))).toBeCloseTo(1000 / 120, 6)
    expect(frameIntervalMs(target(30, 240))).toBeCloseTo(1000 / 30, 6)
  })

  it('非法值一律不限流，宁可满帧也不能把界面卡死', () => {
    expect(frameIntervalMs(target(0, 240))).toBe(0)
    expect(frameIntervalMs(target(-1, 240))).toBe(0)
    expect(frameIntervalMs(target(Number.NaN, 240))).toBe(0)
    expect(frameIntervalMs({ enabled: true, hz: 120, displayHz: Number.NaN })).toBeCloseTo(1000 / 120, 6)
  })
})

describe('resolveFrameRateBridge（三个 preload 的桥形状必须都认得）', () => {
  const target: FrameRateTarget = { enabled: false, hz: 60, displayHz: 240 }

  it('识别主窗桥（preload.cjs 的 display.getFrameRate / onFrameRate）', () => {
    const get = vi.fn(async () => target)
    const onFrameRate = vi.fn(() => () => undefined)
    const bridge = resolveFrameRateBridge({ electron: { display: { getFrameRate: get, onFrameRate } } })
    expect(bridge).not.toBeNull()
    expect(bridge?.get).toBe(get)
    expect(bridge?.onSet).toBe(onFrameRate)
  })

  it('识别桌面歌词窗桥（desktop-lyrics-preload.cjs 的 frameRate.get / onSet）', () => {
    const get = vi.fn(async () => target)
    const onSet = vi.fn(() => () => undefined)
    const bridge = resolveFrameRateBridge({ desktopLyrics: { frameRate: { get, onSet } } })
    expect(bridge?.get).toBe(get)
    expect(bridge?.onSet).toBe(onSet)
  })

  it('识别桌面播放器窗桥（desktop-player-preload.cjs 的 frameRate.get / onSet）', () => {
    const get = vi.fn(async () => target)
    const onSet = vi.fn(() => () => undefined)
    const bridge = resolveFrameRateBridge({ desktopPlayer: { frameRate: { get, onSet } } })
    expect(bridge?.get).toBe(get)
    expect(bridge?.onSet).toBe(onSet)
  })

  it('主窗桥优先于小窗桥', () => {
    const mainGet = vi.fn(async () => target)
    const lyricsGet = vi.fn(async () => target)
    const bridge = resolveFrameRateBridge({
      electron: { display: { getFrameRate: mainGet, onFrameRate: vi.fn() } },
      desktopLyrics: { frameRate: { get: lyricsGet, onSet: vi.fn() } },
    })
    expect(bridge?.get).toBe(mainGet)
  })

  it('命名不匹配的桥必须被拒绝，而不是静默接受（否则限流永不生效）', () => {
    // 主窗的桥被错当成小窗形状（get/onSet）——这正是曾经写错过的形态
    expect(resolveFrameRateBridge({ electron: { display: { get: vi.fn(), onSet: vi.fn() } } as never })).toBeNull()
    // 小窗的桥被错当成主窗形状
    expect(resolveFrameRateBridge({ desktopLyrics: { frameRate: { getFrameRate: vi.fn(), onFrameRate: vi.fn() } } as never })).toBeNull()
  })

  it('桥缺失或半成品时返回 null，不抛错', () => {
    expect(resolveFrameRateBridge({})).toBeNull()
    expect(resolveFrameRateBridge({ electron: {} })).toBeNull()
    expect(resolveFrameRateBridge({ electron: { display: {} } })).toBeNull()
    expect(resolveFrameRateBridge({ electron: { display: { getFrameRate: vi.fn() } } })).toBeNull()
    expect(resolveFrameRateBridge({ desktopLyrics: { frameRate: { get: vi.fn() } } })).toBeNull()
  })
})

describe('createFrameGate（哪些 vsync 该真正执行）', () => {
  const VSYNC_240 = 1000 / 240

  it('240Hz vsync 上按 60fps 目标放行：每 4 帧恰好放行 1 帧', () => {
    const gate = createFrameGate(() => 1000 / 60)
    let ran = 0
    for (let i = 1; i <= 240; i += 1) {
      if (gate.shouldRun(VSYNC_240 * i)) ran += 1
    }
    expect(ran).toBe(60)
  })

  it('120fps 目标在 240Hz vsync 上每 2 帧放行 1 帧', () => {
    const gate = createFrameGate(() => 1000 / 120)
    let ran = 0
    for (let i = 1; i <= 240; i += 1) {
      if (gate.shouldRun(VSYNC_240 * i)) ran += 1
    }
    expect(ran).toBe(120)
  })

  it('不限流时每一帧都放行', () => {
    const gate = createFrameGate(() => 0)
    let ran = 0
    for (let i = 1; i <= 30; i += 1) {
      if (gate.shouldRun(VSYNC_240 * i)) ran += 1
    }
    expect(ran).toBe(30)
  })

  it('某帧迟到后不会连补几帧造成突发', () => {
    const gate = createFrameGate(() => 1000 / 60)
    expect(gate.shouldRun(0.1)).toBe(true)
    // 一次 100ms 的长帧之后，下一帧必须重新等待一个完整间隔，而不是连续放行
    expect(gate.shouldRun(100.1)).toBe(true)
    expect(gate.shouldRun(100.2)).toBe(false)
    expect(gate.shouldRun(104.2)).toBe(false)
    expect(gate.shouldRun(117)).toBe(true)
  })

  it('reset 后立刻允许放行（用于显示器/档位切换）', () => {
    const gate = createFrameGate(() => 1000 / 60)
    expect(gate.shouldRun(0.1)).toBe(true)
    expect(gate.shouldRun(1)).toBe(false)
    gate.reset()
    expect(gate.shouldRun(1)).toBe(true)
  })
})

describe('createRafThrottle（替换全局 rAF 的蹦床）', () => {
  /** 假 vsync 源：手动按时间戳驱动，用来观察限流效果 */
  function makeHarness(getIntervalMs: () => number) {
    const vsyncCallbacks = new Map<number, (ts: number) => void>()
    let nextVsyncHandle = 1
    const throttle = createRafThrottle({
      raf: (cb) => {
        const handle = nextVsyncHandle
        nextVsyncHandle += 1
        vsyncCallbacks.set(handle, cb)
        return handle
      },
      caf: (handle) => {
        vsyncCallbacks.delete(handle)
      },
      getIntervalMs,
    })
    return {
      throttle,
      // 触发一次 vsync：与真实 rAF 一样，同一帧已注册的回调都收到同一个时间戳
      vsync(ts: number) {
        const snapshot = Array.from(vsyncCallbacks.values())
        vsyncCallbacks.clear()
        for (const cb of snapshot) cb(ts)
      },
      armedCount: () => vsyncCallbacks.size,
    }
  }

  const VSYNC_240 = 1000 / 240

  it('60fps 目标下，240 次 vsync 只执行 60 次回调', () => {
    const h = makeHarness(() => 1000 / 60)
    let runs = 0
    const loop = () => {
      runs += 1
      h.throttle.raf(loop)
    }
    h.throttle.raf(loop)
    for (let i = 1; i <= 240; i += 1) h.vsync(VSYNC_240 * i)
    expect(runs).toBe(60)
  })

  it('不限流时每次 vsync 都执行（高刷档不受影响）', () => {
    const h = makeHarness(() => 0)
    let runs = 0
    const loop = () => {
      runs += 1
      h.throttle.raf(loop)
    }
    h.throttle.raf(loop)
    for (let i = 1; i <= 100; i += 1) h.vsync(VSYNC_240 * i)
    expect(runs).toBe(100)
  })

  it('同一帧内注册的多个回调共用同一个时间戳，且只执行一次', () => {
    const h = makeHarness(() => 0)
    const seen: Array<[string, number]> = []
    h.throttle.raf((ts) => seen.push(['a', ts]))
    h.throttle.raf((ts) => seen.push(['b', ts]))
    h.vsync(16.7)
    expect(seen).toEqual([['a', 16.7], ['b', 16.7]])
  })

  it('回调内新注册的属于下一帧，不会在同一帧被重入', () => {
    const h = makeHarness(() => 0)
    const order: string[] = []
    let first = true
    const reentrant = () => {
      order.push(first ? 'outer' : 'inner')
      if (first) {
        first = false
        h.throttle.raf(reentrant)
      }
    }
    h.throttle.raf(reentrant)
    h.vsync(10)
    expect(order).toEqual(['outer'])
    h.vsync(20)
    expect(order).toEqual(['outer', 'inner'])
  })

  it('cancel 能真正拦住尚未执行的回调', () => {
    const h = makeHarness(() => 0)
    const spy = vi.fn()
    const handle = h.throttle.raf(spy)
    expect(h.throttle.pendingCount()).toBe(1)
    h.throttle.caf(handle)
    expect(h.throttle.pendingCount()).toBe(0)
    h.vsync(10)
    expect(spy).not.toHaveBeenCalled()
  })

  it('单个回调抛错不影响同帧其他回调，也不断掉后续帧', () => {
    const h = makeHarness(() => 0)
    const spy = vi.fn()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const throwing = () => {
      throw new Error('boom')
    }
    // 持续帧循环：每帧重新注册，用来验证抛错不会让后续帧停摆
    const persistent = () => {
      spy()
      h.throttle.raf(persistent)
    }
    h.throttle.raf(throwing)
    h.throttle.raf(persistent)
    h.vsync(10)
    h.vsync(20)
    expect(spy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('没有待执行回调时不再向 vsync 源注册（空闲零开销）', () => {
    const h = makeHarness(() => 0)
    const handle = h.throttle.raf(() => undefined)
    expect(h.armedCount()).toBe(1)
    h.throttle.caf(handle)
    h.vsync(10)
    expect(h.armedCount()).toBe(0)
  })

  it('档位在线切换后立刻按新目标限流', () => {
    let interval = 0
    const h = makeHarness(() => interval)
    let runs = 0
    const loop = () => {
      runs += 1
      h.throttle.raf(loop)
    }
    h.throttle.raf(loop)
    for (let i = 1; i <= 24; i += 1) h.vsync(VSYNC_240 * i)
    expect(runs).toBe(24)

    interval = 1000 / 60
    runs = 0
    for (let i = 25; i <= 264; i += 1) h.vsync(VSYNC_240 * i)
    expect(runs).toBe(60)
  })
})
