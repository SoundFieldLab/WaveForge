/** @vitest-environment jsdom */
/**
 * 探索页-酷狗一级分区（音乐 / 听书）jsdom 冒烟：
 * 1) 默认落在「音乐」分区；页签按酷狗品牌色渲染（激活项品牌色胶囊）；
 * 2) 点「听书」切区：只有激活分区的面板可见，其余面板隐藏（aria-hidden + display:none）；
 * 3) 设置里隐藏板块能连带收起分区：听书分区整体消失，音乐子板块全隐藏时自动回落到听书；
 * 4) 平台隔离：板块显隐判定里没有酷狗板块时（其它平台能力表 / 未登录兜底）整页不渲染任何内容，
 *    也不会渲染通用「推荐歌单 / 排行榜 / 最新音乐 / 新碟」板块。
 * 「刷歌」分区已按产品决策下线（上游动态流恒空），不再出现在页签里。
 * 数据来自 mock 的 kugouService，避免触网。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

vi.mock('../src/services/kugouService', () => ({
  hasKugouConceptCredential: () => true,
  // 听书：空推荐池（板块自己渲染空态/错误态），其余接口本测试用不到
  fetchKugouLongaudioDaily: vi.fn(async () => ({ albums: [], hasMore: false })),
  fetchKugouLongaudioAlbumDetail: vi.fn(async () => ({ album: null })),
  fetchKugouLongaudioChapters: vi.fn(async () => ({ chapters: [], hasMore: false })),
  getKugouLongaudioUrl: vi.fn(async () => ({ url: '' })),
}))

import KugouExplorePage from '../src/features/kugouExplore/KugouExplorePage'
import type { ExplorePayload } from '../src/services/exploreApi'
import type { Song } from '../src/services/musicApi'

const makeSong = (name: string, mid: string): Song => ({
  id: Number(mid.slice(0, 4)) || 1,
  mid,
  name,
  artists: [{ name: '样例歌手' }],
  album: { name: '样例专辑', picUrl: 'https://example.test/cover.jpg' },
  duration: 200_000,
  platform: 'kugou',
})

const payload: ExplorePayload = {
  code: 0,
  platform: 'kugou',
  officialEnhanced: false,
  personalized: true,
  dailySongs: [makeSong('每日推荐样例', 'AAAA1111')],
  radioSongs: [],
  newSongs: [makeSong('榜单新歌', 'BBBB1111')],
  playlists: [],
  charts: [],
  albums: [],
  channels: [],
  kugou: {
    dailySongs: [makeSong('每日推荐样例', 'AAAA1111')],
    dailyDate: '20261007',
    newSongs: [{ song: makeSong('我们在场', 'CCCC1111') }],
    channels: [],
    tagGroups: [{ id: '8', name: '风格', tags: [{ id: '9', name: '流行' }] }],
    tagPlaylists: [],
    tagPlaylistsHasNext: false,
    yueku: { newAlbums: [], ranks: [], recommendPlaylists: [] },
    singers: [],
  },
  meta: { source: 'kugou-mobile-api', updatedAt: 0 },
}

const handlers = {
  onPlaySongs: vi.fn(),
  onSongSelect: vi.fn(),
  onOpenPlaylist: vi.fn(),
  onOpenAlbum: vi.fn(),
  onOpenArtist: vi.fn(),
  onSongContextMenu: vi.fn(),
  onOpenMoreSection: vi.fn(),
  onOpenSearch: vi.fn(),
  onRetry: vi.fn(),
}

const baseProps = {
  ...handlers,
  payload,
  accent: '#FF7A00',
  accentRgb: '255, 122, 0',
  compactCards: false,
  showDescriptions: true,
  expandedHome: false,
  exploreCardBg: 'rgba(255,255,255,0.05)',
  showSubtitles: true,
  sectionStyle: () => ({}),
}

/** 模拟 kugou 能力表：只有酷狗板块（含通用 discover/channels 别名）可见 */
const kugouVisible = (section: string) =>
  ['discover', 'kugouLibrary', 'kugouPlaylistTags', 'channels', 'kugouCategories', 'kugouLongaudio'].includes(section)

const paneOf = (zone: string) => document.querySelector(`[data-kugou-zone="${zone}"]`) as HTMLElement

afterEach(() => {
  cleanup()
})

describe('酷狗探索页一级分区（音乐 / 听书）', () => {
  it('默认落在音乐分区：页签齐全（无刷歌），激活项用酷狗品牌色，音乐五板块可见', async () => {
    render(<KugouExplorePage {...baseProps} sectionVisible={kugouVisible} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map(tab => tab.textContent)).toEqual(['音乐', '听书'])
    const active = screen.getByRole('tab', { name: '音乐' })
    expect(active.getAttribute('aria-selected')).toBe('true')
    // 品牌色胶囊：accent（#FF7A00）直接写进激活项样式（jsdom 会归一化成 rgb）
    const activeStyle = active.getAttribute('style') || ''
    expect(activeStyle.includes('FF7A00') || activeStyle.includes('rgb(255, 122, 0)')).toBe(true)
    expect(paneOf('music').className).not.toContain('hidden')
    expect(paneOf('longaudio').className).toContain('hidden')
    // 「刷歌」分区已下线：DOM 里不存在
    expect(paneOf('youth')).toBeNull()
    // 音乐分区：推荐 + 乐库 + 歌单 + 频道 + 分类五板块都在
    for (const board of ['discover', 'library', 'playlist-tags', 'channels', 'categories']) {
      expect(document.querySelector(`[data-kugou-board="${board}"]`)).toBeTruthy()
    }
  })

  it('点「听书」切区：听书面板可见、音乐面板隐藏，听书板块挂载', async () => {
    render(<KugouExplorePage {...baseProps} sectionVisible={kugouVisible} />)
    fireEvent.click(screen.getByRole('tab', { name: '听书' }))
    expect(screen.getByRole('tab', { name: '听书' }).getAttribute('aria-selected')).toBe('true')
    expect(paneOf('longaudio').className).not.toContain('hidden')
    expect(paneOf('music').className).toContain('hidden')
    expect(screen.getByText('进入听书')).toBeTruthy()
  })

  it('设置里隐藏听书板块：分区页签消失，音乐分区保留', () => {
    const hidden = new Set(['kugouLongaudio'])
    render(<KugouExplorePage {...baseProps} sectionVisible={section => kugouVisible(section) && !hidden.has(section)} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['音乐'])
    expect(screen.queryByText('进入听书')).toBeNull()
  })

  it('音乐子板块全部隐藏时：整块音乐面板收起，自动回落到听书分区而不是空白', () => {
    const hidden = new Set(['discover', 'kugouLibrary', 'kugouPlaylistTags', 'channels', 'kugouCategories'])
    render(<KugouExplorePage {...baseProps} sectionVisible={section => kugouVisible(section) && !hidden.has(section)} />)
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['听书'])
    expect(paneOf('music').className).toContain('hidden')
    expect(paneOf('longaudio').className).not.toContain('hidden')
  })

  it('平台隔离：没有酷狗板块能力时（其它平台的区块列表）整页不渲染，也不出现通用聚合板块', () => {
    // 其它平台能力表里只有 playlists/charts/newSongs/albums 这类通用区块
    render(<KugouExplorePage {...baseProps} sectionVisible={section => ['playlists', 'charts', 'newSongs', 'albums'].includes(section)} />)
    expect(screen.queryAllByRole('tab')).toHaveLength(0)
    for (const zone of ['music', 'longaudio']) {
      expect(paneOf(zone).className).toContain('hidden')
    }
    // 通用聚合板块（推荐歌单/排行榜速览/最新音乐/新碟上架）不属于酷狗页
    expect(screen.queryByText('推荐歌单')).toBeNull()
    expect(screen.queryByText('排行榜速览')).toBeNull()
  })
})
