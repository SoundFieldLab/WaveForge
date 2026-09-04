/** @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppleCoverFx from '../src/components/AppleCoverFx'
import { PvLyricsPage } from '../src/components/pvLyrics/PvLyricsPage'
import type { PlaybackTimeStore } from '../src/audio/playbackTimeStore'

const pvMocks = vi.hoisted(() => ({ instances: [] as Array<Record<string, any>> }))

vi.mock('../src/vendor/pv/core/engine', () => ({
  PVEngine: class MockPVEngine {
    init = vi.fn(() => Promise.resolve())
    seek = vi.fn()
    destroy = vi.fn()
    resize = vi.fn()
    addEffect = vi.fn()
    setText = vi.fn()
    setLyricTimeline = vi.fn()
    setBeats = vi.fn()
    loadTemplate = vi.fn()
    addMedia = vi.fn()
    resume = vi.fn()
    pause = vi.fn()
    fadeToTemplate = vi.fn()
    beat = { bpm: 0 }
    onTemplateReload: (() => void) | null = null
    lyricOffset = 0
    alphaMode = false

    constructor() {
      pvMocks.instances.push(this)
    }
  },
}))
vi.mock('../src/vendor/pv/templates', () => ({ templates: [{}] }))
vi.mock('../src/services/autoMixAnalysisService', () => ({
  autoMixAnalysisService: { getCached: vi.fn(() => Promise.resolve(null)) },
}))
vi.mock('../src/components/pvLyrics/pvBridge', () => ({
  toPvLyrics: vi.fn(() => []),
  buildBeats: vi.fn(() => []),
}))
vi.mock('../src/components/pvLyrics/pvStyleMapping', () => ({
  recommendTemplates: vi.fn(() => [0]),
}))
vi.mock('../src/components/pvLyrics/pvDirector', () => ({
  compileScenes: vi.fn(() => []),
}))

class RafHarness {
  private nextId = 1
  readonly callbacks = new Map<number, FrameRequestCallback>()
  readonly cancelled: number[] = []

  request = vi.fn((callback: FrameRequestCallback) => {
    const id = this.nextId++
    this.callbacks.set(id, callback)
    return id
  })

  cancel = vi.fn((id: number) => {
    this.cancelled.push(id)
    this.callbacks.delete(id)
  })

  runNext(now = performance.now() + 17) {
    const entry = this.callbacks.entries().next().value as [number, FrameRequestCallback] | undefined
    if (!entry) throw new Error('No animation frame is pending')
    this.callbacks.delete(entry[0])
    entry[1](now)
  }
}

const canvasContext = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  save: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  arcTo: vi.fn(),
  closePath: vi.fn(),
  clip: vi.fn(),
  restore: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  globalAlpha: 1,
  fillStyle: '',
} as unknown as CanvasRenderingContext2D

let visibilityState: DocumentVisibilityState
let raf: RafHarness
let resizeObservers: Array<{ observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }>

beforeEach(() => {
  visibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  raf = new RafHarness()
  vi.stubGlobal('requestAnimationFrame', raf.request)
  vi.stubGlobal('cancelAnimationFrame', raf.cancel)
  resizeObservers = []
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe = vi.fn()
    disconnect = vi.fn()
    constructor() { resizeObservers.push(this) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvasContext)
  pvMocks.instances.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('AppleCoverFx animation lifecycle', () => {
  it('cleans animation resources when enabled changes from true to false', () => {
    const addListener = vi.spyOn(document, 'addEventListener')
    const removeListener = vi.spyOn(document, 'removeEventListener')
    const view = render(<AppleCoverFx enabled isPlaying size={240} radius={16} />)

    expect(raf.callbacks.size).toBe(1)
    expect(resizeObservers).toHaveLength(1)
    expect(resizeObservers[0].observe).toHaveBeenCalledOnce()
    const staleTick = [...raf.callbacks.values()][0]

    view.rerender(<AppleCoverFx enabled={false} isPlaying size={240} radius={16} />)

    expect(view.container.querySelector('canvas')).toBeNull()
    expect(raf.callbacks.size).toBe(0)
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce()
    expect(addListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    staleTick(performance.now() + 17)
    expect(raf.callbacks.size).toBe(0)
  })
})

describe('PvLyricsPage animation lifecycle', () => {
  const store: PlaybackTimeStore = {
    getSnapshot: () => ({ currentTime: 10, duration: 180, isPlaying: true }),
    subscribe: () => () => undefined,
    publish: () => undefined,
  }
  const props = {
    lyrics: [],
    currentIndex: 0,
    playbackTimeStore: store,
    timeOffset: 0,
    isPlaying: false,
    playerTheme: 'dark' as const,
    accentColor: '#fff',
    songTitle: 'Song',
    songArtist: 'Artist',
    trackId: 'track',
    translationEnabled: false,
    romanEnabled: false,
  }

  it('runs only while playing and visible, with one loop across resumes', async () => {
    const view = render(<PvLyricsPage {...props} />)
    await act(async () => { await Promise.resolve() })
    const engine = pvMocks.instances[0]

    expect(raf.callbacks.size).toBe(0)

    view.rerender(<PvLyricsPage {...props} isPlaying />)
    expect(raf.callbacks.size).toBe(1)
    act(() => raf.runNext())
    expect(engine.resume).toHaveBeenCalled()
    expect(raf.callbacks.size).toBe(1)

    view.rerender(<PvLyricsPage {...props} />)
    expect(raf.callbacks.size).toBe(0)
    expect(engine.pause).toHaveBeenCalled()

    view.rerender(<PvLyricsPage {...props} isPlaying />)
    expect(raf.callbacks.size).toBe(1)
    visibilityState = 'hidden'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(raf.callbacks.size).toBe(0)

    visibilityState = 'visible'
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(raf.callbacks.size).toBe(1)

    view.unmount()
    expect(raf.callbacks.size).toBe(0)
    expect(engine.destroy).toHaveBeenCalledOnce()
  })
})
