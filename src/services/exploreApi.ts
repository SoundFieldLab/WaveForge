import type { MusicPlatform } from './platforms'
import { getPlatformCookie } from './platforms'
import { getApiBase } from './apiConfig'
import type { Song } from './musicApi'
import { getQQMusicSkillHeaders } from './qqMusicSkills'
import { fetchAppleExplorePayload } from './appleExploreService'
import { createTtlCache } from '../utils/ttlCache'
import {
  appleSongToSong,
  getAppleCatalogPlaylistTracks,
} from './appleCatalog'

const API_BASES = [getApiBase()]
const EXPLORE_MEMORY_CACHE_TTL = 9 * 60 * 1000

const exploreHomeMemoryCache = new Map<string, { payload: ExplorePayload; expiresAt: number }>()
const exploreHomePending = new Map<string, Promise<ExplorePayload>>()
// 歌单/榜单详情：面板来回开关时同一份数据会被反复请求（传统模式、桌面组件、探索页详情都在用）。
const exploreDetailCache = createTtlCache<ExploreDetail>({ ttlMs: 5 * 60 * 1000, maxEntries: 40 })
// 任一平台登录态变化（含汽水扫码成功）→ 失效探索页内存缓存，个性化数据立即可见
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => {
    exploreHomeMemoryCache.clear()
    exploreDetailCache.clear()
  })
  // 歌单内容变化（加/删歌、收藏、删除歌单）→ 歌单/榜单详情缓存立刻失效。
  // 传统模式等会把「用户自己的歌单」也走这条缓存，不清的话重开详情最长 5 分钟还是旧曲目。
  window.addEventListener('playlist-content-changed', () => { exploreDetailCache.clear() })
}

export type ExplorePlatform = MusicPlatform

function fingerprintExploreValue(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getExploreHomeCacheKey(platform: ExplorePlatform, appleCountry?: string): string {
  // Apple 无 cookie，按商店区分缓存
  if (platform === 'apple') {
    const storefront = appleCountry || localStorage.getItem('appleStorefront') || 'cn'
    return `apple:${storefront}`
  }
  const userIdKey = platform === 'qq' ? 'qq_user_id' : platform === 'netease' ? 'netease_user_id' : `${platform}_user_id`
  const userId = localStorage.getItem(userIdKey) || ''
  const cookie = getExploreCookie(platform)
  const accountKey = userId ? `user:${userId}` : cookie ? `cookie:${fingerprintExploreValue(cookie)}` : 'guest'
  return `${platform}:${accountKey}`
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export interface ExplorePlaylist {
  id: string
  name: string
  description?: string
  coverUrl: string
  playCount?: number
  trackCount?: number
  creator?: string
  /** 歌单仅来自网易云/QQ（Apple 探索不产出歌单） */
  platform: MusicPlatform
  source?: 'personalized' | 'community' | 'qqmusic-skills' | string
  /** 酷狗歌单列表内嵌的部分歌曲（hash + filename），详情接口不可用时兜底 */
  embeddedSongs?: Array<{ hash: string; filename: string }>
  /** 酷狗 concept 概念版 global_collection_id：有概念版凭据时优先用它取曲目 */
  conceptId?: string
  /** 酷狗分类歌单自带的标签（分类板块的筛选依据；其它平台为空） */
  tags?: string[]
}

export interface ExploreChartSong {
  id?: number
  /** 平台歌曲标识（酷狗 hash / 抖音 music_id 等），用于直接播放 */
  mid?: string
  /** Apple 目录曲目 id（原生取流 salableAdamId）；缺失时只能回退载体匹配 */
  appleId?: string
  name: string
  artist: string
  coverUrl?: string
  rank?: number
}

export interface ExploreChart {
  id: string
  name: string
  group: string
  description?: string
  coverUrl: string
  playCount?: number
  updateText?: string
  platform: ExplorePlatform
  source?: 'community' | 'qqmusic-skills' | string
  songs: ExploreChartSong[]
}

export interface ExploreAlbum {
  id: number
  mid?: string
  name: string
  artist: string
  coverUrl: string
  publishTime?: number | string
  platform: ExplorePlatform
}

export interface ExploreChannel {
  id: string
  name: string
  group: string
  description?: string
  coverUrl: string
  playCount?: number
  platform: ExplorePlatform
  song?: Song | null
}

export interface QQNativeExploreCard {
  id: string
  type: number
  subtype: number
  style: number
  title: string
  subtitle?: string
  coverUrl?: string
  reason?: string
  songs: Song[]
  playlist?: ExplorePlaylist | null
}

export interface QQNativeExploreModule {
  id: string
  title: string
  style: number
  personalized: true
  source: 'qq-native-recommend-feed'
  cards: QQNativeExploreCard[]
}

export interface QQNativeExploreFeed {
  accountScoped: true
  generatedAt: number
  loadMark: number
  hasMore: boolean
  cursor: { page: number; shelfCount: number }
  daily30?: {
    playlistId: string
    title: string
    coverUrl?: string
    dateKey: string
    songs: Song[]
  } | null
  modules: QQNativeExploreModule[]
}

/** 酷狗探索页扩展板块（客户端组装）：乐库/歌单分类/频道/每日推荐。
 *  每个子项单独带 error，UI 按板块显示「空态 + 原因」，不让单个上游失败拖垮整个探索页。 */
export interface KugouExploreTagGroup {
  id: string
  name: string
  tags: Array<{ id: string; name: string }>
}

export interface KugouExplorePayload {
  /** 每日推荐（概念版 /concept/daily） */
  dailySongs: Song[]
  dailyDate?: string
  dailyError?: string
  /** 新歌速递（概念版 /concept/newsongs，乐库板块用） */
  newSongs: Array<{ song: Song; publishDate?: string }>
  newSongsError?: string
  /** 频道（概念版 /concept/channels；上游对无订阅账号返回空） */
  channels: ExploreChannel[]
  channelError?: string
  /** 歌单分类标签树（概念版 /concept/playlist/tags） */
  tagGroups: KugouExploreTagGroup[]
  tagError?: string
  /** 分类歌单推荐池（概念版 /concept/playlist/by-tag，带标签与播放量） */
  tagPlaylists: ExplorePlaylist[]
  tagPlaylistsHasNext: boolean
  tagPlaylistsError?: string
  /** 乐库首页（概念版 /concept/yueku）：官方乐库页的新歌/专辑/榜单/推荐歌单 */
  yueku: {
    headlineCoverUrl?: string
    newAlbums: ExploreAlbum[]
    ranks: Array<{ rankid: string; rankname: string; coverUrl: string; playCount?: number }>
    recommendPlaylists: ExplorePlaylist[]
  } | null
  yuekuError?: string
  /** 歌手目录（概念版 /concept/singers） */
  singers: Array<{ singerid: string; singername: string; coverUrl?: string; fansCount?: number; heat?: number }>
  singersError?: string
}

export interface ExplorePayload {
  code: number
  platform: ExplorePlatform
  officialEnhanced: boolean
  personalized: boolean
  dailySongs: Song[]
  radioSongs: Song[]
  newSongs: Song[]
  playlists: ExplorePlaylist[]
  charts: ExploreChart[]
  albums: ExploreAlbum[]
  channels: ExploreChannel[]
  qqNative?: QQNativeExploreFeed | null
  /** 仅 kugou：官方五板块（乐库/歌单/频道/分类）所需的扩展数据 */
  kugou?: KugouExplorePayload | null
  meta: {
    source: string
    recommendationSource?: 'qq-guess-you-like' | 'qqmusic-skills-radio' | 'qq-daily' | 'public' | string
    updatedAt: number
  }
}

export interface ExploreDetail {
  playlist: {
    id: string
    name: string
    coverImgUrl: string
    trackCount: number
    description?: string
    /** 歌单被播放次数（QQ listennum / 网易云 playCount） */
    playCount?: number
    /** 创建者（后端归一化对象） */
    creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
    tags?: string[]
    isLike?: boolean
    createTime?: number
    platform: MusicPlatform
  }
  songs: Song[]
}

const ensureOk = async (response: Response) => {
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new Error(`探索服务返回了无效响应 (${response.status})`)
  }
  const data = await response.json()
  if (!response.ok || (data.code && Number(data.code) >= 400)) {
    throw new Error(data.error || data.message || `请求失败 (${response.status})`)
  }
  return data
}

const fetchExploreJson = async (
  path: string,
  params: Record<string, string | undefined>,
  signal?: AbortSignal
) => {
  let lastError: unknown
  for (const base of API_BASES) {
    const url = new URL(`${base}${path}`)
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value)
    })
    try {
      const headers = path.includes('/qq') || params.platform === 'qq'
        ? await getQQMusicSkillHeaders()
        : undefined
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(), 20_000)
      const abortFromCaller = () => controller.abort()
      signal?.addEventListener('abort', abortFromCaller, { once: true })
      try {
        return await ensureOk(await fetch(url.toString(), { signal: controller.signal, headers, cache: 'no-store' }))
      } finally {
        window.clearTimeout(timeoutId)
        signal?.removeEventListener('abort', abortFromCaller)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('探索服务暂时不可用')
}

const normalizeNeteaseSong = (input: any): Song | null => {
  const track = input?.song || input || {}
  const album = track.al || track.album || {}
  const artists = track.ar || track.artists || []
  const id = Number(track.id || 0)
  if (!id || !track.name) return null

  return {
    id,
    name: track.name,
    artists: (artists.length ? artists : [{ name: '未知歌手' }]).map((artist: any) => ({
      id: Number(artist.id) || undefined,
      name: artist.name || '未知歌手'
    })),
    album: {
      id: Number(album.id) || undefined,
      name: album.name || '',
      picUrl: album.picUrl || album.blurPicUrl || input?.picUrl || ''
    },
    duration: Number(track.dt || track.duration || 0),
    platform: 'netease',
    vip: Number(track.fee) === 1,
    fee: Number(track.fee) || 0,
    noCopyright: Number(track.privilege?.st) < 0
  }
}

const normalizeQQSong = (input: any): Song | null => {
  const track = input?.songInfo || input?.song || input || {}
  const mid = String(track.mid || track.MID || track.Mid || track.songmid || track.songMid || track.song_mid || '').trim()
  const id = Number(track.id || track.ID || track.songid || track.songId || 0)
  const album = track.album || track.albumInfo || {}
  const albumMid = album.mid || album.MID || album.pmid || album.albumMid || album.albumMID ||
    track.albummid || track.albumMid || track.albumMID || track.album_mid || track.album_pic_mid || ''
  const rawArtists = track.singer || track.singers || track.artists || track.artist || []
  const artistNameFallback = track.singerName || track.singername || track.SingerName || track.artistName || '未知歌手'
  const artistList = Array.isArray(rawArtists) ? rawArtists : rawArtists ? [rawArtists] : []
  const name = track.name || track.Name || track.title || track.songname || track.songName || ''
  if (!name || (!mid && !id)) return null

  const coverUrl = track.cover || track.Cover || track.picUrl || track.picurl || track.album_pic_url || track.albumpic || track.albumPic ||
    track.albumCover || album.picUrl || album.picurl || album.cover || album.coverUrl || album.url || (
    albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${String(albumMid).replace(/_\d+$/, '')}.jpg` : ''
  )

  return {
    id,
    mid: mid || undefined,
    name,
    artists: (artistList.length ? artistList : [{ name: artistNameFallback }]).map((artist: any) => {
      const value = typeof artist === 'string' ? { name: artist } : artist || {}
      return {
        id: Number(value.id || value.singerid) || undefined,
        mid: value.mid || value.MID || value.singermid || value.singerMid || undefined,
        name: value.name || value.title || value.singerName || value.SingerName || artistNameFallback
      }
    }),
    album: {
      id: Number(album.id || track.albumid || track.album_id) || undefined,
      mid: albumMid || undefined,
      pmid: album.pmid || undefined,
      name: album.name || album.Name || album.title || track.albumname || track.album_name || '',
      picUrl: coverUrl
    },
    duration: Number(track.interval || 0) * 1000 || Number(track.duration || 0),
    platform: 'qq',
    vip: Boolean(track.pay?.pay_play || track.pay?.paydownload || track.isonly === 1)
  }
}

export function getExploreCookie(platform: ExplorePlatform): string {
  return getPlatformCookie(platform)
}

async function syncQQExploreCookie(cookie: string, signal?: AbortSignal): Promise<void> {
  if (!cookie) return
  await fetch(`${API_BASES[0]}/qq/user/setCookie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: cookie }),
    signal,
    cache: 'no-store'
  }).catch(error => {
    if ((error as Error).name === 'AbortError') throw error
  })
}

export async function fetchExploreHome(
  platform: ExplorePlatform,
  signal?: AbortSignal,
  options: { forceRefresh?: boolean; enhanced?: boolean; appleCountry?: string } = {}
): Promise<ExplorePayload> {
  const cacheKey = getExploreHomeCacheKey(platform, options.appleCountry)
  if (!options.forceRefresh) {
    const cached = exploreHomeMemoryCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.payload
    const pending = exploreHomePending.get(cacheKey)
    if (pending) return awaitWithSignal(pending, signal)
  }

  const request = (async () => {
  // Apple：客户端组装（RSS + amp-api），不走服务端 /explore/apple
  if (platform === 'apple') {
    const storefront = options.appleCountry || localStorage.getItem('appleStorefront') || 'cn'
    const payload = await fetchAppleExplorePayload(storefront)
    exploreHomeMemoryCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL
    })
    return payload
  }
  // 酷狗：经 local-server 代理调用移动端公开接口（真实 TOP500/新歌榜/歌单）
  if (platform === 'kugou') {
    const { fetchKugouRankList, fetchKugouRankInfo, fetchKugouPlaylists, kugouTrackToSong, resolveKugouCover } = await import('./kugouService')
    const [ranksRes, playlistsRes] = await Promise.allSettled([
      fetchKugouRankList(),
      fetchKugouPlaylists(24),
    ])
    const ranks = ranksRes.status === 'fulfilled' ? ranksRes.value : []
    const prefer = (names: string[]) => ranks.find(rank => names.some(name => rank.rankname.includes(name)))
    const hotRank = prefer(['TOP500', '热歌', '最热']) || ranks[0]
    const newRank = prefer(['新歌', '新声']) || ranks.find(rank => rank.rankid === '74534')
    const risingRank = prefer(['飙升', '飙升榜']) || ranks.find(rank => rank.rankid === '6666')
    // 更多榜单（酷狗 web 榜单页同款分类）：国潮/ACG/DJ/怀旧/纯音乐等，去重后最多取 6 个
    const extraNames = ['国潮', 'ACG', 'DJ', '80后', '90后', '00后', '民谣', '纯音乐', '粤语', '日韩', '网络热歌']
    const extraRanks = ranks.filter(rank => extraNames.some(name => rank.rankname.includes(name)))
    // 榜单顺序 [热歌, 新歌, 飙升, ...扩展]：新歌榜取真实新歌榜（rankSongs[1]）
    const chartRanks = [hotRank, newRank, risingRank, ...extraRanks]
      .filter((rank): rank is NonNullable<typeof rank> => Boolean(rank))
      .filter((rank, index, arr) => arr.findIndex(r => r.rankid === rank.rankid) === index) // 去重
      .slice(0, 6)
    const chartTrackResults = await Promise.allSettled(
      chartRanks.map(rank => fetchKugouRankInfo(rank.rankid, 30)),
    )
    const rankSongs = chartTrackResults.map((result, index) =>
      result.status === 'fulfilled' ? result.value : chartTrackResults[index].status === 'fulfilled' ? [] : []
    )
    const hotTracks = rankSongs[0] || []
    const toChart = (rank: { rankid: string; rankname: string; img?: string }, tracks: Array<{ hash: string; songName: string; singerName: string; coverUrl?: string }>): ExploreChart => ({
      id: `kg-${rank.rankid}`,
      name: rank.rankname || '酷狗榜单',
      group: '酷狗音乐',
      description: `${rank.rankname || '酷狗榜单'} · 酷狗音乐实时更新`,
      coverUrl: resolveKugouCover(rank.img || ''),
      updateText: '实时更新',
      platform: 'kugou',
      source: 'kugou-rank',
      songs: tracks.slice(0, 30).map((track, index) => ({
        mid: track.hash,
        name: track.songName,
        artist: track.singerName,
        coverUrl: track.coverUrl,
        rank: index + 1,
      })),
    })
    const charts = chartRanks.map((rank, index) => toChart(rank, rankSongs[index] || [])).filter(chart => chart.songs.length > 0)
    const playlists: ExplorePlaylist[] = (playlistsRes.status === 'fulfilled' ? playlistsRes.value : []).map(item => ({
      id: item.specialid,
      name: item.name,
      coverUrl: item.coverUrl || '',
      playCount: item.playcount,
      trackCount: item.songcount,
      platform: 'kugou',
      source: 'kugou-plist',
      embeddedSongs: item.songs,
    }))
    // 新专辑（mobilecdn 公开目录接口）：探索页「新碟」区块与专辑详情入口
    const { fetchKugouAlbumList } = await import('./kugouService')
    const albumsRes = await fetchKugouAlbumList(1, 24).catch(() => [] as Awaited<ReturnType<typeof fetchKugouAlbumList>>)
    const albums: ExploreAlbum[] = albumsRes.map(item => ({
      id: Number(parseInt(String(item.albumid).slice(0, 12), 10)) || 0,
      mid: item.albumid,
      name: item.albumname,
      artist: item.singername,
      coverUrl: item.imgurl || '',
      publishTime: item.publishtime || '',
      platform: 'kugou' as const,
    }))
    // ── 官方五板块（乐库/歌单/频道/分类/每日推荐）所需的扩展数据 ──
    // 全部走概念版目录接口（游客设备凭据即可），逐项 allSettled：单个上游失败只影响它自己的板块。
    const {
      fetchKugouDailyRecommend,
      fetchKugouChannels,
      fetchKugouPlaylistTags,
      fetchKugouPlaylistsByTag,
      fetchKugouYueku,
      fetchKugouSingerList,
      fetchKugouNewSongs,
    } = await import('./kugouService')
    const tagPlaylistToExplore = (item: { specialid: string; globalSpecialId?: string; name: string; coverUrl: string; playCount?: number; trackCount?: number; creator?: string; intro?: string; tags: string[] }): ExplorePlaylist => ({
      id: item.specialid,
      conceptId: item.globalSpecialId,
      name: item.name,
      coverUrl: item.coverUrl,
      playCount: item.playCount,
      trackCount: item.trackCount,
      creator: item.creator,
      description: item.intro,
      // 分类筛选依据（分类板块的标签芯片 ↔ 歌单标签）
      tags: item.tags,
      platform: 'kugou',
      source: 'kugou-tag-playlist',
    })
    const [dailyRes, channelsRes, tagsRes, tagPlaylistsRes, yuekuRes, singersRes, newSongsRes] = await Promise.allSettled([
      fetchKugouDailyRecommend(),
      fetchKugouChannels(1, 30),
      fetchKugouPlaylistTags(),
      fetchKugouPlaylistsByTag(0, 1, 100),
      fetchKugouYueku(),
      fetchKugouSingerList(40),
      fetchKugouNewSongs(21608, 1, 30),
    ])
    const daily: Awaited<ReturnType<typeof fetchKugouDailyRecommend>> = dailyRes.status === 'fulfilled' ? dailyRes.value : { songs: [] }
    const channelResult: Awaited<ReturnType<typeof fetchKugouChannels>> = channelsRes.status === 'fulfilled' ? channelsRes.value : { channels: [] }
    const tagResult: Awaited<ReturnType<typeof fetchKugouPlaylistTags>> = tagsRes.status === 'fulfilled' ? tagsRes.value : { groups: [] }
    const tagPlaylistResult: Awaited<ReturnType<typeof fetchKugouPlaylistsByTag>> = tagPlaylistsRes.status === 'fulfilled' ? tagPlaylistsRes.value : { playlists: [], hasNext: false }
    const yuekuResult: Awaited<ReturnType<typeof fetchKugouYueku>> = yuekuRes.status === 'fulfilled' ? yuekuRes.value : { yueku: null }
    const singerResult: Awaited<ReturnType<typeof fetchKugouSingerList>> = singersRes.status === 'fulfilled' ? singersRes.value : { singers: [] }
    const newSongResult: Awaited<ReturnType<typeof fetchKugouNewSongs>> = newSongsRes.status === 'fulfilled' ? newSongsRes.value : { songs: [] }
    const kugou: KugouExplorePayload = {
      dailySongs: daily.songs.map(kugouTrackToSong),
      dailyDate: daily.date,
      dailyError: daily.songs.length === 0 ? '每日推荐暂无返回（上游限流或接口不可用）' : undefined,
      newSongs: newSongResult.songs.map(item => ({
        song: kugouTrackToSong(item.track),
        publishDate: item.publishDate,
      })),
      newSongsError: newSongResult.songs.length === 0 ? newSongResult.error || '新歌速递暂无返回' : undefined,
      channels: channelResult.channels.map(channel => ({
        id: channel.id,
        name: channel.name,
        group: channel.group || '频道',
        description: channel.description,
        coverUrl: channel.coverUrl || '',
        playCount: channel.playCount,
        platform: 'kugou',
        source: 'kugou-channel',
        song: null,
      })),
      channelError: channelResult.channels.length === 0 ? channelResult.error || '当前账号没有订阅频道' : undefined,
      tagGroups: tagResult.groups,
      tagError: tagResult.groups.length === 0 ? tagResult.error || '分类标签暂无返回' : undefined,
      tagPlaylists: tagPlaylistResult.playlists.map(tagPlaylistToExplore),
      tagPlaylistsHasNext: tagPlaylistResult.hasNext,
      tagPlaylistsError: tagPlaylistResult.playlists.length === 0 ? tagPlaylistResult.error || '分类歌单暂无返回' : undefined,
      yueku: yuekuResult.yueku
        ? {
          headlineCoverUrl: yuekuResult.yueku.headline?.coverUrl,
          newAlbums: yuekuResult.yueku.newAlbums.map(item => ({
            id: Number(item.albumid) || 0,
            mid: item.albumid,
            name: item.albumname,
            artist: item.singername,
            coverUrl: item.imgurl || '',
            publishTime: item.publishtime || '',
            platform: 'kugou' as const,
          })),
          ranks: yuekuResult.yueku.ranks,
          recommendPlaylists: yuekuResult.yueku.recommendPlaylists.map(tagPlaylistToExplore),
        }
        : null,
      yuekuError: !yuekuResult.yueku ? yuekuResult.error || '乐库数据暂无返回' : undefined,
      // 上游按分组返回（每组 hotsize 个）会合出上千条：只保留前 48 位热门歌手，
      // 避免探索页缓存把整棵歌手目录写进 localStorage
      singers: singerResult.singers.slice(0, 48),
      singersError: singerResult.singers.length === 0 ? singerResult.error || '歌手目录暂无返回' : undefined,
    }
    const dailySongs = kugou.dailySongs.length > 0 ? kugou.dailySongs : hotTracks.map(kugouTrackToSong)
    const payload: ExplorePayload = {
      code: 0,
      platform: 'kugou',
      officialEnhanced: false,
      // 日推来自概念版账号通道（有数据即代表个性化内容可用）
      personalized: kugou.dailySongs.length > 0,
      dailySongs,
      radioSongs: [],
      newSongs: (rankSongs[1]?.length ? rankSongs[1] : hotTracks).map(kugouTrackToSong),
      playlists,
      charts,
      albums,
      channels: [],
      kugou,
      meta: { source: 'kugou-mobile-api', updatedAt: Date.now() },
    }
    exploreHomeMemoryCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL })
    return payload
  }
  // Spotify：官方 Web API（需登录 token；未登录返回空 payload，区块自动隐藏）
  if (platform === 'spotify') {
    const { fetchSpotifyNewReleases, fetchSpotifyFeaturedPlaylists, fetchSpotifyCharts } = await import('./spotifyService')
    const [releasesRes, playlistsRes, chartsRes] = await Promise.allSettled([
      fetchSpotifyNewReleases(30),
      fetchSpotifyFeaturedPlaylists(24),
      fetchSpotifyCharts(),
    ])
    const releases = releasesRes.status === 'fulfilled' ? releasesRes.value : []
    const albums: ExploreAlbum[] = releases.map(item => ({
      id: Number(parseInt(item.id.slice(0, 12), 36)) || 0,
      mid: item.id,
      name: item.name,
      artist: item.artists.map(artist => artist.name).join(' / '),
      coverUrl: item.coverUrl || '',
      platform: 'spotify',
    }))
    // 新发行接口返回专辑：以"专辑首唱"形式呈现新鲜内容
    const newSongs: Song[] = releases.map(item => ({
      id: Number(parseInt(item.id.slice(0, 12), 36)) || 0,
      mid: item.id,
      name: item.name,
      artists: item.artists.map(artist => ({ name: artist.name })),
      album: { name: item.name, picUrl: item.coverUrl || '' },
      duration: 0,
      platform: 'spotify',
      fee: 0,
      songType: 1,
      fusedSources: [],
    }))
    // 榜单：官方 Top 榜歌单（Global Top 50 / Viral 50）
    const charts: ExploreChart[] = (chartsRes.status === 'fulfilled' ? chartsRes.value : []).map(chart => ({
      id: `sp-${chart.id}`,
      name: chart.name,
      group: 'Spotify',
      description: `${chart.name} · Spotify 官方榜单`,
      coverUrl: chart.coverUrl || '',
      updateText: '每周更新',
      platform: 'spotify' as const,
      source: 'spotify-chart',
      songs: chart.songs.slice(0, 30).map((track, index) => ({
        mid: track.id,
        name: track.name,
        artist: track.artists.map(a => a.name).join(' / '),
        coverUrl: track.album?.images?.[0]?.url,
        rank: index + 1,
      })),
    })).filter(chart => chart.songs.length > 0)
    const payload: ExplorePayload = {
      code: 0,
      platform: 'spotify',
      officialEnhanced: false,
      personalized: Boolean(localStorage.getItem('spotify_access_token')),
      dailySongs: [],
      radioSongs: [],
      newSongs,
      playlists: (playlistsRes.status === 'fulfilled' ? playlistsRes.value : []).map(item => ({
        id: item.id,
        name: item.name,
        coverUrl: item.coverUrl || '',
        platform: 'spotify',
        source: 'spotify-featured',
        creator: 'Spotify 编辑精选',
      })),
      charts,
      albums,
      channels: [],
      meta: { source: 'spotify-web-api', updatedAt: Date.now() },
    }
    exploreHomeMemoryCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL })
    return payload
  }
  // 汽水音乐：真实个性化数据流——并行拉取每日推荐（/api/soda/daily）、官方榜单组
  // （/api/soda/charts）与（登录时）用户歌单卡（/api/soda/user/playlists）；
  // 三者全空（后端未就绪/全挂）时回退旧 fetchSodaExplore 关键词聚合路径，保证区块不空白。
  if (platform === 'soda') {
    const { fetchSodaDaily, fetchSodaCharts, fetchSodaUserPlaylists, fetchSodaExplore, isSodaLoggedIn, clusterSodaAlbumsFromSongs } =
      await import('./sodaService')
    // 登录态粗判仅决定是否请求用户歌单卡；daily 的 personalized 由后端按会话判定
    const loggedIn = isSodaLoggedIn()
    const [dailyRes, chartsRes, playlistsRes] = await Promise.allSettled([
      fetchSodaDaily(),
      fetchSodaCharts(),
      loggedIn ? fetchSodaUserPlaylists() : Promise.resolve([] as Awaited<ReturnType<typeof fetchSodaUserPlaylists>>),
    ])
    const daily = dailyRes.status === 'fulfilled'
      ? dailyRes.value
      : { songs: [] as Song[], personalized: false }
    const chartGroups = chartsRes.status === 'fulfilled' ? chartsRes.value : []
    const userPlaylistCards = playlistsRes.status === 'fulfilled' ? playlistsRes.value : []

    // 榜单全量透传：封面取组内首曲封面；歌曲带名次与 mid（榜单详情可直接走汽水音源）
    // 命名保留后端原样——「热歌」「新歌」等字样供首页模块正则匹配（HomeView 不做改动）
    const charts: ExploreChart[] = chartGroups.map((chart): ExploreChart => ({
      id: chart.id,
      name: chart.name,
      group: chart.group,
      description: chart.description || `${chart.name} · 汽水音乐官方榜`,
      coverUrl: chart.songs[0]?.album?.picUrl || '',
      updateText: '实时更新',
      platform: 'soda',
      source: 'soda-reverse-api',
      songs: chart.songs.slice(0, 30).map((song, songIndex) => ({
        id: song.id,
        mid: song.mid,
        name: song.name,
        artist: song.artists?.[0]?.name || '',
        coverUrl: song.album?.picUrl || '',
        rank: songIndex + 1,
      })),
    })).filter(chart => chart.songs.length > 0)

    // 新歌区：优先取名称含「新歌/新曲」的榜单组歌曲；否则回退第一组前 20 首
    const newSongGroup = chartGroups.find(group => /新歌|新曲/.test(group.name))
    const newSongs: Song[] = (newSongGroup ? newSongGroup.songs : chartGroups[0]?.songs || []).slice(0, 20)

    // 推荐歌单卡：登录时取用户歌单前 12 张（fetchSodaUserPlaylists 已聚合创建+收藏，
    // source 区分自建/收藏供详情侧识别；未登录保持空数组）
    const playlists: ExplorePlaylist[] = userPlaylistCards.slice(0, 12).map(item => ({
      id: item.id,
      name: item.name,
      coverUrl: item.coverUrl || '',
      trackCount: item.trackCount,
      creator: '汽水音乐',
      platform: 'soda',
      source: item.collected ? 'soda-collected-playlist' : 'soda-user-playlist',
    }))

    // 新碟区块（派生聚合）：从每日推荐 + 新歌 + 各榜单组曲目的专辑字段聚拢去重
    // （clusterSodaAlbumsFromSongs：专辑名+封面键、cap 12、诚实标注 soda-derived-albums）。
    // 游客模式上游曲目常缺专辑字段 → 如实留空，区块由 sectionHasData 自动隐藏（预期诚实行为，非缺陷）。
    const albums: ExploreAlbum[] = clusterSodaAlbumsFromSongs(
      [...daily.songs, ...newSongs, ...chartGroups.flatMap(group => group.songs)],
      12,
    ).map(item => ({
      id: Number(item.id.slice(0, 15)) || 0,
      mid: item.id, // 真实专辑 id 缺失时回退专辑名（/album/tracks 按名/按 id 双口径）
      name: item.name,
      artist: item.artist,
      coverUrl: item.coverUrl || '',
      platform: 'soda' as const,
    }))

    // 统一装配：保持 ExplorePayload 形状与缓存写入逻辑不变
    const assembleSodaPayload = (
      source: string,
      data: Pick<ExplorePayload, 'personalized' | 'dailySongs' | 'newSongs' | 'playlists' | 'charts' | 'albums'>
    ): ExplorePayload => ({
      code: 0,
      platform: 'soda',
      officialEnhanced: false,
      personalized: data.personalized,
      dailySongs: data.dailySongs,
      radioSongs: [],
      newSongs: data.newSongs,
      playlists: data.playlists,
      charts: data.charts,
      albums: data.albums,
      channels: [],
      meta: { source, updatedAt: Date.now() },
    })

    // 失败降级：细粒度接口全部为空 → 回退旧关键词聚合路径（内部自带公开目录/DOM 抓取兜底）
    if (!daily.songs.length && !charts.length && !playlists.length) {
      const explore = await fetchSodaExplore()
      const fallbackCharts: ExploreChart[] = explore.charts.map((chart): ExploreChart => ({
        id: chart.id,
        name: chart.name,
        group: chart.group,
        description: `${chart.name} · 汽水音乐`,
        coverUrl: chart.songs[0]?.album?.picUrl || '',
        updateText: '实时更新',
        platform: 'soda',
        source: 'soda-web-api-fallback',
        songs: chart.songs.map((song, songIndex) => ({
          id: song.id,
          mid: song.mid,
          name: song.name,
          artist: song.artists?.[0]?.name || '',
          coverUrl: song.album?.picUrl || '',
          rank: songIndex + 1,
        })),
      })).filter(chart => chart.songs.length > 0)
      const payload = assembleSodaPayload('soda-web-api-fallback', {
        personalized: false,
        dailySongs: explore.songs,
        newSongs: explore.songs.slice(0, 20),
        playlists: explore.playlists.slice(0, 8).map(item => ({
          id: item.id,
          name: item.name,
          coverUrl: item.coverUrl || '',
          creator: '汽水音乐',
          platform: 'soda',
          source: 'soda-web-api-fallback',
        })),
        charts: fallbackCharts,
        // 回退路径同样派生新碟（旧关键词聚合的曲目字段），保持区块行为一致
        albums: clusterSodaAlbumsFromSongs(explore.songs, 12).map(item => ({
          id: Number(item.id.slice(0, 15)) || 0,
          mid: item.id,
          name: item.name,
          artist: item.artist,
          coverUrl: item.coverUrl || '',
          platform: 'soda' as const,
        })),
      })
      exploreHomeMemoryCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL })
      return payload
    }

    const payload = assembleSodaPayload('soda-web-api', {
      // 登录且日推确有个性化数据时为 true，探索页据此展示「汽水·每日推荐」语义
      personalized: Boolean(daily.personalized && daily.songs.length > 0),
      dailySongs: daily.songs,
      newSongs,
      playlists,
      charts,
      albums,
    })
    exploreHomeMemoryCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL })
    return payload
  }
  // enhanced=false：关闭平台增强（不传 cookie，后端只返回公开榜单/热门，不请求个性化推荐）
  const cookie = options.enhanced === false ? '' : getExploreCookie(platform)
  if (platform === 'qq') {
    await syncQQExploreCookie(cookie)
  }
  let data = await fetchExploreJson(`/explore/${platform}`, { cookie })
  if (
    platform === 'qq' &&
    cookie &&
    data?.personalized !== true &&
    data?.meta?.recommendationSource === 'public'
  ) {
    await syncQQExploreCookie(cookie)
    data = await fetchExploreJson(`/explore/${platform}`, { cookie, personalized: '1' })
  }
  const normalizedPayload = {
    ...data,
    dailySongs: Array.isArray(data.dailySongs) ? data.dailySongs : [],
    radioSongs: Array.isArray(data.radioSongs) ? data.radioSongs : [],
    newSongs: Array.isArray(data.newSongs) ? data.newSongs : [],
    playlists: Array.isArray(data.playlists) ? data.playlists : [],
    charts: Array.isArray(data.charts) ? data.charts : [],
    albums: Array.isArray(data.albums) ? data.albums : [],
    channels: Array.isArray(data.channels) ? data.channels : [],
    qqNative: data.qqNative && Array.isArray(data.qqNative.modules) ? data.qqNative : null
  } as ExplorePayload
  exploreHomeMemoryCache.set(cacheKey, {
    payload: normalizedPayload,
    expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL
  })
  return normalizedPayload
  })()

  if (!options.forceRefresh) {
    exploreHomePending.set(cacheKey, request)
    const cleanup = () => {
      if (exploreHomePending.get(cacheKey) === request) exploreHomePending.delete(cacheKey)
    }
    void request.then(cleanup, cleanup)
  }
  return awaitWithSignal(request, signal)
}

export function prefetchExploreHome(platform: ExplorePlatform): Promise<ExplorePayload> {
  return fetchExploreHome(platform)
}

export async function fetchQQNativeFeedPage(
  cursor: { page: number; shelfCount: number },
  seen: { shelfIds?: string[]; feedKeys?: string[] } = {},
  signal?: AbortSignal
): Promise<Pick<QQNativeExploreFeed, 'modules' | 'hasMore' | 'loadMark' | 'cursor'>> {
  const cookie = getExploreCookie('qq')
  if (!cookie) throw new Error('需要登录 QQ 音乐')
  await syncQQExploreCookie(cookie, signal)
  const headers = { 'Content-Type': 'application/json', ...(await getQQMusicSkillHeaders()) }
  const response = await fetch(`${API_BASES[0]}/explore/qq/native/feed`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      page: cursor.page,
      direction: cursor.page > 1 ? 1 : 0,
      shelfCount: cursor.shelfCount,
      shelfIds: (seen.shelfIds || []).slice(-200),
      feedKeys: (seen.feedKeys || []).slice(-100)
    }),
    signal,
    cache: 'no-store'
  })
  const data = await ensureOk(response)
  return {
    modules: Array.isArray(data.modules) ? data.modules : [],
    hasMore: data.hasMore === true,
    loadMark: Number(data.loadMark ?? -1),
    cursor: data.cursor || { page: cursor.page + 1, shelfCount: cursor.shelfCount }
  }
}

/** 电台批次（QQ 猜你喜欢/随心听）：songs + 服务端随批次下发的卡面文案。 */
export interface QQGuessYouLikeBatch {
  songs: Song[]
  /** 电台名（猜你喜欢）与逐曲推荐语（模板带 `{br}` 换行标记），首页大卡文案就来自这里。 */
  radio: { name: string; reasons: Array<{ mid: string; reason: string; template: string }> } | null
}

export async function fetchQQGuessYouLikeBatchWithMeta(
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal,
  options: { count?: number; fast?: boolean } = {},
): Promise<QQGuessYouLikeBatch> {
  const cookie = getExploreCookie('qq')
  if (cookie) await syncQQExploreCookie(cookie, signal)
  const count = Math.max(1, Math.min(60, Math.floor(options.count ?? 30)))
  const response = await fetch(`${API_BASES[0]}/explore/qq/radio/next`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await getQQMusicSkillHeaders()) },
    body: JSON.stringify({
      cookie,
      batch: Math.max(1, Math.floor(batch)),
      count,
      exclude: excludeSongKeys.slice(-300),
      // fast：官方首屏语义——只打一次上游（约 1.3s 拿到 5 首）就先开播，后续靠队列持续追加
      ...(options.fast ? { fast: 1 } : {}),
    }),
    signal,
    cache: 'no-store',
  })
  const data = await ensureOk(response)
  const rawSongs = Array.isArray(data.songs) ? data.songs : []
  const songs = rawSongs
    .map((song: any) => normalizeQQSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))
  const radio = data?.radio && typeof data.radio === 'object'
    ? {
      name: String(data.radio.name || '猜你喜欢'),
      reasons: Array.isArray(data.radio.reasons)
        ? data.radio.reasons.map((item: any) => ({
          mid: String(item?.mid || ''),
          reason: String(item?.reason || ''),
          template: String(item?.template || ''),
        })).filter((item: { mid: string }) => item.mid)
        : [],
    }
    : null
  return { songs, radio }
}

export async function fetchQQGuessYouLikeBatch(
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal,
  count = 30,
  fast = false,
): Promise<Song[]> {
  const { songs } = await fetchQQGuessYouLikeBatchWithMeta(batch, excludeSongKeys, signal, { count, fast })
  return songs
}

// 汽水无限续播游标状态（模块级单例）：batch<=1 视为新会话重置；到底后停止续拉（重试不再打网络）。
// App 探索无限续播与桌面小组件共用本入口，两者均从 batch=1/2 起步、按调用序推进游标；
// 极端交叉调用可能复用同一游标取到重复曲目，下游已有按歌曲 key 去重兜底（App additions 过滤）。
let sodaFeedContinuationCursor: string | undefined
let sodaFeedContinuationExhausted = false

export async function fetchExploreRecommendationBatch(
  platform: ExplorePlatform,
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal,
  // fast：QQ 猜你喜欢/随心听的「先给 5 首就播」语义（只打一次上游 ≈0.9s），队列续载也走它
  options: { count?: number; fast?: boolean } = {},
): Promise<Song[]> {
  // Apple/Spotify/酷狗 无连续电台接口
  if (platform === 'apple' || platform === 'spotify' || platform === 'kugou') return []
  // 汽水：登录态个性化 feed 游标续拉（契约：游标请求失败/到底如实返回空页，后端不回退媒体库拼凑）；
  // 未登录返回空数组（维持现语义：该平台无限续播静默停止，由 explore 首页批次兜底）
  if (platform === 'soda') {
    const { fetchSodaFeed, isSodaLoggedIn } = await import('./sodaService')
    if (!isSodaLoggedIn()) return []
    if (batch <= 1) {
      sodaFeedContinuationCursor = undefined
      sodaFeedContinuationExhausted = false
    }
    if (sodaFeedContinuationExhausted) return []
    const page = await fetchSodaFeed(30, sodaFeedContinuationCursor)
    if (page.nextCursor) {
      sodaFeedContinuationCursor = page.nextCursor
      if (page.hasMore === false) sodaFeedContinuationExhausted = true
    } else if (page.hasMore === false || page.songs.length > 0) {
      // 明确到底（hasMore:false）或旧后端单页（有歌无游标，无法续拉）→ 停止续拉
      sodaFeedContinuationExhausted = true
    }
    // 其余（空页且未明确到底）= 请求失败或瞬时无数据：保留游标，交由上层重试机制用同一游标再探
    return page.songs
  }
  const cookie = getExploreCookie(platform)
  if (platform === 'qq') {
    return fetchQQGuessYouLikeBatch(batch, excludeSongKeys, signal, options.count ?? 30, options.fast)
  }

  const data = await fetchExploreJson('/explore/netease/recommendations/next', {
    cookie,
    batch: String(Math.max(1, Math.floor(batch))),
    count: '30',
    exclude: excludeSongKeys.slice(-300).join(',') || undefined
  }, signal)
  const songs = Array.isArray(data.songs) ? data.songs : []
  return songs
    .map((song: any) => normalizeNeteaseSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))
}

/** 歌单详情：同一份歌单在 TTL 内重复打开直接复用缓存（不重复请求）。 */
export async function fetchExplorePlaylist(playlist: ExplorePlaylist, signal?: AbortSignal): Promise<ExploreDetail> {
  // source 与榜单同理进键：skills 来源与原生来源同 id 但内容不同，混用会串数据。
  const key = `playlist:${playlist.platform}:${playlist.id}:${playlist.source || ''}`
  const cached = exploreDetailCache.get(key)
  if (cached) return cached
  const detail = await fetchExplorePlaylistUncached(playlist, signal)
  if (!signal?.aborted) exploreDetailCache.set(key, detail)
  return detail
}

async function fetchExplorePlaylistUncached(playlist: ExplorePlaylist, signal?: AbortSignal): Promise<ExploreDetail> {
  // Apple 编辑/热门歌单：amp-api catalog 曲目（需 dev token；无 token 返回空歌单）
  if (playlist.platform === 'apple') {
    const storefront = localStorage.getItem('appleStorefront') || 'cn'
    const tracks = await getAppleCatalogPlaylistTracks(playlist.id, storefront)
    const songs = tracks.map(track => appleSongToSong(track, storefront))
    return {
      playlist: {
        ...playlist,
        creator: typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator,
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: playlist.coverUrl,
        trackCount: songs.length || playlist.trackCount || 0,
        description: playlist.description || '',
        platform: 'apple',
      },
      songs,
    }
  }
  // Spotify 歌单：官方 Web API 曲目
  if (playlist.platform === 'spotify') {
    const { fetchSpotifyPlaylist, spotifyTrackToSong } = await import('./spotifyService')
    const tracks = await fetchSpotifyPlaylist(playlist.id)
    const songs = tracks.map(spotifyTrackToSong)
    return {
      playlist: {
        ...playlist,
        creator: typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator,
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: playlist.coverUrl,
        trackCount: songs.length || playlist.trackCount || 0,
        description: playlist.description || '',
        platform: 'spotify',
      },
      songs,
    }
  }
  // 酷狗歌单：概念版凭据优先（用户自建歌单/「我喜欢」只有概念版接口拿得到曲目）；
  // 否则退回公开详情；再不行用列表内嵌歌曲兜底。无自定义封面时用首曲封面。
  if (playlist.platform === 'kugou') {
    const { fetchKugouPlaylistDetail, fetchKugouUserPlaylistTracks, hasKugouConceptCredential, kugouTrackToSong } = await import('./kugouService')
    // 概念版歌单曲目接口认 global_collection_id（分类歌单两者都带，可能不同）
    const conceptTracksId = playlist.conceptId || playlist.id
    let tracks = hasKugouConceptCredential()
      ? []
      : await fetchKugouPlaylistDetail(playlist.id).catch(() => [] as Awaited<ReturnType<typeof fetchKugouPlaylistDetail>>)
    if (tracks.length === 0) {
      tracks = await fetchKugouUserPlaylistTracks(conceptTracksId)
    }
    if (tracks.length === 0 && playlist.embeddedSongs?.length) {
      const { parseKugouEmbeddedSongs } = await import('./kugouService')
      tracks = parseKugouEmbeddedSongs(playlist.embeddedSongs)
    }
    const songs = tracks.map(kugouTrackToSong)
    return {
      playlist: {
        ...playlist,
        creator: typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator,
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: playlist.coverUrl || songs[0]?.album?.picUrl || '',
        trackCount: songs.length || playlist.trackCount || 0,
        description: playlist.description || '',
        platform: 'kugou',
      },
      songs,
    }
  }
  // 汽水歌单：逆向 Web API 歌单曲目页（支持 qishui-feed 等虚拟歌单 id），失败返回空壳由上层提示。
  // 后端单页上限 50 条，这里与 playlistService.getPlaylistDetail 同款分页合并全量曲目：
  // hasMore/trackCount 终止 + mid 去重兜底 + 20 页封顶，避免超过 50 首的歌单只显示第一页。
  if (playlist.platform === 'soda') {
    const { fetchSodaPlaylistTracks } = await import('./sodaService')
    const sodaSongs: Song[] = []
    const seenMids = new Set<string>()
    let name = ''
    let coverUrl = ''
    let trackCount = 0
    let offset = 0
    for (let page = 0; page < 20; page += 1) {
      const detail = await fetchSodaPlaylistTracks(playlist.id, offset)
      if (!name && detail.name) name = detail.name
      if (!coverUrl && detail.coverUrl) coverUrl = detail.coverUrl
      if (detail.trackCount > trackCount) trackCount = detail.trackCount
      if (!Array.isArray(detail.tracks) || detail.tracks.length === 0) break
      for (const song of detail.tracks) {
        const key = String(song.mid || song.id || '')
        if (key && seenMids.has(key)) continue
        if (key) seenMids.add(key)
        sodaSongs.push(song)
      }
      offset += detail.tracks.length
      if (!detail.hasMore || offset >= trackCount) break
    }
    return {
      playlist: {
        ...playlist,
        creator: typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator,
        id: playlist.id,
        name: name || playlist.name,
        coverImgUrl: coverUrl || playlist.coverUrl,
        trackCount: Number(trackCount || sodaSongs.length || playlist.trackCount || 0),
        description: playlist.description || '',
        platform: 'soda',
      },
      songs: sodaSongs,
    }
  }
  const cookie = getExploreCookie(playlist.platform)
  const data = await fetchExploreJson(`/${playlist.platform}/playlist/detail`, {
    id: playlist.id,
    songNum: playlist.platform === 'qq' ? '10000' : undefined,
    limit: playlist.platform === 'netease' ? '10000' : undefined,
    source: playlist.source,
    cookie
  }, signal)
  const rawSongs = playlist.platform === 'qq'
    ? data.songlist || data.playlist?.tracks || []
    : data.playlist?.tracks || data.songs || []
  const songs = rawSongs
    .map((song: any) => playlist.platform === 'qq' ? normalizeQQSong(song) : normalizeNeteaseSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))

  return {
      playlist: {
        ...playlist,
        creator: data.playlist?.creator || (typeof playlist.creator === 'string' ? { nickname: playlist.creator } : playlist.creator),
        id: playlist.id,
        name: data.playlist?.name || playlist.name,
      coverImgUrl: data.playlist?.coverImgUrl || playlist.coverUrl,
      trackCount: Number(data.playlist?.trackCount || songs.length || playlist.trackCount || 0),
      description: data.playlist?.description || playlist.description || '',
      // 元数据透传：播放次数/创建者/标签（后端歌单详情已归一化；用于传统模式歌单页角标与创建者展示）
      playCount: Number(data.playlist?.playCount || playlist.playCount || 0),
      tags: Array.isArray(data.playlist?.tags) ? data.playlist.tags : [],
      isLike: Boolean((playlist as any).isLike),
      createTime: Number(data.playlist?.createTime || 0) || undefined,
      platform: playlist.platform
    },
    songs
  }
}

/** 榜单详情：同 TTL 内复用，探索页/传统模式/桌面组件共用同一份。 */
export async function fetchExploreChart(chart: ExploreChart, signal?: AbortSignal, period = ""): Promise<ExploreDetail> {
  // period：榜单周期（周榜 2026_39 / 日榜 2026-10-06）。不同周期是不同内容，缓存键必须带上。
  // source 也必须进键：探索模式的 skills 榜单（source='qqmusic-skills'，上游 trackList 不带专辑封面）
  // 与原生榜单（source='community'）同 id 但内容不同。旧键不含 source，谁先打开谁把详情写进缓存——
  // 传统模式接着点同一个榜单会命中无封面那份，整页封面占位且不发请求（2026-10-07 用户实测根因）。
  const key = `chart:${chart.platform}:${chart.id}:${chart.source || ''}:${period}`
  const cached = exploreDetailCache.get(key)
  if (cached) return cached
  const detail = await fetchExploreChartUncached(chart, signal, period)
  if (!signal?.aborted) exploreDetailCache.set(key, detail)
  return detail
}

async function fetchExploreChartUncached(chart: ExploreChart, signal?: AbortSignal, period = ""): Promise<ExploreDetail> {
  // Apple：榜单数据客户端已带（charts 携带歌曲列表），无需服务端
  if (chart.platform === 'apple') {
    const songs: Song[] = chart.songs.map(song => ({
      id: typeof song.id === 'number' ? song.id : Number(song.id) || 0,
      // appleId 是原生取流的唯一依据：缺了就只能回退 QQ/网易云 载体匹配
      appleId: song.appleId || undefined,
      name: song.name,
      artists: song.artist ? [{ name: song.artist }] : [],
      album: { name: '', picUrl: song.coverUrl || '' },
      duration: 0,
      platform: 'apple',
    }))
    return {
      playlist: {
        id: chart.id,
        name: chart.name,
        coverImgUrl: chart.coverUrl,
        trackCount: songs.length,
        description: chart.description || '',
        platform: 'apple',
      },
      songs,
    }
  }
  // 酷狗榜单：客户端已带歌曲列表（含 hash），无需服务端
  if (chart.platform === 'kugou') {
    const songs: Song[] = chart.songs.map(song => ({
      id: typeof song.id === 'number' ? song.id : Number(song.id) || 0,
      mid: song.mid || (typeof song.id === 'number' ? '' : String(song.id || '')),
      name: song.name,
      artists: song.artist ? [{ name: song.artist }] : [],
      album: { name: '', picUrl: song.coverUrl || '' },
      duration: 0,
      platform: 'kugou',
    }))
    return {
      playlist: {
        id: chart.id,
        name: chart.name,
        coverImgUrl: chart.coverUrl,
        trackCount: songs.length,
        description: chart.description || '',
        platform: 'kugou',
      },
      songs,
    }
  }
  // 汽水榜单：客户端已带歌曲列表（逆向 Web API 官方榜），无需服务端
  if (chart.platform === 'soda') {
    const songs: Song[] = chart.songs.map(song => ({
      id: typeof song.id === 'number' ? song.id : Number(song.id) || 0,
      mid: song.mid || (typeof song.id === 'number' ? '' : String(song.id || '')),
      name: song.name,
      artists: song.artist ? [{ name: song.artist }] : [],
      album: { name: '', picUrl: song.coverUrl || '' },
      duration: 0,
      platform: 'soda',
    }))
    return {
      playlist: {
        id: chart.id,
        name: chart.name,
        coverImgUrl: chart.coverUrl,
        trackCount: songs.length,
        description: chart.description || '',
        platform: 'soda',
      },
      songs,
    }
  }
  // Spotify 榜单：客户端已带歌曲列表（官方 Top 榜歌单），无需服务端
  if (chart.platform === 'spotify') {
    const songs: Song[] = chart.songs.map(song => ({
      id: typeof song.id === 'number' ? song.id : Number(song.id) || 0,
      mid: song.mid || (typeof song.id === 'number' ? '' : String(song.id || '')),
      name: song.name,
      artists: song.artist ? [{ name: song.artist }] : [],
      album: { name: '', picUrl: song.coverUrl || '' },
      duration: 0,
      platform: 'spotify',
    }))
    return {
      playlist: {
        id: chart.id,
        name: chart.name,
        coverImgUrl: chart.coverUrl,
        trackCount: songs.length,
        description: chart.description || '',
        platform: 'spotify',
      },
      songs,
    }
  }
  const cookie = getExploreCookie(chart.platform)
  let lastResult: ExploreDetail | null = null
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await fetchExploreJson('/explore/chart', {
        platform: chart.platform,
        id: chart.id,
        name: chart.name,
        coverUrl: chart.coverUrl,
        description: chart.description,
        source: chart.source,
        cookie,
        ...(period ? { period } : {})
      }, signal) as ExploreDetail
      lastResult = result
      if (Array.isArray(result.songs) && result.songs.length > 0) return result
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
    if (attempt < 2) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }, 180 * (attempt + 1))
        const abort = () => {
          window.clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    }
  }
  if (lastResult) return lastResult
  throw lastError instanceof Error ? lastError : new Error(`${chart.name} 暂时没有返回歌曲，请稍后重试`)
}

export async function fetchExploreChannel(channel: ExploreChannel, signal?: AbortSignal): Promise<ExploreDetail> {
  const cookie = getExploreCookie('qq')
  const detail = await fetchExploreJson('/explore/radio', {
    platform: channel.platform,
    id: channel.id,
    name: channel.name,
    coverUrl: channel.coverUrl,
    cookie: getExploreCookie(channel.platform) || cookie
  }, signal)
  if ((!Array.isArray(detail.songs) || detail.songs.length === 0) && channel.song) {
    return {
      ...detail,
      playlist: { ...detail.playlist, trackCount: 1 },
      songs: [channel.song]
    }
  }
  return detail
}

// ─────────────────────── 酷狗分类歌单（分页 + 客户端标签筛选）───────────────────────
// 上游 special_recommend 不支持按 tag 查询（tagids 实测无效）：这里按页拉推荐池，
// 再按歌单自带的 tags 过滤。同一 (tag,page) 结果做短缓存，避免「换标签」来回打网络。
const kugouTagPlaylistCache = new Map<string, { playlists: ExplorePlaylist[]; hasNext: boolean; expiresAt: number }>()
const KUGOU_TAG_PLAYLIST_TTL = 5 * 60 * 1000
const KUGOU_TAG_PLAYLIST_MAX_PAGES = 3

function mapKugouTagPlaylist(item: { specialid: string; globalSpecialId?: string; name: string; coverUrl: string; playCount?: number; trackCount?: number; creator?: string; intro?: string; tags: string[] }): ExplorePlaylist {
  return {
    id: item.specialid,
    conceptId: item.globalSpecialId,
    name: item.name,
    coverUrl: item.coverUrl,
    playCount: item.playCount,
    trackCount: item.trackCount,
    creator: item.creator,
    description: item.intro,
    // 上游标签（分类筛选依据）：其它平台不写该字段，仅酷狗分类板块读取
    tags: item.tags,
    platform: 'kugou',
    source: 'kugou-tag-playlist',
  }
}

/** 酷狗分类歌单：tag=null 表示全部（官方"推荐"档），hasNext 供继续翻页 */
export async function fetchKugouTagPlaylists(
  tag: string | null,
  page = 1,
  signal?: AbortSignal,
): Promise<{ playlists: ExplorePlaylist[]; hasNext: boolean }> {
  const cacheKey = `kugou-tag:${tag || '*'}:${page}`
  const cached = kugouTagPlaylistCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { playlists: cached.playlists, hasNext: cached.hasNext }
  const { fetchKugouPlaylistsByTag } = await import('./kugouService')
  const result = await fetchKugouPlaylistsByTag(0, Math.max(1, page), 100)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const mapped = result.playlists.map(mapKugouTagPlaylist)
  let value = {
    playlists: tag ? mapped.filter(playlist => playlist.tags?.includes(tag)) : mapped,
    hasNext: result.hasNext,
  }
  // 单页只有约 35 条且标签分布稀疏：本页没命中标签时继续翻页补齐（最多 3 页），
  // 否则多数标签会显示空网格，而用户其实还有下一页可看。
  let cursor = Math.max(1, page)
  while (tag && value.playlists.length === 0 && value.hasNext && cursor < KUGOU_TAG_PLAYLIST_MAX_PAGES) {
    cursor += 1
    const next = await fetchKugouPlaylistsByTag(0, cursor, 100)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const nextMapped = next.playlists.map(mapKugouTagPlaylist)
    value = {
      playlists: nextMapped.filter(playlist => playlist.tags?.includes(tag)),
      hasNext: next.hasNext,
    }
  }
  kugouTagPlaylistCache.set(cacheKey, { ...value, expiresAt: Date.now() + KUGOU_TAG_PLAYLIST_TTL })
  return value
}
