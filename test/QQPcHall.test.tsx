/** @vitest-environment jsdom */
// 乐馆（QQPcHall）页签数据源与交互冒烟：视频（二级页签：推荐=精选视频货架 / 视频库=分类+列表）、
// 排行（过滤上游打不开的 MV 榜）。数字专辑整页移除（付费商城，不做购买类内容）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import QQPcHall from '../src/features/traditionalPc/QQPcHall'

vi.mock('../src/features/qqExplore/api', () => ({
  fetchQQExploreBootstrap: vi.fn(async () => ({
    accountScoped: true,
    generatedAt: Date.now(),
    feed: { modules: [], loadMark: -1, hasMore: false, cursor: { page: 1, shelfCount: 0 } },
    daily30: null,
    musicHall: [
      {
        id: '127', title: '精选视频', style: 0, nicheStyle: 10002, serverOrder: 8,
        cards: [{
          id: '52695641', subId: '', type: 0, subtype: 0, style: 86, jumpType: 10012, nicheStyle: 10002,
          title: 'MV｜测试曲目', subtitle: '测试歌手', coverUrl: 'https://x/mv1.jpg', count: '',
          songs: [], action: { type: 'open-mv', mvId: '52695641' },
        }],
      },
    ],
  })),
  fetchQQRadarSongs: vi.fn(),
}))

vi.mock('../src/services/exploreApi', () => ({
  fetchExploreHome: vi.fn(async () => ({
    charts: [
      { id: '26', name: '热歌榜', group: '巅峰榜', coverUrl: 'https://x/c1.png', platform: 'qq', songs: [] },
      { id: '201', name: 'MV榜', group: '巅峰榜', coverUrl: 'https://x/c2.png', platform: 'qq', songs: [] },
    ],
  })),
  getExploreCookie: vi.fn(() => 'uin=1; qm_keyst=abc'),
}))

const mvCategoryPayload = {
  result: 100,
  data: {
    version: [{ id: 7, name: '全部' }, { id: 8, name: 'MV' }],
    area: [{ id: 15, name: '全部' }, { id: 16, name: '内地' }],
  },
}
const mvListPayload = {
  result: 100,
  data: {
    list: [{
      vid: '00testvid', mvid: 1, title: '测试 MV 标题', picurl: 'http://y.gtimg.cn/x.jpg', playcnt: 12345,
      singers: [{ name: '测试歌手' }], duration: 200, pubdate: 1,
    }],
  },
}

const mvChartPayload = {
  code: 200,
  chart: { id: 201, title: 'MV榜', coverUrl: 'https://x/chart.png', intro: '播放得分最高的官方MV', updateTips: '每10分钟更新', listenNum: 1450225, totalNum: 2 },
  items: [
    { rank: 1, vid: '002RRuBE035A2E', title: '异想天开', singer: '肖战', singerMid: '0022eAG537I1bg', coverUrl: 'https://x/mv-1.jpg' },
    { rank: 2, vid: '003jAGwa1Xo2Xe', title: 'I Like You', singer: '宋雨琦', singerMid: '', coverUrl: 'https://x/mv-2.jpg' },
  ],
}

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const json = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response
  if (url.includes('/qq/mv/chart')) return json(mvChartPayload)
  if (url.includes('/qq/mv/category')) return json(mvCategoryPayload)
  if (url.includes('/qq/mv/list')) return json(mvListPayload)
  if (url.includes('/qq/singer/category')) return json({ result: 100, data: { area: [], sex: [], index: [] } })
  if (url.includes('/qq/songlist/category')) return json({ result: 100, data: [] })
  if (url.includes('/qq/radio/channels')) return json({ code: 200, groups: [] })
  if (url.includes('/qq/banner')) return json({ banners: [] })
  return json({})
})

const actions = {
  onPlaySongs: vi.fn(),
  onSongMenu: vi.fn(),
  onOpenPlaylist: vi.fn(),
  onNavigate: vi.fn(),
  onOpenAlbum: vi.fn(),
  onOpenMv: vi.fn(),
  onOpenChart: vi.fn(),
}

const baseProps = {
  chrome: { tone: 'light' as const, skin: 'qq' as const, accent: '#31c27c' },
  account: { loggedIn: true, username: '测试用户', userId: '1' },
  actions,
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  Object.values(actions).forEach(fn => fn.mockClear())
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

const hallTab = (label: string) => screen.getAllByRole('button', { name: label })[0]

describe('QQ 乐馆', () => {
  it('视频页：推荐用精选视频货架（点击播 MV），视频库走分类 + MV 列表', async () => {
    render(<QQPcHall {...baseProps} />)
    fireEvent.click(hallTab('视频'))
    // 推荐：来自 musicHall 的精选视频货架
    const curated = await screen.findByText('MV｜测试曲目')
    fireEvent.click(curated)
    expect(actions.onOpenMv).toHaveBeenCalledWith('52695641', 'qq')

    // 视频库：分类筛选 + mv/list 网格
    fireEvent.click(screen.getByRole('button', { name: '视频库' }))
    const mv = await screen.findByText('测试 MV 标题')
    expect(screen.getByText('测试歌手')).toBeTruthy()
    fireEvent.click(mv)
    expect(actions.onOpenMv).toHaveBeenCalledWith('00testvid', 'qq')
  })

  it('视频排行榜：MV 榜头图 + 名次列表，点击播 MV', async () => {
    render(<QQPcHall {...baseProps} />)
    fireEvent.click(hallTab('视频'))
    fireEvent.click(screen.getByRole('button', { name: '排行榜' }))
    // 榜单头图/标题来自 /qq/mv/chart
    expect(await screen.findByText('MV榜')).toBeTruthy()
    const first = await screen.findByText('异想天开')
    expect(screen.getByText('肖战')).toBeTruthy()
    fireEvent.click(first)
    expect(actions.onOpenMv).toHaveBeenCalledWith('002RRuBE035A2E', 'qq')
  })

  it('排行榜目录过滤掉上游打不开的 MV 榜', async () => {
    render(<QQPcHall {...baseProps} />)
    fireEvent.click(hallTab('排行'))
    await screen.findByText('热歌榜')
    expect(screen.queryByText('MV榜')).toBeNull()
    fireEvent.click(screen.getByText('热歌榜'))
    expect(actions.onOpenChart).toHaveBeenCalled()
  })

  it('不再提供数字专辑页签（付费商城，不做购买）', () => {
    render(<QQPcHall {...baseProps} />)
    expect(screen.queryByRole('button', { name: '数字专辑' })).toBeNull()
  })
})
