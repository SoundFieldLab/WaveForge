import type { MusicPlatform } from './platforms'
import type { Song } from './musicApi'
import { getLikedSongs } from './playlistService'

export type FavoritePlatform = MusicPlatform

const favoriteIdsCache = new Map<string, Set<string>>()
const pendingLoads = new Map<string, Promise<Set<string>>>()

const ownerKey = (platform: FavoritePlatform, userId: string) => `${platform}:${userId}`

export function getFavoriteUserId(platform: FavoritePlatform): string {
  if (platform === 'apple') {
    // Apple 无 userId；用固定归属键（登录态存在时），凭据失效即自然失效
    return localStorage.getItem('appleMediaUserToken') ? 'apple-user' : ''
  }
  return platform === 'qq'
    ? localStorage.getItem('qq_user_id') || ''
    : localStorage.getItem('netease_user_id') || ''
}

export function getFavoriteSongIdentifiers(song: Song): string[] {
  return [song.id, song.mid]
    .filter(value => value !== undefined && value !== null && String(value).trim())
    .map(value => String(value))
}

export function peekSongFavoriteStatus(
  song: Song,
  platform: FavoritePlatform,
  userId: string,
): boolean | null {
  if (!userId) return false
  const ids = favoriteIdsCache.get(ownerKey(platform, userId))
  if (!ids) return null
  return getFavoriteSongIdentifiers(song).some(identifier => ids.has(identifier))
}

export function loadFavoriteIdentifiers(
  platform: FavoritePlatform,
  userId: string,
): Promise<Set<string>> {
  if (!userId) return Promise.resolve(new Set())
  const key = ownerKey(platform, userId)
  const cached = favoriteIdsCache.get(key)
  if (cached) return Promise.resolve(cached)
  const pending = pendingLoads.get(key)
  if (pending) return pending

  const request = getLikedSongs(userId, platform)
    .then(data => {
      const values = platform === 'qq'
        ? [...(Array.isArray(data?.ids) ? data.ids : []), ...(Array.isArray(data?.mids) ? data.mids : [])]
        : (Array.isArray(data?.ids) ? data.ids : [])
      const ids = new Set<string>()
      values.forEach((value: unknown) => ids.add(String(value)))
      favoriteIdsCache.set(key, ids)
      return ids
    })
    .finally(() => pendingLoads.delete(key))

  pendingLoads.set(key, request)
  return request
}

export function applyFavoriteMutation(detail: {
  platform?: FavoritePlatform
  type?: string
  songId?: string | number
  songMid?: string
}): void {
  if (!detail.platform || (detail.type !== 'like' && detail.type !== 'unlike')) return
  const userId = getFavoriteUserId(detail.platform)
  if (!userId) return
  const ids = favoriteIdsCache.get(ownerKey(detail.platform, userId))
  if (!ids) return

  const identifiers = [detail.songId, detail.songMid]
    .filter(value => value !== undefined && value !== null && String(value).trim())
    .map(value => String(value))
  identifiers.forEach(identifier => {
    if (detail.type === 'like') ids.add(identifier)
    else ids.delete(identifier)
  })
}
