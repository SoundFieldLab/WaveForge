/** @vitest-environment jsdom */
/**
 * 传统模式酷狗客户端其余页面冒烟：
 * - 听书页：分类胶囊 + 卡片墙角标（听书VIP / 播放量），点卡片交给 kugouLongaudioStore.openAlbum（复用独立播放器）；
 * - 音乐云盘 / 已购音乐：登录态下的空态（上游无数据时如实说明，不造假）。
 * 数据全部 mock，不触网。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KugouLongaudioAlbum } from '../src/services/kugouService'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

// vi.mock 工厂会被提升到文件顶部，工厂里引用到的对象必须用 vi.hoisted 一起提升
const { album, openAlbum, setBrowseTag, ensureBrowseLoaded } = vi.hoisted(() => ({
  album: {
    albumId: 'A1',
    name: '玄界之门',
    author: '样例主播',
    authors: ['样例主播'],
    coverUrl: 'https://example.test/1.jpg',
    intro: '玄幻爽文',
    playCount: 67594990,
    chapterCount: 3,
    isPaid: true,
    primaryTag: '玄幻异界',
    tags: ['玄幻异界'],
  } satisfies KugouLongaudioAlbum,
  openAlbum: vi.fn(async () => {}),
  setBrowseTag: vi.fn(),
  ensureBrowseLoaded: vi.fn(async () => {}),
}))

vi.mock('../src/features/kugouLongaudio/store', () => {
  const state = {
    view: 'closed' as const,
    browse: { albums: [album], page: 1, hasMore: false, loading: false, error: '', tag: null },
    player: { album: null, chapters: [], currentIndex: -1, status: 'idle' },
    recent: [],
    activeAlbum: null,
  }
  return {
    kugouLongaudioStore: {
      subscribe: () => () => {},
      getState: () => state,
      ensureBrowseLoaded,
      loadMoreBrowse: vi.fn(async () => {}),
      setBrowseTag,
      openLibrary: vi.fn(),
      enter: vi.fn(),
      openAlbum,
    },
    selectBrowseTags: (s: typeof state) => {
      const counts = new Map<string, number>()
      for (const item of s.browse.albums) {
        if (item.primaryTag) counts.set(item.primaryTag, (counts.get(item.primaryTag) || 0) + 1)
      }
      return [...counts.entries()].map(([name, count]) => ({ name, count }))
    },
    // 未选标签时返回全量（页面的「全部」胶囊）
    selectVisibleBrowseAlbums: (s: typeof state) => (s.browse.tag ? s.browse.albums.filter(item => item.tags.includes(s.browse.tag!)) : s.browse.albums),
  }
})

vi.mock('../src/services/kugouService', () => ({
  hasKugouConceptCredential: () => true,
  fetchKugouUserCloud: vi.fn(async () => ({ songs: [], empty: true, total: 0 })),
  fetchKugouPurchasedSongs: vi.fn(async () => ({ songs: [], total: 0 })),
  fetchKugouPurchasedAlbums: vi.fn(async () => ({ albums: [], total: 0 })),
  kugouTrackToSong: vi.fn(() => ({ id: 1, name: 'x', artists: [], album: { name: '' }, duration: 0, platform: 'kugou' })),
}))

import KugouPcLongaudio from '../src/features/traditionalPc/KugouPcLongaudio'
import { KugouPcPurchased } from '../src/features/traditionalPc/KugouPcPersonal'
import { pcTheme } from '../src/features/traditionalPc/pcKit'
import type { KugouPcPageContext } from '../src/features/traditionalPc/KugouPcShared'

const ctx = {
  theme: pcTheme('light'),
  accent: '#ff7a00',
  account: { loggedIn: true, username: '安小达', userId: '777' },
  actions: { onPlaySongs: vi.fn(), onSongMenu: vi.fn(), onOpenPlaylist: vi.fn(), onNavigate: vi.fn() },
  active: true,
  openPlaylist: vi.fn(),
  openArtist: vi.fn(),
  openAlbum: vi.fn(),
} as unknown as KugouPcPageContext

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => cleanup())

describe('KugouPcLongaudio 听书页', () => {
  it('渲染分类胶囊与卡片墙（听书VIP/播放量角标），点卡片走独立听书 store', () => {
    render(<KugouPcLongaudio ctx={ctx} />)

    expect(screen.getByText('听书')).toBeTruthy()
    expect(screen.getByText('玄界之门')).toBeTruthy()
    expect(screen.getByText('听书VIP')).toBeTruthy()
    expect(screen.getByText('6759万')).toBeTruthy()
    expect(screen.getByRole('button', { name: '全部' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '玄幻异界' })).toBeTruthy()

    fireEvent.click(screen.getByText('玄界之门'))
    expect(openAlbum).toHaveBeenCalledWith('A1', expect.objectContaining({ summary: album }))
  })
})

describe('KugouPcPersonal 已购（云盘页已下线）', () => {
  it('已购音乐为空时双空态', async () => {
    render(<KugouPcPurchased ctx={ctx} />)
    expect(await screen.findByText('已购单曲')).toBeTruthy()
    expect(screen.getByText('暂无已购单曲')).toBeTruthy()
    expect(screen.getByText('暂无已购专辑')).toBeTruthy()
  })
})
