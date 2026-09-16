/**
 * DG-LAB 最小化调试后端。
 *
 * 设计原则：**不复制插件逻辑，只换宿主**。
 * 中继/映射引擎直接 require 主仓库的 server/dglab-relay.cjs（同一份代码），
 * 因此这里调通的波形，就是主程序里跑的波形；不会出现「调试桩与真机不一致」。
 *
 * 端口刻意与主程序错开，可与 WaveForge 同时运行、互不干扰：
 *   调试前端  3100（vite dev）
 *   调试 API  3101（本文件）
 *   调试中继  31082（WS，虚拟/真机设备接入）
 *
 * 与主程序的唯一差别：默认端口写死 31082、默认开开发者详细日志、附带虚拟设备。
 */

const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const express = require('express')

const { createDGLabRelay } = require('../../server/dglab-relay.cjs')
const { createVirtualDevice } = require('./virtual-device.cjs')

const API_PORT = Number(process.env.DGLAB_DEBUG_API_PORT) || 3101
const RELAY_PORT = Number(process.env.DGLAB_DEBUG_RELAY_PORT) || 31082
const FRONTEND_ORIGINS = [
  'http://127.0.0.1:3100',
  'http://localhost:3100',
]

/** 测试音乐目录：环境变量优先，其次用户音乐库，最后仓库内可选目录。 */
function resolveMusicDirs() {
  const dirs = []
  if (process.env.DGLAB_DEBUG_MUSIC_DIR) dirs.push(process.env.DGLAB_DEBUG_MUSIC_DIR)
  dirs.push(path.join(os.homedir(), 'Music'))
  dirs.push(path.join(__dirname, '..', 'music'))
  return dirs.filter(d => {
    try { return fs.statSync(d).isDirectory() } catch { return false }
  })
}

const AUDIO_EXT = new Set(['.ogg', '.mp3', '.flac', '.wav', '.m4a', '.aac', '.opus'])

function listMusic() {
  const tracks = []
  for (const dir of resolveMusicDirs()) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!AUDIO_EXT.has(ext)) continue
      const full = path.join(dir, entry.name)
      let size = 0
      try { size = fs.statSync(full).size } catch { continue }
      tracks.push({
        // id = 绝对路径的 base64url，避免暴露路径字符问题，也便于流式路由反查
        id: Buffer.from(full, 'utf8').toString('base64url'),
        name: path.basename(entry.name, ext),
        file: entry.name,
        ext,
        size,
        dir,
      })
    }
  }
  return tracks.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
}

function resolveTrack(id) {
  let full = ''
  try {
    full = Buffer.from(String(id), 'base64url').toString('utf8')
  } catch {
    return null
  }
  const resolved = path.resolve(full)
  // 只允许流式读取已登记的目录，避免任意文件读取
  const allowed = resolveMusicDirs().some(dir => {
    const root = path.resolve(dir)
    return resolved === root || resolved.startsWith(root + path.sep)
  })
  if (!allowed) return null
  if (!AUDIO_EXT.has(path.extname(resolved).toLowerCase())) return null
  try {
    if (!fs.statSync(resolved).isFile()) return null
  } catch {
    return null
  }
  return resolved
}

/* ---------------------------------- 中继 ---------------------------------- */

const relay = createDGLabRelay()
// 调试默认值：错开端口 + 详细日志（都只作用于本次调试进程）
relay._internal.settings.port = RELAY_PORT
relay._internal.settings.devMode = true
relay._internal.settings.version = process.env.DGLAB_DEBUG_VERSION === 'v4' ? 'v4' : 'v3'

const relayLogs = []
const MAX_RELAY_LOGS = 400

const app = express()
app.use(express.json({ limit: '4mb' }))

app.use((req, res, next) => {
  const origin = req.headers.origin
  if (origin && FRONTEND_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  // 中继自身的日志也回流到调试前端（便于在页面上直接看引擎日志）
  next()
})

// 真实中继的 HTTP 路由（/api/dglab/status | /control | /qr）
relay.registerHttp(app)

/* ---------------------------------- 虚拟设备 ---------------------------------- */

let device = null

function ensureVirtualDevice() {
  const version = relay._internal.settings.version
  // 切换 V3/V4 后旧设备仍连着旧协议：丢弃并按新协议重建，避免连不上还以为引擎坏了。
  if (device && device.getState().version !== version) {
    try { device.disconnect() } catch { /* ignore */ }
    device = null
  }
  if (device) return device
  device = createVirtualDevice({
    port: RELAY_PORT,
    version,
    getClientId: () => relay._internal.clientId,
    log: () => {},
  })
  return device
}

/* ---------------------------------- 调试 API ---------------------------------- */

/**
 * 引擎内部状态有两处来源，必须合并读取：
 *   relay._internal.engine —— 运行标志（running / seenAudio / lastAudioAt / requested）
 *   relay._engine          —— 映射电平（A/B 目标与当前、AGC、乐速、占空、包络、ramp）
 * 只读其中一处会得到 undefined（例如把 A/B 当成 _internal.engine.A）。
 */
function readEngine() {
  const run = relay._internal.engine
  const level = relay._engine
  return {
    running: Boolean(run.running),
    seenAudio: Boolean(run.seenAudio),
    requested: Boolean(run.requested),
    lastAudioAt: Number(run.lastAudioAt) || 0,
    paused: Boolean(level.paused),
    outputOn: Boolean(level.outputOn),
    // 电平：目标 / 当前（0-200）
    A: { target: Number(level.A?.target) || 0, current: Number(level.A?.current) || 0 },
    B: { target: Number(level.B?.target) || 0, current: Number(level.B?.current) || 0 },
    speed: Number(level.speed) || 0,
    agc: Number(level.agc) || 0,
    energyEnv: Number(level.energyEnv) || 0,
    dutyOn: Number(level.dutyOn) || 0,
    ramp: level.ramp ? { duration: level.ramp.duration } : null,
  }
}

app.get('/api/debug/state', (req, res) => {
  const status = relay.getStatus()
  res.json({
    ok: true,
    ports: { api: API_PORT, relay: RELAY_PORT, frontend: 3100 },
    relay: {
      running: status.running,
      state: status.state,
      version: status.version,
      port: status.port,
      bound: status.bound,
      deviceName: status.deviceName,
      softLimit: status.softLimit,
      deviceStrength: status.deviceStrength,
      clientId: relay._internal.clientId,
      devMode: relay._internal.settings.devMode,
      feelStyle: relay._internal.settings.feelStyle,
      settings: relay._internal.settings,
    },
    engine: readEngine(),
    device: device ? device.getState() : null,
    musicDirs: resolveMusicDirs(),
  })
})

app.post('/api/debug/device/connect', (req, res) => {
  const d = ensureVirtualDevice()
  res.json({ ok: true, result: d.connect(), device: d.getState() })
})

app.post('/api/debug/device/disconnect', (req, res) => {
  if (!device) {
    res.json({ ok: true, result: { ok: true }, device: null })
    return
  }
  res.json({ ok: true, result: device.disconnect(), device: device.getState() })
})

app.post('/api/debug/device/clear', (req, res) => {
  res.json(device ? device.clear() : { ok: true })
})

app.post('/api/debug/device/limit', (req, res) => {
  const d = ensureVirtualDevice()
  const body = req.body || {}
  res.json({ ok: true, ...d.setReportedLimit(body), device: d.getState() })
})

app.get('/api/debug/events', (req, res) => {
  const since = Number(req.query.since) || 0
  const d = device
  res.json({
    ok: true,
    since,
    seq: d ? d.getState().seq : 0,
    events: d ? d.getEvents(since) : [],
    // 脉冲单独给：前端要按帧画「设备真实波形」
    pulses: d ? d.getPulses(Math.max(0, since - 50)) : [],
    device: d ? d.getState() : null,
    engine: readEngine(),
  })
})

app.get('/api/debug/logs', (req, res) => {
  res.json({ ok: true, lines: relayLogs.slice(-MAX_RELAY_LOGS) })
})

/* ---------------------------------- 音乐流 ---------------------------------- */

app.get('/api/debug/music', (req, res) => {
  res.json({ ok: true, tracks: listMusic(), dirs: resolveMusicDirs() })
})

app.get('/api/debug/music/:id', (req, res) => {
  const file = resolveTrack(req.params.id)
  if (!file) {
    res.status(404).json({ ok: false, error: 'track_not_found' })
    return
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    res.status(404).json({ ok: false, error: 'stat_failed' })
    return
  }
  const ext = path.extname(file).toLowerCase()
  const mime = ext === '.ogg' || ext === '.opus' ? 'audio/ogg'
    : ext === '.mp3' ? 'audio/mpeg'
      : ext === '.flac' ? 'audio/flac'
        : ext === '.wav' ? 'audio/wav'
          : ext === '.m4a' ? 'audio/mp4'
            : 'application/octet-stream'
  res.setHeader('Content-Type', mime)
  res.setHeader('Accept-Ranges', 'bytes')

  // Range 支持：播放器拖动进度/循环依赖它，缺了会整段重下或无法 seek。
  const range = req.headers.range
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match && match[1] ? Number(match[1]) : 0
    const end = match && match[2] ? Number(match[2]) : stat.size - 1
    if (Number.isNaN(start) || start >= stat.size) {
      res.status(416).setHeader('Content-Range', `bytes */${stat.size}`).end()
      return
    }
    const safeEnd = Math.min(end, stat.size - 1)
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${stat.size}`)
    res.setHeader('Content-Length', String(safeEnd - start + 1))
    fs.createReadStream(file, { start, end: safeEnd }).pipe(res)
    return
  }

  res.setHeader('Content-Length', String(stat.size))
  fs.createReadStream(file).pipe(res)
})

/* ---------------------------------- 启动 ---------------------------------- */

// 订阅中继日志（与 ctrl 客户端并行，仅供调试页面展示）
const server = http.createServer(app)

server.listen(API_PORT, '127.0.0.1', () => {
  const tracks = listMusic()
  console.log('')
  console.log('  DG-LAB 最小化调试平台')
  console.log(`  ├─ 调试 API     http://127.0.0.1:${API_PORT}`)
  console.log(`  ├─ 调试中继     ws://0.0.0.0:${RELAY_PORT}（${relay._internal.settings.version}）`)
  console.log(`  ├─ 音乐目录     ${resolveMusicDirs().join(' | ') || '（未找到，可用 DGLAB_DEBUG_MUSIC_DIR 指定）'}`)
  console.log(`  └─ 已发现曲目   ${tracks.length} 首${tracks.length ? `：${tracks.map(t => t.file).join('、')}` : ''}`)
  console.log('')
  console.log('  提示：浏览器打开 http://127.0.0.1:3100 ；虚拟设备默认自动连入中继。')
  console.log('')
})

// 中继日志回流：包装 log 的 console 输出
const originalLog = console.log
console.log = (...args) => {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  if (line.includes('[DG_LAB]')) {
    relayLogs.push(line.replace('[DG_LAB]', '').trim())
    if (relayLogs.length > MAX_RELAY_LOGS) relayLogs.splice(0, relayLogs.length - MAX_RELAY_LOGS)
  }
  originalLog(...args)
}

// 自动启动中继 + 虚拟设备，省掉「手点一遍」的重复劳动
setTimeout(() => {
  relay.start()
  const d = ensureVirtualDevice()
  // 等中继 listen 完成再连设备
  setTimeout(() => d.connect(), 300)
}, 200)

function shutdown() {
  try { device?.disconnect() } catch { /* ignore */ }
  try { relay.stop() } catch { /* ignore */ }
  try { server.close() } catch { /* ignore */ }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
