/**
 * TV 软键盘：Android TV 一般没有系统输入法，文本输入（搜索、QQ cookie 粘贴等）
 * 需要遥控器可操作的屏幕键盘。
 *
 * 机制：
 *  - tv-mode 下任意 input/textarea/contenteditable 获得焦点时自动弹出；
 *  - 键盘是一个 data-tv-scope 聚焦域，D-pad 由 tvCore 的空间导航在网格内移动；
 *  - 按 OK 输出字符到目标输入框（通过原生 value setter + input 事件，React 能感知）；
 *  - BACK / 完成键关闭键盘并把焦点交还页面。
 */
import { useEffect, useRef, useState } from 'react'
import {
  useTvMode,
  useRemoteCursorMode,
  setKeyboardActive,
  useTvBack,
  startTv,
  setTvFocus,
} from './tvCore'
import { requestRemoteTextInput } from './remoteBridge'

// 标准 QWERTY 布局（按真实键盘行排列），数字/符号页同理
const KEY_ROWS: Record<Page, string[]> = {
  lower: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  upper: ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'],
  symbols: ['1234567890', '-=[]\\;\',./', '!@#$%^&*()_+', '{}|:"<>?`~'],
}
const SPACE = ' '

// 只有文本类输入才弹键盘：checkbox/range/radio/按钮等开关类不算（否则焦点到开关会误弹键盘）
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text'
    return TEXT_INPUT_TYPES.has(type)
  }
  return false
}

type Page = 'lower' | 'upper' | 'symbols'

export default function TvKeyboard() {
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const [target, setTarget] = useState<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [page, setPage] = useState<Page>('lower')
  const [closing, setClosing] = useState(false)
  const targetRef = useRef<typeof target>(null)
  const keyboardRef = useRef<HTMLDivElement>(null)
  const switchBtnRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)
  const remoteCursorModeRef = useRef(remoteCursorMode)
  remoteCursorModeRef.current = remoteCursorMode
  targetRef.current = target

  useEffect(() => {
    if (!tvMode) return
    // React 首帧渲染完成后，让 tvCore 重新收拢焦点到可见候选。
    startTv()
    const onFocusIn = () => {
      const ae = document.activeElement
      if (isEditable(ae)) {
        // 不可见的输入框（隐藏搜索框/弹层关闭后的残留焦点）不弹键盘也不请求远程输入
        const el = ae as HTMLElement
        if (el.offsetParent === null && el.getClientRects().length === 0) return
        if (remoteCursorModeRef.current) {
          // 远程遥控器连接中：不弹 TV 软键盘，改用手机端输入框（用户自己的键盘）
          setKeyboardActive(false)
          requestRemoteTextInput()
          return
        }
        setTarget(ae as HTMLInputElement | HTMLTextAreaElement)
        setPage('lower')
        setKeyboardActive(true)
      } else if (ae && !keyboardRef.current?.contains(ae)) {
        // 焦点离开可编辑区域（键盘内部元素除外）→ 关闭
        setTarget(null)
        setKeyboardActive(false)
      }
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      setKeyboardActive(false)
    }
  }, [tvMode])

  // BACK：优先关闭软键盘（target 变化时重新注册，把键盘的 BACK 处理顶到栈尾）
  useTvBack(
    () => {
      if (targetRef.current) {
        close()
        return true
      }
      return false
    },
    [target]
  )

  const close = () => {
    if (closingRef.current) return
    closingRef.current = true
    setClosing(true)
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current)
    // 先播退出动画（260ms 淡出上移），动画结束后再卸载键盘
    closeTimerRef.current = window.setTimeout(() => {
      closingRef.current = false
      setClosing(false)
      setTarget(null)
      setKeyboardActive(false)
      try {
        targetRef.current?.blur()
      } catch {
        // ignore
      }
    }, 260)
  }

  // 输入框失焦且新焦点不在键盘内 → 自动关闭（输入完成/取消输入/输入框被移除都覆盖）
  useEffect(() => {
    if (!tvMode || !target) return
    const onFocusOut = (e: FocusEvent) => {
      if (closingRef.current) return
      const next = e.relatedTarget as Node | null
      if (next && keyboardRef.current?.contains(next)) return
      close()
    }
    document.addEventListener('focusout', onFocusOut)
    return () => document.removeEventListener('focusout', onFocusOut)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tvMode, target])

  // 切换 ABC/abc/123 页：字符键会卸载重建，把焦点显式放回切换按钮，
  // 避免焦点落在已卸载节点上（焦点环变淡/按 OK 无效）。
  const switchPage = () => {
    setPage(page === 'lower' ? 'upper' : page === 'upper' ? 'symbols' : 'lower')
    requestAnimationFrame(() => {
      if (switchBtnRef.current) setTvFocus(switchBtnRef.current)
    })
  }

  // ★ hooks 必须全部在提前 return 之前（React 规则：hooks 不能条件化，否则 #310 白屏）
  const deleteCharRef = useRef<() => void>(() => {})
  const closeRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!tvMode || !target) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.keyCode === 8 || e.keyCode === 67) {
        e.preventDefault()
        e.stopPropagation()
        deleteCharRef.current()
      } else if (e.keyCode === 27) {
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tvMode, target])

  if (!tvMode || !target) return null

  const insert = (text: string) => {
    const t = target
    if (!t) return
    const proto =
      t instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return
    const start = t.selectionStart ?? t.value.length
    const end = t.selectionEnd ?? t.value.length
    const next = t.value.slice(0, start) + text + t.value.slice(end)
    setter.call(t, next)
    t.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      t.setSelectionRange(start + text.length, start + text.length)
    } catch {
      // ignore
    }
  }

  const deleteChar = () => {
    const t = target
    if (!t) return
    const proto =
      t instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (!setter) return
    const start = t.selectionStart ?? t.value.length
    const end = t.selectionEnd ?? t.value.length
    if (start === end && start > 0) {
      const next = t.value.slice(0, start - 1) + t.value.slice(end)
      setter.call(t, next)
      t.dispatchEvent(new Event('input', { bubbles: true }))
      try {
        t.setSelectionRange(start - 1, start - 1)
      } catch {
        // ignore
      }
    } else if (start !== end) {
      const next = t.value.slice(0, start) + t.value.slice(end)
      setter.call(t, next)
      t.dispatchEvent(new Event('input', { bubbles: true }))
      try {
        t.setSelectionRange(start, start)
      } catch {
        // ignore
      }
    }
  }

  // 让键盘渲染阶段能取到最新 deleteChar/close（函数定义在 return 之后，hooks 已在上方声明）
  deleteCharRef.current = deleteChar
  closeRef.current = close

  const Key = ({ label, onClick, wide = false }: { label: string; onClick: () => void; wide?: boolean }) => (
    <button
      data-tv-focus
      tabIndex={-1}
      onClick={onClick}
      className={`tv-key ${wide ? 'tv-key-wide' : ''}`}
      style={{
        minWidth: wide ? 110 : 62,
        height: 58,
        margin: 4,
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.22)',
        background: 'rgba(255,255,255,0.12)',
        color: '#fff',
        fontSize: 20,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {label}
    </button>
  )

  return (
    <div
      ref={keyboardRef}
      data-tv-scope
      className="tv-keyboard"
      style={{
        position: 'fixed',
        left: '50%',
        transform: `translateX(-50%)${closing ? ' translateY(14px)' : ''}`,
        bottom: 24,
        zIndex: 2147483001,
        maxWidth: 'min(96vw, 1200px)',
        background: 'rgba(12,16,24,0.94)',
        border: '1px solid rgba(255,255,255,0.16)',
        borderRadius: 18,
        padding: '12px 16px 14px',
        boxShadow: '0 18px 60px rgba(0,0,0,0.6)',
        textAlign: 'center',
        opacity: closing ? 0 : 1,
        transition: 'opacity .24s ease, transform .24s ease',
        pointerEvents: closing ? 'none' : 'auto',
      }}
    >
      {/* 键盘头部：说明 + 关闭按钮 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>遥控器键盘</span>
        <button
          data-tv-focus
          tabIndex={-1}
          onClick={close}
          style={{
            background: 'rgba(255,255,255,0.12)',
            color: '#fff',
            border: '1px solid rgba(255,255,255,0.25)',
            borderRadius: 8,
            padding: '6px 14px',
            fontSize: 13,
          }}
        >
          ✕ 关闭
        </button>
      </div>

      {/* 当前输入预览 */}
      <div
        style={{
          color: 'rgba(255,255,255,0.85)',
          fontSize: 15,
          minHeight: 26,
          marginBottom: 8,
          padding: '4px 12px',
          background: 'rgba(0,0,0,0.4)',
          borderRadius: 8,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'left',
        }}
      >
        {target.value || '\u00A0'}
      </div>

      {/* 字符网格（QWERTY 行排列） */}
      <div style={{ maxWidth: 1060, margin: '0 auto' }}>
        {KEY_ROWS[page].map((row, ri) => (
          <div key={ri} style={{ display: 'flex', justifyContent: 'center' }}>
            {row.split('').map((c) => (
              <Key key={`${page}-${c}`} label={c} onClick={() => insert(c)} />
            ))}
          </div>
        ))}

        {/* 控制行 */}
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 6 }}>
          <button
            ref={switchBtnRef}
            data-tv-focus
            tabIndex={-1}
            onClick={switchPage}
            className="tv-key"
            style={{
              minWidth: 62,
              height: 58,
              margin: 4,
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'rgba(255,255,255,0.12)',
              color: '#fff',
              fontSize: 20,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {page === 'lower' ? 'ABC' : page === 'upper' ? '123' : 'abc'}
          </button>
          <Key label="空格" wide onClick={() => insert(SPACE)} />
          <Key label="⌫ 删除" wide onClick={deleteChar} />
          <Key label="完成" wide onClick={close} />
        </div>
      </div>
    </div>
  )
}
