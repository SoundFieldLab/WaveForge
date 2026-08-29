/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { isTvModeActive } from '../platform'
import { useTvMode, useRemoteCursorMode, useTvBack } from '../tv/tvCore'
import { lazy, Suspense, memo, useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Search, Settings, X, Play, Clock, Volume2, VolumeX, LogIn, Captions, Heart, MonitorSmartphone, Speaker } from 'lucide-react'
import PluginShortcuts from './PluginShortcuts'
import PlaylistCarousel3D from './PlaylistCarousel3D'
import DesktopMiniPlayer from './DesktopMiniPlayer'
import ModeSelectionPanel, { MODE_SELECTION_CLOSE_MS, MODE_SELECTION_PANEL_HEIGHT } from './ModeSelectionPanel'
import GlobalToast from './GlobalToast'
import LyricsDisplay from './LyricsDisplay'
import DesktopWidgetZone from './DesktopWidgetZone'
import DesktopFocusAlarmOverlay from './DesktopFocusAlarmOverlay'
import { Song, LyricLine } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getVisiblePlatforms } from '../services/platforms'
import { getAppleLibraryPlaylists, getAppleRecentPlayed, appleLibraryTrackToSong, getApplePlaylistTracks, getAppleCatalogPlaylistTracks, appleSongToSong, removeAppleTracksFromPlaylist } from '../services/appleCatalog'
import { desktopWallpaperManager, DesktopLiveWallpaperSource, toWallpaperUrl } from '../services/desktopWallpaperManager'
import { getPlaylistDetail, getUserPlaylists, removeSongFromPlaylist, streamNeteasePlaylistTracks } from '../services/playlistService'
import { useColorThief } from '../hooks/useColorThief'
import {
  DESKTOP_CUSTOMIZATION_EVENT,
  DesktopCustomizationSettings,
  loadDesktopCustomization,
} from '../services/desktopCustomization'
import { useDesktopFocusTimer } from '../hooks/useDesktopFocusTimer'
import { getReadableDesktopAccentColor } from '../utils/desktopAccentColor'
import { parseStoredArray, parseStoredBoolean } from '../utils/storage'
import type { PlaybackOrigin, SongSelectHandler } from '../types/playbackNavigation'
import { addDesktopListeningSeconds, recordDesktopSongStart } from '../services/desktopMusicActivity'
import type { DesktopMusicWidgetContext } from './DesktopExtraWidgets'
import {
  loadWallpaperEngineRotationSettings,
  saveWallpaperEngineRotationSettings,
  type WallpaperEngineRotationSettings,
  type WallpaperEngineWallpaper,
} from '../services/wallpaperEngineRotation'

const LazyDesktopSettingsModal = lazy(() => import('./DesktopSettingsModal'))
const LazySearchPanel = lazy(() => import('./SearchPanel'))
const LazyPlaylistGrid3D = lazy(() => import('./PlaylistGrid3D'))
const LazyLoginView = lazy(() => import('./LoginView'))
const LazyDesktopCustomizationEditor = lazy(() => import('./DesktopCustomizationEditor'))

interface DesktopViewProps {
  // 音乐播放相关
  onSongSelect: SongSelectHandler
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  currentSong: Song | null
  isPlaying: boolean
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  currentTime?: number
  duration?: number
  lyrics?: LyricLine[]
  playbackQueue: Song[]
  currentIndex: number
  volume: number
  onVolumeChange: (volume: number) => void
  onRemoveQueueItem: (index: number) => void
  onMoveQueueItem: (from: number, to: number) => void
  /** 桌面融合穿透：空区域鼠标穿透到真实桌面，组件区保持可交互 */
  desktopFusionEnabled?: boolean
  onDesktopFusionChange?: (enabled: boolean) => void
  
  // 登录状态
  authRevision?: number
  neteaseLoggedIn: boolean
  neteaseUserId: string
  neteaseUsername?: string
  qqLoggedIn: boolean
  qqUserId: string
  qqUsername?: string
  appleLoggedIn?: boolean
  appleUsername?: string
  onAppleLoginClick?: () => void
  onAppleLogout?: () => void
  // 新三平台登录态
  spotifyLoggedIn?: boolean
  spotifyUserId?: string
  spotifyUsername?: string
  kugouLoggedIn?: boolean
  kugouUserId?: string
  kugouUsername?: string
  sodaLoggedIn?: boolean
  sodaUserId?: string
  sodaUsername?: string
  
  // VIP状态
  neteaseVip: boolean
  qqVip: boolean
  
  // 登录回调
  onNeteaseLogin: (cookie: string) => void
  onQQLogin: (cookie: string) => void
  onSpotifyLogin?: (cookie: string, username?: string) => void
  onKugouLogin?: (cookie: string, username?: string) => void
  onSodaLogin?: (cookie: string, username?: string) => void

  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onCopyInfo?: (song: Song) => void
  
  // 其他
  onExitDesktopMode: () => void
  onRemoteClick: () => void
  /** 播放设备控制（音频输出设备 / AirPlay 投送）弹窗 */
  onOpenDeviceControl: () => void
}

interface Playlist {
  id: string | number
  name: string
  coverImgUrl: string
  trackCount?: number
  playCount?: number
  description?: string
  dirId?: string | number
  userId?: string | number
  platform?: MusicPlatform
  isLike?: boolean
  isCollected?: boolean
  isRecent?: boolean
  covers?: string[]
}

function isDesktopLiveWallpaperSource(wallpaper: unknown): wallpaper is DesktopLiveWallpaperSource {
  return Boolean(
    wallpaper &&
    typeof wallpaper === 'object' &&
    'kind' in wallpaper &&
    (wallpaper as DesktopLiveWallpaperSource).kind === 'wallpaper-engine'
  )
}

// QQ 最近播放的 mid 是字母数字混合字符串，不能直接 Number()。
// 云端歌曲缺少数字 id 时用 mid 生成稳定数字 id，供列表 key 与当前曲高亮使用。
const qqRecentSongHashId = (mid: string): number => {
  let hash = 0
  for (let i = 0; i < mid.length; i += 1) {
    hash = (hash * 31 + mid.charCodeAt(i)) | 0
  }
  return Math.abs(hash) || 1
}

function DesktopView({
  onSongSelect,
  restorePlaybackOrigin,
  currentSong,
  isPlaying,
  onPlayPause,
  onNext,
  onPrevious,
  currentTime = 0,
  duration = 0,
  lyrics = [],
  playbackQueue,
  currentIndex,
  volume,
  onVolumeChange,
  onRemoveQueueItem,
  onMoveQueueItem,
  desktopFusionEnabled = false,
  onDesktopFusionChange,
  authRevision = 0,
  neteaseLoggedIn,
  neteaseUserId,
  neteaseUsername,
  qqLoggedIn,
  qqUserId,
  qqUsername,
  appleLoggedIn = false,
  appleUsername = '',
  onAppleLoginClick,
  spotifyLoggedIn = false,
  spotifyUserId = '',
  spotifyUsername = '',
  kugouLoggedIn = false,
  kugouUserId = '',
  kugouUsername = '',
  sodaLoggedIn = false,
  sodaUserId = '',
  sodaUsername = '',
  neteaseVip,
  qqVip,
  onNeteaseLogin,
  onQQLogin,
  onSpotifyLogin,
  onKugouLogin,
  onSodaLogin,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onOpenArtist,
  onOpenAlbum,
  onCopyInfo,
  onExitDesktopMode,
  onRemoteClick,
  onOpenDeviceControl,
}: DesktopViewProps) {
  // 当前平台（桌面模式独立）- 记住用户选择
  const [currentPlatform, setCurrentPlatform] = useState<MusicPlatform>(() => {
    const saved = localStorage.getItem('desktopModePlatform')
    if (saved === 'qq' || saved === 'apple') {
      return getVisiblePlatforms().includes(saved) ? saved : 'netease'
    }
    return 'netease'
  })

  // TV 遥控器模式（html.tv-mode 激活）：桌面模式下的歌单栏/小白条交互需要适配遥控器
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const isTvUi = isTvModeActive()
  // 歌单栏在 TV 模式下默认展开（遥控器没有 hover 触发小白条，直接常驻）
  const [showPlaylistCarousel, setShowPlaylistCarousel] = useState(() => isTvModeActive())
  
  // 歌单列表
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [loading, setLoading] = useState(false)
  // 最近播放（桌面模式仅展示歌曲，数据与简约模式同源）
  const [recentSongs, setRecentSongs] = useState<Song[]>([])
  const [recentCovers, setRecentCovers] = useState<string[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const recentSongsRef = useRef<Song[]>([])
  const recentCoversRef = useRef<string[]>([])
  const recentLoadControllerRef = useRef<AbortController | null>(null)
  const recentLoadSignatureRef = useRef('')  
  // UI状态
  const [showThemePanel, setShowThemePanel] = useState(false)
  const [themePanelSettled, setThemePanelSettled] = useState(false)
  const [isTopHovered, setIsTopHovered] = useState(false)
  const [showUpArrowHint, setShowUpArrowHint] = useState(false)
  // TV 无鼠标：顶部/底部悬浮控件视为恒 hover（控件常驻可聚焦）；
  // 手机遥控器连上（光标模式）时恢复真实 hover，与 PC 一致（与 HomeView 同策略）
  const topBarActive = (tvMode && !remoteCursorMode) || isTopHovered

  useEffect(() => {
    const closeForModeSwitch = () => {
      setThemePanelSettled(false)
      setShowThemePanel(false)
      setShowUpArrowHint(false)
    }
    window.addEventListener('viewModeChanged', closeForModeSwitch)
    return () => window.removeEventListener('viewModeChanged', closeForModeSwitch)
  }, [])

  const [showSettings, setShowSettings] = useState(false)
  const [settingsModuleMounted, setSettingsModuleMounted] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showPlaylistDetail, setShowPlaylistDetail] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] = useState<Playlist | null>(null)
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([])
  const [loadingPlaylistSongs, setLoadingPlaylistSongs] = useState(false)
  const playlistLoadControllerRef = useRef<AbortController | null>(null)
  const [showDesktopMiniPlayer, setShowDesktopMiniPlayer] = useState(false) // 桌面迷你播放器

  useEffect(() => {
    if (restorePlaybackOrigin?.surface.startsWith('search')) {
      setShowSearch(true)
      return
    }
    if (restorePlaybackOrigin?.surface !== 'desktop-playlist' || !restorePlaybackOrigin.playlist) return
    setSelectedPlaylist(restorePlaybackOrigin.playlist as Playlist)
    setPlaylistSongs(restorePlaybackOrigin.songs || [])
    setLoadingPlaylistSongs(false)
    setShowPlaylistDetail(true)
    setShowPlaylistCarousel(true)
  }, [restorePlaybackOrigin?.revision])
  const [showDesktopLyrics, setShowDesktopLyrics] = useState(() => {
    const saved = localStorage.getItem('showDesktopLyrics')
    return parseStoredBoolean(saved, false)
  })
  const [desktopCustomization, setDesktopCustomization] = useState<DesktopCustomizationSettings>(() => loadDesktopCustomization())
  const [showDesktopCustomizer, setShowDesktopCustomizer] = useState(false)
  const [customizerModuleMounted, setCustomizerModuleMounted] = useState(false)
  const [widgetOverlaySide, setWidgetOverlaySide] = useState<'left' | 'right' | null>(null)
  const focusTimer = useDesktopFocusTimer(false)
  const alarmContextRef = useRef<AudioContext | null>(null)
  const alarmIntervalRef = useRef<number | null>(null)
  const playbackWasActiveRef = useRef(isPlaying)
  const [showLogin, setShowLogin] = useState(false) // 登录面板
  const [loginPlatform, setLoginPlatform] = useState<MusicPlatform>('netease') // 登录平台

  useEffect(() => {
    if (showSettings) setSettingsModuleMounted(true)
  }, [showSettings])

  useEffect(() => {
    if (showDesktopCustomizer) setCustomizerModuleMounted(true)
  }, [showDesktopCustomizer])
  
  const [lyricOffset] = useState(() => Number(localStorage.getItem('lyricOffset')) || 0)
  
  // 提取当前歌曲封面主题色
  const { dominantColor } = useColorThief(currentSong?.album?.picUrl || '')
  const desktopAccentColor = useMemo(() => getReadableDesktopAccentColor(dominantColor), [dominantColor])

  useEffect(() => {
    if (currentSong) recordDesktopSongStart(currentSong)
  }, [currentSong?.id, currentSong?.mid, currentSong?.platform])

  useEffect(() => {
    if (!currentSong || !isPlaying) return
    const timer = window.setInterval(() => addDesktopListeningSeconds(currentSong, 10), 10_000)
    return () => window.clearInterval(timer)
  }, [currentSong?.id, currentSong?.mid, currentSong?.platform, isPlaying])
  
  // 计算当前歌词
  const currentMiniLyric = useMemo(() => {
    const adjustedTime = currentTime + 0.5 + lyricOffset
    for (let index = lyrics.length - 1; index >= 0; index--) {
      if (lyrics[index].time <= adjustedTime) {
        return lyrics[index].text
      }
    }
    return ''
  }, [currentTime, lyricOffset, lyrics])

  useEffect(() => {
    const handleCustomizationChange = (event: Event) => {
      const next = (event as CustomEvent<DesktopCustomizationSettings>).detail
      const resolved = next || loadDesktopCustomization()
      setDesktopCustomization(resolved)
      setBackgroundBlur(resolved.backgroundBlur)
      setBackgroundDim(resolved.backgroundDim)
    }

    window.addEventListener(DESKTOP_CUSTOMIZATION_EVENT, handleCustomizationChange)
    return () => window.removeEventListener(DESKTOP_CUSTOMIZATION_EVENT, handleCustomizationChange)
  }, [])

  useEffect(() => {
    playbackWasActiveRef.current = isPlaying
  }, [isPlaying])

  const stopAlarmSound = useCallback(() => {
    if (alarmIntervalRef.current !== null) {
      window.clearInterval(alarmIntervalRef.current)
      alarmIntervalRef.current = null
    }
    const context = alarmContextRef.current
    alarmContextRef.current = null
    if (context && context.state !== 'closed') void context.close()
  }, [])

  const startAlarmSound = useCallback(() => {
    stopAlarmSound()
    const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextConstructor) return
    const context = new AudioContextConstructor()
    alarmContextRef.current = context

    const playPulse = () => {
      if (context.state === 'suspended') void context.resume()
      const startAt = context.currentTime + 0.03
      ;[0, 0.22].forEach((offset, index) => {
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(index === 0 ? 880 : 1174.66, startAt + offset)
        gain.gain.setValueAtTime(0.0001, startAt + offset)
        gain.gain.exponentialRampToValueAtTime(0.22, startAt + offset + 0.025)
        gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.18)
        oscillator.connect(gain)
        gain.connect(context.destination)
        oscillator.start(startAt + offset)
        oscillator.stop(startAt + offset + 0.2)
      })
    }

    playPulse()
    alarmIntervalRef.current = window.setInterval(playPulse, 1150)
  }, [stopAlarmSound])

  // 自动隐藏歌单栏的定时器
  const hideCarouselTimerRef = useRef<number | null>(null)
  const playlistLoadSignatureRef = useRef('')
  
  // 桌面壁纸状态 - 使用新的壁纸管理器
  const [desktopWallpaper, setDesktopWallpaper] = useState<string | null>(null)
  const [desktopLiveWallpaper, setDesktopLiveWallpaper] = useState<DesktopLiveWallpaperSource | null>(null)
  const [wallpaperKey, setWallpaperKey] = useState(0) // 用于触发切换动画
  const wallpaperSourceRef = useRef('')
  
  // Wallpaper Engine 同步状态
  const [wallpaperSyncEnabled, setWallpaperSyncEnabled] = useState(() => {
    const saved = localStorage.getItem('wallpaperSyncEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  // 卡片模糊度
  const [cardBlurAmount, setCardBlurAmount] = useState(() => {
    const saved = localStorage.getItem('cardBlurAmount')
    return saved ? parseInt(saved) : 10
  })
  
  // 背景模糊度
  const [backgroundBlur, setBackgroundBlur] = useState(() => desktopCustomization.backgroundBlur)

  const [backgroundDim, setBackgroundDim] = useState(() => desktopCustomization.backgroundDim)
  
  // Toast 通知
  const [showToast, setShowToast] = useState(false)
  const [toastMessage, setToastMessage] = useState('')
  const [toastType, setToastType] = useState<'success' | 'error' | 'info' | 'warning'>('info')
  const toastTimerRef = useRef<number | null>(null)
  const transientTimersRef = useRef<Set<number>>(new Set())
  const wallpaperScanControllerRef = useRef<AbortController | null>(null)
  const wallpaperRotationTimerRef = useRef<number | null>(null)
  const wallpaperRotationApplyingRef = useRef(false)
  const selectWeWallpaperRef = useRef<((wallpaper: WallpaperEngineWallpaper, source?: 'manual' | 'rotation') => Promise<void>) | null>(null)
  
  // 视频音量控制
  const [videoMuted, setVideoMuted] = useState(() => {
    const saved = localStorage.getItem('desktopVideoMuted')
    return saved !== null ? JSON.parse(saved) : true // 默认静音
  })
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoUnsupported, setVideoUnsupported] = useState(false)
  const desktopVideoUrl = desktopLiveWallpaper?.sourceType === 'video'
    ? desktopLiveWallpaper.url
    : null

  // Chromium 会在 video DOM 离开页面后继续保留解码器和媒体缓冲。
  // 使用稳定的 ref 生命周期主动断开 src，确保离开桌面模式或切换壁纸时销毁媒体管线。
  const setDesktopVideoRef = useCallback((video: HTMLVideoElement | null) => {
    const previousVideo = videoRef.current
    if (previousVideo && previousVideo !== video) {
      previousVideo.pause()
      previousVideo.removeAttribute('src')
      previousVideo.load()
    }

    videoRef.current = video

    // React 19 StrictMode 会额外执行一次 ref 清理/挂载；清理后需要恢复当前地址。
    if (video && desktopVideoUrl && video.getAttribute('src') !== desktopVideoUrl) {
      video.setAttribute('src', desktopVideoUrl)
      video.load()
    }
  }, [desktopVideoUrl])

  useEffect(() => {
    if (!desktopVideoUrl) return

    // Chromium may keep decoding a looping wallpaper while the window is hidden.
    // Pause the media pipeline off-screen and resume the same animation on return.
    const syncVideoPlayback = () => {
      const video = videoRef.current
      if (!video) return
      if (document.visibilityState !== 'visible' || focusTimer.timer.status === 'ringing') {
        video.pause()
        return
      }
      void video.play().catch(() => undefined)
    }

    syncVideoPlayback()
    document.addEventListener('visibilitychange', syncVideoPlayback)
    return () => document.removeEventListener('visibilitychange', syncVideoPlayback)
  }, [desktopVideoUrl, focusTimer.timer.status])

  useEffect(() => {
    if (focusTimer.timer.status !== 'ringing') {
      stopAlarmSound()
      return
    }
    if (playbackWasActiveRef.current) {
      playbackWasActiveRef.current = false
      onPlayPause()
    }
    if (videoRef.current && !videoMuted) {
      videoRef.current.pause()
    }
    startAlarmSound()
    return stopAlarmSound
  }, [focusTimer.timer.status, onPlayPause, startAlarmSound, stopAlarmSound, videoMuted])
  
  // WallpaperEngine 壁纸列表
  const [weWallpapers, setWeWallpapers] = useState<WallpaperEngineWallpaper[]>(() => {
    // 从缓存加载壁纸列表
    const cached = localStorage.getItem('weWallpapersCache')
    return parseStoredArray<WallpaperEngineWallpaper>(cached)
  })
  const [weLoading, setWeLoading] = useState(false)
  const [weError, setWeError] = useState<string | null>(null)
  const [selectedWeWallpaper, setSelectedWeWallpaper] = useState<string | null>(() => {
    return localStorage.getItem('selectedWeWallpaper')
  })
  const [wallpaperRotation, setWallpaperRotation] = useState<WallpaperEngineRotationSettings>(() => loadWallpaperEngineRotationSettings())
  const weWallpapersRef = useRef(weWallpapers)
  const selectedWeWallpaperRef = useRef(selectedWeWallpaper)
  const wallpaperRotationRef = useRef(wallpaperRotation)
  const wallpaperSyncEnabledRef = useRef(wallpaperSyncEnabled)
  weWallpapersRef.current = weWallpapers
  selectedWeWallpaperRef.current = selectedWeWallpaper
  wallpaperRotationRef.current = wallpaperRotation
  wallpaperSyncEnabledRef.current = wallpaperSyncEnabled
  
  // 显示 Toast
  const scheduleTransientTimer = (callback: () => void, delay: number) => {
    const timer = window.setTimeout(() => {
      transientTimersRef.current.delete(timer)
      callback()
    }, delay)
    transientTimersRef.current.add(timer)
    return timer
  }

  const showToastNotification = (message: string, type: 'success' | 'error' | 'info' | 'warning' = 'info') => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
      transientTimersRef.current.delete(toastTimerRef.current)
      toastTimerRef.current = null
    }
    setToastMessage(message)
    setToastType(type)
    setShowToast(true)
    toastTimerRef.current = scheduleTransientTimer(() => {
      setShowToast(false)
    }, 3000)
  }

  const updateWallpaperRotation = (next: WallpaperEngineRotationSettings) => {
    if (next.enabled && next.selectedWallpaperIds.length < 2) {
      showToastNotification('请至少选择 2 张参与轮换的壁纸', 'warning')
    }
    const normalized = saveWallpaperEngineRotationSettings(next)
    wallpaperRotationRef.current = normalized
    setWallpaperRotation(normalized)
  }
  
  // 切换视频静音
  const toggleVideoMute = () => {
    const newMuted = !videoMuted
    
    // 如果用户想要打开壁纸音频（取消静音），且当前正在播放音乐
    if (!newMuted && isPlaying) {
      // 暂停音乐播放
      onPlayPause()
      showToastNotification('已暂停音乐播放以播放壁纸音频', 'info')
    }
    
    setVideoMuted(newMuted)
    localStorage.setItem('desktopVideoMuted', JSON.stringify(newMuted))
    if (videoRef.current) {
      videoRef.current.muted = newMuted
    }
  }

  // 扫描 WallpaperEngine 壁纸
  const scanWeWallpapers = async () => {
    wallpaperScanControllerRef.current?.abort()
    const scanController = new AbortController()
    wallpaperScanControllerRef.current = scanController
    setWeLoading(true)
    setWeError(null)
    try {
      const response = await fetch('http://localhost:3001/api/wallpaper-engine/scan', { signal: scanController.signal, cache: 'no-store' })
      const data = await response.json()
      if (scanController.signal.aborted || wallpaperScanControllerRef.current !== scanController) return
      
      if (data.success) {
        // 从 localStorage 读取上次的扫描结果
        const cachedWallpapersStr = localStorage.getItem('weWallpapersCache')
        const cachedWallpapers = cachedWallpapersStr ? JSON.parse(cachedWallpapersStr) : []
        
        // 对比变化（比较壁纸 ID）
        const newCount = data.wallpapers.length
        const oldCount = cachedWallpapers.length
        
        if (oldCount > 0) {
          // 深度对比：比较壁纸 ID 集合
          const oldIds = new Set(cachedWallpapers.map((w: any) => w.id))
          const newIds = new Set(data.wallpapers.map((w: any) => w.id))
          
          // 计算新增和删除
          const addedIds = data.wallpapers.filter((w: any) => !oldIds.has(w.id))
          const removedIds = cachedWallpapers.filter((w: any) => !newIds.has(w.id))
          
          const addedCount = addedIds.length
          const removedCount = removedIds.length
          
          if (addedCount > 0 && removedCount > 0) {
            showToastNotification(`新增 ${addedCount} 张，减少 ${removedCount} 张壁纸`, 'info')
          } else if (addedCount > 0) {
            showToastNotification(`新增 ${addedCount} 张壁纸`, 'success')
          } else if (removedCount > 0) {
            showToastNotification(`减少 ${removedCount} 张壁纸`, 'info')
          } else {
            showToastNotification(`找到 ${data.count} 个壁纸（无变化）`, 'info')
          }
        } else {
          // 首次扫描
          showToastNotification(`找到 ${data.count} 个壁纸`, 'success')
        }
        
        const nextWallpapers = Array.isArray(data.wallpapers)
          ? data.wallpapers as WallpaperEngineWallpaper[]
          : []

        // 保存到缓存并剔除已失效的轮换条目。
        localStorage.setItem('weWallpapersCache', JSON.stringify(nextWallpapers))
        setWeWallpapers(nextWallpapers)
        weWallpapersRef.current = nextWallpapers

        const validIds = new Set(nextWallpapers.map(item => item.id))
        const currentRotation = wallpaperRotationRef.current
        const selectedWallpaperIds = currentRotation.selectedWallpaperIds.filter(id => validIds.has(id))
        if (selectedWallpaperIds.length !== currentRotation.selectedWallpaperIds.length) {
          updateWallpaperRotation({
            ...currentRotation,
            enabled: currentRotation.enabled && selectedWallpaperIds.length >= 2,
            selectedWallpaperIds,
          })
        }
      } else {
        setWeError(data.message)
        showToastNotification(data.message, 'error')
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('扫描壁纸失败:', error)
        setWeError('扫描失败，请确保 WallpaperEngine 已安装')
        showToastNotification('扫描失败', 'error')
      }
    } finally {
      if (wallpaperScanControllerRef.current === scanController) {
        wallpaperScanControllerRef.current = null
        setWeLoading(false)
      }
    }
  }

  const selectWeWallpaper = async (
    wallpaper: WallpaperEngineWallpaper,
    source: 'manual' | 'rotation' = 'manual',
  ) => {
    if (wallpaperSyncEnabledRef.current) {
      if (source === 'manual') showToastNotification('请先关闭同步功能', 'warning')
      return
    }
    if (!wallpaper?.id || ((wallpaper.type === 'video' || wallpaper.type === 'image') && !wallpaper.file)) {
      showToastNotification('该壁纸文件已失效，请重新扫描壁纸库', 'warning')
      return
    }

    try {
      selectedWeWallpaperRef.current = wallpaper.id
      setSelectedWeWallpaper(wallpaper.id)
      localStorage.setItem('selectedWeWallpaper', wallpaper.id)

      // 手动和自动轮换共用同一应用通道。
      desktopWallpaperManager.saveSettings({ lastWallpaperSource: 'wallpaper-engine-manual' })
      setVideoUnsupported(false)

      if (wallpaper.type === 'video') {
        const mediaUrl = `http://localhost:3001/api/wallpaper-engine/media?id=${encodeURIComponent(wallpaper.id)}&file=${encodeURIComponent(wallpaper.file)}`
        console.log('[DesktopView] 应用视频壁纸:', mediaUrl)
        setDesktopLiveWallpaper({
          kind: 'wallpaper-engine',
          sourceType: 'video',
          url: mediaUrl,
          path: wallpaper.path || '',
          title: wallpaper.title,
          id: wallpaper.id,
        })
        setDesktopWallpaper(null)
      } else if (wallpaper.type === 'image') {
        setDesktopWallpaper(`http://localhost:3001/api/wallpaper-engine/media?id=${encodeURIComponent(wallpaper.id)}&file=${encodeURIComponent(wallpaper.file)}`)
        setDesktopLiveWallpaper(null)
      } else if (wallpaper.preview) {
        setDesktopWallpaper(`http://localhost:3001${wallpaper.preview}`)
        setDesktopLiveWallpaper(null)
      } else {
        throw new Error('Wallpaper has no playable media')
      }

      setWallpaperKey(key => key + 1)
      showToastNotification(
        source === 'rotation' ? `已自动切换壁纸：${wallpaper.title}` : `已应用壁纸：${wallpaper.title}`,
        'success',
      )
    } catch (error) {
      console.error('应用壁纸失败:', error)
      showToastNotification('应用壁纸失败，请重新扫描壁纸库', 'error')
    }
  }
  selectWeWallpaperRef.current = selectWeWallpaper

  const rotateWallpaperEngine = useCallback(async () => {
    if (wallpaperRotationApplyingRef.current) return
    const settings = wallpaperRotationRef.current
    if (!settings.enabled || wallpaperSyncEnabledRef.current) return

    const selectedSet = new Set(settings.selectedWallpaperIds)
    const candidates = weWallpapersRef.current.filter(item =>
      selectedSet.has(item.id)
      && Boolean(item.id)
      && Boolean(item.file || item.preview),
    )
    if (candidates.length < 2) return

    const currentId = selectedWeWallpaperRef.current
    let nextWallpaper: WallpaperEngineWallpaper
    if (settings.mode === 'random') {
      const alternatives = candidates.filter(item => item.id !== currentId)
      nextWallpaper = alternatives[Math.floor(Math.random() * alternatives.length)]
    } else {
      const currentIndex = candidates.findIndex(item => item.id === currentId)
      nextWallpaper = candidates[currentIndex < 0 ? 0 : (currentIndex + 1) % candidates.length]
    }

    wallpaperRotationApplyingRef.current = true
    try {
      await selectWeWallpaperRef.current?.(nextWallpaper, 'rotation')
    } finally {
      wallpaperRotationApplyingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (wallpaperRotationTimerRef.current !== null) {
      window.clearInterval(wallpaperRotationTimerRef.current)
      wallpaperRotationTimerRef.current = null
    }
    if (
      !wallpaperRotation.enabled
      || wallpaperRotation.selectedWallpaperIds.length < 2
      || wallpaperSyncEnabled
    ) return

    wallpaperRotationTimerRef.current = window.setInterval(
      () => void rotateWallpaperEngine(),
      wallpaperRotation.intervalMinutes * 60_000,
    )

    return () => {
      if (wallpaperRotationTimerRef.current !== null) {
        window.clearInterval(wallpaperRotationTimerRef.current)
        wallpaperRotationTimerRef.current = null
      }
    }
  }, [
    rotateWallpaperEngine,
    wallpaperRotation.enabled,
    wallpaperRotation.intervalMinutes,
    wallpaperRotation.mode,
    wallpaperRotation.selectedWallpaperIds.join('|'),
    wallpaperSyncEnabled,
  ])

  // 跳到下一个支持的壁纸（当视频格式不支持时）
  const skipToNextWallpaper = () => {
    if (!selectedWeWallpaper || weWallpapers.length === 0) return
    const currentIndex = weWallpapers.findIndex(wallpaper => wallpaper.id === selectedWeWallpaper)
    if (currentIndex === -1) return

    for (let offset = 1; offset <= weWallpapers.length; offset += 1) {
      const nextWallpaper = weWallpapers[(currentIndex + offset) % weWallpapers.length]
      if (nextWallpaper.id && (nextWallpaper.file || nextWallpaper.preview)) {
        void selectWeWallpaper(nextWallpaper)
        return
      }
    }
    showToastNotification('未找到支持的壁纸格式', 'error')
  }

  // 处理 Wallpaper Engine 同步开关
  const handleWallpaperSyncToggle = (enabled: boolean) => {
    if (enabled && wallpaperRotationRef.current.enabled) {
      updateWallpaperRotation({ ...wallpaperRotationRef.current, enabled: false })
    }
    wallpaperSyncEnabledRef.current = enabled
    setWallpaperSyncEnabled(enabled)
    localStorage.setItem('wallpaperSyncEnabled', JSON.stringify(enabled))
    desktopWallpaperManager.saveSettings({ wallpaperEngineEnabled: enabled })
    window.dispatchEvent(new CustomEvent('wallpaperSyncChanged', { detail: enabled }))
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 加载用户歌单
  useEffect(() => {
    const activeUserId = currentPlatform === 'netease' ? neteaseUserId : currentPlatform === 'qq' ? qqUserId : currentPlatform === 'spotify' ? (spotifyUserId || '') : currentPlatform === 'kugou' ? (kugouUserId || '') : currentPlatform === 'soda' ? (sodaUserId || '') : ''
    const isPlatformLoggedIn = currentPlatform === 'netease'
      ? Boolean(neteaseLoggedIn && neteaseUserId)
      : currentPlatform === 'qq'
        ? Boolean(qqLoggedIn && qqUserId)
        : currentPlatform === 'apple'
          ? Boolean(appleLoggedIn)
          : currentPlatform === 'spotify'
            ? Boolean(spotifyLoggedIn)
            : currentPlatform === 'kugou'
              ? Boolean(kugouLoggedIn)
              : Boolean(sodaLoggedIn)
    const loadSignature = `${currentPlatform}:${isPlatformLoggedIn ? activeUserId : 'logged-out'}:${authRevision}`

    if (playlistLoadSignatureRef.current === loadSignature) {
      return
    }
    playlistLoadSignatureRef.current = loadSignature

    if (!isPlatformLoggedIn) {
      setLoading(false)
      setPlaylists(prev => prev.length === 0 ? prev : [])
      return
    }

    const loadPlaylists = async () => {
      setLoading(true)
      setPlaylists([]) // 清空旧数据
      
      try {
        // Apple：资料库歌单（amp-api）
        if (currentPlatform === 'apple') {
          const data = await getAppleLibraryPlaylists(100)
          const playlistData = data.map(p => ({
            id: p.id,
            name: p.name,
            coverImgUrl: p.artworkUrl || '',
            trackCount: p.trackCount || 0,
            playCount: 0,
            platform: 'apple' as const,
          }))
          setPlaylists(playlistData)
          return
        }
        if (currentPlatform === 'netease') {
          console.log(`🔄 桌面模式加载网易云歌单...`)
          const data = await getUserPlaylists('netease', neteaseUserId, neteaseUsername)
          const playlistData = data.map((p: any) => ({
            ...p,
            id: p.id,
            name: p.name,
            coverImgUrl: p.coverImgUrl,
            trackCount: p.trackCount,
            playCount: p.playCount,
            platform: 'netease' as const,
          }))
          console.log(`✅ 网易云歌单加载成功: ${playlistData.length}个`)
          setPlaylists(playlistData)
        } else if (currentPlatform === 'qq') {
          console.log(`🔄 桌面模式加载QQ音乐歌单...`)
          const data = await getUserPlaylists('qq', qqUserId, qqUsername)
          const playlistData = data.map((p: any) => ({
            ...p,
            id: p.id,
            name: p.name,
            coverImgUrl: p.coverImgUrl,
            trackCount: p.trackCount,
            platform: 'qq' as const,
            isLike: p.isLike,
          }))
          console.log(`✅ QQ音乐歌单加载成功: ${playlistData.length}个`)
          setPlaylists(playlistData)
        } else if (currentPlatform === 'spotify' || currentPlatform === 'kugou' || currentPlatform === 'soda') {
          console.log(`🔄 桌面模式加载${currentPlatform}歌单...`)
          const data = await getUserPlaylists(currentPlatform, activeUserId, currentPlatform === 'spotify' ? spotifyUsername : undefined)
          const playlistData = data.map((p: any) => ({
            ...p,
            id: p.id,
            name: p.name,
            coverImgUrl: p.coverImgUrl || p.coverUrl || '',
            trackCount: p.trackCount || 0,
            platform: currentPlatform,
          }))
          console.log(`✅ ${currentPlatform}歌单加载成功: ${playlistData.length}个`)
          setPlaylists(playlistData)
        }
      } catch (error) {
        console.error('❌ 加载歌单失败:', error)
        setPlaylists([])
      } finally {
        setLoading(false)
      }
    }
    
    loadPlaylists()
  }, [currentPlatform, neteaseLoggedIn, qqLoggedIn, appleLoggedIn, spotifyLoggedIn, kugouLoggedIn, sodaLoggedIn, neteaseUserId, qqUserId, spotifyUserId, kugouUserId, sodaUserId, neteaseUsername, qqUsername, spotifyUsername, authRevision])
  // 加载最近播放歌曲（桌面模式仅显示歌曲，与简约模式同源）
  useEffect(() => {
    const isPlatformLoggedIn = currentPlatform === 'netease'
      ? Boolean(neteaseLoggedIn && neteaseUserId)
      : currentPlatform === 'qq'
        ? Boolean(qqLoggedIn && qqUserId)
        : Boolean(appleLoggedIn)
    const loadSignature = `${currentPlatform}:${isPlatformLoggedIn ? 'in' : 'out'}:${authRevision}`
    if (recentLoadSignatureRef.current === loadSignature) return
    recentLoadSignatureRef.current = loadSignature

    if (!isPlatformLoggedIn) {
      recentLoadControllerRef.current?.abort()
      recentLoadControllerRef.current = null
      setRecentSongs([])
      setRecentCovers([])
      recentSongsRef.current = []
      recentCoversRef.current = []
      setRecentLoading(false)
      return
    }

    const controller = new AbortController()
    recentLoadControllerRef.current = controller
    // 切换平台或登录态变化时先清空旧数据，避免新平台加载完成前显示上一平台的最近播放。
    setRecentSongs([])
    setRecentCovers([])
    recentSongsRef.current = []
    recentCoversRef.current = []
    setRecentLoading(true)

    const loadRecent = async () => {
      try {
        // Apple：最近播放走 amp-api（需登录 token）
        if (currentPlatform === 'apple') {
          const tracks = await getAppleRecentPlayed(100)
          const songs = tracks.map(track => appleLibraryTrackToSong(track))
          if (controller.signal.aborted) return
          setRecentSongs(songs)
          setRecentCovers(songs.map(song => song.album.picUrl || '').filter(Boolean))
          recentSongsRef.current = songs
          recentCoversRef.current = songs.map(song => song.album.picUrl || '').filter(Boolean)
          return
        }
        const cookie = currentPlatform === 'qq'
          ? localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
          : localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        if (!cookie) {
          setRecentSongs([])
          setRecentCovers([])
          recentSongsRef.current = []
          recentCoversRef.current = []
          return
        }
        const endpoint = currentPlatform === 'qq'
          ? 'http://localhost:3001/api/qq/record/recent/song'
          : 'http://localhost:3001/api/netease/record/recent/song'
        const query = new URLSearchParams({ limit: '100', cookie })
        const response = await fetch(`${endpoint}?${query.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        const payload = await response.json()
        if (!response.ok || payload?.error) throw new Error(payload?.error || '最近播放加载失败')
        const rows = currentPlatform === 'qq'
          ? (Array.isArray(payload?.records)
              ? payload.records
              : (Array.isArray(payload?.songlist) ? payload.songlist.map((song: any) => ({ song })) : []))
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
        const songs: Song[] = rows.map((row: any): Song | null => {
          if (currentPlatform === 'qq') {
            const raw = row?.song || row
            // QQ 云端歌曲 mid 为字母数字混合，优先取数字 id；缺失时用 mid 生成稳定数字 id。
            const mid = String(raw?.mid ?? raw?.songmid ?? '')
            const numericId = Number(raw?.id ?? raw?.songid ?? raw?.songId)
            if (!mid && !Number.isFinite(numericId)) return null
            const id = Number.isFinite(numericId) && numericId > 0 ? numericId : qqRecentSongHashId(mid)
            const artists = Array.isArray(raw?.singer) ? raw.singer : (Array.isArray(raw?.artists) ? raw.artists : [])
            const albumName = raw?.album?.name || raw?.albumname || ''
            const albumPic = raw?.album?.picUrl || raw?.albumpic || raw?.picUrl || (raw?.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${raw.albummid}.jpg` : '')
            return {
              id,
              mid,
              name: raw?.songname || raw?.name || '未知歌曲',
              artists: artists.map((artist: any) => ({ id: artist?.id, name: artist?.name || artist?.singerName || '未知歌手', mid: artist?.mid })),
              album: { id: raw?.album?.id || raw?.albumid, name: albumName || '未知专辑', picUrl: albumPic, mid: raw?.albummid, pmid: raw?.album?.pmid },
              duration: Number(raw?.duration) || Number(raw?.interval || 0) * 1000,
              platform: 'qq',
              vip: raw?.pay?.payplay === 1 || false,
            }
          }
          const source = row?.resource || row?.data || row?.song || row
          const id = Number(source?.id ?? source?.song?.id ?? row?.resourceId)
          if (!Number.isFinite(id)) return null
          const songSource = source?.song || source?.data || row?.song || row?.data || source
          const artists = songSource?.ar || songSource?.artists || songSource?.singer || []
          const album = songSource?.al || songSource?.album || {}
          return {
            id,
            name: songSource?.name || songSource?.songName || '未知歌曲',
            artists: Array.isArray(artists) ? artists.map((artist: any) => ({ id: artist?.id, name: artist?.name || artist?.n || '未知歌手', mid: artist?.mid })) : [],
            album: {
              id: album?.id,
              name: album?.name || '未知专辑',
              picUrl: typeof album?.picUrl === 'string' ? album.picUrl : (typeof album?.picurl === 'string' ? album.picurl : (typeof album?.blurPicUrl === 'string' ? album.blurPicUrl : '')),
              mid: album?.mid,
              pmid: album?.pmid,
            },
            duration: Number(songSource?.dt || songSource?.duration || 0),
            platform: 'netease',
            vip: songSource?.privilege?.st === -200 || Boolean(songSource?.fee === 1),
            fee: songSource?.fee,
          }
        }).filter((song: Song | null): song is Song => Boolean(song && song.name !== '未知歌曲'))
        setRecentSongs(songs)
        recentSongsRef.current = songs
        const covers = songs.map(song => song.album.picUrl).filter(url => typeof url === 'string' && url.length > 0).slice(0, 4)
        setRecentCovers(covers)
        recentCoversRef.current = covers
      } catch (error) {
        if ((error as Error)?.name === 'AbortError') return
        console.error('❌ [DesktopView] 加载最近播放失败:', error)
        setRecentSongs([])
        setRecentCovers([])
        recentSongsRef.current = []
        recentCoversRef.current = []
      } finally {
        if (recentLoadControllerRef.current === controller) {
          recentLoadControllerRef.current = null
          setRecentLoading(false)
        }
      }
    }

    void loadRecent()
    const handleReported = () => { void loadRecent() }
    window.addEventListener('waveforge-recent-playback-reported', handleReported)
    return () => {
      controller.abort()
      window.removeEventListener('waveforge-recent-playback-reported', handleReported)
    }
  }, [currentPlatform, neteaseLoggedIn, qqLoggedIn, neteaseUserId, qqUserId, authRevision])

  // 监听 Wallpaper Engine 同步设置变化
  useEffect(() => {
    const handleWallpaperSyncChange = (e: Event) => {
      const enabled = Boolean((e as CustomEvent).detail)
      wallpaperSyncEnabledRef.current = enabled
      if (enabled && wallpaperRotationRef.current.enabled) {
        updateWallpaperRotation({ ...wallpaperRotationRef.current, enabled: false })
      }
      setWallpaperSyncEnabled(enabled)
      desktopWallpaperManager.saveSettings({ wallpaperEngineEnabled: enabled })
      window.dispatchEvent(new Event('desktopWallpaperChanged'))
    }
    
    window.addEventListener('wallpaperSyncChanged', handleWallpaperSyncChange)
    return () => window.removeEventListener('wallpaperSyncChanged', handleWallpaperSyncChange)
  }, [])
  
  // 监听卡片模糊度变化
  useEffect(() => {
    const handleBlurChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail !== undefined) {
        setCardBlurAmount(customEvent.detail)
      }
    }
    
    window.addEventListener('cardBlurAmountChanged', handleBlurChange)
    return () => window.removeEventListener('cardBlurAmountChanged', handleBlurChange)
  }, [])
  
  // 监听背景模糊度变化
  useEffect(() => {
    const handleBackgroundBlurChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail !== undefined) {
        setBackgroundBlur(customEvent.detail)
      }
    }
    
    window.addEventListener('desktopBackgroundBlurChanged', handleBackgroundBlurChange)
    return () => window.removeEventListener('desktopBackgroundBlurChanged', handleBackgroundBlurChange)
  }, [])

  useEffect(() => {
    const handleBackgroundDimChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail !== undefined) {
        setBackgroundDim(Math.max(0, Math.min(70, Number(customEvent.detail) || 0)))
      }
    }

    window.addEventListener('desktopBackgroundDimChanged', handleBackgroundDimChange)
    return () => window.removeEventListener('desktopBackgroundDimChanged', handleBackgroundDimChange)
  }, [])
  
  // 监听不支持的壁纸类型警告
  useEffect(() => {
    const handleUnsupportedWallpaper = (e: Event) => {
      console.log('[DesktopView] Received unsupportedWallpaper event!')
      const customEvent = e as CustomEvent
      const { sourceType, title } = customEvent.detail || {}
      console.warn('[DesktopView] Unsupported wallpaper detected:', sourceType)
      // 按类型给出更准确的提示（Wallpaper Engine 场景/程序壁纸无法在浏览器中实时渲染，
      // 只会显示静态预览图）
      const typeMessages: Record<string, string> = {
        scene: '3D 场景壁纸',
        application: '程序壁纸',
        web: '网页壁纸',
        unknown: '动态壁纸',
      }
      const label = typeMessages[sourceType as string] || '动态壁纸'
      const name = title ? `「${title}」` : ''
      showToastNotification(`Wallpaper Engine ${name}${label}无法实时同步，已显示静态预览`, 'warning')
    }
    
    console.log('[DesktopView] Setting up unsupportedWallpaper listener')
    window.addEventListener('unsupportedWallpaper', handleUnsupportedWallpaper)
    return () => {
      console.log('[DesktopView] Removing unsupportedWallpaper listener')
      window.removeEventListener('unsupportedWallpaper', handleUnsupportedWallpaper)
    }
  }, [])
  
  // 智能音频冲突处理：当音乐开始播放时，自动静音壁纸音频
  useEffect(() => {
    if (isPlaying && !videoMuted && videoRef.current) {
      console.log('[DesktopView] Music started playing, auto-muting wallpaper audio')
      setVideoMuted(true)
      localStorage.setItem('desktopVideoMuted', JSON.stringify(true))
      if (videoRef.current) {
        videoRef.current.muted = true
      }
      showToastNotification('已自动静音壁纸音频', 'info')
    }
  }, [isPlaying])

  // 桌面壁纸加载 - 使用新的壁纸管理器
  useEffect(() => {
    const loadWallpaper = async (forceReload = false) => {
      const wallpaper = await desktopWallpaperManager.getCurrentWallpaper()
      let nextSignature = 'none'
      
      if (typeof wallpaper === 'string') {
        // 字符串类型：Wallpaper Engine 路径或随机图片 URL
        // 本地路径可能是 UNC（\\server\share\...），统一规范化为可渲染的 URL
        const wallpaperUrl = toWallpaperUrl(wallpaper)
        nextSignature = `image:${wallpaperUrl}`
        if (!forceReload && wallpaperSourceRef.current === nextSignature) return
        wallpaperSourceRef.current = nextSignature
        setDesktopLiveWallpaper(null)
        setDesktopWallpaper(wallpaperUrl)
      } else if (isDesktopLiveWallpaperSource(wallpaper)) {
        nextSignature = `live:${wallpaper.sourceType}:${wallpaper.url}:${wallpaper.path}`
        if (!forceReload && wallpaperSourceRef.current === nextSignature) return
        wallpaperSourceRef.current = nextSignature
        setDesktopWallpaper(null)
        setDesktopLiveWallpaper(wallpaper)
        
        // 如果是视频壁纸且音乐正在播放，自动静音壁纸音频
        if (wallpaper.sourceType === 'video' && isPlaying) {
          console.log('[DesktopView] Music is playing, auto-muting video wallpaper')
          setVideoMuted(true)
          localStorage.setItem('desktopVideoMuted', JSON.stringify(true))
          scheduleTransientTimer(() => {
            if (videoRef.current) {
              videoRef.current.muted = true
            }
          }, 100)
        }
        return
      } else if (wallpaper && typeof wallpaper === 'object') {
        // 对象类型：上传的文件
        nextSignature = `image:${wallpaper.id}:${wallpaper.dataUrl.length}`
        if (!forceReload && wallpaperSourceRef.current === nextSignature) return
        wallpaperSourceRef.current = nextSignature
        setDesktopLiveWallpaper(null)
        setDesktopWallpaper(wallpaper.dataUrl)
      } else {
        if (!forceReload && wallpaperSourceRef.current === nextSignature) return
        wallpaperSourceRef.current = nextSignature
        setDesktopLiveWallpaper(null)
        setDesktopWallpaper(null)
      }
      
      // 更新key以触发切换动画
      setWallpaperKey(prev => prev + 1)
    }
    
    // 组件挂载时强制重新加载壁纸，确保显示正确的壁纸设置
    console.log('[DesktopView] 组件挂载，强制重新加载壁纸')
    loadWallpaper(true)
    
    // 监听壁纸变化
    const handleWallpaperChange = () => {
      console.log('[DesktopView] 收到壁纸变化事件，强制重新加载')
      loadWallpaper(true) // 强制重新加载
    }
    
    window.addEventListener('desktopWallpaperChanged', handleWallpaperChange)
    
    // 监听来自 Electron 的壁纸变化（用于 Wallpaper Engine 同步）
    const unsubscribeWallpaper = window.electron?.wallpaper?.onWallpaperChange
      ? window.electron.wallpaper.onWallpaperChange((wallpaper) => {
        console.log('🖼️ 系统壁纸已变化:', wallpaper)
        const settings = desktopWallpaperManager.getSettings()
        const engine = typeof wallpaper === 'string' ? null : wallpaper.wallpaperEngine
        
        // 检查是否是不支持的壁纸类型
        if (settings.wallpaperEngineEnabled && engine?.unsupported) {
          console.warn('[DesktopView] Unsupported wallpaper type:', engine.sourceType)
          const typeMessages: Record<string, string> = {
            scene: '3D 场景壁纸',
            application: '程序壁纸',
            web: '网页壁纸',
            unknown: '动态壁纸',
          }
          const label = typeMessages[engine.sourceType] || '动态壁纸'
          const name = engine.title ? `「${engine.title}」` : ''
          showToastNotification(`Wallpaper Engine ${name}${label}无法实时同步，已显示静态预览`, 'warning')
          // 回退到系统壁纸
          const nextWallpaper = typeof wallpaper === 'string'
            ? wallpaper
            : wallpaper.dataUrl || wallpaper.fileUrl || wallpaper.path
          if (nextWallpaper) {
            const nextSignature = `image:${nextWallpaper}`
            if (wallpaperSourceRef.current === nextSignature) return
            wallpaperSourceRef.current = nextSignature
            setDesktopLiveWallpaper(null)
            setDesktopWallpaper(nextWallpaper)
            setWallpaperKey(prev => prev + 1)
          }
          return
        }
        
        // 检查是否是 Wallpaper Engine 的 video 类型（支持动态壁纸）
        if (settings.wallpaperEngineEnabled && engine && engine.sourceType === 'video') {
          const nextLiveWallpaper = {
            kind: 'wallpaper-engine',
            sourceType: engine.sourceType,
            url: engine.mediaUrl || engine.fileUrl,
            path: engine.path,
            title: engine.title || '动态壁纸'
          } as DesktopLiveWallpaperSource
          const nextSignature = `live:${nextLiveWallpaper.sourceType}:${nextLiveWallpaper.url}:${nextLiveWallpaper.path}`
          if (wallpaperSourceRef.current === nextSignature) return
          wallpaperSourceRef.current = nextSignature
          setDesktopWallpaper(null)
          setDesktopLiveWallpaper(prev => {
            if (prev && prev.sourceType === nextLiveWallpaper.sourceType && prev.url === nextLiveWallpaper.url && prev.path === nextLiveWallpaper.path) {
              return prev
            }
            return nextLiveWallpaper
          })
          
          // 如果音乐正在播放，自动静音壁纸音频
          if (isPlaying) {
            console.log('[DesktopView] Music is playing, auto-muting video wallpaper from Wallpaper Engine')
            setVideoMuted(true)
            localStorage.setItem('desktopVideoMuted', JSON.stringify(true))
            scheduleTransientTimer(() => {
              if (videoRef.current) {
                videoRef.current.muted = true
              }
            }, 100)
          }
          return
        }
        
        // 处理静态图片壁纸
        const nextWallpaper = typeof wallpaper === 'string'
          ? wallpaper
          : wallpaper.dataUrl || wallpaper.fileUrl || wallpaper.path
        if (settings.wallpaperEngineEnabled && nextWallpaper) {
          const nextSignature = `image:${nextWallpaper}`
          if (wallpaperSourceRef.current === nextSignature) return
          wallpaperSourceRef.current = nextSignature
          setDesktopLiveWallpaper(null)
          setDesktopWallpaper(toWallpaperUrl(nextWallpaper))
          setWallpaperKey(prev => prev + 1)
        }
      })
      : undefined
    
    // 启动自动切换
    desktopWallpaperManager.startAutoSwitch()
    desktopWallpaperManager.switchOnStartup()
    
    return () => {
      window.removeEventListener('desktopWallpaperChanged', handleWallpaperChange)
      unsubscribeWallpaper?.()
      desktopWallpaperManager.stopAutoSwitch()
    }
  }, [])

  // 监听当前歌曲变化，如果有歌曲正在播放则显示迷你播放器。
  // 歌词直接复用播放页已经加载并校准过的数据，避免桌面模式二次请求产生不同结果。
  useEffect(() => {
    if (currentSong) {
      setShowDesktopMiniPlayer(true)
    }
  }, [currentSong])

  // 切换平台
  const handlePlatformSwitch = () => {
    const order = getVisiblePlatforms()
    const next = order[(order.indexOf(currentPlatform) + 1) % order.length]
    setCurrentPlatform(next)
    localStorage.setItem('desktopModePlatform', next)
  }

  const closePlaylistDetail = useCallback(() => {
    playlistLoadControllerRef.current?.abort()
    playlistLoadControllerRef.current = null
    setLoadingPlaylistSongs(false)
    setShowPlaylistDetail(false)
  }, [])

  const closePlaylistCarousel = useCallback(() => {
    if (hideCarouselTimerRef.current) {
      clearTimeout(hideCarouselTimerRef.current)
      transientTimersRef.current.delete(hideCarouselTimerRef.current)
      hideCarouselTimerRef.current = null
    }
    setShowPlaylistCarousel(false)
    closePlaylistDetail()
  }, [closePlaylistDetail])

  // TV 遥控器 BACK：按层级关闭 歌单详情 → 设置/搜索 → 模式面板 → 切换模式
  useTvBack(() => {
    if (showPlaylistDetail) {
      closePlaylistDetail()
      return true
    }
    if (showSettings) {
      setShowSettings(false)
      return true
    }
    if (showSearch) {
      setShowSearch(false)
      return true
    }
    if (showDesktopCustomizer) {
      setShowDesktopCustomizer(false)
      return true
    }
    if (showThemePanel) {
      setThemePanelSettled(false)
      setShowThemePanel(false)
      return true
    }
    return false
  }, [showPlaylistDetail, showSettings, showSearch, showDesktopCustomizer, showThemePanel, closePlaylistDetail])

  const handleWidgetOverlayChange = useCallback((side: 'left' | 'right', open: boolean) => {
    if (open) {
      closePlaylistCarousel()
      setWidgetOverlaySide(side)
      return
    }
    setWidgetOverlaySide(current => current === side ? null : current)
  }, [closePlaylistCarousel])

  const handleLeftWidgetOverlayChange = useCallback((open: boolean) => handleWidgetOverlayChange('left', open), [handleWidgetOverlayChange])
  const handleRightWidgetOverlayChange = useCallback((open: boolean) => handleWidgetOverlayChange('right', open), [handleWidgetOverlayChange])

  // 小白条 hover 处理 - 显示歌单栏
  const handleBottomBarMouseEnter = () => {
    setShowPlaylistCarousel(true)
    // 清除可能存在的隐藏定时器
    if (hideCarouselTimerRef.current) {
      clearTimeout(hideCarouselTimerRef.current)
      transientTimersRef.current.delete(hideCarouselTimerRef.current)
      hideCarouselTimerRef.current = null
    }
  }

  // 歌单栏区域 hover 处理
  const handleCarouselMouseEnter = () => {
    // 清除隐藏定时器
    if (hideCarouselTimerRef.current) {
      clearTimeout(hideCarouselTimerRef.current)
      transientTimersRef.current.delete(hideCarouselTimerRef.current)
      hideCarouselTimerRef.current = null
    }
  }

  const handleCarouselMouseLeave = () => {
    // 如果没有打开歌单详情弹窗，4秒后隐藏
    if (!showPlaylistDetail) {
      hideCarouselTimerRef.current = scheduleTransientTimer(() => {
        hideCarouselTimerRef.current = null
        setShowPlaylistCarousel(false)
      }, 4000)
    }
  }

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hideCarouselTimerRef.current) {
        clearTimeout(hideCarouselTimerRef.current)
        transientTimersRef.current.delete(hideCarouselTimerRef.current as unknown as number)
        hideCarouselTimerRef.current = null
      }
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current)
        transientTimersRef.current.delete(toastTimerRef.current as unknown as number)
        toastTimerRef.current = null
      }
      transientTimersRef.current.forEach(timer => window.clearTimeout(timer))
      transientTimersRef.current.clear()
      wallpaperScanControllerRef.current?.abort()
      wallpaperScanControllerRef.current = null
      playlistLoadControllerRef.current?.abort()
      stopAlarmSound()
    }
  }, [stopAlarmSound])

  // 选择歌单
  const handlePlaylistSelect = useCallback(async (playlist: Playlist) => {
    playlistLoadControllerRef.current?.abort()
    // 最近播放：直接使用已加载的最近播放歌曲，不走歌单接口
    if (playlist.isRecent || String(playlist.id) === '__recent__') {
      const recentSongsList = recentSongsRef.current
      setSelectedPlaylist({
        ...playlist,
        covers: recentCoversRef.current,
        trackCount: recentSongsList.length,
      })
      setShowPlaylistDetail(true)
      setLoadingPlaylistSongs(false)
      setPlaylistSongs(recentSongsList)
      if (hideCarouselTimerRef.current) {
        clearTimeout(hideCarouselTimerRef.current)
        transientTimersRef.current.delete(hideCarouselTimerRef.current)
        hideCarouselTimerRef.current = null
      }
      return
    }
    const playlistLoadController = new AbortController()
    playlistLoadControllerRef.current = playlistLoadController
    setSelectedPlaylist(playlist)
    setShowPlaylistDetail(true)
    setLoadingPlaylistSongs(true)
    setPlaylistSongs([])
    
    // 清除隐藏定时器，保持歌单栏显示
    if (hideCarouselTimerRef.current) {
      clearTimeout(hideCarouselTimerRef.current)
      transientTimersRef.current.delete(hideCarouselTimerRef.current)
      hideCarouselTimerRef.current = null
    }
    
    try {
      if (currentPlatform === 'apple') {
        // Apple：目录歌单（pl. 前缀）走 catalog，资料库歌单走 me/library
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const playlistId = String(playlist.id || '')
        const tracks = playlistId.startsWith('pl.')
          ? await getAppleCatalogPlaylistTracks(playlistId, storefront)
          : await getApplePlaylistTracks(playlistId)
        if (playlistLoadController.signal.aborted || playlistLoadControllerRef.current !== playlistLoadController) return
        const songs = tracks.map(track => appleSongToSong(track, storefront))
        setPlaylistSongs(songs)
      } else if (currentPlatform === 'netease') {
        await streamNeteasePlaylistTracks(playlist.id, {
          signal: playlistLoadController.signal,
          firstPageSize: 120,
          pageSize: 200,
          onPage: (page, firstPage) => {
            if (playlistLoadController.signal.aborted || playlistLoadControllerRef.current !== playlistLoadController) return
            const pageSongs: Song[] = page.tracks.map((track: any) => ({
              id: track.id,
              name: track.name,
              artists: track.ar || track.artists || [],
              album: track.al || track.album || {},
              duration: track.dt || track.duration || 0,
              platform: 'netease',
              vip: track.vip || false,
              fee: track.fee || 0
            }))
            setSelectedPlaylist(current => current ? { ...current, trackCount: page.total } : current)
            setPlaylistSongs(current => {
              if (firstPage) return pageSongs
              const seen = new Set(current.map(song => String(song.id)))
              return [...current, ...pageSongs.filter(song => !seen.has(String(song.id)))]
            })
            if (firstPage) setLoadingPlaylistSongs(false)
          },
        })
      } else if (currentPlatform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie') || ''
        const response = await fetch(`http://localhost:3001/api/qq/playlist/detail?id=${playlist.id}&cookie=${encodeURIComponent(cookie)}`, {
          signal: playlistLoadController.signal,
          cache: 'no-store',
        })
        if (!response.ok) throw new Error(`QQ 歌单加载失败 (${response.status})`)
        const data = await response.json()
        if (playlistLoadController.signal.aborted || playlistLoadControllerRef.current !== playlistLoadController) return
        if (data.songlist) {
        console.log(`📝 [DesktopView] QQ音乐歌单包含 ${data.songlist.length} 首歌曲`)
        const songs: Song[] = data.songlist.map((track: any) => ({
          id: track.songid || track.id,
          mid: track.songmid || track.mid,
          name: track.songname || track.name,
          artists: track.singer || [],
          album: {
            name: track.albumname || track.album?.name || '',
            picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : '')
          },
          // 本地服务已将 QQ 歌曲时长统一为毫秒；兼容旧接口的秒制 interval。
          duration: Number(track.duration) || Number(track.interval || 0) * 1000,
          platform: 'qq',
          vip: track.pay?.payplay === 1 || false
        }))
        console.log(`✅ [DesktopView] 设置了 ${songs.length} 首歌曲到 playlistSongs`)
        setPlaylistSongs(songs)
        }
      } else if (currentPlatform === 'soda') {
        // 汽水：经 playlistService 统一详情（分页合并全量曲目，支持 qishui-liked 等虚拟歌单 id）
        const data = await getPlaylistDetail(String(playlist.id || ''), 'soda')
        if (playlistLoadController.signal.aborted || playlistLoadControllerRef.current !== playlistLoadController) return
        const detailed = { ...playlist, ...data?.playlist, isCollected: playlist.isCollected }
        setSelectedPlaylist(previous => previous ? { ...previous, ...detailed } : detailed)
        setPlaylistSongs(Array.isArray(data?.tracks) ? data.tracks : [])
      }
    } catch (error) {
      if ((error as Error).name !== 'AbortError') console.error('加载歌单详情失败:', error)
    } finally {
      if (playlistLoadControllerRef.current === playlistLoadController) {
        playlistLoadControllerRef.current = null
        setLoadingPlaylistSongs(false)
      }
    }
  }, [currentPlatform])

  const removeSongFromVisiblePlaylist = (song: Song) => {
    setPlaylistSongs(previous => previous.filter(item => !(
      String(item.id) === String(song.id) && (item.platform || currentPlatform) === (song.platform || currentPlatform)
    )))
    setSelectedPlaylist(previous => previous ? {
      ...previous,
      trackCount: Math.max(0, Number(previous.trackCount || 0) - 1),
    } : previous)
  }

  const handleRemoveFromCurrentPlaylist = async (song: Song) => {
    if (!selectedPlaylist) return

    if (selectedPlaylist.isLike) {
      const removed = await onRemoveFromFavorites?.(song)
      if (removed === false) return
      removeSongFromVisiblePlaylist(song)
      showToastNotification('已从我喜欢中移除', 'success')
      return
    }

    const userId = currentPlatform === 'netease' ? neteaseUserId : currentPlatform === 'qq' ? qqUserId : ''
    // Apple：从资料库歌单移除曲目（amp-api）
    if (currentPlatform === 'apple') {
      try {
        const appleSongId = song.appleId || String(song.id)
        const ok = await removeAppleTracksFromPlaylist(String(selectedPlaylist.dirId || selectedPlaylist.id || ''), [appleSongId])
        if (!ok) throw new Error('从 Apple 歌单移除歌曲失败，请检查登录状态')
        removeSongFromVisiblePlaylist(song)
        showToastNotification('已从 Apple 歌单移除歌曲', 'success')
      } catch (error) {
        console.error('Desktop Apple playlist song removal failed:', error)
        showToastNotification(error instanceof Error ? error.message : '从歌单移除歌曲失败，请重试', 'error')
        throw error
      }
      return
    }
    const playlistOwnerId = selectedPlaylist.userId == null ? '' : String(selectedPlaylist.userId)
    if (selectedPlaylist.isCollected || (playlistOwnerId && playlistOwnerId !== String(userId || ''))) return

    try {
      const result = await removeSongFromPlaylist(
        String(selectedPlaylist.dirId || selectedPlaylist.id),
        String(song.id),
        userId || '',
        currentPlatform,
        { songMid: song.mid, songType: song.songType },
      )
      const succeeded = result && !result.error && (
        result.code === undefined || result.code === 0 || result.code === 200 || result.result === 0 || result.result === 100
      )
      if (!succeeded) throw new Error(result?.error || result?.message || '从歌单移除歌曲失败')
      removeSongFromVisiblePlaylist(song)
      showToastNotification('已从歌单移除歌曲', 'success')
    } catch (error) {
      console.error('Desktop playlist song removal failed:', error)
      showToastNotification(error instanceof Error ? error.message : '从歌单移除歌曲失败，请重试', 'error')
      throw error
    }
  }

  const canRemoveFromCurrentPlaylist = Boolean(
    selectedPlaylist && !selectedPlaylist.isRecent && !selectedPlaylist.isLike && !selectedPlaylist.isCollected && (
      selectedPlaylist.userId == null || String(selectedPlaylist.userId) === String(currentPlatform === 'netease' ? neteaseUserId : qqUserId)
    )
  )

  // 播放歌曲 - 关闭歌单详情，显示迷你播放器，4秒后隐藏歌单栏
  const handlePlaySong = (song: Song) => {
    onSongSelect(song, playlistSongs, {
      surface: 'desktop-playlist',
      playlist: selectedPlaylist,
      songs: playlistSongs,
    })
    closePlaylistDetail() // 关闭歌单详情弹窗并取消未完成的分页请求
    setShowDesktopMiniPlayer(true) // 显示桌面迷你播放器
    
    // 4秒后隐藏歌单栏
    hideCarouselTimerRef.current = scheduleTransientTimer(() => {
      hideCarouselTimerRef.current = null
      setShowPlaylistCarousel(false)
    }, 4000)
  }

  // 播放全部
  const handlePlayAll = () => {
    if (playlistSongs.length > 0) {
      onSongSelect(playlistSongs[0], playlistSongs, {
        surface: 'desktop-playlist',
        playlist: selectedPlaylist,
        songs: playlistSongs,
      })
      closePlaylistDetail()
      setShowDesktopMiniPlayer(true)
      
      // 4秒后隐藏歌单栏
      hideCarouselTimerRef.current = scheduleTransientTimer(() => {
        hideCarouselTimerRef.current = null
        setShowPlaylistCarousel(false)
      }, 4000)
    }
  }
  
  // 格式化时长
  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // 最近播放入口卡片（放在用户喜欢歌单左侧；默认聚焦仍是用户喜欢歌单）
  const recentEntry: Playlist | null = (currentPlatform === 'netease'
      ? Boolean(neteaseLoggedIn && neteaseUserId)
      : Boolean(qqLoggedIn && qqUserId)) && recentSongs.length > 0
    ? {
        id: '__recent__',
        name: '最近播放',
        coverImgUrl: recentCovers[0] || '',
        covers: recentCovers,
        trackCount: recentSongs.length,
        platform: currentPlatform,
        isRecent: true,
      }
    : null
  const desktopOverlayOpen = widgetOverlaySide !== null
    || showSettings
    || showDesktopCustomizer
    || showSearch
    || showLogin
    || showThemePanel
    || showPlaylistDetail
    || focusTimer.timer.status === 'ringing'

  // 桌面融合穿透：光标悬停在组件上时窗口可交互，空区域点击穿透到真实桌面。
  // 利用 setIgnoreMouseEvents(true,{forward:true}) 的 mousemove 转发，由页面实时判定交互区。
  // 可交互区域用 data-desktop-interactive / .desktop-widget-card / .desktop-lyrics-fusion 标记，
  // 其余（透明背景、卡片间隙、容器骨架）一律穿透，让真实桌面图标/任务栏可点。
  // 弹层/面板打开时整窗强制交互——弹层覆盖全屏，此时任何点击都属于应用本身。
  useEffect(() => {
    if (!desktopFusionEnabled) return
    let lastSend = 0
    const INTERACTIVE_SELECTOR = '.desktop-widget-card, .desktop-lyrics-fusion, [data-desktop-interactive]'
    // 判定光标下的元素是否属于"可交互 UI"：
    // 1) 命中标记（组件卡片/歌词/歌单栏/迷你播放器/标题栏等）
    // 2) 命中任意 position:fixed 的元素——全屏弹层（设备控制/遥控器/歌曲详情/登录提示/
    //    更新提示等）与标题栏都是 fixed。DesktopView 之外的 App 级弹层不在
    //    desktopOverlayOpen 状态里，必须靠这里通用覆盖：弹层打开时所有点击都属于应用，
    //    融合穿透只在透明空区域生效。
    const isInteractiveElement = (target: Element | null): boolean => {
      if (!target || !target.closest) return false
      if (target.closest(INTERACTIVE_SELECTOR)) return true
      let node: Element | null = target
      while (node && node !== document.body) {
        if (node.nodeType === 1 && window.getComputedStyle(node).position === 'fixed') return true
        node = node.parentElement
      }
      return false
    }
    const onMouseMove = (event: MouseEvent) => {
      const now = Date.now()
      if (now - lastSend < 40) return // 节流 IPC
      lastSend = now
      if (desktopOverlayOpen) {
        window.electron?.desktopFusion?.setInteractive(true)
        return
      }
      const target = document.elementFromPoint(event.clientX, event.clientY) as Element | null
      window.electron?.desktopFusion?.setInteractive(isInteractiveElement(target))
    }
    window.electron?.desktopFusion?.setInteractive(desktopOverlayOpen) // 初始态：弹层开则整窗交互，否则穿透等 mousemove
    document.addEventListener('mousemove', onMouseMove)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      window.electron?.desktopFusion?.setInteractive(false)
    }
  }, [desktopFusionEnabled, desktopOverlayOpen])

  const widgetHandlersRef = useRef({
    onVolumeChange,
    onPlayPause,
    onNext,
    onSongSelect,
    onRemoveQueueItem,
    onMoveQueueItem,
    onPlaylistSelect: handlePlaylistSelect,
    onOpenArtist,
  })
  widgetHandlersRef.current = {
    onVolumeChange,
    onPlayPause,
    onNext,
    onSongSelect,
    onRemoveQueueItem,
    onMoveQueueItem,
    onPlaylistSelect: handlePlaylistSelect,
    onOpenArtist,
  }

  const handleWidgetVolumeChange = useCallback((nextVolume: number) => widgetHandlersRef.current.onVolumeChange(nextVolume), [])
  const handleWidgetPlayPause = useCallback(() => widgetHandlersRef.current.onPlayPause(), [])
  const handleWidgetNext = useCallback(() => widgetHandlersRef.current.onNext(), [])
  const handleWidgetSongSelect = useCallback((song: Song, songs?: Song[]) => { void widgetHandlersRef.current.onSongSelect(song, songs) }, [])
  const handleWidgetRemoveQueueItem = useCallback((index: number) => widgetHandlersRef.current.onRemoveQueueItem(index), [])
  const handleWidgetMoveQueueItem = useCallback((from: number, to: number) => widgetHandlersRef.current.onMoveQueueItem(from, to), [])
  const handleWidgetPlaylistSelect = useCallback((playlist: DesktopMusicWidgetContext['playlists'][number]) => { void widgetHandlersRef.current.onPlaylistSelect(playlist as Playlist) }, [])
  const handleWidgetOpenArtist = useCallback((artistId: string, platform: MusicPlatform) => widgetHandlersRef.current.onOpenArtist?.(artistId, platform), [])

  const desktopMusicWidgetContext = useMemo<DesktopMusicWidgetContext>(() => ({
    currentSong,
    isPlaying,
    queue: playbackQueue,
    currentIndex,
    playlists,
    platform: currentPlatform,
    volume,
    onVolumeChange: handleWidgetVolumeChange,
    onPlayPause: handleWidgetPlayPause,
    onNext: handleWidgetNext,
    onSongSelect: handleWidgetSongSelect,
    onRemoveQueueItem: handleWidgetRemoveQueueItem,
    onMoveQueueItem: handleWidgetMoveQueueItem,
    onPlaylistSelect: handleWidgetPlaylistSelect,
    onOpenArtist: handleWidgetOpenArtist,
  }), [currentSong, isPlaying, playbackQueue, currentIndex, playlists, currentPlatform, volume, handleWidgetVolumeChange, handleWidgetPlayPause, handleWidgetNext, handleWidgetSongSelect, handleWidgetRemoveQueueItem, handleWidgetMoveQueueItem, handleWidgetPlaylistSelect, handleWidgetOpenArtist])

  return (
    <div
      className="absolute inset-0 h-full w-full overflow-hidden"
      style={{ backgroundColor: 'transparent' }}
    >
      {/* 全局 Toast 通知 */}
      <GlobalToast 
        show={showToast} 
        message={toastMessage} 
        type={toastType}
        onClose={() => setShowToast(false)}
      />
      
      {/* 背景层（桌面融合穿透开启时隐藏，让真实桌面壁纸透出） */}
      {!desktopFusionEnabled && <div className="absolute inset-0 z-0" style={{ 
        opacity: 1, 
        transform: 'translate3d(0, 0, 0)',
        backfaceVisibility: 'hidden',
        willChange: 'auto',
        isolation: 'isolate',
        contain: 'layout style paint'
      }}>
        {desktopLiveWallpaper ? (
          <div className="absolute inset-0 overflow-hidden" style={{
            transform: 'translateZ(0)',
            willChange: 'auto'
          }}>
            {desktopLiveWallpaper.sourceType === 'video' ? (
              <video
                key={desktopVideoUrl}
                ref={setDesktopVideoRef}
                className="absolute inset-0 h-full w-full object-cover"
                style={{
                  filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : 'none',
                  transform: `translate3d(0, 0, 0) scale(${1 + backgroundBlur / 220})`,
                  transformOrigin: 'center center',
                  willChange: backgroundBlur > 0 ? 'transform, filter' : 'auto',
                  isolation: 'isolate'
                }}
                src={desktopLiveWallpaper.url}
                autoPlay
                loop
                muted={videoMuted}
                playsInline
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget
                  // 检测视频是否真的有视频轨道（videoWidth > 0）
                  if (video.videoWidth === 0 || video.videoHeight === 0) {
                    console.warn('[DesktopView] 视频格式不支持（可能是 H.265 编码）', {
                      src: video.src,
                      videoWidth: video.videoWidth,
                      videoHeight: video.videoHeight,
                      readyState: video.readyState
                    })
                    setVideoUnsupported(true)
                    showToastNotification('该视频格式不受设备支持 (H.265)，正在切换到下一个壁纸...', 'warning')
                    // 延迟 1 秒后切换到下一个壁纸
                    scheduleTransientTimer(() => {
                      skipToNextWallpaper()
                    }, 1500)
                  } else {
                    console.log('[DesktopView] 视频加载成功:', {
                      videoWidth: video.videoWidth,
                      videoHeight: video.videoHeight,
                      duration: video.duration
                    })
                    setVideoUnsupported(false)
                  }
                }}
                onError={(e) => {
                  console.error('[DesktopView] 视频加载错误:', e)
                  setVideoUnsupported(true)
                  showToastNotification('视频加载失败，正在切换到下一个壁纸...', 'error')
                  scheduleTransientTimer(() => {
                    skipToNextWallpaper()
                  }, 1500)
                }}
              />
            ) : (
              <iframe
                className="absolute inset-0 h-full w-full border-0"
                style={{
                  filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : 'none',
                  transform: `translate3d(0, 0, 0) scale(${1 + backgroundBlur / 220})`,
                  transformOrigin: 'center center',
                  willChange: backgroundBlur > 0 ? 'transform, filter' : 'auto',
                  isolation: 'isolate'
                }}
                src={desktopLiveWallpaper.url}
                title={desktopLiveWallpaper.title || 'Wallpaper Engine wallpaper'}
                sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
                allow="autoplay; fullscreen"
              />
            )}
          </div>
        ) : desktopWallpaper ? (
          <div
            className="absolute inset-0 bg-cover bg-center"
            style={{ 
              backgroundImage: `url(${desktopWallpaper})`,
              filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : 'none',
              opacity: 1,
              transform: `translate3d(0, 0, 0) scale(${1 + backgroundBlur / 220})`,
              transformOrigin: 'center center',
              backfaceVisibility: 'hidden',
              willChange: backgroundBlur > 0 ? 'transform, filter' : 'transform'
            }}
          />
        ) : (
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(135deg, #0f0c29 0%, #302b63 52%, #24243e 100%)',
              filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : 'none',
              transform: `translate3d(0, 0, 0) scale(${1 + backgroundBlur / 220})`,
              transformOrigin: 'center center',
              backfaceVisibility: 'hidden'
            }}
          />
        )}
      </div>}

      {backgroundDim > 0 && !desktopFusionEnabled && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-[1] bg-black"
          style={{ opacity: backgroundDim / 100 }}
        />
      )}

      <motion.div
        className="absolute inset-0 z-[2]"
        animate={{ y: showThemePanel ? MODE_SELECTION_PANEL_HEIGHT : 0 }}
        transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
        style={{ willChange: 'transform', backfaceVisibility: 'hidden', transform: 'translateZ(0)' }}
      >

      <DesktopWidgetZone
        side="left"
        settings={desktopCustomization}
        cardBlurAmount={cardBlurAmount}
        accentColor={desktopAccentColor}
        onOverlayOpenChange={handleLeftWidgetOverlayChange}
        layerState={widgetOverlaySide === null ? 'base' : widgetOverlaySide === 'left' ? 'active' : 'behind'}
        musicContext={desktopMusicWidgetContext}
      />
      <DesktopWidgetZone
        side="right"
        settings={desktopCustomization}
        cardBlurAmount={cardBlurAmount}
        accentColor={desktopAccentColor}
        onOverlayOpenChange={handleRightWidgetOverlayChange}
        layerState={widgetOverlaySide === null ? 'base' : widgetOverlaySide === 'right' ? 'active' : 'behind'}
        musicContext={desktopMusicWidgetContext}
      />

      <AnimatePresence>
        {showDesktopLyrics && currentSong && (
          <motion.div
            key={`desktop-lyrics-${currentSong.id || currentSong.mid}-${desktopCustomization.desktopLyricStyle}-${desktopCustomization.traditionalLyricSize}-${desktopCustomization.modernLyricSize}`}
            initial={{ opacity: 0, scale: 0.985, filter: 'blur(12px)' }}
            animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
            exit={{ opacity: 0, scale: 0.985, filter: 'blur(12px)' }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className={`desktop-lyrics-fusion absolute z-20 flex items-center justify-center overflow-hidden ${isTvUi ? 'bottom-72' : 'bottom-16'}`}
            style={{
              top: 'clamp(178px, 19vh, 224px)',
              left: '6vw',
              right: '6vw',
            }}
          >
            <div
              className={`relative h-full w-full ${isTvUi ? 'max-h-[420px]' : 'max-h-[680px]'}`}
              style={{
                maxWidth: desktopCustomization.left.length > 0 || desktopCustomization.right.length > 0
                  ? 'min(1080px, 54vw)'
                  : 'min(1180px, 74vw)',
              }}
            >
              {lyrics.length > 0 ? (
                <LyricsDisplay
                  lyrics={lyrics}
                  currentTime={currentTime}
                  isPlaying={isPlaying}
                  accentColor={desktopAccentColor}
                  translationEnabled={desktopCustomization.desktopLyricStyle === 'traditional'}
                  translationPosition="traditional"
                  romanEnabled={desktopCustomization.desktopLyricStyle === 'traditional'}
                  displayMode={desktopCustomization.desktopLyricStyle === 'modern' ? 'single' : 'scroll'}
                  scrollAlignment="center"
                  layoutContext="desktop"
                  lyricSizeOverride={desktopCustomization.desktopLyricStyle === 'modern' ? desktopCustomization.modernLyricSize : desktopCustomization.traditionalLyricSize}
                  wordByWordEnabledOverride
                  wordByWordEffectModeOverride={desktopCustomization.desktopLyricStyle === 'modern' ? 'soft' : 'clear'}
                  lyricGlowOverride={desktopCustomization.desktopLyricStyle === 'modern'}
                  animationModeOverride="elegant"
                  singlePlacementMode="centered"
                  immersiveEffect={desktopCustomization.desktopLyricStyle === 'modern' ? 'soft-focus' : undefined}
                  immersiveAvoidTopLeft={false}
                  backgroundEffect="immersive"
                  trackId={currentSong.id || currentSong.mid}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xl font-medium tracking-[0.2em] text-white/45">
                  当前歌曲暂无歌词
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 顶部主题切换触发区域 - 面板关闭时的下箭头 */}
      <div 
        className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-8 z-50"
        data-desktop-interactive
        onMouseEnter={() => setIsTopHovered(true)}
        onMouseLeave={() => setIsTopHovered(false)}
      >
        <AnimatePresence>
          {(topBarActive || showUpArrowHint) && !showThemePanel && (
            <motion.button
              aria-label="打开模式选择"
              data-tv-focus
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              onClick={() => {
                setThemePanelSettled(false)
                setShowThemePanel(true)
                setShowUpArrowHint(false)
              }}
              className="absolute top-0 left-1/2 -translate-x-1/2 bg-white/10 backdrop-blur-md rounded-b-2xl border border-white/20 border-t-0 hover:bg-white/20 transition-colors"
              style={{ width: '200px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              whileHover={{ backgroundColor: 'rgba(255, 255, 255, 0.25)' }}
              whileTap={{ scale: 0.98 }}
            >
              <div>
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                </svg>
              </div>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* 主题面板 + 面板内上箭头 */}
      <AnimatePresence>
        {showThemePanel && (
          <ModeSelectionPanel
            currentMode="desktop"
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

      {/* 主内容区 - 移除外部歌单栏，只保留小白条触发的歌单栏 */}
      {/* 此 div 已废弃，保留仅用于主题面板动画效果，但不应影响渲染 */}

      {/* 歌单轮播区域 + 控制按钮 - 在最底部，一起显示隐藏 */}
      <AnimatePresence>
        {showPlaylistCarousel && (
          <motion.div
            initial={{ y: 56, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 44, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="absolute bottom-0 left-0 right-0 z-40"
            data-desktop-interactive
            onMouseEnter={handleCarouselMouseEnter}
            onMouseLeave={handleCarouselMouseLeave}
            style={{ 
              pointerEvents: 'auto', 
              paddingBottom: '12px',
              transform: 'translate3d(0, 0, 0)',
              willChange: 'transform, opacity',
              isolation: 'isolate',
              contain: 'layout paint style',
              backfaceVisibility: 'hidden'
            }}
          >
            {/* 加载动画或歌单轮播 */}
            {loading ? (
              <div className="flex flex-col items-center justify-center h-64 gap-4">
                <p className="text-white/80 text-sm">
                  正在加载歌单...
                </p>
              </div>
            ) : (playlists.length > 0 || recentEntry) ? (
              <PlaylistCarousel3D
                playlists={recentEntry ? [recentEntry, ...playlists] : playlists}
                onPlaylistSelect={handlePlaylistSelect}
                platform={currentPlatform}
                initialFocusedIndex={recentEntry ? 1 : 0}
                compact={isTvUi}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-64 gap-4">
                {currentPlatform === 'netease' && !neteaseLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录网易云音乐</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => {
                        setLoginPlatform('netease')
                        setShowLogin(true)
                      }}
                      className="px-6 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white hover:bg-white/20 transition-all"
                    >
                      登录网易云音乐
                    </motion.button>
                  </>
                )}
                {currentPlatform === 'qq' && !qqLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录QQ音乐</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => {
                        setLoginPlatform('qq')
                        setShowLogin(true)
                      }}
                      className="px-6 py-2 rounded-full bg-white/10 backdrop-blur-md border border-white/20 text-white hover:bg-white/20 transition-all"
                    >
                      登录QQ音乐
                    </motion.button>
                  </>
                )}
                {currentPlatform === 'apple' && !appleLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录 Apple Music</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => onAppleLoginClick?.()}
                      className="px-6 py-2 rounded-full bg-pink-600/90 hover:bg-pink-600 text-white transition-all"
                    >
                      登录 Apple Music
                    </motion.button>
                  </>
                )}
                {currentPlatform === 'spotify' && !spotifyLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录 Spotify</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => { setLoginPlatform('spotify'); setShowLogin(true) }}
                      className="px-6 py-2 rounded-full bg-[#1DB954]/90 hover:bg-[#1DB954] text-white transition-all"
                    >
                      登录 Spotify
                    </motion.button>
                  </>
                )}
                {currentPlatform === 'kugou' && !kugouLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录酷狗音乐</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => { setLoginPlatform('kugou'); setShowLogin(true) }}
                      className="px-6 py-2 rounded-full bg-orange-500/90 hover:bg-orange-500 text-white transition-all"
                    >
                      登录酷狗音乐
                    </motion.button>
                  </>
                )}
                {currentPlatform === 'soda' && !sodaLoggedIn && (
                  <>
                    <p className="text-white/60 mb-2">请先登录汽水音乐</p>
                    <motion.button
                      whileHover={{ scale: 1.05 }}
                      whileTap={{ scale: 0.95 }}
                      onClick={() => { setLoginPlatform('soda'); setShowLogin(true) }}
                      className="px-6 py-2 rounded-full bg-sky-500/90 hover:bg-sky-500 text-white transition-all"
                    >
                      登录汽水音乐
                    </motion.button>
                  </>
                )}
                {((currentPlatform === 'netease' && neteaseLoggedIn) || (currentPlatform === 'qq' && qqLoggedIn) || (currentPlatform === 'apple' && appleLoggedIn) || (currentPlatform === 'spotify' && spotifyLoggedIn) || (currentPlatform === 'kugou' && kugouLoggedIn) || (currentPlatform === 'soda' && sodaLoggedIn)) && (
                  <p className="text-white/60">暂无歌单</p>
                )}
              </div>
            )}
            
            {/* 底部控制区域：按钮组 - 从左到右：播放设备、遥控器、搜索、平台切换、设置、音量控制 */}
            <div className="flex items-center justify-center gap-3 mt-2">
              {/* 播放设备控制按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onOpenDeviceControl}
                className="rounded-full flex items-center justify-center transition-all"
                style={{
                  width: '48px',
                  height: '48px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                <Speaker className="w-5 h-5 text-white" />
              </motion.button>

              {/* 遥控器按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onRemoteClick}
                className="rounded-full flex items-center justify-center transition-all"
                style={{
                  width: '48px',
                  height: '48px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                <MonitorSmartphone className="w-5 h-5 text-white" />
              </motion.button>

              {/* 搜索按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => setShowSearch(true)}
                className="rounded-full flex items-center justify-center transition-all"
                style={{
                  width: '48px',
                  height: '48px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                <Search className="w-5 h-5 text-white" />
              </motion.button>

              {/* 平台切换按钮 - 显示当前平台真实 logo */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={handlePlatformSwitch}
                className="rounded-full flex items-center justify-center transition-all"
                style={{
                  width: '48px',
                  height: '48px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                {currentPlatform === 'netease' ? (
                  // 网易云音乐 logo
                  <img 
                    src="https://s1.music.126.net/style/favicon.ico?v20180823" 
                    alt="网易云音乐"
                    className="w-6 h-6"
                    style={{ objectFit: 'contain' }}
                  />
                ) : currentPlatform === 'qq' ? (
                  // QQ音乐 logo
                  <img 
                    src="https://y.qq.com/favicon.ico" 
                    alt="QQ音乐"
                    className="w-6 h-6"
                    style={{ objectFit: 'contain' }}
                  />
                ) : (
                  // Apple Music logo
                  <img 
                    src="https://www.apple.com/favicon.ico" 
                    alt="Apple Music"
                    className="w-6 h-6"
                    style={{ objectFit: 'contain' }}
                  />
                )}
              </motion.button>

              {/* 桌面融合穿透开关 */}
              <motion.button
                whileHover={{ scale: 1.08 }}
                whileTap={{ scale: 0.94 }}
                onClick={() => onDesktopFusionChange?.(!desktopFusionEnabled)}
                title={desktopFusionEnabled ? '桌面融合穿透：已开启（空区域可操作真实桌面，点击关闭）' : '桌面融合穿透：关闭（点击开启，空区域穿透到真实桌面）'}
                className="flex h-9 w-9 items-center justify-center rounded-full transition-all"
                style={{
                  background: desktopFusionEnabled ? 'rgba(236, 72, 153, 0.25)' : 'rgba(255, 255, 255, 0.1)',
                  border: `1px solid ${desktopFusionEnabled ? 'rgba(236, 72, 153, 0.6)' : 'rgba(255, 255, 255, 0.2)'}`,
                  color: desktopFusionEnabled ? '#f9a8d4' : 'rgba(255,255,255,0.7)',
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18M9 21V9M6 6h.01M10 6h.01" />
                </svg>
              </motion.button>

              {/* 设置按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  closePlaylistCarousel()
                  setShowSettings(true)
                }}
                className="rounded-full flex items-center justify-center transition-all"
                style={{
                  width: '48px',
                  height: '48px',
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                <Settings className="w-5 h-5 text-white" />
              </motion.button>

              {/* 视频音量控制按钮 - 仅在视频壁纸时显示 */}
              {desktopLiveWallpaper && desktopLiveWallpaper.sourceType === 'video' && (
                <motion.button
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={toggleVideoMute}
                  className="rounded-full flex items-center justify-center transition-all"
                  style={{
                    width: '48px',
                    height: '48px',
                    background: 'rgba(255, 255, 255, 0.1)',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                  }}
                >
                  {videoMuted ? (
                    <VolumeX className="w-5 h-5 text-white" />
                  ) : (
                    <Volume2 className="w-5 h-5 text-white" />
                  )}
                </motion.button>
              )}

              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => {
                  const next = !showDesktopLyrics
                  setShowDesktopLyrics(next)
                  localStorage.setItem('showDesktopLyrics', JSON.stringify(next))
                }}
                className="rounded-full flex items-center justify-center transition-all"
                title={showDesktopLyrics ? '关闭桌面歌词' : '显示桌面歌词'}
                style={{
                  width: '48px',
                  height: '48px',
                  background: showDesktopLyrics
                    ? `linear-gradient(135deg, ${desktopAccentColor}, ${desktopAccentColor}99)`
                    : 'rgba(255, 255, 255, 0.1)',
                  border: showDesktopLyrics ? '1px solid rgba(255,255,255,0.48)' : '1px solid rgba(255, 255, 255, 0.2)',
                  boxShadow: showDesktopLyrics
                    ? `0 8px 30px ${desktopAccentColor}55, inset 0 1px 0 rgba(255,255,255,0.34)`
                    : '0 8px 32px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.2)',
                }}
              >
                <Captions className="w-5 h-5 text-white" />
              </motion.button>

              {/* 插件系统入口 */}
              <PluginShortcuts variant="desktop" />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 底部小白条 - 只在歌单隐藏时显示 */}
      <AnimatePresence>
        {!showPlaylistCarousel && !desktopOverlayOpen && (
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            className="absolute bottom-0 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3"
            data-desktop-interactive
            style={{
              paddingTop: '40px',
              paddingBottom: '8px'
            }}
            onMouseEnter={handleBottomBarMouseEnter}
            onClick={handleBottomBarMouseEnter}
          >
            {/* 小白条：TV 遥控器模式下可聚焦（data-tv-focus），OK 键展开歌单栏 */}
            <motion.div
              data-tv-focus
              aria-label="显示歌单"
              className={`${isTvUi ? 'w-64 h-2.5' : 'w-96 h-1.5'} rounded-full bg-white/40 cursor-pointer`}
              style={{
                boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)'
              }}
              whileHover={{ height: '8px', backgroundColor: 'rgba(255, 255, 255, 0.6)' }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* 搜索面板 */}
      <Suspense fallback={null}>
      <AnimatePresence>
        {showSearch && (
          <LazySearchPanel
            onSongSelect={(song, searchResults, origin) => {
              onSongSelect(song, searchResults, { ...origin, surface: origin?.surface || 'search', mode: 'desktop' })
              setShowSearch(false)
            }}
            onClose={() => setShowSearch(false)}
            restorePlaybackOrigin={restorePlaybackOrigin}
            playerTheme="dark"
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            currentSong={currentSong}
            onPlayNext={onPlayNext}
            onAddToFavorites={onAddToFavorites}
            onRemoveFromFavorites={onRemoveFromFavorites}
            onAddToPlaylist={onAddToPlaylist}
            onViewComments={onViewComments}
            onOpenArtist={onOpenArtist}
            onOpenPlaylist={(playlist) => {
              // 搜索歌单结果 → 桌面端歌单详情面板（QQ 用 mid 字符串 id，网易云用数字 id）
              void handlePlaylistSelect({
                id: playlist.platform === 'qq' ? String(playlist.id) : Number(playlist.id) || playlist.id,
                mid: playlist.platform === 'qq' ? String(playlist.id) : undefined,
                name: playlist.name,
                coverImgUrl: playlist.coverImgUrl,
                trackCount: playlist.trackCount,
                creator: playlist.creator,
                platform: playlist.platform,
              } as Playlist)
            }}
            onCopyInfo={onCopyInfo}
          />
        )}
      </AnimatePresence>
      </Suspense>

      {/* 设置面板 */}
      {settingsModuleMounted && (
        <Suspense fallback={null}>
          <LazyDesktopSettingsModal
        show={showSettings}
        onClose={() => setShowSettings(false)}
        weWallpapers={weWallpapers}
        weLoading={weLoading}
        weError={weError}
        selectedWeWallpaper={selectedWeWallpaper}
        wallpaperSyncEnabled={wallpaperSyncEnabled}
        onScanWeWallpapers={scanWeWallpapers}
        onSelectWeWallpaper={selectWeWallpaper}
        wallpaperRotation={wallpaperRotation}
        onWallpaperRotationChange={updateWallpaperRotation}
        onWallpaperSyncToggle={handleWallpaperSyncToggle}
        onOpenCustomizer={() => {
          closePlaylistCarousel()
          setShowDesktopCustomizer(true)
        }}
      />
        </Suspense>
      )}

      {customizerModuleMounted && (
        <Suspense fallback={null}>
          <LazyDesktopCustomizationEditor
        open={showDesktopCustomizer}
        settings={desktopCustomization}
        onClose={() => setShowDesktopCustomizer(false)}
      />
        </Suspense>
      )}

      <DesktopFocusAlarmOverlay
        open={focusTimer.timer.status === 'ringing'}
        accentColor={desktopAccentColor}
        onRepeat={focusTimer.repeat}
        onStop={focusTimer.stop}
        title={focusTimer.timer.phase === 'focus' ? '专注时间结束' : '休息时间结束'}
        detail={focusTimer.timer.phase === 'focus' ? `${focusTimer.timer.label || '本轮任务'} · 已完成 ${focusTimer.timer.completedSessions} 个番茄` : '休息完成，可以开始下一轮专注'}
      />

      {/* 桌面迷你播放器 */}
      <AnimatePresence>
        {showDesktopMiniPlayer && currentSong && (
          <DesktopMiniPlayer
            currentSong={currentSong}
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            onPlayPause={onPlayPause}
            onNext={onNext}
            onPrevious={onPrevious}
            cardBlurAmount={cardBlurAmount}
            accentColor={desktopAccentColor}
            currentLyric={currentMiniLyric}
            underOverlay={desktopOverlayOpen}
            onEnterPlayer={() => {
              console.log('🎵 [DesktopView] 迷你播放器被点击，切换到简约模式')
              onExitDesktopMode()
            }}
          />
        )}
      </AnimatePresence>

      {/* 歌单详情 - 3D 网格视图（参考 folia-major） */}
      <AnimatePresence
        onExitComplete={() => {
          if (!showPlaylistDetail) {
            setPlaylistSongs([])
            setSelectedPlaylist(null)
          }
        }}
      >
        {showPlaylistDetail && selectedPlaylist && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.3 }}
            className="absolute inset-0 z-50"
            style={{
              background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.3) 100%)',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)',
            }}
          >
            <div className="w-full h-full flex flex-col">
              {/* 头部：返回按钮、封面和信息 */}
              <div className="flex-shrink-0 p-6 border-b border-white/10">
                <div className="flex items-center gap-6">
                  {/* 返回按钮 */}
                  <button
                    onClick={closePlaylistDetail}
                    className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 transition-all flex items-center justify-center shrink-0"
                  >
                    <ChevronDown className="w-5 h-5 text-white rotate-90" />
                  </button>

                          {/* 封面：最近播放显示 2x2 封面宫格，其余显示歌单封面 */}
        {selectedPlaylist.isRecent ? (
          <div className="grid h-20 w-20 shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-xl bg-white/10 shadow-2xl">
            {Array.from({ length: 4 }).map((_, coverIndex) => {
              const cover = selectedPlaylist.covers?.[coverIndex]
              return cover ? (
                <img key={coverIndex} src={cover} alt="" className="h-full w-full object-cover" />
              ) : (
                <div key={coverIndex} className="flex h-full w-full items-center justify-center bg-white/10">
                  <Clock className="h-4 w-4 text-white/25" />
                </div>
              )
            })}
          </div>
        ) : (
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl shadow-2xl">
            <img
              src={selectedPlaylist.coverImgUrl}
              alt={selectedPlaylist.name}
              className="h-full w-full object-cover"
            />
            {currentPlatform === 'qq' && selectedPlaylist.isLike && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <Heart
                  className="h-[42%] w-[42%] fill-white/75 text-white/75"
                  strokeWidth={0}
                  style={{ filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.28)) blur(0.6px)' }}
                />
              </div>
            )}
          </div>
        )}
                  
                  {/* 信息 */}
                  <div className="flex-1 flex flex-col justify-center min-w-0">
                    <h1 className="text-2xl font-bold text-white mb-1 truncate">
                      {selectedPlaylist.name}
                    </h1>
                    <p className="text-white/60 text-sm">
                      {playlistSongs.length < Number(selectedPlaylist.trackCount || 0)
                        ? `已加载 ${playlistSongs.length} / ${selectedPlaylist.trackCount} 首`
                        : `${selectedPlaylist.trackCount} 首歌曲`}
                    </p>
                  </div>
                  
                  {/* 播放全部按钮 */}
                  <button
                    onClick={handlePlayAll}
                    disabled={playlistSongs.length === 0}
                    className="px-6 py-2.5 bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 text-white rounded-full font-medium transition-all shadow-lg flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
                  >
                    <Play className="w-4 h-4" fill="currentColor" />
                    播放全部
                  </button>
                </div>
              </div>
              
                {/* 3D 网格歌曲视图 */}
                <Suspense fallback={<div className="flex flex-1 items-center justify-center text-sm text-white/55">正在加载歌单视图…</div>}>
                <LazyPlaylistGrid3D
                  songs={playlistSongs}
                  loading={loadingPlaylistSongs}
                  onPlaySong={handlePlaySong}
                  formatDuration={formatDuration}
                  platform={currentPlatform}
                  neteaseVip={neteaseVip}
                  qqVip={qqVip}
                  currentSong={currentSong}
                  onPlayNext={onPlayNext}
                  onAddToFavorites={onAddToFavorites}
                  onRemoveFromFavorites={onRemoveFromFavorites}
                  onAddToPlaylist={onAddToPlaylist}
                  onRemoveFromPlaylist={canRemoveFromCurrentPlaylist ? handleRemoveFromCurrentPlaylist : undefined}
                  onViewComments={onViewComments}
                  onOpenAlbum={onOpenAlbum}
                  onOpenArtist={onOpenArtist}
                  onCopyInfo={onCopyInfo}
                  userPlaylists={playlists}
                  currentPlaylistId={String(selectedPlaylist.dirId || selectedPlaylist.id)}
                  isCurrentPlaylistLiked={Boolean(selectedPlaylist.isLike)}
                />
                </Suspense>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 登录面板 */}
      <Suspense fallback={null}>
      <AnimatePresence>
        {showLogin && (
          <LazyLoginView
            platform={loginPlatform}
            onCancel={() => setShowLogin(false)}
            onLoginSuccess={(cookie, username) => {
              if (loginPlatform === 'netease') {
                onNeteaseLogin(cookie)
              } else if (loginPlatform === 'qq') {
                onQQLogin(cookie)
              } else if (loginPlatform === 'spotify') {
                onSpotifyLogin?.(cookie, username)
              } else if (loginPlatform === 'kugou') {
                onKugouLogin?.(cookie, username)
              } else if (loginPlatform === 'soda') {
                onSodaLogin?.(cookie, username)
              }
              setShowLogin(false)
            }}
          />
        )}
      </AnimatePresence>
      </Suspense>
      </motion.div>
    </div>
  )
}
// 导出 memo 包装：播放中 App 约 1Hz 重渲染时，props 稳定则跳过整棵桌面模式子树重渲染
export default memo(DesktopView)
