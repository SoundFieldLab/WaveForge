import { describe, it, expect } from 'vitest'
import { reconcileBoundaryParentheses } from '../src/utils/lyricBoundaryParentheses.ts'

describe('reconcileBoundaryParentheses（歌词边界括号补全）', () => {
  it('空文本或空 token 时原样返回（复制）', () => {
    expect(reconcileBoundaryParentheses('', [{ word: 'a', startTime: 0, duration: 0 }]))
      .toEqual([{ word: 'a', startTime: 0, duration: 0 }])
    expect(reconcileBoundaryParentheses('(a)', [])).toEqual([])
  })

  it('补齐缺失的左括号，时间从 0 开始、时长为 0', () => {
    const result = reconcileBoundaryParentheses('(你好', [
      { word: '你好', startTime: 0, duration: 100 },
    ])
    expect(result).toEqual([
      { word: '(', startTime: 0, duration: 0 },
      { word: '你好', startTime: 0, duration: 100 },
    ])
  })

  it('补齐缺失的右括号，紧随最后 token 之后', () => {
    const result = reconcileBoundaryParentheses('你好)', [
      { word: '你好', startTime: 50, duration: 100 },
    ])
    expect(result).toEqual([
      { word: '你好', startTime: 50, duration: 100 },
      { word: ')', startTime: 150, duration: 0 },
    ])
  })

  it('支持中文全角括号', () => {
    const result = reconcileBoundaryParentheses('（你好）', [
      { word: '你好', startTime: 0, duration: 200 },
    ])
    expect(result).toEqual([
      { word: '（', startTime: 0, duration: 0 },
      { word: '你好', startTime: 0, duration: 200 },
      { word: '）', startTime: 200, duration: 0 },
    ])
  })

  it('两侧括号同时缺失时都补齐', () => {
    const result = reconcileBoundaryParentheses('(你好)', [
      { word: '你好', startTime: 10, duration: 300 },
    ])
    expect(result).toEqual([
      { word: '(', startTime: 0, duration: 0 },
      { word: '你好', startTime: 10, duration: 300 },
      { word: ')', startTime: 310, duration: 0 },
    ])
  })

  it('括号已存在时不重复补齐', () => {
    const result = reconcileBoundaryParentheses('(你好)', [
      { word: '(', startTime: 0, duration: 0 },
      { word: '你好', startTime: 0, duration: 100 },
      { word: ')', startTime: 100, duration: 0 },
    ])
    expect(result).toEqual([
      { word: '(', startTime: 0, duration: 0 },
      { word: '你好', startTime: 0, duration: 100 },
      { word: ')', startTime: 100, duration: 0 },
    ])
  })

  it('仅行文本有多余括号时按数量差额补齐', () => {
    const result = reconcileBoundaryParentheses('((你好))', [
      { word: '你好', startTime: 0, duration: 50 },
    ])
    expect(result).toEqual([
      { word: '(', startTime: 0, duration: 0 },
      { word: '(', startTime: 0, duration: 0 },
      { word: '你好', startTime: 0, duration: 50 },
      { word: ')', startTime: 50, duration: 0 },
      { word: ')', startTime: 50, duration: 0 },
    ])
  })

  it('行内其他位置的括号不受影响', () => {
    const result = reconcileBoundaryParentheses('(副歌(高音))', [
      { word: '副歌', startTime: 0, duration: 100 },
    ])
    // 只补最外层缺失的括号；内部括号保持原样
    expect(result[0]).toEqual({ word: '(', startTime: 0, duration: 0 })
    expect(result[result.length - 1]).toEqual({ word: ')', startTime: 100, duration: 0 })
    // 缺失 1 个左括号 + 2 个右括号，加上原 token 共 4 项
    expect(result.length).toBe(4)
    expect(result.map(token => token.word)).toEqual(['(', '副歌', ')', ')'])
  })
})
