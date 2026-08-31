// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AirplayController } from '../src/services/airplayController'

const idleStatus = { phase: 'idle', devices: [] }
const connectedStatus = { phase: 'connected', devices: [] }

describe('AirplayController sync timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('runs no polling timer until connected and stops after disconnect status', async () => {
    let statusListener: ((status: typeof idleStatus) => void) | null = null
    const bridge = {
      onStatus: vi.fn((listener: (status: typeof idleStatus) => void) => {
        statusListener = listener
        return () => { statusListener = null }
      }),
      getStatus: vi.fn(async () => idleStatus),
      setMetadata: vi.fn(async () => undefined),
      setProgress: vi.fn(async () => undefined),
      setStreaming: vi.fn(),
    }
    Object.defineProperty(window, 'electron', { configurable: true, value: { airplay: bridge } })
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval')
    const controller = new AirplayController()

    controller.init()
    controller.attachProbe(() => ({ title: 'Song', artist: 'Artist', album: '', coverUrl: '', durationMs: 1_000, elapsedMs: 0, isPlaying: false }))
    await Promise.resolve()
    expect(setIntervalSpy).not.toHaveBeenCalled()

    statusListener?.(connectedStatus)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    statusListener?.(connectedStatus)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    statusListener?.(idleStatus)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    controller.dispose()
  })
})
