/**
 * Spotify 服务（官方 Web API）
 *
 * 登录：OAuth 授权码流（主进程弹窗，token 存 localStorage）。
 * 未登录时播放降级（resolvePlayableSong 匹配网易云/QQ）。
 * 歌词：官方无歌词 API → 由上层走 Lrclib/AMLL 兜底。
 */

import type { Song } from './musicApi'
import { getPlatformCookie } from './platforms'

const API = 'https://api.spotify.com/v1'
const TOKEN_URL = 'https://accounts.spotify.com/api/token'
/** 与主进程一致的公开 Client ID（spotifyd 官方注册） */
const CLIENT_ID = '65b708073fc0480ea92a077233ca87bd'

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
        client_id: CLIENT_ID,
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

export async function spotifyFetch(path: string): Promise<any | null> {
  const token = getSpotifyToken()
  if (!token) return null
  try {
    const resp = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    // 401：access token 过期，尝试刷新后重试一次
    if (resp.status === 401) {
      const refreshed = await refreshSpotifyToken()
      if (refreshed) {
        const retry = await fetch(`${API}${path}`, {
          headers: { Authorization: `Bearer ${getSpotifyToken()}` },
        })
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
  artists: Array<{ name: string }>
  album?: { name: string; images?: Array<{ url: string }> }
  duration_ms?: number
  explicit?: boolean
}

function normalizeTrack(item: any): SpotifyTrack {
  return {
    id: String(item.id || ''),
    name: String(item.name || ''),
    artists: (item.artists || []).map((a: any) => ({ name: String(a.name || '') })),
    album: item.album
      ? { name: String(item.album.name || ''), images: item.album.images || [] }
      : undefined,
    duration_ms: item.duration_ms,
    explicit: Boolean(item.explicit),
  }
}

/** 搜索歌曲 */
export async function searchSpotifySongs(keyword: string, limit = 30): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/search?q=${encodeURIComponent(keyword)}&type=track&limit=${limit}`)
  return (data?.tracks?.items || []).map(normalizeTrack).filter((t: SpotifyTrack) => t.id && t.name)
}

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
export async function fetchSpotifyFeaturedPlaylists(limit = 30): Promise<Array<{ id: string; name: string; coverUrl?: string }>> {
  const data = await spotifyFetch(`/browse/featured-playlists?limit=${limit}`)
  return (data?.playlists?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
  }))
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

/** 我的歌单 */
export async function fetchSpotifyMyPlaylists(limit = 50): Promise<Array<{ id: string; name: string; coverUrl?: string }>> {
  const data = await spotifyFetch(`/me/playlists?limit=${limit}`)
  return (data?.items || []).map((item: any) => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    coverUrl: item.images?.[0]?.url || undefined,
  }))
}

/** 我喜欢的歌曲（Library） */
export async function fetchSpotifyLiked(limit = 50): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/me/tracks?limit=${limit}`)
  return (data?.items || []).map((item: any) => normalizeTrack(item.track)).filter((t: SpotifyTrack) => t.id && t.name)
}

/** 歌单详情 */
export async function fetchSpotifyPlaylist(playlistId: string, limit = 50): Promise<SpotifyTrack[]> {
  const data = await spotifyFetch(`/playlists/${playlistId}/tracks?limit=${limit}`)
  return (data?.items || []).map((item: any) => normalizeTrack(item.track)).filter((t: SpotifyTrack) => t.id && t.name)
}

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
