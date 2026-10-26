/**
 * 移动端 BACK 键栈：仿 tvCore 的 useTvBack 语义，但独立于 TV 焦点层。
 *
 * 原生侧（MainActivity.dispatchKeyEvent）把 Android BACK（keyCode 4）转发为 DOM
 * keydown；本模块监听后按「后进先出」派发给已注册的处理函数，消费了则上报
 * WaveForgeNative.reportBackConsumed() 阻止原生默认返回（退出应用）。
 * 未消费时原生 800ms 后执行默认（finish）。
 *
 * PC 模拟：Escape 等价 BACK（输入框聚焦时不拦截，避免打断编辑）。
 */
import { useEffect, useRef } from 'react'

type BackHandler = () => boolean

const handlers: BackHandler[] = []
let installed = false

const EDITABLE_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isEditable(target: EventTarget | null): boolean {
  const el = target as Element | null
  if (!el) return false
  if ((el as HTMLElement).isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') return EDITABLE_TYPES.has((el as HTMLInputElement).type || 'text')
  return false
}

function dispatchMobileBack(): boolean {
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    try {
      if (handlers[i]()) return true
    } catch {
      // 单个处理器异常不影响后续
    }
  }
  return false
}

/** 程序化触发一次返回（等价按 BACK）：MV 关闭等「返回上一页」语义复用同一条栈。 */
export function triggerMobileBack(): boolean {
  const consumed = dispatchMobileBack()
  if (consumed) {
    try {
      ;(window as any).WaveForgeNative?.reportBackConsumed?.()
    } catch { /* ignore */ }
  }
  return consumed
}

function onKeydown(e: KeyboardEvent) {
  // Android KEYCODE_BACK（原生 forwardKeyToDom 转发 keyCode 4）；PC 模拟用 Escape
  const isAndroidBack = e.keyCode === 4
  const isSimBack = e.key === 'Escape'
  if (!isAndroidBack && !isSimBack) return
  // 模拟键在输入框内不拦截（Android 真机 BACK 由系统软键盘自行处理退格/收起逻辑，
  // 到达 DOM 的 BACK 一律视为导航返回）
  if (isSimBack && isEditable(e.target)) return
  if (dispatchMobileBack()) {
    e.preventDefault()
    e.stopPropagation()
    try {
      ;(window as any).WaveForgeNative?.reportBackConsumed?.()
    } catch {
      // ignore
    }
  }
}

function install() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('keydown', onKeydown, true)
}

/** 注册一个返回处理函数（返回 true 表示已消费）。卸载时自动移除。 */
export function useMobileBack(handler: BackHandler, deps: ReadonlyArray<unknown> = []): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    install()
    const fn: BackHandler = () => ref.current()
    handlers.push(fn)
    return () => {
      const i = handlers.indexOf(fn)
      if (i >= 0) handlers.splice(i, 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
