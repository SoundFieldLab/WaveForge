/**
 * TV 局域网调试桥（跟随开发者模式，默认关闭）：
 *  - 开发者模式开启时：通知后端启动 :3008 调试服务，并连 ws://localhost:3008/ws
 *    接收电脑调试台（http://<设备IP>:3008）发出的控制命令 → 派发到应用执行；
 *  - 前端 JS 错误（window.onerror/unhandledrejection）上报到后端调试服务，
 *    电脑端无需 adb 即可看到崩溃原因。
 */
import { isDebugMode, getFrontendLogsSince } from './debugStore'
import { isAndroid } from '../platform'

let ws: WebSocket | null = null
let lastReportedLogs = 0
// :3008 调试桥配对令牌（POST /api/tv/debug-mode 返回；3008 的 verifyClient 校验它）
let debugBridgeToken = ''

function syncBackend(enabled: boolean): void {
  try {
    void fetch('http://localhost:3001/api/tv/debug-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { debugBridgeToken = String(data?.debugToken || '') })
      .catch(() => {})
  } catch {
    // ignore
  }
}

function connectWs(): void {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
  // 先确认 3008 是 TV 调试服务（校验特征标记，任何占用 3008 的其它服务都不连，避免误发命令/反复重试）
  fetch('http://localhost:3008/', { cache: 'no-store' })
    .then((r) => (r.ok ? r.text() : ''))
    .then((html) => {
      if (html.includes('WaveForge TV 调试台')) connectWsDirect()
    })
    .catch(() => { /* 调试服务未运行：不连接 */ })
}

function connectWsDirect(): void {
  if (!debugBridgeToken) {
    // verifyClient 要求令牌：开关刚打开时 syncBackend 可能还没回来，等下一轮重连
    if (isDebugMode()) setTimeout(connectWs, 3000)
    return
  }
  try {
    ws = new WebSocket(`ws://localhost:3008/ws?token=${encodeURIComponent(debugBridgeToken)}`)
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
          // 派发到 document（capture 监听都在 document 上；派发到 window 的合成事件
          // 传播路径不含 document，tvCore/mediaKeyBridge 收不到）。
          // OK（13）需要 keydown+keyup 配对：tvCore 在 keyup 时才执行激活（支持长按右键）
          const init = { keyCode: code, which: code, bubbles: true, cancelable: true }
          document.dispatchEvent(new KeyboardEvent('keydown', init))
          if (code === 13) {
            setTimeout(() => document.dispatchEvent(new KeyboardEvent('keyup', init)), 30)
          }
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

// 错误上报节流：渲染循环里的异常（rAF 内每帧抛错）曾以 60 条/秒的速度打爆后端
// crash.log 落盘。按 (message) 去重 + 全局每分钟 10 条上限，超出静默丢弃。
const reportedErrorMessages = new Map<string, number>()
const ERROR_REPORT_WINDOW_MS = 60_000
const ERROR_REPORT_MAX_PER_WINDOW = 10
let errorReportWindowStart = 0
let errorReportWindowCount = 0

function reportFrontendError(payload: Record<string, unknown>): void {
  if (!isDebugMode()) return
  try {
    const key = String(payload.message || '')
    const now = Date.now()
    if (now - errorReportWindowStart > ERROR_REPORT_WINDOW_MS) {
      errorReportWindowStart = now
      errorReportWindowCount = 0
    }
    errorReportWindowCount += 1
    if (errorReportWindowCount > ERROR_REPORT_MAX_PER_WINDOW) return
    const lastAt = reportedErrorMessages.get(key) || 0
    if (now - lastAt < 5000) return
    if (reportedErrorMessages.size > 64) reportedErrorMessages.clear()
    reportedErrorMessages.set(key, now)
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
  // 按 total 差量取尾部：环形缓冲裁剪后 length 恒等于上限，若按 length 判增量，
  // 第一次上报后（lastReported = 200）后续日志会全部漏报——调试台只剩前 200 条。
  const { logs, total } = getFrontendLogsSince(lastReportedLogs)
  if (!logs.length) return
  const batch = logs
  lastReportedLogs = total
  try {
    void fetch('http://localhost:3001/api/tv/debug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: batch }),
    })
      .then((r) => { if (r.ok) debugReportFailures = 0; else debugReportFailures++ })
      .catch(() => { debugReportFailures++ })
  } catch {
    debugReportFailures++
  }
}

export function installDebugRemote(): () => void {
  // TV 调试（:3008）仅在 Android/TV 端启用（PC 端 3002/3008 是其它服务，禁用避免 404/连接噪音）
  if (!isAndroid()) return () => undefined
  const sync = () => {
    const enabled = isDebugMode()
    syncBackend(enabled)
    if (enabled) setTimeout(connectWs, 400) // 等 syncBackend 返回 debugToken 再连（无令牌会被 verifyClient 拒）
    else closeWs()
  }
  const onWindowError = (e: ErrorEvent) => {
    reportFrontendError({
      source: 'window.onerror',
      message: e.message,
      stack: e.error instanceof Error ? e.error.stack : undefined,
      url: typeof e.filename === 'string' ? `${e.filename}:${e.lineno}:${e.colno}` : undefined,
    })
  }
  const onUnhandledRejection = (e: PromiseRejectionEvent) => {
    reportFrontendError({
      source: 'unhandledrejection',
      message: e.reason instanceof Error ? e.reason.message : String(e.reason),
      stack: e.reason instanceof Error ? e.reason.stack : undefined,
    })
  }
  window.addEventListener('developerModeChanged', sync)
  window.addEventListener('error', onWindowError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  // 定时器句柄必须留存：此前只 setInterval 且丢弃返回值，运行期无法停止上报轮询。
  const reportTimer = window.setInterval(reportFrontendLogs, 2000)
  sync() // 初始同步（开发者模式默认关 → 不启调试服务）

  return () => {
    window.removeEventListener('developerModeChanged', sync)
    window.removeEventListener('error', onWindowError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
    window.clearInterval(reportTimer)
    closeWs()
  }
}
