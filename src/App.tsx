import { debugLog, isTransitionDebugEnabled } from './utils/debugLog'
import { parseStoredBoolean } from './utils/storage'
import { isTv, isTvModeActive, isDesktop } from './platform'
import { dispatchTvBack, useTvBack, useRemoteCursorMode } from './tv/tvCore'
import { isPerfModeEfficiency, isPerfModeEnhanced } from './tv/perfMode'
import { lazy, memo, Suspense, startTransition, useState, useCallback, useEffect, useRef, useMemo, useSyncExternalStore, type ComponentProps, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import AlbumCoverPlayer from './components/AlbumCoverPlayer'
import TransitionTrackTitles from './components/TransitionTrackTitles'
import { useTransitionLyricsCrossfade, useTransitionOverlayProgress, useTransitionTargetTime, useTransitionVisualIdentity } from './hooks/useTransitionVisual'
import type { TransitionVisualStore } from './audio/transitionVisualStore'
import LyricsDisplay from './components/LyricsDisplay'
import PlayerControls from './components/PlayerControls'
import TitleBar from './components/TitleBar'
import FusionEnableConfirmModal from './components/FusionEnableConfirmModal'
import UpdateManager from './components/UpdateManager'
import UpdatePrompt from './components/UpdatePrompt'
import CrossfadeBackground from './components/CrossfadeBackground'
import { chromaClient } from './plugins/clients/ChromaClient'
import { signalRgbClient } from './plugins/clients/SignalRgbClient'
import { getBackgroundArtworkSize } from './services/artwork'
import { setGameModeFrozen as setGameModeFrozenRuntime } from './services/gameModeRuntime'
import ModernFluidBackground from './components/ModernFluidBackground'
import { FoliaTransitionOverlay } from './components/folia/FoliaTransitionOverlay'
import { FoliaUpNextCard } from './components/folia/FoliaUpNextCard'
import { resolveFoliaPresentation } from './components/folia/foliaPresentation'
import { resolveFoliaStyleFallback, supportsLumiere } from './components/foliaLumiereSupport'
import {
  mergeOrder,
  moveIdToIndex,
  parseStoredIdList,
  readStoredOrder,
  resolveEffectiveVisible,
  toggleVisible,
  writeStoredOrder,
} from './components/lyricModePrefs'
import { HorizontalShelf } from './components/apple-explore/HorizontalShelf'
import { FoliaTuningPanel } from './components/FoliaTuningPanel'
import {
  hasFoliaTuningOverride,
  readFoliaTunings,
  resolvePanelTuning,
  writeFoliaTunings,
} from './components/foliaTunings'
import { getVisualizerRegistryEntry } from './vendor/folia/components/visualizer/registry'
import type { VisualizerTuningBundle } from './vendor/folia/components/visualizer/tuningRegistry'
import { AutomixHudBadge, useAutomixHudTime, transitionEngineDisplayName } from './components/AutomixHudBadge'

import MiniPlayer from './components/MiniPlayer'
import Toast from './components/Toast'
import GaplessModeToast from './components/GaplessModeToast'
import TransitionDebugToast from './components/TransitionDebugToast'
import ModeTransitionOverlay from './components/ModeTransitionOverlay'
import {
  getModeTransitionStyle,
  isModeTransitionSoundEnabled,
  MODE_TRANSITION_STYLE_EVENT,
  MODE_TRANSITION_SOUND_EVENT,
  type ModeTransitionStyle,
} from './services/modeTransitionSettings'
import { extractDominantColor, useColorThief } from './hooks/useColorThief'
import { useAudioPlayer, type AudioGraphHandle } from './hooks/useAudioPlayer'
import { airplayController } from './services/airplayController'
import { runShaderWarmup } from './services/shaderWarmup'
import { useAudioAnalyzer } from './hooks/useAudioAnalyzer'
import { useAppleDynamicCover } from './hooks/useAppleDynamicCover'
import { FOLIA_STYLES } from './vendor/folia/stylesMeta'
import { useAudioPulseStore, type AudioPulseStore } from './hooks/useAudioPulse'
import { useAutoHideCursor } from './hooks/useAutoHideCursor'
import { Song, getSongUrl, getSodaPlaybackInfo, invalidateSongUrl, getLyrics, getProxiedImageUrl,
  getSimilarSongs, getProxiedAudioUrl, getLocalAlbumIdentifier, resolveSongAlbumIdentifier, isSameSong, LyricLine } from './services/musicApi'
import { recordAppleRecentPlaybackFallback } from './services/appleRecentPlayback'
import type { MusicPlatform } from './services/platforms'
import { getPlatformCapabilities, isPlatformVisible, platformLabel } from './services/platforms'
import { getAppleMusicSettings, resolveAppleTrack } from './services/appleMusic'
import { getAppleAuthState, clearAppleLogin, type AppleUserInfo } from './services/appleAuth'
import { recordLogin, clearLoginExpiry, isLoginExpired } from './services/loginExpiry'
import { resolvePlayableSong, setAppleSongLoved, getLastAppleMutationResult, addAppleTracksToPlaylist, getAppleLibraryPlaylists, getAppleLibrarySongs, getAppleHotSongs, appleLibraryTrackToSong, appleSongToSong, resolveAppleLibraryCatalogId, APPLE_LIBRARY_ID_PATTERN } from './services/appleCatalog'
import { ensureBridgeRunning, checkBridgeRunning, bridgePlay, bridgeStop, getState as getBridgeState, isBridgeReady, fetchBridgeSpectrum } from './services/appleWebViewBridge'
import { getAppleRadioFailReason, isAppleNativeStreamEnabled, isAppleEmeCapable, isAppleTrackRadioStation, releaseAppleNativeStream, resolveAppleNativeStream, resolveAppleRadioStream, type AppleNativeStream } from './services/applePlayback'
import { APPLE_AUTOPLAY_CHANGED_EVENT, readAppleAutoplayEnabled } from './services/appleAutoplaySettings'
import { createAppleAutoplayStation, fetchAppleAutoplayTracks } from './services/appleWebService'
import { decideAppleRadioFailure, getAppleRadioReconnectKey } from './services/appleRadioReconnect'
import { fetchAppleRadioPage, fetchAppleStationDetail, appleStationToSong } from './services/appleWebService'
import { getAppleAcceptanceSnapshot, installAppleEmeAcceptanceInstrumentation, resetAppleAcceptanceSnapshot } from './services/appleAcceptanceDiagnostics'
import AppleLoginPanel from './components/AppleLoginPanel'
import { cacheManager } from './services/cacheManager'
import { indexedDBCache } from './services/indexedDBCache'
import { autoMixAnalysisService } from './services/autoMixAnalysisService'
import { getAudioEngineVersion, setAudioEngineVersion, type AudioEngineVersion } from './services/audioEngineVersion'
import { getEngineAdapter, getAvailableEngines, getAvailableEngineIds, type IAudioEngineAdapter } from './services/audio-engine'
import { sequenceTracksHam2, type SequencingEntry } from './services/playlistSequencing'
import { resolveArtistIdentifier, resolveViewArtistIntent } from './services/playbackArtist'
import { likeSong, addSongToPlaylist, getUserPlaylists, updateCachedUserPlaylists, getPlaylistDetail } from './services/playlistService'
import { fetchExploreRecommendationBatch } from './services/exploreApi'
import { fetchNeteaseHeartMode, fetchNeteaseRoam } from './features/neteaseExplore/api'
import { fetchQQRadarSongs } from './features/qqExplore/api'
import { scheduleBackgroundPrefetch } from './services/backgroundPrefetch'
import { getResolvedArtworkUrl, preloadArtwork } from './services/artworkLoader'
import { recordListen } from './services/listeningLog'
import { getDesktopSpectrumConsumerCount, subscribeDesktopSpectrumConsumers } from './services/desktopSpectrum'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings, Sparkles, Check, Image as ImageIcon, Radio, SlidersHorizontal } from 'lucide-react'
import { getDeterministicNextIndex, getUpcomingIndices } from './audio/PlaybackQueue'
import type { PreloadTrack, TrackAnalysis, TransitionCommit, TransitionDebugInfo, TransitionState, TransitionStrategy } from './audio/types'
import { createPlaybackTimeCommitGate, type PlaybackTimeStore } from './audio/playbackTimeStore'
import { canonicalTrackKey, isQueuePlaceholder, type ResonancePlatformBadge, type ResonanceTrack } from './features/resonance/model'
import { getResonanceSession, subscribeResonanceSessionLifecycle } from './features/resonance/session'
import { resolveLocalTrack, type ResonanceLocalTrack } from './features/resonance/matcher'
import { readResonanceEntryMode, rememberResonanceEntryMode } from './features/resonance/settings'
import { RESONANCE_PUSH_EVENT, setResonanceSuspended, songToResonanceTrack } from './features/resonance/push'
import { createSongOwnedHandoff, readSongOwnedHandoff, type SongOwnedHandoff } from './services/watchHandoff'
import { songKeyOf as bilibiliSongKeyOf } from './services/bilibiliApi'
import type { PlaybackOrigin, ViewMode } from './types/playbackNavigation'
import { preloadOnIdle } from './utils/lazyPreload'
const loadHomeView = () => import('./components/HomeView')
const loadExploreView = () => import('./components/ExploreView')
const loadDesktopView = () => import('./components/DesktopView')
const loadTraditionalView = () => import('./components/TraditionalView')
// 共振（多人一起听）：独立模式，房间状态由 src/features/resonance 的单例承载
const loadResonanceView = () => import('./features/resonance/ResonanceView')
// 模式切换过渡动画时长：最短 3s（高性能机秒切也不一闪而过）；最长 12s 兜底（防止加载异常卡死界面）
const MODE_TRANSITION_MIN_MS = 3000
// 快速档（目标模式本次会话已挂载过、内容就绪）：只播一段压紧的丝滑过渡，不让用户白等
const MODE_TRANSITION_QUICK_MIN_MS = 850
// 简易风格（徽章动画）暖目标下的窗口：比复杂快速档稍长一点，让"极光+徽章"能被看清不闪一下
const MODE_TRANSITION_SIMPLE_MIN_MS = 1300
const MODE_TRANSITION_MAX_MS = 12000
// 各模式懒加载 chunk 的统一入口：过渡动画一开始（点击模式卡片）就提前拉取，
// 与来源面板的收起动画并行下载/编译，viewModeChanged 到达时 chunk 通常已在内存里——
// 这就是「切换时做预加载」的核心：把串行的 加载→切换 变成并行的 加载‖动画
const MODE_CHUNK_LOADERS: Record<'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance', () => Promise<unknown>> = {
  explore: loadExploreView,
  minimal: loadHomeView,
  traditional: loadTraditionalView,
  desktop: loadDesktopView,
  resonance: loadResonanceView,
}
const PLAYBACK_NEUTRAL_COLOR = '#6b7280'
// TV 效能档禁入的重 GPU 歌词模式：多维（R3F WebGL 全速渲染）、Folia（WebGL）、PV（Pixi 60fps ticker）、壁纸（桌面壁纸语义）
const TV_HEAVY_LYRIC_MODES: LyricDisplayMode[] = ['multidimensional', 'folia', 'pv', 'wallpaper']
// 过渡进度在 App 侧的粗量化节流基准（见 setTransitionProgress 调用处）
let lastTransitionProgressThrottle = 0
const LazyHomeView = lazy(loadHomeView)
const LazyExploreView = lazy(loadExploreView)
const LazyDesktopView = lazy(loadDesktopView)
const LazyTraditionalView = lazy(loadTraditionalView)
const LazyResonanceView = lazy(loadResonanceView)
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
// 仅由 设置→高级 卡片手动触发（或首次启动 (!completedLocal && !fileFlagDone)）显示；
// 软件启动不会自动弹出 OOBE。
// 未来 AI 接力：OOBE 2 = 功能介绍引导，在 OobeGuide 的 welcome 步骤前插入步骤即可。
// ────────────────────────────────────────────────────────────────
const OOBE_ENABLED = false
/** 设置→高级 卡片触发的 OOBE 事件名 */
const OOBE_TRIGGER_EVENT = 'waveforge-trigger-oobe'
// 调音室组件的 lazy import 已下沉到各引擎 Adapter 的 renderStudio 内部，
// App.tsx 不再直接引用调音室组件（统一通过 engineAdapterRef.current.renderStudio 渲染）。
const loadPlaylistPanel = () => import('./components/PlaylistPanel')
const loadLoginView = () => import('./components/LoginView')
const loadProfileView = () => import('./components/ProfileView')
const loadArtistDetailModal = () => import('./components/ArtistDetailModal')
const loadArtistPickerModal = () => import('./components/ArtistPickerModal')
const loadAlbumDetailModal = () => import('./components/AlbumDetailModal')
const loadCommentModal = () => import('./components/CommentModal')
const LazyPlaylistPanel = lazy(loadPlaylistPanel)
const loadPlaylistDetailPanel = () => import('./components/PlaylistDetailPanel')
const LazyPlaylistDetailPanel = lazy(loadPlaylistDetailPanel)
const LazyLoginView = lazy(loadLoginView)
const LazyProfileView = lazy(loadProfileView)
const LazyArtistDetailModal = lazy(loadArtistDetailModal)
const LazyArtistPickerModal = lazy(loadArtistPickerModal)
const LazyAlbumDetailModal = lazy(loadAlbumDetailModal)
const LazyCommentModal = lazy(loadCommentModal)
const loadModernAudioVisualizer = () => import('./components/ModernAudioVisualizer')
const loadPlaybackRadialMenu = () => import('./components/PlaybackRadialMenu')
const loadQQMusicPreferenceDialog = () => import('./features/qqExplore/QQMusicPreferenceDialog')
const loadImmersiveControls = () => import('./components/ImmersiveControls')
const loadQuickSettingsHost = () => import('./components/QuickSettingsHost')
const loadTranslationDisplay = () => import('./components/TranslationDisplay')
const loadWallpaperLyrics = () => import('./components/WallpaperLyrics')
const loadGloriousLyrics = () => import('./components/GloriousLyrics')
const loadMultidimensionalLyrics = () => import('./components/MultidimensionalLyrics')
const loadFoliaLyricsPage = () => import('./components/FoliaLyricsPage')
const loadPvLyricsPage = () => import('./components/pvLyrics/PvLyricsPage')
const loadModengPlayer = () => import('./components/ModengPlayerPage')
const loadAppleRadioNowPlayingPage = () => import('./components/AppleRadioNowPlayingPage')
const LazyAppleRadioNowPlayingPage = lazy(loadAppleRadioNowPlayingPage)
const loadPodcastNowPlayingPage = () => import('./components/PodcastNowPlayingPage')
const LazyPodcastNowPlayingPage = lazy(loadPodcastNowPlayingPage)
const loadBilibiliMvPlayer = () => import('./components/BilibiliMvPlayer')
const loadBilibiliMvBackground = () => import('./components/BilibiliMvBackground')
const LazyModernAudioVisualizer = lazy(loadModernAudioVisualizer)
const LazyPlaybackRadialMenu = lazy(loadPlaybackRadialMenu)
const LazyQQMusicPreferenceDialog = lazy(loadQQMusicPreferenceDialog)
const LazyImmersiveControls = lazy(loadImmersiveControls)
const LazyQuickSettingsHost = lazy(loadQuickSettingsHost)
const LazyTranslationDisplay = lazy(loadTranslationDisplay)
const LazyWallpaperLyrics: any = lazy(loadWallpaperLyrics)
const LazyGloriousLyrics: any = lazy(loadGloriousLyrics)
const LazyMultidimensionalLyrics = lazy(loadMultidimensionalLyrics)
const LazyFoliaLyricsPage = lazy(loadFoliaLyricsPage)
const LazyPvLyricsPage: any = lazy(loadPvLyricsPage)
const LazyModengPlayer: any = lazy(loadModengPlayer)
const LazyBilibiliMvPlayer: any = lazy(loadBilibiliMvPlayer)
const LazyBilibiliMvBackground: any = lazy(loadBilibiliMvBackground)
// 歌词模式 → chunk 预载器：切换前先加载目标 chunk，避免 lazy 首次挂载 suspend 到
// app 级 Suspense(fallback=null) 导致整个播放页闪空（modern 为默认模式，无独立 chunk）
const LYRIC_MODE_LOADERS: Partial<Record<string, () => Promise<unknown>>> = {
  wallpaper: loadWallpaperLyrics,
  glorious: loadGloriousLyrics,
  multidimensional: loadMultidimensionalLyrics,
  folia: loadFoliaLyricsPage,
  modeng: loadModengPlayer,
  video: loadBilibiliMvPlayer,
  pv: loadPvLyricsPage,
}
const loadRemoteControlModal = () => import('./components/RemoteControlModal')
const LazyRemoteControlModal = lazy(loadRemoteControlModal)
const loadPlaybackDeviceModal = () => import('./components/PlaybackDeviceModal')
const LazyPlaybackDeviceModal = lazy(loadPlaybackDeviceModal)
const loadSongDetailModal = () => import('./components/SongDetailModal')
const LazySongDetailModal = lazy(loadSongDetailModal)
import RemoteCursor from './components/RemoteCursor'
import PlatformLoginNotice from './components/PlatformLoginNotice'
import SimilarSongsPanel, { extractSimilarSongItems, normalizeSimilarSongItems } from './components/SimilarSongsPanel'
import PluginOverlay from './components/PluginOverlay'
import { setGlobalAudioAnalyzerStore, setGlobalPlaybackActive, setGlobalAudioAnalysers, dglabClient } from './plugins/clients/DGLabClient'
import { setChromaAudioAnalyzerStore, setChromaPlaybackActive } from './plugins/clients/ChromaClient'
import { setSignalRgbAudioAnalyzerStore, setSignalRgbPlaybackActive } from './plugins/clients/SignalRgbClient'
import { isPluginEnabled, PLUGIN_STATE_EVENT } from './services/pluginStore'
import { hasEnabledAudioPlugin } from './plugins/registry'
import {
  createPlatformEntitlements,
  detectQQMusicSvip,
  detectQQMusicVip,
  entitlementTierFromSodaMembership,
  entitlementTierFromSpotifyProduct,
  entitlementTierFromVip,
  type EntitlementTier,
} from './utils/musicEntitlements'
import { getQQUserDisplayName } from './utils/qqUser'
import { LYRIC_STYLE_MODE_EVENT, readLyricStyleMode, type LyricStyleMode } from './utils/lyricStyle'
import { ModeParkedContext, modeLayerStyle, modeLayerSuspendedAttr } from './utils/modeLayer'
import { FrozenScope } from './components/frozenScope'
import { getAppleLovedSongIds } from './services/appleCatalog'
import {
  applyFavoriteMutation,
  getFavoriteSongIdentifiers,
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
import { notifyPlaybackSpeedTransitionReset } from './services/playbackSpeedSettings'

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

/**
 * 这些歌词模式在「纯音乐」时使用自己的版面（居中封面、没有歌词列）。
 * 其余模式（modern/soft 等默认播放页）统一走同一棵播放页树：纯音乐时收起歌词列，
 * 有词时展开 —— 同一棵树 + layout 动画，使「有词 ↔ 纯音乐」过渡时封面是滑过去的。
 */
const PURE_MUSIC_OWN_LAYOUT_MODES = new Set<string>([
  'modeng', 'immersive', 'wallpaper', 'multidimensional', 'folia', 'glorious', 'pv',
])

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

/**
 * 过渡期"先行淡入的下一首歌词层"。
 *
 * 用户诉求：前一首进入过渡后歌词按过渡时长逐渐淡出、后一首同时逐渐淡入（交叉）。
 * canonical 歌词要等视觉切换帧（90%）才换成下一首，所以这里用**目标曲时间轴**
 * （视觉轨道 targetTime）先把下一首歌词渲染出来，按交叉进度提升不透明度；视觉切换帧
 * 由 canonical 歌词在同一位置、同样式、无入场动画地接替 —— 切换帧零可见变化。
 *
 * 非交互（无 seek/悬浮/点击），也不驱动宿主翻译面板。
 */
const TransitionIncomingLyrics = memo(function TransitionIncomingLyrics({
  store,
  lyrics,
  trackId,
  accentColor,
  displayMode,
  scrollAlignment,
  backgroundEffect,
  playerTheme,
  lyricStyleMode,
  onActiveIndexChange,
}: {
  store: TransitionVisualStore | null
  lyrics: NonNullable<ComponentProps<typeof LyricsDisplay>['lyrics']>
  trackId: string | number | undefined
  accentColor: string
  displayMode: ComponentProps<typeof LyricsDisplay>['displayMode']
  scrollAlignment: ComponentProps<typeof LyricsDisplay>['scrollAlignment']
  backgroundEffect: ComponentProps<typeof LyricsDisplay>['backgroundEffect']
  playerTheme: 'light' | 'dark'
  lyricStyleMode: ComponentProps<typeof LyricsDisplay>['lyricStyleMode']
  onActiveIndexChange: (index: number) => void
}) {
  const targetTime = useTransitionTargetTime(store)
  const progress = useTransitionLyricsCrossfade(store)
  if (!store) return null
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ opacity: progress, pointerEvents: 'none' }}>
      <LyricsDisplay
        currentTime={targetTime}
        lyrics={lyrics}
        trackId={trackId}
        isPlaying
        accentColor={accentColor}
        displayMode={displayMode}
        scrollAlignment={scrollAlignment}
        backgroundEffect={backgroundEffect}
        playerTheme={playerTheme}
        lyricStyleMode={lyricStyleMode}
        // 交叉期间不叠翻译/罗马音：宿主另有翻译面板，叠两层会重复
        translationEnabled={false}
        romanEnabled={false}
        managedCrossfade
        onActiveIndexChange={onActiveIndexChange}
      />
    </div>
  )
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

/**
 * 看歌兜底（搜索失败）时把全局控件挂到 body：看歌 surface(z-10, absolute inset-0) 会盖住
 * minimal-playback-surface 的 transform 层叠上下文（willChange:transform 让其常驻合成层），
 * 内联渲染的固定位控件会被看歌蒙层盖住 → "控件消失"。与顶部歌词模式切换同款逃逸手段。
 * 包一层 fixed+w-0+h-0+z-60：不拦截事件（零尺寸），子元素固定定位仍相对视口且位于最上层。
 */
function MaybePortal({ active, children }: { active: boolean; children: ReactNode }) {
  return active
    ? createPortal(<div className="fixed top-0 left-0 z-[60] w-0 h-0">{children}</div>, document.body)
    : <>{children}</>
}

type LiveMiniPlayerProps = Omit<ComponentProps<typeof MiniPlayer>, 'currentTime'> & {
  playbackTimeStore: PlaybackTimeStore
  /** 外部时间源覆盖（看歌模式：迷你播放器按视频进度显示） */
  externalCurrentTime?: number
}

const LiveMiniPlayer = memo(function LiveMiniPlayer({
  playbackTimeStore,
  externalCurrentTime,
  ...props
}: LiveMiniPlayerProps) {
  const storeTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime

  return <MiniPlayer {...props} currentTime={externalCurrentTime ?? storeTime} />
})

type LiveUpNextNotificationProps = Omit<ComponentProps<typeof LazyUpNextNotification>, 'secondsRemaining'> & {
  playbackTimeStore: PlaybackTimeStore
  eventTime: number
}

const LiveUpNextNotification = memo(function LiveUpNextNotification({
  playbackTimeStore,
  eventTime,
  ...props
}: LiveUpNextNotificationProps) {
  const currentTime = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  ).currentTime

  return <LazyUpNextNotification {...props} secondsRemaining={eventTime - currentTime} />
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
type LyricDisplayMode = 'modern' | 'immersive' | 'wallpaper' | 'glorious' | 'multidimensional' | 'modeng' | 'video' | 'folia' | 'pv'

const LYRIC_MODE_VISIBILITY_KEY = 'waveforge_visible_lyric_modes'
const LYRIC_MODE_MODENG_MIGRATED_KEY = 'waveforge_modeng_mode_migrated'
const LYRIC_MODE_VIDEO_MIGRATED_KEY = 'waveforge_video_mode_migrated'
const LYRIC_MODE_PV_MIGRATED_KEY = 'waveforge_pv_mode_migrated'
/** Folia 歌词样式（vendored Project Folia 可视化器）的持久化 key 与默认样式 */
const FOLIA_STYLE_KEY = 'waveforge_folia_style'
/** Folia 样式选择条的顺序（用户拖动排序）；缺项按默认顺序追加，升级新增样式不会消失 */
const FOLIA_STYLE_ORDER_KEY = 'waveforge_folia_style_order'
/** Folia 样式的显示/隐藏集合（与 WaveForge 模式那份互相独立） */
const FOLIA_STYLE_VISIBILITY_KEY = 'waveforge_visible_folia_styles'
/** WaveForge 歌词模式的显示顺序（用户拖动排序） */
const LYRIC_MODE_ORDER_KEY = 'waveforge_lyric_mode_order'
/** 站在 Folia 页签时菜单不列它自己：这个页签下 Folia 天然是开着的 */
const FOLIA_PAGE_SELF_MODE: LyricDisplayMode = 'folia'
/** 可见数下限：Folia 侧至少留两个，避免选择条被关空 */
const MIN_VISIBLE_FOLIA_STYLES = 2
const ALL_LYRIC_MODES: LyricDisplayMode[] = ['modern', 'immersive', 'wallpaper', 'glorious', 'multidimensional', 'modeng', 'video', 'folia', 'pv']
const LYRIC_MODE_NAMES: Record<LyricDisplayMode, string> = {
  modern: '现代',
  immersive: '沉浸式',
  wallpaper: '墙纸',
  glorious: '辉煌',
  multidimensional: '多维',
  modeng: '摩登',
  video: '看歌',
  folia: 'Folia',
  pv: 'PV',
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
          // PV（pv-tool 移植歌词模式）为新增模式：同样一次性补回
          if (!withModern.includes('pv') && !localStorage.getItem(LYRIC_MODE_PV_MIGRATED_KEY)) {
            const withPv = [...withModern, 'pv' as LyricDisplayMode]
            localStorage.setItem(LYRIC_MODE_PV_MIGRATED_KEY, '1')
            localStorage.setItem(LYRIC_MODE_VISIBILITY_KEY, JSON.stringify(withPv))
            return withPv
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
  /** 过渡视觉轨道 store：传入时用它的逐帧进度（30fps 直达本组件，只重渲染整页背景层） */
  transitionVisualStore?: TransitionVisualStore | null
  pulseStore: AudioPulseStore
  backgroundEffect: 'transparent' | 'blur' | 'immersive' | 'modern'
  backgroundBlur: number
  isPlaying: boolean
  playerTheme: 'light' | 'dark'
}

/**
 * 律动包络对背景缩放「额外贡献」的系数（0~1，越小越含蓄）。
 *
 * `--cover-pulse-scale` 的包络峰值约 0.2（`useAudioPulse` 里对 inputs 全部做了
 * `Math.min` 钳制），原样叠加到 `baseScale`(1.1) 上会让整屏背景在 **1.10 ~ 1.31**
 * 之间起伏 —— 尤其「躁动」档的 punch 是每拍一次 32ms 起跳的脉冲，
 * 观感是背景跟着鼓点一撑一撑地跳，幅度明显压过其余所有律动
 * （歌词当前句 / 封面卡 / 频谱条都只有 2~3%）。这里压到 40%
 * （上限 ≈ +0.08 → 1.18），保留呼吸感但不再「跳」。
 *
 * ⚠️ 只调这一个系数，**不要**去改 `useAudioPulse` 的钳制值 —— 那个包络还被
 * folia 运镜 / 歌词 / 封面卡 / 频谱条共用，动它会连带改掉那一串效果。
 */
const PULSE_SCALE_GAIN = 0.4

const PulsingCrossfadeBackground = memo(function PulsingCrossfadeBackground({
  pulseStore,
  backgroundEffect,
  backgroundBlur,
  isPlaying,
  playerTheme,
  transitionVisualStore = null,
  transitionProgress = 0,
  ...crossfadeProps
}: PulsingCrossfadeBackgroundProps) {
  const storeBackgroundProgress = useTransitionOverlayProgress(transitionVisualStore, transitionProgress)
  const activeBackgroundProgress = transitionVisualStore ? storeBackgroundProgress : transitionProgress
  const pulseRootRef = useRef<HTMLDivElement>(null)
  const pulseHighlightRef = useRef<HTMLDivElement>(null)
  const isModernBackground = backgroundEffect === 'modern'
  const baseScale = backgroundEffect === 'immersive' ? 1.15 : 1.1
  // 窗口宽高比：普通长方形（16:9 / 16:10）整封面放大铺满即可；
  // 只有极端超宽（带鱼屏 ≥2:1）封面被裁得只剩一条时，才用「整图 + 糊底」兜底。
  const [viewportAspect, setViewportAspect] = useState(() => (typeof window === 'undefined' ? 16 / 9 : window.innerWidth / Math.max(1, window.innerHeight)))
  useEffect(() => {
    const onResize = () => setViewportAspect(window.innerWidth / Math.max(1, window.innerHeight))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    // 脉冲写入节流：pulseStore 由音频分析驱动，实测每秒写入约 97 次
    // （--cover-pulse-scale 是继承型 CSS 变量，每次写入都会让整个背景子树重算样式，
    //   实测进入播放页 8 秒内 RecalcStyle 达 1325 次/816ms，是"进入播放页卡一下"的主因）。
    // 脉冲本身是缓慢的呼吸效果，30fps 视觉上无差别。
    const PULSE_MIN_INTERVAL_MS = 32
    // 白闪层的两级柔化（用户反馈了两次的「频闪」= 每拍整屏闪一下）：
    //
    // ① 拆基线：pulse.scale = 慢呼吸 + punch（punch 是 `useAudioPulse` 里
    //    每拍一次、32ms 起跳的冲击）。用一条 τ≈620ms 的慢线把两者分开，
    //    白闪层只取「呼吸的全部 + 冲击的 30%」—— 呼吸感保留，每拍闪白基本消失。
    //    冲击仍**完整**地驱动 `--cover-pulse-scale` 做背景缩放，那里的 0.055s
    //    transition 会把它化成柔和的一"撑"，本来就是「跳一下」而不是「闪」。
    // ② 再低通：残下的 30% 冲击还要过一遍 τ=120ms 的一阶低通，抹掉上升沿。
    //
    // ⚠️ 不要退回「只调 CSS transition」：原实现的 `transition: opacity 0.12s` 在
    //    32ms 的写入节奏下等效于 τ≈103ms 的低通，即"本来就平滑过"—— 真正刺眼的是
    //    每拍 0.17 的整屏提亮幅度本身，所以这里才必须去削 punch，而不是去调 transition。
    //    现在 transition 已彻底去掉（`transition: 'none'`），平滑完全由这里负责。
    const HIGHLIGHT_SMOOTH_MS = 120
    const BREATH_BASELINE_MS = 620
    const PUNCH_LEAK = 0.3
    let lastAppliedAt = 0
    let breathBaseline: number | null = null
    let smoothedHighlight: number | null = null
    const applyPulse = (now: number) => {
      const root = pulseRootRef.current
      const highlight = pulseHighlightRef.current
      if (!root || !highlight) return

      const pulse = pulseStore.getSnapshot()
      root.style.setProperty('--cover-pulse-scale', String(pulse.scale))

      const delta = lastAppliedAt === 0
        ? PULSE_MIN_INTERVAL_MS
        : Math.max(1, Math.min(160, now - lastAppliedAt))
      lastAppliedAt = now

      if (breathBaseline === null) {
        breathBaseline = pulse.scale
      } else {
        breathBaseline += (pulse.scale - breathBaseline) * (1 - Math.exp(-delta / BREATH_BASELINE_MS))
      }
      const flashScale = breathBaseline + (pulse.scale - breathBaseline) * PUNCH_LEAK
      // brightness/saturation 都正比于 scale，这里等价于"只把 scale 换成 flashScale"，
      // 不用去猜当前是 soft / dynamic / restless 哪一档的倍数。
      const ratio = pulse.scale > 1e-6 ? Math.min(1, flashScale / pulse.scale) : 0

      // Brightness/saturation used to rebuild the blurred full-screen filter every
      // frame. A composited soft-light layer produces the same visible flash while
      // keeping the expensive blur raster stable. The layer is now also de-punched
      // and low-pass filtered so a beat reads as a swell instead of a flicker.
      const target = Math.min(0.22, (pulse.brightness * 0.62 + pulse.saturation * 0.045) * ratio)
      if (smoothedHighlight === null) {
        smoothedHighlight = target
      } else {
        smoothedHighlight += (target - smoothedHighlight) * (1 - Math.exp(-delta / HIGHLIGHT_SMOOTH_MS))
      }
      highlight.style.opacity = String(smoothedHighlight)
    }

    const applyPulseThrottled = () => {
      const now = performance.now()
      if (now - lastAppliedAt < PULSE_MIN_INTERVAL_MS) return
      applyPulse(now)
    }

    applyPulse(performance.now())
    return pulseStore.subscribe(applyPulseThrottled)
  }, [pulseStore])

  const staticFilter = backgroundEffect === 'transparent'
    ? `blur(${backgroundBlur}px) brightness(1.1)`
    : backgroundEffect === 'blur'
      ? 'blur(40px)'
      : `blur(${backgroundBlur}px) saturate(1.3)`
  // 背景源图分辨率跟随实际模糊半径：模糊 0 时 128 源图铺满全屏会糊成像素块
  const backgroundArtworkSize = getBackgroundArtworkSize(backgroundEffect === 'blur' ? 40 : backgroundBlur)
  const crossfadeImageStyle = useMemo(() => ({
    filter: staticFilter,
    transform: `translate3d(0, 0, 0) scale(calc(${baseScale} + var(--cover-pulse-scale, 0) * ${PULSE_SCALE_GAIN}))`,
    transition: 'transform 0.055s linear, opacity 0.5s',
    willChange: 'transform' as const,
    // 摩登背景：封面图让位给流体层（保留挂载以便切回其它模式时无闪回）
    ...(isModernBackground ? { opacity: 0 } : {}),
  }), [baseScale, staticFilter, isModernBackground])

  // 智能比例：封面是正方形、屏幕是长方形（超宽屏更极端）。
  // 单纯 cover 会把方图放大裁成一条（超宽屏相当于把封面放大数倍），于是低模糊时改为
  // 「整图 contain（不裁不放大）+ 同图糊化铺底补两侧」，既不切封面也不留空。
  const backgroundBlurValue = backgroundEffect === 'blur' ? 40 : backgroundBlur
  // 极端宽高比阈值：16:9=1.78 / 16:10=1.6 走铺满；21:9=2.33 / 32:9 才兜底
  const EXTREME_ASPECT = 2.05
  const fitWholeCover = backgroundEffect !== 'transparent'
    && backgroundBlurValue < 16
    && viewportAspect >= EXTREME_ASPECT
    && !isModernBackground
  const fillImageStyle = useMemo(() => ({
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    // 补底层始终重糊：既遮住裁切痕迹，也不与上层整图争细节
    filter: `blur(${Math.max(30, backgroundBlurValue * 1.6)}px) saturate(1.25) brightness(0.6)`,
    transform: `translate3d(0, 0, 0) scale(calc(${baseScale} + var(--cover-pulse-scale, 0)))`,
    transition: 'transform 0.055s linear, opacity 0.5s',
    willChange: 'transform' as const,
  }), [backgroundBlurValue, baseScale])
  const fitImageStyle = useMemo(() => ({
    // 90% 视口高：整张封面完整可见，四周留一点呼吸位由糊化层补满（不留空、不裁切、不放大）
    backgroundSize: 'auto 90%',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    filter: backgroundBlurValue > 0 ? `blur(${backgroundBlurValue}px) saturate(1.15)` : 'none',
    transition: 'transform 0.055s linear, opacity 0.5s',
  }), [backgroundBlurValue])

  return (
    <div
      ref={pulseRootRef}
      className="absolute inset-0 overflow-hidden"
      style={{ ['--cover-pulse-scale' as string]: 0 }}
    >
      {isModernBackground && (
        <ModernFluidBackground coverUrl={crossfadeProps.coverUrl} isPlaying={isPlaying} playerTheme={playerTheme} />
      )}
      {fitWholeCover ? (
        <>
          {/* 补底：重糊环境层（小图即可，糊到看不出细节） */}
          <CrossfadeBackground {...crossfadeProps} transitionProgress={activeBackgroundProgress} imageStyle={fillImageStyle} artworkSize={128} />
          {/* 主体：整张封面等比 contain，不裁切、不过度放大 */}
          <CrossfadeBackground {...crossfadeProps} transitionProgress={activeBackgroundProgress} imageStyle={fitImageStyle} artworkSize={backgroundArtworkSize} />
        </>
      ) : (
        <CrossfadeBackground
          {...crossfadeProps}
          transitionProgress={activeBackgroundProgress}
          imageStyle={crossfadeImageStyle}
          artworkSize={backgroundArtworkSize}
        />
      )}
      <div
        ref={pulseHighlightRef}
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          opacity: 0,
          background: 'rgba(255, 255, 255, 0.34)',
          mixBlendMode: 'soft-light',
          // 刻意不加 transition：opacity 已经由上面的 applyPulse 做一阶低通，
          // 再叠一层 CSS transition 会在每 32ms 的写入节奏下反复重启，产生锯齿抖动
          // （正是「频闪」的另一半原因）。
          transition: 'none',
          willChange: 'opacity',
        }}
      />
    </div>
  )
})

function getSongKey(song: Song): string {
  // Apple：id 可能为 0（库内曲目 l. 前缀非数字），必须用 appleId 保证每首歌唯一——
  // 否则所有 AM 歌曲都是 apple-0，预载/URL 缓存/AutoMix 全部串歌（播放货不对板）
  return `${song.platform || 'netease'}-${song.mid || song.appleId || song.id}`
}

// 纯音乐判定（现代歌词模式：纯音乐时封面居中显示）。
// 只查前两行会漏掉"作曲/编曲信息在前、纯音乐提示在后"的歌曲——扫描全部歌词行；
// 空歌词也视为纯音乐（无歌词兜底居中）。各歌词加载路径统一走此函数，避免判定不一致。
const PURE_MUSIC_MARKERS = ['纯音乐', '无歌词', 'instrumental']
function detectPureMusic(lyrics: LyricLine[] | undefined | null): boolean {
  const lines = Array.isArray(lyrics) ? lyrics : []
  if (lines.length === 0) return true
  return lines.some(line => {
    const text = (line?.text || '').toLowerCase()
    return PURE_MUSIC_MARKERS.some(marker => text.includes(marker))
  })
}

function getSongIdentifiers(song: Song | null): string[] {
  if (!song) return []
  return [song.appleId, song.appleLibraryId, song.id, song.mid]
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

// 兼容后端透传的原始歌曲结构（网易云歌单详情等返回 { al, ar, dt } 而非归一化的 { album, artists, duration }），
// 在播放管线入口统一归一化，避免 createTrackFromSong / ensureSongLyrics 等处对 artists/album 直接解引用崩溃。
function normalizeRawSongShape(song: any): Song {
  if (!song || typeof song !== 'object') return song
  const hasRawShape = !Array.isArray(song.artists) && (song.al || song.ar || song.dt !== undefined)
  if (!hasRawShape) return song
  return {
    id: Number(song.id ?? 0),
    mid: song.mid || undefined,
    name: song.name || '',
    artists: Array.isArray(song.ar)
      ? song.ar.map((a: any) => ({ id: a?.id, name: a?.name || '', mid: a?.mid }))
      : (Array.isArray(song.artists) ? song.artists : []),
    album: {
      id: song.al?.id,
      name: song.al?.name || '',
      picUrl: song.al?.picUrl || '',
    },
    duration: Number(song.dt ?? song.duration ?? 0),
    platform: song.platform,
  }
}

function createTrackFromSong(song: Song, url?: string, dominantColor?: string): Track {
  const raw = song as any
  const artists = Array.isArray(song.artists)
    ? song.artists.map(a => a.name)
    : (Array.isArray(raw.ar) ? raw.ar.map((a: any) => a?.name || '') : [])
  return {
    id: song.id ?? raw.id,
    title: song.name || raw.name || '',
    artist: artists.join(', '),
    album: song.album?.name || raw.al?.name || '',
    coverUrl: song.album?.picUrl || raw.al?.picUrl || '',
    duration: Number(song.duration ?? raw.dt ?? 0) / 1000,
    url,
    dominantColor,
  }
}

// QQ 原始结构里歌曲 mid 可能落在 songmid/songMid（Song 类型未声明），做一次宽松读取。
type DeckIdentitySong = Song & { songmid?: string | null; songMid?: string | null }

/**
 * 播放 deck 元数据的唯一构造点（P0-2）：App 侧所有 preloadNext / loadAndPlay 注入点都必须
 * 经由此函数，否则引擎侧 qqTrackRef 拿到空身份 ⇒ AutoMix Enhanced 云端档（advanced/extreme）
 * 100% 静默降级 lite（用户设置的 extreme 从未生效）。
 * 只补曲目身份字段；url/trackKey/duration/albumId/albumCover/appleHls 等仍由调用点按原语义传入。
 */
function buildDeckMetadata(
  song: Song,
  url: string,
  index: number | undefined,
  extras: Omit<PreloadTrack, 'url' | 'index' | 'songId' | 'mid' | 'name' | 'artists'> = {},
): PreloadTrack {
  const raw = song as DeckIdentitySong
  const mid = [raw.mid, raw.songmid, raw.songMid].find((value): value is string => typeof value === 'string' && value.length > 0)
  const artists = Array.isArray(song.artists) ? song.artists.map(artist => artist?.name).filter(Boolean) : []
  return {
    url,
    index,
    ...extras,
    songId: song.id ?? mid,
    ...(mid ? { mid } : {}),
    ...(song.name ? { name: song.name } : {}),
    ...(artists.length > 0 ? { artists } : {}),
  }
}

/**
 * 切歌 toast 展示"实际档位"（P1-12）：这两个字段在 TransitionDebugInfo 上由主负责人补充（可选），
 * 此处做宽松读取——字段缺席时 toast 保持原有内容。
 */
function readEnhancedTierDebug(info: TransitionDebugInfo | null): { appliedTier?: string; tierFallbackReason?: string } {
  const raw = info as (TransitionDebugInfo & { qqAppliedTier?: string; tierFallbackReason?: string }) | null
  return { appliedTier: raw?.qqAppliedTier, tierFallbackReason: raw?.tierFallbackReason }
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

// ─────────────── 汽水换源提示（可感知化：审计三「静默换源」修复）───────────────
/** 汽水 /song/url 不可播原因 → 中文短语（reason 口径与后端 sodaUnavailableResult 一致） */
const SODA_UNAVAILABLE_REASON_TEXT: Record<string, string> = {
  svip_required: '需 SVIP 权益',
  vip_required: '需 VIP 权益',
  membership_unknown: '会员状态验证中',
  login_required: '汽水未登录',
  missing_id: '歌曲信息异常',
  session_rejected: '汽水登录已失效，请重新扫码',
}

/**
 * 汽水源不可播 → 换源提示文案。
 * 统一以「汽水·」前缀标注来源平台，避免用户把切过来的网易云/QQ 版本误认为汽水原唱。
 */
const buildSodaSourceSwitchToast = (
  song: Song,
  info: { requiredTier?: 'free' | 'vip' | 'svip'; vipLabel?: string; reason?: string } | null,
): string => {
  const artistName = song.artists?.[0]?.name || ''
  const heading = artistName ? `汽水·${artistName}《${song.name}》` : `汽水《${song.name}》`
  const tier: 'SVIP' | 'VIP' | '' =
    info?.requiredTier === 'svip'
      ? 'SVIP'
      : info?.requiredTier === 'vip'
        ? 'VIP'
        : /svip/i.test(String(info?.vipLabel || ''))
          ? 'SVIP'
          : /^vip/i.test(String(info?.vipLabel || ''))
            ? 'VIP'
            : ''
  // 会员档位场景：「汽水·周杰伦《xxx》需 SVIP，已切换其他来源版本」
  if (tier) return `${heading}需 ${tier}，已切换其他来源版本`
  // 其余场景（音源解析失败/未登录等）：「汽水《xxx》暂不可播（音源暂时无法解析），已切换其他来源版本」
  const why = SODA_UNAVAILABLE_REASON_TEXT[String(info?.reason || '')] || '音源暂时无法解析'
  return `${heading}暂不可播（${why}），已切换其他来源版本`
}

function App() {
  // 视图模式状态（探索 / 简约 / 桌面）
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem('viewMode')
    let mode: ViewMode = saved === 'explore' || saved === 'minimal' || saved === 'traditional' || saved === 'desktop' || saved === 'resonance' ? saved : 'minimal'
    // 上次是「共振」时不要一头扎进共振：回到进共振之前的那个模式，
    // 免得用户关客户端时正好在共振里，下次启动还得手动切出来。
    if (mode === 'resonance') {
      const previous = readResonanceEntryMode()
      if (previous === 'explore' || previous === 'minimal' || previous === 'traditional' || previous === 'desktop') mode = previous
      else mode = 'minimal'
    }
    // TV 效能档隐藏桌面模式（普通/增强显示）：历史保存值也不会恢复成桌面
    return isTv() && isPerfModeEfficiency() && mode === 'desktop' ? 'minimal' : mode
  })
  const viewModeChangeRevisionRef = useRef(0)
  // 已访问过的模式：切走只隐藏、不卸载（与「播放页覆盖时不卸载」同一套做法）。
  // 卸载再挂载会把已加载内容、滚动位置、打开中的弹窗全部丢掉，切回来等于重新请求一遍数据；
  // 只保留真正访问过的模式，冷启动不会把其它模式的请求一起打出去。
  const [visitedModes, setVisitedModes] = useState<Set<ViewMode>>(() => new Set([viewMode]))
  if (!visitedModes.has(viewMode)) setVisitedModes(previous => new Set(previous).add(viewMode))
  const visitedModesRef = useRef(visitedModes)
  visitedModesRef.current = visitedModes
  // 房间还在时切模式的「挂起 / 退出」询问；bypass 用于让用户选完之后放行同一次切换
  const [resonanceExitPrompt, setResonanceExitPrompt] = useState<{ next: ViewMode } | null>(null)
  const resonanceModeSwitchBypassRef = useRef(false)
  // 桌面融合穿透：桌面模式空区域鼠标穿透到真实桌面（退出 kiosk + 组件区可交互）
  const [desktopFusionEnabled, setDesktopFusionEnabled] = useState(() => localStorage.getItem('desktopFusionEnabled') === 'true')
  // 开启融合需重建窗口（会中断播放/重载界面），先弹应用内确认框（参考删除歌单弹窗）
  const [showFusionConfirm, setShowFusionConfirm] = useState(false)
  const handleDesktopFusionChange = useCallback(async (enabled: boolean) => {
    if (enabled) {
      // 开启穿透需要把主窗口重建为透明窗口（transparent 仅创建时生效，普通模式用原生
      // 不透明窗口+系统圆角）——先弹应用内确认框，确认后由 confirmEnableFusion 重建
      setShowFusionConfirm(true)
      return
    }
    setDesktopFusionEnabled(false)
    localStorage.setItem('desktopFusionEnabled', 'false')
    try { await window.electron?.desktopFusion.setEnabled(false) } catch { /* 忽略 */ }
  }, [])
  // 确认开启融合：先写 localStorage，主进程销毁重建为透明窗口（本实例随旧窗口销毁，
  // 新窗口启动时据此恢复融合态）；invoke 通道随窗口销毁关闭，异常可忽略
  const confirmEnableFusion = useCallback(async () => {
    setShowFusionConfirm(false)
    localStorage.setItem('desktopFusionEnabled', 'true')
    try { await window.electron?.desktopFusion.setEnabled(true) } catch { /* 忽略 */ }
  }, [])
  // 重启后同步主进程窗口状态（退出 kiosk / 置顶等），保证与 localStorage 一致
  useEffect(() => {
    if (desktopFusionEnabled) void window.electron?.desktopFusion.setEnabled(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 融合穿透的鼠标悬停检测只在桌面模式（DesktopView 内）运行；融合开启且处于其他
  // 模式（简约播放页/探索/传统）时，应用 UI 铺满全窗、没有可穿透的空区域，
  // 整窗强制可交互，避免 DesktopView 卸载后窗口残留 click-through（什么都点不了）。
  // 例如：融合开启时点迷你播放器进播放页，播放页必须可操作。
  useEffect(() => {
    if (!desktopFusionEnabled) return
    if (viewMode !== 'desktop') {
      window.electron?.desktopFusion?.setInteractive(true)
    }
  }, [desktopFusionEnabled, viewMode])
  // 模式切换过渡动画：全屏覆盖掩盖新模式挂载卡顿。to=目标模式，ready=目标内容已就绪，
  // 收起条件 = ready 且 时长 ≥ 最短 3s（慢机 5~10s 加载期间动画无限循环，不会"断片"）。
  const [modeTransition, setModeTransition] = useState<{ to: 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance'; startedAt: number; ready: boolean; quick?: boolean } | null>(null)
  const modeTransitionRef = useRef(modeTransition)
  modeTransitionRef.current = modeTransition
  // 转场动画风格 / 音效（设置 → 个性化；全局设置注册表 'transition' 组同键同事件）
  const [modeTransitionStyle, setModeTransitionStyleState] = useState<ModeTransitionStyle>(() => getModeTransitionStyle())
  const [modeTransitionSoundOn, setModeTransitionSoundOnState] = useState(() => isModeTransitionSoundEnabled())
  // 模式切换事件监听是挂载一次的长闭包，读风格要用 ref 拿最新值（直接读 state 会拿到过期值）
  const modeTransitionStyleRef = useRef(modeTransitionStyle)
  modeTransitionStyleRef.current = modeTransitionStyle
  useEffect(() => {
    const syncStyle = () => setModeTransitionStyleState(getModeTransitionStyle())
    const syncSound = () => setModeTransitionSoundOnState(isModeTransitionSoundEnabled())
    window.addEventListener(MODE_TRANSITION_STYLE_EVENT, syncStyle)
    window.addEventListener(MODE_TRANSITION_SOUND_EVENT, syncSound)
    window.addEventListener('waveforge:global-setting-changed', syncStyle)
    window.addEventListener('waveforge:global-setting-changed', syncSound)
    return () => {
      window.removeEventListener(MODE_TRANSITION_STYLE_EVENT, syncStyle)
      window.removeEventListener(MODE_TRANSITION_SOUND_EVENT, syncSound)
      window.removeEventListener('waveforge:global-setting-changed', syncStyle)
      window.removeEventListener('waveforge:global-setting-changed', syncSound)
    }
  }, [])
  const viewModeRef = useRef<ViewMode>(viewMode)
  viewModeRef.current = viewMode
  
  const [currentTrack, setCurrentTrack] = useState<Track>({
    title: 'WaveForge',
    artist: '点击搜索按钮开始',
    album: 'Demo Album',
    coverUrl: '', // 初始为空，避免加载随机图片
    duration: 240,
  })
  
  const [isPlaying, setIsPlaying] = useState(false)
  // App only commits playback time when a discrete presentation boundary changes.
  // Progress bars and other continuous consumers subscribe to playbackTimeStore locally.
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeRef = useRef(0)
  /** 模式切换交接用的最近有效歌曲进度；媒体重挂载期间不得用 0 覆盖它。 */
  const modeHandoffTimeRef = useRef<{ songKey: string; time: number } | null>(null)
  const currentTimeCommitGateRef = useRef(createPlaybackTimeCommitGate())
  const commitCurrentTime = useCallback((value: number) => {
    currentTimeRef.current = value
    setCurrentTime(value)
  }, [])
  const [duration, setDuration] = useState(0)
  /** 当前曲目是否由 WebView2 播放面播放（外部播放源模式；驱动频谱/分析器走 bridge 数据源） */
  const [externalPlaybackActive, setExternalPlaybackActive] = useState(false)
  /** 当前曲目是否为直播流（Apple 电台等；直播时播放器显示 LIVE 指示、禁拖动） */
  const [isLive, setIsLive] = useState(false)
  const [volume, setVolume] = useState(1.0) // 默认音量100%
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showMixingStudio, setShowMixingStudio] = useState(false)
  const [showRemote, setShowRemote] = useState(false)
  // 播放设备控制弹窗（音频输出设备 / AirPlay 投送）
  const [showDeviceControl, setShowDeviceControl] = useState(false)
  const [showSongDetail, setShowSongDetail] = useState(false)
  const [songDetailSong, setSongDetailSong] = useState<Song | null>(null)
  const [showSimilarSongs, setShowSimilarSongs] = useState(false)
  const [similarSongsSource, setSimilarSongsSource] = useState<Song | null>(null)
  // 歌曲详情「也爱歌单」应用内打开。
  // 数据（detailPlaylist）与可见性（detailPlaylistOpen）刻意分开：关闭只把可见性置 false，
  // 让面板退场动画跑完（期间数据/封面/动态 HLS 全程冻结），退场结束后才清空数据。
  // 此前关闭是同帧 setDetailPlaylist(null)，面板与封面一起卸载 → 内部 AnimatePresence 的
  // exit 从不执行（表现为"关不掉/直接消失"），且 60px 封面模糊与 80px backdrop 模糊
  // 在同一帧被销毁重排，就是关闭掉帧与封面闪烁的来源。
  const [detailPlaylist, setDetailPlaylist] = useState<{ playlist: any; songs: Song[] } | null>(null)
  const [detailPlaylistOpen, setDetailPlaylistOpen] = useState(false)
  const [detailPlaylistLoading, setDetailPlaylistLoading] = useState(false)  // 退场回调在动画完成时执行，需要读"此刻"是否又打开了面板，故用 ref 同步可见性
  const detailPlaylistOpenRef = useRef(false)
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
  // 过渡调试弹窗：显示本次过渡用的引擎/策略/DJ 效果清单（受"过渡调试"开关控制）
  const [transitionDebugToast, setTransitionDebugToast] = useState<TransitionDebugInfo | null>(null)
  const transitionDebugToastTimerRef = useRef<number | null>(null)
  // 卸载时清理弹窗定时器，避免卸载后 setState
  useEffect(() => () => {
    if (engineSwitchToastTimerRef.current !== null) window.clearTimeout(engineSwitchToastTimerRef.current)
    if (gaplessModeToastTimerRef.current !== null) window.clearTimeout(gaplessModeToastTimerRef.current)
    if (transitionDebugToastTimerRef.current !== null) window.clearTimeout(transitionDebugToastTimerRef.current)
  }, [])
  // 调音室弹窗锚点：记录打开按钮的位置，弹窗从按钮侧弹出/关闭时收缩回按钮
  const mixingStudioAnchorRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  useEffect(() => {
    const currentViewLoader = viewMode === 'explore'
      ? loadExploreView
      : viewMode === 'desktop'
        ? loadDesktopView
        : viewMode === 'traditional'
          ? loadTraditionalView
          : loadHomeView
    const alternateViewLoaders = [loadHomeView, loadExploreView, loadTraditionalView, loadDesktopView, loadResonanceView]
      .filter(loader => loader !== currentViewLoader)

    void currentViewLoader()
    // TV 效能档跳过 idle 预载：10+ 个懒加载 chunk（含全部备用视图/弹窗）常驻解析后的 JS，
    // 弱机内存吃紧——按需加载首开多等几百毫秒换取更小的常驻内存（隔离：仅 TV 效能档）
    if (isTvModeActive() && isPerfModeEfficiency()) return
    return preloadOnIdle([
      loadSearchPanel,
      loadUpNextNotification,
      loadSettingsPanel,
      loadPlaylistPanel,
      loadLoginView,
      loadProfileView,
      loadArtistDetailModal,
      loadAlbumDetailModal,
      loadCommentModal,
      ...alternateViewLoaders,
    ], 2000)
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
  /** 非空时表示要直接打开某个用户的主页（而非自己），由歌单创建者等入口设置 */
  const [profileUserTarget, setProfileUserTarget] = useState<{ platform: 'netease' | 'qq'; userId: string; nickname?: string } | null>(null)

  const [showHome, setShowHome] = useState(true) // 控制简约模式首页显示
  const [showSharedPlayer, setShowSharedPlayer] = useState(false)
  const [enteredFromMode, setEnteredFromMode] = useState<ViewMode>('minimal') // 记录进入来源，用于返回时恢复状态
  // 遥控器/快捷键 Home 的恢复依据（ref 读最新值，避免事件监听闭包拿到旧状态）：
  // 桌面模式播放被旧逻辑拽进播放页时，Home 应把用户送回桌面而不是 minimal 主页
  const enteredFromModeRef = useRef<ViewMode>(enteredFromMode)
  enteredFromModeRef.current = enteredFromMode
  const playbackOriginRef = useRef<PlaybackOrigin>({ mode: 'minimal', surface: 'home' })
  // 当前播放队列是否来自 QQ「刷歌」：刷歌播放页/播放页右键菜单据此提供「音乐偏好设置」
  const [radarPlaybackActive, setRadarPlaybackActive] = useState(false)
  const [qqMusicPreferenceOpen, setQQMusicPreferenceOpen] = useState(false)
  // 全局入口：探索页右键 / 刷歌播放器滑杆按钮 / 播放页右键都派发该事件
  useEffect(() => {
    const handleOpenMusicPreference = () => setQQMusicPreferenceOpen(true)
    window.addEventListener('waveforge:qq-open-music-preference', handleOpenMusicPreference)
    return () => window.removeEventListener('waveforge:qq-open-music-preference', handleOpenMusicPreference)
  }, [])
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
  // 多歌手「查看歌手」选择器：{ song } 有值时弹出（背景用该曲封面）
  const [artistPicker, setArtistPicker] = useState<{ show: boolean; song: Song | null }>({ show: false, song: null })
  const [selectedArtistId, setSelectedArtistId] = useState<string | null>(null)
  const [selectedArtistPlatform, setSelectedArtistPlatform] = useState<MusicPlatform>('netease')
  // 歌手名提示：QQ 纯数字 singer_id 反查真 mid 时按名采信（handleOpenArtist 记录）
  const [selectedArtistName, setSelectedArtistName] = useState('')
  const [showAlbumDetail, setShowAlbumDetail] = useState(false)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [selectedAlbumPlatform, setSelectedAlbumPlatform] = useState<MusicPlatform>('netease')
  const [selectedArtistAlbumId, setSelectedArtistAlbumId] = useState<string | number | undefined>()
  const [selectedArtistTab, setSelectedArtistTab] = useState<PlaybackOrigin['artistTab']>('hotSongs')
  // 导航栈：支持歌曲详情、艺人和专辑之间反向关闭
  const navigationStack = useRef<Array<
    | { type: 'artist' | 'album'; id: string; platform: MusicPlatform; tab?: string }
    | { type: 'song'; song: Song }
  >>([])
  const [showCommentModal, setShowCommentModal] = useState(false)
  const [selectedCommentSong, setSelectedCommentSong] = useState<Song | null>(null)
  const [currentSongLiked, setCurrentSongLiked] = useState(false)
  const [playbackContextPlaylists, setPlaybackContextPlaylists] = useState<any[]>([])
  const [playbackContextPlaylistsLoading, setPlaybackContextPlaylistsLoading] = useState(false)
  
  const [canonicalLyrics, setLyrics] = useState<LyricLine[]>([])
  const [appleCoverUrl, setAppleCoverUrl] = useState<string | null>(null)
  const [lyricOffset, setLyricOffset] = useState(() => Number(localStorage.getItem('lyricOffset')) || 0)
  const [lyricStyleMode, setLyricStyleMode] = useState<LyricStyleMode>(readLyricStyleMode)
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

  const appleNativePreloadKeyRef = useRef('')
  const appleNativePreloadAttemptsRef = useRef<Map<string, number>>(new Map())
  const appleNativePreloadRetryTimerRef = useRef<number | null>(null)

  const bumpQueueRevision = useCallback(() => {
    const nextRevision = queueRevisionRef.current + 1
    queueRevisionRef.current = nextRevision
    appleNativePreloadAttemptsRef.current.clear()
    if (appleNativePreloadRetryTimerRef.current !== null) {
      window.clearTimeout(appleNativePreloadRetryTimerRef.current)
      appleNativePreloadRetryTimerRef.current = null
    }
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
    lyricsPolicyKey?: string
  }>>(new Map())
  const lyricsCacheGenerationRef = useRef(0)
  const lyricsPolicyFingerprintRef = useRef('')
  const audioUrlCacheGenerationRef = useRef(0)
  const audioPlayerCacheControlRef = useRef<{
    cancelTransition: (reason?: string, preserveNext?: boolean, announceCancellation?: boolean) => void
  } | null>(null)

  useEffect(() => {
    const invalidatePreloadedAudioUrls = () => {
      audioUrlCacheGenerationRef.current += 1
      appleNativePreloadKeyRef.current = ''
      appleNativePreloadAttemptsRef.current.clear()
      if (appleNativePreloadRetryTimerRef.current !== null) {
        window.clearTimeout(appleNativePreloadRetryTimerRef.current)
        appleNativePreloadRetryTimerRef.current = null
      }
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

    // 设置页「清理全部」：预载缓存此前没有任何外部清理入口，只能等 5 分钟 TTL /
    // 上限 30 条的定期回收自然收敛。
    const clearPreloadCache = () => {
      preloadCacheRef.current.clear()
    }

    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, invalidatePreloadedAudioUrls)
    window.addEventListener('waveforge-auth-changed', invalidatePreloadedAudioUrls)
    window.addEventListener('waveforge:url-cache-cleared', clearPreloadCache)
    return () => {
      window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, invalidatePreloadedAudioUrls)
      window.removeEventListener('waveforge-auth-changed', invalidatePreloadedAudioUrls)
      window.removeEventListener('waveforge:url-cache-cleared', clearPreloadCache)
    }
  }, [])

  useEffect(() => () => {
    if (appleNativePreloadRetryTimerRef.current !== null) {
      window.clearTimeout(appleNativePreloadRetryTimerRef.current)
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
  const lyricArrowHintTimerRef = useRef<number | null>(null)
  // 歌词模式切换序号：chunk 预载把 setState 推迟了，快速连点时迟到请求不得覆盖最新目标
  const lyricModeSwitchSeqRef = useRef(0)
  const suppressUpNextUntilRef = useRef(0)
  
  // 添加Toast的辅助函数（timer 收进 Set，卸载时统一清理，防 HMR/重挂载后对已卸载组件 setState）
  const toastTimersRef = useRef<Set<number>>(new Set())
  // 引用稳定性：addToast 被 RESONANCE_PUSH_EVENT 监听 effect 列为依赖，若每次渲染重建
  // 就会反复退订/重订 window 监听。函数体只用到 ref 与 setState，依赖为空即可。
  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info', accentColor?: string, duration = 4000) => {
    const id = toastIdRef.current++
    setToasts(prev => [...prev, { id, message, type, accentColor }])
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(timer)
      setToasts(prev => prev.filter(t => t.id !== id))
    }, duration)
    toastTimersRef.current.add(timer)
  }, [])

  useEffect(() => () => {
    if (playModeToastTimerRef.current !== null) window.clearTimeout(playModeToastTimerRef.current)
    if (lyricArrowHintTimerRef.current !== null) window.clearTimeout(lyricArrowHintTimerRef.current)
    toastTimersRef.current.forEach(t => window.clearTimeout(t))
    toastTimersRef.current.clear()
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

  // MV 背景设置（B 站视频作为歌词背景层）
  const [mvBackgroundEnabled, setMvBackgroundEnabled] = useState(() => {
    const saved = localStorage.getItem('mvBackgroundEnabled')
    return parseStoredBoolean(saved, false)
  })
  // MV 背景回退：未找到 MV / 播放失败时自动切回普通封面背景（由 BilibiliMvBackground 上报）
  const [mvBackgroundFallback, setMvBackgroundFallback] = useState(false)
  // 搜索到 MV 不等于视频已经出画面；在 canplay 前保留封面兜底，避免播放页黑屏或透出上一页。
  const [mvBackgroundReady, setMvBackgroundReady] = useState(false)

  // Apple「自动连播」（官方 stations/continuous 协议，∞ 开关在 Apple 播放列表面板）
  const [appleAutoplayEnabled, setAppleAutoplayEnabled] = useState(() => readAppleAutoplayEnabled())
  const appleAutoplayRef = useRef<{ seedKey: string; stationId?: string; disabled?: boolean }>({ seedKey: '' })
  useEffect(() => {
    const handler = (event: Event) => setAppleAutoplayEnabled(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener(APPLE_AUTOPLAY_CHANGED_EVENT, handler)
    return () => window.removeEventListener(APPLE_AUTOPLAY_CHANGED_EVENT, handler)
  }, [])

  // OOBE：默认不启用，仅由 设置→高级 卡片通过事件手动触发（计数器作 key，可重复触发）
  const [oobeOpenCount, setOobeOpenCount] = useState(0)

  // 纯音乐模式状态
  const [isPureMusic, setIsPureMusic] = useState(false)
  const [lyricDisplayMode, setLyricDisplayMode] = useState<LyricDisplayMode>(() => {
    const saved = localStorage.getItem('lyricDisplayMode')
    const mode = saved === 'immersive' || saved === 'wallpaper' || saved === 'glorious' || saved === 'multidimensional' || saved === 'modeng' || saved === 'video' || saved === 'folia' || saved === 'pv' ? saved : 'modern'
    // TV 效能档：WebGL（多维/Folia）与 Pixi（PV）级歌词不可承受，历史选择直接回落摩登
    if (isTvModeActive() && isPerfModeEfficiency() && TV_HEAVY_LYRIC_MODES.includes(mode)) return 'modern'
    return mode
  })
  // 摩登模式状态 ref：resolveAppleCover 等回调读取最新值（AM 封面仅摩登使用）
  const lyricDisplayModeRef = useRef(lyricDisplayMode)
  lyricDisplayModeRef.current = lyricDisplayMode
  useEffect(() => {
    const loader = LYRIC_MODE_LOADERS[lyricDisplayMode]
    if (!loader) return
    return preloadOnIdle([loader], 350)
  }, [])
  const [modernAudioVisualizerEnabled, setModernAudioVisualizerEnabled] = useState(() => {
    const saved = localStorage.getItem('modernAudioVisualizerEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showLyricModePanel, setShowLyricModePanel] = useState(false)
  const [showLyricModeCustomize, setShowLyricModeCustomize] = useState(false)
  // 歌词面板第二页：Folia 歌词样式（vendored Project Folia 可视化器，12 种样式）
  const [lyricPanelPage, setLyricPanelPage] = useState<'waveforge' | 'folia'>('waveforge')
  const [foliaStyle, setFoliaStyle] = useState<string>(() => {
    const saved = localStorage.getItem(FOLIA_STYLE_KEY)
    // 绘光的光场与 bloom 都是 GLSL，上游在非 WebGL 下直接 throw。GPU 被禁用/软件渲染时
    // 开机就回落到静止（纯 DOM），避免整个歌词页打空。
    return resolveFoliaStyleFallback(saved || 'classic')
  })
  // 探测一次即可（要建临时 canvas，不该每次切样式都做）
  const lumiereSupported = useMemo(() => supportsLumiere(), [])
  // ── Folia 样式的顺序与显示/隐藏（与 WaveForge 模式那份偏好互相独立）──
  const foliaStyleIds = useMemo(() => FOLIA_STYLES.map(style => style.id), [])
  const [foliaStyleOrder, setFoliaStyleOrder] = useState<string[]>(() => (
    readStoredOrder(FOLIA_STYLE_ORDER_KEY, FOLIA_STYLES.map(style => style.id))
    ?? FOLIA_STYLES.map(style => style.id)
  ))
  const [visibleFoliaStyles, setVisibleFoliaStyles] = useState<string[]>(() => {
    try {
      return parseStoredIdList(localStorage.getItem(FOLIA_STYLE_VISIBILITY_KEY))
        ?? FOLIA_STYLES.map(style => style.id)
    } catch {
      return FOLIA_STYLES.map(style => style.id)
    }
  })
  // ── WaveForge 歌词模式的显示顺序（可见性仍由既有 visibleLyricModes 负责）──
  const [lyricModeOrder, setLyricModeOrder] = useState<string[]>(() => (
    readStoredOrder(LYRIC_MODE_ORDER_KEY, ALL_LYRIC_MODES) ?? [...ALL_LYRIC_MODES]
  ))
  const orderedFoliaStyles = useMemo(
    () => mergeOrder(foliaStyleIds, foliaStyleOrder),
    [foliaStyleIds, foliaStyleOrder],
  )
  const effectiveVisibleFoliaStyles = resolveEffectiveVisible({
    allIds: orderedFoliaStyles,
    visible: visibleFoliaStyles,
    currentId: foliaStyle,
    minVisible: MIN_VISIBLE_FOLIA_STYLES,
  })
  const visibleFoliaStyleEntries = orderedFoliaStyles
    .filter(id => effectiveVisibleFoliaStyles.includes(id))
    .map(id => FOLIA_STYLES.find(style => style.id === id))
    .filter((style): style is (typeof FOLIA_STYLES)[number] => Boolean(style))
  const orderedLyricModes = useMemo(
    () => mergeOrder(ALL_LYRIC_MODES, lyricModeOrder).filter((mode): mode is LyricDisplayMode => ALL_LYRIC_MODES.includes(mode as LyricDisplayMode)),
    [lyricModeOrder],
  )
  const moveFoliaStyleTo = (id: string, targetIndex: number) => {
    const next = moveIdToIndex(orderedFoliaStyles, id, targetIndex)
    setFoliaStyleOrder(next)
    writeStoredOrder(FOLIA_STYLE_ORDER_KEY, next)
  }
  const moveLyricModeTo = (id: string, targetIndex: number) => {
    const next = moveIdToIndex(orderedLyricModes, id, targetIndex)
    setLyricModeOrder(next)
    writeStoredOrder(LYRIC_MODE_ORDER_KEY, next)
  }
  const toggleFoliaStyleVisibility = (id: string) => {
    const result = toggleVisible({
      allIds: orderedFoliaStyles,
      visible: visibleFoliaStyles,
      currentId: foliaStyle,
      minVisible: MIN_VISIBLE_FOLIA_STYLES,
      id,
    })
    if (!result.ok) return
    setVisibleFoliaStyles(result.visible)
    try {
      localStorage.setItem(FOLIA_STYLE_VISIBILITY_KEY, JSON.stringify(result.visible))
    } catch (error) {
      console.warn('保存 Folia 样式可见设置失败:', error)
    }
  }
  // Folia 是否使用自己的背景（latent 封面取色 shader）：关闭后改用 WaveForge 封面背景
  // （folia 层透明露出 App 的封面背景层）。默认开启，尊重喜欢 Folia 原生背景的用户。
  const [foliaBackgroundEnabled, setFoliaBackgroundEnabled] = useState(() => {
    const saved = localStorage.getItem('waveforge_folia_background')
    return saved === null || saved !== 'false'
  })
  const handleFoliaBackgroundToggle = () => {
    setFoliaBackgroundEnabled((prev) => {
      const next = !prev
      localStorage.setItem('waveforge_folia_background', JSON.stringify(next))
      return next
    })
  }
  // 打开歌词面板时按当前模式定位页：Folia 页模式直接落在第二页（样式页）
  useEffect(() => {
    if (showLyricModePanel) setLyricPanelPage(lyricDisplayModeRef.current === 'folia' ? 'folia' : 'waveforge')
  }, [showLyricModePanel])
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
  const [backgroundEffect, setBackgroundEffect] = useState<'transparent' | 'blur' | 'immersive' | 'modern'>(() => {
    const saved = localStorage.getItem('backgroundEffect')
    return (saved as 'transparent' | 'blur' | 'immersive' | 'modern') || 'blur'
  })
  
  // 背景模糊度（仅用于透明模式）
  const [backgroundBlur, setBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('backgroundBlur')
    return saved ? parseFloat(saved) : 30 // 默认值 30px
  })

  // MV 视频背景的独立模糊度：与封面背景两套设置，互不覆盖。
  // 视频背景默认 0（视频清晰显示）；用户调整后记住，切到封面背景时互不影响。
  const [mvBackgroundBlur, setMvBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('mvBackgroundBlur')
    const parsed = saved ? parseFloat(saved) : Number.NaN
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
  })
  useEffect(() => {
    const onMvBlur = (e: Event) => setMvBackgroundBlur((e as CustomEvent<number>).detail)
    window.addEventListener('mvBackgroundBlurChanged', onMvBlur as EventListener)
    return () => window.removeEventListener('mvBackgroundBlurChanged', onMvBlur as EventListener)
  }, [])
  
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
  const [autoMixEnhanced, setAutoMixEnhanced] = useState(() => {
    const saved = localStorage.getItem('autoMixEnhanced')
    return parseStoredBoolean(saved, false)
  })
  // 过渡引擎三选一（标准 / Pro / Enhanced）；旧版本只有 autoMixEnhanced 布尔值
  const [autoMixEngine, setAutoMixEngine] = useState<'standard' | 'pro' | 'enhanced'>(() => {
    const saved = localStorage.getItem('autoMixEngine')
    if (saved === 'standard' || saved === 'pro' || saved === 'enhanced') return saved
    return parseStoredBoolean(localStorage.getItem('autoMixEnhanced'), false) ? 'pro' : 'standard'
  })
  // AutoMix Enhanced 档位（Lite / Advanced / Extreme）
  const [autoMixEnhancedTier, setAutoMixEnhancedTier] = useState<'lite' | 'advanced' | 'extreme'>(() => {
    const saved = localStorage.getItem('autoMixEnhancedTier')
    return saved === 'advanced' || saved === 'extreme' ? saved : 'lite'
  })
  const [autoMixTransitionIntensity, setAutoMixTransitionIntensity] = useState<'subtle' | 'standard' | 'strong'>(() => {
    const saved = localStorage.getItem('autoMixTransitionIntensity')
    return saved === 'subtle' || saved === 'strong' ? saved : 'standard'
  })
  const [autoMixAiMix, setAutoMixAiMix] = useState(() => {
    const saved = localStorage.getItem('autoMixAiMix')
    return parseStoredBoolean(saved, false)
  })
  // DJTransGAN 是严格可选扩展：计划器只接收“用户开启且引擎完整可用”的有效值，
  // 避免删除模型后旧 localStorage=true 仍让时间线误走 60 秒 AI 路径。
  const [autoMixAiAvailable, setAutoMixAiAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!autoMixAiMix) {
      setAutoMixAiAvailable(false)
      return () => { cancelled = true }
    }
    void window.electron?.render?.aiMixStatus?.()
      .then(status => { if (!cancelled) setAutoMixAiAvailable(status?.available === true) })
      .catch(() => { if (!cancelled) setAutoMixAiAvailable(false) })
    return () => { cancelled = true }
  }, [autoMixAiMix])

  // 游戏模式（主进程会话级开关，重启软件自动回到标准模式）：
  // enabled = 模式开启（AutoMix 等重负载立即禁用）；frozen = 主窗已隐藏到托盘（10Hz 频谱 tick 冻结）
  const [gameModeEnabled, setGameModeEnabled] = useState(false)
  const [gameModeFrozen, setGameModeFrozen] = useState(false)
  const gameModeFrozenRef = useRef(false)
  gameModeFrozenRef.current = gameModeFrozen
  useEffect(() => {
    const api = window.electron?.gameMode
    if (!api) return
    void api.get?.().then((status) => {
      setGameModeEnabled(Boolean(status?.enabled))
      setGameModeFrozen(Boolean(status?.frozen))
    }).catch(() => undefined)
    return api.onChange?.((enabled, frozen) => {
      if (enabled !== undefined) setGameModeEnabled(Boolean(enabled))
      if (frozen !== undefined) setGameModeFrozen(Boolean(frozen))
    })
  }, [])

  // 冻结态势下发到渲染端全局快照：散落在 service/hook 里的后台循环（Apple 桥轮询、
  // 无缝衔接尾段监测、音频特效旋转、桌面挂件时钟等）按它自行降频，无需各自订阅 IPC
  useEffect(() => {
    setGameModeFrozenRuntime(gameModeFrozen)
  }, [gameModeFrozen])

  // 游戏模式冻结灯效/外部设备插件：Chroma 是 30fps setInterval 帧流（每帧逐设备 IPC + 本机 HTTP 请求），
  // 且 Chroma/SignalRGB 会持有分析器后台租约把 30Hz FFT 锁活——窗口隐藏后照样满速，必须显式停。
  // DG-LAB 同理：激活后 5s 中继状态轮询 + 30fps 特征推送 + 系统采集分析器都不会因窗口隐藏而停，
  // 冻结时一并 deactivate（中继侧会自动 clear 归零），下次任务/解冻时 activate 自动重建。
  // 解冻时只恢复冻结前处于激活状态的插件；插件注册表的启用状态不受影响（客户端为共享单例）。
  const chromaFrozenRef = useRef(false)
  const signalRgbFrozenRef = useRef(false)
  const dgLabFrozenRef = useRef(false)
  useEffect(() => {
    if (gameModeFrozen) {
      chromaFrozenRef.current = chromaClient.isActive()
      signalRgbFrozenRef.current = signalRgbClient.isActive()
      dgLabFrozenRef.current = dglabClient.isActive()
      if (chromaFrozenRef.current) void chromaClient.deactivate().catch(() => undefined)
      if (signalRgbFrozenRef.current) void signalRgbClient.deactivate().catch(() => undefined)
      if (dgLabFrozenRef.current) dglabClient.deactivate()
      return
    }
    if (chromaFrozenRef.current) {
      chromaFrozenRef.current = false
      void chromaClient.activate().catch(() => undefined)
    }
    if (signalRgbFrozenRef.current) {
      signalRgbFrozenRef.current = false
      void signalRgbClient.activate().catch(() => undefined)
    }
    if (dgLabFrozenRef.current) {
      dgLabFrozenRef.current = false
      dglabClient.activate()
    }
  }, [gameModeFrozen])

  // 看歌模式禁用交叉过渡/无缝衔接/自动混音（视频切歌做这些太割裂），只影响生效值不污染用户设置；
  // 游戏模式同理：为打游戏让路，直接禁用 AutoMix 这类分析/渲染大头；
  // TV 上没有节拍/响度分析服务（3002/3003）也没有桌面渲染桥，AutoMix 只会静默降级为固定交叉淡化——
  // 强制关闭以消除每次切歌的健康探测白等（≤2s）、REPREPARE 重试循环与「即将智能混音」的误导 HUD。
  const watchModeActive = lyricDisplayMode === 'video'
  // TV：手机遥控器是否处于光标模式（连接后 hover 交互可用，焦点揭示逻辑要相应让位）
  const remoteCursorModeActive = useRemoteCursorMode()
  const effectiveCrossfadeEnabled = !watchModeActive && crossfadeEnabled
  const effectiveGaplessEnabled = !watchModeActive && gaplessEnabled
  const effectiveAutoMixEnabled = !watchModeActive && autoMixEnabled && !gameModeEnabled && !isTvModeActive()
  
  // 切歌过渡状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [transitionState, setTransitionState] = useState<TransitionState>('idle')
  const [transitionStrategy, setTransitionStrategy] = useState<TransitionStrategy>('none')
  const [transitionStyle, setTransitionStyle] = useState<'energetic' | 'atmospheric' | 'clean' | undefined>(undefined)
  const [transitionDebug, setTransitionDebug] = useState<TransitionDebugInfo | null>(null)
  // ref：commit 弹窗需要读最新一次 armed 的调试信息（含回退原因），避免闭包陈旧
  const transitionDebugRef = useRef<TransitionDebugInfo | null>(null)
  transitionDebugRef.current = transitionDebug
  const [transitionFallbackReason, setTransitionFallbackReason] = useState<string | undefined>()
  const [transitionProgress, setTransitionProgress] = useState(0) // 过渡进度 0-1
  /** 歌词落定版本号：真实切歌提交时 +1，供歌词列表在提交帧强制重锚（修复「提交后不跟屏」）。 */
  const [lyricSettleRevision, setLyricSettleRevision] = useState(0)
  // 过渡缓冲时长（秒）：叠加动画窗口（最后 4 秒）按此映射 progress
  const [transitionDuration, setTransitionDuration] = useState(0)
  const transitionTargetTimeRef = useRef(Number.NaN)
  const [transitionStartTime, setTransitionStartTime] = useState<number | null>(null)

  // AutoMix 过渡 HUD（播放页封面下方时间节点徽标 + 进度条介入/过渡提示）。
  // 个性化 → 「AutoMix 过渡提示」开关控制显示；localStorage 键 automixTransitionHudEnabled（默认开）。
  const [automixHudEnabled, setAutomixHudEnabled] = useState(() => parseStoredBoolean(localStorage.getItem('automixTransitionHudEnabled'), true))
  useEffect(() => {
    const sync = () => setAutomixHudEnabled(parseStoredBoolean(localStorage.getItem('automixTransitionHudEnabled'), true))
    window.addEventListener('automixTransitionHudChanged', sync)
    return () => window.removeEventListener('automixTransitionHudChanged', sync)
  }, [])

  const [automixHudSkippedTrackKey, setAutomixHudSkippedTrackKey] = useState<string | null>(null)
  /**
   * 无缝衔接边界的开始时间（秒）：药丸时间节点与 UpNext 倒计时共用。
   *   · 同专辑 → 曲末（直接拼接发生在 source ended 时）；
   *   · 跨专辑 → 曲末 − 估计窗口（2.5s）——交叉锚定在歌曲最末尾的空白处；
   *     计划就绪后节点时间会由真实窗口（transitionDebug）覆盖。
   */
  const gaplessBoundaryStartAt = useMemo(() => {
    if (!effectiveGaplessEnabled || effectiveAutoMixEnabled) return null
    const current = playlist[currentIndex]
    if (!current) return null
    const totalSeconds = duration > 0 ? duration : Math.max(0, Number(current.duration) / 1000)
    if (totalSeconds <= 0) return null
    const next = playlist[currentIndex + 1]
    const currentAlbum = current.album?.id ?? current.album?.mid ?? ''
    const nextAlbum = next?.album?.id ?? next?.album?.mid ?? ''
    if (currentAlbum && nextAlbum && String(currentAlbum) === String(nextAlbum)) return totalSeconds
    return Math.max(0, totalSeconds - 2.5)
  }, [effectiveGaplessEnabled, effectiveAutoMixEnabled, playlist, currentIndex, duration])
  // 过渡 HUD 数据（药丸时间节点 + 进度条上方引擎名共用）：
  //   · automix：计划就绪（armed）即给出「即将在 m:ss 开始智能混音」的时间节点，直到过渡开跑；
  //   · gapless：同样出节点「即将在 m:ss 开始无缝衔接」（跨专辑 = 交叉起点，同专辑 = 曲末）；
  //   · 已降级为普通交叉淡化（fixed-crossfade / none）时不给任何提示，避免误导。
  const automixHud = useMemo(() => {
    if (transitionState !== 'armed' && transitionState !== 'running-transition') return null
    const strategy = transitionStrategy
    const engineName = transitionEngineDisplayName(strategy, effectiveAutoMixEnabled, autoMixEngine)
    if (!engineName) return null
    const phase = (transitionState === 'running-transition' ? 'running' : 'armed') as 'armed' | 'running'
    if (strategy === 'gapless') {
      const current = playlist[currentIndex]
      if (!(duration > 0) || !current) return null
      // 节点被用户关闭（本曲不做无缝衔接）→ 不再显示
      const currentKey = getSongKey(current)
      if (automixHudSkippedTrackKey && currentKey === automixHudSkippedTrackKey) return null
      // 首选：智能短交叉计划就绪后，节点时间 = 计划窗口起点（分析算出的交叉位置）；
      // 计划未就绪时退回估算值（跨专辑 = 曲末-裁剪-默认窗；同专辑 = 曲末）
      const gaplessDbg = transitionDebug
      const planStart = gaplessDbg && Number.isFinite(gaplessDbg.sourceStartTime) && gaplessDbg.sourceTrackKey === currentKey
        ? gaplessDbg.sourceStartTime
        : null
      const joinAt = planStart ?? gaplessBoundaryStartAt ?? duration
      return {
        phase,
        startAt: joinAt,
        endAt: joinAt,
        engineLabel: engineName,
        kind: 'gapless' as const,
        key: `gapless|${joinAt.toFixed(2)}`,
      }
    }
    // 只有"智能过渡"才提示：用户点过关闭（本曲不做智能混音）或已降级为普通交叉淡化时不再打扰
    // ——否则文案会说"开始智能混音"而实际只是一次短交叉，属于误导。
    const isSmartTransition = strategy === 'smart-rendered'
      || strategy === 'smart-rendered-v2'
      || strategy === 'smart-rendered-qq'
      || strategy === 'beat-crossfade'
    if (!isSmartTransition) return null
    const dbg = transitionDebug
    if (!dbg || !Number.isFinite(dbg.sourceStartTime) || !Number.isFinite(dbg.sourceEndTime)) return null
    if (dbg.sourceEndTime <= dbg.sourceStartTime) return null
    if (automixHudSkippedTrackKey && dbg.sourceTrackKey === automixHudSkippedTrackKey) return null
    return {
      phase,
      startAt: dbg.sourceStartTime,
      endAt: dbg.sourceEndTime,
      engineLabel: engineName,
      kind: 'automix' as const,
      key: `${dbg.sourceTrackKey}|${dbg.sourceStartTime.toFixed(2)}`,
    }
  }, [effectiveAutoMixEnabled, transitionState, transitionDebug, transitionStrategy, autoMixEngine, duration, automixHudSkippedTrackKey, playlist, currentIndex, gaplessBoundaryStartAt])
  // modern 等流式播放页的过渡徽标：按 HUD 键记忆「关闭」（切歌/重排后自动恢复）。
  // 药丸时间节点对 AutoMix 与无缝衔接都可用（gapless 的节点 = 裁剪后的拼接点）。
  // 时间订阅（automixHudTime）在 audioPlayer 声明之后统一挂（依赖 playbackTimeStore）。
  const [dismissedAutomixHudKey, setDismissedAutomixHudKey] = useState<string | null>(null)
  useEffect(() => {
    setDismissedAutomixHudKey(null)
  }, [automixHud?.key])
  const modernAutomixHud = automixHudEnabled && automixHud && automixHud.key !== dismissedAutomixHudKey
    ? automixHud
    : null
  const modernAutomixHudColors = playerTheme === 'dark'
    ? { chip: 'rgba(15, 17, 24, 0.55)', text: '#f7f7fa', dim: 'rgba(255,255,255,0.55)' }
    : { chip: 'rgba(255, 255, 255, 0.62)', text: '#17181d', dim: 'rgba(20, 22, 28, 0.5)' }
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
    // 过渡期间供 MV 背景提前匹配/预载目标 MV（automix/无缝等长过渡时新 MV 叠旧 MV 渐入）
    duration?: number
    platform?: string
    id?: string | number
    /** 过渡目标专辑名：MV 预载时用于推导作品名（IP 证据） */
    albumName?: string
  } | null>(null)
  const [transitionFromAccentColor, setTransitionFromAccentColor] = useState<string | null>(null)
  const [transitionToAccentColor, setTransitionToAccentColor] = useState<string | null>(null)
  /**
   * 视觉轨道（Visual Track）：进度 90% 时把"画面归属"提前切到目标曲——歌名/歌手/封面/歌词/
   * 配色/MV 都改读它，而 canonical 的 currentTrack、播放时钟、队列 revision、歌词归属一概不动
   *（早期实现直接改 canonical，会误触发按 currentIndex 的加载链路，故分轨为纯展示状态）。
   * 真正的提交帧只是把 canonical 换成同一首目标曲，因此那一刻画面上没有任何可见变化。
   */
  const [visualTrack, setVisualTrack] = useState<{
    trackKey: string
    index: number
    coverUrl: string
    title: string
    artist: string
    albumName?: string
    songId?: string | number
    /** 目标曲歌词（取预载缓存；缺失时沿用当前歌词，提交帧会自然纠正） */
    lyrics: LyricLine[]
  } | null>(null)
  const visualTrackRef = useRef<typeof visualTrack>(null)
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
  const canonicalSong = currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null
  /**
   * 视觉轨道（Visual Track）——过渡到 90%（进度）时把"画面归属"提前切到目标曲：
   * 播放页上的一切展示（歌名/歌手/封面/时长/歌词/MV/队列高亮）都经 `currentSong` / `lyrics`
   * 读取，这里让它们跟随视觉轨道；而 canonical 的 `currentIndex`/`currentTrack`/播放时钟/
   * 队列 revision/歌词归属**不动**（早期实现直接改 canonical，会误触发按 index 的加载链路）。
   * 真正提交时 canonical 换成同一首目标曲、视觉轨道在同一批清空 —— 画面在那一刻零变化。
   * 视觉轨道仅在过渡 90% 之后存在，其余时间这两个绑定等于 canonical 值。
   */
  const currentSong = visualTrack ? (playlist[visualTrack.index] ?? canonicalSong) : canonicalSong
  /** 歌词同理：切轨后歌词面板读目标曲歌词（时钟也已切到目标曲，避免"新时钟配旧歌词"）。 */
  const lyrics = visualTrack && visualTrack.lyrics.length > 0 ? visualTrack.lyrics : canonicalLyrics
  const currentAppleRadio = currentSong?.appleRadio || null
  const isAppleRadioPlayback = Boolean(currentAppleRadio)

  const [appleRadioStatus, setAppleRadioStatus] = useState<'connecting' | 'playing' | 'reconnecting' | 'error'>('connecting')
  const [appleRadioError, setAppleRadioError] = useState('')
  /** 电台点选瞬间锁定专页，避免 currentSong 尚未切换时短暂显示上一首歌曲播放页。 */
  const [appleRadioSurfaceLocked, setAppleRadioSurfaceLocked] = useState(false)
  const [pendingAppleRadioSong, setPendingAppleRadioSong] = useState<Song | null>(null)
  const appleRadioAcceptanceRef = useRef({
    currentSong,
    status: appleRadioStatus,
    error: appleRadioError,
    isPlaying,
    streamResolved: false,
  })
  appleRadioAcceptanceRef.current = {
    ...appleRadioAcceptanceRef.current,
    currentSong,
    status: appleRadioStatus,
    error: appleRadioError,
    isPlaying,
  }

  // Apple 播放面仅在 Electron CENC 失败时按需启动；正常 Apple 歌曲走本地 L3音频图，
  // 不因当前平台/队列是 Apple 就常驻拉起 WebView2。
  const appleBridgeStopTimerRef = useRef<number | null>(null)
  // 「播放面未授权」一次性会话提示标记（避免每次点歌都弹 toast）
  const appleBridgeAuthHintShownRef = useRef(false)
  useEffect(() => {
    const platform = currentSong?.platform
    if (platform !== 'apple' && platform) {
      if (appleBridgeStopTimerRef.current) {
        window.clearTimeout(appleBridgeStopTimerRef.current)
        appleBridgeStopTimerRef.current = null
      }
      // 切到其他平台时立即释放兼容播放面；它不参与正常原生 CENC 播放
      void bridgeStop().catch(() => undefined)
      void window.electron?.stopAppleBridge?.()
    }
    return () => {
      if (appleBridgeStopTimerRef.current !== null) {
        window.clearTimeout(appleBridgeStopTimerRef.current)
        appleBridgeStopTimerRef.current = null
      }
    }
  }, [currentSong?.platform])

  // 播客节目没有歌词、也没有 MV 背景：自动使用纯音乐播放页并隐藏 MV 入口
  const podcastPlayback = Boolean(currentSong?.isPodcast)
  const pureMusicPlayback = isPureMusic || podcastPlayback
  /**
   * 电台/播客都不该有 MV 背景：它们不是「歌曲」，没有可匹配的 MV。
   * 这个判断必须与下面 MV 图层的挂载条件（`!isAppleRadioPlayback && !podcastPlayback`）
   * **完全一致**——此前这里漏了 isAppleRadioPlayback，于是开着 MV 背景时进电台：
   * 歌词页按「MV 已激活」把自己透明掉（等 MV 出画面），可 MV 图层根本没挂载，
   * 结果整屏全黑（用户实测反馈）。关掉 MV 背景开关就正常，正是这个不一致导致的。
   */
  const mvBackgroundSuppressed = isAppleRadioPlayback || podcastPlayback
  // 只有视频已经真正出画面时才让歌词页面透明；搜索/拉流/canplay 前继续显示封面兜底。
  const mvBackgroundActive = Boolean(currentSong) && lyricDisplayMode !== 'video' && mvBackgroundEnabled && !mvBackgroundFallback && mvBackgroundReady && !mvBackgroundSuppressed
  // Apple Music 动态封面（图层叠加式）：未开启/无动态封面/查询失败时为 null，封面永远回退平台静态图
  const appleDynamicCover = useAppleDynamicCover({
    title: isAppleRadioPlayback ? '' : currentSong?.name || '',
    artist: isAppleRadioPlayback ? '' : (currentSong?.artists || []).map((artist: { name: string }) => artist.name).join(', '),
    album: isAppleRadioPlayback ? '' : currentSong?.album?.name || '',
    duration: isAppleRadioPlayback ? undefined : currentSong?.duration,
    trackKey: isAppleRadioPlayback ? '' : currentSong?.id || currentSong?.mid || '',
  })
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('mvBackgroundActiveChanged', { detail: mvBackgroundActive }))
  }, [mvBackgroundActive])
  // QuickSettings 是懒加载挂载，可能晚于 MV 背景激活（一次性广播已错过）：收到查询请求时回发当前状态
  useEffect(() => {
    const onQuery = () => window.dispatchEvent(new CustomEvent('mvBackgroundActiveChanged', { detail: mvBackgroundActive }))
    window.addEventListener('mvBackgroundActiveQuery', onQuery as EventListener)
    return () => window.removeEventListener('mvBackgroundActiveQuery', onQuery as EventListener)
  }, [mvBackgroundActive])

  // 代理自动配置通知：运行中代理断开 / 启动时未检测到代理端口 → 弹 toast
  useEffect(() => {
    // 派发前先等 showToast 监听器注册（挂载早期直接派发会被丢弃）。
    // 启动类提示额外延后数秒——刚启动界面还没稳定，立即弹用户来不及看；
    // 同时把展示时长拉长到 8s 保证可读。运行中断开提示保持即时。
    const toast = (message: string, delay = 0, duration = 4000) => {
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type: 'info', duration } }))
      }, delay)
    }
    const off = window.electron?.proxyManager?.onNotice?.((notice) => {
      if (notice.kind === 'disconnected') toast('检测到代理断开，已为您关闭自动代理')
    })
    // 启动提示：主进程的端口检测可能在渲染进程挂载后才完成，轮询几次兜底
    let attempts = 0
    const tryConsume = () => {
      void window.electron?.proxyManager?.consumeNotice?.().then((notice) => {
        if (notice === 'startup-unavailable') {
          toast('由于您上次关闭时为自动代理，本次启动检测到无代理端口，已为您关闭自动代理功能', 3500, 8000)
        } else if (notice === 'startup-unusable') {
          toast('上次使用的代理已失效（端口在但隧道不通），已为您关闭自动代理功能', 3500, 8000)
        } else if (attempts < 8) {
          attempts += 1
          window.setTimeout(tryConsume, 800)
        }
      }).catch(() => {})
    }
    tryConsume()
    return () => off?.()
  }, [])
  // 切歌时重置 MV 背景状态：上一首的回退/就绪状态都不能泄漏到下一首。
  useEffect(() => {
    setMvBackgroundFallback(false)
    setMvBackgroundReady(false)
  }, [currentSong?.id, currentSong?.mid, currentSong?.name])
  // 稳定的歌手名数组（避免每次渲染新引用导致 MV 背景等组件反复重挂/重跑）
  const currentSongArtists = useMemo(
    () => (currentSong?.artists || []).map((artist: any) => artist.name),
    [currentSong],
  )
  // 稳定的歌手名拼接串（folia 等歌词组件按值比较避免每秒重渲染）
  const currentSongArtistLabel = useMemo(() => currentSongArtists.join(', '), [currentSongArtists])
  const isPlaybackPage = Boolean(currentSong) && (showSharedPlayer || (viewMode === 'minimal' && !showHome))
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
      setShowSharedPlayer(false)
      setShowHome(true)
      return true
    }
    return false
  }, [])

  // 共振房间「挂起/退出」询问框：BACK 应关掉询问（留在房间），否则未消费的 BACK 会直接退出应用。
  // deps 让它在提示出现时重新注册，从而优先于 App 里那条常驻兜底处理器。
  const resonanceExitPromptRef = useRef(resonanceExitPrompt)
  resonanceExitPromptRef.current = resonanceExitPrompt
  useTvBack(() => {
    if (!resonanceExitPromptRef.current) return false
    setResonanceExitPrompt(null)
    return true
  }, [resonanceExitPrompt])

  const playlistKeys = useMemo(() => playlist.map(getSongKey), [playlist])
  // 看歌预加载：即将播放的后 2 首歌（预匹配评分高的 B 站视频）
  const watchUpcomingSongs = useMemo(() => {
    if (!playlist.length || typeof currentIndex !== 'number' || currentIndex < 0) return []
    const upcoming: Array<{ songTitle: string; songArtists: string[]; songDuration: number; platform?: string; id?: string | number; songAlbum?: string }> = []
    for (let offset = 1; offset <= 2; offset += 1) {
      const song = playlist[currentIndex + offset]
      if (!song) break
      upcoming.push({
        songTitle: song.name,
        songArtists: (song.artists || []).map((artist: any) => artist.name).filter(Boolean),
        songDuration: (song.duration || 0) / 1000,
        platform: song.platform,
        id: song.id || song.mid,
        songAlbum: song.album?.name,
      })
    }
    return upcoming
  }, [playlist, currentIndex])
  const deterministicNextIndex = useMemo(
    () => getDeterministicNextIndex(playlistKeys, currentIndex, playMode, queueRevision),
    [playlistKeys, currentIndex, playMode, queueRevision]
  )
  // 看歌视频播放状态（迷你播放器/桌面小窗按视频进度显示；歌词时间源也依赖它）。
  // 声明位置必须在歌词线性 memo 之前（currentMiniLyric 等引用）。
  const [watchVideoActive, setWatchVideoActive] = useState(false)
  const [watchVideoState, setWatchVideoState] = useState({ playing: false, time: 0, duration: 0, volume: 0.8, alignmentOffset: 0, alignmentVerified: false })
  const watchVideoStateRef = useRef(watchVideoState)
  watchVideoStateRef.current = watchVideoState
  // 看歌模式下歌词时间源：引擎暂停 → currentTime 冻结，任务栏/桌面歌词会停住。
  // 已确认对齐（视频与歌曲同源）时按「视频位 − 对齐偏移」推出歌曲位，歌词随 MV 继续滚动；
  // 未确认（自由播放/货不对板）时歌词位置不可信 → 显示层回退「歌名-艺人」。
  const lyricTimelineTime = lyricDisplayMode === 'video' && watchVideoActive && watchVideoState.alignmentVerified
    ? watchVideoState.time - watchVideoState.alignmentOffset
    : currentTime
  const watchLyricUnverified = lyricDisplayMode === 'video' && watchVideoActive && !watchVideoState.alignmentVerified
  const currentMiniLyric = useMemo(() => {
    const inWatchUnverified = watchLyricUnverified
    if (inWatchUnverified) {
      // 看歌但未确认对齐：歌词位不可信 → 显示「歌名 - 歌手」兜底
      const artist = Array.isArray(currentSongArtists) ? currentSongArtists.map((a: any) => (a && a.name) || a || '').filter(Boolean).join(' / ') : ''
      return `${currentSong?.name || ''}${artist ? ` - ${artist}` : ''}`
    }
    const adjustedTime = lyricTimelineTime + 0.5 + lyricOffset
    for (let index = lyrics.length - 1; index >= 0; index--) {
      if (lyrics[index].time <= adjustedTime) return lyrics[index].text
    }
    return ''
  }, [watchLyricUnverified, lyricTimelineTime, lyricOffset, lyrics, currentSong, currentSongArtists])
  /**
   * 迷你播放器无歌词时的占位文案。
   * - Apple 电台：电台/节目名（`appleRadio.showName`）
   * - 曲目型电台队列：队列曲目不带 appleRadio，但电台名已回填进 `album.name`
   * - 播客：节目所属播客名（服务端写入 `album.name`）
   * 其余由迷你播放器回退到「暂无歌词」。
   */
  const currentMiniLyricsPlaceholder = useMemo(() => {
    if (currentSong?.appleRadio) {
      return currentSong.appleRadio.showName?.trim() || currentSong?.name || ''
    }
    if (currentSong?.isPodcast || currentSong?.isRadioQueue) {
      return currentSong?.album?.name?.trim() || currentSong?.name || ''
    }
    return ''
  }, [currentSong])
  const currentLyricIndex = useMemo(() => {
    const adjustedTime = lyricTimelineTime + 0.5 + lyricOffset
    if (lyrics.length === 0 || adjustedTime < lyrics[0].time) return -1
    for (let index = lyrics.length - 1; index >= 0; index--) {
      if (lyrics[index].time <= adjustedTime) return index
    }
    return -1
  }, [lyricTimelineTime, lyricOffset, lyrics])
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
  const playbackLyricsRef = useRef(lyrics)
  const playbackDesktopLyricsRef = useRef(desktopLyrics)
  const playbackLyricOffsetRef = useRef(lyricOffset)
  playbackLyricsRef.current = lyrics
  playbackDesktopLyricsRef.current = desktopLyrics
  playbackLyricOffsetRef.current = lyricOffset
  const desktopLyricLine = useMemo(() => {
    // 看歌未确认对齐（货不对板/自由播放）→ 桌面/任务栏歌词显示「歌名-艺人」兜底
    if (watchLyricUnverified) {
      const artist = Array.isArray(currentSongArtists) ? currentSongArtists.map((a: any) => (a && a.name) || a || '').filter(Boolean).join(' / ') : ''
      return { time: 0, text: `${currentSong?.name || ''}${artist ? ` - ${artist}` : ''}`, translation: '', roman: '', words: [], romanWords: [], isGeneratedInterlude: false } as DesktopLyricLine
    }
    const adjustedTime = lyricTimelineTime + 0.28 + lyricOffset
    for (let index = desktopLyrics.length - 1; index >= 0; index--) {
      const line = desktopLyrics[index]
      if (line.time <= adjustedTime) {
        if (line.isGeneratedInterlude && line.interludeEndTime !== undefined && lyricTimelineTime + lyricOffset >= line.interludeEndTime) {
          return desktopLyrics[index + 1] || line
        }
        return line
      }
    }
    return null
  }, [watchLyricUnverified, lyricTimelineTime, lyricOffset, desktopLyrics])
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
    if (song.appleRadio) return Promise.resolve([])
    const cached = preloadCacheRef.current.get(cacheKey)
    const cachedUrlTimestamp = cached?.urlTimestamp ?? (cached?.url ? cached.timestamp : undefined)

    // 跨平台补源（平台可用性增强）：汽水等平台的歌实际用别的平台音源出声时，
    // 歌词也要**跟着音源平台走**——网易云源带翻译、逐字等各自的质量特征，
    // 按原平台取词会丢掉这些（实测：Fire Again 补网易云源，原汽水路径无翻译，网易云 tlyric 存在）。
    // 登记表里有 from 平台 + carrierId（实际音源歌曲 id），直接拿来取词。
    let lyricPlatformOverride: MusicPlatform | null = null
    let lyricIdOverride: string | number | null = null
    if (song.platform === 'soda') {
      try {
        const reg = JSON.parse(localStorage.getItem('wf_cross_filled_tracks') || '{}')
        const info = reg[`soda:${song.mid || song.id}`]
        if (info && info.from && info.carrierId) {
          lyricPlatformOverride = info.from as MusicPlatform
          lyricIdOverride = String(info.carrierId)
        }
      } catch { /* 登记表读不到就按原平台走 */ }
    }

    const platform = lyricPlatformOverride || (song.platform || 'netease') as MusicPlatform
    // 汽水的 item_id 是超长数字串，Number 化会截断失配；Apple 必须优先使用 catalog appleId。
    const rawSongId = lyricIdOverride != null
      ? lyricIdOverride
      : platform === 'apple'
        ? (song.appleId || song.id)
        : (platform === 'qq' || platform === 'soda' || platform === 'kugou')
          ? (song.mid || song.id)
          : song.id
    const resolveLyricsSongId = async (): Promise<string | number> => {
      const value = String(rawSongId || '')
      if (platform === 'apple' && APPLE_LIBRARY_ID_PATTERN.test(value)) {
        return await resolveAppleLibraryCatalogId(value).catch(() => null) || ''
      }
      return rawSongId
    }
    const lyricsCacheGeneration = lyricsCacheGenerationRef.current
    let lyricsLoadedFromPersistentCache = false
    // 歌词缓存版本：评分/数据源/解析逻辑变更时递增，使旧缓存（旧解析选中的劣质/残缺源）失效。
    // v3→v4：修复 QQ 歌词请求的 songID 形态后，**递增版本强制清除今天缓存下来的残缺结果**
    //（上午 parseInt('004Iwx…')=4 的守卫 bug 让 musicu 返回空 qrc/trans/roma → 结果被
    // IndexedDB 永久缓存，后端修好后缓存仍喂旧坏数据 → 重启也无效）
    // v5：保留 Apple TTML 独立翻译/罗马音、对唱 agent 和背景和声字段。
    // v6：背景和声结构修复——AMLL TTML 的 x-bg 随主行下发（此前被丢弃）、YRC 括号和声行
    //     归并为主行 backgroundVocals（此前是独立行）。旧缓存会重放"和声变独立大字行"的旧结构，
    //     必须升版本强制重取，否则修复在缓存命中的歌曲上完全不可见。
    // v8：结构补挂扩展为「演唱者(agent) + 背景和声(backgroundVocals)」全量下发，含跨源
    //     文本差异（want/wanna）的偏差兜底——v7 缓存里的骨架行仍是无 agent 的旧结构。
    // v7：AMLL 结果下发 ttm:agent（左右分栏数据源）+ 经本地服务代理取数（渲染进程直连
    //     在部分网络下整批失败）。v6 缓存里存的正是"无 agent、无 backgroundVocals"的
    //     旧骨架（TTL 30 天，重启也不会失效），必须再升一版；**今后任何歌词取数/解析/
    //     合并管线的改动都要随手升这个版本号**，否则等于没改。
    // 来源策略进入 key：切语言、登录态、第三方/自适应/主源后不会继续读取旧结果。
    const lyricsPolicyKey = [
      // 跨平台补源换轨进入 key：同一首歌补源前后取词平台不同（汽水源无翻译、网易云源有），
      // 不进 key 会命中补源前缓存的无翻译旧结果，修复对已缓存歌曲完全不可见。
      lyricPlatformOverride ? `xf-${lyricPlatformOverride}` : 'non-xf',
      platform === 'apple' ? (localStorage.getItem('appleMusicEnabled') || 'default') : 'non-apple',
      platform === 'apple' ? (localStorage.getItem('appleLyricLang') || 'zh-hans-cn') : '-',
      platform === 'apple' ? (getAppleAuthState().loggedIn ? 'logged-in' : 'logged-out') : '-',
      localStorage.getItem('thirdPartyLyricsEnabled') || 'default',
      localStorage.getItem('adaptiveLyrics') || 'default',
      localStorage.getItem('primaryLyricsSource') || 'AMLL',
    ].join(':')
    const lyricsCacheKey = `v8:${lyricsPolicyKey}:${cacheKey}`
    const isFresh = cached
      && cached.lyricsPolicyKey === lyricsPolicyKey
      && Date.now() - (cached.lyricsTimestamp ?? cached.timestamp) < 5 * 60 * 1000
    if (isFresh && cached.lyricsLoaded) return Promise.resolve(cached.lyrics)
    if (isFresh && cached.lyricsPromise) return cached.lyricsPromise
    const request = indexedDBCache.getCachedLyrics<LyricLine[]>(lyricsCacheKey, platform)
      .catch(() => null)
      .then(async persistedLyrics => {
        if (Array.isArray(persistedLyrics)) {
          lyricsLoadedFromPersistentCache = true
          return persistedLyrics
        }
        const lyricsSongId = await resolveLyricsSongId()
        return getLyrics(
          lyricsSongId,
      platform,
      song.name,
      song.artists.map(artist => artist.name).filter(Boolean).join(', '),
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
          lyricsPolicyKey,
        })
        if (activeTrackKeyRef.current === cacheKey) {
          debugLog(`📝 歌词更新: ${source} (${progressLyrics.length}行 逐字=${hasWordByWord})`)
          setLyrics(progressLyrics)
          setIsPureMusic(detectPureMusic(progressLyrics))
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
        lyricsPolicyKey,
      })
      if (activeTrackKeyRef.current === cacheKey) {
        setLyrics(finalLyrics)
        setIsPureMusic(detectPureMusic(finalLyrics))
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
        lyricsPolicyKey,
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
      lyricsPolicyKey,
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
          lyricsPolicyKey: undefined,
        })
      }
      const currentSong = playlistRef.current[currentIndexRef.current]
      if (currentSong) {
        const currentKey = getSongKey(currentSong)
        setLyrics([])
        void ensureSongLyrics(currentSong, currentKey)
      }
    }
    window.addEventListener('waveforge:lyrics-cache-cleared', clearLyricsMemory)
    window.addEventListener('waveforge:lyrics-policy-changed', clearLyricsMemory)
    return () => {
      window.removeEventListener('waveforge:lyrics-cache-cleared', clearLyricsMemory)
      window.removeEventListener('waveforge:lyrics-policy-changed', clearLyricsMemory)
    }
  }, [ensureSongLyrics])

  useEffect(() => {
    const handleLyricOffsetChange = (event: Event) => {
      setLyricOffset(Number((event as CustomEvent<number>).detail) || 0)
    }
    window.addEventListener('lyricOffsetChanged', handleLyricOffsetChange)
    return () => window.removeEventListener('lyricOffsetChanged', handleLyricOffsetChange)
  }, [])

  useEffect(() => {
    const handleLyricStyleModeChange = (event: Event) => {
      setLyricStyleMode((event as CustomEvent<LyricStyleMode>).detail === 'modern' ? 'modern' : 'soft')
    }
    window.addEventListener(LYRIC_STYLE_MODE_EVENT, handleLyricStyleModeChange)
    return () => window.removeEventListener(LYRIC_STYLE_MODE_EVENT, handleLyricStyleModeChange)
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
  const [spotifyEntitlement, setSpotifyEntitlement] = useState<EntitlementTier>(() => (
    entitlementTierFromSpotifyProduct(localStorage.getItem('spotify_product'))
  ))
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
  const [sodaEntitlement, setSodaEntitlement] = useState<EntitlementTier>(() => (
    (localStorage.getItem('soda_entitlement') as EntitlementTier | null) || 'unknown'
  ))


  const platformEntitlements = useMemo(() => createPlatformEntitlements({
    netease: entitlementTierFromVip(neteaseVip),
    qq: entitlementTierFromVip(qqVip),
    // Apple Music 是订阅制：能登录就说明订阅有效（目录曲都能放），没登录才算 unknown。
    // 之前这里恒为 'unknown'，会把已登录的 Apple 当成「没会员」，加歌面板会给每首 Apple 曲标「需要 VIP」。
    apple: appleLoggedIn ? 'vip' : 'unknown',
    spotify: spotifyLoggedIn ? spotifyEntitlement : 'unknown',
    // 酷狗没有可用的会员档位来源：保持 unknown = 「不预设，实测取流」（提前判 free 会把付费曲直接误杀）
    kugou: 'unknown',
    soda: sodaLoggedIn ? sodaEntitlement : 'unknown',
  }), [appleLoggedIn, neteaseVip, qqVip, sodaEntitlement, sodaLoggedIn, spotifyEntitlement, spotifyLoggedIn])
  // 共振：本机各平台的登录与会员档位 / 账号标识（房间内只展示徽章，不外发账号）
  const resonancePlatforms = useMemo(() => [
    { platform: 'netease' as MusicPlatform, loggedIn: neteaseLoggedIn, tier: platformEntitlements.netease },
    { platform: 'qq' as MusicPlatform, loggedIn: qqLoggedIn, tier: platformEntitlements.qq },
    { platform: 'apple' as MusicPlatform, loggedIn: appleLoggedIn, tier: platformEntitlements.apple },
    { platform: 'spotify' as MusicPlatform, loggedIn: spotifyLoggedIn, tier: platformEntitlements.spotify },
    { platform: 'kugou' as MusicPlatform, loggedIn: kugouLoggedIn, tier: platformEntitlements.kugou },
    { platform: 'soda' as MusicPlatform, loggedIn: sodaLoggedIn, tier: platformEntitlements.soda },
  ], [appleLoggedIn, kugouLoggedIn, neteaseLoggedIn, platformEntitlements, qqLoggedIn, sodaLoggedIn, spotifyLoggedIn])
  const resonanceUserIds = useMemo(() => ({
    netease: neteaseUserId,
    qq: qqUserId,
    kugou: kugouUserId,
  } as Partial<Record<MusicPlatform, string>>), [kugouUserId, neteaseUserId, qqUserId])
  const resonanceUsernames = useMemo(() => ({
    netease: neteaseUsername,
    qq: qqUsername,
    kugou: kugouUsername,
  } as Partial<Record<MusicPlatform, string>>), [kugouUsername, neteaseUsername, qqUsername])
  const [loginRestoreComplete, setLoginRestoreComplete] = useState(false)
  // 登录态发生变化后通知首页、个人中心等依赖平台账号的视图刷新。
  const [authRevision, setAuthRevision] = useState(0)

  // 各平台账号用户 id（Spotify/酷狗/汽水 不应回退到 QQ 账号，避免喜欢/加歌串台）
  const getPlatformUserId = useCallback((target: MusicPlatform) => {
    if (target === 'netease') return neteaseUserId
    if (target === 'qq') return qqUserId
    if (target === 'spotify') return spotifyUserId
    if (target === 'kugou') return kugouUserId
    if (target === 'soda') return sodaUserId
    return ''
  }, [neteaseUserId, qqUserId, spotifyUserId, kugouUserId, sodaUserId])

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
    const platform = (currentSong.platform || 'netease') as MusicPlatform
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
    if (platform === 'apple') {
      recordAppleRecentPlaybackFallback(currentSong)
      session.reported = true
      return
    }
    if (platform !== 'netease' && platform !== 'qq') return
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
      : getPlatformUserId(platform)
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
    if (platform === 'apple') {
      const identifiers = getFavoriteSongIdentifiers(currentSong)
      void getAppleLovedSongIds(identifiers)
        .then(ids => {
          if (!cancelled) setCurrentSongLiked(ids.some(id => identifiers.includes(id)))
        })
        .catch(() => undefined)
      return () => { cancelled = true }
    }
    void loadFavoriteIdentifiers(platform, userId)
      .then(() => {
        if (cancelled) return
        setCurrentSongLiked(peekSongFavoriteStatus(currentSong, platform, userId) === true)
      })
      .catch(error => {
        if (!cancelled) console.warn('Failed to read current favorite state:', error)
      })

    return () => { cancelled = true }
  }, [currentSong, neteaseUserId, qqUserId, appleLoggedIn, sodaUserId])

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
  const appleAcceptanceActiveRef = useRef(false)
  const dominantColorRef = useRef<string>(PLAYBACK_NEUTRAL_COLOR)
  // P1-2：最近一次 ready 的封面主色/色板（含过渡目标封面的解析结果），
  // 供封面取色处于 loading 的短暂帧沿用，避免整屏配色闪灰。
  const lastReadyCoverColorRef = useRef<{ color: string | null; palette: string[] }>({ color: null, palette: [] })
  
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
    // AirPlay 投送：采集点挂在 analyser 之后（取完整混音，含音效）；本机静音用 outputGain
    airplayController.setCaptureSource(handle.audioContext, handle.analyser, handle.outputGain)
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
  
  const appleRadioReconnectKeyRef = useRef('')
  const appleRadioReconnectTimerRef = useRef<number | null>(null)
  const retryAppleRadioRef = useRef<(song: Song, index: number) => void>(() => undefined)
  useEffect(() => () => {
    if (appleRadioReconnectTimerRef.current !== null) window.clearTimeout(appleRadioReconnectTimerRef.current)
  }, [])

  // 播放器状态监听器
  const audioPlayer = useAudioPlayer(
    useCallback((state) => {
      if (state.isPlaying !== undefined) setIsPlaying(state.isPlaying)
      if (state.currentTime !== undefined) {
        currentTimeRef.current = state.currentTime
        const activeSong = playlistRef.current[currentIndexRef.current]
        const songKey = activeSong ? bilibiliSongKeyOf({
          songTitle: activeSong.name,
          artists: (activeSong.artists || []).map((artist: any) => artist.name),
          songDuration: (activeSong.duration || 0) / 1000,
          platform: activeSong.platform,
          id: activeSong.id || activeSong.mid,
        }) : ''
        if (songKey && Number.isFinite(state.currentTime) && state.currentTime > 0) {
          modeHandoffTimeRef.current = { songKey, time: state.currentTime }
        }
        const findTimelineIndex = (lines: LyricLine[], offset: number) => {
          for (let index = lines.length - 1; index >= 0; index -= 1) {
            if (lines[index].time <= state.currentTime! + offset) return index
          }
          return -1
        }
        const lyricIndex = findTimelineIndex(playbackLyricsRef.current, 0.5 + playbackLyricOffsetRef.current)
        let desktopLyricIndex = findTimelineIndex(playbackDesktopLyricsRef.current, 0.28 + playbackLyricOffsetRef.current)
        const activeDesktopLyric = playbackDesktopLyricsRef.current[desktopLyricIndex]
        if (
          activeDesktopLyric?.isGeneratedInterlude
          && activeDesktopLyric.interludeEndTime !== undefined
          && state.currentTime + playbackLyricOffsetRef.current >= activeDesktopLyric.interludeEndTime
        ) {
          desktopLyricIndex = Math.min(desktopLyricIndex + 1, playbackDesktopLyricsRef.current.length - 1)
        }

        // 倒计时基准：gapless/autoMix 启用时以 transitionStartTime（=动画起点）为准，
        // 否则以歌曲结束时间为准。
        const useTransitionCountdown = effectiveAutoMixEnabled || effectiveGaplessEnabled
        const eventTime = useTransitionCountdown ? (transitionStartTime ?? duration) : duration
        const timeRemaining = (eventTime ?? duration) - state.currentTime
        const inAnimationWindowNow = transitionStartTime === null || state.currentTime >= transitionStartTime
        const effectiveDuration = duration > 0
          ? duration
          : Math.max(0, Number(currentSong?.duration) / 1000)
        const reportThreshold = effectiveDuration > 0
          ? Math.min(30, Math.max(10, effectiveDuration * 0.1), Math.max(1, effectiveDuration - 1))
          : 30
        const presentationKey = [
          lyricIndex,
          desktopLyricIndex,
          inAnimationWindowNow ? 1 : 0,
          state.currentTime >= reportThreshold ? Math.floor(state.currentTime / 15) : -1,
        ].join(':')

        if (currentTimeCommitGateRef.current({
          currentTime: state.currentTime,
          isPlaying: state.isPlaying,
          presentationKey,
        })) {
          setCurrentTime(state.currentTime)
        }

        // AI 长混音音频过渡远早于动画点开始（transitioning 全程 true）——只有真正
        // 进入动画窗口后才隐藏"即将播放/即将进入过渡"卡片（卡片负责动画前的倒计时）。
        if ((state.transitioning && inAnimationWindowNow) || state.transitionState === 'preparing-next') {
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
    if (state.live !== undefined) setIsLive(state.live)
    if (state.volume !== undefined) setVolume(state.volume)
    if (state.transitioning !== undefined) setIsTransitioning(state.transitioning)
    if (state.transitionState !== undefined) setTransitionState(state.transitionState)
    if (state.transitionStrategy !== undefined) setTransitionStrategy(state.transitionStrategy)
    if (state.transitionStyle !== undefined) setTransitionStyle(state.transitionStyle)
    if (state.transitionDuration !== undefined) setTransitionDuration(state.transitionDuration)
    if (state.transitionTargetTime !== undefined) transitionTargetTimeRef.current = state.transitionTargetTime
    if (state.transitionDebug !== undefined) setTransitionDebug(state.transitionDebug)
    if ('transitionStartTime' in state) setTransitionStartTime(state.transitionStartTime ?? null)
    if (state.fallbackReason !== undefined || state.transitionState === 'armed' || state.transitionState === 'preparing-next') {
      setTransitionFallbackReason(state.fallbackReason)
    }
    
    // 更新过渡进度
    if (state.transitionProgress !== undefined) {
      // 过渡期间发布侧以 30fps 推送进度；这里若每帧 setState，会把整个 App 树拉到
      // 30fps reconcile（几百 KB 组件树，即便子树有 memo 仍有高频 diff 开销）。
      // 再粗量化到 ~10fps：进度条/过渡遮罩显示无感知差异，仅"到达 1 / 过渡结束"强制落定最终帧。
      const nowMs = performance.now()
      if (state.transitionProgress >= 1 || state.transitioning === false
        || nowMs - lastTransitionProgressThrottle >= 100) {
        setTransitionProgress(previousProgress => {
          const shouldHoldCompletedFrame = state.transitioning === false
            && state.transitionState === 'committed'
            && state.transitionProgress === 0
            && previousProgress > 0
          return shouldHoldCompletedFrame ? previousProgress : state.transitionProgress!
        })
        lastTransitionProgressThrottle = nowMs
      }
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
          duration: typeof normalizedToSong.duration === 'number' ? normalizedToSong.duration / 1000 : undefined,
          platform: normalizedToSong.platform,
          id: normalizedToSong.id ?? normalizedToSong.mid,
          albumName: normalizedToSong.album?.name,
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
      // 过渡被取消/失败/结束但**没有走到提交**：视觉轨道必须回退到 canonical。
      // 否则会永久停在"歌词/背景已是下一首、歌名/封面还是上一首"的半套状态
      //（视觉轨道只在真正提交的那一批里清空；取消路径不会经过提交）。
      if (visualTrackRef.current) {
        console.warn('[VisualTrack] 过渡未提交（' + state.transitionState + '），画面回退到当前曲:', visualTrackRef.current.trackKey)
        visualTrackRef.current = null
        setVisualTrack(null)
      }
    }
    
    // 在过渡中点切换视觉信息
    if (state.visualSwitchCommit) {
      transitionCommitRef.current(state.visualSwitchCommit)
    }
    
    // 歌曲切换提交
    if (state.transitionCommit) {
      // 调试弹窗已在 armed 时展示过计划详情；真实切歌提交时先清掉，
      // 避免与「切歌方案」弹窗在右上角重叠。
      if (transitionDebugToastTimerRef.current !== null) window.clearTimeout(transitionDebugToastTimerRef.current)
      transitionDebugToastTimerRef.current = null
      setTransitionDebugToast(null)
      transitionCommitRef.current(state.transitionCommit)

      // The audio deck is already committed at this point. Clear the visual snapshot in
      // the same React batch as the canonical song switch so a completed AutoMix does not
      // keep the controls/background in their "transition" presentation indefinitely.
      setIsTransitioning(false)
      setTransitionProgress(0)
      // 歌词落定：提交帧强制重锚当前句（修复「交叉结束的下一秒歌词列表不跟屏」）
      setLyricSettleRevision(value => value + 1)
      setTransitionFromTrack(null)
      setTransitionToTrack(null)
      setTransitionFromAccentColor(null)
      // P1-2：此帧不动 transitionToAccentColor——新封面此刻还在取色（loading），
      // 由 transitionToTrack 取色 effect 在新封面 ready 后再清，避免过渡已淡入到的目标色被丢弃。
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
      // 仅「过渡调试」开关开启时显示（设置 → 开发者选项 → 调试面板）；关闭则不弹，
      // 避免每次切歌右上角提示干扰。
      if (!isTransitionDebugEnabled()) return
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
      } else if (commit.strategy === 'smart-rendered-qq') {
        toastMessage = '已用「AutoMix Enhanced 智能混音」切换'
      } else if (commit.strategy === 'smart-rendered-v2') {
        toastMessage = '已用「AutoMix Pro 智能渲染」切换'
      } else if (commit.strategy === 'smart-rendered') {
        toastMessage = '已用「Smart AutoMix 智能渲染」切换'
      } else if (commit.strategy === 'beat-crossfade') {
        toastMessage = '已用「Smart AutoMix 节拍交叉淡化」切换'
      } else if (commit.strategy === 'fixed-crossfade') {
        toastMessage = '已用「交叉淡化」切换'
      }
      if (toastMessage) {
        const debug = transitionDebugRef.current
        const notes: string[] = []
        const reason = debug?.fallbackReason
        if (reason) notes.push(reason)
        // P1-12：展示档位 ≠ 实际档位时把真实档位与降级原因透出（例如 extreme 匹配不到 QQ 曲目
        // 而实际跑 lite）；此前 qqAppliedTier 只写不读，降级对用户完全不可见。
        const { appliedTier, tierFallbackReason } = readEnhancedTierDebug(debug)
        if (appliedTier && appliedTier !== autoMixEnhancedTier) {
          notes.push(`实际档位：${appliedTier}${tierFallbackReason ? ` · ${tierFallbackReason}` : ''}`)
        }
        triggerGaplessModeToast(notes.length > 0 ? `${toastMessage}（${notes.join('；')}）` : toastMessage)
      }
    } else if (
      state.transitionState === 'committed'
      && state.transitioning === false
      && state.seamlessTransition === true
      && !state.transitionCommit
    ) {
      // ③ albumGapless 交叉淡化 handoff（adoptExternalAudio 路径）
      triggerGaplessModeToast('已用「albumGapless 交叉淡化」切换')
    }

    if (state.transitionState === 'failed') {
      const activeRadioSong = playlist[currentIndex]
      const activeRadio = activeRadioSong?.appleRadio
      if (activeRadio) {
        const reconnectKey = getAppleRadioReconnectKey(activeRadio.storefront, activeRadio.stationId)
        const decision = decideAppleRadioFailure(
          appleRadioReconnectKeyRef.current,
          reconnectKey,
          state.fallbackReason,
        )
        if (decision.type === 'reconnect') {
          appleRadioReconnectKeyRef.current = decision.reconnectKey
          setAppleRadioStatus('reconnecting')
          setAppleRadioError('')
          if (appleRadioReconnectTimerRef.current !== null) window.clearTimeout(appleRadioReconnectTimerRef.current)
          appleRadioReconnectTimerRef.current = window.setTimeout(() => {
            appleRadioReconnectTimerRef.current = null
            const latestRadio = playlistRef.current[currentIndexRef.current]?.appleRadio
            const latestKey = latestRadio
              ? getAppleRadioReconnectKey(latestRadio.storefront, latestRadio.stationId)
              : ''
            if (latestKey !== decision.reconnectKey) return
            retryAppleRadioRef.current(activeRadioSong, currentIndex)
          }, decision.delayMs)
          return
        }
        setAppleRadioStatus('error')
        setAppleRadioError(decision.message)
        return
      }
    }

    if (state.ended && playlist.length > 0 && state.transitionState !== 'committed') {
      const activeSong = playlist[currentIndex]
      if (activeSong?.appleRadio) {
        setAppleRadioStatus('error')
        setAppleRadioError('Apple Music 电台连接已结束，请重新连接')
        return
      }
      if (playMode === 'repeat') {
        // 尝试播放失败，可能需要重新登录
        audioPlayer.seek(0)
        // audioPlayer 可能在 togglePlay 之前的 play 方法中已经切换了播放状态
        audioPlayer.togglePlay()
      } else if (isResonanceHost()) {
        // 房主在共振房间里：一首自然放完要推进**房间队列**，不能走本机 handleNext。
        // 房间内本机播放列表被压成单曲（见 resonanceAdapter.apply），走 handleNext 只会
        // 在那一首上回绕，房间 cursor 永远不动，成员会被反复拉回开头。
        getResonanceSession().hostNext()
      } else {
        // 防止在歌曲变化时快速连续调用导致竞态条件
        handleNextRef.current()
      }
    }
  }, [duration, upNextTime, upNextEnabled, showUpNext, playMode, deterministicNextIndex, autoMixEnabled, gaplessEnabled, transitionStartTime, canShowUpNextOnCurrentSurface, playlist, handleNextRef, dominantColorRef, autoMixEnhancedTier]),
    { enabled: effectiveCrossfadeEnabled, duration: crossfadeDuration },
    { enabled: effectiveGaplessEnabled, albumGapless: albumGaplessEnabled },
    {
      enabled: effectiveAutoMixEnabled,
      mode: 'auto',
      enableBeatMatching: autoMixBeatMatching,
      skipSilence: autoMixSkipSilence,
      minDuration: autoMixMinDuration,
      maxDuration: autoMixMaxDuration,
      enhanced: autoMixEnhanced,
      engine: autoMixEngine,
      enhancedTier: autoMixEnhancedTier,
      intensity: autoMixTransitionIntensity,
      aiMix: autoMixAiMix && autoMixAiAvailable,
    },
    handleAudioGraphReady
  )
  audioPlayerCacheControlRef.current = audioPlayer
  const playerStemControl = useMemo(() => ({
    ...audioPlayer.trackStems.state,
    onEnable: () => audioPlayer.trackStems.enable(),
    onVocalChange: audioPlayer.trackStems.setVocalLevel,
    onStemChange: (stem: import('./audio/trackStemMixer').TrackStemName, gain: number) => audioPlayer.trackStems.setStemGains({ [stem]: gain }),
    onReturnOriginal: audioPlayer.trackStems.returnToOriginal,
  }), [
    audioPlayer.trackStems.state,
    audioPlayer.trackStems.enable,
    audioPlayer.trackStems.setVocalLevel,
    audioPlayer.trackStems.setStemGains,
    audioPlayer.trackStems.returnToOriginal,
  ])
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
  
  // 需要频谱的插件启用时保持音频分析流（即使封面律动关闭）
  const [pluginAudioActive, setPluginAudioActive] = useState(() => hasEnabledAudioPlugin(isPluginEnabled))
  useEffect(() => {
    const handler = () => setPluginAudioActive(hasEnabledAudioPlugin(isPluginEnabled))
    window.addEventListener(PLUGIN_STATE_EVENT, handler)
    return () => window.removeEventListener(PLUGIN_STATE_EVENT, handler)
  }, [])

  const [traditionalSpectrumVisible, setTraditionalSpectrumVisible] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('waveforge:traditional-preferences:v2') || '{}')
      return stored.showWaveform !== false
    } catch {
      return true
    }
  })
  const [traditionalRightColumnVisible, setTraditionalRightColumnVisible] = useState(() => (
    typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 1180px)').matches
  ))
  useEffect(() => {
    const syncPreference = (event: Event) => {
      const detail = (event as CustomEvent<{ showWaveform?: boolean }>).detail
      if (typeof detail?.showWaveform === 'boolean') setTraditionalSpectrumVisible(detail.showWaveform)
    }
    window.addEventListener('traditionalPreferencesChanged', syncPreference)
    return () => window.removeEventListener('traditionalPreferencesChanged', syncPreference)
  }, [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia('(min-width: 1180px)')
    const sync = () => setTraditionalRightColumnVisible(media.matches)
    sync()
    media.addEventListener?.('change', sync)
    return () => media.removeEventListener?.('change', sync)
  }, [])

  // 播放器状态监听
  // 封面脉冲：30fps 写 CSS 变量 + 全背景子树样式重算（曾实测 RecalcStyle 1325 次/816ms），
  // TV 普通/效能档强制关闭（增强档尊重用户开关）
  const pulseActive = coverPulseEnabled && isPlaying && (!isTvModeActive() || isPerfModeEnhanced())
  const traditionalSpectrumActive = viewMode === 'traditional' && showHome && Boolean(currentSong) && traditionalSpectrumVisible && traditionalRightColumnVisible
  const analyzerEnabledNow = audioAnalyzerEnabled && (pulseActive || pluginAudioActive || traditionalSpectrumActive) && !isPerfModeEfficiency()
  // WebView2 播放面频谱：外部源模式下轮询 bridge /spectrum（WASAPI loopback），
  // 供桌面频谱 tick 与主可视化分析器共同消费
  const externalSpectrumRef = useRef<number[]>(Array(64).fill(0))
  const clearExternalSpectrum = useCallback(() => {
    externalSpectrumRef.current.fill(0)
  }, [])
  useEffect(() => {
    // 游戏模式冻结（主窗隐藏）时停掉这条 20Hz 轮询链：它由 setTimeout 自续，
    // 窗口隐藏后照常满速跑，是穿透冻结的残留负载之一
    if (!externalPlaybackActive || !analyzerEnabledNow || gameModeFrozenRef.current) {
      clearExternalSpectrum()
      return
    }
    let disposed = false
    let timer: number | null = null
    const loop = async () => {
      if (disposed) return
      const spectrum = await fetchBridgeSpectrum()
      if (!disposed) {
        if (spectrum && spectrum.bins.length > 0) externalSpectrumRef.current = spectrum.bins
        else clearExternalSpectrum()
      }
      if (!disposed) timer = window.setTimeout(loop, 50)
    }
    void loop()
    return () => {
      disposed = true
      clearExternalSpectrum()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [externalPlaybackActive, analyzerEnabledNow, clearExternalSpectrum])
  const externalAnalyzerSource = useMemo(() => ({
    active: externalPlaybackActive && analyzerEnabledNow,
    getBins: () => (externalPlaybackActive ? Uint8Array.from(externalSpectrumRef.current) : null),
  }), [externalPlaybackActive, analyzerEnabledNow])
  // WebView2 播放面：B 站 MV 背景读 audio.currentTime 对齐画面（约 7 处同步循环），
  // 外部源模式下本地元素无媒体——用代理视图把 currentTime/duration/paused 重定向到 bridge，
  // 其余属性读转发到底层元素（视频本身静音，无双重出声）
  const externalAudioViewRef = useRef<HTMLAudioElement | null>(null)
  const externalAudioProxyRef = useRef<any>(null)
  if (!externalAudioProxyRef.current) {
    // 原生方法（addEventListener 等）必须绑定底层元素再返回——否则 this 丢失会抛
    // "Illegal invocation" 直接崩掉渲染树；按「属性+元素」缓存绑定，元素切换时重绑
    const boundCache = new Map<string | symbol, { el: any; bound: any }>()
    externalAudioProxyRef.current = new Proxy({} as HTMLAudioElement, {
      get(_target, prop) {
        if (prop === 'currentTime') return getBridgeState().position || 0
        if (prop === 'duration') return getBridgeState().duration || 0
        if (prop === 'paused') return !getBridgeState().playing
        const el = externalAudioViewRef.current
        const value = el ? (el as any)[prop] : undefined
        if (typeof value === 'function') {
          const cached = boundCache.get(prop)
          if (cached && cached.el === el) return cached.bound
          const bound = value.bind(el)
          boundCache.set(prop, { el, bound })
          return bound
        }
        return value
      },
      set(_target, prop, value) {
        const el = externalAudioViewRef.current
        if (el) { (el as any)[prop] = value }
        return true
      },
    })
  }
  const audioAnalyzer = useAudioAnalyzer(
    audioPlayer.analyserNode,
    analyzerEnabledNow, // 效能档关闭音频可视化省资源；DG-LAB 插件启用时保持分析流
    audioPlayer.leftAnalyserNode, // DG-LAB 立体声：左声道（音效后最终听感信号）
    audioPlayer.rightAnalyserNode, // DG-LAB 立体声：右声道
    externalAnalyzerSource,
  )
  const audioPulseStore = useAudioPulseStore(audioAnalyzer, pulseActive, coverPulseMode)

  // 插件系统（DG_LAB、Razer Chroma 等）需要访问实时音频分析流
  useEffect(() => {
    setGlobalAudioAnalyzerStore(audioAnalyzer)
    setChromaAudioAnalyzerStore(audioAnalyzer)
    setSignalRgbAudioAnalyzerStore(audioAnalyzer)
  }, [audioAnalyzer])

  // DG-LAB 实时波形（左右声道时域采样）用分析器
  useEffect(() => {
    setGlobalAudioAnalysers(audioPlayer.leftAnalyserNode, audioPlayer.rightAnalyserNode)
  }, [audioPlayer.leftAnalyserNode, audioPlayer.rightAnalyserNode])

  // 播放状态同步给插件：暂停时进入各自的空闲或安全输出。
  useEffect(() => {
    setGlobalPlaybackActive(isPlaying)
    setChromaPlaybackActive(isPlaying)
    setSignalRgbPlaybackActive(isPlaying)
  }, [isPlaying])
  
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
      // 本地听歌记录：「听歌报告」数据源（每次实际开播记一条，90 秒内同曲去重）
      recordListen(normalizedSong)
      // 酷狗：无缝切换同样是一次开播，与普通播放路径一致上报最近播放（失败静默）
      if ((normalizedSong.platform || 'netease') === 'kugou') {
        void import('./services/kugouService')
          .then(m => m.uploadKugouPlayRecord(normalizedSong))
          .catch(() => undefined)
      }
        if ((normalizedSong.platform || 'netease') === 'qq' && !normalizedSong.album?.picUrl) {
          normalizedSong = await loadQQSongDetail(normalizedSong)
        }
        
        // 接管预加载的音频元素
        if (options.preloadedAudio && options.preloadedAudioUrl) {
          const success = await audioPlayer.adoptExternalAudio(options.preloadedAudio, buildDeckMetadata(normalizedSong, options.preloadedAudioUrl, index, {
            trackKey: getSongKey(normalizedSong),
            duration: normalizedSong.duration / 1000,
            albumId: getLocalAlbumIdentifier(normalizedSong, normalizedSong.platform || 'netease') || undefined,
            albumCover: normalizedSong.album?.picUrl || undefined,
          }))
          
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
        commitCurrentTime(audioPlayer.getAudioElement()?.currentTime || 0)
        const cachedLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics || []
        setLyrics(cachedLyrics)
        setIsPureMusic(detectPureMusic(cachedLyrics))
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
      const enhanced = localStorage.getItem('autoMixEnhanced')
      const intensity = localStorage.getItem('autoMixTransitionIntensity')
      const aiMix = localStorage.getItem('autoMixAiMix')

      setAutoMixEnabled(parseStoredBoolean(enabled, false))
      setAutoMixBeatMatching(parseStoredBoolean(beatMatching, true))
      setAutoMixSkipSilence(parseStoredBoolean(skipSilence, true))
      setAutoMixMinDuration(minDuration ? parseFloat(minDuration) : 2)
      setAutoMixMaxDuration(maxDuration ? parseFloat(maxDuration) : 12)
      setAutoMixEnhanced(parseStoredBoolean(enhanced, false))
      const engineSaved = localStorage.getItem('autoMixEngine')
      setAutoMixEngine(
        engineSaved === 'standard' || engineSaved === 'pro' || engineSaved === 'enhanced'
          ? engineSaved
          : (parseStoredBoolean(enhanced, false) ? 'pro' : 'standard'),
      )
      const tierSaved = localStorage.getItem('autoMixEnhancedTier')
      setAutoMixEnhancedTier(tierSaved === 'advanced' || tierSaved === 'extreme' ? tierSaved : 'lite')
      setAutoMixTransitionIntensity(
        intensity === 'subtle' || intensity === 'strong' ? intensity : 'standard',
      )
      const aiRequested = parseStoredBoolean(aiMix, false)
      setAutoMixAiMix(aiRequested)
      if (!aiRequested) {
        setAutoMixAiAvailable(false)
      } else {
        void window.electron?.render?.aiMixStatus?.()
          .then(status => setAutoMixAiAvailable(status?.available === true))
          .catch(() => setAutoMixAiAvailable(false))
      }

      // 设置状态写入后端日志：无论操作到哪一步，都能看到开关的真实状态
      window.electron?.automixLog?.('settings', JSON.stringify({
        enabled: parseStoredBoolean(enabled, false),
        enhanced: parseStoredBoolean(enhanced, false),
        engine: localStorage.getItem('autoMixEngine') || 'auto',
        tier: localStorage.getItem('autoMixEnhancedTier') || 'lite',
        intensity: intensity === 'subtle' || intensity === 'strong' ? intensity : 'standard',
        aiMix: parseStoredBoolean(aiMix, false),
        beatMatching: parseStoredBoolean(beatMatching, true),
        skipSilence: parseStoredBoolean(skipSilence, true),
        minDuration: minDuration ? parseFloat(minDuration) : 2,
        maxDuration: maxDuration ? parseFloat(maxDuration) : 12,
      })).catch(() => undefined)
    }

    // 挂载时立即记录一次（含默认值），确认渲染端日志链路可用
    handleAutoMixChange()
    // 探针：验证渲染端跑的是含本代码的版本（可在 localStorage leveldb 中直接验证）
    try {
      localStorage.setItem('wf_automix_mount_marker', String(Date.now()))
    } catch {
      // 忽略
    }

    window.addEventListener('autoMixSettingsChanged', handleAutoMixChange)
    return () => {
      window.removeEventListener('autoMixSettingsChanged', handleAutoMixChange)
    }
  }, [])

  useEffect(() => {
    // 'showToast' 与 'app-toast' 双事件名：ExploreView/ProfileView 等处用的是 app-toast，
    // 历史上无人监听导致 7 处提示静默丢失，这里统一接收
    const handleShowToast = (e: CustomEvent) => {
      const { message, type, duration } = e.detail
      addToast(message, type as 'success' | 'error' | 'info', localStorage.getItem('accentColor') || '#3B82F6', duration)
    }
    window.addEventListener('showToast', handleShowToast as EventListener)
    window.addEventListener('app-toast', handleShowToast as EventListener)
    return () => {
      window.removeEventListener('showToast', handleShowToast as EventListener)
      window.removeEventListener('app-toast', handleShowToast as EventListener)
    }
  }, [])

  // 允许独立模式打开全局播放列表面板，避免传统模式依赖父级布局实现按钮行为。
  useEffect(() => {
    const openPlaylist = () => setShowPlaylist(true)
    window.addEventListener('waveforge:open-playlist', openPlaylist)
    return () => window.removeEventListener('waveforge:open-playlist', openPlaylist)
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
    const applyMode = (mode: 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance') => {
      // TV 效能档无桌面模式：遥控器/远程/恢复路径都不会进入桌面（模式卡片也已隐藏）
      if (isTv() && isPerfModeEfficiency() && mode === 'desktop') mode = 'minimal'
      // 记下「进共振之前是什么模式」：下次启动停在共振也能回到原来的模式
      if (mode === 'resonance') {
        rememberResonanceEntryMode(viewModeRef.current)
        // 回到共振模式 = 结束挂起：房间重新驱动本机播放
        const session = getResonanceSession()
        session.setSuspended(false)
        setResonanceSuspended(false)
      }
      setViewMode(mode)
      // 共振不作为启动后的持久目标；离开后记录普通模式，下次启动回到它
      if (mode !== 'resonance') localStorage.setItem('viewMode', mode)
      setEnteredFromMode(mode)
      // 壁纸监控按需启停（桌面模式 + 联动开启才启动）
      syncWallpaperWatcher(mode)
      // 切换模式时清掉待恢复的歌单/搜索来源，避免切回后又自动打开上一次的歌单
      setRestorePlaybackOrigin(null)
      setShowSharedPlayer(false)
      playbackOriginRef.current = { mode, surface: mode === 'minimal' ? 'home' : 'mode-root' }
      setRadarPlaybackActive(false)
      if (mode === 'desktop') setShowHome(false)
      else setShowHome(true)
      // 注意：不在此关闭融合穿透——融合开启时跨模式切换不应重建窗口（会中断播放）。
      // 非桌面模式下由 App 层融合效果强制整窗可交互（见 handleDesktopFusionEffect），
      // 桌面模式由 DesktopView 的悬停检测负责，穿透状态始终有人接管。
      // 探索→简约 切模式时收回顶部歌词模式下拉框/自定义/箭头提示，避免占位残留
      setShowLyricModePanel(false)
      setShowLyricModeCustomize(false)
      setShowLyricModeArrowHint(false)
    }

    // 壁纸监控按需启停：仅「桌面模式 + 壁纸联动开启」时启动，其余模式停止（避免持续 powershell 查询拖慢性能）
    const syncWallpaperWatcher = (mode?: ViewMode) => {
      const inDesktop = (mode ?? viewModeRef.current) === 'desktop'
      const syncOn = localStorage.getItem('wallpaperSyncEnabled') === 'true'
      window.electron?.wallpaper?.setWallpaperWatcherEnabled?.(Boolean(inDesktop && syncOn))
    }
    const onWallpaperSyncChange = () => syncWallpaperWatcher()
    window.addEventListener('wallpaperSyncChanged', onWallpaperSyncChange)
    syncWallpaperWatcher(viewMode)

    const handleViewModeChange = (e: Event) => {
      const mode = (e as CustomEvent).detail as 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance'
      // 共振是插件功能：插件没启用时不该能进这个模式（按钮/卡片/遥控器/注入事件都得拦住）。
      // 插件中心里已经有「启用」开关，这里做最后一道闸，避免绕过界面直接切进去。
      if (mode === 'resonance' && !isPluginEnabled('resonance')) {
        addToast('「共振 · 一起听」插件未启用，请先在插件中心打开', 'info')
        return
      }
      // 房间里还有人 + 要切去别的模式 → 先问「挂起还是退出」，不能一声不响把房间丢了
      // （bypass 由弹窗按钮设置：用户已经选过了，直接放行同一次切换）
      const resonanceRoom = getResonanceSession().getSnapshot()
      if (
        !resonanceModeSwitchBypassRef.current
        && mode !== 'resonance'
        && viewModeRef.current === 'resonance'
        && resonanceRoom.room
        && resonanceRoom.live
      ) {
        // 模式卡片在派发前已经播了过渡动画：既然这次切换被拦下来询问，先把动画收掉，
        // 否则弹窗背后会挂着一个最长 12s 的粒子过渡
        setModeTransition(null)
        setResonanceExitPrompt({ next: mode })
        return
      }
      resonanceModeSwitchBypassRef.current = false
      const revision = ++viewModeChangeRevisionRef.current
      // 目标模式本次会话已经挂载过：内容已经就绪，走「快速档」过渡（压紧版动画，不让用户白等）；
      // 首次访问的模式仍走完整过渡动画。
      const warmTarget = visitedModesRef.current.has(mode)
      // 模式切换过渡动画：若尚未为同一目标显示，则立即显示（点击即盖住，覆盖加载卡顿；
      // 已显示则保留原有 startedAt，不重置最短时长）。模式卡片路径已在 viewModeTransitionStart
      // 里提前预加载 chunk + 盖上动画，这里通常只是兜底（遥控器/远程等直接派发 viewModeChanged 的入口）。
      // 暖目标同样出（快速窗口）——简易风格也靠这里补上动画，不再"只有复杂才有过渡"。
      if (mode !== viewModeRef.current && modeTransitionRef.current?.to !== mode) {
        setModeTransition({ to: mode, startedAt: performance.now(), ready: false, quick: warmTarget })
      }
      const loadTarget = MODE_CHUNK_LOADERS[mode]

      // Keep the current mode painted until the destination chunk is ready, then let the
      // two prepared roots crossfade. React.lazy must never expose the black app base here.
      void loadTarget().then(() => {
        // 快速连续切换时，仅执行最新一次请求；但用户点击的模式必须最终生效，
        // 因此用「最近请求」判断：revision 与当前一致才应用（旧请求自然被丢弃）。
        if (revision !== viewModeChangeRevisionRef.current) return
        const isQuick = modeTransitionRef.current?.to === mode && modeTransitionRef.current.quick === true
        // ★ 复杂转场的动画窗口内继续预加载：目标 chunk 已就位，再把后续播放资源
        //   （接下来几首歌的音频/歌词/封面缓存）提前拉好——3s 动画播完，新模式内容全热。
        //   快速档内容本来就就绪，不做重复预加载。简易转场维持旧机制。
        if (!isQuick) preloadUpcomingSongs(currentIndexRef.current)
        applyMode(mode)
        // 目标模式挂载并绘制一帧后，再等一小段让首次渲染/数据拉取真正展开，然后标记 ready。
        // ready 与最短时长共同决定何时收起过渡动画：完整档 ≥3s、快速档 ≥0.85s；
        // 慢机加载 5~10s 期间动画无限循环，这期间新模式在动画下方正常渲染加载。
        requestAnimationFrame(() => {
          window.setTimeout(() => {
            if (revision !== viewModeChangeRevisionRef.current) return
            setModeTransition((prev) => (prev && prev.to === mode ? { ...prev, ready: true } : prev))
          }, isQuick ? 120 : 800)
        })
      }).catch(error => {
        console.error('[ViewMode] Failed to load target mode:', mode, error)
        // 懒加载失败时不能切模式：React.lazy 的 rejection 会被永久缓存，"下次渲染重试"不成立，
        // 贸然 applyMode 会让渲染树 suspend 且无边界兜底，直接白屏。保持原模式并提示。
        if (revision === viewModeChangeRevisionRef.current) {
          // 立即标记 ready，让过渡动画按最短时长正常收起，否则会一直转圈到 12s 兜底
          setModeTransition(prev => (prev && prev.to === mode ? { ...prev, ready: true } : prev))
          addToast('模式加载失败，请重试', 'error')
        }
      })
    }
    
    window.addEventListener('viewModeChanged', handleViewModeChange as EventListener)
    // 点击模式卡片时立即派发：先显示过渡动画（不切模式），等来源模式的面板收起/内容复位后
    // 再经 viewModeChanged 真正切换——动画从头盖到尾，来源内容不会以展开态残留成顶部占位
    const handleTransitionStart = (e: Event) => {
      const mode = (e as CustomEvent).detail as 'explore' | 'minimal' | 'traditional' | 'desktop'
      if (!['explore', 'minimal', 'traditional', 'desktop', 'resonance'].includes(mode)) return
      const complexStyle = modeTransitionStyleRef.current === 'complex'
      const warmTarget = visitedModesRef.current.has(mode)
      // ★ 复杂转场的预加载前移：动画一开始就拉目标模式的 chunk（import 天然幂等，重复调用零开销），
      //   与面板收起动画并行下载/编译；等 viewModeChanged 到达时 loadTarget() 直接命中缓存。
      //   简易转场维持旧机制（viewModeChanged 时才加载）。
      if (complexStyle) void MODE_CHUNK_LOADERS[mode]().catch(() => undefined)
      // 复杂转场：冷目标 → 完整档动画；暖目标（内容已就绪）→ 压紧的快速档，丝滑但不白等。
      // 简易转场：同样每次都播（暖目标用短窗口）——此前暖目标完全不出遮罩，用户实测
      // 「选了简易就再也看不到简易动画，只剩复杂」（2026-10-06）。
      if (
        mode !== viewModeRef.current
        && modeTransitionRef.current?.to !== mode
      ) {
        setModeTransition({ to: mode, startedAt: performance.now(), ready: false, quick: warmTarget })
      }
    }
    window.addEventListener('viewModeTransitionStart', handleTransitionStart as EventListener)

    return () => {
      window.removeEventListener('wallpaperSyncChanged', onWallpaperSyncChange)
      window.removeEventListener('viewModeChanged', handleViewModeChange as EventListener)
      window.removeEventListener('viewModeTransitionStart', handleTransitionStart as EventListener)
    }
  }, [])

  // 模式过渡动画收起：目标模式已就绪 且 时长 ≥ 最短 3s → 淡出；超过 12s 兜底强制收起（防止异常卡死界面）
  useEffect(() => {
    if (!modeTransition) return
    const timer = window.setInterval(() => {
      const tr = modeTransitionRef.current
      if (!tr) {
        window.clearInterval(timer)
        return
      }
      const elapsed = performance.now() - tr.startedAt
      // 快速档最短时长压到 ~0.85s：动画主线播完即收，既有过渡感又不拖节奏；
      // 简易风格的暖目标窗口略长（1.3s），徽章动画看得清但依旧干脆。
      const minMs = tr.quick
        ? (modeTransitionStyleRef.current === 'simple' ? MODE_TRANSITION_SIMPLE_MIN_MS : MODE_TRANSITION_QUICK_MIN_MS)
        : MODE_TRANSITION_MIN_MS
      if ((tr.ready && elapsed >= minMs) || elapsed >= MODE_TRANSITION_MAX_MS) {
        window.clearInterval(timer)
        setModeTransition(null)
      }
    }, 200)
    return () => window.clearInterval(timer)
  }, [modeTransition])
  
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

  const handleMvBackgroundToggle = () => {
    const newValue = !mvBackgroundEnabled
    setMvBackgroundEnabled(newValue)
    // 重新启用时清掉上次的死胡同回退标记，让 MV 层重新参与匹配
    setMvBackgroundFallback(false)
    localStorage.setItem('mvBackgroundEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new Event('mvBackgroundSettingsChanged'))
  }

  const handleLyricDisplayModeChange = (mode: LyricDisplayMode) => {
    // TV 效能档：WebGL/Pixi 级歌词模式不可进入（面板入口已过滤，这里兜底外部事件路径）
    if (isTvModeActive() && isPerfModeEfficiency() && TV_HEAVY_LYRIC_MODES.includes(mode)) return
    // Close the overlay before swapping the lyric renderer. Keeping both updates in one React batch
    // can preserve the outgoing panel when the renderer changes during its exit transition.
    setShowLyricModePanel(false)
    setShowLyricModeCustomize(false)
    setShowLyricModeArrowHint(false)
    const switchSeq = ++lyricModeSwitchSeqRef.current

    // 切到看歌：记录音频位置 + 停引擎（视频接管音频输出）
    if (mode === 'video') {
      const engineEl = audioPlayerRef.current?.getAudioElement?.()
      const storePosition = audioPlayer.playbackTimeStore.getSnapshot().currentTime
      const rawPosition = Number(engineEl?.currentTime)
      const handoffSongKey = currentSong ? bilibiliSongKeyOf({
        songTitle: currentSong.name,
        artists: currentSong.artists.map((artist: any) => artist.name),
        songDuration: (currentSong.duration || 0) / 1000,
        platform: currentSong.platform,
        id: currentSong.id || currentSong.mid,
      }) : ''
      const rememberedPosition = modeHandoffTimeRef.current?.songKey === handoffSongKey
        ? modeHandoffTimeRef.current.time
        : 0
      const livePosition = Number.isFinite(rawPosition) && rawPosition > 0 ? rawPosition : 0
      const storedPosition = Number.isFinite(storePosition) && storePosition > 0 ? storePosition : 0
      const renderedTransitionActive = transitionState === 'running-transition'
        && (transitionStrategy === 'smart-rendered' || transitionStrategy === 'smart-rendered-v2' || transitionStrategy === 'smart-rendered-qq')
      const pos = renderedTransitionActive
        ? Math.max(storedPosition, livePosition, rememberedPosition)
        : Math.max(livePosition, storedPosition, rememberedPosition)
      modeHandoffTimeRef.current = { songKey: handoffSongKey, time: pos }
      setWatchSyncSeek(createSongOwnedHandoff(handoffSongKey, pos))
      setWatchVideoState(previous => ({
        ...previous,
        playing: false,
        time: pos,
        duration: (currentSong?.duration || 0) / 1000,
        alignmentOffset: 0,
        alignmentVerified: false,
      }))
      watchEngineVolumeRef.current = volume
      watchEngineMutedRef.current = engineEl?.muted ?? false
      const mvState = mvBackgroundStateRef.current
      setWatchInitialVideo(mvState?.songKey === handoffSongKey
        ? createSongOwnedHandoff(handoffSongKey, { ...mvState, currentTime: pos })
        : null)
      // 保持引擎继续播放，直到看歌播放器报告 active；目标 ready 后由 handoff effect 淡出并暂停。
      watchHandoffPendingRef.current = true
      watchPausedEngineRef.current = false
      audioPlayerRef.current?.setWatchHold?.(true)
      const heldEngineEl = audioPlayerRef.current?.getAudioElement?.() || engineEl
      if (heldEngineEl) {
        const duration = Number(heldEngineEl.duration) || 0
        const heldPosition = Math.max(0, Math.min(pos, duration > 0 ? duration - 0.2 : pos))
        if (Math.abs(heldEngineEl.currentTime - heldPosition) > 0.05) heldEngineEl.currentTime = heldPosition
        audioPlayer.playbackTimeStore.publish({ currentTime: heldPosition, isPlaying: !heldEngineEl.paused })
      }
      // 看歌模式视频接管时间线：中止任何在途的音频过渡并清掉过渡视觉状态，
      // 否则 transitionToTrack/预载会残留到切回歌词模式后，把下一首的 MV 叠到 MV 背景上。
      // 挂起引擎自动过渡（setWatchHold 已在冻结逻辑时钟后同步执行）：看歌期间
      // automix 不得 prepare/启动→提交，否则已武装的过渡会在看歌中自动 commit。
      clearTransitionResetTimer()
      setIsTransitioning(false)
      setTransitionProgress(0)
      setTransitionFromTrack(null)
      setTransitionToTrack(null)
      setTransitionFromAccentColor(null)
      setTransitionToAccentColor(null)
      watchResumeHeldAtEndRef.current = false
      // 先加载看歌 chunk 再切：lazy 首挂载 suspend 会落在 app 级 Suspense(fallback=null)
      // 导致整个播放页闪空（chunk 失败不阻断，退化为原有 Suspense 行为）
      void loadBilibiliMvPlayer().catch(() => { /* chunk 失败不阻断 */ }).then(() => {
        window.requestAnimationFrame(() => {
          if (switchSeq !== lyricModeSwitchSeqRef.current) return
          setLyricDisplayMode(mode)
          localStorage.setItem('lyricDisplayMode', mode)
          lyricDisplayModeRef.current = mode
          window.dispatchEvent(new CustomEvent('lyricDisplayModeChanged', { detail: mode }))
        })
      })
      return
    }

    // 切出看歌：视频音频淡出 → 恢复引擎位置并淡入（无缝拼接：前段视频音频 → 后段音源音频）
    if (lyricDisplayModeRef.current === 'video') {
      // 歌曲位 = 视频位 − 对齐偏移：看歌里视频播在「歌曲位+偏移」（Die For You +19.89s），
      // 直接用视频位会让引擎/歌词整体前跳 1~2 句（用户实测）。
      // **货不对板退化（机制保证不坏）**：
      //  - 匹配失败/网格拒绝（自由播放）→ 对齐偏移 = 0 → 歌曲位 = 视频位 = 进入位置+已播时长，
      //    歌曲自然续播，错误视频不会把歌曲位带偏；
      //  - 偏移生效但视频有误 → Math.max(…, watchSyncSeek) 下限 + 歌末尾 dur-0.5 钳制兜底。
      //  - 视频刚进看歌还在缓冲（getCurrentTime≈0~1s，远小于进入位置）→ 下限兜底为进入位置。
      const vidTime = watchPlayerRef.current?.getCurrentTime?.() ?? 0
      const alignOffset = watchPlayerRef.current?.getAlignmentOffset?.() ?? 0
      const currentWatchSongKey = currentSong ? bilibiliSongKeyOf({
        songTitle: currentSong.name,
        artists: currentSong.artists.map((artist: any) => artist.name),
        songDuration: (currentSong.duration || 0) / 1000,
        platform: currentSong.platform,
        id: currentSong.id || currentSong.mid,
      }) : ''
      const entryFloor = readSongOwnedHandoff(watchSyncSeek, currentWatchSongKey, 0)
      const capturedResumeTime = Math.max(vidTime - alignOffset, entryFloor)
      void (async () => {
        try { await watchPlayerRef.current?.fadeOutAudio?.() } catch { /* 淡出失败不阻断 */ }

        // 淡出期间看歌时间线仍在前进；在真正移交控制权时再取一次，避免固定回退约 200ms。
        const handoffWatchTime = watchPlayerRef.current?.getCurrentTime?.() ?? 0
        const handoffOffset = watchPlayerRef.current?.getAlignmentOffset?.() ?? alignOffset
        const resumeTime = Math.max(capturedResumeTime, handoffWatchTime - handoffOffset, entryFloor)
        const engineEl = audioPlayerRef.current?.getAudioElement?.()
        if (engineEl && resumeTime > 0) {
          const dur = Number(engineEl.duration) || 0
          const restored = dur > 0 ? Math.max(0, Math.min(resumeTime, dur - 0.2)) : Math.max(0, resumeTime)
          modeHandoffTimeRef.current = { songKey: currentWatchSongKey, time: restored }
          if (dur > 0 && resumeTime >= dur - 0.5) {
            audioPlayerRef.current?.seek(restored)
            watchResumeHeldAtEndRef.current = true
          } else {
            audioPlayerRef.current?.seek(restored)
          }
        }
        // 先加载目标歌词模式 chunk 再切（防 app 级 Suspense 整页闪空）
        const exitLoader = LYRIC_MODE_LOADERS[mode]
        try { if (exitLoader) await exitLoader() } catch { /* chunk 失败不阻断 */ }
        window.requestAnimationFrame(() => {
          if (switchSeq !== lyricModeSwitchSeqRef.current) return
          setLyricDisplayMode(mode)
          localStorage.setItem('lyricDisplayMode', mode)
          lyricDisplayModeRef.current = mode
          window.dispatchEvent(new CustomEvent('lyricDisplayModeChanged', { detail: mode }))
        })
      })()
      return
    }

    // 先加载目标歌词模式 chunk 再切：lazy 首挂载会 suspend 到 app 级 Suspense(fallback=null)，
    // 整个播放页（含控制条/歌词）会闪空。加载失败不阻塞切换，退化为原有 Suspense 行为
    const modeLoader = LYRIC_MODE_LOADERS[mode]
    const applyLyricMode = () => {
      window.requestAnimationFrame(() => {
        // 迟到的旧切换请求直接丢弃（快速连点时只有最新一次生效）
        if (switchSeq !== lyricModeSwitchSeqRef.current) return
        setLyricDisplayMode(mode)
        localStorage.setItem('lyricDisplayMode', mode)
        window.dispatchEvent(new CustomEvent('lyricDisplayModeChanged', { detail: mode }))
      })
    }
    if (modeLoader) {
      void modeLoader().catch(() => { /* chunk 失败不阻断 */ }).then(applyLyricMode)
      return
    }
    applyLyricMode()
  }

  /** 选择 Folia 歌词样式（第二页样式卡）：保存样式；未在 Folia 页时同时切入 */
  const handleFoliaStyleSelect = (style: string) => {
    // 不支持 WebGL 时绘光会被回落成静止，落盘也存回落后的值，避免下次开机又选中绘光
    const resolved = resolveFoliaStyleFallback(style)
    setFoliaStyle(resolved)
    localStorage.setItem(FOLIA_STYLE_KEY, resolved)
    if (lyricDisplayModeRef.current !== 'folia') handleLyricDisplayModeChange('folia')
  }

  // 外部（快捷设置 QuickSettings 等）发起的歌词模式切换 → 走统一切换逻辑；
  // App 自身派发该事件时 lyricDisplayModeRef 已等于目标 mode，判等后直接忽略（防自触发递归）
  useEffect(() => {
      const handleExternalLyricMode = (event: Event) => {
        const mode = (event as CustomEvent<LyricDisplayMode>).detail
        if (!ALL_LYRIC_MODES.includes(mode) || lyricDisplayModeRef.current === mode) return
        lyricModeHandlerRef.current(mode)
      }
    window.addEventListener('lyricDisplayModeChanged', handleExternalLyricMode)
    return () => window.removeEventListener('lyricDisplayModeChanged', handleExternalLyricMode)
  }, [])

  // 同步其他视图修改的歌词模式可见性设置
  useEffect(() => {
    const handleLyricModesVisibilityChanged = () => setVisibleLyricModes(loadVisibleLyricModes())
    window.addEventListener('waveforge-lyric-modes-visibility-changed', handleLyricModesVisibilityChanged)
    return () => window.removeEventListener('waveforge-lyric-modes-visibility-changed', handleLyricModesVisibilityChanged)
  }, [])

  // 当前所在歌词模式始终保留在可见列表里
  const ensureModernVisible = (modes: LyricDisplayMode[]): LyricDisplayMode[] =>
    modes.includes('modern') ? modes : ['modern', ...modes]
  // TV 效能档：隐藏 WebGL（多维/Folia）与 Pixi（PV）级歌词模式（全速 GPU 渲染弱机带不动）
  const tvEfficiencyFilteredVisibleLyricModes = isTvModeActive() && isPerfModeEfficiency()
    ? visibleLyricModes.filter((m) => !TV_HEAVY_LYRIC_MODES.includes(m))
    : visibleLyricModes
  const effectiveVisibleLyricModes = ensureModernVisible(
    tvEfficiencyFilteredVisibleLyricModes.includes(lyricDisplayMode)
      ? tvEfficiencyFilteredVisibleLyricModes
      : [...tvEfficiencyFilteredVisibleLyricModes, lyricDisplayMode]
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
  // 视觉轨道：90% 切轨后显示封面同步切到目标曲（叠加层已退休，由 canonical 展示无缝接替），
  // 取色随之切到目标曲；配合 applyVisualSwitch 里登记的"最近 ready 色"，切换帧不闪灰。
  const displayCoverUrl = visualTrack?.coverUrl || currentTrack.coverUrl
  // 视觉轨道生效时不再用 canonical 的**动态封面**（Apple HLS 动画封面属于上一首）：各播放页会优先
  // 渲染它并盖掉已切换的静态封面，是半套切换/串台的另一条路径。静态封面仍走 displayCoverUrl。
  const displayAnimatedCoverUrl = visualTrack ? null : (appleDynamicCover.cover?.videoUrl ?? null)
  const displayAnimatedCoverPoster = visualTrack ? null : (appleDynamicCover.cover?.posterUrl ?? null)

  /**
   * 「播放设置」弹窗左侧预览用的播放上下文。
   *
   * 弹窗宿主挂在 App 根节点、portal 到 body，拿不到播放页的上下文，只能在这里组装后透传。
   * 刻意**不下发时间快照**：App 的 currentTime 被 commit gate 门控（只在暂停/跳转/换曲时提交），
   * 当 prop 传下去会一直停在旧值。预览自己订阅 audioPlayer.playbackTimeStore 取连续时间，
   * 与 LiveLyricsDisplay / LivePlayerControls 同一套写法。
   */
  const quickSettingsPlayback = useMemo(() => ({
    track: { title: currentTrack.title, artist: currentTrack.artist, coverUrl: displayCoverUrl },
    lyrics,
    lyricOffset,
    playbackTimeStore: audioPlayer.playbackTimeStore,
  }), [currentTrack.title, currentTrack.artist, displayCoverUrl, lyrics, lyricOffset, audioPlayer.playbackTimeStore])

  // 提取封面主色调
  const { dominantColor: extractedColor, palette: coverPalette, status: coverColorStatus } = useColorThief(displayCoverUrl)
  // P1-2：封面 URL 变化的那一帧 useColorThief 回到 loading（新封面还没采样完），若直接退回中性灰，
  // commit 帧整屏配色（背景渐变/强调色/歌词高亮/控件）会闪一下灰再跳到新色。
  // 这里用 ref 记住最近一次 ready 的主色与色板：未 ready 时沿用（过渡目标色也会在解析完成后
  // 写入该 ref，见 transitionToTrack 取色 effect），只有从未取到过颜色时才退回中性色。
  if (coverColorStatus === 'ready' && (coverPalette[0] || extractedColor)) {
    lastReadyCoverColorRef.current = { color: coverPalette[0] || extractedColor!, palette: coverPalette }
  }
  const lastReadyCoverColor = lastReadyCoverColorRef.current
  const playbackCoverColor = coverColorStatus === 'ready'
    ? (coverPalette[0] || extractedColor || PLAYBACK_NEUTRAL_COLOR)
    : (lastReadyCoverColor.color || PLAYBACK_NEUTRAL_COLOR)
  // 调色板同样沿用（视觉化的 palette 消费点），避免 loading 帧从有色变无色
  const effectiveCoverPalette = coverColorStatus === 'ready' ? coverPalette : lastReadyCoverColor.palette
  const dominantColor = playbackCoverColor
  dominantColorRef.current = playbackCoverColor
  // 歌词模式预设条：色档数据在这里、顺序由用户偏好（orderedLyricModes）决定。
  // 不含 folia —— 它有自己的第二页，不出现在这一页的横格里。
  const lyricModeTiles = [
    { mode: 'modern' as LyricDisplayMode, label: '现代', background: 'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)' },
    { mode: 'immersive' as LyricDisplayMode, label: '沉浸式', background: 'linear-gradient(135deg, #1e3a5f 0%, #0f1c2e 50%, #0a0a0a 100%)' },
    { mode: 'wallpaper' as LyricDisplayMode, label: '墙纸', background: `repeating-linear-gradient(0deg, rgba(255,255,255,.055) 0 1px, transparent 1px 18px), linear-gradient(135deg, ${playbackCoverColor} 0%, #18171c 58%, #09090b 100%)` },
    { mode: 'glorious' as LyricDisplayMode, label: '辉煌', background: `linear-gradient(118deg, #080713 0%, ${playbackCoverColor} 50%, #090911 78%, #101522 100%)` },
    { mode: 'multidimensional' as LyricDisplayMode, label: '多维', background: `linear-gradient(145deg, #05060c 0%, ${playbackCoverColor} 48%, #0b1b2a 72%, #030409 100%)` },
    { mode: 'modeng' as LyricDisplayMode, label: '摩登', background: 'linear-gradient(120deg, #3a3a3c 0%, #232325 45%, #101012 100%)' },
    { mode: 'video' as LyricDisplayMode, label: '看歌', background: 'linear-gradient(120deg, #f8a5c2 0%, #fb7299 45%, #2d1b3d 100%)' },
    { mode: 'pv' as LyricDisplayMode, label: 'PV', background: 'linear-gradient(135deg, #6d28d9 0%, #3b2f8f 42%, #0f172a 100%)' },
  ]
  const orderedLyricModeTiles = orderedLyricModes
    .map(mode => lyricModeTiles.find(tile => tile.mode === mode))
    .filter((tile): tile is (typeof lyricModeTiles)[number] => Boolean(tile))
    .filter(tile => effectiveVisibleLyricModes.includes(tile.mode))
  // 菜单条目按页签切换内容：WaveForge 页列 9 个歌词模式；Folia 页列 Folia 风格
  //（Folia 页签下不出现「Folia」自身——在这个页签它天然是开着的，列出来只会误导）。
  // 两份列表规则一致（当前项与「关掉就不够最小可见数」的项不可隐藏），只是作用对象不同。
  const lyricModeMenuEntries = lyricPanelPage === 'folia'
    ? orderedFoliaStyles.map((id, index) => {
        const isVisible = effectiveVisibleFoliaStyles.includes(id)
        const isCurrent = foliaStyle === id
        return {
          id,
          index,
          label: FOLIA_STYLES.find(style => style.id === id)?.zhName ?? id,
          sublabel: id as string | undefined,
          visible: isVisible,
          locked: isCurrent || (isVisible && effectiveVisibleFoliaStyles.length <= MIN_VISIBLE_FOLIA_STYLES),
          status: isCurrent ? '当前样式' : isVisible ? '显示中' : '已隐藏',
          onToggle: () => toggleFoliaStyleVisibility(id),
          onMove: (targetIndex: number) => moveFoliaStyleTo(id, targetIndex),
          canMoveUp: index > 0,
          canMoveDown: index < orderedFoliaStyles.length - 1,
        }
      })
    : orderedLyricModes.map((mode, index) => {
        const isVisible = effectiveVisibleLyricModes.includes(mode)
        const isCurrent = lyricDisplayMode === mode
        return {
          id: mode as string,
          index,
          label: LYRIC_MODE_NAMES[mode],
          sublabel: undefined as string | undefined,
          visible: isVisible,
          locked: isCurrent || mode === 'modern' || (isVisible && effectiveVisibleLyricModes.length <= 1),
          status: mode === 'modern' ? '始终显示' : isCurrent ? '当前模式' : isVisible ? '显示中' : '已隐藏',
          onToggle: () => toggleLyricModeVisibility(mode),
          onMove: (targetIndex: number) => moveLyricModeTo(mode, targetIndex),
          canMoveUp: index > 0,
          canMoveDown: index < orderedLyricModes.length - 1,
        }
      })
  // 菜单内拖拽排序：按指针所在行直接落位（moveIdToIndex 的语义在「原列表下标」下成立，
  // 上下移都不必做 ±1 修正）。不做自动滚动——列表最多 14 行，够不到时用上/下移按钮兜底。
  const menuListRef = useRef<HTMLDivElement | null>(null)
  const menuDragRef = useRef<{ id: string; pointerId: number } | null>(null)
  const [menuDraggingId, setMenuDraggingId] = useState<string | null>(null)
  const handleMenuGripPointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // 指针捕获失败时拖拽退化为「按一下即停」，不影响上/下移按钮
    }
    menuDragRef.current = { id, pointerId: event.pointerId }
    setMenuDraggingId(id)
  }
  const handleMenuGripPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = menuDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const list = menuListRef.current
    if (!list) return
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-menu-row]'))
    const overIndex = rows.findIndex(row => {
      const rect = row.getBoundingClientRect()
      return event.clientY >= rect.top && event.clientY <= rect.bottom
    })
    if (overIndex < 0) return
    const currentIndex = rows.findIndex(row => row.dataset.menuRow === drag.id)
    if (currentIndex < 0 || currentIndex === overIndex) return
    if (lyricPanelPage === 'folia') moveFoliaStyleTo(drag.id, overIndex)
    else moveLyricModeTo(drag.id, overIndex)
  }
  const endMenuGripDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = menuDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    menuDragRef.current = null
    setMenuDraggingId(null)
  }
  // ── Folia 参数面板：注册表驱动，谁声明了 renderSettingsPanel 就渲染谁 ──
  const [userFoliaTunings, setUserFoliaTunings] = useState<VisualizerTuningBundle>(() => readFoliaTunings())
  const [showFoliaTuning, setShowFoliaTuning] = useState(false)
  // 只用 registry 查询，不 import 任何 renderer：面板存在与否看 entry 有没有声明
  const foliaStyleHasPanel = lyricPanelPage === 'folia'
    && Boolean(getVisualizerRegistryEntry(foliaStyle as never)?.renderSettingsPanel)
  const commitFoliaTuning = (next: Record<string, unknown>) => {
    const bundle: VisualizerTuningBundle = { ...userFoliaTunings, [foliaStyle]: next } as VisualizerTuningBundle
    setUserFoliaTunings(bundle)
    writeFoliaTunings(bundle)
  }
  const resetFoliaTuning = () => {
    const bundle: VisualizerTuningBundle = { ...userFoliaTunings }
    delete bundle[foliaStyle as keyof VisualizerTuningBundle]
    setUserFoliaTunings(bundle)
    writeFoliaTunings(bundle)
  }
  // 动画窗口：过渡动画（卡片/流光/交叉淡化）只在 currentTime 到达 transitionStartTime
  // （=动画起点，最多提前 10s）后才开始。AI 长混音的音频过渡远早于动画点开始，
  // 若不加门控，视觉会跟着 60s 混音全程走。transitionStartTime 为 null（普通交叉淡化/
  // gapless）时视为始终在窗口内，保持 v1 行为不变。
  const inAnimationWindow = transitionStartTime === null || currentTime >= transitionStartTime
  // 叠加动画（封面/字/MV 渐变）在过渡的最后一段完成：窗口取"最后 4 秒"与"90% 切换点"的交集，
  // 使交叉淡化**恰好在视觉轨道切换那一帧到 100%**（随后叠加层退休、由 canonical 无缝接替）。
  const overlayProgress = (() => {
    if (!inAnimationWindow) return 0
    const dur = transitionDuration > 0 ? transitionDuration : 20
    const span = Math.min(4, dur)
    const start = 1 - span / dur
    const end = 0.9
    if (transitionProgress >= end) return 1
    return Math.max(0, Math.min(1, (transitionProgress - start) / Math.max(1e-6, end - start)))
  })()
  const isVisualTransitioning = (isTransitioning && inAnimationWindow) || Boolean(transitionToTrack && overlayProgress > 0 && inAnimationWindow)
  // 视觉切换（progress 90% 的 visualSwitchCommit）是否已把 currentSong 换成过渡目标：
  // 换过之后新曲歌词/封面要做的是「淡入」，不再套用旧曲的淡出时钟（避免暗态→满亮跳变的割裂感）。
  const visualSwitchedToTarget = Boolean(
    transitionToTrack && currentSong && getSongKey(currentSong) === transitionToTrack.trackKey,
  )

  // ---- 歌词交叉淡化（用户诉求：前一首进入过渡就逐渐淡出、后一首逐渐淡入，交叉跟随过渡时长）----
  // 只在"混音音频正在播放"期间生效（armed 等待期不动歌词；提交后交回 canonical）。
  const transitionVisualIdentity = useTransitionVisualIdentity(audioPlayer.transitionVisualStore)
  const transitionAudioRunning = transitionState === 'running-transition'
  const lyricsCrossfadeActive = transitionAudioRunning
    && transitionVisualIdentity.active
    && !transitionVisualIdentity.switched
  // 托管窗口：过渡音频在放（含视觉切换帧到提交之间）——此时歌词不做入场动画、滚动一步到位
  const lyricsManagedSwitch = transitionAudioRunning && transitionVisualIdentity.active
  // 过渡期"先行淡入的下一首歌词"层上报的焦点行：视觉切换帧交给正式歌词树做锚点，
  // 避免"先锚第一句再跳回正确句"的闪跳（切歌瞬间引擎时间线可能还差一帧）。
  const incomingLyricIndexRef = useRef(-1)
  // 稳定引用（只写 ref）：避免每次渲染新建回调击穿 TransitionIncomingLyrics 的 memo
  const handleIncomingLyricIndexChange = useCallback((index: number) => {
    incomingLyricIndexRef.current = index
  }, [])
  // 过渡结束即失效：避免下一轮过渡误用上一轮的行号
  useEffect(() => {
    if (!lyricsManagedSwitch) incomingLyricIndexRef.current = -1
  }, [lyricsManagedSwitch])
  const incomingLyrics = useMemo(() => {
    if (!lyricsManagedSwitch) return null
    const toKey = transitionVisualIdentity.toTrackKey
    if (!toKey) return null
    const cached = preloadCacheRef.current.get(toKey)?.lyrics
    return cached && cached.length > 0 ? cached : null
  }, [lyricsManagedSwitch, transitionVisualIdentity.toTrackKey])
  // 有词 ↔ 纯音乐：纯音乐一侧在过渡期间也保留歌词列（让下一首歌词能淡入/上一首能淡出），
  // 视觉切换帧再收起/展开；配合下面的 layout 动画，封面是"滑过去"而不是"抽一下"。
  const showLyricsColumn = !isPureMusic || Boolean(lyricsCrossfadeActive && incomingLyrics)
  const getMvPlaybackTimeSeconds = useCallback(() => {
    const renderedTransitionActive = transitionState === 'running-transition'
      && (transitionStrategy === 'smart-rendered' || transitionStrategy === 'smart-rendered-v2' || transitionStrategy === 'smart-rendered-qq')
    return renderedTransitionActive
      ? audioPlayer.playbackTimeStore.getSnapshot().currentTime
      : Number.NaN
  }, [audioPlayer.playbackTimeStore, transitionState, transitionStrategy])
  const getMvTransitionTargetTimeSeconds = useCallback(() => {
    const renderedTransitionActive = transitionState === 'running-transition'
      && (transitionStrategy === 'smart-rendered' || transitionStrategy === 'smart-rendered-v2' || transitionStrategy === 'smart-rendered-qq')
    return renderedTransitionActive ? transitionTargetTimeRef.current : Number.NaN
  }, [transitionState, transitionStrategy])
  // 稳定引用包装：BilibiliMvBackground 已 memo，函数 prop 身份必须稳定；
  // 底层实现随 transitionState/strategy 合法变化时经 ref 转发，memo 判等不受影响。
  const mvPlaybackTimeGettersRef = useRef({ playback: getMvPlaybackTimeSeconds, transitionTarget: getMvTransitionTargetTimeSeconds })
  mvPlaybackTimeGettersRef.current = { playback: getMvPlaybackTimeSeconds, transitionTarget: getMvTransitionTargetTimeSeconds }
  const getMvPlaybackTimeSecondsStable = useCallback(() => mvPlaybackTimeGettersRef.current.playback(), [])
  const getMvTransitionTargetTimeSecondsStable = useCallback(() => mvPlaybackTimeGettersRef.current.transitionTarget(), [])
  // 看歌模式下视频为唯一时间线：automix/无缝/交叉过渡全部失效
  // 跨专辑的无缝衔接现在用「智能短交叉」实现（引擎执行策略是 beat-crossfade / fixed-crossfade），
  // 但对用户而言仍是无缝衔接：显示层归类为 gapless（白色 Gapless 标签），与设置语义一致。
  // 交叉淡化设置显式打开时（crossfade 优先于 gapless）保持「纯交叉淡化」不显示引擎名。
  const effectiveTransitionStrategy = lyricDisplayMode === 'video'
    ? 'none'
    : ((transitionStrategy === 'fixed-crossfade' || transitionStrategy === 'beat-crossfade')
      && effectiveGaplessEnabled && !effectiveAutoMixEnabled && !effectiveCrossfadeEnabled
      ? 'gapless'
      : transitionStrategy)
  // AutoMix 过渡时，播放页过渡指示显示 AutoMix 以与无缝衔接(Gapless)区分
  const isAutoMixTransition = effectiveAutoMixEnabled && effectiveTransitionStrategy !== 'gapless' && effectiveTransitionStrategy !== 'none'
  // AutoMix Pro（v2）：播放页过渡指示与右上角提示显示独立文案/样式
  const isEnhancedAutoMix = isAutoMixTransition && autoMixEnhanced
  // AutoMix 三档与无缝衔接的**引擎名**（过渡徽标 / 进度条上方金色提示统一用它，
  // 只写引擎名，不出现「即将介入 / 正在介入 / 过渡效果」这类中间态措辞）：
  //   standard=AutoMix   pro=AutoMix Pro   enhanced=AutoMix Enhanced   gapless=Gapless
  // 单一真源在 transitionEngineDisplayName（AutomixHudBadge.tsx），HUD 与这里共用同一份映射。
  const autoMixEngineLabel = autoMixEngine === 'enhanced'
    ? 'AutoMix Enhanced'
    : autoMixEngine === 'pro' ? 'AutoMix Pro' : 'AutoMix'
  const transitionEngineName = transitionEngineDisplayName(effectiveTransitionStrategy, effectiveAutoMixEnabled, autoMixEngine)

  // 播放提示倒计时目标：
  //  · AutoMix 有介入点 → automixHud.startAt（与药丸时间节点一致）
  //  · 无缝衔接（gapless）→ gaplessBoundaryStartAt（跨专辑 = 交叉起点，同专辑 = 曲末）；
  //    否则用动画窗口起点（=原始末尾前 10s），裁剪/交叉生效时卡片会停在「0秒后」等好几秒
  const upNextEventTime = useMemo(() => {
    const base = automixHud?.startAt
      ?? ((effectiveAutoMixEnabled || effectiveGaplessEnabled) ? (transitionStartTime ?? duration) : duration)
    return gaplessBoundaryStartAt != null ? Math.min(base, gaplessBoundaryStartAt) : base
  }, [automixHud?.startAt, effectiveAutoMixEnabled, effectiveGaplessEnabled, transitionStartTime, duration, gaplessBoundaryStartAt])

  // 过渡调试弹窗：过渡计划就绪（armed）时展示引擎/策略/DJ 效果清单；
  // 受「过渡调试」开关控制（设置 → 开发者选项 → 调试面板），关闭则不显示。
  useEffect(() => {
    if (!transitionDebug || !isTransitionDebugEnabled()) return
    if (transitionDebugToastTimerRef.current !== null) window.clearTimeout(transitionDebugToastTimerRef.current)
    setTransitionDebugToast(transitionDebug)
    transitionDebugToastTimerRef.current = window.setTimeout(() => {
      transitionDebugToastTimerRef.current = null
      setTransitionDebugToast(null)
    }, 6000)
  }, [transitionDebug])

  useEffect(() => {
    const wasTransitioning = wasAudioTransitioningRef.current
    if (isTransitioning && !wasTransitioning) {
      setTransitionFromAccentColor(dominantColor)
    }
    wasAudioTransitioningRef.current = isTransitioning
  }, [dominantColor, isTransitioning])

  // 用户倍速与过渡互斥：过渡开始时广播归一信号（歌曲 audio/看歌 video/背景 MV 各自归 1，
  // 引擎在 overlap 以 BPM speedRatio 接管）；过渡结束（回非过渡态）后由各应用方按设置恢复。
  useEffect(() => {
    if (isTransitioning) notifyPlaybackSpeedTransitionReset()
  }, [isTransitioning])

  useEffect(() => {
    const coverUrl = transitionToTrack?.coverUrl
    let cancelled = false

    if (!coverUrl) {
      // P1-2：commit 帧 transitionToTrack 被清空，而新封面此刻往往还在取色（useColorThief=loading）。
      // 立刻清掉目标色会让整屏配色从"过渡已淡入到的目标色"瞬间掉回上一首/中性灰。保留到新封面
      // 取色 ready 再清；期间 isTransitioning 已为 false，PlayerControls 不会再消费该值。
      // 残留的过渡目标色会在新封面 ready 后（下一次本 effect 运行）被清掉并交给新主色。
      if (coverColorStatus === 'loading') return
      setTransitionToAccentColor(null)
      return
    }

    // 摩登播放页过渡融合层的顶层封面用 512 档（与 preloadUpcomingSongs 的 128/500 两档不同档），
    // armed 期间按 critical 预热 HTTP 缓存；选项必须与渲染处 getResolvedArtworkUrl 完全一致，
    // 保证预加载与 <img> 实际请求命中同一条缓存记录
    void preloadArtwork(coverUrl, { size: 512, priority: 'critical' }).catch(() => undefined)

    extractDominantColor(coverUrl).then(color => {
      if (cancelled) return
      setTransitionToAccentColor(color)
      // P1-2：该结果与 useColorThief 共用同一份按 URL 的内存缓存，等于提前拿到"下一首的主色"，
      // 写入沿用 ref 后，commit 帧新封面尚未 ready 时也能用目标曲配色而不是灰。
      if (color) lastReadyCoverColorRef.current = { color, palette: [color] }
    })

    return () => {
      cancelled = true
    }
  }, [transitionToTrack?.coverUrl, coverColorStatus])

  useEffect(() => {
    // 过渡进行中（准备/armed/混音中）保留叠加层；commit 后（playing/committed/idle）
    // 立即清除过渡封面叠加，恢复当前歌曲封面——不依赖 transitionProgress 是否到 1
    // （过渡进度可能在 commit 时停在 <1，旧条件导致叠加层残留上一曲封面）。
    if (transitionState === 'armed' || transitionState === 'running-transition' || transitionState === 'preparing-next') return
    if (!transitionToTrack) return

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
    transitionState,
    transitionToTrack?.artist,
    transitionToTrack?.coverUrl,
    transitionToTrack?.title,
  ])

  const restoreNavigationEntry = (prev: (typeof navigationStack.current)[number] | undefined): boolean => {
    if (!prev) return false
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    setShowSongDetail(false)
    if (prev.type === 'artist') {
      setSelectedArtistId(prev.id)
      setSelectedArtistPlatform(prev.platform)
      setSelectedArtistTab((prev.tab || 'hotSongs') as PlaybackOrigin['artistTab'])
      setShowArtistDetail(true)
      return true
    }
    if (prev.type === 'album') {
      setSelectedAlbumId(prev.id)
      setSelectedAlbumPlatform(prev.platform)
      setShowAlbumDetail(true)
      return true
    }
    if (prev.type !== 'song') return false
    setSongDetailSong(prev.song)
    setShowSongDetail(true)
    return true
  }

  const closeArtistDetail = () => {
    if (restoreNavigationEntry(navigationStack.current.pop())) return
    setShowArtistDetail(false)
    setSelectedArtistId(null)
    setSelectedArtistAlbumId(undefined)
  }

  const closeAlbumDetail = () => {
    if (restoreNavigationEntry(navigationStack.current.pop())) return
    setShowAlbumDetail(false)
    setSelectedAlbumId(null)
  }

  const closeCommentModal = useCallback(() => {
    setShowCommentModal(false)
    setSelectedCommentSong(null)
  }, [])

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
  const pushNavigation = (entry: (typeof navigationStack.current)[number]) => {
    const stack = navigationStack.current
    const top = stack[stack.length - 1]
    const duplicate = top?.type === entry.type && (
      entry.type === 'song'
        ? top.type === 'song' && getSongKey(top.song) === getSongKey(entry.song)
        : top.type !== 'song' && top.id === entry.id && top.platform === entry.platform
    )
    if (duplicate) return
    if (stack.length >= 20) stack.shift()
    stack.push(entry)
  }

  // 用户主动关闭（关闭按钮/点遮罩/下拉/TV 返回）：只置可见性为 false，让退场动画跑完；
  // 数据、封面与动态封面 HLS 在退场期间保持不动，退场结束后由 onExitComplete 统一释放。
  const closeDetailPlaylist = useCallback(() => {
    setDetailPlaylistOpen(false)
  }, [])

  // 跨弹窗导航关闭（打开艺人/专辑/歌曲详情/相似歌曲、选歌切播放页）：数据即刻释放。
  // 这些场景新弹窗层级低于面板（艺人 z-70 / 歌曲详情与相似歌曲 z-85，面板 z-95），
  // 若让面板播完退场动画，新弹窗会先被盖住约 300ms，属于行为回退。
  const closeDetailPlaylistImmediate = useCallback(() => {
    setDetailPlaylistOpen(false)
    setDetailPlaylist(null)
  }, [])

  // 退场结束回调：用户若在退场期间又打开了（同一或另一歌单），保留数据避免闪空。
  const handleDetailPlaylistExitComplete = useCallback(() => {
    if (detailPlaylistOpenRef.current) return
    setDetailPlaylist(null)
  }, [])

  // 退场结束时读取"当前是否仍可见"。用 ref 而非 state 闭包：回调在退场动画完成时才执行，
  // 闭包里的 state 会是调用时的旧值。
  useEffect(() => {
    detailPlaylistOpenRef.current = detailPlaylistOpen
  }, [detailPlaylistOpen])

  // 歌单详情会话缓存：关→再进同一歌单秒回（冻结约定），不再全量重拉。
  // 短 TTL 避免服务端歌单更新后长时间陈旧；容量封顶防极端浏览堆积。
  const playlistDetailCacheRef = useRef(new Map<string, { at: number; payload: { playlist: any; songs: Song[] } }>())
  const handleOpenPlaylistFromDetail = async (playlistId: string, platform: MusicPlatform) => {
    const cacheKey = `${platform}:${playlistId}`
    const cached = playlistDetailCacheRef.current.get(cacheKey)
    if (cached && Date.now() - cached.at < 60_000) {
      setDetailPlaylist(cached.payload)
      setDetailPlaylistOpen(true)
      return
    }
    setDetailPlaylistLoading(true)
    try {
      const data = await getPlaylistDetail(playlistId, platform)
      const songs = data?.songs || data?.songlist || data?.playlist?.tracks || data?.tracks || []
      const payload = { playlist: data?.playlist || { id: playlistId, platform, name: '歌单' }, songs }
      const cache = playlistDetailCacheRef.current
      cache.set(cacheKey, { at: Date.now(), payload })
      if (cache.size > 8) {
        const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) cache.delete(oldest[0])
      }
      setDetailPlaylist(payload)
      setDetailPlaylistOpen(true)
    } catch {
      closeDetailPlaylistImmediate()
      addToast('歌单加载失败，请稍后重试', 'error')
    } finally {
      setDetailPlaylistLoading(false)
    }
  }
  // 评论弹窗：memo(CommentModal) 配套稳定回调（声明在 handleOpenPlaylistFromDetail 之后，避免 TDZ）
  const commentOpenPlaylistRef = useRef(handleOpenPlaylistFromDetail)
  commentOpenPlaylistRef.current = handleOpenPlaylistFromDetail
  const commentOpenPlaylistStable = useCallback((playlist: { id: string; platform?: MusicPlatform }) => {
    void commentOpenPlaylistRef.current(playlist.id, playlist.platform || 'netease')
  }, [])

  // 处理歌曲选择
  const handleSongSelect = async (song: Song, playlistFromSource?: Song[], origin?: PlaybackOrigin, sourceIndex?: number) => {
    // 同步关闭所有覆盖层/详情弹窗（在任何 await 之前）：点歌即切播放页，防止
    // 艺人/专辑/歌单详情弹窗残留盖在播放页上面无法关闭
    // （含整屏 backdrop-filter 的弹窗：退出节点在播放页挂载时会被卡住不卸载）
    setShowSearch(false)
    setShowProfile(false)
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    setShowSongDetail(false)
    setShowPlaylist(false)
    setShowLogin(false)
    setShowCommentModal(false)
    setShowRemote(false)
    setShowSettings(false)
    setShowMixingStudio(false)
    setShowLyricModePanel(false)
    setShowLyricModeCustomize(false)
    setShowDeviceControl(false)
    setSelectedArtistId(null)
    setSelectedArtistAlbumId(undefined)
    setSelectedAlbumId(null)
    // 选歌是"离开详情弹窗"的动作：清空艺人/专辑导航栈，防止之后 closeAlbumDetail
    // 把早已关闭的上一级弹窗重新弹出（脏栈复活）
    navigationStack.current = []
    // Keep the source view painted while the first-use playback chunks are prepared. Without
    // this, the app-level Suspense boundary can reveal the fixed black base on the first song.
    const isRadioSelection = Boolean(song.appleRadio)
    setAppleRadioSurfaceLocked(isRadioSelection)
    setPendingAppleRadioSong(isRadioSelection ? song : null)
    if (appleRadioReconnectTimerRef.current !== null) {
      window.clearTimeout(appleRadioReconnectTimerRef.current)
      appleRadioReconnectTimerRef.current = null
    }
    if (!isRadioSelection) appleRadioReconnectKeyRef.current = ''
    const playbackSurfaceReady = isRadioSelection
      ? loadAppleRadioNowPlayingPage()
      : Promise.allSettled([
      loadPlaybackRadialMenu(),
      loadImmersiveControls(),
      loadQuickSettingsHost(),
      loadTranslationDisplay(),
      loadModernAudioVisualizer(),
      loadBilibiliMvBackground(),
        lyricDisplayMode === 'wallpaper'
          ? loadWallpaperLyrics()
          : lyricDisplayMode === 'glorious'
            ? loadGloriousLyrics()
              : lyricDisplayMode === 'multidimensional'
                ? loadMultidimensionalLyrics()
                : lyricDisplayMode === 'folia'
                  ? loadFoliaLyricsPage()
                  : lyricDisplayMode === 'modeng'
                    ? loadModengPlayer()
: lyricDisplayMode === 'video'
                    ? loadBilibiliMvPlayer()
                    : lyricDisplayMode === 'pv'
                      ? loadPvLyricsPage()
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
    setRadarPlaybackActive(inferredOrigin.qqRadarContinuation?.mode === 'radar')
    setRestorePlaybackOrigin(null)
    const normalizedSong = normalizeSongCover(normalizeRawSongShape(song))
    const normalizedPlaylist = isRadioSelection ? [normalizedSong] : playlistFromSource?.map(normalizeSongCover)
    const nextPlaylist = isRadioSelection
      ? [normalizedSong]
      : normalizedPlaylist && normalizedPlaylist.length > 0
      ? normalizedPlaylist
      : playlist.some(item => getSongKey(item) === getSongKey(normalizedSong))
        ? playlist
        : [...playlist, normalizedSong]
    // 调用方知道点击项索引时优先用它：队列里同一首歌出现多次时 findIndex 只认第一条，
    // 会出现「点第二条播第一条」。两边都拿不到时退回最后一项（该分支里它正是刚追加的那首），
    // 不再用 Math.max(0, ...) 静默改播列表第一首。
    const foundIndex = nextPlaylist.findIndex(item => getSongKey(item) === getSongKey(normalizedSong))
    const selectedIndex = typeof sourceIndex === 'number' && sourceIndex >= 0 && sourceIndex < nextPlaylist.length
      && getSongKey(nextPlaylist[sourceIndex]) === getSongKey(normalizedSong)
      ? sourceIndex
      : foundIndex >= 0
        ? foundIndex
        : Math.max(0, nextPlaylist.length - 1)

    audioPlayer.cancelTransition('explicit song selection', false)
    bumpQueueRevision()
    currentIndexRef.current = selectedIndex
    setPlaylist(nextPlaylist)
    setCurrentIndex(selectedIndex)

    const originMode = inferredOrigin.mode || viewMode
    // 共振房内的换歌由房主权威状态驱动（见 resonanceAdapter.apply）。共振模式必须原地切歌：
    // 若走到下面的 setViewMode('minimal')，成员会被踢出共振界面、并且把持久化的
    // viewMode 覆写成 minimal——与 docs/resonance-design.md「共振页内不切走播放页」相悖。
    // 桌面模式同理原地播放：点歌只弹桌面迷你播放器，绝不抢整个窗口进播放页
    // （抢切会把 viewMode 持久化成 minimal，之后不管从哪切回桌面都会再被拽进播放页）。
    const playsInPlace = !isRadioSelection && (originMode === 'traditional' || originMode === 'explore' || originMode === 'resonance' || originMode === 'desktop')
    // 电台从探索页点播：探索页（含电台弹窗）保持挂载，播放页以覆盖层打开，返回时原样呈现弹窗
    const exploreRadioOverlay = isRadioSelection && originMode === 'explore'
    setEnteredFromMode(originMode)
    if (viewMode !== 'minimal' && !playsInPlace && !exploreRadioOverlay) {
      setViewMode('minimal')
      localStorage.setItem('viewMode', 'minimal')
    }
    setShowProfile(false)
    setShowSearch(false)
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    setShowSharedPlayer(false)
    if (isRadioSelection) {
      void playbackSurfaceReady
      setShowHome(false)
      if (exploreRadioOverlay) {
        playbackOriginRef.current = inferredOrigin
        setEnteredFromMode('explore')
        setShowSharedPlayer(true)
      } else {
        setShowSharedPlayer(false)
      }
    } else if (originMode === 'explore') {
      setShowHome(true)
      // 探索页设置「点击歌曲直接进入播放页」：探索页保持挂载，播放页覆盖其上
      let exploreOpenPlayerPref = false
      try {
        exploreOpenPlayerPref = (JSON.parse(localStorage.getItem('explorePreferences') || '{}') as { openPlayerOnSongSelect?: unknown }).openPlayerOnSongSelect === true
      } catch { /* 偏好缺失按默认（留在探索页）处理 */ }
      if (exploreOpenPlayerPref) {
        playbackOriginRef.current = inferredOrigin
        setRestorePlaybackOrigin(null)
        setEnteredFromMode('explore')
        setShowSharedPlayer(true)
        // 必须同时收起首页：播放页表面只在 {currentSong && !showHome} 分支里渲染，
        // 少了这一句用户点歌后会停在首页（只剩 mini 播放器），与设置项
        // 「直接进入播放页」的语义不符。另两条设 showSharedPlayer(true) 的路径
        // （电台浮层 / onOpenPlayer）都是配对 setShowHome(false) 的，这里原先漏了。
        setShowHome(false)
      }
    } else if (!playsInPlace) {
      await playbackSurfaceReady
      // 记录进入来源：播放页 Home 键/主页按钮据此返回正确的模式
      playbackOriginRef.current = inferredOrigin
      setShowHome(false)
    }
    await loadAndPlaySong(nextPlaylist[selectedIndex] || normalizedSong, selectedIndex, nextPlaylist)
  }
  retryAppleRadioRef.current = (song, index) => {
    void loadAndPlaySong(song, index, [song])
  }

  // 打开艺人详情
  const handleOpenArtist = (artistId: string, platform: MusicPlatform, artistName = '') => {
    // 歌单详情面板(z-95)高于艺人弹窗(z-70)：从面板内"查看歌手"时先关面板，避免新弹窗被盖住。
    // 这里必须立即释放数据（不能等退场动画），否则新艺人弹窗会被仍在退场的面板压住约 300ms。
    closeDetailPlaylistImmediate()
    // 先关闭弹窗（不触发导航栈弹出）
    const hadAlbum = showAlbumDetail && selectedAlbumId
    const hadArtist = showArtistDetail && selectedArtistId
    const hadSong = showSongDetail && songDetailSong
    const prevSong = hadSong ? { type: 'song' as const, song: songDetailSong } : null
    const prevArtist = hadArtist ? { type: 'artist' as const, id: selectedArtistId, platform: selectedArtistPlatform, tab: selectedArtistTab } : null
    const prevAlbum = hadAlbum ? { type: 'album' as const, id: selectedAlbumId, platform: selectedAlbumPlatform } : null
    // 临时阻止 closeAlbumDetail/closeCommentModal 弹出导航栈
    const savedStack = navigationStack.current
    navigationStack.current = [] as any
    closeAlbumDetail()
    closeCommentModal()
    setShowSongDetail(false)
    navigationStack.current = savedStack
    // 压入导航栈
    if (prevAlbum) pushNavigation(prevAlbum)
    if (prevArtist) pushNavigation(prevArtist)
    if (prevSong) pushNavigation(prevSong)
    setSelectedArtistId(artistId)
    setSelectedArtistPlatform(platform)
    setSelectedArtistName(String(artistName || ''))
    setSelectedArtistAlbumId(undefined)
    setSelectedArtistTab('hotSongs')
    setShowArtistDetail(true)
  }

  // 打开专辑详情
  const handleOpenAlbum = (albumId: string, platform: MusicPlatform) => {
    // 歌单详情面板(z-95)低于专辑弹窗(z-300)可见，但为统一"离开面板"语义，同样立即关闭
    closeDetailPlaylistImmediate()
    const hadAlbum = showAlbumDetail && selectedAlbumId
    const hadArtist = showArtistDetail && selectedArtistId
    const hadSong = showSongDetail && songDetailSong
    const prevSong = hadSong ? { type: 'song' as const, song: songDetailSong } : null
    const prevArtist = hadArtist ? { type: 'artist' as const, id: selectedArtistId, platform: selectedArtistPlatform, tab: selectedArtistTab } : null
    const prevAlbum = hadAlbum ? { type: 'album' as const, id: selectedAlbumId, platform: selectedAlbumPlatform } : null
    // 临时阻止 closeArtistDetail/closeCommentModal 弹出导航栈
    const savedStack = navigationStack.current
    navigationStack.current = [] as any
    closeArtistDetail()
    closeCommentModal()
    setShowSongDetail(false)
    navigationStack.current = savedStack
    // 压入导航栈
    if (prevArtist) pushNavigation(prevArtist)
    if (prevAlbum) pushNavigation(prevAlbum)
    if (prevSong) pushNavigation(prevSong)
    setSelectedAlbumId(albumId)
    setSelectedAlbumPlatform(platform)
    setShowAlbumDetail(true)
  }

  const handlePlayerHome = () => {
    const origin = playbackOriginRef.current
    const targetMode = origin.mode || enteredFromMode || 'minimal'

    setAppleRadioSurfaceLocked(false)
    if (targetMode === 'explore' && viewModeRef.current === 'explore') {
      // 探索页保持挂载：直接关播放页覆盖层，滚动位置/弹窗/已加载内容原样保留，不重载
      setEnteredFromMode('explore')
      setShowSharedPlayer(false)
      setShowHome(true)
      return
    }
    setViewMode(targetMode)
    localStorage.setItem('viewMode', targetMode)
    setEnteredFromMode(targetMode)
    setShowSharedPlayer(false)
    setShowHome(targetMode !== 'desktop')
    setShowSearch(origin.surface.startsWith('search'))
    setShowProfile(false)
    setShowArtistDetail(false)
    setShowAlbumDetail(false)
    // 回到来源页：弹窗全部关闭，导航栈一并清空，避免残留脏条目
    navigationStack.current = []

    if ((origin.surface === 'artist' || origin.surface === 'artist-album') && origin.artistId && origin.platform) {
      setSelectedArtistId(String(origin.artistId))
      setSelectedArtistPlatform(origin.platform)
      setSelectedArtistAlbumId(origin.albumId)
      setSelectedArtistTab(origin.artistTab || (origin.albumId ? 'albums' : 'hotSongs'))
      setShowArtistDetail(true)
    } else if (origin.surface === 'album' && origin.albumId && origin.platform) {
      setSelectedAlbumId(String(origin.albumId))
      setSelectedAlbumPlatform(origin.platform)
      setShowAlbumDetail(true)
    }

    const revision = ++restorePlaybackRevisionRef.current
    setRestorePlaybackOrigin({ ...origin, mode: targetMode, revision })
  }
  // 键盘 Home 键：播放页时等同「回到主页」chip（遥控 Home 动作只覆盖遥控通道，键盘此前无处理）
  const handlePlayerHomeRef = useRef<() => void>(() => undefined)
  handlePlayerHomeRef.current = handlePlayerHome
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // 仅 Home 裸键生效（带修饰键的组合留给系统/其他快捷键）
      if (event.key !== 'Home' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || target.getAttribute('role') === 'slider')) return
      if (!backStateRef.current.isPlaybackPage) return
      event.preventDefault()
      handlePlayerHomeRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // 下一首播放
  // 「下一首播放」的插入游标：连点两次时第二首会插到第一首前面（顺序反了），
  // 因为每次都算 currentIndex + 1。这里记住上一首插到哪，当前曲目变了就重置。
  const playNextCursorRef = useRef<{ base: number; at: number }>({ base: -1, at: 0 })
  const handlePlayNext = (song: Song, toastText = '已添加至下一首播放') => {
    audioPlayer.cancelTransition('play-next queue changed', false)
    bumpQueueRevision()
    if (playNextCursorRef.current.base !== currentIndexRef.current) {
      playNextCursorRef.current = { base: currentIndexRef.current, at: currentIndexRef.current + 1 }
    }
    const insertAt = playNextCursorRef.current.at
    const prependInstead = currentIndexRef.current < 0
    setPlaylist(prev => {
      if (prev.length === 0) return [song]
      if (prependInstead) return [song, ...prev]
      const at = Math.max(0, Math.min(insertAt, prev.length))
      const newPlaylist = [...prev]
      newPlaylist.splice(at, 0, song)
      return newPlaylist
    })
    playNextCursorRef.current = { base: currentIndexRef.current, at: insertAt + 1 }
    // 索引类副作用移出 setState updater：updater 必须是纯函数（StrictMode/并发下可能被重放）
    if (playlist.length === 0 || prependInstead) {
      currentIndexRef.current = 0
      setCurrentIndex(0)
    }

    // 显示全局消息提示
    addToast(toastText, 'success')
  }

  // 相似歌曲·插入下一首（网易云客户端「相似歌曲」灯泡同款取歌，但不打断当前播放）：
  // 取第一首相似歌曲，走「下一首播放」同一条插入链路（游标/队列 revision/引擎重排一致），
  // 当前歌曲继续播完；列表为空或没有当前曲目时才直接起播。
  const queueSimilarNext = async (song: Song | null) => {
    if (!song) return
    if (song.platform === 'apple' || song.platform === 'soda') {
      addToast('当前平台暂不支持相似歌曲', 'info')
      return
    }
    try {
      const similarId = song.platform === 'qq' ? String(song.id || song.mid) : String(song.id)
      const similarRaw = await getSimilarSongs(similarId, (song.platform || 'netease') as 'netease' | 'qq')
      // 响应形状按平台不同（网易云 { songs } / QQ { result, data: [...] }），统一归一化——
      // 直接对整个响应 .find 会在 QQ 上崩（实测 V.find is not a function，387433441）
      const platform = (song.platform || 'netease') as string
      const similarList = normalizeSimilarSongItems(extractSimilarSongItems(similarRaw), platform)
      const selfKey = getSongKey(song)
      const candidate = similarList.find((item) => getSongKey(item) !== selfKey)
      if (!candidate) {
        addToast('没有找到可播放的相似歌曲', 'info')
        return
      }
      const idx = currentIndexRef.current
      if (idx < 0 || playlist.length === 0) {
        handleSongSelect(candidate)
        return
      }
      handlePlayNext(candidate, `相似歌曲：${candidate.name}，已添加至下一首播放列表`)
    } catch (error) {
      console.error('[相似歌曲] 切歌失败:', error)
      addToast('相似歌曲获取失败，请重试', 'error')
    }
  }

  // 添加到我喜欢
  const handleAddToFavorites = async (song: Song): Promise<boolean> => {
    try {
      const platform = (song.platform || 'netease') as MusicPlatform
      // Apple：“喜爱”是评分状态，与“加入资料库”是两个独立操作。
      if (platform === 'apple') {
        if (!appleLoggedIn) {
          addToast('请先登录 Apple Music', 'error')
          return false
        }
        const appleSongId = song.appleId || String(song.id)
        const ok = await setAppleSongLoved(appleSongId, true)
        if (ok) {
          addToast('已标记为喜爱歌曲', 'success')
          applyFavoriteMutation({ platform: 'apple', type: 'like', songId: appleSongId })
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'like', songId: appleSongId }
          }))
          return true
        } else {
          const failure = getLastAppleMutationResult()
          addToast(failure.error || '标记喜爱歌曲失败', 'error')
          return false
        }
      }
      const userId = getPlatformUserId(platform)
      
      if (!userId) {
        addToast(`请先登录${platformLabel(platform)}`, 'error')
        return false
      }
      
      const mutationSong = platform === 'qq' && (!song.mid || !/^\d+$/.test(String(song.id)))
        ? await loadQQSongDetail(song)
        : song
      if (platform === 'qq' && !mutationSong.mid) {
        addToast('缺少 QQ 音乐歌曲 MID，无法添加到喜欢', 'error')
        return false
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
        return true
      } else {
        addToast(result.error || result.message || '添加到喜欢失败', 'error')
        return false
      }
    } catch (error) {
      console.error('添加到喜欢时出错:', error)
      addToast(error instanceof Error ? error.message : '添加到喜欢失败', 'error')
      return false
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
        const appleId = String(song.appleId || '')
        const libraryId = String(song.appleLibraryId || '')
        const appleTrack = {
          catalogId: appleId && !APPLE_LIBRARY_ID_PATTERN.test(appleId) ? appleId : undefined,
          libraryId: libraryId || (APPLE_LIBRARY_ID_PATTERN.test(appleId) ? appleId : undefined),
        }
        const ok = await addAppleTracksToPlaylist(playlistId, [appleTrack])
        const appleSongId = appleTrack.catalogId || appleTrack.libraryId || ''
        if (ok) {
          addToast('已添加到 Apple 歌单', 'success')
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'add', songId: appleSongId, playlistId }
          }))
        } else {
          const failure = getLastAppleMutationResult()
          addToast(failure.error || '添加到 Apple 歌单失败', 'error')
        }
        return
      }
      const userId = getPlatformUserId(platform)
      
      if (!userId) {
        addToast(`请先登录${platformLabel(platform)}`, 'error')
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
    const platform = (song.platform || 'netease') as MusicPlatform
    if (!getPlatformCapabilities(platform).comments) {
      addToast(`${platformLabel(platform)}不支持歌曲评论`, 'info')
      return
    }
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

      // Lyrics and artwork begin together with audio preparation. The upcoming
      // player image is decoded before transition state starts using it.
      void ensureSongLyrics(song, cacheKey)
      // 封面必须按「播放页封面用的那一档清晰度」预热，否则切歌后仍要现下载。
      // 缓存键与代理 URL 都带清晰度（`artwork:v1:{platform}:{rendition}:{source}`）：
      // 背景层要 background(128)，播放页封面走 getProxiedImageUrl 的默认 size=500→512 桶。
      // 此前 position 0 只预热 background，切歌后封面 <img> 得重新拉 512 图；下载期间
      // 浏览器继续显示上一首已解码的位图（不会闪空），表现就是"背景已换成新歌、
      // 封面还停在上一首 3~4 秒"。
      // 这里显式传 size:500（而不是 role）以与 displayCoverUrl 完全同一档，
      // 不受 devicePixelRatio 影响——URL 一致才能真正命中 HTTP 缓存。
      const coverSource = song.album?.picUrl || ''
      const isImmediateNext = position === 0
      void preloadArtwork(coverSource, {
        role: 'background',
        priority: isImmediateNext ? 'critical' : 'deferred',
      }).catch(() => undefined)
      void preloadArtwork(coverSource, {
        size: 500,
        priority: isImmediateNext ? 'critical' : 'visible',
      }).catch(() => undefined)

      // Apple 原生播放只为第一首确定的 next 预取 CENC stream，限制为 active + standby 两个会话。
      // WebView2 是外部播放源，不能进入本地双 deck；第二首只预取歌词，不提前申请 license。
      if (platform === 'apple' && (isAppleNativeStreamEnabled() || isBridgeReady())) {
        if (position !== 0 || song.appleRadio || !isAppleNativeStreamEnabled() || !(effectiveCrossfadeEnabled || effectiveGaplessEnabled || effectiveAutoMixEnabled)) {
          debugLog(`🍎 [Preload] ${song.name}: 跳过 Apple 载体预载`)
          return
        }
        const nativePreloadKey = `${requestRevision}:${idx}:${cacheKey}`
        if ((appleNativePreloadAttemptsRef.current.get(nativePreloadKey) || 0) >= 2) {
          debugLog(`🍎 [Preload] ${song.name}: 本轮 Apple CENC standby 重试已达上限`)
          return
        }
        if (appleNativePreloadKeyRef.current === nativePreloadKey) {
          debugLog(`🍎 [Preload] ${song.name}: 复用进行中的 Apple CENC standby 请求`)
          return
        }
        appleNativePreloadKeyRef.current = nativePreloadKey
        const settleNativePreload = (success: boolean) => {
          if (success) {
            appleNativePreloadAttemptsRef.current.delete(nativePreloadKey)
            return
          }
          if (appleNativePreloadKeyRef.current === nativePreloadKey) appleNativePreloadKeyRef.current = ''
          const attempts = (appleNativePreloadAttemptsRef.current.get(nativePreloadKey) || 0) + 1
          appleNativePreloadAttemptsRef.current.set(nativePreloadKey, attempts)
          if (attempts >= 2 || appleNativePreloadRetryTimerRef.current !== null) return
          appleNativePreloadRetryTimerRef.current = window.setTimeout(() => {
            appleNativePreloadRetryTimerRef.current = null
            const nextIndex = getUpcomingIndices(
              playlistRef.current.map(getSongKey),
              currentIndexRef.current,
              modeOverride,
              requestRevision,
              1,
            )[0]
            if (requestRevision !== queueRevisionRef.current
              || audioUrlGeneration !== audioUrlCacheGenerationRef.current
              || nextIndex !== idx
              || getSongKey(playlistRef.current[idx]) !== cacheKey) return
            preloadUpcomingSongs(currentIndexRef.current, requestRevision, modeOverride)
          }, 1_000)
        }
        void (async () => {
          let streamId = String(song.appleId || song.id || '')
          if (streamId && APPLE_LIBRARY_ID_PATTERN.test(streamId)) {
            streamId = await resolveAppleLibraryCatalogId(streamId).catch(() => null) || ''
          }
          const stream = streamId && streamId !== '0' && await isAppleEmeCapable()
            ? await resolveAppleNativeStream(streamId)
            : null
          const currentUpcoming = getUpcomingIndices(
            playlistRef.current.map(getSongKey),
            currentIndexRef.current,
            modeOverride,
            requestRevision,
            1,
          )[0]
          const requestIsCurrent = requestRevision === queueRevisionRef.current
            && audioUrlGeneration === audioUrlCacheGenerationRef.current
            && currentUpcoming === idx
            && getSongKey(playlistRef.current[idx]) === cacheKey
          if (!stream || !requestIsCurrent) {
            if (stream) releaseAppleNativeStream(stream)
            settleNativePreload(false)
            return
          }
          debugLog(`🍎 [Preload] Apple CENC standby 就绪: ${song.name}`)
          audioPlayer.preloadNext(buildDeckMetadata(song, stream.url, idx, {
            appleHls: stream,
            trackKey: cacheKey,
            duration: song.duration / 1000,
            albumId: getLocalAlbumIdentifier(song, platform) || undefined,
            albumCover: song.album?.picUrl || undefined,
            onPreloadSettled: settleNativePreload,
          }))
        })().catch(error => {
          settleNativePreload(false)
          console.warn(`[Preload] Apple CENC standby 失败: ${song.name}`, error)
        })
        return
      }

      // Apple 原生播放被明确关闭且 bridge 未运行时，预载备用载体 URL。
      const audioSource = platform === 'apple'
        ? resolvePlayableSong(song).then(resolved => resolved
            ? { songId: resolved.platform === 'qq' ? resolved.mid || resolved.id : resolved.id, platform: resolved.platform || 'netease' }
            : null)
        : Promise.resolve({ songId: (platform === 'qq' || platform === 'soda' || platform === 'kugou') ? (song.mid || song.id) : song.id, platform })
      
      // 检查缓存是否已存在且未过期（5分钟内有效）
      const cached = preloadCacheRef.current.get(cacheKey)
      const now = Date.now()
      if (cached && cached.url && (now - (cached.urlTimestamp ?? cached.timestamp)) < 5 * 60 * 1000) {
        debugLog(`✅ [Preload] 使用缓存的 URL: ${cached.url.substring(0, 50)}...`)
        // 只预加载第一首歌到音频元素，其他歌曲只缓存
        if (requestRevision === queueRevisionRef.current && position === 0 && (effectiveCrossfadeEnabled || effectiveGaplessEnabled || effectiveAutoMixEnabled)) {
          debugLog(`📥 [Preload] 调用 audioPlayer.preloadNext (从缓存)`)
          debugLog(`   Position: ${position}`)
            audioPlayer.preloadNext(buildDeckMetadata(song, getProxiedAudioUrl(cached.url), idx, {
              trackKey: cacheKey,
              duration: song.duration / 1000,
              albumId: getLocalAlbumIdentifier(song, platform) || undefined,
              albumCover: song.album?.picUrl || undefined,
            }))
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
            if (requestRevision === queueRevisionRef.current && position === 0 && (effectiveCrossfadeEnabled || effectiveGaplessEnabled || effectiveAutoMixEnabled)) {
              debugLog(`📥 [Preload] 调用 audioPlayer.preloadNext (新获取)`)
              debugLog(`   Position: ${position}, URL: ${url.substring(0, 80)}...`)
              audioPlayer.preloadNext(buildDeckMetadata(song, getProxiedAudioUrl(url), idx, {
                trackKey: cacheKey,
                duration: song.duration / 1000,
                albumId: getLocalAlbumIdentifier(song, platform) || undefined,
                albumCover: song.album?.picUrl || undefined,
              }))
            }
          } else {
            debugLog(`❌ [Preload] 第 ${position + 1} 首歌曲 URL 获取失败，可能是VIP歌曲`)
          }
        }).catch(err => {
          console.error(`  ❌ 第 ${position + 1} 首歌曲失败: ${song.name}`, err)
        })
      })
    })
  }, [playlist, playMode, queueRevision, effectiveCrossfadeEnabled, effectiveGaplessEnabled, effectiveAutoMixEnabled, audioPlayer.preloadNext, ensureSongLyrics])

  useEffect(() => {
    const continuation = infiniteExploreContinuationRef.current
    // Apple「自动连播」：与探索页无限推荐共用续载框架（临近队尾时补曲），但走官方
    // stations/continuous 协议（用队列末尾歌曲作种子创建连续电台，next-tracks 取曲）。
    const appleAutoplayActive = appleAutoplayEnabled
      && playMode === 'sequential'
      && playlist.length > 0
      && playlist[0]?.platform === 'apple'
      && currentIndex >= 0
      && !playlist[currentIndex]?.appleRadio
    if (playbackOriginRef.current.continuation !== 'explore-infinite' && !appleAutoplayActive) {
      continuation.loading = false
      continuation.lastQueueLength = 0
      continuation.batch = 1
      continuation.advancePending = false
      return
    }

    if (playlist.length === 0 || currentIndex < 0 || playlist.length - currentIndex > (appleAutoplayActive ? 2 : 6)) return
    if (continuation.loading || continuation.lastQueueLength === playlist.length) return

    continuation.loading = true
    continuation.lastQueueLength = playlist.length
    const requestedBatch = continuation.batch
    continuation.batch += 1

    const excludedSongKeys = playlistRef.current.map(song => String(song.mid || song.id || '')).filter(Boolean)
    const continuationPlatform = playbackOriginRef.current.platform || playlist[0]?.platform || 'netease'
    const neteaseContinuation = playbackOriginRef.current.neteaseContinuation
    const qqRadarContinuation = playbackOriginRef.current.qqRadarContinuation
    // 网易云心动/漫游和 QQ 刷歌沿用各自的原生接口，其他平台保持原有推荐续取路径。
    const continuationRequest = continuationPlatform === 'netease' && neteaseContinuation?.mode === 'heart-mode'
      ? fetchNeteaseHeartMode(playlist[currentIndex]?.id || playlist[playlist.length - 1]?.id || 0, neteaseContinuation.playlistId, undefined, { count: 30 })
      : continuationPlatform === 'netease' && neteaseContinuation?.mode === 'roam'
        ? fetchNeteaseRoam(undefined, { unplaySongIds: excludedSongKeys })
        : continuationPlatform === 'qq' && qqRadarContinuation?.mode === 'radar'
          ? fetchQQRadarSongs({ page: qqRadarContinuation.page, reqType: qqRadarContinuation.reqType, entranceSongs: qqRadarContinuation.entranceSongs }).then(result => {
              // continuation.page 语义 = 待取页（首次=后端返回的 已取页+1）；取完推进到下一页，避免漏批/重取
              if (result.page) qqRadarContinuation.page = result.page
              return result.songs
            })
          : appleAutoplayActive
            ? (async () => {
                // 种子=队列末尾 3 首的 Apple 目录 id；同一播放上下文复用同一连续电台
                // （next-tracks 是游标式接口，连调返回不同曲目），换播放列表后重建。
                if (appleAutoplayRef.current.disabled) throw new Error('Apple 自动连播已停用（此前创建失败）')
                const queue = playlistRef.current
                const seedKey = getSongKey(queue[0] || playlist[0])
                if (appleAutoplayRef.current.seedKey !== seedKey || !appleAutoplayRef.current.stationId) {
                  const seeds = queue.slice(-3)
                    .map(song => String(song.appleId || ''))
                    .filter(id => /^\d+$/.test(id))
                  const station = await createAppleAutoplayStation(seeds)
                  if (!station) throw new Error('Apple 自动连播电台创建失败（未登录或种子无效）')
                  appleAutoplayRef.current = { seedKey, stationId: station.id }
                }
                const autoplayStationId = appleAutoplayRef.current.stationId
                if (!autoplayStationId) throw new Error('Apple 自动连播电台不可用')
                return fetchAppleAutoplayTracks(autoplayStationId, 5)
              })()
            // QQ 电台（猜你喜欢/随心听）：一次补 5 首走 fast 路径（≈0.9s），续拉很快；
            // 官方播放列表里就是「共 5 首 + 持续推荐歌曲」这个语义。
            : fetchExploreRecommendationBatch(
              continuationPlatform,
              requestedBatch,
              excludedSongKeys,
              undefined,
              continuationPlatform === 'qq' ? { count: 5, fast: true } : {},
            )
    // 请求发起时的加载修订号：若用户等待期间手动换歌，只追加队列，不自动抢播。
    const loadRevisionAtRequest = songLoadRevisionRef.current
    void continuationRequest
      .then(songs => {
        if (!appleAutoplayActive && playbackOriginRef.current.continuation !== 'explore-infinite') return
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
          // 仅当等待期间没有新加载（用户没手动选歌）且仍在续播上下文时才自动续播
          if (shouldAdvance && songLoadRevisionRef.current === loadRevisionAtRequest
            && (playbackOriginRef.current.continuation === 'explore-infinite' || appleAutoplayActive)) {
            const nextIndex = trimmedQueue.length
            currentIndexRef.current = nextIndex
            setCurrentIndex(nextIndex)
            void loadAndPlaySong(nextQueue[nextIndex], nextIndex, nextQueue)
          }
        }, 0)
      })
      .catch(error => {
        continuation.lastQueueLength = 0
        // 连播电台创建失败后放弃该上下文的自动连播（避免每次到队尾都重试失败请求）
        if (appleAutoplayActive) appleAutoplayRef.current = { seedKey: appleAutoplayRef.current.seedKey, stationId: undefined, disabled: true }
        window.setTimeout(() => setContinuationRetry(value => value + 1), 1200)
        console.warn(`[${appleAutoplayActive ? 'Apple自动连播' : continuationPlatform === 'qq' ? 'QQ猜你喜欢' : '网易云无限推荐'}] 下一批加载失败:`, error)
      })
      .finally(() => {
        continuation.loading = false
      })
  }, [currentIndex, playlist.length, playMode, continuationRetry, bumpQueueRevision, preloadUpcomingSongs, appleAutoplayEnabled, currentSong?.platform, currentSong?.appleRadio])

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
      // 音质与供源平台绑定：Apple 曲目预载走载体平台（身份仍是 Apple）；其它平台按 override 分流
      const carrierSong: Song = platform === 'apple' && playable !== song
        ? { ...song, audioSourceOverride: { platform: (playable.platform || 'netease') as MusicPlatform, id: String(playable.platform === 'qq' ? (playable.mid || playable.id) : playable.id) } }
        : song
      const override = carrierSong.audioSourceOverride
      const resolvedPlatform = override?.platform || (playable.platform || 'netease')
      const cached = preloadCacheRef.current.get(trackKey)
      const cachedUrlIsFresh = Boolean(
        cached?.url
        && Date.now() - (cached.urlTimestamp ?? cached.timestamp) < 5 * 60 * 1000
      )
      const songId = override
        ? override.id
        : (resolvedPlatform === 'qq' || resolvedPlatform === 'soda' || resolvedPlatform === 'kugou') ? (playable.mid || playable.id) : playable.id
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
        playbackCoverColor,
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


  /**
   * 视觉轨道切换（进度 90% 的 visualSwitchCommit）：
   * 只更新"画面归属"——歌名/歌手/封面/歌词/配色/MV 改读 visualTrack；canonical 的
   * currentTrack / currentIndex / 播放时钟 / 队列 revision / 歌词归属全部不动。
   * 同时退休过渡叠加层：叠加层的交叉淡化以 90%（= 本切换点）为终点（见 overlayProgress），
   * 此刻它显示的就是目标曲，撤掉叠加层后由 canonical 展示无缝接替。
   */
  const applyVisualSwitch = useCallback((commit: TransitionCommit) => {
    if (!commit.isVisualSwitch) return
    if (commit.sourceTrackKey && activeTrackKeyRef.current && commit.sourceTrackKey !== activeTrackKeyRef.current) return
    const preparedIndex = commit.targetIndex
    const preparedSong = preparedIndex !== undefined ? playlist[preparedIndex] : undefined
    const targetIndex = preparedSong && getSongKey(preparedSong) === commit.targetTrackKey
      ? preparedIndex!
      : playlist.findIndex(song => getSongKey(song) === commit.targetTrackKey)
    const song = targetIndex >= 0 ? playlist[targetIndex] : undefined
    if (!song) return
    const normalizedSong = normalizeSongCover(normalizeRawSongShape(song))
    const cacheKey = getSongKey(normalizedSong)
    const cachedLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics
    const next: NonNullable<typeof visualTrack> = {
      trackKey: cacheKey,
      index: targetIndex,
      coverUrl: normalizedSong.album?.picUrl || '',
      title: normalizedSong.name,
      artist: normalizedSong.artists.map(artist => artist.name).join(', '),
      albumName: normalizedSong.album?.name,
      songId: normalizedSong.id ?? normalizedSong.mid,
      lyrics: cachedLyrics && cachedLyrics.length > 0 ? cachedLyrics : lyrics,
    }
    visualTrackRef.current = next
    setVisualTrack(next)
    // 有词 ↔ 纯音乐 的版面归属也要跟着视觉轨道走：以前 isPureMusic 只在**音频提交帧**更新，
    // 于是"过渡播完那一刻版面才抽到居中/双栏"（用户实测最难看的一处）。
    // 这里与画面同帧更新，配合播放页的 layout 动画，封面是滑过去的。
    if (cachedLyrics) setIsPureMusic(detectPureMusic(cachedLyrics))
    // 封面也必须跟着切：各播放页优先用 App 的 appleCoverUrl（旧曲高清封面）而不是 coverUrl，
    // 不清掉就会出现"歌名/歌词/背景已是下一首、封面还是上一首"的半套切换（用户实测串台）。
    setAppleCoverUrl(null)
    resolveAppleCover(normalizedSong)
    // 目标曲配色已在 armed 阶段取过（transitionToTrack 取色 effect）：登记为"最近 ready 色"，
    // 这样切轨后 canonical 封面开始取色（loading）时不会闪回源曲颜色，提交帧也保持目标色。
    if (transitionToAccentColor && transitionToAccentColor !== lastReadyCoverColorRef.current?.color) {
      lastReadyCoverColorRef.current = { color: transitionToAccentColor, palette: lastReadyCoverColorRef.current?.palette ?? [] }
    }
    setIsTransitioning(false)
    setTransitionProgress(0)
    setTransitionFromTrack(null)
    setTransitionToTrack(null)
    setTransitionFromAccentColor(null)
    void window.electron?.automixLog?.('VisualTrack', `switch → ${cacheKey} @${Number(commit.targetTime || 0).toFixed(2)}s（叠加层退休，画面交给 canonical）`)?.catch?.(() => undefined)
    debugLog('🎨 [VisualTrack] 画面已切到目标曲:', cacheKey)
  }, [playlist, transitionToAccentColor, lyrics, getSongKey])

  // PlaybackEngine atomic commit: update React/UI only; never reload the deck already producing audio.
  const commitPreparedSong = useCallback((commit: TransitionCommit) => {
    if (commit.sourceTrackKey && activeTrackKeyRef.current && commit.sourceTrackKey !== activeTrackKeyRef.current) return
    // 视觉预切换走独立通道（applyVisualSwitch）：这里只处理真正的歌曲切换。
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
    if (!song) {
      // P2-17 兜底：目标曲在过渡途中被移出队列（只有桌面队列删除/移动/智能重排三条路径会先
      // cancelTransition），而音频 deck 已经切到目标曲——裸 return 会让 UI（currentIndex/currentTrack/
      // 歌词/时钟）永久停在与音频不一致的状态。
      // 取舍：不尝试按旧 targetTrackKey 修复（该曲已不在队列里），改为提示 + 让播放层按最新队列
      // 重新解析下一首（handleNext → 完整 loadAndPlay），由它一次性把 UI 与音频重新对齐。
      console.warn('[TransitionCommit] 目标曲已不在队列中，重新同步播放状态:', commit.targetTrackKey)
      addToast('队列已变化，正在重新同步播放状态', 'info')
      handleNextRef.current()
      return
    }
    const nextRevision = bumpQueueRevision()

    const normalizedSong = normalizeSongCover(normalizeRawSongShape(song))
    const cacheKey = getSongKey(normalizedSong)
    
    activeTrackKeyRef.current = cacheKey
    currentIndexRef.current = targetIndex
    setCurrentIndex(targetIndex)
    setCurrentTrack(createTrackFromSong(normalizedSong))
    void window.electron?.automixLog?.('VisualTrack', `commit → ${cacheKey}（视觉轨道=${visualTrackRef.current?.trackKey || 'none'}，两者一致时画面零变化）`)?.catch?.(() => undefined)
    // 视觉轨道此时与 canonical 指向同一首曲目（90% 已切轨）：在这里清掉视觉轨道，
    // 与 canonical 换歌同批发生 → 画面上没有任何可见变化（这正是"提交帧零跳变"的关键）。
    if (visualTrackRef.current && visualTrackRef.current.trackKey !== cacheKey) {
      console.warn('[VisualTrack] 提交曲目与视觉轨道不一致，回退到 canonical:', visualTrackRef.current.trackKey, '→', cacheKey)
    }
    visualTrackRef.current = null
    setVisualTrack(null)
    // Apple Music：切歌即清封面，后台匹配命中后替换为高清封面（与 loadAndPlaySong 一致——
    // 漏清会导致 appleCoverUrl 残留旧歌封面，自动切歌后 displayCoverUrl 恒为旧图）
    setAppleCoverUrl(null)
    resolveAppleCover(normalizedSong)
    commitCurrentTime(commit.targetTime)
    setDuration(normalizedSong.duration / 1000)
    setCurrentTranslation('')

    const cached = preloadCacheRef.current.get(cacheKey)
    if (cached && cached.lyrics.length > 0) {
      setLyrics(cached.lyrics)
      setIsPureMusic(detectPureMusic(cached.lyrics))
    } else {
      // 无预载歌词：保留旧歌词直到 ensureSongLyrics 拉到新词再整体替换。
      // 此前这里 setLyrics([]) 会把歌词区清空——提交瞬间界面"闪一下/像刷新"的直接来源。
      setIsPureMusic(detectPureMusic(cached?.lyrics))
    }
    void ensureSongLyrics(normalizedSong, cacheKey)

    window.setTimeout(() => {
      if (appleAcceptanceActiveRef.current) return
      preloadUpcomingSongs(targetIndex, nextRevision)
    }, 0)
  }, [bumpQueueRevision, playlist, preloadUpcomingSongs, ensureSongLyrics, resolveAppleCover, addToast])

  useEffect(() => {
    // 提交分发：视觉预切换（isVisualSwitch）走纯展示的 applyVisualSwitch，
    // 真正的歌曲切换才走 commitPreparedSong（canonical 状态）。
    const dispatcher = (commit: TransitionCommit) => {
      if (commit.isVisualSwitch) {
        applyVisualSwitch(commit)
        return
      }
      commitPreparedSong(commit)
    }
    transitionCommitRef.current = dispatcher
    return () => {
      if (transitionCommitRef.current === dispatcher) transitionCommitRef.current = () => undefined
    }
  }, [applyVisualSwitch, commitPreparedSong])
  // 加载并播放歌曲
  const loadAndPlaySong = async (song: Song, songIndex?: number, playlistOverride?: Song[]) => {
    // App 的渲染树巨大，播放页挂载/切歌 = 整树重建（"进入播放页瞬间卡一下"的根因）。
    // React 19 异步 transition：让整个加载流程内（含 await 之后的各 setState）以低优先级、
    // 可分片的方式渲染，点击/切歌这一帧不再被巨型 commit 阻塞；音频引擎独立于 React
    // 调度，无时序影响，快速连切时也只合并提交最新一首。
    return new Promise<void>(resolve => {
      startTransition(async () => {
        try {
          const loadRevision = songLoadRevisionRef.current + 1
          songLoadRevisionRef.current = loadRevision
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
      if (song.appleRadio) {
        commitCurrentTime(0)
        setDuration(0)
      }
      // 上一首若是 WebView2 播放面播放，先退出外部源模式（内部会停掉播放面声音）
      audioPlayer.disableExternalPlayback()
      setExternalPlaybackActive(false)

      let normalizedSong = normalizeSongCover(song)
      // Apple Music 播放路由（官方支持方向）：
      // ① ECS Browser CDM (L3) + CENC/HLS 原生播放；② WebView2 兼容兜底；③ 网易云/QQ 载体。
      // castLabs 已确认 Windows MF CDM 是已废弃实验路径，默认 Browser CDM L3 才是生产方向。
      let useWebView2 = false
      const tryWebView2Fallback = async (): Promise<boolean> => {
        if (normalizedSong.platform !== 'apple' || !normalizedSong.appleId) return false
        if (!isLatestLoad() || !(await ensureBridgeRunning()) || !isLatestLoad()) {
          ;(window as any).electron?.log?.('[PlaySong] WebView2 fallback: bridge 不可用或请求已过期')
          return false
        }
        let authorized = getBridgeState().authorized
        for (let i = 0; i < 40 && !authorized && isLatestLoad(); i++) {
          await new Promise(r => setTimeout(r, 300))
          if (!isLatestLoad()) return false
          await checkBridgeRunning()
          authorized = getBridgeState().authorized
        }
        if (!isLatestLoad()) return false
        if (!authorized) {
          ;(window as any).electron?.log?.('[PlaySong] WebView2 fallback: 播放面未授权（等待超时）')
          if (!appleBridgeAuthHintShownRef.current) {
            appleBridgeAuthHintShownRef.current = true
            addToast('Apple 兼容播放需一次授权：设置 → Apple Music 播放面 → 打开窗口登录', 'info')
          }
          return false
        }
        const ok = await bridgePlay(String(normalizedSong.appleId))
        ;(window as any).electron?.log?.(`[PlaySong] WebView2 fallback bridgePlay(${normalizedSong.appleId}) → ${ok}`)
        return ok
      }

      // Apple Music 原生音源：webPlayback + CENC HLS + ECS Browser CDM (L3)。
      let appleHlsStream: AppleNativeStream | null = null
      const radioDescriptor = normalizedSong.appleRadio
      if (radioDescriptor) {
        setAppleRadioStatus('connecting')
        setAppleRadioError('')
        let radioPlayParams = radioDescriptor.playParams
        // 补取电台详情的条件：playParams 缺失，**或**缺 stationHash。
        // 官方 play/assets 请求实测总是携带 stationHash
        // （format=stream&hasDrm=true&id=ra.xxx&kind=radioStation&mediaType=0&stationHash=…&streamingKind=1&keyFormat=web）。
        // 列表接口给的 playParams 常常只有 id/kind、没有 stationHash；若只按「playParams 是否为空」
        // 决定要不要补取，就会带着不完整的参数去请求 → Apple 返回 404（而后被泛化成"地区限制"文案）。
        const playParamsIncomplete = !radioPlayParams
          || Object.keys(radioPlayParams).length === 0
          || !radioPlayParams.stationHash
        if (playParamsIncomplete) {
          const stationDetail = await fetchAppleStationDetail(
            radioDescriptor.stationId,
            radioDescriptor.storefront || normalizedSong.appleStorefront,
          ).catch(() => null)
          if (!isLatestLoad()) return
          if (stationDetail?.playParams) {
            // 合并而非替换：列表侧已有的键（如列表特有的 seed）不能被详情响应抹掉
            radioPlayParams = { ...(radioPlayParams || {}), ...stationDetail.playParams }
            radioDescriptor.playParams = radioPlayParams
          }
          if (!radioDescriptor.stationHash && stationDetail?.stationHash) {
            radioDescriptor.stationHash = stationDetail.stationHash
          }
          ;(window as any).electron?.log?.(`[AppleRadio] station detail resolved: hasPlayParams=${Boolean(radioPlayParams)} hasStationHash=${Boolean(radioDescriptor.stationHash)}`)
        }
        appleHlsStream = await resolveAppleRadioStream(
          radioDescriptor.stationId,
          radioPlayParams
            ? { ...radioPlayParams, ...(radioDescriptor.stationHash ? { stationHash: radioDescriptor.stationHash } : {}) }
            : radioDescriptor.stationHash ? { stationHash: radioDescriptor.stationHash } : undefined,
        ).catch(error => {
          setAppleRadioError(error instanceof Error ? error.message : 'Apple Music 电台取流失败')
          return null
        })
        if (!isLatestLoad()) return
        if (!appleHlsStream) {
          // 曲目型电台（playParams.format==='tracks'，如「风格电台」里的「K-Pop 电台」）：
          // 它本来就没有直播流（play/assets 实测恒 404），曲目来自
          // POST /v1/me/stations/next-tracks/{id}。这里取一批曲目当作队列播第一首，
          // 后续由既有的 Apple 自动连播（next-tracks 游标）继续补曲。
          if (isAppleTrackRadioStation(radioPlayParams) || /曲目型电台/.test(getAppleRadioFailReason())) {
            // 传电台名：队列曲目会把它写进 album.name，迷你播放器/桌面歌词在无歌词时显示它
            // （此前不传，界面上退化成「暂无歌词」，用户实测反馈"播放电台应该用电台名"）
            const radioSongs = await fetchAppleAutoplayTracks(
              radioDescriptor.stationId,
              10,
              normalizedSong.name || normalizedSong.album?.name || '',
            ).catch(() => [])
            if (!isLatestLoad()) return
            if (radioSongs.length > 0) {
              debugLog(`📻 [PlaySong] 曲目型电台：取到 ${radioSongs.length} 首，按队列播放`)
              // 队列里是普通目录歌曲（不再带 appleRadio），播放页按普通歌曲渲染；
              // 但仍要把电台状态收干净，否则会停在 'connecting' 留下一直转圈的假象。
              appleRadioReconnectKeyRef.current = ''
              setAppleRadioError('')
              setAppleRadioStatus('playing')
              const first = radioSongs[0]
              const queue = radioSongs
              setPlaylist(queue)
              setCurrentIndex(0)
              await loadAndPlaySong(first, 0, queue)
              return
            }
          }
          // 电台不启用 WebView2 二次登录：原生 HLS/EME 失败时直接报告真实原因，
          // 不把用户带到另一个需要重新登录的播放窗口。
          setAppleRadioError(getAppleRadioFailReason())
          setAppleRadioStatus('error')
          setCurrentTrack(createTrackFromSong(normalizedSong))
          return
        }
        radioDescriptor.timeline = appleHlsStream.live === true ? 'live' : appleHlsStream.live === false ? 'vod' : radioDescriptor.timeline
        appleRadioAcceptanceRef.current.streamResolved = true
        debugLog(`📻 [PlaySong] Apple 电台流就绪 timeline=${radioDescriptor.timeline}`)
      } else if (normalizedSong.platform === 'apple' && isAppleNativeStreamEnabled()) {
        let streamId = String(normalizedSong.appleId || normalizedSong.id || '')
        if (streamId && APPLE_LIBRARY_ID_PATTERN.test(streamId)) {
          const catalogId = await resolveAppleLibraryCatalogId(streamId).catch(() => null)
          if (catalogId) streamId = catalogId
        }
        const emeCapable = await isAppleEmeCapable()
        if (streamId && streamId !== '0' && emeCapable) {
          appleHlsStream = await resolveAppleNativeStream(streamId)
          if (!isLatestLoad()) {
            releaseAppleNativeStream(appleHlsStream)
            return
          }
          if (!appleHlsStream) useWebView2 = await tryWebView2Fallback()
        } else if (!emeCapable) {
          debugLog('🍎 [PlaySong] ECS Browser CDM 不可用，尝试 WebView2 兼容播放')
          useWebView2 = await tryWebView2Fallback()
        } else if (!streamId || streamId === '0') {
          console.warn(`🍎 [PlaySong] Apple 歌曲缺少有效曲目 id：《${normalizedSong.name}》`)
          useWebView2 = await tryWebView2Fallback()
        }
      }
      if (appleHlsStream && !useWebView2) {
        // 已命中 Electron 原生 CENC；兼容 bridge 不再参与本曲播放，立即释放其进程与轮询。
        void bridgeStop().catch(() => undefined)
        void window.electron?.stopAppleBridge?.()
      }
      // 需要跨平台载体转换的平台：apple（原生取流失败时）/spotify（无自源音源，始终）。
      // kugou/soda 先试原生播放（汽水走逆向 Web API，免费/试听流可播），
      // 付费/失败时在 URL 为空分支再匹配网易云/QQ 同款。
      const needsCarrier = !appleHlsStream && !useWebView2 && (normalizedSong.platform === 'apple'
        || normalizedSong.platform === 'spotify')
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
        // 身份不换：apple/spotify 曲目借网易云/QQ 载体出声，但歌曲仍是原平台身份
        // （platform/歌词/艺人/专辑/收藏不动）；audioSourceOverride 告诉取流层用载体。
        audioSong = {
          ...normalizedSong,
          audioSourceOverride: { platform: resolved.platform || 'netease', id: String(resolved.platform === 'qq' ? (resolved.mid || resolved.id) : resolved.id) },
        }
      }
      if ((normalizedSong.platform || 'netease') === 'qq' && !normalizedSong.album?.picUrl) {
        normalizedSong = await loadQQSongDetail(normalizedSong)
        if (!isLatestLoad()) return
        setPlaylist(prev => prev.map(item => getSongKey(item) === getSongKey(normalizedSong) ? normalizedSong : item))
      }
      // 清空当前翻译（切歌时）
      setCurrentTranslation('')
      
      const platform = audioSong.platform || 'netease'
      const songId = (platform === 'qq' || platform === 'soda' || platform === 'kugou') ? (audioSong.mid || audioSong.id) : audioSong.id
      const hasValidSongId = radioDescriptor || appleHlsStream
        ? true
        : platform === 'netease'
          ? Number.isFinite(Number(songId)) && Number(songId) > 0
          : Boolean(String(songId || '').trim())
      if (!hasValidSongId) {
        addToast('歌曲信息不完整，暂时无法播放，请重新加载该列表', 'error')
        console.warn(`[PlaySong] ${platform} song is missing a playable identifier`)
        return
      }
      debugLog(`  歌手: ${normalizedSong.artists.map(a => a.name).join(', ')}`)
      if (platform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie')
        debugLog(`  Cookie状态: ${cookie ? '有效(长度:' + cookie.length + ')' : '无效'}`)
      }
      const coverUrl = normalizedSong.album?.picUrl || ''
      setCurrentTrack(createTrackFromSong(normalizedSong))
      commitCurrentTime(0)
      // Apple Music：切歌即清封面，后台匹配命中后替换为高清封面
      setAppleCoverUrl(null)
      if (!radioDescriptor) resolveAppleCover(normalizedSong)
      
      // 如果有艺人ID，获取艺人详情
      const cacheKey = getSongKey(normalizedSong)
      activeTrackKeyRef.current = cacheKey
      const cached = radioDescriptor ? undefined : preloadCacheRef.current.get(cacheKey)
      const now = Date.now()
      const lyricsPromise = radioDescriptor ? Promise.resolve([] as LyricLine[]) : ensureSongLyrics(normalizedSong, cacheKey)
      
      let url: string | null = null
      let songLyrics: LyricLine[] = cached?.lyrics || []
      // 汽水本次加载的结构化不可播信息（requiredTier/vipLabel/reason）：可播或其他平台时为 null
      let sodaUnavailableInfo: { requiredTier?: 'free' | 'vip' | 'svip'; vipLabel?: string; reason?: string } | null = null

      // 音频 URL 与歌词分别判断时效，歌词请求不再等播放器完成加载后才开始。
      if (useWebView2) {
        // WebView2 播放面模式：音源在 WebView2 内解密播放，无需本地 URL；
        // 预载缓存里的载体 URL 不可用（会造成播放面 + 本地 deck 双重出声）
      } else if (appleHlsStream) {
        // Apple 原生 HLS：清单签名有时效且不走 getSongUrl，不写 URL 缓存，
        // 切歌/重播时重新取流（webPlayback 本身很快）
        url = appleHlsStream.url
        debugLog('🍎 [PlaySong] Apple 原生 HLS 音源就绪: ' + url.slice(0, 96))
      } else if (cached?.url && (now - (cached.urlTimestamp ?? cached.timestamp)) < 5 * 60 * 1000) {
        url = cached.url
        debugLog('🎵 歌词: 缓存命中 (' + songLyrics.length + '行)')
      } else {
        if (platform === 'soda') {
          // 汽水：改调结构化播放详情（替代裸 getSongUrl 直取 URL），不可播时带上
          // requiredTier/vipLabel/reason 供换源提示文案；请求口径与 getSongUrl 汽水分支一致
          // （传 audioSong 让补源覆盖生效：汽水歌借 QQ/网易音频时按供源平台发请求）
          const playbackInfo = await getSodaPlaybackInfo(songId, audioSong)
          url = playbackInfo.url
          if (!url) {
            sodaUnavailableInfo = {
              requiredTier: playbackInfo.requiredTier,
              vipLabel: playbackInfo.vipLabel,
              reason: playbackInfo.reason,
            }
          }
        } else {
          url = await getSongUrl(songId, platform, 2, audioSong)
        }
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
      
      
      // 检测歌曲下架
      if (!useWebView2 && url === 'SONG_UNAVAILABLE') {
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

      // 汽水：原生音源解析成功后上报播放（回传个性化推荐数据；失败静默）。
      // 走缓存 URL 或降级到网易云/QQ 载体时不重复上报。
      if (platform === 'soda' && url) {
        void import('./services/sodaService')
          .then(m => m.reportSodaPlay(String(normalizedSong.mid || normalizedSong.id)))
          .catch(() => undefined)
      }
      // 酷狗：原生音源解析成功后上报「最近播放」（mxid=Song.kugouMixSongId，缺失时服务端按 hash 反查）。
      // 上报失败静默；降级到其它平台载体时此分支不会命中（url 为空先走补源）。
      if (platform === 'kugou' && url) {
        void import('./services/kugouService')
          .then(m => m.uploadKugouPlayRecord(normalizedSong))
          .catch(() => undefined)
      }
      
      if (!url && !useWebView2) {
        // 跨平台可用性增强（设置开关「平台可用性增强」）：原生播放失败（付费/版权/未登录）→ 尝试同名匹配播放。
        // 此前酷狗/汽水无论开关如何都会匹配、QQ 完全不匹配，与设置文案不符；现在统一受开关控制。
        const fallbackEnabled = parseStoredBoolean(localStorage.getItem('crossPlatformFallbackEnabled'), false)
        const fallbackPlatforms = ['kugou', 'soda', 'qq']
        if (fallbackEnabled && fallbackPlatforms.includes(normalizedSong.platform || 'netease')) {
          // 汽水源不可播：先弹一次性可感知提示（标注「汽水·」前缀，避免用户误以为播的是网易云版本），
          // 再走既有同名匹配兜底；netease/qq 兜底流程本身不变
          if (normalizedSong.platform === 'soda') {
            addToast(buildSodaSourceSwitchToast(normalizedSong, sodaUnavailableInfo), 'error')
          }
          const sourceSong = normalizedSong
          // 后端控制台留痕用：说清「原平台为什么播不了」，否则日志里只有一个「补源失败」看不出所以然。
          // 会员档位判定与 buildSodaSourceSwitchToast 保持同一口径——'free' 不是「需要会员」，
          // 不能拼成「汽水需 FREE」这种废话。
          const fillTier: 'SVIP' | 'VIP' | '' =
            sodaUnavailableInfo?.requiredTier === 'svip'
              ? 'SVIP'
              : sodaUnavailableInfo?.requiredTier === 'vip'
                ? 'VIP'
                : /svip/i.test(String(sodaUnavailableInfo?.vipLabel || ''))
                  ? 'SVIP'
                  : /^vip/i.test(String(sodaUnavailableInfo?.vipLabel || ''))
                    ? 'VIP'
                    : ''
          const fillReason = normalizedSong.platform === 'soda'
            ? (fillTier
              ? `汽水需 ${fillTier}`
              : SODA_UNAVAILABLE_REASON_TEXT[String(sodaUnavailableInfo?.reason || '')] || '汽水音源暂时无法解析')
            : normalizedSong.platform === 'kugou'
              ? '酷狗付费/版权受限'
              : 'QQ 音乐付费/版权受限'
          const fillTrackInfo = {
            title: String(normalizedSong.name || ''),
            artist: normalizedSong.artists?.map(a => a.name).filter(Boolean).join(' / ') || '',
            reason: fillReason,
          }
          const resolved = await resolvePlayableSong(normalizedSong)
          if (resolved && resolved.platform !== normalizedSong.platform) {
            const carrierUrl = await getSongUrl(resolved.platform === 'qq' ? (resolved.mid || resolved.id) : resolved.id, resolved.platform)
            if (carrierUrl && carrierUrl !== 'SONG_UNAVAILABLE') {
              // 登记补源：歌单行尾显示「补」，让用户知道播的不是原平台音源；
              // 同时把「从哪个平台补的」打到后端控制台（【平台可用性增强】）
              void import('./services/crossFillRegistry')
                .then(m => {
                  m.recordCrossFill(sourceSong, resolved.platform as MusicPlatform, String(resolved.mid || resolved.id || ''))
                  m.reportCrossPlatformFill({
                    from: (sourceSong.platform || 'netease') as MusicPlatform,
                    to: resolved.platform as MusicPlatform,
                    ...fillTrackInfo,
                    success: true,
                  })
                })
                .catch(() => undefined)
              // 身份不换（用户口径）：歌曲仍是原平台身份——歌词/艺人/专辑/加歌单全跟进入平台，
              // 只借载体平台的音频。载体平台+id 走 audioSourceOverride 传递（取流按供源平台发），
              // 并登记进 crossFillRegistry（音质菜单跨会话也能对上供源平台）。
              normalizedSong = {
                ...normalizedSong,
                audioSourceOverride: { platform: resolved.platform as MusicPlatform, id: String(resolved.mid || resolved.id || '') },
              }
              url = carrierUrl
            }
          }
          if (!url) {
            void import('./services/crossFillRegistry')
              .then(m => m.reportCrossPlatformFill({
                from: (sourceSong.platform || 'netease') as MusicPlatform,
                ...fillTrackInfo,
                success: false,
              }))
              .catch(() => undefined)
            addToast(
              normalizedSong.platform === 'kugou'
                ? '该歌曲为酷狗付费/版权受限曲目，且未找到可播放版本'
                : normalizedSong.platform === 'soda'
                  ? '该歌曲为汽水 VIP/版权受限曲目，且未找到可播放版本'
                  : '该歌曲为 QQ 音乐付费/版权受限曲目，且未找到可播放版本',
              'error',
            )
            return
          }
        } else if (normalizedSong.platform === 'kugou' || normalizedSong.platform === 'soda') {
          // 开关关闭：如实提示并给出开启入口，不再静默跨平台补源
          addToast(
            normalizedSong.platform === 'kugou'
              ? '该歌曲为酷狗付费/版权受限曲目，可在设置中开启「平台可用性增强」尝试跨平台补源'
              : '该歌曲为汽水 VIP/版权受限曲目，可在设置中开启「平台可用性增强」尝试跨平台补源',
            'error',
          )
          return
        } else {
          console.error('获取歌曲URL返回空')
          console.error('  可能原因:')
          console.error('  1. VIP歌曲且未登录VIP账号')
          console.error('  2. 版权限制')
          console.error('  3. Cookie过期或无效')
          console.error('  4. API返回错误格式')
          addToast('无法播放该歌曲，可能是VIP歌曲或版权限制', 'error')
          return
        }
      }
      
      // 处理封面图片URL，支持网易云音乐的URL参数
      setCurrentTrack(createTrackFromSong(normalizedSong, url ?? undefined))
      
      // 如果是当前播放的歌曲，确保歌词已加载且不为空
      songLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics || songLyrics
      if (songLyrics.length > 0) {
        setLyrics(songLyrics)
      } else {
        setLyrics([]) // 先清空歌词
      }
      setIsPureMusic(detectPureMusic(songLyrics))
      
      let started = false
      if (useWebView2) {
        // === WebView2 播放面模式 ===
        // 音频在 WebView2 兼容播放窗口中解密播放，本地 deck 保持空载；
        // 播放器进入外部源模式：bridge 状态经 emit 管线驱动全部 UI（进度/歌词/播控），
        // 播完经 ended 语义走上层切歌/单曲循环，播控命令在 hook 内分流到 bridge。
        started = true
        // Song.duration 单位为毫秒（与 loadAndPlay 的 duration 传参一致，需 /1000 转秒）
        audioPlayer.enableExternalPlayback({ duration: Number(normalizedSong.duration) / 1000 || 0 })
        setExternalPlaybackActive(true)
      } else {
        try {
        // 此分支 !useWebView2：上方 url 为空分支已 return，url 必为有效载体/HLS 地址
        const deckUrl = appleHlsStream ? url! : getProxiedAudioUrl(url!)
        started = await audioPlayer.loadAndPlay(deckUrl, volume, buildDeckMetadata(normalizedSong, deckUrl, songIndex, {
          trackKey: cacheKey,
          duration: normalizedSong.duration / 1000,
          albumId: getLocalAlbumIdentifier(normalizedSong, platform) || undefined,
          albumCover: normalizedSong.album?.picUrl || undefined,
          appleHls: appleHlsStream || undefined,
        }))
        // 看歌模式下引擎静默：视频接管音频，加载后立即暂停避免双重奏
        if (started && lyricDisplayModeRef.current === 'video') {
          const engineEl = audioPlayerRef.current?.getAudioElement?.()
          if (engineEl) { engineEl.volume = 0; engineEl.pause() }
          watchPausedEngineRef.current = true
        }
      } catch (firstPlaybackError) {
        if (!isLatestLoad()) return
        // Apple 原生 HLS 播放失败（license/清单/网络等）：不跑 getSongUrl 重试
        // （apple id 不是网易云/QQ id，重试必然空转），也不触发外层 alert，
        // 给可感知提示即可，用户可重试或切下一首（切歌会重新走完整取流流程）
        if (appleHlsStream) {
          console.warn('[PlaySong] Apple 原生 HLS 播放失败:', firstPlaybackError)
          // 电台直播：给出可感知提示（无同款歌曲可回退）
          if ((normalizedSong as { appleRadio?: unknown }).appleRadio) {
            const message = firstPlaybackError instanceof Error ? firstPlaybackError.message : '网络或授权问题'
            setAppleRadioError(message)
            setAppleRadioStatus('error')
            addToast('电台直播播放失败（网络或授权问题），请重试', 'error')
            return
          }
          // 静默处理：不外弹提示（用户偏好），仅转发主进程控制台便于排查
          try {
            ;(window as any).electron?.log?.(`[ApplePlayback] HLS 播放失败: ${firstPlaybackError instanceof Error ? firstPlaybackError.message : String(firstPlaybackError)}`)
          } catch { /* 忽略 */ }
          // Electron L3/CENC 失败后优先切到 WebView2 兼容播放；只有 bridge 也失败才加载体。
          useWebView2 = await tryWebView2Fallback()
          if (useWebView2 && isLatestLoad()) {
            appleHlsStream = null
            started = true
            audioPlayer.enableExternalPlayback({ duration: Number(normalizedSong.duration) / 1000 || 0 })
            setExternalPlaybackActive(true)
            setCurrentTrack(createTrackFromSong(normalizedSong))
            return
          }

          // WebView2 也不可用时回退网易云/QQ 载体（避免把用户晾在 0:00）。
              const resolved = await resolvePlayableSong(normalizedSong)
              if (resolved && isLatestLoad()) {
                const carrierId = resolved.platform === 'qq' ? (resolved.mid || resolved.id) : resolved.id
                const carrierUrl = await getSongUrl(carrierId, resolved.platform || 'netease')
                if (carrierUrl && carrierUrl !== 'SONG_UNAVAILABLE' && isLatestLoad()) {
                  // 身份不换：HLS 失败回落载体时同样保留原平台身份（Apple 仍是 Apple），
                  // 只借载体音频；详情/收藏/歌单操作继续按 Apple 平台走。
                  normalizedSong = {
                    ...normalizedSong,
                    audioSourceOverride: { platform: resolved.platform || 'netease', id: String(carrierId || '') },
                  }
                  url = carrierUrl
                  setCurrentTrack(createTrackFromSong(normalizedSong, url))
              songLyrics = preloadCacheRef.current.get(cacheKey)?.lyrics || songLyrics
              const carrierDeckUrl = getProxiedAudioUrl(url)
              started = await audioPlayer.loadAndPlay(carrierDeckUrl, volume, buildDeckMetadata(normalizedSong, carrierDeckUrl, songIndex, {
                trackKey: cacheKey,
                duration: normalizedSong.duration / 1000,
                albumId: getLocalAlbumIdentifier(normalizedSong, resolved.platform || 'netease') || undefined,
                albumCover: normalizedSong.album?.picUrl || undefined,
              }))
              if (started && lyricDisplayModeRef.current === 'video') {
                const engineEl = audioPlayerRef.current?.getAudioElement?.()
                if (engineEl) { engineEl.volume = 0; engineEl.pause() }
                watchPausedEngineRef.current = true
              }
            }
          }
          return
        }
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
        // 即使签名 URL 与失败 URL 相同也再试一次：瞬时 CDN 解码失败不代表 URL 无效
        if (!refreshedUrl || !isLatestLoad()) throw firstPlaybackError
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
        const retryDeckUrl = getProxiedAudioUrl(url)
        started = await audioPlayer.loadAndPlay(retryDeckUrl, volume, buildDeckMetadata(normalizedSong, retryDeckUrl, songIndex, {
          trackKey: cacheKey,
          duration: normalizedSong.duration / 1000,
          albumId: getLocalAlbumIdentifier(normalizedSong, platform) || undefined,
          albumCover: normalizedSong.album?.picUrl || undefined,
          appleHls: appleHlsStream || undefined,
        }))
        if (started && lyricDisplayModeRef.current === 'video') {
          const engineEl = audioPlayerRef.current?.getAudioElement?.()
          if (engineEl) { engineEl.volume = 0; engineEl.pause() }
          watchPausedEngineRef.current = true
        }
      } // ← closes catch
      } // ← closes else
      if (!started || !isLatestLoad()) {
        if (radioDescriptor && isLatestLoad()) {
          releaseAppleNativeStream(appleHlsStream)
          setAppleRadioStatus('error')
          setAppleRadioError('Apple Music 电台未能启动播放，请重新连接')
        }
        return
      }
      
      // 响度归一化：按曲目测量 LUFS 并施加增益（adapter 内部按 capabilities 判断，v1/v3 no-op）
      // WebView2 播放面模式无本地音频链路，跳过
      if (!radioDescriptor && !useWebView2) engineAdapterRef.current.applyLoudnessNormalization(cacheKey, url!)
      
      // 请求可能已经由下一首预载启动；这里仅保持引用，避免重复调用。
      void lyricsPromise
      
      if (radioDescriptor) {
        appleRadioReconnectKeyRef.current = ''
        setAppleRadioStatus('playing')
      }

      // 用于控制逐字歌词的显示，预留2秒缓冲
      if (!radioDescriptor && actualPlaylist.length > 1) {
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
        } finally {
          resolve() // 无论是成功、提前 return 还是报错，都确保调用方 await 能继续
        }
      })
    })
  }

  // 上一曲
  const handlePrevious = () => {
    if (playlist.length === 0 || currentSong?.appleRadio) return
    // 共振房间里没有「上一曲」语义（队列由房主向前推进）：与媒体键/遥控器的处理保持一致。
    // 房间里本机列表被压成单曲，走本机逻辑只会在那一首上回绕。
    if (isResonanceHost()) return
    audioPlayer.cancelTransition('manual previous', false)
    audioPlayer.resetGaplessIntegration() // 清理预加载的音频
    bumpQueueRevision()
    
    // 如果当前有歌曲正在播放且播放列表不为空
    const newIndex = currentIndexRef.current > 0 ? currentIndexRef.current - 1 : playlist.length - 1
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
    commitCurrentTime(0)
    setLyrics([])
    setIsPureMusic(false) // 重置纯音乐状态?
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex], newIndex)
  }

  // 下一曲
  const handleNext = () => {
    if (playlist.length === 0 || currentSong?.appleRadio) return
    // 房间里点「下一首」必须推进房间队列：媒体键与遥控器已走 hostNext()，而播放器上的按钮此前
    // 没有这个分支，会走本机逻辑在「被压成单曲」的列表上回绕，还会把全体成员拉回 0:00。
    if (isResonanceHost()) {
      getResonanceSession().hostNext()
      return
    }
    const appleAutoplayHold = appleAutoplayEnabled
      && playMode === 'sequential'
      && playlist.length > 0
      && playlist[0]?.platform === 'apple'
      && !currentSong?.appleRadio
    if (
      (playbackOriginRef.current.continuation === 'explore-infinite' || appleAutoplayHold) &&
      playMode === 'sequential' &&
      currentIndexRef.current >= playlist.length - 1
    ) {
      // 无限推荐/自动连播正在续载时停留在当前曲，避免队尾瞬间回绕到第一首。
      infiniteExploreContinuationRef.current.advancePending = true
      infiniteExploreContinuationRef.current.lastQueueLength = 0
      setContinuationRetry(value => value + 1)
      return
    }
    audioPlayer.cancelTransition('manual or automatic next', false)
    audioPlayer.resetGaplessIntegration() // 清理预加载的音频
    bumpQueueRevision()
    
    const newIndex = deterministicNextIndex ?? (currentIndexRef.current < playlist.length - 1 ? currentIndexRef.current + 1 : 0)
    
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
    commitCurrentTime(0)
    setLyrics([])
    setIsPureMusic(false) // 重置纯音乐状态
    currentIndexRef.current = newIndex
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex], newIndex)
  }
  handleNextRef.current = handleNext
  const handleSongSelectRef = useRef(handleSongSelect)
  handleSongSelectRef.current = handleSongSelect

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('appleAcceptance') !== '1') return

    const waitFor = async (predicate: () => boolean, timeoutMs: number, label: string) => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (predicate()) return
        await new Promise(resolve => window.setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for ${label}`)
    }
    const settingsKeys = [
      'crossfadeEnabled',
      'crossfadeDuration',
      'gaplessEnabled',
      'autoMixEnabled',
      'autoMixEnhanced',
      'autoMixAiMix',
      'playMode',
      'appleNativeStream',
    ] as const
    const backup = Object.fromEntries(settingsKeys.map(key => [key, localStorage.getItem(key)]))
    let restoreEme: () => void = () => undefined

    const configure = async (mode: 'crossfade' | 'gapless' | 'automix' | 'radio') => {
      appleAcceptanceActiveRef.current = true
      localStorage.setItem('appleNativeStream', 'true')
      localStorage.setItem('crossfadeEnabled', String(mode === 'crossfade'))
      localStorage.setItem('crossfadeDuration', '1')
      localStorage.setItem('gaplessEnabled', String(mode === 'gapless'))
      localStorage.setItem('autoMixEnabled', String(mode === 'automix'))
      localStorage.setItem('autoMixEnhanced', String(mode === 'automix'))
      localStorage.setItem('autoMixAiMix', 'false')
      setCrossfadeEnabled(mode === 'crossfade')
      setCrossfadeDuration(1)
      setGaplessEnabled(mode === 'gapless')
      setAutoMixEnabled(mode === 'automix')
      setAutoMixEnhanced(mode === 'automix')
      setAutoMixAiMix(false)
      setPlayMode('sequential')
      window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      window.dispatchEvent(new Event('gaplessSettingsChanged'))
      window.dispatchEvent(new Event('autoMixSettingsChanged'))
      resetAppleAcceptanceSnapshot()
      audioPlayerRef.current.resetAcceptanceState()
      restoreEme = installAppleEmeAcceptanceInstrumentation()
      await new Promise(resolve => window.setTimeout(resolve, 250))
      return { mode, configured: true }
    }

    const loadPair = async () => {
      const auth = getAppleAuthState()
      if (!auth.loggedIn) throw new Error('Apple account is not logged in')
      const library = await getAppleLibrarySongs(50)
      let songs = library.filter(track => Boolean(track.catalogId)).slice(0, 2).map(appleLibraryTrackToSong)
      let source: 'library' | 'catalog' = 'library'
      if (songs.length < 2) {
        const hot = await getAppleHotSongs(auth.storefront, 10)
        songs = hot.slice(0, 2).map(song => appleSongToSong(song, auth.storefront))
        source = 'catalog'
      }
      if (songs.length < 2) throw new Error('Unable to select two Apple catalog tracks')
      await handleSongSelectRef.current(songs[0], songs, { mode: 'minimal', surface: 'search', platform: 'apple' })
      await waitFor(() => {
        const player = audioPlayerRef.current
        const state = player.getAcceptanceState()
        const diagnostics = getAppleAcceptanceSnapshot()
        return state.activeAppleHls && state.standbyAppleHls
          && diagnostics.hlsReady >= 2
          && diagnostics.licenseSuccesses >= 2
      }, 60_000, 'two ready Apple CENC decks')
      return { loggedIn: true, source, selectedTracks: 2 }
    }

    const loadRadio = async () => {
      const auth = getAppleAuthState()
      if (!auth.loggedIn) throw new Error('Apple account is not logged in')
      setAppleRadioStatus('connecting')
      setAppleRadioError('')
      appleRadioAcceptanceRef.current.streamResolved = false
      const page = await fetchAppleRadioPage(auth.storefront)
      const station = page.sections.flatMap(section => section.items).find(item => item.type === 'stations' && Boolean(item.playId || item.id))
      if (!station) throw new Error('Unable to select an Apple radio station')
      await handleSongSelectRef.current(
        appleStationToSong(station, undefined, auth.storefront),
        undefined,
        { mode: 'minimal', surface: 'explore-apple', platform: 'apple', detail: { tab: 'radio' } },
      )
      await waitFor(() => {
        const state = appleRadioAcceptanceRef.current
        return state.status === 'error' || (state.status === 'playing' && state.isPlaying)
      }, 60_000, 'Apple radio playback terminal state')
      const state = appleRadioAcceptanceRef.current
      return {
        loggedIn: true,
        stationSelected: true,
        dedicatedPage: Boolean(state.currentSong?.appleRadio),
        status: state.status,
        playing: state.isPlaying,
        streamResolved: state.streamResolved,
        timeline: state.currentSong?.appleRadio?.timeline || 'unknown',
        errorCategory: state.error
          ? state.error.includes('404') ? 'not-found'
            : state.error.includes('401') || state.error.includes('403') ? 'authorization'
              : state.error.includes('license') || state.error.includes('CENC') ? 'drm'
                : 'playback'
          : '',
      }
    }

    const snapshot = () => ({
      auth: { loggedIn: getAppleAuthState().loggedIn },
      player: audioPlayerRef.current.getAcceptanceState(),
      diagnostics: getAppleAcceptanceSnapshot(),
      heap: typeof performance !== 'undefined' && 'memory' in performance
        ? { usedJSHeapSize: Number((performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize || 0) }
        : null,
    })

    const transition = async () => {
      const player = audioPlayerRef.current
      const strategy = await player.runAcceptanceTransition()
      await waitFor(() => {
        const state = audioPlayerRef.current.getAcceptanceState()
        return state.transitionState === 'playing' && state.activeAppleHls && !state.standbyAppleHls
      }, 10_000, 'Apple transition commit and retired deck cleanup')
      return { strategy, snapshot: snapshot() }
    }

    const cleanup = async (restoreSettings = true) => {
      audioPlayerRef.current.releaseAcceptanceDecks()
      await waitFor(() => {
        const diagnostics = getAppleAcceptanceSnapshot()
        return diagnostics.activeHls === 0 && diagnostics.activeEmeSessions === 0
      }, 10_000, 'Apple HLS and EME session release').catch(() => undefined)
      if (restoreSettings) {
        appleAcceptanceActiveRef.current = false
        restoreEme()
        for (const key of settingsKeys) {
          const value = backup[key]
          if (value === null) localStorage.removeItem(key)
          else localStorage.setItem(key, value)
        }
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
      }
      return snapshot()
    }

    ;(window as any).__waveforgeAppleAcceptance = { configure, loadPair, loadRadio, snapshot, transition, cleanup }
    return () => {
      restoreEme()
      delete (window as any).__waveforgeAppleAcceptance
    }
  }, [])
  
  // 获取下一首歌曲（不播放，仅用于显示）
  const nextSongToShow = useMemo((): Song | undefined => {
    if (deterministicNextIndex === undefined) return undefined
    return playlist[deterministicNextIndex]
  }, [playlist, deterministicNextIndex])
  // modern 等流式播放页的过渡徽标倒计时：与 ModengPlayerPage 同一 playbackTimeStore 订阅
  const automixHudTime = useAutomixHudTime(audioPlayer.playbackTimeStore)
  const foliaPresentation = resolveFoliaPresentation({
    isPlaybackPage,
    lyricMode: lyricDisplayMode,
    upNextEnabled,
    hasNext: Boolean(nextSongToShow),
    playMode,
    showUpNext,
    autoMixRunning: isAutoMixTransition && transitionState === 'running-transition',
    transitionDuration,
  })

  const handlePlayModeChange = (mode?: 'sequential' | 'shuffle' | 'repeat') => {
    const now = Date.now()
    if (now - lastPlayModeChangeRef.current < 300) return
    lastPlayModeChangeRef.current = now

    // 支持两种调用形态（参数互斥）：
    //   1) mode 已传入 → 双按钮 UI（摩登 / 实时控件 / 任何 onPlayModeChange 形如 (m)=>void 的地方）
    //      直接落到指定模式，跳过循环；
    //   2) mode 未传入 → 单按钮 UI（TraditionalView / 旧的 PlayerControls.onPlayModeChange: () => void）
    //      按 sequential → shuffle → repeat 循环到下一个模式。
    //   之前双按钮调进来 mode 被忽略，导致点"单曲循环"按钮实际落到"随机播放"，
    //   再按一次才到"单曲循环"——典型循环错位 bug。2026-09-12 修。
    let newMode: 'sequential' | 'shuffle' | 'repeat'
    if (mode) {
      if (playMode === mode) return // 已处于该模式：不触发 toast/重置 queue，避免误连点
      newMode = mode
    } else {
      const modes: Array<'sequential' | 'shuffle' | 'repeat'> = ['sequential', 'shuffle', 'repeat']
      newMode = modes[(modes.indexOf(playMode) + 1) % modes.length]
    }
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
        accentColor: playbackCoverColor,
      }])
    } else {
      setToasts(prev => {
        const nextToast = {
          id: existingId,
          message: modeNames[newMode],
          type: 'info' as const,
          accentColor: playbackCoverColor,
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
  const playbackSurfaceRef = useRef<HTMLDivElement>(null)
  // 播放页（各歌词界面）：鼠标本体无操作 8s 自动渐隐，一动立即显示
  const playbackCursorHideRef = useAutoHideCursor(8000)
  const watchPlayerRef = useRef<{
    togglePlay: () => boolean
    seekTo: (seconds: number) => void
    setVolume: (value: number) => void
    getCurrentTime: () => number
    /** 当前应用的对齐偏移（歌曲位 = 视频位 − 偏移；切回时还原歌曲位） */
    getAlignmentOffset: () => number
    fadeOutAudio: () => Promise<void>
  } | null>(null)
  /** 进入看歌时引擎音量（切回歌词模式时淡入到该值） */
  const watchEngineVolumeRef = useRef(1)
  const watchEngineMutedRef = useRef(false)
  /** MV 背景当前播放的视频状态（切到看歌时复用已加载的流，避免重新缓冲卡顿） */
  const mvBackgroundStateRef = useRef<{ songKey: string; bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string } | null>(null)
  // 稳定引用：BilibiliMvBackground 已 memo，这两个函数 prop 必须身份稳定
  // （实现体只读写 ref，无闭包状态，useCallback [] 安全）。
  const getMvAudioElementStable = useCallback(() => {
    const el = audioPlayerRef.current.getAudioElement()
    // WebView2 播放面：MV 背景同步时间源走 bridge（代理视图）
    if (audioPlayerRef.current.isExternalPlaybackActive?.()) {
      externalAudioViewRef.current = el
      return externalAudioProxyRef.current
    }
    return el
  }, [])
  const handleMvBackgroundPlayStateChange = useCallback((s: { songKey: string; bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string; currentTime: number } | null) => {
    // null = MV 背景已卸载/切歌/失败：清空复用缓存，避免切看歌时用上过期视频
    mvBackgroundStateRef.current = s ? { songKey: s.songKey, bvid: s.bvid, cid: s.cid, videoUrl: s.videoUrl, cacheKey: s.cacheKey, type: s.type } : null
  }, [])
  const [watchInitialVideo, setWatchInitialVideo] = useState<SongOwnedHandoff<{ bvid: string; cid: number; videoUrl: string; cacheKey: string; type?: string; currentTime: number }> | null>(null)
  /** HTMLAudioElement 音量渐变（等功率线性，避免双声爆音） */
  const fadeElementVolume = (el: HTMLAudioElement | null | undefined, from: number, to: number, ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (!el) return resolve()
      const startAt = performance.now()
      const step = () => {
        const t = Math.min(1, (performance.now() - startAt) / ms)
        el.volume = from + (to - from) * t
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  /** 看歌搜索失败：进入兼容音频界面（全局底部控件 + 右上角按钮组，无翻译/罗马音） */
  const [watchSearchFailed, setWatchSearchFailed] = useState(false)
  /** 看歌视频的实时播放状态（迷你播放器/桌面小窗按视频进度显示） */
  /** 看歌视频为当前时间线（视频模式且视频已接管播放）——迷你播放器/桌面小窗据此按视频显示与控制 */
  const watchTimelineActive = lyricDisplayMode === 'video' && watchVideoActive
  const watchTimelineActiveRef = useRef(watchTimelineActive)
  watchTimelineActiveRef.current = watchTimelineActive
  /** 切到看歌时的按歌曲归属音频续播位置（秒） */
  const [watchSyncSeek, setWatchSyncSeek] = useState<SongOwnedHandoff<number> | null>(null)
  const watchPausedEngineRef = useRef(false)
  const watchHandoffPendingRef = useRef(false)
  const lyricModeHandlerRef = useRef<(mode: LyricDisplayMode) => void>(() => undefined)
  lyricModeHandlerRef.current = handleLyricDisplayModeChange
  /**
   * 切出看歌时视频进度已越过歌曲音频末尾（MV 往往比歌长）：引擎停在歌曲末尾保持暂停，
   * 不再起播触发 ended → 自动切下一首（用户切个模式歌就被顶掉）。恢复 effect 据此跳过自动 play。
   */
  const watchResumeHeldAtEndRef = useRef(false)

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
      // 解除看歌挂起：引擎恢复对当前歌的正常过渡准备（automix 重新可用）
      audioPlayerRef.current?.setWatchHold?.(false)
      // 切出看歌：恢复引擎音量 + 播放（引擎在进入看歌时已被淡出回调暂停）
      if (watchPausedEngineRef.current) {
        watchPausedEngineRef.current = false
        const engineEl = audioPlayerRef.current?.getAudioElement?.()
        if (engineEl) {
          audioPlayerRef.current?.setVolume(watchEngineVolumeRef.current)
          engineEl.muted = watchEngineMutedRef.current
          // 视频进度越过歌曲末尾时停在末尾保持暂停（不自动切下一首），跳过自动起播
          if (!watchResumeHeldAtEndRef.current && engineEl.paused) {
            // play() 的媒体事件是异步的；先同步发布恢复意图，避免背景层在 hidden=false
            // 的首个 render 中仍看到看歌接管期间的 isPlaying=false 而再次暂停视频。
            setIsPlaying(true)
            const playPromise = engineEl.play()
            void playPromise.catch(() => {
              const activeEngineEl = audioPlayerRef.current?.getAudioElement?.()
              if (lyricDisplayModeRef.current === 'video' || activeEngineEl !== engineEl || !engineEl.paused) return
              setIsPlaying(false)
            })
          }
        }
      }
      return
    }
    // 进入看歌：目标视频/音频 active 后才淡出并暂停引擎，避免加载期听感断点。
    if (watchVideoActive && watchHandoffPendingRef.current) {
      watchHandoffPendingRef.current = false
      const engineEl = audioPlayerRef.current?.getAudioElement?.()
      if (engineEl && !engineEl.paused) {
        const from = engineEl.volume
        void fadeElementVolume(engineEl, from, 0, 200).then(() => {
          if (lyricDisplayModeRef.current !== 'video') return
          engineEl.pause()
          watchPausedEngineRef.current = true
          audioPlayer.playbackTimeStore.publish({ currentTime: engineEl.currentTime, isPlaying: false })
        })
      } else {
        watchPausedEngineRef.current = true
      }
    }
  }, [lyricDisplayMode, watchVideoActive])

  // 看歌期间引擎看门狗（双声防护）：视频接管时间线时，引擎**必须保持暂停**——任何路径
  //（自动过渡计时、媒体键冲突、恢复逻辑误触发）把引擎重新拉起播放，都会与 DASH 音频轨
  // 形成双重奏（用户实测 生活 切看歌必现、切回即好）。1s 周期把误播的引擎压回去。
  useEffect(() => {
    if (lyricDisplayMode !== 'video' || !watchVideoActive || watchHandoffPendingRef.current) return
    const timer = window.setInterval(() => {
      const el = audioPlayerRef.current?.getAudioElement?.()
      if (el && !el.paused) {
        el.pause()
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [lyricDisplayMode, watchVideoActive])

  // ===== 桌面播放器：独立置顶小窗口的状态桥接 =====
  const isPlayingRef = useRef(isPlaying)
  // ── 共振（多人一起听）的播放适配与跨平台解析 ─────────────────────────────
  // 房间只同步「哪首歌、播到哪一秒」；本机用自己的账号与音源播放，绝不共享会员。
  // 本机解析不了 → 静音跟随（不加载、不出声），并把原因交给共振界面提示。
  /** 已解析过的曲目缓存：同一首不重复搜索/取流（房间内最多 200 条） */
  const resonanceResolvedRef = useRef<Map<string, ResonanceLocalTrack>>(new Map())
  const resolveResonanceTrackCached = useCallback(async (track: ResonanceTrack) => {
    const cached = resonanceResolvedRef.current.get(track.key)
    if (cached) return cached
    const resolved = await resolveLocalTrack(track, resonancePlatforms)
    resonanceResolvedRef.current.set(track.key, resolved)
    if (resonanceResolvedRef.current.size > 200) {
      const oldest = resonanceResolvedRef.current.keys().next().value
      if (oldest) resonanceResolvedRef.current.delete(oldest)
    }
    return resolved
  }, [resonancePlatforms])

  /**
   * 预热房间里的下一首：与其它模式的「下一首预载」同一套内容（歌词 + 封面 + 音频地址）。
   *
   * 共振的播放权威在房主手里，本机不知道什么时候会换歌；等 `apply` 收到新 trackKey 才开拉，
   * 会比其它模式慢一拍（尤其是首次播放同一首歌）。这里在已知队列时提前把下一首备好。
   * 只做「解析 + 取流 + 预取封面/歌词」，不写 App 播放列表、不改播放状态。
   */
  const resonancePreloadedRef = useRef<Set<string>>(new Set())
  const preloadResonanceTrack = useCallback((track?: ResonanceTrack) => {
    if (!track?.key) return
    // 成员队列里「还没拉到的空位」是占位行，不是真歌：解析/预热它只会白跑一次搜索
    if (isQueuePlaceholder(track)) return
    if (resonancePreloadedRef.current.has(track.key)) return
    resonancePreloadedRef.current.add(track.key)
    void (async () => {
      try {
        const resolved = await resolveResonanceTrackCached(track)
        if (!resolved.playable || !resolved.song) return
        const song = resolved.song
        const cacheKey = getSongKey(song)
        // 歌词：与控制当前曲目同一入口，命中缓存则不重复请求
        void ensureSongLyrics(song, cacheKey)
        // 封面：按播放页角色的优先级预取，切过去时不会有空窗
        void preloadArtwork(song.album?.picUrl, { role: 'player', priority: 'visible' })
        // 音频地址：写进 App 的统一预载缓存（切歌时 loadAndPlaySong 直接命中，省一次往返）
        const source = {
          songId: resolved.platform === 'qq' ? (song.mid || song.id) : song.id,
          platform: resolved.platform || song.platform || 'netease',
        }
        const url = await getSongUrl(source.songId, source.platform).catch(() => null)
        if (!url || url === 'SONG_UNAVAILABLE') return
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
      } catch { /* 预热失败不影响播放：真到那首歌时还会正常解析 */ }
    })()
  }, [resolveResonanceTrackCached])

  /**
   * 共振换歌会把本机播放列表覆写成「这一首」（见下方 apply 的 handleSongSelect 调用）。
   * 这是房间语义决定的（队列由房主权威驱动，不该和本机私有列表打架），但**退出房间后必须还原**，
   * 否则用户的播放列表就只剩房间里最后一首，丢掉了他原来的正在播放/待播内容。
   * 这里在第一次被共振改写前存一份快照，房间结束时还回去。
   *
   * 还原前会确认「本机播放列表还是共振最后写进去的那一份」，用来兜住两种真实情形：
   * 挂起期间用户在别的模式里听了自己的歌、或退出前刚在房间里换过歌——那些内容不该被旧快照盖掉。
   * 注意：房间内本机列表本就由房间权威接管（用户自己选的歌下一次广播就会被覆盖），
   * 所以退出时回到进房前的状态是预期行为，不属于「丢掉用户操作」。
   */
  const resonancePlaylistBackupRef = useRef<{ playlist: Song[]; currentIndex: number } | null>(null)
  const resonanceManagedPlaylistRef = useRef<Song[] | null>(null)
  const restoreResonancePlaylist = useCallback(() => {
    const backup = resonancePlaylistBackupRef.current
    const managed = resonanceManagedPlaylistRef.current
    resonancePlaylistBackupRef.current = null
    resonanceManagedPlaylistRef.current = null
    if (!backup) return
    // 列表已不是共振写进去的那一份（用户在挂起期间或退出前放了自己的歌）→ 尊重用户当前内容，不动
    const current = playlistRef.current
    const untouched = Boolean(managed)
      && current.length === managed!.length
      && current.every((song, index) => getSongKey(song) === getSongKey(managed![index]))
    if (!untouched) return
    setPlaylist(backup.playlist)
    setCurrentIndex(backup.currentIndex)
    playlistRef.current = backup.playlist
    currentIndexRef.current = backup.currentIndex
    bumpQueueRevision()
    // 界面（currentSong 由 playlist/currentIndex 派生）已经回到老歌，引擎也得跟上，
    // 否则会出现「控件显示 A、实际在放房间那首 B」的不一致。
    const restored = backup.playlist[backup.currentIndex]
    if (restored) void loadAndPlaySongRef.current(restored, backup.currentIndex, backup.playlist)
  }, [bumpQueueRevision])
  const loadAndPlaySongRef = useRef(loadAndPlaySong)
  loadAndPlaySongRef.current = loadAndPlaySong

  /** 共振播放适配器：读本机播放 / 对齐房主权威进度 / 解析本机可播性 */
  const createResonanceAdapter = useCallback((hooks: { onUnplayable: (track: ResonanceTrack, result: ResonanceLocalTrack) => void }) => ({
    readLocal: () => {
      const song = currentSong
      if (!song) return null
      return {
        trackKey: canonicalTrackKey({ title: song.name, artists: (song.artists || []).map(artist => artist.name) }),
        positionMs: Math.max(0, Math.round((audioPlayer.playbackTimeStore.getSnapshot().currentTime || 0) * 1000)),
        playing: Boolean(isPlaying),
      }
    },
    apply: (playback: { trackKey: string; positionMs: number; playing: boolean }, hard: boolean) => {
      void (async () => {
        const room = getResonanceSession().getSnapshot()
        // 房间被挂起（房主切去别的模式）：谁都不跟着动，各自听自己的
        if (room.suspended) return
        const track = room.queue.items.find(item => item.key === playback.trackKey)
        if (!track) return
        const resolved = await resolveResonanceTrackCached(track)
        if (!resolved.playable || !resolved.song) {
          // 静音跟随：本机播不了这首（没会员/没版权/没登录），不加载也不出声，
          // 但必须**把本机正在响的那一首停掉**——房间已经换歌，用户这边上一首还在放，
          // 与界面上的「已静音跟随 · 原因」自相矛盾（设计 §12 明确否定这种割裂）。
          // 判定一律看「音频元素此刻是否真的在响」，不看 React 状态（apply 是异步的，状态可能过期）；
          // 在响就走播放器自己的 togglePlay 暂停（它会一并取消在途过渡、清理 gapless 备用轨、
          // 挂起音频上下文），而不是裸 pause 留下半截过渡。反之什么都不做，避免把已停的东西重新起播。
          const unplayableAudio = audioPlayerRef.current
          if (unplayableAudio?.isExternalPlaybackActive?.()) {
            // 外部播放源（WebView2/AirPlay）：本机元素恒为 paused，需要显式停掉播放面
            unplayableAudio.disableExternalPlayback()
          } else {
            const engineEl = unplayableAudio?.getAudioElement?.()
            if (engineEl && !engineEl.paused) unplayableAudio?.togglePlay()
          }
          hooks.onUnplayable(track, resolved)
          return
        }
        const sameSong = Boolean(currentSong && isSameSong(currentSong, resolved.song))
        if (!sameSong) {
          // 第一次被共振改写播放列表前先留一份备份，退出房间时还原（房间队列语义不受影响）
          if (!resonancePlaylistBackupRef.current) {
            resonancePlaylistBackupRef.current = { playlist: [...playlistRef.current], currentIndex: currentIndexRef.current }
          }
          // 走既有播放入口（ref 稳定引用）：换歌 + 交给统一播放链
          handleSongSelectRef.current(resolved.song, [resolved.song])
          // 记下共振写进本机的这一份：还原时据此判断「用户有没有自己动过播放列表」
          resonanceManagedPlaylistRef.current = [resolved.song]
          // 换歌后顺带把房间里的下一首也预热掉（与其它模式的下一首预载同一套：歌词 + 封面 + 音频地址）
          const index = room.queue.items.findIndex(item => item.key === playback.trackKey)
          if (index >= 0) preloadResonanceTrack(room.queue.items[index + 1])
          return
        }
        const audio = audioPlayerRef.current
        const target = Math.max(0, playback.positionMs / 1000)
        const drift = Math.abs((audioPlayer.playbackTimeStore.getSnapshot().currentTime || 0) - target)
        // 硬同步（换歌 / 暂停切换 / 房主拖进度）立即对齐；软同步只在漂移超过 0.6s 时纠偏
        if (hard || drift > 0.6) audio.seek(target)
        // 用 ref 读播放态：apply 是异步的（上面 await 过解析），闭包里的 isPlaying 可能已过期
        if (playback.playing !== Boolean(isPlayingRef.current)) audio.togglePlay()
      })()
    },
    setQueue: (tracks: ResonanceTrack[], startIndex: number) => {
      // 房间队列由共振界面展示；本机播放完全由房主权威状态驱动，不改写 App 播放列表（避免队列语义打架）。
      // 但要**预热下一首**：房间里换歌是房主说了算，如果不提前把下一首的歌词/封面/音频地址取好，
      // 轮到它的时候才现拉，会比其它模式明显慢半拍。
      preloadResonanceTrack(tracks[startIndex + 1])
    },
    canPlay: async (track: ResonanceTrack) => {
      const resolved = await resolveResonanceTrackCached(track)
      return { playable: resolved.playable, tier: resolved.tier, reason: resolved.reason }
    },
  }), [audioPlayer, currentSong, isPlaying, resolveResonanceTrackCached, preloadResonanceTrack])
  isPlayingRef.current = isPlaying
  /**
   * 本机是否是「正在驱动房间的房主」。
   * 用在自然放完（ended）的分支里：房主在房间里时，切歌必须推进房间队列而不是本机单曲列表。
   * 挂起的房间不算（房主在听自己的歌，本机行为保持不变）。
   */
  const isResonanceHost = useCallback(() => {
    const snapshot = getResonanceSession().getSnapshot()
    return snapshot.role === 'host' && snapshot.live && Boolean(snapshot.room) && !snapshot.room?.suspended
  }, [])

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
      // 看歌模式：视频为唯一时间线，媒体键/遥控 play·pause 交给视频播放器接管
      if (lyricDisplayMode === 'video') {
        handlePlayPause()
        return
      }
      const audio = audioPlayer.getAudioElement()
      // WebView2 播放面：本地元素恒为暂停态，"正在播"以 bridge 状态为准
      const currentlyPlaying = audioPlayer.isExternalPlaybackActive?.()
        ? getBridgeState().playing
        : isPlayingRef.current && !(audio?.paused ?? true)
      if (action === 'play' && !currentlyPlaying) audioPlayer.togglePlay()
      else if (action === 'pause' && currentlyPlaying) audioPlayer.togglePlay()
      else if (action === 'toggle') audioPlayer.togglePlay()
    } else if (action === 'next') {
      // 共振房间内：切歌必须推进房间队列。
      // 房间里本机列表被压成单曲，走 handleNext 只会在那一首上回绕（还会把全体成员硬拉回 0:00），
      // 所以遥控器/媒体键的「下一曲」要和界面上的「下一首」按钮走同一条路径。
      if (isResonanceHost()) getResonanceSession().hostNext()
      else handleNext()
    } else if (action === 'prev') {
      // 房间里的「上一曲」没有对应语义（队列由房主向前推进），不做本机回绕
      if (!isResonanceHost()) handlePrevious()
    } else if (action === 'select-index') {
      const index = Number(payload)
      const target = playlistRef.current[index]
      if (target) void handleSongSelectRef.current(target, playlistRef.current, undefined, index)
    } else if (action === 'seek') {
      if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
        watchPlayerRef.current.seekTo(Number(payload) || 0)
      } else {
        audioPlayerRef.current.seek(Number(payload) || 0)
      }
    } else if (action === 'volume') {
      const v = Math.max(0, Math.min(1, Number(payload)))
      if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
        watchPlayerRef.current.setVolume(v)
      } else {
        audioPlayerRef.current.setVolume(v)
      }
      if (v > 0 && mutedRef.current) { mutedRef.current = false; setMuted(false) }
    } else if (action === 'mute') {
      const next = !mutedRef.current
      mutedRef.current = next
      if (next) {
        lastVolumeRef.current = volumeRef.current > 0 ? volumeRef.current : 0.8
        if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
          watchPlayerRef.current.setVolume(0)
        } else {
          audioPlayerRef.current.setVolume(0)
        }
      } else {
        if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
          watchPlayerRef.current.setVolume(lastVolumeRef.current || 0.8)
        } else {
          audioPlayerRef.current.setVolume(lastVolumeRef.current || 0.8)
        }
      }
      setMuted(next)
    } else if (action === 'home') {
      // 遥控器 Home：回到当前模式主页（不切换模式），并关闭所有弹层
      // 特例：桌面模式播放被拽进播放页（viewMode 已是 minimal 但来源是桌面）→ 直接送回桌面模式
      if (viewModeRef.current === 'minimal' && enteredFromModeRef.current === 'desktop' && backStateRef.current.isPlaybackPage) {
        setViewMode('desktop')
        localStorage.setItem('viewMode', 'desktop')
        setEnteredFromMode('desktop')
        setShowSharedPlayer(false)
        setShowHome(false)
        return
      }
      setShowSharedPlayer(false)
      setShowHome(viewModeRef.current !== 'desktop')
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
      // 先让各弹窗/面板注册的 useTvBack 消费：手机遥控的 BACK 此前走的是另一条链路，
      // 完全绕过 dispatchTvBack —— 模式选择面板、软键盘、各弹窗都关不掉，反而把播放页/主页关了。
      if (dispatchTvBack()) return
      if (showSongDetail) setShowSongDetail(false)
      else if (showRemote) setShowRemote(false)
      else if (showMixingStudio) setShowMixingStudio(false)
      else if (showCommentModal) closeCommentModal()
      else if (showArtistDetail) closeArtistDetail()
      else if (showAlbumDetail) closeAlbumDetail()
      else if (showSettings) setShowSettings(false)
      else if (showSearch) setShowSearch(false)
      else { setShowSharedPlayer(false); setShowHome(viewModeRef.current !== 'desktop'); setShowProfile(false) }
    } else if (action === 'show-comment' || action === 'show-song' || action === 'show-artist') {
      const current = playlistRef.current[currentIndexRef.current]
      if (!current) return
      const platform = (current as any).platform || 'netease'
      if (action === 'show-comment') {
        handleViewComments(current)
      } else if (action === 'show-artist') {
        const artist = Array.isArray(current.artists) ? current.artists[0] : null
        // 汽水无艺人 ID，约定传歌手名
        const artistId = platform === 'soda' ? (artist?.name || artist?.id)
          : platform === 'qq' ? (artist?.mid || artist?.id)
            : platform === 'apple' ? (artist?.appleId || artist?.id) : artist?.id
        if (!artistId) {
          addToast('当前歌曲缺少歌手信息', 'error')
          return
        }
        handleOpenArtist(String(artistId), platform, artist?.name || '')
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
      const order = ['explore', 'minimal', 'traditional', 'desktop', 'resonance']
      const idx = order.indexOf(viewMode)
      const next = order[(idx + 1) % order.length]
      window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: next }))
    } else if (action === 'set-mode') {
      const mode = String(payload)
      if (['explore', 'minimal', 'traditional', 'desktop', 'resonance'].includes(mode)) {
        window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode }))
      }
    } else if (action === 'set-lyric-mode') {
      const mode = String(payload) as LyricDisplayMode
      if (ALL_LYRIC_MODES.includes(mode)) handleLyricDisplayModeChange(mode)
    } else if (action === 'stop') {
      // 停止：暂停并回到开头（主流遥控器停止键）
      // 看歌模式：时间源是视频元素（rewind/fast-forward 同此处理），不能 seek 音频
      if (lyricDisplayModeRef.current === 'video' && watchPlayerRef.current) {
        try { watchPlayerRef.current.seekTo(0) } catch { /* 视频桥不可用时忽略 */ }
        if (watchVideoStateRef.current?.playing) watchPlayerRef.current.togglePlay?.()
      } else {
        audioPlayerRef.current.seek(0)
        if (audioPlayer.isExternalPlaybackActive?.()) {
          if (getBridgeState().playing) audioPlayer.togglePlay()
        } else {
          const audio = audioPlayer.getAudioElement()
          if (isPlayingRef.current && !(audio?.paused ?? true)) audioPlayer.togglePlay()
        }
      }
    } else if (action === 'rewind') {
      // WebView2 播放面：时间源来自 bridge（本地元素无媒体）；看歌模式：时间源是视频
      const t = lyricDisplayModeRef.current === 'video' && watchPlayerRef.current
        ? (watchPlayerRef.current?.getCurrentTime?.() || 0)
        : audioPlayer.isExternalPlaybackActive?.()
          ? (getBridgeState().position || 0)
          : (audioPlayer.getAudioElement()?.currentTime || 0)
      audioPlayerRef.current.seek(Math.max(0, t - 10))
    } else if (action === 'fast-forward') {
      const watchMode = lyricDisplayModeRef.current === 'video' && watchPlayerRef.current
      const external = audioPlayer.isExternalPlaybackActive?.()
      const t = watchMode
        ? (watchPlayerRef.current?.getCurrentTime?.() || 0)
        : external ? (getBridgeState().position || 0) : (audioPlayer.getAudioElement()?.currentTime || 0)
      const d = watchMode
        ? (watchVideoStateRef.current?.duration || 0)
        : external ? (getBridgeState().duration || 0) : (audioPlayer.getAudioElement()?.duration || 0)
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
  // IPC 推送变化去重：记录上次推送的进度与频谱，避免 10Hz tick 无变化也扇出
  const desktopSpectrumLastPushProgressRef = useRef(-1)
  const desktopSpectrumLastPushSpectrumRef = useRef<number[]>(Array(5).fill(0))

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
      // volume/seek 是连续控制（拖动滑块会产生高频事件），不能被按键去重拦截
      const isContinuous = action === 'volume' || action === 'seek' || action === 'select-index'
      const group = action === 'toggle' || action === 'play' || action === 'pause' ? 'playback' : action
      const now = Date.now()
      const last = lastMediaControlRef.current
      // Windows 有时会同时把同一次按键交给 globalShortcut 与 Media Session。
      if (!isContinuous && last?.group === group && now - last.time < 280) return
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
    // payload 必须透传：任务栏播控/托盘弹窗的 seek、volume 等带参动作依赖它
    const unsubscribe = mediaKeys?.onControl((action, payload) => dispatchMediaControl(action, payload))
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

  // 歌词岛 / 任务栏播控：托盘菜单等主进程路径改动开关后，转成 DOM 事件供设置面板同步
  useEffect(() => {
    const unsubscribe = window.electron?.lyricsIsland?.onEnabledChanged?.(enabled => {
      window.dispatchEvent(new CustomEvent('lyricsIslandEnabledChanged', { detail: enabled === true }))
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    const unsubscribe = window.electron?.taskbarWidget?.onEnabledChanged?.(enabled => {
      window.dispatchEvent(new CustomEvent('taskbarWidgetEnabledChanged', { detail: enabled === true }))
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

  // AirPlay 投送端：初始化订阅（设备发现/连接状态），并把当前播放信息作为探测源。
  // 采集点（masterGain）由 handleAudioGraphReady 注入；此处仅提供元数据与播放状态。
  useEffect(() => {
    airplayController.init()
    return () => airplayController.dispose()
  }, [])

  // 音频输出设备：应用启动即后台预载设备列表（播放设备控制弹窗打开直接显示）
  useEffect(() => {
    void import('./services/audioOutput').then(({ initAudioOutputDevices }) => initAudioOutputDevices())
  }, [])

  const airplayProbeRef = useRef({
    title: '', artist: '', album: '', coverUrl: '', durationMs: 0, elapsedMs: 0, isPlaying: false,
  })
  airplayProbeRef.current = {
    title: currentTrack.title || '',
    artist: currentTrack.artist || '',
    album: currentTrack.album || '',
    coverUrl: currentTrack.coverUrl || '',
    durationMs: Math.max(0, (Number(currentTrack.duration) || 0) * 1000),
    elapsedMs: 0,
    isPlaying: Boolean(isPlaying),
  }
  useEffect(() => {
    airplayController.attachProbe(() => ({
      ...airplayProbeRef.current,
      elapsedMs: Math.max(0, currentTimeRef.current) * 1000,
    }))
    return () => airplayController.detachProbe()
  }, [])

  // AirPlay 音量条变化（跟随软件音量开启时）→ 同步软件音量条显示
  useEffect(() => {
    const onAirplayVolume = (event: Event) => {
      const v = Number((event as CustomEvent<number>).detail)
      if (Number.isFinite(v)) setVolume(Math.max(0, Math.min(1, v)))
    }
    window.addEventListener('airplay-volume-changed', onAirplayVolume)
    return () => window.removeEventListener('airplay-volume-changed', onAirplayVolume)
  }, [])

  // AirPlay 投送时静音本机输出（声音只走音箱），断开/停止投送恢复原音量。
  // 只静音输出设备、不改 UI 音量：音量按钮保持原值显示，投送期间操作它控制 AirPlay 音量。
  // 投送状态由「播放设备控制」弹窗的音频输出列表直接体现（AirPlay 条目自动选中），不再弹 toast。
  const airplayLocalMutedRef = useRef(false)
  const airplayRestoreVolumeRef = useRef(1)
  const airplayStreamingRef = useRef(false)
  const airplayUnmuteTimerRef = useRef<number | null>(null)
  useEffect(() => {
    return airplayController.subscribe((status) => {
      const streaming = status?.phase === 'streaming'
      airplayStreamingRef.current = streaming
      if (streaming && !airplayLocalMutedRef.current) {
        airplayLocalMutedRef.current = true
        if (airplayUnmuteTimerRef.current !== null) {
          window.clearTimeout(airplayUnmuteTimerRef.current)
          airplayUnmuteTimerRef.current = null
        }
        airplayRestoreVolumeRef.current = volumeRef.current > 0 ? volumeRef.current : 1
        // 音量条同步显示当前 AirPlay 音量（用户期望整个软件音量控件跟随音箱音量）
        setVolume(airplayController.getVolume() / 100)
        // 只静音本机输出（outputGain，采集点在其之前不受影响），投送给音箱的仍是完整声音
        airplayController.setLocalMute(true)
      } else if (!streaming && airplayLocalMutedRef.current) {
        // 暂停/切歌会短暂离开 streaming：延迟 1.5s 再恢复，避免闪烁与音量条跳动
        if (airplayUnmuteTimerRef.current === null) {
          airplayUnmuteTimerRef.current = window.setTimeout(() => {
            airplayUnmuteTimerRef.current = null
            airplayLocalMutedRef.current = false
            airplayController.setLocalMute(false)
            setVolume(airplayRestoreVolumeRef.current)
          }, 1500)
        }
      }
    })
  }, [])

  useEffect(() => {
    window.electron?.desktopPlayer?.pushState({
      song: currentSong
        ? {
            name: currentSong.name,
            artists: Array.isArray(currentSong.artists)
              ? currentSong.artists.map((artist: any) => artist?.name).filter(Boolean).join(' / ')
              : '',
            coverUrl: getResolvedArtworkUrl(currentSong.album?.picUrl || '', { role: 'player', size: 512 }),
            coverRevision: currentSong.album?.picUrl || '',
          }
        : null,
      // 时长（秒）：主进程据此把任务栏进度条换算为 0-1
      duration: currentSong && !isAppleRadioPlayback && Number.isFinite(Number(currentSong.duration))
        ? Math.max(0, Number(currentSong.duration) / 1000)
        : 0,
      live: isLive || currentAppleRadio?.timeline === 'live',
      // 电台/播客没有相邻曲目语义：独立播放窗隐藏上一曲/下一曲
      nonSkippable: isAppleRadioPlayback || podcastPlayback,
      lyricsPlaceholder: currentMiniLyricsPlaceholder,
    })
  }, [currentSong, currentAppleRadio?.timeline, isAppleRadioPlayback, podcastPlayback, isLive, currentMiniLyricsPlaceholder])

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
    window.electron?.desktopPlayer?.pushState({ playing: watchTimelineActive ? watchVideoState.playing : isPlaying })
  }, [isPlaying, watchTimelineActive, watchVideoState.playing])

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
        // 先彻底关闭底层全屏弹窗：歌曲详情(z-85)低于专辑详情(z-300)/歌单详情面板(z-95)，
        // 叠开会被盖住成为"隐形弹窗"（同 handleViewComments 的"彻底关闭"语义）
        dismissAlbumDetail()
        dismissArtistDetail()
        closeDetailPlaylistImmediate()
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
        // 同上：相似歌曲面板(z-85)会被专辑/歌单详情盖住，先彻底关闭底层弹窗
        dismissAlbumDetail()
        dismissArtistDetail()
        closeDetailPlaylistImmediate()
        setSimilarSongsSource(song)
        setShowSimilarSongs(true)
      }
    }
    window.addEventListener('waveforge:show-similar-songs', handler)
    return () => window.removeEventListener('waveforge:show-similar-songs', handler)
  }, [])

  // 相似歌曲直接切歌（网易云灯泡行为）：右键菜单/轮盘派发。
  // handler 走 latest-ref：App 高频重渲染时避免反复退订/重订 window 监听。
  const playSimilarEventRef = useRef<(event: Event) => void>(() => undefined)
  playSimilarEventRef.current = (event) => {
    const detail = (event as CustomEvent<Song | null | undefined>).detail
    void queueSimilarNext(detail || playlist[currentIndexRef.current] || null)
  }
  useEffect(() => {
    const handler = (event: Event) => playSimilarEventRef.current(event)
    window.addEventListener('waveforge:play-similar-song', handler)
    return () => window.removeEventListener('waveforge:play-similar-song', handler)
  }, [])

  // 歌曲详情内嵌 MV 播放前请求暂停主音频（防"歌唱+MV 双重奏"）。
  // 显式暂停而非 toggle：仅当确实在播放时暂停（口径与遥控/媒体键的 pause 分支一致，
  // WebView2 播放面以 bridge 状态为准）。
  useEffect(() => {
    const handler = () => {
      const audio = audioPlayerRef.current.getAudioElement()
      const currentlyPlaying = audioPlayerRef.current.isExternalPlaybackActive?.()
        ? getBridgeState().playing
        : isPlayingRef.current && !(audio?.paused ?? true)
      if (currentlyPlaying) audioPlayerRef.current.togglePlay()
    }
    window.addEventListener('waveforge:pause-main-playback', handler)
    return () => window.removeEventListener('waveforge:pause-main-playback', handler)
  }, [])

  // 音质快捷切换（播放条按钮）显示开关：默认开启，快捷设置 → 外观 可关；
  // 独立 localStorage 键 + 事件同步（与其它快捷设置开关同模式）。
  const [qualityQuickSwitch, setQualityQuickSwitch] = useState<boolean>(() => {
    try { return localStorage.getItem('waveforge:quality-quick-switch') !== 'false' } catch { return true }
  })
  useEffect(() => {
    const handler = (event: Event) => setQualityQuickSwitch(Boolean((event as CustomEvent<boolean>).detail))
    window.addEventListener('waveforge:quality-quick-switch-changed', handler)
    return () => window.removeEventListener('waveforge:quality-quick-switch-changed', handler)
  }, [])

  // 共振挂起时，全局右键菜单多一项「推送至共振（一起听）」→ 这里把歌交给房间。
  // 房主当场决定：能加就设成下一曲，不能加就挂进预排队。
  useEffect(() => {
    const handler = (event: Event) => {
      const song = (event as CustomEvent).detail as Song | undefined
      if (!song?.name) return
      const session = getResonanceSession()
      const result = session.pushTrack(songToResonanceTrack(song))
      if (!result.ok) {
        addToast(`没能推送到共振房间：${result.reason === 'no-room' ? '房间已经不在了' : result.reason || '未知原因'}`, 'error')
        return
      }
      const mine = session.getSnapshot().role === 'host'
      if (mine) {
        addToast(
          result.mode === 'pending'
            ? `《${song.name}》已预排进共振房间，等你的加歌资格放开`
            : `《${song.name}》已设为共振房间的下一曲`,
          'success',
        )
      } else {
        addToast(`《${song.name}》已推送到共振房间，房主会按房间规则排进队列`, 'success')
      }
    }
    window.addEventListener(RESONANCE_PUSH_EVENT, handler)
    return () => window.removeEventListener(RESONANCE_PUSH_EVENT, handler)
  }, [addToast])

  /**
   * 播放/暂停、换歌时**立即**把权威状态推给房间。
   *
   * session 里那条 2s 心跳只是兜底；设计 §6 承诺「播放/暂停/seek 是硬同步（立即对齐）」，
   * 但此前 App 侧一处都没调用 pushPlayback，实际同步延迟就等于心跳周期（最坏 2s）。
   * 房主与「获授权控制播放的成员」都要推：canControl 已经在 session 内校验，
   * 没有控制权时它会自己 return。
   */
  useEffect(() => {
    const session = getResonanceSession()
    const snapshot = session.getSnapshot()
    if (snapshot.role !== 'host' && !snapshot.canControl) return
    session.pushPlayback(true)
  }, [isPlaying, currentSong])

  // 共振房间结束（主动退出 / 解散 / 被移出 / 房主离开）后，把被共振覆写的本机播放列表还原回去。
  // 房间内「退出房间」按钮直接调 session.leave()，不经过 App，所以这里订阅会话状态统一收口。
  // 也要跟着「单例被替换」重新订阅：插件被禁用会 clearResonanceSession() 销毁单例，
  // 旧订阅此后永远不会再收到通知，还原就再也不会触发（本机播放列表会永远停在房间那首）。
  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    let hadRoom = false
    const attach = () => {
      unsubscribe?.()
      const session = getResonanceSession()
      hadRoom = Boolean(session.getSnapshot().room)
      unsubscribe = session.subscribe(() => {
        const snapshot = session.getSnapshot()
        const hasRoom = Boolean(snapshot.room)
        if (hadRoom && !hasRoom) restoreResonancePlaylist()
        hadRoom = hasRoom
      })
    }
    attach()
    const offLifecycle = subscribeResonanceSessionLifecycle(attach)
    return () => {
      offLifecycle()
      unsubscribe?.()
    }
  }, [restoreResonancePlaylist])

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
      // 游戏模式冻结（主窗已隐藏到托盘）：跳过频谱计算与推送，换取 CPU/GPU 占用骤降；
      // 保留 1Hz 空转心跳，解冻后自动恢复。歌词岛的进度由 500ms 兜底推送维持。
      if (gameModeFrozenRef.current) {
        if (isPlayingRef.current || watchTimelineActiveRef.current) schedule(1000)
        return
      }
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
      // WebView2 播放面：WASAPI loopback 频谱来自 bridge（64 对数 bin），本地 analyser 无音频流
      const externalPlaying = Boolean(audioPlayer.isExternalPlaybackActive?.() && getBridgeState().playing)
      const audioActive = Boolean(externalPlaying || (analyser && isPlayingRef.current && !(audio?.paused ?? true)))
      if (!audioActive && desktopSpectrumIdleRef.current && !overlayActive) return

      let spectrum: number[]
      if (audioActive && (analyser || externalPlaying)) {
        const bins = externalPlaying
          ? externalSpectrumRef.current.length
          : (analyser?.frequencyBinCount ?? 64)
        if (!desktopSpectrumBufferRef.current || desktopSpectrumBufferRef.current.length !== bins) {
          desktopSpectrumBufferRef.current = new Uint8Array(bins)
        }
        const data = desktopSpectrumBufferRef.current
        if (externalPlaying) {
          const extBins = externalSpectrumRef.current
          for (let index = 0; index < bins; index += 1) data[index] = extBins[index] ?? 0
        } else {
          analyser!.getByteFrequencyData(data)
        }
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
        // 变化去重：进度 ≥0.5s 或频谱明显变化才推送（10Hz tick 只在有变化时扇出 IPC/遥控 TCP）
        const progressNow = watchTimelineActiveRef.current
          ? (watchVideoStateRef.current?.time || 0)
          : (audioPlayer.isExternalPlaybackActive?.()
              ? (getBridgeState().position || 0)
              : (Number(audio?.currentTime) || 0)) + lyricOffsetRef.current - 0.2
        const progressChanged = Math.abs(progressNow - desktopSpectrumLastPushProgressRef.current) >= 0.5
        const spectrumChanged = compactSpectrum.some((value, index) => Math.abs(value - desktopSpectrumLastPushSpectrumRef.current[index]) > 0.03)
        if (progressChanged || spectrumChanged) {
          desktopSpectrumLastPushProgressRef.current = progressNow
          desktopSpectrumLastPushSpectrumRef.current = Array.from(compactSpectrum)
          if (watchTimelineActiveRef.current) {
            // 看歌模式：桌面小窗进度按视频
            const v = watchVideoStateRef.current
            window.electron?.desktopPlayer?.pushState({
              spectrum: compactSpectrum,
              progress: v.time,
              duration: v.duration || 0,
            })
          } else {
            window.electron?.desktopPlayer?.pushState({
              spectrum: compactSpectrum,
              progress: progressNow,
              duration: audioPlayer.isExternalPlaybackActive?.()
                ? (getBridgeState().duration || 0)
                : (Number(audio?.duration) || 0),
            })
          }
        }
      }
      if (spectrumWidgetVisible) {
        window.dispatchEvent(new CustomEvent('desktopSpectrumChanged', { detail: spectrum }))
      }
      desktopSpectrumIdleRef.current = !audioActive

      if ((isPlayingRef.current || watchTimelineActiveRef.current) && (overlayActive || spectrumWidgetVisible)) schedule()
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
    // 任务栏进度上报仅桌面有意义（TV 上 electron 桥是空函数，注册即每秒空转）
    if (!isDesktop()) return
    const videoTimeline = watchTimelineActive
    if (!isPlaying && !videoTimeline) return
    // 游戏模式冻结期间 2Hz → 1Hz：歌词岛/任务栏播控都是本地插值，1s 推一次足够，
    // 少一半 IPC + 序列化唤醒是纯赚（解冻立即回到 2Hz）
    const intervalMs = gameModeFrozen ? 1000 : 500
    const timer = window.setInterval(() => {
      // 有 overlay 时上面的 tick 已每 100ms 高频推送，无需重复上报；
      // 游戏模式冻结期间 tick 停转，这条低频兜底负责维持歌词岛/任务栏的进度插值
      if (desktopOverlayActiveRef.current && !gameModeFrozenRef.current) return
      if (videoTimeline) {
        // 看歌模式：任务栏进度按视频
        const v = watchVideoStateRef.current
        if (v.duration > 0) window.electron?.desktopPlayer?.pushState({ progress: v.time, duration: v.duration })
        return
      }
      // WebView2 播放面：时间源来自 bridge（本地 audio 元素无媒体）
      if (audioPlayer.isExternalPlaybackActive?.()) {
        const s = getBridgeState()
        if (!s.playing) return
        window.electron?.desktopPlayer?.pushState({
          progress: (s.position || 0) + lyricOffsetRef.current - 0.2,
          duration: s.duration || 0,
        })
        return
      }
      const audio = audioPlayer.getAudioElement()
      if (!audio || audio.paused) return
      window.electron?.desktopPlayer?.pushState({
        progress: (Number(audio.currentTime) || 0) + lyricOffsetRef.current - 0.2,
        duration: Number.isFinite(audio.duration) && (audio.duration ?? 0) > 0 ? audio.duration : 0,
      })
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [isPlaying, watchTimelineActive, gameModeFrozen])

  const handleSeek = useCallback((time: number) => {
    // 看歌模式：seek 作用于视频（迷你播放器/全局进度条）
    if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
      watchPlayerRef.current.seekTo(time)
      return
    }
    audioPlayerRef.current.seek(time)
  }, [lyricDisplayMode])

  const handleVolumeChange = useCallback((newVolume: number) => {
    // AirPlay 投送中：音量按钮控制音箱音量（本机输出已静音），同时更新音量条显示
    if (airplayStreamingRef.current) {
      setVolume(newVolume)
      airplayController.setVolume(Math.round(Math.max(0, Math.min(1, newVolume)) * 100))
      return
    }
    // 看歌模式：音量作用于视频音轨
    if (lyricDisplayMode === 'video' && watchPlayerRef.current) {
      watchPlayerRef.current.setVolume(newVolume)
      return
    }
    audioPlayerRef.current.setVolume(newVolume)
    // 界面滑条调整音量时同步解除静音状态：媒体键静音后 mutedRef 仍为 true，
    // 用户拉高音量若不解除，托盘/歌词岛会一直显示静音图标且下一次媒体键「静音」语义反转
    if (newVolume > 0 && mutedRef.current) {
      mutedRef.current = false
      setMuted(false)
    }
    // 用户手动调整主音量：开启「跟随软件音量」时联动 AirPlay 音箱音量。
    // 只在用户操作时推送（unmute/streaming 同步等内部 setVolume 不推送，
    // 否则会拿默认 100% 音量覆盖用户设置的投送音量）。
    airplayController.setPlayerVolume(newVolume)
  }, [lyricDisplayMode])

  const handleDesktopQueueRemove = useCallback((index: number) => {
    if (index < 0 || index === currentIndexRef.current || index >= playlist.length) return
    // 删掉的是「后面还没播的」曲目时必须取消在途/已预载的过渡：引擎可能已把被删的那首作为
    // 下一首预载，交叉淡化时仍会切过去，而 UI/歌词停在刚播完的那首（音频与界面永久错位）。
    if (index > currentIndexRef.current) {
      audioPlayerRef.current?.cancelTransition('queue item removed', false)
    }
    const next = playlist.filter((_, itemIndex) => itemIndex !== index)
    playlistRef.current = next
    if (index < currentIndexRef.current) {
      currentIndexRef.current -= 1
      setCurrentIndex(currentIndexRef.current)
    }
    setPlaylist(next)
    const nextRevision = bumpQueueRevision()
    // 取消/顺序变化后按新队列重预载「下一首」，否则当前歌剩余时间里无缝/交叉过渡静默失效
    window.setTimeout(() => preloadUpcomingSongs(currentIndexRef.current, nextRevision, playMode, next), 0)
  }, [playlist, bumpQueueRevision, playMode, preloadUpcomingSongs])

  const handleDesktopQueueMove = useCallback((from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= playlist.length || to >= playlist.length) return
    const next = [...playlist]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    const active = currentIndexRef.current
    const nextActive = active === from ? to : from < active && to >= active ? active - 1 : from > active && to <= active ? active + 1 : active
    // 移动涉及「未播区」时，引擎可能已把旧顺序的下一首预载/武装过渡，必须取消并按新顺序重预载
    // （对照 handleSmartReorder / handleDesktopQueueRemove；此前漏了这步：拖动后当前歌自然播完仍会切到拖动前的旧「下一首」）
    const upcomingChanged = from > active || to > active
    if (upcomingChanged) {
      audioPlayerRef.current?.cancelTransition('queue reordered', false)
    }
    currentIndexRef.current = nextActive
    playlistRef.current = next
    setCurrentIndex(nextActive)
    setPlaylist(next)
    const nextRevision = bumpQueueRevision()
    if (upcomingChanged) {
      window.setTimeout(() => preloadUpcomingSongs(nextActive, nextRevision, playMode, next), 0)
    }
  }, [playlist, bumpQueueRevision, playMode, preloadUpcomingSongs])

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
    // 只在交互式登录时记录有效期：启动恢复也走这个函数，若每次都刷新 expiresAt，
    // 「登录已过期」提示将永远不触发（showToastMessage=false 即启动恢复路径）
    if (showToastMessage) recordLogin('netease')
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
      // 1. 先写入 QQ cookie 到后端服务器
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
        
        // 2. 获取用户详细信息（失败不回滚已成功的 cookie 登录，仅用默认资料）
        let userDetailData: any = null
        try {
          const userDetailRes = await fetch(`http://localhost:3001/api/qq/user/detail?id=${uin}&cookie=${encodeURIComponent(cookie)}`)
          userDetailData = await userDetailRes.json()
        } catch (detailError) {
          console.warn('⚠️ 获取QQ音乐用户详情网络失败，使用默认信息:', detailError)
          userDetailData = null
        }
        
        // qq-music-api返回的歌曲详情可能在result字段中
        if (userDetailData && userDetailData.creator) {
          const user = userDetailData.creator
          
          const username = getQQUserDisplayName(userDetailData, uin)
          const avatar = user.headpic || user.avatarUrl || user.avatar || ''
          const isVip = detectQQMusicVip(userDetailData)
          // 超级会员（比绿钻高一级）：杜比全景声/臻品母带4.0/臻品音质2.0 的门槛，单独落盘供音质弹层标注
          const isSvip = detectQQMusicSvip(userDetailData)
          localStorage.setItem('qq_svip', isSvip ? 'true' : 'false')
          
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
        // 同上：启动恢复不刷新有效期，否则过期提醒永不出现
        if (showToastMessage) recordLogin('qq')
        window.dispatchEvent(new CustomEvent('waveforge-auth-changed', {
          detail: { platform: 'qq', userId: uin }
        }))
      } else {
        throw new Error('设置Cookie失败')
      }
    } catch (error) {
      console.error('❌ QQ音乐登录失败:', error)
      // 启动时的静默恢复（showToastMessage=false）失败**不得**清登录态：
      // 同步后端 cookie 是尽力而为的一步（后端重启/瞬时超时都会失败），
      // 一次瞬时失败就把 qq_cookie / qq_user_id 抹掉 = 用户被莫名踢出登录，
      // 左栏歌单与推荐卡随之消失（2026-10-07 实测复现）。保留本地凭据，等后续请求自愈。
      if (!showToastMessage) return
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
  //
  // 这两个回调会作为 props 传给常驻挂载的 HomeView / DesktopView / SettingsPanel（均为 memo）。
  // 若每次渲染重建引用就会击穿这三棵巨型子树的 memo——App 每次因播放进度/过渡重渲染时
  // 都连带重渲染。故按本文件既有做法（viewCallbacks / profileLogoutRef）：实现体放 ref
  // 每次渲染刷新（闭包始终最新），对外只暴露引用稳定的 useCallback。
  const appleAuthHandlersRef = useRef({
    login: (_user: AppleUserInfo | null) => {},
    logout: () => {},
  })
  appleAuthHandlersRef.current = {
    login: (user: AppleUserInfo | null) => {
      refreshAppleAuth(user)
      setAuthRevision(previous => previous + 1)
      window.dispatchEvent(new CustomEvent('waveforge-auth-changed', {
        detail: { platform: 'apple', userId: '' }
      }))
      if (user) addToast('Apple Music 登录成功', 'success')
    },
    logout: () => {
      void window.electron?.appleLogout?.().catch(() => undefined)
      clearAppleLogin()
      refreshAppleAuth(null)
      setAuthRevision(previous => previous + 1)
      window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'apple' } }))
      addToast('Apple Music 已退出登录', 'info')
    },
  }
  const handleAppleLogin = useCallback(
    (user: AppleUserInfo | null) => appleAuthHandlersRef.current.login(user),
    [],
  )
  const handleAppleLogout = useCallback(
    () => appleAuthHandlersRef.current.logout(),
    [],
  )

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
      if (result.product) {
        const tier = entitlementTierFromSpotifyProduct(result.product)
        localStorage.setItem('spotify_product', String(result.product))
        setSpotifyEntitlement(tier)
      }
      if (result.userId) {
        localStorage.setItem('spotify_user_id', result.userId)
        setSpotifyUserId(String(result.userId))
      }
      setSpotifyLoggedIn(true)
      if (result.username) setSpotifyUsername(result.username)
      if (result.avatar) setSpotifyAvatar(result.avatar)
      void import('./services/spotifyService').then(({ fetchSpotifyMe }) => fetchSpotifyMe().then(profile => {
        if (!profile) return
        const tier = entitlementTierFromSpotifyProduct(profile.product)
        setSpotifyEntitlement(tier)
        if (profile.product) localStorage.setItem('spotify_product', profile.product)
      }))
      setAuthRevision(previous => previous + 1)
      window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'spotify', userId: result.userId || '' } }))
      addToast('Spotify 授权成功', 'success')
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const handleSpotifySessionExpired = () => {
      setSpotifyLoggedIn(false)
      setSpotifyUserId('')
      setSpotifyUsername('')
      setSpotifyAvatar('')
      setSpotifyEntitlement('unknown')
      localStorage.removeItem('spotify_product')
      setAuthRevision(previous => previous + 1)
      addToast('Spotify 登录已过期，请重新登录', 'info')
    }
    window.addEventListener('spotify-session-expired', handleSpotifySessionExpired)
    return () => window.removeEventListener('spotify-session-expired', handleSpotifySessionExpired)
  }, [])

  // 酷狗登录结果（主进程回调）：同步 userId/avatar 等扩展信息
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.onKugouAuthResult) return
    const unsub = bridge.onKugouAuthResult((result: any) => {
      if (!result?.success || !result.cookie) return
      // 同时写 localStorage 与 React state：只落盘会导致登录后
      // 简约模式（读 state）头像/昵称空白，重启后（读 localStorage）才出现
      if (result.username) {
        setKugouUsername(result.username)
        localStorage.setItem('kugou_username', result.username)
      }
      if (result.userId) {
        setKugouUserId(String(result.userId))
        localStorage.setItem('kugou_user_id', String(result.userId))
      }
      if (result.avatar) {
        setKugouAvatar(result.avatar)
        localStorage.setItem('kugou_avatar', result.avatar)
      }
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 汽水登录态自愈：
  // ① token 存在但昵称/头像/ID 缺失（旧版登录流程只落盘了 token）时，经后端 luna/pc/me 补齐用户资料；
  // ② 后端明确返回 loggedIn:false 且本地仍持有 cookie 时，判定 token 已失效——自动清除
  //    soda_token/soda_username/soda_avatar/soda_user_id 四键并同步状态（等效退出登录），
  //    让 UI 如实显示未登录，避免「假登录」壳（如汽水我的喜欢恒为空）一直误导。
  useEffect(() => {
    if (!sodaLoggedIn) return
    let cancelled = false
    void import('./services/sodaService').then(({ getSodaStatus }) =>
      getSodaStatus().then(async st => {
        if (cancelled) return
        if (st?.loggedIn) {
          const tier = entitlementTierFromSodaMembership(st.membership)
          setSodaEntitlement(tier)
          localStorage.setItem('soda_entitlement', tier)
          // 登录有效：仅当本地资料缺失时补齐昵称/头像/ID（原有「补全资料」逻辑保留）
          if (localStorage.getItem('soda_user_id') && localStorage.getItem('soda_username')) return
          const p = st.profile
          if (!p) return
          if (p.nickname) {
            setSodaUsername(p.nickname)
            localStorage.setItem('soda_username', p.nickname)
          }
          if (p.avatarUrl) {
            setSodaAvatar(p.avatarUrl)
            localStorage.setItem('soda_avatar', p.avatarUrl)
          }
          if (p.userId) {
            setSodaUserId(String(p.userId))
            localStorage.setItem('soda_user_id', String(p.userId))
          }
          return
        }
        // loggedIn:false 且 cookie 非空 → 疑似已失效。再确认一次：只有后端明确应答
        // loggedIn:false 才清理；网络失败/超时一律不动凭据，防止误清有效登录态。
        const cookie = localStorage.getItem('soda_token') || ''
        if (!cookie) return
        try {
          const resp = await fetch(`http://localhost:3001/api/soda/status?cookie=${encodeURIComponent(cookie)}`, {
            cache: 'no-store',
            signal: AbortSignal.timeout(5000),
          })
          if (!resp.ok) return
          const again = await resp.json()
          if (cancelled || again?.loggedIn !== false) return
          localStorage.removeItem('soda_token')
          localStorage.removeItem('soda_username')
          localStorage.removeItem('soda_avatar')
          localStorage.removeItem('soda_user_id')
          localStorage.removeItem('soda_entitlement')
          setSodaLoggedIn(false)
          setSodaUsername('')
          setSodaAvatar('')
          setSodaUserId('')
          setSodaEntitlement('unknown')
          setAuthRevision(previous => previous + 1)
          window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'soda' } }))
          addToast('汽水音乐登录态已失效，请重新登录', 'info')
        } catch { /* 后端未就绪/网络失败：保持现状，下次启动再检 */ }
      }).catch(() => { /* 忽略 */ })
    )
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sodaLoggedIn])

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
      if (session.userId) {
        setKugouUserId(String(session.userId))
        localStorage.setItem('kugou_user_id', String(session.userId))
      }
      if (session.avatar) {
        setKugouAvatar(session.avatar)
        localStorage.setItem('kugou_avatar', session.avatar)
      }
      if (!kugouLoggedIn) {
        setKugouLoggedIn(true)
        setAuthRevision(previous => previous + 1)
        window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'kugou' } }))
      }
    }).catch(() => { /* 忽略 */ })
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 汽水登录结果（主进程回调）：同步用户名/头像/ID
  useEffect(() => {
    const bridge = (window as any).electron
    if (!bridge?.onSodaAuthResult) return
    const unsub = bridge.onSodaAuthResult((result: any) => {
      if (!result?.success || !result.cookie) return
      if (result.username) {
        localStorage.setItem('soda_username', result.username)
        setSodaUsername(result.username)
      }
      if (result.avatar) {
        localStorage.setItem('soda_avatar', result.avatar)
        setSodaAvatar(result.avatar)
      }
      if (result.userId) {
        localStorage.setItem('soda_user_id', String(result.userId))
        setSodaUserId(String(result.userId))
      }
    })
    return () => { try { unsub?.() } catch { /* 忽略 */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 新三平台登录态处理（登录面板写入 localStorage，这里同步 React 状态 + 广播）──
  const handleSpotifyLogin = (cookie: string, username?: string) => {
    // Spotify 由主进程 OAuth 写入 token；仅当存在真实 access_token 才算登录（cookie 参数仅作占位）
    const loggedIn = Boolean(localStorage.getItem('spotify_access_token'))
    setSpotifyLoggedIn(loggedIn)
    if (loggedIn) setSpotifyUserId(localStorage.getItem('spotify_user_id') || '')
    if (loggedIn) {
      void import('./services/spotifyService').then(({ fetchSpotifyMe }) => fetchSpotifyMe().then(profile => {
        if (!profile) return
        const tier = entitlementTierFromSpotifyProduct(profile.product)
        setSpotifyEntitlement(tier)
        if (profile.product) localStorage.setItem('spotify_product', profile.product)
      }))
    }
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
    localStorage.removeItem('spotify_product')
    setSpotifyLoggedIn(false)
    setSpotifyUsername('')
    setSpotifyAvatar('')
    setSpotifyUserId('')
    setSpotifyEntitlement('unknown')
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
        // 未带回昵称：用隐藏窗口桥/代理拉取用户信息自愈（www.kugou.com 对服务端请求有 WAF，优先桥）
        void import('./services/kugouService').then(({ fetchKugouUserInfo }) =>
          fetchKugouUserInfo(cookie).then((info: any) => {
            if (info?.nickname) {
              setKugouUsername(info.nickname)
              localStorage.setItem('kugou_username', info.nickname)
              if (info.user_id) {
                setKugouUserId(String(info.user_id))
                localStorage.setItem('kugou_user_id', String(info.user_id))
              }
              if (info.avatar) {
                setKugouAvatar(info.avatar)
                localStorage.setItem('kugou_avatar', info.avatar)
              }
            }
          }).catch(() => { /* 忽略 */ })
        )
      }
      // 扫码登录面板已把 userid/头像直接落盘（概念版通道没有网页 getinfo）——这里同步进 React state，
      // 否则个人中心要重启应用（重新读 localStorage）才显示昵称/头像/ID
      const syncedUserId = localStorage.getItem('kugou_user_id') || ''
      const syncedAvatar = localStorage.getItem('kugou_avatar') || ''
      if (syncedUserId) setKugouUserId(syncedUserId)
      if (syncedAvatar) setKugouAvatar(syncedAvatar)
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
    // 概念版扫码凭据（kugou_concept_credential）一并清除，避免「退出后仍按扫码通道请求」
    void import('./services/kugouService').then(m => m.clearKugouConceptCredential()).catch(() => {})
    setKugouLoggedIn(false)
    setKugouUsername('')
    setKugouAvatar('')
    setKugouUserId('')
    // 同时清除共享 session 里的 kugou.com Cookie：否则登录弹窗会带出旧账号，无法换号登录
    const bridge = (window as any).electron
    if (bridge?.clearKugouSession) void bridge.clearKugouSession()
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'kugou' } }))
    addToast('酷狗音乐已退出登录', 'info')
  }
  const handleSodaLogin = (cookie: string, username?: string, extra?: { avatar?: string; userId?: string }) => {
    setSodaLoggedIn(Boolean(cookie))
    if (cookie) {
      localStorage.setItem('soda_token', cookie)
      if (username) {
        setSodaUsername(username)
        localStorage.setItem('soda_username', username)
      }
      if (extra?.avatar) {
        setSodaAvatar(extra.avatar)
        localStorage.setItem('soda_avatar', extra.avatar)
      }
      if (extra?.userId) {
        setSodaUserId(String(extra.userId))
        localStorage.setItem('soda_user_id', String(extra.userId))
      }
      // 会员信息与资料字段是否齐全无关，每次登录都刷新。
      void import('./services/sodaService').then(({ getSodaStatus }) =>
        getSodaStatus().then(st => {
          if (!st?.loggedIn) return
          const tier = entitlementTierFromSodaMembership(st.membership)
          setSodaEntitlement(tier)
          localStorage.setItem('soda_entitlement', tier)
          if (username && extra && (extra.userId || extra.avatar)) return
          if (!st.profile) return
          const p = st.profile
          if (p.nickname) {
            setSodaUsername(p.nickname)
            localStorage.setItem('soda_username', p.nickname)
          }
          if (p.avatarUrl) {
            setSodaAvatar(p.avatarUrl)
            localStorage.setItem('soda_avatar', p.avatarUrl)
          }
          if (p.userId) {
            setSodaUserId(String(p.userId))
            localStorage.setItem('soda_user_id', String(p.userId))
          }
        }).catch(() => { /* 忽略 */ })
      )
    }
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'soda' } }))
    if (cookie) addToast('汽水音乐登录成功', 'success')
  }
  const handleSodaLogout = () => {
    // 主进程侧同步清理：auth-v6 分区的 .qishui.com Cookie/本地存储 + soda-qr-login.json 会话字段，
    // 否则换账号后旧凭据仍有效；TV/旧版无此桥（clearSodaLogin 不存在）时跳过，仅清渲染层四键
    const bridge = (window as any).electron
    if (bridge?.clearSodaLogin) void Promise.resolve(bridge.clearSodaLogin()).catch(() => { /* 忽略 */ })
    localStorage.removeItem('soda_token')
    localStorage.removeItem('soda_username')
    localStorage.removeItem('soda_avatar')
    localStorage.removeItem('soda_user_id')
    localStorage.removeItem('soda_entitlement')
    setSodaLoggedIn(false)
    setSodaUsername('')
    setSodaAvatar('')
    setSodaUserId('')
    setSodaEntitlement('unknown')
    setAuthRevision(previous => previous + 1)
    window.dispatchEvent(new CustomEvent('waveforge-auth-changed', { detail: { platform: 'soda' } }))
    addToast('汽水音乐已退出登录', 'info')
  }

  const handleRemoveFromFavorites = async (song: Song): Promise<boolean> => {
    try {
      const platform = (song.platform || 'netease') as MusicPlatform
      // Apple：取消“喜爱”评分，不从音乐资料库删除。
      if (platform === 'apple') {
        if (!appleLoggedIn) {
          addToast('请先登录 Apple Music', 'error')
          return false
        }
        const appleSongId = song.appleId || String(song.id)
        const ok = await setAppleSongLoved(appleSongId, false)
        if (ok) {
          addToast('已取消喜爱', 'success')
          applyFavoriteMutation({ platform: 'apple', type: 'unlike', songId: appleSongId })
          window.dispatchEvent(new CustomEvent('playlist-content-changed', {
            detail: { platform: 'apple', type: 'unlike', songId: appleSongId }
          }))
          return true
        }
        const failure = getLastAppleMutationResult()
        addToast(failure.error || '取消喜爱失败', 'error')
        return false
      }
      const userId = getPlatformUserId(platform)

      if (!userId) {
        addToast(`请先登录${platformLabel(platform)}`, 'error')
        return false
      }

      const mutationSong = platform === 'qq' && !song.mid ? await loadQQSongDetail(song) : song
      const result = await likeSong(mutationSong.id.toString(), userId, platform, false, {
        songMid: mutationSong.mid,
        songType: mutationSong.songType
      })

      if (result.code === 200 || result.result === 100) {
        addToast('已从喜欢歌单中移除', 'success')
        const changed = !result.unchanged
        if (changed) {
          updateCachedUserPlaylists(platform, userId, playlists => playlists.map(item => (
            item.isLike
              ? { ...item, trackCount: Math.max(0, Number(item.trackCount || 0) - 1) }
              : item
          )))
        }
        window.dispatchEvent(new CustomEvent('playlist-content-changed', {
          detail: {
            platform,
            type: 'unlike',
            songId: mutationSong.id,
            songMid: mutationSong.mid,
            trackCountDelta: changed ? -1 : 0,
          }
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
    setPlaybackContextPlaylistsLoading(true)
    const platform = (currentSong.platform || 'netease') as MusicPlatform
    if (platform === 'apple') {
      void getAppleLibraryPlaylists(100)
        .then(setPlaybackContextPlaylists)
        .catch(() => setPlaybackContextPlaylists([]))
        .finally(() => setPlaybackContextPlaylistsLoading(false))
      return
    }
    const userId = getPlatformUserId(platform) || ''
    const username = platform === 'netease' ? neteaseUsername : qqUsername
    const tokenDriven = platform === 'spotify' || platform === 'kugou' || platform === 'soda'
    if (!userId && !tokenDriven) {
      setPlaybackContextPlaylistsLoading(false)
      return
    }
    void getUserPlaylists(platform, userId, username)
      .then(setPlaybackContextPlaylists)
      .catch(error => {
        console.warn('Failed to load playlists for playback context menu:', error)
        setPlaybackContextPlaylists([])
      })
      .finally(() => setPlaybackContextPlaylistsLoading(false))
  }

  const favoriteMutationInFlightRef = useRef<Set<string>>(new Set())
  const handlePlaybackToggleFavorite = (song: Song, liked: boolean) => {
    // 连点会重复提交：网易云的服务端不返回 unchanged、前端也没有请求中防抖，本地「我喜欢」
    // 计数会被加多次。同一首歌的收藏操作在途时忽略后续点击。
    const key = getSongKey(song)
    if (favoriteMutationInFlightRef.current.has(key)) return
    favoriteMutationInFlightRef.current.add(key)
    const done = () => { favoriteMutationInFlightRef.current.delete(key) }
    if (liked) void handleRemoveFromFavorites(song).then(done, done)
    else void handleAddToFavorites(song).then(done, done)
  }

  /** 各平台的歌手标识字段不同：汽水用名字当伪 id、QQ 用 mid、Apple 用 appleId，其余用数字 id。 */
  const resolvePlaybackArtistId = (platform: MusicPlatform, artist?: { id?: number | string; mid?: string; appleId?: string; name?: string }): string =>
    resolveArtistIdentifier(platform, artist)

  /** 打开播放中歌曲的第 index 位歌手（播放页右键 / 径向菜单 / 多歌手选择器共用）。 */
  const openPlaybackArtistAt = (song: Song, index: number) => {
    const platform = (song.platform || 'netease') as MusicPlatform
    const artist = song.artists?.[index]
    const artistId = resolvePlaybackArtistId(platform, artist)
    if (!artistId) {
      addToast('当前歌曲缺少歌手信息', 'error')
      return
    }
    handleOpenArtist(artistId, platform, artist?.name || '')
  }

  const handlePlaybackViewArtist = (song: Song) => {
    const intent = resolveViewArtistIntent(song.artists)
    if (intent.kind === 'none') {
      addToast('当前歌曲缺少歌手信息', 'error')
      return
    }
    // 单歌手直接进歌手页；多歌手先弹出选择器（背景是当前歌曲封面）让用户挑，
    // 不再默认取第一个——多歌手曲目里其余歌手原来根本没法从播放页进（用户实测反馈）。
    if (intent.kind === 'direct') {
      openPlaybackArtistAt(song, intent.index)
      return
    }
    setArtistPicker({ show: true, song })
  }

  const handlePlaybackViewAlbum = (song: Song) => {
    const platform = (song.platform || 'netease') as MusicPlatform
    // 汽水：resolveSongAlbumIdentifier 返回专辑名作标识（AlbumDetailModal 纯数字按 id、否则按名查询）
    void resolveSongAlbumIdentifier(song, platform).then(albumId => {
      if (!albumId) {
        addToast('当前歌曲缺少专辑信息', 'error')
        return
      }
      handleOpenAlbum(albumId, platform)
    })
  }

  // 播放页两个面板（PlaylistPanel/SimilarSongsPanel）的右键菜单回调包：
  // 处理器经 ref 转发最新闭包、对象用 useMemo 保持引用稳定——原来每次渲染都内联新建
  // songMenu 对象，播放中 1Hz 的进度重渲染会让两个面板的 memo 每秒失效一次。
  const playbackPanelHandlersRef = useRef({
    handleSongSelect,
    handlePlayNext,
    handleAddToFavorites,
    handleRemoveFromFavorites,
    handleAddToPlaylist,
    handleViewComments,
    handlePlaybackViewAlbum,
    handlePlaybackViewArtist,
    handleCopyInfo,
    onMenuOpen: handlePlaybackContextMenuOpen,
    playlist,
  })
  playbackPanelHandlersRef.current = {
    handleSongSelect,
    handlePlayNext,
    handleAddToFavorites,
    handleRemoveFromFavorites,
    handleAddToPlaylist,
    handleViewComments,
    handlePlaybackViewAlbum,
    handlePlaybackViewArtist,
    handleCopyInfo,
    onMenuOpen: handlePlaybackContextMenuOpen,
    playlist,
  }
  const panelSongMenu = useMemo(() => ({
    userPlaylists: playbackContextPlaylists,
    onPlayNow: (song: Song) => { void playbackPanelHandlersRef.current.handleSongSelect(song, playbackPanelHandlersRef.current.playlist) },
    onPlayNext: (song: Song) => { playbackPanelHandlersRef.current.handlePlayNext(song) },
    onAddToFavorites: (song: Song) => { void playbackPanelHandlersRef.current.handleAddToFavorites(song) },
    onRemoveFromFavorites: (song: Song) => { void playbackPanelHandlersRef.current.handleRemoveFromFavorites(song) },
    onAddToPlaylist: (song: Song, playlistId: string) => { void playbackPanelHandlersRef.current.handleAddToPlaylist(song, playlistId) },
    onViewComments: (song: Song) => { playbackPanelHandlersRef.current.handleViewComments(song) },
    onViewAlbum: (song: Song) => { playbackPanelHandlersRef.current.handlePlaybackViewAlbum(song) },
    onViewArtist: (song: Song) => { playbackPanelHandlersRef.current.handlePlaybackViewArtist(song) },
    onCopyInfo: (song: Song) => { playbackPanelHandlersRef.current.handleCopyInfo(song) },
    // 队列/相似歌曲面板自己右键打开菜单时也要按当前歌曲平台拉候选歌单，
    // 否则「添加到」子菜单是空的（这块原来只在播放页径向菜单里触发）
    onMenuOpen: () => { playbackPanelHandlersRef.current.onMenuOpen() },
  }), [playbackContextPlaylists])

  // 监听喜欢状态变化
  useEffect(() => {
    const restoreLoginState = async () => {
      // cookie 可能早于 30 天有效期就被撤销，而恢复到这一步只会「显示已登录」并把后续请求
      // 变成静默失败。这里在启动后**后台核验一次**，仅在明确判定未登录时提示用户重新登录；
      // 接口异常/网络失败一律按「未知」处理、不动登录态。刻意不做自动登出——误判的代价
      //（正常用户被踢出去）高于收益，所以只提示。
      const warnedCredentialPlatforms = new Set<string>()
      const warnIfCredentialInvalid = async (url: string, isInvalid: (body: any) => boolean, label: string) => {
        try {
          const response = await fetch(url)
          if (!response.ok) return
          const body = await response.json().catch(() => null)
          if (!body || !isInvalid(body) || warnedCredentialPlatforms.has(label)) return
          warnedCredentialPlatforms.add(label)
          addToast(`${label}登录信息可能已失效，请到设置中重新登录`, 'error')
        } catch {
          // 网络异常：按未知处理，不改登录态
        }
      }
      try {
        const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie')
        if (neteaseCookie) {
          await handleNeteaseLogin(neteaseCookie, false)
        }

        const qqCookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie')
        if (qqCookie) {
          await handleQQLogin(qqCookie, false)
        }

        // 核验放在恢复之后异步进行（不阻塞界面）；判定信号与登录路径一致：
        // 网易云 account/profile 双空、QQ 没有 creator。
        if (neteaseCookie) {
          void warnIfCredentialInvalid(
            `http://localhost:3001/api/netease/user/account?cookie=${encodeURIComponent(neteaseCookie)}`,
            body => body.account == null && body.profile == null,
            '网易云音乐',
          )
        }
        const qqUserId = localStorage.getItem('qq_user_id')
        if (qqCookie && qqUserId) {
          void warnIfCredentialInvalid(
            `http://localhost:3001/api/qq/user/detail?id=${encodeURIComponent(qqUserId)}&cookie=${encodeURIComponent(qqCookie)}`,
            body => !body.creator,
            'QQ 音乐',
          )
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
    // 游戏模式：停掉后台预取（10 分钟一次的突发网络 + 封面解码），把资源留给游戏
    if (gameModeEnabled) return
    return scheduleBackgroundPrefetch({
      viewMode,
      neteaseLoggedIn,
      qqLoggedIn,
      appleLoggedIn,
      sodaLoggedIn,
      appleStorefront,
      sodaAccountId: sodaUserId,
    })
  }, [loginRestoreComplete, viewMode, neteaseLoggedIn, qqLoggedIn, appleLoggedIn, sodaLoggedIn, appleStorefront, neteaseUserId, qqUserId, sodaUserId, gameModeEnabled])

  // 处理喜欢按钮点击 - 切换喜欢状态
  const getBackgroundStyle = () => {
    // 根据主题和显示模式返回背景样式
    if (playerTheme === 'light') {
      return dominantColor 
        ? `linear-gradient(135deg, color-mix(in srgb, ${dominantColor} 13%, transparent) 0%, #f5f5f0 50%, #e8e8e0 100%)`
        : 'linear-gradient(135deg, #f5f5f0 0%, #e8e8e0 100%)'
    }
    // 深色主题返回深色渐变背景
    return dominantColor 
      ? `linear-gradient(135deg, color-mix(in srgb, ${dominantColor} 8%, transparent) 0%, #000 100%)`
      : 'linear-gradient(135deg, #0a0a0a 0%, #000 100%)'
  }


  // ===== GPU 设置变更确认：用户修改显卡/关闭 GPU 加速后重启需确认，否则自动回退到安全默认值 =====
  const [pendingGpuChange, setPendingGpuChange] = useState<{ type: 'preference' | 'acceleration' | 'backend'; fromTier?: boolean } | null>(null)
  const [gpuConfirmCountdown, setGpuConfirmCountdown] = useState(30)
  const gpuCountdownRef = useRef(30)
  // 渲染后端切换后的「渲染器预热」：重启进入先预编译着色管线（可跳过），完成后才展示 30s 体验确认横幅
  const [gpuPreheatDone, setGpuPreheatDone] = useState(false)
  const [gpuPreheatProgress, setGpuPreheatProgress] = useState(0)

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
    void window.electron?.system.getGpuSettings().then(result => {
      if (cancelled) return
      if (result.pendingGpuChange) setPendingGpuChange(result.pendingGpuChange)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 启动后空闲预热 GPU 着色管线（游戏式 shader 预编译）：首次进入可视化场景不再卡编译。
  // TV 效能档跳过：重 GPU 歌词模式已禁入，预热只在弱 GPU 上白建 WebGL 上下文（隔离：仅 TV 效能档）。
  useEffect(() => {
    if (isTvModeActive() && isPerfModeEfficiency()) return
    runShaderWarmup()
  }, [])

  // 渲染后端切换后的「渲染器预热」：置顶遮罩预编译着色管线（可跳过）。
  // 预热完成 / 点击跳过后才放行下方 30s 倒计时确认横幅，让用户在真实后端下体验后决定去留，
  // 而不是一重启就被确认横幅打断、立刻改动设置。
  useEffect(() => {
    if (pendingGpuChange?.type !== 'backend') {
      setGpuPreheatDone(false)
      setGpuPreheatProgress(0)
      return
    }
    const PREHEAT_MIN_MS = 2600
    let cancelled = false
    const t0 = performance.now()
    const tick = () => {
      if (cancelled) return
      setGpuPreheatProgress(Math.min(100, ((performance.now() - t0) / PREHEAT_MIN_MS) * 100))
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    // 强制重跑预热（传 force 跳过 warmed 守卫，编译进入空闲序执行）
    window.setTimeout(() => runShaderWarmup(true), 0)
    const guard = window.setTimeout(() => {
      if (cancelled) return
      setGpuPreheatDone(true)
    }, PREHEAT_MIN_MS)
    return () => {
      cancelled = true
      window.clearTimeout(guard)
    }
  }, [pendingGpuChange])

  useEffect(() => {
    if (!pendingGpuChange) return
    gpuCountdownRef.current = 30
    setGpuConfirmCountdown(30)
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
  }, [pendingGpuChange, revertGpuChange, gpuPreheatDone])

  /** 打开任意用户主页（歌单创建者等二级入口）：复用 ProfileView 的他人主页视图 */
  const handleOpenUserProfile = useCallback((platform: MusicPlatform, userId: string, nickname?: string) => {
    if (!userId) return
    if (platform !== 'netease' && platform !== 'qq') return
    setProfileInitialPlatform(platform)
    setProfileInitialTab('created')
    setProfileUserTarget({ platform, userId: String(userId), nickname })
    setShowProfile(true)
  }, [])

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
    onOpenDeviceControl: () => void
    onSettingsClick: () => void
    onProfileClick: (platform: MusicPlatform, initialTab?: 'created' | 'subscribed' | 'detail' | 'recent') => void
    onOpenUserProfile: (platform: MusicPlatform, userId: string, nickname?: string) => void
    onOpenPlayer: (origin?: PlaybackOrigin) => void
    onExitDesktopMode: () => void
    onToggleFavorite: () => void
    onPlayModeChange: () => void
    onOpenMixingStudio: () => void
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
    onOpenUserProfile: handleOpenUserProfile,
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
    onOpenDeviceControl: () => setShowDeviceControl(true),
    onSettingsClick: () => setShowSettings(true),
    onProfileClick: (platform, initialTab = 'created') => {
      // ProfileView 支持网易云/QQ/Apple/汽水（汽水分支数据自足：资料读 localStorage，
      // 歌单/最近播放走 /api/soda/* 路由）；酷狗/Spotify 登录用户按钮可见但渲染条件
      // 短路（点了没反应），改为明确提示
      if (!['netease', 'qq', 'apple', 'soda'].includes(platform)) {
        addToast('该平台暂不支持查看个人主页', 'info')
        return
      }
      setProfileInitialPlatform(platform)
      setProfileInitialTab(initialTab)
      // 从自己的入口打开：清掉上次遗留的「他人主页」目标，避免冻结恢复后仍停在别人主页
      setProfileUserTarget(null)
      setShowProfile(true)
    },
    onOpenPlayer: (origin) => {
      setShowLogin(false)
      setShowSearch(false)
      const originMode = viewModeRef.current
      playbackOriginRef.current = origin || { mode: originMode, surface: originMode === 'minimal' ? 'home' : 'mode-root' }
      setRestorePlaybackOrigin(null)
      setEnteredFromMode(originMode)
      setShowSharedPlayer(true)
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
    onToggleFavorite: () => {
      const current = playlistRef.current[currentIndexRef.current]
      if (current) void handlePlaybackToggleFavorite(current, currentSongLiked)
    },
    onPlayModeChange: () => handlePlayModeChange(),
    onOpenMixingStudio: () => setShowMixingStudio(true),
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
      onSodaLogin: (cookie, username, extra) => latest.current.onSodaLogin(cookie, username, extra),
      onSodaLogout: () => latest.current.onSodaLogout(),
      onRemoveQueueItem: (index) => latest.current.onRemoveQueueItem(index),
      onMoveQueueItem: (from, to) => latest.current.onMoveQueueItem(from, to),
      onLoginClick: (platform) => latest.current.onLoginClick(platform),
      onNeteaseLoginClick: () => latest.current.onNeteaseLoginClick(),
      onQQLoginClick: () => latest.current.onQQLoginClick(),
      onSearchClick: () => latest.current.onSearchClick(),
      onRemoteClick: () => latest.current.onRemoteClick(),
      onOpenDeviceControl: () => setShowDeviceControl(true),
      onSettingsClick: () => latest.current.onSettingsClick(),
      onProfileClick: (platform, initialTab) => latest.current.onProfileClick(platform, initialTab),
      onOpenUserProfile: (platform, userId, nickname) => latest.current.onOpenUserProfile(platform, userId, nickname),
      onOpenPlayer: (origin) => latest.current.onOpenPlayer(origin),
      onExitDesktopMode: () => latest.current.onExitDesktopMode(),
      onToggleFavorite: () => latest.current.onToggleFavorite(),
      onPlayModeChange: () => latest.current.onPlayModeChange(),
      onOpenMixingStudio: () => latest.current.onOpenMixingStudio(),
    }
  }, [])

  // 稳定回调：三视图的登录/资料入口（内联箭头函数会逐秒重建，击穿 memo(HomeView/ExploreView/
  // TraditionalView)，TV 弱 CPU 上整棵视图树（含首页歌单列表）每秒全量重渲染）
  const openAppleLogin = useCallback(() => setShowAppleLogin(true), [])
  const handleMinimalLogin = useCallback((platform: MusicPlatform) => {
    if (platform === 'apple') { setShowAppleLogin(true); return }
    setLoginPlatform(platform)
    setShowLogin(true)
  }, [])
  const handleTraditionalLogin = useCallback((platform: MusicPlatform) => {
    if (platform === 'apple') { setShowAppleLogin(true); return }
    setLoginPlatform(platform)
    setShowLogin(true)
  }, [])
  const handleViewProfileClick = useCallback((platform: MusicPlatform) => {
    if (platform === 'apple') { setShowAppleLogin(true); return }
    setProfileInitialPlatform(platform)
    setProfileInitialTab('created')
    setProfileUserTarget(null)
    setShowProfile(true)
  }, [])

  // 设置面板常驻挂载，关闭回调需稳定引用以配合 memo 跳过播放中的重渲染
  const closeSettings = useCallback(() => setShowSettings(false), [])
  // 稳定引用：内联箭头函数会击穿 memo(SettingsPanel)，导致常驻挂载的巨型面板跟着 App 重渲染
  const openRemote = useCallback(() => setShowRemote(true), [])

  // 歌曲详情 / 相似歌曲弹窗关闭回调需稳定引用以配合 memo 跳过播放中的重渲染
  const closeSongDetail = useCallback(() => setShowSongDetail(false), [])
  const closeSimilarSongs = useCallback(() => setShowSimilarSongs(false), [])

  // 搜索面板：memo(SearchPanel) 配套稳定回调（面板打开期间 App 重渲染不再击穿）
  const closeSearchPanel = useCallback(() => {
    setShowSearch(false)
    setRestorePlaybackOrigin(null)
  }, [])
  const consumeRestoreOrigin = useCallback(() => setRestorePlaybackOrigin(null), [])
  const searchOpenPlaylistRef = useRef(handleOpenPlaylistFromDetail)
  searchOpenPlaylistRef.current = handleOpenPlaylistFromDetail
  const searchOpenPlaylistStable = useCallback((playlist: { id: string; platform?: MusicPlatform }) => {
    void searchOpenPlaylistRef.current(playlist.id, playlist.platform || 'netease')
  }, [])

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
  const profileSwitchPlatformRef = useRef<(platform: MusicPlatform) => void>(() => undefined)
  const profileLogoutRef = useRef<(platform: MusicPlatform) => void>(() => undefined)
  const smartReorderRef = useRef<() => void>(() => undefined)
  const playlistSongSelectRef = useRef<(index: number) => void>(() => undefined)
  closeProfileRef.current = () => { setShowProfile(false); setProfileUserTarget(null) }
  closeAlbumDetailRef.current = () => closeAlbumDetail()
  closePlaylistRef.current = () => setShowPlaylist(false)
  /** 个人中心可切换的平台（已登录 + 未隐藏，顺序即药丸内顺序） */
  const profileSwitchablePlatforms = useMemo(() => {
    const loggedIn: Record<MusicPlatform, boolean> = {
      netease: neteaseLoggedIn,
      qq: qqLoggedIn,
      apple: appleLoggedIn,
      spotify: spotifyLoggedIn,
      kugou: kugouLoggedIn,
      soda: sodaLoggedIn,
    }
    return (['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda'] as MusicPlatform[])
      .filter(platform => loggedIn[platform] && isPlatformVisible(platform))
  }, [neteaseLoggedIn, qqLoggedIn, appleLoggedIn, spotifyLoggedIn, kugouLoggedIn, sodaLoggedIn])
  profileSwitchPlatformRef.current = (platform: MusicPlatform) => {
    // 直切指定平台：只允许切到「已登录且未隐藏」的平台（药丸理论上只列这些，这里再兜一层）
    const loggedIn: Record<MusicPlatform, boolean> = {
      netease: neteaseLoggedIn,
      qq: qqLoggedIn,
      apple: appleLoggedIn,
      spotify: spotifyLoggedIn,
      kugou: kugouLoggedIn,
      soda: sodaLoggedIn,
    }
    if (!loggedIn[platform] || !isPlatformVisible(platform)) return
    setProfileInitialPlatform(platform)
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
    switchProfilePlatformTo: (platform: MusicPlatform) => profileSwitchPlatformRef.current(platform),
    logout: (platform: MusicPlatform) => profileLogoutRef.current(platform),
    smartReorder: () => smartReorderRef.current(),
    playlistSongSelect: (index: number) => playlistSongSelectRef.current(index),
  }), [])

  // 设置→高级 卡片触发 OOBE（默认不自动启用）
  useEffect(() => {
    const onTriggerOobe = () => setOobeOpenCount((v) => v + 1)
    window.addEventListener(OOBE_TRIGGER_EVENT, onTriggerOobe)
    return () => window.removeEventListener(OOBE_TRIGGER_EVENT, onTriggerOobe)
  }, [])

  const renderedMode: ViewMode = isPlaybackPage ? 'minimal' : viewMode
  // 探索页进入播放页时不再卸载探索页：播放页以覆盖层叠在其上（zIndex 4 > 探索 1），
  // 返回时只关覆盖层——滚动位置、打开中的歌单/电台弹窗、已加载内容全部原样保留。
  const exploreKeptAlive = isPlaybackPage && enteredFromMode === 'explore' && viewMode === 'explore'
  // 传统模式同理：播放页覆盖其上，传统视图内部导航与已加载歌单原样保留。
  const traditionalKeptAlive = isPlaybackPage && enteredFromMode === 'traditional' && viewMode === 'traditional'
  // 简约模式主页↔播放页在同一分支内共存：主页隐藏不卸载（注意不能用 AnimatePresence
  // 保留退场节点——首页壁纸+多层 backdrop-filter 的合成快照会残留，见下方分支内注释）。
  const minimalHomeKeptAlive = isPlaybackPage && enteredFromMode === 'minimal' && viewMode === 'minimal'
  // 探索页是独立的不透明工作面；从其 mini 播放器进入播放页时，播放页首帧必须完全覆盖探索页。
  // 否则 AnimatePresence 的同步淡入/淡出会把两个页面叠在一起，表现为用户截图中的整屏透底。
  const enteringPlayerFromExplore = isPlaybackPage && enteredFromMode === 'explore'
  const mixingStudioAudio = showMixingStudio ? audioPlayer.getAudioElement() : null

  // 「挂起」= 已挂载但当前不显示（用户切到了别的模式）。与上面的 keptAlive 区别：
  // keptAlive 是播放页覆盖在本模式之上，zIndex 仍是 1；挂起是彻底切走，只隐藏、保留状态。
  // resonance 不参与：它是插件式的房间模式，进出走自己的挂起/退出流程，保持原行为。
  const parkedExplore = visitedModes.has('explore') && renderedMode !== 'explore' && !exploreKeptAlive
  const parkedTraditional = visitedModes.has('traditional') && renderedMode !== 'traditional' && !traditionalKeptAlive
  const parkedMinimal = visitedModes.has('minimal') && renderedMode !== 'minimal'
  const parkedDesktop = visitedModes.has('desktop') && renderedMode !== 'desktop'
  // 暂停重活（光晕/封面墙漂移/频谱绘制）：不可见时这些合成纯属浪费算力。
  const exploreSuspended = exploreKeptAlive || parkedExplore
  const traditionalSuspended = traditionalKeptAlive || parkedTraditional
  const homeSuspended = minimalHomeKeptAlive || parkedMinimal

  // 简约层被挂起时，连带收起它的「顶部歌词样式下拉」（触发按钮与面板，见 playback surface 里的
  // createPortal）。它们 portal 到 body，不受挂起层 visibility:hidden 约束；光靠不渲染能挡住
  // 眼前这一帧，但面板的 open 状态还留着，切回播放页会凭空自己展开一次。
  // 放在这里而不是各条切换路径上：遥控器 Home / 键盘 Home / 模式卡片 / 远程指令都收敛到这一处。
  useEffect(() => {
    if (!parkedMinimal) return
    setShowLyricModePanel(false)
    setShowLyricModeCustomize(false)
    setShowLyricModeArrowHint(false)
  }, [parkedMinimal])

  // ── 详情弹窗 / 个人中心「冻结」────────────────────────────────────────────
  // 关闭时不再卸载、只把 suspended 传给被冻结的组件（组件内部隐藏自身），重开同一 id 时
  // 组件实例与内部 state（页签、分页、列表）原样保留，不会重建 DOM、不会重放加载动画、
  // 不会重发请求；id 真正变化时才换 key 重新挂载（该情况本就该重新取数）。
  // 与 mode-view freeze 同款思路（见上方 parkedExplore/parkedMinimal）。
  const [frozenArtistDetail, setFrozenArtistDetail] = useState<{ id: string | number; platform: MusicPlatform; name: string } | null>(null)
  if (showArtistDetail && selectedArtistId && (!frozenArtistDetail || frozenArtistDetail.id !== selectedArtistId || frozenArtistDetail.platform !== selectedArtistPlatform)) {
    setFrozenArtistDetail({ id: selectedArtistId, platform: selectedArtistPlatform, name: selectedArtistName })
  }
  const [frozenAlbumDetail, setFrozenAlbumDetail] = useState<{ id: string | number; platform: MusicPlatform } | null>(null)
  if (showAlbumDetail && selectedAlbumId && (!frozenAlbumDetail || frozenAlbumDetail.id !== selectedAlbumId || frozenAlbumDetail.platform !== selectedAlbumPlatform)) {
    setFrozenAlbumDetail({ id: selectedAlbumId, platform: selectedAlbumPlatform })
  }
  const [frozenSongDetail, setFrozenSongDetail] = useState<Song | null>(null)
  if (showSongDetail && songDetailSong && (!frozenSongDetail || getSongKey(frozenSongDetail) !== getSongKey(songDetailSong))) {
    setFrozenSongDetail(songDetailSong)
  }
  const [frozenSimilarSongs, setFrozenSimilarSongs] = useState<Song | null>(null)
  if (showSimilarSongs && similarSongsSource && (!frozenSimilarSongs || getSongKey(frozenSimilarSongs) !== getSongKey(similarSongsSource))) {
    setFrozenSimilarSongs(similarSongsSource)
  }
  const [commentModalFrozen, setCommentModalFrozen] = useState(false)
  if (showCommentModal && !commentModalFrozen) setCommentModalFrozen(true)
  const [profileFrozen, setProfileFrozen] = useState(false)
  if (showProfile && (neteaseLoggedIn || qqLoggedIn || appleLoggedIn || sodaLoggedIn) && !profileFrozen) setProfileFrozen(true)

  return (
    <>
      {/* 自定义窗口标题栏 */}
      <TitleBar />

      {/* 遥控器虚拟鼠标 overlay（顶层挂载，任何模式下都可用） */}
      <RemoteCursor />

      {/* 首次平台登录风险提示（自包含，首次登录后弹出一次） */}
      <PlatformLoginNotice playerTheme={playerTheme} />

      {/* OOBE 1（主题/隐私/免责引导）：默认不自动弹出，仅设置→高级 卡片触发 */}
      {(OOBE_ENABLED || oobeOpenCount > 0) && (
        <Suspense fallback={null}>
          <LazyOobeGuide
            key={oobeOpenCount}
            playerTheme={playerTheme}
            enabled={OOBE_ENABLED}
            forceOpen={oobeOpenCount > 0}
          />
        </Suspense>
      )}

      {/* 全局弹层：遥控器 / 歌曲详情（任何模式下都能打开） */}
      <AnimatePresence>
        {showRemote && (
          <Suspense fallback={null}>
            <LazyRemoteControlModal
              key="remote-control"
              onClose={() => setShowRemote(false)}
              playerTheme={playerTheme}
            />
          </Suspense>
        )}
        {showDeviceControl && (
          <Suspense fallback={null}>
            <LazyPlaybackDeviceModal
              key="playback-device"
              show
              onClose={() => setShowDeviceControl(false)}
              playerTheme={playerTheme}
            />
          </Suspense>
        )}
        {frozenSongDetail && (
          <Suspense fallback={null}>
            <LazySongDetailModal
              key={getSongKey(frozenSongDetail)}
              song={frozenSongDetail}
              suspended={!showSongDetail}
              onClose={closeSongDetail}
              playerTheme={playerTheme}
              onPlayNow={viewCallbacks.onSongSelect}
              onOpenPlaylist={(id, platform) => { void handleOpenPlaylistFromDetail(id, platform) }}
              onOpenAlbum={(id, platform) => {
                handleOpenAlbum(id, platform)
              }}
              onOpenArtist={(id, platform) => {
                handleOpenArtist(id, platform)
              }}
              onViewArtistSong={handlePlaybackViewArtist}
              onViewAlbumSong={handlePlaybackViewAlbum}
            />
          </Suspense>
        )}
        {frozenSimilarSongs && (
          <SimilarSongsPanel
            key={getSongKey(frozenSimilarSongs)}
            song={frozenSimilarSongs}
            suspended={!showSimilarSongs}
            onClose={closeSimilarSongs}
            onPlayNow={viewCallbacks.onSongSelect}
            onPlayNext={viewCallbacks.onPlayNext}
            playerTheme={playerTheme}
            songMenu={panelSongMenu}
          />
        )}
        {detailPlaylist && (
          <Suspense fallback={null}>
            <LazyPlaylistDetailPanel
              show={detailPlaylistOpen}
              overlayZ={95}
              playerTheme={playerTheme}
              playlist={detailPlaylist.playlist}
              songs={detailPlaylist.songs}
              loading={detailPlaylistLoading}
              onClose={closeDetailPlaylist}
              onExitComplete={handleDetailPlaylistExitComplete}
              onSongSelect={(song, songs) => {
                // 选歌后关闭歌单详情面板（避免盖在播放页上），并记录歌单来源，
                // home 返回时经 HomeView 恢复同一歌单并自动定位当前歌曲
                closeDetailPlaylistImmediate()
                void handleSongSelect(song, songs, {
                  surface: 'home-playlist',
                  playlist: detailPlaylist.playlist,
                  songs,
                })
              }}
              currentPlatform={detailPlaylist.playlist.platform || 'netease'}
              currentUserId={detailPlaylist.playlist.platform === 'qq' ? qqUserId : neteaseUserId}
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
          </Suspense>
        )}
      </AnimatePresence>

      {/* 渲染器预热遮罩：切换渲染后端重启后常驻此界面。
          阶段一：预编译着色管线（可跳过）；阶段二：预热完成后在同一界面接 30s 体验倒计时，
          用户实测后端流畅度后决定「保留」或「回退到上次模式」。确认/回退/超时才关闭。 */}
      {pendingGpuChange?.type === 'backend' && (
        <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-black/85 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="渲染器预热">
          <div className="w-[min(440px,88vw)] rounded-[26px] border border-white/12 bg-[#0d1220]/97 p-7 text-center shadow-[0_30px_90px_rgba(0,0,0,.65)]">
            {!gpuPreheatDone ? (
              <>
                <div className="relative mx-auto flex h-14 w-14 items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-2 border-white/10"></div>
                  <div className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-white/80"></div>
                  <Sparkles className="h-5 w-5 text-white/80" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">渲染器预热中</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-white/50">
                  正在预编译 WebGL 着色器管线，首次进入动效场景将不再卡顿（约 2 秒）
                </p>
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                  <div className="h-full rounded-full transition-[width] duration-150" style={{ width: `${gpuPreheatProgress}%`, backgroundColor: '#ff5a70' }}></div>
                </div>
                <button
                  type="button"
                  onClick={() => setGpuPreheatDone(true)}
                  className="mt-5 rounded-lg border border-white/12 bg-white/6 px-4 py-2 text-xs font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
                >
                  跳过预热，立即体验
                </button>
              </>
            ) : (
              <>
                <div className="relative mx-auto flex h-14 w-14 items-center justify-center">
                  <div className="absolute inset-0 rounded-full border-2 border-[#ff5a70]/30"></div>
                  <Check className="h-6 w-6 text-[#ff5a70]" />
                </div>
                <h3 className="mt-4 text-base font-semibold text-white">渲染器预热完成</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-white/50">
                  当前生效后端：Vulkan。NVIDIA 下 Vulkan 的视频硬解需跨后端拷贝，
                  持续帧率通常低于 D3D11（系统默认）。接下来进入 30 秒体验期：
                  满意点「保留」；不满意点「回退」，立即恢复为上次模式（D3D11 / 自动）。
                </p>
                <div className="mt-5 flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={() => void confirmGpuChange()}
                    className="rounded-lg bg-[#ff5a70] px-5 py-2 text-sm font-semibold text-white transition hover:brightness-110"
                  >
                    保留此渲染后端
                  </button>
                  <button
                    type="button"
                    onClick={() => void revertGpuChange()}
                    className="rounded-lg border border-white/12 bg-white/6 px-5 py-2 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
                  >
                    回退到上次模式（{gpuConfirmCountdown}）
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* GPU 设置变更确认横幅（渲染后端类型已并入上方预热遮罩，不走横幅） */}
      {pendingGpuChange && pendingGpuChange.type !== 'backend' && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[99999] w-[min(92vw,560px)] pointer-events-auto">
          <div className={`rounded-xl border p-4 shadow-2xl ${playerTheme === 'dark' ? 'bg-[#0b1220]/95 border-red-500/40' : 'bg-white/95 border-red-500/40'}`}>
            <div className={`text-sm font-medium leading-relaxed ${playerTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              {pendingGpuChange.type === 'preference'
                ? '您在此前修改过 GPU 加速设备，若无异常请点击确认，否则将在 30 秒后自动恢复为系统默认显卡'
                : '您在此前关闭了 GPU 加速，若无异常请点击确认，否则将在 30 秒后自动打开 GPU 加速'}
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
      
      {/* 固定背景层 - 防止切换时白屏（桌面模式 + 融合穿透时隐藏，让真实桌面透出） */}
      {!(viewMode === 'desktop' && desktopFusionEnabled) && <div className="fixed inset-0 bg-black" />}

      {/* 桌面融合开启确认弹窗（重建窗口会中断播放/重载界面，先询问用户） */}
      <FusionEnableConfirmModal
        show={showFusionConfirm}
        onClose={() => setShowFusionConfirm(false)}
        onConfirm={() => void confirmEnableFusion()}
      />

      {/* 共振房间里切模式：问一句「挂起还是退出」，别一声不响把房间丢了 */}
      {resonanceExitPrompt && (
        <div className="fixed inset-0 z-[420] flex items-center justify-center bg-black/70 p-6 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label="要离开共振房间吗">
          <div className="w-[min(460px,92vw)] overflow-hidden rounded-[26px] border border-white/12 bg-[#0d1220]/97 p-6 text-white shadow-[0_30px_90px_rgba(0,0,0,.65)]">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-[#ff5a70]/18 text-[#ff8b9a]"><Radio className="h-5 w-5" /></span>
              <div>
                <h3 className="text-base font-semibold">还在一起听房间里</h3>
                <p className="mt-0.5 text-xs text-white/50">切到别的模式前，先决定这个房间怎么处理</p>
              </div>
            </div>
            <div className="mt-5 space-y-2">
              <button
                type="button"
                onClick={() => {
                  const session = getResonanceSession()
                  session.setSuspended(true)
                  setResonanceSuspended(true)
                  const next = resonanceExitPrompt.next
                  setResonanceExitPrompt(null)
                  resonanceModeSwitchBypassRef.current = true
                  window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: next }))
                  addToast('共振已挂起：房间还在，右键歌曲可以「推送至共振」', 'info')
                }}
                className="w-full rounded-2xl border border-white/12 bg-white/6 px-4 py-3 text-left transition hover:bg-white/10"
              >
                <span className="block text-sm font-medium">挂起共振</span>
                <span className="mt-0.5 block text-[11px] text-white/45">房间保留（成员还在），你在别的模式里可以右键把歌推回房间</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const session = getResonanceSession()
                  const wasHost = session.getSnapshot().role === 'host'
                  session.dissolve()
                  setResonanceSuspended(false)
                  const next = resonanceExitPrompt.next
                  setResonanceExitPrompt(null)
                  resonanceModeSwitchBypassRef.current = true
                  window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: next }))
                  addToast(wasHost ? '房间已解散' : '已退出房间', 'info')
                }}
                className="w-full rounded-2xl border border-white/12 bg-white/6 px-4 py-3 text-left transition hover:bg-white/10"
              >
                <span className="block text-sm font-medium">退出共振</span>
                <span className="mt-0.5 block text-[11px] text-white/45">房主退出即解散房间；成员退出只离开自己</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  // 模式选择组件通常会先写 localStorage 再派发事件；取消时要把「共振仍在」写回去
                  localStorage.setItem('viewMode', 'resonance')
                  setResonanceExitPrompt(null)
                }}
                className="w-full rounded-2xl px-4 py-2.5 text-center text-sm text-white/60 transition hover:bg-white/6"
              >
                留在这里（取消）
              </button>
            </div>
          </div>
        </div>
      )}
      
      {/* 全局更新提示（任何视图模式可见；分客户端显示） */}
      <UpdatePrompt playerTheme={playerTheme} />

      {/* 更新中心 + Toast 通知：必须在模式分支之外渲染——四个模式容器是 zIndex:2 的永久层叠
          上下文，更新中心弹窗(z-300)困在里面会被任何根级浮层盖住，且 explore/desktop/traditional
          三模式下整个不渲染（toast/更新提示静默丢失）。portal 挂 body 保证在所有弹窗（含插件控制台）之上 */}
      <UpdateManager />
      {createPortal(
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
        </div>,
        document.body,
      )}

      {/* 引擎切换右上角小弹窗（2s 后淡出）。同样移出模式分支：fixed 定位困在 zIndex:2
          上下文里会被根级浮层盖住，且非 minimal 模式下不渲染 */}
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

      {/* #10 Gapless 方案弹窗（切歌完成时提示本次衔接方案，2.5s 后淡出） */}
      <GaplessModeToast message={gaplessModeToast} playerTheme={playerTheme} />

      {/* 过渡调试弹窗（受「过渡调试」开关控制；top-28 与 Gapless 弹窗错位，二者可能同时出现） */}
      <TransitionDebugToast info={transitionDebugToast} playerTheme={playerTheme} />


      {/* 模式切换过渡动画：顶层常驻（不在任何模式容器内），切到任何模式都能覆盖显示 */}
      <ModeTransitionOverlay
        mode={modeTransition?.to ?? null}
        theme={playerTheme}
        variant={modeTransitionStyle}
        quick={modeTransition?.quick === true}
        sound={modeTransitionSoundOn}
      />
      
      <Suspense fallback={null}><AnimatePresence initial={false} mode="sync" presenceAffectsLayout={false}>
        {/* 桌面模式 */}
        {(renderedMode === 'explore' || exploreSuspended) && (
          <motion.div
            key="explore-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 h-full w-full"
            style={modeLayerStyle({ suspended: exploreSuspended })}
            data-wf-suspended={modeLayerSuspendedAttr(exploreSuspended)}
          >
            <ModeParkedContext.Provider value={exploreSuspended}>
            {/* 探索页被播放页覆盖/或非当前模式时整页不可见：冻结作用域让封面只留 1×1 占位，
                释放已解码位图（实测多平台浏览后隐藏面板里躺着 569 张已解码封面，
                渲染进程 3.8GB）。返回时按原来的 src 从缓存重新解码，不重新下载。 */}
            <FrozenScope.Provider value={exploreSuspended}>
            <LazyExploreView
              motionSuspended={exploreSuspended}
              suspended={exploreSuspended}
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              currentSong={currentSong}
              isPlaying={isPlaying}
              playbackTimeStore={audioPlayer.playbackTimeStore}
              duration={duration}
              volume={volume}
              currentLyric={currentMiniLyric}
              accentColor={playbackCoverColor}
              playerTheme={playerTheme}
              authRevision={authRevision}
              platformEntitlements={platformEntitlements}
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
              onLoginClick={handleMinimalLogin}
              onProfileClick={handleViewProfileClick}
              onOpenUserProfile={viewCallbacks.onOpenUserProfile}
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

            </FrozenScope.Provider>
            </ModeParkedContext.Provider>
          </motion.div>
        )}
        {(renderedMode === 'desktop' || parkedDesktop) && (
          <motion.div
            key="desktop-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 w-full h-full"
            style={modeLayerStyle({ suspended: parkedDesktop })}
            data-wf-suspended={modeLayerSuspendedAttr(parkedDesktop)}
          >
            <ModeParkedContext.Provider value={parkedDesktop}>
            <LazyDesktopView
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              currentSong={currentSong}
              isPlaying={isPlaying}
              playbackTimeStore={audioPlayer.playbackTimeStore}
              desktopFusionEnabled={desktopFusionEnabled}
              suspended={parkedDesktop}
              onDesktopFusionChange={handleDesktopFusionChange}
              authRevision={authRevision}
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
              onAppleLoginClick={openAppleLogin}
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
              onOpenDeviceControl={viewCallbacks.onOpenDeviceControl}
            />
            </ModeParkedContext.Provider>
          </motion.div>
        )}
        {renderedMode === 'resonance' && (
          <motion.div
            key="resonance-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 h-full w-full"
            style={modeLayerStyle({ suspended: false })}
          >
            <ModeParkedContext.Provider value={false}>
            {/* 共振：房间状态在会话单例里，模式切换不会丢房间；播放由房主权威状态驱动 */}
            <LazyResonanceView
              playerTheme={playerTheme}
              platforms={resonancePlatforms}
              identityCandidates={[
                // 只把「确实登录了 + 有账号名」的平台当身份候选：
                // 登出后 localStorage 里的旧昵称不该继续冒充可用身份
                ...(neteaseLoggedIn ? [{ platform: 'netease' as MusicPlatform, nickname: neteaseUsername || '', avatarUrl: neteaseAvatar || '' }] : []),
                ...(qqLoggedIn ? [{ platform: 'qq' as MusicPlatform, nickname: qqUsername || '', avatarUrl: qqAvatar || '' }] : []),
                ...(appleLoggedIn ? [{ platform: 'apple' as MusicPlatform, nickname: appleUsername || '', avatarUrl: appleAvatar || '' }] : []),
                ...(spotifyLoggedIn ? [{ platform: 'spotify' as MusicPlatform, nickname: spotifyUsername || '', avatarUrl: spotifyAvatar || '' }] : []),
                ...(kugouLoggedIn ? [{ platform: 'kugou' as MusicPlatform, nickname: kugouUsername || '', avatarUrl: kugouAvatar || '' }] : []),
                ...(sodaLoggedIn ? [{ platform: 'soda' as MusicPlatform, nickname: sodaUsername || '', avatarUrl: sodaAvatar || '' }] : []),
              ]}
              userIds={resonanceUserIds}
              usernames={resonanceUsernames}
              createAdapter={createResonanceAdapter}
              nowPlaying={{ song: currentSong, positionMs: currentTime, playing: isPlaying }}
              onSelectMode={mode => window.dispatchEvent(new CustomEvent('viewModeChanged', { detail: mode }))}
            />
            </ModeParkedContext.Provider>
          </motion.div>
        )}
        {(renderedMode === 'traditional' || traditionalSuspended) && (
          <motion.div
            key="traditional-mode"
            initial={{ opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 w-full h-full"
            style={modeLayerStyle({ suspended: traditionalSuspended })}
            data-wf-suspended={modeLayerSuspendedAttr(traditionalSuspended)}
          >
            <ModeParkedContext.Provider value={traditionalSuspended}>
            <LazyTraditionalView
              onSongSelect={viewCallbacks.onSongSelect}
              restorePlaybackOrigin={restorePlaybackOrigin}
              currentSong={currentSong}
              queue={playlist}
              currentIndex={currentIndex}
              isPlaying={isPlaying}
              live={isLive || currentAppleRadio?.timeline === 'live'}
              playbackTimeStore={audioPlayer.playbackTimeStore}
              dominantColor={dominantColor}
              analyzerStore={audioAnalyzer}
              duration={duration}
              lyrics={lyrics}
              volume={volume}
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
              spotifyLoggedIn={spotifyLoggedIn}
              spotifyUserId={spotifyUserId}
              spotifyUsername={spotifyUsername}
              spotifyAvatar={spotifyAvatar}
              kugouLoggedIn={kugouLoggedIn}
              kugouUserId={kugouUserId}
              kugouUsername={kugouUsername}
              kugouAvatar={kugouAvatar}
              sodaLoggedIn={sodaLoggedIn}
              sodaUserId={sodaUserId}
              sodaUsername={sodaUsername}
              sodaAvatar={sodaAvatar}
              onLoginClick={handleTraditionalLogin}
              onProfileClick={handleViewProfileClick}
              onSearchClick={viewCallbacks.onSearchClick}
              onSettingsClick={viewCallbacks.onSettingsClick}
              liked={currentSongLiked}
              onToggleFavorite={viewCallbacks.onToggleFavorite}
              playMode={playMode}
              onPlayModeChange={viewCallbacks.onPlayModeChange}
              onOpenMixingStudio={viewCallbacks.onOpenMixingStudio}
              onOpenPlayer={viewCallbacks.onOpenPlayer}
              onPlayPause={viewCallbacks.onPlayPause}
              onNext={viewCallbacks.onNext}
              onPrevious={viewCallbacks.onPrevious}
              onSeek={viewCallbacks.onSeek}
              onVolumeChange={viewCallbacks.onVolumeChange}
              onOpenArtist={viewCallbacks.onOpenArtist}
              onOpenAlbum={viewCallbacks.onOpenAlbum}
              onPlayNext={viewCallbacks.onPlayNext}
              onAddToFavorites={viewCallbacks.onAddToFavorites}
              onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
              onAddToPlaylist={viewCallbacks.onAddToPlaylist}
              onViewComments={viewCallbacks.onViewComments}
              onCopyInfo={viewCallbacks.onCopyInfo}
              suspended={traditionalSuspended}
            />
            </ModeParkedContext.Provider>
          </motion.div>
        )}
        {(renderedMode === 'minimal' || exploreKeptAlive || parkedMinimal) && (
          /* 简约模式 */
          <motion.div
            key="minimal-mode"
            initial={enteringPlayerFromExplore ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 26, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -18, scale: 1.012 }}
            transition={enteringPlayerFromExplore ? { duration: 0 } : { duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 h-screen w-full flex items-center justify-center overflow-hidden bg-black"
            // 本层自带不透明黑底（bg-black）且 DOM 顺序在其它模式层之后，挂起时若不隐藏，
            // 它会盖住传统/探索/桌面并吞掉点击——挂起样式必须走 modeLayerStyle。
            style={modeLayerStyle({ suspended: parkedMinimal, overlayAbove: exploreKeptAlive })}
            data-wf-suspended={modeLayerSuspendedAttr(parkedMinimal)}
          >
            <ModeParkedContext.Provider value={parkedMinimal}>

      {/* 默认背景 - 始终存在 */}
      <div 
        className="absolute inset-0"
        style={{
          background: getBackgroundStyle()
        }}
      />

      {/* 背景层：封面常驻最底兜底，MV 叠其上（加载期间 MV 层透明露出封面，就绪后渐入） */}
      <div className="absolute inset-0">
        {currentSong && lyricDisplayMode !== 'video' && (
          <PulsingCrossfadeBackground
            coverUrl={displayCoverUrl}
            transitionFromUrl={transitionFromTrack?.coverUrl}
            transitionToUrl={transitionToTrack?.coverUrl}
            isTransitioning={isVisualTransitioning}
            // 与 MV 背景共用 overlayProgress：它是从动画窗口起点重新归一化的 0→1，
            // 窗口开启瞬间恰好为 0，不会把过渡中段的进度硬跳上去。裸 transitionProgress
            // 的原点是音频过渡起点，窗口晚开时会一次性跳到 (dur-lead)/dur（AI 路径达 0.67）。
            transitionProgress={overlayProgress}
            // 视觉轨道：整页背景层的交叉淡化也吃逐帧进度（只重渲染它，不再 10fps 台阶）
            transitionVisualStore={audioPlayer.transitionVisualStore}
            pulseStore={audioPulseStore}
            backgroundEffect={backgroundEffect}
            backgroundBlur={backgroundBlur}
            isPlaying={isPlaying}
            playerTheme={playerTheme}
          />
        )}
        {/* 电台/播客不挂 MV 图层（与 mvBackgroundActive 同一判断，避免"歌词页透明等 MV"的黑屏） */}
        {currentSong && !mvBackgroundSuppressed && (
          <LazyBilibiliMvBackground
            songTitle={currentSong.name}
            songArtists={currentSongArtists}
            songDuration={(currentSong.duration || 0) / 1000}
            platform={currentSong.platform}
            songId={currentSong.id || currentSong.mid}
            songAlbum={currentSong.album?.name}
            isPlaying={isPlaying}
            getAudioElement={getMvAudioElementStable}
            getPlaybackTimeSeconds={getMvPlaybackTimeSecondsStable}
            getTransitionTargetTimeSeconds={getMvTransitionTargetTimeSecondsStable}
            playerTheme={playerTheme}
            upcomingSongs={watchUpcomingSongs}
            enabled={mvBackgroundEnabled && !mvBackgroundSuppressed}
            // 「被外部表面完全遮挡」时隐藏 + 暂停（display:none + pause），但**保留**已缓冲的视频
            // 与搜索/staged 状态：恢复时直接续播同一视频，不重新搜索/拉流，并由组件内的
            // returningFromHidden 分支做一次硬同步到音频位置——这正是「看歌↔歌词页来回切能无缝
            // 接上、且 MV 实时对准」所依赖的机制。
            //   · lyricDisplayMode === 'video'：看歌表面接管
            //   · showHome：简约首页接管。首页根节点是 .home-view-root（background:#09090b 不透明）
            //     且 MV 层在其下方，此时 MV 完全不可见却仍在全速解码 1080P——纯浪费。
            //     用同一个 hidden 通道而不是另造机制，才能保住「切回来无缝 + 实时对准」。
            //   · parkedMinimal：整个简约层已被挂起隐藏（见本层容器的 modeLayerStyle），
            //     同属「完全不可见」，一并走 hidden 通道停掉解码。
            //   · gameModeFrozen：游戏模式已把主窗隐藏到托盘——整块画面都不可见，
            //     但 1080P 视频解码 + 1.5s 对齐轮询不会因窗口隐藏自动停，必须一起冻结；
            //     解冻时组件内的 returningFromHidden 分支会自动硬同步回音频位置。
            hidden={lyricDisplayMode === 'video' || showHome || parkedMinimal || gameModeFrozen}
            lyrics={lyrics}
            blur={mvBackgroundBlur}
            transitionToTrack={transitionToTrack}
            // 封面过渡只在过渡动画窗口内叠加（用户要求：从过渡动画开始，不是 automix 介入），
            // 且叠加只在最后 4 秒完成（不拖沓）
            transitionProgress={overlayProgress}
            // 视觉轨道：逐帧进度直达 MV 层（只重渲染它），目标 MV 渐入不再有整树节流台阶
            transitionVisualStore={audioPlayer.transitionVisualStore}
            songTrackKey={currentSong ? getSongKey(currentSong) : ''}
            onFallbackChange={setMvBackgroundFallback}
            onReadyChange={setMvBackgroundReady}
            onPlayStateChange={handleMvBackgroundPlayStateChange}
          />
        )}
            {/* 渐变遮罩层 */}
            <div 
              className="absolute inset-0 bg-gradient-to-b transition-all duration-500 pointer-events-none"
              style={{
                backgroundImage: playerTheme === 'dark'
                  ? backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.05), rgba(0,0,0,0.05), rgba(0,0,0,0.05))'  // 深色透明模式增加5%白色叠加
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0.55), rgba(0,0,0,0.7))'  // 深色模糊：中等压暗
                    : backgroundEffect === 'modern'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.42), rgba(0,0,0,0.3), rgba(0,0,0,0.48))'  // 摩登流体：背景自身已压暗，这里只补一点均匀压暗
                    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.6) 100%)'  // 深色沉浸：强压暗+渐变
                  : backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0.05), rgba(255,255,255,0.05))'  // 浅色透明模式增加5%黑色叠加
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(250,250,248,0.42), rgba(250,250,248,0.32), rgba(250,250,248,0.46))'  // 浅色模糊：明显白雾
                    : backgroundEffect === 'modern'
                    ? 'linear-gradient(to bottom, rgba(250,250,248,0.4), rgba(250,250,248,0.3), rgba(250,250,248,0.44))'  // 浅色摩登流体：中等白雾保证可读
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

      {/* 主内容容器层 */}
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
          onOpenRemote: openRemote,
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

        {/* 主内容区 */}
        <div className="relative flex-1 flex items-center justify-center overflow-hidden">
          {/* 看歌模式：视频播放器常驻挂载（回主页/探索也继续播，迷你播放器/桌面小窗按视频进度控制它；
              无重跳——视频从未卸载，进度不丢失） */}
          {currentSong && lyricDisplayMode === 'video' && (() => {
            const currentWatchSongKey = bilibiliSongKeyOf({
              songTitle: currentSong.name,
              artists: currentSong.artists.map((artist: any) => artist.name),
              songDuration: (currentSong.duration || 0) / 1000,
              platform: currentSong.platform,
              id: currentSong.id || currentSong.mid,
            })
            const currentWatchSeek = readSongOwnedHandoff(watchSyncSeek, currentWatchSongKey, 0)
            const currentInitialVideo = readSongOwnedHandoff(watchInitialVideo, currentWatchSongKey, null)
            // 当前歌是否有模式切换交接：有 → 引擎淡出期间可跟随实时位置；
            // 无（冷启动看歌开播/看歌内切歌）→ 播放器必须从歌曲起点 0 开始。
            const engineHandoffActive = Number.isFinite(readSongOwnedHandoff(watchSyncSeek, currentWatchSongKey, Number.NaN))
            return (
            <div className={`absolute inset-0 ${showHome ? 'z-0' : 'z-10'}`} data-watch-surface>
              <LazyBilibiliMvPlayer
                ref={watchPlayerRef}
                songTitle={currentSong.name}
                songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                songArtists={currentSong.artists.map((artist: any) => artist.name)}
                songDuration={(currentSong.duration || 0) / 1000}
                coverUrl={displayCoverUrl}
                platform={currentSong.platform}
                songId={currentSong.id || currentSong.mid}
                songAlbum={currentSong.album?.name}
                playerTheme={playerTheme}
                onNext={handleNext}
                onPrevious={handlePrevious}
                onBackToAudio={() => handleLyricDisplayModeChange('modern')}
                onVideoActiveChange={setWatchVideoActive}
                onSearchFailedChange={setWatchSearchFailed}
                volume={volume}
                onVideoStateChange={(state: { playing: boolean; time: number; duration: number; volume: number; alignmentOffset?: number; alignmentVerified?: boolean }) => {
                  setWatchVideoState({
                    playing: state.playing,
                    time: state.time,
                    duration: state.duration,
                    volume: state.volume,
                    alignmentOffset: state.alignmentOffset ?? 0,
                    alignmentVerified: state.alignmentVerified ?? false,
                  })
                  if (state.alignmentVerified && Number.isFinite(state.time) && state.time > 0) {
                    const songKey = currentSong ? bilibiliSongKeyOf({
                      songTitle: currentSong.name,
                      artists: currentSong.artists.map((artist: any) => artist.name),
                      songDuration: (currentSong.duration || 0) / 1000,
                      platform: currentSong.platform,
                      id: currentSong.id || currentSong.mid,
                    }) : ''
                    if (songKey) modeHandoffTimeRef.current = {
                      songKey,
                      time: Math.max(0, state.time - (state.alignmentOffset ?? 0)),
                    }
                  }
                  // 看歌里调音量 → 同步全局音量（其它播放模式跟随）
                  if (typeof state.volume === 'number' && state.volume >= 0 && state.volume <= 1) {
                    setVolume(state.volume)
                  }
                }}
                onHomeClick={handlePlayerHome}
                onOpenPlaylist={() => setShowPlaylist(true)}
                onToggleFavorite={() => { void handlePlaybackToggleFavorite(currentSong, currentSongLiked) }}
                liked={currentSongLiked}
                upcomingSongs={watchUpcomingSongs}
                initialSeekSeconds={currentWatchSeek}
                songUrl={audioPlayerRef.current?.getAudioElement?.()?.src || ''}
                initialVideoUrl={currentInitialVideo?.videoUrl}
                initialCid={currentInitialVideo?.cid}
                initialBvid={currentInitialVideo?.bvid}
                initialCacheKey={currentInitialVideo?.cacheKey}
                initialType={currentInitialVideo?.type}
                getEnginePosition={() => Number(audioPlayerRef.current?.getAudioElement?.()?.currentTime) || 0}
                engineHandoffActive={engineHandoffActive}
                // 游戏模式冻结（主窗隐藏到托盘）时也走 surfaceVisible=false：该分支只暂停视频解码，
                // DASH 音频继续当播放源（歌照放），解冻时会自动 syncWatchVideoOnSurfaceRestore 回到音画同帧
                surfaceVisible={!showHome && lyricDisplayMode === 'video' && !gameModeFrozen}
              />
            </div>
            )
          })()}
          {/* 首页包含整屏壁纸、多个 backdrop-filter 与独立合成层。这里不能使用
              AnimatePresence 保留退出节点：冷启动首次播放时 Chromium 偶发把首页
              合成快照永久留在播放页上。直接替换节点可以确保首页当帧卸载；新页面
              自身的 initial/animate 仍提供完整入场过渡。 */}
          {(!currentSong || showHome || minimalHomeKeptAlive || parkedMinimal) && (
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
              style={{ willChange: 'transform, opacity, filter', visibility: homeSuspended ? 'hidden' : 'visible', zIndex: 0 }}
              data-wf-suspended={homeSuspended ? '' : undefined}
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
              onAppleLoginClick={openAppleLogin}
              onAppleLogout={handleAppleLogout}
              spotifyLoggedIn={spotifyLoggedIn}
              spotifyUsername={spotifyUsername}
              spotifyAvatar={spotifyAvatar}
              spotifyUserId={spotifyUserId}
              kugouLoggedIn={kugouLoggedIn}
              kugouUsername={kugouUsername}
              kugouAvatar={kugouAvatar}
              kugouUserId={kugouUserId}
              onKugouLogout={viewCallbacks.onKugouLogout}
              sodaLoggedIn={sodaLoggedIn}
              sodaUsername={sodaUsername}
              sodaAvatar={sodaAvatar}
              sodaUserId={sodaUserId}
              onSodaLogout={viewCallbacks.onSodaLogout}
              onSpotifyLogout={viewCallbacks.onSpotifyLogout}
              onNeteaseLoginClick={viewCallbacks.onNeteaseLoginClick}
              onQQLoginClick={viewCallbacks.onQQLoginClick}
              onAppleProfileClick={openAppleLogin}
              onLoginClick={handleMinimalLogin}
              onSearchClick={viewCallbacks.onSearchClick}
              onRemoteClick={viewCallbacks.onRemoteClick}
              onOpenDeviceControl={viewCallbacks.onOpenDeviceControl}
              onSettingsClick={viewCallbacks.onSettingsClick}
              onProfileClick={viewCallbacks.onProfileClick}
              onOpenUserProfile={viewCallbacks.onOpenUserProfile}
              onOpenArtist={viewCallbacks.onOpenArtist}
              onOpenAlbum={viewCallbacks.onOpenAlbum}
              onPlayNext={viewCallbacks.onPlayNext}
              onAddToFavorites={viewCallbacks.onAddToFavorites}
              onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
              onAddToPlaylist={viewCallbacks.onAddToPlaylist}
              onViewComments={viewCallbacks.onViewComments}
              onCopyInfo={viewCallbacks.onCopyInfo}
              accentColor={playbackCoverColor}
              currentSong={currentSong}
              playerTheme={playerTheme}
              suspended={homeSuspended}
            />
            </motion.div>
          )}
          {currentSong && !showHome && (
            <motion.div
              key="minimal-playback-surface"
              initial={{ opacity: 0, y: 24, scale: 0.985, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.46, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-0 w-full h-full flex flex-col"
              style={{ willChange: 'transform, opacity, filter' }}
              ref={(el) => { playbackSurfaceRef.current = el; playbackCursorHideRef(el) }}
              data-waveforge-playback-page="true"
            >
              <LazyPlaybackRadialMenu
                song={currentSong}
                accentColor={playbackCoverColor}
                liked={currentSongLiked}
                userPlaylists={playbackContextPlaylists}
                playlistsLoading={playbackContextPlaylistsLoading}
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
                showMusicPreference={radarPlaybackActive}
                onOpenMusicPreference={() => setQQMusicPreferenceOpen(true)}
              />
              {/* 全局控制按钮 - 各歌词模式按自己的版式取变体：
                  沉浸 = left（右上角整组控件：顶部收起箭头 + 按钮列，弹框出现时整组避让）；
                  现代 = slab（与沉浸同一套"整列收进一块玻璃板"的形态，但保留自己原来的位置：
                  无收起箭头、无弹框避让、容器 right-0 而行 right-6）；
                  墙纸 = compact（相纸下方小横向条）；辉煌 = glorious（竖版封面卡片下方小横向条，锚点由 GloriousLyrics 提供）；
                  其余（folia / pv / 多维）= default（右上角各自独立的玻璃圆钮，**不要动**）。
                  看歌正常播放时由播放器内部控件接管；真正无视频/失败时经 MaybePortal 恢复全局入口；
                  摩登模式改用自身左下角页脚控件，全局入口不渲染。
                  电台/播客各自的播放页是独立设计（自带返回、播放、音量、设置），
                  这里不再叠加歌词页的悬浮控件——否则会出现「右上角主页/设置/音效」
                  这类与电台页重复且语义不符的入口。 */}
              {((lyricDisplayMode !== 'video' && lyricDisplayMode !== 'modeng') || watchSearchFailed)
                && !isAppleRadioPlayback && !podcastPlayback && !appleRadioSurfaceLocked && (
              <MaybePortal active={lyricDisplayMode === 'video' && !parkedMinimal}>
                <LazyImmersiveControls
                  coverColor={playbackCoverColor}
                  variant={
                    lyricDisplayMode === 'immersive'
                      ? 'left'
                      : lyricDisplayMode === 'modern'
                        ? 'slab'
                        : lyricDisplayMode === 'wallpaper'
                          ? 'compact'
                          : lyricDisplayMode === 'glorious'
                            ? 'glorious'
                            : 'default'
                  }
                  onHomeClick={handlePlayerHome}
                  hideHome={lyricDisplayMode === 'modeng'}
                onOpenMixingStudio={(anchorRect) => {
                  if (anchorRect) {
                    mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                  }
                  setShowMixingStudio(true)
                }}
                onTranslationToggle={handleTranslationToggle}
                translationEnabled={translationEnabled}
                hasTranslation={lyricDisplayMode !== 'video' ? hasTranslation : false}
                onRomanToggle={handleRomanToggle}
                romanEnabled={romanEnabled}
                hasRoman={lyricDisplayMode !== 'video' ? hasRoman : false}
                onMvBackgroundToggle={podcastPlayback || isAppleRadioPlayback || appleRadioSurfaceLocked ? undefined : handleMvBackgroundToggle}
                mvBackgroundEnabled={mvBackgroundEnabled && !podcastPlayback && !isAppleRadioPlayback && !appleRadioSurfaceLocked}
                playerTheme={playerTheme}
                isPureMusic={pureMusicPlayback}
                stemControl={currentSong?.platform !== 'apple' ? playerStemControl : undefined}
              />
              </MaybePortal>
              )}

              {/* 顶部中央歌词模式切换：createPortal 挂到 body，逃出 minimal-playback-surface 的
                  transform 层叠上下文——否则在看歌模式下会被 data-watch-surface(z-10) 盖住，无法 hover。
                  但挂起（简约层不是当前显示的面）时必须连 portal 一起收起来：portal 挂在 body 上，
                  不受挂起层 visibility:hidden 的约束，留在原地会盖在桌面/探索/传统模式的顶部，
                  表现为「顶部下拉切模式，出来的却是歌词样式」。 */}
              {!pureMusicPlayback && !isAppleRadioPlayback && !parkedMinimal && createPortal((
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
                      {(isLyricModeTopHovered || showLyricModeArrowHint || (isTvModeActive() && !remoteCursorModeActive)) && !showLyricModePanel && (
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
                      // timer 收进 ref：快速反复开关面板时先清旧的，避免累积多个定时器
                      if (lyricArrowHintTimerRef.current !== null) window.clearTimeout(lyricArrowHintTimerRef.current)
                      lyricArrowHintTimerRef.current = window.setTimeout(() => setShowLyricModeArrowHint(false), 1800)
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
                          if (!showLyricModeCustomize && !showFoliaTuning) return
                          // 两个弹层都带 data-lyric-mode-customize：点在弹层内部不关闭
                          if ((event.target as HTMLElement).closest('[data-lyric-mode-customize]')) return
                          setShowLyricModeCustomize(false)
                          setShowFoliaTuning(false)
                        }}
                      >
                        <div className={`relative h-[22vh] backdrop-blur-xl overflow-hidden ${playerTheme === 'dark' ? 'bg-black/40' : 'bg-white/55'}`}>
                          <div className="h-full flex flex-col items-center justify-center px-8 py-6">
                            <div className="w-full max-w-5xl flex flex-col items-center h-full">
                              {lyricPanelPage === 'waveforge' ? (
                                <>
                                  <h2 className={`text-xl font-bold mb-4 text-center ${playerTheme === 'dark' ? 'text-white' : 'text-black/90'}`}>歌词显示</h2>
                                  <div
                                    className="grid w-full gap-3"
                                    style={{ gridTemplateColumns: `repeat(${orderedLyricModeTiles.length}, minmax(0, 1fr))` }}
                                  >
                                    {orderedLyricModeTiles.map(({ mode, label, background }) => (
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
                                          boxShadow: lyricDisplayMode === mode ? `0 0 18px ${(playbackCoverColor)}35` : 'none',
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
                                </>
                              ) : (
                                <>
                                  {/* 设计来源那行移到标题右侧同一基线：原来它单独占一行，
                                      14 个样式挤在一行横格里 —— 现在横向滚动，一屏 8 个 + 第 9 个露出一点 */}
                                  <div className="mb-3 flex w-full items-baseline justify-center gap-2">
                                    <h2 className={`text-xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black/90'}`}>Folia 歌词</h2>
                                    <span className={`text-[11px] ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/40'}`}>
                                      {visibleFoliaStyleEntries.length} 种歌词视觉 · 设计来源 Project Folia
                                    </span>
                                  </div>
                                  <HorizontalShelf
                                    ariaLabel="Folia 歌词样式"
                                    className="w-full"
                                    viewportClassName="gap-2"
                                    // 一屏 8 个 + 第 9 个露出约 30px（8.3 分法），提示右侧还有内容
                                    itemClassName="w-[calc((100%-3.65rem)/8.3)] shrink-0"
                                  >
                                    {visibleFoliaStyleEntries.map((style) => {
                                      const active = lyricDisplayMode === 'folia' && foliaStyle === style.id
                                      // 绘光需要 WebGL：不支持时灰掉并标明原因，而不是点了之后抛错
                                      const unsupported = style.id === 'lumiere' && !lumiereSupported
                                      return (
                                        <motion.button
                                          type="button"
                                          key={style.id}
                                          disabled={unsupported}
                                          title={unsupported ? '绘光需要 WebGL，当前环境不可用' : undefined}
                                          whileHover={unsupported ? undefined : { scale: 1.06 }}
                                          whileTap={unsupported ? undefined : { scale: 0.94 }}
                                          onClick={() => handleFoliaStyleSelect(style.id)}
                                          className={`relative h-20 w-full rounded-xl overflow-hidden border-2 transition-all ${unsupported ? 'cursor-not-allowed opacity-40 grayscale' : 'cursor-pointer'}`}
                                          style={{
                                            background: style.gradient,
                                            borderColor: active ? '#fff' : 'rgba(255,255,255,0.2)',
                                            boxShadow: active ? `0 0 16px ${(playbackCoverColor)}40` : 'none',
                                          }}
                                        >
                                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-1">
                                            <span className="text-white font-medium text-sm leading-none truncate max-w-full">{style.zhName}</span>
                                            <span className="text-white/50 text-[9px] leading-none truncate max-w-full">{style.id}</span>
                                          </div>
                                          {active && (
                                            <div className="absolute top-1.5 right-1.5 bg-white/20 backdrop-blur-sm px-1.5 py-0.5 rounded-full text-[10px] text-white">
                                              当前
                                            </div>
                                          )}
                                          {unsupported && (
                                            <div className="absolute bottom-1 left-0 right-0 text-center text-[9px] text-white/80">需要 WebGL</div>
                                          )}
                                        </motion.button>
                                      )
                                    })}
                                  </HorizontalShelf>
                                </>
                              )}
                            </div>
                          </div>
                          {/* Folia 参数面板：只在当前样式声明了设置面板时出现（注册表驱动） */}
                          {foliaStyleHasPanel && (
                            <button
                              type="button"
                              aria-label="Folia 歌词参数"
                              title={`${FOLIA_STYLES.find(style => style.id === foliaStyle)?.zhName ?? foliaStyle} 参数`}
                              data-lyric-mode-customize
                              onClick={(event) => {
                                event.stopPropagation()
                                setShowLyricModeCustomize(false)
                                setShowFoliaTuning((value) => !value)
                              }}
                              className={`absolute bottom-4 right-44 z-30 flex h-9 w-9 items-center justify-center rounded-full border transition-[background-color,color] ${
                                showFoliaTuning
                                  ? 'border-transparent text-white'
                                  : playerTheme === 'dark'
                                    ? 'border-white/15 bg-white/[0.08] text-white/85 hover:bg-white/[0.16] hover:text-white'
                                    : 'border-black/10 bg-black/[0.06] text-black/70 hover:bg-black/[0.12] hover:text-black'
                              }`}
                              style={showFoliaTuning ? { backgroundColor: playbackCoverColor, boxShadow: `0 0 12px ${playbackCoverColor}55` } : undefined}
                            >
                              <SlidersHorizontal className="h-[18px] w-[18px]" />
                            </button>
                          )}
                          {/* Folia 歌词样式页切换：自定义按钮左侧，一键切到第二页（12 种 Folia 样式） */}
                          <button
                            type="button"
                            aria-label="Folia 歌词样式"
                            title="Folia 歌词样式（设计来源 Project Folia）"
                            onClick={(event) => {
                              event.stopPropagation()
                              setShowFoliaTuning(false)
                              setLyricPanelPage((page) => (page === 'waveforge' ? 'folia' : 'waveforge'))
                            }}
                            className={`absolute bottom-4 z-30 flex h-9 w-9 items-center justify-center rounded-full border transition-[background-color,color] ${
                              lyricPanelPage === 'folia' ? 'right-32' : 'right-20'
                            } ${
                              lyricPanelPage === 'folia'
                                ? 'border-transparent text-white'
                                : playerTheme === 'dark'
                                  ? 'border-white/15 bg-white/[0.08] text-white/85 hover:bg-white/[0.16] hover:text-white'
                                  : 'border-black/10 bg-black/[0.06] text-black/70 hover:bg-black/[0.12] hover:text-black'
                            }`}
                            style={lyricPanelPage === 'folia' ? { backgroundColor: playbackCoverColor, boxShadow: `0 0 12px ${playbackCoverColor}55` } : undefined}
                          >
                            <Sparkles className="h-[18px] w-[18px]" />
                          </button>
                          {/* Folia 背景按钮：仅 Folia 样式页显示；开 = Folia 原生背景（封面取色），关 = WaveForge 封面背景 */}
                          {lyricPanelPage === 'folia' && (
                            <button
                              type="button"
                              aria-label="使用 Folia 背景"
                              title={foliaBackgroundEnabled ? '使用 Folia 背景（点击改用封面背景）' : '使用 WaveForge 封面背景（点击改用 Folia 背景）'}
                              onClick={(event) => {
                                event.stopPropagation()
                                handleFoliaBackgroundToggle()
                              }}
                              className={`absolute bottom-4 right-20 z-30 flex h-9 w-9 items-center justify-center rounded-full border transition-[background-color,color] ${
                                foliaBackgroundEnabled
                                  ? 'border-transparent text-white'
                                  : playerTheme === 'dark'
                                    ? 'border-white/15 bg-white/[0.08] text-white/85 hover:bg-white/[0.16] hover:text-white'
                                    : 'border-black/10 bg-black/[0.06] text-black/70 hover:bg-black/[0.12] hover:text-black'
                              }`}
                              style={foliaBackgroundEnabled ? { backgroundColor: playbackCoverColor, boxShadow: `0 0 12px ${playbackCoverColor}55` } : undefined}
                            >
                              <ImageIcon className="h-[18px] w-[18px]" />
                            </button>
                          )}
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
                              <p className={`px-2 pb-1.5 pt-1 text-[11px] font-semibold tracking-[0.08em] ${playerTheme === 'dark' ? 'text-white/55' : 'text-black/50'}`}>
                                {lyricPanelPage === 'folia' ? '显示 / 隐藏歌词样式' : '显示 / 隐藏歌词模式'}
                              </p>
                              {/* 列表高度封顶并可滚动：Folia 侧最多 14 项，不封顶会顶出屏幕 */}
                              <div ref={menuListRef} className="max-h-[52vh] overflow-y-auto">
                                {lyricModeMenuEntries.map((entry) => (
                                  <div
                                    key={entry.id}
                                    data-menu-row={entry.id}
                                    className={`flex items-center gap-0.5 rounded-xl transition-colors ${menuDraggingId === entry.id ? (playerTheme === 'dark' ? 'bg-white/[0.12]' : 'bg-black/[0.08]') : ''}`}
                                  >
                                    {/* 拖拽把手 + 上/下移：拖拽靠指针事件，上下移保证键盘/触屏也能排序 */}
                                    <button
                                      type="button"
                                      aria-label={`拖动排序：${entry.label}`}
                                      title="拖动排序"
                                      onPointerDown={(event) => handleMenuGripPointerDown(event, entry.id)}
                                      onPointerMove={handleMenuGripPointerMove}
                                      onPointerUp={endMenuGripDrag}
                                      onPointerCancel={endMenuGripDrag}
                                      className={`flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md active:cursor-grabbing ${playerTheme === 'dark' ? 'text-white/30 hover:text-white/60' : 'text-black/30 hover:text-black/60'}`}
                                    >
                                      <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                        <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                                        <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                                        <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                                      </svg>
                                    </button>
                                    <span className="flex shrink-0 flex-col">
                                      <button
                                        type="button"
                                        aria-label={`${entry.label} 上移`}
                                        disabled={!entry.canMoveUp}
                                        onClick={() => entry.onMove(entry.index - 1)}
                                        className="flex h-4 w-4 items-center justify-center rounded text-[8px] leading-none disabled:opacity-20 enabled:hover:bg-white/10"
                                      >
                                        ▲
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`${entry.label} 下移`}
                                        disabled={!entry.canMoveDown}
                                        onClick={() => entry.onMove(entry.index + 1)}
                                        className="flex h-4 w-4 items-center justify-center rounded text-[8px] leading-none disabled:opacity-20 enabled:hover:bg-white/10"
                                      >
                                        ▼
                                      </button>
                                    </span>
                                    <button
                                      type="button"
                                      disabled={entry.locked}
                                      onClick={entry.onToggle}
                                      className={`flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${playerTheme === 'dark' ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
                                    >
                                      <span className="flex min-w-0 flex-col leading-tight">
                                        <span className={`truncate text-sm font-medium ${playerTheme === 'dark' ? 'text-white/95' : 'text-black/85'}`}>{entry.label}</span>
                                        <span className={`mt-0.5 truncate text-[10px] ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/40'}`}>
                                          {entry.sublabel ? `${entry.sublabel} · ${entry.status}` : entry.status}
                                        </span>
                                      </span>
                                      <span
                                        aria-hidden="true"
                                        className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${entry.visible ? 'bg-emerald-400/80' : playerTheme === 'dark' ? 'bg-white/15' : 'bg-black/15'}`}
                                      >
                                        <span
                                          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200 ${entry.visible ? 'left-[18px]' : 'left-0.5'}`}
                                        />
                                      </span>
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <p className={`px-2 pb-1 pt-1.5 text-[10px] leading-snug ${playerTheme === 'dark' ? 'text-white/35' : 'text-black/35'}`}>
                                {lyricPanelPage === 'folia'
                                  ? '拖动左侧把手可排序；当前样式与最后 ' + MIN_VISIBLE_FOLIA_STYLES + ' 个可见样式不可隐藏'
                                  : '现代模式始终显示；当前模式与最后一个可见模式不可隐藏'}
                              </p>
                            </motion.div>
                          )}
                          {/* Folia 参数面板：与模式菜单互斥（同时开会在同一区域重叠） */}
                          {showFoliaTuning && foliaStyleHasPanel && (
                            <motion.div
                              key="folia-tuning-popover"
                              initial={{ opacity: 0, y: -6, scale: 0.98 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -6, scale: 0.98 }}
                              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                              data-lyric-mode-customize
                              className={`absolute right-8 top-[calc(22vh+24px)] z-40 w-[21rem] max-h-[62vh] overflow-y-auto rounded-2xl border p-2 backdrop-blur-2xl ${playerTheme === 'dark' ? 'border-white/15 bg-[#0c0e1a]/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.55)]' : 'border-black/10 bg-white/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.15)]'}`}
                              style={{ willChange: 'transform, opacity' }}
                            >
                              <FoliaTuningPanel
                                mode={foliaStyle}
                                tuning={resolvePanelTuning(userFoliaTunings, foliaStyle)}
                                onCommit={commitFoliaTuning}
                                onReset={resetFoliaTuning}
                                hasOverride={hasFoliaTuningOverride(userFoliaTunings, foliaStyle)}
                                playerTheme={playerTheme}
                                accentColor={playbackCoverColor}
                              />
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              ), document.body)}


              {(() => {
            // 播放器事件监听，处理播放状态变化
            return (isAppleRadioPlayback || (appleRadioSurfaceLocked && pendingAppleRadioSong?.appleRadio)) ? (
              <motion.div
                key="apple-radio-player"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-20"
              >
                <LazyAppleRadioNowPlayingPage
                  song={(isAppleRadioPlayback ? currentSong : pendingAppleRadioSong)!}
                  isPlaying={isPlaying}
                  currentTime={currentTime}
                  duration={duration}
                  volume={volume}
                  playerTheme={playerTheme}
                  status={appleRadioStatus}
                  error={appleRadioError}
                  playbackTimeStore={audioPlayer.playbackTimeStore}
                  onBack={handlePlayerHome}
                  onPlayPause={handlePlayPause}
                  onSeek={audioPlayer.seek}
                  onVolumeChange={handleVolumeChange}
                  onRetry={() => {
                    const target = (isAppleRadioPlayback ? currentSong : pendingAppleRadioSong)
                    if (target) void loadAndPlaySong(target, 0, [target])
                  }}
                  onOpenSoundEffects={(anchorRect) => {
                    if (anchorRect) {
                      mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                    }
                    setShowMixingStudio(true)
                  }}
                />
              </motion.div>
            ) : podcastPlayback ? (
              /* 播客单集：独立播放页（不是歌曲，没有歌词/MV/专辑语义）。
                  此前被归一到下面的「纯音乐」分支，封面取不到时只剩 No Cover 黑板。 */
              <motion.div
                key="podcast-player"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute inset-0 z-20"
              >
                <LazyPodcastNowPlayingPage
                  song={currentSong}
                  isPlaying={isPlaying}
                  currentTime={currentTime}
                  duration={duration}
                  volume={volume}
                  playerTheme={playerTheme}
                  playbackTimeStore={audioPlayer.playbackTimeStore}
                  onBack={handlePlayerHome}
                  onPlayPause={handlePlayPause}
                  onSeek={audioPlayer.seek}
                  onVolumeChange={handleVolumeChange}
                  onOpenSoundEffects={(anchorRect) => {
                    if (anchorRect) {
                      mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                    }
                    setShowMixingStudio(true)
                  }}
                />
              </motion.div>
            ) : (isPureMusic && !PURE_MUSIC_OWN_LAYOUT_MODES.has(lyricDisplayMode)) ? (
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
                      // 与封面背景/MV 同源：overlayProgress 从动画窗口起点归一化，无跳变
                      transitionProgress={overlayProgress}
                      // 视觉轨道：逐帧进度直达封面层（只重渲染它），交叉淡化不再有整树节流台阶
                      transitionProgressStore={audioPlayer.transitionVisualStore}
                      transitionFromTrack={transitionFromTrack}
                      transitionToTrack={transitionToTrack}
                      pulseStore={audioPulseStore}
                      animatedCoverUrl={displayAnimatedCoverUrl}
                      animatedCoverPoster={displayAnimatedCoverPoster}
                    />

                    {/* 歌曲信息 - 过渡时双层淡入淡出（逐帧进度由视觉轨道 store 直达组件，消除整树节流台阶） */}
                    <div className="relative w-full max-w-4xl space-y-3 text-center">
                      <TransitionTrackTitles
                        isTransitioning={isVisualTransitioning}
                        progress={overlayProgress}
                        progressStore={audioPlayer.transitionVisualStore}
                        fromTrack={transitionFromTrack}
                        toTrack={transitionToTrack}
                        fallbackTitle={currentSong.name}
                        fallbackArtist={currentSong.artists.map((a: any) => a.name).join(', ')}
                        playerTheme={playerTheme}
                        size="lg"
                      />
                      {/* AutoMix 过渡徽标：纯音乐居中布局同样显示（与有词布局一致）。
                          绝对定位挂在歌名块下方（top-full + mt），不进文档流 —— 通知出现/消失
                          不再撑高居中容器（否则封面与歌名歌手会被顶得上下位移）。 */}
                      {modernAutomixHud && (
                        <div className="pointer-events-none absolute left-0 right-0 top-full mt-4 flex w-full justify-center">
                          <AutomixHudBadge
                            info={modernAutomixHud}
                            currentTime={automixHudTime}
                            scale={1}
                            colors={modernAutomixHudColors}
                            // 药丸底色 = 当前封面主题色的淡色（color-mix 混入原底色，保持对比度）
                            accentColor={playbackCoverColor}
                            onDismiss={() => { setDismissedAutomixHudKey(modernAutomixHud.key); setAutomixHudSkippedTrackKey(modernAutomixHud.key.split('|')[0] || null); audioPlayer.skipAutoMixForCurrentPair() }}
                          />
                        </div>
                      )}
                    </div>
                </motion.div>
                </motion.div>
              ) : lyricDisplayMode === 'immersive' ? (
                <motion.div
                  key="immersive-lyrics-player"
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
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
                      accentColor={playbackCoverColor}
                      translationEnabled={translationEnabled}
                      translationPosition="traditional"
                      onCurrentTranslationChange={setCurrentTranslation}
                      onSeek={audioPlayer.seek}
                      romanEnabled={romanEnabled}
                      displayMode="single"
                      singleNextLinePreview
                      settleRevision={lyricSettleRevision}
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
                    accentColor={playbackCoverColor}
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
                  animate={{ opacity: 1, scale: 1 }}
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
                    accentColor={playbackCoverColor}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    isTransitioning={isVisualTransitioning}
                    active
                    onSeek={audioPlayer.seek}
                    mvBackgroundActive={mvBackgroundActive}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'folia' ? (
                <motion.div
                  key="folia-lyrics-player"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 w-full min-h-0"
                >
                  <LazyFoliaLyricsPage
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    playerTheme={playerTheme}
                    accentColor={playbackCoverColor}
                    songTitle={currentSong.name}
                    songArtist={currentSongArtistLabel}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id ?? currentSong.mid ?? getSongKey(currentSong) ?? ''}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    onSeek={audioPlayer.seek}
                    analyzerStore={audioAnalyzer}
                    foliaStyle={foliaStyle}
                    foliaBackgroundEnabled={foliaBackgroundEnabled}
                    mvBackgroundActive={mvBackgroundActive}
                    userTunings={userFoliaTunings}
                    active
                  />
                </motion.div>
              ) : lyricDisplayMode === 'glorious' ? (
                <motion.div
                  key="glorious-lyrics-player"
                  initial={{ opacity: 0, scale: 1.04 }}
                  animate={{ opacity: 1, scale: 1 }}
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
                    accentColor={playbackCoverColor}
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
                  animate={{ opacity: 1, scale: 1 }}
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
                    accentColor={playbackCoverColor}
                    playerTheme={playerTheme}
                    songTitle={currentSong.name}
                    songArtist={currentSong.artists.map((artist: any) => artist.name).join(', ')}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    appleCoverUrl={appleCoverUrl || undefined}
                    animatedCoverUrl={displayAnimatedCoverUrl}
                    animatedCoverPoster={displayAnimatedCoverPoster}
                    trackId={currentSong.id || currentSong.mid}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    hasTranslation={hasTranslation}
                    hasRoman={hasRoman}
                    onTranslationToggle={handleTranslationToggle}
                    onRomanToggle={handleRomanToggle}
                    // 评论能力按平台判断：不支持的平台直接不传回调（播放页按钮转为禁用态），
                    // 而不是给了按钮、点了才提示「不支持」（2026-09-27 审计）
                    onOpenComments={getPlatformCapabilities(currentSong.platform || 'netease').comments
                      ? () => handleViewComments(currentSong)
                      : undefined}
                    onHomeClick={handlePlayerHome}
                    onMvBackgroundToggle={handleMvBackgroundToggle}
                    mvBackgroundEnabled={mvBackgroundEnabled}
                    mvBackgroundActive={mvBackgroundActive}
                    onOpenMixingStudio={(anchorRect?: DOMRect) => {
                      if (anchorRect) {
                        mixingStudioAnchorRef.current = { x: anchorRect.x, y: anchorRect.y, width: anchorRect.width, height: anchorRect.height }
                      }
                      setShowMixingStudio(true)
                    }}
                    isPureMusic={isPureMusic}
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
                    automixHud={automixHudEnabled ? automixHud : null}
                    transitionProgress={overlayProgress}
                    transitionFromCover={transitionFromTrack?.coverUrl ? getResolvedArtworkUrl(transitionFromTrack.coverUrl, { size: 512 }) : undefined}
                    transitionToCover={transitionToTrack?.coverUrl ? getResolvedArtworkUrl(transitionToTrack.coverUrl, { size: 512 }) : undefined}
                    // HUD「关闭」= 本曲不做智能混音（完整播放本曲，末尾短交叉）
                    onSkipAutomix={() => audioPlayer.skipAutoMixForCurrentPair()}
                    transitionToTitle={transitionToTrack?.title}
                    transitionToArtist={transitionToTrack?.artist}
                  />
                </motion.div>
              ) : lyricDisplayMode === 'pv' ? (
                <motion.div
                  key="pv-lyrics-player"
                  initial={{ opacity: 0, scale: 1.02 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.99 }}
                  transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                  className="flex-1 w-full min-h-0 relative"
                >
                  <LazyPvLyricsPage
                    lyrics={lyrics}
                    currentIndex={currentLyricIndex}
                    playbackTimeStore={audioPlayer.playbackTimeStore}
                    timeOffset={lyricOffset - 0.2}
                    isPlaying={isPlaying}
                    playerTheme={playerTheme}
                    accentColor={playbackCoverColor}
                    songTitle={currentSong.name}
                    songArtist={currentSongArtistLabel}
                    songAlbum={currentSong.album?.name}
                    coverUrl={displayCoverUrl}
                    trackId={currentSong.id || currentSong.mid}
                    trackKey={currentSong ? getSongKey(currentSong) : ''}
                    translationEnabled={translationEnabled}
                    romanEnabled={romanEnabled}
                    onSeek={audioPlayer.seek}
                    mvBackgroundActive={mvBackgroundActive}
                    dominantColor={dominantColor}
                    isTransitioning={isVisualTransitioning}
                    transitionProgress={overlayProgress}
                    transitionToTitle={transitionToTrack?.title}
                    transitionToArtist={transitionToTrack?.artist}
                  />
                </motion.div>
              ) : (
                /* 统一播放页版面：有词 = 左封面 + 右歌词；纯音乐 = 封面居中（歌词列收起）。
                   两种状态共用同一棵树（不换 key）→ 封面用 layout 动画滑到新位置，
                   不再"过渡完毕抽一下到中间"；封面/MV 也不会因换版面而重挂载。 */
                <motion.div
                  key="default-player"
                  initial={{ opacity: 0, filter: 'blur(10px)' }}
                  animate={{ opacity: 1, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, filter: 'blur(10px)' }}
                  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  className="flex-1 w-full flex items-center justify-center"
                >
                  <div className={`w-full flex items-center justify-center ${showLyricsColumn ? 'max-w-7xl h-[85vh] gap-12' : 'gap-0'}`}>
                  {/* 左侧：封面展示区 */}
                  <motion.div
                    layout="position"
                    transition={{ duration: 0.5, ease: [0.32, 0.72, 0, 1] }}
                    className={`flex flex-col items-center justify-center ${showLyricsColumn ? 'flex-1 gap-6' : 'gap-8 px-6'}`}
                  >
                    <AlbumCoverPlayer
                      coverUrl={displayCoverUrl}
                      isPlaying={isPlaying}
                      dominantColor={dominantColor}
                      trackId={currentSong.id || currentSong.mid}
                      isTransitioning={isVisualTransitioning}
                      // 与封面背景/MV 同源：overlayProgress 从动画窗口起点归一化，无跳变
                      transitionProgress={overlayProgress}
                      // 视觉轨道：逐帧进度直达封面层（只重渲染它），交叉淡化不再有整树节流台阶
                      transitionProgressStore={audioPlayer.transitionVisualStore}
                      transitionFromTrack={transitionFromTrack}
                      transitionToTrack={transitionToTrack}
                      pulseStore={audioPulseStore}
                      animatedCoverUrl={displayAnimatedCoverUrl}
                      animatedCoverPoster={displayAnimatedCoverPoster}
                    />

                    {/* 歌曲信息 - 过渡时双层淡入淡出（逐帧进度由视觉轨道 store 直达组件） */}
                    <div className={`relative w-full text-center ${showLyricsColumn ? 'min-h-[5.25rem] max-w-xl space-y-2 px-4' : 'max-w-4xl space-y-3'}`}>
                      <TransitionTrackTitles
                        isTransitioning={isVisualTransitioning}
                        progress={overlayProgress}
                        progressStore={audioPlayer.transitionVisualStore}
                        fromTrack={transitionFromTrack}
                        toTrack={transitionToTrack}
                        fallbackTitle={currentSong.name}
                        fallbackArtist={currentSong.artists.map((a: any) => a.name).join(', ')}
                        playerTheme={playerTheme}
                        size={showLyricsColumn ? 'md' : 'lg'}
                      />
                      {/* AutoMix 过渡徽标：歌名下方显示过渡时间节点（个性化里可关）。
                          绝对定位（top-full）→ 不再把封面/歌名歌手顶跑位。 */}
                      {modernAutomixHud && (
                        <div className={`pointer-events-none absolute left-0 right-0 top-full flex w-full justify-center ${showLyricsColumn ? 'mt-3' : 'mt-4'}`}>
                          <AutomixHudBadge
                            info={modernAutomixHud}
                            currentTime={automixHudTime}
                            scale={1}
                            colors={modernAutomixHudColors}
                            // 药丸底色 = 当前封面主题色的淡色（color-mix 混入原底色，保持对比度）
                            accentColor={playbackCoverColor}
                            onDismiss={() => { setDismissedAutomixHudKey(modernAutomixHud.key); setAutomixHudSkippedTrackKey(modernAutomixHud.key.split('|')[0] || null); audioPlayer.skipAutoMixForCurrentPair() }}
                          />
                        </div>
                      )}
                    </div>
                  </motion.div>

                  {/* 右侧：歌词显示区（纯音乐时收起——过渡期间例外，见 showLyricsColumn） */}
                  {showLyricsColumn && (
                  <motion.div
                    layout="position"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                    className="flex-1 flex flex-col justify-between h-full min-h-0 py-8"
                  >
                    {/* 歌词显示 */}
                    <div className="flex-1 min-h-0 flex items-center justify-center">
                      <div className="relative w-full h-full min-h-0">
                        <LiveLyricsDisplay
                      playbackTimeStore={audioPlayer.playbackTimeStore}
                          lyrics={lyrics}
                          isPlaying={isPlaying}
                          accentColor={playbackCoverColor}
                          translationEnabled={translationEnabled}
                          translationPosition={translationPosition}
                          onCurrentTranslationChange={setCurrentTranslation}
                          onSeek={audioPlayer.seek}
                          romanEnabled={romanEnabled}
                          backgroundEffect={backgroundEffect}
                          sustainGlowEnabled
                          isTransitioning={isVisualTransitioning}
                          // 歌词与封面/MV 共用同一交叉淡化时钟：仅在最后 ~4 秒窗口内渐隐，
                          // 窗口外保持可读（此前动画窗口一开就压到 0.14，歌词提前消失）。
                          // 交叉淡化（整段过渡）生效时由 crossfadeActive 接管，这里归零避免叠加。
                          transitionFadeProgress={isVisualTransitioning && !visualSwitchedToTarget ? overlayProgress : 0}
                          crossfadeActive={lyricsCrossfadeActive}
                          crossfadeStore={audioPlayer.transitionVisualStore}
                          managedCrossfade={lyricsManagedSwitch}
                          settleRevision={lyricSettleRevision}
                          indexHint={visualSwitchedToTarget && incomingLyricIndexRef.current >= 0 ? incomingLyricIndexRef.current : null}
                          trackId={currentSong?.id || currentSong?.mid}
                          pulseStore={audioPulseStore}
                          playerTheme={playerTheme}
                          lyricStyleMode={lyricStyleMode}
                        />
                        {/* 过渡期下一首歌词层：与上面这层交叉（旧淡出 / 新淡入），
                            视觉切换帧由 canonical 在同位置同样式无动画接替。 */}
                        {lyricsCrossfadeActive && incomingLyrics && (
                          <TransitionIncomingLyrics
                            store={audioPlayer.transitionVisualStore}
                            lyrics={incomingLyrics}
                            trackId={transitionVisualIdentity.toTrackKey}
                            accentColor={playbackCoverColor}
                            displayMode="scroll"
                            scrollAlignment="left"
                            backgroundEffect={backgroundEffect}
                            playerTheme={playerTheme}
                            lyricStyleMode={lyricStyleMode}
                            onActiveIndexChange={handleIncomingLyricIndexChange}
                          />
                        )}
                      </div>
                    </div>

                    {/* 歌词翻译 */}
                    <LazyTranslationDisplay
                      translation={currentTranslation}
                      show={translationEnabled && translationPosition === 'bottom-right'}
                      songId={currentSong?.id}
                    />
                  </motion.div>
                  )}
                </div>
              </motion.div>
            )
          })()}

          <AnimatePresence>
            {currentSong && !showHome && !isAppleRadioPlayback && !appleRadioSurfaceLocked && lyricDisplayMode === 'modern' && modernAudioVisualizerEnabled && !(isTvModeActive() && isPerfModeEfficiency()) && (
              <LazyModernAudioVisualizer
                key="modern-audio-visualizer"
                analyser={audioPlayer.analyserNode}
                isPlaying={isPlaying}
                accentColor={playbackCoverColor}
                palette={effectiveCoverPalette}
                playerTheme={playerTheme}
                pulseStore={audioPulseStore}
              />
            )}
          </AnimatePresence>

          {/* Folia 专属过渡展示层：独立于 FoliaLyricsPage，30fps progress 不触发歌词树重渲染。 */}
          {foliaPresentation.active && currentSong && !isAppleRadioPlayback && !appleRadioSurfaceLocked && (
            <>
              <FoliaUpNextCard
                visible={foliaPresentation.cardVisible}
                isTransitioning={foliaPresentation.transitionBorderVisible}
                progress={transitionProgress}
                current={{ title: currentSong.name, artist: currentSongArtistLabel, coverUrl: displayCoverUrl }}
                next={nextSongToShow ? {
                  title: nextSongToShow.name,
                  artist: nextSongToShow.artists.map(artist => artist.name).join(', '),
                  coverUrl: nextSongToShow.album?.picUrl,
                } : undefined}
                onActivate={() => {
                  suppressUpNextUntilRef.current = Date.now() + 3000
                  setShowUpNext(false)
                  handleNext()
                }}
                theme={playerTheme}
                accentColor={playbackCoverColor}
              />
              <FoliaTransitionOverlay
                visible={foliaPresentation.overlayVisible}
                suppressed={foliaPresentation.transitionBorderVisible}
                progress={transitionProgress}
                duration={transitionDuration}
                bpm={transitionDebug?.sourceBpm}
                accentColor={playbackCoverColor}
                theme={playerTheme}
              />
            </>
          )}

          {/* 全局播放器固定在底部；真正无视频/失败时通过 portal 恢复音频控制。
              挂起（简约层不是当前显示的面）时回归内联渲染：portal 挂在 body 上不受挂起层
              visibility:hidden 约束，留着会浮在桌面/探索/传统模式上。 */}
          {currentSong && !showHome && !isAppleRadioPlayback && !appleRadioSurfaceLocked && lyricDisplayMode !== 'modeng' && (lyricDisplayMode !== 'video' || watchSearchFailed) && (
            <MaybePortal active={lyricDisplayMode === 'video' && !parkedMinimal}>
            <LivePlayerControls
                      playbackTimeStore={audioPlayer.playbackTimeStore}
              isPlaying={isPlaying}
              duration={duration}
              live={isLive}
              volume={volume}
              onPlayPause={handlePlayPause}
              onSeek={handleSeek}
              onVolumeChange={handleVolumeChange}
              onPrevious={handlePrevious}
              onNext={handleNext}
              onPlaylistClick={() => setShowPlaylist(true)}
              songPlatform={currentSong?.platform}
              songId={currentSong ? (currentSong.mid || currentSong.id) : undefined}
              qualityQuickSwitchEnabled={qualityQuickSwitch}
              backgroundEffect={lyricDisplayMode === 'immersive' || lyricDisplayMode === 'glorious' || lyricDisplayMode === 'multidimensional' ? 'immersive' : backgroundEffect}
              playMode={playMode}
              onPlayModeChange={handlePlayModeChange}
              accentColor={playbackCoverColor}
              transitionFromAccentColor={transitionFromAccentColor || transitionFromTrack?.dominantColor || undefined}
              transitionToAccentColor={transitionToAccentColor || undefined}
              transitionProgress={overlayProgress}
              playerTheme={playerTheme}
              isTransitioning={isVisualTransitioning}
              isAutoMixTransition={isAutoMixTransition}
              enhancedAutoMix={isEnhancedAutoMix}
              // 「AutoMix 正在介入」：只有真正开始混音（running-transition）才显示，
              // armed/准备阶段不显示（用户要求：不是开关开着就一直显示）
              enhancedAutoMixActive={isEnhancedAutoMix && transitionState === 'running-transition'}
              // 进度条上方金色引擎名：AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless
              // （只写引擎名；无可归属引擎时为 undefined → 不显示）
              transitionEngineLabel={transitionEngineName ?? undefined}
              transitionStartTime={transitionStartTime}
              immersiveTranslation={immersiveLyricLine?.translation || ''}
              immersiveRoman={immersiveLyricLine?.roman || ''}
              showImmersiveTranslation={lyricDisplayMode === 'immersive' && translationEnabled && Boolean(immersiveLyricLine?.translation?.trim())}
              showImmersiveRoman={lyricDisplayMode === 'immersive' && romanEnabled && Boolean(immersiveLyricLine?.roman?.trim())}
            />
            </MaybePortal>
          )}
          </motion.div>
        )}
        </div>

        {/* 首页 MiniPlayer 必须由首页直接挂载/卸载。播放页不能等待组件内部的
            exit 动画，否则冷启动首次播放时 Chromium 可能保留一个空的合成框。 */}
        {showHome && currentSong && <LiveMiniPlayer
                      playbackTimeStore={audioPlayer.playbackTimeStore}
          externalCurrentTime={watchTimelineActive ? watchVideoState.time : undefined}
          show={true}
          coverUrl={displayCoverUrl}
          isPlaying={watchTimelineActive ? watchVideoState.playing : isPlaying}
          duration={watchTimelineActive && watchVideoState.duration > 0 ? watchVideoState.duration : duration}
          volume={watchTimelineActive ? watchVideoState.volume : volume}
          title={currentTrack.title}
          artist={currentTrack.artist}
          currentLyric={currentMiniLyric}
          hasLyrics={lyrics.length > 0}
          live={isLive || currentAppleRadio?.timeline === 'live'}
          // 电台（含曲目型电台）与播客都没有「相邻曲目」语义：隐藏切歌按钮，
          // 无歌词时改显示电台名 / 播客名（比「暂无歌词」更能说明在放什么）。
          hideSkipControls={isAppleRadioPlayback || podcastPlayback}
          lyricsPlaceholder={currentMiniLyricsPlaceholder}
          accentColor={playbackCoverColor}
          onPlayPause={handlePlayPause}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onSeek={handleSeek}
          onVolumeChange={handleVolumeChange}
          onClick={() => {
            playbackOriginRef.current = { mode: viewMode, surface: viewMode === 'minimal' ? 'home' : 'mode-root' }
            setRestorePlaybackOrigin(null)
            setEnteredFromMode(viewMode)
            setShowSharedPlayer(true)
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
            songMenu={panelSongMenu}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            currentPlatform={currentSong?.platform || 'netease'}
          />
        </Suspense>
      )}

      {/* 鐧诲綍瑙嗗浘 */}
            </ModeParkedContext.Provider>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 调音室是全模式共享弹层，不能挂在简约模式分支中。 */}
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
              sourceUrl: mixingStudioAudio?.src || undefined,
              sourceDuration: mixingStudioAudio?.duration || undefined,
              exportFileName: currentSong?.name || undefined,
            })}
          </Suspense>
        )}
      </AnimatePresence>

      {/* 播放设置弹窗（原 QuickSettings 下拉面板）：全局唯一宿主，与调音室同为全模式共享弹层。
          弹窗内部由 QuickSettingsHost 自己 portal 到 body —— 挂在这里而不是各播放页里，
          既避免被四个模式容器的层叠上下文困住，也让弹窗不再受播放页 overflow-hidden 裁切。 */}
      <Suspense fallback={null}>
        <LazyQuickSettingsHost playback={quickSettingsPlayback} />
      </Suspense>

      {/* 播放提示是全局覆盖层：播放页始终允许显示；探索、简约首页和桌面模式
          只有在“在播放页外显示播放提示”开启时才显示，且三个模式位置一致。 */}
      {playlist.length > 0 && playMode !== 'repeat' && canShowUpNextOnCurrentSurface && foliaPresentation.useLegacyUpNext && (
        <Suspense fallback={null}>
          <LiveUpNextNotification
            playbackTimeStore={audioPlayer.playbackTimeStore}
            // 倒计时目标见上方 upNextEventTime（AutoMix 用介入点；gapless 用裁剪后的拼接点）
            // 常驻挂载 + show 下传：出场动画由组件内 AnimatePresence 播（此前直接卸载组件，
            // exit 永远不会执行——用户反馈「入场出场动画没做」）。
            show={showUpNext}
            playerTheme={playerTheme}
            nextSong={nextSongToShow}
            mode={effectiveAutoMixEnabled || effectiveGaplessEnabled ? 'transition' : 'play'}
            // 无缝衔接（gapless）没有混音介入动作：文案用「即将无缝衔接」，不再套「即将进入过渡」
            strategyLabel={
              (effectiveGaplessEnabled && !effectiveAutoMixEnabled) || transitionStrategy === 'gapless'
                ? '即将无缝衔接'
                : undefined
            }
            // 裁剪过尾部静音时，倒计时目标改为「有声内容结束」（拼接点），
            // 否则卡片会停在「0秒后」数秒直到原始末尾才消失
            eventTime={upNextEventTime}
            enhanced={effectiveAutoMixEnabled && autoMixEnhanced}
            enhancedLabel={transitionStrategy === 'smart-rendered-qq' ? 'Enhanced 过渡' : 'Pro 过渡'}
            transitionStyle={transitionStrategy === 'smart-rendered-qq' ? undefined : transitionStyle}
            onSkip={() => {
              suppressUpNextUntilRef.current = Date.now() + 3000
              setShowUpNext(false)
              handleNext()
            }}
          />
        </Suspense>
      )}

      {/* Search and login are global singletons. They can open from any mode and must not
          remain attached to an outgoing AnimatePresence branch during playback entry.
          不用 AnimatePresence 包裹：整屏 backdrop-filter 的退出节点在播放页挂载时会被
          Chromium/framer-motion 卡住不卸载（首页同款故障），普通条件渲染关闭即当帧卸载。 */}
      <Suspense fallback={null}>
          {showSearch && (
            <LazySearchPanel
            onSongSelect={viewCallbacks.onSongSelect}
            restorePlaybackOrigin={restorePlaybackOrigin}
            onClose={closeSearchPanel}
            onRestoreConsumed={consumeRestoreOrigin}
            playerTheme={playerTheme}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            neteaseLoggedIn={neteaseLoggedIn}
            qqLoggedIn={qqLoggedIn}
            appleLoggedIn={appleLoggedIn}
            spotifyLoggedIn={spotifyLoggedIn}
            kugouLoggedIn={kugouLoggedIn}
            currentSong={currentSong}
            onPlayNext={viewCallbacks.onPlayNext}
            onAddToFavorites={viewCallbacks.onAddToFavorites}
            onRemoveFromFavorites={viewCallbacks.onRemoveFromFavorites}
            onAddToPlaylist={viewCallbacks.onAddToPlaylist}
            onViewComments={viewCallbacks.onViewComments}
            onOpenArtist={viewCallbacks.onOpenArtist}
            onOpenAlbum={viewCallbacks.onOpenAlbum}
            onOpenPlaylist={searchOpenPlaylistStable}
            onCopyInfo={viewCallbacks.onCopyInfo}
            />
          )}
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
          retain a second interactive overlay while playback switches to minimal mode.
          不用 AnimatePresence 包裹：整屏 backdrop-filter 退出节点会被卡住不卸载，
          普通条件渲染保证选歌后艺人弹窗当帧移除。 */}
      <Suspense fallback={null}>
        {artistPicker.show && artistPicker.song ? (
          <LazyArtistPickerModal
            show={artistPicker.show}
            song={artistPicker.song}
            accent={playbackCoverColor}
            onSelect={index => {
              const target = artistPicker.song
              setArtistPicker({ show: false, song: null })
              if (target) openPlaybackArtistAt(target, index)
            }}
            onClose={() => setArtistPicker({ show: false, song: null })}
          />
        ) : null}
      </Suspense>
      <Suspense fallback={null}>
          {frozenArtistDetail && (
            <LazyArtistDetailModal
            key={'artist-' + frozenArtistDetail.id}
            artistId={frozenArtistDetail.id}
            platform={frozenArtistDetail.platform}
            artistName={frozenArtistDetail.name}
            suspended={!showArtistDetail}
            onClose={closeArtistDetail}
            onSongSelect={handleArtistDetailSongSelect}
            initialAlbumId={selectedArtistAlbumId}
            onAlbumOpen={setSelectedArtistAlbumId}
            initialTab={selectedArtistTab || 'hotSongs'}
            onTabChange={setSelectedArtistTab}
            accentColor={playbackCoverColor}
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
            onVideoPlaybackStart={() => { if (isPlaying) handlePlayPause() }}
            />
          )}
      </Suspense>

      <Suspense fallback={null}>
          {frozenAlbumDetail && (
            <LazyAlbumDetailModal
            key={'album-' + frozenAlbumDetail.id}
            albumId={frozenAlbumDetail.id}
            platform={frozenAlbumDetail.platform}
            suspended={!showAlbumDetail}
            storefront={frozenAlbumDetail.platform === 'apple' ? appleStorefront : undefined}
            onClose={stableDialogCallbacks.closeAlbumDetail}
            onSongSelect={handleAlbumDetailSongSelect}
            accentColor={playbackCoverColor}
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
      </Suspense>

      {qqMusicPreferenceOpen && (
        <Suspense fallback={null}>
          <LazyQQMusicPreferenceDialog open={qqMusicPreferenceOpen} onClose={() => setQQMusicPreferenceOpen(false)} />
        </Suspense>
      )}

      <Suspense fallback={null}>
        <AnimatePresence>
          {commentModalFrozen && (
            <LazyCommentModal
              isOpen={showCommentModal}
              onClose={closeCommentModal}
              song={selectedCommentSong}
              playerTheme={playerTheme}
              accentColor={playbackCoverColor}
              onOpenPlaylist={commentOpenPlaylistStable}
            />
          )}
        </AnimatePresence>
      </Suspense>

      {/* Global singleton prevents duplicate overlays during view-mode changes.
          不用 AnimatePresence 包裹（与搜索面板同款故障）：ProfileView 的玻璃遮罩带整屏
          backdrop-filter，退出节点在播放页挂载时会被 Chromium/framer-motion 卡住不卸载
          → 最近播放等弹窗选歌后残留盖在播放页上；普通条件渲染关闭即当帧卸载。 */}
      <Suspense fallback={null}>
          {profileFrozen && (neteaseLoggedIn || qqLoggedIn || appleLoggedIn || sodaLoggedIn) && (
            <LazyProfileView
            suspended={!showProfile}
            initialPlatform={profileInitialPlatform}
            initialTab={profileInitialTab}
            switchablePlatforms={profileSwitchablePlatforms}
            onSwitchPlatformTo={stableDialogCallbacks.switchProfilePlatformTo}
            userId={profileInitialPlatform === 'netease' ? neteaseUserId : profileInitialPlatform === 'qq' ? qqUserId : ''}
            cookie={profileInitialPlatform === 'netease' ? _neteaseCookie : profileInitialPlatform === 'qq' ? _qqCookie : ''}
            onClose={stableDialogCallbacks.closeProfile}
            onSongSelect={viewCallbacks.onSongSelect}
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
            initialUserTarget={profileUserTarget}
            />
          )}
      </Suspense>
    </Suspense>
    {/* 插件系统（插件中心/详情/导入/使用须知/DG_LAB 控制台） */}
    <PluginOverlay />
    </>
  )
}

export default App





