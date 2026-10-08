/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 汽水音乐（Soda Music / Qishui）后端模块（server/qishui-api.mjs）
 *
 * 移植自 temp/SodaMusic_Qishui_Code/qishui-api.js 的逆向实现（CommonJS → ESM），
 * 为 WaveForge 提供 /api/soda/* 全部路由：
 *  - 状态/登录态校验（luna/pc/me，抖音会话 Cookie）
 *  - PC Web 搜索（luna/pc/search/track）+ 火山引擎公开目录搜索兜底
 *  - 个性化推荐 feed（luna/pc[/feed]/song-tab，库回退）
 *  - 用户歌单/歌单详情（luna/pc/user/playlist、me/collection/mixed、playlist/detail 游标分页）
 *  - 喜欢/收藏/加歌/最近播放上报（luna/pc/me/collection/* 写接口）
 *  - 评论读取与发布（luna/pc/comments[/create]）
 *  - 播放地址解析（luna/pc/track_v2 POST→GET + url_player_info，会员分层过滤）
 *  - 歌词（beta-luna SEO 兜底 + track_v2 + 公开目录，yrc 逐字格式转 LRC）
 *
 * 安全约定（必须遵守，与 QQ cookie 单事实源一致）：
 *  - 汽水登录态 = 前端每次请求传入的抖音会话 cookie 参数（GET query 或 POST body）；
 *  - 本模块【绝不】把该 cookie 持久化：不写文件、不存全局变量作为登录态；
 *  - 仅允许按 cookie 指纹做内存 TTL 缓存（会员状态、歌单库等，见 createTtlCache）；
 *  - 所有上游网络请求一律带超时（AbortSignal.timeout），失败降级返回明确 error。
 */

import crypto from 'node:crypto'
// 加密音频解密代理：把带 #auth= 凭证的 CDN 地址包装为本地 /api/soda/audio 解密流
import { sodaWrapAudioUrl } from './qishui-audio-decryptor.mjs'

// ─────────────────────────── 常量 ───────────────────────────

/** 火山引擎公开目录（无需登录；旧 /api/qishui/* 路由同源，互不影响） */
const QISHUI_PUBLIC_SEARCH_URL = 'https://api-vehicle.volcengine.com/v2/search/type'
const QISHUI_PUBLIC_CONTENTS_URL = 'https://api-vehicle.volcengine.com/v2/custom/contents'
const QISHUI_PUBLIC_HEADERS = {
  Accept: 'application/json,text/plain,*/*',
  'User-Agent': 'WaveForge/0.1 (Qishui public catalog bridge)',
}

/** 虚拟歌单 id（前端可见的固定 id，非服务端真实歌单） */
export const SODA_VIRTUAL_FEED_PLAYLIST_ID = 'qishui-feed'
export const SODA_WEB_LIKED_PLAYLIST_ID = 'qishui-liked'
export const SODA_WEB_RECENT_PLAYLIST_ID = 'qishui-recent'

/** Web API 多基地轮询（任一失败自动切换下一个） */
const QISHUI_WEB_API_BASES = (process.env.QISHUI_WEB_API_BASES || 'https://api5-lq.qishui.com,https://api.qishui.com')
  .split(',')
  .map((item) => item.trim().replace(/\/+$/, ''))
  .filter(Boolean)
/** PC 客户端专用基地址（写操作与 track_v2 都走这里） */
const QISHUI_WEB_PC_API_BASE = (process.env.QISHUI_WEB_PC_API_BASE || 'https://api.qishui.com').replace(/\/+$/, '')

const QISHUI_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36'
const QISHUI_PC_APP_UA = 'LunaPC/3.3.0(359450208)'
/** Web API 公共参数 */
const QISHUI_WEB_DEFAULT_PARAMS = {
  aid: '386088',
  app_name: 'luna_pc',
  device_platform: 'web',
  channel: 'pc_web',
}

// ─────────────────────────── 内存 TTL 缓存（仅按 cookie 指纹等键缓存，绝不持久化登录态）───────────────────────────

function createTtlCache(maxEntries, defaultTtlMs) {
  const store = new Map()
  const inflight = new Map()
  return {
    get(key) {
      const hit = store.get(key)
      if (!hit || Date.now() - hit.at > hit.ttl) return null
      return hit.value
    },
    set(key, value, ttlMs) {
      store.set(key, { at: Date.now(), ttl: ttlMs || defaultTtlMs, value })
      if (store.size > maxEntries) {
        // Map 保持插入顺序，首个 key 即最旧条目；无需每次写入都对全表排序。
        const oldestKey = store.keys().next().value
        if (oldestKey !== undefined) store.delete(oldestKey)
      }
    },
    clear() {
      store.clear()
      inflight.clear()
    },
    /** 并发去重 + TTL 缓存包装；ttlMs 可为函数（根据结果动态决定） */
    async wrap(key, ttlMs, fn) {
      const cached = this.get(key)
      if (cached !== null) return cached
      if (inflight.has(key)) return inflight.get(key)
      const promise = Promise.resolve()
        .then(fn)
        .then((value) => {
          const resolvedTtlMs = typeof ttlMs === 'function' ? ttlMs(value) : ttlMs
          this.set(key, value, resolvedTtlMs)
          return value
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, promise)
      return promise
    },
  }
}

const sodaSearchCache = createTtlCache(80, 2 * 60 * 1000)
const sodaLyricCache = createTtlCache(240, 30 * 60 * 1000)
const sodaPublicDetailCache = createTtlCache(240, 30 * 60 * 1000)
/** 歌词「确认无词」负缓存（纯音乐/翻唱常见）：三级兜底全空后短周期记忆，避免同一首反复打满三级拖慢切歌；键带登录指纹，登录态解锁 track_v2 新数据源时不互相污染 */
const sodaLyricMissCache = createTtlCache(120, 10 * 60 * 1000)
const sodaFeedCache = createTtlCache(16, 90 * 1000)
const sodaWebLibraryCache = createTtlCache(24, 90 * 1000)
const sodaWebPlaylistCache = createTtlCache(48, 90 * 1000)
/** 歌单游标状态缓存：fp|pid -> { rawItems, cursor, hasMore, ... }（跨页续传） */
const sodaWebPlaylistCursorCache = new Map()
const sodaMembershipCache = createTtlCache(24, 60 * 1000)
/** 会员正向观察历史：网络抖动时短暂保留最近的正向会员结论，避免误判降级 */
const sodaMembershipPositiveHistory = new Map()
const SODA_MEMBERSHIP_POSITIVE_CACHE_MS = 10 * 1000
const SODA_MEMBERSHIP_POSITIVE_GRACE_MS = 20 * 1000
const sodaTrackMetadataCache = createTtlCache(120, 20 * 1000)
const sodaPlaybackCache = createTtlCache(120, 4 * 60 * 1000)
/** track_v2 失败负缓存：fp|id -> { at, message, code, postError }（短 TTL 记住「无效 JSON」等确定性失败，
 * 避免同曲快速连续重打上游触发更严风控）；成功结果仍走 sodaTrackMetadataCache 正缓存，互不影响 */
const sodaTrackV2ErrorCache = new Map()
const SODA_TRACK_V2_ERROR_TTL_MS = 45 * 1000
const SODA_TRACK_V2_ERROR_CACHE_LIMIT = 256
const sodaChartCache = createTtlCache(16, 10 * 60 * 1000)
/** 搜索派生端点（联想/歌手/专辑）缓存：短 TTL + createTtlCache.wrap 自带同 key 并发去重（同一关键词并发只打一次上游） */
const sodaSuggestCache = createTtlCache(120, 2 * 60 * 1000)
const sodaSearchArtistsCache = createTtlCache(80, 2 * 60 * 1000)
const sodaSearchAlbumsCache = createTtlCache(80, 2 * 60 * 1000)
/**
 * 听歌模式数据缓存（场景列表 / 发现块）。
 * 客户端是「每天 5 点后首次进入才刷新」，服务端这边用 10 分钟 TTL + 同 key 并发去重即可，
 * 没必要把「5 点」这套客户端缓存策略也搬过来。
 */
const sodaSceneCache = createTtlCache(24, 10 * 60 * 1000)

/**
 * 听歌模式的「当天桶」键：客户端 SceneMode 是**每天 5 点后的首次访问才刷新**
 * （src/renderer/compositions/sceneMode.ts 的 isFirstVisitAfterFive + LAST_TIME_TO_REFRESH_SCENE_MODE_PAGE），
 * 并把该时间戳嵌进每个请求 key。
 * 我们原来用 10 分钟 TTL：服务端这 45 个场景的顺序会周期性重排，于是我们的「常用模式」
 * 每隔几分钟换一批，看起来就和 PC 客户端对不上——而客户端其实一整天都钉在同一个顺序上。
 * 这里复刻同款「当天桶」，让两边在同一时间粒度上稳定。
 */
function sodaSceneDayBucket(nowMs) {
  const d = new Date(nowMs || Date.now())
  // 凌晨 5 点前算「前一天」（客户端 fiveAM 比较的同一口径）
  if (d.getHours() < 5) d.setDate(d.getDate() - 1)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

/** 写操作成功后失效账号库相关缓存（喜欢/收藏/加歌/上报后立即生效） */
function invalidateSodaLibraryCaches() {
  sodaWebLibraryCache.clear()
  sodaWebPlaylistCache.clear()
  sodaWebPlaylistCursorCache.clear()
}

// ─────────────────────────── 基础请求封装（一律带超时）───────────────────────────

async function requestText(targetUrl, opts = {}, body) {
  const timeoutMs = Number(opts.timeoutMs) || 8000
  try {
    const resp = await fetch(targetUrl, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: body == null ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await resp.text()
    if (resp.status >= 400) {
      const err = new Error('HTTP ' + resp.status)
      err.statusCode = resp.status
      err.body = text
      throw err
    }
    return text
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      const wrapped = new Error('请求超时（' + timeoutMs + 'ms）')
      wrapped.cause = err
      throw wrapped
    }
    throw err
  }
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body)
  try {
    return JSON.parse(text)
  } catch (cause) {
    // 活体探测实锤（2026-08-26）：track_v2 等上游对无效会话返回 HTTP 200 +
    // application/json + 空 body，正是「无效 JSON」判定的直接来源。
    // 识别空体为独立错误（空体=上游拒绝会话的形态，重试/换参同样无效），
    // 供 song/url 侧归因出准确 reason，与「有 body 但解析失败」区分开。
    if (text.trim() === '') {
      const err = new Error('汽水音乐接口返回了空响应（会话可能已失效）')
      err.code = 'SODA_EMPTY_BODY'
      err.body = ''
      err.emptyBody = true
      throw err
    }
    const err = new Error('汽水音乐接口返回了无效 JSON')
    err.cause = cause
    err.body = text
    throw err
  }
}

function urlWithParams(baseUrl, params) {
  const u = new URL(baseUrl)
  Object.keys(params || {}).forEach((key) => {
    const value = params[key]
    if (value == null || value === '') return
    u.searchParams.set(key, String(value))
  })
  return u.toString()
}

function qishuiPcUrl(apiPath, params) {
  const target = /^https?:\/\//i.test(apiPath) ? apiPath : QISHUI_WEB_PC_API_BASE + apiPath
  return urlWithParams(target, params || {})
}

// ─────────────────────────── Cookie 工具（按请求传递，绝不落盘）───────────────────────────

const SODA_COOKIE_ATTRIBUTE_NAMES = new Set(['path', 'domain', 'expires', 'max-age', 'samesite', 'secure', 'httponly'])

function collectSodaCookiePair(picked, key, value) {
  key = String(key || '').trim()
  if (!key || SODA_COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return
  if (value === null || value === undefined) return
  picked.set(key, String(value).trim())
}

function collectSodaCookieInput(input, picked) {
  if (input === null || input === undefined) return
  if (Array.isArray(input)) {
    input.forEach((item) => collectSodaCookieInput(item, picked))
    return
  }
  if (typeof input === 'object') {
    // 支持 puppeteer 式 { name, value } 与普通对象两种形态
    if (input.name && Object.prototype.hasOwnProperty.call(input, 'value')) {
      collectSodaCookiePair(picked, input.name, input.value)
      return
    }
    Object.keys(input).forEach((key) => {
      const value = input[key]
      if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'value')) {
        collectSodaCookiePair(picked, key, value.value)
      } else if (typeof value !== 'object') {
        collectSodaCookiePair(picked, key, value)
      }
    })
    return
  }
  // 字符串：兼容换行分隔与分号分隔
  String(input).split(/\r?\n/).forEach((line) => {
    line.split(';').forEach((part) => {
      const raw = String(part || '').trim()
      const idx = raw.indexOf('=')
      if (idx <= 0) return
      collectSodaCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1))
    })
  })
}

/** 把任意输入（字符串/对象/数组）规范化为 "k=v; k=v" 的 Cookie 头 */
function normalizeSodaCookieInput(input) {
  const picked = new Map()
  collectSodaCookieInput(input, picked)
  return Array.from(picked.entries())
    .filter(([key, value]) => key && value != null && String(value) !== '')
    .map(([key, value]) => key + '=' + value)
    .join('; ')
}

function sodaCookieObject(cookieText) {
  const out = {}
  String(cookieText || '').split(';').forEach((part) => {
    const idx = part.indexOf('=')
    if (idx <= 0) return
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  })
  return out
}

/** 是否携带抖音会话登录标记（sessionid/sid_guard 等） */
function sodaCookieHasLogin(cookieText) {
  return /(?:^|;\s*)(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=/i.test(String(cookieText || ''))
}

/** cookie 指纹：仅用于内存缓存的 key（sha1 前 16 位），不含任何持久化 */
function sodaCookieFingerprint(cookieText) {
  return crypto.createHash('sha1').update(normalizeSodaCookieInput(cookieText)).digest('hex').slice(0, 16)
}

function sodaCookieUserId(cookieText) {
  const obj = sodaCookieObject(cookieText)
  const raw = String(obj.uid_tt || obj.uid_tt_ss || obj.sessionid || obj.sessionid_ss || obj.sid_guard || '').trim()
  if (!raw) return ''
  return 'web:' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12)
}

/** 只保留会话关键 cookie，减小请求头体积 */
function sodaSessionCookieHeader(cookieText) {
  const normalized = normalizeSodaCookieInput(cookieText)
  const obj = sodaCookieObject(normalized)
  if (sodaCookieHasLogin(normalized)) return normalized
  const sessionid = obj.sessionid || obj.sessionid_ss || ''
  return sessionid ? 'sessionid=' + sessionid + ';' : normalized
}

function sodaHeadersWithCookie(headers, cookieText) {
  const out = Object.assign({}, headers || {})
  const cookie = normalizeSodaCookieInput(cookieText)
  if (cookie) out.Cookie = cookie
  return out
}

// ─────────────────────────── 通用字段提取工具 ───────────────────────────

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
}

function normalizeLyricBody(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
}

function pickObject() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i]
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return {}
}

function pickArray() {
  for (let i = 0; i < arguments.length; i++) {
    const value = arguments[i]
    if (Array.isArray(value)) return value
  }
  return []
}

function qishuiObjectString(obj, keys) {
  obj = obj && typeof obj === 'object' ? obj : {}
  for (const key of keys || []) {
    const value = obj[key]
    if (value === null || value === undefined) continue
    if (Array.isArray(value)) {
      const text = value.map((item) => normalizeText(item)).find(Boolean)
      if (text) return text
      continue
    }
    if (typeof value !== 'object') {
      const text = normalizeText(value)
      if (text) return text
    }
  }
  return ''
}

function qishuiObjectNumber(obj, keys) {
  const num = Number(qishuiObjectString(obj, keys))
  return Number.isFinite(num) ? num : 0
}

function firstUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || ''
  if (typeof value === 'object') {
    return firstUrl(value.url_list || value.urls || value.url || value.uri || value.main_url || value.cover_url || value.download_url)
  }
  return ''
}

function qishuiImageUrl(value, suffix) {
  if (!value) return ''
  if (typeof value === 'string') {
    const text = normalizeText(value)
    if (!/^https?:\/\//i.test(text)) return ''
    return suffix && !text.includes('~') ? text + suffix : text
  }
  if (Array.isArray(value)) return value.map((item) => qishuiImageUrl(item, suffix)).find(Boolean) || ''
  if (typeof value !== 'object') return ''
  const cover = normalizeText(
    firstUrl(value.urls || value.url_list || value.urlList || value.url || value.main_url || value.cover_url || value.image_url || ''),
  )
  const uri = normalizeText(value.uri || value.url_key || value.image_uri || value.cover_uri || '')
  let out = cover
  if (out && uri && !out.includes(uri)) out += uri
  if (!out && /^https?:\/\//i.test(uri)) out = uri
  if (!/^https?:\/\//i.test(out)) return ''
  return suffix && !out.includes('~') ? out + suffix : out
}

function qishuiFirstImageUrl(suffix) {
  for (let i = 1; i < arguments.length; i++) {
    const url = qishuiImageUrl(arguments[i], suffix)
    if (url) return url
  }
  return ''
}

/** 上游偶尔把 JSON 塞进字符串里（甚至多层转义），尽力解开 */
function sodaMaybeParseJson(value) {
  let text = typeof value === 'string' ? value.trim() : ''
  if (!text) return value
  for (let i = 0; i < 3 && text.charAt(0) === '"'; i++) {
    try {
      text = JSON.parse(text)
    } catch {
      break
    }
    if (typeof text !== 'string') return text
    text = text.trim()
  }
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

// ─────────────────────────── 歌词：逐字 YRC → LRC 转换与缓存 ───────────────────────────

function sodaLyricTimestamp(ms) {
  ms = Math.max(0, Number(ms) || 0)
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.floor((ms % 60000) / 1000)
  const centiseconds = Math.floor((ms % 1000) / 10)
  return (
    '[' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(seconds).padStart(2, '0') +
    '.' +
    String(centiseconds).padStart(2, '0') +
    ']'
  )
}

/** 把汽水 "[start,dur]<start,dur,0>词" 逐字格式转换为标准 LRC（同时保留 yrc 原文备用） */
function sodaConvertLyric(value) {
  const input = normalizeLyricBody(value)
  if (!input) return { lyric: '', yrc: '' }
  const lrcLines = []
  const yrcLines = []
  let converted = false
  input.split('\n').forEach((rawLine) => {
    const line = String(rawLine || '').trim()
    const timed = line.match(/^\[(\d+),(\d+)\](.*)$/)
    if (!timed) return
    const lineStart = Math.max(0, Number(timed[1]) || 0)
    const lineDuration = Math.max(0, Number(timed[2]) || 0)
    const body = timed[3] || ''
    const wordPattern = /([<\(])(\d+),(\d+),(\d+)[>\)]([^<\(]*)/g
    let wordMatch
    let text = ''
    let yrcBody = ''
    while ((wordMatch = wordPattern.exec(body))) {
      const rawStart = Math.max(0, Number(wordMatch[2]) || 0)
      const wordDuration = Math.max(0, Number(wordMatch[3]) || 0)
      const wordText = String(wordMatch[5] || '')
      if (!wordText) continue
      // <相对行内偏移；(绝对毫秒（兼容两种上游写法）
      const absoluteStart =
        wordMatch[1] === '<'
          ? lineStart + rawStart
          : rawStart >= Math.max(0, lineStart - 500)
            ? rawStart
            : lineStart + rawStart
      text += wordText
      yrcBody += '(' + absoluteStart + ',' + wordDuration + ',' + (Number(wordMatch[4]) || 0) + ')' + wordText
    }
    if (!text) text = body.replace(/[<\(]\d+,\d+,\d+[>\)]/g, '')
    text = text.replace(/\s+/g, ' ').trim()
    if (!text) return
    converted = true
    lrcLines.push(sodaLyricTimestamp(lineStart) + text)
    yrcLines.push('[' + lineStart + ',' + lineDuration + ']' + (yrcBody || text))
  })
  if (!converted) return { lyric: input, yrc: '' }
  return { lyric: lrcLines.join('\n'), yrc: yrcLines.join('\n') }
}

/**
 * 汽水上游 yrc 逐字文本 → 结构化时间轴（独立导出：/api/soda/lyric 的 words 字段与单测共用）。
 * 注意：这是汽水自己的 wire 格式（与 sodaConvertLyric 同源），不是网易 yrc 语义：
 *   行头 `[行起点ms,行长ms]`，其后每字为 `<相对偏移ms,时长ms,0>字文` 或 `(绝对起点ms,时长ms,0)字文`；
 *   `<>` 为行内相对偏移，`()` 为绝对毫秒（兼容旧样例行内偏移写法：rawStart < lineStart-500 时按相对补正），
 *   与 sodaConvertLyric 完全同一套判定规则，避免两套实现漂移。
 * 输出行 [{ start,end,text,translated?,words:[{text,start,end}] }]，时间均为绝对毫秒；
 * 非 yrc 形态（普通 LRC/纯文本）返回 []，调用方据此省略 words 字段。
 */
export function parseSodaYrcTimeline(value) {
  const input = normalizeLyricBody(value)
  if (!input) return []
  const rows = []
  input.split('\n').forEach((rawLine) => {
    const line = String(rawLine || '').trim()
    const timed = line.match(/^\[(\d+),(\d+)\](.*)$/)
    if (!timed) return
    const lineStart = Math.max(0, Number(timed[1]) || 0)
    const lineDuration = Math.max(0, Number(timed[2]) || 0)
    const body = timed[3] || ''
    const wordPattern = /([<\(])(\d+),(\d+),(\d+)[>\)]([^<\(]*)/g
    let wordMatch
    let text = ''
    let words = null
    while ((wordMatch = wordPattern.exec(body))) {
      const rawStart = Math.max(0, Number(wordMatch[2]) || 0)
      const wordDuration = Math.max(0, Number(wordMatch[3]) || 0)
      const wordText = String(wordMatch[5] || '')
      if (!wordText) continue
      // 判定规则与 sodaConvertLyric 保持一致：< 相对行内偏移；( 绝对毫秒（兼容两种上游写法）
      const absoluteStart =
        wordMatch[1] === '<'
          ? lineStart + rawStart
          : rawStart >= Math.max(0, lineStart - 500)
            ? rawStart
            : lineStart + rawStart
      text += wordText
      words = words || []
      words.push({
        text: wordText,
        start: absoluteStart,
        end: absoluteStart + wordDuration,
      })
    }
    if (!text) text = body.replace(/[<\(]\d+,\d+,\d+[>\)]/g, '')
    text = text.replace(/\s+/g, ' ').trim()
    if (!text) return
    rows.push(words ? { start: lineStart, end: lineStart + lineDuration, text, words } : { start: lineStart, end: lineStart + lineDuration, text })
  })
  return rows
}

/** 平铺 LRC（"[mm:ss.xx]文本"）→ [{start,text}] 毫秒入口；作为翻译内联的候选源 */
function extractSodaFlatLrcEntries(value) {
  const input = normalizeLyricBody(value)
  if (!input) return []
  const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
  const entries = []
  for (const raw of input.split('\n')) {
    const matches = [...String(raw).matchAll(timeRe)]
    const text = String(raw).replace(timeRe, '').trim()
    if (!matches.length || !text) continue
    for (const m of matches) {
      const min = Number(m[1] || 0)
      const sec = Number(m[2] || 0)
      const frac = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) : 0
      entries.push({ start: Math.round((min * 60 + sec + frac / 1000) * 1000), text })
    }
  }
  return entries.sort((a, b) => a.start - b.start)
}

/**
 * 组装 /api/soda/lyric 的 words 结构化字段：
 * yrc 命中时输出逐字行并把翻译按 ≤500ms 就近内联到 translated（与前端 tlyric 对齐容差一致）；
 * 非 yrc（公开目录平铺 LRC 等）返回 null，保持响应里无逐字数据。
 */
export function buildSodaWordTimeline(lyricRaw, tlyricRaw) {
  const rows = parseSodaYrcTimeline(lyricRaw)
  if (!rows.length) return null
  // 翻译候选：track_v2 的翻译可能是逐字 yrc，也可能是平铺 LRC——两种形态都能内联
  const yrcTrans = parseSodaYrcTimeline(tlyricRaw).map((row) => ({ start: row.start, text: row.text }))
  const candidates = (yrcTrans.length ? yrcTrans : extractSodaFlatLrcEntries(tlyricRaw)).sort((a, b) => a.start - b.start)
  if (candidates.length) {
    // 贪心就近对齐：仅允许向后推进指针，|时间差|≤500ms 视为同一行（规则与前端 tlyric 对齐一致）
    const TOLERANCE_MS = 500
    let pointer = 0
    for (const row of rows) {
      while (pointer < candidates.length && candidates[pointer].start < row.start - TOLERANCE_MS) {
        pointer += 1
      }
      const candidate = candidates[pointer]
      if (candidate && Math.abs(candidate.start - row.start) <= TOLERANCE_MS && !row.translated) {
        row.translated = candidate.text
        pointer += 1
      }
    }
  }
  return rows
}

/** 规范化并写入歌词内存缓存（30 分钟） */
function cacheSodaLyric(id, lyric, tlyric, source) {
  id = normalizeText(id)
  // words 结构化逐字基于未转换的原始文本解析（yrc 形态才有结果；平铺 LRC → null）
  const rawLyric = lyric
  const rawTlyric = tlyric
  const primary = sodaConvertLyric(lyric)
  const translated = sodaConvertLyric(tlyric)
  lyric = primary.lyric
  tlyric = translated.lyric
  if (!id || (!lyric && !tlyric)) return null
  const payload = {
    provider: 'qishui',
    lyric,
    tlyric,
    yrc: primary.yrc,
    ytlrc: translated.yrc,
    source: source || 'soda-cache',
    cachedAt: Date.now(),
  }
  const words = buildSodaWordTimeline(rawLyric, rawTlyric)
  if (words) payload.words = words
  sodaLyricCache.set(id, payload)
  return payload
}

function sodaLyricTextFromNode(value) {
  value = sodaMaybeParseJson(value)
  if (typeof value === 'string') {
    const text = normalizeLyricBody(value)
    // URL 形态的“歌词”（需再拉取）本模块不支持，跳过
    return /^https?:\/\//i.test(text) ? '' : text
  }
  if (!value || typeof value !== 'object') return ''
  const entity = pickObject(value.lyric_entity, value.lyricEntity, value.original_lyric, value.originalLyric, value)
  for (const key of ['content', 'lyric_text', 'lyricText', 'text', 'original_content', 'originalContent']) {
    const text = sodaLyricTextFromNode(entity[key])
    if (text) return text
  }
  if (entity !== value) return sodaLyricTextFromNode(entity)
  return ''
}

/** 在任意响应负载中递归找歌词原文与翻译（深度/节点数受限防炸栈） */
function extractSodaLyrics(payload) {
  const found = { lyric: '', tlyric: '' }
  const seen = new Set()
  let visitedNodes = 0
  function visit(node, pathText, depth) {
    if (!node || depth > 7 || visitedNodes >= 600 || (found.lyric && found.tlyric)) return
    node = sodaMaybeParseJson(node)
    if (!node || typeof node !== 'object') return
    if (seen.has(node)) return
    seen.add(node)
    visitedNodes += 1
    Object.keys(node).slice(0, 120).forEach((key) => {
      const child = node[key]
      const childPath = pathText ? pathText + '.' + key : key
      if (/lyric|lyrics|tlyric|translation/i.test(key)) {
        const text = sodaLyricTextFromNode(child)
        if (text) {
          if (/translat|tlyric|lang_translation|translated/i.test(childPath)) {
            if (!found.tlyric) found.tlyric = text
          } else if (!found.lyric) {
            found.lyric = text
          }
        }
      }
      // 大数组分支对找歌词无意义，剪枝
      if (/^(album_tracks|artist_tracks|chart_tracks|comments|prompts|recommend_media_list)$/i.test(key)) return
      visit(child, childPath, depth + 1)
    })
  }
  visit(payload, '', 0)
  return found
}

// ─────────────────────────── 会员分层（free < vip < svip）───────────────────────────

const SODA_VIP_NUMBER_KEYS = new Set([
  'viptype', 'viplevel', 'membertype', 'memberlevel', 'musicviptype', 'musicviplevel',
])
const SODA_SVIP_NUMBER_KEYS = new Set([
  'sviptype', 'sviplevel', 'superviptype', 'superviplevel',
])
const SODA_VIP_FLAG_KEYS = new Set([
  'isvip', 'ismember', 'hasvip', 'hasmembership', 'vipactive', 'vipenabled',
])
const SODA_SVIP_FLAG_KEYS = new Set([
  'issvip', 'issupervip', 'hassvip', 'hassupervip', 'svipactive', 'svipenabled',
])
const SODA_MEMBERSHIP_LABEL_KEYS = new Set([
  'viplevelname', 'vipname', 'memberlevelname', 'membername', 'membershiplevel', 'membershiptype',
])
const SODA_VIP_CONTAINER_KEYS = new Set([
  'vipinfo', 'vipdetail', 'vipbenefit', 'vippackage', 'memberinfo', 'memberdetail',
  'memberbenefit', 'memberpackage', 'membershipinfo', 'membershipdetail',
])
const SODA_SVIP_CONTAINER_KEYS = new Set([
  'svipinfo', 'svipdetail', 'svipbenefit', 'svippackage', 'supervipinfo',
  'supervipdetail', 'supervipbenefit', 'supervippackage',
])
const SODA_MEMBERSHIP_STATUS_KEYS = new Set([
  'status', 'state', 'active', 'valid', 'enabled', 'isactive', 'isvalid', 'isenabled',
])
const SODA_MEMBERSHIP_GENERIC_EXPIRY_KEYS = new Set([
  'expiretime', 'expiresat', 'expirationtime', 'expiredat', 'endtime', 'validuntil',
])
const SODA_VIP_EXPIRY_KEYS = new Set([
  'vipexpiretime', 'vipexpiresat', 'vipexpiredat', 'vipendtime',
  'memberexpiretime', 'memberexpiresat', 'memberexpiredat', 'memberendtime',
])
const SODA_SVIP_EXPIRY_KEYS = new Set([
  'svipexpiretime', 'svipexpiresat', 'svipexpiredat', 'svipendtime',
])

function sodaFieldKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')
}

function sodaExplicitPositive(value) {
  if (value === true) return true
  if (typeof value === 'number') return Number.isFinite(value) && value > 0
  const text = normalizeText(value).toLowerCase()
  if (!text) return false
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) > 0
  return /^(true|yes|active|valid|enabled|opened|vip|svip|premium|member|会员|已开通|有效)$/.test(text)
}

function sodaExplicitNegative(value) {
  if (value === false || value === null) return true
  if (typeof value === 'number') return Number.isFinite(value) && value <= 0
  const text = normalizeText(value).toLowerCase()
  if (!text) return false
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) <= 0
  return /^(false|no|inactive|invalid|disabled|closed|expired|none|free|normal|ordinary|非会员|普通用户|未开通|无vip|已过期|过期)$/.test(text)
}

function sodaMembershipLevelValue(value) {
  const text = normalizeText(value).toLowerCase().replace(/[\s_-]+/g, '')
  if (/^(svip|supervip|超级会员|超级vip|豪华会员)$/.test(text)) return 'svip'
  if (/^(vip|premium|member|会员|普通会员)$/.test(text)) return 'vip'
  if (/^(none|free|normal|ordinary|novip|非会员|普通用户|未开通|无vip|已过期|过期)$/.test(text)) return 'none'
  return ''
}

function sodaMembershipExpiryMillis(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) {
    return number < 100000000000 ? number * 1000 : number
  }
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * 判定单个对象里某档会员（vip/svip）的生效状态：
 * 层级专属到期时间优先于通用到期时间，避免 SVIP 过期字段误伤有效的 VIP。
 */
function sodaMembershipObjectState(value, level) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { known: false, active: null, expiresAt: 0 }
  }
  let known = false
  let statusPositive = false
  let statusNegative = false
  let genericExpiryKnown = false
  let genericExpiryExpired = false
  let genericFutureExpiry = 0
  let levelExpiryKnown = false
  let levelExpiryExpired = false
  let levelFutureExpiry = 0
  const levelExpiryKeys =
    level === 'svip' ? SODA_SVIP_EXPIRY_KEYS : level === 'vip' ? SODA_VIP_EXPIRY_KEYS : null
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = sodaFieldKey(key)
    const isGenericExpiry = SODA_MEMBERSHIP_GENERIC_EXPIRY_KEYS.has(normalizedKey)
    const isLevelExpiry = levelExpiryKeys
      ? levelExpiryKeys.has(normalizedKey)
      : SODA_VIP_EXPIRY_KEYS.has(normalizedKey) || SODA_SVIP_EXPIRY_KEYS.has(normalizedKey)
    if (isGenericExpiry || isLevelExpiry) {
      const expiresAt = sodaMembershipExpiryMillis(item)
      const isKnownExpiry =
        expiresAt > 0 ||
        (item !== '' && item !== null && item !== undefined && Number.isFinite(Number(item)) && Number(item) <= 0)
      if (!isKnownExpiry) continue
      known = true
      if (isLevelExpiry) {
        levelExpiryKnown = true
        if (expiresAt > Date.now()) levelFutureExpiry = Math.max(levelFutureExpiry, expiresAt)
        else levelExpiryExpired = true
      } else {
        genericExpiryKnown = true
        if (expiresAt > Date.now()) genericFutureExpiry = Math.max(genericFutureExpiry, expiresAt)
        else genericExpiryExpired = true
      }
      continue
    }
    if (!SODA_MEMBERSHIP_STATUS_KEYS.has(normalizedKey)) continue
    if (sodaExplicitNegative(item)) {
      known = true
      statusNegative = true
    } else if (sodaExplicitPositive(item)) {
      known = true
      statusPositive = true
    }
  }
  const expiryKnown = levelExpiryKnown || genericExpiryKnown
  const expiryExpired = levelExpiryKnown ? levelExpiryExpired : genericExpiryExpired
  const futureExpiry = levelExpiryKnown ? levelFutureExpiry : genericFutureExpiry
  const active =
    statusNegative || expiryExpired
      ? false
      : futureExpiry > 0 || (!expiryKnown && statusPositive)
        ? true
        : expiryKnown
          ? false
          : null
  return { known, active, expiresAt: active === true ? futureExpiry : 0 }
}

/** 深度遍历 me/track_v2 负载，聚合出当前账号的会员结论 */
function sodaMembershipFromData(value) {
  value = value && typeof value === 'object' ? value : {}
  let membershipKnown = false
  let isVip = false
  let isSvip = false
  let vipType = 0
  let svipType = 0
  let vipExpiresAt = 0
  let svipExpiresAt = 0
  let visited = 0

  const rememberExpiry = (level, expiresAt) => {
    expiresAt = Number(expiresAt) || 0
    if (expiresAt <= Date.now()) return
    if (level === 'svip') {
      if (!svipExpiresAt || expiresAt < svipExpiresAt) svipExpiresAt = expiresAt
      return
    }
    if (level === 'vip' && (!vipExpiresAt || expiresAt < vipExpiresAt)) vipExpiresAt = expiresAt
  }

  const applyLevel = (level, numericValue, active, expiresAt) => {
    if (active === false || !level) return
    if (level === 'svip') {
      isSvip = true
      isVip = true
      svipType = Math.max(svipType, Number(numericValue) || 1)
      rememberExpiry('svip', expiresAt)
      return
    }
    if (level === 'vip') {
      isVip = true
      vipType = Math.max(vipType, Number(numericValue) || 1)
      rememberExpiry('vip', expiresAt)
    }
  }

  const visit = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6 || visited > 600) return
    visited += 1
    if (Array.isArray(node)) {
      node.slice(0, 120).forEach((item) => visit(item, depth + 1))
      return
    }
    const vipObjectState = sodaMembershipObjectState(node, 'vip')
    const svipObjectState = sodaMembershipObjectState(node, 'svip')
    for (const [key, item] of Object.entries(node).slice(0, 160)) {
      const normalizedKey = sodaFieldKey(key)
      if (SODA_SVIP_NUMBER_KEYS.has(normalizedKey)) {
        membershipKnown = true
        const number = Number(item)
        if (Number.isFinite(number) && number > 0) applyLevel('svip', number, svipObjectState.active, svipObjectState.expiresAt)
      } else if (SODA_VIP_NUMBER_KEYS.has(normalizedKey)) {
        membershipKnown = true
        const number = Number(item)
        if (Number.isFinite(number) && number > 0) applyLevel('vip', number, vipObjectState.active, vipObjectState.expiresAt)
      } else if (SODA_SVIP_FLAG_KEYS.has(normalizedKey)) {
        membershipKnown = true
        if (sodaExplicitPositive(item)) applyLevel('svip', 1, svipObjectState.active, svipObjectState.expiresAt)
      } else if (SODA_VIP_FLAG_KEYS.has(normalizedKey)) {
        membershipKnown = true
        if (sodaExplicitPositive(item)) applyLevel('vip', 1, vipObjectState.active, vipObjectState.expiresAt)
      } else if (SODA_MEMBERSHIP_LABEL_KEYS.has(normalizedKey)) {
        membershipKnown = true
        const level = sodaMembershipLevelValue(item)
        const state = level === 'svip' ? svipObjectState : vipObjectState
        applyLevel(level, 1, state.active, state.expiresAt)
      } else if (SODA_SVIP_CONTAINER_KEYS.has(normalizedKey) || SODA_VIP_CONTAINER_KEYS.has(normalizedKey)) {
        membershipKnown = true
        const level = SODA_SVIP_CONTAINER_KEYS.has(normalizedKey) ? 'svip' : 'vip'
        const state = sodaMembershipObjectState(item, level)
        if (state.active === true) applyLevel(level, 1, true, state.expiresAt)
      }
      if (item && typeof item === 'object') visit(item, depth + 1)
    }
  }

  visit(value, 0)
  if (isSvip) isVip = true
  const vipLevel = isSvip ? 'svip' : isVip ? 'vip' : 'none'
  const activeExpiries = [vipExpiresAt, svipExpiresAt].filter((item) => item > Date.now())
  return {
    membershipKnown,
    vipType: isSvip ? svipType : vipType,
    vipLevel,
    isVip,
    isSvip,
    vipLabel: vipLevel === 'svip' ? 'SVIP' : vipLevel === 'vip' ? 'VIP' : '无VIP',
    expiresAt: activeExpiries.length ? Math.min(...activeExpiries) : 0,
  }
}

/**
 * track_v2 负载里的 membership 字段是歧义来源：可能是曲目自身限制而非账号权益，
 * 因此只信任明确的 user_membership/account_membership 等容器。
 */
function sodaPlaybackMembershipFromPayload(payload) {
  const data = (payload && payload.data) || payload || {}
  const trustedCandidates = [
    data.user_membership,
    data.userMembership,
    data.account_membership,
    data.accountMembership,
    data.user && data.user.membership,
    data.account && data.account.membership,
    data.me && data.me.membership,
  ].filter((item) => item && typeof item === 'object')
  if (trustedCandidates.length) {
    const trusted = sodaMembershipFromData({ membership_sources: trustedCandidates })
    if (trusted.membershipKnown) return trusted
  }
  return {
    membershipKnown: false,
    vipType: 0,
    vipLevel: 'none',
    isVip: false,
    isSvip: false,
    vipLabel: '无VIP',
    expiresAt: 0,
  }
}

function sodaUnknownMembership(error) {
  return {
    membershipKnown: false,
    membershipStatus: 'unknown',
    reason: 'membership_unknown',
    vipType: 0,
    vipLevel: 'unknown',
    isVip: false,
    isSvip: false,
    vipLabel: '未知会员状态',
    expiresAt: 0,
    sessionValidated: false,
    error: normalizeText(error || 'SODA_MEMBERSHIP_UNKNOWN'),
  }
}

/** 记录会员正向观察（短宽限期），查询失败时短暂沿用最近一次正向结论 */
function sodaApplyMembershipObservation(historyKey, membership, now) {
  historyKey = normalizeText(historyKey)
  membership =
    membership && typeof membership === 'object' ? Object.assign({}, membership) : sodaUnknownMembership('SODA_MEMBERSHIP_UNKNOWN')
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const membershipKnown = !!membership.membershipKnown
  const expiresAt = Number(membership.expiresAt) || 0
  const positive = membershipKnown && !!(membership.isVip || membership.isSvip)

  if (membershipKnown) {
    if (historyKey) sodaMembershipPositiveHistory.delete(historyKey)
    if (positive && expiresAt > now && historyKey) {
      const retainedUntil = Math.min(expiresAt, now + SODA_MEMBERSHIP_POSITIVE_GRACE_MS)
      sodaMembershipPositiveHistory.set(historyKey, {
        membership: Object.assign({}, membership, {
          membershipStatus: membership.isSvip ? 'svip' : 'vip',
        }),
        observedAt: now,
        expiresAt,
        retainedUntil,
      })
      while (sodaMembershipPositiveHistory.size > 48) {
        const oldestKey = sodaMembershipPositiveHistory.keys().next().value
        if (!oldestKey) break
        sodaMembershipPositiveHistory.delete(oldestKey)
      }
    }
    return Object.assign(membership, {
      membershipStatus: positive ? (membership.isSvip ? 'svip' : 'vip') : 'free',
    })
  }

  const previous = historyKey ? sodaMembershipPositiveHistory.get(historyKey) : null
  if (
    previous &&
    previous.expiresAt > now &&
    previous.retainedUntil > now &&
    previous.membership &&
    previous.membership.membershipKnown
  ) {
    return Object.assign({}, previous.membership, {
      retainedOfficialPositive: true,
      retainedUntil: previous.retainedUntil,
      entitlementSource: 'recent-official-positive',
      membershipCheckError: membership.error || membership.reason || 'membership_unknown',
    })
  }
  if (previous && historyKey) sodaMembershipPositiveHistory.delete(historyKey)
  return Object.assign(sodaUnknownMembership(membership.error || membership.reason), membership, {
    membershipKnown: false,
    membershipStatus: 'unknown',
    reason: 'membership_unknown',
    vipType: 0,
    vipLevel: 'unknown',
    isVip: false,
    isSvip: false,
    vipLabel: '未知会员状态',
    expiresAt: 0,
  })
}

function sodaMembershipCacheTtlMs(membership, now) {
  now = Number.isFinite(Number(now)) ? Number(now) : Date.now()
  if (!(membership && membership.membershipKnown)) return 1
  if (!(membership.isVip || membership.isSvip)) return SODA_MEMBERSHIP_POSITIVE_CACHE_MS
  const expiresAt = Number(membership && membership.expiresAt) || 0
  if (expiresAt <= 0) return 1
  let remainingMs = expiresAt - now
  const retainedUntil = Number(membership.retainedUntil) || 0
  if (retainedUntil > 0) remainingMs = Math.min(remainingMs, retainedUntil - now)
  if (remainingMs <= 0) return 1
  return Math.max(1, Math.min(SODA_MEMBERSHIP_POSITIVE_CACHE_MS, remainingMs - 250))
}

const SODA_TIER_RANK = Object.freeze({ free: 0, vip: 1, svip: 2 })

function sodaNormalizeRequiredTier(value) {
  const text = normalizeText(value).toLowerCase().replace(/[-_\s]/g, '')
  if (/^(svip|supervip|hires|highres|highresolution|master|atmos|dolby|spatial)$/.test(text)) return 'svip'
  if (/^(vip|member|premium|lossless|sq|flac|exhigh|high|higher|highest|hq|320)$/.test(text)) return 'vip'
  return 'free'
}

function sodaHigherRequiredTier(a, b) {
  a = sodaNormalizeRequiredTier(a)
  b = sodaNormalizeRequiredTier(b)
  return SODA_TIER_RANK[b] > SODA_TIER_RANK[a] ? b : a
}

function sodaMembershipTier(membership) {
  if (!(membership && membership.membershipKnown)) return 'unknown'
  if (membership.isSvip) return 'svip'
  if (membership.isVip) return 'vip'
  return 'free'
}

function sodaRequiredTierAllowed(requiredTier, membership) {
  requiredTier = sodaNormalizeRequiredTier(requiredTier)
  if (requiredTier === 'free') return true
  if (!(membership && membership.membershipKnown)) return false
  if (requiredTier === 'svip') return !!membership.isSvip
  return !!membership.isVip
}

// ─────────────────────────── 音质/流候选评估 ───────────────────────────

function sodaNormalizeDurationSeconds(value) {
  const num = Number(value) || 0
  if (!num) return 0
  return num > 1000 ? Math.round(num / 1000) : Math.round(num)
}

/** 时长归一为毫秒（>1000 视为已是毫秒，与原实现秒级阈值一致） */
function sodaDurationToMs(value) {
  const num = Number(value) || 0
  if (!num) return 0
  return num > 1000 ? Math.round(num / 1000) * 1000 : Math.round(num * 1000)
}

function sodaNormalizeBitrateKbps(value) {
  const num = Number(value) || 0
  if (!num) return 0
  return num > 1000 ? Math.round(num / 1000) : Math.round(num)
}

function sodaBitrateForUi(value) {
  const kbps = sodaNormalizeBitrateKbps(value)
  return kbps > 0 ? kbps * 1000 : 0
}

function sodaQualityRank(quality, format, bitrate) {
  const q = normalizeText(quality).toLowerCase().replace(/[-_\s]/g, '')
  const f = normalizeText(format).toLowerCase()
  const br = sodaNormalizeBitrateKbps(bitrate)
  const losslessFormat = /flac|alac|wav/.test(f)
  const losslessLabel = /lossless|flac|sq|svip/.test(q)
  const hiresLabel = /hires|master/.test(q)
  if (hiresLabel && (losslessFormat || br >= 900)) return 110
  if (losslessLabel || losslessFormat || br >= 900) return 100
  if (hiresLabel) return 90
  if (/atmos|dolby|spatial/.test(q)) return 88
  if (/highest|excellent|superhigh|hq/.test(q)) return 80
  if (/higher|high|320/.test(q) || br >= 320) return 70
  if (/standard|medium|normal|128/.test(q) || br >= 128) return 50
  if (/low|preview/.test(q)) return 10
  return br > 0 ? 20 : 0
}

function sodaPlaybackLevel(quality, format, bitrate) {
  const rank = sodaQualityRank(quality, format, bitrate)
  if (rank >= 100) return 'lossless'
  if (rank >= 80) return 'hires'
  if (rank >= 65) return 'exhigh'
  return 'standard'
}

// ─────────────── 客户端权威音质门槛（track.label_info.quality_map） ───────────────
// 客户端给每个音质档打的会员角标来自 quality_map[<档位>].play_detail.need_vip，
// 这是上游算好的结果，比按标签/码率正则猜可靠。实测（track_v2 真样本）：
//   medium / higher / highest → need_vip:false（免费可播）；lossless / spatial / hi_res → need_vip:true
// 旧实现只看标签正则，把 higher/highest 误判成 VIP、把 hi_res 误判成 SVIP，
// 导致免费档被挡、会员档降级请求。
const SODA_QUALITY_KEY_ALIAS = {
  standard: 'medium', normal: 'medium', low: 'medium', medium: 'medium',
  exhigh: 'higher', hq: 'higher', high: 'higher', higher: 'higher',
  highest: 'highest', superhigh: 'highest', excellent: 'highest',
  hires: 'hi_res', highres: 'hi_res', highresolution: 'hi_res',
  spatial: 'spatial', atmos: 'spatial', dolby: 'spatial',
  lossless: 'lossless', sq: 'lossless', flac: 'lossless', master: 'lossless',
}
/** 各级典型码率（kbps），取自客户端 track.bit_rates，用于流标签缺失时归档 */
const SODA_QUALITY_KEY_BITRATE = { medium: 68, higher: 132, highest: 260, hi_res: 320, spatial: 321, lossless: 1080 }
/**
 * 客户端「音质档位 → 所需会员层级」的产品定义。
 * 来源：客户端 GetCommerceInfo(includes=['benefit_base']).benefit_base.quality.quality_list 的真实返回——
 *   medium 标准音质 free / highest 极高音质 free / lossless 无损音质 svip / spatial 全景声 svip / hi_res 录音室音质 svip
 * higher（较高）不下发给用户手选，只在 benefit_quality_map 里作为已授权项出现，播放免费。
 * 注：这不是账号态，是产品定义；账号是否有权限由 benefit_quality_map / membership 决定。
 */
const SODA_QUALITY_STAGE_BY_KEY = {
  medium: 'free',
  higher: 'free',
  highest: 'free',
  lossless: 'svip',
  spatial: 'svip',
  hi_res: 'svip',
}
/** 客户端 quality_list 的中文档位名（UI 文案对齐用） */
const SODA_QUALITY_LABEL_BY_KEY = {
  medium: '标准音质',
  higher: '较高音质',
  highest: '极高音质',
  lossless: '无损音质',
  spatial: '全景声',
  hi_res: '录音室音质',
}

/** 抽取 track 的权威音质门槛；没有 quality_map 信息时返回 null（调用方退回启发式） */
export function sodaTrackQualityGate(track) {
  const labelInfo = pickObject(track && track.label_info, track && track.labelInfo)
  if (!labelInfo) return null
  const qualityMap = pickObject(labelInfo.quality_map, labelInfo.qualityMap)
  const gate = { byKey: {}, vipPlayKeys: [], onlyVipDownload: false, hasMap: false }
  if (qualityMap) {
    for (const rawKey of Object.keys(qualityMap)) {
      const key = normalizeText(rawKey).toLowerCase()
      if (!key) continue
      const entry = pickObject(qualityMap[rawKey]) || {}
      const play = pickObject(entry.play_detail, entry.playDetail) || {}
      const needVip = play.need_vip === true || play.needVip === true
      const needPurchase = play.need_purchase === true || play.needPurchase === true
      gate.byKey[key] = { needVip, needPurchase, condition: normalizeText(play.condition || play.conditionKey) }
      if (needVip) gate.vipPlayKeys.push(key)
      gate.hasMap = true
    }
  }
  const vipPlay = pickArray(labelInfo.quality_only_vip_can_play, labelInfo.qualityOnlyVipCanPlay)
  if (vipPlay.length) {
    gate.vipPlayKeys = vipPlay.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
    gate.hasMap = true
  }
  gate.onlyVipDownload = labelInfo.only_vip_download === true || labelInfo.onlyVipDownload === true
  return gate.hasMap ? gate : null
}

/** 客户端档位键 → 所需层级（'free' | 'vip' | 'svip'），未知键返回空串 */
export function sodaQualityStageForKey(key, needVip) {
  const compact = normalizeText(key).toLowerCase().replace(/[-_\s]/g, '')
  const canonical = SODA_QUALITY_KEY_ALIAS[compact] || compact
  const stage = SODA_QUALITY_STAGE_BY_KEY[canonical]
  if (stage) return stage
  return needVip ? 'vip' : 'free'
}

/** 把一条流归一到 quality_map 的档位键：先按标签别名，再按格式，最后按码率就近 */
function sodaQualityKeyFromStream(stream, gate) {
  const keys = Object.keys((gate && gate.byKey) || {})
  if (!keys.length) return ''
  const compact = normalizeText(stream && stream.quality).toLowerCase().replace(/[-_\s]/g, '')
  const byAlias = compact ? SODA_QUALITY_KEY_ALIAS[compact] || compact : ''
  const matched = keys.find((key) => key.replace(/[-_\s]/g, '') === byAlias || key.replace(/[-_\s]/g, '') === compact)
  if (matched) return matched
  const format = normalizeText(stream && stream.format).toLowerCase()
  if (/flac|alac|wav/.test(format)) {
    const losslessKey = keys.find((key) => /lossless|flac|sq/.test(key))
    if (losslessKey) return losslessKey
  }
  const bitrate = sodaNormalizeBitrateKbps(stream && stream.bitrate)
  if (bitrate > 0) {
    let pick = ''
    let bestDiff = Infinity
    for (const key of keys) {
      const target = SODA_QUALITY_KEY_BITRATE[key]
      if (!target) continue
      const diff = Math.abs(bitrate - target)
      if (diff < bestDiff) {
        bestDiff = diff
        pick = key
      }
    }
    if (pick) return pick
  }
  return ''
}

/** 该流在客户端门槛下需要什么层级（无法归档时返回 null，交给启发式兜底） */
function sodaStreamTierFromQualityGate(stream, gate) {
  if (!gate) return null
  const key = sodaQualityKeyFromStream(stream, gate)
  if (!key) return null
  const entry = (gate.byKey || {})[key]
  const needVip = entry ? entry.needVip : (gate.vipPlayKeys || []).includes(key)
  return sodaQualityStageForKey(key, needVip)
}

function sodaBetterStreamCandidate(a, b) {
  if (!b) return true
  // 先比时长：过滤明显被截断的试听片段
  const ad = sodaNormalizeDurationSeconds(a && a.duration)
  const bd = sodaNormalizeDurationSeconds(b && b.duration)
  if (ad > 0 || bd > 0) {
    if (ad > bd + 1) return true
    if (bd > ad + 1) return false
  }
  const ar = sodaQualityRank(a && a.quality, a && a.format, a && a.bitrate)
  const br = sodaQualityRank(b && b.quality, b && b.format, b && b.bitrate)
  if (ar !== br) return ar > br
  const ab = sodaNormalizeBitrateKbps(a && a.bitrate)
  const bb = sodaNormalizeBitrateKbps(b && b.bitrate)
  if (ab !== bb) return ab > bb
  return (Number(a && a.size) || 0) > (Number(b && b.size) || 0)
}

function sodaBestStreamCandidate(candidates) {
  let best = null
  ;(candidates || []).forEach((item) => {
    if (!item || !item.url) return
    if (sodaBetterStreamCandidate(item, best)) best = item
  })
  return best
}

/** 由音质标签/格式/码率推断该流所需的会员层级；有客户端 quality_map 时以其为准 */
export function sodaStreamRequiredTier(stream, gate) {
  stream = stream && typeof stream === 'object' ? stream : {}
  const effectiveGate = gate || stream.qualityGate || null
  const gated = sodaStreamTierFromQualityGate(stream, effectiveGate)
  if (gated) return gated
  let requiredTier = sodaNormalizeRequiredTier(
    stream.requiredTier || stream.required_tier || stream.membershipTier || stream.membership_tier || '',
  )
  const quality = normalizeText(stream.quality || stream.definition || '').toLowerCase().replace(/[-_\s]/g, '')
  const format = normalizeText(stream.format || '').toLowerCase()
  const bitrate = sodaNormalizeBitrateKbps(stream.bitrate)
  // 兜底启发式（仅在没有 quality_map 时生效）。客户端实测没有任何档位要求 SVIP：
  // hi_res / spatial / lossless 都只是 need_vip:true，SVIP 只在音质确实标了 svip 语义时才升。
  if (/\bsvip\b|supervip|onlysvip|sviprequired/.test(quality)) {
    requiredTier = sodaHigherRequiredTier(requiredTier, 'svip')
  } else if (
    /lossless|flac|sq|hires|highres|highresolution|master|atmos|dolby|spatial|hi_?res/.test(quality) ||
    /flac|alac|wav/.test(format) ||
    bitrate >= 900
  ) {
    requiredTier = sodaHigherRequiredTier(requiredTier, 'vip')
  } else if (/highest|excellent|superhigh|higher|high|hq|exhigh|320/.test(quality) || bitrate > 192) {
    requiredTier = sodaHigherRequiredTier(requiredTier, 'vip')
  }
  return requiredTier
}

function sodaStreamAllowedForMembership(stream, membership) {
  if (!stream || !stream.url) return false
  return sodaRequiredTierAllowed(sodaStreamRequiredTier(stream), membership)
}

/** 只在会员允许的候选里挑最优流 */
function sodaBestStreamCandidateForMembership(candidates, membership) {
  return sodaBestStreamCandidate((candidates || []).filter((item) => sodaStreamAllowedForMembership(item, membership)))
}

/**
 * 请求音质选档（/api/soda/song/url 的 quality 参数）：在会员允许的候选流里挑最贴近请求档位的一档。
 * - 'standard'（含 low/normal/medium/128）→ 最低可用档；
 * - 'high'（含 higher/hq/exhigh/320）→ 中档（按质量分就近，同距取低档，宁低勿败）；
 * - 'lossless'（含 sq/flac）→ 无损档；'hires'（含 master/highres）→ Hi-Res 档；
 * - 纯数字 → 按码率（kbps，兼容 bps 原始值）就近匹配，同距取低码率。
 * 未识别的标签 / 候选为空 / 全是质量分未知(0)的流 时回退 fallbackBest（= 现行"会员允许内最优"），
 * 保证缺省 quality 与旧行为完全一致；请求档位越权时上游候选已被会员过滤剔除，自然落回低档而非报错。
 * 明显截断的试听片段（时长比候选最长还要短 2s 以上）不参与选档，避免 standard 档选中 30s 预览。
 */
export function sodaPickStreamForQuality(streams, requestedQuality, fallbackBest) {
  const autoStripSvip = !normalizeText(requestedQuality)
  if (autoStripSvip) {
    // 「自动」不上超级会员流（与网易云/QQ 的自动档同口径）：自动选档池剔除需 SVIP 的候选，
    // 只在普通 VIP 档里就近挑；剔除后为空（整曲只有 SVIP 流）时由调用方放行原 best，保证不断播。
    const nonSvip = (streams || []).filter((item) => item && item.url && sodaStreamRequiredTier(item) !== 'svip')
    if (nonSvip.length) streams = nonSvip
  }
  const candidates = (streams || []).filter((item) => item && item.url)
  if (!candidates.length || !fallbackBest) return fallbackBest
  const compact = normalizeText(requestedQuality).toLowerCase().replace(/[-_\s]/g, '')
  if (!compact) return fallbackBest
  let maxDuration = 0
  candidates.forEach((item) => {
    maxDuration = Math.max(maxDuration, sodaNormalizeDurationSeconds(item.duration))
  })
  const fullLength = maxDuration
    ? candidates.filter((item) => {
        const duration = sodaNormalizeDurationSeconds(item.duration)
        return !(duration > 0 && duration + 2 < maxDuration)
      })
    : candidates
  const pool = fullLength.length ? fullLength : candidates
  // 纯数字码率：就近匹配
  if (/^\d+(?:\.\d+)?$/.test(compact)) {
    const target = sodaNormalizeBitrateKbps(compact)
    if (!(target > 0)) return fallbackBest
    let pick = null
    let pickDiff = 0
    for (const item of pool) {
      const kbps = sodaNormalizeBitrateKbps(item.bitrate)
      if (!(kbps > 0)) continue
      const diff = Math.abs(kbps - target)
      if (!pick || diff < pickDiff || (diff === pickDiff && kbps < sodaNormalizeBitrateKbps(pick.bitrate))) {
        pick = item
        pickDiff = diff
      }
    }
    return pick || fallbackBest
  }
  // 标签档位：映射到 sodaQualityRank 同一标尺的目标分，就近挑档，同距取低档
  const targetRank = /^(standard|normal|medium|low|preview|128)$/.test(compact)
    ? 0
    : /^(high|higher|hq|exhigh|320)$/.test(compact)
      ? 70
      : /^(lossless|sq|flac)$/.test(compact)
        ? 100
        : /^(hires|master|highres|highresolution)$/.test(compact)
          ? 110
          : -1
  if (targetRank < 0) return fallbackBest
  let pick = null
  let pickDiff = 0
  for (const item of pool) {
    const rank = sodaQualityRank(item.quality, item.format, item.bitrate)
    // 质量分未知（0）的流不冒充"最低档"——可能只是缺元数据的高码率流
    if (targetRank === 0 && rank <= 0) continue
    const diff = Math.abs(rank - targetRank)
    if (!pick || diff < pickDiff || (diff === pickDiff && rank < sodaQualityRank(pick.quality, pick.format, pick.bitrate))) {
      pick = item
      pickDiff = diff
    }
  }
  return pick || fallbackBest
}

function sodaStreamUrlFrom(value) {
  return normalizeText(
    qishuiObjectString(value, [
      'main_play_url', 'MainPlayUrl', 'main_url', 'MainUrl', 'url', 'URL', 'play_url', 'PlayURL',
      'playable_url', 'PlayableUrl', 'playableUrl',
    ]) ||
      qishuiObjectString(value, [
        'backup_play_url', 'BackupPlayUrl', 'backup_url', 'BackupUrl', 'backup_url_1', 'backup_url_2', 'backup_url_3',
      ]) ||
      firstUrl(value && (value.backup_urls || value.backupUrls || value.url_list || value.UrlList)),
  )
}

function sodaBitrateFromUrl(value) {
  value = normalizeText(value)
  if (!value) return 0
  try {
    const parsed = new URL(value)
    for (const key of ['br', 'bitrate', 'bit_rate', 'real_bitrate']) {
      const bitrate = Number(parsed.searchParams.get(key)) || 0
      if (bitrate > 0) return bitrate
    }
  } catch {
    /* 非 URL 形态，忽略 */
  }
  const match = value.match(/(?:^|[\/_.-])(\d{2,4})(?:k|kbps)(?:[\/_.-]|$)/i)
  return match ? Number(match[1]) || 0 : 0
}

function sodaBitrateFromSize(size, duration) {
  size = Number(size) || 0
  duration = sodaNormalizeDurationSeconds(duration)
  if (size <= 0 || duration <= 0) return 0
  const bitrate = Math.round((size * 8) / duration)
  return bitrate >= 32000 && bitrate <= 12000000 ? bitrate : 0
}

function sodaVideoModelPlayAuth(value) {
  value = value && typeof value === 'object' ? value : {}
  const child = pickObject(value.encrypt_info, value.EncryptInfo, value.encryptInfo)
  return qishuiObjectString(child, ['spade_a', 'SpadeA', 'spadeA', 'play_auth', 'PlayAuth'])
}

function sodaVideoModelQualityHint(key) {
  const normalized = normalizeText(key).toLowerCase().replace(/[-_\s]/g, '')
  if (!normalized) return ''
  return ['hires', 'lossless', 'sq', 'flac', 'highest', 'higher', 'standard', 'normal'].find((token) => normalized.includes(token)) || ''
}

function sodaStreamFromObject(value, inherited) {
  if (!value || typeof value !== 'object') return null
  const url = sodaStreamUrlFrom(value)
  if (!url) return null
  inherited = inherited || {}
  const meta = pickObject(value.video_meta, value.VideoMeta, value.meta, value.Meta)
  const size =
    qishuiObjectNumber(value, ['size', 'Size', 'file_size', 'FileSize', 'data_size', 'DataSize']) ||
    qishuiObjectNumber(meta, ['size', 'Size', 'file_size', 'FileSize'])
  const duration = sodaNormalizeDurationSeconds(qishuiObjectNumber(value, ['duration', 'Duration']) || inherited.duration || 0)
  const bitrate =
    qishuiObjectNumber(value, ['bitrate', 'Bitrate', 'real_bitrate', 'RealBitrate', 'br', 'BR', 'bit_rate', 'BitRate']) ||
    qishuiObjectNumber(meta, ['bitrate', 'Bitrate', 'real_bitrate', 'RealBitrate', 'bit_rate', 'BitRate']) ||
    sodaBitrateFromUrl(url) ||
    sodaBitrateFromSize(size, duration)
  const stream = {
    url,
    auth:
      qishuiObjectString(value, ['play_auth', 'PlayAuth', 'spade_a', 'SpadeA']) ||
      sodaVideoModelPlayAuth(value) ||
      inherited.auth ||
      '',
    size,
    format:
      qishuiObjectString(value, ['format', 'Format', 'vtype', 'VType', 'file_format', 'FileFormat']) ||
      qishuiObjectString(meta, ['format', 'Format', 'vtype', 'VType', 'codec_type', 'CodecType']),
    bitrate,
    quality:
      qishuiObjectString(value, ['quality', 'Quality', 'definition', 'Definition', 'quality_type', 'QualityType']) ||
      sodaVideoModelQualityHint(qishuiObjectString(value, ['gear_des_key', 'GearDesKey']) || inherited.keyHint || ''),
    duration,
  }
  if (inherited.gate) stream.qualityGate = inherited.gate
  stream.requiredTier = sodaStreamRequiredTier(stream, inherited.gate)
  return stream
}

/** 递归收集 video_model（可能为多层转义 JSON 字符串）中的所有可用流 */
function sodaCollectVideoModelStreams(value, keyHint, inherited, out) {
  value = sodaMaybeParseJson(value)
  inherited = inherited || {}
  if (!value) return
  if (Array.isArray(value)) {
    value.forEach((item) => sodaCollectVideoModelStreams(item, keyHint, inherited, out))
    return
  }
  if (typeof value !== 'object') return
  const ownAuth = sodaVideoModelPlayAuth(value) || inherited.auth || ''
  const ownDuration =
    sodaNormalizeDurationSeconds(qishuiObjectNumber(value, ['video_duration', 'duration', 'Duration'])) ||
    inherited.duration ||
    0
  const entry = sodaStreamFromObject(value, { auth: ownAuth, duration: ownDuration, keyHint, gate: inherited.gate })
  if (entry) out.push(entry)
  Object.keys(value).forEach((key) => {
    sodaCollectVideoModelStreams(value[key], key, { auth: ownAuth, duration: ownDuration, gate: inherited.gate }, out)
  })
}

// 曲目自身的 VIP/SVIP 限制探测（跳过 account/membership 等账号容器避免误判）
const SODA_TRACK_VIP_KEYS = new Set([
  'onlyvipplayable', 'viprequired', 'needvip', 'isvip', 'isviponly', 'viponly', 'onlyvip',
  'onlymemberplayable', 'memberrequired', 'needmember', 'payplay',
])
const SODA_TRACK_SVIP_KEYS = new Set([
  'onlysvipplayable', 'sviprequired', 'needsvip', 'issvip', 'issviponly', 'sviponly', 'onlysvip',
  'onlysupervipplayable', 'superviprequired', 'needsupervip', 'issuperviponly', 'superviponly',
])
const SODA_TRACK_ACCOUNT_CONTAINER_KEYS = new Set([
  'membership', 'membershipinfo', 'usermembership', 'accountmembership',
  'account', 'userinfo', 'userprofile', 'me',
])

function sodaTrackPlaybackRestriction(value) {
  let vipRequired = false
  let svipRequired = false
  let membershipHintKnown = false
  let visited = 0
  const evidence = []
  const visit = (node, depth, pathKeys) => {
    if (!node || typeof node !== 'object' || depth > 7 || visited > 800) return
    visited += 1
    if (Array.isArray(node)) {
      node.slice(0, 160).forEach((item) => visit(item, depth + 1, pathKeys))
      return
    }
    for (const [key, item] of Object.entries(node).slice(0, 180)) {
      const normalizedKey = sodaFieldKey(key)
      const nextPath = pathKeys.concat(normalizedKey)
      if (SODA_TRACK_ACCOUNT_CONTAINER_KEYS.has(normalizedKey)) continue
      if (SODA_TRACK_SVIP_KEYS.has(normalizedKey)) {
        membershipHintKnown = true
        if (sodaExplicitPositive(item)) {
          svipRequired = true
          vipRequired = true
          evidence.push(nextPath.join('.'))
        }
      } else if (SODA_TRACK_VIP_KEYS.has(normalizedKey)) {
        membershipHintKnown = true
        if (sodaExplicitPositive(item)) {
          vipRequired = true
          evidence.push(nextPath.join('.'))
        }
      } else if (normalizedKey === 'fee') {
        membershipHintKnown = true
        if (Number(item) === 1) {
          vipRequired = true
          evidence.push(nextPath.join('.'))
        }
      } else if (normalizedKey === 'privilege') {
        membershipHintKnown = true
        if (Number(item) >= 9) {
          vipRequired = true
          evidence.push(nextPath.join('.'))
        }
      }
      if (item && typeof item === 'object') visit(item, depth + 1, nextPath)
    }
  }
  visit(value, 0, [])
  return {
    vipRequired,
    svipRequired,
    requiredTier: svipRequired ? 'svip' : vipRequired ? 'vip' : 'free',
    membershipHintKnown,
    evidence,
  }
}

// ─────────────────────────── Web API 请求层（多基地轮询 + LunaPC 头）───────────────────────────

function sodaWebCommonParams(extra, opts) {
  if (opts && opts.noDefaultParams) return Object.assign({}, extra || {})
  return Object.assign({}, QISHUI_WEB_DEFAULT_PARAMS, extra || {})
}

/**
 * 设备指纹（每会话稳定）：audit 确认上游对「高频出现的全新设备」敏感，会回 HTML 质询页
 * （= requestJson「无效 JSON」的头号嫌疑）。此前 device_id/fp/iid 每次用 Date.now() 现造、cdid 恒空。
 * 现以 cookie 内容 sha1 前 16 位为键，模块级 Map 记忆同一登录态的身份组合，进程生命周期内不变；
 * 格式仿登录侧 qishui-auth-v6 的持久化身份（device_id 16 位数字 / install_id 15 位数字）+ 字节系 cdid 惯例 UUID。
 * 生成是同步的（randomInt/randomUUID 无 await 缝隙），Map 同步读写即并发安全；未带 cookie 时退回进程级默认身份。
 */
function sodaRandomNumericId(length, firstMax = 8) {
  let value = String(crypto.randomInt(1, Math.max(2, firstMax + 1)))
  while (value.length < length) value += String(crypto.randomInt(0, 10))
  return value
}

function sodaCreateDeviceIdentity() {
  const deviceId = sodaRandomNumericId(16)
  return {
    device_id: deviceId,
    fp: deviceId,
    iid: sodaRandomNumericId(15),
    cdid: crypto.randomUUID(),
  }
}

const sodaDeviceIdentityCache = new Map()
const SODA_DEVICE_IDENTITY_CACHE_LIMIT = 128

function sodaStableDeviceIdentity(cookieText) {
  const key = cookieText ? sodaCookieFingerprint(cookieText) : ''
  if (!key) {
    if (!sodaDeviceIdentityCache.has('')) sodaDeviceIdentityCache.set('', sodaCreateDeviceIdentity())
    return sodaDeviceIdentityCache.get('')
  }
  let identity = sodaDeviceIdentityCache.get(key)
  if (!identity) {
    identity = sodaCreateDeviceIdentity()
    sodaDeviceIdentityCache.set(key, identity)
    while (sodaDeviceIdentityCache.size > SODA_DEVICE_IDENTITY_CACHE_LIMIT) {
      const oldestKey = sodaDeviceIdentityCache.keys().next().value
      if (!oldestKey) break
      // 默认身份（'' 键）被驱逐也没关系：下次未带 cookie 请求时会按需重建
      sodaDeviceIdentityCache.delete(oldestKey)
    }
  }
  return identity
}

/** PC 客户端公共参数（aid=386088 等，来自逆向抓包）；传 cookie 时复用该会话的稳定设备指纹 */
function sodaPcAppParams(extra, cookieText) {
  const identity = sodaStableDeviceIdentity(cookieText)
  return Object.assign(
    {
      aid: '386088',
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: identity.device_id,
      cdid: identity.cdid,
      iid: identity.iid,
      version_name: '3.3.0',
      version_code: '30030000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 11',
      fp: identity.fp,
    },
    extra || {},
  )
}

function sodaWebHeaders(cookieText, opts) {
  const cookie = opts && opts.sessionOnly ? sodaSessionCookieHeader(cookieText) : normalizeSodaCookieInput(cookieText)
  const headers = {
    Accept: 'application/json,text/plain,*/*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': opts && opts.pcApp ? QISHUI_PC_APP_UA : QISHUI_WEB_UA,
  }
  if (opts && opts.pcApp) {
    headers['x-luna-background-type'] = 'foreground'
    headers['x-luna-is-background-req'] = '0'
    headers['x-luna-is-local-user'] = '1'
  }
  if (cookie) headers.Cookie = cookie
  return headers
}

function sodaPcStatusError(payload, fallback) {
  if (!payload || typeof payload !== 'object') return null
  const code = Number(payload.status_code == null ? payload.error_code : payload.status_code)
  if (!Number.isFinite(code) || code === 0) return null
  const info = payload.status_info || {}
  const message = normalizeText(info.status_msg || payload.message || payload.status_msg || fallback || 'SODA_PC_API_ERROR')
  const err = new Error(message || 'SODA_PC_API_ERROR')
  err.code = 'SODA_PC_API_' + code
  err.statusCode = code
  err.body = payload
  return err
}

/**
 * Web API GET：在多个基地址间轮询，401/403 直接终止（会话无效换基地址也没用）。
 */
async function sodaWebRequestJson(apiPath, params, cookieText, opts = {}) {
  const bases = Array.isArray(opts.bases) && opts.bases.length ? opts.bases : QISHUI_WEB_API_BASES
  let lastErr = null
  for (const base of bases) {
    const target = /^https?:\/\//i.test(apiPath) ? apiPath : String(base || '').replace(/\/+$/, '') + apiPath
    const targetUrl = urlWithParams(target, sodaWebCommonParams(params, opts))
    try {
      const json = await requestJson(targetUrl, {
        timeoutMs: opts.timeoutMs || 8000,
        headers: sodaWebHeaders(cookieText, opts),
      })
      const err = sodaPcStatusError(json, 'SODA_WEB_REQUEST_FAILED')
      if (err) throw err
      return json
    } catch (err) {
      lastErr = err
      if (err && (err.statusCode === 401 || err.statusCode === 403)) break
    }
  }
  throw lastErr || new Error('SODA_WEB_REQUEST_FAILED')
}

/** PC 客户端写接口 POST（必须携带会话 cookie） */
async function sodaPcPostJson(apiPath, payload, cookieText, opts = {}) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    const err = new Error('QISHUI_COOKIE_REQUIRED')
    err.code = 'QISHUI_COOKIE_REQUIRED'
    throw err
  }
  const body = JSON.stringify(payload || {})
  const json = await requestJson(qishuiPcUrl(apiPath, sodaPcAppParams(opts.params, cookieText)), {
    method: 'POST',
    timeoutMs: opts.timeoutMs || 9000,
    headers: Object.assign(sodaWebHeaders(cookie, { sessionOnly: true, pcApp: true }), {
      Referer: 'https://www.qishui.com/',
    }),
  }, body)
  const statusError = sodaPcStatusError(json, opts.errorCode || 'SODA_PC_WRITE_FAILED')
  if (statusError) throw statusError
  return json
}

// ─────────────────────────── 媒体映射（统一 SodaSong 对象）───────────────────────────

function extractSodaMediaList(payload) {
  const data = (payload && payload.data) || payload || {}
  const direct = pickArray(
    data.media_resources,
    data.media_list,
    data.related_media,
    data.medias,
    data.media,
    data.tracks,
    data.track_list,
    data.songs,
    data.items,
    data.list,
    data.result,
    data.song_list,
    data.recommend_media_list,
  )
  if (direct.length) return direct
  const candidates = []
  function walk(node, depth) {
    if (!node || depth > 4) return
    if (Array.isArray(node)) {
      const mediaLike = node.filter(
        (item) => item && typeof item === 'object' && (item.media || item.track_entity || item.entity || item.base_info || item.id || item.media_id),
      )
      if (mediaLike.length > candidates.length) candidates.splice(0, candidates.length, ...mediaLike)
      node.forEach((item) => walk(item, depth + 1))
    } else if (typeof node === 'object') {
      Object.keys(node).slice(0, 80).forEach((key) => walk(node[key], depth + 1))
    }
  }
  walk(data, 0)
  return candidates
}

/** 多歌手名拆分（沿用原实现的分隔符："A/B"、"A,B"、"A&B"；搜索派生端点聚合歌手时同款拆法，勿两处漂移） */
const SODA_ARTIST_NAME_SPLIT_RE = /\s*\/\s*|\s*,\s*|\s*&\s*/

function sodaArtists(related, base, display, track, media) {
  const links = pickArray(
    related.artist_links,
    related.artists,
    base.artist_links,
    base.artists,
    display.artist_links,
    display.artists,
    track && track.artists,
    media && media.artists,
  )
  const out = []
  links.forEach((item) => {
    const name = normalizeText(item && (item.name || item.display_name || item.simple_display_name || item.title || item.artist_name))
    if (!name || out.some((a) => a.name === name)) return
    const artist = { id: String((item && (item.id || item.artist_id || item.open_id)) || ''), name }
    // 歌手头像。真实字段是 **url_avatar**（URLInfo{uri,urls,template_prefix}）——旧实现只读了
    // avatar_url/avatarUrl/avatar/... 这一串不存在的名字，所以列表里的歌手头像一直是空的。
    // 其余几个名字保留作兼容（不同接口形态略有差异）。
    const avatar = qishuiFirstImageUrl(
      '~c5_300x300.jpg',
      item.url_avatar,
      item.urlAvatar,
      item.avatar_url,
      item.avatarUrl,
      item.avatar,
      item.large_avatar_url,
      item.medium_avatar_url,
    )
    if (avatar) artist.avatarUrl = avatar
    out.push(artist)
  })
  const fallback = normalizeText(base.artist_name || display.artist_name || related.artist_name || (track && track.artist_name) || (media && media.artist_name))
  if (fallback && !out.length) {
    fallback.split(SODA_ARTIST_NAME_SPLIT_RE).forEach((name) => {
      name = normalizeText(name)
      if (name) out.push({ id: '', name })
    })
  }
  return out
}

/**
 * 会话内媒体项 → 统一 SodaSong：
 * { id, name, artist, artists?, album, albumId?, coverUrl, durationMs, vip, requiredTier, onlyVipPlayable? }
 */
export function mapSodaMedia(raw, index, query) {
  raw = raw || {}
  const entity = pickObject(raw.entity, raw.data, raw)
  const media = pickObject(entity.media, raw.media, entity)
  const wrapper = pickObject(entity.track_wrapper, media.track_wrapper, raw.track_wrapper)
  const track = pickObject(wrapper.track, media.track_entity, raw.track_entity, media.track, raw.track, media)
  const base = pickObject(track.base_info, media.base_info, raw.base_info, track)
  const display = pickObject(track.display_info, media.display_info, raw.display_info)
  const related = pickObject(track.related_info, media.related_info, raw.related_info)
  const id = normalizeText(base.id || track.id || media.id || raw.id || raw.media_id || raw.item_id || raw.song_id || raw.vid)
  const name = normalizeText(base.name || base.title || track.name || track.title || media.name || raw.name || raw.title)
  if (!id || !name) return null
  const artists = sodaArtists(related, base, display, track, media)
  const artist = artists.map((a) => a.name).filter(Boolean).join(' / ') || normalizeText(base.author || raw.author || '')
  const albumLink = pickObject(related.album_link, related.album, base.album, display.album, track.album, media.album)
  const album = normalizeText(albumLink.name || albumLink.title || base.album_name || display.album_name || '')
  const albumId = normalizeText(albumLink.id || albumLink.album_id || base.album_id || media.album_id || '')
  const coverUrl = qishuiFirstImageUrl(
    '~c5_375x375.jpg',
    display.cover_url,
    display.url_cover,
    base.cover_url,
    base.url_cover,
    albumLink.cover_url,
    albumLink.url_cover,
    track.url_cover,
    track.cover_url,
    media.cover_url,
    media.url_cover,
    raw.cover_url,
    raw.cover,
    raw.url_cover,
  )
  const rawDuration =
    Number(base.duration_ms || base.duration || track.duration_ms || track.duration || media.duration_ms || media.duration || raw.duration || 0) || 0
  // 顺路把随搜索结果附带的歌词种入缓存（后续 /api/soda/lyric 直接命中）
  const lyricInfo = pickObject(display.lyric_info, track.lyric_info, base.lyric_info)
  const lyricEntity = pickObject(lyricInfo.lyric_entity, lyricInfo.lyric, lyricInfo.original_lyric)
  const lyricText = normalizeLyricBody(lyricEntity.content || lyricInfo.content || lyricInfo.lyric || lyricInfo.lyric_text || '')
  const translations = pickArray(lyricInfo.lang_translations, lyricInfo.translations, lyricInfo.translation)
  let tlyricText = ''
  for (const item of translations) {
    const tEntity = pickObject(item && item.lyric_entity, item)
    const text = normalizeLyricBody(tEntity.content || (item && (item.content || item.lyric || item.lyric_text)))
    if (text) {
      tlyricText = text
      break
    }
  }
  if (lyricText) cacheSodaLyric(id, lyricText, tlyricText, 'soda-web-cache')
  // VIP 限制：label_info.only_vip_playable + 深度限制探测取更严格的一档
  const labelVip = !!(track.label_info && track.label_info.only_vip_playable)
  const restriction = sodaTrackPlaybackRestriction({ track, media, base })
  const vip = labelVip || restriction.vipRequired
  const requiredTier = vip ? sodaHigherRequiredTier(restriction.requiredTier, 'vip') : 'free'
  const song = {
    id,
    name,
    artist,
    album,
    coverUrl,
    durationMs: sodaDurationToMs(rawDuration),
    vip,
    requiredTier: vip ? requiredTier : 'free',
  }
  if (artists.length) song.artists = artists.map((a) => ({ id: a.id, name: a.name }))
  if (albumId) song.albumId = albumId
  if (vip) song.onlyVipPlayable = true
  // 限免凭证：只在「列表/推荐流条目」上（track_wrapper.limited_free_info），track_v2 那侧返回 null。
  // 必须原样整份透出、原样整份回传——sign(v2.0) 签的是整个对象，裁剪或改写任一字段服务端都不认
  // （实测：只传 sign+sign_version 无效、改 expire_time 无效、跨曲复用 sign 无效）。
  // 有它且 limited_free=true，track_v2 才会把 29s 试听流换成整曲。
  const limitedFree = pickObject(wrapper.limited_free_info, media.limited_free_info, raw.limited_free_info)
  if (limitedFree && limitedFree.limited_free === true) {
    song.limitedFreeInfo = limitedFree
    song.limitedFree = true
  }
  return song
}

function dedupeSodaSongs(songs) {
  const seen = new Set()
  const out = []
  ;(songs || []).forEach((song) => {
    if (!song || !song.id) return
    const key = String(song.id)
    if (seen.has(key)) return
    seen.add(key)
    out.push(song)
  })
  return out
}

function mapSodaMediaList(rawItems, query) {
  return dedupeSodaSongs((rawItems || []).map((item, index) => mapSodaMedia(item, index, query)).filter(Boolean))
}

/** 公开目录条目 → 统一 SodaSong */
function mapSodaPublicItem(raw, index, query) {
  raw = raw || {}
  const author = pickObject(raw.author_info, raw.author, raw.artist)
  const albumObj = pickObject(raw.album_info, raw.album)
  const id = normalizeText(raw.item_id || raw.id || raw.song_id || raw.music_id)
  const name = normalizeText(raw.title || raw.name || raw.song_name)
  if (!id || !name) return null
  const artistName = normalizeText(author.name || raw.author_name || raw.artist_name || raw.singer || '')
  const lyricInfo = pickObject(raw.lyric_info, raw.lyric)
  const lyric = normalizeLyricBody(lyricInfo.lyric_text || lyricInfo.content || lyricInfo.lyric || raw.lyric_text || '')
  if (lyric) cacheSodaLyric(id, lyric, '', 'soda-public-search-cache')
  const vip = !!(raw.qishui_label_info && raw.qishui_label_info.only_vip_playable)
  const song = {
    id,
    name,
    artist: artistName,
    album: normalizeText(albumObj.name || raw.album_name || ''),
    coverUrl: firstUrl(raw.cover_url || raw.cover || raw.artwork || albumObj.cover_url),
    durationMs: sodaDurationToMs(raw.duration_ms || raw.duration || 0),
    vip,
    requiredTier: vip ? 'vip' : 'free',
  }
  if (artistName) {
    song.artists = [{ id: normalizeText(author.id || author.author_id), name: artistName }]
    // 公开目录作者头像（author_info.avatar_url 等字段上游带才透传，缺失不出该字段）
    const artistAvatar = qishuiFirstImageUrl(
      '~c5_300x300.jpg',
      author.avatar_url,
      author.avatarUrl,
      author.avatar,
      author.large_avatar_url,
      author.medium_avatar_url,
    )
    if (artistAvatar) song.artists[0].avatarUrl = artistAvatar
  }
  const albumId = normalizeText(albumObj.id || raw.album_id || '')
  if (albumId) song.albumId = albumId
  if (vip) song.onlyVipPlayable = true
  return song
}

// ─────────────────────────── 公开搜索相关性排序 ───────────────────────────

function sodaSearchComparable(value) {
  return normalizeText(value)
    .normalize('NFKC')
    .toLowerCase()
    // 设备端 nodejs-mobile 的 V8 不支持字符类内 \p{...}（Invalid property name in character class），
    // 改用纯 ASCII 区间等价写法：去掉空白与 ASCII 标点/符号
    .replace(/[\s!-\/:-@\[-`{-~]+/g, '')
}

function sodaPublicSearchScore(song, keywords) {
  song = song || {}
  const query = sodaSearchComparable(keywords)
  if (!query) return 0
  const name = sodaSearchComparable(song.name)
  const artist = sodaSearchComparable(song.artist)
  const album = sodaSearchComparable(song.album)
  let score = 0
  if (name === query) score += 180
  else if (name.includes(query)) score += 120
  else if (name && query.includes(name) && name.length >= 2) score += 70
  if (artist === query) score += 150
  else if (artist.includes(query)) score += 105
  if (album === query) score += 80
  else if (album.includes(query)) score += 45
  const tokens = normalizeText(keywords).split(/\s+/).map(sodaSearchComparable).filter((token) => token.length >= 2)
  tokens.forEach((token) => {
    if (name.includes(token)) score += 28
    if (artist.includes(token)) score += 22
    if (album.includes(token)) score += 10
  })
  return score
}

/** 相关性排序：有命中的条目优先，其次保持上游热度顺序 */
function rankSodaPublicSongs(songs, keywords, limit) {
  const scored = (Array.isArray(songs) ? songs : []).map((song, index) => ({
    song,
    index,
    score: sodaPublicSearchScore(song, keywords),
  }))
  const matched = scored.filter((item) => item.score > 0)
  const source = matched.length ? matched : scored
  return source
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.max(1, Number(limit) || 8))
    .map((item) => item.song)
}

// ─────────────────────────── 搜索实现（PC 会话优先 + 公开目录兜底）───────────────────────────

/** 搜索类型归一：客户端 Search 的 search_type 取 all|track|artist|album|playlist（缺省 track） */
const SODA_SEARCH_TYPES = new Set(['all', 'track', 'artist', 'album', 'playlist', 'mix', 'video'])
function sodaNormalizeSearchType(value) {
  const type = normalizeText(value).toLowerCase()
  return SODA_SEARCH_TYPES.has(type) ? type : 'track'
}

/**
 * 搜索结果分组拆解。客户端真实结构：
 *   result_groups[] = { id, data:[{ meta:{item_type}, entity:{track|playlist|artist|album|...} }],
 *                       next_cursor, has_more, display_title, display_type, description, bottom_desc, display_view_all }
 * 游标在「组」上（不是 data 上），旧实现读 data.next_cursor 永远拿不到 → 翻页重复。
 */
function extractSodaPcSearchGroups(payload) {
  const data = (payload && payload.data) || payload || {}
  const groups = pickArray(
    data.result_groups,
    data.resultGroups,
    data.search_result && data.search_result.result_groups,
    payload && payload.result_groups,
  )
  const items = []
  for (const group of groups) {
    const groupData = group && (group.data || group.items || group.list || group.result)
    if (Array.isArray(groupData)) items.push(...groupData)
    else items.push(...extractSodaMediaList(groupData))
  }
  return {
    groups,
    items: items.length ? items : extractSodaMediaList(data),
  }
}

function extractSodaPcSearchItems(payload) {
  return extractSodaPcSearchGroups(payload).items
}

/** 搜索结果组元信息（标题/类型/描述/是否显示“查看全部”） */
function sodaSearchGroupMeta(groups) {
  return (groups || []).map((group) => ({
    id: normalizeText(group && group.id),
    displayTitle: normalizeText(group && (group.display_title || group.displayTitle)),
    displayType: normalizeText(group && (group.display_type || group.displayType)),
    description: normalizeText(group && group.description),
    bottomDesc: normalizeText(group && (group.bottom_desc || group.bottomDesc)),
    displayViewAll: !!(group && (group.display_view_all || group.displayViewAll)),
  }))
}

/** 搜索结果里的歌单卡片（客户端 entity.playlist），字段名对齐 GetPlaylistDetail/FeedPlaylistSquare */
function mapSodaSearchPlaylist(raw, index, query) {
  raw = raw || {}
  const entity = pickObject(raw.entity, raw.data, raw)
  const playlist = pickObject(entity.playlist, raw.playlist, entity.playlist_info, entity)
  const id = normalizeText(playlist.id || playlist.playlist_id || raw.id)
  if (!id) return null
  const owner = pickObject(playlist.owner, playlist.user, playlist.creator) || {}
  const stats = pickObject(playlist.stats) || {}
  const resourceCnt = pickObject(playlist.resource_cnt, playlist.resourceCnt) || {}
  return {
    id,
    name: normalizeText(playlist.title || playlist.name),
    coverUrl: qishuiFirstImageUrl(
      '~c5_375x375.jpg',
      playlist.url_cover,
      playlist.cover_url,
      playlist.cover,
    ),
    description: normalizeText(playlist.desc || playlist.description),
    trackCount: Number(playlist.count_tracks ?? playlist.countTracks ?? resourceCnt.track_cnt ?? 0) || 0,
    playCount: Number(stats.count_visible ?? stats.countVisible ?? 0) || 0,
    collectCount: Number(stats.count_collected ?? stats.countCollected ?? 0) || 0,
    creator: normalizeText(owner.nickname || owner.name || ''),
    creatorId: normalizeText(owner.id || ''),
    creatorAvatarUrl: qishuiFirstImageUrl('~c5_100x100.jpg', owner.medium_avatar_url, owner.thumb_avatar_url),
    isCollected: playlist.is_collected === true || (pickObject(playlist.state) || {}).is_collected === true,
    platform: 'soda',
    index,
    query,
  }
}

/** 搜索结果里的歌手卡片（客户端 entity.artist） */
function mapSodaSearchArtist(raw, index, query) {
  raw = raw || {}
  const entity = pickObject(raw.entity, raw.data, raw)
  const artist = pickObject(entity.artist, raw.artist, entity.artist_info, entity)
  const id = normalizeText(artist.id || artist.artist_id || raw.id)
  if (!id) return null
  const state = pickObject(artist.state) || {}
  const stats = pickObject(artist.stats) || {}
  return {
    id,
    name: normalizeText(artist.name || artist.nickname || artist.simple_display_name),
    avatarUrl: qishuiFirstImageUrl(
      '~c5_375x375.jpg',
      artist.url_avatar,
      artist.avatar_url,
      artist.medium_avatar_url,
      artist.thumb_avatar_url,
    ),
    brief: normalizeText(artist.brief || (pickObject(artist.user_brief) || {}).nickname || ''),
    followerCount: Number(stats.count_follower ?? stats.countFollower ?? artist.follower_count ?? 0) || 0,
    trackCount: Number(stats.count_track ?? stats.countTrack ?? 0) || 0,
    followed: !!(state.follow_status || state.is_following),
    collected: !!(state.is_collected || state.collected),
    userArtistType: Number(artist.user_artist_type ?? 0) || 0,
    platform: 'soda',
    index,
    query,
  }
}

/** 搜索结果里的专辑卡片（客户端 entity.album） */
function mapSodaSearchAlbum(raw, index, query) {
  raw = raw || {}
  const entity = pickObject(raw.entity, raw.data, raw)
  const album = pickObject(entity.album, raw.album, entity.album_info, entity)
  const id = normalizeText(album.id || album.album_id || raw.id)
  if (!id) return null
  const artists = pickArray(album.artists).map((item) => ({
    id: normalizeText(item && item.id),
    name: normalizeText(item && item.name),
  }))
  const stats = pickObject(album.stats) || {}
  return {
    id,
    name: normalizeText(album.name || album.title),
    coverUrl: qishuiFirstImageUrl('~c5_375x375.jpg', album.url_cover, album.cover_url, album.cover),
    artists,
    artist: artists.map((item) => item.name).filter(Boolean).join(' / '),
    company: normalizeText(album.company),
    trackCount: Number(album.count_tracks ?? album.countTracks ?? 0) || 0,
    releaseDate: Number(album.release_date ?? album.releaseDate ?? 0) || 0,
    collectCount: Number(stats.count_collected ?? stats.countCollected ?? 0) || 0,
    collected: album.is_collected === true || (pickObject(album.state) || {}).is_collected === true,
    platform: 'soda',
    index,
    query,
  }
}

/**
 * PC Web 搜索（需登录）：luna/pc/search/{search_type}
 * search_type 取值与客户端一致：all | track | artist | album | playlist
 * 游标取 result_groups[0].next_cursor（真实位置），has_more 取该组 has_more。
 */
async function handleSodaPcSearch(keywords, limit, cookieText, offset, searchType) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  const requestCount = Math.max(1, Math.min(50, Number(limit) || 8))
  offset = Math.max(0, Number(offset) || 0)
  const type = sodaNormalizeSearchType(searchType)
  const json = await sodaWebRequestJson(`/luna/pc/search/${encodeURIComponent(type)}`, sodaPcAppParams({
    q: keywords,
    cursor: String(offset),
    count: requestCount,
    search_method: 'input',
  }, cookie), cookie, {
    bases: [QISHUI_WEB_PC_API_BASE],
    noDefaultParams: true,
    sessionOnly: true,
    pcApp: true,
    timeoutMs: 8500,
  })
  const { groups, items } = extractSodaPcSearchGroups(json)
  const typed = (mapper) => items.map((item, index) => mapper(item, index, keywords)).filter(Boolean)
  const songs = mapSodaMediaList(items, keywords).slice(0, limit)
  const playlists = typed(mapSodaSearchPlaylist).slice(0, limit)
  const artists = typed(mapSodaSearchArtist).slice(0, limit)
  const albums = typed(mapSodaSearchAlbum).slice(0, limit)
  // 游标在组上；同页多组时取第一组的游标（客户端也按组翻页）
  const firstGroup = groups[0] || {}
  const nextCursor = normalizeText(firstGroup.next_cursor || firstGroup.nextCursor || '')
  const hasMoreFlag = firstGroup.has_more != null ? firstGroup.has_more : firstGroup.hasMore
  const pageCount = Math.max(songs.length, playlists.length, artists.length, albums.length)
  const hasMore =
    typeof hasMoreFlag === 'boolean'
      ? hasMoreFlag
      : Number(hasMoreFlag) > 0 || (!!nextCursor && nextCursor !== String(offset)) || songs.length >= limit
  return {
    source: 'pc-session',
    searchType: type,
    songs,
    playlists,
    artists,
    albums,
    groups: sodaSearchGroupMeta(groups),
    rawCount: items.length,
    offset,
    nextOffset: offset + pageCount,
    nextCursor,
    hasMore,
  }
}

/** 火山引擎公开目录搜索（无需登录）；窗口一次取足后在本地排序集合上分页 */
async function handleSodaPublicSearch(keywords, limit, cookieText, offset) {
  offset = Math.max(0, Number(offset) || 0)
  const requestLimit = Math.min(100, Math.max(offset + (Number(limit) * 3 || 0), 36))
  const url = urlWithParams(QISHUI_PUBLIC_SEARCH_URL, {
    keyword: keywords,
    search_type: 'music',
    limit: requestLimit,
    real_offset: 0,
    search_source: 'qishui',
  })
  const json = await requestJson(url, { timeoutMs: 8000, headers: QISHUI_PUBLIC_HEADERS })
  const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : []
  const mappedSongs = list.map((item, index) => mapSodaPublicItem(item, index, keywords)).filter(Boolean)
  const rankedSongs = rankSodaPublicSongs(mappedSongs, keywords, requestLimit)
  const songs = rankedSongs.slice(offset, offset + limit)
  return {
    source: 'public-catalog',
    songs,
    rawCount: list.length,
    offset,
    nextOffset: offset + songs.length,
    // 原版等价判断（移植时弱化为 songs.length>=limit，会在候选集末尾多发空页请求）：
    // 本页已满 且 （本地排序集还有剩余 或 上游确实拉满了候选窗口——上游没给满窗口说明该词候选已耗尽，
    // 不再凭 requestLimit<100 乐观猜"可能还有"，避免前端按 hasMore 探测到必空的下页）
    hasMore:
      songs.length >= limit &&
      (offset + songs.length < rankedSongs.length || (requestLimit < 100 && list.length >= requestLimit)),
    message: songs.length ? '' : '汽水公开搜索暂时没有返回匹配结果。',
  }
}

/** 统一搜索入口：登录优先 PC 会话搜索，失败/未登录回退公开目录（结果缓存 2 分钟） */
async function handleSodaSearch(keywords, limit, cookieText, offset, searchType) {
  keywords = normalizeText(keywords)
  limit = Math.max(1, Math.min(50, Number(limit) || 20))
  offset = Math.max(0, Number(offset) || 0)
  const type = sodaNormalizeSearchType(searchType)
  if (!keywords) return { source: 'none', songs: [], playlists: [], artists: [], albums: [], message: '缺少关键词' }
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const cacheKey =
    keywords.toLowerCase() + '|' + limit + '|' + offset + '|' + type + '|' + (loggedIn ? sodaCookieFingerprint(cookieText) : 'public')
  return sodaSearchCache.wrap(cacheKey, 2 * 60 * 1000, async () => {
    let pcSearchError = ''
    if (loggedIn) {
      try {
        return await handleSodaPcSearch(keywords, limit, cookieText, offset, type)
      } catch (err) {
        pcSearchError = (err && err.message) || String(err)
      }
    }
    const fallback = await handleSodaPublicSearch(keywords, limit, cookieText, offset)
    if (pcSearchError) fallback.pcSearchError = pcSearchError
    return fallback
  })
}

/**
 * 公开目录 lyric_info 的翻译提取：translated_lyric/translation/tlyric 文本字段优先
 * （经 sodaLyricTextFromNode 展开 lyric_entity 并拒收 URL 形态），其次 lang_translations[]/translations[]
 * 数组形态（与搜索路径 mapSodaMedia 的提取规则一致）。
 */
function extractSodaDetailTranslation(lyricInfo) {
  const direct = sodaLyricTextFromNode(lyricInfo.translated_lyric || lyricInfo.translation || lyricInfo.tlyric || '')
  if (direct) return direct
  for (const item of pickArray(lyricInfo.lang_translations, lyricInfo.translations)) {
    const entity = pickObject(item && item.lyric_entity, item)
    const text = normalizeLyricBody(entity.content || (item && (item.content || item.lyric || item.lyric_text)))
    if (text) return text
  }
  return ''
}

/** 公开目录单曲详情（歌词兜底数据源之一，30 分钟缓存） */
async function fetchSodaPublicDetail(id) {
  id = normalizeText(id)
  if (!id) return null
  return sodaPublicDetailCache.wrap(id, 30 * 60 * 1000, async () => {
    const url = urlWithParams(QISHUI_PUBLIC_CONTENTS_URL, {
      sources: 'qishui',
      need_author: true,
      need_album: true,
      need_ugc: true,
      need_stat: true,
      item_ids: id,
    })
    const json = await requestJson(url, { timeoutMs: 8000, headers: QISHUI_PUBLIC_HEADERS })
    const item = json && json.data && Array.isArray(json.data.list) ? json.data.list[0] : null
    if (!item) return null
    // lyric_info 兼容多形态：复用 sodaLyricTextFromNode（自动展开 lyric_entity，并拒收
    // 「URL 形态歌词」——那种正文需二次拉取，直接入库会把 URL 当 LRC 污染 30 分钟缓存）；
    // 纯文本字段作后备，末尾再拦一次 URL 兜底。
    const lyricInfo = pickObject(item.lyric_info, item.lyric)
    let lyric = sodaLyricTextFromNode(lyricInfo)
      || normalizeLyricBody(lyricInfo.lyric_text || lyricInfo.content || lyricInfo.lyric || '')
    if (/^https?:\/\//i.test(lyric)) lyric = ''
    const tlyric = extractSodaDetailTranslation(lyricInfo)
    cacheSodaLyric(id, lyric, tlyric, 'soda-public-detail')
    return { item, lyric, tlyric }
  })
}

// ─────────────────────────── 个性化 feed 与账号媒体库 ───────────────────────────

/** 个性化推荐 feed（需登录）：song-tab 两路径尝试 + 媒体库回退；cursor 透传上游翻页，回程透出 nextCursor/hasMore */
async function fetchSodaWebFeedSongs(cookieText, limit, cursor, opts) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    return { source: 'none', songs: [], error: 'QISHUI_COOKIE_REQUIRED' }
  }
  limit = Math.max(1, Math.min(50, Number(limit) || 8))
  cursor = normalizeText(cursor)
  opts = opts && typeof opts === 'object' ? opts : {}
  // 场景模式用的偏好（客户端 FeedSongTab 的 feed_preference）：
  //   服务端场景 → { scene_mode_id }；客户端内置的两个 → { preference_mode: 'familiar'|'fresh' }
  const sceneModeId = Number(opts.sceneModeId) || 0
  const preferenceMode = normalizeText(opts.preferenceMode)
  // 「已听过的曲目」：客户端靠它做分页（响应里没有 cursor，只有 has_more 恒真），
  // 我们把调用方传来的已听 id 原样转成 played_media，语义与客户端一致。
  const playedIds = Array.isArray(opts.playedIds) ? opts.playedIds.map((id) => normalizeText(id)).filter(Boolean).slice(0, 60) : []
  const cacheKey =
    'web-feed|' + sodaCookieFingerprint(cookie) + '|' + limit + '|' + (cursor || 'head') +
    '|s' + sceneModeId + '|p' + preferenceMode + '|x' + playedIds.length
  return sodaFeedCache.wrap(cacheKey, 90 * 1000, async () => {
    // 客户端走 POST + 结构化 body；实测 GET（cursor/cnt/count）一律返回空 body，
    // 这正是旧实现一直退到「媒体库拼凑」的原因。
    const feedPreference = sceneModeId ? { scene_mode_id: sceneModeId } : preferenceMode ? { preference_mode: preferenceMode } : undefined
    const body = {
      is_first_request: !cursor && !playedIds.length,
      is_did_first_request: false,
      played_media: playedIds.map((id) => ({ type: 'track', id })),
      ...(feedPreference ? { feed_preference: feedPreference } : {}),
    }
    let lastErr = null
    for (const path of ['/luna/pc/feed/song-tab', '/luna/feed/song-tab']) {
      try {
        const json = await sodaPcPostJson(path, body, cookie, {
          errorCode: 'SODA_WEB_FEED_FAILED',
          timeoutMs: 9000,
        })
        const rawItems = extractSodaMediaList(json)
        const songs = mapSodaMediaList(rawItems, 'web-feed').slice(0, limit)
        if (songs.length) {
          return {
            source: 'song-tab',
            songs,
            rawCount: rawItems.length,
            // 客户端把 has_more 当恒真：真正的「下一页」是带着 played_media 再请求一次
            hasMore: true,
            cursorless: true,
          }
        }
        lastErr = new Error('SODA_WEB_FEED_EMPTY')
      } catch (err) {
        lastErr = err
      }
    }
    if (cursor || sceneModeId || preferenceMode) {
      // 场景模式/翻页失败时如实返回空页，不回退媒体库（否则场景电台里会混进「我喜欢/最近播放」）
      return {
        source: 'song-tab',
        songs: [],
        rawCount: 0,
        hasMore: false,
        error: (lastErr && lastErr.message) || 'SODA_WEB_FEED_EMPTY',
      }
    }
    try {
      const fallback = await fetchSodaWebLibraryFeedFallback(cookie, limit)
      if (fallback && fallback.songs && fallback.songs.length) return fallback
    } catch (fallbackErr) {
      lastErr = fallbackErr || lastErr
    }
    return { source: 'none', songs: [], rawCount: 0, error: (lastErr && lastErr.message) || '' }
  })
}

/** feed 不可用时：用「我喜欢 + 最近播放 + 前几个歌单」拼一份推荐替代 */
async function fetchSodaWebLibraryFeedFallback(cookieText, limit) {
  const cookie = normalizeSodaCookieInput(cookieText)
  limit = Math.max(1, Math.min(50, Number(limit) || 8))
  const library = await fetchSodaWebLibrary(cookie)
  let songs = dedupeSodaSongs([].concat(library.likedTracks || []).concat(library.recentTracks || []))
  const detailCandidates = []
    .concat(library.likedCard ? [library.likedCard] : [])
    .concat((library.playlists || []).filter((pl) => pl && pl.id))
  for (let i = 0; songs.length < limit && i < detailCandidates.length && i < 4; i += 1) {
    const pl = detailCandidates[i]
    if (!pl || !pl.id) continue
    try {
      const detail = await fetchSodaWebPlaylistTracks(pl.id, cookie, { limit: Math.max(limit, 12), offset: 0 })
      songs = dedupeSodaSongs(songs.concat(detail && detail.tracks ? detail.tracks : []))
    } catch {
      /* 单个歌单失败不阻塞整体回退 */
    }
  }
  songs = songs.slice(0, limit)
  return {
    source: 'web-library-fallback',
    songs,
    rawCount: songs.length,
    fallback: true,
    error: songs.length ? '' : ((library.errors || []).join('; ') || 'SODA_WEB_FEED_EMPTY'),
  }
}

function sodaPlaylistLikeName(name) {
  // 「我喜欢」类歌单判定：喜欢/收藏/liked/favorite
  return /喜欢|收藏|favorite|liked/i.test(String(name || ''))
}

function sodaPlaylistPrimaryLikeName(name) {
  return /favorite|liked/i.test(String(name || '')) || String(name || '').includes('喜欢')
}

function sodaPlaylistIdFromItem(item) {
  item = item || {}
  return normalizeText(
    item.playlist_id || item.playlistId || item.collection_id || item.collectionId || item.id || item.item_id || item.resource_id || item.object_id || item.server_id || '',
  )
}

function sodaPlaylistNameFromItem(item) {
  item = item || {}
  return normalizeText(item.title || item.public_title || item.publicTitle || item.name || item.display_title || item.display_name || item.playlist_name || item.collection_name || '')
}

function sodaPlaylistCoverFromItem(item) {
  item = item || {}
  return qishuiFirstImageUrl('~c5_300x300.jpg', item.cover_url, item.cover, item.cover_uri, item.image, item.image_url, item.url_cover, item.icon, item.avatar)
}

function sodaPlaylistTrackCountFromItem(item) {
  item = item || {}
  return Number(item.count_tracks || item.track_count || item.media_count || item.count || item.total || item.song_count || 0) || 0
}

/** 从任意响应里挖出歌单卡片（创建的 + 收藏的） */
function extractSodaPlaylistCards(payload) {
  const data = (payload && payload.data) || payload || {}
  const out = []
  const seen = new Set()
  function visit(node, depth) {
    if (!node || depth > 6) return
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1))
      return
    }
    if (typeof node !== 'object') return
    const candidates = [
      node.playlist,
      node.playlist_info,
      node.collection,
      node.collect_playlist,
      node.fav_playlist,
      node.resource,
      node,
    ].filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    candidates.forEach((item) => {
      const id = sodaPlaylistIdFromItem(item)
      const name = sodaPlaylistNameFromItem(item)
      const count = sodaPlaylistTrackCountFromItem(item)
      const type = normalizeText(item.type || item.card_type || item.resource_type || node.type || '')
      // 客户端 Sidebar.vue 按 playlist.type 区分入口：1=我喜欢的音乐，4=抖音收藏的音乐，
      // 2/3/11=创建的歌单。这个数字必须原样透出，否则前端无法把音乐库入口对上真实歌单。
      const playlistType =
        Number(
          item.type ?? item.playlist_type ?? item.playlistType ?? item.resource_type ?? item.resourceType ?? node.type ?? 0,
        ) || 0
      if (!id || !name) return
      if (!count && !sodaPlaylistLikeName(name) && !/playlist|collection|fav|songlist|歌单/i.test(type + ' ' + name)) return
      const key = id + '|' + name
      if (seen.has(key)) return
      seen.add(key)
      out.push({
        id,
        name,
        cover: sodaPlaylistCoverFromItem(item),
        trackCount: count,
        playCount: Number(item.play_count || item.playCount || 0) || 0,
        creator: normalizeText(
          item.creator_name || item.author_name || item.owner_name || (item.owner && (item.owner.nickname || item.owner.public_name)) || '汽水音乐',
        ),
        subscribed: true,
        owned: false,
        shelfPane: '',
        virtual: false,
        isLiked: sodaPlaylistLikeName(name),
        // 客户端歌单类型（1 我喜欢 / 4 抖音收藏 / 2|3|11 自建）
        playlistType,
      })
    })
    Object.keys(node).slice(0, 80).forEach((key) => visit(node[key], depth + 1))
  }
  visit(data, 0)
  return out
}

/** 构造虚拟歌单（我喜欢 / 最近播放 / 推荐 feed） */
function buildSodaVirtualPlaylist(id, name, songs, extra = {}) {
  songs = Array.isArray(songs) ? songs : []
  return {
    id,
    name,
    cover: extra.cover || songs.map((song) => song && song.coverUrl).find(Boolean) || '',
    trackCount: Number(extra.trackCount != null ? extra.trackCount : songs.length) || 0,
    creator: extra.creator || '汽水音乐',
    subscribed: !!extra.subscribed,
    owned: !!extra.owned,
    shelfPane: extra.shelfPane || '',
    virtual: true,
    songs,
  }
}

/** 账号媒体库聚合（90s 缓存/每 cookie）：
 *  我创建的歌单 + 收藏混合卡片 + 最近播放 + 我喜欢轨道 */
async function fetchSodaWebLibrary(cookieText) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    return { loggedIn: false, playlists: [], likedCard: null, likedTracks: [], recentTracks: [], errors: ['QISHUI_COOKIE_REQUIRED'] }
  }
  const cacheKey = 'library|' + sodaCookieFingerprint(cookie)
  return sodaWebLibraryCache.wrap(cacheKey, 90 * 1000, async () => {
    const playlists = []
    const likedTracks = []
    const recentTracks = []
    const cardTracks = []
    const errors = []
    const tryRead = async (label, apiPath, params, requestOpts = {}) => {
      try {
        const json = await sodaWebRequestJson(apiPath, params || {}, cookie, Object.assign({
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          timeoutMs: 6500,
        }, requestOpts))
        if (/created|collection|collect/i.test(label)) {
          extractSodaPlaylistCards(json).forEach((pl) => {
            const primaryLike = sodaPlaylistPrimaryLikeName(pl && pl.name)
            if (/created/i.test(label) || primaryLike) {
              pl.shelfPane = 'mine'
              pl.owned = true
              pl.subscribed = false
            } else {
              pl.shelfPane = 'fav'
              pl.owned = false
              pl.subscribed = true
            }
            playlists.push(pl)
          })
        }
        const songs = mapSodaMediaList(extractSodaMediaList(json), label)
        if (/recent/i.test(label)) recentTracks.push(...dedupeSodaSongs(songs))
        else if (/liked|favorite|collect/i.test(label)) likedTracks.push(...dedupeSodaSongs(songs))
        else cardTracks.push(...dedupeSodaSongs(songs))
        return json
      } catch (err) {
        if (!requestOpts.optional) errors.push(label + ':' + ((err && err.message) || 'failed'))
        return null
      }
    }

    const pcRequestOpts = { pcApp: true }
    const meJson = await tryRead('me', '/luna/pc/me', sodaPcAppParams({}, cookie), pcRequestOpts)
    const meData = (meJson && meJson.data) || meJson || {}
    const profile = sodaProfileFromMeData(meData)
    const userId = profile.userId

    await Promise.all([
      userId
        ? tryRead('created', '/luna/pc/user/playlist', sodaPcAppParams({ user_id: userId, cursor: '', count: 50 }, cookie), pcRequestOpts)
        : Promise.resolve(null),
      tryRead('collection', '/luna/pc/me/collection/mixed', sodaPcAppParams({ cursor: '', count: 50 }, cookie), Object.assign({ optional: true }, pcRequestOpts)),
      tryRead('recent', '/luna/pc/me/recently-played-media', sodaPcAppParams({ cursor: '', count: 50 }, cookie), Object.assign({ optional: true }, pcRequestOpts)),
    ])
    if (!userId) errors.push('me:missing-user-id')

    const uniquePlaylists = []
    const seenPlaylists = new Set()
    playlists.forEach((pl) => {
      if (!pl || !pl.id || seenPlaylists.has(pl.id)) return
      seenPlaylists.add(pl.id)
      uniquePlaylists.push(pl)
    })

    const likedCard =
      uniquePlaylists.find((pl) => pl && pl.isLiked && sodaPlaylistPrimaryLikeName(pl.name)) ||
      uniquePlaylists.find((pl) => pl && pl.isLiked) ||
      null
    return {
      loggedIn: true,
      playlists: uniquePlaylists,
      likedCard,
      likedTracks: dedupeSodaSongs(likedTracks.concat(cardTracks.filter((song) => false))),
      recentTracks: dedupeSodaSongs(recentTracks),
      cardTracks: dedupeSodaSongs(cardTracks),
      profile,
      errors,
    }
  })
}

/** 用户资料（luna/pc/me 数据 → 统一 profile 结构） */
function sodaProfileFromUser(user) {
  user = user && typeof user === 'object' ? user : {}
  const nickname = normalizeText(
    user.nickname || user.nick_name || user.nickName || user.display_name || user.displayName || user.name ||
      user.public_name || user.publicName || user.douyin_id || '',
  )
  const userId = normalizeText(user.id || user.user_id || user.userId || user.uid || user.sec_uid || user.secUid || user.open_id || '')
  const avatar = qishuiFirstImageUrl(
    '~c5_300x300.jpg',
    user.larger_avatar_url,
    user.medium_avatar_url,
    user.avatar_url,
    user.avatarUrl,
    user.avatar,
    user.user_avatar,
    user.pic,
    user.icon,
  )
  return {
    userId,
    nickname,
    avatar,
    douyinId: normalizeText(user.douyin_id || user.unique_id || user.short_id || ''),
    profileReady: !!(userId || nickname || avatar),
  }
}

function sodaProfileFromMeData(meData) {
  const data = (meData && meData.data) || meData || {}
  const user = pickObject(data.my_info, data.myInfo, data.user, data.user_info, data.userInfo, data.account, data.me, data)
  const profile = sodaProfileFromUser(user)
  if (!profile.userId) profile.userId = normalizeText(data.user_id || data.userId || data.uid || data.id || '')
  if (!profile.nickname) profile.nickname = normalizeText(data.nickname || data.nick_name || data.name || data.douyin_id || '')
  if (!profile.avatar) {
    profile.avatar = qishuiFirstImageUrl(
      '~c5_300x300.jpg',
      data.larger_avatar_url,
      data.medium_avatar_url,
      data.avatar_url,
      data.avatar,
      data.pic,
    )
  }
  Object.assign(profile, sodaMembershipFromData(data))
  profile.profileReady = !!(profile.userId || profile.nickname || profile.avatar)
  return profile
}

/** 会员状态查询（luna/pc/me，60s 内按 cookie 指纹缓存） */
async function fetchSodaPlaybackMembership(cookieText) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    return sodaUnknownMembership('QISHUI_COOKIE_REQUIRED')
  }
  const cacheKey = 'membership|' + sodaCookieFingerprint(cookie)
  return sodaMembershipCache.wrap(cacheKey, sodaMembershipCacheTtlMs, async () => {
    try {
      const json = await sodaWebRequestJson('/luna/pc/me', sodaPcAppParams({}, cookie), cookie, {
        bases: [QISHUI_WEB_PC_API_BASE],
        noDefaultParams: true,
        sessionOnly: true,
        pcApp: true,
        timeoutMs: 6500,
      })
      const data = (json && json.data) || json || {}
      const profile = sodaProfileFromMeData(data)
      // profile 三要素随缓存对象一起返回：/api/soda/status 直接复用，
      // 不必对同一端点 /luna/pc/me 再串行打一次（缓存 TTL 仅 10s，头像/昵称陈旧度可忽略）
      return sodaApplyMembershipObservation(cacheKey, {
        membershipKnown: !!profile.membershipKnown,
        vipType: Number(profile.vipType) || 0,
        vipLevel: profile.vipLevel || 'none',
        isVip: !!profile.isVip,
        isSvip: !!profile.isSvip,
        vipLabel: profile.vipLabel || '无VIP',
        expiresAt: Number(profile.expiresAt) || 0,
        sessionValidated: !!profile.profileReady,
        userId: profile.userId || '',
        nickname: profile.nickname || '',
        avatar: profile.avatar || '',
        entitlementSource: 'official-pc-me',
      })
    } catch (err) {
      return sodaApplyMembershipObservation(cacheKey, sodaUnknownMembership((err && err.message) || 'SODA_MEMBERSHIP_CHECK_FAILED'))
    }
  })
}

/** 歌单详情（真实歌单 id）：游标式增量翻页 + 会话级缓存 */
async function fetchSodaWebPlaylistTracks(playlistId, cookieText, opts = {}) {
  const cookie = normalizeSodaCookieInput(cookieText)
  const id = normalizeText(String(playlistId || '').replace(/^qishui:/i, ''))
  if (!sodaCookieHasLogin(cookie) || !id) {
    return { id, name: '', tracks: [], total: 0, error: 'QISHUI_COOKIE_REQUIRED' }
  }
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 50))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const cacheKey = 'playlist|' + sodaCookieFingerprint(cookie) + '|' + id + '|' + limit + '|' + offset
  return sodaWebPlaylistCache.wrap(cacheKey, 90 * 1000, async () => {
    const targetCount = offset + limit
    const cursorKey = sodaCookieFingerprint(cookie) + '|' + id
    let cursorState = sodaWebPlaylistCursorCache.get(cursorKey)
    if (!cursorState || Date.now() - cursorState.updatedAt > 10 * 60 * 1000) {
      cursorState = { rawItems: [], cursor: '', hasMore: true, lastJson: null, updatedAt: Date.now(), promise: null }
      sodaWebPlaylistCursorCache.set(cursorKey, cursorState)
    }
    // 不足目标数量且上游还有更多时继续翻页（并发请求共享同一 promise）
    while (cursorState.rawItems.length < targetCount && cursorState.hasMore) {
      if (!cursorState.promise) {
        cursorState.promise = sodaWebRequestJson('/luna/pc/playlist/detail', sodaPcAppParams({
          playlist_id: id,
          cursor: cursorState.cursor,
          count: Math.min(100, Math.max(1, targetCount - cursorState.rawItems.length)),
        }, cookie), cookie, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          timeoutMs: 9000,
        }).then((json) => {
          cursorState.lastJson = json
          const pageRawItems = extractSodaMediaList(json)
          cursorState.rawItems.push(...pageRawItems)
          const pageData = (json && json.data) || json || {}
          const nextCursor = normalizeText(pageData.next_cursor || pageData.nextCursor || (json && json.next_cursor) || '')
          cursorState.cursor = nextCursor
          cursorState.hasMore =
            !!(pageData.has_more || pageData.hasMore || (json && json.has_more)) && !!nextCursor
          cursorState.updatedAt = Date.now()
          if (!pageRawItems.length) cursorState.hasMore = false
        }).finally(() => {
          cursorState.promise = null
        })
      }
      await cursorState.promise
    }
    while (sodaWebPlaylistCursorCache.size > 12) sodaWebPlaylistCursorCache.delete(sodaWebPlaylistCursorCache.keys().next().value)

    const allRawItems = cursorState.rawItems
    const lastJson = cursorState.lastJson
    const upstreamHasMore = cursorState.hasMore
    const data = (lastJson && lastJson.data) || lastJson || {}
    const meta = pickObject(data.playlist, lastJson && lastJson.playlist, data.playlist_info, lastJson && lastJson.playlist_info)
    const playlistCover = sodaPlaylistCoverFromItem(meta)
    const allTracks = mapSodaMediaList(allRawItems, 'web-playlist').map((song) =>
      song && !song.coverUrl && playlistCover ? Object.assign({}, song, { coverUrl: playlistCover }) : song,
    )
    const tracks = allTracks.slice(offset, offset + limit)
    const total =
      Number(meta.count_tracks || meta.track_count || data.total || data.count || data.total_num || allRawItems.length || allTracks.length) ||
      allTracks.length
    return {
      id,
      name: sodaPlaylistNameFromItem(meta) || '汽水歌单',
      coverUrl: playlistCover,
      trackCount: total,
      tracks,
      total,
      offset,
      nextOffset: offset + tracks.length,
      hasMore: upstreamHasMore || offset + tracks.length < total,
      rawCount: allRawItems.length,
    }
  })
}

// ─────────────────────────── 写操作（喜欢/收藏/加歌/最近播放）───────────────────────────

function sodaCollectionIds(value) {
  const values = Array.isArray(value) ? value : String(value == null ? '' : value).split(',')
  const seen = new Set()
  const ids = []
  values.forEach((item) => {
    const id = normalizeText(
      item && typeof item === 'object' ? item.id || item.trackId || item.track_id || item.providerSongId : item,
    )
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  })
  return ids
}

/** 布尔参数宽容解析（接受 boolean / 0|1 / 'false' 等字符串） */
function sodaWriteEnabled(value) {
  if (value === false || value === 0) return false
  return !/^(?:false|0|off|no)$/i.test(normalizeText(value))
}

/** 批量检查是否已喜欢：基于我喜欢歌单内容比对 */
async function handleSodaCheckTracksLiked(trackIds, cookieText) {
  const ids = sodaCollectionIds(trackIds)
  if (!ids.length) return { liked: {}, complete: true }
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    const err = new Error('QISHUI_COOKIE_REQUIRED')
    err.code = 'QISHUI_COOKIE_REQUIRED'
    throw err
  }
  const library = await fetchSodaWebLibrary(cookie)
  let knownTracks = dedupeSodaSongs(library.likedTracks || [])
  let complete = false
  if (library.likedCard && library.likedCard.id) {
    // 审计确认：我喜欢歌单常超 50 首，此前只拉单页 → 超出的红心恒判未喜欢。
    // 改为游标分页全量拉取（复用 fetchSodaWebPlaylistTracks 的游标增量翻页），
    // complete 只在成功遍历完整个歌单时置 true；安全上限 40 页（2000 首），触顶如实上报不完整。
    const MAX_LIKED_PAGES = 40
    let fetched = 0
    for (let page = 0; page < MAX_LIKED_PAGES; page += 1) {
      const detail = await fetchSodaWebPlaylistTracks(library.likedCard.id, cookie, { limit: 50, offset: fetched }).catch(() => null)
      if (!detail || !Array.isArray(detail.tracks)) break
      knownTracks = dedupeSodaSongs(knownTracks.concat(detail.tracks))
      fetched += detail.tracks.length
      // 空页即停止（若上游仍声称有更多，则无法确认完整，complete 维持 false）
      if (!detail.tracks.length) break
      if (!detail.hasMore) {
        complete = true
        break
      }
    }
  }
  const knownLiked = new Set(knownTracks.map((song) => String(song.id || '')).filter(Boolean))
  const liked = {}
  ids.forEach((id) => {
    liked[id] = knownLiked.has(id)
  })
  return { liked, complete, checkedCount: knownLiked.size }
}

/** 喜欢/取消喜欢：luna/pc/me/collection/media[/delete] */
async function handleSodaSetTrackLiked(trackId, liked, cookieText) {
  const id = normalizeText(trackId)
  if (!id) throw new Error('缺少汽水音乐歌曲 id')
  liked = sodaWriteEnabled(liked)
  await sodaPcPostJson(
    liked ? '/luna/pc/me/collection/media' : '/luna/pc/me/collection/media/delete',
    { media: [{ type: 'track', id }], scene: '' },
    cookieText,
    { errorCode: liked ? 'SODA_LIKE_FAILED' : 'SODA_UNLIKE_FAILED' },
  )
  invalidateSodaLibraryCaches()
  return { id, liked }
}

/** 收藏/取消收藏歌单 */
async function handleSodaSetPlaylistCollected(playlistId, collected, cookieText) {
  const id = normalizeText(String(playlistId || '').replace(/^qishui:/i, ''))
  if (!id) throw new Error('缺少汽水音乐歌单 id')
  collected = sodaWriteEnabled(collected)
  await sodaPcPostJson(
    collected ? '/luna/pc/me/collection/playlist' : '/luna/pc/me/collection/playlist/delete',
    { playlist_ids: [id] },
    cookieText,
    { errorCode: collected ? 'SODA_PLAYLIST_COLLECT_FAILED' : 'SODA_PLAYLIST_UNCOLLECT_FAILED' },
  )
  invalidateSodaLibraryCaches()
  return { id, collected }
}

/**
 * 创建歌单：POST /luna/pc/me/playlist（客户端 CreatePlaylist）。
 * 注：老代码里曾断言「上游不存在创建歌单端点」，那是误判——客户端 IDL 明确有
 * CreatePlaylistRequest{name,is_private,track_ids,media} → /luna/pc/me/playlist。
 */
async function handleSodaCreatePlaylist(name, isPrivate, cookieText) {
  const trimmed = normalizeText(name)
  if (!trimmed) throw new Error('缺少歌单名称')
  const json = await sodaPcPostJson(
    '/luna/pc/me/playlist',
    { name: trimmed, is_private: !!isPrivate },
    cookieText,
    { errorCode: 'SODA_PLAYLIST_CREATE_FAILED' },
  )
  invalidateSodaLibraryCaches()
  const playlist = pickObject(json && json.playlist, json && json.data && json.data.playlist, json && json.data) || {}
  return {
    id: normalizeText(playlist.id || playlist.playlist_id || playlist.playlistId),
    name: normalizeText(playlist.title || playlist.name) || trimmed,
    isPrivate: !!isPrivate,
    created: true,
  }
}

/** 删除歌单：POST /luna/pc/me/playlist/delete（客户端 MDeletePlaylists） */
async function handleSodaDeletePlaylist(playlistId, cookieText) {
  const id = normalizeText(String(playlistId || '').replace(/^qishui:/i, ''))
  if (!id) throw new Error('缺少汽水音乐歌单 id')
  await sodaPcPostJson(
    '/luna/pc/me/playlist/delete',
    { playlist_ids: [id] },
    cookieText,
    { errorCode: 'SODA_PLAYLIST_DELETE_FAILED' },
  )
  invalidateSodaLibraryCaches()
  return { id, deleted: true }
}

// ─────────────────── 听歌模式（场景电台 / 探索更多）───────────────────

/**
 * 电台拉歌（客户端 FeedRadioTracks → POST /luna/pc/feed/radio/tracks）。
 * flow_type / trigger_info 原本藏在卡片的 `style.link`（luna://luna.com/play_source?…）里，
 * 客户端就是从这个 link 上现取的，这里沿用同一取法。
 */
async function handleSodaRadioTracks(cookieText, radioId, opts) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  const id = normalizeText(radioId)
  if (!id) throw new Error('缺少电台 id')
  opts = opts && typeof opts === 'object' ? opts : {}
  let flowType = Number(opts.flowType) || 0
  let triggerInfo = normalizeText(opts.triggerInfo)
  if (!flowType || !triggerInfo) {
    try {
      const link = new URL(normalizeText(opts.link))
      if (!flowType) flowType = Number(link.searchParams.get('flow_type')) || 2
      if (!triggerInfo) triggerInfo = link.searchParams.get('trigger_info') || ''
    } catch {
      /* link 非法就用默认值 */
    }
  }
  if (!flowType) flowType = 2
  const json = await sodaPcPostJson(
    '/luna/pc/feed/radio/tracks',
    { radio_id: id, cursor: normalizeText(opts.cursor), flow_type: flowType, trigger_info: triggerInfo },
    cookie,
    { errorCode: 'SODA_RADIO_TRACKS_FAILED', timeoutMs: 9000 },
  )
  const songs = mapSodaMediaList(extractSodaMediaList(json), 'soda-radio')
  const data = (json && json.data) || json || {}
  return {
    songs,
    nextCursor: normalizeText(data.next_cursor || data.nextCursor),
    hasMore: !!(data.has_more || data.hasMore),
  }
}
/**
 * 场景列表（客户端 FeedMode → GET /luna/pc/feed/mode）。
 * 客户端只取 `feed_mode_block[0].feed_mode` 的前 6 个，并在最前面插入两个内置项
 * （熟悉模式 familiar / 新鲜模式 fresh：没有 scene_mode_id，改用 preference_mode 走同一个拉流接口）。
 */
async function handleSodaFeedMode(cookieText, opts) {
  opts = opts && typeof opts === 'object' ? opts : {}
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  return sodaSceneCache.wrap('feed-mode|' + sodaCookieFingerprint(cookie) + '|' + sodaSceneDayBucket() + (opts.full ? '|full' : ''), 24 * 60 * 60 * 1000, async () => {
    const json = await sodaWebRequestJson('/luna/pc/feed/mode', sodaPcAppParams({}, cookie), cookie, {
      bases: [QISHUI_WEB_PC_API_BASE],
      noDefaultParams: true,
      sessionOnly: true,
      pcApp: true,
      timeoutMs: 9000,
    })
    const block = pickArray(json && json.feed_mode_block, json && json.feedModeBlock)[0] || {}
    const rawModes = pickArray(block.feed_mode, block.feedMode)
    const modes = rawModes
      .map((item) => {
        const scene = pickObject(item && item.entity && item.entity.feed_scene_mode) || {}
        const text = normalizeText(item && item.text)
        if (!text) return null
        return {
          text,
          sceneModeId: Number(scene.scene_mode_id ?? scene.sceneModeId) || 0,
          subQueueType: normalizeText(scene.sub_queue_type || scene.subQueueType),
          iconUrl: sodaTemplatedImageUrl(pickObject(item && item.url_info, item && item.urlInfo), '~c5_100x100.jpg'),
          cutoverToast: normalizeText(item && item.cutover_toast),
        }
      })
      .filter(Boolean)
      // 客户端「常用模式」只取前 6 个；手机端「探索页·模式探索」是整张网格，所以支持 full 全量
      .slice(0, opts.full ? 999 : 6)
    // 客户端内置两项排最前（src/services/queue/items/feedmode.ts 的 feedModeTop2）
    const top2 = [
      { text: '熟悉模式', sceneModeId: 0, subQueueType: 'familiar', preferenceMode: 'familiar', iconUrl: '' },
      { text: '新鲜模式', sceneModeId: 0, subQueueType: 'fresh', preferenceMode: 'fresh', iconUrl: '' },
    ]
    return { title: normalizeText(block.title) || '场景音乐', modes: top2.concat(modes) }
  })
}

/**
 * 探索更多新模式（客户端 DiscoverView + DiscoverMix）。
 * blocks 里挑 `discover_playlist_mix` 摊平成卡片；翻页用 DiscoverMix 并把已曝光过的
 * inner_block_id 回传去重（客户端同款）。
 */
async function handleSodaDiscoverMix(cookieText, opts) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  opts = opts && typeof opts === 'object' ? opts : {}
  const exposure = Array.isArray(opts.exposure) ? opts.exposure.map((id) => normalizeText(id)).filter(Boolean).slice(0, 60) : []
  const useMix = !!normalizeText(opts.cursor) || exposure.length > 0
  const cacheKey = 'discover|' + sodaCookieFingerprint(cookie) + '|' + sodaSceneDayBucket() + '|' + (useMix ? 'mix|x' + exposure.length : 'view')
  return sodaSceneCache.wrap(cacheKey, 24 * 60 * 60 * 1000, async () => {
    let blocks = []
    if (useMix) {
      const json = await sodaPcPostJson(
        '/luna/pc/discover/mix',
        {
          block_type: 'discover_playlist_mix',
          sub_channel_id: -2,
          exposure_radio_list: exposure,
          ...(normalizeText(opts.cursor) ? { cursor: normalizeText(opts.cursor) } : {}),
        },
        cookie,
        { errorCode: 'SODA_DISCOVER_MIX_FAILED', timeoutMs: 9000 },
      )
      blocks = pickArray(json && json.blocks, json && json.inner_block, json && json.innerBlock)
    } else {
      const json = await sodaPcPostJson(
        '/luna/pc/discover',
        { first_request: true, pc_new_discover_request: true },
        cookie,
        { errorCode: 'SODA_DISCOVER_FAILED', timeoutMs: 9000 },
      )
      const mixBlock = pickArray(json && json.blocks).find((b) => normalizeText(b && b.type) === 'discover_playlist_mix')
      blocks = pickArray(mixBlock && mixBlock.inner_block, mixBlock && mixBlock.innerBlock)
    }
    const items = blocks
      .map((entry) => {
        const resource = pickArray(entry && entry.resources)[0] || {}
        const style = pickObject(resource.style) || pickObject(entry && entry.style) || {}
        const coverColor = pickObject(style.cover_color)
        const baseFive = pickObject(coverColor && coverColor.base_five_color)
        const kind = normalizeText(resource.type || entry.type)
        return {
          innerBlockId: normalizeText((entry && (entry.inner_block_id || entry.innerBlockId)) || resource.resource_id),
          type: kind === 'radio' ? 'radio' : 'playlist',
          resourceId: normalizeText(resource.resource_id || resource.resourceId),
          title: normalizeText(style.title) || normalizeText(entry && entry.title),
          desc: normalizeText(style.desc),
          coverUrl: sodaTemplatedImageUrl(pickObject(pickArray(style.cover_url_list)[0], style.cover_url, style.coverUrl), '~c5_375x375.jpg'),
          backgroundColor: baseFive && baseFive.rgb ? '#' + normalizeText(baseFive.rgb) : '',
          link: normalizeText(style.link),
          sceneName: kind === 'radio' ? 'discovery_radio' : 'discovery_playlist',
        }
      })
      .filter((item) => item.resourceId && (item.title || item.coverUrl))
    return { items, hasMore: useMix ? items.length > 0 : true }
  })
}

/**
 * 上游 URLInfo（{uri, urls[], template_prefix}）→ 可直出的图片地址。
 * 裸 url+uri 是**没有图片处理模板**的，直接请求会 404；必须补上模板后缀：
 *   有 template_prefix 时用 "~<prefix>-image.image"（客户端同名取法，PNG/SVG 通用）；
 *   没有时退回 waveforge 各处封面统一在用的 "~c5_NxN.jpg" 裁剪模板。
 */
export function sodaTemplatedImageUrl(node, cropSuffix) {
  // 调用点的回退参数可能是纯字符串 URL（style.cover_url / coverUrl），
  // pickObject 会把它当非对象丢掉，所以字符串要直接放行
  if (typeof node === 'string') {
    const text = normalizeText(node)
    if (!text) return ''
    if (text.includes('~')) return text
    return cropSuffix ? text + cropSuffix : text
  }
  node = pickObject(node)
  const bare = qishuiImageUrl(node, '')
  if (!bare) return ''
  if (bare.includes('~')) return bare
  const prefix = normalizeText(node.template_prefix || node.templatePrefix)
  if (prefix) return bare + '~' + prefix + '-image.image'
  return cropSuffix ? bare + cropSuffix : bare
}

/**
 * 「探索更多新模式」的完整板块（手机端 /luna/discover 的首屏 blocks）。
 *
 * 与下面 DiscoverMix 的分工：这个给「首屏若干块卡片 + 每块的标题」，
 * 是手机端发现页的正文；DiscoverMix 是同一块数据的翻页源。
 * 结构统一为 block{title,type,cards[]}，卡片取 resources[0].style 的
 * title/desc/cover/底色 —— 与 DiscoverMix 同一套字段。
 */
async function handleSodaDiscoverSections(cookieText) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  const cacheKey = 'discover-sections|' + sodaCookieFingerprint(cookie) + '|' + sodaSceneDayBucket()
  return sodaSceneCache.wrap(cacheKey, 24 * 60 * 60 * 1000, async () => {
    const json = await sodaPcPostJson(
      '/luna/pc/discover',
      { first_request: true, pc_new_discover_request: true },
      cookie,
      { errorCode: 'SODA_DISCOVER_FAILED', timeoutMs: 9000 },
    )
    const blocks = pickArray(json && json.blocks)
    const sections = blocks
      .map((block) => {
        const cards = pickArray(block && block.inner_block, block && block.innerBlock)
          .map((entry) => {
            const resource = pickArray(entry && entry.resources)[0] || {}
            const style = pickObject(resource.style) || pickObject(entry && entry.style) || {}
            const coverColor = pickObject(style.cover_color)
            const baseFive = pickObject(coverColor && coverColor.base_five_color)
            const kind = normalizeText(resource.type || entry.type)
            return {
              innerBlockId: normalizeText((entry && (entry.inner_block_id || entry.innerBlockId)) || resource.resource_id),
              type: kind === 'radio' ? 'radio' : 'playlist',
              resourceId: normalizeText(resource.resource_id || resource.resourceId),
              title: normalizeText(style.title) || normalizeText(entry && entry.title),
              desc: normalizeText(style.desc) || normalizeText(entry && entry.desc),
              coverUrl: sodaTemplatedImageUrl(
                pickObject(pickArray(style.cover_url_list)[0], style.cover_url, style.coverUrl),
                '~c5_375x375.jpg',
              ),
              backgroundColor: baseFive && baseFive.rgb ? '#' + normalizeText(baseFive.rgb) : '',
              link: normalizeText(style.link),
              sceneName: normalizeText(entry && entry.scene_name) || (kind === 'radio' ? 'discovery_radio' : 'discovery_playlist'),
            }
          })
          .filter((card) => card.resourceId && (card.title || card.coverUrl))
        const style = pickObject(block && block.block_style, block && block.blockStyle) || {}
        return {
          title: normalizeText(block && block.title),
          type: normalizeText(block && block.type),
          columnSize: Number(style.column_size ?? style.columnSize) || 0,
          rowSize: Number(style.row_size ?? style.rowSize) || 0,
          cards,
        }
      })
      .filter((section) => section.cards.length > 0)
    return { sections }
  })
}

/**
 * 歌单广场（客户端 FeedPlaylistSquare → POST /luna/feed/playlist-square | /luna/pc/feed/playlist-square）。
 * 返回分类标签 + 歌单卡片（title/desc/曲目数/收藏数/可见数/封面）。
 */
async function handleSodaPlaylistSquare(cookieText, opts) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  opts = opts && typeof opts === 'object' ? opts : {}
  const categoryId = normalizeText(opts.categoryId)
  const cacheKey = 'playlist-square|' + sodaCookieFingerprint(cookie) + '|' + sodaSceneDayBucket() + '|' + (categoryId || 'all')
  return sodaSceneCache.wrap(cacheKey, 30 * 60 * 1000, async () => {
    const json = await sodaPcPostJson(
      '/luna/pc/feed/playlist-square',
      categoryId ? { category_id: categoryId } : {},
      cookie,
      { errorCode: 'SODA_PLAYLIST_SQUARE_FAILED', timeoutMs: 9000 },
    )
    const categories = pickArray(json && json.categories)
      .map((item) => ({
        id: normalizeText(item && (item.id ?? item.tag_id ?? item.tagId)),
        name: normalizeText(item && (item.name || item.title)),
      }))
      .filter((item) => item.name)
    const items = pickArray(json && json.items)
      .map((entry) => {
        const playlist = pickObject(entry && entry.entity && entry.entity.playlist, entry && entry.playlist) || {}
        const stats = pickObject(playlist.stats) || {}
        const id = normalizeText(playlist.id || playlist.playlist_id)
        if (!id) return null
        return {
          id,
          title: normalizeText(playlist.title || playlist.name),
          desc: normalizeText(playlist.desc || playlist.description),
          coverUrl: sodaTemplatedImageUrl(pickObject(playlist.url_cover, playlist.urlCover, playlist.cover_url), '~c5_375x375.jpg'),
          trackCount: Number(playlist.count_tracks ?? playlist.countTracks ?? (pickObject(playlist.resource_cnt) || {}).track_cnt ?? 0) || 0,
          collectCount: Number(stats.count_collected ?? stats.countCollected ?? 0) || 0,
          visibleCount: Number(stats.count_visible ?? stats.countVisible ?? 0) || 0,
          creator: normalizeText((pickObject(playlist.owner) || {}).nickname),
        }
      })
      .filter(Boolean)
    return { categories, items, hasMore: !!(json && (json.has_more || json.hasMore)) }
  })
}

/**
 * 「适合『听』的视频」（手机端听抖音 tab 的内容）→ POST /luna/feed/listen-video-tab。
 * 手机端独有的内容形态（小说/脱口秀/助眠等长音频视频流），PC 端没有 /pc/ 路径，
 * 只能打移动端原生路径（实测可用）。
 */
async function handleSodaListenVideo(cookieText, opts) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  opts = opts && typeof opts === 'object' ? opts : {}
  const count = Math.max(1, Math.min(30, Number(opts.count) || 12))
  const cacheKey = 'listen-video|' + sodaCookieFingerprint(cookie) + '|' + count + '|' + normalizeText(opts.categoryId)
  return sodaSceneCache.wrap(cacheKey, 10 * 60 * 1000, async () => {
    const json = await sodaPcPostJson(
      '/luna/feed/listen-video-tab',
      {
        count,
        ...(normalizeText(opts.categoryId) ? { category_id: normalizeText(opts.categoryId) } : {}),
      },
      cookie,
      { errorCode: 'SODA_LISTEN_VIDEO_FAILED', timeoutMs: 9000 },
    )
    const items = pickArray(json && json.items)
      .map((entry) => {
        const video = pickObject(entry && entry.entity && entry.entity.video, entry && entry.video) || {}
        const id = normalizeText(entry && entry.id ? entry.id : video.id)
        if (!id) return null
        const author = pickObject(video.author, video.owner) || {}
        const statistic = pickObject(video.statistics, video.stats) || {}
        return {
          id,
          type: normalizeText(entry && entry.type) || 'video_track_mix',
          title: normalizeText(video.description || video.title || entry && entry.title),
          coverUrl: qishuiFirstImageUrl('', video.image_url, video.imageUrl, video.cover_url),
          durationMs: Number(video.duration) || 0,
          authorName: normalizeText(author.nickname || author.name),
          authorAvatarUrl: qishuiFirstImageUrl('~c5_100x100.jpg', author.avatar_thumb, author.avatar_url),
          playCount: Number(statistic.play_count ?? statistic.playCount ?? 0) || 0,
          diggCount: Number(statistic.digg_count ?? statistic.diggCount ?? 0) || 0,
        }
      })
      .filter(Boolean)
    const style = pickObject(json && json.style) || {}
    const bg = pickObject(style.background_color)
    return {
      items,
      backgroundColor: bg && bg.rgb ? '#' + normalizeText(bg.rgb) : '',
      hasMore: !!(json && (json.has_more || json.hasMore)),
    }
  })
}

// ─────────────── 真实艺人页（详情 / 专辑 / 全部歌曲）───────────────
//
// 旧实现是「伪艺人」：只拿歌手名去搜索、再按名字聚合，所以没有头像、没有简介、没有专辑
// ——客户端本身有真实艺人接口（/luna/pc/artists/{id} 系列），实测从 Node 直连可用。
// 曲目里的 artists[].mid 就是真实 artist_id（前面已保留），前端拿它打开艺人页即可。

/** 艺人页专辑卡片（artist_info.hot_albums 与 ListArtistAlbums 的 albums[] 同构） */
function sodaArtistAlbumCard(raw) {
  const album = pickObject(raw) || {}
  const id = normalizeText(album.id || album.album_id || album.albumId)
  if (!id) return null
  const artists = pickArray(album.artists)
    .map((item) => ({ id: normalizeText(item && item.id), name: normalizeText(item && item.name) }))
    .filter((item) => item.name)
  const stats = pickObject(album.stats) || {}
  return {
    id,
    name: normalizeText(album.name || album.title),
    coverUrl: qishuiFirstImageUrl('~c5_375x375.jpg', album.url_cover, album.urlCover, album.cover_url),
    artists,
    artist: artists.map((item) => item.name).join(' / '),
    company: normalizeText(album.company),
    trackCount: Number(album.count_tracks ?? album.countTracks) || 0,
    releaseDate: Number(album.release_date ?? album.releaseDate) || 0,
    collectCount: Number(stats.count_collected ?? stats.countCollected) || 0,
    collected: !!(pickObject(album.state) || {}).is_collected,
    platform: 'soda',
  }
}

/** 艺人详情：GET /luna/pc/artists/{id}（客户端 GetArtistDetail） */
async function handleSodaArtistDetail(artistId, cookieText) {
  const id = normalizeText(String(artistId || '').replace(/^qishui:/i, ''))
  if (!id) throw new Error('缺少汽水音乐歌手 id')
  const cacheKey = 'artist-detail|' + sodaCookieFingerprint(cookieText) + '|' + id
  return sodaSceneCache.wrap(cacheKey, 30 * 60 * 1000, async () => {
    const json = await sodaWebRequestJson(
      `/luna/pc/artists/${encodeURIComponent(id)}`,
      sodaPcAppParams({}, cookieText),
      cookieText,
      {
        bases: [QISHUI_WEB_PC_API_BASE],
        noDefaultParams: true,
        sessionOnly: true,
        pcApp: true,
        timeoutMs: 9000,
      },
    )
    const info = pickObject(json && json.artist_info, json && json.artistInfo) || {}
    const profile = pickObject(info.artist_profile, info.artistProfile) || {}
    const career = pickObject(profile.career) || {}
    const state = pickObject(info.state) || {}
    const stats = pickObject(info.stats) || {}
    return {
      id: normalizeText(info.id) || id,
      name: normalizeText(info.name || info.simple_display_name || info.simpleDisplayName),
      fullName: normalizeText(info.full_display_name || info.fullDisplayName),
      avatarUrl: qishuiFirstImageUrl('~c5_500x500.jpg', info.url_avatar, info.urlAvatar),
      albumCount: Number(info.count_albums ?? info.countAlbums) || 0,
      trackCount: Number(info.count_tracks ?? info.countTracks) || 0,
      collectCount: Number(stats.count_collected ?? stats.countCollected) || 0,
      collected: !!(state.is_collected ?? state.isCollected),
      blocked: !!(state.blocked_by_me ?? state.blockedByMe),
      userArtistType: Number(info.user_artist_type ?? info.userArtistType) || 0,
      // 「歌手详情」：客户端 Artist 页展示的就是简介 / 职业 / 国籍这几项
      intro: normalizeText(profile.intro || profile.description),
      occupations: pickArray(career.occupations).map((item) => normalizeText(item)).filter(Boolean),
      nationality: normalizeText(profile.nationality),
      hotTracks: mapSodaMediaList(pickArray(json && json.hot_tracks, json && json.hotTracks), 'soda-artist'),
      hotAlbums: pickArray(json && json.hot_albums, json && json.hotAlbums).map(sodaArtistAlbumCard).filter(Boolean),
      hotMvs: pickArray(json && json.hot_mvs, json && json.hotMvs),
      hasMoreTracks: !!(json && (json.has_more_tracks ?? json.hasMoreTracks)),
      hasMoreAlbums: !!(json && (json.has_more_albums ?? json.hasMoreAlbums)),
    }
  })
}

/** 艺人专辑列表：GET /luna/pc/artists/{id}/albums（客户端 ListArtistAlbums） */
async function handleSodaArtistAlbums(artistId, opts, cookieText) {
  const id = normalizeText(String(artistId || '').replace(/^qishui:/i, ''))
  if (!id) throw new Error('缺少汽水音乐歌手 id')
  opts = opts && typeof opts === 'object' ? opts : {}
  const cursor = normalizeText(opts.cursor)
  const count = Math.max(1, Math.min(50, Number(opts.count) || 20))
  const json = await sodaWebRequestJson(
    `/luna/pc/artists/${encodeURIComponent(id)}/albums`,
    sodaPcAppParams({ cursor: cursor || '0', count: String(count) }, cookieText),
    cookieText,
    {
      bases: [QISHUI_WEB_PC_API_BASE],
      noDefaultParams: true,
      sessionOnly: true,
      pcApp: true,
      timeoutMs: 9000,
    },
  )
  const data = (json && json.data) || json || {}
  const albums = pickArray(data.albums, json && json.albums).map(sodaArtistAlbumCard).filter(Boolean)
  const nextCursor = normalizeText(data.next_cursor || data.nextCursor)
  return { albums, nextCursor, hasMore: !!(data.has_more ?? data.hasMore) || !!nextCursor }
}

/**
 * 艺人全部歌曲：GET /luna/pc/artists/{id}/tracks（客户端 ListArtistTracks）
 * sort_type：0=最热 1=发行时间 2=收藏数（客户端 ArtistTrackSortType）
 */
async function handleSodaArtistTracks(artistId, opts, cookieText) {
  const id = normalizeText(String(artistId || '').replace(/^qishui:/i, ''))
  if (!id) throw new Error('缺少汽水音乐歌手 id')
  opts = opts && typeof opts === 'object' ? opts : {}
  const cursor = normalizeText(opts.cursor)
  const count = Math.max(1, Math.min(50, Number(opts.count) || 30))
  const sortType = Math.max(0, Math.min(2, Number(opts.sortType) || 0))
  const json = await sodaWebRequestJson(
    `/luna/pc/artists/${encodeURIComponent(id)}/tracks`,
    sodaPcAppParams({ cursor: cursor || '0', count: String(count), sort_type: String(sortType) }, cookieText),
    cookieText,
    {
      bases: [QISHUI_WEB_PC_API_BASE],
      noDefaultParams: true,
      sessionOnly: true,
      pcApp: true,
      timeoutMs: 9000,
    },
  )
  const data = (json && json.data) || json || {}
  const tracks = mapSodaMediaList(pickArray(data.tracks, json && json.tracks), 'soda-artist')
  const nextCursor = normalizeText(data.next_cursor || data.nextCursor)
  return { tracks, nextCursor, hasMore: !!(data.has_more ?? data.hasMore) || !!nextCursor }
}

/** 歌单追加歌曲 */
async function handleSodaPlaylistAddSong(playlistId, track, cookieText) {
  const playlistIdValue = normalizeText(String(playlistId || '').replace(/^qishui:/i, ''))
  const trackId = normalizeText(
    track && typeof track === 'object' ? track.providerSongId || track.trackId || track.track_id || track.id : track,
  )
  if (!playlistIdValue || !trackId) throw new Error('缺少汽水音乐歌单 id 或歌曲 id')
  await sodaPcPostJson(
    '/luna/pc/me/playlist/media/append',
    { playlist_id: playlistIdValue, media: [{ id: trackId, type: 'track' }] },
    cookieText,
    { errorCode: 'SODA_PLAYLIST_ADD_FAILED' },
  )
  invalidateSodaLibraryCaches()
  return { pid: playlistIdValue, id: trackId }
}

/** 收藏/取消收藏专辑 */
async function handleSodaSetAlbumCollected(albumId, collected, cookieText) {
  const id = normalizeText(albumId)
  if (!id) throw new Error('缺少汽水音乐专辑 id')
  collected = sodaWriteEnabled(collected)
  await sodaPcPostJson(
    collected ? '/luna/pc/me/collection/album' : '/luna/pc/me/collection/album/delete',
    { album_ids: [id] },
    cookieText,
    { errorCode: collected ? 'SODA_ALBUM_COLLECT_FAILED' : 'SODA_ALBUM_UNCOLLECT_FAILED' },
  )
  invalidateSodaLibraryCaches()
  return { id, collected }
}

/** 上报最近播放（同时清库缓存让「最近播放」虚拟歌单立即可见） */
async function handleSodaReportRecentlyPlayed(trackId, cookieText) {
  const id = normalizeText(trackId)
  if (!id) throw new Error('缺少汽水音乐歌曲 id')
  await sodaPcPostJson(
    '/luna/pc/me/recently-played-media',
    { media: [{ type: 'track', id }] },
    cookieText,
    { errorCode: 'SODA_RECENT_PLAY_REPORT_FAILED', timeoutMs: 6500 },
  )
  sodaWebLibraryCache.clear()
  return { id, reported: true }
}

// ─────────────────────────── 评论 ───────────────────────────

function extractSodaCommentList(payload) {
  const data = (payload && payload.data) || payload || {}
  return pickArray(data.comments, data.comment_list, data.commentList, data.items, data.list, payload && payload.comments)
}

/** 上游评论 → 统一结构（字段名对齐客户端 ListComments / ListReplies 的 Comment 实体） */
function mapSodaComment(raw) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const comment = pickObject(raw.comment, raw.comment_info, raw.commentInfo, raw)
  const user = pickObject(comment.user, comment.user_info, comment.userInfo, comment.author, raw.user, raw.user_info, raw.author)
  // 客户端字段：time_created（秒）/ count_digged / count_reply / featured / ip_label
  const timeRaw =
    Number(
      qishuiObjectNumber(comment, ['time_created', 'timeCreated', 'create_time', 'createTime', 'created_at', 'createdAt', 'time']),
    ) || 0
  const likes =
    Number(
      qishuiObjectNumber(comment, ['count_digged', 'countDigged', 'like_count', 'likeCount', 'digg_count', 'diggCount', 'liked_count']),
    ) || 0
  const replyCount = Number(qishuiObjectNumber(comment, ['count_reply', 'countReply'])) || 0
  const out = {
    id: normalizeText(comment.id || comment.comment_id || comment.commentId || raw.id || ''),
    user: {
      name: normalizeText(
        user.nickname || user.nick_name || user.nickName || user.name || user.screen_name || user.public_name || '',
      ),
      avatarUrl: qishuiFirstImageUrl(
        '~c5_100x100.jpg',
        user.medium_avatar_url,
        user.thumb_avatar_url,
        user.avatar_url,
        user.avatarUrl,
        user.avatar,
        user.larger_avatar_url,
      ),
      userId: normalizeText(user.id || user.user_id || user.uid || ''),
    },
    content: normalizeLyricBody(comment.content || comment.text || comment.comment_text || comment.commentText || ''),
    likes,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
  }
  // 客户端 VIP 角标：user.vip_stage（free/vip/svip）+ user.is_vip
  const vipStage = normalizeText(user.vip_stage || user.vipStage).toLowerCase()
  if (user.is_vip === true || vipStage === 'vip' || vipStage === 'svip') {
    out.user.vip = vipStage === 'svip' ? 'svip' : 'vip'
  }
  // 客户端音乐人标识：user_artist_info.user_artist_type（0 普通用户，非 0 为音乐人）
  const artistInfo = pickObject(comment.user_artist_info, comment.userArtistInfo)
  const artistType = Number(artistInfo && (artistInfo.user_artist_type ?? artistInfo.userArtistType)) || 0
  if (artistType) out.user.artistType = artistType
  const ipLabel = normalizeText(comment.ip_label || comment.ipLabel)
  if (ipLabel) out.ipLabel = ipLabel
  if (replyCount > 0) out.replyCount = replyCount
  // 客户端用 user_digged 决定点赞图标实心/空心（本地乐观更新也会写它）
  if (comment.user_digged === true || comment.userDigged === true) out.liked = true
  if (sodaExplicitPositive(comment.featured ?? comment.pinned ?? comment.is_pinned ?? comment.stick_top ?? comment.is_stick)) {
    out.pinned = true
  }
  const repliesRaw = pickArray(
    comment.reply_infos,
    comment.replyInfos,
    comment.reply_list,
    comment.replies,
    comment.reply_comments,
  )
  if (repliesRaw.length) out.replies = repliesRaw.slice(0, 20).map((reply) => mapSodaComment(reply))
  return out
}

/** 评论列表（需登录）：luna/pc/comments 游标分页 */
async function handleSodaComments(trackId, opts, cookieText) {
  const id = normalizeText(trackId)
  if (!id) throw new Error('缺少汽水音乐歌曲 id')
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    const err = new Error('QISHUI_COOKIE_REQUIRED')
    err.code = 'QISHUI_COOKIE_REQUIRED'
    throw err
  }
  opts = opts || {}
  const count = Math.max(1, Math.min(50, Number(opts.count != null ? opts.count : opts.limit) || 20))
  const cursor = normalizeText(opts.cursor != null ? opts.cursor : opts.offset || '')
  const json = await sodaWebRequestJson('/luna/pc/comments', sodaPcAppParams({
    group_id: id,
    cursor,
    count,
    group_type: 0,
  }, cookie), cookie, {
    bases: [QISHUI_WEB_PC_API_BASE],
    noDefaultParams: true,
    sessionOnly: true,
    pcApp: true,
    timeoutMs: 8500,
  })
  const rawComments = extractSodaCommentList(json)
  const comments = rawComments.map(mapSodaComment).filter((comment) => comment.content)
  const data = (json && json.data) || json || {}
  const nextCursor = normalizeText(data.next_cursor || data.nextCursor || data.cursor || (json && (json.next_cursor || json.cursor)) || '')
  return {
    comments,
    total: Number(data.total || data.total_count || data.totalCount || data.count || comments.length) || comments.length,
    cursor,
    nextCursor,
    hasMore: !!(data.has_more || data.hasMore || nextCursor),
  }
}

/** 发布评论：luna/pc/comments/create */
async function handleSodaCreateComment(trackId, text, cookieText) {
  const id = normalizeText(trackId)
  text = normalizeLyricBody(text)
  if (!id) throw new Error('缺少汽水音乐歌曲 id')
  if (!text) throw new Error('缺少评论内容')
  const json = await sodaPcPostJson('/luna/pc/comments/create', { group_id: id, text, group_type: 0 }, cookieText, {
    errorCode: 'SODA_COMMENT_CREATE_FAILED',
  })
  const rawComments = extractSodaCommentList(json)
  const comment = rawComments.length ? mapSodaComment(rawComments[0]) : mapSodaComment((json && json.data) || json)
  return { comment: comment.content ? comment : null }
}

/** 评论回复列表：GET /luna/pc/comments/{comment_id}/replies（客户端 ListReplies） */
async function handleSodaCommentReplies(commentId, opts, cookieText) {
  const id = normalizeText(commentId)
  if (!id) throw new Error('缺少评论 id')
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    const err = new Error('QISHUI_COOKIE_REQUIRED')
    err.code = 'QISHUI_COOKIE_REQUIRED'
    throw err
  }
  opts = opts || {}
  const count = Math.max(1, Math.min(50, Number(opts.count != null ? opts.count : opts.limit) || 20))
  const cursor = normalizeText(opts.cursor != null ? opts.cursor : opts.offset || '')
  const json = await sodaWebRequestJson(
    `/luna/pc/comments/${encodeURIComponent(id)}/replies`,
    sodaPcAppParams({ cursor, count, group_type: 0 }, cookie),
    cookie,
    {
      bases: [QISHUI_WEB_PC_API_BASE],
      noDefaultParams: true,
      sessionOnly: true,
      pcApp: true,
      timeoutMs: 8500,
    },
  )
  const data = (json && json.data) || json || {}
  const raw = pickArray(
    data.reply_infos,
    data.replyInfos,
    data.comments,
    data.replies,
    json && json.reply_infos,
  )
  const replies = raw.map(mapSodaComment).filter((reply) => reply.content)
  const nextCursor = normalizeText(data.cursor || data.next_cursor || data.nextCursor || '')
  return {
    replies,
    total: Number(data.count || replies.length) || replies.length,
    cursor,
    nextCursor,
    hasMore: !!(data.has_more || data.hasMore || (nextCursor && nextCursor !== cursor)),
  }
}

/**
 * 评论点赞/取消：POST /luna/pc/comments/action（客户端 CommentAction）
 * type：1=点赞，3=取消点赞（取自客户端 compositions/comment.ts digComment/undoDigComment）
 */
async function handleSodaCommentAction(commentId, opts, cookieText) {
  const id = normalizeText(commentId)
  if (!id) throw new Error('缺少评论 id')
  opts = opts || {}
  const liked = opts.liked !== false
  const json = await sodaPcPostJson(
    '/luna/pc/comments/action',
    {
      comment_id: id,
      reply_id: normalizeText(opts.replyId || opts.reply_id || ''),
      group_id: normalizeText(opts.groupId || opts.group_id || ''),
      type: liked ? 1 : 3,
      scene_name: normalizeText(opts.sceneName || opts.scene_name || 'comment_detail'),
    },
    cookieText,
    { errorCode: 'SODA_COMMENT_ACTION_FAILED' },
  )
  return {
    id,
    liked,
    likedComment: normalizeText((json && json.liked_comment) || (json && json.likedComment) || ''),
  }
}

/** 删除评论：POST /luna/pc/comments/delete（客户端 DeleteComment） */
async function handleSodaDeleteComment(commentId, replyId, cookieText) {
  const id = normalizeText(commentId)
  if (!id) throw new Error('缺少评论 id')
  await sodaPcPostJson(
    '/luna/pc/comments/delete',
    { comment_id: id, reply_id: normalizeText(replyId || '') },
    cookieText,
    { errorCode: 'SODA_COMMENT_DELETE_FAILED' },
  )
  return { id, deleted: true }
}

// ─────────────────────────── 播放地址解析（track_v2 + 会员分层过滤）───────────────────────────

function sodaPrimaryTrackFromV2(payload) {
  const data = (payload && payload.data) || payload || {}
  return pickObject(data.track, data.track_info, data.trackInfo, payload && payload.track, payload && payload.track_info, payload && payload.trackInfo)
}

function sodaTrackPlayerFromV2(payload, track) {
  const data = (payload && payload.data) || payload || {}
  return pickObject(
    data.track_player,
    data.trackPlayer,
    payload && payload.track_player,
    payload && payload.trackPlayer,
    track && track.track_player,
    track && track.trackPlayer,
  )
}

/**
 * track_v2 的请求体。字段集严格按客户端 GetTrackV2Request（idl/goapi/contract/track.ts）：
 * track_id / media_type / queue_type / scene_name 等——**不含 includes**。
 * includes 属于 GetTrackRequest（/luna/track），混进 track_v2 是协议外字段。
 */
async function fetchSodaPcTrackV2Post(trackId, cookieText, limitedFreeParam) {
  const body = JSON.stringify(Object.assign(
    {
      track_id: trackId,
      media_type: 'track',
      queue_type: 'favorite_track_playlist',
      scene_name: 'library',
    },
    // 限免凭证必须整份原样回传（sign v2.0 覆盖所有字段）；实测换队列类型不影响生效
    limitedFreeParam ? { limited_free_param: limitedFreeParam } : {},
  ))
  const json = await requestJson(qishuiPcUrl('/luna/pc/track_v2', sodaPcAppParams({}, cookieText)), {
    method: 'POST',
    timeoutMs: 10000,
    headers: Object.assign(sodaWebHeaders(cookieText, { sessionOnly: true, pcApp: true }), {
      Referer: 'https://www.qishui.com/',
    }),
  }, body)
  const err = sodaPcStatusError(json, 'SODA_PC_TRACK_V2_FAILED')
  if (err) throw err
  return json
}

async function fetchSodaPcTrackV2Get(trackId, cookieText) {
  const json = await requestJson(
    qishuiPcUrl('/luna/pc/track_v2', sodaPcAppParams({ track_id: trackId, media_type: 'track' }, cookieText)),
    {
      timeoutMs: 10000,
      headers: Object.assign(sodaWebHeaders(cookieText, { sessionOnly: true, pcApp: true }), {
        Referer: 'https://www.qishui.com/',
      }),
    },
  )
  const err = sodaPcStatusError(json, 'SODA_PC_TRACK_V2_GET_FAILED')
  if (err) throw err
  return json
}

/**
 * 曲目详情（带「我的收藏态 / 播放统计 / 歌词」）：POST /luna/track（客户端 GetTrack）。
 * includes 是 GetTrackRequest 的字段，取值见客户端 TrackInclude* 常量：
 *   track / track_player / lyric / is_collected / track_stats
 * 与 track_v2 的分工：track_v2 只给播放所需的元数据与流地址，
 * 收藏态与统计必须走这个接口（track_v2 的契约里根本没有 includes）。
 */
const SODA_TRACK_INCLUDES = ['track', 'track_player', 'lyric', 'is_collected', 'track_stats']

async function fetchSodaTrackDetailPayload(trackId, cookieText) {
  return sodaPcPostJson(
    '/luna/track',
    {
      track_id: normalizeText(trackId),
      media_type: 'track',
      includes: SODA_TRACK_INCLUDES,
    },
    cookieText,
    { errorCode: 'SODA_TRACK_DETAIL_FAILED' },
  )
}

/** 曲目详情 → 前端结构（收藏态 + 统计 + 歌词顺带种入缓存） */
async function handleSodaTrackDetail(trackId, cookieText) {
  const id = normalizeText(trackId)
  if (!id) throw new Error('缺少汽水音乐歌曲 id')
  const json = await fetchSodaTrackDetailPayload(id, cookieText)
  const track = pickObject(json && json.track, json && json.track_info) || {}
  const stats = pickObject(json && json.track_stats, track.stats) || {}
  const lyricInfo = pickObject(json && json.lyric, track.lyric_info)
  const lyric = sodaLyricTextFromNode(lyricInfo) || normalizeLyricBody(lyricInfo && (lyricInfo.lyric_text || lyricInfo.content) || '')
  if (lyric && !/^https?:\/\//i.test(lyric)) {
    cacheSodaLyric(id, lyric, extractSodaDetailTranslation(lyricInfo), 'soda-track-detail')
  }
  const collectedRaw = json && (json.is_collected != null ? json.is_collected : json.isCollected)
  const state = pickObject(track.state) || {}
  return {
    id,
    isCollected: collectedRaw != null ? !!collectedRaw : !!state.is_collected,
    stats: {
      countCollected: Number(stats.count_collected ?? stats.countCollected ?? 0) || 0,
      countComment: Number(stats.count_comment ?? stats.countComment ?? 0) || 0,
      countShared: Number(stats.count_shared ?? stats.countShared ?? 0) || 0,
      countPlayed: Number(stats.count_played ?? stats.countPlayed ?? 0) || 0,
      countMarked: Number(stats.count_marked ?? stats.countMarked ?? 0) || 0,
    },
    lyric: lyric || undefined,
    tlyric: lyric ? extractSodaDetailTranslation(lyricInfo) || undefined : undefined,
  }
}

/** track_v2 元数据（POST 优先，GET 兜底，20s 微缓存 + 45s 失败负缓存） */
async function fetchSodaPcTrackV2(trackId, cookieText, limitedFreeParam) {
  const cookie = normalizeSodaCookieInput(cookieText)
  const cacheKey =
    'track-v2-meta|' + sodaCookieFingerprint(cookie) + '|' + normalizeText(trackId) +
    // 带限免凭证与不带的响应完全不同（整曲 vs 29s 试听），必须分开缓存，否则会互相污染
    (limitedFreeParam ? '|lf' : '')
  const errorKey = 'track-v2-error|' + sodaCookieFingerprint(cookie) + '|' + normalizeText(trackId)
  // 负缓存命中：短窗口内直接复述上次失败摘要（requestJson「无效 JSON」等），不再重复打上游；TTL 过后自动放行重试
  const cachedError = sodaTrackV2ErrorCache.get(errorKey)
  if (cachedError && Date.now() - cachedError.at < SODA_TRACK_V2_ERROR_TTL_MS) {
    const err = new Error(cachedError.message || 'SODA_PC_TRACK_V2_FAILED')
    if (cachedError.code) err.code = cachedError.code
    if (cachedError.postError) err.postError = cachedError.postError
    err.fromNegativeCache = true
    throw err
  }
  try {
    return await sodaTrackMetadataCache.wrap(cacheKey, 20 * 1000, async () => {
      try {
        return await fetchSodaPcTrackV2Post(trackId, cookie, limitedFreeParam)
      } catch (postError) {
        // 限免凭证只能走 POST（契约里 limited_free_param 不在 query 白名单）。
        // 带凭证时不做 GET 兜底：GET 拿回来的必然是 29s 试听流，会把「限免可整曲」
        // 静默降级成试听，比直接报错更难排查。
        if (limitedFreeParam) throw postError
        try {
          return await fetchSodaPcTrackV2Get(trackId, cookie)
        } catch (getError) {
          getError.postError = (postError && postError.message) || String(postError)
          throw getError
        }
      }
    })
  } catch (err) {
    sodaTrackV2ErrorCache.set(errorKey, {
      at: Date.now(),
      message: (err && err.message) || String(err),
      code: (err && err.code) || '',
      postError: (err && err.postError) || '',
    })
    while (sodaTrackV2ErrorCache.size > SODA_TRACK_V2_ERROR_CACHE_LIMIT) {
      const oldestKey = sodaTrackV2ErrorCache.keys().next().value
      if (!oldestKey) break
      sodaTrackV2ErrorCache.delete(oldestKey)
    }
    throw err
  }
}

/** 拉取 url_player_info（CDN 直签地址），同样做会员过滤；被挡的最优流内部保留用于精确报因 */
async function fetchSodaPlayerInfo(playerInfoUrl, cookieText, membership, gate) {
  playerInfoUrl = normalizeText(playerInfoUrl)
  if (!/^https?:\/\//i.test(playerInfoUrl)) return null
  const json = await requestJson(playerInfoUrl, {
    timeoutMs: 10000,
    headers: sodaHeadersWithCookie({
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': QISHUI_WEB_UA,
      Referer: 'https://api.qishui.com/',
    }, cookieText),
  })
  const result = pickObject(json && json.Result, json && json.result)
  const data = pickObject(result.Data, result.data, json && json.Data, json && json.data)
  const list = pickArray(data.PlayInfoList, data.playInfoList, data.play_info_list, json && json.PlayInfoList)
  const streams = list.map((item) => sodaStreamFromObject(item, { gate })).filter(Boolean)
  const best = sodaBestStreamCandidateForMembership(streams, membership)
  if (best) return best
  const blocked = sodaBestStreamCandidate(streams)
  if (blocked) return blocked
  const error = pickObject(json && json.ResponseMetadata && json.ResponseMetadata.Error, json && json.responseMetadata && json.responseMetadata.error)
  if (error && (error.Message || error.message)) throw new Error(normalizeText(error.Message || error.message))
  return null
}

function collectSodaTrackV2Streams(payload) {
  const track = sodaPrimaryTrackFromV2(payload)
  const player = sodaTrackPlayerFromV2(payload, track)
  // 客户端权威音质门槛：track.label_info.quality_map → 每档是否需要会员
  const gate = sodaTrackQualityGate(track)
  const audioInfo = pickObject(track.audio_info, track.audioInfo, payload && payload.audio_info, payload && payload.audioInfo)
  const playInfoList = pickArray(audioInfo.play_info_list, audioInfo.PlayInfoList, audioInfo.playInfoList)
  const streams = playInfoList.map((item) => sodaStreamFromObject(item, { gate })).filter(Boolean)
  const videoModel = player.video_model || player.VideoModel || player.videoModel || track.video_model || track.VideoModel || ''
  sodaCollectVideoModelStreams(videoModel, '', { gate }, streams)
  const bitRates = pickArray(track.bit_rates, track.bitRates, audioInfo.bit_rates, audioInfo.bitRates, payload && payload.bit_rates, payload && payload.bitRates)
  const fallbackStreams = bitRates.map((item) => sodaStreamFromObject(item, { gate })).filter(Boolean)
  return { track, player, gate, streams, fallbackStreams }
}

/** 从 track_v2 负载解析可播下载信息；拿不到时抛带错误码的异常（VIP/SVIP/会员未知） */
async function resolveSodaDownloadInfo(trackId, payload, cookieText, membership) {
  const collected = collectSodaTrackV2Streams(payload)
  const playerInfoUrl = qishuiObjectString(collected.player, ['url_player_info', 'URLPlayerInfo', 'urlPlayerInfo'])
  if (playerInfoUrl) {
    try {
      const stream = await fetchSodaPlayerInfo(playerInfoUrl, cookieText, membership, collected.gate)
      if (stream) collected.streams.push(stream)
    } catch (err) {
      collected.playerInfoError = (err && err.message) || String(err)
    }
  }
  // 会员允许的候选全集（play_info_list / video_model / url_player_info 补充流）：quality 选档在此基础上就近挑档
  const allowedStreams = (collected.streams || []).filter((item) => sodaStreamAllowedForMembership(item, membership))
  const best =
    sodaBestStreamCandidate(allowedStreams) ||
    sodaBestStreamCandidateForMembership(collected.fallbackStreams, membership)
  if (!best) {
    const unrestricted =
      sodaBestStreamCandidate(collected.streams) || sodaBestStreamCandidate(collected.fallbackStreams)
    const requiredTier = unrestricted ? sodaStreamRequiredTier(unrestricted) : 'free'
    const entitlementLimited = !!(unrestricted && !sodaRequiredTierAllowed(requiredTier, membership))
    let errorCode = 'SODA_AUDIO_SOURCE_EMPTY'
    if (entitlementLimited && !(membership && membership.membershipKnown)) errorCode = 'SODA_MEMBERSHIP_UNKNOWN'
    else if (entitlementLimited && requiredTier === 'svip') errorCode = 'SODA_SVIP_REQUIRED'
    else if (entitlementLimited && requiredTier === 'vip') errorCode = 'SODA_VIP_REQUIRED'
    const err = new Error(errorCode === 'SODA_AUDIO_SOURCE_EMPTY' ? collected.playerInfoError || errorCode : errorCode)
    err.code = errorCode
    err.requiredTier = requiredTier
    throw err
  }
  // 主候选全集为空时（仅 bit_rates 兜底命中），选档池退回 bit_rates 里会员允许的档位
  const qualityPool = allowedStreams.length
    ? allowedStreams
    : (collected.fallbackStreams || []).filter((item) => sodaStreamAllowedForMembership(item, membership))
  return Object.assign(collected, { best, qualityPool })
}

/** 给 CDN 地址附加 #auth= 播放凭证（上游要求） */
function sodaUrlWithAuth(url, auth) {
  url = normalizeText(url)
  auth = normalizeText(auth)
  if (!url || !auth || url.includes('#auth=')) return url
  return url + '#auth=' + encodeURIComponent(auth)
}

function sodaUnavailableResult(reason, message, extra) {
  return Object.assign(
    {
      url: '',
      playable: false,
      reason,
      error: message,
    },
    extra || {},
  )
}

/** 把会员视图展开为响应顶层字段（原版 song/url 有、移植时丢失；与嵌套 membership 双写兼容，审计四-3） */
function sodaFlattenMembershipView(view) {
  return {
    membershipKnown: !!(view && view.membershipKnown),
    vipType: Number(view && view.vipType) || 0,
    vipLevel: (view && view.vipLevel) || 'unknown',
    isVip: !!(view && view.isVip),
    isSvip: !!(view && view.isSvip),
    vipLabel: (view && view.vipLabel) || '未知会员状态',
  }
}

/**
 * 播放地址主流程：
 *  无 cookie → login_required；track_v2 元数据 → 会员判定（曲目限制 ∪ 音质档位需求）→
 *  不满足则 playable:false + reason（免费用户不给 VIP 流）；满足则挑会员允许范围内的最优流。
 */
async function handleSodaSongUrl(opts, cookieText) {
  opts = opts && typeof opts === 'object' ? opts : { id: opts }
  const id = normalizeText(opts.id || opts.trackId || opts.track_id || '')
  const cookie = normalizeSodaCookieInput(cookieText || opts.cookie || '')
  const requestedQuality = normalizeText(opts.quality || '')
  // 限免凭证：由列表/推荐流条目的 limited_free_info 原样带回（整份，不许裁剪）
  const limitedFreeParam =
    opts.limitedFreeParam && typeof opts.limitedFreeParam === 'object' && !Array.isArray(opts.limitedFreeParam)
      ? opts.limitedFreeParam
      : null
  const unknownMembershipView = { isVip: false, isSvip: false, vipType: 0, vipLevel: 'unknown', vipLabel: '未知会员状态', membershipKnown: false }
  if (!id) {
    return sodaUnavailableResult('missing_id', '缺少汽水音乐歌曲 id', Object.assign({
      requiredTier: 'free',
      requestedQuality,
    }, sodaFlattenMembershipView(unknownMembershipView), { membership: unknownMembershipView }))
  }
  if (!sodaCookieHasLogin(cookie)) {
    return sodaUnavailableResult('login_required', '汽水音乐播放需要登录态（cookie 参数）', Object.assign({
      requiredTier: 'free',
      requestedQuality,
    }, sodaFlattenMembershipView(unknownMembershipView), { membership: unknownMembershipView }))
  }
  let payload
  try {
    payload = await fetchSodaPcTrackV2(id, cookie, limitedFreeParam)
  } catch (err) {
    // 空体（上游对失效会话的 200+空 body 形态）单列 reason，前端提示「会话失效」
    // 而非笼统「音源暂时无法解析」；负缓存已按 message/code 摘要缓存，无需在此去重。
    const reason = (err && err.code === 'SODA_EMPTY_BODY') ? 'session_rejected' : 'source_unavailable'
    return sodaUnavailableResult(reason, '汽水音乐未返回播放元数据：' + ((err && err.message) || String(err)), Object.assign({
      requiredTier: 'free',
      requestedQuality,
    }, sodaFlattenMembershipView(unknownMembershipView), { membership: unknownMembershipView }))
  }
  let membership = sodaPlaybackMembershipFromPayload(payload)
  if (!membership.membershipKnown) membership = await fetchSodaPlaybackMembership(cookie)
  const membershipView = {
    isVip: !!membership.isVip,
    isSvip: !!membership.isSvip,
    vipType: Number(membership.vipType) || 0,
    vipLevel: membership.vipLevel || (membership.membershipKnown ? 'none' : 'unknown'),
    vipLabel: membership.vipLabel || (membership.membershipKnown ? '无VIP' : '未知会员状态'),
    membershipKnown: !!membership.membershipKnown,
  }
  const membershipKey = membership.isSvip ? 'svip' : membership.isVip ? 'vip' : membership.membershipKnown ? 'free' : 'unknown'
  const cacheKey = 'track-v2|' + sodaCookieFingerprint(cookie) + '|' + membershipKey + '|' + id + '|' + requestedQuality
  return sodaPlaybackCache.wrap(cacheKey, 4 * 60 * 1000, async () => {
    try {
      // 曲目自身限制 + 请求音质档位需求，两者取更严格
      const trackRestriction = sodaTrackPlaybackRestriction(payload)
      const requestRestriction = sodaTrackPlaybackRestriction(opts)
      const requiredTier = sodaHigherRequiredTier(trackRestriction.requiredTier, requestRestriction.requiredTier)
      if (!sodaRequiredTierAllowed(requiredTier, membership)) {
        const reason = !membership.membershipKnown ? 'membership_unknown' : requiredTier === 'svip' ? 'svip_required' : 'vip_required'
        const message =
          reason === 'membership_unknown'
            ? '汽水音乐暂时无法验证当前账号的会员状态，请稍后重试。'
            : reason === 'svip_required'
              ? '该汽水音乐歌曲或音质需要可验证的 SVIP 权益。'
              : '该汽水音乐歌曲或音质需要可验证的 VIP 权益。'
        return sodaUnavailableResult(reason, message, Object.assign({
          requiredTier,
          requestedQuality,
        }, sodaFlattenMembershipView(membershipView), { membership: membershipView }))
      }
      const resolved = await resolveSodaDownloadInfo(id, payload, cookie, membership)
      const track = resolved.track || {}
      // 请求音质选档：会员允许的多档位里就近挑档；缺省/未识别/越权回退最优流（宁低勿败，缺省行为与旧版一致）。
      // 「自动」的 SVIP 剔除在 sodaPickStreamForQuality 内做（缺省 quality 时剔除需 SVIP 的候选；
      // 剔除后为空则回退原 best，保证整曲只有 SVIP 流时不断播）。
      let best = resolved.best
      if (!requestedQuality && sodaStreamRequiredTier(best) === 'svip') {
        const nonSvipBest = sodaBestStreamCandidate(resolved.qualityPool.filter((item) => sodaStreamRequiredTier(item) !== 'svip'))
        if (nonSvipBest) best = nonSvipBest
      }
      const stream = sodaPickStreamForQuality(resolved.qualityPool, requestedQuality, best)
      const duration = stream.duration || sodaNormalizeDurationSeconds(track.duration_ms || track.duration || 0)
      const fullDuration = sodaNormalizeDurationSeconds(track.duration_ms || track.duration || 0)
      // 试听判定：流时长明显小于整曲时长
      const trial = !!(duration > 0 && fullDuration > 0 && duration + 5 < fullDuration)
      const result = {
        // 带 #auth= 凭证的加密流改走本地解密代理，前端 <audio> 直接可播（VIP/高音质无声修复）
        url: sodaWrapAudioUrl(sodaUrlWithAuth(stream.url, stream.auth), stream.auth),
        playable: true,
        trial,
        quality: normalizeText(stream.quality || stream.format || sodaPlaybackLevel(stream.quality, stream.format, stream.bitrate)),
        bitrateKbps: sodaNormalizeBitrateKbps(stream.bitrate) || undefined,
        format: normalizeText(stream.format) || undefined,
        requiredTier: sodaStreamRequiredTier(stream),
        durationSec: duration,
        membership: membershipView,
        source: 'qishui-pc-track-v2',
        // 恢复原版响应字段（移植丢失，审计四-3）：顶层会员视图 + 音质档位/下载体积/请求音质回显
        level: sodaPlaybackLevel(stream.quality, stream.format, stream.bitrate),
        size: Number(stream.size) || 0,
        requestedQuality,
        membershipKnown: membershipView.membershipKnown,
        vipType: membershipView.vipType,
        vipLevel: membershipView.vipLevel,
        isVip: membershipView.isVip,
        isSvip: membershipView.isSvip,
        vipLabel: membershipView.vipLabel,
      }
      if (result.bitrateKbps == null) delete result.bitrateKbps
      if (result.format == null) delete result.format
      // 版权/权益视图：与客户端 useCurrentPlayableCommercialInfo 同一口径，UI 据此显示角标与横幅。
      // preview 优先信上游的 video_model_type===2（客户端同款判定），流时长只是兜底。
      const videoModelType = Number(resolved.player && (resolved.player.video_model_type ?? resolved.player.videoModelType)) || 0
      result.entitlement = {
        onlyVipPlayable: !!(track.label_info && (track.label_info.only_vip_playable ?? track.label_info.onlyVipPlayable)),
        limitedFree: !!limitedFreeParam,
        limitedFreeExpireAt: Number(limitedFreeParam && limitedFreeParam.expire_time) || 0,
        preview: videoModelType === 2 || trial,
        videoModelType,
        interceptType: normalizeText(limitedFreeParam && limitedFreeParam.intercept_type),
      }
      return result
    } catch (err) {
      const entitlementReason =
        err && err.code === 'SODA_MEMBERSHIP_UNKNOWN'
          ? 'membership_unknown'
          : err && err.code === 'SODA_SVIP_REQUIRED'
            ? 'svip_required'
            : err && err.code === 'SODA_VIP_REQUIRED'
              ? 'vip_required'
              : ''
      const message = entitlementReason
        ? {
            membership_unknown: '汽水音乐暂时无法验证当前账号的会员状态，请稍后重试。',
            svip_required: '汽水音乐仅返回了需要 SVIP 权益的音质。',
            vip_required: '汽水音乐仅返回了需要 VIP 权益的音质。',
          }[entitlementReason]
        : '汽水音乐没有返回可播放的音频源：' + ((err && err.message) || String(err))
      return sodaUnavailableResult(entitlementReason || 'source_unavailable', message, Object.assign({
        requiredTier: (err && err.requiredTier) || 'free',
        requestedQuality,
      }, sodaFlattenMembershipView(membershipView), { membership: membershipView }))
    }
  })
}

// ─────────────────────────── 歌词 ───────────────────────────

/** SEO 公开接口（无需登录的第一优先数据源） */
async function fetchSodaSeoTrack(trackId) {
  return requestJson(urlWithParams('https://beta-luna.douyin.com/luna/h5/seo_track', {
    track_id: trackId,
    device_platform: 'web',
  }), {
    timeoutMs: 8000,
    headers: {
      Accept: 'application/json,text/plain,*/*',
      'User-Agent': QISHUI_WEB_UA,
      Referer: 'https://www.douyin.com/',
    },
  })
}

/** 歌词主流程：SEO → （登录时）track_v2 → 公开目录；全程 LRC 化并缓存，yrc 命中时附结构化 words */
async function handleSodaLyric(id, cookieText) {
  id = normalizeText(id)
  if (!id) return { lyric: '', tlyric: '', source: 'none', error: '缺少汽水音乐歌曲 id', words: null }
  const cached = sodaLyricCache.get(id)
  if (cached) return { lyric: cached.lyric, tlyric: cached.tlyric, source: cached.source, words: cached.words || null }
  // 负缓存命中：近期已确认三级全空，直接短路返回，避免纯音乐/翻唱每次切歌都打满三级上游
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const missKey = id + '|' + (loggedIn ? 'login' : 'guest')
  if (sodaLyricMissCache.get(missKey)) {
    return { lyric: '', tlyric: '', source: 'none', error: 'soda-lyric-known-missing' }
  }
  const errors = []
  try {
    const seoPayload = await fetchSodaSeoTrack(id)
    const lyrics = extractSodaLyrics(seoPayload)
    const cachedSeo = cacheSodaLyric(id, lyrics.lyric, lyrics.tlyric, 'soda-seo-track')
    if (cachedSeo) return { lyric: cachedSeo.lyric, tlyric: cachedSeo.tlyric, source: cachedSeo.source, words: cachedSeo.words || null }
  } catch (err) {
    errors.push('seo:' + ((err && err.message) || String(err)))
  }
  if (loggedIn) {
    try {
      const trackPayload = await fetchSodaPcTrackV2Get(id, cookieText)
      const lyrics = extractSodaLyrics(trackPayload)
      const cachedTrack = cacheSodaLyric(id, lyrics.lyric, lyrics.tlyric, 'soda-pc-track-v2')
      if (cachedTrack) return { lyric: cachedTrack.lyric, tlyric: cachedTrack.tlyric, source: cachedTrack.source, words: cachedTrack.words || null }
    } catch (err) {
      errors.push('track-v2:' + ((err && err.message) || String(err)))
    }
  }
  try {
    await fetchSodaPublicDetail(id)
    const fresh = sodaLyricCache.get(id)
    if (fresh) return { lyric: fresh.lyric, tlyric: fresh.tlyric, source: fresh.source, words: fresh.words || null }
  } catch (err) {
    errors.push('public:' + ((err && err.message) || String(err)))
  }
  // 三级全空：写入负缓存（10 分钟），下轮同曲直接短路
  sodaLyricMissCache.set(missKey, true)
  return { lyric: '', tlyric: '', source: 'none', error: errors.join('; ') || 'all-sources-empty', words: null }
}

// ─────────────────────────── 聚合能力：状态 / 榜单 / 日推 / 艺人 / 专辑 ───────────────────────────

/** 状态：无 cookie 返回未登录；有 cookie 校验 luna/pc/me 并带出 profile + membership */
async function handleSodaStatus(cookieText) {
  const cookie = normalizeSodaCookieInput(cookieText)
  const membershipFallback = sodaUnknownMembership('')
  const base = {
    provider: 'qishui',
    label: '汽水音乐',
    configured: true,
    loggedIn: false,
    membership: {
      isVip: false,
      isSvip: false,
      vipLabel: '无VIP',
      membershipKnown: false,
      vipLevel: 'unknown',
      expiresAt: 0,
      membershipStatus: 'unknown',
    },
  }
  if (!sodaCookieHasLogin(cookie)) return base
  try {
    const membership = await fetchSodaPlaybackMembership(cookie)
    const validated = !!membership.sessionValidated
    if (!validated) {
      // 会话无效或上游失败：如实报告未登录，附原因
      return Object.assign({}, base, {
        loggedIn: false,
        membership: {
          isVip: !!membership.isVip,
          isSvip: !!membership.isSvip,
          vipLabel: membership.vipLabel || '无VIP',
          membershipKnown: !!membership.membershipKnown,
          vipLevel: membership.vipLevel || 'unknown',
          expiresAt: Number(membership.expiresAt) || 0,
          membershipStatus: membership.membershipStatus || 'unknown',
        },
        error: membership.error || 'QISHUI_SESSION_INVALID',
      })
    }
    // profile 数据在 fetchSodaPlaybackMembership 内已随 /luna/pc/me 一次取回并随缓存返回；
    // 三要素齐全时不再二次串行请求同一端点（status 是前端打开/刷新的必经接口，
    // 原先缓存未命中时总延迟约翻倍）。
    let profile = {
      userId: membership.userId || '',
      nickname: membership.nickname || '',
      avatar: membership.avatar || '',
    }
    if (!profile.userId && !profile.nickname && !profile.avatar) {
      const profileSource = await sodaWebRequestJson('/luna/pc/me', sodaPcAppParams({}, cookie), cookie, {
        bases: [QISHUI_WEB_PC_API_BASE],
        noDefaultParams: true,
        sessionOnly: true,
        pcApp: true,
        timeoutMs: 6500,
      })
      profile = sodaProfileFromMeData((profileSource && profileSource.data) || profileSource || {})
    }
    return {
      provider: 'qishui',
      label: '汽水音乐',
      configured: true,
      loggedIn: true,
      profile: {
        userId: profile.userId || sodaCookieUserId(cookie),
        nickname: profile.nickname || '汽水音乐账号',
        avatarUrl: profile.avatar || '',
        vipLabel: membership.vipLabel || '无VIP',
        isVip: !!membership.isVip,
        isSvip: !!membership.isSvip,
        expiresAt: Number(membership.expiresAt) || 0,
      },
      membership: {
        isVip: !!membership.isVip,
        isSvip: !!membership.isSvip,
        vipLabel: membership.vipLabel || '无VIP',
        membershipKnown: !!membership.membershipKnown,
        vipLevel: membership.vipLevel || 'none',
        expiresAt: Number(membership.expiresAt) || 0,
        membershipStatus: membership.membershipStatus || (membership.isSvip ? 'svip' : membership.isVip ? 'vip' : 'free'),
      },
    }
  } catch (err) {
    void membershipFallback
    return Object.assign({}, base, { loggedIn: false, error: (err && err.message) || 'SODA_STATUS_FAILED' })
  }
}

// 榜单定义：固定关键词经公开目录搜索聚合（登录时优先 PC 会话搜索增强）
const SODA_CHART_DEFINITIONS = [
  { id: 'douyin-hot', name: '抖音热歌', keyword: '热歌', group: '抖音榜', description: '抖音站内正在热播的歌曲' },
  { id: 'douyin-new', name: '抖音新歌', keyword: '新歌', group: '抖音榜', description: '最近上线的全新歌曲' },
  { id: 'douyin-rise', name: '抖音飙升', keyword: '飙升', group: '抖音榜', description: '热度快速攀升的歌曲' },
  { id: 'douyin-pop', name: '流行精选', keyword: '流行', group: '抖音榜', description: '流行度高的人气歌曲' },
]

/** 榜单噪声过滤：公开搜索会命中两类垃圾——①标题≈关键词的歌（搜"热歌"返回《热歌》）②汇编合集（合集/串烧/DJ长串） */
function filterSodaChartNoise(songs, keyword) {
  const kw = sodaSearchComparable(keyword)
  const candidates = Array.isArray(songs) ? songs : []
  const COMPILATION_MARKS = ['合集', '串烧', '连播']
  const isNoise = (song) => {
    const rawTitle = String((song && song.name) || '')
    if (!rawTitle.trim()) return true
    const title = sodaSearchComparable(rawTitle)
    if (!title) return true
    // ① 标题与关键词完全同名（搜"热歌"返回《热歌》）→ 垃圾
    if (title === kw) return true
    return false
  }
  return candidates.filter(song => !isNoise(song))
}

/** 榜单聚合：每个榜单独立缓存（登录/未登录分别缓存），并行拉取，单项失败置空不影响其它 */
async function handleSodaCharts(cookieText, chartLimit) {
  const cookie = normalizeSodaCookieInput(cookieText)
  const loggedIn = sodaCookieHasLogin(cookie)
  const limit = Math.max(1, Math.min(30, Number(chartLimit) || 30))
  const charts = await Promise.all(
    SODA_CHART_DEFINITIONS.map(async (def) => {
      const cacheKey = def.id + '|' + (loggedIn ? sodaCookieFingerprint(cookie) : 'public') + '|' + limit
      let songs = []
      let error = ''
      try {
        songs = await sodaChartCache.wrap(cacheKey, 10 * 60 * 1000, async () => {
          const keep = (list) => {
            const filtered = filterSodaChartNoise(list, def.keyword)
            // 同名去重；含关键词 tag 的条目（真实歌曲的抖音版）沉底，真实歌曲优先
            const seenTitles = new Set()
            const clean = []
            const tagged = []
            for (const song of filtered) {
              const title = sodaSearchComparable(song && song.name)
              if (!title || seenTitles.has(title)) continue
              seenTitles.add(title)
              const kwC = sodaSearchComparable(def.keyword)
              if (kwC && title.includes(kwC)) tagged.push(song)
              else clean.push(song)
            }
            const out = [...clean, ...tagged].slice(0, limit)
            return out
          }
          if (loggedIn) {
            try {
              const pc = await handleSodaPcSearch(def.keyword, limit * 3, cookie, 0)
              if (pc.songs && pc.songs.length) return keep(pc.songs)
            } catch {
              /* PC 搜索失败回退公开目录 */
            }
          }
          // 多拉候选：噪声过滤后仍需填满榜单
          const pub = await handleSodaPublicSearch(def.keyword, limit * 3, '', 0)
          return keep(pub.songs || [])
        })
      } catch (err) {
        error = (err && err.message) || 'SODA_CHART_FAILED'
      }
      const chart = {
        id: def.id,
        name: def.name,
        group: def.group,
        description: def.description,
        songs: Array.isArray(songs) ? songs.slice(0, limit) : [],
      }
      if (error) chart.error = error
      return chart
    }),
  )
  return { charts }
}

/** 日推：登录走个性化 feed（personalized:true），未登录回退公开热歌 */
async function handleSodaDaily(cookieText, limit) {
  limit = Math.max(1, Math.min(50, Number(limit) || 20))
  const cookie = normalizeSodaCookieInput(cookieText)
  if (sodaCookieHasLogin(cookie)) {
    const feed = await fetchSodaWebFeedSongs(cookie, limit)
    if (feed.songs && feed.songs.length) {
      return { songs: feed.songs.slice(0, limit), personalized: true }
    }
    const pub = await handleSodaPublicSearch('热歌', limit * 3, '', 0)
    return {
      songs: filterSodaChartNoise(pub.songs || [], '热歌').slice(0, limit),
      personalized: false,
      message: '汽水个性化推荐暂不可用，已回退公开热歌。' + (feed.error ? '（' + feed.error + '）' : ''),
    }
  }
  const pub = await handleSodaPublicSearch('热歌', limit * 3, '', 0)
  return { songs: filterSodaChartNoise(pub.songs || [], '热歌').slice(0, limit), personalized: false }
}

/** 最近播放（只读）：复用账号库聚合缓存里 recentTracks（luna/pc/me/recently-played-media，
 *  已按 cookie 指纹 90s TTL 缓存），取前 N 条 mapSodaMedia 映射歌曲，不发额外上游请求 */
async function handleSodaRecentTracks(cookieText, limit) {
  limit = Math.max(1, Math.min(50, Number(limit) || 10))
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    return { loggedIn: false, songs: [] }
  }
  const library = await fetchSodaWebLibrary(cookie)
  return { loggedIn: true, songs: (library.recentTracks || []).slice(0, limit) }
}

/**
 * 专辑收藏状态检查（只读，尽力而为）：
 * 上游没有逐专辑的收藏状态读接口——只从账号库聚合缓存（fetchSodaWebLibrary，
 * 90s TTL/每 cookie 指纹；库冷却时最多补一次常规聚合请求）判归：
 * 收藏夹 shelf 卡片 id 命中、或「已收藏媒体」（likedTracks：collection/mixed 等显式收藏动作读取）
 * 内映射出的专辑 id/同名命中即 collected:true；
 * 未命中返回 known:false（证据不足 ≠ 确认未收藏），前端保持默认未收藏即可。
 */
async function handleSodaAlbumCollectCheck(albumKey, cookieText) {
  const key = normalizeText(albumKey)
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!key || !sodaCookieHasLogin(cookie)) {
    return { id: key, loggedIn: false, collected: false, known: false }
  }
  const library = await fetchSodaWebLibrary(cookie)
  // 外部约定汽水专辑标识可能传真实数字 id，也可能传「专辑名」原串（AlbumDetailModal 同口径），两种都认
  const nameKey = /^\d+$/.test(key) ? '' : key.toLowerCase()
  const matchSong = (song) =>
    !!song && (
      (song.albumId ? String(song.albumId) === key : false) ||
      (!!nameKey && String(song.album || '').trim().toLowerCase() === nameKey)
    )
  let collected = false
  let via = ''
  if ((library.playlists || []).some((pl) => pl && String(pl.id) === key)) {
    collected = true
    via = 'shelf-card'
  } else if ((library.likedTracks || []).some(matchSong)) {
    collected = true
    via = 'collected-media'
  }
  return { id: key, loggedIn: true, collected, known: true, via: via || undefined }
}

/** 艺人歌曲：公开搜索 + 按歌手名相关性排序（rankSodaPublicSongs 已内置歌手权重） */
async function handleSodaArtistSongs(artistName, limit, cookieText) {
  artistName = normalizeText(artistName)
  limit = Math.max(1, Math.min(50, Number(limit) || 30))
  if (!artistName) throw new Error('缺少歌手名')
  const result = await handleSodaSearch(artistName, Math.min(100, limit * 3), cookieText, 0)
  const songs = rankSodaPublicSongs(result.songs || [], artistName, limit)
  return { artist: { name: artistName }, songs }
}

function sodaAlbumMatches(songAlbum, keywords) {
  const album = sodaSearchComparable(songAlbum)
  const query = sodaSearchComparable(keywords)
  if (!album || !query) return false
  return album === query || (album.includes(query) && album.length <= query.length * 3) || (query.includes(album) && album.length >= 2)
}

/** 专辑歌曲（尽力而为）：搜索歌曲名/专辑名后按专辑名过滤聚拢 */
async function handleSodaAlbumTracks(albumName, albumId, limit, cookieText) {
  albumName = normalizeText(albumName)
  albumId = normalizeText(albumId)
  limit = Math.max(1, Math.min(50, Number(limit) || 50))
  if (!albumName && !albumId) throw new Error('缺少专辑名或专辑 id')
  const keyword = albumName || albumId
  const result = await handleSodaSearch(keyword, 50, cookieText, 0)
  const all = result.songs || []
  const tracks = all.filter((song) => (albumName ? sodaAlbumMatches(song.album, albumName) : song.albumId === albumId)).slice(0, limit)
  const firstWithAlbum = tracks.find((song) => song.album) || null
  const album = {
    name: firstWithAlbum ? firstWithAlbum.album : keyword,
  }
  if (firstWithAlbum && firstWithAlbum.albumId) album.id = firstWithAlbum.albumId
  if (firstWithAlbum && firstWithAlbum.coverUrl) album.coverUrl = firstWithAlbum.coverUrl
  return { album, tracks, message: tracks.length ? '' : '未能通过搜索定位到该专辑的曲目，仅供参考。' }
}

// ─────────────────────────── 搜索派生端点（suggest / artists / albums）───────────────────────────
// 三者都复用 handleSodaSearch（登录优先 PC 会话搜索、失败/未登录回退火山公开目录，与 /api/soda/search
// 同模式同缓存），只在上游一次搜索结果上做本地派生聚合；各带短 TTL 缓存（createTtlCache.wrap 自带
// 同 key 并发去重，同关键词并发只打一次上游）。

/**
 * 从统一 SodaSong 提取歌手名列表：优先 artists 数组，否则按既有分隔符拆 artist 串；
 * 两者都再做一次既有拆法二次拆分——公开目录 author_info 常见「A/B」「A,B」合并形态
 * （如 "周杰伦/那英"），派生聚合前须拆成单名（拆法与 sodaArtists 回退路径一致）。
 */
function sodaSongArtistNames(song) {
  const rawNames =
    song && Array.isArray(song.artists) && song.artists.length
      ? song.artists.map((item) => normalizeText(item && item.name)).filter(Boolean)
      : [normalizeText(song && song.artist)]
  return rawNames.flatMap((name) =>
    name.split(SODA_ARTIST_NAME_SPLIT_RE).map((part) => normalizeText(part)).filter(Boolean),
  )
}

/** 歌手名 → 头像映射（仅上游结果带头像字段时非空；供派生歌手端点透传 avatarUrl） */
function sodaSongArtistAvatarMap(song) {
  const map = new Map()
  if (song && Array.isArray(song.artists)) {
    song.artists.forEach((item) => {
      const avatar = normalizeText(item && item.avatarUrl)
      if (!avatar) return
      // 合并形态条目（"A/B"）的头像登记到拆分后的每个单名上（上游对合并条目通常也不带头像，实际影响小）
      sodaSongArtistNames({ artists: [item] }).forEach((name) => {
        if (name && !map.has(name)) map.set(name, avatar)
      })
    })
  }
  return map
}

/** 派生端点排序：与关键词前缀匹配者优先 → 其余维持上游相关性顺序（稳定排序） */
function sodaDerivedRelevanceRank(text, query) {
  const comparable = sodaSearchComparable(text)
  if (!query || !comparable) return 0
  if (comparable.startsWith(query)) return 2
  if (comparable.includes(query)) return 1
  return 0
}

/**
 * 搜索联想（派生端点）：一次轻量搜索（limit 20）→ 歌曲名/歌手名/专辑名候选去重。
 * type ∈ 'song' | 'artist' | 'album'；未命中返回空 suggestions。
 */
/** 客户端搜索联想：GET /luna/pc/sug（sugs[] = { suggestion, content_type, entity:{artist|playlist|...}, group_id }） */
async function fetchSodaPcSug(keywords, cookieText) {
  const json = await sodaWebRequestJson('/luna/pc/sug', sodaPcAppParams({ q: keywords }, cookieText), cookieText, {
    bases: [QISHUI_WEB_PC_API_BASE],
    noDefaultParams: true,
    sessionOnly: true,
    pcApp: true,
    timeoutMs: 5000,
  })
  const data = (json && json.data) || json || {}
  return pickArray(data.sugs, data.suggestions, json && json.sugs)
}

/**
 * 上游 sug 项 → 统一联想结构。
 * 保留 content_type 与实体主键：客户端点歌手/歌单联想是直接跳详情页的，只有文本没法复刻这个行为。
 */
function mapSodaSugItem(raw) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const text = normalizeText(raw.suggestion || raw.text || raw.word || raw.query)
  if (!text) return null
  const entity = pickObject(raw.entity) || {}
  const artist = pickObject(entity.artist) || {}
  const playlist = pickObject(entity.playlist) || {}
  const track = pickObject(entity.track) || {}
  const album = pickObject(entity.album) || {}
  const id = normalizeText(artist.id || playlist.id || track.id || album.id || '')
  const declared = normalizeText(raw.content_type || raw.contentType || raw.type).toLowerCase()
  const type = declared || (artist.id ? 'artist' : playlist.id ? 'playlist' : album.id ? 'album' : 'song')
  const out = { text, type }
  if (id) out.id = id
  const groupId = normalizeText(raw.group_id || raw.groupId)
  if (groupId) out.groupId = groupId
  return out
}

async function handleSodaSearchSuggest(keywords, limit, cookieText) {
  keywords = normalizeText(keywords)
  limit = Math.max(1, Math.min(20, Number(limit) || 8))
  if (!keywords) return { suggestions: [] }
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const cacheKey =
    'suggest|' + keywords.toLowerCase() + '|' + limit + '|' + (loggedIn ? sodaCookieFingerprint(cookieText) : 'public')
  return sodaSuggestCache.wrap(cacheKey, 2 * 60 * 1000, async () => {
    // 优先用客户端真实联想接口（带 entity id，可直接跳转）
    if (loggedIn) {
      try {
        const raw = await fetchSodaPcSug(keywords, cookieText)
        const suggestions = raw.map(mapSodaSugItem).filter(Boolean).slice(0, limit)
        if (suggestions.length) return { suggestions, source: 'pc-sug' }
      } catch {
        /* 失败回退派生候选 */
      }
    }
    const result = await handleSodaSearch(keywords, 20, cookieText, 0)
    const query = sodaSearchComparable(keywords)
    const seen = new Set()
    const candidates = []
    const push = (text, type) => {
      text = normalizeText(text)
      if (!text) return
      const key = sodaSearchComparable(text)
      if (!key || seen.has(key)) return
      seen.add(key)
      candidates.push({ text, type, prefix: sodaDerivedRelevanceRank(text, query) === 2 })
    }
    for (const song of result.songs || []) {
      push(song.name, 'song')
      sodaSongArtistNames(song).forEach((name) => push(name, 'artist'))
      push(song.album, 'album')
    }
    // 前缀匹配优先，其余保持上游相关性顺序（sort 稳定）
    candidates.sort((a, b) => (a.prefix === b.prefix ? 0 : a.prefix ? -1 : 1))
    return { suggestions: candidates.slice(0, limit).map(({ text, type }) => ({ text, type })), source: 'derived' }
  })
}

/**
 * 搜索歌手聚合（派生端点）：搜索（limit 50）→ 按歌手名聚合去重（多歌手拆分沿用模块内既有拆法，
 * 见 SODA_ARTIST_NAME_SPLIT_RE）→ songCount 聚合计数；按"关键词相关度 → 计数（热度）→ 上游顺序"排序。
 * id = 歌手名（与现有伪艺人按名检索 /api/soda/artist/songs?name= 的约定一致）；
 * avatarUrl 仅上游结果带头像字段才透传，缺失不出该字段。
 */
async function handleSodaSearchArtists(keywords, limit, cookieText) {
  keywords = normalizeText(keywords)
  limit = Math.max(1, Math.min(50, Number(limit) || 10))
  if (!keywords) return { artists: [] }
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const cacheKey =
    'search-artists|' + keywords.toLowerCase() + '|' + limit + '|' + (loggedIn ? sodaCookieFingerprint(cookieText) : 'public')
  return sodaSearchArtistsCache.wrap(cacheKey, 2 * 60 * 1000, async () => {
    const result = await handleSodaSearch(keywords, 50, cookieText, 0)
    const query = sodaSearchComparable(keywords)
    const byName = new Map()
    for (const song of result.songs || []) {
      const avatars = sodaSongArtistAvatarMap(song)
      for (const name of sodaSongArtistNames(song)) {
        const key = sodaSearchComparable(name)
        if (!key) continue
        let entry = byName.get(key)
        if (!entry) {
          entry = { name, songCount: 0, avatarUrl: '', order: byName.size }
          byName.set(key, entry)
        }
        entry.songCount += 1
        if (!entry.avatarUrl) entry.avatarUrl = avatars.get(name) || ''
      }
    }
    const artists = Array.from(byName.values())
      .sort((a, b) => {
        const relA = sodaDerivedRelevanceRank(a.name, query)
        const relB = sodaDerivedRelevanceRank(b.name, query)
        if (relA !== relB) return relB - relA
        if (a.songCount !== b.songCount) return b.songCount - a.songCount
        return a.order - b.order
      })
      .slice(0, limit)
      .map((entry) => {
        const artist = { id: entry.name, name: entry.name, songCount: entry.songCount, source: 'soda-search-derived' }
        if (entry.avatarUrl) artist.avatarUrl = entry.avatarUrl
        return artist
      })
    return { artists }
  })
}

/**
 * 搜索专辑聚合（派生端点）：搜索（limit 50）→ 按「专辑名+歌手」键聚拢（sodaSearchComparable 归一后
 * 合并大小写/空白变体，与 /api/soda/album/tracks 的按名归拢同口径）→ 封面取组内首曲封面。
 * id 优先取组内真实 albumId，缺失回退专辑名（专辑详情端点按名/按 id 双口径均可消费）。
 */
async function handleSodaSearchAlbums(keywords, limit, cookieText) {
  keywords = normalizeText(keywords)
  limit = Math.max(1, Math.min(50, Number(limit) || 10))
  if (!keywords) return { albums: [] }
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const cacheKey =
    'search-albums|' + keywords.toLowerCase() + '|' + limit + '|' + (loggedIn ? sodaCookieFingerprint(cookieText) : 'public')
  return sodaSearchAlbumsCache.wrap(cacheKey, 2 * 60 * 1000, async () => {
    const result = await handleSodaSearch(keywords, 50, cookieText, 0)
    const query = sodaSearchComparable(keywords)
    const byKey = new Map()
    for (const song of result.songs || []) {
      const name = normalizeText(song.album)
      if (!name) continue
      const artistName = sodaSongArtistNames(song)[0] || normalizeText(song.artist) || ''
      const albumId = normalizeText(song.albumId)
      const key = sodaSearchComparable(name) + '|' + sodaSearchComparable(artistName)
      let entry = byKey.get(key)
      if (!entry) {
        entry = { id: albumId || name, name, artist: artistName, picUrl: normalizeText(song.coverUrl) || '', songCount: 0, order: byKey.size }
        byKey.set(key, entry)
      }
      entry.songCount += 1
      if (!entry.picUrl) entry.picUrl = normalizeText(song.coverUrl) || ''
      if (!/^\d+$/.test(entry.id) && albumId) entry.id = albumId
    }
    const albums = Array.from(byKey.values())
      .sort((a, b) => {
        const relA = sodaDerivedRelevanceRank(a.name, query)
        const relB = sodaDerivedRelevanceRank(b.name, query)
        if (relA !== relB) return relB - relA
        if (a.songCount !== b.songCount) return b.songCount - a.songCount
        return a.order - b.order
      })
      .slice(0, limit)
      .map((entry) => {
        const album = { id: entry.id, name: entry.name, artist: entry.artist, songCount: entry.songCount, source: 'soda-search-derived' }
        if (entry.picUrl) album.picUrl = entry.picUrl
        return album
      })
    return { albums }
  })
}

// ─────────────────────────── 路由注册 ───────────────────────────

/** 本次请求的汽水 cookie（GET query 或 POST body；只读使用，绝不落盘/回写任何全局） */
function sodaRequestCookie(req) {
  const raw = req.query && req.query.cookie != null ? req.query.cookie : req.body && req.body.cookie
  return normalizeSodaCookieInput(raw)
}

function sodaRequireLogin(res, cookie) {
  if (sodaCookieHasLogin(cookie)) return true
  res.status(401).json({ error: '需要汽水音乐（抖音会话）登录态：请在请求中携带 cookie 参数' })
  return false
}

function sodaClampInt(value, defaultValue, min, max) {
  const num = Math.floor(Number(value))
  if (!Number.isFinite(num)) return defaultValue
  return Math.max(min, Math.min(max, num))
}

/** 统一错误出口：登录类错误 401，其余 500，均带中文 error 文案 */
function sodaSendError(res, tag, err, extra) {
  console.error('[Soda/' + tag + ']', (err && err.message) || err)
  const message = String((err && err.message) || err || '请求失败')
  const isLoginError = err && (err.code === 'QISHUI_COOKIE_REQUIRED') || /COOKIE_REQUIRED|login_required/i.test(message)
  res.status(isLoginError ? 401 : 502).json(Object.assign({ error: message }, extra || {}))
}

export function registerSodaRoutes(app) {
  // 1. 状态（无需 cookie 也 200：loggedIn:false）
  app.get('/api/soda/status', async (req, res) => {
    try {
      res.json(await handleSodaStatus(sodaRequestCookie(req)))
    } catch (err) {
      sodaSendError(res, 'Status', err)
    }
  })

  // 2. 搜索：登录优先 PC 会话搜索，失败/未登录回退火山公开目录
  app.get('/api/soda/search', async (req, res) => {
    try {
      const keywords = String(req.query.keywords || req.query.keyword || '').trim()
      if (!keywords) return res.status(400).json({ error: '缺少关键词 keywords' })
      const limit = sodaClampInt(req.query.limit, 20, 1, 50)
      const offset = sodaClampInt(req.query.offset, 0, 0, 100000)
      const searchType = sodaNormalizeSearchType(req.query.type || req.query.searchType || req.query.search_type)
      const result = await handleSodaSearch(keywords, limit, sodaRequestCookie(req), offset, searchType)
      // 分页状态（升级用可选字段）：诚实透出内部判定——PC 会话搜索单独凭上游 has_more/游标，公开目录按
      // 本页填充数 + 候选窗口余量判定；hasMore:false 时不下发 nextOffset，避免暗示还有下一页
      const hasMore = !!result.hasMore
      res.json({
        songs: result.songs || [],
        // 客户端 Search 的多类型结果（search_type=all 时同时下发；单类型时仅对应数组非空）
        playlists: result.playlists || undefined,
        artists: result.artists || undefined,
        albums: result.albums || undefined,
        groups: result.groups || undefined,
        searchType,
        source: result.source || '',
        message: result.message || undefined,
        hasMore,
        nextOffset: hasMore ? Number(result.nextOffset) || undefined : undefined,
        // 客户端按上游游标翻页；透出以便前端与服务端一致地续拉
        nextCursor: hasMore ? result.nextCursor || undefined : undefined,
      })
    } catch (err) {
      sodaSendError(res, 'Search', err, { songs: [] })
    }
  })

  // 2.1 搜索联想（派生端点：歌曲名/歌手名/专辑名候选；契约约定失败/未命中一律 200 + 空 suggestions）
  app.get('/api/soda/search/suggest', async (req, res) => {
    const keywords = String(req.query.keywords || req.query.keyword || '').trim()
    const limit = sodaClampInt(req.query.limit, 8, 1, 20)
    try {
      const result = await handleSodaSearchSuggest(keywords, limit, sodaRequestCookie(req))
      res.json({ suggestions: result.suggestions || [] })
    } catch (err) {
      console.error('[Soda/SearchSuggest]', (err && err.message) || err)
      res.json({ suggestions: [], error: String((err && err.message) || err || '请求失败') })
    }
  })

  // 2.2 搜索歌手聚合（派生端点：按歌手名聚合去重 + 热度计数排序；id=歌手名，与伪艺人按名检索约定一致）
  app.get('/api/soda/search/artists', async (req, res) => {
    try {
      const keywords = String(req.query.keywords || req.query.keyword || '').trim()
      if (!keywords) return res.json({ artists: [] })
      const limit = sodaClampInt(req.query.limit, 10, 1, 50)
      const result = await handleSodaSearchArtists(keywords, limit, sodaRequestCookie(req))
      res.json({ artists: result.artists || [] })
    } catch (err) {
      sodaSendError(res, 'SearchArtists', err, { artists: [] })
    }
  })

  // 2.3 搜索专辑聚合（派生端点：按「专辑名+歌手」聚拢，封面取组内首曲封面）
  app.get('/api/soda/search/albums', async (req, res) => {
    try {
      const keywords = String(req.query.keywords || req.query.keyword || '').trim()
      if (!keywords) return res.json({ albums: [] })
      const limit = sodaClampInt(req.query.limit, 10, 1, 50)
      const result = await handleSodaSearchAlbums(keywords, limit, sodaRequestCookie(req))
      res.json({ albums: result.albums || [] })
    } catch (err) {
      sodaSendError(res, 'SearchAlbums', err, { albums: [] })
    }
  })

  // 3. 个性化推荐 feed（需登录；cursor 可选透传上游翻页，回程带 nextCursor/hasMore 可选字段）
  app.get('/api/soda/feed', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const limit = sodaClampInt(req.query.limit, 12, 1, 50)
      const cursor = normalizeText(req.query.cursor)
      // 场景模式：sceneModeId（服务端场景）或 preferenceMode（familiar/fresh）
      const sceneModeId = sodaClampInt(req.query.sceneModeId || req.query.scene_mode_id, 0, 0, 9999)
      const preferenceMode = normalizeText(req.query.preferenceMode || req.query.preference_mode)
      // 已听曲目（客户端的分页手段）：逗号分隔的 track id
      const playedIds = normalizeText(req.query.playedIds || req.query.played_ids)
        ? String(req.query.playedIds || req.query.played_ids).split(',').map((s) => s.trim()).filter(Boolean)
        : []
      const feed = await fetchSodaWebFeedSongs(cookie, limit, cursor, { sceneModeId, preferenceMode, playedIds })
      res.json({
        name: normalizeText(req.query.name) || (sceneModeId || preferenceMode ? '场景推荐' : '汽水推荐'),
        songs: feed.songs || [],
        error: feed.error || undefined,
        nextCursor: feed.nextCursor || undefined,
        hasMore: feed.hasMore == null ? undefined : !!feed.hasMore,
        // 上游没有游标：下一页 = 带上 playedIds 再请求一次（客户端同款语义）
        cursorless: !!feed.cursorless,
        source: feed.source || undefined,
      })
    } catch (err) {
      sodaSendError(res, 'Feed', err, { songs: [] })
    }
  })

  // 3b. 听歌模式：场景列表（客户端 FeedMode → GET /luna/pc/feed/mode）
  app.get('/api/soda/feed-mode', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const result = await handleSodaFeedMode(cookie, { full: String(req.query.full || '') === '1' })
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'FeedMode', err, { modes: [] })
    }
  })

  // 3b-2. 探索页正文：手机端 /luna/discover 的全部卡片板块（带每块标题）
  app.get('/api/soda/discover', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const result = await handleSodaDiscoverSections(cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'Discover', err, { sections: [] })
    }
  })

  // 3b-3. 歌单广场（分类标签 + 歌单卡片）
  app.get('/api/soda/playlist-square', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      const result = await handleSodaPlaylistSquare(cookie, {
        categoryId: normalizeText(req.query.categoryId || req.query.category_id),
      })
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'PlaylistSquare', err, { items: [], categories: [] })
    }
  })

  // 3b-4. 「适合『听』的视频」（手机端听抖音 tab 的内容）
  app.get('/api/soda/listen-video', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const result = await handleSodaListenVideo(cookie, {
        count: sodaClampInt(req.query.count || req.query.limit, 12, 1, 30),
        categoryId: normalizeText(req.query.categoryId || req.query.category_id),
      })
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'ListenVideo', err, { items: [] })
    }
  })

  // 3c. 听歌模式下半屏：探索更多新模式（DiscoverView / DiscoverMix）
  app.get('/api/soda/discover/mix', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const exposure = normalizeText(req.query.exposure)
        ? String(req.query.exposure).split(',').map((s) => s.trim()).filter(Boolean)
        : []
      const result = await handleSodaDiscoverMix(cookie, { cursor: normalizeText(req.query.cursor), exposure })
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'DiscoverMix', err, { items: [] })
    }
  })

  // 3d. 电台拉歌（探索卡片里 type=radio 的项）
  app.get('/api/soda/radio/tracks', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const radioId = normalizeText(req.query.id || req.query.radioId || req.query.radio_id)
      if (!radioId) return res.status(400).json({ error: '缺少电台 id' })
      const result = await handleSodaRadioTracks(cookie, radioId, {
        cursor: normalizeText(req.query.cursor),
        link: normalizeText(req.query.link),
      })
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'RadioTracks', err, { songs: [] })
    }
  })

  // 4. 用户歌单（含我喜欢/最近播放/推荐三个虚拟歌单）
  app.get('/api/soda/user/playlists', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const library = await fetchSodaWebLibrary(cookie)
      const likedTracks = library.likedTracks || []
      const likedCard = library.likedCard || {}
      const playlists = [
        {
          id: SODA_WEB_LIKED_PLAYLIST_ID,
          name: '我喜欢的音乐',
          coverUrl: likedCard.cover || likedTracks.map((song) => song.coverUrl).find(Boolean) || '',
          trackCount: likedTracks.length || Number(likedCard.trackCount) || 0,
          isLikedLike: true,
          // 客户端 Sidebar 的「我喜欢的音乐」= playlist.type === 1
          type: 1,
        },
      ]
      ;(library.playlists || []).forEach((pl) => {
        if (!pl || !pl.id) return
        if (playlists.some((item) => item.id === pl.id)) return
        playlists.push({
          id: pl.id,
          name: pl.name,
          coverUrl: pl.cover || '',
          trackCount: Number(pl.trackCount) || 0,
          isLikedLike: sodaPlaylistLikeName(pl.name),
          collected: !pl.owned,
          // 客户端歌单类型（1 我喜欢 / 4 抖音收藏 / 2|3|11 自建），供前端区分入口
          type: Number(pl.playlistType) || 0,
        })
      })
      const recentTracks = library.recentTracks || []
      if (recentTracks.length) {
        playlists.push({
          id: SODA_WEB_RECENT_PLAYLIST_ID,
          name: '历史播放',
          coverUrl: recentTracks.map((song) => song.coverUrl).find(Boolean) || '',
          trackCount: recentTracks.length,
          isLikedLike: false,
          type: 0,
        })
      }
      res.json({ playlists, likedPlaylistId: SODA_WEB_LIKED_PLAYLIST_ID, libraryErrors: library.errors || [] })
    } catch (err) {
      sodaSendError(res, 'UserPlaylists', err, { playlists: [] })
    }
  })

  // 5. 歌单详情/曲目（支持 qishui-feed / qishui-liked / qishui-recent 虚拟 id）
  // [诊断] 仅在测试端口(3999)暴露：抓 track_v2 原始上游响应，定位『无效 JSON』
  app.get('/api/soda/_debug/trackv2', async (req, res) => {
    if (String(process.env.PORT || '3001') !== '3999') return res.status(404).json({ error: 'not available' })
    try {
      const cookie = sodaRequestCookie(req)
      const id = normalizeText(String(req.query.id || ''))
      const target = qishuiPcUrl('/luna/pc/track_v2', sodaPcAppParams({ track_id: id, media_type: 'track' }, cookie))
      const resp = await fetch(target, { headers: sodaWebHeaders(cookie, { sessionOnly: true, pcApp: true }), signal: AbortSignal.timeout(15000) })
      const ct = resp.headers.get('content-type') || ''
      const text = await resp.text()
      res.json({ status: resp.status, contentType: ct, bodyLen: text.length, bodyHead: text.slice(0, 500) })
    } catch (e) {
      res.status(502).json({ error: String((e && e.message) || e) })
    }
  })

  app.get('/api/soda/playlist/tracks', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(String(req.query.id || '').replace(/^qishui:/i, ''))
      if (!id) return res.status(400).json({ error: '缺少歌单 id' })
      const limit = sodaClampInt(req.query.limit, 50, 1, 50)
      const offset = sodaClampInt(req.query.offset, 0, 0, 100000)

      const respondVirtual = (playlistId, name, allSongs, extraCover) => {
        const tracks = allSongs.slice(offset, offset + limit)
        res.json({
          id: playlistId,
          name,
          coverUrl: extraCover || tracks.map((song) => song.coverUrl).find(Boolean) || '',
          trackCount: allSongs.length,
          tracks,
          nextOffset: offset + tracks.length,
          hasMore: offset + tracks.length < allSongs.length,
        })
      }

      if (id === SODA_WEB_LIKED_PLAYLIST_ID || id === 'liked' || id === 'favorite') {
        const library = await fetchSodaWebLibrary(cookie)
        let allSongs = library.likedTracks || []
        // 我喜欢轨道缺失时回退到真实「我喜欢」歌单详情
        if (!allSongs.length && library.likedCard && library.likedCard.id) {
          const detail = await fetchSodaWebPlaylistTracks(library.likedCard.id, cookie, { limit, offset }).catch(() => null)
          if (detail && Array.isArray(detail.tracks)) {
            return res.json({
              id: SODA_WEB_LIKED_PLAYLIST_ID,
              name: '汽水我的喜欢',
              coverUrl: (library.likedCard && library.likedCard.cover) || detail.coverUrl || '',
              trackCount: detail.total || detail.tracks.length,
              tracks: detail.tracks,
              nextOffset: detail.nextOffset,
              hasMore: !!detail.hasMore,
            })
          }
        }
        return respondVirtual(SODA_WEB_LIKED_PLAYLIST_ID, '汽水我的喜欢', allSongs, (library.likedCard && library.likedCard.cover) || '')
      }
      if (id === SODA_WEB_RECENT_PLAYLIST_ID || id === 'recent') {
        const library = await fetchSodaWebLibrary(cookie)
        return respondVirtual(SODA_WEB_RECENT_PLAYLIST_ID, '汽水最近播放', library.recentTracks || [])
      }
      if (id === SODA_VIRTUAL_FEED_PLAYLIST_ID || id === 'feed') {
        const feed = await fetchSodaWebFeedSongs(cookie, Math.max(limit, 12))
        return respondVirtual(SODA_VIRTUAL_FEED_PLAYLIST_ID, '汽水推荐', feed.songs || [])
      }
      const detail = await fetchSodaWebPlaylistTracks(id, cookie, { limit, offset })
      if (detail && detail.error === 'QISHUI_COOKIE_REQUIRED') {
        return res.status(401).json({ error: '需要汽水音乐（抖音会话）登录态' })
      }
      res.json({
        id: detail.id,
        name: detail.name || '汽水歌单',
        coverUrl: detail.coverUrl || '',
        trackCount: Number(detail.total) || (detail.tracks || []).length,
        tracks: detail.tracks || [],
        nextOffset: detail.nextOffset,
        hasMore: !!detail.hasMore,
      })
    } catch (err) {
      sodaSendError(res, 'PlaylistTracks', err, { tracks: [] })
    }
  })

  // 6. 批量检查是否已喜欢
  app.get('/api/soda/song/like/check', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const ids = sodaCollectionIds(String(req.query.ids || req.query.id || ''))
      if (!ids.length) return res.json({ liked: {}, complete: true })
      const result = await handleSodaCheckTracksLiked(ids, cookie)
      res.json({ liked: result.liked || {}, complete: result.complete, checkedCount: result.checkedCount })
    } catch (err) {
      sodaSendError(res, 'LikeCheck', err, { liked: {} })
    }
  })

  // 7. 喜欢/取消喜欢（body: { id, like, song?, cookie }；song 仅透传预留，帮助前端语义完整）
  app.post('/api/soda/song/like', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const song = body.song && typeof body.song === 'object' ? body.song : {}
      const id = normalizeText(body.id || song.id || song.providerSongId || song.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const like = sodaWriteEnabled(body.like != null ? body.like : true)
      await handleSodaSetTrackLiked(id, like, cookie)
      res.json({ success: true, id, like: like })
    } catch (err) {
      sodaSendError(res, 'Like', err)
    }
  })

  // 8. 歌单加歌（body: { pid, song:{id,...}, cookie }）
  app.post('/api/soda/playlist/add-song', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const song = body.song && typeof body.song === 'object' ? body.song : {}
      const pid = normalizeText(String(body.pid || body.playlistId || ''))
      const songId = normalizeText(song.id || song.providerSongId || body.id)
      if (!pid) return res.status(400).json({ error: '缺少歌单 id（pid）' })
      if (!songId) return res.status(400).json({ error: '缺少歌曲 id（song.id）' })
      await handleSodaPlaylistAddSong(pid, { id: songId }, cookie)
      res.json({ success: true, pid, id: songId })
    } catch (err) {
      sodaSendError(res, 'PlaylistAddSong', err)
    }
  })

  // 9. 收藏/取消收藏歌单（body: { id, collected, cookie }）
  app.post('/api/soda/playlist/collect', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(String(body.id || body.playlistId || ''))
      if (!id) return res.status(400).json({ error: '缺少歌单 id' })
      const collected = sodaWriteEnabled(body.collected != null ? body.collected : true)
      await handleSodaSetPlaylistCollected(id, collected, cookie)
      res.json({ success: true, id, collected })
    } catch (err) {
      sodaSendError(res, 'PlaylistCollect', err)
    }
  })

  // 8b. 创建歌单（body: { name, isPrivate, cookie }）
  app.post('/api/soda/playlist/create', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const name = normalizeText(body.name || body.title)
      if (!name) return res.status(400).json({ error: '缺少歌单名称' })
      const result = await handleSodaCreatePlaylist(name, body.isPrivate === true || body.is_private === true, cookie)
      res.json({ success: true, ...result })
    } catch (err) {
      sodaSendError(res, 'PlaylistCreate', err)
    }
  })

  // 8c. 删除歌单（body: { id, cookie }）
  app.post('/api/soda/playlist/delete', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(String(body.id || body.playlistId || ''))
      if (!id) return res.status(400).json({ error: '缺少歌单 id' })
      const result = await handleSodaDeletePlaylist(id, cookie)
      res.json({ success: true, ...result })
    } catch (err) {
      sodaSendError(res, 'PlaylistDelete', err)
    }
  })

  // 10. 收藏/取消收藏专辑（body: { id, collected, cookie }）
  app.post('/api/soda/album/collect', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(String(body.id || body.albumId || ''))
      if (!id) return res.status(400).json({ error: '缺少专辑 id' })
      const collected = sodaWriteEnabled(body.collected != null ? body.collected : true)
      await handleSodaSetAlbumCollected(id, collected, cookie)
      res.json({ success: true, id, collected })
    } catch (err) {
      sodaSendError(res, 'AlbumCollect', err)
    }
  })

  // 11. 上报最近播放（body: { id, cookie }）
  app.post('/api/soda/report/play', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(body.id || body.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      await handleSodaReportRecentlyPlayed(id, cookie)
      res.json({ success: true, id })
    } catch (err) {
      sodaSendError(res, 'ReportPlay', err)
    }
  })

  // 12. 评论：GET 读列表 / POST 发评论（同路径）
  app.get('/api/soda/song/comments', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const limit = sodaClampInt(req.query.limit, 18, 1, 50)
      const cursor = String(req.query.cursor || '')
      const result = await handleSodaComments(id, { limit, cursor }, cookie)
      res.json({
        comments: result.comments,
        cursor: result.nextCursor || undefined,
        hasMore: !!result.hasMore,
        total: result.total,
      })
    } catch (err) {
      sodaSendError(res, 'Comments', err, { comments: [] })
    }
  })
  app.post('/api/soda/song/comments', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(body.id || body.trackId)
      const content = normalizeLyricBody(body.content || body.text)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      if (!content) return res.status(400).json({ error: '缺少评论内容' })
      const result = await handleSodaCreateComment(id, content, cookie)
      res.json({ success: true, comment: result.comment || undefined })
    } catch (err) {
      sodaSendError(res, 'CommentCreate', err)
    }
  })
  // 12b. 评论回复列表（客户端 ListReplies：GET /luna/pc/comments/{id}/replies）
  app.get('/api/soda/comment/replies', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const commentId = normalizeText(req.query.commentId || req.query.id || req.query.comment_id)
      if (!commentId) return res.status(400).json({ error: '缺少评论 id' })
      const limit = Number(req.query.limit || req.query.count) || 20
      const cursor = normalizeText(req.query.cursor || '')
      const result = await handleSodaCommentReplies(commentId, { count: limit, cursor }, cookie)
      res.json({
        replies: result.replies,
        hasMore: !!result.hasMore,
        total: result.total,
        cursor: result.cursor,
        nextCursor: result.nextCursor,
      })
    } catch (err) {
      sodaSendError(res, 'CommentReplies', err, { replies: [] })
    }
  })
  // 12c. 评论点赞/取消（客户端 CommentAction：POST /luna/pc/comments/action，type 1=赞 3=取消）
  app.post('/api/soda/comment/action', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const commentId = normalizeText(body.commentId || body.comment_id || body.id)
      if (!commentId) return res.status(400).json({ error: '缺少评论 id' })
      const result = await handleSodaCommentAction(
        commentId,
        {
          liked: body.liked !== false && body.type !== 3,
          replyId: body.replyId || body.reply_id,
          groupId: body.groupId || body.group_id,
          sceneName: body.sceneName || body.scene_name,
        },
        cookie,
      )
      res.json({ success: true, ...result })
    } catch (err) {
      sodaSendError(res, 'CommentAction', err)
    }
  })
  // 12d. 删除评论（客户端 DeleteComment：POST /luna/pc/comments/delete）
  app.post('/api/soda/comment/delete', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const commentId = normalizeText(body.commentId || body.comment_id || body.id)
      if (!commentId) return res.status(400).json({ error: '缺少评论 id' })
      const result = await handleSodaDeleteComment(commentId, body.replyId || body.reply_id, cookie)
      res.json({ success: true, ...result })
    } catch (err) {
      sodaSendError(res, 'CommentDelete', err)
    }
  })

  // 13. 播放地址（核心：track_v2 + 会员分层过滤；不可播时 url='' + playable:false + reason）
  app.get('/api/soda/song/url', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const result = await handleSodaSongUrl({ id, quality: String(req.query.quality || '') }, cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'SongUrl', err, { url: '', playable: false })
    }
  })

  /**
   * POST 版 song/url：限免凭证（limited_free_info 整份对象）走 body 传。
   * 用 POST 而不是把对象塞进 query，是因为凭证里的字段（config/intercept_type/…）会被
   * URL 编码膨胀好几倍，且 GET query 天然不适合传结构化对象。
   */
  app.post('/api/soda/song/url', async (req, res) => {
    try {
      const body = req.body || {}
      const cookie = normalizeSodaCookieInput(body.cookie)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(body.id || body.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const result = await handleSodaSongUrl(
        {
          id,
          quality: String(body.quality || ''),
          limitedFreeParam: body.limitedFreeParam || body.limited_free_param,
        },
        cookie,
      )
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'SongUrlPost', err, { url: '', playable: false })
    }
  })

  // 13b. 曲目详情：收藏态 + 播放统计 + 歌词（客户端 GetTrack → POST /luna/track + includes）
  app.get('/api/soda/track/detail', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const result = await handleSodaTrackDetail(id, cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'TrackDetail', err)
    }
  })

  // 13c. 媒体统计：播放/收藏/评论/分享数（客户端 GetMediaStats → GET /luna/pc/media-stats）
  app.get('/api/soda/media/stats', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      const mediaId = normalizeText(req.query.id || req.query.mediaId || req.query.media_id)
      if (!mediaId) return res.status(400).json({ error: '缺少媒体 id' })
      const mediaType = normalizeText(req.query.type || req.query.mediaType || 'track')
      const artistIds = normalizeText(req.query.artistIds || req.query.artist_ids || '')
      const json = await sodaWebRequestJson(
        '/luna/pc/media-stats',
        sodaPcAppParams(
          { media_id: mediaId, media_type: mediaType, artist_ids: artistIds },
          cookie,
        ),
        cookie,
        {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          timeoutMs: 6500,
        },
      )
      const data = (json && json.data) || json || {}
      const stats = pickObject(data.stats) || {}
      res.json({
        stats: {
          countCollected: Number(stats.count_collected ?? stats.countCollected ?? 0) || 0,
          countComment: Number(stats.count_comment ?? stats.countComment ?? 0) || 0,
          countShared: Number(stats.count_shared ?? stats.countShared ?? 0) || 0,
          countPlayed: Number(stats.count_played ?? stats.countPlayed ?? 0) || 0,
          countMarked: Number(stats.count_marked ?? stats.countMarked ?? 0) || 0,
        },
        isPostCommentInLessComments: !!(data.is_post_comment_in_less_comments ?? data.isPostCommentInLessComments),
      })
    } catch (err) {
      sodaSendError(res, 'MediaStats', err, { stats: null })
    }
  })

  // 14. 歌词（SEO → track_v2 → 公开目录三级兜底）
  app.get('/api/soda/lyric', async (req, res) => {
    try {
      const id = normalizeText(req.query.id || req.query.trackId)
      if (!id) return res.status(400).json({ error: '缺少歌曲 id' })
      const result = await handleSodaLyric(id, sodaRequestCookie(req))
      // words：yrc 命中时的结构化逐字时间轴（绝对毫秒）；平铺 LRC/公开目录兜底时为 null
      res.json({ lyric: result.lyric || '', tlyric: result.tlyric || '', source: result.source || '', words: result.words || null, error: result.error || undefined })
    } catch (err) {
      sodaSendError(res, 'Lyric', err, { lyric: '', tlyric: '' })
    }
  })

  // 15. 艺人歌曲（公开搜索 + 歌手相关性排序，无需登录）
  app.get('/api/soda/artist/songs', async (req, res) => {
    try {
      const name = String(req.query.name || req.query.artist || '').trim()
      if (!name) return res.status(400).json({ error: '缺少歌手名 name' })
      const limit = sodaClampInt(req.query.limit, 30, 1, 50)
      const result = await handleSodaArtistSongs(name, limit, sodaRequestCookie(req))
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'ArtistSongs', err, { songs: [] })
    }
  })

  // 15b. 真实艺人详情（by artist_id：头像 / 简介 / 职业 / 国籍 / 热门歌曲 / 专辑）
  app.get('/api/soda/artist/detail', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.artistId || req.query.artist_id)
      if (!id) return res.status(400).json({ error: '缺少歌手 id' })
      const result = await handleSodaArtistDetail(id, cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'ArtistDetail', err)
    }
  })

  // 15c. 艺人专辑列表（by artist_id，游标分页）
  app.get('/api/soda/artist/albums', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.artistId || req.query.artist_id)
      if (!id) return res.status(400).json({ error: '缺少歌手 id' })
      const result = await handleSodaArtistAlbums(id, {
        cursor: normalizeText(req.query.cursor),
        count: sodaClampInt(req.query.count || req.query.limit, 20, 1, 50),
      }, cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'ArtistAlbums', err, { albums: [] })
    }
  })

  // 15d. 艺人全部歌曲（by artist_id，支持 sort_type：0 最热 / 1 发行时间 / 2 收藏数）
  app.get('/api/soda/artist/tracks', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const id = normalizeText(req.query.id || req.query.artistId || req.query.artist_id)
      if (!id) return res.status(400).json({ error: '缺少歌手 id' })
      const result = await handleSodaArtistTracks(id, {
        cursor: normalizeText(req.query.cursor),
        count: sodaClampInt(req.query.count || req.query.limit, 30, 1, 50),
        sortType: sodaClampInt(req.query.sortType || req.query.sort_type, 0, 0, 2),
      }, cookie)
      res.json(result)
    } catch (err) {
      sodaSendError(res, 'ArtistTracks', err, { tracks: [] })
    }
  })

  // 16. 专辑曲目（尽力而为：搜索后按专辑名过滤）
  app.get('/api/soda/album/tracks', async (req, res) => {
    try {
      const name = String(req.query.name || '').trim()
      const albumId = normalizeText(req.query.id || req.query.albumId)
      if (!name && !albumId) return res.status(400).json({ error: '缺少专辑名 name 或专辑 id' })
      const limit = sodaClampInt(req.query.limit, 50, 1, 50)
      const result = await handleSodaAlbumTracks(name, albumId, limit, sodaRequestCookie(req))
      res.json({ album: result.album, tracks: result.tracks, message: result.message || undefined })
    } catch (err) {
      sodaSendError(res, 'AlbumTracks', err, { tracks: [] })
    }
  })

  // 17. 榜单聚合（固定关键词经公开目录搜索；登录时 PC 会话数据增强；无需登录可用）
  app.get('/api/soda/charts', async (req, res) => {
    try {
      const limit = sodaClampInt(req.query.limit, 30, 1, 30)
      res.json(await handleSodaCharts(sodaRequestCookie(req), limit))
    } catch (err) {
      sodaSendError(res, 'Charts', err, { charts: [] })
    }
  })

  // 18. 日推（登录个性化 feed / 未登录公开热歌）
  app.get('/api/soda/daily', async (req, res) => {
    try {
      const limit = sodaClampInt(req.query.limit, 20, 1, 50)
      res.json(await handleSodaDaily(sodaRequestCookie(req), limit))
    } catch (err) {
      sodaSendError(res, 'Daily', err, { songs: [], personalized: false })
    }
  })

  // 19. 最近播放（只读：复用账号库聚合缓存 recentTracks，前 N 条 mapSodaMedia 映射歌曲；
  //     cookie 请求级透传、绝不落盘全局。未登录返回 loggedIn:false 空列表而非报错）
  app.get('/api/soda/recent', async (req, res) => {
    try {
      const limit = sodaClampInt(req.query.limit, 10, 1, 50)
      res.json(await handleSodaRecentTracks(sodaRequestCookie(req), limit))
    } catch (err) {
      sodaSendError(res, 'Recent', err, { songs: [], loggedIn: false })
    }
  })

  // 20. 专辑收藏状态检查（只读尽力而为：从账号库聚合缓存判归，id= 专辑 id 或专辑名原串）
  app.get('/api/soda/album/collect/check', async (req, res) => {
    try {
      const id = normalizeText(req.query.id || req.query.albumId)
      if (!id) return res.status(400).json({ error: '缺少专辑 id 或专辑名 id' })
      res.json(await handleSodaAlbumCollectCheck(id, sodaRequestCookie(req)))
    } catch (err) {
      sodaSendError(res, 'AlbumCollectCheck', err, { collected: false, known: false })
    }
  })
}
