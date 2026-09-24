import type { Song } from './musicApi'

export interface NeteaseRecentSongResult {
  songs: Song[]
  total: number
}

const RECENT_CACHE_TTL_MS = 30_000
const recentCache = new Map<string, { value: NeteaseRecentSongResult; expiresAt: number }>()
const pendingRequests = new Map<string, Promise<NeteaseRecentSongResult>>()

// 缓存键含原始 cookie（换号即换键，不会串号），但旧账号的条目会一直留着；
// 登录态变化时清一次，既释放也避免语义上的残留。
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => recentCache.clear())
}

function getRecentRows(payload: any): any[] {
  const candidates = [
    payload?.data?.list,
    payload?.data?.records,
    payload?.data?.songs,
    payload?.data,
    payload?.list,
    payload?.records,
    payload?.songs,
    payload?.weekData,
    payload?.allData,
  ]
  return candidates.find(Array.isArray) || []
}

export function getNeteaseArtwork(raw: any): string {
  const source = raw?.resource || raw?.data || raw?.song || raw || {}
  const nested = source?.song || source?.data || raw?.resource?.song || raw?.data?.song || raw?.song || {}
  const album = source?.al || source?.album || nested?.al || nested?.album || {}
  return String(
    album?.picUrl
      || album?.picurl
      || album?.blurPicUrl
      || album?.coverUrl
      || source?.coverUrl
      || nested?.coverUrl
      || source?.albumpic
      || nested?.albumpic
      || source?.picUrl
      || nested?.picUrl
      || '',
  )
}

export function normalizeNeteaseRecentSong(raw: any): Song | null {
  const source = raw?.resource || raw?.data || raw?.song || raw || {}
  const nested = source?.song || source?.data || raw?.resource?.song || raw?.data?.song || raw?.song || source
  const id = Number(nested?.id ?? source?.id ?? raw?.songId ?? raw?.resourceId)
  if (!Number.isFinite(id)) return null
  const artists = nested?.ar || nested?.artists || nested?.singer || []
  const album = nested?.al || nested?.album || source?.al || source?.album || {}
  return {
    id,
    name: nested?.name || source?.name || '未知歌曲',
    artists: Array.isArray(artists)
      ? artists.map((artist: any) => ({ id: artist.id, name: artist.name || artist.n || '未知歌手', mid: artist.mid }))
      : [],
    album: {
      id: album.id,
      name: album.name || '未知专辑',
      picUrl: getNeteaseArtwork(raw),
      mid: album.mid,
      pmid: album.pmid,
    },
    duration: Number(nested?.dt || nested?.duration || source?.dt || 0),
    platform: 'netease',
    vip: nested?.privilege?.st === -200 || Boolean(nested?.fee === 1),
    fee: nested?.fee,
  }
}

function cacheKey(cookie: string, limit: number): string {
  return `${cookie}:${limit}`
}

export async function fetchNeteaseRecentSongs(cookie: string, limit = 100): Promise<NeteaseRecentSongResult> {
  const key = cacheKey(cookie, limit)
  const cached = recentCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.value
  if (cached) recentCache.delete(key)
  const pending = pendingRequests.get(key)
  if (pending) return pending

  const request = (async () => {
    const query = new URLSearchParams({ limit: String(limit), cookie })
    const response = await fetch(`http://localhost:3001/api/netease/record/recent/song?${query.toString()}`, { cache: 'no-store' })
    const payload = await response.json()
    if (!response.ok || payload?.error) throw new Error(payload?.error || 'recent playback unavailable')
    const rows = getRecentRows(payload)
    const songs = rows.map(normalizeNeteaseRecentSong).filter((song): song is Song => Boolean(song && song.name !== '未知歌曲'))
    const reportedCount = Number(payload?.total ?? payload?.data?.total ?? payload?.songnum ?? rows.length)
    const value = { songs, total: Number.isFinite(reportedCount) ? reportedCount : rows.length }
    recentCache.set(key, { value, expiresAt: Date.now() + RECENT_CACHE_TTL_MS })
    return value
  })()
  pendingRequests.set(key, request)
  void request.finally(() => {
    if (pendingRequests.get(key) === request) pendingRequests.delete(key)
  }).catch(() => undefined)
  return request
}

export function clearNeteaseRecentCache(): void {
  recentCache.clear()
}
