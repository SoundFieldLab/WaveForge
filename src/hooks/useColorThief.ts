import { useState, useEffect } from 'react'
import { indexedDBCache } from '../services/indexedDBCache'

interface ColorPalette {
  dominantColor: string | null
  palette: string[]
}

interface CoverSource {
  url: string
  isObjectUrl: boolean
}

/**
 * 以对象 URL 形式加载封面，避免生成长期驻留的 base64 DataURL 大字符串。
 * 返回的 isObjectUrl 为 true 时，调用方使用完毕后必须 revokeObjectURL。
 */
async function loadCoverAsObjectUrl(imageUrl: string): Promise<CoverSource> {
  try {
    const cachedBlob = await indexedDBCache.getCoverBlob(imageUrl)
    if (cachedBlob) return { url: URL.createObjectURL(cachedBlob), isObjectUrl: true }
  } catch {
    // 缓存读取失败时直接走代理下载
  }
  const proxyUrl = `http://localhost:3001/api/proxy-image?url=${encodeURIComponent(imageUrl)}`
  try {
    const response = await fetch(proxyUrl)
    if (!response.ok) return { url: proxyUrl, isObjectUrl: false }
    const blob = await response.blob()
    await indexedDBCache.cacheCover(imageUrl, blob)
    return { url: URL.createObjectURL(blob), isObjectUrl: true }
  } catch {
    return { url: proxyUrl, isObjectUrl: false }
  }
}

/** 释放采样用的小 Canvas，让像素缓冲尽快被 GC 回收。 */
function releaseCanvas(canvas: HTMLCanvasElement | null): void {
  if (!canvas) return
  canvas.width = 0
  canvas.height = 0
}

// 模块级内存缓存：URL → 主色采样结果。
// useColorThief（当前曲目封面）与 extractDominantColor（过渡目标封面）可能对同一封面
// 重复做全图下载 + IndexedDB 写入 + 两次 50×50 采样；该缓存按原始封面 URL 共享，
// 命中后直接返回，避免重复网络请求与重复采样。带条数与过期上限防止无界增长。
const COLOR_THIEF_CACHE_MAX = 30
const COLOR_THIEF_CACHE_MAX_AGE = 1000 * 60 * 10 // 10 分钟
const colorThiefMemoryCache = new Map<string, { palette: ColorPalette; storedAt: number }>()

function getCachedColorThief(imageUrl: string): ColorPalette | null {
  if (!imageUrl) return null
  const entry = colorThiefMemoryCache.get(imageUrl)
  if (!entry) return null
  if (Date.now() - entry.storedAt > COLOR_THIEF_CACHE_MAX_AGE) {
    colorThiefMemoryCache.delete(imageUrl)
    return null
  }
  return entry.palette
}

function setCachedColorThief(imageUrl: string, palette: ColorPalette): void {
  if (!imageUrl) return
  colorThiefMemoryCache.delete(imageUrl)
  colorThiefMemoryCache.set(imageUrl, { palette, storedAt: Date.now() })
  // 超限时从队首淘汰最旧条目（LRU 近似）
  while (colorThiefMemoryCache.size > COLOR_THIEF_CACHE_MAX) {
    const oldestKey = colorThiefMemoryCache.keys().next().value
    if (oldestKey === undefined) break
    colorThiefMemoryCache.delete(oldestKey as string)
  }
}

/** 对已解码的封面图做 50×50 降采样，返回主色与色板（与原有提取算法逐位一致）。 */
function computeColorThiefPalette(image: HTMLImageElement): ColorPalette {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return { dominantColor: null, palette: [] }
  canvas.width = 50
  canvas.height = 50
  ctx.drawImage(image, 0, 0, 50, 50)
  const data = ctx.getImageData(0, 0, 50, 50).data
  // 采样完成后立即释放 Canvas，避免残留占用内存
  releaseCanvas(canvas)
  let red = 0
  let green = 0
  let blue = 0
  const buckets = new Map<string, { red: number; green: number; blue: number; count: number }>()
  for (let index = 0; index < data.length; index += 4) {
    const pixelRed = data[index]
    const pixelGreen = data[index + 1]
    const pixelBlue = data[index + 2]
    red += pixelRed
    green += pixelGreen
    blue += pixelBlue

    const luminance = pixelRed * 0.2126 + pixelGreen * 0.7152 + pixelBlue * 0.0722
    if (data[index + 3] < 180 || luminance < 18 || luminance > 242) continue
    const key = `${Math.round(pixelRed / 28)}-${Math.round(pixelGreen / 28)}-${Math.round(pixelBlue / 28)}`
    const bucket = buckets.get(key) || { red: 0, green: 0, blue: 0, count: 0 }
    bucket.red += pixelRed
    bucket.green += pixelGreen
    bucket.blue += pixelBlue
    bucket.count += 1
    buckets.set(key, bucket)
  }
  const pixelCount = data.length / 4
  const color = `rgb(${Math.floor(red / pixelCount * 0.5)}, ${Math.floor(green / pixelCount * 0.5)}, ${Math.floor(blue / pixelCount * 0.5)})`
  const candidates = [...buckets.values()]
    .map(bucket => ({
      red: Math.round(bucket.red / bucket.count),
      green: Math.round(bucket.green / bucket.count),
      blue: Math.round(bucket.blue / bucket.count),
      count: bucket.count,
    }))
    .sort((left, right) => right.count - left.count)
  const selected: typeof candidates = []

  for (const candidate of candidates) {
    const sufficientlyDifferent = selected.every(existing => {
      const distance = Math.hypot(
        candidate.red - existing.red,
        candidate.green - existing.green,
        candidate.blue - existing.blue
      )
      return distance >= 54
    })
    if (!sufficientlyDifferent) continue
    selected.push(candidate)
    if (selected.length >= 4) break
  }

  return {
    dominantColor: color,
    palette: selected.length > 0
      ? selected.map(item => `rgb(${item.red}, ${item.green}, ${item.blue})`)
      : [color],
  }
}

// 并发去重：同一 URL 正在计算时，后续调用复用同一个 Promise，避免重复下载
const colorThiefInFlight = new Map<string, Promise<ColorPalette>>()

/** 按 URL 计算主色与色板：先查内存缓存，未命中时下载 + 采样并写入缓存。 */
function computeColorThiefForUrl(imageUrl: string): Promise<ColorPalette> {
  const cached = getCachedColorThief(imageUrl)
  if (cached) return Promise.resolve(cached)

  const inFlight = colorThiefInFlight.get(imageUrl)
  if (inFlight) return inFlight

  const task = (async (): Promise<ColorPalette> => {
    let source: CoverSource | null = null
    try {
      source = await loadCoverAsObjectUrl(imageUrl)
      const loadedSource = source
      const result = await new Promise<ColorPalette>((resolve) => {
        const img = new Image()
        img.crossOrigin = 'Anonymous'
        const finish = () => {
          // 释放解码后的封面图与对象 URL
          img.onload = null
          img.onerror = null
          img.src = ''
          if (loadedSource.isObjectUrl) URL.revokeObjectURL(loadedSource.url)
        }
        img.onload = () => {
          const palette = computeColorThiefPalette(img)
          finish()
          resolve(palette)
        }
        img.onerror = () => {
          finish()
          resolve({ dominantColor: null, palette: [] })
        }
        img.src = loadedSource.url
      })
      setCachedColorThief(imageUrl, result)
      return result
    } catch (error) {
      console.error('提取颜色失败:', error)
      if (source?.isObjectUrl) URL.revokeObjectURL(source.url)
      return { dominantColor: null, palette: [] }
    } finally {
      colorThiefInFlight.delete(imageUrl)
    }
  })()

  colorThiefInFlight.set(imageUrl, task)
  return task
}

export function useColorThief(imageUrl: string): ColorPalette {
  const [dominantColor, setDominantColor] = useState<string | null>(null)
  const [palette, setPalette] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false

    if (!imageUrl) {
      setDominantColor(null)
      setPalette([])
      return
    }

    // 内存缓存命中：直接返回结果，不再重复下载封面 / 写 IndexedDB / 采样
    const cached = getCachedColorThief(imageUrl)
    if (cached) {
      setDominantColor(cached.dominantColor)
      setPalette(cached.palette)
      return
    }

    void computeColorThiefForUrl(imageUrl).then(result => {
      if (cancelled) return
      setDominantColor(result.dominantColor)
      setPalette(result.palette)
    })

    return () => {
      cancelled = true
    }
  }, [imageUrl])

  return { dominantColor, palette }
}

// 独立的颜色提取函数，用于异步提取（与 hook 共享按 URL 的内存缓存，命中直接返回）
export async function extractDominantColor(imageUrl: string): Promise<string | null> {
  if (!imageUrl) return null
  const cached = getCachedColorThief(imageUrl)
  if (cached) return cached.dominantColor
  const result = await computeColorThiefForUrl(imageUrl)
  return result.dominantColor
}
