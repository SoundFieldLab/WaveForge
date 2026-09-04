/**
 * WaveForge 音频效果引擎 v3 —— 听力分析流程（HearingTest）
 *
 * 出处/许可：自研状态机（设计文档 §4.8 / 映射表 #13 🟡，流程参考临床听力测试的
 *   "升降法/二分法"阈值估计；特征统计配合 meyda(MIT) 式特征，技术文档 §12）。
 *
 * 契约（API_SPEC 小节 F）：频点 125/250/500/1000/2000/4000/8000 Hz，
 *   电平 -60..0 dB，每频点二分 5 轮逼近听阈；阈值估计 = 最终二分区间中点。
 * 本文件只实现流程状态机（播放/合成由调用方按 nextStep 返回的电平进行），
 * 因此确定性（无随机、无 Date、无 I/O），同回答序列必得同听阈曲线。
 */

export interface AudiogramPoint {
  freqHz: number
  thresholdDb: number
}

/** 测试频点（Hz），按 API_SPEC 契约 7 频点 */
export const HEARING_TEST_FREQUENCIES = [125, 250, 500, 1000, 2000, 4000, 8000] as const
/** 电平下限 dB */
export const HEARING_LO_DB = -60
/** 电平上限 dB */
export const HEARING_HI_DB = 0
/** 每频点二分轮数 */
export const HEARING_ROUNDS = 5

export class HearingTest {
  private readonly freqCount = HEARING_TEST_FREQUENCIES.length
  private freqIndex = 0
  private round = 0
  private lo = HEARING_LO_DB
  private hi = HEARING_HI_DB
  private pendingLevel: number | null = null
  private thresholds: AudiogramPoint[] = []
  private started = false
  private done = false

  constructor(fs: number) {
    // fs 用于校验采样率合法性（约定：fs<=0 抛错）；状态机本身不依赖其数值
    if (!(fs > 0)) throw new Error('invalid sample rate')
  }

  /** 开始新一轮完整测试（重置所有状态） */
  begin(): void {
    this.started = true
    this.done = false
    this.freqIndex = 0
    this.round = 0
    this.lo = HEARING_LO_DB
    this.hi = HEARING_HI_DB
    this.pendingLevel = null
    this.thresholds = []
  }

  /**
   * 返回当前测试步骤（频率 + 播放电平 dB）；全部完成或未 begin 时返回 null。
   * 重复调用（未 answer）幂等返回同一待测步骤。
   */
  nextStep(): { freqHz: number; levelDb: number } | null {
    if (!this.started || this.done) return null
    if (this.pendingLevel !== null) {
      return { freqHz: HEARING_TEST_FREQUENCIES[this.freqIndex], levelDb: this.pendingLevel }
    }
    // 新频点首轮：取当前二分区间中点（首频点初值 = (lo+hi)/2 = -30dB）
    const level = (this.lo + this.hi) / 2
    this.pendingLevel = level
    return { freqHz: HEARING_TEST_FREQUENCIES[this.freqIndex], levelDb: level }
  }

  /**
   * 用户回答是否听到当前步骤的声音（二分逼近阈值）。
   * 无待测步骤时为安全空操作。第 HEARING_ROUNDS 轮后记录该频点阈值并切换到下一频点。
   */
  answer(heard: boolean): void {
    if (!this.started || this.done || this.pendingLevel === null) return
    const level = this.pendingLevel
    if (heard) this.hi = level
    else this.lo = level
    this.round++
    this.pendingLevel = null
    if (this.round >= HEARING_ROUNDS) {
      // 收敛：阈值估计取最终二分区间中点（分辨率 60/2^5 ≈ 1.875 dB）
      this.thresholds.push({
        freqHz: HEARING_TEST_FREQUENCIES[this.freqIndex],
        thresholdDb: (this.lo + this.hi) / 2,
      })
      this.freqIndex++
      this.round = 0
      this.lo = HEARING_LO_DB
      this.hi = HEARING_HI_DB
      if (this.freqIndex >= this.freqCount) this.done = true
    }
  }

  /** 当前频点序号（0 起；供 UI 进度显示） */
  getFreqIndex(): number {
    return this.freqIndex
  }

  /** 当前频点内二分轮数（0 起；供 UI 进度显示） */
  getRound(): number {
    return this.round
  }

  /** 是否已开始 */
  isStarted(): boolean {
    return this.started
  }

  /** 是否全部完成 */
  isDone(): boolean {
    return this.done
  }

  /** 已完成的听阈曲线（按频点顺序；返回副本） */
  getAudiogram(): AudiogramPoint[] {
    return this.thresholds.map((t) => ({ ...t }))
  }

  /** 重置为未开始状态 */
  reset(): void {
    this.started = false
    this.done = false
    this.freqIndex = 0
    this.round = 0
    this.lo = HEARING_LO_DB
    this.hi = HEARING_HI_DB
    this.pendingLevel = null
    this.thresholds = []
  }
}