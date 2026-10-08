/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 听书独立状态（浏览卡片墙 + 专辑章节 + 播放）。
 *
 * 设计要点（为什么这样写）：
 * - 听书用独立 `HTMLAudioElement`，**不复用**主播放器 store：主播放器的歌词/自动混音/
 *   共振/MV 都挂在它的状态机上，听书接进去会把章节当歌曲、污染播放历史与过渡策略。
 * - 切到听书时通过既有的 `waveforge:pause-main-playback` 事件请求 App 优雅暂停主音频
 *   （App 侧只在确实播放中才暂停），不写主播放器状态，退出听书也不回写。
 * - 数据访问与音频元素都可注入，便于在 node 环境下做纯逻辑单测。
 */
import {
  fetchKugouLongaudioAlbumDetail,
  fetchKugouLongaudioChapters,
  fetchKugouLongaudioDaily,
  getKugouLongaudioUrl,
  type KugouLongaudioAlbum,
  type KugouLongaudioAlbumDetail,
  type KugouLongaudioChapter,
} from '../../services/kugouService'

export const LONGAUDIO_RATE_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export const LONGAUDIO_MIN_RATE = 0.75
export const LONGAUDIO_MAX_RATE = 2
/** 「我的听书」最近收听记录（本地）：跨会话保留，退出听书不清空 */
export const LONGAUDIO_RECENT_KEY = 'waveforge.kugou.longaudio.recent'
const RECENT_LIMIT = 12
/** 章节分页大小：上游单页上限 100，取 30 与官方客户端首屏接近 */
export const LONGAUDIO_CHAPTER_PAGE_SIZE = 30
export const LONGAUDIO_DAILY_PAGE_SIZE = 24

export interface LongaudioRecentAlbum {
  albumId: string
  name: string
  coverUrl: string
  author: string
  chapterCount?: number
  /** 最近一次收听时间戳 */
  at: number
}

export interface LongaudioAudioLike {
  src: string
  currentTime: number
  duration: number
  playbackRate: number
  paused: boolean
  play: () => Promise<void> | void
  pause: () => void
  addEventListener: (type: string, handler: () => void) => void
  removeEventListener: (type: string, handler: () => void) => void
}

export type LongaudioStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface LongaudioBrowseState {
  albums: KugouLongaudioAlbum[]
  page: number
  hasMore: boolean
  loading: boolean
  error: string
  /** 分类胶囊：null = 全部；其余为 tag_info.tag_name 聚合值（上游无按分类拉取接口，客户端筛选） */
  tag: string | null
}

export interface LongaudioPlayerState {
  album: KugouLongaudioAlbumDetail | null
  albumLoading: boolean
  albumError: string
  chapters: KugouLongaudioChapter[]
  chapterPage: number
  chapterHasMore: boolean
  chaptersLoading: boolean
  chapterError: string
  /** -1 = 尚未选中任何章节（高亮不出现） */
  currentIndex: number
  status: LongaudioStatus
  error: string
  rate: number
  currentTime: number
  duration: number
}

export interface LongaudioState {
  view: 'closed' | 'player' | 'library'
  browse: LongaudioBrowseState
  player: LongaudioPlayerState
  recent: LongaudioRecentAlbum[]
  /** 当前正在播放/待播的专辑摘要（播放器页头与「我的听书」共用） */
  activeAlbum: { albumId: string; name: string; coverUrl: string; author: string; chapterCount?: number } | null
}

/** 局部更新：每个分片各自浅合并（不做深合并没有意义，字段都是扁平的） */
interface LongaudioPatch {
  view?: LongaudioState['view']
  browse?: Partial<LongaudioBrowseState>
  player?: Partial<LongaudioPlayerState>
  recent?: LongaudioRecentAlbum[]
  activeAlbum?: LongaudioState['activeAlbum']
}

type LongaudioAlbumSummary = { albumId: string; name: string; coverUrl: string; author: string; chapterCount?: number }

/** 可注入依赖：生产用真实服务 + `new Audio()`，单测注入假实现 */
export interface KugouLongaudioDeps {
  fetchDaily: (page: number, pagesize: number) => Promise<{ albums: KugouLongaudioAlbum[]; hasMore: boolean; error?: string }>
  fetchAlbumDetail: (albumId: string) => Promise<{ album: KugouLongaudioAlbumDetail | null; error?: string }>
  fetchChapters: (albumId: string, page: number, pagesize: number) => Promise<{ chapters: KugouLongaudioChapter[]; hasMore: boolean; error?: string }>
  resolveUrl: (hash: string, extra: { albumId?: string; albumAudioId?: number }) => Promise<{ url: string | null; error?: string }>
  createAudio: () => LongaudioAudioLike | null
  /** 请求主播放器优雅暂停（生产=派发 waveforge:pause-main-playback 事件） */
  onBeforePlay?: () => void
  readRecent: () => LongaudioRecentAlbum[]
  writeRecent: (albums: LongaudioRecentAlbum[]) => void
}

export interface KugouLongaudioStore {
  getState: () => LongaudioState
  subscribe: (listener: () => void) => () => void
  /** 听书首页（板块卡片墙）首次加载 / 重试 */
  ensureBrowseLoaded: (options?: { force?: boolean }) => Promise<void>
  loadMoreBrowse: () => Promise<void>
  setBrowseTag: (tag: string | null) => void
  /** 进入听书：有当前专辑直接进播放器，否则进「我的听书」 */
  enter: () => void
  openLibrary: () => void
  /** 打开专辑（详情 + 首屏章节）；play=true 时自动从第一章开始播。
   *  summary 是列表卡片已有的摘要（封面/作者/章节数）：详情返回前先用它渲染页头，避免闪空。 */
  openAlbum: (albumId: string, options?: { play?: boolean; summary?: LongaudioAlbumSummary }) => Promise<void>
  loadMoreChapters: () => Promise<void>
  selectChapter: (index: number, autoPlay?: boolean) => Promise<void>
  togglePlay: () => Promise<void>
  playNext: () => Promise<void>
  playPrev: () => Promise<void>
  setRate: (rate: number) => void
  seek: (seconds: number) => void
  retryChapter: () => Promise<void>
  /** 退出听书界面：暂停独立音频但保留专辑与进度，主播放器状态不受影响 */
  exit: () => void
  startPlaylist: () => Promise<void>
}

const clampRate = (rate: number): number => {
  const value = Number.isFinite(rate) ? rate : 1
  return Math.min(LONGAUDIO_MAX_RATE, Math.max(LONGAUDIO_MIN_RATE, Math.round(value * 100) / 100))
}

const initialState = (recent: LongaudioRecentAlbum[]): LongaudioState => ({
  view: 'closed',
  browse: { albums: [], page: 0, hasMore: true, loading: false, error: '', tag: null },
  player: {
    album: null,
    albumLoading: false,
    albumError: '',
    chapters: [],
    chapterPage: 0,
    chapterHasMore: false,
    chaptersLoading: false,
    chapterError: '',
    currentIndex: -1,
    status: 'idle',
    error: '',
    rate: 1,
    currentTime: 0,
    duration: 0,
  },
  recent,
  activeAlbum: null,
})

const defaultCreateAudio = (): LongaudioAudioLike | null => {
  if (typeof Audio === 'undefined') return null
  return new Audio() as unknown as LongaudioAudioLike
}

const defaultReadRecent = (): LongaudioRecentAlbum[] => {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(LONGAUDIO_RECENT_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item: LongaudioRecentAlbum) => item && item.albumId && item.name).slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

const defaultWriteRecent = (albums: LongaudioRecentAlbum[]): void => {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(LONGAUDIO_RECENT_KEY, JSON.stringify(albums.slice(0, RECENT_LIMIT))) } catch { /* 配额满时放弃缓存 */ }
}

export function createKugouLongaudioStore(overrides: Partial<KugouLongaudioDeps> = {}): KugouLongaudioStore {
  const deps: KugouLongaudioDeps = {
    fetchDaily: fetchKugouLongaudioDaily,
    fetchAlbumDetail: fetchKugouLongaudioAlbumDetail,
    fetchChapters: fetchKugouLongaudioChapters,
    resolveUrl: getKugouLongaudioUrl,
    createAudio: defaultCreateAudio,
    onBeforePlay: () => {
      if (typeof window !== 'undefined') window.dispatchEvent(new Event('waveforge:pause-main-playback'))
    },
    readRecent: defaultReadRecent,
    writeRecent: defaultWriteRecent,
    ...overrides,
  }

  let state = initialState(deps.readRecent())
  const listeners = new Set<() => void>()
  let audio: LongaudioAudioLike | null = null
  let audioBound = false
  // 浏览首页只自动尝试一次：探索页父组件每次渲染都会重发 effect，
  // 失败后自动重试会在上游 502 时形成请求风暴（重试交给用户点「重试」按钮）
  let browseAttempted = false
  // 快速切章/切专辑时旧请求可能后到：用自增令牌让过期响应静默丢弃
  let playToken = 0
  let albumToken = 0

  const commit = (partial: LongaudioPatch): void => {
    let next = state
    if (partial.browse) next = { ...next, browse: { ...next.browse, ...partial.browse } }
    if (partial.player) next = { ...next, player: { ...next.player, ...partial.player } }
    if (partial.recent) next = { ...next, recent: partial.recent }
    if (partial.view) next = { ...next, view: partial.view }
    if (partial.activeAlbum !== undefined) next = { ...next, activeAlbum: partial.activeAlbum }
    state = next
    listeners.forEach(listener => listener())
  }

  const setPlayer = (partial: Partial<LongaudioPlayerState>): void => commit({ player: partial })

  const ensureAudio = (): LongaudioAudioLike | null => {
    if (audio) return audio
    audio = deps.createAudio()
    if (!audio || audioBound) return audio
    audioBound = true
    audio.addEventListener('timeupdate', () => {
      setPlayer({ currentTime: Number(audio?.currentTime || 0) })
    })
    audio.addEventListener('loadedmetadata', () => {
      const duration = Number(audio?.duration || 0)
      if (Number.isFinite(duration) && duration > 0) setPlayer({ duration })
    })
    audio.addEventListener('ended', () => {
      void store.playNext()
    })
    audio.addEventListener('error', () => {
      // 上游直链是带时效的 CDN 地址：失效/权限受限时如实报错，不静默重试
      if (state.player.status === 'loading' || state.player.status === 'playing') {
        setPlayer({ status: 'error', error: '章节播放中断：直链可能已过期或该章节受版权限制' })
      }
    })
    return audio
  }

  const rememberRecent = (album: LongaudioAlbumSummary): void => {
    const entry: LongaudioRecentAlbum = {
      albumId: album.albumId,
      name: album.name,
      coverUrl: album.coverUrl,
      author: album.author,
      chapterCount: album.chapterCount,
      at: Date.now(),
    }
    const next = [entry, ...state.recent.filter(item => item.albumId !== album.albumId)].slice(0, RECENT_LIMIT)
    deps.writeRecent(next)
    commit({ recent: next })
  }

  type LongaudioAlbumSummary = { albumId: string; name: string; coverUrl: string; author: string; chapterCount?: number }

  /** 加载并播放指定章节；autoPlay=false 时只选中（用于打开专辑后的默认高亮） */
  const playChapterAt = async (index: number, autoPlay: boolean): Promise<void> => {
    const { chapters, album } = state.player
    const chapter = chapters[index]
    if (!chapter) return
    const token = ++playToken
    setPlayer({ currentIndex: index, currentTime: 0, duration: chapter.duration || 0, error: '' })
    if (!autoPlay) {
      setPlayer({ status: 'paused' })
      return
    }
    setPlayer({ status: 'loading' })
    const resolved = await deps.resolveUrl(chapter.hash, {
      albumId: album?.albumId,
      albumAudioId: chapter.albumAudioId,
    })
    if (token !== playToken) return
    if (!resolved.url) {
      setPlayer({ status: 'error', error: resolved.error || '该章节暂时无法播放' })
      return
    }
    const element = ensureAudio()
    if (!element) {
      setPlayer({ status: 'error', error: '当前环境不支持音频播放' })
      return
    }
    // 直链就绪后才请求暂停主音乐：解析失败时不该把主播放器打断
    deps.onBeforePlay?.()
    element.pause()
    element.src = resolved.url
    element.playbackRate = state.player.rate
    try {
      await element.play()
      if (token !== playToken) return
      setPlayer({ status: 'playing', duration: chapter.duration || state.player.duration })
      if (album) {
        rememberRecent({
          albumId: album.albumId,
          name: album.name,
          coverUrl: album.coverUrl,
          author: album.author,
          chapterCount: state.activeAlbum?.chapterCount || state.player.chapters.length || undefined,
        })
      }
    } catch (error) {
      if (token !== playToken) return
      setPlayer({ status: 'error', error: error instanceof Error ? error.message : '播放失败' })
    }
  }

  const store: KugouLongaudioStore = {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    ensureBrowseLoaded: async (options = {}) => {
      if (state.browse.loading) return
      if (!options.force) {
        if (state.browse.albums.length > 0 || browseAttempted) return
      }
      browseAttempted = true
      commit({ browse: { loading: true, error: '' } })
      const result = await deps.fetchDaily(1, LONGAUDIO_DAILY_PAGE_SIZE)
      commit({
        browse: {
          albums: result.albums,
          page: result.albums.length > 0 ? 1 : 0,
          hasMore: result.hasMore,
          loading: false,
          error: result.error || (result.albums.length === 0 ? '听书推荐暂时没有返回内容' : ''),
        },
      })
    },

    loadMoreBrowse: async () => {
      if (state.browse.loading || !state.browse.hasMore) return
      const nextPage = state.browse.page + 1
      commit({ browse: { loading: true, error: '' } })
      const result = await deps.fetchDaily(nextPage, LONGAUDIO_DAILY_PAGE_SIZE)
      const known = new Set(state.browse.albums.map(album => album.albumId))
      commit({
        browse: {
          albums: [...state.browse.albums, ...result.albums.filter(album => !known.has(album.albumId))],
          page: result.albums.length > 0 ? nextPage : state.browse.page,
          hasMore: result.hasMore,
          loading: false,
          error: result.error || '',
        },
      })
    },

    setBrowseTag: tag => commit({ browse: { tag } }),

    enter: () => commit({ view: state.player.album ? 'player' : 'library' }),

    openLibrary: () => commit({ view: 'library' }),

    openAlbum: async (albumId, options = {}) => {
      if (!albumId) return
      const sameAlbum = state.player.album?.albumId === albumId
      const summary = options.summary
      commit({ view: 'player', activeAlbum: sameAlbum ? state.activeAlbum : (summary || null) })
      if (!sameAlbum) {
        const token = ++albumToken
        setPlayer({
          album: null,
          albumLoading: true,
          albumError: '',
          chapters: [],
          chapterPage: 0,
          chapterHasMore: false,
          chaptersLoading: true,
          chapterError: '',
          currentIndex: -1,
          status: 'idle',
          error: '',
          currentTime: 0,
          duration: 0,
        })
        const [detail, firstPage] = await Promise.all([
          deps.fetchAlbumDetail(albumId),
          deps.fetchChapters(albumId, 1, LONGAUDIO_CHAPTER_PAGE_SIZE),
        ])
        if (token !== albumToken) return
        const album = detail.album
        commit({
          activeAlbum: album
            ? {
                albumId: album.albumId,
                name: album.name || summary?.name || '',
                coverUrl: album.coverUrl || summary?.coverUrl || '',
                author: album.author || summary?.author || '',
                chapterCount: summary?.chapterCount,
              }
            : (summary || state.activeAlbum),
        })
        setPlayer({
          album,
          albumLoading: false,
          albumError: album ? '' : (detail.error || '专辑详情不可用'),
          chapters: firstPage.chapters,
          chapterPage: firstPage.chapters.length > 0 ? 1 : 0,
          chapterHasMore: firstPage.hasMore,
          chaptersLoading: false,
          chapterError: firstPage.error || (firstPage.chapters.length === 0 ? '该专辑暂时没有可播放章节' : ''),
        })
      }
      if (options.play) await store.startPlaylist()
    },

    loadMoreChapters: async () => {
      const album = state.player.album
      if (!album || state.player.chaptersLoading || !state.player.chapterHasMore) return
      const nextPage = state.player.chapterPage + 1
      setPlayer({ chaptersLoading: true })
      const result = await deps.fetchChapters(album.albumId, nextPage, LONGAUDIO_CHAPTER_PAGE_SIZE)
      const known = new Set(state.player.chapters.map(chapter => chapter.hash))
      setPlayer({
        chapters: [...state.player.chapters, ...result.chapters.filter(chapter => !known.has(chapter.hash))],
        chapterPage: result.chapters.length > 0 ? nextPage : state.player.chapterPage,
        chapterHasMore: result.hasMore,
        chaptersLoading: false,
        chapterError: result.error || '',
      })
    },

    selectChapter: async (index, autoPlay = true) => {
      if (index < 0 || index >= state.player.chapters.length) return
      await playChapterAt(index, autoPlay)
    },

    togglePlay: async () => {
      const element = ensureAudio()
      const { status, currentIndex, chapters } = state.player
      if (status === 'playing') {
        element?.pause()
        setPlayer({ status: 'paused' })
        return
      }
      if (currentIndex < 0 || !chapters[currentIndex]) {
        // 未选中过章节：从第一章开始（空专辑不报错，UI 已有空态）
        if (chapters.length === 0) return
        await store.selectChapter(0, true)
        return
      }
      if (status === 'paused' && element?.src) {
        try {
          deps.onBeforePlay?.()
          element.playbackRate = state.player.rate
          await element.play()
          setPlayer({ status: 'playing', error: '' })
        } catch (error) {
          setPlayer({ status: 'error', error: error instanceof Error ? error.message : '播放失败' })
        }
        return
      }
      // idle / error：重新解析直链后播放
      await store.selectChapter(currentIndex, true)
    },

    playNext: async () => {
      const { currentIndex, chapters } = state.player
      if (currentIndex < 0) {
        if (chapters.length > 0) await store.selectChapter(0, true)
        return
      }
      if (currentIndex + 1 < chapters.length) {
        await store.selectChapter(currentIndex + 1, true)
        return
      }
      if (state.player.chapterHasMore) {
        await store.loadMoreChapters()
        if (currentIndex + 1 < state.player.chapters.length) {
          await store.selectChapter(currentIndex + 1, true)
          return
        }
      }
      // 已是最后一章：停在末尾保持暂停，不自动跳回开头
      ensureAudio()?.pause()
      setPlayer({ status: 'paused' })
    },

    playPrev: async () => {
      const { currentIndex, chapters } = state.player
      if (currentIndex <= 0) {
        if (chapters.length > 0) await store.selectChapter(0, true)
        return
      }
      await store.selectChapter(currentIndex - 1, true)
    },

    setRate: rate => {
      const next = clampRate(rate)
      const element = ensureAudio()
      if (element) element.playbackRate = next
      setPlayer({ rate: next })
    },

    seek: seconds => {
      const element = ensureAudio()
      const duration = state.player.duration || state.player.chapters[state.player.currentIndex]?.duration || 0
      const target = Math.min(Math.max(0, Number(seconds) || 0), duration > 0 ? duration : Number.MAX_SAFE_INTEGER)
      if (element) element.currentTime = target
      setPlayer({ currentTime: target })
    },

    retryChapter: async () => {
      const { currentIndex } = state.player
      if (currentIndex < 0) return
      await store.selectChapter(currentIndex, true)
    },

    exit: () => {
      // 退出界面就停声：留着独立音频在后台播会让用户以为「关掉还在响」
      ensureAudio()?.pause()
      setPlayer({ status: state.player.status === 'playing' || state.player.status === 'loading' ? 'paused' : state.player.status })
      commit({ view: 'closed' })
    },

    startPlaylist: async () => {
      const { chapters, currentIndex } = state.player
      if (chapters.length === 0) return
      await store.selectChapter(currentIndex >= 0 ? currentIndex : 0, true)
    },
  }

  return store
}

/** 分类胶囊：按 tag_info.tag_name 聚合（上游没有按分类拉取的接口，只能对已加载内容做客户端筛选） */
export function selectBrowseTags(state: LongaudioState): Array<{ name: string; count: number }> {
  const counts = new Map<string, number>()
  for (const album of state.browse.albums) {
    if (!album.primaryTag) continue
    counts.set(album.primaryTag, (counts.get(album.primaryTag) || 0) + 1)
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

export function selectVisibleBrowseAlbums(state: LongaudioState): KugouLongaudioAlbum[] {
  const tag = state.browse.tag
  if (!tag) return state.browse.albums
  return state.browse.albums.filter(album => album.tags.includes(tag) || album.primaryTag === tag)
}

/** 应用内单例（生产环境） */
export const kugouLongaudioStore = createKugouLongaudioStore()
