/**
 * 酷狗听书服务层字段映射单测（mock fetch，走真实 kgConceptPost 路径）。
 * fixture 字段名取自 2026-10-07 实测响应（daily/album/audios），值全部为编造样例。
 * 重点：daily 的 is_pay→听书VIP 信号、详情接口 cover 只是文件名（必须用 sizable_cover）、
 * 章节 timelength 毫秒→秒、以及 hasMore 只能按满页推断（total 在响应体顶层、网关未透传）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchKugouLongaudioAlbumDetail,
  fetchKugouLongaudioChapters,
  fetchKugouLongaudioDaily,
  getKugouLongaudioUrl,
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
})

describe('fetchKugouLongaudioDaily（/concept/longaudio/daily）', () => {
  it('映射封面/作者/章节数/播放量/VIP 角标与分类标签，跳过缺 id 或名称的条目', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        is_end: 0,
        albums: [
          {
            album_id: 88314495,
            album_name: '催眠下雨声',
            author_name: '晚安安',
            sizable_cover: 'http://imge.kugou.com/stdmusic/{size}/20240302/abc.jpg',
            intro: '听着雨声入睡',
            play_count: 67594990,
            audio_total: 121,
            is_pay: 1,
            tag_info: { tag_id: 3311, tag_name: '自然疗愈' },
            album_label: { label_id: 146, label_name: '豪门' },
            publish_date: '2024-03-02',
            recommend_reason: '根据大家的口味推荐',
          },
          { album_id: '', album_name: '缺 id 的条目' },
          { album_id: 42, album_name: '' },
        ],
      },
    }))

    const result = await fetchKugouLongaudioDaily(1, 24)
    expect(result.hasMore).toBe(true)
    expect(result.albums).toHaveLength(1)
    const album = result.albums[0]
    expect(album.albumId).toBe('88314495')
    expect(album.name).toBe('催眠下雨声')
    expect(album.author).toBe('晚安安')
    expect(album.coverUrl).toBe('https://imge.kugou.com/stdmusic/400/20240302/abc.jpg')
    expect(album.chapterCount).toBe(121)
    expect(album.playCount).toBe(67594990)
    expect(album.isPaid).toBe(true)
    expect(album.primaryTag).toBe('自然疗愈')
    expect(album.tags).toEqual(['自然疗愈', '豪门'])
  })

  it('is_end=1 时不再翻页；上游失败返回 error 而不是抛异常', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: { is_end: 1, albums: [{ album_id: 1, album_name: 'A' }] } }))
    const done = await fetchKugouLongaudioDaily(2, 24)
    expect(done.hasMore).toBe(false)

    mockFetch.mockResolvedValueOnce(jsonResponse({ success: false, error: '酷狗接口失败' }, false, 502))
    const failed = await fetchKugouLongaudioDaily(1, 24)
    expect(failed.albums).toEqual([])
    expect(failed.error).toBe('酷狗接口失败')
  })
})

describe('fetchKugouLongaudioAlbumDetail（/concept/longaudio/album，data 是数组）', () => {
  it('详情 cover 只是文件名：封面走 sizable_cover，长简介优先 full_intro', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [
        {
          album_id: '88314495',
          album_name: '催眠下雨声',
          author_name: '晚安安',
          authors: [{ author_id: '6485856', author_name: '晚安' }],
          cover: '20240302083303887607.jpg',
          sizable_cover: 'http://imge.kugou.com/stdmusic/{size}/20240302/20240302083303887607.jpg',
          intro: '短简介',
          mix_intro: '混合简介',
          full_intro: '完整简介',
          play_times: 67594990,
          album_tag: [{ tag_id: '1070', tag_name: '助眠解压' }, { tag_id: '3311', tag_name: '自然疗愈' }],
          category: '2',
          language: '国语',
          publish_company: '样例唱片',
          is_publish: '1',
        },
      ],
    }))

    const { album } = await fetchKugouLongaudioAlbumDetail('88314495')
    expect(album?.name).toBe('催眠下雨声')
    expect(album?.coverUrl).toBe('https://imge.kugou.com/stdmusic/400/20240302/20240302083303887607.jpg')
    expect(album?.intro).toBe('完整简介')
    expect(album?.tags).toEqual(['助眠解压', '自然疗愈'])
    expect(album?.playCount).toBe(67594990)
    expect(album?.language).toBe('国语')
    expect(album?.isPublished).toBe(true)
  })

  it('上游返回空数组时给出可展示的错误', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: [] }))
    const { album, error } = await fetchKugouLongaudioAlbumDetail('1')
    expect(album).toBeNull()
    expect(error).toBe('上游没有返回该专辑')
  })
})

describe('fetchKugouLongaudioChapters（/concept/longaudio/audios）', () => {
  it('毫秒时长转秒，满页即推断还有下一页', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: Array.from({ length: 30 }, (_, index) => ({
        hash: `HASH${index}`,
        audio_id: 100 + index,
        album_audio_id: 200 + index,
        audio_name: `第${index + 1}集`,
        timelength: 256756,
        sort: index + 2,
        disc: 1,
        pay_type: 0,
        privilege: 0,
        trans_param: { union_cover: 'http://imge.kugou.com/stdmusic/{size}/x.jpg' },
      })),
    }))

    const result = await fetchKugouLongaudioChapters('88314495', 1, 30)
    expect(result.chapters).toHaveLength(30)
    expect(result.hasMore).toBe(true)
    expect(result.chapters[0].duration).toBe(257)
    expect(result.chapters[0].albumAudioId).toBe(200)
    expect(result.chapters[0].name).toBe('第1集')
  })

  it('不满页时不再翻页；缺 hash/名称的条目被跳过', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: [
        { hash: 'HASH-OK', audio_name: '第1集', timelength: 1000, sort: 1 },
        { hash: '', audio_name: '缺 hash' },
        { hash: 'HASH-NO-NAME', audio_name: '   ' },
      ],
    }))
    const result = await fetchKugouLongaudioChapters('1', 1, 30)
    expect(result.chapters).toHaveLength(1)
    expect(result.hasMore).toBe(false)
  })
})

describe('getKugouLongaudioUrl（/concept/longaudio/url）', () => {
  it('成功返回直链；403 时带上游错误文案', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ url: 'https://cdn.example.test/a.mp3', level: '128' }))
    await expect(getKugouLongaudioUrl('HASH', { albumId: '1' })).resolves.toEqual({ url: 'https://cdn.example.test/a.mp3' })

    mockFetch.mockResolvedValueOnce(jsonResponse({ error: '该章节需要听书 VIP' }, false, 403))
    const failed = await getKugouLongaudioUrl('HASH', { albumId: '1' })
    expect(failed.url).toBeNull()
    expect(failed.error).toBe('该章节需要听书 VIP')
  })

  it('缺 hash 时直接返回错误，不发请求', async () => {
    const result = await getKugouLongaudioUrl('')
    expect(result.url).toBeNull()
    expect(result.error).toBe('缺少章节 hash')
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
