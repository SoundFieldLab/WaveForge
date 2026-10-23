import type { Song } from '../services/musicApi'

export type ViewMode = 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance' | 'singalong' | 'inparty'

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
  | 'explore-apple'
  | 'explore-fm'
  | 'desktop-playlist'
  | 'traditional-playlist'
  | 'traditional-search'
  | 'traditional-recent'
  | 'traditional-library'
  | 'traditional-album'
  | 'traditional-artist'
  /** 汽水听歌模式：场景电台 / 探索卡片起的播（用于「切出看歌」后回到听歌模式页） */
  | 'soda-scene'

export interface PlaybackOrigin {
  mode?: ViewMode
  surface: PlaybackSurface
  platform?: import('../services/platforms').MusicPlatform
  searchMode?: import('../services/platforms').MusicPlatform | 'fused'
  artistId?: string | number
  albumId?: string | number
  artistTab?: 'hotSongs' | 'allSongs' | 'albums' | 'videos' | 'programs' | 'similarArtists' | 'info'
  playlist?: unknown
  songs?: Song[]
  detail?: unknown
  continuation?: 'explore-infinite'
  neteaseContinuation?:
    | { mode: 'heart-mode'; playlistId: string }
    | { mode: 'roam' }
  qqRadarContinuation?: {
    mode: 'radar'
    page: number
    reqType: number
    entranceSongs: number[]
  }
}

export type SongSelectHandler = (
  song: Song,
  playlist?: Song[],
  origin?: PlaybackOrigin,
  /** 调用方知道点击项在 playlist 中的下标时传入：同名歌重复出现时按位置精确定位 */
  sourceIndex?: number,
) => void
