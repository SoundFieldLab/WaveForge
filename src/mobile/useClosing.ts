/**
 * 关闭动画 hook：调用 close() 后先打 .is-closing 播退出动画，180ms 后真卸载。
 * 用法：const [visible, close] = useClosing(onClosed) —— visible 控制挂载，
 * close() 先播动画再触发 onClosed（父组件把 state 置 null）。
 */
import { useCallback, useRef, useState } from 'react'

const CLOSE_ANIM_MS = 190

export function useClosing(onClosed: () => void): [boolean, () => void, boolean] {
  const [visible, setVisible] = useState(true)
  const [closing, setClosing] = useState(false)
  const timerRef = useRef<number | null>(null)

  const close = useCallback(() => {
    if (closing) return
    setClosing(true)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      setVisible(false)
      onClosed()
    }, CLOSE_ANIM_MS)
  }, [closing, onClosed])

  return [visible, close, closing]
}
