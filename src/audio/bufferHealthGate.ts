/**
 * 后台重任务动态门控（带宽/解码预算调度）。
 *
 * 播放关键路径（当前曲音频流、MV 视频流、歌词、封面）永远立即并行，不被门控；
 * 只有「下一曲预载 + AutoMix 离线分析渲染」这类重后台任务走本门控：它们等
 * 当前曲缓冲健康（下载前沿领先播放位置足够远）后立刻放行——动态看实际缓冲，
 * 不用固定秒数，缓冲来得快就放得快。
 *
 * 设计要点：
 * - 门控期间挂起的任务按 FIFO 排队，健康条件满足时一次性放行（后台任务本身
 *   不需要保序，但顺序执行去重逻辑更可预测）；
 * - 兜底超时（默认 20s）：CDN 慢/代理不回 content-length 等场景下缓冲健康
 *   可能永远不满足，超时后强制放行——宁可偶尔抢一点带宽，不能让下一曲预载
 *   和 AutoMix 永久饿死（否则过渡边界处现算 = 卡整个过渡）；
 * - 健康判定基于 HTMLMediaElement buffered（毫秒级，读取零成本）；
 * - 新歌加载（loadAndPlay）会 reset()：换曲后旧健康状态作废，重新等新曲缓冲。
 */

export interface BufferHealthGateOptions {
  /** 下载前沿需领先播放位置的距离（秒）。低于它 = 当前曲还饥渴，后台任务让路。 */
  readonly leadSeconds: number
  /** 兜底超时（毫秒）：等待超过此时长无条件放行。0 = 不设兜底（不推荐）。 */
  readonly fallbackTimeoutMs: number
  /** 健康探测轮询间隔（毫秒）。 */
  readonly pollIntervalMs: number
  /** 调试输出。 */
  readonly debug?: (message: string) => void
}

export const DEFAULT_BUFFER_HEALTH_GATE_OPTIONS: BufferHealthGateOptions = {
  leadSeconds: 30,
  fallbackTimeoutMs: 20_000,
  pollIntervalMs: 250,
}

type QueuedTask = {
  run: () => void
  enqueuedAt: number
  label: string
}

export class BufferHealthGate {
  private options: BufferHealthGateOptions
  private queue: QueuedTask[] = []
  private fallbackTimer: number | null = null
  private pollTimer: number | null = null
  private oldestWaitStart: number | null = null

  constructor(options: Partial<BufferHealthGateOptions> = {}) {
    this.options = { ...DEFAULT_BUFFER_HEALTH_GATE_OPTIONS, ...options }
  }

  /**
   * 经门控执行任务：当前曲缓冲健康（或兜底超时）后立刻 run()；已健康时同步执行。
   * 返回是否立即执行（false = 排队等待中）。
   */
  runWhenHealthy(audio: HTMLMediaElement | null, label: string, run: () => void): boolean {
    if (this.isHealthy(audio)) {
      run()
      return true
    }
    this.queue.push({ run, enqueuedAt: performance.now(), label })
    if (this.oldestWaitStart === null) {
      this.oldestWaitStart = performance.now()
      this.startFallback()
    }
    this.startPolling(audio)
    return false
  }

  /** 当前曲缓冲是否已健康：下载前沿领先播放位置 leadSeconds 秒以上（或已接近曲尾）。 */
  private isHealthy(audio: HTMLMediaElement | null): boolean {
    if (!audio || audio.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) {
      // HAVE_ENOUGH_DATA = 浏览器按当前速率判断缓冲充足（整曲已进内存或流式充足）
      return true
    }
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) return false
    const buffered = audio.buffered
    if (buffered.length === 0) return false
    const position = audio.currentTime
    // 找包含播放位置的 range
    let front = -1
    for (let index = 0; index < buffered.length; index += 1) {
      if (position >= buffered.start(index) - 0.5 && position <= buffered.end(index)) {
        front = buffered.end(index)
        break
      }
    }
    if (front < 0) front = buffered.end(buffered.length - 1)
    const lead = front - position
    // 接近曲尾时前沿追不上 lead 是正常的：剩余全长够过渡即可
    const duration = Number.isFinite(audio.duration) ? audio.duration : Infinity
    if (duration - position < this.options.leadSeconds) return lead > (duration - position) * 0.8
    return lead >= this.options.leadSeconds
  }

  private startFallback(): void {
    this.stopFallback()
    if (this.options.fallbackTimeoutMs <= 0) return
    this.fallbackTimer = window.setTimeout(() => this.flush('兜底超时'), this.options.fallbackTimeoutMs)
  }

  private startPolling(audio: HTMLMediaElement | null): void {
    if (this.pollTimer !== null || !audio) return
    this.pollTimer = window.setInterval(() => {
      if (this.queue.length === 0) {
        this.stopAll()
        return
      }
      if (this.isHealthy(audio)) this.flush('缓冲健康')
    }, this.options.pollIntervalMs)
  }

  private stopAll(): void {
    this.stopPolling()
    this.stopFallback()
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private stopFallback(): void {
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }

  /** 放行全部排队任务并停止探测。 */
  private flush(reason: string): void {
    const tasks = this.queue
    this.queue = []
    this.stopPolling()
    this.stopFallback()
    if (tasks.length === 0) return
    const waitedMs = this.oldestWaitStart !== null ? Math.round(performance.now() - this.oldestWaitStart) : 0
    this.oldestWaitStart = null
    this.options.debug?.(`[后台门控] ${reason}（等待 ${waitedMs}ms）→ 放行 ${tasks.length} 项：${tasks.map(t => t.label).join('、')}`)
    for (const task of tasks) task.run()
  }

  /** 换曲/停播时调用：清空队列（丢弃未执行的等待任务）并复位状态。 */
  reset(): void {
    const dropped = this.queue.length
    this.queue = []
    this.oldestWaitStart = null
    this.stopPolling()
    this.stopFallback()
    if (dropped > 0) this.options.debug?.(`[后台门控] reset 丢弃 ${dropped} 项等待任务`)
  }

  /** 当前排队任务数（诊断用）。 */
  get pendingCount(): number {
    return this.queue.length
  }
}
