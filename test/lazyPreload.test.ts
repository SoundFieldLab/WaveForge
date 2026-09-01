// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preloadOnIdle } from '../src/utils/lazyPreload'

describe('preloadOnIdle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads one module per idle turn and waits for the active loader', async () => {
    const callbacks = new Map<number, IdleRequestCallback>()
    let nextHandle = 1
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    })
    const cancelIdleCallback = vi.fn((handle: number) => callbacks.delete(handle))
    Object.assign(window, { requestIdleCallback, cancelIdleCallback })

    let resolveFirst: (() => void) | undefined
    const first = vi.fn(() => new Promise<void>(resolve => { resolveFirst = resolve }))
    const second = vi.fn(async () => undefined)
    const third = vi.fn(async () => undefined)

    preloadOnIdle([first, second, third], 1234)
    expect(requestIdleCallback).toHaveBeenCalledTimes(1)
    expect(requestIdleCallback).toHaveBeenLastCalledWith(expect.any(Function), { timeout: 1234 })

    callbacks.get(1)?.({ didTimeout: false, timeRemaining: () => 10 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalledTimes(1)

    resolveFirst?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(requestIdleCallback).toHaveBeenCalledTimes(2)

    callbacks.get(2)?.({ didTimeout: false, timeRemaining: () => 10 })
    await Promise.resolve()
    await Promise.resolve()
    expect(second).toHaveBeenCalledTimes(1)
    expect(third).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalledTimes(3)
  })

  it('cancels scheduled and subsequent preload work', async () => {
    const callbacks = new Map<number, IdleRequestCallback>()
    let nextHandle = 1
    const requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      const handle = nextHandle++
      callbacks.set(handle, callback)
      return handle
    })
    const cancelIdleCallback = vi.fn((handle: number) => callbacks.delete(handle))
    Object.assign(window, { requestIdleCallback, cancelIdleCallback })

    const beforeStart = vi.fn(async () => undefined)
    const cancelBeforeStart = preloadOnIdle([beforeStart])
    cancelBeforeStart()
    expect(cancelIdleCallback).toHaveBeenCalledWith(1)
    expect(beforeStart).not.toHaveBeenCalled()

    let resolveActive: (() => void) | undefined
    const active = vi.fn(() => new Promise<void>(resolve => { resolveActive = resolve }))
    const queued = vi.fn(async () => undefined)
    const cancelDuringLoad = preloadOnIdle([active, queued])
    callbacks.get(2)?.({ didTimeout: false, timeRemaining: () => 10 })
    cancelDuringLoad()
    resolveActive?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(active).toHaveBeenCalledTimes(1)
    expect(queued).not.toHaveBeenCalled()
    expect(requestIdleCallback).toHaveBeenCalledTimes(2)
  })
})
