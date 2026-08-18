import type { TrackAnalysis, TransitionPlan, RenderedTransition } from './audio/types'

// Electron API 类型声明
export interface WallpaperPayload {
  path: string
  fileUrl: string
  dataUrl: string
  mimeType: string
  size: number
  mtimeMs: number
  wallpaperEngine?: WallpaperEngineSource
}

export type WallpaperEngineSourceType = 'video' | 'web' | 'image' | 'scene' | 'application' | 'unknown'

export interface WallpaperEngineSource {
  path?: string
  fileUrl?: string
  mediaUrl?: string
  sourceType: WallpaperEngineSourceType
  unsupported?: boolean // 标记为不支持的壁纸类型
  monitor?: string
  local?: boolean
  title?: string
  size?: number
  mtimeMs?: number
  configPath?: string
}

export interface FullscreenStatus {
  fullscreen: boolean
  kiosk: boolean
  maximized: boolean
}

export type WallpaperResult =
  | ({ success: true } & WallpaperPayload)
  | { success: false; error?: string }


export interface AnalysisRuntimeStatus {
  available: boolean
  provider: string
  model?: string
  version: string
  reason?: string
  cacheRoot?: string
  pythonAvailable?: boolean
}

export interface AnalysisJobHandle {
  jobId: string
  status: string
  reason?: string
  result?: TrackAnalysis
  cached?: boolean
}

export interface AnalysisAPI {
  startTrackAnalysis: (input: { trackKey: string; audioPath: string; duration?: number; sourceSignature?: string }) => Promise<AnalysisJobHandle>
  getTrackAnalysis: (trackKey: string) => Promise<TrackAnalysis | null>
  saveTrackAnalysis: (analysis: TrackAnalysis) => Promise<{ success: boolean; error?: string }>
  cancelJob: (jobId: string) => Promise<{ success: boolean }>
  getStatus: () => Promise<AnalysisRuntimeStatus>
  getCacheStats: () => Promise<{ fileCount: number; totalSize: number; cachePath: string }>
  clearCache: () => Promise<{ success: boolean; error?: string }>
  onProgress: (callback: (progress: { jobId: string; trackKey?: string; stage: string; progress: number; message?: string }) => void) => () => void
}
export interface DeviceLicenseGrant {
  feature: string
  label: string
  issuedAt: number
  expiresAt: number | null
  note?: string
}

export type DeviceIdentityResult =
  | { success: true; deviceId: string; storage: 'registry' | 'file' }
  | { success: false; error: string }

export type DeviceLicenseStateResult =
  | { success: true; deviceId: string; storage: 'registry' | 'file'; grants: DeviceLicenseGrant[] }
  | { success: false; error: string }

export type DeviceRedeemResult =
  | { success: true; message: string; storage: 'registry' | 'file'; grant: DeviceLicenseGrant; grants: DeviceLicenseGrant[] }
  | { success: false; error: string }

export interface HardwareAccelerationStatus {
  enabled: boolean
  gpuPreference: 'auto' | 'discrete' | 'integrated'
  pendingGpuChange: { type: 'preference' | 'acceleration' } | null
  actualEnabled: boolean
  featureStatus: Record<string, string>
  gpu: {
    active: boolean
    vendorId?: number
    deviceId?: number
    vendorString?: string
    deviceString?: string
    driverVendor?: string
    driverVersion?: string
  } | null
  gpus: Array<{
    active: boolean
    vendorId?: number
    deviceId?: number
    vendorString: string
    deviceString: string
    driverVersion?: string
    kind: 'discrete' | 'integrated' | 'unknown'
  }>
}

export interface ElectronAPI {
  analysis: AnalysisAPI
  system: {
    minimize: () => Promise<any> | void
    maximize: () => Promise<any> | void
    close: () => Promise<any> | void
    isMaximized: () => Promise<boolean>
    onMaximizedChange: (callback: (isMaximized: boolean) => void) => () => void
    setFullscreen: (fullscreen: boolean, kiosk?: boolean) => Promise<any>
    isFullscreen: () => Promise<FullscreenStatus>
    onFullscreenChange: (callback: (isFullscreen: boolean) => void) => () => void
    getLocation: () => Promise<{
      success: boolean
      latitude?: number
      longitude?: number
      accuracy?: number | null
      source?: string
      error?: string
    }>
    getHardwareAcceleration: () => Promise<HardwareAccelerationStatus>
    setHardwareAcceleration: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean; requiresRestart: boolean }>
    setGpuPreference: (preference: 'auto' | 'discrete' | 'integrated') => Promise<{ success: boolean; gpuPreference: 'auto' | 'discrete' | 'integrated'; requiresRestart: boolean }>
    confirmGpuChange: () => Promise<{ success: boolean }>
    revertGpuChange: () => Promise<{ success: boolean; hardwareAcceleration: boolean; gpuPreference: 'auto' | 'discrete' | 'integrated' }>
  }
  mediaKeys: {
    setEnabled: (enabled: boolean) => Promise<{
      success: boolean
      enabled: boolean
      registrations: Record<string, boolean>
    }>
    onControl: (callback: (action: string, payload?: any) => void) => () => void
  }
  audio: {
    getSystemVolume: () => Promise<{ success: boolean; volume: number }>
  }
  desktopWidgets: {
    getSystemStatus: () => Promise<{
      cpuUsage: number
      memoryUsed: number
      memoryTotal: number
      memoryPercent: number
      disks: Array<{ name: string; used: number; total: number; percent: number }>
      uptime: number
      platform: string
    }>
    pickLauncherTarget: (kind: 'app' | 'folder') => Promise<string | null>
    openLauncherTarget: (target: string, kind: 'app' | 'folder' | 'url') => Promise<{ success: boolean; error?: string }>
  }
  openQQLoginWindow: () => Promise<{ success: boolean; cookie?: string; error?: string }>
  openQQSkillKeyWindow: () => Promise<{ success: boolean; apiKey?: string; error?: string }>
  /** Apple Music 网页一键登录：内置窗口登录 Apple ID，自动抓取 media-user-token 与 Developer Token */
  appleLogin: () => Promise<{ success: boolean; mediaUserToken?: string; developerToken?: string; name?: string; email?: string; realName?: string; avatar?: string; billingAddress?: string; country?: string; paymentType?: string; accountBalance?: string; birthday?: string; language?: string; twoFactor?: string; trustedDevices?: string; passwordUpdated?: string; notificationEmail?: string; signInWithApple?: string; devices?: Array<{ name: string; model: string; icon?: string }>; icons?: Record<string, string>; error?: string }>
  /** 从 Apple 网页前端资源获取可用的 Developer Token（免密钥，约 70 天有效） */
  appleFetchDevToken: () => Promise<{ success: boolean; token?: string; expiresAt?: number; error?: string }>
  /** amp-api 代理（渲染进程直连会被 CORS 拦截，改由主进程请求） */
  appleApi: (path: string, developerToken: string, mediaUserToken: string, method?: string, body?: string | null) =>
    Promise<{ ok: boolean; status: number; data: unknown; error?: string }>
  /** Apple 账号信息（buy.itunes 接口，需登录窗口抓取的 itunes cookie） */
  appleAccountInfo: (cookies: string) => Promise<{ ok: boolean; status: number; data: unknown; error?: string }>
  /** Apple 个人资料页（解析 og:image 头像） */
  appleFetchProfile: (profileUrl: string) => Promise<{ ok: boolean; status: number; html?: string; error?: string }>
  /** Apple 账号页面（Apple ID / Apple Account，带全量会话 cookie 解析名字与头像） */
  appleFetchAccount: (cookies: string) => Promise<{ ok: boolean; status: number; html?: string; error?: string }>
  /** 酷狗音乐登录（Electron 弹窗扫码，抓 kg_token） */
  openKugouLoginWindow: () => Promise<{ success: boolean; cookie?: string; error?: string }>
  /** Spotify OAuth 授权（Electron 弹窗） */
  openSpotifyLogin: () => Promise<{ success: boolean; username?: string; error?: string }>
  /** Spotify 授权完成回调 */
  onSpotifyAuthResult: (callback: (result: { success: boolean; accessToken?: string; refreshToken?: string; username?: string; avatar?: string; userId?: string; error?: string }) => void) => () => void
  /** 汽水音乐登录（Electron 弹窗扫码，抓 token） */
  openSodaLogin: () => Promise<{ success: boolean; token?: string; username?: string; error?: string }>
  /** 渲染进程日志转发到主进程控制台（后台窗口可见） */
  log: (message: string) => void
  wallpaper: {
    getCurrentWallpaper: () => Promise<WallpaperResult>
    onWallpaperChange: (callback: (wallpaper: WallpaperPayload | string) => void) => () => void
  }
  developerMode: {
    set: (enabled: boolean) => Promise<{ success: boolean }>
    get: () => Promise<{ enabled: boolean }>
  }
  deviceLicense: {
    getState: () => Promise<DeviceLicenseStateResult>
    copyDeviceId: () => Promise<DeviceIdentityResult>
    readClipboard?: () => Promise<{ success: true; text: string } | { success: false; error: string }>
    redeem: (code: string) => Promise<DeviceRedeemResult>
    reset: () => Promise<{ success: boolean; removed?: { registry: boolean; file: boolean }; error?: string }>
  }
  render: {
    transition: (plan: TransitionPlan, sourceAudioPath: string, targetAudioPath: string) => Promise<{ 
      success: boolean
      outputPath?: string
      duration?: number
      sampleRate?: number
      channels?: number
      size?: number
      cached?: boolean
      stretchApplied?: boolean
      djEffectsApplied?: boolean
      targetResumeTime?: number
      rendererVersion?: string
      error?: string
    }>
    getAudioUrl?: (filePath: string) => Promise<string>

    readAudioFile: (filePath: string) => Promise<ArrayBuffer>
    clearCache: () => Promise<{ success: boolean }>
    getCacheStats: () => Promise<{ count: number; size: number }>
  }
  audioDownload: {
    prepare: (urlOrPath: string, trackKey: string) => Promise<string>
    cleanupOldFiles: () => Promise<{ success: boolean }>
    getStats: () => Promise<{ fileCount: number; totalSize: number; maxSize: number; cachePath: string }>
    clearCache: () => Promise<{ success: boolean }>
  }
  /** 应用更新：下载安装包（多源逐个尝试）→ sha256 校验 → 打开安装向导 */
  update: {
    downloadAndInstall: (urls: string[], sha256: string) => Promise<{ success: boolean; error?: string; path?: string }>
  }
  config: {
    getCachePath: () => Promise<string>
    setCachePath: (path: string) => Promise<{ success: boolean; error?: string }>
    selectCachePath: () => Promise<string | null>
    resetCachePath: () => Promise<string>
  }
  credentials: {
    getQQMusicSkillKey: () => Promise<{ success: boolean; configured: boolean; key?: string; secure?: boolean; error?: string }>
    setQQMusicSkillKey: (key: string) => Promise<{ success: boolean; configured?: boolean; secure?: boolean; error?: string }>
    deleteQQMusicSkillKey: () => Promise<{ success: boolean; configured?: boolean; error?: string }>
  }
  desktopPlayer: {
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
    setForm: (form: 'card' | 'bar') => Promise<{ success: boolean; form: 'card' | 'bar' }>
    getInitialState: () => Promise<DesktopPlayerSnapshot>
    pushState: (
      partial: Partial<
        Pick<
          DesktopPlayerSnapshot,
          'song' | 'lyric' | 'playing' | 'spectrum' | 'accentColor' | 'playlist' | 'currentIndex' | 'progress' | 'duration' | 'hasTranslation' | 'hasRomaji' | 'volume' | 'muted' | 'page'
        >
      >
    ) => void
    onControl: (callback: (action: string, payload?: number) => void) => () => void
    onEnabledChanged: (callback: (enabled: boolean) => void) => () => void
  }
  desktopLyrics: {
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean }>
    getSettings: () => Promise<DesktopLyricsSettings>
    updateSettings: (partial: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
    onEnabledChanged: (callback: (enabled: boolean) => void) => () => void
  }
  remote: {
    start: (port?: number) => Promise<RemoteStatus & { error?: string }>
    stop: () => Promise<RemoteStatus>
    getStatus: () => Promise<RemoteStatus>
    getSettings: () => Promise<RemoteSettings>
    updateSettings: (partial: Partial<RemoteSettings>) => Promise<RemoteSettings>
    onCursor: (callback: (command: RemoteCursorCommand) => void) => () => void
    onClientsChange: (callback: (status: RemoteStatus) => void) => () => void
  }
}

export interface DesktopPlayerSongInfo {
  name: string
  artists: string
  coverUrl: string
}

export interface DesktopPlayerLyricWord {
  word: string
  startTime: number
  duration: number
}

export interface DesktopPlayerLyric {
  line: string
  translation: string
  romaji?: string
  nextLine?: string
  nextTranslation?: string
  nextRomaji?: string
  words: DesktopPlayerLyricWord[]
  romanWords?: DesktopPlayerLyricWord[]
  lineStart: number
  lineDuration: number
  isInterlude?: boolean
  interludeStartTime?: number
  interludeEndTime?: number
}

export type DesktopLyricsColorMode = 'auto' | 'rose' | 'sky' | 'gold' | 'mint' | 'white'
export type DesktopLyricsOrientation = 'horizontal' | 'vertical'

export interface DesktopLyricsSettings {
  enabled: boolean
  fontSize: number
  colorMode: DesktopLyricsColorMode
  orientation: DesktopLyricsOrientation
  doubleLine: boolean
  translationEnabled: boolean
  romajiEnabled: boolean
  traditionalEnabled: boolean
  locked: boolean
}

// ===== 遥控器（局域网 Web 服务 + 虚拟鼠标）=====
export type RemoteTheme = 'dark' | 'light'
export type RemoteTopRightAction = 'song' | 'comment' | 'artist' | 'favorite' | 'desktop-lyrics' | 'mode-switch'

export interface RemoteGestureSettings {
  doubleTap: boolean
  swipe: boolean
  twoFinger: boolean
  twoFingerTap: boolean
}

export interface RemoteSettings {
  theme: RemoteTheme
  topRightAction: RemoteTopRightAction
  gestures: RemoteGestureSettings
}

export interface RemoteLanAddress {
  name: string
  address: string
}

export interface RemoteClientInfo {
  name: string
  ip: string
  connectedAt: number
}

export interface RemoteStatus {
  running: boolean
  port: number
  token: string
  clientCount: number
  maxClients: number
  clients: RemoteClientInfo[]
  ips: RemoteLanAddress[]
  error?: string
}

export interface RemoteCursorCommand {
  cmd: 'move' | 'click' | 'hold-start' | 'hold-cancel' | 'hold-complete' | 'right-click' | 'scroll'
  dx?: number
  dy?: number
}

export interface DesktopPlayerPlaylistItem {
  index: number
  name: string
  artists: string
}

export interface DesktopPlayerSnapshot {
  song: DesktopPlayerSongInfo | null
  lyric: DesktopPlayerLyric | null
  playing: boolean
  spectrum: number[]
  enabled: boolean
  form: 'card' | 'bar'
  accentColor: string
  playlist: DesktopPlayerPlaylistItem[]
  currentIndex: number
  progress: number
  duration: number
  hasTranslation: boolean
  hasRomaji: boolean
  volume: number
  muted: boolean
  page: 'home' | 'playback'
}

export type DesktopPlayerControlAction =
  | 'play'
  | 'pause'
  | 'toggle'
  | 'next'
  | 'prev'
  | 'close'
  | 'select-index'

export interface DesktopPlayerBridgeAPI {
  getState: () => Promise<DesktopPlayerSnapshot>
  onState: (callback: (state: Partial<DesktopPlayerSnapshot>) => void) => () => void
  sendControl: (action: DesktopPlayerControlAction, payload?: number) => void
  startResize: (point: { x: number; y: number; edge: 'nw' | 'ne' | 'sw' | 'se' }) => void
  resizeTo: (point: { x: number; y: number }) => void
  endResize: () => void
  startDrag: (point: { x: number; y: number }) => void
  dragTo: (point: { x: number; y: number }) => void
  endDrag: () => void
  reportContentHeight: (height: number) => void
  setExpanded: (expanded: boolean) => Promise<{ direction: 'up' | 'down' }>
}

export interface DesktopLyricsBridgeAPI {
  getState: () => Promise<DesktopPlayerSnapshot>
  getSettings: () => Promise<DesktopLyricsSettings>
  onState: (callback: (state: Partial<DesktopPlayerSnapshot>) => void) => () => void
  onSettings: (callback: (settings: DesktopLyricsSettings) => void) => () => void
  updateSettings: (partial: Partial<DesktopLyricsSettings>) => Promise<DesktopLyricsSettings>
  setPanelOpen: (open: boolean) => Promise<{ open: boolean }>
  setMousePassthrough: (passthrough: boolean) => Promise<{ passthrough: boolean }>
  sendControl: (action: DesktopPlayerControlAction) => void
  startResize: (point: { x: number; y: number; edge: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' }) => void
  resizeTo: (point: { x: number; y: number }) => void
  endResize: () => void
  startDrag: (point: { x: number; y: number }) => void
  dragTo: (point: { x: number; y: number }) => void
  endDrag: () => void
}

declare global {
  interface Window {
    electron?: ElectronAPI
    desktopPlayer?: DesktopPlayerBridgeAPI
    desktopLyrics?: DesktopLyricsBridgeAPI
    electronAPI?: {
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      openQQLoginWindow: () => Promise<void>
      onQQLoginResult: (callback: (cookie: string) => void) => void
    }
  }
}

export {}






