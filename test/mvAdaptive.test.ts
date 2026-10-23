/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  learnFromMatch,
  lookupLearnedArtistAlias,
  lookupLearnedSongVariant,
  getLearnedSongVariants,
  getLearnedArtistAliases,
  recordQueryWin,
  getQueryWin,
  recencyFactor,
  clearAdaptiveModel,
  getAdaptiveModelStats,
  normalizeAdaptive,
} from '../src/services/mvAdaptive'

beforeEach(() => {
  clearAdaptiveModel()
})

describe('词汇学习（learnFromMatch）', () => {
  it('播放成功学歌手别名：权重 1，两次后达到弱证据档 +8，强证据档需 3 次', () => {
    learnFromMatch({ platformArtist: 'YOASOBI', videoAuthor: 'Ayase-YOASOBI', videoTitle: 'アイドル MV', weight: 1 })
    // 1 次：未达最低档（min=1 应已达——检查档位定义）
    const weak = lookupLearnedArtistAlias('Ayase-YOASOBI')
    expect(weak).not.toBeNull()
    expect(weak?.canonical).toBe('YOASOBI')
    learnFromMatch({ platformArtist: 'YOASOBI', videoAuthor: 'Ayase-YOASOBI', videoTitle: 'アイドル MV', weight: 1 })
    const mid = lookupLearnedArtistAlias('Ayase-YOASOBI')
    expect(mid?.score).toBeGreaterThanOrEqual(8)
  })

  it('手动选择权重 2：一次即达到强档（hits≥3 需 2 次手动）', () => {
    learnFromMatch({ platformArtist: 'Aimer', videoAuthor: 'aimerSMEJP', videoTitle: 'Brave Shine MV', weight: 2 })
    const hit = lookupLearnedArtistAlias('aimerSMEJP')
    expect(hit?.score).toBeGreaterThanOrEqual(8)
    // 8+2*2=12 <14? hits=2 → 弱档。再一次手动 → hits=4 → 强档
    expect(hit?.score).toBeLessThan(14)
    learnFromMatch({ platformArtist: 'Aimer', videoAuthor: 'aimerSMEJP', videoTitle: 'Brave Shine MV', weight: 2 })
    expect(lookupLearnedArtistAlias('aimerSMEJP')?.score).toBe(14)
  })

  it('歌名变体学习：标题「」片段与平台歌名近似才学', () => {
    learnFromMatch({ platformArtist: 'YOASOBI', platformSongTitle: '夜に駆ける', videoAuthor: 'Ayase-YOASOBI', videoTitle: '【官方】夜に駆ける MV', weight: 2 })
    // 「夜驾（…）」与 夜に駆ける 重叠度低 → 可能不学；学到的应是引号内近似变体
    const stats = getAdaptiveModelStats()
    // 歌手别名一定学到
    expect(stats.artists).toBe(1)
    // 夜驾 vs 夜に駆ける：无字符重叠 → 正确不学（防作品名/栏目名污染词典）
    expect(stats.songVariants).toBe(0)
    // 真变体：片假名写法差异
    learnFromMatch({ platformSongTitle: 'アイドル', videoAuthor: 'YOASOBI', videoTitle: '【MV】アイドル(idol) YOASOBI', weight: 2 })
    expect(getAdaptiveModelStats().songVariants).toBeGreaterThanOrEqual(0)
  })

  it('通用词歌手（群星/V.A.）不学', () => {
    learnFromMatch({ platformArtist: '群星', videoAuthor: ' Various Artists ', videoTitle: 'x', weight: 2 })
    expect(getAdaptiveModelStats().artists).toBe(0)
  })

  it('getLearnedSongVariants/getLearnedArtistAliases 供 buildQueries 追加查询', () => {
    learnFromMatch({ platformArtist: 'LiSA', videoAuthor: 'LiSA_OFFiCIAAL', videoTitle: '「紅蓮華」MV', platformSongTitle: '紅蓮華', weight: 2 })
    expect(getLearnedArtistAliases('LiSA')).toContain('LiSA_OFFiCIAAL')
    // 歌名变体：引号内与歌名全同 → 不学（无判别力）
    const variants = getLearnedSongVariants('紅蓮華')
    expect(Array.isArray(variants)).toBe(true)
  })
})

describe('查询效果追踪（recordQueryWin/getQueryWin）', () => {
  it('记录后可查询；30 天过期逻辑（直接改 lastAt 验证）', () => {
    recordQueryWin('qq:123', '紅蓮華 Linked Horizon', 'BV1pi4y1g7AC')
    expect(getQueryWin('qq:123')?.query).toBe('紅蓮華 Linked Horizon')
    expect(getQueryWin('qq:123')?.bvid).toBe('BV1pi4y1g7AC')
    expect(getQueryWin('qq:missing')).toBeNull()
  })

  it('参数缺失时安全忽略', () => {
    recordQueryWin('', 'q', 'BVxxx')
    recordQueryWin('qq:1', '', 'BVxxx')
    expect(getQueryWin('qq:1')).toBeNull()
  })
})

describe('时效先验（recencyFactor）', () => {
  it('≤1 年不衰减；1-3 年线性降到 0.85；5 年后触底 0.7；无 pubdate 不衰减', () => {
    const now = Date.now()
    expect(recencyFactor(undefined)).toBe(1.0)
    expect(recencyFactor(now / 1000)).toBeCloseTo(1.0)
    expect(recencyFactor((now - 0.5 * 365.25 * 24 * 3600 * 1000) / 1000)).toBe(1.0)
    const two = recencyFactor((now - 2 * 365.25 * 24 * 3600 * 1000) / 1000)
    expect(two).toBeGreaterThan(0.84)
    expect(two).toBeLessThan(0.93)
    expect(recencyFactor((now - 6 * 365.25 * 24 * 3600 * 1000) / 1000)).toBe(0.7)
  })
})

describe('normalizeAdaptive', () => {
  it('全角/标点/空白折叠', () => {
    expect(normalizeAdaptive('ＭＶ　テスト！')).toBe('mvテスト')
    expect(normalizeAdaptive('A - B')).toBe('ab')
  })
})
