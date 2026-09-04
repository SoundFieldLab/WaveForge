// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('Apple WebView bridge polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('keeps state polling single-flight and stops after the final listener leaves', async () => {
    let slowState = false
    let stateRequests = 0
    let resolveState: (() => void) | null = null

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/ping')) return new Response(JSON.stringify({ ok: true, ready: true }))
      if (url.endsWith('/state')) {
        stateRequests += 1
        if (slowState) await new Promise<void>(resolve => { resolveState = resolve })
        return new Response(JSON.stringify({
          ready: true,
          authorized: true,
          playing: false,
          position: 0,
          duration: 180,
          title: '',
          artist: '',
          ended: false,
        }))
      }
      return new Response(JSON.stringify({ ok: true }))
    }))

    Object.defineProperty(window, 'electron', {
      configurable: true,
      value: { spawnAppleBridge: vi.fn(async () => ({ ok: true, token: 'test-session-token' })) },
    })

    const bridge = await import('../src/services/appleWebViewBridge')
    const starting = bridge.ensureBridgeRunning()
    await vi.advanceTimersByTimeAsync(500)
    await expect(starting).resolves.toBe(true)

    slowState = true
    const unsubscribe = bridge.onStateChange(() => undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(stateRequests).toBe(2)

    resolveState?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200)
    expect(stateRequests).toBe(3)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(stateRequests).toBe(3)
  })
})
