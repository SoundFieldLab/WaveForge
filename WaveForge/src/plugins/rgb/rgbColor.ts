import type { RgbColor } from './rgbTypes'

export interface HsvColor {
  /** Hue in degrees. */
  h: number
  s: number
  v: number
}

export interface OklabColor {
  L: number
  a: number
  b: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))

export function srgbChannelToLinear(value: number): number {
  const channel = clamp01(value)
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4
}

export function linearChannelToSrgb(value: number): number {
  const channel = clamp01(value)
  return clamp01(channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055)
}

export function srgbToLinear(color: RgbColor): RgbColor {
  return {
    r: srgbChannelToLinear(color.r),
    g: srgbChannelToLinear(color.g),
    b: srgbChannelToLinear(color.b),
  }
}

export function linearToSrgb(color: RgbColor): RgbColor {
  return {
    r: linearChannelToSrgb(color.r),
    g: linearChannelToSrgb(color.g),
    b: linearChannelToSrgb(color.b),
  }
}

export function linearRgbToOklab(color: RgbColor): OklabColor {
  const r = clamp01(color.r)
  const g = clamp01(color.g)
  const b = clamp01(color.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  }
}

export function oklabToLinearRgb(color: OklabColor): RgbColor {
  const l = (color.L + 0.3963377774 * color.a + 0.2158037573 * color.b) ** 3
  const m = (color.L - 0.1055613458 * color.a - 0.0638541728 * color.b) ** 3
  const s = (color.L - 0.0894841775 * color.a - 1.291485548 * color.b) ** 3

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  }
}

export function srgbToOklab(color: RgbColor): OklabColor {
  return linearRgbToOklab(srgbToLinear(color))
}

export function oklabToSrgb(color: OklabColor): RgbColor {
  return linearToSrgb(oklabToLinearRgb(color))
}

export function mixLinearSrgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const t = clamp01(amount)
  const a = srgbToLinear(from)
  const b = srgbToLinear(to)
  return linearToSrgb({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

export function mixOklab(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const t = clamp01(amount)
  const a = srgbToOklab(from)
  const b = srgbToOklab(to)
  return oklabToSrgb({
    L: a.L + (b.L - a.L) * t,
    a: a.a + (b.a - a.a) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

export function applyGamma(color: RgbColor, gamma: number): RgbColor {
  const exponent = Number.isFinite(gamma) && gamma > 0 ? gamma : 1
  return {
    r: clamp01(color.r) ** exponent,
    g: clamp01(color.g) ** exponent,
    b: clamp01(color.b) ** exponent,
  }
}

export function hsvToSrgb(color: HsvColor): RgbColor {
  const hue = ((Number.isFinite(color.h) ? color.h : 0) % 360 + 360) % 360
  const saturation = clamp01(color.s)
  const value = clamp01(color.v)
  const chroma = value * saturation
  const sector = hue / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  let r = 0
  let g = 0
  let b = 0

  if (sector < 1) [r, g] = [chroma, x]
  else if (sector < 2) [r, g] = [x, chroma]
  else if (sector < 3) [g, b] = [chroma, x]
  else if (sector < 4) [g, b] = [x, chroma]
  else if (sector < 5) [r, b] = [x, chroma]
  else [r, b] = [chroma, x]

  const match = value - chroma
  return { r: r + match, g: g + match, b: b + match }
}

export function srgbToHsv(color: RgbColor): HsvColor {
  const r = clamp01(color.r)
  const g = clamp01(color.g)
  const b = clamp01(color.b)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0

  if (delta > 0) {
    if (max === r) hue = 60 * (((g - b) / delta) % 6)
    else if (max === g) hue = 60 * ((b - r) / delta + 2)
    else hue = 60 * ((r - g) / delta + 4)
  }

  return {
    h: (hue + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  }
}
