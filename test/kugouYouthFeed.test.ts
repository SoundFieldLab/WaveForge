/**
 * 3.E 酷狗刷歌（youth 动态流）单测：
 * 1) 卡片解析：数组透传 + 多形态结构识别（参考形态 / 嵌套形态 / 完全未知），不硬编码字段名、不丢卡片；
 * 2) 客户端薄封装：空列表是正常结果（empty=true，不是 error），上报已听带 mixsongid；
 * 3) store：空态、open 自动拉流、已听只上报一次、is_end 时不翻页；
 * 4) 平台隔离：板块/入口只在 kugou 下挂载（源码守卫，与五板块同一套做法）。
 */
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchKugouYouthDynamic,
  fetchKugouYouthRecent,
  parseKugouYouthCard,
  parseKugouYouthCards,
  reportKugouYouthListen,
} from '../src/services/kugouService'
import { createKugouYouthStore } from '../src/features/kugouYouth/store'

const HASH = '0123456789abcdef0123456789abcdef'

const jsonResponse = (data: unknown, ok = true, status = 200) => ({ ok, status, json: async () => data })
const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  localStorage.setItem('kugou_concept_credential', JSON.stringify({ token: 'tk', userid: '123', mid: '456', guid: 'G' }))
})

describe('parseKugouYouthCards（数组透传 + 多形态兼容解析）', () => {
  it('参考形态（hash/audio_id/author_name/authors[]/audio_info{}）能识别出可播放曲目', () => {
    const card = parseKugouYouthCard({
      hash: HASH,
      audio_id: 998877,
      author_name: '样例歌手',
      authors: [{ author_name: '样例歌手' }],
      audio_info: { name: '样例歌曲', timelen: 215000, cover: 'https://example.test/c.jpg' },
    })
    expect(card.song).not.toBeNull()
    expect(card.song?.name).toBe('样例歌曲')
    expect(card.song?.mid).toBe(HASH)
    expect(card.song?.artists[0]?.name).toBe('样例歌手')
    expect(card.song?.duration).toBe(215000)
    expect(card.song?.album.picUrl).toBe('https://example.test/c.jpg')
    expect(card.mixsongid).toBe(998877)
    expect(card.raw).toEqual(expect.objectContaining({ hash: HASH }))
  })

  it('嵌套形态（card.song 里面才有 hash/songname/singername）同样能识别，时长按秒处理', () => {
    const card = parseKugouYouthCard({
      card: { type: 1, song: { file_hash: HASH.toUpperCase(), songname: '嵌套歌曲', singername: '嵌套歌手', duration: 240 } },
    })
    expect(card.song?.name).toBe('嵌套歌曲')
    expect(card.song?.mid).toBe(HASH)
    expect(card.song?.artists[0]?.name).toBe('嵌套歌手')
    expect(card.song?.duration).toBe(240000)
    expect(card.mixsongid).toBe(0)
  })

  it('完全未知形态：不猜字段、不丢卡片——song 为 null，raw 原样保留，标题用原始首个文案兜底', () => {
    const raw = { foo: 'bar', nested: { id: 7 } }
    const card = parseKugouYouthCard(raw)
    expect(card.song).toBeNull()
    expect(card.raw).toBe(raw)
    expect(card.title).toBe('bar')
    expect(card.mixsongid).toBe(0)
  })

  it('非数组/空输入返回空数组（上游 list 恒空时不得抛错）', () => {
    expect(parseKugouYouthCards(null)).toEqual([])
    expect(parseKugouYouthCards(undefined)).toEqual([])
    expect(parseKugouYouthCards([])).toEqual([])
  })

  it('混合数组逐条解析：识别不出的条目仍在结果里（不静默丢弃）', () => {
    const cards = parseKugouYouthCards([
      { hash: HASH, name: '可识别', singer_name: '歌手' },
      { unknown: '结构', only: 1 },
    ])
    expect(cards).toHaveLength(2)
    expect(cards[0].song?.name).toBe('可识别')
    expect(cards[1].song).toBeNull()
  })
})

describe('客户端薄封装（fetchKugouYouthDynamic / fetchKugouYouthRecent / reportKugouYouthListen）', () => {
  it('空 list 是正常结果：empty=true、error 为空（空态靠 empty 而不是错误）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, list: [], isEnd: true, lastCid: '' }))
    const feed = await fetchKugouYouthDynamic()
    expect(feed.cards).toEqual([])
    expect(feed.empty).toBe(true)
    expect(feed.isEnd).toBe(true)
    expect(feed.error).toBeUndefined()
    const [url] = mockFetch.mock.calls[0]
    expect(String(url)).toContain('/kugou/concept/youth/dynamic')
  })

  it('lastCid 只在翻页时随请求带上（首屏不臆造 last_cid 参数）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, list: [], isEnd: false, lastCid: 'next-cid' }))
    const feed = await fetchKugouYouthDynamic('abc')
    const [, init] = mockFetch.mock.calls[0]
    expect(JSON.parse(init.body).last_cid).toBe('abc')
    expect(feed.lastCid).toBe('next-cid')
    expect(feed.isEnd).toBe(false)
  })

  it('最近动态与上报已听走各自的 POST 路由（上报带 mixsongid）', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true, list: [] }))
    const recent = await fetchKugouYouthRecent()
    expect(recent.empty).toBe(true)
    expect(String(mockFetch.mock.calls[0][0])).toContain('/kugou/concept/youth/recent')

    mockFetch.mockResolvedValueOnce(jsonResponse({ success: true }))
    const ok = await reportKugouYouthListen(998877)
    expect(ok).toBe(true)
    const [, init] = mockFetch.mock.calls[1]
    expect(JSON.parse(init.body)).toEqual({ credential: expect.objectContaining({ token: 'tk' }), mixsongid: 998877 })
  })

  it('缺 mixsongid 时不上报（不发请求）', async () => {
    expect(await reportKugouYouthListen(0)).toBe(false)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe('createKugouYouthStore（空态 / 起播上报 / 翻页）', () => {
  it('open 触发一次拉流；空流落到 empty 态且 error 为空', async () => {
    const fetchDynamic = vi.fn(async () => ({ cards: [], isEnd: true, lastCid: '', empty: true }))
    const store = createKugouYouthStore({ fetchDynamic, fetchRecent: async () => ({ cards: [], empty: true }), reportListen: async () => true })
    expect(store.getState().open).toBe(false)
    store.open()
    await vi.waitFor(() => expect(store.getState().loading).toBe(false))
    expect(fetchDynamic).toHaveBeenCalledTimes(1)
    expect(fetchDynamic).toHaveBeenCalledWith('')
    const state = store.getState()
    expect(state.open).toBe(true)
    expect(state.empty).toBe(true)
    expect(state.error).toBe('')
    expect(state.cards).toEqual([])
    expect(state.index).toBe(-1)
  })

  it('select 对同一 mixsongid 只上报一次（会话内去重）', async () => {
    const card = parseKugouYouthCard({ hash: HASH, name: '歌曲A', audio_id: 123 })
    const reportListen = vi.fn(async () => true)
    const store = createKugouYouthStore({
      fetchDynamic: async () => ({ cards: [card], isEnd: true, lastCid: '', empty: false }),
      fetchRecent: async () => ({ cards: [], empty: true }),
      reportListen,
    })
    await store.refresh()
    expect(reportListen).toHaveBeenCalledTimes(1)
    expect(reportListen).toHaveBeenCalledWith(123)
    store.select(0)
    await Promise.resolve()
    expect(reportListen).toHaveBeenCalledTimes(1)
  })

  it('is_end=true 或没有 last_cid 时不翻页；翻页结果按 raw 去重追加', async () => {
    const first = parseKugouYouthCard({ hash: HASH, name: '歌曲A' })
    const second = parseKugouYouthCard({ hash: 'fedcba9876543210fedcba9876543210', name: '歌曲B' })
    const fetchDynamic = vi.fn(async (lastCid?: string) => lastCid === ''
      ? { cards: [first], isEnd: false, lastCid: 'p2', empty: false }
      : { cards: [first, second], isEnd: true, lastCid: '', empty: false })
    const store = createKugouYouthStore({ fetchDynamic, fetchRecent: async () => ({ cards: [], empty: true }), reportListen: async () => true })
    await store.refresh()
    await store.loadMore()
    expect(fetchDynamic).toHaveBeenLastCalledWith('p2')
    expect(store.getState().cards).toHaveLength(2)
    await store.loadMore()
    expect(fetchDynamic).toHaveBeenCalledTimes(2)
    expect(store.getState().isEnd).toBe(true)
  })
})

describe('刷歌下线后的平台隔离（源码守卫）', () => {
  const source = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8')

  it('探索页酷狗一级分区只剩「音乐 / 听书」，刷歌不再挂载', () => {
    const explore = source('ExploreView.tsx')
    expect(explore).toContain("import KugouExplorePage from '../features/kugouExplore/KugouExplorePage'")
    expect(explore).toContain('<KugouExplorePage')
    const page = readFileSync(new URL('../src/features/kugouExplore/KugouExplorePage.tsx', import.meta.url), 'utf8')
    // 刷歌（kugouYouth）已按产品决策下线：外壳不再 import/挂载 Board 与 Overlay
    expect(page).not.toContain("import KugouYouthFeedBoard from '../kugouYouth/KugouYouthFeedBoard'")
    expect(page).not.toContain('<KugouYouthFeedBoard')
    expect(page).not.toContain('<KugouYouthFeedOverlay')
    expect(page).toContain("from '../kugouLongaudio/KugouLongaudioBoard'")
  })

  it('传统模式酷狗左栏不再有刷歌导航项与全屏入口', () => {
    const traditional = source('TraditionalView.tsx')
    expect(traditional).not.toContain("import { KugouYouthTraditionalOverlay } from '../features/kugouYouth/KugouYouthTraditionalEntry'")
    expect(traditional).not.toContain('<KugouYouthTraditionalOverlay')
    const sidebar = readFileSync(new URL('../src/features/traditionalPc/KugouPcSidebar.tsx', import.meta.url), 'utf8')
    expect(sidebar).not.toContain("import { KugouYouthNavButton } from '../kugouYouth/KugouYouthTraditionalEntry'")
    expect(sidebar).not.toContain('<KugouYouthNavButton')
  })
})
