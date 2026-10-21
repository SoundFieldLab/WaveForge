import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'

/** 只观察正文尺寸与滚动位置，避免滚动提示牵动参数页和实时读数。 */
export function ContentViewport({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  const viewportRef = useRef<HTMLElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const hintRef = useRef<HTMLButtonElement>(null)
  const [hasMore, setHasMore] = useState(false)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    let frame: number | undefined

    const measure = () => {
      frame = undefined
      // 容忍缩放和小数像素误差，抵达末尾后不再闪现提示。
      const more = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 4
      if (!more && document.activeElement === hintRef.current) {
        viewport.focus({ preventScroll: true })
      }
      setHasMore(more)
    }
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(measure)
    }

    viewport.scrollTop = 0
    measure()
    viewport.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // 展开效果、生成分享串、切换 EQ 模式等都会改变正文高度。
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    observer?.observe(viewport)
    observer?.observe(content)
    return () => {
      viewport.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
    }
  }, [pageKey])

  const scrollFurther = () => {
    const viewport = viewportRef.current
    if (!viewport) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    viewport.scrollBy({ top: viewport.clientHeight * 0.75, behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  return (
    <div className="@container grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]" style={{ background: '#fbfdfc' }}>
      <main
        ref={viewportRef}
        id="hse-page-content"
        aria-label="当前调音页面内容"
        tabIndex={0}
        className="h-full overflow-y-auto overscroll-contain p-4 outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-[#006a63] sm:p-6"
        style={{ scrollPaddingBottom: '32px', scrollbarGutter: 'stable' }}
      >
        <div ref={contentRef}>{children}</div>
      </main>
      {hasMore && (
        <div className="flex justify-center border-t border-[#dce9e5] bg-[#fbfdfc] px-4 py-1" >
          <button
            ref={hintRef}
            type="button"
            aria-controls="hse-page-content"
            onClick={scrollFurther}
            className="hse-glass-button pointer-events-auto inline-flex min-h-8 items-center gap-2 rounded-full px-4 text-xs font-semibold text-[#006a63]"
          >
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
            向下查看更多
          </button>
        </div>
      )}
    </div>
  )
}
