const electronProcessStartedAt = performance.now()

// 强制设置 Node.js 输出编码为 UTF-8
if (process.stdout && typeof process.stdout.setDefaultEncoding === 'function') {
  process.stdout.setDefaultEncoding('utf8')
}
if (process.stderr && typeof process.stderr.setDefaultEncoding === 'function') {
  process.stderr.setDefaultEncoding('utf8')
}

// 防 EPIPE 崩溃：stdout/stderr 管道被关闭（如从启动器/脚本 detached 启动后管道断开、
// GUI 环境无控制台等）时，console.log 写已关闭管道会抛未捕获异常导致主进程崩溃。
// 捕获 'error' 事件静默吞掉 EPIPE（broken pipe），其他错误仍抛出。
for (const stream of [process.stdout, process.stderr]) {
  if (stream) {
    stream.on('error', (error) => {
      if (error && error.code === 'EPIPE') return
      throw error
    })
  }
}

// Avoid spawning chcp/cmd.exe here. Electron is a GUI process, and the child
// console can flash visibly whenever the main process is initialized.
const { app, BrowserWindow, ipcMain, protocol, shell, session, safeStorage, dialog, globalShortcut, clipboard, utilityProcess, net, nativeImage } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const {
  loadWindowState,
  saveWindowState,
  clampBoundsToWorkArea,
} = require('./window-state.cjs')
const startupTimingLogPath = process.env.WAVEFORGE_STARTUP_LOG || ''
function logStartupTiming(message) {
  const line = '[Electron +' + Math.round(performance.now() - electronProcessStartedAt) + 'ms] ' + message
  console.log(line)
  if (startupTimingLogPath) {
    try { fs.appendFileSync(startupTimingLogPath, line + '\n', 'utf8') } catch {}
  }
}

const performanceSettingsPath = path.join(app.getPath('userData'), 'performance-settings.json')
const shortcutSettingsPath = path.join(app.getPath('userData'), 'shortcut-settings.json')
// 全局高刷：渲染帧率可选档位范围（跟随所在显示器刷新率，最高 360Hz）
const HIGH_REFRESH_MIN_HZ = 30
const HIGH_REFRESH_MAX_HZ = 360

function readPerformanceSettings() {
  const defaults = { hardwareAcceleration: true, gpuPreference: 'auto', pendingGpuChange: null, highRefreshRate: false, highRefreshHz: null }
  try {
    const parsed = JSON.parse(fs.readFileSync(performanceSettingsPath, 'utf8'))
    const gpuPreference = ['auto', 'discrete', 'integrated'].includes(parsed?.gpuPreference)
      ? parsed.gpuPreference
      : defaults.gpuPreference
    const pending = parsed?.pendingGpuChange
    const savedHz = Number(parsed?.highRefreshHz)
    return {
      hardwareAcceleration: parsed?.hardwareAcceleration !== false,
      gpuPreference,
      pendingGpuChange: (pending && (pending.type === 'preference' || pending.type === 'acceleration')) ? pending : null,
      highRefreshRate: parsed?.highRefreshRate === true,
      highRefreshHz: Number.isInteger(savedHz) && savedHz >= 30 && savedHz <= HIGH_REFRESH_MAX_HZ ? savedHz : null,
    }
  } catch {
    return { ...defaults }
  }
}

function writePerformanceSettings(settings) {
  try {
    const temporaryPath = `${performanceSettingsPath}.tmp`
    fs.mkdirSync(path.dirname(performanceSettingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify(settings), 'utf8')
    fs.renameSync(temporaryPath, performanceSettingsPath)
  } catch (error) {
    console.error('[性能设置] 保存失败:', error?.message || error)
  }
}

const performanceSettings = readPerformanceSettings()
// Media Foundation Widevine CDM 实验已移除：castLabs 官方确认该 Windows L1 路径仅为历史实验，
// 已在近期 Chromium/ECS 中废弃且不支持 VMP。Apple 原生 CENC 应使用 ECS 默认 Browser CDM (L3)，
// 并单独验证生产 EVS/VMP 签名；不要再注入 ExternalClearKeyForTesting/media_foundation_cdm_path。
// 全局高刷：用户手动选了具体档位时，启动即用 --force-frame-rate 强制 Chromium 帧率
// （比运行时 setFrameRate 更可靠；「跟随显示器最高」档在 app ready 后按显示器实时应用）
if (performanceSettings.highRefreshRate === true && performanceSettings.highRefreshHz) {
  try { app.commandLine.appendSwitch('force-frame-rate', String(performanceSettings.highRefreshHz)) } catch { /* 忽略 */ }
}
// 软件合成标记：GPU 合成器禁用时置 true（app ready 后由 getGPUFeatureStatus 判定）。
// createWindow 据此动态调整 splash 最短可见时间（软件合成下内容层提交慢）。
let gpuCompositingDisabled = false
if (!performanceSettings.hardwareAcceleration) {
  app.disableHardwareAcceleration()
} else if (performanceSettings.gpuPreference === 'discrete') {
  // 强制使用独立显卡（高性能 GPU）
  app.commandLine.appendSwitch('force_high_performance_gpu')
} else if (performanceSettings.gpuPreference === 'integrated') {
  // 强制使用核显/集成显卡（低功耗 GPU）
  app.commandLine.appendSwitch('force_low_power_gpu')
}

// ── Widevine CDM 引导（Apple Music 原生音源：HLS 流走 EME 解密的钥匙）────────
// 标准 Electron 不带 Widevine CDM。扫描系统已安装 Edge/Chrome 的 Widevine 组件，
// app ready 前通过 --widevine-cdm-path/version 注入；找不到时渲染层自动回退
// 网易云/QQ 载体匹配（AM 原生音源仅在有 Widevine 的环境可用，Cider 同款思路）。
function findWidevineCdm() {
  const candidates = []
  const roots = [process.env['ProgramFiles(x86)'], process.env['ProgramFiles'], process.env.LOCALAPPDATA]
  for (const base of roots) {
    if (!base) continue
    for (const appDir of ['Microsoft/Edge/Application', 'Google/Chrome/Application']) {
      const versionsDir = path.join(base, appDir)
      let entries = []
      try { entries = fs.readdirSync(versionsDir) } catch { continue }
      for (const version of entries) {
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) continue
        candidates.push({
          version,
          root: path.join(versionsDir, version, 'WidevineCdm'),
          manifestPath: path.join(versionsDir, version, 'WidevineCdm', 'manifest.json'),
          dllDir: path.join(versionsDir, version, 'WidevineCdm', '_platform_specific', 'win_x64'),
        })
      }
    }
  }
  candidates.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
  // 标准布局（Chrome/Edge 一致）：manifest.json 在 WidevineCdm 根，DLL 在
  // _platform_specific/win_x64/。Electron 的 --widevine-cdm-path 必须指向含
  // manifest.json 的根目录；--widevine-cdm-version 必须等于 manifest 里的
  // CDM 版本（4.x），若错填浏览器版本号（151.x）EME 会直接 Unsupported keySystem。
  for (const c of candidates) {
    try {
      if (!fs.existsSync(path.join(c.dllDir, 'widevinecdm.dll')) || !fs.existsSync(c.manifestPath)) continue
      const manifest = JSON.parse(fs.readFileSync(c.manifestPath, 'utf8'))
      const cdVersion = manifest && typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : ''
      if (!cdVersion) continue
      return { path: c.root, version: cdVersion }
    } catch { /* 继续下一个候选 */ }
  }
  // 个别构建把 manifest.json 放在 win_x64 内：按"根目录含 manifest"重新找一遍
  for (const c of candidates) {
    try {
      const innerManifest = path.join(c.dllDir, 'manifest.json')
      if (!fs.existsSync(path.join(c.dllDir, 'widevinecdm.dll')) || !fs.existsSync(innerManifest)) continue
      const manifest = JSON.parse(fs.readFileSync(innerManifest, 'utf8'))
      const cdVersion = manifest && typeof manifest.version === 'string' && manifest.version.trim() ? manifest.version.trim() : ''
      if (!cdVersion) continue
      return { path: c.dllDir, version: cdVersion }
    } catch { /* 继续下一个候选 */ }
  }
  return null
}
// ── Widevine 运行时判定 ────────────────────────────────────────────────────
// castlabs ECS（Electron for Content Security，带 Widevine 的官方分叉）自带
// 组件更新服务管理 CDM，无需借系统 Chrome/Edge 的组件；标准 Electron 才走
// 下面基于 --widevine-cdm-* 开关的注入。判断依据：ECS 提供 components API。
function isEcsBuild() {
  try {
    const { components } = require('electron')
    return Boolean(components && typeof components.whenReady === 'function')
  } catch {
    return false
  }
}

// ── ECS 完全离线播种（第一启动预置 Widevine CDM）────────────────────────────
// ECS 的 CUS（组件更新服务）判定"已安装"的依据 = Local State 里 updateclientdata
// 注册（appId=oimompecagnajdejgnnjijobebaeigek，pv=版本）+ userData/WidevineCdm/
// <版本>/ 下的文件。实测（本机）：播种后在 Google 完全不可达的情况下 EME 仍
// OK（更新检查失败不会移除本地组件）。因此：首次启动若发现未注册，就从系统
// Chrome/Edge 复制 CDM 并写入注册 → 用户端零 Google 依赖；有网络的机器 CUS
// 照常日后自动升级 CDM。
const ECS_WIDEVINE_APP_ID = 'oimompecagnajdejgnnjijobebaeigek'
function findExistingEcsCdmVersion(userDataDir) {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'))
    const entry = localState?.updateclientdata?.apps?.[ECS_WIDEVINE_APP_ID]
    const pv = entry && typeof entry.pv === 'string' ? entry.pv : ''
    if (!pv) return ''
    const versionDir = path.join(userDataDir, 'WidevineCdm', pv)
    return fs.existsSync(path.join(versionDir, 'manifest.json')) ? pv : ''
  } catch {
    return ''
  }
}

/** 点分版本号比较：a > b 返回 true */
function versionNewerEcs(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0
  }
  return false
}
function seedEcsOfflineCdm() {
  try {
    const userDataDir = app.getPath('userData')
    const existing = findExistingEcsCdmVersion(userDataDir)
    const source = findWidevineCdm() // 系统 Chrome/Edge 的 CDM（含 manifest 版本）
    if (!source) {
      if (!existing) console.log('[Widevine] 离线播种：未找到系统 Chrome/Edge CDM（CUS 将尝试联网安装）')
      return
    }
    // CDM 补丁级过期会被 Apple license 服务器拒绝（-1021/42605 WIDEVINE_CDM_EXPIRED）。
    // 系统 Chrome/Edge 出了更新 CDM 时要升级播种目录并刷新 Local State 注册，
    // 不能因「已注册」就永远停在旧版本上。
    const versionNewer = (a, b) => {
      const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0)
      const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d) return d > 0
      }
      return false
    }
    if (existing && !versionNewer(source.version, existing)) return // 已是最新 → 无需播种
    const version = source.version
    const vdir = path.join(userDataDir, 'WidevineCdm', version)
    fs.mkdirSync(path.join(vdir, '_platform_specific', 'win_x64'), { recursive: true })
    const copyIfExists = (from, to) => {
      if (fs.existsSync(from)) {
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.copyFileSync(from, to)
      }
    }
    copyIfExists(path.join(source.path, 'manifest.json'), path.join(vdir, 'manifest.json'))
    copyIfExists(path.join(source.path, 'LICENSE'), path.join(vdir, 'LICENSE'))
    copyIfExists(path.join(source.path, 'LICENSE.txt'), path.join(vdir, 'LICENSE'))
    const spSrc = path.join(source.path, '_platform_specific', 'win_x64')
    copyIfExists(path.join(spSrc, 'widevinecdm.dll'), path.join(vdir, '_platform_specific', 'win_x64', 'widevinecdm.dll'))
    copyIfExists(path.join(spSrc, 'widevinecdm.dll.sig'), path.join(vdir, '_platform_specific', 'win_x64', 'widevinecdm.dll.sig'))
    copyIfExists(path.join(source.path, '_metadata', 'verified_contents.json'), path.join(vdir, '_metadata', 'verified_contents.json'))
    // Local State 注册（ECS CUS 识别"已安装"的依据）
    const localStatePath = path.join(userDataDir, 'Local State')
    let localState = {}
    try { localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) } catch { localState = {} }
    if (!localState.updateclientdata) localState.updateclientdata = {}
    if (!localState.updateclientdata.apps) localState.updateclientdata.apps = {}
    localState.updateclientdata.apps[ECS_WIDEVINE_APP_ID] = {
      cohort: '1:3cjr:',
      cohortname: 'Auto',
      fp: '',
      installdate: 7178,
      max_pv: '0.0.0.0',
      pf: '49b89fa4-5266-481b-af73-868305d174b0',
      pv: version,
    }
    fs.writeFileSync(localStatePath, JSON.stringify(localState), 'utf8')
    logStartupTiming(`[Widevine] 离线播种${existing ? `升级（${existing} → ${version}）` : '完成'}：CDM ${version} -> ${vdir}`)
  } catch (error) {
    console.warn('[Widevine] 离线播种失败（不影响启动，CUS 将尝试联网安装）:', error?.message || error)
  }
}
if (isEcsBuild()) {
  console.log('[Widevine] 检测到 castlabs ECS 运行时：CDM 由组件服务管理，跳过自定义注入')
  // 优先让 castlabs CUS 联网下载**官方预配置 CDM**（其设备证书被 Apple license 服务接受；
  // 我们播种的 Chrome/Edge 经典 L3 CDM 会被 Apple 以 -1021 拒绝）。仅当网络不可达、
  // CUS 拿不到组件时，才落盘播种系统 Chrome/Edge 的 CDM 兜底（保证 EME 可用、
  // Apple 原生音源虽不可用但结构完整，其余 DRM 场景不受影响）。
  app.whenReady().then(async () => {
    try {
      const { components } = require('electron')
      await components.whenReady()
      // CUS 下载窗口：castlabs 组件包约 20MB+，慢网络需要时间
      await new Promise(resolve => setTimeout(resolve, 15000))
      const list = (typeof components.getComponents === 'function' ? components.getComponents() : {}) || {}
      const cdm = list[ECS_WIDEVINE_APP_ID]
      const cusVersion = cdm && typeof cdm.version === 'string' ? cdm.version : ''
      const seeded = findExistingEcsCdmVersion(app.getPath('userData'))
      if (cusVersion && (!seeded || versionNewerEcs(cusVersion, seeded))) {
        console.log(`[Widevine] CUS 已提供 castlabs 官方 CDM ${cusVersion}，使用正版组件（不播种）`)
        return
      }
      if (seeded) return // 播种版仍是在用的最新可用版本
    } catch (error) {
      console.warn('[Widevine] CUS 状态检查失败:', error?.message || error)
    }
    seedEcsOfflineCdm()
  }).catch(() => seedEcsOfflineCdm())
} else {
  try {
    const widevine = findWidevineCdm()
    if (widevine) {
      app.commandLine.appendSwitch('widevine-cdm-path', widevine.path)
      app.commandLine.appendSwitch('widevine-cdm-version', widevine.version)
      logStartupTiming(`[Widevine] 注入 CDM ${widevine.version} @ ${widevine.path}`)
    } else {
      console.log('[Widevine] 未检测到 Edge/Chrome Widevine 组件（AM 原生音源将回退载体匹配）')
    }
  } catch (error) {
    console.error('[Widevine] CDM 引导失败:', error?.message || error)
  }
}

app.on('child-process-gone', (_event, details) => {
  const processType = String(details?.type || '').toLowerCase()
  if (processType === 'gpu' || processType === 'renderer') {
    console.error('[ProcessHealth] Electron child process exited:', {
      type: details?.type,
      reason: details?.reason,
      exitCode: details?.exitCode,
      serviceName: details?.serviceName,
      name: details?.name,
    })
  }
})

// 立即设置应用名称（必须在app.ready之前）
app.setName('WaveForge 澜音工坊')
app.setAppUserModelId('com.waveforge.desktop')

const { execFile, execFileSync, spawn } = require('child_process')
const os = require('os')
const { pathToFileURL } = require('url')
const { createAnalysisRuntime } = require('./analysis-runtime.cjs')
const { setupRenderIPC, setupAiMixIPC, cleanup: cleanupRender } = require('./render-runtime.cjs')
const automixLog = require('./automix-log.cjs')
const { ConfigManager } = require('./config-manager.cjs')
const deviceLicense = require('./device-license.cjs')
const { createRemoteServer, getLanIPv4Addresses } = require('./remote-server.cjs')
const { setupAirplayIpc } = require('./airplay/airplay-ipc.cjs')
const { setupChromaIpc } = require('./chroma-ipc.cjs')
const { setupSignalRgbIpc } = require('./signalrgb-ipc.cjs')
logStartupTiming('Main-process modules loaded')

let desktopWidgetCpuSample = null
const DESKTOP_WIDGET_DISK_CACHE_MS = 60_000
let desktopWidgetDiskCache = []
let desktopWidgetDiskCacheExpiresAt = 0
let desktopWidgetDiskRequest = null

function readCpuTimes() {
  return os.cpus().reduce((total, cpu) => {
    const idle = total.idle + cpu.times.idle
    const all = total.all + Object.values(cpu.times).reduce((sum, value) => sum + value, 0)
    return { idle, all }
  }, { idle: 0, all: 0 })
}

function readMediaKeysEnabled() {
  try {
    const parsed = JSON.parse(fs.readFileSync(shortcutSettingsPath, 'utf8'))
    return parsed?.mediaKeysEnabled !== false
  } catch {
    return true
  }
}

function writeMediaKeysEnabled(enabled) {
  try {
    const temporaryPath = `${shortcutSettingsPath}.tmp`
    fs.mkdirSync(path.dirname(shortcutSettingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ mediaKeysEnabled: enabled === true }), 'utf8')
    fs.renameSync(temporaryPath, shortcutSettingsPath)
  } catch (error) {
    console.error('[快捷键设置] 保存失败:', error?.message || error)
  }
}

function readDesktopWidgetDisks() {
  if (process.platform !== 'win32') return Promise.resolve([])

  const now = Date.now()
  if (now < desktopWidgetDiskCacheExpiresAt) {
    return Promise.resolve(desktopWidgetDiskCache)
  }
  if (desktopWidgetDiskRequest) return desktopWidgetDiskRequest

  const script = "Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"
  desktopWidgetDiskRequest = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error || !String(stdout || '').trim()) return resolve([])
      try {
        const parsed = JSON.parse(stdout)
        const items = Array.isArray(parsed) ? parsed : [parsed]
        resolve(items.map(disk => {
          const total = Number(disk.Size) || 0
          const free = Number(disk.FreeSpace) || 0
          const used = Math.max(0, total - free)
          return { name: disk.DeviceID || '磁盘', used, total, percent: total ? used / total * 100 : 0 }
        }))
      } catch { resolve([]) }
    })
  }).then(disks => {
    desktopWidgetDiskCache = disks
    desktopWidgetDiskCacheExpiresAt = Date.now() + DESKTOP_WIDGET_DISK_CACHE_MS
    return disks
  }).finally(() => {
    desktopWidgetDiskRequest = null
  })

  return desktopWidgetDiskRequest
}

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged
const devServerUrl = process.env.WAVEFORGE_DEV_SERVER_URL || 'http://127.0.0.1:3000'

// 导航白名单：只允许应用自身的地址（开发模式 Vite 服务器 / 生产模式打包产物），
// 阻止同窗口被任意外部页面导航——特权 preload 桥一旦跟到外部站点就会被滥用。
const ALLOWED_DEV_SERVER_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
])
const ALLOWED_APP_FILE_URLS = new Set([
  pathToFileURL(path.join(__dirname, '../dist/index.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-player.html')).href,
  pathToFileURL(path.join(__dirname, '../dist/desktop-lyrics.html')).href,
])

function isAllowedNavigationTarget(url) {
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol === 'file:') {
      return ALLOWED_APP_FILE_URLS.has(parsed.href)
    }
    if (isDev && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return ALLOWED_DEV_SERVER_ORIGINS.has(parsed.origin)
    }
  } catch {
    // 无法解析的 URL 一律不放行
  }
  return false
}

function guardAgainstExternalNavigation(webContents) {
  webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url)) {
      event.preventDefault()
    }
  })
}

let mainWindow = null
let wallpaperWatcher = null
/** AirPlay 投送端控制器句柄（whenReady 内初始化，模块作用域供冒烟自检引用） */
let airplayControllerHandle = null
let chromaControllerHandle = null
let signalRgbControllerHandle = null
let qqLoginWindow = null
let qqLoginWindowOpening = false
let qqSkillKeyWindow = null
let analysisRuntime = null
const authorizedStemInputPaths = new Set()
let stemRuntime = null
let trackStemRuntime = null
let mediaKeysEnabled = readMediaKeysEnabled()

const mediaKeyAccelerators = {
  MediaPlayPause: 'toggle',
  MediaNextTrack: 'next',
  MediaPreviousTrack: 'prev',
}

function setGlobalMediaKeysEnabled(enabled) {
  mediaKeysEnabled = enabled === true
  writeMediaKeysEnabled(mediaKeysEnabled)
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))

  const registrations = {}
  if (mediaKeysEnabled) {
    Object.entries(mediaKeyAccelerators).forEach(([accelerator, action]) => {
      registrations[accelerator] = globalShortcut.register(accelerator, () => {
        dispatchPlayerControl(action)
      })
    })
  }

  return { success: true, enabled: mediaKeysEnabled, registrations }
}
let configManager = null

const QQMUSIC_SKILL_CREDENTIAL = 'qqmusicSkillApiKey'
const allowedMediaFiles = new Set()
const MAX_ALLOWED_MEDIA_FILES = 256

// ===== 桌面播放器：独立置顶小窗口（card 悬浮卡片 / bar 紧凑条状） =====
let desktopPlayerWindow = null
let desktopPlayerEnabled = false
let desktopPlayerForm = 'card'
const desktopPlayerState = {
  song: null, // { name, artists, coverUrl }
  lyric: null, // { line, translation, words, lineStart }
  playing: false,
  spectrum: [0, 0, 0, 0, 0],
  accentColor: '',
  playlist: [],
  currentIndex: -1,
  progress: 0,
  duration: 0, // 当前歌曲时长（秒），用于任务栏进度条 0-1 换算
  hasTranslation: false,
  hasRomaji: false,
  volume: 0.5, // 遥控器状态回传用
  muted: false,
  page: 'home', // 'home' | 'playback' —— 遥控器「模式切换」据此展示模式列表或歌词样式列表
}
const DESKTOP_PLAYER_FORMS = new Set(['card', 'bar'])
const DESKTOP_PLAYER_BASE_SIZE = {
  card: { width: 380, height: 150 },
  bar: { width: 480, height: 80 },
}
let desktopPlayerExpansionDirection = 'down'
let desktopPlayerDragSession = null
let desktopPlayerResizeSession = null
let desktopPlayerBoundsAnimation = null

// ===== 桌面歌词：独立透明置顶窗口 =====
let desktopLyricsWindow = null
let desktopLyricsDragSession = null
let desktopLyricsResizeSession = null
let desktopLyricsSavedBounds = null
let desktopLyricsPanelRestoreBounds = null
let desktopLyricsMousePassthrough = false
const DESKTOP_LYRICS_DEFAULTS = Object.freeze({
  enabled: false,
  fontSize: 58,
  // 歌词字体族名；空字符串 = 默认字体栈。可选本机字体，因此只做字符串校验不做白名单
  fontFamily: '',
  colorMode: 'auto',
  orientation: 'horizontal',
  doubleLine: false,
  translationEnabled: false,
  romajiEnabled: false,
  traditionalEnabled: false,
  locked: false,
})
const DESKTOP_LYRICS_COLORS = new Set(['auto', 'rose', 'sky', 'gold', 'mint', 'white'])
const DESKTOP_LYRICS_ORIENTATIONS = new Set(['horizontal', 'vertical'])
let desktopLyricsSettings = { ...DESKTOP_LYRICS_DEFAULTS }

function getDesktopPlayerWorkArea(bounds) {
  const { screen } = require('electron')
  return screen.getDisplayMatching(bounds).workArea
}

function clampDesktopPlayerBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, bounds.x)),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, bounds.y)),
    width,
    height,
  }
}

function animateDesktopPlayerBounds(targetBounds, duration = 240) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) clearInterval(desktopPlayerBoundsAnimation)
  const startBounds = desktopPlayerWindow.getBounds()
  const startedAt = Date.now()
  desktopPlayerBoundsAnimation = setInterval(() => {
    if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
      return
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration)
    const eased = 1 - Math.pow(1 - progress, 3)
    const interpolate = key => Math.round(startBounds[key] + (targetBounds[key] - startBounds[key]) * eased)
    desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({
      x: interpolate('x'), y: interpolate('y'), width: interpolate('width'), height: interpolate('height'),
    }))
    if (progress >= 1) {
      clearInterval(desktopPlayerBoundsAnimation)
      desktopPlayerBoundsAnimation = null
    }
  }, 16)
}

function getDesktopPlayerSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-player-settings.json')
}

function loadDesktopPlayerSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopPlayerSettingsPath(), 'utf8'))
    return {
      enabled: parsed?.enabled === true,
      form: DESKTOP_PLAYER_FORMS.has(parsed?.form) ? parsed.form : 'card',
    }
  } catch {
    return { enabled: false, form: 'card' }
  }
}

function saveDesktopPlayerSettings() {
  try {
    const settingsPath = getDesktopPlayerSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ enabled: desktopPlayerEnabled, form: desktopPlayerForm }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面播放器] 保存设置失败:', error)
  }
}

function getDesktopPlayerSnapshot() {
  return { ...desktopPlayerState, enabled: desktopPlayerEnabled, form: desktopPlayerForm }
}

function broadcastDesktopPlayerState() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', getDesktopPlayerSnapshot())
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:state', getDesktopPlayerSnapshot())
  }
  broadcastRemoteState()
}

function broadcastRemoteState() {
  if (remoteServer) remoteServer.broadcastState(getDesktopPlayerSnapshot())
}

// 遥控器端 state 是整包替换语义（state = msg.state），因此高频增量广播必须带上它依赖的
// 少量基础字段（song/playing/muted/volume/page），再合并本次增量。不带 playlist/spectrum 等
// 大字段——playlist 最多 500 条，只在低频完整快照里推送。
function buildRemoteMinimalState(partial) {
  const base = {
    song: desktopPlayerState.song || null,
    playing: desktopPlayerState.playing,
    muted: desktopPlayerState.muted,
    volume: desktopPlayerState.volume,
    page: desktopPlayerState.page,
  }
  return Object.assign(base, partial)
}

function broadcastDesktopPlayerPartial(partial) {
  if (!partial || Object.keys(partial).length === 0) return
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.webContents.send('desktop-player:state', partial)
  }
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    const lyricsPartial = {}
    for (const key of ['song', 'lyric', 'playing', 'accentColor', 'progress', 'hasTranslation', 'hasRomaji']) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) lyricsPartial[key] = partial[key]
    }
    if (Object.keys(lyricsPartial).length > 0) {
      desktopLyricsWindow.webContents.send('desktop-lyrics:state', lyricsPartial)
    }
  }
  // 高频路径（渲染端每 100ms 推 {spectrum, progress}）只广播最小字段集合，
  // 避免每 100ms 全量 JSON.stringify 含 500 条 playlist 的完整快照广播给遥控器。
  if (remoteServer) remoteServer.broadcastState(buildRemoteMinimalState(partial))
}

function desktopPlayerSetExpanded(expanded) {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  const bounds = desktopPlayerWindow.getBounds()
  if (expanded) {
    const workArea = getDesktopPlayerWorkArea(bounds)
    const roomAbove = bounds.y - workArea.y
    const roomBelow = workArea.y + workArea.height - (bounds.y + bounds.height)
    desktopPlayerExpansionDirection = roomBelow >= 260 || roomBelow >= roomAbove ? 'down' : 'up'
  }
  return desktopPlayerExpansionDirection
}

function createDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) return desktopPlayerWindow
  const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm] || DESKTOP_PLAYER_BASE_SIZE.card
  desktopPlayerWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'WaveForge 桌面播放器',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-player-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) {
    desktopPlayerWindow.loadURL(`${devServerUrl}/desktop-player.html`)
  } else {
    desktopPlayerWindow.loadFile(path.join(__dirname, '../dist/desktop-player.html'))
  }

  desktopPlayerWindow.once('ready-to-show', () => {
    if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
      // 首次创建：卡片位于右上角，紧凑条状位于顶部居中。
      try {
        const { screen } = require('electron')
        const workArea = screen.getPrimaryDisplay().workArea
        const bounds = desktopPlayerWindow.getBounds()
        const x = desktopPlayerForm === 'bar'
          ? Math.round(workArea.x + (workArea.width - bounds.width) / 2)
          : Math.round(workArea.x + workArea.width - bounds.width - 24)
        const y = Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24))
        desktopPlayerWindow.setBounds({ x, y, width: bounds.width, height: bounds.height })
      } catch (positionError) {
        console.warn('[桌面播放器] 初始定位失败:', positionError)
      }
      // showInactive：不抢焦点。主窗口 kiosk 全屏（覆盖任务栏）时若被抢焦，
      // Windows 会退出 kiosk 露出任务栏，用户还需再点一次主窗口才能恢复全屏。
      desktopPlayerWindow.showInactive()
      desktopPlayerWindow.moveTop()
    }
  })
  desktopPlayerWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
  })
  guardAgainstExternalNavigation(desktopPlayerWindow.webContents)
  desktopPlayerWindow.on('closed', () => {
    desktopPlayerWindow = null
    // Alt+F4 等系统路径关闭：同步开关状态（UI 内关闭路径已做），否则渲染端开关残留
    // "开启"，频谱/状态推送持续打向已销毁窗口
    if (desktopPlayerEnabled) {
      desktopPlayerEnabled = false
      saveDesktopPlayerSettings()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-player:enabled-changed', false)
      }
    }
  })
  return desktopPlayerWindow
}

function closeDesktopPlayerWindow() {
  if (desktopPlayerWindow && !desktopPlayerWindow.isDestroyed()) {
    desktopPlayerWindow.close()
  }
  desktopPlayerWindow = null
}

function getDesktopLyricsSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-lyrics-settings.json')
}

function sanitizeDesktopLyricsSettings(input = {}, base = DESKTOP_LYRICS_DEFAULTS) {
  return {
    enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
    fontSize: input.fontSize === undefined
      ? base.fontSize
      : Math.round(Math.min(120, Math.max(26, Number(input.fontSize) || DESKTOP_LYRICS_DEFAULTS.fontSize))),
    // 字体族名：允许任意本机字体名，仅截断长度防止异常数据；空串 = 默认字体栈
    fontFamily: input.fontFamily === undefined
      ? (base.fontFamily || '')
      : String(input.fontFamily).trim().slice(0, 128),
    colorMode: input.colorMode === undefined
      ? base.colorMode
      : (DESKTOP_LYRICS_COLORS.has(input.colorMode) ? input.colorMode : 'auto'),
    orientation: input.orientation === undefined
      ? base.orientation
      : (DESKTOP_LYRICS_ORIENTATIONS.has(input.orientation) ? input.orientation : 'horizontal'),
    doubleLine: input.doubleLine === undefined ? base.doubleLine === true : input.doubleLine === true,
    translationEnabled: input.translationEnabled === undefined ? base.translationEnabled === true : input.translationEnabled === true,
    romajiEnabled: input.romajiEnabled === undefined ? base.romajiEnabled === true : input.romajiEnabled === true,
    traditionalEnabled: input.traditionalEnabled === undefined ? base.traditionalEnabled === true : input.traditionalEnabled === true,
    locked: input.locked === undefined ? base.locked === true : input.locked === true,
  }
}

function loadDesktopLyricsSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getDesktopLyricsSettingsPath(), 'utf8'))
    desktopLyricsSavedBounds = parsed?.bounds && Number.isFinite(parsed.bounds.x) && Number.isFinite(parsed.bounds.y)
      ? parsed.bounds
      : null
    return sanitizeDesktopLyricsSettings(parsed)
  } catch {
    desktopLyricsSavedBounds = null
    return { ...DESKTOP_LYRICS_DEFAULTS }
  }
}

function saveDesktopLyricsSettings() {
  try {
    const settingsPath = getDesktopLyricsSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    const bounds = desktopLyricsPanelRestoreBounds || (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()
      ? desktopLyricsWindow.getBounds()
      : desktopLyricsSavedBounds)
    desktopLyricsSavedBounds = bounds || desktopLyricsSavedBounds
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify({ ...desktopLyricsSettings, bounds }, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[桌面歌词] 保存设置失败:', error)
  }
}

function getDesktopLyricsSettings() {
  return { ...desktopLyricsSettings }
}

function broadcastDesktopLyricsSettings() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    desktopLyricsWindow.webContents.send('desktop-lyrics:settings', getDesktopLyricsSettings())
  }
}

function setDesktopLyricsMousePassthrough(passthrough) {
  const next = desktopLyricsSettings.locked === true && passthrough === true
  desktopLyricsMousePassthrough = next
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) {
    try {
      if (next) desktopLyricsWindow.setIgnoreMouseEvents(true, { forward: true })
      else desktopLyricsWindow.setIgnoreMouseEvents(false)
    } catch (error) {
      console.warn('[\u684c\u9762\u6b4c\u8bcd] \u5207\u6362\u9f20\u6807\u7a7f\u900f\u5931\u8d25:', error)
    }
  }
  return desktopLyricsMousePassthrough
}

function getDesktopLyricsDefaultBounds(orientation = desktopLyricsSettings.orientation) {
  const { screen } = require('electron')
  const workArea = screen.getPrimaryDisplay().workArea
  const size = orientation === 'vertical'
    ? { width: 300, height: Math.min(720, workArea.height - 48) }
    : { width: Math.min(980, workArea.width - 48), height: 180 }
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: orientation === 'vertical'
      ? Math.round(workArea.y + (workArea.height - size.height) / 2)
      : Math.round(workArea.y + workArea.height - size.height - 54),
    ...size,
  }
}

function clampDesktopLyricsBounds(bounds) {
  const workArea = getDesktopPlayerWorkArea(bounds)
  const vertical = desktopLyricsSettings.orientation === 'vertical'
  const minimumWidth = vertical ? 240 : 480
  const minimumHeight = vertical ? 340 : 116
  const width = Math.min(workArea.width, Math.max(minimumWidth, Math.round(bounds.width)))
  const height = Math.min(workArea.height, Math.max(minimumHeight, Math.round(bounds.height)))
  return {
    x: Math.min(workArea.x + workArea.width - width, Math.max(workArea.x, Math.round(bounds.x))),
    y: Math.min(workArea.y + workArea.height - height, Math.max(workArea.y, Math.round(bounds.y))),
    width,
    height,
  }
}

function createDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) return desktopLyricsWindow
  const initialBounds = desktopLyricsSavedBounds || getDesktopLyricsDefaultBounds()
  desktopLyricsWindow = new BrowserWindow({
    ...initialBounds,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    show: false,
    title: 'WaveForge 桌面歌词',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'desktop-lyrics-preload.cjs'),
      backgroundThrottling: false,
      cache: false,
    },
  })

  if (isDev) desktopLyricsWindow.loadURL(`${devServerUrl}/desktop-lyrics.html`)
  else desktopLyricsWindow.loadFile(path.join(__dirname, '../dist/desktop-lyrics.html'))

  desktopLyricsWindow.once('ready-to-show', () => {
    if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed()) return
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsWindow.getBounds()))
    desktopLyricsWindow.showInactive()
    desktopLyricsWindow.moveTop()
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  })
  desktopLyricsWindow.webContents.once('did-finish-load', () => {
    broadcastDesktopPlayerState()
    broadcastDesktopLyricsSettings()
  })
  guardAgainstExternalNavigation(desktopLyricsWindow.webContents)
  desktopLyricsWindow.on('closed', () => {
    desktopLyricsWindow = null
    desktopLyricsPanelRestoreBounds = null
    desktopLyricsMousePassthrough = false
    // Alt+F4 等系统路径关闭：同步开关状态（UI 内关闭路径已做），否则渲染端开关残留"开启"
    if (desktopLyricsSettings.enabled) {
      desktopLyricsSettings = { ...desktopLyricsSettings, enabled: false }
      saveDesktopLyricsSettings()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop-lyrics:enabled-changed', false)
      }
    }
  })
  return desktopLyricsWindow
}

function closeDesktopLyricsWindow() {
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed()) desktopLyricsWindow.close()
  desktopLyricsWindow = null
  desktopLyricsPanelRestoreBounds = null
  desktopLyricsMousePassthrough = false
}

ipcMain.handle('desktop-lyrics:get-settings', () => getDesktopLyricsSettings())

ipcMain.handle('desktop-lyrics:set-enabled', (_event, enabled) => {
  desktopLyricsSettings = { ...desktopLyricsSettings, enabled: enabled === true }
  saveDesktopLyricsSettings()
  if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  else closeDesktopLyricsWindow()
  // 回广播启用状态，让主窗口据此门控频谱推送
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-lyrics:enabled-changed', desktopLyricsSettings.enabled)
  }
  return { success: true, enabled: desktopLyricsSettings.enabled }
})

ipcMain.handle('desktop-lyrics:update-settings', (_event, partial) => {
  const previousOrientation = desktopLyricsSettings.orientation
  desktopLyricsSettings = sanitizeDesktopLyricsSettings(partial, desktopLyricsSettings)
  if (Object.prototype.hasOwnProperty.call(partial || {}, 'locked')) {
    setDesktopLyricsMousePassthrough(desktopLyricsSettings.locked)
  }
  if (desktopLyricsSettings.enabled && !desktopLyricsWindow) createDesktopLyricsWindow()
  if (desktopLyricsWindow && !desktopLyricsWindow.isDestroyed() && previousOrientation !== desktopLyricsSettings.orientation) {
    const baseTarget = getDesktopLyricsDefaultBounds(desktopLyricsSettings.orientation)
    if (desktopLyricsPanelRestoreBounds) {
      desktopLyricsPanelRestoreBounds = baseTarget
      const workArea = getDesktopPlayerWorkArea(baseTarget)
      const targetHeight = Math.min(workArea.height, Math.max(baseTarget.height, 500))
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
        ...baseTarget,
        y: Math.max(workArea.y, baseTarget.y + baseTarget.height - targetHeight),
        height: targetHeight,
      }))
    } else {
      desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(baseTarget))
    }
  }
  saveDesktopLyricsSettings()
  broadcastDesktopLyricsSettings()
  return getDesktopLyricsSettings()
})

ipcMain.handle('desktop-lyrics:set-panel-open', (_event, open) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return { open: false }
  if (open === true && !desktopLyricsPanelRestoreBounds) {
    const bounds = desktopLyricsWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    desktopLyricsPanelRestoreBounds = bounds
    const targetHeight = Math.min(workArea.height, Math.max(bounds.height, 500))
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
      x: bounds.x,
      y: Math.max(workArea.y, bounds.y + bounds.height - targetHeight),
      width: bounds.width,
      height: targetHeight,
    }))
  } else if (open !== true && desktopLyricsPanelRestoreBounds) {
    desktopLyricsWindow.setBounds(clampDesktopLyricsBounds(desktopLyricsPanelRestoreBounds))
    desktopLyricsPanelRestoreBounds = null
  }
  return { open: open === true }
})

ipcMain.handle('desktop-lyrics:set-mouse-passthrough', (_event, passthrough) => ({
  passthrough: setDesktopLyricsMousePassthrough(passthrough === true),
}))

ipcMain.on('desktop-lyrics:control', (_event, action) => {
  if (action === 'close') {
    desktopLyricsSettings = { ...desktopLyricsSettings, enabled: false }
    saveDesktopLyricsSettings()
    closeDesktopLyricsWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-lyrics:enabled-changed', false)
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop-player:control', action)
})

ipcMain.on('desktop-lyrics:drag-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  desktopLyricsDragSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-lyrics:drag-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsDragSession) return
  const start = desktopLyricsDragSession
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    ...start.bounds,
    x: start.bounds.x + ((Number(point?.x) || 0) - start.x),
    y: start.bounds.y + ((Number(point?.y) || 0) - start.y),
  }))
})

ipcMain.on('desktop-lyrics:drag-end', () => {
  desktopLyricsDragSession = null
  saveDesktopLyricsSettings()
})

ipcMain.on('desktop-lyrics:resize-start', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || desktopLyricsSettings.locked) return
  if (desktopLyricsPanelRestoreBounds) return
  const edge = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].includes(point?.edge) ? point.edge : 'se'
  desktopLyricsResizeSession = {
    bounds: desktopLyricsWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge,
  }
})

ipcMain.on('desktop-lyrics:resize-to', (_event, point) => {
  if (!desktopLyricsWindow || desktopLyricsWindow.isDestroyed() || !desktopLyricsResizeSession) return
  const start = desktopLyricsResizeSession
  const dx = (Number(point?.x) || 0) - start.x
  const dy = (Number(point?.y) || 0) - start.y
  const fromLeft = start.edge.includes('w')
  const fromRight = start.edge.includes('e')
  const fromTop = start.edge.includes('n')
  const fromBottom = start.edge.includes('s')
  const width = start.bounds.width + (fromLeft ? -dx : fromRight ? dx : 0)
  const height = start.bounds.height + (fromTop ? -dy : fromBottom ? dy : 0)
  const nextWidth = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 240 : 480, width)
  const nextHeight = Math.max(desktopLyricsSettings.orientation === 'vertical' ? 340 : 116, height)
  desktopLyricsWindow.setBounds(clampDesktopLyricsBounds({
    x: fromLeft ? start.bounds.x + start.bounds.width - nextWidth : start.bounds.x,
    y: fromTop ? start.bounds.y + start.bounds.height - nextHeight : start.bounds.y,
    width: nextWidth,
    height: nextHeight,
  }))
})

ipcMain.on('desktop-lyrics:resize-end', () => {
  desktopLyricsResizeSession = null
  saveDesktopLyricsSettings()
})

ipcMain.handle('desktop-player:set-enabled', (_event, enabled) => {
  desktopPlayerEnabled = enabled === true
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled) {
    createDesktopPlayerWindow()
  } else {
    closeDesktopPlayerWindow()
  }
  // 回广播启用状态，让主窗口据此门控频谱推送（无消费者时跳过 IPC 与数组分配）
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:enabled-changed', desktopPlayerEnabled)
  }
  return { success: true, enabled: desktopPlayerEnabled }
})

ipcMain.handle('desktop-player:set-form', (_event, form) => {
  if (!DESKTOP_PLAYER_FORMS.has(form)) return { success: false, form: desktopPlayerForm }
  const changed = desktopPlayerForm !== form
  desktopPlayerForm = form
  saveDesktopPlayerSettings()
  if (desktopPlayerEnabled && desktopPlayerWindow && !desktopPlayerWindow.isDestroyed() && changed) {
    const size = DESKTOP_PLAYER_BASE_SIZE[desktopPlayerForm]
    const bounds = desktopPlayerWindow.getBounds()
    const workArea = getDesktopPlayerWorkArea(bounds)
    const centerX = workArea.x + workArea.width / 2
    desktopPlayerWindow.setBounds({
      x: desktopPlayerForm === 'bar'
        ? Math.round(centerX - size.width / 2)
        : Math.round(workArea.x + workArea.width - size.width - 24),
      y: Math.round(workArea.y + (desktopPlayerForm === 'bar' ? 12 : 24)),
      width: size.width,
      height: size.height,
    })
  }
  broadcastDesktopPlayerState()
  return { success: true, form: desktopPlayerForm }
})

ipcMain.handle('desktop-player:get-state', () => getDesktopPlayerSnapshot())

ipcMain.handle('media-keys:set-enabled', (_event, enabled) => {
  if (!app.isReady()) return { success: false, enabled: false, registrations: {} }
  return setGlobalMediaKeysEnabled(enabled)
})

// IPC：OOBE 完成 flag 文件（用户数据目录下 .oobe-complete，独立于 localStorage——
// 双重保险：localStorage 被清/损坏时仍能识别已完成的 OOBE，跳过引导）
const oobeFlagPath = () => path.join(app.getPath('userData'), '.oobe-complete')

ipcMain.handle('oobe:get-flag', () => {
  try {
    return fs.existsSync(oobeFlagPath())
  } catch {
    return false
  }
})
ipcMain.handle('oobe:set-flag', () => {
  try {
    fs.writeFileSync(oobeFlagPath(), new Date().toISOString(), 'utf8')
    return true
  } catch {
    return false
  }
})

// 主窗口推送播放状态（歌曲 / 歌词 / 播放中 / 频谱）
ipcMain.on('desktop-player:state-update', (_event, partial) => {
  if (!partial || typeof partial !== 'object') return
  const changed = {}

  if (partial.song !== undefined) {
    const next = partial.song || null
    if (desktopPlayerState.song !== next) {
      desktopPlayerState.song = next
      changed.song = next
    }
  }
  if (partial.lyric !== undefined) {
    const next = partial.lyric || null
    if (desktopPlayerState.lyric !== next) {
      desktopPlayerState.lyric = next
      changed.lyric = next
    }
  }
  if (partial.playing !== undefined) {
    const next = partial.playing === true
    if (desktopPlayerState.playing !== next) {
      desktopPlayerState.playing = next
      changed.playing = next
    }
  }
  for (const key of ['hasTranslation', 'hasRomaji']) {
    if (partial[key] === undefined) continue
    const next = partial[key] === true
    if (desktopPlayerState[key] !== next) {
      desktopPlayerState[key] = next
      changed[key] = next
    }
  }
  if (partial.accentColor !== undefined) {
    const next = String(partial.accentColor || '')
    if (desktopPlayerState.accentColor !== next) {
      desktopPlayerState.accentColor = next
      changed.accentColor = next
    }
  }
  if (Array.isArray(partial.playlist)) {
    const next = partial.playlist.slice(0, 500).map(item => ({
      index: Number(item?.index) || 0,
      name: String(item?.name || ''),
      artists: String(item?.artists || ''),
    }))
    desktopPlayerState.playlist = next
    changed.playlist = next
  }
  if (partial.currentIndex !== undefined) {
    const value = Number(partial.currentIndex)
    const next = Number.isInteger(value) ? value : -1
    if (desktopPlayerState.currentIndex !== next) {
      desktopPlayerState.currentIndex = next
      changed.currentIndex = next
    }
  }
  if (typeof partial.progress === 'number' && Number.isFinite(partial.progress)) {
    desktopPlayerState.progress = partial.progress
    changed.progress = partial.progress
  }
  if (typeof partial.duration === 'number' && Number.isFinite(partial.duration)) {
    const next = Math.max(0, partial.duration)
    if (desktopPlayerState.duration !== next) {
      desktopPlayerState.duration = next
      changed.duration = next
    }
  }
  if (typeof partial.volume === 'number' && Number.isFinite(partial.volume)) {
    const next = Math.max(0, Math.min(1, partial.volume))
    if (desktopPlayerState.volume !== next) {
      desktopPlayerState.volume = next
      changed.volume = next
    }
  }
  if (typeof partial.muted === 'boolean') {
    if (desktopPlayerState.muted !== partial.muted) {
      desktopPlayerState.muted = partial.muted
      changed.muted = partial.muted
    }
  }
  if (partial.page === 'home' || partial.page === 'playback') {
    if (desktopPlayerState.page !== partial.page) {
      desktopPlayerState.page = partial.page
      changed.page = partial.page
    }
  }
  if (Array.isArray(partial.spectrum)) {
    const next = partial.spectrum.slice(0, 5).map(value => Math.max(0, Math.min(1, Number(value) || 0)))
    desktopPlayerState.spectrum = next
    changed.spectrum = next
  }
  broadcastDesktopPlayerPartial(changed)

  // Windows 任务栏：播放/暂停状态变化时切换缩略图按钮图标；进度/时长/播放状态/
  // 歌曲变化时刷新任务栏进度条（mode: normal 播放中 / paused 暂停 / none 停止）。
  if (changed.playing !== undefined) updateThumbarButtons()
  if (changed.playing !== undefined || changed.song !== undefined || changed.progress !== undefined || changed.duration !== undefined) {
    updateTaskbarProgress()
  }
  // 任务栏快捷播控 widget：歌曲/播放/进度变化时同步刷新；切歌后重新显示（关闭仅隐藏当前歌）
  if (changed.song !== undefined) taskbarWidgetClosedByUser = false
  if (changed.song !== undefined || changed.playing !== undefined || changed.progress !== undefined || changed.duration !== undefined || changed.muted !== undefined) {
    updateTaskbarWidget()
  }
})

// 小窗口内的播放控制指令，转发给主窗口执行
ipcMain.on('desktop-player:control', (_event, action, payload) => {
  // close 由主进程直接处理：关闭小窗口并同步开关状态
  if (action === 'close') {
    desktopPlayerEnabled = false
    saveDesktopPlayerSettings()
    closeDesktopPlayerWindow()
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('desktop-player:enabled-changed', false)
    }
    return
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop-player:control', action, payload)
  }
})

ipcMain.on('desktop-player:resize-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerForm !== 'card') return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerResizeSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
    edge: ['nw', 'ne', 'sw', 'se'].includes(point?.edge) ? point.edge : 'se',
  }
})

ipcMain.on('desktop-player:resize-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerResizeSession) return
  const start = desktopPlayerResizeSession
  const workArea = getDesktopPlayerWorkArea(start.bounds)
  const dx = (Number(point?.x) || 0) - start.x
  const dy = (Number(point?.y) || 0) - start.y
  const fromLeft = start.edge.endsWith('w')
  const fromTop = start.edge.startsWith('n')
  const width = Math.min(720, Math.max(300, Math.round(start.bounds.width + (fromLeft ? -dx : dx))))
  const height = Math.min(workArea.height, Math.max(112, Math.round(start.bounds.height + (fromTop ? -dy : dy))))
  const x = fromLeft ? start.bounds.x + start.bounds.width - width : start.bounds.x
  const y = fromTop ? start.bounds.y + start.bounds.height - height : start.bounds.y
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds({ x, y, width, height }))
})

ipcMain.on('desktop-player:resize-end', () => {
  desktopPlayerResizeSession = null
})

ipcMain.handle('desktop-player:set-expanded', (_event, expanded) => {
  return { direction: desktopPlayerSetExpanded(expanded === true) || desktopPlayerExpansionDirection }
})


// 内容高度同步：根据屏幕剩余空间保持顶边或底边不动，避免面板跑出屏幕。
ipcMain.on('desktop-player:content-height', (_event, height) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerResizeSession) return
  // 最小高度与 resize 的 112 一致（此前用 BASE_SIZE.height=150，卡片缩到 112 后收起会被撑回 150，尺寸变长）
  const minimum = desktopPlayerForm === 'bar' ? 80 : 112
  const bounds = desktopPlayerWindow.getBounds()
  const workArea = getDesktopPlayerWorkArea(bounds)
  const target = Math.min(workArea.height, Math.max(minimum, Math.ceil(Number(height) || 0)))
  if (bounds.height === target) return
  const y = desktopPlayerExpansionDirection === 'up' ? bounds.y + bounds.height - target : bounds.y
  animateDesktopPlayerBounds(clampDesktopPlayerBounds({ x: bounds.x, y, width: bounds.width, height: target }))
})

// 使用拖动开始时的绝对窗口坐标，避免高频 IPC 延迟造成位移累计误差和窗口抽搐。
ipcMain.on('desktop-player:drag-start', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed()) return
  if (desktopPlayerBoundsAnimation) {
    clearInterval(desktopPlayerBoundsAnimation)
    desktopPlayerBoundsAnimation = null
  }
  desktopPlayerDragSession = {
    bounds: desktopPlayerWindow.getBounds(),
    x: Number(point?.x) || 0,
    y: Number(point?.y) || 0,
  }
})

ipcMain.on('desktop-player:drag-to', (_event, point) => {
  if (!desktopPlayerWindow || desktopPlayerWindow.isDestroyed() || !desktopPlayerDragSession) return
  const start = desktopPlayerDragSession
  const next = {
    ...start.bounds,
    x: Math.round(start.bounds.x + (Number(point?.x) - start.x)),
    y: Math.round(start.bounds.y + (Number(point?.y) - start.y)),
  }
  desktopPlayerWindow.setBounds(clampDesktopPlayerBounds(next))
})

ipcMain.on('desktop-player:drag-end', () => {
  desktopPlayerDragSession = null
})

function getSecureCredentialsPath() {
  return path.join(app.getPath('userData'), 'secure-credentials.json')
}

function readSecureCredentials() {
  const credentialsPath = getSecureCredentialsPath()
  if (!fs.existsSync(credentialsPath)) return {}
  try {
    const parsed = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeSecureCredentials(credentials) {
  const credentialsPath = getSecureCredentialsPath()
  const temporaryPath = `${credentialsPath}.tmp`
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(temporaryPath, JSON.stringify(credentials), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporaryPath, credentialsPath)
}

function readQQMusicSkillKey() {
  if (!safeStorage.isEncryptionAvailable()) return ''
  const encrypted = readSecureCredentials()[QQMUSIC_SKILL_CREDENTIAL]
  if (typeof encrypted !== 'string' || !encrypted) return ''
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return ''
  }
}

// 开发者模式状态（默认关闭）
let developerMode = false

// 日志辅助函数，仅在开发者模式下输出壁纸相关日志
function logWallpaper(...args) {
  if (developerMode) {
    console.log(...args)
  }
}

function safeSendToWindow(targetWindow, channel, ...args) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return false
  }

  const contents = targetWindow.webContents
  if (!contents || contents.isDestroyed()) {
    return false
  }

  try {
    contents.send(channel, ...args)
    return true
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (!message.includes('Render frame was disposed')) {
      console.warn(`[IPC] Failed to send "${channel}":`, message)
    }
    return false
  }
}

// 统一的播放控制命令派发入口：全局媒体键与 Windows 任务栏缩略图按钮共用，
// 避免各来源各自实现一套「发给主窗口渲染进程」的逻辑。走 global-media-key 通道，
// 渲染进程已内置 280ms 防抖（Windows 可能把同一次按键同时交给 globalShortcut 与
// Media Session，防止同一动作重复触发）。
function dispatchPlayerControl(action, payload) {
  safeSendToWindow(mainWindow, 'global-media-key', action, payload)
}

// ===== Windows 任务栏缩略图按钮 + 进度条（仅 win32 生效，其余平台自动跳过） =====
const THUMBAR_ICON_SIZE = 32
let thumbarIconsCache = null

// 生成任务栏按钮图标。Electron 没有内置的播放/暂停图标素材，这里用
// nativeImage.createFromBitmap 从原始 BGRA 位图直接绘制三角形/竖线，
// 不依赖外部图片资源。图标统一为白色（RGB 相等），字节序差异不影响渲染。
function buildThumbarIcon(inside) {
  const size = THUMBAR_ICON_SIZE
  const buffer = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!inside(x, y)) continue
      const offset = (y * size + x) * 4
      buffer[offset] = 255
      buffer[offset + 1] = 255
      buffer[offset + 2] = 255
      buffer[offset + 3] = 255
    }
  }
  try {
    const image = nativeImage.createFromBitmap(buffer, { width: size, height: size })
    if (image.isEmpty()) return nativeImage.createEmpty()
    return image
  } catch {
    return nativeImage.createEmpty()
  }
}

function getThumbarIcons() {
  if (!thumbarIconsCache) {
    const center = THUMBAR_ICON_SIZE / 2
    const half = 10 // 三角形/竖线的垂直半高（图标上下对称，位图方向差异无影响）
    // 播放：向右的实心三角形（左底右尖）
    const playInside = (x, y) => {
      const t = (27 - x) / (27 - 8)
      return x >= 8 && x <= 27 && t >= 0 && Math.abs(y - center) <= half * t
    }
    // 暂停：两根竖线
    const pauseInside = (x, y) => {
      const inLeft = x >= 8 && x <= 13 && y >= 6 && y <= 26
      const inRight = x >= 19 && x <= 24 && y >= 6 && y <= 26
      return inLeft || inRight
    }
    // 上一首：左侧竖线 + 向左的实心三角形（右底左尖，尖贴着竖线）
    const prevInside = (x, y) => {
      const bar = x >= 4 && x <= 7 && y >= 7 && y <= 25
      const t = (x - 7) / (23 - 7)
      const triangle = x >= 7 && x <= 23 && t >= 0 && t <= 1 && Math.abs(y - center) <= half * t
      return bar || triangle
    }
    // 下一首：向右的实心三角形（左底右尖，尖贴着竖线）+ 右侧竖线
    const nextInside = (x, y) => {
      const bar = x >= 25 && x <= 28 && y >= 7 && y <= 25
      const t = (25 - x) / (25 - 9)
      const triangle = x >= 9 && x <= 25 && t >= 0 && t <= 1 && Math.abs(y - center) <= half * t
      return bar || triangle
    }
    thumbarIconsCache = {
      play: buildThumbarIcon(playInside),
      pause: buildThumbarIcon(pauseInside),
      prev: buildThumbarIcon(prevInside),
      next: buildThumbarIcon(nextInside),
    }
  }
  return thumbarIconsCache
}

function updateThumbarButtons() {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const icons = getThumbarIcons()
  if (icons.play.isEmpty() || icons.pause.isEmpty()) return
  const playing = desktopPlayerState.playing === true
  const buttons = [
    { tooltip: '上一首', icon: icons.prev, click: () => dispatchPlayerControl('prev') },
    {
      tooltip: playing ? '暂停' : '播放',
      icon: playing ? icons.pause : icons.play,
      click: () => dispatchPlayerControl('toggle'),
    },
    { tooltip: '下一首', icon: icons.next, click: () => dispatchPlayerControl('next') },
  ]
  try {
    mainWindow.setThumbarButtons(buttons)
  } catch {
    // 非 Windows / 窗口无任务栏按钮等场景：静默忽略
  }
}

function getTaskbarProgressRatio() {
  const duration = Number(desktopPlayerState.duration) || 0
  const progress = Number(desktopPlayerState.progress) || 0
  if (duration <= 0 || progress <= 0) return 0
  return Math.max(0, Math.min(1, progress / duration))
}

function updateTaskbarProgress() {
  if (process.platform !== 'win32') return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const playing = desktopPlayerState.playing === true
  const hasSong = Boolean(desktopPlayerState.song)
  const ratio = getTaskbarProgressRatio()
  try {
    if (!hasSong) {
      mainWindow.setProgressBar(0, { mode: 'none' })
    } else {
      mainWindow.setProgressBar(ratio, { mode: playing ? 'normal' : 'paused' })
    }
  } catch {
    // 静默忽略
  }
}

function updateTaskbar() {
  updateThumbarButtons()
  updateTaskbarProgress()
}

// ===== 任务栏迷你播控（贴任务栏带的迷你歌词播放器，win32 生效） =====
// 与 Echo 的「迷你底栏」对齐：窗口高度精确等于任务栏带高度，贴任务栏右侧（或居中），
// 播放时显示封面/歌词行/进度并提供控制；默认鼠标穿透，悬停进入交互态不挡任务栏。
// 设置（userData/taskbar-widget-settings.json）由「设置-个性化」控制开关/位置/宽度/模式。
const TASKBAR_WIDGET_DEFAULTS = { enabled: false, position: 'right', width: 340, mode: 'normal', darken: false, darkenLevel: 0.5, hideControls: false }
let taskbarWidgetSettings = { ...TASKBAR_WIDGET_DEFAULTS }
let taskbarWidgetWindow = null
let taskbarWidgetClosedByUser = false
let taskbarWidgetInteractive = false
let taskbarWidgetExpanded = false
let taskbarDisplayMetricsBound = false
// 设置文件重载节流：updateTaskbarWidget 随播放进度每秒触发，避免每次同步读盘
let taskbarWidgetSettingsLastLoad = 0
const TASKBAR_WIDGET_SETTINGS_RELOAD_MS = 5000

function getTaskbarWidgetSettingsPath() {
  return path.join(app.getPath('userData'), 'taskbar-widget-settings.json')
}

function sanitizeTaskbarWidgetSettings(input = {}, base = TASKBAR_WIDGET_DEFAULTS) {
  return {
    enabled: input.enabled === undefined ? base.enabled === true : input.enabled === true,
    position: input.position === 'right' || input.position === 'center' ? input.position : (base.position === 'center' ? 'center' : 'right'),
    width: Math.round(Math.min(420, Math.max(260, Number(input.width) || base.width))),
    mode: input.mode === 'pure' || input.mode === 'normal' ? input.mode : (base.mode === 'pure' ? 'pure' : 'normal'),
    darken: input.darken === undefined ? base.darken === true : input.darken === true,
    darkenLevel: Math.min(0.95, Math.max(0.05, Number(input.darkenLevel) || base.darkenLevel)),
    hideControls: input.hideControls === undefined ? base.hideControls === true : input.hideControls === true,
  }
}

function loadTaskbarWidgetSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getTaskbarWidgetSettingsPath(), 'utf8'))
    taskbarWidgetSettings = sanitizeTaskbarWidgetSettings(parsed)
  } catch {
    taskbarWidgetSettings = { ...TASKBAR_WIDGET_DEFAULTS }
  }
  return taskbarWidgetSettings
}

function saveTaskbarWidgetSettings() {
  try {
    const settingsPath = getTaskbarWidgetSettingsPath()
    const temporaryPath = `${settingsPath}.tmp`
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(temporaryPath, JSON.stringify(taskbarWidgetSettings, null, 2), 'utf8')
    fs.renameSync(temporaryPath, settingsPath)
  } catch (error) {
    console.error('[任务栏播控] 保存设置失败:', error)
  }
}

function getTaskbarWidgetSettings() {
  return { ...taskbarWidgetSettings }
}

function broadcastTaskbarWidgetSettings() {
  if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) {
    taskbarWidgetWindow.webContents.send('taskbar-widget:settings', getTaskbarWidgetSettings())
  }
}

// 系统托盘（通知区域）左缘测量：Windows 下查询 TrayNotifyWnd 的物理像素矩形。
// 右侧定位需要「紧贴托盘外侧」，固定留白在托盘宽度变化时会叠进托盘，故按真实托盘位置计算。
let taskbarTrayCache = null // { left, right } 物理像素
let taskbarTrayCacheAt = 0
let taskbarTrayRequest = null
const TASKBAR_TRAY_CACHE_MS = 30000
// 托盘不可测时靠右贴齐：留 12px 边距
const TASKBAR_TRAY_FALLBACK_RATIO = 0.04

function fetchTaskbarTrayRectPhysical() {
  if (taskbarTrayRequest) return taskbarTrayRequest
  const script = [
    `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class T{[DllImport("user32.dll")]public static extern IntPtr FindWindow(string c,string t);[DllImport("user32.dll")]public static extern IntPtr FindWindowEx(IntPtr p,IntPtr c,string cn,string tn);[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);public struct R{public int L,T,Rt,B;}}'`,
    `$t=[T]::FindWindow('Shell_TrayWnd',$null)`,
    `$n=[T]::FindWindowEx($t,[IntPtr]::Zero,'TrayNotifyWnd',$null)`,
    `if($n -eq [IntPtr]::Zero){'none'}else{$r=New-Object T+R;[T]::GetWindowRect($n,[ref]$r)|Out-Null;"$($r.L),$($r.Rt)"}`,
  ].join(';')
  taskbarTrayRequest = new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 3000 }, (error, stdout) => {
      taskbarTrayRequest = null
      if (error) return resolve(null)
      const lines = String(stdout || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      const match = (lines[lines.length - 1] || '').match(/^(-?\d+),(-?\d+)$/)
      if (!match) return resolve(null)
      const rect = { left: Number(match[1]), right: Number(match[2]) }
      taskbarTrayCache = rect
      taskbarTrayCacheAt = Date.now()
      resolve(rect)
    })
  })
  return taskbarTrayRequest
}

function getTaskbarTrayLeftDip() {
  if (taskbarTrayCache && Date.now() - taskbarTrayCacheAt < TASKBAR_TRAY_CACHE_MS) {
    const { screen } = require('electron')
    const scale = screen.getPrimaryDisplay().scaleFactor || 1
    return Math.round(taskbarTrayCache.left / scale)
  }
  return null
}

/** 托盘缓存失效时后台刷新，完成后重新贴边（托盘图标增减导致宽度变化也能跟上） */
function refreshTaskbarTray() {
  if (getTaskbarTrayLeftDip() !== null) return Promise.resolve(taskbarTrayCache)
  return fetchTaskbarTrayRectPhysical().then(rect => {
    if (rect) dockTaskbarWidgetWindow()
    return rect
  })
}

function getTaskbarWidgetPosition() {
  const { screen } = require('electron')
  const display = screen.getPrimaryDisplay()
  const bounds = display.bounds // 含任务栏的完整屏幕区域
  const workArea = display.workArea
  const width = taskbarWidgetSettings.width
  // 任务栏方位判定：对比 bounds 与 workArea 的四边差（DIP）
  const taskbarTop = Math.round(workArea.y - bounds.y)
  const taskbarBottom = Math.round((bounds.y + bounds.height) - (workArea.y + workArea.height))
  const taskbarLeft = Math.round(workArea.x - bounds.x)
  const taskbarRight = Math.round((bounds.x + bounds.width) - (workArea.x + workArea.width))
  const horizontalX = taskbarWidgetSettings.position === 'center'
    ? Math.round(bounds.x + (bounds.width - width) / 2)
    : (() => {
        // 右侧：紧贴系统托盘左侧外部（间隙 8px），避免叠进托盘/时钟区域
        const trayLeft = getTaskbarTrayLeftDip()
        if (trayLeft !== null && trayLeft - width - 8 >= bounds.x) {
          return Math.round(trayLeft - width - 8)
        }
        // 托盘尚未测出：保守预留 30% 屏宽，绝不叠进托盘
        return Math.round(bounds.x + bounds.width - width - Math.round(bounds.width * TASKBAR_TRAY_FALLBACK_RATIO))
      })()

  if (taskbarBottom > 0) {
    // 底部任务栏（Windows 11 默认）
    return { x: horizontalX, y: Math.round(bounds.y + bounds.height - taskbarBottom), width, height: taskbarBottom }
  }
  if (taskbarTop > 0) {
    // 顶部任务栏
    return { x: horizontalX, y: Math.round(bounds.y), width, height: taskbarTop }
  }
  if (taskbarLeft > 0) {
    // 左侧任务栏：竖条贴左缘（内容仍按横向布局，长度取用户宽度）
    return { x: Math.round(bounds.x), y: Math.round(bounds.y + (bounds.height - width) / 2), width: taskbarLeft, height: width }
  }
  if (taskbarRight > 0) {
    // 右侧任务栏：竖条贴右缘
    return { x: Math.round(bounds.x + bounds.width - taskbarRight), y: Math.round(bounds.y + (bounds.height - width) / 2), width: taskbarRight, height: width }
  }
  // 无任务栏/自动隐藏：贴底部
  return { x: Math.round(bounds.x + (bounds.width - width) / 2), y: Math.round(bounds.y + bounds.height - 40), width, height: 40 }
}

function dockTaskbarWidgetWindow() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  const pos = getTaskbarWidgetPosition()
  try {
    // 展开状态保留：重新贴边时按当前展开/收起状态应用对应高度
    if (taskbarWidgetExpanded) {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y - TASKBAR_WIDGET_POPUP_HEIGHT, width: pos.width, height: pos.height + TASKBAR_WIDGET_POPUP_HEIGHT })
    } else {
      taskbarWidgetWindow.setBounds(pos)
    }
  } catch { /* 忽略 */ }
}

function createTaskbarWidgetWindow() {
  if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) return taskbarWidgetWindow
  loadTaskbarWidgetSettings()
  const pos = getTaskbarWidgetPosition()
  // 窗口参数与可正常点击的桌面播放器保持一致（不设 type:'toolbar'/focusable:false/movable:false）：
  // 这三个参数组合在 Win11 透明置顶窗口上会导致系统命中测试跳过该窗口，点击永远落不进来。
  taskbarWidgetWindow = new BrowserWindow({
    ...pos,
    frame: false,
    transparent: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'taskbar-widget-preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  })
  taskbarWidgetWindow.setAlwaysOnTop(true, 'screen-saver')
  taskbarWidgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // 默认鼠标穿透。注意：不能靠 forward:true 转发 mouseenter 来切换交互态——
  // 在 Win11 + 透明置顶组合下，setIgnoreMouseEvents 每次切换都会让系统重新命中
  // 测试并触发 mouseenter/mouseleave 振荡，交互态永远不稳定，点击无法落窗。
  // 改为主进程光标轮询（startTaskbarWidgetPolling）检测悬停。
  try {
    taskbarWidgetWindow.setIgnoreMouseEvents(true, { forward: true })
  } catch { /* 忽略 */ }
  taskbarWidgetWindow.loadFile(path.join(__dirname, 'taskbar-widget.html'))
  taskbarWidgetWindow.on('closed', () => {
    taskbarWidgetWindow = null
    taskbarWidgetInteractive = false
    taskbarWidgetExpanded = false
    stopTaskbarWidgetPolling()
  })
  startTaskbarWidgetPolling()
  // 托盘位置后台测量：首次显示用保守预留，测出真实托盘后立即贴齐
  refreshTaskbarTray()
  return taskbarWidgetWindow
}

// 显示器/任务栏尺寸变化时重新贴边（任务栏高/宽变化、换显示器等）
function bindTaskbarDisplayMetrics() {
  if (taskbarDisplayMetricsBound) return
  taskbarDisplayMetricsBound = true
  const { screen } = require('electron')
  screen.on('display-metrics-changed', () => {
    taskbarTrayCache = null // 显示器变化后托盘位置作废，后台重测
    dockTaskbarWidgetWindow()
    refreshTaskbarTray()
  })
}

// 系统深浅色切换时刷新 widget 主题（推状态带 theme 字段）
let taskbarThemeSyncBound = false
function bindTaskbarThemeSync() {
  if (taskbarThemeSyncBound) return
  taskbarThemeSyncBound = true
  const { nativeTheme } = require('electron')
  nativeTheme.on('updated', () => {
    updateTaskbarWidget()
  })
}

/** 把当前播放状态推送到 widget（并控制显隐） */
// 仅进度变化时 1s 节流：避免渲染端每秒多次 timeupdate（约 4 次/s）把整份状态
// （含逐词歌词 words）序列化推送，widget 内部按 lastCur + rAF 插值，1s 更新足够平滑。
let taskbarWidgetLastSendAt = 0
let taskbarWidgetLastSendKey = ''
const TASKBAR_WIDGET_SEND_THROTTLE_MS = 1000

function updateTaskbarWidget() {
  if (process.platform !== 'win32') return
  // 设置仅在开关/更新设置时写入，这里节流重载（避免播放进度每秒触发同步读盘）
  if (Date.now() - taskbarWidgetSettingsLastLoad > TASKBAR_WIDGET_SETTINGS_RELOAD_MS) {
    loadTaskbarWidgetSettings()
    taskbarWidgetSettingsLastLoad = Date.now()
  }
  bindTaskbarDisplayMetrics()
  bindTaskbarThemeSync()
  const hasSong = Boolean(desktopPlayerState.song?.name)
  // 开启时始终显示（冷启动无歌时显示品牌名），关闭/用户手动关闭才隐藏
  if (!taskbarWidgetSettings.enabled || taskbarWidgetClosedByUser) {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed() && taskbarWidgetWindow.isVisible()) {
      taskbarWidgetWindow.hide()
    }
    return
  }
  const win = createTaskbarWidgetWindow()
  if (!win) return
  const song = desktopPlayerState.song || {}
  const lyric = desktopPlayerState.lyric || null
  const { nativeTheme } = require('electron')
  // 内容键：歌曲/播放态/歌词行/静音/主题变化必须立即推送，仅进度变化时允许节流
  const contentKey = `${song.name}|${desktopPlayerState.playing === true}|${lyric?.line || ''}|${desktopPlayerState.muted === true}|${nativeTheme.shouldUseDarkColors}`
  const now = Date.now()
  if (contentKey === taskbarWidgetLastSendKey && now - taskbarWidgetLastSendAt < TASKBAR_WIDGET_SEND_THROTTLE_MS) {
    return
  }
  taskbarWidgetLastSendKey = contentKey
  taskbarWidgetLastSendAt = now
  const payload = {
    title: song.name || '',
    artist: Array.isArray(song.artists) ? song.artists.join(' / ') : (song.artists || ''),
    cover: song.coverUrl || '',
    playing: desktopPlayerState.playing === true,
    cur: Number(desktopPlayerState.progress) || 0,
    dur: Number(desktopPlayerState.duration) || 0,
    muted: desktopPlayerState.muted === true,
    // 歌曲主题色：暂停按钮/进度条跟随（App 推送 dominantColor）
    accent: String(desktopPlayerState.accentColor || '') || '#FB7299',
    lyric: lyric ? {
      line: lyric.line || '',
      nextLine: lyric.nextLine || '',
      translation: lyric.translation || '',
      nextTranslation: lyric.nextTranslation || '',
      lineStart: Number(lyric.lineStart) || 0,
      lineDuration: Number(lyric.lineDuration) || 0,
      // 逐词时序（毫秒，相对行首）：任务栏按词做「柔和」式逐字填充，与播放页同一套归一化逻辑
      words: Array.isArray(lyric.words)
        ? lyric.words.map((w) => ({
            word: String(w?.word ?? ''),
            startTime: Number(w?.startTime) || 0,
            duration: Number(w?.duration) || 0,
          }))
        : [],
    } : null,
    theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  }
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return
      win.showInactive()
      win.webContents.send('taskbar-widget:state', payload)
    })
  } else {
    win.webContents.send('taskbar-widget:state', payload)
    if (!win.isVisible()) win.showInactive()
  }
}

/** 显示/隐藏任务栏 widget（兼容旧调用；新入口统一走 set-enabled 持久化设置） */
function setTaskbarWidgetVisible(visible) {
  if (process.platform !== 'win32') return { success: false, reason: '仅支持 Windows' }
  taskbarWidgetClosedByUser = !visible
  if (visible) {
    updateTaskbarWidget()
  } else {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
  }
  return { success: true }
}

// 光标轮询：任务栏 widget 悬停检测。页面 mouseenter/mouseleave 转发在
// 透明置顶窗口上会因 setIgnoreMouseEvents 切换而振荡，改由主进程每 120ms
// 判断光标是否落在窗口内，据此稳定切换交互态（见 createTaskbarWidgetWindow 注释）。
let taskbarWidgetPollTimer = null

function taskbarWidgetCursorInside() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed() || !taskbarWidgetWindow.isVisible()) return false
  const { screen } = require('electron')
  const pt = screen.getCursorScreenPoint()
  const b = taskbarWidgetWindow.getBounds()
  return pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height
}

function updateTaskbarWidgetInteractive() {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  // 窗口隐藏时无需轮询/发 hover IPC：直接停（创建窗口后、窗口销毁前由 show/hide 触发重测）
  if (!taskbarWidgetWindow.isVisible()) {
    if (taskbarWidgetInteractive) {
      taskbarWidgetInteractive = false
      try { taskbarWidgetWindow.setIgnoreMouseEvents(true, { forward: true }) } catch { /* 忽略 */ }
    }
    return
  }
  const inside = taskbarWidgetCursorInside()
  if (inside !== taskbarWidgetInteractive) {
    taskbarWidgetInteractive = inside
    if (inside) {
      try {
        taskbarWidgetWindow.moveTop() // 进入交互态时确保窗口在该位置最顶，点击不被其他窗口截走
      } catch { /* 忽略 */ }
    }
    try {
      taskbarWidgetWindow.setIgnoreMouseEvents(!inside, { forward: true })
    } catch { /* 忽略 */ }
  }
  if (taskbarWidgetWindow.isDestroyed()) return
  // 通知页面悬停状态：进入取消收拢定时器，离开触发收拢（原 mouseleave 行为）
  taskbarWidgetWindow.webContents.send('taskbar-widget:hover', inside === true)
  // 托盘缓存过期时后台重测并贴齐（托盘图标增减改变宽度也能跟上）
  if (inside && taskbarTrayCache && Date.now() - taskbarTrayCacheAt > TASKBAR_TRAY_CACHE_MS) {
    refreshTaskbarTray()
  }
}

function startTaskbarWidgetPolling() {
  if (taskbarWidgetPollTimer) return
  taskbarWidgetPollTimer = setInterval(updateTaskbarWidgetInteractive, 120)
}

function stopTaskbarWidgetPolling() {
  if (taskbarWidgetPollTimer) {
    clearInterval(taskbarWidgetPollTimer)
    taskbarWidgetPollTimer = null
  }
}

ipcMain.on('taskbar-widget:action', (_event, action, payload) => {
  if (action === 'close') {
    taskbarWidgetClosedByUser = true
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
    return
  }
  if (action === 'seek' && typeof payload === 'number') {
    dispatchPlayerControl('seek', payload)
    return
  }
  if (action === 'toggleMute') {
    dispatchPlayerControl('mute')
    return
  }
  if (action === 'toggle' || action === 'prev' || action === 'next') {
    dispatchPlayerControl(action)
    return
  }
})

// 点击播控展开/收起：窗口高度在任务栏高度上额外加一段，供向上弹出的按钮面板显示
const TASKBAR_WIDGET_POPUP_HEIGHT = 218
ipcMain.on('taskbar-widget:set-expanded', (_event, expanded) => {
  if (!taskbarWidgetWindow || taskbarWidgetWindow.isDestroyed()) return
  taskbarWidgetExpanded = expanded === true
  try {
    const pos = getTaskbarWidgetPosition()
    if (taskbarWidgetExpanded) {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y - TASKBAR_WIDGET_POPUP_HEIGHT, width: pos.width, height: pos.height + TASKBAR_WIDGET_POPUP_HEIGHT })
    } else {
      taskbarWidgetWindow.setBounds({ x: pos.x, y: pos.y, width: pos.width, height: pos.height })
    }
  } catch { /* 忽略 */ }
})

ipcMain.on('taskbar-widget:set-interactive', (_event, interactive) => {
  // 已废弃：交互态改由主进程光标轮询（updateTaskbarWidgetInteractive）维护，
  // 页面驱动的 setInteractive 在透明置顶窗口上会造成 mouseenter/mouseleave 振荡。
  // 保留空处理器仅为兼容旧 preload 调用，不再改变窗口鼠标穿透状态。
})

ipcMain.handle('taskbar-widget:set-visible', (_event, visible) => setTaskbarWidgetVisible(Boolean(visible)))
ipcMain.handle('taskbar-widget:get-state', () => ({
  visible: Boolean(taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed() && taskbarWidgetWindow.isVisible()),
  closedByUser: taskbarWidgetClosedByUser,
}))

// 设置-个性化 开关：启用/禁用任务栏迷你播控（持久化）
ipcMain.handle('taskbar-widget:set-enabled', (_event, enabled) => {
  if (process.platform !== 'win32') return { success: false, reason: '仅支持 Windows' }
  loadTaskbarWidgetSettings()
  taskbarWidgetSettings = { ...taskbarWidgetSettings, enabled: enabled === true }
  saveTaskbarWidgetSettings()
  taskbarWidgetClosedByUser = false
  if (taskbarWidgetSettings.enabled) {
    updateTaskbarWidget()
  } else {
    if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.hide()
  }
  broadcastTaskbarWidgetSettings()
  return { success: true, enabled: taskbarWidgetSettings.enabled }
})

ipcMain.handle('taskbar-widget:get-settings', () => {
  loadTaskbarWidgetSettings()
  return getTaskbarWidgetSettings()
})

ipcMain.handle('taskbar-widget:update-settings', (_event, partial) => {
  loadTaskbarWidgetSettings()
  taskbarWidgetSettings = sanitizeTaskbarWidgetSettings(partial || {}, taskbarWidgetSettings)
  saveTaskbarWidgetSettings()
  dockTaskbarWidgetWindow()
  broadcastTaskbarWidgetSettings()
  return getTaskbarWidgetSettings()
})


// ===== 遥控器：局域网 Web 服务 + 虚拟鼠标桥接 =====
let remoteServer = null
const remoteSettings = { theme: 'dark', topRightAction: 'song', gestures: { doubleTap: true, swipe: true, twoFinger: true, twoFingerTap: true } }

function remoteSettingsPath() {
  return path.join(app.getPath('userData'), 'remote-settings.json')
}

function loadRemoteSettings() {
  try {
    const raw = fs.readFileSync(remoteSettingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed.theme === 'light' || parsed.theme === 'dark') remoteSettings.theme = parsed.theme
    if (['song', 'comment', 'artist', 'favorite', 'desktop-lyrics', 'mode-switch'].includes(parsed.topRightAction)) remoteSettings.topRightAction = parsed.topRightAction
    if (parsed.gestures && typeof parsed.gestures === 'object') {
      if (typeof parsed.gestures.doubleTap === 'boolean') remoteSettings.gestures.doubleTap = parsed.gestures.doubleTap
      if (typeof parsed.gestures.swipe === 'boolean') remoteSettings.gestures.swipe = parsed.gestures.swipe
      if (typeof parsed.gestures.twoFinger === 'boolean') remoteSettings.gestures.twoFinger = parsed.gestures.twoFinger
      if (typeof parsed.gestures.twoFingerTap === 'boolean') remoteSettings.gestures.twoFingerTap = parsed.gestures.twoFingerTap
    }
  } catch {
    // 首次运行 / 文件缺失：使用默认
  }
}

function saveRemoteSettings() {
  try {
    const tmp = remoteSettingsPath() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(remoteSettings, null, 2), 'utf8')
    fs.renameSync(tmp, remoteSettingsPath())
  } catch (err) {
    console.error('[Remote] 保存设置失败:', err)
  }
}

function getRemoteSettings() {
  return { ...remoteSettings }
}

function ensureRemoteServer() {
  if (remoteServer) return remoteServer
  remoteServer = createRemoteServer({
    getComputerName: () => os.hostname(),
    getSettings: () => remoteSettings,
    getState: () => getDesktopPlayerSnapshot(),
    sendControl: (action, payload) => {
      safeSendToWindow(mainWindow, 'desktop-player:control', action, payload)
    },
    sendCursor: (cmd, data) => {
      safeSendToWindow(mainWindow, 'remote:cursor', { cmd, ...(data || {}) })
    },
    onClientsChange: (status) => {
      safeSendToWindow(mainWindow, 'remote:clients', status)
    },
  })
  return remoteServer
}

ipcMain.handle('remote:start', async (_event, requestedPort) => {
  const srv = ensureRemoteServer()
  try {
    return await srv.start(Number(requestedPort) || 25566)
  } catch (err) {
    return { running: false, error: err && err.message ? err.message : String(err) }
  }
})

ipcMain.handle('remote:stop', () => {
  if (remoteServer) remoteServer.stop()
  return remoteServer ? remoteServer.status() : { running: false, port: 25566, token: '', clientCount: 0, ips: getLanIPv4Addresses() }
})

ipcMain.handle('remote:get-status', () => (
  remoteServer
    ? remoteServer.status()
    : { running: false, port: 25566, token: '', clientCount: 0, ips: getLanIPv4Addresses() }
))

ipcMain.handle('remote:get-settings', () => getRemoteSettings())

ipcMain.handle('remote:update-settings', (_event, partial) => {
  if (partial && typeof partial === 'object') {
    if (partial.theme === 'light' || partial.theme === 'dark') remoteSettings.theme = partial.theme
    if (['song', 'comment', 'artist', 'favorite', 'desktop-lyrics', 'mode-switch'].includes(partial.topRightAction)) remoteSettings.topRightAction = partial.topRightAction
    if (partial.gestures && typeof partial.gestures === 'object') {
      if (typeof partial.gestures.doubleTap === 'boolean') remoteSettings.gestures.doubleTap = partial.gestures.doubleTap
      if (typeof partial.gestures.swipe === 'boolean') remoteSettings.gestures.swipe = partial.gestures.swipe
      if (typeof partial.gestures.twoFinger === 'boolean') remoteSettings.gestures.twoFinger = partial.gestures.twoFinger
      if (typeof partial.gestures.twoFingerTap === 'boolean') remoteSettings.gestures.twoFingerTap = partial.gestures.twoFingerTap
    }
  }
  saveRemoteSettings()
  if (remoteServer) remoteServer.pushConfig()
  return getRemoteSettings()
})

function getWindowsSystemLocation() {
  const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Devices.Geolocation.Geolocator, Windows, ContentType=WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetGenericArguments().Count -eq 1 -and $_.GetParameters().Count -eq 1 } |
  Select-Object -First 1
$accessOperation = [Windows.Devices.Geolocation.Geolocator]::RequestAccessAsync()
$accessTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.GeolocationAccessStatus]).Invoke($null, @($accessOperation))
$access = $accessTask.GetAwaiter().GetResult()
if ([string]$access -ne 'Allowed') {
  throw "Windows location permission is $access"
}
$geolocator = New-Object Windows.Devices.Geolocation.Geolocator
$positionOperation = $geolocator.GetGeopositionAsync()
$positionTask = $asTask.MakeGenericMethod([Windows.Devices.Geolocation.Geoposition]).Invoke($null, @($positionOperation))
$position = $positionTask.GetAwaiter().GetResult()
$point = $position.Coordinate.Point.Position
[pscustomobject]@{
  latitude = $point.Latitude
  longitude = $point.Longitude
  accuracy = $position.Coordinate.Accuracy
} | ConvertTo-Json -Compress
`

  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || '无法读取 Windows 系统定位'))
          return
        }
        try {
          const jsonLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop()
          const location = JSON.parse(jsonLine || '{}')
          const latitude = Number(location.latitude)
          const longitude = Number(location.longitude)
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            throw new Error('Windows 系统定位没有返回有效坐标')
          }
          resolve({
            latitude,
            longitude,
            accuracy: Number(location.accuracy) || null,
            source: 'windows',
          })
        } catch (parseError) {
          reject(parseError)
        }
      },
    )
  })
}


protocol.registerSchemesAsPrivileged([
  {
    scheme: 'waveforge-media',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      // 关键：允许从 http://127.0.0.1:3000（渲染 origin）跨源 fetch 该协议。
      // 缺失时 AI 混音 wav（waveforge-media://）被 Chromium CORS 拦截 → 缓冲加载失败
      // → 回退普通交叉淡化 → 音量突变 + MV 预载链路断裂（用户实测的"介入即衰减/
      // MV 不叠加/封面回退"均由此引起）。registerSchemesAsPrivileged 仅在启动时生效，
      // 修改后必须完全重启应用。
      corsEnabled: true,
    },
  },
])

function createWindow() {
  // 开发模式下主页面加载很快，必须让启动画面先完成绘制并保持可见，
  // 否则 splash 的淡入和音波动画还没显示就会被主窗口关闭。
  // 软件合成（GPU 加速禁用）下内容层提交慢，splash 最短可见时间动态加长，
  // 给 logo/文字/音波足够时间真正上屏（否则只见深色底 ≈ 黑屏）。
  const splashMinVisibleMs = isDev ? 1800 : (gpuCompositingDisabled ? 3500 : 1200)
  let splashShownAt = 0

  const splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // 显示时机：等渲染器完成首帧绘制（ready-to-show）再 show。
    // 本机 GPU 合成器为 disabled_software（软件合成，GPU 加速禁用）：
    // 窗口隐藏时渲染器默认暂停绘制（paintWhenInitiallyHidden=false），首帧可能
    // 不完整；ready-to-show 触发≠内容已上屏，show 时窗口表面可能是 OS 默认白。
    // 修复：paintWhenInitiallyHidden:true 让渲染器在隐藏时也持续绘制，
    // 首帧内容（深色底+logo+文字+音波）在 show 前已完整就绪。
    show: false,
    backgroundColor: '#0a0f14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      paintWhenInitiallyHidden: true,  // 隐藏时持续绘制，splash 首帧内容完整
    },
  })

  let splashShown = false
  const showSplash = () => {
    if (splashShown || splashWindow.isDestroyed() || splashWindow.isVisible()) return
    splashShown = true
    splashShownAt = Date.now()
    splashWindow.show()
    splashWindow.focus()
    logStartupTiming(`Splash animation shown`)
  }
  let splashLoadDone = false
  let splashFrameDone = false
  const tryShowSplash = () => {
    if (splashLoadDone && splashFrameDone) showSplash()
  }
  splashWindow.once('ready-to-show', () => {
    splashFrameDone = true
    tryShowSplash()
  })
  const splashReady = splashWindow.loadFile(path.join(__dirname, 'splash.html'))
    .then(() => {
      splashLoadDone = true
      tryShowSplash()
      return true
    })
    .catch(error => {
      console.warn('[Startup] Failed to load splash animation:', error.message)
      splashLoadDone = true
      tryShowSplash()
      return false
    })
  setTimeout(() => {
    splashLoadDone = true
    splashFrameDone = true
    tryShowSplash()
  }, 3000)
  // 创建主窗口：默认原生不透明窗口（Windows 11 系统圆角/阴影/对齐吸附）。
  // 桌面融合穿透需要透明窗口，而 transparent 仅创建时生效——开启/关闭融合时
  // 由 recreateMainWindow 销毁重建切换透明属性，普通模式始终用原生窗口。
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: '#000000',
    transparent: false,
    titleBarStyle: 'hidden',
    title: 'WaveForge 澜音工坊',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    roundedCorners: true,
    show: false, // 初始隐藏窗口
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      paintWhenInitiallyHidden: true,  // 软件合成下隐藏时也持续绘制，避免显示时首帧空白
      backgroundThrottling: false, // Chroma 后台联动；各可视化仍由订阅者/可见性自行门控
    },
  })

  // 阻止同窗口被导航到外部站点（特权 preload 桥只允许停留在应用自身地址）
  guardAgainstExternalNavigation(mainWindow.webContents)

  // ── 窗口状态记忆：恢复上次关闭时的窗口布局（大小/位置/显示器/全屏或最大化） ──
  // 仅当记录的版本与当前版本一致（未经过应用内更新）时恢复，否则保持默认（主屏 + 1400×900）。
  const savedWindowState = loadWindowState(app)
  if (savedWindowState) {
    try {
      const { screen } = require('electron')
      const displays = screen.getAllDisplays()
      const targetDisplay = displays.find((d) => d.id === savedWindowState.displayId) || screen.getPrimaryDisplay()
      const bounds = clampBoundsToWorkArea(savedWindowState.bounds, targetDisplay.workArea)
      mainWindow.setBounds(bounds)
      if (savedWindowState.state === 'maximized') {
        // 窗口尚未显示时 maximize 可能不生效，等 show 后再设置
        mainWindow.once('show', () => {
          if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isKiosk()) {
            mainWindow.maximize()
            mainWindowExpanded = true
          }
        })
      } else if (savedWindowState.state === 'kiosk') {
        // 全屏覆盖任务栏（kiosk）：同样等窗口显示后再进入
        mainWindow.once('show', () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.setKiosk(true)
            mainWindowExpanded = true
          }
        })
      }
    } catch (error) {
      console.error('[WindowState] 恢复窗口状态失败:', error?.message || error)
    }
  }

  // 开发模式加载 Vite 服务器
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[ProcessHealth] Main renderer exited:', {
      reason: details?.reason,
      exitCode: details?.exitCode,
    })
  })

  mainWindow.webContents.once('dom-ready', () => {
    logStartupTiming('Main renderer DOM ready')
  })
  mainWindow.webContents.once('did-finish-load', async () => {
    logStartupTiming('Main renderer finished loading')
    // 资源加载完成（React 已挂载）——满足主窗显示条件之一
    mainLoaded = true
    showMainWindowWhenReady()
    try {
      const rendererMetrics = await mainWindow.webContents.executeJavaScript(`(() => {
        const resources = performance.getEntriesByType('resource')
          .map(entry => ({
            name: entry.name.replace(location.origin, ''),
            duration: Math.round(entry.duration),
            startTime: Math.round(entry.startTime),
            transferSize: entry.transferSize || 0,
          }))
          .sort((left, right) => right.duration - left.duration)
        return {
          resourceCount: resources.length,
          slowestResources: resources.slice(0, 12),
        }
      })()`)
      logStartupTiming(`Renderer resources: ${rendererMetrics.resourceCount}; slowest: ${JSON.stringify(rendererMetrics.slowestResources)}`)
    } catch (error) {
      logStartupTiming(`Renderer performance metrics unavailable: ${error.message}`)
    }
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) {
      logStartupTiming(`Main renderer failed to load (${errorCode}: ${errorDescription}) ${validatedURL}`)
    }
  })

  // ===== WF_SMOKE=1 冒烟自检：验证新增功能（AirPlay / 任务栏播控 / 音频设备）主进程接线，随后自动退出 =====
  if (process.env.WF_SMOKE === '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      const results = []
      const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail })
      try {
        // 1) 任务栏迷你播控：位置计算 + 窗口创建（win32）
        const pos = typeof getTaskbarWidgetPosition === 'function' ? getTaskbarWidgetPosition() : null
        check('taskbar position sane', Boolean(pos && pos.width >= 260 && pos.width <= 420 && pos.height >= 1 && Number.isFinite(pos.x) && Number.isFinite(pos.y)), JSON.stringify(pos))
        const settings = loadTaskbarWidgetSettings()
        check('taskbar settings load', settings && ['right', 'center'].includes(settings.position) && settings.width >= 260 && settings.width <= 420, JSON.stringify(settings))
        if (process.platform === 'win32') {
          const widgetWin = createTaskbarWidgetWindow()
          const widgetBounds = widgetWin ? widgetWin.getBounds() : null
          check('taskbar widget window', Boolean(widgetWin && !widgetWin.isDestroyed()), JSON.stringify(widgetBounds))
          if (widgetBounds && pos) check('taskbar widget height == taskbar band', widgetBounds.height === pos.height, `${widgetBounds.height} vs ${pos.height}`)
          if (widgetWin && !widgetWin.isDestroyed()) widgetWin.close()
        }
        // 2) AirPlay 投送端：服务已启动（mDNS 浏览中）+ 设备列表接口可用
        const airplayService = airplayControllerHandle?.service
        check('airplay service started', Boolean(airplayService), '')
        const airplayStatus = airplayService?.getStatus ? airplayService.getStatus() : null
        check('airplay status browsing', Boolean(airplayStatus && (airplayStatus.phase === 'browsing' || airplayStatus.phase === 'idle')), JSON.stringify(airplayStatus && { phase: airplayStatus.phase, devices: airplayStatus.devices.length }))
        check('airplay devices array', Array.isArray(airplayService?.listDevices ? airplayService.listDevices() : null), '')
        // 3) 音频输出设备：渲染进程 enumerateDevices 真实返回 audiooutput（权限 handler 生效）
        mainWindow.webContents.executeJavaScript(`(async () => {
          try {
            const devices = await navigator.mediaDevices.enumerateDevices()
            return {
              ok: true,
              outputs: devices.filter(d => d.kind === 'audiooutput').map(d => ({ label: d.label || '', id: d.deviceId.slice(0, 8) })),
              mediaSupported: typeof navigator.mediaDevices.enumerateDevices === 'function',
            }
          } catch (error) {
            return { ok: false, error: String(error && error.message || error) }
          }
        })()`).then((result) => {
          check('enumerateDevices available', Boolean(result && result.ok && result.mediaSupported), JSON.stringify(result && result.outputs))
          check('audiooutput devices listed', Boolean(result && result.ok && Array.isArray(result.outputs) && result.outputs.length >= 0), JSON.stringify(result && result.outputs))
          finishSmoke(results)
        }).catch((error) => {
          check('enumerateDevices js', false, String(error && error.message || error))
          finishSmoke(results)
        })
      } catch (error) {
        check('smoke crash', false, String(error && error.stack || error))
        finishSmoke(results)
      }
    })
    const finishSmoke = (results) => {
      const failed = results.filter(r => !r.ok)
      console.log('=== WF_SMOKE RESULTS ===')
      for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`)
      console.log(`=== WF_SMOKE SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
      try { if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.close() } catch {}
      setTimeout(() => app.exit(failed.length === 0 ? 0 : 1), 200)
    }
  }

  if (isDev) {
    mainWindow.loadURL(devServerUrl)
    if (process.env.WAVEFORGE_OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools()
    }
  } else {
    // 生产模式加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
  
  // 主窗口显示：等「首帧渲染完成」且「资源加载完成（React 已挂载）」都满足才显示。
  // 仅依赖 ready-to-show 会在首帧（可能只是纯背景色帧）时就显示，用户会先看到黑屏再闪出内容；
  // 双条件保证 show 时页面内容已就绪，配合 splash 最短可见时间，启动画面自然过渡到主界面。
  let mainFirstFrameReady = false
  let mainLoaded = false
  let mainShown = false
  const showMainWindowWhenReady = () => {
    if (mainShown || !mainWindow || mainWindow.isDestroyed()) return
    if (!mainFirstFrameReady || !mainLoaded) return
    mainShown = true
    const visibleForMs = splashShownAt > 0 ? Date.now() - splashShownAt : 0
    // splash 实际显示过才保证最短可见时间；未显示（加载失败等）则立即切换主窗
    const remainingMs = splashShownAt > 0
      ? Math.max(0, splashMinVisibleMs - visibleForMs)
      : 0

    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.show()
      mainWindow.focus()
      if (!splashWindow.isDestroyed()) splashWindow.close()
      logStartupTiming('Main window shown')
    }, remainingMs)
  }
  // 兜底：任一事件异常未触发（如 GPU 合成器问题），8s 后强制显示，避免永远黑屏卡住
  setTimeout(() => {
    mainFirstFrameReady = true
    mainLoaded = true
    showMainWindowWhenReady()
  }, 8000)
  mainWindow.once('ready-to-show', () => {
    mainFirstFrameReady = true
    showMainWindowWhenReady()
  })
  // 事件接线（状态推送/窗口记忆/F12 等）——与融合穿透重建（recreateMainWindow）共用
  wireMainWindowEvents(mainWindow)
}

// ========== 壁纸功能 ==========

// 获取 Windows 当前桌面壁纸路径
function detectImageMime(buffer, filePath) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer.length >= 3 && buffer.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp'

  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/jpeg'
}

let wallpaperPayloadCache = null

async function buildWallpaperPayload(wallpaperPath) {
  const stats = await fs.promises.stat(wallpaperPath)
  const cacheKey = `${path.resolve(wallpaperPath)}:${stats.size}:${stats.mtimeMs}`
  if (wallpaperPayloadCache?.key === cacheKey) {
    return { ...wallpaperPayloadCache.payload }
  }

  // 壁纸 2-10MB：异步整读 + base64，避免阻塞主线程（原同步读取会造成事件循环尖峰）
  const buffer = await fs.promises.readFile(wallpaperPath)
  const mimeType = detectImageMime(buffer, wallpaperPath)
  const payload = {
    path: wallpaperPath,
    fileUrl: pathToFileURL(wallpaperPath).href,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    mimeType,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  }
  wallpaperPayloadCache = { key: cacheKey, payload }
  return { ...payload }
}

function toMediaUrl(filePath) {
  const resolved = path.resolve(filePath)
  allowedMediaFiles.delete(resolved)
  allowedMediaFiles.add(resolved)
  while (allowedMediaFiles.size > MAX_ALLOWED_MEDIA_FILES) {
    const oldest = allowedMediaFiles.values().next().value
    if (!oldest) break
    allowedMediaFiles.delete(oldest)
  }
  return `waveforge-media://local/${encodeURIComponent(resolved)}`
}

function registerMediaProtocol() {
  protocol.registerFileProtocol('waveforge-media', (request, callback) => {
    try {
      const url = new URL(request.url)
      const encodedPath = url.pathname.replace(/^\/+/, '')
      const filePath = path.resolve(decodeURIComponent(encodedPath))

      if (!filePath || !allowedMediaFiles.has(filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        callback({ error: -6 })
        return
      }

      callback({ path: filePath })
    } catch (error) {
      console.warn('[MediaProtocol] Failed to resolve media URL:', error.message)
      callback({ error: -2 })
    }
  })
}

const WALLPAPER_ENGINE_CONFIG_CACHE_MS = 60_000
let wallpaperEngineConfigPathCache = null
let wallpaperEngineConfigPathCacheExpiresAt = 0
let wallpaperEngineConfigRequest = null

// 异步解析 Wallpaper Engine config 路径。原实现用 execFileSync('powershell.exe', ..., timeout:5000)，
// 被壁纸 watcher（每 10s tick）与 get-current-wallpaper IPC 触发时最坏每 60s 缓存过期一次、
// 最长冻结主线程 5 秒。改为 execFile 异步 + 缓存 Promise（同 windowsWallpaperRequest / desktopWidgetDiskRequest 模式），
// 过期期间并发调用共享同一个在途请求。
function getWallpaperEngineConfigPath() {
  const now = Date.now()
  if (now < wallpaperEngineConfigPathCacheExpiresAt) {
    return Promise.resolve(wallpaperEngineConfigPathCache)
  }
  if (wallpaperEngineConfigRequest) return wallpaperEngineConfigRequest

  wallpaperEngineConfigRequest = new Promise((resolve) => {
    const candidates = []
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process wallpaper32,wallpaper64 -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path)',
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 },
      (error, stdout) => {
        if (error) {
          console.warn('[WallpaperEngine] Process lookup failed:', error.message)
        } else {
          const processPath = String(stdout || '').trim()
          if (processPath) candidates.push(path.join(path.dirname(processPath), 'config.json'))
        }

        candidates.push(
          path.join(process.env.ProgramFiles || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
          path.join(process.env['ProgramFiles(x86)'] || '', 'Steam', 'steamapps', 'common', 'wallpaper_engine', 'config.json'),
          'D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine\\config.json'
        )

        wallpaperEngineConfigPathCache = candidates.find(candidate => candidate && fs.existsSync(candidate)) || null
        wallpaperEngineConfigPathCacheExpiresAt = Date.now() + WALLPAPER_ENGINE_CONFIG_CACHE_MS
        resolve(wallpaperEngineConfigPathCache)
      }
    )
  }).finally(() => {
    wallpaperEngineConfigRequest = null
  })

  return wallpaperEngineConfigRequest
}

function getWallpaperEngineSourceType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (['.mp4', '.webm', '.mov', '.m4v', '.avi', '.mkv'].includes(ext)) return 'video'
  if (['.html', '.htm'].includes(ext)) return 'web'
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (ext === '.json' || ext === '.pkg') return 'scene'
  if (ext === '.exe') return 'application'
  return 'unknown'
}

function findWallpaperEngineUserConfig(config) {
  return Object.values(config).find((value) => (
    value &&
    typeof value === 'object' &&
    value.general &&
    value.general.wallpaperconfig &&
    value.general.wallpaperconfig.selectedwallpapers
  ))
}

async function getWallpaperEngineSource() {
  try {
    const configPath = await getWallpaperEngineConfigPath()
    if (!configPath) return null

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const userConfig = findWallpaperEngineUserConfig(config)
    const selected = userConfig?.general?.wallpaperconfig?.selectedwallpapers
    if (!selected || typeof selected !== 'object') return null

    const monitor = selected.Monitor0 ? 'Monitor0' : Object.keys(selected)[0]
    const wallpaper = selected[monitor]
    const wallpaperPath = wallpaper?.file
    if (!wallpaperPath || !fs.existsSync(wallpaperPath)) return null

    const stats = fs.statSync(wallpaperPath)
    const sourceType = getWallpaperEngineSourceType(wallpaperPath)

    // 对于 Scene 类型壁纸，标记为不支持
    if (sourceType === 'scene') {
      logWallpaper('[WallpaperEngine] Scene wallpaper detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'scene',
        path: wallpaperPath
      }
    }
    
    // 对于 Web 类型壁纸，尝试提取视频文件
    if (sourceType === 'web') {
      const wallpaperDir = path.dirname(wallpaperPath)
      logWallpaper('[WallpaperEngine] Web wallpaper detected, searching for video files in:', wallpaperDir)
      
      // 搜索目录中的视频文件
      const videoExtensions = ['.mp4', '.webm', '.mov', '.m4v']
      let foundVideo = null
      
      try {
        const files = fs.readdirSync(wallpaperDir)
        for (const file of files) {
          const ext = path.extname(file).toLowerCase()
          if (videoExtensions.includes(ext)) {
            foundVideo = path.join(wallpaperDir, file)
            logWallpaper('[WallpaperEngine] Found video file:', foundVideo)
            break
          }
        }
        
        // 如果找到视频文件，返回视频源
        if (foundVideo && fs.existsSync(foundVideo)) {
          const videoStats = fs.statSync(foundVideo)
          logWallpaper('[WallpaperEngine] Using extracted video from web wallpaper:', foundVideo)
          
          return {
            path: foundVideo,
            fileUrl: pathToFileURL(foundVideo).href,
            mediaUrl: toMediaUrl(foundVideo),
            sourceType: 'video', // 改为 video 类型
            monitor,
            local: Boolean(wallpaper.local),
            title: path.basename(wallpaperDir), // 使用目录名作为标题
            size: videoStats.size,
            mtimeMs: videoStats.mtimeMs,
            configPath,
          }
        }
      } catch (err) {
        console.warn('[WallpaperEngine] Failed to search for video files:', err.message)
      }
      
      // 如果没有找到视频，标记为不支持
      logWallpaper('[WallpaperEngine] Web wallpaper has no extractable video, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'web',
        path: wallpaperPath
      }
    }
    
    // 对于 unknown 类型壁纸，标记为不支持
    if (sourceType === 'unknown') {
      logWallpaper('[WallpaperEngine] Unknown wallpaper type detected - unsupported, falling back to Windows wallpaper')
      return {
        unsupported: true,
        sourceType: 'unknown',
        path: wallpaperPath
      }
    }

    return {
      path: wallpaperPath,
      fileUrl: pathToFileURL(wallpaperPath).href,
      mediaUrl: toMediaUrl(wallpaperPath),
      sourceType,
      monitor,
      local: Boolean(wallpaper.local),
      title: path.basename(wallpaperPath),
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      configPath,
    }
  } catch (error) {
    console.warn('[WallpaperEngine] Source lookup failed:', error.message)
    return null
  }
}

let windowsWallpaperRequest = null

function getWindowsWallpaper() {
  if (windowsWallpaperRequest) return windowsWallpaperRequest

  logWallpaper('🔍 [Wallpaper] 开始获取壁纸路径..')
  windowsWallpaperRequest = new Promise((resolve, reject) => {
    if (os.platform() !== 'win32') {
      console.error('❌ [Wallpaper] 不支持的操作系统:', os.platform())
      reject(new Error('此功能仅支持 Windows 系统'))
      return
    }
    logWallpaper('✅ [Wallpaper] 系统检查通过: Windows')

    execFile(
      'reg.exe',
      ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'],
      { encoding: null, maxBuffer: 1024 * 1024, windowsHide: true, timeout: 5000 },
      async (error, stdout, stderr) => {
        try {
          if (error) {
            console.error('❌ [Wallpaper] 注册表查询失败:', error.message)
            if (stderr?.length) console.error('❌ [Wallpaper] 错误输出:', new TextDecoder('gbk').decode(stderr))
            reject(error)
            return
          }

          const output = stdout?.length ? new TextDecoder('gbk').decode(stdout) : ''
          const match = output.match(/^\s*Wallpaper\s+REG_\w+\s+(.+?)\s*$/mi)
          const wallpaperPath = match?.[1]?.trim() || ''
          logWallpaper('📁 [Wallpaper] 壁纸路径:', wallpaperPath)

          if (wallpaperPath && fs.existsSync(wallpaperPath)) {
            logWallpaper('✓ [Wallpaper] 文件存在验证通过')
            const wallpaper = await buildWallpaperPayload(wallpaperPath)
            const wallpaperEngine = await getWallpaperEngineSource()
            if (wallpaperEngine) wallpaper.wallpaperEngine = wallpaperEngine
            // 多屏壁纸：Windows 把每块屏的独立壁纸转码为 Themes 目录的 TranscodedWallpaper 系列文件，
            // 一并采集进 payload 供 watcher 判断「任一屏幕壁纸变化」。
            try {
              const themesDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Themes')
              if (fs.existsSync(themesDir)) {
                const transcoded = fs.readdirSync(themesDir)
                  .filter(file => /^TranscodedWallpaper(_\d+)?$/.test(file))
                  .map(file => {
                    const filePath = path.join(themesDir, file)
                    let stat = null
                    try { stat = fs.statSync(filePath) } catch { return null }
                    return stat ? { file, path: filePath, mtimeMs: stat.mtimeMs, size: stat.size } : null
                  })
                  .filter(Boolean)
                if (transcoded.length > 0) wallpaper.wallpapers = transcoded
              }
            } catch (scanError) {
              logWallpaper('⚠️ [Wallpaper] 扫描多屏壁纸失败:', scanError?.message || scanError)
            }
            logWallpaper('🔗 [Wallpaper] 转换后的URL:', wallpaper.fileUrl)
            logWallpaper('📊 [Wallpaper] 壁纸数据:', {
              mimeType: wallpaper.mimeType,
              size: wallpaper.size,
              mtimeMs: wallpaper.mtimeMs,
              wallpapers: wallpaper.wallpapers?.length,
            })
            logWallpaper('✓ [Wallpaper] 壁纸获取成功')
            resolve(wallpaper)
          } else {
            console.error('❌ [Wallpaper] 文件不存在:', wallpaperPath)
            reject(new Error('壁纸文件不存在: ' + wallpaperPath))
          }
        } catch (err) {
          reject(err)
        }
      }
    )
  }).finally(() => {
    windowsWallpaperRequest = null
  })

  return windowsWallpaperRequest
}

// IPC 处理：获取当前壁纸
ipcMain.handle('get-current-wallpaper', async () => {
  logWallpaper('📞 [IPC] 收到获取壁纸请求')
  try {
    const wallpaper = await getWindowsWallpaper()
    logWallpaper('✓ [IPC] 返回壁纸:', wallpaper.fileUrl)
    return { success: true, ...wallpaper }
  } catch (error) {
    console.error('❌ [IPC] 获取壁纸失败:', error.message)
    return { success: false, error: error.message }
  }
})

// IPC 处理：打开外部链接
ipcMain.handle('open-external', async (event, url) => {
  logWallpaper('📞 [IPC] 收到打开外部链接请求:', url)
  try {
    const parsed = new URL(String(url || ''))
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { success: false, error: '只允许打开 HTTP 或 HTTPS 链接' }
    }
    await shell.openExternal(parsed.href)
    logWallpaper('✓ [IPC] 成功在默认浏览器中打开链接')
    return { success: true }
  } catch (error) {
    console.error('❌ [IPC] 打开外部链接失败:', error.message)
    return { success: false, error: error.message }
  }
})

ipcMain.handle('desktop-widgets:get-system-status', async () => {
  const current = readCpuTimes()
  const previous = desktopWidgetCpuSample
  desktopWidgetCpuSample = current
  const totalDelta = previous ? current.all - previous.all : 0
  const idleDelta = previous ? current.idle - previous.idle : 0
  const cpuUsage = totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
  const memoryTotal = os.totalmem()
  const memoryUsed = Math.max(0, memoryTotal - os.freemem())
  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal ? memoryUsed / memoryTotal * 100 : 0,
    disks: await readDesktopWidgetDisks(),
    uptime: os.uptime(),
    platform: `${os.type()} ${os.release()}`,
  }
})

ipcMain.handle('desktop-widgets:pick-launcher-target', async (_event, kind) => {
  const result = await dialog.showOpenDialog({
    title: kind === 'folder' ? '选择文件夹' : '选择应用或文件',
    properties: kind === 'folder' ? ['openDirectory'] : ['openFile'],
  })
  return result.canceled ? null : result.filePaths[0] || null
})

// 启动器组件合法的可执行/快捷方式类型；扩展名不在白名单内的一律拒绝打开。
const ALLOWED_LAUNCHER_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.lnk', '.url', '.msi', '.appref-ms',
])

ipcMain.handle('desktop-widgets:open-launcher-target', async (_event, target, kind) => {
  const value = String(target || '').trim()
  if (!value) return { success: false, error: '目标为空' }
  if (kind === 'url') {
    let parsed
    try { parsed = new URL(value) } catch { return { success: false, error: '网址无效' } }
    if (!['http:', 'https:'].includes(parsed.protocol)) return { success: false, error: '仅支持 HTTP/HTTPS 地址' }
    await shell.openExternal(parsed.href)
    return { success: true }
  }
  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved)) return { success: false, error: '文件或目录不存在' }
  // 仅允许启动器组件合法的可执行/快捷方式类型，阻止任意文件被当作程序启动。
  const extension = path.extname(resolved).toLowerCase()
  if (!ALLOWED_LAUNCHER_EXTENSIONS.has(extension)) {
    return { success: false, error: '不支持的文件类型' }
  }
  const error = await shell.openPath(resolved)
  return error ? { success: false, error } : { success: true }
})

// 启动壁纸监听（每10秒检查一次）
let lastWallpaperSignature = null
let wallpaperWatcherBusy = false

function stopWallpaperWatcher() {
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
    wallpaperWatcher = null
  }
  wallpaperWatcherBusy = false
  lastWallpaperSignature = null
}

function startWallpaperWatcher() {
  logWallpaper('[Watcher] Starting wallpaper watcher')
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
  }

  wallpaperWatcher = setInterval(async () => {
    logWallpaper('🔧 [Watcher] 检查壁纸变化..')
    // 重入保护：上一次 tick 尚未结束（如 powershell 查询最坏 5s 超时）则跳过本次，
    // 避免 10s interval 与仍在执行的检查重叠。
    if (wallpaperWatcherBusy) {
      logWallpaper('⏭️ [Watcher] 上次检查未完成，跳过本次')
      return
    }
    wallpaperWatcherBusy = true
    try {
      const wallpaper = await getWindowsWallpaper()
      const engineSignature = wallpaper.wallpaperEngine
        ? `${wallpaper.wallpaperEngine.path}:${wallpaper.wallpaperEngine.mtimeMs}:${wallpaper.wallpaperEngine.size}:${wallpaper.wallpaperEngine.sourceType}`
        : 'no-engine'
      const isLiveEngineWallpaper = wallpaper.wallpaperEngine &&
        (wallpaper.wallpaperEngine.sourceType === 'video' || wallpaper.wallpaperEngine.sourceType === 'web')
      const currentSignature = isLiveEngineWallpaper
        ? engineSignature
        : `${wallpaper.path}:${wallpaper.mtimeMs}:${wallpaper.size}:${engineSignature}`
      // 多屏：任一屏幕的独立壁纸（TranscodedWallpaper 系列）变化也视为壁纸变化
      const multiScreenSignature = Array.isArray(wallpaper.wallpapers)
        ? wallpaper.wallpapers.map(w => `${w.file}:${w.mtimeMs}:${w.size}`).join('|')
        : ''
      
      // 如果壁纸路径/任一屏幕壁纸发生变化，通知渲染进程
      if (`${currentSignature}|${multiScreenSignature}` !== lastWallpaperSignature) {
        logWallpaper('🎨 [Watcher] 检测到壁纸变化！')
        logWallpaper('   旧壁纸:', lastWallpaperSignature)
        logWallpaper('   新壁纸:', `${currentSignature}|${multiScreenSignature}`)
        lastWallpaperSignature = `${currentSignature}|${multiScreenSignature}`
        if (mainWindow && !mainWindow.isDestroyed()) {
          logWallpaper('📡 [Watcher] 发送壁纸变化事件到渲染进程')
          safeSendToWindow(mainWindow, 'wallpaper-changed', wallpaper)
        } else {
          console.warn('⚠️ [Watcher] 主窗口不存在或已销毁')
        }
      } else {
        logWallpaper('✅ [Watcher] 壁纸未变化')
      }
    } catch (error) {
      console.error('❌ [Watcher] 壁纸监听出错:', error.message)
    } finally {
      wallpaperWatcherBusy = false
    }
  }, 10000) // 每10秒检查一次
  
  logWallpaper('✓ [Watcher] 壁纸监听器已启动（10秒间隔）')
}

// 渲染端按需启停壁纸监控：仅在桌面模式 + 壁纸联动开启时启用（避免非桌面模式持续 powershell 查询拖慢性能）
ipcMain.handle('set-wallpaper-watcher', (_event, enabled) => {
  logWallpaper(`[Watcher] 收到启停请求: ${enabled ? '启动' : '停止'}`)
  if (enabled) {
    startWallpaperWatcher()
  } else {
    stopWallpaperWatcher()
  }
  return { success: true }
})

// ========== QQ音乐登录窗口 ==========

async function createQQLoginWindow() {
  return new Promise((resolve) => {
    if (qqLoginWindow || qqLoginWindowOpening) {
      if (qqLoginWindow && !qqLoginWindow.isDestroyed()) qqLoginWindow.focus()
      resolve({ success: false, error: 'QQ 音乐登录窗口已打开' })
      return
    }
    // 先同步占坑再清 Cookie：清理链路有 await，两次快速点击会在 await 间隙双双通过
    // 上面的检查并各开一个窗口，共享变量被后者覆盖（关闭时置 null 与实际窗口错位）
    qqLoginWindowOpening = true

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    // 清理 QQ 音乐相关的缓存和 Cookie
    void (async () => {
    try {
      const session = mainWindow.webContents.session
      
      console.log('🔧 [QQ登录] 清理 QQ 音乐缓存和 Cookie...')
      
      // 清理 Cookie
      const cookies = await session.cookies.get({ domain: '.qq.com' })
      for (const cookie of cookies) {
        await session.cookies.remove(`https://${cookie.domain}`, cookie.name)
      }
      
      // 登录窗口与主应用共用 session，不能清空全部 localStorage/indexDB，
      // 否则会连带删除 WaveForge 自身设置。QQ 域 Cookie 已在上面精准清理。
      console.log('✓ [QQ登录] QQ 域 Cookie 清理完成')
    } catch (err) {
      console.error('❌ [QQ登录] 清理缓存失败:', err)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
    
    qqLoginWindow = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: mainWindow,
      modal: true,
      frame: false, // 无边框
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'WaveForge 澜音工坊 - QQ音乐登录',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: mainWindow.webContents.session, // 共享 session 以保留 Cookie
      },
    })
    // 窗口已创建，解除同步占坑（此后由 qqLoginWindow 本身承担防重入）
    qqLoginWindowOpening = false

    // 导航守卫：登录页本身就是 y.qq.com（QQ 音乐官方域），登录流程还可能跳到
    // ptlogin2/graph 等 QQ 域做认证。只放行 qq.com 域（含子域），其余一律拦截并
    // 交给系统默认浏览器，避免共享 session 的 Cookie 被引导到外部站点。
    const isQQDomain = (url) => {
      try {
        const hostname = new URL(String(url || '')).hostname.toLowerCase()
        return hostname === 'qq.com' || hostname.endsWith('.qq.com')
      } catch {
        return false
      }
    }
    qqLoginWindow.webContents.on('will-navigate', (event, url) => {
      if (!isQQDomain(url)) {
        event.preventDefault()
        if (/^https?:\/\//i.test(String(url || ''))) {
          shell.openExternal(String(url)).catch(() => {})
        }
      }
    })
    // 阻止 window.open 创建新的 Electron 窗口；外链一律交给系统默认浏览器。
    qqLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(String(url || ''))) {
        shell.openExternal(String(url)).catch(() => {})
      }
      return { action: 'deny' }
    })

    // 加载 QQ 音乐喜欢的歌曲页面（需要登录）
    qqLoginWindow.loadURL('https://y.qq.com/n/ryqq_v2/profile/like/song')

    // 页面加载完成后注入关闭按钮
    qqLoginWindow.webContents.on('did-finish-load', () => {
      qqLoginWindow.webContents.executeJavaScript(`
        (function() {
          // 创建关闭按钮容器
          const closeBtn = document.createElement('div');
          closeBtn.id = 'waveforge-close-btn';
          closeBtn.innerHTML = \`
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          \`;
          
          // 样式
          closeBtn.style.cssText = \`
            position: fixed;
            top: 20px;
            right: 20px;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(10px);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            z-index: 999999;
            color: white;
            opacity: 0;
            transition: all 0.3s ease;
            pointer-events: auto;
          \`;
          
          // 鼠标悬停显示
          let hideTimer = null;
          
          function showButton() {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
          }
          
          function scheduleHide() {
            hideTimer = setTimeout(() => {
              closeBtn.style.opacity = '0';
            }, 3000);
          }
          
          closeBtn.addEventListener('mouseenter', () => {
            clearTimeout(hideTimer);
            closeBtn.style.opacity = '1';
            closeBtn.style.background = 'rgba(255, 0, 0, 0.7)';
          });
          
          closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(0, 0, 0, 0.5)';
            scheduleHide();
          });
          
          closeBtn.addEventListener('click', () => {
            window.close();
          });
          
          // 监听鼠标移动，靠近右上角时显示
          document.addEventListener('mousemove', (e) => {
            const distanceFromTopRight = Math.sqrt(
              Math.pow(window.innerWidth - e.clientX, 2) + 
              Math.pow(e.clientY, 2)
            );
            
            if (distanceFromTopRight < 150) {
              showButton();
              scheduleHide();
            }
          });
          
          // 添加到页面
          document.body.appendChild(closeBtn);
          
          // 初始显示3秒
          showButton();
          scheduleHide();
        })();
      `).catch(err => {
        console.error('❌ [QQ登录] 注入关闭按钮失败:', err)
      })
    })

    // 定期检查是否登录成功
    const checkLoginInterval = setInterval(async () => {
      if (!qqLoginWindow || qqLoginWindow.isDestroyed()) {
        clearInterval(checkLoginInterval)
        return
      }

      try {
        const cookies = await qqLoginWindow.webContents.session.cookies.get({ 
          domain: '.qq.com' 
        })

        // 检查关键 Cookie 是否存在
        const hasUserId = cookies.some(cookie =>
          cookie.name === 'uin' || cookie.name === 'wxuin'
        )
        const hasMusicKey = cookies.some(cookie =>
          cookie.name === 'qm_keyst' ||
          cookie.name === 'qqmusic_key'
        )
        const hasLogin = hasUserId && hasMusicKey

        if (hasLogin) {
        // 构建 Cookie 字符串
          const cookieString = cookies
            .map(cookie => `${cookie.name}=${cookie.value}`)
            .join('; ')

        console.log('✓ [QQ登录] 登录成功，获取到 Cookie')

          // 先完成 Promise，再关闭窗口，避免 closed 事件误报为取消。
          clearInterval(checkLoginInterval)
          finish({ success: true, cookie: cookieString })
          qqLoginWindow.close()
        }
      } catch (err) {
        console.error('❌ [QQ登录] 检查登录状态失败:', err)
      }
    }, 2000) // 每2秒检查一次

    qqLoginWindow.on('closed', () => {
      clearInterval(checkLoginInterval)
      qqLoginWindow = null
      finish({ success: false, error: '用户取消登录' })
    })
    })().catch(error => {
      console.error('[QQ Login] failed to initialize login window:', error)
      if (qqLoginWindow && !qqLoginWindow.isDestroyed()) qqLoginWindow.destroy()
      qqLoginWindow = null
      qqLoginWindowOpening = false
      finish({ success: false, error: error?.message || 'QQ login window initialization failed' })
    })
  })
}

// ── 酷狗音乐登录窗口（Electron 弹窗，登录后抓 kg_token cookie）──────────────
let kugouLoginWindow = null
async function createKugouLoginWindow() {
  return new Promise((resolve) => {
    if (kugouLoginWindow) {
      kugouLoginWindow.focus()
      resolve({ success: false, error: '酷狗音乐登录窗口已打开' })
      return
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    void (async () => {
      try {
        // 注意：不清除 kugou.com 域 Cookie —— 若用户已登录（KuGoo 会话），窗口直接显示已登录态
        const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
        kugouLoginWindow = new BrowserWindow({
          width: 1000,
          height: 700,
          parent: mainWindow,
          modal: true,
          frame: false,
          backgroundColor: '#1a1a1a',
          titleBarStyle: 'hidden',
          title: 'WaveForge 澜音工坊 - 酷狗音乐登录',
          icon: fs.existsSync(iconPath) ? iconPath : undefined,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: mainWindow.webContents.session,
          },
        })
        // 伪装为普通 Chrome（酷狗登录页对 Electron UA 偶发拦截）
        kugouLoginWindow.webContents.setUserAgent(REAL_CHROME_UA)

        // 每次打开清掉 kugou.com 域 Cookie：从干净会话开始，便于登录其他账号
        // （localStorage 中的 kugou_cookie 在登录成功前保持不变，成功后由新会话覆盖）
        const kugouSession = kugouLoginWindow.webContents.session
        try {
          const cookies = await kugouSession.cookies.get({ domain: '.kugou.com' })
          await Promise.all(cookies.map(c => removeSessionCookie(kugouSession, c)))
          console.log('🧹 [酷狗] 已清理 kugou.com 域 Cookie，从干净会话开始登录')
        } catch { /* 清理失败不阻塞 */ }

        // 导航守卫：只放行 kugou.com 域（登录/认证跳转），外链交系统浏览器
        const isKugouDomain = (url) => {
          try {
            const hostname = new URL(String(url || '')).hostname.toLowerCase()
            return hostname === 'kugou.com' || hostname.endsWith('.kugou.com')
          } catch {
            return false
          }
        }
        kugouLoginWindow.webContents.on('will-navigate', (event, url) => {
          if (!isKugouDomain(url)) {
            event.preventDefault()
            if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {})
          }
        })
        kugouLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {})
          return { action: 'deny' }
        })

        // 加载酷狗登录页（网页版登录：扫码或手机号）
        kugouLoginWindow.loadURL('https://www.kugou.com/')

        // 注入关闭按钮
        kugouLoginWindow.webContents.on('did-finish-load', () => {
          kugouLoginWindow.webContents.executeJavaScript(`
            (function() {
              if (document.getElementById('waveforge-close-btn')) return;
              const closeBtn = document.createElement('div');
              closeBtn.id = 'waveforge-close-btn';
              closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
              closeBtn.style.cssText = 'position:fixed;top:12px;right:12px;width:32px;height:32px;background:rgba(0,0,0,0.55);backdrop-filter:blur(8px);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;color:#fff;';
              closeBtn.addEventListener('click', () => window.close());
              document.body.appendChild(closeBtn);
            })();
          `).catch(() => {})
        })

        // 每 2 秒检查登录态：kg_token Cookie 或 用户信息探测命中 → 登录成功
        // （kg_mid/dfid/ACK_SERVER 等是游客设备 Cookie，不能作为登录依据）
        const USER_INFO_SCRIPT = `(async () => {
          const tryFetch = async (url) => {
            try {
              const r = await fetch(url, { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
              if (!r.ok) return null;
              const t = await r.text();
              try { return JSON.parse(t); } catch { return t; }
            } catch { return null; }
          };
          // 1. 酷狗网页用户接口（登录态下返回昵称/头像）
          const info = await tryFetch('https://www.kugou.com/yy/index.php?r=user/getinfo');
          if (info && (info.data || info.user_info || info.user)) {
            const d = info.data || info.user_info || info.user || {};
            const name = d.nickname || d.user_name || d.userName || d.name || '';
            const id = d.user_id || d.userid || d.id || '';
            const av = d.avatar || d.head_img || d.headimg || d.user_pic || '';
            if (name || id) return JSON.stringify({ name, id, avatar: av });
          }
          // 2. 页面 DOM 抓取顶部用户昵称/头像
          const nameEl = document.querySelector('.user-info .name, .login-info .user-name, .user-name, [class*="user"] [class*="name"], [class*="userInfo"]');
          const avEl = document.querySelector('.user-info img, .login-info img, [class*="avatar"] img, img[class*="head"]');
          return JSON.stringify({
            name: nameEl ? (nameEl.textContent || '').trim() : '',
            id: '',
            avatar: avEl ? (avEl.src || '') : ''
          });
        })()`
        // 带超时的 executeJavaScript（防止页面挂起导致登录流程卡死）
        const probeUserInfo = async () => {
          if (!kugouLoginWindow || kugouLoginWindow.isDestroyed()) return ''
          const raw = await Promise.race([
            kugouLoginWindow.webContents.executeJavaScript(USER_INFO_SCRIPT).catch(() => ''),
            new Promise(resolve => setTimeout(() => resolve(''), 8000)),
          ])
          return raw || ''
        }
        const checkLoginInterval = setInterval(async () => {
          if (!kugouLoginWindow || kugouLoginWindow.isDestroyed()) {
            clearInterval(checkLoginInterval)
            return
          }
          try {
            const cookies = await kugouLoginWindow.webContents.session.cookies.get({ domain: '.kugou.com' })
            // 登录凭据：KuGoo（网页登录会话，内含 KugooID/NickName/Pic）或 kg_token（客户端令牌）
            const kuGooCookie = cookies.find(c => c.name === 'KuGoo' && /KugooID=/.test(c.value || ''))
            const kgToken = cookies.find(c => c.name === 'kg_token')
            // 从 KuGoo 值直接解析用户信息（%uXXXX 为 UTF-16 编码）
            const decodeUnicode = (str) => {
              try { return decodeURIComponent(str.replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))) } catch { return str }
            }
            let parsed = { name: '', id: '', avatar: '' }
            if (kuGooCookie?.value) {
              const kv = new URLSearchParams(String(kuGooCookie.value))
              parsed = {
                name: decodeUnicode(kv.get('NickName') || kv.get('UserName') || ''),
                id: kv.get('KugooID') || '',
                avatar: decodeUnicode(kv.get('Pic') || ''),
              }
            }
            if (kuGooCookie || (kgToken && kgToken.value)) {
              const cookieString = cookies
                .map(c => `${c.name}=${c.value}`)
                .join('; ')
              console.log(`✓ [酷狗登录] 登录成功（${kuGooCookie ? 'KuGoo 会话' : 'kg_token'}），Cookie 已捕获`)
              clearInterval(checkLoginInterval)
              finish({
                success: true,
                cookie: cookieString,
                username: parsed.name || '',
                userId: parsed.id || '',
                avatar: parsed.avatar || '',
              })
              kugouLoginWindow.close()
            } else {
              // 兜底：探测用户信息（真实登录时页面/接口返回昵称或 ID）
              const userInfoRaw = await probeUserInfo()
              let probeParsed = {}
              try { probeParsed = JSON.parse(userInfoRaw || '{}') } catch { probeParsed = {} }
              if (probeParsed.name || probeParsed.id) {
                const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ')
                console.log('✓ [酷狗登录] 登录成功（用户信息探测命中）')
                clearInterval(checkLoginInterval)
                finish({
                  success: true,
                  cookie: cookieString,
                  username: probeParsed.name || '',
                  userId: probeParsed.id || '',
                  avatar: probeParsed.avatar || '',
                })
                kugouLoginWindow.close()
              }
            }
          } catch (err) {
            console.error('❌ [酷狗登录] 检查登录状态失败:', err)
          }
        }, 2000)

        kugouLoginWindow.on('closed', () => {
          clearInterval(checkLoginInterval)
          kugouLoginWindow = null
          finish({ success: false, error: '用户取消登录' })
        })
      } catch (error) {
        console.error('[酷狗登录] 初始化登录窗口失败:', error)
        if (kugouLoginWindow && !kugouLoginWindow.isDestroyed()) kugouLoginWindow.destroy()
        kugouLoginWindow = null
        finish({ success: false, error: error?.message || '酷狗音乐登录窗口初始化失败' })
      }
    })()
  })
}

ipcMain.handle('open-kugou-login-window', async () => {
  try {
    const result = await createKugouLoginWindow()
    // 登录成功后把扩展用户信息（用户名/ID/头像）通知渲染进程持久化
    if (result?.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('kugou-auth-result', result)
    }
    return result
  } catch (err) {
    console.error('❌[酷狗登录] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// 退出登录时清除共享 session 的 kugou.com Cookie（防止登录弹窗带出旧账号，无法换号登录）
ipcMain.handle('kugou-clear-session', async () => {
  try {
    const ses = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.session : null
    if (!ses) return { success: false }
    const cookies = await ses.cookies.get({ domain: '.kugou.com' })
    await Promise.all(cookies.map(c => removeSessionCookie(ses, c)))
    console.log('🧹 [酷狗] 已清除会话 Cookie（退出登录）')
    return { success: true }
  } catch (error) {
    console.error('❌[酷狗] 清除会话 Cookie 失败:', error)
    return { success: false }
  }
})

// 读取当前会话的酷狗登录态（应用启动时自动恢复已登录状态）
ipcMain.handle('get-kugou-session', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false, loggedIn: false }
    const cookies = await mainWindow.webContents.session.cookies.get({ domain: '.kugou.com' })
    const kuGooCookie = cookies.find(c => c.name === 'KuGoo' && /KugooID=/.test(c.value || ''))
    if (!kuGooCookie?.value) return { success: true, loggedIn: false }
    const decodeUnicode = (str) => {
      try { return decodeURIComponent(str.replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))) } catch { return str }
    }
    const kv = new URLSearchParams(String(kuGooCookie.value))
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    return {
      success: true,
      loggedIn: true,
      cookie: cookieString,
      username: decodeUnicode(kv.get('NickName') || kv.get('UserName') || ''),
      userId: kv.get('KugooID') || '',
      avatar: decodeUnicode(kv.get('Pic') || ''),
    }
  } catch (err) {
    console.error('❌[酷狗登录] 读取会话失败:', err)
    return { success: false, loggedIn: false }
  }
})

// ── Spotify OAuth 授权（Electron 弹窗，授权码流）──────────────────────────
// 用公开的 Spotify Client ID（WaveForge 桌面应用）走 OAuth 授权码流程：
// 弹窗打开 accounts.spotify.com/authorize → 用户登录授权 → 重定向到本地回调端口
// → 主进程监听回调换 access/refresh token → 存 localStorage 并通知渲染进程。
// 未配置自有 Client Secret 时采用 PKCE 或本地换 token 端点（见实现）。
let spotifyLoginWindow = null
let spotifyCallbackServer = null

// Spotify OAuth 客户端 ID：默认采用 Spotify 官方为 spotifyd 开源项目注册的公开 Client ID
// （社区广泛复用）。共享 ID 可能被 Spotify 风控（authorize 返回 server_error），
// 渲染进程可在设置里配置自己的 Client ID（dashboard.spotify.com 免费注册，redirect URI 填 8000/login）。
const SPOTIFY_DEFAULT_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd'

async function createSpotifyLoginWindow(clientId) {
  const SPOTIFY_CLIENT_ID = clientId && /^[0-9a-f]{32}$/i.test(String(clientId).trim())
    ? String(clientId).trim()
    : SPOTIFY_DEFAULT_CLIENT_ID
  return new Promise((resolve) => {
    if (spotifyLoginWindow) {
      spotifyLoginWindow.focus()
      resolve({ success: false, error: 'Spotify 授权窗口已打开' })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try { if (spotifyCallbackServer) { spotifyCallbackServer.close(); spotifyCallbackServer = null } } catch {}
      // 成功/失败收尾都关窗：modal 挂在主窗上，不关会一直挡住主窗（对齐 QQ/酷狗/Apple 行为）。
      // closed 处理器有 settled 防重，不会把这次主动 close 误报成"用户取消授权"
      try { if (spotifyLoginWindow && !spotifyLoginWindow.isDestroyed()) spotifyLoginWindow.close() } catch {}
      resolve(result)
    }
    const http = require('http')
    // spotifyd 公开 client_id 在 Spotify Dashboard 注册的 redirect_uri 固定为
    // http://127.0.0.1:8000/login（oauth_port 默认 8000、路径 /login，见 spotifyd 源码）。
    // 之前用 47320/callback 与注册值不匹配 → 授权页报 "redirect_uri: Not matching configuration"。
    const redirectPort = 8000
    const redirectUri = `http://127.0.0.1:${redirectPort}/login`

    // 本地回调服务器：接收授权码 → 换 token
    spotifyCallbackServer = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1:${redirectPort}`)
        if (url.pathname === '/login') {
          const code = url.searchParams.get('code')
          const error = url.searchParams.get('error')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          if (!code) {
            res.end('<html><body style="background:#111;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">授权已取消，可以关闭此窗口。</body></html>')
            finish({ success: false, error: error || '授权取消' })
            return
          }
          // 换 token（Spotify 官方 token 端点，POST 不需要 CORS）
          const tokenResp = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code,
              redirect_uri: redirectUri,
              client_id: SPOTIFY_CLIENT_ID,
            }),
          })
          const tokenData = await tokenResp.json()
          if (!tokenData.access_token) {
            res.end('<html><body style="background:#111;color:#f66;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">Token 获取失败，请重试。</body></html>')
            finish({ success: false, error: tokenData.error_description || 'Token 获取失败' })
            return
          }
          // 拉取用户信息
          const userResp = await fetch('https://api.spotify.com/v1/me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          })
          let username = ''
          let avatar = ''
          let userId = ''
          if (userResp.ok) {
            const me = await userResp.json()
            username = me.display_name || me.id || ''
            userId = me.id || ''
            avatar = me.images?.[0]?.url || ''
          }
          // 持久化（通过主窗口 webContents 写 localStorage 或返回给渲染进程）
          const result = {
            success: true,
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token || '',
            expiresIn: tokenData.expires_in || 3600,
            username,
            avatar,
            userId,
          }
          res.end('<html><body style="background:#111;color:#1DB954;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:18px;">✓ 授权成功，可以关闭此窗口。</body></html>')
          finish(result)
        } else {
          res.writeHead(404)
          res.end('Not Found')
        }
      } catch (e) {
        console.error('❌ [Spotify] 回调处理失败:', e)
        finish({ success: false, error: e.message })
      }
    })
    spotifyCallbackServer.on('error', (err) => {
      console.error('❌ [Spotify] 回调端口监听失败:', err && err.message)
      finish({ success: false, error: err && err.code === 'EADDRINUSE'
        ? `端口 ${redirectPort} 被占用，请关闭占用该端口的程序后重试（Spotify 授权需要 ${redirectPort} 端口做本地回调）`
        : `Spotify 授权回调启动失败：${err && err.message || err}` })
    })
    spotifyCallbackServer.listen(redirectPort, '127.0.0.1', () => {
      // 每次打开清掉 Spotify 域 Cookie：从干净会话开始，便于登录其他账号
      const spotifySession = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.session : null
      const clearSpotifyCookies = async () => {
        if (!spotifySession) return
        try {
          const domains = ['accounts.spotify.com', '.spotify.com', '.open.spotify.com']
          for (const domain of domains) {
            const cookies = await spotifySession.cookies.get({ domain })
            await Promise.all(cookies.map(c => removeSessionCookie(spotifySession, c)))
          }
          console.log('🧹 [Spotify] 已清理 Spotify 域 Cookie，从干净会话开始授权')
        } catch { /* 清理失败不阻塞 */ }
      }
      const scope = 'user-read-private user-read-email playlist-read-private playlist-modify-private playlist-modify-public user-library-read user-library-modify user-top-read'
      const authUrl = `https://accounts.spotify.com/authorize?client_id=${SPOTIFY_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`
      void clearSpotifyCookies().then(() => {
        if (settled) return
        spotifyLoginWindow = new BrowserWindow({
          width: 720,
          height: 620,
          parent: mainWindow,
          modal: true,
          frame: false,
          backgroundColor: '#191414',
          title: 'WaveForge 澜音工坊 - Spotify 授权',
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            session: mainWindow.webContents.session,
          },
        })
        // Spotify 对 Electron UA 会在授权页报错（页面显示 something wrong），伪装为普通 Chrome
        spotifyLoginWindow.webContents.setUserAgent(REAL_CHROME_UA)
        // 导航守卫 + window.open 拦截：与 QQ/酷狗/Apple 登录窗对齐。该窗共享主 session，
        // 无守卫时页面可把共享 Cookie 的窗口导航到任意域，window.open 会产生无引用、
        // 不受控的原生窗口（"弹出的窗口无法关闭"的一类来源）。注意：Spotify 登录页的
        // Google/Facebook 等第三方登录按钮会被拦截（外开系统浏览器），邮箱登录不受影响
        spotifyLoginWindow.webContents.on('will-navigate', (event, url) => {
          if (/^https:\/\/([a-z0-9-]+\.)*(spotify\.com|scdn\.co)\//i.test(String(url || ''))) return
          event.preventDefault()
          if (/^https?:\/\//i.test(String(url || ''))) {
            shell.openExternal(String(url)).catch(() => {})
          }
        })
        spotifyLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//i.test(String(url || ''))) {
            shell.openExternal(String(url)).catch(() => {})
          }
          return { action: 'deny' }
        })
        spotifyLoginWindow.loadURL(authUrl)
      // 注入关闭按钮
      spotifyLoginWindow.webContents.on('did-finish-load', () => {
        spotifyLoginWindow.webContents.executeJavaScript(`
          (function() {
            if (document.getElementById('waveforge-close-btn')) return;
            const b = document.createElement('div');
            b.id = 'waveforge-close-btn';
            b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            b.style.cssText = 'position:fixed;top:12px;right:12px;width:32px;height:32px;background:rgba(0,0,0,0.55);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;color:#fff;';
            b.addEventListener('click', () => window.close());
            document.body.appendChild(b);
          })();
        `).catch(() => {})
      })
      spotifyLoginWindow.on('closed', () => {
        spotifyLoginWindow = null
        finish({ success: false, error: '用户取消授权' })
      })
      })
    })
    // 超时保护
    setTimeout(() => finish({ success: false, error: '授权超时' }), 5 * 60 * 1000).unref?.()
  })
}

ipcMain.handle('open-spotify-login', async (_event, clientId) => {
  try {
    const result = await createSpotifyLoginWindow(clientId)
    // 成功后将 token 写入渲染进程 localStorage（通过事件交给前端）
    if (result?.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('spotify-auth-result', result)
    }
    return { success: Boolean(result?.success), username: result?.username, error: result?.error }
  } catch (err) {
    console.error('❌[Spotify] 授权失败:', err)
    return { success: false, error: err.message }
  }
})

// ── 汽水音乐登录：汽水自有 Passport 二维码流程（移植自 Mineradio qishui-auth-v6，GPL-3.0-only）──
// 生成二维码 → 轮询 check_qrconnect → 确认后捕获 .qishui.com 会话 Cookie + 用户资料。
// 旧方案（sso.douyin.com 抖音 SSO）抓到的是 .douyin.com Cookie，luna Web API 一律 403，已废弃。
let sodaLoginWindow = null

function sodaLoginPageHtml(qrDataUrl) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>汽水音乐扫码登录</title>' +
    '<style>' +
    'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#111318;font-family:"Microsoft YaHei",system-ui,sans-serif;color:#fff}' +
    '.card{width:340px;text-align:center;padding:32px 28px;border-radius:20px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08)}' +
    'h2{margin:0 0 6px;font-size:20px}' +
    '.sub{margin:0 0 18px;font-size:12px;color:rgba(255,255,255,.45)}' +
    '.qrbox{position:relative;width:280px;height:280px;margin:0 auto 18px;background:#fff;border-radius:14px;padding:10px;box-sizing:border-box}' +
    'img{width:100%;height:100%;display:block}' +
    '#status{font-size:14px;color:rgba(255,255,255,.75);min-height:20px;margin:0 0 14px}' +
    '.tip{font-size:11px;color:rgba(255,255,255,.3);line-height:1.7}' +
    '</style></head><body><div class="card">' +
    '<h2>汽水音乐扫码登录</h2><p class="sub">WaveForge · 澜音工坊</p>' +
    '<div class="qrbox"><img id="waveforge-qr" src="' + qrDataUrl + '" alt="二维码"></div>' +
    '<p id="status">请打开「汽水音乐」App 扫描二维码</p>' +
    '<p class="tip">扫码登录即代表同意汽水音乐用户协议<br>本窗口由 WaveForge 本地渲染，凭据仅保存在本机</p>' +
    '</div>' +
    '<script>(function(){var b=document.createElement("div");b.innerHTML="✕";b.style.cssText="position:fixed;top:12px;right:14px;width:30px;height:30px;line-height:30px;text-align:center;background:rgba(255,255,255,.1);border-radius:50%;cursor:pointer;z-index:2147483647;color:#fff;font-size:14px";b.addEventListener("click",function(){window.close()});document.body.appendChild(b)})();' +
    'window.__wfSetStatus=function(s){var e=document.getElementById("status");if(e)e.textContent=s};' +
    'window.__wfSetQr=function(src){var e=document.getElementById("waveforge-qr");if(e)e.src=src};' +
    '</script></body></html>'
}

async function createSodaLoginWindow() {
  return new Promise((resolve) => {
    if (sodaLoginWindow && !sodaLoginWindow.isDestroyed()) {
      sodaLoginWindow.focus()
      resolve({ success: false, error: '汽水音乐登录窗口已打开' })
      return
    }
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      if (sodaLoginWindow && !sodaLoginWindow.isDestroyed()) sodaLoginWindow.close()
      resolve(result)
    }
    void (async () => {
      try {
        const auth = require('./qishui-auth-v6.cjs')
        // 凭据/设备指纹持久化到 userData（deviceId 稳定可降低风控概率；cookie 登录后写入）
        const configFile = path.join(app.getPath('userData'), 'soda-qr-login.json')
        const readCfg = () => { try { return JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch { return {} } }
        const writeCfg = (patch) => {
          try { fs.writeFileSync(configFile, JSON.stringify({ ...readCfg(), ...(patch || {}) }, null, 2), 'utf8') } catch {}
        }
        auth.configure({
          getConfig: () => ({
            deviceId: '', installId: '', verifyPortraitId: '',
            computerName: os.hostname() || 'Windows-PC', cookie: '', msToken: '',
            ...readCfg(),
          }),
          updateConfig: (patch) => writeCfg(patch),
        })
        // 每次打开登录窗都重置凭据文件中的会话字段（保留 deviceId/msToken 设备指纹）：
        // 1) 防止历史/测试残留会话被成功判定误读为"秒登录"；2) 换账号从干净会话开始
        writeCfg({ cookie: '' })

        let qrWindow = new BrowserWindow({
          width: 420,
          height: 600,
          parent: mainWindow,
          modal: true,
          frame: false,
          resizable: false,
          backgroundColor: '#111318',
          title: 'WaveForge 澜音工坊 - 汽水音乐登录',
          icon: path.join(__dirname, '..', 'build', 'icon.ico'),
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        })
        qrWindow.setMenuBarVisibility(false)
        sodaLoginWindow = qrWindow

        const setStatus = (text) => {
          try { if (qrWindow && !qrWindow.isDestroyed()) void qrWindow.webContents.executeJavaScript('window.__wfSetStatus && window.__wfSetStatus(' + JSON.stringify(text) + ')') } catch {}
        }

        // 生成并刷新二维码（过期自动重取，最多 4 次）
        let qrToken = ''
        let expiredCount = 0
        const buildQr = async () => {
          const qr = await auth.getQrCode()
          const data = qr.data || {}
          qrToken = String(data.token || '')
          if (!qrToken || !data.qrcode) throw new Error('二维码生成数据不完整')
          if (qrWindow && !qrWindow.isDestroyed()) {
            await qrWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(sodaLoginPageHtml(String(data.qrcode))))
          }
        }

        await buildQr()

        // 轮询扫码状态；check_qrconnect 可能因二次验证(MFA)长时间阻塞——用 inFlight 防止调用堆积。
        // 成功判定以「凭据文件里的 .qishui 会话 Cookie」为准：无论返回包形状如何、
        // 甚至轮询中途抛错（MFA 完成后偶发响应异常），只要会话已落盘即视为登录成功。
        let pollTimer = null
        let inFlight = false
        let consecutiveErrors = 0
        const hasRealSession = (cfg) => {
          // 不用正则避免转义歧义：按分号拆 Cookie，看是否存在任一会话键
          const names = String((cfg && cfg.cookie) || '').split(';').map(part => part.trim().split('=')[0].toLowerCase())
          return names.includes('sessionid') || names.includes('sessionid_ss') || names.includes('sid_guard') || names.includes('sid_tt')
        }
        // 登录闭环立即完成，不做任何网络等待：昵称/头像/ID 由渲染层自愈逻辑
        // （handleSodaLogin 缺字段时经 /api/soda/status 补齐）异步获取。
        // 此前在这里同步等资料接口，接口一旦迟滞会把整个登录流程卡死在窗口不关。
        const completeLogin = (cookie) => {
          if (settled) return
          if (pollTimer) clearInterval(pollTimer)
          console.log('[SodaLogin] 会话已建立，完成登录闭环')
          // 注意：settled 由 finish 内部置位；这里若提前置位会让 finish 的防重护栏短路
          finish({ success: true, cookie, username: '', avatar: '', userId: '' })
        }
        pollTimer = setInterval(async () => {
          if (!qrWindow || qrWindow.isDestroyed() || settled) { clearInterval(pollTimer); return }
          if (inFlight) { console.log('[SodaLogin][tick] 跳过：上一次检查仍在进行'); return }
          inFlight = true
          try {
            // 先看凭据文件：MFA/二次验证流程可能在任意时刻把会话写进来
            const cfgSnapshot = readCfg()
            console.log('[SodaLogin][tick] cookie字段=', String(cfgSnapshot.cookie || '').slice(0, 60))
            if (hasRealSession(cfgSnapshot)) { console.log('[SodaLogin][tick] 检测到有效会话 → 完成登录'); completeLogin(String(cfgSnapshot.cookie || '')); return }
            const envelope = await auth.checkQrConnect(qrToken)
            consecutiveErrors = 0
            const d = envelope.data || {}
            const errorCode = Number(d.error_code)
            // 返回包确认 → 再核对一次落盘 Cookie（persistSessionCookies 在 check 内部已完成）
            const cfgAfter = readCfg()
            if ((errorCode === 0 && (String(d.status) === '3' || d.session_cookie)) || hasRealSession(cfgAfter)) {
              completeLogin(String(cfgAfter.cookie || ''))
              return
            }
            if (errorCode === 2) {
              // 二维码已过期：自动刷新
              expiredCount += 1
              if (expiredCount > 4) {
                clearInterval(pollTimer)
                finish({ success: false, error: '二维码已多次过期，请重新打开登录' })
                return
              }
              setStatus('二维码已过期，正在刷新…')
              await buildQr()
              setStatus('请使用「汽水音乐」App 扫描新二维码')
              return
            }
            if (errorCode === 7) {
              clearInterval(pollTimer)
              finish({ success: false, error: '请求过于频繁，请一分钟后再试' })
              return
            }
            if (String(d.status) === '2') setStatus('已扫码 ✓ 请在手机上确认登录')
          } catch (err) {
            console.error('[SodaLogin][tick] check异常:', err && err.message)
            // 异常路径同样先查落盘 Cookie：MFA 通过后的收尾请求偶发失败不影响会话有效性
            const cfgErr = readCfg()
            if (hasRealSession(cfgErr)) { completeLogin(String(cfgErr.cookie || '')); return }
            if (err && err.code === 'QISHUI_MFA_CANCELLED') {
              clearInterval(pollTimer)
              finish({ success: false, error: err.message || '安全验证已取消' })
              return
            }
            consecutiveErrors += 1
            if (consecutiveErrors >= 8) {
              clearInterval(pollTimer)
              finish({ success: false, error: (err && err.message) || '登录状态检查连续失败' })
            } else {
              setStatus(consecutiveErrors >= 2 ? '安全验证处理中/网络波动，正在重试… (' + consecutiveErrors + '/8)' : '正在检查扫码状态…')
            }
          } finally {
            inFlight = false
          }
        }, 2000)

        qrWindow.on('closed', () => {
          if (pollTimer) clearInterval(pollTimer)
          sodaLoginWindow = null
          // 手动关闭窗口 ≠ 一定失败：若扫码+验证码已完成、会话已落盘，按登录成功收尾
          const cfgOnClose = readCfg()
          if (hasRealSession(cfgOnClose)) {
            console.log('[SodaLogin] 窗口关闭时会话有效，按成功收尾')
            finish({ success: true, cookie: String(cfgOnClose.cookie || ''), username: '', avatar: '', userId: '' })
            return
          }
          finish({ success: false, error: '用户取消登录' })
        })
      } catch (error) {
        console.error('[汽水音乐] 初始化登录窗口失败:', error)
        if (sodaLoginWindow && !sodaLoginWindow.isDestroyed()) sodaLoginWindow.destroy()
        sodaLoginWindow = null
        finish({ success: false, error: (error && error.message) || '汽水音乐登录初始化失败' })
      }
    })()
  })
}
ipcMain.handle('open-soda-login', async () => {
  try {
    const result = await createSodaLoginWindow()
    // 登录成功后把用户名/头像通知渲染进程持久化
    if (result?.success && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('soda-auth-result', result)
    }
    return result
  } catch (err) {
    console.error('❌[汽水音乐] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// 汽水退出登录清理：关登录窗 → 清 persist:mineradio-qishui-auth-v6 分区的 .qishui.com
// Cookie/localStorage（复用 qishui-auth-v6 的 clear）→ 清凭据文件 soda-qr-login.json 的会话字段。
// 凭据文件保留 deviceId/installId 等设备指纹（稳定可降低风控概率），只清 cookie/msToken，
// 与打开登录窗前的重置逻辑（writeCfg({ cookie: '' })）对齐。运行时未初始化时 clear()
// 会直接按分区名清存储，覆盖「应用重启后 runtime 为空」的场景。
ipcMain.handle('soda-clear-login', async () => {
  try {
    // 顺序关键：先清凭据文件会话字段，再销毁扫码窗——qrWindow 的 closed 处理器会
    // readCfg() 判断会话是否有效，若先 destroy 会把"刚要被清掉的旧 cookie"误判为登录成功，
    // 挂起的 open-soda-login 以 success+旧 cookie resolve，渲染层把已清除的登录态落盘
    const configFile = path.join(app.getPath('userData'), 'soda-qr-login.json')
    try {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'))
      if (cfg && typeof cfg === 'object') {
        delete cfg.cookie
        delete cfg.msToken
        fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8')
      }
    } catch { /* 文件不存在/损坏：无残留凭据可清，忽略 */ }
    if (sodaLoginWindow && !sodaLoginWindow.isDestroyed()) {
      try { sodaLoginWindow.destroy() } catch {}
      sodaLoginWindow = null
    }
    const auth = require('./qishui-auth-v6.cjs')
    await auth.clear()
    console.log('🧹 [汽水音乐] 已清除登录分区与凭据文件会话字段（退出登录）')
    return { success: true }
  } catch (err) {
    console.error('❌[汽水音乐] 清除登录态失败:', err)
    return { success: false, error: (err && err.message) || String(err) }
  }
})

// HSE 开发者模式：把调音室导出的「发布种子」写回仓库源文件 builtinSceneSeed.ts。
// 仅开发模式可用（打包版没有 src 源码树，app.isPackaged 直接拒绝），
// 内容必须带种子赋值语句标记且限长，防止变成任意文件写入通道。
ipcMain.handle('hse-write-scene-seed', async (_e, content) => {
  try {
    if (app.isPackaged) return { ok: false, error: '仅开发模式可写回仓库' }
    if (typeof content !== 'string' || !content.includes('export const BUILTIN_SCENE_SEED') || content.length > 2 * 1024 * 1024) {
      return { ok: false, error: '内容不符合种子文件格式' }
    }
    const target = path.join(app.getAppPath(), 'src', 'services', 'waveforge-engine-v3', 'src', 'engine', 'builtinSceneSeed.ts')
    if (!fs.existsSync(target)) return { ok: false, error: '仓库中不存在 builtinSceneSeed.ts（仅开发环境可用）' }
    const tmp = target + '.tmp'
    fs.writeFileSync(tmp, content, 'utf8')
    fs.renameSync(tmp, target)
    console.log('✍️ [HSE] 发布种子已写回:', target)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
})

// HSE 离线导出落盘：把调音室渲染好的 MP3 直写到用户桌面。
// 文件名由渲染层给（<歌曲名>-Modified.mp3），这里再做一次非法字符兜底清洗与
// 重名自动 (2) 序号，绝不覆盖用户已存在的文件。300MB 上限防误传巨型数据。
ipcMain.handle('hse-save-rendered-audio', (_e, data, fileName) => {
  try {
    const buf = Buffer.from(data)
    if (!buf.length) return { ok: false, error: '导出内容为空' }
    if (buf.length > 300 * 1024 * 1024) return { ok: false, error: '导出内容超过 300MB，疑似异常' }
    const safeName = String(fileName || '').replace(/[\\/:*?"<>|]/g, '_').trim()
      .replace(/^\.{1,2}$/, '_') || 'WaveForge-HSE-Modified.mp3'
    const dir = app.getPath('desktop')
    const ext = path.extname(safeName) || '.mp3'
    const stem = safeName.slice(0, safeName.length - ext.length)
    let target = path.join(dir, safeName)
    let n = 2
    while (fs.existsSync(target)) {
      target = path.join(dir, `${stem} (${n})${ext}`)
      n += 1
    }
    fs.writeFileSync(target, buf)
    console.log('🎵 [HSE] 渲染音频已保存:', target, `(${(buf.length / 1024 / 1024).toFixed(1)}MB)`)
    return { ok: true, path: target }
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) }
  }
})


// 监听打开 QQ 登录窗口的请求
ipcMain.handle('open-qq-login-window', async () => {
  try {
    const result = await createQQLoginWindow()
    return result
  } catch (err) {
    console.error('❌[QQ登录] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// 渲染进程日志桥：把前端（校验/登录流程）的诊断输出到主进程控制台（后台窗口可见）
ipcMain.on('app-log', (event, message) => {
  console.log('[渲染进程]', message)
})

// ── 汽水音乐（抖音）数据桥 ──────────────────────────────────────────
// 汽水音乐（api.qishui.com/luna）为 protobuf 签名接口，网页直连不可用；
// 抖音系接口又需要 a_bogus 签名。方案：隐藏窗口加载 www.douyin.com
// （与主应用共享 session，登录后带抖音会话），导航到抖音页面并由页面自身渲染，
// 再抓取渲染后的音乐卡片 —— 绕过签名，直接拿到真实抖音音乐数据。
let douyinBridgeWindow = null
let douyinBridgeReady = false
let douyinBridgeLoading = null

function ensureDouyinBridge() {
  if (douyinBridgeWindow && !douyinBridgeWindow.isDestroyed()) {
    if (douyinBridgeReady) return Promise.resolve(douyinBridgeWindow)
    return douyinBridgeLoading || Promise.resolve(douyinBridgeWindow)
  }
  douyinBridgeReady = false
  douyinBridgeWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: mainWindow ? mainWindow.webContents.session : undefined,
    },
  })
  // 隐藏数据桥同样伪装为普通 Chrome（抖音风控对 Electron UA 的抓取接口会限流）
  douyinBridgeWindow.webContents.setUserAgent(REAL_CHROME_UA)
  douyinBridgeWindow.setMenuBarVisibility(false)
  // 拦截 window.open：抖音站点弹窗会产生无引用、无守卫的游离原生窗口，桥窗不需要弹窗
  douyinBridgeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  douyinBridgeWindow.webContents.on('destroyed', () => {
    douyinBridgeReady = false
    douyinBridgeWindow = null
  })
  douyinBridgeWindow.webContents.on('did-finish-load', () => {
    douyinBridgeReady = true
  })
  const loadPromise = douyinBridgeWindow.loadURL('https://www.douyin.com/')
    .catch(error => console.error('❌ [汽水数据桥] 加载抖音失败:', error))
  douyinBridgeLoading = loadPromise.then(() => douyinBridgeWindow)
  return loadPromise.then(() => douyinBridgeWindow)
}

/** 在隐藏窗口内导航到抖音搜索页并抓取音乐卡片（需已登录抖音） */
async function scrapeDouyinMusic(keyword) {
  try {
    const win = await ensureDouyinBridge()
    const keywordEnc = encodeURIComponent(String(keyword || '热门'))
    await win.webContents.loadURL(`https://www.douyin.com/search/${keywordEnc}?type=music`).catch(() => {})
    // 等待页面渲染出结果（多次尝试）
    await new Promise(resolve => setTimeout(resolve, 6000))
    let attempts = 0
    let items = []
    while (attempts < 5 && items.length === 0) {
      items = await win.webContents.executeJavaScript(`
        (function () {
          const out = [];
          // 抖音搜索音乐卡片：链接包含 /music/ 的元素
          const seen = new Set();
          const candidates = document.querySelectorAll('a[href*="/music/"], [data-e2e*="music"]');
          candidates.forEach(function (el) {
            const link = el.closest('a') || el;
            const href = (link.getAttribute('href') || '');
            const m = href.match(/\\/music\\/([0-9]+)/);
            if (!m) return;
            const id = m[1];
            if (seen.has(id)) return;
            seen.add(id);
            // 音乐名/作者：从卡片内文本与 alt 提取
            let name = '';
            let author = '';
            let cover = '';
            const imgs = el.querySelectorAll('img');
            imgs.forEach(function (img) {
              const alt = (img.getAttribute('alt') || '').trim();
              if (alt && alt.length > 1 && alt.length < 40 && !name) name = alt;
              if (!cover && img.getAttribute('src')) cover = img.getAttribute('src');
            });
            const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (!name && text) {
              const parts = text.split(' ');
              name = parts[0] || '';
              author = parts.slice(1).join(' ').replace(/^[-·\\s]+/, '');
            }
            if (name || text) {
              out.push({ id: id, name: name || text.slice(0, 20), author: author || '', cover: cover || '', text: text.slice(0, 60) });
            }
          });
          return out.slice(0, 30);
        })()
      `).catch(() => [])
      if (items.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
      attempts += 1
    }
    return items
  } catch (error) {
    console.error('❌ [汽水数据桥] 抓取失败:', error)
    return []
  }
}

ipcMain.handle('soda-scrape-search', async (_event, keyword) => {
  if (typeof keyword !== 'string' || keyword.trim().length === 0) {
    return { success: false, error: '搜索关键词无效', items: [] }
  }
  try {
    const items = await scrapeDouyinMusic(keyword)
    return { success: true, items }
  } catch (err) {
    console.error('❌[汽水数据桥] 搜索失败:', err)
    return { success: false, error: err.message, items: [] }
  }
})

// ── 酷狗隐藏数据桥：www.kugou.com 对服务端 node fetch 有 TLS/行为指纹风控（返回 Access Deny），
//    用真实 Chromium 隐藏窗口（共享 mainWindow session，含 KuGoo 登录态）在页面内同源 fetch 用户接口。
let kugouBridgeWindow = null
let kugouBridgeReady = false
let kugouBridgeLoading = null

function ensureKugouBridge() {
  if (kugouBridgeWindow && !kugouBridgeWindow.isDestroyed()) {
    if (kugouBridgeReady) return Promise.resolve(kugouBridgeWindow)
    return kugouBridgeLoading || Promise.resolve(kugouBridgeWindow)
  }
  kugouBridgeReady = false
  kugouBridgeWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    show: false,
    backgroundColor: '#111111',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: mainWindow ? mainWindow.webContents.session : undefined,
    },
  })
  kugouBridgeWindow.webContents.setUserAgent(REAL_CHROME_UA)
  kugouBridgeWindow.setMenuBarVisibility(false)
  // 拦截 window.open：页面弹窗会产生无引用、无守卫的游离原生窗口，桥窗不需要弹窗
  kugouBridgeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  kugouBridgeWindow.webContents.on('destroyed', () => {
    kugouBridgeReady = false
    kugouBridgeWindow = null
  })
  kugouBridgeWindow.webContents.on('did-finish-load', () => {
    kugouBridgeReady = true
  })
  const loadPromise = kugouBridgeWindow.loadURL('https://www.kugou.com/')
    .catch(error => console.error('❌ [酷狗数据桥] 加载酷狗失败:', error))
  kugouBridgeLoading = loadPromise.then(() => kugouBridgeWindow)
  return loadPromise.then(() => kugouBridgeWindow)
}

/** 页面内同源 fetch 酷狗用户歌单（真实 Chromium 上下文，绕开服务端 WAF） */
async function scrapeKugouUserPlaylists() {
  const win = await ensureKugouBridge()
  // 首次加载等待页面就绪；之后页面已挂载，短暂等待确保会话 cookie 生效
  await new Promise(resolve => setTimeout(resolve, kugouBridgeReady ? 800 : 4000))
  const result = await win.webContents.executeJavaScript(`(async () => {
    const tryFetch = async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return null;
        const t = await r.text();
        try { return JSON.parse(t); } catch { return null; }
      } catch { return null; }
    };
    const pl = await tryFetch('https://www.kugou.com/yy/index.php?r=user/getplaylist&page=1&pagesize=100');
    const lists = (pl && (pl.data && pl.data.list)) || (pl && pl.data) || [];
    if (!Array.isArray(lists)) return '[]';
    return JSON.stringify(lists.map(function (item) {
      return {
        specialid: String(item.specialid || item.id || ''),
        name: String(item.specialname || item.name || ''),
        img: String(item.img || item.cover || ''),
        songcount: Number(item.songcount || 0),
        playcount: Number(item.playcount || 0),
      };
    }).filter(function (x) { return x.specialid && x.name; }));
  })()`)
  try { return JSON.parse(result || '[]') } catch { return [] }
}

/** 页面内同源 fetch 酷狗用户信息（昵称/头像/ID，绕开服务端 WAF） */
async function scrapeKugouUserInfo() {
  const win = await ensureKugouBridge()
  await new Promise(resolve => setTimeout(resolve, kugouBridgeReady ? 800 : 4000))
  const result = await win.webContents.executeJavaScript(`(async () => {
    const tryFetch = async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return null;
        const t = await r.text();
        try { return JSON.parse(t); } catch { return null; }
      } catch { return null; }
    };
    const info = await tryFetch('https://www.kugou.com/yy/index.php?r=user/getinfo');
    const d = (info && (info.data || info.user_info || info.user)) || {};
    return JSON.stringify({
      nickname: d.nickname || d.user_name || d.userName || d.name || '',
      user_id: d.user_id || d.userid || d.id || '',
      avatar: d.avatar || d.head_img || d.headimg || d.user_pic || '',
    });
  })()`)
  try { return JSON.parse(result || '{}') } catch { return {} }
}

ipcMain.handle('kugou-scrape-user-playlists', async () => {
  try {
    const playlists = await scrapeKugouUserPlaylists()
    return { success: true, playlists }
  } catch (err) {
    console.error('❌[酷狗数据桥] 用户歌单抓取失败:', err)
    return { success: false, error: err.message, playlists: [] }
  }
})

ipcMain.handle('kugou-scrape-user-info', async () => {
  try {
    const info = await scrapeKugouUserInfo()
    return { success: true, info }
  } catch (err) {
    console.error('❌[酷狗数据桥] 用户信息抓取失败:', err)
    return { success: false, error: err.message, info: null }
  }
})

// ── Apple Music amp-api 代理（Cider mkv3 同款思路）──────────────────────────
// 渲染进程浏览器直连 amp-api.music.apple.com 会被 CORS 拦截（Failed to fetch）。
// 改为渲染进程请求主进程 → 主进程 fetch（无 CORS）→ 返回 JSON。登录/资料库/目录全部走这里。
ipcMain.handle('apple-api', async (event, payload) => {
  const { path, method = 'GET', developerToken, mediaUserToken, body } = payload || {}
  if (!path || !developerToken) return { ok: false, status: 0, error: '缺少请求参数' }
  // 校验输入类型：path 必须是字符串且以 / 开头（防协议/内网跳转拼接），method 白名单
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    return { ok: false, status: 0, error: '非法路径' }
  }
  const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
  const safeMethod = ALLOWED_METHODS.has(String(method).toUpperCase()) ? String(method).toUpperCase() : 'GET'
  // 路径归一化：appleAuth 传 /me/...（无 /v1），appleCatalog 传 /v1/...，统一补成带 /v1 的完整路径
  const apiPath = path.startsWith('/v1') ? path : `/v1${path}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const headers = {
      Authorization: `Bearer ${developerToken}`,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      Accept: 'application/json',
    }
    if (mediaUserToken) headers['Media-User-Token'] = mediaUserToken
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json'
    const response = await fetch(`https://amp-api.music.apple.com${apiPath}`, {
      method: safeMethod,
      headers,
      body: body !== undefined && body !== null ? body : undefined,
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple Music 原生音源取流（Cider 同款：webPlayback 私有接口）──────────────
// POST play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback，
// body {"salableAdamId":"<catalogSongId>"}；响应 songList[0] 携带 songsId、
// HLS 主清单（attributes.assetUrl / offers[].hlsUrl）与 EME keyURLs
// （hls-key-cert-url / hls-key-server-url / widevine-cert-url）。
// 浏览器直连该接口同样受 CORS 限制，统一走主进程（请求头与 SDK 完全一致）。
const APPLE_MZPLAY_WEBPLAYBACK = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback'
ipcMain.handle('apple-playback', async (_event, payload) => {
  const { songId, developerToken, mediaUserToken } = payload || {}
  if (!songId || !developerToken || !mediaUserToken) {
    return { ok: false, status: 0, error: '缺少参数（songId/developerToken/mediaUserToken）' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const headers = {
      Authorization: `Bearer ${developerToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Apple-Music-User-Token': String(mediaUserToken),
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
    }
    const response = await fetch(APPLE_MZPLAY_WEBPLAYBACK, {
      method: 'POST',
      headers,
      body: JSON.stringify({ salableAdamId: String(songId) }),
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple HLS 清单代理：渲染层解析主清单需先拿到文本（Electron 源下直连会被
// CORS 拦），主进程 fetch 后回传。白名单限制在 Apple/苹果静态资源域。──────────
ipcMain.handle('apple-fetch-url', async (_event, payload) => {
  const { url } = payload || {}
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return { ok: false, error: '非法 URL' }
  let hostname = ''
  try {
    hostname = new URL(url).hostname
  } catch {
    return { ok: false, error: '非法 URL' }
  }
  if (!/^(apple|itunes\.apple|music\.apple)\.com$/i.test(hostname) && !/(^|\.)(apple\.com|itunes\.apple\.com|mzstatic\.com)$/i.test(hostname)) {
    return { ok: false, error: '域名不在白名单' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    return { ok: response.ok, status: response.status, text }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple Music 电台直播取流（Cider/MusicKit v3 同款）──────────────────────
// GET api.music.apple.com/v1/play/assets?<playParams>&keyFormat=web，响应
// results.assets[0] 携带 HLS 主清单 url 与 EME keyURLs（keyServerUrl /
// widevineKeyCertificateUrl / fairPlayKeyCertificateUrl）。api 宿主不可用时
// 回退 amp-api（gamdl 常量亦指向 amp-api；两宿主响应结构一致）。
const APPLE_PLAY_ASSETS_HOSTS = ['https://api.music.apple.com', 'https://amp-api.music.apple.com']
ipcMain.handle('apple-play-assets', async (_event, payload) => {
  const { query, developerToken, mediaUserToken } = payload || {}
  if (typeof query !== 'string' || !query || !developerToken || !mediaUserToken) {
    return { ok: false, status: 0, error: '缺少参数（query/developerToken/mediaUserToken）' }
  }
  // 校验查询串只含 URL 安全字符（防参数注入/拼接）
  if (!/^[A-Za-z0-9_=&%[\].,-]+$/.test(query)) {
    return { ok: false, status: 0, error: '非法查询参数' }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  const headers = {
    Authorization: `Bearer ${developerToken}`,
    Accept: 'application/json',
    'X-Apple-Music-User-Token': String(mediaUserToken),
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
  }
  try {
    for (const host of APPLE_PLAY_ASSETS_HOSTS) {
      try {
        const response = await fetch(`${host}/v1/play/assets?${query}`, { headers, signal: controller.signal })
        const text = await response.text()
        let data = null
        try {
          data = text ? JSON.parse(text) : null
        } catch {
          data = text
        }
        if (response.ok && Array.isArray(data?.results?.assets) && data.results.assets.length > 0) {
          return { ok: true, status: response.status, data }
        }
        if (response.ok && Array.isArray(data?.errors) && data.errors.length > 0) {
          return { ok: false, status: response.status, data, error: data.errors[0]?.title || '取流被拒' }
        }
      } catch { /* 换宿主重试 */ }
    }
    return { ok: false, status: 0, error: 'play/assets 取流失败（两个宿主均无有效响应）' }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple 账号信息（buy.itunes 账号接口，Cider 同款：凭登录窗口抓取的 itunes cookie）──
ipcMain.handle('apple-account-info', async (event, cookies) => {
  if (!cookies) return { ok: false, status: 0, error: '缺少账号 cookie' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const headers = {
      'User-Agent': APPLE_SAFARI_UA,
      Cookie: String(cookies),
      Accept: 'application/json',
    }
    // 从 cookie 串里补 Media-User-Token 请求头（buy.itunes 账号接口需要）
    const mediaTokenMatch = String(cookies).match(/(?:^|;\s*)media-user-token=([^;]+)/)
    if (mediaTokenMatch) headers['Media-User-Token'] = decodeURIComponent(mediaTokenMatch[1])
    const response = await fetch('https://buy.itunes.apple.com/account/web/info', {
      headers,
      signal: controller.signal,
    })
    const text = await response.text()
    let data = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    console.log(`[Apple账号] buy.itunes HTTP ${response.status}，响应长度 ${text.length}`)
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple 个人资料页（解析 og:image 头像，需主进程避免 CORS）──
ipcMain.handle('apple-fetch-profile', async (event, profileUrl) => {
  // 仅允许 https 的公开网页，防止传入 file:// 等本地路径被代理读取
  const safeUrl = typeof profileUrl === 'string' && /^https:\/\/[^/]/.test(profileUrl) ? profileUrl : 'https://music.apple.com/profile'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(safeUrl, {
      headers: { 'User-Agent': APPLE_SAFARI_UA, Accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal,
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, html: text }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple 账号页面（Apple ID / Apple Account，带全量会话 cookie 解析名字与头像）──
ipcMain.handle('apple-fetch-account', async (event, cookies) => {
  if (!cookies) return { ok: false, status: 0, error: '缺少账号 cookie' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    // 依次尝试 Apple 账号页面（新的 Apple Account 与旧版 Apple ID）
    const urls = [
      'https://account.apple.com/account/manage',
      'https://appleid.apple.com/account/manage',
    ]
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': APPLE_SAFARI_UA,
            Cookie: String(cookies),
            Accept: 'text/html,application/json',
          },
          redirect: 'follow',
          signal: controller.signal,
        })
        const text = await response.text()
        console.log(`[Apple账号] 资料页 ${url} HTTP ${response.status}，长度 ${text.length}`)
        // 登录后页面：200 且有一定内容即返回（SPA 壳可能偏小，放宽判定）
        if (response.ok && text.length > 500) {
          return { ok: true, status: response.status, html: text }
        }
      } catch (e) {
        console.log(`[Apple账号] 资料页 ${url} 请求失败：${e && e.message ? e.message : e}`)
        // 继续尝试下一个
      }
    }
    return { ok: false, status: 0, error: '未能访问 Apple 账号资料页' }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
})

// ── Apple Music 网页一键登录（内置窗口登录 Apple ID，自动抓取凭据）────────────────
// 用户无需自行获取 Developer Token / Media-User-Token：
//  - Media-User-Token：登录 music.apple.com 后从会话 Cookie 抓取（同 QQ 登录模式）
//  - Developer Token：拦截登录窗口发往 amp-api.music.apple.com 的 Authorization 请求头
const APPLE_LOGIN_PARTITION = 'waveforge-apple-login'
// 标准 Chrome/Windows UA（无 Electron 标记）。Safari UA 在 Windows 上可能触发
// Apple 页面的兼容性重定向，改用 Chrome 最稳。
const APPLE_SAFARI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// 登录窗口伪装为普通 Chrome（去掉 Electron 特征）：抖音/Spotify 等站点对 Electron UA
// 有风控/兼容问题（抖音：验证码「系统繁忙」、扫码「访问太频繁」；Spotify：登录后报错）。
const REAL_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'

/** 删除会话 cookie（Electron 的 cookies.remove 第一个参数必须是完整 URL，不能用 domain） */
function removeSessionCookie(ses, cookie) {
  const host = String(cookie && cookie.domain || '').replace(/^\./, '')
  if (!host || !ses || typeof ses.cookies.remove !== 'function') return Promise.resolve()
  return ses.cookies.remove(`https://${host}/`, cookie.name).catch(() => {})
}
let appleLoginWindow = null
// 捕获到的 Apple Developer Token（页面 fetch/XHR 补丁 + webRequest 拦截 + localStorage 扫描）
let appleDevTokenCapture = ''
// 本地加载动画页（先展示，避免 Apple 页面加载期间纯黑）
const APPLE_SPINNER_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
  'html,body{height:100%;margin:0;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}' +
  '.spinner{width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fa2d48;animation:spin .9s linear infinite}' +
  '@keyframes spin{to{transform:rotate(360deg)}}' +
  '</style></head><body><div class="spinner"></div><div style="opacity:.65">正在打开 Apple Music 登录…</div></body></html>'
)
let appleNavigateTimer = null
let appleOverlayTimer = null

// 预加载脚本上报 Developer Token（页面上下文补丁最可靠，Service Worker 也拦得住）
ipcMain.on('apple-login-token', (event, token) => {
  if (!token || appleDevTokenCapture) return
  if (appleLoginWindow && event.sender === appleLoginWindow.webContents) {
    appleDevTokenCapture = String(token).trim()
  }
})

function isAppleDomain(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase()
    return hostname === 'apple.com' || hostname.endsWith('.apple.com')
  } catch {
    return false
  }
}

// 登录窗口内允许的域：apple.com 全家 + iCloud（登录后静默提取昵称/头像用，SSO 自动登录无需用户操作）
function isAppleLoginAllowedDomain(url) {
  try {
    const hostname = new URL(String(url || '')).hostname.toLowerCase()
    if (isAppleDomain(url)) return true
    return hostname === 'icloud.com.cn' || hostname.endsWith('.icloud.com.cn')
      || hostname === 'icloud.com' || hostname.endsWith('.icloud.com')
      || hostname === 'gateway.icloud.com.cn'
  } catch {
    return false
  }
}

// iCloud 首页提取账号名 + 头像 + 邮箱（登录 AM 后同一会话静默进入，SSO 自动登录）。
// 头像 URL 需 iCloud 会话 cookie，因此在主进程用登录窗口会话抓取后转 data URL，可长期持久化。
// 若 SSO 未自动登录（页面出现登录表单）或超时，静默放弃，不影响登录流程。
// 提取全程由外部 interval 盖住页面（常驻遮罩"正在完成登录…"），用户只看到加载动画。
let appleFinalizeTimer = null
// 登录收尾阶段常驻遮罩：每 800ms 重新注入，覆盖 iCloud / 账户摘要等多次导航清空 DOM 的情况
function startAppleFinalizeOverlay(win) {
  const inject = () => {
    if (!win || win.isDestroyed()) return
    win.webContents.executeJavaScript(`
      (function () {
        if (document.getElementById('waveforge-icloud-overlay')) return;
        var el = document.createElement('div');
        el.id = 'waveforge-icloud-overlay';
        el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;';
        el.innerHTML = '<div style="width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fa2d48;animation:wf-icloud-spin .9s linear infinite;"></div><div style="opacity:.65">正在获取用户信息…</div>';
        var st = document.createElement('style');
        st.textContent = '@keyframes wf-icloud-spin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(st);
        document.body.appendChild(el);
      })()
    `).catch(() => {})
  }
  inject()
  appleFinalizeTimer = setInterval(inject, 800)
}
function stopAppleFinalizeOverlay() {
  if (appleFinalizeTimer) {
    clearInterval(appleFinalizeTimer)
    appleFinalizeTimer = null
  }
}

async function extractICloudProfile(win, appleSession) {
  try {
    console.log('[Apple登录] 静默跳转 iCloud 提取资料…')
    // 先绑定 did-finish-load（SSO 重定向可能多次触发），loadURL 后等页面就绪再轮询
    let finishedResolve = null
    const onFinished = () => { if (finishedResolve) { finishedResolve(); finishedResolve = null } }
    win.webContents.on('did-finish-load', onFinished)
    const finished = new Promise(resolve => {
      finishedResolve = resolve
      setTimeout(() => { if (finishedResolve) { finishedResolve(); finishedResolve = null } }, 20000)
    })
    await win.loadURL('https://www.icloud.com.cn/')
    await finished
    win.webContents.removeListener('did-finish-load', onFinished)
    const deadline = Date.now() + 15000
    let info = null
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (!win || win.isDestroyed()) return null
      info = await win.webContents.executeJavaScript(`
        (function () {
          var result = { name: '', email: '', avatar: '', needLogin: false };
          function clean(t) { return (t || '').replace(/\\s+/g, ' ').trim(); }
          var all = clean(document.body && document.body.textContent);
          // SSO 未自动登录的标志：登录表单（密码框 / 邮箱框 / 登录按钮 / 验证码）
          var pwdInputs = document.querySelectorAll('input[type="password"]');
          var emailInputs = document.querySelectorAll('input[type="email"], input[type="text"][autocomplete="username"], input[name*="account"], input[name*="login"], input[name*="user"], input[placeholder*="密码"], input[placeholder*="账号"], input[placeholder*="Apple ID"], input[placeholder*="验证码"]');
          var loginBtns = document.querySelectorAll('button, [role="button"], a, input[type="submit"]');
          var hasLoginBtn = false;
          for (var lb = 0; lb < loginBtns.length; lb++) {
            var lbt = clean(loginBtns[lb].textContent) + ' ' + clean(loginBtns[lb].getAttribute('value')) + ' ' + clean(loginBtns[lb].getAttribute('aria-label'));
            if (/^登录$|^继续$|^登录$|sign in|sign-in|continue|log in|登录 Apple|验证|获取验证码/i.test(lbt)) { hasLoginBtn = true; break; }
          }
          if (pwdInputs.length > 0 || emailInputs.length > 0 || hasLoginBtn) {
            result.needLogin = true;
            return result;
          }
          // 邮箱
          var emailMatch = all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
          if (emailMatch) result.email = emailMatch[0];
          // 头像：alt 含「个人资料」的方形图
          var imgs = document.querySelectorAll('img');
          for (var i = 0; i < imgs.length; i++) {
            var alt = clean(imgs[i].getAttribute('alt') || '');
            var src = imgs[i].currentSrc || imgs[i].src || '';
            if ((alt.indexOf('个人资料') !== -1 || alt.indexOf('资料照片') !== -1 || /profile|photo|avatar/i.test(alt)) && src) {
              result.avatar = src;
              break;
            }
          }
          // 名字：「账户信息」区块内的短文本（排除邮箱/订阅词/占位文案）
          if (all.indexOf('账户信息') !== -1 || all.indexOf('Account Information') !== -1 || /Account Information/i.test(all)) {
            var headings = document.querySelectorAll('h1,h2,h3,h4,[role="heading"]');
            var section = null;
            for (var h = 0; h < headings.length; h++) {
              var ht = clean(headings[h].textContent);
              if (ht === '账户信息' || /^account information$/i.test(ht)) { section = headings[h].parentElement; break; }
            }
            var candidates = [];
            if (section) {
              var nodes = section.querySelectorAll('*');
              for (var n = 0; n < nodes.length; n++) {
                var t = clean(nodes[n].textContent);
                if (t.length >= 1 && t.length <= 30
                    && !/@/.test(t)
                    && !/iCloud\\+|方案|储存空间|订阅|设置|账户信息|你的个人资料|个人资料图像|恢复|退出|签名|account information|plan|storage|subscription|settings|profile photo|recovery/i.test(t)
                    && /[\\u4e00-\\u9fa5A-Za-z]/.test(t)) {
                  candidates.push(t);
                }
              }
            }
            if (candidates.length) result.name = candidates[0];
          }
          return result;
        })()
      `).catch(() => null)
      if (info && typeof info === 'object' && String(info.name || '').trim()) break
      // SSO 未自动登录（出现登录表单）→ 立即放弃，不阻塞登录
      if (info && typeof info === 'object' && info.needLogin) {
        try {
          const curUrl = await win.webContents.getURL()
          const bodyText = await win.webContents.executeJavaScript('(document.body && document.body.textContent || "").replace(/\\s+/g," ").slice(0,200)').catch(() => '')
          console.log(`[Apple登录] iCloud SSO 未自动登录（URL=${curUrl}，页面=${bodyText}），跳过 iCloud 资料提取`)
        } catch (e) {}
        return null
      }
      // 诊断：记录本轮 URL 与页面摘要（便于排查 iCloud 停留状态）
      try {
        const curUrl = await win.webContents.getURL()
        const bodyText = await win.webContents.executeJavaScript('(document.body && document.body.textContent || "").replace(/\\s+/g," ").slice(0,150)').catch(() => '')
        console.log(`[Apple登录] iCloud 提取中… URL=${curUrl} 页面=${bodyText}`)
      } catch (e) {}
    }
    if (!info || typeof info !== 'object') return null
    const name = String(info.name || '').trim()
    const email = String(info.email || '').trim()
    const avatarUrl = String(info.avatar || '').trim()
    if (!name && !avatarUrl) return null

    // 头像转 data URL：主进程带会话 cookie 抓取（浏览器/渲染进程无 iCloud cookie，会 401）
    let avatarDataUrl = ''
    if (avatarUrl) {
      try {
        const cookies = await appleSession.cookies.get({ url: avatarUrl })
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ')
        const resp = await fetch(avatarUrl, { headers: { Cookie: cookieHeader }, redirect: 'follow' })
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer())
          const contentType = resp.headers.get('content-type') || 'image/jpeg'
          // 头像一般几十 KB；超 300KB 不再转 data URL（避免撑爆 localStorage）
          if (buf.length <= 300 * 1024) {
            avatarDataUrl = `data:${contentType};base64,${buf.toString('base64')}`
          } else {
            avatarDataUrl = avatarUrl
          }
        }
      } catch (e) {
        console.log(`[Apple登录] iCloud 头像抓取失败：${e && e.message ? e.message : e}`)
      }
    }
    if (name) console.log(`[Apple登录] iCloud 账号名：${name}`)
    if (email) console.log(`[Apple登录] iCloud 邮箱：${email}`)
    if (avatarDataUrl) console.log(`[Apple登录] iCloud 头像已抓取（${avatarDataUrl.startsWith('data:') ? 'data URL' : 'URL'}）`)
    return { name, email, avatarUrl: avatarDataUrl || avatarUrl }
  } catch (e) {
    console.log(`[Apple登录] iCloud 资料提取失败（跳过，不影响登录）：${e && e.message ? e.message : e}`)
    return null
  } finally {
    win.webContents.removeListener('did-finish-load', onFinished)
  }
  // 遮罩由调用方 startAppleFinalizeOverlay 管理，窗口关闭时随 finish() 清理
}

// 从按钮提取语义 SVG 图标（排除右箭头/关闭等纯装饰图标），转 data URL 并注入白色 fill
// 注入到提取脚本中的页面侧函数
const APPLE_ICON_EXTRACTOR = `
  function wfAppleIcon(btn) {
    var svgs = btn.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      var vb = s.getAttribute('viewBox') || '';
      var w = parseFloat(s.getAttribute('width')) || 0;
      var h = parseFloat(s.getAttribute('height')) || 0;
      // 跳过纯箭头（窄长条 viewBox 如 "0 0 9 48"）与 X 关闭（14x14 十字）
      if (/0 0 9 48|0 0 17 48|0 0 14 44/.test(vb)) continue;
      if (vb === '0 0 14 14' && w <= 14 && h <= 14) continue; // 关闭 X
      var html = s.outerHTML || '';
      if (html.length < 80 || html.length > 4000) continue;
      // 标准化为正方形 viewBox（取宽高最大值居中），保证在固定容器下占满
      var vbMatch = vb.match(/^(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)\\s+(-?[\\d.]+)$/);
      var out = html;
      if (vbMatch) {
        var vx = parseFloat(vbMatch[1]), vy = parseFloat(vbMatch[2]);
        var vw = parseFloat(vbMatch[3]), vh = parseFloat(vbMatch[4]);
        var side = Math.max(vw, vh);
        var cx = vx + vw / 2, cy = vy + vh / 2;
        var nvb = (cx - side / 2) + ' ' + (cy - side / 2) + ' ' + side + ' ' + side;
        out = out.replace(/viewBox="[^"]*"/, 'viewBox="' + nvb + '"');
      }
      // 不注入 fill：渲染端用 CSS mask 按主题色填充（保留原始 path，去掉可能的 fill/stroke/width/height 干扰）
      out = out.replace(/\s*fill="[^"]*"/g, '').replace(/\s*stroke="[^"]*"/g, '')
        .replace(/\s*width="[^"]*"/g, '').replace(/\s*height="[^"]*"/g, '');
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(out);
    }
    return '';
  }
`

// ── Apple 账户资料提取（account.apple.com，与 AM 同属 apple.com 域）────
// 注意：AM 登录会话（music.apple.com 域）不会自动带出 account.apple.com 的登录态。
// 用户同意后跳转到 account.apple.com，若未登录则停留登录页让用户完成登录（Apple 会预填邮箱），
// 登录成功后自动抓取：昵称 / 邮箱 / 真实头像(data URL) / 出生日期 / 国家或地区 / 语言。
async function extractAppleAccountProfile(win, appleSession) {
  try {
    console.log('[Apple登录] 访问 Apple 账户个人信息页…')
    await win.loadURL('https://account.apple.com/account/manage/section/information')
    // 数据采集期顶部药丸提示（非阻塞；页面导航会清 DOM，导航后注入）
    showApplePill(win, '正在获取用户信息…')
    // 等页面加载完成（SPA 渲染；若需登录，用户完成登录后自动进入。最多等 10 分钟）
    // 头像/昵称抓取总预算 1 分钟（Apple 部分地区节点返回慢，但也不宜久等）；
    // 若触发 needLogin（用户在窗口内手动登录 Apple 账户），从提示起再给 5 分钟人工等待
    let deadline = Date.now() + 60 * 1000
    let info = null
    let loginPrompted = false
    let avatarOnlyStreak = 0
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (!win || win.isDestroyed()) return null
      info = await win.webContents.executeJavaScript(`
        ${APPLE_ICON_EXTRACTOR}
        (function () {
          var result = { name: '', email: '', avatar: '', birthday: '', country: '', language: '', icons: {}, needLogin: false };
          function clean(t) { return (t || '').replace(/\\s+/g, ' ').trim(); }
          var all = clean(document.body && document.body.textContent);
          // 未登录标志：出现"登录"链接且无"退出登录"，且主区未渲染出个人信息
          if (all.indexOf('退出登录') === -1 && (all.indexOf('登录') !== -1 || all.indexOf('Sign in') !== -1)) {
            if (!document.querySelector('h1')) { result.needLogin = true; return result; }
          }
          // 头像：alt="描述文件" 的图（真实账户照片，data URL）
          var imgs = document.querySelectorAll('img');
          for (var i = 0; i < imgs.length; i++) {
            var alt = clean(imgs[i].getAttribute('alt') || '');
            var src = imgs[i].currentSrc || imgs[i].src || '';
            if ((alt.indexOf('描述文件') !== -1 || /profile|avatar|photo/i.test(alt)) && src) {
              result.avatar = src;
              break;
            }
          }
          // 出生日期 / 国家或地区 / 语言（个人信息页各按钮标题，同时抓左侧图标；
          // 标签中英双语——account.apple.com 跟随账户语言设置，英文界面也能抓到）
          var btns = document.querySelectorAll('button, [role="button"]');
          for (var b = 0; b < btns.length; b++) {
            var bt = clean(btns[b].textContent);
            var bm = bt.match(/^(姓名|Name|出生日期|Birthday|国家或地区|Country or Region|Country\\/Region|语言|Language)\\s*(.*)$/);
            if (bm) {
              var key = bm[1];
              var isName = key === '姓名' || key === 'Name';
              var isBirth = key === '出生日期' || key === 'Birthday';
              var isCountry = key === '国家或地区' || key === 'Country or Region' || key === 'Country/Region';
              var isLang = key === '语言' || key === 'Language';
              var val = bm[2];
              var icon = wfAppleIcon(btns[b]);
              if (isName && val && !result.name) result.name = val;
              else if (isBirth && val) { result.birthday = val; if (icon) result.icons.birthday = icon; }
              else if (isCountry && val) { result.country = val; if (icon) result.icons.country = icon; }
              else if (isLang && val) { result.language = val; if (icon) result.icons.language = icon; }
            }
          }
          // 邮箱
          var emailMatch = all.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
          if (emailMatch) result.email = emailMatch[0];
          return result;
        })()
      `).catch(() => null)
      if (info && typeof info === 'object' && String(info.name || '').trim() && String(info.avatar || '').trim()) break
      // 空转保护：特殊布局/语言下昵称可能始终抓不到——头像连续 3 轮稳定即收手
      //（返回仅头像的结果，昵称走账单姓名兜底），避免干等满 10 分钟超时
      if (info && typeof info === 'object' && String(info.avatar || '').trim() && String(info.name || '').trim() === '') {
        avatarOnlyStreak += 1
        if (avatarOnlyStreak >= 3) break
      } else {
        avatarOnlyStreak = 0
      }
      if (info && typeof info === 'object' && info.needLogin) {
        // 未登录：移除处理中遮罩（让登录表单可见），提示用户在当前窗口完成 Apple 账户登录
        // （Apple 会识别 AM 会话预填邮箱），然后继续轮询等待登录成功。
        win.webContents.executeJavaScript('(function(){var e=document.getElementById("waveforge-apple-processing");if(e&&e.parentNode)e.parentNode.removeChild(e);var c=document.getElementById("waveforge-apple-consent");if(c&&c.parentNode)c.parentNode.removeChild(c);})()').catch(() => {})
        if (!loginPrompted) {
          loginPrompted = true
          // 人工登录不受 1 分钟预算限制：从提示起重置 5 分钟窗口
          deadline = Math.max(deadline, Date.now() + 5 * 60 * 1000)
          console.log('[Apple登录] account.apple.com 未登录，等待用户在当前窗口完成登录…')
          win.webContents.executeJavaScript(`
            (function () {
              if (document.getElementById('waveforge-account-login-hint')) return;
              var el = document.createElement('div');
              el.id = 'waveforge-account-login-hint';
              el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;background:rgba(10,10,12,0.92);color:#fff;padding:14px 20px;font:600 13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.12);';
              el.innerHTML = '<span style="color:#fa2d48;font-size:16px;">●</span> 请在下方完成 Apple 账户登录（邮箱已预填），登录后将自动获取您的账户资料';
              document.body.appendChild(el);
            })()
          `).catch(() => {})
        }
        continue
      }
    }
    if (!info || typeof info !== 'object') return null
    // 登录成功：移除登录提示条（数据已就绪，顶部药丸继续显示到安全页抓取结束）
    win.webContents.executeJavaScript('(function(){var e=document.getElementById("waveforge-account-login-hint");if(e&&e.parentNode)e.parentNode.removeChild(e);})()').catch(() => {})
    const name = String(info.name || '').trim()
    const email = String(info.email || '').trim()
    const avatar = String(info.avatar || '').trim()
    const birthday = String(info.birthday || '').trim()
    const country = String(info.country || '').trim()
    const language = String(info.language || '').trim()
    if (!name && !avatar) return null
    if (name) console.log(`[Apple登录] Apple 账户昵称：${name}`)
    if (email) console.log(`[Apple登录] Apple 账户邮箱：${email}`)
    if (avatar) console.log(`[Apple登录] Apple 账户头像已抓取（${avatar.startsWith('data:') ? 'data URL' : 'URL'}，${avatar.length} 字符）`)
    if (birthday) console.log(`[Apple登录] 出生日期：${birthday}`)
    const icons = (info.icons && typeof info.icons === 'object') ? info.icons : {}
    if (Object.keys(icons).length) console.log(`[Apple登录] 个人信息页图标已抓取：${Object.keys(icons).join('、')}`)
    return { name, email, avatarUrl: avatar, birthday, country, language, icons }
  } catch (e) {
    console.log(`[Apple登录] Apple 账户资料提取失败（跳过，不影响登录）：${e && e.message ? e.message : e}`)
    return null
  }
}

// account.apple.com 设备页：提取设备列表（设备名 + 型号）
async function extractAppleDevices(win) {
  try {
    await win.loadURL('https://account.apple.com/account/manage/section/devices')
    const deadline = Date.now() + 12000
    let devices = null
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (!win || win.isDestroyed()) return []
      devices = await win.webContents.executeJavaScript(`
        ${APPLE_ICON_EXTRACTOR}
        (function () {
          var result = [];
          // 设备型号模式（排除付款方式/家庭成员等非设备项）
          var modelRe = /Mac|iPhone|iPad|iPod|Windows|Apple\\s*TV|Watch|AirPods|Studio|Pro|Mini|Air|Phone|Book|Vision/i;
          var btns = document.querySelectorAll('button, [role="button"]');
          for (var b = 0; b < btns.length; b++) {
            var h = btns[b].querySelector('h1,h2,h3,h4,[role="heading"]');
            var title = h ? (h.textContent || '').replace(/\\s+/g, ' ').trim() : '';
            if (!title) continue;
            var model = '';
            var generics = btns[b].querySelectorAll('div, span, p, [role="generic"]');
            for (var g = 0; g < generics.length; g++) {
              var t = (generics[g].textContent || '').replace(/\\s+/g, ' ').trim();
              if (t && t !== title) { model = t; break; }
            }
            // 仅接受：标题或型号包含设备特征，且标题不含付款/家庭成员标识
            if (/支付|Pay|UnionPay|银联|家庭|成员|（我）/.test(title)) continue;
            if (!modelRe.test(title + ' ' + model)) continue;
            var icon = wfAppleIcon(btns[b]);
            result.push({ name: title, model: model, icon: icon });
          }
          return result;
        })()
      `).catch(() => null)
      if (devices && Array.isArray(devices) && devices.length > 0) break
    }
    if (!devices || !Array.isArray(devices)) return []
    const list = devices.filter(d => d && d.name).slice(0, 30)
    if (list.length) console.log(`[Apple登录] 设备列表：${list.length} 台（${list.slice(0, 3).map(d => d.name).join('、')}…）`)
    return list
  } catch (e) {
    console.log(`[Apple登录] 设备提取失败（跳过）：${e && e.message ? e.message : e}`)
    return []
  }
}

// account.apple.com 登录与安全性页：提取安全信息（双重认证/受信任设备等）
async function extractAppleSecurity(win) {
  try {
    await win.loadURL('https://account.apple.com/account/manage/section/security')
    showApplePill(win, '正在获取账户安全信息…')
    const deadline = Date.now() + 12000
    let info = null
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      if (!win || win.isDestroyed()) return null
      info = await win.webContents.executeJavaScript(`
        ${APPLE_ICON_EXTRACTOR}
        (function () {
          var result = { twoFactor: '', trustedDevices: '', passwordUpdated: '', notificationEmail: '', recovery: '', legacyContact: '', signInWithApple: '', icons: {} };
          var btns = document.querySelectorAll('button, [role="button"]');
          for (var b = 0; b < btns.length; b++) {
            var t = (btns[b].textContent || '').replace(/\\s+/g, ' ').trim();
            var m = t.match(/^账户安全\\s*(.*)$/);
            if (m && m[1]) {
              var sec = m[1];
              var two = sec.match(/(双重认证|two-factor)/i);
              var dev = sec.match(/(\\d+)\\s*台受信任设备|(\\d+)\\s*trusted devices/i);
              if (two) result.twoFactor = two[0];
              if (dev) result.trustedDevices = dev[1] || dev[2];
              var icon = wfAppleIcon(btns[b]);
              if (icon) result.icons.security = icon;
              continue;
            }
            m = t.match(/^密码\\s*(.*)$/);
            if (m && m[1]) { result.passwordUpdated = m[1]; var icon2 = wfAppleIcon(btns[b]); if (icon2) result.icons.password = icon2; }
            m = t.match(/^通知电子邮件\\s*(\\S+@\\S+)/);
            if (m) { result.notificationEmail = m[1]; var icon3 = wfAppleIcon(btns[b]); if (icon3) result.icons.notification = icon3; }
            m = t.match(/^账户恢复\\s*(.*)$/);
            if (m && m[1]) { result.recovery = m[1]; var icon4 = wfAppleIcon(btns[b]); if (icon4) result.icons.recovery = icon4; }
            m = t.match(/^遗产联系人\\s*(.*)$/);
            if (m && m[1]) { result.legacyContact = m[1]; var icon5 = wfAppleIcon(btns[b]); if (icon5) result.icons.legacy = icon5; }
            m = t.match(/^通过 Apple 登录\\s*(.*)$/);
            if (m && m[1]) { result.signInWithApple = m[1]; var icon6 = wfAppleIcon(btns[b]); if (icon6) result.icons.apple = icon6; }
          }
          return result;
        })()
      `).catch(() => null)
      if (info && typeof info === 'object' && (info.twoFactor || info.trustedDevices || info.signInWithApple)) break
    }
    if (!info || typeof info !== 'object') return null
    if (info.twoFactor) console.log(`[Apple登录] 双重认证：${info.twoFactor}`)
    if (info.trustedDevices) console.log(`[Apple登录] 受信任设备：${info.trustedDevices} 台`)
    if (info.signInWithApple) console.log(`[Apple登录] 通过 Apple 登录：${info.signInWithApple}`)
    return info
  } catch (e) {
    console.log(`[Apple登录] 安全信息提取失败（跳过）：${e && e.message ? e.message : e}`)
    return null
  }
}

// 在登录窗口内显示"处理中"遮罩（抓取数据等耗时操作期间，避免停留在原始页面）
function showAppleOverlay(win, text) {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`
    (function () {
      var text = ${JSON.stringify(text || '正在获取用户信息…')};
      if (document.getElementById('waveforge-apple-consent')) {
        // 已存在弹窗遮罩（同意/拒绝后切换为处理中）：更新文案
        var card = document.getElementById('waveforge-apple-consent');
        card.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,\\"Segoe UI\\",\\"PingFang SC\\",\\"Microsoft YaHei\\",sans-serif;">' +
          '<div style="width:36px;height:36px;border-radius:50%;border:3px solid rgba(255,255,255,0.18);border-top-color:#fa2d48;animation:wf-consent-spin 0.9s linear infinite;"></div>' +
          '<div style="opacity:0.75;">' + text + '</div>' +
          '</div>';
        return;
      }
      var el = document.createElement('div');
      el.id = 'waveforge-apple-processing';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,10,12,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;';
      el.innerHTML =
        '<div style="width:36px;height:36px;border-radius:50%;border:3px solid rgba(255,255,255,0.18);border-top-color:#fa2d48;animation:wf-consent-spin 0.9s linear infinite;"></div>' +
        '<div style="opacity:0.75;">' + text + '</div>';
      if (!document.getElementById('wf-consent-spin-style')) {
        var st = document.createElement('style');
        st.id = 'wf-consent-spin-style';
        st.textContent = '@keyframes wf-consent-spin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(st);
      }
      document.body.appendChild(el);
    })()
  `).catch(() => {})
}

// ── 药丸提示（登录窗口顶部的非阻塞进度胶囊，数据采集各阶段复用） ──
// 同一元素复用：重复调用只更新文案（跨页面导航后 DOM 重建，需在导航后重新注入）
function showApplePill(win, text) {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`
    (function () {
      var text = ${JSON.stringify(text || '正在获取用户信息…')};
      var el = document.getElementById('waveforge-apple-pill');
      if (!el) {
        el = document.createElement('div');
        el.id = 'waveforge-apple-pill';
        el.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(10,10,12,0.86);border:1px solid rgba(255,255,255,0.14);border-radius:999px;padding:9px 18px;display:flex;align-items:center;gap:9px;color:#fff;font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.45);backdrop-filter:blur(8px);';
        el.innerHTML =
          '<span style="width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,0.22);border-top-color:#fa2d48;display:inline-block;animation:wf-consent-spin 0.9s linear infinite;"></span>' +
          '<span id="waveforge-apple-pill-text" style="opacity:0.85;">' + text + '</span>';
        if (!document.getElementById('wf-consent-spin-style')) {
          var st = document.createElement('style');
          st.id = 'wf-consent-spin-style';
          st.textContent = '@keyframes wf-consent-spin{to{transform:rotate(360deg)}}';
          (document.head || document.documentElement).appendChild(st);
        }
        document.body.appendChild(el);
      } else {
        var t = document.getElementById('waveforge-apple-pill-text');
        if (t) t.textContent = text;
      }
    })()
  `).catch(() => {})
}

function hideApplePill(win) {
  if (!win || win.isDestroyed()) return
  win.webContents.executeJavaScript(`(function(){var e=document.getElementById('waveforge-apple-pill');if(e&&e.parentNode)e.parentNode.removeChild(e);})()`).catch(() => {})
}

// ── Apple 账户信息展示确认弹窗（登录窗口内，用户同意才继续抓取 account.apple.com）────
// 在 AM 登录窗口内注入一个深色弹窗：告知用户已获取的 Apple ID/账单信息，
// 询问是否同意登录 Apple 账户以展示完整信息（昵称/头像/个人信息）。
// 同意 → 继续抓取 account.apple.com；拒绝 → 使用账单真名 + monogram 头像。
// 通过轮询窗口变量等待用户选择（无 IPC 往返，简单可靠）。
async function askAppleAccountConsent(win, billingName) {
  try {
    // 清理旧状态
    await win.webContents.executeJavaScript('window.__wfAppleAccountChoice = ""').catch(() => {})
    await win.webContents.executeJavaScript(`
      (function () {
        if (document.getElementById('waveforge-apple-consent')) {
          document.getElementById('waveforge-apple-consent').remove();
        }
        var overlay = document.createElement('div');
        overlay.id = 'waveforge-apple-consent';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(10,10,12,0.88);display:flex;align-items:center;justify-content:center;padding:24px;';
        var card = document.createElement('div');
        card.style.cssText = 'max-width:430px;width:100%;background:#14141c;border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:28px 26px;color:#fff;font:500 14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 24px 80px rgba(0,0,0,0.6);';
        card.innerHTML =
          '<div style="font-size:17px;font-weight:700;margin-bottom:6px;">Apple 账户信息</div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:16px;">隐私知情选择</div>' +
          '<div style="color:rgba(255,255,255,0.78);font-size:13px;line-height:1.7;">' +
          'Apple Music 登录本身并不包含您的头像与昵称。我们已获取您的 Apple ID 与账单信息。' +
          '若您同意，我们将进一步读取您的 Apple 账户资料（昵称、头像、个人信息）用于完整展示。' +
          '</div>' +
          '<div style="margin-top:14px;padding:12px 14px;background:rgba(255,255,255,0.05);border-radius:12px;font-size:12.5px;color:rgba(255,255,255,0.55);line-height:1.7;">' +
          '所有数据仅保存在本机，不会向云端或任何平台传播泄露。拒绝后仍可正常使用 Apple Music 功能，仅隐藏账户资料。' +
          '</div>' +
          '<div style="display:flex;gap:10px;margin-top:22px;">' +
          '<button id="wf-consent-reject" style="flex:1;padding:11px 0;border-radius:12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.14);color:#fff;font-size:14px;font-weight:600;cursor:pointer;">拒绝登录</button>' +
          '<button id="wf-consent-accept" style="flex:1;padding:11px 0;border-radius:12px;background:#fa2d48;border:none;color:#fff;font-size:14px;font-weight:700;cursor:pointer;">同意登录</button>' +
          '</div>';
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        // 点击后：记录选择并把弹窗内容切换为"正在获取用户信息…"（遮罩常驻，避免回到 AM 界面）
        function wfShowProcessing(text) {
          var o = document.getElementById('waveforge-apple-consent');
          if (!o) return;
          o.innerHTML =
            '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,\\"Segoe UI\\",\\"PingFang SC\\",\\"Microsoft YaHei\\",sans-serif;">' +
            '<div style="width:36px;height:36px;border-radius:50%;border:3px solid rgba(255,255,255,0.18);border-top-color:#fa2d48;animation:wf-consent-spin 0.9s linear infinite;"></div>' +
            '<div style="opacity:0.75;">' + text + '</div>' +
            '</div>';
          if (!document.getElementById('wf-consent-spin-style')) {
            var st = document.createElement('style');
            st.id = 'wf-consent-spin-style';
            st.textContent = '@keyframes wf-consent-spin{to{transform:rotate(360deg)}}';
            (document.head || document.documentElement).appendChild(st);
          }
        }
        document.getElementById('wf-consent-accept').addEventListener('click', function () {
          window.__wfAppleAccountChoice = 'accept';
          wfShowProcessing('正在获取用户信息…');
        });
        document.getElementById('wf-consent-reject').addEventListener('click', function () {
          window.__wfAppleAccountChoice = 'reject';
          wfShowProcessing('正在写入数据，请稍后…');
        });
      })()
    `).catch(() => {})
    // 轮询等待用户选择（最多 5 分钟，超时视为拒绝）
    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 300))
      if (!win || win.isDestroyed()) return 'reject'
      const choice = await win.webContents.executeJavaScript('window.__wfAppleAccountChoice || ""').catch(() => '')
      if (choice === 'accept' || choice === 'reject') {
        console.log(`[Apple登录] 用户${choice === 'accept' ? '同意' : '拒绝'}展示 Apple 账户信息`)
        return choice
      }
    }
    return 'reject'
  } catch (e) {
    console.log(`[Apple登录] 账户信息确认弹窗异常（按拒绝处理）：${e && e.message ? e.message : e}`)
    return 'reject'
  }
}

async function createAppleLoginWindow() {
  return new Promise((resolve) => {
    if (appleLoginWindow) {
      appleLoginWindow.focus()
      resolve({ success: false, error: 'Apple Music 登录窗口已打开' })
      return
    }

    let settled = false
    let mediaTokenFoundAt = 0
    appleDevTokenCapture = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      // 释放 webRequest 拦截，避免常驻泄漏
      try { appleSession.webRequest.onBeforeSendHeaders(null) } catch {}
      stopAppleFinalizeOverlay()
      resolve(result)
    }

    // 独立分区会话：登录窗口与主应用隔离，Cookie 互不污染
    // （castlabs 42 无会话级 WebAuthn 开关，通行密钥弹窗在窗口创建处的 dom-ready 拦截）
    const appleSession = session.fromPartition(APPLE_LOGIN_PARTITION)

    void (async () => {
      try {
        // 清理上次登录残留（cookies 需通过 clearStorageData 的 cookies storages 清除）
        await appleSession.clearStorageData()
        await appleSession.clearCache()
        await appleSession.clearStorageData({ storages: ['cookies'] })

        // 拦截登录窗口发往 Apple 目录 API 的请求，捕获 Authorization: Bearer <dev token>
        appleSession.webRequest.onBeforeSendHeaders(
          { urls: ['https://amp-api.music.apple.com/*'] },
          (details, callback) => {
            const auth = details.requestHeaders['Authorization'] || details.requestHeaders['authorization']
            if (auth && auth.startsWith('Bearer ') && !appleDevTokenCapture) {
              appleDevTokenCapture = auth.slice('Bearer '.length)
            }
            callback({ requestHeaders: details.requestHeaders })
          }
        )

        const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')

        appleLoginWindow = new BrowserWindow({
          width: 1000,
          height: 700,
          parent: mainWindow,
          modal: true,
          show: false, // 先显示本地加载动画页，避免 Apple 页面加载期间纯黑
          frame: false, // 无标题栏/无最小化最大化/无菜单栏，只留注入的关闭 X
          autoHideMenuBar: true,
          backgroundColor: '#0a0a0a',
          title: 'WaveForge 澜音工坊 - Apple Music 登录',
          icon: fs.existsSync(iconPath) ? iconPath : undefined,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: APPLE_LOGIN_PARTITION,
          },
        })
        appleLoginWindow.webContents.setUserAgent(APPLE_SAFARI_UA)

        // 页面级拦截 WebAuthn（通行密钥）：castlabs 42 无会话级开关，且 Apple 登录页会自动
        // 触发系统通行密钥选择器——Win11 下"Windows 安全中心"弹窗每次都跟着弹。
        // 关键：Apple 的登录表单在**跨域 iframe**里（appleid/itunes 域），只补主 frame 拦不到；
        // 这里对 framesInSubtree 的全部 frame 注入 stub（credentials.get/create 立即 NotAllowedError
        // + 关掉平台认证器探测，让页面连通行密钥选项都不渲染），并在窗体生命周期前 90 秒内
        // 定时补种（动态创建的 iframe 等不到事件）
        const WEB_AUTHN_BLOCK_STUB = `
          (function () {
            try {
              var c = navigator.credentials;
              if (!c || !c.__wfWebAuthnBlocked) {
                var reject = function () { return Promise.reject(new DOMException('WebAuthn disabled', 'NotAllowedError')); };
                Object.defineProperty(navigator, 'credentials', {
                  value: { __wfWebAuthnBlocked: true, get: reject, create: reject },
                  configurable: true,
                });
              }
              if (window.PublicKeyCredential) {
                try {
                  window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = function () { return Promise.resolve(false); };
                  window.PublicKeyCredential.isConditionalMediationAvailable = function () { return Promise.resolve(false); };
                } catch (e) { /* 忽略 */ }
              }
              // 拆条件填充触发器：邮箱输入框的 autocomplete="webauthn" 一聚焦就会发起
              // 通行密钥自动填充（Win11 弹系统选择器）——剥掉该标记
              var strip = function (root) {
                try {
                  var list = (root || document).querySelectorAll('input[autocomplete*="webauthn" i]');
                  for (var i = 0; i < list.length; i++) {
                    var a = list[i].getAttribute('autocomplete') || '';
                    var next = a.replace(/webauthn/gi, '').replace(/\\s+/g, ' ').trim();
                    list[i].setAttribute('autocomplete', next || 'off');
                  }
                } catch (e) { /* 忽略 */ }
              };
              strip(document);
              if (!window.__wfWebauthnObserver) {
                window.__wfWebauthnObserver = true;
                try {
                  new MutationObserver(function () { strip(document); })
                    .observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['autocomplete'] });
                } catch (e) { /* 忽略 */ }
              }
            } catch (e) { /* 忽略 */ }
          })()
        `
        const blockAppleWebAuthnAllFrames = () => {
          if (!appleLoginWindow || appleLoginWindow.isDestroyed()) return
          let frames = []
          try { frames = appleLoginWindow.webContents.mainFrame.framesInSubtree() } catch { return }
          for (const frame of frames) {
            try { frame.executeJavaScript(WEB_AUTHN_BLOCK_STUB).catch(() => {}) } catch { /* frame 已销毁 */ }
          }
        }
        appleLoginWindow.webContents.on('dom-ready', blockAppleWebAuthnAllFrames)
        appleLoginWindow.webContents.on('did-frame-finish-load', blockAppleWebAuthnAllFrames)
        console.log('[AppleLogin] WebAuthn 通行密钥拦截已启用（全 frame + autocomplete 剥离 + 10 分钟补种）')
        const webAuthnPatchTimer = setInterval(() => {
          if (!appleLoginWindow || appleLoginWindow.isDestroyed()) { clearInterval(webAuthnPatchTimer); return }
          blockAppleWebAuthnAllFrames()
        }, 700)
        setTimeout(() => clearInterval(webAuthnPatchTimer), 600_000)
        // CDP 预注入：document-start 时机、先于任何页面脚本、自动覆盖所有 frame（含未来创建的）
        // —— 消灭「页面脚本先于 dom-ready 补丁捕获原始 credentials 引用」的时序竞争
        try {
          appleLoginWindow.webContents.debugger.attach('1.3')
          appleLoginWindow.webContents.debugger
            .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: WEB_AUTHN_BLOCK_STUB, runImmediately: true })
            .catch(() => { /* 失败仍有 dom-ready/定时注入兜底 */ })
        } catch { /* debugger 被占用时忽略 */ }

        // 导航守卫：Apple 登录/授权只在 apple.com 域 + iCloud（提取资料用）；外链交给系统浏览器
        appleLoginWindow.webContents.on('will-navigate', (event, url) => {
          if (!isAppleLoginAllowedDomain(url)) {
            event.preventDefault()
            if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {})
          }
        })
        appleLoginWindow.webContents.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\//i.test(String(url || ''))) shell.openExternal(String(url)).catch(() => {})
          return { action: 'deny' }
        })

        // 先显示本地加载动画（立即可见，无黑屏），短暂停留后导航到 Apple 登录页
        appleLoginWindow.loadURL(APPLE_SPINNER_HTML)
        appleLoginWindow.once('ready-to-show', () => {
          if (appleLoginWindow && !appleLoginWindow.isDestroyed()) appleLoginWindow.show()
        })
        appleNavigateTimer = setTimeout(() => {
          if (appleLoginWindow && !appleLoginWindow.isDestroyed()) {
            appleLoginWindow.loadURL('https://music.apple.com/')
          }
        }, 600)

        // dom-ready 即注入主世界脚本（页面一就绪就有关闭 X；同时补丁 fetch/XHR 捕获
        // amp-api 的 Authorization: Bearer Developer Token，并定期扫 localStorage）
        appleLoginWindow.webContents.on('dom-ready', () => {
          appleLoginWindow.webContents.executeJavaScript(`
            (function () {
              if (window.__waveforgeAppleHooked) return;
              window.__waveforgeAppleHooked = true;
              window.__waveforgeAppleDevToken = '';

              function isValidToken(t) {
                try {
                  var parts = String(t).split('.');
                  if (parts.length !== 3) return false;
                  var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                  while (b64.length % 4) b64 += '=';
                  var p = JSON.parse(decodeURIComponent(escape(atob(b64))));
                  if (p && typeof p === 'object') {
                    if (typeof p.root === 'string' && p.root.indexOf('amp-api.music.apple.com') !== -1 && !p.user) return true;
                    if (p.iss && p.exp && !p.user) return true;
                  }
                } catch (e) {}
                return false;
              }
              function report(t) {
                var v = String(t || '').trim();
                if (!v || window.__waveforgeAppleDevToken || !isValidToken(v)) return;
                window.__waveforgeAppleDevToken = v;
              }
              function maybeFromHeaders(headers) {
                try {
                  var auth = (typeof headers.get === 'function')
                    ? (headers.get('Authorization') || headers.get('authorization'))
                    : (headers.Authorization || headers.authorization);
                  if (auth && String(auth).indexOf('Bearer ') === 0) report(String(auth).slice(7));
                } catch (e) {}
              }

              // 加载动画遮罩（页面渲染期间避免纯黑让用户误以为窗口卡死）
              if (!document.getElementById('waveforge-loading-overlay')) {
                var overlay = document.createElement('div');
                overlay.id = 'waveforge-loading-overlay';
                overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483645;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#fff;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;';
                overlay.innerHTML = '<div style="width:34px;height:34px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#fa2d48;animation:wf-loading-spin .9s linear infinite;"></div><div style="opacity:.65">正在加载 Apple Music…</div>';
                var ovStyle = document.createElement('style');
                ovStyle.textContent = '@keyframes wf-loading-spin{to{transform:rotate(360deg)}}';
                (document.head || document.documentElement).appendChild(ovStyle);
                document.body.appendChild(overlay);
                // 用户一旦与页面交互（点击/触摸）立即移除遮罩，绝不让它盖住已渲染的界面
                window.addEventListener('pointerdown', function wfRemove() {
                  var el = document.getElementById('waveforge-loading-overlay');
                  if (el && el.parentNode) el.parentNode.removeChild(el);
                  window.removeEventListener('pointerdown', wfRemove);
                });
              }

              // 常显关闭 X
              if (!document.getElementById('waveforge-close-btn')) {
                var btn = document.createElement('div');
                btn.id = 'waveforge-close-btn';
                btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                btn.style.cssText = 'position:fixed;top:12px;right:12px;width:32px;height:32px;background:rgba(20,20,24,.55);backdrop-filter:blur(8px);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2147483647;color:#fff;transition:background .2s ease;';
                btn.addEventListener('mouseenter', function () { btn.style.background = 'rgba(220,38,38,.85)'; });
                btn.addEventListener('mouseleave', function () { btn.style.background = 'rgba(20,20,24,.55)'; });
                btn.addEventListener('click', function () { window.close(); });
                document.body.appendChild(btn);
              }

              // 补丁 fetch（仅 amp-api 请求）
              var origFetch = window.fetch;
              window.fetch = function (input, init) {
                try {
                  var url = typeof input === 'string' ? input : (input && input.url) || '';
                  if (url.indexOf('amp-api.music.apple.com') !== -1) maybeFromHeaders(init && init.headers);
                } catch (e) {}
                return origFetch.apply(this, arguments);
              };

              // 补丁 XHR
              var origOpen = XMLHttpRequest.prototype.open;
              XMLHttpRequest.prototype.open = function (method, url) {
                try { this.__wfUrl = String(url || ''); } catch (e) {}
                return origOpen.apply(this, arguments);
              };
              var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
              XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
                try {
                  var url = this.__wfUrl || '';
                  if (url.indexOf('amp-api.music.apple.com') !== -1 && String(name).toLowerCase() === 'authorization' && String(value).indexOf('Bearer ') === 0) {
                    report(String(value).slice(7));
                  }
                } catch (e) {}
                return origSetHeader.apply(this, arguments);
              };

              // 定期扫 localStorage
              setInterval(function () {
                try {
                  for (var i = 0; i < localStorage.length; i++) {
                    var v = localStorage.getItem(localStorage.key(i)) || '';
                    if (v.length > 150) report(v);
                  }
                } catch (e) {}
              }, 3000);
            })();
          `).catch(() => {})
        })

        // 页面加载完成后：固定延时移除加载动画（不再做内容检测，绝不卡死）
        // 同时从页面 MusicKit 实例直接取 Developer Token（localStorage 扫描已由注入脚本完成）
        appleLoginWindow.webContents.on('did-finish-load', () => {
          if (appleOverlayTimer) clearTimeout(appleOverlayTimer)
          appleOverlayTimer = setTimeout(() => {
            appleOverlayTimer = null
            if (!appleLoginWindow || appleLoginWindow.isDestroyed()) return
            appleLoginWindow.webContents.executeJavaScript(
              "(function(){var o=document.getElementById('waveforge-loading-overlay');if(o&&o.parentNode)o.parentNode.removeChild(o);})()"
            ).catch(() => {})
          }, 400)
          appleLoginWindow.webContents.executeJavaScript(`
            (function () {
              try {
                if (window.MusicKit && window.MusicKit.getInstance && MusicKit.getInstance().developerToken) {
                  return MusicKit.getInstance().developerToken;
                }
              } catch (e) {}
              return '';
            })()
          `).then(token => {
            if (token && !appleDevTokenCapture) appleDevTokenCapture = String(token)
          }).catch(() => {})
        })

        // 每 2 秒检查 media-user-token Cookie 是否出现（登录成功标志）
        const checkInterval = setInterval(async () => {
          if (!appleLoginWindow || appleLoginWindow.isDestroyed()) {
            clearInterval(checkInterval)
            return
          }
          // 读取页面主世界补丁捕获的 Developer Token
          try {
            appleLoginWindow.webContents.executeJavaScript('window.__waveforgeAppleDevToken || ""')
              .then(token => { if (token && !appleDevTokenCapture) appleDevTokenCapture = String(token) })
              .catch(() => {})
          } catch (e) {}
          try {
            const cookies = await appleSession.cookies.get({})
            const mediaUserToken = cookies.find(cookie => cookie.name === 'media-user-token')
            if (mediaUserToken && mediaUserToken.value) {
              // 登录成功后页面会立即请求 amp-api 拉取数据（此时才带 Developer Token）。
              // 若还没抓到，给页面最多 8 秒余量再收尾，尽量把 dev token 一并带回。
              if (!appleDevTokenCapture && !mediaTokenFoundAt) {
                mediaTokenFoundAt = Date.now()
              }
              if (appleDevTokenCapture || (mediaTokenFoundAt && Date.now() - mediaTokenFoundAt > 8000)) {
                clearInterval(checkInterval)
                // 加载动画已注释（用户需要观察完整登录流程）；确认无残留遮罩
                stopAppleFinalizeOverlay()
                // startAppleFinalizeOverlay(appleLoginWindow)
                if (appleDevTokenCapture) {
                  // 诊断日志：打印捕获到的 token 声明，便于排查兼容性
                  // （新版令牌声明为 root_https_origin，旧版为 root）
                  try {
                    const parts = appleDevTokenCapture.split('.')
                    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
                    const origin = payload.root_https_origin || payload.root || '?'
                    console.log(`[Apple登录] Developer Token 已捕获: root=${Array.isArray(origin) ? origin.join(',') : origin} iss=${payload.iss || '?'} exp=${payload.exp ? new Date(payload.exp * 1000).toISOString() : '?'} user=${payload.user ? 'yes' : 'no'}`)
                  } catch (e) {}
                } else {
                  console.warn('[Apple登录] 未能捕获 Developer Token（页面可能未发起 amp-api 请求）')
                }
                // 账号信息所需的 Apple 会话 cookie（buy.itunes 账号接口用，Cider 同款）
                const APPLE_ACCOUNT_COOKIES = ['itspod', 'pltvcid', 'pldfltcid', 'itua', 'media-user-token', 'acn1', 'dslang', 'asp']
                const appleCookies = cookies
                  .filter(cookie => APPLE_ACCOUNT_COOKIES.includes(cookie.name))
                  .map(cookie => `${cookie.name}=${cookie.value}`)
                  .join('; ')
                // 全量会话 cookie（含 Apple ID / idmsa 域，用于 Apple 账号体系的名字/头像解析）
                const allCookies = cookies
                  .map(cookie => `${cookie.name}=${cookie.value}`)
                  .join('; ')
                // 持久化全量网页会话 Cookie：Apple license（acquireWebPlaybackLicense）会校验
                // 网页会话，仅凭 media-user-token 会被拒（-1002 session ended）。登录分区是
                // 内存态（应用重启即空），登录时落盘，license 代理（local-server）读取附带。
                try {
                  fs.writeFileSync(
                    path.join(app.getPath('userData'), 'apple-web-cookies.json'),
                    JSON.stringify({ cookie: allCookies, savedAt: Date.now() }),
                    'utf8',
                  )
                  console.log(`[Apple登录] 网页会话 Cookie 已持久化（license 代理用，${allCookies.length} chars）`)
                } catch (e) {
                  console.warn('[Apple登录] Cookie 持久化失败:', e?.message || e)
                }
                // 从登录窗口渲染出的界面提取账号名/头像（web 播放器侧边栏一定显示，最后的数据源）。
                // 轮询等待侧边栏渲染完成（media-token 出现时界面可能还没画完）。
                const extractSidebarUser = () => appleLoginWindow.webContents.executeJavaScript(`
                  (function () {
                    var result = { name: '', avatar: '' };
                    function clean(t) { return (t || '').replace(/\\s+/g, ' ').trim(); }
                    function looksLikeName(t) {
                      return t.length >= 1 && t.length <= 40 && !/^\\d+$/.test(t) && !/^[\\s·•\\-–—]*$/.test(t);
                    }
                    // 头像：导航/侧边栏里的小尺寸方形图片
                    var avatarImg = null;
                    var imgs = document.querySelectorAll('img');
                    for (var j = 0; j < imgs.length; j++) {
                      var img = imgs[j];
                      var src = img.src || '';
                      if (src.indexOf('mzstatic') !== -1) {
                        var r = img.getBoundingClientRect();
                        if (r.width >= 16 && r.width <= 96 && r.height >= 16 && r.height <= 96 && Math.abs(r.width - r.height) < 8) {
                          result.avatar = src;
                          avatarImg = img;
                          break;
                        }
                      }
                    }
                    // 名字：从头像元素向上爬（账号按钮 = 头像 + 昵称 在同一个容器里）
                    if (avatarImg) {
                      var el = avatarImg;
                      for (var k = 0; k < 6 && el; k++) {
                        el = el.parentElement;
                        if (!el) break;
                        var t = clean(el.textContent);
                        if (t && looksLikeName(t) && t.indexOf('http') === -1) { result.name = t; break; }
                        if (el.children && el.children.length > 1) {
                          for (var c = 0; c < el.children.length; c++) {
                            var ct = clean(el.children[c].textContent);
                            if (ct && ct.length >= 1 && ct.length <= 40 && looksLikeName(ct) && ct !== t) { result.name = ct; break; }
                          }
                          if (result.name) break;
                        }
                      }
                    }
                    // 直接选择器兜底
                    if (!result.name) {
                      var selectors = [
                        '[data-testid="sidebar-account-name"]', '[data-testid="sidebar-account"]',
                        '[data-testid="account-name"]', '[data-testid="account-menu"]',
                        '[class*="account-name"]', '[class*="user-name"]', '[class*="profile-name"]', '[class*="account-menu"]'
                      ];
                      for (var i = 0; i < selectors.length; i++) {
                        var sel = document.querySelector(selectors[i]);
                        if (sel) {
                          var st = clean(sel.textContent);
                          if (st && looksLikeName(st)) { result.name = st; break; }
                        }
                      }
                    }
                    return result;
                  })()
                `)
                let domName = ''
                let domAvatar = ''
                let domBillingName = ''
                // 账户摘要补充字段（仅本地存储，用于用户同意登录 Apple 账户页后的互补展示）
                let appleBillingAddress = ''
                let appleCountry = ''
                let applePaymentType = ''
                let appleAccountBalance = ''
                // Apple 账户页补充字段（个人信息页：出生日期/语言；安全页；设备页）
                let appleBirthday = ''
                let appleAccountLanguage = ''
                let appleTwoFactor = ''
                let appleTrustedDevices = ''
                let applePasswordUpdated = ''
                let appleNotificationEmail = ''
                let appleSignInWithApple = ''
                // Apple 账户页信息图标（登录时一次性抓取，存入本地，展示时直接使用）
                let appleIcons = {}
                for (let domAttempt = 0; domAttempt < 12; domAttempt += 1) {
                  try {
                    const info = await extractSidebarUser()
                    if (info && typeof info === 'object') {
                      const n = String(info.name || '').trim()
                      const a = String(info.avatar || '').trim()
                      if (n) domName = n
                      if (a) domAvatar = a
                      if (domName && domAvatar) break
                    }
                  } catch (e) { /* 重试 */ }
                  await new Promise(resolve => setTimeout(resolve, 500))
                }
                if (domName) console.log(`[Apple登录] 从界面提取到账号名：${domName}`)
                if (domAvatar) console.log(`[Apple登录] 从界面提取到头像：${domAvatar.slice(0, 120)}…`)

                // Apple 账户资料提取：仅在用户同意后执行（见下方弹窗逻辑）。
                // account.apple.com 与 AM 同属 apple.com 域，SSO 会话直接生效，实测无需二次登录。
                let domEmail = ''
                let appleConsent = 'reject' // 用户是否同意展示 Apple 账户信息（默认拒绝）
                {
                  // 提前记下当前 storefront（账户摘要页需要它，导航会覆盖窗口 URL）
                  const preUrl = (await appleLoginWindow.webContents.getURL()) || ''
                  const preSf = (preUrl.match(/\/([a-z]{2})\//) || [])[1] || 'cn'
                  appleLoginWindow.__wfAppleStorefront = preSf
                }

                // 账户摘要提取：导航到「账户设置」页，从"账户摘要"里提取 Apple ID/真实姓名/账单地址等
                // （CommerceKit 与 AM 网页登录连通，登录窗口登录后可直接读取，无需额外认证）
                {
                  try {
                    const currentUrl = (await appleLoginWindow.webContents.getURL()) || ''
                    const sfMatch = currentUrl.match(/\/([a-z]{2})\//)
                    const storefront = (sfMatch && sfMatch[1]) || appleLoginWindow.__wfAppleStorefront || 'cn'
                    await appleLoginWindow.loadURL(`https://music.apple.com/${storefront}/account/settings?l=zh-Hans-CN`)
                    // 账单抓取药丸提示（导航完成后注入，避免被页面加载清掉）
                    showApplePill(appleLoginWindow, '正在获取账单信息…')
                    // 等 iframe（CommerceKit 账户设置）加载
                    await new Promise(resolve => setTimeout(resolve, 4500))
                    const accountInfo = await appleLoginWindow.webContents.executeJavaScript(`
                      (function () {
                        var result = { email: '', realName: '', billingAddress: '', country: '', paymentType: '', accountBalance: '' };
                        function textOf(el) { return el && el.textContent ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
                        var iframes = document.querySelectorAll('iframe');
                        var doc = document;
                        for (var i = 0; i < iframes.length; i++) {
                          try { if (iframes[i].contentDocument) { doc = iframes[i].contentDocument; break; } } catch (e) {}
                        }
                        // 字段标签 → 紧随其后的 list/listitem 值（账户摘要区结构：generic 标签 + list 值）
                        function valuesAfter(label) {
                          var nodes = doc.querySelectorAll('div, span, h2, h3, h4, p, [role="generic"]');
                          for (var n = 0; n < nodes.length; n++) {
                            var t = textOf(nodes[n]);
                            if (t === label || t === label + ' ' || t === label) {
                              // 找到标签，取其后的兄弟 list
                              var el = nodes[n];
                              var next = el.nextElementSibling;
                              if (next) {
                                if (next.tagName === 'UL' || next.tagName === 'OL' || next.querySelector) {
                                  var items = next.querySelectorAll ? next.querySelectorAll('li, [role="listitem"]') : [];
                                  if (items.length) {
                                    var vals = [];
                                    for (var k = 0; k < items.length; k++) {
                                      var lt = textOf(items[k]);
                                      if (lt) vals.push(lt);
                                    }
                                    if (vals.length) return vals;
                                  }
                                }
                                // 标签和 list 之间可能有包裹层，往上找一层
                                var parent = next.parentElement || el.parentElement;
                                var items2 = parent ? parent.querySelectorAll('li, [role="listitem"]') : [];
                                var vals2 = [];
                                for (var m = 0; m < items2.length; m++) {
                                  var l2 = textOf(items2[m]);
                                  if (l2 && l2 !== t) vals2.push(l2);
                                }
                                if (vals2.length) return vals2;
                              }
                            }
                          }
                          return [];
                        }
                        // 邮箱：Apple 账户 行的第一个 listitem
                        var appleAccount = valuesAfter('Apple 账户');
                        if (appleAccount.length) {
                          var em = (appleAccount[0] || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/);
                          if (em) result.email = em[0];
                        }
                        // 真实姓名 + 账单地址（第一行是姓名，其余为地址；本地存储备用）
                        var billing = valuesAfter('账单寄送地址');
                        if (billing.length) {
                          result.realName = billing[0];
                          result.billingAddress = billing.slice(1).join('，');
                        }
                        // 国家/地区
                        var country = valuesAfter('国家或地区');
                        if (country.length) result.country = country[0];
                        // 付款类型
                        var payment = valuesAfter('付款类型');
                        if (payment.length) result.paymentType = payment[0];
                        // Apple 账户余额
                        var balance = valuesAfter('Apple 账户余额');
                        if (balance.length) result.accountBalance = balance[0];
                        return result;
                      })()
                    `)
                    if (accountInfo && typeof accountInfo === 'object') {
                      domEmail = String(accountInfo.email || '').trim()
                      domBillingName = String(accountInfo.realName || '').trim()
                      appleBillingAddress = String(accountInfo.billingAddress || '').trim()
                      appleCountry = String(accountInfo.country || '').trim()
                      applePaymentType = String(accountInfo.paymentType || '').trim()
                      appleAccountBalance = String(accountInfo.accountBalance || '').trim()
                    }
                    if (domEmail) console.log(`[Apple登录] 从账户摘要提取到 Apple ID：${domEmail}`)
                    if (domBillingName) console.log(`[Apple登录] 从账户摘要提取到真实姓名：${domBillingName}`)
                    if (appleBillingAddress) console.log(`[Apple登录] 账单地址已存本地：${appleBillingAddress}`)
                  } catch (e) {
                    console.log(`[Apple登录] 账户摘要提取失败：${e && e.message ? e.message : e}`)
                  }
                }

                // 账单摘要抓完，撤掉药丸提示再询问
                hideApplePill(appleLoginWindow)

                // ── 账户信息展示确认弹窗（登录窗口内）──
                // 用户同意 → 继续抓取 account.apple.com（昵称/头像/个人信息/设备）；
                // 用户拒绝 → 仅使用账单 Apple ID + 账单真实姓名 + monogram 头像。
                // 注意：只要 AM 登录成功就询问——不再因摘要提取为空而静默跳过
                //（Apple 页面语言/区域不同会让中文标签抓取落空，此前会被误判成"用户拒绝"）
                appleConsent = await askAppleAccountConsent(appleLoginWindow, domBillingName || '')

                // 用户同意后：抓取 account.apple.com 完整账户资料（SSO 会话直接生效，无需二次登录）
                if (appleConsent === 'accept') {
                  console.log('[Apple登录] 用户同意，开始抓取 Apple 账户资料…')
                  const accountProfile = await extractAppleAccountProfile(appleLoginWindow, appleSession)
                  if (accountProfile) {
                    if (accountProfile.name) domName = accountProfile.name
                    if (accountProfile.avatarUrl) domAvatar = accountProfile.avatarUrl
                    if (accountProfile.email && !domEmail) domEmail = accountProfile.email
                    if (accountProfile.birthday) appleBirthday = accountProfile.birthday
                    if (accountProfile.country && !appleCountry) appleCountry = accountProfile.country
                    if (accountProfile.language) appleAccountLanguage = accountProfile.language
                    if (accountProfile.icons && typeof accountProfile.icons === 'object') {
                      appleIcons = { ...appleIcons, ...accountProfile.icons }
                    }
                  }
                  // 登录与安全性页（双重认证/受信任设备等 + 图标）
                  const accountSecurity = await extractAppleSecurity(appleLoginWindow)
                  if (accountSecurity) {
                    if (accountSecurity.twoFactor) appleTwoFactor = accountSecurity.twoFactor
                    if (accountSecurity.trustedDevices) appleTrustedDevices = accountSecurity.trustedDevices
                    if (accountSecurity.passwordUpdated) applePasswordUpdated = accountSecurity.passwordUpdated
                    if (accountSecurity.notificationEmail) appleNotificationEmail = accountSecurity.notificationEmail
                    if (accountSecurity.signInWithApple) appleSignInWithApple = accountSecurity.signInWithApple
                    if (accountSecurity.icons && typeof accountSecurity.icons === 'object') {
                      appleIcons = { ...appleIcons, ...accountSecurity.icons }
                    }
                  }
                  // 账户资料抓取完毕，撤掉顶部药丸提示
                  hideApplePill(appleLoginWindow)
                } else {
                  console.log('[Apple登录] 用户拒绝，使用账单姓名 + monogram 头像')
                  // 拒绝时不抓取 Apple 账户资料；头像由渲染端用账单真实姓名生成 monogram
                  domAvatar = ''
                }

                const result = {
                  success: true,
                  mediaUserToken: mediaUserToken.value,
                  developerToken: appleDevTokenCapture || undefined,
                  cookies: appleCookies || undefined,
                  allCookies: allCookies || undefined,
                  // 显示名兜底：侧边栏昵称 → 账单真实姓名（比"Apple Music 用户"更有辨识度）
                  name: domName || domBillingName || undefined,
                  email: domEmail || undefined,
                  realName: domBillingName || undefined,
                  avatar: domAvatar || undefined,
                  billingAddress: appleBillingAddress || undefined,
                  country: appleCountry || undefined,
                  paymentType: applePaymentType || undefined,
                  accountBalance: appleAccountBalance || undefined,
                  birthday: appleBirthday || undefined,
                  language: appleAccountLanguage || undefined,
                  twoFactor: appleTwoFactor || undefined,
                  trustedDevices: appleTrustedDevices || undefined,
                  passwordUpdated: applePasswordUpdated || undefined,
                  notificationEmail: appleNotificationEmail || undefined,
                  signInWithApple: appleSignInWithApple || undefined,
                  icons: (Object.keys(appleIcons).length ? appleIcons : undefined),
                  consent: appleConsent,
                }
                finish(result)
                if (appleLoginWindow && !appleLoginWindow.isDestroyed()) appleLoginWindow.close()
              }
            }
          } catch (err) {
            console.error('❌ [Apple登录] 检查登录状态失败:', err)
          }
        }, 2000)

        // 超时保护（Apple 登录含两步验证，给足 10 分钟）
        const timeoutTimer = setTimeout(() => {
          clearInterval(checkInterval)
          finish({ success: false, error: 'Apple Music 登录超时，请重试' })
          if (appleLoginWindow && !appleLoginWindow.isDestroyed()) appleLoginWindow.close()
        }, 10 * 60 * 1000)

        appleLoginWindow.on('closed', () => {
          clearInterval(checkInterval)
          clearTimeout(timeoutTimer)
          stopAppleFinalizeOverlay()
          if (appleNavigateTimer) { clearTimeout(appleNavigateTimer); appleNavigateTimer = null }
          if (appleOverlayTimer) { clearTimeout(appleOverlayTimer); appleOverlayTimer = null }
          appleLoginWindow = null
          finish({ success: false, error: '用户取消登录' })
        })
      } catch (error) {
        console.error('❌ [Apple登录] 初始化登录窗口失败:', error)
        if (appleLoginWindow && !appleLoginWindow.isDestroyed()) appleLoginWindow.destroy()
        appleLoginWindow = null
        finish({ success: false, error: error?.message || 'Apple 登录窗口初始化失败' })
      }
    })()
  })
}

// 监听打开 Apple Music 登录窗口的请求
ipcMain.handle('apple-login', async () => {
  try {
    const result = await createAppleLoginWindow()
    return result
  } catch (err) {
    console.error('❌[Apple登录] 打开登录窗口失败:', err)
    return { success: false, error: err.message }
  }
})

// ── Apple 网页开发者令牌（gamdl / Cider-fork 同款做法）────────────────────
// Apple 网页播放器把可用的 MusicKit 开发者令牌（iss=AMPWebPlay，约 70 天有效）
// 内置在前端资源里。主进程 fetch 无 CORS 限制，拿到后返回给渲染进程缓存按需刷新。
// 这是目前唯一无需用户提供 Apple Developer 密钥即可获得的可用 Developer Token。
function decodeJwtExp(token) {
  try {
    const parts = String(token).split('.')
    if (parts.length !== 3) return 0
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return Number(payload.exp) || 0
  } catch {
    return 0
  }
}

ipcMain.handle('apple-fetch-dev-token', async () => {
  // 主进程 fetch 必须带超时，否则网络卡住会让登录面板一直转圈
  const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    // 方法一：browse 页 meta 标签中的环境配置（轻量，不下载大 bundle）
    const browseRes = await fetchWithTimeout('https://music.apple.com/us/browse', { headers: { 'User-Agent': APPLE_SAFARI_UA } })
    if (browseRes.ok) {
      const html = await browseRes.text()
      const metaMatch = html.match(/desktop-music-app\/config\/environment"\s+content="([^"]+)"/)
      if (metaMatch) {
        try {
          const env = JSON.parse(decodeURIComponent(metaMatch[1]))
          const token = env && env.MEDIA_API && env.MEDIA_API.token
          if (token) {
            const exp = decodeJwtExp(token)
            if (exp) return { success: true, token, expiresAt: exp }
          }
        } catch (e) { /* 继续尝试 bundle 方法 */ }
      }
    }

    // 方法二：主页 → 提取 bundle 路径 → 从 bundle 中提取 JWT
    const homeRes = await fetchWithTimeout('https://music.apple.com/', { headers: { 'User-Agent': APPLE_SAFARI_UA } })
    if (!homeRes.ok) throw new Error(`Apple 主页请求失败 (${homeRes.status})`)
    const homeHtml = await homeRes.text()
    const bundleMatch = homeHtml.match(/assets\/index[~-][^"']+\.js/)
    if (!bundleMatch) throw new Error('未能定位 Apple 前端资源')
    const jsRes = await fetchWithTimeout(`https://music.apple.com/${bundleMatch[0]}`, { headers: { 'User-Agent': APPLE_SAFARI_UA } })
    if (!jsRes.ok) throw new Error(`Apple 前端资源请求失败 (${jsRes.status})`)
    const js = await jsRes.text()
    const tokenMatch = js.match(/"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/)
    if (!tokenMatch) throw new Error('前端资源中未找到开发者令牌')
    const token = tokenMatch[0].replace(/"/g, '')
    const exp = decodeJwtExp(token)
    return { success: true, token, expiresAt: exp || 0 }
  } catch (err) {
    console.error('❌ [Apple登录] 获取网页开发者令牌失败:', err)
    return { success: false, error: err && err.message ? err.message : '获取开发者令牌失败' }
  }
})

// ── QQ 音乐官方增强：内置窗口领取 qmk API Key ──────────────────────────────
const QMK_OFFICIAL_KEY_URL = 'https://y.qq.com/n/ryqq_v2/qqmusic_skills'
// Dedicated isolated session for the claim window, wiped on every open so
// cached QQ login state from the app/browser is never reused.
const QMK_SESSION_PARTITION = 'waveforge-qq-skill-key'

// 注入：自动滚动到「获取 API Key」区块，并用动画引导点击「登录QQ音乐」按钮
const QMK_GUIDE_JS = `
(function () {
  if (window.__waveforgeQmkGuideDismissed) return;
  var old = document.getElementById('waveforge-skill-guide');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  function findElByText(text) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (node.nodeValue && node.nodeValue.indexOf(text) !== -1) {
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 60 && guard < 8) {
          el = el.parentElement;
          guard++;
        }
        return el;
      }
    }
    return null;
  }

  var heading = findElByText('获取 API Key');
  if (heading) {
    setTimeout(function () {
      try { heading.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }, 350);
  }

  var loginBtn = findElByText('登录QQ音乐');
  if (!loginBtn) return;

  var overlay = document.createElement('div');
  overlay.id = 'waveforge-skill-guide';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';

  var style = document.createElement('style');
  style.textContent = '@keyframes wf-guide-pulse{0%{box-shadow:0 0 0 0 rgba(49,230,139,.75)}70%{box-shadow:0 0 0 26px rgba(49,230,139,0)}100%{box-shadow:0 0 0 0 rgba(49,230,139,0)}}@keyframes wf-guide-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}';
  (document.head || document.documentElement).appendChild(style);

  var ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;border-radius:14px;border:3px solid #31e68b;background:rgba(49,230,139,.16);animation:wf-guide-pulse 1.6s infinite;pointer-events:none;';

  var arrow = document.createElement('div');
  arrow.style.cssText = 'position:fixed;width:44px;height:44px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));animation:wf-guide-bounce 1s infinite;pointer-events:none;';
  arrow.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="#31e68b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var tip = document.createElement('div');
  tip.style.cssText = 'position:fixed;padding:8px 14px;border-radius:10px;background:rgba(7,16,24,.92);color:#31e68b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(49,230,139,.4);pointer-events:none;white-space:nowrap;';
  tip.textContent = '请点击「登录QQ音乐」领取 API Key';

  function reposition() {
    var rect = loginBtn.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    ring.style.left = (rect.left - 8) + 'px';
    ring.style.top = (rect.top - 8) + 'px';
    ring.style.width = (rect.width + 16) + 'px';
    ring.style.height = (rect.height + 16) + 'px';
    arrow.style.left = (rect.left + rect.width / 2 - 22) + 'px';
    arrow.style.top = (rect.top - 60) + 'px';
    tip.style.left = (rect.left + rect.width / 2 - 125) + 'px';
    tip.style.top = (rect.top - 106) + 'px';
  }

  overlay.appendChild(ring);
  overlay.appendChild(arrow);
  overlay.appendChild(tip);
  document.body.appendChild(overlay);
  reposition();
  var moveTimer = setInterval(reposition, 600);

  var dismissed = false;
  function dismissGuide() {
    if (dismissed) return;
    dismissed = true;
    window.__waveforgeQmkGuideDismissed = true;
    clearInterval(moveTimer);
    clearInterval(goneTimer);
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  loginBtn.addEventListener('click', dismissGuide);

  var goneTimer = setInterval(function () {
    if (!loginBtn.isConnected || !loginBtn.getBoundingClientRect().width) {
      clearInterval(moveTimer);
      clearInterval(goneTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
  }, 1000);
})();
`

// 注入：右上角悬浮关闭按钮（鼠标靠近右上角出现）
const QMK_CLOSE_BTN_JS = `
(function () {
  if (document.getElementById('waveforge-close-btn')) return;
  var closeBtn = document.createElement('div');
  closeBtn.id = 'waveforge-close-btn';
  closeBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  closeBtn.style.cssText = 'position:fixed;top:20px;right:20px;width:40px;height:40px;background:rgba(0,0,0,.5);backdrop-filter:blur(10px);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:999999;color:white;opacity:0;transition:all .3s ease;pointer-events:auto;';
  var hideTimer = null;
  function showButton() { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; }
  function scheduleHide() { hideTimer = setTimeout(function () { closeBtn.style.opacity = '0'; }, 3000); }
  closeBtn.addEventListener('mouseenter', function () { clearTimeout(hideTimer); closeBtn.style.opacity = '1'; closeBtn.style.background = 'rgba(255,0,0,.7)'; });
  closeBtn.addEventListener('mouseleave', function () { closeBtn.style.background = 'rgba(0,0,0,.5)'; scheduleHide(); });
  closeBtn.addEventListener('click', function () { window.close(); });
  document.addEventListener('mousemove', function (e) {
    var d = Math.sqrt(Math.pow(window.innerWidth - e.clientX, 2) + Math.pow(e.clientY, 2));
    if (d < 150) { showButton(); scheduleHide(); }
  });
  document.body.appendChild(closeBtn);
  showButton();
  scheduleHide();
})();
`

// 从官方页抓取 qmk- 开头的 API Key（输入框值 / 元素属性 / 文本节点）
const QMK_DETECT_KEY_JS = `
(function () {
  var fullRe = /qmk-[A-Za-z0-9._-]{8,}/;
  var maskedRe = /qmk-[A-Za-z0-9.*_-]{8,}/;
  var full = '';
  var masked = '';
  function hit(value, re) {
    if (!value) return '';
    var m = re.exec(String(value));
    return m ? m[0] : '';
  }
  function consider(value) {
    if (!full) full = hit(value, fullRe);
    if (!masked && value) {
      var mm = hit(value, maskedRe);
      if (mm) masked = mm;
    }
  }
  var inputs = document.querySelectorAll('input, textarea');
  for (var i = 0; i < inputs.length; i++) {
    consider(inputs[i].value);
  }
  var attrs = ['data-key', 'data-apikey', 'data-clipboard', 'title', 'placeholder', 'aria-label', 'value'];
  var els = document.querySelectorAll('[data-key],[data-apikey],[data-clipboard],[title],[placeholder],[aria-label],[value]');
  for (var j = 0; j < els.length && !full; j++) {
    for (var a = 0; a < attrs.length; a++) {
      consider(els[j].getAttribute(attrs[a]));
    }
  }
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var count = 0;
  while (walker.nextNode() && count < 30000 && !full) {
    count++;
    consider(walker.currentNode.nodeValue);
  }
  return JSON.stringify({ full: full, masked: masked });
})()
`
// 在官方页里定位「复制Key」按钮：按多组文案匹配 + 回退到 clipboard/copy 数据属性。
// 返回真实可点击的元素（button / a / [role=button] / 带 data-clipboard 的元素）。
function qmkFindCopyBtnSource() {
  return `(function () {
    var texts = ['复制Key', '复制 Key', '复制key', '复制', 'Copy Key', 'Copy', 'copy'];
    function findCopyBtn() {
      for (var t = 0; t < texts.length; t++) {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          var node = walker.currentNode;
          var v = node.nodeValue || '';
          if (v.indexOf(texts[t]) === -1) continue;
          var el = node.parentElement;
          var guard = 0;
          while (el && el.innerText && el.innerText.length > 30 && guard < 8) { el = el.parentElement; guard++; }
          var clickable = (el && el.closest && el.closest('button, a, [role=button], [data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]')) || el;
          if (clickable) return clickable;
        }
      }
      var attrEls = document.querySelectorAll('[data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]');
      if (attrEls.length) return attrEls[0];
      return null;
    }
    var btn = findCopyBtn();
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) { return false; }
  })()`
}
const QMK_CLICK_COPY_JS = `
${qmkFindCopyBtnSource()}
`

// 注入：登录后页面只显示打码 key（qmk-12cc****…7916）时，用动画引导用户点击「复制Key」按钮。
// 复制按钮点击后完整 key 会进剪贴板，主进程轮询读到后自动完成登录并关闭窗口。
const QMK_COPY_GUIDE_JS = `
(function () {
  if (window.__waveforgeQmkCopyGuideDismissed) return;
  var old = document.getElementById('waveforge-copy-guide');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  var texts = ['复制Key', '复制 Key', '复制key', '复制', 'Copy Key', 'Copy', 'copy'];
  function findCopyBtn() {
    for (var t = 0; t < texts.length; t++) {
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        var v = node.nodeValue || '';
        if (v.indexOf(texts[t]) === -1) continue;
        var el = node.parentElement;
        var guard = 0;
        while (el && el.innerText && el.innerText.length > 30 && guard < 8) { el = el.parentElement; guard++; }
        var clickable = (el && el.closest && el.closest('button, a, [role=button], [data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]')) || el;
        if (clickable) return clickable;
      }
    }
    var attrEls = document.querySelectorAll('[data-clipboard], [data-copy], [data-clipboard-text], [data-clipboard-action]');
    if (attrEls.length) return attrEls[0];
    return null;
  }

  function mount(target) {
    if (window.__waveforgeQmkCopyGuideMounted) return;
    window.__waveforgeQmkCopyGuideMounted = true;

    var overlay = document.createElement('div');
    overlay.id = 'waveforge-copy-guide';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483646;';

    var style = document.createElement('style');
    style.textContent = '@keyframes wf-copy-pulse{0%{box-shadow:0 0 0 0 rgba(49,230,139,.75)}70%{box-shadow:0 0 0 26px rgba(49,230,139,0)}100%{box-shadow:0 0 0 0 rgba(49,230,139,0)}}@keyframes wf-copy-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(10px)}}';
    (document.head || document.documentElement).appendChild(style);

    var ring = document.createElement('div');
    ring.style.cssText = 'position:fixed;border-radius:10px;border:3px solid #31e68b;background:rgba(49,230,139,.18);animation:wf-copy-pulse 1.4s infinite;pointer-events:none;';

    var arrow = document.createElement('div');
    arrow.style.cssText = 'position:fixed;width:44px;height:44px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.55));animation:wf-copy-bounce 1s infinite;pointer-events:none;';
    arrow.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 5v14m0 0l-6-6m6 6l6-6" stroke="#31e68b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;padding:9px 15px;border-radius:10px;background:rgba(7,16,24,.94);color:#31e68b;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);border:1px solid rgba(49,230,139,.4);pointer-events:none;white-space:nowrap;';
    tip.textContent = '请点击「复制Key」按钮，自动完成登录';

    function reposition() {
      if (!target.isConnected) { cleanup(); return; }
      var rect = target.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      ring.style.left = (rect.left - 6) + 'px';
      ring.style.top = (rect.top - 6) + 'px';
      ring.style.width = (rect.width + 12) + 'px';
      ring.style.height = (rect.height + 12) + 'px';
      var above = rect.top > 150;
      arrow.style.left = (rect.left + rect.width / 2 - 22) + 'px';
      arrow.style.top = above ? (rect.top - 58) + 'px' : (rect.bottom + 14) + 'px';
      arrow.style.transform = above ? '' : 'rotate(180deg)';
      tip.style.left = Math.max(8, Math.min(window.innerWidth - 270, rect.left + rect.width / 2 - 125)) + 'px';
      tip.style.top = above ? (rect.top - 108) + 'px' : (rect.bottom + 66) + 'px';
    }

    var moveTimer = null;
    var goneTimer = null;
    function cleanup() {
      window.__waveforgeQmkCopyGuideDismissed = true;
      if (moveTimer) clearInterval(moveTimer);
      if (goneTimer) clearInterval(goneTimer);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    overlay.appendChild(ring);
    overlay.appendChild(arrow);
    overlay.appendChild(tip);
    document.body.appendChild(overlay);
    reposition();
    moveTimer = setInterval(reposition, 500);

    // 用户点击复制按钮后 key 进入剪贴板，主进程会读到并自动关闭窗口。
    target.addEventListener('click', function () { setTimeout(cleanup, 600); });
    goneTimer = setInterval(function () {
      if (!target.isConnected || !target.getBoundingClientRect().width) cleanup();
    }, 800);
  }

  var btn = findCopyBtn();
  if (btn) { mount(btn); return; }
  var tries = 0;
  var retry = setInterval(function () {
    if (window.__waveforgeQmkCopyGuideMounted || ++tries > 12) { clearInterval(retry); return; }
    var b = findCopyBtn();
    if (b) { clearInterval(retry); mount(b); }
  }, 500);
})();
`


async function createQQSkillKeyWindow() {
  // 防重入检查必须先于 session 清空：窗口开着时再次点领取，若先清空会把正在使用的
  // 独立分区 storage 全清掉，正在登录的页面当场掉登录态（对齐 apple/soda 的先检查后清理）
  if (qqSkillKeyWindow && !qqSkillKeyWindow.isDestroyed()) {
    qqSkillKeyWindow.focus()
    return Promise.resolve({ success: false, error: 'QQ 音乐官方增强领取窗口已打开' })
  }
  // Wipe the dedicated qmk session before opening so the login is always fresh.
  const qmkSession = session.fromPartition(QMK_SESSION_PARTITION)
  // Allow clipboard write so the official copy button can put the key on the clipboard.
  qmkSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  })
  qmkSession.setPermissionCheckHandler((_wc, permission) =>
    permission === 'clipboard-sanitized-write' || permission === 'clipboard-read' || permission === 'geolocation')
  try {
    await qmkSession.clearStorageData()
    await qmkSession.clearCache()
    await qmkSession.clearAuthCache()
    const qmkCookies = await qmkSession.cookies.get({})
    for (const cookie of qmkCookies) {
      await qmkSession.cookies.remove(`https://${cookie.domain}`, cookie.name)
    }
  } catch (err) {
    console.error('[QQ Skill Key] clear session failed:', err)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')

    qqSkillKeyWindow = new BrowserWindow({
      width: 1100,
      height: 760,
      parent: mainWindow,
      modal: true,
      frame: false,
      backgroundColor: '#000000',
      titleBarStyle: 'hidden',
      title: 'WaveForge 波音工坊 - QQ音乐官方增强',
      icon: fs.existsSync(iconPath) ? iconPath : undefined,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: qmkSession,
      },
    })

    qqSkillKeyWindow.loadURL(QMK_OFFICIAL_KEY_URL)

    const injectGuide = () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) return
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_GUIDE_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入引导失败:', err)
      })
      qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLOSE_BTN_JS).catch((err) => {
        console.error('[QQ Skill Key] 注入关闭按钮失败:', err)
      })
    }

    qqSkillKeyWindow.webContents.on('did-finish-load', injectGuide)
    qqSkillKeyWindow.webContents.on('did-navigate', () => setTimeout(injectGuide, 350))
    qqSkillKeyWindow.webContents.on('did-navigate-in-page', () => setTimeout(injectGuide, 350))

    // 轮询抓取页面上出现的 qmk- API Key
    let copyGuideShown = false
    let copyClickAttempts = 0
    const keyPoll = setInterval(async () => {
      if (!qqSkillKeyWindow || qqSkillKeyWindow.isDestroyed()) {
        clearInterval(keyPoll)
        return
      }
      try {
        const raw = await qqSkillKeyWindow.webContents.executeJavaScript(QMK_DETECT_KEY_JS, true)
        let info = null
        try { info = JSON.parse(raw) } catch (e) { info = null }
        let key = info && info.full ? info.full : ''
        if (!key && info && info.masked) {
          // 先注入引导动画指向「复制Key」（用户可手动点，最可靠）；同时尽力自动点击复制。
          if (!copyGuideShown) {
            copyGuideShown = true
            await qqSkillKeyWindow.webContents.executeJavaScript(QMK_COPY_GUIDE_JS, true).catch(() => {})
          }
          if (copyClickAttempts < 3) {
            copyClickAttempts++
            const clicked = await qqSkillKeyWindow.webContents.executeJavaScript(QMK_CLICK_COPY_JS, true).catch(() => false)
            if (clicked) await new Promise((r) => setTimeout(r, 500))
          }
          const cb = clipboard.readText() || ''
          const m = cb.match(/qmk-[A-Za-z0-9._-]{8,}/)
          if (m) {
            const star = info.masked.indexOf('*')
            const prefix = star > 0 ? info.masked.slice(0, star) : ''
            const lastStar = info.masked.lastIndexOf('*')
            const suffix = lastStar >= 0 && lastStar < info.masked.length - 1 ? info.masked.slice(lastStar + 1) : ''
            if ((!prefix || m[0].startsWith(prefix)) && (!suffix || m[0].endsWith(suffix))) key = m[0]
          }
        }
        if (key) {
          clearInterval(keyPoll)
          console.log('[QQ Skill Key] auto captured API Key')
          finish({ success: true, apiKey: key })
          qqSkillKeyWindow.close()
        }
      } catch (err) {
        // page navigating; skip this tick
      }
    }, 1500)

    qqSkillKeyWindow.on('closed', () => {
      clearInterval(keyPoll)
      qqSkillKeyWindow = null
      finish({ success: false, error: '用户取消了领取' })
    })
  })
}

// 监听打开 QQ 音乐官方增强领取窗口的请求
ipcMain.handle('open-qq-skill-key-window', async () => {
  try {
    return await createQQSkillKeyWindow()
  } catch (err) {
    console.error('[QQ Skill Key] 打开领取窗口失败:', err)
    return { success: false, error: err.message }
  }
})


// IPC 处理：设置开发者模式
ipcMain.handle('set-developer-mode', (event, enabled) => {
  developerMode = enabled
  console.log(`🔧 [DevMode] 开发者模式已${enabled ? '启用' : '禁用'}`)
  return { success: true }
})

// IPC 处理：获取开发者模式状态
ipcMain.handle('get-developer-mode', () => {
  return { enabled: developerMode }
})

// Device ID is stored in HKCU\Software\WaveForge; file storage is only a fallback.
ipcMain.handle('device-license:get-state', () => {
  try {
    return { success: true, ...deviceLicense.getState(app) }
  } catch (error) {
    console.error('[DeviceLicense] Failed to read state:', error)
    return { success: false, error: error?.message || 'Unable to copy device ID' }
  }
})

// 系统音量（0-100，取左右声道均值）。用 winmm 的 waveOutGetVolume 读取主输出音量，
// 2 分钟缓存避免频繁 spawn PowerShell。前端频响补偿据此自适应（<50% 时提示开启）。
let systemVolumeCache = { value: -1, expiresAt: 0 }
let systemVolumeRequest = null
ipcMain.handle('audio:get-system-volume', () => {
  if (process.platform !== 'win32') return { success: true, volume: -1 }
  const now = Date.now()
  if (systemVolumeCache.value >= 0 && now < systemVolumeCache.expiresAt) {
    return { success: true, volume: systemVolumeCache.value }
  }
  if (!systemVolumeRequest) {
    const script = [
      "Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class VolUtil { [DllImport(\"winmm.dll\")] public static extern int waveOutGetVolume(System.IntPtr hwo, out uint dwVolume); }'",
      '$v = 0',
      '[VolUtil]::waveOutGetVolume([IntPtr]::Zero, [ref]$v) | Out-Null',
      '([math]::Round(((($v -band 0xFFFF) / 65535.0) + ((($v -shr 16) -band 0xFFFF) / 65535.0)) / 2 * 100))',
    ].join('; ')
    systemVolumeRequest = new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
        systemVolumeRequest = null
        const parsed = parseInt(String(stdout || '').trim(), 10)
        const volume = error || !isFinite(parsed) ? -1 : Math.max(0, Math.min(100, parsed))
        systemVolumeCache = { value: volume, expiresAt: Date.now() + 120_000 }
        resolve({ success: true, volume })
      })
    })
  }
  return systemVolumeRequest
})

ipcMain.handle('device-license:copy-id', () => {
  try {
    const identity = deviceLicense.getOrCreateDeviceId(app)
    clipboard.writeText(identity.deviceId)
    return { success: true, ...identity }
  } catch (error) {
    console.error('[DeviceLicense] Failed to copy device ID:', error)
    return { success: false, error: error?.message || 'Unable to copy device ID' }
  }
})

ipcMain.handle('device-license:read-clipboard', () => {
  try {
    return { success: true, text: clipboard.readText() }
  } catch (error) {
    console.error('[DeviceLicense] Failed to read clipboard:', error)
    return { success: false, error: error?.message || 'Unable to read clipboard' }
  }
})

ipcMain.handle('device-license:redeem', (_event, code) => {
  try {
    return deviceLicense.redeem(app, code)
  } catch (error) {
    console.warn('[DeviceLicense] Redemption failed:', error?.message || error)
    return { success: false, error: error?.message || 'Unable to redeem code' }
  }
})

ipcMain.handle('device-license:reset', () => {
  try {
    return deviceLicense.resetDeviceLicense(app)
  } catch (error) {
    console.error('[DeviceLicense] Reset failed:', error?.message || error)
    return { success: false, error: error?.message || 'Unable to reset device license' }
  }
})

// 根据 vendor/设备名判断 GPU 类型（独显 / 核显 / 未知），用于显卡选择 UI 展示
function classifyGpuKind(device) {
  const vendor = String(device?.vendorString || '').toLowerCase()
  const name = String(device?.deviceString || '').toLowerCase()
  if (vendor.includes('nvidia')) return 'discrete'
  if (vendor.includes('intel')) return 'integrated'
  if (vendor.includes('amd') || vendor.includes('ati') || vendor.includes('advanced micro devices')) {
    // AMD：RX/Pro 系列为独显，Radeon Graphics/APU 为核显
    return /rx\s?\d|radeon\s?rx|radeon\s?pro/.test(name) ? 'discrete' : 'integrated'
  }
  return 'unknown'
}

ipcMain.handle('get-hardware-acceleration', async () => {
  let gpuInfo = null
  try {
    gpuInfo = await app.getGPUInfo('complete')
  } catch (error) {
    console.warn('[GPU] Failed to read GPU information:', error?.message || error)
  }

  const devices = Array.isArray(gpuInfo?.gpuDevice) ? gpuInfo.gpuDevice : []
  const activeGpu = devices.find(device => device?.active) || devices[0] || null

  // 去重（同一显卡可能以不同 adapter 出现），保留首条
  const seen = new Set()
  const gpus = devices
    .filter(device => {
      const key = `${device?.vendorString || ''}|${device?.deviceString || ''}`
      if (!key.trim() || seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map(device => ({
      active: Boolean(device?.active),
      vendorId: device?.vendorId,
      deviceId: device?.deviceId,
      vendorString: device?.vendorString || '',
      deviceString: device?.deviceString || '',
      driverVersion: device?.driverVersion || '',
      kind: classifyGpuKind(device),
    }))

  return {
    enabled: performanceSettings.hardwareAcceleration,
    gpuPreference: performanceSettings.gpuPreference,
    pendingGpuChange: performanceSettings.pendingGpuChange,
    actualEnabled: app.isHardwareAccelerationEnabled(),
    featureStatus: app.getGPUFeatureStatus(),
    gpu: activeGpu ? {
      active: Boolean(activeGpu.active),
      vendorId: activeGpu.vendorId,
      deviceId: activeGpu.deviceId,
      vendorString: activeGpu.vendorString || '',
      deviceString: activeGpu.deviceString || '',
      driverVendor: activeGpu.driverVendor || '',
      driverVersion: activeGpu.driverVersion || '',
    } : null,
    gpus,
  }
})

ipcMain.handle('set-hardware-acceleration', (_event, enabled) => {
  performanceSettings.hardwareAcceleration = enabled !== false
  // 关闭 GPU 加速属于风险操作，重启后需要用户确认，否则 15 秒自动恢复
  performanceSettings.pendingGpuChange = performanceSettings.hardwareAcceleration ? null : { type: 'acceleration' }
  writePerformanceSettings(performanceSettings)
  return { success: true, enabled: performanceSettings.hardwareAcceleration, requiresRestart: true }
})

ipcMain.handle('set-gpu-preference', (_event, preference) => {
  const next = ['auto', 'discrete', 'integrated'].includes(preference) ? preference : 'discrete'
  performanceSettings.gpuPreference = next
  // 切换到强制显卡（独显/核显）属于风险操作，重启后需要用户确认；自动为安全默认
  performanceSettings.pendingGpuChange = next === 'auto' ? null : { type: 'preference' }
  writePerformanceSettings(performanceSettings)
  return { success: true, gpuPreference: next, requiresRestart: true }
})

// 用户确认新的 GPU 设置可用（保留当前设置，清除待确认标记）
ipcMain.handle('confirm-gpu-change', () => {
  performanceSettings.pendingGpuChange = null
  writePerformanceSettings(performanceSettings)
  return { success: true }
})

// 用户未确认 / 点击取消：回退到安全默认值（独显 / 开启 GPU 加速）
ipcMain.handle('revert-gpu-change', () => {
  const pending = performanceSettings.pendingGpuChange
  if (pending?.type === 'acceleration') {
    performanceSettings.hardwareAcceleration = true
  } else if (pending?.type === 'preference') {
    performanceSettings.gpuPreference = 'auto'
  }
  performanceSettings.pendingGpuChange = null
  writePerformanceSettings(performanceSettings)
  return {
    success: true,
    hardwareAcceleration: performanceSettings.hardwareAcceleration,
    gpuPreference: performanceSettings.gpuPreference,
  }
})

// ── 全局高刷：让所有窗口的渲染帧率跟随所在显示器的刷新率（默认软件渲染下 Chromium 锁 60Hz）──

/** 窗口所在显示器的刷新率（Hz），夹在 [30, 360]，取不到时回退 60 */
function getWindowDisplayFrequency(win) {
  try {
    const { screen } = require('electron')
    if (!win || win.isDestroyed()) return 60
    const display = screen.getDisplayMatching(win.getBounds())
    const hz = Math.round(Number(display.displayFrequency) || 0)
    if (hz <= 0) return 60
    return Math.min(HIGH_REFRESH_MAX_HZ, Math.max(HIGH_REFRESH_MIN_HZ, hz))
  } catch {
    return 60
  }
}

/** 把当前高刷设置应用到全部窗口的 webContents（渲染帧率跟随所在显示器） */
function applyHighRefreshRate() {
  const enabled = performanceSettings.highRefreshRate === true
  const displayHz = getWindowDisplayFrequency(mainWindow)
  // 开启：默认跟随所在显示器最高刷新率；用户手动选档时取其与显示器最高中的较小值
  const targetHz = enabled
    ? (performanceSettings.highRefreshHz ? Math.min(performanceSettings.highRefreshHz, displayHz) : displayHz)
    : HIGH_REFRESH_MIN_HZ
  const targets = [mainWindow, desktopPlayerWindow, desktopLyricsWindow, taskbarWidgetWindow]
  for (const win of targets) {
    try {
      if (win && !win.isDestroyed() && win.webContents) win.webContents.setFrameRate(targetHz)
    } catch { /* 忽略 */ }
  }
  return { enabled, hz: targetHz, displayFrequency: displayHz }
}

/** 显示器/主窗口移动后重新贴合所在显示器刷新率（只绑定一次，避免重复监听） */
let highRefreshBound = false
function rebindHighRefreshRate() {
  const { screen } = require('electron')
  if (performanceSettings.highRefreshRate === true) {
    if (highRefreshBound) return
    highRefreshBound = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.on('move', applyHighRefreshRate)
        mainWindow.on('resize', applyHighRefreshRate)
      } catch { /* 忽略 */ }
    }
    screen.on('display-metrics-changed', applyHighRefreshRate)
  } else {
    highRefreshBound = false
  }
}

ipcMain.handle('display:get-info', () => {
  try {
    const { screen } = require('electron')
    const mainWinDisplay = (mainWindow && !mainWindow.isDestroyed())
      ? screen.getDisplayMatching(mainWindow.getBounds())
      : screen.getPrimaryDisplay()
    return {
      highRefreshEnabled: performanceSettings.highRefreshRate === true,
      highRefreshHz: performanceSettings.highRefreshHz,
      currentHz: getWindowDisplayFrequency(mainWindow),
      primary: screen.getPrimaryDisplay().displayFrequency,
      mainWindowDisplayId: mainWinDisplay.id,
      displays: screen.getAllDisplays().map(display => ({
        id: display.id,
        isPrimary: display.id === screen.getPrimaryDisplay().id,
        isMainWindow: display.id === mainWinDisplay.id,
        bounds: display.bounds,
        workArea: display.workArea,
        frequency: Math.round(Number(display.displayFrequency) || 0),
        scaleFactor: display.scaleFactor,
        label: `${display.bounds.width}×${display.bounds.height}${Math.round(Number(display.displayFrequency) || 0) ? ` @${Math.round(Number(display.displayFrequency) || 0)}Hz` : ''}`,
      })),
    }
  } catch (error) {
    return { error: error?.message || String(error) }
  }
})

ipcMain.handle('display:set-high-refresh', (_event, enabled, hz) => {
  performanceSettings.highRefreshRate = enabled === true
  const savedHz = Number(hz)
  performanceSettings.highRefreshHz = Number.isInteger(savedHz) && savedHz >= HIGH_REFRESH_MIN_HZ && savedHz <= HIGH_REFRESH_MAX_HZ
    ? savedHz
    : null
  writePerformanceSettings(performanceSettings)
  applyHighRefreshRate()
  rebindHighRefreshRate()
  return { success: true, enabled: performanceSettings.highRefreshRate, hz: getWindowDisplayFrequency(mainWindow) }
})

// 保存主窗口当前状态（窗口化/最大化/全屏覆盖任务栏 + 位置大小 + 所在显示器）
function persistMainWindowState() {
  try {
    const { screen } = require('electron')
    if (mainWindow && !mainWindow.isDestroyed()) {
      saveWindowState(app, mainWindow, screen)
    }
  } catch {
    // ignore
  }
}

// IPC 处理：窗口控制
ipcMain.handle('window-minimize', () => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

// 窗口"扩大态"自记状态：kiosk 全屏 / 原生全屏 / 最大化 任一成立即 true。
// Windows 上 setKiosk 进入全屏后，isKiosk()/isFullScreen()/isMaximized() 返回值可能
// 全部为 false（kiosk 走独立全屏路径且不触发 maximize 事件），导致最大化按钮的第二次
// 按压被误判为"非全屏"而重新进入全屏——看起来"按了没反应"。自记状态让进入/还原切换始终自洽。
let mainWindowExpanded = false
// 进入扩大态前的正常窗口边界：kiosk 退出后 Electron 在 Windows 上可能不恢复原位置/尺寸
//（停留在左上角或全屏尺寸），还原时显式 setBounds 恢复。
let mainWindowNormalBounds = null

// 窗口状态记忆：大小/位置/状态变化后防抖保存（关闭时会做最终保存）。
// 提升到模块级：主窗口重建（透明↔不透明切换）后事件接线继续共用。
let windowStateSaveTimer = null
const scheduleWindowStateSave = () => {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer)
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null
    persistMainWindowState()
  }, 400)
}

// 关闭全部从属窗口（主窗真关闭时清场用）：登录窗走 close()，各自 closed 处理器会把
// 挂起的登录 Promise 以"用户取消"收尾（不卡"登录中"）；任务栏 widget 与两个数据桥是
// 隐藏工具窗，直接 destroy。
function closeAllDependentWindows() {
  const closable = [qqLoginWindow, kugouLoginWindow, spotifyLoginWindow, appleLoginWindow, sodaLoginWindow, qqSkillKeyWindow, desktopPlayerWindow, desktopLyricsWindow]
  for (const w of closable) {
    try { if (w && !w.isDestroyed()) w.close() } catch { /* 忽略 */ }
  }
  try { if (taskbarWidgetWindow && !taskbarWidgetWindow.isDestroyed()) taskbarWidgetWindow.destroy() } catch { /* 忽略 */ }
  try { if (douyinBridgeWindow && !douyinBridgeWindow.isDestroyed()) douyinBridgeWindow.destroy() } catch { /* 忽略 */ }
  try { if (kugouBridgeWindow && !kugouBridgeWindow.isDestroyed()) kugouBridgeWindow.destroy() } catch { /* 忽略 */ }
}

// 主窗口事件接线：启动创建（createWindow）与融合穿透重建（recreateMainWindow）共用。
// 重建后必须重新挂接，否则窗口会失去状态推送（标题栏图标）/窗口记忆/F12 快捷键。
function wireMainWindowEvents(win) {
  // 阻止 window.open 创建新的 Electron 窗口（外部链接交给系统浏览器）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  // 窗口关闭（含退出）前做最终状态保存——will-quit 时窗口可能已销毁拿不到 bounds
  win.on('close', () => {
    persistMainWindowState()
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    if (wallpaperWatcher) {
      clearInterval(wallpaperWatcher)
      wallpaperWatcher = null
    }
    // 融合穿透重建：旧窗销毁也触发本事件，此场景绝不能清场（新主窗马上接管）
    if (win.__wfRecreating) return
    // 主窗真被关闭：同步关闭全部从属窗。它们无 parent（部分 skipTaskbar）不会随主窗
    // 级联销毁，否则 window-all-closed 永不触发，进程无窗残留、用户找不到任何入口
    closeAllDependentWindows()
  })

  // 最大化/还原/全屏事件：自记扩大态 + 向渲染端推送状态（标题栏按钮图标依赖）
  win.on('maximize', () => {
    mainWindowExpanded = true
    // 记录最大化前的正常边界（getNormalBounds 在最大化后仍返回还原态的位置/尺寸），
    // 覆盖 Win+Up / 拖到顶部等原生最大化路径——否则还原时没有边界可恢复
    if (!mainWindowNormalBounds) mainWindowNormalBounds = win.getNormalBounds()
    safeSendToWindow(win, 'window-maximized', true)
    safeSendToWindow(win, 'window-fullscreen-change', true)
  })
  win.on('unmaximize', () => {
    // 可能仍处于 kiosk/原生全屏（例如全屏内部状态变化），自记态仅在确认非全屏后清除
    mainWindowExpanded = win.isKiosk() || win.isFullScreen()
    safeSendToWindow(win, 'window-maximized', false)
    safeSendToWindow(win, 'window-fullscreen-change', mainWindowExpanded)
  })
  win.on('enter-full-screen', () => {
    mainWindowExpanded = true
    if (!mainWindowNormalBounds) mainWindowNormalBounds = win.getNormalBounds()
    safeSendToWindow(win, 'window-fullscreen-change', true)
  })
  win.on('leave-full-screen', () => {
    mainWindowExpanded = win.isKiosk() || win.isMaximized()
    safeSendToWindow(win, 'window-fullscreen-change', false)
  })

  // 加载完成后向渲染端推送当前窗口状态
  win.webContents.on('did-finish-load', () => {
    if (mainWindow === win && !win.isDestroyed()) {
      safeSendToWindow(win, 'window-maximized', win.isMaximized())
      safeSendToWindow(win, 'window-fullscreen-change', win.isKiosk() || win.isFullScreen())
    }
  })

  // 窗口状态记忆：大小/位置/状态变化后防抖保存
  win.on('resize', scheduleWindowStateSave)
  win.on('move', scheduleWindowStateSave)
  win.on('maximize', scheduleWindowStateSave)
  win.on('unmaximize', scheduleWindowStateSave)
  win.on('enter-full-screen', scheduleWindowStateSave)
  win.on('leave-full-screen', scheduleWindowStateSave)

  // F12 快捷键：开发者模式下打开开发者工具
  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (developerMode) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
      }
    }
  })
}

// 重建主窗口：transparent 仅在创建时生效（透明窗口用于桌面融合穿透，普通模式用原生
// 不透明窗口+系统圆角/阴影），切换两者只能销毁重建。重建保留窗口边界与置顶状态，
// 融合特有的状态（kiosk 记忆/沉底/鼠标穿透）由调用方在重建后应用。
async function recreateMainWindow(transparent) {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const wasAlwaysOnTop = mainWindow.isAlwaysOnTop()
  // 先退出扩大态（kiosk/全屏/最大化），避免销毁时把全屏边界写进窗口状态记忆；
  // 退出后再取边界，否则 getBounds 会拿到 kiosk 的全屏尺寸
  try {
    if (mainWindow.isKiosk()) mainWindow.setKiosk(false)
    if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
  } catch { /* 忽略 */ }
  const savedBounds = mainWindow.getBounds()
  mainWindowExpanded = false
  mainWindowNormalBounds = null

  const oldWindow = mainWindow
  mainWindow = null
  // 标记重建销毁：closed 处理器据此跳过从属窗清场（否则会关掉桌面歌词/桌面播放器等）
  oldWindow.__wfRecreating = true
  if (!oldWindow.isDestroyed()) oldWindow.destroy()

  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico')
  const win = new BrowserWindow({
    width: savedBounds.width,
    height: savedBounds.height,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 1200,
    minHeight: 800,
    frame: false,
    backgroundColor: transparent ? '#00000000' : '#000000',
    transparent,
    titleBarStyle: 'hidden',
    title: 'WaveForge 澜音工坊',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    // 不透明窗口用 Windows 11 原生圆角；透明窗口原生圆角无效，由渲染端 #root 自绘
    roundedCorners: !transparent,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      paintWhenInitiallyHidden: true, // 软件合成下隐藏时也持续绘制，避免显示时首帧空白
    },
  })
  mainWindow = win
  if (wasAlwaysOnTop) win.setAlwaysOnTop(true)
  guardAgainstExternalNavigation(win)
  wireMainWindowEvents(win)

  if (isDev) {
    win.loadURL(devServerUrl)
    if (process.env.WAVEFORGE_OPEN_DEVTOOLS === '1') win.webContents.openDevTools()
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  win.once('ready-to-show', () => {
    if (mainWindow === win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  return win
}

// 应用融合穿透窗口状态：退出 kiosk/置顶并沉底（真实窗口浮在上层），开启鼠标穿透。
const applyFusionWindowState = (win) => {
  if (!win || win.isDestroyed()) return
  try {
    if (win.isKiosk()) win.setKiosk(false)
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setAlwaysOnTop(false)
    win.moveBottom()
    win.setIgnoreMouseEvents(true, { forward: true })
  } catch (error) {
    console.error('[桌面融合穿透] 应用融合窗口状态失败:', error?.message || error)
  }
}

// 恢复原生窗口状态（关闭融合后）：重新置顶；开启前是 kiosk 全屏则还原。
const restoreNativeWindowState = (win) => {
  if (!win || win.isDestroyed()) return
  try {
    win.setAlwaysOnTop(true)
    win.moveTop()
    if (desktopFusionSavedKiosk) win.setKiosk(true)
    win.setIgnoreMouseEvents(false)
  } catch (error) {
    console.error('[桌面融合穿透] 恢复原生窗口状态失败:', error?.message || error)
  }
}

// 还原分支需要"无条件退出全部扩大形态"：isKiosk()/isFullScreen() 在 kiosk 时序下可能
// 返回 false，导致按状态判断的恢复被跳过（窗口一直停留在全屏，看起来"缩小没反应"）。
// 对非对应状态的 setKiosk(false)/setFullScreen(false)/unmaximize() 调用是无害 no-op。
const restoreMainWindowFromExpanded = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setKiosk(false)
    mainWindow.setFullScreen(false)
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    // 显式恢复进入前边界；未记录时（如启动即 kiosk）交给原生还原（unmaximize/
    // setKiosk(false)），不强行居中覆盖用户自定义位置/尺寸
    if (mainWindowNormalBounds) {
      mainWindow.setBounds(mainWindowNormalBounds)
      mainWindowNormalBounds = null
    }
  } catch (error) {
    console.error('[窗口最大化] 还原失败:', error?.message || error)
  }
}

ipcMain.handle('window-maximize', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindowExpanded) {
    // 扩大态 → 还原窗口
    console.log('[窗口最大化] 还原窗口（当前为扩大态）')
    restoreMainWindowFromExpanded()
    mainWindowExpanded = false
  } else {
    // 正常窗口 → 按用户设置进入全屏或最大化
    try {
      // 记录进入前边界，供还原时显式恢复（kiosk 退出后 Electron 可能不恢复原位置/尺寸）
      mainWindowNormalBounds = mainWindow.getBounds()
      // 从渲染进程读取全屏模式设置
      const fullscreenMode = await mainWindow.webContents.executeJavaScript(`
        (() => {
          try {
            return localStorage.getItem('fullscreenMode') || 'kiosk';
          } catch {
            return 'kiosk';
          }
        })()
      `)
      console.log('[窗口最大化] 读取到的全屏模式设置:', fullscreenMode)
      if (fullscreenMode === 'kiosk') {
        console.log('[窗口最大化] 进入全屏模式（覆盖任务栏）')
        mainWindow.setKiosk(true)
      } else {
        console.log('[窗口最大化] 进入全屏无边框模式（保留任务栏）')
        mainWindow.maximize()
      }
    } catch (error) {
      console.error('[窗口最大化] 读取设置失败，使用默认全屏模式', error)
      mainWindow.setKiosk(true)
    }
    mainWindowExpanded = true
  }
  // 切换完成后向渲染端推送真实状态，供标题栏按钮图标刷新
  // （kiosk 路径不触发 maximize/unmaximize 事件，必须在此显式同步）
  try {
    safeSendToWindow(mainWindow, 'window-maximized', mainWindow.isMaximized())
    safeSendToWindow(mainWindow, 'window-fullscreen-change', mainWindowExpanded)
    persistMainWindowState()
  } catch { /* 忽略 */ }
})

ipcMain.handle('window-close', () => {
  if (mainWindow) {
    mainWindow.close()
  }
})

// IPC 处理：获取窗口最大化状态?
ipcMain.handle('window-is-maximized', () => {
  return mainWindow ? mainWindow.isMaximized() : false
})

// 桌面融合穿透：把桌面模式「融合」进真实桌面。
// 开启后：退出 kiosk、取消置顶并把窗口沉底（真实窗口浮在上层），
// 由渲染端按光标是否悬停在组件上（mousemove + elementFromPoint）实时切换鼠标穿透，
// 空区域点击穿透到真实桌面（可点文件夹/任务栏）。
// 注意：穿透需要透明窗口，而 transparent 只在窗口创建时生效——普通模式用原生不透明
// 窗口（系统圆角/阴影/对齐吸附），开启/关闭融合时销毁重建主窗口切换透明属性。
let desktopFusionEnabled = false
let desktopFusionSavedKiosk = false

ipcMain.handle('desktop-fusion:get-state', () => ({ enabled: desktopFusionEnabled }))

// 设置融合状态并重建窗口（透明↔不透明）。供渲染端关闭融合、以及应用启动时
// 从 localStorage 恢复融合态（此时主进程 desktopFusionEnabled 为 false）调用。
ipcMain.handle('desktop-fusion:set-enabled', async (_event, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false, canceled: false }
  const next = enabled === true
  if (next === desktopFusionEnabled) return { success: true, enabled: desktopFusionEnabled, recreated: false }
  desktopFusionEnabled = next
  try {
    if (next) {
      // 开启：记录 kiosk 记忆，重建为透明窗口（启动恢复路径，无需确认）
      desktopFusionSavedKiosk = mainWindow.isKiosk()
      const win = await recreateMainWindow(true)
      if (!win) { desktopFusionEnabled = false; return { success: false, canceled: false } }
      applyFusionWindowState(win)
    } else {
      // 关闭：重建回原生不透明窗口并恢复置顶/kiosk
      const win = await recreateMainWindow(false)
      if (!win) { desktopFusionEnabled = true; return { success: false, canceled: false } }
      restoreNativeWindowState(win)
    }
  } catch (error) {
    console.error('[桌面融合穿透] 切换失败:', error?.message || error)
  }
  return { success: true, enabled: desktopFusionEnabled, recreated: true }
})

// 开启穿透需重建窗口（会中断当前播放/重载界面），确认框由渲染端应用内弹窗完成
//（FusionEnableConfirmModal，与删除歌单弹窗同款样式），确认后经 set-enabled 重建。
// 此路径同样承担"应用启动时从 localStorage 恢复融合态"（此时主进程 desktopFusionEnabled
// 为 false，渲染端启动同步调用 set-enabled(true) 触发重建为透明窗口）。

// 渲染端报告「光标是否悬停在组件上」→ 切换鼠标穿透
ipcMain.on('desktop-fusion:set-interactive', (_event, interactive) => {
  if (!desktopFusionEnabled || !mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setIgnoreMouseEvents(!(interactive === true), { forward: true })
  } catch { /* 忽略 */ }
})


// IPC 处理：全屏控制
ipcMain.handle('window-set-fullscreen', (event, fullscreen, kiosk = false) => {
  console.log('[全屏控制] fullscreen=', fullscreen, ', kiosk=', kiosk)
  console.log('[全屏控制] 当前状态: isKiosk=', mainWindow?.isKiosk(), ', isFullScreen=', mainWindow?.isFullScreen(), ', isMaximized=', mainWindow?.isMaximized())
  
  if (mainWindow) {
    if (fullscreen) {
      // 记录进入前边界（kiosk 退出后 Electron 可能不恢复原位置/尺寸）
      if (!mainWindowExpanded) mainWindowNormalBounds = mainWindow.getBounds()
      if (kiosk) {
        // 全屏模式（kiosk=true）- 覆盖任务栏
        console.log('[全屏控制] 启用全屏模式（覆盖任务栏）')
        // 先退出其他模式
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize()
        }
        // 使用 setKiosk 来覆盖任务栏（Windows 上最可靠的方式）
        mainWindow.setKiosk(true)
      } else {
        // 全屏无边框模式（kiosk=false）- 保留任务栏
        console.log('[全屏控制] 启用全屏无边框模式（保留任务栏，使用最大化）')
        // 先退出其他模式
        if (mainWindow.isKiosk()) {
          mainWindow.setKiosk(false)
        }
        if (mainWindow.isFullScreen()) {
          mainWindow.setFullScreen(false)
        }
        // 使用最大化来保留任务栏
        mainWindow.maximize()
      }
      mainWindowExpanded = true
    } else {
      // 退出所有全屏模式（不依赖 isKiosk()/isFullScreen() 可能不可靠的查询，无条件恢复）
      console.log('[全屏控制] 退出全屏')
      restoreMainWindowFromExpanded()
      mainWindowExpanded = false
    }
    
    console.log(`[全屏控制] 执行后状态: isKiosk=${mainWindow.isKiosk()}, isFullScreen=${mainWindow.isFullScreen()}, isMaximized=${mainWindow.isMaximized()}`)
    // 向渲染端同步扩大态（kiosk 路径可能不触发 fullscreen 事件），刷新标题栏图标
    safeSendToWindow(mainWindow, 'window-fullscreen-change', mainWindowExpanded)
    persistMainWindowState() // 全屏/最大化切换后立即记忆
  }
})

// IPC 处理：获取全屏状态?
ipcMain.handle('window-is-fullscreen', () => {
  if (!mainWindow) return { fullscreen: false, kiosk: false, maximized: false, expanded: false }
  return {
    fullscreen: mainWindow.isFullScreen(),
    kiosk: mainWindow.isKiosk(),
    maximized: mainWindow.isMaximized(),
    expanded: mainWindowExpanded
  }
})

ipcMain.handle('get-system-location', async () => {
  try {
    return { success: true, ...(await getWindowsSystemLocation()) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
})

/**
 * 启动本地后端服务（仅打包版需要；开发模式由 scripts/dev-electron.mjs 负责）。
 * 1) Express API（local-server.mjs，端口 3001）——通过 utilityProcess.fork 启动，
 *    传入开发模式 API 进程会用到的同款缓存路径参数（app.getPath('userData')/cache）。
 * 2) Python 节拍服务（beat_analyzer.py，端口 3002）——优先使用嵌入式 python，
 *    启动失败仅告警（应用会自动降级到 Fixed Crossfade）。
 * 3) Python 响度测量服务（loudness_server.py，端口 3003）——响度归一化按曲目调用。
 * 4) Python 频响补偿设计服务（compensation_server.py，端口 3004）——等响度/预设/自定义 → 多段 Biquad。
 */
let localApiChild = null
let localPythonChild = null
let localLoudnessChild = null
let localCompensationChild = null

// ── 孤儿后端清扫：上次异常退出残留的子进程会占住后端端口，导致新实例误连旧后端 ──
// 必须在模块级声明：will-quit 与 AppleBridge 的 python 校验都在模块作用域调用，
// 放进 startLocalBackend 的 try 块内会因作用域不可见抛 ReferenceError（静默失效）。
// 18790 = Apple 播放面 bridge（apple_bridge.py）控制端口
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const BACKEND_PORTS = [3001, 3002, 3003, 3004, 18790]
async function sweepBackendOrphans(reason) {
  for (const port of BACKEND_PORTS) {
    try {
      const ps = [
        '$c = Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue',
        'foreach ($x in $c) {',
        '  $pp = Get-Process -Id $x.OwningProcess -ErrorAction SilentlyContinue',
        '  if ($pp -and ($pp.Path -like "*win-unpacked*" -or $pp.Path -like "*resources\\python-embed*" -or $pp.ProcessName -like "WaveForge*" -or $pp.ProcessName -like "python*")) { Write-Output $x.OwningProcess }',
        '}',
      ].join('; ')
      const out = await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 12000 })
      const pids = String(out.stdout || '').split(/[^0-9]+/).map(v => parseInt(v, 10)).filter(v => v > 0)
      for (const pid of pids) {
        try {
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000 })
          console.log('[LocalAPI] 清扫残留子进程 pid=' + pid + ' (port=' + port + ', reason=' + reason + ')')
        } catch { /* 已退出则忽略 */ }
      }
    } catch { /* 清扫失败不阻塞启动 */ }
  }
}

async function startLocalBackend() {
  if (!app.isPackaged) return // 开发模式由 dev-electron.mjs 启动
  if (process.env.WAVEFORGE_DISABLE_LOCAL_BACKEND === '1') return

  // 1) Express API（3001）
  try {
    await sweepBackendOrphans('startup')
    const serverEntry = path.join(process.resourcesPath, 'app.asar', 'local-server.mjs')
    localApiChild = utilityProcess.fork(serverEntry, [], {
      env: {
        ...process.env,
        WAVEFORGE_USERDATA: app.getPath('userData'),
      },
      stdio: 'pipe',
    })
    localApiChild.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.log('[LocalAPI]', text)
    })
    localApiChild.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) console.error('[LocalAPI:err]', text)
    })
    localApiChild.on('exit', (code) => {
      console.error('[LocalAPI] exited with code', code)
      localApiChild = null
    })
    console.log('[LocalAPI] starting local-server.mjs via utilityProcess')
  } catch (error) {
    console.error('[LocalAPI] failed to start:', error)
  }

  // 嵌入式 Python 可执行文件路径（节拍与响度服务共用）。
  // 必须声明在函数作用域：若放在节拍服务 try 块内，响度服务的 spawn 拿不到它，
  // 会抛 ReferenceError 导致响度服务在打包版从未启动。
  const pythonExe = path.join(process.resourcesPath, 'python-embed', 'python.exe')

  // 2) Python 节拍服务（3002）——仅当嵌入式 python 与脚本都存在时启动。
  // 缺少文件只跳过节拍服务（不再 return 整个函数，避免连带跳过响度服务）。
  try {
    const beatAnalyzer = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-beat-service', 'beat_analyzer.py')
    if (!fs.existsSync(pythonExe)) {
      console.warn('[BeatService] 未找到嵌入式 Python，跳过节拍服务（将使用 Fixed Crossfade 降级）')
    } else if (!fs.existsSync(beatAnalyzer)) {
      console.warn('[BeatService] 未找到 beat_analyzer.py，跳过节拍服务')
    } else {
      localPythonChild = spawn(pythonExe, [beatAnalyzer], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })
      localPythonChild.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.log('[BeatService]', text)
      })
      localPythonChild.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.error('[BeatService:err]', text)
      })
      // spawn 失败（如嵌入式 python 缺失/启动即退出）时避免 unhandled 'error' 事件
      localPythonChild.on('error', (error) => {
        console.error('[BeatService] failed to spawn:', error?.message || error)
        localPythonChild = null
      })
      localPythonChild.on('exit', (code) => {
        console.warn('[BeatService] exited with code', code)
        localPythonChild = null
      })
      console.log('[BeatService] starting beat_analyzer.py on port 3002')
    }
  } catch (error) {
    console.error('[BeatService] failed to start:', error)
  }

  // 3) Python 响度测量服务（3003）——独立于节拍服务，响度归一化按曲目调用
  try {
    const loudnessServer = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-beat-service', 'loudness_server.py')
    if (!fs.existsSync(pythonExe)) {
      console.warn('[LoudnessService] 未找到嵌入式 Python，跳过响度服务（响度归一化不可用）')
    } else if (!fs.existsSync(loudnessServer)) {
      console.warn('[LoudnessService] 未找到 loudness_server.py，跳过响度服务（响度归一化不可用）')
    } else {
      localLoudnessChild = spawn(pythonExe, [loudnessServer], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })
      localLoudnessChild.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.log('[LoudnessService]', text)
      })
      localLoudnessChild.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.error('[LoudnessService:err]', text)
      })
      // spawn 失败（如嵌入式 python 缺失/启动即退出）时避免 unhandled 'error' 事件
      localLoudnessChild.on('error', (error) => {
        console.error('[LoudnessService] failed to spawn:', error?.message || error)
        localLoudnessChild = null
      })
      localLoudnessChild.on('exit', (code) => {
        console.warn('[LoudnessService] exited with code', code)
        localLoudnessChild = null
      })
      console.log('[LoudnessService] starting loudness_server.py on port 3003')
    }
  } catch (error) {
    console.error('[LoudnessService] failed to start:', error)
  }

  // 4) Python 频响补偿设计服务（3004）——独立于节拍/响度服务，等响度/预设/自定义 → 多段 Biquad 参数
  try {
    const compensationServer = path.join(process.resourcesPath, 'app.asar.unpacked', 'python-beat-service', 'compensation_server.py')
    if (!fs.existsSync(pythonExe)) {
      console.warn('[CompensationService] 未找到嵌入式 Python，跳过频响补偿服务（频响补偿不可用）')
    } else if (!fs.existsSync(compensationServer)) {
      console.warn('[CompensationService] 未找到 compensation_server.py，跳过频响补偿服务（频响补偿不可用）')
    } else {
      localCompensationChild = spawn(pythonExe, [compensationServer], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      })
      localCompensationChild.stdout?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.log('[CompensationService]', text)
      })
      localCompensationChild.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim()
        if (text) console.error('[CompensationService:err]', text)
      })
      // spawn 失败（如嵌入式 python 缺失/启动即退出）时避免 unhandled 'error' 事件
      localCompensationChild.on('error', (error) => {
        console.error('[CompensationService] failed to spawn:', error?.message || error)
        localCompensationChild = null
      })
      localCompensationChild.on('exit', (code) => {
        console.warn('[CompensationService] exited with code', code)
        localCompensationChild = null
      })
      console.log('[CompensationService] starting compensation_server.py on port 3004')
    }
  } catch (error) {
    console.error('[CompensationService] failed to start:', error)
  }
}

// ── Apple 播放面（WebView2 bridge）子进程管理 ──
// apple_bridge.py 用 pywebview + WebView2 承载 music.apple.com，作为 Electron Browser CDM
// 原生 CENC 失败时的兼容兜底；渲染进程经带会话认证的 127.0.0.1 HTTP 接口控制播放。
let appleBridgeChild = null
let appleBridgeSessionToken = ''
const appleBridgePythonOkCache = new Map()
const APPLE_BRIDGE_PORT = 18790
// spawn 互斥：预热定时器与渲染端平台联动可能同一瞬间并发触发，双双通过 ping 检查会双开
// （Windows 允许端口重复绑定，两个 bridge 同时监听 18790，请求只进其中一个）
let appleBridgeSpawning = false

/** 探测 python 是否装有 pywebview（结果按 exe 路径缓存；Windows Store 占位符会自然失败） */
async function pythonHasPywebview(pythonExe) {
  if (appleBridgePythonOkCache.has(pythonExe)) return appleBridgePythonOkCache.get(pythonExe)
  let ok = false
  try {
    await execFileAsync(pythonExe, ['-c', 'import webview'], { timeout: 20000 })
    ok = true
  } catch { ok = false }
  appleBridgePythonOkCache.set(pythonExe, ok)
  return ok
}

/** 找可用的 Python：环境变量 → 嵌入式 → 常见系统安装位置 → PATH */
async function findAppleBridgePython() {
  const candidates = []
  if (process.env.WAVEFORGE_APPLE_BRIDGE_PYTHON) candidates.push(process.env.WAVEFORGE_APPLE_BRIDGE_PYTHON)
  candidates.push(app.isPackaged
    ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
    // dev 模式下 getAppPath() 是 desktop/，用 __dirname 回项目根
    : path.join(__dirname, '..', 'resources', 'python-embed', 'python.exe'))
  const localAppData = process.env.LOCALAPPDATA || ''
  try {
    for (const dir of fs.readdirSync(path.join(localAppData, 'Programs', 'Python'))) {
      candidates.push(path.join(localAppData, 'Programs', 'Python', dir, 'python.exe'))
    }
  } catch { /* 目录不存在 */ }
  for (const root of ['C:\\', 'D:\\']) {
    try {
      for (const dir of fs.readdirSync(root)) {
        if (/^python/i.test(dir)) candidates.push(path.join(root, dir, 'python.exe'))
      }
    } catch { /* 盘符不存在 */ }
  }
  candidates.push('python', 'python3') // PATH 兜底（import 校验排除占位符/无 pywebview 的）
  for (const exe of candidates) {
    if (!exe) continue
    if (exe !== 'python' && exe !== 'python3' && !fs.existsSync(exe)) continue
    if (await pythonHasPywebview(exe)) return exe
  }
  return null
}

async function pingAppleBridge(token = appleBridgeSessionToken) {
  if (!token) return false
  try {
    const res = await fetch(`http://127.0.0.1:${APPLE_BRIDGE_PORT}/ping`, {
      headers: { 'X-WaveForge-Bridge-Token': token },
      signal: AbortSignal.timeout(1500),
    })
    if (res.ok) {
      const d = await res.json()
      return Boolean(d && d.ok)
    }
  } catch { /* 未运行 */ }
  return false
}

/** 启动 Apple 播放面 bridge（幂等：已在跑返回当前会话；并发触发合并为一次 spawn） */
async function startAppleBridge() {
  if (await pingAppleBridge()) return { ok: true, token: appleBridgeSessionToken }
  if (appleBridgeChild && !appleBridgeChild.killed) return { ok: true, token: appleBridgeSessionToken }
  if (appleBridgeSpawning) {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 500))
      if (!appleBridgeSpawning) break
    }
    const ok = (await pingAppleBridge()) || Boolean(appleBridgeChild && !appleBridgeChild.killed)
    return ok ? { ok: true, token: appleBridgeSessionToken } : { ok: false }
  }
  appleBridgeSpawning = true
  try {
    const ok = await doStartAppleBridge()
    return ok ? { ok: true, token: appleBridgeSessionToken } : { ok: false }
  } finally {
    appleBridgeSpawning = false
  }
}

async function doStartAppleBridge() {
  const scriptPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'python-apple-bridge', 'apple_bridge.py')
    // dev 模式下 getAppPath() 是 main.cjs 所在目录（desktop/），必须用 __dirname 回项目根
    : path.join(__dirname, '..', 'python-apple-bridge', 'apple_bridge.py')
  if (!fs.existsSync(scriptPath)) {
    console.warn('[AppleBridge] 未找到 apple_bridge.py，跳过启动')
    return false
  }
  const pythonExe = await findAppleBridgePython()
  if (!pythonExe) {
    console.warn('[AppleBridge] 未找到装有 pywebview 的 Python，Apple 原生源不可用（走载体兜底）')
    return false
  }
  // WebView2 用户数据目录：持久化 music.apple.com 登录态（登录一次长期有效）
  const profileDir = path.join(app.getPath('userData'), 'apple-bridge-profile')
  try { fs.mkdirSync(profileDir, { recursive: true }) } catch { /* 忽略 */ }
  appleBridgeSessionToken = crypto.randomBytes(32).toString('base64url')
  const childEnv = {}
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PYTHONHOME', 'PYTHONPATH']) {
    if (process.env[key]) childEnv[key] = process.env[key]
  }
  childEnv.PYTHONIOENCODING = 'utf-8'
  childEnv.PYTHONUNBUFFERED = '1'
  const child = spawn(pythonExe, [scriptPath, String(APPLE_BRIDGE_PORT), '--profile', profileDir, '--token', appleBridgeSessionToken], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv,
  })
  appleBridgeChild = child
  child.stdout?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.log('[AppleBridge]', text)
  })
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk).trim()
    if (text) console.error('[AppleBridge:err]', text)
  })
  child.on('error', (error) => {
    console.error('[AppleBridge] failed to spawn:', error?.message || error)
    if (appleBridgeChild === child) {
      appleBridgeChild = null
      appleBridgeSessionToken = ''
    }
  })
  child.on('exit', (code) => {
    console.warn('[AppleBridge] exited with code', code)
    if (appleBridgeChild === child) {
      appleBridgeChild = null
      appleBridgeSessionToken = ''
    }
  })
  console.log('[AppleBridge] starting apple_bridge.py on port', APPLE_BRIDGE_PORT)
  return true
}

// 应用退出时一并结束本地子进程
app.on('will-quit', async () => {
  persistMainWindowState() // 关闭前做最终窗口状态保存（防抖定时器可能尚未触发）
  try { localApiChild?.kill() } catch {}
  await sweepBackendOrphans('quit')
  try { localPythonChild?.kill() } catch {}
  try { localLoudnessChild?.kill() } catch {}
  try { localCompensationChild?.kill() } catch {}
  try { appleBridgeChild?.kill() } catch {}
  if (stemRuntime) {
    try { stemRuntime.shutdown() } catch { /* optional runtime cleanup */ }
    stemRuntime = null
  }
  if (trackStemRuntime) {
    try { trackStemRuntime.shutdown() } catch { /* optional runtime cleanup */ }
    trackStemRuntime = null
  }
})

app.whenReady().then(async () => {
  logStartupTiming('Electron app ready')
  // 启动时应用上次「稍后」的待更新：拉起 updater 后立即退出，换完文件自动重启到新版本。
  // 返回 true 表示正在重启应用，跳过本窗口创建流程。
  try {
    const { applyPendingAtStartup } = require('./update-manager.cjs')
    if (applyPendingAtStartup()) return
  } catch (error) {
    console.error('⚠️ [更新] 启动应用待更新失败:', error instanceof Error ? error.message : error)
  }
  // GPU 状态诊断：区分"splash 未渲染出来"（GPU 合成器异常）与"未加载出来"（资源失败）。
  // 每次启动写入日志，便于排查 splash 黑/白屏问题。
  try {
    const gpuInfo = app.getGPUFeatureStatus()
    logStartupTiming(`GPU feature status: accelerated=${gpuInfo.gpu_compositing || '?'} webgl=${gpuInfo.webgl || '?'}`)
    // 软件合成（GPU 加速禁用）下，窗口内容层提交明显变慢（可达 2s+）。
    // 记录该状态，createWindow 据此动态延长 splash 最短可见时间，
    // 给内容层足够时间真正上屏，避免 splash 显示 1.2s 后就被关闭、用户只见深色底（≈黑）。
    gpuCompositingDisabled = gpuInfo.gpu_compositing === 'disabled_software' || gpuInfo.gpu_compositing === 'disabled'
  } catch (error) {
    logStartupTiming(`GPU feature status unavailable: ${error.message}`)
  }
  // Electron 默认不会自动放行渲染进程的定位权限。
  // 放行后，天气组件才能优先使用 Windows/Chromium 的设备定位，再回退到公网 IP。
  // media 权限：放行后渲染进程才能用 navigator.mediaDevices.enumerateDevices()
  // 列出真实的音频输出设备（设置-高级「音频输出设备」）。
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'geolocation' || permission === 'media')
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'geolocation' || permission === 'media')
  })
  session.defaultSession.setDevicePermissionHandler((details) => {
    // enumerateDevices 需要设备级授权才能返回带标签的真实设备列表
    const type = details?.deviceType || ''
    return type === 'audiooutput' || type === 'audio' || type === 'video' || details?.mediaType === 'audio'
  })

  // ── Apple 音源 CORS 放行（Cider 式原生音源所需）────────────────────────────
  // 渲染层 hls.js 直接请求 Apple 的 HLS 清单/分段/Widevine license，这些接口的
  // CORS 头固定允许的是 music.apple.com 源，本地渲染进程源会被浏览器拦下。
  // 这里对 Apple 域名响应统一重写 CORS 头为请求方源（并吞掉不友好的预检 4xx），
  // 只影响跨域响应头，不触碰请求内容。
  const APPLE_CORS_HOST_RE = /(^|\.)(apple\.com|itunes\.apple\.com|mzstatic\.com)$/i
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    try {
      const hostname = new URL(details.url).hostname
      if (!APPLE_CORS_HOST_RE.test(hostname)) return callback({})
      const requestOrigin = details.headers?.origin || '*'
      const originList = requestOrigin === '*' ? ['*'] : [requestOrigin]
      // 头部统一成小写（避免同名不同大小写头并存 → 双份 CORS 头导致校验失败）
      const headers = {}
      for (const key of Object.keys(details.responseHeaders || {})) {
        const lower = String(key).toLowerCase()
        const value = details.responseHeaders[key]
        if (lower === 'content-length' && details.method === 'OPTIONS') continue
        headers[lower] = value
      }
      const set = (name, value) => { headers[String(name).toLowerCase()] = Array.isArray(value) ? value : [value] }
      set('Access-Control-Allow-Origin', originList)
      set('Access-Control-Allow-Credentials', ['true'])
      set('Access-Control-Allow-Headers', ['Authorization, Content-Type, Media-User-Token, X-Apple-Music-User-Token, X-Apple-Renewal'])
      set('Access-Control-Allow-Methods', ['GET, HEAD, POST, OPTIONS, PUT, DELETE, PATCH'])
      // CORS 预检要求 2xx：Apple 部分接口对 OPTIONS 可能返回 4xx，统一改写成 204 放行
      if (details.method === 'OPTIONS' && (details.statusCode < 200 || details.statusCode >= 300)) {
        headers['content-length'] = ['0']
        return callback({ cancel: false, statusCode: 204, responseHeaders: headers })
      }
      return callback({ responseHeaders: headers })
    } catch (error) {
      console.error('[AppleCORS] 响应头重写失败:', error?.message || error)
      return callback({})
    }
  })

  // 初始化配置管理器
  configManager = new ConfigManager(app)
  const cachePath = configManager.getCachePath()
  console.log('📁 [Config] 缓存路径:', cachePath)
  loadRemoteSettings()
  
  // 创建缓存目录结构
  const requiredDirs = [
    cachePath,
    path.join(cachePath, 'temp'),           // 音频缓存
    path.join(cachePath, 'beat_analysis'),  // 节拍分析缓存
    path.join(cachePath, 'tracks'),         // 音轨缓存
    path.join(cachePath, 'transition-renders') // 过渡渲染
  ]
  
  requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      console.log('📁 [Config] 创建目录:', dir)
    }
  })
  
  // 启动本地后端 API 服务（端口 3001）与 Python 节拍服务（端口 3002）。
  // 开发模式下由 scripts/dev-electron.mjs 启动；打包版必须由主进程自行启动，
  // 否则渲染进程请求 localhost:3001 全部失败，应用只剩空壳 UI。
  startLocalBackend()
  
  // 传入缓存路径给 analysis runtime。
  // 延迟到 setImmediate 初始化：createAnalysisRuntime 内部 AudioDownloadService 构造时会
  // 同步读取并逐条 statSync 校验音频缓存索引，末尾还会同步 readdirSync 扫描全部缓存目录
  // 执行清理（缓存文件多时可达数十到数百毫秒）。这些工作与窗口显示无关，先创建 splash/
  // 主窗口与 loadFile 让界面尽早出现，再执行分析运行时初始化。渲染进程的 analysis:* /
  // audio-download:* IPC 只在用户实际操作（切歌分析/下载/清理缓存）时才调用，必然晚于
  // setImmediate 回调，因此 handler 注册顺序不受影响；启动失败也只会让分析功能降级，
  // 不影响窗口显示与后端服务。
  setImmediate(() => {
    analysisRuntime = createAnalysisRuntime(app, ipcMain, () => mainWindow, cachePath)
  })
  
  // Setup render runtime IPC handlers
  automixLog.init(app)

  // 渲染进程的 automix 事件（在调用后端之前就发生/退出的情况）也写进同一个日志文件
  ipcMain.handle('automix-log:append', (_event, scope, message) => {
    if (typeof scope !== 'string' || typeof message !== 'string') return true
    automixLog.log(`renderer:${scope}`, message.slice(0, 400))
    return true
  })

  setupRenderIPC(ipcMain, configManager.getCachePath(), toMediaUrl)
  try {
    const stemModels = require('./stem-model-manager.cjs')
    const { setupStemIPC } = require('./stem-runtime.cjs')
    const { setupTrackStemIPC } = require('./track-stem-runtime.cjs')
    stemModels.setupStemModelIPC(ipcMain)
    stemRuntime = setupStemIPC(ipcMain, {
      modelPath: stemModels.getModelPath(),
      pythonPath: stemModels.getRuntimePath(),
      isModelTrusted: stemModels.isModelTrusted,
      isRuntimeTrusted: stemModels.isRuntimeTrusted,
      modelsPath: stemModels.getModelRoot(),
      cachePath: path.join(configManager.getCachePath(), 'stem-renders'),
      ffmpegPath: process.env.WAVEFORGE_FFMPEG_PATH,
    })
    trackStemRuntime = setupTrackStemIPC(ipcMain, {
      modelPath: stemModels.getModelPath(),
      pythonPath: stemModels.getRuntimePath(),
      isModelTrusted: stemModels.isModelTrusted,
      isRuntimeTrusted: stemModels.isRuntimeTrusted,
      modelsPath: stemModels.getModelRoot(),
      cachePath: path.join(configManager.getCachePath(), 'track-stems'),
      ffmpegPath: process.env.WAVEFORGE_FFMPEG_PATH,
      decoderPythonPath: app.isPackaged
        ? path.join(process.resourcesPath, 'python-embed', 'python.exe')
        : path.join(__dirname, '..', 'resources', 'python-embed', 'python.exe'),
      isInputAllowed: inputPath => authorizedStemInputPaths.has(path.resolve(inputPath)),
    })
  } catch (error) {
    console.error('⚠️ [Stem Model] HTDemucs 模型/运行时初始化失败:', error instanceof Error ? error.message : error)
  }
  // AI 混音（DJTransGAN）运行时：严格可选；关闭时 renderer 不调用任何 Torch IPC
  setupAiMixIPC(ipcMain, configManager.getCachePath())
  // AI 混音模型（DJTransGAN 仓库 + 预训练权重）下载/删除管理：设置面板「下载模型」用
  try {
    const { setupAiModelIPC } = require('./ai-model-manager.cjs')
    setupAiModelIPC(ipcMain, (scope, message) => automixLog.log(scope, message))
  } catch (error) {
    console.error('⚠️ [AI Model] 模型下载管理器初始化失败:', error instanceof Error ? error.message : error)
  }
  // 代理自动配置：模型下载/应用更新走用户本地代理（设置 → 高级 → 代理自动配置）
  try {
    const { setupProxyIPC } = require('./proxy-manager.cjs')
    setupProxyIPC(ipcMain, (scope, message) => automixLog.log(scope, message))
  } catch (error) {
    console.error('⚠️ [Proxy] 代理管理器初始化失败:', error instanceof Error ? error.message : error)
  }

  // AirPlay 投送端：mDNS 设备发现 + RAOP/AirPlay2 会话管理（纯 JS，无原生依赖）
  try {
    airplayControllerHandle = setupAirplayIpc({ ipcMain, getMainWindow: () => mainWindow })
    console.log('🎵 [AirPlay] 投送端已启动（mDNS 设备发现中）')
  } catch (error) {
    console.error('🎵 [AirPlay] 启动失败:', error instanceof Error ? error.message : error)
  }
  // Razer Chroma：本地 REST 会话、设备探测与高频灯效帧。
  try {
    chromaControllerHandle = setupChromaIpc({ ipcMain, getMainWindow: () => mainWindow })
  } catch (error) {
    console.error('[Chroma] 初始化失败:', error instanceof Error ? error.message : error)
  }
  // SignalRGB：Effect 安装、Local API 与 Canvas Event 桥。
  try {
    signalRgbControllerHandle = setupSignalRgbIpc({ ipcMain, getMainWindow: () => mainWindow, shell })
  } catch (error) {
    console.error('[SignalRGB] 初始化失败:', error instanceof Error ? error.message : error)
  }
  ipcMain.handle('audio-output:is-supported', () => process.platform === 'win32' || process.platform === 'darwin')

  // Apple 播放面 bridge：渲染端点 Apple 歌曲时经此自动拉起（appleWebViewBridge.ensureBridgeRunning）
  ipcMain.handle('apple-bridge:spawn', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return { ok: false }
    try {
      return await startAppleBridge()
    } catch (error) {
      console.error('[AppleBridge] spawn failed:', error?.message || error)
      return false
    }
  })

  // Apple 播放面 bridge：渲染端节能联动主动关闭（离开 Apple 平台 5 分钟）
  ipcMain.handle('apple-bridge:stop', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false
    try {
      if (appleBridgeChild && !appleBridgeChild.killed) {
        appleBridgeChild.kill()
        console.log('[AppleBridge] bridge stopped by renderer (平台节能)')
      }
      return true
    } catch (error) {
      console.error('[AppleBridge] stop failed:', error?.message || error)
      return false
    }
  })

  app.on('will-quit', async () => {
    if (airplayControllerHandle) {
      try { airplayControllerHandle.dispose() } catch { /* 忽略 */ }
      airplayControllerHandle = null
    }
    if (chromaControllerHandle) {
      try { await chromaControllerHandle.dispose() } catch { /* 忽略 */ }
      chromaControllerHandle = null
    }
    if (signalRgbControllerHandle) {
      try { signalRgbControllerHandle.dispose() } catch { /* 忽略 */ }
      signalRgbControllerHandle = null
    }
  })
  
  // Setup audio download IPC handlers
  ipcMain.handle('audio-download:prepare', async (_event, urlOrPath, trackKey) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      throw new Error('Audio download service not initialized')
    }
    const result = await analysisRuntime.audioDownload.prepareAudioFile(urlOrPath, trackKey)
    authorizedStemInputPaths.add(path.resolve(result))
    // Keep the authorization set bounded; cached paths are re-authorized on each prepare call.
    if (authorizedStemInputPaths.size > 256) authorizedStemInputPaths.delete(authorizedStemInputPaths.values().next().value)
    const ext = String(result || '').split('.').pop()?.toLowerCase() || '?'
    automixLog.log('download', `trackKey=${trackKey} url=${String(urlOrPath).slice(0, 120)} -> ${result} (ext=${ext})`)
    return result
  })

  // 只读缓存命中检查（不触发下载）：看歌等场景优先用本地已缓存音轨（mv-align 已下载
  // 同一 DASH 音频），命中即秒开；未命中返回 null，调用方照旧走流式 URL。
  ipcMain.handle('audio-download:peekCached', (_event, trackKey) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      return null
    }
    return analysisRuntime.audioDownload.peekCached(trackKey)
  })

  // 把已下载的音频文件映射为渲染进程可 fetch 的 waveforge-media:// URL
  // （浏览器端 decodeAudioData 原生支持 m4a/aac——Python/librosa 侧 libsndfile 打不开）。
  // 仅允许下载缓存目录内的文件，与 render:getAudioUrl 同款路径校验。
  ipcMain.handle('audio-download:getMediaUrl', (_event, filePath) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload || !analysisRuntime.audioDownload.tempRoot) {
      throw new Error('Audio download service not initialized')
    }
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('Media file path is required')
    const resolved = path.resolve(filePath)
    const relative = path.relative(path.resolve(analysisRuntime.audioDownload.tempRoot), resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Media file path is outside the audio download cache')
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error('Media file does not exist')
    }
    const url = toMediaUrl(resolved)
    automixLog.log('media-url', resolved)
    return url
  })

  // 保存渲染进程转码后的 WAV（Chromium decodeAudioData → 16bit PCM），供 Python
  // 渲染/AI worker 读取（libsndfile 只认 wav/flac/ogg/mp3，m4a/aac/opus 必须转码）。
  // 已存在同 key 的 WAV 直接复用，同一首歌只转码一次。
  ipcMain.handle('audio-download:saveWav', (_event, trackKey, wavArrayBuffer) => {
    if (!analysisRuntime || !analysisRuntime.audioDownload || !analysisRuntime.audioDownload.tempRoot) {
      throw new Error('Audio download service not initialized')
    }
    if (typeof trackKey !== 'string' || !trackKey.trim() || trackKey.length > 256) {
      throw new Error('A non-empty track key is required')
    }
    const buf = Buffer.from(wavArrayBuffer || new ArrayBuffer(0))
    if (buf.length < 44 || buf.length > 512 * 1024 * 1024
      || buf.toString('ascii', 0, 4) !== 'RIFF'
      || buf.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Invalid WAV payload')
    }
    const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
    const safeName = `${trackKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100)}-${contentHash}.wav`
    const target = path.join(analysisRuntime.audioDownload.tempRoot, safeName)
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      automixLog.log('saveWav', `trackKey=${trackKey} 复用已有 ${target}`)
      return target
    }
    const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, buf)
      fs.renameSync(temp, target)
    } finally {
      try { fs.rmSync(temp, { force: true }) } catch {}
    }
    automixLog.log('saveWav', `trackKey=${trackKey} 写入 ${buf.length} bytes -> ${target}`)
    return target
  })
  
  ipcMain.handle('audio-download:cleanup', () => {
    authorizedStemInputPaths.clear()
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.cleanupOldFiles()
    }
    return { success: true }
  })
  
  ipcMain.handle('audio-download:get-stats', () => {
    if (!analysisRuntime || !analysisRuntime.audioDownload) {
      return { fileCount: 0, totalSize: 0, maxSize: 2 * 1024 * 1024 * 1024, cachePath: '' }
    }
    const stats = analysisRuntime.audioDownload.getCacheStats()
    const cachePath = path.join(configManager.getCachePath(), 'temp')
    return { ...stats, cachePath }
  })
  
  ipcMain.handle('audio-download:clear-cache', () => {
    authorizedStemInputPaths.clear()
    if (analysisRuntime && analysisRuntime.audioDownload) {
      analysisRuntime.audioDownload.cleanupAll()
      return { success: true }
    }
    return { success: false }
  })

  // 应用更新管理：后台静默下载 + 退出即应用 + 更新日志/版本历史。
  // 处理器集中在 update-manager.cjs（下载进度经 update:download-status 事件广播）。
  try {
    const { setupUpdateIPC } = require('./update-manager.cjs')
    setupUpdateIPC(ipcMain)
  } catch (error) {
    console.error('⚠️ [更新] 更新管理器初始化失败:', error instanceof Error ? error.message : error)
  }
  
  // 配置管理 IPC 处理器
  ipcMain.handle('config:get-cache-path', () => {
    return configManager.getCachePath()
  })

  // QQ 音乐官方 Skills Key 使用系统安全存储（Windows 上为 DPAPI）加密后再落盘。
  // 不写入项目配置、环境文件或日志。
  ipcMain.handle('credentials:get-qqmusic-skill-key', () => ({
    success: true,
    configured: Boolean(readQQMusicSkillKey()),
    key: readQQMusicSkillKey(),
    secure: safeStorage.isEncryptionAvailable()
  }))

  ipcMain.handle('credentials:set-qqmusic-skill-key', (_event, value) => {
    const key = String(value || '').trim()
    if (!/^qmk-[A-Za-z0-9._-]+$/.test(key)) {
      return { success: false, error: 'API Key 格式应为 qmk-…' }
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: '当前系统安全存储不可用，密钥不会被明文保存' }
    }
    try {
      const credentials = readSecureCredentials()
      credentials[QQMUSIC_SKILL_CREDENTIAL] = safeStorage.encryptString(key).toString('base64')
      writeSecureCredentials(credentials)
      return { success: true, configured: true, secure: true }
    } catch (error) {
      return { success: false, error: error.message || '保存 API Key 失败' }
    }
  })

  ipcMain.handle('credentials:delete-qqmusic-skill-key', () => {
    try {
      const credentials = readSecureCredentials()
      delete credentials[QQMUSIC_SKILL_CREDENTIAL]
      writeSecureCredentials(credentials)
      return { success: true, configured: false }
    } catch (error) {
      return { success: false, error: error.message || '删除 API Key 失败' }
    }
  })
  
  ipcMain.handle('config:set-cache-path', (event, newPath) => {
    try {
      // 验证路径是否有效
      if (typeof newPath !== 'string' || !newPath.trim() || !path.isAbsolute(newPath.trim())) {
        return { success: false, error: '路径必须是绝对路径' }
      }
      
      // 保存配置
      const success = configManager.setCachePath(newPath.trim())
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', newPath)
        console.log('⚠️ [Config] 需要重启应用以生效')
        return { success: true, needRestart: true }
      } else {
        return { success: false, error: '保存配置失败' }
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  })
  
  ipcMain.handle('config:select-cache-path', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
        title: '选择缓存存储路径',
        buttonLabel: '选择'
      })
      
      if (result.canceled || result.filePaths.length === 0) {
        return null
      }
      
      const selectedPath = result.filePaths[0]
      
      // 自动保存选择的路径
      const success = configManager.setCachePath(selectedPath)
      if (success) {
        console.log('📁 [Config] 缓存路径已更新:', selectedPath)
        return selectedPath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to select cache path:', error)
      return null
    }
  })
  
  ipcMain.handle('config:reset-cache-path', () => {
    try {
      const defaultCachePath = configManager.getDefaultCachePath()
      
      // 保存配置
      const success = configManager.setCachePath(defaultCachePath)
      if (success) {
        console.log('📁 [Config] 缓存路径已重置为默认值:', defaultCachePath)
        return defaultCachePath
      } else {
        throw new Error('保存配置失败')
      }
    } catch (error) {
      console.error('Failed to reset cache path:', error)
      throw error
    }
  })
  
  registerMediaProtocol()

  // 桌面播放器：读取上次的开关与形态设置
  const desktopPlayerSaved = loadDesktopPlayerSettings()
  desktopPlayerEnabled = desktopPlayerSaved.enabled
  desktopPlayerForm = desktopPlayerSaved.form
  desktopLyricsSettings = loadDesktopLyricsSettings()

  // castlabs ECS：先等 Widevine CDM 组件就绪再开窗口（首次会联网安装，失败不阻断——
  // AM 原生音源自动回退网易云/QQ 载体，其余功能不受影响）
  try {
    const { components } = require('electron')
    if (components && typeof components.whenReady === 'function') {
      await components.whenReady()
      let statusText = ''
      try { statusText = JSON.stringify(components.status ? components.status() : '') } catch { /* 忽略 */ }
      logStartupTiming(`[ECS] components ready: ${statusText}`)
    }
  } catch (error) {
    console.warn('[ECS] components 初始化失败（Widevine 可能未就绪，AM 原生将回退载体）:', error instanceof Error ? error.message : error)
  }

  // 若上次退出时开启了桌面播放器，等主窗口起来后再显示小窗口，避免抢占启动焦点
  setTimeout(() => {
    if (desktopPlayerEnabled) createDesktopPlayerWindow()
    if (desktopLyricsSettings.enabled) createDesktopLyricsWindow()
  }, 1500)
  logStartupTiming('Creating main and splash windows')
  createWindow()
  setGlobalMediaKeysEnabled(mediaKeysEnabled)
  updateTaskbar() // Windows 任务栏缩略图按钮与进度条初始化（渲染进程就绪后推送状态会再刷新）

  // WebView2 播放面不在启动阶段预热：正常 Apple CENC 播放不需要它；
  // 仅当 Electron L3/CENC 失败时由渲染端按需经 apple-bridge:spawn 拉起。
  // 全局高刷：若设置已开启，启动即应用（跟随所在显示器刷新率，最高 300Hz）
  applyHighRefreshRate()
  rebindHighRefreshRate()
  
  // 移除默认菜单栏
  if (mainWindow) {
    mainWindow.setMenu(null)
  }
  
  // 等待渲染进程加载完成后读取开发者模式设置
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      (() => {
        try {
          const saved = localStorage.getItem('developerMode');
          return saved !== null ? JSON.parse(saved) : false;
        } catch {
          return false;
        }
      })()
    `).then(enabled => {
      developerMode = enabled
      console.log(`🔧 [DevMode] 从设置中加载开发者模式 ${enabled ? '启用' : '禁用'}`)
    }).catch(() => {
      console.log('🔧 [DevMode] 无法读取开发者模式设置，使用默认值: 禁用')
    })
  })

  // 壁纸监控不再全局启动：由渲染端在「桌面模式 + 壁纸联动开启」时经 set-wallpaper-watcher 启停

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  Object.keys(mediaKeyAccelerators).forEach(accelerator => globalShortcut.unregister(accelerator))
  if (wallpaperWatcher) {
    clearInterval(wallpaperWatcher)
    wallpaperWatcher = null
  }
  // 销毁汽水签名引擎的隐藏验证窗（show:false、close 被 preventDefault→hide、无 parent）：
  // 不销毁会阻断 window-all-closed 与 app.quit()，进程残留且任务栏无入口可关
  try { require('./qishui-auth-v6.cjs').destroyForQuit() } catch { /* 未初始化无窗口可清 */ }
  // 停止遥控器局域网服务
  if (remoteServer) {
    remoteServer.stop()
    remoteServer = null
  }
  // Cleanup render runtime
  cleanupRender()
})

