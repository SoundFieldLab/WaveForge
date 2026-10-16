// 帧率限流：必须是第一个 import（逐字歌词是 rAF 驱动的重灾区）。
// 模块求值阶段即替换全局 requestAnimationFrame，见 utils/frameRateLimiter.ts。
import '../utils/frameRateLimiter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// @ts-ignore: allow side-effect CSS import without module declaration
import '../assets/fonts/fonts.css'
// @ts-ignore: allow side-effect CSS import without module declaration
import './style.css'
import DesktopLyricsApp from './DesktopLyricsApp'
import ErrorBoundary from '../components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary compact>
      <DesktopLyricsApp />
    </ErrorBoundary>
  </StrictMode>,
)
