/** @vitest-environment jsdom */
// 传统模式 Apple Music 客户端复刻冒烟测试（2026-10-08）：
//  · 左栏结构 = 官方客户端侧栏（搜索 / 主页 / 广播 / 资料库四项 / 播放列表两项 / 底部账号）
//  · 未订阅（未登录或登录但会员过期）→ 主页是订阅广告；点「免费试用」打开购买窗口（Electron 桥）
//  · 广播页 = 客户端版式（大电台卡 + 风格电台方卡货架），数据走 fetchAppleRadioPage
//  · 资料库「歌曲」= 客户端表格列（标题/时长/艺人/专辑/类型/★/播放次数）+ 过滤
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { configure } from '@testing-library/dom'

// 页面按需懒加载：全量跑（并行 240+ 文件）时首次动态 import 可能超过默认 1s 等待，放宽到 5s
configure({ asyncUtilTimeout: 5000 })

// jsdom 没有实现 Element.scrollTo（页面导航会调用主滚动容器）
if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined
}

vi.mock('../src/services/desktopSpectrum', () => ({
  registerDesktopSpectrumConsumer: vi.fn(() => () => undefined),
}))

vi.mock('../src/services/exploreApi', () => ({
  fetchExploreHome: vi.fn(async () => ({ personalized: false, dailySongs: [], radioSongs: [], newSongs: [], charts: [], playlists: [] })),
  fetchExplorePlaylist: vi.fn(async () => ({ playlist: null, songs: [] })),
  fetchExploreChart: vi.fn(async () => ({ songs: [] })),
  fetchExploreChannel: vi.fn(async () => ({ songs: [] })),
  fetchExploreRecommendationBatch: vi.fn(async () => []),
}))

vi.mock('../src/services/playlistService', () => ({
  getUserPlaylists: vi.fn(async () => []),
  subscribePlaylist: vi.fn(async () => ({ code: 200 })),
  createPlaylist: vi.fn(async () => ({ code: 200 })),
  getLikedSongs: vi.fn(async () => ({ ids: [], mids: [] })),
  invalidateUserPlaylistsCache: vi.fn(),
  deletePlaylist: vi.fn(),
  updatePlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
}))

// ── Apple 数据层：只桩掉网络函数，其余导出保持真实（类型/常量/转换）─────
const librarySongs = [
  { id: 'i.aaa', catalogId: '111', name: '客户端列测试曲', artistName: '测试艺人', albumName: '测试专辑', artworkUrl: '', durationMs: 125000, genreName: 'J-Pop', playCount: 3, dateAdded: Date.parse('2026-09-01T00:00:00Z') },
  { id: 'i.bbb', catalogId: '222', name: 'Zzz 另一首', artistName: '别的艺人', albumName: '其它专辑', artworkUrl: '', durationMs: 90000, genreName: 'Anime', playCount: 0 },
]
vi.mock('../src/services/appleCatalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/appleCatalog')>()
  return {
    ...actual,
    getAppleLibrarySongs: vi.fn(async () => librarySongs),
    getAppleLibraryPlaylists: vi.fn(async () => []),
    getAppleLibraryAlbums: vi.fn(async () => []),
    getAppleLibraryArtists: vi.fn(async () => []),
    getAppleFavoriteSongs: vi.fn(async () => []),
    getAppleFavoriteSongIds: vi.fn(async () => ['111']),
    getAppleLovedSongIds: vi.fn(async (ids: string[]) => ids.filter(id => id === '111')),
    setAppleSongLoved: vi.fn(async () => true),
    // 默认「无失败原因」；订阅失效用例里单独改
    getLastAppleMeFailureMessage: vi.fn(() => ''),
  }
})

const radioSections = [
  {
    id: 'radio-hot', kind: 'grid' as const, title: '热门电台',
    items: [
      { id: 'ra.1', playId: 'ra.1', type: 'stations' as const, name: '流行乐电台', subtitle: 'Apple Music 电台', curatorName: 'Apple Music 电台', artworkUrl: 'https://is1-ssl.mzstatic.com/x/1.jpg' },
      { id: 'ra.2', playId: 'ra.2', type: 'stations' as const, name: '经典流行乐电台', curatorName: 'Apple Music 电台', artworkUrl: 'https://is1-ssl.mzstatic.com/x/2.jpg' },
    ],
  },
  {
    id: 'radio-genre', kind: 'grid' as const, title: '风格电台',
    items: [
      { id: 'ra.3', playId: 'ra.3', type: 'stations' as const, name: 'Spa 音乐', curatorName: 'Apple Music 电台', artworkUrl: 'https://is1-ssl.mzstatic.com/x/3.jpg' },
    ],
  },
]
vi.mock('../src/services/appleWebService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/appleWebService')>()
  return {
    ...actual,
    fetchAppleRadioPage: vi.fn(async () => ({ sections: radioSections, personalized: false, sourceLabel: 'apple-api editorial(radio)' })),
    fetchAppleHomePage: vi.fn(async () => ({ sections: [], personalized: false, sourceLabel: 'apple-rss（未登录）' })),
    // 搜索页落地 = 类别浏览（apple-curators 网格）
    fetchAppleSearchLanding: vi.fn(async () => ({
      hero: null,
      personalized: false,
      sourceLabel: 'apple-api search landing',
      sections: [{
        id: 'curators', kind: 'curators', title: '类别浏览',
        items: [
          { id: 'c1', playId: 'c1', type: 'curators', name: '国语流行', artworkUrl: '' },
          { id: 'c2', playId: 'c2', type: 'curators', name: 'K-Pop', artworkUrl: '' },
        ],
      }],
    })),
    fetchAppleCuratorPage: vi.fn(async () => null),
    appleStationToSong: vi.fn((item: { playId: string; name: string; artworkUrl?: string }) => ({
      id: 0, name: item.name, artists: [{ name: 'Apple Music 电台' }], album: { name: '', picUrl: item.artworkUrl || '' }, duration: 0, platform: 'apple' as const, appleId: item.playId,
    })),
    appleWebItemToSong: vi.fn((item: { playId: string; name: string; artworkUrl?: string }) => ({
      id: 0, name: item.name, artists: [{ name: '' }], album: { name: '', picUrl: item.artworkUrl || '' }, duration: 0, platform: 'apple' as const, appleId: item.playId,
    })),
  }
})
vi.mock('../src/services/appleAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/appleAuth')>()
  return {
    ...actual,
    getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'media', storefront: 'cn' }),
  }
})

import TraditionalView from '../src/components/TraditionalView'

const analyzerSnapshot = {
  bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
  spectrum: new Float32Array(24),
  left: { bass: 0, mid: 0, high: 0, overall: 0 },
  right: { bass: 0, mid: 0, high: 0, overall: 0 },
}
const analyzerStore = {
  subscribe: () => () => undefined,
  getSnapshot: () => analyzerSnapshot,
  retainBackground: () => () => undefined,
  hasBackgroundConsumers: () => false,
}
const baseProps = {
  onSongSelect: vi.fn(),
  onOpenPlayer: vi.fn(),
  analyzerStore,
  restorePlaybackOrigin: null,
  currentSong: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  playbackTimeStore: { subscribe: () => () => undefined, getSnapshot: () => ({ currentTime: 0 }) },
  duration: 0,
  lyrics: [],
  volume: 0.5,
  playerTheme: 'light' as const,
  neteaseLoggedIn: false,
  neteaseUsername: '',
  qqLoggedIn: false,
  qqUsername: '',
  appleLoggedIn: false,
  appleUsername: '',
  appleAvatar: '',
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

const renderApple = (overrides: Record<string, unknown> = {}) => render(<TraditionalView {...baseProps} {...overrides} />)

describe('传统模式 Apple Music 客户端复刻', () => {
  beforeEach(() => {
    localStorage.clear()
    // 平台 = Apple（TraditionalView 从同步键恢复平台）
    localStorage.setItem('waveforge:platform', 'apple')
  })
  afterEach(() => { cleanup(); vi.clearAllMocks() })

  it('左栏是客户端结构：搜索 + 主页/广播 + 资料库四项 + 播放列表两项 + 底部账号', async () => {
    renderApple()
    const sidebar = await screen.findByTestId('apple-pc-sidebar')
    for (const label of ['主页', '广播', '资料库', '最近添加', '艺人', '专辑', '歌曲', '播放列表', '所有播放列表', '喜爱歌曲']) {
      expect(within(sidebar).getByText(label)).toBeTruthy()
    }
    expect(within(sidebar).getByPlaceholderText('搜索')).toBeTruthy()
    expect(within(sidebar).getByText('登录 Apple Music')).toBeTruthy()
    // 客户端顶栏的播放控件不复刻：左栏里不应出现「随机播放 / 队列」这类控件
    expect(within(sidebar).queryByLabelText('随机播放')).toBeNull()
  })

  it('未登录时主页是订阅广告，点「免费试用」打开购买窗口（Electron 桥）', async () => {
    const appleSubscribe = vi.fn(async () => ({ success: true }))
    ;(window as unknown as { electron?: Record<string, unknown> }).electron = { appleSubscribe }
    try {
      renderApple()
      const ad = await screen.findByTestId('apple-pc-subscribe-ad')
      expect(within(ad).getByText('尽是你爱听的音乐。')).toBeTruthy()
      fireEvent.click(within(ad).getByRole('button', { name: '免费试用' }))
      await waitFor(() => expect(appleSubscribe).toHaveBeenCalledTimes(1))
    } finally {
      delete (window as unknown as { electron?: unknown }).electron
    }
  })

  it('点左栏「广播」→ 客户端版式广播页（大电台卡 + 风格电台货架）', async () => {
    renderApple()
    const sidebar = await screen.findByTestId('apple-pc-sidebar')
    fireEvent.click(within(sidebar).getByText('广播'))
    expect(await screen.findByText('热门电台')).toBeTruthy()
    expect(screen.getByText('风格电台')).toBeTruthy()
    expect(screen.getByText('流行乐电台')).toBeTruthy()
    expect(screen.getAllByText('Apple Music 电台').length).toBeGreaterThan(0)
  })

  it('点左栏「歌曲」→ 客户端歌曲表：标题/时长/艺人/专辑/类型/★/播放次数，且过滤生效', async () => {
    renderApple({ appleLoggedIn: true, appleUsername: '芳乃 凌音' })
    const sidebar = await screen.findByTestId('apple-pc-sidebar')
    fireEvent.click(within(sidebar).getByText('歌曲'))

    // 表格页工具条（客户端：居中小标题 + 过滤/显示选项）
    expect(await screen.findByText('客户端列测试曲')).toBeTruthy()
    for (const header of ['标题', '时长', '艺人', '专辑', '类型', '播放次数']) {
      expect(screen.getAllByText(header).length).toBeGreaterThan(0)
    }
    expect(screen.getByText('J-Pop')).toBeTruthy()
    expect(screen.getByText('2:05')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()

    // 过滤：输入关键词后只剩匹配行
    fireEvent.click(screen.getByLabelText('过滤'))
    const filterInput = await screen.findByPlaceholderText('过滤')
    fireEvent.change(filterInput, { target: { value: 'zzz' } })
    await waitFor(() => expect(screen.queryByText('客户端列测试曲')).toBeNull())
    expect(screen.getByText('Zzz 另一首')).toBeTruthy()
  })

  it('资料库接口被拒（订阅失效 40015）时给出准确状态与续订入口，而不是空态', async () => {
    const catalog = await import('../src/services/appleCatalog')
    const songsMock = catalog.getAppleLibrarySongs as unknown as ReturnType<typeof vi.fn>
    const failureMock = catalog.getLastAppleMeFailureMessage as unknown as ReturnType<typeof vi.fn>
    // 注意：TraditionalView 的平台侧栏也会拉一次 getAppleLibrarySongs，所以这里改「实现」而不是 Once
    songsMock.mockImplementation(async () => [])
    failureMock.mockImplementation(() => 'Apple Music 订阅已失效，暂时无法使用「资料库」，续订后即可恢复')
    const appleSubscribe = vi.fn(async () => ({ success: true }))
    ;(window as unknown as { electron?: Record<string, unknown> }).electron = { appleSubscribe }
    try {
      renderApple({ appleLoggedIn: true, appleUsername: '芳乃 凌音' })
      const sidebar = await screen.findByTestId('apple-pc-sidebar')
      fireEvent.click(within(sidebar).getByText('歌曲'))
      const notice = await screen.findByTestId('apple-pc-subscription-notice')
      expect(within(notice).getByText('Apple Music 订阅已失效')).toBeTruthy()
      expect(within(notice).getByText(/当你的会员资格暂停后/)).toBeTruthy()
      expect(within(notice).getByText(/续订后即可恢复/)).toBeTruthy()
      fireEvent.click(within(notice).getByRole('button', { name: '免费试用' }))
      await waitFor(() => expect(appleSubscribe).toHaveBeenCalledTimes(1))
    } finally {
      delete (window as unknown as { electron?: unknown }).electron
      songsMock.mockImplementation(async () => librarySongs)
      failureMock.mockImplementation(() => '')
    }
  })

  it('主页（已登录）：订阅失效时页首是订阅广告卡，内容交给探索页 Apple 面板渲染', async () => {
    const web = await import('../src/services/appleWebService')
    const homeMock = web.fetchAppleHomePage as unknown as ReturnType<typeof vi.fn>
    homeMock.mockImplementation(async () => ({
      sections: [],
      hero: null,
      personalized: false,
      sourceLabel: 'Apple Music · 公开推荐',
      fallbackReason: 'Apple Music 订阅已失效，个性化推荐暂不可用，已显示公开内容',
      subscriptionExpired: true,
    }))
    try {
      renderApple({ appleLoggedIn: true, appleUsername: '芳乃 凌音' })
      // 复刻主页容器 + 订阅广告卡（免费试用 → 购买窗口）；内容由嵌入的探索面板渲染
      const page = await screen.findByTestId('apple-pc-home')
      expect(page).toBeTruthy()
      const ad = await screen.findByTestId('apple-pc-subscribe-ad')
      expect(within(ad).getByText('尽是你爱听的音乐。')).toBeTruthy()
      expect(within(ad).getByRole('button', { name: '免费试用' })).toBeTruthy()
    } finally {
      homeMock.mockImplementation(async () => ({ sections: [], personalized: false, sourceLabel: 'apple-rss（未登录）' }))
    }
  })

  it('搜索框进的是客户端搜索页：先显示「类别浏览」，再出结果分区', async () => {
    renderApple()
    const sidebar = await screen.findByTestId('apple-pc-sidebar')
    // 侧栏点「搜索」（放大镜按钮）→ 复刻搜索页
    fireEvent.click(within(sidebar).getAllByRole('button', { name: '搜索' })[0])
    const page = await screen.findByTestId('apple-pc-search')
    expect(within(page).getByText('搜索')).toBeTruthy()
    // 无关键词 = 类别浏览（apple-curators 网格）
    expect(await within(page).findByText('国语流行')).toBeTruthy()
    expect(within(page).getByText('K-Pop')).toBeTruthy()
  })
})
