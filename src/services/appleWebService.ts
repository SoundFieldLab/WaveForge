/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 探索页 web 端适配服务（逆向自 music.apple.com 前端 bundle 的 amp-api 调用）
 *
 * 页面结构（与 web 播放器 1:1，2026-08 实测端点）：
 * - 主页（Listen Now）：/v1/me/recommendations?name 缺省（登录态个性化组：专属推荐/最近播放/口味组…）
 * - 新发现（Browse，web /new）：/v1/editorial/{sf}/groupings?name=browse&platform=web&tabs=subscriber
 *   响应为 editorial-elements 树：[316] 容器 → [317] 徽章卡（designBadge + contents[0]）/
 *   [320] 宽幅横幅（designTag）/ [326] 网格区（stations/songs/playlists）
 * - 广播（Radio，web /radio）：groupings?name=radio，Subscriber tab：
 *   [320] 推荐单集（宽幅大卡 + 电台单集）/ [326] 新近内容·艺人接管麦克风·热门电台·风格电台 /
 *   [385]→[394] 电台主持人·艺人主持节目（节目卡）
 * - 搜索落地（web /search 无关键词）：/v1/recommendations/{sf}?name=search-landing（类别浏览 = apple-curators）
 * - 分类页（web /curator/{slug}/{id}）：/v1/catalog/{sf}?ids[apple-curators]={id}&include=grouping,playlists
 * - 排行榜（web /new/top-charts）：/v1/catalog/{sf}/charts?with=cityCharts,dailyGlobalTopCharts
 * - 歌曲详情（web /song/…）：/v1/catalog/{sf}/songs/{id}?include=albums,artists + /lyrics（MUT）
 * - 动态封面：playlists/stations/albums ?extend=editorialVideo → motionDetailSquare（HLS .m3u8 + 预览帧）
 *
 * 均为「登录优先、未登录兜底」；storefront 使用账号商店（/v1/me/storefront）。
 */
import { appleApiRequest } from './appleApiBridge'
import { getAppleCredentials } from './appleAuth'
import {
  getAppleEditorialPlaylists,
  getAppleHotSongs,
  getAppleCatalogPlaylistTracks,
  getAppleLibrarySongs,
  getAppleLibraryAlbums,
  getAppleLibraryArtists,
  getAppleLibraryPlaylists,
  getAppleLibraryMusicVideos,
  getAppleRecentPlayed,
  getAppleLibraryAlbumTracks,
  getAppleLibraryArtistAlbums,
  getApplePlaylistTracks,
  appleLibraryTrackToSong,
  appleSongToSong,
  type AppleCatalogSong,
  type AppleLibraryAlbum,
} from './appleCatalog'
import { toHighResArtwork } from './appleMusic'
import { sanitizeAppleRadioPlayParams, type AppleNativeStream, type AppleRadioPlayParams } from './applePlayback'
import { cachePersonalStation, isPersonalStationId, protectStationName } from '../utils/applePrivacy'
import { parseTTML } from '../utils/ttmlParser'
import type { Song } from './musicApi'

/** 转发诊断到主进程控制台（无 UI） */
function forwardToMainLog(message: string): void {
  try {
    const bridge = (window as any).electron
    if (bridge && typeof bridge.log === 'function') bridge.log(message)
  } catch { /* 忽略 */ }
}

// ─────────────────────────── 类型 ───────────────────────────

export type AppleWebItemType = 'songs' | 'playlists' | 'albums' | 'stations' | 'radio-shows' | 'artists' | 'music-videos' | 'uploaded-videos' | 'posts' | 'rooms' | 'curators' | 'groupings'

export interface AppleWebItem {
  id: string
  /** 播放/打开用的目录 id（library 类条目优先用 catalog 关联 id） */
  playId: string
  type: AppleWebItemType
  name: string
  subtitle?: string
  description?: string
  artworkUrl?: string
  /** 动态封面 HLS 流（editorialVideo.motion*.video，.m3u8） */
  motionArtworkUrl?: string
  /** 动态封面静态帧（editorialVideo.motion*.previewFrame.url） */
  motionPosterUrl?: string
  /** 编辑横幅大图（hero/编辑元素用） */
  heroArtworkUrl?: string
  artistName?: string
  artistId?: string
  albumId?: string
  /** 歌曲所属专辑名（editorial room 歌曲表格的「专辑」列）。 */
  albumName?: string
  durationMs?: number
  curatorName?: string
  trackCount?: number
  releaseDate?: string
  /** stations：所属节目 */
  showName?: string
  /** 库资源自身 id；recently-added 等混合资源保留用于库内操作。 */
  libraryId?: string
  /** 库资源关联的目录 id；播放和目录详情优先使用。 */
  catalogId?: string
  /** 库内条目（点击走库内详情/曲目，而非目录打开） */
  isLibrary?: boolean
  /** 该条目在 web 上的 canonical url */
  url?: string
  // ── 编辑元素字段（browse/radio 卡片） ──
  /** designBadge：推荐歌单 / 新专辑 / 新单曲 / 推荐单集 … */
  badge?: string
  /** designTag：横幅说明文案 */
  tag?: string
  /** Apple presentation card 的短标签（如“专属推荐”“下一首”）。 */
  editorialLabel?: string
  /** Apple presentation card 的说明文案。 */
  editorialTagline?: string
  /** 元素自带宽幅横幅图（[320]/[394] 编辑元素） */
  bannerUrl?: string
  // ── 电台字段 ──
  stationHash?: string
  isLive?: boolean
  airTime?: { start?: string; end?: string }
  contentRating?: string
  /** stations：playParams（直播取流 /v1/play/assets 的查询参数） */
  playParams?: AppleRadioPlayParams
  /** stations：resource 自带的 offers[0].hlsUrl（部分电台免 play/assets 直接可播） */
  offersHlsUrl?: string
  /** offers 快捷流是否声明 DRM；未知时不得绕过 play/assets 的 license 信息 */
  offersHasDrm?: boolean
  // ── 歌曲字段（详情页用） ──
  audioTraits?: string[]
  composerName?: string
  genreNames?: string[]
  isrc?: string
  /** 30s 预览（previews[0].url） */
  previewUrl?: string
}

export type AppleWebSectionKind =
  /** 主页专属精选推荐（powerswoosh 纵向大卡） */
  | 'home-featured'
  /** [317] 徽章卡（新发现主视觉网格） */
  | 'featured-cards'
  /** [320] 宽幅横幅（带 designTag 文案） */
  | 'banner'
  /** [394] 节目卡（电台主持人 / 艺人主持节目） */
  | 'show-cards'
  /** [326]/[327] 网格区（电台单集 / 歌曲 / 歌单） */
  | 'grid'
  /** 新发现精品推荐（两列宽卡） */
  | 'new-hero'
  /** 新发现歌曲三列列表 */
  | 'song-grid'
  /** 新发现方形专辑/歌单 shelf */
  | 'album-shelf'
  /** 新发现电台节目三列网格 */
  | 'station-grid'
  /** 新发现视频/帖子 shelf */
  | 'video-shelf'
  /** 新发现底部入口网格 */
  | 'explore-links'
  /** 主页横向行（listen-now 个性化组） */
  | 'row'
  /** 排行榜（charts 端点） */
  | 'chart'
  /** 搜索落地：类别浏览（apple-curators） */
  | 'curators'
  /** [404] 纯文本区块（如「空间音频 Q&A」，description 为 HTML） */
  | 'text-block'

export interface AppleWebSection {
  id: string
  kind: AppleWebSectionKind
  title: string
  subtitle?: string
  /** Apple Web 返回的真实 shelf presentation 类型。 */
  displayKind?: string
  items: AppleWebItem[]
  /** banner 专用：宽幅图 */
  bannerUrl?: string
  /** banner 专用：说明文案（designTag） */
  tag?: string
  /** chart 专用：榜单类型（most-played / daily-global-top / city-top） */
  chartType?: string
  /** Apple editorial section 的真实详情入口（通常为 room URL）。 */
  url?: string
  /** [326]/[327]/[345] 的 room 引用（标题 `>` 入口）；取自 relationships.room，而非拼接 URL。 */
  roomId?: string
  /** [320] banner 指向的 multi-room id（link.url 的 viewMultiRoom?fcId=）。 */
  multiRoomId?: string
  /** 编辑元素 layout 提示：`track`=歌曲轨表格，`normal`=普通内容货架。 */
  layoutType?: string
  /** 编辑元素布局风格：`compact`=每屏 1 行，`expanded`=每屏 2 行（观测推断）。 */
  displayStyle?: string
  /** [404] 纯文本区块正文（HTML）。 */
  bodyHtml?: string
}

export interface AppleWebPage {
  sections: AppleWebSection[]
  /** 页面主视觉（web powerswoosh 大卡；仅主页使用） */
  hero?: AppleWebItem | null
  /** 是否登录态个性化数据 */
  personalized: boolean
  /** 数据来源说明（展示用） */
  sourceLabel: string
  /** 个性化内容不可用时的脱敏原因；页面仍可展示公开回退内容。 */
  fallbackReason?: string
  /** 当前失败是否需要用户重新登录 Apple Music。 */
  requiresLogin?: boolean
}

/** 兼容旧引用 */
export type AppleWebRow = AppleWebSection

/**
 * 探索页可跳转目标。官网 editorial 元素与「探索更多」链接大量使用 legacy URL
 * （WebObjects/MZStore.woa、itunes.apple.com/collection?fcId= 等），此处统一归一化，
 * 供服务层与 UI 共用，避免各处按字符串猜目标类型。
 */
export type AppleExploreTarget =
  | { kind: 'room'; id: string }
  | { kind: 'grouping'; id: string }
  | { kind: 'multiroom'; id: string }
  | { kind: 'curator'; id: string }
  | { kind: 'charts' }
  | { kind: 'external'; url: string }

/** legacy / 现代 URL → 探索目标。无法识别时返回 null。 */
export function resolveExploreTarget(rawUrl: string | undefined): AppleExploreTarget | null {
  const raw = String(rawUrl || '').trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw, 'https://music.apple.com')
  } catch {
    return null
  }
  const path = url.pathname
  const search = url.searchParams

  // legacy：viewMultiRoom?fcId= / viewGrouping?id= / viewTop?genreId=
  if (/\/viewMultiRoom$/i.test(path)) {
    const fcId = search.get('fcId')
    return fcId ? { kind: 'multiroom', id: fcId } : null
  }
  if (/\/viewGrouping$/i.test(path)) {
    const id = search.get('id')
    return id ? { kind: 'grouping', id } : null
  }
  if (/\/viewTop$/i.test(path)) return { kind: 'charts' }
  if (/\/collection\//i.test(path)) {
    const fcId = search.get('fcId')
    return fcId ? { kind: 'room', id: fcId } : null
  }

  // 现代路径
  const room = path.match(/\/room\/(\d+)\/?$/)
  if (room) return { kind: 'room', id: room[1] }
  const multiRoom = path.match(/\/multi-room\/(\d+)\/?$/)
  if (multiRoom) return { kind: 'multiroom', id: multiRoom[1] }
  const grouping = path.match(/\/grouping\/(\d+)\/?$/)
  if (grouping) return { kind: 'grouping', id: grouping[1] }
  const curator = path.match(/\/curator\/[^/]+\/(\d+)\/?$/)
  if (curator) return { kind: 'curator', id: curator[1] }
  if (/\/new\/top-charts\/?$/i.test(path)) return { kind: 'charts' }

  if (/^https?:/i.test(raw)) return { kind: 'external', url: raw }
  return null
}

// ─────────────────────────── 工具 ───────────────────────────

function getStorefront(): string {
  try {
    return localStorage.getItem('appleStorefront') || 'cn'
  } catch {
    return 'cn'
  }
}

const art = (attributes: any, size = 420): string => toHighResArtwork(attributes?.artwork?.url || '', size)

/** 编辑元素宽幅横幅（4320×1080 源，取 1600 宽） */
const bannerArt = (attributes: any, size = 1600): string => toHighResArtwork(attributes?.artwork?.url || '', size)

function catalogIdOf(resource: any): string {
  const catalog = resource?.relationships?.catalog?.data?.[0]?.id
  return catalog ? String(catalog) : String(resource?.id ?? '')
}

/**
 * Apple 接口的标题/名称字段有时是字符串，有时是 { stringForDisplay: '…' } 之类的
 * 对象（不同接口/资源形态不一）。统一归一化为字符串，避免把对象渲染成 React 子元素
 * 触发 error #31（Objects are not valid as a React child）。
 */
function displayString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const inner = obj.stringForDisplay ?? obj.title ?? obj.name ?? obj.label
    return typeof inner === 'string' ? inner : ''
  }
  return ''
}

/** 可作为卡片/行展示的内容类型（editorial contents 白名单） */
const CONTENT_TYPES: string[] = ['songs', 'albums', 'playlists', 'stations', 'radio-shows', 'radio-show', 'artists', 'music-videos', 'uploaded-videos', 'posts', 'rooms', 'curators', 'apple-curators', 'groupings']

function normalizeContentType(type: string): AppleWebItemType | null {
  if (type === 'radio-show') return 'radio-shows'
  // 策展人在响应中的类型为 apple-curators，统一归一到 curators。
  if (type === 'apple-curators') return 'curators'
  if (type === 'library-albums') return 'albums'
  if (type === 'library-playlists') return 'playlists'
  if (type === 'library-songs' || type === 'uploaded-audios') return 'songs'
  if (type === 'library-music-videos') return 'music-videos'
  return CONTENT_TYPES.includes(type) ? type as AppleWebItemType : null
}

function itemize(resource: any, type: AppleWebItemType, preferredId?: string, displayKind?: string): AppleWebItem | null {
  const attributes = resource?.attributes || {}
  const presentation = extractEditorialPresentation(resource, displayKind)
  const notes = presentation.notes
  const name = displayString(attributes.name) || displayString(attributes.title) || displayString(notes?.name)
  if (!name && !resource?.id) return null
  const playParams = attributes.playParams || {}
  // 个人电台（ra.u-）在开启隐私保护时全局显示为「**的歌单」。
  const rawName = name || displayString(attributes.title)
  const safeName = type === 'stations' ? protectStationName(rawName || '', String(resource.id || '')) : rawName
  // 策展人（类别浏览）官网标题用 shortName，完整名放在副标题。
  const displayName = type === 'curators' ? (attributes.shortName || safeName) : safeName
  const motion = extractMotionArtwork(resource, 600, displayKind)
  const playParamsFields = sanitizeAppleRadioPlayParams(playParams)
  return {
    id: String(resource.id || ''),
    playId: preferredId || catalogIdOf(resource),
    type,
    name: displayName,
    subtitle: type === 'songs' || type === 'albums' ? attributes.artistName
      : type === 'playlists' ? attributes.curatorName
        : type === 'curators' ? (attributes.name || 'Apple Music')
          : attributes.radioShowName || displayString(notes?.short) || attributes.editorialNotes?.short,
    description: displayString(notes?.tagline) || displayString(notes?.short) || attributes.description?.short || attributes.description?.standard || attributes.editorialNotes?.short || attributes.editorialNotes?.standard,
    artworkUrl: presentation.artworkUrl || art(attributes),
    motionArtworkUrl: motion.video,
    motionPosterUrl: motion.poster,
    heroArtworkUrl: extractHeroArtwork(resource, 1200, displayKind),
    artistName: attributes.artistName,
    artistId: resource?.relationships?.artists?.data?.[0]?.id ? String(resource.relationships.artists.data[0].id) : undefined,
    albumId: resource?.relationships?.albums?.data?.[0]?.id ? String(resource.relationships.albums.data[0].id) : undefined,
    albumName: attributes.albumName || displayString(resource?.relationships?.albums?.data?.[0]?.attributes?.name) || undefined,
    durationMs: attributes.durationInMillis || attributes.durationMillis || attributes.durationInMilliseconds,
    curatorName: attributes.curatorName,
    trackCount: attributes.trackCount ?? attributes.playlistTrackCount ?? (Array.isArray(resource?.relationships?.tracks?.data) ? resource.relationships.tracks.data.length : undefined),
    releaseDate: attributes.releaseDate,
    showName: attributes.radioShowName,
    url: attributes.url,
    editorialLabel: displayString(notes?.name) || displayString(presentation.card?.title) || undefined,
    editorialTagline: displayString(notes?.tagline) || displayString(notes?.short) || undefined,
    stationHash: playParams.stationHash,
    isLive: attributes.isLive,
    airTime: attributes.airTime ? { start: attributes.airTime.start, end: attributes.airTime.end } : undefined,
    contentRating: attributes.contentRating,
    playParams: Object.keys(playParamsFields).length > 0 ? playParamsFields : undefined,
    offersHlsUrl: Array.isArray(attributes.offers) && typeof attributes.offers[0]?.hlsUrl === 'string'
      ? attributes.offers[0].hlsUrl
      : undefined,
    offersHasDrm: Array.isArray(attributes.offers) && attributes.offers[0]
      ? (typeof attributes.offers[0].hasDrm === 'boolean'
          ? attributes.offers[0].hasDrm
          : typeof attributes.offers[0].drmType === 'string' || typeof attributes.offers[0].keyServerUrl === 'string'
            ? true
            : undefined)
      : undefined,
    audioTraits: Array.isArray(attributes.audioTraits) ? attributes.audioTraits : undefined,
    composerName: attributes.composerName,
    genreNames: Array.isArray(attributes.genreNames) ? attributes.genreNames : undefined,
    isrc: attributes.isrc,
    previewUrl: Array.isArray(attributes.previews) ? attributes.previews[0]?.url : undefined,
  }
}

/**
 * 从 resource 提取动态封面（editorialVideo.motion*.video=.m3u8 + previewFrame.url 静态帧）。
 * 实测键：motionDetailSquare / motionDetailTall / motionSquareVideo1x1 / motionTallVideo3x4 / motionWideVideo21x9。
 */
function extractMotionArtwork(resource: any, size = 600, displayKind?: string): { video?: string; poster?: string } {
  try {
    const attributes = resource?.attributes || {}
    const presentation = extractEditorialPresentation(resource, displayKind)
    const sources = [presentation.card?.editorialVideo, attributes.editorialVideo]
    const keys = displayKind === 'MusicNotesHeroShelf' || displayKind === 'MusicSuperHeroShelf'
      ? ['motionDetailTall', 'motionTallVideo3x4', 'motionHero', 'motionWideVideo21x9', 'motionDetailSquare', 'motionSquareVideo1x1', 'motionArtistSquare']
      : ['motionDetailSquare', 'motionSquareVideo1x1', 'motionArtistSquare', 'motionDetailTall', 'motionTallVideo3x4', 'motionWideVideo21x9', 'motionHero']
    for (const ev of sources) {
      for (const key of keys) {
        const node = ev?.[key]
        const video = node?.video
        if (typeof video === 'string' && /\.m3u8(?:$|[?#])/i.test(video)) {
          const frameUrl = node?.previewFrame?.url || ''
          const poster = typeof frameUrl === 'string' && frameUrl ? toHighResArtwork(frameUrl, size) : ''
          return { video, poster: poster || undefined }
        }
      }
    }
    return {}
  } catch {
    return {}
  }
}

function extractEditorialPresentation(resource: any, displayKind?: string): { card?: any; notes?: any; artworkUrl?: string } {
  const attributes = resource?.attributes || {}
  const rawCards = attributes.plainEditorialCard
  const cards = Array.isArray(rawCards)
    ? rawCards.filter(Boolean)
    : rawCards && typeof rawCards === 'object'
      ? Object.values(rawCards).filter(value => value && typeof value === 'object')
      : []
  const card = cards.find((candidate: any) => candidate?.display?.kind === displayKind || candidate?.kind === displayKind) || cards[0]
  const notes = card?.plainEditorialNotes || attributes.plainEditorialNotes || attributes.editorialNotes
  const artworkUrl = extractEditorialArtworkUrl(card?.editorialArtwork || attributes.editorialArtwork, displayKind, 600)
  return { card, notes, artworkUrl }
}

function extractEditorialArtworkUrl(editorialArtwork: any, displayKind?: string, size = 1200): string | undefined {
  if (!editorialArtwork || typeof editorialArtwork !== 'object') return undefined
  const preferred = displayKind === 'MusicNotesHeroShelf' || displayKind === 'MusicSuperHeroShelf'
    ? ['superHeroTall', 'subscriptionHero', 'staticDetailTall', 'superHeroWide', 'subscriptionCover', 'staticDetailSquare']
    : ['staticDetailSquare', 'subscriptionCover', 'staticDetailTall', 'superHeroWide', 'superHeroTall', 'subscriptionHero']
  const candidates = [editorialArtwork, ...preferred.map(key => editorialArtwork?.[key]), ...Object.values(editorialArtwork)]
  for (const candidate of candidates) {
    const url = typeof candidate === 'string' ? candidate : candidate?.url
    if (typeof url !== 'string' || !url) continue
    const resolved = toHighResArtwork(url, size)
    if (/^https?:\/\//.test(resolved)) return resolved
  }
  return undefined
}

function extractHeroArtwork(resource: any, size = 1200, displayKind?: string): string | undefined {
  try {
    const attributes = resource?.attributes || {}
    const presentation = extractEditorialPresentation(resource, displayKind)
    const editorial = extractEditorialArtworkUrl(presentation.card?.editorialArtwork || attributes.editorialArtwork, displayKind, size)
    if (editorial) return editorial
    const url = attributes?.artwork?.url
    if (typeof url === 'string' && url) {
      const resolved = toHighResArtwork(url, size)
      if (/^https?:\/\//.test(resolved)) return resolved
    }
    return undefined
  } catch {
    return undefined
  }
}

type GemsFailure = {
  status: number
  message: string
}

let lastGemsFailure: GemsFailure | null = null

async function gemsRequest(
  path: string,
  options?: { method?: string; body?: unknown; mediaUserToken?: boolean },
): Promise<any | null> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) {
    lastGemsFailure = { status: 0, message: 'Apple Developer Token 缺失' }
    return null
  }
  if (options?.mediaUserToken && !credentials.mediaUserToken) {
    lastGemsFailure = { status: 401, message: 'Apple Music 登录凭据缺失' }
    return null
  }
  const result = await appleApiRequest(path, {
    method: options?.method || 'GET',
    developerToken: credentials.developerToken,
    mediaUserToken: options?.mediaUserToken ? credentials.mediaUserToken : undefined,
    body: options?.body,
    timeoutMs: 10000,
  })
  if (!result.ok) {
    forwardToMainLog(`[AppleWeb] 请求失败 status=${result.status} path=${path.split('?')[0]} error=${String(result.error || '').slice(0, 120)}`)
    const message = result.status === 401 || result.status === 403
      ? 'Apple Music 登录会话已过期'
      : result.status === 0
        ? '无法连接 Apple Music'
        : `Apple Music 请求失败（HTTP ${result.status}）`
    lastGemsFailure = { status: result.status, message }
    return null
  }
  lastGemsFailure = null
  return result.data
}

// ─────────────────────────── editorial 树解析（browse / radio / curator 共用） ───────────────────────────

/**
 * 从带 format[resources]=map 的响应建立「资源引用 → 完整资源」合并器。
 * 注意：这类响应里 `data[]` 常常只是 `{id,type}` 引用，完整对象在 `resources[type][id]`，
 * 因此必须先合并再解析，否则会拿到空壳（此前 rooms/curator 就踩过这个坑）。
 * groupings / groupings/{id} / rooms / multirooms / curator 共用。
 */
function createEditorialResourceResolver(data: any): (reference: any) => any {
  const index = new Map<string, any>()
  const add = (resource: any, fallbackType?: string, fallbackId?: string) => {
    if (!resource || typeof resource !== 'object') return
    const type = String(resource.type || fallbackType || '')
    const id = String(resource.id || fallbackId || '')
    if (!type || !id) return
    index.set(`${type}:${id}`, { ...resource, type, id })
  }
  const included: any[] = Array.isArray(data?.included) ? data.included : []
  included.forEach((resource: any) => add(resource))
  const resources = data?.resources || {}
  if (Array.isArray(resources)) resources.forEach((resource: any) => add(resource))
  else if (resources && typeof resources === 'object') {
    Object.entries(resources).forEach(([type, values]: [string, any]) => {
      if (Array.isArray(values)) values.forEach((resource: any) => add(resource, type))
      else if (values && typeof values === 'object' && values.type && values.id) add(values, type)
      else if (values && typeof values === 'object') Object.entries(values).forEach(([id, resource]: [string, any]) => add(resource, type, id))
    })
  }
  return (reference: any): any => {
    if (!reference || typeof reference !== 'object') return reference
    const full = index.get(`${String(reference.type || '')}:${String(reference.id || '')}`)
    if (!full) return reference
    return {
      ...full,
      ...reference,
      attributes: { ...(full.attributes || {}), ...(reference.attributes || {}) },
      relationships: { ...(full.relationships || {}), ...(reference.relationships || {}) },
    }
  }
}

/** 依据条目类型挑选区块 kind（房间列表与推荐组共用）。 */
function sectionKindForItems(items: AppleWebItem[]): AppleWebSectionKind {
  if (items.length === 0) return 'grid'
  const types = new Set(items.map(item => item.type))
  if (types.size === 1) {
    const only = items[0].type
    if (only === 'songs') return 'song-grid'
    if (only === 'stations' || only === 'radio-shows') return 'station-grid'
    if (only === 'music-videos' || only === 'uploaded-videos' || only === 'posts') return 'video-shelf'
    if (only === 'curators') return 'curators'
    if (only === 'rooms' || only === 'groupings') return 'explore-links'
    return 'album-shelf'
  }
  // 混合列表（实测「大家都在听」= 歌单 + 专辑）：方形卡片类走 album-shelf，其余走通用 grid。
  const squareOnly = items.every(item => item.type === 'albums' || item.type === 'playlists')
  return squareOnly ? 'album-shelf' : 'grid'
}

/**
 * 解析 editorial-elements 树为 sections。
 * 元素类型（editorialElementKind，实测）：
 * - 316：容器（children 为 [317] 徽章卡 / [320] 横幅）
 * - 317：徽章卡（designBadge + contents[0] 单个资源）
 * - 320：宽幅横幅（artwork 4320×1080 + designTag，contents 可空或 1 个资源）
 * - 326/327：网格区（name + contents 资源列表）
 * - 385：节目容器（children 为 [394] 节目卡）
 * - 394：节目卡（designTag 为节目名，artwork 宽幅横幅）
 */
function parseEditorialSections(elements: any[], depth = 0, pageName = 'browse', resolveResource: (resource: any) => any = (resource: any) => resource): AppleWebSection[] {
  if (depth > 5) return []
  const sections: AppleWebSection[] = []
  const editorialUrl = (attributes: any): string | undefined => {
    const raw = attributes?.link?.url || attributes?.url
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }
  let pendingCards: AppleWebItem[] = []
  let pendingSectionUrl: string | undefined
  let cardSeq = 0

  const flushCards = () => {
    if (pendingCards.length === 0) return
    const first = pendingCards[0]
    const sequence = cardSeq++
    const isFirstBrowseCards = pageName === 'music' && sequence === 0
    sections.push({
      id: `cards-${sequence}`,
      kind: isFirstBrowseCards ? 'new-hero' : 'featured-cards',
      title: isFirstBrowseCards ? '精品推荐' : (first?.badge || '精选推荐'),
      items: pendingCards,
      url: pendingSectionUrl,
    })
    pendingCards = []
    pendingSectionUrl = undefined
  }

  const pushInner = (inner: AppleWebSection[]) => {
    inner.forEach(section => {
      if (section.kind === 'featured-cards' || section.kind === 'new-hero') {
        // 每个 editorial 容器就是官网上的一个独立卡片分区，不能跨容器合并。
        flushCards()
        sections.push({
          ...section,
          kind: pageName === 'music' && sections.length === 0 ? 'new-hero' : 'featured-cards',
        })
      } else {
        flushCards()
        sections.push(section)
      }
    })
  }

  for (const elementReference of elements) {
    const element = resolveResource(elementReference)
    if (!element || typeof element !== 'object') continue
    const attributes = element.attributes || {}
    const kind = String(attributes.editorialElementKind || '')
    const relations = element.relationships || {}
    if (pendingCards.length === 0) pendingSectionUrl = editorialUrl(attributes)

    if (kind === '316' || kind === '382' || (kind === '' && relations.children)) {
      // 316/382 都是容器（382 是根容器，id 常为 default）：递归展开子元素。
      pushInner(parseEditorialSections(relations.children?.data || [], depth + 1, pageName, resolveResource))
    } else if (kind === '317') {
      const content = resolveResource(relations.contents?.data?.[0])
      const itemType = normalizeContentType(String(content?.type || 'playlists'))
      if (itemType) {
        const item = itemize(content, itemType)
        if (item) {
          item.badge = attributes.designBadge || undefined
          item.tag = attributes.designTag || undefined
          item.bannerUrl = attributes.artwork?.url
            ? bannerArt(attributes)
            : extractEditorialArtworkUrl(attributes.editorialArtwork, attributes.display?.kind, 1200)
          pendingCards.push(item)
        }
      }
    } else if (kind === '320') {
      const content = resolveResource(relations.contents?.data?.[0])
      const itemType = normalizeContentType(String(content?.type || ''))
      const item = itemType
        ? itemize(content, itemType)
        : null
      const bannerUrl = attributes.artwork?.url
        ? bannerArt(attributes)
        : extractEditorialArtworkUrl(attributes.editorialArtwork, attributes.display?.kind, 1600)
      if (item || bannerUrl) {
        flushCards()
        // banner 的 link 可能为 null（实测广播 3 个 banner 均无链接），此时仅展示不可点。
        const target = resolveExploreTarget(editorialUrl(attributes))
        sections.push({
          id: `banner-${element.id || sections.length}`,
          kind: 'banner',
          title: displayString(attributes.designBadge) || item?.name || '',
          tag: attributes.designTag || undefined,
          bannerUrl,
          items: item ? [item] : [],
          url: editorialUrl(attributes),
          multiRoomId: target?.kind === 'multiroom' ? target.id : undefined,
        })
      }
    } else if (kind === '326' || kind === '327' || kind === '345') {
      // 326（普通货架）/327（歌曲轨）/345（multiroom 货架）同形：
      // attributes.name|title + relationships.contents + relationships.room。
      const contents: any[] = relations.contents?.data || []
      const items: AppleWebItem[] = []
      contents.forEach((content: any) => {
        const resource = resolveResource(content)
        const itemType = normalizeContentType(String(resource?.type || content?.type || ''))
        if (!itemType) return
        const item = itemize(resource, itemType)
        if (item) items.push(item)
      })
      if (items.length > 0) {
        flushCards()
        const roomReference = relations.room?.data?.[0]
        sections.push({
          id: `${kind === '327' ? 'tracks' : 'grid'}-${element.id || sections.length}`,
          kind: pageName === 'music'
            ? (items.every(item => item.type === 'songs') ? 'song-grid'
              : items.every(item => item.type === 'rooms') ? 'explore-links'
                : items.every(item => item.type === 'stations' || item.type === 'radio-shows') ? 'station-grid'
                  : items.some(item => item.type === 'music-videos' || item.type === 'posts') ? 'video-shelf'
                    : 'album-shelf')
            : 'grid',
          displayKind: String(attributes.display?.kind || ''),
          title: displayString(attributes.name) || displayString(attributes.title) || '精选',
          items: items,
          url: editorialUrl(attributes),
          // 模块标题 `>` 的入口来自 relationships.room（实测其 id 即该区块对应 room），不是拼接 URL。
          roomId: roomReference?.id ? String(roomReference.id) : undefined,
          layoutType: attributes.type ? String(attributes.type) : undefined,
          displayStyle: attributes.displayStyle ? String(attributes.displayStyle) : undefined,
        })
      }
    } else if (kind === '391') {
      // 「探索更多」：attributes.links 为 [{label,url}]，标签直接来自接口，无需硬编码。
      const links: any[] = Array.isArray(attributes.links) ? attributes.links : []
      const items: AppleWebItem[] = links
        .filter(link => typeof link?.url === 'string' && link.url)
        .map((link, index) => ({
          id: `explore-link-${element.id || ''}-${index}`,
          playId: link.url,
          type: 'rooms',
          name: displayString(link.label) || link.url,
          url: link.url,
        }))
      if (items.length > 0) {
        flushCards()
        sections.push({
          id: `explore-${element.id || sections.length}`,
          kind: 'explore-links',
          title: displayString(attributes.name) || displayString(attributes.title) || '探索更多',
          items,
        })
      }
    } else if (kind === '404') {
      // 纯文本区块（如「空间音频 Q&A」）：无 relationships，正文为 HTML。
      const bodyHtml = typeof attributes.description === 'string' ? attributes.description : ''
      if (bodyHtml) {
        flushCards()
        sections.push({
          id: `text-${element.id || sections.length}`,
          kind: 'text-block',
          title: displayString(attributes.title) || displayString(attributes.name) || '',
          bodyHtml,
          items: [],
        })
      }
    } else if (kind === '322') {
      // 322 是 24 条风格链接行；实测官网在探索页不渲染它，故只解析不产出区块（避免与官网不一致）。
    } else if (kind === '385') {
      const shows: AppleWebItem[] = []
      ;(relations.children?.data || []).forEach((show: any) => {
        const showAttrs = show?.attributes || {}
        const name = displayString(showAttrs.designTag) || displayString(showAttrs.name)
        if (!name) return

        const stationResource = (show?.relationships?.contents?.data || [])
          .find((resource: any) => normalizeContentType(String(resource?.type || '')) === 'stations')
        const station = stationResource ? itemize(stationResource, 'stations') : null
        const rawUrl = typeof showAttrs.link?.url === 'string'
          ? showAttrs.link.url
          : typeof showAttrs.url === 'string' ? showAttrs.url : ''
        let linkedStationId = ''
        try {
          const url = new URL(rawUrl, 'https://music.apple.com')
          if (url.hostname === 'music.apple.com' && /\/station\//.test(url.pathname)) {
            linkedStationId = url.pathname.match(/\/(ra\.\d+)\/?$/)?.[1] || ''
          }
        } catch {
          linkedStationId = ''
        }

        shows.push({
          ...(station || {}),
          id: station?.id || String(show.id || ''),
          playId: station?.playId || linkedStationId,
          type: station || linkedStationId ? 'stations' : 'radio-shows',
          name,
          tag: displayString(showAttrs.designTag) || undefined,
          bannerUrl: showAttrs.artwork?.url ? bannerArt(showAttrs) : station?.bannerUrl,
          url: rawUrl || station?.url,
        })
      })
      if (shows.length > 0) {
        flushCards()
        sections.push({
          id: `shows-${element.id || sections.length}`,
          kind: pageName === 'music' ? 'station-grid' : 'show-cards',
          title: displayString(attributes.name) || displayString(attributes.title) || '节目',
          items: shows,
          url: editorialUrl(attributes),
        })
      }
    }
    // 其它未知元素安全跳过
  }
  flushCards()
  return sections
}

/** 取 groupings 响应里的目标 tab（radio 有 Subscriber/Non Subscriber/Opt Out 多 tab） */
function pickTab(grouping: any, preferSubscriber = true): any {
  const tabs: any[] = grouping?.relationships?.tabs?.data || []
  if (tabs.length === 0) return null
  if (preferSubscriber) {
    const sub = tabs.find(tab => /subscrib/i.test(String(tab?.id || '') + ' ' + String(tab?.attributes?.name || '')))
    if (sub) return sub
  }
  return tabs[0]
}

/**
 * 编辑 groupings 页（web /new 与 /radio 同款接口，参数与前端 bundle 完全一致）：
 * GET /v1/editorial/{sf}/groupings?name=new|radio&platform=web&tabs=subscriber&…
 */
async function fetchEditorialPage(name: string, storefront: string): Promise<{ sections: AppleWebSection[]; hero: AppleWebItem | null }> {
  const data = await gemsRequest(
    `/v1/editorial/${encodeURIComponent(storefront)}/groupings?art%5Burl%5D=c%2Cf&extend=artistUrl%2CeditorialArtwork%2CeditorialVideo%2CplainEditorialNotes&extend%5Bstation-events%5D=editorialVideo&fields%5Balbums%5D=artistName%2CartistUrl%2Cartwork%2CcontentRating%2CeditorialArtwork%2CplainEditorialNotes%2Cname%2CplayParams%2CreleaseDate%2Curl%2CtrackCount&fields%5Bartists%5D=name%2Curl%2Cartwork%2CeditorialArtwork%2CgenreNames%2CplainEditorialNotes&format%5Bresources%5D=map&include%5Balbums%5D=artists&include%5Bmusic-videos%5D=artists&include%5Bsongs%5D=artists&include%5Bstations%5D=events%2Cradio-show&l=zh-Hans-CN&name=${encodeURIComponent(name)}&omit%5Bresource%3Aartists%5D=autos&platform=web&relate%5Bsongs%5D=albums&tabs=subscriber`,
  )
  if (!data) return { sections: [], hero: null }
  // groupings / rooms / multirooms / curator 共用同一套资源引用合并逻辑。
  const resolveEditorialResource = createEditorialResourceResolver(data)
  const groupingReference = Array.isArray(data.data) ? data.data[0] : null
  const grouping = resolveEditorialResource(groupingReference)
  const tabReference = pickTab(grouping)
  const tab = resolveEditorialResource(tabReference)
  const childReferences = tab?.relationships?.children?.data || grouping?.relationships?.children?.data || []
  const children = childReferences.map(resolveEditorialResource)
  const sections = parseEditorialSections(children, 0, name, resolveEditorialResource)
  forwardToMainLog(`[AppleWeb] ${name} sections: ${sections.map(section => `${section.kind}:${section.title}`).join(' | ')}`)
  forwardToMainLog(`[AppleWeb] ${name} section entries: ${sections.map(section => `${section.title}=${section.roomId || section.multiRoomId || section.url || '-'}`).join(' | ')}`)
  forwardToMainLog(`[AppleWeb] ${name} first items: ${sections.slice(0, 3).map(section => section.items.slice(0, 2).map(item => `${item.type}:${item.id}:art=${Boolean(item.artworkUrl)}:banner=${Boolean(item.bannerUrl)}:motion=${Boolean(item.motionArtworkUrl)}`).join(',')).join(' | ')}`)
  // 主视觉：radio 页取第一张推荐单集横幅；browse 页无 hero（卡片网格即主视觉）
  let hero: AppleWebItem | null = null
  if (name === 'radio') {
    const banner = sections.find(section => section.kind === 'banner' && section.items.length > 0)
    if (banner) hero = banner.items[0]
  }
  return { sections, hero }
}

// ─────────────────────────── 主页（Listen Now） ───────────────────────────

/** 最近添加（资料库新增，优先登录）：/v1/me/library/recently-added */
export async function fetchHomeRecentlyAdded(): Promise<AppleWebSection | null> {
  const data = await gemsRequest('/v1/me/library/recently-added?limit=25&platform=web&include=catalog', { mediaUserToken: true })
  if (!data) return null
  const resources: any[] = Array.isArray(data.data) ? data.data : []
  if (resources.length === 0) return null
  const collected: AppleWebItem[] = []
  resources.forEach((resource: any) => {
    const rawType = String(resource?.type || '')
    const kind = rawType.startsWith('library-') ? rawType.slice('library-'.length) : rawType
    if (!['songs', 'albums', 'playlists', 'music-videos', 'uploaded-videos'].includes(kind)) return
    const normalizedKind = kind === 'uploaded-videos' ? 'uploaded-videos' : kind
    const catalogId = resource?.relationships?.catalog?.data?.[0]?.id
      ? String(resource.relationships.catalog.data[0].id)
      : undefined
    const item = itemize(resource, normalizedKind as AppleWebItemType, catalogId || String(resource.id || ''))
    if (item) {
      item.libraryId = rawType.startsWith('library-') ? String(resource.id || '') : undefined
      item.catalogId = catalogId
      item.isLibrary = rawType.startsWith('library-')
      collected.push(item)
    }
  })
  if (collected.length === 0) return null
  return { id: 'home-recently-added', kind: 'row', title: '最近添加', subtitle: '你加进资料库的新鲜内容', items: collected }
}

/** 主页 Listen Now（1:1 web）：/v1/me/recommendations（实测 group 标题在 attributes.stringForDisplay） */
async function fetchHomeListenNow(): Promise<{ sections: AppleWebSection[]; hero: AppleWebItem | null; failure?: GemsFailure }> {
  const data = await gemsRequest(
    '/v1/me/recommendations?art%5Burl%5D=f'
    + '&displayFilter%5Bkind%5D=MusicCircleCoverShelf,MusicConcertsEmptyShelf,MusicCoverGrid,MusicCoverShelf,MusicNotesHeroShelf,MusicSocialCardShelf,MusicSuperHeroShelf'
    + '&extend=editorialArtwork,editorialVideo,plainEditorialCard,plainEditorialNotes'
    + '&extend%5Bplaylists%5D=artistNames'
    + '&extend%5Bstations%5D=airTime,supportsAirTimeUpdates'
    + '&fields%5Bartists%5D=name,artwork,url'
    + '&format%5Bresources%5D=map'
    + '&include%5Balbums%5D=artists&include%5Blibrary-playlists%5D=catalog'
    + '&include%5Bpersonal-recommendation%5D=primary-content&include%5Bstations%5D=radio-show'
    + '&meta%5Bstations%5D=inflectionPoints'
    + '&name=listen-now&omit%5Bresource%5D=autos&platform=web'
    + '&timezone=%2B08%3A00'
    + '&types=activities,albums,apple-curators,artists,concerts,curators,editorial-items,library-albums,library-playlists,music-movies,music-videos,playlists,social-profiles,social-upsells,songs,stations,tv-episodes,tv-shows,uploaded-audios,uploaded-videos'
    + '&with=friendsMix,library,social',
    { mediaUserToken: true },
  )
  if (!data) return { sections: [], hero: null, failure: lastGemsFailure || { status: 0, message: 'Apple Music 推荐接口未返回数据' } }
  const resourceMap = data.resources || {}
  const included: any[] = Array.isArray(data.included) ? data.included : []
  const includedMap = new Map<string, any>()
  const indexResource = (resource: any) => {
    if (!resource?.id || !resource?.type) return
    includedMap.set(`${resource.type}:${resource.id}`, resource)
  }
  included.forEach(indexResource)
  if (Array.isArray(resourceMap)) resourceMap.forEach(indexResource)
  else Object.entries(resourceMap).forEach(([key, value]: [string, any]) => {
    if (Array.isArray(value)) value.forEach(indexResource)
    else if (value && typeof value === 'object' && value.id && value.type) indexResource(value)
    else if (value && typeof value === 'object') Object.entries(value).forEach(([id, resource]: [string, any]) => {
      if (resource && typeof resource === 'object') indexResource({ id: resource.id || id, type: resource.type || key, ...resource })
    })
  })
  const findResource = (id: string, type: string): any =>
    includedMap.get(`${type}:${id}`) || resourceMap?.[id] || resourceMap?.[type]?.[id] || null
  const groupCandidates: any[] = Array.isArray(data.data)
    ? data.data.map((ref: any) => {
      if (!ref?.id || !ref?.type) return ref
      return resourceMap?.[ref.type]?.[ref.id] || resourceMap?.[ref.id] || ref
    })
    : data.data && typeof data.data === 'object'
      ? Object.values(data.data).flatMap(value => Array.isArray(value) ? value : [])
      : []
  const resourceGroups = Array.isArray(resourceMap)
    ? resourceMap.filter((resource: any) => resource?.relationships || resource?.attributes?.contents || resource?.attributes?.primaryContent)
    : []
  const groups: any[] = [...groupCandidates, ...resourceGroups]
  const sections: AppleWebSection[] = []
  const groupKinds = new Set<string>()

  const collectGroupItems = (group: any, displayKind?: string): AppleWebItem[] => {
    const collected: AppleWebItem[] = []
    const relations = group?.relationships || {}
    const refs: any[] = []
    const seen = new Set<string>()
    const appendRefs = (value: unknown) => {
      if (!value) return
      if (Array.isArray(value)) {
        value.forEach(appendRefs)
        return
      }
      if (typeof value !== 'object') return
      const obj = value as Record<string, any>
      if (Array.isArray(obj.data)) appendRefs(obj.data)
      if (Array.isArray(obj.contents)) appendRefs(obj.contents)
      if (Array.isArray(obj.primaryContent)) appendRefs(obj.primaryContent)
      if (Array.isArray(obj.resources)) appendRefs(obj.resources)
      if (obj.id && obj.type) {
        const refKey = `${obj.type}:${obj.id}`
        if (!seen.has(refKey)) {
          seen.add(refKey)
          refs.push(obj)
        }
      }
    }
    // Apple web 将 primary content 放在组内容之前；保持网页版的优先顺序。
    appendRefs(group?.primaryContent)
    appendRefs(group?.attributes?.primaryContent)
    appendRefs(group?.relationships?.primaryContent?.data)
    appendRefs(group?.relationships?.['primary-content']?.data)
    appendRefs(group?.contents)
    appendRefs(group?.attributes?.contents)
    appendRefs(group?.relationships?.contents?.data)
    for (const key of Object.keys(relations)) {
      if (key === 'primaryContent' || key === 'primary-content' || key === 'contents') continue
      appendRefs(relations[key]?.data)
    }
    const resolveResource = (ref: any): any => {
      if (!ref || typeof ref !== 'object') return null
      const type = String(ref.type || '')
      const id = String(ref.id || '')
      const direct = id && type ? findResource(id, type) : null
      if (direct) {
        return {
          ...direct,
          ...ref,
          attributes: { ...(direct.attributes || {}), ...(ref.attributes || {}) },
          relationships: { ...(direct.relationships || {}), ...(ref.relationships || {}) },
        }
      }
      if (ref.attributes) return ref
      for (const relation of Object.values(ref.relationships || {})) {
        const candidates = (relation as any)?.data
        const nested = Array.isArray(candidates) ? candidates : candidates ? [candidates] : []
        for (const candidate of nested) {
          const resolved = resolveResource(candidate)
          if (resolved?.attributes) return resolved
        }
      }
      return null
    }
    refs.forEach((ref: any) => {
      const rawType = String(ref?.type || '')
      const resource = resolveResource(ref)
      const type = normalizeContentType(rawType) || normalizeContentType(String(resource?.type || ''))
      if (!type || !resource?.attributes) return
      const item = itemize(resource, type, undefined, displayKind)
      if (item) collected.push(item)
    })
    return collected
  }

  groups.forEach((group: any, index: number) => {
    const title = displayString(group?.attributes?.stringForDisplay) || displayString(group?.attributes?.title) || (index === 0 ? '专属推荐' : '为你推荐')
    const displayKind = String(group?.attributes?.display?.kind || '')
    const items = collectGroupItems(group, displayKind)
    if (items.length === 0) return
    const groupKind = String(group?.attributes?.kind || '')
    // 实测官网按 display.kind 决定卡片规格：MusicNotesHeroShelf / MusicSuperHeroShelf 是大卡
    // （如「专属精选推荐」「专属推荐歌单」「音乐回忆」），MusicCoverShelf 等是普通卡。
    const isHeroShelf = displayKind === 'MusicNotesHeroShelf' || displayKind === 'MusicSuperHeroShelf'
    const sectionKind: AppleWebSectionKind = isHeroShelf
      ? 'home-featured'
      : groupKind === 'recently-played'
        ? 'row'
        : 'row'
    sections.push({
      id: `listen-now-${index}`,
      kind: sectionKind,
      title,
      displayKind,
      items: items.slice(0, 40),
    })
  })
  const extras = await (async () => {
    const extraSections: AppleWebSection[] = []
    if (groupKinds.has('recently-played')) return extraSections
    const recentPromise = getAppleRecentPlayed(40)
        .then(recent => {
          if (recent.length > 0) extraSections.push({
            id: 'home-recent-played',
            kind: 'row',
            title: '最近播放',
            subtitle: '继续收听你最近播放的内容',
            items: recent.map((song): AppleWebItem => ({
              id: song.id,
              playId: song.id,
              type: 'songs',
              name: song.name,
              subtitle: song.artistName,
              artworkUrl: song.artworkUrl,
              artistId: song.artistId,
              albumId: song.albumId,
              artistName: song.artistName,
              durationMs: song.durationMs,
            })),
          })
        })
        .catch(() => undefined)
    const addedPromise = fetchHomeRecentlyAdded()
      .then(added => { if (added) extraSections.push(added) })
      .catch(() => undefined)
    await Promise.all([recentPromise, addedPromise])
    return extraSections
  })()
  extras.forEach(section => sections.push(section))
  return { sections, hero: null }
}

/** 未登录兜底：RSS 热歌 + 编辑歌单 */
async function fetchHomeFallback(storefront: string): Promise<AppleWebSection[]> {
  const [hot, playlists] = await Promise.allSettled([
    getAppleHotSongs(storefront, 30),
    getAppleEditorialPlaylists(storefront, 16),
  ])
  const sections: AppleWebSection[] = []
  if (hot.status === 'fulfilled' && hot.value.length > 0) {
    sections.push({
      id: 'home-fallback-hot',
      kind: 'row',
      title: '今日热选',
      subtitle: '全球最受欢迎（登录后按你的口味个性化）',
      items: hot.value.map((song: AppleCatalogSong): AppleWebItem => ({
        id: song.id,
        playId: song.id,
        type: 'songs',
        name: song.name,
        subtitle: song.artistName,
        artworkUrl: song.artworkUrl,
        artistName: song.artistName,
        durationMs: song.durationMs,
      })),
    })
  }
  if (playlists.status === 'fulfilled' && playlists.value.length > 0) {
    sections.push({
      id: 'home-fallback-playlists',
      kind: 'row',
      title: '编辑精选歌单',
      subtitle: 'Apple Music 编辑策划',
      items: playlists.value.map((playlist): AppleWebItem => ({
        id: playlist.id,
        playId: playlist.id,
        type: 'playlists',
        name: playlist.name,
        subtitle: playlist.curatorName,
        description: playlist.description,
        artworkUrl: playlist.artworkUrl,
        curatorName: playlist.curatorName,
        trackCount: playlist.trackCount,
      })),
    })
  }
  return sections
}

/** 主页入口：有 mediaUserToken 一律先打 listen-now（绝不走 RSS 拖挂），无 token 才 RSS 兜底 */
export async function fetchAppleHomePage(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const credentials = getAppleCredentials()
  const hasMedia = Boolean(credentials.mediaUserToken)
  if (hasMedia) {
    const result = await fetchHomeListenNow()
    forwardToMainLog('[AppleWeb] home listen-now: sections=' + result.sections.length + ' hero=' + (result.hero ? 'yes' : 'no'))
    if (result.sections.length > 0) {
      return { sections: result.sections, hero: result.hero, personalized: true, sourceLabel: 'Apple Music · 主页' }
    }
    const fallbackSections = await fetchHomeFallback(sf)
    const failure = result.failure || { status: 200, message: 'Apple Music 暂未返回可展示的个性化推荐' }
    return {
      sections: fallbackSections,
      hero: null,
      personalized: false,
      sourceLabel: fallbackSections.length > 0 ? 'Apple Music · 公开推荐' : 'Apple Music · 暂无内容',
      fallbackReason: `${failure.message}，已显示公开内容`,
      requiresLogin: failure.status === 401 || failure.status === 403,
    }
  }
  forwardToMainLog('[AppleWeb] home: 无 mediaUserToken → RSS 兜底')
  return { sections: await fetchHomeFallback(sf), hero: null, personalized: false, sourceLabel: 'apple-rss（未登录）' }
}

// ─────────────────────────── 排行榜（web /new/top-charts 同款） ───────────────────────────

/**
 * charts：/v1/catalog/{sf}/charts?with=cityCharts,dailyGlobalTopCharts（含城市榜/每周热门100）。
 * 注意：条目类型以接口实际返回为准——songs/albums/music-videos 是内容榜，
 * 而 dailyGlobalTopCharts（每周热门100）与 cityCharts（城市榜）的条目是「地区榜歌单」，
 * 必须按 playlists 处理（点击进歌单详情，不能当歌曲播放）。
 */
export async function fetchAppleTopCharts(storefront?: string): Promise<AppleWebSection[]> {
  const sf = storefront || getStorefront()
  const result = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/charts?types=albums,songs,music-videos,playlists&limit=50&include=tracks&include[songs]=artists&with=cityCharts,dailyGlobalTopCharts`,
  )
  if (!result) return []
  const sections: AppleWebSection[] = []
  const results = result?.results || {}
  const pushChart = (chart: any, fallbackType?: AppleWebItemType) => {
    const items: any[] = Array.isArray(chart?.data) ? chart.data : []
    const mapped: AppleWebItem[] = []
    items.forEach((item: any) => {
      const type = normalizeContentType(String(item?.type || '')) || fallbackType
      if (!type) return
      const mappedItem = itemize(item, type)
      if (mappedItem) mapped.push(mappedItem)
    })
    if (mapped.length > 0) {
      const sectionType = mapped.every(item => item.type === mapped[0].type)
        ? mapped[0].type
        : 'mixed'
      sections.push({
        id: `chart-${sectionType}-${chart?.chart || 'most-played'}`,
        kind: 'chart',
        title: chart?.shortName || chart?.name || '排行榜',
        chartType: chart?.chart,
        items: mapped,
      })
    }
  }
  const pushCharts = (value: unknown, fallbackType: AppleWebItemType) => {
    if (!Array.isArray(value)) return
    value.forEach(chart => {
      if (Array.isArray(chart?.data)) pushChart(chart, fallbackType)
    })
  }
  pushCharts(results?.songs, 'songs')
  pushCharts(results?.dailyGlobalTopCharts, 'playlists')
  pushCharts(results?.albums, 'albums')
  pushCharts(results?.playlists, 'playlists')
  pushCharts(results?.['music-videos'], 'music-videos')
  pushCharts(results?.cityCharts, 'playlists')
  return sections
}

// ─────────────────────────── 新发现 / 广播 ───────────────────────────

/** 新发现（web /new 同款编辑页 + 排行榜；接口失败回退 RSS） */
export async function fetchAppleBrowsePage(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const editorial = await fetchEditorialPage('music', sf)
  const sections = editorial.sections
  if (sections.length === 0) {
    return { sections: await fetchHomeFallback(sf), hero: null, personalized: false, sourceLabel: 'apple-rss（browse 接口失败）' }
  }
  // 「探索更多」由接口 [391] attributes.links 提供（含 label），不再硬编码。
  return { sections, hero: null, personalized: false, sourceLabel: 'apple-api editorial(music)' }
}

/** 最近收听的电台（需登录）：/v1/me/recent/radio-stations */
async function fetchRecentRadioSection(): Promise<AppleWebSection | null> {
  const data = await gemsRequest('/v1/me/recent/radio-stations?limit=30&platform=web&include[stations]=radio-show&omit[resource]=autos', { mediaUserToken: true })
  if (!data) return null
  const resources: any[] = Array.isArray(data.data) ? data.data : []
  const items: AppleWebItem[] = []
  resources.forEach((resource: any) => {
    const item = itemize(resource, 'stations')
    if (item) {
      const show = resource?.relationships?.radioShow?.data?.[0]
      if (show?.attributes?.name && !item.showName) item.showName = show.attributes.name
      items.push(item)
    }
  })
  if (items.length === 0) return null
  return { id: 'radio-recent', kind: 'grid', title: '最近收听的电台', subtitle: '接着上次的频道听', items }
}

/** 电台精选（catalog stations；失败静默回退空） */
async function fetchCatalogStationsSection(storefront: string): Promise<AppleWebSection | null> {
  const data = await gemsRequest(`/v1/catalog/${encodeURIComponent(storefront)}/stations?limit=50&platform=web&omit[resource]=autos`)
  if (!data) return null
  const resources: any[] = Array.isArray(data.data) ? data.data : []
  const items: AppleWebItem[] = []
  resources.forEach((resource: any) => {
    const item = itemize(resource, 'stations')
    if (item) items.push(item)
  })
  if (items.length === 0) return null
  const section: AppleWebSection = { id: 'radio-catalog', kind: 'grid', title: '电台精选', subtitle: 'Apple Music 官方频道与电台', items }
  return section
}

/** 广播（web /radio 同款编辑页；含最近电台；接口失败回退 stations 列表） */
export async function fetchAppleRadioPage(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const loggedIn = Boolean(getAppleCredentials().developerToken && getAppleCredentials().mediaUserToken)
  const editorial = await fetchEditorialPage('radio', sf)
  /** 「最近收听的电台」放到「探索更多」之前（官网该区块在列表末尾、探索更多上方）。 */
  const withRecentAtEnd = (sections: AppleWebSection[], recent: AppleWebSection | null): AppleWebSection[] => {
    if (!recent) return sections
    const exploreIndex = sections.findIndex(section => section.kind === 'explore-links')
    if (exploreIndex < 0) return [...sections, recent]
    return [...sections.slice(0, exploreIndex), recent, ...sections.slice(exploreIndex)]
  }
  if (editorial.sections.length > 0) {
    const recentSection = loggedIn ? await fetchRecentRadioSection().catch(() => null) : null
    // 官网广播页没有独立大 banner（首屏即「推荐单集」横向货架），因此不再返回 hero。
    return {
      sections: withRecentAtEnd(editorial.sections, recentSection),
      hero: null,
      personalized: loggedIn,
      sourceLabel: 'apple-api editorial(radio)',
    }
  }
  const [recent, stations] = await Promise.allSettled([
    loggedIn ? fetchRecentRadioSection() : Promise.resolve(null),
    fetchCatalogStationsSection(sf),
  ])
  const sections: AppleWebSection[] = []
  if (stations.status === 'fulfilled' && stations.value) sections.push(stations.value)
  const recentValue = recent.status === 'fulfilled' ? recent.value : null
  return {
    sections: withRecentAtEnd(sections, recentValue),
    hero: null,
    personalized: loggedIn,
    sourceLabel: sections.length || recentValue ? 'apple-api-catalog' : 'radio 暂无可展示内容（登录后可看最近电台）',
  }
}

/**
 * 读取用户个人电台（Apple 以真实姓名命名，station id 前缀 `ra.u-`）。
 * 实测来源：/v1/me/recommendations?name=listen-now 的 resources.stations。
 */
export async function fetchApplePersonalStation(): Promise<{ id: string; name: string } | null> {
  const data = await gemsRequest(
    '/v1/me/recommendations?format%5Bresources%5D=map&l=zh-Hans-CN&name=listen-now&platform=web&timezone=%2B08%3A00',
    { mediaUserToken: true },
  )
  const stations = (data?.resources || {}).stations || {}
  for (const station of Object.values<any>(stations)) {
    const id = String(station?.id || '')
    if (!isPersonalStationId(id)) continue
    const name = displayString(station?.attributes?.name)
    if (!name) continue
    const info = { id, name }
    cachePersonalStation(info)
    return info
  }
  return null
}

// ─────────────────────────── 搜索落地 / 分类页（web /search 同款） ───────────────────────────

/**
 * 搜索落地页「类别浏览」（web /search 无关键词视图）：
 * GET /v1/recommendations/{sf}?name=search-landing&platform=web&types=activities,apple-curators,editorial-items
 * 返回 apple-curators 列表（舞曲 / 国语流行 / K-Pop / 空间音频 / 热门 …）。
 */
export async function fetchAppleSearchLanding(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    // 实测：必须带 format[resources]=map，否则响应只有 data/meta、没有 resources，条目引用无法解析。
    `/v1/recommendations/${encodeURIComponent(sf)}?name=search-landing&platform=web&omit[resource]=autos`
    + '&format%5Bresources%5D=map'
    + '&extend=editorialArtwork&types=activities,apple-curators,editorial-items&with=concerts',
  )
  // groups 是 personal-recommendation；完整对象在 resources['personal-recommendation']。
  const resolveResource = createEditorialResourceResolver(data)
  const groups: any[] = (Array.isArray(data?.data) ? data.data : []).map((reference: any) => resolveResource(reference))
  const items: AppleWebItem[] = []
  groups.forEach(group => {
    const attributes = group?.attributes || {}
    // 组标题为 {stringForDisplay} 结构，不是纯字符串。
    const groupTitle = displayString(attributes.title) || '类别浏览'
    const contents: any[] = group?.relationships?.contents?.data || []
    contents.forEach((content: any) => {
      const resolved = resolveResource(content)
      const contentAttributes = resolved?.attributes || {}
      const name = displayString(contentAttributes.name)
      if (!name || !resolved?.id) return
      const type = normalizeContentType(String(resolved.type || content?.type || 'apple-curators')) || 'curators'
      const hero = contentAttributes.editorialArtwork?.subscriptionHero?.url
        ? toHighResArtwork(contentAttributes.editorialArtwork.subscriptionHero.url, 1600)
        : undefined
      items.push({
        id: String(resolved.id),
        playId: String(resolved.id),
        type,
        name,
        description: contentAttributes.editorialNotes?.short || contentAttributes.editorialNotes?.standard,
        artworkUrl: art(contentAttributes),
        heroArtworkUrl: hero,
        subtitle: displayString(contentAttributes.shortName) || contentAttributes.curatorName || groupTitle,
        url: contentAttributes.url,
      })
    })
  })
  if (items.length === 0) {
    return { sections: [], hero: null, personalized: false, sourceLabel: '类别浏览暂无数据' }
  }
  return {
    sections: [{ id: 'search-curators', kind: 'curators', title: '类别浏览', items }],
    hero: null,
    personalized: false,
    sourceLabel: 'apple-api search-landing',
  }
}

export interface AppleCuratorPage {
  curator: AppleWebItem
  sections: AppleWebSection[]
  playlists: AppleWebItem[]
  playlistCount?: number
}

/**
 * curator 页（web /curator/{slug}/{id} 同款）。
 * 实测：`GET /v1/catalog/{sf}?ids[apple-curators]={id}&ids[curators]={id}&include=grouping,playlists&format[resources]=map`
 * - 必须带 `format[resources]=map`，否则响应没有 resources，条目只剩引用壳；
 * - `relationships.grouping` 是一棵**标准编辑树**（316/317/320/326/327/382），与首页同构，可共用解析器；
 * - curator 自身属性只有 artwork/editorialArtwork/kind/name/shortName/url，**没有简介字段**（实测加 extend 也不返回）。
 */
export async function fetchAppleCuratorPage(curatorId: string, storefront?: string): Promise<AppleCuratorPage | null> {
  if (!curatorId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}?ids[curators]=${encodeURIComponent(curatorId)}&ids[apple-curators]=${encodeURIComponent(curatorId)}`
    + '&art[url]=f'
    + '&extend=editorialArtwork%2CeditorialVideo'
    + '&extend[apple-curators]=playlistCount&extend[curators]=playlistCount'
    + '&format[resources]=map'
    + '&include=grouping%2Cplaylists'
    + '&l=zh-Hans-CN&platform=web',
  )
  if (!data) return null
  const resolveResource = createEditorialResourceResolver(data)
  const reference = Array.isArray(data.data) ? data.data[0] : null
  const element = reference ? resolveResource(reference) : null
  const attributes = element?.attributes || {}
  if (!attributes.name) return null
  const hero = attributes.editorialArtwork?.subscriptionHero?.url
    ? toHighResArtwork(attributes.editorialArtwork.subscriptionHero.url, 1600)
    : undefined
  const curator: AppleWebItem = {
    id: String(element.id),
    playId: String(element.id),
    type: 'curators',
    name: attributes.name,
    // curator 无简介，这里留空以与官网一致（官网 curator 页也没有介绍文案）。
    description: attributes.editorialNotes?.short || attributes.editorialNotes?.standard,
    artworkUrl: art(attributes),
    heroArtworkUrl: hero,
    curatorName: attributes.shortName || attributes.curatorName,
    trackCount: attributes.playlistCount,
    url: attributes.url,
  }
  const playlists: AppleWebItem[] = []
  ;(element.relationships?.playlists?.data || []).forEach((playlist: any) => {
    const resolved = resolveResource(playlist)
    const type = normalizeContentType(String(resolved?.type || 'playlists'))
    if (!type) return
    const item = itemize(resolved, type)
    if (item) playlists.push(item)
  })
  const groupingReference = element.relationships?.grouping?.data?.[0]
  const grouping = groupingReference ? resolveResource(groupingReference) : null
  const tab = resolveResource(pickTab(grouping))
  const childReferences = tab?.relationships?.children?.data || grouping?.relationships?.children?.data || []
  const sections = parseEditorialSections(childReferences.map(resolveResource), 0, 'music', resolveResource)
  return { curator, sections, playlists, playlistCount: attributes.playlistCount }
}

export interface AppleRadioShowDetail {
  show: AppleWebItem
  episodes: AppleWebItem[]
}

/** 广播节目详情：节目容器本身不可播放，展开其 episodes/stations 后再播放。 */
export async function fetchAppleRadioShowDetail(showId: string, storefront?: string): Promise<AppleRadioShowDetail | null> {
  if (!showId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/radio-shows/${encodeURIComponent(showId)}?include=episodes,stations&extend=editorialArtwork,editorialVideo`,
  )
  const resource = Array.isArray(data?.data) ? data.data[0] : null
  if (!resource) return null
  const show = itemize(resource, 'radio-shows')
  if (!show) return null
  const episodes: AppleWebItem[] = []
  const candidates = [
    ...(resource.relationships?.episodes?.data || []),
    ...(resource.relationships?.stations?.data || []),
    ...(resource.relationships?.contents?.data || []),
  ]
  for (const item of candidates) {
    const type = normalizeContentType(String(item?.type || 'stations'))
    if (!type || (type !== 'stations' && type !== 'music-videos')) continue
    const mapped = itemize(item, type)
    if (mapped && !episodes.some(existing => existing.id === mapped.id)) episodes.push(mapped)
  }
  return { show, episodes }
}

// ─────────────────────────── 歌曲详情（web /song/… 同款） ───────────────────────────

export interface AppleSongDetail {
  song: AppleWebItem
  album?: AppleWebItem
  artists: AppleWebItem[]
  /** 完整歌词（TTML 解析，time 单位秒） */
  lyrics: Array<{ time: number; text: string }>
  /** 幕后词曲（TTML songwriters / composerName） */
  songwriters: string[]
  /** 更多 {artist} 的作品（艺人专辑） */
  artistAlbums: AppleWebItem[]
}

/**
 * 歌曲详情（web 歌曲页 1:1）：
 * - /v1/catalog/{sf}/songs/{id}?include=albums,artists（基础信息 + 出演艺人 + 专辑）
 * - /v1/catalog/{sf}/songs/{id}/lyrics（MUT；TTML 含 songwriters）
 * - /v1/catalog/{sf}/artists/{id}/albums（更多作品）
 */
export async function fetchAppleSongDetail(songId: string, storefront?: string): Promise<AppleSongDetail | null> {
  if (!songId) return null
  const sf = storefront || getStorefront()
  // fields[artists]=artwork：出演艺人头像（缺省 include 只回 id+name，详情页艺人无头像）
  const songData = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/songs/${encodeURIComponent(songId)}?include=albums,artists&fields[artists]=name,artwork,url`,
  )
  const songResource = Array.isArray(songData?.data) ? songData.data[0] : null
  if (!songResource?.attributes?.name) return null
  const song = itemize(songResource, 'songs')!
  song.playId = String(songResource.id)

  const albumResource = songResource.relationships?.albums?.data?.[0]
  const album = albumResource ? (itemize(albumResource, 'albums') ?? undefined) : undefined
  const artistResources: any[] = songResource.relationships?.artists?.data || []
  const artists = artistResources
    .map((artist: any) => itemize(artist, 'artists'))
    .filter((item): item is AppleWebItem => Boolean(item))

  // 歌词 + 更多作品并行
  const [lyricsData, artistAlbumsData] = await Promise.allSettled([
    gemsRequest(`/v1/catalog/${encodeURIComponent(sf)}/songs/${encodeURIComponent(songId)}/lyrics`, { mediaUserToken: true }),
    artistResources[0]?.id
      ? gemsRequest(`/v1/catalog/${encodeURIComponent(sf)}/artists/${encodeURIComponent(String(artistResources[0].id))}/albums?limit=12`)
      : Promise.resolve(null),
  ])

  let lyrics: Array<{ time: number; text: string }> = []
  let songwriters: string[] = []
  if (lyricsData.status === 'fulfilled') {
    const ttml = lyricsData.value?.data?.[0]?.attributes?.ttml
    if (typeof ttml === 'string' && ttml.length > 0) {
      try {
        const parsed = parseTTML(ttml)
        lyrics = parsed.lines
          .map(line => ({
            time: line.startTime / 1000,
            text: line.words.map(word => word.text).join('').trim(),
          }))
          .filter(line => line.text.length > 0)
      } catch {
        lyrics = []
      }
      // TTML <songwriters> 节点（iTunesMetadata 内）
      const writerMatches = ttml.match(/<songwriter>([^<]+)<\/songwriter>/g) || []
      songwriters = writerMatches
        .map(tag => tag.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
    }
  }
  if (song.composerName && !songwriters.includes(song.composerName)) {
    songwriters = [song.composerName, ...songwriters]
  }

  const artistAlbums: AppleWebItem[] = []
  if (artistAlbumsData.status === 'fulfilled' && Array.isArray(artistAlbumsData.value?.data)) {
    artistAlbumsData.value.data.forEach((albumItem: any) => {
      const item = itemize(albumItem, 'albums')
      if (item) artistAlbums.push(item)
    })
  }

  return { song, album, artists, lyrics, songwriters, artistAlbums }
}

// ─────────────────────────── 动态封面 / 电台详情 ───────────────────────────

/** 目录资源动态封面（web powerswoosh）：按资源类型读取 editorialVideo。 */
export async function fetchAppleResourceMotion(
  type: 'playlists' | 'albums' | 'stations',
  resourceId: string,
  storefront?: string,
): Promise<{ video?: string; poster?: string } | null> {
  if (!resourceId) return null
  const sf = storefront || getStorefront()
  const endpoint = type === 'stations'
    ? `/v1/catalog/${encodeURIComponent(sf)}/stations/${encodeURIComponent(resourceId)}?extend=editorialVideo,editorialArtwork&include=radio-show`
    : `/v1/catalog/${encodeURIComponent(sf)}/${type}/${encodeURIComponent(resourceId)}?extend=editorialVideo,editorialArtwork`
  const data = await gemsRequest(endpoint)
  const resource = Array.isArray(data?.data) ? data.data[0] : null
  const motion = extractMotionArtwork(resource, 600)
  const poster = motion.poster || art(resource?.attributes, 600)
  if (!motion.video && !poster) return null
  return { video: motion.video, poster: poster || undefined }
}

export async function fetchApplePlaylistMotion(
  playlistId: string,
  storefront?: string,
): Promise<{ video?: string; poster?: string } | null> {
  return fetchAppleResourceMotion('playlists', playlistId, storefront)
}

/**
 * 电台详情（web /station/… 同款）：
 * GET /v1/catalog/{sf}/stations/{id}?extend=editorialVideo,editorialArtwork&include=radio-show
 */
export async function fetchAppleStationDetail(stationId: string, storefront?: string): Promise<AppleWebItem | null> {
  if (!stationId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/stations/${encodeURIComponent(stationId)}?extend=editorialVideo,editorialArtwork&include=radio-show&fields[stations]=name,url,artwork,editorialArtwork,editorialVideo,editorialNotes,playParams,isLive,airTime`,
  )
  const resource = Array.isArray(data?.data) ? data.data[0] : null
  if (!resource?.attributes?.name) return null
  const item = itemize(resource, 'stations')
  if (!item) return null
  const show = resource.relationships?.radioShow?.data?.[0]
  if (show?.attributes?.name && !item.showName) item.showName = show.attributes.name
  return item
}

// ─────────────────────────── 资料库（Library） ───────────────────────────

/** 资料库入口（1:1 web）：最近添加 / 艺人 / 专辑 / 歌曲 / 专属推荐 */
export async function fetchAppleLibraryPage(_storefront?: string): Promise<AppleWebPage> {
  const loggedIn = Boolean(getAppleCredentials().developerToken && getAppleCredentials().mediaUserToken)
  if (!loggedIn) {
    return { sections: [], hero: null, personalized: false, sourceLabel: '登录后可查看资料库' }
  }
  const [recentlyAdded, songs, albums, artists, playlists, videos, listenNow] = await Promise.allSettled([
    fetchHomeRecentlyAdded(),
    getAppleLibrarySongs(5000),
    getAppleLibraryAlbums(2000),
    getAppleLibraryArtists(1000),
    fetchAppleLibraryPlaylistsSection(),
    fetchAppleLibraryVideosSection(),
    fetchHomeListenNow(),
  ])
  const sections: AppleWebSection[] = []
  // 资料库各分区在官网都是方形网格（专辑/最近添加 172×172）或表格（歌曲），统一打上布局标记。
  // 最近添加 / 艺人 / 专辑 / 音乐视频 / 播放列表：官网是「2 行 + 每行 5 个并露出第 6 个一点」的横向货架。
  const asGrid = (section: AppleWebSection | null | undefined): AppleWebSection | null =>
    section ? { ...section, layoutType: 'library-rows' } : null
  const recentSection = asGrid(recentlyAdded.status === 'fulfilled' ? recentlyAdded.value : null)
  if (recentSection) sections.push(recentSection)
  if (artists.status === 'fulfilled' && artists.value.length > 0) {
    sections.push({
      id: 'library-artists', kind: 'row', layoutType: 'library-rows', title: '艺人', subtitle: `资料库共 ${artists.value.length} 位`,
      items: artists.value.map((artist): AppleWebItem => {
        const catalogId = (artist as typeof artist & { catalogId?: string }).catalogId
        return {
          id: artist.id, playId: catalogId || artist.id, libraryId: artist.id, catalogId,
          type: 'artists', name: artist.name,
          subtitle: artist.genreName, artworkUrl: artist.artworkUrl, isLibrary: true,
        }
      }),
    })
  }
  const playlistSection = asGrid(playlists.status === 'fulfilled' ? playlists.value : null)
  if (playlistSection) sections.push(playlistSection)
  if (albums.status === 'fulfilled' && albums.value.length > 0) {
    sections.push({
      id: 'library-albums', kind: 'row', layoutType: 'library-rows', title: '专辑', subtitle: `资料库共 ${albums.value.length} 张`,
      items: albums.value.map((album): AppleWebItem => ({
        id: album.id, playId: album.catalogId || album.id, libraryId: album.id, catalogId: album.catalogId,
        type: 'albums', name: album.name,
        subtitle: album.artistName, artworkUrl: album.artworkUrl, artistName: album.artistName,
        releaseDate: album.releaseDate, trackCount: album.trackCount, isLibrary: true,
      })),
    })
  }
  const videoSection = asGrid(videos.status === 'fulfilled' ? videos.value : null)
  if (videoSection) sections.push(videoSection)
  if (songs.status === 'fulfilled' && songs.value.length > 0) {
    sections.push({
      // 实测官网 /library/songs 为五列表格（名称/艺人/专辑/时长）；用 song-grid + layoutType=track 走表格渲染。
      id: 'library-songs', kind: 'song-grid', layoutType: 'library-track-rows', title: '歌曲', subtitle: `资料库共 ${songs.value.length} 首`,
      items: songs.value.map((track): AppleWebItem => ({
        id: track.id, playId: track.catalogId || track.id, libraryId: track.id, catalogId: track.catalogId,
        type: 'songs',
        name: track.name, subtitle: track.artistName, artworkUrl: track.artworkUrl,
        artistName: track.artistName, durationMs: track.durationMs, isLibrary: true,
      })),
    })
  }
  if (listenNow.status === 'fulfilled') {
    const madeForYou = listenNow.value.sections
      .filter(section => section.kind === 'row')
      .flatMap(section => section.items)
      .slice(0, 40)
    if (madeForYou.length > 0) {
      sections.push({ id: 'library-made-for-you', kind: 'row', layoutType: 'library-grid', title: '专属推荐', subtitle: 'Apple Music 根据你的口味生成', items: madeForYou })
    }
  }
  const failedLabels = [
    { label: '最近添加', result: recentlyAdded },
    { label: '歌曲', result: songs },
    { label: '专辑', result: albums },
    { label: '艺人', result: artists },
    { label: '播放列表', result: playlists },
    { label: '音乐视频', result: videos },
    { label: '专属推荐', result: listenNow },
  ].filter(entry => entry.result.status === 'rejected').map(entry => entry.label)
  return {
    sections,
    hero: null,
    personalized: true,
    sourceLabel: 'apple-api（资料库）',
    fallbackReason: failedLabels.length > 0 ? `部分资料库内容加载失败：${failedLabels.join('、')}。可刷新重试。` : undefined,
  }
}

/** 库专辑曲目 → 可播放 Song（catalogId 优先，走统一播放链路） */
export async function fetchLibraryAlbumTracksForPlay(albumId: string): Promise<Song[]> {
  const tracks = await getAppleLibraryAlbumTracks(albumId)
  return tracks.map(track => appleLibraryTrackToSong(track))
}

/** 库艺人在资料库内的专辑（艺人抽屉用） */
export async function fetchLibraryArtistAlbumsForDrawer(artistId: string): Promise<AppleLibraryAlbum[]> {
  return getAppleLibraryArtistAlbums(artistId)
}

// ─────────────────────────── 播放与收藏动作 ───────────────────────────

/** 行内条目 → 可播放 Song（platform=apple，走统一播放链路：原生→载体回退） */
export function appleWebItemToSong(item: AppleWebItem, storefront?: string): Song {
  const song = appleSongToSong(
    {
      id: item.playId || item.id,
      artistId: item.artistId,
      albumId: item.albumId,
      name: item.name,
      artistName: item.artistName || item.subtitle || '',
      artworkUrl: item.artworkUrl,
      durationMs: item.durationMs,
    },
    storefront || getStorefront(),
  )
  if (item.libraryId) song.appleLibraryId = item.libraryId
  return song
}

/** 电台 → 播放描述 Song。流不进入队列；每次播放由 App 重新请求 /v1/play/assets。 */
export function appleStationToSong(station: AppleWebItem, _stream?: AppleNativeStream, storefront = getStorefront()): Song {
  const stationId = station.playId || station.id
  const timeline = station.isLive === true ? 'live' : station.isLive === false ? 'vod' : 'unknown'
  return {
    id: 0,
    appleId: stationId,
    appleStorefront: storefront,
    name: station.name || 'Apple Music 电台',
    artists: [{ name: station.showName || 'Apple Music 电台' }],
    album: { name: station.showName || 'Apple Music 电台', picUrl: station.artworkUrl || station.motionPosterUrl || station.heroArtworkUrl || '' },
    duration: station.durationMs || 0,
    platform: 'apple',
    vip: false,
    appleRadio: {
      stationId,
      storefront,
      playParams: station.playParams,
      timeline,
      showName: station.showName,
      description: station.description,
      airTime: station.airTime,
      artworkUrl: station.artworkUrl,
      motionArtworkUrl: station.motionArtworkUrl,
      motionPosterUrl: station.motionPosterUrl,
      heroArtworkUrl: station.heroArtworkUrl,
    },
  }
}

/** 歌单曲目 → 可播放 Song（目录歌单，catalog id 直接可播） */
export async function fetchApplePlaylistTracksForPlay(playlistId: string, storefront?: string): Promise<Song[]> {
  const songs = await getAppleCatalogPlaylistTracks(playlistId, storefront || getStorefront())
  return songs.map(song => appleSongToSong(song, storefront || getStorefront()))
}

/** 喜欢 / 取消喜欢（web 播放器正向：POST / DELETE /v1/me/favorites?ids[songs]=<id>） */
export async function setAppleFavorite(type: 'songs' | 'albums' | 'playlists', id: string, favorite: boolean): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest(`/v1/me/favorites?ids[${type}]=${encodeURIComponent(id)}`, {
    method: favorite ? 'POST' : 'DELETE',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs: 10000,
  })
  return result.ok
}

/** 歌单收藏 = 加入资料库（POST /v1/me/library {data:[{id,type:'playlists'}]}） */
export async function addApplePlaylistToLibrary(playlistId: string): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest('/v1/me/library', {
    method: 'POST',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    body: { data: [{ id: playlistId, type: 'playlists' }] },
    timeoutMs: 10000,
  })
  return result.ok
}

/** 歌单取消收藏 = 从资料库移除 */
export async function removeApplePlaylistFromLibrary(playlistId: string): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest(`/v1/me/library/playlists/${encodeURIComponent(playlistId)}`, {
    method: 'DELETE',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs: 10000,
  })
  return result.ok
}

export async function removeAppleResourceFromLibrary(
  type: 'albums' | 'music-videos' | 'stations',
  id: string,
  libraryId?: string,
): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken || !id) return false
  let resolvedLibraryId = libraryId || ''
  if (!resolvedLibraryId) {
    const lookup = await appleApiRequest(`/v1/me/library/${type}?filter[catalog-id]=${encodeURIComponent(id)}&limit=1`, {
      developerToken: credentials.developerToken,
      mediaUserToken: credentials.mediaUserToken,
      timeoutMs: 10000,
    })
    const item = Array.isArray(lookup.data?.data) ? lookup.data.data[0] : null
    resolvedLibraryId = item?.id ? String(item.id) : ''
  }
  if (!resolvedLibraryId) return false
  const result = await appleApiRequest(`/v1/me/library/${type}/${encodeURIComponent(resolvedLibraryId)}`, {
    method: 'DELETE',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs: 10000,
  })
  return result.ok
}

/** 电台加入资料库（尝试；部分商店不可用则返回 false） */
export async function addAppleStationToLibrary(stationId: string): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest('/v1/me/library', {
    method: 'POST',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    body: { data: [{ id: stationId, type: 'stations' }] },
    timeoutMs: 10000,
  })
  return result.ok
}

// ─────────────────────────── 资料库写操作（歌曲/专辑/视频） ───────────────────────────

/** 通用「加入资料库」（POST /v1/me/library；web 歌曲行「添加到资料库」同款） */
async function addAppleToLibrary(type: 'songs' | 'albums' | 'music-videos' | 'playlists' | 'stations', id: string): Promise<boolean> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) return false
  const result = await appleApiRequest('/v1/me/library', {
    method: 'POST',
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    body: { data: [{ id, type }] },
    timeoutMs: 10000,
  })
  return result.ok
}

/** 单曲加入资料库 */
export function addAppleSongToLibrary(songId: string): Promise<boolean> {
  return addAppleToLibrary('songs', songId)
}

/** 专辑加入资料库 */
export function addAppleAlbumToLibrary(albumId: string): Promise<boolean> {
  return addAppleToLibrary('albums', albumId)
}

/** 音乐视频加入资料库 */
export function addAppleMusicVideoToLibrary(videoId: string): Promise<boolean> {
  return addAppleToLibrary('music-videos', videoId)
}

// ─────────────────────────── 资料库分区（播放列表 / 音乐视频） ───────────────────────────

/** 资料库「播放列表」分区（web 侧栏 播放列表/所有播放列表 同款） */
export async function fetchAppleLibraryPlaylistsSection(): Promise<AppleWebSection | null> {
  const playlists = await getAppleLibraryPlaylists(2000)
  if (playlists.length === 0) return null
  return {
    id: 'library-playlists',
    kind: 'grid',
    title: '播放列表',
    subtitle: '你的资料库歌单',
    items: playlists.map(playlist => ({
      id: playlist.id,
      playId: playlist.catalogId || playlist.id,
      libraryId: playlist.id,
      catalogId: playlist.catalogId,
      type: 'playlists',
      isLibrary: true,
      name: playlist.name,
      subtitle: playlist.curatorName || '我创建的歌单',
      description: playlist.description,
      artworkUrl: playlist.artworkUrl,
      curatorName: playlist.curatorName,
      trackCount: playlist.trackCount,
    })),
  }
}

/** 资料库「音乐视频」分区（web 侧栏 音乐视频 同款） */
export async function fetchAppleLibraryVideosSection(): Promise<AppleWebSection | null> {
  const videos = await getAppleLibraryMusicVideos(1000)
  if (videos.length === 0) return null
  return {
    id: 'library-videos',
    kind: 'grid',
    title: '音乐视频',
    subtitle: '资料库中的视频',
    items: videos.map(video => ({
      id: video.id,
      playId: video.catalogId || video.id,
      type: 'music-videos',
      isLibrary: true,
      name: video.name,
      subtitle: video.artistName,
      artworkUrl: video.artworkUrl,
      artistName: video.artistName,
      durationMs: video.durationMs,
    })),
  }
}

/** 库内歌单曲目 → 可播放 Song（catalog 关联 id 优先，走统一播放链路） */
export async function fetchLibraryPlaylistTracksForPlay(playlistId: string): Promise<Song[]> {
  const tracks = await getApplePlaylistTracks(playlistId, 300)
  return tracks.map(track => appleLibraryTrackToSong(track))
}

// ─────────────────────────── 排行榜页（web /new/top-charts 同款） ───────────────────────────

/** 排行榜页（歌曲/专辑/视频榜 + 每周热门100 + 城市榜） */
export async function fetchAppleChartsPage(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const charts = await fetchAppleTopCharts(sf)
  if (charts.length === 0) {
    return { sections: [], hero: null, personalized: false, sourceLabel: '排行榜暂无数据' }
  }
  return { sections: charts, hero: null, personalized: false, sourceLabel: 'apple-api charts' }
}

// ─────────────────────────── 探索更多 room 页（web /room/{id} 同款） ───────────────────────────

/**
 * room 页（web /room/{id} 与模块标题 `>` 入口同款）。
 *
 * 实测结构（与"编辑树"完全不同，务必注意）：
 * - 端点 `/v1/editorial/{sf}/rooms/{id}`，响应只有 `resources.rooms` 与内容资源；
 * - 标题在 `rooms[].attributes.title`（**不是 name**）；
 * - 条目在 `rooms[].relationships.contents`，一次性返回全部（实测 limit 参数返回 400、offset 被忽略、无 meta/next）；
 * - 条目可混合类型（实测「大家都在听」为歌单+专辑）。
 */
export async function fetchAppleRoomPage(roomId: string, storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  if (!roomId) return { sections: [], hero: null, personalized: false, sourceLabel: 'room 参数缺失' }
  const data = await gemsRequest(
    `/v1/editorial/${encodeURIComponent(sf)}/rooms/${encodeURIComponent(roomId)}`
    + '?art%5Burl%5D=c%2Cf'
    + '&extend=editorialVideo%2Coffers%2CseoDescription%2CseoTitle'
    + '&extend%5Balbums%5D=artistUrl'
    + '&fields%5Balbums%5D=artistName%2CartistUrl%2Cartwork%2CcontentRating%2CeditorialArtwork%2CeditorialNotes%2Cname%2CplayParams%2CreleaseDate%2Curl%2CtrackCount'
    + '&format%5Bresources%5D=map'
    + '&include%5Balbums%5D=artists%2Ccomposers'
    + '&include%5Bsongs%5D=artists%2Ccomposers'
    + '&l=zh-Hans-CN'
    + '&omit%5Bresource%3Aartists%5D=autos'
    + '&platform=web'
    + '&relate%5Bsongs%5D=albums',
  )
  if (!data) return { sections: [], hero: null, personalized: false, sourceLabel: 'room 取流失败' }
  const resolveResource = createEditorialResourceResolver(data)
  const rawRoom = Array.isArray(data.data) ? data.data[0] : null
  const room = rawRoom ? resolveResource(rawRoom) : null
  const roomResource = room?.['id'] && room?.['type'] === 'rooms'
    ? room
    : Object.values((data.resources || {}).rooms || {})[0]
  if (!roomResource) return { sections: [], hero: null, personalized: false, sourceLabel: 'room 取流失败' }

  const title = displayString(roomResource.attributes?.title) || displayString(roomResource.attributes?.name) || '探索'
  const items: AppleWebItem[] = []
  ;(roomResource.relationships?.contents?.data || []).forEach((content: any) => {
    const resource = resolveResource(content)
    const itemType = normalizeContentType(String(resource?.type || content?.type || ''))
    if (!itemType) return
    const item = itemize(resource, itemType)
    if (item) items.push(item)
  })

  const sections: AppleWebSection[] = items.length > 0
    ? [{
      id: `room-${roomId}`,
      kind: sectionKindForItems(items),
      // 房间页标题由上层页头渲染，这里留空避免重复。
      title: '',
      items,
      roomId,
      // room 页条目在官网是换行网格（实测 204px × 5 列、不横向滚动）；歌曲 room 会走表格分支。
      layoutType: items.every(item => item.type === 'songs') ? 'track' : 'room-grid',
      displayStyle: 'expanded',
    }]
    : []
  return {
    sections,
    hero: null,
    personalized: false,
    sourceLabel: `apple-api room(${title})`,
  }
}

/**
 * grouping 页（web /grouping/{id}，如音乐视频 170872、空间音频 188741）。
 * 结构与首页同构：groupings → tabs[0]（editorial-elements 根）→ children。
 */
export async function fetchAppleGroupingPage(groupingId: string, storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  if (!groupingId) return { sections: [], hero: null, personalized: false, sourceLabel: 'grouping 参数缺失' }
  const data = await gemsRequest(
    `/v1/editorial/${encodeURIComponent(sf)}/groupings/${encodeURIComponent(groupingId)}`
    + '?art%5Burl%5D=c%2Cf'
    + '&extend=artistUrl%2CeditorialArtwork%2CeditorialVideo%2CplainEditorialNotes'
    + '&extend%5Bstation-events%5D=editorialVideo'
    + '&fields%5Balbums%5D=artistName%2CartistUrl%2Cartwork%2CcontentRating%2CeditorialArtwork%2CplainEditorialNotes%2Cname%2CplayParams%2CreleaseDate%2Curl%2CtrackCount'
    + '&fields%5Bartists%5D=name%2Curl%2Cartwork%2CeditorialArtwork%2CgenreNames%2CplainEditorialNotes'
    + '&format%5Bresources%5D=map'
    + '&include%5Balbums%5D=artists&include%5Bmusic-videos%5D=artists&include%5Bsongs%5D=artists'
    + '&include%5Bstations%5D=events%2Cradio-show'
    + '&l=zh-Hans-CN'
    + '&omit%5Bresource%3Aartists%5D=autos'
    + '&platform=web&relate%5Bsongs%5D=albums&tabs=subscriber',
  )
  return editorialDocumentToPage(data, 'grouping')
}

/**
 * multi-room 页（web /multi-room/{id}，入口来自 320 banner 的 viewMultiRoom?fcId=）。
 * 实测元素类型为 **345（货架，与 326 同形）+ 404（纯文本区块）**，自身无 title。
 */
export async function fetchAppleMultiRoomPage(multiRoomId: string, storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  if (!multiRoomId) return { sections: [], hero: null, personalized: false, sourceLabel: 'multiroom 参数缺失' }
  const data = await gemsRequest(
    `/v1/editorial/${encodeURIComponent(sf)}/multirooms/${encodeURIComponent(multiRoomId)}`
    + '?art%5Burl%5D=c%2Cf'
    + '&extend=artistUrl%2CeditorialArtwork%2CeditorialVideo%2CplainEditorialNotes'
    + '&format%5Bresources%5D=map'
    + '&include%5Balbums%5D=artists&include%5Bsongs%5D=artists'
    + '&l=zh-Hans-CN'
    + '&omit%5Bresource%3Aartists%5D=autos'
    + '&platform=web&relate%5Bsongs%5D=albums',
  )
  return editorialDocumentToPage(data, 'multiroom')
}

/** 把 groupings/groupings{id}/multirooms 这类"编辑文档"解析为页面（共享解析路径）。 */
function editorialDocumentToPage(data: any, label: string): AppleWebPage {
  const empty: AppleWebPage = { sections: [], hero: null, personalized: false, sourceLabel: `${label} 取流失败` }
  if (!data) return empty
  const resolveResource = createEditorialResourceResolver(data)
  const reference = Array.isArray(data.data) ? data.data[0] : null
  if (!reference) return empty
  const document = resolveResource(reference)
  const tabReference = pickTab(document)
  const tab = resolveResource(tabReference)
  const childReferences = tab?.relationships?.children?.data || document?.relationships?.children?.data || []
  const children = childReferences.map(resolveResource)
  if (children.length === 0) return empty
  const sections = parseEditorialSections(children, 0, 'music', resolveResource)
  const title = displayString(document?.attributes?.title) || displayString(document?.attributes?.name) || label
  return { sections, hero: null, personalized: false, sourceLabel: `apple-api ${label}(${title})` }
}

// ─────────────────────────── Posts（web /post/{id} 同款） ───────────────────────────

export interface ApplePostDetail {
  id: string
  name: string
  artistName?: string
  artworkUrl?: string
  body?: string
  /** 帖子附带的可播内容（歌曲/专辑/音乐视频/歌单） */
  media?: AppleWebItem[]
}

/**
 * 帖子详情（艺人分享）：GET /v1/catalog/{sf}/posts/{id}?include=…
 * 接口字段为尽力解析（web 前端 bundle 未完全逆向），失败时上层用卡片信息兜底。
 */
export async function fetchApplePostDetail(postId: string, storefront?: string): Promise<ApplePostDetail | null> {
  if (!postId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/posts/${encodeURIComponent(postId)}`
    + '?include=artists,songs,albums,music-videos,playlists&extend=plainEditorialNotes',
  )
  const resource = Array.isArray(data?.data) ? data.data[0] : null
  if (!resource?.attributes?.name) return null
  const attributes = resource.attributes || {}
  const media: AppleWebItem[] = []
  ;['songs', 'albums', 'music-videos', 'playlists'].forEach(type => {
    ;(resource.relationships?.[type]?.data || []).forEach((content: any) => {
      const item = itemize(content, type as AppleWebItemType)
      if (item) media.push(item)
    })
  })
  return {
    id: String(resource.id),
    name: attributes.name,
    artistName: attributes.artistName || attributes.curatorName,
    artworkUrl: art(attributes),
    body: attributes.body || attributes.plainEditorialNotes?.standard || attributes.description?.standard,
    media,
  }
}
