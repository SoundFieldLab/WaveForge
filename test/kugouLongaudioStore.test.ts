/**
 * 独立听书 store 的行为单测（node 环境，不依赖真实音频/网络）：
 * 浏览卡片墙分页与分类筛选、专辑+章节加载、章节切换（播放/上一章/下一章/自动续页）、
 * 直链失败如实报错、倍速钳制、退出听书不打断主播放器（只暂停自己的音频）。
 * fixture 字段名取自 2026-10-07 实测响应，值全部为编造样例。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createKugouLongaudioStore,
  selectBrowseTags,
  selectVisibleBrowseAlbums,
  type KugouLongaudioDeps,
  type LongaudioAudioLike,
  type LongaudioRecentAlbum,
} from '../src/features/kugouLongaudio/store'
import type {
  KugouLongaudioAlbum,
  KugouLongaudioAlbumDetail,
  KugouLongaudioChapter,
} from '../src/services/kugouService'

const makeAlbum = (albumId: string, name: string, tag: string, isPaid = false): KugouLongaudioAlbum => ({
  albumId,
  name,
  author: '样例主播',
  authors: ['样例主播'],
  coverUrl: `https://example.test/${albumId}.jpg`,
  intro: '样例简介',
  playCount: 123456,
  chapterCount: 3,
  isPaid,
  primaryTag: tag,
  tags: [tag],
})

const makeChapter = (index: number, hash: string): KugouLongaudioChapter => ({
  hash,
  albumAudioId: 1000 + index,
  name: `第${index + 1}集 样例章节`,
  duration: 300,
  sort: index + 1,
  disc: 1,
  payType: 0,
  privilege: 0,
})

const makeDetail = (albumId: string, name: string): KugouLongaudioAlbumDetail => ({
  albumId,
  name,
  author: '样例主播',
  authors: ['样例主播'],
  coverUrl: `https://example.test/${albumId}.jpg`,
  intro: '专辑简介',
  playCount: 987654,
  tags: ['玄幻异界'],
  isPublished: true,
  isPaid: false,
})

/** 可观测的假音频元素：记录 play/pause 调用与 src，支持手动派发 ended */
function createFakeAudio(): LongaudioAudioLike & {
  handlers: Map<string, Set<() => void>>
  emit: (type: string) => void
  playCalls: number
  pauseCalls: number
} {
  const handlers = new Map<string, Set<() => void>>()
  const element = {
    src: '',
    currentTime: 0,
    duration: 0,
    playbackRate: 1,
    paused: true,
    playCalls: 0,
    pauseCalls: 0,
    handlers,
    play: async () => {
      element.playCalls += 1
      element.paused = false
    },
    pause: () => {
      element.pauseCalls += 1
      element.paused = true
    },
    addEventListener: (type: string, handler: () => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type)!.add(handler)
    },
    removeEventListener: (type: string, handler: () => void) => {
      handlers.get(type)?.delete(handler)
    },
    emit: (type: string) => {
      handlers.get(type)?.forEach(handler => handler())
    },
  }
  return element
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function buildStore(overrides: Partial<KugouLongaudioDeps> = {}) {
  const audio = createFakeAudio()
  const onBeforePlay = vi.fn()
  const writeRecent = vi.fn()
  let recent: LongaudioRecentAlbum[] = []
  const deps: Partial<KugouLongaudioDeps> = {
    fetchDaily: vi.fn(async (page: number) => ({
      albums: page === 1
        ? [makeAlbum('1', '玄界之门', '玄幻异界'), makeAlbum('2', '助眠雨声', '自然疗愈', true)]
        : [makeAlbum('3', '都市医仙', '都市纵横')],
      hasMore: page === 1,
    })),
    fetchAlbumDetail: vi.fn(async (albumId: string) => ({ album: makeDetail(albumId, '玄界之门') })),
    fetchChapters: vi.fn(async (_albumId: string, page: number) => ({
      chapters: page === 1 ? [makeChapter(0, 'HASH-A'), makeChapter(1, 'HASH-B')] : [makeChapter(2, 'HASH-C')],
      hasMore: page === 1,
    })),
    resolveUrl: vi.fn(async (hash: string) => ({ url: `https://cdn.example.test/${hash}.mp3` })),
    createAudio: () => audio,
    onBeforePlay,
    readRecent: () => recent,
    writeRecent: (albums) => { recent = albums; writeRecent(albums) },
    ...overrides,
  }
  return { store: createKugouLongaudioStore(deps), audio, onBeforePlay, deps, getRecent: () => recent }
}

describe('听书 store：浏览卡片墙', () => {
  it('首次加载第一页，分类胶囊按 tag_name 聚合且可客户端筛选', async () => {
    const { store } = buildStore()
    await store.ensureBrowseLoaded()
    const state = store.getState()
    expect(state.browse.albums.map(album => album.albumId)).toEqual(['1', '2'])
    expect(state.browse.hasMore).toBe(true)
    expect(selectBrowseTags(state).map(tag => tag.name)).toEqual(['玄幻异界', '自然疗愈'])

    store.setBrowseTag('玄幻异界')
    expect(selectVisibleBrowseAlbums(store.getState()).map(album => album.albumId)).toEqual(['1'])
    store.setBrowseTag(null)
    expect(selectVisibleBrowseAlbums(store.getState())).toHaveLength(2)
  })

  it('加载更多按 albumId 去重并停止在 hasMore=false', async () => {
    const { store } = buildStore()
    await store.ensureBrowseLoaded()
    await store.loadMoreBrowse()
    expect(store.getState().browse.albums.map(album => album.albumId)).toEqual(['1', '2', '3'])
    expect(store.getState().browse.hasMore).toBe(false)
  })

  it('上游失败时保留错误文案（不静默清空）', async () => {
    const { store } = buildStore({ fetchDaily: vi.fn(async () => ({ albums: [], hasMore: false, error: '上游 502' })) })
    await store.ensureBrowseLoaded()
    expect(store.getState().browse.error).toBe('上游 502')
  })
})

describe('听书 store：专辑与章节切换', () => {
  it('打开专辑加载详情 + 首屏章节，选中章节时解析直链并请求暂停主播放器', async () => {
    const { store, audio, onBeforePlay, getRecent } = buildStore()
    await store.openAlbum('1', { summary: makeAlbum('1', '玄界之门', '玄幻异界') })
    expect(store.getState().view).toBe('player')
    expect(store.getState().player.album?.albumId).toBe('1')
    expect(store.getState().player.chapters).toHaveLength(2)
    expect(store.getState().player.currentIndex).toBe(-1)

    await store.selectChapter(1)
    const state = store.getState()
    expect(state.player.currentIndex).toBe(1)
    expect(state.player.status).toBe('playing')
    expect(audio.src).toBe('https://cdn.example.test/HASH-B.mp3')
    expect(audio.playCalls).toBe(1)
    expect(onBeforePlay).toHaveBeenCalledTimes(1)
    // 播放后写入「我的听书」最近收听
    expect(getRecent().map((album: { albumId: string }) => album.albumId)).toEqual(['1'])
  })

  it('下一章越过已加载页时自动续页，最后一章停在末尾不再前进', async () => {
    const { store } = buildStore()
    await store.openAlbum('1')
    await store.selectChapter(1)
    await store.playNext()
    expect(store.getState().player.chapters).toHaveLength(3)
    expect(store.getState().player.currentIndex).toBe(2)

    await store.playNext()
    expect(store.getState().player.currentIndex).toBe(2)
    expect(store.getState().player.status).toBe('paused')
  })

  it('上一章在第一张时停在开头（不越界）', async () => {
    const { store } = buildStore()
    await store.openAlbum('1')
    await store.selectChapter(0)
    await store.playPrev()
    expect(store.getState().player.currentIndex).toBe(0)
  })

  it('章节自然播完后自动切下一章', async () => {
    const { store, audio } = buildStore()
    await store.openAlbum('1')
    await store.selectChapter(0)
    audio.emit('ended')
    await flush()
    expect(store.getState().player.currentIndex).toBe(1)
    expect(store.getState().player.status).toBe('playing')
  })

  it('直链解析失败时如实报错，且不打断主播放器', async () => {
    const { store, onBeforePlay } = buildStore({ resolveUrl: vi.fn(async () => ({ url: null, error: '该章节需要听书 VIP' })) })
    await store.openAlbum('1')
    await store.selectChapter(0)
    expect(store.getState().player.status).toBe('error')
    expect(store.getState().player.error).toBe('该章节需要听书 VIP')
    expect(onBeforePlay).not.toHaveBeenCalled()
  })

  it('暂停后再播放沿用已解析直链，不重复请求', async () => {
    const { store, audio, deps } = buildStore()
    await store.openAlbum('1')
    await store.selectChapter(0)
    await store.togglePlay()
    expect(store.getState().player.status).toBe('paused')
    const callsBefore = (deps.resolveUrl as ReturnType<typeof vi.fn>).mock.calls.length
    await store.togglePlay()
    expect(store.getState().player.status).toBe('playing')
    expect((deps.resolveUrl as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)
    expect(audio.playCalls).toBe(2)
  })

  it('倍速钳制在 0.75~2x 并作用到音频元素', async () => {
    const { store, audio } = buildStore()
    store.setRate(3)
    expect(store.getState().player.rate).toBe(2)
    expect(audio.playbackRate).toBe(2)
    store.setRate(0.5)
    expect(store.getState().player.rate).toBe(0.75)
    store.setRate(1.25)
    expect(store.getState().player.rate).toBe(1.25)
  })

  it('退出听书只暂停独立音频并保留专辑进度，主播放器状态不被回写', async () => {
    const { store, audio } = buildStore()
    await store.openAlbum('1')
    await store.selectChapter(0)
    store.exit()
    expect(store.getState().view).toBe('closed')
    expect(store.getState().player.status).toBe('paused')
    expect(audio.pauseCalls).toBeGreaterThan(0)
    expect(store.getState().player.album?.albumId).toBe('1')
    expect(store.getState().player.currentIndex).toBe(0)
  })

  it('「进入听书」有专辑进播放器、无专辑进我的听书', async () => {
    const { store } = buildStore()
    store.enter()
    expect(store.getState().view).toBe('library')
    store.openLibrary()
    expect(store.getState().view).toBe('library')
    await store.openAlbum('1')
    store.exit()
    store.enter()
    expect(store.getState().view).toBe('player')
  })
})
