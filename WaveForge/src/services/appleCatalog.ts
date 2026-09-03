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
  storefront?: string
  artistId?: string
  albumId?: string
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
  /** 目录专辑曲目数（部分接口返回） */
  trackCount?: number
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
  artistId: item.artistId ? String(item.artistId) : undefined,
  albumId: item.collectionId ? String(item.collectionId) : undefined,
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

export async function searchAppleCatalog(title: string, artist = '', limit = 25, storefront?: string): Promise<AppleCatalogSong[]> {
  if (!title.trim()) return []
  const tracks = await searchAppleTracks(title, artist, undefined, limit, storefront)
  return tracks.map(track => ({
    id: track.songId,
    storefront: track.storefront,
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
  catalogId?: string
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
  artistId?: string
  albumId?: string
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

const toAppleApiPath = (next: unknown): string | null => {
  if (typeof next !== 'string' || !next.trim()) return null
  try {
    const url = new URL(next, AMP_API)
    if (!/(^|\.)music\.apple\.com$/i.test(url.hostname)) return null
    return `${url.pathname}${url.search}`
  } catch {
    return next.startsWith('/') ? next : null
  }
}

async function fetchAppleMePages(path: string, requestedLimit: number): Promise<{ items: any[]; included: any[] }> {
  const target = Math.max(1, requestedLimit)
  const items: any[] = []
  const included: any[] = []
  const seen = new Set<string>()
  let next: string | null = path
  for (let page = 0; next && items.length < target && page < 100; page += 1) {
    const data = await appleMeFetch(next)
    if (!data) break
    for (const item of Array.isArray(data.data) ? data.data : []) {
      const key = `${item?.type || ''}:${item?.id || ''}`
      if (!item?.id || seen.has(key)) continue
      seen.add(key)
      items.push(item)
      if (items.length >= target) break
    }
    if (Array.isArray(data.included)) included.push(...data.included)
    next = toAppleApiPath(data.next)
  }
  return { items, included }
}

const withPageLimit = (path: string, limit: number): string => {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}limit=${Math.min(100, Math.max(1, limit))}`
}

/** 当前登录用户的歌单列表 */
export async function getAppleLibraryPlaylists(limit = 100): Promise<AppleLibraryPlaylist[]> {
  // web 播放器同款（列表层不带 include=tracks；platform=web 为 me 接口的当前门槛参数）
  const { items } = await fetchAppleMePages(
    withPageLimit('/v1/me/library/playlists?platform=web&include=catalog&omit[resource]=autos', limit),
    limit,
  )
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      catalogId: item?.relationships?.catalog?.data?.[0]?.id ? String(item.relationships.catalog.data[0].id) : undefined,
      name: item.attributes.name || '',
      description: item.attributes.description?.standard || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      curatorName: item.attributes.curatorName || undefined,
      trackCount: item.attributes.trackCount ?? item.relationships?.tracks?.data?.length,
    }))
    .filter(playlist => playlist.name)
}

const mapAppleLibraryTrack = (item: any, includedById: Map<string, any>): AppleLibraryTrack => {
  const catalogRef = item?.relationships?.catalog?.data?.[0]
  const catalog = catalogRef?.id ? includedById.get(`${catalogRef.type || 'songs'}:${catalogRef.id}`) : null
  const catalogResource = catalog || catalogRef || {}
  return {
    id: String(item.id),
    catalogId: catalogRef?.id ? String(catalogRef.id) : undefined,
    artistId: catalogResource?.relationships?.artists?.data?.[0]?.id
      ? String(catalogResource.relationships.artists.data[0].id)
      : undefined,
    albumId: catalogResource?.relationships?.albums?.data?.[0]?.id
      ? String(catalogResource.relationships.albums.data[0].id)
      : undefined,
    name: item.attributes.name || catalogResource?.attributes?.name || '',
    artistName: item.attributes.artistName || catalogResource?.attributes?.artistName || '',
    albumName: item.attributes.albumName || catalogResource?.attributes?.albumName || undefined,
    artworkUrl: toHighResArtwork(item.attributes.artwork?.url || catalogResource?.attributes?.artwork?.url || ''),
    durationMs: item.attributes.durationInMillis || catalogResource?.attributes?.durationInMillis,
  }
}

/** 用户歌单的曲目 */
export async function getApplePlaylistTracks(playlistId: string, limit = 300): Promise<AppleLibraryTrack[]> {
  const { items, included } = await fetchAppleMePages(
    withPageLimit(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?platform=web&include=catalog`, limit),
    limit,
  )
  const includedById = new Map(included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item]))
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => mapAppleLibraryTrack(item, includedById))
    .filter(track => track.name)
}

/**
 * 资料库歌单列表接口对部分歌单（喜爱歌曲 / 收藏类）不返回 trackCount：
 * 对缺失数量的歌单并行拉一次曲目列表补全（limit=100 以内曲目数即真实数量）。
 * 并发上限 16 个防刷接口；补齐结果仅在本次返回生效，不落缓存。
 */
export async function enrichApplePlaylistTrackCounts(playlists: AppleLibraryPlaylist[]): Promise<AppleLibraryPlaylist[]> {
  const missing = playlists.filter(playlist => !playlist.trackCount).slice(0, 16)
  if (missing.length === 0) return playlists
  const results = await Promise.allSettled(
    missing.map(playlist => getApplePlaylistTracks(String(playlist.id), 100).then(tracks => tracks.length)),
  )
  const countById = new Map<string, number>()
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value > 0) countById.set(String(missing[index].id), result.value)
  })
  if (countById.size === 0) return playlists
  return playlists.map(playlist => {
    const count = countById.get(String(playlist.id))
    return count !== undefined ? { ...playlist, trackCount: count } : playlist
  })
}

/** 用户资料库音乐视频（「资料库 → 音乐视频」分区） */
export interface AppleLibraryMusicVideo {
  id: string
  catalogId?: string
  name: string
  artistName: string
  artworkUrl?: string
  durationMs?: number
}

export async function getAppleLibraryMusicVideos(limit = 100): Promise<AppleLibraryMusicVideo[]> {
  const { items } = await fetchAppleMePages(
    withPageLimit('/v1/me/library/music-videos?platform=web&include=catalog', limit),
    limit,
  )
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any): AppleLibraryMusicVideo => ({
      id: String(item.id),
      catalogId: item?.relationships?.catalog?.data?.[0]?.id ? String(item.relationships.catalog.data[0].id) : undefined,
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
}

/** 用户资料库全部歌曲（「我的音乐」） */
export async function getAppleLibrarySongs(limit = 200): Promise<AppleLibraryTrack[]> {
  const { items, included } = await fetchAppleMePages(
    withPageLimit('/v1/me/library/songs?platform=web&include=catalog', limit),
    limit,
  )
  const includedById = new Map(included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item]))
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => mapAppleLibraryTrack(item, includedById))
    .filter(track => track.name)
}

/** 资料库专辑（web「资料库」页 albums 分区同款接口） */
export interface AppleLibraryAlbum {
  id: string
  catalogId?: string
  name: string
  artistName: string
  artworkUrl?: string
  releaseDate?: string
  trackCount?: number
}

/** 资料库艺人 */
export interface AppleLibraryArtist {
  id: string
  catalogId?: string
  name: string
  artworkUrl?: string
  genreName?: string
}

async function fetchLibraryCollection(path: string, limit: number): Promise<{ items: any[]; included: any[] }> {
  return fetchAppleMePages(withPageLimit(path, limit), limit)
}

/** 用户资料库全部专辑 */
export async function getAppleLibraryAlbums(limit = 200): Promise<AppleLibraryAlbum[]> {
  const { items, included } = await fetchLibraryCollection('/v1/me/library/albums?platform=web&include=catalog&omit[resource]=autos', limit)
  const includedById = new Map(
    included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item] as const),
  )
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any) => {
      const catalogRef = item.relationships?.catalog?.data?.[0]
      const catalog = catalogRef ? includedById.get(`${catalogRef.type}:${catalogRef.id}`) : null
      const attrs = item.attributes || {}
      const catalogAttrs = catalog?.attributes || catalogRef?.attributes || {}
      return {
        id: String(item.id),
        catalogId: catalogRef?.id ? String(catalogRef.id) : undefined,
        name: attrs.name || catalogAttrs.name || '',
        artistName: attrs.artistName || catalogAttrs.artistName || '',
        artworkUrl: toHighResArtwork(attrs.artwork?.url || catalogAttrs.artwork?.url || ''),
        releaseDate: attrs.releaseDate || catalogAttrs.releaseDate,
        trackCount: attrs.trackCount ?? catalogAttrs.trackCount ?? item.relationships?.tracks?.data?.length,
      }
    })
}

/** 用户资料库全部艺人 */
export async function getAppleLibraryArtists(limit = 200): Promise<AppleLibraryArtist[]> {
  const { items, included } = await fetchLibraryCollection('/v1/me/library/artists?platform=web&include=catalog&omit[resource]=autos', limit)
  const includedById = new Map(
    included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item] as const),
  )
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map((item: any) => {
      const catalogRef = item.relationships?.catalog?.data?.[0]
      const catalog = catalogRef ? includedById.get(`${catalogRef.type}:${catalogRef.id}`) : null
      const attrs = item.attributes || {}
      const catalogAttrs = catalog?.attributes || catalogRef?.attributes || {}
      return {
        id: String(item.id),
        catalogId: catalogRef?.id ? String(catalogRef.id) : undefined,
        name: attrs.name || catalogAttrs.name || '',
        artworkUrl: toHighResArtwork(attrs.artwork?.url || catalogAttrs.artwork?.url || ''),
        genreName: Array.isArray(attrs.genreNames) ? attrs.genreNames[0]
          : Array.isArray(catalogAttrs.genreNames) ? catalogAttrs.genreNames[0] : undefined,
      }
    })
}

/** 单张库专辑曲目（include=catalog 带回目录 id 供播放） */
export async function getAppleLibraryAlbumTracks(albumId: string, limit = 300): Promise<AppleLibraryTrack[]> {
  const { items, included } = await fetchAppleMePages(
    withPageLimit(`/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks?platform=web&include=catalog`, limit),
    limit,
  )
  const includedById = new Map(included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item]))
  return items
    .filter(item => item?.id && item?.attributes?.name)
    .map(item => mapAppleLibraryTrack(item, includedById))
}

/** 某库艺人在资料库内的专辑 */
export async function getAppleLibraryArtistAlbums(artistId: string, limit = 100): Promise<AppleLibraryAlbum[]> {
  const { items } = await fetchLibraryCollection(
    `/v1/me/library/artists/${encodeURIComponent(artistId)}/albums?platform=web&omit[resource]=autos`,
    limit,
  )
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
  /** songs 仅热门歌曲榜携带 id（RSS 目录曲目 id，原生取流必需）；专辑/歌单榜为条目名 */
  songs: Array<{ id?: string; name: string; artist: string; coverUrl?: string }>
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
      // id 必须保留：原生取流（webPlayback salableAdamId）与缓存键都依赖目录曲目 id；
      // 此前丢弃 id 导致队列退化为 apple-0/1/2 排名键，原生取流被静默跳过 → 全部回退 QQ/网易云
      songs: songItems.map((item: any) => ({
        id: String(item?.id ?? '') || undefined,
        name: item.name ?? '',
        artist: item.artistName ?? '',
        coverUrl: toHighResArtwork(item.artworkUrl100 || ''),
      })),
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

async function fetchAppleCatalogPages(path: string, requestedLimit: number): Promise<any[]> {
  const target = Math.max(1, requestedLimit)
  const items: any[] = []
  const seenItems = new Set<string>()
  const seenPages = new Set<string>()
  let next: string | null = path
  for (let page = 0; next && items.length < target && page < 100; page += 1) {
    if (seenPages.has(next)) break
    seenPages.add(next)
    const data = await appleCatalogFetch(next, 10000)
    if (!data) break
    for (const item of Array.isArray(data.data) ? data.data : []) {
      const key = `${item?.type || ''}:${item?.id || ''}`
      if (!item?.id || seenItems.has(key)) continue
      seenItems.add(key)
      items.push(item)
      if (items.length >= target) break
    }
    next = toAppleApiPath(data.next)
  }
  return items
}

/** 编辑精选歌单曲目（amp-api catalog，需 dev token；无 token 返回空） */
export async function getAppleCatalogPlaylistTracks(playlistId: string, country = 'cn', limit = 5000): Promise<AppleCatalogSong[]> {
  const items = await fetchAppleCatalogPages(
    `/v1/catalog/${encodeURIComponent(country)}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${Math.min(100, Math.max(1, limit))}&include=artists,albums`,
    limit,
  )
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      storefront: country,
      artistId: item?.relationships?.artists?.data?.[0]?.id ? String(item.relationships.artists.data[0].id) : undefined,
      albumId: item?.relationships?.albums?.data?.[0]?.id ? String(item.relationships.albums.data[0].id) : undefined,
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
        artistId: item.artistId ? String(item.artistId) : undefined,
        albumId: item.collectionId ? String(item.collectionId) : String(albumId),
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
        artistId: item.artistId ? String(item.artistId) : String(artistId),
        albumId: item.collectionId ? String(item.collectionId) : undefined,
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

// ─────────────────────────── 目录艺人扩展（艺人页 专辑/视频/简介/相关艺人） ───────────────────────────

/** 目录艺人详情（amp-api catalog；含编辑简介/流派/高清封面） */
export interface AppleCatalogArtistDetail {
  id: string
  name: string
  artworkUrl?: string
  genreNames?: string[]
  bio?: string
  url?: string
}

export async function getAppleCatalogArtist(artistId: string, storefront = 'cn'): Promise<AppleCatalogArtistDetail | null> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return null
  const result = await appleApiRequest(
    `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}`
    + '?fields[artists]=name,url,artwork,genreNames,plainEditorialNotes,editorialNotes',
    { developerToken: credentials.developerToken, timeoutMs: 10000 },
  )
  const resource = result.ok && Array.isArray(result.data?.data) ? result.data.data[0] : null
  const attrs = resource?.attributes || {}
  if (!attrs.name) return null
  const bio = typeof attrs.plainEditorialNotes?.standard === 'string'
    ? attrs.plainEditorialNotes.standard
    : typeof attrs.editorialNotes?.standard === 'string' ? attrs.editorialNotes.standard : ''
  return {
    id: String(resource.id),
    name: attrs.name,
    artworkUrl: attrs.artwork?.url ? toHighResArtwork(attrs.artwork.url, 600) : undefined,
    genreNames: Array.isArray(attrs.genreNames) ? attrs.genreNames : undefined,
    bio: bio || undefined,
    url: attrs.url,
  }
}

/** 目录艺人专辑（web 艺人页「专辑/单曲」同款） */
export async function getAppleCatalogArtistAlbums(artistId: string, storefront = 'cn', limit = 200): Promise<AppleCatalogAlbum[]> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return []
  const items = await fetchAppleCatalogPages(
    `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}/albums?limit=${Math.min(200, Math.max(1, limit))}&include=artists`,
    limit,
  )
  return items
    .filter((item: any) => item?.attributes?.name)
    .map((item: any): AppleCatalogAlbum => ({
      id: String(item.id),
      name: item.attributes.name,
      artistName: item.attributes.artistName || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      releaseDate: item.attributes.releaseDate,
      genres: Array.isArray(item.attributes.genreNames) ? item.attributes.genreNames : undefined,
      trackCount: item.attributes.trackCount,
    }))
}

/** 目录艺人音乐视频（web 艺人页「视频」同款） */
export interface AppleCatalogMusicVideo {
  id: string
  name: string
  artistName: string
  artworkUrl?: string
  durationMs?: number
}

export async function getAppleCatalogArtistMusicVideos(artistId: string, storefront = 'cn', limit = 100): Promise<AppleCatalogMusicVideo[]> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return []
  const items = await fetchAppleCatalogPages(
    `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}/music-videos?limit=${Math.min(100, Math.max(1, limit))}&include=artists`,
    limit,
  )
  return items
    .filter((item: any) => item?.attributes?.name)
    .map((item: any): AppleCatalogMusicVideo => ({
      id: String(item.id),
      name: item.attributes.name,
      artistName: item.attributes.artistName || '',
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      durationMs: item.attributes.durationInMillis,
    }))
}

/** 相关艺人（尽力而为：catalog include=related-artists 有数据才返回，否则空数组） */
export async function getAppleCatalogRelatedArtists(artistId: string, storefront = 'cn'): Promise<AppleCatalogArtist[]> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return []
  const result = await appleApiRequest(
    `/v1/catalog/${encodeURIComponent(storefront)}/artists/${encodeURIComponent(artistId)}?include=related-artists&fields[artists]=name,url,artwork`,
    { developerToken: credentials.developerToken, timeoutMs: 10000 },
  )
  if (!result.ok || !Array.isArray(result.data?.data)) return []
  const refs: any[] = result.data.data[0]?.relationships?.['related-artists']?.data || []
  if (refs.length === 0) return []
  const included = Array.isArray(result.data.included) ? result.data.included : []
  const byKey = new Map<string, any>()
  included.forEach((inc: any) => { if (inc?.id) byKey.set(`${inc.type}:${inc.id}`, inc) })
  const artists: AppleCatalogArtist[] = []
  refs.forEach((ref: any) => {
    const res = byKey.get(`${ref.type}:${ref.id}`) || ref
    const attrs = res?.attributes || {}
    if (!attrs.name) return
    artists.push({
      id: String(res.id || ref.id),
      name: attrs.name,
      artworkUrl: attrs.artwork?.url ? toHighResArtwork(attrs.artwork.url, 300) : undefined,
      url: attrs.url,
    })
  })
  return artists
}

// ─────────────────────────── 资料库写操作（需登录：Media-User-Token） ───────────────────────────

type AppleMutationMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface AppleMutationResult {
  ok: boolean
  status: number
  error?: string
}

let lastAppleMutationResult: AppleMutationResult = { ok: true, status: 200 }

export function getLastAppleMutationResult(): AppleMutationResult {
  return lastAppleMutationResult
}

const appleMeMutateResult = async (path: string, method: AppleMutationMethod, body?: unknown): Promise<AppleMutationResult> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    return { ok: false, status: 401, error: 'Apple Music 登录凭据缺失' }
  }
  const result = await appleApiRequest(path, {
    method,
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    body,
    timeoutMs: 10000,
  })
  if (!result.ok) {
    const apiError = result.data?.errors?.[0]
    const error = apiError?.detail || apiError?.title || result.error || `Apple Music 请求失败 (${result.status || '网络错误'})`
    console.warn('[AppleCatalog] 资料库写操作失败:', path, result.status, error)
    return { ok: false, status: result.status, error }
  }
  return { ok: true, status: result.status }
}

const appleMeMutate = async (path: string, method: AppleMutationMethod, body?: unknown): Promise<boolean> => {
  lastAppleMutationResult = await appleMeMutateResult(path, method, body)
  return lastAppleMutationResult.ok
}

/** 创建资料库歌单 */
export async function createApplePlaylist(name: string, description?: string): Promise<boolean> {
  const attributes: Record<string, string> = { name }
  if (description) attributes.description = description
  return appleMeMutate('/v1/me/library/playlists', 'POST', { attributes })
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

/** 向资料库歌单添加曲目；目录歌曲使用 songs，上传曲目使用 library-songs。 */
export async function addAppleTracksToPlaylist(
  playlistId: string,
  tracks: Array<string | ApplePlaylistTrackIdentifier>,
): Promise<boolean> {
  if (!playlistId || tracks.length === 0) return false
  const resolved = await Promise.all(tracks.map(async track => {
    if (typeof track === 'string') {
      const id = track.trim()
      if (!id) return null
      if (!APPLE_LIBRARY_ID_PATTERN.test(id)) return { id, type: 'songs' as const }
      const catalogId = await resolveAppleLibraryCatalogId(id)
      return catalogId
        ? { id: catalogId, type: 'songs' as const }
        : { id, type: 'library-songs' as const }
    }
    const catalogId = String(track.catalogId || '').trim()
    if (catalogId) return { id: catalogId, type: 'songs' as const }
    const libraryId = String(track.libraryId || '').trim()
    if (!libraryId) return null
    const resolvedCatalogId = await resolveAppleLibraryCatalogId(libraryId)
    return resolvedCatalogId
      ? { id: resolvedCatalogId, type: 'songs' as const }
      : { id: libraryId, type: 'library-songs' as const }
  }))
  const data = resolved.filter((item): item is NonNullable<typeof item> => item !== null)
  if (data.length === 0) return false
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, 'POST', { data })
}

export interface ApplePlaylistTrackIdentifier {
  /** 优先使用目录歌曲 id；Apple 的歌单 tracks 删除接口首先接受 songs。 */
  catalogId?: string
  /** 仅无目录关联（如上传曲目）时使用资料库歌曲 id，并发送 library-songs。 */
  libraryId?: string
}

/** 从资料库歌单移除曲目：优先 catalog songs，缺失时才回退 library-songs。 */
export async function removeAppleTracksFromPlaylist(
  playlistId: string,
  tracks: Array<string | ApplePlaylistTrackIdentifier>,
): Promise<boolean> {
  if (!playlistId || tracks.length === 0) return false
  const resolved = await Promise.all(tracks.map(async track => {
    if (typeof track === 'string') {
      const id = track.trim()
      if (!id) return null
      if (!APPLE_LIBRARY_ID_PATTERN.test(id)) return { id, type: 'songs' as const }
      const catalogId = await resolveAppleLibraryCatalogId(id)
      return catalogId
        ? { id: catalogId, type: 'songs' as const }
        : { id, type: 'library-songs' as const }
    }
    const catalogId = String(track.catalogId || '').trim()
    if (catalogId) return { id: catalogId, type: 'songs' as const }
    const libraryId = String(track.libraryId || '').trim()
    if (!libraryId) return null
    const resolvedCatalogId = await resolveAppleLibraryCatalogId(libraryId)
    return resolvedCatalogId
      ? { id: resolvedCatalogId, type: 'songs' as const }
      : { id: libraryId, type: 'library-songs' as const }
  }))
  const data = resolved.filter((item): item is NonNullable<typeof item> => item !== null)
  if (data.length === 0) return false
  return appleMeMutate(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, 'DELETE', { data })
}

/** 加入 Apple Music 资料库（独立于“喜爱”评分）。 */
export async function addAppleSongToLibrary(songId: string): Promise<boolean> {
  if (!songId) return false
  return appleMeMutate('/v1/me/library', 'POST', { data: [{ id: songId, type: 'songs' }] })
}

/** 设置 Apple Music 目录歌曲的“喜爱”状态；网页 favorites 为主，ratings 为兼容回退。 */
export async function setAppleSongLoved(songId: string, loved: boolean): Promise<boolean> {
  if (!songId) return false
  const favoritePath = `/v1/me/favorites?ids[songs]=${encodeURIComponent(songId)}`
  if (await appleMeMutate(favoritePath, loved ? 'POST' : 'DELETE')) return true
  const favoriteFailure = getLastAppleMutationResult()
  if (favoriteFailure.status !== 404 && favoriteFailure.status !== 405) return false
  const ratingPath = `/v1/me/ratings/songs/${encodeURIComponent(songId)}`
  return loved
    ? appleMeMutate(ratingPath, 'PUT', { type: 'ratings', attributes: { value: 1 } })
    : appleMeMutate(ratingPath, 'DELETE')
}

/** 读取 favorites 歌曲集合；null 表示端点不可用，空数组表示成功但没有收藏。 */
export async function getAppleFavoriteSongIds(limit = 5000): Promise<string[] | null> {
  const target = Math.max(1, limit)
  const ids = new Set<string>()
  const seenPages = new Set<string>()
  let next: string | null = `/v1/me/favorites/songs?limit=${Math.min(100, target)}`
  for (let page = 0; next && ids.size < target && page < 100; page += 1) {
    if (seenPages.has(next)) break
    seenPages.add(next)
    const data = await appleMeFetch(next)
    if (!data) return null
    for (const item of Array.isArray(data.data) ? data.data : []) {
      const id = item?.relationships?.resource?.data?.[0]?.id || item?.id
      if (id) ids.add(String(id))
      if (ids.size >= target) break
    }
    next = toAppleApiPath(data.next)
  }
  return [...ids]
}

/** 读取 favorites 对应的完整目录歌曲，保持 favorites 返回顺序。 */
export async function getAppleFavoriteSongs(limit = 5000, storefront = getAppleCredentials().storefront || 'cn'): Promise<AppleCatalogSong[]> {
  const ids = await getAppleFavoriteSongIds(limit)
  if (!ids || ids.length === 0) return []
  const songsById = new Map<string, AppleCatalogSong>()
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    const data = await appleCatalogFetch(
      `/v1/catalog/${encodeURIComponent(storefront)}/songs?ids=${encodeURIComponent(batch.join(','))}&include=artists,albums`,
      10000,
    )
    for (const item of Array.isArray(data?.data) ? data.data : []) {
      if (!item?.id || !item?.attributes) continue
      songsById.set(String(item.id), {
        id: String(item.id),
        storefront,
        artistId: item?.relationships?.artists?.data?.[0]?.id ? String(item.relationships.artists.data[0].id) : undefined,
        albumId: item?.relationships?.albums?.data?.[0]?.id ? String(item.relationships.albums.data[0].id) : undefined,
        name: item.attributes.name || '',
        artistName: item.attributes.artistName || '',
        albumName: item.attributes.albumName || undefined,
        artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
        releaseDate: item.attributes.releaseDate,
        durationMs: item.attributes.durationInMillis,
      })
    }
  }
  return ids.map(id => songsById.get(id)).filter((song): song is AppleCatalogSong => Boolean(song?.name))
}

/** 批量读取 Apple Music favorites；旧服务不支持状态接口时回退 ratings。 */
export async function getAppleLovedSongIds(songIds: string[]): Promise<string[]> {
  const ids = [...new Set(songIds.map(id => String(id).trim()).filter(Boolean))]
  const loved = new Set<string>()
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    const favoriteData = await appleMeFetch(`/v1/me/favorites?ids[songs]=${encodeURIComponent(batch.join(','))}`)
    const favoriteItems = Array.isArray(favoriteData?.data) ? favoriteData.data : null
    if (favoriteItems) {
      for (const item of favoriteItems) {
        const id = item?.relationships?.resource?.data?.[0]?.id || item?.id
        if (id) loved.add(String(id))
      }
      continue
    }
    const ratingData = await appleMeFetch(`/v1/me/ratings/songs?ids=${encodeURIComponent(batch.join(','))}`)
    for (const item of Array.isArray(ratingData?.data) ? ratingData.data : []) {
      if (Number(item?.attributes?.value) === 1 && item?.id) loved.add(String(item.id))
    }
  }
  return [...loved]
}

/** 根据目录歌曲 ID 找到对应的资料库歌曲 ID。 */
export async function resolveAppleCatalogLibraryId(catalogId: string): Promise<string | null> {
  if (!catalogId) return null
  if (APPLE_LIBRARY_ID_PATTERN.test(catalogId)) return catalogId
  const data = await appleMeFetch(`/v1/me/library/songs?filter[catalog-id]=${encodeURIComponent(catalogId)}&include=catalog&limit=1`)
  const item = Array.isArray(data?.data) ? data.data[0] : null
  return item?.id ? String(item.id) : null
}

/** 从资料库移除歌曲；既接受 library ID，也接受 catalog ID。 */
export async function removeAppleSongFromLibrary(songId: string): Promise<boolean> {
  if (!songId) return false
  const libraryId = APPLE_LIBRARY_ID_PATTERN.test(songId)
    ? songId
    : await resolveAppleCatalogLibraryId(songId)
  if (!libraryId) {
    lastAppleMutationResult = { ok: false, status: 404, error: '歌曲不在 Apple Music 资料库中' }
    return false
  }
  return appleMeMutate(`/v1/me/library/songs/${encodeURIComponent(libraryId)}`, 'DELETE')
}

/** 最近播放（需登录） */
export async function getAppleRecentPlayed(limit = 50): Promise<AppleCatalogSong[]> {
  const target = Math.max(1, limit)
  const { items } = await fetchAppleMePages(
    `/v1/me/recent/played/tracks?platform=web&limit=${Math.min(25, target)}`,
    target,
  )
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => ({
      id: String(item.id),
      artistId: item?.relationships?.artists?.data?.[0]?.id ? String(item.relationships.artists.data[0].id) : undefined,
      albumId: item?.relationships?.albums?.data?.[0]?.id ? String(item.relationships.albums.data[0].id) : undefined,
      name: item.attributes.name || '',
      artistName: item.attributes.artistName || '',
      albumName: item.attributes.albumName || undefined,
      artworkUrl: toHighResArtwork(item.attributes.artwork?.url || ''),
      releaseDate: item.attributes.releaseDate,
      durationMs: item.attributes.durationInMillis,
    }))
    .filter(track => track.name)
}

// ─────────────────────────── Apple 曲目 → WaveForge Song（统一播放转换） ───────────────────────────

/** Apple 合成集合 ID（与真实 library-playlists ID 永不冲突）。 */
export const APPLE_LIBRARY_ID = '__apple_library__'
export const APPLE_FAVORITES_ID = '__apple_favorites__'

/** 取歌单第一首曲目的封面（系统封面不可用时，用首曲封面顶替） */
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
export function appleSongToSong(song: AppleCatalogSong, storefront = song.storefront || getAppleCredentials().storefront || 'cn'): Song {
  return {
    id: Number(song.id) || 0,
    appleId: String(song.id || ''),
    appleStorefront: storefront,
    name: song.name || '',
    artists: song.artistName ? [{ name: song.artistName, appleId: song.artistId }] : [],
    album: {
      appleId: song.albumId,
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
    appleLibraryId: String(track.id || ''),
    appleStorefront: getAppleCredentials().storefront,
    name: track.name || '',
    artists: track.artistName ? [{ name: track.artistName, appleId: track.artistId }] : [],
    album: {
      appleId: track.albumId,
      name: track.albumName || '',
      picUrl: track.artworkUrl || '',
    },
    duration: track.durationMs || 0,
    platform: 'apple',
    vip: false,
  }
}

/** 资料库曲目 id 前缀（i./l./p. 等），区别于纯数字目录曲目 id */
export const APPLE_LIBRARY_ID_PATTERN = /^(i|l|p|ra)\./

/**
 * 资料库曲目 id（i.xxx）→ 目录曲目 id（webPlayback 的 salableAdamId 必须是目录 id）。
 * 资料库条目通过 include=catalog 关联目录曲目；用户自传云盘曲目无目录关联 → 返回 null
 * （上层保持库 id，取流会失败并回退载体匹配，这是预期行为）。
 */
export async function resolveAppleLibraryCatalogId(libraryId: string): Promise<string | null> {
  if (!libraryId || !APPLE_LIBRARY_ID_PATTERN.test(libraryId)) return null
  const data = await appleMeFetch(`/v1/me/library/songs/${encodeURIComponent(libraryId)}?include=catalog&platform=web`)
  const item = Array.isArray(data?.data) ? data.data[0] : null
  const catalogId = item?.relationships?.catalog?.data?.[0]?.id
  return catalogId && String(catalogId).trim() ? String(catalogId) : null
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
  const tracks = await searchAppleCatalog(keywords, '', limit, country)
  return tracks.map(track => appleSongToSong(track))
}

// ─────────────────────────── amp-api 目录搜索（web 播放器同款） ───────────────────────────

export interface AppleSearchV1Result {
  songs: AppleCatalogSong[]
  albums: AppleCatalogAlbum[]
  artists: AppleCatalogArtist[]
  playlists: AppleCatalogPlaylist[]
  errorStatus?: number
}

/**
 * amp-api 目录搜索（music.apple.com 搜索框同款接口）：
 * GET /v1/catalog/{storefront}/search?term=...&types=songs,albums,artists,playlists
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
    + `&types=songs,albums,artists,playlists&limit=${Math.min(50, Math.max(1, limit))}&include[songs]=artists&include[albums]=artists&include[playlists]=tracks`
  const result = await appleApiRequest(url, { developerToken: credentials.developerToken, timeoutMs: 15000 })
  if (!result.ok) return { ...empty, errorStatus: result.status || -1 }
  const results = result.data?.results || {}
  const included: any[] = Array.isArray(result.data?.included) ? result.data.included : []
  const relationshipId = (resource: any, relation: string): string | undefined => {
    const ref = resource?.relationships?.[relation]?.data?.[0]
    if (ref?.id) return String(ref.id)
    const linked = included.find(item => item?.type === relation && item?.attributes?.name === resource?.attributes?.[relation === 'albums' ? 'albumName' : 'artistName'])
    return linked?.id ? String(linked.id) : undefined
  }
  const mapSongs = (data?: any[]): AppleCatalogSong[] => Array.isArray(data) ? data.map((song: any) => ({
    id: String(song?.id ?? ''),
    artistId: relationshipId(song, 'artists'),
    albumId: relationshipId(song, 'albums'),
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
  const url = `/v1/catalog/${encodeURIComponent(storefront)}/search/suggestions?term=${encodeURIComponent(keywords.trim())}&types=songs,albums,artists,playlists`
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
