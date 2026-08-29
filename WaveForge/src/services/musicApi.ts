import type { MusicPlatform } from './platforms'
const API_BASE = 'http://localhost:3001/api'

import { parseTTML } from '../utils/ttmlParser'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  getAudioQualityRequest,
} from './audioQualitySettings'
import { getAppleMusicLyrics, isAppleMusicConfigured } from './appleMusic'

const isYrcTimestampFragment = (value: string) => {
  const trimmed = value.trim()
  return trimmed.length > 0
    && /^[\d(),\s]+$/u.test(trimmed)
    && /\d/u.test(trimmed)
    && /,/u.test(trimmed)
}

const getPlatformCookie = (platform: MusicPlatform, explicitCookie?: string) => explicitCookie || (
  platform === 'qq'
    ? localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
    : localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
)

const SONG_URL_CACHE_TTL = 5 * 60 * 1000
const SONG_URL_NEGATIVE_CACHE_TTL = 25 * 1000
const SONG_URL_FETCH_TIMEOUT = 26 * 1000
const SONG_URL_CACHE_MAX_ENTRIES = 256
const songUrlCache = new Map<string, { url: string | null; expiresAt: number }>()
const songUrlPending = new Map<string, Promise<string | null>>()
const songUrlInvalidationVersions = new Map<string, number>()
let songUrlCacheGeneration = 0

export const clearSongUrlCache = () => {
  songUrlCacheGeneration += 1
  songUrlCache.clear()
  songUrlPending.clear()
  songUrlInvalidationVersions.clear()
}

// 模块加载时不再注册监听器（HMR/多实例会重复注册并累积）；
// 改为惰性注册：首次调用 getSongUrl 时注册一次，事件触发时清缓存。
let songUrlListenersRegistered = false
const ensureSongUrlListenersRegistered = () => {
  if (songUrlListenersRegistered) return
  songUrlListenersRegistered = true
  if (typeof window !== 'undefined') {
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, clearSongUrlCache)
    window.addEventListener('waveforge-auth-changed', clearSongUrlCache)
  }
}

const fingerprint = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

const cacheSongUrl = (key: string, url: string | null) => {
  const now = Date.now()
  for (const [cachedKey, entry] of songUrlCache) {
    if (entry.expiresAt <= now) songUrlCache.delete(cachedKey)
  }
  songUrlCache.delete(key)
  songUrlCache.set(key, {
    url,
    expiresAt: now + (url ? SONG_URL_CACHE_TTL : SONG_URL_NEGATIVE_CACHE_TTL),
  })
  while (songUrlCache.size > SONG_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = songUrlCache.keys().next().value
    if (oldestKey === undefined) break
    songUrlCache.delete(oldestKey)
  }
}

const fetchSongUrlResponse = async (url: string): Promise<Response> => {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), SONG_URL_FETCH_TIMEOUT)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

const buildSongUrlCacheKey = (id: number | string, platform: MusicPlatform) => {
  const cookie = platform === 'qq'
    ? (localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || '')
    : (localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')
  const crossPlatformFallback = platform === 'netease'
    ? (localStorage.getItem('crossPlatformFallbackEnabled') ?? 'false')
    : 'not-applicable'
  const { preference, isVip } = getAudioQualityRequest(platform)
  return `${platform}:${id}:${preference}:${isVip ? 'vip' : 'free'}:${fingerprint(cookie)}:${crossPlatformFallback}`
}

export const invalidateSongUrl = (id: number | string, platform: MusicPlatform = 'netease') => {
  const cacheKey = buildSongUrlCacheKey(id, platform)
  songUrlCache.delete(cacheKey)
  songUrlPending.delete(cacheKey)
  const nextVersion = (songUrlInvalidationVersions.get(cacheKey) || 0) + 1
  songUrlInvalidationVersions.delete(cacheKey)
  songUrlInvalidationVersions.set(cacheKey, nextVersion)
  while (songUrlInvalidationVersions.size > SONG_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = songUrlInvalidationVersions.keys().next().value
    if (oldestKey === undefined) break
    songUrlInvalidationVersions.delete(oldestKey)
  }
}

export interface Song {
  id: number
  mid?: string // QQ音乐需要mid
  songType?: number // QQ MusicU 写操作必须使用歌曲真实类型，不能固定为 0
  name: string
  artists: { id?: number; name: string; mid?: string }[]
  album: {
    id?: number // 网易云专辑ID，用于懒加载封面
    name: string
    picUrl: string
    mid?: string
    pmid?: string | number
  }
  duration: number
  playCount?: number // 播放次数（听歌排行等）
  platform?: MusicPlatform // 标识来源平台
  /** Apple Music 目录/资料库 ID 原文（数字转 String(id) 后可能丢失精度，保留原串） */
  appleId?: string
  vip?: boolean // 是否为VIP歌曲
  noCopyright?: boolean // 是否无版权
  commentCount?: number
  fee?: number // 付费类型（网易云）0免费 1VIP 4付费专辑 8低音质免费
  /** 融合搜索中，同一首歌可用的所有平台版本（第一项为当前优选版本） */
  fusedSources?: Array<{
    platform: MusicPlatform
    id: number
    mid?: string
    vip?: boolean
    noCopyright?: boolean
  }>
}


export function getLocalAlbumIdentifier(song: Song, platform: MusicPlatform): string | null {
  const raw = song as any
  const album = raw.album || raw.al || {}
  // 汽水：无专辑 ID 体系，约定用「专辑名」作标识（艺人/专辑弹窗按名查询）
  if (platform === 'soda') return album.name ? String(album.name) : null
  const id = platform === 'qq'
    ? (album.mid || raw.albummid || album.pmid || album.id || raw.albumid)
    : (album.id || raw.albumid || raw.al?.id)
  return id ? String(id) : null
}

export async function resolveSongAlbumIdentifier(song: Song, platform: MusicPlatform): Promise<string | null> {
  // Apple 歌曲的 album 无网易云/QQ 专辑 id，不向平台接口查询
  if (platform === 'apple') return null
  // 汽水：直接返回专辑名标识，不向网易云/QQ 查询详情
  if (platform === 'soda') return getLocalAlbumIdentifier(song, 'soda')
  const localId = getLocalAlbumIdentifier(song, platform)
  if (localId) return localId

  try {
    if (platform === 'qq') {
      const songKey = song.mid || String(song.id)
      const response = await fetch(`${API_BASE}/qq/song/detail?mid=${encodeURIComponent(songKey)}`)
      const data = await response.json()
      const detailSong = data.song || data
      return getLocalAlbumIdentifier(detailSong, 'qq')
    }

    const response = await fetch(`${API_BASE}/netease/song/detail?ids=${encodeURIComponent(String(song.id))}`)
    const data = await response.json()
    const detailSong = data.songs?.[0]
    if (!detailSong) return null
    return detailSong.al?.id ? String(detailSong.al.id) : getLocalAlbumIdentifier(detailSong, 'netease')
  } catch (error) {
    console.error('解析专辑ID失败:', error)
    return null
  }
}

export interface Artist {
  id: number
  mid?: string // QQ音乐需要mid
  name: string
  picUrl: string
  albumSize?: number // 专辑数量
  musicSize?: number // 歌曲数量
  description?: string // 艺人介绍
  platform?: MusicPlatform
  alias?: string[] // 别称
  intro?: any[] // 详细介绍（章节）
  country?: string // 国籍
  occupation?: string // 职业
  briefDesc?: string // 简介
  fans?: number // 粉丝数
  basic?: any // QQ音乐基本信息
  other?: any // QQ音乐其他信息
  /** 融合搜索去重后命中的平台 */
  sourcePlatforms?: Array<MusicPlatform>
}

export interface Album {
  id: number
  mid?: string // QQ音乐需要mid
  name: string
  picUrl: string
  artist: { name: string; id?: number; mid?: string }
  publishTime?: number
  size?: number // 歌曲数量
  description?: string // 专辑描述
  platform?: MusicPlatform
  genre?: string // 流派/类型
  lan?: string // 语言
  company?: string // 唱片公司
  /** 融合搜索去重后命中的平台 */
  sourcePlatforms?: Array<MusicPlatform>
}

export interface SearchSuggestion {
  keyword: string
  type: 'song' | 'artist' | 'album' // 搜索类型
}

export interface SearchResult {
  songs: Song[]
  songCount: number
  artists?: Artist[] // 歌手搜索结果
  albums?: Album[] // 专辑搜索结果
}

export interface LyricLine {
  time: number
  text: string
  words?: LyricWord[] // 逐字歌词
  translation?: string // 翻译
  roman?: string // 罗马音（纯文本）
  romanWords?: LyricWord[] // 逐字罗马音
  /** Apple Music 对唱/多声部：ttm:agent id（如 v1/v2） */
  agent?: string
  /** 该行演唱者名（由 Apple 曲目艺人列表按 agent 顺序映射） */
  agentName?: string
}

export interface LyricWord {
  word: string
  startTime: number // 相对于歌词行开始的时间（毫秒）
  duration: number // 持续时间（毫秒）
}

// 添加尺寸参数（网易云 CDN 支持）
function addCoverSizeParam(url: string, size: number = 500): string {
  if (!url || !/^https?:\/\//i.test(url)) return url
  const param = `param=${size}y${size}`
  if (/[?&]param=\d+y\d+/i.test(url)) {
    return url.replace(/([?&])param=\d+y\d+/i, `$1${param}`)
  }
  return url + (url.indexOf('?') >= 0 ? '&' : '?') + param
}

// 图片代理（解决防盗链和CORS）
export function getProxiedImageUrl(originalUrl: string, size: number = 500): string {
  if (!originalUrl || !/^https?:\/\//i.test(originalUrl)) return ''

  // CachedImage and API mappers may both normalize the same cover. Keep the
  // operation idempotent so /api/cover never becomes nested inside itself.
  try {
    const input = new URL(originalUrl)
    const proxy = new URL(`${API_BASE}/cover`)
    if (input.origin === proxy.origin && input.pathname === proxy.pathname) {
      return originalUrl
    }
  } catch {
    return originalUrl
  }
  
  // QQ音乐和网易云都需要代理
  const urlWithSize = addCoverSizeParam(originalUrl, size)
  
  // 检查开发者模式
  const devMode = localStorage.getItem('developerMode') === 'true'
  
  return `${API_BASE}/cover?url=${encodeURIComponent(urlWithSize)}&devMode=${devMode}`
}

// 搜索歌曲（支持平台选择）
export async function searchSongs(keywords: string, limit = 30, platform: MusicPlatform = 'netease'): Promise<SearchResult> {
  try {
    const devMode = localStorage.getItem('developerMode') === 'true'
    // 酷狗：前端直连搜索接口（kugouService）
    if (platform === 'kugou') {
      const { searchKugouSongs, kugouTrackToSong } = await import('./kugouService')
      const tracks = await searchKugouSongs(keywords, limit)
      return { songs: tracks.map(kugouTrackToSong), songCount: tracks.length }
    }
    // Spotify：前端直连官方 API
    if (platform === 'spotify') {
      const { searchSpotifySongs, spotifyTrackToSong } = await import('./spotifyService')
      const tracks = await searchSpotifySongs(keywords, limit)
      return { songs: tracks.map(spotifyTrackToSong), songCount: tracks.length }
    }
    // 汽水音乐：走逆向 Web API 搜索（后端 /api/soda/search，签名在服务端完成）
    if (platform === 'soda') {
      const { searchSodaSongs } = await import('./sodaService')
      const songs = await searchSodaSongs(keywords, limit)
      return { songs, songCount: songs.length }
    }
    const endpoint = platform === 'qq' ? '/qq/search' : '/netease/search'
    const response = await fetch(`${API_BASE}${endpoint}?keywords=${encodeURIComponent(keywords)}&limit=${limit}&devMode=${devMode}`)
    const data = await response.json()
    
    if (platform === 'qq') {
      // QQ音乐返回格式
      const songs = (data.songs || []).map((song: any) => {
        return {
          id: song.id || 0,
          mid: song.mid || '', // QQ音乐需要mid
          name: song.name || '',
          artists: song.artists || [],
          album: {
            name: song.album?.name || song.album || '',
            picUrl: song.album?.picUrl || song.cover || ''
          },
          duration: song.duration || 0,
          platform: 'qq',
          vip: song.vip || false, // VIP标识
          noCopyright: song.noCopyright || false // 无版权标识
        }
      })
      
      return {
        songs,
        songCount: songs.length
      }
    } else {
      // 网易云音乐返回格式
      const songs = (data.result?.songs || []).map((song: any) => ({
        id: song.id,
        name: song.name,
        artists: song.artists || [],
        album: {
          id: song.album?.id, // 保存专辑ID用于懒加载
          name: song.album?.name || '',
          picUrl: song.album?.picUrl || 
                  song.album?.artist?.img1v1Url || 
                  song.album?.blurPicUrl ||
                  song.artists?.[0]?.img1v1Url ||
                  ''
        },
        duration: song.duration || 0,
        platform: 'netease',
        vip: song.vip || false, // VIP标识
        noCopyright: song.noCopyright || false, // 无版权标识
        fee: song.fee // 付费类型
      }))
      
      return {
        songs,
        songCount: data.result?.songCount || 0
      }
    }
  } catch (error) {
    console.error('搜索失败:', error)
    throw error
  }
}

// 搜索建议
export async function searchSuggest(keywords: string, platform: MusicPlatform = 'netease'): Promise<SearchSuggestion[]> {
  try {
    // 汽水：逆向接口无搜索建议端点，返回空（避免误用网易云建议造成串台）
    if (platform === 'soda') return []
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/suggest?keywords=${encodeURIComponent(keywords)}`)
      const data = await response.json()
      const suggestions: SearchSuggestion[] = []
      
      // QQ音乐的suggest接口通常返回一个suggestions数组，每个元素包含keyword和type
      if (data.suggestions && Array.isArray(data.suggestions)) {
        data.suggestions.forEach((item: any) => {
          if (item.keyword || item.value) {
            suggestions.push({ 
              keyword: item.keyword || item.value, 
              type: 'song' // 默认单曲，如果有type字段可以映射
            })
          }
        })
      }
      return suggestions
    }
    
    // 网易云音乐
    const response = await fetch(`${API_BASE}/netease/search/suggest?keywords=${encodeURIComponent(keywords)}`)
    const data = await response.json()
    const suggestions: SearchSuggestion[] = []
    
    // 网易云通常返回 result.allMatch 或直接 suggestions
    const result = data.result || data
    
    // 尝试从不同字段提取建议
    if (result.allMatch && Array.isArray(result.allMatch)) {
      result.allMatch.forEach((item: any) => {
        if (item.keyword) {
          const type = item.type === 100 ? 'artist' : item.type === 10 ? 'album' : 'song'
          suggestions.push({ keyword: item.keyword, type })
        }
      })
    } else if (result.order && result.order.length > 0) {
      // 按照order的顺序提取
      result.order.forEach((key: string) => {
        if (result[key] && Array.isArray(result[key])) {
          const type = key === 'artists' ? 'artist' : key === 'albums' ? 'album' : 'song'
          result[key].slice(0, 3).forEach((item: any) => {
            suggestions.push({ 
              keyword: item.name || item.keyword, 
              type 
            })
          })
        }
      })
    } else if (data.suggestions && Array.isArray(data.suggestions)) {
      // 简单的suggestions数组
      data.suggestions.forEach((item: any) => {
        suggestions.push({ 
          keyword: typeof item === 'string' ? item : (item.keyword || item.name || item.value), 
          type: 'song' 
        })
      })
    }
    return suggestions
  } catch (error) {
    console.error('❌ [API] 搜索建议失败:', error)
    return []
  }
}

// 搜索歌手
export async function searchArtists(keywords: string, platform: MusicPlatform = 'netease'): Promise<Artist[]> {
  try {
    // Spotify：官方 API 艺人搜索
    if (platform === 'spotify') {
      const { searchSpotifyArtists } = await import('./spotifyService')
      const artists = await searchSpotifyArtists(keywords, 20)
      return artists.map(a => ({
        id: Number(parseInt(a.id.slice(0, 12), 36)) || 0,
        mid: a.id,
        name: a.name,
        picUrl: a.coverUrl || '',
        platform: 'spotify' as const,
      }))
    }
    // 酷狗/汽水：暂不支持独立艺人搜索
    if (platform === 'kugou' || platform === 'soda') return []
    const devMode = localStorage.getItem('developerMode') === 'true'
    if (platform === 'qq') {
      const url = `${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&type=singer&devMode=${devMode}`
      const response = await fetch(url)
      const data = await response.json()
      console.log(`📊 [搜索歌手-QQ] 返回数据keys:`, Object.keys(data))
      console.log(`📊 [搜索歌手-QQ] singers字段:`, data.singers ? `存在(${data.singers.length}个)` : '不存在')
      
      if (data.singers && data.singers.length > 0) {
        console.log(`📊 [搜索歌手-QQ] 前3个歌手:`, data.singers.slice(0, 3).map((s: any) => ({
          id: s.singer_id,
          mid: s.singer_mid,
          name: s.singer_name
        })))
      }
      
      const artists = (data.singers || []).map((item: any) => ({
        id: item.singer_id,
        mid: item.singer_mid,
        name: item.singer_name,
        picUrl: item.singer_pic ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${item.singer_mid}.jpg` : '',
        albumSize: item.albumNum,
        musicSize: item.songNum,
        platform: 'qq' as const
      }))
      return artists
    }
    
    const url = `${API_BASE}/netease/search?keywords=${encodeURIComponent(keywords)}&type=100&devMode=${devMode}`
    const response = await fetch(url)
    const data = await response.json()
    console.log(`📊 [搜索歌手-网易云] 返回数据keys:`, Object.keys(data))
    console.log(`📊 [搜索歌手-网易云] result.artists字段:`, data.result?.artists ? `存在(${data.result.artists.length}个)` : '不存在')
    
    if (data.result?.artists && data.result.artists.length > 0) {
      console.log(`📊 [搜索歌手-网易云] 前3个歌手:`, data.result.artists.slice(0, 3).map((s: any) => ({
        id: s.id,
        name: s.name
      })))
    }
    
    const artists = (data.result?.artists || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      picUrl: item.picUrl || item.img1v1Url,
      albumSize: item.albumSize,
      musicSize: item.musicSize,
      platform: 'netease' as const
    }))
    return artists
  } catch (error) {
    console.error('❌ [搜索歌手] 异常错误:', error)
    console.error('❌ [搜索歌手] 错误堆栈:', (error as Error).stack)
    return []
  }
}

// 搜索专辑
export async function searchAlbums(keywords: string, platform: MusicPlatform = 'netease'): Promise<Album[]> {
  try {
    // Spotify：官方 API 专辑搜索
    if (platform === 'spotify') {
      const { searchSpotifyAlbums } = await import('./spotifyService')
      const albums = await searchSpotifyAlbums(keywords, 20)
      return albums.map(a => ({
        id: Number(parseInt(a.id.slice(0, 12), 36)) || 0,
        mid: a.id,
        name: a.name,
        artist: { name: a.artists.map(artist => artist.name).join(' / ') },
        picUrl: a.coverUrl || '',
        publishTime: a.releaseDate ? new Date(a.releaseDate).getTime() : 0,
        platform: 'spotify' as const,
      }))
    }
    // 酷狗/汽水：暂不支持独立专辑搜索
    if (platform === 'kugou' || platform === 'soda') return []
    const devMode = localStorage.getItem('developerMode') === 'true'
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&type=album&devMode=${devMode}`)
      const data = await response.json()
      const albums = (data.albums || []).map((item: any) => {
        const album = {
          id: item.albumID,
          mid: item.albumMID,
          name: item.albumName,
          picUrl: item.albumPic || '',
          artist: { name: item.singer_name || '未知艺人', mid: item.singer_mid },
          publishTime: item.pub_time,
          platform: 'qq' as const
        }
        return album
      })
      return albums
    }
    const response = await fetch(`${API_BASE}/netease/search?keywords=${encodeURIComponent(keywords)}&type=10&devMode=${devMode}`)
    const data = await response.json()
    const albums = (data.result?.albums || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      picUrl: item.picUrl,
      artist: { name: item.artist?.name, id: item.artist?.id },
      publishTime: item.publishTime,
      size: item.size,
      platform: 'netease' as const
    }))
    return albums
  } catch (error) {
    console.error('搜索专辑失败:', error)
    return []
  }
}

// 获取歌曲播放URL（支持平台）
export async function getSongUrl(id: number | string, platform: MusicPlatform = 'netease'): Promise<string | null> {
  ensureSongUrlListenersRegistered()
  if (!String(id).trim()) return null
  const cacheKey = buildSongUrlCacheKey(id, platform)
  const now = Date.now()
  const cached = songUrlCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    songUrlCache.delete(cacheKey)
    songUrlCache.set(cacheKey, cached)
    return cached.url
  }
  if (cached) songUrlCache.delete(cacheKey)

  const pending = songUrlPending.get(cacheKey)
  if (pending) return pending

  const requestGeneration = songUrlCacheGeneration
  const requestVersion = songUrlInvalidationVersions.get(cacheKey) || 0
  const resolveCurrentRequest = async (): Promise<string | null> => {
    try {
      let apiUrl: string
      let readUrl: (data: any) => string | null
      if (platform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
        const { preference, isVip } = getAudioQualityRequest('qq')
        apiUrl = `${API_BASE}/qq/song/url?mid=${encodeURIComponent(String(id))}&quality=${encodeURIComponent(preference)}&vip=${isVip ? 'true' : 'false'}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`
        readUrl = data => data.url || null
      } else if (platform === 'kugou') {
        // 酷狗：签名网关四层策略（H5→Mobile→Web），付费歌曲返回 null → 上层降级网易云/QQ
        const kgCookie = localStorage.getItem('kugou_cookie') || ''
        apiUrl = `${API_BASE}/kugou/song/url?hash=${encodeURIComponent(String(id))}${kgCookie ? `&cookie=${encodeURIComponent(kgCookie)}` : ''}`
        readUrl = data => data.url || null
      } else if (platform === 'soda') {
        // 汽水音乐：逆向 Web API 音源（VIP/SVIP 分层过滤在服务端完成；
        // 未登录或无可用流时 url 为空 → 返回 null 走上层网易云/QQ 降级匹配）
        const { preference } = getAudioQualityRequest('soda')
        apiUrl = `${API_BASE}/soda/song/url?id=${encodeURIComponent(String(id))}&quality=${encodeURIComponent(preference)}${
          (() => {
            const sdCookie = localStorage.getItem('soda_token') || ''
            return sdCookie ? '&cookie=' + encodeURIComponent(sdCookie) : ''
          })()
        }`
        readUrl = data => data.url || null
      } else if (platform === 'spotify') {
        // Spotify：未登录无自源音源，返回 null → 上层降级网易云/QQ
        return null
      } else {
        const cookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        const fallbackSetting = localStorage.getItem('crossPlatformFallbackEnabled')
        const crossPlatformFallback = fallbackSetting !== null ? JSON.parse(fallbackSetting) : false
        const { preference, isVip } = getAudioQualityRequest('netease')
        apiUrl = `${API_BASE}/netease/song/url?id=${encodeURIComponent(String(id))}&quality=${encodeURIComponent(preference)}&vip=${isVip ? 'true' : 'false'}&fallback=${crossPlatformFallback ? 'true' : 'false'}${cookie ? '&cookie=' + encodeURIComponent(cookie) : ''}`
        readUrl = data => data.data?.[0]?.url || null
      }

      const response = await fetchSongUrlResponse(apiUrl)
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(data?.error || `Playback URL request failed (${response.status})`)
      }

      if (requestGeneration !== songUrlCacheGeneration) {
        return getSongUrl(id, platform)
      }
      if ((songUrlInvalidationVersions.get(cacheKey) || 0) !== requestVersion) {
        return null
      }

      const url = readUrl(data)
      if (url && platform === 'netease' && data.fallback) {
        console.info(`[API] Netease song ${id} is using fallback audio from ${data.source || 'automatic match'}`)
      }
      cacheSongUrl(cacheKey, url)
      return url
    } catch (error) {
      if (requestGeneration !== songUrlCacheGeneration) {
        return getSongUrl(id, platform)
      }
      if ((songUrlInvalidationVersions.get(cacheKey) || 0) !== requestVersion) {
        return null
      }
      console.error(`[API] Failed to resolve ${platform} song ${id} playback URL:`, error)
      return null
    }
  }

  const request = resolveCurrentRequest()
  songUrlPending.set(cacheKey, request)
  try {
    return await request
  } finally {
    if (songUrlPending.get(cacheKey) === request) {
      songUrlPending.delete(cacheKey)
    }
  }
}

/**
 * 汽水播放地址详情（结构化不可播原因）：
 * 与 getSongUrl 汽水分支同口径（音质偏好 + soda_token cookie 一致），替代裸调直取 URL，
 * 不可播时带回顶层 requiredTier/vipLabel/reason（/api/soda/song/url playable:false 时的结构化原因），
 * 供上层换源提示文案使用；请求失败统一降级为 { url: null }，不向调用方抛错。
 */
export async function getSodaPlaybackInfo(id: number | string): Promise<{
  url: string | null
  requiredTier?: 'free' | 'vip' | 'svip'
  vipLabel?: string
  reason?: string
}> {
  if (!String(id).trim()) return { url: null }
  const { preference } = getAudioQualityRequest('soda')
  const query = new URLSearchParams({ id: String(id), quality: preference })
  const sdCookie = localStorage.getItem('soda_token') || ''
  if (sdCookie) query.set('cookie', sdCookie)
  try {
    const response = await fetchSongUrlResponse(`${API_BASE}/soda/song/url?${query.toString()}`)
    // 401 = 登录态缺失（sodaRequireLogin）：按后端约定的 login_required 原因口径回传；其余失败不带 reason
    if (!response.ok) {
      return { url: null, reason: response.status === 401 ? 'login_required' : undefined }
    }
    const data: any = await response.json().catch(() => ({}))
    return {
      url: data?.url ? String(data.url) : null,
      requiredTier: data?.requiredTier,
      vipLabel: data?.vipLabel ? String(data.vipLabel) : undefined,
      reason: data?.reason ? String(data.reason) : undefined,
    }
  } catch {
    return { url: null }
  }
}

// Song details
export async function getSongDetail(id: number): Promise<Song | null> {
  try {
    const response = await fetch(`${API_BASE}/netease/song/detail?ids=${id}`)
    const data = await response.json()
    
    return data.songs?.[0] || null
  } catch (error) {
    console.error('获取歌曲详情失败:', error)
    return null
  }
}

function normalizeYrcWords(words: LyricWord[]): LyricWord[] {
  const normalized: LyricWord[] = []
  let previousEnd = 0
  let index = 0

  while (index < words.length) {
    const word = words[index]
    if (/^\s+$/u.test(word.word)) {
      normalized.push({ ...word, startTime: previousEnd, duration: 0 })
      index++
      continue
    }

    if (word.duration > 0 && word.startTime >= 0) {
      const startTime = Math.max(0, word.startTime)
      normalized.push({ ...word, startTime })
      previousEnd = Math.max(previousEnd, startTime + word.duration)
      index++
      continue
    }

    const runStart = index
    while (index < words.length && !(words[index].duration > 0 && words[index].startTime >= 0)) {
      index++
    }
    const run = words.slice(runStart, index)
    const characterCount = Math.max(1, run.reduce(
      (count, item) => count + (item.word.trim() ? Array.from(item.word).length : 0),
      0
    ))
    const nextTimedStart = index < words.length ? Math.max(previousEnd, words[index].startTime) : null
    const inferredDuration = nextTimedStart !== null && nextTimedStart > previousEnd
      ? nextTimedStart - previousEnd
      : Math.min(2400, Math.max(280, characterCount * 180))
    let elapsed = 0

    run.forEach(item => {
      if (/^\s+$/u.test(item.word)) {
        normalized.push({ ...item, startTime: previousEnd + elapsed, duration: 0 })
        return
      }
      const itemCharacters = Math.max(1, Array.from(item.word).length)
      const duration = inferredDuration * itemCharacters / characterCount
      normalized.push({ ...item, startTime: previousEnd + elapsed, duration })
      elapsed += duration
    })
    previousEnd += inferredDuration
  }

  return normalized
}

// 解析逐字歌词
// 格式: [16210,3460](16210,670,0)还(16880,410,0)没...
function parseYrc(yrcText: string): LyricLine[] {
  if (!yrcText) return []
  

  
  const lines = yrcText.split('\n')
  const result: LyricLine[] = []
  
  for (const line of lines) {
    // 跳过JSON元数据行
    if (line.trim().startsWith('{')) continue
    if (!line.trim()) continue
    
    // 匹配格式: [开始时间,总时长](字1时间,字1时长,0)字1(字2时间,字2时长,0)字2...
    const headerMatch = /^\[(\d+),(\d+)\]/.exec(line)
    if (!headerMatch) continue
    
    const lineStartTime = parseInt(headerMatch[1]) / 1000 // 转换为秒
    
    // 移除 header [时间,时长]
    let contentAfterHeader = line.substring(headerMatch[0].length)
    
    // ?? 重要修复：移除无时间戳的前缀文本（如 "词:"、"曲:"等标签）
    const firstTimestampCheck = /\(\d+,\d+/.exec(contentAfterHeader)
    if (firstTimestampCheck && firstTimestampCheck.index > 0) {
      const prefixText = contentAfterHeader.substring(0, firstTimestampCheck.index).trim()
      if (/^[\u4e00-\u9fff]+[:：]\s*$/.test(prefixText)) {
        contentAfterHeader = contentAfterHeader.substring(firstTimestampCheck.index)
      }
    }
    
    // ============================================
    // 核心修复：使用两步法解析逐字歌词
    // 第一步：找到所有时间戳的位置和参数
    // 第二步：提取每个时间戳后面的文本作为独立的词
    // ============================================
    const words: LyricWord[] = []
    const timestampRegex = /\((\d+),(\d+)(?:,\d+)?\)/g
    const timestamps: { startTime: number; duration: number; index: number; length: number }[] = []
    let tsMatch
    
    const lineStartTimeMs = parseInt(headerMatch[1]) // 行开始的绝对时间（毫秒）
    
    // 先找到第一个时间戳的位置
    const firstTimestampMatch = timestampRegex.exec(contentAfterHeader)
    let firstIndex = firstTimestampMatch ? firstTimestampMatch.index : -1
    
    // 重置正则表达式
    timestampRegex.lastIndex = 0
    
    while ((tsMatch = timestampRegex.exec(contentAfterHeader)) !== null) {
      const absoluteStartTime = parseInt(tsMatch[1])
      timestamps.push({
        startTime: absoluteStartTime - lineStartTimeMs,  // 转换为相对于行开始的时间
        duration: parseInt(tsMatch[2]),          // 毫秒（QRC格式已是毫秒）
        index: tsMatch.index,
        length: tsMatch[0].length
      })
    }
    
    // 提取第一个时间戳之前的文本（如果存在）
    if (firstIndex > 0) {
      const prefixText = contentAfterHeader.substring(0, firstIndex).trim()
      if (prefixText && !isYrcTimestampFragment(prefixText)) {
        // 第一个词的开始时间为0，duration为第一个时间戳的开始时间
        const firstDuration = timestamps.length > 0 ? timestamps[0].startTime : 0
        words.push({
          word: prefixText,
          startTime: 0,
          duration: firstDuration
        })
      }
    }
    
    // 第二步：提取每个时间戳后面的文本
    for (let i = 0; i < timestamps.length; i++) {
      const ts = timestamps[i]
      const afterTimestamp = contentAfterHeader.substring(ts.index + ts.length)
      
      // 找到下一个时间戳的位置
      const nextTs = timestamps[i + 1]
      let wordText: string
      if (nextTs) {
        // 提取到下一个时间戳之前的内容
        wordText = afterTimestamp.substring(0, nextTs.index - (ts.index + ts.length))
      } else {
        // 最后一个时间戳，取到行尾
        wordText = afterTimestamp
      }
      
      // Keep whitespace tokens: they are part of the visible lyric and separate words.
      if (!wordText) continue
      
      // 跳过纯数字和符号（过滤误匹配的时间戳碎片）
      if (isYrcTimestampFragment(wordText)) continue
      
      words.push({
        word: wordText,
        startTime: ts.startTime,
        duration: ts.duration
      })
    }
    
    const normalizedWords = normalizeYrcWords(words)
    
    // 清理整行内容，生成纯文本
    let fullText = contentAfterHeader
    
    // 移除完整的时间戳
    fullText = fullText.replace(/\(\d+,\d+(?:,\d+)?\)/g, '')
    
    // 移除残留的时间戳碎片
    fullText = fullText.replace(/\d+,\d+\)/g, '')
    fullText = fullText.replace(/,\d+\)/g, '')
    fullText = fullText.replace(/\(\d+,/g, '')
    fullText = fullText.replace(/\(\d+$/g, '')
    
    // 清理不匹配的括号
    const leftCount = (fullText.match(/\(/g) || []).length
    const rightCount = (fullText.match(/\)/g) || []).length
    if (leftCount !== rightCount) {
      fullText = fullText.replace(/[\(\)]/g, '')
    }
    
    // 清理多余空白和逗号
    fullText = fullText.replace(/,+/g, '').trim().replace(/\s+/g, ' ')
    
    if (fullText) {
      result.push({
        time: lineStartTime,
        text: fullText,
        words: normalizedWords.length > 0 ? normalizedWords : undefined
      })
    }
  }
  
  return result.sort((a, b) => a.time - b.time)
}

// 从 QQ 音乐的 [kana:...] 元数据中提取逐字时间映射
// 格式: [kana:1字1符1号(12345,100)带(12445,150)时(12595,120)间...]
// 返回: Map<字符, {startTime, duration}>
function parseQQKanaMetadata(kanaText: string): Map<string, {startTime: number, duration: number}[]> {
  const result = new Map<string, {startTime: number, duration: number}[]>()
  
  // 查找 [kana:...] 行
  const kanaMatch = /\[kana:([^\]]+)\]/.exec(kanaText)
  if (!kanaMatch) return result
  
  const kanaData = kanaMatch[1]
  
  console.log('🔍 QQ音乐 Kana 原始数据:', kanaData.substring(0, 500))
  
  // 解析格式: 1字1符(12345,100)带(12445,150)时...
  // 1 是普通字符的分隔符
  // 字(时间,时长) 是带时间信息的字符
  let currentPos = 0
  
  while (currentPos < kanaData.length) {
    // 跳过数字分隔符
    if (/^\d+/.test(kanaData.substring(currentPos))) {
      const numMatch = /^(\d+)/.exec(kanaData.substring(currentPos))
      if (numMatch) {
        currentPos += numMatch[1].length
      }
    }
    
    // 查找字符和可能的时间信息
    const charMatch = /^([^1(]+)(\((\d+),(\d+)\))?/.exec(kanaData.substring(currentPos))
    if (charMatch) {
      const chars = charMatch[1]
      const hasTime = charMatch[2] !== undefined
      const startTime = hasTime ? parseInt(charMatch[3]) : 0
      const duration = hasTime ? parseInt(charMatch[4]) : 0
      
      // ⚠️ 修复：如果一组字符共享一个时间戳，需要平均分配时间
      // 例如: Takizawa(12345,800) -> 每个字母分配 100ms
      const charArray = Array.from(chars)
      const charCount = charArray.length
      const charDuration = charCount > 0 ? duration / charCount : duration
      
      // 为每个字符存储时间信息
      charArray.forEach((char, index) => {
        if (!result.has(char)) {
          result.set(char, [])
        }
        result.get(char)!.push({ 
          startTime: startTime + index * charDuration, 
          duration: charDuration 
        })
      })
      
      currentPos += charMatch[0].length
    } else {
      currentPos++
    }
  }
  
  return result
}

// 解析 QQ 音乐的 kana 格式歌词（合并普通歌词和 kana 时间信息）
function parseQQKanaLyric(lrcText: string, qrcText: string): LyricLine[] {
  if (!lrcText) return []
  
  console.log('📋 QQ音乐歌词数据:')
  console.log('  - lrcText长度:', lrcText.length)
  console.log('  - qrcText长度:', qrcText.length)
  console.log('  - qrcText前500字符:', qrcText.substring(0, 500))
  
  // 从 qrc 中提取 kana 时间映射
  const kanaMap = parseQQKanaMetadata(qrcText)
  // 解析普通歌词
  const lines = lrcText.split('\n')
  const result: LyricLine[] = []
  
  for (const line of lines) {
    // 跳过元数据行
    if (line.trim().startsWith('[ti:') || 
        line.trim().startsWith('[ar:') || 
        line.trim().startsWith('[al:') ||
        line.trim().startsWith('[by:') ||
        line.trim().startsWith('[offset:') ||
        line.trim().startsWith('[kana:')) {
      continue
    }
    if (!line.trim()) continue
    
    // 匹配时间戳 [mm:ss.xx] 或 [mm:ss.xxx]
    const timeMatch = /^\[(\d{2}):(\d{2})\.(\d{2,3})\]/.exec(line)
    if (!timeMatch) continue
    
    const minutes = parseInt(timeMatch[1])
    const seconds = parseInt(timeMatch[2])
    const milliseconds = parseInt(timeMatch[3].padEnd(3, '0'))
    const lineStartTime = minutes * 60 + seconds + milliseconds / 1000
    
    // 获取歌词文本
    const lyricText = line.substring(timeMatch[0].length).trim()
    if (!lyricText) continue
    
    // 如果有 kana 时间映射，为每个字符添加逐字时间
    const words: LyricWord[] = []
    if (kanaMap.size > 0) {
      for (const char of lyricText) {
        const timeInfo = kanaMap.get(char)
        if (timeInfo && timeInfo.length > 0) {
          // 使用第一个匹配的时间信息（并从数组中移除）
          const info = timeInfo.shift()!
          words.push({
            word: char,
            startTime: info.startTime,
            duration: info.duration
          })
        } else {
          // 没有时间信息的字符
          words.push({
            word: char,
            startTime: 0,
            duration: 0
          })
        }
      }
    }
    
    result.push({
      time: lineStartTime,
      text: lyricText,
      words: words.length > 0 ? words : undefined
    })
  }
  
  return result.sort((a, b) => a.time - b.time)
}

// 解析普通歌词
/**
 * 网易云新版歌词接口可能返回 JSON 行格式：{"t":16000,"c":[{"tx":"文本"}]}
 * （t = 毫秒；无 t 的行是未同步纯文本，跳过）。旧接口返回标准 LRC。
 */
function parseNeteaseJsonLyric(lyricText: string): LyricLine[] {
  const result: LyricLine[] = []
  for (const line of lyricText.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed)
      const timeMs = obj?.t
      if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) continue
      const text = Array.isArray(obj?.c)
        ? obj.c.map((chunk: any) => (chunk && typeof chunk.tx === 'string' ? chunk.tx : '')).join('')
        : ''
      if (text.trim()) result.push({ time: timeMs / 1000, text: text.trim() })
    } catch {
      // 非 JSON 行忽略
    }
  }
  return result.sort((a, b) => a.time - b.time)
}

function parseLyric(lyricText: string): LyricLine[] {
  if (!lyricText) return []

  const lines = lyricText.split('\n')
  const result: LyricLine[] = []

  const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 网易云新版歌词可能是"JSON 行 + 普通 LRC"混合格式：
    // 开头是 JSON 元数据行（作词/作曲…），后面是普通 LRC 正文。
    // 逐行判断，JSON 行按 JSON 解析，其余按 LRC 解析，两者都要保留。
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed)
        const timeMs = obj?.t
        if (typeof timeMs === 'number' && Number.isFinite(timeMs)) {
          const text = Array.isArray(obj?.c)
            ? obj.c.map((chunk: any) => (chunk && typeof chunk.tx === 'string' ? chunk.tx : '')).join('')
            : ''
          if (text.trim()) result.push({ time: timeMs / 1000, text: text.trim() })
        }
      } catch {
        // 非 JSON 行忽略
      }
      continue
    }

    const match = timeRegex.exec(line)
    if (match) {
      const minutes = parseInt(match[1])
      const seconds = parseInt(match[2])
      const milliseconds = parseInt(match[3].padEnd(3, '0'))

      const time = minutes * 60 + seconds + milliseconds / 1000
      const text = line.replace(timeRegex, '').trim()

      if (text) {
        result.push({ time, text })
      }
    }
  }

  return result.sort((a, b) => a.time - b.time)
}

// 获取歌词（支持多源自适应 + 流式更新）
// 歌词API日志接口
export interface LyricsApiLog {
  source: string
  hasWordByWord: boolean
  hasRoman: boolean
  hasTranslation: boolean
  status: 'success' | 'failed' | 'empty'
  lineCount: number
  errorMessage?: string
}

export interface LyricsFinalInfo {
  logs: LyricsApiLog[]
  finalSources: {
    wordByWord?: string
    roman?: string
    translation?: string
  }
  allCompleted: boolean
}

export async function getLyrics(
  id: number | string, 
  platform: MusicPlatform = 'netease',
  songName?: string,
  artistName?: string,
  duration?: number,
  onProgress?: (lyrics: LyricLine[], source: string, hasWordByWord: boolean, apiLogs?: LyricsFinalInfo) => void
): Promise<LyricLine[]> {
  // 只有元数据（作词/作曲…）没有正文的"空壳歌词"：视为无效结果，
  // 避免 Lrclib/AMLL 等第三方源用空壳抢跑，导致界面只剩"作词 作曲"没有正文。
  const LYRIC_METADATA_ONLY = /^(词|曲|编曲|作词|作曲|演唱|歌手|制作人|录音|混音|母带)[：:\s]/u
  const isMetadataOnlyLyrics = (lyrics: LyricLine[]): boolean => {
    if (!Array.isArray(lyrics) || lyrics.length === 0) return false
    return !lyrics.some(line => {
      const text = (line.text || '').trim()
      if (!text) return false
      return !LYRIC_METADATA_ONLY.test(text)
    })
  }
  try {
    // 检查用户设置
    const thirdPartyEnabled = localStorage.getItem('thirdPartyLyricsEnabled')
    const adaptiveLyrics = localStorage.getItem('adaptiveLyrics')
    const primarySource = localStorage.getItem('primaryLyricsSource') || 'AMLL'
    
    const useThirdParty = thirdPartyEnabled !== null ? JSON.parse(thirdPartyEnabled) : true
    const useAdaptive = adaptiveLyrics !== null ? JSON.parse(adaptiveLyrics) : true
    // 如果禁用第三方或禁用自适应，直接使用当前平台
    if (!useThirdParty || !useAdaptive || primarySource === 'Platform') {
      return await getPlatformLyrics(id, platform, songName, artistName)
    }
    
    // 官方歌词源必须与歌曲所属平台一致，禁止拿一个平台的歌曲 ID 请求另一个平台。
    // 旧设置中如果保存了不匹配的官方源，则安全回退到当前歌曲平台。
    const requestedOfficialPlatform = primarySource === 'NetEase'
      ? 'netease'
      : primarySource === 'QQMusic'
        ? 'qq'
        : null

    if (requestedOfficialPlatform) {
      if (requestedOfficialPlatform !== platform) {
        console.warn(
          `[Lyrics] 已阻止跨平台歌词请求：歌曲平台=${platform}，设置源=${requestedOfficialPlatform}；改用当前平台`
        )
      }
    }
    
    // 默认策略：流式加载 - 先显示基础歌词，再逐步增强
    type LyricsSourceResult = { source: string; lyrics: LyricLine[]; hasWW: boolean; hasTrans: boolean; hasRom: boolean }
    const isApplePlatform = platform === 'apple'
    const platformSourceName = platform === 'qq' ? 'QQ音乐' : isApplePlatform ? 'Apple Music' : platform === 'spotify' ? 'Spotify' : platform === 'kugou' ? '酷狗' : platform === 'soda' ? '汽水' : '网易云'
    
    // 平台互斥：QQ音乐歌曲不请求网易云API，网易云歌曲不请求QQ音乐API。
    // Apple 曲目不请求网易云/QQ 平台源；Spotify 无官方歌词接口（酷狗登录时除外；
    // 汽水已接入逆向歌词管线，走 getPlatformLyrics 内部含网易云同名匹配兜底）。
    const platformSourcePromise = isApplePlatform
      ? Promise.resolve([])
      : platform === 'spotify'
        ? Promise.resolve([])
        : getPlatformLyrics(id, platform, songName, artistName)
    const amllSourcePromise = isApplePlatform
      ? Promise.resolve([])
      : getAMLLTTMLLyrics(id, platform)
    const sources = [
      // 平台官方源只请求当前歌曲所属平台
      { name: platformSourceName, promise: platformSourcePromise },
      { name: 'AMLL TTML DB', promise: amllSourcePromise },
      // Apple Music：仅在用户已完成 Apple 登录时才请求（未登录默认关闭，不替换平台歌词）
      ...(isAppleMusicConfigured()
        ? [{ name: 'Apple Music', promise: songName && artistName ? getAppleMusicLyrics(songName, artistName, duration) : Promise.resolve([]) }]
        : []),
      { name: 'Lrclib', promise: songName && artistName ? getLrclibLyrics(songName, artistName, duration) : Promise.resolve([]) }
    ]
    
    // API日志收集
    const apiLogs: LyricsApiLog[] = []
    const totalApis = sources.length
    
    let currentLyrics: LyricLine[] = []
    let hasWordByWord = false
    let hasTranslation = false
    let hasRoman = false
    let completedCount = 0
    
    // 包装每个请求，处理完成后立即更新
    const wrappedPromises: Promise<LyricsSourceResult | null>[] = sources.map(source => 
      source.promise
        .then(lyrics => {
          completedCount++
          const hasWW = lyrics.some(line => line.words && line.words.length > 0)
          const hasTrans = lyrics.some(line => line.translation)
          const hasRom = lyrics.some(line => line.roman || (line.romanWords && line.romanWords.length > 0))
          
          // 记录API日志
          apiLogs.push({
            source: source.name,
            hasWordByWord: hasWW,
            hasRoman: hasRom,
            hasTranslation: hasTrans,
            status: lyrics.length === 0 ? 'empty' : 'success',
            lineCount: lyrics.length
          })
          
          if (lyrics.length === 0 || isMetadataOnlyLyrics(lyrics)) return null
          
          return { source: source.name, lyrics, hasWW, hasTrans, hasRom }
        })
        .catch((error) => {
          completedCount++
          // 记录失败日志
          apiLogs.push({
            source: source.name,
            hasWordByWord: false,
            hasRoman: false,
            hasTranslation: false,
            status: 'failed',
            lineCount: 0,
            errorMessage: error instanceof Error ? error.message : '未知错误'
          })
          return null
        })
    )
    
    try {
      // 第一阶段：谁先返回有效歌词就先显示。平台源为空或暂时变慢时，
      // 已经预载完成的 AMLL TTML 不再被它阻塞。
      const firstResult = await new Promise<LyricsSourceResult | null>(resolve => {
        let pending = wrappedPromises.length
        let settled = false
        wrappedPromises.forEach(promise => {
          promise.then(result => {
            pending--
            if (!settled && result) {
              settled = true
              resolve(result)
            } else if (!settled && pending === 0) {
              resolve(null)
            }
          })
        })
      })
      
      let finalSourceTracking = {
        wordByWord: undefined as string | undefined,
        roman: undefined as string | undefined,
        translation: undefined as string | undefined
      }
      
      if (firstResult && firstResult.lyrics.length > 0) {
        currentLyrics = firstResult.lyrics
        hasWordByWord = firstResult.hasWW
        hasTranslation = firstResult.hasTrans
        hasRoman = firstResult.hasRom
        
        // 记录来源
        if (hasWordByWord) finalSourceTracking.wordByWord = firstResult.source
        if (hasRoman) finalSourceTracking.roman = firstResult.source
        if (hasTranslation) finalSourceTracking.translation = firstResult.source
        

        
        // 流式回调：立即显示基础歌词
        console.log(`  [Lyrics] 源: ${firstResult.source}, 逐字: ${hasWordByWord}, 罗马音: ${hasRoman}, 翻译: ${hasTranslation}, text: '${currentLyrics[0]?.text || ''}'`); if (onProgress) {
          onProgress(currentLyrics, firstResult.source, hasWordByWord, {
            logs: [...apiLogs],
            finalSources: { ...finalSourceTracking },
            allCompleted: completedCount >= totalApis
          })
        }
      }
      
      // 第二阶段：等待所有结果，增强歌词
      const allResults = await Promise.allSettled(wrappedPromises)
      
      const successfulResults = allResults.flatMap(result =>
        result.status === 'fulfilled' && result.value ? [result.value] : []
      )
      if (successfulResults.length === 0) return []

      const preferredSource = primarySource === 'AMLL'
        ? 'AMLL TTML DB'
        : primarySource === 'Apple Music'
          ? 'Apple Music'
          : requestedOfficialPlatform === platform
            ? platformSourceName
            : platformSourceName

      // 先选逐字质量最高的骨架，再按时间把其他来源的翻译/罗马音补进来。
      // 第三方/Apple 歌词源必须通过「同步性达标」检查，否则降权甚至不被采纳：
      // 1) 时长一致性：歌词时间轴须落在歌曲时长范围内（过短/超长视为不同步）
      // 2) 平台歌词时间轴交叉验证：与当前平台官方歌词做文本对齐，时间偏差中位数小才加分
      const platformResult = successfulResults.find(result => result.source === platformSourceName)

      const normalizeLyricText = (text: string) => (text || '')
        .toLowerCase()
        .replace(/[\s·•\-–—()（）[\]【】「」『』〈〉《》"'`、，。！？!?,.&/|:：]+/g, '')

      /** 候选歌词 vs 平台官方歌词：文本对齐后的时间偏差中位数 → 同步分 */
      const lyricTimingSyncScore = (candidate: LyricLine[], reference: LyricLine[]): number => {
        const referenceTimes = new Map<string, number[]>()
        reference.forEach(line => {
          const key = normalizeLyricText(line.text)
          if (!key) return
          const list = referenceTimes.get(key) ?? []
          list.push(line.time)
          referenceTimes.set(key, list)
        })
        const diffs: number[] = []
        candidate.forEach(line => {
          const key = normalizeLyricText(line.text)
          if (!key) return
          const times = referenceTimes.get(key)
          if (times && times.length > 0) diffs.push(line.time - times[0])
        })
        // 匹配对数不足（平台歌词过劣/过少）视为无法验证：不加分也不降权
        if (diffs.length < Math.max(3, Math.floor(candidate.length * 0.3))) return 0
        diffs.sort((a, b) => a - b)
        const medianDiff = Math.abs(diffs[Math.floor(diffs.length / 2)])
        if (medianDiff < 1.0) return 30   // 同步良好
        if (medianDiff < 2.5) return 10   // 轻微偏差可接受
        return -150                       // 明显不同步 → 直接排除（超过逐字分 100，任何第三方源必败）
      }

      const sourceScore = (result: LyricsSourceResult) => {
        let score = (result.hasWW ? 100 : 0)
          + (result.hasTrans ? 20 : 0)
          + (result.hasRom ? 20 : 0)
          + (result.source === preferredSource ? 35 : 0)
          + (result.source === platformSourceName ? 5 : 0)
          + Math.min(10, result.lyrics.length / 20)
        // 时长一致性：歌词时间轴必须落在歌曲时长内（duration 为毫秒）
        if (duration && result.lyrics.length > 0) {
          const lastTime = result.lyrics[result.lyrics.length - 1].time
          const durationSeconds = duration / 1000
          if (lastTime >= durationSeconds * 0.5 && lastTime <= durationSeconds * 1.05) {
            score += 10
          } else {
            score -= 40
          }
        }
        // 平台歌词交叉验证：第三方/Apple 源需与当前平台官方歌词时间轴对齐
        if (platformResult && result.source !== platformSourceName
          && result.lyrics.length > 0 && platformResult.lyrics.length > 0) {
          score += lyricTimingSyncScore(result.lyrics, platformResult.lyrics)
        }
        return score
      }

      // 骨架源选择策略（用户策略）：
      // - **QQ 音乐**：QQ 官方歌词权威（逐字+翻译+罗马音一次请求全拿），其缺失部分第三方
      //   通常也没有（实测 QQ 的 qrc/trans 覆盖极高）——**强制以 QQ 官方为骨架**，
      //   第三方源只做翻译/罗马音空缺的兜底拼接，绝不让第三方逐字源顶掉 QQ 骨架。
      // - **网易云**：官方逐字（yrc）覆盖少，保持评分制——第三方逐字源（WW+100）可竞争
      //   骨架，官方+第三方并行拼接（网易云本身就是拼接生态）。
      const baseResult = platformSourceName === 'QQ音乐'
        ? [...successfulResults].sort((a, b) => (a.source === 'QQ音乐' ? -1 : 0) - (b.source === 'QQ音乐' ? -1 : 0))[0]
        : [...successfulResults].sort((a, b) => sourceScore(b) - sourceScore(a))[0]
      currentLyrics = baseResult.lyrics
      hasWordByWord = baseResult.hasWW
      hasTranslation = baseResult.hasTrans
      hasRoman = baseResult.hasRom
      finalSourceTracking = {
        wordByWord: baseResult.hasWW ? baseResult.source : undefined,
        roman: baseResult.hasRom ? baseResult.source : undefined,
        translation: baseResult.hasTrans ? baseResult.source : undefined,
      }

      for (const result of successfulResults) {
        if (result === baseResult) continue
        const translations = result.lyrics
          .filter(line => line.translation)
          .map(line => ({ time: line.time, text: line.translation || '' }))
        const romans = result.lyrics
          .filter(line => line.roman || line.romanWords)
          .map(line => ({ time: line.time, text: line.roman || '', words: line.romanWords }))
        if (translations.length === 0 && romans.length === 0) continue

        const neededTranslation = !hasTranslation && translations.length > 0
        const neededRoman = !hasRoman && romans.length > 0
        currentLyrics = mergeLyricsWithTranslationAndRoman(currentLyrics, translations, romans)
        if (neededTranslation) {
          hasTranslation = true
          finalSourceTracking.translation = result.source
        }
        if (neededRoman) {
          hasRoman = true
          finalSourceTracking.roman = result.source
        }
      }

      console.log(`  [Lyrics] 组合完成: 骨架=${baseResult.source}, 逐字=${hasWordByWord}, 罗马音=${hasRoman}, 翻译=${hasTranslation}`)
      // Apple 曲目歌词诊断：转发到后台控制台，便于确认逐字/翻译/罗马音来源
      if (isApplePlatform) {
        try {
          const bridge = (window as any).electron
          if (bridge && typeof bridge.log === 'function') {
            bridge.log(`[Apple歌词] 歌曲《${songName || ''}》骨架源=${baseResult.source} 逐字=${hasWordByWord} 罗马音=${hasRoman} 翻译=${hasTranslation}（${baseResult.lyrics.length}行）`)
          }
        } catch {
          // 忽略
        }
      }
      if (onProgress) {
        onProgress(currentLyrics, baseResult.source, hasWordByWord, {
          logs: [...apiLogs],
          finalSources: { ...finalSourceTracking },
          allCompleted: true,
        })
      }
      
      // 输出格式化的API日志总结
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('📊 歌词 API 调用汇总')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
      
      apiLogs.forEach(log => {
        const statusIcon = log.status === 'success' ? '✅' : log.status === 'empty' ? '⚠️' : '❌'
        console.log(`${statusIcon} ${log.source}`)
        
        if (log.status === 'success') {
          const wwIcon = log.hasWordByWord ? '✓' : '✗'
          const romIcon = log.hasRoman ? '✓' : '✗'
          const transIcon = log.hasTranslation ? '✓' : '✗'
          console.log(`   逐字: ${wwIcon}  |  罗马音: ${romIcon}  |  翻译: ${transIcon}`)
          console.log(`   ${log.lineCount} 行\n`)
        } else if (log.status === 'empty') {
          console.log('   暂无信息\n')
        } else if (log.status === 'failed') {
          console.log(`   错误: ${log.errorMessage}\n`)
        }
      })
      
      if (finalSourceTracking.wordByWord || finalSourceTracking.roman || finalSourceTracking.translation) {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
        console.log('🎯 最终来源')
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
        
        if (finalSourceTracking.wordByWord) {
          console.log(`逐字: ${finalSourceTracking.wordByWord}`)
        }
        if (finalSourceTracking.roman) {
          console.log(`罗马音: ${finalSourceTracking.roman}`)
        }
        if (finalSourceTracking.translation) {
          console.log(`翻译: ${finalSourceTracking.translation}`)
        }
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
      } else {
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
      }
      
      return currentLyrics
      
    } catch (error) {
      console.error('  ❌ 获取歌词失败:', error)
      return []
    }
    
  } catch (error) {
    console.error('获取歌词失败:', error)
    return []
  }
}

// 获取平台原生歌词（内部函数）
async function getPlatformLyrics(id: number | string, platform: MusicPlatform, songName?: string, artistName?: string): Promise<LyricLine[]> {
  try {
    if (platform === 'kugou') {
      // 酷狗：krcs 歌词接口（无需登录；失败走 Lrclib/AMLL 兜底）
      const url = new URL(`${API_BASE}/kugou/lyric`)
      url.searchParams.set('hash', String(id))
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
      if (!response.ok) return []
      const data = await response.json()
      const lyricText = data.lyric || ''
      if (!lyricText) return []
      return parseLyric(lyricText)
    }
    if (platform === 'soda') {
      // 汽水：逆向歌词管线（SEO → track_v2 → 公开目录）；getSodaLyrics 已随原文对齐挂载汽水自带翻译（tlyric）
      const { getSodaLyrics } = await import('./sodaService')
      const lines = await getSodaLyrics(String(id))
      if (lines.length) return lines
      // 汽水曲库缺词（纯音乐/翻唱常见）→ 网易云同名匹配兜底，保证"自动拉歌词"体验；
      // 命中时参考网易云主路径把 tlyric 翻译一并合并，避免兜底歌词丢翻译。
      const keyword = [songName, artistName].filter(Boolean).join(' ').trim()
      if (keyword) {
        try {
          const res = await searchSongs(keyword, 5, 'netease')
          const target = res.songs && res.songs[0]
          if (target && target.id) {
            const resp = await fetch(`${API_BASE}/netease/lyric?id=${encodeURIComponent(String(target.id))}`, { signal: AbortSignal.timeout(8000) })
            if (resp.ok) {
              const data = await resp.json().catch(() => null)
              const lrc = String(data?.lrc?.lyric || data?.lyric || '')
              if (lrc.includes('[')) {
                const lyrics = parseLyric(lrc)
                const translations = parseLyric(String(data?.tlyric?.lyric || ''))
                return mergeLyricsWithTranslationAndRoman(lyrics, translations)
              }
            }
          }
        } catch { /* 匹配失败静默 */ }
      }
      return []
    }
    if (platform === 'qq') {
      const qqCookie = localStorage.getItem('qq_cookie') || ''
      const url = new URL(`${API_BASE}/qq/lyric`)
      // 同一参数既可能是 songmid（字符串/数字）也可能是 songID（纯数字）：两种都传，
      // 后端 musicu 按有效字段取——只传 mid 时，songID 型 id 会被当成 songMID 查询 → 空歌词
      //（实测 rainy tone qq:233811640 只传 mid 返回空，带 songID 才有完整 LRC）
      url.searchParams.set('mid', String(id))
      url.searchParams.set('id', String(id))
      if (qqCookie) {
        url.searchParams.set('cookie', qqCookie)
      }
      
      const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) })
      
      // 检查响应状态
      if (!response.ok) {
        console.error(`  [QQ音乐] HTTP错误: ${response.status} ${response.statusText}`)
        return []
      }
      
      const data = await response.json()
      
      // 检查API返回的错误
      if (data.code && data.code !== 200 && data.code !== 0) {
        console.error(`  [QQ音乐] API错误: code=${data.code}, msg=${data.msg || data.message}`)
        return []
      }
      // 获取翻译和罗马音
      const translationText = data.trans?.lyric || ''
      const translations = parseLyric(translationText)
      
      const romanText = data.roma?.lyric || ''
      // QQ音乐的罗马音也是YRC格式，需要用parseYrc解析以保留逐字信息
      const romans = romanText ? parseYrc(romanText) : []
      
      // 优先逐字歌词
      if (data.qrc?.lyric) {
        const qrcText = data.qrc.lyric
        const lrcText = data.lrc?.lyric || ''
        let lyrics: LyricLine[] = []
        
        
        // 先尝试解析为网易云 YRC 格式（QQ 音乐的 QRC 也是这个格式）
        lyrics = parseYrc(qrcText)
        // 如果 YRC 解析失败，尝试 kana 格式（需要 lrc 和 qrc 合并）
        if (lyrics.length === 0 && qrcText.includes('[kana:') && lrcText) {
          lyrics = parseQQKanaLyric(lrcText, qrcText)
        }
        
        // 如果都失败，按普通歌词解析
        if (lyrics.length === 0) {
          lyrics = parseLyric(lrcText || qrcText)
        }
        
        return mergeLyricsWithTranslationAndRoman(lyrics, translations, romans)
      }
      
      // 否则普通歌词
      const lyricText = data.lrc?.lyric || ''
      const lyrics = parseLyric(lyricText)
      return mergeLyricsWithTranslationAndRoman(lyrics, translations, romans)
      
    } else {
      const response = await fetch(`${API_BASE}/netease/lyric?id=${id}`, { signal: AbortSignal.timeout(5000) })
      
      // 检查响应状态
      if (!response.ok) {
        console.error(`  [网易云] HTTP错误: ${response.status} ${response.statusText}`)
        return []
      }
      
      const data = await response.json()
      
      // 检查API返回的错误
      if (data.code && data.code !== 200) {
        console.error(`  [网易云] API错误: code=${data.code}, msg=${data.msg || data.message}`)
        return []
      }
      // 获取翻译
      const translationText = data.tlyric?.lyric || ''
      const translations = parseLyric(translationText)
      
      // 优先逐字歌词
      if (data.yrc?.lyric) {
        const lyrics = parseYrc(data.yrc.lyric)
        if (lyrics.length > 0) {
          return mergeLyricsWithTranslationAndRoman(lyrics, translations)
        }
        // 网易云新版 yrc 可能是 JSON 且仅含元数据（作词/作曲…），
        // 此时解析为空 → 退回普通 lrc，避免平台歌词整体丢失。
      }
      
      // 否则普通歌词
      const lyricText = data.lrc?.lyric || ''
      const lyrics = parseLyric(lyricText)
      return mergeLyricsWithTranslationAndRoman(lyrics, translations)
    }
  } catch (error) {
    console.error(`[${platform}] 获取歌词失败:`, error)
    return []
  }
}

// 合并歌词、翻译和罗马音
function mergeLyricsWithTranslationAndRoman(
  lyrics: LyricLine[], 
  translations: LyricLine[], 
  romans: LyricLine[] = []
): LyricLine[] {
  if (translations.length === 0 && romans.length === 0) return lyrics
  
  // 使用贪婪算法：为每句歌词找最接近的翻译和罗马音
  const usedTranslations = new Set<number>()
  const usedRomans = new Set<number>()
  
  return lyrics.map((lyric) => {
    const text = lyric.text?.trim() || ''
    
    // 检查是否是元数据行（词:、曲:、编曲:等）或歌曲标题行（包含 " - " 分隔符）
    const isMetadata = /^(词|曲|编曲|作词|作曲|演唱|歌手)[：:]/u.test(text)
    const isSongTitle = / - /.test(text) && lyric.time < 2 // 前2秒内包含 " - " 的行视为标题
    
    // 元数据行和标题行不需要匹配翻译和罗马音
    if (isMetadata || isSongTitle) {
      return lyric
    }
    
    let bestTransMatch: LyricLine | undefined
    let bestRomanMatch: LyricLine | undefined
    let minTransDiff = Infinity
    let minRomanDiff = Infinity
    
    // 找到时间最接近且未使用的翻译
    translations.forEach((t, index) => {
      if (usedTranslations.has(index)) return
      
      const diff = Math.abs(t.time - lyric.time)
      // 开头歌词（前5秒）放宽阈值到2秒，因为时间戳经常不准确
      const threshold = lyric.time < 5 ? 2.0 : 1.0
      if (diff < threshold && diff < minTransDiff) {
        minTransDiff = diff
        bestTransMatch = t
      }
    })
    
    // 找到时间最接近且未使用的罗马音
    romans.forEach((r, index) => {
      if (usedRomans.has(index)) return
      
      const diff = Math.abs(r.time - lyric.time)
      // 特殊处理：第一句歌词（0-3秒内）使用更宽松的阈值，允许向后匹配
      let threshold = 1.0
      if (lyric.time < 3) {
        // 第一句歌词放宽到3秒，且允许罗马音时间晚于歌词
        threshold = 3.0
      } else if (lyric.time < 10) {
        // 前10秒放宽到2秒
        threshold = 2.0
      }
      
      if (diff < threshold && diff < minRomanDiff) {
        minRomanDiff = diff
        bestRomanMatch = r
      }
    })
    
    // 标记已使用的翻译
    if (bestTransMatch) {
      const matchIndex = translations.indexOf(bestTransMatch)
      if (matchIndex !== -1) {
        usedTranslations.add(matchIndex)
      }
    }
    
    // 标记已使用的罗马音
    if (bestRomanMatch) {
      const matchIndex = romans.indexOf(bestRomanMatch)
      if (matchIndex !== -1) {
        usedRomans.add(matchIndex)
      }
    }
    
    return {
      ...lyric,
      // 组合多个来源时只补空缺，不能让后到的空结果擦掉 TTML 自带内容。
      translation: lyric.translation || bestTransMatch?.text || '',
      roman: lyric.roman || bestRomanMatch?.text || '',
      // 如果罗马音有逐字信息，也合并进来（用于显示逐字罗马音）
      romanWords: lyric.romanWords || bestRomanMatch?.words || undefined
    }
  })
}


function parseAMLLTTMLLyrics(ttmlText: string): LyricLine[] {
  const parsed = parseTTML(ttmlText)

  return parsed.lines
    .map(line => {
      const words = line.words.map(word => ({
        word: word.text,
        // AMLL TTML 使用歌曲绝对时间；WaveForge 的逐字时间以当前行为原点。
        startTime: Math.max(0, word.startTime - line.startTime),
        duration: Math.max(0, word.endTime - word.startTime),
      }))
      const text = words.map(word => word.word).join('').trim()

      return {
        time: line.startTime / 1000,
        text,
        words: words.length > 0 ? words : undefined,
        translation: line.translation?.trim() || undefined,
        roman: line.roman?.trim() || undefined,
      }
    })
    .filter(line => line.text)
    .sort((a, b) => a.time - b.time)
}

interface AMLLEndpoint {
  name: string
  url: string
  timeout: number
}

async function fetchFirstValidAMLL(endpoints: AMLLEndpoint[]): Promise<{ lyrics: LyricLine[]; endpoint: string } | null> {
  return new Promise(resolve => {
    let pending = endpoints.length
    let settled = false

    const finishEmpty = () => {
      pending--
      if (!settled && pending === 0) resolve(null)
    }

    endpoints.forEach(endpoint => {
      fetch(endpoint.url, { signal: AbortSignal.timeout(endpoint.timeout) })
        .then(async response => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const lyrics = parseAMLLTTMLLyrics(await response.text())
          if (lyrics.length === 0) throw new Error('TTML 内容为空')
          if (!settled) {
            settled = true
            resolve({ lyrics, endpoint: endpoint.name })
          }
        })
        .catch(finishEmpty)
    })
  })
}

// 获取真正的 TTML，而不是仓库生成的普通 LRC；逐字、翻译和罗马音来自同一文档。
async function getAMLLTTMLLyrics(id: number | string, platform: MusicPlatform): Promise<LyricLine[]> {
  const startTime = Date.now()
  // Spotify/汽水：曲目 ID 与 AMLL 库（网易云/QQ 目录）不兼容，直接返回空避免无效请求
  if (platform === 'spotify' || platform === 'soda') return []
  const folder = platform === 'qq' ? 'qq-lyrics' : 'ncm-lyrics'
  const encodedId = encodeURIComponent(String(id))
  const primaryEndpoints: AMLLEndpoint[] = [
    {
      name: 'GitHub Raw',
      url: `https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/${folder}/${encodedId}.ttml`,
      timeout: 4500,
    },
    platform === 'netease'
      ? {
          name: 'AMLL 作者镜像',
          url: `https://amll-ttml-db.stevexmh.net/ncm/${encodedId}`,
          timeout: 4500,
        }
      : {
          name: 'jsDelivr',
          url: `https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/${folder}/${encodedId}.ttml`,
          timeout: 4500,
        },
  ]

  const primary = await fetchFirstValidAMLL(primaryEndpoints)
  if (primary) {
    const hasTranslation = primary.lyrics.some(line => line.translation)
    const hasRoman = primary.lyrics.some(line => line.roman)
    console.log(`  [AMLL TTML DB] ✅ ${primary.endpoint}: 逐字 ✓ | 翻译 ${hasTranslation ? '✓' : '✗'} | 罗马音 ${hasRoman ? '✓' : '✗'} | ${primary.lyrics.length}行 | ${Date.now() - startTime}ms`)
    return primary.lyrics
  }

  if (platform === 'netease') {
    const fallback = await fetchFirstValidAMLL([
      {
        name: 'Dimeta 镜像',
        url: `https://amll.mirror.dimeta.top/api/db/ncm-lyrics/${encodedId}.ttml`,
        timeout: 5500,
      },
      {
        name: 'jsDelivr',
        url: `https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/${folder}/${encodedId}.ttml`,
        timeout: 5500,
      },
    ])
    if (fallback) {
      console.log(`  [AMLL TTML DB] ✅ ${fallback.endpoint}: ${fallback.lyrics.length}行 | ${Date.now() - startTime}ms`)
      return fallback.lyrics
    }
  }

  console.log(`  [AMLL TTML DB] 暂无对应 TTML，耗时: ${Date.now() - startTime}ms`)
  return []
}

// 从 Lrclib 获取歌词（需要歌曲名和艺术家）
async function getLrclibLyrics(songName: string, artistName: string, duration?: number): Promise<LyricLine[]> {
  const startTime = Date.now()
  try {
    // Lrclib API: https://lrclib.net/api/get
    const params = new URLSearchParams({
      track_name: songName,
      artist_name: artistName,
    })
    
    if (duration) {
      // 转换为秒
      params.set('duration', Math.round(duration / 1000).toString())
    }
    
    const url = `https://lrclib.net/api/get?${params.toString()}`
    const response = await fetch(url, { 
      signal: AbortSignal.timeout(3000) // 3秒超时
    })
    
    if (!response.ok) {
      console.log(`  [Lrclib] HTTP ${response.status}, 耗时: ${Date.now() - startTime}ms`)
      return []
    }
    
    const data = await response.json()
    
    // Lrclib 返回 syncedLyrics (逐行) 和 plainLyrics (纯文本)
    // 优先使用 syncedLyrics
    const lyricText = data.syncedLyrics || data.plainLyrics || ''
    
    if (!lyricText) {
      console.log(`  [Lrclib] ❌ 无歌词, 耗时: ${Date.now() - startTime}ms`)
      return []
    }
    
    // 解析为标准 LRC 格式
    const parsed = parseLyric(lyricText)
    const hasSync = !!data.syncedLyrics
    console.log(`  [Lrclib] ✅ 找到歌词 (${hasSync ? '同步' : '纯文本'}), ${parsed.length}行, 耗时: ${Date.now() - startTime}ms`)
    return parsed
  } catch (error) {
    console.log(`  [Lrclib] ❌ ${error instanceof Error ? error.message : '未找到'}, 耗时: ${Date.now() - startTime}ms`)
    return []
  }
}

// 批量获取网易云专辑封面
export async function loadAlbumCovers(songs: Song[]): Promise<Song[]> {
  try {
    // 提取需要加载封面的专辑ID
    const albumIds = [...new Set(songs.map(s => s.album?.id).filter(Boolean))] as number[]
    
    if (albumIds.length === 0) return songs
    
    const devMode = localStorage.getItem('developerMode') === 'true'
    const response = await fetch(`${API_BASE}/netease/albums/covers?ids=${albumIds.join(',')}&devMode=${devMode}`)
    const data = await response.json()
    
    if (data.covers) {
      // 更新歌曲的封面URL
      return songs.map(song => {
        if (song.album?.id && data.covers[song.album.id]) {
          return {
            ...song,
            album: {
              ...song.album,
              picUrl: data.covers[song.album.id]
            }
          }
        }
        return song
      })
    }
    
    return songs
  } catch (error) {
    console.error('批量加载封面失败:', error)
    return songs
  }
}

// 获取歌手详情
export async function getArtistDetail(id: number | string, platform: MusicPlatform = 'netease'): Promise<Artist | null> {
  try {
    // Spotify：官方 API 艺人详情
    if (platform === 'spotify') {
      const { spotifyFetch } = await import('./spotifyService')
      const data = await spotifyFetch(`/artists/${id}`)
      if (!data) return null
      const sid = String(data.id || id)
      return {
        id: Number(parseInt(sid.slice(0, 12), 36)) || 0,
        mid: sid,
        name: String(data.name || ''),
        picUrl: data.images?.[0]?.url || '',
        albumSize: data.total_albums,
        musicSize: data.total_tracks,
        platform: 'spotify' as const,
      }
    }
    // 酷狗/汽水：暂不支持艺人详情（无公开接口），返回 null → UI 不弹艺人页
    if (platform === 'kugou' || platform === 'soda') return null
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/artist?mid=${id}`)
      const data = await response.json()
      console.log(`[前端-歌手详情] 📊 QQ音乐返回数据keys:`, Object.keys(data))
      return {
        id: data.singer_id,
        mid: data.singer_mid,
        name: data.singer_name,
        picUrl: `https://y.gtimg.cn/music/photo_new/T001R800x800M000${id}.jpg`,
        albumSize: data.albumNum,
        musicSize: data.songNum,
        description: data.desc,
        fans: data.fans || 0,
        basic: data.basic,
        other: data.other,
        platform: 'qq'
      }
    }
    const response = await fetch(`${API_BASE}/netease/artist?id=${id}`)
    const data = await response.json()
    console.log(`[前端-歌手详情] 📊 网易云返回数据keys:`, Object.keys(data))
    
    if (!data.artist) {
      console.error(`[前端-歌手详情] ❌ 网易云返回数据中没有artist字段!`)
      console.error(`[前端-歌手详情] ❌ 完整数据:`, JSON.stringify(data).substring(0, 500))
      return null
    }
    
    console.log(`[前端-歌手详情] 📊 artist字段keys:`, Object.keys(data.artist))
    console.log(`[前端-歌手详情] 📊 alias: ${data.artist.alias ? JSON.stringify(data.artist.alias) : '无数据'}`)
    console.log(`[前端-歌手详情] 📊 briefDesc: ${data.artist.briefDesc ? '有数据(' + data.artist.briefDesc.length + '字符)' : '无数据'}`)
    console.log(`[前端-歌手详情] 📊 intro: ${data.artist.intro ? '有数据(' + data.artist.intro.length + '章节)' : '无数据'}`)
    const result = {
      id: data.artist.id,
      name: data.artist.name,
      picUrl: data.artist.picUrl || data.artist.img1v1Url,
      albumSize: data.artist.albumSize,
      musicSize: data.artist.musicSize,
      description: data.artist.briefDesc,
      briefDesc: data.artist.briefDesc,
      intro: data.artist.intro,
      alias: data.artist.alias || [],
      fans: data.fans || 0,
      platform: 'netease' as const
    }
    
    console.log(`[前端-歌手详情] 📊 最终返回的Artist对象keys:`, Object.keys(result))
    console.log(`[前端-歌手详情] 📊 description字段: ${result.description ? '有(' + result.description.length + '字符)' : '无'}`)
    console.log(`[前端-歌手详情] 📊 intro字段: ${result.intro ? '有(' + result.intro.length + '章节)' : '无'}`)
    return result
  } catch (error) {
    console.error('[前端-歌手详情] ❌ 异常错误:', error)
    console.error('[前端-歌手详情] ❌ 错误堆栈:', (error as Error).stack)
    return null
  }
}

// 获取歌手热门歌曲
export async function getArtistTopSongs(id: number | string, platform: MusicPlatform = 'netease'): Promise<Song[]> {
  try {
    // Spotify：官方 API 艺人热门歌曲
    if (platform === 'spotify') {
      const { spotifyFetch, spotifyTrackToSong } = await import('./spotifyService')
      const data = await spotifyFetch(`/artists/${id}/top-tracks`)
      return (data?.tracks || []).map((t: any) => spotifyTrackToSong({
        id: String(t.id || ''),
        name: String(t.name || ''),
        artists: (t.artists || []).map((a: any) => ({ name: String(a.name || '') })),
        album: t.album ? { name: String(t.album.name || ''), images: t.album.images || [] } : undefined,
        duration_ms: t.duration_ms,
      }))
    }
    // 酷狗/汽水：暂无艺人热门歌曲接口
    if (platform === 'kugou' || platform === 'soda') return []
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/artist/songs?mid=${id}`)
      const data = await response.json()
      console.log('📊 [getArtistTopSongs] QQ音乐返回数据keys:', Object.keys(data))
      
      const songs = (data.songs || []).slice(0, 50).map((item: any) => {
        const song = {
          id: item.id || item.songid,
          mid: item.mid || item.songmid,
          name: item.name || item.songname || item.title,
          artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
          album: {
            id: item.album?.id || item.albumid,
            mid: item.album?.mid || item.albummid,
            name: item.album?.name || item.albumname || item.album?.title || '',
            picUrl: (item.album?.mid || item.albummid) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album?.mid || item.albummid}.jpg` : ''
          },
          duration: (item.interval || item.duration) * 1000,
          platform: 'qq' as const,
          vip: item.pay?.payplay === 1
        }
        return song
      })
      return songs
    }
    
    // 使用 /api/netease/artist/songs 接口（返回热门歌曲）
    const response = await fetch(`${API_BASE}/netease/artist/songs?id=${id}`)
    const data = await response.json()
    
    // 检查后端返回的错误标志
    if (data.error) {
      console.error('获取歌手热门歌曲失败:', data.error)
      throw new Error(data.error)
    }
    
    return (data.songs || []).slice(0, 50).map((item: any) => ({
      id: item.id,
      name: item.name,
      artists: item.ar?.map((a: any) => ({ name: a.name })) || [],
      album: {
        id: item.al?.id,
        name: item.al?.name || '',
        picUrl: getProxiedImageUrl(item.al?.picUrl || '')
      },
      duration: item.dt,
      platform: 'netease' as const,
      vip: item.fee === 1 || item.fee === 4,
      // 更准确的版权判断
      noCopyright: item.privilege?.st < 0 || item.privilege?.playMaxbr === 0 || false,
      fee: item.fee
    }))
  } catch (error) {
    console.error('获取歌手热门歌曲失败:', error)
    return []
  }
}

// 获取专辑详情
export async function getAlbumDetail(id: number | string, platform: MusicPlatform = 'netease'): Promise<Album | null> {
  try {
    // Spotify：官方 API 专辑详情
    if (platform === 'spotify') {
      const { spotifyFetch } = await import('./spotifyService')
      const data = await spotifyFetch(`/albums/${id}`)
      if (!data) return null
      const sid = String(data.id || id)
      return {
        id: Number(parseInt(sid.slice(0, 12), 36)) || 0,
        mid: sid,
        name: String(data.name || ''),
        artist: data.artists?.[0]?.name || '',
        picUrl: data.images?.[0]?.url || '',
        description: '',
        publishTime: data.release_date || '',
        platform: 'spotify' as const,
      }
    }
    // 酷狗/汽水：暂不支持专辑详情
    if (platform === 'kugou' || platform === 'soda') return null
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/album?mid=${id}`)
      const data = await response.json()
      
      console.log('[前端-专辑详情] QQ音乐专辑数据:', {
        albumName: data.albumName,
        pub_time: data.pub_time,
        desc: data.desc ? `有数据(${data.desc.length}字符)` : '无数据',
        genre: data.genre,
        lan: data.lan,
        company: data.company
      })
      
      return {
        id: data.albumID,
        mid: data.albumMID,
        name: data.albumName,
        picUrl: `https://y.gtimg.cn/music/photo_new/T002R800x800M000${id}.jpg`,
        artist: { name: data.singer_name, mid: data.singer_mid },
        publishTime: data.pub_time,
        description: data.desc,
        genre: data.genre,
        lan: data.lan,
        company: data.company,
        platform: 'qq'
      }
    }
    
    const response = await fetch(`${API_BASE}/netease/album?id=${id}`)
    const data = await response.json()
    return {
      id: data.album.id,
      name: data.album.name,
      picUrl: getProxiedImageUrl(data.album.picUrl),
      artist: { name: data.album.artist?.name, id: data.album.artist?.id },
      publishTime: data.album.publishTime,
      size: data.album.size,
      description: data.album.description,
      platform: 'netease'
    }
  } catch (error) {
    console.error('获取专辑详情失败:', error)
    return null
  }
}

// 获取专辑歌曲列表
export async function getAlbumSongs(id: number | string, platform: MusicPlatform = 'netease'): Promise<Song[]> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/album?mid=${id}`)
      const data = await response.json()
      return (data.songs || []).map((item: any) => ({
        id: item.songid,
        mid: item.songmid,
        name: item.songname,
        artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
        album: {
          id: data.albumID,
          mid: data.albumMID || String(id),
          name: data.albumName,
          picUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${id}.jpg`
        },
        duration: item.interval * 1000,
        platform: 'qq' as const,
        vip: item.pay?.payplay === 1
      }))
    }
    
    const response = await fetch(`${API_BASE}/netease/album?id=${id}`)
    const data = await response.json()
    return (data.songs || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      // 后端已经统一返回 artists 字段
      artists: item.artists?.map((a: any) => ({ name: a.name, id: a.id })) || [],
      album: {
        id: data.album.id,
        name: data.album.name,
        picUrl: getProxiedImageUrl(data.album.picUrl)
      },
      // 后端已经统一返回 duration 字段
      duration: item.duration,
      platform: 'netease' as const,
      vip: item.fee === 1 || item.fee === 4,
      // 更准确的版权判断：privilege.st < 0 或 playMaxbr === 0 才是真正无版权
      noCopyright: item.privilege?.st < 0 || item.privilege?.playMaxbr === 0 || false,
      fee: item.fee
    }))
  } catch (error) {
    console.error('获取专辑歌曲列表失败:', error)
    return []
  }
}

// 获取歌手全部歌曲（分页加载）
export async function getArtistAllSongs(id: number | string, platform: MusicPlatform = 'netease', offset: number = 0, limit: number = 40): Promise<{ songs: Song[], total: number }> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/artist/songs?mid=${id}&limit=${limit}`)
      const data = await response.json()
      const songs = (data.songs || []).map((item: any) => ({
        id: item.id,
        mid: item.mid,
        name: item.name || item.title,
        artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
        album: {
          id: item.album?.id,
          mid: item.album?.mid,
          name: item.album?.name || item.album?.title || '',
          picUrl: item.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.album.mid}.jpg` : ''
        },
        duration: (item.interval || item.duration) * 1000,
        platform: 'qq' as const,
        vip: item.pay?.payplay === 1
      }))
      return {
        songs,
        total: data.total || 0
      }
    }
    
    // 网易云暂时不支持分页，返回热门歌曲
    const songs = await getArtistTopSongs(id, 'netease')
    return {
      songs,
      total: songs.length
    }
  } catch (error) {
    console.error('获取歌手全部歌曲失败:', error)
    return { songs: [], total: 0 }
  }
}

// 获取歌手专辑列表
export async function getArtistAlbums(id: number | string, platform: MusicPlatform = 'netease', limit: number = 200, offset: number = 0): Promise<Album[]> {
  try {
    // Spotify：官方 API 艺人专辑
    if (platform === 'spotify') {
      const { spotifyFetch } = await import('./spotifyService')
      const data = await spotifyFetch(`/artists/${id}/albums?limit=${Math.min(limit, 50)}&offset=${offset}`)
      return (data?.items || []).map((item: any) => {
        const sid = String(item.id || '')
        return {
          id: Number(parseInt(sid.slice(0, 12), 36)) || 0,
          mid: sid,
          name: String(item.name || ''),
          artist: item.artists?.[0]?.name || '',
          picUrl: item.images?.[0]?.url || '',
          publishTime: item.release_date || '',
          platform: 'spotify' as const,
        }
      })
    }
    // 酷狗/汽水：暂不支持艺人专辑
    if (platform === 'kugou' || platform === 'soda') return []
    if (platform === 'qq') {
      const page = Math.floor(offset / limit) + 1
      const response = await fetch(`${API_BASE}/qq/artist/albums?mid=${id}&page=${page}&pageSize=${limit}`)
      const data = await response.json()
      return (data.albumList || []).map((item: any) => ({
        id: item.albumID,
        mid: item.albumMID,
        name: item.albumName,
        picUrl: `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albumMID}.jpg`,
        artist: { name: item.singer_name, mid: item.singer_mid },
        publishTime: item.pub_time,
        size: item.song_count,
        platform: 'qq' as const
      }))
    }
    
    const response = await fetch(`${API_BASE}/netease/artist/albums?id=${id}&limit=${limit}&offset=${offset}`)
    const data = await response.json()
    return (data.hotAlbums || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      picUrl: getProxiedImageUrl(item.picUrl),
      artist: { name: item.artist?.name, id: item.artist?.id },
      publishTime: item.publishTime,
      size: item.size,
      platform: 'netease' as const
    }))
  } catch (error) {
    console.error('获取歌手专辑列表失败:', error)
    return []
  }
}

// 获取歌手MV列表
export async function getArtistMVs(id: number | string, platform: MusicPlatform = 'netease', limit: number = 200, offset: number = 0): Promise<any[]> {
  try {
    if (platform === 'qq') {
      const page = Math.floor(offset / limit) + 1
      const response = await fetch(`${API_BASE}/qq/artist/mvs?mid=${id}&page=${page}&pageSize=${limit}`)
      const data = await response.json()
      return (data.mvList || []).map((item: any) => ({
        id: item.vid,
        name: item.name,
        imgurl: item.picurl || '',
        imgurl16v9: item.picurl || '',
        picUrl: item.picurl || '',
        playCount: item.playcnt,
        publishTime: item.pubdate,
        duration: item.duration * 1000, // 转换为毫秒
        platform: 'qq' as const
      }))
    }
    
    const response = await fetch(`${API_BASE}/netease/artist/mvs?id=${id}&limit=${limit}&offset=${offset}`)
    const data = await response.json()
    return (data.mvs || []).map((item: any) => ({
      id: item.id,
      name: item.name,
      imgurl: item.imgurl,
      imgurl16v9: item.imgurl16v9,
      picUrl: item.imgurl16v9 || item.imgurl || item.cover,
      playCount: item.playCount,
      publishTime: item.publishTime,
      duration: item.duration,
      platform: 'netease' as const
    }))
  } catch (error) {
    console.error('获取歌手MV列表失败:', error)
    return []
  }
}

// 获取MV播放地址
export async function getMVUrl(mvId: number | string, quality: number = 1080, platform: MusicPlatform = 'netease'): Promise<string | null> {
  try {
    if (platform === 'qq') {
      const cookie = getPlatformCookie('qq')
      const response = await fetch(`${API_BASE}/qq/mv/url?vid=${mvId}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`)
      const data = await response.json()
      return data.url || null
    }
    
    const response = await fetch(`${API_BASE}/netease/mv/url?id=${mvId}&r=${quality}`)
    const data = await response.json()
    return data.data?.url || null
  } catch (error) {
    console.error('获取MV播放地址失败:', error)
    return null
  }
}

// 获取MV播放信息（含失败原因）——QQ MV 无免费播放源时返回 error 供 UI 展示
export async function getMVPlaybackInfo(mvId: number | string, quality: number = 1080, platform: MusicPlatform = 'netease'): Promise<{ url: string | null, error?: string, needCookie?: boolean }> {
  try {
    if (platform === 'qq') {
      const cookie = getPlatformCookie('qq')
      const response = await fetch(`${API_BASE}/qq/mv/url?vid=${mvId}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`)
      const data = await response.json()
      return { url: data.url || null, error: data.error, needCookie: data.needCookie }
    }
    const response = await fetch(`${API_BASE}/netease/mv/url?id=${mvId}&r=${quality}`)
    const data = await response.json()
    return { url: data.data?.url || null }
  } catch (error) {
    console.error('获取MV播放信息失败:', error)
    return { url: null, error: error instanceof Error ? error.message : '获取播放地址失败' }
  }
}

// 获取MV详情
export async function getMVDetail(mvId: number | string, platform: MusicPlatform = 'netease'): Promise<any> {
  try {
    if (platform === 'qq') {
      const cookie = getPlatformCookie('qq')
      const response = await fetch(`${API_BASE}/qq/mv/detail?vid=${mvId}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`)
      const data = await response.json()
      return {
        id: data.vid,
        name: data.name,
        artistName: data.singer,
        cover: data.picurl ? getProxiedImageUrl(data.picurl) : '',
        playCount: data.playcnt,
        publishTime: data.pubdate,
        desc: data.desc
      }
    }
    
    const response = await fetch(`${API_BASE}/netease/mv/detail?mvid=${mvId}`)
    const data = await response.json()
    return {
      id: data.data?.id,
      name: data.data?.name,
      artistName: data.data?.artistName,
      cover: getProxiedImageUrl(data.data?.cover || ''),
      playCount: data.data?.playCount,
      publishTime: data.data?.publishTime,
      desc: data.data?.desc
    }
  } catch (error) {
    console.error('获取MV详情失败:', error)
    return null
  }
}
// 歌单控制功能

// 创建歌单
export async function createPlaylist(
  name: string,
  platform: MusicPlatform = 'netease',
  options: {
    privacy?: string
    type?: string
    cookie?: string
  } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/playlist/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        privacy: options.privacy || '0',
        type: options.type || 'NORMAL',
        cookie: cookie
      })
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('创建歌单失败:', error)
    throw error
  }
}

// 删除歌单
export async function deletePlaylist(
  playlistId: string,
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/playlist/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: playlistId,
        cookie: cookie
      })
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('删除歌单失败:', error)
    throw error
  }
}

// 添加歌曲到歌单
export async function addTracksToPlaylist(
  playlistId: string,
  trackIds: string[],
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/playlist/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'add',
        pid: playlistId,
        tracks: trackIds.join(','),
        cookie: cookie
      })
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('添加歌曲到歌单失败:', error)
    throw error
  }
}

// 从歌单删除歌曲
export async function removeTracksFromPlaylist(
  playlistId: string,
  trackIds: string[],
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/playlist/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        op: 'del',
        pid: playlistId,
        tracks: trackIds.join(','),
        cookie: cookie
      })
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('从歌单删除歌曲失败:', error)
    throw error
  }
}

// 收藏/取消收藏歌单
export async function subscribePlaylist(
  playlistId: string,
  subscribe: boolean = true,
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/playlist/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        t: subscribe ? '1' : '2',
        subscribe,
        id: playlistId,
        cookie: cookie
      })
    })

    const data = await response.json()
    return data
  } catch (error) {
    console.error('收藏歌单失败:', error)
    throw error
  }
}

// ══════════════════════════════════════════════════════════════
// 第一批：搜索热词 + 搜索联想 + 专辑收藏 + 热门评论
// ══════════════════════════════════════════════════════════════

/** 获取搜索热词 */
export async function searchHot(platform: MusicPlatform = 'netease'): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/${platform}/search/hot`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取搜索热词失败')
    return data
  } catch (error) {
    console.error('搜索热词获取失败:', error)
    return null
  }
}

/** QQ 搜索快速联想 */
export async function searchQuick(keywords: string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/search/quick?keywords=${encodeURIComponent(keywords)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取搜索联想失败')
    return data
  } catch (error) {
    console.error('搜索联想获取失败:', error)
    return null
  }
}

/** 收藏/取消收藏专辑 */
export async function subscribeAlbum(
  id: string,
  subscribe: boolean = true,
  platform: MusicPlatform = 'netease',
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/album/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, subscribe, t: subscribe ? '1' : '2', cookie })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '收藏专辑失败')
    return data
  } catch (error) {
    console.error('收藏专辑失败:', error)
    throw error
  }
}

/** 获取已收藏专辑列表 */
export async function getSubscribedAlbums(platform: 'netease' = 'netease', options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/album/sublist?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取收藏专辑列表失败')
    return data
  } catch (error) {
    console.error('获取收藏专辑列表失败:', error)
    return null
  }
}

/**
 * 查询当前账号是否已收藏某专辑。
 * QQ 传 mid，网易云传数字 id。
 */
export async function isAlbumSubscribed(
  albumId: string | number,
  platform: MusicPlatform
): Promise<boolean> {
  try {
    const id = String(albumId)
    const data = platform === 'qq'
      ? await getQQSubscribedAlbums()
      : await getSubscribedAlbums('netease')
    if (!data) return false
    const list = data?.data?.list || data?.data?.data || data?.list || data?.data || []
    if (!Array.isArray(list)) return false
    return list.some((a: any) => {
      const mid = a.mid || a.album_mid || a.MID || ''
      const rawId = a.id || a.album_id || a.ID || ''
      return String(mid) === id || String(rawId) === id
    })
  } catch (error) {
    console.error('查询专辑收藏状态失败:', error)
    return false
  }
}

/** 获取网易云热门评论 */
export async function getHotComments(
  id: string,
  type: number = 0,
  limit: number = 20,
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/comment/hot?id=${id}&type=${type}&limit=${limit}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取热门评论失败')
    return data
  } catch (error) {
    console.error('获取热门评论失败:', error)
    return null
  }
}

// ══════════════════════════════════════════════════════════════
// 第二批：相似歌曲/歌手 + 歌手关注/取关
// ══════════════════════════════════════════════════════════════

/** 获取相似歌曲 */
export async function getSimilarSongs(
  id: string,
  platform: MusicPlatform = 'netease',
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    // QQ 需要 numeric id，网易云需要 string id，统一用 id 参数名
    const url = `${API_BASE}/${platform}/song/similar?id=${encodeURIComponent(id)}&cookie=${encodeURIComponent(cookie)}`
    const response = await fetch(url)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取相似歌曲失败')
    return data
  } catch (error) {
    console.error('相似歌曲获取失败:', error)
    return null
  }
}

/** 获取相似歌手 */
export async function getSimilarArtists(
  id: string,
  platform: MusicPlatform = 'netease',
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie(platform, options.cookie)
    const paramKey = platform === 'qq' ? 'mid' : 'id'
    const url = `${API_BASE}/${platform}/artist/similar?${paramKey}=${encodeURIComponent(id)}&cookie=${encodeURIComponent(cookie)}`
    const response = await fetch(url)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取相似歌手失败')
    return data
  } catch (error) {
    console.error('相似歌手获取失败:', error)
    return null
  }
}

/** 关注/取关歌手 */
export async function subscribeArtist(
  id: string,
  subscribe: boolean = true,
  platform: MusicPlatform = 'netease',
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    // Spotify：官方 API 关注/取关艺人（id 为 Spotify artist id）
    if (platform === 'spotify') {
      const { followSpotifyArtists } = await import('./spotifyService')
      const ok = await followSpotifyArtists([id], subscribe)
      if (!ok) throw new Error('Spotify 关注歌手失败（token 失效或网络异常）')
      return { result: 200, platform: 'spotify' }
    }
    const cookie = getPlatformCookie(platform, options.cookie)
    const body: Record<string, any> = { id, subscribe, t: subscribe ? '1' : '2', cookie }
    // QQ 的歌手关注使用 mid 字段而非 id
    if (platform === 'qq') {
      body.mid = id
      delete body.id
    }
    const response = await fetch(`${API_BASE}/${platform}/artist/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '关注歌手失败')
    return data
  } catch (error) {
    console.error('关注歌手失败:', error)
    throw error
  }
}

/** 获取已关注歌手列表 */
export async function getSubscribedArtists(platform: MusicPlatform = 'netease', options: { cookie?: string } = {}): Promise<any> {
  try {
    // Spotify：官方 API 我关注的艺人
    if (platform === 'spotify') {
      const { fetchSpotifyFollowingArtists } = await import('./spotifyService')
      const artists = await fetchSpotifyFollowingArtists(50)
      return { artists }
    }
    const cookie = getPlatformCookie(platform, options.cookie)
    const response = await fetch(`${API_BASE}/${platform}/artist/sublist?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取关注歌手列表失败')
    return data
  } catch (error) {
    console.error('获取关注歌手列表失败:', error)
    return null
  }
}

/** QQ 收藏专辑列表（自己，user/collect/album） */
export async function getQQSubscribedAlbums(options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const response = await fetch(`${API_BASE}/qq/album/sublist?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取收藏专辑列表失败')
    return data
  } catch (error) {
    console.error('QQ收藏专辑列表获取失败:', error)
    return null
  }
}

/** QQ 关注歌手列表（RelationList 过滤歌手，fcg 老接口需 skey 不可用） */
export async function getQQSubscribedArtists(options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const response = await fetch(`${API_BASE}/qq/artist/sublist2?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取关注歌手列表失败')
    return data
  } catch (error) {
    console.error('QQ关注歌手列表获取失败:', error)
    return null
  }
}

/**
 * 查询当前账号是否已关注某歌手（拉取已关注列表后按 id/mid 匹配）。
 * QQ 传 mid，网易云传数字 id。
 */
export async function isArtistFollowed(
  artistId: string | number,
  platform: MusicPlatform
): Promise<boolean> {
  try {
    const id = String(artistId)
    const data = platform === 'qq'
      ? await getQQSubscribedArtists()
      : await getSubscribedArtists('netease')
    if (!data) return false
    const list = data?.data?.list || data?.data?.data || data?.list || data?.data || []
    if (!Array.isArray(list)) return false
    return list.some((a: any) => {
      const mid = a.mid || a.singer_mid || a.MID || ''
      const rawId = a.id || a.singer_id || a.ID || ''
      return String(mid) === id || String(rawId) === id
    })
  } catch (error) {
    console.error('查询歌手关注状态失败:', error)
    return false
  }
}

// ══════════════════════════════════════════════════════════════
// 第三批：MV分类浏览 + 用户关注/粉丝 + 听歌排行
// ══════════════════════════════════════════════════════════════

/** 获取网易云全部 MV 列表 */
export async function getAllMVs(
  limit: number = 30,
  offset: number = 0,
  area: string = '',
  type: string = '',
  order: string = '',
  options: { cookie?: string } = {}
): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset), cookie })
    if (area) params.set('area', area)
    if (type) params.set('type', type)
    if (order) params.set('order', order)
    const response = await fetch(`${API_BASE}/netease/mv/all?${params}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取MV列表失败')
    return data
  } catch (error) {
    console.error('MV列表获取失败:', error)
    return null
  }
}

/** 获取 QQ MV 分类 */
export async function getMVCategories(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/mv/category`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取MV分类失败')
    return data
  } catch (error) {
    console.error('MV分类获取失败:', error)
    return null
  }
}

/** 获取 QQ MV 列表（按分类：version 版本/类型 + area 地区） */
export async function getMVListByCategory(version: number = 7, area: number = 15, pageNo: number = 1, pageSize: number = 20): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/mv/list?version=${version}&area=${area}&pageNo=${pageNo}&pageSize=${pageSize}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取MV列表失败')
    return data
  } catch (error) {
    console.error('MV列表获取失败:', error)
    return null
  }
}

/** 搜索 MV（网易云 type=1004，QQ t=12） */
export async function searchMVs(keywords: string, platform: MusicPlatform = 'netease', limit: number = 30): Promise<any> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}&type=mv`)
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || 'MV搜索失败')
      return data
    }
    const cookie = getPlatformCookie('netease')
    const params = new URLSearchParams({ keywords, limit: String(limit), type: '1004', cookie })
    const response = await fetch(`${API_BASE}/netease/search?${params}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || 'MV搜索失败')
    return data
  } catch (error) {
    console.error('MV搜索失败:', error)
    return null
  }
}

/** 搜索歌单（网易云 type=1000，QQ t=2） */export async function searchPlaylists(keywords: string, platform: MusicPlatform = 'netease', limit: number = 20): Promise<any> {
  try {
    if (platform === 'qq') {
      const response = await fetch(`${API_BASE}/qq/search?keywords=${encodeURIComponent(keywords)}&limit=${limit}&type=playlist`)
      const data = await response.json()
      if (!response.ok) throw new Error(data?.error || '歌单搜索失败')
      return data
    }
    const cookie = getPlatformCookie('netease')
    const params = new URLSearchParams({ keywords, limit: String(limit), type: '1000', cookie })
    const response = await fetch(`${API_BASE}/netease/search?${params}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '歌单搜索失败')
    return data
  } catch (error) {
    console.error('歌单搜索失败:', error)
    return null
  }
}

/** 搜索用户（网易云 type=1002） */
export async function searchUsers(keywords: string, limit: number = 20): Promise<{ userId: number; nickname: string; signature: string; avatarUrl: string }[]> {
  try {
    const cookie = getPlatformCookie('netease')
    const params = new URLSearchParams({ keywords, limit: String(limit), type: '1002', cookie })
    const response = await fetch(`${API_BASE}/netease/search?${params}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '用户搜索失败')
    return (data?.result?.userprofiles || []).map((u: any) => ({
      userId: u.userId,
      nickname: u.nickname || '未知用户',
      signature: u.signature || '',
      avatarUrl: u.avatarUrl || '',
    }))
  } catch (error) {
    console.error('用户搜索失败:', error)
    return []
  }
}

/** 获取用户关注列表 */
export async function getUserFollows(uid: string, options: { cookie?: string; limit?: number; offset?: number } = {}): Promise<any> {  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const limit = options.limit ?? 30
    const offset = options.offset ?? 0
    const response = await fetch(`${API_BASE}/netease/user/follows?uid=${uid}&limit=${limit}&offset=${offset}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取关注列表失败')
    return data
  } catch (error) {
    console.error('关注列表获取失败:', error)
    return null
  }
}

/** 获取用户粉丝列表 */
export async function getUserFolloweds(uid: string, options: { cookie?: string; limit?: number; offset?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const limit = options.limit ?? 30
    const offset = options.offset ?? 0
    const response = await fetch(`${API_BASE}/netease/user/followeds?uid=${uid}&limit=${limit}&offset=${offset}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取粉丝列表失败')
    return data
  } catch (error) {
    console.error('粉丝列表获取失败:', error)
    return null
  }
}

/** 网易云首页 Banner */
export async function getNeteaseBanner(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/banner`)
    const data = await response.json()
    return data?.banners || []
  } catch (error) {
    console.error('Banner获取失败:', error)
    return []
  }
}

/** QQ 首页 Banner */
export async function getQQBanner(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/banner`)
    const data = await response.json()
    return data?.banners || []
  } catch (error) {
    console.error('QQ Banner获取失败:', error)
    return []
  }
}

/** 网易云热门歌单 */
export async function getNeteasePlaylistHot(cat: string = '全部', limit: number = 30): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/playlist/hot?cat=${encodeURIComponent(cat)}&limit=${limit}`)
    const data = await response.json()
    return data?.playlists || []
  } catch (error) {
    console.error('热门歌单获取失败:', error)
    return []
  }
}

/** 网易云精品歌单 */
export async function getNeteasePlaylistHighquality(cat: string = '全部', limit: number = 30): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/playlist/highquality?cat=${encodeURIComponent(cat)}&limit=${limit}`)
    const data = await response.json()
    return data?.playlists || []
  } catch (error) {
    console.error('精品歌单获取失败:', error)
    return []
  }
}

/** 网易云 MV 榜 */
export async function getNeteaseTopMv(limit: number = 30): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/top/mv?limit=${limit}`)
    const data = await response.json()
    return data?.mvs || []
  } catch (error) {
    console.error('MV榜获取失败:', error)
    return []
  }
}

/** 网易云热门歌手 */
export async function getNeteaseTopArtists(limit: number = 30): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/top/artists?limit=${limit}`)
    const data = await response.json()
    return data?.artists || []
  } catch (error) {
    console.error('热门歌手获取失败:', error)
    return []
  }
}

/** QQ 歌单分类 */
export async function getQQSonglistCategory(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/songlist/category`)
    const data = await response.json()
    return data?.data || []
  } catch (error) {
    console.error('QQ歌单分类获取失败:', error)
    return []
  }
}

/** QQ 分类歌单 */
export async function getQQSonglistList(id: number, page: number = 1, pageSize: number = 20): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/songlist/list?id=${id}&page=${page}&pageSize=${pageSize}`)
    const data = await response.json()
    return data?.data || null
  } catch (error) {
    console.error('QQ分类歌单获取失败:', error)
    return null
  }
}

/** 网易云歌曲百科 */
export async function getNeteaseSongWiki(id: number | string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/song/wiki?id=${encodeURIComponent(String(id))}`)
    const data = await response.json()
    return data?.summary || null
  } catch (error) {
    console.error('歌曲百科获取失败:', error)
    return null
  }
}

/** 网易云相关博客（歌曲所属专辑的博客文章，App 歌曲详情"相关博客"） */
export async function getNeteaseSongBlog(albumId: number | string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/song/blog?albumId=${encodeURIComponent(String(albumId))}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (data?.code !== 200) {
      console.warn('相关博客获取失败:', data?.msg || data?.error || `code ${data?.code}`)
      return null
    }
    return data
  } catch (error) {
    console.error('相关博客获取失败:', error)
    return null
  }
}

/** QQ 歌曲所在歌单 */
export async function getQQSongPlaylist(mid: string, limit: number = 10): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/song/playlist?mid=${encodeURIComponent(mid)}&limit=${limit}`)
    const data = await response.json()
    return data?.data || null
  } catch (error) {
    console.error('QQ歌曲所在歌单获取失败:', error)
    return null
  }
}

/** 网易云相似 MV */
export async function getNeteaseSimiMv(mvid: number | string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/simi/mv?mvid=${encodeURIComponent(String(mvid))}`)
    const data = await response.json()
    return data?.mvs || []
  } catch (error) {
    console.error('相似MV获取失败:', error)
    return []
  }
}

/** 网易云收藏的 MV */
export async function getNeteaseMvSublist(options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/mv/sublist?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data?.data || []
  } catch (error) {
    console.error('收藏MV获取失败:', error)
    return []
  }
}

/** 网易云收藏/取消收藏 MV */
export async function subscribeNeteaseMV(mvid: number | string, subscribe: boolean = true, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/mv/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mvid: String(mvid), subscribe, cookie })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '收藏MV失败')
    return data
  } catch (error) {
    console.error('收藏MV失败:', error)
    throw error
  }
}

/** 网易云全部排行榜列表 */
export async function getNeteaseToplistDetail(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/toplist/detail`)
    const data = await response.json()
    return data?.list || []
  } catch (error) {
    console.error('排行榜列表获取失败:', error)
    return []
  }
}

/** 网易云指定榜单完整歌曲（榜单即歌单） */
export async function getNeteaseToplistSongs(id: number | string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/toplist/songs?id=${encodeURIComponent(String(id))}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('榜单歌曲获取失败:', error)
    return null
  }
}

/** 网易云私人FM 不再播放（垃圾桶） */
export async function neteaseFmTrash(id: number | string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/fm/trash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id), cookie })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '操作失败')
    return data
  } catch (error) {
    console.error('FM垃圾桶操作失败:', error)
    return null
  }
}

/** 网易云每日推荐不感兴趣 */
export async function neteaseRecommendDislike(id: number | string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/recommend/dislike`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: String(id), cookie })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '操作失败')
    return data
  } catch (error) {
    console.error('日推不感兴趣失败:', error)
    return null
  }
}

/** 网易云 VIP 信息 */
export async function getNeteaseVipInfo(options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/vip/info?cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('VIP信息获取失败:', error)
    return null
  }
}

/** 网易云关注动态 */
export async function getNeteaseFollowingEvents(options: { cookie?: string; pagesize?: number; lasttime?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/event/following?pagesize=${Number(options.pagesize) || 20}&lasttime=${Number(options.lasttime) || -1}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('关注动态获取失败:', error)
    return null
  }
}

/** 网易云用户动态 */
export async function getNeteaseUserEvents(uid: number | string, options: { cookie?: string; lasttime?: number; limit?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/event/user?uid=${encodeURIComponent(String(uid))}&lasttime=${Number(options.lasttime) || -1}&limit=${Number(options.limit) || 30}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('用户动态获取失败:', error)
    return null
  }
}

/** 网易云通知消息 */
export async function getNeteaseNotices(options: { cookie?: string; limit?: number; lasttime?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/msg/notices?limit=${Number(options.limit) || 30}&lasttime=${Number(options.lasttime) || -1}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('通知消息获取失败:', error)
    return null
  }
}

/** 网易云评论消息 */
export async function getNeteaseCommentMessages(uid: number | string, options: { cookie?: string; limit?: number; before?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/msg/comments?uid=${encodeURIComponent(String(uid))}&limit=${Number(options.limit) || 30}&before=${Number(options.before) || -1}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('评论消息获取失败:', error)
    return null
  }
}

/** 网易云云盘歌曲列表 */
export async function getNeteaseCloudSongs(options: { cookie?: string; limit?: number; offset?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/cloud/list?limit=${Number(options.limit) || 30}&offset=${Number(options.offset) || 0}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('云盘列表获取失败:', error)
    return null
  }
}

/** 网易云云盘歌曲播放链接 */
export async function getNeteaseCloudSongUrl(id: number | string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/cloud/url?id=${encodeURIComponent(String(id))}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('云盘歌曲链接获取失败:', error)
    return null
  }
}

/** 网易云订阅/取消订阅电台 */
export async function subscribeNeteaseDj(rid: number | string, subscribe: boolean = true, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/dj/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rid: String(rid), subscribe, cookie })
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '订阅电台失败')
    return data
  } catch (error) {
    console.error('订阅电台失败:', error)
    return null
  }
}

/** 网易云订阅电台列表 */
export async function getNeteaseDjSublist(options: { cookie?: string; limit?: number; offset?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/dj/sublist?limit=${Number(options.limit) || 30}&offset=${Number(options.offset) || 0}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('订阅电台列表获取失败:', error)
    return null
  }
}

/** QQ 歌曲关联 MV */
export async function getQQSongMV(songId: number | string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/song/mv?id=${encodeURIComponent(String(songId))}`)
    const data = await response.json()
    return data?.data || null
  } catch (error) {
    console.error('QQ歌曲关联MV获取失败:', error)
    return null
  }
}

/** QQ MV 点赞/取消 */
export async function likeQQMV(id: number | string, like: boolean = true): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq')
    const response = await fetch(`${API_BASE}/qq/mv/like?id=${encodeURIComponent(String(id))}&type=${like ? 1 : 0}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data
  } catch (error) {
    console.error('QQ MV点赞失败:', error)
    return null
  }
}

/** QQ 歌手分类 */
export async function getQQArtistCategory(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/qq/artist/category`)
    const data = await response.json()
    return data?.data || null
  } catch (error) {
    console.error('QQ歌手分类获取失败:', error)
    return null
  }
}

/** QQ 歌手列表 */
export async function getQQArtistList(params: { type?: number; area?: number; sex?: number; genre?: number; pageNo?: number; pageSize?: number } = {}): Promise<any> {
  try {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => { if (v != null) q.set(k, String(v)) })
    const response = await fetch(`${API_BASE}/qq/artist/list?${q}`)
    const data = await response.json()
    return data?.data || null
  } catch (error) {
    console.error('QQ歌手列表获取失败:', error)
    return null
  }
}

/** 网易云电台推荐 */
export async function getNeteaseDjRecommend(): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/dj/recommend`)
    const data = await response.json()
    return data || null
  } catch (error) {
    console.error('电台推荐获取失败:', error)
    return null
  }
}

/** QQ 听 [歌曲] 的也在听（相似 + 同歌手热门 15 首） */
export async function getQQListenAlso(songid: number | string, singermid?: string): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq')
    const response = await fetch(`${API_BASE}/qq/song/listen-also?songid=${encodeURIComponent(String(songid))}${singermid ? `&singermid=${encodeURIComponent(singermid)}` : ''}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data?.data?.songs || []
  } catch (error) {
    console.error('也在听获取失败:', error)
    return []
  }
}

/** QQ 喜欢 [歌曲] 的人也爱它们（相关歌单 6 个，offset 换一批） */
export async function getQQLikeAlso(songid: number | string, offset: number = 0): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq')
    const response = await fetch(`${API_BASE}/qq/song/like-also?songid=${encodeURIComponent(String(songid))}&offset=${offset}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data?.data?.playlists || []
  } catch (error) {
    console.error('也爱歌单获取失败:', error)
    return []
  }
}

/** 网易云「喜欢这首歌的人也爱听」（相似歌曲，需登录） */
export async function getNeteaseSimiSong(id: number | string, limit: number = 10): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease')
    const response = await fetch(`${API_BASE}/netease/song/simi?id=${encodeURIComponent(String(id))}&limit=${limit}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data?.songs || []
  } catch (error) {
    console.error('网易云也爱听获取失败:', error)
    return []
  }
}

/** 网易云「相关歌单」（包含此歌曲的歌单，需登录） */
export async function getNeteaseRelatedPlaylist(id: number | string): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease')
    const response = await fetch(`${API_BASE}/netease/song/related-playlist?id=${encodeURIComponent(String(id))}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    return data?.playlists || []
  } catch (error) {
    console.error('网易云相关歌单获取失败:', error)
    return []
  }
}

/** 获取网易云用户详情（公开，可查任意用户） */
export async function getUserDetail(uid: string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/user/detail?uid=${encodeURIComponent(uid)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取用户详情失败')
    return data
  } catch (error) {
    console.error('用户详情获取失败:', error)
    return null
  }
}

/** 获取网易云用户歌单（公开，可查任意用户） */
export async function getUserPlaylistList(uid: string): Promise<any> {
  try {
    const response = await fetch(`${API_BASE}/netease/user/playlist?uid=${encodeURIComponent(uid)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取用户歌单失败')
    return data
  } catch (error) {
    console.error('用户歌单获取失败:', error)
    return null
  }
}

/** QQ 关注用户列表（music.concern.RelationList/GetFollowList） */
export async function getQQFollows(options: { cookie?: string; start?: number; num?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const start = options.start ?? 0
    const num = options.num ?? 30
    const response = await fetch(`${API_BASE}/qq/user/follows?start=${start}&num=${num}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取关注列表失败')
    return data
  } catch (error) {
    console.error('QQ关注列表获取失败:', error)
    return null
  }
}

/** QQ 粉丝列表（music.concern.RelationList/GetFansList） */
export async function getQQFans(options: { cookie?: string; start?: number; num?: number } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const start = options.start ?? 0
    const num = options.num ?? 30
    const response = await fetch(`${API_BASE}/qq/user/fans?start=${start}&num=${num}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取粉丝列表失败')
    return data
  } catch (error) {
    console.error('QQ粉丝列表获取失败:', error)
    return null
  }
}

/** QQ 用户主页（按 EncUin 查资料/关注/粉丝数 + 关注/粉丝列表，支持查看他人） */
export async function getQQUserProfile(encUin: string, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const response = await fetch(`${API_BASE}/qq/user/profile?encUin=${encodeURIComponent(encUin)}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取用户主页失败')
    return data
  } catch (error) {
    console.error('QQ用户主页获取失败:', error)
    return null
  }
}

/** QQ 用户我喜欢列表（music.favor_system_read/get_favor_list_byid，EncUin 支持查看他人） */
export async function getQQUserFavs(encUin: string, favType: number = 1, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const response = await fetch(`${API_BASE}/qq/user/favs?encUin=${encodeURIComponent(encUin)}&favType=${favType}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取我喜欢失败')
    return data
  } catch (error) {
    console.error('QQ我喜欢获取失败:', error)
    return null
  }
}

/** QQ 关注/取关用户（EncUin） */
export async function subscribeQQUser(encUin: string, subscribe: boolean, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('qq', options.cookie)
    const response = await fetch(`${API_BASE}/qq/user/subscribe?encUin=${encodeURIComponent(encUin)}&subscribe=${subscribe}&cookie=${encodeURIComponent(cookie)}`, { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '关注操作失败')
    return data
  } catch (error) {
    console.error('QQ关注用户失败:', error)
    return null
  }
}

/** 网易云关注/取关用户 */
export async function subscribeNeteaseUser(id: string, subscribe: boolean, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/user/subscribe?id=${encodeURIComponent(id)}&subscribe=${subscribe}&cookie=${encodeURIComponent(cookie)}`, { method: 'POST' })
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '关注操作失败')
    return data
  } catch (error) {
    console.error('网易云关注用户失败:', error)
    return null
  }
}

/** 获取网易云听歌排行（type=0 所有, type=1 周排行） */
export async function getUserRecordRank(uid: string, type: 0 | 1 = 0, options: { cookie?: string } = {}): Promise<any> {
  try {
    const cookie = getPlatformCookie('netease', options.cookie)
    const response = await fetch(`${API_BASE}/netease/record/rank/${type}?uid=${uid}&cookie=${encodeURIComponent(cookie)}`)
    const data = await response.json()
    if (!response.ok) throw new Error(data?.error || '获取听歌排行失败')
    return data
  } catch (error) {
    console.error('听歌排行获取失败:', error)
    return null
  }
}






