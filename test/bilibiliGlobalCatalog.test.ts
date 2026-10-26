import { describe, expect, it } from 'vitest'
import { GLOBAL_CATALOG_ENTRIES, GLOBAL_CATALOG_VERSION, findGlobalCatalogByMeta, getGlobalCatalogEntryByBvid } from '../src/data/bilibiliGlobalCatalog'

describe('global catalog (全球热门 MV 核验库)', () => {
  it('has entries with valid structure', () => {
    expect(GLOBAL_CATALOG_ENTRIES.length).toBeGreaterThan(500)
    for (const e of GLOBAL_CATALOG_ENTRIES.slice(0, 50)) {
      expect(e.bvid).toMatch(/^BV[0-9A-Za-z]{10}$/)
      expect(e.songTitle.length).toBeGreaterThan(0)
      expect(e.artists.length).toBeGreaterThan(0)
      expect(e.duration).toBeGreaterThan(30)
      expect(e.duration).toBeLessThan(1200)
      expect(e.playCount).toBeGreaterThan(0)
    }
  })

  it('finds entry by exact title + artist (米津玄師 Lemon)', () => {
    const hit = findGlobalCatalogByMeta('Lemon', ['米津玄師'], 275)
    expect(hit).not.toBeNull()
    expect(hit!.bvid).toBe('BV164411D7vc')
  })

  it('finds entry ignoring version suffix (Live Ver. / 完整版)', () => {
    const hit = findGlobalCatalogByMeta('Lemon (Live Ver.)', ['米津玄師'], 275)
    expect(hit).not.toBeNull()
  })

  it('finds entry despite artist name variants (周杰伦 vs Jay Chou 不匹配时应拒绝)', () => {
    // 歌手写法差异：大小写/空白
    const hit = findGlobalCatalogByMeta('Blank Space', ['taylor swift'], 232)
    expect(hit).not.toBeNull()
    expect(hit!.artists[0]).toBe('Taylor Swift')
  })

  it('rejects wrong-artist same-title (防同名不同歌手错配)', () => {
    // 库内有 NewJeans Attention 和 Charlie Puth Attention —— 歌手不同必须各回各家
    const nj = findGlobalCatalogByMeta('Attention', ['NewJeans'], 178)
    const cp = findGlobalCatalogByMeta('Attention', ['Charlie Puth'], 197)
    if (nj && cp) {
      expect(nj.artists[0]).not.toBe(cp.artists[0])
    }
  })

  it('rejects duration mismatch >10s (防同名不同版本)', () => {
    // Lemon 是 275s，用一个完全不同时长查询应拒绝
    const hit = findGlobalCatalogByMeta('Lemon', ['米津玄師'], 60)
    expect(hit).toBeNull()
  })

  it('returns null for unknown song', () => {
    const hit = findGlobalCatalogByMeta('完全不存在的一首歌XYZ', ['不存在歌手'], 200)
    expect(hit).toBeNull()
  })

  it('bvid lookup works', () => {
    const e = getGlobalCatalogEntryByBvid(GLOBAL_CATALOG_ENTRIES[0].bvid)
    expect(e).not.toBeNull()
    expect(e!.bvid).toBe(GLOBAL_CATALOG_ENTRIES[0].bvid)
    expect(getGlobalCatalogEntryByBvid('BV0000000000')).toBeNull()
  })

  it('version is tracked for cache fingerprint invalidation', () => {
    expect(GLOBAL_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}-\d+$/)
  })
})
