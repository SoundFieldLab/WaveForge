/**
 * Spotify Partner 数据适配层（渲染端）
 *
 * 把主进程 partner 桥（api-partner GraphQL）返回的桌面端 schema，转成本项目
 * `spotifyService.ts` 定义的 Web API 形态（SpotifyPlaylist / SpotifyTrack）。
 * 调用方（ProfileView / playlistService）由此对两条通道无感：partner 可用走 partner
 * （不受 Web API 公共 client_id 限流影响），否则调用方回落原有 Web API 路径。
 *
 * 响应形态均经真机实测（2026-10-21，字段路径以实测为准）：
 *   libraryV3          → me.libraryV3.items[].item.data（歌单卡）
 *   fetchPlaylist      → playlistV2.content.items[].itemV2.data（曲目行）
 *   fetchLibraryTracks → me.library.tracks.items[].track.data（喜欢的歌曲）
 */

import type { SpotifyPlaylist, SpotifyTrack } from './spotifyService'

const PLAYLIST_URI_PREFIX = 'spotify:playlist:'
const TRACK_URI_PREFIX = 'spotify:track:'

const firstCover = (coverArt: any): string => {
  // 桌面端 schema 两种形态：{sources:[...]}（albumOfTrack.coverArt）与
  // {items:[{sources:[...]}]}（libraryV3 歌单 images）。统一剥到 sources。
  let sources = coverArt?.sources
  if (!Array.isArray(sources) && Array.isArray(coverArt?.items)) {
    sources = coverArt.items[0]?.sources
  }
  if (!Array.isArray(sources) || sources.length === 0) return ''
  // 官方面板口径取最大可用尺寸：sources 顺序不定，按 height 挑最大
  const best = sources.reduce((best: any, item: any) => ((item?.height ?? 0) > (best?.height ?? -1) ? item : best), sources[0])
  return String(best?.url ?? '')
}

const trackIdFromUri = (uri: unknown): string => {
  const value = String(uri ?? '')
  return value.startsWith(TRACK_URI_PREFIX) ? value.slice(TRACK_URI_PREFIX.length) : ''
}

/** 桌面端 Track 节点 → Web API SpotifyTrack 形态 */
function normalizePartnerTrack(data: any, fallbackAlbumName = ''): SpotifyTrack | null {
  if (!data || data.__typename !== 'Track') return null
  // 曲目 id 优先 data.uri；UserLibraryTrack 的包装把 _uri 挂在 track 外层（entry.track._uri）
  const id = trackIdFromUri(data.uri) || trackIdFromUri(data._uri)
  if (!id) return null
  const album = data.albumOfTrack ?? {}
  const cover = firstCover(album.coverArt)
  return {
    id,
    name: String(data.name ?? ''),
    artists: (album.artists?.items ?? data.artists?.items ?? [])
      .map((item: any) => ({ name: String(item?.profile?.name ?? item?.name ?? '') }))
      .filter((artist: { name: string }) => artist.name),
    album: {
      id: trackIdFromUri(album.uri) || undefined,
      name: String(album.name ?? fallbackAlbumName),
      images: cover ? [{ url: cover }] : undefined,
    },
    duration_ms: Number(data.duration?.totalMilliseconds) || undefined,
    explicit: Boolean(data.contentRating?.label === 'EXPLICIT'),
    preview_url: null,
  }
}

/** 桌面端 Playlist 节点 → Web API SpotifyPlaylist 形态 */
function normalizePartnerPlaylist(data: any, uri: string, myAccountId?: string): SpotifyPlaylist | null {
  if (!data || data.__typename !== 'Playlist') return null
  const id = trackIdFromUri(uri) || uri.replace(PLAYLIST_URI_PREFIX, '')
  if (!id) return null
  const owner = String(data.ownerV2?.data?.username ?? data.ownerV2?.data?.name ?? '')
  return {
    id,
    name: String(data.name ?? ''),
    description: String(data.description ?? '') || undefined,
    coverUrl: firstCover(data.images) || undefined,
    owner: owner || undefined,
    public: data.currentUserCapabilities?.canView !== false,
    tracksTotal: Number(data.trackCount ?? data.tracks?.totalCount) || 0,
    ownedByMe: Boolean(myAccountId && owner && owner === myAccountId),
  }
}

// ── 桥调用封装（未登录/桥缺失返回 null，调用方回落 Web API）────────────

async function partnerQuery(name: string, variables: Record<string, unknown>): Promise<any | null> {
  try {
    const { spotifyPartnerStatus, spotifyPartnerQuery } = await import('./spotifyPartnerClient')
    const status = await spotifyPartnerStatus()
    if (!status.loggedIn) return null
    return await spotifyPartnerQuery(name, variables)
  } catch {
    return null
  }
}

const currentPartnerAccountId = async (): Promise<string | undefined> => {
  try {
    const { spotifyPartnerStatus } = await import('./spotifyPartnerClient')
    const status = await spotifyPartnerStatus()
    // 桥账号 id 是本地哈希，与 ownerV2.username 不同源；ownedByMe 判定用 username
    return (status.user as any)?.username ?? undefined
  } catch {
    return undefined
  }
}

// ── 对外能力（形态与 spotifyService 同签名）──────────────────────

/** 我的歌单（libraryV3，自动翻页聚合）
 *  实测（2026-10-21）：features/libraryItemType 传非空值会被上游 400 拒——必须空参
 *  拉全量（歌单+艺人混合返回），这里自筛 __typename === 'Playlist'。 */
export async function fetchPartnerMyPlaylists(limit = 50): Promise<SpotifyPlaylist[] | null> {
  const myAccountId = await currentPartnerAccountId()
  const out: SpotifyPlaylist[] = []
  const pageSize = 50
  for (let offset = 0; offset < limit; offset += pageSize) {
    const page = await partnerQuery('libraryV3', {
      filters: [],
      order: null,
      textFilter: '',
      features: [],
      limit: pageSize,
      offset,
      flatten: false,
      expandedFolders: [],
      folderUris: [],
      includeFolders: true,
      withGid: true,
      libraryItemType: null,
      offsetInUri: false,
    })
    const items = page?.me?.libraryV3?.items
    if (!Array.isArray(items) || items.length === 0) break
    for (const entry of items) {
      const wrapper = entry?.item ?? entry
      if (wrapper?.data?.__typename !== 'Playlist') continue
      const playlist = normalizePartnerPlaylist(wrapper.data, String(wrapper?._uri ?? ''), myAccountId)
      if (playlist) out.push(playlist)
      if (out.length >= limit) return out
    }
    if (items.length < pageSize) break
  }
  return out.length > 0 ? out : null
}

/** 歌单详情 + 全部曲目（fetchPlaylist，自动翻页；行里带 uid 备将来歌单编辑用） */
export async function fetchPartnerPlaylistDetail(
  playlistId: string,
): Promise<{ playlist: SpotifyPlaylist; songs: SpotifyTrack[] } | null> {
  const myAccountId = await currentPartnerAccountId()
  const uri = PLAYLIST_URI_PREFIX + playlistId
  let header: SpotifyPlaylist | null = null
  const songs: SpotifyTrack[] = []
  const pageSize = 50
  for (let offset = 0; offset < 500; offset += pageSize) {
    const page = await partnerQuery('fetchPlaylist', {
      uri,
      offset,
      limit: pageSize,
      enableWatchFeedEntrypoint: false,
    })
    const v2 = page?.playlistV2
    if (!v2) break
    if (!header) {
      header = normalizePartnerPlaylist(
        { __typename: 'Playlist', ...v2, images: v2.coverArt ? { sources: v2.coverArt.sources } : v2.images },
        uri,
        myAccountId,
      )
      if (!header) return null
    }
    const rows = v2.content?.items
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const track = normalizePartnerTrack(row?.itemV2?.data ?? row?.item?.data)
      if (track) songs.push(track)
    }
    if (rows.length < pageSize) break
  }
  if (!header || songs.length === 0) return null
  return { playlist: header, songs }
}

/** 歌单详情（完整字段版）：给传统模式官方复刻页用——含每行的添加日期/专辑 uri/曲目号/播放次数/uid */
export interface PartnerPlaylistRow {
  track: SpotifyTrack
  addedAt?: string
  albumUri?: string
  trackNumber?: number
  playcount?: number
  uid?: string
}
export interface PartnerPlaylistDetailFull {
  id: string
  ownedByMe: boolean
  name: string
  description: string
  coverUrl: string
  ownerName: string
  ownerAvatar?: string
  ownerId?: string
  trackCount: number
  durationMs: number
  rows: PartnerPlaylistRow[]
}
export async function fetchPartnerPlaylistDetailFull(
  playlistId: string,
  maxRows = 500,
): Promise<PartnerPlaylistDetailFull | null> {
  const myAccountId = await currentPartnerAccountId()
  const uri = PLAYLIST_URI_PREFIX + playlistId
  let header: { name: string; description: string; coverUrl: string; ownerName: string; ownerAvatar?: string; ownerId?: string; trackCount: number; durationMs: number } | null = null
  const rows: PartnerPlaylistRow[] = []
  const pageSize = 50
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const page = await partnerQuery('fetchPlaylist', { uri, offset, limit: pageSize, enableWatchFeedEntrypoint: false })
    const v2 = page?.playlistV2
    if (!v2) break
    if (!header) {
      header = {
        name: String(v2.name ?? ''),
        description: String(v2.description ?? ''),
        coverUrl: firstCover(v2.coverArt),
        ownerName: String(v2.ownerV2?.data?.name ?? v2.ownerV2?.data?.username ?? ''),
        ownerAvatar: firstCover(v2.ownerV2?.data?.avatar),
        ownerId: String(v2.ownerV2?.data?.username ?? ''),
        trackCount: Number(v2.trackCount) || 0,
        durationMs: Number(v2.duration?.totalMilliseconds) || 0,
      }
    }
    const items = v2.content?.items
    if (!Array.isArray(items) || items.length === 0) break
    for (const row of items) {
      const data = row?.itemV2?.data ?? row?.item?.data
      if (!data || data.__typename !== 'Track') continue
      const track = normalizePartnerTrack(data)
      if (!track) continue
      rows.push({
        track,
        addedAt: row?.addedAt?.isoString,
        albumUri: trackIdFromUri(data.albumOfTrack?.uri) || undefined,
        trackNumber: Number(data.trackNumber) || undefined,
        playcount: Number(data.playcount) || undefined,
        uid: String(row?.uid ?? '') || undefined,
      })
      if (rows.length >= maxRows) break
    }
    if (items.length < pageSize) break
  }
  if (!header || rows.length === 0) return null
  return { id: playlistId, ...header, ownedByMe: header.ownerId === myAccountId, rows }
}

/** 歌单曲目（fetchPlaylist，自动翻页；ProfileView 播放入口用，不含歌单头） */
export async function fetchPartnerPlaylistTracks(
  playlistId: string,
  limit = 50,
): Promise<SpotifyTrack[] | null> {
  const detail = await fetchPartnerPlaylistDetail(playlistId)
  return detail ? detail.songs.slice(0, limit) : null
}

/** 喜欢的歌曲（fetchLibraryTracks，自动翻页） */
export async function fetchPartnerLiked(limit = 50): Promise<SpotifyTrack[] | null> {
  const out: SpotifyTrack[] = []
  const pageSize = 50
  for (let offset = 0; offset < limit; offset += pageSize) {
    const page = await partnerQuery('fetchLibraryTracks', {
      offset,
      limit: pageSize,
      features: ['LIKED_SONGS'],
    })
    const items = page?.me?.library?.tracks?.items
    if (!Array.isArray(items) || items.length === 0) break
    for (const entry of items) {
      // UserLibraryTrackResponse：{ track: { _uri, data: {...Track} } } —— 曲目 uri 在外层 _uri，
      // normalizePartnerTrack 读 data.uri，这里注入一次即可
      const wrapper = entry?.track ?? entry
      const track = normalizePartnerTrack({ ...wrapper?.data, uri: wrapper?.data?.uri ?? wrapper?._uri })
      if (track && track.id && track.name) out.push(track)
      if (out.length >= limit) return out
    }
    if (items.length < pageSize) break
  }
  return out.length > 0 ? out : null
}
