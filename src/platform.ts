/**
 * 平台检测：区分桌面（Electron/Windows）、Android TV、Android 手机、Android 平板、纯浏览器。
 * 桌面端专属能力（桌面小组件、壁纸、遥控、GPU 设置等）按平台隐藏；
 * 手机/平板为触摸 UI（MobileApp），TV 为遥控器 UI（tv-mode），互不混用。
 */
export type PlatformKind = 'desktop' | 'android-tv' | 'android-phone' | 'android-tablet' | 'web'

/** 触屏移动端形态：手机 / 平板（Fold 展开按平板、折叠按手机，运行时切换）。 */
export type FormFactor = 'phone' | 'tablet'

/** 平板判定阈值（CSS dp，与 Android sw600dp 平板线一致）。 */
export const TABLET_MIN_WIDTH_DP = 600

type DeviceClass = 'desktop' | 'web' | 'android-tv' | 'android-touch'

/** 设备类别（UA + 原生 uiMode 决定，进程内不变；不含 phone/tablet 细分）。 */
let cachedClass: DeviceClass | null = null

function detectDeviceClass(): DeviceClass {
  if (cachedClass) return cachedClass
  if (typeof navigator === 'undefined') {
    cachedClass = 'desktop'
    return cachedClass
  }
  const ua = navigator.userAgent
  const hasElectron = typeof window !== 'undefined' && Boolean((window as any).electron?.system)
  if (/Android/i.test(ua)) {
    // Android TV / Google TV / Fire TV 的 UA 通常带 TV/Leanback/AFT/GoogleTV 标记。
    // 部分电视盒子 UA 无标记：原生侧 getUiMode()（UiModeManager TELEVISION）兜底。
    if (/TV|Leanback|GoogleTV|AFT|BRAVIA|CrKey|SHIELD|NetCast/i.test(ua) || nativeUiMode() === 'television') {
      cachedClass = 'android-tv'
    } else {
      cachedClass = 'android-touch'
    }
  } else if (hasElectron) {
    cachedClass = 'desktop'
  } else {
    cachedClass = 'web'
  }
  return cachedClass
}

/** 原生 WaveForgeNative.getUiMode()：'television'（TV 设备）/ 'normal' / null（非安卓）。 */
function nativeUiMode(): string | null {
  try {
    const fn = (window as any).WaveForgeNative?.getUiMode
    return typeof fn === 'function' ? String(fn() || '') || null : null
  } catch {
    return null
  }
}

/**
 * 当前表单形态（仅触摸安卓有意义）：按 Android 官方 sw600dp 语义——取**屏幕最小边**
 * （CSS dp）≥600 为平板。用屏幕而非窗口的原因：
 *  - 普通手机横屏（窗口宽 ≥600）不会误入平板布局；
 *  - 平板分屏（窗口被压窄）不会误降为手机布局；
 *  - Fold 折叠/展开 = 物理屏切换（外屏 ~360dp / 内屏 ≥600dp），screen 随之变化并触发
 *    resize 事件 → 这里重算即可实时换形态。
 * 窗口宽仅作 screen 缺失时的回退（非常规宿主）。
 */
export function currentFormFactor(): FormFactor {
  if (typeof window === 'undefined') return 'phone'
  const screenW = window.screen?.width || 0
  const screenH = window.screen?.height || 0
  const smallest = screenW && screenH
    ? Math.min(screenW, screenH)
    : Math.min(window.innerWidth, window.innerHeight)
  return smallest >= TABLET_MIN_WIDTH_DP ? 'tablet' : 'phone'
}

/**
 * 应用态表单形态：读 initPlatformUI 写入的 html[data-form]（含 ?ui=phone|tablet
 * 模拟覆盖），缺失时回退裸视口判定。MobileApp 的壳层切换必须用它——直接读
 * currentFormFactor() 会无视调试覆盖，模拟 Fold 时壳不切换。
 */
export function getAppliedFormFactor(): FormFactor {
  if (typeof document !== 'undefined') {
    const v = document.documentElement.dataset.form
    if (v === 'phone' || v === 'tablet') return v
  }
  return currentFormFactor()
}

export function detectPlatform(): PlatformKind {
  const deviceClass = detectDeviceClass()
  if (deviceClass === 'android-tv') return 'android-tv'
  if (deviceClass === 'android-touch') {
    return currentFormFactor() === 'tablet' ? 'android-tablet' : 'android-phone'
  }
  return deviceClass
}

export const getPlatform = detectPlatform
export const isDesktop = () => detectPlatform() === 'desktop'
export const isAndroid = () => {
  const c = detectDeviceClass()
  return c === 'android-tv' || c === 'android-touch'
}
export const isTv = () => detectDeviceClass() === 'android-tv'
/** 触摸移动端（手机或平板）：渲染 MobileApp 触摸 UI。 */
export const isTouchMobile = () => detectDeviceClass() === 'android-touch'

/**
 * TV UI 是否激活：检查 html.tv-mode 类。
 * 真机（Android TV）与浏览器强制（?tv=1 / localStorage 开关）都返回 true——
 * 用于"TV 专属 UI/设置"的门控，方便在浏览器里调试 TV 界面。
 */
export function isTvModeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('tv-mode')
}

/**
 * 触摸移动 UI 是否激活：检查 html.mobile-mode 类。
 * 手机/平板真机与 PC 模拟（?ui=phone / ?ui=tablet）都返回 true。
 */
export function isMobileModeActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('mobile-mode')
}

/**
 * Android 手机/平板（含平板/手机「PC 版布局」，即 pc-touch 树）。
 * 用于移动端硬性能力降级：双 deck 预载/交叉淡化在移动 WebAudio 上不稳定
 * （实测待机 deck 满增益出声 → 与主曲混音，听感即「爆音/杂音/不受控快进」，
 * 且 UI 进度条正常），所以 Android 触摸端一律走单 deck 直切。
 */
export function isAndroidTouchDevice(): boolean {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.classList.contains('mobile-mode') || root.classList.contains('pc-touch')) return true
  const kind = root.dataset.platform || ''
  return kind === 'android-phone' || kind === 'android-tablet'
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

// ── 移动端 UI 调试开关 ──
// ?ui=phone / ?ui=tablet 在 PC 浏览器模拟手机/平板触摸 UI；?ui=auto 恢复自动。
// localStorage 持久化（waveforge:ui-override），刷新后保持。
export type UiOverride = 'phone' | 'tablet' | 'tv' | 'auto' | null
const UI_OVERRIDE_FLAG = 'waveforge:ui-override'

export function getUiOverride(): UiOverride {
  try {
    const v = localStorage.getItem(UI_OVERRIDE_FLAG)
    return v === 'phone' || v === 'tablet' || v === 'tv' || v === 'auto' ? v : null
  } catch {
    return null
  }
}

export function setUiOverride(value: UiOverride): void {
  try {
    if (value && value !== 'auto') localStorage.setItem(UI_OVERRIDE_FLAG, value)
    else localStorage.removeItem(UI_OVERRIDE_FLAG)
  } catch {
    // ignore
  }
  applyPlatformUi()
}

/** 上次应用的平台 UI 签名：变化时派发 waveforge-platform-changed（Fold 开合/旋转/override 切换）。 */
let lastAppliedSignature = ''

// ── 平板「PC 布局」偏好 ──
// 平板用户可选把整棵 UI 换成桌面 App 移植（viewport 拉宽到 PC 基准等比缩放，
// 做法 TV 端同源）；默认保持移动布局。手机与平板形态均可开启（用户要求手机也有桌面模式）。
export type TabletLayoutStyle = 'mobile' | 'pc'
const TABLET_LAYOUT_KEY = 'waveforge:mobile-tablet-layout'
/** PC 布局的排版基准宽（CSS px）：桌面 App 按此宽度完整排版，等比缩放进屏幕。 */
export const PC_TABLET_VIEWPORT = 1280
/** 手机形态默认基准：屏物理更小，1280 等比缩完后字太小、点不到，860 兼顾完整度与可读性。 */
export const PC_PHONE_VIEWPORT = 860
/** PC 布局缩放档位（越大 = 排版越宽 = 屏幕上字越小）。与 TV 的 scale 设置同思路。 */
export const PC_TOUCH_WIDTH_OPTIONS: Array<{ value: number; label: string; hint: string }> = [
  { value: 760, label: '特大', hint: '字最大，一屏内容最少' },
  { value: 860, label: '大', hint: '手机推荐' },
  { value: 1024, label: '标准', hint: '接近桌面比例' },
  { value: 1152, label: '小', hint: '平板横屏可用' },
  { value: 1280, label: '极小', hint: '完整桌面比例，平板推荐' },
  { value: 1440, label: '超小', hint: '大平板/追求信息密度' },
]
const PC_TOUCH_WIDTH_KEY = 'waveforge:pc-touch-width'

/** 当前 PC 触屏布局基准宽（用户可调；未设置按形态给默认值）。 */
export function getPcTouchWidth(form: FormFactor | null = null): number {
  try {
    const raw = Number(localStorage.getItem(PC_TOUCH_WIDTH_KEY))
    if (Number.isFinite(raw) && raw >= 560 && raw <= 2000) return raw
  } catch { /* ignore */ }
  return form === 'phone' ? PC_PHONE_VIEWPORT : PC_TABLET_VIEWPORT
}

export function setPcTouchWidth(width: number): void {
  try { localStorage.setItem(PC_TOUCH_WIDTH_KEY, String(width)) } catch { /* ignore */ }
  applyPlatformUi()
}

export function getTabletLayoutStyle(): TabletLayoutStyle {
  try {
    return localStorage.getItem(TABLET_LAYOUT_KEY) === 'pc' ? 'pc' : 'mobile'
  } catch {
    return 'mobile'
  }
}

export function setTabletLayoutStyle(style: TabletLayoutStyle): void {
  try {
    if (style === 'pc') localStorage.setItem(TABLET_LAYOUT_KEY, 'pc')
    else localStorage.removeItem(TABLET_LAYOUT_KEY)
  } catch {
    // ignore
  }
  applyPlatformUi()
}

/** 当前是否处于「平板 PC 布局」模式（html.pc-touch，桌面 App 树 + 触屏适配）。 */
export function isPcTabletActive(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('pc-touch')
}

/** 应用平台 UI 标记与 viewport（幂等，可在 resize/Fold 开合后重跑）。 */
function applyPlatformUi(): void {
  const kind = detectPlatform()
  const root = document.documentElement
  const override = getUiOverride()
  const tvActive = kind === 'android-tv' || override === 'tv'
  // PC 模拟：?ui=phone / ?ui=tablet 在桌面浏览器也强制移动 UI（含形态），方便调试。
  const mobileActive =
    kind === 'android-phone' || kind === 'android-tablet' || override === 'phone' || override === 'tablet'
  const form: FormFactor | null =
    override === 'phone' ? 'phone' : override === 'tablet' ? 'tablet' : mobileActive ? currentFormFactor() : null
  // 用户选了 PC 布局：渲染桌面 App（见 PlatformRoot），打 pc-touch 类做触屏适配。
  // 平板两种朝向都可用；手机形态**仅横屏生效**——竖屏可用宽度只有横屏一半，
  // 等比缩放后字太小点不到，竖屏自动保持移动版（旋转时本函数重跑，自动换树）。
  const portrait = typeof window !== 'undefined' && window.innerHeight > window.innerWidth
  const pcTouchPref = mobileActive && getTabletLayoutStyle() === 'pc'
  const pcTouchActive = pcTouchPref && (form === 'tablet' || !portrait)
  const pcTabletActive = pcTouchActive
  const effectiveMobile = mobileActive && !pcTouchActive

  root.dataset.platform = kind
  root.classList.toggle('tv-mode', tvActive)
  root.classList.toggle('mobile-mode', effectiveMobile)
  root.classList.toggle('pc-touch', pcTabletActive)
  if (form) root.dataset.form = form
  else delete root.dataset.form

  // 移动端一律沉浸全屏（用户要求：顶部时间/状态栏也隐藏，滑动手势临时唤出）：
  // 手机移动布局 / 平板移动布局 / 平板 PC 布局三种形态均隐藏系统栏；
  // TV/桌面不受影响（TV 本就全屏，桌面无此桥）。
  try {
    ;(window as any).WaveForgeNative?.setImmersiveMode?.(pcTabletActive || effectiveMobile)
  } catch {
    // 原生桥不可用（浏览器模拟）时忽略
  }

  // viewport：TV 用宽布局基准（applyTvScale 写 width=2133*100/缩放）；
  // PC 布局拉宽到 PC 基准（平板 1280 / 手机 1024，等比缩放完整桌面排版）；
  // 移动布局用原生 dp（device-width），保证 600dp 平板判定成立。
  const meta = document.querySelector('meta[name="viewport"]')
  if (meta) {
    if (tvActive) {
      applyTvScale()
    } else if (pcTabletActive) {
      // 用户可调基准宽（手机默认 860 / 平板默认 1280）；平板竖屏再收窄 12%
      // ——竖屏可用宽度约为横屏一半，固定宽会比横屏更小更难读。
      // 手机竖屏不会走到这里（PC 布局仅横屏生效，见上）。
      const base = getPcTouchWidth(form)
      meta.setAttribute('content', `width=${portrait ? Math.round(base * 0.88) : base}`)
      document.documentElement.style.removeProperty('--tv-scale')
    } else {
      meta.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
      document.documentElement.style.removeProperty('--tv-scale')
    }
  }

  // 状态签名变化时广播：PlatformRoot（移动 UI ↔ 桌面/TV/平板PC）与 MobileApp（phone ↔ tablet）监听。
  const signature = `${kind}|${tvActive ? 'tv' : pcTabletActive ? 'pc-tablet' : effectiveMobile ? `mobile:${form}` : 'std'}`
  if (signature !== lastAppliedSignature) {
    const changed = lastAppliedSignature !== ''
    lastAppliedSignature = signature
    if (changed) {
      window.dispatchEvent(new CustomEvent('waveforge-platform-changed', { detail: { platform: kind } }))
    }
  }
}

/**
 * 在 <html> 上标记平台：CSS 通过 html.tv-mode / html.mobile-mode / html[data-platform]
 * 选择器做交互适配。支持 ?tv=1（强制 TV）与 ?ui=phone|tablet|auto（移动 UI 模拟）。
 */
export function initPlatformUI(): void {
  // URL 覆盖开关（一次性读取后落入/移出 localStorage）
  try {
    const params = new URLSearchParams(window.location.search)
    if (params.get('tv') === '1') setTvModeForced(true)
    else if (params.get('tv') === '0') setTvModeForced(false)
    const uiParam = params.get('ui')
    if (uiParam === 'phone' || uiParam === 'tablet') setUiOverride(uiParam)
    else if (uiParam === 'auto') setUiOverride(null)
  } catch {
    // ignore
  }
  applyPlatformUi()

  // Fold 开合 / 旋转 / 分屏：视口宽度跨过 600dp 线时重算形态并广播。
  // MainActivity manifest 已声明 configChanges（screenLayout|smallestScreenSize），
  // Activity 不重建、WebView 只 resize，这里就是运行时切换的唯一入口。
  // ⚠️ 实测部分 ROM（vivo Fold 等）折叠切换后 resize 事件会丢/迟到——screen 已变而
  // 事件未触发，形态卡死（tablet 偏好在 360dp 外屏上渲染桌面 UI）。三重兜底：
  //  1) resize/orientationchange/visibilitychange 都触发重算；
  //  2) 折叠切换必然伴随 Activity onResume——原生侧在 onResume 再补发一次 resize；
  //  3) 短周期(800ms×3)定时复查，screen 变化后总能追上。
  if (typeof window !== 'undefined') {
    const reapply = () => applyPlatformUi()
    window.addEventListener('resize', reapply)
    window.addEventListener('orientationchange', reapply)
    document.addEventListener('visibilitychange', reapply)
    let watchdog = 0
    const armWatchdog = () => {
      window.clearTimeout(watchdog)
      for (let i = 1; i <= 3; i += 1) {
        window.setTimeout(reapply, i * 800)
      }
    }
    window.addEventListener('resize', armWatchdog)
    document.addEventListener('visibilitychange', armWatchdog)
    armWatchdog()
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
// UI 布局基准宽 2133。缩放通过动态改写 viewport width 实现：width = 2133 * 100 / scale，
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
