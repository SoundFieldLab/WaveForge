/**
 * 汽水派生数据纯函数单测（写法约定对齐 test/sodaLyricTimeline.test.ts）：
 * 1) splitSodaArtistNames        —— 多歌手字段拆分（与后端 SODA_ARTIST_NAME_SPLIT_RE 同口径）；
 * 2) aggregateSodaArtistsFromSongs —— 歌手聚合去重（多歌手拆分 / 归一去重 / 计数排序 / cap）；
 * 3) clusterSodaAlbumsFromSongs  —— 专辑聚拢（专辑名+封面键去重 / cap）；
 * 4) rankSodaSuggestCandidates   —— suggest 排序（前缀命中优先 / 归一去重 / cap）。
 * 三个纯函数定义在 src/services/sodaService.ts，仅依赖 musicApi 的类型声明（node 环境可直接加载）；
 * fixture 为手工编造的脱敏样例（非真实歌曲数据）。
 */
import { describe, expect, it } from 'vitest'
// 前端派生纯函数：仅依赖 musicApi 的类型声明，node 环境可直接加载
import {
  aggregateSodaArtistsFromSongs,
  clusterSodaAlbumsFromSongs,
  rankSodaSuggestCandidates,
  splitSodaArtistNames,
} from '../src/services/sodaService'
import type { SodaSearchSuggestion } from '../src/services/sodaService'
import type { Song } from '../src/services/musicApi'

/** 手工编造的脱敏 Song 工厂（非真实歌曲数据） */
const makeSong = (overrides: {
  name?: string
  artists?: Song['artists']
  album?: Partial<Song['album']>
}): Song => ({
  id: 0,
  name: overrides.name || '测试歌曲',
  artists: overrides.artists || [],
  album: { name: overrides.album?.name || '', picUrl: overrides.album?.picUrl || '' },
  duration: 0,
  platform: 'soda',
})

describe('splitSodaArtistNames（多歌手字段拆分）', () => {
  it('按 / , & 三种分隔符拆分组合歌手（与后端 SODA_ARTIST_NAME_SPLIT_RE 同口径）', () => {
    expect(splitSodaArtistNames(makeSong({ artists: [{ name: '张三/李四' }] }))).toEqual(['张三', '李四'])
    expect(splitSodaArtistNames(makeSong({ artists: [{ name: '张三 , 李四' }] }))).toEqual(['张三', '李四'])
    expect(splitSodaArtistNames(makeSong({ artists: [{ name: '张三 & 李四' }] }))).toEqual(['张三', '李四'])
  })

  it('同一首歌多歌手字段逐个拆分并全局去重（归一后相同视为同一人，保留首个展示形态）', () => {
    const song = makeSong({ artists: [{ name: '张三/李四' }, { name: '李四' }, { name: '王 五' }, { name: '王五' }] })
    expect(splitSodaArtistNames(song)).toEqual(['张三', '李四', '王 五'])
  })

  it('中文顿号不拆分（后端同样不拆，保持口径一致）', () => {
    expect(splitSodaArtistNames(makeSong({ artists: [{ name: '张三、李四' }] }))).toEqual(['张三、李四'])
  })

  it('空输入/空歌手字段返回空数组', () => {
    expect(splitSodaArtistNames(makeSong({}))).toEqual([])
    expect(splitSodaArtistNames(makeSong({ artists: [{ name: '' }, { name: '  ' }] }))).toEqual([])
  })
})

describe('aggregateSodaArtistsFromSongs（歌手聚合去重）', () => {
  const SONGS: Song[] = [
    makeSong({ name: '歌一', artists: [{ name: '张三/李四' }] }),
    makeSong({ name: '歌二', artists: [{ name: '张三' }] }),
    makeSong({ name: '歌三', artists: [{ name: '李四' }] }),
    makeSong({ name: '歌四', artists: [{ name: '王五' }] }),
  ]

  it('多歌手拆分后聚合计数：张三/李四 各计 2 首，王五 1 首', () => {
    const artists = aggregateSodaArtistsFromSongs(SONGS)
    expect(artists.map(item => item.name)).toEqual(['张三', '李四', '王五'])
    expect(artists.map(item => item.songCount)).toEqual([2, 2, 1])
    // id = 歌手名（伪艺人约定），来源标注诚实派生
    expect(artists[0]).toMatchObject({ id: '张三', source: 'soda-search-derived' })
  })

  it('同名字段大小写/空白变体归一去重后合并计数', () => {
    const artists = aggregateSodaArtistsFromSongs([
      makeSong({ artists: [{ name: 'Zhang San' }] }),
      makeSong({ artists: [{ name: 'zhang  san' }] }),
    ])
    expect(artists).toHaveLength(1)
    expect(artists[0].songCount).toBe(2)
    expect(artists[0].name).toBe('Zhang San')
  })

  it('cap 截断：按计数降序保留前 N 位', () => {
    const artists = aggregateSodaArtistsFromSongs(SONGS, 2)
    expect(artists.map(item => item.name)).toEqual(['张三', '李四'])
  })

  it('关键词前缀命中优先（其余按计数 → 首现顺序）', () => {
    const artists = aggregateSodaArtistsFromSongs(SONGS, 20, '王')
    expect(artists[0].name).toBe('王五')
  })

  it('空输入返回空数组', () => {
    expect(aggregateSodaArtistsFromSongs([])).toEqual([])
    expect(aggregateSodaArtistsFromSongs([makeSong({})])).toEqual([])
  })
})

describe('clusterSodaAlbumsFromSongs（专辑聚拢）', () => {
  it('按「专辑名+封面」键聚拢去重并累计曲目数', () => {
    const songs: Song[] = [
      makeSong({ artists: [{ name: '张三' }], album: { name: '专辑A', picUrl: 'https://cdn/a.jpg' } }),
      makeSong({ artists: [{ name: '张三' }], album: { name: '专辑 A', picUrl: 'https://cdn/a.jpg' } }),
      makeSong({ artists: [{ name: '张三' }], album: { name: '专辑A', picUrl: 'https://cdn/a2.jpg' } }),
    ]
    const albums = clusterSodaAlbumsFromSongs(songs)
    // 「专辑A + 同封面」两首聚为一组；同名不同封面是另一个键（诚实拆分，不强行合并）
    expect(albums).toHaveLength(2)
    expect(albums[0]).toMatchObject({
      id: '专辑A',
      name: '专辑A',
      artist: '张三',
      coverUrl: 'https://cdn/a.jpg',
      songCount: 2,
      source: 'soda-derived-albums',
    })
    expect(albums[1].songCount).toBe(1)
  })

  it('无专辑名的曲目跳过；组内首曲缺封面时由后续曲目补齐', () => {
    const songs: Song[] = [
      makeSong({ album: { name: '' } }),
      makeSong({ artists: [{ name: '李四' }], album: { name: '专辑B' } }),
      makeSong({ artists: [{ name: '李四' }], album: { name: '专辑B', picUrl: 'https://cdn/b.jpg' } }),
    ]
    const albums = clusterSodaAlbumsFromSongs(songs)
    expect(albums).toHaveLength(1)
    expect(albums[0].coverUrl).toBe('https://cdn/b.jpg')
    expect(albums[0].songCount).toBe(2)
  })

  it('cap 截断：按组内曲目数降序保留前 N 张', () => {
    const songs: Song[] = [
      makeSong({ album: { name: '专辑A' } }),
      makeSong({ album: { name: '专辑A' } }),
      makeSong({ album: { name: '专辑B' } }),
      makeSong({ album: { name: '专辑C' } }),
    ]
    expect(clusterSodaAlbumsFromSongs(songs, 2).map(item => item.name)).toEqual(['专辑A', '专辑B'])
  })

  it('空输入/全无专辑字段返回空数组', () => {
    expect(clusterSodaAlbumsFromSongs([])).toEqual([])
    expect(clusterSodaAlbumsFromSongs([makeSong({})])).toEqual([])
  })
})

describe('rankSodaSuggestCandidates（suggest 排序）', () => {
  const CANDIDATES: SodaSearchSuggestion[] = [
    { text: '晴天', type: 'song' },
    { text: '晴天乐队', type: 'artist' },
    { text: '晴天精选集', type: 'album' },
    { text: '晴天', type: 'song' }, // 重复候选
  ]

  it('前缀命中的候选优先，其余保持上游相关性顺序（sort 稳定）', () => {
    const ranked = rankSodaSuggestCandidates(CANDIDATES, '晴天乐队', 8)
    expect(ranked[0]).toEqual({ text: '晴天乐队', type: 'artist' })
    // 非前缀候选保持原顺序
    expect(ranked.slice(1).map(item => item.text)).toEqual(['晴天', '晴天精选集'])
  })

  it('归一去重：同文本候选只保留首个', () => {
    const ranked = rankSodaSuggestCandidates(CANDIDATES, '晴天', 8)
    expect(ranked.filter(item => item.text === '晴天')).toHaveLength(1)
  })

  it('cap 截断 + 空输入安全', () => {
    expect(rankSodaSuggestCandidates(CANDIDATES, '晴天', 2)).toHaveLength(2)
    expect(rankSodaSuggestCandidates([], '晴天', 8)).toEqual([])
    expect(rankSodaSuggestCandidates(CANDIDATES, '', 8)).toHaveLength(3)
  })

  it('type 非法值兜底为 song', () => {
    const malformed = [{ text: '未知类别', type: 'vibe' }] as unknown as SodaSearchSuggestion[]
    const ranked = rankSodaSuggestCandidates(malformed, '未知', 8)
    expect(ranked[0].type).toBe('song')
  })
})
