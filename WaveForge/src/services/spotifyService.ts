/**
 * Spotify 服务（官方 Web API，前端直连，CORS 允许）
 *
 * 登录：OAuth 授权码流（主进程弹窗，token 存 localStorage）。
 * 播放：官方音频流受 DRM 保护，无公开直链 → 由 resolvePlayableSong 匹配网易云/QQ 播放。
 * 歌词：官方无歌词 API → 由上层走 Lrclib/AMLL 兜底。
 */

import type { Song } from './musicApi'
import { getPlatformCookie } from './platforms'

const API = 'https://api.spotify.com/v1'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
/** 默认公开 Client ID（spotifyd 官方注册；共享 ID 可能被 Spotify 风控，支持用户自定义） */
const DEFAULT_CLIENT_ID = '65b708073fc0480ea92a077233ca87bd'

/** 读取用户自定义 Client ID（设置里配置），未配置时用默认 */
export function getSpotifyClientId(): string {
  try {
    const custom = localStorage.getItem('spotify_client_id')
    if (custom && /^[0-9a-f]{32}$/i.test(custom.trim())) return custom.trim()
  } catch { /* 忽略 */ }
  return DEFAULT_CLIENT_ID
}

export function getSpotifyToken(): string {
  return getPlatformCookie('spotify')
}

export function getSpotifyRefreshToken(): string {
  return localStorage.getItem('spotify_refresh_token') || ''
}

export function isSpotifyLoggedIn(): boolean {
  return Boolean(getSpotifyToken())
}

/** 用 refresh token 换新 access token（access token 约 1 小时过期） */
async function refreshSpotifyToken(): Promise<boolean> {
  const refreshToken = getSpotifyRefreshToken()
  if (!refreshToken) return false
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: getSpotifyClientId(),
      }),
    })
    if (!resp.ok) return false
    const data = await resp.json()
    if (!data.access_token) return false
    localStorage.setItem('spotify_access_token', data.access_token)
    // Spotify 刷新可能返回新 refresh token，也更新
    if (data.refresh_token) localStorage.setItem('spotify_refresh_token', data.refresh_token)
    return true
  } catch (e) {
    console.warn('[Spotify] token 刷新失败:', e)
    return false
  }
}

export async function spotifyFetch(path: string, init?: RequestInit): Promise<any | null> {
  const token = getSpotifyToken()
  if (!token) return null
  try {
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${token}`)
    const resp = await fetch(`${API}${path}`, { ...init, headers })
    // 401：access token 过期，尝试刷新后重试一次
    if (resp.status === 401) {
      const refreshed = await refreshSpotifyToken()
      if (refreshed) {
        const retryHeaders = new Headers(init?.headers)
        retryHeaders.set('Authorization', `Bearer ${getSpotifyToken()}`)
        const retry = await fetch(`${API}${path}`, { ...init, headers: retryHeaders })
        if (retry.ok) return retry.json()
      }
      return null
    }
    if (!resp.ok) return null
    return resp.json()
  } catch (e) {
    console.warn('[Spotify] 请求失败:', e)
    return null
  }
}

export interface SpotifyTrack {
  id: string
  name: string
  artists: Array<{ name: string; id?: string }>
  album?: { id?: string; name: string; images?: Array<{ url: string }> }
  duration_ms?: number
  explicit?: boolean
  preview_url?: string | null
}

export interface SpotifyPlaylist {
  id: string
  name: string
  description?: string
  coverUrl?: string
  owner?: string
  public?: boolean
  tracksTotal?: number
  /** 是否本人创建 */
  ownedByMe?: boolean
}

function normalizeTrack(item: any): SpotifyTrack {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    artists: (item.artists || []).map((a: any) => ({ name: String(a.name || ''), id: a.id ? String(a.id) : undefined })),
    album: item.album
      ? { id: item.album.id ? String(item.album.id) : undefined, name: String(item.album.name || ''), images: item.album.images || [] }
      : undefined,
    duration_ms: item.duration_ms,
    explicit: Boolean(item.explicit),
    preview_url: item.preview_url || null,
  }
}

function normalizePlaylist(item: any, myId?: string): SpotifyPlaylist {
  const owner = item.owner?.id || item.owner?.display_name || ''
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    description: item.description || undefined,
    coverUrl: item.images?.[0]?.url || undefined,
    owner: String(owner || ''),
    public: item.public !== false,
    tracksTotal: item.tracks?.total ?? item.tracks_total,
    ownedByMe: Boolean(myId && owner && owner === myId),
  }
}

/** 分页拉取（自动翻页，最多 maxPages 页） */
async function spotifyPaginate<T>(path: string, extract: (data: any) => any[], maxPages = 2, perPage = 50): Promise<T[]> {
  const all: any[] = []
  for (let page = 0; page < maxPages; page += 1) {
    const sep = path.includes('?') ? '&' : '?'
    const data = await spotifyFetch(`${path}${sep}limit=${perPage}&offset=${page * perPage}`)
    if (!data) break
    const items = extract(data) || []
    all.push(...items)
    if (items.length < perPage) break
  }
  return all
}

// ─────────────────────────── 搜索 ───────────────────────────

/** 搜索歌曲 */
export async function searchSpotifySongs(keyword: string, limit = 30): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(keyword)}&type=track&limit=${limit}`)
  return (data?.tracks?.items || []).map(normalizeTrack).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 搜索艺人 */
export async function searchSpotifyArtists(keyword: string, limit = 20): Promise<Array<{ id: string; name: string; coverUrl?: string; followers?: number }>> {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(keyword)}&type=artist&limit=${limit}`)
  return (data?.artists?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
    followers: item.followers?.total,
  }))
}

/** 搜索专辑 */
export async function searchSpotifyAlbums(keyword: string, limit = 20): Promise<Array<{ id: string; name: string; artists: Array<{ name: string }>; coverUrl?: string; releaseDate?: string }>> {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(keyword)}&type=album&limit=${limit}`)
  return (data?.albums?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    artists: (item.artists || []).map((a: any) => ({ name: String(a.name || '') })),
    coverUrl: item.images?.[0]?.url || undefined,
    releaseDate: item.release_date || undefined,
  }))
}

/** 搜索歌单 */
export async function searchSpotifyPlaylists(keyword: string, limit = 20): Promise<SpotifyPlaylist[]> {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(keyword)}&type=playlist&limit=${limit}`)
  return (data?.playlists?.items || []).map((item: any) => normalizePlaylist(item)).filter((p: SpotifyPlaylist) => p.id && p.name)
}

// ─────────────────────────── 探索 ───────────────────────────

/** 新发行（探索页） */
export async function fetchSpotifyNewReleases(limit = 30): Promise<Array<{ id: string; name: string; artists: Array<{ name: string }>; coverUrl?: string }>> {
  const data = await spotifyFetch(`/browse/new-releases?limit=${limit}`)
  return (data?.albums?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    artists: (item.artists || []).map((a: any) => ({ name: String(a.name || '') })),
    coverUrl: item.images?.[0]?.url || undefined,
  }))
}

/** 特色歌单（探索页） */
export async function fetchSpotifyFeaturedPlaylists(limit = 30): Promise<SpotifyPlaylist[]> {
  const data = await spotifyFetch(`/browse/featured-playlists?limit=${limit}`)
  return (data?.playlists?.items || []).map((item: any) => normalizePlaylist(item)).filter((p: SpotifyPlaylist) => p.id && p.name)
}

/** 分类（探索页） */
export async function fetchSpotifyCategories(limit = 30): Promise<Array<{ id: string; name: string; coverUrl?: string }>> {
  const data = await spotifyFetch(`/browse/categories?limit=${limit}`)
  return (data?.categories?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.icons?.[0]?.url || undefined,
  }))
}

/** 分类下的歌单 */
export async function fetchSpotifyCategoryPlaylists(categoryId: string, limit = 20): Promise<SpotifyPlaylist[]> {
  const data = await spotifyFetch(`/browse/categories/${encodeURIComponent(categoryId)}/playlists?limit=${limit}`)
  return (data?.playlists?.items || []).map((item: any) => normalizePlaylist(item)).filter((p: SpotifyPlaylist) => p.id && p.name)
}

/**
 * 探索页榜单：Spotify 无榜单接口，用官方稳定 Top 榜歌单充当（Global Top 50 / Viral 50 / 中国 Top 50）。
 * 任一抓取失败该榜自动隐藏。
 */
const TOP_PLAYLIST_IDS: Array<{ id: string; name: string }> = [
  { id: '37i9dQZEVXbMDoHDwVN2tF', name: '全球 Top 50' },
  { id: '37i9dQZEVXbLiRSa8hR9mA', name: '全球 Viral 50' },
]
export async function fetchSpotifyCharts(): Promise<Array<{ id: string; name: string; coverUrl?: string; songs: SpotifyTrack[] }>> {
  const charts: Array<{ id: string; name: string; coverUrl?: string; songs: SpotifyTrack[] }> = []
  for (const chart of TOP_PLAYLIST_IDS) {
    const songs = await fetchSpotifyPlaylist(chart.id, 30)
    if (!songs.length) continue
    const info = await spotifyFetch(`/playlists/${chart.id}?fields=images`)
    charts.push({ id: chart.id, name: chart.name, coverUrl: info?.images?.[0]?.url, songs })
  }
  return charts
}

// ─────────────────────────── 歌单 ───────────────────────────

/** 我的歌单（含 ownedByMe 标记） */
export async function fetchSpotifyMyPlaylists(limit = 50): Promise<SpotifyPlaylist[]> {
  const me = await fetchSpotifyMe()
  const myId = me?.id || ''
  const items = await spotifyPaginate<any>('/me/playlists', (data) => data?.items || [], 2, 50)
  return items.map((item: any) => normalizePlaylist(item, myId)).filter((p: SpotifyPlaylist) => p.id && p.name)
}

/** 歌单详情（含歌单信息 + 全部曲目，自动翻页） */
export async function fetchSpotifyPlaylistDetail(playlistId: string): Promise<{ playlist: SpotifyPlaylist; songs: SpotifyTrack[] } | null> {
  const info = await spotifyFetch(`/playlists/${playlistId}?fields=id,name,description,images,owner,public,tracks(total)`)
  if (!info?.id) return null
  const tracks = await spotifyPaginate<SpotifyTrack>(`/playlists/${playlistId}/tracks`, (data) => (data?.items || []).map((i: any) => i.track), 8, 50)
  return {
    playlist: normalizePlaylist(info),
    songs: tracks.filter((t: SpotifyTrack) => t.id && t.name),
  }
}

/** 歌单曲目（探索/榜单用，最多 2 页） */
export async function fetchSpotifyPlaylist(playlistId: string, limit = 50): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/playlists/${playlistId}/tracks?limit=${limit}`)
  return (data?.items || []).map((item: any) => normalizeTrack(item.track)).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 创建歌单 */
export async function createSpotifyPlaylist(name: string, description = '', isPublic = true): Promise<string | null> {
  const me = await fetchSpotifyMe()
  if (!me?.id) return null
  const data = await spotifyFetch(`/users/${me.id}/playlists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description, public: isPublic }),
  })
  return data?.id ? String(data.id) : null
}

/** 删除歌单（Spotify 无删除接口：改为清空曲目 + 改名「已删除」不可行，返回明确不支持） */
export async function deleteSpotifyPlaylist(_playlistId: string): Promise<boolean> {
  // Spotify Web API 不提供删除歌单接口（用户可在官方客户端删除）
  return false
}

/** 改名歌单 */
export async function renameSpotifyPlaylist(playlistId: string, name: string, description?: string): Promise<boolean> {
  const data = await spotifyFetch(`/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description: description ?? undefined }),
  })
  return data !== null
}

/** 加歌到歌单（trackIds 为 Spotify track id） */
export async function addTracksToSpotifyPlaylist(playlistId: string, trackIds: string[]): Promise<boolean> {
  if (!trackIds.length) return false
  const data = await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: trackIds.map(id => `spotify:track:${id}`) }),
  })
  return data !== null
}

/** 从歌单移除歌曲 */
export async function removeTracksFromSpotifyPlaylist(playlistId: string, trackIds: string[]): Promise<boolean> {
  if (!trackIds.length) return false
  const data = await spotifyFetch(`/playlists/${playlistId}/tracks`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks: trackIds.map(id => ({ uri: `spotify:track:${id}` })) }),
  })
  return data !== null
}

/** 收藏/取消收藏歌单（follow/unfollow） */
export async function followSpotifyPlaylist(playlistId: string, follow: boolean): Promise<boolean> {
  const data = await spotifyFetch(`/playlists/${playlistId}/followers`, {
    method: follow ? 'PUT' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  return data !== null
}

/** 是否已收藏歌单 */
export async function isSpotifyPlaylistFollowed(playlistId: string): Promise<boolean> {
  const data = await spotifyFetch(`/playlists/${playlistId}/followers/contains?ids=spotify:user:me`)
  return Array.isArray(data) && data[0] === true
}

// ─────────────────────────── 喜欢（Library） ───────────────────────────

/** 我喜欢的歌曲 */
export async function fetchSpotifyLiked(limit = 50): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/me/tracks?limit=${limit}`)
  return (data?.items || []).map((item: any) => normalizeTrack(item.track)).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 喜欢/取消喜欢 */
export async function likeSpotifyTracks(trackIds: string[], like: boolean): Promise<boolean> {
  if (!trackIds.length) return false
  const data = await spotifyFetch(`/me/tracks?ids=${encodeURIComponent(trackIds.join(','))}`, {
    method: like ? 'PUT' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  return data !== null
}

/** 批量查询喜欢状态（返回 Set<trackId>） */
export async function areSpotifyTracksLiked(trackIds: string[]): Promise<Set<string>> {
  if (!trackIds.length) return new Set()
  const data = await spotifyFetch(`/me/tracks/contains?ids=${encodeURIComponent(trackIds.join(','))}`)
  if (!Array.isArray(data)) return new Set()
  const liked = new Set<string>()
  data.forEach((v, i) => { if (v && trackIds[i]) liked.add(trackIds[i]) })
  return liked
}

// ─────────────────────────── 专辑 / 艺人 ───────────────────────────

/** 专辑详情 + 曲目 */
export async function fetchSpotifyAlbum(albumId: string): Promise<{ id: string; name: string; coverUrl?: string; artists: Array<{ name: string; id?: string }>; releaseDate?: string; songs: SpotifyTrack[] } | null> {
  const info = await spotifyFetch(`/albums/${albumId}`)
  if (!info?.id) return null
  return {
    id: String(info.id),
    name: String(info.name || ''),
    coverUrl: info.images?.[0]?.url || undefined,
    artists: (info.artists || []).map((a: any) => ({ name: String(a.name || ''), id: a.id ? String(a.id) : undefined })),
    releaseDate: info.release_date || undefined,
    songs: (info.tracks?.items || []).map(normalizeTrack).filter((t: SpotifyTrack) => t.id && t.name),
  }
}

/** 收藏/取消收藏专辑 */
export async function saveSpotifyAlbums(albumIds: string[], save: boolean): Promise<boolean> {
  if (!albumIds.length) return false
  const data = await spotifyFetch(`/me/albums?ids=${encodeURIComponent(albumIds.join(','))}`, {
    method: save ? 'PUT' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  return data !== null
}

/** 已保存的专辑 */
export async function fetchSpotifySavedAlbums(limit = 50): Promise<Array<{ id: string; name: string; artists: Array<{ name: string }>; coverUrl?: string }>> {
  const items = await spotifyPaginate<any>('/me/albums', (data) => data?.items || [], 2, 50)
  return items.map((item: any) => {
    const album = item.album || item
    return {
      id: String(album.id || ''),
      name: String(album.name || ''),
      artists: (album.artists || []).map((a: any) => ({ name: String(a.name || '') })),
      coverUrl: album.images?.[0]?.url || undefined,
    }
  }).filter((a: { id: string; name: string; artists: Array<{ name: string }>; coverUrl?: string }) => a.id && a.name)
}

/** 艺人详情 */
export async function fetchSpotifyArtist(artistId: string): Promise<{ id: string; name: string; coverUrl?: string; followers?: number; genres?: string[] } | null> {
  const data = await spotifyFetch(`/artists/${artistId}`)
  if (!data?.id) return null
  return {
    id: String(data.id),
    name: String(data.name || ''),
    coverUrl: data.images?.[0]?.url || undefined,
    followers: data.followers?.total,
    genres: data.genres || [],
  }
}

/** 艺人热门曲目 */
export async function fetchSpotifyArtistTopTracks(artistId: string, market = 'CN', limit = 20): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/artists/${artistId}/top-tracks?market=${market}`)
  return (data?.tracks || []).slice(0, limit).map(normalizeTrack).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 艺人专辑 */
export async function fetchSpotifyArtistAlbums(artistId: string, limit = 20): Promise<Array<{ id: string; name: string; coverUrl?: string; releaseDate?: string }>> {
  const data = await spotifyFetch(`/artists/${artistId}/albums?limit=${limit}&include_groups=album,single`)
  return (data?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
    releaseDate: item.release_date || undefined,
  })).filter((a: { id: string; name: string; coverUrl?: string; releaseDate?: string }) => a.id && a.name)
}

/** 相关艺人 */
export async function fetchSpotifyRelatedArtists(artistId: string, limit = 10): Promise<Array<{ id: string; name: string; coverUrl?: string }>> {
  const data = await spotifyFetch(`/artists/${artistId}/related-artists`)
  return (data?.artists || []).slice(0, limit).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
  })).filter((a: { id: string; name: string; coverUrl?: string }) => a.id && a.name)
}

/** 关注/取关艺人 */
export async function followSpotifyArtists(artistIds: string[], follow: boolean): Promise<boolean> {
  if (!artistIds.length) return false
  const data = await spotifyFetch(`/me/following?type=artist&ids=${encodeURIComponent(artistIds.join(','))}`, {
    method: follow ? 'PUT' : 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  })
  return data !== null
}

/** 我关注的艺人 */
export async function fetchSpotifyFollowingArtists(limit = 50): Promise<Array<{ id: string; name: string; coverUrl?: string }>> {
  const data = await spotifyFetch(`/me/following?type=artist&limit=${limit}`)
  return (data?.artists?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
  })).filter((a: { id: string; name: string; coverUrl?: string }) => a.id && a.name)
}

/** 是否关注了艺人 */
export async function areSpotifyArtistsFollowed(artistIds: string[]): Promise<Set<string>> {
  if (!artistIds.length) return new Set()
  const data = await spotifyFetch(`/me/following/contains?type=artist&ids=${encodeURIComponent(artistIds.join(','))}`)
  if (!Array.isArray(data)) return new Set()
  const followed = new Set<string>()
  data.forEach((v, i) => { if (v && artistIds[i]) followed.add(artistIds[i]) })
  return followed
}

// ─────────────────────────── 用户 ───────────────────────────

/** 用户信息（登录后） */
export async function fetchSpotifyMe(): Promise<{ displayName: string; id: string; images: Array<{ url: string }> } | null> {
  const data = await spotifyFetch('/me')
  if (!data) return null
  return {
    displayName: String(data.display_name || data.id || ''),
    id: String(data.id || ''),
    images: data.images || [],
  }
}

/** 我的 Top 歌曲（user-top-read scope） */
export async function fetchSpotifyTopTracks(limit = 20): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/me/top/tracks?limit=${limit}`)
  return (data?.items || []).map(normalizeTrack).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 最近播放（user-read-recently-played scope，未授权时返回空） */
export async function fetchSpotifyRecentlyPlayed(limit = 20): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/me/player/recently-played?limit=${limit}`)
  return (data?.items || []).map((item: any) => normalizeTrack(item.track)).filter((t: SpotifyTrack) => t.id && t.name)
}

/** Spotify 歌曲 → WaveForge Song */
export function spotifyTrackToSong(track: SpotifyTrack): Song {
  return {
    id: Number(parseInt(track.id.slice(0, 12), 36)) || 0,
    mid: track.id,
    name: track.name,
    artists: track.artists.map(a => ({ name: a.name })),
    album: {
      name: track.album?.name || '',
      picUrl: track.album?.images?.[0]?.url || '',
    },
    duration: track.duration_ms || 0,
    platform: 'spotify' as const,
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}
