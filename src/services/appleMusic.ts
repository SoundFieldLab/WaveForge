/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 数据服务（歌词 / 封面 / 对唱）
 *
 * 数据链路（依据 LyricsBlossom 逆向成果）：
 * 1. iTunes Search 按歌名+艺人匹配 → Apple songId + 高清封面（无登录可用，CORS 全开）
 * 2. AMP syllable-lyrics 直连（需开发者 token + Media-User-Token，设置页可配）
 * 3. AMLL 社区库 am-lyrics/{songId}.ttml（Apple 原版 TTML，免 token）
 *
 * 对唱（ttm:agent）：Apple TTML 的 <p> 带 ttm:agent="v1/v2"，head 有
 * <ttm:agent type="person|other" xml:id="..."/> 声明；渲染端按演唱者着色。
 */
import type { LyricLine } from './musicApi'
import { parseTTML, type TTMLAgent } from '../utils/ttmlParser'
import { getAppleAuthState } from './appleAuth'
import { appleApiRequest } from './appleApiBridge'

// ─────────────────────────── 设置 ───────────────────────────

export interface AppleMusicSettings {
  /** 总开关 */
  enabled: boolean
  /** AMP API 开发者 token（音乐 Web 播放器前端一般直接从 token 站点获取） */
  developerToken: string
  /** Media-User-Token（需 Apple Music 账号） */
  mediaUserToken: string
  /** storefront，如 cn / us / hk / tw */
  storefront: string
  /** 歌词语言：zh-hans-cn / zh-hant-tw / zh-hant-hk / en-us / en-gb */
  lyricLang: string
  /** 命中 Apple 曲目时优先使用 Apple 高清封面 */
  preferAppleCover: boolean
  /** 对唱歌词按演唱者着色 */
  duetColors: boolean
}

const DEFAULT_SETTINGS: AppleMusicSettings = {
  // 默认禁用 AM 歌词：未登录/未主动开启时不请求 Apple 官方接口，也不替换平台歌词
  enabled: false,
  developerToken: '',
  mediaUserToken: '',
  storefront: 'cn',
  lyricLang: 'zh-hans-cn',
  preferAppleCover: true,
  duetColors: true,
}

export function getAppleMusicSettings(): AppleMusicSettings {
  const read = (key: string) => localStorage.getItem(key)
  const enabled = read('appleMusicEnabled')
  return {
    enabled: enabled === null ? DEFAULT_SETTINGS.enabled : enabled !== 'false',
    developerToken: read('appleDeveloperToken') || '',
    mediaUserToken: read('appleMediaUserToken') || '',
    storefront: read('appleStorefront') || DEFAULT_SETTINGS.storefront,
    lyricLang: read('appleLyricLang') || DEFAULT_SETTINGS.lyricLang,
    preferAppleCover: read('applePreferCover') !== 'false',
    duetColors: read('appleDuetColors') !== 'false',
  }
}

// ─────────────────────────── iTunes Search ───────────────────────────

export interface AppleTrackMatch {
  songId: string
  trackName: string
  artistName: string
  albumName?: string
  /** 高清封面（600×600） */
  artworkUrl?: string
  durationMs?: number
  /** 曲目所在商店，用于 AMP 请求 */
  storefront: string
}

const normalizeTitle = (value: string) =>
  (value || '')
    .toLowerCase()
    .replace(/[\s·•\-–—()（）[\]【】「」『』〈〉《》"'`、，。！？!?,.&/\\|]+/g, '')

/**
 * artworkUrl100 → 高清（正则 \d+x\d+bb 替换，与逆向文档一致）。
 *
 * amp-api / editorial 的封面 URL 有多种尺寸占位格式，必须全部归一化，否则
 * 带占位符的 URL 直接 404（探索页封面裂图的根因）：
 * - source/{w}x{h}bb.jpg                    标准占位
 * - xxx.png/{w}x{h}SC.DN01.jpg?l=zh-Hans    本地化编辑图
 * - xxx.png/{w}x{h}sr.jpg                   电台方图
 * - xxx.png/{w}x{h}cc.jpg                   裁切图
 * - xxx.png/{w}x{h}SC.FPSL02.{f}?l=zh-Hans  带文件扩展名占位 {f}
 */
export function toHighResArtwork(url: string, size = 600): string {
  if (!url) return url
  return url
    .replace(/\d+x\d+bb/g, `${size}x${size}bb`)
    .replace(/\{w\}/g, String(size))
    .replace(/\{h\}/g, String(size))
    .replace(/\{f\}/g, 'jpg')
}

/** 设置 storefront → iTunes country 参数（大写 ISO） */
const STOREFRONT_TO_COUNTRY: Record<string, string> = {
  cn: 'CN', us: 'US', hk: 'HK', tw: 'TW', jp: 'JP', kr: 'KR', gb: 'GB',
}

/** iTunes country（CHN/TWN/HKG/USA…）→ AMP storefront（cn/tw/hk/us…） */
const COUNTRY_TO_STOREFRONT: Record<string, string> = {
  chn: 'cn', twn: 'tw', hkg: 'hk', usa: 'us', jpn: 'jp', kor: 'kr', gbr: 'gb',
}

async function searchAppleTracksInCountry(
  title: string,
  artist: string,
  country: string,
  limit = 8,
): Promise<AppleTrackMatch[]> {
  const term = `${artist} ${title}`.trim()
  if (!term) return []
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=song&limit=${limit}&country=${country}`
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return []
    const data = await response.json()
    const results = Array.isArray(data?.results) ? data.results : []
    return results
      .filter((item: any) => item && item.wrapperType === 'track' && item.trackId)
      .map((item: any): AppleTrackMatch => {
        const itemCountry = String(item.country || '').toLowerCase()
        return {
          songId: String(item.trackId),
          trackName: item.trackName || '',
          artistName: item.artistName || '',
          albumName: item.collectionName || undefined,
          artworkUrl: toHighResArtwork(item.artworkUrl100 || ''),
          durationMs: item.trackTimeMillis || undefined,
          storefront: COUNTRY_TO_STOREFRONT[itemCountry] || STOREFRONT_TO_COUNTRY[country]?.toLowerCase() || 'cn',
        }
      })
  } catch (error) {
    console.warn(`[AppleMusic] iTunes Search(${country}) 失败:`, error)
    return []
  } finally {
    window.clearTimeout(timeout)
  }
}

/**
 * 跨商店搜索（配置的 storefront 优先，CN/US/TW/HK 兜底——中文歌曲在美区会返回英文名，
 * 必须按商店并行搜索再统一评分）。按 songId 去重合并。
 */
export async function searchAppleTracks(
  title: string,
  artist: string,
  _durationMs?: number,
  limit = 8,
  storefront?: string,
): Promise<AppleTrackMatch[]> {
  const settings = getAppleMusicSettings()
  const configured = STOREFRONT_TO_COUNTRY[(storefront || settings.storefront).toLowerCase()]
  const ordered = [...new Set([configured, 'CN', 'US', 'TW', 'HK', 'JP'].filter(Boolean))] as string[]

  const settled = await Promise.allSettled(
    ordered.map(country => searchAppleTracksInCountry(title, artist, country, limit)),
  )
  const merged = new Map<string, AppleTrackMatch>()
  settled.forEach(result => {
    if (result.status !== 'fulfilled') return
    result.value.forEach(track => {
      if (!merged.has(track.songId)) merged.set(track.songId, track)
    })
  })
  return [...merged.values()]
}

/**
 * 按歌名+艺人（+时长容差）评分匹配最佳 Apple 曲目。
 * 要求标题至少部分命中，否则返回 null。
 */
export async function matchAppleTrack(
  title: string,
  artist: string,
  durationMs?: number,
): Promise<AppleTrackMatch | null> {
  if (!title || !artist) return null
  const tracks = await searchAppleTracks(title, artist, durationMs)
  const normTitle = normalizeTitle(title)
  const normArtist = normalizeTitle(artist)

  let best: AppleTrackMatch | null = null
  let bestScore = 0
  tracks.forEach(track => {
    const trackTitle = normalizeTitle(track.trackName)
    const trackArtist = normalizeTitle(track.artistName)
    let score = 0
    if (normTitle && trackTitle === normTitle) score += 100
    else if (normTitle && (trackTitle.includes(normTitle) || normTitle.includes(trackTitle))) score += 60
    if (normArtist && trackArtist === normArtist) score += 40
    else if (normArtist && (trackArtist.includes(normArtist) || normArtist.includes(trackArtist))) score += 20
    if (durationMs && track.durationMs && Math.abs(track.durationMs - durationMs) < 2500) score += 15
    if (score > bestScore) {
      bestScore = score
      best = track
    }
  })
  // 标题未命中（<60）视为不匹配
  if (!best || bestScore < 60) return null
  return best
}

// ─────────────────────────── AMP syllable-lyrics 直连 ───────────────────────────

const LANG_MAP: Record<string, { lyrics: string; script?: string; accept: string }> = {
  'zh-hans-cn': { lyrics: 'zh-hans-cn', script: 'zh-Hans', accept: 'zh-CN,zh-Hans;q=0.9' },
  'zh-hant-tw': { lyrics: 'zh-hant-tw', script: 'zh-Hant', accept: 'zh-TW,zh-Hant;q=0.9' },
  'zh-hant-hk': { lyrics: 'zh-hant-hk', script: 'zh-Hant', accept: 'zh-HK,zh-Hant;q=0.9' },
  'en-us': { lyrics: 'en-us', accept: 'en-US,en;q=0.9' },
  'en-gb': { lyrics: 'en-gb', accept: 'en-GB,en;q=0.9' },
}

export interface AppleTtmlBundle {
  primary: string
  localizations: string[]
}

function normalizeLocaleCode(value: string): string {
  return value.toLowerCase().replace(/_/g, '-')
}

export function collectAppleTtml(attributes: any, settings: AppleMusicSettings): AppleTtmlBundle | null {
  const localizations = attributes?.ttmlLocalizations && typeof attributes.ttmlLocalizations === 'object'
    ? attributes.ttmlLocalizations as Record<string, unknown>
    : {}
  const requested = normalizeLocaleCode(settings.lyricLang)
  const requestedScript = requested.includes('hant') ? 'zh-hant' : requested.includes('hans') ? 'zh-hans' : requested.split('-').slice(0, 2).join('-')
  const entries = Object.entries(localizations)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()))
    .sort(([left], [right]) => {
      const rank = (code: string) => {
        const normalized = normalizeLocaleCode(code)
        if (normalized === requested) return 0
        if (normalized.startsWith(requestedScript)) return 1
        if (normalized.startsWith('zh-hans')) return 2
        if (normalized.startsWith('zh-hant')) return 3
        if (normalized.startsWith('en')) return 4
        return 5
      }
      return rank(left) - rank(right)
    })
  const values = entries.map(([, value]) => value)
  if (typeof attributes?.ttml === 'string' && attributes.ttml.trim()) values.push(attributes.ttml)
  const unique = values.filter((value, index) => values.indexOf(value) === index)
  if (unique.length === 0) return null

  let primary = unique[0]
  let bestPrimaryLines = -1
  for (const value of unique) {
    try {
      const primaryLines = parseTTML(value).lines.filter(line => line.words.length > 0).length
      if (primaryLines > bestPrimaryLines) {
        primary = value
        bestPrimaryLines = primaryLines
      }
    } catch { /* malformed candidate ignored */ }
  }
  return { primary, localizations: unique.filter(value => value !== primary) }
}

export function mergeAppleTtmlBundle(bundle: AppleTtmlBundle): string {
  if (bundle.localizations.length === 0) return bundle.primary
  const primaryDoc = new DOMParser().parseFromString(bundle.primary, 'text/xml')
  const primaryParagraphs = Array.from(primaryDoc.getElementsByTagNameNS('*', 'p'))
    .filter(element => !['x-translation', 'x-roman'].includes(
      element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || element.getAttribute('ttm:role') || '',
    ))
  const keyOf = (element: Element) => {
    const begin = element.getAttribute('begin') || ''
    const end = element.getAttribute('end') || ''
    const agent = element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'agent') || element.getAttribute('ttm:agent') || ''
    return `${begin}|${end}|${agent}`
  }
  const byKey = new Map(primaryParagraphs.map(element => [keyOf(element), element]))
  for (const localization of bundle.localizations) {
    try {
      const doc = new DOMParser().parseFromString(localization, 'text/xml')
      for (const paragraph of Array.from(doc.getElementsByTagNameNS('*', 'p'))) {
        const role = paragraph.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || paragraph.getAttribute('ttm:role') || ''
        const target = byKey.get(keyOf(paragraph))
        if (!target) continue
        const appendAlternate = (source: Element, alternateRole: string) => {
          const wrapper = primaryDoc.createElementNS(target.namespaceURI, 'span')
          wrapper.setAttributeNS('http://www.w3.org/ns/ttml#metadata', 'ttm:role', alternateRole)
          const lang = source.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang') || source.getAttribute('xml:lang')
          if (lang) wrapper.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', lang)
          const imported = primaryDoc.importNode(source, true)
          while (imported.firstChild) wrapper.appendChild(imported.firstChild)
          const text = wrapper.textContent?.trim()
          const duplicate = Array.from(target.children).some(child => {
            const childRole = child.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || child.getAttribute('ttm:role') || ''
            return childRole === alternateRole && child.textContent?.trim() === text
          })
          if (!duplicate) target.appendChild(wrapper)
        }
        if (role === 'x-translation' || role === 'x-roman') {
          appendAlternate(paragraph, role)
          continue
        }
        for (const child of Array.from(paragraph.children)) {
          const childRole = child.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || child.getAttribute('ttm:role') || ''
          if (childRole === 'x-translation' || childRole === 'x-roman') appendAlternate(child, childRole)
        }
      }
    } catch { /* malformed localization ignored */ }
  }
  return new XMLSerializer().serializeToString(primaryDoc)
}

export async function fetchAppleSyllableLyricsDirect(
  match: AppleTrackMatch,
  settings: AppleMusicSettings = getAppleMusicSettings(),
): Promise<AppleTtmlBundle | null> {
  const storefront = settings.storefront || match.storefront || 'cn'
  const params = new URLSearchParams()
  const lang = LANG_MAP[settings.lyricLang] || LANG_MAP['zh-hans-cn']
  params.set('l[lyrics]', lang.lyrics)
  if (lang.script) params.set('l[script]', lang.script)
  params.set('extend', 'ttmlLocalizations')

  // 走主进程代理（浏览器直连 amp-api 会被 CORS 拦截，与登录/资料库同理）
  const path = `/v1/catalog/${encodeURIComponent(storefront)}/songs/${encodeURIComponent(match.songId)}/syllable-lyrics?${params.toString()}`
  const result = await appleApiRequest(path, {
    developerToken: settings.developerToken,
    mediaUserToken: settings.mediaUserToken,
    timeoutMs: 6000,
  })
  if (!result.ok) {
    if (result.status === 401 || result.status === 403) {
      console.warn('[AppleMusic] AMP 401/403：token 无效或未授权，回退社区库')
    } else if (result.status === 0) {
      console.warn('[AppleMusic] AMP 网络错误，回退社区库:', result.error)
    } else {
      console.warn(`[AppleMusic] AMP HTTP ${result.status}`)
    }
    return null
  }
  const attributes = result.data?.data?.[0]?.attributes
  if (!attributes) return null
  return collectAppleTtml(attributes, settings)
}

// ─────────────────────────── AMLL am-lyrics 社区库（免 token） ───────────────────────────

export async function fetchAmLyricsTtml(songId: string): Promise<string | null> {
  const endpoints = [
    `https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/am-lyrics/${encodeURIComponent(songId)}.ttml`,
    `https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main/am-lyrics/${encodeURIComponent(songId)}.ttml`,
    `https://amll-ttml-db.stevexmh.net/am/${encodeURIComponent(songId)}`,
  ]
  for (const url of endpoints) {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 5000)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) continue
      const text = await response.text()
      if (text && text.trim().length > 3 && text.includes('<tt')) return text
    } catch {
      // 继续尝试下一个镜像
    } finally {
      window.clearTimeout(timeout)
    }
  }
  return null
}

// ─────────────────────────── TTML → LyricLine（含对唱） ───────────────────────────

export interface AppleLyricsResult {
  lyrics: LyricLine[]
  hasDuet: boolean
  agents: TTMLAgent[]
}

/**
 * 把 Apple Music / AMLL TTML 转成 WaveForge 时间轴。
 * - 行时间 = TTML 时间 − leadingSilence（前导静音整体平移）
 * - 词时间保持行内相对（毫秒）
 * - 对唱：line.agent = ttm:agent id，line.agentName 由艺人列表按声明顺序映射
 */
export function convertAppleTTMLToLyrics(
  ttmlText: string,
  artistNames?: string[],
): AppleLyricsResult {
  const parsed = parseTTML(ttmlText)
  const silenceMs = parsed.leadingSilenceMs ?? 0
  const agents = parsed.agents ?? []

  const agentNameOf = (id: string): string | undefined => {
    if (!artistNames || artistNames.length === 0) return undefined
    const index = agents.findIndex(agent => agent.id === id)
    if (index < 0) return undefined
    return artistNames[Math.min(index, artistNames.length - 1)]
  }

  const lyrics: LyricLine[] = parsed.lines
    .map(line => {
      const words = line.words.map(word => ({
        word: word.text,
        startTime: Math.max(0, word.startTime - line.startTime),
        duration: Math.max(0, word.endTime - word.startTime),
      }))
      const text = words.map(word => word.word).join('').trim()
      const lineTime = Math.max(0, line.startTime - silenceMs) / 1000
      const alternateTexts = line.alternateTexts?.map(alternate => ({
        role: alternate.role,
        type: alternate.type,
        language: alternate.language,
        lang: alternate.lang,
        text: alternate.text,
        agent: alternate.agent,
        time: Math.max(0, alternate.startTime - silenceMs) / 1000,
        endTime: Math.max(0, alternate.endTime - silenceMs) / 1000,
        words: alternate.words?.map(word => ({
          word: word.text,
          startTime: Math.max(0, word.startTime - alternate.startTime),
          duration: Math.max(0, word.endTime - word.startTime),
        })),
      }))
      const backgroundVocals = line.backgroundVocals?.map(vocal => ({
        time: Math.max(0, vocal.startTime - silenceMs) / 1000,
        endTime: Math.max(0, vocal.endTime - silenceMs) / 1000,
        text: vocal.text,
        words: vocal.words.map(word => ({
          word: word.text,
          startTime: Math.max(0, word.startTime - vocal.startTime),
          duration: Math.max(0, word.endTime - word.startTime),
        })),
        translation: vocal.translation,
        roman: vocal.roman || vocal.romanization,
        romanization: vocal.romanization || vocal.roman,
        agent: vocal.agent,
        agentId: vocal.agentId || vocal.agent,
        agentName: vocal.agent ? agentNameOf(vocal.agent) : undefined,
        alternateTexts: vocal.alternateTexts?.map(alternate => ({
          role: alternate.role,
          type: alternate.type,
          language: alternate.language,
          lang: alternate.lang,
          text: alternate.text,
          agent: alternate.agent,
        })),
      }))
      return {
        time: lineTime,
        endTime: Math.max(0, line.endTime - silenceMs) / 1000,
        text,
        words: words.length > 0 ? words : undefined,
        translation: line.translation?.trim() || undefined,
        roman: line.roman?.trim() || undefined,
        role: line.role,
        agent: line.agent || undefined,
        agentName: line.agent ? agentNameOf(line.agent) : undefined,
        alternateTexts: alternateTexts?.length ? alternateTexts : undefined,
        backgroundVocals: backgroundVocals?.length ? backgroundVocals : undefined,
      }
    })
    .filter(line => line.text)
    .sort((a, b) => a.time - b.time)

  const hasDuet = agents.length >= 2 && lyrics.some(line => line.agent)
  return { lyrics, hasDuet, agents }
}

// ─────────────────────────── 曲目匹配缓存 ───────────────────────────

const appleMatchCache = new Map<string, AppleTrackMatch | null>()
const matchCacheKey = (title: string, artist: string) => `${normalizeTitle(title)}|${normalizeTitle(artist)}`

export function getCachedAppleMatch(title: string, artist: string): AppleTrackMatch | null | undefined {
  return appleMatchCache.get(matchCacheKey(title, artist))
}

/** 带缓存的曲目匹配（歌词与封面共用，避免重复请求 iTunes） */
export async function resolveAppleTrack(
  title: string,
  artist: string,
  durationMs?: number,
): Promise<AppleTrackMatch | null> {
  if (!title || !artist) return null
  const key = matchCacheKey(title, artist)
  if (appleMatchCache.has(key)) return appleMatchCache.get(key) ?? null
  const match = await matchAppleTrack(title, artist, durationMs)
  appleMatchCache.set(key, match)
  return match
}

// ─────────────────────────── 歌词主入口 ───────────────────────────

/**
 * 获取 Apple Music 歌词（LyricLine[]）。
 * 优先 AMP 直连（需 token），否则走 AMLL am-lyrics 社区库（免 token）。
 */
/** 用户是否已完成 Apple Music 登录（未登录不请求 AM 歌词/特殊封面数据）。 */
export function isAppleMusicConfigured(): boolean {
  const s = getAppleAuthState()
  const settings = getAppleMusicSettings()
  return Boolean(s.loggedIn && settings.developerToken && settings.mediaUserToken)
}

export async function getAppleMusicLyrics(
  title: string,
  artist: string,
  durationMs?: number,
  options?: { songId?: string | number; storefront?: string },
): Promise<LyricLine[]> {
  const settings = getAppleMusicSettings()
  // 未登录默认关闭 AM 歌词：不请求 Apple 官方接口，也不用社区库替换平台歌词
  if (!settings.enabled || !isAppleMusicConfigured()) return []

  const directSongId = String(options?.songId || '').trim()
  const usableDirectSongId = directSongId && directSongId !== '0' && !/^(?:i|l|p|ra)\./i.test(directSongId)
  const match: AppleTrackMatch | null = usableDirectSongId
    ? {
        songId: directSongId,
        trackName: title || directSongId,
        artistName: artist || '',
        durationMs,
        storefront: options?.storefront || settings.storefront || 'cn',
      }
    : title && artist
      ? await resolveAppleTrack(title, artist, durationMs)
      : null
  if (!match) return []

  let ttml: string | null = null
  // 仅「已登录」才请求 Apple 官方接口（token 存在但未登录成功时直接走社区库）
  const loggedIn = getAppleAuthState().loggedIn
  if (loggedIn && settings.developerToken && settings.mediaUserToken) {
    const bundle = await fetchAppleSyllableLyricsDirect(match, settings)
    if (bundle) ttml = mergeAppleTtmlBundle(bundle)
  }
  if (!ttml) {
    ttml = await fetchAmLyricsTtml(match.songId)
  }
  if (!ttml) return []

  try {
    const artistNames = artist.split(/[,，&/和、]/).map(item => item.trim()).filter(Boolean)
    const { lyrics } = convertAppleTTMLToLyrics(ttml, artistNames)
    return lyrics
  } catch (error) {
    console.warn('[AppleMusic] TTML 解析失败:', error)
    return []
  }
}

/**
 * 供设置面板测试 Apple 凭证/网络使用：搜索并抓取一次 TTML，返回状态。
 */
export async function testAppleMusicLink(title: string, artist: string): Promise<{
  ok: boolean
  matched: boolean
  songId?: string
  trackName?: string
  source?: 'amp' | 'amll'
  message: string
}> {
  const settings = getAppleMusicSettings()
  const match = await resolveAppleTrack(title, artist)
  if (!match) {
    return { ok: false, matched: false, message: 'iTunes 未匹配到该歌曲' }
  }
  if (settings.developerToken && settings.mediaUserToken) {
    const ttml = await fetchAppleSyllableLyricsDirect(match, settings)
    if (ttml) {
      return {
        ok: true,
        matched: true,
        songId: match.songId,
        trackName: `${match.trackName} - ${match.artistName}`,
        source: 'amp',
        message: 'AMP 直连成功（Apple 官方源）',
      }
    }
  }
  const ttml = await fetchAmLyricsTtml(match.songId)
  if (ttml) {
    return {
      ok: true,
      matched: true,
      songId: match.songId,
      trackName: `${match.trackName} - ${match.artistName}`,
      source: 'amll',
      message: '社区库 am-lyrics 命中（免 token）',
    }
  }
  return { ok: false, matched: true, songId: match.songId, trackName: `${match.trackName} - ${match.artistName}`, message: '已匹配但社区库暂无该曲歌词' }
}

// ─────────────────────────── 对唱配色 ───────────────────────────

/** 演唱者调色板（Apple Music 风格：主唱保持高亮，副唱取不同色相） */
export const DUET_AGENT_COLORS = ['#ffffff', '#ff9f43', '#4dc9f6', '#ff6b81', '#a3e635', '#c084fc']

/**
 * 返回某演唱者（agent）的着色：
 * - 无对唱数据或主唱（第一个 agent）→ 使用默认白/主题色
 * - 其余演唱者 → 从调色板按索引取色
 */
export function getAgentTintColor(
  agentId: string | undefined,
  agentCount: number,
  dark: boolean,
  accentColor?: string,
  agentOrder?: string[],
): string | undefined {
  if (!agentId || agentCount < 2) return undefined
  const numeric = agentId.match(/(\d+)$/)?.[1]
  const index = numeric ? Math.max(0, Number(numeric) - 1) : Math.max(0, agentOrder?.indexOf(agentId) ?? 0)
  if (index === 0) return undefined
  const palette = dark
    ? DUET_AGENT_COLORS
    : ['#111114', '#e8682f', '#0f83c9', '#e0556d', '#4d7c0f', '#7c3aed']
  return palette[Math.min(index, palette.length - 1)]
}
