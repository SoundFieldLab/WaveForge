/** @vitest-environment jsdom */
// QQ 传统模式首页冒烟：Hero 行必须与官方客户端一致——
// 主推大卡后接**服务器顺序前 4 张 style 202 卡**（每日30首 / 刷歌模式 / 百万收藏 / 新歌推荐），
// 不能把 202/900/991 的刷歌卡漏掉、也不能让第 5 张「歌手漫游」挤进来。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import QQPcHome from '../src/features/traditionalPc/QQPcHome'
import { fetchQQExploreBootstrap } from '../src/features/qqExplore/api'

const heroCards = [
  { id: '992', feedKey: 'a', type: 700, subtype: 712, style: 203, title: 'YoShiNo', subtitle: '', coverUrl: '', songs: [], action: { type: 'open-external', url: 'https://i2.y.qq.com/x' } },
  { id: '99', feedKey: 'b', type: 700, subtype: 711, style: 201, title: '猜你喜欢', subtitle: '', coverUrl: '', songs: [], action: { type: 'play-radio', radioId: 99 } },
  { id: '5643607054', feedKey: 'c', type: 500, subtype: 510, style: 202, title: '每日30首', subtitle: 'To The First-SKY-HI', coverUrl: 'https://x/d30.png', songs: [], action: { type: 'open-playlist', playlistId: '5643607054' } },
  { id: '22000', feedKey: 'd', type: 900, subtype: 991, style: 202, title: '雷达模式', subtitle: "Don't Waste My Time-NOA", coverUrl: 'https://x/radar.png', songs: [], action: { type: 'play-radar', page: 1, reqType: 0, entranceSongs: [] } },
  { id: '211111', feedKey: 'e', type: 500, subtype: 513, style: 202, title: '百万收藏', subtitle: 'Ghost-Au/Ra', coverUrl: 'https://x/m.png', songs: [], action: { type: 'open-playlist', playlistId: '211111' } },
  { id: '211207', feedKey: 'f', type: 500, subtype: 513, style: 202, title: '新歌推荐', subtitle: 'Журавли-Клава Кока', coverUrl: 'https://x/new.png', songs: [], action: { type: 'open-playlist', playlistId: '211207' } },
  { id: '211192', feedKey: 'g', type: 500, subtype: 513, style: 202, title: '歌手漫游', subtitle: 'KONTINUUM-SennaRin', coverUrl: 'https://x/roam.png', songs: [], action: { type: 'open-playlist', playlistId: '211192' } },
  { id: '1001', feedKey: 'h', type: 900, subtype: 11, style: 209, title: '自定义', subtitle: '', coverUrl: '', songs: [], action: { type: 'open-preferences' } },
]

const radarSongs = [
  { id: 1, name: '雷达第一首', artists: [{ name: '歌手R' }], album: { name: '专辑R', picUrl: '' }, duration: 200000, platform: 'qq' },
]

vi.mock('../src/features/qqExplore/api', () => ({
  fetchQQExploreBootstrap: vi.fn(async () => ({
    accountScoped: true,
    generatedAt: Date.now(),
    feed: {
      loadMark: 1, hasMore: false, cursor: { page: 2, shelfCount: 1 },
      modules: [{ id: 'hi', instanceId: 'hi', title: 'Hi 测试 今日为你推荐', style: 2, source: 'qq-native-recommend-feed', refresh: null, cards: heroCards }],
    },
    daily30: { playlistId: '5643607054', title: '每日30首', coverUrl: '', dateKey: '2026-10-07', songs: [] },
    musicHall: [],
  })),
  fetchQQExploreFeed: vi.fn(async () => ({ modules: [], loadMark: -1, hasMore: false, cursor: { page: 3, shelfCount: 1 } })),
  fetchQQRadarSongs: vi.fn(async () => ({ songs: radarSongs, hasMore: true, page: 2 })),
}))

vi.mock('../src/services/exploreApi', () => ({
  // 首页预取走带文案的批次：songs + radio（电台名 + 逐曲推荐模板）
  fetchQQGuessYouLikeBatchWithMeta: vi.fn(async () => ({
    songs: [],
    radio: { name: '猜你喜欢', reasons: [{ mid: 'm1', reason: '根据你的听歌口味推荐', template: '把耳机分给月亮， {br}用音乐涂鸦夜空。' }] },
  })),
  fetchExploreRecommendationBatch: vi.fn(async () => []),
  getExploreCookie: vi.fn(() => 'uin=1; qm_keyst=abc'),
}))

const actions = {
  onPlaySongs: vi.fn(),
  onSongMenu: vi.fn(),
  onOpenPlaylist: vi.fn(),
  onNavigate: vi.fn(),
  onOpenAlbum: vi.fn(),
  onOpenMv: vi.fn(),
  onOpenChart: vi.fn(),
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response))
  Object.values(actions).forEach(fn => fn.mockClear())
})
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
  cleanup()
})

describe('QQ 首页 Hero 行', () => {
  it('彩色卡 = 服务器顺序前 4 张 202 卡（含刷歌模式，不含第 5 张歌手漫游）', async () => {
    render(<QQPcHome payload={null} account={{ loggedIn: true, username: '测试', userId: '1' }} actions={actions} />)
    // 前三张与官方一致
    expect(await screen.findByText('Daily 30')).toBeTruthy()
    expect(screen.getAllByText('刷歌模式').length).toBeGreaterThan(0)
    expect(screen.getAllByText('百万收藏').length).toBeGreaterThan(0)
    expect(screen.getAllByText('新歌推荐').length).toBeGreaterThan(0)
    // 第 5 张不进这一行
    expect(screen.queryByText('歌手漫游')).toBeNull()
  })

  it('刷歌模式卡点击走雷达（GetRadarSong）并起播', async () => {
    render(<QQPcHome payload={null} account={{ loggedIn: true, username: '测试', userId: '1' }} actions={actions} />)
    const radarCard = (await screen.findAllByText('刷歌模式'))[0].closest('button')
    expect(radarCard).toBeTruthy()
    fireEvent.click(radarCard as HTMLButtonElement)
    await waitFor(() => expect(actions.onPlaySongs).toHaveBeenCalled())
    expect(actions.onPlaySongs.mock.calls[0][0].name).toBe('雷达第一首')
  })
})

describe('QQ 首页首屏加载体验', () => {
  it('bootstrap 未返回时先渲染骨架卡行（不再是整行空白）', () => {
    vi.mocked(fetchQQExploreBootstrap).mockImplementationOnce(() => new Promise(() => {}) as never)
    render(<QQPcHome payload={null} account={{ loggedIn: true, username: '测试', userId: '1' }} actions={actions} />)
    expect(screen.getByLabelText('正在加载推荐')).toBeTruthy()
  })

  it('命中首屏缓存时同步渲染卡行（stale-while-revalidate，不等网络）', () => {
    sessionStorage.setItem('waveforge:qq-home-feed:v1', JSON.stringify({
      at: Date.now(),
      account: '1',
      modules: [{ id: 'hi', instanceId: 'hi', title: 'Hi 测试 今日为你推荐', cards: heroCards }],
      cursor: null,
      daily30: { playlistId: '5643607054', title: '每日30首', coverUrl: '', dateKey: '2026-10-07', songs: [] },
    }))
    // 网络永不返回：首屏必须完全由缓存渲染
    vi.mocked(fetchQQExploreBootstrap).mockImplementationOnce(() => new Promise(() => {}) as never)
    render(<QQPcHome payload={null} account={{ loggedIn: true, username: '测试', userId: '1' }} actions={actions} />)
    expect(screen.getByText('Daily 30')).toBeTruthy()
    expect(screen.getAllByText('刷歌模式').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText('正在加载推荐')).toBeNull()
  })

  it('缓存账号不匹配时不复用（换账号不得看到上一个账号的推荐）', () => {
    sessionStorage.setItem('waveforge:qq-home-feed:v1', JSON.stringify({
      at: Date.now(),
      account: 'other-user',
      modules: [{ id: 'hi', instanceId: 'hi', title: 'Hi 别人 今日为你推荐', cards: heroCards }],
      cursor: null,
      daily30: null,
    }))
    vi.mocked(fetchQQExploreBootstrap).mockImplementationOnce(() => new Promise(() => {}) as never)
    render(<QQPcHome payload={null} account={{ loggedIn: true, username: '测试', userId: '1' }} actions={actions} />)
    expect(screen.queryByText('Daily 30')).toBeNull()
    expect(screen.getByLabelText('正在加载推荐')).toBeTruthy()
  })
})
