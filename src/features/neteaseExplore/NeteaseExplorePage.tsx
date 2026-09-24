import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronRight, Compass, Disc3, Headphones, HeartPulse, Loader2, LogIn, Mic2, Music2, Play, Radio, RefreshCw, Sparkles, Trophy, UserRoundSearch, Waves, X } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import type { Song } from '../../services/musicApi'
import { fetchExplorePlaylist } from '../../services/exploreApi'
import type { ExploreChannel, ExplorePayload, ExplorePlaylist } from '../../services/exploreApi'
import { applyFavoriteMutation, getFavoriteSongIdentifiers, invalidateFavoriteIdentifiers, loadFavoriteIdentifiers } from '../../services/favoriteStatusService'
import {
  fetchNeteaseArtistRadio,
  fetchNeteaseDailySongs,
  fetchNeteaseDailyStyleSongs,
  fetchNeteaseHeartMode,
  fetchNeteaseNativeHome,
  fetchNeteasePodcastHome,
  fetchNeteaseProgramSong,
  fetchNeteaseProgramSongs,
  fetchNeteaseRedCounts,
  fetchNeteaseRoam,
  fetchNeteaseSessionStatus,
  fetchNeteaseSimilarContext,
  fetchNeteaseSimilarSongs,
  fetchNeteaseSongDetail,
  fetchNeteaseUnlimitedFlow,
  fetchNeteaseUserDetail,
  fetchNeteaseUserPlaylists,
} from './api'
import {
  normalizeNeteaseResource,
  normalizeNeteaseShortcuts,
  neteaseBlockMoreTarget,
  neteaseResourceArtwork,
  neteaseResourceKey,
  neteaseShortcutKind,
  type NeteaseNativeBlock,
  type NeteaseNativeFlow,
  type NeteaseNativeHome,
  type NeteaseNativeResource,
} from './model'
import { fetchNeteaseLinkPage } from './discover'
import { normalizeNeteaseLinkPage } from './model'
import NeteaseDiscoverView from './NeteaseDiscoverView'
import NeteaseWebPanel, { type NeteaseWebTarget } from './NeteaseWebPanel'
import NeteaseDailyRecommendPanel from './NeteaseDailyRecommendPanel'
import NeteaseRadioDetailPanel, { type NeteaseRadioDetailTarget } from './NeteaseRadioDetailPanel'
import { NeteaseFlowGrid, NeteaseNativeBlockView, SongRestrictionBadges } from './NeteaseResourceView'
import type { EntitlementTier } from '../../utils/musicEntitlements'

// src/features/neteaseExplore/NeteaseExplorePage.tsx

interface NeteaseExplorePageProps {
  loggedIn: boolean
  username: string
  userId?: string
  entitlement: EntitlementTier
  authRevision: number
  accent: string
  showDescription: boolean
  currentSong?: Song | null
  publicContent?: ExplorePayload | null
  accountPlaylists: any[]
  /** 回传页面上已加载资源的封面，供 ExploreView 拼「封面墙」背景（网易云没有聚合首页 payload） */
  onArtworkCovers?: (covers: string[]) => void
  onRequestFallback: () => void
  onLogin: () => void
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean, neteaseContinuation?: { mode: 'heart-mode'; playlistId: string } | { mode: 'roam' }) => void
  onOpenPlaylist: (playlist: ExplorePlaylist, autoplay?: boolean) => void
  onOpenChannel: (channel: ExploreChannel, autoplay?: boolean) => void
  onOpenAlbum?: (albumId: string) => void
  onOpenArtist?: (artistId: string) => void
  onOpenMV: (mvId: string) => void
  onViewComments?: (song: Song) => void
  onSongContextMenu: (event: React.MouseEvent, song: Song, songs: Song[], continuous?: boolean) => void
  onPlaylistContextMenu: (event: React.MouseEvent, playlist: ExplorePlaylist) => void
  onAddToFavorites?: (song: Song) => void | Promise<boolean>
  onRemoveFromFavorites?: (song: Song) => void | Promise<boolean>
}

interface SimilarPanelState {
  loading: boolean
  error: string
  songs: Song[]
  playlists: ExplorePlaylist[]
  users: Array<{ id: string; name: string; avatarUrl: string; signature: string }>
}

const EMPTY_SIMILAR: SimilarPanelState = { loading: false, error: '', songs: [], playlists: [], users: [] }

const ENTRY_FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--explore-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d1118]'

// 乐流网格最宽 4 列（MixedGrid: 2xl:grid-cols-4）。去重后行尾常剩 1~3 张，渲染时裁到整行，
// 多出来的留到下一次「加载更多乐流」补齐，避免最后一行缺角。
const FLOW_GRID_COLUMNS = 4

/** 推荐/精选区块 -> 发现页目标（用于「更多」跳转） */
export function discoverTargetForBlock(blockCode: string): { tab: 'music' | 'podcast'; channelCode?: string } | null {
  const code = String(blockCode || '').toUpperCase()
  if (/PODCAST|VOICE|AUDIO_BOOK|BROADCAST|FM_CHANNEL/.test(code)) return { tab: 'podcast' }
  if (/RANK|TOPLIST/.test(code)) return { tab: 'music', channelCode: 'chart' }
  if (/NEW_SONG|NEW_ALBUM|NEWSONG/.test(code)) return { tab: 'music', channelCode: 'feature' }
  if (/PLAYLIST|SHEET|STYLE|SCENE|COMBINATION|RADAR|CLOUD_VILLAGE|MIXED_ARTIST|QUALITY_SONG_LIST|TREASURE/.test(code)) return { tab: 'music', channelCode: 'playlist' }
  return null
}

function NeteaseExploreSkeleton() {
  return <div className="animate-pulse space-y-10" aria-label="正在加载网易云推荐"><div className="flex gap-4 overflow-hidden">{Array.from({ length: 5 }).map((_, index) => <div key={index} className="aspect-[1.2/1] w-52 shrink-0 rounded-md bg-white/[0.055]" />)}</div><div className="grid gap-x-6 md:grid-cols-2 2xl:grid-cols-3">{Array.from({ length: 9 }).map((_, index) => <div key={index} className="flex items-center gap-3 border-b border-white/[0.05] py-3"><div className="h-14 w-14 rounded-md bg-white/[0.06]" /><div className="flex-1 space-y-2"><div className="h-3 w-3/5 rounded bg-white/[0.07]" /><div className="h-2 w-2/5 rounded bg-white/[0.045]" /></div></div>)}</div></div>
}

function normalizeSong(value: any): Song | null {
  const resource = normalizeNeteaseResource({ resourceId: value?.id, resourceType: 'song', songData: value }, 0)
  return resource?.song || null
}

function normalizeSimilarPayload(payload: any): Omit<SimilarPanelState, 'loading' | 'error'> {
  const rawSongs = payload?.songs?.songs || payload?.songs?.data?.songs || []
  const rawPlaylists = payload?.playlists?.playlists || payload?.playlists?.data?.playlists || []
  const rawUsers = payload?.users?.userprofiles || payload?.users?.data?.userprofiles || []
  return {
    songs: (Array.isArray(rawSongs) ? rawSongs : []).map(normalizeSong).filter((song): song is Song => Boolean(song)),
    playlists: (Array.isArray(rawPlaylists) ? rawPlaylists : []).map((item: any) => ({ id: String(item.id || ''), name: String(item.name || '相关歌单'), coverUrl: String(item.coverImgUrl || item.picUrl || '').replace(/^http:/, 'https:'), description: String(item.description || item.copywriter || ''), playCount: Number(item.playCount || 0) || undefined, trackCount: Number(item.trackCount || 0) || undefined, platform: 'netease' as const, source: 'netease-native-similar' })).filter((item: ExplorePlaylist) => item.id),
    users: (Array.isArray(rawUsers) ? rawUsers : []).map((item: any) => ({ id: String(item.userId || item.id || ''), name: String(item.nickname || item.name || '网易云用户'), avatarUrl: String(item.avatarUrl || '').replace(/^http:/, 'https:'), signature: String(item.signature || '') })).filter((item: { id: string }) => item.id),
  }
}

export default function NeteaseExplorePage({
  loggedIn,
  username,
  userId,
  entitlement,
  authRevision,
  accent,
  showDescription,
  currentSong,
  publicContent,
  accountPlaylists,
  onArtworkCovers,
  onRequestFallback,
  onLogin,
  onPlaySongs,
  onOpenPlaylist,
  onOpenChannel,
  onOpenAlbum,
  onOpenArtist,
  onOpenMV,
  onViewComments,
  onSongContextMenu,
  onPlaylistContextMenu,
  onAddToFavorites,
  onRemoveFromFavorites,
}: NeteaseExplorePageProps) {
  const [home, setHome] = useState<NeteaseNativeHome | null>(null)
  const [linkHome, setLinkHome] = useState<NeteaseNativeHome | null>(null)
  const [linkShortcuts, setLinkShortcuts] = useState<NeteaseNativeResource[]>([])
  const [activeTab, setActiveTab] = useState<'recommend' | 'discover'>('recommend')
  // 发现页进入过一次就保持挂载（切回推荐只隐藏）：否则每次切回来都要重建频道/榜单/歌单广场
  // 的全部数据，等于重新走一遍加载。
  const [discoverVisited, setDiscoverVisited] = useState(false)
  useEffect(() => {
    if (activeTab === 'discover') setDiscoverVisited(true)
  }, [activeTab])
  const [discoverTab, setDiscoverTab] = useState<'music' | 'podcast'>('music')
  const [discoverJump, setDiscoverJump] = useState<{ tab: 'music' | 'podcast'; channelCode?: string; token: number } | null>(null)
  const [webTarget, setWebTarget] = useState<NeteaseWebTarget | null>(null)
  const [cubePageRequest, setCubePageRequest] = useState<{ pageId: string; title: string; token: number } | null>(null)
  const [podcast, setPodcast] = useState<NeteaseNativeHome | null>(null)
  const [flow, setFlow] = useState<NeteaseNativeFlow | null>(null)
  const [homeError, setHomeError] = useState('')
  const [podcastError, setPodcastError] = useState('')
  const [flowError, setFlowError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMoreHome, setLoadingMoreHome] = useState(false)
  const [loadingMoreLink, setLoadingMoreLink] = useState(false)
  const [flowLoading, setFlowLoading] = useState(false)
  const [entryLoading, setEntryLoading] = useState('')
  const [dailySongs, setDailySongs] = useState<Song[] | null>(null)
  // 二级面板「冻结」：首次打开后保持挂载，关闭只隐藏、不卸载，这样标签页/滚动位置/已拉到的数据都不丢，
  // 再次打开也不再重发同样的请求（visible 与数据分开存，便于同一 key 直接复用）。
  const [dailyVisible, setDailyVisible] = useState(false)
  /** 已按哪一天拉过每日推荐：同一天重开只显示，不再重发请求；跨天/换账号会重新拉。 */
  const dailyLoadedRef = useRef('')
  const [similar, setSimilar] = useState<SimilarPanelState | null>(null)
  const [similarVisible, setSimilarVisible] = useState(false)
  const similarKeyRef = useRef('')
  const [profile, setProfile] = useState<any | null>(null)
  const [profileVisible, setProfileVisible] = useState(false)
  const profileKeyRef = useRef('')
  const [profileLoading, setProfileLoading] = useState(false)
  /** 用户主页的歌单（二级入口）；null=加载中，[]=确实没有 */
  const [profilePlaylists, setProfilePlaylists] = useState<any[] | null>(null)
  /** 电台/播客节目详情（二级入口） */
  const [radioDetail, setRadioDetail] = useState<NeteaseRadioDetailTarget | null>(null)
  const [radioDetailVisible, setRadioDetailVisible] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())
  const [favoritesReady, setFavoritesReady] = useState(false)
  const [favoriteRefreshRevision, setFavoriteRefreshRevision] = useState(0)
  const [favoriteOverrides, setFavoriteOverrides] = useState<Map<string, boolean>>(new Map())
  const [favoritePending, setFavoritePending] = useState<Set<string>>(new Set())
  const [redCounts, setRedCounts] = useState<Map<string, number>>(new Map())
  const [visibleSongIds, setVisibleSongIds] = useState<Set<string>>(new Set())
  const [roamPlayedIds, setRoamPlayedIds] = useState<string[]>([])
  const favoriteOwnerRef = useRef('')
  const favoritePendingRef = useRef(new Set<string>())
  const redCountRequestedRef = useRef(new Set<string>())
  const requestRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const podcastSectionRef = useRef<HTMLElement | null>(null)
  const pageRef = useRef<HTMLDivElement | null>(null)
  const exposedResourcesRef = useRef(new Set<string>())
  const homeRef = useRef<NeteaseNativeHome | null>(null)
  homeRef.current = home
  const fallbackRef = useRef({ publicContent, onRequestFallback })
  fallbackRef.current = { publicContent, onRequestFallback }
  const accountKey = `${loggedIn ? 'user' : 'guest'}:${userId || ''}:${authRevision}`
  const [sessionProfile, setSessionProfile] = useState<{ userId: string; nickname: string; avatarUrl: string } | null>(null)
  const [sessionVerified, setSessionVerified] = useState<boolean | null>(null)
  const verifiedAccount = loggedIn && sessionVerified === true && Boolean(sessionProfile?.userId)
  const accountUserId = sessionProfile?.userId || userId || ''

  const load = useCallback(async (refresh = false) => {
    const requestId = ++requestRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    if (refresh) setRefreshing(true); else setLoading(true)
    setHomeError('')
    setPodcastError('')
    setFlowError('')
    if (refresh) {
      setHome(null)
      setPodcast(null)
      setFlow(null)
      setLinkHome(null)
      setLinkShortcuts([])
    }
    const [homeResult, podcastResult, flowResult, linkResult] = await Promise.allSettled([
      fetchNeteaseNativeHome(refresh, controller.signal, refresh && homeRef.current ? {
        blockCodeOrderList: homeRef.current.blockCodeOrderList,
        exposedResource: JSON.stringify([...exposedResourcesRef.current]),
      } : undefined),
      fetchNeteasePodcastHome(controller.signal),
      fetchNeteaseUnlimitedFlow(controller.signal),
      fetchNeteaseLinkPage('HOME_RECOMMEND_PAGE', '0', refresh, controller.signal),
    ])
    if (requestId !== requestRef.current || controller.signal.aborted) return
    if (homeResult.status === 'fulfilled') setHome(homeResult.value)
    else {
      setHomeError(homeResult.reason instanceof Error ? homeResult.reason.message : '首页推荐加载失败')
      if (!fallbackRef.current.publicContent) fallbackRef.current.onRequestFallback()
    }
    if (linkResult.status === 'fulfilled') {
      setLinkHome(normalizeNeteaseLinkPage(linkResult.value))
      setLinkShortcuts(normalizeNeteaseShortcuts(linkResult.value))
    }
    if (podcastResult.status === 'fulfilled') setPodcast(podcastResult.value)
    else setPodcastError(podcastResult.reason instanceof Error ? podcastResult.reason.message : '播客推荐加载失败')
    if (flowResult.status === 'fulfilled') setFlow(flowResult.value)
    else setFlowError(flowResult.reason instanceof Error ? flowResult.reason.message : '继续探索加载失败')
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setSessionProfile(null)
    setSessionVerified(null)
    if (!loggedIn) return () => controller.abort()
    void fetchNeteaseSessionStatus(controller.signal).then(status => {
      if (controller.signal.aborted) return
      setSessionProfile(status.profile)
      setSessionVerified(status.authenticated === true && Boolean(status.profile?.userId))
    }).catch(() => {
      if (!controller.signal.aborted) {
        setSessionProfile(null)
        setSessionVerified(null)
      }
    })
    return () => controller.abort()
  }, [accountKey, loggedIn])

  useEffect(() => {
    setHome(null)
    setPodcast(null)
    setFlow(null)
    setDailySongs(null)
    setDailyVisible(false)
    dailyLoadedRef.current = ''
    setSimilar(null)
    setSimilarVisible(false)
    similarKeyRef.current = ''
    setProfile(null)
    setProfileVisible(false)
    profileKeyRef.current = ''
    setRadioDetail(null)
    setRadioDetailVisible(false)
    setRoamPlayedIds([])
    void load(false)
    return () => controllerRef.current?.abort()
  }, [accountKey, load])

  useEffect(() => {
    const owner = verifiedAccount && accountUserId ? `netease:${accountUserId}` : ''
    favoriteOwnerRef.current = owner
    setFavoriteIds(new Set())
    setFavoriteOverrides(new Map())
    setFavoritePending(new Set())
    favoritePendingRef.current.clear()
    setFavoritesReady(false)
    if (!owner || !accountUserId) return
    let cancelled = false
    void loadFavoriteIdentifiers('netease', accountUserId).then(ids => {
      if (!cancelled && favoriteOwnerRef.current === owner) {
        setFavoriteIds(new Set(ids))
        setFavoritesReady(true)
      }
    }).catch(() => {
      if (!cancelled && favoriteOwnerRef.current === owner) setFavoritesReady(true)
    })
    const handleFavoriteChange = (event: Event) => {
      const detail = (event as CustomEvent<{ platform?: 'netease'; type?: string; songId?: string | number }>).detail
      if (detail?.platform !== 'netease' || (detail.type !== 'like' && detail.type !== 'unlike')) return
      applyFavoriteMutation(detail)
      const id = String(detail.songId || '')
      if (!id) return
      setFavoriteIds(previous => {
        const next = new Set(previous)
        if (detail.type === 'like') next.add(id); else next.delete(id)
        return next
      })
      setFavoriteOverrides(previous => new Map(previous).set(id, detail.type === 'like'))
    }
    window.addEventListener('playlist-content-changed', handleFavoriteChange)
    return () => {
      cancelled = true
      window.removeEventListener('playlist-content-changed', handleFavoriteChange)
    }
  }, [favoriteRefreshRevision, accountUserId, verifiedAccount])

  useEffect(() => {
    const missing = [...visibleSongIds].filter(id => !redCountRequestedRef.current.has(id))
    if (missing.length === 0) return
    const controller = new AbortController()
    missing.forEach(id => redCountRequestedRef.current.add(id))
    const chunks: string[][] = []
    for (let index = 0; index < missing.length; index += 40) chunks.push(missing.slice(index, index + 40))
    void Promise.all(chunks.map(chunk => fetchNeteaseRedCounts(chunk, controller.signal))).then(results => {
      if (controller.signal.aborted) return
      setRedCounts(previous => {
        const next = new Map(previous)
        results.forEach(counts => Object.entries(counts).forEach(([id, count]) => next.set(id, count)))
        return next
      })
    }).catch(() => undefined)
    return () => controller.abort()
  }, [visibleSongIds])

  // 观察可见资源卡（data-resource-id）以驱动红心数请求。原来只在 [home, flow, podcast] 变化时
  // 观察「当时已存在」的节点：晚渲染出来的卡片（续拉区块、发现页/二级页、切页签后重新挂载的节点）
  // 永远不会被观察，红心数就停在旧值。改为挂载时观察一次 + MutationObserver 持续接管新增节点
  // （IntersectionObserver.observe 对已观察节点是幂等的，可重复调用）。
  useEffect(() => {
    const root = pageRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const element = entry.target as HTMLElement
          const resourceId = element.dataset.resourceId
          if (resourceId) exposedResourcesRef.current.add(resourceId)
          const songId = element.dataset.songId
          if (songId) setVisibleSongIds(previous => previous.has(songId) ? previous : new Set(previous).add(songId))
        }
      }
    }, { root: root.closest('.explore-scrollbar'), threshold: 0.45 })
    const observeSubtree = (node: Element) => {
      if (node instanceof HTMLElement && node.dataset.resourceId) observer.observe(node)
      node.querySelectorAll<HTMLElement>('[data-resource-id]').forEach(element => observer.observe(element))
    }
    root.querySelectorAll<HTMLElement>('[data-resource-id]').forEach(element => observer.observe(element))
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(records => {
      for (const record of records) {
        record.addedNodes.forEach(node => { if (node.nodeType === 1) observeSubtree(node as Element) })
      }
    })
    mutations?.observe(root, { childList: true, subtree: true })
    return () => { mutations?.disconnect(); observer.disconnect() }
  }, [])

  const normalizedAccountPlaylists = useMemo(() => (accountPlaylists || []).map((playlist: any) => ({
    id: String(playlist.id || ''),
    name: String(playlist.name || ''),
    coverUrl: String(playlist.coverImgUrl || playlist.coverUrl || ''),
    trackCount: Number(playlist.trackCount || 0),
    platform: 'netease' as const,
    source: playlist.isLike ? 'netease-liked' : 'netease-account',
  })).filter((playlist: ExplorePlaylist) => playlist.id), [accountPlaylists])
  const likedPlaylist = normalizedAccountPlaylists.find(playlist => playlist.source === 'netease-liked' || /我喜欢/.test(playlist.name)) || null

  const radarPlaylist = home?.blocks.flatMap(block => block.resources).find(resource => neteaseShortcutKind(resource) === 'radar')?.playlist
    || normalizedAccountPlaylists.find(playlist => /雷达/.test(playlist.name)) || null
  const neteaseCurrentSong = currentSong && (currentSong.platform || 'netease') === 'netease' ? currentSong : null
  // App 实机语义（9.5.90 ADB 验证）：心动模式不要求正在播放——顶栏显示「我喜欢的音乐」，
  // 以红心歌单里的歌为锚点进入 intelligence 列表；正在播放网易云歌曲时才用当前歌做锚点。
  const startHeartMode = useCallback(async () => {
    if (!likedPlaylist) throw new Error('未找到「我喜欢的音乐」歌单，请先登录网易云')
    const seedSong = neteaseCurrentSong?.id ? neteaseCurrentSong : null
    let queue: Song[]
    if (seedSong) {
      queue = await fetchNeteaseHeartMode(Number(seedSong.id), likedPlaylist.id)
    } else {
      const liked = await fetchExplorePlaylist(likedPlaylist)
      const first = liked.songs[0]
      if (!first) throw new Error('「我喜欢的音乐」还没有歌曲，先收藏几首吧')
      const songs = await fetchNeteaseHeartMode(Number(first.id), likedPlaylist.id)
      // App 以锚点歌开场：返回列表不含锚点时补到队首
      queue = songs.some(song => String(song.id) === String(first.id)) ? songs : [first, ...songs]
    }
    if (!queue.length) throw new Error('心动模式暂无歌曲')
    onPlaySongs(queue[0], queue, true, { mode: 'heart-mode', playlistId: likedPlaylist.id })
  }, [likedPlaylist, neteaseCurrentSong, onPlaySongs])
  const dragonBlock = home?.blocks.find(block => block.showType.toUpperCase() === 'DRAGON_BALL' || block.blockCode.toUpperCase() === 'DRAGON_BALL' || /DRAGON.?BALL/.test(`${block.blockCode} ${block.showType}`.toUpperCase()))
  const shortcutSourceResources = [
    ...linkShortcuts,
    ...(dragonBlock?.resources || home?.blocks.find(block => block.resources.some(resource => neteaseShortcutKind(resource) !== null))?.resources || []),
  ]
  const shortcutLabels: Record<string, string> = {
    '每日推荐': '今日限定好歌推荐',
    '心动模式': '红心歌曲和相似推荐',
    '雷达歌单': '反复聆听你爱的歌',
    '漫游': '多样频道无限畅听',
    '相似歌曲': '从你喜欢的歌听起',
    '相似艺人': '从你喜欢的艺人听起',
  }
  const shortcutKindByTitle: Record<string, ReturnType<typeof neteaseShortcutKind>> = {
    '每日推荐': 'daily',
    '心动模式': 'heart-mode',
    '雷达歌单': 'radar',
    '漫游': 'roam',
    '相似歌曲': 'similar',
    '相似艺人': 'similar-user',
  }
  // 推荐页主内容优先使用 Link Platform 下发的真实区块；旧协议仅作降级
  const linkContentBlocks = (linkHome?.blocks || []).filter(block => !/GREETING|DAILY_RECOMMEND/.test((block.blockCode || '').toUpperCase()))
  const legacyContentBlocks = (home?.blocks || []).filter(block => block !== dragonBlock)
    .filter(block => block.resources.length > 0 || block.title)
  const contentBlocks = linkContentBlocks.length > 0 ? linkContentBlocks : legacyContentBlocks
  // 顶部六张卡的封面兜底：Link Platform 快捷块常被服务端按日去重，缺图时用实时数据补
  const dailyRecommendBlock = (linkHome?.blocks || []).find(block => /DAILY_RECOMMEND/.test((block.blockCode || '').toUpperCase()))
  const shortcutArtworkFallback: Record<string, string> = {
    '每日推荐': dailyRecommendBlock?.resources[0]?.coverUrl || '',
    '心动模式': likedPlaylist?.coverUrl || '',
    '雷达歌单': radarPlaylist?.coverUrl || '',
    '相似歌曲': neteaseCurrentSong?.album?.picUrl || '',
  }

  const runEntry = useCallback(async (name: string, task: () => Promise<void>) => {
    if (entryLoading) return
    setEntryLoading(name)
    setHomeError('')
    try { await task() } catch (error) { setHomeError(error instanceof Error ? error.message : `${name}加载失败`) } finally { setEntryLoading('') }
  }, [entryLoading])

  const requireLogin = () => {
    if (verifiedAccount) return true
    onLogin()
    return false
  }

  // 每日推荐面板保持挂载：同一天已经拉过就不再重发请求，仅重新显示（历史/风格子 Tab 的状态也保留）。
  const openDailyRecommend = useCallback(async () => {
    const day = new Date().toDateString()
    if (dailyLoadedRef.current === day) { setDailyVisible(true); return }
    const songs = await fetchNeteaseDailySongs()
    if (!songs.length) throw new Error('今日暂无推荐')
    dailyLoadedRef.current = day
    setDailySongs(songs)
    setDailyVisible(true)
  }, [])

  const openSimilar = async () => {
    if (!neteaseCurrentSong) throw new Error('请先播放一首网易云歌曲')
    const key = String(neteaseCurrentSong.id)
    // 同一首歌已经有数据：面板保持挂载，直接复用，不再重新请求
    if (similarKeyRef.current === key && similar && !similar.error
      && (similar.songs.length > 0 || similar.playlists.length > 0 || similar.users.length > 0)) {
      setSimilarVisible(true)
      return
    }
    setSimilarVisible(true)
    setSimilar({ ...EMPTY_SIMILAR, loading: true })
    try {
      const result = normalizeSimilarPayload(await fetchNeteaseSimilarContext(neteaseCurrentSong.id))
      similarKeyRef.current = key
      setSimilar({ ...result, loading: false, error: '' })
    } catch (error) {
      setSimilar({ ...EMPTY_SIMILAR, error: error instanceof Error ? error.message : '相似推荐加载失败' })
    }
  }

  const openUser = async (id: string) => {
    const key = String(id)
    // 同一个用户已经有资料：直接复用（面板冻结，不重复拉详情与歌单）
    if (profileKeyRef.current === key && profile?.profile) { setProfileVisible(true); return }
    setProfileVisible(true)
    setProfileLoading(true)
    setProfilePlaylists(null)
    try {
      const result = await fetchNeteaseUserDetail(id)
      if (!result?.profile) throw new Error('用户资料加载失败')
      profileKeyRef.current = key
      setProfile(result)
      // 用户主页的歌单是二级入口：并行拉取，失败不阻断资料展示
      void fetchNeteaseUserPlaylists(id)
        .then(list => setProfilePlaylists(list))
        .catch(() => setProfilePlaylists([]))
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : '用户资料加载失败')
    } finally { setProfileLoading(false) }
  }

  const executeResource = useCallback(async (resource: NeteaseNativeResource, queue: NeteaseNativeResource[]) => {
    const action = resource.action
    const queueSongs = queue.map(item => item.song).filter((song): song is Song => Boolean(song))
    switch (action.type) {
      case 'song': {
        // 单曲卡自带整栏播放队列（实测「根据你喜爱的歌曲推荐」的 clickAction/playBtn 里
        // 带着该栏 18 首完整队列）：App 点一张卡播整栏，这里按队列拉详情后从点击项起播。
        const playQueue = resource.playQueue
        if (playQueue && playQueue.ids.length > 1) {
          const songs = await fetchNeteaseSongDetail(playQueue.ids)
          if (songs.length > 0) {
            const start = Math.min(playQueue.start, songs.length - 1)
            onPlaySongs(songs[start], songs, true)
            return
          }
        }
        onPlaySongs(action.song, queueSongs.length ? queueSongs : [action.song]); return
      }
      case 'comments': onViewComments?.(action.song); return
      case 'playlist': onOpenPlaylist(action.playlist, action.autoplay); return
      case 'album': onOpenAlbum?.(action.id); return
      case 'radio': onOpenChannel(action.channel); return
      case 'program': {
        const song = await fetchNeteaseProgramSong(action.id)
        if (!song) throw new Error('节目暂时无法播放')
        // App 语义（实机验证）：播客栏位点一集，整栏节目按展示顺序进播放列表
        const siblingIds = queue
          .filter(item => item !== resource && item.action.type === 'program' && item.action.id && item.action.id !== action.id)
          .map(item => (item.action as { id: string }).id)
        const siblings = siblingIds.length ? await fetchNeteaseProgramSongs(siblingIds) : []
        onPlaySongs(song, [song, ...siblings])
        return
      }
      case 'artist': onOpenArtist?.(action.id); return
      case 'user': await openUser(action.id); return
      case 'mv': onOpenMV(action.id); return
      case 'web': {
        // 站内网页面板，不再跳系统浏览器
        setWebTarget({ url: action.url, title: resource.title })
        return
      }
      case 'podcast-section': podcastSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return
      case 'daily-rcmd': {
        if (action.tab === 'style') {
          const songs = await fetchNeteaseDailyStyleSongs(action.categoryId, action.tagId, Number(action.songId) || 0)
          if (!songs.length) throw new Error('风格日推暂无歌曲')
          onPlaySongs(songs[0], songs, true)
          return
        }
        await openDailyRecommend()
        return
      }
      case 'semantic': {
        const text = action.text
        if (/云村出品/.test(text)) {
          setActiveTab('discover')
          setDiscoverTab('music')
          setDiscoverJump(previous => ({ tab: 'music', channelCode: 'playlist', token: (previous?.token || 0) + 1 }))
          return
        }
        if (/排行榜|榜单/.test(text)) {
          setActiveTab('discover')
          setDiscoverTab('music')
          setDiscoverJump(previous => ({ tab: 'music', channelCode: 'chart', token: (previous?.token || 0) + 1 }))
          return
        }
        if (/新歌新碟|新歌|新碟/.test(text)) {
          setActiveTab('discover')
          setDiscoverTab('music')
          setDiscoverJump(previous => ({ tab: 'music', channelCode: 'feature', token: (previous?.token || 0) + 1 }))
          return
        }
        if (/每日推荐|日推/.test(text)) {
          await openDailyRecommend()
          return
        }
        if (/心动/.test(text)) {
          await startHeartMode()
          return
        }
        if (/漫游|私人/.test(text)) {
          const songs = await fetchNeteaseRoam(undefined, { unplaySongIds: roamPlayedIds })
          if (!songs.length) throw new Error('私人漫游暂无歌曲')
          setRoamPlayedIds(previous => [...new Set([...previous, ...songs.map(song => String(song.id))])].slice(-100))
          onPlaySongs(songs[0], songs, true, { mode: 'roam' })
          return
        }
        throw new Error(`${text || '该内容'}暂不支持在 WaveForge 内打开`)
      }
      case 'fm': {
        const songs = await fetchNeteaseRoam(undefined, { mode: action.fmMode, subMode: action.subMode, limit: 30 })
        if (!songs.length) throw new Error(`${action.title || '该频道'}暂无歌曲`)
        onPlaySongs(songs[0], songs, true, { mode: 'roam' })
        return
      }
      case 'cube-page': {
        setActiveTab('discover')
        setDiscoverTab('music')
        setCubePageRequest(previous => ({ pageId: action.pageId, title: action.title || '网易云页面', token: (previous?.token || 0) + 1 }))
        return
      }
      case 'song-id': {
        const songs = await fetchNeteaseSongDetail([action.id])
        if (!songs.length) throw new Error('歌曲详情加载失败')
        onPlaySongs(songs[0], songs, true)
        return
      }
      case 'similar-songs': {
        const songs = await fetchNeteaseSimilarSongs(action.seedIds)
        if (!songs.length) throw new Error('相似歌曲暂无内容')
        onPlaySongs(songs[0], songs, true)
        return
      }
      case 'similar-artists': {
        const songs = await fetchNeteaseArtistRadio(action.artistIds)
        if (!songs.length) throw new Error('相似艺人暂无内容')
        onPlaySongs(songs[0], songs, true)
        return
      }
      case 'none': setHomeError(`${resource.title} 暂不支持在 WaveForge 内打开`)
    }
  }, [likedPlaylist, neteaseCurrentSong, onOpenAlbum, onOpenArtist, onOpenChannel, onOpenMV, onOpenPlaylist, onPlaySongs, onViewComments, openDailyRecommend, roamPlayedIds, startHeartMode])

  const isSongFavorite = useCallback((resource: NeteaseNativeResource) => {
    const song = resource.song
    if (!song) return false
    const key = String(song.id)
    if (favoriteOverrides.has(key)) return Boolean(favoriteOverrides.get(key))
    const authoritativeFavorite = getFavoriteSongIdentifiers(song).some(identifier => favoriteIds.has(identifier))
    return favoritesReady ? authoritativeFavorite : Boolean(resource.isFavorite || authoritativeFavorite)
  }, [favoriteIds, favoriteOverrides, favoritesReady])

  const toggleFavorite = useCallback(async (event: React.MouseEvent, resource: NeteaseNativeResource) => {
    event.preventDefault()
    event.stopPropagation()
    const song = resource.song
    if (!song || !verifiedAccount || !favoritesReady) {
      if (!verifiedAccount) onLogin()
      return
    }
    const key = String(song.id)
    if (favoritePendingRef.current.has(key)) return
    const current = isSongFavorite(resource)
    const previousOverride = favoriteOverrides.get(key)
    favoritePendingRef.current.add(key)
    setFavoritePending(previous => new Set(previous).add(key))
    setFavoriteOverrides(previous => new Map(previous).set(key, !current))
    setRedCounts(previous => {
      const baseline = previous.get(key) ?? resource.favoriteCount
      if (baseline === undefined) return previous
      return new Map(previous).set(key, Math.max(0, baseline + (current ? -1 : 1)))
    })
    try {
      const result = current ? await onRemoveFromFavorites?.(song) : await onAddToFavorites?.(song)
      if (result === false || (current ? !onRemoveFromFavorites : !onAddToFavorites)) throw new Error(current ? '取消喜欢失败' : '添加到喜欢失败')
      setFavoriteIds(previous => {
        const next = new Set(previous)
        getFavoriteSongIdentifiers(song).forEach(identifier => { if (current) next.delete(identifier); else next.add(identifier) })
        return next
      })
    } catch (error) {
      setFavoriteOverrides(previous => {
        const next = new Map(previous)
        if (previousOverride === undefined) next.delete(key); else next.set(key, previousOverride)
        return next
      })
      setRedCounts(previous => {
        const value = previous.get(key)
        if (value === undefined) return previous
        return new Map(previous).set(key, Math.max(0, value + (current ? 1 : -1)))
      })
      setHomeError(error instanceof Error ? error.message : '收藏状态更新失败')
    } finally {
      favoritePendingRef.current.delete(key)
      setFavoritePending(previous => { const next = new Set(previous); next.delete(key); return next })
    }
  }, [favoriteOverrides, favoritesReady, isSongFavorite, onAddToFavorites, onLogin, onRemoveFromFavorites, verifiedAccount])

  const callbacks = useMemo(() => ({
    onExecute: (resource: NeteaseNativeResource, queue: NeteaseNativeResource[]) => { void executeResource(resource, queue).catch(error => setHomeError(error instanceof Error ? error.message : '内容打开失败')) },
    onSongContextMenu,
    onPlaylistContextMenu,
    isSongFavorite,
    isFavoritePending: (song: Song) => favoritePending.has(String(song.id)),
    onToggleFavorite: (event: React.MouseEvent, resource: NeteaseNativeResource) => { void toggleFavorite(event, resource) },
    favoriteCount: (resource: NeteaseNativeResource) => resource.song ? redCounts.get(String(resource.song.id)) ?? resource.favoriteCount : resource.favoriteCount,
    entitlement,
    onOpenResourceDetail: (resource: NeteaseNativeResource) => {
      const kind = resource.action.type === 'radio' ? 'radio' : resource.action.type === 'program' ? 'program' : ''
      if (!kind) return
      setRadioDetail({ kind, id: String(resource.id), title: resource.title, coverUrl: resource.coverUrl })
      setRadioDetailVisible(true)
    },
    onBlockMore: (block: NeteaseNativeBlock) => {
      const target = neteaseBlockMoreTarget(block)
      if (!target) return
      if (target.kind === 'artist') { onOpenArtist?.(target.artistId); return }
      setActiveTab('discover')
      setDiscoverTab(target.tab)
      setDiscoverJump(previous => ({ tab: target.tab, channelCode: target.channelCode, token: (previous?.token || 0) + 1 }))
    },
  }), [entitlement, executeResource, favoritePending, isSongFavorite, onOpenArtist, onPlaylistContextMenu, onSongContextMenu, redCounts, toggleFavorite])

  // 发现页不显示「更多」（App 里发现页区块没有更多入口）
  const discoverCallbacks = useMemo(() => ({ ...callbacks, onBlockMore: undefined }), [callbacks])

  const loadMoreHome = async () => {
    if (!home?.hasMore || !home.cursor || loadingMoreHome) return
    setLoadingMoreHome(true)
    try {
      const next = await fetchNeteaseNativeHome(false, undefined, {
        ...home,
        exposedResource: JSON.stringify([...exposedResourcesRef.current]),
      })
      const seen = new Set(home.blocks.map(block => `${block.blockCode}:${block.id}`))
      const existingResourceKeys = new Set(home.blocks.flatMap(block => block.resources.map(neteaseResourceKey)))
      const additions = next.blocks
        .filter(block => !seen.has(`${block.blockCode}:${block.id}`))
        .map(block => ({ ...block, resources: block.resources.filter(resource => {
          const key = neteaseResourceKey(resource)
          if (existingResourceKeys.has(key)) return false
          existingResourceKeys.add(key)
          return true
        }) }))
        .filter(block => block.resources.length > 0 || block.title)
      setHome({ ...next, blocks: [...home.blocks, ...additions], rawBlocks: [...home.rawBlocks, ...next.rawBlocks] })
    } catch (error) { setHomeError(error instanceof Error ? error.message : '更多推荐加载失败') } finally { setLoadingMoreHome(false) }
  }

  const loadMoreLink = async () => {
    if (!linkHome?.hasMore || !linkHome.cursor || loadingMoreLink) return
    setLoadingMoreLink(true)
    try {
      // 翻页必须回传上一页 blockCodeOrderList（服务端要求），并带上已展示区块（与 App 行为一致）
      const payload = await fetchNeteaseLinkPage(
        'HOME_RECOMMEND_PAGE',
        linkHome.cursor,
        false,
        undefined,
        linkHome.blockCodeOrderList,
        linkHome.blocks.map(block => block.blockCode).filter(Boolean),
      )
      const next = normalizeNeteaseLinkPage(payload)
      const seen = new Set(linkHome.blocks.map(block => block.blockCode))
      const additions = next.blocks.filter(block => {
        if (seen.has(block.blockCode)) return false
        seen.add(block.blockCode)
        return true
      })
      setLinkHome({
        ...linkHome,
        cursor: next.cursor || linkHome.cursor,
        hasMore: next.hasMore,
        blockCodeOrderList: next.blockCodeOrderList.length ? next.blockCodeOrderList : linkHome.blockCodeOrderList,
        blocks: [...linkHome.blocks, ...additions],
        rawBlocks: [...linkHome.rawBlocks, ...next.rawBlocks],
      })
    } catch (error) {
      setHomeError(error instanceof Error ? error.message : '加载更多推荐失败')
    } finally { setLoadingMoreLink(false) }
  }

  /** App 是无限滚动：每屏到底就自动续拉下一页。这里在后台把剩余页补满，
   *  否则用户只能看到第 1 页的 4~5 个区块，而 App 实际有 19+ 个。
   *  串行拉取以免打乱服务端要求的 blockCodeOrderList 链；失败静默，保留「加载更多」按钮兜底。 */
  const linkAutoFillActiveRef = useRef(false)
  const linkAutoFillCancelledRef = useRef(false)
  useEffect(() => {
    if (linkAutoFillActiveRef.current) return
    if (!linkHome?.hasMore || !linkHome.cursor || linkHome.blocks.length === 0) return
    linkAutoFillActiveRef.current = true
    void (async () => {
      let current = linkHome
      try {
        for (let page = 0; page < 12; page += 1) {
          if (linkAutoFillCancelledRef.current || !current.hasMore || !current.cursor) break
          const payload = await fetchNeteaseLinkPage(
            'HOME_RECOMMEND_PAGE',
            current.cursor,
            false,
            undefined,
            current.blockCodeOrderList,
            current.blocks.map(block => block.blockCode).filter(Boolean),
          )
          if (linkAutoFillCancelledRef.current) break
          const next = normalizeNeteaseLinkPage(payload)
          const seen = new Set(current.blocks.map(block => block.blockCode))
          const additions = next.blocks.filter(block => {
            if (seen.has(block.blockCode)) return false
            seen.add(block.blockCode)
            return true
          })
          const merged: NeteaseNativeHome = {
            ...current,
            cursor: next.cursor || current.cursor,
            hasMore: next.hasMore,
            blockCodeOrderList: next.blockCodeOrderList.length ? next.blockCodeOrderList : current.blockCodeOrderList,
            blocks: [...current.blocks, ...additions],
            rawBlocks: [...current.rawBlocks, ...next.rawBlocks],
          }
          // 服务端没有再推进就停止，避免空转
          if (additions.length === 0 && String(next.cursor) === String(current.cursor)) {
            setLinkHome({ ...merged, hasMore: false })
            break
          }
          current = merged
          setLinkHome(merged)
        }
      } catch {
        /* 静默：保留「加载更多推荐」按钮兜底 */
      } finally {
        linkAutoFillActiveRef.current = false
      }
    })()
    // 注意：这里**不能**在 cleanup 里取消循环——每拉一页都会 setLinkHome 触发本 effect 重跑，
    // cleanup 会立刻把循环掐断（实测只加载到第 2 页共 12 个区块就停）。
    // 用 activeRef 做单飞 + 组件卸载时才置 cancelled，保证整条链跑完。
  }, [linkHome])

  // 组件真正卸载时才终止续拉；切换账号时重新允许（新账号的 linkHome 会被置空后重拉）
  useEffect(() => () => { linkAutoFillCancelledRef.current = true }, [])
  useEffect(() => { linkAutoFillCancelledRef.current = false }, [accountKey])

  const loadMoreFlow = async () => {    if (!flow?.hasMore || flowLoading) return
    setFlowLoading(true)
    try {
      const seen = new Set(flow.resources.map(neteaseResourceKey))
      let resources = [...flow.resources]
      let hasMore: boolean = flow.hasMore
      // 服务端每批约 10 条且与上一批重叠，去重后行尾会缺角；继续取批直到刚好填满最后一行。
      for (let attempt = 0; attempt < 4 && hasMore && resources.length % FLOW_GRID_COLUMNS !== 0; attempt += 1) {
        const batch = await fetchNeteaseUnlimitedFlow()
        const additions = batch.resources.filter(item => {
          const key = neteaseResourceKey(item)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        if (additions.length === 0) { hasMore = false; break }
        resources = [...resources, ...additions]
        hasMore = batch.hasMore
      }
      setFlow({ hasMore, resources })
    } catch (error) { setFlowError(error instanceof Error ? error.message : '乐流加载失败') } finally { setFlowLoading(false) }
  }

  const fallbackResources = useMemo(() => {
    const songs = (publicContent?.dailySongs || []).map((song, index) => normalizeNeteaseResource({ resourceId: song.id, resourceType: 'song', songData: song, uiElement: { mainTitle: { title: song.name }, subTitle: { title: song.artists.map(artist => artist.name).join(' / ') }, image: { imageUrl: song.album.picUrl } } }, index)).filter((item): item is NeteaseNativeResource => Boolean(item))
    const playlists = (publicContent?.playlists || []).map((playlist, index) => normalizeNeteaseResource({ resourceId: playlist.id, resourceType: 'list', action: `orpheus://playlist/${playlist.id}`, uiElement: { mainTitle: { title: playlist.name }, subTitle: { title: playlist.description || '' }, image: { imageUrl: playlist.coverUrl } } }, index)).filter((item): item is NeteaseNativeResource => Boolean(item))
    return { songs, playlists }
  }, [publicContent])

  const flowResources = useMemo(() => {
    const list = flow?.resources || []
    if (list.length <= FLOW_GRID_COLUMNS) return list
    const remainder = list.length % FLOW_GRID_COLUMNS
    return remainder === 0 ? list : list.slice(0, list.length - remainder)
  }, [flow])

  // 封面墙封面源：整页已加载资源（首页推荐/播客/快捷入口/继续探索）的封面去重后回传。
  // ExploreView 侧只对「封面墙」偏好做兜底，这里多给一些（墙最多铺 28 张）。
  const artworkCovers = useMemo(() => {
    const resources = [
      ...(home?.blocks || []).flatMap(block => block.resources),
      ...linkShortcuts,
      ...(podcast?.blocks || []).flatMap(block => block.resources),
      ...(flow?.resources || []),
    ]
    return Array.from(new Set(resources.map(neteaseResourceArtwork).filter(Boolean))).slice(0, 48)
  }, [home, linkShortcuts, podcast, flow])

  useEffect(() => {
    onArtworkCovers?.(artworkCovers)
  }, [artworkCovers, onArtworkCovers])

  const shortcutResource = (title: string) => {
    const description = shortcutLabels[title] || ''
    return shortcutSourceResources.find(resource => resource.title.trim() === title)
      || (description ? shortcutSourceResources.find(resource => resource.subtitle.trim() === description) : undefined)
  }

  const playDailySongs = useCallback(async () => {
    const songs = await fetchNeteaseDailySongs()
    if (!songs.length) throw new Error('今日暂无推荐')
    onPlaySongs(songs[0], songs, true)
  }, [onPlaySongs])

  const playSimilarSongs = useCallback(async () => {
    // 优先用卡片自带的种子歌曲（App 语义：从你喜欢的歌听起，不依赖当前播放）
    const cardResource = linkShortcuts.find(resource => neteaseShortcutKind(resource) === 'similar')
    const seeds = cardResource && cardResource.action.type === 'similar-songs' ? cardResource.action.seedIds : []
    if (seeds.length > 0) {
      const songs = await fetchNeteaseSimilarSongs(seeds)
      if (!songs.length) throw new Error('相似歌曲暂无内容')
      onPlaySongs(songs[0], songs, true)
      return
    }
    if (!neteaseCurrentSong) throw new Error('请先播放一首网易云歌曲')
    const result = normalizeSimilarPayload(await fetchNeteaseSimilarContext(neteaseCurrentSong.id))
    if (!result.songs.length) throw new Error('当前歌曲暂无相似歌曲')
    onPlaySongs(result.songs[0], result.songs, true)
  }, [linkShortcuts, neteaseCurrentSong, onPlaySongs])

  const playSimilarArtists = useCallback(async () => {
    const cardResource = linkShortcuts.find(resource => neteaseShortcutKind(resource) === 'similar-user')
    const artistIds = cardResource && cardResource.action.type === 'similar-artists' ? cardResource.action.artistIds : []
    if (artistIds.length > 0) {
      const songs = await fetchNeteaseArtistRadio(artistIds)
      if (!songs.length) throw new Error('相似艺人暂无内容')
      onPlaySongs(songs[0], songs, true)
      return
    }
    await openSimilar()
  }, [linkShortcuts, onPlaySongs, openSimilar])

  const entryCards = useMemo(() => [
    { title: '每日推荐', subtitle: '今日限定好歌推荐', icon: Sparkles, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('每日推荐', openDailyRecommend) },
    { title: '心动模式', subtitle: '红心歌曲和相似推荐', icon: HeartPulse, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('心动模式', startHeartMode) },
    { title: '雷达歌单', subtitle: '反复聆听你爱的歌', icon: Trophy, enabled: verifiedAccount && Boolean(radarPlaylist), run: () => requireLogin() && radarPlaylist && onOpenPlaylist(radarPlaylist, true) },
    { title: '漫游', subtitle: '多样频道无限畅听', icon: Radio, enabled: verifiedAccount, run: () => requireLogin() && void runEntry('私人漫游', async () => { const songs = await fetchNeteaseRoam(undefined, { unplaySongIds: roamPlayedIds }); if (!songs.length) throw new Error('私人漫游暂无歌曲'); setRoamPlayedIds(previous => [...new Set([...previous, ...songs.map(song => String(song.id))])].slice(-100)); onPlaySongs(songs[0], songs, true, { mode: 'roam' }) }) },
    { title: '相似歌曲', subtitle: '从你喜欢的歌听起', icon: Disc3, enabled: true, run: () => void runEntry('相似歌曲', playSimilarSongs) },
    { title: '相似艺人', subtitle: '从你喜欢的艺人听起', icon: UserRoundSearch, enabled: true, run: () => void runEntry('相似艺人', playSimilarArtists) },
  ], [likedPlaylist, neteaseCurrentSong, onOpenPlaylist, onPlaySongs, openDailyRecommend, openSimilar, playSimilarArtists, playSimilarSongs, radarPlaylist, requireLogin, startHeartMode, roamPlayedIds, runEntry, verifiedAccount])

  const orderedEntryCards = useMemo(() => entryCards, [entryCards])

  return (
    <div ref={pageRef} className="space-y-10 pb-48">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-full border border-white/[0.09] bg-white/[0.035] p-1" role="tablist" aria-label="网易云探索分页">
          {([['recommend', Sparkles, '推荐'], ['discover', Compass, '发现']] as const).map(([key, Icon, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={activeTab === key}
              onClick={() => setActiveTab(key)}
              className={`flex h-10 items-center gap-2 rounded-full px-5 text-sm transition ${activeTab === key ? 'bg-white text-black' : 'text-white/55 hover:text-white/85'}`}
            >
              <Icon className="h-4 w-4" />{label}
            </button>
          ))}
        </div>
        {activeTab === 'discover' && (
          <div className="flex items-center gap-1" aria-label="发现分页">
            <ChevronRight className="h-4 w-4 text-white/28" />
            {([['music', Music2, '音乐'], ['podcast', Headphones, '播客']] as const).map(([key, Icon, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={discoverTab === key}
                onClick={() => { setDiscoverTab(key); setDiscoverJump(previous => ({ tab: key, token: (previous?.token || 0) + 1 })) }}
                className={`flex h-9 items-center gap-2 rounded-full px-4 text-sm transition ${discoverTab === key ? 'bg-white/[0.14] text-white' : 'text-white/50 hover:bg-white/[0.07] hover:text-white/85'}`}
              >
                <Icon className="h-4 w-4" />{label}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 推荐 / 发现两块都保持挂载，只切显示：来回切页签不再重建几百张卡片、也不再重拉频道数据 */}
      <div className={activeTab === 'discover' ? 'hidden' : 'contents'}>
        <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><div className="flex items-center gap-2 text-xs font-medium text-white/42"><Waves className="h-4 w-4" style={{ color: accent }} />网易云手机客户端推荐流</div><h2 className="mt-2 text-2xl font-semibold md:text-3xl">{sessionProfile?.nickname || username ? `${sessionProfile?.nickname || username}，` : ''}为你推荐</h2>{showDescription && <p className="mt-2 text-sm text-white/42">区块、顺序和资源由网易云移动端推荐服务实时下发。</p>}</div>
        <div className="flex items-center gap-2">{!verifiedAccount && <button type="button" onClick={onLogin} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] px-4 text-sm text-white/65"><LogIn className="h-4 w-4" />登录</button>}<button type="button" disabled={refreshing} onClick={() => {
          if (userId) {
            invalidateFavoriteIdentifiers('netease', userId)
            setFavoriteRefreshRevision(revision => revision + 1)
          }
          redCountRequestedRef.current.clear()
          setVisibleSongIds(new Set())
          void load(true)
        }} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.05] px-4 text-sm text-white/65 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />刷新推荐</button></div>
      </div>

      {homeError && <div role="alert" className="flex items-center gap-3 rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm"><AlertCircle className="h-4 w-4 text-rose-400" />{homeError}</div>}
      {!verifiedAccount && loggedIn && sessionVerified === false && <div className="rounded-md border border-amber-200/15 bg-amber-100/[0.05] px-4 py-3 text-sm text-amber-50/65">网易云账号凭据已经失效，请重新登录后刷新推荐。</div>}
      {!loggedIn && home && !home.accountScoped && <div className="rounded-md border border-amber-200/15 bg-amber-100/[0.05] px-4 py-3 text-sm text-amber-50/65">当前是网易云匿名推荐。登录后才会下发每日推荐、雷达歌单、关注艺人和账号口味模块。</div>}
      {loading && !home ? <NeteaseExploreSkeleton /> : (
        <>
          <section aria-label="网易云推荐快捷入口" aria-busy={Boolean(entryLoading)}>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] xl:gap-5 min-[1900px]:gap-6">
              {orderedEntryCards.map(({ title, subtitle, icon: Icon, enabled, run }, index) => {
                const shortcutKind = shortcutKindByTitle[title]
                const artwork = (shortcutKind ? linkShortcuts.find(resource => neteaseShortcutKind(resource) === shortcutKind) : undefined) || shortcutResource(title)
                const imageUrl = artwork ? neteaseResourceArtwork(artwork) : (shortcutArtworkFallback[title] || '')
                const displayTitle = title
                const displaySubtitle = shortcutLabels[title] || subtitle
                const hasDirectPlay = title === '每日推荐' || title === '雷达歌单' || title === '漫游'
                return (
                  <div
                    role="button"
                    tabIndex={enabled ? 0 : -1}
                    onKeyDown={event => {
                      if (enabled && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault()
                        if (title === '每日推荐') return void runEntry('每日推荐', openDailyRecommend)
                        if (title === '相似歌曲') return void runEntry('相似歌曲', playSimilarSongs)
                        if (title === '相似艺人') return void runEntry('相似艺人', playSimilarArtists)
                        run()
                      }
                    }}
                    onClick={event => {
                      event.stopPropagation()
                      if (!enabled) return
                      if (title === '每日推荐') return void runEntry('每日推荐', openDailyRecommend)
                      if (title === '相似歌曲') return void runEntry('相似歌曲', playSimilarSongs)
                      if (title === '相似艺人') return void runEntry('相似艺人', playSimilarArtists)
                      run()
                    }}
                    aria-disabled={!enabled}
                    className={`group relative aspect-[0.86/1] w-full overflow-hidden rounded-[6px] bg-[#d9d9d9] text-left shadow-[0_1px_2px_rgba(0,0,0,0.24)] transition ${!enabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer'} ${ENTRY_FOCUS}`}
                  >
                    {imageUrl ? <CachedImage src={imageUrl} alt="" platform="netease" retainPrevious lazy className="absolute inset-0 h-full w-full object-cover" role="card" priority={index < 4 ? 'visible' : undefined} fallback={<span className="absolute inset-0 bg-[#b8b4ae]" />} /> : <span className="absolute inset-0 flex items-center justify-center bg-[#b8b4ae]"><Icon className="h-9 w-9 text-white/55" /></span>}
                    <span className="absolute inset-x-0 bottom-0 h-[46%] bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.72))]" />
                    <span className="absolute inset-x-3 bottom-3 pr-7"><span className="block truncate text-[15px] font-semibold text-white">{displayTitle}</span><span className="mt-1 line-clamp-2 text-[11px] leading-4 text-white/78">{displaySubtitle}</span></span>
                    {entryLoading === title ? <Loader2 className="absolute bottom-4 right-3 h-4 w-4 animate-spin text-white" /> : hasDirectPlay && enabled && <button type="button" aria-label={`播放${title}`} onClick={event => { event.stopPropagation(); if (title === '每日推荐') void runEntry('每日推荐', playDailySongs); else run() }} className="absolute bottom-2 right-2 flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100 focus-visible:translate-y-0 focus-visible:opacity-100"><Play className="h-4 w-4 fill-current" /></button>}
                  </div>
                )
              })}
            </div>
          </section>
          <div className="space-y-12">{contentBlocks.map((block, index) => <NeteaseNativeBlockView key={`${block.id}-${index}`} block={block} callbacks={callbacks} />)}</div>
          {contentBlocks.length === 0 && (fallbackResources.songs.length > 0 || fallbackResources.playlists.length > 0) && <div className="space-y-12">{fallbackResources.songs.length > 0 && <NeteaseNativeBlockView block={{ id: 'fallback-songs', blockCode: 'FALLBACK_SONGS', showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN', title: '今日推荐', subtitle: '', resources: fallbackResources.songs, raw: {} }} callbacks={callbacks} />}{fallbackResources.playlists.length > 0 && <NeteaseNativeBlockView block={{ id: 'fallback-playlists', blockCode: 'FALLBACK_PLAYLISTS', showType: 'HOMEPAGE_SLIDE_PLAYLIST', title: '推荐歌单', subtitle: '', resources: fallbackResources.playlists, raw: {} }} callbacks={callbacks} />}</div>}
          {linkHome?.hasMore && linkHome.cursor && linkHome.blocks.length > 0 && <div className="flex justify-center"><button type="button" disabled={loadingMoreLink} onClick={() => void loadMoreLink()} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] px-5 text-sm text-white/60 disabled:opacity-50">{loadingMoreLink && <Loader2 className="h-4 w-4 animate-spin" />}加载更多推荐</button></div>}
          {linkContentBlocks.length === 0 && home?.hasMore && home.cursor && <div className="flex justify-center"><button type="button" disabled={loadingMoreHome} onClick={() => void loadMoreHome()} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] px-5 text-sm text-white/60 disabled:opacity-50">{loadingMoreHome && <Loader2 className="h-4 w-4 animate-spin" />}加载更多推荐</button></div>}
        </>
      )}

      <section><div className="mb-4 flex items-center gap-2"><Sparkles className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">继续探索</h3></div>{flowError ? <div className="flex items-center justify-between rounded-md border border-white/[0.07] px-4 py-3 text-sm text-white/50"><span>{flowError}</span><button type="button" onClick={() => void load(false)}>重试</button></div> : flowResources.length ? <><NeteaseFlowGrid resources={flowResources} callbacks={callbacks} />{flow?.hasMore && <div className="mt-5 flex justify-center"><button type="button" disabled={flowLoading} onClick={() => void loadMoreFlow()} className="flex h-10 items-center gap-2 rounded-full border border-white/[0.09] px-5 text-sm text-white/60 disabled:opacity-50">{flowLoading && <Loader2 className="h-4 w-4 animate-spin" />}加载更多乐流</button></div>}</> : <p className="text-sm text-white/38">暂无更多内容</p>}</section>

      <section ref={podcastSectionRef}>
        <div className="mb-5 flex items-center gap-2"><Mic2 className="h-5 w-5" style={{ color: accent }} /><h3 className="text-xl font-semibold">播客推荐</h3></div>
        {podcastError
          ? <div className="rounded-md border border-white/[0.07] px-4 py-3 text-sm text-white/50">{podcastError}</div>
          : podcast?.blocks.length
            ? <div className="space-y-10">{(() => {
                const seen = new Set<string>()
                return podcast.blocks
                  .filter(block => !/DRAGONBALL/i.test(block.blockCode))
                  .map((block, index) => ({ ...block, resources: block.resources.filter(resource => { const key = neteaseResourceKey(resource); if (seen.has(key)) return false; seen.add(key); return true }) })).filter(block => block.resources.length > 0).map((block, index) => <NeteaseNativeBlockView key={`${block.id}-${index}`} block={block} callbacks={callbacks} />)
              })()}</div>
            : <p className="text-sm text-white/38">暂无播客推荐</p>}
      </section>

      </>
      </div>

      {(discoverVisited || activeTab === 'discover') && (
        <div className={activeTab === 'discover' ? 'contents' : 'hidden'}>
          <NeteaseDiscoverView accent={accent} callbacks={discoverCallbacks} accountUserId={accountUserId} tab={discoverTab} onTabChange={setDiscoverTab} jump={discoverJump || undefined} cubePage={cubePageRequest || undefined} />
        </div>
      )}

      {webTarget && <NeteaseWebPanel target={webTarget} onClose={() => setWebTarget(null)} />}

      {/* 二级面板保持挂载：关闭只隐藏，不卸载（数据/子级导航状态都保留，重开同一目标不再重发请求） */}
      {radioDetail && (
        <div className={radioDetailVisible ? 'contents' : 'hidden'} aria-hidden={!radioDetailVisible}>
          <NeteaseRadioDetailPanel
            target={radioDetail}
            onClose={() => setRadioDetailVisible(false)}
            onOpenRadio={(radioId, name) => setRadioDetail({ kind: 'radio', id: radioId, title: name })}
            onOpenUser={(userId) => { setRadioDetailVisible(false); void openUser(userId) }}
          />
        </div>
      )}

      {dailySongs && (
        <div className={dailyVisible ? 'contents' : 'hidden'} aria-hidden={!dailyVisible}>
          <NeteaseDailyRecommendPanel initialSongs={dailySongs} entitlement={entitlement} onClose={() => setDailyVisible(false)} onPlaySongs={(song, songs) => onPlaySongs(song, songs)} onSongContextMenu={(event, song, songs) => onSongContextMenu(event, song, songs)} />
        </div>
      )}

      {similar && (<div className={similarVisible ? 'contents' : 'hidden'} aria-hidden={!similarVisible}><div className="fixed inset-0 z-[175] flex items-center justify-center bg-black/65 p-5 backdrop-blur-xl" onClick={() => setSimilarVisible(false)}><div className="flex max-h-[86vh] w-full max-w-5xl flex-col overflow-hidden rounded-md border border-white/[0.1] bg-[#0d1118] text-white" onClick={event => event.stopPropagation()}><div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4"><div><h3 className="font-semibold">相似推荐</h3><p className="mt-1 text-xs text-white/38">基于当前歌曲，同时获取歌曲、歌单和用户</p></div><button type="button" onClick={() => setSimilarVisible(false)} aria-label="关闭相似推荐"><X className="h-5 w-5" /></button></div><div className="overflow-y-auto p-5">{similar.loading ? <div className="flex min-h-64 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : similar.error ? <p className="text-sm text-rose-200">{similar.error}</p> : <div className="space-y-8">{similar.songs.length > 0 && <section><h4 className="mb-3 font-medium">相似歌曲</h4><div className="grid gap-2 md:grid-cols-2">{similar.songs.map((song, index) => <button key={song.id} type="button" onClick={() => onPlaySongs(song, similar.songs, true)} onContextMenu={event => onSongContextMenu(event, song, similar.songs, true)} className="flex items-center gap-3 rounded-md p-2 text-left hover:bg-white/[0.06]"><CachedImage src={song.album.picUrl} alt="" className="h-12 w-12 rounded-md" role="row" priority={index < 3 ? 'visible' : undefined} /><span className="min-w-0"><span className="block truncate text-sm">{song.name}</span><span className="block truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</span></span><SongRestrictionBadges song={song} entitlement={entitlement} /></button>)}</div></section>}{similar.playlists.length > 0 && <section><h4 className="mb-3 font-medium">相关歌单</h4><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{similar.playlists.map(item => <button key={item.id} type="button" onClick={() => onOpenPlaylist(item)} className="text-left"><CachedImage src={item.coverUrl} alt="" className="aspect-square w-full rounded-md" role="card" /><span className="mt-2 block line-clamp-2 text-sm">{item.name}</span></button>)}</div></section>}{similar.users.length > 0 && <section><h4 className="mb-3 font-medium">相似用户</h4><div className="grid gap-3 md:grid-cols-3">{similar.users.map(user => <button key={user.id} type="button" onClick={() => void openUser(user.id)} className="flex items-center gap-3 rounded-md border border-white/[0.07] p-3 text-left"><CachedImage src={user.avatarUrl} alt="" className="h-12 w-12 rounded-full" role="compact" /><span className="min-w-0"><span className="block truncate text-sm">{user.name}</span><span className="block truncate text-xs text-white/38">{user.signature}</span></span></button>)}</div></section>}{similar.songs.length === 0 && similar.playlists.length === 0 && similar.users.length === 0 && <p className="py-16 text-center text-sm text-white/45">当前歌曲暂无相似推荐</p>}</div>}</div></div></div></div>)}

      {(profile || profileLoading) && (<div className={profileVisible ? 'contents' : 'hidden'} aria-hidden={!profileVisible}><div className="fixed inset-0 z-[180] flex items-center justify-center bg-black/65 p-5 backdrop-blur-xl" onClick={() => setProfileVisible(false)}><div className="flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-md border border-white/[0.1] bg-[#0d1118] text-white" onClick={event => event.stopPropagation()}>{profileLoading ? <div className="flex min-h-48 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin" /></div> : <><div className="p-6 pb-4"><div className="flex items-start justify-between"><div className="flex min-w-0 items-center gap-4"><CachedImage src={profile.profile.avatarUrl} alt="" className="h-16 w-16 rounded-full" role="hero" priority="visible" /><div className="min-w-0"><h3 className="truncate text-lg font-semibold">{profile.profile.nickname}</h3><p className="mt-1 text-xs text-white/38">Lv.{profile.level || 0} · {profile.profile.follows || 0} 关注 · {profile.profile.followeds || 0} 粉丝</p></div></div><button type="button" onClick={() => setProfileVisible(false)} aria-label="关闭用户资料"><X className="h-5 w-5" /></button></div><p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-white/55">{profile.profile.signature || '这个用户还没有填写个人介绍。'}</p></div>{profilePlaylists === null ? <div className="flex min-h-24 items-center justify-center border-t border-white/[0.07]"><Loader2 className="h-5 w-5 animate-spin text-white/40" /></div> : profilePlaylists.length > 0 ? <div className="overflow-y-auto border-t border-white/[0.07] p-6 pt-5"><h4 className="mb-3 flex items-center gap-2 text-sm font-medium text-white/70">TA 的歌单<span className="text-xs font-normal text-white/35">{profilePlaylists.length}</span></h4><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">{profilePlaylists.slice(0, 24).map((item: any) => <button key={String(item.id)} type="button" onClick={() => { setProfileVisible(false); onOpenPlaylist({ id: String(item.id), name: String(item.name || '歌单'), coverUrl: String(item.coverImgUrl || item.picUrl || '').replace(/^http:/, 'https:'), description: String(item.description || ''), playCount: Number(item.playCount || 0) || undefined, trackCount: Number(item.trackCount || 0) || undefined, creator: item.creator?.nickname, platform: 'netease' as const, source: 'netease-user-profile' }) }} className="text-left"><CachedImage src={String(item.coverImgUrl || item.picUrl || '').replace(/^http:/, 'https:')} alt="" className="aspect-square w-full rounded-md" role="card" /><span className="mt-2 line-clamp-2 text-xs leading-snug text-white/80">{item.name}</span></button>)}</div></div> : <p className="border-t border-white/[0.07] px-6 py-4 text-xs text-white/38">TA 还没有公开歌单</p>}</>}</div></div></div>)}
    </div>
  )
}
