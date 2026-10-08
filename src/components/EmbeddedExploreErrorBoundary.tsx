import { Component, type ReactNode } from 'react'

/** 判断 lazy chunk 加载失败（重建后旧哈希分包被替换 / 弱网 / 杀软拦截 js） */
function isChunkLoadError(error: Error | null | undefined): boolean {
  const message = error?.message || ''
  return error?.name === 'ChunkLoadError' ||
    /Loading chunk|Importing a module script failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(message)
}

/** 嵌入式探索页（QQ/网易云）的局部错误边界：崩溃时显示错误详情而不是黑掉整个窗口 */
export default class EmbeddedExploreErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(`[TraditionalView] ${this.props.label} 渲染崩溃:`, error, info?.componentStack)
    // lazy chunk 加载失败（重建/升级后旧 index 引用的哈希分包已被替换、弱网）走整页重载自愈：
    // 这类错误「重试」必然复败（失败的分包名烘焙在旧 bundle 里），重载拿新构建是唯一可靠恢复；
    // 与根级 ErrorBoundary 同一口径。防循环用「时间窗」而不是一次性标记：
    // 开发期可能连续重建多次（每轮哈希都变），一次性标记会让第二次之后只能看到错误页。
    if (!isChunkLoadError(error)) return
    try {
      const flag = 'wf:chunk-error-reloaded'
      const last = Number(sessionStorage.getItem(flag) || 0)
      if (Date.now() - last > 20_000) {
        sessionStorage.setItem(flag, String(Date.now()))
        window.location.reload()
      }
    } catch {
      // sessionStorage 不可用（隐私模式等）时保留下方兜底 UI
    }
  }

  render() {
    if (this.state.error) {
      // chunk 失效时「重试」无效（旧分包已不存在）：把主操作换成整页刷新
      const chunkError = isChunkLoadError(this.state.error)
      return (
        <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="text-sm font-medium text-rose-300">{this.props.label} 渲染出错</div>
          <pre className="max-w-[640px] overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/40 p-3 text-left text-xs text-white/60">
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack?.slice(0, 1200)}
          </pre>
          <button
            type="button"
            onClick={() => (chunkError ? window.location.reload() : this.setState({ error: null }))}
            className="rounded-full px-4 py-1.5 text-xs text-white"
            style={{ background: 'var(--explore-accent, #fa2d48)' }}
          >
            {chunkError ? '页面已更新，刷新加载' : '重试'}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
