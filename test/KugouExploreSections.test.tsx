/** @vitest-environment jsdom */
/**
 * 酷狗探索页五板块渲染冒烟：推荐（五张大卡 + 今日专属推荐）/ 乐库 / 歌单 / 频道 / 分类。
 * 1) 填充数据时五个板块与官方卡片文案齐全；
 * 2) 上游全空（频道未订阅 / 标签不可用）时显示空态而不是崩溃或空白。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import KugouExploreSections, { KugouDiscoverBoard } from '../src/features/kugouExplore/KugouExploreSections'
import type { ExplorePayload } from '../src/services/exploreApi'
import type { Song } from '../src/services/musicApi'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

// 频道板块启动时会从本地服务拉电台分类（公开数据）：这里在 fetch 边界打桩，
// 让真实 service 代码路径参与测试，同时保证不触网、结果确定。
const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data }) as unknown as Response
const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/concept/radio/classes')) return jsonResponse({ success: true, data: [] })
  if (url.includes('/concept/radio/songs')) return jsonResponse({ success: true, tracks: [] })
  return jsonResponse({})
})
beforeEach(() => {
  fetchStub.mockClear()
  fetchStub.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/concept/radio/classes')) return jsonResponse({ success: true, data: [] })
    if (url.includes('/concept/radio/songs')) return jsonResponse({ success: true, tracks: [] })
    return jsonResponse({})
  })
  vi.stubGlobal('fetch', fetchStub)
})
afterEach(() => {
  vi.unstubAllGlobals()
  cleanup()
})

const makeSong = (name: string, mid: string): Song => ({
  id: Number(mid.slice(0, 4)) || 1,
  mid,
  name,
  artists: [{ name: '样例歌手' }],
  album: { name: '样例专辑', picUrl: 'https://example.test/cover.jpg' },
  duration: 200_000,
  platform: 'kugou',
})

const buildPayload = (filled: boolean): ExplorePayload => ({
  code: 0,
  platform: 'kugou',
  officialEnhanced: false,
  personalized: filled,
  dailySongs: filled ? [makeSong('每日推荐样例', 'AAAA1111'), makeSong('日推第二首', 'AAAA2222')] : [],
  radioSongs: [],
  newSongs: filled ? [makeSong('榜单新歌', 'BBBB1111')] : [],
  playlists: filled ? [{ id: '1001', name: '公开歌单', coverUrl: '', platform: 'kugou', playCount: 20_000 }] : [],
  charts: filled ? [{
    id: 'kg-8888',
    name: 'TOP500',
    group: '酷狗音乐',
    coverUrl: '',
    platform: 'kugou',
    songs: [{ name: '榜首歌曲', artist: '样例歌手', rank: 1 }],
  }] : [],
  albums: filled ? [{ id: 1, mid: 'a1', name: '样例专辑', artist: '样例歌手', coverUrl: '', platform: 'kugou' }] : [],
  channels: [],
  kugou: {
    dailySongs: filled ? [makeSong('每日推荐样例', 'AAAA1111'), makeSong('日推第二首', 'AAAA2222')] : [],
    dailyDate: '20261007',
    newSongs: filled ? [{ song: makeSong('我们在场', 'CCCC1111'), publishDate: '2026-10-02' }] : [],
    newSongsError: filled ? undefined : '新歌速递暂无返回',
    channels: [],
    channelError: filled ? undefined : '当前账号没有订阅频道',
    tagGroups: filled
      ? [{ id: '8', name: '风格', tags: [{ id: '9', name: '流行' }, { id: '32', name: '爵士' }] }]
      : [],
    tagError: filled ? undefined : '分类标签暂无返回',
    tagPlaylists: filled ? [{
      id: '4893706',
      conceptId: 'collection_3_1_38_0',
      name: '咖啡配爵士，开启最好的工作时光',
      coverUrl: '',
      playCount: 9_413_765,
      trackCount: 42,
      creator: '样例用户',
      tags: ['爵士', '英语'],
      platform: 'kugou',
      source: 'kugou-tag-playlist',
    }] : [],
    tagPlaylistsHasNext: false,
    tagPlaylistsError: filled ? undefined : '分类歌单暂无返回',
    yueku: filled
      ? {
        newAlbums: [{ id: 1, mid: 'yu1', name: '乐库新碟', artist: '样例歌手', coverUrl: '', platform: 'kugou' }],
        ranks: [{ rankid: '8888', rankname: 'TOP500', coverUrl: '' }],
        recommendPlaylists: [{
          id: '6409645',
          name: '今日专属歌单',
          coverUrl: '',
          playCount: 100_000,
          platform: 'kugou',
          source: 'kugou-tag-playlist',
        }],
      }
      : null,
    yuekuError: filled ? undefined : '乐库数据暂无返回',
    singers: filled ? [{ singerid: '3520', singername: '周杰伦', coverUrl: '', fansCount: 25_000_000 }] : [],
    singersError: filled ? undefined : '歌手目录暂无返回',
  },
  meta: { source: 'kugou-mobile-api', updatedAt: 0 },
})

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
  accent: '#FF7A00',
  accentRgb: '255, 122, 0',
  compactCards: false,
  showDescriptions: true,
  expandedHome: false,
  exploreCardBg: 'rgba(255,255,255,0.05)',
  showSubtitles: true,
  sectionStyle: () => ({}),
  sectionVisible: () => true,
}

describe('酷狗探索页五板块渲染', () => {
  it('推荐板块渲染五张官方大卡与今日专属推荐网格', () => {
    const payload = buildPayload(true)
    render(<KugouDiscoverBoard {...baseProps} payload={payload} />)
    ;['猜你喜欢', '每日推荐', '排行榜', '歌单广场', '歌手'].forEach(label => {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    })
    expect(screen.getByText('今日专属推荐')).not.toBeNull()
    expect(screen.getByText('今日专属歌单')).not.toBeNull()
  })

  it('乐库板块渲染新歌速递/新碟速递/歌手三行', () => {
    const payload = buildPayload(true)
    render(<KugouExploreSections {...baseProps} payload={payload} />)
    expect(screen.getByText('乐库')).not.toBeNull()
    expect(screen.getByText('新歌速递')).not.toBeNull()
    expect(screen.getByText('我们在场')).not.toBeNull()
    expect(screen.getByText('新碟速递')).not.toBeNull()
    expect(screen.getByText('周杰伦')).not.toBeNull()
  })

  it('歌单板块渲染分类标签与分类歌单，点标签触发筛选', () => {
    const payload = buildPayload(true)
    render(<KugouExploreSections {...baseProps} payload={payload} />)
    expect(screen.getByText('歌单')).not.toBeNull()
    expect(screen.getByText('咖啡配爵士，开启最好的工作时光')).not.toBeNull()
    // 标签出现在「歌单」板块与「分类」板块：点击分类里的「流行」芯片应触发一次筛选请求
    fireEvent.click(screen.getAllByRole('button', { name: '流行' })[0])
    expect(screen.getByText('歌单')).not.toBeNull()
  })

  it('频道板块：电台分类 + 电台卡渲染，点电台拉曲单开播', async () => {
    fetchStub.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/concept/radio/classes')) {
        return jsonResponse({
          success: true,
          data: [{
            classid: '10029',
            name: '晚上',
            stations: [{ fmid: '744', name: '健身房', coverUrl: '', fmtype: 2, currentSong: { name: '样例直播曲' } }],
          }],
        })
      }
      if (url.includes('/concept/radio/songs')) {
        return jsonResponse({ success: true, tracks: [{ hash: 'aaaa1111bbbb2222cccc3333dddd4444', songName: '开播曲', singerName: '样例歌手' }] })
      }
      return jsonResponse({})
    })
    const payload = buildPayload(true)
    render(<KugouExploreSections {...baseProps} payload={payload} />)
    expect(await screen.findByText('健身房')).not.toBeNull()
    expect(await screen.findByText('样例直播曲')).not.toBeNull()
    expect(screen.getByText('电台直播 · 分类切换（来自酷狗概念版）')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /健身房/ }))
    await waitFor(() => expect(handlers.onPlaySongs).toHaveBeenCalled())
  })

  it('频道为空时显示空态说明，而不是隐藏板块或空白', () => {
    const payload = buildPayload(false)
    render(<KugouExploreSections {...baseProps} payload={payload} />)
    expect(screen.getByText('电台列表暂时不可用')).not.toBeNull()
    expect(screen.getByText('分类标签暂时不可用')).not.toBeNull()
    expect(screen.getByText('新歌速递暂时没有返回内容')).not.toBeNull()
  })

  it('设置里隐藏的板块不渲染（尊重探索页偏好）', () => {
    const payload = buildPayload(true)
    const hidden = new Set(['discover', 'kugouLibrary', 'channels', 'kugouCategories'])
    render(
      <KugouExploreSections
        {...baseProps}
        sectionVisible={section => !hidden.has(section)}
        payload={payload}
      />,
    )
    expect(screen.queryByText('乐库')).toBeNull()
    expect(screen.queryByText('新歌速递')).toBeNull()
    expect(screen.queryByText('电台列表暂时不可用')).toBeNull()
    // 未隐藏的「歌单」板块仍在
    expect(screen.getByText('咖啡配爵士，开启最好的工作时光')).not.toBeNull()
  })

  it('播放新歌按钮把新歌队列交给播放处理器', () => {
    const payload = buildPayload(true)
    render(<KugouExploreSections {...baseProps} payload={payload} />)
    fireEvent.click(screen.getByRole('button', { name: /播放新歌/ }))
    expect(handlers.onPlaySongs).toHaveBeenCalledWith(expect.objectContaining({ name: '我们在场' }), expect.any(Array), false)
  })
})
