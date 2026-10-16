// 全局高刷的渲染层限流。
//
// 背景（这是必须放在渲染层的原因）：
// Electron 的 `webContents.setFrameRate()` 按官方 typings 只在「离屏渲染(offscreen)」下
// 生效（"If offscreen rendering is enabled sets the frame rate to the specified number"，
// `frameRate` 属性同样标注 "Only applicable if offscreen rendering is enabled"），
// 而本应用所有窗口都是普通窗口（main.cjs 里没有任何 offscreen:true）。
// 实测：对普通窗口依次调用 setFrameRate(15/30/60/120/240)，渲染器的 rAF 频率恒等于
// 显示器刷新率（240Hz 屏上全部是 240fps），窗口焦点与调用时机都不影响。
// 于是「关掉高刷」并没有把界面降到 60Hz 基准，开关两侧完全一样。
//
// 因此帧率上限只能自己实现：包一层 requestAnimationFrame，由闸门按时间戳决定
// 这一帧是否真正执行回调。跳过帧时不跑任何业务代码，只做一次比较。
//
// 关键性质：目标帧率 >= 显示器刷新率时闸门恒开（零限流），所以「全局高刷」档
// 保持满帧不受影响；限流只在用户显式压低档位、或关闭高刷回到 60Hz 基准时起作用。

export interface FrameRateTarget {
  /** 设置里是否开启了全局高刷（仅供 UI 显示，限流判断只看 hz 与 displayHz） */
  enabled: boolean
  /** 该窗口的目标渲染帧率（Hz） */
  hz: number
  /** 该窗口所在显示器的刷新率（Hz），用于判断是否还需要限流 */
  displayHz: number
}

/** 目标帧率对应的最小帧间隔（ms）。返回 0 表示不限流。 */
export function frameIntervalMs(target: FrameRateTarget | null): number {
  // 尚未取到目标（启动瞬间）：不限流，避免误伤高刷档的启动首帧
  if (!target) return 0
  const hz = Number(target.hz)
  if (!Number.isFinite(hz) || hz <= 0) return 0
  const displayHz = Number(target.displayHz)
  // 目标不低于显示器刷新率 → 满帧跟随，无需限流（高刷档走这条）
  if (Number.isFinite(displayHz) && displayHz > 0 && hz >= displayHz) return 0
  return 1000 / hz
}

/**
 * 帧闸门：给一串 vsync 时间戳，回答「这一帧该不该真正执行」。
 * 抽成纯函数便于单测；容差用于吸收毫秒取整误差（如 120Hz 的 8.333ms）。
 */
export function createFrameGate(
  getIntervalMs: () => number,
  toleranceMs = 0.5,
): { shouldRun: (ts: number) => boolean; reset: () => void } {
  let lastRunTs = 0
  return {
    shouldRun(ts: number): boolean {
      const interval = getIntervalMs()
      if (interval <= 0) {
        lastRunTs = ts
        return true
      }
      // 以「上一次真正执行」为基准，不用累加：某帧迟到时不会连补几帧造成突发
      if (lastRunTs !== 0 && ts - lastRunTs < interval - toleranceMs) return false
      lastRunTs = ts
      return true
    },
    reset() {
      lastRunTs = 0
    },
  }
}

/** 注入式 vsync 源，便于单测用假时钟驱动。 */
export interface RafThrottleHooks {
  raf: (callback: (ts: number) => void) => number
  caf: (handle: number) => void
  getIntervalMs: () => number
}

export interface RafThrottle {
  /** 可直接替换 window.requestAnimationFrame */
  raf: (callback: FrameRequestCallback) => number
  /** 可直接替换 window.cancelAnimationFrame */
  caf: (handle: number) => void
  /** 当前排队等待执行的回调数（诊断用） */
  pendingCount: () => number
}

/**
 * rAF 蹦床：所有注册都进内部队列，由帧闸门决定这一帧是否整批执行。
 *
 * 为什么全部走内部队列、不在「不限流」时直通原生 rAF：两种模式混用会让自增 id
 * 与原生句柄撞号，`cancelAnimationFrame` 可能取消错对象。统一走内部 id 空间即可根除。
 * 受限时空闲代价只是每帧一次 Map 操作。
 *
 * 语义与原生保持一致：同一帧的回调收到同一个时间戳、按注册顺序执行、
 * 回调内新注册的属于下一帧、取消已执行过的句柄是空操作。
 */
export function createRafThrottle(
  hooks: RafThrottleHooks,
  onFrameRun?: (ts: number) => void,
): RafThrottle {
  const gate = createFrameGate(hooks.getIntervalMs)
  const pending = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  let armed = false

  function schedule(): void {
    if (armed || pending.size === 0) return
    armed = true
    hooks.raf(pump)
  }

  function pump(ts: number): void {
    armed = false
    if (gate.shouldRun(ts)) {
      if (onFrameRun) onFrameRun(ts)
      // 先摘出整批再执行：回调里新注册的 rAF 属于下一帧（与原生语义一致）
      const batch = Array.from(pending.values())
      pending.clear()
      for (const callback of batch) {
        try {
          callback(ts)
        } catch (error) {
          // 单个回调抛错不能掀掉整帧、更不能中断后续回调
          console.error('[frame-rate] rAF 回调抛错:', error)
        }
      }
    }
    schedule()
  }

  return {
    raf(callback: FrameRequestCallback): number {
      const handle = nextHandle++
      pending.set(handle, callback)
      schedule()
      return handle
    },
    caf(handle: number): void {
      pending.delete(handle)
    },
    pendingCount(): number {
      return pending.size
    },
  }
}

/** 主窗桥来自 preload.cjs 的 display 段，名字是 getFrameRate/onFrameRate。 */
export interface MainDisplayFrameRateBridgeRaw {
  getFrameRate?: () => Promise<FrameRateTarget | null>
  onFrameRate?: (callback: (target: FrameRateTarget) => void) => (() => void) | void
}

/** 两个独立小窗桥来自各自的 preload，名字是 get/onSet。 */
export interface FrameRateBridgeRaw {
  get?: () => Promise<FrameRateTarget | null>
  onSet?: (callback: (target: FrameRateTarget) => void) => (() => void) | void
}

export interface FrameRateBridgeHost {
  electron?: { display?: MainDisplayFrameRateBridgeRaw }
  desktopLyrics?: { frameRate?: FrameRateBridgeRaw }
  desktopPlayer?: { frameRate?: FrameRateBridgeRaw }
}

/** 归一化后的桥：两个方法都保证存在，渲染层只跟这个类型打交道。 */
interface FrameRateBridge {
  get: () => Promise<FrameRateTarget | null>
  onSet: (callback: (target: FrameRateTarget) => void) => (() => void) | void
}

/**
 * 解析出可用的帧率桥。
 *
 * 注意三个 preload 暴露的方法名不一致（主窗是 getFrameRate/onFrameRate，
 * 两个独立小窗是 get/onSet），必须分别匹配——统一当成一种形状会导致静默失效：
 * 桥取不到 → target 恒为 null → 限流永不生效，「关掉高刷」看起来毫无作用。
 * 这里抽成可测函数，由 test/frameRateLimiter.test.ts 用三个 preload 的真实形状守住。
 */
export function resolveFrameRateBridge(host: FrameRateBridgeHost): FrameRateBridge | null {
  const fromMain = host.electron?.display
  if (fromMain?.getFrameRate && fromMain.onFrameRate) {
    return { get: fromMain.getFrameRate, onSet: fromMain.onFrameRate }
  }
  for (const candidate of [host.desktopLyrics?.frameRate, host.desktopPlayer?.frameRate]) {
    if (candidate?.get && candidate.onSet) {
      return { get: candidate.get, onSet: candidate.onSet }
    }
  }
  return null
}

function findBridge(): FrameRateBridge | null {
  return resolveFrameRateBridge(window as unknown as FrameRateBridgeHost)
}

let installed = false
let target: FrameRateTarget | null = null
let activeThrottle: RafThrottle | null = null

// 实测帧率：设置面板显示的是「请求值」，这里统计「真正执行的帧率」，
// 让用户能看出设置有没有生效（旧的 setFrameRate 时代两者会长期不一致）。
let measuredHz = 0
let measuredFrames = 0
let measuredFromTs = 0

function recordMeasuredFrame(ts: number): void {
  if (measuredFromTs === 0) {
    measuredFromTs = ts
    measuredFrames = 0
    return
  }
  measuredFrames += 1
  const elapsed = ts - measuredFromTs
  if (elapsed >= 1000) {
    measuredHz = Math.round((measuredFrames * 1000) / elapsed)
    measuredFromTs = ts
    measuredFrames = 0
  }
}

function applyTarget(next: FrameRateTarget | null): void {
  if (!next) return
  const hz = Number(next.hz)
  const displayHz = Number(next.displayHz)
  const changed = !target || target.hz !== hz || target.displayHz !== displayHz || target.enabled !== next.enabled
  target = { enabled: next.enabled === true, hz, displayHz }
  if (changed) {
    const interval = frameIntervalMs(target)
    console.log(`[frame-rate] 目标 ${hz}Hz（所在显示器 ${displayHz}Hz）→ ${interval > 0 ? `限流 ${hz}fps` : '满帧跟随'}`)
  }
}

/** 安装渲染层帧率限流（幂等）。替换全局 requestAnimationFrame。 */
export function installFrameRateLimiter(): void {
  if (installed) return
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
  installed = true

  const nativeRaf = window.requestAnimationFrame.bind(window)
  const nativeCaf = window.cancelAnimationFrame.bind(window)
  activeThrottle = createRafThrottle(
    { raf: nativeRaf, caf: nativeCaf, getIntervalMs: () => frameIntervalMs(target) },
    recordMeasuredFrame,
  )
  window.requestAnimationFrame = activeThrottle.raf
  window.cancelAnimationFrame = activeThrottle.caf

  const bridge = findBridge()
  if (!bridge) return
  try {
    bridge.onSet((next) => applyTarget(next))
  } catch (error) {
    console.warn('[frame-rate] 订阅帧率变更失败:', error)
  }
  // 先按「不限流」启动（target 为 null），取到真实目标后立即收紧：
  // 反过来会让高刷档在启动瞬间被误压到 60fps
  Promise.resolve(bridge.get())
    .then((next) => applyTarget(next ?? null))
    .catch((error) => console.warn('[frame-rate] 读取目标帧率失败:', error))
}

/** 供设置面板读取：实测到的渲染帧率（Hz），0 表示还没测出。 */
export function getMeasuredFrameRate(): number {
  return measuredHz
}

/** 供设置面板读取：当前这一帧是否被限流（false 表示满帧跟随显示器）。 */
export function isFrameRateLimited(): boolean {
  return frameIntervalMs(target) > 0
}

/** 仅测试用：查询蹦床排队数。 */
export function getPendingFrameCount(): number {
  return activeThrottle ? activeThrottle.pendingCount() : 0
}

// 在模块求值阶段就替换全局 rAF，而不是等入口调用：ES 模块的 import 会先于引用方
// 的函数体全部求值，App/framer-motion/three 这些若在各自的模块作用域缓存了 rAF
// 引用，等到入口函数体里再调用就晚了。只有 window 上确实有 rAF 时才装，
// 因此 vitest 的 node 环境（无 window）不会触发，单测可纯逻辑导入本模块。
installFrameRateLimiter()
