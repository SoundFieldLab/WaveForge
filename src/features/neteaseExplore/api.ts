import { getNeteaseProgramDetail, getNeteaseRadioDetail, getUserDetail, getUserPlaylistList, type Song } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getExploreCookie } from '../../services/exploreApi'
import { createTtlCache } from '../../utils/ttlCache'
import { normalizeNeteaseFlow, normalizeNeteaseHome, type NeteaseNativeFlow, type NeteaseNativeHome } from './model'

// src/features/neteaseExplore/api.ts

const API_BASE = `${getApiBase()}/netease/native`

// 冷启动/返回再进会反复拉同一批只读数据：首页推荐（4 路 allSettled 里最重的一路）、
// 相似推荐上下文、用户资料/歌单、电台/节目详情。这里按 key 存短 TTL 结果，命中即不再发请求。
// 只存成功且非空的结果，不落盘；账号态数据在登录态变化时整体清空。
const homeCache = createTtlCache<NeteaseNativeHome>({ ttlMs: 5 * 60 * 1000, maxEntries: 4 })
const similarContextCache = createTtlCache<NeteaseSimilarContext>({ ttlMs: 5 * 60 * 1000, maxEntries: 20 })
const userDetailCache = createTtlCache<any>({ ttlMs: 10 * 60 * 1000, maxEntries: 30 })
const userPlaylistCache = createTtlCache<any[]>({ ttlMs: 10 * 60 * 1000, maxEntries: 30 })
const radioDetailCache = createTtlCache<any>({ ttlMs: 10 * 60 * 1000, maxEntries: 30 })
const programDetailCache = createTtlCache<any>({ ttlMs: 10 * 60 * 1000, maxEntries: 30 })

/** 登录态变化后调用：清掉账号态只读缓存，避免显示上一个账号的推荐/资料。 */
export const clearNeteaseReadCaches = () => {
  homeCache.clear()
  similarContextCache.clear()
  userDetailCache.clear()
  userPlaylistCache.clear()
  radioDetailCache.clear()
  programDetailCache.clear()
}
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', clearNeteaseReadCaches)
  // 网易云歌单内容变化（喜欢/加歌/删歌/收藏）→ 用户歌单与首页推荐里的歌单架立刻失效，
  // 否则原生探索页最长 10 分钟显示旧曲目数/旧歌单。
  window.addEventListener('playlist-content-changed', (event) => {
    const detail = (event as CustomEvent<{ platform?: string }>).detail
    if (!detail?.platform || detail.platform === 'netease') clearNeteaseReadCaches()
  })
}

async function request(path: string, params: Record<string, string | undefined>, signal?: AbortSignal) {
  const url = new URL(`${API_BASE}${path}`)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value)
  const response = await fetch(url, { signal, cache: 'no-store' })
  const data = await response.json()
  if (!response.ok || Number(data?.code) >= 400) throw new Error(data?.error || data?.message || `网易云请求失败 (${response.status})`)
  return data
}

export interface NeteaseSessionStatus {
  authenticated: boolean | null
  profile: { userId: string; nickname: string; avatarUrl: string } | null
  reason: string
}

export async function fetchNeteaseSessionStatus(signal?: AbortSignal): Promise<NeteaseSessionStatus> {
  const payload = await request('/session-status', { cookie: getExploreCookie('netease') }, signal)
  return {
    authenticated: typeof payload?.authenticated === 'boolean' ? payload.authenticated : null,
    profile: payload?.profile?.userId ? {
      userId: String(payload.profile.userId),
      nickname: String(payload.profile.nickname || ''),
      avatarUrl: String(payload.profile.avatarUrl || ''),
    } : null,
    reason: String(payload?.reason || ''),
  }
}

export async function fetchNeteaseNativeHome(
  refresh = false,
  signal?: AbortSignal,
  state?: { cursor?: string; blockCodeOrderList?: string[]; exposedResource?: string },
): Promise<NeteaseNativeHome> {
  // 只有「首页第一页」（无 cursor）才可复用：带 cursor 的续拉强依赖服务端翻页链，不能缓存。
  const cacheKey = state?.cursor ? '' : 'default'
  if (!refresh && cacheKey) {
    const cached = homeCache.get(cacheKey)
    if (cached) return cached
  }
  const extInfo = state ? JSON.stringify({
    netstat: 1,
    guideToastLastShow: 0,
    carrier: '',
    abInfo: { 'hp-new-homepageV3.1': '' },
    requestLongVideoBanner: true,
    refreshType: refresh ? 1 : 0,
    forceFreshForNewUser: false,
    blockCodeOrderList: state.blockCodeOrderList || [],
    exposedResource: state.exposedResource || '',
  }) : undefined
  const payload = await request('/home', {
    cookie: getExploreCookie('netease'),
    refresh: refresh ? '1' : undefined,
    cursor: state?.cursor,
    extInfo,
  }, signal)
  const home = normalizeNeteaseHome(payload)
  // 空结果不缓存（一次失败/空页不该被钉死 5 分钟）
  if (cacheKey && home.blocks.length > 0) homeCache.set(cacheKey, home)
  return home
}

export async function fetchNeteaseUnlimitedFlow(signal?: AbortSignal): Promise<NeteaseNativeFlow> {
  const payload = await request('/unlimited-flow', { cookie: getExploreCookie('netease') }, signal)
  return normalizeNeteaseFlow(payload)
}

export function normalizeNeteaseSongs(payload: any): Song[] {
  const candidates = Array.isArray(payload)
    ? payload
    : payload?.data?.dailySongs || payload?.data?.songs || payload?.dailySongs || payload?.songs || payload?.data || []
  if (!Array.isArray(candidates)) return []
  const songs = candidates.map((value: any) => {
    const track = value?.songInfo || value?.song || value?.simpleSong || value
    const album = track?.al || track?.album || {}
    const artists = track?.ar || track?.artists || []
    return {
      id: Number(track?.id || 0),
      name: String(track?.name || ''),
      artists: (Array.isArray(artists) ? artists : []).map((artist: any) => ({ id: Number(artist?.id) || undefined, name: String(artist?.name || '未知歌手') })),
      album: { id: Number(album?.id) || undefined, name: String(album?.name || ''), picUrl: String(album?.picUrl || album?.blurPicUrl || '').replace(/^http:/, 'https:') },
      duration: Number(track?.dt || track?.duration || 0),
      platform: 'netease' as const,
      fee: Number(track?.fee || 0),
      vip: Number(track?.fee) === 1,
      requiredTier: Number(track?.fee) === 1 ? 'vip' as const : 'free' as const,
      noCopyright: Number(track?.privilege?.st) < 0,
    }
  }).filter((song: Song) => song.id && song.name)
  const seen = new Set<number>()
  return songs.filter((song: Song) => {
    if (seen.has(song.id)) return false
    seen.add(song.id)
    return true
  })
}

export async function fetchNeteaseDailySongs(signal?: AbortSignal): Promise<Song[]> {
  return normalizeNeteaseSongs(await request('/daily-songs', { cookie: getExploreCookie('netease') }, signal))
}

export interface NeteaseDailyStyleCategory {
  categoryId: string
  categoryName: string
  tags: Array<{ tagId: string; tagName: string }>
}

export async function fetchNeteaseDailyHistory(date?: string, signal?: AbortSignal): Promise<{ dates: string[]; songs: Song[]; description: string; emptyMessage: string }> {
  const payload = await request('/daily-history', { cookie: getExploreCookie('netease'), date }, signal)
  const data = payload?.data || {}
  return {
    dates: (Array.isArray(data.dates) ? data.dates : []).map((item: any) => String(item?.date || item || '')).filter(Boolean),
    songs: normalizeNeteaseSongs(data?.songs || data?.dailySongs || []),
    description: String(data.description || ''),
    emptyMessage: String(data.noHistoryMessage || ''),
  }
}

export async function fetchNeteaseDailyStyleConfig(signal?: AbortSignal): Promise<NeteaseDailyStyleCategory[]> {
  const payload = await request('/daily-style', { cookie: getExploreCookie('netease') }, signal)
  const categories = payload?.data?.categorys || []
  return (Array.isArray(categories) ? categories : []).map((category: any) => ({
    categoryId: String(category.categoryId || ''),
    categoryName: String(category.categoryName || ''),
    tags: (Array.isArray(category.tagVOList) ? category.tagVOList : []).map((tag: any) => ({ tagId: String(tag.tagId || ''), tagName: String(tag.tagName || '') })).filter((tag: { tagId: string; tagName: string }) => tag.tagId && tag.tagName),
  })).filter((category: NeteaseDailyStyleCategory) => category.categoryId && category.categoryName)
}

export async function fetchNeteaseDailyStyleSongs(categoryId: string, tagId: string, seedSongId = 0, signal?: AbortSignal): Promise<Song[]> {
  const payload = await request('/daily-style', { cookie: getExploreCookie('netease'), categoryId, tagId, songId: String(seedSongId) }, signal)
  return normalizeNeteaseSongs(payload?.data?.dailySongs || [])
}

export interface NeteaseRoamOptions {
  mode?: string
  subMode?: string
  limit?: number
  entranceType?: string
  unplaySongIds?: Array<string | number>
  openAidj?: boolean
  aidjReqTimes?: number
}

export async function fetchNeteaseRoam(signal?: AbortSignal, options: NeteaseRoamOptions = {}): Promise<Song[]> {
  const unplaySongIds = [...new Set((options.unplaySongIds || []).map(String).filter(id => /^\d+$/.test(id)))].slice(-100)
  return normalizeNeteaseSongs(await request('/roam', {
    cookie: getExploreCookie('netease'), mode: options.mode || 'DEFAULT', subMode: options.subMode,
    limit: String(Math.max(1, Math.min(50, options.limit || 30))), entranceType: options.entranceType,
    unplaySongIds: unplaySongIds.length ? JSON.stringify(unplaySongIds) : undefined,
    openAidj: options.openAidj ? '1' : undefined,
    aidjReqTimes: options.aidjReqTimes == null ? undefined : String(Math.max(0, options.aidjReqTimes)),
  }, signal))
}

export interface NeteaseHeartModeOptions { count?: number; type?: string; extJson?: string }

export async function fetchNeteaseHeartMode(songId: number, playlistId: string, signal?: AbortSignal, options: NeteaseHeartModeOptions = {}): Promise<Song[]> {
  return normalizeNeteaseSongs(await request('/heart-mode', {
    cookie: getExploreCookie('netease'), songId: String(songId), playlistId, startMusicId: String(songId),
    type: options.type || 'fromPlayOne', count: String(Math.max(1, Math.min(50, options.count || 30))), extJson: options.extJson || '{}',
  }, signal))
}

export async function fetchNeteaseProgramSong(programId: string, signal?: AbortSignal): Promise<Song | null> {
  const payload = await request('/program-detail', { cookie: getExploreCookie('netease'), id: programId }, signal)
  const program = payload?.program || payload?.data?.program || payload?.data || {}
  const songs = normalizeNeteaseSongs([program?.mainSong || program?.mainTrack].filter(Boolean))
  if (!songs[0]) return null
  return {
    ...songs[0],
    name: String(program?.name || songs[0].name),
    album: { ...songs[0].album, name: String(program?.radio?.name || songs[0].album.name), picUrl: String(program?.coverUrl || program?.blurCoverUrl || songs[0].album.picUrl).replace(/^http:/, 'https:') },
    duration: Number(program?.duration || songs[0].duration || 0),
    commentCount: Number(program?.commentCount || songs[0].commentCount || 0) || undefined,
    isPodcast: true,
  }
}

/** 批量拉取播客节目音频（播客栏位整列入队用，单次上限 12 条） */
export async function fetchNeteaseProgramSongs(programIds: string[], signal?: AbortSignal): Promise<Song[]> {
  const ids = [...new Set(programIds.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 12)
  if (!ids.length) return []
  const payload = await request('/program-songs', { cookie: getExploreCookie('netease'), ids: ids.join(',') }, signal)
  const programs: any[] = Array.isArray(payload?.programs) ? payload.programs : []
  return programs.filter(Boolean).map((entry: any) => {
    const program = entry?.program || {}
    const songs = normalizeNeteaseSongs([program?.mainSong || program?.mainTrack].filter(Boolean))
    const song = songs[0]
    if (!song) return null
    return {
      ...song,
      name: String(program?.name || song.name),
      album: { ...song.album, name: String(program?.radio?.name || song.album.name), picUrl: String(program?.coverUrl || program?.blurCoverUrl || song.album.picUrl).replace(/^http:/, 'https:') },
      duration: Number(program?.duration || song.duration || 0),
      commentCount: Number(program?.commentCount || song.commentCount || 0) || undefined,
      isPodcast: true,
    } as Song
  }).filter((song): song is Song => Boolean(song))
}

export async function fetchNeteaseDailyPodcast(signal?: AbortSignal): Promise<any[]> {
  const payload = await request('/daily-podcast', { cookie: getExploreCookie('netease') }, signal)
  const data = payload?.data
  return Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : []
}

export interface NeteaseSimilarContext {
  songs: any
  playlists: any
  users: any
}

export async function fetchNeteaseSimilarContext(songId: number, signal?: AbortSignal): Promise<NeteaseSimilarContext> {
  const key = String(songId)
  const cached = similarContextCache.get(key)
  if (cached) return cached
  const context = await request('/similar-context', { cookie: getExploreCookie('netease'), songId: key }, signal)
  if (context && !signal?.aborted) similarContextCache.set(key, context)
  return context
}

// services/musicApi 里的用户/电台/节目详情没有缓存，这里包一层短 TTL，面板反复开关不再重发请求。
// 失败返回 null / 空数组时不写缓存，保留原错误与重试路径。
export async function fetchNeteaseUserDetail(id: string): Promise<any> {
  const key = String(id)
  const cached = userDetailCache.get(key)
  if (cached) return cached
  const detail = await getUserDetail(id)
  if (detail?.profile) userDetailCache.set(key, detail)
  return detail
}

export async function fetchNeteaseUserPlaylists(id: string): Promise<any[]> {
  const key = String(id)
  const cached = userPlaylistCache.get(key)
  if (cached) return cached
  const payload = await getUserPlaylistList(id)
  const playlists = Array.isArray(payload?.playlist) ? payload.playlist : []
  if (playlists.length > 0) userPlaylistCache.set(key, playlists)
  return playlists
}

export async function fetchNeteaseRadioDetail(id: string): Promise<any> {
  const key = String(id)
  const cached = radioDetailCache.get(key)
  if (cached) return cached
  const detail = await getNeteaseRadioDetail(id)
  if (detail) radioDetailCache.set(key, detail)
  return detail
}

export async function fetchNeteaseProgramDetail(id: string): Promise<any> {
  const key = String(id)
  const cached = programDetailCache.get(key)
  if (cached) return cached
  const detail = await getNeteaseProgramDetail(id)
  if (detail) programDetailCache.set(key, detail)
  return detail
}

export async function fetchNeteaseRedCounts(songIds: Array<string | number>, signal?: AbortSignal): Promise<Record<string, number>> {
  const uniqueIds = [...new Set(songIds.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 40)
  if (uniqueIds.length === 0) return {}
  try {
    const payload = await request('/red-counts', { cookie: getExploreCookie('netease'), ids: uniqueIds.join(',') }, signal)
    const counts = payload?.counts
    if (!counts || typeof counts !== 'object') return {}
    return Object.fromEntries(Object.entries(counts).filter(([, value]) => Number.isFinite(Number(value))).map(([id, value]) => [id, Number(value)]))
  } catch {
    return {}
  }
}

export async function fetchNeteasePodcastHome(signal?: AbortSignal): Promise<NeteaseNativeHome> {
  const payload = await request('/podcast-home', { cookie: getExploreCookie('netease') }, signal)
  const data = payload?.data || {}
  return normalizeNeteaseHome({ ...payload, data: { ...data, blocks: data.blockVOS || [] } })
}

/** 歌曲详情：新歌新碟等卡片只给 song id 时用它补齐播放信息 */
export async function fetchNeteaseSongDetail(ids: Array<string | number>, signal?: AbortSignal): Promise<Song[]> {
  const list = [...new Set(ids.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 20)
  if (list.length === 0) return []
  return normalizeNeteaseSongs(await request('/song-detail', { cookie: getExploreCookie('netease'), ids: list.join(',') }, signal))
}

/** 相似歌曲：种子来自推荐页卡片自带的 sourceId 列表（无需当前播放） */
export async function fetchNeteaseSimilarSongs(seedIds: Array<string | number>, signal?: AbortSignal): Promise<Song[]> {
  const ids = [...new Set(seedIds.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 3)
  if (ids.length === 0) return []
  return normalizeNeteaseSongs(await request('/similar-songs', { cookie: getExploreCookie('netease'), ids: ids.join(',') }, signal))
}

/** 相似艺人：种子艺人 id 来自推荐页卡片，取其热门歌曲 */
export async function fetchNeteaseArtistRadio(artistIds: Array<string | number>, signal?: AbortSignal): Promise<Song[]> {
  const ids = [...new Set(artistIds.map(String).filter(id => /^\d+$/.test(id)))].slice(0, 3)
  if (ids.length === 0) return []
  return normalizeNeteaseSongs(await request('/artist-radio', { cookie: getExploreCookie('netease'), ids: ids.join(',') }, signal))
}
