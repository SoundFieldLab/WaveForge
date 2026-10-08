/**
 * 3.C 酷狗个人中心/最近播放/评论/歌单写操作的客户端映射单测。
 * fixture 按 D:\opencode\.tmp-kugou-endpoints.md 的实测响应结构手写（字段名取自真实响应，值全部为编造样例）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildKugouSongLink,
  collectKugouPlaylist,
  fetchKugouComments,
  fetchKugouPlayRecords,
  fetchKugouUserCloud,
  mapKugouCommentItem,
  mapKugouPlayRecord,
  parseKugouCollectionOwner,
  parseKugouCommentAddtime,
  uploadKugouPlayRecord,
} from '../src/services/kugouService'

const jsonResponse = (data: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => data,
})

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  // 概念版凭据：写操作/最近播放都要求登录态
  localStorage.setItem('kugou_concept_credential', JSON.stringify({ token: 'tk', userid: '123', mid: '456', guid: 'G' }))
})

describe('mapKugouPlayRecord（playhistory get_songs → 领域对象）', () => {
  it('映射 mxid/ot/info 字段与权限接口封面兜底，丢弃缺 hash 或歌名的条目', () => {
    const record = mapKugouPlayRecord({
      mxid: 998877,
      ot: 1759800000,
      pc: 3,
      info: {
        hash: 'ABCDEF0123456789ABCDEF0123456789',
        name: '样例歌曲',
        singername: '样例歌手',
        album_id: '5566',
        timelen: 245000,
        singerinfo: [{ id: 777, name: '样例歌手' }],
        trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/c.jpg' },
      },
    })
    expect(record).toMatchObject({
      mxid: 998877,
      ot: 1759800000,
      pc: 3,
      track: {
        hash: 'abcdef0123456789abcdef0123456789',
        songName: '样例歌曲',
        singerName: '样例歌手',
        singerId: '777',
        albumId: '5566',
        albumAudioId: 998877,
        duration: 245,
        coverUrl: 'https://imge.kugou.com/stdmusic/400/c.jpg',
      },
    })
    expect(mapKugouPlayRecord({ mxid: 1, info: { hash: '', name: 'x' } })).toBeNull()
    expect(mapKugouPlayRecord({ mxid: 1, info: { hash: 'aa', name: '' } })).toBeNull()
  })
})

describe('fetchKugouPlayRecords（/concept/history → 记录 + bp 翻页）', () => {
  it('透传 hasMore/bp 并映射记录列表', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      hasMore: true,
      bp: 'next-page-token',
      songs: [{ mxid: 11, ot: 100, pc: 1, info: { hash: 'AA11', name: '很久以前' } }],
    }))
    const result = await fetchKugouPlayRecords('prev-token')
    expect(result.hasMore).toBe(true)
    expect(result.bp).toBe('next-page-token')
    expect(result.records).toHaveLength(1)
    expect(result.records[0].track.songName).toBe('很久以前')
    // 请求体带上了翻页 bp
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.bp).toBe('prev-token')
    expect(body.credential.userid).toBe('123')
  })
})

describe('uploadKugouPlayRecord（/playrecord/upload）', () => {
  it('带 Song.kugouMixSongId 时用它作为 mxid', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, code: 1, mxid: 998877 }))
    const ok = await uploadKugouPlayRecord({ mid: 'aabb', kugouMixSongId: 998877 } as never)
    expect(ok).toBe(true)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.mxid).toBe(998877)
    expect(body.ot).toBeGreaterThan(0)
  })

  it('缺 mxid 时只带 hash（由服务端反查）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, code: 1 }))
    await uploadKugouPlayRecord({ mid: 'AABBCC' } as never)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.hash).toBe('AABBCC')
    expect(body.mxid).toBeUndefined()
  })

  it('未登录（无概念版凭据）直接返回 false 且不发请求', async () => {
    localStorage.removeItem('kugou_concept_credential')
    const ok = await uploadKugouPlayRecord({ mid: 'aabb', kugouMixSongId: 1 } as never)
    expect(ok).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('mapKugouCommentItem / fetchKugouComments', () => {
  it('映射实测评论字段（like.count/haslike、reply_num、special_child_id、addtime 秒）', () => {
    const comment = mapKugouCommentItem({
      id: 321,
      content: '好听',
      addtime: 1759800000,
      user_name: '听众',
      user_pic: 'http://imge.kugou.com/head.jpg',
      like: { count: 12, haslike: 1 },
      reply_num: 2,
      special_child_id: 'abc123',
    })
    expect(comment).toMatchObject({
      id: '321',
      content: '好听',
      addtime: 1759800000,
      userName: '听众',
      likeCount: 12,
      hasLiked: true,
      replyCount: 2,
      specialChildId: 'abc123',
    })
    expect(mapKugouCommentItem({})).toBeNull()
  })

  it('addtime 实测是日期串（也兼容 10/13 位时间戳），统一换算成秒', () => {
    const fromDate = parseKugouCommentAddtime('2026-01-10 00:50:09')
    expect(fromDate).toBeGreaterThan(1_700_000_000)
    expect(fromDate).toBeLessThan(1_900_000_000)
    expect(parseKugouCommentAddtime(1759800000)).toBe(1759800000)
    expect(parseKugouCommentAddtime(1759800000000)).toBe(1759800000)
    expect(parseKugouCommentAddtime('')).toBe(0)
    expect(parseKugouCommentAddtime('not-a-date')).toBe(0)
    // 只认 special_child_id：special_id（歌曲级）不能当 childrenid
    expect(mapKugouCommentItem({ id: 1, content: 'x', special_id: 2364 })?.specialChildId).toBe('')
  })

  it('列表接口映射 count/maxPage/childrenId 并过滤空条目（热词实测字段是 content）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        count: 391,
        maxPage: 14,
        childrenid: '461025803',
        hot_word_list: [{ content: '爷青回', count: 5 }],
        list: [
          { id: 1, content: 'a', addtime: 1, user_name: 'u', like: { count: 0 } },
          { id: 0, content: '' },
        ],
      },
    }))
    const result = await fetchKugouComments(998877, 2, 30)
    expect(result.total).toBe(391)
    expect(result.maxPage).toBe(14)
    expect(result.childrenId).toBe('461025803')
    expect(result.hotWords).toEqual([{ word: '爷青回', count: 5 }])
    expect(result.comments).toHaveLength(1)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.mixsongid).toBe(998877)
    expect(body.page).toBe(2)
  })

  it('缺少 mixsongid 时不发请求，返回可展示的错误原因', async () => {
    const result = await fetchKugouComments(0)
    expect(result.comments).toEqual([])
    expect(result.error).toBeTruthy()
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('parseKugouCollectionOwner（收藏歌单归属解析）', () => {
  it('解析 collection_3_<uid>_<listid>_0；公开 specialid 无法解析', () => {
    expect(parseKugouCollectionOwner('collection_3_811918369_2_0')).toEqual({
      ownerUserId: '811918369',
      listid: '2',
      gid: 'collection_3_811918369_2_0',
    })
    expect(parseKugouCollectionOwner('3855147')).toBeNull()
    expect(parseKugouCollectionOwner('')).toBeNull()
  })
})

describe('collectKugouPlaylist（收藏 / 取消收藏）', () => {
  it('收藏：从 collection id 解析归属并上送 add_list type=1 所需字段', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, listid: '2', globalCollectionId: 'collection_3_123_99_0' }))
    const result = await collectKugouPlaylist('collection_3_811918369_38_0', true, { name: '爵士歌单' })
    expect(result.success).toBe(true)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toMatchObject({ subscribe: true, ownerUserId: '811918369', listid: '38', name: '爵士歌单' })
  })

  it('收藏：公开 specialid 缺归属信息 → 明确失败，不发请求', async () => {
    const result = await collectKugouPlaylist('3855147', true)
    expect(result.success).toBe(false)
    expect(result.error).toContain('归属')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('取消收藏：只按 listid 走 delete 分支', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, listid: '38' }))
    const result = await collectKugouPlaylist('collection_3_811918369_38_0', false)
    expect(result.success).toBe(true)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toEqual({ credential: expect.anything(), subscribe: false, listid: '38' })
  })
})

describe('fetchKugouUserCloud（空盘 data.list === "" 是正常空态）', () => {
  it('空字符串 list → success + empty，不抛错', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, empty: true, songs: [], total: 0 }))
    const result = await fetchKugouUserCloud(1, 30)
    expect(result.empty).toBe(true)
    expect(result.songs).toEqual([])
  })
})

describe('buildKugouSongLink（复制链接）', () => {
  it('hash + album_id 生成官方网页链接；缺 hash 返回空串', () => {
    expect(buildKugouSongLink({ mid: 'ABCD', album: { mid: '5566' } }))
      .toBe('https://www.kugou.com/song/#hash=ABCD&album_id=5566')
    expect(buildKugouSongLink({ mid: 'ABCD' })).toBe('https://www.kugou.com/song/#hash=ABCD')
    expect(buildKugouSongLink({})).toBe('')
  })
})
