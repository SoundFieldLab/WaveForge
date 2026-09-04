import { describe, it, expect } from 'vitest'
import { parseStoredBoolean, parseStoredArray } from '../src/utils/storage.ts'

describe('parseStoredBoolean（存储布尔值解析）', () => {
  it('null 返回 fallback', () => {
    expect(parseStoredBoolean(null, true)).toBe(true)
    expect(parseStoredBoolean(null, false)).toBe(false)
  })

  it('合法布尔字符串解析为对应值', () => {
    expect(parseStoredBoolean('true', false)).toBe(true)
    expect(parseStoredBoolean('false', true)).toBe(false)
  })

  it('非布尔 JSON 值（数字/字符串/对象）回退到 fallback', () => {
    expect(parseStoredBoolean('1', false)).toBe(false)
    expect(parseStoredBoolean('"true"', false)).toBe(false) // JSON 字符串不是布尔
    expect(parseStoredBoolean('{"a":1}', true)).toBe(true)
  })

  it('非法 JSON 回退到 fallback', () => {
    expect(parseStoredBoolean('garbage', true)).toBe(true)
    expect(parseStoredBoolean('', false)).toBe(false)
  })
})

describe('parseStoredArray（存储数组解析）', () => {
  it('空值返回空数组', () => {
    expect(parseStoredArray(null)).toEqual([])
    expect(parseStoredArray('')).toEqual([])
  })

  it('合法 JSON 数组返回对应元素', () => {
    expect(parseStoredArray('["a","b"]')).toEqual(['a', 'b'])
    expect(parseStoredArray('[1,2,3]')).toEqual([1, 2, 3])
  })

  it('非数组 JSON 返回空数组', () => {
    expect(parseStoredArray('42')).toEqual([])
    expect(parseStoredArray('{"a":1}')).toEqual([])
  })

  it('非法 JSON 返回空数组', () => {
    expect(parseStoredArray('not json at all')).toEqual([])
  })
})
