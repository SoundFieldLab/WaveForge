import type { MusicPlatform } from './platforms'

export interface PlaylistOwnershipContext {
  neteaseUserId?: string | number
  qqUserId?: string | number
  spotifyUserId?: string | number
  kugouUserId?: string | number
  sodaUserId?: string | number
}

export function isSpecialPlaylist(playlist: any): boolean {
  const id = String(playlist?.id || playlist?.dirId || '')
  return Boolean(playlist?.isLike) || id === '__apple_library__' || id === '__apple_favorites__'
}

export function isPlaylistOwner(playlist: any, context: PlaylistOwnershipContext = {}): boolean {
  if (!playlist || isSpecialPlaylist(playlist) || playlist.isCollected || playlist.subscribed) return false
  const platform = (playlist.platform || 'netease') as MusicPlatform
  if (platform === 'apple') return playlist.ownedByMe === true
  if (playlist.ownedByMe === true) return true
  if (platform === 'spotify') return Boolean(playlist.owner && context.spotifyUserId && String(playlist.owner) === String(context.spotifyUserId))
  const ownerId = playlist.userId ?? playlist.creator?.userId ?? playlist.ownerId
  const currentUserId = platform === 'netease' ? context.neteaseUserId
    : platform === 'qq' ? context.qqUserId
      : platform === 'kugou' ? context.kugouUserId
        : platform === 'soda' ? context.sodaUserId : undefined
  return Boolean(ownerId !== undefined && ownerId !== null && currentUserId && String(ownerId) === String(currentUserId))
}
