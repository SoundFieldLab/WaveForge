// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { SpatialSceneEditor, type SpatialScenePoint } from './SpatialSceneEditor'
import { createHSETheme } from '../hse-theme'
import { createLayoutSpeakers } from '../../src/spatial/layouts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const theme = createHSETheme()
const listener = { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 }
const points: SpatialScenePoint[] = [{ id: 'left', label: '左前方虚拟扬声器', position: { x: -2, y: 1.6, z: 3 }, muted: true }]
const markerPosition = (node: Element) => ({ x: Number(node.getAttribute('data-marker-x')), y: Number(node.getAttribute('data-marker-y')) })
const anchorPosition = (node: Element) => ({ x: Number(node.getAttribute('data-anchor-x')), y: Number(node.getAttribute('data-anchor-y')) })
function svgCoordinates(svg: SVGSVGElement) {
  Object.defineProperty(svg, 'getScreenCTM', { value: () => ({ inverse: () => ({}) }) })
  Object.defineProperty(svg, 'createSVGPoint', { value: () => ({ x: 0, y: 0,
    matrixTransform() { return { x: (this.x - 80) / 2, y: (this.y - 40) / 2 } },
  }) })
}
const pointerAt = (position: { x: number; y: number }) => ({ clientX: 80 + position.x * 2, clientY: 40 + position.y * 2 })
function expectSeparated(nodes: Element[]) {
  for (let i = 0; i < nodes.length; i++) {
    const a = markerPosition(nodes[i])
    expect(a.x).toBeGreaterThanOrEqual(56); expect(a.x).toBeLessThanOrEqual(424)
    expect(a.y).toBeGreaterThanOrEqual(56); expect(a.y).toBeLessThanOrEqual(264)
    // 连同选中圈都不进入听者的头部和文字区域。
    expect(Math.abs(a.x - 240) >= 60 || a.y <= 100 || a.y >= 230).toBe(true)
    for (let j = i + 1; j < nodes.length; j++) {
      const b = markerPosition(nodes[j])
      expect(Math.abs(a.x - b.x) >= 56 || Math.abs(a.y - b.y) >= 56).toBe(true)
    }
  }
}

describe('二维声场编辑器', () => {
  it('完整名称和静音文字位于图外，节点使用编号', () => {
    render(<SpatialSceneEditor points={points} listener={listener} selected="left" onSelect={() => {}} onMove={() => {}} view="top" theme={theme} />)
    expect(screen.getByText('左前方虚拟扬声器 · 静音')).toBeTruthy()
    expect(screen.getByRole('button', { name: /选择左前方虚拟扬声器，已静音/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByText('前方 +Z')).toBeTruthy()
    expect(screen.getByText('左侧 −X')).toBeTruthy()
  })

  it('俯视图键盘编辑 X/Z 且保留高度，Shift 提供精细步进', () => {
    const onMove = vi.fn(), onSelect = vi.fn()
    render(<SpatialSceneEditor points={points} listener={listener} selected={null} onSelect={onSelect} onMove={onMove} view="top" theme={theme} />)
    const node = screen.getByRole('button', { name: /选择左前方/ })
    fireEvent.keyDown(node, { key: 'ArrowUp' })
    expect(onSelect).toHaveBeenLastCalledWith('left')
    expect(onMove).toHaveBeenLastCalledWith('left', { x: -2, y: 1.6, z: 3.1 })
    fireEvent.keyDown(node, { key: 'ArrowRight', shiftKey: true })
    expect(onMove).toHaveBeenLastCalledWith('left', { x: -1.99, y: 1.6, z: 3 })
  })

  it('侧视图编辑 Z/Y，保留左右位置 X', () => {
    const onMove = vi.fn()
    render(<SpatialSceneEditor points={points} listener={listener} selected="left" onSelect={() => {}} onMove={onMove} view="side" theme={theme} />)
    const node = screen.getByRole('button', { name: /选择左前方/ })
    fireEvent.keyDown(node, { key: 'ArrowDown' })
    expect(onMove).toHaveBeenLastCalledWith('left', { x: -2, y: 1.5, z: 3 })
    fireEvent.keyDown(node, { key: 'ArrowRight' })
    expect(onMove).toHaveBeenLastCalledWith('left', { x: -2, y: 1.6, z: 3.1 })
    expect(screen.getByText('上方 +Y')).toBeTruthy()
  })

  it('侧视拖动按 SVG 矩阵换算 Z/Y，缩放时保留 X', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const onMove = vi.fn()
    const { container } = render(<SpatialSceneEditor points={points} listener={listener} selected="left" onSelect={() => {}} onMove={onMove} view="side" theme={theme} />)
    const svg = container.querySelector('svg')!
    svgCoordinates(svg)
    const node = screen.getByRole('button', { name: /选择左前方/ })
    const start = markerPosition(node), scale = 3 * 1.2
    fireEvent.pointerDown(node, { button: 0, ...pointerAt(start) })
    expect(onMove).not.toHaveBeenCalled()
    fireEvent.pointerMove(svg, pointerAt(start))
    expect(onMove).toHaveBeenLastCalledWith('left', points[0].position)
    fireEvent.pointerMove(svg, pointerAt({ x: start.x - 192 / scale * 1.5, y: start.y - 112 / scale }))
    expect(onMove).toHaveBeenLastCalledWith('left', { x: -2, y: 2.6, z: 1.5 })
    fireEvent.pointerCancel(svg)
    onMove.mockClear()
    fireEvent.pointerMove(svg, { clientX: 600, clientY: 300 })
    expect(onMove).not.toHaveBeenCalled()
  })

  it.each(['top', 'side'] as const)('真实 1 米 7.1.4 布局在%s图中铺开，重叠投影编号避让并连接真实位置', view => {
    const speakers = createLayoutSpeakers('714').map((speaker, index) => {
      const az = speaker.azimuthDeg * Math.PI / 180, el = speaker.elevationDeg * Math.PI / 180
      return { id: `speaker-${index}`, label: `扬声器 ${index + 1}`, position: {
        x: Math.sin(az) * Math.cos(el), y: 1.6 + Math.sin(el), z: Math.cos(az) * Math.cos(el),
      } }
    })
    const { container, rerender } = render(<SpatialSceneEditor points={speakers} listener={listener} selected="speaker-1" onSelect={() => {}} onMove={() => {}} view={view} theme={theme} />)
    const nodes = Array.from(container.querySelectorAll('[data-scene-point]'))
    expect(nodes).toHaveLength(11)
    expectSeparated(nodes)
    const anchors = nodes.map(anchorPosition)
    expect(Math.max(...anchors.map(at => at.x)) - Math.min(...anchors.map(at => at.x))).toBeGreaterThan(280)
    if (view === 'side') expect(anchorPosition(container.querySelector('[data-scene-point="speaker-1"]')!))
      .toEqual(anchorPosition(container.querySelector('[data-scene-point="speaker-2"]')!))
    const shifted = nodes.filter(node => JSON.stringify(anchorPosition(node)) !== JSON.stringify(markerPosition(node)))
    expect(shifted.length).toBeGreaterThan(0)
    for (const node of shifted) {
      const line = container.querySelector(`[data-scene-connector="${node.getAttribute('data-scene-point')}"]`)!
      const anchor = anchorPosition(node), marker = markerPosition(node)
      expect(Number(line.getAttribute('x1'))).toBe(anchor.x); expect(Number(line.getAttribute('y1'))).toBe(anchor.y)
      expect(Number(line.getAttribute('x2'))).toBe(marker.x); expect(Number(line.getAttribute('y2'))).toBe(marker.y)
      expect(node.querySelector('line')).toBeNull()
    }
    const positions = nodes.map(node => node.getAttribute('transform'))
    rerender(<SpatialSceneEditor points={speakers} listener={listener} selected="speaker-7" onSelect={() => {}} onMove={() => {}} view={view} theme={theme} />)
    expect(nodes.map(node => node.getAttribute('transform'))).toEqual(positions)
  })

  it('16 个同位置声源也分别显示，并避开听者', () => {
    const overlapping = Array.from({ length: 16 }, (_, index) => ({ id: `source-${index}`, label: `声源 ${index + 1}`, position: { ...listener.position } }))
    const { container } = render(<SpatialSceneEditor points={overlapping} listener={listener} selected="source-0" onSelect={() => {}} onMove={() => {}} view="side" theme={theme} />)
    expectSeparated(Array.from(container.querySelectorAll('[data-scene-point]')))
  })

  it.each(['top', 'side'] as const)('%s图的偏移编号按下不跳位，拖动改变真实坐标并保留隐藏轴', view => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const source: SpatialScenePoint[] = view === 'top'
      ? [{ id: 'first', label: '前声源', position: { x: 0.75, y: 1, z: 0 } }, { id: 'second', label: '后声源', position: { x: 0.75, y: 3, z: 0 } }]
      : [{ id: 'first', label: '前声源', position: { x: -2, y: 1.6, z: 0.75 } }, { id: 'second', label: '后声源', position: { x: 2, y: 1.6, z: 0.75 } }]
    const onMove = vi.fn()
    function ControlledEditor() {
      const [current, setCurrent] = useState(source), [selected, setSelected] = useState<string | null>(null)
      return <SpatialSceneEditor points={current} listener={listener} selected={selected} onSelect={setSelected}
        onMove={(id, position) => { onMove(id, position); setCurrent(items => items.map(point => point.id === id ? { ...point, position } : point)) }} view={view} theme={theme} />
    }
    const { container } = render(<ControlledEditor />), svg = container.querySelector('svg')!
    svgCoordinates(svg)
    const node = container.querySelector('[data-scene-point="second"]')!, first = container.querySelector('[data-scene-point="first"]')!
    const start = markerPosition(node), firstStart = markerPosition(first), anchor = anchorPosition(node)
    expect(start).not.toEqual(anchor)
    const cursor = { x: start.x + 7, y: start.y - 4 }
    fireEvent.pointerDown(node, { button: 0, ...pointerAt(cursor) })
    expect(onMove).not.toHaveBeenCalled()
    expect(markerPosition(node)).toEqual(start)
    fireEvent.pointerMove(svg, pointerAt(cursor))
    expect(onMove).toHaveBeenLastCalledWith('second', source[1].position)
    const scale = 0.75 * 1.2, dx = 192 / scale * 0.3, dy = -112 / scale * 0.45
    fireEvent.pointerMove(svg, pointerAt({ x: cursor.x + dx, y: cursor.y + dy }))
    expect(onMove).toHaveBeenLastCalledWith('second', view === 'top' ? { x: 1.05, y: 3, z: 0.45 } : { x: 2, y: 2.05, z: 1.05 })
    expect(markerPosition(node).x).toBeCloseTo(start.x + dx)
    expect(markerPosition(node).y).toBeCloseTo(start.y + dy)
    expect(markerPosition(first)).toEqual(firstStart)
    expect(screen.getByText('范围 ±0.9 m')).toBeTruthy()
    fireEvent.pointerUp(svg)
    onMove.mockClear()
    fireEvent.pointerMove(svg, pointerAt(cursor))
    expect(onMove).not.toHaveBeenCalled()
  })
})
