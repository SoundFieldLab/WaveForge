/**
 * 平台根分流：按 initPlatformUI() 打在 <html> 上的标记决定挂载哪棵 UI 树——
 *  - html.mobile-mode（Android 手机/平板触摸端，或 PC ?ui=phone|tablet 模拟）→ MobileApp
 *  - html.pc-touch（手机/平板 + 设置里选「PC 版布局」）→ 桌面 App 移植（viewport 拉宽到
 *    PC 基准等比缩放完整桌面排版 + 沉浸全屏；切回移动布局的入口在 设置→移动端，与 TV 端同构）
 *  - 其余（PC 桌面 / Android TV）→ App + TvKeyboard + DebugPanels
 * Fold 折叠形态切换（phone ↔ tablet）在 MobileApp 内部自适应，无需换树；
 * 只有 TV ↔ 触摸端 / 移动 ↔ PC 布局跨树变化会整树切换（播放中断，可接受）。
 */
import { lazy, Suspense, useEffect, useState } from 'react'
import { isMobileModeActive } from './platform'
import ErrorBoundary from './components/ErrorBoundary'

const MobileApp = lazy(() => import('./mobile/MobileApp'))
const DesktopApp = lazy(() => import('./App'))
const TvKeyboard = lazy(() => import('./tv/TvKeyboard'))
const DebugPanels = lazy(() => import('./tv/DebugPanels'))

function RootSplash() {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#0a0f14', color: '#9db2cc',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 15, fontFamily: 'system-ui, sans-serif',
    }}>
      正在启动 WaveForge…
    </div>
  )
}

export default function PlatformRoot() {
  const [mobile, setMobile] = useState(() => isMobileModeActive())
  useEffect(() => {
    const onPlatformChanged = () => setMobile(isMobileModeActive())
    window.addEventListener('waveforge-platform-changed', onPlatformChanged)
    return () => window.removeEventListener('waveforge-platform-changed', onPlatformChanged)
  }, [])

  if (mobile) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<RootSplash />}>
          <MobileApp />
        </Suspense>
      </ErrorBoundary>
    )
  }
  return (
    <ErrorBoundary>
      <Suspense fallback={<RootSplash />}>
        <DesktopApp />
        <TvKeyboard />
        <DebugPanels />
      </Suspense>
    </ErrorBoundary>
  )
}
