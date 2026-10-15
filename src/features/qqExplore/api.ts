import { getApiBase } from '../../services/apiConfig'
import { getExploreCookie } from '../../services/exploreApi'
import type { Song } from '../../services/musicApi'
import type { QQExploreCursor, QQExploreFeed, QQExploreRefreshToken, QQExploreSnapshot } from './model'

const API_PATH = '/explore/qq/native'

async function post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const cookie = getExploreCookie('qq')
  if (!cookie) throw new Error('需要登录 QQ 音乐')
  const timeoutController = new AbortController()
  const timeout = window.setTimeout(() => timeoutController.abort(), 25_000)
  const abort = () => timeoutController.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await fetch(`${getApiBase()}${API_PATH}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...body }),
      signal: timeoutController.signal,
      cache: 'no-store',
    })
    const data = await response.json()
    if (!response.ok || Number(data?.code) >= 400) throw new Error(data?.error || `请求失败 (${response.status})`)
    return data as T
  } catch (error) {
    if (timeoutController.signal.aborted && !signal?.aborted) throw new Error('QQ 音乐请求超时')
    throw error
  } finally {
    window.clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

export function fetchQQExploreBootstrap(signal?: AbortSignal): Promise<QQExploreSnapshot> {
  return post<QQExploreSnapshot>('/bootstrap', {}, signal)
}

export function fetchQQExploreFeed(
  cursor: QQExploreCursor,
  seenShelfIds: string[],
  seenFeedKeys: string[],
  refresh?: QQExploreRefreshToken | null,
  signal?: AbortSignal,
): Promise<QQExploreFeed> {
  return post<QQExploreFeed>('/feed', {
    page: refresh ? 1 : cursor.page,
    direction: refresh ? 0 : cursor.page > 1 ? 1 : 0,
    shelfCount: refresh ? 0 : cursor.shelfCount,
    shelfIds: refresh ? [] : seenShelfIds.slice(-200),
    feedKeys: seenFeedKeys.slice(-100),
    refresh: refresh || undefined,
  }, signal)
}

export async function fetchQQExploreAppendShelf(appendToken: string, action: 'play' | 'like', signal?: AbortSignal): Promise<{ modules: QQExploreFeed['modules'] }> {
  try {
    return await post('/card/append', { appendToken, action }, signal)
  } catch (error) {
    if (error instanceof Error && /60001|GetRecommendAppendShelf.*60001/i.test(error.message)) return { modules: [] }
    throw error
  }
}

export function fetchQQExploreSimilarShelf(appendToken: string, signal?: AbortSignal): Promise<{ modules: QQExploreFeed['modules'] }> {
  return post('/card/similar', { appendToken }, signal)
}

export interface QQExploreFeedbackOption {
  token: string
  title: string
}

export function fetchQQExploreFeedbackOptions(feedbackToken: string, signal?: AbortSignal): Promise<{ options: QQExploreFeedbackOption[]; affirmText: string }> {
  return post('/feedback/options', { feedbackToken }, signal)
}

export function submitQQExploreFeedback(feedbackToken: string, optionTokens: string[], signal?: AbortSignal): Promise<{ success: boolean }> {
  return post('/feedback/submit', { feedbackToken, optionTokens }, signal)
}

export interface QQExplorePreferenceItem {
  id: string
  title: string
  coverUrl: string
  selected: boolean
  itemType: number
  itemSubtype: number
}

export function fetchQQExplorePreferences(signal?: AbortSignal): Promise<{ items: QQExplorePreferenceItem[] }> {
  return post('/preferences', {}, signal)
}

export function saveQQExplorePreferences(items: QQExplorePreferenceItem[], signal?: AbortSignal): Promise<{ saved: number }> {
  return post('/preferences/save', { items }, signal)
}

export async function resolveQQExploreSong(
  songId: string,
  fallback: { title?: string; artist?: string; coverUrl?: string },
  signal?: AbortSignal,
): Promise<Song> {
  const data = await post<{ song: Song }>('/song', { songId, ...fallback }, signal)
  return data.song
}

export async function resolveQQExploreSongs(
  cards: Array<{ songId: string; title?: string; artist?: string; coverUrl?: string }>,
  signal?: AbortSignal,
): Promise<Song[]> {
  const data = await post<{ songs: (Song | null)[] }>('/songs', { cards: cards.slice(0, 36) }, signal)
  // 服务端按卡片下标返回（解析失败的卡为 null 占位）：按 songId 建 Map 对齐，
  // 丢弃失败项且不错位 —— 缓存数组与卡片下标一一对应是 PcSongShelf / playModuleAt 的契约。
  const byId = new Map<string, Song>()
  for (const song of Array.isArray(data.songs) ? data.songs : []) {
    if (!song) continue
    // 卡的 songId 是 QQ 数字 id（resolveQQNativeSongById 按 song_id 查询），
    // 对齐键必须用 song.id；mid 是另一套标识，不能混用
    const key = String((song as { id?: string | number }).id ?? '')
    if (key && key !== '0') byId.set(key, song)
  }
  const resolved: Song[] = []
  for (const card of cards) {
    const song = byId.get(String(card.songId))
    if (song) resolved.push(song)
  }
  return resolved
}

export async function fetchQQRadarSongs(
  params: { page: number; reqType: number; entranceSongs: number[] },
  signal?: AbortSignal,
): Promise<{ songs: Song[]; hasMore: boolean; page: number }> {
  return post('/radar', { ...params, needNum: 30 }, signal)
}

// ── QQ 歌曲黑名单（「不喜欢」，App 同款 music.feedback.FeedbackBlack）──────
export interface QQDislikeEntry {
  id: string
  name: string
  img: string
  idType: number
  time: number
}

export interface QQDislikeListData {
  songs: QQDislikeEntry[]
  singers: QQDislikeEntry[]
  styles: QQDislikeEntry[]
}

/** 黑名单列表（不传 cmd 时歌曲/歌手/风格三张表全量返回）。 */
export function fetchQQDislikeList(signal?: AbortSignal): Promise<QQDislikeListData> {
  return post<QQDislikeListData>('/dislike/list', {}, signal)
}

export function addQQDislike(song: { songId?: string | number; songMid?: string; name?: string }, signal?: AbortSignal): Promise<{ success: boolean; id: string }> {
  return post('/dislike/add', { songId: song.songId, songMid: song.songMid, name: song.name }, signal)
}

export function cancelQQDislike(song: { songId?: string | number; songMid?: string; name?: string }, signal?: AbortSignal): Promise<{ success: boolean; id: string }> {
  return post('/dislike/cancel', { songId: song.songId, songMid: song.songMid, name: song.name }, signal)
}

export function fetchQQDislikeStyles(signal?: AbortSignal): Promise<{ styles: Array<{ id: string; name: string; idType: number; status: number }> }> {
  return post('/dislike/styles', {}, signal)
}

export type QQDislikeKind = 'song' | 'singer' | 'style'

/** 移除黑名单条目（按类型，条目原样回传列表返回的 id/name/idType）。 */
export function removeQQDislikeEntry(kind: QQDislikeKind, entry: QQDislikeEntry, signal?: AbortSignal): Promise<{ success: boolean }> {
  return post('/dislike/cancel-entry', { type: kind, entry }, signal)
}

// ── 音乐偏好（= App 刷歌页右上角设置 → 我的音乐偏好 H5 同款接口）────────────
export interface QQUserProfile {
  key: string
  name: string
  score: number
  isBlack: boolean
}

export interface QQUserProfileData {
  expired: boolean
  updateTime: number
  showsTitle: string
  profiles: QQUserProfile[]
}

export function fetchQQUserProfile(signal?: AbortSignal): Promise<QQUserProfileData> {
  return post<QQUserProfileData>('/profile/get', {}, signal)
}

export function saveQQUserProfile(
  profiles: Array<{ key: string; score: number; isAdjust?: boolean; isBlack?: boolean }>,
  signal?: AbortSignal,
): Promise<{ saved: number }> {
  return post('/profile/set', { profiles }, signal)
}
