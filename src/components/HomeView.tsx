import { memo, useState, useEffect, useRef } from 'react'
import { PLATFORM_CHANGED_EVENT, readSyncedPlatform, syncPlatformAcrossViews } from '../services/platformSync'
import { motion, AnimatePresence, animate, useMotionValue } from 'framer-motion'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'
import { isTvModeActive } from '../platform'
import { usePerfMode } from '../tv/perfMode'
import { Play, Music, TrendingUp, Flame, Clock, LogOut, Crown, User, Heart, MonitorSmartphone, Search, Settings, History, Speaker } from 'lucide-react'
import { Song, getProxiedImageUrl, resolveSongAlbumIdentifier, getSongUrl, isSameSong } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getVisiblePlatforms, PLATFORM_VISIBILITY_EVENT, PLATFORM_ORDER_EVENT } from '../services/platforms'
import PlaylistDetailPanel from './PlaylistDetailPanel'
import ModeSelectionPanel, { MODE_SELECTION_CLOSE_MS, MODE_SELECTION_PANEL_HEIGHT } from './ModeSelectionPanel'
import { getCachedUserPlaylists, getPlaylistDetail, getUserPlaylists, streamNeteasePlaylistTracks } from '../services/playlistService'
import { getAppleLibraryPlaylists, enrichApplePlaylistTrackCounts, getAppleRecentPlayed, getApplePlaylistTracks, getAppleCatalogPlaylistTracks, getAppleLibrarySongs, getApplePlaylistFirstTrackArtwork, appleSongToSong, appleLibraryTrackToSong, createApplePlaylist, deleteApplePlaylist, updateApplePlaylist, removeAppleTracksFromPlaylist, APPLE_LIBRARY_ID, isAppleLovedPlaylistName } from '../services/appleCatalog'
import CachedImage from './CachedImage'
import { imageCache } from '../utils/imageCache'
import { wallpaperManager, WallpaperFile } from '../services/wallpaperManager'
import SongContextMenu from './SongContextMenu'
import { Plus, RefreshCw } from 'lucide-react'
import { createPlaylist, deletePlaylist, updatePlaylist, updatePlaylistCover, subscribePlaylist, removeSongFromPlaylist } from '../services/playlistService'
import PlaylistContextMenu from './PlaylistContextMenu'
import CreatePlaylistModal from './CreatePlaylistModal'
import EditPlaylistModal from './EditPlaylistModal'
import DeletePlaylistModal from './DeletePlaylistModal'
import PluginShortcuts from './PluginShortcuts'
import type { PlaybackOrigin, SongSelectHandler } from '../types/playbackNavigation'
import { fetchExploreChart, fetchExploreHome, fetchExplorePlaylist } from '../services/exploreApi'
import {
  getDefaultHomeModules,
  HOME_MODULE_BY_ID,
  sanitizeHomeModules,
  type HomeModuleType,
} from '../services/homeModules'

interface HomeViewProps {
  onSongSelect: SongSelectHandler
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  neteaseLoggedIn: boolean
  neteaseUsername: string
  neteaseAvatar?: string
  neteaseUserId?: string
  neteaseVip?: boolean
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  qqAvatar?: string
  qqUserId?: string
  qqVip?: boolean
  onQQLogout: () => void
  appleLoggedIn?: boolean
  appleUsername?: string
  appleAvatar?: string
  appleStorefront?: string
  appleEmail?: string
  onAppleLoginClick?: () => void
  onAppleLogout?: () => void
  onAppleProfileClick?: () => void
  spotifyLoggedIn?: boolean
  spotifyUsername?: string
  spotifyAvatar?: string
  spotifyUserId?: string
  kugouLoggedIn?: boolean
  kugouUsername?: string
  kugouAvatar?: string
  kugouUserId?: string
  sodaLoggedIn?: boolean
  sodaUsername?: string
  sodaAvatar?: string
  sodaUserId?: string
  onSpotifyLogout?: () => void
  onKugouLogout?: () => void
  onSodaLogout?: () => void
  onNeteaseLoginClick: () => void
  onQQLoginClick: () => void
  /** 通用登录入口（新平台：Spotify/酷狗/汽水） */
  onLoginClick?: (platform: MusicPlatform) => void
  onProfileClick: (platform: MusicPlatform, initialTab?: 'created' | 'subscribed' | 'detail' | 'recent') => void
  onSearchClick: () => void
  onRemoteClick: () => void
  /** 播放设备控制（音频输出设备 / AirPlay 投送）弹窗 */
  onOpenDeviceControl: () => void
  onSettingsClick: () => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => boolean | Promise<boolean>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  accentColor?: string
  currentSong?: Song | null
  playerTheme?: 'light' | 'dark'
  authRevision?: number
}

type ChartType = 'new' | 'hot' | 'rising'

interface HomeModuleSessionSnapshot {
  songs: Song[]
  playlists: any[]
  updatedAt: number
  isStale?: boolean
}

// 内存缓存负责同一运行会话；持久缓存让冷启动先显示上一次成功内容，再后台刷新。
const homeModuleSessionCache = new Map<string, HomeModuleSessionSnapshot>()
const HOME_MODULE_SESSION_CACHE_LIMIT = 6
const HOME_MODULE_SESSION_CACHE_TTL = 5 * 60 * 1000
const HOME_MODULE_PERSISTED_CACHE_TTL = 24 * 60 * 60 * 1000
const HOME_MODULE_PERSISTED_CACHE_KEY = 'waveforge:home-module-cache:v1'

const readPersistedHomeModuleCache = (): Record<string, HomeModuleSessionSnapshot> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_MODULE_PERSISTED_CACHE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, HomeModuleSessionSnapshot>
  } catch {
    return {}
  }
}

// localStorage 持久化只写精简字段：仅保留渲染与点击所需的小字段（均为 Song 接口字段），
// 丢弃原始响应可能附带的歌词缓存/播放地址/privilege 等大字段，避免每次保存都同步序列化整份冗余数据。
const SLIM_SONG_FIELDS = ['id', 'mid', 'songType', 'name', 'artists', 'album', 'duration', 'platform', 'vip', 'noCopyright', 'commentCount', 'fee', 'fusedSources'] as const
const SLIM_PLAYLIST_FIELDS = ['id', 'name', 'coverImgUrl', 'trackCount', 'playCount', 'description', 'platform', 'source', 'creator', 'isLike', 'dirId', 'userId', 'isCollected'] as const

const slimHomeModuleSnapshot = (snapshot: { songs: Song[]; playlists: any[] }): { songs: Song[]; playlists: any[] } => {
  const slimSong = (song: Song): Song => {
    const result: Record<string, unknown> = {}
    for (const field of SLIM_SONG_FIELDS) {
      if (song[field as keyof Song] !== undefined) result[field] = song[field as keyof Song]
    }
    return result as unknown as Song
  }
  const slimPlaylist = (playlist: any) => {
    const result: Record<string, unknown> = {}
    for (const field of SLIM_PLAYLIST_FIELDS) {
      if (playlist?.[field] !== undefined) result[field] = playlist[field]
    }
    return result
  }
  return {
    songs: snapshot.songs.map(slimSong),
    playlists: snapshot.playlists.map(slimPlaylist),
  }
}

const saveHomeModuleSession = (key: string, snapshot: Omit<HomeModuleSessionSnapshot, 'updatedAt'>) => {
  const storedSnapshot = { songs: snapshot.songs, playlists: snapshot.playlists, updatedAt: Date.now() }
  // 内存缓存保留完整歌曲对象，供同会话快速恢复
  homeModuleSessionCache.delete(key)
  homeModuleSessionCache.set(key, storedSnapshot)
  while (homeModuleSessionCache.size > HOME_MODULE_SESSION_CACHE_LIMIT) {
    const oldestKey = homeModuleSessionCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    homeModuleSessionCache.delete(oldestKey)
  }

  try {
    const persisted = readPersistedHomeModuleCache()
    // 落盘时用精简快照，避免同步主线程的大 JSON 序列化
    persisted[key] = { ...storedSnapshot, ...slimHomeModuleSnapshot(storedSnapshot) }
    const entries = Object.entries(persisted)
      .filter(([, value]) => value && Array.isArray(value.songs) && Array.isArray(value.playlists))
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, HOME_MODULE_SESSION_CACHE_LIMIT)
    localStorage.setItem(HOME_MODULE_PERSISTED_CACHE_KEY, JSON.stringify(Object.fromEntries(entries)))
  } catch (error) {
    console.warn('[Home] 无法持久化首页推荐缓存:', error)
  }
}

const getHomeModuleSessionSnapshot = (key: string) => {
  const snapshot = homeModuleSessionCache.get(key)
  if (snapshot && Date.now() - snapshot.updatedAt <= HOME_MODULE_SESSION_CACHE_TTL) {
    return { ...snapshot, isStale: false }
  }
  if (snapshot) {
    homeModuleSessionCache.delete(key)
  }

  const persisted = readPersistedHomeModuleCache()[key]
  if (!persisted || !Array.isArray(persisted.songs) || !Array.isArray(persisted.playlists)) return undefined
  const age = Date.now() - Number(persisted.updatedAt || 0)
  if (age < 0 || age > HOME_MODULE_PERSISTED_CACHE_TTL) return undefined
  const restored = { ...persisted, isStale: age > HOME_MODULE_SESSION_CACHE_TTL }
  homeModuleSessionCache.set(key, restored)
  return restored
}

const requiresFullQQRecommendationBatch = (moduleId: HomeModuleType) => (
  moduleId === 'qq_guess_you_like' || moduleId === 'qq_daily_30'
)

/** 平台登录身份（模块会话缓存归属键的数据源） */
interface HomeModuleIdentity {
  loggedIn?: boolean
  userId?: string
}

/**
 * 首页模块会话缓存的归属键：按模块自身平台显式查表解析登录态与用户 ID。
 * 根因修复：此前除 netease 外的一切模块（含汽水/Spotify/酷狗/Apple）都窜到 QQ 分支，
 * 导致 QQ 登录/登出误使这些平台的缓存翻新、而其自身登录变化反而不影响 key。
 */
const getHomeModuleSessionKey = (
  moduleId: HomeModuleType,
  identities: Partial<Record<MusicPlatform, HomeModuleIdentity>>
) => {
  const modulePlatform = HOME_MODULE_BY_ID[moduleId]?.platform ?? 'netease'
  const identity = identities[modulePlatform]
  const loggedIn = Boolean(identity?.loggedIn)
  const userId = identity?.userId || ''
  // developerMode 只影响 QQ 官方增强接口的返回内容（dev 直连），仅需 QQ 键区分；
  // 其余平台接口不受该开关影响，避免无关翻新
  const devMode = modulePlatform === 'qq' && localStorage.getItem('developerMode') === 'true'

  // Never retain login cookies inside long-lived Map keys.
  return `${moduleId}:${loggedIn ? userId || 'signed-in' : 'guest'}:${devMode ? 'dev' : 'prod'}`
}

function HomeView({ 
  onSongSelect,
  restorePlaybackOrigin,
  neteaseLoggedIn,
  neteaseUsername,
  neteaseAvatar,
  neteaseUserId,
  neteaseVip,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  qqAvatar,
  qqUserId,
  qqVip,
  onQQLogout,
  appleLoggedIn = false,
  appleUsername = '',
  appleAvatar,
  appleStorefront = 'cn',
  appleEmail = '',
  onAppleLoginClick,
  onAppleLogout,
  onAppleProfileClick,
  spotifyLoggedIn = false,
  spotifyUsername = '',
  spotifyAvatar,
  spotifyUserId = '',
  kugouLoggedIn = false,
  kugouUsername = '',
  kugouAvatar,
  kugouUserId = '',
  sodaLoggedIn = false,
  sodaUsername = '',
  sodaAvatar,
  sodaUserId = '',
  onSpotifyLogout,
  onKugouLogout,
  onSodaLogout,
  onNeteaseLoginClick,
  onQQLoginClick,
  onLoginClick,
  onProfileClick,
  onSearchClick,
  onRemoteClick,
  onOpenDeviceControl,
  onSettingsClick,
  onOpenArtist,
  onOpenAlbum,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onCopyInfo,
  accentColor = '#3B82F6',
  currentSong = null,
  playerTheme = 'dark',
  authRevision = 0
}: HomeViewProps) {
  const [leftChartType, setLeftChartType] = useState<ChartType>('new')
  const [platform, setPlatform] = useState<MusicPlatform>(() => readSyncedPlatform(getVisiblePlatforms(), 'selectedPlatform'))
  // 平台变化（药丸点击/拖动/被隐藏回退）即持久化；其他挂载视图通过事件同步
  useEffect(() => {
    syncPlatformAcrossViews(platform)
  }, [platform])
  useEffect(() => {
    const onPlatformChanged = (event: Event) => {
      const next = (event as CustomEvent<MusicPlatform>).detail
      if (next && getVisiblePlatforms().includes(next)) setPlatform(next)
    }
    window.addEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
    return () => window.removeEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
  }, [])
  // 可见平台（设置中可隐藏不常用的平台 / 调整顺序）
  const [visiblePlatforms, setVisiblePlatforms] = useState<MusicPlatform[]>(() => getVisiblePlatforms())
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
    // 当前平台被隐藏时切换到第一个可见平台
    if (platform && !visiblePlatforms.includes(platform)) {
      const next = visiblePlatforms[0] || 'netease'
      setPlatform(next)
      syncPlatformAcrossViews(next)
    }
  }, [visiblePlatforms, platform])

  // 平台药丸：指针驱动（参考 PlaylistCarousel3D），当前平台始终居中；拖动实时跟随、松手平滑归中
  const PLATFORM_SLOT = 80
  const platformIdx = Math.max(0, visiblePlatforms.indexOf(platform))
  const platformStripX = useMotionValue((1 - platformIdx) * PLATFORM_SLOT)
  const platformDragRef = useRef<{ startX: number; startIdx: number; dragging: boolean; moved: boolean; pressedKey: MusicPlatform | null }>({ startX: 0, startIdx: platformIdx, dragging: false, moved: false, pressedKey: null })
  const platformStripRef = useRef<HTMLDivElement>(null)
  const platformIdxRef = useRef(platformIdx)
  platformIdxRef.current = platformIdx
  const platformDraggingRef = useRef(false)

  // 外部切换（点击药丸/设置里改平台）→ 平滑滚动到当前平台居中
  useEffect(() => {
    if (platformDraggingRef.current) return
    animate(platformStripX, (1 - platformIdx) * PLATFORM_SLOT, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
  }, [platform, visiblePlatforms, platformStripX, platformIdx])

  const platformPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const pill = (e.target as HTMLElement).closest('button')
    const pressedKey = pill?.getAttribute('data-platform') as MusicPlatform | null
    e.currentTarget.setPointerCapture(e.pointerId)
    platformStripX.stop()
    platformDragRef.current = { startX: e.clientX, startIdx: platformIdxRef.current, dragging: true, moved: false, pressedKey }
    platformDraggingRef.current = true
  }
  const platformPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = platformDragRef.current
    if (!st.dragging) return
    const rawDelta = e.clientX - st.startX
    if (Math.abs(rawDelta) > 8) st.moved = true
    // 连续浮点索引：起点索引固定为按下时的索引，floatIndex 完全由 rawDelta 决定，
    // 拖动实时跟随、取整即切换平台。切勿改写 st.startIdx——跨槽后 rawDelta 仍相对
    // 最初按下点，改写起点会导致索引每次跨槽额外偏移 +1（拖 1px 跳一槽，从第一个飞到最后一个）。
    const floatIndex = Math.max(0, Math.min(visiblePlatforms.length - 1, st.startIdx - rawDelta / PLATFORM_SLOT))
    const nextIdx = Math.round(floatIndex)
    if (nextIdx !== st.startIdx && visiblePlatforms[nextIdx]) setPlatform(visiblePlatforms[nextIdx])
    platformStripX.set((1 - floatIndex) * PLATFORM_SLOT)
  }
  const platformPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = platformDragRef.current
    if (!st.dragging) return
    const wasDrag = st.moved
    const pressedKey = st.pressedKey
    st.dragging = false
    platformDraggingRef.current = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    platformStripX.stop()
    animate(platformStripX, (1 - platformIdxRef.current) * PLATFORM_SLOT, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
    // 未拖动：解析按下的药丸直接切换（pointer capture 会拦截原生 click）
    if (!wasDrag && pressedKey && pressedKey !== platform) setPlatform(pressedKey)
  }

  const [hideHomeAccountId, setHideHomeAccountId] = useState(() => localStorage.getItem('hideHomeAccountId') === 'true')
  const [recentPlaybackSummary, setRecentPlaybackSummary] = useState<{ covers: string[]; count: number }>({ covers: [], count: 0 })
  const [chartSongs, setChartSongs] = useState<Song[]>([])
  const initialPlaylistUserId = platform === 'netease' ? neteaseUserId : platform === 'qq' ? qqUserId : ''
  const [userPlaylists, setUserPlaylists] = useState<any[]>(() => (
    initialPlaylistUserId
      ? getCachedUserPlaylists(platform, initialPlaylistUserId) || []
      : []
  ))
  const [loading, setLoading] = useState(true)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  // 平台切换器操作提示：15 秒后渐隐
  const [switcherHintVisible, setSwitcherHintVisible] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setSwitcherHintVisible(false), 15000)
    return () => clearTimeout(t)
  }, [])
  
  // Playlist management state
  const [showCreatePlaylist, setShowCreatePlaylist] = useState(false)
  const [showEditPlaylist, setShowEditPlaylist] = useState(false)
  const [showDeletePlaylist, setShowDeletePlaylist] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] = useState<any>(null)
  const [playlistContextMenu, setPlaylistContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    playlist: any
  }>({ show: false, x: 0, y: 0, playlist: null })
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [operationLoading, setOperationLoading] = useState(false)
  
  // Per-platform home module configuration
  const [neteaseModules, setNeteaseModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_netease')
    return saved ? sanitizeHomeModules(saved, 'netease') : getDefaultHomeModules('netease', neteaseLoggedIn)
  })
  
  const [qqModules, setQQModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_qq')
    return saved ? sanitizeHomeModules(saved, 'qq') : getDefaultHomeModules('qq', qqLoggedIn)
  })

  const [appleModules, setAppleModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_apple')
    return saved ? sanitizeHomeModules(saved, 'apple') : getDefaultHomeModules('apple', appleLoggedIn || false)
  })

  // Spotify / 酷狗 / 汽水：暂无平台专属模块，state 保持空数组（首页主卡区自动降级）
  const [spotifyModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_spotify')
    return saved ? sanitizeHomeModules(saved, 'spotify') : getDefaultHomeModules('spotify', false)
  })
  const [kugouModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_kugou')
    return saved ? sanitizeHomeModules(saved, 'kugou') : getDefaultHomeModules('kugou', false)
  })
  const [sodaModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_soda')
    return saved ? sanitizeHomeModules(saved, 'soda') : getDefaultHomeModules('soda', false)
  })
  const [currentSpotifyIndex] = useState(0)
  const [currentKugouIndex] = useState(0)
  // 单模块平台的占位 setter：Tab 映射统一引用，平台未来加模块时无需再改
  const setCurrentSpotifyIndex = (v: number) => { void v }
  const setCurrentKugouIndex = (v: number) => { void v }
  const [currentSodaIndex, setCurrentSodaIndex] = useState(() => {
    const saved = localStorage.getItem('homeModuleIndex_soda')
    const savedIndex = saved ? parseInt(saved, 10) : 0
    const modules = sanitizeHomeModules(localStorage.getItem('homeModules_soda'), 'soda')
    return savedIndex < modules.length ? savedIndex : 0
  })
  
  // 恢复上次选择的卡片索引（会话级别，重启后重置为0）
  const [currentNeteaseIndex, setCurrentNeteaseIndex] = useState(() => {
    const saved = localStorage.getItem('homeModuleIndex_netease')
    const savedIndex = saved ? parseInt(saved, 10) : 0
    // 确保索引不越界
    const modules = sanitizeHomeModules(localStorage.getItem('homeModules_netease'), 'netease')
    return savedIndex < modules.length ? savedIndex : 0
  })
  const [currentQQIndex, setCurrentQQIndex] = useState(() => {
    const saved = localStorage.getItem('homeModuleIndex_qq')
    const savedIndex = saved ? parseInt(saved, 10) : 0
    // 确保索引不越界
    const modules = sanitizeHomeModules(localStorage.getItem('homeModules_qq'), 'qq')
    return savedIndex < modules.length ? savedIndex : 0
  })
  const [currentAppleIndex, setCurrentAppleIndex] = useState(() => {
    const saved = localStorage.getItem('homeModuleIndex_apple')
    const savedIndex = saved ? parseInt(saved, 10) : 0
    // 确保索引不越界
    const modules = sanitizeHomeModules(localStorage.getItem('homeModules_apple'), 'apple')
    return savedIndex < modules.length ? savedIndex : 0
  })
  const initialModuleId = platform === 'netease'
    ? neteaseModules[currentNeteaseIndex]
    : platform === 'qq'
      ? qqModules[currentQQIndex]
      : platform === 'apple'
        ? appleModules[currentAppleIndex]
        : platform === 'spotify'
          ? spotifyModules[currentSpotifyIndex]
          : platform === 'kugou'
            ? kugouModules[currentKugouIndex]
            : sodaModules[currentSodaIndex]
  // 当前平台生效的首页模块（简约模式主卡循环）
  const activeModules = platform === 'netease' ? neteaseModules : platform === 'qq' ? qqModules : platform === 'apple' ? appleModules : platform === 'spotify' ? spotifyModules : platform === 'kugou' ? kugouModules : sodaModules
  // 各平台登录身份：模块会话缓存按 HOME_MODULE_BY_ID[moduleId].platform 取对应平台身份，
  // Apple 模块为 storefront 级内容（无账号维度），固定匿名归属
  const homeModuleIdentities: Partial<Record<MusicPlatform, HomeModuleIdentity>> = {
    netease: { loggedIn: neteaseLoggedIn, userId: neteaseUserId },
    qq: { loggedIn: qqLoggedIn, userId: qqUserId },
    apple: { loggedIn: false },
    spotify: { loggedIn: spotifyLoggedIn, userId: spotifyUserId },
    kugou: { loggedIn: kugouLoggedIn, userId: kugouUserId },
    soda: { loggedIn: sodaLoggedIn, userId: sodaUserId },
  }
  const initialModuleSnapshot = initialModuleId
    ? getHomeModuleSessionSnapshot(getHomeModuleSessionKey(initialModuleId, homeModuleIdentities))
    : undefined
  const [moduleSongs, setModuleSongs] = useState<Song[]>(() => initialModuleSnapshot?.songs || [])
  const [modulePlaylists, setModulePlaylists] = useState<any[]>(() => initialModuleSnapshot?.playlists || [])
  const [moduleLoading, setModuleLoading] = useState(() => Boolean(initialModuleId && !initialModuleSnapshot))
  const [moduleError, setModuleError] = useState('')
  const [moduleCoversReady, setModuleCoversReady] = useState(() => Boolean(initialModuleSnapshot))
  const [forceReload, setForceReload] = useState(0)
  const playlistAuthRevisionRef = useRef(authRevision)
  const moduleAuthRevisionRef = useRef(authRevision)
  
  // Playlist detail panel state
  const [showPlaylistDetail, setShowPlaylistDetail] = useState(false)
  // Apple 音乐库歌曲（喜爱歌曲，amp-api；供伪歌单打开/播放）
  const [appleLibrarySongs, setAppleLibrarySongs] = useState<Song[]>([])
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([])
  const [loadingPlaylistSongs, setLoadingPlaylistSongs] = useState(false)
  
  // 壁纸背景
  const [currentWallpaper, setCurrentWallpaper] = useState<WallpaperFile | null>(null)
  
  // 卡片模糊度
  const [cardBlurAmount, setCardBlurAmount] = useState(() => {
    const saved = localStorage.getItem('cardBlurAmount')
    return saved ? parseInt(saved) : 10
  })
  
  // 底部药丸悬停状态
  const [isBottomBarHovered, setIsBottomBarHovered] = useState(false)
  
  // 主题面板状态
  const [showThemePanel, setShowThemePanel] = useState(false)
  const [themePanelSettled, setThemePanelSettled] = useState(false)
  const [isTopHovered, setIsTopHovered] = useState(false)
  // TV 遥控器模式无鼠标：顶部/底部悬浮栏视为恒 hover，控件常驻可聚焦；
  // 手机遥控器连上（光标模式）时恢复真实 hover，与 PC 一致。
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  // TV 遥控器（无鼠标）：药丸变成单个可聚焦单元，左右键循环切换平台；PC/光标模式仍走拖拽
  const pillTvAdjust = tvMode && !remoteCursorMode
  const platformLabel = { netease: '网易云', qq: 'QQ音乐', apple: 'Apple', spotify: 'Spotify', kugou: '酷狗', soda: '汽水' } as Record<MusicPlatform, string>
  const cyclePlatform = (dir: 1 | -1) => {
    setPlatform(prev => {
      const idx = Math.max(0, visiblePlatforms.indexOf(prev))
      const next = (idx + dir + visiblePlatforms.length) % visiblePlatforms.length
      return visiblePlatforms[next] ?? prev
    })
  }
  const platformKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); cyclePlatform(-1) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); cyclePlatform(1) }
  }
  const perfMode = usePerfMode()
  // 常驻小元素（模式下拉 chevron/上箭头提示）的无限浮动：TV 非增强档静态化（JS 动画，tv.css 杀不掉）
  const tvChevronFloat = !isTvModeActive() || perfMode === 'enhanced'
  // 昂贵的动态背景（渐变 + 光晕）：性能模式仅约束 TV（效能/普通降为静态省 CPU/内存）；
  // PC 上始终全开（PC 的 perfMode 默认 normal，但不受 TV 性能档约束）。
  const showHeavyVisuals = !isTvModeActive() || perfMode === 'enhanced'
  const topBarActive = (tvMode && !remoteCursorMode) || isTopHovered
  const bottomBarActive = (tvMode && !remoteCursorMode) || isBottomBarHovered
  const [showUpArrowHint, setShowUpArrowHint] = useState(false)

  useEffect(() => {
    const closeForModeSwitch = () => {
      setThemePanelSettled(false)
      setShowThemePanel(false)
      setShowUpArrowHint(false)
    }
    window.addEventListener('viewModeChanged', closeForModeSwitch)
    return () => window.removeEventListener('viewModeChanged', closeForModeSwitch)
  }, [])
  
  // 个人中心面板状态
  
  // 歌单播放缓存 - 预加载详情与首曲 URL，减少点击延迟
  const playlistPlaybackCacheRef = useRef<Map<string, { songs: Song[]; timestamp: number }>>(new Map())
  const playlistPlaybackPendingRef = useRef<Map<string, Promise<Song[]>>>(new Map())
  const PLAYLIST_PLAYBACK_CACHE_TTL = 5 * 60 * 1000
  const PLAYLIST_PLAYBACK_CACHE_MAX_ENTRIES = 4
  const playlistHoverTimersRef = useRef<Map<string, number>>(new Map())

  const setPlaylistPlaybackCache = (cacheKey: string, songs: Song[]) => {
    const cache = playlistPlaybackCacheRef.current
    cache.set(cacheKey, { songs, timestamp: Date.now() })
    // 浏览大量歌单时缓存只增不减，会积压整份曲目列表。按最旧时间戳淘汰。
    while (cache.size > PLAYLIST_PLAYBACK_CACHE_MAX_ENTRIES) {
      let oldestKey: string | null = null
      let oldestTime = Number.POSITIVE_INFINITY
      for (const [key, value] of cache) {
        if (value.timestamp < oldestTime) {
          oldestTime = value.timestamp
          oldestKey = key
        }
      }
      if (oldestKey === null) break
      cache.delete(oldestKey)
    }
  }
  
  // AbortController instances used to clean up pending requests
  const activeRequestsRef = useRef<Set<AbortController>>(new Set())
  const refreshHomeModuleControllerRef = useRef<AbortController | null>(null)
  const playlistLoadIdRef = useRef(0)
  const playlistDetailControllerRef = useRef<AbortController | null>(null)
  const playlistDetailRequestIdRef = useRef(0)
  const playlistDetailCleanupTimerRef = useRef<number | null>(null)
  
  // 右键菜单状态
  const [contextMenuVisible, setContextMenuVisible] = useState(false)
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })
  const [contextMenuSong, setContextMenuSong] = useState<Song | null>(null)
  
  // 监听卡片模糊度变化
  useEffect(() => {
    const handlePrivacySettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<{ hideHomeAccountId?: boolean }>).detail
      setHideHomeAccountId(typeof detail?.hideHomeAccountId === 'boolean'
        ? detail.hideHomeAccountId
        : localStorage.getItem('hideHomeAccountId') === 'true')
    }
    window.addEventListener('privacy-settings-changed', handlePrivacySettingsChange)
    return () => window.removeEventListener('privacy-settings-changed', handlePrivacySettingsChange)
  }, [])

  useEffect(() => {
    const handleBlurAmountChange = (e: Event) => {
      const customEvent = e as CustomEvent
      const newAmount = customEvent.detail
      console.log('[HomeView] 收到卡片模糊度变化事件:', newAmount)
      if (typeof newAmount === 'number') {
        console.log('[HomeView] 更新模糊度到:', newAmount)
        setCardBlurAmount(newAmount)
      }
    }
    window.addEventListener('cardBlurAmountChanged', handleBlurAmountChange)
    return () => window.removeEventListener('cardBlurAmountChanged', handleBlurAmountChange)
  }, [])
  
  // Cancel all pending requests when the component unmounts
  useEffect(() => {
    return () => {
      // Cancel every active request
      activeRequestsRef.current.forEach(controller => {
        try {
          controller.abort()
        } catch (e) {
          // 忽略已取消的错误
        }
      })
      activeRequestsRef.current.clear()
      playlistDetailControllerRef.current = null
      if (playlistDetailCleanupTimerRef.current !== null) {
        window.clearTimeout(playlistDetailCleanupTimerRef.current)
        playlistDetailCleanupTimerRef.current = null
      }
    }
  }, [])

  // 保存用户选择的卡片索引到 localStorage
  useEffect(() => {
    localStorage.setItem('homeModuleIndex_netease', currentNeteaseIndex.toString())
  }, [currentNeteaseIndex])

  useEffect(() => {
    localStorage.setItem('homeModuleIndex_qq', currentQQIndex.toString())
  }, [currentQQIndex])

  useEffect(() => {
    localStorage.setItem('homeModuleIndex_soda', currentSodaIndex.toString())
  }, [currentSodaIndex])

  useEffect(() => {
    if (moduleLoading) {
      setModuleCoversReady(false)
      return
    }

    // Only warm the first visible covers. Remaining cards use viewport lazy loading.
    const coverUrls = [...new Set([
      ...moduleSongs.slice(0, 4).map(song => song.album?.picUrl),
      ...modulePlaylists.slice(0, 4).map(playlist => playlist.coverImgUrl),
    ].filter((url): url is string => Boolean(url)))]

    if (coverUrls.length === 0) {
      setModuleCoversReady(true)
      return
    }

    let cancelled = false
    let completed = 0
    const preloadImages = new Set<HTMLImageElement>()

    const markDone = () => {
      completed += 1
      if (!cancelled && completed >= coverUrls.length) {
        setModuleCoversReady(true)
      }
    }

    setModuleCoversReady(false)

    coverUrls.forEach((url) => {
      const proxyUrl = getProxiedImageUrl(url)
      if (!proxyUrl || imageCache.get(proxyUrl)) {
        markDone()
        return
      }

      const img = new Image()
      preloadImages.add(img)
      const finish = (loaded: boolean) => {
        if (loaded) imageCache.set(proxyUrl, proxyUrl)
        img.onload = null
        img.onerror = null
        preloadImages.delete(img)
        markDone()
      }
      img.onload = () => finish(true)
      img.onerror = () => finish(false)
      img.decoding = 'async'
      img.src = proxyUrl
    })

    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        setModuleCoversReady(true)
      }
    }, 5000)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      preloadImages.forEach(img => {
        img.onload = null
        img.onerror = null
        img.src = ''
      })
      preloadImages.clear()
    }
  }, [moduleLoading, moduleSongs, modulePlaylists])

  const getPlaylistPlaybackCacheKey = (playlist: any) => {
    const playlistPlatform = (playlist.platform || platform) as MusicPlatform
    const accountId = playlistPlatform === 'qq' ? (qqUserId || 'guest') : playlistPlatform === 'apple' ? 'apple-user' : (neteaseUserId || 'guest')
    return `${playlistPlatform}:${accountId}:${authRevision}:${playlist.id}`
  }

  const mapPlaylistTracksToSongs = (tracks: any[], playlistPlatform: 'netease' | 'qq'): Song[] => {
    if (!Array.isArray(tracks)) return []

    if (playlistPlatform === 'netease') {
      return tracks.map((track: any) => ({
        id: track.id,
        name: track.name,
        artists: track.ar || track.artists || [],
        album: track.al || track.album || {},
        duration: track.dt || track.duration || 0,
        platform: 'netease',
        vip: track.vip || false,
        fee: track.fee || 0
      }))
    }

    return tracks.map((track: any) => ({
      id: track.songid || track.id,
      mid: track.songmid || track.mid,
      name: track.songname || track.name,
      artists: track.singer || [],
      album: {
        name: track.albumname || track.album?.name || '',
        picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
      },
      duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
      platform: 'qq',
      vip: track.pay?.payplay === 1 || false
    }))
  }

  const resolvePlaylistSongsForPlayback = async (playlist: any): Promise<Song[]> => {
    const playlistPlatform = playlist.platform || platform
    const cacheKey = getPlaylistPlaybackCacheKey(playlist)
    const cached = playlistPlaybackCacheRef.current.get(cacheKey)
    const now = Date.now()
    if (cached && (now - cached.timestamp) < PLAYLIST_PLAYBACK_CACHE_TTL) {
      return cached.songs
    }

    const pending = playlistPlaybackPendingRef.current.get(cacheKey)
    if (pending) {
      return pending
    }

    const request = (async () => {
      let data: any

      // Apple：音乐库伪歌单直接用已加载的喜爱歌曲；目录歌单（pl. 前缀）走 catalog，资料库歌单走 me/library
      if (playlistPlatform === 'apple') {
        if (String(playlist.id || '') === APPLE_LIBRARY_ID) {
          const songs = appleLibrarySongs.length > 0 ? appleLibrarySongs : []
          if (songs.length > 0) {
            setPlaylistPlaybackCache(cacheKey, songs)
          }
          return songs
        }
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const playlistId = String(playlist.id || '')
        const tracks = playlistId.startsWith('pl.')
          ? await getAppleCatalogPlaylistTracks(playlistId, storefront)
          : await getApplePlaylistTracks(playlistId)
        const songs = tracks.map(track => appleSongToSong(track, storefront))
        if (songs.length > 0) {
          setPlaylistPlaybackCache(cacheKey, songs)
        }
        return songs
      }

      if (playlistPlatform === 'netease') {
        const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        const response = await fetch(`http://localhost:3001/api/netease/playlist/detail?id=${encodeURIComponent(playlist.id)}&cookie=${encodeURIComponent(neteaseCookie)}`)
        data = await response.json()
        if (!response.ok || data.error) throw new Error(data.error || '读取网易云歌单失败')
        const songs = mapPlaylistTracksToSongs(data.playlist?.tracks || [], 'netease')
        if (songs.length > 0) {
          setPlaylistPlaybackCache(cacheKey, songs)
        }
        const firstSong = songs[0]
        if (firstSong) {
          void getSongUrl(firstSong.platform === 'qq' ? (firstSong.mid || firstSong.id) : firstSong.id, firstSong.platform || 'netease').catch(() => null)
        }
        return songs
      }

      // 汽水：统一详情（分页全量），此前会误入 QQ 分支导致悬停播放/预取失败
      if (playlistPlatform === 'soda') {
        const sodaData = await getPlaylistDetail(String(playlist.id || ''), 'soda')
        const songs = Array.isArray(sodaData?.tracks) ? sodaData.tracks : []
        if (songs.length > 0) {
          setPlaylistPlaybackCache(cacheKey, songs)
        }
        const firstSong = songs[0]
        if (firstSong) {
          void getSongUrl(firstSong.mid || firstSong.id, 'soda').catch(() => null)
        }
        return songs
      }

      const cookie = localStorage.getItem('qq_cookie') || ''
      const response = await fetch(`http://localhost:3001/api/qq/playlist/detail?id=${playlist.id}&cookie=${encodeURIComponent(cookie)}`)
      data = await response.json()
      if (!response.ok || data.error) throw new Error(data.error || '读取QQ歌单失败')
      const songs = mapPlaylistTracksToSongs(data.songlist || data.data?.songlist || [], 'qq')
      if (songs.length > 0) {
        setPlaylistPlaybackCache(cacheKey, songs)
      }
      const firstSong = songs[0]
      if (firstSong) {
        void getSongUrl(firstSong.platform === 'qq' ? (firstSong.mid || firstSong.id) : firstSong.id, firstSong.platform || 'qq').catch(() => null)
      }
      return songs
    })()

    playlistPlaybackPendingRef.current.set(cacheKey, request)
    try {
      return await request
    } finally {
      if (playlistPlaybackPendingRef.current.get(cacheKey) === request) {
        playlistPlaybackPendingRef.current.delete(cacheKey)
      }
    }
  }

  const prefetchPlaylistPlayback = (playlist: any) => {
    if ((playlist.platform || platform) === 'netease' && Number(playlist.trackCount || 0) > 200) return
    void resolvePlaylistSongsForPlayback(playlist).catch((error) => {
      console.debug('[playlist playback prefetch] failed:', error)
    })
  }

  const schedulePlaylistHoverPrefetch = (playlist: any) => {
    const key = getPlaylistPlaybackCacheKey(playlist)
    if (playlistHoverTimersRef.current.has(key)) return
    const timer = window.setTimeout(() => {
      playlistHoverTimersRef.current.delete(key)
      prefetchPlaylistPlayback(playlist)
    }, 650)
    playlistHoverTimersRef.current.set(key, timer)
  }

  const cancelPlaylistHoverPrefetch = (playlist: any) => {
    const key = getPlaylistPlaybackCacheKey(playlist)
    const timer = playlistHoverTimersRef.current.get(key)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      playlistHoverTimersRef.current.delete(key)
    }
  }

  useEffect(() => () => {
    playlistHoverTimersRef.current.forEach(timer => window.clearTimeout(timer))
    playlistHoverTimersRef.current.clear()
  }, [])

  const cancelPlaylistDetailRequest = () => {
    playlistDetailRequestIdRef.current += 1
    const controller = playlistDetailControllerRef.current
    if (controller) {
      controller.abort()
      activeRequestsRef.current.delete(controller)
      playlistDetailControllerRef.current = null
    }
  }

  const closePlaylistDetail = () => {
    cancelPlaylistDetailRequest()
    setLoadingPlaylistSongs(false)
    setShowPlaylistDetail(false)

    if (playlistDetailCleanupTimerRef.current !== null) {
      window.clearTimeout(playlistDetailCleanupTimerRef.current)
    }
    // 延迟清理歌曲列表，避免关闭歌单详情时内容瞬间闪烁。
    playlistDetailCleanupTimerRef.current = window.setTimeout(() => {
      playlistDetailCleanupTimerRef.current = null
      setPlaylistSongs([])
    }, 450)
  }

  // Load playlist details
  const handlePlaylistClick = async (playlist: any) => {
    if (playlistDetailCleanupTimerRef.current !== null) {
      window.clearTimeout(playlistDetailCleanupTimerRef.current)
      playlistDetailCleanupTimerRef.current = null
    }
    cancelPlaylistDetailRequest()

    const requestId = playlistDetailRequestIdRef.current
    const abortController = new AbortController()
    playlistDetailControllerRef.current = abortController
    activeRequestsRef.current.add(abortController)

    setSelectedPlaylist(playlist)
    setShowPlaylistDetail(true)
    setLoadingPlaylistSongs(true)
    setPlaylistSongs([])

    const waitForRetry = (delay: number) => new Promise<void>((resolve, reject) => {
      if (abortController.signal.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
        return
      }
      const timer = window.setTimeout(() => {
        abortController.signal.removeEventListener('abort', handleAbort)
        resolve()
      }, delay)
      const handleAbort = () => {
        window.clearTimeout(timer)
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      }
      abortController.signal.addEventListener('abort', handleAbort, { once: true })
    })

    // 请求失败时进行有限次数重试。
    const fetchWithRetry = async (url: string, maxRetries = 3): Promise<any> => {
      let lastError: unknown = null

      for (let i = 0; i < maxRetries; i++) {
        try {
          console.log(`[API request] attempt ${i + 1}/${maxRetries}`)
          const response = await fetch(url, {
            signal: abortController.signal,
            cache: 'no-store',
          })

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`)
          }

          const data = await response.json()
          if (data.error) {
            throw new Error(data.error)
          }
          return data
        } catch (error) {
          if ((error as Error).name === 'AbortError') {
            throw error
          }

          lastError = error
          console.warn(`[API request] attempt ${i + 1} failed:`, error)
          if (i < maxRetries - 1) {
            await waitForRetry(500 * (i + 1))
          }
        }
      }

      throw lastError
    }

    const isCurrentRequest = () => (
      playlistDetailRequestIdRef.current === requestId &&
      playlistDetailControllerRef.current === abortController &&
      !abortController.signal.aborted
    )

    try {
      const playlistPlatform = playlist.platform || platform

      // Apple：音乐库伪歌单直接用已加载的喜爱歌曲；目录歌单（pl. 前缀）走 catalog，资料库歌单走 me/library
      if (playlistPlatform === 'apple') {
        if (String(playlist.id || '') === APPLE_LIBRARY_ID) {
          if (isCurrentRequest()) {
            setSelectedPlaylist({ ...playlist, platform: 'apple' })
            setPlaylistSongs(appleLibrarySongs)
          }
          return
        }
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const playlistId = String(playlist.id || '')
        const tracks = playlistId.startsWith('pl.')
          ? await getAppleCatalogPlaylistTracks(playlistId, storefront)
          : await getApplePlaylistTracks(playlistId)
        if (!isCurrentRequest()) return
        const songs = tracks.map(track => appleSongToSong(track, storefront))
        setSelectedPlaylist({ ...playlist, platform: 'apple', trackCount: songs.length })
        setPlaylistSongs(songs)
        return
      }

      // 汽水：经 playlistService 统一详情（分页合并全量曲目，支持 qishui-liked 等虚拟歌单 id）。
      // 此前缺失该分支时，汽水歌单点击后不发起任何请求，详情面板永远为空列表。
      if (playlistPlatform === 'soda') {
        const data = await getPlaylistDetail(String(playlist.id || ''), 'soda')
        if (!isCurrentRequest()) return
        const detailed = {
          ...playlist,
          ...data?.playlist,
          name: data?.playlist?.name || playlist.name,
          coverImgUrl: data?.playlist?.coverImgUrl || playlist.coverImgUrl,
          trackCount: data?.playlist?.trackCount || playlist.trackCount,
          platform: 'soda',
          isLike: playlist.isLike,
          isCollected: playlist.isCollected,
        }
        setSelectedPlaylist(detailed)
        setPlaylistSongs(Array.isArray(data?.tracks) ? data.tracks : [])
        return
      }

      // 酷狗：经 playlistService 统一详情（公开详情失败回退用户歌单曲目接口）。
      // 此前缺失该分支时，酷狗歌单（含「我喜欢」）点击后不发起任何请求，详情面板永远为空列表。
      if (playlistPlatform === 'kugou') {
        const data = await getPlaylistDetail(String(playlist.id || ''), 'kugou')
        if (!isCurrentRequest()) return
        const detailed = {
          ...playlist,
          ...data?.playlist,
          name: data?.playlist?.name || playlist.name,
          coverImgUrl: data?.playlist?.coverImgUrl || playlist.coverImgUrl,
          trackCount: data?.playlist?.trackCount || playlist.trackCount,
          platform: 'kugou',
          isLike: playlist.isLike,
          isCollected: playlist.isCollected,
        }
        setSelectedPlaylist(detailed)
        setPlaylistSongs(Array.isArray(data?.tracks) ? data.tracks : [])
        return
      }

      if (playlistPlatform === 'netease') {
        await streamNeteasePlaylistTracks(playlist.id, {
          signal: abortController.signal,
          firstPageSize: 120,
          pageSize: 200,
          onPage: (page, firstPage) => {
            if (!isCurrentRequest()) return
            const pageSongs = mapPlaylistTracksToSongs(page.tracks, 'netease')
            setSelectedPlaylist((current: any) => ({ ...(current || playlist), ...page.playlist, trackCount: page.total, platform: 'netease' }))
            setPlaylistSongs(current => {
              if (firstPage) return pageSongs
              const seen = new Set(current.map(song => String(song.id)))
              return [...current, ...pageSongs.filter(song => !seen.has(String(song.id)))]
            })
            if (firstPage) setLoadingPlaylistSongs(false)
          },
        })
      } else if (playlistPlatform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie') || ''
        const data = await fetchWithRetry(`http://localhost:3001/api/qq/playlist/detail?id=${playlist.id}&cookie=${encodeURIComponent(cookie)}`)
        if (!isCurrentRequest()) return

        if (data.playlist) {
          const keepCustomLikeAppearance = Boolean(playlist.isLike)
          setSelectedPlaylist({
            ...playlist,
            ...data.playlist,
            name: keepCustomLikeAppearance ? playlist.name : (data.playlist.name || playlist.name),
            coverImgUrl: keepCustomLikeAppearance ? playlist.coverImgUrl : (data.playlist.coverImgUrl || playlist.coverImgUrl),
            dirId: playlist.dirId,
            userId: playlist.userId,
            isLike: playlist.isLike,
            isCollected: playlist.isCollected,
            platform: 'qq'
          })
        }
        if (data.songlist && Array.isArray(data.songlist)) {
          const songs: Song[] = data.songlist.map((track: any) => ({
            id: track.songid || track.id,
            mid: track.songmid || track.mid,
            name: track.songname || track.name,
            artists: track.singer || [],
            album: {
              name: track.albumname || track.album?.name || '',
              picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
            },
            duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
            platform: 'qq',
            vip: track.pay?.payplay === 1 || false
          }))
          setPlaylistSongs(songs)
        } else {
          console.warn('[QQ Music] songlist field was not found')
        }
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError' && isCurrentRequest()) {
        console.error('[playlist details] load failed:', error)
      }
    } finally {
      activeRequestsRef.current.delete(abortController)
      if (playlistDetailControllerRef.current === abortController) {
        playlistDetailControllerRef.current = null
      }
      if (playlistDetailRequestIdRef.current === requestId) {
        setLoadingPlaylistSongs(false)
      }
    }
  }

  useEffect(() => {
    if (restorePlaybackOrigin?.surface !== 'home-playlist' || !restorePlaybackOrigin.playlist) return
    if (playlistDetailCleanupTimerRef.current !== null) {
      window.clearTimeout(playlistDetailCleanupTimerRef.current)
      playlistDetailCleanupTimerRef.current = null
    }
    cancelPlaylistDetailRequest()
    setLoadingPlaylistSongs(false)
    setSelectedPlaylist(restorePlaybackOrigin.playlist)
    setPlaylistSongs(restorePlaybackOrigin.songs || [])
    setShowPlaylistDetail(true)
  }, [restorePlaybackOrigin?.revision])
  const showPlaylistToast = (message: string, type: 'success' | 'error' | 'info') => {
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
  }

  const isPlaylistActionSuccessful = (result: any) => {
    if (!result || result.error) return false
    return result.code === undefined || result.code === 0 || result.code === 200 || result.result === 0 || result.result === 100
  }

  // Handle the playlist context menu
  const handlePlaylistContextMenu = (playlist: any, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedPlaylist(playlist)
    setPlaylistContextMenu({
      show: true,
      x: e.clientX,
      y: e.clientY,
      playlist: playlist
    })
    setIsSubscribed(Boolean(playlist.isCollected || playlist.subscribed))
  }

  // Create a playlist
  const handleCreatePlaylist = async (name: string, privacy: 'public' | 'private', description?: string, coverDataUrl?: string) => {
    setOperationLoading(true)
    try {
      // Apple：amp-api 创建资料库歌单（描述/封面不受公开接口支持）
      if (platform === 'apple') {
        const ok = await createApplePlaylist(name)
        if (!ok) throw new Error('创建 Apple 歌单失败，请检查登录状态')
        await refreshPlaylists()
        setShowCreatePlaylist(false)
        showPlaylistToast('Apple 歌单创建成功', 'success')
        return
      }
      const result = await createPlaylist(name, platform, {
        privacy: privacy === 'private' ? '10' : '0',
        type: 'NORMAL'
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '创建歌单失败')
      }

      const createdId = result?.playlist?.id || result?.data?.playlist?.id || result?.id || result?.playlistId
      if (platform === 'netease' && description && createdId) {
        const updateResult = await updatePlaylist(createdId.toString(), 'netease', { name, desc: description, tags: '' })
        if (!isPlaylistActionSuccessful(updateResult)) {
          throw new Error(updateResult?.error || updateResult?.message || '歌单描述保存失败')
        }
      }
      if (platform === 'netease' && coverDataUrl && createdId) {
        const coverResult = await updatePlaylistCover(createdId.toString(), coverDataUrl, 'netease')
        if (!isPlaylistActionSuccessful(coverResult)) {
          throw new Error(coverResult?.error || coverResult?.message || '歌单封面上传失败')
        }
      }

      await refreshPlaylists()
      setShowCreatePlaylist(false)
      showPlaylistToast(
        platform === 'qq' && (description || coverDataUrl)
          ? 'QQ 歌单创建成功；描述和自定义封面不受当前接口支持'
          : '歌单创建成功',
        'success'
      )
    } catch (error) {
      console.error('Create playlist failed:', error)
      showPlaylistToast(error instanceof Error ? error.message : '创建歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  // Edit a playlist
  const handleEditPlaylist = async (data: { name: string; desc?: string; privacy?: string; coverDataUrl?: string }) => {
    if (!selectedPlaylist) return
    setOperationLoading(true)
    try {
      // Apple：PATCH 资料库歌单名称/描述
      if (platform === 'apple') {
        const ok = await updateApplePlaylist(String(selectedPlaylist.id || ''), {
          name: data.name,
          description: data.desc || undefined,
        })
        if (!ok) throw new Error('更新 Apple 歌单失败，请检查登录状态')
        await refreshPlaylists()
        setShowEditPlaylist(false)
        showPlaylistToast('Apple 歌单信息已更新', 'success')
        return
      }
      const tags = Array.isArray(selectedPlaylist.tags) ? selectedPlaylist.tags.join(';') : (selectedPlaylist.tags || '')
      const result = await updatePlaylist(selectedPlaylist.id.toString(), 'netease', {
        name: data.name,
        desc: data.desc,
        tags
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '编辑歌单失败')
      }
      if (data.coverDataUrl) {
        const coverResult = await updatePlaylistCover(selectedPlaylist.id.toString(), data.coverDataUrl, 'netease')
        if (!isPlaylistActionSuccessful(coverResult)) {
          throw new Error(coverResult?.error || coverResult?.message || '歌单封面上传失败')
        }
      }
      await refreshPlaylists()
      setShowEditPlaylist(false)
      showPlaylistToast('歌单信息已更新', 'success')
    } catch (error) {
      console.error('Edit playlist failed:', error)
      showPlaylistToast(error instanceof Error ? error.message : '编辑歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  // Delete a playlist
  const handleDeletePlaylist = async () => {
    if (!selectedPlaylist) return
    setOperationLoading(true)
    try {
      // Apple：删除资料库歌单（amp-api）
      if (platform === 'apple') {
        const ok = await deleteApplePlaylist(String(selectedPlaylist.id || ''))
        if (!ok) throw new Error('删除 Apple 歌单失败，请检查登录状态')
        await refreshPlaylists()
        setShowDeletePlaylist(false)
        setSelectedPlaylist(null)
        setShowPlaylistDetail(false)
        showPlaylistToast('Apple 歌单已删除', 'success')
        return
      }
      const deleteId = platform === 'qq' ? selectedPlaylist.dirId || selectedPlaylist.id : selectedPlaylist.id
      const result = await deletePlaylist(deleteId.toString(), platform)
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '删除歌单失败')
      }
      await refreshPlaylists()
      setShowDeletePlaylist(false)
      setSelectedPlaylist(null)
      setShowPlaylistDetail(false)
      showPlaylistToast('歌单已删除', 'success')
    } catch (error) {
      console.error('Delete playlist failed:', error)
      showPlaylistToast(error instanceof Error ? error.message : '删除歌单失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  // Subscribe to or unsubscribe from a playlist
  const handleSubscribePlaylist = async (playlist: any, subscribe: boolean) => {
    setOperationLoading(true)
    try {
      // Apple 无收藏歌单概念（资料库歌单即我的歌单）
      if (platform === 'apple') {
        showPlaylistToast('Apple Music 暂不支持收藏歌单', 'info')
        return
      }
      const result = await subscribePlaylist(playlist.id.toString(), subscribe, platform)
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || (subscribe ? '收藏歌单失败' : '取消收藏失败'))
      }
      setIsSubscribed(subscribe)
      await refreshPlaylists()
      showPlaylistToast(subscribe ? '已收藏歌单' : '已取消收藏', 'success')
    } catch (error) {
      console.error('Playlist subscription failed:', error)
      showPlaylistToast(error instanceof Error ? error.message : '歌单收藏操作失败，请重试', 'error')
    } finally {
      setOperationLoading(false)
    }
  }

  // Share a playlist (copies the share link to the clipboard)
  const handleSharePlaylist = (playlist: any) => {
    const url = platform === 'qq'
      ? `https://y.qq.com/n/ryqq/playlist/${playlist.id}`
      : `https://music.163.com/#/playlist?id=${playlist.id}`
    try {
      navigator.clipboard.writeText(url).catch(() => {
        // Electron 中 clipboard API 可能被 CSP 限制，回退到 textarea 选择复制
        const textarea = document.createElement('textarea')
        textarea.value = url
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      })
    } catch {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    showPlaylistToast('歌单链接已复制', 'success')
  }

  // 按平台显式解析「歌单归属用户 id」：汽水等新平台不复用网易/QQ 身份（否则 owner 校验会
  // 被别的平台 userId 误命中/静默 no-op），无对应身份的平台返回空串，绝不兜底窜台。
  // 汽水以 localStorage['soda_user_id'] 为归属键（sodaUserId prop 为 App 会话快照，兜底一致）。
  const getPlaylistOwnerUserId = (plat: MusicPlatform): string => {
    switch (plat) {
      case 'netease': return neteaseUserId || ''
      case 'qq': return qqUserId || ''
      case 'spotify': return spotifyUserId || ''
      case 'kugou': return kugouUserId || ''
      case 'soda': return sodaUserId || (() => { try { return localStorage.getItem('soda_user_id') || '' } catch { return '' } })()
      default: return ''
    }
  }

  // Remove a song from a playlist
  const handleRemoveFromPlaylist = async (song: Song, playlistId: string) => {
    // Apple：从资料库歌单移除曲目（amp-api）
    if (platform === 'apple') {
      if (!selectedPlaylist || selectedPlaylist.isLike || selectedPlaylist.isCollected) return
      try {
        const appleSongId = song.appleId || String(song.id)
        const ok = await removeAppleTracksFromPlaylist(String(selectedPlaylist.id || ''), [appleSongId])
        if (!ok) throw new Error('从 Apple 歌单移除歌曲失败，请检查登录状态')
        playlistPlaybackCacheRef.current.delete(getPlaylistPlaybackCacheKey(selectedPlaylist))
        setPlaylistSongs(previous => previous.filter(item => !(
          isSameSong(item, song)
        )))
        setSelectedPlaylist((previous: any) => previous ? {
          ...previous,
          trackCount: Math.max(0, Number(previous.trackCount || 0) - 1)
        } : previous)
        await refreshPlaylists()
        showPlaylistToast('已从 Apple 歌单移除歌曲', 'success')
      } catch (error) {
        console.error('Remove song from Apple playlist failed:', error)
        showPlaylistToast(error instanceof Error ? error.message : '从 Apple 歌单移除歌曲失败，请重试', 'error')
      }
      return
    }
    // 归属校验按当前平台显式取自有 userId（此前 else 窜到 neteaseUserId，汽水/spotify/kugou 必然静默 no-op）
    const userId = getPlaylistOwnerUserId(platform)
    if (
      !selectedPlaylist ||
      selectedPlaylist.isLike ||
      selectedPlaylist.isCollected ||
      selectedPlaylist.userId?.toString() !== userId?.toString()
    ) return

    try {
      const result = await removeSongFromPlaylist(playlistId, song.id.toString(), userId || '', platform, {
        songMid: song.mid,
        songType: song.songType,
      })
      if (!isPlaylistActionSuccessful(result)) {
        throw new Error(result?.error || result?.message || '从歌单移除歌曲失败')
      }

      const selectedMutationId = selectedPlaylist
        ? String(selectedPlaylist.dirId || selectedPlaylist.id)
        : ''
      if (selectedPlaylist && selectedMutationId === playlistId) {
        playlistPlaybackCacheRef.current.delete(getPlaylistPlaybackCacheKey(selectedPlaylist))
        setPlaylistSongs(previous => previous.filter(item => !(
          isSameSong(item, song)
        )))
        setSelectedPlaylist((previous: any) => previous ? {
          ...previous,
          trackCount: Math.max(0, Number(previous.trackCount || 0) - 1)
        } : previous)
      }
      await refreshPlaylists()
      showPlaylistToast('已从歌单移除歌曲', 'success')
    } catch (error) {
      console.error('Remove song from playlist failed:', error)
      showPlaylistToast(error instanceof Error ? error.message : '从歌单移除歌曲失败，请重试', 'error')
    }
  }

  const handleRemoveFromLikedPlaylist = async (song: Song) => {
    if (!selectedPlaylist?.isLike || !onRemoveFromFavorites) return
    const removed = await onRemoveFromFavorites(song)
    if (!removed) return

    setPlaylistSongs(previous => previous.filter(item => !(
      isSameSong(item, song)
    )))
    setSelectedPlaylist((previous: any) => previous ? {
      ...previous,
      trackCount: Math.max(0, Number(previous.trackCount || 0) - 1)
    } : previous)
    await refreshPlaylists()
  }

  // Refresh user playlists
  const refreshPlaylists = async (showFeedback = false) => {
    const loadId = ++playlistLoadIdRef.current
    setPlaylistLoading(true)
    try {
      // Apple：资料库歌单（amp-api）；列表接口对喜爱歌曲/收藏类歌单不返回 trackCount，
      // 补拉一次曲目数，避免卡片显示「首歌曲」（空）或详情「undefined 首歌曲」
      if (platform === 'apple') {
        const playlists = await getAppleLibraryPlaylists(100)
        const enriched = await enrichApplePlaylistTrackCounts(playlists)
        if (loadId !== playlistLoadIdRef.current) return
        setUserPlaylists(enriched)
        if (showFeedback) showPlaylistToast('歌单列表已刷新', 'success')
        return
      }
      // 归属身份按平台显式解析（此前 else 落到 qqUserId：QQ 未登录时汽水歌单刷新被静默短路，
      // QQ 登录时又会把汽水缓存键错挂在 QQ 身份上）
      const currentUserId = getPlaylistOwnerUserId(platform)
      if (!currentUserId) return
      const playlists = await getUserPlaylists(
        platform,
        currentUserId,
        platform === 'netease' ? neteaseUsername : platform === 'qq' ? qqUsername : platform === 'soda' ? (sodaUsername || '') : '',
        { forceRefresh: true }
      )
      if (loadId !== playlistLoadIdRef.current) return
      setUserPlaylists(playlists)
      if (showFeedback) showPlaylistToast('歌单列表已刷新', 'success')
    } catch (error) {
      console.error('Refresh playlists failed:', error)
      if (showFeedback) showPlaylistToast('刷新歌单失败，请重试', 'error')
    } finally {
      if (loadId === playlistLoadIdRef.current) setPlaylistLoading(false)
    }
  }

  // Play a playlist
  const handlePlayPlaylist = async (playlist: any, e: React.MouseEvent) => {
    e.stopPropagation() // Avoid opening playlist details
    e.preventDefault()

    try {
      const songs = await resolvePlaylistSongsForPlayback(playlist)
      if (songs.length > 0) {
        onSongSelect(songs[0], songs)
      }
    } catch (error) {
      console.error('Play playlist failed:', error)
    }
  }

  // 首次进入时加载；重新进入简约模式会命中会话缓存。
  useEffect(() => {
    const shouldForceRefresh = authRevision !== playlistAuthRevisionRef.current
    playlistAuthRevisionRef.current = authRevision
    void loadUserPlaylists(shouldForceRefresh)
  }, [neteaseLoggedIn, qqLoggedIn, platform, neteaseUserId, qqUserId, neteaseUsername, qqUsername, authRevision])

  useEffect(() => {
    const handlePlaylistContentChanged = (event: Event) => {
      const detail = (event as CustomEvent<{
        platform?: 'netease' | 'qq'
        type?: string
        coverImgUrl?: string
        trackCountDelta?: number
      }>).detail
      if (!detail || detail.platform !== platform || detail.type !== 'like') return

      const patchLikedPlaylist = (playlist: any) => playlist?.isLike
        ? {
            ...playlist,
            coverImgUrl: detail.coverImgUrl || playlist.coverImgUrl,
            trackCount: Math.max(0, Number(playlist.trackCount || 0) + Number(detail.trackCountDelta || 0))
          }
        : playlist

      setUserPlaylists(previous => previous.map(patchLikedPlaylist))
      setSelectedPlaylist((previous: any) => patchLikedPlaylist(previous))
    }

    window.addEventListener('playlist-content-changed', handlePlaylistContentChanged)
    return () => window.removeEventListener('playlist-content-changed', handlePlaylistContentChanged)
  }, [platform])

  // 预加载首页可见歌单的播放队列与首曲，减少点击等待
  useEffect(() => {
    if (!userPlaylists.length) return

    // Warm only the first small playlist after idle; full playlists can contain hundreds of tracks.
    const targets = userPlaylists.slice(0, 1).filter(playlist => Number(playlist.trackCount || 0) <= 100)
    const timers = targets.map(playlist => window.setTimeout(() => {
      prefetchPlaylistPlayback(playlist)
    }, 1200))

    return () => {
      timers.forEach(timer => window.clearTimeout(timer))
    }
  }, [userPlaylists, platform])
  
  // Watch for home module configuration changes
  useEffect(() => {
    const handleModulesChange = () => {
      const savedNetease = localStorage.getItem('homeModules_netease')
      const savedQQ = localStorage.getItem('homeModules_qq')
      if (savedNetease) {
        setNeteaseModules(sanitizeHomeModules(savedNetease, 'netease'))
        setCurrentNeteaseIndex(0)
      }
      if (savedQQ) {
        setQQModules(sanitizeHomeModules(savedQQ, 'qq'))
        setCurrentQQIndex(0)
      }
    }
    
    window.addEventListener('homeModulesChanged', handleModulesChange)
    return () => window.removeEventListener('homeModulesChanged', handleModulesChange)
  }, [])
  
  // 加载壁纸
  useEffect(() => {
    const loadWallpaper = async () => {
      const wallpaper = await wallpaperManager.getCurrentWallpaper()
      setCurrentWallpaper(wallpaper)
    }
    
    // 初始加载
    loadWallpaper()
    
    // Watch for wallpaper changes
    const handleWallpaperChange = () => {
      loadWallpaper()
    }
    
    window.addEventListener('wallpaperChanged', handleWallpaperChange)
    
    // Start automatic wallpaper switching
    wallpaperManager.startAutoSwitch()
    
    // Switch wallpaper at startup when configured
    wallpaperManager.switchOnStartup()
    
    return () => {
      window.removeEventListener('wallpaperChanged', handleWallpaperChange)
      wallpaperManager.stopAutoSwitch()
    }
  }, [])
  
  // Watch for card blur changes
  useEffect(() => {
    const handleBlurChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail !== undefined) {
        setCardBlurAmount(customEvent.detail)
      }
    }
    
    window.addEventListener('cardBlurChanged', handleBlurChange)
    return () => window.removeEventListener('cardBlurChanged', handleBlurChange)
  }, [])
  
  // 根据登录状态更新默认模块
  useEffect(() => {
    const saved = localStorage.getItem('homeModules_netease')
    if (!saved) {
      setNeteaseModules(getDefaultHomeModules('netease', neteaseLoggedIn))
      setCurrentNeteaseIndex(0)
      setForceReload(prev => prev + 1)
    }
  }, [neteaseLoggedIn])

  useEffect(() => {
    const saved = localStorage.getItem('homeModules_qq')
    if (!saved) {
      setQQModules(getDefaultHomeModules('qq', qqLoggedIn))
      setCurrentQQIndex(0)
      setForceReload(prev => prev + 1)
    }
  }, [qqLoggedIn])

  const loadModernHomeModule = async (
    moduleId: HomeModuleType,
    sessionKey: string,
    signal?: AbortSignal,
    forceRefresh = false,
  ) => {
    const definition = HOME_MODULE_BY_ID[moduleId]
    const modulePlatform = definition.platform
    const loggedIn = modulePlatform === 'netease' ? neteaseLoggedIn : modulePlatform === 'qq' ? qqLoggedIn : modulePlatform === 'apple' ? (appleLoggedIn || false) : modulePlatform === 'spotify' ? (spotifyLoggedIn || false) : modulePlatform === 'kugou' ? (kugouLoggedIn || false) : (sodaLoggedIn || false)

    if (definition.loginRequired && !loggedIn) {
      setModuleSongs([])
      setModulePlaylists([])
      setModuleError(`登录${modulePlatform === 'netease' ? '网易云音乐' : modulePlatform === 'qq' ? 'QQ 音乐' : modulePlatform === 'apple' ? 'Apple Music' : modulePlatform === 'spotify' ? 'Spotify' : modulePlatform === 'kugou' ? '酷狗音乐' : '汽水音乐（抖音）'}后即可加载${definition.name}`)
      return
    }

    const payload = await fetchExploreHome(modulePlatform, signal, {
      forceRefresh,
      appleCountry: modulePlatform === 'apple' ? (appleStorefront || 'cn') : undefined,
    })
    if (signal?.aborted) return

    let songs: Song[] = []
    let playlists: any[] = []

    switch (moduleId) {
      case 'netease_daily_recommend':
        songs = payload.dailySongs
        break
      case 'netease_private_fm':
        songs = payload.radioSongs.length > 0
          ? payload.radioSongs
          : payload.dailySongs.length > 0
            ? payload.dailySongs
            : payload.newSongs
        break
      case 'netease_radar': {
        const radar = payload.playlists.find(item => /雷达|私人/.test(item.name)) ||
          payload.playlists.find(item => item.source === 'personalized')
        if (radar) {
          const detail = await fetchExplorePlaylist(radar, signal)
          if (signal?.aborted) return
          songs = detail.songs.slice(0, 50)
        }
        break
      }
      case 'netease_playlists':
        playlists = payload.playlists
        break
      case 'netease_new_songs':
        songs = payload.newSongs
        break
      case 'qq_guess_you_like':
        songs = payload.radioSongs
        break
      case 'qq_daily_30':
        // 未配置官方 Skills 时，服务端使用同账号的“猜你喜欢”动态批次补足 30 首。
        songs = payload.dailySongs.length > 0
          ? payload.dailySongs
          : payload.radioSongs.length > 0
            ? payload.radioSongs
            : payload.newSongs
        break
      case 'qq_playlists':
        playlists = payload.playlists
        break
      case 'qq_ai_playlists':
        playlists = payload.playlists.filter(item => item.source === 'qqmusic-skills')
        break
      case 'qq_new_songs':
        songs = payload.newSongs
        break
      case 'apple_new_songs':
        songs = payload.newSongs
        break
      case 'apple_playlists':
        playlists = payload.playlists
        break
      case 'apple_hot_songs': {
        const chart = payload.charts.find(item => /热门/.test(item.name)) || payload.charts[0]
        if (chart) {
          songs = (await fetchExploreChart(chart, signal)).songs
          if (signal?.aborted) return
        }
        break
      }
      case 'netease_hot_songs':
      case 'netease_rising_songs':
      case 'qq_hot_songs':
      case 'qq_rising_songs':
      case 'kugou_hot_songs':
      case 'soda_hot_songs':
      case 'spotify_hot_songs': {
        const rising = moduleId.endsWith('rising_songs')
        const pattern = rising ? /飙升|上升/ : /热歌|TOP500|流行指数|热门|抖音/
        const chart = payload.charts.find(item => pattern.test(item.name)) || payload.charts[rising ? 1 : 0]
        if (chart) {
          songs = (await fetchExploreChart(chart, signal)).songs
          if (signal?.aborted) return
        }
        break
      }
      case 'kugou_new_songs':
      case 'soda_new_songs':
      case 'spotify_new_songs':
        songs = payload.newSongs.length > 0 ? payload.newSongs : payload.dailySongs
        break
      case 'kugou_playlists':
      case 'spotify_playlists':
        playlists = payload.playlists
        break
    }

    playlists = playlists.map(item => ({
      id: item.id,
      name: item.name,
      coverImgUrl: item.coverUrl,
      trackCount: item.trackCount || 0,
      playCount: item.playCount || 0,
      description: item.description || '',
      platform: item.platform,
      source: item.source,
    }))

    const visibleSongs = songs.slice(0, 50)
    const visiblePlaylists = playlists.slice(0, 60)
    // QQ 连续推荐的首批仅有 5 首时不能写进简约模式会话缓存，
    // 否则即使随后登录态和 Skill 已准备好，页面仍会一直复用这份短批次。
    const canCacheSnapshot = !requiresFullQQRecommendationBatch(moduleId) || visibleSongs.length >= 30
    if ((visibleSongs.length > 0 || visiblePlaylists.length > 0) && canCacheSnapshot) {
      saveHomeModuleSession(sessionKey, { songs: visibleSongs, playlists: visiblePlaylists })
    }
    if (signal?.aborted) return
    setModuleSongs(visibleSongs)
    setModulePlaylists(visiblePlaylists)

    if (visibleSongs.length === 0 && visiblePlaylists.length === 0) {
      setModuleError(moduleId === 'qq_ai_playlists'
        ? '请先在 QQ 音乐探索页启用官方增强，然后刷新本模块'
        : `${definition.name}暂时没有返回内容，请稍后刷新`)
    }
  }
  
  // 加载当前模块数据（根据平台）
  useEffect(() => {
    const abortController = new AbortController()
    activeRequestsRef.current.add(abortController) // 🔧 跟踪请求
    
    const shouldForceRefresh = authRevision !== moduleAuthRevisionRef.current
    moduleAuthRevisionRef.current = authRevision
    const loadData = async () => {
      if (platform === 'netease' && neteaseModules.length > 0) {
        await loadModuleData(neteaseModules[currentNeteaseIndex], abortController.signal, shouldForceRefresh)
      } else if (platform === 'qq' && qqModules.length > 0) {
        await loadModuleData(qqModules[currentQQIndex], abortController.signal, shouldForceRefresh)
      } else if (platform === 'apple' && appleModules.length > 0) {
        await loadModuleData(appleModules[currentAppleIndex], abortController.signal, shouldForceRefresh)
      } else if (platform === 'spotify' && spotifyModules.length > 0) {
        await loadModuleData(spotifyModules[currentSpotifyIndex], abortController.signal, shouldForceRefresh)
      } else if (platform === 'kugou' && kugouModules.length > 0) {
        await loadModuleData(kugouModules[currentKugouIndex], abortController.signal, shouldForceRefresh)
      } else if (platform === 'soda' && sodaModules.length > 0) {
        await loadModuleData(sodaModules[currentSodaIndex], abortController.signal, shouldForceRefresh)
      }
    }
    
    loadData()
    
    return () => {
      abortController.abort()
      activeRequestsRef.current.delete(abortController) // 🔧 清理请求
    }
  }, [
    platform,
    currentNeteaseIndex,
    currentQQIndex,
    currentAppleIndex,
    currentSpotifyIndex,
    currentKugouIndex,
    currentSodaIndex,
    forceReload,
    neteaseLoggedIn,
    qqLoggedIn,
    appleLoggedIn,
    spotifyLoggedIn,
    kugouLoggedIn,
    sodaLoggedIn,
    neteaseUserId,
    qqUserId,
    neteaseModules,
    qqModules,
    appleModules,
    spotifyModules,
    kugouModules,
    sodaModules,
    authRevision
  ])

  const loadModuleData = async (
    moduleId: HomeModuleType,
    signal?: AbortSignal,
    forceRefresh = false
  ) => {
    const sessionKey = getHomeModuleSessionKey(moduleId, homeModuleIdentities)
    const sessionSnapshot = getHomeModuleSessionSnapshot(sessionKey)

    const canReuseSnapshot = sessionSnapshot && (
      !requiresFullQQRecommendationBatch(moduleId) || sessionSnapshot.songs.length >= 30
    )
    if (canReuseSnapshot) {
      setModuleSongs(sessionSnapshot.songs)
      setModulePlaylists(sessionSnapshot.playlists)
      setModuleError('')
      setModuleLoading(false)
      setModuleCoversReady(true)
      if (!forceRefresh && !sessionSnapshot.isStale) return
    }

    const keepCachedContentVisible = Boolean(canReuseSnapshot)
    setModuleLoading(!keepCachedContentVisible)
    setModuleCoversReady(keepCachedContentVisible)
    setModuleError('')
    if (!keepCachedContentVisible) {
      setModuleSongs([])
      setModulePlaylists([])
    }
    
    try {
      // 检查是否已取消
      if (signal?.aborted) {
        return
      }
      await loadModernHomeModule(moduleId, sessionKey, signal, forceRefresh)

      
    } catch (error: any) {
      // 忽略 AbortError（请求被取消）
      if (error.name === 'AbortError') {
        return
      }
      console.error('加载模块数据失败:', error)
      if (!keepCachedContentVisible) {
        setModuleError(error?.message || '推荐内容加载失败，请稍后重试')
      }
    } finally {
      // Clear loading state unless the request was cancelled
      if (!signal?.aborted) {
        setModuleLoading(false)
      }
    }
  }
  

  const loadChartSongs = async () => {
    setLoading(true)
    try {
      const payload = await fetchExploreHome(platform)
      let songs: Song[] = []
      if (leftChartType === 'new') {
        songs = payload.newSongs
      } else {
        const pattern = leftChartType === 'rising'
          ? /飙升|上升|趋势/
          : /热歌|流行指数|热门/
        const chart = payload.charts.find(item => pattern.test(item.name)) ||
          payload.charts[leftChartType === 'rising' ? 1 : 0]
        if (chart) songs = (await fetchExploreChart(chart)).songs
      }
      setChartSongs(songs.slice(0, 30))
    } catch (error) {
      console.error('加载首页榜单失败:', error)
      setChartSongs([])
    } finally {
      setLoading(false)
    }
  }


  const loadUserPlaylists = async (forceRefresh = false) => {
    const loggedIn = platform === 'netease' ? neteaseLoggedIn : platform === 'qq' ? qqLoggedIn : platform === 'apple' ? (appleLoggedIn || false) : platform === 'spotify' ? (spotifyLoggedIn || false) : platform === 'kugou' ? (kugouLoggedIn || false) : (sodaLoggedIn || false)
    const currentUserId = platform === 'netease' ? neteaseUserId : platform === 'qq' ? qqUserId : platform === 'spotify' ? (spotifyUserId || '') : platform === 'kugou' ? (kugouUserId || '') : platform === 'soda' ? (sodaUserId || '') : ''
    const currentUsername = platform === 'netease' ? neteaseUsername : qqUsername

    if (!loggedIn) {
      ++playlistLoadIdRef.current
      setUserPlaylists([])
      setPlaylistLoading(false)
      return
    }
    // Apple：资料库歌单 + 音乐库（喜爱歌曲）伪歌单（amp-api，无 userId 概念）
    if (platform === 'apple') {
      const loadId = ++playlistLoadIdRef.current
      setUserPlaylists([])
      setPlaylistLoading(true)
      try {
        const [playlistsRes, libraryRes] = await Promise.allSettled([
          getAppleLibraryPlaylists(100),
          getAppleLibrarySongs(100),
        ])
        if (loadId !== playlistLoadIdRef.current) return
        // 资料库歌单：列表接口对喜爱歌曲/收藏类不返回 trackCount → 补拉曲目数；
        // Apple 的「喜爱歌曲（Loved）」自动歌单 → isLike（爱心），重命名 + 首曲封面
        const rawPlaylists = playlistsRes.status === 'fulfilled' ? playlistsRes.value : []
        const enrichedPlaylists = await enrichApplePlaylistTrackCounts(rawPlaylists)
        if (loadId !== playlistLoadIdRef.current) return
        const playlists = enrichedPlaylists.map(playlist => ({
          ...playlist,
          coverImgUrl: playlist.artworkUrl || '',
          isLike: isAppleLovedPlaylistName(playlist.name || ''),
        }))
        const lovedPlaylist = playlists.find(item => item.isLike)
        if (lovedPlaylist) {
          lovedPlaylist.name = `${appleUsername || 'Apple Music 用户'} 的喜爱歌曲`
          const firstCover = await getApplePlaylistFirstTrackArtwork(String(lovedPlaylist.id))
          if (firstCover) lovedPlaylist.coverImgUrl = firstCover
        }
        let appleSongs: Song[] = []
        if (libraryRes.status === 'fulfilled') {
          appleSongs = libraryRes.value.map(track => appleLibraryTrackToSong(track))
          setAppleLibrarySongs(appleSongs)
        }
        // 「我的音乐库」= 全部收藏歌曲，伪歌单置于顶部（非喜爱，不打爱心）
        if (appleSongs.length > 0) {
          setUserPlaylists([
            {
              id: APPLE_LIBRARY_ID,
              name: '我的音乐库',
              coverImgUrl: appleSongs[0]?.album.picUrl || '',
              trackCount: appleSongs.length,
              platform: 'apple',
            },
            ...playlists,
          ])
        } else {
          setUserPlaylists(playlists)
        }
      } catch (error) {
        console.error('Load Apple playlists failed:', error)
      } finally {
        if (loadId === playlistLoadIdRef.current) setPlaylistLoading(false)
      }
      return
    }
    if (!currentUserId) {
      ++playlistLoadIdRef.current
      setUserPlaylists([])
      setPlaylistLoading(false)
      return
    }

    const cached = forceRefresh ? undefined : getCachedUserPlaylists(platform, currentUserId)
    if (cached) {
      ++playlistLoadIdRef.current
      setUserPlaylists(cached)
      setPlaylistLoading(false)
      return
    }

    const loadId = ++playlistLoadIdRef.current
    setUserPlaylists([])
    setPlaylistLoading(true)

    try {
      const playlists = await getUserPlaylists(platform, currentUserId, currentUsername, { forceRefresh })
      if (loadId !== playlistLoadIdRef.current) return
      setUserPlaylists(playlists)
    } catch (error) {
      console.error('Load user playlists failed:', error)
    } finally {
      if (loadId === playlistLoadIdRef.current) setPlaylistLoading(false)
    }
  }

  const currentHomeModuleId = platform === 'netease'
    ? neteaseModules[currentNeteaseIndex]
    : platform === 'qq'
      ? qqModules[currentQQIndex]
      : appleModules[currentAppleIndex]
  const currentHomeModule = currentHomeModuleId ? HOME_MODULE_BY_ID[currentHomeModuleId] : undefined
  const currentHomeModuleNeedsLogin = Boolean(
    currentHomeModule?.loginRequired && (
      platform === 'netease' ? !neteaseLoggedIn : platform === 'qq' ? !qqLoggedIn : platform === 'apple' ? !(appleLoggedIn || false) : platform === 'spotify' ? !(spotifyLoggedIn || false) : platform === 'kugou' ? !(kugouLoggedIn || false) : !(sodaLoggedIn || false)
    )
  )

  const refreshCurrentHomeModule = () => {
    const currentModule = platform === 'netease'
      ? neteaseModules[currentNeteaseIndex]
      : platform === 'qq'
        ? qqModules[currentQQIndex]
        : platform === 'apple'
          ? appleModules[currentAppleIndex]
          : platform === 'spotify'
            ? spotifyModules[currentSpotifyIndex]
            : platform === 'kugou'
              ? kugouModules[currentKugouIndex]
              : sodaModules[currentSodaIndex]
    if (!currentModule) return

    // 取消上一次刷新的在途请求，避免旧响应覆盖新内容
    if (refreshHomeModuleControllerRef.current) {
      refreshHomeModuleControllerRef.current.abort()
      activeRequestsRef.current.delete(refreshHomeModuleControllerRef.current)
    }
    const controller = new AbortController()
    refreshHomeModuleControllerRef.current = controller
    activeRequestsRef.current.add(controller)

    void loadModuleData(currentModule, controller.signal, true)
  }

  const getChartIcon = (type: ChartType) => {
    switch (type) {
      case 'new': return <Clock className="w-4 h-4" />
      case 'hot': return <Flame className="w-4 h-4" />
      case 'rising': return <TrendingUp className="w-4 h-4" />
    }
  }

  const getChartName = (type: ChartType) => {
    switch (type) {
      case 'new': return '新歌榜'
      case 'hot': return '热歌榜'
      case 'rising': return '飙升榜'
    }
  }

  const isLoggedIn = platform === 'netease' ? neteaseLoggedIn : platform === 'qq' ? qqLoggedIn : platform === 'apple' ? (appleLoggedIn || false) : platform === 'spotify' ? (spotifyLoggedIn || false) : platform === 'kugou' ? (kugouLoggedIn || false) : (sodaLoggedIn || false)
  const username = platform === 'netease' ? neteaseUsername : platform === 'qq' ? qqUsername : platform === 'apple' ? (appleUsername || '') : platform === 'spotify' ? (spotifyUsername || '') : platform === 'kugou' ? (kugouUsername || '') : (sodaUsername || '')
  const avatar = platform === 'netease' ? neteaseAvatar : platform === 'qq' ? qqAvatar : platform === 'apple' ? appleAvatar : platform === 'spotify' ? spotifyAvatar : platform === 'kugou' ? kugouAvatar : sodaAvatar
  const userId = platform === 'netease' ? neteaseUserId : platform === 'qq' ? qqUserId : platform === 'kugou' ? (kugouUserId || '') : platform === 'spotify' ? (spotifyUserId || '') : platform === 'soda' ? (sodaUserId || '') : ''
  const isVip = platform === 'netease' ? neteaseVip : platform === 'qq' ? qqVip : false

  // 平台登录入口：netease/qq 走原有点击回调，新平台走通用 onLoginClick（打开对应登录面板）
  const handlePlatformLoginClick = () => {
    if (platform === 'netease') { onNeteaseLoginClick(); return }
    if (platform === 'qq') { onQQLoginClick(); return }
    if (platform === 'apple') { onAppleLoginClick?.(); return }
    onLoginClick?.(platform)
  }
  // 平台登录按钮文案/配色
  const platformLoginLabel = platform === 'netease' ? '网易云登录' : platform === 'qq' ? 'QQ音乐登录' : platform === 'apple' ? 'Apple Music 登录' : platform === 'spotify' ? 'Spotify 登录' : platform === 'kugou' ? '酷狗音乐登录' : '汽水音乐登录'
  const platformLoginColor = platform === 'netease' ? 'bg-red-600 hover:bg-red-700' : platform === 'qq' ? 'bg-green-600 hover:bg-green-700' : platform === 'apple' ? 'bg-pink-600 hover:bg-pink-700' : platform === 'spotify' ? 'bg-[#1DB954] hover:bg-[#17a74b]' : platform === 'kugou' ? 'bg-orange-500 hover:bg-orange-600' : 'bg-sky-500 hover:bg-sky-600'

  useEffect(() => {
    if (!isLoggedIn) {
      setRecentPlaybackSummary({ covers: [], count: 0 })
      return
    }

    const controller = new AbortController()
    const loadSummary = async () => {
      try {
        // 新三平台中 Spotify/酷狗无最近播放汇总，置空展示；汽水走本地只读聚合路由填充
        if (platform === 'spotify' || platform === 'kugou') {
          setRecentPlaybackSummary({ covers: [], count: 0 })
          return
        }
        // 汽水：/api/soda/recent 复用后端账号库聚合缓存（recently-played-media），
        // 返回 mapSodaMedia 映射歌曲（id/name/artist/album/coverUrl/durationMs...），不新造字段
        if (platform === 'soda') {
          const sdCookie = localStorage.getItem('soda_token') || ''
          if (!sdCookie) {
            setRecentPlaybackSummary({ covers: [], count: 0 })
            return
          }
          const query = new URLSearchParams({ limit: '50', cookie: sdCookie })
          const response = await fetch(`http://localhost:3001/api/soda/recent?${query.toString()}`, {
            cache: 'no-store',
            signal: controller.signal,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok || payload?.error) throw new Error(payload?.error || 'recent playback unavailable')
          if (!payload?.loggedIn) {
            setRecentPlaybackSummary({ covers: [], count: 0 })
            return
          }
          const rows = Array.isArray(payload?.songs) ? payload.songs : []
          // 汇总位仅取封面四宫格 + 条数，song 字段无需完整 Song 结构
          const covers = rows.map((row: any) => String(row?.coverUrl || '')).filter(Boolean).slice(0, 4)
          setRecentPlaybackSummary({ covers, count: rows.length })
          return
        }
        // Apple：最近播放走 amp-api（需登录 token）
        if (platform === 'apple') {
          const tracks = await getAppleRecentPlayed(100)
          const covers = tracks.map(track => track.artworkUrl || '').filter(Boolean).slice(0, 4)
          setRecentPlaybackSummary({ covers, count: tracks.length })
          return
        }
        const cookie = platform === 'qq'
          ? localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
          : localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        if (!cookie) return
        const endpoint = platform === 'qq'
          ? 'http://localhost:3001/api/qq/record/recent/song'
          : 'http://localhost:3001/api/netease/record/recent/song'
        const recentQuery = new URLSearchParams({ limit: '100', cookie })
        const response = await fetch(`${endpoint}?${recentQuery.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json()
        if (!response.ok || payload?.error) throw new Error(payload?.error || 'recent playback unavailable')
        const rows = platform === 'qq'
          ? (Array.isArray(payload?.records) ? payload.records : [])
          : ([
              payload?.data?.list,
              payload?.data?.records,
              payload?.data?.songs,
              payload?.data,
              payload?.list,
              payload?.records,
              payload?.songs,
              payload?.weekData,
              payload?.allData,
            ].find(Array.isArray) || [])
        const covers = rows.map((row: any) => {
          const song = platform === 'qq' ? (row?.song || row) : (row?.resource || row?.data || row?.song || row)
          return song?.album?.picUrl || song?.al?.picUrl || song?.albumpic || song?.picUrl || ''
        }).filter((url: unknown): url is string => typeof url === 'string' && url.length > 0).slice(0, 4)
        const reportedCount = Number(payload?.total ?? payload?.data?.total ?? payload?.songnum ?? rows.length)
        setRecentPlaybackSummary({ covers, count: Number.isFinite(reportedCount) ? reportedCount : rows.length })
      } catch (error) {
        if ((error as Error)?.name !== 'AbortError') setRecentPlaybackSummary({ covers: [], count: 0 })
      }
    }

    void loadSummary()
    const handleReported = () => void loadSummary()
    window.addEventListener('waveforge-recent-playback-reported', handleReported)
    return () => {
      controller.abort()
      window.removeEventListener('waveforge-recent-playback-reported', handleReported)
    }
  }, [platform, isLoggedIn, authRevision])

  return (
    <div
      className="home-view-root absolute inset-0 h-full w-full overflow-hidden"
    >
      {/* 壁纸背景或默认渐变背景 */}
      {currentWallpaper ? (
        // 自定义壁纸
        <div className="home-wallpaper-layer absolute inset-0">
          {currentWallpaper.type === 'image' ? (
            <img
              src={currentWallpaper.dataUrl}
              alt="壁纸"
              className="home-wallpaper-media w-full h-full object-cover"
            />
          ) : (
            <video
              src={currentWallpaper.dataUrl}
              className="home-wallpaper-media w-full h-full object-cover"
              autoPlay
              loop
              muted
              playsInline
            />
          )}
          {/* 半透明遮罩，确保内容可读 */}
          <div className={`absolute inset-0 ${playerTheme === 'dark' ? 'bg-black/30' : 'bg-white/40'}`} />
        </div>
      ) : (
        // 默认粉色渐变背景 - 添加动画
        <>
          <motion.div
            className="absolute inset-0"
            style={
              showHeavyVisuals
                ? undefined
                : {
                    background:
                      playerTheme === 'dark'
                        ? 'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)'
                        : 'linear-gradient(135deg, #f7f4ee 0%, #efe8e0 50%, #f3efe8 100%)',
                  }
            }
            animate={
              showHeavyVisuals
                ? {
                    background:
                      playerTheme === 'dark'
                        ? [
                            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
                            'linear-gradient(135deg, #3d1b2d 0%, #2e0f1a 50%, #0a0a0a 100%)',
                            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
                          ]
                        : [
                            'linear-gradient(135deg, #f7f4ee 0%, #efe8e0 50%, #f3efe8 100%)',
                            'linear-gradient(135deg, #f4eef0 0%, #e9e2e6 50%, #f2efe9 100%)',
                            'linear-gradient(135deg, #f7f4ee 0%, #efe8e0 50%, #f3efe8 100%)',
                          ],
                  }
                : undefined
            }
            transition={{
              duration: 10,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          
          {/* Decorative background glow（仅增强模式渲染，普通/效能为静态背景省资源） */}
          {showHeavyVisuals && (<>
          <motion.div
            className="absolute w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(255, 105, 180, 0.6) 0%, rgba(219, 112, 147, 0.4) 40%, transparent 70%)',
              opacity: playerTheme === 'dark' ? 1 : 0.45,
              filter: 'blur(80px)',
              top: '20%',
              left: '15%',
            }}
            animate={{
              scale: [1, 1.3, 1.1, 1],
              x: [0, 60, -20, 0],
              y: [0, 40, -30, 0],
              rotate: [0, 90, 180, 360],
            }}
            transition={{
              duration: 12,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          
          <motion.div
            className="absolute w-[45vw] h-[45vw] max-w-[600px] max-h-[600px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(186, 85, 211, 0.5) 0%, rgba(147, 112, 219, 0.35) 40%, transparent 70%)',
              opacity: playerTheme === 'dark' ? 1 : 0.45,
              filter: 'blur(90px)',
              bottom: '15%',
              right: '20%',
            }}
            animate={{
              scale: [1, 1.4, 1.2, 1],
              x: [0, -50, 30, 0],
              y: [0, -60, 20, 0],
              rotate: [0, -120, -240, -360],
            }}
            transition={{
              duration: 15,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          
          <motion.div
            className="absolute w-[35vw] h-[35vw] max-w-[400px] max-h-[400px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(255, 20, 147, 0.5) 0%, rgba(199, 21, 133, 0.3) 40%, transparent 70%)',
              opacity: playerTheme === 'dark' ? 1 : 0.45,
              filter: 'blur(70px)',
              top: '45%',
              right: '30%',
            }}
            animate={{
              scale: [1, 1.25, 1.15, 1],
              x: [0, 40, -30, 0],
              y: [0, -40, 30, 0],
              rotate: [0, 60, 120, 180],
            }}
            transition={{
              duration: 10,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          
          {/* 额外的流动光晕 */}
          <motion.div
            className="absolute w-[30vw] h-[30vw] max-w-[350px] max-h-[350px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(218, 112, 214, 0.4) 0%, transparent 70%)',
              opacity: playerTheme === 'dark' ? 1 : 0.45,
              filter: 'blur(60px)',
              top: '60%',
              left: '40%',
            }}
            animate={{
              scale: [1, 1.2, 1, 1.1, 1],
              x: [0, -40, 20, -10, 0],
              y: [0, 30, -20, 40, 0],
            }}
            transition={{
              duration: 13,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />

          {/* 第五个光晕 - 右上角 */}
          <motion.div
            className="absolute w-[35vw] h-[35vw] max-w-[450px] max-h-[450px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(255, 182, 193, 0.45) 0%, transparent 70%)',
              opacity: playerTheme === 'dark' ? 1 : 0.45,
              filter: 'blur(75px)',
              top: '10%',
              right: '10%',
            }}
            animate={{
              scale: [1, 1.35, 1.15, 1],
              x: [0, -30, 20, 0],
              y: [0, 50, -30, 0],
              rotate: [0, 180, 360],
            }}
            transition={{
              duration: 14,
              repeat: Infinity,
              ease: "easeInOut"
            }}
          />
          </>)}
          
          {/* 减轻遮罩透明度 */}
          <div className={`absolute inset-0 ${playerTheme === 'dark' ? 'bg-black/10' : 'bg-white/20'}`} />
        </>
      )}

      <motion.div
        className="absolute inset-0 z-10"
        animate={{ y: showThemePanel ? MODE_SELECTION_PANEL_HEIGHT : 0 }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        style={{
          willChange: 'transform',
          backfaceVisibility: 'hidden',
          transform: 'translateZ(0)',
        }}
      >
      {/* Top hover trigger area */}
      <div 
        className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-8 z-50"
        onMouseEnter={() => setIsTopHovered(true)}
        onMouseLeave={() => setIsTopHovered(false)}
        onClick={() => {
          if (!showThemePanel) {
            setThemePanelSettled(false)
            setShowThemePanel(true)
            setShowUpArrowHint(false)
          }
        }}
      >
        <AnimatePresence>
          {(topBarActive || showUpArrowHint) && !showThemePanel && (
            <motion.button
              aria-label="打开模式选择"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              onClick={() => {
                setThemePanelSettled(false)
                setShowThemePanel(true)
                setShowUpArrowHint(false)
              }}
              className={`absolute top-0 left-1/2 -translate-x-1/2 backdrop-blur-md rounded-b-2xl border border-t-0 transition-colors ${playerTheme === 'dark' ? 'bg-white/10 border-white/20 hover:bg-white/20' : 'bg-black/5 border-black/15 hover:bg-black/10'}`}
              style={{ width: '200px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              whileHover={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.12)' }}
              whileTap={{ scale: 0.98 }}
            >
              <motion.div
                animate={{ 
                  y: tvChevronFloat ? [0, 2, 0] : 0,
                  opacity: showUpArrowHint ? [1, 0.5, 1] : 1
                }}
                transition={{ 
                  y: tvChevronFloat ? { duration: 1, repeat: Infinity } : { duration: 0 },
                  opacity: showUpArrowHint ? { duration: 0.5, repeat: Infinity } : { duration: 0 }
                }}
              >
                <svg className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black/70'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                </svg>
              </motion.div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* 主题面板 + 面板内上箭头 */}
      <AnimatePresence>
        {showThemePanel && (
          <ModeSelectionPanel
            currentMode="minimal"
            onClose={() => {
              setThemePanelSettled(false)
              setShowThemePanel(false)
            }}
            onSelect={(mode) => {
              setThemePanelSettled(false)
              setShowThemePanel(false)
              setShowUpArrowHint(false)
              // 立即显示过渡动画；面板收起/内容复位后再切换，避免来源内容以展开态残留成顶部占位
              window.dispatchEvent(new CustomEvent('viewModeTransitionStart', { detail: mode }))
              window.setTimeout(() => {
                localStorage.setItem('viewMode', mode)
                window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode }))
              }, MODE_SELECTION_CLOSE_MS)
            }}
          />
        )}
      </AnimatePresence>

      {/* 内容区 */}
      <motion.div
        className="home-ui-layer relative z-10 w-full h-full flex items-center justify-center px-2 md:px-4 py-4 md:py-6"
      >
        <div className="w-full h-full flex flex-col md:flex-row gap-4 md:gap-6">
        {/* 左栏：自定义模块 - 如果当前平台没有模块则隐藏 */}
        {activeModules.length > 0 && (
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="home-glass-panel relative w-full md:w-80 lg:w-96 min-h-0 flex flex-col flex-shrink-0 overflow-hidden rounded-3xl"
            style={{
              willChange: 'transform, opacity'
            }}
          >
          <div
            aria-hidden="true"
            className="home-glass-panel-surface absolute inset-0 pointer-events-none rounded-3xl"
            style={{
              backdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
              WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
            }}
          />
          {/* Recommendation module header */}
          <div className={`p-6 border-b ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className={`text-xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>首页推荐</h2>
              <motion.button
                whileHover={{ scale: 1.1, rotate: 45 }}
                whileTap={{ scale: 0.9 }}
                onClick={refreshCurrentHomeModule}
                disabled={moduleLoading}
                className={`p-2 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                title="刷新当前推荐"
                aria-label="刷新当前推荐"
              >
                <RefreshCw className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'} ${moduleLoading ? 'animate-spin' : ''}`} />
              </motion.button>
            </div>
            {/* Module tabs */}
            <div className="flex gap-2 overflow-x-auto overflow-y-visible" style={{ scrollbarWidth: 'none' }}>
              {activeModules.map((moduleId, index) => {
                const moduleInfo = HOME_MODULE_BY_ID[moduleId]
                
                const currentIndex = platform === 'netease' ? currentNeteaseIndex : platform === 'qq' ? currentQQIndex : platform === 'apple' ? currentAppleIndex : platform === 'spotify' ? currentSpotifyIndex : platform === 'kugou' ? currentKugouIndex : currentSodaIndex
                const setCurrentIndex = platform === 'netease' ? setCurrentNeteaseIndex : platform === 'qq' ? setCurrentQQIndex : platform === 'apple' ? setCurrentAppleIndex : platform === 'spotify' ? setCurrentSpotifyIndex : platform === 'kugou' ? setCurrentKugouIndex : setCurrentSodaIndex
                
                return (
                  <button
                    key={moduleId}
                    onClick={() => {
                      setCurrentIndex(index)
                    }}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                      currentIndex === index
                        ? playerTheme === 'dark' ? 'bg-white/20 text-white' : 'bg-black/15 text-black/85'
                        : playerTheme === 'dark' ? 'bg-white/5 text-white/60 hover:bg-white/10' : 'bg-black/5 text-black/55 hover:bg-black/10'
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${
                      moduleInfo?.platform === 'netease' ? 'bg-red-500' : 'bg-green-500'
                    }`} />
                    {moduleInfo?.name || moduleId}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 内容区域 */}
          <div 
            className="flex-1 overflow-hidden rounded-b-[24px]"
          >
            <div
              className="home-glass-scroll overflow-y-auto pr-2"
              style={{
                height: 'calc(100% - 10px)',
                scrollbarWidth: 'thin',
                scrollbarColor: playerTheme === 'dark' ? 'rgba(255, 255, 255, 0.3) transparent' : 'rgba(0, 0, 0, 0.3) transparent'
              }}
            >
            <div className="p-4 pb-6">
              {moduleLoading || (!moduleCoversReady && moduleSongs.length === 0 && modulePlaylists.length === 0) ? (
                <div className="flex flex-col items-center justify-center h-64 gap-6">
                  <div className="relative w-20 h-20">
                    <motion.div
                      className="absolute inset-0 rounded-full bg-gradient-to-r from-pink-500/20 to-purple-500/20"
                      animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.2, 0.5] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <motion.div
                      className="absolute inset-2 rounded-full border-2"
                      style={{
                        borderImage: 'linear-gradient(135deg, #ec4899, #a855f7) 1',
                      }}
                      animate={{ rotate: 360 }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                    />
                    <motion.div
                      className="absolute inset-0 flex items-center justify-center"
                      animate={{ scale: [1, 1.1, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      <Music className="w-8 h-8 text-pink-400" />
                    </motion.div>
                  </div>
                  <div className="flex items-center gap-2">
                    <motion.span
                      className={`text-base font-light tracking-wide ${playerTheme === 'dark' ? 'text-white/90' : 'text-black/70'}`}
                      animate={{ opacity: [0.4, 1, 0.4] }}
                      transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      正在加载列表
                    </motion.span>
                    <div className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className="w-1.5 h-1.5 rounded-full bg-pink-400"
                          animate={{ opacity: [0.3, 1, 0.3], y: [0, -4, 0] }}
                          transition={{
                            duration: 1.5,
                            repeat: Infinity,
                            delay: i * 0.2,
                            ease: 'easeInOut',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              ) : moduleError && moduleSongs.length === 0 && modulePlaylists.length === 0 ? (
                <div className="flex min-h-64 flex-col items-center justify-center gap-4 px-5 text-center">
                  <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                    <Music className={`h-7 w-7 ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/40'}`} />
                  </div>
                  <div>
                    <div className={`text-sm font-medium ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>
                      {currentHomeModuleNeedsLogin ? '登录后解锁个性化推荐' : '暂时没有加载到内容'}
                    </div>
                    <p className={`mt-1 max-w-64 text-xs leading-5 ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>{moduleError}</p>
                  </div>
                  <button
                    onClick={currentHomeModuleNeedsLogin
                      ? handlePlatformLoginClick
                      : refreshCurrentHomeModule}
                    className="rounded-full bg-white px-4 py-2 text-xs font-medium text-black transition-transform hover:scale-105 active:scale-95"
                  >
                    {currentHomeModuleNeedsLogin ? '去登录' : '重新加载'}
                  </button>
                </div>
              ) : (
                <div>
                  {/* Song list mode */}
                  {moduleSongs.length > 0 && (
                    <div className="space-y-1">
                      {moduleSongs.map((song, index) => (
                        <motion.div
                          key={`module-song-${index}`}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          // 逐项延迟只保留前 8 项，避免列表越长首屏入场越慢
                          transition={{ delay: Math.min(index, 8) * 0.01 }}
                          whileHover={{ scale: 1.02 }}
                          onClick={() => onSongSelect(song, moduleSongs)}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            setContextMenuPosition({ x: e.clientX, y: e.clientY })
                            setContextMenuSong(song)
                            setContextMenuVisible(true)
                          }}
                          className={`flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all group ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                          style={{ willChange: 'transform' }}
                        >
                          {/* 排名 */}
                          <div className={`w-6 text-center font-bold text-sm ${
                            index < 3 ? 'text-yellow-400' : playerTheme === 'dark' ? 'text-white/40' : 'text-black/35'
                          }`}>
                            {index + 1}
                          </div>

                          {/* 封面 */}
                          <div className={`w-10 h-10 rounded-md overflow-hidden flex-shrink-0 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                            {song.album?.picUrl ? (
                              <CachedImage 
                                src={song.album.picUrl} 
                                alt={song.name} 
                                className="w-full h-full object-cover"
                                fallback={
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Music className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                                  </div>
                                }
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                              </div>
                            )}
                          </div>

                          {/* 歌曲信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <div className={`text-sm font-medium truncate ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>{song.name}</div>
                              {(song.vip || song.fee === 1 || song.fee === 4) && !isVip && (
                                <Crown className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                              )}
                            </div>
                            <div className={`text-xs truncate ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>
                              {song.artists.map(a => a.name).join(', ')}
                            </div>
                          </div>

                          {/* 播放按钮 */}
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <Play className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black/70'}`} />
                          </div>
                          </motion.div>
                        ))}
                      </div>
                    )}

                  {/* Playlist list mode */}
                  {modulePlaylists.length > 0 && (
                    <div className="space-y-2">
                      {modulePlaylists.map((playlist, index) => (
                        <motion.div
                          key={`module-playlist-${playlist.id || index}`}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          // 逐项延迟只保留前 8 项，避免列表越长首屏入场越慢
                          transition={{ delay: Math.min(index, 8) * 0.05 }}
                          whileHover={{ x: 4, transition: { duration: 0.2 } }}
                          onClick={() => handlePlaylistClick(playlist)}
                          onContextMenu={(e) => handlePlaylistContextMenu(playlist, e)}
                          className="flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all group"
                          style={{
                            background: playerTheme === 'dark' ? 'rgba(255, 255, 255, 0.05)' : 'rgba(255, 255, 255, 0.45)',
                            border: playerTheme === 'dark' ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(0, 0, 0, 0.06)',
                            backdropFilter: `blur(${cardBlurAmount}px)`,
                            WebkitBackdropFilter: `blur(${cardBlurAmount}px)`
                          }}
                        >
                          <div className={`w-14 h-14 rounded-lg overflow-hidden flex-shrink-0 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                            {playlist.coverImgUrl ? (
                              <CachedImage
                                src={playlist.coverImgUrl}
                                alt={playlist.name}
                                className="w-full h-full object-cover"
                                fallback={
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Music className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                                  </div>
                                }
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                              </div>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className={`text-sm font-medium line-clamp-2 ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>{playlist.name}</div>
                            <div className={`text-xs mt-0.5 ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>{playlist.trackCount || 0} 首歌曲</div>
                          </div>
                          <button
                            onClick={(e) => handlePlayPlaylist(playlist, e)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Play className={`w-4 h-4 transition-colors ${playerTheme === 'dark' ? 'text-white/70 group-hover:text-white' : 'text-black/60 group-hover:text-black'}`} />
                          </button>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
        </motion.div>
      )}
        {/* right column: user playlists */}
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          layout
          layoutDependency={`${platform}-${activeModules.length}`}
          transition={{
            layout: { type: "spring", stiffness: 300, damping: 30 }
          }}
          className="home-glass-panel relative flex-1 min-h-0 flex flex-col overflow-hidden rounded-3xl"
          style={{
            willChange: 'transform, opacity'
          }}
        >
          <div
            aria-hidden="true"
            className="home-glass-panel-surface absolute inset-0 pointer-events-none rounded-3xl"
            style={{
              backdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
              WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
            }}
          />
          <div className={`p-6 border-b flex items-center justify-between ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
            <h2 className={`text-xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>我的歌单</h2>
            {isLoggedIn && (
              <div className="flex items-center gap-1">
                <motion.button
                  whileHover={{ scale: 1.1, rotate: 45 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => refreshPlaylists(true)}
                  disabled={playlistLoading}
                  className={`p-2 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                  title="刷新歌单"
                  aria-label="刷新歌单"
                >
                  <RefreshCw className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'} ${playlistLoading ? 'animate-spin' : ''}`} />
                </motion.button>
                {(
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setShowCreatePlaylist(true)}
                    className={`p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                    title="创建歌单"
                    aria-label="创建歌单"
                  >
                    <Plus className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}`} />
                  </motion.button>
                )}
              </div>
            )}
          </div>
          <div className="home-glass-scroll flex-1 overflow-y-auto">
            {!isLoggedIn ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <Music className={`w-16 h-16 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                <p className={`mb-4 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}`}>登录后查看你的歌单</p>
                <button
                  onClick={handlePlatformLoginClick}
                  className={`px-6 py-3 ${platformLoginColor} text-white rounded-full font-medium transition-colors`}
                >
                  {platformLoginLabel}
                </button>
              </div>
            ) : playlistLoading && userPlaylists.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <div className={playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}>加载中...</div>
              </div>
            ) : userPlaylists.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <Music className={`w-16 h-16 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                <p className={playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}>暂无歌单</p>
              </div>
            ) : (
              <div className="p-4 pb-6">
                {/* 根据是否有推荐模块调整网格列数 */}
                <div className="grid gap-4" style={{
                gridTemplateColumns: activeModules.length === 0 
                  ? 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))' // Larger cards without recommendation modules
                  : 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', // Standard cards with recommendation modules
                maxWidth: '100%'
              }}>
                <AnimatePresence mode="popLayout">
                {userPlaylists.slice(0, 100).map((playlist: any, index: number) => (
                  <motion.div
                    key={`${platform || 'unknown'}-playlist-${playlist.id || index}`}
                    className="home-playlist-card relative group overflow-hidden rounded-xl cursor-pointer"
                    layout
                    layoutDependency={`${platform}-${playlist.id || index}-${index}`}
                    initial={{ opacity: 0, scale: 0.8, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -20 }}
                    transition={{
                      layout: { type: "spring", stiffness: 300, damping: 30 },
                      opacity: { duration: 0.2 },
                      scale: { duration: 0.2 },
                      // 逐项延迟只保留前 8 项，避免网格越长首屏入场越慢
                      delay: Math.min(index, 8) * 0.03
                    }}
                    whileHover={{ scale: 1.02, transition: { duration: 0.2 } }}
                    onMouseEnter={() => schedulePlaylistHoverPrefetch(playlist)}
                    onMouseLeave={() => cancelPlaylistHoverPrefetch(playlist)}
                    onClick={() => handlePlaylistClick(playlist)}
                    onContextMenu={(e) => handlePlaylistContextMenu(playlist, e)}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gridTemplateRows: 'auto auto',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      willChange: 'transform'
                    }}
                  >
                    <div
                      aria-hidden="true"
                      className="home-playlist-card-glass absolute inset-0 pointer-events-none rounded-xl"
                      style={{
                        backdropFilter: `blur(${cardBlurAmount}px)`,
                        WebkitBackdropFilter: `blur(${cardBlurAmount}px)`,
                      }}
                    />
                    {/* 封面 */}
                    <div
                      className={`relative z-10 rounded-lg overflow-hidden ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}
                      style={{
                        width: activeModules.length === 0 ? '100px' : '80px',
                        height: activeModules.length === 0 ? '100px' : '80px',
                        gridRow: '1 / 3',
                        flexShrink: 0
                      }}
                    >
                      {playlist.coverImgUrl ? (
                        <>
                          <CachedImage
                            src={playlist.coverImgUrl}
                            alt={playlist.name}
                            className="w-full h-full object-cover"
                            fallback={
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                              </div>
                            }
                          />
                          {playlist.isLike && (platform === 'qq' || platform === 'apple') && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Heart
                                className="h-[42%] w-[42%] fill-white/75 text-white/75"
                                strokeWidth={0}
                                style={{
                                  filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.28)) blur(0.6px)'
                                }}
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                        </div>
                      )}
                    </div>

                    {/* Playlist name */}
                    <div className={`relative z-10 text-sm font-medium line-clamp-2 leading-tight ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`} title={playlist.name}>
                      {playlist.name}
                    </div>

                    {/* 歌曲数量 */}
                    <div className={`relative z-10 text-xs self-end pr-12 ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>
                      {playlist.trackCount || 0} 首歌曲
                    </div>

                    {(
                      <button
                        type="button"
                        onClick={(e) => handlePlayPlaylist(playlist, e)}
                        className={`absolute right-3 bottom-3 z-20 w-10 h-10 rounded-xl flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all shadow-lg ${playerTheme === 'dark' ? 'bg-white/5 hover:bg-white/10 text-white border border-white/10 hover:border-white/20' : 'bg-black/5 hover:bg-black/10 text-black/80 border border-black/10 hover:border-black/20'}`}
                        style={{
                          backdropFilter: `blur(${cardBlurAmount}px)`,
                          WebkitBackdropFilter: `blur(${cardBlurAmount}px)`
                        }}
                        title="播放全部"
                        aria-label={`播放歌单：${playlist.name}`}
                      >
                        <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
                      </button>
                    )}
                  </motion.div>
                ))}
                </AnimatePresence>
              </div>
            </div>
            )}
          </div>
        </motion.div>

        {/* 右栏：用户信息 */}
        <motion.div
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          className="home-glass-panel relative w-full md:w-80 min-h-0 flex flex-col flex-shrink-0 overflow-hidden rounded-3xl"
          style={{
            willChange: 'transform, opacity'
          }}
        >
          <div
            aria-hidden="true"
            className="home-glass-panel-surface absolute inset-0 pointer-events-none rounded-3xl"
            style={{
              backdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
              WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
            }}
          />
          <div className={`p-6 border-b flex items-center justify-between ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
            <h2 className={`text-xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>个人信息</h2>
          </div>

          {/* Platform switcher：可拖拽药丸轮播（当前平台始终居中，最多显 3 个，首尾留空） */}
          <div className="px-6 pt-4 pb-2">
            <div className="relative mx-auto overflow-hidden rounded-full p-1"
              style={{
                width: 240,
                background: playerTheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                border: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
              }}
              {...(pillTvAdjust
                ? {
                    'data-tv-focus': '',
                    tabIndex: 0,
                    'data-tv-arrows': 'horizontal',
                    'aria-label': `平台切换，当前 ${platformLabel[platform]}，左右键切换`,
                    onKeyDown: platformKeyDown,
                  }
                : {})}
            >
              {/* 液态玻璃高亮：固定视口中央（第二个槽位），平台滑过时被覆盖；backdrop-blur 液态质感 */}
              <motion.div
                className="absolute top-1 bottom-1 rounded-full shadow-lg"
                style={{
                  width: 80,
                  left: 80, // 固定居中（视口 240 / 3 = 80 的中间槽）
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(255,255,255,0.28), rgba(255,255,255,0.12))'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.95), rgba(255,255,255,0.75))',
                  backdropFilter: `blur(${cardBlurAmount}px) saturate(160%)`,
                  WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(160%)`,
                  boxShadow: playerTheme === 'dark'
                    ? '0 4px 18px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.25)'
                    : '0 4px 20px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.9)',
                  border: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.8)'}`,
                }}
              />
              {/* 可拖拽内容条（指针驱动，参考桌面模式 PlaylistCarousel3D）：当前位置 = (1-floatIndex)*80，
                  拖动实时跟随指针、焦点随取整切换，松手平滑归中；当前平台始终居中（被液态玻璃覆盖） */}
              <motion.div
                ref={platformStripRef}
                className="relative flex touch-none select-none"
                style={{ x: platformStripX, cursor: 'grab' }}
                onPointerDown={platformPointerDown}
                onPointerMove={platformPointerMove}
                onPointerUp={platformPointerUp}
                onPointerCancel={platformPointerUp}
                {...(pillTvAdjust ? { 'data-tv-skip': '' } : {})}
              >
                {visiblePlatforms.map(key => {
                  const dotColor = key === 'netease' ? 'bg-red-500' : key === 'qq' ? 'bg-green-500' : key === 'apple' ? 'bg-pink-500' : key === 'spotify' ? 'bg-[#1DB954]' : key === 'kugou' ? 'bg-orange-500' : 'bg-sky-500'
                  const label = key === 'netease' ? '网易云' : key === 'qq' ? 'QQ音乐' : key === 'apple' ? 'Apple' : key === 'spotify' ? 'Spotify' : key === 'kugou' ? '酷狗' : '汽水'
                  const active = platform === key
                  return (
                    <motion.button
                      key={key}
                      type="button"
                      data-platform={key}
                      onClick={() => setPlatform(key)}
                      className={`flex-shrink-0 w-[80px] py-2 text-sm font-semibold relative z-10 flex items-center justify-center gap-1.5 transition-colors ${
                        active
                          ? playerTheme === 'dark' ? 'text-white' : 'text-black/90'
                          : playerTheme === 'dark' ? 'text-white/45' : 'text-black/35'
                      }`}
                    >
                      <motion.span
                        className={`w-2 h-2 rounded-full ${dotColor}`}
                        animate={{ scale: active ? [1, 1.3, 1] : 1, opacity: active ? 1 : 0.5 }}
                        transition={{ duration: 0.3 }}
                      />
                      {label}
                    </motion.button>
                  )
                })}
              </motion.div>
            </div>
            <div className={`mt-2 text-center text-[10px] tracking-wide transition-opacity duration-1000 ${switcherHintVisible ? 'opacity-100' : 'opacity-0'} ${playerTheme === 'dark' ? 'text-white/25' : 'text-black/25'}`}>{pillTvAdjust ? '左右键切换平台' : '左右拖动切换平台'}</div>
          </div>

          {/* 已播歌曲汇总卡：网易/QQ/Apple 原生记录 + 汽水（/api/soda/recent 聚合），酷狗/Spotify 无数据不展示 */}
          {isLoggedIn && (platform === 'netease' || platform === 'qq' || platform === 'apple' || platform === 'soda') && (
            <div className="px-6 pt-5">
              <motion.button
                type="button"
                onClick={() => onProfileClick(platform, 'recent')}
                whileHover={{ scale: 1.015, y: -2 }}
                whileTap={{ scale: 0.99 }}
                className="home-recent-card group relative w-full overflow-hidden rounded-2xl text-left"
                style={{
                  willChange: 'transform',
                }}
              >
                <div
                  aria-hidden="true"
                  className="home-recent-card-glass absolute inset-0 pointer-events-none rounded-2xl"
                  style={{
                    backdropFilter: `blur(${cardBlurAmount}px)`,
                    WebkitBackdropFilter: `blur(${cardBlurAmount}px)`,
                  }}
                />
                <div className="relative z-10 flex items-center gap-4 p-3">
                  <div className={`grid h-24 w-24 flex-shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-2xl shadow-lg ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                    {Array.from({ length: 4 }).map((_, index) => {
                      const cover = recentPlaybackSummary.covers[index]
                      return cover ? (
                        <CachedImage key={`${cover}-${index}`} src={cover} alt="最近播放封面" className="h-full w-full object-cover" />
                      ) : (
                        <div key={`recent-placeholder-${index}`} className={`flex h-full w-full items-center justify-center ${playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                          <Music className={`h-4 w-4 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                        </div>
                      )
                    })}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className={`text-lg font-semibold ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>已播歌曲</div>
                    <div className={`mt-1 text-sm ${playerTheme === 'dark' ? 'text-white/55' : 'text-black/55'}`}>{recentPlaybackSummary.count} 首</div>
                  </div>
                  <History className={`h-5 w-5 flex-shrink-0 transition-colors ${playerTheme === 'dark' ? 'text-white/35 group-hover:text-white/70' : 'text-black/30 group-hover:text-black/60'}`} />
                </div>
              </motion.button>
            </div>
          )}

          <div className="flex-1 flex flex-col items-center justify-center p-6">
            {!isLoggedIn ? (
              <div className="text-center">
                <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-4 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                  <Music className={`w-10 h-10 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                </div>
                <p className={playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}>未登录</p>
              </div>
            ) : (
              <div className="w-full text-center">
                {/* 头像 */}
                <div className={`w-24 h-24 rounded-full overflow-hidden mx-auto mb-4 border-2 ${playerTheme === 'dark' ? 'border-white/20' : 'border-black/15'}`}>
                  {avatar ? (
                    <img src={avatar} alt={username} className="w-full h-full object-cover" />
                  ) : (
                    <div className={`w-full h-full flex items-center justify-center ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                      <Music className={`w-12 h-12 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                    </div>
                  )}
                </div>

                {/* 昵称 */}
                <div className="mb-2 flex items-center justify-center gap-2">
                  <h3 className={`text-xl font-bold ${isVip ? 'text-yellow-400' : playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>
                    {username}
                  </h3>
                  {isVip && <Crown className="w-5 h-5 text-yellow-400" />}
                </div>

                {/* 账号ID */}
                {((userId && !hideHomeAccountId) || (platform === 'apple' && appleEmail && !hideHomeAccountId)) && (
                  <p className={`text-sm mb-6 ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>
                    {platform === 'netease' ? '网易云ID'
                      : platform === 'qq' ? 'QQ号'
                      : platform === 'apple' ? 'AppleID'
                      : platform === 'kugou' ? '酷狗ID'
                      : platform === 'spotify' ? 'Spotify ID'
                      : '抖音ID'}: {platform === 'apple' ? appleEmail : userId}
                  </p>
                )}

                {/* 操作按钮 */}
                <div className="space-y-3 w-full px-4">
                  <button
                    onClick={() => {
                      onProfileClick(platform, 'created')
                    }}
                    className="relative w-full px-6 py-3 text-white rounded-full font-medium transition-all flex items-center justify-center gap-2 overflow-hidden group"
                    style={{
                      background: platform === 'netease' 
                        ? 'linear-gradient(135deg, #e74c3c 0%, #c0392b 100%)' 
                        : 'linear-gradient(135deg, #31c27c 0%, #22a866 100%)',
                      boxShadow: platform === 'netease'
                        ? '0 4px 20px rgba(231, 76, 60, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)'
                        : '0 4px 20px rgba(49, 194, 124, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.transform = 'translateY(-2px)'
                      e.currentTarget.style.boxShadow = platform === 'netease'
                        ? '0 6px 30px rgba(231, 76, 60, 0.6), inset 0 1px 0 rgba(255,255,255,0.3)'
                        : '0 6px 30px rgba(49, 194, 124, 0.6), inset 0 1px 0 rgba(255,255,255,0.3)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.transform = 'translateY(0)'
                      e.currentTarget.style.boxShadow = platform === 'netease'
                        ? '0 4px 20px rgba(231, 76, 60, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)'
                        : '0 4px 20px rgba(49, 194, 124, 0.4), inset 0 1px 0 rgba(255,255,255,0.2)'
                    }}
                  >
                    <div 
                      className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                      style={{
                        background: platform === 'netease'
                          ? 'radial-gradient(circle at center, #e74c3cff 0%, transparent 70%)'
                          : 'radial-gradient(circle at center, #31c27cff 0%, transparent 70%)',
                        filter: 'blur(20px)',
                      }}
                    />
                    <User className="w-4 h-4 relative z-10" />
                    <span className="relative z-10">个人中心</span>
                  </button>


                  <button
                    onClick={platform === 'netease' ? onNeteaseLogout : platform === 'qq' ? onQQLogout : platform === 'apple' ? (onAppleLogout || (() => {})) : platform === 'spotify' ? (onSpotifyLogout || (() => {})) : platform === 'kugou' ? (onKugouLogout || (() => {})) : (onSodaLogout || (() => {}))}
                    className={`w-full px-6 py-3 rounded-full font-medium transition-all flex items-center justify-center gap-2 ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white' : 'bg-black/10 hover:bg-black/15 text-black/80'}`}
                  >
                    <LogOut className="w-4 h-4" />
                    退出登录
                  </button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
      </motion.div>

      {/* Playlist detail panel */}
      <PlaylistDetailPanel
        show={showPlaylistDetail}
        playerTheme={playerTheme}
        playlist={selectedPlaylist}
        songs={playlistSongs}
        loading={loadingPlaylistSongs}
        onClose={closePlaylistDetail}
        onSongSelect={(song, songs) => {
          // 选歌后关闭歌单详情覆盖层，否则播放页出现后歌单界面还叠在上面
          closePlaylistDetail()
          onSongSelect(song, songs, {
            surface: 'home-playlist',
            playlist: selectedPlaylist,
            songs,
          })
        }}
        neteaseVip={neteaseVip}
        qqVip={qqVip}
        currentPlatform={platform}
        currentUserId={selectedPlaylist?.platform === 'qq' ? qqUserId : neteaseUserId}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={
          selectedPlaylist?.isLike && onRemoveFromFavorites
            ? handleRemoveFromLikedPlaylist
            : onRemoveFromFavorites
        }
        onRemoveFromPlaylist={
          selectedPlaylist?.userId?.toString() === (platform === 'qq' ? qqUserId : neteaseUserId) &&
          !selectedPlaylist?.isLike &&
          !selectedPlaylist?.isCollected
            ? handleRemoveFromPlaylist
            : undefined
        }
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists}
        currentSong={currentSong}
      />

      {/* Bottom floating toolbar：仅主界面显示（歌单/模块详情打开时隐藏） */}
      {!showPlaylistDetail && (
      <motion.div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 z-50"
        style={{
          paddingTop: '40px',
          paddingBottom: '8px'
        }}
        onMouseEnter={() => setIsBottomBarHovered(true)}
        onMouseLeave={() => setIsBottomBarHovered(false)}
      >
        <AnimatePresence mode="wait">
          {!bottomBarActive ? (
            // Collapsed bar
            <motion.div
              key="bar"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="home-bottom-bar relative w-96 h-1.5 overflow-hidden rounded-full cursor-pointer"
              style={{
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
              }}
            >
              <div aria-hidden="true" className="home-bottom-bar-glass absolute inset-0 rounded-full bg-white/40 backdrop-blur-md" />
            </motion.div>
          ) : (
            // Expanded toolbar actions
            <motion.div
              key="pill"
              initial={{ opacity: 0, y: 20, width: '30rem' }}
              animate={{ opacity: 1, y: 0, width: '30rem' }}
              exit={{ opacity: 0, y: 20, width: '30rem' }}
              transition={{ type: "spring", stiffness: 300, damping: 25 }}
              className="home-bottom-pill relative overflow-hidden px-8 py-4 rounded-full"
              style={{
                willChange: 'transform, opacity'
              }}
            >
              <div
                aria-hidden="true"
                className="home-bottom-pill-glass absolute inset-0 pointer-events-none rounded-full"
                style={{
                  backdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
                  WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
                }}
              />
              <div className="relative z-10 flex items-center justify-center gap-6">
                {/* 播放设备控制按钮 */}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-3 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-600 hover:from-violet-600 hover:to-fuchsia-700 text-white transition-all shadow-lg"
                  onClick={onOpenDeviceControl}
                  title="播放设备控制"
                >
                  <Speaker className="w-5 h-5" />
                </motion.button>

                {/* 遥控器按钮 */}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-3 rounded-full bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white transition-all shadow-lg"
                  onClick={onRemoteClick}
                  title="遥控器"
                >
                  <MonitorSmartphone className="w-5 h-5" />
                </motion.button>

                {/* 搜索按钮 */}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-3 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white transition-all shadow-lg"
                  onClick={onSearchClick}
                  title="搜索音乐"
                >
                  <Search className="w-5 h-5" />
                </motion.button>

                {/* Settings button */}
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  className="p-3 rounded-full bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white transition-all shadow-lg"
                  onClick={onSettingsClick}
                  title="设置"
                >
                  <Settings className="w-5 h-5" />
                </motion.button>

                {/* 插件系统入口（含已启用插件快捷按钮） */}
                <PluginShortcuts variant="home" />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      )}
      {/* 右键菜单 */}
      {contextMenuSong && <SongContextMenu
        show={contextMenuVisible}
        x={contextMenuPosition.x}
        y={contextMenuPosition.y}
        song={contextMenuSong}
        playerTheme={playerTheme}
        onClose={() => setContextMenuVisible(false)}
        onPlayNow={(song) => {
          onSongSelect(song, moduleSongs)
          setContextMenuVisible(false)
        }}
        onPlayNext={(song) => {
          onPlayNext?.(song)
          setContextMenuVisible(false)
        }}
        onAddToFavorites={(song) => {
          onAddToFavorites?.(song)
          setContextMenuVisible(false)
        }}
        onRemoveFromFavorites={(song) => {
          void onRemoveFromFavorites?.(song)
          setContextMenuVisible(false)
        }}
        onAddToPlaylist={(song, playlistId) => {
          onAddToPlaylist?.(song, playlistId)
          setContextMenuVisible(false)
        }}
        onViewComments={(song) => {
          onViewComments?.(song)
          setContextMenuVisible(false)
        }}
        onViewAlbum={async (song) => {
          const songPlatform = song.platform || platform
          const albumId = await resolveSongAlbumIdentifier(song, songPlatform)
          if (onOpenAlbum && albumId) {
            onOpenAlbum(albumId, songPlatform)
          }
          setContextMenuVisible(false)
        }}
        onViewArtist={(song) => {
          const songPlatform = song.platform || platform
          const artist = song.artists?.[0]
          // 汽水无艺人 ID，约定传歌手名
          const artistId = songPlatform === 'soda' ? (artist?.name || artist?.id)
            : songPlatform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
          if (onOpenArtist && artistId) onOpenArtist(String(artistId), songPlatform)
          setContextMenuVisible(false)
        }}
        onCopyInfo={(song) => {
          onCopyInfo?.(song)
          setContextMenuVisible(false)
        }}
        userPlaylists={userPlaylists}
        platform={platform}
      />}
      {/* Playlist context menu */}
      <PlaylistContextMenu
        show={playlistContextMenu.show}
        x={playlistContextMenu.x}
        y={playlistContextMenu.y}
        playlist={playlistContextMenu.playlist}
        onClose={() => setPlaylistContextMenu({ show: false, x: 0, y: 0, playlist: null })}
        onEdit={(playlist) => {
          setSelectedPlaylist(playlist)
          setShowEditPlaylist(true)
        }}
        onDelete={(playlist) => {
          setSelectedPlaylist(playlist)
          setShowDeletePlaylist(true)
        }}
        onSubscribe={handleSubscribePlaylist}
        onShare={handleSharePlaylist}
        isOwner={platform === 'apple' ? true : playlistContextMenu.playlist?.userId?.toString() === (platform === 'netease' ? neteaseUserId : qqUserId)}
        isSubscribed={isSubscribed}
        isSpecialPlaylist={Boolean(playlistContextMenu.playlist?.isLike)}
        canEdit={platform === 'netease' || platform === 'apple'}
      />

      {/* Create playlist dialog */}
      <CreatePlaylistModal
        show={showCreatePlaylist}
        onClose={() => setShowCreatePlaylist(false)}
        onSubmit={handleCreatePlaylist}
        loading={operationLoading}
      />

      {/* Edit playlist dialog */}
      <EditPlaylistModal
        show={showEditPlaylist}
        onClose={() => setShowEditPlaylist(false)}
        onSubmit={handleEditPlaylist}
        playlist={selectedPlaylist}
        loading={operationLoading}
      />

      {/* Delete playlist dialog */}
      <DeletePlaylistModal
        show={showDeletePlaylist}
        onClose={() => setShowDeletePlaylist(false)}
        onConfirm={handleDeletePlaylist}
        playlistName={selectedPlaylist?.name || ''}
        loading={operationLoading}
      />
      </motion.div>
    </div>
  )
  }
  // 导出 memo 包装：App 播放中约 1Hz 重渲染时，props 稳定则跳过整棵首页子树重渲染
  export default memo(HomeView)










