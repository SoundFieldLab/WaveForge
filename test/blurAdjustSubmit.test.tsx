/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BlurAdjustModal from '../src/components/BlurAdjustModal'

vi.mock('../src/tv/tvCore', () => ({
  useTvBack: () => undefined,
}))

/** 手动控制的 rAF：把回调排队，由测试显式 flush，从而观察「每帧一次提交」。 */
let rafQueue: Array<() => void> = []
let rafId = 0
const flushFrame = () => {
  const queued = rafQueue
  rafQueue = []
  for (const cb of queued) cb()
}

beforeEach(() => {
  localStorage.clear()
  rafQueue = []
  rafId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(() => cb(0))
    rafId += 1
    return rafId
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    // 简化：取消即整队清空（本组用例只关心「未被 flush 的帧不该生效」）
    void id
    rafQueue = []
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
})

const slider = () => screen.getByRole('slider') as HTMLInputElement
const blurEvents = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.map(([e]) => (e as CustomEvent).detail as number)

describe('BlurAdjustModal 模糊度提交', () => {
  it('同一帧内多次拖动只提交一次事件（rAF 合并）', () => {
    const onEvent = vi.fn()
    window.addEventListener('cardBlurAmountChanged', onEvent)
    render(<BlurAdjustModal show onClose={vi.fn()} />)

    // 模拟一帧内连续多次 change（真实拖拽/按住方向键会这样）
    fireEvent.change(slider(), { target: { value: '11' } })
    fireEvent.change(slider(), { target: { value: '12' } })
    fireEvent.change(slider(), { target: { value: '13' } })

    // 帧未 flush 前不应派发
    expect(onEvent).not.toHaveBeenCalled()

    flushFrame()

    // 一帧只提交一次，且提交的是最后一个值
    expect(blurEvents(onEvent)).toEqual([13])
    expect(localStorage.getItem('cardBlurAmount')).toBe('13')
    window.removeEventListener('cardBlurAmountChanged', onEvent)
  })

  it('提交时同时落盘 localStorage 与派发事件（保持成对）', () => {
    const onEvent = vi.fn()
    window.addEventListener('cardBlurAmountChanged', onEvent)
    render(<BlurAdjustModal show onClose={vi.fn()} />)

    fireEvent.change(slider(), { target: { value: '20' } })
    flushFrame()

    expect(localStorage.getItem('cardBlurAmount')).toBe('20')
    expect(blurEvents(onEvent)).toEqual([20])
    window.removeEventListener('cardBlurAmountChanged', onEvent)
  })

  it('取消时同步恢复初始值（不依赖未执行的 rAF）', () => {
    localStorage.setItem('cardBlurAmount', '10')
    const onEvent = vi.fn()
    window.addEventListener('cardBlurAmountChanged', onEvent)
    render(<BlurAdjustModal show onClose={vi.fn()} />)

    fireEvent.change(slider(), { target: { value: '25' } })
    // 不 flush，直接取消：应回落到初始值 10
    fireEvent.click(screen.getByRole('button', { name: /取消/ }))

    expect(localStorage.getItem('cardBlurAmount')).toBe('10')
    expect(blurEvents(onEvent)).toEqual([10])
    window.removeEventListener('cardBlurAmountChanged', onEvent)
  })

  it('保存时以当前滑块值同步提交', () => {
    const onEvent = vi.fn()
    window.addEventListener('cardBlurAmountChanged', onEvent)
    render(<BlurAdjustModal show onClose={vi.fn()} />)

    fireEvent.change(slider(), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: /保存/ }))

    expect(localStorage.getItem('cardBlurAmount')).toBe('18')
    expect(blurEvents(onEvent)).toEqual([18])
    window.removeEventListener('cardBlurAmountChanged', onEvent)
  })
})
