// QQ 音乐 PC 客户端「乐馆」页（官方音乐馆货架的复刻）。
//
// 官方乐馆的顶部页签（2026-10 实测）：精选 / 排行 / 歌手 / 分类歌单 / 数字专辑 / 音质专区 /
// 边听边玩 / 视频 / 频道。本页实现的六类都有真实数据源：
//   · 精选：账号级聚合接口的 musicHall 货架（要登录 cookie，未登录整体空态，不编内容）；
//   · 排行：聚合接口 /api/explore/qq 透传的官方榜单目录（上游 top/category，带分组与前三首），
//     失败/为空时退回货架里 action=open-chart 的榜单卡；纯 MV 榜（点开上游 502）不列入，避免死链；
//   · 歌手：公开歌手列表接口 + singer/category 的地区/性别/字母筛选项（二级菜单），分页加载；
//   · 分类歌单：公开的歌单分类 + 分类歌单接口，分类胶囊为二级、歌单网格为三级；
//   · 视频：二级页签 推荐（musicHall「精选视频」货架）/ 视频库（mv/category 筛选 + mv/list 网格），
//     点击走全局 MV 播放器；
//   · 频道：官方电台广场的分类与频道位（服务端 /api/qq/radio/channels 解析官方页面 SSR 数据），
//     点击频道即从该频道拉一批歌开播（/api/qq/radio/songs，需要登录）。
// 未做：数字专辑（官方为付费商城，用户明确要求整页移除）、下列两类（网关里没有数据源，未编内容顶上）：
//   · 音质专区：客户端专有营销页；扫过 GET /GetHomePage 的 1~99 / 100~150 / 151~220 全部货架 id，
//     没有任何货架对应它（音乐馆只有「更多」货架里的杜比全景声/臻品母带文字入口，无 id 无封面）；
//   · 边听边玩：客户端专有互动页（H5 小游戏），同样没有可调用的网关接口。
// 星光 / 农场 / 直播 / 听书 在网关里同样没有对应数据源，整类不做（不留点了没反应的分类）。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { Play, RefreshCw, User } from 'lucide-react'
import { fetchExploreHome, getExploreCookie, type ExploreChart } from '../../services/exploreApi'
import { getApiBase } from '../../services/apiConfig'
import { openExternalLink } from '../../utils/externalLink'
import { fetchQQExploreBootstrap } from '../qqExplore/api'
import { isHiddenQQMusicHallShelf } from '../qqExplore/model'
import type { QQExploreAction, QQExploreSnapshot, QQMusicHallCard, QQMusicHallShelf } from '../qqExplore/model'
import type { Song } from '../../services/musicApi'
import {
  PcCardGrid, PcChips, PcCountBadge, PcCover, PcEmpty, PcGhostButton, PcIconButton,
  PcPageTitle, PcPrimaryButton, PcSectionTitle, pcCount, pcTheme, type PcTabItem,
} from './pcKit'
import type { PcAccount, PcActions } from './types'

export interface QQPcHallProps {
  chrome: { tone: 'light' | 'dark'; skin: 'qq'; accent: string }
  account: PcAccount
  actions: PcActions
  /** false（隐藏保活页）时不发任何请求 */
  active?: boolean
  /** 从侧栏功能位进来时直接落到对应页签（频道/视频/飙升榜/官方歌单 = channels/videos/charts/playlists）。 */
  initialTab?: HallTab
}

type HallTab = 'recommend' | 'charts' | 'artists' | 'playlists' | 'videos' | 'channels'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type MvSubTab = 'recommend' | 'charts' | 'library'

/**
 * 「最新发行」区域页签 = 上游 newalbum.NewAlbumServer/get_new_album_info 的 area 1~6
 * （2026-10-07 实测：area=2 内含内地与港台华语发行，官方客户端再拆「内地/港台」两档，
 * 接口层没有该拆分，故这一档如实标成「华语」而不是误标成内地或港台）。
 */
const NEW_ALBUM_AREAS: Array<{ area: number; label: string }> = [
  { area: 1, label: '最新' },
  { area: 2, label: '华语' },
  { area: 3, label: '欧美' },
  { area: 4, label: '韩国' },
  { area: 5, label: '日本' },
  { area: 6, label: '其他' },
]

/** 顶部分类：只列有数据源的六类（数字专辑=付费商城、音质专区=VIP 试用页、边听边玩=小游戏，均不做；星光/农场/直播/听书同理）。 */const HALL_TABS: PcTabItem[] = [
  { key: 'recommend', label: '精选' },
  { key: 'charts', label: '排行' },
  { key: 'artists', label: '歌手' },
  { key: 'playlists', label: '分类歌单' },
  { key: 'videos', label: '视频' },
  { key: 'channels', label: '频道' },
]

/** 视频页的二级页签（官方：推荐 / 排行榜 / 视频库）。 */
const MV_SUB_TABS: PcTabItem[] = [
  { key: 'recommend', label: '推荐' },
  { key: 'charts', label: '排行榜' },
  { key: 'library', label: '视频库' },
]

/** 父层未接线时的兜底：页面必须能独立渲染，不许因缺回调抛错。 */
const FALLBACK_ACTIONS: PcActions = {
  onPlaySongs: () => {},
  onSongMenu: () => {},
  onOpenPlaylist: () => {},
  onNavigate: () => {},
}

/** 歌手列表每页条数由上游固定为 80（singer/list 的 sin 步长），用来判断「还有下一页」。 */
const SINGER_PAGE_SIZE = 80
const MV_PAGE_SIZE = 20
const RADIO_SONG_COUNT = 30

interface QQSinger { mid: string; name: string; picUrl: string }
interface QQSquareCategory { id: number; name: string; group: string }
interface QQSquarePlaylist { id: string; name: string; coverUrl: string; playCount: number; trackCount?: number }
interface QQSingerFilterOption { id: number; name: string }
interface QQMvItem { vid: string; mvid: number; title: string; coverUrl: string; playCount: number; artist: string; duration: number; pubdate: number }
/** MV 榜（官方「视频 → 排行榜」的巅峰榜.MV）：条目是 MV，带名次与 vid。 */
interface QQMvChartItem { rank: number; vid: string; title: string; singer: string; singerMid: string; coverUrl: string }
interface QQMvChart { id: number; title: string; coverUrl: string; intro: string; updateTips: string; listenNum: number; totalNum: number }
interface QQRadioChannel { id: string; title: string; coverUrl: string; listenDesc: string; listenNum: number; listenNumText: string }
interface QQRadioGroup { id: string; title: string; channels: QQRadioChannel[] }

/* ------------------------------------------------------------------ *
 * 服务端返回解析（字段名有多套历史写法，这里逐层兜底，拿不到就少渲染）
 * ------------------------------------------------------------------ */

function parseQQSingers(payload: any): QQSinger[] {
  const raw = payload?.data?.list || payload?.data?.singers?.singerlist || payload?.data?.singerlist || []
  return (Array.isArray(raw) ? raw : []).map((item: any) => ({
    mid: String(item?.singer_mid || item?.mid || ''),
    name: String(item?.singer_name || item?.name || ''),
    // 歌手头像原样保留 .webp 后缀：实测（2026-09-28）去掉后缀 y.gtimg.cn 会直接 404，
    // 本地 /cover 代理会照常转发，前端 CachedImage 也能解码 webp
    picUrl: String(item?.singer_pic || item?.picUrl || ''),
  })).filter(item => item.mid && item.name)
}

/** 歌单分类：服务端按「分组 → 分类列表」两级返回，拍平成带 group 的一维列表。 */
function parseQQCategories(payload: any): QQSquareCategory[] {
  const groups = payload?.data
  const list: QQSquareCategory[] = []
  for (const group of Array.isArray(groups) ? groups : []) {
    for (const item of group?.list || []) {
      if (item?.id != null) list.push({ id: Number(item.id), name: String(item.name || ''), group: String(group?.type || '') })
    }
  }
  return list
}

function parseQQSquarePlaylists(payload: any): QQSquarePlaylist[] {
  const raw = payload?.data?.list || []
  return (Array.isArray(raw) ? raw : []).map((item: any) => ({
    id: String(item?.dissid || item?.id || ''),
    name: String(item?.dissname || item?.name || ''),
    coverUrl: String(item?.imgurl || item?.coverUrl || ''),
    playCount: Number(item?.listennum || item?.play_count || 0),
    trackCount: Number(item?.song_count || 0) || undefined,
  })).filter(item => item.id && item.name)
}

/** 歌手筛选标签：singer/category 返回 { area | sex | genre | index: [{id,name}] }。 */
function parseQQSingerFilters(payload: any): Record<'area' | 'sex' | 'genre' | 'index', QQSingerFilterOption[]> {
  const data = payload?.data || {}
  const normalize = (raw: any): QQSingerFilterOption[] => (Array.isArray(raw) ? raw : [])
    .map((item: any) => ({ id: Number(item?.id), name: String(item?.name || '') }))
    .filter(item => Number.isFinite(item.id) && item.name)
  return {
    area: normalize(data.area),
    sex: normalize(data.sex),
    genre: normalize(data.genre),
    index: normalize(data.index),
  }
}

function parseQQMvCategories(payload: any): { version: QQSingerFilterOption[]; area: QQSingerFilterOption[] } {
  const data = payload?.data || {}
  const normalize = (raw: any): QQSingerFilterOption[] => (Array.isArray(raw) ? raw : [])
    .map((item: any) => ({ id: Number(item?.id), name: String(item?.name || '') }))
    .filter(item => Number.isFinite(item.id) && item.name)
  return { version: normalize(data.version), area: normalize(data.area) }
}

function parseQQMvList(payload: any): QQMvItem[] {
  const raw = payload?.data?.list || payload?.list || []
  return (Array.isArray(raw) ? raw : []).map((item: any) => ({
    vid: String(item?.vid || ''),
    mvid: Number(item?.mvid || 0),
    title: String(item?.title || item?.name || ''),
    coverUrl: String(item?.picurl || item?.cover || '').replace(/^http:/, 'https:'),
    playCount: Number(item?.playcnt || item?.playCount || 0),
    artist: (Array.isArray(item?.singers) ? item.singers : []).map((singer: any) => String(singer?.name || '')).filter(Boolean).join(' / '),
    duration: Number(item?.duration || 0),
    pubdate: Number(item?.pubdate || 0),
  })).filter(item => item.vid && item.title)
}

function parseQQRadioGroups(payload: any): QQRadioGroup[] {
  const groups = payload?.groups
  if (!Array.isArray(groups)) return []
  return groups.map((group: any) => ({
    id: String(group?.id || ''),
    title: String(group?.title || ''),
    channels: (Array.isArray(group?.channels) ? group.channels : []).map((channel: any) => ({
      id: String(channel?.id || ''),
      title: String(channel?.title || ''),
      coverUrl: String(channel?.coverUrl || ''),
      listenDesc: String(channel?.listenDesc || ''),
      listenNum: Number(channel?.listenNum || 0),
      listenNumText: String(channel?.listenNumText || ''),
    })).filter((channel: QQRadioChannel) => channel.id && channel.title),
  })).filter(group => group.title && group.channels.length)
}

/* ------------------------------------------------------------------ *
 * 货架卡片：副标题 / 角标 / 点击行为
 * ------------------------------------------------------------------ */

/** count 是纯数字才交给角标（pcCount 会转成 万/亿）；是「1.2万」这类文案就原样并进副标题。 */
function hallCardCount(card: QQMusicHallCard): number | undefined {
  const count = (card.count || '').trim()
  return /^\d+$/.test(count) ? Number(count) : undefined
}

function hallCardSubtitle(card: QQMusicHallCard): string {
  const subtitle = (card.subtitle || '').trim()
  const count = (card.count || '').trim()
  if (!count || /^\d+$/.test(count)) return subtitle
  return subtitle ? `${subtitle} · ${count}` : count
}

/**
 * 货架卡片 → 可打开的歌单对象（与探索页 executeMusicHallCard 同口径）。
 * 为什么不用 model.qqCardPlaylist：它的入参是「探索 feed 卡」类型（QQExploreCard 要求 feedKey 等字段），
 * 货架卡片类型缺这些字段，类型不通；这里按同样的字段口径构造一次。
 */
function hallPlaylist(card: QQMusicHallCard) {
  return {
    id: card.action.type === 'open-playlist' ? card.action.playlistId : card.id,
    name: card.title || 'QQ 音乐歌单',
    description: card.subtitle || '',
    coverUrl: card.coverUrl || '',
    platform: 'qq' as const,
    source: 'qq-native-music-hall',
  }
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

function QQPcHall({ chrome, account, actions, active = true, initialTab }: QQPcHallProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const act = actions || FALLBACK_ACTIONS
  const loggedIn = Boolean(account?.loggedIn)
  const userId = account?.userId || ''

  const [tab, setTab] = useState<HallTab>(initialTab && HALL_TABS.some(item => item.key === initialTab) ? initialTab : 'recommend')
  /** 视频页二级页签：推荐（精选视频货架）/ 视频库（类型+地区筛选的完整列表）。 */  const [mvSubTab, setMvSubTab] = useState<MvSubTab>('recommend')
  /** 刷新令牌：+1 会让所有「已加载键」失效，从而只重取当前需要的几路数据。 */
  const [revision, setRevision] = useState(0)
  const [notice, setNotice] = useState('')

  // 精选：轮播（公开接口）+ 推荐 / 排行共用的账号级货架快照
  // 精选顶部首发 banner：来自 musicHall 的「首发」货架（服务端 /qq/hall/banners 按 ShelfId 115/116/1 取）
  const [banners, setBanners] = useState<Array<{ id: string; title: string; subtitle: string; coverUrl: string; songs: Song[]; action: QQExploreAction }>>([])
  const [bannerIndex, setBannerIndex] = useState(0)
  // 精选「官方歌单」货架：playlist.HotRecommendServer/get_hot_recommend（编辑推荐）
  const [officialPlaylists, setOfficialPlaylists] = useState<Array<{ id: string; name: string; coverUrl: string; playCount: number; creator: string }>>([])
  // 最新发行：官方这一行带区域页签（上游 newalbum.NewAlbumServer 的 area 1~6，
  // 实测 1=最新 2=华语（内地+港台混排）3=欧美 4=韩国 5=日本 6=其他）+ 右侧「更多」展开
  const [newAlbums, setNewAlbums] = useState<Array<{ id: string; mid: string; name: string; singer: string; coverUrl: string }>>([])
  const [newAlbumArea, setNewAlbumArea] = useState(1)
  const [newAlbumExpanded, setNewAlbumExpanded] = useState(false)
  const [newAlbumLoading, setNewAlbumLoading] = useState(false)
  const bannerKeyRef = useRef('')
  const [snapshot, setSnapshot] = useState<QQExploreSnapshot | null>(null)
  const [snapshotState, setSnapshotState] = useState<LoadState>('idle')
  const [snapshotError, setSnapshotError] = useState('')
  const snapshotKeyRef = useRef('')

  // 排行：官方榜单目录（聚合接口 /api/explore/qq 的 charts 字段，上游来自 top/category 全量榜单）
  const [directoryCharts, setDirectoryCharts] = useState<ExploreChart[]>([])
  const [directoryState, setDirectoryState] = useState<LoadState>('idle')
  const directoryKeyRef = useRef('')

  // 歌手
  const [singers, setSingers] = useState<QQSinger[]>([])
  const [singerState, setSingerState] = useState<LoadState>('idle')
  const [singerLoadingMore, setSingerLoadingMore] = useState(false)
  const [singerHasMore, setSingerHasMore] = useState(false)
  const [singerFilters, setSingerFilters] = useState<Record<'area' | 'sex' | 'genre' | 'index', QQSingerFilterOption[]> | null>(null)
  const [singerArea, setSingerArea] = useState(-100)
  const [singerSex, setSingerSex] = useState(-100)
  const [singerIndex, setSingerIndex] = useState(-100)
  /** 风格筛选（官方歌手页第三个下拉：全部/流行/说唱/国风/摇滚/电子…，值来自 singer/category 的 genre）。 */
  const [singerGenre, setSingerGenre] = useState(-100)
  const singerPageRef = useRef(1)
  const singerKeyRef = useRef('')
  const singerAbortRef = useRef<AbortController | null>(null)
  const singerFilterKeyRef = useRef('')

  // 歌单分类 / 分类歌单
  const [categories, setCategories] = useState<QQSquareCategory[]>([])
  const [activeCategory, setActiveCategory] = useState<number | null>(null)
  const [squarePlaylists, setSquarePlaylists] = useState<QQSquarePlaylist[]>([])
  const [squareState, setSquareState] = useState<LoadState>('idle')
  const [squareLoadingMore, setSquareLoadingMore] = useState(false)
  const [squareHasMore, setSquareHasMore] = useState(false)
  const squarePageRef = useRef(1)
  const categoryKeyRef = useRef('')
  const squareKeyRef = useRef('')
  const squareAbortRef = useRef<AbortController | null>(null)

  // 视频：mv/category 二级筛选 + mv/list 网格
  const [mvCategories, setMvCategories] = useState<{ version: QQSingerFilterOption[]; area: QQSingerFilterOption[] } | null>(null)
  const [mvVersion, setMvVersion] = useState(7)
  const [mvArea, setMvArea] = useState(15)
  const [mvList, setMvList] = useState<QQMvItem[]>([])
  const [mvState, setMvState] = useState<LoadState>('idle')
  const [mvLoadingMore, setMvLoadingMore] = useState(false)
  const [mvHasMore, setMvHasMore] = useState(false)
  // MV 榜（排行榜子页签）：与「推荐」的热门区共用同一份数据
  const [mvChart, setMvChart] = useState<QQMvChart | null>(null)
  const [mvChartItems, setMvChartItems] = useState<QQMvChartItem[]>([])
  const [mvChartState, setMvChartState] = useState<LoadState>('idle')
  const mvChartKeyRef = useRef('')
  // 视频「推荐」顶部 banner（官方首发 MV 资讯轮播，GetHomePage ShelfId 127）
  const [videoBanners, setVideoBanners] = useState<Array<{ id: string; title: string; subtitle: string; coverUrl: string; mvId: string }>>([])
  const [videoBannerIndex, setVideoBannerIndex] = useState(0)
  const videoBannerKeyRef = useRef('')
  const mvPageRef = useRef(1)
  const mvCategoryKeyRef = useRef('')
  const mvListKeyRef = useRef('')
  const mvAbortRef = useRef<AbortController | null>(null)

  // 频道：官方电台广场分类（二级）+ 频道位（三级：点击直接开播该频道）
  const [radioGroups, setRadioGroups] = useState<QQRadioGroup[]>([])
  const [radioState, setRadioState] = useState<LoadState>('idle')
  const [activeRadioGroup, setActiveRadioGroup] = useState('')
  const [radioPlayingId, setRadioPlayingId] = useState('')
  const radioKeyRef = useRef('')
  const radioAbortRef = useRef<AbortController | null>(null)

  useEffect(() => () => singerAbortRef.current?.abort(), [])

  /* ── 精选：顶部轮播（公开接口；与官方一样每页三张、可点开 H5） ── */
  const bannerKey = `banners:${revision}`
  useEffect(() => {
    if (!active || tab !== 'recommend') return
    if (bannerKeyRef.current === bannerKey) return
    bannerKeyRef.current = bannerKey
    const controller = new AbortController()
    const cookie = getExploreCookie('qq')
    void Promise.allSettled([
      fetch(`${getApiBase()}/qq/hall/banners?cookie=${encodeURIComponent(cookie)}`, { signal: controller.signal, cache: 'no-store' }).then(r => r.json()),
      fetch(`${getApiBase()}/qq/hall/official-playlists?num=12&cookie=${encodeURIComponent(cookie)}`, { signal: controller.signal, cache: 'no-store' }).then(r => r.json()),
    ]).then(([bannerResult, playlistResult]) => {
      if (controller.signal.aborted) return
      const bannerList = bannerResult.status === 'fulfilled' && Array.isArray(bannerResult.value?.banners) ? bannerResult.value.banners : []
      setBanners(bannerList.map((item: any) => ({
        id: String(item?.id || ''),
        title: String(item?.title || ''),
        subtitle: String(item?.subtitle || ''),
        coverUrl: String(item?.coverUrl || ''),
        songs: Array.isArray(item?.songs) ? item.songs : [],
        action: item?.action || { type: 'unsupported' },
      }))
        // 商城/预售类导流 banner（跳外链，如「实体画胶预售」）不展示：用户要求去掉卖货 banner
        .filter((item: { action: { type?: string } }) => item.action?.type !== 'open-external')
        .filter((item: { coverUrl: string; title: string }) => item.coverUrl && item.title))
      setBannerIndex(0)
      const playlistList = playlistResult.status === 'fulfilled' && Array.isArray(playlistResult.value?.playlists) ? playlistResult.value.playlists : []
      setOfficialPlaylists(playlistList.map((item: any) => ({
        id: String(item?.id || ''),
        name: String(item?.name || ''),
        coverUrl: String(item?.coverUrl || ''),
        playCount: Number(item?.playCount || 0),
        creator: String(item?.creator || ''),
      })).filter((item: { id: string; name: string }) => item.id && item.name))
    }).catch(() => { /* 失败保持空，不编内容 */ })
    return () => {
      controller.abort()
      if (bannerKeyRef.current === bannerKey) bannerKeyRef.current = ''
    }
  }, [active, tab, bannerKey])

  /* ── 最新发行：区域页签 + 分页（公开接口，无需登录） ── */
  useEffect(() => {
    if (!active || tab !== 'recommend') return
    const controller = new AbortController()
    setNewAlbumLoading(true)
    const num = newAlbumExpanded ? 24 : 12
    void fetch(`${getApiBase()}/qq/hall/new-albums?area=${newAlbumArea}&num=${num}`, { signal: controller.signal, cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (controller.signal.aborted) return
        const list = Array.isArray(data?.albums) ? data.albums : []
        setNewAlbums(list.map((item: any) => ({
          id: String(item?.id || ''),
          mid: String(item?.mid || ''),
          name: String(item?.name || ''),
          singer: String(item?.singer || ''),
          coverUrl: String(item?.coverUrl || ''),
        })).filter((item: { id: string; name: string }) => item.id && item.name))
      })
      .catch(() => { if (!controller.signal.aborted) setNewAlbums([]) })
      .finally(() => { if (!controller.signal.aborted) setNewAlbumLoading(false) })
    return () => controller.abort()
  }, [active, tab, revision, newAlbumArea, newAlbumExpanded])

  /* ── 推荐 / 排行：账号级货架快照 ── */
  const snapshotKey = `${userId}:${revision}`
  useEffect(() => {
    // 未登录时接口必然 401（网关要求 cookie），索性不发请求，直接走登录空态
    if (!active || !loggedIn) return
    if (snapshotKeyRef.current === snapshotKey) return
    snapshotKeyRef.current = snapshotKey
    const controller = new AbortController()
    setSnapshotState('loading')
    setSnapshotError('')
    void fetchQQExploreBootstrap(controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setSnapshot(data)
        setSnapshotState('ready')
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        // 失败不留请求锁：重试按钮会通过 revision 再发一次
        if (snapshotKeyRef.current === snapshotKey) snapshotKeyRef.current = ''
        setSnapshot(null)
        setSnapshotState('error')
        setSnapshotError(error instanceof Error ? error.message : '乐馆内容加载失败')
      })
    return () => {
      controller.abort()
      // 中断（例如页面被隐藏）后允许下次可见时重来，否则会永远停在加载中
      if (snapshotKeyRef.current === snapshotKey) snapshotKeyRef.current = ''
    }
  }, [active, loggedIn, snapshotKey, tab, directoryState])

  /* ── 排行：榜单目录（聚合接口公开可用，进入页签才请求；失败时退回货架榜单卡） ── */
  const directoryKey = `charts-directory:${revision}`
  useEffect(() => {
    if (!active || tab !== 'charts') return
    if (directoryKeyRef.current === directoryKey) return
    directoryKeyRef.current = directoryKey
    const controller = new AbortController()
    setDirectoryState('loading')
    void fetchExploreHome('qq', controller.signal)
      .then(data => {
        if (controller.signal.aborted) return
        setDirectoryCharts(Array.isArray(data?.charts) ? data.charts : [])
        setDirectoryState('ready')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // 失败不留请求锁：重试按钮会通过 revision 再发一次
        if (directoryKeyRef.current === directoryKey) directoryKeyRef.current = ''
        setDirectoryCharts([])
        setDirectoryState('error')
      })
    return () => {
      controller.abort()
      if (directoryKeyRef.current === directoryKey) directoryKeyRef.current = ''
    }
  }, [active, tab, directoryKey])

  /* ── 歌手：筛选项 + 公开列表（进入页签才请求） ── */
  const singerFilterKey = `singer-filters:${revision}`
  useEffect(() => {
    if (!active || tab !== 'artists') return
    if (singerFilterKeyRef.current === singerFilterKey) return
    singerFilterKeyRef.current = singerFilterKey
    const controller = new AbortController()
    fetch(`${getApiBase()}/qq/singer/category`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        setSingerFilters(parseQQSingerFilters(payload))
      })
      .catch(() => { if (!controller.signal.aborted) setSingerFilters(null) })
    return () => {
      controller.abort()
      if (singerFilterKeyRef.current === singerFilterKey) singerFilterKeyRef.current = ''
    }
  }, [active, tab, singerFilterKey])

  const loadSingers = useCallback((page: number, append: boolean) => {
    singerAbortRef.current?.abort()
    const controller = new AbortController()
    singerAbortRef.current = controller
    if (append) setSingerLoadingMore(true)
    else { setSingerState('loading'); setSingers([]) }
    const params = new URLSearchParams({
      area: String(singerArea), sex: String(singerSex), index: String(singerIndex), genre: String(singerGenre), pageNo: String(page),
    })
    fetch(`${getApiBase()}/qq/singer/list?${params.toString()}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQSingers(payload)
        const total = Number(payload?.data?.total || 0)
        setSingers(previous => (append ? [...previous.filter(item => !list.some(next => next.mid === item.mid)), ...list] : list))
        singerPageRef.current = page
        setSingerHasMore(total > 0 ? page * SINGER_PAGE_SIZE < total : list.length >= SINGER_PAGE_SIZE)
        setSingerState('ready')
        setSingerLoadingMore(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        // 追加失败保持原列表（已有内容不丢），首屏失败才落空态
        setSingerLoadingMore(false)
        setSingerState(append ? 'ready' : 'error')
      })
  }, [singerArea, singerSex, singerIndex, singerGenre])

  const singerKey = `singers:${singerArea}:${singerSex}:${singerIndex}:${singerGenre}:${revision}`
  useEffect(() => {
    if (!active || tab !== 'artists') return
    if (singerKeyRef.current === singerKey) return
    singerKeyRef.current = singerKey
    loadSingers(1, false)
    return () => {
      singerAbortRef.current?.abort()
      if (singerKeyRef.current === singerKey) singerKeyRef.current = ''
    }
  }, [active, tab, singerKey, loadSingers])

  /* ── 歌单分类：公开接口 ── */
  const categoryKey = `categories:${revision}`
  useEffect(() => {
    if (!active || tab !== 'playlists') return
    if (categoryKeyRef.current === categoryKey) return
    categoryKeyRef.current = categoryKey
    const controller = new AbortController()
    fetch(`${getApiBase()}/qq/songlist/category`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQCategories(payload)
        setCategories(list)
        setActiveCategory(previous => (previous != null && list.some(item => item.id === previous)
          ? previous
          : list.find(item => item.name === '全部')?.id ?? list[0]?.id ?? null))
      })
      .catch(() => {
        if (controller.signal.aborted) return
        if (categoryKeyRef.current === categoryKey) categoryKeyRef.current = ''
        setCategories([])
      })
    return () => {
      controller.abort()
      if (categoryKeyRef.current === categoryKey) categoryKeyRef.current = ''
    }
  }, [active, tab, categoryKey])

  /* ── 分类歌单网格：服务端路由已做 id→category / page→pageNo / pageSize→num 映射，
       分类与翻页都能真实生效，因此这里与歌手区一样提供「加载更多」。 ── */
  const SQUARE_PAGE_SIZE = 30
  const loadSquare = useCallback((categoryId: number, page: number, append: boolean) => {
    squareAbortRef.current?.abort()
    const controller = new AbortController()
    squareAbortRef.current = controller
    if (append) setSquareLoadingMore(true)
    else { setSquareState('loading'); setSquarePlaylists([]) }
    fetch(`${getApiBase()}/qq/songlist/list?id=${categoryId}&page=${page}&pageSize=${SQUARE_PAGE_SIZE}&sort=5`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQSquarePlaylists(payload)
        setSquarePlaylists(previous => (append
          ? [...previous.filter(item => !list.some(next => next.id === item.id)), ...list]
          : list))
        squarePageRef.current = page
        setSquareHasMore(list.length >= SQUARE_PAGE_SIZE)
        setSquareState('ready')
        setSquareLoadingMore(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setSquareLoadingMore(false)
        setSquareState(append ? 'ready' : 'error')
      })
  }, [])

  const squareKey = `${activeCategory}:${revision}`
  useEffect(() => {
    if (!active || tab !== 'playlists' || activeCategory == null) return
    if (squareKeyRef.current === squareKey) return
    squareKeyRef.current = squareKey
    loadSquare(activeCategory, 1, false)
    return () => {
      squareAbortRef.current?.abort()
      if (squareKeyRef.current === squareKey) squareKeyRef.current = ''
    }
  }, [active, tab, activeCategory, squareKey, loadSquare])

  const loadMoreSquare = useCallback(() => {
    if (activeCategory == null || squareLoadingMore) return
    loadSquare(activeCategory, squarePageRef.current + 1, true)
  }, [activeCategory, squareLoadingMore, loadSquare])

  /* ── 视频：类型/地区筛选项（进入「视频库」子页签才请求） ── */
  const mvCategoryKey = `mv-categories:${revision}`
  useEffect(() => {
    if (!active || tab !== 'videos' || mvSubTab !== 'library') return
    if (mvCategoryKeyRef.current === mvCategoryKey) return
    mvCategoryKeyRef.current = mvCategoryKey
    const controller = new AbortController()
    fetch(`${getApiBase()}/qq/mv/category`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        setMvCategories(parseQQMvCategories(payload))
      })
      .catch(() => { if (!controller.signal.aborted) setMvCategories(null) })
    return () => {
      controller.abort()
      if (mvCategoryKeyRef.current === mvCategoryKey) mvCategoryKeyRef.current = ''
    }
  }, [active, tab, mvSubTab, mvCategoryKey])

  const loadMvList = useCallback((version: number, area: number, page: number, append: boolean) => {
    mvAbortRef.current?.abort()
    const controller = new AbortController()
    mvAbortRef.current = controller
    if (append) setMvLoadingMore(true)
    else { setMvState('loading'); setMvList([]) }
    fetch(`${getApiBase()}/qq/mv/list?version=${version}&area=${area}&pageNo=${page}&pageSize=${MV_PAGE_SIZE}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list = parseQQMvList(payload)
        setMvList(previous => (append ? [...previous.filter(item => !list.some(next => next.vid === item.vid)), ...list] : list))
        mvPageRef.current = page
        setMvHasMore(list.length >= MV_PAGE_SIZE)
        setMvState('ready')
        setMvLoadingMore(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setMvLoadingMore(false)
        setMvState(append ? 'ready' : 'error')
      })
  }, [])

  const mvListKey = `${mvVersion}:${mvArea}:${revision}`
  useEffect(() => {
    // MV 列表：视频库里是全量筛选列表，「推荐」页签只取前几条当「最新」
    if (!active || tab !== 'videos' || mvSubTab === 'charts') return
    if (mvListKeyRef.current === mvListKey) return
    mvListKeyRef.current = mvListKey
    loadMvList(mvVersion, mvArea, 1, false)
    return () => {
      mvAbortRef.current?.abort()
      if (mvListKeyRef.current === mvListKey) mvListKeyRef.current = ''
    }
  }, [active, tab, mvSubTab, mvListKey, loadMvList])

  /** MV 榜：`/api/qq/mv/chart`（上游 musicToplist.ToplistInfoServer/GetDetail，topId=201）。 */
  const mvChartKey = `mv-chart:${revision}`
  useEffect(() => {
    // 「推荐」的热门区与「排行榜」都要这份数据；只有「视频库」不需要
    if (!active || tab !== 'videos' || mvSubTab === 'library') return
    if (mvChartKeyRef.current === mvChartKey) return
    mvChartKeyRef.current = mvChartKey
    const controller = new AbortController()
    setMvChartState('loading')
    fetch(`${getApiBase()}/qq/mv/chart?num=30`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const items: QQMvChartItem[] = Array.isArray(payload?.items) ? payload.items : []
        setMvChart(payload?.chart || null)
        setMvChartItems(items)
        setMvChartState(items.length ? 'ready' : 'error')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        if (mvChartKeyRef.current === mvChartKey) mvChartKeyRef.current = ''
        setMvChart(null)
        setMvChartItems([])
        setMvChartState('error')
      })
    return () => {
      controller.abort()
      if (mvChartKeyRef.current === mvChartKey) mvChartKeyRef.current = ''
    }
  }, [active, tab, mvSubTab, mvChartKey])

  /* ── 视频「推荐」顶部 banner：官方首发 MV 资讯（GetHomePage ShelfId 127，与乐馆 115/116 同套路） ── */
  const videoBannerKey = `video-banners:${revision}`
  useEffect(() => {
    if (!active || tab !== 'videos' || mvSubTab !== 'recommend') return
    if (videoBannerKeyRef.current === videoBannerKey) return
    videoBannerKeyRef.current = videoBannerKey
    const controller = new AbortController()
    const cookie = getExploreCookie('qq')
    void fetch(`${getApiBase()}/qq/video/banners?cookie=${encodeURIComponent(cookie)}`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const list: Array<{ id: string; title: string; subtitle: string; coverUrl: string; mvId: string }> = (Array.isArray(payload?.banners) ? payload.banners : [])
          .map((item: any) => ({
            id: String(item?.id || ''),
            title: String(item?.title || ''),
            subtitle: String(item?.subtitle || ''),
            coverUrl: String(item?.coverUrl || ''),
            mvId: String(item?.action?.mvId || ''),
          }))
          .filter((item: { coverUrl: string; title: string; mvId: string }) => item.coverUrl && item.title && item.mvId)
        setVideoBanners(list)
        setVideoBannerIndex(0)
      })
      .catch(() => { /* banner 拉不到不拦下方货架 */ })
    return () => controller.abort()
  }, [active, tab, mvSubTab, videoBannerKey])

  const loadMoreMv = useCallback(() => {
    if (mvLoadingMore) return
    loadMvList(mvVersion, mvArea, mvPageRef.current + 1, true)
  }, [mvArea, mvLoadingMore, mvVersion, loadMvList])

  /* ── 频道：官方电台广场分类 + 频道位（公开接口） ── */
  const radioKey = `radio-channels:${revision}`
  useEffect(() => {
    if (!active || tab !== 'channels') return
    if (radioKeyRef.current === radioKey) return
    radioKeyRef.current = radioKey
    const controller = new AbortController()
    radioAbortRef.current?.abort()
    radioAbortRef.current = controller
    setRadioState('loading')
    fetch(`${getApiBase()}/qq/radio/channels`, { signal: controller.signal, cache: 'no-store' })
      .then(response => response.json())
      .then(payload => {
        if (controller.signal.aborted) return
        const groups = parseQQRadioGroups(payload)
        setRadioGroups(groups)
        setActiveRadioGroup(previous => (groups.some(group => group.id === previous) ? previous : (groups[0]?.id || '')))
        setRadioState(groups.length ? 'ready' : 'error')
      })
      .catch(() => {
        if (controller.signal.aborted) return
        if (radioKeyRef.current === radioKey) radioKeyRef.current = ''
        setRadioGroups([])
        setRadioState('error')
      })
    return () => {
      controller.abort()
      if (radioKeyRef.current === radioKey) radioKeyRef.current = ''
    }
  }, [active, tab, radioKey])

  /** 播放某个频道：拉一批该频道歌曲直接开播（与「猜你喜欢」同一电台接口，需要登录 cookie）。 */
  const playChannel = useCallback(async (channel: QQRadioChannel) => {
    if (!loggedIn) { act.onLogin?.(); return }
    try {
      setNotice('')
      setRadioPlayingId(channel.id)
      const cookie = getExploreCookie('qq')
      const response = await fetch(`${getApiBase()}/qq/radio/songs?id=${encodeURIComponent(channel.id)}&count=${RADIO_SONG_COUNT}&cookie=${encodeURIComponent(cookie)}`, { cache: 'no-store' })
      const payload = await response.json()
      const songs = Array.isArray(payload?.songs) ? payload.songs : []
      if (!songs.length) throw new Error(`「${channel.title}」暂时没有返回歌曲`)
      act.onPlaySongs(songs[0], songs, 0)
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '这个频道暂时无法播放')
    } finally {
      setRadioPlayingId('')
    }
  }, [act, loggedIn])

  /* ── 派生数据 ── */

  // 推荐货架：官方顺序 + 去掉听书/直播/数字专辑等无数据源货架，并丢掉没有可展示卡片的空货架
  const visibleShelves = useMemo(() => {
    const shelves = snapshot?.musicHall || []
    return shelves
      .filter(shelf => shelf.title.trim() && shelf.cards.length > 0 && !isHiddenQQMusicHallShelf(shelf))
      // 焦点图是顶部的 banner 行（服务端另有 /qq/hall/banners），不再当普通货架重复渲染
      .filter(shelf => !/焦点图/.test(shelf.title))
      // 新碟（116）由下方「最新发行」区块（带区域页签 + 分页）专门渲染，避免同一版面出现两行新碟
      .filter(shelf => !/^新碟$|最新发行/.test(shelf.title.trim()))
      .sort((left, right) => left.serverOrder - right.serverOrder)
  }, [snapshot])

  /**
   * 排行榜兜底目录：正常情况用聚合接口 /api/explore/qq 透传的全量榜单（directoryCharts，
   * 上游 top/category），接口失败或为空时才从货架里 action=open-chart 的卡片反推。
   * 这里刻意不套 isHiddenQQMusicHallShelf：隐藏规则是为了首页版面（编辑甄选等），
   * 不代表里面的榜单卡无效。
   */
  const charts = useMemo<ExploreChart[]>(() => {
    const seen = new Set<string>()
    const list: ExploreChart[] = []
    for (const shelf of snapshot?.musicHall || []) {
      for (const card of shelf.cards) {
        if (card.action.type !== 'open-chart' || !card.action.chartId) continue
        if (seen.has(card.action.chartId)) continue
        seen.add(card.action.chartId)
        list.push({
          id: card.action.chartId,
          name: card.title || 'QQ 音乐榜单',
          group: shelf.title || '排行榜',
          coverUrl: card.coverUrl || '',
          platform: 'qq',
          songs: [],
        })
      }
    }
    return list
  }, [snapshot])

  /** 排行榜目录按官方分组（巅峰榜 / 地区榜 / 特色榜 / 全球榜…）渲染，组内保持上游顺序。
   *  纯 MV 榜（「MV榜」）不列入：上游 `top/category` 的该类榜单在 /api/explore/chart 上是 502，
   *  点开只会是空页——按「渲染出来的都要能用」的口径先不列，视频侧等拿到 MV 榜接口再补。 */
  const chartGroups = useMemo(() => {
    const source = (directoryCharts.length ? directoryCharts : charts)
      .filter(chart => !/\bMV\s*榜/i.test(chart.name || ''))
    const map = new Map<string, ExploreChart[]>()
    for (const chart of source) {
      const key = (chart.group || '排行榜').trim() || '排行榜'
      const arr = map.get(key) || []
      arr.push(chart)
      map.set(key, arr)
    }
    return [...map.entries()]
  }, [directoryCharts, charts])

  /** 分类胶囊按官方分组顺序渲染（同组内一行）。 */
  const categoryGroups = useMemo(() => {
    const map = new Map<string, QQSquareCategory[]>()
    for (const item of categories) {
      const arr = map.get(item.group) || []
      arr.push(item)
      map.set(item.group, arr)
    }
    return [...map.entries()]
  }, [categories])

  const activeRadio = useMemo(
    () => radioGroups.find(group => group.id === activeRadioGroup) || radioGroups[0] || null,
    [radioGroups, activeRadioGroup],
  )


  /** 视频「推荐」：musicHall 的「精选视频」货架（官方策展的 MV，卡片带 mvId）。 */
  const videoShelf = useMemo(
    () => (snapshot?.musicHall || []).find(shelf => /精选视频|视频/.test(shelf.title) && shelf.cards.some(card => card.action.type === 'open-mv')) || null,
    [snapshot],
  )

  // 视频页顶部轮播：三张一屏，6 秒自动翻页（与乐馆精选 banner 同版式；卡片点击直接播 MV）
  const videoBannerPages = useMemo(() => {
    const pages: Array<typeof videoBanners> = []
    for (let i = 0; i < videoBanners.length; i += 3) pages.push(videoBanners.slice(i, i + 3))
    return pages
  }, [videoBanners])
  useEffect(() => {
    if (tab !== 'videos' || mvSubTab !== 'recommend' || videoBannerPages.length < 2) return
    const timer = window.setInterval(() => setVideoBannerIndex(index => (index + 1) % videoBannerPages.length), 6000)
    return () => window.clearInterval(timer)
  }, [tab, mvSubTab, videoBannerPages.length])

  // 精选顶部轮播：三张一屏，6 秒自动翻页（与官方一样底部小点可点）
  const bannerPages = useMemo(() => {
    const pages: Array<typeof banners> = []
    for (let i = 0; i < banners.length; i += 3) pages.push(banners.slice(i, i + 3))
    return pages
  }, [banners])
  useEffect(() => {
    if (tab !== 'recommend' || bannerPages.length < 2) return
    const timer = window.setInterval(() => setBannerIndex(index => (index + 1) % bannerPages.length), 6000)
    return () => window.clearInterval(timer)
  }, [tab, bannerPages.length])

  /**
   * 卡片点击行为：null = 本软件没有对应目标（该卡渲染成静态元素，不留点了没反应的按钮）。
   * 可覆盖的动作与官方客户端的落点一一对应：歌单/榜单/歌曲/专辑/歌手/MV/更多分区/搜索。
   */
  const cardAction = useCallback((card: QQMusicHallCard): (() => void) | null => {
    const action = card.action
    switch (action.type) {
      case 'open-playlist':
        return () => act.onOpenPlaylist(hallPlaylist(card))
      case 'open-chart':
        return () => act.onOpenChart?.({
          id: action.chartId,
          name: card.title || 'QQ 音乐榜单',
          group: '',
          coverUrl: card.coverUrl || '',
          platform: 'qq' as const,
          songs: [],
        })
      case 'play-songs':
        return card.songs.length ? () => act.onPlaySongs(card.songs[0], card.songs, 0) : null
      case 'open-album':
        return act.onOpenAlbum ? () => act.onOpenAlbum?.(action.albumId, 'qq') : null
      case 'open-mv':
        // 走全局 MV 弹窗直接播放（与左栏「MV」入口同一链路）；弹窗不可用时才退回系统浏览器
        if (act.onOpenMv) return () => act.onOpenMv?.(action.mvId, 'qq')
        return () => openExternalLink(`https://y.qq.com/n/ryqq/mv/${action.mvId}`)
      case 'open-external':
        return () => openExternalLink(action.url)
      case 'open-section':
        // 官方的「更多」入口：能对上我们页签的跳页签，MV 分区走全局 MV 弹窗，其余不响应
        if (action.section === 'artists') return () => setTab('artists')
        if (action.section === 'charts') return () => setTab('charts')
        if (action.section === 'playlists') return () => setTab('playlists')
        if (action.section === 'mvs' && act.onOpenMv) return () => act.onOpenMv?.(undefined, 'qq')
        return null
      case 'search':
        return () => act.onNavigate({ kind: 'qq', page: 'search', keyword: action.query })
      case 'unsupported':
      case 'play-radio':
      case 'play-radar':
      case 'open-preferences':
        return null
      default: {
        // 上游 action 联合类型里没有 open-artist，但货架实测会出现，做一次宽松兜底
        const loose = action as unknown as { type?: string; artistId?: string; mid?: string }
        const artistId = String(loose.artistId || loose.mid || '')
        if (loose.type === 'open-artist' && artistId) return () => act.onOpenArtist?.(artistId, 'qq')
        return null
      }
    }
  }, [act])

  const refresh = useCallback(() => {
    // 已加载键全部失效 + revision 变化：当前页签需要的数据会重新拉取，其余页签等切过去再拉
    snapshotKeyRef.current = ''
    directoryKeyRef.current = ''
    singerKeyRef.current = ''
    singerFilterKeyRef.current = ''
    categoryKeyRef.current = ''
    squareKeyRef.current = ''
    mvCategoryKeyRef.current = ''
    mvListKeyRef.current = ''
    radioKeyRef.current = ''
    bannerKeyRef.current = ''
    videoBannerKeyRef.current = ''
    setRevision(value => value + 1)
  }, [])

  const loadingLine = <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>

  const loginEmpty = (
    <PcEmpty
      theme={theme}
      title="登录后查看乐馆内容"
      description="部分货架需要登录 QQ 音乐，登录后显示与手机客户端同账号的内容"
      action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined}
    />
  )

  const snapshotErrorEmpty = (
    <PcEmpty
      theme={theme}
      title="乐馆内容加载失败"
      description={snapshotError || '本地网关暂时没有返回内容'}
      action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />}
    />
  )

  /* ── 精选：官方轮播 + 官方货架（标题 + 6 列封面卡） ── */
  const renderShelves = () => {
    const bannerRow = bannerPages.length ? (
      <div className="mb-7">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(bannerPages[bannerIndex] || []).map((banner, index) => {
            const playable = banner.action.type === 'play-songs' && banner.songs.length > 0
            // 官方这几张首发 banner 是「新碟发行」类内容：上游 action 是 open-album → 点开专辑详情。
            // 旧实现只认 play-songs，其余一律渲染成点不动的静态卡（用户反馈「banner 点不进去」）。
            const albumId = banner.action.type === 'open-album' ? String((banner.action as { albumId?: string }).albumId || '') : ''
            const playlistId = banner.action.type === 'open-playlist' ? String((banner.action as { playlistId?: string }).playlistId || '') : ''
            const mvId = banner.action.type === 'open-mv' ? String((banner.action as { mvId?: string }).mvId || '') : ''
            const runBanner = playable
              ? () => act.onPlaySongs(banner.songs[0], banner.songs, 0)
              : albumId && act.onOpenAlbum
                ? () => act.onOpenAlbum?.(albumId, 'qq')
                : playlistId && act.onOpenPlaylist
                  ? () => act.onOpenPlaylist({ id: playlistId, name: banner.title, coverUrl: banner.coverUrl, platform: 'qq', source: 'qq-hall-banner' })
                  : mvId && act.onOpenMv
                    ? () => act.onOpenMv?.(mvId, 'qq')
                    : null
            const body = (
              <span className="relative block h-[168px] w-full overflow-hidden rounded-xl">
                <img src={banner.coverUrl} alt={banner.title} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]" loading="lazy" referrerPolicy="no-referrer" />
                <span className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent" />
                <span className="absolute inset-x-0 bottom-0 p-3">
                  <span className="block truncate text-[15px] font-semibold text-white">{banner.title}</span>
                  {banner.subtitle ? <span className="mt-0.5 block truncate text-[12px] text-white/75">{banner.subtitle}</span> : null}
                </span>
                {playable ? (
                  <span className="absolute right-3 top-3 flex h-8 items-center gap-1 rounded-full bg-white/92 px-3 text-[12px] font-medium text-slate-900 shadow">
                    <Play className="h-3.5 w-3.5 fill-current" />
                    立即播放
                  </span>
                ) : null}
              </span>
            )
            if (!runBanner) {
              return <div key={`hall-banner:${banner.id}:${index}`} className="block text-left" title="该内容只能在 QQ 音乐客户端中打开">{body}</div>
            }
            return (
              <button
                key={`hall-banner:${banner.id}:${index}`}
                type="button"
                onClick={runBanner}
                className="group block text-left"
                title={banner.title}
              >
                {body}
              </button>
            )
          })}
        </div>
        {bannerPages.length > 1 ? (
          <div className="mt-2.5 flex items-center justify-center gap-1.5">
            {bannerPages.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`切换到第 ${index + 1} 屏推荐`}
                onClick={() => setBannerIndex(index)}
                className="h-1.5 rounded-full transition-all"
                style={{ width: index === bannerIndex ? 16 : 6, background: index === bannerIndex ? accent : 'rgba(128,128,128,0.45)' }}
              />
            ))}
          </div>
        ) : null}
      </div>
    ) : null

    if (!loggedIn) {
      return (
        <>
          {bannerRow}
          {loginEmpty}
        </>
      )
    }
    if (snapshotState === 'error' && !visibleShelves.length) {
      return (
        <>
          {bannerRow}
          {snapshotErrorEmpty}
        </>
      )
    }
    if (snapshotState === 'loading' && !snapshot) {
      return (
        <>
          {bannerRow}
          {loadingLine}
        </>
      )
    }
    if (!visibleShelves.length) {
      return (
        <>
          {bannerRow}
          <PcEmpty theme={theme} title="暂无货架内容" description="QQ 音乐没有返回可展示的推荐货架" />
        </>
      )
    }
    return (
      <>
        {bannerRow}
        {/* 最新发行：官方这一行带区域页签（上游 area 1~6 = 最新/华语/欧美/韩国/日本/其他，
            官方客户端把华语再拆成内地/港台——接口层没有拆分，这里如实按上游分区标注），
            右侧「更多」把 12 张扩到 24 张（官方是跳列表页，我们没有那个页面，就地展开最接近）。 */}
        {newAlbums.length || newAlbumLoading ? (
          <section className="mb-8">
            <div className="flex items-start justify-between gap-3">
              <PcSectionTitle title="最新发行" theme={theme} more={newAlbumExpanded ? '收起' : '更多'} onMore={() => setNewAlbumExpanded(value => !value)} />
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {NEW_ALBUM_AREAS.map(option => (
                <button
                  key={option.area}
                  type="button"
                  onClick={() => setNewAlbumArea(option.area)}
                  className={`rounded-full px-3 py-1 text-[12px] transition ${newAlbumArea === option.area ? 'font-medium text-white' : `${theme.subtle} ${theme.tone === 'dark' ? 'hover:bg-white/[0.08]' : 'hover:bg-black/[0.05]'}`}`}
                  style={newAlbumArea === option.area ? { background: accent } : undefined}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {newAlbums.map(album => (
                <button
                  key={`qq-new-album:${album.id}`}
                  type="button"
                  onClick={() => act.onOpenAlbum?.(album.mid || album.id, 'qq')}
                  className="group min-w-0 text-left"
                  title={album.singer ? `${album.name} - ${album.singer}` : album.name}
                >
                  <PcCover src={album.coverUrl} alt={album.name} className="aspect-square w-full transition group-hover:-translate-y-0.5" rounded="rounded-[8px]" />
                  <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{album.name}</span>
                  <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{album.singer}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {/* 官方精选的顺序是「首发 banner → 官方歌单 → 其它货架」；官方歌单来自
            playlist.HotRecommendServer/get_hot_recommend（与客户端逐条一致，见服务端路由注释）。 */}
        {officialPlaylists.length ? (
          <section className="mb-8">
            <PcSectionTitle
              title="官方歌单"
              theme={theme}
              more="更多"
              onMore={() => setTab('playlists')}
            />
            <PcCardGrid
              items={officialPlaylists.map(playlist => ({
                key: `qq-official-playlist:${playlist.id}`,
                coverUrl: playlist.coverUrl,
                title: playlist.name,
                subtitle: playlist.creator || undefined,
                playCount: playlist.playCount,
                onClick: () => act.onOpenPlaylist({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq', source: 'qq-hot-recommend' }),
                onContextMenu: (event: ReactMouseEvent) => {
                  event.preventDefault()
                  act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: { id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq' } })
                },
              }))}
              theme={theme}
              accent={accent}
              columns={6}
            />
          </section>
        ) : null}
        {visibleShelves.map(shelf => (
          <section key={`${shelf.id}:${shelf.title}`} className="mb-8">
            <PcSectionTitle title={shelf.title} theme={theme} />
            {/* 为什么不用 PcCardGrid：它只会渲染 <button>，而货架里存在本软件打不开的卡片，
                硬套就会留下「点了没反应」的死按钮。这里复用同一套栅格样式，按可点性切换 button/div。 */}
            <div className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
              {shelf.cards.map((card, index) => {
                const run = cardAction(card)
                const subtitle = hallCardSubtitle(card)
                const body = (
                  <>
                    <PcCover
                      src={card.coverUrl}
                      alt={card.title || shelf.title}
                      className="aspect-square w-full"
                      rounded="rounded-[8px]"
                      overlay={
                        <>
                          <PcCountBadge value={hallCardCount(card)} />
                          {run ? (
                            <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                              <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                            </span>
                          ) : null}
                        </>
                      }
                    />
                    <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{card.title}</span>
                    {subtitle ? <span className={`mt-0.5 line-clamp-2 block text-[11px] leading-snug ${theme.faint}`}>{subtitle}</span> : null}
                  </>
                )
                const key = `${shelf.id}:${card.id}:${card.subId}:${index}`
                if (!run) {
                  return (
                    <div key={key} className="block text-left" title="该内容只能在 QQ 音乐客户端中打开">
                      {body}
                    </div>
                  )
                }
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={run}
                    title={card.title}
                    // 只有歌单类卡片右击才有意义（菜单里是歌单操作）
                    onContextMenu={card.action.type === 'open-playlist'
                      ? (event: ReactMouseEvent) => {
                        event.preventDefault()
                        act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: hallPlaylist(card) })
                      }
                      : undefined}
                    className="group block text-left"
                  >
                    {body}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </>
    )
  }

  /* ── 歌手：地区/性别/字母筛选（二级菜单）+ 圆形头像网格 + 分页 ── */
  const renderArtists = () => {
    if (!act.onOpenArtist) return <PcEmpty theme={theme} title="当前版本不支持打开歌手页" />
    const filterRow = (label: string, options: QQSingerFilterOption[] | undefined, value: number, onChange: (next: number) => void) => {
      if (!options?.length) return null
      return (
        <div key={label} className="mb-2 flex items-start gap-3">
          <span className={`mt-1.5 w-8 shrink-0 text-right text-[12px] ${theme.faint}`}>{label}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {options.map(option => {
              const active = option.id === value
              return (
                <button
                  key={`${label}:${option.id}`}
                  type="button"
                  onClick={() => onChange(option.id)}
                  className={`min-w-[46px] rounded-full px-3 py-1 text-[12px] transition ${active ? 'font-medium text-white' : theme.chipIdle}`}
                  style={active ? { background: accent } : undefined}
                >
                  {option.name}
                </button>
              )
            })}
          </div>
        </div>
      )
    }
    return (
      <div>
        {singerFilters ? (
          <div className="mb-5">
            {filterRow('地区', singerFilters.area, singerArea, setSingerArea)}
            {filterRow('性别', singerFilters.sex, singerSex, setSingerSex)}
            {filterRow('字母', singerFilters.index, singerIndex, setSingerIndex)}
            {filterRow('风格', singerFilters.genre, singerGenre, setSingerGenre)}
          </div>
        ) : null}
        {singerState === 'loading' ? loadingLine : singerState === 'error' ? (
          <PcEmpty theme={theme} title="歌手列表加载失败" description="公开接口暂时不可用" action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />} />
        ) : !singers.length ? <PcEmpty theme={theme} title="暂无歌手" description="该筛选条件下没有可展示的歌手" /> : (
          <>
            <PcCardGrid
              items={singers.map(singer => ({
                key: `singer:${singer.mid}`,
                coverUrl: singer.picUrl,
                title: singer.name,
                rounded: 'rounded-full',
                onClick: () => act.onOpenArtist?.(singer.mid, 'qq'),
              }))}
              theme={theme}
              accent={accent}
              columns={6}
              showPlayOnHover={false}
            />
            {singerHasMore ? (
              <div className="mt-6 flex justify-center">
                <PcGhostButton
                  label="加载更多歌手"
                  theme={theme}
                  disabled={singerLoadingMore}
                  onClick={() => loadSingers(singerPageRef.current + 1, true)}
                />
              </div>
            ) : null}
          </>
        )}
      </div>
    )
  }

  /* ── 排行：官方榜单目录，按官方分组（巅峰榜/地区榜/特色榜/全球榜）分节；
        带前三首的榜单卡是「富卡」（封面 + 榜名 + 前三首），其余是普通封面卡。 ── */
  const renderCharts = () => {
    if (!act.onOpenChart) return <PcEmpty theme={theme} title="当前版本不支持打开榜单" />
    if (!chartGroups.length) {
      if (directoryState === 'loading') return loadingLine
      if (!loggedIn) {
        return <PcEmpty theme={theme} title="登录后查看官方排行榜" description="榜单目录暂时不可用，登录后可从账号货架补齐榜单" action={act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined} />
      }
      if (snapshotState === 'loading' && !snapshot) return loadingLine
      if (snapshotState === 'error') return snapshotErrorEmpty
      return <PcEmpty theme={theme} title="暂无榜单" description="榜单目录与账号货架里都没有榜单" />
    }
    return (
      <>
        {chartGroups.map(([group, groupCharts]) => {
          const rich = groupCharts.filter(chart => (chart.songs || []).length > 0)
          const simple = groupCharts.filter(chart => !(chart.songs || []).length)
          return (
            <section key={group} className="mb-8">
              <PcSectionTitle title={group} theme={theme} />
              {rich.length ? (
                <div className="mb-4 grid grid-cols-1 gap-5 xl:grid-cols-3">
                  {rich.map(chart => (
                    <button
                      key={`chart-rich:${chart.id}`}
                      type="button"
                      onClick={() => act.onOpenChart?.(chart)}
                      className={`group flex min-w-0 items-stretch gap-4 rounded-xl p-3 text-left transition ${theme.hover}`}
                    >
                      <PcCover src={chart.coverUrl} alt={chart.name} className="h-[124px] w-[124px] shrink-0" rounded="rounded-lg" overlay={<PcCountBadge value={chart.playCount} />} />
                      <span className="flex min-w-0 flex-1 flex-col justify-center">
                        <span className={`truncate text-[15px] font-semibold ${theme.text}`}>{chart.name}</span>
                        <span className="mt-1.5 space-y-1">
                          {(chart.songs || []).slice(0, 3).map((song, index) => (
                            <span key={`${chart.id}:${song.mid || song.id || index}`} className={`flex items-center gap-2 text-[12px] ${theme.subtle}`}>
                              <span className={`w-3 shrink-0 text-right text-[11px] ${theme.faint}`}>{index + 1}</span>
                              <span className="truncate">{song.name}{song.artist ? ` - ${song.artist}` : ''}</span>
                            </span>
                          ))}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
              {simple.length ? (
                <PcCardGrid
                  items={simple.map(chart => ({
                    key: `chart:${chart.id}`,
                    coverUrl: chart.coverUrl,
                    title: chart.name,
                    subtitle: chart.updateText || undefined,
                    playCount: chart.playCount,
                    onClick: () => act.onOpenChart?.(chart),
                  }))}
                  theme={theme}
                  accent={accent}
                  columns={6}
                  showPlayOnHover={false}
                />
              ) : null}
            </section>
          )
        })}
      </>
    )
  }

  /* ── 分类歌单：分类胶囊（二级）+ 精选歌单网格（三级）+ 分页 ── */
  const renderPlaylists = () => {
    const grid = squareState === 'error'
      ? <PcEmpty theme={theme} title="歌单加载失败" description="公开接口暂时不可用" action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />} />
      : squareState === 'loading'
        ? loadingLine
        : squarePlaylists.length
          ? (
            <PcCardGrid
              items={squarePlaylists.map(playlist => {
                const open = () => act.onOpenPlaylist({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq', source: 'qq-songlist-square' })
                return {
                  key: `qq-playlist:${playlist.id}`,
                  coverUrl: playlist.coverUrl,
                  title: playlist.name,
                  subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : undefined,
                  playCount: playlist.playCount,
                  onClick: open,
                  onContextMenu: (event: ReactMouseEvent) => {
                    event.preventDefault()
                    act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: { id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl, platform: 'qq' } })
                  },
                }
              })}
              theme={theme}
              accent={accent}
              columns={6}
            />
          )
          : <PcEmpty theme={theme} title="暂无歌单" description="该分类没有返回歌单" />
    return (
      <div className="space-y-4">
        {categoryGroups.map(([group, items]) => (
          <div key={group || 'default'} className="flex items-start gap-2">
            {group ? <span className={`mt-1.5 w-10 shrink-0 text-right text-[12px] ${theme.faint}`}>{group}</span> : null}
            <PcChips
              items={items.map(item => ({ key: String(item.id), label: item.name }))}
              value={activeCategory == null ? '' : String(activeCategory)}
              onChange={key => setActiveCategory(Number(key))}
              accent={accent}
              theme={theme}
              className="flex-1"
            />
          </div>
        ))}
        <div className="pt-2">
          <PcSectionTitle title="精选歌单" theme={theme} />
          {grid}
        </div>
        {squareState === 'ready' && squareHasMore ? (
          <div className="flex justify-center pt-2">
            <PcGhostButton
              label="加载更多歌单"
              theme={theme}
              disabled={squareLoadingMore}
              onClick={loadMoreSquare}
            />
          </div>
        ) : null}
      </div>
    )
  }

  /* ── 视频：二级页签（推荐 / 视频库）+ MV 网格（点击直接播 MV） ── */
  const mvCard = (mv: QQMvItem) => (
    <button
      key={`mv:${mv.vid}`}
      type="button"
      onClick={() => act.onOpenMv ? act.onOpenMv(mv.vid, 'qq') : openExternalLink(`https://y.qq.com/n/ryqq/mv/${mv.vid}`)}
      className="group min-w-0 text-left"
      title={mv.title}
    >
      <PcCover
        src={mv.coverUrl}
        alt={mv.title}
        className="aspect-video w-full"
        rounded="rounded-lg"
        overlay={
          <>
            <PcCountBadge value={mv.playCount} />
            <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
              <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
            </span>
          </>
        }
      />
      <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{mv.title}</span>
      {mv.artist ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{mv.artist}</span> : null}
    </button>
  )

  /** MV 榜条目行（排行榜与推荐的热门区共用样式）：名次 + 缩略图 + 标题 + 歌手。 */
  const mvChartRow = (item: QQMvChartItem) => (
    <button
      key={`mv-chart:${item.vid}`}
      type="button"
      onClick={() => act.onOpenMv ? act.onOpenMv(item.vid, 'qq') : openExternalLink(`https://y.qq.com/n/ryqq/mv/${item.vid}`)}
      className={`group flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition ${theme.hover}`}
      title={item.title}
    >
      <span className={`w-5 shrink-0 text-center text-[14px] tabular-nums ${item.rank <= 3 ? 'font-semibold' : ''} ${theme.subtle}`} style={item.rank <= 3 ? { color: accent } : undefined}>{item.rank}</span>
      <PcCover src={item.coverUrl} alt={item.title} className="h-[68px] w-[120px] shrink-0" rounded="rounded-md" overlay={
        <span className="absolute bottom-1 right-1 flex h-6 w-6 items-center justify-center rounded-full bg-white/95 opacity-0 shadow transition group-hover:opacity-100">
          <Play className="h-3 w-3 fill-current" style={{ color: accent }} />
        </span>
      } />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] ${theme.text}`}>{item.title}</span>
        {item.singer ? <span className={`mt-0.5 block truncate text-[12px] ${theme.faint}`}>{item.singer}</span> : null}
      </span>
    </button>
  )

  /** 视频「排行榜」：官方的巅峰榜.MV（榜单头图 + 名次列表，点击播 MV）。 */
  const renderVideoCharts = () => {
    if (mvChartState === 'loading') return loadingLine
    if (mvChartState === 'error' || !mvChartItems.length) {
      return (
        <PcEmpty
          theme={theme}
          title="MV 榜加载失败"
          description="榜单接口暂时不可用"
          action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />}
        />
      )
    }
    return (
      <div>
        <div className="mb-5 flex items-center gap-4">
          <PcCover src={mvChart?.coverUrl} alt={mvChart?.title || 'MV 榜'} className="h-[132px] w-[132px] shrink-0" rounded="rounded-lg" />
          <div className="min-w-0">
            <h2 className={`text-[22px] font-semibold ${theme.text}`}>{mvChart?.title || 'MV榜'}</h2>
            <div className={`mt-1 text-[12px] ${theme.faint}`}>
              {[mvChart?.updateTips, mvChart?.totalNum ? `${mvChart.totalNum} 个 MV` : '', pcCount(mvChart?.listenNum)].filter(Boolean).join(' · ')}
            </div>
            {mvChart?.intro ? <p className={`mt-2 line-clamp-2 max-w-[46rem] text-[12px] ${theme.subtle}`}>{mvChart.intro}</p> : null}
          </div>
        </div>
        <div className="max-w-[62rem] space-y-0.5">{mvChartItems.map(mvChartRow)}</div>
      </div>
    )
  }

  /** 视频「推荐」：榜单入口 + 最新（mv/list 按发布时间倒序）+ 热门（MV 榜前几名）。 */
  const renderVideoRecommend = () => {
    const latest = mvList.slice(0, 10)
    const hot = mvChartItems.slice(0, 10)
    const hero = mvChart ? (
      <button
        type="button"
        onClick={() => setMvSubTab('charts')}
        className={`mb-6 flex w-full min-w-0 items-center gap-4 rounded-xl p-3 text-left transition ${theme.hover}`}
        title={`${mvChart.title}：查看完整榜单`}
      >
        <PcCover src={mvChart.coverUrl} alt={mvChart.title} className="h-[96px] w-[96px] shrink-0" rounded="rounded-lg" />
        <span className="min-w-0">
          <span className={`block text-[17px] font-semibold ${theme.text}`}>{mvChart.title}</span>
          <span className={`mt-1 block truncate text-[12px] ${theme.faint}`}>{[mvChart.updateTips, pcCount(mvChart.listenNum)].filter(Boolean).join(' · ')}</span>
          <span className="mt-2 inline-flex items-center gap-1 text-[12px]" style={{ color: accent }}>
            <Play className="h-3 w-3 fill-current" />查看完整榜单
          </span>
        </span>
      </button>
    ) : null

    const section = (title: string, action: ReactNode) => (
      <section className="mt-6">
        <PcSectionTitle title={title} theme={theme} />
        {action}
      </section>
    )
    const grid = (items: QQMvItem[]) => (
      <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{items.map(mvCard)}</div>
    )

    const curated = (videoShelf?.cards || []).filter(card => card.action.type === 'open-mv' && act.onOpenMv)
    // 官方视频页顶部 = 首发 MV 资讯轮播（ShelfId 127），三张一屏、底部小点可点，卡片点击播 MV
    const videoBannerRow = videoBannerPages.length && act.onOpenMv ? (
      <div className="mb-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {(videoBannerPages[videoBannerIndex] || []).map((banner, index) => (
            <button
              key={`video-banner:${banner.id}:${index}`}
              type="button"
              onClick={() => act.onOpenMv?.(banner.mvId, 'qq')}
              className="group block text-left"
              title={banner.title}
            >
              <span className="relative block aspect-video w-full overflow-hidden rounded-xl">
                <img src={banner.coverUrl} alt={banner.title} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.02]" loading="lazy" referrerPolicy="no-referrer" />
                <span className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent" />
                <span className="absolute inset-x-0 bottom-0 p-3">
                  <span className="block truncate text-[15px] font-semibold text-white">{banner.title}</span>
                  {banner.subtitle ? <span className="mt-0.5 block truncate text-[12px] text-white/75">{banner.subtitle}</span> : null}
                </span>
                <span className="absolute right-3 top-3 flex h-8 items-center gap-1 rounded-full bg-white/92 px-3 text-[12px] font-medium text-slate-900 shadow">
                  <Play className="h-3.5 w-3.5 fill-current" />
                  MV
                </span>
              </span>
            </button>
          ))}
        </div>
        {videoBannerPages.length > 1 ? (
          <div className="mt-2.5 flex items-center justify-center gap-1.5">
            {videoBannerPages.map((_, index) => (
              <button
                key={index}
                type="button"
                aria-label={`切换到第 ${index + 1} 屏视频推荐`}
                onClick={() => setVideoBannerIndex(index)}
                className="h-1.5 rounded-full transition-all"
                style={{ width: index === videoBannerIndex ? 16 : 6, background: index === videoBannerIndex ? accent : 'rgba(128,128,128,0.45)' }}
              />
            ))}
          </div>
        ) : null}
      </div>
    ) : null
    return (
      <div>
        {videoBannerRow}
        {hero}
        {curated.length ? section('精选', (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
            {curated.map((card, index) => (
              <button
                key={`mv-shelf:${card.id}:${index}`}
                type="button"
                onClick={() => act.onOpenMv?.(card.action.type === 'open-mv' ? card.action.mvId : '', 'qq')}
                className="group min-w-0 text-left"
                title={card.title}
              >
                <PcCover src={card.coverUrl} alt={card.title} className="aspect-video w-full" rounded="rounded-lg" />
                <span className={`mt-2 line-clamp-2 text-[13px] leading-snug ${theme.text}`}>{card.title}</span>
                {hallCardSubtitle(card) ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{hallCardSubtitle(card)}</span> : null}
              </button>
            ))}
          </div>
        )) : null}
        {latest.length ? section('最新', grid(latest)) : null}
        {hot.length ? section('热门', <div className="max-w-[62rem] space-y-0.5">{hot.map(mvChartRow)}</div>) : null}
        {!curated.length && !latest.length && !hot.length ? (
          mvState === 'loading' || mvChartState === 'loading'
            ? loadingLine
            : <PcEmpty theme={theme} title="暂无视频内容" description={loggedIn ? '接口暂时没有返回 MV' : '登录后还会显示账号的精选视频'} action={!loggedIn && act.onLogin ? <PcPrimaryButton label="立即登录" icon={<User className="h-3.5 w-3.5" />} onClick={act.onLogin} accent={accent} /> : undefined} />
        ) : null}
      </div>
    )
  }

  /** 视频「视频库」：类型/地区筛选（二级）+ 全部 MV 网格 + 分页。 */
  const renderVideoLibrary = () => {
    const mvGrid = mvState === 'error'
      ? <PcEmpty theme={theme} title="MV 列表加载失败" description="公开接口暂时不可用" action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />} />
      : mvState === 'loading'
        ? loadingLine
        : mvList.length
          ? <div className="grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">{mvList.map(mvCard)}</div>
          : <PcEmpty theme={theme} title="暂无 MV" description="该筛选条件下没有返回 MV" />
    const filterRow = (label: string, options: QQSingerFilterOption[] | undefined, value: number, onChange: (next: number) => void) => {
      if (!options?.length) return null
      return (
        <div key={label} className="flex items-start gap-3">
          <span className={`mt-1.5 w-8 shrink-0 text-right text-[12px] ${theme.faint}`}>{label}</span>
          <PcChips
            items={options.map(option => ({ key: String(option.id), label: option.name }))}
            value={String(value)}
            onChange={key => onChange(Number(key))}
            accent={accent}
            theme={theme}
            className="flex-1"
          />
        </div>
      )
    }
    return (
      <div className="space-y-4">
        {filterRow('类型', mvCategories?.version, mvVersion, setMvVersion)}
        {filterRow('地区', mvCategories?.area, mvArea, setMvArea)}
        <div className="pt-2">
          <PcSectionTitle title="最新" theme={theme} />
          {mvGrid}
        </div>
        {mvState === 'ready' && mvHasMore ? (
          <div className="flex justify-center pt-2">
            <PcGhostButton label="加载更多 MV" theme={theme} disabled={mvLoadingMore} onClick={loadMoreMv} />
          </div>
        ) : null}
      </div>
    )
  }

  const renderVideos = () => (
    <div className="space-y-4">
      <PcChips
        items={MV_SUB_TABS}
        value={mvSubTab}
        onChange={key => setMvSubTab(key as MvSubTab)}
        accent={accent}
        theme={theme}
      />
      <div className="pt-1">
        {mvSubTab === 'recommend' ? renderVideoRecommend() : mvSubTab === 'charts' ? renderVideoCharts() : renderVideoLibrary()}
      </div>
    </div>
  )

  /* ── 数字专辑：官方这一页是付费专辑商城（立即购买/支持），本软件不做购买类内容，整页移除。
        musicHall 里的「数字专辑」货架也不进精选（isHiddenQQMusicHallShelf 里已列）。 ── */

  /* ── 频道：官方电台广场分类（二级）+ 圆形频道位（三级：点击开播该频道） ── */
  const renderChannels = () => {
    if (radioState === 'loading') return loadingLine
    if (radioState === 'error' || !radioGroups.length) {
      return (
        <PcEmpty
          theme={theme}
          title="频道列表加载失败"
          description="官方频道页暂时不可用"
          action={<PcGhostButton label="重试" icon={<RefreshCw className="h-3.5 w-3.5" />} theme={theme} onClick={refresh} />}
        />
      )
    }
    return (
      <div className="space-y-4">
        <PcChips
          items={radioGroups.map(group => ({ key: group.id, label: group.title }))}
          value={activeRadio?.id || ''}
          onChange={key => setActiveRadioGroup(key)}
          accent={accent}
          theme={theme}
        />
        <div className="pt-2">
          <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {(activeRadio?.channels || []).map(channel => {
              const playing = radioPlayingId === channel.id
              return (
                <button
                  key={`radio:${channel.id}`}
                  type="button"
                  onClick={() => { void playChannel(channel) }}
                  disabled={playing}
                  className="group min-w-0 text-center disabled:opacity-70"
                  title={channel.listenDesc || channel.title}
                >
                  <PcCover
                    src={channel.coverUrl}
                    alt={channel.title}
                    className="aspect-square w-full"
                    rounded="rounded-full"
                    overlay={
                      <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition group-hover:opacity-100">
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white/95 shadow-md">
                          <Play className="h-4 w-4 fill-current" style={{ color: accent }} />
                        </span>
                      </span>
                    }
                  />
                  <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{channel.title}</span>
                  <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>
                    {playing ? '正在开播…' : (channel.listenNumText || pcCount(channel.listenNum) || channel.listenDesc || '')}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="pb-8">
      <PcPageTitle
        title="乐馆"
        theme={theme}
        extra={(
          <PcIconButton theme={theme} title="刷新" onClick={refresh}>
            <RefreshCw className="h-4 w-4" />
          </PcIconButton>
        )}
      />

      <PcChips
        items={HALL_TABS}
        value={tab}
        onChange={key => { setNotice(''); setTab(key as HallTab) }}
        accent={accent}
        theme={theme}
        className="mb-5"
      />

      {notice ? <div className={`mb-4 rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>{notice}</div> : null}

      {tab === 'recommend' && renderShelves()}
      {tab === 'charts' && renderCharts()}
      {tab === 'artists' && renderArtists()}
      {tab === 'playlists' && renderPlaylists()}
      {tab === 'videos' && renderVideos()}
      {tab === 'channels' && renderChannels()}
    </div>
  )
}

export default memo(QQPcHall)
