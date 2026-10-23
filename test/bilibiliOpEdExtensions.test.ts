import { describe, expect, it } from 'vitest'
import {
  OP_ED_EXTENSION_ENTRIES,
  OP_ED_EXTENSION_UPLOADER_MIDS,
  getOpEdExtensionDeclaration,
  getOpEdExtensionsByFranchise,
  getOpEdExtensionVersions,
  findOpEdExtensionByMeta,
} from '../src/data/bilibiliOpEdExtensions'

describe('OP/ED 延长库（bilibiliOpEdExtensions）', () => {
  const BVID_RE = /^BV[0-9A-Za-z]{10}$/

  it('条目结构完整：bvid 合法、(songKey×uploaderMid) 唯一、时长与核验字段齐全', () => {
    const keys = new Set<string>()
    for (const entry of OP_ED_EXTENSION_ENTRIES) {
      expect(entry.songKey).toMatch(/^(qq|netease):\d+$/)
      expect(BVID_RE.test(entry.bvid)).toBe(true)
      expect(entry.songKey.trim()).not.toBe('')
      // v2：同曲多版本（不同 UP 都做了同一首歌）合法——按 (songKey, uploaderMid) 唯一；
      // 命中时由 getOpEdExtensionDeclaration 按播放数取最优版本
      const composite = `${entry.songKey}@${entry.uploaderMid}`
      expect(keys.has(composite)).toBe(false)
      keys.add(composite)
      expect(entry.duration).toBeGreaterThan(30)
      expect(entry.videoDuration).toBeGreaterThan(30)
      expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(OP_ED_EXTENSION_UPLOADER_MIDS).toContain(entry.uploaderMid)
      expect(['op', 'ed', 'in', 'tm']).toContain(entry.kind)
    }
  })

  it('按 songKey 精确查找命中（紅蓮の弓矢 qq:4973706）', () => {
    const hit = getOpEdExtensionDeclaration('qq:4973706')
    expect(hit?.bvid).toBe('BV1pi4y1g7AC')
    expect(hit?.franchise).toBe('进击的巨人')
    expect(hit?.kind).toBe('op')
  })

  it('未收录歌曲返回 null', () => {
    expect(getOpEdExtensionDeclaration('qq:1')).toBeNull()
    expect(getOpEdExtensionDeclaration('')).toBeNull()
  })

  it('按作品名查找返回该作品全部延长版', () => {
    const hits = getOpEdExtensionsByFranchise('进击的巨人')
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) expect(hit.franchise).toBe('进击的巨人')
    expect(getOpEdExtensionsByFranchise('不存在的作品')).toEqual([])
  })
})

describe('同曲多版本（v2 multi-map + 播放数取胜）', () => {
  it('getOpEdExtensionVersions 返回同曲全部版本；单曲返回单元素数组', () => {
    const versions = getOpEdExtensionVersions('qq:4973706')
    expect(versions.length).toBeGreaterThanOrEqual(1)
    for (const v of versions) expect(v.songKey).toBe('qq:4973706')
    expect(getOpEdExtensionVersions('qq:1')).toEqual([])
  })

  it('同曲多版本时 getOpEdExtensionDeclaration 返回播放数最高者', () => {
    const versions = getOpEdExtensionVersions('qq:4973706')
    if (versions.length >= 2) {
      const best = getOpEdExtensionDeclaration('qq:4973706')
      const maxPlay = Math.max(...versions.map((v) => v.playCount ?? 0))
      expect(best?.playCount ?? 0).toBe(maxPlay)
    } else {
      // 单版本时行为与 map 直查一致
      const best = getOpEdExtensionDeclaration('qq:4973706')
      expect(best?.bvid).toBe('BV1pi4y1g7AC')
    }
  })

  it('全部条目都带 playCount（2026-10-21 快照）', () => {
    for (const entry of OP_ED_EXTENSION_ENTRIES) {
      expect(typeof entry.playCount).toBe('number')
      expect(entry.playCount!).toBeGreaterThanOrEqual(0)
    }
  })
})

// ===== 全平台元数据回退索引（v3）=====
describe('全平台元数据回退（findOpEdExtensionByMeta）', () => {
  it('netease 平台同一首歌（不同 id）通过标题+歌手命中同一延长版', () => {
    // 紅蓮の弓矢 / Linked Horizon 在库里的 QQ songKey 是 qq:4973706；
    // 网易云的 id 完全不同——元数据索引应命中同一 bvid
    const hit = findOpEdExtensionByMeta('紅蓮の弓矢', ['Linked Horizon'], 316)
    expect(hit?.bvid).toBe('BV1pi4y1g7AC')
  })

  it('带版本后缀的歌名（完整版/TV size 等）剥后缀后仍命中', () => {
    const hit = findOpEdExtensionByMeta('紅蓮の弓矢 (TVサイズver.)', ['Linked Horizon'], 94)
    // 时长差 >10s（TV size 94s vs 库内 316s）→ 时长过滤拒绝该条，返回 null（避免错配）
    expect(hit).toBeNull()
    const ok = findOpEdExtensionByMeta('紅蓮の弓矢（完整版）', ['Linked Horizon'], 318)
    expect(ok?.bvid).toBe('BV1pi4y1g7AC')
  })

  it('同名不同歌手 → 拒绝（歌手过滤）', () => {
    // 库内 蒂德比特（G.E.M.）等歌名可能撞名——用库内已知歌名+错误歌手验证不命中
    const hit = findOpEdExtensionByMeta('紅蓮の弓矢', ['完全不同的歌手'], 316)
    expect(hit).toBeNull()
  })

  it('Apple/汽水等无 id 平台（platform 缺省）同样命中', () => {
    // 模拟 MatchContext 不带 platform/id 的极端情况（Apple Music 流派）
    const hit = findOpEdExtensionByMeta('Grand Blue', ['湘南乃風'], 313)
    expect(hit?.uploaderMid).toBe(8871554)
  })

  it('时长缺失（undefined）时仍可命中（交给评分层裁决）', () => {
    const hit = findOpEdExtensionByMeta('Grand Blue', ['湘南乃風'], undefined)
    expect(hit?.bvid).toBe('BV1sa411f7Yp')
  })
})
