// 传统模式：独立的三栏式音乐播放界面。
// - 所有内容（搜索/音乐库/歌单/歌手/专辑/评论/个人中心）都在中间栏直接展示，不用弹窗；
// - 平台切换为可拖拽药丸（与简约模式一致）；模式切换走全局顶部下拉条；
// - 右栏：资料卡 + 正在播放（真实频谱）+ 歌词 + 播放列表（覆盖到底部，可滚动）。
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps } from 'react'
import { AnimatePresence, animate, motion, useMotionValue } from 'framer-motion'
import {
  ChevronLeft, ChevronRight, Heart, Home, Library, ListMusic, LogIn, Music2,
  Pause, Play, Plus, Search, Settings, SkipBack, SkipForward, SlidersHorizontal,
  Sparkles, Volume2, X, Waves, Check,
} from 'lucide-react'
import type { Song, LyricLine } from '../services/musicApi'
import { getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getVisiblePlatforms, getPlatformCapabilities, platformLabel } from '../services/platforms'
import { fetchExploreHome, fetchExplorePlaylist, type ExplorePayload, type ExplorePlaylist } from '../services/exploreApi'
import { createPlaylist, getUserPlaylists, invalidateUserPlaylistsCache, subscribePlaylist } from '../services/playlistService'
import { registerDesktopSpectrumConsumer } from '../services/desktopSpectrum'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'
import { isPerfModeEnhanced } from '../tv/perfMode'
import ModeSelectionPanel, { MODE_SELECTION_CLOSE_MS } from './ModeSelectionPanel'
import TraditionalPlaylistDetail from './TraditionalPlaylistDetail'
import TraditionalSearch from './TraditionalSearch'
import TraditionalLibrary from './TraditionalLibrary'
import TraditionalComments from './TraditionalComments'
import TraditionalArtistDetail from './TraditionalArtistDetail'
import TraditionalAlbumDetail from './TraditionalAlbumDetail'
import SongContextMenu from './SongContextMenu'
import PlaylistContextMenu from './PlaylistContextMenu'
import LyricsDisplay from './LyricsDisplay'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { PlaybackOrigin, SongSelectHandler, ViewMode } from '../types/playbackNavigation'

type TraditionalPreferences = {
  density: 'comfortable' | 'compact'
  showRecommendations: boolean
  showWaveform: boolean
  background: 'aurora' | 'plain' | 'cover'
  backgroundBlur: number
  backgroundDim: boolean
  sidebarWidth: 'narrow' | 'wide'
}

const PREF_KEY = 'waveforge:traditional-preferences:v2'
const defaultPreferences: TraditionalPreferences = {
  density: 'comfortable', showRecommendations: true, showWaveform: true, background: 'aurora', backgroundBlur: 0, backgroundDim: false, sidebarWidth: 'wide',
}

const readPreferences = (): TraditionalPreferences => {
  try { return { ...defaultPreferences, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') } } catch { return defaultPreferences }
}

interface TraditionalViewProps {
  onSongSelect: SongSelectHandler
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  currentSong: Song | null
  queue: Song[]
  currentIndex: number
  isPlaying: boolean
  /** 播放时间不再经 App 每秒下传（会击穿 memo 整树重渲染）：改由内部叶子组件订阅 */
  playbackTimeStore: PlaybackTimeStore
  duration: number
  /** 当前播放歌曲的主题色（跟随歌曲变化，未播放时回退平台色） */
  dominantColor?: string
  lyrics: LyricLine[]
  volume: number
  playerTheme: 'light' | 'dark'
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
  spotifyLoggedIn: boolean
  spotifyUsername: string
  spotifyAvatar?: string
  kugouLoggedIn: boolean
  kugouUsername: string
  kugouAvatar?: string
  sodaLoggedIn: boolean
  sodaUsername: string
  sodaAvatar?: string
  authRevision?: number
  onLoginClick: (platform: MusicPlatform) => void
  onProfileClick: (platform: MusicPlatform) => void
  onSearchClick: () => void
  onSettingsClick: () => void
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
}

const PLATFORM_ACCENTS: Record<MusicPlatform, string> = {
  netease: '#ec4899', qq: '#22c55e', apple: '#fa2d48', spotify: '#1ed760', kugou: '#ff7a00', soda: '#38bdf8',
}

const platformShortName = (platform: MusicPlatform) => ({ netease: '网易云', qq: 'QQ音乐', apple: 'Apple', spotify: 'Spotify', kugou: '酷狗', soda: '汽水' })[platform]
const songKey = (song: Song) => `${song.platform}:${song.id || song.mid || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''
const formatTime = (value: number) => {
  const total = Math.max(0, Math.floor(value || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 进度条行包装：内部订阅播放时间（4Hz），传统视图本体不再因 currentTime 每秒重渲染
const TraditionalProgressRow = memo(function TraditionalProgressRow({
  playbackTimeStore,
  duration,
  onSeek,
  songTheme,
  mutedText,
}: {
  playbackTimeStore: PlaybackTimeStore
  duration: number
  onSeek: (time: number) => void
  songTheme: string
  mutedText: string
}) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime
  const t = Math.min(duration || 1, currentTime)
  return (
    <div className="mt-3">
      <input aria-label="播放进度" type="range" min={0} max={duration || 1} value={t} onChange={(event) => onSeek(Number(event.target.value))} className="w-full" style={{ accentColor: songTheme }} />
      <div className={`mt-1 flex justify-between text-[10px] ${mutedText}`}>
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  )
})

// 内嵌歌词包装：内部订阅播放时间（4Hz），与 App 播放页 LiveLyricsDisplay 同款
const TraditionalLiveLyrics = memo(function TraditionalLiveLyrics({
  playbackTimeStore,
  ...props
}: { playbackTimeStore: PlaybackTimeStore } & Omit<ComponentProps<typeof LyricsDisplay>, 'currentTime'>) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime
  return <LyricsDisplay {...props} currentTime={currentTime} />
})

// 传统模式中间栏页面：一切内容都在中间栏展示，不复用全局弹窗
type TraditionalPage =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'library' }
  | { name: 'profile' }
  | { name: 'playlist'; playlist: any; songs: Song[] }
  | { name: 'comments'; song: Song }
  | { name: 'artist'; id: string; platform: MusicPlatform }
  | { name: 'album'; id: string; platform: MusicPlatform }

function TraditionalView({
  onSongSelect, currentSong, queue, isPlaying, playbackTimeStore, duration, lyrics, volume, playerTheme, dominantColor,
  neteaseLoggedIn, neteaseUsername, neteaseAvatar, neteaseUserId,
  qqLoggedIn, qqUsername, qqAvatar, qqUserId,
  appleLoggedIn, appleUsername, appleAvatar, spotifyUsername, spotifyAvatar,
  kugouUsername, kugouAvatar, sodaUsername, sodaAvatar, authRevision = 0,
  onLoginClick, onSettingsClick, onPlayPause, onNext, onPrevious, onSeek, onVolumeChange,
  onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onCopyInfo,
}: TraditionalViewProps) {
  const [platform, setPlatform] = useState<MusicPlatform>(() => (localStorage.getItem('traditionalPlatform') as MusicPlatform) || 'netease')
  const [visiblePlatforms, setVisiblePlatforms] = useState<MusicPlatform[]>(() => getVisiblePlatforms())
  const [payload, setPayload] = useState<ExplorePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [preferences, setPreferences] = useState<TraditionalPreferences>(readPreferences)
  const [songMenu, setSongMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const [playlistMenu, setPlaylistMenu] = useState<{ show: boolean; x: number; y: number; playlist: any | null }>({ show: false, x: 0, y: 0, playlist: null })
  const [playlistSubscribed, setPlaylistSubscribed] = useState(false)
  const [showModePanel, setShowModePanel] = useState(false)
  const [playlistTab, setPlaylistTab] = useState<'mine' | 'collected'>('mine')
  const [creatingPlaylist, setCreatingPlaylist] = useState(false)
  const [newPlaylistName, setNewPlaylistName] = useState('')
  const [creatingPlaylistBusy, setCreatingPlaylistBusy] = useState(false)
  const [topBarActive, setTopBarActive] = useState(false)
  // TV 遥控器模式（无鼠标）：顶部模式下拉条常驻显示；平台药丸变成单个可聚焦单元，左右键切换。
  // 手机遥控器连上（光标模式）后恢复 PC 式 hover/拖拽交互。
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const topBarTvActive = tvMode && !remoteCursorMode
  const pillTvAdjust = tvMode && !remoteCursorMode
  // 常驻小元素（模式下拉 chevron）的无限浮动：TV 非增强档静态化（JS 动画，tv.css 杀不掉）
  const tvChevronFloat = !tvMode || isPerfModeEnhanced()
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
  const [spectrum, setSpectrum] = useState<number[]>(Array(18).fill(0))
  // 右栏：播放列表 / 同步歌词 共用一张卡片，点击切换；未播放时无歌词，只显示播放列表
  const [rightTab, setRightTab] = useState<'playlist' | 'lyrics'>('playlist')
  // 音量弹层（代替常驻滑条）
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [history, setHistory] = useState<TraditionalPage[]>([{ name: 'home' }])
  const [historyIndex, setHistoryIndex] = useState(0)
  const historyIndexRef = useRef(0)
  historyIndexRef.current = historyIndex
  const currentPage = history[historyIndex] || history[0] || { name: 'home' }
  const mainRef = useRef<HTMLElement>(null)

  // 页面历史导航：左上角 后退/前进 箭头
  const navigate = useCallback((next: TraditionalPage) => {
    setHistory(prev => {
      const trimmed = prev.slice(0, historyIndexRef.current + 1)
      return [...trimmed, next]
    })
    setHistoryIndex(prev => prev + 1)
    mainRef.current?.scrollTo({ top: 0 })
  }, [])
  const goBack = useCallback(() => {
    if (historyIndexRef.current <= 0) return
    setHistoryIndex(historyIndexRef.current - 1)
    mainRef.current?.scrollTo({ top: 0 })
  }, [])
  const goForward = useCallback(() => {
    if (historyIndexRef.current >= history.length - 1) return
    setHistoryIndex(historyIndexRef.current + 1)
    mainRef.current?.scrollTo({ top: 0 })
  }, [history.length])

  const loggedIn = platform === 'netease' ? neteaseLoggedIn : platform === 'qq' ? qqLoggedIn : platform === 'apple' ? appleLoggedIn : platform === 'spotify' ? spotifyUsername.length > 0 : platform === 'kugou' ? kugouUsername.length > 0 : sodaUsername.length > 0
  const username = platform === 'netease' ? neteaseUsername : platform === 'qq' ? qqUsername : platform === 'apple' ? appleUsername : platform === 'spotify' ? spotifyUsername : platform === 'kugou' ? kugouUsername : sodaUsername
  const avatar = platform === 'netease' ? neteaseAvatar : platform === 'qq' ? qqAvatar : platform === 'apple' ? appleAvatar : platform === 'spotify' ? spotifyAvatar : platform === 'kugou' ? kugouAvatar : sodaAvatar
  const accent = PLATFORM_ACCENTS[platform]
  // 正在播放/歌词卡片的主题色跟随当前歌曲（dominantColor），未播放时用平台色
  const songTheme = currentSong && dominantColor ? dominantColor : accent
  const isDark = playerTheme === 'dark'
  const text = isDark ? 'text-white' : 'text-slate-900'
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'

  useEffect(() => {
    const syncPlatforms = () => setVisiblePlatforms(getVisiblePlatforms())
    window.addEventListener('waveforge-platform-visibility-changed', syncPlatforms)
    window.addEventListener('waveforge-platform-order-changed', syncPlatforms)
    return () => { window.removeEventListener('waveforge-platform-visibility-changed', syncPlatforms); window.removeEventListener('waveforge-platform-order-changed', syncPlatforms) }
  }, [])

  useEffect(() => {
    if (!visiblePlatforms.includes(platform)) setPlatform(visiblePlatforms[0] || 'netease')
  }, [platform, visiblePlatforms])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPayload(null)
    void fetchExploreHome(platform).then(next => { if (!cancelled) setPayload(next) }).catch(() => { if (!cancelled) setPayload(null) }).finally(() => { if (!cancelled) setLoading(false) })
    localStorage.setItem('traditionalPlatform', platform)
    return () => { cancelled = true }
  }, [platform, authRevision])

  useEffect(() => {
    let cancelled = false
    const id = platform === 'netease' ? neteaseUserId : platform === 'qq' ? qqUserId : ''
    const name = username
    if (!id && !name) { setUserPlaylists([]); return }
    void getUserPlaylists(platform, id || '', name || undefined).then(items => { if (!cancelled) setUserPlaylists(items || []) }).catch(() => { if (!cancelled) setUserPlaylists([]) })
    return () => { cancelled = true }
  }, [platform, neteaseUserId, qqUserId, username, authRevision])

  useEffect(() => {
    const close = () => setShowSettings(false)
    window.addEventListener('viewModeChanged', close)
    return () => window.removeEventListener('viewModeChanged', close)
  }, [])

  // 未播放（无歌词）时自动切回播放列表 tab
  useEffect(() => {
    if (!currentSong && rightTab === 'lyrics') setRightTab('playlist')
  }, [currentSong, rightTab])

  const savePreferences = useCallback((patch: Partial<TraditionalPreferences>) => {
    setPreferences(prev => { const next = { ...prev, ...patch }; localStorage.setItem(PREF_KEY, JSON.stringify(next)); window.dispatchEvent(new CustomEvent('traditionalPreferencesChanged', { detail: next })); return next })
  }, [])

  // 真实频谱：注册为桌面频谱消费者，接收 App 主进程算好的 48 段频谱，取 18 段渲染
  useEffect(() => {
    // 桌面频谱消费者仅桌面有意义：TV（Android）无 Electron 频谱源，注册只会让 10Hz 空转
    if (tvMode) return
    const unregister = registerDesktopSpectrumConsumer()
    let frame: number | null = null
    let pending: number[] | null = null
    const update = (event: Event) => {
      pending = (event as CustomEvent<number[]>).detail
      if (frame !== null || document.visibilityState !== 'visible') return
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (!pending?.length) return
        const source = pending
        const target = Array.from({ length: 18 }, (_, index) => {
          const pos = (index / 17) * (source.length - 1)
          const left = Math.floor(pos)
          const right = Math.min(source.length - 1, left + 1)
          return (source[left] || 0) * (1 - (pos - left)) + (source[right] || 0) * (pos - left)
        })
        setSpectrum(target)
      })
    }
    window.addEventListener('desktopSpectrumChanged', update)
    return () => {
      unregister()
      window.removeEventListener('desktopSpectrumChanged', update)
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [tvMode])

  const openPlaylist = useCallback(async (playlist: ExplorePlaylist | any) => {
    setPlaylistLoading(true)
    navigate({ name: 'playlist', playlist: playlist || null, songs: [] })
    try {
      const result = await fetchExplorePlaylist({ ...playlist, platform: playlist.platform || platform })
      setHistory(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last && last.name === 'playlist') next[next.length - 1] = { name: 'playlist', playlist: result.playlist || playlist, songs: result.songs || [] }
        return next
      })
    } catch { /* 保留 loading 占位 */ } finally { setPlaylistLoading(false) }
  }, [platform, navigate])

  const openArtistDetail = useCallback((artistId: string, targetPlatform: MusicPlatform) => {
    if (artistId) navigate({ name: 'artist', id: String(artistId), platform: targetPlatform })
  }, [navigate])
  const openAlbumDetail = useCallback((albumId: string, targetPlatform: MusicPlatform) => {
    if (albumId) navigate({ name: 'album', id: String(albumId), platform: targetPlatform })
  }, [navigate])
  const openCommentsFor = useCallback((song: Song) => { if (song) navigate({ name: 'comments', song }) }, [navigate])

  const handleSubscribePlaylist = useCallback(async (playlist: any, subscribe: boolean) => {
    const targetPlatform = (playlist?.platform || platform) as MusicPlatform
    if (!getPlatformCapabilities(targetPlatform).subscribePlaylist) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `${platformLabel(targetPlatform)}暂不支持收藏歌单`, type: 'info' } }))
      return
    }
    try {
      const result = await subscribePlaylist(String(playlist?.id || playlist?.dirId || ''), subscribe, targetPlatform)
      const success = result && !result.error && (result.code === undefined || result.code === 0 || result.code === 200 || result.result === undefined || result.result === 0 || result.result === 100)
      if (!success) throw new Error(result?.message || result?.error || '歌单收藏操作失败')
      setPlaylistSubscribed(subscribe)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: subscribe ? '已收藏歌单' : '已取消收藏', type: 'success' } }))
      window.dispatchEvent(new CustomEvent('waveforge-auth-changed'))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '歌单收藏操作失败，请重试', type: 'error' } }))
    }
  }, [platform])

  const handleCreatePlaylist = useCallback(async () => {
    const name = newPlaylistName.trim()
    if (!name || creatingPlaylistBusy) return
    if (!loggedIn) { onLoginClick(platform); return }
    setCreatingPlaylistBusy(true)
    try {
      const result = await createPlaylist(name, platform)
      const success = result && !result.error && (result.code === 200 || result.code === undefined || result.result === 0 || result.result === 100 || result.result === undefined)
      if (!success) throw new Error(result?.message || result?.error || '创建歌单失败')
      invalidateUserPlaylistsCache(platform, platform === 'netease' ? (neteaseUserId || '') : (qqUserId || ''))
      const id = platform === 'netease' ? neteaseUserId : platform === 'qq' ? qqUserId : ''
      void getUserPlaylists(platform, id || '', username || undefined).then(items => setUserPlaylists(items || [])).catch(() => undefined)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单已创建', type: 'success' } }))
      setCreatingPlaylist(false)
      setNewPlaylistName('')
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '创建歌单失败', type: 'error' } }))
    } finally { setCreatingPlaylistBusy(false) }
  }, [newPlaylistName, creatingPlaylistBusy, loggedIn, platform, neteaseUserId, qqUserId, username, onLoginClick])

  const recommendationSongs = useMemo(() => {
    const list = [...(payload?.dailySongs || []), ...(payload?.radioSongs || []), ...(payload?.newSongs || [])]
    return list.filter((song, index, arr) => arr.findIndex(other => songKey(other) === songKey(song)) === index).slice(0, preferences.density === 'compact' ? 8 : 12)
  }, [payload, preferences.density])
  const heroSongs = recommendationSongs.slice(0, 4)
  const minePlaylists = userPlaylists.filter(item => !item.isLike && !item.isCollected && !item.subscribed)
  const collectedPlaylists = userPlaylists.filter(item => !item.isLike && (Boolean(item.isCollected) || Boolean(item.subscribed)))
  const displayPlaylist = (playlistTab === 'mine' ? minePlaylists : collectedPlaylists)
  const queuedSongs = queue.length > 0 ? queue : currentSong ? [currentSong] : []
  const switchMode = (mode: ViewMode) => { window.dispatchEvent(new CustomEvent('viewModeTransitionStart', { detail: mode })); window.setTimeout(() => { localStorage.setItem('viewMode', mode); window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode })) }, MODE_SELECTION_CLOSE_MS); setShowModePanel(false) }
  const openLibrary = () => navigate({ name: 'library' })
  const openLikedSongs = () => {
    // 优先打开「我喜欢的音乐」歌单；找不到时进入音乐库（个人资料里的我喜欢的入口），不再弹全局资料弹层
    const liked = userPlaylists.find(item => item.isLike)
    if (liked) void openPlaylist(liked)
    else navigate({ name: 'library' })
  }

  // 平台药丸：与简约模式同款指针驱动——当前平台始终居中；拖动实时跟随、松手平滑归中
  const PLATFORM_SLOT = 80
  const platformIdx = Math.max(0, visiblePlatforms.indexOf(platform))
  const platformStripX = useMotionValue((1 - platformIdx) * PLATFORM_SLOT)
  const platformDragRef = useRef<{ startX: number; startIdx: number; dragging: boolean; moved: boolean; pressedKey: MusicPlatform | null }>({ startX: 0, startIdx: platformIdx, dragging: false, moved: false, pressedKey: null })
  const platformIdxRef = useRef(platformIdx)
  platformIdxRef.current = platformIdx
  const platformDraggingRef = useRef(false)
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
    if (!wasDrag && pressedKey && pressedKey !== platform) setPlatform(pressedKey)
  }

  // 背景：独立背景层（模糊只作用于背景），内容层在其上
  const bgBase = preferences.background === 'plain'
    ? (isDark ? '#090d16' : '#f3f4f6')
    : preferences.background === 'cover' && currentSong
      ? `linear-gradient(135deg, rgba(8,12,22,.96), rgba(8,12,22,.78)), url(${coverOf(currentSong)}) center/cover`
      : (isDark ? 'radial-gradient(circle at 88% 0%, rgba(236,72,153,.22), transparent 34%), radial-gradient(circle at 32% 24%, rgba(59,130,246,.16), transparent 36%), #090d16' : 'radial-gradient(circle at 88% 0%, rgba(236,72,153,.16), transparent 34%), #f2f4f8')
  // TV 弱 GPU：全屏 filter blur 是栅格化大头，TV 上把背景模糊钳到 4px（桌面保持用户设置）
  const bgBlur = tvMode ? Math.min(preferences.backgroundBlur, 4) : preferences.backgroundBlur
  const bgStyle = bgBlur > 0
    ? { background: bgBase, filter: `blur(${bgBlur}px)`, transform: 'scale(1.06)' }
    : { background: bgBase }

  return (
    <div className={`relative h-full overflow-hidden ${text}`}>
      {/* 背景层：可独立模糊/暗化，不影响前景内容 */}
      <div className={`pointer-events-none absolute inset-0 transition-[filter] ${tvMode ? 'duration-100' : 'duration-300'}`} style={bgStyle} />
      {preferences.backgroundDim && <div className="pointer-events-none absolute inset-0 bg-black/25" />}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/15" />

      <header className="relative z-30 flex h-16 items-center gap-3 border-b px-4 backdrop-blur-xl" style={{ borderColor: isDark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.1)' }}>
        {/* 左上角：Logo + 软件名 */}
        <div className="flex shrink-0 items-center gap-2">
          <img src={new URL('../../logo.png', import.meta.url).href} alt="WaveForge" className="h-8 w-8 rounded-xl object-cover" />
          <span className="hidden text-sm font-semibold sm:inline">WaveForge</span>
        </div>
        {/* 平台药丸（名字右边，拖拽切换） */}
        <div className="relative h-9 w-[240px] shrink-0 overflow-hidden rounded-2xl border" style={{ borderColor: isDark ? 'rgba(255,255,255,.12)' : 'rgba(15,23,42,.12)' }}
          {...(pillTvAdjust
            ? {
                'data-tv-focus': '',
                tabIndex: 0,
                'data-tv-arrows': 'horizontal',
                'aria-label': `平台切换，当前 ${platformShortName(platform)}，左右键切换`,
                onKeyDown: platformKeyDown,
              }
            : {})}
        >
          <div className="pointer-events-none absolute left-1/2 top-1/2 h-7 w-[76px] -translate-x-1/2 -translate-y-1/2 rounded-xl transition-colors" style={{ background: `${accent}1f`, border: `1px solid ${accent}55` }} />
          <motion.div className="relative flex touch-none select-none" style={{ x: platformStripX, cursor: 'grab' }} onPointerDown={platformPointerDown} onPointerMove={platformPointerMove} onPointerUp={platformPointerUp} onPointerCancel={platformPointerUp} {...(pillTvAdjust ? { 'data-tv-skip': '' } : {})}>
            {visiblePlatforms.map(key => {
              const active = platform === key
              return (
                <motion.button
                  key={key} type="button" data-platform={key} onClick={() => setPlatform(key)}
                  className="relative z-10 flex h-9 w-20 flex-shrink-0 items-center justify-center gap-1.5 text-xs font-medium transition-colors"
                  style={{ color: active ? (isDark ? '#fff' : '#1a1a1a') : isDark ? 'rgba(255,255,255,.45)' : 'rgba(15,23,42,.4)' }}
                >
                  <motion.span className="h-1.5 w-1.5 rounded-full" style={{ background: active ? accent : isDark ? 'rgba(255,255,255,.4)' : 'rgba(15,23,42,.3)' }} animate={{ scale: active ? [1, 1.35, 1] : 1, opacity: active ? 1 : .5 }} transition={{ duration: .3 }} />
                  {platformShortName(key)}
                </motion.button>
              )
            })}
          </motion.div>
        </div>
        {/* 后退 / 前进（药丸右边） */}
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={goBack} disabled={historyIndex <= 0} aria-label="后退" className="rounded-xl p-2 transition hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"><ChevronLeft className="h-4 w-4" /></button>
          <button type="button" onClick={goForward} disabled={historyIndex >= history.length - 1} aria-label="前进" className="rounded-xl p-2 transition hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <button type="button" onClick={() => navigate({ name: 'search' })} className={`flex h-9 w-full max-w-[220px] items-center justify-center gap-2 rounded-2xl border px-3 text-sm transition hover:bg-white/10 ${muted} ${surface}`}><Search className="h-4 w-4" />搜索</button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button type="button" onClick={() => setShowSettings(true)} className="rounded-xl p-2 opacity-70 transition hover:bg-white/10" aria-label="传统模式设置"><Settings className="h-4 w-4" /></button>
          <button type="button" onClick={() => loggedIn ? navigate({ name: 'profile' }) : onLoginClick(platform)} className="flex max-w-[130px] items-center gap-2 rounded-2xl border px-2.5 py-1.5 transition hover:bg-white/10" style={{ borderColor: isDark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.1)' }}>{avatar ? <img src={avatar} alt="" className="h-7 w-7 rounded-full object-cover" /> : loggedIn ? <div className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: accent }}><Music2 className="h-4 w-4 text-white" /></div> : <LogIn className="h-4 w-4" />}<span className="truncate text-xs">{loggedIn ? username || '我的账户' : '登录'}</span></button>
        </div>
      </header>

      <AnimatePresence>{showModePanel && <ModeSelectionPanel currentMode="traditional" onClose={() => setShowModePanel(false)} onSelect={switchMode} />}</AnimatePresence>

      {/* 顶部悬停触发条：与简约/探索一致的全局模式下拉入口 */}
      <div
        className="absolute left-1/2 top-0 z-40 h-8 w-32 -translate-x-1/2"
        aria-label="顶部悬停切换模式区域"
        onMouseEnter={() => setTopBarActive(true)}
        onMouseLeave={() => setTopBarActive(false)}
        onClick={() => { if (!showModePanel) setShowModePanel(true) }}
      >
        <AnimatePresence>
          {(topBarTvActive || topBarActive) && !showModePanel && (
            <motion.button
              aria-label="打开模式选择"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              onClick={() => setShowModePanel(true)}
              className={`absolute left-1/2 top-0 -translate-x-1/2 rounded-b-2xl border border-t-0 backdrop-blur-md transition-colors ${isDark ? 'border-white/20 bg-white/10 hover:bg-white/20' : 'border-black/15 bg-black/5 hover:bg-black/10'}`}
              style={{ width: '200px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <motion.div animate={tvChevronFloat ? { y: [0, 2, 0] } : { y: 0 }} transition={tvChevronFloat ? { y: { duration: 1, repeat: Infinity } } : { duration: 0 }}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className={`h-6 w-6 ${isDark ? 'text-white' : 'text-black/70'}`}><path d="M6 9l6 6 6-6" /></svg>
              </motion.div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      <div className="relative z-10 grid h-[calc(100%_-_4rem)] min-h-0" style={{ gridTemplateColumns: preferences.sidebarWidth === 'wide' ? '220px minmax(0,1fr) 320px' : '176px minmax(0,1fr) 300px' }}>
        {/* 左栏：导航 + 我的歌单 / 收藏歌单 */}
        <aside className={`flex min-h-0 flex-col border-r px-3 py-5 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
          <nav className="space-y-1">
            <button type="button" onClick={() => navigate({ name: 'home' })} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm" style={{ background: currentPage.name === 'home' ? `${accent}2e` : undefined, color: currentPage.name === 'home' ? accent : undefined }}><Home className="h-4 w-4" />发现</button>
            <button type="button" onClick={openLibrary} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${currentPage.name === 'library' ? '' : muted} hover:bg-white/10`} style={currentPage.name === 'library' ? { color: accent } : undefined}><Library className="h-4 w-4" />音乐库</button>
            <button type="button" onClick={openLikedSongs} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${muted} hover:bg-white/10`}><Heart className="h-4 w-4" />我喜欢</button>
          </nav>
          <div className="mt-7 flex items-center gap-2 px-1">
            <button type="button" onClick={() => setPlaylistTab('mine')} className={`rounded-full px-2.5 py-1 text-xs transition ${playlistTab === 'mine' ? 'font-medium' : muted}`} style={playlistTab === 'mine' ? { color: accent } : undefined}>我的歌单</button>
            <span className={`text-xs ${muted}`}>/</span>
            <button type="button" onClick={() => setPlaylistTab('collected')} className={`rounded-full px-2.5 py-1 text-xs transition ${playlistTab === 'collected' ? 'font-medium' : muted}`} style={playlistTab === 'collected' ? { color: accent } : undefined}>收藏</button>
            <button type="button" onClick={() => { if (!loggedIn) { onLoginClick(platform); return } setCreatingPlaylist(value => !value) }} className="ml-auto rounded p-1 hover:bg-white/10" aria-label="创建歌单"><Plus className="h-3.5 w-3.5" /></button>
          </div>
          {creatingPlaylist && (
            <div className="mt-2 flex items-center gap-1.5 px-1">
              <input
                autoFocus
                value={newPlaylistName}
                onChange={event => setNewPlaylistName(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void handleCreatePlaylist() }}
                placeholder="歌单名称"
                className="h-8 w-full min-w-0 flex-1 rounded-lg border bg-transparent px-2 text-xs outline-none"
                style={{ borderColor: isDark ? 'rgba(255,255,255,.2)' : 'rgba(15,23,42,.2)' }}
              />
              <button type="button" onClick={() => void handleCreatePlaylist()} disabled={creatingPlaylistBusy || !newPlaylistName.trim()} className="rounded-lg p-1.5 text-white disabled:opacity-40" style={{ background: accent }} aria-label="确认创建"><Check className="h-3.5 w-3.5" /></button>
            </div>
          )}
          <div className="mt-2 flex-1 space-y-1 overflow-y-auto">
            {displayPlaylist.map((playlist: any) => (
              <button type="button" key={`${playlist.platform || platform}:${playlist.id || playlist.dirId}`} onClick={() => openPlaylist(playlist)} onContextMenu={event => { event.preventDefault(); setPlaylistSubscribed(Boolean(playlist.isCollected || playlist.subscribed)); setPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }} className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-white/10`}>
                <img src={playlist.coverImgUrl || playlist.coverUrl || ''} alt="" className="h-9 w-9 rounded-lg object-cover" />
                <span className="min-w-0 flex-1 truncate text-xs">{playlist.name}</span>
              </button>
            ))}
            {displayPlaylist.length === 0 && <p className={`px-2 py-4 text-center text-[10px] ${muted}`}>{playlistTab === 'mine' ? '还没有创建歌单，点 + 新建' : '还没有收藏歌单'}</p>}
          </div>
        </aside>

        {/* 中间栏：内容展示区（首页/搜索/音乐库/歌单/歌手/专辑/评论/个人中心） */}
        <main ref={mainRef} className="min-h-0 overflow-y-auto px-5 py-6 lg:px-8">
          {currentPage.name === 'search' ? (
            <TraditionalSearch platform={platform} accent={accent} isDark={isDark} currentSong={currentSong} onBack={goBack} onSongSelect={onSongSelect} onOpenPlaylist={openPlaylist} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'library' ? (
            <TraditionalLibrary platform={platform} accent={accent} isDark={isDark} loggedIn={loggedIn} username={username} loading={loading} payload={payload} recommendationSongs={recommendationSongs} onBack={goBack} onSongSelect={onSongSelect} onOpenPlaylist={openPlaylist} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'profile' ? (
            <ProfilePage platform={platform} accent={accent} isDark={isDark} loggedIn={loggedIn} username={username} avatar={avatar} userPlaylists={userPlaylists} onBack={goBack} onOpenPlaylist={openPlaylist} onOpenLiked={openLikedSongs} onLoginClick={() => onLoginClick(platform)} />
          ) : currentPage.name === 'playlist' ? (
            <TraditionalPlaylistDetail playlist={currentPage.playlist} songs={currentPage.songs} loading={playlistLoading} currentSong={currentSong} playerTheme={playerTheme} accentColor={accent} onClose={goBack} onSongSelect={(song, songs) => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-playlist', platform: song.platform || platform })} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'comments' ? (
            <TraditionalComments song={currentPage.song} accent={accent} isDark={isDark} onClose={goBack} />
          ) : currentPage.name === 'artist' ? (
            <TraditionalArtistDetail artistId={currentPage.id} platform={currentPage.platform} accent={accent} isDark={isDark} currentSong={currentSong} onClose={goBack} onSongSelect={onSongSelect} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} onOpenAlbum={openAlbumDetail} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'album' ? (
            <TraditionalAlbumDetail albumId={currentPage.id} platform={currentPage.platform} accent={accent} isDark={isDark} currentSong={currentSong} onClose={goBack} onSongSelect={onSongSelect} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} onOpenArtist={openArtistDetail} userPlaylists={userPlaylists} />
          ) : (
            <HomeContent
              platform={platform} accent={accent} isDark={isDark} muted={muted} surface={surface}
              loading={loading} loggedIn={loggedIn} username={username} payload={payload}
              recommendationSongs={recommendationSongs} heroSongs={heroSongs} preferences={preferences}
              onOpenSettings={() => setShowSettings(true)}
              onSongSelect={(song, songs, origin) => onSongSelect(song, songs, origin)}
              onSongMenu={setSongMenu} onPlaylistMenu={setPlaylistMenu} onOpenPlaylist={openPlaylist}
            />
          )}
        </main>

        {/* 右栏：资料卡 + 正在播放（真实频谱）+ 歌词 + 播放列表（覆盖到底部可滚动） */}
        <aside className={`flex min-h-0 flex-col border-l ${isDark ? 'border-white/10' : 'border-black/10'}`}>
          <div className="shrink-0 px-4 pt-4">
            <button type="button" onClick={() => loggedIn ? navigate({ name: 'profile' }) : onLoginClick(platform)} className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition hover:bg-white/10 ${surface}`}>
              {avatar ? <img src={avatar} alt="" className="h-10 w-10 rounded-full object-cover" /> : <div className="flex h-10 w-10 items-center justify-center rounded-full text-white" style={{ background: accent }}><Music2 className="h-5 w-5" /></div>}
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{loggedIn ? username || '我的账户' : '游客模式'}</span><span className={`mt-0.5 block text-xs ${muted}`}>{loggedIn ? `${platformLabel(platform)} · 个人音乐库` : '登录后同步收藏与歌单'}</span></span>
            </button>
          </div>

          <div className="shrink-0 px-4 pt-4">
            <section className={`rounded-2xl border p-4 ${surface}`}>
              <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">正在播放</h2><Heart className="h-4 w-4" style={{ color: songTheme }} /></div>
              {currentSong ? (
                <>
                  <div className="flex gap-3"><img src={coverOf(currentSong)} alt="" className="h-16 w-16 rounded-xl object-cover shadow-lg" /><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{currentSong.name}</div><div className={`mt-1 truncate text-xs ${muted}`}>{currentSong.artists?.map(a => a.name).join(' / ')}</div><div className={`mt-1 truncate text-[10px] ${muted}`}>{currentSong.album?.name || '未知专辑'}</div></div></div>
                  {preferences.showWaveform && (
                    <div className="relative mt-4 flex h-12 items-end justify-center gap-[3px] overflow-hidden rounded-xl" style={{ background: `${songTheme}12` }}>
                      {/* 底部辉光 */}
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6" style={{ background: `linear-gradient(to top, ${songTheme}30, transparent)` }} />
                      {spectrum.map((value, index) => {
                        const h = Math.max(10, Math.min(100, value * 100))
                        return (
                          <span
                            key={index}
                            className="relative z-10 w-[6px] rounded-full"
                            style={{
                              height: `${h}%`,
                              background: `linear-gradient(to top, ${songTheme}55, ${songTheme})`,
                              boxShadow: isPlaying ? `0 0 8px ${songTheme}66` : 'none',
                              opacity: isPlaying ? .95 : .35,
                              transition: 'height 90ms ease-out, opacity 200ms',
                            }}
                          />
                        )
                      })}
                    </div>
                  )}
                  <TraditionalProgressRow playbackTimeStore={playbackTimeStore} duration={duration} onSeek={onSeek} songTheme={songTheme} mutedText={muted} />
                  <div className="mt-3 flex items-center justify-center gap-5">
                    <button type="button" onClick={onPrevious} aria-label="上一首"><SkipBack className="h-4 w-4" /></button>
                    <button type="button" onClick={onPlayPause} className="flex h-11 w-11 items-center justify-center rounded-full text-white" style={{ background: songTheme }}>{isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}</button>
                    <button type="button" onClick={onNext} aria-label="下一首"><SkipForward className="h-4 w-4" /></button>
                    {/* 音量按钮：点击弹出音量条 */}
                    <div className="relative">
                      <button type="button" onClick={() => setVolumeOpen(value => !value)} aria-label="音量" className={`rounded-full p-2 transition ${volumeOpen ? 'bg-white/15' : 'hover:bg-white/10'}`} style={{ color: volumeOpen ? songTheme : undefined }}><Volume2 className="h-4 w-4" /></button>
                      <AnimatePresence>
                        {volumeOpen && (
                          <motion.div initial={{ opacity: 0, y: 6, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: .96 }} transition={{ duration: .14 }} className={`absolute bottom-full right-0 z-30 mb-2 flex w-32 flex-col items-center gap-1 rounded-xl border p-3 shadow-xl backdrop-blur-xl ${surface}`}>
                            <Volume2 className="h-4 w-4" style={{ color: songTheme }} />
                            <input aria-label="音量滑块" type="range" min={0} max={1} step={.01} value={volume} onChange={event => onVolumeChange(Number(event.target.value))} className="w-full" style={{ accentColor: songTheme }} />
                            <span className={`text-[10px] tabular-nums ${muted}`}>{Math.round(volume * 100)}%</span>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </>
              ) : <div className="py-7 text-center"><Music2 className="mx-auto h-8 w-8 opacity-30" /><p className={`mt-2 text-xs ${muted}`}>选择一首歌曲开始播放</p><button type="button" onClick={() => navigate({ name: 'search' })} className="mt-3 rounded-full px-3 py-1.5 text-xs text-white" style={{ background: accent }}>去搜索</button></div>}
            </section>
          </div>

          {/* 播放列表 / 同步歌词 共用一张卡片 */}
          <div className="min-h-0 flex-1 px-4 pb-4 pt-4">
            <section className={`flex h-full min-h-0 flex-col rounded-2xl border p-3 ${surface}`}>
              <div className="mb-2 flex shrink-0 items-center gap-1 rounded-xl border p-0.5" style={{ borderColor: isDark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.1)' }}>
                <button type="button" onClick={() => setRightTab('playlist')} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs transition" style={rightTab === 'playlist' ? { background: `${songTheme}26`, color: songTheme } : undefined}><ListMusic className="h-3.5 w-3.5" />播放列表{currentSong ? <span className={`ml-0.5 text-[9px] ${muted}`}>{queuedSongs.length}</span> : null}</button>
                {currentSong && <button type="button" onClick={() => setRightTab('lyrics')} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs transition" style={rightTab === 'lyrics' ? { background: `${songTheme}26`, color: songTheme } : undefined}><Waves className="h-3.5 w-3.5" />同步歌词</button>}
              </div>
              {rightTab === 'lyrics' && currentSong ? (
                <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-2">
                  {/* 与共享播放页一致的单行模式：避免 scroll 模式手动滚动/自动回位的抽风 */}
                  <TraditionalLiveLyrics playbackTimeStore={playbackTimeStore} isPlaying={isPlaying} accentColor={songTheme} lyrics={lyrics} displayMode="single" translationEnabled={false} romanEnabled={false} layoutContext="player" lyricSizeOverride={1.15} wordByWordEnabledOverride playerTheme={playerTheme} onSeek={onSeek} />
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
                  {queuedSongs.map((song, index) => { const active = currentSong && songKey(song) === songKey(currentSong); return <button type="button" key={`${songKey(song)}:${index}`} onClick={() => onSongSelect(song, queuedSongs, { mode: 'traditional', surface: 'mode-root', platform: song.platform || platform })} className={`flex w-full items-center gap-2 rounded-xl px-1.5 py-1.5 text-left transition ${active ? 'bg-white/10' : 'hover:bg-white/8'}`}><span className={`w-4 text-center text-[10px] ${muted}`}>{active && isPlaying ? <Waves className="h-3.5 w-3.5" style={{ color: songTheme }} /> : index + 1}</span><img src={coverOf(song)} alt="" loading="lazy" className="h-8 w-8 rounded-lg object-cover" /><span className="min-w-0 flex-1"><span className="block truncate text-xs">{song.name}</span><span className={`block truncate text-[10px] ${muted}`}>{song.artists?.map(a => a.name).join(' / ')}</span></span></button> })}
                  {queuedSongs.length === 0 && <p className={`px-2 py-5 text-center text-xs ${muted}`}>播放列表为空</p>}
                </div>
              )}
            </section>
          </div>
        </aside>
      </div>

      <AnimatePresence>{showSettings && <TraditionalSettings preferences={preferences} playerTheme={playerTheme} onChange={savePreferences} onGlobalSettings={() => { setShowSettings(false); onSettingsClick() }} onClose={() => setShowSettings(false)} />}</AnimatePresence>
      <SongContextMenu show={songMenu.show} x={songMenu.x} y={songMenu.y} song={songMenu.song} onClose={() => setSongMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, recommendationSongs, { mode: 'traditional', surface: 'mode-root', platform: song.platform || platform })} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onViewAlbum={song => song.album?.id && openAlbumDetail(String(song.album.id), song.platform || platform)} onViewArtist={song => song.artists?.[0]?.id && openArtistDetail(String(song.artists[0].id), song.platform || platform)} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={songMenu.song?.platform || platform} playerTheme={playerTheme} />
      <PlaylistContextMenu show={playlistMenu.show} x={playlistMenu.x} y={playlistMenu.y} playlist={playlistMenu.playlist} onClose={() => setPlaylistMenu({ show: false, x: 0, y: 0, playlist: null })} onEdit={() => undefined} onDelete={() => undefined} onSubscribe={handleSubscribePlaylist} onShare={playlist => {
        const targetPlatform = (playlist?.platform || platform) as MusicPlatform
        const url = targetPlatform === 'qq' ? `https://y.qq.com/n/ryqq/playlist/${playlist?.id || playlist?.dirId || ''}` : `https://music.163.com/#/playlist?id=${playlist?.id || ''}`
        void navigator.clipboard?.writeText(url)
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单链接已复制', type: 'success' } }))
      }} isOwner={false} isSubscribed={playlistSubscribed || Boolean(playlistMenu.playlist?.isCollected || playlistMenu.playlist?.subscribed)} isSpecialPlaylist={Boolean(playlistMenu.playlist?.isLike)} canEdit={false} />
      <style>{`@keyframes traditionalWave { from { transform: scaleY(.45); opacity: .45; } to { transform: scaleY(1.05); opacity: 1; } }`}</style>
    </div>
  )
}

// 首页内容：发现（排行榜 + 新歌 + 推荐歌单）
function HomeContent({ platform, accent, muted, surface, loggedIn, username, payload, heroSongs, onOpenSettings, onSongSelect, onSongMenu, onPlaylistMenu, onOpenPlaylist }: {
  platform: MusicPlatform; accent: string; isDark: boolean; muted: string; surface: string; loading: boolean; loggedIn: boolean; username: string; payload: ExplorePayload | null; recommendationSongs: Song[]; heroSongs: Song[]; preferences: TraditionalPreferences; onOpenSettings: () => void; onSongSelect: SongSelectHandler; onSongMenu: (menu: { show: boolean; x: number; y: number; song: Song | null }) => void; onPlaylistMenu: (menu: { show: boolean; x: number; y: number; playlist: any | null }) => void; onOpenPlaylist: (playlist: any) => void;
}) {
  // 发现页 = 探索向内容：排行榜 + 新歌 + 推荐歌单（个性化推荐在音乐库）
  const charts = (payload?.charts || []).slice(0, 4)
  const newSongs = (payload?.newSongs || []).slice(0, 8)
  const chartSongToSong = (chart: any, s: any): Song => ({ id: s.id || 0, mid: s.mid, name: s.name || '', artists: [{ name: s.artist || '' }], album: { name: '', picUrl: s.coverUrl || chart.coverUrl || '' }, duration: 0, platform: chart.platform || platform })
  return <><div className="mb-6 flex items-end justify-between"><div><p className={`text-xs uppercase tracking-[.2em] ${muted}`}>{platformLabel(platform)}</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">{username ? `欢迎回来，${username}` : '在音乐里，遇见更好的自己'}</h1><p className={`mt-2 text-sm ${muted}`}>{loggedIn ? '探索新歌与排行榜，个性推荐在音乐库' : '登录后解锁个性化推荐，游客也可以直接开始播放'}</p></div><button type="button" onClick={onOpenSettings} className={`rounded-xl border p-2 ${surface}`} aria-label="打开传统模式设置"><SlidersHorizontal className="h-4 w-4" /></button></div>
  <section className="relative mb-8 grid min-h-[190px] grid-cols-[minmax(0,1fr)_180px] overflow-hidden rounded-3xl border p-6" style={{ borderColor: `${accent}55`, background: `linear-gradient(125deg, ${accent}28, rgba(255,255,255,.05))` }}><div className="relative z-10 flex flex-col justify-between"><div><span className="rounded-full border px-2.5 py-1 text-[10px]" style={{ borderColor: `${accent}66`, color: accent }}>TRADITIONAL MODE</span><h2 className="mt-4 max-w-lg text-2xl font-semibold">发现好音乐，从排行榜开始</h2><p className={`mt-2 max-w-md text-sm ${muted}`}>新歌速递、热门榜单、精选歌单——探索永远不缺新意。</p></div><button type="button" onClick={() => heroSongs[0] && onSongSelect(heroSongs[0], heroSongs, { mode: 'traditional', surface: 'mode-root', platform })} className="mt-4 flex w-fit items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-white" style={{ background: accent }}><Play className="h-4 w-4" />播放推荐</button></div><div className="relative flex items-center justify-center"><div className="absolute h-36 w-36 rounded-full blur-3xl" style={{ background: accent, opacity: .3 }} />{heroSongs[0] ? <img src={coverOf(heroSongs[0])} alt="" className="relative h-32 w-32 rotate-3 rounded-2xl object-cover shadow-2xl" /> : <Sparkles className="relative h-16 w-16 opacity-50" />}</div></section>

  {charts.length > 0 && <section className="mb-8"><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">排行榜</h2><span className={`text-xs ${muted}`}>热门榜单实时更新</span></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
    {charts.map(chart => {
      const chartSongs = (chart.songs || []).map(s => chartSongToSong(chart, s))
      return (
        <div key={`${chart.id}:${chart.name}`} className={`overflow-hidden rounded-2xl border transition hover:-translate-y-1 ${surface}`}>
          <button type="button" onClick={() => chartSongs[0] && onSongSelect(chartSongs[0], chartSongs, { mode: 'traditional', surface: 'mode-root', platform: chart.platform || platform })} className="group relative block w-full text-left">
            <img src={chart.coverUrl || ''} alt="" loading="lazy" className="aspect-square w-full object-cover" />
            <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition group-hover:opacity-100"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-slate-900"><Play className="h-4 w-4 fill-current" /></span></span>
            <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white backdrop-blur">{chart.name}</span>
          </button>
          <div className="space-y-1 p-2">
            {chart.songs.slice(0, 3).map((s, index) => (
              <button key={`${s.id || s.mid || s.name}:${index}`} type="button" onClick={() => chartSongs[index] && onSongSelect(chartSongs[index], chartSongs, { mode: 'traditional', surface: 'mode-root', platform: chart.platform || platform })} className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-xs transition hover:bg-white/10">
                <span className={`w-4 text-center ${index === 0 ? 'font-bold' : muted}`} style={index === 0 ? { color: accent } : undefined}>{index + 1}</span>
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </button>
            ))}
          </div>
        </div>
      )
    })}
  </div></section>}

  {newSongs.length > 0 && <section className="mb-8"><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">新歌速递</h2><span className={`text-xs ${muted}`}>{newSongs.length} 首新歌</span></div><div className="grid grid-cols-2 gap-3 md:grid-cols-4">{newSongs.map(song => <button type="button" key={songKey(song)} onClick={() => onSongSelect(song, newSongs, { mode: 'traditional', surface: 'mode-root', platform: song.platform })} onContextMenu={event => { event.preventDefault(); onSongMenu({ show: true, x: event.clientX, y: event.clientY, song }) }} className={`group overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}><div className="relative aspect-square overflow-hidden rounded-xl"><img src={coverOf(song)} alt="" loading="lazy" className="h-full w-full object-cover transition duration-300 group-hover:scale-105" /><span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-900 opacity-0 shadow-lg transition group-hover:opacity-100"><Play className="h-4 w-4 fill-current" /></span></div><div className="mt-2 truncate text-sm">{song.name}</div><div className={`truncate text-xs ${muted}`}>{song.artists?.map(a => a.name).join(' / ')}</div></button>)}</div></section>}

  <section><div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">推荐歌单</h2><span className={`text-xs ${muted}`}>右键歌单可收藏或分享</span></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{(payload?.playlists || []).slice(0, 8).map(playlist => <button type="button" key={`${playlist.platform}:${playlist.id}`} onClick={() => onOpenPlaylist(playlist)} onContextMenu={event => { event.preventDefault(); onPlaylistMenu({ show: true, x: event.clientX, y: event.clientY, playlist }) }} className={`overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}><img src={playlist.coverUrl} alt="" loading="lazy" className="aspect-square w-full rounded-xl object-cover" /><div className="mt-2 truncate text-sm">{playlist.name}</div><div className={`text-xs ${muted}`}>{playlist.trackCount ? `${playlist.trackCount} 首` : '精选歌单'}</div></button>)}</div></section>
  </>}

// 个人中心页：账号信息 + 我的歌单（在中间栏展示，不使用全局弹层）
function ProfilePage({ platform, accent, isDark, loggedIn, username, avatar, userPlaylists, onOpenPlaylist, onOpenLiked, onLoginClick }: {
  platform: MusicPlatform; accent: string; isDark: boolean; loggedIn: boolean; username: string; avatar?: string; userPlaylists: any[]; onBack: () => void; onOpenPlaylist: (playlist: any) => void; onOpenLiked: () => void; onLoginClick: () => void;
}) {
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'
  const playlists = userPlaylists.filter(item => !item.isLike)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-center gap-3">
        <div><h1 className="text-xl font-semibold">个人中心</h1><p className={`text-xs ${muted}`}>{platformLabel(platform)}</p></div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loggedIn ? (
          <div className={`flex h-56 flex-col items-center justify-center gap-3 rounded-3xl border ${surface}`}>
            <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: `${accent}22` }}><Music2 className="h-6 w-6" style={{ color: accent }} /></div>
            <p className={`text-sm ${muted}`}>登录 {platformLabel(platform)} 后同步收藏与歌单</p>
            <button type="button" onClick={onLoginClick} className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white" style={{ background: accent }}><LogIn className="h-4 w-4" />立即登录</button>
          </div>
        ) : (
          <>
            <div className={`flex items-center gap-4 rounded-3xl border p-6 ${surface}`}>
              {avatar ? <img src={avatar} alt="" className="h-20 w-20 rounded-full object-cover" /> : <div className="flex h-20 w-20 items-center justify-center rounded-full text-2xl text-white" style={{ background: accent }}>{username.slice(0, 1)}</div>}
              <div className="min-w-0 flex-1"><h2 className="truncate text-2xl font-semibold">{username}</h2><p className={`mt-1 text-sm ${muted}`}>{platformLabel(platform)} 账号</p><button type="button" onClick={onOpenLiked} className="mt-3 flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs text-white" style={{ background: accent }}><Heart className="h-3.5 w-3.5 fill-current" />我喜欢的音乐</button></div>
            </div>
            <h3 className="mb-3 mt-7 text-lg font-semibold">我的歌单</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {playlists.map((playlist, index) => (
                <button key={`${playlist.platform || platform}:${playlist.id || playlist.dirId}:${index}`} type="button" onClick={() => onOpenPlaylist(playlist)} className={`overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}>
                  <img src={playlist.coverImgUrl || playlist.coverUrl || ''} alt="" className="aspect-square w-full rounded-xl object-cover" />
                  <div className="mt-2 truncate text-sm">{playlist.name}</div>
                  <div className={`truncate text-xs ${muted}`}>{playlist.trackCount ? `${playlist.trackCount} 首` : '歌单'}</div>
                </button>
              ))}
              {playlists.length === 0 && <div className={`col-span-full flex h-40 items-center justify-center rounded-3xl border ${surface}`}><p className={`text-sm ${muted}`}>还没有歌单</p></div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}


function TraditionalSettings({ preferences, playerTheme, onChange, onGlobalSettings, onClose }: { preferences: TraditionalPreferences; playerTheme: 'light' | 'dark'; onChange: (patch: Partial<TraditionalPreferences>) => void; onGlobalSettings: () => void; onClose: () => void }) {
  const dark = playerTheme === 'dark'
  return <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[180] bg-black/35 backdrop-blur-sm"><motion.aside initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 28, stiffness: 260 }} className={`absolute bottom-3 right-3 top-3 w-[min(420px,calc(100%_-_24px))] overflow-y-auto rounded-3xl border p-6 shadow-2xl ${dark ? 'border-white/10 bg-[#101522]/95 text-white' : 'border-black/10 bg-white/95 text-slate-900'}`}><div className="flex items-center justify-between"><div><div className="flex items-center gap-2 text-lg font-semibold"><Settings className="h-5 w-5" />传统模式设置</div><p className="mt-1 text-xs opacity-55">只影响传统模式的布局与氛围</p></div><button type="button" onClick={onClose} aria-label="关闭设置"><X className="h-5 w-5 opacity-60" /></button></div><div className="mt-6 space-y-5">
    <SettingChoice label="内容密度" value={preferences.density} options={[['comfortable', '舒适'], ['compact', '紧凑']]} onChange={value => onChange({ density: value as TraditionalPreferences['density'] })} dark={dark} />
    <SettingChoice label="背景氛围" value={preferences.background} options={[['aurora', '流光'], ['cover', '封面'], ['plain', '纯色']]} onChange={value => onChange({ background: value as TraditionalPreferences['background'] })} dark={dark} />
    <SliderSetting label={`背景模糊 ${preferences.backgroundBlur > 0 ? preferences.backgroundBlur + 'px' : ''}`} value={preferences.backgroundBlur} min={0} max={28} step={1} onChange={value => onChange({ backgroundBlur: value })} dark={dark} />
    <Toggle label="背景暗化" value={preferences.backgroundDim} onChange={value => onChange({ backgroundDim: value })} dark={dark} />
    <SettingChoice label="侧栏宽度" value={preferences.sidebarWidth} options={[['wide', '宽松'], ['narrow', '紧凑']]} onChange={value => onChange({ sidebarWidth: value as TraditionalPreferences['sidebarWidth'] })} dark={dark} />
    <Toggle label="显示推荐内容" value={preferences.showRecommendations} onChange={value => onChange({ showRecommendations: value })} dark={dark} />
    <Toggle label="显示播放频谱" value={preferences.showWaveform} onChange={value => onChange({ showWaveform: value })} dark={dark} />
    <button type="button" onClick={onGlobalSettings} className="flex w-full items-center justify-between rounded-2xl border border-pink-400/30 bg-pink-500/10 px-4 py-3 text-left text-sm"><span><span className="block font-medium">全局设置</span><span className="mt-1 block text-xs opacity-55">账号 / 个性化 / 高级 / 关于，与简约模式实时同步</span></span><ChevronRight className="h-4 w-4" /></button>
  </div></motion.aside></motion.div>
}

function SliderSetting({ label, value, min, max, step, onChange, dark }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; dark: boolean }) {
  return <div><div className="mb-2 flex items-center justify-between text-sm font-medium"><span>{label}</span></div><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} className="w-full" style={{ accentColor: dark ? '#ec4899' : '#db2777' }} /></div>
}

function SettingChoice({ label, value, options, onChange, dark }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void; dark: boolean }) { return <div><div className="mb-2 text-sm font-medium">{label}</div><div className="grid grid-cols-3 gap-2">{options.map(([key, labelText]) => <button type="button" key={key} onClick={() => onChange(key)} className={`rounded-xl border px-2 py-2 text-xs ${value === key ? 'border-pink-400 bg-pink-500 text-white' : dark ? 'border-white/10 bg-white/5 opacity-70' : 'border-black/10 bg-black/5 opacity-70'}`}>{labelText}</button>)}</div></div> }
function Toggle({ label, value, onChange, dark }: { label: string; value: boolean; onChange: (value: boolean) => void; dark: boolean }) { return <button type="button" onClick={() => onChange(!value)} className={`flex w-full items-center justify-between rounded-2xl border px-4 py-3 text-left text-sm ${dark ? 'border-white/10 bg-white/5' : 'border-black/10 bg-black/5'}`}><span>{label}</span><span className={`relative h-6 w-11 rounded-full ${value ? 'bg-pink-500' : dark ? 'bg-white/15' : 'bg-black/15'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${value ? 'left-[22px]' : 'left-0.5'}`} /></span></button> }

export default memo(TraditionalView)
