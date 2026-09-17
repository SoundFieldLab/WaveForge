import {
  Children,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

type HorizontalShelfProps = {
  children: ReactNode
  ariaLabel: string
  className?: string
  viewportClassName?: string
  itemClassName?: string
  rightPeek?: number | string
  edgeHotZoneWidth?: number
  edgeControls?: 'always' | 'hover'
  edgeControlSize?: 'default' | 'compact'
}

type DragState = {
  pointerId: number
  startX: number
  startScrollLeft: number
  lastX: number
  lastTime: number
  velocity: number
  moved: boolean
}

const DRAG_THRESHOLD = 6
const EDGE_EPSILON = 2
const INERTIA_PROJECTION_MS = 180

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function HorizontalShelf({
  children,
  ariaLabel,
  className = '',
  viewportClassName = '',
  itemClassName = '',
  rightPeek,
  edgeHotZoneWidth = 56,
  edgeControls = 'hover',
  edgeControlSize = 'compact',
}: HorizontalShelfProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const animationRef = useRef<number | null>(null)
  const suppressTimerRef = useRef<number | null>(null)
  const suppressActivationRef = useRef(false)
  const dragRef = useRef<DragState>({
    pointerId: -1,
    startX: 0,
    startScrollLeft: 0,
    lastX: 0,
    lastTime: 0,
    velocity: 0,
    moved: false,
  })
  const [canScrollLeft, setCanScrollLeft] = useState(false)
  const [canScrollRight, setCanScrollRight] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [hotEdge, setHotEdge] = useState<'left' | 'right' | null>(null)

  const updateEdges = useCallback(() => {
    const node = viewportRef.current
    if (!node) return
    const max = Math.max(0, node.scrollWidth - node.clientWidth)
    setCanScrollLeft(node.scrollLeft > EDGE_EPSILON)
    setCanScrollRight(node.scrollLeft < max - EDGE_EPSILON)
  }, [])

  const cancelAnimation = useCallback(() => {
    if (animationRef.current === null) return
    cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }, [])

  const nearestSnapPoint = useCallback((requested: number) => {
    const node = viewportRef.current
    if (!node) return requested
    const max = Math.max(0, node.scrollWidth - node.clientWidth)
    const clamped = Math.min(max, Math.max(0, requested))
    const points = Array.from(node.children, child => Math.min(max, (child as HTMLElement).offsetLeft))
    if (points.length === 0) return clamped
    return points.reduce((nearest, point) => (
      Math.abs(point - clamped) < Math.abs(nearest - clamped) ? point : nearest
    ), points[0])
  }, [])

  const animateTo = useCallback((requested: number, duration = 280) => {
    const node = viewportRef.current
    if (!node) return
    cancelAnimation()
    const max = Math.max(0, node.scrollWidth - node.clientWidth)
    const target = Math.min(max, Math.max(0, requested))
    const start = node.scrollLeft
    if (prefersReducedMotion() || duration <= 0 || Math.abs(target - start) < 1) {
      node.scrollLeft = target
      updateEdges()
      return
    }
    const startedAt = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      node.scrollLeft = start + (target - start) * eased
      updateEdges()
      if (progress < 1) animationRef.current = requestAnimationFrame(step)
      else animationRef.current = null
    }
    animationRef.current = requestAnimationFrame(step)
  }, [cancelAnimation, updateEdges])

  useEffect(() => {
    const node = viewportRef.current
    if (!node) return
    updateEdges()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateEdges) : null
    observer?.observe(node)
    Array.from(node.children).forEach(child => observer?.observe(child))
    return () => observer?.disconnect()
  }, [children, updateEdges])

  useEffect(() => () => {
    cancelAnimation()
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current)
  }, [cancelAnimation])

  const suppressActivationAfterDrag = () => {
    suppressActivationRef.current = true
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current)
    suppressTimerRef.current = window.setTimeout(() => {
      suppressActivationRef.current = false
      suppressTimerRef.current = null
    }, 500)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const node = viewportRef.current
    if (!node) return
    cancelAnimation()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: node.scrollLeft,
      lastX: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
      moved: false,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const node = viewportRef.current
    const drag = dragRef.current
    if (!node || drag.pointerId !== event.pointerId) return
    const distance = event.clientX - drag.startX
    if (Math.abs(distance) >= DRAG_THRESHOLD && !drag.moved) {
      drag.moved = true
      node.setPointerCapture?.(event.pointerId)
      setIsDragging(true)
    }
    if (!drag.moved) return
    event.preventDefault()
    const elapsed = event.timeStamp - drag.lastTime
    if (elapsed > 0) {
      const instantaneousVelocity = -(event.clientX - drag.lastX) / elapsed
      drag.velocity = drag.velocity * 0.65 + instantaneousVelocity * 0.35
    }
    drag.lastX = event.clientX
    drag.lastTime = event.timeStamp
    node.scrollLeft = drag.startScrollLeft - distance
    updateEdges()
  }

  const finishDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const node = viewportRef.current
    const drag = dragRef.current
    if (!node || drag.pointerId !== event.pointerId) return
    if (node.hasPointerCapture?.(event.pointerId)) node.releasePointerCapture?.(event.pointerId)
    drag.pointerId = -1
    setIsDragging(false)
    if (!drag.moved) {
      updateEdges()
      return
    }
    suppressActivationAfterDrag()
    const projected = cancelled ? node.scrollLeft : node.scrollLeft + drag.velocity * INERTIA_PROJECTION_MS
    const max = Math.max(0, node.scrollWidth - node.clientWidth)
    animateTo(Math.min(max, Math.max(0, projected)), cancelled ? 0 : 160)
  }

  const suppressDraggedActivation = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressActivationRef.current) return
    event.preventDefault()
    event.stopPropagation()
  }

  const scrollPage = (direction: -1 | 1) => {
    const node = viewportRef.current
    if (!node) return
    const pageDistance = Math.max(280, node.clientWidth * 0.82)
    animateTo(nearestSnapPoint(node.scrollLeft + direction * pageDistance))
  }

  const updateHotEdge = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (edgeControls !== 'hover') return
    if (event.pointerType === 'touch') return
    const bounds = event.currentTarget.getBoundingClientRect()
    const localX = event.clientX - bounds.left
    if (localX <= edgeHotZoneWidth) setHotEdge('left')
    else if (localX >= bounds.width - edgeHotZoneWidth) setHotEdge('right')
    else setHotEdge(null)
  }

  const peekStyle = rightPeek === undefined
    ? undefined
    : ({ paddingInlineEnd: typeof rightPeek === 'number' ? `${rightPeek}px` : rightPeek } as CSSProperties)
  // 官网同款：可横向滚动的一侧用渐隐遮罩，拖拽时边缘内容淡出（而不是被硬切）。
  const EDGE_FADE = '28px'
  const edgeMaskStyle: CSSProperties = (() => {
    const left = canScrollLeft ? `transparent 0, #000 ${EDGE_FADE}` : null
    const right = canScrollRight ? `#000 calc(100% - ${EDGE_FADE}), transparent 100%` : null
    if (!left && !right) return {}
    const gradient = `linear-gradient(90deg, ${left ?? '#000 0'}, ${right ?? '#000 100%'})`
    return {
      maskImage: gradient,
      WebkitMaskImage: gradient,
    } as CSSProperties
  })()
  const arrowClass = edgeControlSize === 'compact'
    ? 'absolute top-1/2 z-30 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/35 text-white/70 shadow-lg backdrop-blur-md transition-[background-color,color,opacity,transform] hover:bg-white/12 hover:text-white active:scale-95 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60'
    : 'absolute top-1/2 z-30 flex h-20 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/18 bg-white/88 text-black/65 shadow-xl backdrop-blur-md transition-[background-color,color,opacity,transform] hover:bg-white hover:text-black active:scale-95 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80'
  const arrowIconClass = edgeControlSize === 'compact' ? 'h-4 w-4' : 'h-10 w-5'
  const edgeControlClass = (edge: 'left' | 'right') => edgeControls === 'always'
    ? 'pointer-events-auto opacity-100'
    : hotEdge === edge
      ? 'pointer-events-auto opacity-100'
      : 'pointer-events-none opacity-0'

  return (
    <div
      className={`relative px-5 ${className}`}
      onPointerMove={updateHotEdge}
      onPointerLeave={() => setHotEdge(null)}
    >
      <div
        ref={viewportRef}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        data-left-edge={canScrollLeft ? 'scrollable' : 'hidden'}
        data-right-edge={canScrollRight ? 'scrollable' : 'hidden'}
        onScroll={updateEdges}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)}
        onDragStart={event => event.preventDefault()}
        onClickCapture={suppressDraggedActivation}
        onContextMenuCapture={suppressDraggedActivation}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); scrollPage(-1) }
          if (event.key === 'ArrowRight') { event.preventDefault(); scrollPage(1) }
        }}
        className={`wf-no-scrollbar flex gap-4 overflow-x-auto overscroll-x-contain pt-2 pb-2 select-none ${isDragging ? 'cursor-grabbing' : ''} ${viewportClassName}`}
        style={{ touchAction: 'pan-y pinch-zoom', ...peekStyle, ...edgeMaskStyle }}
      >
        {Children.map(children, child => (
          <div
            data-horizontal-shelf-item=""
            className={`shrink-0 ${isDragging ? 'shadow-[0_8px_24px_rgba(0,0,0,0.18)]' : ''} ${itemClassName}`}
          >
            {child}
          </div>
        ))}
      </div>
      {canScrollLeft && (
        <button
          type="button"
          aria-label={`向左浏览${ariaLabel}`}
          title="向左浏览"
          onClick={() => scrollPage(-1)}
          className={`${arrowClass} -left-5 ${edgeControlClass('left')}`}
        >
          <ChevronLeft className={arrowIconClass} strokeWidth={edgeControlSize === 'compact' ? 2 : 1.5} />
        </button>
      )}
      {canScrollRight && (
        <button
          type="button"
          aria-label={`向右浏览${ariaLabel}`}
          title="向右浏览"
          onClick={() => scrollPage(1)}
          className={`${arrowClass} -right-5 ${edgeControlClass('right')}`}
        >
          <ChevronRight className={arrowIconClass} strokeWidth={edgeControlSize === 'compact' ? 2 : 1.5} />
        </button>
      )}
    </div>
  )
}
