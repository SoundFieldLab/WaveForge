/** @vitest-environment jsdom */
// 传统模式冒烟测试（v2）：中间栏展示所有内容、搜索/音乐库/歌单/评论/歌手/专辑、顶部模式下拉、真实频谱。
// 纯 DOM + 文本断言（不依赖截图）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

if (typeof Element !== 'undefined' && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => undefined
}

const cannedHomePayload = {
  personalized: true,  dailySongs: [
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
  fetchExploreChart: vi.fn(),
  fetchExploreChannel: vi.fn(),
}))

// 传统模式首页 = PC 客户端风格页面（QQPcHome 吃聚合 payload；NeteasePcHome 自拉原生数据）。
// 外壳冒烟测试直接用真实组件（jsdom 网络失败会优雅降级），只断言外壳接线与 PC 结构。
vi.mock('../src/features/qqExplore/QQExplorePage', () => ({ default: () => <div data-testid="qq-explore-page" /> }))

// QQ 首页的数据源 = QQ 客户端原生推荐流（不是手机端聚合数据）：这里给它一份与客户端同构的
// 两卡货架，验证首页按 feed 卡片渲染与点击分发。
vi.mock('../src/features/qqExplore/api', () => ({
  fetchQQExploreBootstrap: vi.fn(async () => ({
    feed: {
      loadMark: 1,
      hasMore: false,
      cursor: { page: 1, shelfCount: 1 },
      modules: [{
        id: 'hi', instanceId: 'hi', title: 'Hi 测试用户  今日为你推荐', style: 2, source: 'qq-native-recommend-feed', refresh: null,
        cards: [
          { id: 'c-radio', feedKey: 'hi', type: 700, subtype: 711, style: 201, title: '猜你喜欢', subtitle: '', coverUrl: 'https://x/radio.png', songs: [], action: { type: 'play-radio' } },
          { id: 'c-daily', feedKey: 'hi', type: 500, subtype: 510, style: 202, title: '每日30首', subtitle: 'イエナイ-花村想太', layerTitle: 'Daily 30', coverUrl: 'https://x/daily.png', songs: [], action: { type: 'open-playlist', playlistId: '7912452323' } },
        ],
      }],
    },
    musicHall: [],
    daily30: { playlistId: '7912452323', title: '测试用户的今日私享', coverUrl: 'https://x/daily30.png', dateKey: '2026-09-29', songs: [{ id: 1, name: '日推歌曲', artists: [{ name: '歌手A' }], album: { name: '专辑', picUrl: '' }, duration: 240000, platform: 'qq' }] },
  })),
  fetchQQRadarSongs: vi.fn(async () => ({ songs: [], hasMore: false, page: 1 })),
  fetchQQExploreFeed: vi.fn(async () => ({ modules: [], loadMark: 0, hasMore: false, cursor: { page: 1, shelfCount: 0 } })),
  fetchQQExploreAppendShelf: vi.fn(async () => ({ modules: [] })),
  fetchQQExploreSimilarShelf: vi.fn(async () => ({ modules: [] })),
  resolveQQExploreSongs: vi.fn(async () => []),
  resolveQQExploreSong: vi.fn(async () => null),
  fetchQQExplorePreferences: vi.fn(async () => ({ items: [] })),
  saveQQExplorePreferences: vi.fn(async () => ({ saved: 0 })),
  fetchQQDislikeList: vi.fn(async () => ({ songs: [] })),
  fetchQQExploreFeedbackOptions: vi.fn(async () => ({ options: [], affirmText: '' })),
  submitQQExploreFeedback: vi.fn(async () => ({ success: true })),
}))

vi.mock('../src/services/playlistService', () => ({
  getUserPlaylists: vi.fn(async () => [
    { id: 'like1', name: '我喜欢的音乐', isLike: true, coverImgUrl: 'https://x/x.png', platform: 'netease' },
    { id: 'm1', name: '我的歌单一', coverImgUrl: 'https://x/x.png', platform: 'netease' },
    { id: 'c1', name: '收藏的歌单', coverImgUrl: 'https://x/x.png', isCollected: true, platform: 'netease' },
  ]),
  subscribePlaylist: vi.fn(async () => ({ code: 200 })),
  createPlaylist: vi.fn(async () => ({ code: 200 })),
  // PC 复刻左栏的计数与红心判定会读它（真实模块返回标识符列表，不含歌曲对象）
  getLikedSongs: vi.fn(async () => ({ ids: ['1'], mids: [] })),
  invalidateUserPlaylistsCache: vi.fn(),
}))

vi.mock('../src/services/desktopSpectrum', () => ({
  registerDesktopSpectrumConsumer: vi.fn(() => () => undefined),
}))

import { fetchExploreHome, fetchExploreChart } from '../src/services/exploreApi'
import TraditionalView from '../src/components/TraditionalView'
import TraditionalSearch, { clearTraditionalSearchCache } from '../src/components/TraditionalSearch'

/** 页面「冻结」后不再卸载、只隐藏：用 aria-hidden 祖先判断「已经离开这一页」。 */
const isHiddenPane = (el: Element | null) => Boolean(el && el.closest('[aria-hidden="true"]'))
import TraditionalComments from '../src/components/TraditionalComments'
import TraditionalAlbumDetail from '../src/components/TraditionalAlbumDetail'
import TraditionalPlaylistDetail from '../src/components/TraditionalPlaylistDetail'
import { dispatchTvBack } from '../src/tv/tvCore'
import { contrastRatio } from '../src/services/foliaReadableColor'
import { isPlaylistOwner } from '../src/services/playlistOwnership'

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

const createMutableAnalyzerStore = () => {
  let snapshot = analyzerSnapshot
  const listeners = new Set<() => void>()
  return {
    store: {
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      getSnapshot: () => snapshot,
      retainBackground: () => () => undefined,
      hasBackgroundConsumers: () => false,
    },
    publish(spectrum: number[]) {
      snapshot = { ...analyzerSnapshot, spectrum: Float32Array.from(spectrum) }
      for (const listener of listeners) listener()
    },
  }
}

const playingSong = {
  id: 88,
  name: '正在播放歌曲',
  artists: [{ name: '播放歌手' }],
  album: { name: '播放专辑', picUrl: 'https://x/playing.png' },
  duration: 180000,
  platform: 'netease' as const,
}

const playbackSnapshot = { currentTime: 0 }

const baseProps = {
  onSongSelect: vi.fn(),
  onOpenPlayer: vi.fn(),
  analyzerStore,
  restorePlaybackOrigin: null,
  currentSong: null,
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  playbackTimeStore: {
    subscribe: () => () => undefined,
    getSnapshot: () => playbackSnapshot,
  },
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
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(fetchExploreChart).mockReset()
    vi.mocked(fetchExploreHome).mockResolvedValue(cannedHomePayload as any)
    // 搜索结果缓存是模块级的（本会话复用），测试之间要清掉，否则断言「打了几次接口」会被上一次的结果命中。
    clearTraditionalSearchCache()
    // 注意：不要在这里统一 stub globalThis.fetch。本文件的用例各自按需替换 fetch，
    // 且首页的兜底内容依赖「jsdom 网络失败」这条路径（例如网易云 7 张快捷卡的本地兜底标题、
    // QQPcHome「你的歌单宝藏库」退回聚合 payload）。统一换成失败桩会让这些兜底链走岔。
  })
  afterEach(() => cleanup())

  it('渲染首页（发现）：平台药丸、顶栏搜索入口、网易云推荐页快捷卡', async () => {
    render(<TraditionalView {...baseProps} />)
    expect(screen.getByText('网易云')).toBeTruthy()
    expect(screen.getByTestId('traditional-top-search')).toBeTruthy()
    // 网易云 PC 推荐页：官方 7 张快捷卡（接口不可用时用本地兜底标题，结构必须在）
    await waitFor(() => expect(screen.getByText('每日推荐')).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText('私人漫游')).toBeTruthy()
    expect(screen.getByText('音乐播客')).toBeTruthy()
  })

  it('聚合首页失败时客户端推荐页照常渲染', async () => {
    vi.mocked(fetchExploreHome).mockRejectedValueOnce(new Error('网络暂时不可用'))
    render(<TraditionalView {...baseProps} />)
    // 复刻推荐页自含原生数据链路：聚合 payload 失败不影响客户端结构渲染
    await waitFor(() => expect(screen.getByText('每日推荐')).toBeTruthy(), { timeout: 4000 })
    // 聚合 payload 自「加载优化」起在首屏后延迟 ~2.5s 才拉（冷启动让出关键路径）；这里等它真实
    // 发起并失败后页面仍照常渲染。必须在用例内消费掉这次 once-rejection，否则残留队列会污染
    // 后续用例的 fetchExploreHome 调用（全量跑时曾因此连锁失败）。
    await waitFor(() => expect(fetchExploreHome).toHaveBeenCalled(), { timeout: 6000 })
    expect(screen.getByText('每日推荐')).toBeTruthy()
  })

  it('点击搜索按钮进入独立搜索页（中间栏）', async () => {
    render(<TraditionalView {...baseProps} />)
    // 顶栏全局搜索框：输入关键词回车进入搜索页（2026-10-08 起搜索框常驻顶栏，不再有搜索按钮）
    fireEvent.change(screen.getByLabelText('搜索歌手、歌曲或专辑'), { target: { value: '周杰伦' } })
    fireEvent.submit(screen.getByTestId('traditional-top-search'))
    await waitFor(() => expect(screen.getByPlaceholderText(/在网易云音乐中搜索/)).toBeTruthy())
  })

  it('非复刻平台（Spotify）音乐库页仍显示个性化推荐', async () => {
    // Apple 自 2026-10-08 起也走客户端复刻左栏/页面（见 test/ApplePcTraditional.test.tsx），
    // 这里改用仍走通用左栏的 Spotify 验证「非复刻平台保留原生音乐库页」。
    localStorage.setItem('waveforge:platform', 'spotify')
    render(<TraditionalView {...baseProps} />)
    fireEvent.click(await screen.findByRole('button', { name: '音乐库' }))
    await waitFor(() => expect(screen.getByText(/专属音乐库|量身推荐|热门音乐推荐/)).toBeTruthy())
    expect(screen.getAllByText(/每日推荐|热门推荐/).length).toBeGreaterThan(0)
  })

  it('网易云左栏按官方分组显示 创建的歌单/收藏的歌单 与新建入口', async () => {
    render(<TraditionalView {...baseProps} />)
    await waitFor(() => expect(screen.getByText('我的歌单一')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText(/^创建的歌单/)).toBeTruthy()
    expect(screen.getAllByText('收藏的歌单').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('新建歌单')).toBeTruthy()
  })

  it('左上角后退/前进箭头支持页面历史导航', async () => {
    render(<TraditionalView {...baseProps} />)
    // 初始在首页：后退禁用
    const back = screen.getByLabelText('后退')
    expect((back as HTMLButtonElement).disabled).toBe(true)
    // 顶栏搜索框搜一下 → 进入搜索页 → 后退可用
    fireEvent.change(screen.getByLabelText('搜索歌手、歌曲或专辑'), { target: { value: '周杰伦' } })
    fireEvent.submit(screen.getByTestId('traditional-top-search'))
    await waitFor(() => expect(screen.getByPlaceholderText(/在网易云音乐中搜索/)).toBeTruthy())
    fireEvent.click(back)
    await waitFor(() => expect(screen.getByTestId('traditional-top-search')).toBeTruthy())
    // 搜索页被冻结保留（不卸载），但已经隐藏、不再可见/可交互
    expect(isHiddenPane(screen.getByPlaceholderText(/在网易云音乐中搜索/))).toBe(true)
    // 前进回到搜索页
    fireEvent.click(screen.getByLabelText('前进'))
    await waitFor(() => expect(isHiddenPane(screen.getByPlaceholderText(/在网易云音乐中搜索/))).toBe(false))
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

  it('顶部模式入口支持键盘聚焦并打开选择面板', async () => {
    render(<TraditionalView {...baseProps} />)
    const trigger = screen.getByLabelText('顶部悬停切换模式区域')
    fireEvent.focus(trigger)
    const button = await screen.findByLabelText('打开模式选择')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await waitFor(() => expect(screen.getByText('模式选择')).toBeTruthy())
    expect(button).toBeTruthy()
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

  it('独立搜索组件：输入关键词只触发一次防抖搜索', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 200, result: { songs: [{ id: 9, name: '搜索结果歌', artists: [{ name: '歌手C' }], album: { name: '专辑C', picUrl: '' }, duration: 200000 }] } }),
    }))
    globalThis.fetch = fetchMock as any
    render(<TraditionalSearch platform="netease" accent="#ec4899" isDark currentSong={null} onBack={() => undefined} onSongSelect={vi.fn()} onOpenPlaylist={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/搜索 网易云/), { target: { value: '周杰伦' } })
    await waitFor(() => expect(screen.getByText('搜索结果歌')).toBeTruthy(), { timeout: 3000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('汽水搜索隐藏当前不支持的歌单标签', () => {
    render(<TraditionalSearch platform="soda" accent="#38bdf8" isDark currentSong={null} onBack={() => undefined} onSongSelect={vi.fn()} onOpenPlaylist={vi.fn()} />)
    expect(screen.queryByRole('button', { name: '歌单' })).toBeNull()
  })

  it('搜索结果行支持 Space 键播放', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ code: 200, result: { songs: [{ id: 10, name: '键盘歌曲', artists: [{ name: '歌手' }], album: { name: '专辑', picUrl: '' }, duration: 1000, platform: 'netease' }] } }),
    })) as any
    const onSongSelect = vi.fn()
    render(<TraditionalSearch platform="netease" accent="#ec4899" isDark currentSong={null} onBack={() => undefined} onSongSelect={onSongSelect} onOpenPlaylist={vi.fn()} />)
    fireEvent.change(screen.getByPlaceholderText(/搜索 网易云/), { target: { value: '键盘' } })
    const row = await screen.findByRole('button', { name: /键盘歌曲/ })
    fireEvent.keyDown(row, { key: ' ' })
    expect(onSongSelect).toHaveBeenCalledTimes(1)
  })

  it('QQ 评论使用 QQ cookie 且加载更多递增页码', async () => {
    localStorage.setItem('qq_cookie', 'qq-auth-cookie')
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: 0, data: { comments: [{ rootcommentid: `c${fetchMock.mock.calls.length}`, rootcommentcontent: 'QQ评论', nick: 'QQ用户', time: 1700000000 }], hotComments: [], hasMore: fetchMock.mock.calls.length === 1 } }),
    }))
    globalThis.fetch = fetchMock as any
    const song = { id: 12, mid: 'qq-mid', name: 'QQ歌曲', artists: [{ name: '歌手' }], album: { name: '专辑', picUrl: '' }, duration: 1000, platform: 'qq' as const }
    render(<TraditionalComments song={song} accent="#22c55e" isDark onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText('加载更多')).toBeTruthy())
    expect(String(fetchMock.mock.calls[0][0])).toContain('pagenum=0')
    expect(String(fetchMock.mock.calls[0][0])).toContain('qq-auth-cookie')
    fireEvent.click(screen.getByText('加载更多'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1][0])).toContain('pagenum=1')
  })

  it('恢复 traditional-search 来源并由 TV back 返回首页', async () => {
    render(<TraditionalView {...baseProps} restorePlaybackOrigin={{ revision: 1, mode: 'traditional', surface: 'traditional-search', platform: 'netease' }} />)
    await waitFor(() => expect(screen.getByPlaceholderText(/在网易云音乐中搜索/)).toBeTruthy())
    expect(dispatchTvBack()).toBe(true)
    // 冻结语义：搜索页保留在 DOM 但已隐藏
    await waitFor(() => expect(isHiddenPane(screen.getByPlaceholderText(/在网易云音乐中搜索/))).toBe(true))
  })

  it('旧偏好中的关闭推荐不影响客户端推荐页渲染', async () => {
    localStorage.setItem('waveforge:traditional-preferences:v2', JSON.stringify({ showRecommendations: false, density: 'compact', sidebarWidth: 'narrow' }))
    render(<TraditionalView {...baseProps} />)
    // 复刻页的快捷卡与区块不受旧「关闭推荐」偏好影响
    await waitFor(() => expect(screen.getByText('每日推荐')).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText('私人漫游')).toBeTruthy()
    expect(screen.getByText('音乐播客')).toBeTruthy()
  })

  it('英文歌词水平排版，日文假名歌词竖排', () => {
    const { rerender } = render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} lyrics={[{ time: 0, text: 'Read these lyrics clearly' }]} />)
    fireEvent.click(screen.getByRole('button', { name: '同步歌词' }))
    expect(screen.getByTestId('traditional-lyrics').getAttribute('data-layout')).toBe('horizontal')
    expect(screen.getByText('Read these lyrics clearly').style.writingMode).toBe('horizontal-tb')

    rerender(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} lyrics={[{ time: 0, text: '君のことが好きだよ' }]} />)
    expect(screen.getByTestId('traditional-lyrics').getAttribute('data-layout')).toBe('vertical')
    expect(screen.getByText('君のことが好きだよ').style.writingMode).toBe('vertical-rl')
  })

  it('QQ 左栏 自建歌单/收藏歌单 分别记忆滚动位置', async () => {
    localStorage.setItem('waveforge:platform', 'qq')
    render(<TraditionalView {...baseProps} qqLoggedIn qqUsername="QQ 用户" qqUserId="1" />)
    // QQ 左栏默认停在「收藏歌单」（与客户端一致），先切到自建歌单再验证两个列表各自记位置
    await waitFor(() => expect(screen.getByText('收藏的歌单')).toBeTruthy(), { timeout: 3000 })
    fireEvent.click(screen.getByText('自建歌单'))
    await waitFor(() => expect(screen.getByText('我的歌单一')).toBeTruthy())
    const scroller = screen.getByTestId('traditional-playlist-scroll')
    scroller.scrollTop = 135
    fireEvent.click(screen.getByText('收藏歌单'))
    expect(scroller.scrollTop).toBe(0)
    scroller.scrollTop = 48
    fireEvent.click(screen.getByText('自建歌单'))
    expect(scroller.scrollTop).toBe(135)
    fireEvent.click(screen.getByText('收藏歌单'))
    expect(scroller.scrollTop).toBe(48)
  })

  it('直播只显示播放暂停，不显示进度与前后曲', () => {
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} live isPlaying />)
    expect(screen.getByText('正在直播')).toBeTruthy()
    const nowPlaying = screen.getByRole('heading', { name: '正在播放' }).closest('section')
    expect(nowPlaying).toBeTruthy()
    const controls = within(nowPlaying as HTMLElement)
    expect(controls.queryByRole('slider', { name: '播放进度' })).toBeNull()
    expect(controls.queryByRole('button', { name: '上一首' })).toBeNull()
    expect(controls.queryByRole('button', { name: '下一首' })).toBeNull()
    expect(controls.getByRole('button', { name: '暂停' })).toBeTruthy()
  })

  it('播放进度支持键盘左右键 seek', () => {
    const onSeek = vi.fn()
    playbackSnapshot.currentTime = 40
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} duration={180} onSeek={onSeek} />)
    const progress = screen.getByRole('slider', { name: '播放进度' })
    expect(progress.getAttribute('tabindex')).toBe('0')
    fireEvent.keyDown(progress, { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenLastCalledWith(45)
    fireEvent.keyDown(progress, { key: 'ArrowLeft', shiftKey: true })
    expect(onSeek).toHaveBeenLastCalledWith(30)
    fireEvent.keyDown(progress, { key: 'Home' })
    expect(onSeek).toHaveBeenLastCalledWith(0)
    fireEvent.keyDown(progress, { key: 'End' })
    expect(onSeek).toHaveBeenLastCalledWith(180)
    fireEvent.keyDown(progress, { key: 'PageUp' })
    expect(onSeek).toHaveBeenLastCalledWith(70)
    fireEvent.keyDown(progress, { key: 'PageDown' })
    expect(onSeek).toHaveBeenLastCalledWith(10)
    playbackSnapshot.currentTime = 0
  })

  it('传统频谱使用稳定的大尺寸 Canvas，并在播放状态持续更新数据源', () => {
    const mutable = createMutableAnalyzerStore()
    const { rerender } = render(<TraditionalView {...baseProps} analyzerStore={mutable.store} currentSong={playingSong} queue={[playingSong]} isPlaying />)
    const spectrum = screen.getByTestId('traditional-spectrum')
    const canvas = spectrum.querySelector('canvas') as HTMLCanvasElement
    expect(canvas).toBeTruthy()
    expect(spectrum.className).toContain('min-h-28')
    expect(canvas.getAttribute('aria-label')).toBe('正在播放音频可视化')

    act(() => mutable.publish(new Array(24).fill(.65)))
    expect(screen.getByTestId('traditional-spectrum').querySelector('canvas')).toBe(canvas)
    act(() => mutable.publish(new Array(24).fill(.18)))
    expect(screen.getByTestId('traditional-spectrum').querySelector('canvas')).toBe(canvas)

    rerender(<TraditionalView {...baseProps} analyzerStore={mutable.store} currentSong={playingSong} queue={[playingSong]} isPlaying={false} />)
    expect(screen.getByTestId('traditional-spectrum').querySelector('canvas')).toBe(canvas)
  })

  it('播放工具药丸展开后，点击工具先关闭再执行', () => {
    const onPlayModeChange = vi.fn()
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} onPlayModeChange={onPlayModeChange} />)
    expect(screen.queryByTestId('traditional-tools-pill')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开播放工具' }))
    expect(screen.getByTestId('traditional-tools-pill')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '播放模式' }))
    expect(onPlayModeChange).toHaveBeenCalledTimes(1)
    return waitFor(() => expect(screen.queryByTestId('traditional-tools-pill')).toBeNull())
  })

  it('歌曲信息使用 onOpenPlayer 打开播放器并保留当前传统页面来源', async () => {
    const onOpenPlayer = vi.fn()
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} onOpenPlayer={onOpenPlayer} />)
    fireEvent.change(screen.getByLabelText('搜索歌手、歌曲或专辑'), { target: { value: '周杰伦' } })
    fireEvent.submit(screen.getByTestId('traditional-top-search'))
    await waitFor(() => expect(screen.getByPlaceholderText(/在网易云音乐中搜索/)).toBeTruthy())
    fireEvent.click(screen.getAllByTitle('进入播放页')[0])
    expect(onOpenPlayer).toHaveBeenCalledWith({ mode: 'traditional', surface: 'traditional-search', platform: 'netease' })
  })

  it('右栏队列切歌保留当前传统页面来源（Apple 客户端资料库页）', async () => {
    const onSongSelect = vi.fn()
    const queuedSong = { ...playingSong, id: 89, name: '队列下一首' }
    localStorage.setItem('waveforge:platform', 'apple')
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong, queuedSong]} onSongSelect={onSongSelect} />)
    // Apple 现在用客户端复刻左栏：资料库 › 歌曲
    const sidebar = await screen.findByTestId('apple-pc-sidebar')
    fireEvent.click(within(sidebar).getByText('歌曲'))
    await waitFor(() => expect(screen.getByText(/登录 Apple Music 后可查看「歌曲」/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /队列下一首/ }))
    expect(onSongSelect).toHaveBeenCalledWith(queuedSong, [playingSong, queuedSong], { mode: 'traditional', surface: 'traditional-library', platform: 'apple' })
  })

  it('主播放按钮提供语义并为浅色封面选择可读图标色', () => {
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} dominantColor="#fff4b0" />)
    const buttons = screen.getAllByRole('button', { name: '播放' }) as HTMLButtonElement[]
    expect(buttons.length).toBeGreaterThan(0)
    expect(contrastRatio(buttons[0].style.color, '#fff4b0')).toBeGreaterThanOrEqual(4.5)
  })

  it('顶部模式入口暴露展开状态和关联面板', async () => {
    render(<TraditionalView {...baseProps} />)
    const trigger = screen.getByLabelText('顶部悬停切换模式区域')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.getAttribute('aria-controls')).toBe('traditional-mode-selection-panel')
    fireEvent.keyDown(trigger, { key: 'Enter' })
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'))
  })

  it('传统偏好连续调整会合并持久化和通知', async () => {
    vi.useFakeTimers()
    const eventSpy = vi.fn()
    window.addEventListener('traditionalPreferencesChanged', eventSpy)
    try {
      render(<TraditionalView {...baseProps} />)
      fireEvent.click(screen.getByRole('button', { name: '设置' }))
      fireEvent.click(screen.getByRole('button', { name: '传统自定义' }))
      const slider = screen.getByRole('slider', { name: '背景模糊' })
      fireEvent.change(slider, { target: { value: '8' } })
      fireEvent.change(slider, { target: { value: '12' } })
      fireEvent.change(slider, { target: { value: '16' } })
      expect(eventSpy).not.toHaveBeenCalled()
      await act(async () => { vi.advanceTimersByTime(120) })
      expect(eventSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(localStorage.getItem('waveforge:traditional-preferences:v2') || '{}').backgroundBlur).toBe(16)
    } finally {
      window.removeEventListener('traditionalPreferencesChanged', eventSpy)
      vi.useRealTimers()
    }
  })

  it('QQ 平台首页按客户端原生推荐流渲染 Hero 卡（不是聚合数据）', async () => {
    render(<TraditionalView {...baseProps} />)
    fireEvent.click(screen.getByText('QQ音乐'))
    // 主推大卡 + 彩色功能卡都来自 QQ 客户端自己的推荐流。
    // 卡面大字与卡下栏目标签都会出现「猜你喜欢」（官方卡下同样是「猜你喜欢-沉浸刷歌」），
    // 因此这里断言「至少出现一次」而不是唯一匹配。
    await waitFor(() => expect(screen.getAllByText('猜你喜欢').length).toBeGreaterThan(0), { timeout: 4000 })
    // 标签用 feed 自带的官方名（layerTitle），说明行用真实副标题 + 歌单中文名
    expect(screen.getByText('Daily 30')).toBeTruthy()
    expect(screen.getByText(/イエナイ-花村想太/)).toBeTruthy()
    expect(screen.getByText('每日30首')).toBeTruthy()
    // 宝藏库区块由另一个数据源（songlist 接口）填充，与上面 waitFor 的 feed 是两条独立
    // 异步链，必须各自等待，不能同步断言。
    await waitFor(() => expect(screen.getByText('你的歌单宝藏库')).toBeTruthy(), { timeout: 4000 })
  })

  it('所有者歌单不应被判定为可收藏', () => {
    expect(isPlaylistOwner({ id: 's1', platform: 'soda', userId: 'u1' }, { sodaUserId: 'u1' })).toBe(true)
    expect(isPlaylistOwner({ id: 's1', platform: 'soda', userId: 'u1', isCollected: true }, { sodaUserId: 'u1' })).toBe(false)
  })

  it('进度条时间使用同一行并保持可访问滑块', () => {
    render(<TraditionalView {...baseProps} currentSong={playingSong} queue={[playingSong]} duration={180} />)
    const slider = screen.getByRole('slider', { name: '播放进度' })
    const timeRow = slider.parentElement?.querySelector('.tabular-nums')
    expect(timeRow?.textContent).toContain('0:00')
    expect(timeRow?.textContent).toContain('3:00')
  })
  it('Apple 所有权只接受明确标记，不按 p. 前缀猜测', () => {
    expect(isPlaylistOwner({ id: 'p.external', platform: 'apple' })).toBe(false)
    expect(isPlaylistOwner({ id: 'p.mine', platform: 'apple', ownedByMe: true })).toBe(true)
  })

  it('QQ 平台 PC 首页渲染歌单封面且无空 src 图片', async () => {
    const payload = { ...cannedHomePayload, playlists: [{ id: 'pl-empty', name: '无封面歌单', coverUrl: '', trackCount: 3, platform: 'qq' }] }
    vi.mocked(fetchExploreHome).mockResolvedValue(payload as any)
    render(<TraditionalView {...baseProps} />)
    fireEvent.click(screen.getByText('QQ音乐'))
    expect((await screen.findAllByLabelText('无封面歌单 封面占位')).length).toBeGreaterThan(0)
    expect(document.querySelector('img[src=""]')).toBeNull()
  })

  it('歌单错误状态提供重试操作', () => {
    const onRetry = vi.fn()
    render(<TraditionalPlaylistDetail playlist={{ id: 'p1', name: '失败歌单', platform: 'netease' }} songs={[]} loading={false} error="歌单加载失败，请重试" onRetry={onRetry} currentSong={null} playerTheme="dark" accentColor="#ec4899" onClose={vi.fn()} onSongSelect={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
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
