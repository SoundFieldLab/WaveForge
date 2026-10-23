import { spawn, execFile, spawnSync } from 'child_process'
import { build, createServer, preview } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { dirname, isAbsolute, resolve } from 'path'
import { homedir } from 'os'
import net from 'net'
import dns from 'node:dns'
import { randomBytes } from 'crypto'
import { appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { isCompatibleLocalApiHealth } from '../server/local-api-health.mjs'

// 当前 Windows 网络的 IPv6 路由可能不可达；外部音乐 CDN/API 优先走 IPv4。
dns.setDefaultResultOrder('ipv4first')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const launcherStartedAt = performance.now()
const startupLogDir = resolve(__dirname, '../logs')
const startupLogFile = resolve(startupLogDir, 'startup-timing.log')
mkdirSync(startupLogDir, { recursive: true })
writeFileSync(startupLogFile, '', 'utf8')
const logStartup = message => {
  const line = '[Startup +' + Math.round(performance.now() - launcherStartedAt) + 'ms] ' + message
  console.log(line)
  appendFileSync(startupLogFile, line + '\n', 'utf8')
}

const projectRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const { prepareWaveForgeUserData } = require('../desktop/user-data-profile.cjs')
const viteConfigFile = resolve(projectRoot, 'vite.config.ts')
const distDir = resolve(projectRoot, 'dist')

// 直接执行本脚本（快捷方式/IDE/`node scripts/dev-electron.mjs`）时 npm 不会运行
// predev:electron。这里再次确保 ECS production streaming VMP，避免原生 Apple CENC
// 因 development VMP 被 -1021 拒绝后误走 WebView2 兼容兜底。
const vmpCheck = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/ensure-dev-vmp.cjs')], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: process.env,
  windowsHide: true,
})
if (vmpCheck.status !== 0) {
  console.error('[EVS/VMP] 开发运行时校验失败，终止启动以避免静默退回非原生音源')
  process.exit(vmpCheck.status || 1)
}

const localServiceToken = process.env.WAVEFORGE_LOCAL_TOKEN || randomBytes(32).toString('base64url')
const appDataRoot = process.platform === 'win32'
  ? resolve(process.env.APPDATA || resolve(homedir(), 'AppData/Roaming'))
  : resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), '.config'))
const profilePreparation = prepareWaveForgeUserData({
  appDataRoot,
  isPackaged: false,
  overridePath: process.env.WAVEFORGE_USER_DATA,
  platform: process.platform,
})
const userDataRoot = profilePreparation.userDataPath
if (profilePreparation.status === 'migrated') {
  console.log(`[Profile] 已将旧 Electron 数据迁移到 ${userDataRoot}`)
} else if (profilePreparation.status === 'profile-active') {
  console.warn('[Profile] WaveForge profile 正在使用，迁移延期到相关进程退出后的下次启动')
}
let pythonCacheRoot = resolve(userDataRoot, 'cache')
try {
  // 与主进程 ConfigManager.loadConfig() 同源的两条规则，缺一即劈叉：
  // ① legacy 默认路径不算「显式自定义」：config.json 里残留的旧默认（userData cache、
  //    exe 目录 cache、项目根 cache）必须忽略，否则主进程把它当未自定义走便携默认
  //    （项目根 cache\），本文件却把它当自定义原样传给 beat/loudness 服务的允许根 →
  //    AudioCache 落在 D:\...\cache\temp，Python 白名单只认 C:\...\澜音工坊\cache →
  //    渲染层 POST /analyze 必撞 "audioPath must be inside the WaveForge cache" 400。
  //    （ConfigManager.getLegacyDefaultCachePaths(): userData cache、exe 目录 cache、项目根 cache）
  // ② 无显式配置时 dev 便携默认是**项目根 cache\**（可写探针通过）。
  const legacyDefaults = [
    resolve(userDataRoot, 'cache'),
    resolve(projectRoot, 'cache'),
  ].map(value => resolve(value))
  const configured = JSON.parse(readFileSync(resolve(userDataRoot, 'config.json'), 'utf8'))?.cachePath
  if (typeof configured === 'string' && isAbsolute(configured.trim())) {
    const resolvedConfigured = resolve(configured.trim())
    if (!legacyDefaults.includes(resolvedConfigured)) {
      pythonCacheRoot = resolvedConfigured
    } else {
      const portableCache = resolve(projectRoot, 'cache')
      mkdirSync(portableCache, { recursive: true })
      accessSync(portableCache, constants.W_OK)
      pythonCacheRoot = portableCache
    }
  } else {
    // 与主进程 ConfigManager.getDefaultCachePath() 同源：无显式配置时 dev 的便携默认
    // 是**项目根 cache\**（可写探针通过），不再是 <profile>\cache。不一致的话，主进程
    // AudioCache 把文件落在项目根 cache\temp，而 beat/loudness 服务的允许根还停在
    // <profile>\cache → "audioPath must be inside the WaveForge cache" 400
    // （首次启动必撞：config.json 此刻还没被主进程写入 cachePath）。
    const portableCache = resolve(projectRoot, 'cache')
    mkdirSync(portableCache, { recursive: true })
    accessSync(portableCache, constants.W_OK)
    pythonCacheRoot = portableCache
  }
} catch { /* Missing or invalid config / unwritable portable dir falls back to profile cache. */ }
mkdirSync(pythonCacheRoot, { recursive: true })
const localServiceEnv = {
  ...process.env,
  WAVEFORGE_LOCAL_TOKEN: localServiceToken,
  WAVEFORGE_CACHE_PATH: pythonCacheRoot,
  WAVEFORGE_PROJECT_ROOT: projectRoot,
  WAVEFORGE_USERDATA: userDataRoot,
}

function getNewestMtime(targetPath) {
  if (!existsSync(targetPath)) return 0
  const stats = statSync(targetPath)
  if (!stats.isDirectory()) return stats.mtimeMs

  let newest = stats.mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    newest = Math.max(newest, getNewestMtime(resolve(targetPath, entry.name)))
  }
  return newest
}

function isRendererBuildFresh() {
  const outputFiles = [
    resolve(distDir, 'index.html'),
    resolve(distDir, 'desktop-player.html'),
    resolve(distDir, 'desktop-lyrics.html'),
  ]
  if (outputFiles.some(outputFile => !existsSync(outputFile))) return false

  const rendererInputs = [
    resolve(projectRoot, 'src'),
    viteConfigFile,
    resolve(projectRoot, 'package.json'),
    resolve(projectRoot, 'package-lock.json'),
    ...readdirSync(projectRoot)
      .filter(file => file.endsWith('.html'))
      .map(file => resolve(projectRoot, file)),
  ]
  const newestInput = Math.max(...rendererInputs.map(getNewestMtime))
  const oldestOutput = Math.min(...outputFiles.map(outputFile => statSync(outputFile).mtimeMs))
  return oldestOutput >= newestInput
}

async function ensureRendererBuild() {
  if (isRendererBuildFresh()) {
    logStartup('Using cached renderer build')
    return
  }

  logStartup('Renderer sources changed; refreshing cached build')
  await build({ configFile: viteConfigFile })
  logStartup('Renderer build cache refreshed')
}

function isPortOpen(port, host = 'localhost') {
  return new Promise(resolve => {
    const socket = net.connect({ port, host })

    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })

    socket.once('error', () => resolve(false))

    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 10000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await isPortOpen(port)) {
      return true
    }

    await new Promise(resolve => setTimeout(resolve, 250))
  }

  return false
}

// ---- 端口占用识别与残留进程清理 ----------------------------------------
// 端口被占用不等于服务可用：之前有残留的 vite dev server（他人/其他会话 `npm run dev`
// 留下、或本启动器崩溃后的孤儿）抢占 3001，导致 local API server 起不来，
// 渲染端所有 /api/* 请求打到 Vite 上返回 HTML → 登录/扫码/账号信息全部失败。
// 这里先 HTTP 验证端口上是否真是 API 服务，再决定是否需要清理。
const ps = (args, opts = {}) => new Promise(resolve => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 6000, ...opts }, (error, stdout) => {
    if (error) return resolve(null)
    resolve(String(stdout || '').trim())
  })
})

/** 端口上是否为本次开发会话可复用的 local API server。 */
async function isLocalApiServerHealthy() {
  let timer
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch('http://127.0.0.1:3001/health', {
      headers: { 'X-WaveForge-Local-Token': localServiceToken },
      signal: controller.signal,
    })
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) return false
    const body = await res.json()
    return isCompatibleLocalApiHealth(body)
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForLocalApi(timeoutMs = 10000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isLocalApiServerHealthy()) return true
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

/** 3002/3003/3004 通用健康检查：/health 返回 JSON 且带 service 字段才算本族服务。
 *  任何无关进程占着端口时 isPortOpen 恒真，此前会被当成"服务已运行"复用，
 *  渲染端请求全部打到错误服务上（与 3001 的 isLocalApiServerHealthy 同理）。 */
async function isPythonServiceHealthy(port, expectedService) {
  let timer
  try {
    const controller = new AbortController()
    timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) return false
    const body = await res.json()
    return String(body?.service || '') === expectedService
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function createStaleLocalApiError() {
  const pid = await getPidOnPort(3001)
  const pidText = pid ? `（PID ${pid}）` : ''
  return new Error([
    '',
    '============================================================',
    `检测到 3001 端口上存在旧的或其他会话的 WaveForge 后端${pidText}。`,
    '为避免当前调试界面连接到错误的登录会话，本次启动已停止。',
    '请先清理该残留后端，再重新运行 npm run dev:electron。',
    '启动器没有自动终止该进程，也没有读取或输出任何登录凭据。',
    '============================================================',
  ].join('\n'))
}

/** 监听指定端口的 PID（仅 State=Listen 的进程） */
async function getPidOnPort(port) {
  const out = await ps([`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1`])
  const pid = Number((out || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 进程命令行是否为「本项目残留的 dev 进程」（vite dev server / local-server / python 服务） */
function isWaveForgeDevLeftover(commandLine) {
  if (!commandLine) return false
  // 统一为正斜杠比较，避免 Windows 命令行的反斜杠/正斜杠混用误判
  const normalized = commandLine.replace(/[\\/]+/g, '/')
  const root = projectRoot.replace(/[\\/]+/g, '/')
  if (!normalized.includes(root)) return false
  return /vite\/bin\/vite|local-server\.mjs|compensation_server\.py|beat_analyzer\.py|loudness_server\.py|apple_bridge\.py/.test(normalized)
}

async function killProcess(pid) {
  await ps([`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`])
}

/**
 * 若端口被非 API 服务的残留 dev 进程占用，精确清理后返回 true；
 * 占用者不是本项目残留进程（可能是其他应用）则返回 false 并提示。
 */
async function freePortIfHijacked(port, serviceName) {
  const pid = await getPidOnPort(port)
  if (!pid) return true // 端口已空闲，无需处理

  const cmdline = await ps([`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])
  if (isWaveForgeDevLeftover(cmdline)) {
    console.warn(`[dev] 端口 ${port} 被残留的 WaveForge dev 进程(PID ${pid})占用，正在清理…`)
    await killProcess(pid)
    // 等端口真正释放
    for (let i = 0; i < 20; i++) {
      if (!(await isPortOpen(port))) return true
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return true
  }
  console.error(`[dev] 端口 ${port} 被其他进程(PID ${pid})占用，无法启动 ${serviceName}。请手动关闭占用该端口的程序后重试。`)
  return false
}

async function launchDev() {
  logStartup('Development launcher started')
  let apiProcess = null
  let pythonProcess = null
  let loudnessProcess = null
  let compensationProcess = null

  /** 统一清场：杀掉本轮已成功拉起的后端子进程（Promise.all 失败路径与正常退出共用） */
  const stopStartedBackends = () => {
    if (apiProcess && !apiProcess.killed) apiProcess.kill()
    if (pythonProcess && !pythonProcess.killed) pythonProcess.kill()
    if (loudnessProcess && !loudnessProcess.killed) loudnessProcess.kill()
    if (compensationProcess && !compensationProcess.killed) compensationProcess.kill()
  }

  // 响度测量服务（3003，独立于节拍服务）——响度归一化按曲目调用
  const startLoudness = async () => {
    if (await isPortOpen(3003)) {
      if (await isPythonServiceHealthy(3003, 'loudness')) {
        console.log('Loudness Service already running on http://localhost:3003')
        return null
      }
      console.warn('[LoudnessService] 端口 3003 被其他进程占用（非响度服务），无法启动。请手动关闭占用该端口的程序后重试。')
      throw new Error('端口 3003 被非 WaveForge 响度服务的进程占用')
    }
    console.log('Starting Loudness Service...')
    const pythonExe = resolve(__dirname, '../resources/python-embed/python.exe')
    const loudnessServer = resolve(__dirname, '../python-beat-service/loudness_server.py')
    const loudnessProc = spawn(
      pythonExe,
      [loudnessServer],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: { ...localServiceEnv, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      }
    )
    // spawn 失败（嵌入式 python 缺失等）时避免未捕获的 'error' 事件崩掉启动器
    loudnessProc.on('error', (error) => {
      console.error(`[LoudnessService] spawn 失败: ${error?.message || error}`)
    })
    waitForPort(3003, 15000).then(success => {
      if (success) {
        console.log('Loudness Service started successfully on http://localhost:3003')
      } else {
        console.warn('Loudness Service did not open port 3003 within 15 seconds')
      }
    })
    return loudnessProc
  }

  // 频响补偿设计服务（3004，独立于节拍/响度服务）——ISO 226 等响度/预设/自定义 → 多段 Biquad 参数
  const startCompensation = async () => {
    if (await isPortOpen(3004)) {
      if (await isPythonServiceHealthy(3004, 'compensation')) {
        console.log('Compensation Service already running on http://localhost:3004')
        return null
      }
      console.warn('[CompensationService] 端口 3004 被其他进程占用（非频响补偿服务），无法启动。')
      throw new Error('端口 3004 被非 WaveForge 频响补偿服务的进程占用')
    }
    console.log('[CompensationService] starting compensation_server.py on port 3004')
    const pythonExe = resolve(__dirname, '../resources/python-embed/python.exe')
    const compensationServer = resolve(__dirname, '../python-beat-service/compensation_server.py')
    const compensationProc = spawn(
      pythonExe,
      [compensationServer],
      {
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: { ...localServiceEnv, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
      }
    )
    // spawn 失败（嵌入式 python 缺失等）时避免未捕获的 'error' 事件崩掉启动器
    compensationProc.on('error', (error) => {
      console.error(`[CompensationService] spawn 失败: ${error?.message || error}`)
    })
    waitForPort(3004, 15000).then(success => {
      if (success) {
        console.log('Compensation Service started successfully on http://localhost:3004')
      } else {
        console.warn('Compensation Service did not open port 3004 within 15 seconds')
      }
    })
    return compensationProc
  }

  // 并行启动所有服务
  const startPython = async () => {
    if (await isPortOpen(3002)) {
      if (await isPythonServiceHealthy(3002, 'beat_this')) {
        console.log('Python Beat Service already running on http://localhost:3002')
        return null
      }
      console.warn('[BeatService] 端口 3002 被其他进程占用（非节拍服务），无法启动。')
      throw new Error('端口 3002 被非 WaveForge 节拍服务的进程占用')
    }
    
    console.log('Starting Python Beat Service...')
    const pythonExe = resolve(__dirname, '../resources/python-embed/python.exe')
    const beatAnalyzer = resolve(__dirname, '../python-beat-service/beat_analyzer.py')
    const beatModel = resolve(__dirname, '../resources/beat-this/final0.ckpt')
    if (!existsSync(beatModel)) throw new Error(`Required Beat This model missing: ${beatModel}`)
    
    const pythonProc = spawn(
      pythonExe,
      [beatAnalyzer],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...localServiceEnv,
          BEAT_THIS_CHECKPOINT: beatModel,
          WAVEFORGE_BEAT_MODEL_PATH: beatModel,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        }
      }
    )
    // spawn 失败（嵌入式 python 缺失等）时避免未捕获的 'error' 事件崩掉启动器
    pythonProc.on('error', (error) => {
      console.error(`[BeatService] spawn 失败: ${error?.message || error}`)
    })

    // 后台等待，不阻塞主流程
    waitForPort(3002, 15000).then(success => {
      if (success) {
        console.log('Python Beat Service started successfully on http://localhost:3002')
      } else {
        console.warn('Python Beat Service did not open port 3002 within 15 seconds')
      }
    })
    
    return pythonProc
  }

  const startAPI = async () => {
    if (await isPortOpen(3001)) {
      if (await isLocalApiServerHealthy()) {
        console.log('Local API server already running on http://localhost:3001')
        return null
      }
      throw await createStaleLocalApiError()
    }

    console.log('Starting Local API Server...')
    const apiProc = spawn(
      process.execPath,
      [resolve(__dirname, '../local-server.mjs')],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...localServiceEnv,
          FORCE_COLOR: '1'
        }
      }
    )
    
    waitForLocalApi(10000).then(success => {
      if (success) {
        console.log('Local API server started successfully on http://localhost:3001')
      } else {
        console.warn('Local API server did not become ready on port 3001 within 10 seconds')
      }
    })
    
    return apiProc
  }

  const startRendererServer = async () => {
    const useLiveRenderer = process.env.WAVEFORGE_LIVE_UI === '1'

    // 3000 是渲染服务专用端口：被残留的 vite dev server 占用会因 strictPort 直接失败
    if (await isPortOpen(3000)) {
      await freePortIfHijacked(3000, 'renderer server')
    }

    if (useLiveRenderer) {
      logStartup('Creating live Vite renderer server')
      const server = await createServer({
        configFile: viteConfigFile,
        server: {
          host: '127.0.0.1',
          port: 3000,
          strictPort: true,
        },
      })
      await server.listen()
      logStartup('Live Vite renderer server is listening')
      server.printUrls()
      return server
    }

    await ensureRendererBuild()
    logStartup('Creating cached renderer server')
    const server = await preview({
      configFile: viteConfigFile,
      preview: {
        host: '127.0.0.1',
        port: 3000,
        strictPort: true,
      },
    })
    logStartup('Cached renderer server is listening')
    server.printUrls()
    return server
  }

  // Start backends and the renderer in parallel. The cached production renderer is
  // the default fast path; set WAVEFORGE_LIVE_UI=1 to restore full Vite HMR.
  // 先完成 3001 预检，避免旧会话存在时仍启动其余服务并遗留更多进程。
  const api = await startAPI()
  apiProcess = api
  // Promise.all 一项失败（典型：3000 被占用导致 startRendererServer 内 vite strictPort
  // 抛错）会让其余已成功拉起的 Python 服务成为孤儿。失败路径必须先清场再退出。
  let python, loudness, compensation, server
  try {
    ;[python, loudness, compensation, server] = await Promise.all([
      startPython(),
      startLoudness(),
      startCompensation(),
      startRendererServer()
    ])
  } catch (error) {
    stopStartedBackends()
    throw error
  }

  pythonProcess = python
  apiProcess = api
  loudnessProcess = loudness
  compensationProcess = compensation

  logStartup('Backend launch tasks dispatched')
  const devServerUrl = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:3000/'
  console.log(`Electron loading ${devServerUrl}`)

  logStartup('Spawning Electron')
  // dev 默认开放 CDP 调试端口（9223），便于自动化工具连接渲染进程排查；
  // 设 WAVEFORGE_REMOTE_DEBUG_PORT='' 可关闭，或设其他值换端口。
  const remoteDebugPort = process.env.WAVEFORGE_REMOTE_DEBUG_PORT === undefined ? '9223' : process.env.WAVEFORGE_REMOTE_DEBUG_PORT
  const electronArgs = [
    ...(remoteDebugPort ? [`--remote-debugging-port=${remoteDebugPort}`] : []),
    resolve(__dirname, '../desktop/main.cjs'),
  ]
  const electronProcess = spawn(
    electron,
    electronArgs,
    {
      stdio: 'inherit',
      env: {
        ...localServiceEnv,
        WAVEFORGE_USER_DATA: userDataRoot,
        WAVEFORGE_DEV_SERVER_URL: devServerUrl,
        WAVEFORGE_STARTUP_LOG: startupLogFile,
        PYTHONIOENCODING: 'utf-8',
      },
    }
  )

  const cleanup = () => {
    server.close()
    stopStartedBackends()
  }

  electronProcess.on('close', code => {
    cleanup()
    process.exit(typeof code === 'number' ? code : 1)
  })

  process.on('SIGINT', () => {
    cleanup()
    process.exit()
  })
}

async function startDev() {
  try {
    await launchDev()
  } catch (error) {
    console.error('启动失败:', error?.message || error)
    process.exitCode = 1
  }
}

startDev().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
