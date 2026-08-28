import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 独立小窗口（桌面歌词/播放器）使用更紧凑的降级 UI */
  compact?: boolean
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 根级错误边界。全仓库此前没有任何 ErrorBoundary：lazy chunk 加载失败（升级后旧
 * index.html 引用已失效的哈希 chunk / 杀软拦截 js / 弱网）或任意组件渲染抛错都会
 * 卸载整棵 React 树，窗口永久白屏且无任何恢复入口。
 *
 * 恢复策略：
 *  - chunk 加载失败 → 自动重载一次（React.lazy 的 rejection 被永久缓存，重载是唯一
 *    可靠恢复手段；sessionStorage 标记防循环重载）；
 *  - 其他渲染错误 → 显示兜底 UI，用户可手动「重载窗口」。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 渲染树崩溃:', error, info.componentStack)
    const message = error?.message || ''
    const isChunkError =
      error?.name === 'ChunkLoadError' ||
      /Loading chunk|Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(message)
    if (!isChunkError) return
    try {
      const flag = 'wf:chunk-error-reloaded'
      if (!sessionStorage.getItem(flag)) {
        sessionStorage.setItem(flag, String(Date.now()))
        window.location.reload()
      }
    } catch {
      // sessionStorage 不可用（隐私模式等）时直接显示兜底 UI
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.compact) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(8, 10, 16, 0.92)',
            color: 'rgba(255,255,255,0.85)',
            fontSize: 13,
            gap: 12,
            flexDirection: 'column',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <span>窗口渲染出错</span>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '6px 18px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.2)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            重载
          </button>
        </div>
      )
    }
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0e14',
          color: 'rgba(255,255,255,0.85)',
          fontFamily: 'system-ui, sans-serif',
          flexDirection: 'column',
          gap: 16,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>WaveForge 澜音工坊</div>
        <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', maxWidth: 460, lineHeight: 1.6 }}>
          界面渲染出现异常，已停止渲染以保护数据。点击下方按钮重载窗口通常可恢复正常。
        </div>
        <pre
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.35)',
            maxWidth: 640,
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            margin: 0,
          }}
        >
          {error.message}
        </pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 28px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.2)',
            background: 'rgba(255,255,255,0.1)',
            color: '#fff',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          重载窗口
        </button>
      </div>
    )
  }
}
