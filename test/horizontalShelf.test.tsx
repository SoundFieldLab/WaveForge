/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HorizontalShelf } from '../src/components/apple-explore/HorizontalShelf'

let resizeCallback: ResizeObserverCallback | null = null

function setShelfGeometry(shelf: HTMLDivElement, options: {
  clientWidth?: number
  scrollWidth?: number
  scrollLeft?: number
  itemOffsets?: number[]
} = {}) {
  Object.defineProperty(shelf, 'clientWidth', { configurable: true, value: options.clientWidth ?? 400 })
  Object.defineProperty(shelf, 'scrollWidth', { configurable: true, value: options.scrollWidth ?? 1000 })
  shelf.scrollLeft = options.scrollLeft ?? 0
  const offsets = options.itemOffsets ?? [0, 220, 440, 660]
  Array.from(shelf.children).forEach((child, index) => {
    Object.defineProperty(child, 'offsetLeft', { configurable: true, value: offsets[index] ?? 0 })
  })
}

function mockPointerCapture(shelf: HTMLDivElement) {
  shelf.setPointerCapture = vi.fn()
  shelf.releasePointerCapture = vi.fn()
  shelf.hasPointerCapture = vi.fn(() => true)
}

function renderShelf(props: Partial<React.ComponentProps<typeof HorizontalShelf>> = {}) {
  return render(
    <HorizontalShelf ariaLabel="推荐内容" {...props}>
      <button type="button">第一项</button>
      <button type="button">第二项</button>
      <button type="button">第三项</button>
      <button type="button">第四项</button>
    </HorizontalShelf>,
  )
}

describe('HorizontalShelf', () => {
  beforeEach(() => {
    resizeCallback = null
    vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) { resizeCallback = callback }
      observe() {}
      disconnect() {}
      unobserve() {}
    })
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('exposes an accessible rail, hidden scrollbar, and compatible peek classes', () => {
    renderShelf({ viewportClassName: 'custom-viewport', itemClassName: 'w-72', rightPeek: '12vw' })
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement

    expect(shelf.tabIndex).toBe(0)
    expect(shelf).toHaveProperty('className', expect.stringContaining('wf-no-scrollbar'))
    expect(shelf.className).toContain('custom-viewport')
    expect(shelf.style.paddingInlineEnd).toBe('12vw')
    expect(shelf.firstElementChild?.className).toContain('w-72')
  })

  it('uses reduced-motion page movement and supports arrow keys', () => {
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf)

    fireEvent.keyDown(shelf, { key: 'ArrowRight' })

    expect(shelf.scrollLeft).toBe(220)
  })

  it('animates page movement when reduced motion is not requested', () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: false } as MediaQueryList)
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frame = callback
      return 1
    }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf)

    fireEvent.keyDown(shelf, { key: 'ArrowRight' })
    expect(requestAnimationFrame).toHaveBeenCalledOnce()
    expect(shelf.scrollLeft).toBe(0)

    act(() => frame?.(performance.now() + 1000))
    expect(shelf.scrollLeft).toBe(220)
  })

  it('preserves clicks below the drag threshold', () => {
    const clicked = vi.fn()
    render(
      <HorizontalShelf ariaLabel="可点击内容">
        <button type="button" onClick={clicked}>播放</button>
      </HorizontalShelf>,
    )
    const shelf = screen.getByRole('region', { name: '可点击内容' }) as HTMLDivElement
    setShelfGeometry(shelf, { itemOffsets: [0] })
    mockPointerCapture(shelf)
    const button = screen.getByRole('button', { name: '播放' })

    fireEvent.pointerDown(button, { pointerId: 2, pointerType: 'mouse', button: 0, clientX: 100 })
    expect(shelf.firstElementChild?.className).not.toContain('rotateY')
    fireEvent.pointerMove(button, { pointerId: 2, pointerType: 'mouse', clientX: 96 })
    expect(shelf.firstElementChild?.className).not.toContain('rotateY')
    fireEvent.pointerUp(button, { pointerId: 2, pointerType: 'mouse', clientX: 96 })
    fireEvent.click(button)

    expect(clicked).toHaveBeenCalledOnce()
    expect(shelf.setPointerCapture).not.toHaveBeenCalled()
  })

  it('drags continuously, keeps the projected release position, and suppresses click and context menu', () => {
    const clicked = vi.fn()
    const contextMenu = vi.fn()
    render(
      <HorizontalShelf ariaLabel="可拖动内容">
        <button type="button" onClick={clicked} onContextMenu={contextMenu}>打开</button>
        <button type="button">下一项</button>
      </HorizontalShelf>,
    )
    const shelf = screen.getByRole('region', { name: '可拖动内容' }) as HTMLDivElement
    setShelfGeometry(shelf, { itemOffsets: [0, 220] })
    mockPointerCapture(shelf)
    const button = screen.getByRole('button', { name: '打开' })

    fireEvent.pointerDown(button, { pointerId: 1, pointerType: 'mouse', button: 0, clientX: 300 })
    fireEvent.pointerMove(button, { pointerId: 1, pointerType: 'mouse', clientX: 165 })
    expect(shelf.scrollLeft).toBe(135)
    expect(shelf.className).not.toContain('snap-')
    expect(shelf.firstElementChild?.className).not.toContain('snap-start')
    fireEvent.pointerUp(button, { pointerId: 1, pointerType: 'mouse', clientX: 165 })
    expect(shelf.firstElementChild?.className).not.toContain('rotateY')
    fireEvent.click(button)
    fireEvent.contextMenu(button)

    expect(shelf.scrollLeft).toBeGreaterThanOrEqual(135)
    expect(shelf.scrollLeft).toBeLessThanOrEqual(600)
    expect(clicked).not.toHaveBeenCalled()
    expect(contextMenu).not.toHaveBeenCalled()
    expect(shelf.setPointerCapture).toHaveBeenCalledWith(1)
    expect(shelf.releasePointerCapture).toHaveBeenCalledWith(1)
  })

  it('releases pointer capture and cancels inertia on pointercancel', () => {
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf)
    mockPointerCapture(shelf)
    const button = screen.getByRole('button', { name: '第一项' })

    fireEvent.pointerDown(button, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 300 })
    fireEvent.pointerMove(button, { pointerId: 3, pointerType: 'touch', clientX: 220 })
    expect(shelf.className).not.toContain('snap-')
    fireEvent.pointerCancel(button, { pointerId: 3, pointerType: 'touch', clientX: 220 })

    expect(shelf.className).not.toContain('snap-')
    expect(shelf.releasePointerCapture).toHaveBeenCalledWith(3)
  })

  it('does not intercept vertical or horizontal wheel input', () => {
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf)

    const vertical = new WheelEvent('wheel', { deltaY: 120, cancelable: true, bubbles: true })
    const horizontal = new WheelEvent('wheel', { deltaX: 80, cancelable: true, bubbles: true })
    shelf.dispatchEvent(vertical)
    shelf.dispatchEvent(horizontal)

    expect(vertical.defaultPrevented).toBe(false)
    expect(horizontal.defaultPrevented).toBe(false)
    expect(shelf.scrollLeft).toBe(0)
  })

  it('hides compact edge controls until the pointer reaches an edge by default', () => {
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    const wrapper = shelf.parentElement as HTMLDivElement
    setShelfGeometry(shelf)
    wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 240, width: 400, height: 240, toJSON: () => ({}) })

    fireEvent.scroll(shelf)
    const right = screen.getByRole('button', { name: '向右浏览推荐内容' })
    expect(right.className).toContain('pointer-events-none opacity-0')
    expect(right.className).toContain('h-11 w-11')
    expect(right.className).toContain('bg-black/35')
    fireEvent.pointerMove(wrapper, { pointerType: 'mouse', clientX: 380 })
    expect(right.className).toContain('pointer-events-auto opacity-100')
  })

  it('shows hover controls only in their available edge hot zones and keeps focus visibility', () => {
    renderShelf({ edgeControls: 'hover' })
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    const wrapper = shelf.parentElement as HTMLDivElement
    setShelfGeometry(shelf)
    wrapper.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 240, width: 400, height: 240, toJSON: () => ({}) })

    fireEvent.scroll(shelf)
    const right = screen.getByRole('button', { name: '向右浏览推荐内容' })
    expect(right.className).toContain('h-11 w-11')
    expect(right.className).toContain('rounded-full')
    expect(right.className).toContain('-right-5')
    expect(right.className).toContain('opacity-0')
    expect(right.className).toContain('pointer-events-none')
    expect(right.className).toContain('focus-visible:opacity-100')
    expect(right.className).toContain('focus-visible:ring-2')
    expect(right.querySelector('svg')?.getAttribute('class')).toContain('h-4 w-4')
    fireEvent.pointerMove(wrapper, { pointerType: 'mouse', clientX: 380 })
    expect(right.className).toContain('opacity-100')
    fireEvent.pointerMove(wrapper, { pointerType: 'mouse', clientX: 200 })
    expect(right.className).not.toContain('pointer-events-auto opacity-100')
    fireEvent.pointerLeave(wrapper)
    expect(right.className).not.toContain('pointer-events-auto opacity-100')
    expect(screen.queryByRole('button', { name: '向左浏览推荐内容' })).toBeNull()

    shelf.scrollLeft = 300
    fireEvent.scroll(shelf)
    const left = screen.getByRole('button', { name: '向左浏览推荐内容' })
    fireEvent.pointerMove(wrapper, { pointerType: 'mouse', clientX: 20 })
    expect(left.className).toContain('opacity-100')

    shelf.scrollLeft = 600
    fireEvent.scroll(shelf)
    expect(screen.queryByRole('button', { name: '向右浏览推荐内容' })).toBeNull()
  })

  it('prevents native image dragging inside the rail', () => {
    render(
      <HorizontalShelf ariaLabel="封面内容">
        <img src="cover.jpg" alt="封面" />
      </HorizontalShelf>,
    )
    const image = screen.getByRole('img', { name: '封面' })
    const event = new Event('dragstart', { bubbles: true, cancelable: true })
    image.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it('uses an epsilon when detecting scroll boundaries', () => {
    renderShelf({ edgeControls: 'hover' })
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf, { clientWidth: 400, scrollWidth: 1000, scrollLeft: 2 })

    fireEvent.scroll(shelf)
    expect(shelf.dataset.leftEdge).toBe('hidden')
    expect(shelf.dataset.rightEdge).toBe('scrollable')

    shelf.scrollLeft = 598
    fireEvent.scroll(shelf)
    expect(shelf.dataset.leftEdge).toBe('scrollable')
    expect(shelf.dataset.rightEdge).toBe('hidden')
  })

  it('recomputes edge availability when observed geometry changes', () => {
    renderShelf()
    const shelf = screen.getByRole('region', { name: '推荐内容' }) as HTMLDivElement
    setShelfGeometry(shelf)

    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(shelf.dataset.leftEdge).toBe('hidden')
    expect(shelf.dataset.rightEdge).toBe('scrollable')

    shelf.scrollLeft = 600
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(shelf.dataset.leftEdge).toBe('scrollable')
    expect(shelf.dataset.rightEdge).toBe('hidden')
  })
})
