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
  const run = () => {
    if (cancelled) return
    for (const load of loaders) {
      void load().catch(() => undefined)
    }
  }
  const ric = (window as any).requestIdleCallback as ((cb: () => void, opts?: { timeout?: number }) => number) | undefined
  const cic = (window as any).cancelIdleCallback as ((handle: number) => void) | undefined
  let handle: number
  if (typeof ric === 'function') {
    handle = ric(run, { timeout: timeoutMs })
  } else {
    handle = window.setTimeout(run, 2000) as unknown as number
  }
  return () => {
    cancelled = true
    if (typeof ric === 'function' && typeof cic === 'function') cic(handle)
    else window.clearTimeout(handle)
  }
}
