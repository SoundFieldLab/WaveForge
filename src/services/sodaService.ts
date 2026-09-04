/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 汽水音乐服务（抖音音乐体系）—— /api/soda/* 全能力类型化客户端
 *
 * 数据源分层：
 * 1. 本地后端 http://localhost:3001/api/soda/*（登录态、搜索、个性化推荐、榜单、
 *    歌单、喜欢/收藏、评论、歌词、播放地址等全部能力；cookie 经 query ?cookie=
 *    或 body 字段传递，来源 localStorage['soda_token']）。
 * 2. 兜底（后端未就绪/失败时）：火山引擎公开目录 API（无需登录，经 local-server
 *    /api/qishui/* 代理）→ 主进程抖音 DOM 抓取桥（window.electron.sodaScrapeSearch）。
 *
 * 设计约定：
 * - 所有请求带 10s 超时（AbortSignal.timeout），网络层失败一律 try/catch 降级：
 *   返回空值/false/null，绝不向 UI 抛错；错误用 console.warn 中文日志，
 *   例行信息走 debugLog（热路径不打 console.log）。
 * - 登录：抖音 passport 扫码（sso.douyin.com），捕获抖音会话 Cookie。
 */

import type { Song, LyricLine } from './musicApi'
import { getPlatformCookie } from './platforms'
import { debugLog } from '../utils/debugLog'
// 汽水逐字（yrc）→ 前端契约归一化：独立实现，不借用网易云解析器
import { asSodaWordRows, sodaWordRowsToLyricLines } from './sodaLyrics'
import type { SodaWordRowWire } from './sodaLyrics'

const SODA_API = 'http://localhost:3001/api/soda'
/** 旧火山公开目录代理（兜底数据源） */
const QISHUI_API = 'http://localhost:3001/api/qishui'
const REQUEST_TIMEOUT_MS = 10000

// ────────────────────────────── 类型定义 ──────────────────────────────

/** 后端 SodaSong 原始形状（/api/soda/* 各接口统一返回的曲目字段） */
interface SodaSong {
  id: string | number
  name?: string
  /** 主艺人（单个字符串） */
  artist?: string
  /** 艺人列表（字符串或 {name} 对象均可） */
  artists?: Array<string | { name?: string }>
  album?: string
  albumId?: string | number
  coverUrl?: string
  /** 时长（毫秒） */
  durationMs?: number
  vip?: boolean
  requiredTier?: 'free' | 'vip' | 'svip'
  onlyVipPlayable?: boolean
  bitrateKbps?: number
  quality?: string
  format?: string
}

/** 汽水用户资料（GET /status 返回的 profile 字段） */
export interface SodaProfile {
  userId: string
  nickname: string
  avatarUrl?: string
  /** 会员标签文案（如「SVIP」） */
  vipLabel?: string
  isVip?: boolean
  isSvip?: boolean
  /** 会员到期时间（ms 时间戳，可能缺省） */
  expiresAt?: number
}

/** 汽水会员信息（各接口返回的 membership 字段，字段均可缺省） */
export interface SodaMembership {
  isVip?: boolean
  isSvip?: boolean
  vipLabel?: string
  expiresAt?: number
}

/** 登录状态（GET /status 返回；请求失败时降级为 loggedIn:false 空状态） */
export interface SodaStatus {
  loggedIn: boolean
  profile?: SodaProfile
  membership: SodaMembership
}

/** 用户歌单卡片（GET /user/playlists 返回项；isLikedLike 标记「我喜欢」类虚拟歌单） */
export interface SodaPlaylistSummary {
  id: string
  name: string
  coverUrl?: string
  trackCount?: number
  isLikedLike?: boolean
  /** 是否已收藏（他人歌单场景） */
  collected?: boolean
}

/** 评论作者 */
export interface SodaCommentUser {
  name: string
  avatarUrl?: string
}

/**
 * 汽水歌曲评论。
 * 注意：time 为可显示时间——后端可能直接返回格式化字符串（如「3天前」），
 * 也可能返回 ms 时间戳；UI 层按 typeof time === 'number' 自行判断格式化。
 */
export interface SodaComment {
  id: string
  user: SodaCommentUser
  content: string
  likes?: number
  time: string | number
  replies?: SodaComment[]
}

/** 榜单组元信息（fetchSodaCharts 返回项 = 本类型 + songs: Song[]） */
export interface SodaChartGroup {
  id: string
  name: string
  /** 分组名（如「官方榜」「风格榜」） */
  group: string
  description?: string
}

/** 专辑信息摘要（fetchSodaAlbumTracks 返回的 album 字段） */
export interface SodaAlbumSummary {
  id?: string
  name: string
  coverUrl?: string
}

/** 播放地址详情（UI 可据 requiredTier/vipLabel/reason 展示 VIP 提示） */
export interface SodaPlaybackInfo {
  /** 播放直链；null = 不可播（未登录/VIP 受限/获取失败） */
  url: string | null
  /** 解锁该曲所需的会员档位 */
  requiredTier?: 'free' | 'vip' | 'svip'
  /** 当前账号会员标签（如「SVIP」），用于提示文案 */
  vipLabel?: string
  /** 不可播原因（后端给出的中文说明，可能缺省） */
  reason?: string
}

/** 歌单曲目页（虚拟歌单 qishui-feed / qishui-liked / qishui-recent 同构） */
export interface SodaPlaylistTracks {
  id: string
  name: string
  coverUrl?: string
  tracks: Song[]
  trackCount: number
  /** 是否还有下一页（offset + 本页条数 < trackCount 时为 true） */
  hasMore?: boolean
}

/** 旧的火山公开目录条目（兜底链路使用，保持既有导出向后兼容） */
export interface DouyinMusicItem {
  id: string
  name: string
  author?: string
  cover?: string
  text?: string
  durationMs?: number
  album?: string
}

// ────────────────────────────── 基础工具 ──────────────────────────────

/** 当前汽水会话 Cookie（抖音 sessionid 等，存于 localStorage['soda_token']） */
export function getSodaToken(): string {
  return getPlatformCookie('soda')
}

/** 是否已登录汽水音乐（本地 Cookie 特征粗判；精确态以 getSodaStatus 为准） */
export function isSodaLoggedIn(): boolean {
  const cookie = getSodaToken()
  return Boolean(cookie && /sessionid|sid_guard|uid_tt|passport/i.test(cookie))
}

/** 组装带 cookie 的查询串（cookie 经 query 参数传递；空值字段自动跳过） */
function buildQuery(params: Record<string, string | number | undefined>, explicitCookie?: string): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const cookie = explicitCookie || getSodaToken()
  if (cookie) search.set('cookie', cookie)
  return search.toString()
}

/** GET /api/soda/* 统一入口：超时/HTTP 错/网络错一律降级为 null，不向 UI 抛错 */
async function sodaGet<T>(path: string, params: Record<string, string | number | undefined> = {}, explicitCookie?: string): Promise<T | null> {
  try {
    const query = buildQuery(params, explicitCookie)
    const resp = await fetch(`${SODA_API}${path}${query ? `?${query}` : ''}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      debugLog(`[汽水] GET ${path} HTTP ${resp.status}`)
      return null
    }
    return (await resp.json()) as T
  } catch (e) {
    console.warn(`[汽水] GET ${path} 请求失败:`, e)
    return null
  }
}

/** POST /api/soda/* 统一入口：cookie 注入 body 字段，失败降级为 null */
async function sodaPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T | null> {
  try {
    const payload: Record<string, unknown> = { ...body }
    const cookie = getSodaToken()
    if (cookie) payload.cookie = cookie
    const resp = await fetch(`${SODA_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!resp.ok) {
      debugLog(`[汽水] POST ${path} HTTP ${resp.status}`)
      return null
    }
    return (await resp.json()) as T
  } catch (e) {
    console.warn(`[汽水] POST ${path} 请求失败:`, e)
    return null
  }
}

// ────────────────────────────── 曲目映射 ──────────────────────────────

/**
 * 后端 SodaSong → WaveForge Song。
 * platform 固定 'soda'；mid 保留原始 id 字符串（汽水 id 超出 JS 安全整数精度，
 * Song.id 用 Number(mid.slice(0,15))||0 截断生成，与 douyinMusicToSong 一致）；
 * vip 由 vip/requiredTier(vip|svip) 推导写入 Song.vip；artists 解析为数组。
 */
export function sodaMediaToSong(s: SodaSong): Song {
  const mid = String(s?.id ?? '')
  const tier = s?.requiredTier
  const vip = Boolean(s?.vip || tier === 'vip' || tier === 'svip')
  const rawArtists = Array.isArray(s?.artists) ? s.artists : []
  const artistNames = rawArtists.length
    ? rawArtists
        .map(item => (typeof item === 'string' ? item : String(item?.name || '')))
        .filter(Boolean)
    : s?.artist
      ? [String(s.artist)]
      : []
  return {
    id: Number(mid.slice(0, 15)) || 0,
    mid,
    name: String(s?.name || '未知歌曲'),
    artists: artistNames.map(name => ({ name })),
    album: {
      name: String(s?.album || ''),
      picUrl: String(s?.coverUrl || ''),
    },
    duration: Number(s?.durationMs || 0),
    platform: 'soda' as const,
    vip,
    fee: vip ? 1 : 0,
    songType: 1,
    fusedSources: [],
  }
}

/** 批量映射并剔除无 id 的脏数据 */
function mapSodaSongs(list: SodaSong[] | undefined): Song[] {
  if (!Array.isArray(list)) return []
  return list.map(sodaMediaToSong).filter(song => song.mid)
}

// ────────────────────────────── 状态 / 搜索 ──────────────────────────────

/**
 * 登录状态与会员信息（未登录或请求失败时返回 loggedIn:false 空状态）。
 * cookie 可选显式传入：手动粘贴 Cookie 登录时先用粘贴内容验证，不落 localStorage。
 */
export async function getSodaStatus(cookie?: string): Promise<SodaStatus> {
  const data = await sodaGet<{
    loggedIn?: boolean
    profile?: {
      userId?: string | number
      nickname?: string
      avatarUrl?: string
      vipLabel?: string
      isVip?: boolean
      isSvip?: boolean
      expiresAt?: number
    }
    membership?: SodaMembership
  }>('/status', {}, cookie)
  if (!data) return { loggedIn: false, membership: {} }
  const p = data.profile
  const profile: SodaProfile | undefined = p && (p.userId !== undefined || p.nickname)
    ? {
        userId: String(p.userId ?? ''),
        nickname: String(p.nickname ?? ''),
        avatarUrl: p.avatarUrl ? String(p.avatarUrl) : undefined,
        vipLabel: p.vipLabel ? String(p.vipLabel) : undefined,
        isVip: Boolean(p.isVip),
        isSvip: Boolean(p.isSvip),
        expiresAt: typeof p.expiresAt === 'number' ? p.expiresAt : undefined,
      }
    : undefined
  return {
    loggedIn: Boolean(data.loggedIn),
    profile,
    membership: data.membership || {},
  }
}

/**
 * 汽水音乐搜索：优先本地后端 /search（登录态可用、字段更全）；
 * 后端失败/未就绪时退回旧火山公开目录，再退回主进程 DOM 抓取桥（保持原兼容链）。
 */
export async function searchSodaSongs(keyword: string, limit = 30): Promise<Song[]> {
  const kw = keyword.trim()
  if (!kw) return []
  const data = await sodaGet<{ songs?: SodaSong[] }>('/search', { keywords: kw, limit })
  const mapped = mapSodaSongs(data?.songs)
  if (mapped.length) return mapped
  // 兜底：旧火山公开目录（保留原有字段映射）
  const items = await publicSearch(kw, limit)
  const source = items.length ? items : await scrapeSearch(kw, limit)
  return source.map(item => douyinMusicToSong(item))
}

// ────────────────────────────── 推荐 / 榜单 ──────────────────────────────

/** 个性化推荐流（需登录；未登录/失败返回空列表） */
export async function fetchSodaFeed(limit = 30): Promise<{ name?: string; songs: Song[] }> {
  const data = await sodaGet<{ name?: string; songs?: SodaSong[] }>('/feed', { limit })
  return {
    name: data?.name ? String(data.name) : undefined,
    songs: mapSodaSongs(data?.songs),
  }
}

/** 每日推荐（未登录时后端返回公开推荐，personalized=false） */
export async function fetchSodaDaily(): Promise<{ songs: Song[]; personalized: boolean }> {
  const data = await sodaGet<{ songs?: SodaSong[]; personalized?: boolean }>('/daily')
  return {
    songs: mapSodaSongs(data?.songs),
    personalized: Boolean(data?.personalized),
  }
}

/** 官方榜单组（每组 songs 已映射为 Song；请求失败返回空数组） */
export async function fetchSodaCharts(): Promise<Array<SodaChartGroup & { songs: Song[] }>> {
  const data = await sodaGet<{
    charts?: Array<{ id?: string | number; name?: string; group?: string; description?: string; songs?: SodaSong[] }>
  }>('/charts')
  if (!Array.isArray(data?.charts)) return []
  return data.charts
    .map(chart => ({
      id: String(chart?.id ?? chart?.name ?? ''),
      name: String(chart?.name || '未命名榜单'),
      group: String(chart?.group || '汽水音乐'),
      description: chart?.description ? String(chart.description) : undefined,
      songs: mapSodaSongs(chart?.songs),
    }))
    .filter(chart => chart.id && chart.songs.length > 0)
}

// ────────────────────────────── 歌单 ──────────────────────────────

/** 用户歌单列表（含「我喜欢」类虚拟歌单标记；未登录/失败返回空数组） */
export async function fetchSodaUserPlaylists(): Promise<SodaPlaylistSummary[]> {
  const data = await sodaGet<{
    playlists?: Array<{
      id?: string | number
      name?: string
      coverUrl?: string
      trackCount?: number
      isLikedLike?: boolean
      collected?: boolean
    }>
  }>('/user/playlists')
  if (!Array.isArray(data?.playlists)) return []
  return data.playlists
    .filter(p => p && p.id !== undefined)
    .map(p => ({
      id: String(p.id),
      name: String(p.name || '未命名歌单'),
      coverUrl: p.coverUrl ? String(p.coverUrl) : undefined,
      trackCount: typeof p.trackCount === 'number' ? p.trackCount : undefined,
      isLikedLike: Boolean(p.isLikedLike),
      collected: p.collected === undefined ? undefined : Boolean(p.collected),
    }))
}

/**
 * 歌单曲目（支持虚拟歌单 qishui-feed / qishui-liked / qishui-recent）。
 * 失败时返回空歌单壳（不抛错）。
 */
export async function fetchSodaPlaylistTracks(id: string, offset = 0, limit = 50): Promise<SodaPlaylistTracks> {
  if (!id) return { id: '', name: '', tracks: [], trackCount: 0 }
  const data = await sodaGet<{
    id?: string | number
    name?: string
    coverUrl?: string
    trackCount?: number
    tracks?: SodaSong[]
  }>('/playlist/tracks', { id, offset, limit })
  const tracks = mapSodaSongs(data?.tracks)
  const trackCount = Number(data?.trackCount ?? tracks.length) || 0
  return {
    id: String(data?.id ?? id),
    name: String(data?.name || ''),
    coverUrl: data?.coverUrl ? String(data.coverUrl) : undefined,
    tracks,
    trackCount,
    hasMore: offset + tracks.length < trackCount,
  }
}

/** 把歌曲加入汽水歌单（song 字段按后端契约裁剪为 id/name/artist/album/durationMs） */
export async function addSodaSongToPlaylist(pid: string, song: Song): Promise<boolean> {
  if (!pid || !song) return false
  const data = await sodaPost<{ success?: boolean }>('/playlist/add-song', {
    pid,
    song: {
      id: song.mid || String(song.id),
      name: song.name,
      artist: song.artists?.[0]?.name || '',
      album: song.album?.name || '',
      durationMs: song.duration || 0,
    },
  })
  return Boolean(data?.success)
}

/** 收藏/取消收藏歌单 */
export async function collectSodaPlaylist(id: string, collected: boolean): Promise<boolean> {
  if (!id) return false
  const data = await sodaPost<{ success?: boolean }>('/playlist/collect', { id, collected })
  return Boolean(data?.success)
}

/** 收藏/取消收藏专辑 */
export async function collectSodaAlbum(id: string, collected: boolean): Promise<boolean> {
  if (!id) return false
  const data = await sodaPost<{ success?: boolean }>('/album/collect', { id, collected })
  return Boolean(data?.success)
}

// ────────────────────────────── 喜欢 / 上报 ──────────────────────────────

/** 批量查询喜欢状态（入参/返回键均为汽水原始曲目 id 字符串） */
export async function checkSodaLiked(ids: string[]): Promise<Record<string, boolean>> {
  const validIds = ids.map(id => String(id || '').trim()).filter(Boolean)
  if (!validIds.length) return {}
  const data = await sodaGet<{ liked?: Record<string, boolean> }>('/song/like/check', { ids: validIds.join(',') })
  if (!data?.liked || typeof data.liked !== 'object') return {}
  const liked: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(data.liked)) {
    liked[String(key)] = Boolean(value)
  }
  return liked
}

/** 喜欢/取消喜欢单曲（可选携带 song 对象便于后端补全曲目资料） */
export async function setSodaTrackLiked(id: string, like: boolean, song?: Song): Promise<boolean> {
  if (!id) return false
  const body: Record<string, unknown> = { id, like }
  if (song) {
    body.song = {
      id: song.mid || String(song.id),
      name: song.name,
      artist: song.artists?.[0]?.name || '',
      album: song.album?.name || '',
      durationMs: song.duration || 0,
    }
  }
  const data = await sodaPost<{ success?: boolean }>('/song/like', body)
  return Boolean(data?.success)
}

/** 上报一次播放（埋点/近期播放统计；失败静默） */
export async function reportSodaPlay(id: string): Promise<void> {
  if (!id) return
  await sodaPost<{ success?: boolean }>('/report/play', { id })
}

// ────────────────────────────── 评论 ──────────────────────────────

function mapSodaComment(raw: any): SodaComment {
  const replies = Array.isArray(raw?.replies) ? raw.replies.map(mapSodaComment) : undefined
  return {
    id: String(raw?.id ?? ''),
    user: {
      name: String(raw?.user?.name ?? ''),
      avatarUrl: raw?.user?.avatarUrl ? String(raw.user.avatarUrl) : undefined,
    },
    content: String(raw?.content ?? ''),
    likes: typeof raw?.likes === 'number' ? raw.likes : Number(raw?.likes || 0),
    // time 可能是格式化字符串或 ms 时间戳，原样透传由 UI 判断展示
    time: typeof raw?.time === 'number' || typeof raw?.time === 'string' ? raw.time : '',
    replies: replies && replies.length ? replies : undefined,
  }
}

/**
 * 歌曲评论列表（游标分页）。
 * comments 内 time 为可显示字符串或 ms 时间戳（见 SodaComment 注释）。
 */
export async function fetchSodaComments(
  id: string,
  cursor?: string,
  limit = 20,
): Promise<{ comments: SodaComment[]; cursor?: string; hasMore: boolean }> {
  if (!id) return { comments: [], hasMore: false }
  const data = await sodaGet<{ comments?: unknown[]; cursor?: string | number; hasMore?: boolean }>(
    '/song/comments',
    { id, limit, cursor },
  )
  const comments = Array.isArray(data?.comments) ? data.comments.map(item => mapSodaComment(item)) : []
  return {
    comments,
    cursor: data?.cursor !== undefined && data.cursor !== null ? String(data.cursor) : undefined,
    hasMore: Boolean(data?.hasMore),
  }
}

/** 发表评论（成功返回 true；失败静默 false） */
export async function createSodaComment(id: string, text: string): Promise<boolean> {
  const content = text.trim()
  if (!id || !content) return false
  const data = await sodaPost<{ success?: boolean }>('/song/comments', { id, content })
  return Boolean(data?.success)
}

// ────────────────────────────── 歌词 ──────────────────────────────

/** LRC 文本 → LyricLine[]（保留原时间戳解析器：支持 [mm:ss]、[mm:ss.xx]、[mm:ss.xxx]，一行多时间戳） */
function parseLrcLines(lrc: string): LyricLine[] {
  if (!lrc || !lrc.includes('[')) return []
  const lines: LyricLine[] = []
  const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  for (const raw of lrc.split('\n')) {
    const match = raw.match(timeRe)
    const text = raw.replace(timeRe, '').trim()
    if (!match || !text) continue
    for (const m of match) {
      const parts = m.slice(1, -1).split(/[:.]/)
      const min = Number(parts[0] || 0)
      const sec = Number(parts[1] || 0)
      const frac = parts[2] ? Number(parts[2].padEnd(3, '0').slice(0, 3)) : 0
      lines.push({ time: min * 60 + sec + frac / 1000, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

/** 拉取原文/翻译 LRC 原文（先走后端 /lyric，失败回退旧火山详情接口仅取原文）。
 *  words：后端 yrc 命中时的结构化逐字时间轴（绝对毫秒，翻译已内联 translated）；平铺 LRC 兜底时为 undefined。 */
async function fetchSodaLyricText(id: string): Promise<{ lyric: string; tlyric: string; words?: SodaWordRowWire[] }> {
  const data = await sodaGet<{ lyric?: string; tlyric?: string; words?: unknown }>('/lyric', { id })
  // 判空放宽到 words：yrc 命中但 lyric 为空的极端形态（仅译文）也保留逐字与翻译，
  // 不再让旧火山兜底覆盖后端结果。
  if (data?.lyric || data?.tlyric || data?.words) {
    return {
      lyric: String(data.lyric || ''),
      tlyric: String(data.tlyric || ''),
      words: asSodaWordRows(data.words) || undefined,
    }
  }
  // 兜底：旧火山公开目录详情（仅原文）
  try {
    const resp = await fetch(`${QISHUI_API}/detail?id=${encodeURIComponent(id)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (resp.ok) {
      const json = (await resp.json()) as { lyric?: string }
      return { lyric: String(json?.lyric || ''), tlyric: '' }
    }
  } catch (e) {
    console.warn('[汽水] 旧版歌词兜底失败:', e)
  }
  return { lyric: '', tlyric: '' }
}

/**
 * 汽水音乐歌词（LRC 解析为 LyricLine[]；无歌词返回 []）。
 * 单次请求同时取原文+翻译+可选逐字（words）：
 * - yrc 命中 → sodaLyrics.ts 把汽水上游结构归一化成网易云 parseYrc 同构的 LyricLine 契约
 *   （time 秒 / word.startTime 相对行首毫秒），翻译走后端内联的 translated；
 * - 无 words（平铺 LRC/公开目录兜底）→ 维持既有 LRC 解析 + ≤500ms 贪心对齐挂 translation。
 */
export async function getSodaLyrics(id: string): Promise<LyricLine[]> {
  if (!id) return []
  const { lyric, tlyric, words } = await fetchSodaLyricText(String(id))
  const wordRows = asSodaWordRows(words)
  if (wordRows) return sodaWordRowsToLyricLines(wordRows)
  const lines = parseLrcLines(lyric)
  const transLines = parseLrcLines(tlyric)
  if (!lines.length || !transLines.length) return lines
  // 时间戳贪心对齐：译文与主歌词行时间差 ≤500ms 视为同一行（规则与 getSodaTranslation 一致）
  let pointer = 0
  const TOLERANCE_SEC = 0.5
  for (let i = 0; i < lines.length; i += 1) {
    while (pointer < transLines.length && transLines[pointer].time < lines[i].time - TOLERANCE_SEC) {
      pointer += 1
    }
    const candidate = transLines[pointer]
    if (candidate && Math.abs(candidate.time - lines[i].time) <= TOLERANCE_SEC) {
      lines[i] = { ...lines[i], translation: candidate.text }
    }
  }
  return lines
}

/**
 * 翻译歌词：返回 { 主歌词行序号: 译文 } 映射。
 * 对齐规则：tlyric 时间戳与主歌词行时间差 ≤500ms 视为同一行。
 */
export async function getSodaTranslation(id: string): Promise<Record<number, string>> {
  if (!id) return {}
  // 基于 getSodaLyrics 的投影：请求一次、对齐逻辑唯一实现，避免重复打 /api/soda/lyric
  const mainLines = await getSodaLyrics(String(id))
  const result: Record<number, string> = {}
  mainLines.forEach((line, i) => {
    const text = line.translation?.trim()
    if (text) result[i] = text
  })
  return result
}

// ────────────────────────────── 播放地址 ──────────────────────────────

/** 请求播放地址详情（不可播时 url 为 null，附会员档位与原因供 UI 提示） */
async function requestSodaPlaybackInfo(id: string): Promise<SodaPlaybackInfo> {
  if (!id) return { url: null }
  const data = await sodaGet<{
    url?: string
    playable?: boolean
    requiredTier?: 'free' | 'vip' | 'svip'
    membership?: SodaMembership
    reason?: string
  }>('/song/url', { id })
  const url = data?.url ? String(data.url) : ''
  const playable = url !== '' && data?.playable !== false
  return {
    url: playable ? url : null,
    requiredTier: data?.requiredTier,
    vipLabel: data?.membership?.vipLabel ? String(data.membership.vipLabel) : undefined,
    reason: data?.reason ? String(data.reason) : undefined,
  }
}

/**
 * 汽水音乐播放直链（真实现：调后端 /song/url）。
 * 成功返回 url 字符串；不可播/未登录/失败返回 null（上层降级跨平台匹配）。
 */
export async function getSodaSongUrl(id: string): Promise<string | null> {
  const info = await requestSodaPlaybackInfo(String(id || ''))
  return info.url
}

/** 播放地址详情（含 requiredTier/vipLabel/reason，供 UI 显示 VIP 提示） */
export async function getSodaPlaybackInfo(id: string): Promise<SodaPlaybackInfo> {
  return requestSodaPlaybackInfo(String(id || ''))
}

// ────────────────────────────── 艺人 / 专辑 ──────────────────────────────

/** 艺人热门歌曲（按艺人名查询；失败返回空数组） */
export async function fetchSodaArtistSongs(name: string, limit = 30): Promise<Song[]> {
  const key = String(name || '').trim()
  if (!key) return []
  const data = await sodaGet<{ artist?: { name?: string }; songs?: SodaSong[] }>('/artist/songs', {
    name: key,
    limit,
  })
  return mapSodaSongs(data?.songs)
}

/** 专辑曲目（nameOrId：纯数字按专辑 id 查询，否则按专辑名查询；失败返回空壳） */
export async function fetchSodaAlbumTracks(nameOrId: string): Promise<{ album: SodaAlbumSummary; tracks: Song[] }> {
  const key = String(nameOrId || '').trim()
  if (!key) return { album: { name: '' }, tracks: [] }
  const params = /^\d+$/.test(key) ? { id: key } : { name: key }
  const data = await sodaGet<{
    album?: { id?: string | number; name?: string; coverUrl?: string }
    tracks?: SodaSong[]
  }>('/album/tracks', params)
  return {
    album: {
      id: data?.album?.id !== undefined
        ? String(data.album.id)
        : /^\d+$/.test(key)
          ? key
          : undefined,
      name: String(data?.album?.name || key),
      coverUrl: data?.album?.coverUrl ? String(data.album.coverUrl) : undefined,
    },
    tracks: mapSodaSongs(data?.tracks),
  }
}

// ────────────────────────────── 探索页聚合 ──────────────────────────────

/** 旧探索页关键词（后端全空时的兜底聚合仍复用） */
const SODA_EXPLORE_KEYWORDS = ['抖音热歌', '网络热歌', '热门歌曲', '新歌']

/** 火山引擎公开目录搜索（兜底；替代抖音 DOM 抓取，无需登录/签名） */
async function publicSearch(keyword: string, limit = 30): Promise<DouyinMusicItem[]> {
  try {
    const resp = await fetch(`${QISHUI_API}/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`, {
      cache: 'no-store',
    })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs
      .map((s: { id?: string; name?: string; artist?: string; coverUrl?: string; durationMs?: number; album?: string }) => ({
        id: String(s.id || ''),
        name: String(s.name || ''),
        author: String(s.artist || ''),
        cover: String(s.coverUrl || ''),
        durationMs: Number(s.durationMs || 0),
        album: String(s.album || ''),
      }))
      .filter((s: { id: string; name: string }) => s.id && s.name)
  } catch (e) {
    console.warn('[汽水] 公开搜索失败:', e)
    return []
  }
}

/** 抓取超时：主进程隐藏窗口每轮最长 6s，这里兜底 8s，避免首页/探索无限转圈 */
const SCRAPE_TIMEOUT_MS = 8000

/** 主进程抖音 DOM 抓取桥（最后一级兜底） */
async function scrapeSearch(keyword: string, limit = 30): Promise<DouyinMusicItem[]> {
  const bridge = (window as any).electron
  if (!bridge?.sodaScrapeSearch) return []
  try {
    const result = await Promise.race([
      bridge.sodaScrapeSearch(keyword),
      new Promise<null>(resolve => setTimeout(() => resolve(null), SCRAPE_TIMEOUT_MS)),
    ])
    if (!result?.success || !Array.isArray(result.items)) return []
    return result.items.slice(0, limit)
  } catch (e) {
    console.warn('[汽水] 搜索抓取失败:', e)
    return []
  }
}

/** 兜底聚合：关键词并行抓取（先公开目录，全失败再并行 DOM 抓取） */
async function legacyCollectExploreItems(): Promise<DouyinMusicItem[]> {
  const collected = new Map<string, DouyinMusicItem>()
  const publicResults = await Promise.allSettled(SODA_EXPLORE_KEYWORDS.map(keyword => publicSearch(keyword, 24)))
  let anyPublic = false
  for (const result of publicResults) {
    if (result.status !== 'fulfilled' || !result.value.length) continue
    anyPublic = true
    for (const item of result.value) {
      if (item.id && !collected.has(item.id)) collected.set(item.id, item)
    }
  }
  if (!anyPublic) {
    const scrapeResults = await Promise.allSettled(SODA_EXPLORE_KEYWORDS.map(keyword => scrapeSearch(keyword, 24)))
    for (const result of scrapeResults) {
      if (result.status !== 'fulfilled') continue
      for (const item of result.value) {
        if (item.id && !collected.has(item.id)) collected.set(item.id, item)
      }
    }
  }
  return [...collected.values()].slice(0, 40)
}

/** 探索页聚合结果（保持既有消费形状不变） */
export interface SodaExploreResult {
  playlists: Array<{ id: string; name: string; coverUrl?: string }>
  songs: Song[]
  charts: Array<{ id: string; name: string; group: string; songs: Song[] }>
}

/**
 * 探索页数据（升级版）：并行取 charts + daily +（登录时）feed 与用户歌单卡片。
 * - charts：后端榜单组直接映射（每榜截前 12 首作图表卡）；
 * - playlists：真实推荐歌单卡（登录用户歌单优先，coverUrl 有则填），
 *   不足 8 张时用榜单组名补齐伪歌单卡（封面取该组第一首歌）；
 * - songs：daily → feed → 榜单聚合去重（上限 60 首）；
 * - 后端整体为空时回退旧关键词聚合链路，保证探索页不空白。
 */
export async function fetchSodaExplore(): Promise<SodaExploreResult> {
  const loggedIn = isSodaLoggedIn()
  const [chartGroups, daily, feed, userPlaylists] = await Promise.all([
    fetchSodaCharts(),
    fetchSodaDaily(),
    loggedIn ? fetchSodaFeed(24) : Promise.resolve({ songs: [] as Song[] }),
    loggedIn ? fetchSodaUserPlaylists() : Promise.resolve([] as SodaPlaylistSummary[]),
  ])

  const charts: SodaExploreResult['charts'] = chartGroups
    .slice(0, 6)
    .map(group => ({
      id: group.id,
      name: group.name,
      group: group.group || '汽水音乐',
      songs: group.songs.slice(0, 12),
    }))
    .filter(chart => chart.songs.length > 0)

  // 推荐歌曲池去重合并：每日推荐 → 个性推荐 → 各榜单
  const merged = new Map<string, Song>()
  const pushAll = (list?: Song[]) => {
    for (const song of list || []) {
      if (song.mid && !merged.has(song.mid)) merged.set(song.mid, song)
    }
  }
  pushAll(daily.songs)
  pushAll(feed.songs)
  for (const chart of charts) pushAll(chart.songs)

  // 后端整体为空（未实现/全挂）→ 回退旧关键词聚合，保证探索页有内容
  if (!merged.size) {
    const items = await legacyCollectExploreItems()
    const all = items.map(douyinMusicToSong)
    for (const song of all) {
      if (song.mid && !merged.has(song.mid)) merged.set(song.mid, song)
    }
    charts.push(
      ...SODA_EXPLORE_KEYWORDS.slice(0, 3)
        .map((keyword, index) => ({
          id: `soda-hot-${index}`,
          name: `抖音${keyword}榜`,
          group: '汽水音乐',
          songs: all.slice(index * 8, index * 8 + 8),
        }))
        .filter(chart => chart.songs.length > 0),
    )
  }

  // 歌单卡：真实用户歌单优先，再用榜单组名补齐（封面取该组首曲）
  const playlists: SodaExploreResult['playlists'] = []
  for (const playlist of userPlaylists.slice(0, 8)) {
    playlists.push({ id: playlist.id, name: playlist.name, coverUrl: playlist.coverUrl })
  }
  for (const chart of charts) {
    if (playlists.length >= 8) break
    if (playlists.some(item => item.id === chart.id || item.name === chart.name)) continue
    playlists.push({
      id: chart.id,
      name: chart.name,
      coverUrl: chart.songs[0]?.album?.picUrl || undefined,
    })
  }

  return {
    playlists,
    songs: [...merged.values()].slice(0, 60),
    charts,
  }
}

// ────────────────────────────── 旧映射（向后兼容） ──────────────────────────────

/** 抖音音乐 → WaveForge Song（id 用抖音 music_id；mid 保留原始 id） */
export function douyinMusicToSong(item: DouyinMusicItem): Song {
  const rawId = String(item.id || '')
  const name = item.name || item.text || '未知歌曲'
  const author = item.author || ''
  return {
    id: Number(rawId.slice(0, 15)) || 0,
    mid: rawId,
    name,
    artists: author ? [{ name: author }] : [],
    album: {
      name: item.album || '',
      picUrl: item.cover || '',
    },
    duration: item.durationMs || 0,
    platform: 'soda' as const,
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}
