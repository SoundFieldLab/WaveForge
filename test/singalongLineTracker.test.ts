/**
 * 学歌插件行跟踪器单测：参照槽构建、样本落位、行结算、重置语义。
 */
import { describe, expect, it } from 'vitest'
import type { LyricLine } from '../src/services/musicApi'
import {
  SingAlongTracker,
  buildLineReference,
  fillReferenceFrequencies,
  hasAnyPitchReference,
  midiToFrequency,
} from '../src/plugins/clients/singalong/lineTracker'
import type { ScoredLine } from '../src/plugins/clients/singalong/lineTracker'

function lineWithWords(partial: Partial<LyricLine>): LyricLine {
  return {
    time: 10,
    text: '测试歌词',
    ...partial,
  } as LyricLine
}

describe('buildLineReference', () => {
  it('无逐字词的行：空槽表，end 用 endTime', () => {
    const line = lineWithWords({ time: 10, endTime: 14 })
    const reference = buildLineReference(line)
    expect(reference.slots).toHaveLength(0)
    expect(reference.end).toBe(14)
  })

  it('有逐字词：按字时长生成槽（≈10 槽/秒，长字封顶 6），end 不早于最后一个字的结束', () => {
    const line = lineWithWords({
      time: 10,
      endTime: 12,
      words: [
        { word: '你', startTime: 0, duration: 500 },
        { word: '好', startTime: 500, duration: 900 },
      ],
    })
    const reference = buildLineReference(line)
    // 500ms → 5 槽；900ms → 6 槽（封顶）
    expect(reference.slots.length).toBe(11)
    // end = max(endTime=12, 逐字末尾 11.4) = 12
    expect(reference.end).toBe(12)
    // 槽时间在各自字窗内
    expect(reference.slots[0].at).toBeGreaterThan(10)
    expect(reference.slots[0].at).toBeLessThan(10.5)
  })
})

describe('fillReferenceFrequencies', () => {
  it('words 带 pitchHz 扩展时填充槽频率并返回 true', () => {
    const line = lineWithWords({
      time: 10,
      words: [
        { word: '啦', startTime: 0, duration: 400, pitchHz: 440 },
        { word: '啦', startTime: 400, duration: 400 },
      ],
    })
    const reference = buildLineReference(line)
    const filled = fillReferenceFrequencies(reference)
    expect(filled).toBe(true)
    // 第一个字（4 槽）全部填上 440
    for (let i = 0; i < 4; i += 1) expect(reference.slots[i].frequency).toBe(440)
    // 第二个字没有标注 → 槽为 null
    expect(reference.slots[4].frequency).toBeNull()
  })

  it('全无标注返回 false', () => {
    const line = lineWithWords({
      time: 10,
      words: [{ word: '啊', startTime: 0, duration: 400 }],
    })
    const reference = buildLineReference(line)
    expect(fillReferenceFrequencies(reference)).toBe(false)
  })
})

describe('SingAlongTracker', () => {
  const lines: LyricLine[] = [
    lineWithWords({ time: 10, endTime: 12, text: '第一句' }),
    lineWithWords({ time: 14, endTime: 16, text: '第二句' }),
  ]

  function makeTracker(onLineScored: (scored: ScoredLine) => void = () => undefined) {
    return new SingAlongTracker(lines, { onLineScored })
  }

  it('update：进度在第一行窗口内返回行 0，行尾+宽限后返回 -1', () => {
    const tracker = makeTracker()
    expect(tracker.update(10.5)).toBe(0)
    expect(tracker.update(11.5)).toBe(0)
    // end=12 + 0.5 宽限 = 12.5 之后退出活跃
    expect(tracker.update(12.51)).toBe(-1)
  })

  it('update：进度到第二行返回行 1', () => {
    const tracker = makeTracker()
    expect(tracker.update(14.2)).toBe(1)
  })

  it('样本落位与结算：唱满第一行 → 得到一行成绩', () => {
    const scored: ScoredLine[] = []
    const tracker = makeTracker(s => scored.push(s))
    tracker.update(10.0)
    // 用户音高样本：每 100ms 一个，对齐参照槽（无逐字词 → 只评节奏）
    for (let i = 0; i < 20; i += 1) {
      tracker.update(10 + i * 0.1)
      tracker.onPitchSample({ at: performance.now(), frequency: 440, rms: 0.2 })
    }
    tracker.update(12.6) // 越过行尾+宽限 → 自动结算
    expect(scored).toHaveLength(1)
    expect(scored[0].line.text).toBe('第一句')
    // 行窗 10-12s 铺 20 个槽，唱满 10.0-11.9 → 全部槽开口 → 节奏 100
    expect(scored[0].score.rhythm).toBe(100)
  })

  it('只唱行窗前半：节奏分按开口覆盖折算（漏唱扣分）', () => {
    const scored: ScoredLine[] = []
    const tracker = makeTracker(s => scored.push(s))
    tracker.update(10.0)
    for (let i = 0; i < 10; i += 1) {
      tracker.update(10 + i * 0.1)
      tracker.onPitchSample({ at: performance.now(), frequency: 440, rms: 0.2 })
    }
    tracker.update(12.6)
    expect(scored).toHaveLength(1)
    expect(scored[0].score.rhythm).toBe(50)
  })

  it('没唱：结算出零分成绩', () => {
    const scored: ScoredLine[] = []
    const tracker = makeTracker(s => scored.push(s))
    tracker.update(10.2)
    tracker.update(12.6)
    expect(scored).toHaveLength(1)
    expect(scored[0].score.total).toBe(0)
  })

  it('reset(false) 清空成绩，reset(true) 保留已结算行', () => {
    const scored: ScoredLine[] = []
    const tracker = makeTracker(s => scored.push(s))
    tracker.update(10.2)
    tracker.update(12.6)
    expect(tracker.scoredLines).toHaveLength(1)
    tracker.reset(true)
    expect(tracker.scoredLines).toHaveLength(1)
    tracker.reset(false)
    expect(tracker.scoredLines).toHaveLength(0)
  })

  it('行切换时自动结算上一行', () => {
    const scored: ScoredLine[] = []
    const tracker = makeTracker(s => scored.push(s))
    tracker.update(10.5)
    tracker.update(14.2) // 第一行已过宽限 → 结算后进入第二行
    expect(scored).toHaveLength(1)
    expect(tracker.activeIndex).toBe(1)
  })
})

describe('hasAnyPitchReference / midiToFrequency', () => {
  it('有 pitchHz 标注返回 true', () => {
    expect(hasAnyPitchReference([
      lineWithWords({ words: [{ word: 'x', startTime: 0, duration: 100, pitchHz: 440 }] }),
    ])).toBe(true)
    expect(hasAnyPitchReference([
      lineWithWords({ words: [{ word: 'x', startTime: 0, duration: 100 }] }),
    ])).toBe(false)
  })

  it('midiToFrequency：A4(69) = 440Hz', () => {
    expect(midiToFrequency(69)).toBeCloseTo(440, 6)
    expect(midiToFrequency(60)).toBeCloseTo(261.63, 2)
  })
})
