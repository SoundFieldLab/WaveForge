/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 酷狗「刷歌」竖滑流独立状态（3.E）。
 *
 * 设计要点（为什么这样写）：
 * - 与 QQ 刷歌同粒度：动态流拉一批卡片 → 交给**主播放器**播放（不另造播放器/音频通道），
 *   QQRadarPlayer 那套也是 onPlaySong → 全局播放器，保持一致；队列续取由本 store 负责。
 * - 与听书播放器相反：刷歌就是听歌，必须复用主播放器（歌词/历史/上报一条链路）。
 * - 上游对本账号恒返回空 list（is_end=1）：空列表是**正常结果**，state 里区分 empty 与 error，
 *   空态文案固定为「当前账号暂无动态」，不把空列表当失败。
 * - 依赖可注入：单测在 node 环境注入假 fetch/report，不触网。
 */
import type { Song } from '../../services/musicApi'
import {
  fetchKugouYouthDynamic,
  fetchKugouYouthRecent,
  reportKugouYouthListen,
  type KugouYouthCard,
  type KugouYouthFeed,
} from '../../services/kugouService'

export interface KugouYouthState {
  /** 全屏竖滑播放页是否打开 */
  open: boolean
  cards: KugouYouthCard[]
  /** 当前滑到的卡片下标（-1 = 空流） */
  index: number
  loading: boolean
  loadingMore: boolean
  /** 上游/网络错误（空 list 不算错误，见 empty） */
  error: string
  /** 上游成功但 list 为空：UI 要展示「当前账号暂无动态」空态 */
  empty: boolean
  isEnd: boolean
  lastCid: string
  /** 最近动态（/recent_dynamic）：作为「最近刷到」与空态下的次级内容 */
  recentCards: KugouYouthCard[]
  recentLoading: boolean
  recentError: string
  recentEmpty: boolean
  /** 本次会话已上报过已听的 mixsongid（避免同曲重复上报） */
  reported: number[]
}

export interface KugouYouthDeps {
  fetchDynamic: (lastCid?: string) => Promise<KugouYouthFeed>
  fetchRecent: () => Promise<{ cards: KugouYouthCard[]; empty: boolean; error?: string }>
  reportListen: (mixsongid: number) => Promise<boolean>
}

const defaultDeps: KugouYouthDeps = {
  fetchDynamic: fetchKugouYouthDynamic,
  fetchRecent: fetchKugouYouthRecent,
  reportListen: reportKugouYouthListen,
}

const initialState: KugouYouthState = {
  open: false,
  cards: [],
  index: -1,
  loading: false,
  loadingMore: false,
  error: '',
  empty: true,
  isEnd: true,
  lastCid: '',
  recentCards: [],
  recentLoading: false,
  recentError: '',
  recentEmpty: true,
  reported: [],
}

/** 卡片去重键：raw 序列化（字段未实测，不能依赖某个 id 字段；同一条目序列化相同才去重） */
function cardKey(card: KugouYouthCard): string {
  try {
    return JSON.stringify(card.raw)
  } catch {
    return String(card.title)
  }
}

export interface KugouYouthStore {
  getState: () => KugouYouthState
  subscribe: (listener: () => void) => () => void
  /** 打开全屏刷歌页；首次打开触发拉流 */
  open: () => void
  close: () => void
  /** 重新拉取动态流（保留已滑位置无意义，重置到第一张） */
  refresh: () => Promise<void>
  /** 滑到末尾附近时续取下一页（is_end 或没有 last_cid 时不请求） */
  loadMore: () => Promise<void>
  /** 选择第 index 张卡片：同步上报已听（静默失败） */
  select: (index: number) => void
  /** 最近动态（板块「最近刷到」用） */
  loadRecent: () => Promise<void>
  /** 仅注入依赖（单测用），返回可覆盖 deps 的 store 工厂 */
  _setDeps?: (deps: Partial<KugouYouthDeps>) => void
}

export function createKugouYouthStore(overrides: Partial<KugouYouthDeps> = {}): KugouYouthStore {
  let deps: KugouYouthDeps = { ...defaultDeps, ...overrides }
  let state: KugouYouthState = { ...initialState, reported: [] }
  const listeners = new Set<() => void>()
  let inFlightDynamic = false

  const emit = (patch: Partial<KugouYouthState>) => {
    state = { ...state, ...patch }
    listeners.forEach(listener => listener())
  }

  const reportOnce = (mixsongid: number) => {
    if (!mixsongid || state.reported.includes(mixsongid)) return
    emit({ reported: [...state.reported, mixsongid] })
    // 上报失败不影响播放：静默吞掉，只在会话内记一次避免重复打点
    void deps.reportListen(mixsongid).catch(() => false)
  }

  const refresh = async () => {
    if (inFlightDynamic) return
    inFlightDynamic = true
    emit({ loading: true, error: '' })
    try {
      const feed = await deps.fetchDynamic('')
      emit({
        cards: feed.cards,
        index: feed.cards.length ? 0 : -1,
        isEnd: feed.isEnd,
        lastCid: feed.lastCid,
        empty: feed.empty,
        error: feed.error || '',
        loading: false,
      })
      // 首张即上报：官方客户端打开刷歌页就把当前卡片算作已听
      if (feed.cards[0]?.mixsongid) reportOnce(feed.cards[0].mixsongid)
    } catch (error) {
      emit({ loading: false, cards: [], index: -1, empty: true, error: error instanceof Error ? error.message : '酷狗刷歌加载失败' })
    } finally {
      inFlightDynamic = false
    }
  }

  const loadMore = async () => {
    if (state.loading || state.loadingMore || state.isEnd || !state.lastCid) return
    emit({ loadingMore: true })
    try {
      const feed = await deps.fetchDynamic(state.lastCid)
      const seen = new Set(state.cards.map(cardKey))
      const additions = feed.cards.filter(card => {
        const key = cardKey(card)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      emit({
        cards: additions.length ? [...state.cards, ...additions] : state.cards,
        isEnd: feed.isEnd || additions.length === 0,
        lastCid: feed.lastCid || state.lastCid,
        loadingMore: false,
        error: feed.error || '',
      })
    } catch (error) {
      emit({ loadingMore: false, error: error instanceof Error ? error.message : '酷狗刷歌下一页加载失败' })
    }
  }

  const loadRecent = async () => {
    emit({ recentLoading: true, recentError: '' })
    try {
      const result = await deps.fetchRecent()
      emit({ recentCards: result.cards, recentEmpty: result.empty, recentError: result.error || '', recentLoading: false })
    } catch (error) {
      emit({ recentLoading: false, recentCards: [], recentError: error instanceof Error ? error.message : '酷狗刷歌最近动态加载失败' })
    }
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    open: () => {
      const isOpen = state.open
      emit({ open: true })
      if (!isOpen && state.cards.length === 0 && !state.loading) void refresh()
    },
    close: () => emit({ open: false }),
    refresh,
    loadMore,
    select: (index: number) => {
      const card = state.cards[index]
      if (!card) return
      emit({ index })
      if (card.mixsongid) reportOnce(card.mixsongid)
    },
    loadRecent,
    _setDeps: (next: Partial<KugouYouthDeps>) => { deps = { ...deps, ...next } },
  }
}

/** 生产单例（探索页板块 / 传统模式入口 / 全屏竖滑页共用一份状态） */
export const kugouYouthStore = createKugouYouthStore()

/** 可播放队列：只取识别出曲目的卡片（识别不出的卡片不参与播放，但仍在 UI 里可见） */
export function selectYouthSongs(cards: KugouYouthCard[]): Song[] {
  return cards.map(card => card.song).filter((song): song is Song => Boolean(song))
}
