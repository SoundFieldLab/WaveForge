import type { MusicPlatform } from './platforms'
import type { Song } from './musicApi'
import { getLikedSongs } from './playlistService'

export type FavoritePlatform = MusicPlatform

const favoriteIdsCache = new Map<string, Set<string>>()
const pendingLoads = new Map<string, Promise<Set<string>>>()
// 缓存尚未加载完成期间发生的红心变更（乐观更新）：加载完成后需合并回快照，
// 否则慢加载的旧列表会覆盖用户刚做的喜欢/取消喜欢，导致重开菜单显示回退。
const pendingOwnerMutations = new Map<string, Array<{ identifier: string; add: boolean }>>()

const ownerKey = (platform: FavoritePlatform, userId: string) => `${platform}:${userId}`

export function getFavoriteUserId(platform: FavoritePlatform): string {
  if (platform === 'apple') {
    // Apple 无 userId；用固定归属键（登录态存在时），凭据失效即自然失效
    return localStorage.getItem('appleMediaUserToken') ? 'apple-user' : ''
  }
  if (platform === 'qq') return localStorage.getItem('qq_user_id') || ''
  // 汽水：归属键用自身登录态
  if (platform === 'soda') return localStorage.getItem('soda_user_id') || ''
  // 酷狗/Spotify：各用各的登录归属键；旧会话未落 userId 时凭凭据存在性给固定键兜底
  // （与 apple 同款策略）。绝不回落到其它平台的归属键——曾把酷狗 id 当网易云 uid 打错接口，
  // 喜欢缓存也跨平台互染。
  if (platform === 'kugou') {
    return localStorage.getItem('kugou_user_id')
      || (localStorage.getItem('kugou_cookie') ? 'kugou-user' : '')
  }
  if (platform === 'spotify') {
    return localStorage.getItem('spotify_user_id')
      || (localStorage.getItem('spotify_access_token') ? 'spotify-user' : '')
  }
  return localStorage.getItem('netease_user_id') || ''
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
      // 合并加载期间的乐观变更（applyFavoriteMutation 在缓存未就绪时记录的增量）
      const deltas = pendingOwnerMutations.get(key)
      if (deltas) {
        deltas.forEach(({ identifier, add }) => {
          if (add) ids.add(identifier)
          else ids.delete(identifier)
        })
        pendingOwnerMutations.delete(key)
      }
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
  if (!identifiers.length) return
  const key = ownerKey(detail.platform, userId)

  if (!ids) {
    // 缓存尚未加载完成（loadFavoriteIdentifiers 在途）：只记录增量，
    // 由加载完成的合并逻辑落地，避免先到先建的空集污染缓存
    const deltas = pendingOwnerMutations.get(key) || []
    const add = detail.type === 'like'
    identifiers.forEach(identifier => deltas.push({ identifier, add }))
    pendingOwnerMutations.set(key, deltas)
    return
  }

  identifiers.forEach(identifier => {
    if (detail.type === 'like') ids.add(identifier)
    else ids.delete(identifier)
  })
}
