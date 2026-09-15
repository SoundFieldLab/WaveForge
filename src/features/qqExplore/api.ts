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
  const data = await post<{ songs: Song[] }>('/songs', { cards: cards.slice(0, 36) }, signal)
  return Array.isArray(data.songs) ? data.songs : []
}

export async function fetchQQRadarSongs(
  params: { page: number; reqType: number; entranceSongs: number[] },
  signal?: AbortSignal,
): Promise<{ songs: Song[]; hasMore: boolean; page: number }> {
  return post('/radar', { ...params, needNum: 30 }, signal)
}
