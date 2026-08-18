/**
 * TV 遥控器媒体键桥接（仅 tv-mode）。
 *
 * Android TV 遥控器的媒体键由原生壳转发为 DOM keydown（keyCode 85-90 等），
 * 但页面里 navigator.mediaSession 的处理器只响应系统媒体会话事件、不响应 DOM 键。
 * 这里把主流遥控器按键统一桥接为应用的控制 action（waveforge:remote-control），
 * 由 App 的 desktopControlHandlerRef 在任意页面统一处理（不再限定播放页）。
 *
 * 映射（Android TV 键位）：
 *  - 播放/暂停  85/126/127/179 → toggle
 *  - 停止        86            → stop（暂停并回到开头）
 *  - 下一首      87/176        → next
 *  - 上一首      88/177        → prev
 *  - 快退        89            → rewind（后退 10 秒）
 *  - 快进        90            → fast-forward（前进 10 秒）
 *  - 菜单        82            → menu（打开当前歌曲详情/操作）
 *  - 搜索        84            → open-search
 */
import { isTvMode } from './tvCore'

const KEY_ACTION_MAP: Record<number, string> = {
  85: 'toggle',
  126: 'toggle',
  127: 'toggle',
  179: 'toggle',
  86: 'stop',
  87: 'next',
  176: 'next',
  88: 'prev',
  177: 'prev',
  89: 'rewind',
  90: 'fast-forward',
  82: 'menu',
  84: 'open-search',
}

let installed = false

export function installMediaKeyBridge(): void {
  if (installed) return
  installed = true
  document.addEventListener('keydown', (e) => {
    if (!isTvMode()) return
    const action = KEY_ACTION_MAP[e.keyCode]
    if (!action) return

    // 输入框聚焦时不拦截（避免把媒体键当文本输入）
    const ae = document.activeElement
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return

    e.preventDefault()
    e.stopPropagation()
    window.dispatchEvent(
      new CustomEvent('waveforge:remote-control', { detail: { action, payload: undefined } })
    )
  })
}
