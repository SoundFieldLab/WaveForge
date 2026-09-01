/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 探索数据服务（客户端组装，与 /explore/netease、/explore/qq 服务端聚合返回同构的 ExplorePayload）
 *
 * 数据源：
 * - 每日热选 dailySongs：Apple 营销 RSS most-played（需本地代理，免 token）
 * - 新歌 newSongs：iTunes RSS topsongs（免 token、CORS 全开）
 * - 推荐歌单 playlists：RSS most-played playlists（Apple 编辑/热门歌单）
 * - 排行榜 charts：热门歌曲/热门专辑/精选歌单三榜
 * - 新碟 albums：RSS most-played albums
 * - channels：Apple 无公开频道接口 → 空（UI 按能力表隐藏）
 */
import type {
  ExploreAlbum,
  ExploreChart,
  ExplorePayload,
  ExplorePlaylist,
} from './exploreApi'
import {
  appleSongToSong,
  getAppleChartGroups,
  getAppleEditorialPlaylists,
  getAppleHotAlbums,
  getAppleHotSongs,
  getAppleNewSongs,
  type AppleCatalogPlaylist,
} from './appleCatalog'
import { toHighResArtwork } from './appleMusic'
import { appleApiRequest } from './appleApiBridge'
import { getAppleAuthState, getAppleCredentials } from './appleAuth'
import type { Song } from './musicApi'

const APPLE_PLAYLIST_SOURCE = 'apple-editorial'
const APPLE_PERSONALIZED_SOURCE = 'apple-personalized'

// ─────────────────────────── 已登录个性化数据（amp-api，需 Media-User-Token） ───────────────────────────

/** 常见曲风名 → 优先展示的曲风榜单（cn 商店真实曲风名 + 英文兜底，按商店 genres 匹配） */
const CURATED_GENRES = [
  'C-Pop', '华语流行', '国语流行',
  'K-Pop', '韩国流行',
  '国际流行', 'Pop',
  '嘻哈/说唱', 'Hip-Hop/Rap',
  '电子音乐', 'Electronic',
  '古典', 'Classical',
  '爵士乐', 'Jazz',
  '摇滚', 'Rock',
  'R&B/灵魂乐', 'R&B/Soul',
  '原声音乐', 'Soundtrack', '影视原声',
  '乡村', 'Country',
  '另类音乐', 'Alternative',
  '舞曲', 'Dance',
]

const artworkUrl = (artwork?: { url?: string }): string => toHighResArtwork(artwork?.url || '')

/** 曲风榜单：取 genres 树 → 匹配曲风名 → 逐个拉 charts（songs/albums） */
async function fetchGenreCharts(storefront: string, developerToken: string): Promise<ExploreChart[]> {
  const genresResult = await appleApiRequest(`/v1/catalog/${encodeURIComponent(storefront)}/genres?limit=100`, {
    developerToken,
    timeoutMs: 10000,
  })
  if (!genresResult.ok) return []
  const genreList: any[] = Array.isArray(genresResult.data?.data) ? genresResult.data.data : []
  const nameToId = new Map<string, string>()
  genreList.forEach((genre: any) => {
    const name = genre?.attributes?.name
    if (name && genre?.id) nameToId.set(name, String(genre.id))
  })
  const picked = CURATED_GENRES
    .map(name => ({ name, id: nameToId.get(name) }))
    .filter((item): item is { name: string; id: string } => Boolean(item.id))
    .slice(0, 6)

  const charts: ExploreChart[] = []
  const settled = await Promise.allSettled(picked.map(async ({ name, id }) => {
    const chartResult = await appleApiRequest(
      `/v1/catalog/${encodeURIComponent(storefront)}/charts?types=songs,albums&genre=${encodeURIComponent(id)}&limit=10`,
      { developerToken, timeoutMs: 10000 }
    )
    if (!chartResult.ok) return null
    const songs = chartResult.data?.results?.songs?.[0]?.data
    if (!Array.isArray(songs) || songs.length === 0) return null
    const first = songs[0]
    return {
      id: `apple-genre-${id}`,
      name: `${name}热歌`,
      group: 'Apple Music 曲风榜',
      description: `根据 ${name} 曲风的流行趋势`,
      coverUrl: artworkUrl(first?.attributes?.artwork),
      platform: 'apple' as const,
      source: 'apple-genre',
      songs: songs.map((song: any, index: number) => ({
        id: Number(song.id) || index,
        appleId: String(song.id || '') || undefined,
        name: song?.attributes?.name || '',
        artist: song?.attributes?.artistName || '',
        coverUrl: artworkUrl(song?.attributes?.artwork),
        rank: index + 1,
      })),
    }
  }))
  settled.forEach(result => {
    if (result.status === 'fulfilled' && result.value) charts.push(result.value)
  })
  return charts
}

/** 专属推荐：/v1/me/recommendations（歌单 + 专辑，带"因为你在听…"等理由） */
async function fetchPersonalizedRecommendations(
  developerToken: string,
  mediaUserToken: string,
): Promise<{ playlists: ExplorePlaylist[]; albums: ExploreAlbum[] }> {
  const result = await appleApiRequest('/v1/me/recommendations?limit=15', {
    developerToken,
    mediaUserToken,
    timeoutMs: 12000,
  })
  const playlists: ExplorePlaylist[] = []
  const albums: ExploreAlbum[] = []
  if (!result.ok) return { playlists, albums }
  const items: any[] = Array.isArray(result.data?.data) ? result.data.data : []
  items.forEach((rec: any) => {
    const reason = rec?.attributes?.reason || ''
    const resources = rec?.relationships?.resources?.data
    if (!Array.isArray(resources)) return
    resources.forEach((resource: any) => {
      const attributes = resource?.attributes || {}
      const name = attributes.name || ''
      if (!name || !resource?.id) return
      if (resource.type === 'playlists') {
        playlists.push({
          id: String(resource.id),
          name,
          description: reason || attributes.description?.short || attributes.description?.standard,
          coverUrl: artworkUrl(attributes.artwork),
          creator: attributes.curatorName || 'Apple Music 为你推荐',
          platform: 'apple',
          source: APPLE_PERSONALIZED_SOURCE,
        })
      } else if (resource.type === 'albums') {
        albums.push({
          id: Number(resource.id) || 0,
          name,
          artist: attributes.artistName || '',
          coverUrl: artworkUrl(attributes.artwork),
          publishTime: attributes.releaseDate ? Date.parse(attributes.releaseDate) || attributes.releaseDate : undefined,
          platform: 'apple',
        })
      }
    })
  })
  return { playlists, albums }
}

/** 常听：/v1/me/history/heavy-rotation（常听的专辑/歌单） */
async function fetchHeavyRotation(
  developerToken: string,
  mediaUserToken: string,
): Promise<ExploreAlbum[]> {
  const result = await appleApiRequest('/v1/me/history/heavy-rotation?limit=10', {
    developerToken,
    mediaUserToken,
    timeoutMs: 12000,
  })
  if (!result.ok) return []
  const items: any[] = Array.isArray(result.data?.data) ? result.data.data : []
  return items
    .filter((item: any) => item?.type === 'albums' && item?.attributes?.name)
    .map((item: any): ExploreAlbum => ({
      id: Number(item.id) || 0,
      name: item.attributes.name || '',
      artist: item.attributes.artistName || '',
      coverUrl: artworkUrl(item.attributes.artwork),
      publishTime: item.attributes.releaseDate ? Date.parse(item.attributes.releaseDate) || item.attributes.releaseDate : undefined,
      platform: 'apple',
    }))
}

// ─────────────────────────── 主入口 ───────────────────────────

const toExplorePlaylist = (playlist: AppleCatalogPlaylist): ExplorePlaylist => ({
  id: playlist.id,
  name: playlist.name,
  description: playlist.description,
  coverUrl: playlist.artworkUrl || '',
  trackCount: playlist.trackCount,
  creator: playlist.curatorName || 'Apple Music 编辑',
  platform: 'apple',
  source: APPLE_PLAYLIST_SOURCE,
})

const toExploreAlbum = (album: {
  id: string
  name: string
  artistName: string
  artworkUrl?: string
  releaseDate?: string
}): ExploreAlbum => ({
  id: Number(album.id) || 0,
  name: album.name,
  artist: album.artistName,
  coverUrl: album.artworkUrl || '',
  publishTime: album.releaseDate ? Date.parse(album.releaseDate) || album.releaseDate : undefined,
  platform: 'apple',
})

/** 探索页 Apple 数据主入口（country 为 storefront 代码：cn/us/hk/tw…） */
export async function fetchAppleExplorePayload(country = 'cn'): Promise<ExplorePayload> {
  const [hotSongs, hotAlbums, playlists, newSongs, chartGroups, loggedInExtras] = await Promise.allSettled([
    getAppleHotSongs(country, 30),
    getAppleHotAlbums(country, 24),
    getAppleEditorialPlaylists(country, 20),
    getAppleNewSongs(country, 30),
    getAppleChartGroups(country),
    // 已登录：专属推荐 / 常听 / 曲风榜单（amp-api，失败不影响基础内容）
    (async () => {
      const state = getAppleAuthState()
      if (!state.loggedIn) return null
      const credentials = getAppleCredentials()
      const [recommendationsRes, heavyRes, genreRes] = await Promise.allSettled([
        fetchPersonalizedRecommendations(credentials.developerToken, credentials.mediaUserToken),
        fetchHeavyRotation(credentials.developerToken, credentials.mediaUserToken),
        fetchGenreCharts(country, credentials.developerToken),
      ])
      return {
        playlists: recommendationsRes.status === 'fulfilled' ? recommendationsRes.value.playlists : [],
        albums: recommendationsRes.status === 'fulfilled' ? recommendationsRes.value.albums : [],
        heavyAlbums: heavyRes.status === 'fulfilled' ? heavyRes.value : [],
        genreCharts: genreRes.status === 'fulfilled' ? genreRes.value : [],
      }
    })(),
  ])

  const dailySongs: Song[] = hotSongs.status === 'fulfilled'
    ? hotSongs.value.map(song => appleSongToSong(song, country))
    : []
  const albums: ExploreAlbum[] = [
    ...(loggedInExtras.status === 'fulfilled' && loggedInExtras.value ? [...loggedInExtras.value.albums, ...loggedInExtras.value.heavyAlbums] : []),
    ...(hotAlbums.status === 'fulfilled' ? hotAlbums.value.map(toExploreAlbum) : []),
  ]
  const playlistItems: ExplorePlaylist[] = [
    ...(loggedInExtras.status === 'fulfilled' && loggedInExtras.value ? loggedInExtras.value.playlists : []),
    ...(playlists.status === 'fulfilled' ? playlists.value.map(toExplorePlaylist) : []),
  ]
  const newSongItems: Song[] = newSongs.status === 'fulfilled'
    ? newSongs.value.map(song => appleSongToSong(song, country))
    : []
  const charts: ExploreChart[] = [
    ...(loggedInExtras.status === 'fulfilled' && loggedInExtras.value ? loggedInExtras.value.genreCharts : []),
    ...(chartGroups.status === 'fulfilled'
      ? chartGroups.value.map((group, index) => ({
          id: group.id,
          name: group.name,
          group: group.group,
          description: group.description,
          coverUrl: group.coverUrl,
          platform: 'apple' as const,
          source: 'apple-rss',
          songs: group.songs
            .map((song, rank) => ({
              id: rank,
              appleId: song.id || undefined,
              name: song.name,
              artist: song.artist,
              coverUrl: song.coverUrl ? toHighResArtwork(song.coverUrl) : undefined,
              rank: rank + 1,
            })),
        }))
      : []),
  ]

  const loggedIn = loggedInExtras.status === 'fulfilled' && loggedInExtras.value !== null
  return {
    code: 0,
    platform: 'apple',
    officialEnhanced: false,
    personalized: loggedIn,
    dailySongs,
    radioSongs: [],
    newSongs: newSongItems,
    playlists: playlistItems,
    charts,
    albums,
    channels: [],
    meta: {
      source: loggedIn ? 'apple-api-personalized' : 'apple-rss',
      updatedAt: Date.now(),
    },
  }
}
