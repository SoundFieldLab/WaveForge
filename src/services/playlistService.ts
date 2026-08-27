import type { MusicPlatform } from './platforms'
import { platformLabel } from './platforms'
/**
 * 歌单服务
 */

import { indexedDBCache } from './indexedDBCache'
import { getAppleLibrarySongs } from './appleCatalog'
import { isQQFallbackDisplayName } from '../utils/qqUser'

export interface PlaylistOptions {
  forceRefresh?: boolean
  skipCache?: boolean
}

const API_BASE = 'http://localhost:3001/api'
const userPlaylistsCache = new Map<string, any[]>()
const userPlaylistsPending = new Map<string, Promise<any[]>>()
const MAX_USER_PLAYLIST_CACHE_ENTRIES = 16
const USER_PLAYLIST_CACHE_VERSION = 'v5-like-username'
let cacheGeneration = 0

async function fetchWithTimeout(url: string, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    window.clearTimeout(timeoutId)
  }
}

async function withPlaylistTimeout<T>(request: Promise<T>, timeoutMs = 22_000): Promise<T> {
  let timeoutId = 0
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timeoutId = window.setTimeout(() => reject(new Error('用户歌单加载超时')), timeoutMs)
      })
    ])
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId)
  }
}

function fingerprint(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function cacheUserPlaylists(key: string, playlists: any[]): void {
  userPlaylistsCache.delete(key)
  userPlaylistsCache.set(key, playlists)
  while (userPlaylistsCache.size > MAX_USER_PLAYLIST_CACHE_ENTRIES) {
    const oldestKey = userPlaylistsCache.keys().next().value
    if (oldestKey === undefined) break
    userPlaylistsCache.delete(oldestKey)
  }
}

function getPlatformCookie(platform: MusicPlatform, explicitCookie?: string): string {
  if (explicitCookie) return explicitCookie
  return platform === 'qq'
    ? localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
    : localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
}

function normalizeQQCover(value?: string): string {
  if (!value) return ''
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('http://')) return `https://${value.slice(7)}`
  return value
}

function getQQSongCover(song: any): string {
  const directCover = normalizeQQCover(
    song?.album?.picUrl ||
    song?.picUrl ||
    song?.albumpic ||
    song?.albumPic ||
    song?.cover
  )
  if (directCover) return directCover

  const albumMid = song?.album?.mid || song?.album?.pmid || song?.albummid || song?.albumMid
  return albumMid
    ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg?max_age=2592000`
    : ''
}

function getQQLikedPlaylistName(username?: string): string {
  const displayName = String(username || localStorage.getItem('qq_username') || '').trim()
  return isQQFallbackDisplayName(displayName) ? '我喜欢的音乐' : displayName + '喜欢的音乐'
}

function normalizeCachedQQPlaylistNames(playlists: any[], username?: string): any[] {
  if (!Array.isArray(playlists)) return playlists
  const likedName = getQQLikedPlaylistName(username)
  return playlists.map(playlist => (
    playlist?.platform === 'qq' && playlist.isLike
      ? { ...playlist, name: likedName }
      : playlist
  ))
}

function isQQLikedPlaylist(item: any): boolean {
  const name = String(item?.diss_name || item?.title || item?.dissname || '').trim()
  const dirId = String(item?.dirid ?? item?.dirId ?? '')
  return dirId === '201' || name === '我喜欢' || name === '我喜欢的音乐' || name.endsWith('喜欢的音乐')
}

/**
 * 用户歌单结果是否值得缓存：
 * - 空列表视为获取异常（QQ 接口吞错返回空、本地服务刚启动未就绪等），不缓存，
 *   否则冷启动会一直吃到上一次失败留下的空缓存，直到用户手动刷新才恢复。
 * - QQ 登录用户必有系统歌单「我喜欢」(isLike)，缺它的列表视为不完整
 *   （disslist 偶发不含 dirid=201 且服务端 user/detail 兜底失败），同样不缓存。
 */
function isCacheableUserPlaylists(platform: MusicPlatform, playlists: any[] | undefined): boolean {
  if (!Array.isArray(playlists) || playlists.length === 0) return false
  return platform !== 'qq' || playlists.some(playlist => Boolean(playlist?.isLike))
}

function getUserPlaylistsCacheKey(platform: MusicPlatform, userId: string): string {
  const cookie = getPlatformCookie(platform)
  const devMode = platform === 'qq' ? localStorage.getItem('developerMode') === 'true' : false
  return `${USER_PLAYLIST_CACHE_VERSION}:${platform}:${userId.trim()}:${devMode ? 'dev' : 'prod'}:${fingerprint(cookie)}`
}

export function getCachedUserPlaylists(
  platform: MusicPlatform,
  userId: string
): any[] | undefined {
  if (!userId.trim()) return undefined
  const cached = userPlaylistsCache.get(getUserPlaylistsCacheKey(platform, userId))
  // 空/不完整（QQ 缺「我喜欢」）的缓存视为无效，让调用方重新拉取
  if (!cached || !isCacheableUserPlaylists(platform, cached)) return undefined
  return platform === 'qq' ? normalizeCachedQQPlaylistNames(cached) : cached
}

export function invalidateUserPlaylistsCache(
  platform: MusicPlatform,
  userId: string
): void {
  if (!userId.trim()) return
  const key = getUserPlaylistsCacheKey(platform, userId)
  userPlaylistsCache.delete(key)
  void indexedDBCache.invalidatePlaylist(key, platform)
    .catch(error => console.warn('使持久化歌单缓存失效失败:', error))
}

export function updateCachedUserPlaylists(
  platform: MusicPlatform,
  userId: string,
  updater: (playlists: any[]) => any[]
): void {
  if (!userId.trim()) return
  const key = getUserPlaylistsCacheKey(platform, userId)
  const cached = userPlaylistsCache.get(key)
  if (!cached) return

  const updated = updater(cached.map(playlist => ({ ...playlist })))
  const normalized = platform === 'qq' ? normalizeCachedQQPlaylistNames(updated) : updated
  cacheUserPlaylists(key, normalized)
  void indexedDBCache.cachePlaylist(key, platform, normalized)
    .catch(error => console.warn('同步持久化歌单缓存失败:', error))
}

export function clearUserPlaylistsMemoryCache(): void {
  cacheGeneration += 1
  userPlaylistsCache.clear()
  userPlaylistsPending.clear()
}

/**
 * 从服务器获取用户歌单列表
 */
async function fetchUserPlaylists(
  platform: MusicPlatform,
  userId: string,
  username?: string
): Promise<any[]> {
  console.log('🌐 从服务器获取用户歌单列表')
  
  // Spotify：我的歌单（token 驱动，无需 userId）
  if (platform === 'spotify') {
    const { fetchSpotifyMyPlaylists } = await import('./spotifyService')
    const playlists = await fetchSpotifyMyPlaylists(50)
    return playlists.map(p => ({
      id: p.id,
      name: p.name,
      coverImgUrl: p.coverUrl || '',
      trackCount: 0,
      platform: 'spotify',
    }))
  }
  // 酷狗：用户歌单（需登录 cookie，经代理）
  if (platform === 'kugou') {
    const { fetchKugouUserPlaylists } = await import('./kugouService')
    const playlists = await fetchKugouUserPlaylists()
    return playlists.map(p => ({
      id: p.specialid,
      name: p.name,
      coverImgUrl: p.coverUrl || '',
      trackCount: p.songcount || 0,
      playCount: p.playcount || 0,
      platform: 'kugou',
    }))
  }
  // 汽水：抖音歌单网关（首项为「汽水我的喜欢」虚拟歌单，isLikedLike 标记；collected 标记收藏的他人歌单）
  if (platform === 'soda') {
    const { fetchSodaUserPlaylists } = await import('./sodaService')
    const playlists = await fetchSodaUserPlaylists()
    // 未登录/接口失败时返回空数组，与酷狗分支一致（不报错）
    const sodaUid = localStorage.getItem('soda_user_id') || ''
    return playlists.map(p => ({
      id: p.id,
      name: p.name,
      coverImgUrl: p.coverUrl || '',
      trackCount: p.trackCount || 0,
      platform: 'soda',
      // 自建歌单归属当前用户，收藏歌单无 userId——对齐 QQ 分支的字段约定
      userId: p.collected ? undefined : sodaUid,
      isLike: Boolean(p.isLikedLike),
      isCollected: Boolean(p.collected),
    }))
  }
  if (!userId.trim()) return []
  
  // 获取 cookie（如果有）
  const cookie = platform === 'qq' 
    ? localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
    : localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
  const firstArray = (...values: any[]) => values.find(value => Array.isArray(value)) || []
  
  if (platform === 'netease') {
    const url = `http://localhost:3001/api/netease/user/playlist?uid=${userId}${cookie ? `&cookie=${encodeURIComponent(cookie)}` : ''}`
    const response = await fetchWithTimeout(url)
    if (!response.ok) {
      throw new Error(`获取网易云歌单失败（HTTP ${response.status}）`)
    }
    const data = await response.json()
    if (data.error) {
      throw new Error(data.error)
    }

    return (Array.isArray(data.playlist) ? data.playlist : []).map((playlist: any) => ({
      ...playlist,
      id: playlist.id?.toString(),
      name: playlist.name || '未命名歌单',
      trackCount: Number(playlist.trackCount ?? playlist.trackNumber ?? 0),
      platform: 'netease',
      isLike: playlist.specialType === 5 || playlist.name === '我喜欢的音乐',
      isCollected: playlist.userId?.toString() !== userId.toString()
    }))
  } else {
    // QQ 音乐：获取自建 + 收藏歌单
    const displayUsername = username || localStorage.getItem('qq_username') || ''
    let allPlaylists: any[] = []
    
    // 1. 获取自建歌单
    try {
      const devMode = localStorage.getItem('developerMode') === 'true'
      const url = `http://localhost:3001/api/qq/user/playlist?id=${userId}&cookie=${encodeURIComponent(cookie)}&devMode=${devMode}`
      const response = await fetchWithTimeout(url)
      const createdData = await response.json()
      
      const createdList = firstArray(
        createdData.list,
        createdData.data?.list,
        createdData.mydiss?.list,
        createdData.data?.mydiss?.list
      )

      if (createdList.length > 0) {
        const createdPlaylists = createdList
          .filter((item: any) => {
            const name = item.diss_name || item.title || item.dissname
            return name !== 'QZone背景音乐' && name !== '本地上传'
          })
          .map((item: any) => ({
            id: item.tid || item.dissid || item.disstid,
            dirId: item.dirid || item.dirId,
            name: item.diss_name || item.title || item.dissname,
            coverImgUrl: normalizeQQCover(item.diss_cover || item.picurl || item.logo),
            trackCount: item.song_cnt || item.songnum || parseInt(item.subtitle?.split('首')[0]) || 0,
            platform: 'qq',
            userId,
            isLike: isQQLikedPlaylist(item)
          }))
        
        allPlaylists.push(...createdPlaylists)
      }
    } catch (error) {
      console.error('❌ 获取QQ音乐自建歌单失败:', error)
    }
    
    // 2. 获取收藏歌单
    try {
      const devMode = localStorage.getItem('developerMode') === 'true'
      const url = `http://localhost:3001/api/qq/user/collect?id=${userId}&cookie=${encodeURIComponent(cookie)}&devMode=${devMode}`
      const response = await fetchWithTimeout(url)
      const collectedData = await response.json()
      
      const list = firstArray(
        collectedData.data?.list,
        collectedData.list,
        collectedData.data?.cdlist,
        collectedData.cdlist
      )
      if (Array.isArray(list)) {
        const collectedPlaylists = list
          .filter((item: any) => {
            const name = item.dissname || item.diss_name || item.title
            return name !== 'QZone背景音乐' && name !== '本地上传'
          })
          .map((item: any) => ({
            id: item.dissid || item.tid || item.disstid,
            name: item.dissname || item.diss_name || item.title,
            coverImgUrl: normalizeQQCover(item.logo || item.diss_cover || item.picurl),
            trackCount: item.songnum || item.song_cnt || 0,
            platform: 'qq',
            isCollected: true
          }))
        
        allPlaylists.push(...collectedPlaylists)
      }
    } catch (error) {
      console.warn('⚠️ 获取收藏歌单失败，仅显示自建歌单:', error)
    }
    
    // 兜底：QQ 接口偶发返回空 id（tid/dissid 缺失），统一补成非空唯一字符串，
    // 避免列表渲染出现重复空 key 导致节点重复创建、无法复用
    allPlaylists = allPlaylists.map((playlist, index) => ({
      ...playlist,
      id: playlist.id === 0 || playlist.id ? String(playlist.id) : `qq-playlist-${index}`
    }))

    // 去重
    const uniquePlaylists = Array.from(
      new Map(allPlaylists.map(item => [item.id, item])).values()
    )
    
    // 处理"我喜欢"歌单
    const likeIndex = uniquePlaylists.findIndex(p => p.isLike)
    if (likeIndex !== -1) {
      const likePlaylist = uniquePlaylists[likeIndex]
      uniquePlaylists.splice(likeIndex, 1)
      
      // 修改名称
      likePlaylist.name = getQQLikedPlaylistName(displayUsername)
      
      // “我喜欢”是 dirId=201 的系统歌单，QQ 返回的歌单封面是默认爱心图。
      // 按该歌单当前排序读取第一首歌曲，并用其歌曲/专辑封面替换默认图。
      try {
        const likedListUrl = `${API_BASE}/qq/likelist?uid=${encodeURIComponent(userId)}&playlistId=${encodeURIComponent(likePlaylist.id || '')}&cookie=${encodeURIComponent(cookie)}`
        const likedListRes = await fetchWithTimeout(likedListUrl)
        if (!likedListRes.ok) throw new Error(`HTTP ${likedListRes.status}`)
        const likedListData = await likedListRes.json()
        const normalizedCover = normalizeQQCover(likedListData.coverImgUrl) || getQQSongCover(likedListData.firstSong)
        if (normalizedCover) {
          likePlaylist.coverImgUrl = normalizedCover
        }

        const firstMid = Array.isArray(likedListData.mids) ? likedListData.mids.find(Boolean) : ''
        if (!normalizedCover && firstMid) {
          const songDetailRes = await fetchWithTimeout(
            `${API_BASE}/qq/song/detail?mid=${encodeURIComponent(firstMid)}&cookie=${encodeURIComponent(cookie)}`
          )
          if (!songDetailRes.ok) throw new Error(`HTTP ${songDetailRes.status}`)
          const songDetailData = await songDetailRes.json()
          const firstSong = songDetailData.song || songDetailData.data?.song || songDetailData.data || songDetailData
          const firstSongCover = getQQSongCover(firstSong)
          if (firstSongCover) {
            likePlaylist.coverImgUrl = firstSongCover
          }
        }
      } catch (error) {
        console.error('❌ 获取我喜欢歌单详情失败:', error)
      }
      
      // 放到第一个
      uniquePlaylists.unshift(likePlaylist)
    }
    
    console.log(`✅ 解析到 ${uniquePlaylists.length} 个QQ音乐歌单`)
    
    return uniquePlaylists
  }
}

/**
 * 获取用户歌单列表。
 * 同一次软件运行期间默认复用已加载的数据；主动刷新时传 forceRefresh。
 */
export async function getUserPlaylists(
  platform: MusicPlatform,
  userId: string,
  username?: string,
  options: PlaylistOptions = {}
): Promise<any[]> {
  // Spotify 用 token、汽水用本地 cookie（soda_token）拉歌单，均不依赖 userId；其余平台需要 userId。
  // 注意：探索页汽水侧栏以空 userId 调用本函数（fetchUserPlaylists 的 soda 分支只认 cookie），
  // 不能在这里被 userId 门禁短路，否则汽水歌单列表永远为空。
  if (platform !== 'spotify' && platform !== 'soda' && !userId.trim()) return []
  const cacheKey = getUserPlaylistsCacheKey(platform, userId)
  const bypassCache = options.forceRefresh || options.skipCache
  const requestGeneration = cacheGeneration

  if (!bypassCache) {
    const cached = userPlaylistsCache.get(cacheKey)
    if (cached && isCacheableUserPlaylists(platform, cached)) {
      return platform === 'qq' ? normalizeCachedQQPlaylistNames(cached, username) : cached
    }

    const pending = userPlaylistsPending.get(cacheKey)
    if (pending) return pending
  }

  const request = (async () => {
    if (!bypassCache) {
      try {
        const persisted = await indexedDBCache.getCachedPlaylist<any[]>(cacheKey, platform)
        if (persisted && isCacheableUserPlaylists(platform, persisted)) {
          const normalizedPersisted = platform === 'qq' ? normalizeCachedQQPlaylistNames(persisted, username) : persisted
          if (requestGeneration === cacheGeneration) cacheUserPlaylists(cacheKey, normalizedPersisted)
          return normalizedPersisted
        }
      } catch (error) {
        console.warn('读取持久化歌单缓存失败，将从服务器刷新:', error)
      }
    }

    let playlists = await withPlaylistTimeout(fetchUserPlaylists(platform, userId, username))
    // QQ 偶发返回空或缺「我喜欢」（disslist 缺 dirid=201 + 服务端兜底失败）：
    // 单次重试，避免启动时把异常结果直接缓存成常态
    if (platform === 'qq' && !isCacheableUserPlaylists(platform, playlists)) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 600))
      const retried = await withPlaylistTimeout(fetchUserPlaylists(platform, userId, username)).catch(() => undefined)
      if (retried && isCacheableUserPlaylists(platform, retried)) playlists = retried
    }
    const normalizedPlaylists = platform === 'qq' ? normalizeCachedQQPlaylistNames(playlists, username) : playlists
    if (!options.skipCache && requestGeneration === cacheGeneration && playlists && isCacheableUserPlaylists(platform, playlists)) {
      cacheUserPlaylists(cacheKey, normalizedPlaylists)
      try {
        await indexedDBCache.cachePlaylist(cacheKey, platform, normalizedPlaylists)
      } catch (error) {
        console.warn('写入持久化歌单缓存失败:', error)
      }
    }
    return normalizedPlaylists
  })()
  if (!options.skipCache) userPlaylistsPending.set(cacheKey, request)

  try {
    return await request
  } finally {
    if (userPlaylistsPending.get(cacheKey) === request) {
      userPlaylistsPending.delete(cacheKey)
    }
  }
}

/**
 * 获取歌单详情
 */
export async function getPlaylistDetail(
  playlistId: string,
  platform: MusicPlatform,
  options: PlaylistOptions = {}
): Promise<any> {
  console.log(`🌐 从服务器获取歌单详情: ${playlistId}`)
  const devMode = localStorage.getItem('developerMode') === 'true'
  // Spotify：官方 API 歌单详情（前端直连，含歌单名/封面）
  if (platform === 'spotify') {
    const { fetchSpotifyPlaylistDetail, spotifyTrackToSong } = await import('./spotifyService')
    const detail = await fetchSpotifyPlaylistDetail(playlistId)
    if (!detail) return { playlist: { id: playlistId, name: 'Spotify 歌单' }, tracks: [], privileges: {} }
    return {
      playlist: {
        id: detail.playlist.id,
        name: detail.playlist.name,
        coverImgUrl: detail.playlist.coverUrl || '',
        description: detail.playlist.description || '',
        owner: detail.playlist.owner,
      },
      tracks: detail.songs.map(s => spotifyTrackToSong(s)),
      privileges: { 1: true, 0: true },
    }
  }
  // 酷狗：本地代理歌单详情（尽力而为，失败返回空）
  if (platform === 'kugou') {
    const { fetchKugouPlaylistDetail, kugouTrackToSong } = await import('./kugouService')
    const tracks = await fetchKugouPlaylistDetail(playlistId)
    return {
      playlist: { id: playlistId, name: '酷狗歌单' },
      tracks: tracks.map(t => kugouTrackToSong(t)),
      privileges: { 1: true, 0: true },
    }
  }
  // 汽水音乐：抖音歌单曲目接口（支持 qishui-feed / qishui-liked / qishui-recent 虚拟歌单）。
  // 后端单页上限 50 条，这里分页合并全部曲目；接口失败时返回空歌单壳（不抛错）
  if (platform === 'soda') {
    const { fetchSodaPlaylistTracks } = await import('./sodaService')
    let allTracks: any[] = []
    const seenIds = new Set<string>()
    let name = ''
    let coverUrl = ''
    let trackCount = 0
    let offset = 0
    // 20 页 × 50 条封顶，防止异常数据导致超大循环；按曲目 id 去重兜底 offset 不生效的场景
    for (let page = 0; page < 20; page += 1) {
      const detail = await fetchSodaPlaylistTracks(playlistId, offset)
      if (!name && detail.name) name = detail.name
      if (!coverUrl && detail.coverUrl) coverUrl = detail.coverUrl
      if (detail.trackCount > trackCount) trackCount = detail.trackCount
      if (!Array.isArray(detail.tracks) || detail.tracks.length === 0) break
      for (const track of detail.tracks) {
        const key = String((track as any)?.mid || (track as any)?.id || '')
        if (key && seenIds.has(key)) continue
        if (key) seenIds.add(key)
        allTracks.push(track)
      }
      offset += detail.tracks.length
      if (!detail.hasMore || offset >= trackCount) break
    }
    return {
      playlist: {
        id: playlistId,
        name: name || '汽水歌单',
        coverImgUrl: coverUrl,
        trackCount: trackCount || allTracks.length,
        platform: 'soda',
      },
      tracks: allTracks,
      privileges: {},
    }
  }
  // Apple Music：目录/编辑歌单曲目（amp-api catalog playlists/{id}/tracks，需 Developer Token）
  if (platform === 'apple') {
    const { getAppleCatalogPlaylistTracks, getAppleCatalogPlaylistSummary, appleSongToSong } = await import('./appleCatalog')
    const summary = await getAppleCatalogPlaylistSummary(playlistId).catch(() => null)
    const tracks = await getAppleCatalogPlaylistTracks(playlistId).catch(() => [])
    return {
      playlist: {
        id: playlistId,
        name: summary?.name || `Apple Music 歌单（${tracks.length} 首）`,
        coverImgUrl: summary?.artworkUrl || undefined,
        description: summary?.description || undefined,
        creator: summary?.curatorName || 'Apple Music 编辑',
        trackCount: summary?.trackCount ?? tracks.length,
        platform: 'apple',
      },
      // 目录曲目已是 catalog id：播放节点保持 platform=apple（统一链路：原生→载体回退）
      tracks: tracks.map(song => appleSongToSong(song)),
      privileges: {},
    }
  }
  const url = platform === 'netease'
    ? `http://localhost:3001/api/netease/playlist/detail?id=${encodeURIComponent(playlistId)}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
    : `http://localhost:3001/api/qq/playlist/detail?id=${playlistId}&devMode=${devMode}&cookie=${encodeURIComponent(localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || '')}`
  
  const maxRetries = 3
  const retryDelay = 1000 // 1秒
  // QQ 大型歌单需要在本地服务中分页拉取完整曲目，给它更充足的时间。
  const timeout = 45000
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      return data
    } catch (error) {
      console.warn(`⚠️ 获取歌单失败 (${i + 1}/${maxRetries}):`, error)
      
      // 如果是最后一次重试，抛出错误
      if (i === maxRetries - 1) {
        throw new Error(`获取歌单详情失败: ${error}`)
      }
      
      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)))
    }
  }
  
  throw new Error('获取歌单详情失败')
}

export interface NeteasePlaylistTrackPage {
  playlist: any
  tracks: any[]
  offset: number
  limit: number
  nextOffset: number
  more: boolean
  total: number
}

export async function getNeteasePlaylistTrackPage(
  playlistId: string | number,
  offset = 0,
  limit = 120,
  signal?: AbortSignal
): Promise<NeteasePlaylistTrackPage> {
  const cookie = getPlatformCookie('netease')
  const url = `${API_BASE}/netease/playlist/detail?id=${encodeURIComponent(String(playlistId))}&offset=${Math.max(0, offset)}&limit=${Math.max(1, Math.min(limit, 500))}&cookie=${encodeURIComponent(cookie)}`
  const response = await fetch(url, { signal })
  const data = await response.json()
  if (!response.ok || data.error || !data.playlist) {
    throw new Error(data.error || `读取网易云歌单失败（HTTP ${response.status}）`)
  }
  const tracks = Array.isArray(data.playlist.tracks) ? data.playlist.tracks : []
  const total = Number(data.playlist.trackCount || tracks.length || 0)
  const nextOffset = Number(data.nextOffset ?? (offset + limit))
  return {
    playlist: data.playlist,
    tracks,
    offset: Number(data.offset ?? offset),
    limit: Number(data.limit ?? limit),
    nextOffset,
    more: data.more === true && nextOffset < total,
    total,
  }
}

export async function streamNeteasePlaylistTracks(
  playlistId: string | number,
  options: {
    signal?: AbortSignal
    firstPageSize?: number
    pageSize?: number
    onPage: (page: NeteasePlaylistTrackPage, firstPage: boolean) => void
  }
): Promise<void> {
  const firstPageSize = Math.max(20, Math.min(options.firstPageSize || 120, 200))
  const pageSize = Math.max(50, Math.min(options.pageSize || 200, 300))
  let offset = 0
  let firstPage = true

  while (!options.signal?.aborted) {
    const page = await getNeteasePlaylistTrackPage(
      playlistId,
      offset,
      firstPage ? firstPageSize : pageSize,
      options.signal
    )
    options.onPage(page, firstPage)
    if (!page.more || page.nextOffset <= offset) break
    offset = page.nextOffset
    firstPage = false
    // 让出一次渲染机会，避免几千首歌单连续合并时阻塞交互。
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
  }
}

/**
 * 获取我喜欢的音乐
 */
export async function getLikedSongs(
  userId: string,
  platform: MusicPlatform,
  options: PlaylistOptions = {}
): Promise<any> {
  console.log('🌐 从服务器获取我喜欢的音乐')
  // Apple：喜欢 = 音乐库歌曲（amp-api）；用 catalogId 与 UI 目录 id 对齐
  if (platform === 'apple') {
    const tracks = await getAppleLibrarySongs(500)
    return {
      ids: tracks.map(track => track.catalogId || track.id),
    }
  }
  // 汽水：喜欢列表 =「qishui-liked」虚拟歌单曲目；返回 ids 供喜欢状态比对（favoriteStatusService 消费）。
  // 后端单页上限 50 条，这里分页拉全量，保证超过一页的喜欢列表红心状态仍准确
  if (platform === 'soda') {
    const { fetchSodaPlaylistTracks } = await import('./sodaService')
    const ids = new Set<string>()
    let offset = 0
    // 与歌单详情一致：20 页 × 50 条封顶
    for (let page = 0; page < 20; page += 1) {
      const detail = await fetchSodaPlaylistTracks('qishui-liked', offset)
      if (!Array.isArray(detail.tracks) || detail.tracks.length === 0) break
      for (const track of detail.tracks) {
        const key = String((track as any)?.mid || (track as any)?.id || '').trim()
        if (key) ids.add(key)
      }
      offset += detail.tracks.length
      if (!detail.hasMore || offset >= detail.trackCount) break
    }
    return { ids: [...ids] }
  }
  // Spotify：官方 Saved Tracks（/v1/me/tracks，token 驱动与 userId 无关）；标识为 Spotify track id 字符串。
  // 用导出的 spotifyFetch 复用其 token 刷新逻辑；官方单页上限 50、next 为空即到底，20 页封顶防异常循环
  if (platform === 'spotify') {
    const { spotifyFetch } = await import('./spotifyService')
    const ids = new Set<string>()
    for (let offset = 0; offset < 20 * 50; offset += 50) {
      const page = await spotifyFetch(`/me/tracks?limit=50&offset=${offset}`)
      const items = Array.isArray(page?.items) ? page.items : []
      items.forEach((item: any) => {
        const trackId = String(item?.track?.id || '').trim()
        if (trackId) ids.add(trackId)
      })
      if (!page?.next || items.length < 50) break
    }
    return { ids: [...ids] }
  }
  // 酷狗：「喜欢」= 用户云歌单中的默认"我喜欢"列表。经本地代理的 H5 签名网关读取：
  // /api/kugou/user/playlist 拿列表 → /api/kugou/user/playlist/tracks 按 listid 分页拉曲目 hash。
  // 标识为 hash；搜索路径的 FileHash 常为大写而网关返回小写——两种大小写都入集合以便命中。
  if (platform === 'kugou') {
    const kgCookie = localStorage.getItem('kugou_cookie') || ''
    if (!kgCookie) return { ids: [] }
    const KG_API = 'http://localhost:3001/api/kugou'
    let favListId = ''
    try {
      const listResp = await fetch(`${KG_API}/user/playlist?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
      if (listResp.ok) {
        const playlists = await listResp.json()
        if (Array.isArray(playlists)) {
          // 与服务端 kugouLikeCheckHashes 同一匹配规则：按名字找"我喜欢"，找不到退第一个
          const fav = playlists.find((p: any) => /我喜欢|默认歌单/.test(String(p?.name || ''))) || playlists[0]
          favListId = String(fav?.specialid || '')
        }
      }
    } catch (error) {
      console.warn('[LikedSongs] 酷狗用户歌单获取失败:', error)
    }
    const ids = new Set<string>()
    if (favListId) {
      for (let page = 1; page <= 20; page += 1) {
        try {
          const resp = await fetch(
            `${KG_API}/user/playlist/tracks?listid=${encodeURIComponent(favListId)}&page=${page}&pagesize=50&cookie=${encodeURIComponent(kgCookie)}`,
            { cache: 'no-store' },
          )
          if (!resp.ok) break
          const json = await resp.json()
          const songs = Array.isArray(json?.songs) ? json.songs : []
          songs.forEach((item: any) => {
            const hash = String(item?.hash || '').trim()
            if (!hash) return
            ids.add(hash)
            ids.add(hash.toLowerCase())
          })
          if (songs.length < 50) break
        } catch {
          break
        }
      }
    }
    return { ids: [...ids] }
  }
  const cookie = getPlatformCookie(platform)
  const url = platform === 'netease'
    ? `${API_BASE}/netease/likelist?uid=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(cookie)}`
    : `${API_BASE}/qq/likelist?uid=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(cookie)}`
  
  const maxRetries = 3
  const retryDelay = 1000
  const timeout = 10000
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)
      
      const response = await fetch(url, { signal: controller.signal })
      clearTimeout(timeoutId)
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      
      const data = await response.json()
      return data
    } catch (error) {
      console.warn(`⚠️ 获取喜欢歌曲失败 (${i + 1}/${maxRetries}):`, error)
      
      if (i === maxRetries - 1) {
        throw new Error(`获取喜欢歌曲失败: ${error}`)
      }
      
      await new Promise(resolve => setTimeout(resolve, retryDelay * (i + 1)))
    }
  }
  
  throw new Error('获取喜欢歌曲失败')
}

/**
 * 红心歌曲（喜欢）
 */
export async function likeSong(
  songId: string,
  userId: string,
  platform: MusicPlatform,
  like: boolean = true,
  options: { songMid?: string; songType?: number; cookie?: string } = {}
): Promise<any> {
  console.log(`${like ? '❤️' : '💔'} ${like ? '喜欢' : '取消喜欢'}歌曲: ${songId}`)

  // Spotify：官方 API 前端直连（songMid 为 Spotify track id）
  if (platform === 'spotify') {
    const { likeSpotifyTracks } = await import('./spotifyService')
    const trackId = options.songMid || songId
    const ok = await likeSpotifyTracks([trackId], like)
    if (!ok) throw new Error('Spotify 喜欢操作失败（token 失效或网络异常）')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 200, platform: 'spotify' }
  }
  // 酷狗：H5 签名网关喜欢（hash 为歌曲标识）
  if (platform === 'kugou') {
    const { likeKugouSong } = await import('./kugouService')
    const ok = await likeKugouSong({ hash: options.songMid || songId, name: '', artists: [] }, like)
    if (!ok) throw new Error('酷狗喜欢操作失败')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 100, platform: 'kugou' }
  }
  // 汽水：抖音喜欢接口（标识为汽水原始曲目 id，songMid 优先；返回形状与酷狗一致）
  if (platform === 'soda') {
    const { setSodaTrackLiked } = await import('./sodaService')
    const ok = await setSodaTrackLiked(String(options.songMid || songId), like)
    if (!ok) throw new Error('汽水音乐喜欢操作失败')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 100, platform: 'soda' }
  }

  const response = await fetch(`${API_BASE}/${platform}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: songId,
      mid: options.songMid,
      songType: options.songType,
      like,
      userId,
      cookie: getPlatformCookie(platform, options.cookie)
    })
  })
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || data.message || `喜欢操作失败（HTTP ${response.status}）`)
  }
  if (platform === 'netease' && Number(data.code) !== 200) {
    throw new Error(data.error || data.message || `网易云音乐喜欢操作失败（code ${data.code ?? 'unknown'}）`)
  }
  if (platform === 'qq' && Number(data.result) !== 100) {
    throw new Error(data.error || data.message || `QQ 音乐喜欢操作失败（result ${data.result ?? 'unknown'}）`)
  }

  invalidateUserPlaylistsCache(platform, userId)
  
  return data
}

/**
 * 添加歌曲到歌单
 */
export async function addSongToPlaylist(
  playlistId: string,
  songId: string,
  userId: string,
  platform: MusicPlatform,
  options: { songMid?: string; songType?: number; cookie?: string } = {}
): Promise<any> {
  console.log(`➕ 添加歌曲 ${songId} 到歌单 ${playlistId}`)

  // Spotify：官方 API 前端直连
  if (platform === 'spotify') {
    const { addTracksToSpotifyPlaylist } = await import('./spotifyService')
    const trackId = options.songMid || songId
    const ok = await addTracksToSpotifyPlaylist(playlistId, [trackId])
    if (!ok) throw new Error('Spotify 添加歌曲失败（token 失效或网络异常）')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 200, platform: 'spotify' }
  }
  // 酷狗：H5 签名网关加歌
  if (platform === 'kugou') {
    const { addKugouSongToPlaylist } = await import('./kugouService')
    const ok = await addKugouSongToPlaylist(playlistId, { hash: options.songMid || songId, name: '', artists: [] })
    if (!ok) throw new Error('酷狗加歌失败')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 100, platform: 'kugou' }
  }
  // 汽水：抖音加歌接口（后端按 song.id 补全资料；与酷狗一致传最小桩对象，songMid 优先）
  if (platform === 'soda') {
    const { addSodaSongToPlaylist } = await import('./sodaService')
    const ok = await addSodaSongToPlaylist(playlistId, {
      id: Number(songId) || 0,
      mid: options.songMid || songId,
      name: '',
      artists: [],
      album: { name: '', picUrl: '' },
      duration: 0,
    })
    if (!ok) throw new Error('汽水音乐添加歌曲失败')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 100, platform: 'soda' }
  }

  const url = platform === 'netease'
    ? `http://localhost:3001/api/netease/playlist/tracks`
    : `http://localhost:3001/api/qq/playlist/tracks`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'add',
      pid: playlistId,
      tracks: songId,
      mid: options.songMid,
      songType: options.songType,
      cookie: getPlatformCookie(platform, options.cookie),
    }),
  })
  
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || data.message || `添加到歌单失败（HTTP ${response.status}）`)
  }
  if (platform === 'netease' && Number(data.code) !== 200) {
    throw new Error(data.error || data.message || data.msg || `网易云音乐添加歌曲失败（code ${data.code ?? 'unknown'}）`)
  }
  if (platform === 'qq' && Number(data.result) !== 100) {
    throw new Error(data.error || data.message || data.msg || `QQ 音乐添加歌曲失败（result ${data.result ?? 'unknown'}）`)
  }
  
  return data
}

/**
 * 从歌单删除歌曲。
 *
 * 入参契约（owner 归属校验在视图层完成后传入，本服务不重复校验）：
 * - platform 必须与 playlistId 同平台；userId 为该平台当前登录用户的归属 id，
 *   仅用于写成功后失效用户歌单缓存（spotify/soda/kugou 分支不依赖），不参与上游鉴权。
 * - options.songMid：spotify=Spotify track id；netease/qq 走 op:'del' 时可选。
 *
 * 平台能力现状（写通道按平台自查，禁止互相套用）：
 * - netease/qq：本地代理 /playlist/tracks op:'del'；
 * - spotify：官方 API DELETE /playlists/{id}/tracks；
 * - 汽水：上游仅提供 me/playlist/media/append 加歌，不存在「从歌单移除单曲」的
 *   media/delete 类端点 → 直接抛错（调用方 toast 明示是上游未提供能力）；
 * - 酷狗：H5 网关只有 /v6/add_song 加歌，无删除端点 → 同样直接抛错。
 */
export async function removeSongFromPlaylist(
  playlistId: string,
  songId: string,
  userId: string,
  platform: MusicPlatform,
  options: { songMid?: string; songType?: number; cookie?: string } = {}
): Promise<any> {
  console.log(`➖ 从歌单 ${playlistId} 删除歌曲 ${songId}`)

  // Spotify：官方 API 前端直连
  if (platform === 'spotify') {
    const { removeTracksFromSpotifyPlaylist } = await import('./spotifyService')
    const trackId = options.songMid || songId
    const ok = await removeTracksFromSpotifyPlaylist(playlistId, [trackId])
    if (!ok) throw new Error('Spotify 删除歌曲失败（token 失效或网络异常）')
    invalidateUserPlaylistsCache(platform, userId)
    return { result: 200, platform: 'spotify' }
  }
  // 汽水：上游不存在移除歌曲端点（已核实 qishui-api.mjs 仅有 add-song 写通道），
  // 抛出明确错误由调用方 toast 提示，不做静默伪装
  if (platform === 'soda') {
    throw new Error('汽水音乐暂不支持从歌单移除歌曲：上游未提供移除歌曲的接口')
  }
  // 酷狗：网关无删除歌曲端点（/api/kugou/playlist/tracks 非 add 直接 400），诚实报错而非误打 QQ 删除接口
  if (platform === 'kugou') {
    throw new Error('酷狗音乐暂不支持从歌单移除歌曲：上游未提供移除歌曲的接口')
  }

  const url = platform === 'netease'
    ? `http://localhost:3001/api/netease/playlist/tracks`
    : `http://localhost:3001/api/qq/playlist/tracks`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      op: 'del',
      pid: playlistId,
      tracks: songId,
      mid: options.songMid,
      songType: options.songType,
      cookie: getPlatformCookie(platform, options.cookie),
    }),
  })
  
  const data = await response.json()
  if (!response.ok) {
    throw new Error(data.error || data.message || `从歌单删除歌曲失败（HTTP ${response.status}）`)
  }
  
  return data
}

/**
 * 手动刷新歌单（用于用户主动刷新）
 */
export async function refreshPlaylist(
  playlistId: string,
  platform: MusicPlatform
): Promise<any> {
  console.log(`🔄 手动刷新歌单: ${playlistId}`)
  return getPlaylistDetail(playlistId, platform, { forceRefresh: true })
}

/**
 * 手动刷新我喜欢的音乐
 */
export async function refreshLikedSongs(
  userId: string,
  platform: MusicPlatform
): Promise<any> {
  console.log('🔄 手动刷新我喜欢的音乐')
  return getLikedSongs(userId, platform, { forceRefresh: true })
}
/**
 * 创建歌单
 */
export async function createPlaylist(
  name: string,
  platform: MusicPlatform = 'netease',
  options: {
    privacy?: string
    type?: string
    cookie?: string
  } = {}
): Promise<any> {
  console.log(`🎵 创建歌单: ${name}`)

  // Spotify：官方 API 前端直连
  if (platform === 'spotify') {
    const { createSpotifyPlaylist } = await import('./spotifyService')
    const id = await createSpotifyPlaylist(name, options.type === 'NORMAL' ? '' : '', options.privacy === '1' ? false : true)
    if (!id) throw new Error('Spotify 创建歌单失败（token 失效或网络异常）')
    invalidateUserPlaylistsCache(platform, '')
    return { id, result: 200, platform: 'spotify' }
  }
  // 汽水：上游不存在创建歌单端点（已核实），抛出明确错误由调用方 toast 提示（不 crash）
  if (platform === 'soda') {
    throw new Error('汽水音乐暂不支持创建歌单：上游未提供创建歌单的接口')
  }
  // 酷狗：无创建歌单网关（platforms.ts 能力表即 false）；诚实拦截，
  // 否则会按下方默认分支误打网易创建接口、在错误平台落地一个真歌单
  if (platform === 'kugou') {
    throw new Error('酷狗音乐暂不支持创建歌单：上游未提供创建歌单的接口')
  }

  const cookie = getPlatformCookie(platform, options.cookie)
  const url = platform === 'qq'
    ? `${API_BASE}/qq/playlist/create`
    : `${API_BASE}/netease/playlist/create`
  
  const response = await fetch(url, {
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
}

/**
 * 删除歌单
 */
export async function deletePlaylist(
  playlistId: string,
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  console.log(`🗑️ 删除歌单: ${playlistId}`)

  // 汽水：上游不存在删除歌单端点（已核实），抛出明确错误由调用方 toast 提示（不 crash）
  if (platform === 'soda') {
    throw new Error('汽水音乐暂不支持删除歌单：上游未提供删除歌单的接口')
  }
  // Spotify Web API 无删除歌单接口；酷狗无删除网关。均诚实拦截，
  // 避免落入下方默认分支误打网易/QQ 删除接口
  if (platform === 'spotify' || platform === 'kugou') {
    throw new Error(`${platformLabel(platform)}暂不支持删除歌单：上游未提供删除歌单的接口`)
  }

  const cookie = getPlatformCookie(platform, options.cookie)
  const url = platform === 'qq'
    ? `${API_BASE}/qq/playlist/delete`
    : `${API_BASE}/netease/playlist/delete`
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: playlistId,
      cookie: cookie
    })
  })

  const data = await response.json()
  return data
}

/**
 * 更新歌单信息
 */
export async function updatePlaylist(
  playlistId: string,
  platform: MusicPlatform = 'netease',
  options: {
    name?: string
    desc?: string
    tags?: string
    cookie?: string
  } = {}
): Promise<any> {
  console.log(`✏️ 更新歌单: ${playlistId}`)
  // 汽水：暂不支持修改歌单信息，明确报错由调用方 toast 提示（不 crash）
  if (platform === 'soda') {
    throw new Error('汽水音乐暂不支持修改歌单信息')
  }
  const cookie = options.cookie || localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
  const url = 'http://localhost:3001/api/netease/playlist/update'
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: playlistId,
      name: options.name,
      desc: options.desc,
      tags: options.tags,
      cookie: cookie
    })
  })

  const data = await response.json()
  return data
}

/**
 * 更新网易云歌单封面
 */
export async function updatePlaylistCover(
  playlistId: string,
  imageData: string,
  platform: MusicPlatform = 'netease',
  options: { cookie?: string } = {}
): Promise<any> {
  // 汽水：暂不支持修改歌单封面，明确报错由调用方 toast 提示（不 crash）
  if (platform === 'soda') {
    throw new Error('汽水音乐暂不支持修改歌单封面')
  }
  const cookie = options.cookie || localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
  const response = await fetch('http://localhost:3001/api/netease/playlist/cover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: playlistId,
      imageData,
      imgSize: 600,
      imgX: 0,
      imgY: 0,
      cookie
    })
  })

  return response.json()
}

/**
 * 收藏/取消收藏歌单
 */
export async function subscribePlaylist(
  playlistId: string,
  subscribe: boolean = true,
  platform: MusicPlatform = 'netease',
  options: {
    cookie?: string
  } = {}
): Promise<any> {
  console.log(`收藏/取消收藏歌单: ${playlistId}`)

  // Spotify：官方 API 前端直连（follow/unfollow）
  if (platform === 'spotify') {
    const { followSpotifyPlaylist } = await import('./spotifyService')
    const ok = await followSpotifyPlaylist(playlistId, subscribe)
    if (!ok) throw new Error('Spotify 收藏歌单失败（token 失效或网络异常）')
    invalidateUserPlaylistsCache(platform, '')
    return { result: 200, platform: 'spotify' }
  }
  // 汽水：抖音收藏/取消收藏歌单
  if (platform === 'soda') {
    const { collectSodaPlaylist } = await import('./sodaService')
    const ok = await collectSodaPlaylist(playlistId, subscribe)
    if (!ok) throw new Error(subscribe ? '汽水音乐收藏歌单失败' : '汽水音乐取消收藏失败')
    invalidateUserPlaylistsCache(platform, localStorage.getItem('soda_user_id') || '')
    return { result: 200, platform: 'soda' }
  }

  // 酷狗：无收藏他人歌单的网关（platforms.ts 能力表即 false）；诚实拦截，
  // 否则会按下方默认分支误打网易收藏接口
  if (platform === 'kugou') {
    throw new Error('酷狗音乐暂不支持收藏歌单：上游未提供收藏歌单的接口')
  }

  const cookie = getPlatformCookie(platform, options.cookie)
  const url = platform === 'qq'
    ? `${API_BASE}/qq/playlist/subscribe`
    : `${API_BASE}/netease/playlist/subscribe`
  
  const response = await fetch(url, {
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
}



