/** @vitest-environment jsdom */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import DesktopMiniPlayer from '../src/components/DesktopMiniPlayer'
import type { Song } from '../src/services/musicApi'

const radioSong: Song = {
  id: 0,
  name: 'Radio',
  artists: [{ name: 'Apple Music' }],
  album: { name: 'Radio', picUrl: '' },
  duration: 0,
  platform: 'apple',
  appleRadio: { stationId: 'station', storefront: 'cn', timeline: 'live' },
}

describe('DesktopMiniPlayer live semantics', () => {
  it('shows live state without finite progress or queue navigation', () => {
    const { container } = render(
      <DesktopMiniPlayer
        currentSong={radioSong}
        isPlaying
        live
        currentTime={20}
        duration={60}
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        cardBlurAmount={12}
      />,
    )
    expect(screen.getByText('正在直播')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '上一首' })).toBeNull()
    expect(screen.queryByRole('button', { name: '下一首' })).toBeNull()
    expect(container.querySelector('[style*="scaleX"]')).toBeNull()
  })
})

/**
 * 电台/播客（nonSkippable）：没有「相邻曲目」语义 → 隐藏切歌，并把无歌词的
 * 占位换成电台名/播客名（此前桌面迷你播放器在无歌词时整行不渲染）。
 */
describe('DesktopMiniPlayer 电台/播客语义', () => {
  const podcastSong: Song = {
    id: 123,
    name: '第 12 期：与过去和解',
    artists: [{ name: '深夜电台' }],
    album: { name: '硬核播客电台', picUrl: '' },
    duration: 1800,
    platform: 'netease',
    isPodcast: true,
  }

  it('播客单集：隐藏上一曲/下一曲，无歌词时显示播客名', () => {
    const { container } = render(
      <DesktopMiniPlayer
        currentSong={podcastSong}
        isPlaying
        currentTime={10}
        duration={1800}
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        cardBlurAmount={12}
        hideSkipControls
        lyricsPlaceholder="硬核播客电台"
      />,
    )
    // 用 container 限定范围：同文件多个 render 共存时全局查询会命中多个同名按钮
    expect(within(container).queryByRole('button', { name: '上一首' })).toBeNull()
    expect(within(container).queryByRole('button', { name: '下一首' })).toBeNull()
    expect(within(container).getByText('硬核播客电台')).toBeTruthy()
    // 播放/暂停必须保留
    expect(within(container).getByRole('button', { name: '暂停' })).toBeTruthy()
  })

  it('普通歌曲不受影响：保留切歌且不显示占位文案', () => {
    const normalSong: Song = {
      id: 9, name: '普通歌曲', artists: [{ name: '歌手' }],
      album: { name: '专辑', picUrl: '' }, duration: 200, platform: 'netease',
    }
    render(
      <DesktopMiniPlayer
        currentSong={normalSong}
        isPlaying
        currentTime={10}
        duration={200}
        onPlayPause={vi.fn()}
        onNext={vi.fn()}
        onPrevious={vi.fn()}
        cardBlurAmount={12}
        lyricsPlaceholder=""
      />,
    )
    expect(screen.getByRole('button', { name: '上一首' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '下一首' })).toBeTruthy()
  })
})
