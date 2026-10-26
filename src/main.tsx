// 帧率限流：必须是第一个 import。此模块在求值时替换全局 requestAnimationFrame，
// 之后才轮到 App/framer-motion/three 等模块求值，它们才不会拿到未包装的 rAF。
// 详见 utils/frameRateLimiter.ts 顶部关于 webContents.setFrameRate 失效的说明。
import './utils/frameRateLimiter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-ignore: allow side-effect CSS import without module declaration
import './assets/fonts/fonts.css'
import './index.css'
import './tv/tv.css'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI, setTvModeForced } from './platform'
import { installElectronShim } from './electronShim'

// 懒 chunk 加载失败自动恢复：打包版的 hash 文件名在发版后变化，长时间停留的旧页面
// 切换模式/懒加载面板时会拉到 404（preview server fallback 把 index.html 当 JS 返回，
// 抛 "SyntaxError: Invalid or unexpected token"）。这里兜底：首次失败 → 清掉 vite 缓存
// 标记并整页 reload 一次（用 sessionStorage 防循环）；二次失败就让错误正常抛出。
window.addEventListener('vite:preloadError', event => {
  const marker = 'waveforge:chunk-reloaded'
  if (sessionStorage.getItem(marker)) return
  sessionStorage.setItem(marker, '1')
  event.preventDefault()
  window.location.reload()
})

// React.lazy 用原生 import()，失败不会走 vite:preloadError —— 在 unhandledrejection 兜底
window.addEventListener('unhandledrejection', event => {
  const reason = String((event as PromiseRejectionEvent).reason?.message || (event as PromiseRejectionEvent).reason || '')
  if (!/dynamically imported module|Failed to fetch dynamically|error loading dynamically/i.test(reason)) return
  const marker = 'waveforge:chunk-reloaded'
  if (sessionStorage.getItem(marker)) return
  sessionStorage.setItem(marker, '1')
  event.preventDefault()
  window.location.reload()
})
import { startTv } from './tv/tvCore'
import { initPerfMode } from './tv/perfMode'
import { captureFrontendConsole, initDebugMode } from './tv/debugStore'
import { installDebugRemote } from './tv/debugRemote'
import { installMediaKeyBridge } from './tv/mediaKeyBridge'
import { installRemoteBridge } from './tv/remoteBridge'
import PlatformRoot from './PlatformRoot'
import { installNativeTooltipSuppressor } from './utils/suppressNativeTooltips'

// 平台初始化：标记 html[data-platform]/tv-mode（供 CSS 焦点适配），
// 并给非 Electron 环境（Android WebView / 纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()

// ── 引擎未就绪自动重试（Android 首屏提速配套）──
// Android 端原生壳服务先出首屏，Node 引擎在后台启动；未就绪期间反代返回
// 503 + X-WaveForge-Engine-Starting。这里在 fetch 层透明重试（最多 ~24s），
// 让所有页面/接口在上层无感知地等到引擎可用，而不是直接甩错误态。
;(() => {
  const nativeFetch = window.fetch.bind(window)
  const ENGINE_HEADER = 'X-WaveForge-Engine-Starting'
  // 首启要解压 ~100MB 核心资产 + Node 冷启，可能 40-60s；重试窗口留足 72s
  const MAX_RETRIES = 90
  const RETRY_MS = 800
  let notifiedStarting = false
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      // Request 对象 body 只能消费一次：每次重试都用 clone
      const nextInput = input instanceof Request ? input.clone() : input
      try {
        const res = await nativeFetch(nextInput as RequestInfo, init)
        if (res.status === 503 && res.headers.get(ENGINE_HEADER)) {
          if (!notifiedStarting) {
            notifiedStarting = true
            console.info('[BOOT] 引擎启动中，请求自动排队重试…')
          }
          try { await res.body?.cancel() } catch { /* ignore */ }
          await new Promise(resolve => setTimeout(resolve, RETRY_MS))
          continue
        }
        return res
      } catch (err) {
        // 壳服务尚未监听（极早期）或网络暂断：同样退避重试
        if (attempt === MAX_RETRIES) throw err
        await new Promise(resolve => setTimeout(resolve, RETRY_MS))
      }
    }
    return nativeFetch(input as RequestInfo, init)
  }
})()

// 凭据安全存储：启动时把 localStorage 遗留的各平台登录态迁移进主进程 safeStorage
// （DPAPI 加密落盘），此后凭据读写走 secureTokenStore（内存缓存 + 加密持久化）。
import('./services/secureTokenStore').then(({ initSecureTokenStore }) => initSecureTokenStore()).catch(() => undefined)
// 全局禁用原生 title 悬浮气泡（用户要求：样式与播放器视觉不符）
installNativeTooltipSuppressor()
// 全局兜底禁用图片原生拖拽：index.css 的 -webkit-user-drag 已覆盖常规场景，
// 这里再挡一层 dragstart（含运行时插入的非 React 节点），避免封面被拖出窗口。
document.addEventListener('dragstart', event => {
  const target = event.target as Element | null
  if (target && typeof target.closest === 'function' && target.closest('img')) event.preventDefault()
}, true)

// ── AutoMix 桥自检（诊断用）：确认 window.electron 真实可用性 ──
// 若 preload 未加载，isDesktop() 会误判为 web 并装桩（render 抛"仅桌面版可用"、
// 无 automixLog/analysis）→ automix 永远交叉。此标记写入 localStorage 便于读取。
try {
  const w = window as unknown as { electron?: { system?: { minimize?: unknown }; automixLog?: (s: string, m: string) => Promise<unknown> } }
  const bridgeOk = Boolean(w.electron?.system && typeof w.electron.system.minimize === 'function')
  localStorage.setItem('wf_bridge_test', bridgeOk ? 'ok' : 'missing')
  if (bridgeOk && w.electron?.automixLog) {
    w.electron.automixLog('bridge', 'electron bridge OK').catch(() => undefined)
  }
} catch {
  // 忽略
}

// 渲染端 console.error 转发到后端日志（preload 可用时），捕获真实错误。
// Error / DOMException 的 name、message、stack 都是不可枚举属性（DOMException 还在原型上），
// JSON.stringify 只会得到 "{}"，必须单独取名字和消息，否则日志里只剩一个空对象、查不出原因。
function describeConsoleArg(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const frame = value.stack?.split('\n')[1]?.trim()
    return frame ? `${value.name}: ${value.message} @ ${frame}` : `${value.name}: ${value.message}`
  }
  // MediaError / DOMException 这类宿主对象的 code/message 挂在原型上，JSON.stringify 只会得到
  // "{}"——线上日志里就完全看不出是解码失败还是格式不支持。这里显式取出来。
  if (value && typeof value === 'object') {
    const holder = value as { name?: unknown; message?: unknown; code?: unknown }
    const hasCode = typeof holder.code === 'number'
    const hasNameMessage = typeof holder.name === 'string' && typeof holder.message === 'string'
    if (hasCode || hasNameMessage) {
      const name = typeof holder.name === 'string' ? holder.name : 'MediaError'
      return `${name}${hasCode ? ` code=${holder.code}` : ''}${typeof holder.message === 'string' ? ` ${holder.message}` : ''}`
    }
  }
  try { return JSON.stringify(value) } catch { return String(value) }
}

const origConsoleError = console.error
console.error = (...args: unknown[]) => {
  try { origConsoleError(...args) } catch { /* ignore */ }
  try {
    const w = window as unknown as { electron?: { automixLog?: (s: string, m: string) => Promise<unknown> } }
    const text = args.map(describeConsoleArg).join(' ').slice(0, 400)
    w.electron?.automixLog?.('renderer-error', text)?.catch?.(() => undefined)
  } catch { /* ignore */ }
}

// console.warn 同样转发到后端日志：排查「放几首就放不了」这类问题时，重试路径与 URL 失效
// 提示都是 warn 级别——不转发就等于没打。此前只有 error 被捕获。
const origConsoleWarn = console.warn
console.warn = (...args: unknown[]) => {
  try { origConsoleWarn(...args) } catch { /* ignore */ }
  try {
    const w = window as unknown as { electron?: { automixLog?: (s: string, m: string) => Promise<unknown> } }
    const text = args.map(describeConsoleArg).join(' ').slice(0, 400)
    w.electron?.automixLog?.('renderer-warn', text)?.catch?.(() => undefined)
  } catch { /* ignore */ }
}

// TV DPI：TV 端布局基准宽由 initPlatformUI/applyTvScale 在启动时写入 viewport meta
// （width=2133/scale；手机/平板端则写 device-width 保持 dp 布局）。

// TV 遥控器交互层（仅 html.tv-mode 生效）：空间导航/焦点环/软键盘。
// 组件挂载后再调用一次（见 TvKeyboard），确保 React 首帧渲染完就有候选可聚焦。
startTv()

// TV 性能模式：按内存自动选默认档，打上 wf-perf-* 类
initPerfMode()

// 调试模式：捕获前端日志 + 初始化开关状态（面板组件 DebugPanels 按需挂载）
captureFrontendConsole()
initDebugMode()

// 诊断：确认 TV 布局视口（应为 2133；若为设备宽则 viewport 未生效）
console.log(`[VIEWPORT] innerWidth=${window.innerWidth} innerHeight=${window.innerHeight}`)
// 诊断：Tailwind v4 透明度依赖 color-mix（需 Chromium 111+），旧 WebView 不支持会导致颜色失效
try {
  console.log(`[COLOR-MIX] ${CSS.supports('color', 'color-mix(in oklab, red 50%, blue)')}`)
} catch {
  console.log('[COLOR-MIX] 不可检测')
}

// 局域网调试桥（跟随开发者模式，默认开启由后端状态决定）：:3008 日志/崩溃/远程控制
installDebugRemote()

// 遥控器媒体键 → 应用播放控制桥接（仅 tv-mode 生效）。
installMediaKeyBridge()

// TV 端远程遥控器（手机控制电视）：仅 Android 启动（桌面走 Electron remote 桥）。
installRemoteBridge()

// PC 模拟测试：Ctrl+Alt+T 在「TV 遥控器模式 / 鼠标模式」间切换（刷新生效）。
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && e.code === 'KeyT') {
    e.preventDefault()
    setTvModeForced(!document.documentElement.classList.contains('tv-mode'))
    window.location.reload()
  }
})

// 内存观察哨：仅当 localStorage 中设置了 waveforge:memory-debug=1 时生效，
// 用于定位播放期间内存持续增长的来源（控制台执行 localStorage.setItem('waveforge:memory-debug','1') 后重启）。
startMemoryWatchdog()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlatformRoot />
  </StrictMode>,
)
