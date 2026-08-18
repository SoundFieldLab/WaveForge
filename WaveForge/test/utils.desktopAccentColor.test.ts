import { describe, it, expect } from 'vitest'
import { getReadableAccentColor, getReadableDesktopAccentColor } from '../src/utils/desktopAccentColor.ts'

describe('getReadableAccentColor（桌面强调色可读性修正）', () => {
  it('null/undefined/空值返回默认强调色', () => {
    expect(getReadableAccentColor(null)).toBe('#8b5cf6')
    expect(getReadableAccentColor(undefined)).toBe('#8b5cf6')
    expect(getReadableAccentColor('')).toBe('#8b5cf6')
    expect(getReadableAccentColor('   ')).toBe('#8b5cf6')
  })

  it('自定义 fallback 生效', () => {
    expect(getReadableAccentColor(null, '#000000')).toBe('#000000')
  })

  it('低饱和度（灰色）返回 fallback', () => {
    expect(getReadableAccentColor('#808080')).toBe('#8b5cf6')
    expect(getReadableAccentColor('#ffffff')).toBe('#8b5cf6')
    expect(getReadableAccentColor('#fff')).toBe('#8b5cf6')
  })

  it('亮度过低的深色被提亮到可读区间', () => {
    const result = getReadableAccentColor('#6d28d9')
    expect(result).toBe('#8349df')
  })

  it('饱和红色输出为可读版本的红色（色相保持不变）', () => {
    const result = getReadableAccentColor('#ff0000')
    expect(result).toBe('#f63131')
  })

  it('支持 rgb()/rgba() 写法', () => {
    expect(getReadableAccentColor('rgb(100, 200, 50)')).toBe('#7ed454')
    expect(getReadableAccentColor('rgba(10, 20, 250, 0.5)')).toBe('#313af6')
  })

  it('无法解析的颜色返回 fallback', () => {
    expect(getReadableAccentColor('not-a-color')).toBe('#8b5cf6')
  })

  it('getReadableDesktopAccentColor 为同一函数的别名', () => {
    expect(getReadableDesktopAccentColor).toBe(getReadableAccentColor)
    expect(getReadableDesktopAccentColor('#ff0000')).toBe('#f63131')
  })
})
