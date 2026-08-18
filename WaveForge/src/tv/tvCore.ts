/**
 * TV 遥控器交互核心（仅在 html.tv-mode 下生效，桌面不受影响）。
 *
 * 设计思路：把"鼠标 hover/点击"交互整体替换为"焦点"交互——
 *  - 空间导航：D-pad 按 DOM 几何找最佳邻居，滚动到可视区并画焦点环；
 *  - Enter/OK 激活：对焦点元素执行 click()（原生 button/链接/带 onClick 的 div 都适用）；
 *  - 聚焦域（scope）：模态/面板用 data-tv-scope 标记，出现时焦点自动收拢进域内；
 *  - BACK 栈：组件可用 useTvBack() 注册返回处理（关闭面板/软键盘等）；
 *  - data-tv-arrows：容器标记后可让方向键穿透给组件自身逻辑（seek/volume/scroll）。
 *
 * 键码兼容两套：DOM 标准箭头键（37-40）与 Android TV 遥控器键码（19-22 上下左右、23/66 确定）。
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

// ---------------- tv-mode 状态（React 可订阅） ----------------
let tvMode =
  typeof document !== 'undefined' && document.documentElement.classList.contains('tv-mode')

const tvListeners = new Set<() => void>()

export function isTvMode(): boolean {
  return tvMode
}

function setTvMode(v: boolean): void {
  if (tvMode === v) return
  tvMode = v
  tvListeners.forEach((fn) => fn())
}

function subscribeTvMode(cb: () => void): () => void {
  tvListeners.add(cb)
  return () => tvListeners.delete(cb)
}

/** React Hook：当前是否 TV 遥控器模式。 */
export function useTvMode(): boolean {
  return useSyncExternalStore(subscribeTvMode, isTvMode)
}

// ---------------- 远程遥控光标模式（React 可订阅） ----------------
// 手机遥控器连上 TV 后切换为"光标交互"：hover 驱动 UI（与 PC 一致），焦点环隐藏。
let remoteCursorMode = false
const remoteCursorListeners = new Set<() => void>()

export function isRemoteCursorMode(): boolean {
  return remoteCursorMode
}

export function setRemoteCursorMode(v: boolean): void {
  if (remoteCursorMode === v) return
  remoteCursorMode = v
  if (v) {
    // 光标模式下隐藏焦点环（用户在用手势/触摸板，不是方向键）
    ensureRing().classList.add('tv-ring-idle')
  } else {
    ensureRing().classList.remove('tv-ring-idle')
    updateRing()
  }
  remoteCursorListeners.forEach((fn) => fn())
}

function subscribeRemoteCursorMode(cb: () => void): () => void {
  remoteCursorListeners.add(cb)
  return () => remoteCursorListeners.delete(cb)
}

/** React Hook：手机遥控器是否处于连接（光标模式）。 */
export function useRemoteCursorMode(): boolean {
  return useSyncExternalStore(subscribeRemoteCursorMode, isRemoteCursorMode)
}

// ---------------- 焦点候选 ---------------- 
// 除了原生可聚焦元素，还纳入本项目约定俗成的可点击项：
//  - [class*="cursor-pointer"]：歌曲行/歌单卡片等 div + onClick 的容器（Tailwind 统一类）
//  - [data-tv-focus]：组件手动标注的任意可聚焦元素
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]',
  '[data-tv-focus]',
  '[class*="cursor-pointer"]',
].join(', ')

/** 开关（checkbox/radio）在设置页用 sr-only 写法（1x1px），导航/焦点环改用其 label 区域。 */
function focusRectOf(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect()
  if (
    r.width < 2 &&
    r.height < 2 &&
    el.tagName === 'INPUT' &&
    ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')
  ) {
    const label = el.closest('label')
    if (label) {
      const lr = label.getBoundingClientRect()
      if (lr.width >= 2 && lr.height >= 2) return lr
    }
  }
  return r
}

/** 渲染存在性：display/visibility/透明度/尺寸（不含视口与滚动裁剪）。 */
function isRendered(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const style = getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (Number(style.opacity) === 0) return false
  const r = el.getBoundingClientRect()
  // 开关（checkbox/radio）是 sr-only 1px，用 label 区域判定，否则设置页开关永远不可聚焦
  if (r.width < 2 || r.height < 2) {
    const isSwitch =
      el.tagName === 'INPUT' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')
    if (!isSwitch) return false
  }
  const vr = focusRectOf(el)
  if (vr.width < 2 || vr.height < 2) return false
  return true
}

/** 基本可见性：渲染存在 + 在视口内（不含滚动容器裁剪）。 */
function isBasicallyVisible(el: HTMLElement): boolean {
  if (!isRendered(el)) return false
  const vr = focusRectOf(el)
  if (vr.bottom < 0 || vr.top > window.innerHeight) return false
  if (vr.right < 0 || vr.left > window.innerWidth) return false
  return true
}

function isVisible(el: HTMLElement): boolean {
  if (!isBasicallyVisible(el)) return false
  // 滚动容器裁剪判定：被可滚动/裁剪祖先挡住（滚出可视区）的元素不算候选——
  // 否则滚到页面底部按"上"会跳到容器外/不可见的元素（如设置页跳标签栏）。
  if (isClippedByScroll(el)) return false
  return true
}

/** 元素是否被某个滚动/裁剪祖先排除在可视区之外（rect 不相交）。 */
function isClippedByScroll(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    const o = style.overflow
    const oy = style.overflowY
    const scrolls =
      oy === 'auto' || oy === 'scroll' || o === 'auto' || o === 'scroll' || o === 'hidden' || oy === 'hidden'
    if (scrolls) {
      const pr = node.getBoundingClientRect()
      if (r.bottom < pr.top + 1 || r.top > pr.bottom - 1 || r.right < pr.left + 1 || r.left > pr.right - 1) {
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/**
 * 元素是否被「不可滚动」的裁剪容器（overflow:hidden/clip）排除在可视区外。
 * 这类容器无法 scrollIntoView 滚回来，同容器保留逻辑不应接纳它们。
 */
function isClippedByNonScrollable(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    const o = style.overflow
    const oy = style.overflowY
    const scrollable = oy === 'auto' || oy === 'scroll' || o === 'auto' || o === 'scroll'
    const clipping = o === 'hidden' || oy === 'hidden' || o === 'clip' || oy === 'clip'
    if (clipping && !scrollable) {
      const pr = node.getBoundingClientRect()
      if (r.bottom < pr.top + 1 || r.top > pr.bottom - 1 || r.right < pr.left + 1 || r.left > pr.right - 1) {
        // 元素与当前裁剪容器之间若有滚动容器，说明可通过 scrollIntoView 滚回，
        // 外层壳（如设置面板 fixed overflow-hidden）的裁剪不算不可恢复，跳过继续向外查
        let inner: HTMLElement | null = el.parentElement
        let recoverable = false
        while (inner && inner !== node) {
          const si = getComputedStyle(inner)
          if (
            si.overflowY === 'auto' ||
            si.overflowY === 'scroll' ||
            si.overflowX === 'auto' ||
            si.overflowX === 'scroll'
          ) {
            recoverable = true
            break
          }
          inner = inner.parentElement
        }
        if (recoverable) {
          node = node.parentElement
          continue
        }
        return true
      }
    }
    node = node.parentElement
  }
  return false
}

/** 元素所在的最近滚动容器（overflow-y/overflow-x auto/scroll）。 */
function scrollParentOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    const style = getComputedStyle(node)
    if (
      style.overflowY === 'auto' ||
      style.overflowY === 'scroll' ||
      style.overflowX === 'auto' ||
      style.overflowX === 'scroll'
    ) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/**
 * 命中测试：元素中心点是否还能被点击到。
 * 模态/面板打开时，其背后的元素会被遮挡（elementFromPoint 命中遮罩而非元素本身），
 * 从而被自动排除在导航候选之外——无需给每个模态框都标记 data-tv-scope 也能避免焦点"穿墙"。
 */
function isHitTestable(el: HTMLElement): boolean {
  const r = focusRectOf(el)
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
  if (!hit) return false
  if (hit === el || el.contains(hit)) return true
  // sr-only 开关：命中 label 区域即视为可点（视觉开关 div 在 label 内，中心点可能落在它上面）
  const label = el.closest('label')
  if (label && (hit === label || label.contains(hit))) return true
  return false
}

// ---------------- 聚焦域（scope） ----------------
// 按出现顺序入栈；取可见的最顶层。组件卸载后自动失效（isConnected 检查）。
const scopes: HTMLElement[] = []

function currentScope(): HTMLElement | Document {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const s = scopes[i]
    if (s.isConnected && isVisible(s)) return s
  }
  return document
}

function candidates(from: HTMLElement | null = null, dir: Direction | null = null): HTMLElement[] {
  const scope = currentScope()
  const root = scope instanceof Document ? document : scope
  const list = Array.from(root.querySelectorAll(FOCUSABLE_SELECTOR)) as HTMLElement[]
  return list.filter((el) => {
    if (el.closest('[data-tv-skip]')) return false
    // sr-only 开关 input（checkbox/radio 且有 label）：label 已是候选（focusRectOf 用 label rect），
    // 排除 input，避免同一开关两个候选（label + input）rect 相同导致导航原地打转
    if (
      el.tagName === 'INPUT' &&
      ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio') &&
      el.closest('label')
    ) {
      return false
    }
    // 包裹禁用控件（disabled input/button）的 label：禁用开关不可操作，不参与导航
    if (
      el.tagName === 'LABEL' &&
      (el.querySelector('input:disabled, button:disabled, select:disabled') !== null)
    ) {
      return false
    }
    if (!isRendered(el)) return false
    if (isClippedByScroll(el)) {
      // 被不可滚动容器（overflow:hidden/clip）裁掉的项滚不回来，排除
      if (isClippedByNonScrollable(el)) return false
      // 同滚动容器内被裁剪的项仍保留为候选（上下/左右均可）：导航选中后
      // scrollIntoView 自动滚回（横向歌单列表 / 纵向设置页都受益）；
      // 跨容器裁剪项仍排除。
      if (from && dir) {
        const curScroll = scrollParentOf(from)
        const candScroll = scrollParentOf(el)
        if (curScroll && candScroll === curScroll) {
          // 容器在该方向已无滚动余量（滚到头/底）时，被裁剪项滚不回来，排除
          const vertical = dir === 'up' || dir === 'down'
          if (vertical) {
            if (dir === 'down' && candScroll.scrollTop + candScroll.clientHeight >= candScroll.scrollHeight - 1) return false
            if (dir === 'up' && candScroll.scrollTop <= 0) return false
          } else {
            if (dir === 'right' && candScroll.scrollLeft + candScroll.clientWidth >= candScroll.scrollWidth - 1) return false
            if (dir === 'left' && candScroll.scrollLeft <= 0) return false
          }
          return true
        }
      }
      return false
    }
    // 未裁剪项必须在视口内且可命中
    const vr = focusRectOf(el)
    if (vr.bottom < 0 || vr.top > window.innerHeight) return false
    if (vr.right < 0 || vr.left > window.innerWidth) return false
    if (!isHitTestable(el)) return false
    return true
  })
}

// ---------------- 焦点状态与焦点环 ----------------
let focusedEl: HTMLElement | null = null
const focusListeners = new Set<() => void>()

export function getFocusedElement(): HTMLElement | null {
  return focusedEl
}

function subscribeFocus(cb: () => void): () => void {
  focusListeners.add(cb)
  return () => focusListeners.delete(cb)
}

/** React Hook：当前焦点元素（用于"焦点落在组件内部时展开控件"等场景）。 */
export function useTvFocus(): HTMLElement | null {
  return useSyncExternalStore(subscribeFocus, getFocusedElement)
}

let ringEl: HTMLDivElement | null = null

function ensureRing(): HTMLDivElement {
  if (ringEl?.isConnected) return ringEl
  ringEl = document.createElement('div')
  ringEl.id = 'tv-focus-ring'
  // 边框宽度按屏幕宽度缩放：4K 电视（~1920 CSS px 布局）上 3px 几乎不可见
  const borderPx = Math.max(3, Math.round((typeof window !== 'undefined' ? window.innerWidth : 1920) / 640))
  ringEl.style.cssText =
    'position:fixed;pointer-events:none;z-index:2147483000;box-sizing:border-box;' +
    `border-radius:${Math.round(borderPx * 2.6)}px;border:${borderPx}px solid #4fc3f7;` +
    'box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 20px rgba(79,195,247,.5);' +
    'transition:left .12s ease,top .12s ease,width .12s ease,height .12s ease,opacity .3s ease;display:none;'
  document.body.appendChild(ringEl)
  return ringEl
}

function updateRing(): void {
  const ring = ensureRing()
  if (!focusedEl || !focusedEl.isConnected || !isVisible(focusedEl)) {
    ring.style.display = 'none'
    return
  }
  const r = focusRectOf(focusedEl)
  ring.style.display = 'block'
  ring.style.left = `${r.left - 5}px`
  ring.style.top = `${r.top - 5}px`
  ring.style.width = `${r.width + 10}px`
  ring.style.height = `${r.height + 10}px`
}

// 焦点环空闲自动渐隐：任意按键/焦点移动视为活动，3 秒无操作后加 tv-ring-idle 类淡出
let ringIdleTimer: number | null = null

function markRingActive(): void {
  const ring = ensureRing()
  ring.classList.remove('tv-ring-idle')
  if (ringIdleTimer !== null) {
    window.clearTimeout(ringIdleTimer)
  }
  ringIdleTimer = window.setTimeout(() => {
    ensureRing().classList.add('tv-ring-idle')
  }, 3000)
}

// ---------------- 设置焦点 ----------------
// 软键盘激活时：焦点环照常移动，但不调用原生 focus()，避免输入框失焦导致键盘消失。
let keyboardActive = false
// 滑块调节模式：range 聚焦 + OK 进入，左右键增减（见 handleKeyDown）
let rangeAdjusting = false

export function isKeyboardActive(): boolean {
  return keyboardActive
}

export function setKeyboardActive(v: boolean): void {
  keyboardActive = v
  // 关闭键盘/面板后若焦点元素已失效（断连/卸载），重新收拢到首个可见候选
  if (!v && (!focusedEl || !focusedEl.isConnected)) focusFirst()
}

/** 元素所在的"卡片"容器：有内边距+圆角、内含少量可聚焦项的小分组。
 * 焦点滚动以卡片为目标，避免按钮进入视口但卡片标题/说明仍被裁剪（如设置页歌词库卡片）。 */
function cardContainerOf(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const cs = getComputedStyle(node)
    const radius = parseFloat(cs.borderRadius)
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    if (radius > 0 && pad > 0) {
      const r = node.getBoundingClientRect()
      const focusableInside = node.querySelectorAll(FOCUSABLE_SELECTOR).length
      // 排除大面板（高于视口 80% 或含大量焦点项）：那类容器不是"卡片"，滚动它没有意义
      if (r.height < window.innerHeight * 0.8 && focusableInside <= 8) {
        return node
      }
    }
    node = node.parentElement
  }
  return null
}

export function setTvFocus(el: HTMLElement | null): void {
  if (el === focusedEl) {
    updateRing()
    return
  }
  focusedEl?.classList.remove('tv-focused')
  focusedEl = el
  if (el) {
    el.classList.add('tv-focused')
    if (!keyboardActive) {
      try {
        el.focus({ preventScroll: true })
      } catch {
        // ignore
      }
    }
    // 按钮所在卡片（若有）一起滚进视口，保证卡片整体（含上方标题/说明）可见
    const card = cardContainerOf(el)
    ;(card || el).scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  focusListeners.forEach((fn) => fn())
  // 诊断：焦点移动日志（配合局域网调试台定位遥控导航问题）
  try {
    if (el) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.className || '').toString().slice(0, 20)
      console.log(`[FOCUS] ${label}`)
    } else {
      console.log('[FOCUS] null')
    }
  } catch {
    // ignore
  }
  updateRing()
  markRingActive()
  updateVolumeKeyCapture()
  // 焦点刚落位时元素可能处于动画初始帧（getBoundingClientRect 位置偏移），下一帧再校正一次
  requestAnimationFrame(updateRing)
}

/** 焦点在 range 滑块上时，让原生层把音量键转发给页面（用于 +1/-1 调节） */
function updateVolumeKeyCapture(): void {
  const capture =
    focusedEl !== null &&
    focusedEl.tagName === 'INPUT' &&
    (focusedEl as HTMLInputElement).type === 'range'
  const native = (window as any).WaveForgeNative
  if (native?.setVolumeKeyCapture) {
    try {
      native.setVolumeKeyCapture(capture)
    } catch {
      // ignore
    }
  }
}

// ---------------- 空间导航 ----------------
type Direction = 'up' | 'down' | 'left' | 'right'

function bestNeighbor(current: HTMLElement, dir: Direction): HTMLElement | null {
  const list = candidates(current, dir)
  // 诊断：打印候选摘要（文本/是否裁剪/是否同容器），配合调试台定位导航问题
  try {
    const curLabel = (current.textContent || current.getAttribute('aria-label') || current.className || '').toString().replace(/\s+/g, ' ').slice(0, 14)
    const curSp = scrollParentOf(current)
    const diag = list
      .filter((el) => el !== current)
      .slice(0, 10)
      .map((el) => {
        const l = (el.textContent || el.getAttribute('aria-label') || el.className || '').toString().replace(/\s+/g, ' ').slice(0, 10)
        const same = scrollParentOf(el) === curSp
        return `${l}[${isClippedByScroll(el) ? '裁' : '显'}${same ? '同' : '异'}]`
      })
      .join(' ')
    console.log(`[NAV] ${dir} from=${curLabel} cand=${list.length} → ${diag}`)
  } catch {
    // ignore
  }
  const cur = focusRectOf(current)
  const cx = cur.left + cur.width / 2
  const cy = cur.top + cur.height / 2
  let best: HTMLElement | null = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === current) continue
    const r = focusRectOf(el)
    const ecx = r.left + r.width / 2
    const ecy = r.top + r.height / 2
    const dx = ecx - cx
    const dy = ecy - cy
    let inDir = false
    if (dir === 'right') inDir = dx > 4
    else if (dir === 'left') inDir = dx < -4
    else if (dir === 'down') inDir = dy > 4
    else inDir = dy < -4
    if (!inDir) continue
    const parallel = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy)
    const perpendicular = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    // 垂直方向偏差权重大，避免对角线跳跃
    let score = parallel + perpendicular * 1.5
    // 同滚动容器优先：上下导航优先选当前面板滚动区内的项（含滚出可视区的，
    // 选中后自动滚动回去）。仅当同容器该方向无候选（滚到头/底）时，
    // 才允许跨容器候选（如从设置内容区回到顶部 tab）。
    if (dir === 'up' || dir === 'down') {
      const curScroll = scrollParentOf(current)
      const candScroll = scrollParentOf(el)
      if (curScroll && candScroll !== curScroll) score += 400
      // 同容器内滚出可视区的项（可自动滚动回去）也小惩，优先选当前可见的紧邻项
      else if (curScroll && candScroll === curScroll && isClippedByScroll(el)) score += 60
    }
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  // 诊断：选中项
  try {
    if (best) {
      const bl = (best.textContent || best.getAttribute('aria-label') || best.className || '').toString().replace(/\s+/g, ' ').slice(0, 16)
      console.log(`[NAV] → 选中: ${bl}`)
    } else {
      console.log(`[NAV] → 无候选`)
    }
  } catch {
    // ignore
  }
  return best
}

function focusFirst(): void {
  const list = candidates()
  if (list.length) setTvFocus(list[0])
}

/** 焦点元素是否处于允许方向键穿透的容器（seek/volume/scroll 等组件自处理）。 */
function arrowsPassThrough(dir: Direction): boolean {
  if (!focusedEl) return false
  const mode = focusedEl.closest('[data-tv-arrows]')?.getAttribute('data-tv-arrows')
  if (!mode) return false
  if ((mode.includes('seek') || mode.includes('volume')) && (dir === 'left' || dir === 'right')) return true
  if (mode.includes('scroll') && (dir === 'up' || dir === 'down')) return true
  if (mode.includes('horizontal') && (dir === 'left' || dir === 'right')) return true
  return false
}

function moveFocus(dir: Direction): void {
  if (arrowsPassThrough(dir)) return
  if (!focusedEl || !focusedEl.isConnected) {
    focusFirst()
    return
  }
  const next = bestNeighbor(focusedEl, dir)
  if (next) setTvFocus(next)
}

// ---------------- 激活（Enter/OK） ----------------
function activate(): void {
  if (!focusedEl) {
    focusFirst()
    return
  }
  // 先尝试 click()；点击不可用（如纯展示元素）则聚焦第一个候选
  try {
    const el = focusedEl as HTMLElement
    if (typeof el.click === 'function') {
      el.click()
      return
    }
  } catch {
    // ignore
  }
  focusFirst()
}

// ---------------- BACK 处理栈 ----------------
type BackHandler = () => boolean
const backHandlers: BackHandler[] = []

/**
 * 注册 BACK 处理器。默认在挂载时注册一次（栈序 = 挂载/打开顺序，稳定不随渲染漂移）；
 * 传入 deps（如 [target]）可在依赖变化时把处理器重新顶到栈尾提升优先级（软键盘用）。
 */
export function useTvBack(handler: BackHandler, deps: ReadonlyArray<unknown> = []): void {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    const fn = () => ref.current()
    const existing = backHandlers.indexOf(fn)
    if (existing >= 0) backHandlers.splice(existing, 1)
    backHandlers.push(fn)
    return () => {
      const i = backHandlers.indexOf(fn)
      if (i >= 0) backHandlers.splice(i, 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

/** 触发一次 BACK（由 DOM keydown/自定义事件/Kotlin 转发调用）。返回是否已被消费。 */
export function dispatchTvBack(): boolean {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    if (backHandlers[i]()) return true
  }
  return false
}

// ---------------- 全局键监听 ----------------
// 只有文本类输入才算"可编辑"：checkbox/range/radio 等开关不算（否则焦点到开关会被当文本处理）
const TV_TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function isEditable(el: Element | null): boolean {
  if (!el) return false
  const h = el as HTMLElement
  if (h.isContentEditable) return true
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type || 'text'
    return TV_TEXT_INPUT_TYPES.has(type)
  }
  return false
}

function dirOf(code: number): Direction {
  switch (code) {
    case 37:
    case 21:
      return 'left'
    case 38:
    case 19:
      return 'up'
    case 39:
    case 22:
      return 'right'
    default:
      return 'down'
  }
}

function handleKeyDown(e: KeyboardEvent): void {
  if (!tvMode) return
  const code = e.keyCode
  // 任何按键都视为活动：焦点环重新显示，3 秒无操作后渐隐
  markRingActive()

  // 音量键（KEYCODE_VOLUME_UP=24 / DOWN=25，原生层在滑块聚焦时转发）：
  // 焦点在 range 滑块上时 +1/-1 调节，而不是移走焦点
  if (code === 24 || code === 25) {
    const el = focusedEl
    if (el && el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'range') {
      e.preventDefault()
      const input = el as HTMLInputElement
      try {
        if (code === 24) input.stepUp()
        else input.stepDown()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        // ignore
      }
    }
    return
  }

  // 滑块调节模式：焦点在 range 上按 OK 进入，左右键增减；再按其他键退出恢复导航
  const isRangeFocused =
    focusedEl !== null &&
    focusedEl.tagName === 'INPUT' &&
    (focusedEl as HTMLInputElement).type === 'range'
  if (isRangeFocused && (code === 13 || code === 23 || code === 66)) {
    e.preventDefault()
    if (!rangeAdjusting) {
      rangeAdjusting = true
      try {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '按 ◀ ▶ 调节数值，其他键退出', type: 'info' } }))
      } catch {
        // ignore
      }
    }
    return
  }
  if (rangeAdjusting && isRangeFocused) {
    if (code === 37 || code === 21 || code === 39 || code === 22) {
      e.preventDefault()
      const input = focusedEl as HTMLInputElement
      try {
        if (code === 37 || code === 21) input.stepDown()
        else input.stepUp()
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new Event('change', { bubbles: true }))
      } catch {
        // ignore
      }
      return
    }
    rangeAdjusting = false // 非左右键：退出调节模式，走正常导航
  }

  // 软键盘激活：方向键在键盘网格内做空间导航，Enter 激活键位，BACK 关闭键盘
  if (keyboardActive) {
    switch (code) {
      case 37:
      case 38:
      case 39:
      case 40:
      case 19:
      case 20:
      case 21:
      case 22:
        e.preventDefault()
        moveFocus(dirOf(code))
        return
      case 13:
      case 23:
      case 66:
        e.preventDefault()
        activate()
        return
      case 4:
        if (dispatchTvBack()) e.preventDefault()
        return
      default:
        return
    }
  }

  // 输入框聚焦时（非软键盘激活，例如接物理键盘），方向键留给文本编辑
  if (isEditable(document.activeElement)) {
    return
  }

  switch (code) {
    case 37: // ArrowLeft
    case 21:
      e.preventDefault()
      moveFocus('left')
      return
    case 38: // ArrowUp
    case 19:
      e.preventDefault()
      moveFocus('up')
      return
    case 39: // ArrowRight
    case 22:
      e.preventDefault()
      moveFocus('right')
      return
    case 40: // ArrowDown
    case 20:
      e.preventDefault()
      moveFocus('down')
      return
    case 13: // Enter
    case 23: // KEYCODE_DPAD_CENTER
    case 66: // KEYCODE_ENTER
      e.preventDefault()
      activate()
      return
    case 8: // Backspace（PC 模拟 TV 的 BACK）
    case 27: // Escape（PC 模拟 TV 的 BACK）
    case 4: // KEYCODE_BACK
      if (dispatchTvBack()) {
        e.preventDefault()
        // 真机：告知原生层"页面已消费 BACK"，避免原生再执行默认返回/退出
        try {
          ;(window as any).WaveForgeNative?.reportBackConsumed?.()
        } catch {
          // ignore
        }
      }
      return
    case 85: // KEYCODE_MEDIA_PLAY_PAUSE
    case 126: // KEYCODE_MEDIA_PLAY
    case 127: // KEYCODE_MEDIA_PAUSE
    case 86: // KEYCODE_MEDIA_STOP
    case 87: // KEYCODE_MEDIA_NEXT
    case 88: // KEYCODE_MEDIA_PREVIOUS
      // 媒体键：不拦截，交给 App 的 mediaSession / 快捷键逻辑
      return
    default:
      return
  }
}

// ---------------- 聚焦域自动管理 ----------------
let scopeObserver: MutationObserver | null = null

function setupScopeObserver(): void {
  scopeObserver = new MutationObserver((mutations) => {
    let changed = false
    let focusedRemoved = false
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node.matches('[data-tv-scope]')) {
          scopes.push(node)
          changed = true
        }
        node.querySelectorAll('[data-tv-scope]').forEach((el) => {
          scopes.push(el as HTMLElement)
          changed = true
        })
      }
      for (const node of m.removedNodes) {
        // 面板卸载：若焦点在被移除子树内，立即隐藏焦点环并复位（避免环残留悬浮）
        if (focusedEl && node instanceof Node && node.contains(focusedEl)) {
          focusedEl = null
          focusedRemoved = true
        }
        // 惰性剔除已断连的 scope，避免长会话累积对已卸载 DOM 的强引用
        for (let i = scopes.length - 1; i >= 0; i--) {
          if (node instanceof Node && node.contains(scopes[i])) scopes.splice(i, 1)
        }
      }
    }
    if (focusedRemoved) updateRing()
    if (changed) {
      // 新面板打开：若当前焦点不在新域内，收拢到新域
      const scope = currentScope()
      if (scope instanceof HTMLElement && (!focusedEl || !scope.contains(focusedEl))) {
        focusFirst()
      }
    }
  })
  scopeObserver.observe(document.body, { childList: true, subtree: true })
}

// 初始时收录已存在的域
function collectExistingScopes(): void {
  document.querySelectorAll('[data-tv-scope]').forEach((el) => scopes.push(el as HTMLElement))
}

// ---------------- 初始化 ----------------
let initialized = false

export function initTv(): void {
  if (initialized) return
  initialized = true
  tvMode = document.documentElement.classList.contains('tv-mode')
  if (!tvMode) return

  ensureRing()
  collectExistingScopes()
  setupScopeObserver()
  document.addEventListener('keydown', handleKeyDown, true)

  // 首次聚焦
  focusFirst()

  // 每次布局/渲染变化后校正焦点环位置（ResizeObserver 对整页更省事，用 rAF 节流）
  let raf = 0
  const onLayout = () => {
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(updateRing)
  }
  window.addEventListener('scroll', onLayout, true)
  window.addEventListener('resize', onLayout)
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onLayout)
    ro.observe(document.body)
  }
  // 面板入场/出场动画（framer-motion 改 transform/opacity）不触发 resize/scroll：
  // 监听动画与过渡结束事件，动画完成后重画焦点环到最终位置
  document.addEventListener('transitionend', onLayout, true)
  document.addEventListener('animationend', onLayout, true)
}

/** 在文档加载完成后调用一次（WebView 就绪、React 挂载后由 main.tsx 调用）。 */
export function startTv(): void {
  if (typeof document === 'undefined') return
  if (!document.documentElement.classList.contains('tv-mode')) return
  if (!initialized) {
    initTv()
  } else {
    // 已初始化过（如 React 挂载后再次调用）：重新收拢焦点到当前可见候选。
    focusFirst()
  }
}

/** 供 Kotlin 转发媒体键等时判定是否已激活。 */
export function isTvActive(): boolean {
  return tvMode
}
