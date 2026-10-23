/**
 * WaveForge v3 调音室 UI —— EQ 响应曲线编辑器（SVG）
 *
 * 对数频率轴（20Hz–20kHz）× 增益轴（-12..+12dB）折线图；
 * 控制点可拖拽（指针捕获），与 v1/v2 调音室的"拖动频点"交互一致。
 * 纯展示 + 受控回调，不依赖任何绘图库。
 */

import { useLayoutEffect, useRef, useState } from 'react'
import type { V3Theme } from './theme'

export interface EqPoint {
  frequency: number
  gain: number
}

export interface EqCurveEditorProps {
  points: EqPoint[]
  theme: V3Theme
  onChange?: (index: number, gain: number) => void
  onSelect?: (index: number) => void
  selectedIndex?: number
  /** 只读模式（锁定态/预览态） */
  readonly?: boolean
  /** 附加参考曲线（如 Q 补偿后的预估响应，仅展示） */
  reference?: EqPoint[]
  height?: number
  minDb?: number
  maxDb?: number
  fMin?: number
  fMax?: number
}

/** 对数频率 → 0..1 x 坐标 */
export function fToX(freq: number, fMin: number, fMax: number): number {
  return (Math.log(freq / fMin) / Math.log(fMax / fMin))
}

/** 增益 → 0..1 y 坐标（顶部为 +max） */
export function dbToY(gain: number, minDb: number, maxDb: number): number {
  return 1 - (gain - minDb) / (maxDb - minDb)
}

export function EqCurveEditor({ points, theme, onChange, onSelect, selectedIndex, readonly, reference, height = 170, minDb = -12, maxDb = 12, fMin = 20, fMax = 20000 }: EqCurveEditorProps) {
  const [W, setWidth] = useState(420)
  const H = height
  const padL = 38
  const padR = 12
  const padT = 12
  const padB = 28
  const iw = W - padL - padR
  const ih = H - padT - padB
  const svgRef = useRef<SVGSVGElement>(null)
  // 显示高度固定，坐标宽度跟随容器，避免宽窗口把图表和文字等比放大。
  useLayoutEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => {
      const width = svg.getBoundingClientRect().width
      if (width > 0) setWidth(width)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(svg)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  const [localSelectedIndex, setLocalSelectedIndex] = useState<number | undefined>(selectedIndex ?? 0)
  const activeSelectedIndex = Math.min(selectedIndex ?? localSelectedIndex ?? 0, Math.max(0, points.length - 1))
  const selectPoint = (index: number) => {
    setLocalSelectedIndex(index)
    onSelect?.(index)
  }

  const x = (f: number) => padL + fToX(f, fMin, fMax) * iw
  const y = (g: number) => padT + dbToY(g, minDb, maxDb) * ih

  /** 频段控制点的三次贝塞尔连线。 */
  const smoothPath = (pts: EqPoint[]): string => {
    if (pts.length === 0) return ''
    if (pts.length === 1) return `M${x(pts[0].frequency).toFixed(2)},${y(pts[0].gain).toFixed(2)}`
    const P = pts.map((p) => [x(p.frequency), y(p.gain)] as [number, number])
    let d = `M${P[0][0].toFixed(2)},${P[0][1].toFixed(2)}`
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] ?? P[i]
      const p1 = P[i]
      const p2 = P[i + 1]
      const p3 = P[i + 2] ?? p2
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
    }
    return d
  }

  const [dragIdx, setDragIdx] = useState<number | null>(null)

  /** 命中检测：频率最近的拖拽点 */
  const hitIndex = (clientX: number, clientY: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return null
    const px = ((clientX - rect.left) / rect.width) * W
    const py = ((clientY - rect.top) / rect.height) * H
    // 找最近的频点（x 距离 < 18px 才命中）
    let best = -1
    let bestD = 18
    points.forEach((p, i) => {
      const d = Math.hypot(x(p.frequency) - px, y(p.gain) - py)
      if (d < bestD) { bestD = d; best = i }
    })
    return best >= 0 ? best : null
  }

  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = hitIndex(e.clientX, e.clientY)
    if (idx === null) return
    selectPoint(idx)
    if (readonly || !onChange) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragIdx(idx)
    const rect = e.currentTarget.getBoundingClientRect()
    const py = ((e.clientY - rect.top) / rect.height) * H
    applyGain(idx, py)
  }

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readonly || !onChange || e.buttons !== 1) return
    const rect = e.currentTarget.getBoundingClientRect()
    const py = ((e.clientY - rect.top) / rect.height) * H
    if (dragIdx !== null) applyGain(dragIdx, py)
  }

  const endDrag = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    setDragIdx(null)
  }

  const applyGain = (idx: number, py: number) => {
    if (!onChange) return
    const gain = minDb + (1 - (py - padT) / ih) * (maxDb - minDb)
    onChange(idx, Math.round(Math.min(maxDb, Math.max(minDb, gain)) * 10) / 10)
  }

  // 频率网格刻度（100Hz / 1kHz / 10kHz 标签）
  const gridFreqs = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter((frequency) => frequency >= fMin && frequency <= fMax)
  const gainTicks = Array.from({ length: 5 }, (_, index) => minDb + (maxDb - minDb) * index / 4)
  const zeroY = y(0)

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      aria-label="均衡器响应曲线"
      className="hse-mono w-full touch-none select-none rounded-xl border"
      style={{ height, display: 'block', background: theme.inputBg, borderColor: theme.glassBorder, cursor: readonly ? 'default' : 'grab' }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={() => setDragIdx(null)}
    >
      {/* 网格 */}
      {gridFreqs.map((f) => (
        <line key={f} x1={x(f)} y1={padT} x2={x(f)} y2={padT + ih} stroke={theme.glassBorder} strokeWidth={1} />
      ))}
      {/* 0dB 中线 */}
      <line x1={padL} y1={zeroY} x2={padL + iw} y2={zeroY} stroke="#8b9e91" strokeWidth={1} strokeDasharray="4 3" />

      {/* 参考曲线（Q 补偿预估等） */}
      {reference && reference.length > 0 && (
        <path d={smoothPath(reference)} fill="none" stroke="#536b66" strokeWidth={1.2} strokeDasharray="3 3" />
      )}

      {/* 主曲线（贝塞尔平滑） */}
      <path d={smoothPath(points)} fill="none" stroke={theme.accentColor} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {/* 填充 */}
      <path d={`${smoothPath(points)} L${x(points[points.length - 1]?.frequency ?? 20000).toFixed(2)},${zeroY.toFixed(2)} L${x(points[0]?.frequency ?? 20).toFixed(2)},${zeroY.toFixed(2)} Z`}
        fill={theme.accentColor} opacity={0.12} />

      {/* 控制点 */}
      {points.map((p, i) => {
        const active = dragIdx === i
        const selected = activeSelectedIndex === i
        return (
          <g key={i} role="button" tabIndex={0} aria-label={`选择 ${Number(p.frequency.toFixed(1))} Hz 频段`} aria-pressed={selected}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPoint(i) }
              if (!readonly && onChange && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
                event.preventDefault()
                selectPoint(i)
                const next = p.gain + (event.key === 'ArrowUp' ? 0.1 : -0.1)
                onChange(i, Number(Math.min(maxDb, Math.max(minDb, next)).toFixed(1)))
              }
            }}>
            {selected && <circle cx={x(p.frequency)} cy={y(p.gain)} r={9} fill="none" stroke={theme.accentColor} strokeWidth={1} opacity={0.45} />}
            <circle cx={x(p.frequency)} cy={y(p.gain)} r={8} fill="transparent" style={{ cursor: readonly ? 'default' : 'pointer' }} />
            <circle cx={x(p.frequency)} cy={y(p.gain)} r={active ? 5.5 : selected ? 5 : 4.5} fill="#ffffff" stroke={theme.accentColor} strokeWidth={selected ? 2.5 : 2}
              style={{ cursor: readonly ? 'default' : 'pointer', transition: 'r 0.1s ease' }} />
          </g>
        )
      })}

      {/* 拖动 Tooltip：实时显示 Hz / dB */}
      {dragIdx !== null && points[dragIdx] && (() => {
        const p = points[dragIdx]
        const tx = Math.max(padL + 26, Math.min(padL + iw - 26, x(p.frequency)))
        const ty = Math.max(padT + 10, y(p.gain) - 12)
        const label = `${Number(p.frequency.toFixed(1))} Hz · ${p.gain > 0 ? '+' : ''}${p.gain.toFixed(1)} dB`
        const w = label.length * 4.2 + 10
        return (
          <g pointerEvents="none">
            <rect x={tx - w / 2} y={ty - 11} width={w} height={15} rx={4} fill="#ffffff" stroke={theme.accentColor} strokeWidth={0.8} />
            <text x={tx} y={ty} textAnchor="middle" fontSize={9} fill={theme.accentColor} style={{ font: '9px ui-monospace, monospace' }}>{label}</text>
          </g>
        )
      })()}

      {/* 频率标签 */}
      {[100, 1000, 10000].map((f) => (
        <text key={f} x={x(f)} y={H - 5} textAnchor="middle" fontSize={9}
          fill={'#536b66'}>{f >= 1000 ? `${f / 1000}k` : f}Hz</text>
      ))}
      <text x={padL} y={H - 5} textAnchor="start" fontSize={9} fill={'#536b66'}>20</text>
      <text x={padL + iw} y={H - 5} textAnchor="end" fontSize={9} fill={'#536b66'}>20k</text>

      {/* 增益刻度位于独立左边距，避免压住曲线 */}
      {gainTicks.map((db) => (
        <text key={db} x={padL - 7} y={y(db) + 3} textAnchor="end" fontSize={9}
          fill={'#536b66'}>{db > 0 ? `+${db}` : db} dB</text>
      ))}
    </svg>
  )
}
