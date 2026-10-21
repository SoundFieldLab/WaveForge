import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { HSETheme } from '../hse-theme'
import type { ListenerState } from '../../src/spatial/types'

export interface SpatialScenePoint {
  id: string
  label: string
  position: { x: number; y: number; z: number }
  muted?: boolean
}

const clamp = (value: number) => Math.round(Math.max(-100, Math.min(100, value)) * 100) / 100
type DiagramPoint = { x: number; y: number }

/** 编号与真实投影分开排布：预留听者区域，编号间留出选中圈和静音角标的空间。 */
function arrangeMarkers(anchors: Map<string, DiagramPoint>, ear: DiagramPoint) {
  const candidates: DiagramPoint[] = []
  for (let y = 56; y <= 264; y += 8) for (let x = 56; x <= 424; x += 8) candidates.push({ x, y })
  const allocate = (slots: DiagramPoint[], useAnchor: boolean) => {
    const placed = new Map<string, DiagramPoint>()
    for (const [id, anchor] of anchors) {
      let nearest: DiagramPoint | null = null, distance = Infinity
      const options = useAnchor ? [{ x: Math.max(56, Math.min(424, anchor.x)), y: Math.max(56, Math.min(264, anchor.y)) }, ...slots] : slots
      for (const candidate of options) {
        if (Math.abs(candidate.x - ear.x) < 60 && candidate.y > ear.y - 60 && candidate.y < ear.y + 70) continue
        if ([...placed.values()].some(other => Math.abs(candidate.x - other.x) < 56 && Math.abs(candidate.y - other.y) < 56)) continue
        const nextDistance = (candidate.x - anchor.x) ** 2 + (candidate.y - anchor.y) ** 2
        if (nextDistance < distance) { nearest = candidate; distance = nextDistance }
      }
      if (!nearest) return null
      placed.set(id, nearest)
    }
    return placed
  }
  const close = allocate(candidates, true)
  if (close) return close
  // 自定义布局最多 16 个声源；规则网格至少保留 19 个可用位置，避免密集摆位把后来的编号挤走。
  const grid: DiagramPoint[] = []
  for (let y = 56; y <= 264; y += 56) for (let x = 64; x <= 424; x += 56) grid.push({ x, y })
  return allocate(grid, false)!
}

/** 俯视编辑 X/Z，侧视编辑 Z/Y。图外名称保持完整，可用键盘定位重叠声源。 */
export function SpatialSceneEditor({ points, listener, selected, onSelect, onMove, view, theme }: {
  points: SpatialScenePoint[]; listener: ListenerState; selected: string | null
  onSelect: (id: string) => void; onMove: (id: string, position: SpatialScenePoint['position']) => void
  view: 'top' | 'side'; theme: HSETheme
}) {
  const drag = useRef<{
    id: string; cursor: DiagramPoint; position: SpatialScenePoint['position']; scale: number
    offset: DiagramPoint; markers: Map<string, DiagramPoint>
  } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragScale, setDragScale] = useState<number | null>(null)
  const titleId = useId(), instructionId = useId()
  const horizontal = (position: SpatialScenePoint['position']) => view === 'top' ? position.x : position.z
  const vertical = (position: SpatialScenePoint['position']) => view === 'top' ? position.z : position.y - 1.6
  const extent = Math.max(0.75, ...points.flatMap(point => [Math.abs(horizontal(point.position)), Math.abs(vertical(point.position))]), Math.abs(horizontal(listener.position)), Math.abs(vertical(listener.position))) * 1.2
  const scale = dragScale ?? extent
  const screen = (position: SpatialScenePoint['position']) => ({ x: 240 + horizontal(position) / scale * 192, y: 160 - vertical(position) / scale * 112 })
  const selectedPoint = points.find(point => point.id === selected)
  const selectedIndex = points.findIndex(point => point.id === selected)
  const ear = screen(listener.position)
  const anchors = new Map(points.map(point => [point.id, screen(point.position)]))
  const markers = drag.current ? new Map(points.map(point => {
    const moving = drag.current!, anchor = anchors.get(point.id)!
    return [point.id, point.id === moving.id ? { x: anchor.x + moving.offset.x, y: anchor.y + moving.offset.y } : moving.markers.get(point.id) ?? anchor]
  })) : arrangeMarkers(anchors, ear)
  const finish = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = null; setDragScale(null)
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
  }
  const coordinate = (event: PointerEvent<SVGElement>) => {
    const svg = svgRef.current, matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY
    return point.matrixTransform(matrix.inverse())
  }
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const moving = drag.current
    if (!moving) return
    const point = points.find(item => item.id === moving.id), cursor = coordinate(event)
    if (!point || !cursor) return
    const dh = (cursor.x - moving.cursor.x) / 192 * moving.scale
    const dv = -(cursor.y - moving.cursor.y) / 112 * moving.scale
    // 从按下时的真实坐标累计光标位移，偏移后的编号在按下及零位移时都不会把声源拉到标签处。
    const shifted = (value: number, delta: number) => Math.abs(delta) < 1e-9 ? value : clamp(value + delta)
    onMove(point.id, { ...point.position, ...(view === 'top'
      ? { x: shifted(moving.position.x, dh), z: shifted(moving.position.z, dv) }
      : { z: shifted(moving.position.z, dh), y: shifted(moving.position.y, dv) }) })
  }
  const keyboard = (event: KeyboardEvent<SVGElement | HTMLButtonElement>, point: SpatialScenePoint) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(point.id); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); onSelect(point.id)
    const step = event.shiftKey ? 0.01 : 0.1, next = { ...point.position }
    const h = view === 'top' ? 'x' : 'z', v = view === 'top' ? 'z' : 'y'
    if (event.key === 'ArrowLeft') next[h] = clamp(next[h] - step)
    if (event.key === 'ArrowRight') next[h] = clamp(next[h] + step)
    if (event.key === 'ArrowUp') next[v] = clamp(next[v] + step)
    if (event.key === 'ArrowDown') next[v] = clamp(next[v] - step)
    onMove(point.id, next)
  }
  const ordered = selectedPoint ? [...points.filter(point => point.id !== selected), selectedPoint] : points

  return <div className="overflow-hidden rounded-2xl border" style={{ borderColor: theme.cardBorder, background: theme.cardBg }}>
    <div className="relative">
      <span className="pointer-events-none absolute inset-x-0 top-2 text-center text-xs" style={{ color: '#536b66' }}>{view === 'top' ? '前方 +Z' : '上方 +Y'}</span>
      <span className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs" style={{ color: '#536b66' }}>{view === 'top' ? '后方 −Z' : '下方 −Y'}</span>
      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs" style={{ color: '#536b66', writingMode: 'vertical-rl' }}>{view === 'top' ? '左侧 −X' : '后方 −Z'}</span>
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs" style={{ color: '#536b66', writingMode: 'vertical-rl' }}>{view === 'top' ? '右侧 +X' : '前方 +Z'}</span>
    <svg ref={svgRef} viewBox="0 0 480 320" role="group" aria-labelledby={titleId} aria-describedby={instructionId}
      className="block w-full" style={{ touchAction: 'none', background: theme.panelBg }}
      onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}
      onLostPointerCapture={() => { drag.current = null; setDragScale(null) }}>
      <title id={titleId}>{view === 'top' ? '声场俯视编辑图' : '声场侧视编辑图'}</title>
      <desc id={instructionId}>选择编号节点或图下完整名称。编号自动避让，连接线端点表示真实位置。拖动节点调整位置，方向键每次移动 0.1 米，按住 Shift 每次移动 0.01 米。</desc>
      {[-2, -1, 0, 1, 2].map(step => <g key={step} stroke={theme.cardBorder} strokeWidth={step === 0 ? 1.2 : 0.7}>
        <line x1={240 + step * 88} y1={40} x2={240 + step * 88} y2={280} />
        <line x1={40} y1={160 + step * 52} x2={440} y2={160 + step * 52} />
      </g>)}
      {selectedPoint && (() => { const at = screen(selectedPoint.position); return <line x1={ear.x} y1={ear.y} x2={at.x} y2={at.y} stroke={theme.accentColor} strokeWidth="1.2" strokeDasharray="4 5" /> })()}
      {points.map(point => {
        const anchor = anchors.get(point.id)!, marker = markers.get(point.id)!, active = selected === point.id
        if (Math.hypot(anchor.x - marker.x, anchor.y - marker.y) < 1) return null
        return <g key={point.id} style={{ pointerEvents: 'none' }} aria-hidden="true">
          <line data-scene-connector={point.id} x1={anchor.x} y1={anchor.y} x2={marker.x} y2={marker.y}
            stroke={active ? theme.accentColor : '#536b66'} strokeWidth={active ? 1.6 : 1} />
          <circle cx={anchor.x} cy={anchor.y} r="3" fill={active ? theme.accentColor : '#536b66'} />
        </g>
      })}
      <g transform={`translate(${ear.x} ${ear.y})`} style={{ pointerEvents: 'none' }} aria-label="听者">
        <circle r="13" fill="#FBFDFC" stroke="#536b66" strokeWidth="1.5" />
        {view === 'top' ? <g transform={`rotate(${listener.yaw})`}>
          <path d="M-5 -18 L0 -27 L5 -18" fill="#536b66" />
          <path d="M-15 -1 Q-15 -19 0 -19 Q15 -19 15 -1 M-15 -1 V6 M15 -1 V6" fill="none" stroke="#536b66" strokeWidth="2" />
        </g> : <path d="M-4 -8 L6 -3 L10 0 L5 4 L4 10 M-17 19 Q0 6 17 19" fill="none" stroke="#536b66" strokeWidth="1.5" />}
        <rect x="-19" y="20" width="38" height="17" rx="4" fill={theme.panelBg} />
        <text y="33" textAnchor="middle" fill="#536b66" fontSize="11">听者</text>
      </g>
      {ordered.map(point => {
        const at = markers.get(point.id)!, anchor = anchors.get(point.id)!, active = selected === point.id, index = points.findIndex(item => item.id === point.id)
        return <g key={point.id} transform={`translate(${at.x} ${at.y})`} role="button" tabIndex={0}
          data-scene-point={point.id} data-anchor-x={anchor.x} data-anchor-y={anchor.y} data-marker-x={at.x} data-marker-y={at.y}
          aria-label={`选择${point.label}${point.muted ? '，已静音' : ''}`} aria-pressed={active}
          style={{ cursor: drag.current?.id === point.id ? 'grabbing' : 'grab', outlineOffset: 4 }}
          onKeyDown={event => keyboard(event, point)} onPointerDown={event => {
            if (event.button !== 0) return
            const cursor = coordinate(event)
            if (!cursor) return
            event.preventDefault(); event.currentTarget.focus()
            drag.current = { id: point.id, cursor, position: { ...point.position }, scale, offset: { x: at.x - anchor.x, y: at.y - anchor.y }, markers }
            onSelect(point.id); setDragScale(scale)
            svgRef.current?.setPointerCapture?.(event.pointerId)
          }}>
          {active && <circle r="25" fill="none" stroke={theme.accentColor} strokeWidth="1.5" strokeDasharray="3 3" />}
          <rect x="-19" y="-19" width="38" height="38" rx="10" fill={active ? theme.accentDim : '#FBFDFC'}
            stroke={active ? theme.accentColor : '#536b66'} strokeWidth={active ? 2 : 1.5} strokeDasharray={point.muted ? '3 3' : undefined} />
          <text y="5" textAnchor="middle" fontSize="13" fill={active ? theme.accentColor : '#153a37'} className="hse-mono" style={{ pointerEvents: 'none' }}>{String(index + 1).padStart(2, '0')}</text>
          {point.muted && <g transform="translate(15 -16)" aria-hidden="true">
            <circle r="8" fill="#FBFDFC" stroke="#536b66" />
            <path d="M-4 -4 L4 4 M-4 4 L4 -4" stroke="#536b66" strokeWidth="1.5" />
          </g>}
        </g>
      })}
    </svg>
    </div>
    <div className="border-t px-3 py-3" style={{ borderColor: theme.cardBorder }}>
      <div className="flex flex-wrap gap-2" role="group" aria-label="二维声源列表">
        {points.map((point, index) => <button key={point.id} type="button" aria-pressed={selected === point.id}
          onClick={() => onSelect(point.id)} onKeyDown={event => keyboard(event, point)}
          className="hse-glass-choice flex min-h-10 max-w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs"
          style={{ borderColor: selected === point.id ? theme.accentColor : theme.cardBorder, background: selected === point.id ? theme.accentDim : theme.cardBg, color: '#153a37' }}>
          <span className="hse-mono" style={{ color: theme.accentColor }}>{String(index + 1).padStart(2, '0')}</span>
          <span className="min-w-0 break-words">{point.label}{point.muted ? ' · 静音' : ''}</span>
          {selected === point.id && <span aria-hidden="true">✓</span>}
        </button>)}
        {!points.length && <p className="text-xs" style={{ color: '#536b66' }}>暂无声源，请添加一个声源后调整位置。</p>}
      </div>
      <p className="mt-3 text-xs leading-relaxed" style={{ color: '#536b66' }} aria-live="polite">
        {selectedPoint ? <><span className="hse-mono">{String(selectedIndex + 1).padStart(2, '0')}</span> {selectedPoint.label} · 距听者 <span className="hse-mono">{Math.hypot(selectedPoint.position.x - listener.position.x, selectedPoint.position.y - listener.position.y, selectedPoint.position.z - listener.position.z).toFixed(2)} m</span> · 高度 <span className="hse-mono">{selectedPoint.position.y.toFixed(2)} m</span>{selectedPoint.muted ? ' · 已静音' : ''}</> : '选择声源后拖动位置，或用方向键微调。'}
      </p>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs" style={{ color: '#536b66' }}>
        <span>{view === 'top' ? '左右 / 前后' : '前后 / 高度'} · 方向键 0.1 m · Shift 0.01 m</span><span className="hse-mono">范围 ±{scale.toFixed(1)} m</span>
      </div>
      <p className="mt-2 text-xs" style={{ color: '#536b66' }}>编号自动避让 · 连接线端点为真实位置</p>
    </div>
  </div>
}
