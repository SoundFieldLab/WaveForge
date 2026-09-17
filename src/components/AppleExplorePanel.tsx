/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 专属探索面板（1:1 复刻 music.apple.com 的 主页 / 新发现 / 广播 / 资料库）
 *
 * - 主页：listen-now 个性化组（最近播放 / 专属推荐 / 口味组…），首项为 powerswoosh 大卡
 * - 新发现：编辑徽章卡网格（designBadge：推荐歌单/新专辑/新单曲…）+ 宽幅横幅 + 歌曲网格 + 排行榜
 * - 广播：推荐单集宽幅大卡 + 新近内容/热门电台/风格电台方卡网格 + 电台主持人节目卡
 * - 资料库：最近添加 / 艺人 / 专辑 / 歌曲 / 专属推荐
 *
 * 动作接线：
 * - 歌曲：点击播放（统一链路：AM 原生 → 网易云/QQ 载体回退）；♥ 喜欢；「…」右键菜单
 * - 歌单：点击打开详情（曲目可播）；＋ 收藏歌单；hover 播放动态封面（editorialVideo）
 * - 电台：点击站内直播播放（/v1/play/assets 取流 + HLS + Widevine EME）；
 *   封面 hover 显示「详情」按钮 → 电台详情抽屉（动态封面 / 描述 / 加入资料库 / 浏览器打开）
 *
 * 地区：固定使用账号商店（个性化内容绑定账号 storefront），无地区切换。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  Check, ChevronRight, Compass, Disc3, ExternalLink, Heart, Home, LayoutGrid, Library, ListMusic, Loader2, LogIn, MoreHorizontal, Play, Plus, Radio, Sparkles, Trophy, UserRound, X,
} from 'lucide-react'
import type { SongSelectHandler } from '../types/playbackNavigation'
import type { Song } from '../services/musicApi'
import type { AppleNativeStream } from '../services/applePlayback'
import {
  addAppleMusicVideoToLibrary,
  addApplePlaylistToLibrary,
  addAppleAlbumToLibrary,
  addAppleSongToLibrary,
  removeApplePlaylistFromLibrary,
  removeAppleResourceFromLibrary,
  appleStationToSong,
  appleWebItemToSong,
  fetchAppleBrowsePage,
  fetchAppleChartsPage,
  fetchAppleCuratorPage,
  fetchAppleGroupingPage,
  fetchAppleHomePage,
  fetchAppleLibraryPage,
  fetchAppleMultiRoomPage,
  fetchAppleResourceMotion,
  fetchApplePostDetail,
  fetchAppleRadioPage,
  fetchAppleRadioShowDetail,
  fetchAppleRecommendationContents,
  fetchAppleRoomPage,
  fetchAppleStationDetail,
  fetchLibraryAlbumTracksForPlay,
  fetchLibraryArtistAlbumsForDrawer,
  resolveExploreTarget,
  setAppleFavorite,
  type AppleCuratorPage,
  type AppleExploreTarget,
  type ApplePostDetail,
  type AppleRadioShowDetail,
  type AppleWebItem,
  type AppleWebPage,
  type AppleWebSection,
} from '../services/appleWebService'
import { getAppleLovedSongIds, removeAppleSongFromLibrary, type AppleLibraryAlbum } from '../services/appleCatalog'
import { applyFavoriteMutation } from '../services/favoriteStatusService'
import { useTvBack } from '../tv/tvCore'
import BrowseCategoriesLanding from './AppleSearchBrowse'
import AppleMusicSearchPage from './AppleMusicSearchPage'
import AppleVideoModal from './AppleVideoModal'
import { HorizontalShelf } from './apple-explore/HorizontalShelf'
import { resolveAppleCardMeta } from './apple-explore/cardMeta'
import CachedImage from './CachedImage'
import AnimatedArtworkCover from './AnimatedArtworkCover'

/** 把列表按每组 size 个切成"列"（官网歌曲轨是每列固定行数的横向分列布局）。 */
function chunkBy<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

/** 探索页站内嵌套层：room / grouping / multiroom / curator（可任意互相进入）。 */
type ExploreLayer = {
  kind: 'room' | 'grouping' | 'multiroom' | 'curator' | 'section'
  id: string
  name: string
  page: AppleWebPage | null
  curator?: AppleCuratorPage | null
  loading: boolean
}

function AppleExploreImage(props: React.ComponentProps<typeof CachedImage>) {
  return <CachedImage {...props} platform="apple" retainPrevious />
}

// ─────────────────────────── 动态封面 ───────────────────────────

/** 播放页以覆盖层覆盖探索页时置 true：面板内所有动态封面视频暂停取流/播放 */
const MotionSuspendContext = createContext(false)

/** 动态封面（web powerswoosh 同款）：HLS 流 → hls.js 播放；失败/无则静态帧/静态图 */
function DynamicCover({ item, className, iconClassName }: { item: AppleWebItem; className?: string; iconClassName?: string }) {
  const suspended = useContext(MotionSuspendContext)
  // suspended 只暂停/恢复已有 video（经 ref 读取），不进初始化 effect 依赖：
  // 否则播放页覆盖探索页、切歌局部刷新等每次挂起都会销毁重建 HLS，
  // 表现为"封面闪一下、动态封面从头播放"。
  const suspendedRef = useRef(suspended)
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const motionHls = item.motionArtworkUrl

  useEffect(() => {
    suspendedRef.current = suspended
    const video = videoRef.current
    if (!video) return
    if (suspended || document.hidden) video.pause()
    else void video.play().catch(() => undefined)
  }, [suspended])

  useEffect(() => {
    if (!motionHls || videoFailed) return
    let hls: { destroy: () => void; __visibilityCleanup?: () => void } | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { default: Hls } = await import('hls.js')
        if (cancelled || !videoRef.current) return
        if (!Hls.isSupported()) { setVideoFailed(true); return }
        const inst = new Hls({ autoStartLoad: true, capLevelToPlayerSize: true, maxBufferLength: 12, backBufferLength: 0 })
        hls = inst
        inst.loadSource(motionHls)
        inst.attachMedia(videoRef.current)
        inst.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled || document.hidden || suspendedRef.current) return
          void videoRef.current?.play().catch(() => undefined)
        })
        const onVisibilityChange = () => {
          const video = videoRef.current
          if (!video) return
          if (document.hidden || suspendedRef.current) video.pause()
          else void video.play().catch(() => undefined)
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        inst.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal && !cancelled) setVideoFailed(true)
        })
        if (cancelled) document.removeEventListener('visibilitychange', onVisibilityChange)
        else hls.__visibilityCleanup = () => document.removeEventListener('visibilitychange', onVisibilityChange)
      } catch {
        if (!cancelled) setVideoFailed(true)
      }
    })()
    return () => {
      cancelled = true
      try { hls?.__visibilityCleanup?.() } catch { /* 忽略 */ }
      try { hls?.destroy() } catch { /* 忽略 */ }
    }
  }, [motionHls, videoFailed])

  if (motionHls && !videoFailed) {
    return (
      <video
        ref={videoRef}
        poster={item.motionPosterUrl || item.artworkUrl || undefined}
        muted
        loop
        playsInline
        preload="metadata"
        className={className}
      />
    )
  }
  const staticSrc = item.motionPosterUrl || item.artworkUrl || item.heroArtworkUrl
  if (staticSrc) {
    return <img src={staticSrc} alt={item.name} loading="lazy" className={className} />
  }
  return (
    <div className={`${className} flex items-center justify-center bg-white/[0.06]`}>
      <MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} />
    </div>
  )
}

/** 歌单动态封面缓存（模块级：同页多卡共享，切 tab 不重复请求）。
 *  成功结果长期缓存；空结果（电台无动态图/请求早期失败）只保留 60s 负缓存后重试，
 *  避免启动早期一次失败就把卡片封面永久钉死成静态图。 */
const motionCache = new Map<string, { video?: string; poster?: string } | null>()
const motionCachedAt = new Map<string, number>()
const motionPending = new Map<string, Promise<{ video?: string; poster?: string } | null>>()
const MOTION_NULL_TTL_MS = 60_000

function loadResourceMotion(resourceType: 'playlists' | 'albums' | 'stations', resourceId: string, storefront: string): Promise<{ video?: string; poster?: string } | null> {
  const key = `${storefront}:${resourceType}:${resourceId}`
  if (motionCache.has(key)) {
    const cached = motionCache.get(key) ?? null
    if (cached || Date.now() - (motionCachedAt.get(key) || 0) < MOTION_NULL_TTL_MS) return Promise.resolve(cached)
    motionCache.delete(key)
    motionCachedAt.delete(key)
  }
  const pending = motionPending.get(key)
  if (pending) return pending
  const task = fetchAppleResourceMotion(resourceType, resourceId, storefront)
    .then(result => {
      motionCache.set(key, result)
      motionCachedAt.set(key, Date.now())
      motionPending.delete(key)
      return result
    })
    .catch(() => {
      motionCache.delete(key)
      motionCachedAt.delete(key)
      motionPending.delete(key)
      return null
    })
  motionPending.set(key, task)
  return task
}

/**
 * 歌单卡封面：静态图打底 + hover 时拉取 editorialVideo 动态封面并播放（web 同款交互）。
 * 鼠标移出暂停（不销毁，再次 hover 直接续播）。
 */
function MotionPlaylistCover({ item, storefront, className, iconClassName }: {
  item: AppleWebItem
  storefront: string
  className?: string
  iconClassName?: string
}) {
    const [motion, setMotion] = useState<{ video?: string; poster?: string } | null | undefined>(
    () => {
      const key = `${storefront}:playlists:${item.playId}`
      return motionCache.has(key) ? motionCache.get(key) ?? null : undefined
    },
  )
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<{ destroy: () => void } | null>(null)

  const start = useCallback(async () => {
    if (motion === null || videoFailed) return
    let videoUrl = motion?.video
    if (!videoUrl) {
      const loaded = await loadResourceMotion('playlists', item.playId, storefront)
      setMotion(loaded)
      if (!loaded) return
      videoUrl = loaded.video
    }
    if (!videoUrl) return
    const video = videoRef.current
    if (!video) return
    if (!hlsRef.current) {
      try {
        const { default: Hls } = await import('hls.js')
        if (!Hls.isSupported()) { setVideoFailed(true); return }
        const inst = new Hls({ autoStartLoad: false, capLevelToPlayerSize: true, maxBufferLength: 10, backBufferLength: 0 })
        hlsRef.current = inst
        inst.on(Hls.Events.MANIFEST_PARSED, () => { void videoRef.current?.play().catch(() => undefined) })
        inst.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal) setVideoFailed(true)
        })
        inst.loadSource(videoUrl)
        inst.attachMedia(video)
      } catch {
        setVideoFailed(true)
      }
    } else {
      void video.play().catch(() => undefined)
    }
  }, [motion, videoFailed, item.playId, storefront])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  useEffect(() => () => {
    try { hlsRef.current?.destroy() } catch { /* 忽略 */ }
  }, [])

  const showVideo = motion !== null && motion !== undefined && !videoFailed
  return (
    <div
      className={`relative overflow-hidden ${className || ''}`}
      onMouseEnter={() => { void start() }}
      onMouseLeave={pause}
    >
      <img
        src={motion?.poster || item.artworkUrl || ''}
        alt={item.name}
        loading="lazy"
        className="h-full w-full object-cover"
      />
      {showVideo && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="none"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {!item.artworkUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/[0.06]">
          <MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} />
        </div>
      )}
    </div>
  )
}

const isMotionResourceType = (type: AppleWebItem['type']): type is 'playlists' | 'albums' | 'stations' => type === 'playlists' || type === 'albums' || type === 'stations'

function MotionArtworkCover({ item, storefront, className, iconClassName }: {
  item: AppleWebItem
  storefront: string
  className?: string
  iconClassName?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // 一旦可见过就保持“可见资格”：IO 在货架/动画容器里可能来回抖动，
  // 播放资格若跟随闪烁会反复 pause 冻在海报帧。取流与播放都用粘性标记。
  const [everVisible, setEverVisible] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
    const [motion, setMotion] = useState<{ video?: string; poster?: string } | null | undefined>(
    item.motionArtworkUrl ? { video: item.motionArtworkUrl, poster: item.motionPosterUrl } : undefined,
  )
  const itemKey = `${storefront}:${item.type}:${item.playId || item.id}`
  // 动态封面按目录资源 id 拉取：playId 缺失时回退资源 id（与 openStation 的取 id 规则一致）。
  const motionResourceId = item.playId || item.id
  const motionSuspended = useContext(MotionSuspendContext)
  useEffect(() => {
    setMotion(item.motionArtworkUrl ? { video: item.motionArtworkUrl, poster: item.motionPosterUrl } : undefined)
  }, [itemKey, item.motionArtworkUrl, item.motionPosterUrl])
  const active = pageVisible && everVisible && !motionSuspended

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const node = hostRef.current
    if (!node) return
    const observer = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) setEverVisible(true)
    }, { rootMargin: '400px', threshold: 0 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!everVisible || motion !== undefined || !motionResourceId || !isMotionResourceType(item.type)) return
    let cancelled = false
    void loadResourceMotion(item.type, motionResourceId, storefront).then(result => {
      if (!cancelled) setMotion(result)
    }).catch(() => { if (!cancelled) setMotion(null) })
    return () => { cancelled = true }
  }, [everVisible, item.type, motion, motionResourceId, storefront])

  return (
    <div
      ref={hostRef}
      className={`relative overflow-hidden ${className || ''}`}
    >
      {/* 静态层固定用作品封面（不用动态封面预览帧），避免动态数据到达后画面自行"变一下"。 */}
      <AppleExploreImage src={item.artworkUrl || motion?.poster || ''} alt={item.name} className="h-full w-full object-cover" role="card" />
      {motion?.video && (
        <AnimatedArtworkCover
          videoUrl={motion.video}
          posterUrl={motion.poster}
          staticCoverUrl={item.artworkUrl}
          active={active}
          className="absolute inset-0 h-full w-full"
          objectFit="cover"
          onError={() => setMotion(null)}
        />
      )}
      {!item.artworkUrl && !motion?.poster && <div className="absolute inset-0 flex items-center justify-center bg-white/[0.06]"><MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} /></div>}
    </div>
  )
}


type AmTab = 'home' | 'browse' | 'radio' | 'categories' | 'charts' | 'library'

const TABS: Array<{ id: AmTab; label: string; icon: typeof Sparkles }> = [
  { id: 'home', label: '主页', icon: Sparkles },
  { id: 'browse', label: '新发现', icon: Compass },
  { id: 'radio', label: '广播', icon: Radio },
  { id: 'categories', label: '分类搜索', icon: LayoutGrid },
  { id: 'charts', label: '排行榜', icon: Trophy },
  { id: 'library', label: '资料库', icon: Library },
]

interface AppleExplorePanelProps {
  appleLoggedIn: boolean
  appleUsername: string
  appleAvatar?: string
  /** 账号 storefront（cn/us/hk/tw…），缺省 'cn' */
  defaultStorefront?: string
  /** 播放页覆盖探索页时置 true：暂停面板内所有动态封面视频流 */
  motionSuspended?: boolean
  accentColor?: string
  accentRgb?: string
  playerTheme?: 'light' | 'dark'
  onSongSelect: SongSelectHandler
  onLoginClick: () => void
  onVideoPlaybackStart?: () => void
  onOpenAlbum?: (albumId: string, platform: 'apple') => void
  /** 打开探索页现成歌单详情面板（PlaylistDetailPanel） */
  onOpenPlaylistPanel?: (playlist: { id: string; name: string; coverUrl?: string; creator?: string; trackCount?: number; description?: string; platform: 'apple'; isLibrary?: boolean }) => void
  /** 打开现成艺人详情（ArtistDetailModal） */
  onOpenArtistPanel?: (artistId: string, platform: 'apple') => void
  /** 歌曲「…」菜单（复用探索页 SongContextMenu） */
  onSongContextMenu?: (event: React.MouseEvent, song: Song, songs: Song[]) => void
  /** 从播放器返回时恢复 Apple 探索页签/局部详情。 */
  restorePlaybackOrigin?: (import('../types/playbackNavigation').PlaybackOrigin & { revision: number }) | null
  /** 探索页「刷新」按钮信号（变化时强制重载当前页签；AM 无「换一批」，刷新入口上移到探索页顶栏） */
  refreshSignal?: number
}

const PAGE_FETCHERS: Record<Exclude<AmTab, 'categories'>, (storefront: string) => Promise<AppleWebPage>> = {
  home: fetchAppleHomePage,
  browse: fetchAppleBrowsePage,
  radio: fetchAppleRadioPage,
  charts: fetchAppleChartsPage,
  library: fetchAppleLibraryPage,
}

/** 只有 catalog song 才能进入统一歌曲播放链路。 */
const isPlayableItem = (item: AppleWebItem) => item.type === 'songs' && Boolean(item.playId)

/** 歌曲时长（ms → m:ss；未知时留空，避免显示 0:00 造成误导）。 */
function formatDuration(durationMs?: number): string {
  if (!Number.isFinite(durationMs) || (durationMs as number) <= 0) return ''
  const totalSeconds = Math.round((durationMs as number) / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Apple audioTraits → 列表卡音质徽标（web 歌曲行同款；与歌曲详情保持一致） */
function songTraitLabel(item: AppleWebItem): string {
  const traits = item.audioTraits || []
  if (traits.includes('spatial')) return '空间音频'
  if (traits.includes('atmos')) return '杜比全景声'
  if (traits.includes('lossless') || traits.includes('lossless-alac') || traits.includes('hi-res-lossless')) return '无损'
  return ''
}

export function AppleExplorePanel({
  appleLoggedIn,
  appleUsername,
  defaultStorefront,
  accentColor = '#fa2d48',
  playerTheme = 'dark',
  onSongSelect,
  onLoginClick,
  onVideoPlaybackStart,
  onOpenAlbum,
  onOpenPlaylistPanel,
  onOpenArtistPanel,
  onSongContextMenu,
  restorePlaybackOrigin,
  refreshSignal,
  motionSuspended = false,
}: AppleExplorePanelProps) {
  const storefront = defaultStorefront || 'cn'
  const [tab, setTab] = useState<AmTab>('home')
  const [pages, setPages] = useState<Partial<Record<AmTab, AppleWebPage>>>({})
  /** 分类页重挂载信号（刷新用） */
  const [categoriesVersion, setCategoriesVersion] = useState(0)
  // 注意：初始必须全 false。loadTab 有「loading[target] 为 true 则跳过」的防重入保护，
  // 若 home 初始为 true，挂载时的 loadTab('home') 会直接 return，主页永远卡在骨架屏。
  const [loading, setLoading] = useState<Record<AmTab, boolean>>({ home: false, browse: false, radio: false, categories: false, charts: false, library: false })
  const [errors, setErrors] = useState<Partial<Record<AmTab, string>>>({})
  const [favorited, setFavorited] = useState<Set<string>>(() => new Set())
  const [savedPlaylists, setSavedPlaylists] = useState<Set<string>>(() => new Set())
  const [catalogLibraryIds, setCatalogLibraryIds] = useState<Map<string, string>>(() => new Map())
  const [libraryMutations, setLibraryMutations] = useState<Set<string>>(() => new Set())
  const [albumDrawer, setAlbumDrawer] = useState<{ album: AppleWebItem; tracks: Song[]; loadingTracks: boolean } | null>(null)
  const [artistDrawer, setArtistDrawer] = useState<{ artist: AppleWebItem; albums: AppleWebItem[]; loading: boolean } | null>(null)
  const [stationDetail, setStationDetail] = useState<{ station: AppleWebItem; loading: boolean } | null>(null)
  const [radioShowDetail, setRadioShowDetail] = useState<{ item: AppleWebItem; detail: AppleRadioShowDetail | null; loading: boolean } | null>(null)
  /** 排行榜抽屉（歌曲/专辑榜：点榜单卡打开完整排名列表） */
  const [chartDetail, setChartDetail] = useState<AppleWebSection | null>(null)
  /** 正在取流的电台 id（防连点重复请求） */
  const playingStationsRef = useRef<Set<string>>(new Set())
  /** 音乐视频播放弹窗（站内 webPlayback + HLS + Widevine） */
  const [videoItem, setVideoItem] = useState<AppleWebItem | null>(null)
  /** 帖子详情弹窗（艺人分享 /post/…） */
  const [postDetail, setPostDetail] = useState<{ item: AppleWebItem; detail: ApplePostDetail | null; loading: boolean } | null>(null)
  /**
   * 站内嵌套层级栈：room / grouping / multiroom / curator 可任意互相进入（官网实测 curator 页内还会出现 room），
   * 因此用有序栈而非单一 roomDetail，返回时逐层弹出。
   */
  const [layers, setLayers] = useState<ExploreLayer[]>([])
  const activeLayer = layers.length > 0 ? layers[layers.length - 1] : null
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 各层级（含 root）的滚动位置记忆：进入更深层时保存当前层，返回时恢复目标层。 */
  const scrollByLevelRef = useRef<Record<string, number>>({ root: 0 })
  const pendingScrollRef = useRef<number | null>(null)
  const levelKeyOf = (stack: ExploreLayer[]) => stack.length > 0
    ? `${stack.length}:${stack[stack.length - 1].kind}:${stack[stack.length - 1].id}`
    : 'root'
  const currentLevelKeyRef = useRef('root')
  currentLevelKeyRef.current = levelKeyOf(layers)

  /** 找到真实滚动容器（面板本身不一定可滚，通常是祖先节点）。 */
  const findScroller = useCallback((): HTMLElement | Window => {
    let el: HTMLElement | null = panelRef.current?.parentElement || null
    while (el) {
      const style = window.getComputedStyle(el)
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 4) return el
      el = el.parentElement
    }
    return window
  }, [])
  const readScroll = useCallback(() => {
    const scroller = findScroller()
    return scroller instanceof Window ? (window.scrollY || 0) : scroller.scrollTop
  }, [findScroller])
  const writeScroll = useCallback((value: number) => {
    const scroller = findScroller()
    if (scroller instanceof Window) window.scrollTo({ top: value })
    else scroller.scrollTop = value
  }, [findScroller])
  const pageContextRef = useRef(`${appleLoggedIn}:${storefront}`)
  const pageRequestRef = useRef<Record<Exclude<AmTab, 'categories'>, number>>({ home: 0, browse: 0, radio: 0, charts: 0, library: 0 })

  const isDark = playerTheme === 'dark'
  const cardBg = isDark ? 'bg-white/[0.05]' : 'bg-black/[0.04]'
  const cardBorder = isDark ? 'border-white/[0.09]' : 'border-black/[0.08]'
  const nativeLight = playerTheme === 'light'

  const loadTab = useCallback(async (target: Exclude<AmTab, 'categories'>, force = false) => {
    if (!force && (pages[target] || loading[target])) return
    const requestContext = pageContextRef.current
    const requestId = ++pageRequestRef.current[target]
    setLoading(prev => ({ ...prev, [target]: true }))
    setErrors(prev => ({ ...prev, [target]: undefined }))
    try {
      const page = await PAGE_FETCHERS[target](storefront)
      if (pageContextRef.current !== requestContext || pageRequestRef.current[target] !== requestId) return
      setPages(prev => ({ ...prev, [target]: page }))
    } catch (error) {
      if (pageContextRef.current !== requestContext || pageRequestRef.current[target] !== requestId) return
      setErrors(prev => ({ ...prev, [target]: error instanceof Error ? error.message : '加载失败' }))
    } finally {
      if (pageContextRef.current === requestContext && pageRequestRef.current[target] === requestId) {
        setLoading(prev => ({ ...prev, [target]: false }))
      }
    }
  }, [pages, loading, storefront])

  useEffect(() => {
    pageContextRef.current = `${appleLoggedIn}:${storefront}`
    for (const target of ['home', 'browse', 'radio', 'charts', 'library'] as const) pageRequestRef.current[target] += 1
    setPages({})
    setErrors({})
    setSavedPlaylists(new Set())
    setCatalogLibraryIds(new Map())
    setLibraryMutations(new Set())
    setLoading({ home: false, browse: false, radio: false, categories: false, charts: false, library: false })
    setCategoriesVersion(version => version + 1)
    setAlbumDrawer(null)
    setArtistDrawer(null)
    setStationDetail(null)
    setRadioShowDetail(null)
    setChartDetail(null)
    setVideoItem(null)
    setPostDetail(null)
    setLayers([])
    if (tab !== 'categories') void loadTab(tab, true)
  }, [appleLoggedIn, storefront]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'home' && tab !== 'categories') void loadTab(tab)
  }, [tab, loadTab])

  useEffect(() => {
    if (appleLoggedIn) void loadTab('library')
  }, [appleLoggedIn, loadTab])

  useEffect(() => {
    const libraryPage = pages.library
    if (!libraryPage) return
    const saved = new Set<string>()
    const libraryIds = new Map<string, string>()
    for (const item of libraryPage.sections.flatMap(section => section.items)) {
      if (!item.libraryId) continue
      const catalogId = item.catalogId || item.playId
      if (item.type === 'songs' || item.type === 'albums' || item.type === 'music-videos') {
        if (catalogId) saved.add(`lib:${item.type}:${catalogId}`)
      } else if (item.type === 'playlists' && catalogId) {
        saved.add(catalogId)
        if (item.libraryId) libraryIds.set(catalogId, item.libraryId)
      }
    }
    setSavedPlaylists(saved)
    setCatalogLibraryIds(libraryIds)
  }, [pages.library])

  useEffect(() => {
    if (!appleLoggedIn) {
      setFavorited(new Set())
      return
    }
    const visibleSongIds = [...new Set(
      Object.values(pages)
        .filter((page): page is AppleWebPage => Boolean(page))
        .flatMap(page => page.sections)
        .flatMap(section => section.items)
        .filter(item => item.type === 'songs' && item.playId)
        .map(item => item.playId),
    )]
    if (visibleSongIds.length === 0) {
      setFavorited(new Set())
      return
    }
    let cancelled = false
    void getAppleLovedSongIds(visibleSongIds).then(ids => {
      if (!cancelled) setFavorited(new Set(ids))
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [appleLoggedIn, pages, refreshSignal])

  useEffect(() => {
    const syncFavorite = (event: Event) => {
      const detail = (event as CustomEvent<{ platform?: string; type?: string; songId?: string | number }>).detail
      if (detail?.platform !== 'apple') return
      if (detail.type === 'library-add' || detail.type === 'playlist-list' || detail.type === 'add' || detail.type === 'remove') {
        void loadTab('library', true)
      }
      if (detail.type !== 'like' && detail.type !== 'unlike') return
      const songId = String(detail.songId || '')
      if (!songId) return
      setFavorited(previous => {
        const next = new Set(previous)
        if (detail.type === 'like') next.add(songId)
        else next.delete(songId)
        return next
      })
    }
    window.addEventListener('playlist-content-changed', syncFavorite)
    return () => window.removeEventListener('playlist-content-changed', syncFavorite)
  }, [loadTab])

  // 探索页顶栏「刷新」按钮（AM 无「换一批」）：信号变化时强制重载当前页签
  const refreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === refreshSignalRef.current) return
    refreshSignalRef.current = refreshSignal
    if (tab === 'categories') {
      // 分类页：重挂载搜索页触发重新拉取
      setCategoriesVersion(v => v + 1)
    } else {
      void loadTab(tab, true)
    }
  }, [refreshSignal, tab, loadTab])

  const currentPage = pages[tab]
  const currentLoading = loading[tab]
  const currentError = errors[tab]

  // ── 动作 ──

  const appleOrigin = useCallback((detail?: Record<string, unknown>) => ({
    mode: 'explore' as const,
    surface: 'explore-apple' as const,
    platform: 'apple' as const,
    detail: {
      tab,
      ...(activeLayer && activeLayer.kind === 'room' ? { room: { id: activeLayer.id, name: activeLayer.name } } : {}),
      ...(postDetail ? { postItem: postDetail.item } : {}),
      ...(chartDetail ? { chart: chartDetail } : {}),
      ...detail,
    },
  }), [activeLayer, chartDetail, postDetail, tab])

  const playItem = useCallback((item: AppleWebItem) => {
    if (!isPlayableItem(item)) return
    const song = appleWebItemToSong(item, storefront)
    void onSongSelect(song, [song], appleOrigin())
  }, [appleOrigin, onSongSelect, storefront])

  const playItemWithQueue = useCallback((item: AppleWebItem, items: AppleWebItem[]) => {
    if (!isPlayableItem(item)) return
    const songs = items
      .filter(entry => isPlayableItem(entry))
      .map(entry => appleWebItemToSong(entry, storefront))
    if (songs.length === 0) return
    void onSongSelect(appleWebItemToSong(item, storefront), songs, appleOrigin())
  }, [appleOrigin, onSongSelect, storefront])

  const openSongMenu = useCallback((event: React.MouseEvent, item: AppleWebItem, items: AppleWebItem[]) => {
    if (!onSongContextMenu || !item.playId || item.type !== 'songs') return
    const songs = items
      .filter(entry => entry.playId && entry.type === 'songs')
      .map(entry => appleWebItemToSong(entry, storefront))
    onSongContextMenu(event, appleWebItemToSong(item, storefront), songs.length > 0 ? songs : [appleWebItemToSong(item, storefront)])
  }, [onSongContextMenu, storefront])

  const toggleFavorite = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn) {
      onLoginClick()
      return
    }
    if (!isPlayableItem(item)) return
    const next = !favorited.has(item.playId)
    const ok = await setAppleFavorite('songs', item.playId, next)
    if (!ok) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '喜爱状态更新失败，请重试', type: 'error' } }))
      return
    }
    setFavorited(prev => {
      const clone = new Set(prev)
      if (next) clone.add(item.playId)
      else clone.delete(item.playId)
      return clone
    })
    const detail = { platform: 'apple' as const, type: next ? 'like' : 'unlike', songId: item.playId }
    applyFavoriteMutation(detail)
    window.dispatchEvent(new CustomEvent('playlist-content-changed', { detail }))
  }, [appleLoggedIn, favorited, onLoginClick])

  const openPlaylistPanel = useCallback((item: AppleWebItem) => {
    const detailId = item.isLibrary ? item.libraryId : item.playId
    if (!detailId || !onOpenPlaylistPanel) return
    onOpenPlaylistPanel({
      id: detailId,
      name: item.name,
      coverUrl: item.artworkUrl,
      creator: item.curatorName,
      trackCount: item.trackCount,
      description: item.description,
      platform: 'apple',
      isLibrary: item.isLibrary,
    })
  }, [onOpenPlaylistPanel])

  /** 库专辑 → 曲目抽屉（/v1/me/library/albums/{id}/tracks） */
  const openAlbumDrawer = useCallback(async (item: AppleWebItem) => {
    if (!item.libraryId) return
    setAlbumDrawer({ album: item, tracks: [], loadingTracks: true })
    const tracks = await fetchLibraryAlbumTracksForPlay(item.libraryId).catch(() => [])
    setAlbumDrawer(prev => prev && prev.album.id === item.id
      ? { album: prev.album, tracks, loadingTracks: false }
      : prev)
  }, [])

  /** 库艺人 → 专辑列表抽屉（/v1/me/library/artists/{id}/albums） */
  const openArtistDrawer = useCallback(async (item: AppleWebItem) => {
    if (!item.libraryId) return
    setArtistDrawer({ artist: item, albums: [], loading: true })
    const albums = await fetchLibraryArtistAlbumsForDrawer(item.libraryId).catch(() => [])
    const albumItems: AppleWebItem[] = albums.map((album: AppleLibraryAlbum) => ({
      id: album.id,
      playId: album.catalogId || album.id,
      libraryId: album.id,
      catalogId: album.catalogId,
      type: 'albums',
      isLibrary: true,
      name: album.name,
      subtitle: album.artistName,
      artworkUrl: album.artworkUrl,
      artistName: album.artistName,
      releaseDate: album.releaseDate,
      trackCount: album.trackCount,
    }))
    setArtistDrawer(prev => prev && prev.artist.id === item.id
      ? { artist: prev.artist, albums: albumItems, loading: false }
      : prev)
  }, [])

  /** 广播节目 → 站内详情；节目中的 station/episode 再进入电台详情或播放。 */
  const openRadioShow = useCallback(async (item: AppleWebItem) => {
    const showId = item.playId || item.id
    if (!showId) return
    setRadioShowDetail({ item, detail: null, loading: true })
    const detail = await fetchAppleRadioShowDetail(showId, storefront).catch(() => null)
    setRadioShowDetail(prev => prev && prev.item.id === item.id
      ? { item: detail?.show || prev.item, detail, loading: false }
      : prev)
  }, [storefront])

  /** 电台 → 详情抽屉（/v1/catalog/{sf}/stations/{id} + 动态封面） */
  const openStation = useCallback(async (item: AppleWebItem) => {
    const stationId = item.playId || item.id
    if (!stationId) return
    setStationDetail({ station: item, loading: true })
    const detail = await fetchAppleStationDetail(stationId, storefront).catch(() => null)
    setStationDetail(prev => prev && prev.station.id === item.id
      ? { station: detail || prev.station, loading: false }
      : prev)
  }, [storefront])

  /** 站内直播播放电台：/v1/play/assets 取流（Cider 同款）→ HLS + Widevine EME → 单曲队列 */
  const playStation = useCallback(async (item: AppleWebItem) => {
    ;(window as any).electron?.log?.(`[AppleRadio] play requested: hasPlayId=${Boolean(item.playId)} hasResourceId=${Boolean(item.id)} hasPlayParams=${Boolean(item.playParams)}`)
    if (!item.playId && !item.id) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '该电台缺少播放标识，暂不可播放', type: 'error' } }))
      return
    }
    if (!appleLoggedIn) {
      onLoginClick()
      return
    }
    const stationKey = item.playId || item.id
    if (playingStationsRef.current.has(stationKey)) return
    playingStationsRef.current.add(stationKey)
    try {
      // 立即进入专属播放页；详情加载不能阻塞播放，App 会用 station id/playParams 取流。
      const song = appleStationToSong(item, undefined, storefront)
      void onSongSelect(song, [song], appleOrigin({ drawerType: 'station', item }))
    } finally {
      playingStationsRef.current.delete(stationKey)
    }
  }, [appleLoggedIn, appleOrigin, onLoginClick, onSongSelect, storefront])

  /** 音乐视频：站内播放（webPlayback 取流 + HLS + Widevine，<video> 元素） */
  const playVideo = useCallback((item: AppleWebItem) => {
    if (!item.playId) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '该视频暂不可播放', type: 'error' } }))
      return
    }
    setVideoItem(item)
  }, [])

  /** 帖子详情（艺人分享 /post/…）：尽力取详情，失败用卡片信息兜底 */
  const openPost = useCallback(async (item: AppleWebItem) => {
    if (!item.id) return
    setPostDetail({ item, detail: null, loading: true })
    const detail = await fetchApplePostDetail(item.id, storefront).catch(() => null)
    setPostDetail(prev => prev && prev.item.id === item.id
      ? { item: prev.item, detail: detail || prev.detail, loading: false }
      : prev)
  }, [storefront])

  /** 打开一个站内嵌套层（room / grouping / multiroom / curator），压入层级栈。
   *  进入前记住当前层滚动位置，进入后新层从顶部开始（官网同款行为）。 */
  const openLayer = useCallback(async (kind: ExploreLayer['kind'], id: string, name: string) => {
    if (!id) return
    scrollByLevelRef.current[currentLevelKeyRef.current] = readScroll()
    pendingScrollRef.current = 0
    const fallbackName = name || '探索'
    setLayers(prev => [...prev, { kind, id, name: fallbackName, page: null, loading: true }])
    const settle = (patch: Partial<ExploreLayer>) => setLayers(prev => {
      if (prev.length === 0) return prev
      const last = prev[prev.length - 1]
      if (last.id !== id || last.kind !== kind) return prev
      return [...prev.slice(0, -1), { ...last, ...patch }]
    })
    const failed: AppleWebPage = { sections: [], hero: null, personalized: false, sourceLabel: `${kind} 加载失败` }
    try {
      if (kind === 'grouping') {
        settle({ page: await fetchAppleGroupingPage(id, storefront), loading: false })
        return
      }
      if (kind === 'multiroom') {
        settle({ page: await fetchAppleMultiRoomPage(id, storefront), loading: false })
        return
      }
      if (kind === 'curator') {
        const curatorPage = await fetchAppleCuratorPage(id, storefront)
        if (!curatorPage) { settle({ page: failed, loading: false }); return }
        settle({
          name: curatorPage.curator.name || fallbackName,
          curator: curatorPage,
          // curator 页 = curator 头 + 标准编辑树分区；这里复用分区渲染。
          page: { sections: curatorPage.sections, hero: null, personalized: false, sourceLabel: `curator(${curatorPage.curator.name})` },
          loading: false,
        })
        return
      }
      settle({ page: await fetchAppleRoomPage(id, storefront), loading: false })
    } catch {
      settle({ page: failed, loading: false })
    }
  }, [storefront])

  const popLayer = useCallback(() => setLayers(prev => prev.slice(0, -1)), [])

  /** 资料库区块的二级铺开页：把该区块的全部条目以换行网格展开（不取数）。 */
  const openSectionSpread = useCallback((section: AppleWebSection) => {
    scrollByLevelRef.current[currentLevelKeyRef.current] = readScroll()
    pendingScrollRef.current = 0
    const spread: AppleWebSection = { ...section, id: `spread-${section.id}`, layoutType: 'room-grid', roomId: undefined, multiRoomId: undefined }
    setLayers(prev => [...prev, {
      kind: 'section',
      id: spread.id,
      name: section.title || '全部',
      page: { sections: [spread], hero: null, personalized: false, sourceLabel: '' },
      loading: false,
    }])
  }, [readScroll])

  /** 主頁区块的「查看全部」二级页（官网标题旁 `>` 进入）：取组级 contents 再按 room 规则渲染。 */
  const openRecommendationContents = useCallback((section: AppleWebSection) => {
    if (!section.contentsPath) return
    scrollByLevelRef.current[currentLevelKeyRef.current] = readScroll()
    pendingScrollRef.current = 0
    const id = `contents-${section.id}`
    setLayers(prev => [...prev, {
      kind: 'section',
      id,
      name: section.title || '全部',
      page: null,
      loading: true,
    }])
    void fetchAppleRecommendationContents(section.contentsPath).then(sections => {
      setLayers(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.id !== id) return prev
        return [...prev.slice(0, -1), {
          ...last,
          loading: false,
          page: { sections, hero: null, personalized: false, sourceLabel: sections.length > 0 ? '' : '暂无可展示的内容' },
        }]
      })
    }).catch(() => {
      setLayers(prev => {
        const last = prev[prev.length - 1]
        if (!last || last.id !== id) return prev
        return [...prev.slice(0, -1), {
          ...last,
          loading: false,
          page: { sections: [], hero: null, personalized: false, sourceLabel: '加载失败' },
        }]
      })
    })
  }, [readScroll])

  /** 跳到指定深度（0 = 新发现根层级），并恢复该层此前的滚动位置。 */
  const goToDepth = useCallback((depth: number) => {
    setLayers(prev => {
      const target = prev.slice(0, Math.max(0, Math.min(depth, prev.length)))
      scrollByLevelRef.current[currentLevelKeyRef.current] = readScroll()
      pendingScrollRef.current = scrollByLevelRef.current[levelKeyOf(target)] ?? 0
      return target
    })
  }, [readScroll])

  /** 层级切换后应用滚动位置：进入新层回顶部，返回/跳转回到该层记忆的位置。 */
  useEffect(() => {
    const pending = pendingScrollRef.current
    if (pending === null) return
    pendingScrollRef.current = null
    const raf = window.requestAnimationFrame(() => {
      writeScroll(pending)
      // 内容异步加载后高度会变化，再补一次以贴近记忆位置。
      window.setTimeout(() => writeScroll(pending), 260)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [layers, writeScroll])

  /** 按 URL 归一化结果打开对应层级；无法识别时返回 false 交给调用方兜底。 */
  const openExploreTarget = useCallback((target: AppleExploreTarget | null, name: string): boolean => {
    if (!target) return false
    if (target.kind === 'room') { void openLayer('room', target.id, name); return true }
    if (target.kind === 'grouping') { void openLayer('grouping', target.id, name); return true }
    if (target.kind === 'multiroom') { void openLayer('multiroom', target.id, name); return true }
    if (target.kind === 'curator') { void openLayer('curator', target.id, name); return true }
    return false
  }, [openLayer])

  /** 兼容旧调用：从条目 URL 推断目标层级。 */
  const openRoom = useCallback(async (item: AppleWebItem) => {
    if (openExploreTarget(resolveExploreTarget(item.url), item.name || '')) return
    // 没有可识别 URL 时，退化为把 id 当 room id（探索更多部分入口只给 id）。
    if (item.id) void openLayer('room', String(item.id), item.name || '探索')
  }, [openExploreTarget, openLayer])

  useEffect(() => {
    if (restorePlaybackOrigin?.surface !== 'explore-apple') return
    const detail = restorePlaybackOrigin.detail as {
      tab?: AmTab
      drawerType?: string
      item?: AppleWebItem
      room?: { id: string; name: string }
      postItem?: AppleWebItem
      chart?: AppleWebSection
    } | undefined
    if (!detail?.tab || !TABS.some(entry => entry.id === detail.tab)) return
    setTab(detail.tab)
    if (detail.room) {
      void openRoom({ id: detail.room.id, playId: detail.room.id, type: 'rooms', name: detail.room.name })
      return
    }
    if (detail.postItem) { void openPost(detail.postItem); return }
    if (detail.chart) { setChartDetail(detail.chart); return }
    if (!detail.item) return
    if (detail.drawerType === 'album' && detail.item.libraryId) void openAlbumDrawer(detail.item)
    else if (detail.drawerType === 'artist' && detail.item.libraryId) void openArtistDrawer(detail.item)
    else if (detail.drawerType === 'station' && detail.item.playId) void openStation(detail.item)
  }, [restorePlaybackOrigin?.revision, openAlbumDrawer, openArtistDrawer, openPost, openRoom, openStation])

  /** 通用「加入资料库」（歌曲/专辑/视频；成功切换 + 态） */
  const saveToLibrary = useCallback(async (item: AppleWebItem) => {
    const key = `lib:${item.type}:${item.playId}`
    if (!appleLoggedIn) {
      onLoginClick()
      return
    }
    if (!item.playId || item.isLibrary || libraryMutations.has(key)) return
      const isSaved = savedPlaylists.has(key)
      setLibraryMutations(previous => new Set(previous).add(key))
      try {
        const ok = isSaved
          ? item.type === 'songs'
            ? await removeAppleSongFromLibrary(item.playId)
            : item.type === 'albums' || item.type === 'music-videos'
              ? await removeAppleResourceFromLibrary(item.type, item.playId, item.libraryId)
              : false
          : item.type === 'songs'
          ? await addAppleSongToLibrary(item.playId)
          : item.type === 'albums'
            ? await addAppleAlbumToLibrary(item.playId)
            : item.type === 'music-videos'
              ? await addAppleMusicVideoToLibrary(item.playId)
              : false
      if (!ok) throw new Error(isSaved ? '从资料库移除失败，请重试' : '添加到资料库失败，请重试')
      setSavedPlaylists(prev => {
        const next = new Set(prev)
        if (isSaved) next.delete(key)
        else next.add(key)
        return next
      })
      window.dispatchEvent(new CustomEvent('playlist-content-changed', { detail: { platform: 'apple', type: isSaved ? 'remove' : 'library-add', songId: item.playId } }))
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: isSaved ? '已从资料库移除' : '已添加到资料库', type: 'success' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: error instanceof Error ? error.message : '资料库操作失败，请重试', type: 'error' } }))
    } finally {
      setLibraryMutations(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [appleLoggedIn, libraryMutations, onLoginClick, savedPlaylists])

  const savePlaylist = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn || !item.playId || item.isLibrary || libraryMutations.has(`playlist:${item.playId}`)) return
    const key = `playlist:${item.playId}`
    const isSaved = savedPlaylists.has(item.playId)
    setLibraryMutations(previous => new Set(previous).add(key))
    try {
      const libraryId = catalogLibraryIds.get(item.playId)
      const ok = isSaved
        ? libraryId ? await removeApplePlaylistFromLibrary(libraryId) : false
        : await addApplePlaylistToLibrary(item.playId)
      if (!ok) throw new Error(isSaved && !libraryId ? '无法确定资料库歌单，请刷新后重试' : '歌单资料库操作失败，请重试')
      setSavedPlaylists(prev => {
        const next = new Set(prev)
        if (isSaved) next.delete(item.playId)
        else next.add(item.playId)
        return next
      })
      window.dispatchEvent(new CustomEvent('playlist-content-changed', { detail: { platform: 'apple', type: isSaved ? 'remove' : 'library-add', playlistId: item.playId } }))
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: isSaved ? '已从资料库移除歌单' : '已添加歌单到资料库', type: 'success' } }))
      void loadTab('library', true)
    } catch (error) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: error instanceof Error ? error.message : '歌单资料库操作失败，请重试', type: 'error' } }))
    } finally {
      setLibraryMutations(previous => {
        const next = new Set(previous)
        next.delete(key)
        return next
      })
    }
  }, [appleLoggedIn, catalogLibraryIds, libraryMutations, loadTab, savedPlaylists])

  const openExternal = useCallback((url?: string) => {
    if (!url) return
    const bridge = (window as any).electron
    if (bridge?.openExternal) void bridge.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  }, [])

  const activateItem = useCallback((item: AppleWebItem, items: AppleWebItem[] = [item]) => {
    // 带站内编辑层链接的条目优先按链接跳转（实测广播「电台主持人/艺人主持节目」的节目卡
    // 指向 viewMultiRoom，属于三级页；新发现的推荐系列 banner 同理）。
    const entryTarget = resolveExploreTarget(item.url)
    if (entryTarget && entryTarget.kind !== 'external' && entryTarget.kind !== 'charts') {
      if (openExploreTarget(entryTarget, item.name)) return
    }
    switch (item.type) {
      case 'songs':
        playItemWithQueue(item, items)
        break
      case 'playlists':
        openPlaylistPanel(item)
        break
      case 'albums':
        if (item.isLibrary) void openAlbumDrawer(item)
        else if (item.playId && onOpenAlbum) onOpenAlbum(item.playId, 'apple')
        break
      case 'artists':
        if (item.isLibrary) void openArtistDrawer(item)
        else if (item.playId && onOpenArtistPanel) onOpenArtistPanel(item.playId, 'apple')
        break
      case 'stations':
        void openStation(item)
        break
      case 'radio-shows':
        void openRadioShow(item)
        break
      case 'music-videos':
        playVideo(item)
        break
      case 'uploaded-videos':
        if (item.catalogId) playVideo({ ...item, playId: item.catalogId, type: 'music-videos' })
        else window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '该上传视频暂无可用的 Apple Music 目录播放资源', type: 'info' } }))
        break
      case 'posts':
        void openPost(item)
        break
      case 'rooms':
        void openRoom(item)
        break
      case 'curators':
        // 策展人（如「来自全球」下的语种/风格）→ 站内 curator 层。
        void openLayer('curator', String(item.playId || item.id), item.name)
        break
      case 'groupings':
        void openLayer('grouping', String(item.playId || item.id), item.name)
        break
    }
  }, [onOpenAlbum, onOpenArtistPanel, openAlbumDrawer, openArtistDrawer, openExploreTarget, openPlaylistPanel, openPost, openRadioShow, openRoom, openStation, playItemWithQueue, playVideo])

  useTvBack(() => {
    if (albumDrawer) setAlbumDrawer(null)
    else if (stationDetail) setStationDetail(null)
    else if (radioShowDetail) setRadioShowDetail(null)
    else if (postDetail) setPostDetail(null)
    else if (chartDetail) setChartDetail(null)
    else if (artistDrawer) setArtistDrawer(null)
    else if (layers.length > 0) goToDepth(layers.length - 1)
    else return false
    return true
  }, [albumDrawer, stationDetail, radioShowDetail, postDetail, chartDetail, artistDrawer, layers.length, goToDepth])

  // ── 卡片子组件 ──

  /** 徽章卡。`textFirst` 只在「新发现」精品推荐启用（官网该区块为文字在上、图在下）；
   *  `overlayMeta` 用于主页「专属精选推荐」（官网同款：名称/副标题/简介内嵌卡片底部渐变）；
   *  其余保持「图在上、文字在下」样式。 */
  const FeaturedCard = ({ item, items, portrait = false, textFirst = false, overlayMeta = false }: { item: AppleWebItem; items: AppleWebItem[]; portrait?: boolean; textFirst?: boolean; overlayMeta?: boolean }) => {
    const isPlaylist = item.type === 'playlists'
    // 官网卡片叠「一行小标签 + 一行标题(可带 E 标) + 简介」，且重复文案只显示一次。
    // 归一逻辑（含去重与兜底规则）见 apple-explore/cardMeta.ts 的注释。
    const cardMeta = resolveAppleCardMeta(item)
    const { label: cardLabel, title: cardTitle, subtitle: cardSubtitle, description: cardDescription, detail: cardDetail, explicit } = cardMeta
    const explicitBadge = explicit ? (
      <span
        aria-label="露骨内容"
        title="露骨内容"
        className="ml-1.5 inline-flex h-[15px] w-[15px] shrink-0 translate-y-[1px] items-center justify-center rounded-[3px] bg-white/85 text-[10px] font-bold leading-none text-black"
      >
        E
      </span>
    ) : null
    const meta = (
      <>
        {item.badge && textFirst && (
          <span className="mb-1.5 inline-block rounded-md border border-white/[0.14] bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-white/80">
            {item.badge}
          </span>
        )}
        {cardLabel && textFirst && (
          <p className="mb-0.5 truncate text-[11px] leading-tight text-white/45">{cardLabel}</p>
        )}
        {cardTitle && (
          <p className={`truncate leading-tight ${textFirst ? 'text-sm font-semibold' : 'text-sm font-medium'}`}>
            {cardTitle}
            {explicitBadge}
          </p>
        )}
        {cardSubtitle && (
          <p className="mt-0.5 truncate text-xs text-white/40">{cardSubtitle}</p>
        )}
        {/* 第三行与副标题不同时才补（专辑副标题=艺人名时会与它同文，去重后不重复显示）。 */}
        {!overlayMeta && cardDetail && cardDetail !== cardSubtitle && (
          <p className="mt-0.5 truncate text-xs text-white/40">{cardDetail}</p>
        )}
      </>
    )
    return (
      <motion.div
        whileHover={{ y: -3 }}
        tabIndex={0}
        data-tv-focus
        className="group min-w-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
        onClick={() => activateItem(item, items)}
        onKeyDown={event => {
          if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
          event.preventDefault()
          activateItem(item, items)
        }}
      >
        {textFirst && <div className="mb-2 min-w-0 px-0.5">{meta}</div>}
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
          {/* 图片比例按官网实测校准：
              · portrait（主页「专属精选推荐」竖卡）：官网实测 407×542 = 3:4；
                原 125/181(≈0.69) 比官网窄高 8.6%，是"卡片比例不对"的直接原因。
              · 其余宽卡：官网实测 540×310(≈1.742)、460×264(≈1.742)；
                原 16/10(1.6) 偏矮，会裁掉更多画面。
              另外：编辑图已把标题烤进画面（artworkHasTitle）时**只出静态图**。
              这类歌单的动态封面是另一套构图（无 Apple Music 字标、无标题），
              自动播放会把它盖在静态图上，表现为"封面和官网不一样、字标消失"。 */}
          {item.bannerUrl && !item.motionArtworkUrl ? (
            <img src={item.bannerUrl} alt={item.name} loading="lazy" className={`${portrait ? 'aspect-[3/4]' : 'aspect-[540/310]'} w-full object-cover`} />
          ) : item.artworkHasTitle && item.artworkUrl ? (
            <AppleExploreImage src={item.artworkUrl} alt={item.name} className={`${portrait ? 'aspect-[3/4]' : 'aspect-[540/310]'} w-full`} role="card" />
          ) : (
            <MotionArtworkCover item={item} storefront={storefront} className={`${portrait ? 'aspect-[3/4]' : 'aspect-[540/310]'} w-full`} />
          )}
          {!textFirst && item.badge && (
            <span className="absolute left-3 top-3 z-10 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur-md">
              {item.badge}
            </span>
          )}
          {/* 描述叠加层（web 卡片同款：底部渐变 + 编辑描述）；overlayMeta 时名称/副标题/简介合并内嵌 */}
          {overlayMeta ? (
            <div className="absolute inset-x-0 bottom-0 z-10 bg-[linear-gradient(0deg,rgba(4,6,10,0.9)_0%,rgba(4,6,10,0.42)_58%,transparent_100%)] px-3.5 pb-3 pt-10">
              {/* 官网此货架为「小标签（下一首/最新发行/专属推荐）+ 标题(带 E 标) + 第三行」，
                  第三行随类型取值（歌单=曲目艺人串、专辑=艺人、电台=编辑简介），
                  各行的重复文案只显示一次（见 apple-explore/cardMeta.ts 注释）。 */}
              {cardLabel && (
                <p className="truncate text-[11px] leading-tight text-white/50">{cardLabel}</p>
              )}
              {cardTitle && (
                <p className="mt-0.5 truncate text-sm font-semibold leading-tight">
                  {cardTitle}
                  {explicitBadge}
                </p>
              )}
              {(cardDetail || cardDescription) && (
                <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/70">
                  {cardDetail || cardDescription}
                </p>
              )}
            </div>
          ) : (
            cardDescription && (
              <>
                <div className="absolute inset-x-0 bottom-0 h-2/3 bg-[linear-gradient(0deg,rgba(6,9,14,0.88)_0%,rgba(6,9,14,0.4)_55%,transparent_100%)]" />
                <p className="absolute inset-x-0 bottom-0 z-10 line-clamp-2 px-3.5 pb-3 text-xs leading-relaxed text-white/75">
                  {cardDescription}
                </p>
              </>
            )
          )}
          {/* hover 播放按钮 */}
          {(isPlayableItem(item) || (item.type === 'stations' && Boolean(item.playId || item.id))) && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); if (item.type === 'stations') void playStation(item); else playItemWithQueue(item, items) }}
              className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
              style={{ background: accentColor }}
              aria-label={`播放${item.name}`}
            >
              <Play className="h-4 w-4 fill-current" />
            </button>
          )}
        </div>
        {!textFirst && !overlayMeta && <div className="mt-2 px-0.5">{meta}</div>}
      </motion.div>
    )
  }

  /** 宽幅横幅（web [320] 编辑元素：4320×1080 大图 + 左上角徽章 + 底部标题/文案） */
  const BannerCard = ({ section, wide = false }: { section: AppleWebSection; wide?: boolean }) => {
    const item = section.items[0]
    return (
      <motion.div
        whileHover={{ y: -2 }}
        className={`group relative w-full cursor-pointer overflow-hidden rounded-2xl border border-white/[0.08] ${wide ? '' : 'aspect-[460/264] min-h-[220px]'}`}
        onClick={() => { if (item) activateItem(item, section.items) }}
      >
        {section.bannerUrl || item?.motionArtworkUrl || item?.artworkUrl ? (
          <div className="absolute inset-0">
            {section.bannerUrl && <img src={section.bannerUrl} alt={section.title} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
            {item?.bannerUrl && !section.bannerUrl && <img src={item.bannerUrl} alt={item.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
            {item?.motionArtworkUrl && <MotionArtworkCover item={item} storefront={storefront} className="absolute inset-0 h-full w-full" />}
            {!section.bannerUrl && !item?.bannerUrl && !item?.motionArtworkUrl && item?.artworkUrl && <MotionArtworkCover item={item} storefront={storefront} className="h-full w-full" />}
          </div>
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(250,45,72,0.25),rgba(10,10,14,0.9))]" />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.88)_5%,rgba(6,9,14,0.25)_55%,rgba(6,9,14,0.05)_100%)]" />
        {/* 文字区（官网广播页「推荐单集」同款）：全部**左下角**竖排，自上而下为
            ① 区块/推荐标签（如「推荐单集」）② 标题（如「NCT 127」）③ 描述小字
            （如「出道 10 周年初心回归…」）。
            此前描述小字被渲染在卡片**顶部**（section.tag 在 justify-end 之外先出现），
            与官网的位置相反；这里统一收进左下角的同一列。 */}
        <div className="relative flex min-h-[220px] flex-col justify-end p-5 md:p-7">
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              {section.title && (
                <span className="mb-1.5 inline-block rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white/85 backdrop-blur-md">
                  {section.title}
                </span>
              )}
              <h3 className="truncate text-xl font-semibold md:text-2xl">{item?.name || section.title}</h3>
              {section.tag && (
                <p className="mt-1 line-clamp-1 text-xs font-medium text-white/60">{section.tag}</p>
              )}
              {!section.tag && item?.subtitle && <p className="mt-1 truncate text-sm text-white/55">{item.subtitle}</p>}
            </div>
            {item?.playId && item.type !== 'artists' && (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  activateItem(item, section.items)
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#0a0f14] opacity-0 [@media(hover:none)]:opacity-100 shadow-xl transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
                style={{ background: accentColor }}
                aria-label={`播放${item?.name || section.title}`}
              >
                <Play className="h-4 w-4 fill-current" />
              </span>
            )}
          </div>
        </div>
      </motion.div>
    )
  }

  /** 电台方卡（web 新近内容/热门电台：方图 + 名称 + 「…」）
   *  官网电台卡没有播放/详情/加入资料库按钮：点击卡片打开电台详情抽屉，播放走抽屉内的按钮。
   *  （此前中央播放按钮会打开电台播放页、ⓘ 也开抽屉，两个入口弹两种窗，逻辑冲突；
   *  且 Apple 的 /v1/me/library 不支持收藏 stations，"+"按钮永远失败。） */
  const StationCard = ({ item }: { item: AppleWebItem }) => {
    return (
      <motion.div
        whileHover={{ y: -3 }}
        data-tv-focus
        className="group min-w-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
        onClick={() => void openStation(item)}
      >
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
          {item.motionArtworkUrl || item.artworkUrl ? (
            <MotionArtworkCover item={item} storefront={storefront} className="aspect-square w-full transition duration-500 group-hover:scale-[1.03]" />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
              <Radio className="h-7 w-7 opacity-40" />
            </div>
          )}
          {item.isLive && (
            <span className="absolute left-2.5 top-2.5 rounded-md bg-[#fa2d48] px-1.5 py-0.5 text-[10px] font-semibold text-white">直播中</span>
          )}
        </div>
        <div className="mt-2 px-0.5">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/40">{item.showName || 'Apple Music 电台'}</p>
        </div>
      </motion.div>
    )
  }

  /** 歌曲行（web 歌曲网格：封面 + 名称 + 艺人 + 「…」菜单） */
  const SongRow = ({ item, items, rank }: { item: AppleWebItem; items: AppleWebItem[]; rank?: number }) => {
    const isFav = favorited.has(item.playId)
    return (
      <div
        tabIndex={0}
        data-tv-focus
        className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2 outline-none transition hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
        onClick={() => playItemWithQueue(item, items)}
        onContextMenu={(event) => openSongMenu(event, item, items)}
      >
        {typeof rank === 'number' ? (
          <span className={`w-6 shrink-0 text-center text-sm tabular-nums ${rank <= 3 ? 'font-semibold' : 'text-white/35'}`} style={rank <= 3 ? { color: accentColor } : undefined}>
            {rank}
          </span>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg">
          {item.artworkUrl ? (
            <AppleExploreImage src={item.artworkUrl} alt={item.name} className="h-full w-full" role="row" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/[0.06]">
              <MusicGlyph className="h-5 w-5 opacity-40" />
            </div>
          )}
          <span
            className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 [@media(hover:none)]:opacity-100 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
            aria-hidden="true"
          >
            <Play className="h-4 w-4 fill-white text-white" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-white/40">
            {songTraitLabel(item) && (
              <span className="shrink-0 rounded border border-white/15 bg-white/[0.06] px-1 py-px text-[10px] font-medium leading-tight text-white/60">
                {songTraitLabel(item)}
              </span>
            )}
            <span className="truncate">{item.artistName || item.subtitle}</span>
          </p>
        </div>
        {!item.isLibrary && (
        <button
          type="button"
          aria-label={savedPlaylists.has(`lib:songs:${item.playId}`) ? '从资料库移除' : '添加到资料库'}
          disabled={libraryMutations.has(`lib:songs:${item.playId}`)}
          onClick={(event) => { event.stopPropagation(); void saveToLibrary(item) }}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 ${
            savedPlaylists.has(`lib:songs:${item.playId}`) ? 'text-[#fa2d48]' : 'text-white/50 hover:bg-white/10'
          }`}
        >
          {savedPlaylists.has(`lib:songs:${item.playId}`) ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
        </button>
        )}
        <button
          type="button"
          aria-label="喜爱歌曲"
          onClick={(event) => { event.stopPropagation(); void toggleFavorite(item) }}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 ${
            isFav ? 'text-[#fa2d48]' : 'text-white/50 hover:bg-white/10'
          }`}
        >
          <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          aria-label="更多操作"
          onClick={(event) => { event.stopPropagation(); openSongMenu(event, item, items) }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 opacity-0 transition hover:bg-white/10 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    )
  }

  /** 歌曲表格行（room 页「新歌精选」同款：歌曲 / 艺人 / 专辑 / 时长 四列） */
  const SongTableRow = ({ item, items }: { item: AppleWebItem; items: AppleWebItem[] }) => {
    const isFav = favorited.has(item.playId)
    const isSaved = savedPlaylists.has(`lib:songs:${item.playId}`)
    const artists = item.artistName || item.subtitle || ''
    return (
      <div
        tabIndex={0}
        data-tv-focus
        className="group grid min-w-0 cursor-pointer grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-4 rounded-lg px-2 py-1.5 outline-none transition hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-[#fa2d48] md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_4rem]"
        onClick={() => playItemWithQueue(item, items)}
        onContextMenu={(event) => openSongMenu(event, item, items)}
      >
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            aria-label={isFav ? '取消喜爱' : '喜爱歌曲'}
            onClick={(event) => { event.stopPropagation(); void toggleFavorite(item) }}
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition ${
              isFav ? 'text-[#fa2d48] opacity-100' : 'text-white/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
            }`}
          >
            <Heart className={`h-3.5 w-3.5 ${isFav ? 'fill-current' : ''}`} />
          </button>
          <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-md">
            {item.artworkUrl ? (
              <AppleExploreImage src={item.artworkUrl} alt={item.name} className="h-full w-full" role="row" />
            ) : (
              <div className="flex h-full w-full items-center justify-center bg-white/[0.06]">
                <MusicGlyph className="h-4 w-4 opacity-40" />
              </div>
            )}
          </div>
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium leading-tight">{item.name}</p>
        </div>
        <p className="min-w-0 truncate text-[13px] text-white/55">{artists}</p>
        <p className="hidden min-w-0 truncate text-[13px] text-white/40 md:block">{item.albumName || ''}</p>
        <div className="hidden items-center justify-end gap-1 md:flex">
          {!item.isLibrary && (
            <button
              type="button"
              aria-label={isSaved ? '从资料库移除' : '添加到资料库'}
              disabled={libraryMutations.has(`lib:songs:${item.playId}`)}
              onClick={(event) => { event.stopPropagation(); void saveToLibrary(item) }}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition ${
                isSaved ? 'text-[#fa2d48] opacity-100' : 'text-white/40 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'
              }`}
            >
              {isSaved ? <Check className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
            </button>
          )}
          <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-white/35">{formatDuration(item.durationMs)}</span>
          <button
            type="button"
            aria-label="更多操作"
            onClick={(event) => { event.stopPropagation(); openSongMenu(event, item, items) }}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-white/40 opacity-0 transition hover:bg-white/10 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    )
  }

  /** 节目卡（web [394]：宽幅横幅 + 节目名） */
  const ShowCard = ({ item }: { item: AppleWebItem }) => (
    <motion.div
      whileHover={{ y: -3 }}
      className="group relative min-w-0 cursor-pointer overflow-hidden rounded-2xl border border-white/[0.08]"
      onClick={() => item.type === 'stations' && (item.playId || item.id)
        ? void openStation(item)
        : item.type === 'radio-shows' && (item.playId || item.id)
          ? void openRadioShow(item)
          : openExternal(item.url)}
    >
      {item.bannerUrl || item.motionArtworkUrl || item.artworkUrl ? (
        <div className="relative aspect-[16/9] w-full">
          <MotionArtworkCover item={item} storefront={storefront} className="h-full w-full" />
        </div>
      ) : (
        <div className="flex aspect-[16/9] w-full items-center justify-center bg-white/[0.06]">
          <Radio className="h-7 w-7 opacity-40" />
        </div>
      )}
      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.85)_0%,rgba(6,9,14,0.15)_60%,transparent_100%)]" />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-3.5">
        <p className="min-w-0 truncate text-sm font-semibold">{item.name}</p>
        {item.type === 'stations' || item.type === 'radio-shows'
          ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/45 opacity-0 [@media(hover:none)]:opacity-100 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100" />
          : <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/45 opacity-0 [@media(hover:none)]:opacity-100 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100" />}
      </div>
    </motion.div>
  )

  /** 主页横向行卡片（歌曲/歌单/专辑/艺人/电台） */
  const RowCard = ({ item, items, fluid = false, portrait = false }: { item: AppleWebItem; items: AppleWebItem[]; fluid?: boolean; portrait?: boolean }) => {
    const isFav = favorited.has(item.playId)
    const isSaved = savedPlaylists.has(item.playId)
    const isPlaylist = item.type === 'playlists'
    const isArtist = item.type === 'artists'
    const isStation = item.type === 'stations'
    const isLibraryResource = item.type === 'albums' || item.type === 'music-videos'
    const libraryKey = `lib:${item.type}:${item.playId}`
    const isLibrarySaved = isLibraryResource && savedPlaylists.has(libraryKey)
    return (
      <motion.div
        whileHover={{ y: -3 }}
        tabIndex={0}
        data-tv-focus
        className={`group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48] ${fluid ? 'w-full' : 'w-[148px] sm:w-[164px] lg:w-[176px]'}`}
        onClick={() => activateItem(item, items)}
      >
        <div className="relative overflow-hidden rounded-xl">
          <MotionArtworkCover item={item} storefront={storefront} className={`${portrait ? 'aspect-[4/5]' : 'aspect-square'} w-full`} />
          {isStation && item.isLive && (
            <span className="absolute left-2 top-2 rounded-md bg-[#fa2d48] px-1.5 py-0.5 text-[10px] font-semibold text-white">直播中</span>
          )}
          {!isArtist && !isStation && !item.isLibrary && item.playId && (
            <button
              type="button"
              aria-label={isPlaylist ? (isSaved ? '从资料库移除歌单' : '添加歌单到资料库') : isLibraryResource ? (isLibrarySaved ? '已添加到资料库' : '添加到资料库') : '喜欢'}
              disabled={libraryMutations.has(libraryKey)}
              onClick={(event) => {
                event.stopPropagation()
                if (isPlaylist) void savePlaylist(item)
                else if (isLibraryResource) void saveToLibrary(item)
                else void toggleFavorite(item)
              }}
              className={`absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full bg-black/55 text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 disabled:cursor-default`}
            >
              {isPlaylist
                ? isSaved ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />
                : isLibraryResource
                  ? isLibrarySaved ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />
                  : <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />}
            </button>
          )}
        </div>
        <div className="mt-2 px-1 pb-1">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/45">{item.curatorName || item.artistName || item.showName || item.subtitle || 'Apple Music'}</p>
        </div>
      </motion.div>
    )
  }

  // ── 分区渲染 ──

  /** 分区渲染语境：browse/room 使用官网横向货架与完整列表，default 保留其它页签原有布局。 */
  type SectionContext = 'browse' | 'room' | 'default'

  const renderSection = (section: AppleWebSection, context: SectionContext = 'default') => {
    const isRoom = context === 'room'
    const useShelf = context === 'browse' || context === 'room'
    // 实测官网 room 页（如「每周热门 100 首」）条目是**换行网格**（204px × 5 列、不横向滚动、无翻页），
    // 不是单行货架；歌曲 room 仍走表格（song-grid + isRoom 分支）。
    if (section.layoutType === 'room-grid' && section.kind !== 'song-grid') {
      const squareOnly = section.items.every(item =>
        item.type === 'albums' || item.type === 'playlists' || item.type === 'stations'
        || item.type === 'artists' || item.type === 'curators' || item.type === 'rooms')
      return (
        <section key={section.id} className="space-y-3">
          <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
          <div className="grid grid-cols-2 gap-x-5 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {section.items.map(item => (
              squareOnly
                ? <RowCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} fluid />
                : <div key={`${section.id}-${item.type}-${item.id}`} className="min-w-0"><ShowCard item={item} /></div>
            ))}
          </div>
        </section>
      )
    }
    switch (section.kind) {
      case 'new-hero':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title || '精品推荐'} subtitle={section.subtitle} section={section} />
            {/* 实测官网精品推荐：卡片 540×310、一屏 2 张并露出第三张约 45px，横向滚动；全部条目来自首次响应。 */}
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title || '精品推荐'} itemClassName="w-[calc((100%-1rem)/2.2)] shrink-0">
              {section.items.map(item => (
                <FeaturedCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} textFirst />
              ))}
            </HorizontalShelf>
          </section>
        )
      case 'song-grid':
        // room 页（如「新歌精选」）与资料库「歌曲」都是官网的完整歌曲表格；主页面为紧凑多列列表。
        if (isRoom || section.layoutType === 'library-track') {
          const songs = section.items.filter(item => item.type === 'songs')
          return (
            <section key={section.id} className="space-y-2">
              <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
              <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] items-center gap-4 border-b border-white/[0.07] px-2 pb-1.5 text-[11px] uppercase tracking-wide text-white/32 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_minmax(0,2fr)_4rem]">
                <span>歌曲</span>
                <span>艺人</span>
                <span className="hidden md:block">专辑</span>
                <span className="hidden text-right md:block">时长</span>
              </div>
              <div>
                {songs.map(item => (
                  <SongTableRow key={`${section.id}-${item.id}`} item={item} items={songs} />
                ))}
              </div>
            </section>
          )
        }
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 官网歌曲轨：每列 4 行；列宽按面板宽度算，保证一屏 4 列 + 第 5 列露出一点（诱导拖拽）。 */}
            <HorizontalShelf
              edgeControls="hover"
              ariaLabel={section.title}
              itemClassName="w-[calc((100%-4rem)/4.4)] shrink-0"
            >
              {chunkBy(section.items, 4).map((column, columnIndex) => (
                <div key={`${section.id}-col-${columnIndex}`} className="flex w-full flex-col gap-0.5">
                  {column.map((item: AppleWebItem, rowIndex: number) => (
                    <SongRow
                      key={`${section.id}-${item.id}-${rowIndex}`}
                      item={item}
                      items={section.items}
                    />
                  ))}
                </div>
              ))}
            </HorizontalShelf>
          </section>
        )
      case 'album-shelf':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 实测官网方形货架：卡片随货架槽位铺满（一屏约 5~6 张）。
                注意 RowCard 必须传 fluid：否则卡片保留自身的固定宽度
                （w-[148px] sm:w-[164px] lg:w-[176px]），比货架分配的槽位窄一大截，
                表现为卡片之间出现 70px 以上的空隙（用户实测反馈"歌与歌之间空太多"）。 */}
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-4rem)/5.6)] shrink-0">
              {section.items.map(item => <RowCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} fluid />)}
            </HorizontalShelf>
          </section>
        )
      case 'curators':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 实测官网 /cn/search 类别卡：216×122 宽卡、每行 4 个（不是方形网格）。 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-3 xl:grid-cols-4">
              {section.items.map(item => (
                <button
                  type="button"
                  key={`${section.id}-${item.id}`}
                  onClick={() => void openLayer('curator', String(item.playId || item.id), item.name)}
                  className="group min-w-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
                >
                  <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                    {item.artworkUrl ? (
                      <AppleExploreImage src={item.artworkUrl} alt={item.name} className="aspect-[216/122] w-full transition duration-500 group-hover:scale-[1.03]" role="card" />
                    ) : (
                      <div className="flex aspect-[216/122] w-full items-center justify-center bg-white/[0.06]">
                        <MusicGlyph className="h-7 w-7 opacity-40" />
                      </div>
                    )}
                  </div>
                  <p className="mt-2 truncate text-[13px] font-medium leading-tight">{item.name}</p>
                  <p className="mt-0.5 truncate text-[11px] text-white/40">{item.subtitle || 'Apple Music'}</p>
                </button>
              ))}
            </div>
          </section>
        )
      case 'text-block':
        return (
          <section key={section.id} className="space-y-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] px-5 py-4">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 404 区块正文是 HTML；去掉标签后按纯文本渲染，避免注入远程标记。 */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/60">
              {String(section.bodyHtml || '').replace(/<[^>]*>/g, '')}
            </p>
          </section>
        )
      case 'station-grid': {
        // 实测官网两种电台形态（由 displayStyle 决定）：
        // - expanded：97×97 封面 + 右侧文字的「横卡」，每列 2 行。
        //   官网实测 ul 是 `grid-auto-flow: column` + 固定 403.5px 列宽 + gap 24/20，
        //   一屏约 2.9 列（内容宽 1167px）→ 也就是「每列 2 行、一屏 5~6 张卡」的观感。
        //   我们按容器宽比例换成 ~2.8 分之一列宽（一屏 2.8 列 ≈ 官网 403.5/1167 = 0.346），
        //   这样宽屏下也能保持"露下一列一部分"的暗示。
        // - compact ：204×204 方形卡（封面+下方文字），约占内容宽 17.5%（一屏约 5~6 个）
        const isExpanded = section.displayStyle === 'expanded'
        if (isExpanded) {
          const columns = chunkBy(section.items, 2)
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
              <HorizontalShelf
                edgeControls="hover"
                ariaLabel={section.title}
                itemClassName="w-[calc((100%-2rem)/2.8)] min-w-[300px] shrink-0"
              >
                {columns.map((column, columnIndex) => (
                  <div key={`${section.id}-col-${columnIndex}`} className="flex w-full flex-col gap-3">
                    {column.map(item => (
                      <button
                        type="button"
                        key={`${section.id}-${item.id}`}
                        onClick={() => void openStation(item)}
                        className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
                      >
                        <div className="relative h-[97px] w-[97px] shrink-0 overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04]">
                          <MotionArtworkCover item={item} storefront={storefront} className="h-full w-full" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                          <p className="mt-0.5 truncate text-[11px] text-white/40">{item.showName || item.subtitle || 'Apple Music 电台'}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </HorizontalShelf>
            </section>
          )
        }
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            <HorizontalShelf
              edgeControls="hover"
              ariaLabel={section.title}
              itemClassName="w-[calc((100%-4rem)/5.6)] shrink-0"
            >
              {section.items.map(item => (
                <button
                  type="button"
                  key={`${section.id}-${item.type}-${item.id}`}
                  onClick={() => void openStation(item)}
                  className="group w-full min-w-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
                >
                  <div className="relative overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04]">
                    <MotionArtworkCover item={item} storefront={storefront} className="aspect-square w-full" />
                  </div>
                  <p className="mt-1.5 truncate text-[11px] font-medium leading-tight">{item.name}</p>
                </button>
              ))}
            </HorizontalShelf>
          </section>
        )
      }
      case 'video-shelf':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 实测官网视频货架：卡片 220×124（16:9）、每行 6 个。 */}
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-4rem)/4.5)] shrink-0">
              {section.items.map(item => <FeaturedCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} />)}
            </HorizontalShelf>
          </section>
        )
      case 'explore-links':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {/* 实测官网「探索更多」：295×58 的链接块排在 <ul> 多列里，不是卡片网格。
                目标由 resolveExploreTarget 归一化（fcId→room、viewGrouping→grouping、viewTop→排行榜）。 */}
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map(item => (
                <li key={`${section.id}-${item.id}`}>
                  <button
                    type="button"
                    onClick={() => {
                      const target = resolveExploreTarget(item.url)
                      if (target && openExploreTarget(target, item.name)) return
                      if (target?.kind === 'charts') { setTab('charts'); return }
                      if (target?.kind === 'external') openExternal(target.url)
                    }}
                    className="flex h-[58px] w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 text-left text-sm font-medium transition hover:bg-white/[0.08]"
                  >
                    <span className="truncate">{item.name}</span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )

      case 'home-featured':
        return (
          <section key={section.id} className="space-y-3">
            {/* 标题取接口值：kind=home-featured 的组不止「专属精选推荐」一个，
                「专属推荐歌单」「音乐回忆：你的热门音乐」同属这一规格。
                此前写死标题会把它们全渲染成「专属精选推荐」，与官网不符。 */}
            <SectionTitle title={section.title || '专属精选推荐'} subtitle={section.subtitle} section={section} />
            {/* 官网主页该货架的卡片随容器宽度缩放：实测官网卡 407px、货架可见宽 2134px
                （约一屏 5.2 张）。本面板货架实测约 1483px，按同比例只有约 283px，
                在并排对比时明显比官网小一圈；这里改为**一屏 4 张**（约 359px），
                比原来放大一档、又不至于像官网那样大，并设 360px 上限
                （官网卡 407px）保证超宽窗口下不会超过官网尺寸。
                比例仍为官网实测的 3:4（407×542 = 0.751）。 */}
            <HorizontalShelf edgeControls="hover" ariaLabel="专属精选推荐" itemClassName="w-[calc((100%-3rem)/4)] min-w-[250px] max-w-[360px] shrink-0">
              {section.items.map(item => <FeaturedCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} portrait overlayMeta />)}
            </HorizontalShelf>
          </section>
        )
      case 'featured-cards':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-1rem)/2.2)] shrink-0">
              {section.items.map(item => <FeaturedCard key={`${section.id}-${item.id}`} item={item} items={section.items} />)}
            </HorizontalShelf>
          </section>
        )
      case 'banner':
        return (
          <section key={section.id}>
            <BannerCard section={section} />
          </section>
        )
      case 'show-cards':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-4rem)/4.5)] shrink-0">
              {section.items.map(item => <ShowCard key={`${section.id}-${item.id}`} item={item} />)}
            </HorizontalShelf>
          </section>
        )
      case 'grid': {
        const songsOnly = section.items.length > 0 && section.items.every(item => item.type === 'songs')
        // 同一 kind='grid' 下混着三种内容形态，官网给它们的卡片规格各不相同，
        // 不能共用一个 itemClassName（此前共用导致"卡片大小不一样"）。按内容类型隔离：
        //   · stations → 方卡（电台封面是方图）
        //   · radio-shows → 横卡（节目/单集）
        //   · music-videos / uploaded-videos / posts → 16:9 视频卡（「艺人分享」）
        const allStations = section.items.length > 0 && section.items.every(item => item.type === 'stations')
        const allVideo = section.items.length > 0 && section.items.every(item =>
          item.type === 'music-videos' || item.type === 'uploaded-videos' || item.type === 'posts')
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            {songsOnly ? (
              <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
                {section.items.slice(0, 30).map(item => (
                  <SongRow key={`${section.id}-${item.id}`} item={item} items={section.items} />
                ))}
              </div>
            ) : (
              <HorizontalShelf
                edgeControls="hover"
                ariaLabel={section.title}
                itemClassName={
                  allStations
                    // 方卡：一屏约 6 张（官网 172×172 方形货架）
                    ? 'w-[calc((100%-5rem)/6)] min-w-[132px] shrink-0'
                    : allVideo
                      // 16:9 视频卡：一屏约 4 张（官网「艺人分享」行）
                      ? 'w-[calc((100%-3rem)/4)] min-w-[200px] shrink-0'
                      : 'w-[calc((100%-4rem)/4.5)] min-w-[190px] shrink-0'
                }
              >
                {section.items.map(item => (
                  item.type === 'stations'
                    ? <StationCard key={`${section.id}-${item.type}-${item.id}`} item={item} />
                    : item.type === 'radio-shows'
                      ? <ShowCard key={`${section.id}-${item.type}-${item.id}`} item={item} />
                      : <FeaturedCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} />
                ))}
              </HorizontalShelf>
            )}
          </section>
        )
      }
      case 'chart': {
        const chartItemType = section.items.length > 0 && section.items.every(item => item.type === section.items[0].type)
          ? section.items[0].type
          : null
        if (!chartItemType) {
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={`${section.items.length} 项 · 点击查看完整榜单`} />
              <button
                type="button"
                onClick={() => setChartDetail(section)}
                className="group flex w-full items-center gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-4 text-left transition hover:bg-white/[0.07]"
              >
                <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                  <Trophy className="h-7 w-7 opacity-50" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold">{section.title}</span>
                  <span className="mt-1 block truncate text-xs text-white/40">歌曲、专辑、歌单与视频</span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-white/25 transition group-hover:text-white/60" />
              </button>
            </section>
          )
        }
        // 歌曲榜：实测官网为 40×40 紧凑行、每行 4 个、6 行（最多 24 条）。
        if (chartItemType === 'songs') {
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={`Top ${section.items.length} 首`} />
              <div className="grid gap-x-6 gap-y-0.5 md:grid-cols-2 xl:grid-cols-4">
                {section.items.slice(0, 24).map((item, rank) => (
                  <SongRow key={`${section.id}-${item.id}`} item={item} items={section.items} rank={rank + 1} />
                ))}
              </div>
            </section>
          )
        }
        // 专辑/歌单榜：实测官网为 172×172 方形货架。
        if (chartItemType === 'albums' || chartItemType === 'playlists') {
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={`${section.items.length} 项`} />
              <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-4rem)/5.6)] shrink-0">
                {section.items.map(item => (
                  <RowCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} fluid />
                ))}
              </HorizontalShelf>
            </section>
          )
        }
        // 视频榜：视频卡网格（站内播放）
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle="热门音乐视频" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {section.items.map(item => (
                <button type="button" key={`${section.id}-${item.id}`} className="group min-w-0 cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]" onClick={() => playVideo(item)}>
                  <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                    {item.artworkUrl ? (
                      <AppleExploreImage src={item.artworkUrl} alt={item.name} className="aspect-square w-full transition duration-500 group-hover:scale-[1.03]" role="card" />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                        <MusicGlyph className="h-7 w-7 opacity-40" />
                      </div>
                    )}
                    <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/85 opacity-0 [@media(hover:none)]:opacity-100 backdrop-blur-md transition group-hover:opacity-100">
                      <Play className="h-4 w-4 fill-current" />
                    </span>
                  </div>
                  <div className="mt-2 px-0.5">
                    <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-white/40">{item.artistName || item.subtitle || 'Apple Music'}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )
      }
      case 'row':
      default:
        // 资料库：官网是「N 行 + 每行 5 个并露出第 6 个一点」的横向货架
        // （最近添加/艺人/专辑 2 行，歌曲 4 行）；区块标题右侧箭头进入二级铺开页。
        if (section.layoutType === 'library-rows' || section.layoutType === 'library-track-rows') {
          const rows = section.layoutType === 'library-track-rows' ? 4 : 2
          const columns = chunkBy(section.items, rows)
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle
                title={section.title}
                subtitle={section.subtitle}
                onOpen={() => openSectionSpread(section)}
                entryLabel={`打开${section.title}`}
              />
              <HorizontalShelf
                edgeControls="hover"
                ariaLabel={section.title}
                itemClassName="w-[calc((100%-4rem)/5.5)] shrink-0"
              >
                {columns.map((column, columnIndex) => (
                  <div key={`${section.id}-col-${columnIndex}`} className="flex w-full flex-col gap-4">
                    {column.map(item => (
                      <RowCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} fluid />
                    ))}
                  </div>
                ))}
              </HorizontalShelf>
            </section>
          )
        }
        if (section.layoutType === 'library-grid') {
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
                {section.items.map(item => (
                  <RowCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={section.items} fluid />
                ))}
              </div>
            </section>
          )
        }
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} section={section} />
            <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-4rem)/5.6)] shrink-0">
              {section.items.map(item => <RowCard key={`${section.id}-${item.id}`} item={item} items={section.items} fluid />)}
              {section.items.length === 0 && (
                <div className="w-full px-4 py-6 text-sm text-white/36">暂无内容</div>
              )}
            </HorizontalShelf>
          </section>
        )
    }
  }

  const SectionTitle = ({ title, subtitle, section, onOpen, entryLabel }: {
    title: string
    subtitle?: string
    section?: AppleWebSection
    /** 通用区块入口（资料库分区用；room/multiroom 走 section 上的引用字段）。 */
    onOpen?: () => void
    entryLabel?: string
  }) => {
    if (!title) return null
    // 区块标题的 `>` 入口有三个来源，均为实测：
    //  1) room / multiroom 引用（新发现/广播的编辑区块）
    //  2) onOpen（资料库分区的铺开页）
    //  3) hasSeeAll（主页推荐组，如「最近播放」→ 组级 contents 二级页）
    // 城市排行榜在接口里同样带 room 引用，但官网该区块不渲染链接，故按可观察行为显式排除。
    const showEntry = Boolean(onOpen)
      || (Boolean(section) && title !== '城市排行榜' && Boolean(section?.roomId || section?.multiRoomId))
      || Boolean(section?.hasSeeAll && section?.contentsPath)
    const openEntry = () => {
      if (onOpen) { onOpen(); return }
      if (section?.roomId) void openLayer('room', section.roomId, title)
      else if (section?.multiRoomId) void openLayer('multiroom', section.multiRoomId, title)
      else if (section?.hasSeeAll && section?.contentsPath) openRecommendationContents(section)
    }
    // 官网页样式（实测 music.apple.com 首页）：可点区块的标题是「内联 chevron 紧贴标题」。
    // 「更多相似作品」这类标题在接口里额外带 contentIds（标题引用的资源），官网会在标题左侧
    // 放一张该资源的小方图，标题同时改用去掉资源名后的短名（titleWithoutName）。
    const displayTitle = section?.titleCoverUrl && section.titleWithoutName
      ? section.titleWithoutName
      : title
    const coverUrl = section?.titleCoverUrl || section?.items?.find(item => item.artworkUrl)?.artworkUrl
    // 标题小图只在「标题自带引用资源」时出现；普通 room 区块沿用旧样式，避免全站标题都长出方图。
    const showTitleCover = Boolean(section?.titleCoverUrl && coverUrl)
    // 标题引用的资源（如「更多相似作品」指向的那张专辑）：点标题即打开它，与官网一致。
    const titleSeedItem = section?.titleContentIds?.length
      ? section.items.find(item => section.titleContentIds!.includes(String(item.playId || item.id)))
      : undefined
    const openTitle = () => {
      if (titleSeedItem) { activateItem(titleSeedItem, [titleSeedItem]); return }
      openEntry()
    }
    if (showTitleCover && coverUrl) {
      return (
        <div className="flex items-center gap-3 border-b border-white/[0.08] pb-3">
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            className="h-10 w-10 shrink-0 rounded-md border border-white/12 object-cover"
          />
          <button
            type="button"
            aria-label={entryLabel || `打开${displayTitle}`}
            onClick={openTitle}
            className="group flex min-w-0 items-center gap-0.5 text-left"
          >
            <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{displayTitle}</h3>
            <ChevronRight className="h-4 w-4 shrink-0 text-white/45 transition group-hover:translate-x-0.5 group-hover:text-white" />
          </button>
        </div>
      )
    }
    return (
    <div className="flex items-center gap-1.5 border-b border-white/[0.08] pb-2.5">
      {/* 箭头紧贴标题文字（官网样式），不是推到行尾；可点标题整块也是按钮。 */}
      {showEntry ? (
        <button
          type="button"
          aria-label={entryLabel || `打开${displayTitle}`}
          onClick={openEntry}
          className="group flex min-w-0 items-center gap-0.5 text-left"
        >
          <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{displayTitle}</h3>
          <ChevronRight className="h-4 w-4 shrink-0 text-white/45 transition group-hover:translate-x-0.5 group-hover:text-white" />
        </button>
      ) : (
        <h3 className="min-w-0 truncate text-lg font-semibold tracking-tight">{displayTitle}</h3>
      )}
      {subtitle && <p className="ml-1 min-w-0 truncate text-xs text-white/42">{subtitle}</p>}
    </div>
    )
  }

  /**
   * 渲染整页分区：连续的 banner（如广播页「推荐单集」多张宽幅大卡）
   * 合并为 2 列网格（web /radio 同款并排布局），其余分区原样渲染。
   */
  const renderAllSections = (sections: AppleWebSection[], context: SectionContext = 'default') => {
    const nodes: ReactNode[] = []
    let index = 0
    while (index < sections.length) {
      const section = sections[index]
      if (section.kind === 'new-hero'
        || (section.kind === 'banner' && (() => {
          // 仅当 banner 组后面紧跟卡片组（新发现顶行）才并入合并货架；
          // 广播页的纯 banner 组保持 BannerCard 样式，不受影响。
          let i = index
          while (i < sections.length && sections[i].kind === 'banner') i += 1
          const next = sections[i]
          return Boolean(next && (next.kind === 'new-hero' || next.kind === 'featured-cards'))
        })())) {
        // 官网「新发现」顶部：必听经典(banner 320)与徽章卡(317)是同一行"文字在上"卡片，
        // 不带区块标题。相邻的 banner / new-hero / featured-cards 合并为一个货架，
        // banner 转为携带宽幅海报的伪条目，避免被拆成多个板块或渲染成全宽大卡。
        const group: AppleWebSection[] = [section]
        index += 1
        while (index < sections.length && (sections[index].kind === 'banner' || sections[index].kind === 'featured-cards' || sections[index].kind === 'new-hero')) {
          group.push(sections[index])
          index += 1
        }
        const heroItems: AppleWebItem[] = group.flatMap(entry => {
          if (entry.kind !== 'banner') return entry.items
          const base = entry.items[0]
          if (!base) return []
          return [{
            ...base,
            bannerUrl: entry.bannerUrl || base.bannerUrl,
            badge: entry.title || base.badge,
            tag: entry.tag || base.tag,
          }]
        })
        nodes.push(
          <section key={`${section.id}-hero-shelf`} className="space-y-3">
            {/* 实测官网精品推荐：卡片 540×310、文字在上、一屏 2 张并露出第三张约 45px，横向滚动。 */}
            <HorizontalShelf edgeControls="hover" ariaLabel="精品推荐" itemClassName="w-[calc((100%-1rem)/2.2)] shrink-0">
              {heroItems.map(item => (
                <FeaturedCard key={`${section.id}-${item.type}-${item.id}`} item={item} items={heroItems} textFirst />
              ))}
            </HorizontalShelf>
          </section>,
        )
      } else if (section.kind === 'banner') {
        const banners: AppleWebSection[] = []
        while (index < sections.length && sections[index].kind === 'banner') {
          banners.push(sections[index])
          index += 1
        }
        // 官网单张/多张 banner 都是紧凑横卡货架（~2.2 分之一内容宽、460×260），不是全宽大卡；
        // 全宽渲染会把 4320×1080 组合图 object-cover 放大数倍（"周年纪念"文字巨大且错位）。
        nodes.push(
          <section key={`${banners[0].id}-banner-shelf`} className="space-y-3">
            <SectionTitle title={banners[0].title || (tab === 'browse' ? '精品推荐' : '推荐')} />
            <HorizontalShelf edgeControls="hover" ariaLabel={tab === 'browse' ? '精品推荐' : '推荐'} itemClassName="w-[calc((100%-1rem)/2.2)] shrink-0">
              {banners.map(banner => <BannerCard key={banner.id} section={banner} />)}
            </HorizontalShelf>
          </section>,
        )
      } else {
        nodes.push(renderSection(section, context))
        index += 1
      }
    }
    return nodes
  }

  const skeleton = (
    <div className="space-y-10">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="space-y-3">
          <div className={`h-5 w-44 rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'}`} />
          <div className="flex gap-3">
            {[0, 1, 2, 3, 4].map((card) => (
              <div key={card} className={`h-44 w-40 shrink-0 rounded-2xl ${cardBg} ${isDark ? 'bg-white/[0.05]' : 'bg-black/[0.04]'}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  /** 曲目列表行（歌单/专辑抽屉共用） */
  function renderTrackRows(loadingTracks: boolean, tracks: Song[]) {
    const drawerOrigin = albumDrawer
      ? appleOrigin({ drawerType: 'album', item: albumDrawer.album })
      : artistDrawer
        ? appleOrigin({ drawerType: 'artist', item: artistDrawer.artist })
        : appleOrigin()
    return (
      <div className="mt-4 max-h-[58vh] overflow-y-auto px-3 pb-6">
        {loadingTracks && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在加载曲目…
          </div>
        )}
        {!loadingTracks && tracks.length === 0 && (
          <div className="py-10 text-center text-sm text-white/40">没有加载到曲目</div>
        )}
        {tracks.map((song, index) => (
          <div
            key={`${song.appleId || song.id}-${index}`}
            className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.06]"
            onClick={() => void onSongSelect(song, tracks, drawerOrigin)}
          >
            <span className="w-5 text-center text-xs text-white/30">{index + 1}</span>
            {song.album?.picUrl
              ? <AppleExploreImage src={song.album.picUrl} alt="" className="h-10 w-10 rounded-lg" role="row" />
              : <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.07]"><MusicGlyph className="h-5 w-5 opacity-40" /></div>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{song.name}</p>
              <p className="truncate text-xs text-white/45">{song.artists.map(artist => artist.name).join(' / ')}</p>
            </div>
            <button
              type="button"
              aria-label="播放"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 [@media(hover:none)]:opacity-100 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
              onClick={(event) => { event.stopPropagation(); void onSongSelect(song, tracks, drawerOrigin) }}
            >
              <Play className="h-4 w-4 fill-current" />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const albumDrawerEl = albumDrawer && (
    <div data-tv-scope className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setAlbumDrawer(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-4">
            {albumDrawer.album.artworkUrl
              ? <AppleExploreImage src={albumDrawer.album.artworkUrl} alt="" className="h-16 w-16 rounded-2xl" role="hero" priority="visible" />
              : <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.07]"><Disc3 className="h-6 w-6 opacity-50" /></div>}
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{albumDrawer.album.name}</h3>
              <p className="mt-0.5 text-xs text-white/45">{albumDrawer.album.artistName || '专辑'} · {albumDrawer.tracks.length} 首</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setAlbumDrawer(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {renderTrackRows(albumDrawer.loadingTracks, albumDrawer.tracks)}
      </motion.div>
    </div>
  )

  const artistDrawerEl = artistDrawer && (
    <div data-tv-scope className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setArtistDrawer(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-4">
            {artistDrawer.artist.artworkUrl
              ? <AppleExploreImage src={artistDrawer.artist.artworkUrl} alt="" className="h-16 w-16 rounded-full" role="hero" priority="visible" />
              : <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.07]"><UserRound className="h-7 w-7 opacity-50" /></div>}
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{artistDrawer.artist.name}</h3>
              <p className="mt-0.5 text-xs text-white/45">资料库专辑 {artistDrawer.albums.length} 张</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setArtistDrawer(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 max-h-[60vh] overflow-y-auto px-4 pb-6">
          {artistDrawer.loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在加载专辑…
            </div>
          )}
          {!artistDrawer.loading && artistDrawer.albums.length === 0 && (
            <div className="py-10 text-center text-sm text-white/40">资料库中没有该艺人的专辑</div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {artistDrawer.albums.map(album => (
              <motion.div
                key={album.id}
                whileHover={{ y: -2 }}
                onClick={() => { setArtistDrawer(null); void openAlbumDrawer(album) }}
                className="group cursor-pointer rounded-2xl border border-white/[0.08] bg-white/[0.05] p-2"
              >
                {album.artworkUrl
                  ? <AppleExploreImage src={album.artworkUrl} alt={album.name} className="aspect-square w-full rounded-xl" role="card" />
                  : <div className="aspect-square w-full rounded-xl bg-white/[0.06] flex items-center justify-center"><Disc3 className="h-7 w-7 opacity-40" /></div>}
                <p className="mt-2 truncate text-[13px] font-medium">{album.name}</p>
                <p className="truncate text-[11px] text-white/45">{album.artistName}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  )

  /** 排行榜抽屉（歌曲/专辑榜完整排名：名次 + 封面 + 名称 + 艺人，点行播放） */
  /** 帖子详情弹窗（艺人分享 /post/…） */
  const postDetailEl = postDetail && (
    <div data-tv-scope className="fixed inset-0 z-[180] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setPostDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="relative h-52 w-full overflow-hidden">
          {postDetail.item.artworkUrl ? (
            <AppleExploreImage src={postDetail.item.artworkUrl} alt="" className="h-full w-full" role="hero" priority="visible" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/[0.05]">
              <UserRound className="h-10 w-10 opacity-40" />
            </div>
          )}
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(12,16,23,1)_0%,rgba(12,16,23,0.25)_60%,transparent_100%)]" />
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setPostDetail(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-md hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 pt-2">
          <h3 className="text-xl font-semibold">{postDetail.item.name}</h3>
          <p className="mt-1 text-xs text-white/45">{postDetail.item.artistName || postDetail.item.subtitle || 'Apple Music 艺人分享'}</p>
          {postDetail.loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载帖子…
            </div>
          )}
          {postDetail.detail?.body && (
            <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-white/70">{postDetail.detail.body}</p>
          )}
          {postDetail.detail?.media && postDetail.detail.media.length > 0 && (
            <div className="mt-5 space-y-2">
              <p className="text-xs font-medium text-white/45">帖子内容</p>
              {postDetail.detail.media.map(media => (
                <button
                  key={`${media.type}-${media.id}`}
                  type="button"
                  onClick={() => {
                    if (media.type === 'songs') playItemWithQueue(media, (postDetail.detail?.media || []).filter(m => m.type === 'songs'))
                    else if (media.type === 'music-videos') playVideo(media)
                    else if (media.type === 'playlists') openPlaylistPanel(media)
                    else if (media.type === 'albums') onOpenAlbum ? onOpenAlbum(media.playId || media.id, 'apple') : void 0
                  }}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] p-2.5 text-left transition hover:bg-white/[0.08]"
                >
                  {media.artworkUrl ? (
                    <AppleExploreImage src={media.artworkUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg" role="compact" />
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
                      {media.type === 'music-videos' ? <MusicGlyph className="h-5 w-5 opacity-50" /> : <ListMusic className="h-5 w-5 opacity-50" />}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{media.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/40">
                      {media.artistName || media.subtitle || ({ songs: '歌曲', albums: '专辑', 'music-videos': '音乐视频', playlists: '歌单' } as Record<string, string>)[media.type] || 'Apple Music'}
                    </span>
                  </span>
                  <Play className="ml-auto h-4 w-4 shrink-0 text-white/40" />
                </button>
              ))}
            </div>
          )}
          {!postDetail.loading && !postDetail.detail && (
            <p className="mt-4 text-sm text-white/40">帖子详情暂不可用，可前往 Apple Music 网页查看。</p>
          )}
        </div>
      </motion.div>
    </div>
  )

  const chartDrawer = chartDetail && (
    <div data-tv-scope className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setChartDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.07]">
              <Trophy className="h-5 w-5 text-white/60" />
            </span>
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{chartDetail.title}</h3>
              <p className="mt-0.5 text-xs text-white/45">{chartDetail.items.length} 项 · Apple Music 官方榜单</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setChartDetail(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 max-h-[58vh] overflow-y-auto px-3 pb-6">
          {chartDetail.items.map((item, index) => (
            <div
              key={`${chartDetail.id}-${item.id}`}
              className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.06]"
              onClick={() => {
                if (item.type === 'playlists') openPlaylistPanel(item)
                else if (item.type === 'albums') onOpenAlbum ? onOpenAlbum(item.playId || item.id, 'apple') : void 0
                else if (item.type === 'music-videos') playVideo(item)
                else playItemWithQueue(item, chartDetail.items)
              }}
            >
              <span className={`w-7 shrink-0 text-center text-sm tabular-nums ${index < 3 ? 'font-semibold' : 'text-white/30'}`} style={index < 3 ? { color: accentColor } : undefined}>
                {index + 1}
              </span>
              {item.artworkUrl ? (
                <AppleExploreImage src={item.artworkUrl} alt={item.name} className="h-11 w-11 shrink-0 rounded-lg" role="row" />
              ) : (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/[0.07]">
                  <MusicGlyph className="h-5 w-5 opacity-40" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="truncate text-xs text-white/45">{item.artistName || item.curatorName || item.subtitle || 'Apple Music'}</p>
              </div>
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 [@media(hover:none)]:opacity-100 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100"
                aria-hidden="true"
              >
                <Play className="h-4 w-4 fill-current" />
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  )

  const radioShowDrawer = radioShowDetail && (
    <div
      data-tv-scope
      className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm"
      onClick={(event) => { if (event.target === event.currentTarget) setRadioShowDetail(null) }}
    >
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] p-6">
          <div className="flex min-w-0 items-center gap-4">
            {radioShowDetail.item.artworkUrl || radioShowDetail.item.bannerUrl ? (
              <AppleExploreImage src={radioShowDetail.item.artworkUrl || radioShowDetail.item.bannerUrl || ''} alt="" className="h-20 w-20 shrink-0 rounded-xl" role="hero" priority="visible" />
            ) : (
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-white/[0.07]"><Radio className="h-7 w-7 opacity-50" /></div>
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#fa2d48]">广播节目</p>
              <h3 className="mt-1 truncate text-xl font-semibold">{radioShowDetail.item.name}</h3>
              {radioShowDetail.item.description && <p className="mt-2 line-clamp-2 text-sm text-white/50">{radioShowDetail.item.description}</p>}
            </div>
          </div>
          <button type="button" aria-label="关闭" onClick={() => setRadioShowDetail(null)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="max-h-[58vh] overflow-y-auto p-4">
          {radioShowDetail.loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />正在加载节目单集…</div>
          ) : radioShowDetail.detail?.episodes.length ? (
            <div className="space-y-2">
              {radioShowDetail.detail.episodes.map((episode, index) => (
                <button
                  key={`${episode.type}-${episode.id}`}
                  type="button"
                  onClick={() => { setRadioShowDetail(null); if (episode.type === 'stations') void openStation(episode); else playVideo(episode) }}
                  className="flex w-full items-center gap-3 rounded-xl p-3 text-left transition hover:bg-white/[0.07]"
                >
                  <span className="w-6 shrink-0 text-center text-xs tabular-nums text-white/35">{index + 1}</span>
                  {episode.artworkUrl ? <AppleExploreImage src={episode.artworkUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg" role="row" /> : <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/[0.07]"><Radio className="h-5 w-5 opacity-45" /></div>}
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{episode.name}</span><span className="mt-0.5 block truncate text-xs text-white/45">{episode.showName || episode.subtitle || 'Apple Music 广播'}</span></span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-white/35" />
                </button>
              ))}
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-white/45">该节目暂未返回可播放单集</div>
          )}
        </div>
      </motion.div>
    </div>
  )

  /** 电台详情抽屉（web /station 同款：动态封面 + 描述 + 加入资料库 + 浏览器打开） */
  const stationDrawer = stationDetail && (
    <div data-tv-scope className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setStationDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        {/* 动态封面头部。圆角必须放在视频最近的可裁剪祖先上并独立层叠上下文：
            合成中的 <video> 会逃逸祖先的 border-radius 裁剪（直角 bug）。 */}
        <div className="relative h-72 w-full overflow-hidden rounded-t-[28px] isolate">
          <DynamicCover item={stationDetail.station} className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(12,16,23,1)_0%,rgba(12,16,23,0.25)_60%,transparent_100%)]" />
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setStationDetail(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-md hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          {stationDetail.station.isLive && (
            <span className="absolute left-4 top-4 rounded-md bg-[#fa2d48] px-2 py-1 text-[11px] font-semibold text-white">直播中</span>
          )}
        </div>
        <div className="p-6 pt-2">
          <h3 className="text-xl font-semibold">{stationDetail.station.name}</h3>
          <p className="mt-1 text-xs text-white/45">
            {stationDetail.station.showName || 'Apple Music 电台'}
            {stationDetail.station.airTime?.start && !stationDetail.station.isLive
              ? ` · 播出 ${new Date(stationDetail.station.airTime.start).toLocaleDateString('zh-CN')}`
              : ''}
          </p>
          {stationDetail.loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载电台详情…
            </div>
          )}
          {stationDetail.station.description && (
            <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-white/60">{stationDetail.station.description}</p>
          )}
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => { setStationDetail(null); void playStation(stationDetail.station) }}
              className="flex flex-1 items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold"
              style={{ background: accentColor, color: '#0a0f14' }}
            >
              <Play className="h-4 w-4 fill-current" /> 播放电台
            </button>
            {stationDetail.station.url && (
              <button
                type="button"
                aria-label="在 Apple Music 打开"
                onClick={() => openExternal(stationDetail.station.url)}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] text-white/70 transition hover:bg-white/[0.1]"
              >
                <ExternalLink className="h-4 w-4" />
              </button>
            )}
          </div>
          {!appleLoggedIn && <p className="mt-2 text-center text-xs text-white/40">登录后可收藏电台；播放直播需登录 Apple Music</p>}
        </div>
      </motion.div>
    </div>
  )

  return (
    <MotionSuspendContext.Provider value={motionSuspended}>
    <div
      className="space-y-6"
      ref={panelRef}
      data-apple-explore-panel
      onDragStart={event => {
        if (event.target instanceof HTMLImageElement) event.preventDefault()
      }}
    >
      {/* 未登录提示 */}
      {!appleLoggedIn && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
          <p className="text-sm text-white/55">
            <span className="mr-2"><Sparkles className="inline h-4 w-4" /></span>
            登录 Apple Music 后这里会变成你的个性化主页（最近播放 / 专属推荐 / 口味推荐）与最近收听的电台。
          </p>
          <button
            type="button"
            onClick={onLoginClick}
            className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: accentColor, color: '#0a0f14' }}
          >
            <LogIn className="h-4 w-4" /> 登录 Apple Music
          </button>
        </div>
      )}

      {/* 页签 + 商店标识（商店 chip 放资料库右侧；刷新入口在探索页顶栏「换一批」位置） */}
      <div role="tablist" aria-label="Apple Music 页面" className="no-scrollbar flex items-center gap-2 overflow-x-auto pb-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => {
              // 切换页签必须退出站内嵌套层级栈，否则会一直停在二级/三级页面上（此前必须手动「返回」才能切走）。
              if (layers.length > 0) setLayers([])
              setTab(id)
            }}
            className={`flex h-10 shrink-0 items-center gap-2 rounded-full px-5 text-sm font-medium transition ${
              tab === id
                ? 'text-[#081017]'
                : 'border border-white/[0.1] bg-white/[0.045] text-white/60 hover:bg-white/[0.09] hover:text-white'
            }`}
            style={tab === id ? { background: accentColor } : undefined}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
        <span className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 text-xs uppercase text-white/40">
          {storefront} 商店
        </span>
      </div>

      {/* 内容 */}
      {activeLayer && (
        <motion.div
          key={`${activeLayer.kind}-${activeLayer.id}-${layers.length}`}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: 'easeOut' }}
          className="space-y-6"
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* 房子：直接回到「新发现」根层级，并恢复进入子层前的滚动位置 */}
            <button
              type="button"
              onClick={() => goToDepth(0)}
              aria-label="回到新发现"
              title="回到新发现"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/[0.1] bg-white/[0.045] text-white/70 transition hover:bg-white/[0.09] hover:text-white"
            >
              <Home className="h-4 w-4" />
            </button>
            {/* 返回：回到上一层级，并恢复该层滚动位置 */}
            <button
              type="button"
              onClick={() => goToDepth(layers.length - 1)}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.045] px-3.5 text-sm text-white/70 transition hover:bg-white/[0.09] hover:text-white"
            >
              <ChevronRight className="h-4 w-4 rotate-180" /> 返回
            </button>
            {/* 路径：新发现 > 年代之声 > Apple Music 怀旧，每段可直接跳转 */}
            <nav aria-label="浏览路径" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => goToDepth(0)}
                className="shrink-0 rounded px-1.5 py-0.5 text-white/55 transition hover:bg-white/[0.08] hover:text-white"
              >
                新发现
              </button>
              {layers.map((layer, index) => (
                <span key={`${layer.kind}-${layer.id}-${index}`} className="flex min-w-0 items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/25" />
                  <button
                    type="button"
                    onClick={() => goToDepth(index + 1)}
                    aria-current={index === layers.length - 1 ? 'page' : undefined}
                    className={`max-w-[14rem] truncate rounded px-1.5 py-0.5 transition hover:bg-white/[0.08] ${
                      index === layers.length - 1 ? 'font-medium text-white/85' : 'text-white/55 hover:text-white'
                    }`}
                  >
                    {layer.name}
                  </button>
                </span>
              ))}
            </nav>
          </div>
          <h2 className="text-2xl font-semibold">{activeLayer.name}</h2>
          {activeLayer.curator && (
            <div className="flex items-center gap-4">
              {activeLayer.curator.curator.artworkUrl && (
                <AppleExploreImage
                  src={activeLayer.curator.curator.heroArtworkUrl || activeLayer.curator.curator.artworkUrl}
                  alt={activeLayer.curator.curator.name}
                  className="h-24 w-24 rounded-2xl"
                  role="hero"
                />
              )}
              <div className="min-w-0 text-sm text-white/55">
                <p className="truncate text-base font-medium text-white/85">{activeLayer.curator.curator.name}</p>
                {typeof activeLayer.curator.playlistCount === 'number' && (
                  <p className="mt-0.5">{activeLayer.curator.playlistCount} 个歌单</p>
                )}
              </div>
            </div>
          )}
          {activeLayer.loading ? skeleton : activeLayer.page ? (
            <>
              {renderAllSections(activeLayer.page.sections, activeLayer.kind === 'room' ? 'room' : 'browse')}
              {activeLayer.page.sections.length === 0 && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
                  {activeLayer.page.sourceLabel}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
              {activeLayer.kind} 加载失败
            </div>
          )}
        </motion.div>
      )}
      {!activeLayer && (<>
      {currentError && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-rose-300/15 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-100/80">
          <span>加载失败：{currentError}</span>
          <button
            type="button"
            onClick={() => { if (tab !== 'categories') void loadTab(tab, true) }}
            className="shrink-0 rounded-full border border-rose-100/20 px-3 py-1.5 text-xs font-medium hover:bg-rose-100/10"
          >
            重试
          </button>
        </div>
      )}
      {tab === 'categories' ? (
        /* 搜索（1:1 复刻 music.apple.com/cn/search）：
           搜索框 + 「Apple Music / 你的资料库」范围切换 + 分区结果（最佳结果/艺人/专辑/歌曲/播放列表）。
           无关键词时展示落地视图——沿用原来的「类别浏览」curator 网格。 */
        <AppleMusicSearchPage
          key={categoriesVersion}
          playerTheme={playerTheme}
          storefront={storefront}
          onSongSelect={onSongSelect}
          playbackOrigin={appleOrigin({ category: true })}
          onOpenItem={activateItem}
          onOpenPlaylist={(playlist) =>
            openPlaylistPanel({
              id: playlist.id,
              playId: playlist.id,
              type: 'playlists',
              name: playlist.name,
              artworkUrl: playlist.coverImgUrl,
              curatorName: playlist.creator,
              trackCount: playlist.trackCount,
            })
          }
          renderLanding={() => (
            <BrowseCategoriesLanding
              playerTheme={playerTheme}
              storefront={storefront}
              onSongSelect={onSongSelect}
              playbackOrigin={appleOrigin({ category: true })}
              onOpenItem={activateItem}
              onOpenPlaylist={(playlist) =>
                openPlaylistPanel({
                  id: playlist.id,
                  playId: playlist.id,
                  type: 'playlists',
                  name: playlist.name,
                  artworkUrl: playlist.coverImgUrl,
                  curatorName: playlist.creator,
                  trackCount: playlist.trackCount,
                })
              }
            />
          )}
        />
      ) : currentLoading && !currentPage ? (
        skeleton
      ) : currentPage ? (
        <>
          <div className="space-y-10">
            {currentPage.fallbackReason && (
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200/15 bg-amber-200/[0.06] px-4 py-3 text-sm text-amber-50/75">
                <span>{currentPage.fallbackReason}</span>
                {/* 登录失效 → 重新登录；订阅失效 → 去官网续订（重新登录不会恢复订阅） */}
                {currentPage.subscriptionExpired ? (
                  <a
                    href="https://music.apple.com/cn/subscribe"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-black"
                  >
                    前往续订
                  </a>
                ) : currentPage.requiresLogin ? (
                  <button type="button" onClick={onLoginClick} className="shrink-0 rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-black">重新登录</button>
                ) : null}
              </div>
            )}
            {/* 页面主视觉大卡（web powerswoosh：动态封面优先） */}
            {currentPage.hero && (
              <section className="relative overflow-hidden rounded-[28px] border border-white/[0.09] shadow-2xl shadow-black/20">
                <div className="absolute inset-0">
                  <DynamicCover item={currentPage.hero} className="h-full w-full object-cover" />
                  <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.9)_8%,rgba(6,9,14,0.25)_58%,rgba(6,9,14,0.08)_100%)]" />
                </div>
                <div className="relative flex min-h-[320px] flex-col justify-end p-6 md:p-10">
                  <div className="mb-auto flex items-center gap-2 text-xs font-medium text-white/65">
                    <Sparkles className="h-4 w-4" style={{ color: accentColor }} />
                    Apple Music · {tab === 'radio' ? '广播精选' : tab === 'browse' ? '新发现' : '专属推荐'}
                  </div>
                  {currentPage.hero.artworkUrl || currentPage.hero.heroArtworkUrl ? (
                    <AppleExploreImage
                      src={currentPage.hero.heroArtworkUrl || currentPage.hero.artworkUrl || ''}
                      alt=""
                      className="mb-4 h-28 w-28 rounded-2xl shadow-lg md:h-32 md:w-32"
                      role="hero"
                      priority="critical"
                      lazy={false}
                    />
                  ) : null}
                  <h2 className="max-w-xl text-2xl font-semibold leading-tight md:text-4xl">{currentPage.hero.name}</h2>
                  {currentPage.hero.subtitle && <p className="mt-1.5 max-w-lg text-sm text-white/58">{currentPage.hero.subtitle}</p>}
                  <div className="mt-5 flex items-center gap-3">
                    {currentPage.hero.type === 'songs' && currentPage.hero.playId ? (
                      <button
                        type="button"
                        onClick={() => playItem(currentPage.hero!)}
                        className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#0a0f14] transition hover:brightness-110"
                        style={{ background: accentColor }}
                      >
                        <Play className="h-4 w-4 fill-current" /> 立即播放
                      </button>
                    ) : (currentPage.hero.type === 'playlists' || currentPage.hero.type === 'stations') && currentPage.hero.playId ? (
                      <button
                        type="button"
                        onClick={() => currentPage.hero!.type === 'stations'
                          ? void playStation(currentPage.hero!)
                          : openPlaylistPanel(currentPage.hero!)}
                        className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#0a0f14] transition hover:brightness-110"
                        style={{ background: accentColor }}
                      >
                        <ListMusic className="h-4 w-4" /> {currentPage.hero.type === 'stations' ? '播放电台' : '打开歌单'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            )}
            {renderAllSections(currentPage.sections, tab === 'browse' ? 'browse' : 'default')}
            {currentPage.sections.length === 0 && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
                {currentPage.sourceLabel}
              </div>
            )}
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5 text-xs text-white/28">
            <span>来源：{currentPage.sourceLabel}</span>
          </footer>
        </>
      ) : null}
      </>)}
      {albumDrawerEl}
      {artistDrawerEl}
      {chartDrawer}
      {radioShowDrawer}
      {stationDrawer}
      {postDetailEl}
      {videoItem && (
        <AppleVideoModal
          item={videoItem}
          onClose={() => setVideoItem(null)}
          onPlaybackStart={onVideoPlaybackStart}
        />
      )}
    </div>
    </MotionSuspendContext.Provider>
  )
}

/** 歌曲占位图标（内联，避免额外依赖） */
function MusicGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 17 4.2v9.47a3 3 0 1 1-2-2.83V8.06l-6 1.5v8.94Z" />
    </svg>
  )
}
