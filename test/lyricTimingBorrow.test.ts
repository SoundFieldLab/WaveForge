import { describe, expect, it } from 'vitest'
import { normalizeLyricText, selectTimingVerifiedLines } from '../src/utils/lyricTimingBorrow'

/** 跨平台借"逐字时间"的校验契约：文本必须一致、时间必须对齐、整体命中率要达标 */
const line = (time: number, text: string, timed = false) => ({
  time,
  text,
  ...(timed ? { words: [{ word: text, startTime: 0, duration: 500 }] } : {}),
})

describe('歌词文本归一化', () => {
  it('忽略空白、标点与符号', () => {
    expect(normalizeLyricText('予定調和の シナリオ、踏み抜いて！')).toBe('予定調和のシナリオ踏み抜いて')
    expect(normalizeLyricText('Hello, world!')).toBe('Helloworld')
    expect(normalizeLyricText(undefined)).toBe('')
  })
})

describe('借逐字时间的安全校验', () => {
  const targets = [
    line(0, '第一句'),
    line(10, '第二句'),
    line(20, '第三句'),
    line(30, '第四句'),
  ]
  const candidatesWithWords = [
    line(0.2, '第一句', true),
    line(10.1, '第二句', true),
    line(19.8, '第三句', true),
    line(30.3, '第四句', true),
  ]

  it('文本一致且时间对齐时按行借用', () => {
    const matched = selectTimingVerifiedLines(targets, candidatesWithWords)
    expect(matched).toHaveLength(4)
  })

  it('文本不一致的行不借（防止词时间挂错句）', () => {
    const mixed = [
      line(0.2, '第一句', true),
      line(10.1, '完全不同的一句话', true),
      line(19.8, '第三句', true),
    ]
    const matched = selectTimingVerifiedLines(targets, mixed)
    // 命中 2/4 低于 50% 下限 → 整首放弃
    expect(matched).toHaveLength(0)
  })

  it('时间偏差超过容差时不借', () => {
    const shifted = [line(0.2, '第一句', true), line(13, '第二句', true), line(19.8, '第三句', true)]
    const matched = selectTimingVerifiedLines(targets, shifted, { tolerance: 0.6 })
    // 第二句差 3s 超出容差 → 只命中 2 行，不足下限
    expect(matched).toHaveLength(0)
  })

  it('同一候选不会被两行重复借用', () => {
    const targets2 = [line(0, '第一句'), line(0.4, '第一句')]
    const matched = selectTimingVerifiedLines(targets2, [line(0.1, '第一句', true)], { minHits: 1, minRatio: 0 })
    expect(matched).toHaveLength(1)
  })

  it('已带逐字的行不再参与借入', () => {
    const withTiming = [line(0, '第一句', true), line(10, '第二句'), line(20, '第三句'), line(30, '第四句')]
    const matched = selectTimingVerifiedLines(withTiming, candidatesWithWords, { minHits: 1, minRatio: 0 })
    expect(matched).toHaveLength(3)
  })

  it('候选没有词级时间时不借', () => {
    const noTiming = [line(0, '第一句'), line(10, '第二句'), line(20, '第三句')]
    expect(selectTimingVerifiedLines(targets, noTiming)).toHaveLength(0)
  })
})
