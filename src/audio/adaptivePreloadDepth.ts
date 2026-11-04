/**
 * 自适应预载深度（连切感知）。
 *
 * 用户连续快速切歌 = 想快速换歌，当前曲在队列里的停留时间极短，
 * 2 首预载窗口来不及覆盖他即将跳到的位置；此时把预载深度提到 3，
 * 让第 3 首的歌词/封面/音频 URL/MV 预热提前就位，连切全程零等待。
 *
 * 策略（经验调参，避免过度预载浪费带宽）：
 * - 60s 滚动窗口内 ≥2 次手动切歌 → 进入 fast-browsing，深度 3；
 * - 120s 无切歌 → 自动回落深度 2（用户回到正常聆听节奏）；
 * - 自动连播/过渡引擎触发的切歌不计入（那不是用户在"找歌"）。
 *
 * 纯逻辑、无 DOM 依赖，可单测。
 */

const SKIP_WINDOW_MS = 60_000
/** 窗口内达到该切歌次数进入快速换歌模式 */
const FAST_BROWSE_SKIP_THRESHOLD = 2
/** 无切歌多久后回落到常规深度 */
const FAST_BROWSE_DECAY_MS = 120_000

export const BASE_PRELOAD_DEPTH = 2
export const FAST_BROWSE_PRELOAD_DEPTH = 3

export class AdaptivePreloadDepth {
  private skipTimestamps: number[] = []
  private fastBrowseUntil = 0

  /** 用户手动切歌（下一首/上一首/点选队列歌曲）时调用。 */
  recordManualSkip(now: number = Date.now()): void {
    this.skipTimestamps = this.skipTimestamps.filter(ts => now - ts < SKIP_WINDOW_MS)
    this.skipTimestamps.push(now)
    if (this.skipTimestamps.length >= FAST_BROWSE_SKIP_THRESHOLD) {
      this.fastBrowseUntil = now + FAST_BROWSE_DECAY_MS
    }
  }

  /** 是否处于快速换歌模式（影响预载深度）。 */
  isFastBrowsing(now: number = Date.now()): boolean {
    // 窗口外的旧记录顺手清理，防长会话积内存
    if (this.skipTimestamps.length > 0 && now - this.skipTimestamps[this.skipTimestamps.length - 1] >= SKIP_WINDOW_MS) {
      this.skipTimestamps = this.skipTimestamps.filter(ts => now - ts < SKIP_WINDOW_MS)
    }
    return now < this.fastBrowseUntil
  }

  /** 当前应使用的预载深度（2 或 3）。 */
  currentDepth(now: number = Date.now()): number {
    return this.isFastBrowsing(now) ? FAST_BROWSE_PRELOAD_DEPTH : BASE_PRELOAD_DEPTH
  }

  /** 测试/换会话复位。 */
  reset(): void {
    this.skipTimestamps = []
    this.fastBrowseUntil = 0
  }
}
