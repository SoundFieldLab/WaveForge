import { describe, expect, it } from 'vitest'
import {
  applyGamma,
  hsvToSrgb,
  linearToSrgb,
  mixLinearSrgb,
  mixOklab,
  srgbToHsv,
  srgbToLinear,
  srgbToOklab,
  oklabToSrgb,
} from '../src/plugins/rgb/rgbColor'

const expectColorClose = (
  actual: { r: number; g: number; b: number },
  expected: { r: number; g: number; b: number },
  digits = 5,
) => {
  expect(actual.r).toBeCloseTo(expected.r, digits)
  expect(actual.g).toBeCloseTo(expected.g, digits)
  expect(actual.b).toBeCloseTo(expected.b, digits)
}

describe('RGB color math', () => {
  it('round-trips sRGB through linear light at transfer-function endpoints', () => {
    expectColorClose(linearToSrgb(srgbToLinear({ r: 0, g: 0.04045, b: 1 })), {
      r: 0,
      g: 0.04045,
      b: 1,
    })
  })

  it('round-trips sRGB through OKLab', () => {
    const source = { r: 0.12, g: 0.56, b: 0.91 }
    expectColorClose(oklabToSrgb(srgbToOklab(source)), source, 4)
  })

  it('uses light-linear interpolation instead of encoded-channel interpolation', () => {
    const midpoint = mixLinearSrgb({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }, 0.5)
    expect(midpoint.r).toBeCloseTo(0.735356, 5)
    expectColorClose(midpoint, { r: midpoint.r, g: midpoint.r, b: midpoint.r })
    expect(mixOklab({ r: 1, g: 0, b: 0 }, { r: 0, g: 0, b: 1 }, 0).r).toBeCloseTo(1, 5)
  })

  it('applies gamma and clamps invalid channel ranges', () => {
    expectColorClose(applyGamma({ r: -1, g: 0.5, b: 2 }, 2), { r: 0, g: 0.25, b: 1 })
  })

  it('converts HSV primary colors and preserves wrapped hue', () => {
    expectColorClose(hsvToSrgb({ h: 120, s: 1, v: 1 }), { r: 0, g: 1, b: 0 })
    expectColorClose(hsvToSrgb({ h: -120, s: 1, v: 1 }), { r: 0, g: 0, b: 1 })
    expect(srgbToHsv({ r: 1, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 })
  })
})
