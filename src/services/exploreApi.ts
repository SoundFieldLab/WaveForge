import type { MusicPlatform } from './platforms'
import { getPlatformCookie } from './platforms'
import type { Song } from './musicApi'
import { getQQMusicSkillHeaders } from './qqMusicSkills'
import { fetchAppleExplorePayload } from './appleExploreService'
import {
  appleSongToSong,
  getAppleCatalogPlaylistTracks,
} from './appleCatalog'

const API_BASES = ['http://localhost:3001/api']
const EXPLORE_MEMORY_CACHE_TTL = 9 * 60 * 1000

const exploreHomeMemoryCache = new Map<string, { payload: ExplorePayload; expiresAt: number }>()
const exploreHomePending = new Map<string, Promise<ExplorePayload>>()
// 任一平台登录态变化（含汽水扫码成功）→ 失效探索页内存缓存，个性化数据立即可见
if (typeof window !== 'undefined') {
  window.addEventListener('waveforge-auth-changed', () => { exploreHomeMemoryCache.clear() })
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
  const mid = String(track.mid || track.songmid || track.songMid || '').trim()
  const id = Number(track.id || track.songid || track.songId || 0)
  const album = track.album || track.albumInfo || {}
  const albumMid = album.mid || album.pmid || album.albumMid || album.albumMID ||
    track.albummid || track.albumMid || track.albumMID || track.album_mid || ''
  const rawArtists = track.singer || track.singers || track.artists || []
  const name = track.name || track.title || track.songname || track.songName || ''
  if (!name || (!mid && !id)) return null

  const coverUrl = track.cover || track.picUrl || track.picurl || track.albumpic || track.albumPic ||
    track.albumCover || album.picUrl || album.picurl || album.cover || album.coverUrl || (
    albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${String(albumMid).replace(/_\d+$/, '')}.jpg` : ''
  )

  return {
    id,
    mid: mid || undefined,
    name,
    artists: (rawArtists.length ? rawArtists : [{ name: track.singerName || '未知歌手' }]).map((artist: any) => ({
      id: Number(artist.id || artist.singerid) || undefined,
      mid: artist.mid || artist.singermid || artist.singerMid || undefined,
      name: artist.name || artist.title || artist.singerName || '未知歌手'
    })),
    album: {
      id: Number(album.id || track.albumid) || undefined,
      mid: albumMid || undefined,
      pmid: album.pmid || undefined,
      name: album.name || album.title || track.albumname || '',
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
    const payload: ExplorePayload = {
      code: 0,
      platform: 'kugou',
      officialEnhanced: false,
      personalized: false,
      dailySongs: hotTracks.map(kugouTrackToSong),
      radioSongs: [],
      newSongs: (rankSongs[1]?.length ? rankSongs[1] : hotTracks).map(kugouTrackToSong),
      playlists,
      charts,
      albums,
      channels: [],
      meta: { source: 'kugou-mobile-api', updatedAt: Date.now() },
    }
    exploreHomeMemoryCache.set(cacheKey, { payload, expiresAt: Date.now() + EXPLORE_MEMORY_CACHE_TTL })
    return payload
  }
  // Spotify：官方 Web API（需登录 token；未登录返回空 payload，区块自动隐藏）
  if (platform === 'spotify') {
    const { fetchSpotifyNewReleases, fetchSpotifyFeaturedPlaylists, fetchSpotifyCharts, spotifyTrackToSong } = await import('./spotifyService')
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
    const { fetchSodaDaily, fetchSodaCharts, fetchSodaUserPlaylists, fetchSodaExplore, isSodaLoggedIn } =
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

    // 推荐歌单卡：仅登录时取用户歌单前 8 个（coverUrl 有则透传）；未登录保持空数组
    const playlists: ExplorePlaylist[] = userPlaylistCards.slice(0, 8).map(item => ({
      id: item.id,
      name: item.name,
      coverUrl: item.coverUrl || '',
      trackCount: item.trackCount,
      creator: '汽水音乐',
      platform: 'soda',
      source: 'soda-user-playlist',
    }))

    // 统一装配：保持 ExplorePayload 形状与缓存写入逻辑不变
    const assembleSodaPayload = (
      source: string,
      data: Pick<ExplorePayload, 'personalized' | 'dailySongs' | 'newSongs' | 'playlists' | 'charts'>
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
      albums: [],
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
    channels: Array.isArray(data.channels) ? data.channels : []
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

export async function fetchQQGuessYouLikeBatch(
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal
): Promise<Song[]> {
  const cookie = getExploreCookie('qq')
  if (cookie) await syncQQExploreCookie(cookie, signal)
  const data = await fetchExploreJson('/explore/qq/radio/next', {
    cookie,
    batch: String(Math.max(1, Math.floor(batch))),
    count: '30',
    exclude: excludeSongKeys.slice(-300).join(',') || undefined
  }, signal)
  const songs = Array.isArray(data.songs) ? data.songs : []
  return songs
    .map((song: any) => normalizeQQSong(song))
    .filter((song: Song | null): song is Song => Boolean(song))
}

export async function fetchExploreRecommendationBatch(
  platform: ExplorePlatform,
  batch: number,
  excludeSongKeys: string[] = [],
  signal?: AbortSignal
): Promise<Song[]> {
  // Apple/Spotify/酷狗/汽水音乐 无连续电台接口
  if (platform === 'apple' || platform === 'spotify' || platform === 'kugou' || platform === 'soda') return []
  const cookie = getExploreCookie(platform)
  if (platform === 'qq') {
    return fetchQQGuessYouLikeBatch(batch, excludeSongKeys, signal)
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

export async function fetchExplorePlaylist(playlist: ExplorePlaylist, signal?: AbortSignal): Promise<ExploreDetail> {
  // Apple 编辑/热门歌单：amp-api catalog 曲目（需 dev token；无 token 返回空歌单）
  if (playlist.platform === 'apple') {
    const storefront = localStorage.getItem('appleStorefront') || 'cn'
    const tracks = await getAppleCatalogPlaylistTracks(playlist.id, storefront)
    const songs = tracks.map(track => appleSongToSong(track, storefront))
    return {
      playlist: {
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
  // 酷狗歌单：优先真实歌单详情接口；用户自建歌单（id 为网关 listid）公开详情拿不到，
  // 回退 H5 签名网关用户歌单曲目接口；最后用列表内嵌歌曲兜底
  if (playlist.platform === 'kugou') {
    const { fetchKugouPlaylistDetail, fetchKugouUserPlaylistTracks, kugouTrackToSong } = await import('./kugouService')
    let tracks = await fetchKugouPlaylistDetail(playlist.id).catch(() => [] as Awaited<ReturnType<typeof fetchKugouPlaylistDetail>>)
    if (tracks.length === 0) {
      tracks = await fetchKugouUserPlaylistTracks(playlist.id)
    }
    if (tracks.length === 0 && playlist.embeddedSongs?.length) {
      const { parseKugouEmbeddedSongs } = await import('./kugouService')
      tracks = parseKugouEmbeddedSongs(playlist.embeddedSongs)
    }
    const songs = tracks.map(kugouTrackToSong)
    return {
      playlist: {
        id: playlist.id,
        name: playlist.name,
        coverImgUrl: playlist.coverUrl,
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
      id: playlist.id,
      name: data.playlist?.name || playlist.name,
      coverImgUrl: data.playlist?.coverImgUrl || playlist.coverUrl,
      trackCount: Number(data.playlist?.trackCount || songs.length || playlist.trackCount || 0),
      description: data.playlist?.description || playlist.description || '',
      // 元数据透传：播放次数/创建者/标签（后端歌单详情已归一化；用于传统模式歌单页角标与创建者展示）
      playCount: Number(data.playlist?.playCount || playlist.playCount || 0),
      creator: data.playlist?.creator || undefined,
      tags: Array.isArray(data.playlist?.tags) ? data.playlist.tags : [],
      isLike: Boolean((playlist as any).isLike),
      createTime: Number(data.playlist?.createTime || 0) || undefined,
      platform: playlist.platform
    },
    songs
  }
}

export async function fetchExploreChart(chart: ExploreChart, signal?: AbortSignal): Promise<ExploreDetail> {
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
        cookie
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
