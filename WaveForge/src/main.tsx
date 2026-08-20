import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './tv/tv.css'
import App from './App'
import { startMemoryWatchdog } from './utils/memoryWatchdog'
import { initPlatformUI, setTvModeForced } from './platform'
import { installElectronShim } from './electronShim'
import { startTv } from './tv/tvCore'
import { initPerfMode } from './tv/perfMode'
import { captureFrontendConsole, initDebugMode } from './tv/debugStore'
import { installDebugRemote } from './tv/debugRemote'
import DebugPanels from './tv/DebugPanels'
import { installMediaKeyBridge } from './tv/mediaKeyBridge'
import { installRemoteBridge } from './tv/remoteBridge'
import TvKeyboard from './tv/TvKeyboard'

// 平台初始化：标记 html[data-platform]/tv-mode（供 CSS 焦点适配），
// 并给非 Electron 环境（Android WebView / 纯浏览器）注入 window.electron 最小桩。
initPlatformUI()
installElectronShim()

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

// 渲染端 console.error 转发到后端日志（preload 可用时），捕获真实错误
const origConsoleError = console.error
console.error = (...args: unknown[]) => {
  try { origConsoleError(...args) } catch { /* ignore */ }
  try {
    const w = window as unknown as { electron?: { automixLog?: (s: string, m: string) => Promise<unknown> } }
    const text = args.map(a => {
      try { return typeof a === 'string' ? a : JSON.stringify(a) } catch { return String(a) }
    }).join(' ').slice(0, 400)
    w.electron?.automixLog?.('renderer-error', text)?.catch?.(() => undefined)
  } catch { /* ignore */ }
}

// TV DPI：TV 端布局基准宽由 android 构建产物的 index.html 静态 viewport 决定
// （build-android-assets.mjs 把 dist/index.html 的 viewport 设为 width=2259，即
// 1920/0.85，软件 UI 整体缩小 15%；桌面构建不受影响）。JS 动态改 meta 无效
// （reload 会重置 meta），因此这里不再做运行时缩放。

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

// 局域网调试桥（跟随开发者模式，默认关闭）：:3002 日志/崩溃/远程控制
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
    <App />
    <TvKeyboard />
    <DebugPanels />
  </StrictMode>,
)
