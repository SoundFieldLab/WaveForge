// 传统模式冒烟测试（v2）：中间栏展示所有内容、搜索/音乐库/歌单/评论/歌手/专辑、顶部模式下拉、真实频谱。
// 纯 DOM + 文本断言（不依赖截图）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const cannedHomePayload = {
  dailySongs: [
    { id: 1, name: '日推歌曲', artists: [{ id: 1, name: '歌手A' }], album: { name: '专辑', picUrl: 'https://p1.music.126.net/x.png' }, duration: 240000, platform: 'netease' },
  ],
  radioSongs: [],
  newSongs: [
    { id: 5, name: '新歌一首', artists: [{ name: '歌手N' }], album: { name: '专辑N', picUrl: 'https://x/n.png' }, duration: 180000, platform: 'netease' },
  ],
  charts: [
    { id: 'ch1', name: '飙升榜', coverUrl: 'https://x/chart.png', platform: 'netease', songs: [{ id: 7, name: '榜一歌曲', artist: '歌手R' }] },
  ],
  playlists: [
    { id: 'pl1', name: '推荐歌单', coverUrl: 'https://x/x.png', trackCount: 12, platform: 'netease' },
  ],
}

vi.mock('../src/services/exploreApi', () => ({
  fetchExploreHome: vi.fn(async () => cannedHomePayload),
  fetchExplorePlaylist: vi.fn(async () => ({
    playlist: { id: 'pl1', name: '推荐歌单', coverImgUrl: 'https://x/x.png', trackCount: 12, platform: 'netease' },
    songs: [{ id: 2, name: '歌单歌曲', artists: [{ name: '歌手B' }], album: { name: '专辑B', picUrl: '' }, duration: 180000, platform: 'netease' }],
  })),
}))

vi.mock('../src/services/playlistService', () => ({
  getUserPlaylists: vi.fn(async () => [
    { id: 'like1', name: '我喜欢的音乐', isLike: true, coverImgUrl: 'https://x/x.png', platform: 'netease' },
    { id: 'm1', name: '我的歌单一', coverImgUrl: 'https://x/x.png', platform: 'netease' },
    { id: 'c1', name: '收藏的歌单', coverImgUrl: 'https://x/x.png', isCollected: true, platform: 'netease' },
  ]),
  subscribePlaylist: vi.fn(async () => ({ code: 200 })),
  createPlaylist: vi.fn(async () => ({ code: 200 })),
  invalidateUserPlaylistsCache: vi.fn(),
}))

vi.mock('../src/services/desktopSpectrum', () => ({
  registerDesktopSpectrumConsumer: vi.fn(() => () => undefined),
}))

import TraditionalView from '../src/components/TraditionalView'
import TraditionalSearch from '../src/components/TraditionalSearch'
import TraditionalComments from '../src/components/TraditionalComments'
import TraditionalAlbumDetail from '../src/components/TraditionalAlbumDetail'

const baseProps = {
  onSongSelect: vi.fn(),
  restorePlaybackOrigin: null,
  currentSong: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  lyrics: [],
  volume: 0.5,
  playerTheme: 'dark' as const,
  neteaseLoggedIn: true,
  neteaseUsername: '测试用户',
  neteaseAvatar: '',
  neteaseUserId: '123',
  neteaseVip: false,
  qqLoggedIn: false,
  qqUsername: '',
  appleLoggedIn: false,
  appleUsername: '',
  spotifyLoggedIn: false,
  spotifyUsername: '',
  kugouLoggedIn: false,
  kugouUsername: '',
  sodaLoggedIn: false,
  sodaUsername: '',
  authRevision: 0,
  onLoginClick: vi.fn(),
  onProfileClick: vi.fn(),
  onSearchClick: vi.fn(),
  onSettingsClick: vi.fn(),
  onPlayPause: vi.fn(),
  onNext: vi.fn(),
  onPrevious: vi.fn(),
  onSeek: vi.fn(),
  onVolumeChange: vi.fn(),
  onOpenArtist: vi.fn(),
  onOpenAlbum: vi.fn(),
  onPlayNext: vi.fn(),
  onAddToFavorites: vi.fn(),
  onRemoveFromFavorites: vi.fn(),
  onAddToPlaylist: vi.fn(),
  onViewComments: vi.fn(),
  onCopyInfo: vi.fn(),
}

describe('传统模式 TraditionalView', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => cleanup())

  it('渲染首页（发现）：平台药丸、搜索按钮、排行榜、新歌、推荐歌单', async () => {
    render(<TraditionalView {...baseProps} />)
    expect(screen.getByText('网易云')).toBeTruthy()
    expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('排行榜')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('飙升榜')).toBeTruthy()
    expect(screen.getByText('新歌速递')).toBeTruthy()
    expect(screen.getByText('新歌一首')).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText('推荐歌单').length).toBeGreaterThan(0), { timeout: 3000 })
  })

  it('点击搜索按钮进入独立搜索页（中间栏）', async () => {
    render(<TraditionalView {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜索 网易云/)).toBeTruthy())
  })

  it('音乐库页显示个性化推荐（不是用户歌单列表）', async () => {
    render(<TraditionalView {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '音乐库' }))
    await waitFor(() => expect(screen.getByText(/专属音乐库|量身推荐/)).toBeTruthy())
    expect(screen.getByText('每日推荐')).toBeTruthy()
  })

  it('左栏歌单含 我的歌单/收藏 切换与创建入口，歌单显示全量', async () => {
    render(<TraditionalView {...baseProps} />)
    await waitFor(() => expect(screen.getByText('我的歌单一')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText('收藏')).toBeTruthy()
    fireEvent.click(screen.getByText('收藏'))
    await waitFor(() => expect(screen.getByText('收藏的歌单')).toBeTruthy())
    expect(screen.getByLabelText('创建歌单')).toBeTruthy()
  })

  it('左上角后退/前进箭头支持页面历史导航', async () => {
    render(<TraditionalView {...baseProps} />)
    // 初始在首页：后退禁用
    const back = screen.getByLabelText('后退')
    expect((back as HTMLButtonElement).disabled).toBe(true)
    // 进入搜索页 → 后退可用
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜索 网易云/)).toBeTruthy())
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByRole('button', { name: '搜索' })).toBeTruthy())
    expect(screen.queryByPlaceholderText(/搜索 网易云/)).toBeNull()
    // 前进回到搜索页
    fireEvent.click(screen.getByLabelText('前进'))
    await waitFor(() => expect(screen.getByPlaceholderText(/搜索 网易云/)).toBeTruthy())
  })

  it('平台药丸在右上角（头部仍渲染平台标签）', async () => {
    render(<TraditionalView {...baseProps} />)
    expect(screen.getByText('网易云')).toBeTruthy()
    expect(screen.getByText('QQ音乐')).toBeTruthy()
  })

  it('顶部悬停区域出现模式下拉触发（全局顶部下拉条）', async () => {
    render(<TraditionalView {...baseProps} />)
    // 顶部居中悬停区域 → 出现下拉箭头按钮
    fireEvent.mouseEnter(screen.getByLabelText('顶部悬停切换模式区域'))
    await waitFor(() => expect(screen.getByLabelText('打开模式选择')).toBeTruthy())
  })

  it('独立搜索组件：输入关键词触发搜索并渲染歌曲结果', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 200, result: { songs: [{ id: 9, name: '搜索结果歌', artists: [{ name: '歌手C' }], album: { name: '专辑C', picUrl: '' }, duration: 200000 }] } }),
    })) as any
    render(<TraditionalSearch platform="netease" accent="#ec4899" isDark currentSong={null} onBack={() => undefined} onSongSelect={vi.fn()} onOpenPlaylist={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/搜索 网易云/), { target: { value: '周杰伦' } })
    await waitFor(() => expect(screen.getByText('搜索结果歌')).toBeTruthy(), { timeout: 3000 })
  })

  it('独立评论内容块：加载并渲染评论（中间栏直接显示）', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 200, data: { comments: [{ commentId: 'c1', content: '这是一条评论', user: { nickname: '评论者', avatarUrl: '' }, time: 1700000000, likedCount: 3 }], hotComments: [], hasMore: false } }),
    })) as any
    const song = { id: 1, name: '评论歌曲', artists: [{ name: '歌手' }], album: { name: '专辑', picUrl: '' }, duration: 1000, platform: 'netease' as const }
    render(<TraditionalComments song={song} accent="#ec4899" isDark onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText('这是一条评论')).toBeTruthy())
    expect(screen.getByText('评论者')).toBeTruthy()
  })

  it('独立专辑内容块：渲染专辑详情头不抛错', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) })) as any
    render(<TraditionalAlbumDetail albumId="42" platform="netease" accent="#ec4899" isDark currentSong={null} onClose={() => undefined} onSongSelect={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('专辑详情')).toBeTruthy())
  })
})
