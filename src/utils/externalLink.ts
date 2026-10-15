/**
 * 外部链接打开工具（PC / TV 统一入口）。
 *
 * 优先级：
 * 1. WaveForgeNative.openExternal（Android 原生 ACTION_VIEW，TV 真机可用——设备有浏览器时会拉起）；
 * 2. Electron 桥 shell.openExternal（桌面端）；
 * 3. window.open（纯浏览器）。
 *
 * TV WebView 的 window.open 无反应（主 WebView 无 onCreateWindow 处理），
 * 原生 ACTION_VIEW 在无浏览器设备上也会静默失败——TV 上额外弹 toast 说明，
 * 至少让用户知道"这个按钮点了没反应"是设计如此，而不是坏了。
 */
export function openExternalLink(url: string): void {
  // 协议白名单：与桌面端 open-external IPC（main.cjs 只放行 http/https）对齐。
  // url 可能来自 API 响应字段——被污染成 intent:// 等 scheme 时，Android ACTION_VIEW
  // 可以触发任意 Intent（含拉起任意组件），不能直接透传。
  let parsed: URL | null = null
  try {
    parsed = new URL(String(url || ''))
  } catch {
    parsed = null
  }
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    try {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '链接协议不受支持，已阻止打开', type: 'error' },
      }))
    } catch {
      // ignore
    }
    return
  }
  const safeUrl = parsed.href
  const native = (window as unknown as { WaveForgeNative?: { openExternal?: (u: string) => void } }).WaveForgeNative
  if (native?.openExternal) {
    try {
      native.openExternal(safeUrl)
      return
    } catch {
      // 原生层抛错（如无 Activity 可处理）→ 落到下方提示
    }
  }
  const electron = (window as unknown as { electron?: { shell?: { openExternal?: (u: string) => Promise<void> } } }).electron
  if (electron?.shell?.openExternal) {
    void electron.shell.openExternal(safeUrl).catch(() => undefined)
    return
  }
  if (typeof window !== 'undefined' && window.innerWidth > 0 && !native) {
    // 纯浏览器环境
    window.open(safeUrl, '_blank', 'noopener')
    return
  }
  // TV 且原生 ACTION_VIEW 不可用：给出可见反馈而不是静默无效
  try {
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: '此链接需在手机或电脑上打开：' + safeUrl.slice(0, 80), type: 'info' },
    }))
  } catch {
    // ignore
  }
}
