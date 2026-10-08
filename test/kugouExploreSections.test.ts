/**
 * 酷狗探索页五板块（乐库/歌单/频道/分类/每日推荐）数据映射单测。
 * 覆盖 src/services/kugouService.ts 新增的概念版薄封装，以及 exploreApi 的分类歌单标签筛选。
 * fixture 按实测响应结构手写（字段名取自真实响应，值全部为编造样例）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchKugouChannels,
  fetchKugouDailyRecommend,
  fetchKugouNewSongs,
  fetchKugouPlaylistsByTag,
  fetchKugouPlaylistTags,
  fetchKugouSingerList,
} from '../src/services/kugouService'
import { fetchKugouTagPlaylists } from '../src/services/exploreApi'

const jsonResponse = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
})

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
})

describe('fetchKugouDailyRecommend（/concept/daily → KugouTrack）', () => {
  it('映射 song_list 的歌名/歌手/封面/时长，跳过缺 hash 或歌名的条目', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        creation_date: '20261007',
        song_list: [
          {
            hash: 'ABCDEF0123456789ABCDEF0123456789',
            songname: '样例歌曲',
            author_name: '样例歌手',
            album_name: '样例专辑',
            album_id: '123456',
            album_audio_id: 998877,
            time_length: 245,
            trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/cover.jpg' },
            singerinfo: [{ id: '777', name: '样例歌手' }],
            hash_320: 'FFFEEEDDCCBBAA998877665544332211',
          },
          { hash: '', songname: '缺 hash' },
          { hash: 'HASHONLY1234567890', songname: '' },
        ],
      },
    }))

    const result = await fetchKugouDailyRecommend()
    expect(result.date).toBe('20261007')
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0]).toMatchObject({
      hash: 'ABCDEF0123456789ABCDEF0123456789',
      songName: '样例歌曲',
      singerName: '样例歌手',
      singerId: '777',
      albumName: '样例专辑',
      albumId: '123456',
      albumAudioId: 998877,
      duration: 245,
      coverUrl: 'https://imge.kugou.com/stdmusic/400/cover.jpg',
    })
  })

  it('接口失败（502）时返回空数组且不抛错：由板块展示空态', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false, error: '酷狗接口失败' }, false, 502))
    await expect(fetchKugouDailyRecommend()).resolves.toEqual({ songs: [] })
  })
})

describe('fetchKugouChannels（/concept/channels → 频道卡片）', () => {
  it('上游对无订阅账号返回 status!=1（502）→ 空列表 + error，不抛错（UI 空态）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false, error: '酷狗接口失败' }, false, 502))
    const result = await fetchKugouChannels(1, 30)
    expect(result.channels).toEqual([])
    expect(result.error).toBeTruthy()
  })

  it('有数据时映射 id/名称/封面/分组，过滤缺 id 或名称的条目', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [
        { channel_id: 9, channel_name: '深夜频道', cover: 'http://imge.kugou.com/{size}/c.jpg', tag_name: '心情', play_count: 1234 },
        { channel_id: '', channel_name: '缺 id' },
      ],
    }))
    const result = await fetchKugouChannels()
    expect(result.channels).toHaveLength(1)
    expect(result.channels[0]).toMatchObject({ id: '9', name: '深夜频道', group: '心情', playCount: 1234 })
  })
})

describe('fetchKugouPlaylistTags（/concept/playlist/tags → 分组标签树）', () => {
  it('按 son 展开子标签，丢弃无子标签的分组', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [
        { tag_id: '5', tag_name: '场景', son: [{ tag_id: '587', tag_name: '学习' }, { tag_id: '660', tag_name: '工作' }] },
        { tag_id: '9', tag_name: '空分组', son: [] },
      ],
    }))
    const result = await fetchKugouPlaylistTags()
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0].name).toBe('场景')
    expect(result.groups[0].tags).toEqual([{ id: '587', name: '学习' }, { id: '660', name: '工作' }])
  })
})

describe('fetchKugouPlaylistsByTag（/concept/playlist/by-tag → 分类歌单）', () => {
  it('映射歌单标签/播放量/创建者，并透传 hasNext', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      hasNext: true,
      data: [{
        specialid: 4893706,
        global_collection_id: 'collection_3_1_38_0',
        specialname: '咖啡配爵士',
        imgurl: 'http://imge.kugou.com/soft/collection/{size}/a.jpg',
        play_count: 9413765,
        songcount: 42,
        nickname: '样例用户',
        intro: '样例简介',
        tags: [{ tag_name: '爵士', tag_id: 32 }, { tag_name: '英语', tag_id: 20 }],
      }],
    }))
    const result = await fetchKugouPlaylistsByTag(0, 1, 100)
    expect(result.hasNext).toBe(true)
    expect(result.playlists[0]).toMatchObject({
      specialid: '4893706',
      globalSpecialId: 'collection_3_1_38_0',
      name: '咖啡配爵士',
      playCount: 9413765,
      trackCount: 42,
      creator: '样例用户',
      tags: ['爵士', '英语'],
    })
  })
})

describe('fetchKugouSingerList（/concept/singers → 歌手目录）', () => {
  it('跨分组去重，保留首次出现的歌手', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [
        { title: 'A', singer: [{ singerid: 3520, singername: '周杰伦', imgurl: 'http://singerimg.kugou.com/{size}/a.jpg', fanscount: 100 }] },
        { title: 'B', singer: [{ singerid: 3520, singername: '周杰伦' }, { singerid: 3060, singername: '陈奕迅', fanscount: 50 }] },
      ],
    }))
    const result = await fetchKugouSingerList(40)
    expect(result.singers.map(singer => singer.singername)).toEqual(['周杰伦', '陈奕迅'])
    expect(result.singers[0].coverUrl).toContain('/400/')
  })
})

describe('fetchKugouNewSongs（/concept/newsongs → 乐库新歌速递）', () => {
  it('映射曲目与发布时间', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      total: 1,
      data: [{
        hash: 'AA11BB22CC33DD44EE55FF6677889900',
        songname: '我们在场',
        authors: [{ author_id: 169967, author_name: '周深' }],
        album_name: '我们在场',
        album_id: '207873836',
        timelength: '00:03:20',
        publish_date: '2026-10-02',
        album_sizable_cover: 'http://imge.kugou.com/stdmusic/{size}/n.jpg',
      }],
    }))
    const result = await fetchKugouNewSongs(21608, 1, 60)
    expect(result.songs).toHaveLength(1)
    expect(result.songs[0].publishDate).toBe('2026-10-02')
    expect(result.songs[0].track).toMatchObject({ songName: '我们在场', singerName: '周深', singerId: '169967' })
  })
})

describe('exploreApi.fetchKugouTagPlaylists（分类歌单客户端标签筛选）', () => {
  it('按歌单自带标签过滤，并把概念版 collection id 带进概念版曲目通道', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      hasNext: false,
      data: [
        { specialid: 1, global_collection_id: 'collection_3_1_1_0', specialname: '爵士歌单', tags: [{ tag_name: '爵士' }] },
        { specialid: 2, global_collection_id: 'collection_3_1_2_0', specialname: '摇滚歌单', tags: [{ tag_name: '摇滚' }] },
      ],
    }))
    const result = await fetchKugouTagPlaylists('摇滚', 1)
    expect(result.playlists).toHaveLength(1)
    expect(result.playlists[0]).toMatchObject({ id: '2', conceptId: 'collection_3_1_2_0', tags: ['摇滚'], platform: 'kugou' })
  })

  it('tag=null 返回整页推荐池', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      hasNext: true,
      data: [
        { specialid: 1, specialname: '歌单一', tags: [{ tag_name: '爵士' }] },
        { specialid: 2, specialname: '歌单二', tags: [] },
      ],
    }))
    const result = await fetchKugouTagPlaylists(null, 1)
    expect(result.playlists).toHaveLength(2)
    expect(result.hasNext).toBe(true)
  })
})
