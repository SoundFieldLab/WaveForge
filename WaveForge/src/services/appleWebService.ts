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
  getAppleLibraryAlbumTracks,
  getAppleLibraryArtistAlbums,
  getApplePlaylistTracks,
  appleLibraryTrackToSong,
  appleSongToSong,
  type AppleCatalogSong,
  type AppleLibraryAlbum,
} from './appleCatalog'
import { toHighResArtwork } from './appleMusic'
import type { AppleNativeStream, AppleRadioPlayParams } from './applePlayback'
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

export type AppleWebItemType = 'songs' | 'playlists' | 'albums' | 'stations' | 'radio-shows' | 'artists' | 'music-videos' | 'uploaded-videos' | 'posts' | 'rooms'

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
  /** [317] 徽章卡（新发现主视觉网格） */
  | 'featured-cards'
  /** [320] 宽幅横幅（带 designTag 文案） */
  | 'banner'
  /** [394] 节目卡（电台主持人 / 艺人主持节目） */
  | 'show-cards'
  /** [326]/[327] 网格区（电台单集 / 歌曲 / 歌单） */
  | 'grid'
  /** 主页横向行（listen-now 个性化组） */
  | 'row'
  /** 排行榜（charts 端点） */
  | 'chart'
  /** 搜索落地：类别浏览（apple-curators） */
  | 'curators'

export interface AppleWebSection {
  id: string
  kind: AppleWebSectionKind
  title: string
  subtitle?: string
  items: AppleWebItem[]
  /** banner 专用：宽幅图 */
  bannerUrl?: string
  /** banner 专用：说明文案（designTag） */
  tag?: string
  /** chart 专用：榜单类型（most-played / daily-global-top / city-top） */
  chartType?: string
}

export interface AppleWebPage {
  sections: AppleWebSection[]
  /** 页面主视觉（web powerswoosh 大卡；仅主页使用） */
  hero?: AppleWebItem | null
  /** 是否登录态个性化数据 */
  personalized: boolean
  /** 数据来源说明（展示用） */
  sourceLabel: string
}

/** 兼容旧引用 */
export type AppleWebRow = AppleWebSection

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
const CONTENT_TYPES: string[] = ['songs', 'albums', 'playlists', 'stations', 'radio-shows', 'radio-show', 'artists', 'music-videos', 'uploaded-videos', 'posts', 'rooms']

function normalizeContentType(type: string): AppleWebItemType | null {
  if (type === 'radio-show') return 'radio-shows'
  return CONTENT_TYPES.includes(type) ? type as AppleWebItemType : null
}

function itemize(resource: any, type: AppleWebItemType, preferredId?: string): AppleWebItem | null {
  const attributes = resource?.attributes || {}
  const name = displayString(attributes.name) || displayString(attributes.title)
  if (!name && !resource?.id) return null
  const playParams = attributes.playParams || {}
  const motion = extractMotionArtwork(resource)
  const playParamsFields: AppleRadioPlayParams = {}
  if (playParams.id !== undefined) playParamsFields.id = String(playParams.id)
  if (playParams.kind !== undefined) playParamsFields.kind = String(playParams.kind)
  if (playParams.format !== undefined) playParamsFields.format = String(playParams.format)
  if (playParams.stationHash !== undefined) playParamsFields.stationHash = String(playParams.stationHash)
  if (typeof playParams.hasDrm === 'boolean') playParamsFields.hasDrm = playParams.hasDrm
  if (playParams.mediaType !== undefined) playParamsFields.mediaType = String(playParams.mediaType)
  return {
    id: String(resource.id || ''),
    playId: preferredId || catalogIdOf(resource),
    type,
    name: name || displayString(attributes.title),
    subtitle: type === 'songs' || type === 'albums' ? attributes.artistName
      : type === 'playlists' ? attributes.curatorName
        : attributes.radioShowName || attributes.editorialNotes?.short,
    description: attributes.description?.short || attributes.description?.standard || attributes.editorialNotes?.short,
    artworkUrl: art(attributes),
    motionArtworkUrl: motion.video,
    motionPosterUrl: motion.poster,
    heroArtworkUrl: extractHeroArtwork(resource),
    artistName: attributes.artistName,
    artistId: resource?.relationships?.artists?.data?.[0]?.id ? String(resource.relationships.artists.data[0].id) : undefined,
    albumId: resource?.relationships?.albums?.data?.[0]?.id ? String(resource.relationships.albums.data[0].id) : undefined,
    durationMs: attributes.durationInMillis || attributes.durationMillis || attributes.durationInMilliseconds,
    curatorName: attributes.curatorName,
    trackCount: attributes.trackCount ?? attributes.playlistTrackCount ?? (Array.isArray(resource?.relationships?.tracks?.data) ? resource.relationships.tracks.data.length : undefined),
    releaseDate: attributes.releaseDate,
    showName: attributes.radioShowName,
    url: attributes.url,
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
function extractMotionArtwork(resource: any, size = 600): { video?: string; poster?: string } {
  try {
    const ev = resource?.attributes?.editorialVideo || {}
    const keys = ['motionDetailSquare', 'motionDetailTall', 'motionSquareVideo1x1', 'motionTallVideo3x4', 'motionWideVideo21x9', 'motionHero', 'motionArtistSquare']
    for (const key of keys) {
      const node = ev?.[key]
      const video = node?.video
      if (typeof video === 'string' && video.endsWith('.m3u8')) {
        const frameUrl = node?.previewFrame?.url || ''
        const poster = typeof frameUrl === 'string' && frameUrl
          ? toHighResArtwork(frameUrl, size)
          : ''
        return { video, poster: poster || undefined }
      }
    }
    return {}
  } catch {
    return {}
  }
}

function extractHeroArtwork(resource: any, size = 1200): string | undefined {
  try {
    const attributes = resource?.attributes || {}
    for (const url of [attributes?.editorialArtwork?.url, attributes?.artwork?.url, attributes?.editorialVideo?.url]) {
      if (typeof url === 'string' && url) {
        const resolved = toHighResArtwork(url, size)
        if (/^https?:\/\//.test(resolved)) return resolved
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function gemsRequest(
  path: string,
  options?: { method?: string; body?: unknown; mediaUserToken?: boolean },
): Promise<any | null> {
  const credentials = getAppleCredentials()
  if (!credentials.developerToken) return null
  if (options?.mediaUserToken && !credentials.mediaUserToken) return null
  const result = await appleApiRequest(path, {
    method: options?.method || 'GET',
    developerToken: credentials.developerToken,
    mediaUserToken: options?.mediaUserToken ? credentials.mediaUserToken : undefined,
    body: options?.body,
    timeoutMs: 10000,
  })
  if (!result.ok) return null
  return result.data
}

// ─────────────────────────── editorial 树解析（browse / radio / curator 共用） ───────────────────────────

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
function parseEditorialSections(elements: any[], depth = 0): AppleWebSection[] {
  if (depth > 5) return []
  const sections: AppleWebSection[] = []
  let pendingCards: AppleWebItem[] = []
  let cardSeq = 0

  const flushCards = () => {
    if (pendingCards.length === 0) return
    const first = pendingCards[0]
    sections.push({
      id: `cards-${cardSeq++}`,
      kind: 'featured-cards',
      title: first?.badge || '精选推荐',
      items: pendingCards,
    })
    pendingCards = []
  }

  const pushInner = (inner: AppleWebSection[]) => {
    inner.forEach(section => {
      if (section.kind === 'featured-cards') {
        pendingCards.push(...section.items)
      } else {
        flushCards()
        sections.push(section)
      }
    })
  }

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    const attributes = element.attributes || {}
    const kind = String(attributes.editorialElementKind || '')
    const relations = element.relationships || {}

    if (kind === '316' || (kind === '' && relations.children)) {
      // 容器：递归
      pushInner(parseEditorialSections(relations.children?.data || [], depth + 1))
    } else if (kind === '317') {
      const content = relations.contents?.data?.[0]
      const itemType = normalizeContentType(String(content?.type || 'playlists'))
      if (itemType) {
        const item = itemize(content, itemType)
        if (item) {
          item.badge = attributes.designBadge || undefined
          item.tag = attributes.designTag || undefined
          item.bannerUrl = attributes.artwork?.url ? bannerArt(attributes) : undefined
          pendingCards.push(item)
        }
      }
    } else if (kind === '320') {
      const content = relations.contents?.data?.[0]
      const itemType = normalizeContentType(String(content?.type || ''))
      const item = itemType
        ? itemize(content, itemType)
        : null
      const bannerUrl = attributes.artwork?.url ? bannerArt(attributes) : undefined
      if (item || bannerUrl) {
        flushCards()
        sections.push({
          id: `banner-${element.id || sections.length}`,
          kind: 'banner',
          title: displayString(attributes.designBadge) || item?.name || '',
          tag: attributes.designTag || undefined,
          bannerUrl,
          items: item ? [item] : [],
        })
      }
    } else if (kind === '326' || kind === '327') {
      const contents: any[] = relations.contents?.data || []
      const items: AppleWebItem[] = []
      contents.forEach((content: any) => {
        const itemType = normalizeContentType(String(content?.type || ''))
        if (!itemType) return
        const item = itemize(content, itemType)
        if (item) items.push(item)
      })
      if (items.length > 0) {
        flushCards()
        sections.push({
          id: `grid-${element.id || sections.length}`,
          kind: 'grid',
          title: displayString(attributes.name) || displayString(attributes.title) || '精选',
          items: items.slice(0, 50),
        })
      }
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
          kind: 'show-cards',
          title: displayString(attributes.name) || displayString(attributes.title) || '节目',
          items: shows,
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
    `/v1/editorial/${encodeURIComponent(storefront)}/groupings?name=${encodeURIComponent(name)}&platform=web&tabs=subscriber`
    + '&omit[resource:artists]=autos&relate[songs]=albums'
    + '&include[albums]=artists&include[songs]=artists&include[music-videos]=artists'
    + '&include[stations]=events,radio-show&extend[station-events]=editorialVideo'
    + '&fields[artists]=name,url,artwork,editorialArtwork,genreNames,plainEditorialNotes'
    + '&fields[albums]=artistName,artistUrl,artwork,contentRating,editorialArtwork,plainEditorialNotes,name,playParams,releaseDate,url,trackCount'
    + '&extend=editorialArtwork,artistUrl,plainEditorialNotes',
  )
  if (!data) return { sections: [], hero: null }
  const grouping = Array.isArray(data.data) ? data.data[0] : null
  const tab = pickTab(grouping)
  const sections = parseEditorialSections(tab?.relationships?.children?.data || [])
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
async function fetchHomeListenNow(): Promise<{ sections: AppleWebSection[]; hero: AppleWebItem | null }> {
  const data = await gemsRequest(
    '/v1/me/recommendations?platform=web&types=albums,playlists,stations'
    + '&include[albums]=artists&include[library-playlists]=catalog&include[stations]=radio-show'
    + '&include[personal-recommendation]=primary-content&fields[artists]=name,artwork,url'
    + '&omit[resource]=autos&extend[stations]=airTime,supportsAirTimeUpdates&meta[stations]=inflectionPoints',
    { mediaUserToken: true },
  )
  if (!data) return { sections: [], hero: null }
  const resourceMap = data.resources || {}
  const findResource = (id: string, type: string): any =>
    resourceMap?.[id] || resourceMap?.[type]?.[id] || null
  const groups: any[] = Array.isArray(data.data) ? data.data : []
  const sections: AppleWebSection[] = []
  let hero: AppleWebItem | null = null

  const collectGroupItems = (group: any): AppleWebItem[] => {
    const collected: AppleWebItem[] = []
    const relations = group?.relationships || {}
    const refs: any[] = []
    const seen = new Set<string>()
    for (const key of Object.keys(relations)) {
      const node = relations[key]?.data
      if (!Array.isArray(node)) continue
      for (const ref of node) {
        const refKey = `${ref?.type}:${ref?.id}`
        if (seen.has(refKey)) continue
        seen.add(refKey)
        refs.push(ref)
      }
    }
    refs.forEach((ref: any) => {
      const type = String(ref?.type || '')
      if (!['albums', 'playlists', 'stations', 'songs'].includes(type)) return
      // 内联 attributes 优先（实测 listen-now 条目为内联完整对象），否则查 resources
      const resource = (ref?.attributes && ref.id) ? ref : findResource(String(ref?.id || ''), type)
      if (!resource?.attributes) return
      const item = itemize(resource, type as AppleWebItemType)
      if (item) collected.push(item)
    })
    return collected
  }

  groups.forEach((group: any, index: number) => {
    const title = displayString(group?.attributes?.stringForDisplay) || displayString(group?.attributes?.title) || (index === 0 ? '专属推荐' : '为你推荐')
    const items = collectGroupItems(group)
    if (items.length === 0) return
    if (!hero && (items[0].artworkUrl || items[0].motionArtworkUrl || items[0].heroArtworkUrl)) hero = items[0]
    // 同一组内按类型拆行（web 一组一 shelf）
    const groupsByType = new Map<AppleWebItemType, AppleWebItem[]>()
    items.forEach(item => {
      const list = groupsByType.get(item.type) || []
      list.push(item)
      groupsByType.set(item.type, list)
    })
    groupsByType.forEach((typedItems, kind) => {
      sections.push({
        id: `listen-now-${index}-${kind}`,
        kind: 'row',
        title,
        items: typedItems.slice(0, 40),
      })
    })
  })
  // 主页辅助 shelf（最近添加）与本组并行竞速：3.5s 内到才展示，避免拖慢主页
  const extras = await Promise.race([
    (async () => {
      const added = await fetchHomeRecentlyAdded().catch(() => null)
      return added ? [added] : []
    })(),
    new Promise<AppleWebSection[]>(resolve => setTimeout(() => resolve([]), 3500)),
  ])
  extras.forEach(section => sections.push(section))
  return { sections, hero }
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
      return { sections: result.sections, hero: result.hero, personalized: true, sourceLabel: 'apple-api listen-now' }
    }
    return { sections: [], hero: null, personalized: false, sourceLabel: 'listen-now 暂无数据（已登录）' }
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
  const pushChart = (chart: any) => {
    const items: any[] = Array.isArray(chart?.data) ? chart.data : []
    const firstType = String(items[0]?.type || '')
    const type: AppleWebItemType = CONTENT_TYPES.includes(firstType) ? firstType as AppleWebItemType : 'songs'
    const mapped: AppleWebItem[] = []
    items.forEach((item: any) => {
      const mappedItem = itemize(item, type)
      if (mappedItem) mapped.push(mappedItem)
    })
    if (mapped.length > 0) {
      sections.push({
        id: `chart-${type}-${chart?.chart || 'most-played'}`,
        kind: 'chart',
        title: chart?.shortName || chart?.name || '排行榜',
        chartType: chart?.chart,
        items: mapped.slice(0, 50),
      })
    }
  }
  if (Array.isArray(results?.songs?.[0]?.data)) pushChart(results.songs[0])
  if (Array.isArray(results?.dailyGlobalTopCharts?.[0]?.data)) pushChart(results.dailyGlobalTopCharts[0])
  if (Array.isArray(results?.albums?.[0]?.data)) pushChart(results.albums[0])
  if (Array.isArray(results?.playlists?.[0]?.data)) pushChart(results.playlists[0])
  if (Array.isArray(results?.['music-videos']?.[0]?.data)) pushChart(results['music-videos'][0])
  if (Array.isArray(results?.cityCharts?.[0]?.data)) pushChart(results.cityCharts[0])
  return sections
}

// ─────────────────────────── 新发现 / 广播 ───────────────────────────

/** 新发现（web /new 同款编辑页 + 排行榜；接口失败回退 RSS） */
export async function fetchAppleBrowsePage(storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  const editorial = await fetchEditorialPage('browse', sf)
  const charts = await fetchAppleTopCharts(sf).catch(() => [])
  const sections = [...editorial.sections, ...charts]
  if (sections.length === 0) {
    return { sections: await fetchHomeFallback(sf), hero: null, personalized: false, sourceLabel: 'apple-rss（browse 接口失败）' }
  }
  return { sections, hero: null, personalized: false, sourceLabel: 'apple-api editorial(browse)' }
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
  if (editorial.sections.length > 0 || editorial.hero) {
    const recentSection = loggedIn ? await fetchRecentRadioSection().catch(() => null) : null
    const sections = [...(recentSection ? [recentSection] : []), ...editorial.sections]
    return { sections, hero: editorial.hero, personalized: loggedIn, sourceLabel: 'apple-api editorial(radio)' }
  }
  const [recent, stations] = await Promise.allSettled([
    loggedIn ? fetchRecentRadioSection() : Promise.resolve(null),
    fetchCatalogStationsSection(sf),
  ])
  const sections: AppleWebSection[] = []
  if (recent.status === 'fulfilled' && recent.value) sections.push(recent.value)
  if (stations.status === 'fulfilled' && stations.value) sections.push(stations.value)
  return {
    sections,
    hero: null,
    personalized: loggedIn,
    sourceLabel: sections.length ? 'apple-api-catalog' : 'radio 暂无可展示内容（登录后可看最近电台）',
  }
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
    `/v1/recommendations/${encodeURIComponent(sf)}?name=search-landing&platform=web&omit[resource]=autos`
    + '&extend=editorialArtwork&types=activities,apple-curators,editorial-items&with=concerts',
  )
  const groups: any[] = Array.isArray(data?.data) ? data.data : []
  const items: AppleWebItem[] = []
  groups.forEach(group => {
    const contents: any[] = group?.relationships?.contents?.data || []
    contents.forEach((content: any) => {
      const attributes = content?.attributes || {}
      const name = displayString(attributes.name)
      if (!name || !content?.id) return
      const hero = attributes.editorialArtwork?.subscriptionHero?.url
        ? toHighResArtwork(attributes.editorialArtwork.subscriptionHero.url, 1600)
        : undefined
      items.push({
        id: String(content.id),
        playId: String(content.id),
        type: 'playlists',
        name,
        description: attributes.editorialNotes?.short || attributes.editorialNotes?.standard,
        artworkUrl: art(attributes),
        heroArtworkUrl: hero,
        url: attributes.url,
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
 * 分类页（web /curator/{slug}/{id} 同款）：
 * GET /v1/catalog/{sf}?ids[apple-curators]={id}&include=grouping,playlists&extend=editorialArtwork
 * 返回 curator 信息 + 歌单列表 + grouping（editorial 树 → 各分区）。
 */
export async function fetchAppleCuratorPage(curatorId: string, storefront?: string): Promise<AppleCuratorPage | null> {
  if (!curatorId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}?ids[curators]=${encodeURIComponent(curatorId)}&ids[apple-curators]=${encodeURIComponent(curatorId)}`
    + '&art[url]=f&include=grouping,playlists&extend[apple-curators]=playlistCount&extend[curators]=playlistCount&extend=editorialArtwork',
  )
  const element = Array.isArray(data?.data) ? data.data[0] : null
  if (!element?.attributes?.name) return null
  const attributes = element.attributes
  const hero = attributes.editorialArtwork?.subscriptionHero?.url
    ? toHighResArtwork(attributes.editorialArtwork.subscriptionHero.url, 1600)
    : undefined
  const curator: AppleWebItem = {
    id: String(element.id),
    playId: String(element.id),
    type: 'playlists',
    name: attributes.name,
    description: attributes.editorialNotes?.short || attributes.editorialNotes?.standard,
    artworkUrl: art(attributes),
    heroArtworkUrl: hero,
    curatorName: attributes.curatorName,
    trackCount: attributes.playlistCount,
    url: attributes.url,
  }
  const playlists: AppleWebItem[] = []
  ;(element.relationships?.playlists?.data || []).forEach((playlist: any) => {
    const item = itemize(playlist, 'playlists')
    if (item) playlists.push(item)
  })
  const grouping = element.relationships?.grouping?.data?.[0]
  const tab = pickTab(grouping, false)
  const sections = parseEditorialSections(tab?.relationships?.children?.data || [])
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

/**
 * 歌单动态封面（web 歌单卡 hover 动效同款）：
 * GET /v1/catalog/{sf}/playlists/{id}?extend=editorialVideo
 * 返回 motionDetailSquare 优先的 HLS 流 + 预览帧；无动态封面返回 null。
 */
export async function fetchApplePlaylistMotion(
  playlistId: string,
  storefront?: string,
): Promise<{ video: string; poster?: string } | null> {
  if (!playlistId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(`/v1/catalog/${encodeURIComponent(sf)}/playlists/${encodeURIComponent(playlistId)}?extend=editorialVideo`)
  const motion = extractMotionArtwork(Array.isArray(data?.data) ? data.data[0] : null, 600)
  if (!motion.video) return null
  return { video: motion.video, poster: motion.poster }
}

/**
 * 电台详情（web /station/… 同款）：
 * GET /v1/catalog/{sf}/stations/{id}?extend=editorialVideo,editorialArtwork&include=radio-show
 */
export async function fetchAppleStationDetail(stationId: string, storefront?: string): Promise<AppleWebItem | null> {
  if (!stationId) return null
  const sf = storefront || getStorefront()
  const data = await gemsRequest(
    `/v1/catalog/${encodeURIComponent(sf)}/stations/${encodeURIComponent(stationId)}?extend=editorialVideo,editorialArtwork&include=radio-show`,
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
    getAppleLibrarySongs(100),
    getAppleLibraryAlbums(80),
    getAppleLibraryArtists(60),
    fetchAppleLibraryPlaylistsSection(),
    fetchAppleLibraryVideosSection(),
    fetchHomeListenNow(),
  ])
  const sections: AppleWebSection[] = []
  if (recentlyAdded.status === 'fulfilled' && recentlyAdded.value) sections.push(recentlyAdded.value)
  if (artists.status === 'fulfilled' && artists.value.length > 0) {
    sections.push({
      id: 'library-artists', kind: 'row', title: '艺人', subtitle: `资料库共 ${artists.value.length} 位`,
      items: artists.value.map((artist): AppleWebItem => {
        const catalogId = (artist as typeof artist & { catalogId?: string }).catalogId
        return {
          id: artist.id, playId: catalogId || artist.id, libraryId: artist.id, catalogId,
          type: 'artists', name: artist.name,
          subtitle: artist.genreName, artworkUrl: artist.artworkUrl, isLibrary: !catalogId,
        }
      }),
    })
  }
  if (playlists.status === 'fulfilled' && playlists.value) sections.push(playlists.value)
  if (albums.status === 'fulfilled' && albums.value.length > 0) {
    sections.push({
      id: 'library-albums', kind: 'row', title: '专辑', subtitle: `资料库共 ${albums.value.length} 张`,
      items: albums.value.map((album): AppleWebItem => ({
        id: album.id, playId: album.catalogId || album.id, libraryId: album.id, catalogId: album.catalogId,
        type: 'albums', name: album.name,
        subtitle: album.artistName, artworkUrl: album.artworkUrl, artistName: album.artistName,
        releaseDate: album.releaseDate, trackCount: album.trackCount, isLibrary: !album.catalogId,
      })),
    })
  }
  if (videos.status === 'fulfilled' && videos.value) sections.push(videos.value)
  if (songs.status === 'fulfilled' && songs.value.length > 0) {
    sections.push({
      id: 'library-songs', kind: 'row', title: '歌曲', subtitle: `资料库共 ${songs.value.length} 首`,
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
      sections.push({ id: 'library-made-for-you', kind: 'row', title: '专属推荐', subtitle: 'Apple Music 根据你的口味生成', items: madeForYou })
    }
  }
  return { sections, hero: null, personalized: true, sourceLabel: 'apple-api（资料库）' }
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

/**
 * 电台 → 可播放 Song（携带已取好的直播流）。
 * 播放链路：loadAndPlaySong 检测到 appleRadio 后直接用其流（/v1/play/assets HLS），
 * 不再走 webPlayback 或网易云/QQ 载体匹配（电台没有"同款歌曲"可回退）。
 */
export function appleStationToSong(station: AppleWebItem, stream: AppleNativeStream, _storefront?: string): Song {
  const stationId = station.playId || station.id
  return {
    id: 0,
    appleId: stationId,
    name: station.name || 'Apple Music 电台',
    artists: [{ name: station.showName || 'Apple Music 电台' }],
    album: { name: '', picUrl: station.artworkUrl || '' },
    duration: 0,
    platform: 'apple',
    vip: false,
    appleRadio: { stream, stationId, isLive: Boolean(station.isLive) },
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
  const playlists = await getAppleLibraryPlaylists(100).catch(() => [])
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
  const videos = await getAppleLibraryMusicVideos(60).catch(() => [])
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
 * 编辑 room 页（web「探索更多」按风格浏览/年代之声/心情与活动/来自全球 同款）：
 * 用 groupings ids 参数取单个 room 的编辑树，复用 browse/radio 的 editorial 解析。
 */
export async function fetchAppleRoomPage(roomId: string, storefront?: string): Promise<AppleWebPage> {
  const sf = storefront || getStorefront()
  if (!roomId) return { sections: [], hero: null, personalized: false, sourceLabel: 'room 参数缺失' }
  const baseQuery = `/v1/editorial/${encodeURIComponent(sf)}/groupings`
    + '?platform=web&tabs=subscriber'
    + '&omit[resource:artists]=autos&relate[songs]=albums'
    + '&include[albums]=artists&include[songs]=artists&include[music-videos]=artists'
    + '&include[stations]=events,radio-show&extend[station-events]=editorialVideo'
    + '&fields[artists]=name,url,artwork,editorialArtwork,genreNames,plainEditorialNotes'
    + '&fields[albums]=artistName,artistUrl,artwork,contentRating,editorialArtwork,plainEditorialNotes,name,playParams,releaseDate,url,trackCount'
    + '&extend=editorialArtwork,artistUrl,plainEditorialNotes'
  // 参数变体依次尝试：ids[groupings] → ids[] → ids={id}（web 前端 bundle 各版本用键不一）
  let data: any = null
  for (const param of [`ids[groupings]=${encodeURIComponent(roomId)}`, `ids=${encodeURIComponent(roomId)}`, `ids[]=${encodeURIComponent(roomId)}`]) {
    const attempt = await gemsRequest(`${baseQuery}&${param}`)
    if (Array.isArray(attempt?.data) && attempt.data.length > 0) {
      data = attempt
      break
    }
  }
  if (!data) return { sections: [], hero: null, personalized: false, sourceLabel: 'room 取流失败' }
  const grouping = Array.isArray(data.data) ? data.data[0] : null
  const tab = pickTab(grouping)
  const sections = parseEditorialSections(tab?.relationships?.children?.data || [])
  const name = displayString(grouping?.attributes?.name) || displayString(grouping?.attributes?.title) || '探索'
  return {
    sections,
    hero: null,
    personalized: false,
    sourceLabel: `apple-api room(${name})`,
  }
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
