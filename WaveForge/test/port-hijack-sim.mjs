// 模拟端口劫持场景：在 3001 上起一个返回 HTML 的假服务（模拟残留 vite），
// 再用与 dev-electron.mjs 相同的清理逻辑识别并终止它。
import { spawn, execFile } from 'child_process'
import http from 'http'
import net from 'net'

const projectRoot = process.cwd()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ps = (args) => new Promise(resolve => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ...args], { windowsHide: true, timeout: 6000 }, (error, stdout) => {
    if (error) return resolve(null)
    resolve(String(stdout || '').trim())
  })
})
const isPortOpen = (port) => new Promise(resolve => {
  const socket = net.connect({ port, host: 'localhost' })
  socket.once('connect', () => { socket.end(); resolve(true) })
  socket.once('error', () => resolve(false))
  socket.setTimeout(1000, () => { socket.destroy(); resolve(false) })
})
const getPidOnPort = async (port) => {
  const out = await ps([`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1`])
  const pid = Number((out || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}
const isWaveForgeDevLeftover = (cmdline) => {
  if (!cmdline || !cmdline.includes(projectRoot)) return false
  return /vite[\\/]bin[\\/]vite|local-server\.mjs|compensation_server\.py|beat_analyzer\.py|loudness_server\.py/.test(cmdline)
}

// 1) 起一个模拟残留 vite 的 HTML 服务（命令行伪装成本项目 vite）
const fakeCmd = `"node" "D:\\opencode\\WaveForge\\node_modules\\.bin\\..\\vite\\bin\\vite.js" --port=3000 --host=0.0.0.0`
const fake = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html')
  res.end('<!doctype html><html>fake vite</html>')
})
await new Promise(r => fake.listen(3001, '127.0.0.1', r))
console.log('fake HTML server listening on 3001 (simulating stale vite)')

// 2) 健康检查应当判假
const healthy = await fetch('http://127.0.0.1:3001/api/qq/cookie/status').then(r => {
  return r.ok && (r.headers.get('content-type') || '').includes('application/json')
}).catch(() => false)
console.log('health check against fake server (expect false):', healthy)

// 3) 清理逻辑：查到占用者 PID → 判定为残留 → 终止
const pid = await getPidOnPort(3001)
const cmdline = await ps([`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`])
console.log('occupier pid:', pid, '| isWaveForgeDevLeftover:', isWaveForgeDevLeftover(cmdline))
if (isWaveForgeDevLeftover(cmdline)) {
  await ps([`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`])
  for (let i = 0; i < 20 && await isPortOpen(3001); i++) await sleep(200)
}
console.log('port 3001 free after cleanup:', !(await isPortOpen(3001)))
fake.close()
process.exit(0)
