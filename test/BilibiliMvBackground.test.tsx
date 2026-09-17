/** @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BilibiliMvBackground from '../src/components/BilibiliMvBackground'
import * as bili from '../src/services/bilibiliApi'
import * as alignment from '../src/services/mvAlignment'

let mockWatchSettings = { targetQuality: 'auto', showLowConfidenceCandidates: false }

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
  getBilibiliWatchSettings: vi.fn(() => mockWatchSettings),
  WATCH_SETTINGS_EVENT: 'bilibili-settings-changed',
  resolveBiliPic: vi.fn((url: string) => url),
  formatBiliTime: vi.fn(() => '3:00'),
}))

vi.mock('../src/services/mvAlignment', () => ({
  ensureMvAlignment: vi.fn(() => Promise.resolve()),
  getMvAlignment: vi.fn(() => null),
  getMvAlignmentFor: vi.fn(() => null),
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
  mockWatchSettings = { targetQuality: 'auto', showLowConfidenceCandidates: false }
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
  it('keeps a none fallback stable without disabling or restarting MV search', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'none', best: null, candidates: [], fallbackChain: [] } as any)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ result: { songs: [] } }) } as Response)
    const onFallbackChange = vi.fn()
    const view = render(<BilibiliMvBackground {...baseProps(audio)} onFallbackChange={onFallbackChange} />)

    await waitFor(() => expect(onFallbackChange).toHaveBeenLastCalledWith(true))
    const searchesAfterFallback = vi.mocked(bili.findBestBilibiliMv).mock.calls.length

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} onFallbackChange={onFallbackChange} />)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(bili.findBestBilibiliMv).toHaveBeenCalledTimes(searchesAfterFallback)
    expect(onFallbackChange).not.toHaveBeenLastCalledWith(false)
  })

  it.each([
    ['netease', 'http://audio/song'],
    ['apple', 'blob:http://127.0.0.1/apple-hls'],
  ])('matches and loads MV background for %s tracks', async (platform, audioUrl) => {
    const audio = new Audio()
    audio.src = audioUrl
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult(`${platform}-bvid`))
    const ensure = vi.mocked(alignment.ensureMvAlignment)
    ensure.mockClear()

    const { container } = render(
      <BilibiliMvBackground
        {...baseProps(audio)}
        platform={platform}
        lyrics={[{ time: 12, text: 'Apple or platform lyric' }]}
      />,
    )

    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    expect(bili.findBestBilibiliMv).toHaveBeenCalledWith(
      expect.objectContaining({ platform }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    await waitFor(() => expect(ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        songUrl: expect.stringContaining(platform === 'apple' ? 'blob:' : 'http://audio/song'),
        lyrics: [expect.objectContaining({ text: 'Apple or platform lyric' })],
        bvid: `${platform}-bvid`,
      }),
      expect.any(AbortSignal),
    ))
  })

  it('keeps the cover fallback until the MV has a playable frame', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('ready-bvid'))
    const onReadyChange = vi.fn()

    const { container, unmount } = render(
      <BilibiliMvBackground {...baseProps(audio)} onReadyChange={onReadyChange} />,
    )

    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    expect(onReadyChange).toHaveBeenLastCalledWith(false)

    fireEvent.canPlay(container.querySelector('video')!)
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true))

    unmount()
    expect(onReadyChange).toHaveBeenLastCalledWith(false)
  })

  it('prewarms alignment only for the immediate upcoming track across platforms', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockImplementation((ctx: any) => Promise.resolve(autoResult(`${ctx.platform}-bvid`)) as any)
    const prewarm = vi.mocked(alignment.prewarmMvBeatAnalysis)
    prewarm.mockClear()

    render(
      <BilibiliMvBackground
        {...baseProps(audio)}
        upcomingSongs={[
          { songTitle: 'Apple Next', songArtists: ['Artist'], songDuration: 180, platform: 'apple', id: 'apple-next' },
          { songTitle: 'QQ Later', songArtists: ['Artist'], songDuration: 180, platform: 'qq', id: 'qq-later' },
        ]}
      />,
    )

    await waitFor(() => expect(bili.findBestBilibiliMv).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'apple', id: 'apple-next' }),
      expect.anything(),
    ))
    await waitFor(() => expect(bili.findBestBilibiliMv).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'qq', id: 'qq-later' }),
      expect.anything(),
    ))
    await waitFor(() => expect(prewarm).toHaveBeenCalledTimes(1))
    expect(prewarm).toHaveBeenCalledWith(expect.objectContaining({
      bvid: 'apple-bvid',
      videoUrl: 'http://stream/cache/audio',
    }))
  })

  it('starts alignment once from the playing status effect', async () => {
    const audio = new Audio()
    audio.src = 'http://audio/song'
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const ensure = vi.mocked(alignment.ensureMvAlignment)
    ensure.mockClear()

    render(<BilibiliMvBackground {...baseProps(audio)} />)

    await waitFor(() => expect(ensure).toHaveBeenCalledTimes(1))
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ bvid: 'current-bvid', cid: 1 }), expect.any(AbortSignal))
  })

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

    await waitFor(() => expect(bili.getBilibiliPlayUrl).toHaveBeenCalledWith('target-bvid', 1, 112, expect.any(AbortSignal)))
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

  it('promotes a committed staged MV after the transition preload ref moves on', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockImplementation((ctx: any) => Promise.resolve(
      autoResult(ctx.songTitle === 'Target' ? 'target-bvid' : 'current-bvid'),
    ) as any)
    vi.mocked(bili.getBilibiliPlayUrl).mockImplementation(async (bvid: string) => ({ code: 0, cacheKey: `cache-${bvid}` }) as any)

    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache-current-bvid/video'))
    const currentVideo = view.container.querySelector('video')!
    setMediaState(currentVideo, { readyState: 4, duration: 180 })
    fireEvent.canPlay(currentVideo)

    view.rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        isPlaying
        transitionProgress={1}
        transitionToTrack={{ trackKey: 'target-track', coverUrl: '', title: 'Target', artist: 'Artist', duration: 180, id: 'target' }}
      />,
    )
    const targetVideo = await waitFor(() => {
      const videos = [...view.container.querySelectorAll('video')]
      const video = videos.find(item => item.getAttribute('src') === 'http://stream/cache-target-bvid/video')
      expect(video).toBeTruthy()
      return video!
    })
    setMediaState(targetVideo, { readyState: 1, duration: 180 })

    view.rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        songTitle="Target"
        songId="target"
        songTrackKey="target-track"
        isPlaying
        transitionToTrack={null}
      />,
    )
    view.rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        songTitle="Target"
        songId="target"
        songTrackKey="target-track"
        isPlaying
        transitionToTrack={{ trackKey: 'later-track', coverUrl: '', title: 'Later', artist: 'Artist', duration: 180, id: 'later' }}
      />,
    )
    view.rerender(
      <BilibiliMvBackground
        {...baseProps(audio)}
        songTitle="Target"
        songId="target"
        songTrackKey="target-track"
        isPlaying
        transitionToTrack={null}
      />,
    )

    setMediaState(targetVideo, { readyState: 4 })
    fireEvent.canPlay(targetVideo)
    await waitFor(() => expect(targetVideo.style.opacity).toBe('1'))
  })

  it('releases both media slots and aborts in-flight work when disabled', async () => {
    const audio = new Audio()
    let searchSignal: AbortSignal | undefined
    vi.mocked(bili.findBestBilibiliMv).mockImplementation((_ctx: any, options: any) => {
      searchSignal = options?.signal
      return new Promise(() => undefined) as any
    })
    const onPlayStateChange = vi.fn()
    const view = render(<BilibiliMvBackground {...baseProps(audio)} isPlaying onPlayStateChange={onPlayStateChange} />)

    await waitFor(() => expect(searchSignal).toBeDefined())
    const videos = [...view.container.querySelectorAll('video')]
    videos[0].setAttribute('src', 'http://stream/a')
    videos[1].setAttribute('src', 'http://stream/b')
    const pauseSpy = vi.mocked(HTMLMediaElement.prototype.pause)
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load)
    pauseSpy.mockClear()
    loadSpy.mockClear()

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} enabled={false} onPlayStateChange={onPlayStateChange} />)

    await waitFor(() => expect(searchSignal?.aborted).toBe(true))
    expect(pauseSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(loadSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(videos.every((video) => !video.hasAttribute('src'))).toBe(true)
    expect(onPlayStateChange).toHaveBeenLastCalledWith(null)
  })

  it('keeps buffered media while hidden is only a temporary cover', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    const video = view.container.querySelector('video')!
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load)
    loadSpy.mockClear()

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} hidden />)

    expect(video.getAttribute('src')).toBe('http://stream/cache/video')
    expect(loadSpy).not.toHaveBeenCalled()
  })

  // 首页/其它表面盖住 MV 时复用同一个 hidden 通道（不另造机制），因此这里锁死两点：
  //   ① 遮挡期间不重新拉流、不丢缓冲（否则切回来会重新搜索 + 黑屏等待）；
  //   ② 取消遮挡后按音频时钟硬同步（"实时对准"），而不是从隐藏前的位置继续播。
  it('keeps the buffered MV while covered by another surface and re-syncs to the audio clock on return', async () => {
    const audio = new Audio()
    Object.defineProperty(audio, 'currentTime', { configurable: true, value: 42, writable: true })
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const view = render(<BilibiliMvBackground {...baseProps(audio)} isPlaying />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    const video = view.container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180, currentTime: 5 })
    const loadSpy = vi.mocked(HTMLMediaElement.prototype.load)
    loadSpy.mockClear()

    // 被首页盖住：与看歌同样的语义——只是临时遮挡
    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying hidden />)
    expect(video.getAttribute('src')).toBe('http://stream/cache/video')
    expect(loadSpy).not.toHaveBeenCalled()

    // 取消遮挡：硬同步到音频位置（42s % 180s = 42s），而不是接着 5s 播
    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying hidden={false} />)
    await waitFor(() => expect(video.currentTime).toBe(42))
    expect(video.getAttribute('src')).toBe('http://stream/cache/video')
  })

  it('resumes a buffered MV when returning from watch mode while audio is playing', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const view = render(<BilibiliMvBackground {...baseProps(audio)} isPlaying />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    const video = view.container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180, currentTime: 12 })
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play)
    playSpy.mockClear()

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying hidden />)
    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying={true} hidden={false} />)

    await waitFor(() => expect(playSpy).toHaveBeenCalled())
    expect(video.getAttribute('src')).toBe('http://stream/cache/video')
  })

  it('retries MV playback from canplay after returning from watch mode', async () => {
    const audio = new Audio()
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue(autoResult('current-bvid'))
    const playSpy = vi.mocked(HTMLMediaElement.prototype.play)
    const view = render(<BilibiliMvBackground {...baseProps(audio)} isPlaying />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    const video = view.container.querySelector('video')!
    setMediaState(video, { readyState: 4, duration: 180, currentTime: 12 })
    playSpy.mockClear()
    playSpy.mockRejectedValueOnce(new DOMException('buffering', 'AbortError')).mockResolvedValue(undefined)

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying hidden />)
    view.rerender(<BilibiliMvBackground {...baseProps(audio)} isPlaying hidden={false} />)
    await waitFor(() => expect(playSpy.mock.calls.length).toBeGreaterThan(0))
    const callsBeforeCanPlay = playSpy.mock.calls.length

    fireEvent.canPlay(video)
    await waitFor(() => expect(playSpy.mock.calls.length).toBeGreaterThan(callsBeforeCanPlay))
  })

  it('plays the best low-confidence candidate without showing a picker by default', async () => {
    const audio = new Audio()
    const best = candidate('best-bvid')
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'confirm', best, candidates: [best], fallbackChain: [best] } as any)
    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)

    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))
    expect(document.body.textContent).not.toContain('匹配置信度不足')
  })

  it('shows a portal picker when enabled and removes it on song change', async () => {
    const audio = new Audio()
    mockWatchSettings = { targetQuality: 'auto', showLowConfidenceCandidates: true }
    const best = candidate('best-bvid')
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'confirm', best, candidates: [best], fallbackChain: [best] } as any)
    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)

    await waitFor(() => expect(document.body.textContent).toContain('匹配置信度不足'))
    const picker = document.body.querySelector('.fixed.z-\\[1000\\]')
    expect(picker).not.toBeNull()
    expect(picker?.querySelector('.overflow-y-auto')).not.toBeNull()

    view.rerender(<BilibiliMvBackground {...baseProps(audio)} songTitle="Next" songId="next" songTrackKey="next-track" />)
    await waitFor(() => expect(document.body.textContent).not.toContain('匹配置信度不足'))
  })

  it('removes the body portal immediately when MV background is disabled', async () => {
    const audio = new Audio()
    mockWatchSettings = { targetQuality: 'auto', showLowConfidenceCandidates: true }
    const best = candidate('best-bvid')
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'confirm', best, candidates: [best], fallbackChain: [best] } as any)
    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)

    await waitFor(() => expect(document.body.textContent).toContain('匹配置信度不足'))
    view.rerender(<BilibiliMvBackground {...baseProps(audio)} enabled={false} />)
    expect(document.body.textContent).not.toContain('匹配置信度不足')
  })

  it('advances to the next candidate when the active video element errors', async () => {
    const audio = new Audio()
    const first = candidate('first-bvid')
    const second = candidate('second-bvid')
    vi.mocked(bili.findBestBilibiliMv).mockResolvedValue({ status: 'auto', best: first, candidates: [first, second], fallbackChain: [first, second] } as any)
    const view = render(<BilibiliMvBackground {...baseProps(audio)} />)
    await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('http://stream/cache/video'))

    fireEvent.error(view.container.querySelector('video')!)
    await waitFor(() => expect(bili.getBilibiliPlayUrl.mock.calls.length).toBeGreaterThanOrEqual(2))
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
