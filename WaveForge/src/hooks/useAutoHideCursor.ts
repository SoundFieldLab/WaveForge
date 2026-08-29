import { useCallback, useEffect, useRef } from 'react'

/**
 * 鼠标指针本体自动隐藏：无操作 timeoutMs（默认 8s）后把元素光标设为 none（渐隐），
 * 鼠标一动立即恢复。只影响光标本身，不碰任何控件/弹层的显隐逻辑。
 *
 * 返回回调 ref：元素出现时挂接监听、消失（条件渲染卸载）时自动清理——
 * 适合播放页表面这类「晚于 App 挂载/随条件卸载」的元素。
 */
export function useAutoHideCursor(timeoutMs = 8000): (el: HTMLElement | null) => void {
  const currentElRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const showRef = useRef<(() => void) | null>(null)

  const callbackRef = useCallback((el: HTMLElement | null) => {
    const prev = currentElRef.current
    if (prev) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = null
      if (showRef.current) {
        prev.removeEventListener('mousemove', showRef.current)
        prev.removeEventListener('mouseenter', showRef.current)
      }
      if (prev.style.cursor === 'none') prev.style.cursor = ''
      showRef.current = null
    }
    currentElRef.current = el
    if (!el) return
    const show = () => {
      if (el.style.cursor) el.style.cursor = ''
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => { el.style.cursor = 'none' }, timeoutMs)
    }
    showRef.current = show
    el.addEventListener('mousemove', show)
    el.addEventListener('mouseenter', show)
    show()
  }, [timeoutMs])

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    const el = currentElRef.current
    if (el && showRef.current) {
      el.removeEventListener('mousemove', showRef.current)
      el.removeEventListener('mouseenter', showRef.current)
      if (el.style.cursor === 'none') el.style.cursor = ''
    }
  }, [])

  return callbackRef
}
