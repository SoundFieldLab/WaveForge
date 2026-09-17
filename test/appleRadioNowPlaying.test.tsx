/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppleRadioNowPlayingPage from '../src/components/AppleRadioNowPlayingPage'
import type { Song } from '../src/services/musicApi'

const radioSong = (timeline: 'live' | 'vod' | 'unknown' = 'live'): Song => ({
  id: 0,
  appleId: 'ra.1',
  name: '测试电台',
  artists: [{ name: 'Apple Music 电台' }],
  album: { name: '测试节目', picUrl: 'https://example.com/station.jpg' },
  duration: timeline === 'vod' ? 120000 : 0,
  platform: 'apple',
  appleRadio: {
    stationId: 'ra.1',
    storefront: 'cn',
    timeline,
    showName: '测试节目',
    description: '节目描述',
    artworkUrl: 'https://example.com/station.jpg',
  },
})

const renderPage = (timeline: 'live' | 'vod' | 'unknown' = 'live') => render(
  <AppleRadioNowPlayingPage
    song={radioSong(timeline)}
    isPlaying
    currentTime={12}
    duration={120}
    volume={0.7}
    playerTheme="dark"
    onBack={vi.fn()}
    onPlayPause={vi.fn()}
    onSeek={vi.fn()}
    onVolumeChange={vi.fn()}
    onRetry={vi.fn()}
  />,
)

describe('AppleRadioNowPlayingPage', () => {
  afterEach(() => cleanup())

  it('renders a live progress bar on the dedicated live surface', () => {
    renderPage('live')
    expect(screen.getByText('Apple Music 广播')).toBeTruthy()
    expect(screen.getByText('直播')).toBeTruthy()
    expect(screen.getByRole('slider', { name: '直播进度' })).toBeTruthy()
    expect(screen.queryByText('歌词')).toBeNull()
  })

  it('reveals the volume slider only after expanding', () => {
    const onVolumeChange = vi.fn()
    const view = render(
      <AppleRadioNowPlayingPage
        song={radioSong()}
        isPlaying
        currentTime={12}
        duration={120}
        volume={0.7}
        playerTheme="dark"
        onBack={vi.fn()}
        onPlayPause={vi.fn()}
        onSeek={vi.fn()}
        onVolumeChange={onVolumeChange}
        onRetry={vi.fn()}
      />,
    )
    expect(view.queryByRole('slider', { name: '电台音量' })).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '电台音量' }))
    const slider = view.getByRole('slider', { name: '电台音量' })
    fireEvent.change(slider, { target: { value: '0.4' } })
    expect(onVolumeChange).toHaveBeenCalledWith(0.4)
  })

  it('allows seeking for on-demand episodes', () => {
    const onSeek = vi.fn()
    render(
      <AppleRadioNowPlayingPage
        song={radioSong('vod')}
        isPlaying={false}
        currentTime={12}
        duration={120}
        volume={0.7}
        playerTheme="light"
        onBack={vi.fn()}
        onPlayPause={vi.fn()}
        onSeek={onSeek}
        onVolumeChange={vi.fn()}
        onRetry={vi.fn()}
      />,
    )
    const bar = screen.getByRole('slider', { name: '节目进度' })
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, right: 120, bottom: 10, width: 120, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    fireEvent.pointerDown(bar, { clientX: 33, pointerId: 1, buttons: 1 })
    expect(onSeek).toHaveBeenCalledWith(33)
    expect(screen.getByText('节目回放')).toBeTruthy()
  })

  it('disables playback while connecting and reconnecting', () => {
    const props = {
      song: radioSong(),
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      volume: 0.7,
      playerTheme: 'dark' as const,
      onBack: vi.fn(),
      onPlayPause: vi.fn(),
      onSeek: vi.fn(),
      onVolumeChange: vi.fn(),
      onRetry: vi.fn(),
    }
    const view = render(<AppleRadioNowPlayingPage {...props} status="connecting" />)
    expect(view.getByText('正在连接')).toBeTruthy()
    expect((view.container.querySelector('button[aria-label="播放电台"]') as HTMLButtonElement).disabled).toBe(true)

    view.rerender(<AppleRadioNowPlayingPage {...props} status="reconnecting" />)
    expect(view.getByText('正在重新连接')).toBeTruthy()
    expect((view.container.querySelector('button[aria-label="播放电台"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows a retry action for stream errors', () => {
    const onRetry = vi.fn()
    render(
      <AppleRadioNowPlayingPage
        song={radioSong()}
        isPlaying={false}
        currentTime={0}
        duration={0}
        volume={0.7}
        playerTheme="dark"
        status="error"
        error="授权失败"
        onBack={vi.fn()}
        onPlayPause={vi.fn()}
        onSeek={vi.fn()}
        onVolumeChange={vi.fn()}
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '重新连接' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(screen.getByText('授权失败')).toBeTruthy()
  })
})

/**
 * 电台页是独立设计：自带返回、音效、设置（音量左侧），
 * 且不再叠加歌词页的悬浮控件（主页/翻译/罗马音/MV 背景）。
 */
describe('AppleRadioNowPlayingPage 独立控件', () => {
  afterEach(() => cleanup())

  it('把「音效」放在播放键与音量之间，且可触发', () => {
    const onOpenSoundEffects = vi.fn()
    const view = render(
      <AppleRadioNowPlayingPage
        song={radioSong()}
        isPlaying
        currentTime={12}
        duration={120}
        volume={0.7}
        playerTheme="dark"
        onBack={vi.fn()}
        onPlayPause={vi.fn()}
        onSeek={vi.fn()}
        onVolumeChange={vi.fn()}
        onRetry={vi.fn()}
        onOpenSoundEffects={onOpenSoundEffects}
      />,
    )
    const soundBtn = view.getByRole('button', { name: '音效' })
    expect(soundBtn).toBeTruthy()
    fireEvent.click(soundBtn)
    expect(onOpenSoundEffects).toHaveBeenCalledTimes(1)
    // 音量键仍在（音效/设置排在其左）
    expect(view.getByRole('button', { name: '电台音量' })).toBeTruthy()
  })

  it('不渲染歌词页专属控件（主页/翻译/罗马音/MV 背景）', () => {
    const view = renderPage('live')
    for (const label of ['MV 背景', '打开调音室']) {
      expect(view.queryByRole('button', { name: label })).toBeNull()
    }
  })
})
