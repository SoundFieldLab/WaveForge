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
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI, setTvModeForced, applyTvScale } from './platform'
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
import DebugPanels from './tv/DebugPanels'
import { installMediaKeyBridge } from './tv/mediaKeyBridge'
import { installRemoteBridge } from './tv/remoteBridge'
import TvKeyboard from './tv/TvKeyboard'
import ErrorBoundary from './components/ErrorBoundary'
import { installNativeTooltipSuppressor } from './utils/suppressNativeTooltips'

// 平台初始化：标记 html[data-platform]/tv-mode（供 CSS 焦点适配），
// 并给非 Electron 环境（Android WebView / 纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()
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

// TV DPI：TV 端布局基准宽由 android 构建产物的 index.html 静态 viewport 决定
// （build-android-assets.mjs 把 dist/index.html 的 viewport 设为 width=2259，即
// 1920/0.85，软件 UI 整体缩小 15%；桌面构建不受影响）。JS 动态改 meta 无效
// （reload 会重置 meta），因此这里不再做运行时缩放。

// TV 遥控器交互层（仅 html.tv-mode 生效）：空间导航/焦点环/软键盘。
// 组件挂载后再调用一次（见 TvKeyboard），确保 React 首帧渲染完就有候选可聚焦。
startTv()

// TV DPI 缩放：启动时按 localStorage 档位应用（CSS zoom）
applyTvScale()

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
    <ErrorBoundary>
      <App />
      <TvKeyboard />
      <DebugPanels />
    </ErrorBoundary>
  </StrictMode>,
)
