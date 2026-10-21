import { useEffect, useRef, type RefObject } from 'react'

/** 参数事件的轻微回弹；数值不位移，减少动态效果时立即呈现最终状态。 */
export function useStateFeedback(value: unknown, ref: RefObject<HTMLElement | null>) {
  const previous = useRef(value)
  useEffect(() => {
    if (Object.is(previous.current, value)) return
    previous.current = value
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = ref.current?.animate?.(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.025)', offset: 0.55 }, { transform: 'scale(1)' }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.3,1)' },
    )
    return () => animation?.cancel()
  }, [value, ref])
}
