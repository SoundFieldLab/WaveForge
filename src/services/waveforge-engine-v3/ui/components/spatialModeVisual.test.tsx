// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SpatialModeVisual } from './SpatialModeVisual'
import { createHSETheme } from '../hse-theme'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const theme = createHSETheme()

describe('立体声展开图', () => {
  it('清楚标示听者、前方和两个声道，不依赖 Canvas', () => {
    const { container } = render(<SpatialModeVisual spreadDeg={60} amount={0.8} active theme={theme} />)
    expect(screen.getByText('左声道 L')).toBeTruthy()
    expect(screen.getByText('右声道 R')).toBeTruthy()
    expect(screen.getByText('听者')).toBeTruthy()
    expect(screen.getByText('前方')).toBeTruthy()
    expect(container.querySelector('canvas')).toBeNull()
    expect(screen.getByText('空间强度 80%')).toBeTruthy()
  })

  it('两个扬声器都支持键盘调角度与上下界', () => {
    const onSpreadChange = vi.fn()
    render(<SpatialModeVisual spreadDeg={60} amount={0.8} active theme={theme} onSpreadChange={onSpreadChange} />)
    const [left, right] = screen.getAllByRole('slider')
    fireEvent.keyDown(left, { key: 'ArrowRight' }); expect(onSpreadChange).toHaveBeenLastCalledWith(61)
    fireEvent.keyDown(right, { key: 'ArrowDown', shiftKey: true }); expect(onSpreadChange).toHaveBeenLastCalledWith(55)
    fireEvent.keyDown(right, { key: 'End' }); expect(onSpreadChange).toHaveBeenLastCalledWith(120)
    fireEvent.keyDown(left, { key: 'Home' }); expect(onSpreadChange).toHaveBeenLastCalledWith(20)
  })

  it('旁路时保留位置但暂停编辑', () => {
    const onSpreadChange = vi.fn()
    render(<SpatialModeVisual spreadDeg={60} amount={0.8} active={false} theme={theme} onSpreadChange={onSpreadChange} transitionKey={2} />)
    const node = screen.getAllByRole('slider')[0]
    expect(node.getAttribute('aria-disabled')).toBe('true')
    fireEvent.keyDown(node, { key: 'ArrowRight' })
    expect(onSpreadChange).not.toHaveBeenCalled()
    expect(screen.getByText('原声对比 · 位置编辑暂停')).toBeTruthy()
  })

  it('使用 SVG 屏幕矩阵换算拖动，响应式缩放不改变角度', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const onSpreadChange = vi.fn()
    const { container } = render(<SpatialModeVisual spreadDeg={60} amount={0.8} active theme={theme} onSpreadChange={onSpreadChange} />)
    const svg = container.querySelector('svg')!
    Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ inverse: () => ({}) }) })
    Object.defineProperty(svg, 'createSVGPoint', { value: () => ({ x: 0, y: 0,
      matrixTransform() { return { x: (this.x - 80) / 2, y: (this.y - 40) / 2 } },
    }) })
    const right = screen.getAllByRole('slider')[1]
    fireEvent.pointerDown(right, { button: 0, clientX: 724, clientY: 204 })
    const angle = Math.PI / 4
    fireEvent.pointerMove(svg, { clientX: 80 + (240 + 164 * Math.sin(angle)) * 2,
      clientY: 40 + (224 - 164 * Math.cos(angle)) * 2 })
    expect(onSpreadChange).toHaveBeenLastCalledWith(90)
    fireEvent.pointerUp(svg)
    onSpreadChange.mockClear()
    fireEvent.pointerMove(svg, { clientX: 700, clientY: 100 })
    expect(onSpreadChange).not.toHaveBeenCalled()
  })
})
