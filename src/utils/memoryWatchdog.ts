/**
 * 内存观察哨（仅调试用，不影响正常功能）
 *
 * 在开发者工具控制台执行 localStorage.setItem('waveforge:memory-debug', '1')
 * 并重启应用后生效：每 30 秒输出一次 JS 堆占用与页面内音频/视频元素数量，
 * 用于定位播放期间内存持续增长的来源。
 */
export function startMemoryWatchdog(intervalMs = 30_000): () => void {
  if (typeof window === 'undefined') return () => undefined
  try {
    if (localStorage.getItem('waveforge:memory-debug') !== '1') return () => undefined
  } catch {
    return () => undefined
  }

  const startedAt = Date.now()
  console.log('[MemoryWatchdog] 已启用，每 30 秒输出一次内存快照')
  const timer = window.setInterval(() => {
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1)
    const mediaElements = document.querySelectorAll('audio,video').length
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number }
    }).memory
    if (memory) {
      console.log(
        `[MemoryWatchdog] +${elapsedMin}min JS堆=${(memory.usedJSHeapSize / 1048576).toFixed(0)}MB ` +
        `总量=${(memory.totalJSHeapSize / 1048576).toFixed(0)}MB 媒体元素=${mediaElements}`,
      )
    } else {
      console.log(`[MemoryWatchdog] +${elapsedMin}min 无 performance.memory 支持 媒体元素=${mediaElements}`)
    }
  }, intervalMs)
  return () => window.clearInterval(timer)
}
