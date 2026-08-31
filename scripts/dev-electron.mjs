import { spawn, execFile } from 'child_process'
import { build, createServer, preview } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import net from 'net'
import { randomBytes } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'

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
const viteConfigFile = resolve(projectRoot, 'vite.config.ts')
const distDir = resolve(projectRoot, 'dist')
const localServiceToken = process.env.WAVEFORGE_LOCAL_TOKEN || randomBytes(32).toString('base64url')
const localServiceEnv = { ...process.env, WAVEFORGE_LOCAL_TOKEN: localServiceToken }

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

/** 端口上是否真的是 local API server：请求其本地 JSON 端点，校验响应为 JSON */
async function isLocalApiServerHealthy() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch('http://127.0.0.1:3001/api/qq/cookie/status', { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const contentType = res.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) return false
    const body = await res.json()
    return body && typeof body === 'object'
  } catch {
    return false
  }
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

async function startDev() {
  logStartup('Development launcher started')
  let apiProcess = null
  let pythonProcess = null
  let loudnessProcess = null
  let compensationProcess = null

  // 响度测量服务（3003，独立于节拍服务）——响度归一化按曲目调用
  const startLoudness = async () => {
    if (await isPortOpen(3003)) {
      console.log('Loudness Service already running on http://localhost:3003')
      return null
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
      console.log('Compensation Service already running on http://localhost:3004')
      return null
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
      console.log('Python Beat Service already running on http://localhost:3002')
      return null
    }
    
    console.log('Starting Python Beat Service...')
    const pythonExe = resolve(__dirname, '../resources/python-embed/python.exe')
    const beatAnalyzer = resolve(__dirname, '../python-beat-service/beat_analyzer.py')
    
    const pythonProc = spawn(
      pythonExe,
      [beatAnalyzer],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...localServiceEnv,
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
      // 端口被占但响应不是 API 服务（典型：残留 vite dev server 返回 HTML）→ 清理后重启
      console.warn('Port 3001 is occupied but does not respond as the local API server; trying to reclaim it…')
      await freePortIfHijacked(3001, 'Local API Server')
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
    
    waitForPort(3001, 10000).then(success => {
      if (success) {
        console.log('Local API server started successfully on http://localhost:3001')
      } else {
        console.warn('Local API server did not open port 3001 within 10 seconds')
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
  const [python, api, loudness, compensation, server] = await Promise.all([
    startPython(),
    startAPI(),
    startLoudness(),
    startCompensation(),
    startRendererServer()
  ])
  
  pythonProcess = python
  apiProcess = api
  loudnessProcess = loudness
  compensationProcess = compensation
  
  logStartup('Backend launch tasks dispatched')
  const devServerUrl = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:3000/'
  console.log(`Electron loading ${devServerUrl}`)

  logStartup('Spawning Electron')
  const electronProcess = spawn(
    electron,
    [resolve(__dirname, '../desktop/main.cjs')],
    {
      stdio: 'inherit',
      env: {
        ...localServiceEnv,
        WAVEFORGE_DEV_SERVER_URL: devServerUrl,
        WAVEFORGE_STARTUP_LOG: startupLogFile,
        PYTHONIOENCODING: 'utf-8',
      },
    }
  )

  const cleanup = () => {
    server.close()

    if (apiProcess && !apiProcess.killed) {
      apiProcess.kill()
    }

    if (pythonProcess && !pythonProcess.killed) {
      pythonProcess.kill()
    }

    if (loudnessProcess && !loudnessProcess.killed) {
      loudnessProcess.kill()
    }

    if (compensationProcess && !compensationProcess.killed) {
      compensationProcess.kill()
    }
  }

  electronProcess.on('close', () => {
    cleanup()
    process.exit()
  })

  process.on('SIGINT', () => {
    cleanup()
    process.exit()
  })
}

startDev()
