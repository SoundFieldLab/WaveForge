/**
 * TV 局域网调试桥（跟随开发者模式，默认关闭）：
 *  - 开发者模式开启时：通知后端启动 :3008 调试服务，并连 ws://localhost:3008/ws
 *    接收电脑调试台（http://<设备IP>:3008）发出的控制命令 → 派发到应用执行；
 *  - 前端 JS 错误（window.onerror/unhandledrejection）上报到后端调试服务，
 *    电脑端无需 adb 即可看到崩溃原因。
 */
import { isDebugMode, getFrontendLogs } from './debugStore'
import { isAndroid } from '../platform'

let ws: WebSocket | null = null
let lastReportedLogs = 0

function syncBackend(enabled: boolean): void {
  try {
    void fetch('http://localhost:3001/api/tv/debug-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).catch(() => {})
  } catch {
    // ignore
  }
}

function connectWs(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  // 先确认 3008 是 TV 调试服务（未启动/被其它服务占用时不连 WS，避免反复重试刷屏）
  fetch('http://localhost:3008/', { cache: 'no-store' })
    .then((r) => {
      if (r.ok) connectWsDirect()
    })
    .catch(() => { /* 调试服务未运行：不连接 */ })
}

function connectWsDirect(): void {
  try {
    ws = new WebSocket('ws://localhost:3008/ws')
  } catch {
    return
  }
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type?: string; action?: string; value?: unknown }
      if (msg?.type === 'reload') {
        // 热更新完成：刷新页面加载新 bundle
        window.location.reload()
        return
      }
      if (msg?.type !== 'control') return
      const action = msg.action
      if (!action) return
      if (action === 'nav' || action === 'ok' || action === 'back') {
        // 方向键/OK/返回：合成 D-pad 键盘事件，交给 tvCore 空间导航
        const code =
          action === 'nav'
            ? ({ up: 38, down: 40, left: 37, right: 39 } as Record<string, number>)[String(msg.value)]
            : action === 'ok'
              ? 13
              : 4
        if (code) {
          window.dispatchEvent(new KeyboardEvent('keydown', { keyCode: code, which: code, bubbles: true, cancelable: true }))
        }
      } else {
        // 播放/切歌/音量/设置等：复用遥控链路
        window.dispatchEvent(new CustomEvent('waveforge:remote-control', { detail: { action, payload: msg.value } }))
      }
    } catch {
      // ignore
    }
  }
  ws.onclose = () => {
    ws = null
    // 开发者模式仍开启时自动重连
    if (isDebugMode()) setTimeout(connectWs, 3000)
  }
  ws.onerror = () => {
    try { ws?.close() } catch { /* ignore */ }
  }
}

function closeWs(): void {
  if (ws) {
    try { ws.close() } catch { /* ignore */ }
    ws = null
  }
}

function reportFrontendError(payload: Record<string, unknown>): void {
  if (!isDebugMode()) return
  try {
    void fetch('http://localhost:3001/api/tv/debug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
  } catch {
    // ignore
  }
}

/** 前端 console 日志批量上报到调试台（电脑端可见前端运行日志） */
let debugReportFailures = 0
function reportFrontendLogs(): void {
  if (!isDebugMode()) return
  // 后端无调试接口（PC 端 local-server 未挂 tv 扩展）：连续失败后停止上报，避免 404 刷屏
  if (debugReportFailures >= 10) return
  const logs = getFrontendLogs()
  if (logs.length <= lastReportedLogs) return
  const batch = logs.slice(lastReportedLogs)
  lastReportedLogs = logs.length
  try {
    void fetch('http://localhost:3001/api/tv/debug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: batch }),
    })
      .then((r) => { if (!r.ok) debugReportFailures++ })
      .catch(() => { debugReportFailures++ })
  } catch {
    debugReportFailures++
  }
}

export function installDebugRemote(): void {
  // TV 调试（:3008）仅在 Android/TV 端启用（PC 端 3002/3008 是其它服务，禁用避免 404/连接噪音）
  if (!isAndroid()) return
  const sync = () => {
    const enabled = isDebugMode()
    syncBackend(enabled)
    if (enabled) connectWs()
    else closeWs()
  }
  window.addEventListener('developerModeChanged', sync)
  window.addEventListener('error', (e) => {
    reportFrontendError({
      source: 'window.onerror',
      message: e.message,
      stack: e.error instanceof Error ? e.error.stack : undefined,
      url: typeof e.filename === 'string' ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    })
  })
  window.addEventListener('unhandledrejection', (e) => {
    reportFrontendError({
      source: 'unhandledrejection',
      message: e.reason instanceof Error ? e.reason.message : String(e.reason),
      stack: e.reason instanceof Error ? e.reason.stack : undefined,
    })
  })
  setInterval(reportFrontendLogs, 2000)
  sync() // 初始同步（开发者模式默认关 → 不启调试服务）
}
