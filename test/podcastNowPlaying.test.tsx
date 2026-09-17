/** @vitest-environment jsdom */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PodcastNowPlayingPage from '../src/components/PodcastNowPlayingPage'
import type { Song } from '../src/services/musicApi'

/**
 * 播客单集：独立播放页。
 * 背景——此前播客被归一到「纯音乐」分支，封面取不到时只剩 No Cover 黑板；
 * 现在播客有自己的页面：方形封面 + 单集标题 + 所属播客名 + 播放/音效/设置/音量。
 */
const podcastSong: Song = {
  id: 2654210758,
  name: '第 12 期：与过去和解',
  artists: [{ name: '深夜电台' }],
  album: { name: '女子无才便留德', picUrl: 'https://example.com/podcast.jpg' },
  duration: 1800000,
  platform: 'netease',
  isPodcast: true,
}

const renderPage = (overrides: Partial<Parameters<typeof PodcastNowPlayingPage>[0]> = {}) => render(
  <PodcastNowPlayingPage
    song={podcastSong}
    isPlaying
    currentTime={30}
    duration={1800}
    volume={0.7}
    playerTheme="dark"
    onBack={vi.fn()}
    onPlayPause={vi.fn()}
    onSeek={vi.fn()}
    onVolumeChange={vi.fn()}
    {...overrides}
  />,
)

describe('PodcastNowPlayingPage', () => {
  afterEach(() => cleanup())

  it('显示单集标题与所属播客名，且用真实封面（不是 No Cover）', () => {
    const view = renderPage()
    expect(view.getByText('第 12 期：与过去和解')).toBeTruthy()
    // 所属播客名：album.name（服务端把节目放队列时写入）
    expect(view.getByText('女子无才便留德')).toBeTruthy()
    expect(view.queryByText('No Cover')).toBeNull()
    const img = view.container.querySelector('img[alt="第 12 期：与过去和解"]')
    expect(img).toBeTruthy()
  })

  it('是独立的播客播放页（标记 + 单集节目标签）', () => {
    const view = renderPage()
    expect(view.container.querySelector('[data-podcast-player]')).toBeTruthy()
    expect(view.getByText('单集节目')).toBeTruthy()
  })

  it('不渲染上一曲/下一曲（播客单集没有相邻曲目语义）', () => {
    const view = renderPage()
    for (const label of ['上一首', '下一首', '上一曲', '下一曲']) {
      expect(view.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('音效按钮排在音量左侧且可触发', () => {
    const onOpenSoundEffects = vi.fn()
    const view = renderPage({ onOpenSoundEffects })
    fireEvent.click(view.getByRole('button', { name: '音效' }))
    expect(onOpenSoundEffects).toHaveBeenCalledTimes(1)
    expect(view.getByRole('button', { name: '音量' })).toBeTruthy()
  })

  it('进度条可拖动跳转', () => {
    const onSeek = vi.fn()
    const view = renderPage({ onSeek })
    const slider = view.getByRole('slider', { name: '节目进度' })
    expect(slider).toBeTruthy()
    fireEvent.keyDown(slider, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenCalled()
  })
})
