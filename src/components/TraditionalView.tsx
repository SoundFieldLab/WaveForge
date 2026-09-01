// 传统模式：独立的三栏式音乐播放界面。
// - 所有内容（搜索/音乐库/歌单/歌手/专辑/评论/个人中心）都在中间栏直接展示，不用弹窗；
// - 平台切换为可拖拽药丸（与简约模式一致）；模式切换走全局顶部下拉条；
// - 右栏：资料卡 + 正在播放（真实频谱）+ 歌词 + 播放列表（覆盖到底部，可滚动）。
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { PLATFORM_CHANGED_EVENT, readSyncedPlatform, syncPlatformAcrossViews } from '../services/platformSync'
import { AnimatePresence, animate, motion, useMotionValue } from 'framer-motion'
import {
  Captions, ChevronLeft, ChevronRight, Disc3, Heart, History, Home, Library, ListMusic, LogIn, Music2,
  Pause, Play, Plus, Repeat, Repeat1, Search, Settings, Shuffle, SkipBack, SkipForward, SlidersHorizontal,
  Sparkles, Volume2, Waves, Check,
} from 'lucide-react'
import AudioQualitySettingsModal from './AudioQualitySettingsModal'
import type { Song, LyricLine } from '../services/musicApi'
import { getProxiedImageUrl, getUserFollows, getUserFolloweds, getQQFollows, getQQFans, getQQUserProfile, subscribeQQUser, subscribeNeteaseUser } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getVisiblePlatforms, getPlatformCapabilities, getPlatformCookie, platformLabel, PLATFORM_ORDER_EVENT, PLATFORM_VISIBILITY_EVENT } from '../services/platforms'
import { fetchExploreHome, fetchExplorePlaylist, type ExplorePayload, type ExplorePlaylist } from '../services/exploreApi'
import { createPlaylist, getUserPlaylists, invalidateUserPlaylistsCache, subscribePlaylist } from '../services/playlistService'
import { getAppleRecentPlayed, appleLibraryTrackToSong } from '../services/appleCatalog'
import { fetchSpotifyLiked, spotifyTrackToSong } from '../services/spotifyService'
import { useAudioAnalyzer, useAudioAnalyzerSnapshot, type AudioAnalyzerStore } from '../hooks/useAudioAnalyzer'
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
import { MirroredGlobalSettings, PlatformOrderEditor, makeSkin } from './MirroredGlobalSettings'
import { GLOBAL_SETTINGS_GROUPS, isEntryVisible, useGlobalSettings, type GlobalSettingsGroupId, type MirrorActionId } from '../services/globalSettingsRegistry'
import { preloadOnIdle } from '../utils/lazyPreload'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { PlaybackOrigin, SongSelectHandler, ViewMode } from '../types/playbackNavigation'

// 设置页用的共享弹窗（按需加载，只有用户在设置里点开时才拉取代码）
const LazyCacheClearModal = lazy(() => import('./CacheClearModal'))
const LazyRemoteSettingsModal = lazy(() => import('./RemoteControlSettingsModal'))

// 组件挂载后：空闲时预热设置页弹窗 chunk，消除首次点击的卡顿
const warmSettingsChunks = () => preloadOnIdle([
  () => import('./CacheClearModal'),
  () => import('./RemoteControlSettingsModal'),
])

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
  /** 播放引擎的频谱分析节点：右栏「正在播放」频谱直接采样（与播放页波形同源） */
  analyserNode?: AnalyserNode | null
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
  /** 当前歌曲是否已喜欢 + 切换（右栏心形按钮） */
  liked?: boolean
  onToggleFavorite?: () => void
  /** 播放模式（顺序/随机/单曲循环） */
  playMode?: 'sequential' | 'shuffle' | 'repeat'
  onPlayModeChange?: () => void
  /** 打开调音室（音效引擎 UI） */
  onOpenMixingStudio?: () => void
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

// 进度条行包装：内部订阅播放时间（4Hz），传统视图本体不再因 currentTime 每秒重渲染。
// 纯进度条（无圆点滑块）：点击/拖动轨道任意位置 seek。
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
  const barRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)
  const t = Math.min(duration || 1, currentTime)
  const pct = duration > 0 ? Math.min(100, (t / duration) * 100) : 0
  const seekFromPointer = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || !duration) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onSeek(ratio * duration)
  }
  return (
    <div className="mt-3">
      <div
        ref={barRef}
        role="slider"
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration || 0)}
        aria-valuenow={Math.round(t)}
        className="group relative h-4 w-full cursor-pointer touch-none select-none"
        onPointerDown={event => { draggingRef.current = true; event.currentTarget.setPointerCapture(event.pointerId); seekFromPointer(event.clientX) }}
        onPointerMove={event => { if (draggingRef.current) seekFromPointer(event.clientX) }}
        onPointerUp={event => { draggingRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
        onPointerCancel={event => { draggingRef.current = false; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full transition-all group-hover:h-1.5" style={{ background: 'rgba(128,128,128,.28)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: songTheme }} />
        </div>
      </div>
      <div className={`mt-1 flex justify-between text-[10px] ${mutedText}`}>
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  )
})

// 频谱叶子组件：直接订阅音频分析器 store（与播放页波形同源，30fps），
// 传统视图本体不因此重渲染。取 24 段对数频谱插值出 18 根柱渲染。
const TraditionalSpectrum = memo(function TraditionalSpectrum({
  analyzerStore,
  isPlaying,
  songTheme,
}: {
  analyzerStore: AudioAnalyzerStore
  isPlaying: boolean
  songTheme: string
}) {
  const { spectrum } = useAudioAnalyzerSnapshot(analyzerStore)
  const BARS = 18
  return (
    <div className="relative mt-4 flex h-12 items-end justify-center gap-[3px] overflow-hidden rounded-xl" style={{ background: `${songTheme}12` }}>
      {/* 底部辉光 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6" style={{ background: `linear-gradient(to top, ${songTheme}30, transparent)` }} />
      {Array.from({ length: BARS }, (_, index) => {
        const pos = spectrum.length > 1 ? (index / (BARS - 1)) * (spectrum.length - 1) : 0
        const left = Math.floor(pos)
        const right = Math.min(spectrum.length - 1, left + 1)
        const value = (spectrum[left] || 0) * (1 - (pos - left)) + (spectrum[right] || 0) * (pos - left)
        const h = Math.max(8, Math.min(100, value * 100))
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
  )
})

// 传统模式右栏专用竖排同步歌词：不复用播放页 LyricsDisplay，播放页歌词不受影响。
// 竖写（writing-mode: vertical-rl）+ 字号随容器高度自适应，保证整行完整显示不裁切；
// 排版：当前行居中大字、下一行在左侧淡色小字，行距/字距按竖排阅读节奏设定。
const TraditionalVerticalLyrics = memo(function TraditionalVerticalLyrics({
  playbackTimeStore,
  lyrics,
  accentColor,
  mutedText,
}: {
  playbackTimeStore: PlaybackTimeStore
  lyrics: LyricLine[]
  accentColor: string
  mutedText: string
}) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxHeight, setBoxHeight] = useState(0)
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) setBoxHeight(entry.contentRect.height)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // 定位当前行：最后一个 time <= currentTime 的行
  let currentIndex = -1
  for (let i = 0; i < lyrics.length; i += 1) {
    const line = lyrics[i]
    if (typeof line?.time === 'number' && line.time <= currentTime) currentIndex = i
    else if (typeof line?.time === 'number' && line.time > currentTime) break
  }
  const currentLine = currentIndex >= 0 ? lyrics[currentIndex] : null
  const nextLine = currentIndex >= 0 && currentIndex + 1 < lyrics.length ? lyrics[currentIndex + 1] : null
  const currentText = currentLine?.text?.trim() || ''
  const nextText = nextLine?.text?.trim() || ''

  // 字号自适应：竖排一行高度 ≈ 字数 × 字号 × (1 + 字距)，反推字号并钳制在合理区间
  const charCount = Math.max(1, Array.from(currentText).length)
  const fitSize = boxHeight > 0 ? Math.floor((boxHeight * 0.86) / (charCount * 1.18)) : 20
  const fontSize = Math.max(14, Math.min(34, fitSize))

  return (
    <div ref={boxRef} className="flex min-h-0 w-full flex-1 items-center justify-center gap-5 overflow-hidden px-2">
      {!currentText ? (
        <p className={`text-xs ${mutedText}`}>暂无同步歌词</p>
      ) : (
        <>
          {/* 当前行：竖写大字，主题色强调 */}
          <motion.p
            key={`cur:${currentIndex}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: .35, ease: 'easeOut' }}
            className="max-h-full font-medium"
            style={{
              writingMode: 'vertical-rl',
              fontSize,
              letterSpacing: '0.18em',
              color: accentColor,
              textShadow: `0 0 18px ${accentColor}55`,
            }}
          >
            {currentText}
          </motion.p>
          {/* 下一行：竖写小字淡色，形成竖排阅读节奏 */}
          {nextText && (
            <p
              className={`max-h-full ${mutedText}`}
              style={{ writingMode: 'vertical-rl', fontSize: Math.max(11, Math.round(fontSize * 0.55)), letterSpacing: '0.14em', opacity: .55 }}
            >
              {nextText}
            </p>
          )}
        </>
      )}
    </div>
  )
})

// 传统模式中间栏页面：一切内容都在中间栏展示，不复用全局弹窗
type TraditionalPage =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'library' }
  | { name: 'recent' }
  | { name: 'settings' }
  | { name: 'profile'; userId?: string; nickname?: string; avatarUrl?: string }
  | { name: 'playlist'; playlist: any; songs: Song[] }
  | { name: 'comments'; song: Song }
  | { name: 'artist'; id: string; platform: MusicPlatform }
  | { name: 'album'; id: string; platform: MusicPlatform }

function TraditionalView({
  onSongSelect, currentSong, queue, isPlaying, playbackTimeStore, duration, lyrics, volume, playerTheme, dominantColor, analyserNode,
  neteaseLoggedIn, neteaseUsername, neteaseAvatar, neteaseUserId,
  qqLoggedIn, qqUsername, qqAvatar, qqUserId,
  appleLoggedIn, appleUsername, appleAvatar, spotifyUsername, spotifyAvatar,
  kugouUsername, kugouAvatar, sodaUsername, sodaAvatar, authRevision = 0,
  onLoginClick, onPlayPause, onNext, onPrevious, onSeek, onVolumeChange,
  liked = false, onToggleFavorite, playMode = 'sequential', onPlayModeChange, onOpenMixingStudio,
  neteaseVip = false, qqVip = false,
  onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onCopyInfo,
}: TraditionalViewProps) {
  const [platform, setPlatform] = useState<MusicPlatform>(() => readSyncedPlatform(getVisiblePlatforms(), 'traditionalPlatform'))
  const [visiblePlatforms, setVisiblePlatforms] = useState<MusicPlatform[]>(() => getVisiblePlatforms())
  // 平台顺序 / 显隐是全软件共享的（简约模式账号页、各模式设置里都能改）：订阅事件保持顶部药丸实时同步
  useEffect(() => {
    const sync = () => setVisiblePlatforms(getVisiblePlatforms())
    window.addEventListener(PLATFORM_ORDER_EVENT, sync)
    window.addEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    return () => {
      window.removeEventListener(PLATFORM_ORDER_EVENT, sync)
      window.removeEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    }
  }, [])
  useEffect(() => {
    const onPlatformChanged = (event: Event) => {
      const next = (event as CustomEvent<MusicPlatform>).detail
      if (next && getVisiblePlatforms().includes(next)) setPlatform(next)
    }
    window.addEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
    return () => window.removeEventListener(PLATFORM_CHANGED_EVENT, onPlatformChanged)
  }, [])

  // 空闲时预热设置弹窗 chunk
  useEffect(() => warmSettingsChunks(), [])
  const [payload, setPayload] = useState<ExplorePayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
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
  // 右栏频谱：直接采样播放引擎 analyser（与播放页波形同源），不再走桌面频谱事件总线
  const analyzerStore = useAudioAnalyzer(analyserNode ?? null, !tvMode && preferences.showWaveform)
  // 右栏：播放列表 / 同步歌词 共用一张卡片，点击切换；未播放时无歌词，只显示播放列表
  const [rightTab, setRightTab] = useState<'playlist' | 'lyrics'>('playlist')
  // 音量弹层（代替常驻滑条）
  const [volumeOpen, setVolumeOpen] = useState(false)
  // 音质弹窗
  const [showQuality, setShowQuality] = useState(false)
  // 桌面歌词开关（与主进程广播同步，网易云「词」按钮同语义）
  const [desktopLyricsOn, setDesktopLyricsOn] = useState(false)
  useEffect(() => {
    let active = true
    window.electron?.desktopLyrics?.getSettings?.().then(settings => { if (active) setDesktopLyricsOn(Boolean(settings?.enabled)) }).catch(() => undefined)
    const sync = (event: Event) => setDesktopLyricsOn(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('desktopLyricsEnabledChanged', sync)
    return () => { active = false; window.removeEventListener('desktopLyricsEnabledChanged', sync) }
  }, [])
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
    if (!visiblePlatforms.includes(platform)) setPlatform(visiblePlatforms[0] || 'netease')
  }, [platform, visiblePlatforms])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPayload(null)
    void fetchExploreHome(platform).then(next => { if (!cancelled) setPayload(next) }).catch(() => { if (!cancelled) setPayload(null) }).finally(() => { if (!cancelled) setLoading(false) })
    syncPlatformAcrossViews(platform)
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

  // 未播放（无歌词）时自动切回播放列表 tab
  useEffect(() => {
    if (!currentSong && rightTab === 'lyrics') setRightTab('playlist')
  }, [currentSong, rightTab])

  const savePreferences = useCallback((patch: Partial<TraditionalPreferences>) => {
    setPreferences(prev => { const next = { ...prev, ...patch }; localStorage.setItem(PREF_KEY, JSON.stringify(next)); window.dispatchEvent(new CustomEvent('traditionalPreferencesChanged', { detail: next })); return next })
  }, [])

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

      {/* 顶栏加高（h-20）+ 内容下沉：隐藏 Windows 标题栏的拖拽区占顶部 32px，控件整体下移避免「一半在标题栏上」 */}
      <header className="relative z-30 flex h-20 items-end gap-3 border-b px-4 pb-2.5 backdrop-blur-xl" style={{ borderColor: isDark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.1)' }}>
        {/* 平台药丸（左上角，拖拽切换） */}
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
        <div className="min-w-0 flex-1" />
        {/* 右上角：Logo + 软件名（品牌标识，非交互；个人中心入口在右栏资料卡，避免与右上角隐藏窗口按钮抢点击） */}
        <div className="flex shrink-0 items-center gap-2">
          <img src={new URL('../../logo.png', import.meta.url).href} alt="WaveForge" className="h-9 w-9 rounded-xl object-cover" />
          <span className="hidden text-base font-semibold sm:inline">WaveForge</span>
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

      <div className="relative z-10 grid h-[calc(100%_-_5rem)] min-h-0" style={{ gridTemplateColumns: preferences.sidebarWidth === 'wide' ? '220px minmax(0,1fr) 320px' : '176px minmax(0,1fr) 300px' }}>
        {/* 左栏：导航 + 我的歌单 / 收藏歌单 */}
        <aside className={`flex min-h-0 flex-col border-r px-3 py-5 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
          <nav className="space-y-1">
            <button type="button" onClick={() => navigate({ name: 'home' })} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm" style={{ background: currentPage.name === 'home' ? `${accent}2e` : undefined, color: currentPage.name === 'home' ? accent : undefined }}><Home className="h-4 w-4" />发现</button>
            <button type="button" onClick={openLibrary} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${currentPage.name === 'library' ? '' : muted} hover:bg-white/10`} style={currentPage.name === 'library' ? { color: accent } : undefined}><Library className="h-4 w-4" />音乐库</button>
            <button type="button" onClick={openLikedSongs} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${muted} hover:bg-white/10`}><Heart className="h-4 w-4" />我喜欢</button>
            <button type="button" onClick={() => navigate({ name: 'recent' })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${currentPage.name === 'recent' ? '' : muted} hover:bg-white/10`} style={currentPage.name === 'recent' ? { color: accent } : undefined}><History className="h-4 w-4" />最近播放</button>
            <button type="button" onClick={() => navigate({ name: 'search' })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${currentPage.name === 'search' ? '' : muted} hover:bg-white/10`} style={currentPage.name === 'search' ? { color: accent } : undefined}><Search className="h-4 w-4" />搜索</button>
            <button type="button" onClick={() => navigate({ name: 'settings' })} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm ${currentPage.name === 'settings' ? '' : muted} hover:bg-white/10`} style={currentPage.name === 'settings' ? { color: accent } : undefined}><Settings className="h-4 w-4" />设置</button>
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
          ) : currentPage.name === 'recent' ? (
            <TraditionalRecent platform={platform} accent={accent} isDark={isDark} loggedIn={loggedIn} currentSong={currentSong} authRevision={authRevision} onBack={goBack} onSongSelect={onSongSelect} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onCopyInfo={onCopyInfo} onLoginClick={() => onLoginClick(platform)} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'settings' ? (
            <TraditionalSettingsPage preferences={preferences} playerTheme={playerTheme} onChange={savePreferences} onOpenQuality={() => setShowQuality(true)} />
          ) : currentPage.name === 'library' ? (
            <TraditionalLibrary platform={platform} accent={accent} isDark={isDark} loggedIn={loggedIn} username={username} loading={loading} payload={payload} recommendationSongs={recommendationSongs} onBack={goBack} onSongSelect={onSongSelect} onOpenPlaylist={openPlaylist} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} />
          ) : currentPage.name === 'profile' ? (
            <TraditionalProfile platform={platform} accent={accent} isDark={isDark} loggedIn={loggedIn} username={username} avatar={avatar} selfUserId={platform === 'netease' ? (neteaseUserId || '') : platform === 'qq' ? (qqUserId || '') : ''} targetUserId={currentPage.userId} targetNickname={currentPage.nickname} targetAvatar={currentPage.avatarUrl} userPlaylists={userPlaylists} onBack={goBack} onOpenPlaylist={openPlaylist} onOpenLiked={openLikedSongs} onOpenUserProfile={(userId, nickname, avatarUrl) => navigate({ name: 'profile', userId, nickname, avatarUrl })} onOpenArtist={openArtistDetail} onLoginClick={() => onLoginClick(platform)} />
          ) : currentPage.name === 'playlist' ? (
            <TraditionalPlaylistDetail playlist={currentPage.playlist} songs={currentPage.songs} loading={playlistLoading} currentSong={currentSong} playerTheme={playerTheme} accentColor={accent} onClose={goBack} onSongSelect={(song, songs) => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-playlist', platform: song.platform || platform })} onOpenArtist={openArtistDetail} onOpenAlbum={openAlbumDetail} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} ownUserName={loggedIn ? username : ''} ownUserAvatar={avatar} ownUserId={platform === 'netease' ? (neteaseUserId || '') : platform === 'qq' ? (qqUserId || '') : ''} onOpenUserProfile={(targetPlatform, userId, nickname, avatarUrl) => { if (targetPlatform === platform) navigate({ name: 'profile', userId, nickname, avatarUrl }) }} />
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
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold">正在播放</h2>
                <button type="button" onClick={onToggleFavorite} disabled={!onToggleFavorite} aria-label={liked ? '取消喜欢' : '喜欢'} className="rounded-full p-1 transition hover:scale-110 disabled:opacity-40">
                  <Heart className={`h-4 w-4 ${liked ? 'fill-current' : ''}`} style={{ color: liked ? '#ef4444' : songTheme }} />
                </button>
              </div>
              {currentSong ? (
                <>
                  {/* 点击歌曲信息进入播放页（传统模式选歌原地播放，播放页入口在此） */}
                  <button type="button" onClick={() => switchMode('minimal')} title="进入播放页" className="flex w-full gap-3 rounded-xl text-left transition hover:bg-white/5">
                    <img src={coverOf(currentSong)} alt="" className="h-16 w-16 rounded-xl object-cover shadow-lg" />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{currentSong.name}</span><span className={`mt-1 block truncate text-xs ${muted}`}>{currentSong.artists?.map(a => a.name).join(' / ')}</span><span className={`mt-1 block truncate text-[10px] ${muted}`}>{currentSong.album?.name || '未知专辑'}</span></span>
                  </button>
                  {preferences.showWaveform && (
                    <TraditionalSpectrum analyzerStore={analyzerStore} isPlaying={isPlaying} songTheme={songTheme} />
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
                  {/* 播控工具行：播放模式 / 音效 / 音质 / 桌面歌词（对齐网易云底栏右侧能力） */}
                  <div className={`mt-2 flex items-center justify-center gap-1 ${muted}`}>
                    <button type="button" onClick={onPlayModeChange} title={playMode === 'shuffle' ? '随机播放' : playMode === 'repeat' ? '单曲循环' : '顺序播放'} aria-label="播放模式" className="rounded-xl p-2 transition hover:bg-white/10">
                      {playMode === 'shuffle' ? <Shuffle className="h-4 w-4" style={{ color: songTheme }} /> : playMode === 'repeat' ? <Repeat1 className="h-4 w-4" style={{ color: songTheme }} /> : <Repeat className="h-4 w-4" />}
                    </button>
                    {onOpenMixingStudio && <button type="button" onClick={onOpenMixingStudio} title="音效 / 调音室" aria-label="音效" className="rounded-xl p-2 transition hover:bg-white/10"><SlidersHorizontal className="h-4 w-4" /></button>}
                    <button type="button" onClick={() => setShowQuality(true)} title="播放音质" aria-label="播放音质" className="rounded-xl p-2 transition hover:bg-white/10"><Disc3 className="h-4 w-4" /></button>
                    <button type="button" onClick={() => window.electron?.desktopLyrics?.setEnabled?.(!desktopLyricsOn)} title="桌面歌词" aria-label="桌面歌词" className="rounded-xl p-2 transition hover:bg-white/10" style={desktopLyricsOn ? { color: songTheme } : undefined}><Captions className="h-4 w-4" /></button>
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
                <TraditionalVerticalLyrics playbackTimeStore={playbackTimeStore} lyrics={lyrics} accentColor={songTheme} mutedText={muted} />
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

      <SongContextMenu show={songMenu.show} x={songMenu.x} y={songMenu.y} song={songMenu.song} onClose={() => setSongMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, recommendationSongs, { mode: 'traditional', surface: 'mode-root', platform: song.platform || platform })} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={openCommentsFor} onViewAlbum={song => song.album?.id && openAlbumDetail(String(song.album.id), song.platform || platform)} onViewArtist={song => song.artists?.[0]?.id && openArtistDetail(String(song.artists[0].id), song.platform || platform)} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={songMenu.song?.platform || platform} playerTheme={playerTheme} />
      <PlaylistContextMenu show={playlistMenu.show} x={playlistMenu.x} y={playlistMenu.y} playlist={playlistMenu.playlist} onClose={() => setPlaylistMenu({ show: false, x: 0, y: 0, playlist: null })} onEdit={() => undefined} onDelete={() => undefined} onSubscribe={handleSubscribePlaylist} onShare={playlist => {
        const targetPlatform = (playlist?.platform || platform) as MusicPlatform
        const url = targetPlatform === 'qq' ? `https://y.qq.com/n/ryqq/playlist/${playlist?.id || playlist?.dirId || ''}` : `https://music.163.com/#/playlist?id=${playlist?.id || ''}`
        void navigator.clipboard?.writeText(url)
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单链接已复制', type: 'success' } }))
      }} isOwner={false} isSubscribed={playlistSubscribed || Boolean(playlistMenu.playlist?.isCollected || playlistMenu.playlist?.subscribed)} isSpecialPlaylist={Boolean(playlistMenu.playlist?.isLike)} canEdit={false} />
      <AudioQualitySettingsModal show={showQuality} onClose={() => setShowQuality(false)} playerTheme={playerTheme} neteaseVip={neteaseVip} qqVip={qqVip} neteaseLoggedIn={neteaseLoggedIn} qqLoggedIn={qqLoggedIn} />
      <style>{`@keyframes traditionalWave { from { transform: scaleY(.45); opacity: .45; } to { transform: scaleY(1.05); opacity: 1; } }`}</style>
    </div>
  )
}

// 首页内容：发现（排行榜 + 新歌 + 推荐歌单）
function HomeContent({ platform, accent, muted, surface, loggedIn, username, payload, heroSongs, onSongSelect, onSongMenu, onPlaylistMenu, onOpenPlaylist }: {
  platform: MusicPlatform; accent: string; isDark: boolean; muted: string; surface: string; loading: boolean; loggedIn: boolean; username: string; payload: ExplorePayload | null; recommendationSongs: Song[]; heroSongs: Song[]; preferences: TraditionalPreferences; onSongSelect: SongSelectHandler; onSongMenu: (menu: { show: boolean; x: number; y: number; song: Song | null }) => void; onPlaylistMenu: (menu: { show: boolean; x: number; y: number; playlist: any | null }) => void; onOpenPlaylist: (playlist: any) => void;
}) {
  // 发现页 = 探索向内容：排行榜 + 新歌 + 推荐歌单（个性化推荐在音乐库）
  const charts = (payload?.charts || []).slice(0, 4)
  const newSongs = (payload?.newSongs || []).slice(0, 8)
  const chartSongToSong = (chart: any, s: any): Song => ({ id: s.id || 0, mid: s.mid, name: s.name || '', artists: [{ name: s.artist || '' }], album: { name: '', picUrl: s.coverUrl || chart.coverUrl || '' }, duration: 0, platform: chart.platform || platform })
  return <><div className="mb-6"><p className={`text-xs uppercase tracking-[.2em] ${muted}`}>{platformLabel(platform)}</p><h1 className="mt-1 text-3xl font-semibold tracking-tight">{username ? `欢迎回来，${username}` : '在音乐里，遇见更好的自己'}</h1><p className={`mt-2 text-sm ${muted}`}>{loggedIn ? '探索新歌与排行榜，个性推荐在音乐库' : '登录后解锁个性化推荐，游客也可以直接开始播放'}</p></div>
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

type TraditionalProfileSocialItem = {
  id: string
  name: string
  avatarUrl: string
  desc?: string
  isFollow: boolean
  kind: 'user' | 'artist'
  artistMid?: string
}

// 个人中心页：对齐 QQ 音乐/网易云个人中心（大头像 + 徽章 + 简介 + 粉丝/关注 + 我喜欢/创建的歌单），
// 支持查看他人（歌单创建者点击进来）；粉丝/关注页带 歌手/用户 分类与关注操作。
function TraditionalProfile({ platform, accent, isDark, loggedIn, username, avatar, selfUserId, targetUserId, targetNickname, targetAvatar, userPlaylists, onOpenPlaylist, onOpenLiked, onOpenUserProfile, onOpenArtist, onLoginClick }: {
  platform: MusicPlatform; accent: string; isDark: boolean; loggedIn: boolean; username: string; avatar?: string; selfUserId: string; targetUserId?: string; targetNickname?: string; targetAvatar?: string; userPlaylists: any[]; onBack: () => void; onOpenPlaylist: (playlist: any) => void; onOpenLiked: () => void; onOpenUserProfile: (userId: string, nickname?: string, avatarUrl?: string) => void; onOpenArtist?: (artistId: string, platform: MusicPlatform) => void; onLoginClick: () => void;
}) {
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'
  const isSelf = !targetUserId || targetUserId === selfUserId
  const uid = targetUserId || selfUserId
  const [detail, setDetail] = useState<{ nickname: string; avatarUrl: string; signature?: string; follows?: number; fans?: number; vip?: boolean } | null>(null)
  const [tab, setTab] = useState<'liked' | 'created'>('liked')
  const [social, setSocial] = useState<{ kind: 'follows' | 'fans' } | null>(null)
  const [qqSocialTab, setQqSocialTab] = useState<'artist' | 'user'>('artist')
  const [socialItems, setSocialItems] = useState<TraditionalProfileSocialItem[]>([])
  const [socialLoading, setSocialLoading] = useState(false)
  const [otherPlaylists, setOtherPlaylists] = useState<any[] | null>(null)

  // 用户详情：昵称/头像/简介/粉丝/关注/徽章
  useEffect(() => {
    let cancelled = false
    const fallback = { nickname: isSelf ? username : (targetNickname || ''), avatarUrl: (isSelf ? avatar : targetAvatar) || '', signature: '' }
    if (!uid) { setDetail(fallback); return }
    if (platform === 'netease') {
      fetch(`http://localhost:3001/api/netease/user/detail?uid=${encodeURIComponent(uid)}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          const p = data?.profile || {}
          setDetail({ nickname: p.nickname || fallback.nickname, avatarUrl: p.avatarUrl || fallback.avatarUrl, signature: p.signature || '', follows: Number(p.follows || 0), fans: Number(p.followeds || 0), vip: Number(p.vipType || 0) > 0 })
        })
        .catch(() => { if (!cancelled) setDetail(fallback) })
    } else if (platform === 'qq') {
      const cookie = getPlatformCookie('qq')
      fetch(`http://localhost:3001/api/qq/user/detail?id=${encodeURIComponent(uid)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          const c = data?.creator || {}
          setDetail({ nickname: c.nick || fallback.nickname, avatarUrl: c.avatar || fallback.avatarUrl, signature: c.desc || '', follows: Number(c.nums?.followsingernum ?? 0), fans: Number(c.nums?.fansnum || 0), vip: Boolean(c.vip) })
        })
        .catch(() => { if (!cancelled) setDetail(fallback) })
    } else {
      setDetail(fallback)
    }
    return () => { cancelled = true }
  }, [platform, uid, isSelf, username, avatar, targetNickname, targetAvatar])

  // 他人的创建歌单
  useEffect(() => {
    if (isSelf || !uid) { setOtherPlaylists(null); return }
    let cancelled = false
    if (platform === 'netease') {
      const cookie = getPlatformCookie('netease')
      fetch(`http://localhost:3001/api/netease/user/playlist?uid=${encodeURIComponent(uid)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          const list = Array.isArray(data?.playlist) ? data.playlist : []
          setOtherPlaylists(list.map((p: any) => ({ id: p.id || p.playlistId, name: p.name || '歌单', coverImgUrl: p.coverImgUrl || '', trackCount: Number(p.trackCount || 0), platform, isLike: p.specialType === 5 || /我喜欢的音乐/.test(p.name || '') })))
        })
        .catch(() => { if (!cancelled) setOtherPlaylists([]) })
    } else if (platform === 'qq') {
      const cookie = getPlatformCookie('qq')
      fetch(`http://localhost:3001/api/qq/user/playlist?id=${encodeURIComponent(uid)}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          if (cancelled) return
          const list = data?.list || data?.data?.list || data?.mydiss?.list || data?.data?.mydiss?.list || []
          setOtherPlaylists((Array.isArray(list) ? list : []).map((p: any) => ({ id: p.tid || p.dissid || p.disstid, name: p.diss_name || p.title || p.dissname || '歌单', coverImgUrl: p.diss_cover || p.picurl || p.logo || '', trackCount: Number(p.song_cnt || p.songnum || 0), platform, isLike: Number(p.dirid) === 201 || Number(p.tid) === 0 })))
        })
        .catch(() => { if (!cancelled) setOtherPlaylists([]) })
    } else {
      setOtherPlaylists([])
    }
    return () => { cancelled = true }
  }, [platform, uid, isSelf])

  // 粉丝 / 关注 列表
  useEffect(() => {
    if (!social) { setSocialItems([]); return }
    let cancelled = false
    setSocialLoading(true)
    const cookie = getPlatformCookie(platform)
    if (platform === 'netease') {
      const task = social.kind === 'follows' ? getUserFollows(uid, { cookie }) : getUserFolloweds(uid, { cookie })
      task.then(data => {
        if (cancelled) return
        const raw = social.kind === 'follows' ? data?.follow : data?.followeds
        setSocialItems((Array.isArray(raw) ? raw : []).map((u: any) => ({ id: String(u.userId || u.id || ''), name: u.nickname || '未知用户', avatarUrl: u.avatarUrl || '', desc: u.signature || '', isFollow: social.kind === 'follows' ? true : Boolean(u.mutual), kind: 'user' as const })))
        setSocialLoading(false)
      }).catch(() => { if (!cancelled) { setSocialItems([]); setSocialLoading(false) } })
    } else if (platform === 'qq') {
      const task = isSelf
        ? (social.kind === 'follows' ? getQQFollows({ cookie }) : getQQFans({ cookie }))
        : getQQUserProfile(uid)
      task.then(data => {
        if (cancelled) return
        const list = isSelf ? (data?.data?.list || []) : ((social.kind === 'follows' ? data?.data?.follows : data?.data?.fans) || [])
        setSocialItems((Array.isArray(list) ? list : []).map((u: any) => {
          const mid = String(u.MID || u.mid || '')
          return { id: String(u.EncUin || u.encUin || mid || ''), name: u.Name || u.name || '未知用户', avatarUrl: u.AvatarUrl || u.avatarUrl || '', desc: u.Desc || u.desc || '', isFollow: Boolean(u.IsFollow || u.isFollow), kind: (mid ? 'artist' : 'user') as 'artist' | 'user', artistMid: mid || undefined }
        }))
        setSocialLoading(false)
      }).catch(() => { if (!cancelled) { setSocialItems([]); setSocialLoading(false) } })
    } else {
      setSocialItems([])
      setSocialLoading(false)
    }
    return () => { cancelled = true }
  }, [social, platform, uid, isSelf])

  const toggleFollow = async (item: TraditionalProfileSocialItem) => {
    if (item.kind === 'artist') {
      if (item.artistMid) onOpenArtist?.(item.artistMid, platform)
      return
    }
    try {
      if (platform === 'netease') await subscribeNeteaseUser(item.id, !item.isFollow)
      else await subscribeQQUser(item.id, !item.isFollow)
      setSocialItems(prev => prev.map(p => (p.id === item.id ? { ...p, isFollow: !item.isFollow } : p)))
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: item.isFollow ? '已取消关注' : '关注成功', type: 'success' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '关注操作失败', type: 'error' } }))
    }
  }

  const ownCreated = userPlaylists.filter(item => !item.isLike && !item.isCollected)
  const otherCreated = (otherPlaylists || []).filter(item => !item.isLike)
  const createdPlaylists = isSelf ? ownCreated : otherCreated
  const likedPlaylist = (isSelf ? userPlaylists : (otherPlaylists || [])).find(item => item.isLike)
  const shownSocialItems = platform === 'qq' ? socialItems.filter(item => item.kind === qqSocialTab) : socialItems
  const artistCount = socialItems.filter(item => item.kind === 'artist').length
  const userCount = socialItems.filter(item => item.kind === 'user').length

  // ── 粉丝 / 关注 页 ──
  if (social) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="mb-5 flex items-center gap-4">
          <button type="button" onClick={() => setSocial(null)} className={`rounded-xl p-2 transition hover:bg-white/10 ${muted}`} aria-label="返回个人中心"><ChevronLeft className="h-5 w-5" /></button>
          <h1 className="text-2xl font-bold">{detail?.nickname || username}的{social.kind === 'follows' ? '关注' : '粉丝'}</h1>
        </div>
        {platform === 'qq' && (
          <div className="mb-5 flex gap-6 text-sm">
            <button type="button" onClick={() => setQqSocialTab('artist')} className={`pb-2 ${qqSocialTab === 'artist' ? 'font-semibold' : muted}`} style={qqSocialTab === 'artist' ? { color: accent, borderBottom: `2px solid ${accent}` } : undefined}>歌手 {artistCount}</button>
            <button type="button" onClick={() => setQqSocialTab('user')} className={`pb-2 ${qqSocialTab === 'user' ? 'font-semibold' : muted}`} style={qqSocialTab === 'user' ? { color: accent, borderBottom: `2px solid ${accent}` } : undefined}>用户 {userCount}</button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {socialLoading ? (
            <div className={`py-16 text-center text-sm ${muted}`}>正在加载…</div>
          ) : shownSocialItems.length === 0 ? (
            <div className={`py-16 text-center text-sm ${muted}`}>暂无{social.kind === 'follows' ? '关注' : '粉丝'}</div>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {shownSocialItems.map(item => (
                <div key={`${item.kind}:${item.id}`} className={`flex flex-col items-center gap-3 rounded-2xl border p-5 ${surface}`}>
                  <button type="button" onClick={() => item.kind === 'user' ? onOpenUserProfile(item.id, item.name, item.avatarUrl) : item.artistMid && onOpenArtist?.(item.artistMid, platform)} className="transition hover:opacity-85">
                    <img src={item.avatarUrl} alt="" className="h-24 w-24 rounded-full object-cover" />
                  </button>
                  <button type="button" onClick={() => item.kind === 'user' ? onOpenUserProfile(item.id, item.name, item.avatarUrl) : item.artistMid && onOpenArtist?.(item.artistMid, platform)} className="w-full truncate text-center text-sm font-medium">{item.name}</button>
                  <button type="button" onClick={() => void toggleFollow(item)} className={`w-full rounded-full px-4 py-1.5 text-xs transition ${item.isFollow ? (isDark ? 'bg-white/10 text-white/60' : 'bg-black/5 text-slate-500') : 'text-white'}`} style={item.isFollow ? undefined : { background: accent }}>{item.isFollow ? '已关注' : '关注'}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── 个人中心主页 ──
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!loggedIn && isSelf ? (
          <div className={`flex h-56 flex-col items-center justify-center gap-3 rounded-3xl border ${surface}`}>
            <div className="flex h-14 w-14 items-center justify-center rounded-full" style={{ background: `${accent}22` }}><Music2 className="h-6 w-6" style={{ color: accent }} /></div>
            <p className={`text-sm ${muted}`}>登录 {platformLabel(platform)} 后查看个人中心</p>
            <button type="button" onClick={onLoginClick} className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white" style={{ background: accent }}><LogIn className="h-4 w-4" />立即登录</button>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-6">
              {detail?.avatarUrl ? <img src={detail.avatarUrl} alt="" className="h-28 w-28 shrink-0 rounded-full object-cover shadow-xl" /> : <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-full text-3xl text-white" style={{ background: accent }}>{(detail?.nickname || username || '?').slice(0, 1)}</div>}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-3xl font-bold">{detail?.nickname || username}</h1>
                  {detail?.vip && <span className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white" style={{ background: accent }}>VIP</span>}
                </div>
                {detail?.signature ? <p className={`mt-2 truncate text-sm ${muted}`}>{detail.signature}</p> : null}
                <div className="mt-3 flex gap-8 text-sm">
                  <button type="button" onClick={() => setSocial({ kind: 'fans' })} className={`transition hover:underline ${muted}`}>粉丝：<span className="font-semibold" style={{ color: accent }}>{detail?.fans ?? '-'}</span></button>
                  <button type="button" onClick={() => setSocial({ kind: 'follows' })} className={`transition hover:underline ${muted}`}>关注：<span className="font-semibold" style={{ color: accent }}>{detail?.follows ?? '-'}</span></button>
                </div>
              </div>
            </div>

            <div className="mt-8 flex gap-8 text-sm">
              <button type="button" onClick={() => setTab('liked')} className={`pb-2 ${tab === 'liked' ? 'font-semibold' : muted}`} style={tab === 'liked' ? { color: accent, borderBottom: `2px solid ${accent}` } : undefined}>我喜欢</button>
              <button type="button" onClick={() => setTab('created')} className={`pb-2 ${tab === 'created' ? 'font-semibold' : muted}`} style={tab === 'created' ? { color: accent, borderBottom: `2px solid ${accent}` } : undefined}>创建的歌单 {createdPlaylists.length}</button>
            </div>

            <div className="mt-6 pb-6">
              {tab === 'liked' ? (
                likedPlaylist ? (
                  <button type="button" onClick={() => isSelf ? onOpenLiked() : onOpenPlaylist(likedPlaylist)} className={`flex w-full max-w-md items-center gap-4 rounded-2xl border p-4 text-left transition hover:-translate-y-0.5 ${surface}`}>
                    <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl" style={{ background: `${accent}33` }}><Heart className="h-8 w-8 fill-current" style={{ color: accent }} /></div>
                    <span className="min-w-0"><span className="block truncate text-base font-semibold">{likedPlaylist.name || '我喜欢的音乐'}</span><span className={`mt-1 block text-xs ${muted}`}>{likedPlaylist.trackCount ? `${likedPlaylist.trackCount} 首` : '点击查看'}</span></span>
                  </button>
                ) : (
                  <div className={`flex h-40 items-center justify-center rounded-2xl border ${surface}`}><p className={`text-sm ${muted}`}>{isSelf ? '还没有喜欢的歌曲' : '暂无公开的我喜欢'}</p></div>
                )
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {createdPlaylists.map((playlist, index) => (
                    <button key={`${playlist.platform || platform}:${playlist.id || playlist.dirId}:${index}`} type="button" onClick={() => onOpenPlaylist(playlist)} className={`overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}>
                      <img src={playlist.coverImgUrl || playlist.coverUrl || ''} alt="" className="aspect-square w-full rounded-xl object-cover" />
                      <div className="mt-2 truncate text-sm">{playlist.name}</div>
                      <div className={`truncate text-xs ${muted}`}>{playlist.trackCount ? `${playlist.trackCount} 首` : '歌单'}</div>
                    </button>
                  ))}
                  {createdPlaylists.length === 0 && <div className={`col-span-full flex h-40 items-center justify-center rounded-2xl border ${surface}`}><p className={`text-sm ${muted}`}>还没有创建歌单</p></div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}


// 汽水曲目（后端 mapSodaMedia 产出）→ WaveForge Song（与 ProfileView 同口径）
const sodaMediaToSong = (raw: any): Song | undefined => {
  const mid = String(raw?.id ?? '')
  if (!mid) return undefined
  const tier = raw?.requiredTier
  const vip = Boolean(raw?.vip || tier === 'vip' || tier === 'svip')
  const rawArtists = Array.isArray(raw?.artists) ? raw.artists : []
  const artistNames = rawArtists.length
    ? rawArtists.map((item: any) => (typeof item === 'string' ? item : String(item?.name || ''))).filter(Boolean)
    : raw?.artist ? [String(raw.artist)] : []
  return {
    id: Number(mid.slice(0, 15)) || 0,
    mid,
    name: String(raw?.name || '未知歌曲'),
    artists: artistNames.map((name: string) => ({ name })),
    album: { name: String(raw?.album || ''), picUrl: String(raw?.coverUrl || '') },
    duration: Number(raw?.durationMs || 0),
    platform: 'soda',
    vip,
    fee: vip ? 1 : 0,
  }
}

// 网易云最近播放行 → Song（与 ProfileView normalizeRecentSong 同口径）
const neteaseRecentRowToSong = (row: any): Song | null => {
  const source = row?.resource || row?.data || row?.song || row
  const id = Number(source?.id ?? source?.songId ?? source?.song?.id ?? row?.resourceId)
  if (!Number.isFinite(id) || id <= 0) return null
  const songSource = source?.song || source?.data || row?.song || row?.data || source
  const artists = songSource?.ar || songSource?.artists || songSource?.singer || []
  const album = songSource?.al || songSource?.album || {}
  return {
    id,
    name: songSource?.name || songSource?.songName || '未知歌曲',
    artists: Array.isArray(artists) ? artists.map((artist: any) => ({ id: artist.id, name: artist.name || artist.n || '未知歌手', mid: artist.mid })) : [],
    album: { id: album.id, name: album.name || '未知专辑', picUrl: String(album.picUrl || album.picurl || album.blurPicUrl || album.coverUrl || songSource?.coverUrl || '') },
    duration: Number(songSource?.dt || songSource?.duration || 0),
    platform: 'netease',
  }
}

const getRecentRows = (payload: any): any[] => {
  const candidates = [payload?.data?.list, payload?.data?.records, payload?.data?.songs, payload?.data, payload?.list, payload?.records, payload?.songs]
  return candidates.find(Array.isArray) || []
}

// 最近播放页：中间栏展示各平台最近播放记录（与简约/桌面模式同源接口）
function TraditionalRecent({ platform, accent, isDark, loggedIn, currentSong, authRevision, onSongSelect, onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onViewComments, onOpenArtist, onOpenAlbum, onCopyInfo, onLoginClick, userPlaylists }: {
  platform: MusicPlatform; accent: string; isDark: boolean; loggedIn: boolean; currentSong: Song | null; authRevision?: number; onBack: () => void; onSongSelect: (song: Song, songs: Song[], origin: PlaybackOrigin) => void; onPlayNext?: (song: Song) => void; onAddToFavorites?: (song: Song) => void; onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>; onAddToPlaylist?: (song: Song, playlistId: string) => void; onViewComments?: (song: Song) => void; onOpenArtist?: (artistId: string, platform: MusicPlatform) => void; onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void; onCopyInfo?: (song: Song) => void; onLoginClick: () => void; userPlaylists?: any[];
}) {
  const [loading, setLoading] = useState(true)
  const [songs, setSongs] = useState<Song[]>([])
  const [error, setError] = useState('')
  const [songMenu, setSongMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const requestIdRef = useRef(0)
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'

  useEffect(() => {
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError('')
    setSongs([])
    const cookie = getPlatformCookie(platform)
    const finish = (list: Song[], message = '') => {
      if (requestId !== requestIdRef.current) return
      setSongs(list)
      setError(message)
      setLoading(false)
    }
    if (platform === 'apple') {
      getAppleRecentPlayed(100)
        .then(tracks => finish(tracks.map((track, index) => appleLibraryTrackToSong({ ...track, id: track.id || `recent-${index}` })).filter((s): s is Song => Boolean(s))))
        .catch(() => finish([], '最近播放加载失败，请重试'))
      return
    }
    if (platform === 'spotify') {
      // Spotify 无官方最近播放接口：展示喜欢的歌曲（与简约模式同口径）
      fetchSpotifyLiked(50)
        .then(tracks => finish(tracks.map(track => spotifyTrackToSong(track))))
        .catch(() => finish([], '最近播放加载失败，请重试'))
      return
    }
    if (platform === 'kugou') {
      finish([])
      return
    }
    const endpoint = platform === 'qq'
      ? `http://localhost:3001/api/qq/record/recent/song?limit=100${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`
      : platform === 'soda'
        ? `http://localhost:3001/api/soda/recent?limit=50${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`
        : `http://localhost:3001/api/netease/record/recent/song?limit=100${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`
    fetch(endpoint, { cache: 'no-store' })
      .then(response => response.json().catch(() => null).then(payload => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok || payload?.error) throw new Error(payload?.error || '最近播放加载失败')
        if (platform === 'qq') {
          const rows = Array.isArray(payload?.records) ? payload.records : (Array.isArray(payload?.songlist) ? payload.songlist.map((song: any) => ({ song })) : [])
          finish(rows.map((row: any, index: number) => {
            const song = row?.song || row
            if (!song?.name) return null
            const artists = Array.isArray(song?.artists) ? song.artists : (Array.isArray(song?.singer) ? song.singer : [])
            return {
              id: Number(song?.id ?? index) || index,
              mid: String(song?.mid || ''),
              name: song.name,
              artists: artists.map((artist: any) => ({ id: artist?.id, name: artist?.name || '', mid: artist?.mid })),
              album: { name: song?.album?.name || '', picUrl: String(song?.album?.picUrl || song?.albumpic || song?.picUrl || '') },
              duration: Number(song?.duration || song?.interval || 0) * (song?.interval ? 1000 : 1),
              platform: 'qq' as const,
            } as Song
          }).filter((s: unknown): s is Song => Boolean(s)))
        } else if (platform === 'soda') {
          const rows: any[] = Array.isArray(payload?.songs) ? payload.songs : []
          finish(rows.map(sodaMediaToSong).filter((s): s is Song => Boolean(s)))
        } else {
          finish(getRecentRows(payload).map(neteaseRecentRowToSong).filter((s): s is Song => Boolean(s)))
        }
      })
      .catch((err: unknown) => finish([], err instanceof Error ? err.message : '最近播放加载失败，请重试'))
  }, [platform, authRevision])

  const activeSong = (song: Song) => currentSong && songKey(song) === songKey(currentSong)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold">最近播放</h1>
          <p className={`mt-1 text-xs ${muted}`}>{platformLabel(platform)} · {songs.length > 0 ? `${songs.length} 首` : '按播放时间倒序'}</p>
        </div>
        {songs.length > 0 && (
          <button type="button" onClick={() => songs[0] && onSongSelect(songs[0], songs, { mode: 'traditional', surface: 'traditional-recent', platform })} className="flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-white" style={{ background: accent }}><Play className="h-3.5 w-3.5" />播放全部</button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 8 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded-2xl bg-white/10" />)}</div>
        ) : !loggedIn ? (
          <div className={`flex h-56 flex-col items-center justify-center gap-3 rounded-3xl border ${surface}`}>
            <History className="h-8 w-8 opacity-30" />
            <p className={`text-sm ${muted}`}>登录 {platformLabel(platform)} 后同步最近播放记录</p>
            <button type="button" onClick={onLoginClick} className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white" style={{ background: accent }}><LogIn className="h-4 w-4" />立即登录</button>
          </div>
        ) : songs.length === 0 ? (
          <div className={`flex h-56 flex-col items-center justify-center gap-3 rounded-3xl border ${surface}`}>
            <History className="h-8 w-8 opacity-30" />
            <p className={`text-sm ${muted}`}>{error || (platform === 'kugou' ? '该平台暂不支持最近播放' : '暂无最近播放记录')}</p>
          </div>
        ) : (
          <div className={`overflow-hidden rounded-2xl border ${surface}`}>
            {songs.map((song, index) => {
              const active = activeSong(song)
              return (
                <div
                  key={`${songKey(song)}:${index}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-recent', platform: song.platform || platform })}
                  onContextMenu={event => { event.preventDefault(); setSongMenu({ show: true, x: event.clientX, y: event.clientY, song }) }}
                  onKeyDown={event => { if (event.key === 'Enter') onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-recent', platform: song.platform || platform }) }}
                  className={`group grid cursor-pointer grid-cols-[36px_minmax(0,1fr)_minmax(100px,.6fr)_56px] items-center gap-3 border-b px-4 py-2.5 transition last:border-b-0 ${active ? (isDark ? 'bg-white/10' : 'bg-pink-50') : isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}
                >
                  <span className="flex justify-center text-xs" style={{ color: active ? accent : undefined }}>
                    {active ? <Music2 className="h-3.5 w-3.5" style={{ color: accent }} /> : <span className={muted}>{index + 1}</span>}
                  </span>
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="relative shrink-0">
                      <img src={coverOf(song)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" />
                      <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/40 group-hover:flex"><Play className="h-4 w-4 fill-current text-white" /></span>
                    </span>
                    <span className="min-w-0">
                      <span className={`block truncate text-sm ${active ? 'font-medium' : ''}`}>{song.name}</span>
                      <span className={`block truncate text-xs ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span>
                    </span>
                  </span>
                  <span className={`hidden truncate text-xs sm:block ${muted}`}>{song.album?.name || '未知专辑'}</span>
                  <span className={`text-right text-xs tabular-nums ${muted}`}>{formatTime(song.duration / 1000)}</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <SongContextMenu
        show={songMenu.show} x={songMenu.x} y={songMenu.y} song={songMenu.song}
        onClose={() => setSongMenu({ show: false, x: 0, y: 0, song: null })}
        onPlayNow={song => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-recent', platform: song.platform || platform })}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onViewAlbum={song => song.album?.id && onOpenAlbum?.(String(song.album.id), song.platform || platform)}
        onViewArtist={song => song.artists?.[0]?.id && onOpenArtist?.(String(song.artists[0].id), song.platform || platform)}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists || []}
        platform={songMenu.song?.platform || platform}
        playerTheme={isDark ? 'dark' : 'light'}
      />
    </div>
  )
}

// ─────────────────────────── 设置页 ───────────────────────────
// QQ 音乐式顶部标签 + 全宽内容，分两类：
// 1. 镜像全局设置（常规/播放/歌词/快捷键/桌面集成/性能/网络/高级/关于）：
//    来自 services/globalSettingsRegistry，与简约模式设置同键同事件，任意一端改动实时互通；
// 2. 「传统自定义」：仅影响传统模式自身的布局 / 背景氛围 / 平台排序显隐。
// 「全局设置」独立入口已移除 —— 全局设置现在就是本页的主体。

type TraditionalSettingsTabId = GlobalSettingsGroupId | 'traditional'

const SETTINGS_TABS: Array<{ id: TraditionalSettingsTabId; label: string }> = [
  { id: 'general', label: '常规' },
  { id: 'playback', label: '播放' },
  { id: 'lyrics', label: '歌词' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'desktop', label: '桌面集成' },
  { id: 'performance', label: '性能' },
  { id: 'network', label: '网络' },
  { id: 'advanced', label: '高级' },
  { id: 'about', label: '关于' },
  { id: 'traditional', label: '传统自定义' },
]

function TraditionalSettingsPage({ preferences, playerTheme, onChange, onOpenQuality }: { preferences: TraditionalPreferences; playerTheme: 'light' | 'dark'; onChange: (patch: Partial<TraditionalPreferences>) => void; onOpenQuality: () => void }) {
  const dark = playerTheme === 'dark'
  const { getValue } = useGlobalSettings()
  const accent = String(getValue('accentColor') || '#3B82F6')
  const skin = useMemo(() => makeSkin({ dark, accent }), [dark, accent])
  const [activeTab, setActiveTab] = useState<TraditionalSettingsTabId>('general')
  const [showCacheClear, setShowCacheClear] = useState(false)
  const [showRemoteSettings, setShowRemoteSettings] = useState(false)

  // 当前环境下没有可见条目的分组，对应标签隐藏（如 Web / TV 下的「桌面集成」「网络」）
  const visibleTabs = useMemo(() => SETTINGS_TABS.filter(tab => {
    if (tab.id === 'traditional') return true
    const group = GLOBAL_SETTINGS_GROUPS.find(item => item.id === tab.id)
    return Boolean(group && group.entries.some(isEntryVisible))
  }), [])

  useEffect(() => {
    if (!visibleTabs.some(tab => tab.id === activeTab)) setActiveTab(visibleTabs[0]?.id ?? 'general')
  }, [visibleTabs, activeTab])

  const handleOpenModal = useCallback((actionId: MirrorActionId) => {
    if (actionId === 'audio-quality') onOpenQuality()
    else if (actionId === 'cache-clear') setShowCacheClear(true)
    else if (actionId === 'remote-settings') setShowRemoteSettings(true)
  }, [onOpenQuality])

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-2">
        <h1 className="flex items-center gap-2 text-xl font-semibold"><Settings className="h-5 w-5" />设置</h1>
        <p className={`mt-1 text-xs ${dark ? 'text-white/50' : 'text-slate-500'}`}>全局设置与简约模式实时同步、对所有模式生效 · 「传统自定义」仅调整传统模式</p>
      </div>

      {/* 顶部标签栏 */}
      <div className={`-mx-1 flex gap-0.5 overflow-x-auto border-b px-1 ${dark ? 'border-white/10' : 'border-black/10'}`} style={{ scrollbarWidth: 'none' }}>
        {visibleTabs.map(tab => {
          const active = tab.id === activeTab
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="relative flex-shrink-0 px-3.5 py-2.5 text-[13px] transition-colors"
              style={{ color: active ? accent : dark ? 'rgba(255,255,255,.55)' : 'rgba(15,23,42,.55)', fontWeight: active ? 600 : 400 }}
            >
              {tab.label}
              {active && (
                <motion.span
                  layoutId="traditional-settings-tab-underline"
                  className="absolute inset-x-3 bottom-0 h-[2.5px] rounded-full"
                  style={{ background: accent }}
                  transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                />
              )}
            </button>
          )
        })}
      </div>

      {/* 内容区：全宽滚动 */}
      <div className="min-h-0 flex-1 overflow-y-auto pb-10 pr-1 pt-4">
        {activeTab === 'traditional' ? (
          <TraditionalCustomTab preferences={preferences} skin={skin} onChange={onChange} />
        ) : (
          <MirroredGlobalSettings key={activeTab} skin={skin} variant="classic" groupId={activeTab} onOpenModal={handleOpenModal} />
        )}
      </div>

      {/* 设置内打开的共享弹窗（音质弹窗由父级挂载） */}
      <Suspense fallback={null}>
        {showCacheClear && <LazyCacheClearModal show onClose={() => setShowCacheClear(false)} playerTheme={playerTheme} />}
        {showRemoteSettings && <LazyRemoteSettingsModal show onClose={() => setShowRemoteSettings(false)} playerTheme={playerTheme} />}
      </Suspense>
    </div>
  )
}

// 「传统自定义」标签：传统模式私有的布局 / 氛围 / 平台排序
function TraditionalCustomTab({ preferences, skin, onChange }: { preferences: TraditionalPreferences; skin: ReturnType<typeof makeSkin>; onChange: (patch: Partial<TraditionalPreferences>) => void }) {
  return (
    <div>
      <CustomSection title="布局" description="传统模式自身的排版密度" skin={skin}>
        <CustomChoice skin={skin} label="内容密度" value={preferences.density} options={[['comfortable', '舒适'], ['compact', '紧凑']]} onChange={value => onChange({ density: value as TraditionalPreferences['density'] })} />
        <CustomChoice skin={skin} label="侧栏宽度" value={preferences.sidebarWidth} options={[['wide', '宽松'], ['narrow', '紧凑']]} onChange={value => onChange({ sidebarWidth: value as TraditionalPreferences['sidebarWidth'] })} />
        <CustomCheck skin={skin} label="显示推荐内容" description="发现页展示推荐歌单与榜单" value={preferences.showRecommendations} onChange={value => onChange({ showRecommendations: value })} />
        <CustomCheck skin={skin} label="显示播放频谱" description="右栏「正在播放」展示实时频谱" value={preferences.showWaveform} onChange={value => onChange({ showWaveform: value })} />
      </CustomSection>
      <CustomSection title="背景氛围" description="传统模式自身的背景效果" skin={skin}>
        <CustomChoice skin={skin} label="背景" value={preferences.background} options={[['aurora', '流光'], ['cover', '封面'], ['plain', '纯色']]} onChange={value => onChange({ background: value as TraditionalPreferences['background'] })} />
        <CustomSlider skin={skin} label="背景模糊" value={preferences.backgroundBlur} min={0} max={28} step={1} unit="px" onChange={value => onChange({ backgroundBlur: value })} />
        <CustomCheck skin={skin} label="背景暗化" description="叠加暗色遮罩，突出前景内容" value={preferences.backgroundDim} onChange={value => onChange({ backgroundDim: value })} />
      </CustomSection>
      <CustomSection title="平台排序与显隐" description="与简约 / 探索 / 桌面模式共用同一份平台顺序，拖拽即时同步" skin={skin}>
        <PlatformOrderEditor skin={skin} />
      </CustomSection>
    </div>
  )
}

// 传统自定义的小节外壳（与镜像设置的 classic 分组同一版式）
function CustomSection({ title, description, skin, children }: { title: string; description?: string; skin: ReturnType<typeof makeSkin>; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <h3 className="text-[15px] font-semibold" style={{ color: skin.text }}>{title}</h3>
      {description && <p className="mt-0.5 text-[11px]" style={{ color: skin.muted }}>{description}</p>}
      <div className="mt-3 grid gap-x-4 gap-y-0.5 border-t pt-3" style={{ borderColor: skin.cardBorder, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {children}
      </div>
    </section>
  )
}

function CustomCheck({ label, description, value, onChange, skin }: { label: string; description?: string; value: boolean; onChange: (value: boolean) => void; skin: ReturnType<typeof makeSkin> }) {
  return (
    <button type="button" onClick={() => onChange(!value)} className="flex items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]">
      <span
        className="mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full border-2 transition-all"
        style={{ borderColor: value ? skin.accent : skin.dark ? 'rgba(255,255,255,0.28)' : 'rgba(15,23,42,0.3)', background: value ? skin.accent : 'transparent' }}
      >
        {value && <Check className="h-3 w-3 text-white" strokeWidth={3.5} />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] leading-5" style={{ color: skin.text }}>{label}</span>
        {description && <span className="mt-0.5 block text-[11px] leading-4" style={{ color: skin.muted }}>{description}</span>}
      </span>
    </button>
  )
}

function CustomChoice({ label, value, options, onChange, skin }: { label: string; value: string; options: Array<[string, string]>; onChange: (value: string) => void; skin: ReturnType<typeof makeSkin> }) {
  return (
    <div className="px-2.5 py-2">
      <div className="text-[13px] leading-5" style={{ color: skin.text }}>{label}</div>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {options.map(([key, labelText]) => {
          const active = value === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => onChange(key)}
              className="rounded-full border px-3.5 py-1.5 text-xs transition-all"
              style={{
                borderColor: active ? skin.accent : skin.cardBorder,
                background: active ? `${skin.accent}1f` : 'transparent',
                color: active ? skin.accent : skin.sub,
                fontWeight: active ? 600 : 400,
              }}
            >
              {labelText}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function CustomSlider({ label, value, min, max, step, unit, onChange, skin }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void; skin: ReturnType<typeof makeSkin> }) {
  return (
    <div className="px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[13px] leading-5" style={{ color: skin.text }}>{label}</span>
        <span className="text-xs tabular-nums" style={{ color: skin.sub }}>{value > 0 ? `${value}${unit || ''}` : '关'}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={event => onChange(Number(event.target.value))}
        className="mt-2 w-full cursor-pointer"
        style={{ accentColor: skin.accent, background: skin.controlBg }}
      />
    </div>
  )
}

export default memo(TraditionalView)
