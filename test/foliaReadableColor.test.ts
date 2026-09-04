import { describe, it, expect } from 'vitest'
import {
  parseHexColor,
  relativeLuminance,
  mixHex,
  resolveReadableThemeColor,
  rgbToHex,
} from '../src/services/foliaReadableColor'

describe('parseHexColor', () => {
  it('解析 #rgb / #rrggbb / rgb()', () => {
    expect(parseHexColor('#a3f')).toEqual({ r: 0xaa, g: 0x33, b: 0xff })
    expect(parseHexColor('#123456')).toEqual({ r: 0x12, g: 0x34, b: 0x56 })
    expect(parseHexColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
  })
  it('无效输入返回 null', () => {
    expect(parseHexColor('not-a-color')).toBeNull()
    expect(parseHexColor('#12')).toBeNull()
    expect(parseHexColor('')).toBeNull()
  })
})

describe('relativeLuminance', () => {
  it('黑白端点', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 5)
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 5)
  })
  it('暗色亮度低、亮色亮度高', () => {
    expect(relativeLuminance({ r: 20, g: 10, b: 40 })).toBeLessThan(0.05)
    expect(relativeLuminance({ r: 200, g: 180, b: 160 })).toBeGreaterThan(0.4)
  })
})

describe('mixHex', () => {
  it('向白混合提亮', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
  })
})

describe('resolveReadableThemeColor', () => {
  it('深色主题：过暗的主题色被提亮到目标亮度', () => {
    const dark = '#1a1030' // 极暗紫
    const result = resolveReadableThemeColor(dark, true)
    const lum = relativeLuminance(parseHexColor(result)!)
    expect(lum).toBeGreaterThanOrEqual(0.4)
    expect(lum).toBeCloseTo(0.42, 1)
  })
  it('深色主题：已经够亮的主题色保持不变', () => {
    const bright = '#8fd3ff' // 亮蓝
    expect(resolveReadableThemeColor(bright, true)).toBe(bright)
  })
  it('浅色主题：过亮的主题色被压暗', () => {
    const light = '#f0f8ff' // 几乎白
    const result = resolveReadableThemeColor(light, false)
    const lum = relativeLuminance(parseHexColor(result)!)
    expect(lum).toBeLessThanOrEqual(0.4)
  })
  it('浅色主题：已经够暗的主题色保持不变', () => {
    const dark = '#3355aa'
    expect(resolveReadableThemeColor(dark, false)).toBe(dark)
  })
  it('无效输入原样返回', () => {
    expect(resolveReadableThemeColor('transparent', true)).toBe('transparent')
    expect(resolveReadableThemeColor('', false)).toBe('')
  })
  it('rgbToHex 往返一致', () => {
    expect(rgbToHex({ r: 0xab, g: 0xcd, b: 0xef })).toBe('#abcdef')
  })
})
