/**
 * 音频线程时钟（主线程侧）。
 *
 * 用途：给「窗口不可见时仍需继续」的后台工作提供稳定的按帧率 tick。
 *
 * 为什么不能用定时器/rAF：页面隐藏后 Chromium 把它们压到 ~1Hz 甚至停掉（实测
 * setInterval(16ms) → 2/s、rAF → 0），而音频渲染线程不受页面可见性影响——实测同一页面
 * 被遮挡 + 节流生效时，AudioWorklet 的消息仍是 189/s，与可见时一致。
 *
 * 为什么不用「关掉窗口后台节流」来绕：那会让 document.visibilityState 永久停在
 * 'visible'，于是界面在完全不可见时仍按显示器刷新率满速渲染（实测 240fps），
 * 且全仓所有基于可见性的门控（含各可视化、桌面挂件轮询）全部失效。
 *
 * 所以后台工作需要的是「换一个不受可见性影响的时钟」，而不是「让窗口一直醒着」。
 *
 * 共享策略：按 AudioContext 复用同一个 worklet 节点（多个订阅者共享，tick 间隔取最大
 * 需求），避免每个插件各建一套音频图。加载失败（非安全上下文 / 无 AudioWorklet）时
 * 降级为定时器：功能不丢，只是退回「窗口隐藏即降频」的旧行为。
 */

const CLOCK_WORKLET_URL = './wf-audio-clock-worklet.js'
const RENDER_QUANTUM = 128
/** tick 间隔比较容差下限：吸收毫秒取整误差 */
const TOLERANCE_MS = 0.5
/** 超过这个时长没有音频线程 tick，就认为音频图停了（context 挂起/无音频），用定时器兜底 */
const STALL_FALLBACK_MS = 1500
const MAX_FPS = 120

interface Subscriber {
  fps: number
  callback: (nowMs: number) => void
  lastRunAt: number
}

export interface AudioThreadClock {
  /** 'worklet' = 走音频线程（隐藏时也稳定）；'timer' = 降级（隐藏时会被压到 ~1Hz） */
  readonly mode: 'worklet' | 'timer'
  /** 按 fps 订阅 tick，返回取消函数。多个订阅者共享同一个底层节点。 */
  subscribe: (fps: number, callback: (nowMs: number) => void) => () => void
  /** 当前订阅者数量（诊断用） */
  subscriberCount: () => number
}

function createClock(context: BaseAudioContext): AudioThreadClock {
  const subscribers = new Set<Subscriber>()
  const sampleRate = Number(context.sampleRate) > 0 ? Number(context.sampleRate) : 48000
  let mode: 'worklet' | 'timer' = 'timer'
  let node: AudioWorkletNode | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let watchdog: ReturnType<typeof setInterval> | null = null
  let lastTickAt = 0
  let loading = false
  let disposed = false
  // 闸门容差：tick 栅格不可能比一个 render quantum 更细，所以「比目标早一个 quantum 以内」
  // 必须算达标；否则会隔帧被跳（实测过 30fps 目标只跑出 15.3/s）。
  let toleranceMs = TOLERANCE_MS

  const maxFps = () => {
    let fps = 0
    for (const subscriber of subscribers) fps = Math.max(fps, subscriber.fps)
    return Math.min(MAX_FPS, Math.max(1, Math.round(fps) || 30))
  }

  /**
   * 闸门容差自校准。
   *
   * tick 栅格的真实间隔取决于设备的渲染批次（未知），所以不靠推算常数：直接用观测到的
   * tick 间隔当容差。容差小于一个栅格时闸门会隔格跳过（实测把 30fps 目标跑成 15.3/s）。
   * 按 process() 调用计数的 tick 在毫秒级，容差因此只有几毫秒，节拍误差可忽略。
   */
  let workletActive = false
  let observedTickMs = 0
  const calibrate = (gapMs: number) => {
    if (!(gapMs > 0.05) || gapMs > 200) return
    observedTickMs = observedTickMs === 0 ? gapMs : observedTickMs * 0.8 + gapMs * 0.2
    toleranceMs = Math.max(TOLERANCE_MS, Math.min(observedTickMs, 20))
  }


  const dispatch = (nowMs: number) => {
    if (workletActive && lastTickAt !== 0) calibrate(nowMs - lastTickAt)
    lastTickAt = nowMs
    // 复制一份再遍历：回调里可能取消订阅
    for (const subscriber of Array.from(subscribers)) {
      const interval = 1000 / subscriber.fps
      if (subscriber.lastRunAt !== 0 && nowMs - subscriber.lastRunAt < interval - toleranceMs) continue
      subscriber.lastRunAt = nowMs
      try {
        subscriber.callback(nowMs)
      } catch (error) {
        console.error('[audio-clock] tick 回调抛错:', error)
      }
    }
  }

  const stopSources = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (watchdog !== null) {
      clearInterval(watchdog)
      watchdog = null
    }
    if (node) {
      try { node.port.onmessage = null } catch { /* 忽略 */ }
      try { node.disconnect() } catch { /* 忽略 */ }
    }
  }

  const startTimerSource = (fps: number) => {
    if (timer !== null) clearInterval(timer)
    // 定时器源本身就是目标间隔，容差用下限即可
    toleranceMs = TOLERANCE_MS
    timer = setInterval(() => dispatch(performance.now()), Math.max(4, Math.round(1000 / fps)))
  }

  const ensureSources = () => {
    if (disposed || subscribers.size === 0) {
      stopSources()
      return
    }
    const fps = maxFps()
    if (mode === 'worklet' && node) {
      try { node.port.postMessage({ tickEveryCalls: 2 }) } catch { /* 忽略 */ }
    } else if (timer !== null) {
      startTimerSource(fps)
    }
    // 兜底心跳：音频图停摆（context 挂起 / 无音频流）时至少保留 ~1Hz，
    // 避免「后台灯效完全冻住」；隐藏时该定时器本身被压到 ~1Hz，正好是需要的下限。
    if (watchdog === null) {
      watchdog = setInterval(() => {
        if (disposed || subscribers.size === 0) return
        if (performance.now() - lastTickAt < STALL_FALLBACK_MS) return
        dispatch(performance.now())
      }, STALL_FALLBACK_MS)
    }
  }

  const initWorklet = async () => {
    if (loading || disposed || mode === 'worklet') return
    loading = true
    try {
      const worklet = (context as unknown as { audioWorklet?: { addModule: (url: string) => Promise<void> } }).audioWorklet
      if (!worklet?.addModule) throw new Error('AudioWorklet 不可用')
      await worklet.addModule(CLOCK_WORKLET_URL)
      if (disposed) return
      node = new AudioWorkletNode(context, 'waveforge-audio-clock')
      node.port.onmessage = () => {
        // 音频线程的时间戳（currentTime）与本页 performance.now 不是同一时基，
        // 这里只把「tick 到了」当信号，门槛判断统一用主线程时基，避免混算。
        dispatch(performance.now())
      }
      workletActive = true
      try { node.port.postMessage({ tickEveryCalls: 2 }) } catch { /* 忽略 */ }
      // 接 destination 才会被音频图拉取；输出在 worklet 里清零，不发声
      node.connect(context.destination)
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      mode = 'worklet'
    } catch {
      // 降级：定时器源（隐藏时会被节流，属于已知且可接受的退化）
      mode = 'timer'
    } finally {
      loading = false
      ensureSources()
    }
  }

  return {
    get mode() {
      return mode
    },
    subscriberCount: () => subscribers.size,
    subscribe(fps, callback) {
      const subscriber: Subscriber = { fps: Math.max(1, Math.min(MAX_FPS, fps)), callback, lastRunAt: 0 }
      subscribers.add(subscriber)
      if (mode === 'timer' && timer === null) startTimerSource(maxFps())
      ensureSources()
      void initWorklet()
      return () => {
        subscribers.delete(subscriber)
        ensureSources()
      }
    },
  }
}

const clockByContext = new WeakMap<BaseAudioContext, AudioThreadClock>()

/** 取（必要时创建）指定音频上下文的时钟。同一 context 全局共享一个底层节点。 */
export function getAudioThreadClock(context: BaseAudioContext | null | undefined): AudioThreadClock | null {
  if (!context) return null
  let clock = clockByContext.get(context)
  if (!clock) {
    clock = createClock(context)
    clockByContext.set(context, clock)
  }
  return clock
}

/**
 * 起一个按 fps 稳定心跳的循环，返回释放函数。
 *
 * 优先音频线程时钟：窗口隐藏后主线程定时器会被压到 ~1Hz，氛围灯/节拍事件形同卡死；
 * 音频线程不受页面可见性影响，因此「后台运行」这类开关才有意义。
 * 取不到时钟（没有音频上下文 / AudioWorklet 不可用）时退回 setInterval：
 * 功能不丢，只是退回「窗口隐藏即降频」的旧行为。
 *
 * 可见状态下两者频率一致，因此不需要按可见性切换——调用方只需在频率/开关变化时重启。
 */
export function startFrameTicker(
  context: BaseAudioContext | null | undefined,
  fps: number,
  callback: () => void,
): () => void {
  const clock = getAudioThreadClock(context)
  if (clock) return clock.subscribe(fps, () => callback())
  const interval = Math.max(4, Math.round(1000 / Math.max(1, fps)))
  const timer = setInterval(callback, interval)
  return () => clearInterval(timer)
}
