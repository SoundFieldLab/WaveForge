/**
 * playheadSync —— 模式 C 轨迹时间预览「随曲目播放」自动跟随
 *
 * 纯模块（无 React/DOM 依赖，可在 node/jsdom 单测，测试注入假 raf）：
 *  - shouldEmitPlayhead：节流判定（|next − prev| > threshold 才发）
 *  - createPlayheadSyncer：raf 循环，每帧读播放时钟 → 节流后经 onChange 下发
 *
 * 设计：
 *  - 节流 0.05s：playhead patch 会触发 fusion 重发 spatial config，过密下发
 *    打爆消息通道；0.05s 步进 ≈ 20fps 轨迹插值精度，视觉无感。
 *  - 暂停时时钟自然停走（store 的 currentTime 不推进），playhead 停在暂停点；
 *    不做额外 isPlaying 判断——暂停/seek 等时钟跳变同样被 0.05s 阈值吸收。
 *  - start() 开启即快照对齐一次（playhead 跳到曲目当前时刻），之后按阈值节流；
 *    stop() 后 start() 可再次对齐（手动拖动覆盖结束恢复自动时复用）。
 *  - 帧调度可注入：测试用假 raf 手动驱动帧回调，断言 onChange 次数与值。
 */

/** 节流阈值（秒）：|next − prev| > 0.05 才下发一次 playhead patch */
export const PLAYHEAD_EMIT_THRESHOLD = 0.05

/** 手动拖动覆盖时长（毫秒）：滑块最后一次变化后经过该时长才恢复自动跟随 */
export const PLAYHEAD_MANUAL_OVERRIDE_MS = 200

/**
 * 节流判定：前后时钟差超过阈值才需要下发。
 * 负变化（seek 回退）同样触发——|Δ| 取绝对值。
 */
export function shouldEmitPlayhead(
  prev: number,
  next: number,
  threshold: number = PLAYHEAD_EMIT_THRESHOLD,
): boolean {
  return Math.abs(next - prev) > threshold
}

export interface PlayheadSyncerOptions {
  /** 节流阈值（秒），默认 PLAYHEAD_EMIT_THRESHOLD（0.05） */
  threshold?: number
  /** 帧调度器（测试注入假 raf；默认 requestAnimationFrame） */
  raf?: (cb: (now: number) => void) => number
  /** 取消帧调度（默认 cancelAnimationFrame） */
  cancelRaf?: (id: number) => void
}

export interface PlayheadSyncer {
  /** 启动循环（幂等）；开启即对齐下发一次当前时钟，之后按阈值节流 */
  start(): void
  /** 停止循环（幂等）；暂停点固定、不补发 */
  stop(): void
}

/**
 * 创建 playhead 自动同步器。
 *
 * @param getTime 读取当前播放时钟（秒）——播放暂停时自然停走
 * @param onChange 节流后的下发回调（调用方接 onChange({ playhead: t })）
 * @param options 阈值 / 帧调度注入
 */
export function createPlayheadSyncer(
  getTime: () => number,
  onChange: (t: number) => void,
  options: PlayheadSyncerOptions = {},
): PlayheadSyncer {
  const threshold = options.threshold ?? PLAYHEAD_EMIT_THRESHOLD
  const schedule = options.raf ?? requestAnimationFrame
  const cancel = options.cancelRaf ?? cancelAnimationFrame
  let running = false
  let rafId = 0
  /** 最近一次已下发的时钟值（节流基线） */
  let lastSent = 0

  const frame = (): void => {
    if (!running) return
    const next = getTime()
    if (shouldEmitPlayhead(lastSent, next, threshold)) {
      lastSent = next
      onChange(next)
    }
    rafId = schedule(frame)
  }

  return {
    start(): void {
      if (running) return
      running = true
      // 开启即对齐：节流基线取当前时钟并立即下发一次——自动跟随开启瞬间
      // playhead 跳到曲目当前时刻（暂停时即暂停点），之后按阈值节流推进。
      lastSent = getTime()
      onChange(lastSent)
      rafId = schedule(frame)
    },
    stop(): void {
      if (!running) return
      running = false
      cancel(rafId)
    },
  }
}
