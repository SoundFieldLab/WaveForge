import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// 虚拟鼠标 overlay：由遥控器触摸板驱动，不占用用户真实鼠标。
// - move 移动光标（钳制在窗口内），6 秒无操作自动隐藏
// - click 合成左键点击（pointer/mouse/click 全序列）
// - hold-start 长按开始 → 外围圆环 2 秒闭合 → 闭合时触发右键
// - hold-cancel 取消长按；scroll 派发滚轮事件
export default function RemoteCursor() {
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const posRef = useRef({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
  const cursorRef = useRef<HTMLDivElement>(null)
  const ringRef = useRef<SVGCircleElement>(null)
  const [visible, setVisible] = useState(false)
  const [ringActive, setRingActive] = useState(false)
  const ringProgressRef = useRef(0)
  const ringStartRef = useRef(0)
  const rafRef = useRef(0)
  const hideTimerRef = useRef<number | null>(null)
  const holdGraceTimerRef = useRef<number | null>(null)
  const lastHoverRef = useRef<Element | null>(null)

  const RING_CIRCUMFERENCE = 2 * Math.PI * 17

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  const updatePos = () => {
    if (cursorRef.current) {
      cursorRef.current.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`
    }
  }

  const scheduleHide = () => {
    setVisible(true)
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    hideTimerRef.current = window.setTimeout(() => setVisible(false), 6000)
  }

  const move = (dx: number, dy: number) => {
    posRef.current.x = Math.max(0, Math.min(window.innerWidth, posRef.current.x + dx))
    posRef.current.y = Math.max(0, Math.min(window.innerHeight, posRef.current.y + dy))
    updatePos()
    // 派发 mouseover/mouseout/mousemove，让 hover 触发的 UI（小白条 / 右上角按钮等）能响应虚拟鼠标
    const { x, y } = posRef.current
    const el = document.elementFromPoint(x, y) || document.body
    const prev = lastHoverRef.current
    if (el !== prev) {
      if (prev) {
        try { prev.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, relatedTarget: el })) } catch { /* ignore */ }
      }
      try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, relatedTarget: prev })) } catch { /* ignore */ }
      lastHoverRef.current = el
    }
    dispatchEventAt('pointermove', x, y, 0)
    dispatchEventAt('mousemove', x, y, 0)
    scheduleHide()
  }

  const dispatchEventAt = (type: string, x: number, y: number, button = 0) => {
    const el = document.elementFromPoint(x, y)
    if (!el) return
    const common = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button }
    let ev: Event
    if (type.startsWith('pointer') && typeof PointerEvent !== 'undefined') {
      ev = new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'touch', isPrimary: true })
    } else {
      ev = new MouseEvent(type, common)
    }
    el.dispatchEvent(ev)
  }

  const click = () => {
    const { x, y } = posRef.current
    dispatchEventAt('pointerdown', x, y, 0)
    dispatchEventAt('mousedown', x, y, 0)
    dispatchEventAt('pointerup', x, y, 0)
    dispatchEventAt('mouseup', x, y, 0)
    dispatchEventAt('click', x, y, 0)
    // 合成事件不会触发浏览器默认聚焦行为：命中输入框时手动 focus()，
    // 否则 TvKeyboard 的 focusin 监听收不到、手机远程输入链整条失效
    try {
      const hit = document.elementFromPoint(x, y)
      const editable = hit instanceof HTMLElement ? hit.closest('input, textarea, [contenteditable="true"]') : null
      if (editable instanceof HTMLElement && editable.isConnected) editable.focus()
    } catch {
      // ignore
    }
    scheduleHide()
  }

  const rightClick = () => {
    const { x, y } = posRef.current
    // 完整右键序列：播放页径向菜单监听的是 mousedown(button=2)，只派发 contextmenu 不够
    dispatchEventAt('pointerdown', x, y, 2)
    dispatchEventAt('mousedown', x, y, 2)
    dispatchEventAt('pointerup', x, y, 2)
    dispatchEventAt('mouseup', x, y, 2)
    dispatchEventAt('contextmenu', x, y, 2)
    scheduleHide()
  }

  const scroll = (dy: number) => {
    const { x, y } = posRef.current
    const el = document.elementFromPoint(x, y)
    if (!el) return
    // 1. 派发 wheel 事件（触发 React onWheel 等自定义滚轮处理）
    try {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY: dy }))
    } catch { /* ignore */ }
    // 2. 合成 wheel 不会触发浏览器默认滚动，手动滚动最近的可滚动元素
    let node: Element | null = el
    while (node && node !== document.documentElement && node !== document.body) {
      const s = getComputedStyle(node)
      const overflowY = s.overflowY
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') && node.scrollHeight > node.clientHeight) {
        node.scrollTop += dy
        break
      }
      node = node.parentElement
    }
    scheduleHide()
  }

  const startHold = () => {
    cancelHold()
    setVisible(true)
    // 短暂宽限：快速点按时不闪现圆环，只有按住超过 200ms 才显示长按进度环
    holdGraceTimerRef.current = window.setTimeout(() => {
      setRingActive(true)
      ringProgressRef.current = 0
      ringStartRef.current = performance.now()
      const tick = (now: number) => {
        const p = Math.min(1, (now - ringStartRef.current) / 2000)
        ringProgressRef.current = p
        if (ringRef.current) {
          ringRef.current.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - p))
        }
        if (p < 1) {
          rafRef.current = requestAnimationFrame(tick)
        } else {
          // 圆环闭合 → 触发右键
          setRingActive(false)
          rightClick()
        }
      }
      rafRef.current = requestAnimationFrame(tick)
    }, 200)
  }

  const cancelHold = () => {
    if (holdGraceTimerRef.current !== null) {
      window.clearTimeout(holdGraceTimerRef.current)
      holdGraceTimerRef.current = null
    }
    cancelAnimationFrame(rafRef.current)
    setRingActive(false)
  }

  useEffect(() => {
    const bridge = window.electron?.remote
    // 命令来源：桌面走 Electron remote 桥；TV 端由 remoteBridge 转成 DOM 事件
    const handle = (command: { cmd?: string; dx?: number; dy?: number }) => {
      switch (command.cmd) {
        case 'move': move(command.dx || 0, command.dy || 0); break
        case 'click': click(); break
        case 'right-click': rightClick(); break
        case 'hold-start': startHold(); break
        case 'hold-cancel': cancelHold(); break
        case 'hold-complete': cancelHold(); rightClick(); break
        case 'scroll': scroll(command.dy || 0); break
      }
    }
    const off = bridge?.onCursor(handle)
    const onDom = (e: Event) => handle((e as CustomEvent<{ cmd?: string; dx?: number; dy?: number }>).detail || {})
    window.addEventListener('waveforge:remote-cursor', onDom)
    return () => {
      off?.()
      window.removeEventListener('waveforge:remote-cursor', onDom)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current)
    if (holdGraceTimerRef.current !== null) window.clearTimeout(holdGraceTimerRef.current)
    cancelAnimationFrame(rafRef.current)
  }, [])

  if (!visible && !ringActive) return null

  // 通过 portal 挂到 document.body，确保虚拟鼠标始终位于最顶层（包括 React portal 弹层之上）
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000 }}>
      <div
        ref={cursorRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: 0,
          height: 0,
          opacity: visible ? 1 : 0,
          transition: 'opacity .2s ease',
        }}
      >
        {/* 长按右键进度环（2 秒闭合） */}
        <svg
          width="40"
          height="40"
          viewBox="0 0 40 40"
          style={{ position: 'absolute', left: -20, top: -20, transform: 'rotate(-90deg)', opacity: ringActive ? 1 : 0, transition: 'opacity .12s ease' }}
        >
          <circle ref={ringRef} cx="20" cy="20" r="17" fill="none" stroke={accentColor} strokeWidth="3" strokeLinecap="round" strokeDasharray={RING_CIRCUMFERENCE} strokeDashoffset={RING_CIRCUMFERENCE} />
        </svg>
        {/* 光标圆点 */}
        <div
          style={{
            position: 'absolute',
            left: -7,
            top: -7,
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: accentColor,
            border: '2px solid rgba(255,255,255,0.9)',
            boxShadow: `0 0 0 2px ${accentColor}44, 0 2px 8px rgba(0,0,0,0.4)`,
          }}
        />
      </div>
    </div>,
    document.body,
  )
}
