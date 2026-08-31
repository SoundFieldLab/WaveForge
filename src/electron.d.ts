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
  /** 主进程自记的"扩大态"（kiosk 全屏/原生全屏/最大化任一成立）。
   *  Windows kiosk 路径下 fullscreen/kiosk/maximized 查询可能全为 false，需优先取此字段。 */
  expanded?: boolean
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

/** 单目标联通状态结果（最多 8 次，整体超 1 分钟标记 timeout） */
export interface HostLatencyResult {
  timeout: boolean
  total: number
  loss: number
  lossRate: number
  avgLatency: number
  minLatency: number
  maxLatency: number
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
  /** 全局高刷：显示器信息与全局渲染帧率控制（跟随所在显示器，最高 360Hz） */
  display: {
    getInfo: () => Promise<{
      highRefreshEnabled: boolean
      highRefreshHz: number | null
      currentHz: number
      primary: number
      mainWindowDisplayId: number
      error?: string
      displays: Array<{
        id: number
        isPrimary: boolean
        isMainWindow: boolean
        bounds: { x: number; y: number; width: number; height: number }
        workArea: { x: number; y: number; width: number; height: number }
        frequency: number
        scaleFactor: number
        label: string
      }>
    }>
    setHighRefresh: (enabled: boolean, hz?: number | null) => Promise<{ success: boolean; enabled: boolean; hz: number }>
  }
  /** 桌面融合穿透：桌面模式空区域鼠标穿透到真实桌面，组件区保持可交互 */
  desktopFusion: {
    getState: () => Promise<{ enabled: boolean }>
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled: boolean; recreated?: boolean }>
    setInteractive: (interactive: boolean) => void
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
  /** 退出登录时清除共享 session 的 kugou.com Cookie（防止登录弹窗带出旧账号） */
  clearKugouSession: () => Promise<{ success: boolean }>
  /** Spotify OAuth 授权（Electron 弹窗；clientId 可选，自定义 Client ID） */
  openSpotifyLogin: (clientId?: string) => Promise<{ success: boolean; username?: string; error?: string }>
  /** Spotify 授权完成回调 */
  onSpotifyAuthResult: (callback: (result: { success: boolean; accessToken?: string; refreshToken?: string; username?: string; avatar?: string; userId?: string; error?: string }) => void) => () => void
  /** 汽水音乐登录（Electron 弹窗扫码，抓 token） */
  openSodaLogin: () => Promise<{ success: boolean; token?: string; username?: string; error?: string }>
  /** 汽水音乐登出清理（清 auth 分区 .qishui.com Cookie/本地存储 + 凭据文件会话字段；TV/旧版 preload 可能缺失） */
  clearSodaLogin?: () => Promise<{ success: boolean; error?: string }>
  /** HSE 开发者模式：把场景微调的「发布种子」写回仓库源文件（仅开发模式；TV/网页端缺失） */
  writeHseSceneSeed?: (content: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  /** HSE 离线导出：渲染完成的 MP3 写到桌面（重名自动加序号；TV/网页端缺失走浏览器下载） */
  saveHseRenderedAudio?: (data: Uint8Array, fileName: string) => Promise<{ ok: boolean; path?: string; error?: string }>
  /** 汽水音乐（抖音）数据桥：隐藏窗口抓取抖音音乐卡片 */
  sodaScrapeSearch: (keyword: string) => Promise<{ success: boolean; items?: Array<{ id: string; name: string; author?: string; cover?: string; text?: string }>; error?: string }>
  /** 酷狗数据桥：隐藏窗口页面内同源 fetch 用户歌单/用户信息（绕开服务端 WAF） */
  kugouScrape: {
    userPlaylists: () => Promise<{ success: boolean; playlists?: Array<{ specialid: string; name: string; img?: string; songcount?: number; playcount?: number }>; error?: string }>
    userInfo: () => Promise<{ success: boolean; info?: { nickname: string; user_id: string; avatar: string } | null; error?: string }>
  }
  /** 渲染进程日志转发到主进程控制台（后台窗口可见） */
  log: (message: string) => void
  wallpaper: {
    getCurrentWallpaper: () => Promise<WallpaperResult>
    onWallpaperChange: (callback: (wallpaper: WallpaperPayload | string) => void) => () => void
    /** 按需启停壁纸监控：仅桌面模式 + 壁纸联动开启时启用（避免非桌面模式持续查询拖慢性能） */
    setWallpaperWatcherEnabled: (enabled: boolean) => Promise<{ success: boolean }>
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
    /** AI 混音（DJTransGAN）：返回模型窗口的 transitionStart / targetResumeTime（长混音语义） */
    transitionAiMix?: (plan: TransitionPlan, sourceAudioPath: string, targetAudioPath: string) => Promise<{
      success: boolean
      outputPath?: string
      duration?: number
      transitionStart?: number
      targetResumeTime?: number
      aiMixApplied?: boolean
      rendererVersion?: string
      /** 混音尾段 target 内容相对原曲的播放速度比（>1 快 / <1 慢），overlap handoff 用 */
      mixSpeedRatio?: number
      error?: string
    }>
    /** AI 混音引擎可用性探测 */
    aiMixStatus?: () => Promise<{
      available: boolean
      hasTorch?: boolean
      weightReady?: boolean
      repoReady?: boolean
      repoDir?: string | null
      python?: string | null
      reason?: string
    }>
    /** AI 学到的推子/EQ 自动化参数（v2 短过渡用；引擎不可用返回 success=false） */
    aiMixAutomation?: (plan: TransitionPlan, sourceAudioPath: string, targetAudioPath: string) => Promise<{
      success: boolean
      params?: Array<{ band: number[][][]; fader: number[][][][] }>
      error?: string
    }>
  }
  /** AI 混音模型（DJTransGAN 仓库 + 预训练权重 + 运行环境）下载/删除管理 */
  aiModel?: {
    getStatus: () => Promise<{
      installed: boolean
      repoReady: boolean
      weightsReady: boolean
      pythonFound: boolean
      depsReady: boolean
      engineAvailable: boolean
      repoDir: string
    }>
    download: () => Promise<{ ok: boolean; already?: boolean }>
    pause: () => Promise<{ ok: boolean }>
    cancel: () => Promise<{ ok: boolean }>
    delete: () => Promise<{ ok: boolean; error?: string }>
    onProgress: (callback: (progress: {
      status: 'idle' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled' | 'deleting'
      phase: 'python' | 'pip' | 'deps' | 'repo' | 'weights' | 'delete' | null
      phaseLabel: string | null
      phasePercent: number
      overallPercent: number
      error: string | null
      done: boolean
      downloadSpeed: number
      downloadEta: number | null
    }) => void) => () => void
  }
  /** 单目标联通状态结果（最多 8 次，整体超 1 分钟标记 timeout） */
  proxyManager?: {
    scan: () => Promise<Array<{ host: string; port: number; type: string; latency: number }>>
    enable: (port: number) => Promise<{ enabled: boolean; proxy: { host: string; port: number; type: string } | null }>
    disable: () => Promise<{ enabled: boolean; proxy: null }>
    getState: () => Promise<{ enabled: boolean; proxy: { host: string; port: number; type: string } | null }>
    setEnabled: (v: boolean) => Promise<{ enabled: boolean; proxy: { host: string; port: number; type: string } | null }>
    consumeNotice: () => Promise<'startup-unavailable' | 'startup-unusable' | null>
    getLatency: () => Promise<{
      status: 'testing' | 'done'
  /** Apple 播放面 bridge（WebView2 原生源）：主进程拉起 apple_bridge.py（幂等） */
  spawnAppleBridge?: () => Promise<{ ok: boolean; token?: string }>
  /** Apple 播放面 bridge：渲染端节能联动主动关闭（离开 Apple 平台 5 分钟） */
  stopAppleBridge?: () => Promise<boolean>
      result: {
        baidu: HostLatencyResult
        github: HostLatencyResult
        google: HostLatencyResult
      } | null
    } | null>
    probe: () => Promise<{
      status: 'testing' | 'done'
      result: {
        baidu: HostLatencyResult
        github: HostLatencyResult
        google: HostLatencyResult
      } | null
    }>
    onLatency: (callback: (latency: {
      status: 'testing' | 'done'
      result: {
        baidu: HostLatencyResult
        github: HostLatencyResult
        google: HostLatencyResult
      } | null
    }) => void) => () => void
    onNotice: (callback: (notice: { kind: 'disconnected' | 'startup-unavailable' }) => void) => () => void
  }
  /** AutoMix 渲染进程诊断日志：写入后端 automix-backend.log（便于前后端合并定位） */
  automixLog?: (scope: string, message: string) => Promise<boolean>
  audioDownload: {
    prepare: (urlOrPath: string, trackKey: string) => Promise<string>
    /** 只读缓存命中检查：已缓存返回本地路径，未缓存返回 null（不触发下载） */
    peekCached?: (trackKey: string) => Promise<string | null>
    /** 把已下载的音频文件映射为渲染进程可 fetch 的 waveforge-media:// URL（浏览器分析 m4a/aac 用） */
    getMediaUrl?: (filePath: string) => Promise<string>
    /** 保存渲染进程转码的 WAV（Chromium 解码 m4a/aac → 16bit PCM），返回路径；同 key 复用 */
    saveWav?: (trackKey: string, wavArrayBuffer: ArrayBuffer) => Promise<string>
    cleanupOldFiles: () => Promise<{ success: boolean }>
    getStats: () => Promise<{ fileCount: number; totalSize: number; maxSize: number; cachePath: string }>
    clearCache: () => Promise<{ success: boolean }>
  }
  /** 应用更新：下载安装包（多源逐个尝试）→ sha256 校验 → 打开安装向导 */
  update: {
    downloadAndInstall: (urls: string[], sha256: string) => Promise<{ success: boolean; error?: string; path?: string }>
    downloadBackground: (payload: { version: string; notes: string; urls: string[]; sha256: string }) => Promise<{ success: boolean; error?: string }>
    applyPending: () => Promise<{ success: boolean }>
    restartForUpdate: () => Promise<{ success: boolean }>
    getPending: () => Promise<{ version: string; notes: string; stagedAt: number } | null>
    consumeLastApplied: () => Promise<{ version: string; notes: string; appliedAt: number } | null>
    onDownloadStatus: (callback: (status: { state: 'progress' | 'done' | 'failed'; percent?: number; version?: string; notes?: string; error?: string }) => void) => () => void
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
  airplay: {
    setEnabled: (enabled: boolean) => Promise<AirplayStatus>
    listDevices: () => Promise<AirplayDeviceInfo[]>
    getStatus: () => Promise<AirplayStatus>
    connect: (deviceId: string, mode?: 'auto' | 'raop' | 'airplay2') => Promise<{ success: boolean; mode?: string; port?: number; error?: string }>
    disconnect: () => Promise<{ success: boolean }>
    setVolume: (volume: number) => Promise<{ success: boolean }>
    /** 记录连接前/断开后应恢复的设备音量（0-100） */
    setRestoreVolume: (volume: number) => Promise<{ success: boolean }>
    setMetadata: (metadata: AirplayMetadata) => Promise<{ success: boolean }>
    setProgress: (elapsed: number, duration: number) => Promise<{ success: boolean }>
    /** 连接提示音在 AirPlay 设备上播放（主进程合成并推入发送管道） */
    playConnectSound: () => Promise<{ success: boolean }>
    sendPcm: (chunk: ArrayBuffer | Uint8Array) => void
    setStreaming: (streaming: boolean) => void
    onStatus: (callback: (status: AirplayStatus) => void) => () => void
  }
  audioOutput: {
    isSupported: () => Promise<boolean>
  }
  taskbarWidget: {
    setEnabled: (enabled: boolean) => Promise<{ success: boolean; enabled?: boolean; reason?: string }>
    getSettings: () => Promise<TaskbarWidgetSettings>
    updateSettings: (partial: Partial<TaskbarWidgetSettings>) => Promise<TaskbarWidgetSettings>
  }
}

export interface TaskbarWidgetSettings {
  enabled: boolean
  position: 'right' | 'center'
  width: number
  mode: 'normal' | 'pure'
  darken: boolean
  darkenLevel: number
  hideControls: boolean
}

export interface AirplayDeviceInfo {
  id: string
  host: string
  addresses: string[]
  name: string
  hasRaop: boolean
  hasAirplay2: boolean
  raopPort: number | null
  airplayPort: number | null
  txt: Record<string, string>
}

export type AirplayPhase = 'idle' | 'browsing' | 'connecting' | 'connected' | 'streaming' | 'error'

export interface AirplayStatus {
  phase: AirplayPhase
  message: string
  devices: AirplayDeviceInfo[]
  connectedDeviceId: string | null
  connectedMode: string | null
  streaming: boolean
  volume: number
}

export interface AirplayMetadata {
  trackKey?: string
  title?: string
  artist?: string
  album?: string
  coverUrl?: string
  durationMs?: number
  elapsedMs?: number
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






