import { spawn } from 'child_process'
import { createServer } from 'vite'
import electron from 'electron'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'
import net from 'net'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

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

async function startDev() {
  let apiProcess = null
  let pythonProcess = null

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
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1'
        }
      }
    )
    
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
      console.log('Local API server already running on http://localhost:3001')
      return null
    }
    
    console.log('Starting Local API Server...')
    const apiProc = spawn(
      process.execPath,
      [resolve(__dirname, '../local-server.mjs')],
      { 
        stdio: ['ignore', 'inherit', 'inherit'],
        windowsHide: true,
        env: {
          ...process.env,
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

  const startVite = async () => {
    const server = await createServer({
      configFile: resolve(__dirname, '../vite.config.ts'),
    })
    await server.listen()
    server.printUrls()
    return server
  }

  // 并行启动所有服务
  const [python, api, server] = await Promise.all([
    startPython(),
    startAPI(),
    startVite()
  ])
  
  pythonProcess = python
  apiProcess = api
  
  const devServerUrl = server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:3000/'
  console.log(`Electron loading ${devServerUrl}`)

  const electronProcess = spawn(
    electron,
    [resolve(__dirname, '../desktop/main.cjs'), '--remote-debugging-port=9222'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        WAVEFORGE_DEV_SERVER_URL: devServerUrl,
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
