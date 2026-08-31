/** @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BilibiliMvBackground from '../src/components/BilibiliMvBackground'
import * as bili from '../src/services/bilibiliApi'

vi.mock('../src/services/bilibiliApi', () => ({
  findBestBilibiliMv: vi.fn(),
  getBilibiliView: vi.fn(),
  getBilibiliPlayUrl: vi.fn(),
  bilibiliStreamUrl: vi.fn((key: string, kind: string) => `http://stream/${key}/${kind}`),
  pickBestPage: vi.fn(() => 0),
  flattenLyricLinesForMatch: vi.fn(() => []),
  songKeyOf: vi.fn((ctx: { songTitle: string; id?: string | number }) => `${ctx.songTitle}:${ctx.id ?? ''}`),
  setBilibiliOverride: vi.fn(),
  getBilibiliOverride: vi.fn(() => null),
  clearBilibiliOverride: vi.fn(),
  getBilibiliWatchSettings: vi.fn(() => ({ targetQuality: 'auto' })),
  resolveBiliPic: vi.fn((url: string) => url),
  formatBiliTime: vi.fn(() => '3:00'),
}))

vi.mock('../src/services/mvAlignment', () => ({
  ensureMvAlignment: vi.fn(() => Promise.resolve()),
  getMvAlignment: vi.fn(() => null),
  prewarmMvBeatAnalysis: vi.fn(() => Promise.resolve()),
  MIN_ALIGNMENT_CONFIDENCE: 0.6,
}))

const candidate = (bvid: string) => ({
  video: { bvid, title: bvid, duration: 180, play: 1, author: 'artist', pic: '' },
  cid: 1,
  score: 100,
  signals: {},
  rank: 0,
  officialVerifyType: -1,
  manualZhSubtitle: false,
  autoSubtitle: false,
  type: 'official',
}) as any

const autoResult = (bvid: string) => ({
  status: 'auto',
  best: candidate(bvid),
  candidates: [candidate(bvid)],
  fallbackChain: [candidate(bvid)],
}) as any

function setMediaState(video: HTMLVideoElement, values: { readyState?: number; duration?: number; currentTime?: number }) {
  if (values.readyState !== undefined) Object.defineProperty(video, 'readyState', { configurable: true, value: values.readyState })
  if (values.duration !== undefined) Object.defineProperty(video, 'duration', { configurable: true, value: values.duration })
  if (values.currentTime !== undefined) video.currentTime = values.currentTime
}

function baseProps(audio: HTMLAudioElement) {
  return {
    songTitle: 'Current',
    songArtists: ['Artist'],
    songDuration: 180,
    songId: 'current',
    songTrackKey: 'current-track',
    isPlaying: false,
    getAudioElement: () => audio,
  }
}

beforeEach(() => {
  vi.mocked(bili.getBilibiliPlayUrl).mockResolvedValue({ code: 0, cacheKey: 'cache' } as any)
  vi.stubGlobal('fetch', vi.fn())
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('BilibiliMvBackground regressions', () => {
  it('preloads a transition target without requiring current-search controller identity', async () => {
    const audio = new Audio()
    let resolveCurrent!: (value: any) => void
    const currentSearch = new Promise((resolve) => { resolveCurrent = resolve })
    vi.mocked(bili.findBestBilibiliMv).mockImplementation((ctx: any) => (
      ctx.songTitle === 'Current' ? currentSearch : Promise.resolve(autoResult('target-bvid'))
    ) as any)

    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)
    view.rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        transitionToTrack={{ trackKey: 'target-track', coverUrl: '', title: 'Target', artist: 'Artist', duration: 180, id: 'target' }}
      />,
    )

    await waitFor(() => expect(bili.getBilibiliPlayUrl).toHaveBeenCalledWith('target-bvid', 1, 127, expect.any(AbortSignal)))
    resolveCurrent({ status: 'confirm', best: null, candidates: [], fallbackChain: [] })
  })

  it('keeps seek listeners while paused and seeks video without playing it', async () => {
    const audio = new Audio()
    audio.currentTime = 0
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const { container } = render(<BilibiliMvBackground {...baseProps(audio)} />)

    await waitFor(() => expect(bili.getBilibiliPlayUrl).toHaveBeenCalled())
    const video = container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180, currentTime: 0 })
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play)
    playSpy.mockClear()

    audio.currentTime = 42
    fireEvent(audio, new Event('seeked'))

    expect(video.currentTime).toBe(42)
    expect(playSpy).not.toHaveBeenCalled()
  })

  it('renders a confirmed fallback URL in the active visible slot', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'none', best: null, candidates: [], fallbackChain: [] } as any)
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ result: { songs: [{ name: 'Current', artists: [{ name: 'Artist' }], mv: 7 }] } }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: { url: 'http://fallback/mv.mp4' } }) } as Response)

    const { container } = render(<BilibiliMvBackground {...baseProps(audio)} />)
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('http://fallback/mv.mp4'))
    const video = container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180 })
    fireEvent.canPlay(video)
    expect(video.style.opacity).toBe('1')
    expect(video.style.display).not.toBe('none')
  })

  it('uses the authoritative target-content clock for a staged AutoMix MV', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(20_000)
    const audio = new Audio()
    audio.currentTime = 140
    vi.mocked(bili.getBilibiliPlayUrl).mockImplementation(async (bvid: string) => ({ code: 0, cacheKey: `cache-${bvid}` }) as any)
    vi.mocked(bili.findBestBilibiliMv).mockImplementation((ctx: any) => Promise.resolve(
      autoResult(ctx.songTitle === 'Target' ? 'target-bvid' : 'current-bvid'),
    ) as any)
    const { container, rerender } = render(
      <BilibiliMvBackground {...baseProps(audio)} />,
    )
    const videos = [...container.querySelectorAll('video')]
    await waitFor(() => expect(videos.some(video => Boolean(video.getAttribute('src')))).toBe(true))
    const currentVideo = videos.find(video => Boolean(video.getAttribute('src')))!
    setMediaState(currentVideo, { readyState: 4, duration: 180, currentTime: 140 })
    fireEvent.canPlay(currentVideo)
    vi.useFakeTimers()

    rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        isPlaying
        getTransitionTargetTimeSeconds={() => 18}
        transitionProgress={0.8}
        transitionToTrack={{ trackKey: 'target-track', coverUrl: '', title: 'Target', artist: 'Artist', duration: 180, id: 'target' }}
      />,
    )
    await act(async () => {
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })
    const targetVideo = [...container.querySelectorAll('video')].find(video => video !== currentVideo)!
    expect(targetVideo).toBeTruthy()
    expect(targetVideo.getAttribute('src')).toBe('http://stream/cache-target-bvid/video')
    setMediaState(targetVideo, { readyState: 4, duration: 180, currentTime: 0 })
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(targetVideo.currentTime).toBe(18)
  })

  it('uses the authoritative playback clock for periodic sync', async () => {
    vi.useFakeTimers()
    vi.spyOn(performance, 'now').mockReturnValue(20_000)
    const audio = new Audio()
    audio.currentTime = 5
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const { container } = render(
      <BilibiliMvBackground {...baseProps(audio)} isPlaying getPlaybackTimeSeconds={() => 61} />,
    )

    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const video = container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180, currentTime: 0 })
    fireEvent.canPlay(video)
    await act(async () => { vi.advanceTimersByTime(1500) })
    expect(video.currentTime).toBe(61)
  })
})
