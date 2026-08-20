/**
 * SpatialRingEditor —— 模式 B 头锁定环绕 2D 环形俯视编辑器（Canvas 2D）
 *
 * 俯视视角：圆心为听者头部，画布上方为前方（az=0）、az>0 偏右（与
 * SpatialModeVisual/instantSpeakers 同一角度约定）；扬声器按 (azimuthDeg,
 * distance) 极坐标绘制，半径按 √(distance/10m) 映射（近场拉开间距）。
 *
 * 交互（仅自定义布局 editable=true）：
 *  - 拖拽点沿圆周改变方位角（pointer 捕获 + atan2 换算，取整到度）；
 *  - 单击选中 → 下方属性区 Slider 微调（方位角/仰角/距离/增益）；
 *  - 双击删除（调用方保证至少保留 1 只）；「添加扬声器」上限 16 只；
 *  - 右键扬声器弹出菜单（复制/删除/静音/Solo——菜单在 editable 且 muted/
 *    onToggleMuted/onDuplicateSpeaker 全部提供时启用，向后兼容缺省不渲染）。
 * 预设布局（editable=false）只读灰调展示，不可交互。
 * 颜色：az<0（左）电光青 accentFrom / az>0（右）深邃紫 accentTo；
 * 仰角≠0 的扬声器（顶置/底部层）带外圈空心标记；静音扬声器点灰显（alpha 0.25）。
 */

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { HSETheme } from '../hse-theme'
import type { SpeakerRoute, VirtualSpeakerCfg } from '../../src/spatial/types'
import { Slider, InfoLine, Segmented } from './Primitives'

interface SpatialRingEditorProps {
  speakers: VirtualSpeakerCfg[]
  /** 可编辑（layout==='custom'）；false 时只读灰调 */
  editable: boolean
  /** 修改第 index 只扬声器（局部字段） */
  onChangeSpeaker: (index: number, patch: Partial<VirtualSpeakerCfg>) => void
  /** 删除第 index 只扬声器（调用方保证至少保留 1 只） */
  onDeleteSpeaker: (index: number) => void
  /** 添加扬声器（调用方保证不超过上限） */
  onAddSpeaker: () => void
  theme: HSETheme
  /** 扬声器输入路由列表（与 speakers 等长；缺失项按方位角默认显示——缺省不渲染路由控件） */
  routes?: SpeakerRoute[]
  /** 修改第 index 只扬声器的输入路由（缺省不渲染路由控件，向后兼容） */
  onChangeRoute?: (index: number, route: SpeakerRoute) => void
  /**
   * 每只扬声器的静音状态（与 speakers 等长；缺失视为未静音）。
   * 与 onToggleMuted/onDuplicateSpeaker 同时提供时启用右键菜单（向后兼容：
   * 缺省不渲染菜单）；静音扬声器点灰显（alpha 0.25）。
   */
  muted?: boolean[]
  /** 切换第 index 只扬声器的静音状态（右键菜单「静音/取消静音」） */
  onToggleMuted?: (index: number) => void
  /**
   * Solo 第 index 只扬声器（右键菜单「Solo」）：父面板基于全局最新参数一次性
   * 构建目标数组（其它 muted=true、本只 muted=false）单次提交。提供时 handleSolo
   * 优先走本回调，避免逐只 onToggleMuted 在事件闭包陈旧的 React state 上反复
   * 覆盖（末只覆盖前只、Solo 仅末只生效的旧 bug）；缺省回退逐只翻转（向后兼容）。
   */
  onSoloSpeaker?: (index: number) => void
  /** 复制第 index 只扬声器并追加到列表尾部（调用方保证不超过 16 上限） */
  onDuplicateSpeaker?: (index: number) => void
}

/** 距离映射上限（米）——环形图最外圈 */
const MAX_DISTANCE = 10
/** 自定义布局扬声器上限 */
const MAX_SPEAKERS = 16
/** 点选命中半径（CSS px） */
const HIT_RADIUS = 14
/** 环形图距离刻度（米，√ 映射后视觉间隔均匀） */
const RING_DISTANCES = [1.5, 3, 6, 10]

/** 扬声器输入路由选项（左源/右源/左右混合） */
const ROUTE_OPTIONS: { value: SpeakerRoute; label: string }[] = [
  { value: 'l', label: '左源' },
  { value: 'r', label: '右源' },
  { value: 'both', label: '左右混合' },
]

/** 右键菜单宽高估算（CSS px，用于菜单位置边缘钳位） */
const MENU_WIDTH = 112
const MENU_HEIGHT = 140

/** 右键菜单单项（theme 风格小浮层项） */
function MenuItem({ label, onClick, disabled, theme }: {
  label: string
  onClick: () => void
  disabled?: boolean
  theme: HSETheme
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-xs transition-colors hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
      style={{ color: theme.textSecondary }}
    >
      {label}
    </button>
  )
}

/** 画布几何（CSS px）：圆心 + 环形半径（随容器自适应） */
function ringGeometry(w: number, h: number): { cx: number; cy: number; radius: number } {
  const radius = Math.max(40, Math.min(w, h) / 2 - 18)
  return { cx: w / 2, cy: h / 2, radius }
}

/** 扬声器 → 屏幕坐标（前方朝上：x = cx + r·sinθ、y = cy − r·cosθ） */
function speakerPos(
  s: VirtualSpeakerCfg,
  g: { cx: number; cy: number; radius: number },
): { x: number; y: number } {
  const r = g.radius * Math.sqrt(Math.min(MAX_DISTANCE, Math.max(0.1, s.distance)) / MAX_DISTANCE)
  const rad = (s.azimuthDeg * Math.PI) / 180
  return { x: g.cx + r * Math.sin(rad), y: g.cy - r * Math.cos(rad) }
}

export function SpatialRingEditor({
  speakers,
  editable,
  onChangeSpeaker,
  onDeleteSpeaker,
  onAddSpeaker,
  theme,
  routes,
  onChangeRoute,
  muted,
  onToggleMuted,
  onSoloSpeaker,
  onDuplicateSpeaker,
}: SpatialRingEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const draggingRef = useRef<number | null>(null)
  /** 右键菜单状态（打开的扬声器索引 + 菜单位置；null = 关闭） */
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  /**
   * 数据参数 ref：draw 内读取，避免 speakers/muted/selected/editable 进入绘制 effect
   * 依赖。拖拽时 speakers/selected 高频变化，若入依赖会反复 cleanup+重建 canvas
   * 设置（重获 ctx、重挂 resize 监听）；改读 ref 后设置 effect 仅依赖主题，另用
   * 轻量重绘 effect（数据 deps）触发 drawRef.current?.() 刷新画面（零重挂开销）。
   */
  const speakersRef = useRef(speakers)
  const mutedRef = useRef(muted)
  const selectedRef = useRef(selected)
  const editableRef = useRef(editable)
  const drawRef = useRef<(() => void) | null>(null)
  speakersRef.current = speakers
  mutedRef.current = muted
  selectedRef.current = selected
  editableRef.current = editable

  /** 右键菜单启用条件：可编辑 + 静音/复制全部新 props 提供（向后兼容缺省不渲染） */
  const menuEnabled =
    editable && muted !== undefined && onToggleMuted !== undefined && onDuplicateSpeaker !== undefined

  // 布局切换（editable 变化）或列表缩短（删除）时清理选中
  useEffect(() => {
    if (!editable) setSelected(null)
  }, [editable])
  useEffect(() => {
    if (selected !== null && selected >= speakers.length) setSelected(null)
  }, [speakers.length, selected])

  // 菜单打开期间：点击其它处关闭（document 监听，卸载清理）
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])

  const canvasGeometry = (): { cx: number; cy: number; radius: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return ringGeometry(Math.max(1, rect?.width ?? 1), Math.max(1, rect?.height ?? 1))
  }

  const eventPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  /** 命中检测：命中半径内最近的扬声器，无则 null */
  const hitTest = (x: number, y: number): number | null => {
    const g = canvasGeometry()
    let best: number | null = null
    let bestDist = HIT_RADIUS
    speakers.forEach((s, i) => {
      const p = speakerPos(s, g)
      const d = Math.hypot(p.x - x, p.y - y)
      if (d < bestDist) {
        bestDist = d
        best = i
      }
    })
    return best
  }

  // —— 绘制（设置 effect：仅主题变化时重挂；数据参数经 ref 读取） ——
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let width = 0
    let height = 0

    const draw = () => {
      // 读 ref（数据参数变化不重挂 effect，见上方 ref 注释）
      const speakers = speakersRef.current
      const muted = mutedRef.current
      const selected = selectedRef.current
      const editable = editableRef.current
      const g = ringGeometry(width, height)
      ctx.clearRect(0, 0, width, height)
      const from = theme.accentFrom // 电光青（左）
      const to = theme.accentTo // 深邃紫（右）

      // 背景圆盘
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, g.radius, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1
      ctx.stroke()

      // 距离刻度环（√ 映射）
      ctx.font = '9px ui-monospace, "JetBrains Mono", "Roboto Mono", monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const d of RING_DISTANCES) {
        const r = g.radius * Math.sqrt(d / MAX_DISTANCE)
        ctx.beginPath()
        ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(255,255,255,0.07)'
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.fillText(`${d}m`, g.cx + r + 4, g.cy)
      }

      // 十字轴线（前-后 / 左-右）
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(g.cx, g.cy - g.radius)
      ctx.lineTo(g.cx, g.cy + g.radius)
      ctx.moveTo(g.cx - g.radius, g.cy)
      ctx.lineTo(g.cx + g.radius, g.cy)
      ctx.stroke()
      ctx.setLineDash([])

      // 方位标注（前/后/左/右）
      ctx.font = '10px "PingFang SC", "Microsoft YaHei", sans-serif'
      ctx.fillStyle = 'rgba(255,255,255,0.35)'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText('前', g.cx, g.cy - g.radius - 2)
      ctx.textBaseline = 'top'
      ctx.fillText('后', g.cx, g.cy + g.radius + 2)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.fillText('左', g.cx - g.radius - 4, g.cy)
      ctx.textAlign = 'left'
      ctx.fillText('右', g.cx + g.radius + 4, g.cy)

      // 听者头部（圆心耳机点 + 光环）
      ctx.strokeStyle = `${from}55`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, 8, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = from
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, 3.5, 0, Math.PI * 2)
      ctx.fill()

      // 扬声器点（预设只读灰调；选中点高亮环；静音点灰显 alpha 0.25）
      const dim = editable ? 1 : 0.4
      speakers.forEach((s, i) => {
        const p = speakerPos(s, g)
        const color = s.azimuthDeg < 0 ? from : to
        const isSel = selected === i
        // 静音扬声器：仅正常亮度的 1/4（alpha 0.25）——弱化但保留位置可读，
        // 与右键菜单「静音」状态一致
        const speakerDim = muted?.[i] === true ? dim * 0.25 : dim
        ctx.save()
        ctx.globalAlpha = speakerDim
        if (editable) {
          ctx.shadowColor = color
          ctx.shadowBlur = isSel ? 18 : 12
        }
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x, p.y, isSel ? 6.5 : 5, 0, Math.PI * 2)
        ctx.fill()
        // 仰角≠0（顶置/底部层）：外圈空心标记
        if (s.elevationDeg !== 0) {
          ctx.globalAlpha = speakerDim * 0.9
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(p.x, p.y, 9.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        // 选中高亮环
        if (isSel && editable) {
          ctx.globalAlpha = 1
          ctx.strokeStyle = color
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(p.x, p.y, 12, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
        // 序号标注
        ctx.globalAlpha = speakerDim
        ctx.fillStyle = 'rgba(255,255,255,0.5)'
        ctx.font = '9px ui-monospace, "JetBrains Mono", "Roboto Mono", monospace'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'bottom'
        ctx.fillText(String(i + 1), p.x + 7, p.y - 7)
        ctx.globalAlpha = 1
      })
    }

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      draw()
    }
    drawRef.current = draw
    resize()
    window.addEventListener('resize', resize)
    return () => {
      drawRef.current = null
      window.removeEventListener('resize', resize)
    }
    // 依赖仅主题：数据参数经 ref 读取（拖拽时不重挂 canvas 设置，见上方 ref 注释）
  }, [theme.accentFrom, theme.accentTo])

  // 数据变化触发轻量重绘（不重挂 canvas 设置：仅调 drawRef.current，拖拽/选中等零重挂开销）
  useEffect(() => {
    drawRef.current?.()
  }, [speakers, muted, selected, editable])

  // —— 交互（仅 editable） ——
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!editable) return
    e.preventDefault()
    const p = eventPos(e)
    const idx = hitTest(p.x, p.y)
    setSelected(idx)
    if (idx !== null) {
      draggingRef.current = idx
      try {
        canvasRef.current?.setPointerCapture(e.pointerId)
      } catch {
        /* 捕获失败仍可拖动（鼠标悬停期间） */
      }
    }
  }

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const idx = draggingRef.current
    if (idx === null || !editable) return
    const p = eventPos(e)
    const g = canvasGeometry()
    // 前方朝上约定下：az = atan2(Δx, −Δy)
    const az = Math.round((Math.atan2(p.x - g.cx, g.cy - p.y) * 180) / Math.PI)
    onChangeSpeaker(idx, { azimuthDeg: az })
  }

  const handlePointerEnd = () => {
    draggingRef.current = null
  }

  const handleDoubleClick = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!editable) return
    const p = eventPos(e)
    const idx = hitTest(p.x, p.y)
    if (idx === null || speakers.length <= 1) return
    onDeleteSpeaker(idx)
  }

  /** 右键：命中扬声器 → 选中并弹出菜单（preventDefault 屏蔽浏览器默认菜单）；
   *  命中空白 → 仅关闭菜单。 */
  const handleContextMenu = (e: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!menuEnabled) return
    e.preventDefault()
    const p = eventPos(e)
    const idx = hitTest(p.x, p.y)
    if (idx === null) {
      setMenu(null)
      return
    }
    setSelected(idx)
    // 菜单位置钳位在画布内（避免右/下边缘溢出容器）
    const rect = canvasRef.current?.getBoundingClientRect()
    const w = rect?.width ?? 360
    const h = rect?.height ?? 240
    setMenu({
      index: idx,
      x: Math.min(p.x, Math.max(0, w - MENU_WIDTH)),
      y: Math.min(p.y, Math.max(0, h - MENU_HEIGHT)),
    })
  }

  /**
   * Solo 语义（右键菜单）：列表内其它扬声器 muted=true、本只 muted=false——
   * 简化归一化：不做「再次 Solo 恢复全部非静音」的双态切换（再次 Solo 同一只
   * 仅重复归一化，Solo 另一只即把独奏转移到该只）。
   *
   * 提交路径：父面板提供 onSoloSpeaker 时优先单次调用（基于 getSpatialParams()
   * 全局最新一次性构建目标数组、单次 patch）；缺省回退逐只翻转 onToggleMuted
   * （向后兼容）。逐只翻转路径在事件闭包陈旧的 React state 上有「末只覆盖前只」
   * 的缺陷（handleToggleMuted 闭包读 spatial、事件内不更新），onSoloSpeaker 路径
   * 在父面板读全局快照规避之——故接线后 Solo 多扬声器正确生效。
   */
  const handleSolo = (index: number): void => {
    if (onSoloSpeaker) {
      onSoloSpeaker(index)
      return
    }
    // 回退（未接线 onSoloSpeaker 时）：逐只翻转与目标态不同的扬声器。
    if (!muted || !onToggleMuted) return
    for (let i = 0; i < speakers.length; i++) {
      const want = i === index ? false : true
      if ((muted[i] === true) !== want) onToggleMuted(i)
    }
  }

  const closeMenu = (): void => setMenu(null)

  const sel = selected !== null && selected < speakers.length ? speakers[selected] : null
  const menuSpeaker = menu !== null && menu.index < speakers.length ? speakers[menu.index] : null
  const menuMuted = menu !== null ? muted?.[menu.index] === true : false

  return (
    <div>
      <div className="relative w-full" style={{ height: 240, maxWidth: 360, margin: '0 auto' }}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="环形扬声器布局编辑器"
          className="w-full h-full"
          style={{
            display: 'block',
            cursor: editable ? 'pointer' : 'default',
            touchAction: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        />

        {/* 右键菜单（theme 风格小浮层；菜单项点击后关闭；容器阻止 pointerdown
            冒泡，避免 document 监听先关菜单导致按钮 click 丢失） */}
        {menuEnabled && menu && menuSpeaker && (
          <div
            className="absolute z-50 rounded-lg py-1 shadow-xl"
            style={{
              left: menu.x,
              top: menu.y,
              backgroundColor: theme.panelBg,
              border: `1px solid ${theme.cardBorder}`,
              backdropFilter: theme.glassBlur,
              WebkitBackdropFilter: theme.glassBlur,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="px-3 py-1 text-[10px] hse-mono" style={{ color: theme.textTertiary }}>
              #{menu.index + 1}
            </div>
            <MenuItem label="复制" theme={theme} onClick={() => { onDuplicateSpeaker!(menu.index); closeMenu() }} />
            <MenuItem
              label="删除"
              theme={theme}
              disabled={speakers.length <= 1}
              onClick={() => { onDeleteSpeaker(menu.index); closeMenu() }}
            />
            <MenuItem
              label={menuMuted ? '取消静音' : '静音'}
              theme={theme}
              onClick={() => { onToggleMuted!(menu.index); closeMenu() }}
            />
            <MenuItem label="Solo" theme={theme} onClick={() => { handleSolo(menu.index); closeMenu() }} />
          </div>
        )}
      </div>

      {/* 选中点属性区 */}
      {editable && selected !== null && sel && (
        <div className="mt-3">
          <div className={`${theme.textSecondary} text-xs mb-1`}>扬声器 {selected + 1} 属性</div>
          <Slider
            label="方位角" value={Math.round(sel.azimuthDeg)} min={-180} max={180} step={1}
            onChange={(v) => onChangeSpeaker(selected, { azimuthDeg: v })}
            display={`${Math.round(sel.azimuthDeg)}°`} theme={theme}
          />
          <Slider
            label="仰角" value={Math.round(sel.elevationDeg)} min={-90} max={90} step={1}
            onChange={(v) => onChangeSpeaker(selected, { elevationDeg: v })}
            display={`${Math.round(sel.elevationDeg)}°`} theme={theme}
          />
          <Slider
            label="距离" value={sel.distance} min={0.5} max={MAX_DISTANCE} step={0.1}
            onChange={(v) => onChangeSpeaker(selected, { distance: v })}
            display={`${sel.distance.toFixed(1)}m`} theme={theme}
          />
          <Slider
            label="增益" value={sel.gain} min={0} max={2} step={0.05}
            onChange={(v) => onChangeSpeaker(selected, { gain: v })}
            display={`${sel.gain.toFixed(2)}x`} theme={theme}
          />
          {/* 输入路由（声源路由完整版）：routes + onChangeRoute 均传入时才渲染；
              缺失项显示方位角就近默认（az≤0→左源、az>0→右源），与 fusion 缺省语义一致 */}
          {onChangeRoute && routes && (
            <div className="mt-2">
              <div className={`${theme.textSecondary} text-xs mb-1`}>输入路由</div>
              <Segmented
                options={ROUTE_OPTIONS}
                value={routes[selected] ?? (sel.azimuthDeg <= 0 ? 'l' : 'r')}
                onChange={(v) => onChangeRoute(selected, v)}
                theme={theme}
                small
              />
            </div>
          )}
        </div>
      )}

      {/* 添加扬声器（仅自定义布局，上限 16） */}
      {editable && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            disabled={speakers.length >= MAX_SPEAKERS}
            onClick={onAddSpeaker}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 disabled:opacity-40"
            style={{
              backgroundColor: theme.inputBg,
              border: `1px solid ${theme.cardBorder}`,
              color: theme.textSecondary,
            }}
          >
            + 添加扬声器
          </button>
          <span className={`hse-mono ${theme.textTertiary} text-[11px]`}>
            {speakers.length}/{MAX_SPEAKERS}
          </span>
        </div>
      )}

      {editable && (
        <InfoLine theme={theme}>
          拖拽点沿圆周调整方位角；双击删除（至少保留 1 只）；仰角 ≠ 0 显示外圈标记（顶置/底部层）。
          {menuEnabled && ' 右键扬声器弹出菜单（复制/删除/静音/Solo）。'}
          {onChangeRoute && ' 选中扬声器可指定输入路由（左源/右源/左右混合）。'}
        </InfoLine>
      )}
    </div>
  )
}
