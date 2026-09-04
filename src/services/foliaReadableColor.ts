/**
 * Folia 主题色可读性校正
 *
 * folia 的 accentColor/secondaryColor（翻译/字幕/次文字颜色）直接取自封面主色。
 * 封面主色常常很深（深紫/暗蓝/黑底封面），在深色背景上发黑发灰、可读性差。
 * 这里把主题色按亮度往白（深色主题）/黑（浅色主题）方向混合，拉到目标相对亮度，
 * 保留色相同时保证文字可读。纯函数，便于单测。
 */

export interface RgbColor {
  r: number
  g: number
  b: number
}

/** 解析 #rgb / #rrggbb / rgb(r,g,b)；无法解析返回 null */
export function parseHexColor(input: string): RgbColor | null {
  if (typeof input !== 'string') return null
  let hex = input.trim()
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(hex)
  if (rgbMatch) {
    const r = Number(rgbMatch[1])
    const g = Number(rgbMatch[2])
    const b = Number(rgbMatch[3])
    if ([r, g, b].every((v) => v >= 0 && v <= 255)) return { r, g, b }
    return null
  }
  if (hex.startsWith('#')) hex = hex.slice(1)
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }
}

export function rgbToHex(rgb: RgbColor): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return `#${[rgb.r, rgb.g, rgb.b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`
}

/** WCAG 相对亮度（0-1，sRGB 线性化） */
export function relativeLuminance(rgb: RgbColor): number {
  const linear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
}

/** 在 sRGB 空间按 t(0-1) 把 a 向 b 混合 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHexColor(a)
  const cb = parseHexColor(b)
  if (!ca || !cb) return a
  const clamped = Math.max(0, Math.min(1, t))
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * clamped,
    g: ca.g + (cb.g - ca.g) * clamped,
    b: ca.b + (cb.b - ca.b) * clamped,
  })
}

const srgbToLinear = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const linearToSrgb = (c: number) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
  return Math.round(v * 255)
}

/** 在线性（感知）空间按 t(0-1) 把 a 向 b 混合：亮度随 t 线性变化，目标亮度可精确命中 */
export function mixHexLinear(a: string, b: string, t: number): string {
  const ca = parseHexColor(a)
  const cb = parseHexColor(b)
  if (!ca || !cb) return a
  const clamped = Math.max(0, Math.min(1, t))
  const la = { r: srgbToLinear(ca.r), g: srgbToLinear(ca.g), b: srgbToLinear(ca.b) }
  const lb = { r: srgbToLinear(cb.r), g: srgbToLinear(cb.g), b: srgbToLinear(cb.b) }
  return rgbToHex({
    r: linearToSrgb(la.r + (lb.r - la.r) * clamped),
    g: linearToSrgb(la.g + (lb.g - la.g) * clamped),
    b: linearToSrgb(la.b + (lb.b - la.b) * clamped),
  })
}

export interface ReadableColorOptions {
  /** 深色主题（背景暗）：过暗的主题色往白提亮；浅色主题则往黑压暗 */
  isDark: boolean
  /** 目标相对亮度（0-1）。深色背景建议 ≥0.4，浅色背景建议 ≤0.5 */
  targetLuminance?: number
}

/**
 * 把主题色校正到目标亮度范围：深色主题下过暗 → 往白混；浅色主题下过亮 → 往黑混。
 * 无法解析的输入原样返回（兜底不破坏既有颜色）。
 */
export function resolveReadableThemeColor(hex: string, isDark: boolean, targetLuminance?: number): string {
  const rgb = parseHexColor(hex)
  if (!rgb) return hex
  const target = targetLuminance ?? (isDark ? 0.42 : 0.4)
  const lum = relativeLuminance(rgb)
  if (isDark) {
    if (lum >= target) return hex
    // 在线性空间向白混合至目标亮度（线性混合的亮度随 t 线性变化，可精确命中）
    const t = (target - lum) / Math.max(1e-6, 1 - lum)
    return mixHexLinear(hex, '#ffffff', t)
  }
  if (lum <= target) return hex
  // 向黑混合至目标亮度：L_mix = L * (1-t)
  const t = 1 - target / Math.max(1e-6, lum)
  return mixHexLinear(hex, '#000000', t)
}
