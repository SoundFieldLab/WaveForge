/**
 * TV 端远程遥控器桥接（仅 Android）。
 *
 * 链路：手机控制页 → 设备内置 Node 的 remote-server(:25567, 复用 PC 端同一套)
 *  → remote-server 把控制/光标命令 broadcast 给所有 WS 客户端
 *  → 本桥作为 WS 客户端接入（token 从 /api/tv/remote-status 读取，本机接口不外泄）
 *  → 控制命令 → waveforge:remote-control（App 的 desktopControlHandlerRef 执行）
 *  → 光标命令 → waveforge:remote-cursor（RemoteCursor 虚拟鼠标驱动 hover UI）
 *
 * 另外轮询 /api/tv/remote-status：手机连上（clientCount>0）时切换为"光标模式"，
 * TV 的 hover 驱动 UI 与 PC 一致、焦点环隐藏。
 */
import { isTvModeActive } from '../platform'
import { setRemoteCursorMode } from './tvCore'

let installed = false
let ws: WebSocket | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let statusTimer: ReturnType<typeof setInterval> | null = null
let closed = false
const DEFAULT_PORT = 25567 // TV 端遥控端口（PC 端固定 25566，TV 用 25567 避免同网段冲突）

async function fetchRemoteStatus(): Promise<{
  running?: boolean
  port?: number
  token?: string
  clientCount?: number
} | null> {
  try {
    const res = await fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as {
      running?: boolean
      port?: number
      token?: string
      clientCount?: number
    }
  } catch {
    return null
  }
}

function scheduleRetry(delayMs: number): void {
  if (closed) return
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => void connect(), delayMs)
}

/** 轮询遥控状态：维持光标模式（clientCount>0 = 手机已连上） */
function startStatusPolling(): void {
  if (statusTimer) return
  const poll = async () => {
    const st = await fetchRemoteStatus()
    if (st) setRemoteCursorMode((st.clientCount || 0) > 0)
  }
  void poll()
  statusTimer = setInterval(poll, 5000)
}

async function connect(): Promise<void> {
  if (closed) return
  try {
    ws?.close()
  } catch {
    // ignore
  }
  const st = await fetchRemoteStatus()
  if (!st?.running || !st?.token) {
    scheduleRetry(5000)
    return
  }
  const port = st.port || DEFAULT_PORT
  try {
    // role=spa：标记为 TV 端自身连接，remote-server 不计入手机客户端数
    // （否则 clientCount≥1 → remoteCursorMode=true → 整个 UI 变 PC 风格）
    ws = new WebSocket(`ws://localhost:${port}/ws?t=${encodeURIComponent(st.token)}&role=spa`)
  } catch {
    scheduleRetry(5000)
    return
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as {
        type?: string
        action?: string
        value?: unknown
        cmd?: string
      }
      if (!msg?.type) return
      if (msg.type === 'control' && msg.action) {
        window.dispatchEvent(
          new CustomEvent('waveforge:remote-control', { detail: { action: msg.action, payload: msg.value } })
        )
      } else if (msg.type === 'cursor' && msg.cmd) {
        // 光标命令原样转给 RemoteCursor（虚拟鼠标 + hover 事件）
        window.dispatchEvent(new CustomEvent('waveforge:remote-cursor', { detail: msg }))
      } else if (msg.type === 'text-input') {
        // 手机端输入完成：写入当前聚焦的输入框（远程遥控连接时替代 TV 软键盘）
        const ae = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) {
          const proto =
            ae instanceof HTMLTextAreaElement
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          if (setter) {
            setter.call(ae, String(msg.value ?? ''))
            ae.dispatchEvent(new Event('input', { bubbles: true }))
          }
        }
      }
    } catch {
      // ignore
    }
  }
  ws.onclose = () => scheduleRetry(5000)
  ws.onerror = () => {
    try {
      ws?.close()
    } catch {
      // ignore
    }
  }
}

/** 请求手机端弹输入框（远程遥控连接时替代 TV 软键盘）。 */
export function requestRemoteTextInput(): void {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'request-input' }))
  }
}

/** TV 模式（真机 TV/平板或浏览器 ?tv=1 强制）启动；桌面非 TV 走 Electron 的 remote 桥。 */
export function installRemoteBridge(): void {
  if (installed || !isTvModeActive() || typeof WebSocket === 'undefined') return
  installed = true
  void connect()
  startStatusPolling()
}
