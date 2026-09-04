/**
 * 平台检测：区分桌面（Electron/Windows）、Android TV、Android 平板、纯浏览器。
 * 桌面端专属能力（桌面小组件、壁纸、遥控、GPU 设置等）按平台隐藏。
 */
export type PlatformKind = 'desktop' | 'android-tv' | 'android-tablet' | 'web'

let cachedKind: PlatformKind | null = null

export function detectPlatform(): PlatformKind {
  if (cachedKind) return cachedKind
  if (typeof navigator === 'undefined') {
    cachedKind = 'desktop'
    return cachedKind
  }
  const ua = navigator.userAgent
  const hasElectron = typeof window !== 'undefined' && Boolean((window as any).electron?.system)
  if (/Android/i.test(ua)) {
    // Android TV / Google TV / Fire TV 的 UA 通常带 TV/Leanback/AFT/GoogleTV 标记。
    // 当前移植目标是 TV 优先；平板触摸适配后续再做，届时在这里区分。
    cachedKind = /TV|Leanback|GoogleTV|AFT|Tablet/i.test(ua) ? 'android-tv' : 'android-tv'
  } else if (hasElectron) {
    cachedKind = 'desktop'
  } else {
    cachedKind = 'web'
  }
  return cachedKind
}

export const getPlatform = detectPlatform
export const isDesktop = () => detectPlatform() === 'desktop'
export const isAndroid = () => detectPlatform() === 'android-tv' || detectPlatform() === 'android-tablet'
export const isTv = () => detectPlatform() === 'android-tv'

/**
 * TV UI 是否激活：检查 html.tv-mode 类。
 * 真机（Android）与浏览器强制（?tv=1 / localStorage 开关）都返回 true——
 * 用于"TV 专属 UI/设置"的门控，方便在浏览器里调试 TV 界面。
 */
export function isTvModeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('tv-mode')
}

/**
 * PC 测试开关：localStorage['waveforge:tv-mode']=1 或 URL 带 ?tv=1 时，
 * 在任意浏览器强制进入 TV 遥控器模式（焦点环/空间导航/软键盘全可用），
 * 方便在电脑上模拟电视遥控器（方向键=D-pad，Enter=OK，Backspace/Esc=BACK）。
 */
const TV_MODE_FLAG = 'waveforge:tv-mode'

export function isTvModeForced(): boolean {
  try {
    return localStorage.getItem(TV_MODE_FLAG) === '1'
  } catch {
    return false
  }
}

export function setTvModeForced(on: boolean): void {
  try {
    if (on) localStorage.setItem(TV_MODE_FLAG, '1')
    else localStorage.removeItem(TV_MODE_FLAG)
  } catch {
    // ignore
  }
}

/**
 * 在 <html> 上标记平台：CSS 通过 html.tv-mode / html[data-platform] 选择器做
 * 焦点交互适配（显示焦点环、把 hover 揭示的 UI 改为 focus 揭示等）。
 * 支持 ?tv=1 强制进入 TV 模式（PC 模拟测试）。
 */
export function initPlatformUI(): void {
  const kind = detectPlatform()
  const root = document.documentElement

  // URL ?tv=1 / ?tv=0 覆盖 localStorage 开关
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tv') === '1') setTvModeForced(true)
    else if (params.get('tv') === '0') setTvModeForced(false)
  } catch {
    // ignore
  }

  const forced = isTvModeForced()
  root.dataset.platform = kind
  // 安卓端当前只面向 TV 遥控器，统一启用 tv-mode 焦点交互；
  // 平板触摸适配到位后再收敛到 android-tv 才启用。PC 上用 ?tv=1 强制进入。
  if (forced || kind === 'android-tv' || kind === 'android-tablet') {
    root.classList.add('tv-mode')
  } else {
    root.classList.remove('tv-mode')
  }
}

// ── TV DPI 缩放 ──
// 用户可选的 UI 缩放档位（百分比）：60/80/100/125/150/175，默认 100（当前基线）。
// 通过 CSS zoom 作用于 <html>，localStorage 持久化，启动时应用。
export const TV_SCALE_OPTIONS = [60, 80, 100, 125, 150, 175] as const
export const TV_SCALE_KEY = 'waveforge:tv-scale'

export function getTvScale(): number {
  try {
    const v = Number(localStorage.getItem(TV_SCALE_KEY) || '100')
    return (TV_SCALE_OPTIONS as readonly number[]).includes(v) ? v : 100
  } catch {
    return 100
  }
}

export function setTvScale(scale: number): void {
  try {
    localStorage.setItem(TV_SCALE_KEY, String(scale))
  } catch {
    // ignore
  }
  applyTvScale(scale)
}

// ── TV DPI 缩放（viewport 真适配）──
// UI 布局基准宽 2133（build-android-assets.mjs 静态写入 index.html）。
// 缩放通过动态改写 viewport width 实现：width = 2133 * 100 / scale，
// 整个界面按新布局宽重排，而不是简单放大像素（避免缩小后四周黑边）。
export const TV_BASELINE_VIEWPORT = 2133

export function applyTvScale(scale?: number): void {
  const v = scale ?? getTvScale()
  if (typeof document === 'undefined') return
  const viewport = Math.round(TV_BASELINE_VIEWPORT * 100 / v)
  const meta = document.querySelector('meta[name="viewport"]')
  if (meta) meta.setAttribute('content', `width=${viewport}`)
  document.documentElement.style.setProperty('--tv-scale', String(v / 100))
}
