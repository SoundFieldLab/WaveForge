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
import { describeAppleApiFailure } from './appleApiErrors'
import { createTtlCache } from '../utils/ttlCache'

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
  /** 编辑撰写的专辑简介（attributes.editorialNotes.standard，需 extend=editorialNotes）。 */
  description?: string
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
  /** /me/library/playlists 始终属于当前登录用户。 */
  ownedByMe: true
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

/** 最近一次 me 请求的 HTTP 状态（0 = 网络错误）。用于把"端点不存在（404/405）"与
 *  "暂时性失败（网络抖动/超时）"区分开——前者应记住不再重试，后者不该降级。 */
let lastAppleMeFetchStatus = 0

export function getLastAppleMeFetchStatus(): number {
  return lastAppleMeFetchStatus
}

/** 带登录凭据的 amp-api「me」请求（需要 Developer Token + Media-User-Token） */
const appleMeFetch = async (path: string, strict = false): Promise<any | null> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    const message = `${path} 未配置凭据（developerToken/mediaUserToken 缺失）`
    forwardToBackend(message)
    lastAppleMeFetchStatus = 401
    if (strict) throw Object.assign(new Error('Apple Music 登录状态无效，请重新登录'), { status: 401 })
    return null
  }
  const result = await appleApiRequest(path, {
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs: 10000,
  })
  lastAppleMeFetchStatus = result.status
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      forwardToBackend(`${path} HTTP ${result.status}：资料库无权限（token 失效或账号无 Apple Music 订阅）`)
    } else if (result.status === 0) {
      forwardToBackend(`${path} 网络错误：${result.error || ''}`)
    } else {
      forwardToBackend(`${path} HTTP ${result.status}`)
    }
    if (strict) {
      // 统一解读：订阅失效（40015）与登录失效都走这里，给出可操作文案
      const message = describeAppleApiFailure(result.status, result.data)
      throw Object.assign(new Error(message), { status: result.status })
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

/**
 * 资料库整体读取（歌单 / 歌曲 / MV / 专辑 / 艺人，单次数百到 5000 首）会被多个视图重复拉取
 * ——传统模式的侧栏、打开歌单、刷新各拉一次。这里按「strict|limit|path」做 5 秒 TTL 缓存，
 * 兜住同一轮操作里的重复调用；**任何写操作（appleMeMutate）都会立即清空缓存**，
 * 所以不会出现「编辑完还看到旧列表」；TTL 短到即使漏掉某条写入路径，最长也只影响 5 秒。
 */
const APPLE_LIBRARY_CACHE_TTL_MS = 5000
// 只缓存「大 limit」的整库读取（5000 首级别）——那才是唯一值得去重的成本。
// 小/中 limit 的读路径（包括「喜爱歌曲」要做的歌单查找）必须保持实时：
// 它们可能在一次操作里被重复调用而数据已被外部改变，缓存会导致读到过期列表
//（test/appleFavoriteSongsRead 与 appleCatalogMutations 就是这么暴露出来的）。
const APPLE_LIBRARY_CACHE_MIN_LIMIT = 3000
const appleLibraryCache = new Map<string, { at: number; value: { items: any[]; included: any[] } }>()

async function fetchAppleMePages(path: string, requestedLimit: number, strict = false): Promise<{ items: any[]; included: any[] }> {
  if (requestedLimit < APPLE_LIBRARY_CACHE_MIN_LIMIT) return fetchAppleMePagesUncached(path, requestedLimit, strict)
  const cacheKey = `${strict ? '1' : '0'}|${requestedLimit}|${path}`
  const cached = appleLibraryCache.get(cacheKey)
  if (cached && Date.now() - cached.at < APPLE_LIBRARY_CACHE_TTL_MS) return cached.value
  const value = await fetchAppleMePagesUncached(path, requestedLimit, strict)
  appleLibraryCache.set(cacheKey, { at: Date.now(), value })
  return value
}

async function fetchAppleMePagesUncached(path: string, requestedLimit: number, strict = false): Promise<{ items: any[]; included: any[] }> {
  const target = Math.max(1, requestedLimit)
  const items: any[] = []
  const included: any[] = []
  const seen = new Set<string>()
  let next: string | null = path
  for (let page = 0; next && items.length < target && page < 100; page += 1) {
    const data = await appleMeFetch(next, strict)
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
  const { items, included } = await fetchAppleMePages(
    withPageLimit('/v1/me/library/playlists?platform=web&include=catalog&omit[resource]=autos', limit),
    limit,
  )
  const includedById = new Map(included.filter(item => item?.id).map(item => [`${item.type}:${item.id}`, item]))
  return items
    .filter(item => item?.id && item?.attributes)
    .map(item => {
      const catalogRef = item?.relationships?.catalog?.data?.[0]
      const catalog = catalogRef?.id ? includedById.get(`${catalogRef.type || 'playlists'}:${catalogRef.id}`) : null
      const artworkUrl = item.attributes.artwork?.url || catalog?.attributes?.artwork?.url || catalogRef?.attributes?.artwork?.url || ''
      return {
        id: String(item.id),
        catalogId: catalogRef?.id ? String(catalogRef.id) : undefined,
        name: item.attributes.name || catalog?.attributes?.name || catalogRef?.attributes?.name || '',
        description: item.attributes.description?.standard || undefined,
        artworkUrl: toHighResArtwork(artworkUrl),
        curatorName: item.attributes.curatorName || undefined,
        trackCount: item.attributes.trackCount ?? catalog?.attributes?.trackCount ?? item.relationships?.tracks?.data?.length,
        ownedByMe: true as const,
      }
    })
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
export async function getApplePlaylistTracks(playlistId: string, limit = 5000): Promise<AppleLibraryTrack[]> {
  const { items, included } = await fetchAppleMePages(
    withPageLimit(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks?platform=web&include=catalog`, limit),
    limit,
    true,
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
export async function getAppleLibraryAlbumTracks(albumId: string, limit = 5000): Promise<AppleLibraryTrack[]> {
  const { items, included } = await fetchAppleMePages(
    withPageLimit(`/v1/me/library/albums/${encodeURIComponent(albumId)}/tracks?platform=web&include=catalog`, limit),
    limit,
    true,
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

const appleCatalogFetch = async (path: string, timeoutMs = 8000, strict = false): Promise<any | null> => {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) {
    if (strict) throw Object.assign(new Error('Apple Music Developer Token 不可用'), { status: 401 })
    return null
  }
  const result = await appleApiRequest(path, {
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs,
  })
  if (!result) return null
  if (!result.ok) {
    const apiError = result.data?.errors?.[0]
    const detail = apiError?.detail || apiError?.title || result.error || ''
    forwardToBackend(`[AppleCatalog] 目录请求失败: ${path} HTTP ${result.status}${detail ? `：${detail}` : ''}`)
    if (result.status === 0) console.warn('[AppleCatalog] 目录请求网络错误:', path, result.error)
    if (strict) {
      // 统一解读：订阅失效（40015）会说清是订阅问题，不再混进"授权失败/重新登录"
      const message = describeAppleApiFailure(result.status, result.data)
      throw Object.assign(new Error(message), { status: result.status })
    }
    return null
  }
  return result.data
}

async function fetchAppleCatalogPages(path: string, requestedLimit: number, strict = false): Promise<any[]> {
  const target = Math.max(1, requestedLimit)
  const items: any[] = []
  const seenItems = new Set<string>()
  const seenPages = new Set<string>()
  let next: string | null = path
  for (let page = 0; next && items.length < target && page < 100; page += 1) {
    if (seenPages.has(next)) break
    seenPages.add(next)
    const data = await appleCatalogFetch(next, 10000, strict)
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
    `/v1/catalog/${encodeURIComponent(country)}/playlists/${encodeURIComponent(playlistId)}/tracks?limit=${Math.min(100, Math.max(1, limit))}`,
    limit,
    true,
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
  incomplete?: boolean
}

/** 专辑详情 + 曲目（Apple Music Catalog 优先，iTunes Lookup 兜底） */
export async function getAppleAlbumDetail(albumId: string, country = 'cn'): Promise<AppleAlbumDetail | null> {
  if (!albumId) return null

  const catalogData = await appleCatalogFetch(
    // extend=editorialNotes 才会返回专辑简介（实测 attributes.editorialNotes.standard）。
    `/v1/catalog/${encodeURIComponent(country)}/albums/${encodeURIComponent(albumId)}?include=tracks&extend=editorialNotes`,
    10000,
  )
  const catalogAlbum = Array.isArray(catalogData?.data) ? catalogData.data[0] : null
  if (catalogAlbum?.id && catalogAlbum?.attributes) {
    const trackRefs = catalogAlbum.relationships?.tracks?.data
    let tracks = Array.isArray(trackRefs)
      ? trackRefs
        .filter((item: any) => item?.id && item?.attributes)
        .map((item: any): AppleCatalogSong => ({
          id: String(item.id),
          artistId: item.relationships?.artists?.data?.[0]?.id ? String(item.relationships.artists.data[0].id) : undefined,
          albumId: String(catalogAlbum.id),
          name: item.attributes.name || '',
          artistName: item.attributes.artistName || '',
          albumName: item.attributes.albumName || catalogAlbum.attributes.name || undefined,
          artworkUrl: toHighResArtwork(item.attributes.artwork?.url || catalogAlbum.attributes.artwork?.url || ''),
          durationMs: item.attributes.durationInMillis,
        }))
        .filter(track => track.name)
      : []
    if (tracks.length === 0) {
      const trackData = await appleCatalogFetch(
        `/v1/catalog/${encodeURIComponent(country)}/albums/${encodeURIComponent(albumId)}/tracks?limit=100`,
        10000,
      )
      tracks = (Array.isArray(trackData?.data) ? trackData.data : [])
        .filter((item: any) => item?.id && item?.attributes)
        .map((item: any): AppleCatalogSong => ({
          id: String(item.id),
          artistId: item.relationships?.artists?.data?.[0]?.id ? String(item.relationships.artists.data[0].id) : undefined,
          albumId: String(catalogAlbum.id),
          name: item.attributes.name || '',
          artistName: item.attributes.artistName || '',
          albumName: item.attributes.albumName || catalogAlbum.attributes.name || undefined,
          artworkUrl: toHighResArtwork(item.attributes.artwork?.url || catalogAlbum.attributes.artwork?.url || ''),
          durationMs: item.attributes.durationInMillis,
        }))
        .filter((track: AppleCatalogSong) => track.name)
    }
    return {
      album: {
        id: String(catalogAlbum.id),
        name: catalogAlbum.attributes.name || '',
        artistName: catalogAlbum.attributes.artistName || '',
        artworkUrl: toHighResArtwork(catalogAlbum.attributes.artwork?.url || ''),
        releaseDate: catalogAlbum.attributes.releaseDate,
        genres: Array.isArray(catalogAlbum.attributes.genreNames) ? catalogAlbum.attributes.genreNames : undefined,
        trackCount: catalogAlbum.attributes.trackCount,
        description: catalogAlbum.attributes.editorialNotes?.standard
          || catalogAlbum.attributes.editorialNotes?.short
          || catalogAlbum.attributes.description?.standard
          || undefined,
      },
      tracks,
      incomplete: tracks.length === 0 && Number(catalogAlbum.attributes.trackCount) > 0,
    }
  }

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
      incomplete: tracks.length === 0 && Number(albumItem.trackCount) > 0,
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
  // 写操作后立即失效资料库读取缓存：否则刚增删/改名的歌单在 5 秒内仍会显示旧数据
  appleLibraryCache.clear()
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

/**
 * 设置 Apple Music 目录歌曲的「喜爱」状态。
 *
 * 实测（真实登录态）：favorites 是**读写不对称**的端点——
 *   POST   /v1/me/favorites?ids[songs]=X  → 202（生效，ratings 值变 1）
 *   DELETE /v1/me/favorites?ids[songs]=X  → 204（生效，值变 0）
 *   但 GET 同路径 → 404 "Path Not Found"（没有读取端点，读取见 getAppleFavoriteSongIds）。
 * 所以写入仍以 favorites 为主，非 404/405 的失败才回退 ratings PUT/DELETE。
 */
export async function setAppleSongLoved(songId: string, loved: boolean): Promise<boolean> {
  if (!songId) return false
  const favoritePath = `/v1/me/favorites?ids[songs]=${encodeURIComponent(songId)}`
  const favoriteOk = await appleMeMutate(favoritePath, loved ? 'POST' : 'DELETE')
  if (favoriteOk) {
    // 刚变更过「喜爱」→ 立刻失效短 TTL 缓存，避免随后读到旧红心状态。
    clearAppleLovedIdsCache()
    return true
  }
  const favoriteFailure = getLastAppleMutationResult()
  if (favoriteFailure.status !== 404 && favoriteFailure.status !== 405) return false
  const ratingPath = `/v1/me/ratings/songs/${encodeURIComponent(songId)}`
  const ratingOk = loved
    ? await appleMeMutate(ratingPath, 'PUT', { type: 'ratings', attributes: { value: 1 } })
    : await appleMeMutate(ratingPath, 'DELETE')
  if (ratingOk) clearAppleLovedIdsCache()
  return ratingOk
}

/**
 * 「喜爱歌曲」在 Apple 服务端**不是** favorites 端点，而是一个普通资料库歌单。
 *
 * 实测（真实登录态，storefront=cn，/v1/me/* 走主进程 appleApi 代理）：
 *   /v1/me/favorites            → 404 {"title":"Path Not Found","code":"40401"}
 *   /v1/me/favorites/songs      → 404 同上
 *   /v1/me/favorites?ids[songs] → 404 同上
 *   /v1/me/ratings/songs?ids=…  → 200（存在，但只接受显式 ids，不是浏览型接口）
 *   /v1/me/library/playlists    → 200，其中 id=p.xxx 且 name=「喜爱歌曲」
 *   /v1/me/library/playlists/{p.xxx}/tracks → 200 返回曲目
 * 同一时刻同一凭据下只有 favorites 系列是 404，故与账号/订阅/地区无关——该路径不存在。
 * 官网侧栏的「喜爱歌曲」也正是这个资料库歌单。
 *
 * 因此这里改为：在资料库歌单里按名称找「喜爱歌曲」，再走既有的资料库歌单曲目接口读取。
 * 找不到时返回 null（表示不可用），与旧签名一致，调用方无需改动。
 */
const APPLE_FAVORITES_PLAYLIST_NAMES = ['喜爱歌曲', 'Loved Songs', 'Love', 'Favorites', '喜欢的歌曲']

async function findAppleFavoritesPlaylistId(): Promise<string | null> {
  try {
    const playlists = await getAppleLibraryPlaylists(200)
    // 优先精确名匹配（本地化名或英文名）
    for (const name of APPLE_FAVORITES_PLAYLIST_NAMES) {
      const hit = playlists.find(playlist => playlist.name === name)
      if (hit) return String(hit.id)
    }
    // 兜底：名称里含「喜爱 / Loved / Favorite」的收藏类歌单
    const loose = playlists.find(playlist => /喜爱|loved|favorite/i.test(playlist.name || ''))
    return loose ? String(loose.id) : null
  } catch {
    return null
  }
}

/** 读取「喜爱歌曲」的目录曲目 id；null 表示不可用，空数组表示成功但没有收藏。 */
export async function getAppleFavoriteSongIds(limit = 5000): Promise<string[] | null> {
  const target = Math.max(1, limit)
  const playlistId = await findAppleFavoritesPlaylistId()
  if (!playlistId) return null
  const tracks = await getApplePlaylistTracks(playlistId, target)
  if (tracks.length === 0) return []
  const ids = tracks
    .map(track => String(track.catalogId || '').trim())
    .filter(id => /^\d+$/.test(id))
  return [...new Set(ids)]
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

/** 批量读取 Apple Music「喜爱」状态（ratings value===1）。
 *  说明：favorites 系列路径（/v1/me/favorites[/songs]）实测恒为 404 "Path Not Found"，
 *  与账号/地区/订阅无关，故不再尝试；ratings 是唯一可用来源。
 *  ratings 也不可用时记为不可用，避免每次页面加载重复请求（会刷屏并拖慢封面）。 */
let favoritesEndpointsUnavailable = false

/**
 * 「喜爱」状态短 TTL 缓存：探索页每次 pages 变化、播放页切歌、右键菜单都会带一批 id 来问一次，
 * 而切页签/开合面板时 id 批次常常不变——不缓存就会反复问同一批。
 * 键 = storefront + id 批次指纹（id 排序后哈希），保持调用方无感。
 * 任何 Apple 收藏变更（本机 like/unlike、资料库增删）或登录态变化都会立刻清空，
 * 避免把刚点亮的红心读成旧状态。
 */
const APPLE_LOVED_IDS_CACHE_TTL_MS = 5 * 60 * 1000
const appleLovedIdsCache = createTtlCache<string[]>({ ttlMs: APPLE_LOVED_IDS_CACHE_TTL_MS, maxEntries: 64 })

const fingerprintIds = (ids: string[]): string => {
  let hash = 2166136261
  const joined = [...ids].sort().join(',')
  for (let index = 0; index < joined.length; index += 1) {
    hash ^= joined.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const clearAppleLovedIdsCache = (): void => { appleLovedIdsCache.clear() }
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', clearAppleLovedIdsCache)
  // 收藏/资料库变更（含「喜爱歌曲」歌单被改写）→ 立刻失效，避免读到旧红心状态。
  window.addEventListener('playlist-content-changed', (event: Event) => {
    const detail = (event as CustomEvent<{ platform?: string }>).detail
    if (!detail || detail.platform === 'apple') clearAppleLovedIdsCache()
  })
}

export async function getAppleLovedSongIds(songIds: string[]): Promise<string[]> {
  const ids = [...new Set(songIds.map(id => String(id).trim()).filter(Boolean))]
  if (ids.length === 0 || favoritesEndpointsUnavailable) return []
  const cacheKey = `${getAppleCredentials().storefront || 'cn'}:${fingerprintIds(ids)}`
  const cached = appleLovedIdsCache.get(cacheKey)
  if (cached) return cached
  const loved = new Set<string>()
  for (let index = 0; index < ids.length; index += 100) {
    const batch = ids.slice(index, index + 100)
    // 直接用 ratings：favorites 系列路径实测恒为 404（"Path Not Found"，同一凭据下
    // ratings/records 均为 200），没有任何账号能走通，先试一次只是每批白跑一个失败请求
    // 并往日志刷 404。ratings/songs 的 value===1 即「喜爱」。
    const ratingData = await appleMeFetch(`/v1/me/ratings/songs?ids=${encodeURIComponent(batch.join(','))}`)
    const ratingItems = Array.isArray(ratingData?.data) ? ratingData.data : null
    if (!ratingItems) {
      // 连 ratings 都不可用 → 本次会话不再重试（也不缓存：失败绝不落缓存）。
      favoritesEndpointsUnavailable = true
      return [...loved]
    }
    for (const item of ratingItems) {
      if (Number(item?.attributes?.value) === 1 && item?.id) loved.add(String(item.id))
    }
  }
  const result = [...loved]
  // 请求成功即缓存（空数组也是有效答案：「这批里没有喜爱的」），失败路径已提前返回。
  appleLovedIdsCache.set(cacheKey, result)
  return result
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
 * 官网搜索页的分区模型（music.apple.com/cn/search 实测顺序）：
 * 最佳结果 → 艺人 → 专辑 → 歌曲 → 播放列表。
 *
 * 官网每区是**独立 shelf**（横向滚动、每区自己的「更多」），最佳结果是 3 列横卡网格。
 * 这里保留原始资源形态（不塌缩成 Song/Album），因为各区的卡片样式差异很大：
 * 艺人要圆卡、专辑/歌单要方卡、歌曲要行卡、最佳结果要「60×60 封面 + 播放按钮」横卡。
 */
export interface AppleSearchSectionItem {
  id: string
  type: 'songs' | 'albums' | 'artists' | 'playlists' | 'music-videos' | 'stations'
  name: string
  /** 副标题：歌曲/专辑=艺人名，歌单=策展人，艺人=「艺人」 */
  subtitle?: string
  artworkUrl?: string
  /** 悬停播放用的目录 id（艺人没有） */
  playId?: string
  /** 歌曲时长（毫秒） */
  durationMs?: number
  trackCount?: number
  /** 该条目是否已在资料库里（relate=library 回填） */
  inLibrary?: boolean
  /** 是否露骨内容 */
  contentRating?: string
  /** 站内跳转链接（艺人/专辑/歌单） */
  url?: string
}

export interface AppleSearchSection {
  /** 稳定 id（供 React key 与测试） */
  id: 'top' | 'artists' | 'albums' | 'songs' | 'playlists' | 'music-videos'
  title: string
  items: AppleSearchSectionItem[]
}

export interface AppleSearchPageResult {
  sections: AppleSearchSection[]
  errorStatus?: number
}

const SEARCH_SECTION_TITLES: Record<AppleSearchSection['id'], string> = {
  top: '最佳结果',
  artists: '艺人',
  albums: '专辑',
  songs: '歌曲',
  playlists: '播放列表',
  'music-videos': '音乐视频',
}

const SEARCH_TYPE_TO_SECTION: Record<string, AppleSearchSection['id']> = {
  artists: 'artists',
  albums: 'albums',
  songs: 'songs',
  playlists: 'playlists',
  'music-videos': 'music-videos',
}

/**
 * 官网搜索页数据（含分区）。
 *
 * 与 searchAppleCatalogV1 的区别：
 * - 带 `format[resources]=map`：响应里 `results[type].data` 只是 `{id,type}` 引用，
 *   完整 attributes 在 `resources[type][id]`。不合并就拿不到 name/artwork
 *   （searchAppleCatalogV1 直接读 `results[x].data[].attributes`，故那边只能拿到空字段）。
 * - **每个类型单独请求，而不是一次带多个 types**：实测（collage，cn 商店）在同一个请求里
 *   混多个 types 会静默丢类型——`types=songs,albums,artists,playlists,music-videos` 只回
 *   songs/albums/artists（playlists / music-videos 直接消失），而单类型请求能完整返回
 *   artists 21 / albums 21 / songs 21 / playlists 14 / music-videos 8，与官网逐区计数一致。
 *   因此这里并行发 5 个单类型请求再合并。
 * - 按官网顺序产出分区，并额外做「最佳结果」：官网最佳结果是**跨类型的混排**
 *   （歌曲 + 专辑 + 艺人），取各区前几条交错，而不是单独一次请求。
 */
export async function searchAppleCatalogSections(
  keywords: string,
  storefront = 'cn',
  limit = 21,
): Promise<AppleSearchPageResult> {
  const term = keywords.trim()
  if (!term) return { sections: [] }
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return { sections: [], errorStatus: -1 }
  const bounded = Math.min(50, Math.max(1, limit))
  const searchOne = async (type: string): Promise<{ type: string; items: AppleSearchSectionItem[] }> => {
    const url = `/v1/catalog/${encodeURIComponent(storefront)}/search?term=${encodeURIComponent(term)}`
      + `&types=${type}`
      + `&limit=${bounded}`
      + '&l=zh-Hans-CN&platform=web'
      + '&format[resources]=map'
      + (type === 'songs' ? '&include[songs]=artists' : '')
      + (type === 'albums' ? '&include[albums]=artists' : '')
      + (type === 'music-videos' ? '&include[music-videos]=artists' : '')
    const result = await appleApiRequest(url, { developerToken: credentials.developerToken, timeoutMs: 15000 })
    if (!result.ok) return { type, items: [] }
    // 引用 → 完整资源合并（attributes 在 resources 里，必须先合并）
    const resources: Record<string, Record<string, any>> = {}
    for (const [bucketType, bucket] of Object.entries(result.data?.resources || {})) {
      if (bucket && typeof bucket === 'object' && !Array.isArray(bucket)) {
        resources[bucketType] = bucket as Record<string, any>
      }
    }
    const refs: any[] = result.data?.results?.[type]?.data || []
    const items: AppleSearchSectionItem[] = []
    for (const ref of refs) {
      const full = resources[String(ref?.type || type)]?.[String(ref?.id || '')]
      if (!full?.attributes) continue
      const attributes = { ...full.attributes, ...(ref.attributes || {}) }
      const section = SEARCH_TYPE_TO_SECTION[type]
      if (!section) continue
      const name = String(attributes.name || '').trim()
      if (!name) continue
      const id = String(full.id || ref.id || '')
      items.push({
        id,
        type: section === 'music-videos' ? 'music-videos' : (type as AppleSearchSectionItem['type']),
        name,
        subtitle: type === 'artists'
          ? '艺人'
          : String(attributes.artistName || attributes.curatorName || attributes.albumName || '').trim() || undefined,
        artworkUrl: attributes.artwork?.url ? toHighResArtwork(attributes.artwork.url) : undefined,
        // 艺人不可「播放」，其余都能用目录 id 直接播
        playId: type === 'artists' ? undefined : id,
        durationMs: attributes.durationInMillis || undefined,
        trackCount: attributes.trackCount ?? attributes.playlistTrackCount ?? undefined,
        contentRating: attributes.contentRating,
        // 音乐视频时长在 attributes 里也是 durationInMillis，封面用 artwork
        url: attributes.url,
      })
    }
    return { type, items }
  }

  const settled = await Promise.all(
    (['artists', 'albums', 'songs', 'playlists', 'music-videos'] as const).map(type => searchOne(type)),
  )
  const bySection = new Map<AppleSearchSection['id'], AppleSearchSectionItem[]>()
  for (const { type, items } of settled) {
    const section = SEARCH_TYPE_TO_SECTION[type]
    if (section && items.length > 0) bySection.set(section, items)
  }

  // 最佳结果：官网是跨类型混排（歌曲/专辑/艺人交错），取各区前几条并按官网观感排序。
  const topItems: AppleSearchSectionItem[] = []
  const songsTop = bySection.get('songs') || []
  const albumsTop = bySection.get('albums') || []
  const artistsTop = bySection.get('artists') || []
  // 官网实测最佳结果顺序：歌曲、专辑、艺人、专辑…（前 6 条最常见是 3 歌 + 2 专辑 + 1 艺人）
  const mixed = [...songsTop.slice(0, 2), ...albumsTop.slice(0, 2), ...artistsTop.slice(0, 1), ...songsTop.slice(2, 4)]
  for (const item of mixed) {
    if (topItems.length >= 6) break
    if (!topItems.some(existing => existing.id === item.id && existing.type === item.type)) topItems.push(item)
  }

  const order: Array<AppleSearchSection['id']> = ['top', 'artists', 'albums', 'songs', 'playlists', 'music-videos']
  const sections: AppleSearchSection[] = []
  for (const id of order) {
    const items = id === 'top' ? topItems : (bySection.get(id) || [])
    if (items.length === 0) continue
    sections.push({ id, title: SEARCH_SECTION_TITLES[id], items })
  }
  return { sections }
}

/**
 * 「在资料库中搜索」（官网搜索页右上角第二档范围）。
 *
 * 实测 `/v1/me/library/search` 虽返回 200，但 `results` 恒为空对象——
 * 官网自己的资料库范围在无命中时也显示「没有搜索结果」（已在调试浏览器中确认），
 * 所以这里改为**拉取资料库再本地过滤**：这样用户搜自己收藏的内容能真正命中，
 * 与官网「搜资料库」的语义一致且更有用。
 */
export async function searchAppleLibrarySections(
  keywords: string,
  limit = 40,
): Promise<AppleSearchPageResult> {
  const term = keywords.trim().toLocaleLowerCase()
  if (!term) return { sections: [] }
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return { sections: [], errorStatus: -1 }
  const match = (value?: string) => Boolean(value && value.toLocaleLowerCase().includes(term))
  const [songs, albums, artists, playlists] = await Promise.all([
    getAppleLibrarySongs(400).catch(() => []),
    getAppleLibraryAlbums(300).catch(() => []),
    getAppleLibraryArtists(300).catch(() => []),
    getAppleLibraryPlaylists(200).catch(() => []),
  ])

  const sections: AppleSearchSection[] = []
  const artistItems: AppleSearchSectionItem[] = artists
    .filter(entry => match(entry.name))
    .slice(0, limit)
    .map(entry => ({
      id: entry.catalogId || entry.id,
      type: 'artists' as const,
      name: entry.name,
      subtitle: '艺人',
      artworkUrl: entry.artworkUrl,
    }))
  const albumItems: AppleSearchSectionItem[] = albums
    .filter(entry => match(entry.name) || match(entry.artistName))
    .slice(0, limit)
    .map(entry => ({
      id: entry.catalogId || entry.id,
      type: 'albums' as const,
      name: entry.name,
      subtitle: entry.artistName,
      artworkUrl: entry.artworkUrl,
      playId: entry.catalogId || entry.id,
      trackCount: entry.trackCount,
    }))
  const songItems: AppleSearchSectionItem[] = songs
    .filter(entry => match(entry.name) || match(entry.artistName) || match(entry.albumName))
    .slice(0, limit)
    .map(entry => ({
      id: entry.catalogId || entry.id,
      type: 'songs' as const,
      name: entry.name,
      subtitle: entry.artistName,
      artworkUrl: entry.artworkUrl,
      playId: entry.catalogId || entry.id,
      durationMs: entry.durationMs,
    }))
  const playlistItems: AppleSearchSectionItem[] = playlists
    .filter(entry => match(entry.name) || match(entry.curatorName))
    .slice(0, limit)
    .map(entry => ({
      id: entry.catalogId || entry.id,
      type: 'playlists' as const,
      name: entry.name,
      subtitle: entry.curatorName,
      artworkUrl: entry.artworkUrl,
      playId: entry.catalogId || entry.id,
      trackCount: entry.trackCount,
    }))

  // 最佳结果：资料库范围同样取跨类型混排（与目录范围保持一致的观感）
  const topItems: AppleSearchSectionItem[] = []
  for (const item of [...songItems.slice(0, 3), ...albumItems.slice(0, 2), ...artistItems.slice(0, 1)]) {
    if (topItems.length >= 6) break
    if (!topItems.some(existing => existing.id === item.id && existing.type === item.type)) topItems.push(item)
  }
  if (topItems.length > 0) sections.push({ id: 'top', title: SEARCH_SECTION_TITLES.top, items: topItems })
  if (artistItems.length > 0) sections.push({ id: 'artists', title: SEARCH_SECTION_TITLES.artists, items: artistItems })
  if (albumItems.length > 0) sections.push({ id: 'albums', title: SEARCH_SECTION_TITLES.albums, items: albumItems })
  if (songItems.length > 0) sections.push({ id: 'songs', title: SEARCH_SECTION_TITLES.songs, items: songItems })
  if (playlistItems.length > 0) sections.push({ id: 'playlists', title: SEARCH_SECTION_TITLES.playlists, items: playlistItems })
  return { sections }
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
 * amp-api 搜索联想（music.apple.com 搜索框同款）。
 *
 * 请求形状来自官网实测抓包（amp-api-edge /v1/catalog/{sf}/search/suggestions）：
 * `kinds=terms,topResults` + `limit[results:terms]` / `limit[results:topResults]`。
 * **`kinds` 是必填**：缺了会直接 400（"One or more kinds must be specified"），
 * 此前只发 types=… 导致联想接口恒失败、联想词永远为空。
 *
 * 响应是 `results.suggestions[]`，每项按 kind 分两类：
 * - `terms`：纯搜索词（attributes.terms 是另一种旧形态，官网当前不用）
 * - `topResults`：可直接点开的歌曲/专辑等（content.attributes 带封面与艺人）
 */
export interface AppleSearchSuggestionItem {
  kind: 'terms' | 'topResults'
  /** terms：建议词；topResults：该资源的显示名 */
  term: string
  /** topResults：资源类型与 id（点击可直接打开/播放） */
  type?: string
  id?: string
  /** topResults：副标题（官网显示「歌曲 · 孙燕姿」） */
  subtitle?: string
  artworkUrl?: string
}

export async function getAppleSearchSuggestionItems(
  keywords: string,
  storefront = 'cn',
): Promise<AppleSearchSuggestionItem[]> {
  const term = keywords.trim()
  if (!term) return []
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return []
  const url = `/v1/catalog/${encodeURIComponent(storefront)}/search/suggestions`
    + `?term=${encodeURIComponent(term)}`
    + '&kinds=terms,topResults'
    + '&types=songs,albums,artists,playlists'
    + '&limit%5Bresults%3Aterms%5D=5&limit%5Bresults%3AtopResults%5D=10'
    + '&platform=web&l=zh-Hans-CN'
  const result = await appleApiRequest(url, { developerToken: credentials.developerToken, timeoutMs: 8000 })
  if (!result.ok) return []
  const raw = result.data?.results?.suggestions
  if (!Array.isArray(raw)) return []
  const items: AppleSearchSuggestionItem[] = []
  for (const entry of raw) {
    const kind = String(entry?.kind || '')
    if (kind === 'terms') {
      const text = String(entry?.displayTerm || entry?.searchTerm || '').trim()
      if (text) items.push({ kind: 'terms', term: text })
      continue
    }
    if (kind !== 'topResults') continue
    const content = entry?.content
    const attributes = content?.attributes || {}
    const name = String(attributes.name || '').trim()
    if (!name || !content?.id) continue
    const type = String(content.type || '')
    // 官网副标题形如「歌曲 · 孙燕姿」；专辑用 artistName，歌单/电台用 curatorName。
    const owner = String(attributes.artistName || attributes.curatorName || attributes.albumArtistName || '').trim()
    items.push({
      kind: 'topResults',
      term: name,
      type,
      id: String(content.id),
      subtitle: owner || undefined,
      artworkUrl: attributes.artwork?.url ? toHighResArtwork(attributes.artwork.url) : undefined,
    })
  }
  return items
}

/** 兼容旧调用：只取建议词。 */
export async function getAppleSearchSuggestions(keywords: string, storefront = 'cn'): Promise<string[]> {
  const items = await getAppleSearchSuggestionItems(keywords, storefront)
  return items.filter(item => item.kind === 'terms').map(item => item.term)
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
