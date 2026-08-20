/**
 * 空间音频俯视可视化 —— 虚拟扬声器布局 + 展开角度（Canvas 2D）
 *
 * 顶部俯视视角：底部中央为听者头部（耳机点），前方弧线上左右两只虚拟扬声器
 * 光点按 ±spreadDeg/2 方位角排布；展开角度弧线用电光青→深邃紫渐变描边；
 * 扬声器外发光随空间化强度（amount）与呼吸动画脉动，强化距离感。
 * 模式关闭（active=false）时绘制灰调「已关闭」占位。
 * 空间化过渡动画（规划书 §5.2 模式 A）：transitionKey 变化时播放一次 2s 过渡——
 * L/R 波形从耳机（听者中心）「飘出」扩散到两侧扬声器，示意声音从颅内展开到
 * 颅内外（双耳虚拟声场）。过渡期间呼吸动画暂停（过渡优先），结束后相位重置恢复。
 * 参考范式：WaveformVisualizer（devicePixelRatio 缩放 + raf 循环）。
 */

import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { HSETheme } from '../hse-theme'

interface SpatialModeVisualProps {
  /** 展开角度（度）20..120 */
  spreadDeg: number
  /** 空间化强度 0..1（影响发光强度） */
  amount: number
  /** 模式 A（一键空间化）是否激活 */
  active: boolean
  theme: HSETheme
  /** 过渡动画触发信号：值变化时播放一次 2s「空间化过渡动画」；
   *  缺省（undefined）不播放，向后兼容 */
  transitionKey?: number
  /**
   * 拖拽扬声器点改展开角度的回调（缺省不启用拖拽，向后兼容）。
   * 提供后：俯视图左右两只虚拟扬声器光点可拖拽——pointerdown 命中光点
   * （12px 内）进入拖拽态，pointermove 按鼠标相对画布中心的角度对称映射
   * spreadDeg（= 2×|角度|，钳制 20..120，取整），实时回传；两点对称
   * （拖任一只均改 spreadDeg，左/右镜像）。拖拽态光标 grabbing、光点放大
   * + 高亮环；悬停光标 grab。
   */
  onSpreadChange?: (spreadDeg: number) => void
}

/** 过渡动画总时长（ms） */
export const TRANSITION_DURATION_MS = 2000

/**
 * 过渡动画进度：把 (now, start) 时刻差线性映射为 0..1 动画相位（2s 总时长）。
 * - now <= start → 0（未开始，钳制到 0）
 * - now - start >= TRANSITION_DURATION_MS → 1（已结束，钳制到 1）
 * - 中间线性：1s 时恰为 0.5
 * 纯函数（无副作用），raf 循环用它驱动过渡渲染，单测直接断言。
 */
export function transitionProgress(now: number, start: number): number {
  const t = (now - start) / TRANSITION_DURATION_MS
  return Math.max(0, Math.min(1, t))
}

/** 0..1 透明度 → 8 位 hex 颜色后缀 */
function alphaHex(a: number): string {
  return Math.round(Math.max(0, Math.min(1, a)) * 255)
    .toString(16)
    .padStart(2, '0')
}

/* ── 过渡动画时间轴分段（t 为 transitionProgress 相位 0..1，共 2s）──
 * 0-0.4s   (t∈[0,0.2))：听者点出现 + 光晕扩张（scale 0.5→1）
 * 0.4-1.4s (t∈[0.2,0.7))：L/R 波形从听者中心沿 ±spread/2 飘向扬声器
 * 1.4-2.0s (t∈[0.7,1])：波形在扬声器处淡出，扬声器光点发光增强 */
const TRANSITION = {
  /** 阶段 1 结束相位（出现 + 光晕扩张完成） */
  APPEAR_END: 0.2,
  /** 阶段 2 结束相位（波形到达扬声器） */
  FLY_END: 0.7,
} as const

/** 波形线采样点数（整段含两端） */
const WAVE_SAMPLES = 25
/** 波形段内正弦周期数：段内呈现 ~180Hz 音频波形的 4 个完整周期（视觉密度） */
const WAVE_CYCLES = 4
/** 波形振荡最大幅度（px，叠加幅度衰减包络后为峰值） */
const WAVE_AMPLITUDE_PX = 3.2

/**
 * 绘制一条「飘出」的波形线（过渡动画阶段 2/3）：
 * 波形前沿从 head 沿行进方向（head→speaker）线性插值飞到 flyT∈[0,1] 处；
 * 波形段垂直于行进方向、长度随行程增长（12→30px），段内正弦振荡
 * （~180Hz 音频波形快照，WAVE_CYCLES 个周期）+ 幅度衰减包络
 * （中心 1 → 两端 0），振荡沿行进方向位移（声波纵向传播的视觉化）。
 * 描边用 accentFrom→accentTo 线性渐变 + 目标扬声器同色外发光（与弧线同风格）。
 */
function drawTransitionWave(
  ctx: CanvasRenderingContext2D,
  head: { x: number; y: number },
  speaker: { x: number; y: number },
  flyT: number,
  from: string,
  to: string,
  waveAlpha: number,
  glowColor: string,
): void {
  const dx = speaker.x - head.x
  const dy = speaker.y - head.y
  const dist = Math.hypot(dx, dy) || 1
  const ux = dx / dist
  const uy = dy / dist
  const nx = -uy
  const ny = ux
  // 波形前沿位置（行程线性插值）+ 段长随行程增长（扩散感）
  const frontX = head.x + ux * flyT * dist
  const frontY = head.y + uy * flyT * dist
  const segLen = 12 + flyT * 18

  const grad = ctx.createLinearGradient(head.x, head.y, speaker.x, speaker.y)
  grad.addColorStop(0, `${from}${alphaHex(waveAlpha)}`)
  grad.addColorStop(1, `${to}${alphaHex(waveAlpha)}`)
  ctx.save()
  ctx.strokeStyle = grad
  ctx.lineWidth = 1.5
  ctx.lineCap = 'round'
  ctx.shadowColor = glowColor
  ctx.shadowBlur = 5 * waveAlpha
  ctx.beginPath()
  for (let i = 0; i <= WAVE_SAMPLES; i += 1) {
    const s = i / WAVE_SAMPLES - 0.5 // -0.5..0.5 段内归一坐标
    const osc = Math.sin(2 * Math.PI * WAVE_CYCLES * s)
    const env = Math.cos(Math.PI * s) // 幅度衰减包络：中心 1 → 两端 0
    const off = osc * env * WAVE_AMPLITUDE_PX
    const x = frontX + nx * s * segLen + ux * off
    const y = frontY + ny * s * segLen + uy * off
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.restore()
}

export function SpatialModeVisual({ spreadDeg, amount, active, theme, transitionKey, onSpreadChange }: SpatialModeVisualProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const phaseRef = useRef(0)
  /** 过渡动画起始时刻（raf 时间戳基）；null = 无过渡在播 */
  const transitionStartRef = useRef<number | null>(null)
  /** 上次收到的 transitionKey（首帧跳过判断用） */
  const prevTransitionKeyRef = useRef<number | undefined>(undefined)
  /**
   * 数据参数 ref：draw 内读取，避免 spreadDeg/amount/active 进入 raf effect 依赖。
   * 拖滑块时这三个值高频变化，若入依赖会反复 cleanup+重建 raf 循环；改读 ref 后
   * effect 仅依赖主题切换（极少发生），raf 持续读 ref.current 渲染最新值。
   */
  const spreadRef = useRef(spreadDeg)
  const amountRef = useRef(amount)
  const activeRef = useRef(active)
  spreadRef.current = spreadDeg
  amountRef.current = amount
  activeRef.current = active

  /* ── 拖拽扬声器点改展开角度（onSpreadChange 提供时启用）──
   *  draggingRef：当前拖拽中的扬声器（'left'/'right'/null），draw 内读取以放大
   *    拖拽点 + 高亮环（视觉反馈）；指针处理器写、raf 读。
   *  lastSpreadRef：上次回传的 spreadDeg（去重，避免同值高频 patch）。
   *  cursor：光标态（default/grab/grabbing），仅影响 canvas style，不触发 raf 重挂。 */
  const draggingRef = useRef<'left' | 'right' | null>(null)
  const lastSpreadRef = useRef(spreadDeg)
  const [cursor, setCursor] = useState<'default' | 'grab' | 'grabbing'>('default')

  /* 过渡触发：transitionKey 变化（含挂载）时重置起始时刻，播放 2s 过渡。
     首帧 transitionKey===0（SpatialPage 初始值，开关本就处于开启态）跳过——
     只有「模式切入 instant」产生的递增 key 才真正触发，页面加载/切页不重播。 */
  useEffect(() => {
    if (transitionKey === undefined) return // 缺省：不播放（向后兼容）
    if (prevTransitionKeyRef.current === undefined && transitionKey === 0) {
      prevTransitionKeyRef.current = transitionKey
      return
    }
    prevTransitionKeyRef.current = transitionKey
    transitionStartRef.current = performance.now()
  }, [transitionKey])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height)
      // 读 ref（数据参数变化不重建 raf，见上方 spreadRef/amountRef/activeRef 注释）
      const spreadDeg = spreadRef.current
      const amount = amountRef.current
      const active = activeRef.current

      /* 过渡相位：transitionStart 非空时按 (now - start) 差值推进
         （transitionProgress，2s 线性映射 0..1）；结束后清空标记并重置
         呼吸相位（重新从 0 起步）。 */
      let transT = 1
      const transitionStart = transitionStartRef.current
      if (transitionStart !== null) {
        transT = transitionProgress(now, transitionStart)
        if (transT >= 1) {
          transitionStartRef.current = null
          phaseRef.current = 0
          transT = 1
        }
      }
      const transitioning = transitionStart !== null && transT < 1

      // 过渡期间呼吸动画暂停（过渡优先），常态恢复推进
      if (!transitioning) phaseRef.current += 0.045
      const pulse = 0.5 + 0.5 * Math.sin(phaseRef.current)

      const cx = width / 2
      const cy = height - 24 // 听者头部中心（底部中央）
      const radius = Math.min(width, height) * 0.5 // 扬声器弧线半径
      const halfDeg = Math.min(60, Math.max(10, spreadDeg / 2))
      const half = (halfDeg * Math.PI) / 180

      // 方位角 → 屏幕坐标（画布上方为听者前方，θ>0 偏向右侧）
      const speakerAt = (theta: number) => ({
        x: cx + radius * Math.sin(theta),
        y: cy - radius * Math.cos(theta),
      })
      const left = speakerAt(-half)
      const right = speakerAt(half)

      if (!active) {
        /* ── 关闭状态：灰调占位 ── */
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.lineWidth = 1
        ctx.setLineDash([4, 4])
        ctx.beginPath()
        ctx.arc(cx, cy, radius, -Math.PI / 2 - half, -Math.PI / 2 + half)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(255,255,255,0.35)'
        ctx.beginPath()
        ctx.arc(cx, cy, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,255,255,0.22)'
        ctx.font = '11px "PingFang SC", "Microsoft YaHei", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('空间音频已关闭', cx, cy - radius - 14)
        raf = requestAnimationFrame(draw)
        return
      }

      const from = theme.accentFrom // 电光青
      const to = theme.accentTo // 深邃紫

      // 扬声器区域背景光晕（随强度与呼吸脉动）
      const glowCenter = { x: cx, y: cy - radius * 0.55 }
      const bgR = radius * 0.6 + pulse * 5
      const bg = ctx.createRadialGradient(glowCenter.x, glowCenter.y, 0, glowCenter.x, glowCenter.y, bgR)
      bg.addColorStop(0, `${from}${alphaHex(0.08 + 0.1 * amount)}`)
      bg.addColorStop(1, `${from}00`)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, width, height)

      // 前方朝向虚线（听者 → 声场）
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 5])
      ctx.beginPath()
      ctx.moveTo(cx, cy - 11)
      ctx.lineTo(cx, cy - radius * 0.94)
      ctx.stroke()
      ctx.setLineDash([])

      // 展开角度弧线（accentFrom → accentTo 渐变描边，透明度随强度）
      const arcAlpha = 0.22 + 0.5 * amount
      const arcGrad = ctx.createLinearGradient(left.x, left.y, right.x, right.y)
      arcGrad.addColorStop(0, `${from}${alphaHex(arcAlpha)}`)
      arcGrad.addColorStop(1, `${to}${alphaHex(arcAlpha)}`)
      ctx.strokeStyle = arcGrad
      ctx.lineWidth = 1.5 + amount * 0.5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.arc(cx, cy, radius, -Math.PI / 2 - half, -Math.PI / 2 + half)
      ctx.stroke()

      // 扬声器光点（外发光 shadowBlur 随 amount 与呼吸脉动，左青右紫；
      // 过渡阶段 3（t≥0.7）发光增强 glowBoost 0→1，呼吸脉动过渡期冻结）
      const glowBoost = transitioning && transT >= TRANSITION.FLY_END
        ? (transT - TRANSITION.FLY_END) / (1 - TRANSITION.FLY_END)
        : 0
      const glow = (3 + pulse * 5) * (0.35 + 0.65 * amount) * (1 + 0.9 * glowBoost)
      // 拖拽态光点放大 + 高亮环（draggingRef 由指针处理器写、raf 读）
      const dragSide = draggingRef.current
      const dot = (p: { x: number; y: number }, color: string, side: 'left' | 'right') => {
        const isDragging = dragSide === side
        const baseR = 3 + amount * 2 + pulse * 0.8 + glowBoost * 1.4
        ctx.save()
        ctx.shadowColor = color
        ctx.shadowBlur = isDragging ? glow * 1.8 : glow
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x, p.y, isDragging ? baseR + 2.5 : baseR, 0, Math.PI * 2)
        ctx.fill()
        if (isDragging) {
          // 拖拽高亮环（半透明同色外圈，强化「正在拖拽这只」反馈）
          ctx.globalAlpha = 0.6
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(p.x, p.y, baseR + 6, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
      }
      dot(left, from, 'left')
      dot(right, to, 'right')

      // L / R 标注
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      ctx.font = '10px ui-monospace, "JetBrains Mono", "Roboto Mono", monospace'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('L', left.x - 12, left.y + 1)
      ctx.fillText('R', right.x + 12, right.y + 1)

      // 展开角度读数
      ctx.fillStyle = 'rgba(255,255,255,0.6)'
      ctx.fillText(`${Math.round(spreadDeg)}°`, cx, cy - radius - 14)

      if (transitioning) {
        /* ── 空间化过渡动画（2s 时间轴，t = transitionProgress 相位 0..1）──
         * 0-0.4s   (t∈[0,0.2))：听者点出现（scale 0.5→1）+ 光晕扩张
         * 0.4-1.4s (t∈[0.2,0.7))：L/R 波形从听者中心沿 ±spread/2 飘向扬声器
         * 1.4-2.0s (t∈[0.7,1])：波形在扬声器处淡出，扬声器光点发光增强 */
        const appear = Math.min(1, transT / TRANSITION.APPEAR_END)
        // 光晕扩张：半径 9→27 向外扩散、透明度随扩张消散（扩散感）
        ctx.strokeStyle = `${from}${alphaHex(0.45 * (1 - appear))}`
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(cx, cy, 9 + appear * 18, 0, Math.PI * 2)
        ctx.stroke()
        // 听者静态光环（透明度随出现淡入，与常态同半径）
        ctx.strokeStyle = `${from}${alphaHex(0.4 * appear)}`
        ctx.beginPath()
        ctx.arc(cx, cy, 9, 0, Math.PI * 2)
        ctx.stroke()
        // 耳机点缩放出现（scale 0.5→1）
        ctx.fillStyle = from
        ctx.beginPath()
        ctx.arc(cx, cy, 4 * (0.5 + 0.5 * appear), 0, Math.PI * 2)
        ctx.fill()

        if (transT >= TRANSITION.APPEAR_END) {
          // 阶段 2/3：左右波形飘出（行程线性插值 flyT 0→1）
          const flyT = (transT - TRANSITION.APPEAR_END) / (TRANSITION.FLY_END - TRANSITION.APPEAR_END)
          const fadeIn = Math.min(1, flyT / 0.25) // 波形随移动淡入（前 25% 行程渐显）
          const fadeOut = transT >= TRANSITION.FLY_END
            ? 1 - (transT - TRANSITION.FLY_END) / (1 - TRANSITION.FLY_END)
            : 1
          const waveAlpha = 0.6 * fadeIn * fadeOut
          if (waveAlpha > 0.01) {
            drawTransitionWave(ctx, { x: cx, y: cy }, left, flyT, from, to, waveAlpha, from)
            drawTransitionWave(ctx, { x: cx, y: cy }, right, flyT, from, to, waveAlpha, to)
          }
        }
      } else {
        // 常态：听者头部（耳机点 + 光环）
        ctx.strokeStyle = `${from}66`
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(cx, cy, 9, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = from
        ctx.beginPath()
        ctx.arc(cx, cy, 4, 0, Math.PI * 2)
        ctx.fill()
      }

      raf = requestAnimationFrame(draw)
    }

    draw(performance.now())
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
    // 依赖仅主题：数据参数经 ref 读取（拖滑块时不重建 raf，见上方 ref 注释）
  }, [theme.accentFrom, theme.accentTo])

  /* ── 拖拽交互（onSpreadChange 提供时启用；缺省不接线，向后兼容）──
   *  几何/命中/角度换算与 draw 内同一约定：画布上方为听者前方，方位角从前方
   *  起算、右正（speakerAt: x = cx + r·sinθ、y = cy − r·cosθ）。拖拽任一光点
   *  对称映射 spreadDeg = 2×|θ|（钳制 20..120，取整），实时 onSpreadChange 回传。 */
  /** 画布几何 + 当前扬声器位置（CSS px，与 draw 同公式；用于指针命中检测） */
  const geometry = (): {
    cx: number; cy: number; radius: number
    left: { x: number; y: number }; right: { x: number; y: number }
  } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const w = Math.max(1, rect?.width ?? 1)
    const h = Math.max(1, rect?.height ?? 1)
    const cx = w / 2
    const cy = h - 24
    const radius = Math.min(w, h) * 0.5
    const halfDeg = Math.min(60, Math.max(10, spreadRef.current / 2))
    const half = (halfDeg * Math.PI) / 180
    const left = { x: cx + radius * Math.sin(-half), y: cy - radius * Math.cos(-half) }
    const right = { x: cx + radius * Math.sin(half), y: cy - radius * Math.cos(half) }
    return { cx, cy, radius, left, right }
  }

  /** 指针客户端坐标 → 画布局部坐标（CSS px） */
  const eventPos = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) }
  }

  /** 命中半径（CSS px）——扬声器光点小（~4-6px），12px 命中区便于点中 */
  const HIT_RADIUS = 12

  /** 命中检测：12px 内最近的扬声器光点（'left'/'right'/null） */
  const hitTest = (x: number, y: number): 'left' | 'right' | null => {
    const { left, right } = geometry()
    const dl = Math.hypot(left.x - x, left.y - y)
    const dr = Math.hypot(right.x - x, right.y - y)
    if (dl < HIT_RADIUS && dl <= dr) return 'left'
    if (dr < HIT_RADIUS) return 'right'
    return null
  }

  /** pointerdown：命中光点 → 进入拖拽态（指针捕获到 canvas，拖出画布仍持续收移动） */
  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!activeRef.current || !onSpreadChange) return
    const p = eventPos(e)
    const hit = hitTest(p.x, p.y)
    if (!hit) return
    draggingRef.current = hit
    lastSpreadRef.current = spreadRef.current
    setCursor('grabbing')
    e.preventDefault()
    try {
      canvasRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 捕获失败仍可拖动（鼠标悬停期间） */
    }
  }

  /** pointermove：拖拽中 → 角度对称映射 spreadDeg 回传（取整去重）；非拖拽 → 悬停命中改光标 */
  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!onSpreadChange) return
    if (draggingRef.current) {
      const { cx, cy } = geometry()
      const p = eventPos(e)
      // 角度从前方（上）起算、右正（atan2(Δx, −Δy)，与 speakerAt 同约定）
      const angleRad = Math.atan2(p.x - cx, cy - p.y)
      const spread = Math.min(120, Math.max(20, Math.round((2 * Math.abs(angleRad) * 180) / Math.PI)))
      if (spread !== lastSpreadRef.current) {
        lastSpreadRef.current = spread
        onSpreadChange(spread)
      }
    } else if (activeRef.current) {
      // 悬停命中 → grab 光标（非拖拽态）
      const p = eventPos(e)
      setCursor(hitTest(p.x, p.y) ? 'grab' : 'default')
    }
  }

  /** pointerup/cancel：结束拖拽，恢复光标 */
  const handlePointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (draggingRef.current) {
      draggingRef.current = null
      setCursor('default')
      try {
        canvasRef.current?.releasePointerCapture(e.pointerId)
      } catch {
        /* 已释放或未捕获 */
      }
    }
  }

  /** pointerleave：非拖拽态离开画布 → 恢复 default 光标（拖拽中不处理，捕获保活） */
  const handlePointerLeave = (): void => {
    if (!draggingRef.current) setCursor('default')
  }

  return (
    <div className="relative w-full" style={{ height: 150, maxWidth: 240, margin: '0 auto' }}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="空间音频布局示意"
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          cursor: onSpreadChange ? cursor : 'default',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
      />
    </div>
  )
}
