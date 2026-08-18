import { spawn } from 'child_process'
import { appendFileSync, closeSync, mkdirSync, openSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const projectDir = resolve(__dirname, '..')
const devScript = resolve(__dirname, 'dev-electron.mjs')
const logDir = resolve(projectDir, 'logs')
const logFile = resolve(logDir, 'waveforge-debug.log')

mkdirSync(logDir, { recursive: true })
appendFileSync(logFile, `\n===== WaveForge debug session ${new Date().toISOString()} =====\n`, 'utf8')
const logFd = openSync(logFile, 'a')

const child = spawn(process.execPath, [devScript], {
  cwd: projectDir,
  windowsHide: true,
  stdio: ['ignore', logFd, logFd],
  env: {
    ...process.env,
    WAVEFORGE_DEBUG_LOG: '1',
  },
})

let closed = false
const finish = (code = 0) => {
  if (!closed) {
    closed = true
    closeSync(logFd)
  }
  process.exit(code)
}

child.on('error', error => {
  appendFileSync(logFile, `[debug-launcher] ${error.stack || error.message}\n`, 'utf8')
  finish(1)
})
child.on('exit', code => finish(code ?? 1))

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}