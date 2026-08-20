const { contextBridge, ipcRenderer } = require('electron')

// 向渲染进程暴露经过限制的安全 API。
contextBridge.exposeInMainWorld('electronAPI', {
  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // OOBE 完成 flag 文件（userData/.oobe-complete，独立于 localStorage 的双重保险）
  oobe: {
    getFlag: () => ipcRenderer.invoke('oobe:get-flag'),
    setFlag: () => ipcRenderer.invoke('oobe:set-flag'),
  },
})

contextBridge.exposeInMainWorld('electron', {
  // System controls
  system: {
    minimize: () => ipcRenderer.invoke('window-minimize'),
    maximize: () => ipcRenderer.invoke('window-maximize'),
    close: () => ipcRenderer.invoke('window-close'),
    isMaximized: () => ipcRenderer.invoke('window-is-maximized'),
    onMaximizedChange: (callback) => {
      const listener = (_event, isMaximized) => callback(isMaximized)
      ipcRenderer.on('window-maximized', listener)
      return () => ipcRenderer.removeListener('window-maximized', listener)
    },
    setFullscreen: (fullscreen, kiosk = false) => ipcRenderer.invoke('window-set-fullscreen', fullscreen, kiosk),
    isFullscreen: () => ipcRenderer.invoke('window-is-fullscreen'),
    onFullscreenChange: (callback) => {
      const listener = (_event, isFullscreen) => callback(isFullscreen)
      ipcRenderer.on('window-fullscreen-change', listener)
      return () => ipcRenderer.removeListener('window-fullscreen-change', listener)
    },
    getLocation: () => ipcRenderer.invoke('get-system-location'),
    getHardwareAcceleration: () => ipcRenderer.invoke('get-hardware-acceleration'),
    setHardwareAcceleration: (enabled) => ipcRenderer.invoke('set-hardware-acceleration', enabled),
    setGpuPreference: (preference) => ipcRenderer.invoke('set-gpu-preference', preference),
    confirmGpuChange: () => ipcRenderer.invoke('confirm-gpu-change'),
    revertGpuChange: () => ipcRenderer.invoke('revert-gpu-change'),
  },

  mediaKeys: {
    setEnabled: (enabled) => ipcRenderer.invoke('media-keys:set-enabled', enabled),
    onControl: (callback) => {
      const listener = (_event, action, payload) => callback(action, payload)
      ipcRenderer.on('global-media-key', listener)
      return () => ipcRenderer.removeListener('global-media-key', listener)
    },
  },

  // 系统音量（频响补偿 / 低音量提示）
  audio: {
    getSystemVolume: () => ipcRenderer.invoke('audio:get-system-volume'),
  },

  desktopWidgets: {
    getSystemStatus: () => ipcRenderer.invoke('desktop-widgets:get-system-status'),
    pickLauncherTarget: (kind) => ipcRenderer.invoke('desktop-widgets:pick-launcher-target', kind),
    openLauncherTarget: (target, kind) => ipcRenderer.invoke('desktop-widgets:open-launcher-target', target, kind),
  },
  
  // 壁纸相关
  wallpaper: {
    getCurrentWallpaper: () => ipcRenderer.invoke('get-current-wallpaper'),
    onWallpaperChange: (callback) => {
      const listener = (_event, wallpaper) => callback(wallpaper)
      ipcRenderer.on('wallpaper-changed', listener)
      return () => ipcRenderer.removeListener('wallpaper-changed', listener)
    },
    // 按需启停壁纸监控：仅桌面模式 + 联动开启时启用（避免非桌面模式持续查询拖慢性能）
    setWallpaperWatcherEnabled: (enabled) => ipcRenderer.invoke('set-wallpaper-watcher', Boolean(enabled)),
  },
  
  // 开发者模式
  developerMode: {
    set: (enabled) => ipcRenderer.invoke('set-developer-mode', enabled),
    get: () => ipcRenderer.invoke('get-developer-mode'),
  },

  // Device-bound identifier and signed redemption codes
  deviceLicense: {
    getState: () => ipcRenderer.invoke('device-license:get-state'),
    copyDeviceId: () => ipcRenderer.invoke('device-license:copy-id'),
    readClipboard: () => ipcRenderer.invoke('device-license:read-clipboard'),
    redeem: (code) => ipcRenderer.invoke('device-license:redeem', code),
    reset: () => ipcRenderer.invoke('device-license:reset'),
  },
  
  // AutoMix 本地分析与缓存
  analysis: {
    startTrackAnalysis: (input) => ipcRenderer.invoke('analysis:start-track', input),
    getTrackAnalysis: (trackKey) => ipcRenderer.invoke('analysis:get-track', trackKey),
    saveTrackAnalysis: (analysis) => ipcRenderer.invoke('analysis:save-track', analysis),
    cancelJob: (jobId) => ipcRenderer.invoke('analysis:cancel-job', jobId),
    getStatus: () => ipcRenderer.invoke('analysis:get-status'),
    getCacheStats: () => ipcRenderer.invoke('analysis:get-cache-stats'),
    clearCache: () => ipcRenderer.invoke('analysis:clear-cache'),
    onProgress: (callback) => {
      const listener = (_event, progress) => callback(progress)
      ipcRenderer.on('analysis:progress', listener)
      return () => ipcRenderer.removeListener('analysis:progress', listener)
    },
  },
  
  // Seamless transition rendering
  render: {
    transition: (plan, sourceAudioPath, targetAudioPath) => 
      ipcRenderer.invoke('render:transition', plan, sourceAudioPath, targetAudioPath),
    getAudioUrl: (filePath) => ipcRenderer.invoke('render:getAudioUrl', filePath),

    readAudioFile: (filePath) => ipcRenderer.invoke('render:readAudioFile', filePath),
    clearCache: () => ipcRenderer.invoke('render:clearCache'),
    getCacheStats: () => ipcRenderer.invoke('render:getCacheStats'),
    // AI 混音（DJTransGAN）可选引擎：未安装时 transitionAiMix 抛错 / aiMixStatus.available=false
    transitionAiMix: (plan, sourceAudioPath, targetAudioPath) =>
      ipcRenderer.invoke('render:transitionAiMix', plan, sourceAudioPath, targetAudioPath),
    aiMixStatus: () => ipcRenderer.invoke('render:aiMixStatus'),
    // AI 学到的推子/EQ 自动化参数（v2 短过渡用）
    aiMixAutomation: (plan, sourceAudioPath, targetAudioPath) =>
      ipcRenderer.invoke('render:aiMixAutomation', plan, sourceAudioPath, targetAudioPath),
  },
  
  // AutoMix 渲染进程诊断日志：写入后端 automix-backend.log
  automixLog: (scope, message) => ipcRenderer.invoke('automix-log:append', scope, message),
  
  // Audio download for rendering
  audioDownload: {
    prepare: (urlOrPath, trackKey) => 
      ipcRenderer.invoke('audio-download:prepare', urlOrPath, trackKey),
    getMediaUrl: (filePath) => ipcRenderer.invoke('audio-download:getMediaUrl', filePath),
    saveWav: (trackKey, wavArrayBuffer) => ipcRenderer.invoke('audio-download:saveWav', trackKey, wavArrayBuffer),
    cleanupOldFiles: () => ipcRenderer.invoke('audio-download:cleanup'),
    getStats: () => ipcRenderer.invoke('audio-download:get-stats'),
    clearCache: () => ipcRenderer.invoke('audio-download:clear-cache'),
  },

  // 应用更新：多源下载安装包 → sha256 校验 → 打开安装向导
  update: {
    downloadAndInstall: (urls, sha256) =>
      ipcRenderer.invoke('update:download-and-install', urls, sha256),
  },
  
  // 配置管理
  config: {
    getCachePath: () => ipcRenderer.invoke('config:get-cache-path'),
    setCachePath: (path) => ipcRenderer.invoke('config:set-cache-path', path),
    selectCachePath: () => ipcRenderer.invoke('config:select-cache-path'),
    resetCachePath: () => ipcRenderer.invoke('config:reset-cache-path'),
  },

  // 账号绑定的 QQ 音乐官方 Skills Key（由主进程使用系统安全存储加密）
  credentials: {
    getQQMusicSkillKey: () => ipcRenderer.invoke('credentials:get-qqmusic-skill-key'),
    setQQMusicSkillKey: (key) => ipcRenderer.invoke('credentials:set-qqmusic-skill-key', key),
    deleteQQMusicSkillKey: () => ipcRenderer.invoke('credentials:delete-qqmusic-skill-key'),
  },
  
  // QQ 音乐登录
  openQQLoginWindow: () => ipcRenderer.invoke('open-qq-login-window'),
  // 酷狗音乐登录（Electron 弹窗扫码，抓 kg_token/KuGoo）
  openKugouLoginWindow: () => ipcRenderer.invoke('open-kugou-login-window'),
  clearKugouSession: () => ipcRenderer.invoke('kugou-clear-session'),
  // 读取当前会话的酷狗登录态（启动时自动恢复）
  getKugouSession: () => ipcRenderer.invoke('get-kugou-session'),
  // Spotify OAuth 授权（Electron 弹窗；clientId 可选，自定义 Client ID）
  openSpotifyLogin: (clientId) => ipcRenderer.invoke('open-spotify-login', clientId),
  // 汽水音乐登录（Electron 弹窗扫码，抓 token）
  openSodaLogin: () => ipcRenderer.invoke('open-soda-login'),
  // 汽水音乐（抖音）数据桥：隐藏窗口导航抖音搜索页抓取音乐卡片
  sodaScrapeSearch: (keyword) => ipcRenderer.invoke('soda-scrape-search', keyword),
  // 酷狗数据桥：隐藏窗口页面内同源 fetch 用户歌单/用户信息（绕开服务端 WAF）
  kugouScrape: {
    userPlaylists: () => ipcRenderer.invoke('kugou-scrape-user-playlists'),
    userInfo: () => ipcRenderer.invoke('kugou-scrape-user-info'),
  },
  // OOBE 完成 flag 文件（userData/.oobe-complete，独立于 localStorage 的双重保险）
  oobe: {
    getFlag: () => ipcRenderer.invoke('oobe:get-flag'),
    setFlag: () => ipcRenderer.invoke('oobe:set-flag'),
  },
  // Spotify 授权完成后回调（主进程返回 token/用户名）
  onSpotifyAuthResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('spotify-auth-result', listener)
    return () => ipcRenderer.removeListener('spotify-auth-result', listener)
  },
  // 酷狗登录完成后回调（主进程返回用户名/ID/头像）
  onKugouAuthResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('kugou-auth-result', listener)
    return () => ipcRenderer.removeListener('kugou-auth-result', listener)
  },
  // 汽水登录完成后回调（主进程返回用户名/头像）
  onSodaAuthResult: (callback) => {
    const listener = (_event, result) => callback(result)
    ipcRenderer.on('soda-auth-result', listener)
    return () => ipcRenderer.removeListener('soda-auth-result', listener)
  },

  // Apple Music 网页一键登录：内置窗口登录 Apple ID，自动抓取凭据
  appleLogin: () => ipcRenderer.invoke('apple-login'),
  // 从 Apple 网页前端资源获取可用的 Developer Token（免密钥，约 70 天有效）
  appleFetchDevToken: () => ipcRenderer.invoke('apple-fetch-dev-token'),
  // amp-api 代理：渲染进程浏览器直连会被 CORS 拦截，改由主进程请求
  appleApi: (path, developerToken, mediaUserToken, method, body) =>
    ipcRenderer.invoke('apple-api', { path, developerToken, mediaUserToken, method, body }),
  // Apple 账号信息（buy.itunes 接口，需登录窗口抓取的 itunes cookie）
  appleAccountInfo: (cookies) => ipcRenderer.invoke('apple-account-info', cookies),
  // Apple 个人资料页（解析 og:image 头像）
  appleFetchProfile: (profileUrl) => ipcRenderer.invoke('apple-fetch-profile', profileUrl),
  // Apple 账号页面（Apple ID / Apple Account，带全量会话 cookie 解析名字与头像）
  appleFetchAccount: (cookies) => ipcRenderer.invoke('apple-fetch-account', cookies),
  // 渲染进程日志转发到主进程控制台（后台窗口可见，便于排查）
  log: (message) => ipcRenderer.send('app-log', String(message)),

  // QQ 音乐官方 Skills Key 领取窗口（内置 Electron 窗口，登录后自动抓取 API Key）
  openQQSkillKeyWindow: () => ipcRenderer.invoke('open-qq-skill-key-window'),

  // 桌面播放器：主窗口侧桥接（状态上报 + 接收小窗口的控制指令 + 开关/形态设置）
  desktopPlayer: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-player:set-enabled', enabled),
    setForm: (form) => ipcRenderer.invoke('desktop-player:set-form', form),
    getInitialState: () => ipcRenderer.invoke('desktop-player:get-state'),
    pushState: (partial) => ipcRenderer.send('desktop-player:state-update', partial),
    onControl: (callback) => {
      const listener = (_event, action, payload) => callback(action, payload)
      ipcRenderer.on('desktop-player:control', listener)
      return () => ipcRenderer.removeListener('desktop-player:control', listener)
    },
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-player:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-player:enabled-changed', listener)
    },
  },

  // 桌面歌词：独立透明置顶窗口的开关与外观设置。
  desktopLyrics: {
    setEnabled: (enabled) => ipcRenderer.invoke('desktop-lyrics:set-enabled', enabled),
    getSettings: () => ipcRenderer.invoke('desktop-lyrics:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('desktop-lyrics:update-settings', partial),
    onEnabledChanged: (callback) => {
      const listener = (_event, enabled) => callback(enabled)
      ipcRenderer.on('desktop-lyrics:enabled-changed', listener)
      return () => ipcRenderer.removeListener('desktop-lyrics:enabled-changed', listener)
    },
  },

  // 遥控器：局域网 Web 服务（手机扫码连接）+ 虚拟鼠标桥接
  remote: {
    start: (port) => ipcRenderer.invoke('remote:start', port),
    stop: () => ipcRenderer.invoke('remote:stop'),
    getStatus: () => ipcRenderer.invoke('remote:get-status'),
    getSettings: () => ipcRenderer.invoke('remote:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('remote:update-settings', partial),
    onCursor: (callback) => {
      const listener = (_event, command) => callback(command)
      ipcRenderer.on('remote:cursor', listener)
      return () => ipcRenderer.removeListener('remote:cursor', listener)
    },
    onClientsChange: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('remote:clients', listener)
      return () => ipcRenderer.removeListener('remote:clients', listener)
    },
  },

  // AirPlay 投送端：发现局域网 AirPlay 设备并推送本地播放的音频（默认关闭，由设置开关启用）
  airplay: {
    setEnabled: (enabled) => ipcRenderer.invoke('airplay:set-enabled', enabled),
    listDevices: () => ipcRenderer.invoke('airplay:list-devices'),
    getStatus: () => ipcRenderer.invoke('airplay:get-status'),
    connect: (deviceId, mode = 'auto') => ipcRenderer.invoke('airplay:connect', deviceId, mode),
    disconnect: () => ipcRenderer.invoke('airplay:disconnect'),
    setVolume: (volume) => ipcRenderer.invoke('airplay:set-volume', volume),
    setRestoreVolume: (volume) => ipcRenderer.invoke('airplay:set-restore-volume', volume),
    setMetadata: (metadata) => ipcRenderer.invoke('airplay:set-metadata', metadata),
    setProgress: (elapsed, duration) => ipcRenderer.invoke('airplay:set-progress', elapsed, duration),
    playConnectSound: () => ipcRenderer.invoke('airplay:play-connect-sound'),
    sendPcm: (chunk) => ipcRenderer.send('airplay:pcm', chunk),
    setStreaming: (streaming) => ipcRenderer.send('airplay:set-streaming', streaming),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('airplay:status', listener)
      return () => ipcRenderer.removeListener('airplay:status', listener)
    },
  },

  // 音频输出设备：enumerateDevices 的权限授权已在 main 侧完成，这里仅暴露工具接口
  audioOutput: {
    isSupported: () => ipcRenderer.invoke('audio-output:is-supported'),
  },

  // 任务栏迷你播控（贴任务栏带）：开关/位置/宽度设置（个性化页控制）
  taskbarWidget: {
    setEnabled: (enabled) => ipcRenderer.invoke('taskbar-widget:set-enabled', enabled),
    getSettings: () => ipcRenderer.invoke('taskbar-widget:get-settings'),
    updateSettings: (partial) => ipcRenderer.invoke('taskbar-widget:update-settings', partial),
  },
})



