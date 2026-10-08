/** @vitest-environment jsdom */
/**
 * 简约模式-酷狗专属区块冒烟（平台隔离）：
 * 1) 右栏「酷狗专区」入口：我喜欢 / 收藏歌单 打开个人中心对应页签，「我的听书」走 kugouLongaudio 的独立 store；
 * 2) 个人中心浮层：最近播放 / 我喜欢 / 收藏歌单 均来自概念版通道；收藏歌单只列他人歌单（自建不混入），
 *    播放全部与打开歌单分别回给宿主回调。
 * 数据全部 mock，不触网。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KugouMinimalTab } from '../src/features/kugouMinimal/KugouMinimalCenter'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

// 听书板块与独立播放器已在 KugouLongaudioUi.test.tsx 单测；这里只验证入口接到同一 store
const { openLibrary, enter, exit } = vi.hoisted(() => ({
  openLibrary: vi.fn(),
  enter: vi.fn(),
  exit: vi.fn(),
}))

vi.mock('../src/features/kugouLongaudio/store', () => ({
  kugouLongaudioStore: {
    subscribe: () => () => {},
    getState: () => ({ view: 'closed', browse: { albums: [], page: 0, hasMore: false, loading: false, error: '', tag: null }, player: { album: null, chapters: [], currentIndex: -1, status: 'idle' }, recent: [], activeAlbum: null }),
    openLibrary,
    enter,
    exit,
  },
}))

vi.mock('../src/features/kugouLongaudio/KugouLongaudioBoard', () => ({
  default: () => <div data-testid="kugou-longaudio-board">听书板块</div>,
}))

vi.mock('../src/features/kugouLongaudio/KugouLongaudioOverlay', () => ({
  default: () => null,
}))

const { playlists, records } = vi.hoisted(() => ({
  playlists: [
    { specialid: 'collection_3_777_2_0', listid: '2', name: '我喜欢', coverUrl: 'https://example.test/liked.jpg', songcount: 1, isMine: true },
    { specialid: 'collection_3_777_5_0', listid: '5', name: '我的自建歌单', coverUrl: '', songcount: 3, isMine: true },
    { specialid: 'collection_3_888_9_0', listid: '9', name: '别人的歌单', coverUrl: 'https://example.test/other.jpg', songcount: 8, playcount: 12000, isMine: false },
  ],
  records: [
    { mxid: 11, ot: 1700000000, pc: 3, track: { hash: 'HASH-RECENT', songName: '最近播放的歌', singerName: '歌手A', albumAudioId: 11, coverUrl: 'https://example.test/r.jpg' } },
  ],
}))

vi.mock('../src/services/kugouService', () => ({
  getKugouConceptCredential: () => null,
  hasKugouConceptCredential: vi.fn(() => true),
  fetchKugouUserPlaylists: vi.fn(async () => playlists),
  fetchKugouPlayRecords: vi.fn(async () => ({ records, hasMore: false, bp: '' })),
  fetchKugouUserPlaylistTracks: vi.fn(async () => [
    { hash: 'HASH-LIKED', songName: '喜欢的歌', singerName: '歌手B', albumAudioId: 21, coverUrl: 'https://example.test/l.jpg' },
  ]),
  // 云盘/已购面板（KugouPcPersonal 复用到个人中心浮层）的数据入口：空态即可，面板只要求函数存在
  fetchKugouUserCloud: vi.fn(async () => ({ songs: [], empty: true, total: 0 })),
  fetchKugouPurchasedSongs: vi.fn(async () => ({ songs: [], total: 0 })),
  fetchKugouPurchasedAlbums: vi.fn(async () => ({ albums: [], total: 0 })),
  kugouTrackToSong: (track: { hash: string; songName: string; singerName?: string; duration?: number; coverUrl?: string }) => ({
    id: 1,
    mid: track.hash,
    name: track.songName,
    artists: [{ name: track.singerName || '' }],
    album: { name: '', picUrl: track.coverUrl || '' },
    duration: (track.duration || 180) * 1000,
    platform: 'kugou',
  }),
}))

import KugouMinimalSuite from '../src/features/kugouMinimal/KugouMinimalSuite'
import KugouMinimalCenter from '../src/features/kugouMinimal/KugouMinimalCenter'

const suiteProps = {
  loggedIn: true,
  username: '安小达',
  avatar: '',
  userId: '777',
  theme: 'dark' as const,
  openTab: null,
  onOpenTab: vi.fn(),
  onPlaySongs: vi.fn(),
}

const centerProps = {
  open: true,
  tab: 'recent' as KugouMinimalTab,
  onTabChange: vi.fn(),
  onClose: vi.fn(),
  loggedIn: true,
  username: '安小达',
  userId: '777',
  onPlaySongs: vi.fn(),
  onOpenPlaylist: vi.fn(),
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => cleanup())

describe('简约模式酷狗专区入口', () => {
  it('渲染五个入口（云盘已下线）；「我喜欢」打开个人中心页签，「我的听书」走独立听书 store', async () => {
    render(<KugouMinimalSuite {...suiteProps} />)

    expect(screen.getByText('酷狗专区')).toBeTruthy()
    for (const label of ['听书', '我的听书', '我喜欢', '收藏歌单', '已购']) {
    // 云盘已随下载功能下线：入口不存在
    expect(screen.queryByText('云盘')).toBeNull()
      expect(screen.getByText(label)).toBeTruthy()
    }

    fireEvent.click(screen.getByText('我喜欢'))
    expect(suiteProps.onOpenTab).toHaveBeenCalledWith('liked')

    fireEvent.click(screen.getByText('收藏歌单'))
    expect(suiteProps.onOpenTab).toHaveBeenCalledWith('playlists')

    fireEvent.click(screen.getByText('已购'))
    expect(suiteProps.onOpenTab).toHaveBeenCalledWith('purchased')

    fireEvent.click(screen.getByText('我的听书'))
    await waitFor(() => expect(openLibrary).toHaveBeenCalled())
  })

  it('openTab 非空时挂载个人中心浮层（lazy + Suspense 链路），页签交给浮层', async () => {
    render(<KugouMinimalSuite {...suiteProps} openTab="recent" />)
    expect(await screen.findByText('酷狗ID: 777')).toBeTruthy()
    expect(await screen.findByText('最近播放的歌')).toBeTruthy()
    // 页签点击回传宿主，由宿主决定新页签（「收藏歌单」在入口与浮层各有一处，限定在浮层内点）
    const center = document.querySelector('[data-kugou-minimal-center]') as HTMLElement
    fireEvent.click(within(center).getByText('收藏歌单'))
    expect(suiteProps.onOpenTab).toHaveBeenCalledWith('playlists')
  })

  it('未登录时点「我喜欢」先去登录，不打开个人中心', () => {
    const onLoginClick = vi.fn()
    render(<KugouMinimalSuite {...suiteProps} loggedIn={false} onLoginClick={onLoginClick} />)

    fireEvent.click(screen.getByText('我喜欢'))
    expect(onLoginClick).toHaveBeenCalled()
    expect(suiteProps.onOpenTab).not.toHaveBeenCalled()
  })
})

describe('简约模式酷狗个人中心', () => {
  it('最近播放：资料/统计与概念版播放历史渲染，播放全部回传歌曲列表', async () => {
    render(<KugouMinimalCenter {...centerProps} />)

    expect(await screen.findByText('最近播放的歌')).toBeTruthy()
    expect(screen.getByText('安小达')).toBeTruthy()
    expect(screen.getByText('酷狗ID: 777')).toBeTruthy()
    expect(screen.getByText('最近播放 1 首')).toBeTruthy()
    expect(screen.getByText('我喜欢 1 首')).toBeTruthy()
    expect(screen.getByText('收藏歌单 1 个')).toBeTruthy()

    fireEvent.click(screen.getByText('播放全部'))
    expect(centerProps.onPlaySongs).toHaveBeenCalledWith(
      [expect.objectContaining({ mid: 'HASH-RECENT', name: '最近播放的歌' })],
      0,
    )
  })

  it('我喜欢：列「我喜欢」歌单曲目；收藏歌单：只列他人歌单并可打开', async () => {
    const { rerender } = render(<KugouMinimalCenter {...centerProps} />)
    await screen.findByText('最近播放的歌')

    rerender(<KugouMinimalCenter {...centerProps} tab="liked" />)
    expect(await screen.findByText('喜欢的歌')).toBeTruthy()

    rerender(<KugouMinimalCenter {...centerProps} tab="playlists" />)
    expect(await screen.findByText('别人的歌单')).toBeTruthy()
    // 自建歌单（isMine）不进收藏歌单列表
    expect(screen.queryByText('我的自建歌单')).toBeNull()

    fireEvent.click(screen.getByText('别人的歌单'))
    expect(centerProps.onOpenPlaylist).toHaveBeenCalledWith(expect.objectContaining({
      id: 'collection_3_888_9_0',
      name: '别人的歌单',
      trackCount: 8,
      platform: 'kugou',
    }))
  })

  it('未登录：给出登录引导，不发任何数据请求', async () => {
    render(<KugouMinimalCenter {...centerProps} loggedIn={false} />)
    expect(await screen.findByText('登录后查看酷狗个人中心')).toBeTruthy()
    const { fetchKugouPlayRecords } = await import('../src/services/kugouService')
    expect(fetchKugouPlayRecords).not.toHaveBeenCalled()
  })
})
