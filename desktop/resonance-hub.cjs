// ── WaveForge 共振：局域网房间中转（房主进程内运行）──
// 定位：**只做密文转发的星型中继**，不解析、不存储任何房间内容。
//  - 房主创建房间时启动本服务（绑 0.0.0.0，局域网可达），并生成 6 位房间码；
//  - 成员用「房间码 + 房主 IP」加入，服务只校验房间号/房间码/人数上限与速率；
//  - 成员 → 房主 单向转发；房主可 to-all / to-peer 广播；成员之间不能直连（星型拓扑）；
//  - 载荷是端到端加密信封（见 src/features/resonance/crypto.ts），中继只看到 roomId/from/kind/seq。
// 隐私约束：日志不打印载荷；/discover 只返回服务信息（不返回房间号与房间码）。
'use strict'

const http = require('http')
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const SERVICE_NAME = 'waveforge-resonance'
const SERVICE_VERSION = 1
const DEFAULT_PORT = 25570
const MAX_MESSAGE_BYTES = 64 * 1024
const CONNECTION_RATE_WINDOW_MS = 10 * 1000
const CONNECTION_RATE_LIMIT = 12
const DEFAULT_MAX_MEMBERS = 15

function normalizeIp(addr) {
  if (!addr) return ''
  return String(addr).replace(/^::ffff:/, '')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/** 6 位数字房间码（避免易混字符，纯数字便于口述） */
function generateRoomCode() {
  return String(crypto.randomInt(100000, 1000000))
}

/**
 * options:
 *   getComputerName() => string
 *   getLanIps()       => [{ name, address }]
 *   onEvent(event)    => void   // { type: 'peer-joined'|'peer-left', peerId, memberCount } 等，供主窗口广播给渲染进程
 */
function createResonanceHub(options = {}) {
  let server = null
  let wss = null
  let running = false
  let port = DEFAULT_PORT
  let room = null        // { roomId, code, maxMembers, createdAt }
  let hostSocket = null
  let hostPeerId = null
  const members = new Map() // peerId => { ws, ip, joinedAt }
  const connectionAttempts = new Map() // ip => timestamps

  const emit = (event) => {
    try { options.onEvent && options.onEvent(event) } catch { /* 事件回调失败不影响服务 */ }
  }

  function isConnectionRateLimited(ip) {
    const now = Date.now()
    const recent = (connectionAttempts.get(ip) || []).filter(at => now - at < CONNECTION_RATE_WINDOW_MS)
    recent.push(now)
    connectionAttempts.set(ip, recent)
    return recent.length > CONNECTION_RATE_LIMIT
  }

  /** 房主侧消息路由：'all' | 'others:<peerId>' | '<peerId>' */
  function routeHostMessage(message) {
    const target = String(message.to || 'all')
    if (target === 'all') { broadcast(message.env); return }
    if (target.startsWith('others:')) {
      broadcast(message.env, target.slice(7))
      return
    }
    sendTo(target, message.env)
  }

  function status() {
    return {
      running,
      port,
      roomId: room ? room.roomId : '',
      code: room ? room.code : '',
      maxMembers: room ? room.maxMembers : DEFAULT_MAX_MEMBERS,
      memberCount: members.size,
      createdAt: room ? room.createdAt : 0,
      ips: typeof options.getLanIps === 'function' ? options.getLanIps() : [],
      isHost: Boolean(hostSocket),
    }
  }

  function send(socket, message) {
    if (!socket || socket.readyState !== socket.OPEN) return false
    try {
      socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  /** 房主侧广播（to-all），可选排除某个成员 */
  function broadcast(envelope, exceptPeerId) {
    let sent = 0
    for (const [peerId, member] of members) {
      if (exceptPeerId && peerId === exceptPeerId) continue
      if (send(member.ws, { t: 'env', env: envelope })) sent += 1
    }
    return sent
  }

  function sendTo(peerId, envelope) {
    const member = members.get(peerId)
    if (!member) return false
    return send(member.ws, { t: 'env', env: envelope })
  }

  function kick(peerId, reason = 'kicked') {
    const member = members.get(peerId)
    if (!member) return false
    try { member.ws.close(4009, reason) } catch { /* ignore */ }
    return true
  }

  function start(config = {}) {
    if (running) {
      if (config.roomId && room && config.roomId !== room.roomId) {
        // 空房间（没人连着）里的旧中转不该拦住新房：渲染进程重载、上一次解散没走完都会留下这种僵尸房间。
        // 有成员在线时仍然拒绝，避免把正在听的人无声踢掉。
        const idle = !hostSocket && members.size === 0
        if (!idle) return Promise.reject(new Error('房间已在进行中'))
        stop()
      } else {
        return Promise.resolve(status())
      }
    }
    const roomId = String(config.roomId || '')
    if (!roomId) return Promise.reject(new Error('缺少房间号'))
    const code = String(config.code || generateRoomCode())
    if (!/^\d{6}$/.test(code)) return Promise.reject(new Error('房间码必须是 6 位数字'))
    const maxMembers = Math.min(DEFAULT_MAX_MEMBERS, Math.max(2, Number(config.maxMembers) || DEFAULT_MAX_MEMBERS))
    // 显式传 0 = 由系统分配临时端口（测试用）；未传时用默认端口
    port = config.port === undefined || config.port === null || config.port === '' ? DEFAULT_PORT : Math.max(0, Number(config.port) || 0)

    return new Promise((resolve, reject) => {
      server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost')
        if (url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, service: SERVICE_NAME, version: SERVICE_VERSION }))
          return
        }
        // 匿名发现：仅服务信息与当前在线人数，不含房间号与房间码
        if (url.pathname === '/discover') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({
            service: SERVICE_NAME,
            version: SERVICE_VERSION,
            name: options.getComputerName ? options.getComputerName() : 'WaveForge',
            port,
            memberCount: members.size,
            open: running,
          }))
          return
        }
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 Not Found')
      })

      wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES })
      wss.on('error', () => {})

      wss.on('connection', (ws, req) => {
        // 每个连接都必须挂 'error' 监听：ws 在协议错误（超 maxPayload 的帧、非法分片、
        // 解压失败等）时会 emit('error')，而 EventEmitter 上无监听者的 'error' 会抛成
        // uncaughtException，直接杀掉 Electron 主进程——即房间内任一成员发一个 64KB+
        // 的帧就能崩掉房主的整个应用（已实测复现）。这里吞掉即可：坏连接由 ws.close 收尾。
        // 每个连接都必须挂 'error' 监听：ws 在协议错误（超 maxPayload 的帧、非法分片、
        // 解压失败等）时会 emit('error')，而 EventEmitter 上无监听者的 'error' 会抛成
        // uncaughtException，直接杀掉 Electron 主进程——即房间内任一成员发一个 64KB+
        // 的帧就能崩掉房主的整个应用（已实测复现；回归测试见 resonanceHub.test.cjs）。
        // 这里吞掉即可：坏连接由 ws 自身的 close 流程收尾。
        ws.on('error', () => {})
        let url = null
        try { url = new URL(req.url, 'http://localhost') } catch { /* ignore */ }
        const ip = normalizeIp(ws._socket && ws._socket.remoteAddress)
        if (isConnectionRateLimited(ip)) {
          ws.close(4008, 'Rate limit exceeded')
          return
        }
        if (!url || !room) {
          ws.close(4001, 'No room')
          return
        }
        // 房间号与房间码都必须匹配（常数时间比较，避免时序侧信道）
        if (!safeEqual(url.searchParams.get('room'), room.roomId) || !safeEqual(url.searchParams.get('code'), room.code)) {
          ws.close(4001, 'Unauthorized')
          return
        }
        const connectedRoomId = room.roomId
        const role = url.searchParams.get('role') || 'member'
        if (role === 'host') {
          if (hostSocket) {
            ws.close(4002, 'Host already connected')
            return
          }
          hostPeerId = crypto.randomUUID()
          hostSocket = ws
          send(ws, { t: 'host-ready', peerId: hostPeerId, roomId: room.roomId, memberCount: members.size })
          emit({ type: 'host-connected', peerId: hostPeerId })
        } else {
          // 房主占 1 席（房主通常就在本进程内，不需要额外连接）
          if (members.size >= room.maxMembers - 1) {
            ws.close(4003, 'Room full')
            return
          }
          const peerId = crypto.randomUUID()
          members.set(peerId, { ws, ip, joinedAt: Date.now() })
          send(ws, { t: 'joined', peerId, roomId: room.roomId, memberCount: members.size })
          send(hostSocket, { t: 'peer-joined', peerId, memberCount: members.size })
          emit({ type: 'peer-joined', peerId, memberCount: members.size })
        }

        ws.on('message', (raw) => {
          let message = null
          try { message = JSON.parse(raw.toString()) } catch { return }
          if (!message || typeof message !== 'object') return
          if (message.t !== 'env' || !message.env || typeof message.env !== 'object') return
          // 信封必须属于本房间；中继不解析其余内容（载荷是端到端加密的）
          // 注意：房间可能已被 stop()，这里只比连接时锁定的房间号，避免读到空房间
          if (String(message.env.roomId || '') !== connectedRoomId) return
          if (ws === hostSocket) {
            // 房主 → 全员 / 排除某人 / 指定成员
            routeHostMessage(message)
            return
          }
          // 成员 → 只能发给房主（星型：成员之间不直连）
          // 房主通常就在本进程内：以事件形式上报；若另有 host socket（TV/外部宿主）再转发一份
          const senderPeerId = findPeerId(ws)
          if (!senderPeerId) return
          emit({ type: 'envelope', peerId: senderPeerId, env: message.env })
          if (hostSocket) send(hostSocket, { t: 'env', from: senderPeerId, env: message.env })
        })

        ws.on('close', () => {
          if (ws === hostSocket) {
            hostSocket = null
            emit({ type: 'host-disconnected' })
            // 房主断开即房间不可用：通知并断开所有成员
            for (const [peerId, member] of members) {
              send(member.ws, { t: 'host-left' })
              try { member.ws.close(4010, 'Host left') } catch { /* ignore */ }
              emit({ type: 'peer-left', peerId, memberCount: Math.max(0, members.size - 1) })
            }
            members.clear()
            return
          }
          const peerId = findPeerId(ws)
          if (!peerId) return
          members.delete(peerId)
          send(hostSocket, { t: 'peer-left', peerId, memberCount: members.size })
          emit({ type: 'peer-left', peerId, memberCount: members.size })
        })
      })

      server.on('error', (error) => {
        running = false
        reject(error)
      })
      server.listen(port, '0.0.0.0', () => {
        running = true
        // port 传 0 时由系统分配：回读真实端口，状态与邀请串都用它
        const address = server.address()
        if (address && typeof address === 'object' && address.port) port = address.port
        room = { roomId, code, maxMembers, createdAt: Date.now() }
        resolve(status())
      })
    })
  }

  function findPeerId(ws) {
    for (const [peerId, member] of members) {
      if (member.ws === ws) return peerId
    }
    return ''
  }

  function stop() {
    for (const [, member] of members) {
      try { member.ws.close(4011, 'Room closed') } catch { /* ignore */ }
    }
    members.clear()
    if (hostSocket) {
      try { hostSocket.close(4011, 'Room closed') } catch { /* ignore */ }
      hostSocket = null
    }
    if (wss) {
      try { wss.close() } catch { /* ignore */ }
      wss = null
    }
    if (server) {
      try { server.close() } catch { /* ignore */ }
      server = null
    }
    const wasRoom = room
    running = false
    room = null
    if (wasRoom) emit({ type: 'closed', roomId: wasRoom.roomId })
    return status()
  }

  /** 房主可随时更换房间码（例如怀疑泄露） */
  function updateCode(code) {
    if (!room) return false
    const next = String(code || '')
    if (!/^\d{6}$/.test(next)) return false
    room.code = next
    return true
  }

  /** 房主复制的邀请串：wf-resonance://<ip>:<port>/<roomId>#<code> */
  function buildInvite(address) {
    if (!room) return ''
    const ip = String(address || '').trim() || (status().ips[0] || {}).address || '127.0.0.1'
    return `wf-resonance://${ip}:${port}/${room.roomId}#${room.code}`
  }

  return { start, stop, status, broadcast, sendTo, kick, updateCode, buildInvite, generateRoomCode }
}

module.exports = {
  SERVICE_NAME,
  SERVICE_VERSION,
  DEFAULT_PORT,
  DEFAULT_MAX_MEMBERS,
  MAX_MESSAGE_BYTES,
  createResonanceHub,
  generateRoomCode,
}
