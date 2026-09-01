/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from 'react'
import { PLATFORM_CHANGED_EVENT, readSyncedPlatform, syncPlatformAcrossViews } from '../services/platformSync'
import { AnimatePresence, motion } from 'framer-motion'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'
import { isPerfModeEnhanced } from '../tv/perfMode'
import ModeSelectionPanel, { MODE_SELECTION_CLOSE_MS, MODE_SELECTION_PANEL_HEIGHT } from './ModeSelectionPanel'
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Crown,
  Disc3,
  Film,
  Globe,
  Headphones,
  Loader2,
  LogIn,
  MonitorSmartphone,
  Music2,
  Play,
  Radio,
  RefreshCw,
  Search,
  Settings,
  Sparkles,
  Trophy,
  UserRound,
  Waves,
  X,
} from 'lucide-react'
import PluginShortcuts from './PluginShortcuts'
import type { Song } from '../services/musicApi'
import { getNeteaseBanner, getQQBanner, neteaseRecommendDislike, neteaseFmTrash } from '../services/musicApi'
import {
  fetchExploreChannel,
  fetchExploreChart,
  fetchExploreHome,
  fetchExplorePlaylist,
  getExploreCookie,
  type ExploreChannel,
  type ExploreChart,
  type ExploreDetail,
  type ExplorePayload,
  type ExplorePlatform,
  type ExplorePlaylist,
} from '../services/exploreApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import MiniPlayer from './MiniPlayer'
import PlaylistDetailPanel from './PlaylistDetailPanel'
import { AppleExplorePanel } from './AppleExplorePanel'
import QQMusicJourney from './QQMusicJourney'
import NeteaseMusicJourney from './NeteaseMusicJourney'
import { getAppleLibraryPlaylists, APPLE_EXPLORE_COUNTRIES } from '../services/appleCatalog'
import { getPlatformCapabilities, getVisiblePlatforms, PLATFORM_VISIBILITY_EVENT, PLATFORM_ORDER_EVENT } from '../services/platforms'
import ExploreSettingsPanel, {
  EXPLORE_SECTION_LABELS,
  createDefaultExplorePreferences,
  normalizeExplorePreferences,
  type ExplorePreferences,
  type ExploreSectionId,
  type ExploreCardOpacity,
} from './ExploreSettingsPanel'
import SongContextMenu from './SongContextMenu'
import MVExploreModal from './MVExploreModal'
import { getUserPlaylists } from '../services/playlistService'
import type { PlaybackOrigin, SongSelectHandler } from '../types/playbackNavigation'
import type { MirrorActionId } from '../services/globalSettingsRegistry'
import { preloadOnIdle } from '../utils/lazyPreload'

// 全局设置镜像里的共享弹窗（按需加载）
const LazyAudioQualityModal = lazy(() => import('./AudioQualitySettingsModal'))
const LazyCacheClearModal = lazy(() => import('./CacheClearModal'))
const LazyRemoteSettingsModal = lazy(() => import('./RemoteControlSettingsModal'))

type ViewMode = 'explore' | 'minimal' | 'traditional' | 'desktop'
const appLogoUrl = new URL('../../logo.png', import.meta.url).href
// v2：酷狗探索数据修复（封面/真新歌榜/多榜单）后升级版本，强制旧缓存失效
// v3：榜单歌曲携带 appleId（目录曲目 id，原生取流必需）。v2 缓存里的 Apple 榜单
// 是无 appleId 的旧结构（id=榜单排名），按天缓存会让坏数据在当天内一直生效。
const EXPLORE_CACHE_KEY = 'exploreHomeCache-v3'
const EXPLORE_SESSION_REFRESH_PREFIX = 'exploreHomeRefreshed:'

/** 探索页平台元信息：名称 / 页签短名 / 主题色 / 主题色 RGB */
const EXPLORE_PLATFORM_META: Record<ExplorePlatform, { name: string; short: string; accent: string; accentRgb: string }> = {
  netease: { name: '网易云音乐', short: '网易云', accent: '#ff5a70', accentRgb: '255, 90, 112' },
  qq: { name: 'QQ 音乐', short: 'QQ 音乐', accent: '#31e68b', accentRgb: '49, 230, 139' },
  apple: { name: 'Apple Music', short: 'Apple Music', accent: '#fa2d48', accentRgb: '250, 45, 72' },
  spotify: { name: 'Spotify', short: 'Spotify', accent: '#1DB954', accentRgb: '29, 185, 84' },
  kugou: { name: '酷狗音乐', short: '酷狗音乐', accent: '#FF7A00', accentRgb: '255, 122, 0' },
  soda: { name: '汽水音乐', short: '汽水音乐', accent: '#38BDF8', accentRgb: '56, 189, 248' },
}

interface ExploreCacheEntry {
  accountKey: string
  dateKey: string
  payload: ExplorePayload
}

interface ExploreViewProps {
  onSongSelect: SongSelectHandler
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  currentSong?: Song | null
  isPlaying: boolean
  /** 播放时间不再经 App 每秒下传（会击穿 memo 整树重渲染）：改由内部叶子组件订阅 */
  playbackTimeStore: PlaybackTimeStore
  duration: number
  volume: number
  currentLyric?: string
  accentColor?: string
  playerTheme?: 'light' | 'dark'
  authRevision?: number
  neteaseLoggedIn: boolean
  neteaseUsername: string
  neteaseAvatar?: string
  neteaseUserId?: string
  neteaseVip?: boolean
  qqLoggedIn: boolean
  qqUsername: string
  qqAvatar?: string
  qqUserId?: string
  qqVip?: boolean
  appleLoggedIn: boolean
  appleUsername: string
  appleAvatar?: string
  appleStorefront?: string
  spotifyLoggedIn: boolean
  spotifyUsername: string
  spotifyAvatar?: string
  kugouLoggedIn: boolean
  kugouUsername: string
  kugouAvatar?: string
  sodaLoggedIn: boolean
  sodaUsername: string
  sodaAvatar?: string
  onLoginClick: (platform: ExplorePlatform) => void
  onProfileClick: (platform: ExplorePlatform) => void
  onSearchClick: () => void
  onRemoteClick: () => void
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onOpenPlayer: () => void
  onOpenArtist?: (artistId: string, platform: ExplorePlatform) => void
  onOpenAlbum?: (albumId: string, platform: ExplorePlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
}

interface CoverProps {
  src?: string
  alt: string
  className?: string
  iconClassName?: string
  eager?: boolean
}

const formatCount = (value?: number) => {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)}万`
  return String(count)
}

const formatReleaseDate = (value?: number | string) => {
  if (!value) return '新鲜发行'
  if (typeof value === 'string') return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '新鲜发行'
  return `${date.getMonth() + 1}月${date.getDate()}日`
}

const getGreeting = () => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了，听点轻柔的'
  if (hour < 11) return '早上好，开启今日声场'
  if (hour < 14) return '中午好，给耳朵放个假'
  if (hour < 18) return '下午好，发现一些新声音'
  return '晚上好，今晚想听什么'
}

// memo 包装：父级探索页内部状态（Banner 轮播、设置面板、换一批等）触发重渲染时，
// 封面 props 均为原始类型且引用稳定，可跳过所有列表项 Cover 的重渲染。
const Cover = memo(function Cover({ src, alt, className = '', iconClassName = 'w-8 h-8', eager = false }: CoverProps) {
  const [failed, setFailed] = useState(false)
  const resolved = src || ''

  useEffect(() => {
    setFailed(false)
  }, [resolved])

  if (!resolved || failed) {
    return (
      <div
        className={`flex items-center justify-center bg-[linear-gradient(135deg,rgba(124,92,255,0.9),rgba(20,184,166,0.72))] text-white/80 ${className}`}
        aria-label={alt}
      >
        <Music2 className={iconClassName} />
      </div>
    )
  }

  return (
    <img
      src={resolved}
      alt={alt}
      className={className}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
})

interface ExploreBannerItem {
  imageUrl: string
  url: string
  title: string
}

// 封面墙背景：用歌曲封面拼成的动态海报墙（电影封面墙效果）。
// 封面平铺 + 缓慢漂移 + 模糊遮罩，让前景内容清晰可读。
function CoverWallBackground({
  covers,
  style,
  animated,
  blurPx,
  accentRgb,
}: {
  covers: string[]
  style: 'tilted' | 'grid'
  animated: boolean
  blurPx: number
  accentRgb: string
}) {
  const tvMode = useTvMode()
  // TV 上封面墙漂移 = 全屏 backdrop-filter 每帧对移动封面重模糊（弱 GPU 帧率杀手）；
  // 非增强档停掉漂移、保留静态封面墙；桌面/增强档行为不变。
  const driftAnimated = animated && (!tvMode || isPerfModeEnhanced())
  const urls = useMemo(() => {
    const unique = Array.from(new Set(covers.filter(Boolean)))
    // 扩充到足够铺满背景的封面数
    const list: string[] = []
    let i = 0
    while (list.length < 28 && unique.length > 0) {
      list.push(unique[i % unique.length])
      i += 1
    }
    return list
  }, [covers])

  const blurValue = `blur(${blurPx}px)`
  const tiltValues = [-5, -3, 0, 3, 5, -2, 2, 4, -4, 1]

  if (urls.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* 封面墙主体：网格排列，动画时缓慢平移 */}
      <div
        className="absolute inset-[-20%]"
        style={{
          animation: driftAnimated ? 'coverWallDrift 90s linear infinite' : undefined,
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: 'minmax(0, 1fr)',
          gap: style === 'grid' ? 10 : 14,
          transform: style === 'tilted' ? 'rotate(2deg) scale(1.06)' : undefined,
        }}
      >
        {urls.map((url, index) => (
          <div
            key={`${url}-${index}`}
            className="overflow-hidden rounded-2xl"
            style={{
              transform: style === 'tilted' ? `rotate(${tiltValues[index % tiltValues.length]}deg)` : undefined,
              boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
              border: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" draggable={false} />
          </div>
        ))}
      </div>
      {/* 模糊遮罩：让前景清晰 */}
      <div
        className="absolute inset-0"
        style={{
          backdropFilter: blurValue,
          WebkitBackdropFilter: blurValue,
          background: `linear-gradient(160deg, rgba(${accentRgb},0.16) 0%, rgba(6,8,12,0.68) 45%, rgba(6,8,12,0.86) 100%)`,
        }}
      />
      {/* 轻微暗角提升前景对比 */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_35%,rgba(0,0,0,0.5)_100%)]" />
    </div>
  )
}
// 独立 memo 组件：Banner 每 5 秒自动轮播时只重渲染本组件，
// 不再带动整个探索页（含所有推荐列表）重渲染。
const ExploreBanner = memo(function ExploreBanner({
  banners,
  onBannerClick,
}: {
  banners: ExploreBannerItem[]
  onBannerClick: (banner: ExploreBannerItem) => void
}) {
  const [bannerIndex, setBannerIndex] = useState(0)

  useEffect(() => {
    if (banners.length <= 1) return
    const timer = setInterval(() => setBannerIndex(i => (i + 1) % banners.length), 5000)
    return () => clearInterval(timer)
  }, [banners.length])

  if (banners.length === 0) return null

  const current = banners[bannerIndex]
  return (
    <div className="relative mb-6 h-36 md:h-48 overflow-hidden rounded-[24px] border border-white/[0.08] bg-white/[0.045]">
      <AnimatePresence initial={false}>
        <motion.div
          key={bannerIndex}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.5 }}
          className="absolute inset-0 cursor-pointer"
          onClick={() => onBannerClick(current)}
        >
          <img src={current.imageUrl} alt={current.title} className="w-full h-full object-cover" />
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3">
            <p className="text-white/90 text-sm font-medium truncate">{current.title}</p>
          </div>
        </motion.div>
      </AnimatePresence>
      {banners.length > 1 && (
        <div className="absolute bottom-2 right-3 flex gap-1.5">
          {banners.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => { e.stopPropagation(); setBannerIndex(i) }}
              className={`h-1.5 rounded-full transition-all ${i === bannerIndex ? 'w-5 bg-white' : 'w-1.5 bg-white/40'}`}
              aria-label={`Banner ${i + 1}`}
            />
          ))}
        </div>
      )}
    </div>
  )
})

function SectionHeading({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: ReactNode
  title: string
  subtitle?: string
  action?: ReactNode
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2.5 text-white">
          <span className="text-white/70">{icon}</span>
          <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
        </div>
        {subtitle && <p className="mt-1.5 text-sm text-white/45">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

function MoreButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1.5 text-xs text-white/48 transition hover:bg-white/[0.09] hover:text-white"
      aria-label={`查看更多${label}`}
    >
      更多 <ChevronRight className="h-3.5 w-3.5" />
    </button>
  )
}

function ExploreSkeleton() {
  return (
    <div className="space-y-10 pb-36">
      <div className="grid min-h-[310px] gap-4 lg:grid-cols-[1.45fr_1fr]">
        <div className="animate-pulse rounded-[28px] bg-white/[0.07]" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="animate-pulse rounded-3xl bg-white/[0.06]" />
          ))}
        </div>
      </div>
      {Array.from({ length: 3 }).map((_, section) => (
        <div key={section}>
          <div className="mb-4 h-7 w-32 animate-pulse rounded-lg bg-white/[0.08]" />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="aspect-square animate-pulse rounded-3xl bg-white/[0.06]" />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

const getExploreDateKey = () => {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

const fingerprintExploreCredential = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const getExploreAccountKey = (platform: ExplorePlatform) => {
  // Apple 无 cookie/用户，按商店区分缓存
  if (platform === 'apple') return `apple:${localStorage.getItem('appleStorefront') || 'cn'}`
  const userIdKey = platform === 'qq' ? 'qq_user_id' : platform === 'netease' ? 'netease_user_id' : `${platform}_user_id`
  const userId = localStorage.getItem(userIdKey) || ''
  const cookie = getExploreCookie(platform)
  if (userId) return `user:${userId}`
  if (cookie) return `cookie:${fingerprintExploreCredential(cookie)}`
  return 'guest'
}

const readExploreCacheEntries = (): Partial<Record<ExplorePlatform, ExploreCacheEntry>> => {
  try {
    const cached = JSON.parse(localStorage.getItem(EXPLORE_CACHE_KEY) || '{}')
    return cached && typeof cached === 'object' ? cached : {}
  } catch {
    return {}
  }
}

const readExploreCache = (): Partial<Record<ExplorePlatform, ExplorePayload>> => {
  const entries = readExploreCacheEntries()
  const today = getExploreDateKey()
  const result: Partial<Record<ExplorePlatform, ExplorePayload>> = {}
  ;(['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda'] as ExplorePlatform[]).forEach(platform => {
    const entry = entries[platform]
    if (
      entry?.payload &&
      entry.dateKey === today &&
      entry.accountKey === getExploreAccountKey(platform)
    ) {
      result[platform] = entry.payload
    }
  })
  return result
}

const writeExploreCache = (platform: ExplorePlatform, payload: ExplorePayload) => {
  const next = {
    ...readExploreCacheEntries(),
    [platform]: {
      accountKey: getExploreAccountKey(platform),
      dateKey: getExploreDateKey(),
      payload
    }
  }
  localStorage.setItem(EXPLORE_CACHE_KEY, JSON.stringify(next))
}

// 迷你播放器包装：内部订阅播放时间（4Hz），ExploreView 本体不再因 currentTime prop 每秒重渲染
const LiveExploreMiniPlayer = memo(function LiveExploreMiniPlayer({
  playbackTimeStore,
  ...props
}: { playbackTimeStore: PlaybackTimeStore } & Omit<ComponentProps<typeof MiniPlayer>, 'currentTime'>) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime
  return <MiniPlayer {...props} currentTime={currentTime} />
})

function ExploreView({
  onSongSelect,
  restorePlaybackOrigin,
  currentSong = null,
  isPlaying,
  playbackTimeStore,
  duration,
  volume,
  currentLyric = '',
  accentColor = '#8b5cf6',
  playerTheme = 'dark',
  authRevision = 0,
  neteaseLoggedIn,
  neteaseUsername,
  neteaseAvatar,
  neteaseUserId,
  neteaseVip,
  qqLoggedIn,
  qqUsername,
  qqAvatar,
  qqUserId,
  qqVip,
  appleLoggedIn,
  appleUsername,
  appleAvatar,
  appleStorefront,
  spotifyLoggedIn,
  spotifyUsername,
  spotifyAvatar,
  kugouLoggedIn,
  kugouUsername,
  kugouAvatar,
  sodaLoggedIn,
  sodaUsername,
  sodaAvatar,
  onLoginClick,
  onProfileClick,
  onSearchClick,
  onRemoteClick,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onOpenPlayer,
  onOpenArtist,
  onOpenAlbum,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onCopyInfo,
}: ExploreViewProps) {
  const [platform, setPlatform] = useState<ExplorePlatform>(() => readSyncedPlatform(getVisiblePlatforms(), 'explorePlatform'))
  // 可见平台（设置中可隐藏不常用的平台 / 调整顺序）
  const [visiblePlatforms, setVisiblePlatforms] = useState<ExplorePlatform[]>(() => getVisiblePlatforms())
  useEffect(() => {
    const sync = () => setVisiblePlatforms(getVisiblePlatforms())
    window.addEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    window.addEventListener(PLATFORM_ORDER_EVENT, sync)
    return () => {
      window.removeEventListener(PLATFORM_VISIBILITY_EVENT, sync)
      window.removeEventListener(PLATFORM_ORDER_EVENT, sync)
    }
  }, [])
  useEffect(() => {
    const onPlatformChanged = (event: Event) => {
      const next = (event as CustomEvent<ExplorePlatform>).detail
      if (next && getVisiblePlatforms().includes(next)) setPlatform(next)
    }
    window.addEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
    return () => window.removeEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
  }, [])
  useEffect(() => {
    // 当前平台被隐藏时切换到第一个可见平台
    if (platform && !visiblePlatforms.includes(platform)) {
      const next = visiblePlatforms[0] || 'netease'
      setPlatform(next)
      syncPlatformAcrossViews(next)
    }
  }, [visiblePlatforms, platform])
  const [dataByPlatform, setDataByPlatform] = useState<Partial<Record<ExplorePlatform, ExplorePayload>>>(() => readExploreCache())
  const [loading, setLoading] = useState(() => {
    const cached = readExploreCache()
    return !cached[platform]
  })
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const authRevisionRef = useRef(authRevision)
  const playlistAuthRevisionRef = useRef(authRevision)
  const [detail, setDetail] = useState<ExploreDetail | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const detailRequestRef = useRef(0)
  const detailControllerRef = useRef<AbortController | null>(null)
  const detailCleanupTimerRef = useRef<number | null>(null)
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
  // Apple 探索国家/地区切换（缺省取账号 storefront）
  const [appleCountry, setAppleCountry] = useState(() => (
    localStorage.getItem('appleExploreCountry') || (appleStorefront && APPLE_EXPLORE_COUNTRIES.some(item => item.code === appleStorefront) ? appleStorefront : 'cn')
  ))
  const changeAppleCountry = (country: string) => {
    localStorage.setItem('appleExploreCountry', country)
    setAppleCountry(country)
    void loadExplore(undefined, true)
  }
  const [songContextMenu, setSongContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    song: Song | null
    songs: Song[]
    continuous: boolean
  }>({ show: false, x: 0, y: 0, song: null, songs: [], continuous: false })
  const [shuffleOffset, setShuffleOffset] = useState(0)
  // Apple Music 刷新信号（AM 无「换一批」，顶栏按钮改为刷新，信号传给 AppleExplorePanel 强制重载）
  const [appleRefreshSignal, setAppleRefreshSignal] = useState(0)
  const [showModePanel, setShowModePanel] = useState(false)
  const [showMVExplore, setShowMVExplore] = useState(false)
  const [fmLoading, setFmLoading] = useState(false)
  // 网易云首页 Banner 轮播
  const [banners, setBanners] = useState<ExploreBannerItem[]>([])

  useEffect(() => {
    if (platform !== 'netease' && platform !== 'qq') return
    let cancelled = false
    const load = platform === 'netease' ? getNeteaseBanner() : getQQBanner()
    void load.then((list) => {
      if (cancelled) return
      setBanners(Array.isArray(list) ? list.map((b: any) => ({
        imageUrl: b.imageUrl || '',
        url: b.url || '',
        title: b.title || b.typeTitle || '',
      })).filter(b => b.imageUrl) : [])
    })
    return () => { cancelled = true }
  }, [platform])

  // 处理 Banner 点击（解析网易云 url 打开歌单/歌曲）
  // useCallback 稳定引用：供 ExploreBanner memo 比较，避免父级每次重渲染传入新函数。
  const handleBannerClick = useCallback((banner: ExploreBannerItem) => {
    const url = banner.url || ''
    const playlistMatch = url.match(/playlist\?id=(\d+)/)
    const songMatch = url.match(/song\?id=(\d+)/)
    if (playlistMatch) {
      void fetchExplorePlaylist({ id: playlistMatch[1], platform: 'netease' } as ExplorePlaylist).then((detail) => {
        if (detail) {
          setDetail(detail)
          setDetailOpen(true)
          setDetailError('')
        }
      })
    } else if (songMatch) {
      void fetchExploreHome('netease').then(() => {
        window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '打开歌曲详情请使用搜索', type: 'info' } }))
      })
    }
  }, [])

  // 关闭探索歌单详情覆盖层（选歌播放/点关闭共用，保证不残留叠在播放页上）
  const closeExploreDetail = useCallback(() => {
    detailRequestRef.current += 1
    detailControllerRef.current?.abort()
    detailControllerRef.current = null
    setDetailOpen(false)
    setDetailError('')
    if (detailCleanupTimerRef.current !== null) window.clearTimeout(detailCleanupTimerRef.current)
    detailCleanupTimerRef.current = window.setTimeout(() => {
      setDetail(null)
      setDetailLoading(false)
      detailCleanupTimerRef.current = null
    }, 450)
  }, [])

  // 网易云私人 FM：个性化电台推荐播放
  const handlePlayFM = async () => {
    if (fmLoading) return
    const cookie = getExploreCookie('netease')
    if (!cookie) {
      onLoginClick?.('netease')
      return
    }
    setFmLoading(true)
    try {
      const res = await fetch(`http://localhost:3001/api/netease/personal_fm?cookie=${encodeURIComponent(cookie)}`)
      const data = await res.json()
      const raw = Array.isArray(data?.data) ? data.data : []
      const songs: Song[] = raw.map((s: any) => ({
        id: s.id,
        name: s.name || '',
        artists: Array.isArray(s.ar) ? s.ar.map((a: any) => ({ id: a.id, name: a.name })) : [],
        album: s.al ? { name: s.al.name, picUrl: s.al.picUrl || '' } : { name: '', picUrl: '' },
        duration: s.dt || 0,
        platform: 'netease'
      })).filter((s: Song) => s.id)
      if (songs.length > 0) onSongSelect(songs[0], songs, { surface: 'explore-fm' })
      else window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '私人 FM 暂无推荐，请稍后再试', type: 'error' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '私人 FM 获取失败', type: 'error' } }))
    } finally {
      setFmLoading(false)
    }
  }

  // 网易云日推/FM 歌曲"不感兴趣"（每日推荐 → dislike；私人FM 来源 → fm_trash 不再播放）
  const handleDislike = useCallback((song: Song) => {
    const cookie = getExploreCookie('netease')
    if (!cookie) {
      onLoginClick?.('netease')
      return
    }
    const showToast = (message: string, type: 'success' | 'error' | 'info' = 'success') => {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message, type } }))
    }
    const isFm = songContextMenu.continuous === true
    const task = isFm
      ? neteaseFmTrash(song.id, { cookie })
      : neteaseRecommendDislike(song.id, { cookie })
    void task.then((result) => {
      const ok = result?.code === 200 || result?.data?.code === 200
      showToast(
        ok ? '已标记为不感兴趣' : '操作失败，请稍后重试',
        ok ? 'success' : 'error',
      )
    })
  }, [songContextMenu.continuous, onLoginClick])

  useEffect(() => {
    if (restorePlaybackOrigin?.surface !== 'explore-detail' || !restorePlaybackOrigin.detail) return
    setDetail(restorePlaybackOrigin.detail as ExploreDetail)
    setDetailError('')
    setDetailLoading(false)
    setDetailOpen(true)
  }, [restorePlaybackOrigin?.revision])
  const [modeTriggerHovered, setModeTriggerHovered] = useState(false)
  // TV 遥控器模式无鼠标：顶部模式切换按钮视为恒 hover（常驻可聚焦）；
  // 手机遥控器连上（光标模式）时恢复真实 hover，与 HomeView/DesktopView 同策略
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const topBarActive = (tvMode && !remoteCursorMode) || modeTriggerHovered
  // 常驻小元素（模式下拉 chevron）的无限浮动：TV 非增强档静态化（JS 动画，tv.css 杀不掉）
  const tvChevronFloat = !tvMode || isPerfModeEnhanced()

  useEffect(() => {
    const closeForModeSwitch = () => {
      setModeTriggerHovered(false)
      setShowModePanel(false)
    }
    window.addEventListener('viewModeChanged', closeForModeSwitch)
    return () => window.removeEventListener('viewModeChanged', closeForModeSwitch)
  }, [])
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 全局设置镜像里打开的共享弹窗（音质 / 缓存清理 / 遥控器个性化）
  const [globalModal, setGlobalModal] = useState<MirrorActionId | null>(null)
  // 空闲时预热共享弹窗 chunk，消除首次点击的卡顿
  useEffect(() => preloadOnIdle([
    () => import('./AudioQualitySettingsModal'),
    () => import('./CacheClearModal'),
    () => import('./RemoteControlSettingsModal'),
  ]), [])
  const [moreSection, setMoreSection] = useState<ExploreSectionId | null>(null)
  const [preferences, setPreferences] = useState<ExplorePreferences>(() => {
    try {
      const saved = localStorage.getItem('explorePreferences')
      return normalizeExplorePreferences(saved ? JSON.parse(saved) : createDefaultExplorePreferences())
    } catch {
      return createDefaultExplorePreferences()
    }
  })

  useEffect(() => {
    const resetModeTrigger = () => setModeTriggerHovered(false)

    window.addEventListener('blur', resetModeTrigger)
    document.addEventListener('mouseleave', resetModeTrigger)

    return () => {
      window.removeEventListener('blur', resetModeTrigger)
      document.removeEventListener('mouseleave', resetModeTrigger)
    }
  }, [])

  const payload = dataByPlatform[platform]
  const loggedIn = platform === 'qq' ? qqLoggedIn
    : platform === 'apple' ? appleLoggedIn
    : platform === 'spotify' ? spotifyLoggedIn
    : platform === 'kugou' ? kugouLoggedIn
    : platform === 'soda' ? sodaLoggedIn
    : neteaseLoggedIn
  const username = platform === 'qq' ? qqUsername
    : platform === 'apple' ? appleUsername
    : platform === 'spotify' ? spotifyUsername
    : platform === 'kugou' ? kugouUsername
    : platform === 'soda' ? sodaUsername
    : neteaseUsername
  const avatar = platform === 'qq' ? qqAvatar
    : platform === 'apple' ? appleAvatar
    : platform === 'spotify' ? spotifyAvatar
    : platform === 'kugou' ? kugouAvatar
    : platform === 'soda' ? sodaAvatar
    : neteaseAvatar
  const vip = platform === 'qq' ? qqVip : platform === 'netease' ? neteaseVip : false
  const platformMeta = EXPLORE_PLATFORM_META[platform]
  const platformName = platformMeta.name
  const accent = platformMeta.accent
  const accentRgb = platformMeta.accentRgb
  const platformPreferences = preferences[platform]

  const themeStyle = {
    '--explore-accent': accent,
    '--explore-accent-rgb': accentRgb,
  } as CSSProperties

  const loadExplore = useCallback(async (signal?: AbortSignal, forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchExploreHome(platform, signal, { forceRefresh, enhanced: platformPreferences.enhancedApi, appleCountry: platform === 'apple' ? appleCountry : undefined })
      writeExploreCache(platform, result)
      setDataByPlatform(previous => ({ ...previous, [platform]: result }))
    } catch (requestError) {
      if ((requestError as Error).name !== 'AbortError') {
        setError(requestError instanceof Error ? requestError.message : '探索内容加载失败')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [platform, qqLoggedIn, neteaseLoggedIn, authRevision, platformPreferences.enhancedApi, appleCountry])

  useEffect(() => {
    syncPlatformAcrossViews(platform)
    const sessionKey = `${EXPLORE_SESSION_REFRESH_PREFIX}${platform}`
    const requiresPersonalizedPayload = platform === 'qq' && qqLoggedIn
    const inMemoryPayload = dataByPlatform[platform]
    const isUsablePayload = (candidate?: ExplorePayload) => !requiresPersonalizedPayload || Boolean(
      candidate?.personalized && candidate.radioSongs.length >= 30
    )
    // 当次应用会话已经刷新过才复用内存数据。冷启动时即使有当天缓存，
    // 也会把缓存作为首屏占位并在后台重新请求，避免完整退出后长期停留在旧内容。
    if (
      refreshKey === 0 &&
      sessionStorage.getItem(sessionKey) === '1' &&
      inMemoryPayload &&
      isUsablePayload(inMemoryPayload)
    ) {
      setLoading(false)
      setError('')
      return
    }
    const controller = new AbortController()
    sessionStorage.setItem(sessionKey, '1')
    const shouldForceRefresh = refreshKey > 0 || authRevision !== authRevisionRef.current
    authRevisionRef.current = authRevision
    void loadExplore(controller.signal, shouldForceRefresh)
    return () => controller.abort()
  }, [loadExplore, refreshKey, authRevision])

  useEffect(() => {
    localStorage.setItem('explorePreferences', JSON.stringify(preferences))
  }, [preferences])

  useEffect(() => {
    if (platform === 'apple') {
      if (!appleLoggedIn) {
        setUserPlaylists([])
        return
      }
      let active = true
      const shouldForceRefresh = authRevision !== playlistAuthRevisionRef.current
      playlistAuthRevisionRef.current = authRevision
      void getAppleLibraryPlaylists(100)
        .then(playlists => {
          if (active) setUserPlaylists(playlists)
        })
        .catch(() => {
          if (active) setUserPlaylists([])
        })
      return () => { active = false }
    }
    // Spotify：官方 API 我的歌单（token 驱动）；酷狗：隐藏窗口桥抓用户歌单
    if (platform === 'spotify' || platform === 'kugou') {
      const loggedIn = platform === 'spotify' ? spotifyLoggedIn : kugouLoggedIn
      if (!loggedIn) {
        setUserPlaylists([])
        return
      }
      let active = true
      const shouldForceRefresh = authRevision !== playlistAuthRevisionRef.current
      playlistAuthRevisionRef.current = authRevision
      void getUserPlaylists(platform, '', platform === 'spotify' ? spotifyUsername : kugouUsername, { forceRefresh: shouldForceRefresh })
        .then(playlists => {
          if (active) setUserPlaylists(playlists || [])
        })
        .catch(() => {
          if (active) setUserPlaylists([])
        })
      return () => { active = false }
    }
    // 汽水：侧栏直接拉取真实用户歌单（含"我喜欢"虚拟歌单；未登录自然返回空数组）
    if (platform === 'soda') {
      let active = true
      const shouldForceRefresh = authRevision !== playlistAuthRevisionRef.current
      playlistAuthRevisionRef.current = authRevision
      void getUserPlaylists('soda', '', sodaUsername, { forceRefresh: shouldForceRefresh })
        .then(playlists => {
          if (active) setUserPlaylists(playlists || [])
        })
        .catch(() => {
          if (active) setUserPlaylists([])
        })
      return () => { active = false }
    }
    const isLoggedIn = platform === 'qq' ? qqLoggedIn : neteaseLoggedIn
    const userId = platform === 'qq' ? qqUserId || '' : neteaseUserId || ''
    const accountName = platform === 'qq' ? qqUsername : neteaseUsername
    const shouldForceRefresh = authRevision !== playlistAuthRevisionRef.current
    playlistAuthRevisionRef.current = authRevision
    if (!isLoggedIn || !userId) {
      setUserPlaylists([])
      return
    }
    let active = true
    void getUserPlaylists(platform, userId, accountName, { forceRefresh: shouldForceRefresh })
      .then(playlists => {
        if (active) setUserPlaylists(playlists)
      })
      .catch(() => {
        if (active) setUserPlaylists([])
      })
    return () => {
      active = false
    }
  }, [platform, neteaseLoggedIn, neteaseUsername, neteaseUserId, qqLoggedIn, qqUsername, qqUserId, authRevision])

  const heroSongs = useMemo(() => {
    if (!payload) return []
    // QQ 首页的首要内容是登录态下的“猜你喜欢”（电台 99）；
    // 网易云仍以每日推荐为主，保持两个平台各自的产品语义。
    if (platform === 'qq' && payload.radioSongs.length > 0) return payload.radioSongs
    if (payload.dailySongs.length > 0) return payload.dailySongs
    if (payload.radioSongs.length > 0) return payload.radioSongs
    return payload.newSongs
  }, [payload, platform])

  const rotateItems = useCallback(<T,>(items: T[], offset: number) => {
    if (items.length < 2) return items
    const normalizedOffset = offset % items.length
    return [...items.slice(normalizedOffset), ...items.slice(0, normalizedOffset)]
  }, [])

  const rotatedHeroSongs = useMemo(() => rotateItems(heroSongs, shuffleOffset), [heroSongs, rotateItems, shuffleOffset])
  const highlightCandidates = useMemo(() => {
    const playlists = payload?.playlists || []
    const playlistsWithCovers = playlists.filter(playlist => Boolean(playlist.coverUrl))
    // 顶部是强视觉区：数据源偶发缺图时优先从同一批推荐中挑选有封面的卡片，
    // “更多”列表仍保留完整数据。
    return playlistsWithCovers.length >= 4 ? playlistsWithCovers : playlists
  }, [payload?.playlists])
  const rotatedPlaylists = useMemo(
    () => rotateItems(highlightCandidates, shuffleOffset * 4),
    [highlightCandidates, rotateItems, shuffleOffset]
  )
  const featuredSong = rotatedHeroSongs[0]
  const highlightPlaylists = rotatedPlaylists.slice(0, 4)
  const isQQGuessYouLike = platform === 'qq' && Boolean(payload?.radioSongs.length)
  const displayName = username || '音乐旅人'
  const playExploreCollection = useCallback((song: Song, songs: Song[], continuous = false) => {
    onSongSelect(song, songs, continuous ? {
      mode: 'explore',
      surface: 'mode-root',
      platform,
      songs,
      continuation: 'explore-infinite'
    } : undefined)
  }, [onSongSelect, platform])

  const openSongContextMenu = useCallback((
    event: React.MouseEvent,
    song: Song,
    songs: Song[],
    continuous = false,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    setSongContextMenu({ show: true, x: event.clientX, y: event.clientY, song, songs, continuous })
  }, [])

  const sectionOrder = useMemo(
    () => Object.fromEntries(platformPreferences.order.map((section, index) => [section, index])) as Record<ExploreSectionId, number>,
    [platformPreferences.order]
  )
  // 区块显隐：用户设置 + 平台能力表 + 数据可用性（空 payload 时区块自动隐藏）
  const sectionHasData = (section: ExploreSectionId) => {
    switch (section) {
      case 'discover':
        return payload ? payload.dailySongs.length + payload.radioSongs.length + payload.newSongs.length > 0 : false
      case 'playlists':
        return (payload?.playlists.length || 0) > 0
      case 'charts':
        return (payload?.charts.length || 0) > 0
      case 'newSongs':
        return (payload?.newSongs.length || 0) > 0
      case 'albums':
        return (payload?.albums.length || 0) > 0
      case 'channels':
        return (payload?.channels.length || 0) > 0
      default:
        return true
    }
  }
  const sectionVisible = (section: ExploreSectionId) => !platformPreferences.hidden.includes(section) && getPlatformCapabilities(platform).exploreSections.includes(section) && sectionHasData(section)
  const sectionStyle = (section: ExploreSectionId): CSSProperties => ({ order: sectionOrder[section] ?? 99 })
  const showSectionDescriptions = platformPreferences.showDescriptions
  const expandedHome = platformPreferences.contentAmount === 'expanded'
  const compactCards = platformPreferences.density === 'compact'
  // 卡片质感：solid/frosted/glass 预设 + custom 自定义不透明度（0-100% → 白底 alpha 0.02-0.32）
  const cardBgOf = (opacity: ExploreCardOpacity, custom: number): string => {
    const alphaMap: Record<string, number> = { solid: 0.02, frosted: 0.05, glass: 0.14 }
    const alpha =
      opacity === 'custom'
        ? Math.min(0.32, 0.02 + (custom / 100) * 0.3)
        : (alphaMap[opacity] ?? 0.05)
    return `rgba(255,255,255,${alpha})`
  }
  const exploreCardBg = cardBgOf(platformPreferences.cardOpacity, platformPreferences.cardOpacityCustom ?? 40)
  const showRankNumbers = platformPreferences.showRankNumbers

  const switchMode = (mode: ViewMode) => {
    localStorage.setItem('viewMode', mode)
    window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode }))
  }

  const handleShuffle = () => {
    setShuffleOffset(offset => offset + 1)
    // 先即时轮换当前内容，再向平台请求下一批真实推荐。
    setRefreshKey(key => key + 1)
  }

  const openDetail = useCallback(async (
    fallback: ExploreDetail['playlist'],
    loader: (signal: AbortSignal) => Promise<ExploreDetail>,
    autoplay = false,
  ) => {
    detailControllerRef.current?.abort()
    const controller = new AbortController()
    detailControllerRef.current = controller
    const requestId = ++detailRequestRef.current
    setDetail({ playlist: fallback, songs: [] })
    setDetailOpen(!autoplay)
    setDetailLoading(true)
    setDetailError('')
    try {
      const result = await loader(controller.signal)
      if (requestId !== detailRequestRef.current || controller.signal.aborted) return
      setDetail(result)
      if (result.songs.length === 0) {
        setDetailError(`${result.playlist.name} 暂时没有返回歌曲，请重试`)
      }
      if (autoplay && result.songs[0]) {
        onSongSelect(result.songs[0], result.songs)
      }
    } catch (requestError) {
      if (requestId !== detailRequestRef.current || controller.signal.aborted) return
      const message = requestError instanceof Error ? requestError.message : '内容加载失败'
      setDetailError(message)
      if (autoplay) setError(message)
    } finally {
      if (requestId === detailRequestRef.current) {
        detailControllerRef.current = null
        setDetailLoading(false)
      }
    }
  }, [onSongSelect])

  useEffect(() => () => {
    detailRequestRef.current += 1
    detailControllerRef.current?.abort()
    detailControllerRef.current = null
    if (detailCleanupTimerRef.current !== null) window.clearTimeout(detailCleanupTimerRef.current)
  }, [])

  const handlePlaylist = (playlist: ExplorePlaylist, autoplay = false) => openDetail({
    id: playlist.id,
    name: playlist.name,
    coverImgUrl: playlist.coverUrl,
    trackCount: playlist.trackCount || 0,
    description: playlist.description,
    platform: playlist.platform,
  }, signal => fetchExplorePlaylist(playlist, signal), autoplay)

  const handleChart = (chart: ExploreChart, autoplay = false) => openDetail({
    id: chart.id,
    name: chart.name,
    coverImgUrl: chart.coverUrl,
    trackCount: 0,
    description: chart.description,
    platform: chart.platform,
  }, signal => fetchExploreChart(chart, signal), autoplay)

  const handleChannel = (channel: ExploreChannel, autoplay = false) => {
    if (channel.platform === 'qq' && channel.id === '99' && !qqLoggedIn) {
      onLoginClick('qq')
      return Promise.resolve()
    }
    return openDetail({
      id: channel.id,
      name: channel.name,
      coverImgUrl: channel.coverUrl,
      trackCount: channel.song ? 1 : 0,
      description: channel.description,
      platform: channel.platform,
    }, signal => fetchExploreChannel(channel, signal), autoplay)
  }

  const discoverSongs = useMemo(() => {
    if (!payload) return []
    const seen = new Set<string>()
    return [...payload.dailySongs, ...payload.radioSongs, ...payload.newSongs].filter(song => {
      const key = `${song.platform}-${song.mid || song.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [payload])

  const closeMoreAnd = (action: () => void) => {
    setMoreSection(null)
    action()
  }

  const renderMoreContent = () => {
    if (!payload || !moreSection) return null

    if (moreSection === 'discover' || moreSection === 'newSongs') {
      const songs = moreSection === 'discover' ? discoverSongs : payload.newSongs
      return (
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {songs.map((song, index) => (
            <button
              key={`${song.platform}-${song.mid || song.id}-${index}`}
              type="button"
              onClick={() => closeMoreAnd(() => playExploreCollection(song, songs))}
              onContextMenu={event => openSongContextMenu(event, song, songs)}
              className="group flex min-w-0 items-center gap-3 rounded-2xl border border-white/[0.06] bg-white/[0.035] p-3 text-left transition hover:bg-white/[0.075]"
            >
              <span className="w-7 shrink-0 text-center text-xs text-white/25">{String(index + 1).padStart(2, '0')}</span>
              <Cover src={song.album.picUrl} alt={song.name} className="h-14 w-14 shrink-0 rounded-xl object-cover" iconClassName="h-4 w-4" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-white/84">{song.name}</span>
                <span className="mt-1 block truncate text-xs text-white/38">{song.artists.map(artist => artist.name).join(' / ')}</span>
              </span>
              <span className="flex h-9 w-9 items-center justify-center rounded-full text-white/70 transition group-hover:text-[#071018]" style={{ background: `${accent}22` }}>
                <Play className="h-3.5 w-3.5 fill-current" />
              </span>
            </button>
          ))}
        </div>
      )
    }

    if (moreSection === 'playlists') {
      return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {payload.playlists.map((playlist, index) => (
            <button
              key={`${playlist.platform}-${playlist.id}-${index}`}
              type="button"
              onClick={() => void handlePlaylist(playlist)}
              className="group min-w-0 text-left"
            >
              <span className="relative block aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] bg-white/[0.04]">
                <Cover src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                <span
                  role="button"
                  tabIndex={0}
                  onClick={event => {
                    event.stopPropagation()
                    void handlePlaylist(playlist, true)
                  }}
                  className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full text-[#071018] opacity-0 shadow-xl transition group-hover:opacity-100"
                  style={{ background: accent }}
                  aria-label={`直接播放${playlist.name}`}
                >
                  <Play className="h-4 w-4 fill-current" />
                </span>
              </span>
              <span className="mt-2.5 block line-clamp-2 text-sm font-medium leading-snug">{playlist.name}</span>
              <span className="mt-1 block truncate text-xs text-white/36">{formatCount(playlist.playCount) ? `${formatCount(playlist.playCount)} 次播放` : playlist.creator || '推荐歌单'}</span>
            </button>
          ))}
        </div>
      )
    }

    if (moreSection === 'charts') {
      return (
        <div className="grid gap-4 lg:grid-cols-2">
          {payload.charts.map((chart, index) => (
            <button
              key={`${chart.platform}-${chart.id}-${index}`}
              type="button"
              onClick={() => void handleChart(chart)}
              className="group flex min-h-40 gap-4 rounded-[22px] border border-white/[0.08] bg-white/[0.035] p-3 text-left transition hover:bg-white/[0.07]"
            >
              <span className="relative h-32 w-32 shrink-0 overflow-hidden rounded-2xl">
                <Cover src={chart.coverUrl} alt={chart.name} className="h-full w-full object-cover" />
                <span className="absolute bottom-2 left-2 rounded-full bg-black/50 px-2 py-1 text-[10px] text-white/65">{chart.group}</span>
              </span>
              <span className="min-w-0 flex-1 py-1">
                <span className="flex items-start justify-between gap-2">
                  <span>
                    <span className="block truncate font-semibold">{chart.name}</span>
                    <span className="mt-1 block text-[11px] text-white/35">{chart.updateText || '实时更新'}</span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={event => {
                      event.stopPropagation()
                      void handleChart(chart, true)
                    }}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/55 transition group-hover:bg-white group-hover:text-black"
                    aria-label={`直接播放${chart.name}`}
                  >
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </span>
                </span>
                <span className="mt-3 block space-y-2">
                  {chart.songs.slice(0, 3).map((song, songIndex) => (
                    <span key={`${song.name}-${songIndex}`} className="flex gap-2 text-xs">
                      <span style={{ color: songIndex === 0 ? accent : 'rgba(255,255,255,0.28)' }}>{songIndex + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-white/68">{song.name}</span>
                      <span className="max-w-28 truncate text-white/28">{song.artist}</span>
                    </span>
                  ))}
                </span>
              </span>
            </button>
          ))}
        </div>
      )
    }

    if (moreSection === 'albums') {
      return null
    }

    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
        {payload.channels.map((channel, index) => (
          <button
            key={`${channel.platform}-${channel.id}-${index}`}
            type="button"
            onClick={() => void handleChannel(channel)}
            className="group relative min-h-48 overflow-hidden rounded-[22px] border border-white/[0.08] bg-white/[0.04] text-left"
          >
            <Cover src={channel.coverUrl} alt={channel.name} className="absolute inset-0 h-full w-full object-cover opacity-62 transition duration-500 group-hover:scale-105" />
            <span className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,7,11,0.96),rgba(5,7,11,0.05))]" />
            <span className="relative flex h-full flex-col justify-end p-4">
              <span className="mb-auto flex items-start justify-between text-[10px] text-white/50">
                {channel.group}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={event => {
                    event.stopPropagation()
                    void handleChannel(channel, true)
                  }}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/75"
                  aria-label={`直接播放${channel.name}`}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                </span>
              </span>
              <span className="line-clamp-2 text-sm font-semibold">{channel.name}</span>
              <span className="mt-1 text-[10px] text-white/36">{formatCount(channel.playCount) ? `${formatCount(channel.playCount)} 人收听` : '打开查看全部节目'}</span>
            </span>
          </button>
        ))}
      </div>
    )
  }

  return (
    <div
      className="explore-view-root absolute inset-0 overflow-hidden bg-[#080b11] text-white"
      style={themeStyle}
    >
      <div
        className={`pointer-events-none absolute inset-0 ${platformPreferences.backgroundIntensity === 'vivid' ? 'opacity-90' : 'opacity-55'}`}
        style={{
          background: playerTheme === 'light'
            ? (platform === 'qq'
              ? 'radial-gradient(circle at 10% 0%, rgba(22, 117, 91, 0.14), transparent 38%), radial-gradient(circle at 92% 15%, rgba(36, 95, 181, 0.12), transparent 34%), linear-gradient(145deg, #f2f6f4 0%, #eef2f5 48%, #f2f1ec 100%)'
              : 'radial-gradient(circle at 10% 0%, rgba(164, 43, 72, 0.12), transparent 38%), radial-gradient(circle at 92% 15%, rgba(96, 50, 177, 0.12), transparent 34%), linear-gradient(145deg, #f7f1f2 0%, #f3f0f4 48%, #f2f1ec 100%)')
            : platform === 'qq'
              ? 'radial-gradient(circle at 10% 0%, rgba(22, 117, 91, 0.34), transparent 38%), radial-gradient(circle at 92% 15%, rgba(36, 95, 181, 0.3), transparent 34%), linear-gradient(145deg, #06131b 0%, #071019 48%, #090c12 100%)'
              : 'radial-gradient(circle at 10% 0%, rgba(164, 43, 72, 0.34), transparent 38%), radial-gradient(circle at 92% 15%, rgba(96, 50, 177, 0.3), transparent 34%), linear-gradient(145deg, #170c13 0%, #100c14 48%, #090b11 100%)',
        }}
      />
      {/* 封面墙背景（从每日推荐/猜你喜欢的歌曲封面生成） */}
      {platformPreferences.backgroundMode === 'coverWall' && heroSongs.length > 0 && (
        <CoverWallBackground
          covers={heroSongs.map(song => song.album?.picUrl || '')}
          style={platformPreferences.coverWallStyle}
          animated={platformPreferences.coverWallAnimated}
          blurPx={
            platformPreferences.coverWallBlur === 'custom'
              ? platformPreferences.coverWallBlurCustom
              : ({ soft: 18, medium: 32, strong: 56 } as const)[platformPreferences.coverWallBlur]
          }
          accentRgb={accentRgb}
        />
      )}
      <div className="pointer-events-none absolute -left-28 top-40 h-80 w-80 rounded-full bg-[rgba(var(--explore-accent-rgb),0.13)] blur-[100px]" />

      <div
        className="fixed left-1/2 top-0 z-[90] h-8 w-32 -translate-x-1/2"
        onMouseEnter={() => setModeTriggerHovered(true)}
        onMouseLeave={() => setModeTriggerHovered(false)}
      >
        <AnimatePresence>
          {topBarActive && !showModePanel && (
            <motion.button
              type="button"
              aria-label="打开模式选择"
              data-tv-focus
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              onClick={() => {
                setModeTriggerHovered(false)
                setShowModePanel(true)
              }}
              className="absolute left-1/2 top-0 flex h-8 w-[200px] -translate-x-1/2 items-center justify-center rounded-b-2xl border border-t-0 border-white/20 bg-white/10 text-white backdrop-blur-md transition hover:bg-white/20"
              whileTap={{ scale: 0.98 }}
            >
              <motion.svg
                animate={tvChevronFloat ? { y: [0, 2, 0] } : { y: 0 }}
                transition={tvChevronFloat ? { duration: 1, repeat: Infinity } : { duration: 0 }}
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
              </motion.svg>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {showModePanel && (
          <ModeSelectionPanel
            currentMode="explore"
            exploreAccentRgb={accentRgb}
            onClose={() => {
              setModeTriggerHovered(false)
              setShowModePanel(false)
            }}
            onSelect={(mode) => {
              setModeTriggerHovered(false)
              setShowModePanel(false)
              // 立即显示过渡动画（覆盖后续所有切换过程）；面板收起/内容复位后再真正切换，
              // 避免来源内容以展开态（下移 210px）残留成目标模式顶部的占位空区。
              window.dispatchEvent(new CustomEvent('viewModeTransitionStart', { detail: mode }))
              window.setTimeout(() => switchMode(mode), MODE_SELECTION_CLOSE_MS)
            }}
          />
        )}
      </AnimatePresence>

      <motion.div
        className="absolute inset-0"
        animate={{ y: showModePanel ? MODE_SELECTION_PANEL_HEIGHT : 0 }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        style={{ willChange: 'transform', backfaceVisibility: 'hidden', transform: 'translateZ(0)' }}
      >
      <div className="relative h-full overflow-y-auto overscroll-contain explore-scrollbar">
        <header className="sticky top-0 z-30 border-b border-white/[0.07] bg-[#090d14]/72 backdrop-blur-2xl">
          <div className="mx-auto flex max-w-[1680px] items-center gap-4 px-5 pb-2 pt-8 md:px-8 lg:px-10">
            <div className="flex min-w-0 items-center gap-3">
              <img
                src={appLogoUrl}
                alt="WaveForge"
                className="h-10 w-10 shrink-0 rounded-2xl object-cover shadow-lg"
                draggable={false}
              />
              <div className="hidden min-w-0 sm:block">
                <h1 className="truncate text-lg font-semibold tracking-tight">探索</h1>
                <p className="text-[11px] text-white/38">今日为您推荐</p>
              </div>
            </div>

            <div className="ml-1 flex items-center rounded-2xl border border-white/[0.08] bg-black/20 p-1">
              {visiblePlatforms.map(item => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setPlatform(item)}
                  className="relative rounded-xl px-3.5 py-2 text-sm font-medium transition md:px-5"
                  style={{ color: item === platform ? '#081017' : 'rgba(255,255,255,0.5)' }}
                >
                  {item === platform && (
                    <motion.span
                      className="absolute inset-0 rounded-xl"
                      style={{ background: accent }}
                      initial={false}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.16, ease: 'easeOut' }}
                    />
                  )}
                  <span className="relative">{EXPLORE_PLATFORM_META[item].short}</span>
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-2">
              {getPlatformCapabilities(platform).radio && (
                <button
                  type="button"
                  onClick={() => void handlePlayFM()}
                  className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
                  aria-label="私人FM"
                  title="私人FM"
                >
                  <Radio className={`h-[18px] w-[18px] ${fmLoading ? 'animate-pulse' : ''}`} />
                </button>
              )}
              {getPlatformCapabilities(platform).mv && (
              <button
                type="button"
                onClick={() => setShowMVExplore(true)}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
                aria-label="MV专区"
                title="MV专区"
              >
                <Film className="h-[18px] w-[18px]" />
              </button>
              )}
              <button
                type="button"
                onClick={onRemoteClick}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
                aria-label="遥控器"
                title="遥控器"
              >
                <MonitorSmartphone className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={onSearchClick}
                className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white"
                aria-label="搜索"
              >
                <Search className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="hidden h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/58 transition hover:bg-white/[0.1] hover:text-white sm:flex"
                aria-label="设置"
              >
                <Settings className="h-[18px] w-[18px]" />
              </button>
              {/* 插件系统入口 */}
              <PluginShortcuts variant="explore" />
              <button
                type="button"
                onClick={() => {
                  // Apple 登录/资料都进入 Apple 登录面板（内含账号信息与退出登录）
                  if (platform === 'apple') onLoginClick('apple')
                  else if (loggedIn) onProfileClick(platform)
                  else onLoginClick(platform)
                }}
                className="flex h-10 items-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.045] px-2 text-sm text-white/70 transition hover:bg-white/[0.1] hover:text-white"
              >
                {avatar ? (
                  <Cover src={avatar} alt={displayName} className="h-7 w-7 rounded-xl object-cover" iconClassName="h-3.5 w-3.5" />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-white/[0.08]">
                    {loggedIn ? <UserRound className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                  </span>
                )}
                <span className="hidden max-w-24 truncate xl:inline">{loggedIn ? displayName : '登录'}</span>
                {vip && <Crown className="hidden h-3.5 w-3.5 text-amber-300 xl:block" />}
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1680px] px-5 pb-8 pt-7 md:px-8 lg:px-10">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-white/36">
                <Waves className="h-3.5 w-3.5" />
                {platformName} · 今日声场
                {platform === 'qq' && payload?.officialEnhanced && (
                  <span className="rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2 py-0.5 tracking-normal text-emerald-200/80">
                    官方 API 已增强
                  </span>
                )}
              </div>
              <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{getGreeting()}，{displayName}</h2>
              <p className="mt-2 text-sm text-white/42">
                {payload?.personalized
                  ? '已结合你的口味、近期热度与平台新鲜内容生成。'
                  : '登录后可加入每日推荐、私人电台与专属歌单。'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!loggedIn && (
                <button
                  type="button"
                  onClick={() => onLoginClick(platform)}
                  className="rounded-full border border-white/[0.1] bg-white/[0.055] px-4 py-2 text-sm text-white/70 transition hover:bg-white/[0.1] hover:text-white"
                >
                  登录解锁个性化
                </button>
              )}
              {platform === 'apple' ? (
                /* Apple Music 无「换一批」（内容非分页随机），此位置改为刷新（重载当前页签） */
                <button
                  type="button"
                  onClick={() => setAppleRefreshSignal(v => v + 1)}
                  disabled={loading}
                  className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-4 text-sm text-white/60 transition hover:bg-white/[0.1] hover:text-white disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw key={appleRefreshSignal} className={`h-4 w-4 ${appleRefreshSignal > 0 ? 'animate-[spin_0.45s_ease-out_1]' : ''}`} />
                  刷新
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleShuffle}
                  disabled={loading}
                  className="flex h-10 items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-4 text-sm text-white/60 transition hover:bg-white/[0.1] hover:text-white disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw key={shuffleOffset} className="h-4 w-4 animate-[spin_0.45s_ease-out_1]" />
                  换一批
                </button>
              )}
            </div>
          </div>

          <AnimatePresence>
            {(error || detailError) && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                className="mb-5 flex items-center gap-3 rounded-2xl border border-rose-300/15 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-100/80"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error || detailError}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 首页 Banner 轮播（网易云 / QQ） */}
          <ExploreBanner banners={banners} onBannerClick={handleBannerClick} />

          {platform === 'apple' ? (
            <AppleExplorePanel
              appleLoggedIn={appleLoggedIn}
              appleUsername={appleUsername}
              appleAvatar={appleAvatar}
              defaultStorefront={appleStorefront}
              accentColor={accent}
              accentRgb={accentRgb}
              playerTheme={playerTheme}
              onSongSelect={onSongSelect}
              onLoginClick={() => onLoginClick('apple')}
              onOpenAlbum={onOpenAlbum}
              onOpenArtistPanel={onOpenArtist}
              onSongContextMenu={(event, song, songs) => openSongContextMenu(event, song, songs)}
              refreshSignal={appleRefreshSignal}
            />
          ) : (
          <>
          {loading && !payload ? (
            <ExploreSkeleton />
          ) : payload ? (
            <div className="space-y-12">
              <section className="grid min-h-[330px] gap-4 lg:grid-cols-[1.42fr_1fr]">
                <motion.div
                  whileHover={{ y: -2 }}
                  onContextMenu={event => featuredSong && openSongContextMenu(event, featuredSong, rotatedHeroSongs, true)}
                  className="group relative min-h-[330px] overflow-hidden rounded-[30px] border border-white/[0.09] bg-white/[0.055] shadow-2xl shadow-black/20"
                >
                  <Cover
                    src={featuredSong?.album.picUrl}
                    alt={featuredSong?.name || '今日推荐'}
                    className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.035]"
                    iconClassName="h-14 w-14"
                    eager
                  />
                  <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(5,8,13,0.95)_0%,rgba(5,8,13,0.76)_43%,rgba(5,8,13,0.18)_100%)]" />
                  <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,8,13,0.72),transparent_58%)]" />
                  <div className="relative flex h-full max-w-[660px] flex-col justify-end p-7 md:p-10">
                    <div className="mb-auto flex items-center gap-2 text-xs font-medium text-white/58">
                      <Sparkles className="h-4 w-4" style={{ color: accent }} />
                      {isQQGuessYouLike
                        ? 'QQ 音乐 · 猜你喜欢'
                        : payload.dailySongs.length > 0
                          ? '专属 Daily Mix'
                          : '今日推荐首发'}
                    </div>
                    <p className="mb-2 text-sm text-white/52">
                      {featuredSong ? featuredSong.artists.map(artist => artist.name).join(' / ') : platformName}
                    </p>
                    <h3 className="line-clamp-2 text-3xl font-semibold leading-tight tracking-tight md:text-5xl">
                      {featuredSong?.name || '让音乐带你去新的地方'}
                    </h3>
                    <p className="mt-3 line-clamp-2 max-w-lg text-sm leading-relaxed text-white/52 md:text-base">
                      {isQQGuessYouLike
                        ? '来自 QQ 音乐为你实时生成的猜你喜欢，越听越贴近你的口味。'
                        : '从你的偏好、今日趋势和新鲜发行中，挑出此刻最值得播放的一首。'}
                    </p>
                    <div className="mt-6 flex items-center gap-3">
                      <button
                        type="button"
                        disabled={!featuredSong}
                        onClick={() => featuredSong && playExploreCollection(featuredSong, rotatedHeroSongs, true)}
                        className="flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold text-[#061018] shadow-lg transition hover:brightness-110 disabled:opacity-40"
                        style={{ background: accent, boxShadow: `0 12px 36px rgba(${accentRgb}, 0.22)` }}
                      >
                        <Play className="h-4 w-4 fill-current" />
                        立即播放
                      </button>
                      <span className="rounded-full border border-white/[0.12] bg-black/25 px-4 py-2.5 text-xs text-white/55 backdrop-blur-md">
                        {heroSongs.length || 0} 首连续推荐
                      </span>
                    </div>
                  </div>
                </motion.div>

                <div className="grid grid-cols-2 gap-4">
                  {highlightPlaylists.map((playlist, index) => (
                    <motion.div
                      key={`${playlist.platform}-${playlist.id}-${index}`}
                      whileHover={{ y: -4 }}
                      onClick={() => void handlePlaylist(playlist)}
                      className="group relative min-h-[157px] cursor-pointer overflow-hidden rounded-[26px] border border-white/[0.08] bg-white/[0.05]"
                    >
                      <Cover
                        src={playlist.coverUrl}
                        alt={playlist.name}
                        className="absolute inset-0 h-full w-full object-cover transition duration-500 group-hover:scale-105"
                      />
                      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,7,11,0.92),rgba(5,7,11,0.08)_72%)]" />
                      <div className="relative flex h-full flex-col justify-end p-4">
                        <div className="mb-auto flex items-center justify-between">
                          <span className="rounded-full bg-black/35 px-2.5 py-1 text-[10px] font-medium text-white/66 backdrop-blur-md">
                            {playlist.source === 'qqmusic-skills' ? 'AI 歌单' : index === 0 ? '为你精选' : '灵感歌单'}
                          </span>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              void handlePlaylist(playlist, true)
                            }}
                            className="flex h-9 w-9 translate-y-1 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                            aria-label={`播放 ${playlist.name}`}
                          >
                            <Play className="h-4 w-4 fill-current" />
                          </button>
                        </div>
                        <h3 className="line-clamp-2 text-sm font-semibold leading-snug md:text-base">{playlist.name}</h3>
                        <p className="mt-1 text-[11px] text-white/48">
                          {formatCount(playlist.playCount) ? `${formatCount(playlist.playCount)} 次播放` : playlist.creator || 'WaveForge 推荐'}
                        </p>
                      </div>
                    </motion.div>
                  ))}
                  {highlightPlaylists.length === 0 && Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="rounded-[26px] border border-white/[0.08] bg-white/[0.04]" />
                  ))}
                </div>
              </section>

              <div className="flex flex-col gap-12">
              {sectionVisible('discover') && (
              <section style={sectionStyle('discover')}>
                <SectionHeading
                  icon={<Sparkles className="h-5 w-5" />}
                  title="为你发现"
                  subtitle={showSectionDescriptions ? (payload.personalized ? '口味推荐与平台趋势的交集' : '热门口碑与编辑推荐') : undefined}
                  action={<MoreButton label="为你发现" onClick={() => setMoreSection('discover')} />}
                />
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                  {[
                    {
                      // 汽水登录态下后端返回个性化日推（payload.personalized），
                      // 标题体现「汽水·每日推荐」；未登录为公开热歌回退，文案如实标注
                      label: payload.dailySongs.length
                        ? (platform === 'soda' && payload.personalized ? '汽水·每日推荐' : '每日推荐')
                        : '今日热选',
                      title: payload.dailySongs.length
                        ? (platform === 'soda' && !payload.personalized ? '汽水实时热门歌曲' : '只属于你的每日歌单')
                        : '今天大家都在听',
                      copy: payload.dailySongs.length
                        ? (platform === 'soda' && !payload.personalized ? '登录汽水音乐后升级为个性化日推' : '根据近期口味持续更新')
                        : '无需登录，也能发现好音乐',
                      icon: Sparkles,
                      cover: payload.dailySongs[1]?.album.picUrl || payload.newSongs[0]?.album.picUrl,
                      songs: payload.dailySongs.length ? payload.dailySongs : payload.newSongs,
                    },
                    {
                      label: platform === 'qq' ? '猜你喜欢' : platform === 'netease' ? '私人漫游' : '新鲜首发',
                      title: (platform === 'netease' || platform === 'qq') ? '一键进入无限电台' : '刚刚上线的新鲜声音',
                      copy: payload.radioSongs.length ? '越听越懂你的连续推荐' : '从相似口味自然延伸',
                      icon: Radio,
                      cover: payload.radioSongs[0]?.album.picUrl || payload.channels[0]?.coverUrl || payload.dailySongs[0]?.album.picUrl,
                      songs: payload.radioSongs.length ? payload.radioSongs : (platform === 'netease' || platform === 'qq' ? payload.radioSongs : payload.newSongs),
                      continuous: true,
                    },
                    {
                      label: '新鲜发行',
                      title: '刚刚抵达的声音',
                      copy: `${payload.newSongs.length} 首新歌等待第一次播放`,
                      icon: Disc3,
                      cover: payload.newSongs[2]?.album.picUrl,
                      songs: payload.newSongs,
                    },
                    {
                      label: '排行榜',
                      title: payload.charts[0]?.name || '此刻正在上升',
                      copy: payload.charts[0]?.songs.slice(0, 2).map(song => song.name).join(' · ') || '捕捉流行变化的现场',
                      icon: Trophy,
                      cover: payload.charts[0]?.coverUrl,
                      chart: payload.charts[0],
                    },
                  ].map((item, index) => {
                    const Icon = item.icon
                    return (
                      <motion.button
                        key={item.label}
                        type="button"
                        whileHover={{ y: -4 }}
                        onContextMenu={event => event.preventDefault()}
                        onClick={() => {
                          if (item.songs?.[0]) {
                            playExploreCollection(
                              item.songs[0],
                              item.songs,
                              'continuous' in item && item.continuous === true
                            )
                          }
                          else if (item.chart) void handleChart(item.chart)
                        }}
                        className="group relative min-h-52 overflow-hidden rounded-[26px] border border-white/[0.08] bg-white/[0.045] text-left"
                      >
                        <Cover src={item.cover} alt={item.title} className="absolute inset-0 h-full w-full object-cover opacity-65 transition duration-500 group-hover:scale-105" />
                        <div
                          className="absolute inset-0"
                          style={{
                            background: `linear-gradient(0deg, rgba(6,8,13,0.96) 0%, rgba(6,8,13,0.34) 70%), linear-gradient(135deg, rgba(${accentRgb}, ${0.08 + index * 0.025}), transparent)`,
                          }}
                        />
                        <div className="relative flex h-full flex-col p-5">
                          <div className="flex items-center justify-between text-xs text-white/58">
                            <span className="flex items-center gap-2">
                              <Icon className="h-4 w-4" style={{ color: accent }} />
                              {item.label}
                            </span>
                            <ChevronRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
                          </div>
                          <div className="mt-auto">
                            <h3 className="text-lg font-semibold leading-snug">{item.title}</h3>
                            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-white/48">{item.copy}</p>
                          </div>
                        </div>
                      </motion.button>
                    )
                  })}
                </div>
              </section>
              )}

              {sectionVisible('journey') && ((platform === 'qq' && qqLoggedIn) || (platform === 'netease' && neteaseLoggedIn && neteaseUserId)) && (
                <section style={sectionStyle('journey')}>
                  {platform === 'qq' ? (
                    <QQMusicJourney
                      configured={payload.officialEnhanced}
                      cookie={getExploreCookie('qq')}
                      accent={accent}
                      showDescription={showSectionDescriptions}
                      onConfiguredChange={() => setRefreshKey(key => key + 1)}
                      onOpenPlaylists={() => setMoreSection('playlists')}
                      onOpenCharts={() => setMoreSection('charts')}
                    />
                  ) : (
                    <NeteaseMusicJourney
                      uid={neteaseUserId || ''}
                      cookie={getExploreCookie('netease')}
                      accent={accent}
                      showDescription={showSectionDescriptions}
                      onPlaySongs={(song, songs) => playExploreCollection(song, songs)}
                      onSongContextMenu={(event, song, songs) => openSongContextMenu(event, song, songs)}
                    />
                  )}
                </section>
              )}

              {sectionVisible('playlists') && (
              <section style={sectionStyle('playlists')}>
                <SectionHeading
                  icon={<Headphones className="h-5 w-5" />}
                  title="推荐歌单"
                  subtitle={showSectionDescriptions ? '从情绪、场景、曲风与近期偏好展开' : undefined}
                  action={<MoreButton label="推荐歌单" onClick={() => setMoreSection('playlists')} />}
                />
                <div className={`grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 ${compactCards ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}>
                  {rotatedPlaylists.slice(0, expandedHome ? 18 : 12).map((playlist, index) => (
                    <motion.div
                      key={`${playlist.platform}-${playlist.id}-${index}`}
                      whileHover={{ y: -5 }}
                      className="group min-w-0 cursor-pointer"
                      onClick={() => void handlePlaylist(playlist)}
                    >
                      <div className="relative aspect-square overflow-hidden rounded-[22px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: exploreCardBg }}>
                        <Cover src={playlist.coverUrl} alt={playlist.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                        <div className="absolute inset-0 bg-black/0 transition group-hover:bg-black/20" />
                        {playlist.source === 'qqmusic-skills' && (
                          <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[10px] text-white/75 backdrop-blur-md">AI 推荐</span>
                        )}
                        {playlist.source === 'apple-personalized' && (
                          <span className="absolute left-3 top-3 rounded-full bg-black/45 px-2.5 py-1 text-[10px] text-white/75 backdrop-blur-md">为你推荐</span>
                        )}
                        {formatCount(playlist.playCount) && (
                          <span className="absolute right-3 top-3 flex items-center gap-1 rounded-full bg-black/45 px-2.5 py-1 text-[10px] text-white/75 backdrop-blur-md">
                            <Headphones className="h-3 w-3" /> {formatCount(playlist.playCount)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={event => {
                            event.stopPropagation()
                            void handlePlaylist(playlist, true)
                          }}
                          className="absolute bottom-3 right-3 flex h-11 w-11 translate-y-2 items-center justify-center rounded-full text-[#071018] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                          style={{ background: accent }}
                          aria-label={`播放 ${playlist.name}`}
                        >
                          <Play className="h-4 w-4 fill-current" />
                        </button>
                      </div>
                      <h3 className="mt-3 line-clamp-2 text-sm font-medium leading-snug text-white/86">{playlist.name}</h3>
                      <p className="mt-1 truncate text-xs text-white/38">
                        {playlist.description || playlist.creator || `${playlist.trackCount || '精选'} 首歌曲`}
                      </p>
                    </motion.div>
                  ))}
                </div>
              </section>
              )}

              {sectionVisible('charts') && (
              <section style={sectionStyle('charts')}>
                <SectionHeading
                  icon={<Trophy className="h-5 w-5" />}
                  title="排行榜速览"
                  subtitle={showSectionDescriptions ? '热门、飙升、新歌与地区趋势集中查看' : undefined}
                  action={<MoreButton label="排行榜" onClick={() => setMoreSection('charts')} />}
                />
                <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                  {payload.charts
                    .slice(0, expandedHome ? 12 : (typeof window !== 'undefined' && window.innerWidth >= 1536 ? 3 : 2) * 4)
                    .map((chart, chartIndex) => (
                    <motion.div
                      key={`${chart.platform}-${chart.id}-${chartIndex}`}
                      whileHover={{ y: -3 }}
                      onClick={() => void handleChart(chart)}
                      className="group flex min-h-44 cursor-pointer gap-4 overflow-hidden rounded-[24px] border border-white/[0.08] p-3 transition"
                      style={{ backgroundColor: exploreCardBg }}
                    >
                      <div className="relative aspect-square h-full min-h-36 w-36 shrink-0 overflow-hidden rounded-[18px]">
                        <Cover src={chart.coverUrl} alt={chart.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(4,6,9,0.65),transparent)]" />
                        <span className="absolute bottom-3 left-3 text-xs font-medium text-white/68">{chart.group}</span>
                      </div>
                      <div className="min-w-0 flex-1 py-1.5 pr-2">
                        <div className="mb-3 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h3 className="truncate text-base font-semibold">{chart.name}</h3>
                            <p className="mt-0.5 truncate text-[11px] text-white/36">
                              {chart.updateText || (formatCount(chart.playCount) ? `${formatCount(chart.playCount)} 人在听` : '实时更新')}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={event => {
                              event.stopPropagation()
                              void handleChart(chart, true)
                            }}
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-white/48 transition group-hover:bg-white group-hover:text-black"
                            aria-label={`直接播放${chart.name}`}
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                          </button>
                        </div>
                        <div className="space-y-2.5">
                          {chart.songs.slice(0, 3).map((song, index) => (
                            <div key={`${song.name}-${index}`} className="flex min-w-0 items-center gap-2 text-xs">
                              {showRankNumbers && (
                                <span
                                  className="w-4 shrink-0 font-semibold"
                                  style={{ color: index === 0 ? accent : 'rgba(255,255,255,0.3)' }}
                                >
                                  {song.rank || index + 1}
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate text-white/72">{song.name}</span>
                              <span className="max-w-24 truncate text-white/30">{song.artist}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </section>
              )}

              {sectionVisible('newSongs') && (
              <section style={sectionStyle('newSongs')}>
                <SectionHeading
                  icon={<Music2 className="h-5 w-5" />}
                  title="最新音乐"
                  subtitle={showSectionDescriptions ? '刚刚上线，也可能成为你的下一首循环' : undefined}
                  action={<MoreButton label="最新音乐" onClick={() => setMoreSection('newSongs')} />}
                />
                <div className={`grid gap-2 ${compactCards ? 'lg:grid-cols-3' : 'md:grid-cols-2'}`}>
                  {payload.newSongs.slice(0, expandedHome ? 18 : 12).map((song, index) => (
                    <motion.button
                      key={`${song.platform}-${song.mid || song.id}-${index}`}
                      type="button"
                      whileHover={{ x: 3 }}
                      onClick={() => onSongSelect(song, payload.newSongs)}
                      onContextMenu={event => openSongContextMenu(event, song, payload.newSongs)}
                      className="group flex min-w-0 items-center gap-3 rounded-2xl border border-transparent p-2 text-left transition hover:border-white/[0.07] hover:bg-white/[0.055]"
                    >
                      {showRankNumbers && (
                        <span className="w-5 shrink-0 text-center text-xs text-white/24">{String(index + 1).padStart(2, '0')}</span>
                      )}
                      <Cover src={song.album.picUrl} alt={song.name} className="h-12 w-12 shrink-0 rounded-xl object-cover" iconClassName="h-4 w-4" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-white/82">{song.name}</span>
                        <span className="mt-1 block truncate text-xs text-white/36">{song.artists.map(artist => artist.name).join(' / ')}</span>
                      </span>
                      {/* 皇冠代表当前账号缺少该 VIP 曲目的播放权限；会员账号不显示。 */}
                      {song.vip && !vip && <Crown className="h-3.5 w-3.5 shrink-0 text-amber-300/70" />}
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/44 opacity-0 transition group-hover:opacity-100">
                        <Play className="h-3.5 w-3.5 fill-current" />
                      </span>
                    </motion.button>
                  ))}
                </div>
              </section>
              )}

              {sectionVisible('albums') && (
              <section style={sectionStyle('albums')}>
                <SectionHeading
                  icon={<Disc3 className="h-5 w-5" />}
                  title="新碟上架"
                  subtitle={showSectionDescriptions ? '最新专辑与单曲，听见正在发生的音乐' : undefined}
                />
                <div className={`grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 md:grid-cols-4 ${compactCards ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}>
                  {payload.albums.slice(0, expandedHome ? 12 : 8).map((album, index) => (
                    <motion.div
                      key={`${album.platform}-${album.mid || album.id}-${index}`}
                      whileHover={{ y: -5 }}
                      className="group min-w-0 cursor-pointer"
                      onClick={() => onOpenAlbum?.(String(album.mid || album.id), album.platform)}
                    >
                      <div className="relative aspect-square overflow-hidden rounded-[22px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: exploreCardBg }}>
                        <Cover src={album.coverUrl} alt={album.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                      </div>
                      <h3 className="mt-3 line-clamp-1 text-sm font-medium leading-snug text-white/86">{album.name}</h3>
                      <p className="mt-1 line-clamp-1 text-xs text-white/40">{album.artist}</p>
                      <p className="mt-0.5 text-[10px] text-white/24">
                        {typeof album.publishTime === 'string' ? album.publishTime.slice(0, 10) : ''}
                      </p>
                    </motion.div>
                  ))}
                </div>
              </section>
              )}

              {sectionVisible('channels') && (
              <section style={sectionStyle('channels')}>
                <SectionHeading
                  icon={<Radio className="h-5 w-5" />}
                  title={platform === 'qq' ? '音乐频道' : '声音与播客'}
                  subtitle={showSectionDescriptions ? (platform === 'qq' ? '按场景、心情与曲风随心播放' : '音乐之外，也听见有趣的人和故事') : undefined}
                  action={<MoreButton label={platform === 'qq' ? '音乐频道' : '声音与播客'} onClick={() => setMoreSection('channels')} />}
                />
                <div className={`grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 ${compactCards ? 'xl:grid-cols-8' : 'xl:grid-cols-6'}`}>
                  {payload.channels.slice(0, expandedHome ? 18 : 12).map((channel, index) => (
                    <motion.button
                      key={`${channel.platform}-${channel.id}-${index}`}
                      type="button"
                      whileHover={{ y: -4 }}
                      onClick={() => void handleChannel(channel)}
                      className="group relative min-h-32 overflow-hidden rounded-[22px] border border-white/[0.08] bg-white/[0.045] text-left"
                    >
                      <Cover src={channel.coverUrl} alt={channel.name} className="absolute inset-0 h-full w-full object-cover opacity-55 transition duration-500 group-hover:scale-105 group-hover:opacity-68" />
                      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(5,7,11,0.94),rgba(5,7,11,0.08))]" />
                      <div className="relative flex h-full flex-col justify-end p-4">
                        <span className="mb-auto text-[10px] font-medium text-white/48">{channel.group}</span>
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={event => {
                            event.stopPropagation()
                            void handleChannel(channel, true)
                          }}
                          onKeyDown={event => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.stopPropagation()
                              void handleChannel(channel, true)
                            }
                          }}
                          className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white/75 opacity-0 backdrop-blur-md transition group-hover:opacity-100"
                          aria-label={`直接播放${channel.name}`}
                        >
                          <Play className="h-3.5 w-3.5 fill-current" />
                        </span>
                        <span className="line-clamp-2 text-sm font-semibold leading-snug">{channel.name}</span>
                        {formatCount(channel.playCount) && (
                          <span className="mt-1 text-[10px] text-white/38">{formatCount(channel.playCount)} 人收听</span>
                        )}
                      </div>
                    </motion.button>
                  ))}
                </div>
              </section>
              )}

              </div>

              <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-6 text-xs text-white/28">
                <span>数据来源：{payload.meta.source}</span>
                <span>内容仅用于个人音乐体验，请支持正版音乐。</span>
              </footer>
            </div>
          ) : (
            <div className="flex min-h-[48vh] flex-col items-center justify-center rounded-[30px] border border-white/[0.08] bg-white/[0.035] text-center">
              <AlertCircle className="mb-4 h-9 w-9 text-white/25" />
              <h3 className="text-lg font-semibold">暂时没有加载到探索内容</h3>
              <p className="mt-2 max-w-md text-sm text-white/40">请确认本地音乐服务已启动，或稍后再试。</p>
              <button
                type="button"
                onClick={() => setRefreshKey(key => key + 1)}
                className="mt-5 flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-[#071018]"
                style={{ background: accent }}
              >
                <RefreshCw className="h-4 w-4" />
                重新加载
              </button>
            </div>
          )}
          </>
          )}
        </main>
      </div>

      <AnimatePresence>
        {moreSection && payload && !detailOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[160] bg-[#080b11]/98 text-white backdrop-blur-2xl"
          >
            <div className="flex h-full flex-col pt-8">
              <div className="flex items-center gap-4 border-b border-white/[0.08] px-5 py-4 md:px-8 lg:px-10">
                <button
                  type="button"
                  onClick={() => setMoreSection(null)}
                  className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.045] text-white/60 transition hover:bg-white/[0.1] hover:text-white"
                  aria-label="返回探索首页"
                >
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div>
                  <h2 className="text-xl font-semibold">{moreSection === 'journey' ? `${platformName}旅程` : EXPLORE_SECTION_LABELS[moreSection]}</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setMoreSection(null)}
                  className="ml-auto flex h-10 w-10 items-center justify-center rounded-2xl bg-white/[0.05] text-white/55 transition hover:bg-white/[0.1] hover:text-white"
                  aria-label="关闭更多内容"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="explore-scrollbar flex-1 overflow-y-auto px-5 py-6 md:px-8 lg:px-10">
                <div className="mx-auto max-w-[1680px]">{renderMoreContent()}</div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ExploreSettingsPanel
        show={settingsOpen}
        platform={platform}
        preferences={preferences}
        accent={accent}
        playerTheme={playerTheme}
        onClose={() => setSettingsOpen(false)}
        onPlatformChange={setPlatform}
        onChange={setPreferences}
        onOpenGlobalModal={setGlobalModal}
      />

      {/* 全局设置镜像的共享弹窗（与简约 / 传统模式同一组件） */}
      <Suspense fallback={null}>
        {globalModal === 'audio-quality' && (
          <LazyAudioQualityModal show onClose={() => setGlobalModal(null)} playerTheme={playerTheme} neteaseVip={Boolean(neteaseVip)} qqVip={Boolean(qqVip)} neteaseLoggedIn={neteaseLoggedIn} qqLoggedIn={qqLoggedIn} />
        )}
        {globalModal === 'cache-clear' && (
          <LazyCacheClearModal show onClose={() => setGlobalModal(null)} playerTheme={playerTheme} />
        )}
        {globalModal === 'remote-settings' && (
          <LazyRemoteSettingsModal show onClose={() => setGlobalModal(null)} playerTheme={playerTheme} />
        )}
      </Suspense>

      {detailLoading && !detailOpen && (
        <div className="pointer-events-none fixed bottom-7 left-1/2 z-[200] flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.1] bg-black/65 px-4 py-2 text-xs text-white/68 shadow-xl backdrop-blur-xl">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在准备播放…
        </div>
      )}

      <PlaylistDetailPanel
        show={detailOpen}
        playerTheme={playerTheme}
        playlist={detail?.playlist || null}
        songs={detail?.songs || []}
        loading={detailLoading}
        onClose={closeExploreDetail}
        onSongSelect={(song, songs) => {
          // 选歌后关闭歌单详情覆盖层，否则播放页出现后歌单界面还叠在上面
          closeExploreDetail()
          onSongSelect(song, songs, {
            surface: 'explore-detail',
            detail: detail || undefined,
            songs,
          })
        }}
        neteaseVip={neteaseVip}
        qqVip={qqVip}
        currentPlatform={detail?.playlist.platform || platform}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists}
        currentSong={currentSong}
        accentColor={accent}
      />

      {songContextMenu.song && (
        <SongContextMenu
          show={songContextMenu.show}
          x={songContextMenu.x}
          y={songContextMenu.y}
          song={songContextMenu.song}
          playerTheme={playerTheme}
          onClose={() => setSongContextMenu(previous => ({ ...previous, show: false }))}
          onPlayNow={song => playExploreCollection(
            song,
            songContextMenu.songs.length > 0 ? songContextMenu.songs : [song],
            songContextMenu.continuous,
          )}
          onPlayNext={onPlayNext}
          onAddToFavorites={onAddToFavorites}
          onRemoveFromFavorites={onRemoveFromFavorites}
          onAddToPlaylist={onAddToPlaylist}
          onViewComments={onViewComments}
          onViewAlbum={song => {
            const menuPlatform = song.platform || platform
            // Apple 歌曲的 Song 不携带专辑 id（appleSongToSong 只带名字/封面）：
            // 先拉歌曲详情拿专辑 id 再打开（否则静默无动作）
            if (menuPlatform === 'apple') {
              const appleId = String(song.appleId || song.id || '')
              if (!appleId || appleId === '0') return
              void import('../services/appleWebService')
                .then(m => m.fetchAppleSongDetail(appleId))
                .then(detail => {
                  if (detail?.album?.id) onOpenAlbum?.(detail.album.id, 'apple')
                })
                .catch(() => undefined)
              return
            }
            const identifier = song.platform === 'qq'
              ? song.album?.mid || song.album?.pmid || song.album?.id
              : song.album?.id
            if (identifier) onOpenAlbum?.(String(identifier), menuPlatform)
          }}
          onViewArtist={song => {
            const menuPlatform = song.platform || platform
            if (menuPlatform === 'apple') {
              const appleId = String(song.appleId || song.id || '')
              if (!appleId || appleId === '0') return
              void import('../services/appleWebService')
                .then(m => m.fetchAppleSongDetail(appleId))
                .then(detail => {
                  const artistId = detail?.artists?.[0]?.playId || detail?.artists?.[0]?.id
                  if (artistId) onOpenArtist?.(artistId, 'apple')
                })
                .catch(() => undefined)
              return
            }
            const artist = song.artists[0]
            const identifier = song.platform === 'qq' ? artist?.mid || artist?.id : artist?.id
            if (identifier) onOpenArtist?.(String(identifier), menuPlatform)
          }}
          onCopyInfo={onCopyInfo}
          onDislike={handleDislike}
          userPlaylists={userPlaylists}
          platform={songContextMenu.song.platform || platform}
        />
      )}

      <AnimatePresence>
        {showMVExplore && (
          <MVExploreModal
            initialPlatform={(platform === 'apple' || platform === 'spotify' || platform === 'soda' || platform === 'kugou') ? 'netease' : platform}
            playerTheme={playerTheme}
            onClose={() => setShowMVExplore(false)}
          />
        )}
      </AnimatePresence>

      <LiveExploreMiniPlayer
        playbackTimeStore={playbackTimeStore}
        show={Boolean(currentSong) && !detailOpen}
        coverUrl={currentSong?.album.picUrl || ''}
        isPlaying={isPlaying}
        duration={duration}
        volume={volume}
        title={currentSong?.name || ''}
        artist={currentSong?.artists.map(artist => artist.name).join(', ') || ''}
        currentLyric={currentLyric}
        hasLyrics={Boolean(currentLyric)}
        accentColor={accentColor}
        onPlayPause={onPlayPause}
        onNext={onNext}
        onPrevious={onPrevious}
        onSeek={onSeek}
        onVolumeChange={onVolumeChange}
        onClick={onOpenPlayer}
      />
      </motion.div>
    </div>
  )
}
// 导出 memo 包装：播放中 App 约 1Hz 重渲染时，props 稳定则跳过整棵探索页子树重渲染
export default memo(ExploreView)
