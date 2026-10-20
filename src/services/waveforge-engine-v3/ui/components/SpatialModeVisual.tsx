/** 立体声展开示意。SVG 坐标同时用于显示与拖动，窗口缩放后保持相同角度。 */
import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import type { HSETheme } from '../hse-theme'

interface SpatialModeVisualProps {
  /** 两个虚拟扬声器之间的展开角度，20..120 度。 */
  spreadDeg: number
  /** 原声与空间声音的混合比例，0..1。 */
  amount: number
  active: boolean
  theme: HSETheme
  /** 保留调用方兼容性；布局变化直接呈现，不播放装饰动画。 */
  transitionKey?: number
  onSpreadChange?: (spreadDeg: number) => void
}

const CENTER = { x: 240, y: 224 }
const RADIUS = 164
const clampSpread = (value: number) => Math.min(120, Math.max(20, Math.round(value)))
const speakerAt = (angle: number, radius = RADIUS) => ({
  x: CENTER.x + radius * Math.sin(angle), y: CENTER.y - radius * Math.cos(angle),
})

export function SpatialModeVisual({ spreadDeg, amount, active, theme, onSpreadChange }: SpatialModeVisualProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<'left' | 'right' | null>(null)
  const lastValue = useRef(spreadDeg)
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null)
  const titleId = useId(), descriptionId = useId()
  const value = clampSpread(spreadDeg), half = value * Math.PI / 360
  const left = speakerAt(-half), right = speakerAt(half)
  const arcLeft = speakerAt(-half, 76), arcRight = speakerAt(half, 76)
  const editable = active && !!onSpreadChange
  const line = active ? theme.accentColor : '#536b66'

  const change = (next: number) => {
    const bounded = clampSpread(next)
    if (bounded !== lastValue.current) { lastValue.current = bounded; onSpreadChange?.(bounded) }
  }
  const end = (event: PointerEvent<SVGSVGElement>) => {
    drag.current = null; setDragging(null)
    if (svgRef.current?.hasPointerCapture?.(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current, matrix = svg?.getScreenCTM()
    if (!editable || !drag.current || !svg || !matrix) return
    const cursor = svg.createSVGPoint()
    cursor.x = event.clientX; cursor.y = event.clientY
    const at = cursor.matrixTransform(matrix.inverse())
    change(2 * Math.abs(Math.atan2(at.x - CENTER.x, CENTER.y - at.y)) * 180 / Math.PI)
  }
  const keyboard = (event: KeyboardEvent<SVGGElement>) => {
    if (!editable) return
    const step = event.shiftKey ? 5 : 1
    const next = ({ ArrowLeft: value - step, ArrowDown: value - step, ArrowRight: value + step,
      ArrowUp: value + step, PageDown: value - 10, PageUp: value + 10, Home: 20, End: 120 } as Record<string, number>)[event.key]
    if (next === undefined) return
    event.preventDefault(); lastValue.current = value; change(next)
  }

  return <div className="w-full" style={{ maxWidth: 520, margin: '0 auto' }}>
    <svg ref={svgRef} viewBox="0 0 480 292" role="group" aria-labelledby={titleId} aria-describedby={descriptionId}
      className="block w-full" style={{ touchAction: 'none', overflow: 'visible' }}
      onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { drag.current = null; setDragging(null) }}>
      <title id={titleId}>立体声展开位置</title>
      <desc id={descriptionId}>俯视图，上方是听者前方。两个虚拟扬声器分别播放左、右声道。可拖动任一扬声器，或聚焦后用方向键调整展开角度。</desc>
      <path d="M48 224 H432 M80 160 H400 M112 96 H368 M160 48 V224 M320 48 V224" fill="none" stroke={theme.cardBorder} strokeWidth="1" />
      <path d="M240 208 V40 M236 46 L240 40 L244 46" fill="none" stroke="#536b66" strokeWidth="1.5" strokeDasharray="4 5" />
      <text x="240" y="25" textAnchor="middle" fontSize="12" fill="#536b66">前方</text>
      <path d="M98 142 A164 164 0 0 1 382 142" fill="none" stroke={theme.cardBorder} strokeWidth="1.5" strokeDasharray="3 5" />
      <path d={`M${left.x} ${left.y} L240 224 L${right.x} ${right.y}`} fill="none" stroke={line} strokeWidth="1.5" />
      <path d={`M${arcLeft.x} ${arcLeft.y} A76 76 0 0 1 ${arcRight.x} ${arcRight.y}`} fill="none" stroke={line} strokeWidth="1.5" />
      <rect x="214" y="122" width="52" height="24" rx="6" fill="#FBFDFC" />
      <text x="240" y="139" textAnchor="middle" fontSize="14" fill={line} className="hse-mono">{value}°</text>
      {(['left', 'right'] as const).map(side => {
        const at = side === 'left' ? left : right
        const label = side === 'left' ? '左声道 L' : '右声道 R'
        const grab = dragging === side
        return <g key={side} transform={`translate(${at.x} ${at.y})`} role="slider" tabIndex={editable ? 0 : -1}
          aria-label={`${label}，展开角度`} aria-valuemin={20} aria-valuemax={120} aria-valuenow={value}
          aria-valuetext={`${value} 度`} aria-disabled={!editable} onKeyDown={keyboard}
          style={{ cursor: editable ? grab ? 'grabbing' : 'grab' : 'default', outlineOffset: 5 }}
          onPointerDown={event => {
            if (!editable || event.button !== 0) return
            event.preventDefault(); event.currentTarget.focus(); drag.current = side; setDragging(side)
            lastValue.current = value; svgRef.current?.setPointerCapture?.(event.pointerId)
          }}>
          <rect x="-22" y="-25" width="44" height="50" rx="9" fill={grab ? theme.accentDim : '#FBFDFC'} stroke={line} strokeWidth={grab ? 2.5 : 1.5} />
          <circle cy="-8" r="3" fill="none" stroke={line} strokeWidth="1.5" />
          <circle cy="8" r="7" fill="none" stroke={line} strokeWidth="1.5" />
          <text x={side === 'left' ? -8 : 8} y="43" textAnchor={side === 'left' ? 'end' : 'start'} fontSize="12" fill="#153a37" style={{ pointerEvents: 'none' }}>{label}</text>
        </g>
      })}
      <g transform="translate(240 224)" aria-label="听者，朝向前方">
        <path d="M-15 -4 C-15 -23 15 -23 15 -4 M-16 -4 V8 M16 -4 V8" fill="none" stroke="#536b66" strokeWidth="2.5" strokeLinecap="round" />
        <circle r="10" fill="#FBFDFC" stroke="#536b66" strokeWidth="1.5" />
        <path d="M-16 18 Q0 5 16 18" fill="none" stroke="#536b66" strokeWidth="1.5" />
        <text y="38" textAnchor="middle" fontSize="12" fill="#536b66">听者</text>
      </g>
      <text x="24" y="280" fontSize="11" fill="#536b66">{active ? `空间强度 ${Math.round(Math.min(1, Math.max(0, amount)) * 100)}%` : '原声对比 · 位置编辑暂停'}</text>
      <text x="456" y="280" textAnchor="end" fontSize="11" fill="#536b66">{editable ? '拖动音箱 · 方向键微调' : '立体声布局示意'}</text>
    </svg>
  </div>
}
