// ── WaveForge 遥控器：局域网 Web 服务（手机浏览器遥控 UI + 虚拟鼠标桥接）──
// 在主进程内运行，绑 0.0.0.0:25566（局域网可达），token 配对防局域网内任意设备乱控。
// 支持多设备（最多 5 台）：桌面 UI 提供短期、一次性的配对 token，配对后改用 HttpOnly 会话。
// 鼠标控制为独占：同一时刻只有一台设备能控制虚拟鼠标，其余设备控制被提示「正在控制鼠标中」，
// 但播放/返回/Home/音量等其它操作不受限制。
'use strict'

const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const DEFAULT_PORT = 25566
const MAX_CLIENTS = 5
const PAIRING_TOKEN_TTL_MS = 5 * 60 * 1000
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const MAX_MESSAGE_BYTES = 64 * 1024
const CONNECTION_RATE_WINDOW_MS = 10 * 1000
const CONNECTION_RATE_LIMIT = 10
const SESSION_COOKIE_PREFIX = 'waveforge_remote_session_'
// 鼠标独占：最后一次鼠标操作后，独占权保留这么久（超过即释放，别的设备可接管）
const MOUSE_OWNERSHIP_MS = 1500

function getLanIPv4Addresses() {
  const result = []
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        result.push({ name, address: iface.address })
      }
    }
  }
  // 默认网卡排序：有线 > 无线 > 未识别 > 虚拟网卡（Tailscale / VMware / VirtualBox / Hyper-V / WSL / 蓝牙等）。
  // 有线和无线都连着时优先选有线（稳定）；虚拟网卡排最后（基本不会用于局域网直连）。
  const score = (name) => {
    if (/tailscale|vmware|vmnet|virtualbox|vEthernet|hyper-?v|docker|wsl|loopback|bluetooth|蓝牙|zerotier|utun|tap-|tun|vm/i.test(name)) return 4
    if (/wlan|wi-?fi|wireless|无线|wifi/i.test(name)) return 2
    if (/ethernet|以太网|有线|eth\d|enp\d|本地连接/i.test(name)) return 1
    return 3 // 未识别（按介于无线与虚拟之间处理）
  }
  result.sort((a, b) => score(a.name) - score(b.name))
  return result
}

function normalizeIp(addr) {
  if (!addr) return ''
  return String(addr).replace(/^::ffff:/, '')
}

/**
 * options:
 *   getComputerName() => string
 *   getSettings()    => { theme, topRightAction, gesturesEnabled }
 *   getState()       => 播放状态快照
 *   sendControl(action, payload) => 转发播放/导航/音量命令给主窗口
 *   sendCursor(cmd, data)         => 转发虚拟鼠标命令给主窗口
 *   onClientsChange(status)       => 客户端列表变化回调（供主窗口「已连接 N 台」状态）
 */
function createRemoteServer(options) {
  let server = null
  let wss = null
  let running = false
  let port = DEFAULT_PORT
  let pairingToken = null
  let clientSeq = 0
  const clients = [] // { id, ws, sessionId, name, ip, connectedAt }
  const sessions = new Map() // sessionId => { expiresAt, activeClientId, ephemeral }
  const connectionAttempts = new Map() // ip => recent attempt timestamps
  let mouseOwnerId = null
  let mouseOwnerActiveUntil = 0
  const now = typeof options.now === 'function' ? options.now : Date.now
  const pairingTokenTtlMs = options.pairingTokenTtlMs || PAIRING_TOKEN_TTL_MS
  const sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS
  const connectionRateWindowMs = options.connectionRateWindowMs || CONNECTION_RATE_WINDOW_MS
  const connectionRateLimit = options.connectionRateLimit || CONNECTION_RATE_LIMIT

  const htmlTemplate = (() => {
    const file = path.join(__dirname, 'remote-ui.html')
    try {
      return fs.readFileSync(file, 'utf8')
    } catch (err) {
      console.error('[Remote] 读取 remote-ui.html 失败:', err)
      return '<html><body><h1>遥控器页面缺失</h1></body></html>'
    }
  })()

  function buildConfig() {
    const settings = options.getSettings ? options.getSettings() : {}
    return {
      computerName: options.getComputerName ? options.getComputerName() : 'WaveForge',
      theme: settings.theme === 'light' ? 'light' : 'dark',
      topRightAction: settings.topRightAction || 'song',
      gestures: settings.gestures || { doubleTap: true, swipe: true, twoFinger: true },
    }
  }

  function renderHtml() {
    return htmlTemplate.replace('__REMOTE_CONFIG__', JSON.stringify(buildConfig()))
  }

  function randomToken() {
    return crypto.randomBytes(24).toString('hex')
  }

  function pruneSessions() {
    const currentTime = now()
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= currentTime && !session.activeClientId) sessions.delete(sessionId)
    }
  }

  function nextToken() {
    pruneSessions()
    if (clients.length >= MAX_CLIENTS) return ''
    if (!pairingToken || pairingToken.expiresAt <= now()) {
      pairingToken = { value: randomToken(), expiresAt: now() + pairingTokenTtlMs }
    }
    return pairingToken.value
  }

  function consumePairingToken(candidate, ephemeral = false) {
    if (!pairingToken || pairingToken.expiresAt <= now() || candidate !== pairingToken.value) return null
    pairingToken = null
    pruneSessions()
    if (clients.length >= MAX_CLIENTS) return null
    const sessionId = randomToken()
    sessions.set(sessionId, { expiresAt: now() + sessionTtlMs, activeClientId: null, ephemeral })
    return sessionId
  }

  function parseCookies(header) {
    const result = {}
    for (const part of String(header || '').split(';')) {
      const separator = part.indexOf('=')
      if (separator < 0) continue
      const key = part.slice(0, separator).trim()
      const value = part.slice(separator + 1).trim()
      if (key) result[key] = value
    }
    return result
  }

  function sessionCookieName() {
    return `${SESSION_COOKIE_PREFIX}${port}`
  }

  function getSession(sessionId) {
    if (!sessionId) return null
    const session = sessions.get(sessionId)
    if (!session || session.expiresAt <= now()) {
      if (session && !session.activeClientId) sessions.delete(sessionId)
      return null
    }
    return session
  }

  function isConnectionRateLimited(ip) {
    const cutoff = now() - connectionRateWindowMs
    const attempts = (connectionAttempts.get(ip) || []).filter(timestamp => timestamp > cutoff)
    attempts.push(now())
    connectionAttempts.set(ip, attempts)
    return attempts.length > connectionRateLimit
  }

  function clientList() {
    return clients.map(c => ({ name: c.name, ip: c.ip, connectedAt: c.connectedAt }))
  }

  function status() {
    // clientCount 只统计"手机控制端"：TV 端 SPA 自连（role=spa）不算，
    // 否则 TV 一启动就被自己触发 remoteCursorMode → 整页切成 PC 风格 UI。
    const phoneCount = clients.filter(c => c.role !== 'spa').length
    return {
      running,
      port,
      token: running ? nextToken() : '',
      clientCount: phoneCount,
      maxClients: MAX_CLIENTS,
      clients: clientList(),
      ips: getLanIPv4Addresses(),
    }
  }

  function notifyClients() {
    if (options.onClientsChange) options.onClientsChange(status())
  }

  function broadcast(obj) {
    const data = JSON.stringify(obj)
    for (const c of clients) {
      if (c.ws.readyState === 1) {
        try { c.ws.send(data) } catch { /* ignore */ }
      }
    }
  }

  function sendTo(client, obj) {
    if (client && client.ws.readyState === 1) {
      try { client.ws.send(JSON.stringify(obj)) } catch { /* ignore */ }
    }
  }

  // 鼠标独占：返回 true（允许）或 { blocked:true, ownerName }
  function acquireMouse(client) {
    const now = Date.now()
    if (mouseOwnerId === client.id) {
      mouseOwnerActiveUntil = now + MOUSE_OWNERSHIP_MS
      return true
    }
    if (mouseOwnerId && now < mouseOwnerActiveUntil) {
      const owner = clients.find(c => c.id === mouseOwnerId)
      return { blocked: true, ownerName: owner ? owner.name : '其他设备' }
    }
    mouseOwnerId = client.id
    mouseOwnerActiveUntil = now + MOUSE_OWNERSHIP_MS
    return true
  }

  function releaseMouseIfOwner(clientId) {
    if (mouseOwnerId === clientId) {
      mouseOwnerId = null
      mouseOwnerActiveUntil = 0
    }
  }

  function dispatchControl(type, action, value) {
    let resolvedAction = null
    let resolvedValue
    if (type === 'control') { resolvedAction = action; resolvedValue = value }
    else if (type === 'volume') { resolvedAction = 'volume'; resolvedValue = Number(value) }
    else if (type === 'mute') { resolvedAction = 'mute' }
    else if (type === 'seek') { resolvedAction = 'seek'; resolvedValue = Number(value) }
    if (!resolvedAction) return
    options.sendControl && options.sendControl(resolvedAction, resolvedValue)
    // 广播给所有客户端：TV 端 WebView 内的 SPA 控制器也作为 WS 客户端接入，
    // 靠这条广播接收命令（桌面端手机页会忽略这条回声，行为不变）。
    broadcast({ type: 'control', action: resolvedAction, value: resolvedValue })
  }

  function handleMessage(client, msg) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'hello') {
      if (typeof msg.name === 'string' && msg.name) client.name = msg.name
      notifyClients()
      return
    }
    if (msg.type === 'control' || msg.type === 'volume' || msg.type === 'mute' || msg.type === 'seek') {
      // 播放/导航/音量等：所有设备都可控制，不受鼠标独占限制
      dispatchControl(msg.type, msg.action, msg.value)
      return
    }
    if (msg.type === 'text-input') {
      // 手机端输入完成 → 广播（TV 端 SPA 收到后写入输入框）
      broadcast({ type: 'text-input', value: msg.value || '' })
      return
    }
    if (msg.type === 'request-input') {
      // TV 端请求文本输入（远程遥控连接时替代 TV 软键盘）→ 广播给手机端弹输入框
      broadcast({ type: 'request-input' })
      return
    }
    if (msg.type === 'cursor') {
      const isMouse = msg.cmd === 'move' || msg.cmd === 'click' || msg.cmd === 'hold-start' || msg.cmd === 'hold-cancel' || msg.cmd === 'scroll' || msg.cmd === 'right-click'
      if (isMouse) {
        const res = acquireMouse(client)
        if (res && res.blocked) {
          sendTo(client, { type: 'control-blocked', name: res.ownerName })
          return
        }
      }
      options.sendCursor && options.sendCursor(msg.cmd, msg)
      // 广播给所有客户端：TV 端 WebView 内的 SPA（remoteBridge → waveforge:remote-cursor）
      // 靠这条广播接收光标命令；桌面端手机页会忽略这条回声，行为不变。
      // 注意 dx/dy（相对位移）必须原样带上：RemoteCursor 的 move 只认 dx/dy，丢了指针就不动。
      broadcast({ type: 'cursor', cmd: msg.cmd, x: msg.x, y: msg.y, dx: msg.dx, dy: msg.dy, kind: msg.kind, buttons: msg.buttons })
    }
  }

  function start(requestedPort) {
    if (running) return Promise.resolve(status())
    return new Promise((resolve, reject) => {
      port = requestedPort == null ? DEFAULT_PORT : requestedPort

      server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const t = url.searchParams.get('t') || ''
          const cookies = parseCookies(req.headers.cookie)
          if (t) {
            const sessionId = consumePairingToken(t)
            if (!sessionId) {
              res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('403 Forbidden')
              return
            }
            res.writeHead(303, {
              Location: '/',
              'Cache-Control': 'no-store',
              'Set-Cookie': `${sessionCookieName()}=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
            })
            res.end()
            return
          }
          if (!getSession(cookies[sessionCookieName()])) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('403 Forbidden')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(renderHtml())
          return
        }
        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        // 匿名设备发现只返回服务信息。配对 token 仅通过桌面 UI 的状态渠道提供。
        if (url.pathname === '/discover') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            name: options.getComputerName ? options.getComputerName() : 'WaveForge',
            port,
          }))
          return
        }
        // 扩展路由钩子（TV 端壁纸扫码上传等由调用方注册），返回 true 表示已处理
        if (options.onHttpRequest && options.onHttpRequest(req, res, url)) {
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 Not Found')
      })

      wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES })
      // ws 会把底层 http server 的 error（如端口被占 EADDRINUSE）转发到自身；
      // 不监听会导致 EventEmitter 抛 uncaughtException，这里静默吞掉（listen 失败由下方 reject 处理）
      wss.on('error', () => {})

      wss.on('connection', (ws, req) => {
        let url
        try { url = new URL(req.url, 'http://localhost') } catch { url = null }
        const ip = normalizeIp(ws._socket && ws._socket.remoteAddress)
        if (isConnectionRateLimited(ip)) {
          ws.close(4008, 'Rate limit exceeded')
          return
        }
        const cookies = parseCookies(req.headers.cookie)
        let sessionId = cookies[sessionCookieName()] || ''
        let session = getSession(sessionId)
        if (!session && url) {
          sessionId = consumePairingToken(url.searchParams.get('t') || '', true) || ''
          session = getSession(sessionId)
        }
        if (!session) {
          ws.close(4001, 'Unauthorized')
          return
        }
        if (session.activeClientId) {
          ws.close(4002, 'Session already in use')
          return
        }
        // role=spa：TV 端 SPA 自连（remoteBridge），不计入手机客户端数
        const role = url ? url.searchParams.get('role') || '' : ''

        if (clients.length >= MAX_CLIENTS) {
          ws.close(4003, 'Max clients reached')
          return
        }

        const client = {
          id: ++clientSeq,
          ws,
          sessionId,
          role,
          name: `设备 ${clients.length + 1}`,
          ip,
          connectedAt: Date.now(),
        }
        session.activeClientId = client.id
        clients.push(client)
        notifyClients()

        try { ws.send(JSON.stringify({ type: 'config', config: buildConfig() })) } catch { /* ignore */ }
        if (options.getState) {
          try { ws.send(JSON.stringify({ type: 'state', state: options.getState() })) } catch { /* ignore */ }
        }

        ws.on('message', (raw) => {
          let msg
          try { msg = JSON.parse(raw.toString()) } catch { return }
          handleMessage(client, msg)
        })
        ws.on('close', () => {
          const idx = clients.indexOf(client)
          if (idx >= 0) clients.splice(idx, 1)
          const currentSession = sessions.get(client.sessionId)
          if (currentSession && currentSession.activeClientId === client.id) {
            currentSession.activeClientId = null
            if (currentSession.ephemeral) sessions.delete(client.sessionId)
          }
          releaseMouseIfOwner(client.id)
          notifyClients()
        })
        ws.on('error', () => {})
      })

      server.once('error', (err) => {
        server = null
        wss = null
        reject(err)
      })

      server.listen(port, '0.0.0.0', () => {
        const address = server.address()
        if (address && typeof address === 'object') port = address.port
        running = true
        console.log(`[Remote] 遥控器服务已启动: http://0.0.0.0:${port}（${MAX_CLIENTS} 槽位）`)
        resolve(status())
      })
    })
  }

  function stop() {
    if (!running) return
    running = false
    for (const c of clients) { try { c.ws.close() } catch { /* ignore */ } }
    clients.length = 0
    pairingToken = null
    sessions.clear()
    connectionAttempts.clear()
    mouseOwnerId = null
    mouseOwnerActiveUntil = 0
    if (wss) { try { wss.close() } catch { /* ignore */ } ; wss = null }
    if (server) { try { server.close() } catch { /* ignore */ } ; server = null }
    console.log('[Remote] 遥控器服务已停止')
    notifyClients()
  }

  function broadcastState(state) {
    if (!running || clients.length === 0) return
    broadcast({ type: 'state', state })
  }

  function pushConfig() {
    if (!running || clients.length === 0) return
    broadcast({ type: 'config', config: buildConfig() })
  }

  return { start, stop, status, broadcastState, pushConfig }
}

module.exports = {
  createRemoteServer,
  getLanIPv4Addresses,
  DEFAULT_PORT,
  MAX_CLIENTS,
  PAIRING_TOKEN_TTL_MS,
  MAX_MESSAGE_BYTES,
  CONNECTION_RATE_LIMIT,
}
