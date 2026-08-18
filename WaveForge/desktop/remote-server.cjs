// ── WaveForge 遥控器：局域网 Web 服务（手机浏览器遥控 UI + 虚拟鼠标桥接）──
// 在主进程内运行，绑 0.0.0.0:25566（局域网可达），token 配对防局域网内任意设备乱控。
// 支持多设备（最多 5 台）：启动时一次性生成 5 个 token 槽位，每台设备占一个槽；
// 关闭弹窗不会停止服务、不会重新生成 token（持续到软件退出或手动断开）。
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
  let tokens = []
  let clientSeq = 0
  const clients = [] // { id, ws, slot, token, name, ip, connectedAt }
  let mouseOwnerId = null
  let mouseOwnerActiveUntil = 0

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

  function generateTokens() {
    tokens = []
    for (let i = 0; i < MAX_CLIENTS; i += 1) tokens.push(crypto.randomBytes(18).toString('hex'))
  }

  // 返回下一个未被占用的 token（槽位），没有则返回 ''
  function nextToken() {
    for (const t of tokens) {
      if (!clients.some(c => c.token === t)) return t
    }
    return ''
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
      token: nextToken(),
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
      broadcast({ type: 'cursor', cmd: msg.cmd, x: msg.x, y: msg.y, kind: msg.kind, buttons: msg.buttons })
    }
  }

  function start(requestedPort) {
    if (running) return Promise.resolve(status())
    return new Promise((resolve, reject) => {
      // 启动即生成 5 个 token 槽位；已运行则保留原 token（关闭弹窗不会重新生成）
      if (!tokens.length) generateTokens()
      port = requestedPort || DEFAULT_PORT

      server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const t = url.searchParams.get('t') || ''
          if (!tokens.includes(t)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('403 Forbidden')
            return
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(renderHtml())
          return
        }
        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true }))
          return
        }
        // 设备发现：手机端扫描多个端口列出局域网内的 WaveForge 设备。
        // 返回 name/port/token（与二维码同等的配对信息，仅限可信局域网使用）。
        if (url.pathname === '/discover') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({
            name: options.getComputerName ? options.getComputerName() : 'WaveForge',
            port,
            token: nextToken() || (tokens[0] || ''),
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

      wss = new WebSocketServer({ server, path: '/ws' })
      // ws 会把底层 http server 的 error（如端口被占 EADDRINUSE）转发到自身；
      // 不监听会导致 EventEmitter 抛 uncaughtException，这里静默吞掉（listen 失败由下方 reject 处理）
      wss.on('error', () => {})

      wss.on('connection', (ws, req) => {
        let url
        try { url = new URL(req.url, 'http://localhost') } catch { url = null }
        const t = url ? url.searchParams.get('t') || '' : ''
        if (!tokens.includes(t)) {
          ws.close(4001, 'Unauthorized')
          return
        }
        // role=spa：TV 端 SPA 自连（remoteBridge），不计入手机客户端数
        const role = url ? url.searchParams.get('role') || '' : ''

        // 同一 token 槽位重连（如页面刷新）：顶掉旧连接
        const existing = clients.find(c => c.token === t)
        if (existing) {
          try { existing.ws.close(4002, 'Replaced') } catch { /* ignore */ }
          const idx = clients.indexOf(existing)
          if (idx >= 0) clients.splice(idx, 1)
          releaseMouseIfOwner(existing.id)
        }
        if (clients.length >= MAX_CLIENTS) {
          ws.close(4003, 'Max clients reached')
          return
        }

        const slot = tokens.indexOf(t)
        const client = {
          id: ++clientSeq,
          ws,
          slot,
          token: t,
          role,
          name: `设备 ${slot + 1}`,
          ip: normalizeIp(ws._socket && ws._socket.remoteAddress),
          connectedAt: Date.now(),
        }
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

module.exports = { createRemoteServer, getLanIPv4Addresses, DEFAULT_PORT, MAX_CLIENTS }
