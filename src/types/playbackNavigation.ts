import type { Song } from '../services/musicApi'

export type ViewMode = 'explore' | 'minimal' | 'traditional' | 'desktop'

export type PlaybackSurface =
  | 'mode-root'
  | 'home'
  | 'home-playlist'
  | 'search'
  | 'search-artist'
  | 'search-album'
  | 'search-artist-album'
  | 'artist'
  | 'artist-album'
  | 'album'
  | 'explore-detail'
  | 'explore-fm'
  | 'desktop-playlist'
  | 'traditional-playlist'
  | 'traditional-search'
  | 'traditional-recent'
  | 'traditional-library'
  | 'traditional-album'
  | 'traditional-artist'

export interface PlaybackOrigin {
  mode?: ViewMode
  surface: PlaybackSurface
  platform?: import('../services/platforms').MusicPlatform
  searchMode?: import('../services/platforms').MusicPlatform | 'fused'
  artistId?: string | number
  albumId?: string | number
  artistTab?: 'hotSongs' | 'allSongs' | 'albums' | 'videos' | 'similarArtists' | 'info'
  playlist?: unknown
  songs?: Song[]
  detail?: unknown
  continuation?: 'explore-infinite'
}

export type SongSelectHandler = (
  song: Song,
  playlist?: Song[],
  origin?: PlaybackOrigin,
) => void
