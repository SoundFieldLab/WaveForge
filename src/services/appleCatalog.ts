/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 目录服务（探索页数据源）
 *
 * - 热门歌曲 / 热门专辑：Apple RSS Feed Generator（most-played，按国家/地区）
 * - 专辑曲目：iTunes Lookup API（collectionId + entity=song）
 * - 目录搜索：复用 appleMusic.ts 的 iTunes Search
 * - 跨平台匹配：Apple 曲目 → 网易云/QQ 同款（WaveForge 播放 Apple 曲目的方式）
 */
import { searchSongs, type Song } from './musicApi'
import type { MusicPlatform } from './platforms'
import { searchAppleTracks, toHighResArtwork } from './appleMusic'
import { AMP_API, getAppleCredentials, forwardToBackend } from './appleAuth'
import { appleApiRequest } from './appleApiBridge'

export interface AppleCatalogSong {
  id: string
  name: string
  artistName: string
  albumName?: string
  artworkUrl?: string
  releaseDate?: string
  durationMs?: number
}

export interface AppleCatalogAlbum {
  id: string
  name: string
  artistName: string
  artworkUrl?: string
  releaseDate?: string
  genres?: string[]
}

export const APPLE_EXPLORE_COUNTRIES = [
  { code: 'cn', label: '中国大陆' },
  { code: 'hk', label: '香港' },
  { code: 'tw', label: '台湾' },
  { code: 'us', label: '美国' },
  { code: 'jp', label: '日本' },
  { code: 'kr', label: '韩国' },
  { code: 'gb', label: '英国' },
]

const RSS_BASE = 'https://rss.marketingtools.apple.com/api/v2'
/** WaveForge 本地 API 服务提供的 Apple RSS 代理（见 local-server.mjs /api/apple/rss） */
const RSS_PROXY = 'http://localhost:3001/api/apple/rss'

/**
 * Apple 营销工具 RSS 无 CORS 头，浏览器直连会被拦截。
 * 依次尝试：本地代理（最可靠）→ 公共 CORS 代理 allorigins → 直连（部分 Electron 环境可用）。
 */
const rssGet = async (country: string, path: string): Promise<any[]> => {
  const directUrl = `${RSS_BASE}/${country}/${path}`
  const attempts = [
    { url: `${RSS_PROXY}?country=${encodeURIComponent(country)}&path=${encodeURIComponent(path)}`, label: '本地代理' },
    { url: `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`, label: 'allorigins' },
    { url: directUrl, label: 'direct' },
  ]
  for (const attempt of attempts) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(attempt.url, { signal: controller.signal })
      if (!response.ok) continue
      const data = await response.json()
      const results = data?.feed?.results
      if (Array.isArray(results) && results.length > 0) return results
      // 兼容旧版 RSS 结构：feed.entry（单曲时可能是对象）
      const entry = data?.feed?.entry
      if (entry) return Array.isArray(entry) ? entry : [entry]
    } catch (error) {
      console.warn(`[AppleCatalog] RSS ${path} (${attempt.label}) 失败:`, error)
    } finally {
      window.clearTimeout(timeout)
    }
  }
  return []
}

const normalizeSong = (item: any): AppleCatalogSong => ({
  id: String(item.id ?? item.trackId ?? ''),
  name: item.name ?? item.trackName ?? '',
  artistName: item.artistName ?? '',
  albumName: item.collectionName ?? item.albumName ?? undefined,
  artworkUrl: toHighResArtwork(item.artworkUrl100 ?? ''),
  releaseDate: item.releaseDate,
  durationMs: item.durationMillis ?? item.trackTimeMillis ?? undefined,
})

export async function getAppleHotSongs(country = 'cn', limit = 20): Promise<AppleCatalogSong[]> {
  const items = await rssGet(country, `music/most-played/${Math.min(50, Math.max(1, limit))}/songs.json`)
  return items.map(normalizeSong).filter(song => song.name && song.id)
}

export async function getAppleHotAlbums(country = 'cn', limit = 20): Promise<AppleCatalogAlbum[]> {
  const items = await rssGet(country, `music/most-played/${Math.min(50, Math.max(1, limit))}/albums.json`)
  return items
    .map((item: any): AppleCatalogAlbum => ({
      id: String(item.id ?? ''),
      name: item.name ?? '',
      artistName: item.artistName ?? '',
      artworkUrl: toHighResArtwork(item.artworkUrl100 ?? ''),
      releaseDate: item.releaseDate,
      genres: Array.isArray(item.genres) ? item.genres : undefined,
    }))
    .filter(album => album.name && album.id)
}

export async function getAppleAlbumTracks(albumId: string, country = 'cn'): Promise<AppleCatalogSong[]> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song&country=${encodeURIComponent(country.toUpperCase())}&limit=200`,
      { signal: controller.signal },
    )
    if (!response.ok) return []
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .filter((item: any) => item && item.wrapperType === 'track')
      .map(normalizeSong)
  } catch (error) {
    console.warn('[AppleCatalog] 专辑曲目查询失败:', error)
    return []
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function searchAppleCatalog(title: string, artist = '', limit = 25): Promise<AppleCatalogSong[]> {
  if (!title.trim()) return []
  const tracks = await searchAppleTracks(title, artist, undefined, limit)
  return tracks.map(track => ({
    id: track.songId,
    name: track.trackName,
    artistName: track.artistName,
    albumName: track.albumName,
    artworkUrl: track.artworkUrl,
    durationMs: track.durationMs,
  }))
}

// ─────────────────────────── 跨平台匹配播放 ───────────────────────────

const normalizeMatch = (value: string) =>
  (value || '')
    .toLowerCase()
    .replace(/[\s·•\-–—()（）[\]【】「」『』〈〉《》"'`、，。！？!?,.&/\\|feat.]+/g, '')

/**
 * 在网易云/QQ 中寻找 Apple 曲目的可播放同款（标题+艺人+时长评分）。
 * 返回 WaveForge 可播放的 Song；找不到返回 null。
 */
export async function findPlayableAppleSong(track: {
  name: string
  artistName: string
  durationMs?: number
}): Promise<Song | null> {
  const normalizedTitle = normalizeMatch(track.name)
  const normalizedArtist = normalizeMatch(track.artistName)
  if (!normalizedTitle) return null

  const [neteaseRes, qqRes] = await Promise.allSettled([
    searchSongs(track.name, 15, 'netease'),
    searchSongs(track.name, 15, 'qq'),
  ])

  // 载体平台 VIP 状态：非 VIP 时给 VIP 候选降权，优先选可完整播放的免费版本（避免 30 秒试听）
  const isCarrierVip = (platform: MusicPlatform) => {
    if (platform === 'apple') return false
    return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
  }

  let best: Song | null = null
  let bestScore = 0

  const consider = (song: Song) => {
    const title = normalizeMatch(song.name)
    const artist = normalizeMatch((song.artists || []).map(artist => artist.name).join(' '))
    let score = 0
    if (title === normalizedTitle) score += 100
    else if (title && (title.includes(normalizedTitle) || normalizedTitle.includes(title))) score += 55
    if (normalizedArtist && artist === normalizedArtist) score += 40
    else if (normalizedArtist && artist && (artist.includes(normalizedArtist) || normalizedArtist.includes(artist))) score += 15
    if (track.durationMs && song.duration) {
      const diff = Math.abs(song.duration - track.durationMs)
      if (diff < 2000) score += 15
      else if (diff < 6000) score += 6
    }
    // 非 VIP：VIP 候选 -30 分，让免费同款在分数接近时胜出
    const carrierPlatform = song.platform || 'netease'
    if (song.vip && !isCarrierVip(carrierPlatform)) score -= 30
    if (score > bestScore) {
      bestScore = score
      best = song
    }
  }

  ;[neteaseRes, qqRes].forEach(result => {
    if (result.status !== 'fulfilled') return
    const songs = result.value?.songs
    if (Array.isArray(songs)) songs.forEach(consider)
  })

  if (!best || bestScore < 60) return null
  return best
}

// ─────────────────────────── 用户资料库（需登录） ───────────────────────────

export interface AppleLibraryPlaylist {
  id: string
  name: string
  description?: string
  artworkUrl?: string
  curatorName?: string
  trackCount?: number
}

export interface AppleLibraryTrack {
  id: string
  /** 目录歌曲 id（资料库歌曲经 include=catalog 返回；用于与 UI 中目录 id 对齐） */
  catalogId?: string
  name: string
  artistName: string
  albumName?: string
  artworkUrl?: string
  durationMs?: number
}

/** 带登录凭据的 amp-api「me」请求（需要 Developer Token + Media-User-Token） */
const appleMeFetch = async (path: string): Promise<any | null> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    forwardToBackend(`${path} 未配置凭据（developerToken/mediaUserToken 缺失）`)
    return null
  }
  const result = await appleApiRequest(path, {
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs: 10000,
  })
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      forwardToBackend(`${path} HTTP ${result.status}：资料库无权限（token 失效或账号无 Apple Music 订阅）`)
    } else if (result.status === 0) {
      forwardToBackend(`${path} 网络错误：${result.error || ''}`)
    } else {
      forwardToBackend(`${path} HTTP ${result.status}`)
    }
    return null
  }
  return result.data
}

/** 当前登录用户的歌单列表 */
export async function getAppleLibraryPlaylists(limit = 100): Promise<AppleLibraryPlaylist[]> {
  // web 播放器同款（列表层不带 include=tracks；platform=web 为 me 接口的当前门槛参数）
  const data = await appleMeFetch(`/v1/me/library/playlists?limit=${Math.min(100, Math.max(1, limit))}&platform=web&omit[resource]=autos`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      description: item.attributes.description?.standard || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      curatorName: item.attributes.curatorName || undefined,
      trackCount: item.attributes.trackCount ?? item.relationships?.tracks?.data?.length,
    }))
    .filter(playlist => playlist.name)
}

/** 用户歌单的曲目 */
export async function getApplePlaylistTracks(playlistId: string, limit = 300): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?platform=web&limit=${Math.min(100, Math.max(1, limit))}`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

/** 用户资料库全部歌曲（「我的音乐」） */
export async function getAppleLibrarySongs(limit = 200): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/library/songs?platform=web&limit=${Math.min(100, Math.max(1, limit))}&include=catalog`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      catalogId: item?.relationships?.catalog?.data?.[0]?.id ? String(item.relationships.catalog.data[0].id) : undefined,
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

/** 资料库专辑（web「资料库」页 albums 分区同款接口） */
export interface AppleLibraryAlbum {
  id: string
  name: string
  artistName: string
  artworkUrl?: string
  releaseDate?: string
  trackCount?: number
}

/** 资料库艺人 */
export interface AppleLibraryArtist {
  id: string
  name: string
  artworkUrl?: string
  genreName?: string
}

async function fetchLibraryCollection(path: string): Promise<any[]> {
  const data = await appleMeFetch(path)
  return Array.isArray(data?.data) ? data.data : []
}

/** 用户资料库全部专辑 */
export async function getAppleLibraryAlbums(limit = 200): Promise<AppleLibraryAlbum[]> {
  const items = await fetchLibraryCollection(`/v1/me/library/albums?limit=${Math.min(100, Math.max(1, limit))}&platform=web&omit[resource]=autos`)
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any) => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      releaseDate: item.attributes.releaseDate,
      trackCount: item.attributes.trackCount ?? item.relationships?.tracks?.data?.length,
    }))
}

/** 用户资料库全部艺人 */
export async function getAppleLibraryArtists(limit = 200): Promise<AppleLibraryArtist[]> {
  const items = await fetchLibraryCollection(`/v1/me/library/artists?limit=${Math.min(100, Math.max(1, limit))}&platform=web&omit[resource]=autos`)
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any) => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      genreName: Array.isArray(item.attributes.genreNames) ? item.attributes.genreNames[0] : undefined,
    }))
}

/** 单张库专辑曲目（include=catalog 带回目录 id 供播放） */
export async function getAppleLibraryAlbumTracks(albumId: string, limit = 300): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks?platform=web&limit=${Math.min(100, Math.max(1, limit))}&include=catalog`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any): AppleLibraryTrack => ({
      id: String(item.id),
      catalogId: item?.relationships?.catalog?.data?.[0]?.id ? String(item.relationships.catalog.data[0].id) : undefined,
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
}

/** 某库艺人在资料库内的专辑 */
export async function getAppleLibraryArtistAlbums(artistId: string, limit = 100): Promise<AppleLibraryAlbum[]> {
  const items = await fetchLibraryCollection(`/v1/me/library/artists/${encodeURIComponent(artistId)}/albums?limit=${Math.min(100, Math.max(1, limit))}&platform=web&omit[resource]=autos`)
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any): AppleLibraryAlbum => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      releaseDate: item.attributes.releaseDate,
      trackCount: item.attributes.trackCount ?? item.relationships?.tracks?.data?.length,
    }))
}

// ─────────────────────────── 目录搜索（艺人 / 专辑） ───────────────────────────

export interface AppleCatalogArtist {
  id: string
  name: string
  artworkUrl?: string
  genreName?: string
  url?: string
}

// 内部映射（与 appleMusic.ts 的 STOREFRONT_TO_COUNTRY 保持一致）
const STOREFRONT_COUNTRY_MAP: Record<string, string> = {
  cn: 'CN', us: 'US', hk: 'HK', tw: 'TW', jp: 'JP', kr: 'KR', gb: 'GB',
}

const APPLE_SEARCH_BASE = 'https://itunes.apple.com/search'
const COUNTRY_PARAM = (country: string) => (STOREFRONT_COUNTRY_MAP[country] || country || 'cn').toUpperCase()

/** iTunes 搜索 → 艺人（entity=musicArtist） */
export async function searchAppleCatalogArtists(title: string, country = 'cn', limit = 15): Promise<AppleCatalogArtist[]> {
  const term = (title || '').trim()
  if (!term) return []
  const url = `${APPLE_SEARCH_BASE}?term=${encodeURIComponent(term)}&entity=musicArtist&limit=${Math.min(50, Math.max(1, limit))}&country=${COUNTRY_PARAM(country)}`
  try {
    const response = await fetch(url)
    if (!response.ok) return []
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .filter((item: any) => item && item.wrapperType === 'artist' && item.artistId)
      .map((item: any) => ({
        id: String(item.artistId),
        name: item.artistName || '',
        artworkUrl: toHighResArtwork(item.artistArtworkUrl100 || item.artworkUrl100 || ''),
        genreName: item.primaryGenreName || undefined,
        url: item.artistLinkUrl || undefined,
      }))
      .filter((artist: AppleCatalogArtist) => artist.name)
  } catch (error) {
    console.warn('[AppleCatalog] 艺人搜索失败:', error)
    return []
  }
}

/** iTunes 搜索 → 专辑（entity=album） */
export async function searchAppleCatalogAlbums(title: string, country = 'cn', limit = 15): Promise<AppleCatalogAlbum[]> {
  const term = (title || '').trim()
  if (!term) return []
  const url = `${APPLE_SEARCH_BASE}?term=${encodeURIComponent(term)}&entity=album&limit=${Math.min(50, Math.max(1, limit))}&country=${COUNTRY_PARAM(country)}`
  try {
    const response = await fetch(url)
    if (!response.ok) return []
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .filter((item: any) => item && item.wrapperType === 'collection' && item.collectionId)
      .map((item: any): AppleCatalogAlbum => ({
        id: String(item.collectionId),
        name: item.collectionName || '',
        artistName: item.artistName || '',
        artworkUrl: toHighResArtwork(item.artworkUrl100 || ''),
        releaseDate: item.releaseDate,
        genres: Array.isArray(item.primaryGenreName) ? item.primaryGenreName : item.primaryGenreName ? [item.primaryGenreName] : undefined,
      }))
      .filter((album: AppleCatalogAlbum) => album.name && album.id)
  } catch (error) {
    console.warn('[AppleCatalog] 专辑搜索失败:', error)
    return []
  }
}

// ─────────────────────────── 编辑精选歌单 / 榜单 / 新歌 ───────────────────────────

export interface AppleCatalogPlaylist {
  id: string
  name: string
  description?: string
  artworkUrl?: string
  trackCount?: number
  curatorName?: string
}

/** Apple 编辑精选 / 热门歌单（RSS most-played playlists，免 token） */
export async function getAppleEditorialPlaylists(country = 'cn', limit = 20): Promise<AppleCatalogPlaylist[]> {
  const items = await rssGet(country, `music/most-played/${Math.min(50, Math.max(1, limit))}/playlists.json`)
  return items
    .map((item: any): AppleCatalogPlaylist => ({
      id: String(item.id ?? ''),
      name: item.name ?? '',
      artworkUrl: toHighResArtwork(item.artworkUrl100 ?? ''),
      trackCount: item.trackCount ?? undefined,
      curatorName: item.curatorName ?? item.author?.name ?? undefined,
    }))
    .filter(playlist => playlist.name && playlist.id)
}

/** 最新/热门歌曲（iTunes RSS topsongs，免 token、CORS 全开） */
export async function getAppleNewSongs(country = 'cn', limit = 30): Promise<AppleCatalogSong[]> {
  const cc = COUNTRY_PARAM(country).toLowerCase()
  const url = `https://itunes.apple.com/${cc}/rss/topsongs/limit=${Math.min(100, Math.max(1, limit))}/json`
  try {
    const response = await fetch(url)
    if (!response.ok) return []
    const data = await response.json()
    const entry = data?.feed?.entry
    if (!entry) return []
    const items = Array.isArray(entry) ? entry : [entry]
    return items
      .map((item: any): AppleCatalogSong => {
        const id = item?.id?.attributes?.['im:id'] || item?.id?.label?.match(/\/i=(\d+)/)?.[1] || item?.id?.label?.match(/(\d{6,})$/)?.[1] || ''
        const images = item?.['im:image']
        const lastImage = Array.isArray(images) ? images[images.length - 1]?.label : images?.label
        return {
          id: String(id || ''),
          name: item?.['im:name']?.label ?? '',
          artistName: item?.['im:artist']?.label ?? '',
          albumName: item?.['im:collection']?.['im:name']?.label ?? undefined,
          artworkUrl: toHighResArtwork(lastImage || ''),
          durationMs: undefined,
        }
      })
      .filter(song => song.name && song.id)
  } catch (error) {
    console.warn('[AppleCatalog] iTunes RSS 新歌失败:', error)
    return []
  }
}

export interface AppleChartGroup {
  id: string
  name: string
  group: string
  description?: string
  coverUrl: string
  songs: Array<{ name: string; artist: string; coverUrl?: string }>
}

/** 探索页排行榜数据：热门歌曲 / 热门专辑 / 精选歌单三榜（免 token） */
export async function getAppleChartGroups(country = 'cn'): Promise<AppleChartGroup[]> {
  const [songs, albums, playlists] = await Promise.allSettled([
    rssGet(country, 'music/most-played/25/songs.json'),
    rssGet(country, 'music/most-played/25/albums.json'),
    rssGet(country, 'music/most-played/25/playlists.json'),
  ])
  const groups: AppleChartGroup[] = []
  const songItems = songs.status === 'fulfilled' ? songs.value : []
  const albumItems = albums.status === 'fulfilled' ? albums.value : []
  const playlistItems = playlists.status === 'fulfilled' ? playlists.value : []

  if (songItems.length > 0) {
    groups.push({
      id: `${country}-hot-songs`,
      name: '热门歌曲榜',
      group: 'Apple Music 全球热度',
      description: '各地区最受欢迎的歌曲',
      coverUrl: toHighResArtwork(songItems[0]?.artworkUrl100 || ''),
      songs: songItems.map((item: any) => ({ name: item.name ?? '', artist: item.artistName ?? '', coverUrl: toHighResArtwork(item.artworkUrl100 || '') })),
    })
  }
  if (albumItems.length > 0) {
    groups.push({
      id: `${country}-hot-albums`,
      name: '热门专辑榜',
      group: 'Apple Music 全球热度',
      description: '近期最受欢迎的专辑',
      coverUrl: toHighResArtwork(albumItems[0]?.artworkUrl100 || ''),
      songs: albumItems.map((item: any) => ({ name: item.name ?? '', artist: item.artistName ?? '', coverUrl: toHighResArtwork(item.artworkUrl100 || '') })),
    })
  }
  if (playlistItems.length > 0) {
    groups.push({
      id: `${country}-top-playlists`,
      name: '精选歌单榜',
      group: 'Apple Music 编辑精选',
      description: '编辑与热门策划歌单',
      coverUrl: toHighResArtwork(playlistItems[0]?.artworkUrl100 || ''),
      songs: playlistItems.map((item: any) => ({ name: item.name ?? '', artist: item.curatorName ?? 'Apple Music 编辑', coverUrl: toHighResArtwork(item.artworkUrl100 || '') })),
    })
  }
  return groups
}

// ─────────────────────────── 目录详情（amp-api，需 Developer Token） ───────────────────────────

const appleCatalogFetch = async (path: string, timeoutMs = 8000): Promise<any | null> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return null
  const result = await appleApiRequest(path, {
    developerToken: credentials.developerToken,
    timeoutMs,
  })
  if (!result.ok) {
    if (result.status === 0) console.warn('[AppleCatalog] 目录请求网络错误:', path, result.error)
    return null
  }
  return result.data
}

/** 编辑精选歌单曲目（amp-api catalog，需 dev token；无 token 返回空） */
export async function getAppleCatalogPlaylistTracks(playlistId: string, country = 'cn'): Promise<AppleCatalogSong[]> {
  const data = await appleCatalogFetch(`/v1/catalog/${encodeURIComponent(country)}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

// ─────────────────────────── 专辑 / 艺人详情（iTunes Lookup，免 token） ───────────────────────────

export interface AppleAlbumDetail {
  album: AppleCatalogAlbum
  tracks: AppleCatalogSong[]
}

/** 专辑详情 + 曲目（iTunes Lookup entity=song，一次返回专辑信息与全部曲目） */
export async function getAppleAlbumDetail(albumId: string, country = 'cn'): Promise<AppleAlbumDetail | null> {
  if (!albumId) return null
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(albumId)}&entity=song&country=${COUNTRY_PARAM(country)}&limit=200`
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    const albumItem = results.find((item: any) => item.wrapperType === 'collection')
    const tracks = results
      .filter((item: any) => item.wrapperType === 'track' && item.trackId)
      .map((item: any): AppleCatalogSong => ({
        id: String(item.trackId),
        name: item.trackName || '',
        artistName: item.artistName || '',
        albumName: item.collectionName || undefined,
        artworkUrl: toHighResArtwork(item.artworkUrl100 || ''),
        durationMs: item.trackTimeMillis || undefined,
      }))
    if (!albumItem) return tracks.length > 0 ? { album: { id: albumId, name: tracks[0]?.albumName || '', artistName: tracks[0]?.artistName || '' }, tracks } : null
    return {
      album: {
        id: String(albumItem.collectionId || albumId),
        name: albumItem.collectionName || '',
        artistName: albumItem.artistName || '',
        artworkUrl: toHighResArtwork(albumItem.artworkUrl100 || ''),
        releaseDate: albumItem.releaseDate,
        genres: albumItem.primaryGenreName ? [albumItem.primaryGenreName] : undefined,
      },
      tracks,
    }
  } catch (error) {
    console.warn('[AppleCatalog] 专辑详情失败:', error)
    return null
  }
}

export interface AppleArtistDetail {
  artist: AppleCatalogArtist
  topSongs: AppleCatalogSong[]
}

/** 艺人详情 + 热门歌曲（iTunes Lookup entity=song，返回艺人信息与其歌曲） */
export async function getAppleArtistDetail(artistId: string, country = 'cn'): Promise<AppleArtistDetail | null> {
  if (!artistId) return null
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(artistId)}&entity=song&country=${COUNTRY_PARAM(country)}&limit=50`
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    const artistItem = results.find((item: any) => item.wrapperType === 'artist')
    const topSongs = results
      .filter((item: any) => item.wrapperType === 'track' && item.trackId)
      .map((item: any): AppleCatalogSong => ({
        id: String(item.trackId),
        name: item.trackName || '',
        artistName: item.artistName || '',
        albumName: item.collectionName || undefined,
        artworkUrl: toHighResArtwork(item.artworkUrl100 || ''),
        durationMs: item.trackTimeMillis || undefined,
      }))
    if (!artistItem && topSongs.length === 0) return null
    return {
      artist: {
        id: String(artistItem?.artistId || artistId),
        name: artistItem?.artistName || topSongs[0]?.artistName || '',
        artworkUrl: toHighResArtwork(artistItem?.artistArtworkUrl100 || artistItem?.artworkUrl100 || ''),
        genreName: artistItem?.primaryGenreName || undefined,
      },
      topSongs,
    }
  } catch (error) {
    console.warn('[AppleCatalog] 艺人详情失败:', error)
    return null
  }
}

// ─────────────────────────── 资料库写操作（需登录：Media-User-Token） ───────────────────────────

const appleMeMutate = async (path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown): Promise<boolean> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest(path, {
    method,
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    body,
    timeoutMs: 10000,
  })
  if (!result.ok) {
    console.warn(`[AppleCatalog] 资料库写操作失败:`, path, result.status, result.error || '')
    return false
  }
  return true
}

/** 创建资料库歌单 */
export async function createApplePlaylist(name: string, description?: string): Promise<boolean> {
  const attributes: Record<string, string> = { name }
  if (description) attributes.description = description
  return appleMeMutate('/v1/me/library/playlists', 'POST', { data: [{ attributes }] })
}

/** 删除资料库歌单 */
export async function deleteApplePlaylist(playlistId: string): Promise<boolean> {
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}`, 'DELETE')
}

/** 更新资料库歌单（名称/描述，PATCH /v1/me/library/playlists/{id}） */
export async function updateApplePlaylist(playlistId: string, attributes: { name?: string; description?: string }): Promise<boolean> {
  if (!playlistId) return false
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}`, 'PATCH', { attributes })
}

/** 向资料库歌单添加曲目（songIds 为 Apple 目录歌曲 id） */
export async function addAppleTracksToPlaylist(playlistId: string, songIds: string[]): Promise<boolean> {
  if (!playlistId || songIds.length === 0) return false
  const data = songIds.map(id => ({ id, type: 'songs' as const }))
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, 'POST', { data })
}

/** 从资料库歌单移除曲目 */
export async function removeAppleTracksFromPlaylist(playlistId: string, songIds: string[]): Promise<boolean> {
  if (!playlistId || songIds.length === 0) return false
  const data = songIds.map(id => ({ id, type: 'songs' as const }))
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, 'DELETE', { data })
}

/** 收藏歌曲 = 加入 Apple 音乐资料库（传入 Apple 目录 songId） */
export async function addAppleSongToLibrary(songId: string): Promise<boolean> {
  if (!songId) return false
  return appleMeMutate('/v1/me/library', 'POST', { data: [{ id: songId, type: 'songs' }] })
}

/** 取消收藏 = 从 Apple 音乐资料库移除（传入资料库 songId） */
export async function removeAppleSongFromLibrary(songId: string): Promise<boolean> {
  if (!songId) return false
  return appleMeMutate(`/v1/me/library/songs/${encodeURIComponent(songId)}`, 'DELETE')
}

/** 最近播放（需登录） */
export async function getAppleRecentPlayed(limit = 50): Promise<AppleLibraryTrack[]> {
  const data = await appleMeFetch(`/v1/me/recent/played/tracks?platform=web&limit=${Math.min(25, Math.max(1, limit))}`)
  const items: any[] = Array.isArray(data?.data) ? data.data : []
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

// ─────────────────────────── Apple 曲目 → WaveForge Song（统一播放转换） ───────────────────────────

/** Apple「音乐库 / 喜爱歌曲」伪歌单 id（个人中心与首页歌单共用） */
export const APPLE_LIBRARY_ID = '__apple_library__'

/** 判断是否为 Apple 的「喜爱歌曲（Loved）」自动歌单（按名称识别，中英文） */
export function isAppleLovedPlaylistName(name: string): boolean {
  return /喜爱|喜欢|loved|heart|favourite|favorite/i.test(name || '')
}

/** 取歌单第一首曲目的封面（喜爱歌曲等系统歌单的特殊封面不可用时，用首曲封面顶替） */
export async function getApplePlaylistFirstTrackArtwork(playlistId: string): Promise<string> {
  try {
    const tracks = await getApplePlaylistTracks(playlistId, 1)
    const first = tracks[0]
    return first?.artworkUrl ? toHighResArtwork(first.artworkUrl) : ''
  } catch {
    return ''
  }
}

/** Apple 目录歌曲 → WaveForge Song（platform: 'apple'，播放时统一走匹配载体） */
export function appleSongToSong(song: AppleCatalogSong, storefront = 'cn'): Song {
  return {
    id: Number(song.id) || 0,
    appleId: String(song.id || ''),
    name: song.name || '',
    artists: song.artistName ? [{ name: song.artistName }] : [],
    album: {
      name: song.albumName || '',
      picUrl: song.artworkUrl || '',
    },
    duration: song.durationMs || 0,
    platform: 'apple',
    vip: false,
  }
}

/** 资料库歌曲 → WaveForge Song（platform: 'apple'） */
export function appleLibraryTrackToSong(track: AppleLibraryTrack): Song {
  return {
    id: Number(track.id) || 0,
    // 原生音源（webPlayback）需要目录歌曲 id（salableAdamId）；资料库 id 仅在
    // 无 catalogId（用户自传云曲目）时兜底，此时取流大概率失败 → 回退载体匹配
    appleId: track.catalogId || String(track.id || ''),
    name: track.name || '',
    artists: track.artistName ? [{ name: track.artistName }] : [],
    album: {
      name: track.albumName || '',
      picUrl: track.artworkUrl || '',
    },
    duration: track.durationMs || 0,
    platform: 'apple',
    vip: false,
  }
}

/**
 * 统一播放转换：非网易云/QQ 平台的曲目 → 网易云/QQ 同款可播放歌曲。
 * - apple：始终匹配（Apple 曲目无法直接播放）
 * - spotify：无自源音源，始终匹配
 * - kugou / soda：由调用方决定（原生音源可播时不进来；汽水走逆向 Web API，免费/试听流可播）
 * - 网易云/QQ 曲目原样返回
 * 所有界面（搜索/歌单/探索/个人中心）点播放时都走这里，避免各处重复匹配。
 */
export async function resolvePlayableSong(song: Song): Promise<Song | null> {
  if (!song) return null
  const platform = song.platform || 'netease'
  if (platform === 'netease' || platform === 'qq') return song
  const artistName = (song.artists || []).map(artist => artist.name).filter(Boolean).join(' ')
  return findPlayableAppleSong({
    name: song.name,
    artistName: artistName || song.name,
    durationMs: song.duration || undefined,
  })
}

/** 目录搜索 → Song[]（SearchPanel 的 Apple 搜索用） */
export async function searchAppleSongsAsSongs(keywords: string, country = 'cn', limit = 25): Promise<Song[]> {
  const tracks = await searchAppleCatalog(keywords, '', limit)
  return tracks.map(track => appleSongToSong(track, country))
}

// ─────────────────────────── amp-api 目录搜索（web 播放器同款） ───────────────────────────

export interface AppleSearchV1Result {
  songs: AppleCatalogSong[]
  albums: AppleCatalogAlbum[]
  artists: AppleCatalogArtist[]
  playlists: AppleCatalogPlaylist[]
}

/**
 * amp-api 目录搜索（music.apple.com 搜索框同款接口）：
 * GET /v1/catalog/{storefront}/search?term=...&types=songs,albums,artists,playlists,stations
 * 需 Developer Token；未配置 token 时返回空（调用方回退 iTunes Search）。
 */
export async function searchAppleCatalogV1(
  keywords: string,
  storefront = 'cn',
  limit = 25,
): Promise<AppleSearchV1Result> {
  const empty: AppleSearchV1Result = { songs: [], albums: [], artists: [], playlists: [] }
  if (!keywords.trim()) return empty
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return empty
  const url = `/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(keywords.trim())}`
    + `&types=songs,albums,artists,playlists,stations&limit=${Math.min(50, Math.max(1, limit))}&include[songs]=artists&include[albums]=artists&include[playlists]=tracks`
  const result = await appleApiRequest(url, { developerToken: credentials.developerToken, timeoutMs: 15000 })
  if (!result.ok) return empty
  const results = result.data?.results || {}
  const mapSongs = (data?: any[]): AppleCatalogSong[] => Array.isArray(data) ? data.map((song: any) => ({
    id: String(song?.id ?? ''),
    name: song?.attributes?.name || '',
    artistName: song?.attributes?.artistName || '',
    albumName: song?.attributes?.albumName || undefined,
    artworkUrl: toHighResArtwork(song?.attributes?.artwork?.url || ''),
    durationMs: song?.attributes?.durationInMillis || song?.attributes?.durationMillis || undefined,
  })).filter(song => song.name && song.id) : []
  const mapAlbums = (data?: any[]): AppleCatalogAlbum[] => Array.isArray(data) ? data.map((album: any) => ({
    id: String(album?.id ?? ''),
    name: album?.attributes?.name || '',
    artistName: album?.attributes?.artistName || '',
    artworkUrl: toHighResArtwork(album?.attributes?.artwork?.url || ''),
    releaseDate: album?.attributes?.releaseDate,
    genres: Array.isArray(album?.attributes?.genreNames) ? album.attributes.genreNames : undefined,
  })).filter(album => album.name && album.id) : []
  const mapArtists = (data?: any[]): AppleCatalogArtist[] => Array.isArray(data) ? data.map((artist: any) => ({
    id: String(artist?.id ?? ''),
    name: artist?.attributes?.name || '',
    artworkUrl: toHighResArtwork(
      artist?.attributes?.artwork?.url || artist?.attributes?.url || '',
    ),
    genreName: Array.isArray(artist?.attributes?.genreNames) ? artist.attributes.genreNames[0] : undefined,
  })).filter(artist => artist.name && artist.id) : []
  const mapPlaylists = (data?: any[]): AppleCatalogPlaylist[] => Array.isArray(data) ? data.map((playlist: any) => ({
    id: String(playlist?.id ?? ''),
    name: playlist?.attributes?.name || '',
    description: playlist?.attributes?.description?.short || playlist?.attributes?.description?.standard,
    artworkUrl: toHighResArtwork(playlist?.attributes?.artwork?.url || ''),
    trackCount: playlist?.attributes?.trackCount ?? playlist?.attributes?.playlistTrackCount,
    curatorName: playlist?.attributes?.curatorName || 'Apple Music 编辑',
  })).filter(playlist => playlist.name && playlist.id) : []
  return {
    songs: mapSongs(results?.songs?.data),
    albums: mapAlbums(results?.albums?.data),
    artists: mapArtists(results?.artists?.data),
    playlists: mapPlaylists(results?.playlists?.data),
  }
}

/**
 * amp-api 搜索建议（web 播放器输入联想同款）：
 * GET /v1/catalog/{storefront}/search/suggestions?term=...&types=...
 * 返回建议词列表；未配置 token 时返回空。
 */
export async function getAppleSearchSuggestions(keywords: string, storefront = 'cn'): Promise<string[]> {
  if (!keywords.trim()) return []
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return []
  const url = `/v1/catalog/${encodeURIComponent(storefront)}/search/suggestions?term=${encodeURIComponent(keywords.trim())}&types=songs,albums,artists,playlists,stations`
  const result = await appleApiRequest(url, { developerToken: credentials.developerToken, timeoutMs: 8000 })
  if (!result.ok) return []
  const item: any = Array.isArray(result.data?.data) ? result.data.data[0] : null
  const terms: unknown = item?.attributes?.terms
  if (Array.isArray(terms)) {
    return terms.filter((term): term is string => typeof term === 'string' && term.trim().length > 0) as string[]
  }
  return []
}

/** 目录歌单摘要（打开搜索到的 AM 歌单时展示头部） */
export async function getAppleCatalogPlaylistSummary(
  playlistId: string,
  storefront = 'cn',
): Promise<AppleCatalogPlaylist | null> {
  if (!playlistId) return null
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return null
  const result = await appleApiRequest(`/v1/catalog/${encodeURIComponent(storefront)}/playlists/${encodeURIComponent(playlistId)}`, {
    developerToken: credentials.developerToken,
    timeoutMs: 10000,
  })
  const playlist: any = result?.ok ? result.data?.data?.[0] : null
  if (!playlist?.attributes?.name) return null
  return {
    id: String(playlist.id),
    name: playlist.attributes.name,
    description: playlist.attributes.description?.short || playlist.attributes.description?.standard,
    artworkUrl: toHighResArtwork(playlist.attributes.artwork?.url || ''),
    trackCount: playlist.attributes.trackCount ?? playlist.attributes.playlistTrackCount,
    curatorName: playlist.attributes.curatorName || 'Apple Music 编辑',
  }
}

export { STOREFRONT_COUNTRY_MAP }
