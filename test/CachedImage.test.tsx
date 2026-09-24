/** @vitest-environment jsdom */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CachedImage from '../src/components/CachedImage'

const { preloadArtwork } = vi.hoisted(() => ({
  preloadArtwork: vi.fn(() => Promise.resolve('http://localhost:3001/cover?url=cover')),
}))

vi.mock('../src/services/artworkLoader', () => ({
  getArtworkEpoch: () => 0,
  getArtworkCacheKey: () => 'artwork:test',
  getResolvedArtworkUrl: () => 'http://localhost:3001/cover?url=cover',
  preloadArtwork,
  subscribeArtworkEpoch: () => () => undefined,
}))

class SilentIntersectionObserver {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
  constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility
})

describe('CachedImage loading fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = SilentIntersectionObserver
  })

  it('starts loading when IntersectionObserver never reports visibility', async () => {
    render(<CachedImage src="https://cdn.example.test/cover.jpg" alt="封面" />)

    expect(preloadArtwork).not.toHaveBeenCalled()

    await act(async () => {
      vi.advanceTimersByTime(800)
    })

    expect(preloadArtwork).toHaveBeenCalledWith(
      'http://localhost:3001/cover?url=cover',
      expect.objectContaining({ priority: 'visible' }),
    )
  })

  it('holds far-off-screen covers back so the visible ones keep the connections', async () => {
    // jsdom 没有布局：给出 checkVisibility 与可量矩形，模拟真实浏览器
    ;(Element.prototype as unknown as { checkVisibility?: () => boolean }).checkVisibility = () => true
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 4000, top: 4000, bottom: 4064, left: 0, right: 64, width: 64, height: 64, toJSON: () => ({}),
    } as DOMRect)

    render(<CachedImage src="https://cdn.example.test/far.jpg" alt="远端封面" />)

    // 兜底超时连着几轮都不该放行：远端封面抢带宽会把可见封面挤到十几秒后
    await act(async () => {
      vi.advanceTimersByTime(2400)
    })
    expect(preloadArtwork).not.toHaveBeenCalled()

    // 滚到视口附近后放行
    rectSpy.mockReturnValue({
      x: 0, y: 100, top: 100, bottom: 164, left: 0, right: 64, width: 64, height: 64, toJSON: () => ({}),
    } as DOMRect)
    await act(async () => {
      vi.advanceTimersByTime(800)
    })
    expect(preloadArtwork).toHaveBeenCalled()
    rectSpy.mockRestore()
  })

  it('keeps the caller positioning wrapper and applies contain to the image when requested', async () => {
    render(<CachedImage src="https://cdn.example.test/cover.jpg" alt="封面" fit="contain" className="absolute inset-0 h-full w-full object-contain" lazy={false} />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const image = document.querySelector('img')
    expect(image?.className).toContain('object-contain')
    expect(image?.parentElement?.className).toContain('absolute')
    expect(image?.parentElement?.className).toContain('inset-0')
    expect(image?.parentElement?.className).not.toContain('relative')
  })

  it('uses cover by default for ordinary artwork', async () => {
    render(<CachedImage src="https://cdn.example.test/cover.jpg" alt="封面" lazy={false} />)

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(document.querySelector('img')?.className).toContain('object-cover')
  })
})
