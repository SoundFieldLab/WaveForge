/**
 * 「共振」传输层：一个接口，两种实现。
 *
 * - 局域网（默认，零配置）：房主进程内起中转（desktop/resonance-hub.cjs），成员用原生 WebSocket 直连房主。
 *   星型拓扑：成员只连房主，成员之间的消息由房主转发（15 人 = 房主 14 条连接，不是 105 条全连接）。
 * - 互联网（可选，Phase 6）：WebRTC DataChannel + 手动信令，见 createRtcTransport 的占位说明。
 *
 * 传输层只搬运**端到端加密信封**；它看不到歌单/聊天内容（信封闭环在 crypto.ts）。
 * 成员侧不需要任何主进程能力，房间内容不经过我们运营的服务器。
 */
import type { ResonanceEnvelope } from './crypto'

export type ResonancePeerEvent =
  | { type: 'peer-joined'; peerId: string; memberCount: number }
  | { type: 'peer-left'; peerId: string; memberCount: number }
  | { type: 'closed'; reason?: string }

export interface ResonanceTransport {
  readonly kind: 'lan-host' | 'lan-member' | 'rtc'
  /** 本机在这个房间里的 peerId（房主为自己生成，成员由房主侧中转分配） */
  readonly selfPeerId: string
  /** 房主的 peerId（成员据此判断权威来源） */
  readonly hostPeerId: string
  connect(): Promise<void>
  /**
   * 成员：发给房主；房主：to='all' 广播、to='others:<peerId>' 广播但排除该成员、或发给指定 peerId。
   * 「排除发送者」用于房主转发聊天，避免原发送者收到自己消息的回声。
   */
  send(envelope: ResonanceEnvelope, to?: string): void
  onEnvelope(listener: (envelope: ResonanceEnvelope, fromPeerId: string) => void): () => void
  onPeerEvent(listener: (event: ResonancePeerEvent) => void): () => void
  /**
   * 关闭并释放底层资源。房主侧必须等主进程的中转真正停下来才能再开新房，
   * 否则 `resonance:start` 会撞上还活着的旧房间，报「房间已在进行中」——所以允许返回 Promise。
   */
  close(): void | Promise<void>
}

interface InvitePayload {
  roomId: string
  code: string
  /** 房间密钥种子：随邀请串交换，中转看不到；派生出的房间密钥用于端到端加密 */
  secret: string
  host?: string
  port?: number
}

const INVITE_PREFIX = 'wf-resonance://'

/** 生成/解析邀请串：wf-resonance://<ip>:<port>/<roomId>#<code>.<secret> */
export function parseInvite(text: string): InvitePayload | null {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (!raw.startsWith(INVITE_PREFIX)) return null
  try {
    const parsed = new URL(raw)
    const roomId = parsed.pathname.replace(/^\//, '')
    const [code, secret] = parsed.hash.replace(/^#/, '').split('.')
    if (!roomId || !/^\d{6}$/.test(code) || !secret) return null
    return { roomId, code, secret, host: parsed.hostname, port: Number(parsed.port) || undefined }
  } catch {
    return null
  }
}

export function buildInvite(payload: InvitePayload): string {
  const host = payload.host || '127.0.0.1'
  const port = payload.port || 25570
  return `${INVITE_PREFIX}${host}:${port}/${payload.roomId}#${payload.code}.${payload.secret}`
}

interface Listener<T> { (value: T): void }

class EventBus<T> {
  private readonly listeners = new Set<Listener<T>>()

  add(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(value: T): void {
    for (const listener of [...this.listeners]) {
      try { listener(value) } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}

/**
 * 房主侧传输：中转跑在主进程（desktop/resonance-hub.cjs），渲染进程通过 IPC 收发。
 */
export function createLanHostTransport(options: {
  roomId: string
  code?: string
  maxMembers?: number
  port?: number
  selfPeerId: string
  bridge?: NonNullable<Window['electron']>['resonance']
  /** 是否允许局域网发现（关闭时中转 /discover 返回 404） */
  discoverable?: boolean
}): ResonanceTransport & { startResult: () => { port: number; code: string; running: boolean } | null } {
  const bridge = options.bridge
  const envelopes = new EventBus<{ envelope: ResonanceEnvelope; from: string }>()
  const peers = new EventBus<ResonancePeerEvent>()
  let unsubscribe: (() => void) | null = null
  let startInfo: { port: number; code: string; running: boolean } | null = null

  return {
    kind: 'lan-host',
    selfPeerId: options.selfPeerId,
    hostPeerId: options.selfPeerId,
    startResult: () => startInfo,
    async connect() {
      if (!bridge) throw new Error('当前环境不支持房间中转（需要桌面端）')
      const status = await bridge.start({
        roomId: options.roomId,
        code: options.code,
        maxMembers: options.maxMembers,
        port: options.port,
        discoverable: options.discoverable !== false,
      })
      if (!status || status.running !== true) throw new Error(status?.error || '房间中转启动失败')
      startInfo = { port: status.port, code: status.code, running: true }
      unsubscribe = bridge.onEvent(event => {
        if (!event || !event.type) return
        if (event.type === 'envelope' && event.env && event.peerId) {
          envelopes.emit({ envelope: event.env as ResonanceEnvelope, from: String(event.peerId) })
          return
        }
        if (event.type === 'peer-joined' || event.type === 'peer-left') {
          peers.emit({ type: event.type, peerId: String(event.peerId || ''), memberCount: Number(event.memberCount || 0) })
          return
        }
        if (event.type === 'closed' || event.type === 'host-disconnected') {
          peers.emit({ type: 'closed', reason: event.type })
        }
      })
    },
    send(envelope, to) {
      void bridge?.send({ envelope, to })
    },
    onEnvelope(listener) {
      return envelopes.add(({ envelope, from }) => listener(envelope, from))
    },
    onPeerEvent(listener) { return peers.add(listener) },
    close() {
      unsubscribe?.()
      unsubscribe = null
      envelopes.clear()
      peers.clear()
      // 返回 Promise：调用方（session.create）必须等中转停稳再开新房，避免撞上旧房间。
      return bridge ? Promise.resolve(bridge.stop()).then(() => undefined, () => undefined) : undefined
    }
  }
}

/**
 * 成员侧传输：直接连房主的局域网中转（原生 WebSocket，无需主进程能力）。
 */
export function createLanMemberTransport(options: {
  host: string
  port?: number
  roomId: string
  code: string
  selfPeerId?: string
}): ResonanceTransport & { assignedPeerId: () => string } {
  const envelopes = new EventBus<{ envelope: ResonanceEnvelope; from: string }>()
  const peers = new EventBus<ResonancePeerEvent>()
  let socket: WebSocket | null = null
  let peerId = options.selfPeerId || ''
  let hostPeerId = ''
  const pending: ResonanceEnvelope[] = []

  const url = `ws://${options.host}:${options.port || 25570}/ws?room=${encodeURIComponent(options.roomId)}&code=${encodeURIComponent(options.code)}`

  return {
    kind: 'lan-member',
    get selfPeerId() { return peerId },
    get hostPeerId() { return hostPeerId },
    assignedPeerId: () => peerId,
    connect() {
      return new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(url)
        socket = ws
        const timer = window.setTimeout(() => {
          try { ws.close() } catch { /* ignore */ }
          reject(new Error('连接房主超时'))
        }, 8000)
        ws.onmessage = (event) => {
          let message: any = null
          try { message = JSON.parse(String(event.data)) } catch { return }
          if (!message || typeof message !== 'object') return
          if (message.t === 'joined') {
            peerId = String(message.peerId || '')
            window.clearTimeout(timer)
            resolve()
            return
          }
          if (message.t === 'env' && message.env) {
            envelopes.emit({ envelope: message.env, from: String(message.env.from || '') })
            return
          }
          if (message.t === 'host-left') {
            peers.emit({ type: 'closed', reason: 'host-left' })
          }
        }
        ws.onerror = () => {
          window.clearTimeout(timer)
          reject(new Error('无法连接房主（检查房间码与网络）'))
        }
        ws.onclose = (event) => {
          window.clearTimeout(timer)
          if (!peerId) {
            reject(new Error(event.code === 4001 ? '房间码不正确' : event.code === 4003 ? '房间已满' : '连接已断开'))
            return
          }
          peers.emit({ type: 'closed', reason: `code-${event.code}` })
        }
      })
    },
    send(envelope) {
      if (!socket || socket.readyState !== WebSocket.OPEN) { pending.push(envelope); return }
      socket.send(JSON.stringify({ t: 'env', env: envelope }))
    },
    onEnvelope(listener) {
      const off = envelopes.add(({ envelope, from }) => listener(envelope, from))
      if (pending.length) {
        const queued = pending.splice(0, pending.length)
        for (const envelope of queued) listener(envelope, envelope.from)
      }
      return off
    },
    onPeerEvent(listener) { return peers.add(listener) },
    close() {
      envelopes.clear()
      peers.clear()
      try { socket?.close() } catch { /* ignore */ }
      socket = null
    },
  }
}

/** 房主：把自己对外的可达地址（局域网 IP，优先级由主进程排序）设为邀请串里的 host */
export function pickInviteHost(ips: Array<{ name: string; address: string }> | undefined, fallback = '127.0.0.1'): string {
  return ips && ips.length > 0 ? ips[0].address : fallback
}
