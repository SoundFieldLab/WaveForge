import { describe, expect, it } from 'vitest'
import {
  AMLL_DARK_MASK_ALPHA,
  buildLineBandMask,
  charEmphasizeDelay,
  charFloatYEm,
  computeEmphasizeParams,
  computeSungRatio,
  emphasizeCharFrame,
  emphasizeEasing,
  generateFadeGradient,
  shouldEmphasizeWord,
} from '../src/utils/amllEmphasize'

/** AM 版长音强调与逐字光带的算法契约（参数照搬 AMLL core） */
describe('长音强调触发条件（AMLL shouldEmphasize）', () => {
  it('CJK 字：唱满 1000ms 触发，差 1ms 不触发', () => {
    expect(shouldEmphasizeWord({ word: '花', startTime: 0, duration: 1000 })).toBe(true)
    expect(shouldEmphasizeWord({ word: '花', startTime: 0, duration: 999 })).toBe(false)
  })

  it('非 CJK：需 1000ms 且长度 2~7', () => {
    expect(shouldEmphasizeWord({ word: 'golden', startTime: 0, duration: 1200 })).toBe(true)
    expect(shouldEmphasizeWord({ word: 'a', startTime: 0, duration: 1200 })).toBe(false)
    expect(shouldEmphasizeWord({ word: 'abcdefgh', startTime: 0, duration: 1200 })).toBe(false)
    expect(shouldEmphasizeWord({ word: 'hour', startTime: 0, duration: 1000 })).toBe(true)
  })

  it('空白词不触发', () => {
    expect(shouldEmphasizeWord({ word: '   ', startTime: 0, duration: 2000 })).toBe(false)
  })
})

describe('强调参数（AMLL calculateEmphasizeParams）', () => {
  it('时长下限 1000ms，行末词幅度加强', () => {
    const plain = computeEmphasizeParams(400, 0, 3, false)
    const last = computeEmphasizeParams(400, 0, 3, true)
    expect(plain.du).toBe(1000)
    expect(last.du).toBeGreaterThan(plain.du)
    expect(last.amount).toBeGreaterThan(plain.amount)
    expect(last.blur).toBeGreaterThan(plain.blur)
  })

  it('amount / blur 有上限（1.2 / 0.8）', () => {
    const long = computeEmphasizeParams(20000, 0, 2, true)
    expect(long.amount).toBeLessThanOrEqual(1.2)
    expect(long.blur).toBeLessThanOrEqual(0.8)
  })

  it('字符错落：同一词内越靠后的字延迟越大', () => {
    const params = computeEmphasizeParams(2000, 100, 4, false)
    const delays = [0, 1, 2, 3].map(i => charEmphasizeDelay(params, i))
    expect(delays[0]).toBe(100)
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1])
  })
})

describe('缓动与帧值', () => {
  it('缓动是脉冲：起点与终点都回到无强调，中段达到峰值（与 AMLL 一致）', () => {
    expect(emphasizeEasing(0)).toBeCloseTo(0, 5)
    expect(emphasizeEasing(1)).toBeCloseTo(0, 5)
    expect(emphasizeEasing(0.5)).toBeGreaterThan(0.9)
    expect(emphasizeEasing(0.2)).toBeLessThan(emphasizeEasing(0.5))
  })

  it('脉冲结束后字回到原始状态', () => {
    const params = computeEmphasizeParams(2000, 0, 2, false)
    const ended = emphasizeCharFrame(params, 0, 2, params.du * 1.5)
    expect(ended.glowAlpha).toBeCloseTo(0, 5)
    expect(ended.scale).toBeCloseTo(1, 5)
  })

  it('帧值：开头无辉光，中途有辉光且缩放 > 1', () => {
    const params = computeEmphasizeParams(2000, 0, 2, false)
    const start = emphasizeCharFrame(params, 0, 2, 0)
    expect(start.glowAlpha).toBeCloseTo(0, 5)
    expect(start.scale).toBeCloseTo(1, 5)

    const middle = emphasizeCharFrame(params, 0, 2, 900)
    expect(middle.glowAlpha).toBeGreaterThan(0)
    expect(middle.scale).toBeGreaterThan(1)
    expect(middle.glowEm).toBeLessThanOrEqual(0.3)
  })

  it('上浮动画在起点与终点均为 0，中途为负（向上）', () => {
    const params = computeEmphasizeParams(2000, 0, 2, false)
    expect(charFloatYEm(params, 0)).toBeCloseTo(0, 5)
    expect(charFloatYEm(params, params.du * 0.7)).toBeLessThan(0)
    expect(charFloatYEm(params, params.du * 1.4)).toBeCloseTo(0, 5)
  })
})

describe('逐字光带', () => {
  it('渐变采用两档 alpha（已唱 1 / 未唱 0.4）', () => {
    const [gradient, totalAspect] = generateFadeGradient(0.5)
    expect(gradient).toContain('rgb(0 0 0 / 1)')
    expect(gradient).toContain(`rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA})`)
    expect(totalAspect).toBeCloseTo(2.5, 5)
  })

  it('整行遮罩随已唱比例推进，且带 em 羽化边界', () => {
    const early = buildLineBandMask(0.1)
    const late = buildLineBandMask(0.8)
    expect(early).toContain('10.00%')
    expect(late).toContain('80.00%')
    expect(early).toContain('em)')
  })

  it('已唱比例：全未唱 0、全唱完 1、半唱居中', () => {
    const words = [
      { word: 'ab', startTime: 0, duration: 1000 },
      { word: 'cd', startTime: 1000, duration: 1000 },
    ]
    expect(computeSungRatio(words, -100)).toBe(0)
    expect(computeSungRatio(words, 5000)).toBe(1)
    expect(computeSungRatio(words, 1500)).toBeCloseTo(0.75, 5)
  })
})
