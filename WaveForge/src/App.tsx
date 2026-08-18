import { debugLog, isVerboseLogEnabled } from './utils/debugLog'
import { parseStoredBoolean } from './utils/storage'
import { isTv, isTvModeActive } from './platform'
import { useTvBack } from './tv/tvCore'
import { isPerfModeEfficiency } from './tv/perfMode'
import { lazy, memo, Suspense, useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore, type ComponentProps } from 'react'
import AlbumCoverPlayer from './components/AlbumCoverPlayer'
import LyricsDisplay from './components/LyricsDisplay'
import PlayerControls from './components/PlayerControls'
import TitleBar from './components/TitleBar'
import UpdatePrompt from './components/UpdatePrompt'
import CrossfadeBackground from './components/CrossfadeBackground'

import MiniPlayer from './components/MiniPlayer'
import Toast from './components/Toast'
import GaplessModeToast from './components/GaplessModeToast'
import { extractDominantColor, useColorThief } from './hooks/useColorThief'
import { useAudioPlayer, type AudioGraphHandle } from './hooks/useAudioPlayer'
import { useAudioAnalyzer } from './hooks/useAudioAnalyzer'
import { useAudioPulseStore, type AudioPulseStore } from './hooks/useAudioPulse'
import { Song, getSongUrl, invalidateSongUrl, getLyrics, getProxiedImageUrl, getLocalAlbumIdentifier, resolveSongAlbumIdentifier, LyricLine } from './services/musicApi'
import type { MusicPlatform } from './services/platforms'
import { isPlatformVisible } from './services/platforms'
import { getAppleMusicSettings, resolveAppleTrack } from './services/appleMusic'
import { getAppleAuthState, clearAppleLogin, type AppleUserInfo } from './services/appleAuth'
import { recordLogin, clearLoginExpiry, isLoginExpired } from './services/loginExpiry'
import { resolvePlayableSong, addAppleSongToLibrary, removeAppleSongFromLibrary, addAppleTracksToPlaylist, getAppleLibraryPlaylists } from './services/appleCatalog'
import AppleLoginPanel from './components/AppleLoginPanel'
import { cacheManager } from './services/cacheManager'
import { indexedDBCache } from './services/indexedDBCache'
import { autoMixAnalysisService } from './services/autoMixAnalysisService'
import { getAudioEngineVersion, setAudioEngineVersion, type AudioEngineVersion } from './services/audioEngineVersion'
import { getEngineAdapter, getAvailableEngines, getAvailableEngineIds, type IAudioEngineAdapter } from './services/audio-engine'
import { sequenceTracksHam2, type SequencingEntry } from './services/playlistSequencing'
import { likeSong, addSongToPlaylist, getUserPlaylists, updateCachedUserPlaylists, getPlaylistDetail } from './services/playlistService'
import { fetchExploreRecommendationBatch } from './services/exploreApi'
import { scheduleBackgroundPrefetch } from './services/backgroundPrefetch'
import { getDesktopSpectrumConsumerCount, subscribeDesktopSpectrumConsumers } from './services/desktopSpectrum'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings } from 'lucide-react'
import { getDeterministicNextIndex, getUpcomingIndices } from './audio/PlaybackQueue'
import type { TrackAnalysis, TransitionCommit, TransitionState, TransitionStrategy } from './audio/types'
import type { PlaybackTimeStore } from './audio/playbackTimeStore'
import type { PlaybackOrigin, ViewMode } from './types/playbackNavigation'
const loadHomeView = () => import('./components/HomeView')
const loadExploreView = () => import('./components/ExploreView')
const loadDesktopView = () => import('./components/DesktopView')
const LazyHomeView = lazy(loadHomeView)
const LazyExploreView = lazy(loadExploreView)
const LazyDesktopView = lazy(loadDesktopView)
const loadSearchPanel = () => import('./components/SearchPanel')
const loadUpNextNotification = () => import('./components/UpNextNotification')
const LazySearchPanel = lazy(loadSearchPanel)
const LazyUpNextNotification = lazy(loadUpNextNotification)
const loadSettingsPanel = () => import('./components/SettingsPanel')
const LazySettingsPanel = lazy(loadSettingsPanel)
const loadOobeGuide = () => import('./components/oobe/OobeGuide')
const LazyOobeGuide = lazy(loadOobeGuide)
// ────────────────────────────────────────────────────────────────
// OOBE 1（第一层引导：主题选择 / 隐私条款 / 免责声明）
// 首次启动且未完成引导时自动弹出（完成即写入 waveforge:oobe-shown，不再打扰）。
// 设置 → 高级 → "重新启用 OOBE 引导" 可清除标记，下次启动再显示一次。
// 未来 AI 接力：OOBE 2 = 功能介绍引导，在 OobeGuide 的 welcome 步骤前插入步骤即可。
// ────────────────────────────────────────────────────────────────
const OOBE_ENABLED = true
// 调音室组件的 lazy import 已下沉到各引擎 Adapter 的 renderStudio 内部，
// App.tsx 不再直接引用调音室组件（统一通过 engineAdapterRef.current.renderStudio 渲染）。
const loadPlaylistPanel = () => import('./components/PlaylistPanel')
const loadLoginView = () => import('./components/LoginView')
const loadProfileView = () => import('./components/ProfileView')
const loadArtistDetailModal = () => import('./components/ArtistDetailModal')
const loadAlbumDetailModal = () => import('./components/AlbumDetailModal')
const loadCommentModal = () => import('./components/CommentModal')
const LazyPlaylistPanel = lazy(loadPlaylistPanel)
const loadPlaylistDetailPanel = () => import('./components/PlaylistDetailPanel')
const LazyPlaylistDetailPanel = lazy(loadPlaylistDetailPanel)
const LazyLoginView = lazy(loadLoginView)
const LazyProfileView = lazy(loadProfileView)
const LazyArtistDetailModal = lazy(loadArtistDetailModal)
const LazyAlbumDetailModal = lazy(loadAlbumDetailModal)
const LazyCommentModal = lazy(loadCommentModal)
const loadModernAudioVisualizer = () => import('./components/ModernAudioVisualizer')
const loadPlaybackRadialMenu = () => import('./components/PlaybackRadialMenu')
const loadImmersiveControls = () => import('./components/ImmersiveControls')
const loadTranslationDisplay = () => import('./components/TranslationDisplay')
const loadWallpaperLyrics = () => import('./components/WallpaperLyrics')
const loadGloriousLyrics = () => import('./components/GloriousLyrics')
const loadMultidimensionalLyrics = () => import('./components/MultidimensionalLyrics')
const loadModengPlayer = () => import('./components/ModengPlayerPage')
const loadBilibiliMvPlayer = () => import('./components/BilibiliMvPlayer')
const LazyModernAudioVisualizer = lazy(loadModernAudioVisualizer)
const LazyPlaybackRadialMenu = lazy(loadPlaybackRadialMenu)
const LazyImmersiveControls = lazy(loadImmersiveControls)
const LazyTranslationDisplay = lazy(loadTranslationDisplay)
const LazyWallpaperLyrics: any = lazy(loadWallpaperLyrics)
const LazyGloriousLyrics: any = lazy(loadGloriousLyrics)
const LazyMultidimensionalLyrics = lazy(loadMultidimensionalLyrics)
const LazyModengPlayer: any = lazy(loadModengPlayer)
const LazyBilibiliMvPlayer: any = lazy(loadBilibiliMvPlayer)
const loadRemoteControlModal = () => import('./components/RemoteControlModal')
const LazyRemoteControlModal = lazy(loadRemoteControlModal)
const loadSongDetailModal = () => import('./components/SongDetailModal')
const LazySongDetailModal = lazy(loadSongDetailModal)
import RemoteCursor from './components/RemoteCursor'
import PlatformLoginNotice from './components/PlatformLoginNotice'
import SimilarSongsPanel from './components/SimilarSongsPanel'
import { detectQQMusicVip } from './utils/musicEntitlements'
import { getQQUserDisplayName } from './utils/qqUser'
import {
  applyFavoriteMutation,
  getFavoriteUserId,
  loadFavoriteIdentifiers,
  peekSongFavoriteStatus,
} from './services/favoriteStatusService'
import { AUDIO_QUALITY_SETTINGS_EVENT } from './services/audioQualitySettings'
import {
  loadPlaybackShortcutSettings,
  PLAYBACK_SHORTCUT_SETTINGS_EVENT,
  type PlaybackShortcutSettings,
} from './services/playbackShortcutSettings'

interface Track {
  id?: number
  title: string
  artist: string
  album: string
  coverUrl: string
  duration: number
  url?: string
  dominantColor?: string
}

type LiveLyricsDisplayProps = Omit<ComponentProps<typeof LyricsDisplay>, 'currentTime'> & {
  playbackTimeStore: PlaybackTimeStore
}

const LiveLyricsDisplay = memo(function LiveLyricsDisplay({
  playbackTimeStore,
  ...props
}: LiveLyricsDisplayProps) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime

  return <LyricsDisplay {...props} currentTime={currentTime} />
})

type LivePlayerControlsProps = Omit<ComponentProps<typeof PlayerControls>, 'currentTime'> & {
  playbackTimeStore: PlaybackTimeStore
}

const LivePlayerControls = memo(function LivePlayerControls({
  playbackTimeStore,
  ...props
}: LivePlayerControlsProps) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime

  return <PlayerControls {...props} currentTime={currentTime} />
})

type LiveMiniPlayerProps = Omit<ComponentProps<typeof MiniPlayer>, 'currentTime'> & {
  playbackTimeStore: PlaybackTimeStore
}

const LiveMiniPlayer = memo(function LiveMiniPlayer({
  playbackTimeStore,
  ...props
}: LiveMiniPlayerProps) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime

  return <MiniPlayer {...props} currentTime={currentTime} />
})

type DesktopLyricLine = LyricLine & {
  isGeneratedInterlude?: boolean
  interludeStartTime?: number
  interludeEndTime?: number
}

const DESKTOP_INTERLUDE_LEAD_SECONDS = 0.28
const DESKTOP_INTERLUDE_HIDE_BEFORE_NEXT_SECONDS = 1
const DESKTOP_INTERLUDE_MIN_GAP_SECONDS = 5

const isDesktopInterludeMarker = (text: string) => {
  const compact = text.trim().replace(/\s+/g, '')
  return compact === '' || /^(?:\.{3,}|…+|[·•・]{3,})$/.test(compact)
}

const estimateDesktopLyricEnd = (lyric: LyricLine, nextTime: number) => {
  const wordEndMs = lyric.words?.reduce((latest, word) => (
    Number.isFinite(word.startTime) && Number.isFinite(word.duration)
      ? Math.max(latest, word.startTime + Math.max(0, word.duration))
      : latest
  ), 0) || 0
  if (wordEndMs >= 400) return Math.min(nextTime, lyric.time + wordEndMs / 1000)
  const characters = Math.max(1, Array.from(lyric.text.trim()).length)
  return Math.min(nextTime, lyric.time + Math.min(5.8, Math.max(1.8, 1.15 + characters * 0.25)))
}

const buildDesktopLyricsWithInterludes = (lyrics: LyricLine[]): DesktopLyricLine[] => {
  const source = lyrics.filter(line => !isDesktopInterludeMarker(line.text || ''))
  const result: DesktopLyricLine[] = []
  source.forEach((line, index) => {
    result.push(line)
    const next = source[index + 1]
    if (!next) return
    const start = estimateDesktopLyricEnd(line, next.time)
    const end = next.time - DESKTOP_INTERLUDE_HIDE_BEFORE_NEXT_SECONDS
    if (next.time - start <= DESKTOP_INTERLUDE_MIN_GAP_SECONDS) return
    result.push({
      time: start + DESKTOP_INTERLUDE_LEAD_SECONDS,
      text: '',
      isGeneratedInterlude: true,
      interludeStartTime: start,
      interludeEndTime: end,
    })
  })
  return result
}

type CoverPulseMode = 'dynamic' | 'soft' | 'restless'
type LyricDisplayMode = 'modern' | 'immersive' | 'wallpaper' | 'glorious' | 'multidimensional' | 'modeng' | 'video'

const LYRIC_MODE_VISIBILITY_KEY = 'waveforge_visible_lyric_modes'
const LYRIC_MODE_MODENG_MIGRATED_KEY = 'waveforge_modeng_mode_migrated'
const LYRIC_MODE_VIDEO_MIGRATED_KEY = 'waveforge_video_mode_migrated'
const ALL_LYRIC_MODES: LyricDisplayMode[] = ['modern', 'immersive', 'wallpaper', 'glorious', 'multidimensional', 'modeng', 'video']
const LYRIC_MODE_NAMES: Record<LyricDisplayMode, string> = {
  modern: '现代',
  immersive: '沉浸式',
  wallpaper: '墙纸',
  glorious: '辉煌',
  multidimensional: '多维',
  modeng: '摩登',
  video: '看歌',
}

function loadVisibleLyricModes(): LyricDisplayMode[] {
  try {
    const raw = localStorage.getItem(LYRIC_MODE_VISIBILITY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((mode: unknown): mode is LyricDisplayMode =>
          ALL_LYRIC_MODES.includes(mode as LyricDisplayMode))
        // 现代模式始终显示，历史设置里即使缺失也要补回
        const withModern = valid.includes('modern') ? valid : ['modern' as LyricDisplayMode, ...valid]
        if (withModern.length > 0) {
          // 摩登为新增模式：不含它的历史设置一次性补回可见列表（迁移标记防重复），之后用户可自由隐藏
          if (!withModern.includes('modeng') && !localStorage.getItem(LYRIC_MODE_MODENG_MIGRATED_KEY)) {
            const withModeng = [...withModern, 'modeng' as LyricDisplayMode]
            localStorage.setItem(LYRIC_MODE_MODENG_MIGRATED_KEY, '1')
            localStorage.setItem(LYRIC_MODE_VISIBILITY_KEY, JSON.stringify(withModeng))
            return withModeng
          }
          // 看歌（B站MV）为新增模式：同样一次性补回
          if (!withModern.includes('video') && !localStorage.getItem(LYRIC_MODE_VIDEO_MIGRATED_KEY)) {
            const withVideo = [...withModern, 'video' as LyricDisplayMode]
            localStorage.setItem(LYRIC_MODE_VIDEO_MIGRATED_KEY, '1')
            localStorage.setItem(LYRIC_MODE_VISIBILITY_KEY, JSON.stringify(withVideo))
            return withVideo
          }
          return withModern
        }
      }
    }
  } catch (error) {
    console.warn('读取歌词模式可见设置失败:', error)
  }
  return [...ALL_LYRIC_MODES]
}

interface PulsingCrossfadeBackgroundProps {
  coverUrl: string
  transitionFromUrl?: string
  transitionToUrl?: string
  isTransitioning: boolean
  transitionProgress: number
  pulseStore: AudioPulseStore
  backgroundEffect: 'transparent' | 'blur' | 'immersive'
  backgroundBlur: number
}

const PulsingCrossfadeBackground = memo(function PulsingCrossfadeBackground({
  pulseStore,
  backgroundEffect,
  backgroundBlur,
  ...crossfadeProps
}: PulsingCrossfadeBackgroundProps) {
  const pulseRootRef = useRef<HTMLDivElement>(null)
  const pulseHighlightRef = useRef<HTMLDivElement>(null)
  const baseScale = backgroundEffect === 'immersive' ? 1.15 : 1.1

  useEffect(() => {
    const applyPulse = () => {
      const root = pulseRootRef.current
      const highlight = pulseHighlightRef.current
      if (!root || !highlight) return

      const pulse = pulseStore.getSnapshot()
      root.style.setProperty('--cover-pulse-scale', String(pulse.scale))
      // Brightness/saturation used to rebuild the blurred full-screen filter every
      // frame. A composited soft-light layer produces the same visible flash while
      // keeping the expensive blur raster stable.
      highlight.style.opacity = String(Math.min(0.22, pulse.brightness * 0.72 + pulse.saturation * 0.055))
    }

    applyPulse()
    return pulseStore.subscribe(applyPulse)
  }, [pulseStore])

  const staticFilter = backgroundEffect === 'transparent'
    ? `blur(${backgroundBlur}px) brightness(1.1)`
    : backgroundEffect === 'blur'
      ? 'blur(40px)'
      : `blur(${backgroundBlur}px) saturate(1.3)`

  return (
    <div
      ref={pulseRootRef}
      className="absolute inset-0 overflow-hidden"
      style={{ ['--cover-pulse-scale' as string]: 0 }}
    >
      <CrossfadeBackground
        {...crossfadeProps}
        imageStyle={{
          filter: staticFilter,
          transform: `translate3d(0, 0, 0) scale(calc(${baseScale} + var(--cover-pulse-scale, 0)))`,
          transition: 'transform 0.055s linear, opacity 0.5s',
          willChange: 'transform',
        }}
      />
      <div
        ref={pulseHighlightRef}
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          opacity: 0,
          background: 'rgba(255, 255, 255, 0.34)',
          mixBlendMode: 'soft-light',
          transition: 'opacity 0.12s ease-out',
          willChange: 'opacity',
        }}
      />
    </div>
  )
})

function getSongKey(song: Song): string {
  return `${song.platform || 'netease'}-${song.mid || song.id}`
}

function getSongIdentifiers(song: Song | null): string[] {
  if (!song) return []
  return [song.id, song.mid]
    .filter(value => value !== undefined && value !== null && String(value).trim())
    .map(value => String(value))
}

// #10 Gapless 方案判定辅助：切歌提交时判断当前曲与目标曲是否同专辑。
// 与 useAudioPlayer 设置 metadata.albumId 的判定方式一致（getLocalAlbumIdentifier），
// 用于区分 gapless 首选「直接拼接」（仅专辑场景）与备选「60ms 淡入淡出」。
function isSameAlbumPlayback(source: Song | undefined, target: Song | undefined): boolean {
  if (!source || !target) return false
  // Apple 曲目 album 无平台专辑 id，直接拼接不适用（返回 false 走淡入淡出）
  const sourcePlatform = source.platform || 'netease'
  const targetPlatform = target.platform || 'netease'
  const sourceAlbumId = getLocalAlbumIdentifier(source, sourcePlatform)
  const targetAlbumId = getLocalAlbumIdentifier(target, targetPlatform)
  return Boolean(sourceAlbumId && targetAlbumId && sourceAlbumId === targetAlbumId)
}

function normalizeSongCover(song: Song): Song {
  const picUrl = song.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

  if (!picUrl || picUrl === song.album?.picUrl) {
    return song
  }

  return {
    ...song,
    album: {
      ...song.album,
      picUrl
    }
  }
}

function createTrackFromSong(song: Song, url?: string, dominantColor?: string): Track {
  return {
    id: song.id,
    title: song.name,
    artist: song.artists.map(a => a.name).join(', '),
    album: song.album.name,
    coverUrl: song.album?.picUrl || '',
    duration: song.duration / 1000,
    url,
    dominantColor,
  }
}

async function loadQQSongDetail(song: Song): Promise<Song> {
  const songMid = song.mid || song.id
  if (!songMid) return song

  try {
    const response = await fetch(`http://localhost:3001/api/qq/song/detail?mid=${encodeURIComponent(String(songMid))}`)
    if (!response.ok) return song

    const data = await response.json()
    return data.song ? normalizeSongCover(data.song) : song
  } catch (error) {
    console.warn('[QQ音乐详情] 请求失败:', error)
    return song
  }
}

function App() {
  // 视图模式状态（探索 / 简约 / 桌面）
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('viewMode')
    const mode = saved === 'explore' || saved === 'minimal' || saved === 'desktop' ? saved : 'minimal'
    // TV 效能档隐藏桌面模式（普通/增强显示）：历史保存值也不会恢复成桌面
    return isTv() && isPerfModeEfficiency() && mode === 'desktop' ? 'minimal' : mode
  })
  const viewModeChangeRevisionRef = useRef(0)
  
  const [currentTrack, setCurrentTrack] = useState<Track>({
    title: 'WaveForge',
    artist: '点击搜索按钮开始',
    album: 'Demo Album',
    coverUrl: '', // 初始为空，避免加载随机图片
    duration: 240,
  })
  
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeCommitRef = useRef({ wallTime: 0, playbackTime: 0 })
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1.0) // 默认音量100%
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showMixingStudio, setShowMixingStudio] = useState(false)
  const [showRemote, setShowRemote] = useState(false)
  const [showSongDetail, setShowSongDetail] = useState(false)
  const [songDetailSong, setSongDetailSong] = useState<Song | null>(null)
  const [showSimilarSongs, setShowSimilarSongs] = useState(false)
  const [similarSongsSource, setSimilarSongsSource] = useState<Song | null>(null)
  // 歌曲详情「也爱歌单」应用内打开
  const [detailPlaylist, setDetailPlaylist] = useState<{ playlist: any; songs: Song[] } | null>(null)
  const [detailPlaylistLoading, setDetailPlaylistLoading] = useState(false)
  // 音效引擎版本（v1 远程原版 / v2 本地增强版 / v3 纯 TS DSP 内核），默认 v1；切换见 switchAudioEngine
  const [audioEngineVersion, setAudioEngineVersionState] = useState<AudioEngineVersion>(() => getAudioEngineVersion(getAvailableEngineIds()))
  // 引擎导出进行中状态（由 adapter.onExportingChange 事件驱动，供调音室导出按钮禁用/文案）
  const [engineExporting, setEngineExporting] = useState(false)
  // 与 state 同步的 ref：switchAudioEngine 切换中同步读写它，规避闭包陈旧 / 同帧连点竞态
  const audioEngineVersionRef = useRef<AudioEngineVersion>(audioEngineVersion)
  audioEngineVersionRef.current = audioEngineVersion
  // 引擎切换时的右上角小弹窗（2s 后淡出）
  const [engineSwitchToast, setEngineSwitchToast] = useState<string | null>(null)
  // 弹窗淡出定时器 ref：连点切换时先清旧再设新，防止旧定时器提前清掉新弹窗
  const engineSwitchToastTimerRef = useRef<number | null>(null)
  // #10 Gapless 方案弹窗：切歌提交时底部提示本次衔接方案（2.5s 后淡出）
  const [gaplessModeToast, setGaplessModeToast] = useState<string | null>(null)
  // 弹窗淡出定时器 ref：连续切歌时先清旧定时器再弹新方案，旧弹窗不残留
  const gaplessModeToastTimerRef = useRef<number | null>(null)
  // 卸载时清理弹窗定时器，避免卸载后 setState
  useEffect(() => () => {
    if (engineSwitchToastTimerRef.current !== null) window.clearTimeout(engineSwitchToastTimerRef.current)
    if (gaplessModeToastTimerRef.current !== null) window.clearTimeout(gaplessModeToastTimerRef.current)
  }, [])
  // 调音室弹窗锚点：记录打开按钮的位置，弹窗从按钮侧弹出/关闭时收缩回按钮
  const mixingStudioAnchorRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  useEffect(() => {
    const idleId = window.requestIdleCallback(() => {
      void Promise.allSettled([
        loadSettingsPanel(),
        loadHomeView(),
        loadExploreView(),
        loadDesktopView(),
        loadSearchPanel(),
        loadProfileView(),
        loadPlaylistPanel(),
        loadLoginView(),
        loadArtistDetailModal(),
        loadAlbumDetailModal(),
        loadCommentModal(),
        loadUpNextNotification(),
        loadPlaybackRadialMenu(),
        loadImmersiveControls(),
        loadTranslationDisplay(),
        loadModernAudioVisualizer(),
        loadWallpaperLyrics(),
        loadGloriousLyrics(),
        loadMultidimensionalLyrics(),
      ])
    }, { timeout: 2000 })
    return () => window.cancelIdleCallback(idleId)
  }, [])
  const [playMode, setPlayMode] = useState<'sequential' | 'shuffle' | 'repeat'>('sequential')
  const [showPlaylist, setShowPlaylist] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [loginPlatform, setLoginPlatform] = useState<MusicPlatform>('netease')
  // Apple Music 登录态（token 登录，见 AppleLoginPanel / appleAuth.ts）
  const [showAppleLogin, setShowAppleLogin] = useState(false)
  const [appleLoggedIn, setAppleLoggedIn] = useState(() => getAppleAuthState().loggedIn)
  const [appleUsername, setAppleUsername] = useState(() => getAppleAuthState().name)
  const [appleAvatar, setAppleAvatar] = useState<string | undefined>(() => getAppleAuthState().avatarUrl)
  const [appleEmail, setAppleEmail] = useState(() => getAppleAuthState().email || '')
  const [appleStorefront, setAppleStorefront] = useState(() => getAppleAuthState().storefront)
  const refreshAppleAuth = (user: AppleUserInfo | null) => {
    if (user) {
      setAppleLoggedIn(true)
      setAppleUsername(user.name)
      setAppleAvatar(user.avatarUrl)
      setAppleEmail(user.email || '')
      setAppleStorefront(user.storefront)
    } else {
      setAppleLoggedIn(false)
      setAppleUsername('')
      setAppleAvatar(undefined)
      setAppleEmail('')
    }
  }
  const [showProfile, setShowProfile] = useState(false)
  const [profileInitialPlatform, setProfileInitialPlatform] = useState<MusicPlatform>('netease')
  const [profileInitialTab, setProfileInitialTab] = useState<'created' | 'subscribed' | 'detail' | 'recent'>('created')

  const [showHome, setShowHome] = useState(true) // 控制首页显示
  const [enteredFromMode, setEnteredFromMode] = useState<ViewMode>('minimal') // 记录进入来源，用于返回时恢复状态
  const playbackOriginRef = useRef<PlaybackOrigin>({ mode: 'minimal', surface: 'home' })
  const recentPlaybackReportRef = useRef({
    songKey: '',
    reported: false,
    inFlight: false,
    attempts: 0,
    nextRetryAt: 0,
    lastObservedTime: 0,
  })
  const [restorePlaybackOrigin, setRestorePlaybackOrigin] = useState<(PlaybackOrigin & { revision: number }) | null>(null)
  const restorePlaybackRevisionRef = useRef(0)
  
  // 艺人和专辑详情弹窗状态
  const [showArtistDetail, setShowArtistDetail] = useState(false)
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null)
  const [selectedArtistPlatform, setSelectedArtistPlatform] = useState<MusicPlatform>('netease')
  const [showAlbumDetail, setShowAlbumDetail] = useState(false)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [selectedAlbumPlatform, setSelectedAlbumPlatform] = useState<MusicPlatform>('netease')
  const [selectedArtistAlbumId, setSelectedArtistAlbumId] = useState<string | number | undefined>()
  const [selectedArtistTab, setSelectedArtistTab] = useState<PlaybackOrigin['artistTab']>('hotSongs')
  // 导航栈：支持叠加窗口（搜索→歌手→专辑→详情）反向关闭
  const navigationStack = useRef<Array<{ type: 'artist' | 'album'; id: string; platform: MusicPlatform; tab?: string }>>([])
  const [showCommentModal, setShowCommentModal] = useState(false)
  const [selectedCommentSong, setSelectedCommentSong] = useState<Song | null>(null)
  const [currentSongLiked, setCurrentSongLiked] = useState(false)
  const [playbackContextPlaylists, setPlaybackContextPlaylists] = useState<any[]>([])
  
  const [lyrics, setLyrics] = useState<LyricLine[]>([])
  const [appleCoverUrl, setAppleCoverUrl] = useState<string | null>(null)
  const [lyricOffset, setLyricOffset] = useState(() => Number(localStorage.getItem('lyricOffset')) || 0)
  const [playlist, setPlaylist] = useState<Song[]>([])
  const playlistRef = useRef<Song[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [queueRevision, setQueueRevision] = useState(0)
  const [isSmartReordering, setIsSmartReordering] = useState(false)
  const [smartReorderProgress, setSmartReorderProgress] = useState({ completed: 0, total: 0 })
  const smartReorderRunRef = useRef(0)
  const smartReorderAbortRef = useRef<AbortController | null>(null)
  const transitionCommitRef = useRef<(commit: TransitionCommit) => void>(() => undefined)
  const activeTrackKeyRef = useRef<string | null>(null)
  const queueRevisionRef = useRef(0)
  const currentIndexRef = useRef(-1)
  const songLoadRevisionRef = useRef(0)
  const infiniteExploreContinuationRef = useRef({
    loading: false,
    lastQueueLength: 0,
    batch: 1,
    advancePending: false,
  })
  const [continuationRetry, setContinuationRetry] = useState(0)

  useEffect(() => {
    queueRevisionRef.current = queueRevision
    currentIndexRef.current = currentIndex
    playlistRef.current = playlist
  }, [queueRevision, currentIndex, playlist])

  useEffect(() => () => {
    smartReorderRunRef.current += 1
    smartReorderAbortRef.current?.abort()
  }, [])

  const bumpQueueRevision = useCallback(() => {
    const nextRevision = queueRevisionRef.current + 1
    queueRevisionRef.current = nextRevision
    setQueueRevision(nextRevision)
    return nextRevision
  }, [])
  
  // 预加载接下来2首歌曲的URL和歌词
  const preloadCacheRef = useRef<Map<string, {
    url: string | null
    lyrics: LyricLine[]
    timestamp: number
    urlTimestamp?: number
    lyricsTimestamp?: number
    lyricsLoaded?: boolean
    lyricsPromise?: Promise<LyricLine[]>
  }>>(new Map())
  const lyricsCacheGenerationRef = useRef(0)
  const audioUrlCacheGenerationRef = useRef(0)
  const audioPlayerCacheControlRef = useRef<{
    cancelTransition: (reason?: string, preserveNext?: boolean, announceCancellation?: boolean) => void
  } | null>(null)

  useEffect(() => {
    const invalidatePreloadedAudioUrls = () => {
      audioUrlCacheGenerationRef.current += 1
      audioPlayerCacheControlRef.current?.cancelTransition('audio source settings changed', false)
      for (const [key, cached] of preloadCacheRef.current) {
        if (!cached.url) continue
        preloadCacheRef.current.set(key, {
          ...cached,
          url: null,
          urlTimestamp: 0,
        })
      }
    }

    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, invalidatePreloadedAudioUrls)
    window.addEventListener('waveforge-auth-changed', invalidatePreloadedAudioUrls)
    return () => {
      window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, invalidatePreloadedAudioUrls)
      window.removeEventListener('waveforge-auth-changed', invalidatePreloadedAudioUrls)
    }
  }, [])

  // 预载缓存只写不删会随播放时长无限增长（歌词数组可达数百 KB/首）。
  // 定期清理过期条目并限制总条数，防止长时间播放积压内存。
  useEffect(() => {
    const PRELOAD_CACHE_TTL = 5 * 60 * 1000
    const PRELOAD_CACHE_MAX_ENTRIES = 30
    const prunePreloadCache = () => {
      const cache = preloadCacheRef.current
      const now = Date.now()
      for (const [key, value] of cache) {
        const urlAge = now - (value.urlTimestamp ?? value.timestamp)
        const lyricsAge = now - (value.lyricsTimestamp ?? value.timestamp)
        if (urlAge > PRELOAD_CACHE_TTL && lyricsAge > PRELOAD_CACHE_TTL) {
          cache.delete(key)
        }
      }
      while (cache.size > PRELOAD_CACHE_MAX_ENTRIES) {
        let oldestKey: string | null = null
        let oldestTime = Number.POSITIVE_INFINITY
        for (const [key, value] of cache) {
          const age = value.urlTimestamp ?? value.timestamp
          if (age < oldestTime) {
            oldestTime = age
            oldestKey = key
          }
        }
        if (oldestKey === null) break
        cache.delete(oldestKey)
      }
    }
    prunePreloadCache()
    const timer = window.setInterval(prunePreloadCache, 60_000)
    return () => window.clearInterval(timer)
  }, [])
  const [showUpNext, setShowUpNext] = useState(false)
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showUpNextOutsidePlayer, setShowUpNextOutsidePlayer] = useState(() => {
    const saved = localStorage.getItem('showUpNextOutsidePlayer')
    return parseStoredBoolean(saved, false)
  })
  const [upNextTime, setUpNextTime] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem('upNextSeconds') || '', 10)
    return Number.isFinite(saved) ? Math.max(5, Math.min(30, saved)) : 10
  })
  
  // Toast通知状态
  // Toast消息队列
  const [toasts, setToasts] = useState<Array<{
    id: number
    message: string
    type: 'success' | 'error' | 'info'
    accentColor?: string // 添加强调色?
  }>>([])
  const toastIdRef = useRef(0)
  const lastPlayModeChangeRef = useRef(0) // 添加防抖
  const playModeToastIdRef = useRef<number | null>(null)
  const playModeToastTimerRef = useRef<number | null>(null)
  const suppressUpNextUntilRef = useRef(0)
  
  // 添加Toast的辅助函数
  const addToast = (message: string, type: 'success' | 'error' | 'info', accentColor?: string) => {
    const id = toastIdRef.current++
    setToasts(prev => [...prev, { id, message, type, accentColor }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4000)
  }

  useEffect(() => () => {
    if (playModeToastTimerRef.current !== null) window.clearTimeout(playModeToastTimerRef.current)
  }, [])
  
  // 歌词翻译设置
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  const [currentTranslation, setCurrentTranslation] = useState('')
  
  // 罗马音设置
  const [romanEnabled, setRomanEnabled] = useState(() => {
    const saved = localStorage.getItem('romanEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  // 纯音乐模式状态
  const [isPureMusic, setIsPureMusic] = useState(false)
  const [lyricDisplayMode, setLyricDisplayMode] = useState<LyricDisplayMode>(() => {
    const saved = localStorage.getItem('lyricDisplayMode')
    return saved === 'immersive' || saved === 'wallpaper' || saved === 'glorious' || saved === 'multidimensional' ? saved : 'modern'
  })
  // 摩登模式状态 ref：resolveAppleCover 等回调读取最新值（AM 封面仅摩登使用）
  const lyricDisplayModeRef = useRef(lyricDisplayMode)
  lyricDisplayModeRef.current = lyricDisplayMode
  const [modernAudioVisualizerEnabled, setModernAudioVisualizerEnabled] = useState(() => {
    const saved = localStorage.getItem('modernAudioVisualizerEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showLyricModePanel, setShowLyricModePanel] = useState(false)
  const [showLyricModeCustomize, setShowLyricModeCustomize] = useState(false)
  const [visibleLyricModes, setVisibleLyricModes] = useState<LyricDisplayMode[]>(() => {
    const loaded = loadVisibleLyricModes()
    return loaded.includes(lyricDisplayMode) ? loaded : [...loaded, lyricDisplayMode]
  })
  const [isLyricModeTopHovered, setIsLyricModeTopHovered] = useState(false)
  const [showLyricModeArrowHint, setShowLyricModeArrowHint] = useState(false)
  const [hideImmersiveSongInfo, setHideImmersiveSongInfo] = useState(() => {
    const saved = localStorage.getItem('hideImmersiveSongInfo')
    return parseStoredBoolean(saved, false)
  })
  
  // 播放模式状态
  const [playerTheme, setPlayerTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('playerTheme')
    return (saved as 'dark' | 'light') || 'dark'
  })

  // 将主题同步到根节点属性，供全局 CSS（玻璃质感等）做浅色适配
  useEffect(() => {
    document.documentElement.dataset.wfTheme = playerTheme
  }, [playerTheme])
  
  // 歌词状态
  const [backgroundEffect, setBackgroundEffect] = useState<'transparent' | 'blur' | 'immersive'>(() => {
    const saved = localStorage.getItem('backgroundEffect')
    return (saved as 'transparent' | 'blur' | 'immersive') || 'blur'
  })
  
  // 背景模糊度（仅用于透明模式）
  const [backgroundBlur, setBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('backgroundBlur')
    return saved ? parseFloat(saved) : 30 // 默认值 30px
  })
  
  // Crossfade 设置
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(() => {
    const saved = localStorage.getItem('crossfadeEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = localStorage.getItem('crossfadeDuration')
    return saved ? parseFloat(saved) : 4 // 默认值 4 秒
  })
  
  // Gapless 设置
  const [gaplessEnabled, setGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('gaplessEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  // Gapless 动画设置
  // 专辑融合设置
  const [albumGaplessEnabled, setAlbumGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('albumGaplessEnabled')
    return parseStoredBoolean(saved, true)
  })

  const [audioAnalyzerEnabled, setAudioAnalyzerEnabled] = useState(() => {
    const saved = localStorage.getItem('audioAnalyzerEnabled')
    return parseStoredBoolean(saved, true)
  })

  const [autoMixEnabled, setAutoMixEnabled] = useState(() => {
    const saved = localStorage.getItem('autoMixEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [autoMixBeatMatching, setAutoMixBeatMatching] = useState(() => {
    const saved = localStorage.getItem('autoMixBeatMatching')
    return parseStoredBoolean(saved, true)
  })
  const [autoMixSkipSilence, setAutoMixSkipSilence] = useState(() => {
    const saved = localStorage.getItem('autoMixSkipSilence')
    return parseStoredBoolean(saved, true)
  })
  const [autoMixMinDuration, setAutoMixMinDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMinDuration')
    return saved ? parseFloat(saved) : 2
  })
  const [autoMixMaxDuration, setAutoMixMaxDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMaxDuration')
    return saved ? parseFloat(saved) : 12
  })
  
  // 切歌过渡状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [transitionState, setTransitionState] = useState<TransitionState>('idle')
  const [transitionStrategy, setTransitionStrategy] = useState<TransitionStrategy>('none')
  const [transitionFallbackReason, setTransitionFallbackReason] = useState<string | undefined>()
  const [isLyricsTransitioning, setIsLyricsTransitioning] = useState(false) // 歌词过渡状态（不影响UI）
  const [transitionProgress, setTransitionProgress] = useState(0) // 过渡进度 0-1
  const [transitionStartTime, setTransitionStartTime] = useState<number | null>(null)
  const [transitionFromTrack, setTransitionFromTrack] = useState<{
    trackKey: string
    coverUrl: string
    title: string
    artist: string
    dominantColor?: string | null
  } | null>(null)
  const [transitionToTrack, setTransitionToTrack] = useState<{
    trackKey: string
    coverUrl: string
    title: string
    artist: string
    dominantColor?: string | null
  } | null>(null)
  const [transitionFromAccentColor, setTransitionFromAccentColor] = useState<string | null>(null)
  const [transitionToAccentColor, setTransitionToAccentColor] = useState<string | null>(null)
  const wasAudioTransitioningRef = useRef(false)
  // 过渡状态 1.5s 复位定时器：统一跟踪，避免快速连切时定时器叠加、卸载后迟到 setState
  const transitionResetTimerRef = useRef<number | null>(null)
  const clearTransitionResetTimer = () => {
    if (transitionResetTimerRef.current !== null) {
      window.clearTimeout(transitionResetTimerRef.current)
      transitionResetTimerRef.current = null
    }
  }
  useEffect(() => () => clearTransitionResetTimer(), [])
  
  // 当前播放进度
  const currentSong = currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null
  const isPlaybackPage = viewMode === 'minimal' && Boolean(currentSong) && !showHome
  const canShowUpNextOnCurrentSurface = isPlaybackPage || showUpNextOutsidePlayer

  // TV 遥控器 BACK 兜底（最低优先级，弹窗/面板的 useTvBack 优先消费）：
  // 个人中心页回主页、播放页回主页；其他情况不消费（交给原生层）。
  // 用 ref 读最新状态避免 deps 变化把本处理器顶到栈尾抢在弹窗之前。
  const backStateRef = useRef({ isPlaybackPage, showProfile })
  backStateRef.current = { isPlaybackPage, showProfile }
  useTvBack(() => {
    if (backStateRef.current.showProfile) {
      setShowProfile(false)
      return true
    }
    if (backStateRef.current.isPlaybackPage) {
      setShowHome(true)
      return true
    }
    return false
  }, [])

  const playlistKeys = useMemo(() => playlist.map(getSongKey), [playlist])
  // 看歌预加载：即将播放的后 2 首歌（预匹配评分高的 B 站视频）
  const watchUpcomingSongs = useMemo(() => {
    if (!playlist.length || typeof currentIndex !== 'number' || currentIndex < 0) return []
    const upcoming: Array<{ songTitle: string; songArtists: string[]; songDuration: number; platform?: string; id?: string | number }> = []
    for (let offset = 1; offset <= 2; offset += 1) {
      const song = playlist[currentIndex + offset]
      if (!song) break
      upcoming.push({
        songTitle: song.name,
        songArtists: (song.artists || []).map((artist: any) => artist.name).filter(Boolean),
        songDuration: (song.duration || 0) / 1000,
        platform: song.platform,
        id: song.id || song.mid,
      })
    }
    return upcoming
  }, [playlist, currentIndex])
  const deterministicNextIndex = useMemo(
    () => getDeterministicNextIndex(playlistKeys, currentIndex, playMode, queueRevision),
    [playlistKeys, currentIndex, playMode, queueRevision]
  )
  const currentMiniLyric = useMemo(() => {
    const adjustedTime = currentTime + 0.5 + lyricOffset
    for (let index = lyrics.length - 1; index >= 0; index--) {
      if (lyrics[index].time <= adjustedTime) return lyrics[index].text
    }
    return ''
  }, [currentTime, lyricOffset, lyrics])
  const currentLyricIndex = useMemo(() => {
    const adjustedTime = currentTime + 0.5 + lyricOffset
    if (lyrics.length === 0 || adjustedTime < lyrics[0].time) return -1
    for (let index = lyrics.length - 1; index >= 0; index--) {
      if (lyrics[index].time <= adjustedTime) return index
    }
    return -1
  }, [currentTime, lyricOffset, lyrics])
  const currentLyricLine = currentLyricIndex >= 0 ? lyrics[currentLyricIndex] : null
  const immersiveLyricLine = useMemo(() => {
    const hasVisibleContent = (line: LyricLine | null | undefined) =>
      Boolean(line?.text?.trim() || line?.translation?.trim() || line?.roman?.trim())

    if (hasVisibleContent(currentLyricLine)) return currentLyricLine

    if (currentLyricIndex >= 0) {
      for (let index = currentLyricIndex - 1; index >= 0; index--) {
        if (hasVisibleContent(lyrics[index])) return lyrics[index]
      }
    }

    return lyrics.find(hasVisibleContent) || null
  }, [currentLyricIndex, currentLyricLine, lyrics])
  const desktopLyrics = useMemo(() => buildDesktopLyricsWithInterludes(lyrics), [lyrics])
  const desktopLyricLine = useMemo(() => {
    const adjustedTime = currentTime + 0.28 + lyricOffset
    for (let index = desktopLyrics.length - 1; index >= 0; index--) {
      const line = desktopLyrics[index]
      if (line.time <= adjustedTime) {
        if (line.isGeneratedInterlude && line.interludeEndTime !== undefined && currentTime + lyricOffset >= line.interludeEndTime) {
          return desktopLyrics[index + 1] || line
        }
        return line
      }
    }
    return null
  }, [currentTime, lyricOffset, desktopLyrics])
  const desktopLyricDuration = useMemo(() => {
    if (!desktopLyricLine) return 4.2
    const index = desktopLyrics.indexOf(desktopLyricLine)
    const nextTime = desktopLyrics[index + 1]?.time
    if (nextTime !== undefined) return Math.max(0.4, nextTime - desktopLyricLine.time)
    const wordEnd = desktopLyricLine.words?.reduce((end, word) => Math.max(end, word.startTime + Math.max(0, word.duration)), 0) || 0
    return wordEnd >= 400 ? wordEnd / 1000 : 4.2
  }, [desktopLyricLine, desktopLyrics])
  const desktopNextLyricLine = useMemo(() => {
    if (!desktopLyricLine) return null
    const currentIndex = desktopLyrics.indexOf(desktopLyricLine)
    for (let index = currentIndex + 1; index < desktopLyrics.length; index++) {
      const candidate = desktopLyrics[index]
      if (candidate?.isGeneratedInterlude) continue
      if (candidate?.text?.trim() || candidate?.translation?.trim() || candidate?.roman?.trim()) return candidate
    }
    return null
  }, [desktopLyricLine, desktopLyrics])
  const immersiveLyricText = immersiveLyricLine?.text?.trim()
    || immersiveLyricLine?.translation?.trim()
    || immersiveLyricLine?.roman?.trim()
    || ''

  // URL 与歌词分开预载，并共享同一个进行中的歌词请求。无缝切歌时先使用
  // 已返回的基础歌词，随后原位升级为 TTML 逐字、翻译和罗马音组合结果。
  const ensureSongLyrics = useCallback((song: Song, cacheKey = getSongKey(song)): Promise<LyricLine[]> => {
    const cached = preloadCacheRef.current.get(cacheKey)
    const cachedUrlTimestamp = cached?.urlTimestamp ?? (cached?.url ? cached.timestamp : undefined)
    const isFresh = cached && Date.now() - (cached.lyricsTimestamp ?? cached.timestamp) < 5 * 60 * 1000
    if (isFresh && cached.lyricsLoaded) return Promise.resolve(cached.lyrics)
    if (isFresh && cached.lyricsPromise) return cached.lyricsPromise

    const platform = song.platform || 'netease'
    const songId = platform === 'qq' ? (song.mid || song.id) : song.id
    const lyricsCacheGeneration = lyricsCacheGenerationRef.current
    let lyricsLoadedFromPersistentCache = false
    // 歌词缓存版本：评分/数据源/解析逻辑变更时递增，使旧缓存（旧解析选中的劣质/残缺源）失效。
    // v2→v3：修复网易云"JSON 元数据+LRC 正文"混合格式解析后，旧缓存里的"作词/作曲"空壳必须作废。
    const lyricsCacheKey = `v3:${cacheKey}`
    const request = indexedDBCache.getCachedLyrics<LyricLine[]>(lyricsCacheKey, platform)
      .catch(() => null)
      .then(persistedLyrics => {
        if (Array.isArray(persistedLyrics)) {
          lyricsLoadedFromPersistentCache = true
          return persistedLyrics
        }
        return getLyrics(
      songId,
      platform,
      song.name,
      song.artists.map(artist => artist.name).join(', '),
      song.duration,
      (progressLyrics, source, hasWordByWord) => {
        if (lyricsCacheGeneration !== lyricsCacheGenerationRef.current) return
        const latest = preloadCacheRef.current.get(cacheKey)
        preloadCacheRef.current.set(cacheKey, {
          url: latest?.url ?? cached?.url ?? null,
          lyrics: progressLyrics,
          timestamp: Date.now(),
          urlTimestamp: latest?.urlTimestamp ?? cachedUrlTimestamp,
          lyricsTimestamp: Date.now(),
          lyricsLoaded: false,
          lyricsPromise: latest?.lyricsPromise,
        })
        if (activeTrackKeyRef.current === cacheKey) {
          debugLog(`📝 歌词更新: ${source} (${progressLyrics.length}行 逐字=${hasWordByWord})`)
          setLyrics(progressLyrics)
          setIsPureMusic(progressLyrics.length === 0 || progressLyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐')))
        }
      }
        )
      }).then(finalLyrics => {
      if (lyricsCacheGeneration !== lyricsCacheGenerationRef.current) return finalLyrics
      if (!lyricsLoadedFromPersistentCache && finalLyrics.length > 0) {
        void indexedDBCache.cacheLyrics(lyricsCacheKey, platform, finalLyrics)
          .catch(error => console.warn('写入歌词缓存失败:', error))
      }
      const latest = preloadCacheRef.current.get(cacheKey)
      preloadCacheRef.current.set(cacheKey, {
        url: latest?.url ?? cached?.url ?? null,
        lyrics: finalLyrics,
        timestamp: Date.now(),
        urlTimestamp: latest?.urlTimestamp ?? cachedUrlTimestamp,
        lyricsTimestamp: Date.now(),
        lyricsLoaded: true,
      })
      if (activeTrackKeyRef.current === cacheKey) {
        setLyrics(finalLyrics)
        setIsPureMusic(finalLyrics.length === 0 || finalLyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐')))
      }
      return finalLyrics
    }).catch(error => {
      const latest = preloadCacheRef.current.get(cacheKey)
      preloadCacheRef.current.set(cacheKey, {
        url: latest?.url ?? cached?.url ?? null,
        lyrics: latest?.lyrics || cached?.lyrics || [],
        timestamp: latest?.timestamp || cached?.timestamp || Date.now(),
        urlTimestamp: latest?.urlTimestamp ?? cachedUrlTimestamp,
        lyricsTimestamp: latest?.lyricsTimestamp ?? cached?.lyricsTimestamp,
        lyricsLoaded: false,
      })
      console.warn(`[Lyrics preload] ${song.name} 加载失败:`, error)
      return []
    })

    preloadCacheRef.current.set(cacheKey, {
      url: cached?.url ?? null,
      lyrics: cached?.lyrics || [],
      timestamp: Date.now(),
      urlTimestamp: cachedUrlTimestamp,
      lyricsTimestamp: Date.now(),
      lyricsLoaded: false,
      lyricsPromise: request,
    })
    return request
  }, [])

  // Apple Music：非阻塞解析曲目匹配，为摩登模式的动态粒子效果提供 AM 封面。
  // 规则：显示封面永远用平台（AM 不替换、不补位）；AM 封面仅在高置信匹配时供
  // 摩登动态效果使用（避免 iTunes 同名不同曲/地区版本误判）。
  const resolveAppleCover = useCallback((song: Song) => {
    // 隔离：AM 封面仅摩登模式使用，非摩登一律不解析（连 iTunes 请求都省）
    if (lyricDisplayModeRef.current !== 'modeng') {
      setAppleCoverUrl(null)
      return
    }
    const settings = getAppleMusicSettings()
    const latestKey = getSongKey(song)
    if (!settings.enabled || !settings.preferAppleCover) {
      setAppleCoverUrl(null)
      return
    }
    const title = song.name
    const artist = song.artists.map(a => a.name).join(', ')
    if (!title || !artist) {
      setAppleCoverUrl(null)
      return
    }
    void resolveAppleTrack(title, artist, song.duration)
      .then(match => {
        // 切歌后丢弃过期结果
        if (activeTrackKeyRef.current !== latestKey) return
        if (!match?.artworkUrl) {
          setAppleCoverUrl(null)
          return
        }
        // 高置信匹配校验：标题命中 +（歌手或时长）验证通过，才认为 AM 曲目正确
        const norm = (s: string) => String(s || '').toLowerCase().replace(/[\s·•\-–—()（）[\]【】「」『』<>《》"'`,.，。！？!?&/|:：]+/g, '')
        const t = norm(match.trackName)
        const a = norm(match.artistName)
        const songT = norm(song.name)
        const songA = norm(song.artists.map(x => x.name).join(' '))
        const titleOk = songT && (t === songT || t.includes(songT) || songT.includes(t))
        const artistOk = songA && (a === songA || a.includes(songA) || songA.includes(a))
        const durationOk = song.duration ? Math.abs((match.durationMs || 0) - song.duration) < 3000 : true
        setAppleCoverUrl(titleOk && (artistOk || durationOk) ? getProxiedImageUrl(match.artworkUrl) : null)
      })
      .catch(() => {
        if (activeTrackKeyRef.current === latestKey) setAppleCoverUrl(null)
      })
  }, [])

  useEffect(() => {
    const clearLyricsMemory = () => {
      lyricsCacheGenerationRef.current += 1
      for (const [key, value] of preloadCacheRef.current) {
        preloadCacheRef.current.set(key, {
          ...value,
          lyrics: [],
          lyricsLoaded: false,
          lyricsPromise: undefined,
          lyricsTimestamp: undefined,
        })
      }
    }
    window.addEventListener('waveforge:lyrics-cache-cleared', clearLyricsMemory)
    return () => window.removeEventListener('waveforge:lyrics-cache-cleared', clearLyricsMemory)
  }, [])

  useEffect(() => {
    const handleLyricOffsetChange = (event: Event) => {
      setLyricOffset(Number((event as CustomEvent<number>).detail) || 0)
    }
    window.addEventListener('lyricOffsetChanged', handleLyricOffsetChange)
    return () => window.removeEventListener('lyricOffsetChanged', handleLyricOffsetChange)
  }, [])

  useEffect(() => {
    const handleHideImmersiveSongInfoChange = (event: Event) => {
      setHideImmersiveSongInfo(Boolean((event as CustomEvent<boolean>).detail))
    }

    window.addEventListener('hideImmersiveSongInfoChanged', handleHideImmersiveSongInfoChange)
    return () => window.removeEventListener('hideImmersiveSongInfoChanged', handleHideImmersiveSongInfoChange)
  }, [])

  useEffect(() => {
    const handleModernAudioVisualizerChange = (event: Event) => {
      setModernAudioVisualizerEnabled(Boolean((event as CustomEvent<boolean>).detail))
    }

    window.addEventListener('modernAudioVisualizerChanged', handleModernAudioVisualizerChange)
    return () => window.removeEventListener('modernAudioVisualizerChanged', handleModernAudioVisualizerChange)
  }, [])
  
  // 登录状态
  const [neteaseLoggedIn, setNeteaseLoggedIn] = useState(() => Boolean(
    localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie')
  ))
  const [neteaseUsername, setNeteaseUsername] = useState(() => localStorage.getItem('netease_username') || '')
  const [neteaseAvatar, setNeteaseAvatar] = useState(() => localStorage.getItem('netease_avatar') || '')
  const [neteaseUserId, setNeteaseUserId] = useState(() => localStorage.getItem('netease_user_id') || '')
  const [neteaseVip, setNeteaseVip] = useState(() => localStorage.getItem('netease_vip') === 'true')
  const [_neteaseCookie, setNeteaseCookie] = useState(() => (
    localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
  ))
  const [qqLoggedIn, setQQLoggedIn] = useState(() => Boolean(
    localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || localStorage.getItem('qq_logged_in') === 'true'
  ))
  const [qqUsername, setQQUsername] = useState(() => localStorage.getItem('qq_username') || '')
  const [qqAvatar, setQQAvatar] = useState(() => localStorage.getItem('qq_avatar') || '')
  const [qqUserId, setQQUserId] = useState(() => localStorage.getItem('qq_user_id') || '')
  const [qqVip, setQQVip] = useState(() => localStorage.getItem('qq_vip') === 'true')
  const [_qqCookie, setQQCookie] = useState(() => (
    localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
  ))
  // Spotify：OAuth token 登录
  const [spotifyLoggedIn, setSpotifyLoggedIn] = useState(() => Boolean(localStorage.getItem('spotify_access_token')))
  const [spotifyUsername, setSpotifyUsername] = useState(() => localStorage.getItem('spotify_username') || '')
  const [spotifyAvatar, setSpotifyAvatar] = useState(() => localStorage.getItem('spotify_avatar') || '')
  const [spotifyUserId, setSpotifyUserId] = useState(() => localStorage.getItem('spotify_user_id') || '')
  // 酷狗音乐：扫码 cookie 登录（KuGoo 网页会话 或 kg_token 客户端令牌）
  const [kugouLoggedIn, setKugouLoggedIn] = useState(() => {
    const cookie = localStorage.getItem('kugou_cookie') || ''
    return Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
  })
  const [kugouUsername, setKugouUsername] = useState(() => localStorage.getItem('kugou_username') || '')
  const [kugouAvatar, setKugouAvatar] = useState(() => localStorage.getItem('kugou_avatar') || '')
  const [kugouUserId, setKugouUserId] = useState(() => localStorage.getItem('kugou_user_id') || '')
  // 汽水音乐：抖音扫码 token 登录
  const [sodaLoggedIn, setSodaLoggedIn] = useState(() => Boolean(localStorage.getItem('soda_token')))
  const [sodaUsername, setSodaUsername] = useState(() => localStorage.getItem('soda_username') || '')
  const [sodaAvatar, setSodaAvatar] = useState(() => localStorage.getItem('soda_avatar') || '')
  const [sodaUserId, setSodaUserId] = useState(() => localStorage.getItem('soda_user_id') || '')
  const [loginRestoreComplete, setLoginRestoreComplete] = useState(false)
  // 登录态发生变化后通知首页、个人中心等依赖平台账号的视图刷新。
  const [authRevision, setAuthRevision] = useState(0)

  useEffect(() => {
    if (!currentSong) {
      recentPlaybackReportRef.current = {
        songKey: '',
        reported: false,
        inFlight: false,
        attempts: 0,
        nextRetryAt: 0,
        lastObservedTime: 0,
      }
      return
    }
    // Apple 曲目不向网易云/QQ 上报最近播放（Apple 端由 amp-api 记录）
    if (currentSong.platform === 'apple') {
      recentPlaybackReportRef.current = {
        songKey: '',
        reported: false,
        inFlight: false,
        attempts: 0,
        nextRetryAt: 0,
        lastObservedTime: 0,
      }
      return
    }

    const platform = (currentSong.platform || 'netease') as 'netease' | 'qq'
    const songKey = getSongKey(currentSong)
    const effectiveDuration = duration > 0
      ? duration
      : Math.max(0, Number(currentSong.duration) / 1000)
    const reportThreshold = effectiveDuration > 0
      ? Math.min(30, Math.max(10, effectiveDuration * 0.1), Math.max(1, effectiveDuration - 1))
      : 30
    let session = recentPlaybackReportRef.current

    if (session.songKey !== songKey) {
      session = {
        songKey,
        reported: false,
        inFlight: false,
        attempts: 0,
        nextRetryAt: 0,
        lastObservedTime: currentTime,
      }
      recentPlaybackReportRef.current = session
    } else {
      const restartedFromBeginning = currentTime <= 1.5
        && session.lastObservedTime >= Math.max(reportThreshold, effectiveDuration * 0.5)
      if (restartedFromBeginning) {
        session.reported = false
        session.inFlight = false
        session.attempts = 0
        session.nextRetryAt = 0
      }
      session.lastObservedTime = currentTime
    }

    if (!isPlaying || currentTime < reportThreshold || session.reported || session.inFlight) return
    if (session.attempts >= 2 || Date.now() < session.nextRetryAt) return

    const cookie = platform === 'qq' ? _qqCookie : _neteaseCookie
    if (!cookie) return

    const originPlaylist = playbackOriginRef.current.playlist as {
      id?: string | number
      tid?: string | number
      playlistId?: string | number
    } | null | undefined
    const sourceId = originPlaylist?.id
      ?? originPlaylist?.tid
      ?? originPlaylist?.playlistId
      ?? playbackOriginRef.current.albumId
      ?? currentSong.album?.id
      ?? currentSong.id
    const endpoint = platform === 'qq'
      ? 'http://localhost:3001/api/qq/record/recent/report'
      : 'http://localhost:3001/api/netease/record/recent/report'
    const body = platform === 'qq'
      ? { cookie, songId: currentSong.id }
      : {
          cookie,
          songId: currentSong.id,
          sourceId,
          playedSeconds: Math.max(1, Math.floor(currentTime)),
        }

    session.inFlight = true
    session.attempts += 1
    void fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async response => {
        const payload = await response.json().catch(() => null)
        if (!response.ok || payload?.synced !== true) {
          throw new Error('recent playback report rejected')
        }
        const activeSession = recentPlaybackReportRef.current
        if (activeSession.songKey !== songKey) return
        activeSession.reported = true
        activeSession.nextRetryAt = 0
        window.dispatchEvent(new CustomEvent('waveforge-recent-playback-reported', {
          detail: { platform },
        }))
      })
      .catch(() => {
        const activeSession = recentPlaybackReportRef.current
        if (activeSession.songKey !== songKey) return
        activeSession.nextRetryAt = Date.now() + 15_000
      })
      .finally(() => {
        const activeSession = recentPlaybackReportRef.current
        if (activeSession.songKey === songKey) activeSession.inFlight = false
      })
  }, [currentSong, currentTime, duration, isPlaying, _neteaseCookie, _qqCookie])

  useEffect(() => {
    if (!currentSong) {
      setCurrentSongLiked(false)
      return
    }

    const platform = (currentSong.platform || 'netease') as MusicPlatform
    // Apple：喜欢状态以音乐库为准（favoriteStatusService 已支持 apple）
    const userId = platform === 'apple'
      ? getFavoriteUserId('apple')
      : platform === 'netease' ? neteaseUserId : qqUserId
    if (!userId) {
      setCurrentSongLiked(false)
      return
    }

    const cachedStatus = peekSongFavoriteStatus(currentSong, platform, userId)
    if (cachedStatus !== null) {
      setCurrentSongLiked(cachedStatus)
      return
    }

    let cancelled = false
    void loadFavoriteIdentifiers(platform, userId)
      .then(() => {
        if (cancelled) return
        setCurrentSongLiked(peekSongFavoriteStatus(currentSong, platform, userId) === true)
      })
      .catch(error => {
        if (!cancelled) console.warn('Failed to read current favorite state:', error)
      })

    return () => { cancelled = true }
  }, [currentSong, neteaseUserId, qqUserId, appleLoggedIn])

  useEffect(() => {
    const handleFavoriteChange = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail
      if (detail?.type !== 'like' && detail?.type !== 'unlike') return
      applyFavoriteMutation(detail)
      if (!currentSong) return
      const currentPlatform = currentSong.platform || 'netease'
      if (detail.platform && detail.platform !== currentPlatform) return
      const changedIdentifiers = [detail.songId, detail.songMid]
        .filter((value: unknown) => value !== undefined && value !== null)
        .map((value: unknown) => String(value))
      if (!getSongIdentifiers(currentSong).some(identifier => changedIdentifiers.includes(identifier))) return

      const liked = detail.type === 'like'
      setCurrentSongLiked(liked)
    }
    window.addEventListener('playlist-content-changed', handleFavoriteChange)
    return () => window.removeEventListener('playlist-content-changed', handleFavoriteChange)
  }, [currentSong])
  
  // 是否需要预加载下一首歌曲的资源（歌曲URL和歌词）
  const hasTranslation = useMemo(() => lyrics.some(lyric => Boolean(lyric.translation?.trim())), [lyrics])
  const hasRoman = useMemo(() => lyrics.some(lyric => Boolean(lyric.roman?.trim()) || Boolean(lyric.romanWords?.length)), [lyrics])
  
  // handleNext 与 dominantColor 的声明位置在 useAudioPlayer 之后，无法放入其回调的依赖数组，
  // 因此用 ref 保存最新引用，供回调在运行时读取，避免陈旧闭包。
  const handleNextRef = useRef<() => void>(() => undefined)
  const dominantColorRef = useRef<string>('#3B82F6')
  
  // 调音室音效引擎：通过统一适配层（IAudioEngineAdapter）接入 v1/v2/v3，App 不再直接持有引擎实例。
  // engineAdapterRef 在版本切换时重建（getEngineAdapter(next)）；addToast 注入给 v2 低音量提示。
  const engineAdapterRef = useRef<IAudioEngineAdapter>(getEngineAdapter(getAudioEngineVersion(getAvailableEngineIds()), {
    onLowVolumeHint: (msg) => addToast(msg, 'info'),
  }))
  const audioGraphHandleRef = useRef<AudioGraphHandle | null>(null)

  // 订阅初始 adapter 的导出状态（若启动时默认 v3，导出按钮需要此状态；切换引擎时在 switchAudioEngine 内重新订阅）
  useEffect(() => {
    const adapter = engineAdapterRef.current
    if (!adapter.onExportingChange) return
    return adapter.onExportingChange(setEngineExporting)
  }, [])

  const handleAudioGraphReady = useCallback((handle: AudioGraphHandle) => {
    audioGraphHandleRef.current = handle
    // 统一接入：adapter.attach 内部按版本走 v1/v2 同步或 v3 异步（worklet 注册）
    void engineAdapterRef.current.attach(handle).catch(() => { /* 通路不可用：保持直连，播放不受影响 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 引擎切换：热切换（暂停音乐 → 替换音频图效果链 → 恢复播放），
  // 音频图未就绪时退化为冷切换（仅保存配置，下次启动生效）。切换后右上角弹 2s 提示。
  // 注意：audioPlayer 在其后声明，此回调仅作引用传递，由调用方（调音室）在运行时触发。
  const switchAudioEngineRef = useRef<(next: AudioEngineVersion) => void>(() => undefined)

  // 系统音量检测：告知引擎频响补偿/等响度补偿（按 capabilities 判断，不再写版本分支）
  useEffect(() => {
    const adapter = engineAdapterRef.current
    if (!adapter.capabilities.supportsSystemVolume) return // v1 无此能力，不轮询避免 IPC 空转
    let cancelled = false
    let timer: number | null = null
    const checkSystemVolume = async () => {
      try {
        const result = await window.electron?.audio?.getSystemVolume()
        if (cancelled || !result || !result.success) return
        // 统一调 adapter.setSystemVolume：v2 内部含低音量提示（capabilities.supportsLowVolumeHint）
        adapter.setSystemVolume(result.volume)
      } catch {
        // 忽略：系统音量不可用（非 Windows / 读取失败）
      }
    }
    void checkSystemVolume()
    // 每 10 分钟刷新一次，让频响补偿跟随音量变化
    timer = window.setInterval(() => { void checkSystemVolume() }, 600_000)
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
    }
    // eslint 无：adapter 通过 ref 读取最新实例
  }, [audioEngineVersion])

  // 服务健康检测：应用启动后约 3s（等待 Python 子进程就绪），检测频响补偿（3004）与响度（3003）
  // 服务是否正常；就绪时各弹一次 toast（localStorage 防重复）。失败静默——服务降级已有回退，
  // 浏览器预览等无服务环境不会弹提示。
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      const checkService = async (port: number, readyMessage: string, storageKey: string) => {
        try {
          if (localStorage.getItem(storageKey)) return
          const controller = new AbortController()
          const timeoutId = window.setTimeout(() => controller.abort(), 2000)
          const res = await fetch(`http://localhost:${port}/health`, { signal: controller.signal })
          window.clearTimeout(timeoutId)
          if (cancelled || !res.ok) return
          localStorage.setItem(storageKey, '1')
          addToast(readyMessage, 'info')
        } catch {
          // 忽略：服务未就绪 / 不存在（浏览器预览、服务未启动等），静默降级
        }
      }
      void checkService(3004, '频响补偿服务已就绪', 'waveforge:service-3004-toasted')
      void checkService(3003, '响度服务已就绪', 'waveforge:service-3003-toasted')
    }, 3000)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // 仅挂载时检测一次；addToast 为渲染内稳定函数，闭包读取最新 state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 响度归一化：开关在调音室切换时即时应用/回退（按 capabilities 判断，v1/v3 no-op）
  useEffect(() => {
    const adapter = engineAdapterRef.current
    if (!adapter.capabilities.supportsLoudnessNormalization) return // v1/v3 无外部归一化（v3 引擎内实时）
    const handleNormalizationChange = (e: Event) => {
      const enabled = (e as CustomEvent).detail === true
      if (!enabled) {
        adapter.resetLoudnessNormalization()
        return
      }
      const trackKey = activeTrackKeyRef.current
      if (!trackKey) return
      const cached = preloadCacheRef.current.get(trackKey)
      const url = cached?.url || ''
      if (url) adapter.applyLoudnessNormalization(trackKey, url)
    }
    window.addEventListener('normalizationEnabledChanged', handleNormalizationChange)
    return () => window.removeEventListener('normalizationEnabledChanged', handleNormalizationChange)
  }, [audioEngineVersion])
  
  // 播放器状态监听器
  const audioPlayer = useAudioPlayer(
    useCallback((state) => {
      if (state.isPlaying !== undefined) setIsPlaying(state.isPlaying)
      if (state.currentTime !== undefined) {
        const now = performance.now()
        const lastCommit = currentTimeCommitRef.current
        const playbackDelta = Math.abs(state.currentTime - lastCommit.playbackTime)
        const shouldCommitToReact = state.isPlaying === false
          || state.currentTime === 0
          || state.currentTime + 0.5 < lastCommit.playbackTime
          || playbackDelta >= 1
          || now - lastCommit.wallTime >= 900

        if (shouldCommitToReact) {
          currentTimeCommitRef.current = { wallTime: now, playbackTime: state.currentTime }
          setCurrentTime(state.currentTime)
        }
        
        // 检查是否接近结束，显示"即将播放下一首"提示
        // 立即切换到下一首，不等待当前歌曲播放完
      const useTransitionCountdown = autoMixEnabled || gaplessEnabled
      // gapless/autoMix 启用时以 transitionStartTime 为倒计时基准；但该值在
      // preparing-next、播放加载、取消等路径会为 null——必须 fallback 到 duration，
      // 否则下方 `eventTime !== null` 检查失败，「即将播放下一首」弹窗永不显示。
      const eventTime = useTransitionCountdown ? (transitionStartTime ?? duration) : duration
      const timeRemaining = (eventTime ?? duration) - state.currentTime
      
      // 提前1秒开始淡出（仅淡出提示本身，不主动关闭用户打开的设置/个人/搜索面板）
      // 如果正在过渡中或准备过渡，隐藏"即将播放"提示
      if (state.transitioning || state.transitionState === 'preparing-next' || state.transitionState === 'running-transition') {
        if (showUpNext) setShowUpNext(false)
      } else if (Date.now() < suppressUpNextUntilRef.current) {
        if (showUpNext) setShowUpNext(false)
      } else if (canShowUpNextOnCurrentSurface && playMode !== 'repeat' && upNextEnabled && duration > 0 && eventTime !== null && timeRemaining <= upNextTime && timeRemaining > 0) {
        if (!showUpNext && deterministicNextIndex !== undefined) {
          setShowUpNext(true)
        }
      } else {
        if (showUpNext) setShowUpNext(false)
      }
    }
    if (state.duration !== undefined) setDuration(state.duration)
    if (state.volume !== undefined) setVolume(state.volume)
    if (state.transitioning !== undefined) setIsTransitioning(state.transitioning)
    if (state.transitionState !== undefined) setTransitionState(state.transitionState)
    if (state.transitionStrategy !== undefined) setTransitionStrategy(state.transitionStrategy)
    if ('transitionStartTime' in state) setTransitionStartTime(state.transitionStartTime ?? null)
    if (state.fallbackReason !== undefined || state.transitionState === 'armed' || state.transitionState === 'preparing-next') {
      setTransitionFallbackReason(state.fallbackReason)
    }
    
    // 更新过渡进度
    if (state.transitionProgress !== undefined) {
      setTransitionProgress(previousProgress => {
        const shouldHoldCompletedFrame = state.transitioning === false
          && state.transitionState === 'committed'
          && state.transitionProgress === 0
          && previousProgress > 0
        return shouldHoldCompletedFrame ? previousProgress : state.transitionProgress!
      })
    }
    
    // 更新过渡轨道信息
    const shouldCaptureTransitionTracks = Boolean(
      state.transitionFromTrackKey
      && state.transitionToTrackKey
      && (
        state.transitioning
        || state.transitionState === 'preparing-next'
        || state.transitionState === 'armed'
        || state.transitionState === 'running-transition'
        || state.transitionState === 'committed'
      )
    )
    if (shouldCaptureTransitionTracks && state.transitionFromTrackKey && state.transitionToTrackKey) {
      // 根据trackKey查找歌曲信息，构建Track对象
      const fromSong = playlist.find(s => getSongKey(s) === state.transitionFromTrackKey)
      const toSong = playlist.find(s => getSongKey(s) === state.transitionToTrackKey)
      
      if (fromSong) {
        const normalizedFromSong = normalizeSongCover(fromSong)
        setTransitionFromTrack({
          trackKey: getSongKey(normalizedFromSong),
          coverUrl: normalizedFromSong.album?.picUrl || '',
          title: normalizedFromSong.name,
          artist: normalizedFromSong.artists.map(artist => artist.name).join(', '),
          dominantColor: dominantColorRef.current, // 使用当前的主色调
        })
      }
      
      if (toSong) {
        const normalizedToSong = normalizeSongCover(toSong)
        setTransitionToTrack({
          trackKey: getSongKey(normalizedToSong),
          coverUrl: normalizedToSong.album?.picUrl || '',
          title: normalizedToSong.name,
          artist: normalizedToSong.artists.map(artist => artist.name).join(', '),
          dominantColor: null, // 下一首的主色调会在切换后更新
        })
      }
    }
    
    // 过渡结束后清理
    if (state.transitionState === 'committed' && state.transitioning === false) {
      // Hold the final frame until the committed track has reached the React UI.
      setTransitionProgress(1)
    } else if (
      state.transitioning === false
      && (state.transitionState === 'cancelled' || state.transitionState === 'failed' || state.transitionState === 'idle')
    ) {
      setTransitionProgress(0)
      setTransitionFromTrack(null)
      setTransitionToTrack(null)
    }
    
    // 在过渡中点切换视觉信息
    if (state.visualSwitchCommit) {
      transitionCommitRef.current(state.visualSwitchCommit)
    }
    
    // 歌曲切换提交
    if (state.transitionCommit) {
      transitionCommitRef.current(state.transitionCommit)

      // The audio deck is already committed at this point. Clear the visual snapshot in
      // the same React batch as the canonical song switch so a completed AutoMix does not
      // keep the controls/background in their "transition" presentation indefinitely.
      setIsTransitioning(false)
      setTransitionProgress(0)
      setTransitionFromTrack(null)
      setTransitionToTrack(null)
      setTransitionFromAccentColor(null)
      setTransitionToAccentColor(null)
    }

    // ── #10 Gapless 方案弹窗：真实切歌提交时识别本次衔接方案 ──
    // 只使用现有 state 可读信息：transitionCommit（isVisualSwitch=false 才是真切换）、
    // transitionState/'seamlessTransition'、playlistRef 中的 source/target 专辑归属。
    // 三方案判定：
    //   ① 直接拼接：transitionStrategy === 'gapless' 且 source/target 同专辑（专辑无缝首选）
    //   ② 60ms 淡入淡出：transitionStrategy === 'gapless' 且非同专辑（非专辑默认/专辑兜底）
    //   ③ albumGapless 交叉淡化：adoptExternalAudio 路径（albumGaplessHandoff），
    //      无 transitionCommit，仅发 transitionState='committed' + seamlessTransition=true
    //   AutoMix：'smart-rendered' / 'beat-crossfade' / 'fixed-crossfade'
    const triggerGaplessModeToast = (message: string) => {
      // 仅开发者调试模式显示（localStorage 'waveforge:verbose-log'='1'，与详细日志同开关）；
      // 正常运行时不弹，避免每次切歌右上角提示干扰。
      if (!isVerboseLogEnabled()) return
      // 防抖：连续切歌时先清旧定时器，旧弹窗被新弹窗直接替换
      if (gaplessModeToastTimerRef.current !== null) window.clearTimeout(gaplessModeToastTimerRef.current)
      setGaplessModeToast(message)
      gaplessModeToastTimerRef.current = window.setTimeout(() => {
        gaplessModeToastTimerRef.current = null
        setGaplessModeToast(null)
      }, 2500)
    }
    if (state.transitionCommit && !state.transitionCommit.isVisualSwitch) {
      const commit = state.transitionCommit
      let toastMessage: string | null = null
      if (commit.strategy === 'gapless') {
        const sourceSong = playlistRef.current.find(s => getSongKey(s) === commit.sourceTrackKey)
        const targetSong = playlistRef.current.find(s => getSongKey(s) === commit.targetTrackKey)
        toastMessage = isSameAlbumPlayback(sourceSong, targetSong)
          ? '已用「直接拼接」无缝切换'
          : '已用「60ms 淡入淡出」切换'
      } else if (commit.strategy === 'smart-rendered') {
        toastMessage = '已用「Smart AutoMix 智能渲染」切换'
      } else if (commit.strategy === 'beat-crossfade') {
        toastMessage = '已用「Smart AutoMix 节拍交叉淡化」切换'
      } else if (commit.strategy === 'fixed-crossfade') {
        toastMessage = '已用「交叉淡化」切换'
      }
      if (toastMessage) triggerGaplessModeToast(toastMessage)
    } else if (
      state.transitionState === 'committed'
      && state.transitioning === false
      && state.seamlessTransition === true
      && !state.transitionCommit
    ) {
      // ③ albumGapless 交叉淡化 handoff（adoptExternalAudio 路径）
      triggerGaplessModeToast('已用「albumGapless 交叉淡化」切换')
    }

    if (state.ended && playlist.length > 0 && state.transitionState !== 'committed') {
      if (playMode === 'repeat') {
        // 尝试播放失败，可能需要重新登录
        audioPlayer.seek(0)
        // audioPlayer 可能在 togglePlay 之前的 play 方法中已经切换了播放状态
        audioPlayer.togglePlay()
      } else {
        // 防止在歌曲变化时快速连续调用导致竞态条件
        handleNextRef.current()
      }
    }
  }, [duration, upNextTime, upNextEnabled, showUpNext, playMode, deterministicNextIndex, autoMixEnabled, gaplessEnabled, transitionStartTime, canShowUpNextOnCurrentSurface, playlist, handleNextRef, dominantColorRef]),
    { enabled: crossfadeEnabled, duration: crossfadeDuration },
    { enabled: gaplessEnabled, albumGapless: albumGaplessEnabled },
    {
      enabled: autoMixEnabled,
      mode: 'auto',
      enableBeatMatching: autoMixBeatMatching,
      skipSilence: autoMixSkipSilence,
      minDuration: autoMixMinDuration,
      maxDuration: autoMixMaxDuration,
    },
    handleAudioGraphReady
  )
  audioPlayerCacheControlRef.current = audioPlayer
  // 保持最新 audioPlayer 引用的 ref，供 useCallback 处理器读取，避免处理器身份随渲染变化
  const audioPlayerRef = useRef(audioPlayer)
  audioPlayerRef.current = audioPlayer

  // 引擎切换（实现放在 audioPlayer 之后，规避 TDZ）：
  // 热切换 = 暂停音乐 → dispose 旧链 → attach 新链 → 恢复播放；
  // 音频图未就绪 = 冷切换（仅保存配置，下次启动生效）。切换后右上角弹 2s 提示。
  // 版本读写走 ref：同帧连点（v1→v2→v1）时每次调用读到的都是最新目标，避免闭包陈旧
  // 导致第二次被误判为"已切到目标"而吞掉，最终停在用户最后点击的版本上。
  const switchAudioEngine = useCallback((next: AudioEngineVersion) => {
    if (next === audioEngineVersionRef.current) return
    const handle = audioGraphHandleRef.current
    // 仅热切换需要暂停音乐（换链瞬间避免爆音）；冷切换引擎尚未接入音频图，无需暂停。
    // 注意：必须用 getAudioElement()（读 activePrimaryRef）取「当前真正在播的 deck」——
    // audioElement 是 state，只在初次加载/过渡提交时更新，双 deck 静默转正/gapless 拼接
    // 路径下是陈旧引用，用它判断会误判未在播 → 恢复播放打在错误的元素上 → 热切换后无声。
    const activeAudio = audioPlayerRef.current?.getAudioElement() ?? null
    const wasPlaying = !!handle && !!activeAudio && !activeAudio.paused
    if (wasPlaying) void activeAudio?.pause()

    // 换引擎：dispose 旧链（恢复 masterGain→analyser 直连），attach 新链
    const oldAdapter = engineAdapterRef.current
    if (handle) {
      oldAdapter.dispose()
    }
    // 重建 adapter：新版本实例 + 注入 addToast（v2 低音量提示用）
    const newAdapter = getEngineAdapter(next, { onLowVolumeHint: (msg) => addToast(msg, 'info') })
    engineAdapterRef.current = newAdapter
    audioEngineVersionRef.current = next
    setAudioEngineVersionState(next)
    setAudioEngineVersion(next)
    // 订阅新 adapter 的导出状态（v3 adapter 有此事件；v1/v2 adapter 无，isExporting 恒 false）
    if (newAdapter.onExportingChange) {
      newAdapter.onExportingChange(setEngineExporting)
    }
    if (handle) {
      // attach 新链（v3 异步 worklet 注册，v1/v2 同步；恢复播放不等待 attach 完成）
      void newAdapter.attach(handle).catch(() => { /* 通路不可用：保持直连 */ })
      // 补挂响度归一化（若新引擎支持且调音室已开启；adapter 内部按 capabilities 判断，不支持则 no-op）
      const trackKey = activeTrackKeyRef.current
      if (trackKey) {
        const cached = preloadCacheRef.current.get(trackKey)
        const url = cached?.url || ''
        if (url) newAdapter.applyLoudnessNormalization(trackKey, url)
      }
      // 恢复播放（热切换成功路径）：恢复同一个活跃 deck
      if (wasPlaying && activeAudio) {
        window.setTimeout(() => { void activeAudio?.play().catch(() => { /* 用户暂停等场景忽略 */ }) }, 80)
      }
    }
    // 右上角 2s 淡出弹窗（连点/重入时先清旧定时器，避免旧弹窗提前清掉新弹窗）
    if (engineSwitchToastTimerRef.current !== null) window.clearTimeout(engineSwitchToastTimerRef.current)
    const versionLabel = next === 'v3' ? 'v3（DSP 内核）' : next === 'v2' ? 'v2（增强版）' : 'v1（原版）'
    setEngineSwitchToast(`音效引擎已切换至 ${versionLabel}${handle ? '' : '，下次启动生效'}`)
    engineSwitchToastTimerRef.current = window.setTimeout(() => {
      engineSwitchToastTimerRef.current = null
      setEngineSwitchToast(null)
    }, 2000)
    setShowMixingStudio(false)
  }, [])
  switchAudioEngineRef.current = switchAudioEngine
  
  // 封面律动效果
  const [coverPulseEnabled, setCoverPulseEnabled] = useState(() => {
    const saved = localStorage.getItem('coverPulseEnabled')
    return parseStoredBoolean(saved, false)
  })

  const [coverPulseMode, setCoverPulseMode] = useState<CoverPulseMode>(() => {
    const saved = localStorage.getItem('coverPulseMode')
    if (saved === 'precise') return 'restless'
    return saved === 'dynamic' || saved === 'restless' ? saved : 'soft'
  })
  
  // 播放器状态监听
  const pulseActive = coverPulseEnabled && isPlaying
  const audioAnalyzer = useAudioAnalyzer(
    audioPlayer.analyserNode,
    audioAnalyzerEnabled && pulseActive && !isPerfModeEfficiency() // 效能档关闭音频可视化省资源
  )
  const audioPulseStore = useAudioPulseStore(audioAnalyzer, pulseActive, coverPulseMode)
  
  // 监听封面律动设置变化
  useEffect(() => {
    const handleCoverPulseChange = (e: CustomEvent) => {
      setCoverPulseEnabled(e.detail)
    }

    const handleCoverPulseModeChange = (e: CustomEvent) => {
      setCoverPulseMode(e.detail === 'precise' ? 'restless' : e.detail)
    }
    
    window.addEventListener('coverPulseChanged', handleCoverPulseChange as EventListener)
    window.addEventListener('coverPulseModeChanged', handleCoverPulseModeChange as EventListener)
    
    return () => {
      window.removeEventListener('coverPulseChanged', handleCoverPulseChange as EventListener)
      window.removeEventListener('coverPulseModeChanged', handleCoverPulseModeChange as EventListener)
    }
  }, [])

  useEffect(() => {
    const handleAudioAnalyzerChange = (e: CustomEvent) => {
      setAudioAnalyzerEnabled(e.detail)
    }
    window.addEventListener('audioAnalyzerEnabledChanged', handleAudioAnalyzerChange as EventListener)
    return () => {
      window.removeEventListener('audioAnalyzerEnabledChanged', handleAudioAnalyzerChange as EventListener)
    }
  }, [])

  // 设置 GaplessIntegration 的 playAt 回调
  useEffect(() => {
    const handlePlayAt = async (index: number, options: any) => {
      debugLog('[Gapless] playAt 被调用, 索引:', index, '选项:', options)
      
      if (index < 0 || index >= playlist.length) {
        console.warn('[Gapless] 索引越界:', index, '播放列表长度:', playlist.length)
        return false
      }
      
      const song = playlist[index]
      if (!song) {
        console.warn('[Gapless] 歌曲不存在:', index)
        return false
      }
      
      // 处理专辑无缝播放或智能混音的切换
      if (options?.albumGaplessHandoff || options?.cuefieldHandoff) {
        debugLog('[Gapless] 专辑无缝播放或智能混音切换, 模式:', options?.albumGaplessHandoff ? 'album-gapless' : 'cuefield')
        debugLog('   当前索引:', currentIndex, '-> 新索引:', index)
        debugLog('   预加载音频:', options.preloadedAudio)
        debugLog('   预加载 URL:', options.preloadedAudioUrl)
        
        // 获取歌曲详情
        let normalizedSong = normalizeSongCover(song)
        if ((normalizedSong.platform || 'netease') === 'qq' && !normalizedSong.album?.picUrl) {
          normalizedSong = await loadQQSongDetail(normalizedSong)
        }
        
        // 接管预加载的音频元素
        if (options.preloadedAudio && options.preloadedAudioUrl) {
          const success = await audioPlayer.adoptExternalAudio(options.preloadedAudio, {
            url: options.preloadedAudioUrl,
            trackKey: getSongKey(normalizedSong),
            index: index,
            duration: normalizedSong.duration / 1000,
            albumId: getLocalAlbumIdentifier(normalizedSong, normalizedSong.platform || 'netease') || undefined,
            albumCover: normalizedSong.album?.picUrl || undefined,
          })
          
          if (!success) {
            console.error('[Gapless] 接管音频失败，回退到普通加载')
            await loadAndPlaySong(normalizedSong, index)
            return true
          }
        }
        
        // The external deck is now the authoritative source. Commit the song,
        // playback clock and lyrics together so React never renders the incoming
        // lyrics against the outgoing deck's final timestamp.
        const nextRevision = bumpQueueRevision()
        const cacheKey = getSongKey(normalizedSong)
        activeTrackKeyRef.current = cacheKey
        currentIndexRef.current = index
        setCurrentIndex(index)
        setCurrentTrack(createTrackFromSong(normalizedSong))
        // Apple Music：切歌即清封面，后台匹配命中后替换为高清封面（与 loadAndPlaySong 一致）
        setAppleCoverUrl(null)
        resolveAppleCover(normalizedSong)
        setCurrentTime(audioPlayer.getAudioElement()?.currentTime || 0)
        const cachedLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics || []
        setLyrics(cachedLyrics)
        setIsPureMusic(cachedLyrics.length > 0 && cachedLyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐')))
        setCurrentTranslation('')
        void ensureSongLyrics(normalizedSong, cacheKey)

        // Every seamless handoff becomes the new queue anchor. Prepare its
        // successor immediately so transitions remain continuous across tracks.
        window.setTimeout(() => preloadUpcomingSongs(index, nextRevision), 0)
        
        return true
      }
      
      // 普通切换
      await loadAndPlaySong(song, index)
      return true
    }
    
    audioPlayer.setPlayAtCallback(handlePlayAt)
  }, [playlist, audioPlayer, volume, ensureSongLyrics, resolveAppleCover])

  useEffect(() => {
    const handleAutoMixChange = () => {
      const enabled = localStorage.getItem('autoMixEnabled')
      const beatMatching = localStorage.getItem('autoMixBeatMatching')
      const skipSilence = localStorage.getItem('autoMixSkipSilence')
      const minDuration = localStorage.getItem('autoMixMinDuration')
      const maxDuration = localStorage.getItem('autoMixMaxDuration')

      setAutoMixEnabled(parseStoredBoolean(enabled, false))
      setAutoMixBeatMatching(parseStoredBoolean(beatMatching, true))
      setAutoMixSkipSilence(parseStoredBoolean(skipSilence, true))
      setAutoMixMinDuration(minDuration ? parseFloat(minDuration) : 2)
      setAutoMixMaxDuration(maxDuration ? parseFloat(maxDuration) : 12)
    }

    window.addEventListener('autoMixSettingsChanged', handleAutoMixChange)
    return () => {
      window.removeEventListener('autoMixSettingsChanged', handleAutoMixChange)
    }
  }, [])

  useEffect(() => {
    const handleShowToast = (e: CustomEvent) => {
      const { message, type } = e.detail
      addToast(message, type as 'success' | 'error' | 'info', localStorage.getItem('accentColor') || '#3B82F6')
    }
    window.addEventListener('showToast', handleShowToast as EventListener)
    return () => {
      window.removeEventListener('showToast', handleShowToast as EventListener)
    }
  }, [])
  
  // 监听背景模糊度变化
  useEffect(() => {
    const handleBackgroundBlurChange = (e: CustomEvent) => {
      setBackgroundBlur(e.detail)
    }
    window.addEventListener('backgroundBlurChanged', handleBackgroundBlurChange as EventListener)
    return () => {
      window.removeEventListener('backgroundBlurChanged', handleBackgroundBlurChange as EventListener)
    }
  }, [])
  
  // 监听“即将播放”提示设置
  useEffect(() => {
    const handleUpNextEnabledChange = () => {
      const saved = localStorage.getItem('upNextEnabled')
      setUpNextEnabled(parseStoredBoolean(saved, true))
    }
    const handleShowUpNextOutsidePlayerChange = () => {
      const saved = localStorage.getItem('showUpNextOutsidePlayer')
      setShowUpNextOutsidePlayer(parseStoredBoolean(saved, false))
    }
    const handleUpNextSecondsChange = () => {
      const saved = Number.parseInt(localStorage.getItem('upNextSeconds') || '', 10)
      setUpNextTime(Number.isFinite(saved) ? Math.max(5, Math.min(30, saved)) : 10)
    }
    
    window.addEventListener('upNextEnabledChanged', handleUpNextEnabledChange)
    window.addEventListener('showUpNextOutsidePlayerChanged', handleShowUpNextOutsidePlayerChange)
    window.addEventListener('upNextSecondsChanged', handleUpNextSecondsChange)
    
    return () => {
      window.removeEventListener('upNextEnabledChanged', handleUpNextEnabledChange)
      window.removeEventListener('showUpNextOutsidePlayerChanged', handleShowUpNextOutsidePlayerChange)
      window.removeEventListener('upNextSecondsChanged', handleUpNextSecondsChange)
    }
  }, [])

  useEffect(() => {
    if (!canShowUpNextOnCurrentSurface && showUpNext) setShowUpNext(false)
  }, [canShowUpNextOnCurrentSurface, showUpNext])
  
  // 监听歌词翻译设置变化
  useEffect(() => {
    const handleTranslationChange = () => {
      const savedEnabled = localStorage.getItem('translationEnabled')
      const savedPosition = localStorage.getItem('translationPosition')
      setTranslationEnabled(parseStoredBoolean(savedEnabled, false))
      setTranslationPosition((savedPosition as 'traditional' | 'bottom-right') || 'traditional')
    }
    
    window.addEventListener('translationSettingsChanged', handleTranslationChange)
    window.addEventListener('translationPositionChanged', handleTranslationChange)
    
    return () => {
      window.removeEventListener('translationSettingsChanged', handleTranslationChange)
      window.removeEventListener('translationPositionChanged', handleTranslationChange)
    }
  }, [])
  
  // 监听罗马音设置变化
  useEffect(() => {
    const handleRomanChange = () => {
      const savedEnabled = localStorage.getItem('romanEnabled')
      setRomanEnabled(parseStoredBoolean(savedEnabled, false))
    }
    
    window.addEventListener('romanSettingsChanged', handleRomanChange)
    
    return () => {
      window.removeEventListener('romanSettingsChanged', handleRomanChange)
    }
  }, [])
  
  // 全局错误处理
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('全局错误:', event.error)
      cacheManager.logError(event.error)
    }
    
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('未处理的 Promise 拒绝:', event.reason)
      cacheManager.logError(event.reason)
    }
    
    const handleBeforeUnload = () => {
      // 清理缓存
      void cacheManager.clearOnClose().catch(error => console.error('关闭时清理缓存失败:', error))
    }
    
    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('beforeunload', handleBeforeUnload)
    
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
  
  // 监听音频元素事件
  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setPlayerTheme(customEvent.detail)
    }
    
    const handleBackgroundEffectChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setBackgroundEffect(customEvent.detail)
    }
    
    window.addEventListener('playerThemeChanged', handleThemeChange as EventListener)
    window.addEventListener('backgroundEffectChanged', handleBackgroundEffectChange as EventListener)
    
    return () => {
      window.removeEventListener('playerThemeChanged', handleThemeChange as EventListener)
      window.removeEventListener('backgroundEffectChanged', handleBackgroundEffectChange as EventListener)
    }
  }, [])
  
  // 监听重新打开设置面板的事件
  useEffect(() => {
    const handleReopenSettings = () => {
      setShowSettings(true)
    }
    
    window.addEventListener('reopenSettings', handleReopenSettings)
    
    return () => {
      window.removeEventListener('reopenSettings', handleReopenSettings)
    }
  }, [])
  
  // 监听视图模式变化
  useEffect(() => {
    const applyMode = (mode: 'explore' | 'minimal' | 'desktop') => {
      // TV 效能档无桌面模式：遥控器/远程/恢复路径都不会进入桌面（模式卡片也已隐藏）
      if (isTv() && isPerfModeEfficiency() && mode === 'desktop') mode = 'minimal'
      setViewMode(mode)
      setEnteredFromMode(mode)
      // 切换模式时清掉待恢复的歌单/搜索来源，避免切回后又自动打开上一次的歌单
      setRestorePlaybackOrigin(null)
      playbackOriginRef.current = { mode, surface: mode === 'minimal' ? 'home' : 'mode-root' }
      if (mode === 'desktop') setShowHome(false)
      else setShowHome(true)
    }

    const handleViewModeChange = (e: Event) => {
      const mode = (e as CustomEvent).detail as 'explore' | 'minimal' | 'desktop'
      const revision = ++viewModeChangeRevisionRef.current
      const loadTarget = mode === 'explore'
        ? loadExploreView
        : mode === 'desktop'
          ? loadDesktopView
          : loadHomeView

      // Keep the current mode painted until the destination chunk is ready, then let the
      // two prepared roots crossfade. React.lazy must never expose the black app base here.
      void loadTarget().then(() => {
        // 快速连续切换时，仅执行最新一次请求；但用户点击的模式必须最终生效，
        // 因此用「最近请求」判断：revision 与当前一致才应用（旧请求自然被丢弃）。
        if (revision !== viewModeChangeRevisionRef.current) return
        applyMode(mode)
      }).catch(error => {
        console.error('[ViewMode] Failed to load target mode:', mode, error)
        // 懒加载失败时仍切换模式，Suspense 会展示 fallback 并在下次渲染重试加载
        if (revision === viewModeChangeRevisionRef.current) applyMode(mode)
      })
    }
    
    window.addEventListener('viewModeChanged', handleViewModeChange as EventListener)
    
    return () => {
      window.removeEventListener('viewModeChanged', handleViewModeChange as EventListener)
    }
  }, [])
  
  // 监听 Crossfade 和 Gapless 设置变化
  useEffect(() => {
    const handleCrossfadeChange = () => {
      const enabled = localStorage.getItem('crossfadeEnabled')
      const duration = localStorage.getItem('crossfadeDuration')
      setCrossfadeEnabled(parseStoredBoolean(enabled, false))
      if (duration) setCrossfadeDuration(parseFloat(duration))
    }
    
    const handleGaplessChange = () => {
      const enabled = localStorage.getItem('gaplessEnabled')
      setGaplessEnabled(parseStoredBoolean(enabled, false))
    }
    
    const handleAlbumGaplessChange = () => {
      const enabled = localStorage.getItem('albumGaplessEnabled')
      setAlbumGaplessEnabled(parseStoredBoolean(enabled, true))
    }
    
    window.addEventListener('crossfadeSettingsChanged', handleCrossfadeChange)
    window.addEventListener('gaplessSettingsChanged', handleGaplessChange)
    window.addEventListener('albumGaplessSettingsChanged', handleAlbumGaplessChange)
    
    return () => {
      window.removeEventListener('crossfadeSettingsChanged', handleCrossfadeChange)
      window.removeEventListener('gaplessSettingsChanged', handleGaplessChange)
      window.removeEventListener('albumGaplessSettingsChanged', handleAlbumGaplessChange)
    }
  }, [])
  
  // 切换翻译显示
  const handleTranslationToggle = () => {
    const newValue = !translationEnabled
    setTranslationEnabled(newValue)
    localStorage.setItem('translationEnabled', JSON.stringify(newValue))
  }

  const handleRomanToggle = () => {
    const newValue = !romanEnabled
    setRomanEnabled(newValue)
    localStorage.setItem('romanEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new Event('romanSettingsChanged'))
  }

  const handleLyricDisplayModeChange = (mode: LyricDisplayMode) => {
    // Close the overlay before swapping the lyric renderer. Keeping both updates in one React batch
    // can preserve the outgoing panel when the renderer changes during its exit transition.
    setShowLyricModePanel(false)
    setShowLyricModeCustomize(false)
    setShowLyricModeArrowHint(false)
    // 切到看歌：记录音频当前播放位置，视频加载后从此处续播（歌↔视频同步的可行近似）
    if (mode === 'video') {
      const pos = Number(audioPlayerRef.current?.getAudioElement?.()?.currentTime) || 0
      setWatchSyncSeek(pos > 0 ? pos : 0)
    }
    window.requestAnimationFrame(() => {
      setLyricDisplayMode(mode)
      localStorage.setItem('lyricDisplayMode', mode)
      window.dispatchEvent(new CustomEvent('lyricDisplayModeChanged', { detail: mode }))
    })
  }
  
  // 同步其他视图修改的歌词模式可见性设置
  useEffect(() => {
    const handleLyricModesVisibilityChanged = () => setVisibleLyricModes(loadVisibleLyricModes())
    window.addEventListener('waveforge-lyric-modes-visibility-changed', handleLyricModesVisibilityChanged)
    return () => window.removeEventListener('waveforge-lyric-modes-visibility-changed', handleLyricModesVisibilityChanged)
  }, [])

  // 当前所在歌词模式始终保留在可见列表里
  const ensureModernVisible = (modes: LyricDisplayMode[]): LyricDisplayMode[] =>
    modes.includes('modern') ? modes : ['modern', ...modes]
  const effectiveVisibleLyricModes = ensureModernVisible(
    visibleLyricModes.includes(lyricDisplayMode)
      ? visibleLyricModes
      : [...visibleLyricModes, lyricDisplayMode]
  )

  const toggleLyricModeVisibility = (mode: LyricDisplayMode) => {
    const isVisible = effectiveVisibleLyricModes.includes(mode)
    // 不能隐藏当前所在模式、现代模式，也不能隐藏最后一个可见模式
    if (isVisible) {
      if (mode === lyricDisplayMode) return
      if (mode === 'modern') return
      if (effectiveVisibleLyricModes.length <= 1) return
    }
    const next = isVisible
      ? effectiveVisibleLyricModes.filter((item) => item !== mode)
      : [...effectiveVisibleLyricModes, mode]
    try {
      localStorage.setItem(LYRIC_MODE_VISIBILITY_KEY, JSON.stringify(next))
    } catch (error) {
      console.warn('保存歌词模式可见设置失败:', error)
    }
    setVisibleLyricModes(next)
    window.dispatchEvent(new Event('waveforge-lyric-modes-visibility-changed'))
  }

  // Apple Music 命中时全局替换封面（异步解析、不阻塞：先显示平台封面，命中后无缝替换）
  // 显示封面：始终用平台封面（AM 封面只用于摩登模式的动态粒子效果，不替换显示封面）
  const displayCoverUrl = currentTrack.coverUrl

  // 提取封面主色调
  const { dominantColor: extractedColor, palette: coverPalette } = useColorThief(displayCoverUrl)
  // 提取失败时使用默认强调色，过渡期间保留来源颜色以避免闪烁。
  const dominantColor = extractedColor || '#3B82F6'
  dominantColorRef.current = dominantColor
  const isVisualTransitioning = isTransitioning || Boolean(transitionToTrack && transitionProgress > 0)
  // 看歌模式下视频为唯一时间线：automix/无缝/交叉过渡全部失效
  const effectiveTransitionStrategy = lyricDisplayMode === 'video' ? 'none' : transitionStrategy
  // AutoMix 过渡时，播放页过渡指示显示 AutoMix 以与无缝衔接(Gapless)区分
  const isAutoMixTransition = autoMixEnabled && effectiveTransitionStrategy !== 'gapless' && effectiveTransitionStrategy !== 'none'

  useEffect(() => {
    const wasTransitioning = wasAudioTransitioningRef.current
    if (isTransitioning && !wasTransitioning) {
      setTransitionFromAccentColor(dominantColor)
    }
    wasAudioTransitioningRef.current = isTransitioning
  }, [dominantColor, isTransitioning])

  useEffect(() => {
    const coverUrl = transitionToTrack?.coverUrl
    let cancelled = false

    if (!coverUrl) {
      setTransitionToAccentColor(null)
      return
    }

    extractDominantColor(coverUrl).then(color => {
      if (!cancelled) setTransitionToAccentColor(color)
    })

    return () => {
      cancelled = true
    }
  }, [transitionToTrack?.coverUrl])

  useEffect(() => {
    if (isTransitioning || transitionProgress < 0.995 || !transitionToTrack) return

    const targetUiReady = currentSong !== null
      && getSongKey(currentSong) === transitionToTrack.trackKey
    if (!targetUiReady) return

    const releaseTimer = window.setTimeout(() => {
      setTransitionProgress(0)
      setTransitionFromTrack(null)
      setTransitionToTrack(null)
      setTransitionFromAccentColor(null)
      setTransitionToAccentColor(null)
    }, 80)

    return () => window.clearTimeout(releaseTimer)
  }, [
    currentSong,
    isTransitioning,
    transitionProgress,
    transitionToTrack?.artist,
    transitionToTrack?.coverUrl,
    transitionToTrack?.title,
  ])

  const closeArtistDetail = () => {
    // 导航栈：如果有上一级，返回上一级
    const prev = navigationStack.current.pop()
    if (prev) {
      if (prev.type === 'artist') {
        setSelectedArtistId(prev.id)
        setSelectedArtistPlatform(prev.platform)
        setSelectedArtistTab((prev.tab || 'hotSongs') as any)
        setShowArtistDetail(true)
        return
      } else if (prev.type === 'album') {
        setSelectedAlbumId(prev.id)
        setSelectedAlbumPlatform(prev.platform)
        setShowAlbumDetail(true)
        return
      }
    }
    setShowArtistDetail(false)
    setSelectedArtistId(null)
    setSelectedArtistAlbumId(undefined)
  }

  const closeAlbumDetail = () => {
    const prev = navigationStack.current.pop()
    if (prev) {
      if (prev.type === 'album') {
        setSelectedAlbumId(prev.id)
        setSelectedAlbumPlatform(prev.platform)
        setShowAlbumDetail(true)
        return
      } else if (prev.type === 'artist') {
        setSelectedArtistId(prev.id)
        setSelectedArtistPlatform(prev.platform)
        setSelectedArtistTab((prev.tab || 'hotSongs') as any)
        setShowArtistDetail(true)
        return
      }
    }
    setShowAlbumDetail(false)
    setSelectedAlbumId(null)
  }

  const closeCommentModal = () => {
    setShowCommentModal(false)
    setSelectedCommentSong(null)
  }

  // 完全关闭歌手/专辑弹窗并清空导航栈。
  // 与 close*Detail（返回上一级）不同：选中歌曲、查看评论等场景要的是"彻底关闭"，
  // 若沿用 close*Detail 会在栈非空时把上一级弹窗重新打开，留下脏栈条目。
  const dismissArtistDetail = () => {
    navigationStack.current = []
    setShowArtistDetail(false)
    setSelectedArtistId(null)
    setSelectedArtistAlbumId(undefined)
  }

  const dismissAlbumDetail = () => {
    navigationStack.current = []
    setShowAlbumDetail(false)
    setSelectedAlbumId(null)
  }

  // 压栈统一入口：栈顶去重 + 深度上限，避免相似歌手自引用造成无限入栈
  const pushNavigation = (entry: { type: 'artist' | 'album'; id: string; platform: MusicPlatform; tab?: string }) => {
    const stack = navigationStack.current
    const top = stack[stack.length - 1]
    if (top && top.type === entry.type && top.id === entry.id && top.platform === entry.platform) return
    if (stack.length >= 20) stack.shift()
    stack.push(entry)
  }

  // 歌曲详情「也爱歌单」→ 应用内打开歌单详情
  const handleOpenPlaylistFromDetail = async (playlistId: string, platform: 'netease' | 'qq') => {
    setDetailPlaylistLoading(true)
    try {
      const data = await getPlaylistDetail(playlistId, platform)
      const songs = data?.songs || data?.songlist || data?.playlist?.tracks || []
      setDetailPlaylist({ playlist: data?.playlist || { id: playlistId, platform, name: '歌单' }, songs })
    } catch {
      setDetailPlaylist(null)
    } finally {
      setDetailPlaylistLoading(false)
    }
  }

  // 处理歌曲选择
  const handleSongSelect = async (song: Song, playlistFromSource?: Song[], origin?: PlaybackOrigin) => {
    // Keep the source view painted while the first-use playback chunks are prepared. Without
    // this, the app-level Suspense boundary can reveal the fixed black base on the first song.
    const playbackSurfaceReady = Promise.allSettled([
      loadPlaybackRadialMenu(),
      loadImmersiveControls(),
      loadTranslationDisplay(),
      loadModernAudioVisualizer(),
        lyricDisplayMode === 'wallpaper'
          ? loadWallpaperLyrics()
          : lyricDisplayMode === 'glorious'
            ? loadGloriousLyrics()
            : lyricDisplayMode === 'multidimensional'
              ? loadMultidimensionalLyrics()
              : lyricDisplayMode === 'modeng'
                ? loadModengPlayer()
                : lyricDisplayMode === 'video'
                  ? loadBilibiliMvPlayer()
                  : Promise.resolve(),
    ])
    const inferredOrigin: PlaybackOrigin = origin
      ? { ...origin, mode: origin.mode || viewMode }
      : showAlbumDetail && selectedAlbumId
        ? { mode: viewMode, surface: 'album', albumId: selectedAlbumId, platform: selectedAlbumPlatform }
        : showArtistDetail && selectedArtistId
          ? {
              mode: viewMode,
              surface: selectedArtistAlbumId ? 'artist-album' : 'artist',
              artistId: selectedArtistId,
              albumId: selectedArtistAlbumId,
              artistTab: selectedArtistTab,
              platform: selectedArtistPlatform,
            }
          : showSearch
            ? { mode: viewMode, surface: 'search' }
            : { mode: viewMode, surface: viewMode === 'minimal' ? 'home' : 'mode-root' }

    playbackOriginRef.current = inferredOrigin
    setRestorePlaybackOrigin(null)
    const normalizedSong = normalizeSongCover(song)
    const normalizedPlaylist = playlistFromSource?.map(normalizeSongCover)
    const nextPlaylist = normalizedPlaylist && normalizedPlaylist.length > 0
      ? normalizedPlaylist
      : playlist.some(item => getSongKey(item) === getSongKey(normalizedSong))
        ? playlist
        : [...playlist, normalizedSong]
    const selectedIndex = Math.max(0, nextPlaylist.findIndex(item => getSongKey(item) === getSongKey(normalizedSong)))

    audioPlayer.cancelTransition('explicit song selection', false)
    bumpQueueRevision()
    currentIndexRef.current = selectedIndex
    setPlaylist(nextPlaylist)
    setCurrentIndex(selectedIndex)

    setEnteredFromMode(inferredOrigin.mode || viewMode)
    if (viewMode !== 'minimal') {
      setViewMode('minimal')
      localStorage.setItem('viewMode', 'minimal')
    }
    setShowProfile(false)
    setShowSearch(false)
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    await playbackSurfaceReady
    setShowHome(false)
    await loadAndPlaySong(nextPlaylist[selectedIndex] || normalizedSong, selectedIndex, nextPlaylist)
  }

  // 打开艺人详情
  const handleOpenArtist = (artistId: string, platform: MusicPlatform) => {
    // 先关闭弹窗（不触发导航栈弹出）
    const hadAlbum = showAlbumDetail && selectedAlbumId
    const hadArtist = showArtistDetail && selectedArtistId
    const prevArtist = hadArtist ? { type: 'artist' as const, id: selectedArtistId, platform: selectedArtistPlatform, tab: selectedArtistTab } : null
    const prevAlbum = hadAlbum ? { type: 'album' as const, id: selectedAlbumId, platform: selectedAlbumPlatform } : null
    // 临时阻止 closeAlbumDetail/closeCommentModal 弹出导航栈
    const savedStack = navigationStack.current
    navigationStack.current = [] as any
    closeAlbumDetail()
    closeCommentModal()
    navigationStack.current = savedStack
    // 压入导航栈
    if (prevAlbum) pushNavigation(prevAlbum)
    if (prevArtist) pushNavigation(prevArtist)
    setSelectedArtistId(artistId)
    setSelectedArtistPlatform(platform)
    setSelectedArtistAlbumId(undefined)
    setSelectedArtistTab('hotSongs')
    setShowArtistDetail(true)
  }

  // 打开专辑详情
  const handleOpenAlbum = (albumId: string, platform: MusicPlatform) => {
    const hadAlbum = showAlbumDetail && selectedAlbumId
    const hadArtist = showArtistDetail && selectedArtistId
    const prevArtist = hadArtist ? { type: 'artist' as const, id: selectedArtistId, platform: selectedArtistPlatform, tab: selectedArtistTab } : null
    const prevAlbum = hadAlbum ? { type: 'album' as const, id: selectedAlbumId, platform: selectedAlbumPlatform } : null
    // 临时阻止 closeArtistDetail/closeCommentModal 弹出导航栈
    const savedStack = navigationStack.current
    navigationStack.current = [] as any
    closeArtistDetail()
    closeCommentModal()
    navigationStack.current = savedStack
    // 压入导航栈
    if (prevArtist) pushNavigation(prevArtist)
    if (prevAlbum) pushNavigation(prevAlbum)
    setSelectedAlbumId(albumId)
    setSelectedAlbumPlatform(platform)
    setShowAlbumDetail(true)
  }

  const handlePlayerHome = () => {
    const origin = playbackOriginRef.current
    const targetMode = origin.mode || enteredFromMode || 'minimal'

    setViewMode(targetMode)
    localStorage.setItem('viewMode', targetMode)
    setEnteredFromMode(targetMode)
    setShowHome(true)
    setShowSearch(origin.surface.startsWith('search'))
    setShowProfile(false)
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    // 回到来源页：弹窗全部关闭，导航栈一并清空，避免残留脏条目
    navigationStack.current = []

    if ((origin.surface === 'artist' || origin.surface === 'artist-album') && origin.artistId && origin.platform && origin.platform !== 'apple') {
      setSelectedArtistId(String(origin.artistId))
      setSelectedArtistPlatform(origin.platform)
      setSelectedArtistAlbumId(origin.albumId)
      setSelectedArtistTab(origin.artistTab || (origin.albumId ? 'albums' : 'hotSongs'))
      setShowArtistDetail(true)
    } else if (origin.surface === 'album' && origin.albumId && origin.platform && origin.platform !== 'apple') {
      setSelectedAlbumId(String(origin.albumId))
      setSelectedAlbumPlatform(origin.platform)
      setShowAlbumDetail(true)
    }

    const revision = ++restorePlaybackRevisionRef.current
    setRestorePlaybackOrigin({ ...origin, mode: targetMode, revision })
  }

  // 下一首播放
  const handlePlayNext = (song: Song) => {
    audioPlayer.cancelTransition('play-next queue changed', false)
    bumpQueueRevision()
    setPlaylist(prev => {
      // 如果是当前播放的歌曲
      if (prev.length === 0) {
        // 添加到播放列表并播放
        currentIndexRef.current = 0
        setCurrentIndex(0)
        return [song]
      }
      
      // 如果是收藏的歌曲
      if (currentIndex >= 0) {
        const newPlaylist = [...prev]
        newPlaylist.splice(currentIndex + 1, 0, song)
        return newPlaylist
      } else {
        // 如果是当前播放的歌曲，但不播放
        currentIndexRef.current = 0
        setCurrentIndex(0)
        return [song, ...prev]
      }
    })
    
    // 显示全局消息提示
    addToast('已添加至下一首播放', 'success')
  }

  // 添加到我喜欢
  const handleAddToFavorites = async (song: Song) => {
    try {
      const platform = (song.platform || 'netease') as MusicPlatform
      // Apple：收藏 = 加入音乐库（amp-api）
      if (platform === 'apple') {
        if (!appleLoggedIn) {
          addToast('请先登录 Apple Music', 'error')
          return
        }
        const appleSongId = song.appleId || String(song.id)
        const ok = await addAppleSongToLibrary(appleSongId)
        if (ok) {
          addToast('已收藏到 Apple 音乐库', 'success')
          applyFavoriteMutation({ platform: 'apple', type: 'like', songId: appleSongId })
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'like', songId: appleSongId }
          }))
        } else {
          addToast('收藏失败，请检查登录状态', 'error')
        }
        return
      }
      const userId = platform === 'netease' ? neteaseUserId : qqUserId
      
      if (!userId) {
        addToast(`请先登录${platform === 'netease' ? '网易云音乐' : 'QQ音乐'}`, 'error')
        return
      }
      
      const mutationSong = platform === 'qq' && (!song.mid || !/^\d+$/.test(String(song.id)))
        ? await loadQQSongDetail(song)
        : song
      if (platform === 'qq' && !mutationSong.mid) {
        addToast('缺少 QQ 音乐歌曲 MID，无法添加到喜欢', 'error')
        return
      }

      const result = await likeSong(mutationSong.id.toString(), userId, platform, true, {
        songMid: mutationSong.mid,
        songType: mutationSong.songType
      })
      
      if (result.code === 200 || result.result === 100) {
        addToast('已添加到我喜欢的歌单', 'success')
        const coverImgUrl = mutationSong.album?.picUrl || ''
        const changed = !result.unchanged
        if (changed) {
          updateCachedUserPlaylists(platform, userId, playlists => playlists.map(item => (
            item.isLike
              ? {
                  ...item,
                  coverImgUrl: coverImgUrl || item.coverImgUrl,
                  trackCount: Number(item.trackCount || 0) + 1
                }
              : item
          )))
        }
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: {
            platform,
            type: 'like',
            songId: mutationSong.id,
            songMid: mutationSong.mid,
            coverImgUrl,
            trackCountDelta: changed ? 1 : 0
          }
        }))
      } else {
        addToast(result.error || result.message || '添加到喜欢失败', 'error')
      }
    } catch (error) {
      console.error('添加到喜欢时出错:', error)
      addToast(error instanceof Error ? error.message : '添加到喜欢失败', 'error')
    }
  }

  // 添加到歌单
  const handleAddToPlaylist = async (song: Song, playlistId: string) => {
    try {
      const platform = (song.platform || 'netease') as MusicPlatform
      // Apple：加入资料库歌单（amp-api）
      if (platform === 'apple') {
        if (!appleLoggedIn) {
          addToast('请先登录 Apple Music', 'error')
          return
        }
        const appleSongId = song.appleId || String(song.id)
        const ok = await addAppleTracksToPlaylist(playlistId, [appleSongId])
        if (ok) {
          addToast('已添加到 Apple 歌单', 'success')
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'add', songId: appleSongId, playlistId }
          }))
        } else {
          addToast('添加到 Apple 歌单失败，请检查登录状态', 'error')
        }
        return
      }
      const userId = platform === 'netease' ? neteaseUserId : qqUserId
      
      if (!userId) {
        addToast(`请先登录${platform === 'netease' ? '网易云音乐' : 'QQ音乐'}`, 'error')
        return
      }
      
      const mutationSong = platform === 'qq' && !song.mid ? await loadQQSongDetail(song) : song
      const trackIdentifier = mutationSong.id != null ? String(mutationSong.id) : ''
      if (!trackIdentifier) {
        addToast('缺少 QQ 音乐歌曲 MID，无法添加到歌单', 'error')
        return
      }
      const result = await addSongToPlaylist(playlistId, trackIdentifier, userId, platform, {
        songMid: mutationSong.mid,
        songType: mutationSong.songType,
      })
      
      if (result.code === 200 || result.result === 0 || result.result === 100) {
        addToast('已添加到歌单', 'success')
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: { platform, type: 'add', playlistId, songId: mutationSong.id }
        }))
      } else {
        addToast(result.error || '添加到歌单失败', 'error')
      }
    } catch (error) {
      console.error('添加到歌单失败:', error)
      addToast(error instanceof Error ? error.message : '添加到歌单失败', 'error')
    }
  }

  // 查看评论页面
  const handleViewComments = (song: Song) => {
    dismissArtistDetail()
    dismissAlbumDetail()
    setSelectedCommentSong(song)
    setShowCommentModal(true)
  }

  // 复制歌曲信息
  const handleCopyInfo = (song: Song) => {
    const artistNames = song.artists?.map((a: any) => a.name).join('、') || '未知艺人'
    const albumName = song.album?.name || '未知专辑'
    const info = `歌曲名：${song.name}，歌手名：${artistNames}，专辑名：${albumName}`
    try {
      navigator.clipboard.writeText(info).catch(() => {
        // Electron 中 clipboard API 可能被 CSP 限制，回退到 textarea 选择复制
        const textarea = document.createElement('textarea')
        textarea.value = info
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      })
    } catch {
      // 兜底：直接 execCommand
      const textarea = document.createElement('textarea')
      textarea.value = info
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    addToast('歌曲信息已复制到剪贴板', 'success')
  }

  // 预加载接下来的歌曲（URL + 歌词）
  const preloadUpcomingSongs = useCallback((currentIdx: number, revisionOverride = queueRevisionRef.current, modeOverride = playMode, playlistOverride?: Song[]) => {
    const actualPlaylist = playlistOverride || playlist
    debugLog('🔄 [Preload] preloadUpcomingSongs 被调用')
    debugLog('   当前索引:', currentIdx)
    debugLog('   播放列表长度:', actualPlaylist.length)
    debugLog('   播放模式:', modeOverride)
    debugLog('   使用覆盖播放列表:', !!playlistOverride)
    debugLog('   无缝衔接设置:', { crossfade: crossfadeEnabled, gapless: gaplessEnabled, autoMix: autoMixEnabled })
    
    if (actualPlaylist.length <= 1) {
      debugLog('⚠️ [Preload] 播放列表太短，跳过预加载')
      return
    }
    const requestRevision = revisionOverride
    const audioUrlGeneration = audioUrlCacheGenerationRef.current
    // 计算接下来的 2 首歌曲索引
    const upcomingIndices = getUpcomingIndices(
      actualPlaylist.map(getSongKey),
      currentIdx,
      modeOverride,
      revisionOverride,
      2
    )
    debugLog('📋 [Preload] 接下来的歌曲索引:', upcomingIndices)
    
    // 异步预加载每首歌
    upcomingIndices.forEach((idx, position) => {
      const song = actualPlaylist[idx]
      if (!song) return
      
      const platform = song.platform || 'netease'
      const cacheKey = getSongKey(song)
      
      debugLog(`🎵 [Preload] 第 ${position + 1} 首歌曲: ${song.name}`)
      debugLog(`   索引: ${idx}, 缓存键: ${cacheKey}`)

      // 歌词不再等待音频 URL，立即开始并复用进行中的请求。
      void ensureSongLyrics(song, cacheKey)
      
      // Apple：队列条目为 Apple 曲目，音频 URL 必须取自解析后的载体歌曲（网易云/QQ）。
      // 解析仅用于取 URL，缓存键仍是 Apple 歌曲本身，loadAndPlaySong 命中缓存即用有效 URL。
      const audioSource = platform === 'apple'
        ? resolvePlayableSong(song).then(resolved => resolved
            ? { songId: resolved.platform === 'qq' ? resolved.mid || resolved.id : resolved.id, platform: resolved.platform || 'netease' }
            : null)
        : Promise.resolve({ songId: platform === 'qq' ? (song.mid || song.id) : song.id, platform })
      
      // 检查缓存是否已存在且未过期（5分钟内有效）
      const cached = preloadCacheRef.current.get(cacheKey)
      const now = Date.now()
      if (cached && cached.url && (now - (cached.urlTimestamp ?? cached.timestamp)) < 5 * 60 * 1000) {
        debugLog(`✅ [Preload] 使用缓存的 URL: ${cached.url.substring(0, 50)}...`)
        // 只预加载第一首歌到音频元素，其他歌曲只缓存
        if (requestRevision === queueRevisionRef.current && position === 0 && (crossfadeEnabled || gaplessEnabled || autoMixEnabled)) {
          debugLog(`📥 [Preload] 调用 audioPlayer.preloadNext (从缓存)`)
          debugLog(`   Position: ${position}`)
          audioPlayer.preloadNext({
            url: cached.url,
            trackKey: cacheKey,
            index: idx,
            duration: song.duration / 1000,
            albumId: getLocalAlbumIdentifier(song, platform) || undefined,
            albumCover: song.album?.picUrl || undefined,
          })
        }
        return
      }
      
      void audioSource.then(source => {
        if (!source) return
        const resolvedSongId = source.songId
        const resolvedPlatform = source.platform
        debugLog(`⏳ [Preload] URL 缓存未命中，开始获取音频地址...`)
        getSongUrl(resolvedSongId, resolvedPlatform).catch(() => null).then(url => {
          if (audioUrlGeneration !== audioUrlCacheGenerationRef.current) return
          if (url && url !== 'SONG_UNAVAILABLE') {
            const latest = preloadCacheRef.current.get(cacheKey)
            preloadCacheRef.current.set(cacheKey, {
              url,
              lyrics: latest?.lyrics || [],
              timestamp: Date.now(),
              urlTimestamp: Date.now(),
              lyricsTimestamp: latest?.lyricsTimestamp,
              lyricsLoaded: latest?.lyricsLoaded,
              lyricsPromise: latest?.lyricsPromise,
            })
            debugLog(`  ✅ 第 ${position + 1} 首歌曲: ${song.name} (${latest?.lyrics.length || 0}行歌词已就绪)`)
            
            // 只预加载第一首歌到音频元素，其他歌曲只缓存
            if (requestRevision === queueRevisionRef.current && position === 0 && (crossfadeEnabled || gaplessEnabled || autoMixEnabled)) {
              debugLog(`📥 [Preload] 调用 audioPlayer.preloadNext (新获取)`)
              debugLog(`   Position: ${position}, URL: ${url.substring(0, 80)}...`)
              audioPlayer.preloadNext({
                url,
                trackKey: cacheKey,
                index: idx,
                duration: song.duration / 1000,
                albumId: getLocalAlbumIdentifier(song, platform) || undefined,
                albumCover: song.album?.picUrl || undefined,
              })
            }
          } else {
            debugLog(`❌ [Preload] 第 ${position + 1} 首歌曲 URL 获取失败，可能是VIP歌曲`)
          }
        }).catch(err => {
          console.error(`  ❌ 第 ${position + 1} 首歌曲失败: ${song.name}`, err)
        })
      })
    })
  }, [playlist, playMode, queueRevision, crossfadeEnabled, gaplessEnabled, autoMixEnabled, audioPlayer.preloadNext, ensureSongLyrics])

  useEffect(() => {
    const continuation = infiniteExploreContinuationRef.current
    if (playbackOriginRef.current.continuation !== 'explore-infinite') {
      continuation.loading = false
      continuation.lastQueueLength = 0
      continuation.batch = 1
      continuation.advancePending = false
      return
    }

    if (playlist.length === 0 || currentIndex < 0 || playlist.length - currentIndex > 6) return
    if (continuation.loading || continuation.lastQueueLength === playlist.length) return

    continuation.loading = true
    continuation.lastQueueLength = playlist.length
    const requestedBatch = continuation.batch
    continuation.batch += 1

    const excludedSongKeys = playlistRef.current.map(song => String(song.mid || song.id || '')).filter(Boolean)
    const continuationPlatform = playbackOriginRef.current.platform || playlist[0]?.platform || 'netease'
    void fetchExploreRecommendationBatch(continuationPlatform, requestedBatch, excludedSongKeys)
      .then(songs => {
        if (playbackOriginRef.current.continuation !== 'explore-infinite') return
        const currentQueue = playlistRef.current
        const seen = new Set(currentQueue.map(getSongKey))
        const additions = songs
          .map(normalizeSongCover)
          .filter(song => {
            const key = getSongKey(song)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        if (additions.length === 0) {
          continuation.lastQueueLength = 0
          window.setTimeout(() => setContinuationRetry(value => value + 1), 800)
          return
        }

        const shouldAdvance = continuation.advancePending && currentIndexRef.current >= currentQueue.length - 1
        continuation.advancePending = false
        // 无限推荐队列裁剪：只保留当前曲之前 100 首 + 当前曲 + 新增曲目，
        // 防止长时间连续收听时队列与 playlistKeys 字符串无限膨胀（内存 + O(n) 叠加）。
        const keepBefore = 100
        const trimmedPrefix = Math.max(0, currentIndexRef.current - keepBefore)
        const trimmedQueue = trimmedPrefix > 0 ? currentQueue.slice(trimmedPrefix) : currentQueue
        const nextQueue = [...trimmedQueue, ...additions]
        playlistRef.current = nextQueue
        const nextRevision = bumpQueueRevision()
        const currentIndexInNewQueue = currentIndexRef.current - trimmedPrefix
        // 队列裁剪后旧索引越界：若只 setPlaylist 而把 currentIndex 推迟到 setTimeout，
        // 中间帧 currentIndex >= playlist.length → currentSong=null → 播放页闪回首页。
        // 必须与 setPlaylist 同步提交 currentIndex（同一批次），避免越界空白帧。
        currentIndexRef.current = currentIndexInNewQueue
        setPlaylist(nextQueue)
        setCurrentIndex(currentIndexInNewQueue)
        window.setTimeout(() => {
          preloadUpcomingSongs(currentIndexInNewQueue, nextRevision, playMode, nextQueue)
          if (shouldAdvance) {
            const nextIndex = trimmedQueue.length
            currentIndexRef.current = nextIndex
            setCurrentIndex(nextIndex)
            void loadAndPlaySong(nextQueue[nextIndex], nextIndex, nextQueue)
          }
        }, 0)
      })
      .catch(error => {
        continuation.lastQueueLength = 0
        window.setTimeout(() => setContinuationRetry(value => value + 1), 1200)
        console.warn(`[${continuationPlatform === 'qq' ? 'QQ猜你喜欢' : '网易云无限推荐'}] 下一批加载失败:`, error)
      })
      .finally(() => {
        continuation.loading = false
      })
  }, [currentIndex, playlist.length, playMode, continuationRetry, bumpQueueRevision, preloadUpcomingSongs])

  const handleSmartReorder = async () => {
    const fixedPrefixLength = currentIndex >= 0 ? currentIndex + 1 : 0
    const candidates = playlist.slice(fixedPrefixLength)
    if (candidates.length < 2 || isSmartReordering) return

    const runId = smartReorderRunRef.current + 1
    smartReorderRunRef.current = runId
    smartReorderAbortRef.current?.abort()
    const controller = new AbortController()
    smartReorderAbortRef.current = controller
    const startingQueueRevision = queueRevisionRef.current
    const anchorSong = currentIndex >= 0 ? playlist[currentIndex] : undefined
    const total = candidates.length + (anchorSong ? 1 : 0)
    let completed = 0

    setIsSmartReordering(true)
    setSmartReorderProgress({ completed: 0, total })

    const updateProgress = () => {
      completed += 1
      if (smartReorderRunRef.current === runId) {
        setSmartReorderProgress({ completed, total })
      }
    }

    const analyzeSongForSequencing = async (song: Song) => {
      const platform = song.platform || 'netease'
      const trackKey = getSongKey(song)
      // Apple：队列条目需先解析载体歌曲取真实音频 URL，避免用 Apple ID 打网易云接口
      const playable = platform === 'apple' ? await resolvePlayableSong(song) : song
      if (!playable) return null
      const resolvedPlatform = playable.platform || 'netease'
      const cached = preloadCacheRef.current.get(trackKey)
      const cachedUrlIsFresh = Boolean(
        cached?.url
        && Date.now() - (cached.urlTimestamp ?? cached.timestamp) < 5 * 60 * 1000
      )
      const songId = resolvedPlatform === 'qq' ? (playable.mid || playable.id) : playable.id
      const audioUrlGeneration = audioUrlCacheGenerationRef.current
      const url = cachedUrlIsFresh ? cached!.url : await getSongUrl(songId, resolvedPlatform)
      if (!url || url === 'SONG_UNAVAILABLE') return null

      if (!cachedUrlIsFresh && audioUrlGeneration === audioUrlCacheGenerationRef.current) {
        const latest = preloadCacheRef.current.get(trackKey)
        preloadCacheRef.current.set(trackKey, {
          url,
          lyrics: latest?.lyrics || [],
          timestamp: Date.now(),
          urlTimestamp: Date.now(),
          lyricsTimestamp: latest?.lyricsTimestamp,
          lyricsLoaded: latest?.lyricsLoaded,
          lyricsPromise: latest?.lyricsPromise,
        })
      }

      const analysis = await autoMixAnalysisService.analyze({
        trackKey,
        url,
        duration: song.duration / 1000,
        signal: controller.signal,
      })
      return analysis.beatFeatures.length ? analysis : null
    }

    try {
      let anchorAnalysis: TrackAnalysis | null = null
      if (anchorSong) {
        try {
          anchorAnalysis = await analyzeSongForSequencing(anchorSong)
        } catch (error) {
          if (controller.signal.aborted) throw error
          console.warn('[PlaylistSequencing] 当前歌曲分析失败，将不使用锚点', error)
        } finally {
          updateProgress()
        }
      }

      const analyzed: Array<SequencingEntry<{ song: Song; position: number }>> = []
      let cursor = 0
      const workerCount = Math.min(2, candidates.length)
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (!controller.signal.aborted) {
          const position = cursor
          cursor += 1
          if (position >= candidates.length) return
          const song = candidates[position]
          try {
            const analysis = await analyzeSongForSequencing(song)
            if (analysis) analyzed.push({ item: { song, position }, analysis })
          } catch (error) {
            if (controller.signal.aborted) throw error
            console.warn(`[PlaylistSequencing] 无法分析 ${song.name}`, error)
          } finally {
            updateProgress()
          }
        }
      }))

      if (
        controller.signal.aborted
        || smartReorderRunRef.current !== runId
        || queueRevisionRef.current !== startingQueueRevision
      ) {
        return
      }
      if (analyzed.length < 2) {
        addToast('可分析的后续歌曲不足，无法进行智能重排', 'error')
        return
      }

      analyzed.sort((left, right) => left.item.position - right.item.position)
      const result = sequenceTracksHam2(analyzed, anchorAnalysis || undefined)
      const analyzedPositions = new Set(analyzed.map(entry => entry.item.position))
      const unavailable = candidates.filter((_, position) => !analyzedPositions.has(position))
      const reorderedCandidates = [
        ...result.items.map(item => item.song),
        ...unavailable,
      ]
      const nextPlaylist = [
        ...playlist.slice(0, fixedPrefixLength),
        ...reorderedCandidates,
      ]

      audioPlayer.cancelTransition('playlist reordered', false)
      audioPlayer.resetGaplessIntegration()
      const nextRevision = bumpQueueRevision()
      setPlaylist(nextPlaylist)
      if (playMode !== 'sequential') setPlayMode('sequential')
      if (currentIndex >= 0) {
        window.setTimeout(() => preloadUpcomingSongs(currentIndex, nextRevision, 'sequential', nextPlaylist), 0)
      }

      const reduction = result.originalCost > 1e-6
        ? Math.max(0, Math.round((1 - result.reorderedCost / result.originalCost) * 100))
        : 0
      addToast(
        reduction > 0
          ? `已按 HAM-2 重排 ${analyzed.length} 首后续歌曲，相邻差异降低约 ${reduction}%`
          : `已按 HAM-2 重排 ${analyzed.length} 首后续歌曲`,
        'success',
        dominantColor || '#ef4444',
      )
    } catch (error) {
      if (!controller.signal.aborted) {
        console.error('[PlaylistSequencing] 智能重排失败', error)
        addToast('智能重排失败，请稍后重试', 'error')
      }
    } finally {
      if (smartReorderRunRef.current === runId) {
        setIsSmartReordering(false)
        smartReorderAbortRef.current = null
      }
    }
  }


  // PlaybackEngine atomic commit: update React/UI only; never reload the deck already producing audio.
  const commitPreparedSong = useCallback((commit: TransitionCommit) => {
    if (commit.sourceTrackKey && activeTrackKeyRef.current && commit.sourceTrackKey !== activeTrackKeyRef.current) return
    // Transition artwork already crossfades through transitionFromTrack/
    // transitionToTrack. A visual-only notification must not mutate the
    // canonical song, clock, queue revision or lyric ownership before the
    // target deck actually becomes active.
    if (commit.isVisualSwitch) return
    // Smart reorder can change queue positions after the next deck was prepared. Only trust
    // the prepared index when it still points at the committed track; otherwise resolve the
    // target by its stable track key in the latest queue.
    const preparedIndex = commit.targetIndex
    const preparedSong = preparedIndex !== undefined ? playlist[preparedIndex] : undefined
    const targetIndex = preparedSong && getSongKey(preparedSong) === commit.targetTrackKey
      ? preparedIndex!
      : playlist.findIndex(song => getSongKey(song) === commit.targetTrackKey)
    const song = targetIndex >= 0 ? playlist[targetIndex] : undefined
    if (!song) return
    const nextRevision = bumpQueueRevision()

    const normalizedSong = normalizeSongCover(song)
    const cacheKey = getSongKey(normalizedSong)
    
    activeTrackKeyRef.current = cacheKey
    currentIndexRef.current = targetIndex
    setCurrentIndex(targetIndex)
    setCurrentTrack(createTrackFromSong(normalizedSong))
    // Apple Music：切歌即清封面，后台匹配命中后替换为高清封面（与 loadAndPlaySong 一致——
    // 漏清会导致 appleCoverUrl 残留旧歌封面，自动切歌后 displayCoverUrl 恒为旧图）
    setAppleCoverUrl(null)
    resolveAppleCover(normalizedSong)
    setCurrentTime(commit.targetTime)
    setDuration(normalizedSong.duration / 1000)
    setCurrentTranslation('')

    const cached = preloadCacheRef.current.get(cacheKey)
    if (cached && cached.lyrics.length > 0) {
      setLyrics(cached.lyrics)
      setIsPureMusic(cached.lyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐')))
    } else {
      setLyrics([])
      setIsPureMusic(false)
    }
    void ensureSongLyrics(normalizedSong, cacheKey)

    window.setTimeout(() => {
      preloadUpcomingSongs(targetIndex, nextRevision)
    }, 0)
  }, [bumpQueueRevision, playlist, preloadUpcomingSongs, ensureSongLyrics, resolveAppleCover])

  useEffect(() => {
    transitionCommitRef.current = commitPreparedSong
    return () => {
      if (transitionCommitRef.current === commitPreparedSong) transitionCommitRef.current = () => undefined
    }
  }, [commitPreparedSong])
  // 加载并播放歌曲
  const loadAndPlaySong = async (song: Song, songIndex?: number, playlistOverride?: Song[]) => {
    const loadRevision = ++songLoadRevisionRef.current
    const isLatestLoad = () => loadRevision === songLoadRevisionRef.current
    const actualPlaylist = playlistOverride || playlist
    debugLog('🎵 [PlaySong] loadAndPlaySong 被调用')
    debugLog('   歌曲:', song.name)
    debugLog('   索引:', songIndex)
    debugLog('   播放列表长度:', actualPlaylist.length)
    debugLog('   使用覆盖播放列表:', !!playlistOverride)
    try {
      // 开始获取用户信息，检查登录状态并处理Cookie
      const currentAudio = audioPlayer.audioElement
      if (currentAudio && !currentAudio.paused) {
        currentAudio.pause()
        currentAudio.currentTime = 0
      }
      setIsPlaying(false)
      
      let normalizedSong = normalizeSongCover(song)
      // 需要跨平台载体转换的平台：apple（始终）、spotify/kugou/soda（未登录时无自源音源）
      const needsCarrier = normalizedSong.platform === 'apple'
        || (normalizedSong.platform === 'spotify' && !localStorage.getItem('spotify_access_token'))
        || (normalizedSong.platform === 'kugou' && !localStorage.getItem('kugou_cookie'))
        || (normalizedSong.platform === 'soda' && !localStorage.getItem('soda_token'))
      let audioSong: Song = normalizedSong
      if (needsCarrier) {
        const resolved = await resolvePlayableSong(normalizedSong)
        if (!resolved) {
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '该歌曲在网易云/QQ 未找到可播放版本', type: 'error' } }))
          const failedLoadRevision = loadRevision
          setTimeout(() => {
            if (failedLoadRevision !== songLoadRevisionRef.current) return
            handleNext()
          }, 2000)
          return
        }
        audioSong = resolved
      }
      if ((normalizedSong.platform || 'netease') === 'qq' && !normalizedSong.album?.picUrl) {
        normalizedSong = await loadQQSongDetail(normalizedSong)
        if (!isLatestLoad()) return
        setPlaylist(prev => prev.map(item => getSongKey(item) === getSongKey(normalizedSong) ? normalizedSong : item))
      }
      // 清空当前翻译（切歌时）
      setCurrentTranslation('')
      
      const platform = audioSong.platform || 'netease'
      const songId = platform === 'qq' ? (audioSong.mid || audioSong.id) : audioSong.id
      debugLog(`  歌手: ${normalizedSong.artists.map(a => a.name).join(', ')}`)
      if (platform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie')
        debugLog(`  Cookie状态: ${cookie ? '有效(长度:' + cookie.length + ')' : '无效'}`)
      }
      const coverUrl = normalizedSong.album?.picUrl || ''
      setCurrentTrack(createTrackFromSong(normalizedSong))
      setCurrentTime(0)
      // Apple Music：切歌即清封面，后台匹配命中后替换为高清封面
      setAppleCoverUrl(null)
      resolveAppleCover(normalizedSong)
      
      // 如果有艺人ID，获取艺人详情
      const cacheKey = getSongKey(normalizedSong)
      activeTrackKeyRef.current = cacheKey
      const cached = preloadCacheRef.current.get(cacheKey)
      const now = Date.now()
      const lyricsPromise = ensureSongLyrics(normalizedSong, cacheKey)
      
      let url: string | null = null
      let songLyrics: LyricLine[] = cached?.lyrics || []
      
      // 音频 URL 与歌词分别判断时效，歌词请求不再等播放器完成加载后才开始。
      if (cached?.url && (now - (cached.urlTimestamp ?? cached.timestamp)) < 5 * 60 * 1000) {
        url = cached.url
        debugLog('🎵 歌词: 缓存命中 (' + songLyrics.length + '行)')
      } else {
        url = await getSongUrl(songId, platform)
        if (!isLatestLoad()) return
        if (url && url !== 'SONG_UNAVAILABLE') {
          const latest = preloadCacheRef.current.get(cacheKey)
          preloadCacheRef.current.set(cacheKey, {
            url,
            lyrics: latest?.lyrics || songLyrics,
            timestamp: Date.now(),
            urlTimestamp: Date.now(),
            lyricsTimestamp: latest?.lyricsTimestamp,
            lyricsLoaded: latest?.lyricsLoaded,
            lyricsPromise: latest?.lyricsPromise,
          })
        }
      }
      
      if (url) {
      }
      
      // 检测歌曲下架
      if (url === 'SONG_UNAVAILABLE') {
        console.error('获取歌曲URL失败，重试3次')
        addToast('获取歌曲信息失败，请稍后重试', 'error')
        // 捕获本次加载的 revision：3 秒后重试前校验用户是否已手动切歌，避免迟到跳歌
        const failedLoadRevision = loadRevision
        setTimeout(() => {
          if (failedLoadRevision !== songLoadRevisionRef.current) return
          handleNext()
        }, 3000)
        return
      }
      
      if (!url) {
        console.error('获取歌曲URL返回空')
        console.error('  可能原因:')
        console.error('  1. VIP歌曲且未登录VIP账号')
        console.error('  2. 版权限制')
        console.error('  3. Cookie过期或无效')
        console.error('  4. API返回错误格式')
        addToast('无法播放该歌曲，可能是VIP歌曲或版权限制', 'error')
        return
      }
      
      // 处理封面图片URL，支持网易云音乐的URL参数
      setCurrentTrack(createTrackFromSong(normalizedSong, url))
      
      // 如果是当前播放的歌曲，确保歌词已加载且不为空
      songLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics || songLyrics
      if (songLyrics.length > 0) {
        setLyrics(songLyrics)
        const checkIsPureMusic = songLyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐'))
        setIsPureMusic(checkIsPureMusic)
      } else {
        setLyrics([]) // 先清空歌词
        setIsPureMusic(false) // 重置纯音乐状态
      }
      
      let started = false
      try {
        started = await audioPlayer.loadAndPlay(url, volume, {
          trackKey: cacheKey,
          index: songIndex,
          duration: normalizedSong.duration / 1000,
          albumId: getLocalAlbumIdentifier(normalizedSong, platform) || undefined,
          albumCover: normalizedSong.album?.picUrl || undefined,
        })
      } catch (firstPlaybackError) {
        if (!isLatestLoad()) return
        // Signed playback URLs can expire or be rejected by the CDN before the
        // five-minute memory entry expires. Evict only this song and retry once.
        invalidateSongUrl(songId, platform)
        const latest = preloadCacheRef.current.get(cacheKey)
        preloadCacheRef.current.set(cacheKey, {
          url: null,
          lyrics: latest?.lyrics || songLyrics,
          timestamp: latest?.timestamp || Date.now(),
          urlTimestamp: 0,
          lyricsTimestamp: latest?.lyricsTimestamp,
          lyricsLoaded: latest?.lyricsLoaded,
          lyricsPromise: latest?.lyricsPromise,
        })
        const refreshedUrl = await getSongUrl(songId, platform)
        if (!refreshedUrl || refreshedUrl === url || !isLatestLoad()) throw firstPlaybackError
        url = refreshedUrl
        const refreshedLatest = preloadCacheRef.current.get(cacheKey)
        preloadCacheRef.current.set(cacheKey, {
          url,
          lyrics: refreshedLatest?.lyrics || songLyrics,
          timestamp: Date.now(),
          urlTimestamp: Date.now(),
          lyricsTimestamp: refreshedLatest?.lyricsTimestamp,
          lyricsLoaded: refreshedLatest?.lyricsLoaded,
          lyricsPromise: refreshedLatest?.lyricsPromise,
        })
        setCurrentTrack(createTrackFromSong(normalizedSong, url))
        started = await audioPlayer.loadAndPlay(url, volume, {
          trackKey: cacheKey,
          index: songIndex,
          duration: normalizedSong.duration / 1000,
          albumId: getLocalAlbumIdentifier(normalizedSong, platform) || undefined,
          albumCover: normalizedSong.album?.picUrl || undefined,
        })
      }
      if (!started || !isLatestLoad()) return
      
      // 响度归一化：按曲目测量 LUFS 并施加增益（adapter 内部按 capabilities 判断，v1/v3 no-op）
      engineAdapterRef.current.applyLoudnessNormalization(cacheKey, url)
      
      // 请求可能已经由下一首预载启动；这里仅保持引用，避免重复调用。
      void lyricsPromise
      
      // 用于控制逐字歌词的显示，预留2秒缓冲
      if (actualPlaylist.length > 1) {
        const indexToUse = songIndex !== undefined ? songIndex : currentIndex
        debugLog('📋 [PlaySong] 准备预加载下一首歌曲')
        debugLog('   使用索引:', indexToUse)
        debugLog('   当前索引:', currentIndex)
        debugLog('   实际播放列表长度:', actualPlaylist.length)
        preloadUpcomingSongs(indexToUse, queueRevisionRef.current, playMode, actualPlaylist)
      } else {
        debugLog('⚠️ [PlaySong] 播放列表太短，跳过预加载 (长度:', actualPlaylist.length, ')')
      }
    } catch (error) {
      if (!isLatestLoad()) return
      console.error('加载歌曲失败:', error)
      alert('加载歌曲失败')
    }
  }

  // 上一曲
  const handlePrevious = () => {
    if (playlist.length === 0) return
    audioPlayer.cancelTransition('manual previous', false)
    audioPlayer.resetGaplessIntegration() // 清理预加载的音频
    bumpQueueRevision()
    
    // 如果当前有歌曲正在播放且播放列表不为空
    const newIndex = currentIndex > 0 ? currentIndex - 1 : playlist.length - 1
    if (gaplessEnabled && playlist[newIndex]) {
      setIsTransitioning(true)
      
      // 1.5秒后重置过渡状态（统一跟踪定时器，快速连切时旧定时器先取消）
      clearTransitionResetTimer()
      transitionResetTimerRef.current = window.setTimeout(() => {
        transitionResetTimerRef.current = null
        setIsTransitioning(false)
      }, 1500)
    }
    
    // 如果是第一首歌，循环到最后一首
    setCurrentTime(0)
    setLyrics([])
    setIsPureMusic(false) // 重置纯音乐状态?
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex], newIndex)
  }

  // 下一曲
  const handleNext = () => {
    if (playlist.length === 0) return
    if (
      playbackOriginRef.current.continuation === 'explore-infinite' &&
      playMode === 'sequential' &&
      currentIndex >= playlist.length - 1
    ) {
      // 无限推荐正在续载时停留在当前曲，避免队尾瞬间回绕到第一首。
      infiniteExploreContinuationRef.current.advancePending = true
      infiniteExploreContinuationRef.current.lastQueueLength = 0
      setContinuationRetry(value => value + 1)
      return
    }
    audioPlayer.cancelTransition('manual or automatic next', false)
    audioPlayer.resetGaplessIntegration() // 清理预加载的音频
    bumpQueueRevision()
    
    const newIndex = deterministicNextIndex ?? (currentIndex < playlist.length - 1 ? currentIndex + 1 : 0)
    
    // 如果当前有歌曲正在播放且播放列表不为空
    if (gaplessEnabled && playlist[newIndex]) {
      setIsTransitioning(true)
      
      // 1.5秒后重置过渡状态（统一跟踪定时器，快速连切时旧定时器先取消）
      clearTransitionResetTimer()
      transitionResetTimerRef.current = window.setTimeout(() => {
        transitionResetTimerRef.current = null
        setIsTransitioning(false)
      }, 1500)
    }
    
    // 清空当前时间和歌词
    setCurrentTime(0)
    setLyrics([])
    setIsPureMusic(false) // 重置纯音乐状态
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex], newIndex)
  }
  handleNextRef.current = handleNext
  
  // 获取下一首歌曲（不播放，仅用于显示）
  const nextSongToShow = useMemo((): Song | undefined => {
    if (deterministicNextIndex === undefined) return undefined
    return playlist[deterministicNextIndex]
  }, [playlist, deterministicNextIndex])

  const handlePlayModeChange = () => {
    const now = Date.now()
    if (now - lastPlayModeChangeRef.current < 300) return
    lastPlayModeChangeRef.current = now

    const modes: Array<'sequential' | 'shuffle' | 'repeat'> = ['sequential', 'shuffle', 'repeat']
    const newMode = modes[(modes.indexOf(playMode) + 1) % modes.length]
    audioPlayer.cancelTransition('play mode changed', false)
    const nextRevision = bumpQueueRevision()
    setPlayMode(newMode)
    window.setTimeout(() => preloadUpcomingSongs(currentIndexRef.current, nextRevision, newMode), 0)

    const modeNames = {
      sequential: '顺序播放',
      shuffle: '随机播放',
      repeat: '单曲循环',
    }
    const existingId = playModeToastIdRef.current
    if (existingId === null) {
      const id = toastIdRef.current++
      playModeToastIdRef.current = id
      setToasts(prev => [...prev, {
        id,
        message: modeNames[newMode],
        type: 'info',
        accentColor: dominantColor || '#ef4444',
      }])
    } else {
      setToasts(prev => {
        const nextToast = {
          id: existingId,
          message: modeNames[newMode],
          type: 'info' as const,
          accentColor: dominantColor || '#ef4444',
        }
        return prev.some(toast => toast.id === existingId)
          ? prev.map(toast => toast.id === existingId ? nextToast : toast)
          : [...prev, nextToast]
      })
    }

    if (playModeToastTimerRef.current !== null) window.clearTimeout(playModeToastTimerRef.current)
    playModeToastTimerRef.current = window.setTimeout(() => {
      const id = playModeToastIdRef.current
      if (id !== null) setToasts(prev => prev.filter(toast => toast.id !== id))
      playModeToastIdRef.current = null
      playModeToastTimerRef.current = null
    }, 4000)
  }

  // 看歌模式协调：视频播放时暂停音频引擎（视频为唯一时间线），视频让位/切走时恢复
  const watchPlayerRef = useRef<{ togglePlay: () => boolean } | null>(null)
  const [watchVideoActive, setWatchVideoActive] = useState(false)
  /** 切到看歌时的音频续播位置（秒） */
  const [watchSyncSeek, setWatchSyncSeek] = useState(0)
  const watchPausedEngineRef = useRef(false)

  const handlePlayPause = useCallback(() => {
    // 看歌模式：有活动视频时由视频接管播放/暂停（引擎保持暂停，避免双声）
    if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
      const handled = watchPlayerRef.current.togglePlay()
      if (handled) return
    }
    audioPlayerRef.current.togglePlay()
  }, [lyricDisplayMode])

  useEffect(() => {
    if (lyricDisplayMode !== 'video') {
      // 切出看歌模式：若引擎是因视频而暂停，恢复出声
      if (watchPausedEngineRef.current && !isPlaying) {
        watchPausedEngineRef.current = false
        audioPlayerRef.current.togglePlay()
      }
      return
    }
    if (watchVideoActive) {
      if (isPlaying) {
        watchPausedEngineRef.current = true
        audioPlayerRef.current.togglePlay()
      }
    } else if (watchPausedEngineRef.current && !isPlaying) {
      // 视频让位（搜索/兜底/切歌）→ 恢复音频引擎继续听
      watchPausedEngineRef.current = false
      audioPlayerRef.current.togglePlay()
    }
  }, [lyricDisplayMode, watchVideoActive, isPlaying])

  // ===== 桌面播放器：独立置顶小窗口的状态桥接 =====
  const isPlayingRef = useRef(isPlaying)
  isPlayingRef.current = isPlaying
  const lastMediaControlRef = useRef<{ group: string; time: number } | null>(null)
  // 遥控器音量/静音状态
  const mutedRef = useRef(false)
  const [muted, setMuted] = useState(false)
  const lastVolumeRef = useRef(0.8)
  const volumeRef = useRef(volume)
  volumeRef.current = volume

  const desktopControlHandlerRef = useRef<(action: string, payload?: any) => void>(() => undefined)
  desktopControlHandlerRef.current = (action, payload) => {
    if (action === 'toggle' || action === 'play' || action === 'pause') {
      const audio = audioPlayer.getAudioElement()
      const currentlyPlaying = isPlayingRef.current && !(audio?.paused ?? true)
      if (action === 'play' && !currentlyPlaying) audioPlayer.togglePlay()
      else if (action === 'pause' && currentlyPlaying) audioPlayer.togglePlay()
      else if (action === 'toggle') audioPlayer.togglePlay()
    } else if (action === 'next') {
      handleNext()
    } else if (action === 'prev') {
      handlePrevious()
    } else if (action === 'select-index') {
      const index = Number(payload)
      const target = playlistRef.current[index]
      if (target) void handleSongSelectRef.current(target, playlistRef.current)
    } else if (action === 'seek') {
      audioPlayerRef.current.seek(Number(payload) || 0)
    } else if (action === 'volume') {
      const v = Math.max(0, Math.min(1, Number(payload)))
      audioPlayerRef.current.setVolume(v)
      if (v > 0 && mutedRef.current) { mutedRef.current = false; setMuted(false) }
    } else if (action === 'mute') {
      const next = !mutedRef.current
      mutedRef.current = next
      if (next) {
        lastVolumeRef.current = volumeRef.current > 0 ? volumeRef.current : 0.8
        audioPlayerRef.current.setVolume(0)
      } else {
        audioPlayerRef.current.setVolume(lastVolumeRef.current || 0.8)
      }
      setMuted(next)
    } else if (action === 'home') {
      // 遥控器 Home：回到当前模式主页（不切换模式），并关闭所有弹层
      setShowHome(true)
      setShowSongDetail(false)
      setShowRemote(false)
      setShowMixingStudio(false)
      setShowCommentModal(false)
      setShowArtistDetail(false)
      setShowAlbumDetail(false)
      setShowSettings(false)
      setShowSearch(false)
      setShowProfile(false)
    } else if (action === 'back') {
      if (showSongDetail) setShowSongDetail(false)
      else if (showRemote) setShowRemote(false)
      else if (showMixingStudio) setShowMixingStudio(false)
      else if (showCommentModal) closeCommentModal()
      else if (showArtistDetail) closeArtistDetail()
      else if (showAlbumDetail) closeAlbumDetail()
      else if (showSettings) setShowSettings(false)
      else if (showSearch) setShowSearch(false)
      else { setShowHome(true); setShowProfile(false) }
    } else if (action === 'show-comment' || action === 'show-song' || action === 'show-artist') {
      const current = playlistRef.current[currentIndexRef.current]
      if (!current) return
      const platform = (current as any).platform || 'netease'
      if (action === 'show-comment') {
        handleViewComments(current)
      } else if (action === 'show-artist') {
        const artist = Array.isArray(current.artists) ? current.artists[0] : null
        const artistId = platform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
        if (!artistId) {
          addToast('当前歌曲缺少歌手信息', 'error')
          return
        }
        handleOpenArtist(String(artistId), platform)
      } else if (action === 'show-song') {
        setSongDetailSong(current)
        setShowSongDetail(true)
      }
    } else if (action === 'favorite') {
      const current = playlistRef.current[currentIndexRef.current]
      if (current) handlePlaybackToggleFavorite(current, currentSongLiked)
    } else if (action === 'desktop-lyrics') {
      void window.electron?.desktopLyrics?.setEnabled?.(!desktopLyricsWindowEnabled)
    } else if (action === 'mode-switch') {
      const order = ['explore', 'minimal', 'desktop']
      const idx = order.indexOf(viewMode)
      const next = order[(idx + 1) % order.length]
      window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: next }))
    } else if (action === 'set-mode') {
      const mode = String(payload)
      if (['explore', 'minimal', 'desktop'].includes(mode)) {
        window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode }))
      }
    } else if (action === 'set-lyric-mode') {
      const mode = String(payload) as LyricDisplayMode
      if (ALL_LYRIC_MODES.includes(mode)) handleLyricDisplayModeChange(mode)
    } else if (action === 'stop') {
      // 停止：暂停并回到开头（主流遥控器停止键）
      const audio = audioPlayer.getAudioElement()
      audioPlayerRef.current.seek(0)
      if (isPlayingRef.current && !(audio?.paused ?? true)) audioPlayer.togglePlay()
    } else if (action === 'rewind') {
      const audio = audioPlayer.getAudioElement()
      const t = audio?.currentTime || 0
      audioPlayerRef.current.seek(Math.max(0, t - 10))
    } else if (action === 'fast-forward') {
      const audio = audioPlayer.getAudioElement()
      const t = audio?.currentTime || 0
      const d = audio?.duration || 0
      audioPlayerRef.current.seek(Math.min(d || t + 10, t + 10))
    } else if (action === 'open-search') {
      setShowSearch(true)
    } else if (action === 'open-settings') {
      setShowSettings(true)
    } else if (action === 'menu') {
      // 菜单键：打开当前歌曲详情/操作
      const current = playlistRef.current[currentIndexRef.current]
      if (current) {
        setSongDetailSong(current)
        setShowSongDetail(true)
      }
    }
  }

  // TV：每次启动自动打开远程遥控器配对界面（TV设置里可关，默认关）
  useEffect(() => {
    if (!isTvModeActive()) return
    try {
      if (localStorage.getItem('tvAutoOpenRemote') !== '1') return
    } catch {
      return
    }
    // 等首帧渲染与交互层就绪后再弹出配对二维码
    const t = window.setTimeout(() => {
      setShowRemote(true)
    }, 1500)
    return () => window.clearTimeout(t)
  }, [])

  const handleSongSelectRef = useRef(handleSongSelect)
  handleSongSelectRef.current = handleSongSelect
  const desktopSpectrumBufferRef = useRef<Uint8Array | null>(null)
  const desktopSpectrumRawRef = useRef<number[]>(Array(48).fill(0))
  const desktopSpectrumDisplayRef = useRef<number[]>(Array(48).fill(0))
  // 音频频谱节点在首次播放时才创建，用 ref 保存最新引用，避免定时器闭包拿到旧对象
  const desktopAnalyserRef = useRef<AnalyserNode | null>(null)
  desktopAnalyserRef.current = audioPlayer.analyserNode || null
  // 小窗播放器/桌面歌词窗口的启用状态；没有消费者时频谱定时器跳过推送，避免持续分配数组与 IPC 开销
  const [desktopPlayerWindowEnabled, setDesktopPlayerWindowEnabled] = useState(false)
  const [desktopLyricsWindowEnabled, setDesktopLyricsWindowEnabled] = useState(false)
  const desktopOverlayActiveRef = useRef(false)
  desktopOverlayActiveRef.current = desktopPlayerWindowEnabled || desktopLyricsWindowEnabled
  const lyricOffsetRef = useRef(lyricOffset)
  lyricOffsetRef.current = lyricOffset
  // 频段边界与结果数组跨 tick 复用，避免每 100ms 新建多个数组
  const spectrumBandsRef = useRef<{ bins: number; edges: number[]; spectrum: number[] } | null>(null)
  const spectrumCompactRef = useRef<number[]>(Array(5).fill(0))
  const desktopSpectrumIdleRef = useRef(false)
  const desktopSpectrumConsumerCountRef = useRef(0)

  useEffect(() => {
    const bridge = window.electron?.desktopPlayer
    if (!bridge) return
    const unsubscribe = bridge.onControl((action, payload) => desktopControlHandlerRef.current(action, payload))
    return unsubscribe
  }, [])

  // TV 端远程遥控：remoteBridge 收到手机命令后经 DOM 事件注入，
  // 与桌面遥控共用 desktopControlHandlerRef 的同一套动作映射
  useEffect(() => {
    const onRemote = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string; payload?: unknown }>).detail
      if (detail?.action) desktopControlHandlerRef.current(detail.action, detail.payload)
    }
    window.addEventListener('waveforge:remote-control', onRemote)
    return () => window.removeEventListener('waveforge:remote-control', onRemote)
  }, [])

  useEffect(() => {
    const mediaKeys = window.electron?.mediaKeys
    const mediaSession = 'mediaSession' in navigator ? navigator.mediaSession : null

    const dispatchMediaControl = (action: string, payload?: any) => {
      const group = action === 'toggle' || action === 'play' || action === 'pause' ? 'playback' : action
      const now = Date.now()
      const last = lastMediaControlRef.current
      // Windows 有时会同时把同一次按键交给 globalShortcut 与 Media Session。
      if (last?.group === group && now - last.time < 280) return
      lastMediaControlRef.current = { group, time: now }
      desktopControlHandlerRef.current(action, payload)
    }

    const setMediaSessionHandlers = (enabled: boolean) => {
      if (!mediaSession) return
      const ignore = () => undefined
      const handlers: Array<[MediaSessionAction, MediaSessionActionHandler | null]> = [
        ['play', enabled ? () => dispatchMediaControl('play') : ignore],
        ['pause', enabled ? () => dispatchMediaControl('pause') : ignore],
        ['nexttrack', enabled ? () => dispatchMediaControl('next') : ignore],
        ['previoustrack', enabled ? () => dispatchMediaControl('prev') : ignore],
      ]
      handlers.forEach(([action, handler]) => {
        try {
          mediaSession.setActionHandler(action, handler)
        } catch (error) {
          console.warn(`Media Session action is unavailable: ${action}`, error)
        }
      })
    }

    const applyEnabledState = (enabled: boolean) => {
      setMediaSessionHandlers(enabled)
      if (!mediaKeys) return
      void mediaKeys.setEnabled(enabled).catch(error => {
        console.warn('Failed to update global media key support:', error)
      })
    }
    const handleSettingsChange = (event: Event) => {
      const settings = (event as CustomEvent<PlaybackShortcutSettings>).detail || loadPlaybackShortcutSettings()
      applyEnabledState(settings.mediaKeysEnabled)
    }

    applyEnabledState(loadPlaybackShortcutSettings().mediaKeysEnabled)
    const unsubscribe = mediaKeys?.onControl(action => dispatchMediaControl(action))
    window.addEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
    return () => {
      unsubscribe?.()
      if (mediaSession) {
        ;(['play', 'pause', 'nexttrack', 'previoustrack'] as MediaSessionAction[]).forEach(action => {
          try { mediaSession.setActionHandler(action, null) } catch { /* unsupported action */ }
        })
      }
      window.removeEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
    }
  }, [])

  // 媒体会话元数据：电视/系统状态栏显示正在播放的歌曲信息（封面/歌名/歌手）
  useEffect(() => {
    if (!currentSong) return
    if (!('mediaSession' in navigator)) return
    try {
      const artists = (currentSong.artists || []).map((a) => a.name).filter(Boolean).join(', ')
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentSong.name || '未知歌曲',
        artist: artists || currentSong.album?.name || '',
        album: currentSong.album?.name || '',
        artwork: currentSong.album?.picUrl
          ? [{ src: getProxiedImageUrl(currentSong.album.picUrl), sizes: '512x512' }]
          : [],
      })
    } catch (error) {
      console.warn('更新媒体会话元数据失败:', error)
    }
  }, [currentSong])

  // 小窗口点 X 关闭后，主进程会广播开关状态，这里转成 DOM 事件供设置面板同步
  useEffect(() => {
    const unsubscribe = window.electron?.desktopPlayer?.onEnabledChanged?.(enabled => {
      window.dispatchEvent(new CustomEvent('desktopPlayerEnabledChanged', { detail: enabled === true }))
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.electron?.desktopLyrics?.onEnabledChanged?.(enabled => {
      window.dispatchEvent(new CustomEvent('desktopLyricsEnabledChanged', { detail: enabled === true }))
    })
    return unsubscribe
  }, [])

  // 初始化并跟踪两个桌面小窗的启用状态，用于频谱推送门控
  useEffect(() => {
    let active = true
    window.electron?.desktopPlayer?.getInitialState?.().then(snapshot => {
      if (active) setDesktopPlayerWindowEnabled(Boolean(snapshot?.enabled))
    }).catch(() => undefined)
    window.electron?.desktopLyrics?.getSettings?.().then(settings => {
      if (active) setDesktopLyricsWindowEnabled(Boolean(settings?.enabled))
    }).catch(() => undefined)
    const syncPlayer = (event: Event) => setDesktopPlayerWindowEnabled(Boolean((event as CustomEvent<boolean>).detail))
    const syncLyrics = (event: Event) => setDesktopLyricsWindowEnabled(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('desktopPlayerEnabledChanged', syncPlayer)
    window.addEventListener('desktopLyricsEnabledChanged', syncLyrics)
    return () => {
      active = false
      window.removeEventListener('desktopPlayerEnabledChanged', syncPlayer)
      window.removeEventListener('desktopLyricsEnabledChanged', syncLyrics)
    }
  }, [])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({
      song: currentSong
        ? {
            name: currentSong.name,
            artists: Array.isArray(currentSong.artists)
              ? currentSong.artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ')
              : '',
            coverUrl: currentSong.album?.picUrl || '',
          }
        : null,
      // 时长（秒）：主进程据此把任务栏进度条换算为 0-1
      duration: currentSong && Number.isFinite(Number(currentSong.duration))
        ? Math.max(0, Number(currentSong.duration) / 1000)
        : 0,
    })
  }, [currentSong])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({
      hasTranslation,
      hasRomaji: hasRoman,
      lyric: desktopLyricLine
        ? {
            line: desktopLyricLine.text || '',
            translation: desktopLyricLine.translation || '',
            romaji: desktopLyricLine.roman || '',
            nextLine: desktopNextLyricLine?.text || '',
            nextTranslation: desktopNextLyricLine?.translation || '',
            nextRomaji: desktopNextLyricLine?.roman || '',
            words: Array.isArray(desktopLyricLine.words)
              ? desktopLyricLine.words.map((word: any) => ({
                  word: word.word,
                  startTime: Number(word.startTime) || 0,
                  duration: Number(word.duration) || 0,
                }))
              : [],
            romanWords: Array.isArray(desktopLyricLine.romanWords)
              ? desktopLyricLine.romanWords.map((word: any) => ({
                  word: word.word,
                  startTime: Number(word.startTime) || 0,
                  duration: Number(word.duration) || 0,
                }))
              : [],
            lineStart: Number(desktopLyricLine.time) || 0,
            lineDuration: desktopLyricDuration,
            isInterlude: desktopLyricLine.isGeneratedInterlude === true,
            interludeStartTime: desktopLyricLine.interludeStartTime,
            interludeEndTime: desktopLyricLine.interludeEndTime,
          }
        : null,
    })
  }, [desktopLyricLine, desktopNextLyricLine, desktopLyricDuration, hasTranslation, hasRoman])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({ playing: isPlaying })
  }, [isPlaying])

  // 遥控器：把音量/静音状态同步给主进程（用于手机端状态显示）
  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({ volume, muted })
  }, [volume, muted])

  // 遥控器：把当前页面（主页/播放页）同步给主进程，「模式切换」据此展示模式列表或歌词样式列表
  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({ page: isPlaybackPage ? 'playback' : 'home' })
  }, [isPlaybackPage])

  // 右键菜单「查看歌曲详情」：通过全局事件打开歌曲详情弹窗
  useEffect(() => {
    const handler = (e: Event) => {
      const song = (e as CustomEvent).detail
      if (song) {
        setSongDetailSong(song)
        setShowSongDetail(true)
      }
    }
    window.addEventListener('waveforge:show-song-detail', handler)
    return () => window.removeEventListener('waveforge:show-song-detail', handler)
  }, [])

  // 右键菜单「相似歌曲」：通过全局事件展示相似歌曲列表
  useEffect(() => {
    const handler = (e: Event) => {
      const song = (e as CustomEvent).detail
      if (song) {
        setSimilarSongsSource(song)
        setShowSimilarSongs(true)
      }
    }
    window.addEventListener('waveforge:show-similar-songs', handler)
    return () => window.removeEventListener('waveforge:show-similar-songs', handler)
  }, [])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({ accentColor: coverPalette[0] || dominantColor })
  }, [coverPalette, dominantColor])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({
      playlist: playlist.slice(0, 500).map((song: any, index: number) => ({
        index,
        name: song?.name || '',
        artists: Array.isArray(song?.artists)
          ? song.artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ')
          : '',
      })),
      currentIndex,
    })
  }, [playlist, currentIndex])

  useEffect(() => {
    let timer: number | null = null
    let disposed = false

    const schedule = (delay = 100) => {
      if (disposed || timer !== null) return
      timer = window.setTimeout(tick, delay)
    }

    const tick = () => {
      timer = null
      const overlayActive = desktopOverlayActiveRef.current
      const consumerCount = document.visibilityState === 'visible' ? getDesktopSpectrumConsumerCount() : 0
      const spectrumWidgetVisible = consumerCount > 0
      if (consumerCount !== desktopSpectrumConsumerCountRef.current) {
        desktopSpectrumConsumerCountRef.current = consumerCount
        desktopSpectrumIdleRef.current = false
      }
      if (!overlayActive && !spectrumWidgetVisible) return

      const audio = audioPlayer.getAudioElement()
      const analyser = desktopAnalyserRef.current
      const audioActive = Boolean(analyser && isPlayingRef.current && !(audio?.paused ?? true))
      if (!audioActive && desktopSpectrumIdleRef.current && !overlayActive) return

      let spectrum: number[]
      if (audioActive && analyser) {
        const bins = analyser.frequencyBinCount
        if (!desktopSpectrumBufferRef.current || desktopSpectrumBufferRef.current.length !== bins) {
          desktopSpectrumBufferRef.current = new Uint8Array(bins)
        }
        const data = desktopSpectrumBufferRef.current
        analyser.getByteFrequencyData(data)
        const bandCount = 48
        let bands = spectrumBandsRef.current
        if (!bands || bands.bins !== bins) {
          const edges = Array.from({ length: bandCount + 1 }, (_, index) => {
            const curved = Math.pow(index / bandCount, 1.65)
            return Math.min(bins, Math.floor(bins * .82 * curved))
          })
          bands = { bins, edges, spectrum: Array(bandCount).fill(0) }
          spectrumBandsRef.current = bands
        }
        spectrum = bands.spectrum
        const edges = bands.edges
        for (let band = 0; band < bandCount; band += 1) {
          const start = edges[band]
          const end = Math.max(start + 1, edges[band + 1])
          let energy = 0
          for (let index = start; index < end; index += 1) energy += (data[index] / 255) ** 2
          const rms = Math.sqrt(energy / Math.max(1, end - start))
          const gain = .82 + (band / Math.max(1, bandCount - 1)) * .7
          const raw = Math.min(1, Math.pow(rms, 1.06) * gain)
          const previousRaw = desktopSpectrumRawRef.current[band]
          const displayed = desktopSpectrumDisplayRef.current
          desktopSpectrumRawRef.current[band] = raw
          const level = Math.max(0, Math.min(1, (raw - 0.045) / 0.68))
          const transient = Math.max(0, Math.min(1, (raw - previousRaw) * 6.5))
          const target = Math.min(0.84, 0.035 + Math.pow(level, 1.22) * 0.55 + transient * 0.24)
          displayed[band] += (target - displayed[band]) * (target > displayed[band] ? 0.68 : 0.38)
          spectrum[band] = displayed[band]
        }
      } else {
        spectrum = spectrumBandsRef.current?.spectrum ?? Array(48).fill(0)
        for (let band = 0; band < spectrum.length; band += 1) spectrum[band] = 0
      }

      const compactSpectrum = spectrumCompactRef.current
      for (let compactIndex = 0; compactIndex < 5; compactIndex += 1) {
        const start = Math.floor((compactIndex / 5) * spectrum.length)
        const end = Math.max(start + 1, Math.floor(((compactIndex + 1) / 5) * spectrum.length))
        let total = 0
        for (let index = start; index < end; index += 1) total += spectrum[index]
        compactSpectrum[compactIndex] = total / Math.max(1, end - start)
      }
      if (overlayActive) {
        window.electron?.desktopPlayer?.pushState({
          spectrum: compactSpectrum,
          progress: (Number(audio?.currentTime) || 0) + lyricOffsetRef.current - 0.2,
          duration: Number(audio?.duration) || 0,
        })
      }
      if (spectrumWidgetVisible) {
        window.dispatchEvent(new CustomEvent('desktopSpectrumChanged', { detail: spectrum }))
      }
      desktopSpectrumIdleRef.current = !audioActive

      if (isPlayingRef.current && (overlayActive || spectrumWidgetVisible)) schedule()
    }

    const wake = () => {
      desktopSpectrumIdleRef.current = false
      schedule(0)
    }

    const unsubscribeConsumers = subscribeDesktopSpectrumConsumers(wake)
    document.addEventListener('visibilitychange', wake)
    wake()

    return () => {
      disposed = true
      unsubscribeConsumers()
      document.removeEventListener('visibilitychange', wake)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [isPlaying, desktopPlayerWindowEnabled, desktopLyricsWindowEnabled])

  // Windows 任务栏缩略图进度条：小窗/歌词窗口未启用时没有频谱推送路径，
  // 这里在播放中低频上报 progress+duration，让主进程能刷新任务栏进度（0-1）。
  useEffect(() => {
    if (!isPlaying) return
    const timer = window.setInterval(() => {
      // 有 overlay 时上面的 tick 已每 100ms 高频推送，无需重复上报
      if (desktopOverlayActiveRef.current) return
      const audio = audioPlayer.getAudioElement()
      if (!audio || audio.paused) return
      window.electron?.desktopPlayer?.pushState({
        progress: (Number(audio.currentTime) || 0) + lyricOffsetRef.current - 0.2,
        duration: Number.isFinite(audio.duration) && (audio.duration ?? 0) > 0 ? audio.duration : 0,
      })
    }, 500)
    return () => window.clearInterval(timer)
  }, [isPlaying])

  const handleSeek = useCallback((time: number) => {
    audioPlayerRef.current.seek(time)
  }, [])

  const handleVolumeChange = useCallback((newVolume: number) => {
    audioPlayerRef.current.setVolume(newVolume)
  }, [])

  const handleDesktopQueueRemove = useCallback((index: number) => {
    if (index < 0 || index === currentIndexRef.current) return
    setPlaylist(current => {
      if (index >= current.length) return current
      const next = current.filter((_, itemIndex) => itemIndex !== index)
      playlistRef.current = next
      if (index < currentIndexRef.current) {
        currentIndexRef.current -= 1
        setCurrentIndex(currentIndexRef.current)
      }
      return next
    })
    bumpQueueRevision()
  }, [bumpQueueRevision])

  const handleDesktopQueueMove = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return
    setPlaylist(current => {
      if (from >= current.length || to >= current.length) return current
      const next = [...current]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      const active = currentIndexRef.current
      const nextActive = active === from ? to : from < active && to >= active ? active - 1 : from > active && to <= active ? active + 1 : active
      currentIndexRef.current = nextActive
      playlistRef.current = next
      setCurrentIndex(nextActive)
      return next
    })
    bumpQueueRevision()
  }, [bumpQueueRevision])

  // 登录处理
  const handleNeteaseLogin = async (cookie: string, showToastMessage = true) => {
    setNeteaseCookie(cookie)
    setNeteaseLoggedIn(true)
    localStorage.setItem('netease_cookie', cookie)
    localStorage.setItem('neteaseCookie', cookie)
    
    // 获取网易云账号资料
    try {
      const res = await fetch(`http://localhost:3001/api/netease/user/account?cookie=${encodeURIComponent(cookie)}`)
      const data = await res.json()
      if (data.profile) {
        const profileUserId = data.profile.userId?.toString() || ''
        setNeteaseUsername(data.profile.nickname || '网易云用户')
        setNeteaseAvatar(data.profile.avatarUrl || '')
        setNeteaseUserId(profileUserId)
        const isVip = data.profile.vipType > 0
        setNeteaseVip(isVip)
        localStorage.setItem('netease_vip', isVip.toString())
        if (profileUserId) localStorage.setItem('netease_user_id', profileUserId)
        localStorage.setItem('netease_username', data.profile.nickname || '网易云用户')
      }
    } catch (error) {
      console.error('获取用户信息失败:', error)
      setNeteaseUsername('网易云用户')
    }
    setAuthRevision(previous => previous + 1)
    // 记录登录有效期（网易云 cookie 官方约 30 天）
    recordLogin('netease')
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', {
      detail: {
        platform: 'netease',
        userId: localStorage.getItem('netease_user_id') || ''
      }
    }))
    // 显示登录成功Toast（只在主动登录时显示，不在页面加载时显示）
    if (showToastMessage) {
      addToast('网易云音乐登录成功', 'info')
    }
  }

  const handleNeteaseLogout = () => {
    setNeteaseLoggedIn(false)
    setNeteaseUsername('')
    setNeteaseAvatar('')
    setNeteaseUserId('')
    setNeteaseVip(false)
    setNeteaseCookie('')
    localStorage.removeItem('netease_cookie')
    localStorage.removeItem('neteaseCookie')
    localStorage.removeItem('netease_user_id')
    localStorage.removeItem('netease_username')
    localStorage.removeItem('netease_vip')
    clearLoginExpiry('netease')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'netease' } }))
  }

  const handleQQLogin = async (cookie: string, showToastMessage = true) => {
    try {
      // 1. 鍏堣閸忓牐顔曠純鐡筼okie閸掔増婀囬崝鈥虫珤
      const setCookieRes = await fetch('http://localhost:3001/api/qq/user/setCookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: cookie })
      })
      const setCookieData = await setCookieRes.json()
      
      if (setCookieData.result === 100 && setCookieData.data?.uin) {
        const uin = setCookieData.data.uin
        setQQCookie(cookie)
        setQQLoggedIn(true)
        setQQUserId(uin)
        localStorage.setItem('qq_cookie', cookie)
        localStorage.setItem('qqCookie', cookie)
        localStorage.setItem('qq_logged_in', 'true')
        localStorage.setItem('qq_user_id', uin)
        
        // 2. 获取用户详细信息
        const userDetailRes = await fetch(`http://localhost:3001/api/qq/user/detail?id=${uin}&cookie=${encodeURIComponent(cookie)}`)
        const userDetailData = await userDetailRes.json()
        
        // qq-music-api返回的歌曲详情可能在result字段中
        if (userDetailData.creator) {
          const user = userDetailData.creator
          
          const username = getQQUserDisplayName(userDetailData, uin)
          const avatar = user.headpic || user.avatarUrl || user.avatar || ''
          const isVip = detectQQMusicVip(userDetailData)
          
          setQQUsername(username)
          setQQAvatar(avatar)
          setQQVip(isVip)
          
          // 保存到localStorage
          localStorage.setItem('qq_username', username)
          localStorage.setItem('qq_avatar', avatar)
          localStorage.setItem('qq_vip', isVip.toString())
          // 显示登录成功Toast（只在主动登录时显示）
          if (showToastMessage) {
            addToast('QQ音乐登录成功', 'success')
          }
        } else {
          // 如果获取详情失败，至少设置基本信息
          console.warn('⚠️ 获取QQ音乐用户详情失败，使用默认信息')
          console.warn('响应数据:', userDetailData)
          setQQUsername(getQQUserDisplayName(userDetailData, uin))
          setQQAvatar('')
          const cachedVip = localStorage.getItem('qq_vip') === 'true'
          setQQVip(cachedVip)
          localStorage.setItem('qq_username', getQQUserDisplayName(userDetailData, uin))
        }
        setAuthRevision(previous => previous + 1)
        // 记录登录有效期（QQ 音乐 cookie 官方约 30 天）
        recordLogin('qq')
        window.dispatchEvent(new CustomEvent('waveforge-auth-changed', {
          detail: { platform: 'qq', userId: uin }
        }))
      } else {
        throw new Error('设置Cookie失败')
      }
    } catch (error) {
      console.error('❌ QQ音乐登录失败:', error)
      // 添加到喜欢失败
      setQQUsername('QQ音乐用户')
      setQQAvatar('')
      setQQUserId('')
      setQQVip(false)
      setQQCookie('')
      setQQLoggedIn(false)
      localStorage.removeItem('qq_cookie')
      localStorage.removeItem('qqCookie')
      localStorage.removeItem('qq_logged_in')
      localStorage.removeItem('qq_user_id')
      localStorage.removeItem('qq_vip')
      if (showToastMessage) addToast(error instanceof Error ? error.message : 'QQ音乐登录失败', 'error')
    }
  }

  const handleQQLogout = () => {
    setQQLoggedIn(false)
    setQQUsername('')
    setQQAvatar('')
    setQQUserId('')
    setQQVip(false)
    setQQCookie('')
    localStorage.removeItem('qq_cookie')
    localStorage.removeItem('qqCookie')
    localStorage.removeItem('qq_logged_in')
    localStorage.removeItem('qq_user_id')
    localStorage.removeItem('qq_vip')
    clearLoginExpiry('qq')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'qq' } }))
    void fetch('http://localhost:3001/api/qq/cookie', { method: 'DELETE' }).catch(() => undefined)
  }

  // Apple Music 登录态：token 保存在 localStorage（AppleLoginPanel 写入），
  // 这里只同步 React 状态并广播 auth 事件，让首页/个人中心等模块感知变化。
  const handleAppleLogin = (user: AppleUserInfo | null) => {
    refreshAppleAuth(user)
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', {
      detail: { platform: 'apple', userId: '' }
    }))
    if (user) addToast('Apple Music 登录成功', 'success')
  }

  const handleAppleLogout = () => {
    clearAppleLogin()
    localStorage.removeItem('appleDeveloperToken')
    localStorage.removeItem('appleMediaUserToken')
    refreshAppleAuth(null)
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'apple' } }))
    addToast('Apple Music 已退出登录', 'info')
  }

  // Spotify OAuth 授权结果（主进程回调）：持久化 token + 同步登录态
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.onSpotifyAuthResult) return
    const unsub = bridge.onSpotifyAuthResult((result: any) => {
      if (!result?.success || !result.accessToken) return
      localStorage.setItem('spotify_access_token', result.accessToken)
      if (result.refreshToken) localStorage.setItem('spotify_refresh_token', result.refreshToken)
      if (result.username) localStorage.setItem('spotify_username', result.username)
      if (result.avatar) localStorage.setItem('spotify_avatar', result.avatar)
      if (result.userId) localStorage.setItem('spotify_user_id', result.userId)
      setSpotifyLoggedIn(true)
      if (result.username) setSpotifyUsername(result.username)
      if (result.avatar) setSpotifyAvatar(result.avatar)
      setAuthRevision(previous => previous + 1)
      window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'spotify', userId: result.userId || '' } }))
      addToast('Spotify 授权成功', 'success')
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 酷狗登录结果（主进程回调）：同步 userId/avatar 等扩展信息
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.onKugouAuthResult) return
    const unsub = bridge.onKugouAuthResult((result: any) => {
      if (!result?.success || !result.cookie) return
      if (result.username) localStorage.setItem('kugou_username', result.username)
      if (result.userId) localStorage.setItem('kugou_user_id', result.userId)
      if (result.avatar) localStorage.setItem('kugou_avatar', result.avatar)
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 酷狗会话自动恢复：应用启动时若 Electron 会话已带 KuGoo 登录态，直接恢复
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.getKugouSession) return
    let active = true
    void bridge.getKugouSession().then((session: any) => {
      if (!active || !session?.loggedIn || !session.cookie) return
      localStorage.setItem('kugou_cookie', session.cookie)
      if (session.username) {
        setKugouUsername(session.username)
        localStorage.setItem('kugou_username', session.username)
      }
      if (session.userId) localStorage.setItem('kugou_user_id', session.userId)
      if (session.avatar) localStorage.setItem('kugou_avatar', session.avatar)
      if (!kugouLoggedIn) {
        setKugouLoggedIn(true)
        setAuthRevision(previous => previous + 1)
        window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'kugou' } }))
      }
    }).catch(() => { /* 忽略 */ })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 汽水登录结果（主进程回调）：同步用户名/头像
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.onSodaAuthResult) return
    const unsub = bridge.onSodaAuthResult((result: any) => {
      if (!result?.success || !result.cookie) return
      if (result.username) {
        localStorage.setItem('soda_username', result.username)
        setSodaUsername(result.username)
      }
      if (result.avatar) localStorage.setItem('soda_avatar', result.avatar)
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 新三平台登录态处理（登录面板写入 localStorage，这里同步 React 状态 + 广播）──
  const handleSpotifyLogin = (cookie: string, username?: string) => {
    // Spotify 由主进程 OAuth 写入 token；仅当存在真实 access_token 才算登录（cookie 参数仅作占位）
    const loggedIn = Boolean(localStorage.getItem('spotify_access_token'))
    setSpotifyLoggedIn(loggedIn)
    if (username && loggedIn) {
      setSpotifyUsername(username)
      localStorage.setItem('spotify_username', username)
    }
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'spotify' } }))
    if (loggedIn) addToast('Spotify 登录成功', 'success')
  }
  const handleSpotifyLogout = () => {
    localStorage.removeItem('spotify_access_token')
    localStorage.removeItem('spotify_refresh_token')
    localStorage.removeItem('spotify_username')
    localStorage.removeItem('spotify_avatar')
    localStorage.removeItem('spotify_user_id')
    setSpotifyLoggedIn(false)
    setSpotifyUsername('')
    setSpotifyAvatar('')
    setSpotifyUserId('')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'spotify' } }))
    addToast('Spotify 已退出登录', 'info')
  }
  const handleKugouLogin = (cookie: string, username?: string) => {
    // 仅当 Cookie 含真实登录凭据（KuGoo 会话 或 kg_token）才算登录
    const loggedIn = Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
    setKugouLoggedIn(loggedIn)
    if (loggedIn) {
      localStorage.setItem('kugou_cookie', cookie)
      if (username) {
        setKugouUsername(username)
        localStorage.setItem('kugou_username', username)
      } else {
        // 未带回昵称：用代理拉取用户信息自愈
        void fetch(`http://localhost:3001/api/kugou/user/info?cookie=${encodeURIComponent(cookie)}`, { cache: 'no-store' })
          .then(res => res.ok ? res.json() : null)
          .then((info: any) => {
            if (info?.nickname) {
              setKugouUsername(info.nickname)
              localStorage.setItem('kugou_username', info.nickname)
              if (info.user_id) localStorage.setItem('kugou_user_id', String(info.user_id))
              if (info.avatar) localStorage.setItem('kugou_avatar', info.avatar)
            }
          })
          .catch(() => { /* 忽略 */ })
      }
    }
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'kugou' } }))
    if (loggedIn) addToast('酷狗音乐登录成功', 'success')
  }
  const handleKugouLogout = () => {
    localStorage.removeItem('kugou_cookie')
    localStorage.removeItem('kugou_username')
    localStorage.removeItem('kugou_avatar')
    localStorage.removeItem('kugou_user_id')
    setKugouLoggedIn(false)
    setKugouUsername('')
    setKugouAvatar('')
    setKugouUserId('')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'kugou' } }))
    addToast('酷狗音乐已退出登录', 'info')
  }
  const handleSodaLogin = (cookie: string, username?: string) => {
    setSodaLoggedIn(Boolean(cookie))
    if (cookie) {
      localStorage.setItem('soda_token', cookie)
      if (username) {
        setSodaUsername(username)
        localStorage.setItem('soda_username', username)
      }
    }
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'soda' } }))
    if (cookie) addToast('汽水音乐登录成功', 'success')
  }
  const handleSodaLogout = () => {
    localStorage.removeItem('soda_token')
    localStorage.removeItem('soda_username')
    localStorage.removeItem('soda_avatar')
    localStorage.removeItem('soda_user_id')
    setSodaLoggedIn(false)
    setSodaUsername('')
    setSodaAvatar('')
    setSodaUserId('')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'soda' } }))
    addToast('汽水音乐已退出登录', 'info')
  }

  const handleRemoveFromFavorites = async (song: Song): Promise<boolean> => {
    try {
      const platform = (song.platform || 'netease') as MusicPlatform
      // Apple：取消收藏 = 从音乐库移除（amp-api）
      if (platform === 'apple') {
        if (!appleLoggedIn) {
          addToast('请先登录 Apple Music', 'error')
          return false
        }
        const appleSongId = song.appleId || String(song.id)
        const ok = await removeAppleSongFromLibrary(appleSongId)
        if (ok) {
          addToast('已从 Apple 音乐库移除', 'success')
          applyFavoriteMutation({ platform: 'apple', type: 'unlike', songId: appleSongId })
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'unlike', songId: appleSongId }
          }))
          return true
        }
        addToast('移除失败，请检查登录状态', 'error')
        return false
      }
      const userId = platform === 'netease' ? neteaseUserId : qqUserId

      if (!userId) {
        addToast(`请先登录${platform === 'netease' ? '网易云音乐' : 'QQ音乐'}`, 'error')
        return false
      }

      const mutationSong = platform === 'qq' && !song.mid ? await loadQQSongDetail(song) : song
      const result = await likeSong(mutationSong.id.toString(), userId, platform, false, {
        songMid: mutationSong.mid,
        songType: mutationSong.songType
      })

      if (result.code === 200 || result.result === 100) {
        addToast('已从喜欢歌单中移除', 'success')
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: { platform, type: 'unlike', songId: mutationSong.id, songMid: mutationSong.mid }
        }))
        return true
      }

      addToast(result.error || result.message || '从喜欢歌单移除失败', 'error')
      return false
    } catch (error) {
      console.error('从喜欢歌单移除时出错:', error)
      addToast(error instanceof Error ? error.message : '从喜欢歌单移除失败', 'error')
      return false
    }
  }

  const handlePlaybackContextMenuOpen = () => {
    if (!currentSong) return
    setPlaybackContextPlaylists([])
    const platform = (currentSong.platform || 'netease') as MusicPlatform
    // Apple：播放上下文歌单用资料库歌单（amp-api）
    if (platform === 'apple') {
      void getAppleLibraryPlaylists(100)
        .then(setPlaybackContextPlaylists)
        .catch(() => setPlaybackContextPlaylists([]))
      return
    }
    const userId = platform === 'netease' ? neteaseUserId : qqUserId
    const username = platform === 'netease' ? neteaseUsername : qqUsername
    if (!userId) {
      return
    }
    void getUserPlaylists(platform, userId, username)
      .then(setPlaybackContextPlaylists)
      .catch(error => {
        console.warn('Failed to load playlists for playback context menu:', error)
        setPlaybackContextPlaylists([])
      })
  }

  const handlePlaybackToggleFavorite = (song: Song, liked: boolean) => {
    if (liked) void handleRemoveFromFavorites(song)
    else void handleAddToFavorites(song)
  }

  const handlePlaybackViewArtist = (song: Song) => {
    const platform = (song.platform || 'netease') as 'netease' | 'qq'
    const artist = song.artists?.[0]
    const artistId = platform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
    if (!artistId) {
      addToast('当前歌曲缺少歌手信息', 'error')
      return
    }
    handleOpenArtist(String(artistId), platform)
  }

  const handlePlaybackViewAlbum = (song: Song) => {
    const platform = (song.platform || 'netease') as 'netease' | 'qq'
    void resolveSongAlbumIdentifier(song, platform).then(albumId => {
      if (!albumId) {
        addToast('当前歌曲缺少专辑信息', 'error')
        return
      }
      handleOpenAlbum(albumId, platform)
    })
  }

  // 监听喜欢状态变化
  useEffect(() => {
    const restoreLoginState = async () => {
      try {
        const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie')
        if (neteaseCookie) {
          await handleNeteaseLogin(neteaseCookie, false)
        }

        const qqCookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie')
        if (qqCookie) {
          await handleQQLogin(qqCookie, false)
        }
      } finally {
        setLoginRestoreComplete(true)
      }
    }

    restoreLoginState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 仅在组件挂载时执行一次?

  useEffect(() => {
    if (!loginRestoreComplete) return
    // 登录有效期提示：已登录但已过期的平台，启动时提醒重新登录（仅启动恢复完成时一次）
    const expiredPlatforms: string[] = []
    if (neteaseLoggedIn && isLoginExpired('netease')) expiredPlatforms.push('网易云音乐')
    if (qqLoggedIn && isLoginExpired('qq')) expiredPlatforms.push('QQ 音乐')
    if (appleLoggedIn && isLoginExpired('apple')) expiredPlatforms.push('Apple Music')
    if (expiredPlatforms.length) {
      addToast(`${expiredPlatforms.join('、')} 登录已过期，请重新登录`, 'info')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginRestoreComplete])

  useEffect(() => {
    if (!loginRestoreComplete) return
    return scheduleBackgroundPrefetch({ viewMode, neteaseLoggedIn, qqLoggedIn })
  }, [loginRestoreComplete, viewMode, neteaseLoggedIn, qqLoggedIn, neteaseUserId, qqUserId])

  // 处理喜欢按钮点击 - 切换喜欢状态
  const getBackgroundStyle = () => {
    // 根据主题和显示模式返回背景样式
    if (playerTheme === 'light') {
      return dominantColor 
        ? `linear-gradient(135deg, ${dominantColor}20 0%, #f5f5f0 50%, #e8e8e0 100%)`
        : 'linear-gradient(135deg, #f5f5f0 0%, #e8e8e0 100%)'
    }
    // 深色主题返回深色渐变背景
    return dominantColor 
      ? `linear-gradient(135deg, ${dominantColor}15 0%, #000 100%)`
      : 'linear-gradient(135deg, #0a0a0a 0%, #000 100%)'
  }


  // ===== GPU 设置变更确认：用户修改显卡/关闭 GPU 加速后重启需确认，否则自动回退到安全默认值 =====
  const [pendingGpuChange, setPendingGpuChange] = useState<{ type: 'preference' | 'acceleration' } | null>(null)
  const [gpuConfirmCountdown, setGpuConfirmCountdown] = useState(15)
  const gpuCountdownRef = useRef(15)

  const confirmGpuChange = useCallback(async () => {
    try {
      await window.electron?.system.confirmGpuChange()
    } catch {}
    setPendingGpuChange(null)
  }, [])

  const revertGpuChange = useCallback(async () => {
    try {
      await window.electron?.system.revertGpuChange()
    } catch {}
    setPendingGpuChange(null)
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: '已恢复为安全默认设置（系统默认显卡 / 开启 GPU 加速），重启后生效', type: 'info' }
    }))
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.electron?.system.getHardwareAcceleration().then(result => {
      if (cancelled) return
      if (result.pendingGpuChange) setPendingGpuChange(result.pendingGpuChange)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!pendingGpuChange) return
    gpuCountdownRef.current = 15
    setGpuConfirmCountdown(15)
    const timer = window.setInterval(() => {
      gpuCountdownRef.current -= 1
      if (gpuCountdownRef.current <= 0) {
        window.clearInterval(timer)
        void revertGpuChange()
      } else {
        setGpuConfirmCountdown(gpuCountdownRef.current)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pendingGpuChange, revertGpuChange])

  // ===== 三视图稳定回调（latest-ref 模式）=====
  // HomeView/ExploreView/DesktopView 已包 React.memo；播放中 App 约 1Hz 重渲染时，
  // 若这些函数 props 每次新建会击穿 memo 导致整棵视图子树反复重渲染。
  // 这里只暴露一次性创建的稳定引用，实现始终经 ref 取最新，行为与原内联等价。
  type ViewCallbacks = {
    onSongSelect: typeof handleSongSelect
    onOpenArtist: typeof handleOpenArtist
    onOpenAlbum: typeof handleOpenAlbum
    onPlayNext: typeof handlePlayNext
    onAddToFavorites: typeof handleAddToFavorites
    onRemoveFromFavorites: typeof handleRemoveFromFavorites
    onAddToPlaylist: typeof handleAddToPlaylist
    onViewComments: typeof handleViewComments
    onCopyInfo: typeof handleCopyInfo
    onPrevious: typeof handlePrevious
    onNext: typeof handleNext
    onPlayPause: typeof handlePlayPause
    onSeek: typeof handleSeek
    onVolumeChange: typeof handleVolumeChange
    onNeteaseLogin: typeof handleNeteaseLogin
    onNeteaseLogout: typeof handleNeteaseLogout
    onQQLogin: typeof handleQQLogin
    onQQLogout: typeof handleQQLogout
    onSpotifyLogin: typeof handleSpotifyLogin
    onSpotifyLogout: typeof handleSpotifyLogout
    onKugouLogin: typeof handleKugouLogin
    onKugouLogout: typeof handleKugouLogout
    onSodaLogin: typeof handleSodaLogin
    onSodaLogout: typeof handleSodaLogout
    onRemoveQueueItem: typeof handleDesktopQueueRemove
    onMoveQueueItem: typeof handleDesktopQueueMove
    onLoginClick: (platform: 'netease' | 'qq') => void
    onNeteaseLoginClick: () => void
    onQQLoginClick: () => void
    onSearchClick: () => void
    onRemoteClick: () => void
    onSettingsClick: () => void
    onProfileClick: (platform: MusicPlatform, initialTab?: 'created' | 'subscribed' | 'detail' | 'recent') => void
    onOpenPlayer: () => void
    onExitDesktopMode: () => void
  }
  const viewCallbacksRef = useRef<ViewCallbacks>(null as unknown as ViewCallbacks)
  viewCallbacksRef.current = {
    onSongSelect: handleSongSelect,
    onOpenArtist: handleOpenArtist,
    onOpenAlbum: handleOpenAlbum,
    onPlayNext: handlePlayNext,
    onAddToFavorites: handleAddToFavorites,
    onRemoveFromFavorites: handleRemoveFromFavorites,
    onAddToPlaylist: handleAddToPlaylist,
    onViewComments: handleViewComments,
    onCopyInfo: handleCopyInfo,
    onPrevious: handlePrevious,
    onNext: handleNext,
    onPlayPause: handlePlayPause,
    onSeek: handleSeek,
    onVolumeChange: handleVolumeChange,
    onNeteaseLogin: handleNeteaseLogin,
    onNeteaseLogout: handleNeteaseLogout,
    onQQLogin: handleQQLogin,
    onQQLogout: handleQQLogout,
    onSpotifyLogin: handleSpotifyLogin,
    onSpotifyLogout: handleSpotifyLogout,
    onKugouLogin: handleKugouLogin,
    onKugouLogout: handleKugouLogout,
    onSodaLogin: handleSodaLogin,
    onSodaLogout: handleSodaLogout,
    onRemoveQueueItem: handleDesktopQueueRemove,
    onMoveQueueItem: handleDesktopQueueMove,
    onLoginClick: (platform) => {
      setLoginPlatform(platform)
      setShowLogin(true)
    },
    onNeteaseLoginClick: () => {
      setLoginPlatform('netease')
      setShowLogin(true)
    },
    onQQLoginClick: () => {
      setLoginPlatform('qq')
      setShowLogin(true)
    },
    onSearchClick: () => setShowSearch(true),
    onRemoteClick: () => setShowRemote(true),
    onSettingsClick: () => setShowSettings(true),
    onProfileClick: (platform, initialTab = 'created') => {
      setProfileInitialPlatform(platform)
      setProfileInitialTab(initialTab)
      setShowProfile(true)
    },
    onOpenPlayer: () => {
      setShowLogin(false)
      setShowSearch(false)
      playbackOriginRef.current = { mode: 'explore', surface: 'mode-root' }
      setRestorePlaybackOrigin(null)
      setEnteredFromMode('explore')
      setViewMode('minimal')
      localStorage.setItem('viewMode', 'minimal')
      setShowHome(false)
    },
    onExitDesktopMode: () => {
      playbackOriginRef.current = { mode: 'desktop', surface: 'mode-root' }
      setRestorePlaybackOrigin(null)
      setViewMode('minimal')
      localStorage.setItem('viewMode', 'minimal')
      setShowHome(false)
      setEnteredFromMode('desktop')
    },
  }
  const viewCallbacks = useMemo<ViewCallbacks>(() => {
    const latest = viewCallbacksRef
    return {
      onSongSelect: (song, playlistFromSource, origin) => latest.current.onSongSelect(song, playlistFromSource, origin),
      onOpenArtist: (artistId, platform) => latest.current.onOpenArtist(artistId, platform),
      onOpenAlbum: (albumId, platform) => latest.current.onOpenAlbum(albumId, platform),
      onPlayNext: (song) => latest.current.onPlayNext(song),
      onAddToFavorites: (song) => latest.current.onAddToFavorites(song),
      onRemoveFromFavorites: (song) => latest.current.onRemoveFromFavorites(song),
      onAddToPlaylist: (song, playlistId) => latest.current.onAddToPlaylist(song, playlistId),
      onViewComments: (song) => latest.current.onViewComments(song),
      onCopyInfo: (song) => latest.current.onCopyInfo(song),
      onPrevious: () => latest.current.onPrevious(),
      onNext: () => latest.current.onNext(),
      onPlayPause: () => latest.current.onPlayPause(),
      onSeek: (time) => latest.current.onSeek(time),
      onVolumeChange: (newVolume) => latest.current.onVolumeChange(newVolume),
      onNeteaseLogin: (cookie, showToastMessage) => latest.current.onNeteaseLogin(cookie, showToastMessage),
      onNeteaseLogout: () => latest.current.onNeteaseLogout(),
      onQQLogin: (cookie, showToastMessage) => latest.current.onQQLogin(cookie, showToastMessage),
      onQQLogout: () => latest.current.onQQLogout(),
      onSpotifyLogin: (cookie, username) => latest.current.onSpotifyLogin(cookie, username),
      onSpotifyLogout: () => latest.current.onSpotifyLogout(),
      onKugouLogin: (cookie, username) => latest.current.onKugouLogin(cookie, username),
      onKugouLogout: () => latest.current.onKugouLogout(),
      onSodaLogin: (cookie, username) => latest.current.onSodaLogin(cookie, username),
      onSodaLogout: () => latest.current.onSodaLogout(),
      onRemoveQueueItem: (index) => latest.current.onRemoveQueueItem(index),
      onMoveQueueItem: (from, to) => latest.current.onMoveQueueItem(from, to),
      onLoginClick: (platform) => latest.current.onLoginClick(platform),
      onNeteaseLoginClick: () => latest.current.onNeteaseLoginClick(),
      onQQLoginClick: () => latest.current.onQQLoginClick(),
      onSearchClick: () => latest.current.onSearchClick(),
      onRemoteClick: () => latest.current.onRemoteClick(),
      onSettingsClick: () => latest.current.onSettingsClick(),
      onProfileClick: (platform, initialTab) => latest.current.onProfileClick(platform, initialTab),
      onOpenPlayer: () => latest.current.onOpenPlayer(),
      onExitDesktopMode: () => latest.current.onExitDesktopMode(),
    }
  }, [])

  // 设置面板常驻挂载，关闭回调需稳定引用以配合 memo 跳过播放中的重渲染
  const closeSettings = useCallback(() => setShowSettings(false), [])

  // 歌曲详情 / 相似歌曲弹窗关闭回调需稳定引用以配合 memo 跳过播放中的重渲染
  const closeSongDetail = useCallback(() => setShowSongDetail(false), [])
  const closeSimilarSongs = useCallback(() => setShowSimilarSongs(false), [])

  // 歌手/专辑弹窗选中歌曲需先清空导航栈（dismiss*），与 handleSongSelect 内部
  // 仅 setShow*Detail(false) 不同，不能直接复用 viewCallbacks.onSongSelect。
  // 经 handleSongSelectRef 取最新实现，避免 [] 依赖闭包捕获过期函数。
  const handleArtistDetailSongSelect = useCallback((song: Song, playlist?: Song[]) => {
    dismissArtistDetail()
    void handleSongSelectRef.current(song, playlist)
  }, [])
  const handleAlbumDetailSongSelect = useCallback((song: Song, playlist?: Song[]) => {
    dismissAlbumDetail()
    void handleSongSelectRef.current(song, playlist)
  }, [])

  // ===== 弹窗稳定回调（latest-ref 模式）=====
  // ProfileView/AlbumDetailModal/PlaylistPanel 已包 memo；这些回调若每次渲染新建会击穿
  // memo 导致 1Hz 无关重渲染。这里用 latest-ref 暴露一次性创建的稳定引用，行为与内联等价。
  const closeProfileRef = useRef<() => void>(() => undefined)
  const closeAlbumDetailRef = useRef<() => void>(() => undefined)
  const closePlaylistRef = useRef<() => void>(() => undefined)
  const profileSwitchPlatformRef = useRef<() => void>(() => undefined)
  const profileLogoutRef = useRef<(platform: MusicPlatform) => void>(() => undefined)
  const smartReorderRef = useRef<() => void>(() => undefined)
  const playlistSongSelectRef = useRef<(index: number) => void>(() => undefined)
  closeProfileRef.current = () => setShowProfile(false)
  closeAlbumDetailRef.current = () => closeAlbumDetail()
  closePlaylistRef.current = () => setShowPlaylist(false)
  profileSwitchPlatformRef.current = () => {
    // 已登录平台间轮换（Apple 登录态由 token 判定；被隐藏的平台不参与轮换）
    const order: MusicPlatform[] = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda']
    const loggedIn = {
      netease: neteaseLoggedIn,
      qq: qqLoggedIn,
      apple: appleLoggedIn,
      spotify: spotifyLoggedIn,
      kugou: kugouLoggedIn,
      soda: sodaLoggedIn,
    } as Record<MusicPlatform, boolean>
    const candidates = order.filter(platform => loggedIn[platform] && isPlatformVisible(platform))
    if (candidates.length <= 1) return
    const next = candidates[(candidates.indexOf(profileInitialPlatform) + 1) % candidates.length] || candidates[0]
    setProfileInitialPlatform(next)
  }
  profileLogoutRef.current = (platform) => {
    if (platform === 'netease') handleNeteaseLogout()
    else if (platform === 'qq') handleQQLogout()
    else if (platform === 'apple') handleAppleLogout()
    else if (platform === 'spotify') handleSpotifyLogout()
    else if (platform === 'kugou') handleKugouLogout()
    else if (platform === 'soda') handleSodaLogout()
  }
  smartReorderRef.current = () => { void handleSmartReorder() }
  playlistSongSelectRef.current = (index) => {
    const song = playlistRef.current[index]
    if (!song) return
    audioPlayer.cancelTransition('playlist song selected', false)
    bumpQueueRevision()
    currentIndexRef.current = index
    setCurrentIndex(index)
    void loadAndPlaySong(song, index, playlistRef.current)
    setShowPlaylist(false)
  }
  const stableDialogCallbacks = useMemo(() => ({
    closeProfile: () => closeProfileRef.current(),
    closeAlbumDetail: () => closeAlbumDetailRef.current(),
    closePlaylist: () => closePlaylistRef.current(),
    switchProfilePlatform: () => profileSwitchPlatformRef.current(),
    logout: (platform: MusicPlatform) => profileLogoutRef.current(platform),
    smartReorder: () => smartReorderRef.current(),
    playlistSongSelect: (index: number) => playlistSongSelectRef.current(index),
  }), [])

  return (
    <>
      {/* 自定义窗口标题栏 */}
      <TitleBar />

      {/* 遥控器虚拟鼠标 overlay（顶层挂载，任何模式下都可用） */}
      <RemoteCursor />

      {/* 首次平台登录风险提示（自包含，首次登录后弹出一次） */}
      <PlatformLoginNotice playerTheme={playerTheme} />

      {/* OOBE 1（主题/隐私/免责引导）：首次启动且未完成时自动弹出 */}
      {OOBE_ENABLED && (
        <Suspense fallback={null}>
          <LazyOobeGuide playerTheme={playerTheme} enabled={OOBE_ENABLED} />
        </Suspense>
      )}

      {/* 全局弹层：遥控器 / 歌曲详情（任何模式下都能打开） */}
      <AnimatePresence>
        {showRemote && (
          <Suspense fallback={null}>
            <LazyRemoteControlModal
              onClose={() => setShowRemote(false)}
              playerTheme={playerTheme}
            />
          </Suspense>
        )}
        {showSongDetail && songDetailSong && (
          <Suspense fallback={null}>
            <LazySongDetailModal
              song={songDetailSong}
              onClose={closeSongDetail}
              playerTheme={playerTheme}
              onPlayNow={viewCallbacks.onSongSelect}
              onOpenPlaylist={(id, platform) => { void handleOpenPlaylistFromDetail(id, platform) }}
            />
          </Suspense>
        )}
        {showSimilarSongs && similarSongsSource && (
          <SimilarSongsPanel
            song={similarSongsSource}
            onClose={closeSimilarSongs}
            onPlayNow={viewCallbacks.onSongSelect}
            onPlayNext={viewCallbacks.onPlayNext}
            playerTheme={playerTheme}
          />
        )}
        {detailPlaylist && (
          <LazyPlaylistDetailPanel
            show
            overlayZ={95}
            playerTheme={playerTheme}
            playlist={detailPlaylist.playlist}
            songs={detailPlaylist.songs}
            loading={detailPlaylistLoading}
            onClose={() => setDetailPlaylist(null)}
            onSongSelect={(song, songs) => { void handleSongSelect(song, songs) }}
            currentPlatform={detailPlaylist.playlist.platform || 'netease'}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            onOpenArtist={handleOpenArtist}
            onOpenAlbum={handleOpenAlbum}
            onPlayNext={handlePlayNext}
            onAddToFavorites={handleAddToFavorites}
            onRemoveFromFavorites={handleRemoveFromFavorites}
            onAddToPlaylist={handleAddToPlaylist}
            onViewComments={handleViewComments}
            onCopyInfo={handleCopyInfo}
            userPlaylists={playbackContextPlaylists}
          />
        )}
      </AnimatePresence>

      {/* GPU 设置变更确认横幅 */}
      {pendingGpuChange && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[99999] w-[min(92vw,560px)] pointer-events-auto">
          <div className={`rounded-xl border p-4 shadow-2xl ${playerTheme === 'dark' ? 'bg-[#0b1220]/95 border-red-500/40' : 'bg-white/95 border-red-500/40'}`}>
            <div className={`text-sm font-medium leading-relaxed ${playerTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {pendingGpuChange.type === 'preference'
                ? '您在此前修改过 GPU 加速设备，若无异常请点击确认，否则将在 15 秒后自动恢复为系统默认显卡'
                : '您在此前关闭了 GPU 加速，若无异常请点击确认，否则将在 15 秒后自动打开 GPU 加速'}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => void confirmGpuChange()}
                className="rounded-lg bg-red-500 hover:bg-red-600 px-5 py-2 text-sm font-semibold text-white transition-colors"
              >
                确认
              </button>
              <button
                onClick={() => void revertGpuChange()}
                className={`rounded-lg px-5 py-2 text-sm transition-colors ${playerTheme === 'dark' ? 'text-white/70 hover:text-white bg-white/10' : 'text-gray-600 hover:text-gray-900 bg-black/5'}`}
              >
                取消（{gpuConfirmCountdown}）
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 固定背景层 - 防止切换时白屏 */}
      <div className="fixed inset-0 bg-black" />
      
      {/* 全局更新提示（任何视图模式可见；分客户端显示） */}
      <UpdatePrompt playerTheme={playerTheme} />
      
      <Suspense fallback={null}><AnimatePresence initial={false} mode="sync" presenceAffectsLayout={false}>
        {/* 桌面模式 */}
        {viewMode === 'explore' ? (
          <motion.div
            key="explore-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 h-full w-full"
            style={{ willChange: 'transform, opacity', backfaceVisibility: 'hidden', zIndex: 2 }}
          >
            <LazyExploreView
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              currentSong={currentSong}
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={duration}
              volume={volume}
              currentLyric={currentMiniLyric}
              accentColor={dominantColor || '#8b5cf6'}
              playerTheme={playerTheme}
              authRevision={authRevision}
              neteaseLoggedIn={neteaseLoggedIn}
              neteaseUsername={neteaseUsername}
              neteaseAvatar={neteaseAvatar}
              neteaseUserId={neteaseUserId}
              neteaseVip={neteaseVip}
              qqLoggedIn={qqLoggedIn}
              qqUsername={qqUsername}
              qqAvatar={qqAvatar}
              qqUserId={qqUserId}
              qqVip={qqVip}
              appleLoggedIn={appleLoggedIn}
              appleUsername={appleUsername}
              appleAvatar={appleAvatar}
              appleStorefront={appleStorefront}
              spotifyLoggedIn={spotifyLoggedIn}
              spotifyUsername={spotifyUsername}
              spotifyAvatar={spotifyAvatar}
              kugouLoggedIn={kugouLoggedIn}
              kugouUsername={kugouUsername}
              kugouAvatar={kugouAvatar}
              sodaLoggedIn={sodaLoggedIn}
              sodaUsername={sodaUsername}
              sodaAvatar={sodaAvatar}
              onLoginClick={(platform) => {
                // Apple 走独立 token 登录面板；网易云/QQ 走原有扫码/密钥登录
                if (platform === 'apple') {
                  setShowAppleLogin(true)
                  return
                }
                setLoginPlatform(platform)
                setShowLogin(true)
              }}
              onProfileClick={(platform) => {
                // Apple 账号入口在 Apple 登录面板内（含资料与退出登录）
                if (platform === 'apple') {
                  setShowAppleLogin(true)
                  return
                }
                setProfileInitialPlatform(platform)
                setProfileInitialTab('created')
                setShowProfile(true)
              }}
              onSearchClick={viewCallbacks.onSearchClick}
              onRemoteClick={viewCallbacks.onRemoteClick}
              onPlayPause={viewCallbacks.onPlayPause}
              onNext={viewCallbacks.onNext}
              onPrevious={viewCallbacks.onPrevious}
              onSeek={viewCallbacks.onSeek}
              onVolumeChange={viewCallbacks.onVolumeChange}
              onOpenPlayer={viewCallbacks.onOpenPlayer}
              onOpenArtist={viewCallbacks.onOpenArtist}
              onOpenAlbum={viewCallbacks.onOpenAlbum}
              onPlayNext={viewCallbacks.onPlayNext}
              onAddToFavorites={viewCallbacks.onAddToFavorites}
              onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
              onAddToPlaylist={viewCallbacks.onAddToPlaylist}
              onViewComments={viewCallbacks.onViewComments}
              onCopyInfo={viewCallbacks.onCopyInfo}
            />

          </motion.div>
        ) : viewMode === 'desktop' ? (
          <motion.div
            key="desktop-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 w-full h-full"
            style={{ willChange: 'transform, opacity', backfaceVisibility: 'hidden', zIndex: 2 }}
          >
            <LazyDesktopView
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              currentSong={currentSong}
              isPlaying={isPlaying}
              currentTime={currentTime}
              duration={duration}
              lyrics={lyrics}
              playbackQueue={playlist}
              currentIndex={currentIndex}
              volume={volume}
              onVolumeChange={viewCallbacks.onVolumeChange}
              onRemoveQueueItem={viewCallbacks.onRemoveQueueItem}
              onMoveQueueItem={viewCallbacks.onMoveQueueItem}
              onPlayPause={viewCallbacks.onPlayPause}
              onNext={viewCallbacks.onNext}
              onPrevious={viewCallbacks.onPrevious}
              neteaseLoggedIn={neteaseLoggedIn}
              neteaseUserId={neteaseUserId}
              qqLoggedIn={qqLoggedIn}
              qqUserId={qqUserId}
              neteaseVip={neteaseVip}
              qqVip={qqVip}
              appleLoggedIn={appleLoggedIn}
              appleUsername={appleUsername}
              onAppleLoginClick={() => setShowAppleLogin(true)}
              onAppleLogout={handleAppleLogout}
              spotifyLoggedIn={spotifyLoggedIn}
              spotifyUserId={spotifyUserId}
              spotifyUsername={spotifyUsername}
              kugouLoggedIn={kugouLoggedIn}
              kugouUserId={kugouUserId}
              kugouUsername={kugouUsername}
              sodaLoggedIn={sodaLoggedIn}
              sodaUserId={sodaUserId}
              sodaUsername={sodaUsername}
              onNeteaseLogin={viewCallbacks.onNeteaseLogin}
              onQQLogin={viewCallbacks.onQQLogin}
              onSpotifyLogin={viewCallbacks.onSpotifyLogin}
              onKugouLogin={viewCallbacks.onKugouLogin}
              onSodaLogin={viewCallbacks.onSodaLogin}
              onPlayNext={viewCallbacks.onPlayNext}
              onAddToFavorites={viewCallbacks.onAddToFavorites}
              onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
              onAddToPlaylist={viewCallbacks.onAddToPlaylist}
              onViewComments={viewCallbacks.onViewComments}
              onOpenArtist={viewCallbacks.onOpenArtist}
              onOpenAlbum={viewCallbacks.onOpenAlbum}
              onCopyInfo={viewCallbacks.onCopyInfo}
              onExitDesktopMode={viewCallbacks.onExitDesktopMode}
              onRemoteClick={viewCallbacks.onRemoteClick}
            />
          </motion.div>
        ) : (
          /* 简约模式 */
          <motion.div
            key="minimal-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 h-screen w-full flex items-center justify-center overflow-hidden"
            style={{ willChange: 'transform, opacity', backfaceVisibility: 'hidden', zIndex: 2 }}
          >
      {/* Toast通知 - 支持显示多个Toast堆叠 */}
      <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[100000] flex flex-col gap-3 pointer-events-none">
        {toasts.map((toast, index) => (
          <Toast 
            key={toast.id}
            show={true}
            message={toast.message}
            type={toast.type}
            accentColor={toast.accentColor}
            style={{ 
              animationDelay: `${index * 50}ms` // 每个Toast延迟50ms出现，产生层叠效果
            }}
          />
        ))}
      </div>

      {/* 默认背景 - 始终存在 */}
      <div 
        className="absolute inset-0"
        style={{
          background: getBackgroundStyle()
        }}
      />

      {/* The outgoing cover remains mounted until the decoded incoming cover overlays it. */}
      <div className="absolute inset-0">
            <PulsingCrossfadeBackground
              coverUrl={displayCoverUrl}
              transitionFromUrl={transitionFromTrack?.coverUrl}
              transitionToUrl={transitionToTrack?.coverUrl}
              isTransitioning={isVisualTransitioning}
              transitionProgress={transitionProgress}
              pulseStore={audioPulseStore}
              backgroundEffect={backgroundEffect}
              backgroundBlur={backgroundBlur}
            />
            {/* 娓愬彉閬濞撴劕褰夐柆顔惧兊 */}
            <div 
              className="absolute inset-0 bg-gradient-to-b transition-all duration-500"
              style={{
                backgroundImage: playerTheme === 'dark'
                  ? backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.05), rgba(0,0,0,0.05), rgba(0,0,0,0.05))'  // 深色透明模式增加5%白色叠加
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0.55), rgba(0,0,0,0.7))'  // 深色模糊：中等压暗
                    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.6) 100%)'  // 深色沉浸：强压暗+渐变
                  : backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0.05), rgba(255,255,255,0.05))'  // 浅色透明模式增加5%黑色叠加
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(250,250,248,0.42), rgba(250,250,248,0.32), rgba(250,250,248,0.46))'  // 浅色模糊：明显白雾
                    : 'linear-gradient(135deg, rgba(250,250,248,0.3) 0%, rgba(250,250,248,0.52) 50%, rgba(250,250,248,0.4) 100%)'  // 浅色沉浸：强白雾+渐变
              }}
            />
            {/* 沉浸模式额外效果 - 边缘渐变和光晕 */}
            {backgroundEffect === 'immersive' && (
              <>
                <div
                  className="absolute inset-0"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'radial-gradient(circle at 30% 40%, rgba(255,255,255,0.15) 0%, transparent 50%)'
                      : 'radial-gradient(circle at 30% 40%, rgba(255,255,255,0.35) 0%, transparent 50%)',
                  }}
                />
                <div
                  className="absolute inset-0"
                  style={{
                    boxShadow: playerTheme === 'dark'
                      ? 'inset 0 0 200px rgba(0,0,0,0.3)'
                      : 'inset 0 0 200px rgba(0,0,0,0.08)',
                  }}
                />
              </>
            )}
      </div>

      {/* 鍐呭閸愬懎顔愮仦?*/}
      <div className="relative z-10 w-full h-full flex flex-col">

        {/* 搜索面板 */}
        {/* 设置面板 */}
        {/* cast props to any to satisfy prop mismatch between App and SettingsPanel typings */}
        {/* 设置面板保持挂载：关闭仅隐藏主面板，内部的首页自定义/模糊度等
            子弹窗链路（HomeCustomizeModal -> BlurAdjustModal）依赖组件存活。 */}
        <Suspense fallback={null}>
          <LazySettingsPanel {...({
          show: showSettings,
          onClose: closeSettings,
          onOpenRemote: () => setShowRemote(true),
          neteaseLoggedIn,
          neteaseUsername,
          onNeteaseLogin: viewCallbacks.onNeteaseLogin,
          onNeteaseLogout: viewCallbacks.onNeteaseLogout,
          qqLoggedIn,
          qqUsername,
          neteaseVip,
          qqVip,
          onQQLogin: viewCallbacks.onQQLogin,
          onQQLogout: viewCallbacks.onQQLogout,
          appleLoggedIn,
          appleUsername,
          onAppleLogin: handleAppleLogin,
          onAppleLogout: handleAppleLogout,
          spotifyLoggedIn,
          spotifyUsername,
          onSpotifyLogin: viewCallbacks.onSpotifyLogin,
          onSpotifyLogout: viewCallbacks.onSpotifyLogout,
          kugouLoggedIn,
          kugouUsername,
          onKugouLogin: viewCallbacks.onKugouLogin,
          onKugouLogout: viewCallbacks.onKugouLogout,
          sodaLoggedIn,
          sodaUsername,
          onSodaLogin: viewCallbacks.onSodaLogin,
          onSodaLogout: viewCallbacks.onSodaLogout,
          playerTheme,
            } as any)} />
        </Suspense>

        {/* 调音室（统一通过适配层渲染：custom 模式返回引擎自带调音室，generic 模式返回通用调音室） */}
        <AnimatePresence>
          {showMixingStudio && (
            <Suspense fallback={null}>
              {engineAdapterRef.current.renderStudio({
                onClose: () => setShowMixingStudio(false),
                playerTheme,
                anchorRect: mixingStudioAnchorRef.current,
                engineVersion: audioEngineVersion,
                onSwitchEngine: switchAudioEngine,
                availableEngines: getAvailableEngines(),
                sourceUrl: audioPlayer.audioElement?.src || undefined,
                sourceDuration: audioPlayer.audioElement?.duration || undefined,
              })}
            </Suspense>
          )}
        </AnimatePresence>

        {/* 引擎切换右上角小弹窗（2s 后淡出） */}
        <AnimatePresence>
          {engineSwitchToast && (
            <motion.div
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              transition={{ duration: 0.25 }}
              className="fixed top-16 right-6 z-[9998] pointer-events-none"
            >
              <div
                className="px-4 py-2.5 rounded-2xl text-sm font-medium shadow-2xl"
                style={{
                  background: 'rgba(10, 12, 20, 0.55)',
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: '#fff',
                }}
              >
                {engineSwitchToast}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* #10 Gapless 方案底部弹窗（切歌完成时提示本次衔接方案，2.5s 后淡出） */}
        <GaplessModeToast message={gaplessModeToast} playerTheme={playerTheme} />
        
        {/* 主内容区 */}
        <div className="relative flex-1 flex items-center justify-center overflow-hidden">
          {/* 首页包含整屏壁纸、多个 backdrop-filter 与独立合成层。这里不能使用
              AnimatePresence 保留退出节点：冷启动首次播放时 Chromium 偶发把首页
              合成快照永久留在播放页上。直接替换节点可以确保首页当帧卸载；新页面
              自身的 initial/animate 仍提供完整入场过渡。 */}
          {!currentSong || showHome ? (
            /* 有歌词时使用两列布局，左侧封面右侧歌词 */
            <motion.div
              key="minimal-home-surface"
              initial={{ opacity: 0, y: -12, scale: 1.01, filter: 'blur(6px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{
                opacity: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
                y: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
                scale: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
                filter: { duration: 0.38, ease: [0.22, 1, 0.36, 1] },
              }}
              className="absolute inset-0"
              style={{ willChange: 'transform, opacity, filter' }}
            >
            <LazyHomeView
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              neteaseLoggedIn={neteaseLoggedIn}
              neteaseUsername={neteaseUsername}
              neteaseAvatar={neteaseAvatar}
              neteaseUserId={neteaseUserId}
              neteaseVip={neteaseVip}
              onNeteaseLogout={viewCallbacks.onNeteaseLogout}
              qqLoggedIn={qqLoggedIn}
              qqUsername={qqUsername}
              qqAvatar={qqAvatar}
              qqUserId={qqUserId}
              qqVip={qqVip}
              onQQLogout={viewCallbacks.onQQLogout}
              appleLoggedIn={appleLoggedIn}
              appleUsername={appleUsername}
              appleAvatar={appleAvatar}
              appleStorefront={appleStorefront}
              appleEmail={appleEmail}
              onAppleLoginClick={() => setShowAppleLogin(true)}
              onAppleLogout={handleAppleLogout}
              spotifyLoggedIn={spotifyLoggedIn}
              spotifyUsername={spotifyUsername}
              spotifyAvatar={spotifyAvatar}
              spotifyUserId={spotifyUserId}
              kugouLoggedIn={kugouLoggedIn}
              kugouUsername={kugouUsername}
              kugouAvatar={kugouAvatar}
              kugouUserId={kugouUserId}
              sodaLoggedIn={sodaLoggedIn}
              sodaUsername={sodaUsername}
              sodaAvatar={sodaAvatar}
              sodaUserId={sodaUserId}
              onNeteaseLoginClick={viewCallbacks.onNeteaseLoginClick}
              onQQLoginClick={viewCallbacks.onQQLoginClick}
              onAppleProfileClick={() => setShowAppleLogin(true)}
              onLoginClick={(platform) => {
                // 新平台（Spotify/酷狗/汽水）：走通用登录弹窗（LoginView 委托到对应面板）
                if (platform === 'apple') { setShowAppleLogin(true); return }
                setLoginPlatform(platform)
                setShowLogin(true)
              }}
              onSearchClick={viewCallbacks.onSearchClick}
              onRemoteClick={viewCallbacks.onRemoteClick}
              onSettingsClick={viewCallbacks.onSettingsClick}
              onProfileClick={viewCallbacks.onProfileClick}
              onOpenArtist={viewCallbacks.onOpenArtist}
              onOpenAlbum={viewCallbacks.onOpenAlbum}
              onPlayNext={viewCallbacks.onPlayNext}
              onAddToFavorites={viewCallbacks.onAddToFavorites}
              onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
              onAddToPlaylist={viewCallbacks.onAddToPlaylist}
              onViewComments={viewCallbacks.onViewComments}
              onCopyInfo={viewCallbacks.onCopyInfo}
              accentColor={dominantColor || '#3B82F6'}
              currentSong={currentSong}
              playerTheme={playerTheme}
            />
            </motion.div>
          ) : (
            <motion.div
              key="minimal-playback-surface"
              initial={{ opacity: 0, y: 24, scale: 0.985, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.46, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 w-full h-full flex flex-col"
              style={{ willChange: 'transform, opacity, filter' }}
              data-waveforge-playback-page="true"
            >
              <LazyPlaybackRadialMenu
                song={currentSong}
                accentColor={dominantColor || '#3B82F6'}
                liked={currentSongLiked}
                userPlaylists={playbackContextPlaylists}
                playerTheme={playerTheme}
                onPlayNow={(song) => { void handleSongSelect(song, playlist) }}
                onPlayNext={handlePlayNext}
                onToggleFavorite={handlePlaybackToggleFavorite}
                onAddToFavorites={(song) => { void handleAddToFavorites(song) }}
                onRemoveFromFavorites={(song) => { void handleRemoveFromFavorites(song) }}
                onAddToPlaylist={(song, playlistId) => { void handleAddToPlaylist(song, playlistId) }}
                onViewComments={handleViewComments}
                onViewAlbum={handlePlaybackViewAlbum}
                onViewArtist={handlePlaybackViewArtist}
                onCopyInfo={handleCopyInfo}
                onContextMenuOpen={handlePlaybackContextMenuOpen}
              />
              {/* 沉浸模式控制按钮 - 右上角（看歌模式隐藏，看歌自带右下按钮组） */}
              {lyricDisplayMode !== 'video' && (
                <LazyImmersiveControls
                  onHomeClick={handlePlayerHome}
                onOpenMixingStudio={(anchorRect) => {
                  if (anchorRect) {
                    mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                  }
                  setShowMixingStudio(true)
                }}
                onTranslationToggle={handleTranslationToggle}
                translationEnabled={translationEnabled}
                hasTranslation={hasTranslation}
                onRomanToggle={handleRomanToggle}
                romanEnabled={romanEnabled}
                hasRoman={hasRoman}
                playerTheme={playerTheme}
                isPureMusic={isPureMusic}
              />
              )}

              {!isPureMusic && (
                <>
                  <button
                    type="button"
                    aria-label="打开歌词显示样式"
                    className="fixed top-0 left-1/2 -translate-x-1/2 w-32 h-8 z-50 appearance-none border-0 bg-transparent p-0"
                    onClick={() => {
                      setShowLyricModePanel(true)
                      setShowLyricModeCustomize(false)
                      setShowLyricModeArrowHint(false)
                    }}
                    onMouseEnter={() => setIsLyricModeTopHovered(true)}
                    onMouseLeave={() => setIsLyricModeTopHovered(false)}
                  >
                    <AnimatePresence>
                      {(isLyricModeTopHovered || showLyricModeArrowHint) && !showLyricModePanel && (
                        <motion.div
                          initial={{ opacity: 0, y: -10 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -10 }}
                          className={`absolute top-0 left-1/2 -translate-x-1/2 backdrop-blur-md rounded-b-2xl border border-t-0 transition-colors ${playerTheme === 'dark' ? 'bg-white/10 border-white/20 hover:bg-white/20' : 'bg-black/5 border-black/15 hover:bg-black/10'}`}
                          style={{ width: '200px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                          whileHover={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.12)' }}
                          whileTap={{ scale: 0.98 }}
                        >
                          <motion.div
                            animate={{
                              y: [0, 2, 0],
                              opacity: showLyricModeArrowHint ? [1, 0.5, 1] : 1,
                            }}
                            transition={{
                              y: { duration: 1, repeat: Infinity },
                              opacity: showLyricModeArrowHint ? { duration: 0.5, repeat: Infinity } : { duration: 0 },
                            }}
                          >
                            <svg className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black/70'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                            </svg>
                          </motion.div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </button>

                  <AnimatePresence
                    onExitComplete={() => {
                      setShowLyricModeArrowHint(true)
                      window.setTimeout(() => setShowLyricModeArrowHint(false), 1800)
                    }}
                  >
                    {showLyricModePanel && (
                      <motion.div
                        initial={{ y: '-100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '-100%' }}
                        transition={{ type: 'spring', damping: 25, stiffness: 200 }}
                        className="fixed top-0 left-0 right-0 z-40"
                        onClick={(event) => {
                          if (!showLyricModeCustomize) return
                          if ((event.target as HTMLElement).closest('[data-lyric-mode-customize]')) return
                          setShowLyricModeCustomize(false)
                        }}
                      >
                        <div className={`relative h-[22vh] backdrop-blur-xl overflow-hidden ${playerTheme === 'dark' ? 'bg-black/40' : 'bg-white/55'}`}>
                          <div className="h-full flex flex-col items-center justify-center px-8 py-6">
                            <div className="w-full max-w-5xl flex flex-col items-center h-full">
                              <h2 className={`text-xl font-bold mb-4 text-center ${playerTheme === 'dark' ? 'text-white' : 'text-black/90'}`}>歌词显示</h2>
                              <div
                                className="grid w-full gap-3"
                                style={{ gridTemplateColumns: `repeat(${effectiveVisibleLyricModes.length}, minmax(0, 1fr))` }}
                              >
                                {([
                                  ['modern', '现代', 'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)'],
                                  ['immersive', '沉浸式', 'linear-gradient(135deg, #1e3a5f 0%, #0f1c2e 50%, #0a0a0a 100%)'],
                                  ['wallpaper', '墙纸', `repeating-linear-gradient(0deg, rgba(255,255,255,.055) 0 1px, transparent 1px 18px), linear-gradient(135deg, ${dominantColor || '#6c5cff'} 0%, #18171c 58%, #09090b 100%)`],
                                  ['glorious', '辉煌', `linear-gradient(118deg, #080713 0%, ${dominantColor || '#6f5cff'} 50%, #090911 78%, #101522 100%)`],
                                  ['multidimensional', '多维', `linear-gradient(145deg, #05060c 0%, ${dominantColor || '#6657ff'} 48%, #0b1b2a 72%, #030409 100%)`],
                                  ['modeng', '摩登', `linear-gradient(120deg, #3a3a3c 0%, #232325 45%, #101012 100%)`],
                                  ['video', '看歌', `linear-gradient(120deg, #f8a5c2 0%, #fb7299 45%, #2d1b3d 100%)`],
                                ] as const)
                                  .filter(([mode]) => effectiveVisibleLyricModes.includes(mode))
                                  .map(([mode, label, background]) => (
                                    <motion.button
                                      type="button"
                                      key={mode}
                                      whileHover={{ scale: 1.05 }}
                                      whileTap={{ scale: 0.95 }}
                                      onClick={() => handleLyricDisplayModeChange(mode)}
                                      className="relative h-24 min-w-0 rounded-xl overflow-hidden cursor-pointer border-2 transition-all"
                                      style={{
                                        background,
                                        borderColor: lyricDisplayMode === mode ? '#fff' : 'rgba(255,255,255,0.2)',
                                        boxShadow: lyricDisplayMode === mode ? `0 0 18px ${(dominantColor || '#ffffff')}35` : 'none',
                                      }}
                                    >
                                      <div className="absolute inset-0 flex items-center justify-center">
                                        <span className="text-white font-medium text-base">{label}</span>
                                      </div>
                                      {lyricDisplayMode === mode && (
                                        <div className="absolute top-2 right-2 bg-white/20 backdrop-blur-sm px-2 py-1 rounded-full text-xs text-white">
                                          当前
                                        </div>
                                      )}
                                    </motion.button>
                                  ))}
                              </div>
                            </div>
                          </div>
                          <button
                            type="button"
                            aria-label="自定义歌词模式显示"
                            title="显示 / 隐藏歌词模式"
                            data-lyric-mode-customize
                            onClick={(event) => {
                              event.stopPropagation()
                              setShowLyricModeCustomize((value) => !value)
                            }}
                            className={`absolute bottom-4 right-8 z-30 flex h-9 w-9 items-center justify-center rounded-full border transition-[background-color,color] ${playerTheme === 'dark' ? 'border-white/15 bg-white/[0.08] text-white/85 hover:bg-white/[0.16] hover:text-white' : 'border-black/10 bg-black/[0.06] text-black/70 hover:bg-black/[0.12] hover:text-black'}`}
                          >
                            <Settings className="h-[18px] w-[18px]" />
                          </button>
                        </div>

                        <div className="flex justify-center -mt-px">
                          <button
                            onClick={() => {
                              setShowLyricModePanel(false)
                              setShowLyricModeCustomize(false)
                            }}
                            className={`backdrop-blur-md rounded-b-2xl border border-t-0 transition-colors ${playerTheme === 'dark' ? 'bg-white/10 border-white/20 hover:bg-white/20' : 'bg-black/5 border-black/15 hover:bg-black/10'}`}
                            style={{ width: '200px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          >
                            <svg className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black/70'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path d="M5 15l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                            </svg>
                          </button>
                        </div>

                        <AnimatePresence>
                          {showLyricModeCustomize && (
                            <motion.div
                              key="lyric-mode-customize-popover"
                              initial={{ opacity: 0, y: -6, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -6, scale: 0.98 }}
                              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                              data-lyric-mode-customize
                              className={`absolute right-8 top-[calc(22vh+24px)] z-40 w-64 rounded-2xl border p-2 backdrop-blur-2xl ${playerTheme === 'dark' ? 'border-white/15 bg-[#0c0e1a]/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.55)]' : 'border-black/10 bg-white/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.15)]'}`}
                              style={{ willChange: 'transform, opacity' }}
                            >
                              <p className={`px-2 pb-1.5 pt-1 text-[11px] font-semibold tracking-[0.08em] ${playerTheme === 'dark' ? 'text-white/55' : 'text-black/50'}`}>显示 / 隐藏歌词模式</p>
                              {ALL_LYRIC_MODES.map((mode) => {
                                const isVisible = effectiveVisibleLyricModes.includes(mode)
                                const isCurrent = lyricDisplayMode === mode
                                // 现代模式始终显示；当前模式与最后一个可见模式不可隐藏
                                const locked = isCurrent || mode === 'modern' || (isVisible && effectiveVisibleLyricModes.length <= 1)
                                return (
                                  <button
                                    key={mode}
                                    type="button"
                                    disabled={locked}
                                    onClick={() => toggleLyricModeVisibility(mode)}
                                    className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${playerTheme === 'dark' ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
                                  >
                                    <span className="flex flex-col leading-tight">
                                      <span className={`text-sm font-medium ${playerTheme === 'dark' ? 'text-white/95' : 'text-black/85'}`}>{LYRIC_MODE_NAMES[mode]}</span>
                                      <span className={`mt-0.5 text-[10px] ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/40'}`}>
                                        {mode === 'modern' ? '始终显示' : (isCurrent ? '当前模式' : (isVisible ? '显示中' : '已隐藏'))}
                                      </span>
                                    </span>
                                    <span
                                      aria-hidden="true"
                                      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${isVisible ? 'bg-emerald-400/80' : playerTheme === 'dark' ? 'bg-white/15' : 'bg-black/15'}`}
                                    >
                                      <span
                                        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200 ${isVisible ? 'left-[18px]' : 'left-0.5'}`}
                                      />
                                    </span>
                                  </button>
                                )
                              })}
                              <p className={`px-2 pb-1 pt-1.5 text-[10px] leading-snug ${playerTheme === 'dark' ? 'text-white/35' : 'text-black/35'}`}>
                                现代模式始终显示；当前模式与最后一个可见模式不可隐藏
                              </p>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}

              {false && !isPureMusic && (
                <motion.div
                  initial={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
                  className="fixed top-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 rounded-full border border-white/15 bg-black/30 p-1 backdrop-blur-xl shadow-[0_8px_28px_rgba(0,0,0,0.28)]"
                >
                  <span className="px-3 text-xs font-medium text-white/60">歌词显示</span>
                  {([
                    ['modern', '现代'],
                    ['immersive', '沉浸式'],
                    ['wallpaper', '墙纸'],
                    ['glorious', '辉煌'],
                    ['multidimensional', '多维'],
                  ] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      onClick={() => handleLyricDisplayModeChange(mode)}
                      className="rounded-full px-3 py-1.5 text-xs font-medium transition-colors"
                      style={{
                        backgroundColor: lyricDisplayMode === mode ? (dominantColor || '#ffffff') : 'transparent',
                        color: lyricDisplayMode === mode ? '#fff' : 'rgba(255,255,255,0.72)',
                        boxShadow: lyricDisplayMode === mode ? `0 0 16px ${(dominantColor || '#ffffff')}40` : 'none',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </motion.div>
              )}

              {(() => {
            // 播放器事件监听，处理播放状态变化
            return isPureMusic ? (
              /* 纯音乐愭椂灞呬腑显示 */
              <motion.div
                key="no-lyrics-player"
                initial={{ opacity: 0, filter: 'blur(10px)' }}
                animate={{ opacity: 1, filter: 'blur(0px)' }}
                exit={{ opacity: 0, filter: 'blur(10px)' }}
                transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                className="flex-1 flex flex-col items-center justify-center gap-8"
              >
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                    className="flex w-full flex-col items-center gap-5 px-6"
                  >
                    <AlbumCoverPlayer
                      coverUrl={displayCoverUrl}
                      isPlaying={isPlaying}
                      dominantColor={dominantColor}
                      trackId={currentSong.id || currentSong.mid}
                      isTransitioning={isVisualTransitioning}
                      transitionProgress={transitionProgress}
                      transitionFromTrack={transitionFromTrack}
                      transitionToTrack={transitionToTrack}
                      pulseStore={audioPulseStore}
                    />
                    
                    {/* 歌曲信息 - 过渡时双层淡入淡出 */}
                    <div className="relative w-full max-w-4xl space-y-3 text-center">
                      {isVisualTransitioning && transitionProgress > 0 && transitionFromTrack && transitionToTrack ? (
                        // 过渡模式：双层叠加
                        <>
                          {/* 底层：旧歌曲信息 */}
                          <div className="absolute inset-0" style={{ opacity: 1 - transitionProgress }}>
                            <h1 className={`text-4xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                              {transitionFromTrack.title}
                            </h1>
                            <p className={`text-xl ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                              {transitionFromTrack.artist}
                            </p>
                          </div>
                          {/* 顶层：新歌曲信息 */}
                          <div className="relative" style={{ opacity: transitionProgress }}>
                            <h1 className={`text-4xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                              {transitionToTrack.title}
                            </h1>
                            <p className={`text-xl ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                              {transitionToTrack.artist}
                            </p>
                          </div>
                        </>
                      ) : (
                        // 正常模式：单层信息
                        <div className="relative">
                          <h1 className={`text-4xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                            {currentSong.name}
                          </h1>
                          <p className={`text-xl ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                            {currentSong.artists.map((a: any) => a.name).join(', ')}
                          </p>
                        </div>
                      )}
                    </div>
                </motion.div>
                </motion.div>
              ) : lyricDisplayMode === 'immersive' ? (
                <motion.div
                  key="immersive-lyrics-player"
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: isLyricsTransitioning ? 0 : 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(10px)' }}
                  transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                  className="flex-1 w-full min-h-0 flex flex-col items-center justify-center px-10 pt-20 pb-28"
                >
                  {!hideImmersiveSongInfo && (
                    <motion.div
                      initial={{ opacity: 0, y: -12 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -12 }}
                      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                      className="pointer-events-none fixed left-10 top-8 z-30 max-w-[42vw]"
                    >
                      <h1 className={`truncate text-2xl font-semibold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>{currentSong.name}</h1>
                      <p className={`mt-1 truncate text-sm ${playerTheme === 'dark' ? 'text-white/70 drop-shadow-md' : 'text-black/60'}`}>{currentSong.artists.map((a: any) => a.name).join(', ')}</p>
                    </motion.div>
                  )}

                  <div className="w-full max-w-6xl h-[78vh] min-h-0 flex items-center justify-center text-center">
                    <LiveLyricsDisplay
                      playbackTimeStore={audioPlayer.playbackTimeStore}
                      lyrics={lyrics}
                      isPlaying={isPlaying}
                      accentColor={dominantColor || '#fff'}
                      translationEnabled={false}
                      translationPosition="bottom-right"
                      onCurrentTranslationChange={setCurrentTranslation}
                      onSeek={audioPlayer.seek}
                      romanEnabled={false}
                      displayMode="single"
                      isTransitioning={isVisualTransitioning}
                      trackId={currentSong?.id || currentSong?.mid}
                      playerTheme={playerTheme}
                    />
                  </div>
                </motion.div>
              ) : lyricDisplayMode === 'wallpaper' ? (
                <motion.div
                  key="wallpaper-lyrics-player"
                  initial={{ opacity: 0, scale: 1.025 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.985 }}
                  transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 w-full min-h-0"
                >
                  <LazyWallpaperLyrics
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    accentColor={dominantColor || '#fff'}
                    playerTheme={playerTheme}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    isTransitioning={isVisualTransitioning}
                    onSeek={audioPlayer.seek}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'multidimensional' ? (
                <motion.div
                  key="multidimensional-lyrics-player"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: isLyricsTransitioning ? 0 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 w-full min-h-0"
                >
                  <LazyMultidimensionalLyrics
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    accentColor={dominantColor || '#fff'}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    isTransitioning={isVisualTransitioning}
                    onSeek={audioPlayer.seek}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'glorious' ? (
                <motion.div
                  key="glorious-lyrics-player"
                  initial={{ opacity: 0, scale: 1.04 }}
                  animate={{ opacity: isLyricsTransitioning ? 0 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.58, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 w-full min-h-0"
                >
                  <LazyGloriousLyrics
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    accentColor={dominantColor || '#fff'}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    isTransitioning={isVisualTransitioning}
                    onSeek={audioPlayer.seek}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'modeng' ? (
                <motion.div
                  key="modeng-lyrics-player"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: isLyricsTransitioning ? 0 : 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.45, ease: [0.42, 0, 0.58, 1] }}
                  className="flex-1 w-full min-h-0 relative"
                >
                  <LazyModengPlayer
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    accentColor={dominantColor || '#fff'}
                    playerTheme={playerTheme}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    appleCoverUrl={appleCoverUrl || undefined}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    isTransitioning={isVisualTransitioning}
                    onSeek={audioPlayer.seek}
                    onPlayPause={handlePlayPause}
                    onPrevious={handlePrevious}
                    onNext={handleNext}
                    volume={volume}
                    onVolumeChange={handleVolumeChange}
                    playMode={playMode}
                    onPlayModeChange={handlePlayModeChange}
                    duration={duration}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'video' ? (
                <motion.div
                  key="video-lyrics-player"
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: isLyricsTransitioning ? 0 : 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(10px)' }}
                  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  className="flex-1 w-full min-h-0 relative"
                >
                  <LazyBilibiliMvPlayer
                    ref={watchPlayerRef}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songArtists={currentSong.artists.map((artist: any) => artist.name)}
                    songDuration={(currentSong.duration || 0) / 1000}
                    coverUrl={displayCoverUrl}
                    platform={currentSong.platform}
                    songId={currentSong.id || currentSong.mid}
                    playerTheme={playerTheme}
                    onNext={handleNext}
                    onPrevious={handlePrevious}
                    onBackToAudio={() => handleLyricDisplayModeChange('modern')}
                    onVideoActiveChange={setWatchVideoActive}
                    onHomeClick={handlePlayerHome}
                    onOpenMixingStudio={(anchorRect: { x: number; y: number; width: number; height: number }) => {
                      if (anchorRect) {
                        mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                      }
                      setShowMixingStudio(true)
                    }}
                    onOpenPlaylist={() => setShowPlaylist(true)}
                    onToggleFavorite={() => { void handlePlaybackToggleFavorite(currentSong, currentSongLiked) }}
                    liked={currentSongLiked}
                    upcomingSongs={watchUpcomingSongs}
                    initialSeekSeconds={watchSyncSeek}
                  />
                </motion.div>
              ) : (
                /* 有歌词时左右布局 */
                <motion.div
                  key="with-lyrics-player"
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(10px)' }}
                  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  className="flex-1 w-full flex items-center justify-center"
                >
                  <div className="w-full max-w-7xl h-[85vh] flex gap-12 items-center">
                  {/* 左侧：封面展示区 */}
                  <div className="flex-1 flex flex-col items-center justify-center gap-6">
                    <AlbumCoverPlayer
                      coverUrl={displayCoverUrl}
                      isPlaying={isPlaying}
                      dominantColor={dominantColor}
                      trackId={currentSong.id || currentSong.mid}
                      isTransitioning={isVisualTransitioning}
                      transitionProgress={transitionProgress}
                      transitionFromTrack={transitionFromTrack}
                      transitionToTrack={transitionToTrack}
                      pulseStore={audioPulseStore}
                    />
                    
                    {/* 歌曲信息 - 过渡时双层淡入淡出 */}
                    <div className="relative min-h-[5.25rem] w-full max-w-xl space-y-2 px-4 text-center">
                      {isVisualTransitioning && transitionProgress > 0 && transitionFromTrack && transitionToTrack ? (
                        // 过渡模式：双层叠加
                        <>
                          {/* 底层：旧歌曲信息 */}
                          <div className="absolute inset-0" style={{ opacity: 1 - transitionProgress }}>
                            <h1 className={`text-3xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                              {transitionFromTrack.title}
                            </h1>
                            <p className={`text-lg ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                              {transitionFromTrack.artist}
                            </p>
                          </div>
                          {/* 顶层：新歌曲信息 */}
                          <div className="relative" style={{ opacity: transitionProgress }}>
                            <h1 className={`text-3xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                              {transitionToTrack.title}
                            </h1>
                            <p className={`text-lg ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                              {transitionToTrack.artist}
                            </p>
                          </div>
                        </>
                      ) : (
                        // 正常模式：单层信息
                        <div className="relative">
                          <h1 className={`text-3xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>
                            {currentSong.name}
                          </h1>
                          <p className={`text-lg ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>
                            {currentSong.artists.map((a: any) => a.name).join(', ')}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 閸欏厖鏅堕敍姘摃鐠囧秵妯夌粈鍝勫隘 */}
                  <div className="flex-1 flex flex-col justify-between h-full min-h-0 py-8">
                    {/* 歌词显示 */}
                    <div className="flex-1 min-h-0 flex items-center justify-center">
                      <div className="w-full h-full min-h-0">
                        <LiveLyricsDisplay
                      playbackTimeStore={audioPlayer.playbackTimeStore}
                          lyrics={lyrics}
                          isPlaying={isPlaying}
                          accentColor={dominantColor || '#fff'}
                          translationEnabled={translationEnabled}
                          translationPosition={translationPosition}
                          onCurrentTranslationChange={setCurrentTranslation}
                          onSeek={audioPlayer.seek}
                          romanEnabled={romanEnabled}
                          backgroundEffect={backgroundEffect}
                          sustainGlowEnabled
                          isTransitioning={isVisualTransitioning}
                          trackId={currentSong?.id || currentSong?.mid}
                          pulseStore={audioPulseStore}
                          playerTheme={playerTheme}
                        />
                      </div>
                    </div>

                    {/* 閸欏厖绗呯憴鎺旂倳鐠囨垶妯夌粈?*/}
                    <LazyTranslationDisplay
                      translation={currentTranslation}
                      show={translationEnabled && translationPosition === 'bottom-right'}
                      songId={currentSong?.id}
                    />
                  </div>
                </div>
              </motion.div>
            )
          })()}

          <AnimatePresence>
            {currentSong && !showHome && lyricDisplayMode === 'modern' && modernAudioVisualizerEnabled && (
              <LazyModernAudioVisualizer
                key="modern-audio-visualizer"
                analyser={audioPlayer.analyserNode}
                isPlaying={isPlaying}
                accentColor={dominantColor || '#ffffff'}
                palette={coverPalette}
                playerTheme={playerTheme}
                pulseStore={audioPulseStore}
              />
            )}
          </AnimatePresence>

          {/* 全局播放器 - 固定在底部（摩登/看歌模式自带控制条，不渲染全局控制条） */}
          {currentSong && !showHome && lyricDisplayMode !== 'modeng' && lyricDisplayMode !== 'video' && (
            <LivePlayerControls
                      playbackTimeStore={audioPlayer.playbackTimeStore}
              isPlaying={isPlaying}
              duration={duration}
              volume={volume}
              onPlayPause={handlePlayPause}
              onSeek={handleSeek}
              onVolumeChange={handleVolumeChange}
              onPrevious={handlePrevious}
              onNext={handleNext}
              onPlaylistClick={() => setShowPlaylist(true)}
              backgroundEffect={lyricDisplayMode === 'immersive' || lyricDisplayMode === 'glorious' || lyricDisplayMode === 'multidimensional' ? 'immersive' : backgroundEffect}
              playMode={playMode}
              onPlayModeChange={handlePlayModeChange}
              accentColor={dominantColor || '#fff'}
              transitionFromAccentColor={transitionFromAccentColor || transitionFromTrack?.dominantColor || undefined}
              transitionToAccentColor={transitionToAccentColor || undefined}
              transitionProgress={transitionProgress}
              playerTheme={playerTheme}
              isTransitioning={isVisualTransitioning}
              isAutoMixTransition={isAutoMixTransition}
              transitionStartTime={transitionStartTime}
              immersiveTranslation={immersiveLyricLine?.translation || ''}
              immersiveRoman={immersiveLyricLine?.roman || ''}
              showImmersiveTranslation={lyricDisplayMode === 'immersive' && translationEnabled && Boolean(immersiveLyricLine?.translation?.trim())}
              showImmersiveRoman={lyricDisplayMode === 'immersive' && romanEnabled && Boolean(immersiveLyricLine?.roman?.trim())}
            />
          )}
          </motion.div>
        )}
        </div>

        {/* 首页 MiniPlayer 必须由首页直接挂载/卸载。播放页不能等待组件内部的
            exit 动画，否则冷启动首次播放时 Chromium 可能保留一个空的合成框。 */}
        {showHome && currentSong && <LiveMiniPlayer
                      playbackTimeStore={audioPlayer.playbackTimeStore}
          show={true}
          coverUrl={displayCoverUrl}
          isPlaying={isPlaying}
          duration={duration}
          volume={volume}
          title={currentTrack.title}
          artist={currentTrack.artist}
          currentLyric={currentMiniLyric}
          hasLyrics={lyrics.length > 0}
          accentColor={dominantColor || '#fff'}
          onPlayPause={handlePlayPause}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          onClick={() => {
            playbackOriginRef.current = { mode: viewMode, surface: viewMode === 'minimal' ? 'home' : 'mode-root' }
            setRestorePlaybackOrigin(null)
            setEnteredFromMode(viewMode)
            setShowHome(false)
          }}
        />}
      </div>

      {/* 播放器设置面板 */}
      {showPlaylist && (
        <Suspense fallback={null}>
          <LazyPlaylistPanel
            show={true}
            playerTheme={playerTheme}
            onClose={stableDialogCallbacks.closePlaylist}
            playlist={playlist}
            currentIndex={currentIndex}
            onSmartReorder={stableDialogCallbacks.smartReorder}
            isSmartReordering={isSmartReordering}
            smartReorderProgress={smartReorderProgress}
            onSongSelect={stableDialogCallbacks.playlistSongSelect}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            currentPlatform={currentSong?.platform === 'qq' ? 'qq' : 'netease'}
          />
        </Suspense>
      )}

      {/* 鐧诲綍瑙嗗浘 */}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 播放提示是全局覆盖层：播放页始终允许显示；探索、简约首页和桌面模式
          只有在“在播放页外显示播放提示”开启时才显示，且三个模式位置一致。 */}
      {playlist.length > 0 && playMode !== 'repeat' && showUpNext && canShowUpNextOnCurrentSurface && (
        <Suspense fallback={null}>
          <LazyUpNextNotification
            show={true}
            playerTheme={playerTheme}
            nextSong={nextSongToShow}
            secondsRemaining={(autoMixEnabled || gaplessEnabled)
              ? (transitionStartTime ?? duration) - currentTime
              : duration - currentTime}
            mode={autoMixEnabled || gaplessEnabled ? 'transition' : 'play'}
            onSkip={() => {
              suppressUpNextUntilRef.current = Date.now() + 3000
              setShowUpNext(false)
              handleNext()
            }}
          />
        </Suspense>
      )}

      {/* Search and login are global singletons. They can open from any mode and must not
          remain attached to an outgoing AnimatePresence branch during playback entry. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {showSearch && (
            <LazySearchPanel
            onSongSelect={viewCallbacks.onSongSelect}
            restorePlaybackOrigin={restorePlaybackOrigin}
            onClose={() => {
              setShowSearch(false)
              setRestorePlaybackOrigin(null)
            }}
            onRestoreConsumed={() => setRestorePlaybackOrigin(null)}
            playerTheme={playerTheme}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            neteaseLoggedIn={neteaseLoggedIn}
            qqLoggedIn={qqLoggedIn}
            currentSong={currentSong}
            onPlayNext={viewCallbacks.onPlayNext}
            onAddToFavorites={viewCallbacks.onAddToFavorites}
            onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
            onAddToPlaylist={viewCallbacks.onAddToPlaylist}
            onViewComments={viewCallbacks.onViewComments}
            onOpenArtist={viewCallbacks.onOpenArtist}
            onOpenAlbum={viewCallbacks.onOpenAlbum}
            onCopyInfo={viewCallbacks.onCopyInfo}
            />
          )}
        </AnimatePresence>
      </Suspense>

      <Suspense fallback={null}>
        <AnimatePresence>
          {showLogin && (
            <LazyLoginView
            platform={loginPlatform}
            onCancel={() => setShowLogin(false)}
            onLoginSuccess={(cookie, username) => {
              if (loginPlatform === 'netease') handleNeteaseLogin(cookie)
              else if (loginPlatform === 'qq') handleQQLogin(cookie)
              else if (loginPlatform === 'spotify') handleSpotifyLogin(cookie, username)
              else if (loginPlatform === 'kugou') handleKugouLogin(cookie, username)
              else if (loginPlatform === 'soda') handleSodaLogin(cookie, username)
              setShowLogin(false)
            }}
            />
          )}
          {showAppleLogin && (
            <AppleLoginPanel
              accentColor="#fa2d48"
              onClose={() => setShowAppleLogin(false)}
              onLoginSuccess={(user) => {
                // user 为 null 表示面板内已退出登录（clearAppleLogin 后回调）
                handleAppleLogin(user)
                setShowAppleLogin(false)
              }}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* Global detail singletons stay outside mode branches so an outgoing view cannot
          retain a second interactive overlay while playback switches to minimal mode. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {showArtistDetail && selectedArtistId && (
            <LazyArtistDetailModal
            key={'artist-' + selectedArtistId}
            artistId={selectedArtistId}
            platform={selectedArtistPlatform}
            onClose={closeArtistDetail}
            onSongSelect={handleArtistDetailSongSelect}
            initialAlbumId={selectedArtistAlbumId}
            onAlbumOpen={setSelectedArtistAlbumId}
            initialTab={selectedArtistTab || 'hotSongs'}
            onTabChange={setSelectedArtistTab}
            accentColor={dominantColor || '#3B82F6'}
            playerTheme={playerTheme}
            currentSong={currentSong}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            onPlayNext={viewCallbacks.onPlayNext}
            onAddToFavorites={viewCallbacks.onAddToFavorites}
            onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
            onAddToPlaylist={viewCallbacks.onAddToPlaylist}
            onViewComments={viewCallbacks.onViewComments}
            onOpenArtist={viewCallbacks.onOpenArtist}
            onOpenAlbum={viewCallbacks.onOpenAlbum}
            onCopyInfo={viewCallbacks.onCopyInfo}
            />
          )}
        </AnimatePresence>
      </Suspense>

      <Suspense fallback={null}>
        <AnimatePresence>
          {showAlbumDetail && selectedAlbumId && (
            <LazyAlbumDetailModal
            key={'album-' + selectedAlbumId}
            albumId={selectedAlbumId}
            platform={selectedAlbumPlatform}
            onClose={stableDialogCallbacks.closeAlbumDetail}
            onSongSelect={handleAlbumDetailSongSelect}
            accentColor={dominantColor || '#3B82F6'}
            playerTheme={playerTheme}
            currentSong={currentSong}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            onPlayNext={viewCallbacks.onPlayNext}
            onAddToFavorites={viewCallbacks.onAddToFavorites}
            onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
            onAddToPlaylist={viewCallbacks.onAddToPlaylist}
            onViewComments={viewCallbacks.onViewComments}
            onOpenArtist={viewCallbacks.onOpenArtist}
            onOpenAlbum={viewCallbacks.onOpenAlbum}
            onCopyInfo={viewCallbacks.onCopyInfo}
            />
          )}
        </AnimatePresence>
      </Suspense>

      <Suspense fallback={null}>
        <AnimatePresence>
          {showCommentModal && (
            <LazyCommentModal
              isOpen={true}
              onClose={closeCommentModal}
              song={selectedCommentSong}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* Global singleton prevents duplicate overlays during view-mode changes. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {showProfile && (neteaseLoggedIn || qqLoggedIn || appleLoggedIn) && (
            <LazyProfileView
            initialPlatform={profileInitialPlatform}
            initialTab={profileInitialTab}
            canSwitchPlatform={[neteaseLoggedIn, qqLoggedIn, appleLoggedIn].filter(Boolean).length >= 2}
            userId={profileInitialPlatform === 'netease' ? neteaseUserId : profileInitialPlatform === 'qq' ? qqUserId : ''}
            cookie={profileInitialPlatform === 'netease' ? _neteaseCookie : profileInitialPlatform === 'qq' ? _qqCookie : ''}
            onClose={stableDialogCallbacks.closeProfile}
            onSongSelect={viewCallbacks.onSongSelect}
            handleSwitchPlatform={stableDialogCallbacks.switchProfilePlatform}
            onLogout={stableDialogCallbacks.logout}
            currentSong={currentSong}
            playerTheme={playerTheme}
            onOpenArtist={viewCallbacks.onOpenArtist}
            onOpenAlbum={viewCallbacks.onOpenAlbum}
            onPlayNext={viewCallbacks.onPlayNext}
            onAddToFavorites={viewCallbacks.onAddToFavorites}
            onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
            onAddToPlaylist={viewCallbacks.onAddToPlaylist}
            onViewComments={viewCallbacks.onViewComments}
            onCopyInfo={viewCallbacks.onCopyInfo}
            />
          )}
        </AnimatePresence>
      </Suspense>
    </Suspense>
    </>
  )
}

export default App










