/**
 * 封面取色：从专辑封面像素里提炼一组用于"摩登流体背景"的调色板。
 *
 * 自研实现（不依赖任何第三方取色库、不复制 AMLL 的 palette/kmeans 代码）：
 *   1) 把封面降采样成小图，逐像素量化到粗粒度的颜色桶；
 *   2) 按桶内像素数排序，取出现最多的若干色；
 *   3) 过滤过暗/过亮与彼此过于接近的颜色，保证画面有层次。
 *
 * 取色只用于背景着色，颜色数值本身不受版权保护；算法为标准直方图量化。
 */

export interface Rgb {
  r: number
  g: number
  b: number
}

/** 量化粒度：每通道右移 4 位 → 16 级/通道 */
const QUANTIZE_SHIFT = 4
const MAX_BUCKETS = 4096

const toHex = ({ r, g, b }: Rgb): string =>
  `#${[r, g, b].map(value => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('')}`

const luminance = ({ r, g, b }: Rgb): number => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

const distance = (a: Rgb, b: Rgb): number =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2)

/** 默认兜底色板：取不到封面时也能有稳定的流体背景 */
export const DEFAULT_FLUID_PALETTE: readonly string[] = ['#1f2a44', '#3b2f52', '#123a3a', '#2b1f3a']

/**
 * 由 RGBA 像素数组提炼调色板（step 为采样步长，data 为 ImageData.data 的兼容输入）。
 * 纯函数，便于单测。
 */
export const paletteFromPixels = (
  data: ArrayLike<number>,
  count = 4,
  step = 4,
): string[] => {
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i + 3 < data.length; i += 4 * Math.max(1, step)) {
    const alpha = data[i + 3]
    if (alpha < 128) continue
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const key =
      ((r >> QUANTIZE_SHIFT) << (8 - QUANTIZE_SHIFT + 4)) |
      ((g >> QUANTIZE_SHIFT) << 4) |
      (b >> QUANTIZE_SHIFT)
    const existing = buckets.get(key)
    if (existing) {
      existing.r += r
      existing.g += g
      existing.b += b
      existing.n += 1
    } else if (buckets.size < MAX_BUCKETS) {
      buckets.set(key, { r, g, b, n: 1 })
    }
  }

  const ranked = [...buckets.values()]
    .map(bucket => ({
      r: bucket.r / bucket.n,
      g: bucket.g / bucket.n,
      b: bucket.b / bucket.n,
      n: bucket.n,
    }))
    .sort((a, b) => b.n - a.n)

  const picked: Rgb[] = []
  const usable = ranked.filter(color => {
    const luma = luminance(color)
    return luma > 0.03 && luma < 0.97
  })
  // 只要存在"可用"颜色（非近黑/近白），就只在其中挑；数量不足由后面的明暗补齐处理。
  // 否则一次近黑噪声色就能成为纯黑封面的主色，画面会塌成一片死黑。
  const pool = usable.length > 0 ? usable : ranked

  for (const color of pool) {
    if (picked.length >= count) break
    // 与已选颜色保持距离：纯色封面也能凑出有层次的背景
    if (picked.some(existing => distance(existing, color) < 48)) continue
    picked.push({ r: color.r, g: color.g, b: color.b })
  }

  // 颜色种类不足（如纯色/黑白封面）时，用已选颜色做明暗/色相偏移补齐
  let index = 0
  while (picked.length < count && picked.length > 0) {
    const base = picked[index % picked.length]
    const shift = (Math.floor(index / picked.length) + 1) * 18
    picked.push({
      r: base.r + shift,
      g: base.g + shift * 0.6,
      b: base.b + shift * 1.2,
    })
    index += 1
  }

  if (picked.length === 0) return [...DEFAULT_FLUID_PALETTE].slice(0, count)
  return picked.map(toHex)
}

const PALETTE_SIZE = 4
const SAMPLE_SIZE = 32
const paletteCache = new Map<string, string[]>()
const palettePending = new Map<string, Promise<string[]>>()

/**
 * 从封面图 URL 取调色板（同源/已代理的 URL 才能读像素）。
 * 结果按 URL 缓存；失败返回默认板，不抛错。
 */
export const extractCoverPalette = async (url: string): Promise<string[]> => {
  if (!url) return [...DEFAULT_FLUID_PALETTE]
  const cached = paletteCache.get(url)
  if (cached) return cached
  const pending = palettePending.get(url)
  if (pending) return pending

  const task = (async () => {
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.crossOrigin = 'anonymous'
        el.onload = () => resolve(el)
        el.onerror = () => reject(new Error('cover load failed'))
        el.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = SAMPLE_SIZE
      canvas.height = SAMPLE_SIZE
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) return [...DEFAULT_FLUID_PALETTE]
      context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const { data } = context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE)
      const palette = paletteFromPixels(data, PALETTE_SIZE, 1)
      paletteCache.set(url, palette)
      return palette
    } catch {
      // 跨域污染/加载失败：退回默认板并缓存，避免反复重试
      const fallback = [...DEFAULT_FLUID_PALETTE]
      paletteCache.set(url, fallback)
      return fallback
    } finally {
      palettePending.delete(url)
    }
  })()

  palettePending.set(url, task)
  return task
}

/** 清空缓存（测试/切歌调色板需要重算时使用） */
export const clearCoverPaletteCache = (): void => {
  paletteCache.clear()
  palettePending.clear()
}
