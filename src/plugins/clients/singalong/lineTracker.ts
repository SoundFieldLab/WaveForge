/**
 * 学歌插件 · 逐行跟唱评分器。
 *
 * 职责：把三路数据对齐到歌词时间轴上——
 *   1. 播放进度（PlaybackTimeStore 订阅，秒）；
 *   2. 参照音高（当前行 words 的逐字时间 → 每 100ms 一个期望音高槽；
 *      无逐字词的行退化为「行内有声/无声」二值参照，即只评节奏）；
 *   3. 用户音高（MicPitchTracker 的 PitchSample 流）。
 *
 * 采样策略：行活跃窗口 [line.time - 前拍, line.end + 后拍) 内按 100ms 收槽；
 * 用户音高样本按「槽起始时间对应的播放进度」落位——样本到达时用
 * 「样本墙钟时间 ↔ 进度快照」对齐（进度暂停时冻结落位）。
 *
 * 行结束（进度越过 end + 宽限）时结算 scoreLine() 并回调，随后开始下一行。
 */

import type { LyricLine } from '../../../services/musicApi'
import type { PitchSample } from './micPitchTracker'
import { frequencyToMidi, scoreLine, type LineScore } from './pitch'

/** 行活跃窗口外扩：提前 0.35s 开始采样（吸气起唱），结束后 0.5s 宽限收尾。 */
const WINDOW_HEAD_S = 0.35
const WINDOW_TAIL_S = 0.5
/** 参照音高槽间隔（秒）。 */
const SLOT_S = 0.1

/** 行的逐字参照音高序列（按槽位）。 */
interface LineReference {
  line: LyricLine
  /** 每槽：起始播放时间（秒）+ 该槽期望基频（Hz 或 null=间发声）。 */
  slots: { at: number; frequency: number | null }[]
  /** 行结束时间（秒，含逐字末尾与 endTime 取大）。 */
  end: number
}

/** 结算完成的一行成绩。 */
export interface ScoredLine {
  line: LyricLine
  score: LineScore
}

function lineEnd(line: LyricLine): number {
  let end = line.endTime ?? line.time + 3
  if (line.words && line.words.length > 0) {
    for (const word of line.words) {
      end = Math.max(end, line.time + (word.startTime + word.duration) / 1000)
    }
  }
  return Math.max(end, line.time + 0.5)
}

/**
 * 构建一行的参照音高槽。
 *
 * 有逐字词：每个字取其时间窗中点的基频（字内不分音高变化——流行乐一字多音
 * 极少且 YIN 窗 46ms 本就只给出均值），字间 gap 超过 200ms 的槽置 null。
 * 无逐字词：返回空槽表（只评节奏，音高帧不参与评分）。
 */
export function buildLineReference(line: LyricLine): LineReference {
  const end = lineEnd(line)
  const slots: LineReference['slots'] = []
  if (line.words && line.words.length > 0) {
    for (const word of line.words) {
      if (!word.word || !word.word.trim()) continue
      const start = line.time + word.startTime / 1000
      const duration = Math.max(word.duration, 1) / 1000
      // 字中点采样一个槽；长字（>400ms）再补几个槽，保证长音不只有一个样本点
      const steps = Math.max(1, Math.min(6, Math.round(duration / SLOT_S)))
      for (let i = 0; i < steps; i += 1) {
        slots.push({ at: start + duration * (i + 0.5) / steps, frequency: null })
      }
      // 槽的期望频率此刻未知（原唱实际音高要靠「播放中的曲子」推不出来），
      // 由调用方在运行时按需填充——见 fillReferenceFrequencies 的说明。
    }
  }
  return { line, slots, end }
}

/**
 * 从一组「候选音高」为参照槽填频。
 *
 * ⚠️ 参照音高的来源：本插件无法离线拿到原唱的人声基频（需要人声分离模型），
 * v1 采用「用户设置基准调 key + 旋律轮廓」的轻量替代不可行（无旋律数据），
 * 因此**音准评分只对「开启音高参照」的用户可用**——参照源是该行 words 里的
 * 音高标注（部分 QQ qrc/AMLL TTML 数据自带 melody 音高扩展，WordLike 扩展字段
 * `pitchHz`）。没有音高标注的行自动退化为节奏评分。
 *
 * 这个函数把 (word.pitchHz 扩展) 摊到槽上；没有标注返回 false。
 */
export function fillReferenceFrequencies(reference: LineReference): boolean {
  const words = reference.line.words
  if (!words || words.length === 0) return false
  const withPitch = words.filter(word => {
    const pitch = (word as unknown as { pitchHz?: unknown }).pitchHz
    return typeof pitch === 'number' && pitch > 0
  })
  if (withPitch.length === 0) return false
  let slotIndex = 0
  for (const word of words) {
    // 空字在 buildLineReference 被跳过、不产槽，这里必须同样跳过——
    // 否则空白后面的字会错拿前面字的槽位（音准对错行内错位）。
    if (!word.word || !word.word.trim()) continue
    const steps = Math.max(1, Math.min(6, Math.round(Math.max(word.duration, 1) / 1000 / SLOT_S)))
    const pitch = (word as unknown as { pitchHz?: number }).pitchHz
    for (let i = 0; i < steps && slotIndex < reference.slots.length; i += 1, slotIndex += 1) {
      reference.slots[slotIndex].frequency = typeof pitch === 'number' && pitch > 0 ? pitch : null
    }
  }
  return true
}

export interface LineTrackerCallbacks {
  /** 行结算完成。 */
  onLineScored: (scored: ScoredLine) => void
}

/**
 * 整曲跟唱会话：按播放进度推进当前行，行内收集用户样本，行尾结算。
 * 一次使用 = 一遍从头到尾（seek 会重建会话）。
 */
export class SingAlongTracker {
  private lines: LyricLine[]
  private references: Map<number, LineReference> = new Map()
  private currentIndex = -1
  private userSamples: PitchSample[] = []
  /** 每个样本对应的播放进度（秒，样本到达时由会话填入）。 */
  private sampleTimes: number[] = []
  private lastProgress = 0
  private scored: ScoredLine[] = []
  private callbacks: LineTrackerCallbacks

  constructor(lines: LyricLine[], callbacks: LineTrackerCallbacks) {
    this.lines = lines
    this.callbacks = callbacks
  }

  /** 已结算的成绩（按行序）。 */
  get scoredLines(): readonly ScoredLine[] {
    return this.scored
  }

  get activeIndex(): number {
    return this.currentIndex
  }

  /** 播放进度推进（每帧调用）。返回当前活跃行下标（-1 = 行间）。 */
  update(progressSeconds: number): number {
    this.lastProgress = progressSeconds
    // 找当前行：最后一个 time <= progress 的行；行尾 + 宽限已过则推进下一行
    let index = -1
    for (let i = 0; i < this.lines.length; i += 1) {
      if (this.lines[i].time <= progressSeconds) index = i
      else break
    }
    if (index >= 0) {
      const end = this.ensureReference(index).end
      if (progressSeconds > end + WINDOW_TAIL_S) index = -1
    }
    this.setActiveLine(index)
    return index
  }

  /** 用户音高样本到达：落到当前活跃行（含行头提前窗）的采样带上。 */
  onPitchSample(sample: PitchSample) {
    if (this.currentIndex < 0) return
    const reference = this.ensureReference(this.currentIndex)
    if (this.lastProgress < reference.line.time - WINDOW_HEAD_S || this.lastProgress > reference.end + WINDOW_TAIL_S) return
    this.userSamples.push(sample)
    this.sampleTimes.push(this.lastProgress)
    // 防爆：单行样本上限（超长行也不至于无限增长）
    if (this.userSamples.length > 2000) {
      this.userSamples.splice(0, 500)
      this.sampleTimes.splice(0, 500)
    }
  }

  /** 结算当前行（进度越过行尾 + 宽限时由 update 触发，也可手动提前结算）。 */
  settleActiveLine() {
    if (this.currentIndex < 0) return
    const reference = this.ensureReference(this.currentIndex)
    const line = reference.line

    // 把用户样本对齐到参照槽：每个槽取「槽时间 ±80ms」内样本的音高中位数。
    // 用槽自身的时间（slot.at，字中点分布）而不是均匀网格——无逐字词的行退化为
    // 均匀网格（槽表为空，按 SLOT_S 铺满行窗），有逐字词的行按字的时间走。
    const hasWordSlots = reference.slots.length > 0
    const uniformCount = Math.ceil((reference.end - line.time) / SLOT_S)
    const slotCount = hasWordSlots ? reference.slots.length : uniformCount
    const slotAt = (index: number): number => (hasWordSlots ? reference.slots[index].at : line.time + (index + 0.5) * SLOT_S)
    const userPitches: (number | null)[] = new Array(slotCount).fill(null)
    const targetPitches: (number | null)[] = new Array(slotCount).fill(null)
    const voicedMask: boolean[] = new Array(slotCount).fill(false)
    for (let i = 0; i < slotCount; i += 1) {
      if (hasWordSlots) targetPitches[i] = reference.slots[i].frequency
    }
    let sampleCursor = 0
    for (let i = 0; i < slotCount; i += 1) {
      const at = slotAt(i)
      const collected: number[] = []
      while (sampleCursor < this.sampleTimes.length && this.sampleTimes[sampleCursor] < at - 0.08) sampleCursor += 1
      for (let s = sampleCursor; s < this.sampleTimes.length && this.sampleTimes[s] <= at + 0.08; s += 1) {
        const sample = this.userSamples[s]
        if (sample.frequency != null) collected.push(sample.frequency)
      }
      if (collected.length > 0) {
        collected.sort((a, b) => a - b)
        userPitches[i] = collected[Math.floor(collected.length / 2)]
        voicedMask[i] = true
      }
    }

    const score = scoreLine({ userPitches, targetPitches, voicedMask })
    const scored: ScoredLine = { line, score }
    this.scored.push(scored)
    this.callbacks.onLineScored(scored)
    this.currentIndex = -1
    this.userSamples = []
    this.sampleTimes = []
  }

  /** seek/换歌：丢弃未结算样本，标记重新开始（当前行会随 update 重新激活）。 */
  reset(keepScores: boolean) {
    if (this.currentIndex >= 0) this.settleActiveLine()
    this.currentIndex = -1
    this.userSamples = []
    this.sampleTimes = []
    if (!keepScores) this.scored = []
  }

  private setActiveLine(index: number) {
    if (index === this.currentIndex) return
    // 活跃行变更前结算旧行
    if (this.currentIndex >= 0) this.settleActiveLine()
    this.currentIndex = index
    this.userSamples = []
    this.sampleTimes = []
  }

  private ensureReference(index: number): LineReference {
    let reference = this.references.get(index)
    if (!reference) {
      reference = buildLineReference(this.lines[index])
      fillReferenceFrequencies(reference)
      this.references.set(index, reference)
    }
    return reference
  }
}

/** 参照音高可用性：任何一行有音高标注即返回 true（决定 UI 是否展示音准分）。 */
export function hasAnyPitchReference(lines: LyricLine[]): boolean {
  return lines.some(line =>
    (line.words ?? []).some(word => typeof (word as unknown as { pitchHz?: unknown }).pitchHz === 'number'),
  )
}

/** 调试辅助：midi → 频率（把音高标注写回 words 时用）。 */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

export { frequencyToMidi }
