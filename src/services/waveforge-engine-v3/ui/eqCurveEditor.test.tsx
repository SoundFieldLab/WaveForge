// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EqCurveEditor } from './eqCurveEditor'
import { useV3Theme } from './theme'

let containerWidth = 1200
let notifyResize: () => void
const observe = vi.fn()
const disconnect = vi.fn()
const graphHeight = 190
const graphLeft = 100
const graphTop = 70

function renderEditor() {
  const onChange = vi.fn()
  const onSelect = vi.fn()
  function Harness() {
    return <EqCurveEditor
      theme={useV3Theme('light')}
      height={graphHeight}
      points={[{ frequency: 20, gain: -3 }, { frequency: 1000, gain: 0 }, { frequency: 20000, gain: 3 }]}
      onChange={onChange}
      onSelect={onSelect}
    />
  }
  const view = render(<Harness />)
  const svg = screen.getByLabelText('均衡器响应曲线') as unknown as SVGSVGElement
  const captured = new Set<number>()
  svg.setPointerCapture = vi.fn((id: number) => { captured.add(id) })
  svg.hasPointerCapture = vi.fn((id: number) => captured.has(id))
  svg.releasePointerCapture = vi.fn((id: number) => { captured.delete(id) })
  return { ...view, svg, onChange, onSelect }
}

/** 点击用户实际看见的控制点；宽度更新后应仍与指针命中坐标重合。 */
function pointPosition(frequency: number) {
  const point = screen.getByRole('button', { name: `选择 ${frequency} Hz 频段` })
  const circle = point.querySelector('circle:last-child')!
  return {
    clientX: graphLeft + Number(circle.getAttribute('cx')),
    clientY: graphTop + Number(circle.getAttribute('cy')),
  }
}

describe('HSE 均衡器曲线尺寸与拖拽', () => {
  beforeEach(() => {
    containerWidth = 1200
    observe.mockClear()
    disconnect.mockClear()
    vi.spyOn(SVGSVGElement.prototype, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(graphLeft, graphTop, containerWidth, graphHeight),
    )
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { notifyResize = callback }
      observe = observe
      disconnect = disconnect
    })
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      readonly pointerId: number
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 0
      }
    })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('宽容器保留图表高度，控制点能选中并按增益轴拖动', () => {
    const { svg, onChange, onSelect } = renderEditor()
    expect(svg.style.height).toBe('190px')
    expect(svg.getAttribute('viewBox')).toBe('0 0 1200 190')
    expect(observe).toHaveBeenCalledWith(svg)

    fireEvent.pointerDown(svg, { ...pointPosition(1000), pointerId: 7, buttons: 1 })
    expect(onSelect).toHaveBeenLastCalledWith(1)
    expect(screen.getByRole('button', { name: '选择 1000 Hz 频段' }).getAttribute('aria-pressed')).toBe('true')
    expect(svg.setPointerCapture).toHaveBeenCalledWith(7)
    expect(onChange).toHaveBeenLastCalledWith(1, 0)

    fireEvent.pointerMove(svg, { clientX: 800, clientY: graphTop + 49.5, pointerId: 7, buttons: 1 })
    expect(onChange).toHaveBeenLastCalledWith(1, 6)
    fireEvent.pointerMove(svg, { clientX: 800, clientY: graphTop + graphHeight + 20, pointerId: 7, buttons: 1 })
    expect(onChange).toHaveBeenLastCalledWith(1, -12)

    fireEvent.pointerUp(svg, { pointerId: 7 })
    expect(svg.releasePointerCapture).toHaveBeenCalledWith(7)
    onChange.mockClear()
    fireEvent.pointerMove(svg, { clientX: 800, clientY: graphTop, pointerId: 7, buttons: 1 })
    expect(onChange).not.toHaveBeenCalled()
  })

  it('容器和窗口改变宽度后，控制点命中与增益映射仍正确', () => {
    const { svg, onChange, onSelect } = renderEditor()
    containerWidth = 680
    act(() => notifyResize())
    expect(svg.getAttribute('viewBox')).toBe('0 0 680 190')
    expect(svg.style.height).toBe('190px')

    fireEvent.pointerDown(svg, { ...pointPosition(20000), pointerId: 8, buttons: 1 })
    expect(onSelect).toHaveBeenLastCalledWith(2)
    expect(onChange).toHaveBeenLastCalledWith(2, 3)
    fireEvent.pointerMove(svg, { clientX: 700, clientY: graphTop + 124.5, pointerId: 8, buttons: 1 })
    expect(onChange).toHaveBeenLastCalledWith(2, -6)
    fireEvent.pointerCancel(svg, { pointerId: 8 })
    expect(svg.releasePointerCapture).toHaveBeenCalledWith(8)

    containerWidth = 980
    fireEvent(window, new Event('resize'))
    expect(svg.getAttribute('viewBox')).toBe('0 0 980 190')
    fireEvent.pointerDown(svg, { ...pointPosition(20), pointerId: 9, buttons: 1 })
    expect(onSelect).toHaveBeenLastCalledWith(0)
    expect(onChange).toHaveBeenLastCalledWith(0, -3)
    fireEvent.pointerUp(svg, { pointerId: 9 })
  })

  it('卸载后断开尺寸观察并移除同一个窗口监听器', () => {
    const addListener = vi.spyOn(window, 'addEventListener')
    const removeListener = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderEditor()
    const resizeListener = addListener.mock.calls.find(([type]) => type === 'resize')?.[1]
    expect(resizeListener).toBeTypeOf('function')

    unmount()

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(removeListener).toHaveBeenCalledWith('resize', resizeListener)
  })
})
