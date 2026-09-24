import type { Song } from '../../services/musicApi'
import type { ExplorePlaylist } from '../../services/exploreApi'

export type QQExploreAction =
  | { type: 'play-radio'; radioId: number }
  | { type: 'play-radar'; page: number; reqType: number; entranceSongs: number[] }
  | { type: 'open-playlist'; playlistId: string }
  | { type: 'open-album'; albumId: string }
  | { type: 'open-chart'; chartId: string }
  | { type: 'open-mv'; mvId: string }
  | { type: 'open-external'; url: string }
  | { type: 'open-section'; section: 'playlists' | 'charts' | 'mvs' }
  | { type: 'open-preferences' }
  | { type: 'play-songs' }
  | { type: 'search'; query: string }
  | { type: 'unsupported' }

export interface QQExploreTag {
  tag: string
  link: string
  tagId: string
  fromType: string
  iconUrl: string
  exts: Record<string, string>
}

export interface QQExploreCard {
  id: string
  feedKey: string
  type: number
  subtype: number
  style: number
  jumpType: number
  title: string
  subtitle?: string
  coverUrl?: string
  layerUrl?: string
  reason?: string
  content?: string
  classification: string
  layerTitle: string
  layerClassifyTitle: string
  layerElementPic0: string
  layerElementPic1: string
  layerElementPic2: string
  typeTag: string
  lowerTags: QQExploreTag[]
  countContent: string
  twoColumn: boolean
  isFavorite: boolean
  favoriteCount: string
  commentCount: string
  badges: string[]
  feedbackToken?: string
  appendToken?: string
  canRequestSimilar: boolean
  songs: Song[]
  action: QQExploreAction
}

export interface QQExploreRefreshToken {
  moduleId: string
  page: number
  layoutTrace: string
  layoutSeq: string
  shelfId: string
  extraInfo: Record<string, unknown>
}

export interface QQExploreModule {
  id: string
  instanceId: string
  title: string
  titleTemplate?: string
  style: number
  source: 'qq-native-recommend-feed'
  refresh: QQExploreRefreshToken | null
  cards: QQExploreCard[]
}

export interface QQExploreCursor {
  page: number
  shelfCount: number
}

export interface QQExploreFeed {
  modules: QQExploreModule[]
  loadMark: number
  hasMore: boolean
  cursor: QQExploreCursor
}

export interface QQMusicHallCard {
  id: string
  subId: string
  type: number
  subtype: number
  style: number
  jumpType: number
  nicheStyle: number
  title: string
  subtitle: string
  coverUrl: string
  count: string
  songs: Song[]
  action: QQExploreAction
}

export interface QQMusicHallShelf {
  id: string
  title: string
  style: number
  nicheStyle: number
  serverOrder: number
  cards: QQMusicHallCard[]
}

export interface QQDaily30 {
  playlistId: string
  title: string
  coverUrl?: string
  dateKey: string
  songs: Song[]
}

export interface QQExploreSnapshot {
  accountScoped: true
  generatedAt: number
  feed: QQExploreFeed
  musicHall: QQMusicHallShelf[]
  daily30: QQDaily30 | null
}

export interface QQExploreState {
  snapshot: QQExploreSnapshot | null
  initialLoading: boolean
  refreshing: boolean
  refreshingModuleId: string
  moduleErrors: Record<string, string>
  loadingMore: boolean
  loadingMoreProgress: number
  error: string
  paginationError: string
}

const HIDDEN_QQ_MUSIC_HALL_LABELS = ['热门节目', '听点不一样的', '听书', '数字专辑', '明星空降', '墙裂推荐', '直播', '编辑甄选'] as const

export function isHiddenQQMusicHallShelf(shelf: QQMusicHallShelf): boolean {
  if (!shelf.cards.length || !shelf.title.trim()) return false
  const text = `${shelf.title} ${shelf.cards.map(card => `${card.title} ${card.subtitle}`).join(' ')}`.trim()
  return HIDDEN_QQ_MUSIC_HALL_LABELS.some(label => text.includes(label))
}

export function isQQStarLightCard(card: QQExploreCard): boolean {
  const text = [card.title, card.subtitle, card.reason, card.content, ...card.badges].join(' ')
  return /星光卡|典藏星光|星光典藏/i.test(text)
}

/** 只有 QQ 客户端能打开的卡片（`unsupported`）：网页端点不开，不如不显示——占位只会让人白点一次。 */
export function isUnopenableQQCard(card: QQExploreCard): boolean {
  return card.action.type === 'unsupported'
}

export function qqCardPlaylist(card: QQExploreCard): ExplorePlaylist | null {
  if (card.action.type !== 'open-playlist') return null
  return {
    id: card.action.playlistId,
    name: card.title || 'QQ 音乐推荐歌单',
    description: card.reason || card.subtitle || '',
    coverUrl: card.coverUrl || '',
    platform: 'qq',
    source: 'qq-native-personalized',
  }
}

export function qqModuleIdentity(module: QQExploreModule): string {
  const shelfId = module.refresh?.shelfId || module.id
  return `${module.source}:${shelfId}:${module.style}`
}

export function qqModuleInstanceIdentity(module: QQExploreModule): string {
  return module.instanceId || qqModuleIdentity(module)
}

export function qqCardIdentity(card: QQExploreCard): string {
  return card.feedKey || `${card.type}:${card.subtype}:${card.style}:${card.jumpType}:${card.id}`
}

export function mergeQQModules(modules: QQExploreModule[]): QQExploreModule[] {
  const merged: QQExploreModule[] = []
  const indices = new Map<string, number>()
  for (const module of modules) {
    const key = qqModuleIdentity(module)
    const index = indices.get(key)
    if (index === undefined) {
      const seenCards = new Set<string>()
      const cards = module.cards.filter(card => {
        const cardKey = qqCardIdentity(card)
        if (seenCards.has(cardKey)) return false
        seenCards.add(cardKey)
        return true
      })
      indices.set(key, merged.length)
      merged.push({ ...module, cards })
      continue
    }
    const current = merged[index]
    const seenCards = new Set(current.cards.map(qqCardIdentity))
    for (const card of module.cards) {
      const cardKey = qqCardIdentity(card)
      if (seenCards.has(cardKey)) continue
      seenCards.add(cardKey)
      current.cards.push(card)
    }
    current.refresh = module.refresh || current.refresh
  }
  return merged
}

export function dedupeQQModules(modules: QQExploreModule[]): QQExploreModule[] {
  return mergeQQModules(modules)
}
