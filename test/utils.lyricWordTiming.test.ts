import { describe, it, expect } from 'vitest'
import {
  normalizeSequentialWordTiming,
  restoreLyricWordSpacing,
  hasTrueWordTiming,
  buildTimedLyricGlyphs,
  buildProgressiveLyricGlyphs,
} from '../src/utils/lyricWordTiming.ts'

describe('normalizeSequentialWordTiming（逐字歌词时序归一化）', () => {
  it('已有序的时序保持不变', () => {
    const input = [
      { word: '我', startTime: 0, duration: 400 },
      { word: '爱', startTime: 500, duration: 400 },
      { word: '你', startTime: 1000, duration: 400 },
    ]
    expect(normalizeSequentialWordTiming(input)).toEqual(input)
  })

  it('乱序时序被重排为严格递增', () => {
    const result = normalizeSequentialWordTiming([
      { word: '你', startTime: 1000, duration: 400 },
      { word: '好', startTime: 500, duration: 400 },
      { word: '啊', startTime: 0, duration: 400 },
    ])
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i].startTime).toBeGreaterThan(result[i - 1].startTime)
    }
    // 首字保留原始时间，不强制归零
    expect(result[0].startTime).toBe(1000)
    // 逐字可见字之间以最小 140ms 兜底间隔分隔
    expect(result[1].startTime - result[0].startTime).toBeGreaterThanOrEqual(140)
  })

  it('空数组原样返回', () => {
    expect(normalizeSequentialWordTiming([])).toEqual([])
  })

  it('空白字被移动到前一字结束位置', () => {
    const result = normalizeSequentialWordTiming([
      { word: '我', startTime: 0, duration: 400 },
      { word: ' ', startTime: 500, duration: 100 },
      { word: '爱', startTime: 600, duration: 400 },
    ])
    const space = result.find(token => token.word === ' ')
    expect(space).toEqual({ word: ' ', startTime: 400, duration: 0 })
  })
})

describe('restoreLyricWordSpacing（恢复行内空格）', () => {
  it('行文本含空格而逐字词缺失时插入空格 token', () => {
    const result = restoreLyricWordSpacing(
      [
        { word: '你', startTime: 0, duration: 400 },
        { word: '好', startTime: 500, duration: 400 },
      ],
      '你 好',
    )
    expect(result).toEqual([
      { word: '你', startTime: 0, duration: 400 },
      { word: ' ', startTime: 400, duration: 0 },
      { word: '好', startTime: 500, duration: 400 },
    ])
  })

  it('行文本无空格时不插入', () => {
    const result = restoreLyricWordSpacing(
      [
        { word: '你', startTime: 0, duration: 400 },
        { word: '好', startTime: 500, duration: 400 },
      ],
      '你好',
    )
    expect(result.map(token => token.word)).toEqual(['你', '好'])
  })
})

describe('hasTrueWordTiming（是否具备真实逐字时间轴）', () => {
  it('多个带正时长的词为 true', () => {
    expect(hasTrueWordTiming({
      text: '你好',
      words: [
        { word: '你', startTime: 0, duration: 300 },
        { word: '好', startTime: 300, duration: 300 },
      ],
    })).toBe(true)
  })

  it('时长全为 0 时为 false', () => {
    expect(hasTrueWordTiming({
      text: '你好',
      words: [
        { word: '你', startTime: 0, duration: 0 },
        { word: '好', startTime: 0, duration: 0 },
      ],
    })).toBe(false)
  })

  it('无逐字词时为 false', () => {
    expect(hasTrueWordTiming({ text: '你好' })).toBe(false)
  })

  it('单个多字词（无法切分字形）为 false', () => {
    expect(hasTrueWordTiming({
      text: '世界',
      words: [{ word: '世界', startTime: 0, duration: 500 }],
    })).toBe(false)
  })

  it('单个单字词为 true', () => {
    expect(hasTrueWordTiming({
      text: '你',
      words: [{ word: '你', startTime: 0, duration: 500 }],
    })).toBe(true)
  })
})

describe('buildTimedLyricGlyphs（逐字歌词字形构建）', () => {
  it('按逐字时间轴生成字形，时间基于行时间偏移', () => {
    const glyphs = buildTimedLyricGlyphs({
      time: 10,
      text: '你好',
      words: [
        { word: '你', startTime: 0, duration: 1000 },
        { word: '好', startTime: 1000, duration: 1000 },
      ],
    })
    expect(glyphs).toEqual([
      { text: '你', startTime: 10, endTime: 11, wordIndex: 0, glyphIndex: 0, isWhitespace: false },
      { text: '好', startTime: 11, endTime: 12, wordIndex: 1, glyphIndex: 0, isWhitespace: false },
    ])
  })

  it('无真实逐字时间轴时返回空数组', () => {
    expect(buildTimedLyricGlyphs({ time: 10, text: '你好' })).toEqual([])
  })
})

describe('buildProgressiveLyricGlyphs（渐进歌词字形构建）', () => {
  it('无逐字时间轴时按可见字数均分兜底时长', () => {
    const glyphs = buildProgressiveLyricGlyphs({ time: 5, text: '你好' })
    // 兜底时长 = max(2.1, 1.45 + 2*0.115) = 2.1s，均分给 2 个字形
    expect(glyphs).toEqual([
      { text: '你', startTime: 5, endTime: 6.05, wordIndex: 0, glyphIndex: 0, isWhitespace: false },
      { text: '好', startTime: 6.05, endTime: 7.1, wordIndex: 0, glyphIndex: 1, isWhitespace: false },
    ])
  })

  it('空文本返回空数组', () => {
    expect(buildProgressiveLyricGlyphs({ time: 0, text: '' })).toEqual([])
  })

  it('纯空白文本返回空数组', () => {
    expect(buildProgressiveLyricGlyphs({ time: 0, text: '   ' })).toEqual([])
  })

  it('有真实逐字时间轴时优先返回逐字字形', () => {
    const glyphs = buildProgressiveLyricGlyphs({
      time: 1,
      text: '你好',
      words: [
        { word: '你', startTime: 0, duration: 500 },
        { word: '好', startTime: 500, duration: 500 },
      ],
    })
    expect(glyphs).toEqual([
      { text: '你', startTime: 1, endTime: 1.5, wordIndex: 0, glyphIndex: 0, isWhitespace: false },
      { text: '好', startTime: 1.5, endTime: 2, wordIndex: 1, glyphIndex: 0, isWhitespace: false },
    ])
  })
})
