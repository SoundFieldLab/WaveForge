/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlaylistDetailPanel from '../src/components/PlaylistDetailPanel'
import type { Song } from '../src/services/musicApi'

// test/neteaseDrillDown.test.tsx
// 二级/三级入口回归：歌单详情里的歌手名与专辑名必须能点开对应页面。
// 旧实现只在右键菜单里提供「查看歌手/查看专辑」，左键点文字没有任何反应。

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
    unobserve() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const song: Song = {
  id: 1,
  name: '测试歌曲',
  artists: [{ id: 22492, name: '女王蜂' }, { id: 510882, name: '合作歌手' }],
  album: { id: 397948166, name: '测试专辑', picUrl: 'https://p1.music.126.net/a.jpg' },
  duration: 200000,
  platform: 'netease',
} as Song

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = {
    show: true,
    playlist: { id: 'pl.1', name: '测试歌单', coverImgUrl: '', trackCount: 1, platform: 'netease' as const },
    songs: [song],
    loading: false,
    onClose: vi.fn(),
    onSongSelect: vi.fn(),
    currentPlatform: 'netease' as const,
    ...overrides,
  }
  render(<PlaylistDetailPanel {...(props as any)} />)
  return props
}

describe('歌单详情的三级入口（左键可点）', () => {
  it('点歌手名打开歌手页，并带上正确的 artistId 与平台', () => {
    const onOpenArtist = vi.fn()
    renderPanel({ onOpenArtist })

    // 两个歌手各自可点
    const first = screen.getByRole('button', { name: '女王蜂' })
    fireEvent.click(first)
    expect(onOpenArtist).toHaveBeenCalledWith('22492', 'netease')

    fireEvent.click(screen.getByRole('button', { name: '合作歌手' }))
    expect(onOpenArtist).toHaveBeenLastCalledWith('510882', 'netease')
  })

  it('点专辑名打开专辑页', () => {
    const onOpenAlbum = vi.fn()
    renderPanel({ onOpenAlbum })

    fireEvent.click(screen.getByRole('button', { name: '测试专辑' }))
    expect(onOpenAlbum).toHaveBeenCalledWith('397948166', 'netease')
  })

  it('点击歌手/专辑不会同时触发播放（stopPropagation）', () => {
    const onOpenArtist = vi.fn()
    const onOpenAlbum = vi.fn()
    const props = renderPanel({ onOpenArtist, onOpenAlbum })

    fireEvent.click(screen.getByRole('button', { name: '女王蜂' }))
    fireEvent.click(screen.getByRole('button', { name: '测试专辑' }))
    expect(props.onSongSelect).not.toHaveBeenCalled()
  })

  it('没有回调解绑时不渲染成按钮，避免出现点了没反应的假入口', () => {
    renderPanel()
    expect(screen.queryByRole('button', { name: '女王蜂' })).toBeNull()
    expect(screen.queryByRole('button', { name: '测试专辑' })).toBeNull()
    // 纯文本仍要显示，不丢信息
    expect(screen.getByText(/女王蜂/)).toBeTruthy()
    expect(screen.getByText('测试专辑')).toBeTruthy()
  })
})
