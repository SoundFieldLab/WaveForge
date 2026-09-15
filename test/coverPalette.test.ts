import { describe, expect, it } from 'vitest'
import { DEFAULT_FLUID_PALETTE, paletteFromPixels } from '../src/utils/coverPalette'

/** 封面取色（摩登流体背景的调色板）算法契约 */
const makePixels = (colors: Array<[number, number, number]>, repeats = 16): number[] => {
  const data: number[] = []
  for (const [r, g, b] of colors) {
    for (let i = 0; i < repeats; i += 1) data.push(r, g, b, 255)
  }
  return data
}

describe('封面取色', () => {
  it('输出固定 4 个合法色值', () => {
    const palette = paletteFromPixels(makePixels([[200, 60, 90], [40, 90, 200]]), 4, 1)
    expect(palette).toHaveLength(4)
    for (const color of palette) expect(color).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('占比高的颜色排在前，且不同颜色都被保留', () => {
    const palette = paletteFromPixels(makePixels([[255, 0, 0], [0, 0, 255]], 32), 4, 1)
    const head = palette.slice(0, 2).join(' ')
    expect(head).toContain('#ff0000')
    expect(head).toContain('#0000ff')
  })

  it('全透明像素退回默认板（不返回空）', () => {
    expect(paletteFromPixels([0, 0, 0, 0, 120, 120, 120, 0], 4, 1)).toEqual([...DEFAULT_FLUID_PALETTE])
  })

  it('纯色封面也能补出多个层次（不出现同色重复）', () => {
    const palette = paletteFromPixels(makePixels([[120, 80, 200]], 64), 4, 1)
    expect(palette).toHaveLength(4)
    expect(new Set(palette).size).toBeGreaterThan(1)
  })

  it('近黑/近白的噪声色被降权，不会成为主色', () => {
    const data = [...makePixels([[3, 3, 3]], 64), ...makePixels([[190, 120, 60]], 8)]
    const palette = paletteFromPixels(data, 4, 1)
    expect(palette[0]).not.toBe('#030303')
  })
})
