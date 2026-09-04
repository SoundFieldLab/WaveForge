const DEFAULT_DESKTOP_ACCENT = '#8b5cf6'

function parseColor(color: string | null | undefined): [number, number, number] | null {
  if (!color) return null
  const value = color.trim()
  const shortHex = value.match(/^#([\da-f])([\da-f])([\da-f])$/i)
  if (shortHex) {
    return shortHex.slice(1).map(channel => Number.parseInt(`${channel}${channel}`, 16)) as [number, number, number]
  }

  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (hex) {
    return hex.slice(1).map(channel => Number.parseInt(channel, 16)) as [number, number, number]
  }

  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (!rgb) return null
  return rgb.slice(1, 4).map(channel => Math.max(0, Math.min(255, Number(channel)))) as [number, number, number]
}

function rgbToHsl([red, green, blue]: [number, number, number]) {
  const r = red / 255
  const g = green / 255
  const b = blue / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const lightness = (max + min) / 2
  const delta = max - min
  if (delta === 0) return { hue: 0, saturation: 0, lightness }

  const saturation = delta / (1 - Math.abs(2 * lightness - 1))
  let hue = max === r
    ? ((g - b) / delta) % 6
    : max === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4
  hue = (hue * 60 + 360) % 360
  return { hue, saturation, lightness }
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const section = hue / 60
  const secondary = chroma * (1 - Math.abs((section % 2) - 1))
  const [r1, g1, b1] = section < 1 ? [chroma, secondary, 0]
    : section < 2 ? [secondary, chroma, 0]
      : section < 3 ? [0, chroma, secondary]
        : section < 4 ? [0, secondary, chroma]
          : section < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary]
  const offset = lightness - chroma / 2
  return [r1, g1, b1].map(channel => Math.round((channel + offset) * 255)) as [number, number, number]
}

function toHex([red, green, blue]: [number, number, number]) {
  return `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Desktop controls append hexadecimal alpha values to the accent color. This
 * guarantees that the color is both hex encoded and bright enough for controls.
 */
export function getReadableAccentColor(color: string | null | undefined, fallback = DEFAULT_DESKTOP_ACCENT) {
  const parsed = parseColor(color)
  if (!parsed) return fallback
  const hsl = rgbToHsl(parsed)
  if (hsl.saturation < 0.18) return fallback

  return toHex(hslToRgb(
    hsl.hue,
    Math.max(0.58, Math.min(0.92, hsl.saturation)),
    Math.max(0.58, Math.min(0.66, hsl.lightness)),
  ))
}

export const getReadableDesktopAccentColor = getReadableAccentColor
