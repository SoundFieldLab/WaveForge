import { describe, expect, it } from 'vitest'
import {
  AMLL_DARK_MASK_ALPHA,
  bandMaskForProgress,
  charEmphasizeDelay,
  charFloatYEm,
  computeEmphasizeParams,
  computeSungRatio,
  computeWordRanges,
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

  it('逐词遮罩随局部进度推进（换行时按阅读顺序，不再各行独立填充）', () => {
    const early = bandMaskForProgress(0.1)
    const late = bandMaskForProgress(0.8)
    expect(early).not.toBe(late)
    // 光带位置随进度右移：相位 10% 时亮区止于 2%，相位 80% 时止于 72%
    expect(early).toContain('2.00%')
    expect(late).toContain('72.00%')
    // 进度 0 整词暗档、进度 1 整词亮档
    expect(bandMaskForProgress(0)).toBe(`linear-gradient(to right, rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA}) 0%, rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA}) 100%)`)
    expect(bandMaskForProgress(1)).toBe('linear-gradient(to right, rgb(0 0 0 / 1) 0%, rgb(0 0 0 / 1) 100%)')
  })

  /**
   * 回归：进度为 0 时**不允许**出现任何亮档。
   *
   * 旧实现只写两个色标（`亮 start%, 暗 end%`），CSS 会把首个色标向左延伸，
   * 于是进度 0 时渐变最左侧仍是满亮——表现为"还没到填充时间，词首那个字已经亮了一点"。
   * 渐变必须写满四个色标才能让 0 进度整词恒为暗档。
   */
  it('进度为 0 时整词全暗（首字不提前点亮）', () => {
    expect(bandMaskForProgress(0)).not.toContain('rgb(0 0 0 / 1)')
  })

  it('进度推进时亮区从 0 起、暗区收在 100% 之前（羽化只在前沿）', () => {
    const mask = bandMaskForProgress(0.5)
    expect(mask).toContain('rgb(0 0 0 / 1) 0%')
    expect(mask).toContain('rgb(0 0 0 / 1) 42.00%')
    expect(mask).toContain(`rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA}) 50.00%`)
    expect(mask.trim().endsWith('100%)')).toBe(true)
  })

  it('进度极小（0.001）时亮区宽度也极小（首字不会明显提前亮）', () => {
    const mask = bandMaskForProgress(0.001)
    // 亮区止于 0.0008*100≈0.08% → 格式化为 0.08%，肉眼不可见
    expect(mask).toContain('rgb(0 0 0 / 1) 0.00%')
    expect(mask).toContain('rgb(0 0 0 / 0.4) 0.10%')
  })

  it('词区间按字符数累计：首词从 0 起、末词到 1（换行不影响阅读顺序）', () => {
    const ranges = computeWordRanges([{ word: 'ab' }, { word: 'cd' }, { word: 'ef' }])
    expect(ranges[0].start).toBeCloseTo(0, 5)
    expect(ranges[0].end).toBeCloseTo(1 / 3, 5)
    expect(ranges[2].end).toBeCloseTo(1, 5)
    // 空白词不占进度
    const withSpace = computeWordRanges([{ word: 'ab' }, { word: ' ' }, { word: 'cd' }])
    expect(withSpace[1].chars).toBe(0)
    expect(withSpace[1].start).toBeCloseTo(withSpace[1].end, 5)
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

  /**
   * 回归：空白词的权重必须与 computeWordRanges 一致（都按 0 计）。
   * 若这里把空白词算作 1 个字符，整句进度会快于实际演唱，
   * 表现为每句刚开头就有"已经唱了一点"的提前填充。
   */
  it('空白词不计权重（与词区间算法一致）', () => {
    const withSpace = [
      { word: 'ab', startTime: 0, duration: 1000 },
      { word: '   ', startTime: 1000, duration: 100 },
      { word: 'cd', startTime: 1100, duration: 1000 },
    ]
    // 只唱完第一个词（2 字 / 可见共 4 字）→ 0.5；空白词若算 1 字会变成约 0.4
    expect(computeSungRatio(withSpace, 1000)).toBeCloseTo(0.5, 5)
  })

  it('零时长可见词不瞬间计满（等下一词推进）', () => {
    const words = [
      { word: 'ab', startTime: 0, duration: 0 },
      { word: 'cd', startTime: 0, duration: 1000 },
    ]
    expect(computeSungRatio(words, 0)).toBe(0)
  })
})
