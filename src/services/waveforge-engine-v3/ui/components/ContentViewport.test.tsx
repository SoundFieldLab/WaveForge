// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContentViewport } from './ContentViewport'

let resize: () => void
let contentHeight = 1000
let viewportHeight = 400
let reducedMotion = false

describe('HSE 正文滚动提示', () => {
  beforeEach(() => {
    contentHeight = 1000
    viewportHeight = 400
    reducedMotion = false
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight)
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
    vi.stubGlobal('cancelAnimationFrame', window.clearTimeout)
    vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }))
    vi.useFakeTimers()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const hint = () => screen.queryByRole('button', { name: '向下查看更多' })
  const flush = () => act(() => { vi.runOnlyPendingTimers() })

  it('有下方内容时显示，到底隐藏，向上滚后再次出现', () => {
    render(<ContentViewport pageKey="scenes">场景内容</ContentViewport>)
    expect(hint()).toBeTruthy()
    const main = screen.getByRole('main')
    main.scrollTop = 600
    fireEvent.scroll(main)
    flush()
    expect(hint()).toBeNull()

    main.scrollTop = 120
    fireEvent.scroll(main)
    flush()
    expect(hint()).toBeTruthy()
  })

  it('每次点击向下移动四分之三屏，减少动态效果时直接滚动', () => {
    render(<ContentViewport pageKey="eq">均衡器内容</ContentViewport>)
    const main = screen.getByRole('main')
    const scrollBy = vi.fn()
    main.scrollBy = scrollBy
    fireEvent.click(hint()!)
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 300, behavior: 'smooth' })
    reducedMotion = true
    fireEvent.click(hint()!)
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 300, behavior: 'auto' })
  })

  it('内容展开和窗口变化后重测，不溢出的页面不显示', () => {
    contentHeight = 300
    render(<ContentViewport pageKey="tuner">分享工具</ContentViewport>)
    expect(hint()).toBeNull()
    contentHeight = 700
    act(() => resize())
    flush()
    expect(hint()).toBeTruthy()
    viewportHeight = 800
    fireEvent(window, new Event('resize'))
    flush()
    expect(hint()).toBeNull()
  })

  it('切页回到顶部并按新内容重测', () => {
    const view = render(<ContentViewport pageKey="eq">均衡器</ContentViewport>)
    const main = screen.getByRole('main')
    main.scrollTop = 600
    fireEvent.scroll(main)
    flush()
    contentHeight = 300
    view.rerender(<ContentViewport pageKey="about">关于</ContentViewport>)
    expect(main.scrollTop).toBe(0)
    expect(hint()).toBeNull()
  })

  it('键盘操作抵达末尾后保留正文焦点', () => {
    render(<ContentViewport pageKey="eq">均衡器</ContentViewport>)
    hint()!.focus()
    const main = screen.getByRole('main')
    main.scrollTop = 600
    fireEvent.scroll(main)
    flush()
    expect(hint()).toBeNull()
    expect(document.activeElement).toBe(main)
  })
})
