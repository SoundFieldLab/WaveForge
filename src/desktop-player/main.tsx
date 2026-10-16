// 帧率限流：必须是第一个 import（频谱/封面脉动由 rAF 驱动）。
// 模块求值阶段即替换全局 requestAnimationFrame，见 utils/frameRateLimiter.ts。
import '../utils/frameRateLimiter'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import DesktopPlayerApp from './DesktopPlayerApp'
import ErrorBoundary from '../components/ErrorBoundary'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary compact>
      <DesktopPlayerApp />
    </ErrorBoundary>
  </StrictMode>,
)
