import { describe, expect, it, vi } from 'vitest'
import {
  DioramaRasterLruCache,
  type DioramaLineRaster,
  type DioramaUnitRaster,
} from '../src/components/foliaDiorama/dioramaTextRaster'

const lineRaster = (): DioramaLineRaster => ({
  texture: { dispose: vi.fn() } as unknown as DioramaLineRaster['texture'],
  canvasWidthPx: 1,
  canvasHeightPx: 1,
  advancePx: 1,
  fontPx: 1,
})

const unitRaster = (): DioramaUnitRaster => ({
  baseTexture: { dispose: vi.fn() } as unknown as DioramaUnitRaster['baseTexture'],
  glowTexture: { dispose: vi.fn() } as unknown as DioramaUnitRaster['glowTexture'],
  canvasWidthPx: 1,
  canvasHeightPx: 1,
  advancePx: 1,
})

describe('DioramaRasterLruCache', () => {
  it('shares one byte budget across line and unit rasters and evicts the LRU entry', () => {
    const cache = new DioramaRasterLruCache(10)
    const line = lineRaster()
    const oldUnit = unitRaster()
    const newUnit = unitRaster()

    cache.set('line', line, 4, 'font-a')
    cache.set('old-unit', oldUnit, 4, 'font-a')
    expect(cache.get('line')).toBe(line)
    cache.set('new-unit', newUnit, 4, 'font-a')

    expect(cache.get('old-unit')).toBeUndefined()
    expect(oldUnit.baseTexture.dispose).toHaveBeenCalledOnce()
    expect(oldUnit.glowTexture.dispose).toHaveBeenCalledOnce()
    expect(line.texture.dispose).not.toHaveBeenCalled()
    expect(cache.bytes).toBe(8)
    expect(cache.size).toBe(2)
  })

  it('disposes every texture when shrinking or clearing', () => {
    const cache = new DioramaRasterLruCache(20)
    const first = unitRaster()
    const second = lineRaster()
    cache.set('first', first, 8, 'font-a')
    cache.set('second', second, 8, 'font-a')

    cache.setBudget(8)
    expect(first.baseTexture.dispose).toHaveBeenCalledOnce()
    expect(first.glowTexture.dispose).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(8)

    cache.clear()
    expect(second.texture.dispose).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(0)
    expect(cache.size).toBe(0)
  })

  it('clears stale fonts and disposes oversized uncached rasters', () => {
    const cache = new DioramaRasterLruCache(8)
    const stale = lineRaster()
    const current = unitRaster()
    const oversized = lineRaster()
    cache.set('stale', stale, 4, 'font-a')
    cache.set('current', current, 4, 'font-b')

    cache.retainFont('font-b')
    expect(stale.texture.dispose).toHaveBeenCalledOnce()
    expect(cache.get('current')).toBe(current)

    expect(cache.set('oversized', oversized, 9, 'font-b')).toBe(false)
    expect(oversized.texture.dispose).toHaveBeenCalledOnce()
    expect(cache.bytes).toBe(4)
  })
})
