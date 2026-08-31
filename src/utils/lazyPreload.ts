/**
 * 懒加载模块的空闲预热。
 *
 * 懒加载 chunk 首次使用时才下载 + 编译（dev 模式还是按需即时转换），
 * 用户第一次点开设置 / 弹窗时会卡 0.5~2 秒。视图挂载后调用本工具，
 * 在浏览器空闲时提前触发 import() 把 chunk 拉进来，首次点击就是热的。
 * 传入的 loader 必须是动态 import（`() => import('./Xxx')`），
 * 写成静态 import 会把模块拉回主包，失去代码分割的意义。
 */
export function preloadOnIdle(loaders: Array<() => Promise<unknown>>, timeoutMs = 4000): () => void {
  if (typeof window === 'undefined') return () => undefined
  let cancelled = false
  let index = 0
  let handle: number | null = null
  const idleWindow = window as typeof window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (handle: number) => void
  }

  const scheduleNext = () => {
    if (cancelled || index >= loaders.length) return
    if (typeof idleWindow.requestIdleCallback === 'function') {
      handle = idleWindow.requestIdleCallback(runNext, { timeout: timeoutMs })
    } else {
      handle = window.setTimeout(runNext, 2000)
    }
  }

  const runNext = () => {
    handle = null
    if (cancelled) return
    const load = loaders[index++]
    void load().catch(() => undefined).finally(scheduleNext)
  }

  scheduleNext()
  return () => {
    cancelled = true
    if (handle === null) return
    if (typeof idleWindow.requestIdleCallback === 'function' && typeof idleWindow.cancelIdleCallback === 'function') {
      idleWindow.cancelIdleCallback(handle)
    } else {
      window.clearTimeout(handle)
    }
    handle = null
  }
}
