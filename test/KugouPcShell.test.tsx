/** @vitest-environment jsdom */
/**
 * 传统模式酷狗客户端外壳（KugouPcShell）jsdom 冒烟：
 * 1) 左导航九项 + 音乐页签五项 + 推荐页五张大卡（对齐官方截图的骨架必须存在）；
 * 2) 页签/左导航切换与未登录空态（收藏/最近播放给登录提示，不造假数据）；
 * 3) 登录态下「我的收藏 / 最近播放」真实渲染（数据来自 mock 的 kugouService）。
 * 全部数据走 mock，不触网；听书 Overlay 与刷歌入口整块替换成哑组件，避免拉入播放器实现。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExplorePayload } from '../src/services/exploreApi'
import type { KugouTrack } from '../src/services/kugouService'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

// 听书播放器是 portal + 独立 Audio，冒烟测试只关心外壳挂载点，整体哑掉
vi.mock('../src/features/kugouLongaudio/KugouLongaudioOverlay', () => ({ default: () => null }))
vi.mock('../src/features/kugouLongaudio/store', () => {
  const state = {
    view: 'closed' as const,
    browse: { albums: [], page: 0, hasMore: false, loading: false, error: '', tag: null },
    player: { album: null, chapters: [], currentIndex: -1, status: 'idle' },
    recent: [],
    activeAlbum: null,
  }
  return {
    kugouLongaudioStore: {
      subscribe: () => () => {},
      getState: () => state,
      ensureBrowseLoaded: vi.fn(async () => {}),
      loadMoreBrowse: vi.fn(async () => {}),
      setBrowseTag: vi.fn(),
      openLibrary: vi.fn(),
      enter: vi.fn(),
      openAlbum: vi.fn(async () => {}),
    },
    selectBrowseTags: () => [],
    selectVisibleBrowseAlbums: () => [],
    LONGAUDIO_DAILY_PAGE_SIZE: 24,
  }
})

// 「刷歌」入口已随产品决策下线（导航表不再含 shuffle 项），旧 mock 一并移除

const likedTrack: KugouTrack = {
  hash: 'abc123',
  songName: '珂拉琪的歌',
  singerName: '珂拉琪',
  albumName: '专辑A',
  duration: 201,
  albumId: '9001',
  albumAudioId: 55,
  coverUrl: 'https://example.test/a.jpg',
}

const recentTrack: KugouTrack = {
  hash: 'def456',
  songName: '最近听过',
  singerName: 'S.H.E',
  albumName: '专辑B',
  duration: 184,
  albumAudioId: 66,
  coverUrl: 'https://example.test/b.jpg',
}

const trackToSong = (track: KugouTrack) => ({
  id: 1,
  mid: track.hash,
  name: track.songName,
  artists: [{ name: track.singerName }],
  album: { id: 1, mid: track.albumId, name: track.albumName || '', picUrl: track.coverUrl || '' },
  duration: (track.duration || 0) * 1000,
  platform: 'kugou' as const,
})

vi.mock('../src/services/kugouService', () => ({
  resolveKugouCover: (url: string) => url || '',
  kugouTrackToSong: (track: KugouTrack) => trackToSong(track),
  fetchKugouUserPlaylists: vi.fn(async () => ([
    { specialid: 'liked-gid', listid: '2', name: '我喜欢', coverUrl: 'https://example.test/liked.jpg', songcount: 2, isMine: true },
    { specialid: 'mine-gid', listid: '7', name: '自建歌单', coverUrl: '', songcount: 3, isMine: true },
    { specialid: 'col-gid', listid: '9', name: '收藏的歌单', coverUrl: '', songcount: 5, isMine: false },
  ])),
  fetchKugouUserPlaylistTracks: vi.fn(async () => [likedTrack]),
  fetchKugouPlayRecords: vi.fn(async () => ({
    records: [{ mxid: 66, ot: 1759800000, pc: 3, track: recentTrack }],
    hasMore: false,
    bp: '',
  })),
  fetchKugouPlaylistsByTag: vi.fn(async () => ({ playlists: [], hasNext: false })),
  fetchKugouUserCloud: vi.fn(async () => ({ songs: [], empty: true, total: 0 })),
  fetchKugouPurchasedSongs: vi.fn(async () => ({ songs: [], total: 0 })),
  fetchKugouPurchasedAlbums: vi.fn(async () => ({ albums: [], total: 0 })),
  hasKugouConceptCredential: vi.fn(() => false),
  createKugouUserPlaylist: vi.fn(async () => ({ result: 200 })),
}))

import KugouPcShell from '../src/features/traditionalPc/KugouPcShell'
import { pcTheme } from '../src/features/traditionalPc/pcKit'

const payload = {
  platform: 'kugou',
  dailySongs: [{ id: 5, mid: 'd1', name: '每日一首', artists: [{ name: '歌手A' }], album: { name: '', picUrl: 'https://example.test/d.jpg' }, duration: 200000, platform: 'kugou' }],
  newSongs: [],
  playlists: [],
  charts: [
    { id: 'kg-8888', name: 'TOP500', group: '酷狗音乐', description: '', coverUrl: 'https://example.test/rank.jpg', updateText: '实时更新', platform: 'kugou', songs: [{ mid: 'r1', name: '榜首歌', artist: '歌手B' }] },
  ],
  albums: [],
  channels: [],
  radioSongs: [],
  meta: { source: 'test', updatedAt: 0 },
  kugou: {
    dailySongs: [{ id: 5, mid: 'd1', name: '每日一首', artists: [{ name: '歌手A' }], album: { name: '', picUrl: 'https://example.test/d.jpg' }, duration: 200000, platform: 'kugou' }],
    dailyDate: '20261007',
    newSongs: [
      { song: { id: 6, mid: 'n1', name: '新歌一首', artists: [{ name: '歌手C' }], album: { name: '', picUrl: 'https://example.test/n.jpg' }, duration: 180000, platform: 'kugou' }, publishDate: '2026-10-07' },
    ],
    channels: [],
    channelError: 'CHANNELS_EMPTY',
    tagGroups: [{ id: 'g1', name: '语种', tags: [{ id: 't1', name: '华语' }] }],
    tagPlaylists: [
      { id: 'p1', name: '精选歌单一号', coverUrl: 'https://example.test/p1.jpg', playCount: 19774000, trackCount: 30, creator: '酷狗官方', tags: ['流行'], platform: 'kugou' },
    ],
    tagPlaylistsHasNext: false,
    yueku: null,
    singers: [{ singerid: 's1', singername: '周杰伦', coverUrl: 'https://example.test/s.jpg', fansCount: 1000000 }],
  },
} as unknown as ExplorePayload

const actions = {
  onPlaySongs: vi.fn(),
  onSongMenu: vi.fn(),
  onOpenPlaylist: vi.fn(),
  onNavigate: vi.fn(),
}

const queueSongs = [
  { id: 5, mid: 'd1', name: '每日一首', artists: [{ name: '歌手A' }], album: { name: '', picUrl: 'https://example.test/d.jpg' }, duration: 200000, platform: 'kugou' as const },
]

// useSyncExternalStore 要求 getSnapshot 返回缓存对象：每次新建对象会让 React 判定「快照一直在变」而无限重渲染
const timeSnapshot = { currentTime: 12, duration: 200, isPlaying: true }
const playbackTimeStore = {
  getSnapshot: () => timeSnapshot,
  subscribe: () => () => {},
  publish: () => {},
}

function renderShell(overrides: {
  loggedIn?: boolean
} = {}) {
  const loggedIn = overrides.loggedIn ?? false
  return render(
    <KugouPcShell
      chrome={{ tone: 'light', accent: '#ff7a00', skin: 'kugou' }}
      account={{ loggedIn, username: loggedIn ? '安小达' : '', userId: loggedIn ? '777' : '' }}
      actions={actions as never}
      payload={payload}
      authRevision={0}
      active
      currentSong={queueSongs[0]}
      queue={queueSongs}
      isPlaying
      liked={false}
      onPlayPause={vi.fn()}
      onNext={vi.fn()}
      onPrevious={vi.fn()}
      onToggleFavorite={vi.fn()}
      onOpenComments={vi.fn()}
      onSearchSubmit={vi.fn()}
      onLoginClick={vi.fn()}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => cleanup())

describe('KugouPcShell 骨架（对齐官方客户端）', () => {
  it('渲染左导航六项（本地与下载/音乐云盘已下线）、音乐页签五项与推荐页五张大卡', async () => {
    renderShell()

    // 左导航（官方的直播入口按规范去掉）
    for (const label of ['音乐', '听书', '我的收藏', '最近播放', '我的听书', '已购音乐']) {
    // 本地与下载/音乐云盘已按产品决策下线：入口不存在
    expect(screen.queryByText('本地与下载')).toBeNull()
    expect(screen.queryByText('音乐云盘')).toBeNull()
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    // 「刷歌」已下线：左导航不再有该入口
    expect(screen.queryByTestId('kugou-youth-nav')).toBeNull()
    expect(screen.queryByText('刷歌')).toBeNull()

    // 官方页签（视频/AI帮唱/赚钱不做）
    for (const tab of ['推荐', '乐库', '歌单', '频道', '分类']) {
      expect(screen.getByRole('button', { name: tab })).toBeTruthy()
    }
    expect(screen.queryByRole('button', { name: '赚钱' })).toBeNull()

    // 推荐页五张大卡
    for (const card of ['猜你喜欢', '每日推荐', '排行榜', '歌单广场', '歌手']) {
      expect(screen.getAllByText(card).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('今日专属推荐')).toBeTruthy()
    expect(screen.getByText('精选歌单一号')).toBeTruthy()

    // 不复刻官方底栏：播放控制/队列在 TraditionalView 的统一右栏（外壳外），外壳内不再有播放条/队列
    expect(document.querySelector('[data-kugou-pc-shell]')).toBeTruthy()
    expect(document.querySelector('[data-kugou-pc-playbar]')).toBeNull()
    expect(screen.queryByRole('button', { name: '播放列表' })).toBeNull()
  })

  it('切换页签与左导航，未登录时收藏/最近播放给登录空态', async () => {
    renderShell()
    expect(screen.getByText('精选歌单一号')).toBeTruthy()

    // 乐库：新歌速递 + 歌手目录
    fireEvent.click(screen.getByRole('button', { name: '乐库' }))
    expect(await screen.findByText('新歌速递')).toBeTruthy()
    expect(screen.getByText('新歌一首')).toBeTruthy()
    expect(screen.getByText('周杰伦')).toBeTruthy()

    // 频道：空态如实说明上游没返回
    fireEvent.click(screen.getByRole('button', { name: '频道' }))
    expect(await screen.findByText('当前账号还没有可显示的频道')).toBeTruthy()

    // 分类：标签维度分组的入口
    fireEvent.click(screen.getByRole('button', { name: '分类' }))
    expect((await screen.findAllByText('语种')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('华语').length).toBeGreaterThan(0)

    // 我的收藏（未登录）
    fireEvent.click(screen.getAllByText('我的收藏')[0])
    expect(await screen.findByText('登录后查看我的收藏')).toBeTruthy()

    // 最近播放（未登录）
    fireEvent.click(screen.getAllByText('最近播放')[0])
    expect(await screen.findByText('登录后同步最近播放记录')).toBeTruthy()
  })

  it('登录后收藏与最近播放按概念版数据渲染', async () => {
    renderShell({ loggedIn: true })

    // 收藏默认在「歌单」页签（官方同款），切到「单曲」看我喜欢曲目
    fireEvent.click(screen.getAllByText('我的收藏')[0])
    expect(await screen.findByText('收藏的歌单')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^单曲/ }))
    expect(await screen.findByText('珂拉琪的歌')).toBeTruthy()

    fireEvent.click(screen.getAllByText('最近播放')[0])
    expect(await screen.findByText('最近听过')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('听过3次')).toBeTruthy())
  })
})

describe('KugouPcShell 主题', () => {
  it('浅色皮肤下不发散（pcTheme light 可用）', () => {
    expect(pcTheme('light').text).toContain('text-slate')
  })
})
