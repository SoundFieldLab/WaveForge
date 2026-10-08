/**
 * 酷狗评论全功能（写操作 + 排序读）客户端单测。
 * fixture 按 2026-10-07 实测响应手写（commentsv3/add、commentsv2/reply、mlike handlelike、
 * commentsv2/delcomment、H5 topliked、web getCommentWithLike、get_hot_word），值全部为编造样例。
 * 覆盖：请求参数构造（本地路由 body 字段名）、成功/失败判定、上游错误码透传、条目映射。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  deleteKugouCommentItem,
  fetchKugouHotComments,
  fetchKugouHotWordComments,
  fetchKugouLatestComments,
  likeKugouCommentItem,
  mapKugouCommentItem,
  replyKugouComment,
  sendKugouComment,
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
  // 写操作要求概念版登录态（未登录时服务层直接拒绝、不发请求）
  localStorage.setItem('kugou_concept_credential', JSON.stringify({ token: 'tk', userid: '123', mid: '456', guid: 'G' }))
})

describe('mapKugouCommentItem（web 列表扩展字段）', () => {
  it('映射 images[0].url 与 IP 属地（web getCommentWithLike 实测下发）', () => {
    const comment = mapKugouCommentItem({
      id: '1250180517',
      content: '带图评论',
      addtime: '2026-10-07 11:28:06',
      user_name: '听众',
      like: { count: 3, haslike: false },
      reply_num: 1,
      special_child_id: '461025803',
      location: '江苏',
      images: [{ url: 'https://cmtimg.kugou.com/a.jpg', height: 1600 }],
    })
    expect(comment).toMatchObject({
      id: '1250180517',
      location: '江苏',
      picUrl: 'https://cmtimg.kugou.com/a.jpg',
    })
    // images 是空串（无图）时不产生 picUrl
    expect(mapKugouCommentItem({ id: 2, content: 'x', images: '' })?.picUrl).toBeUndefined()
  })
})

describe('sendKugouComment（发表，commentsv3/add）', () => {
  it('上送 mixsongid+content，成功带回 addid', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, id: '1250179241' }))
    const result = await sendKugouComment(756594047, '  联调评论  ')
    expect(result).toEqual({ success: true, id: '1250179241' })
    const [url, init] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/api/kugou/concept/comment/send')
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ mixsongid: 756594047, content: '联调评论' })
    expect(body.credential).toMatchObject({ token: 'tk', userid: '123' })
  })

  it('上游失败（如频控 60062）透出原始错误信息与错误码', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: false, error: '评论过于频繁请稍候', errorCode: 60062 }, false, 400))
    const result = await sendKugouComment(756594047, 'x')
    expect(result.success).toBe(false)
    expect(result.error).toBe('评论过于频繁请稍候')
    expect(result.errorCode).toBe(60062)
  })

  it('未登录不发请求', async () => {
    localStorage.removeItem('kugou_concept_credential')
    const result = await sendKugouComment(1, 'x')
    expect(result.success).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('replyKugouComment（回复，commentsv2/reply）', () => {
  it('回复楼层带上被回复对象 id 与所属顶级评论 id（pid）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, id: '1250180975' }))
    const result = await replyKugouComment(756594047, { commentId: '736523307', pid: '1066169973', content: '回复楼层' })
    expect(result.success).toBe(true)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toMatchObject({ mixsongid: 756594047, comment_id: '736523307', pid: '1066169973', content: '回复楼层' })
  })

  it('回复顶级评论时 pid 缺省为 0（is_t 由服务端按 pid 推导）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, id: '1' }))
    await replyKugouComment(756594047, { commentId: '1066169973', content: '回复主楼' })
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.pid).toBe('0')
  })
})

describe('likeKugouCommentItem（点赞，mlike handlelike toggle）', () => {
  it('上送评论 id + special_id + 期望态，回传服务端最终 isLiked', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, isLiked: true }))
    const result = await likeKugouCommentItem('1066169973', '461025803', true)
    expect(result).toEqual({ success: true, isLiked: true })
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toEqual({ credential: expect.anything(), comment_id: '1066169973', special_id: '461025803', liked: true })
  })

  it('缺 special_id 直接拒绝（上游 hot_replylist/handlelike 都要求 childrenid）', async () => {
    const result = await likeKugouCommentItem('1066169973', '', true)
    expect(result.success).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('deleteKugouCommentItem（删除，commentsv2/delcomment）', () => {
  it('上送评论 id 与 special_id', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true }))
    const result = await deleteKugouCommentItem('1250179241', '461025803')
    expect(result.success).toBe(true)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.comment_id).toBe('1250179241')
    expect(body.special_id).toBe('461025803')
  })
})

describe('排序读（推荐 cmtlist / 最热 topliked / 最新 getCommentWithLike / 热词 get_hot_word）', () => {
  it('fetchKugouHotComments：special_id 必传，映射 tags chips（实测下发 全部/最热）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        list: [{ id: 1066169973, content: '热评', addtime: 1759800000, user_name: 'Rs', like: { count: 234, haslike: 0 }, reply_num: 26, special_child_id: '461025803' }],
        count: 312,
        tags: [{ name: '全部', count: 312, type: 'default' }, { name: '最热', count: 312 }],
        current_page: 1,
      },
    }))
    const result = await fetchKugouHotComments(756594047, '461025803', 1, 30)
    expect(result.total).toBe(312)
    expect(result.tags).toEqual([{ word: '全部', count: 312 }, { word: '最热', count: 312 }])
    expect(result.comments).toHaveLength(1)
    expect(result.comments[0]).toMatchObject({ likeCount: 234, replyCount: 26 })
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toMatchObject({ special_id: '461025803', page: 1, pagesize: 30 })
  })

  it('fetchKugouHotComments：缺 special_id 不发请求', async () => {
    const result = await fetchKugouHotComments(756594047, '', 1, 30)
    expect(result.comments).toEqual([])
    expect(result.error).toBeTruthy()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetchKugouLatestComments：映射 web 列表（cid 字符串、IP 属地）', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      success: true,
      data: {
        list: [{ id: '1250180517', content: '新评', addtime: '2026-10-02 23:34:40', user_name: '安小达', like: { count: 0 }, location: '江苏', special_child_id: '461025803' }],
        count: 232,
        childrenid: '461025803',
      },
    }))
    const result = await fetchKugouLatestComments(756594047, 1, 30)
    expect(result.total).toBe(232)
    expect(result.childrenId).toBe('461025803')
    expect(result.comments[0]).toMatchObject({ id: '1250180517', location: '江苏' })
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body).toMatchObject({ mixsongid: 756594047, page: 1 })
  })

  it('fetchKugouHotWordComments：上送 hot_word', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ success: true, data: { list: [], count: 5 } }))
    const result = await fetchKugouHotWordComments(756594047, '真夜中', 1, 30)
    expect(result.total).toBe(5)
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.hot_word).toBe('真夜中')
  })
})
