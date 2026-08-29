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
        const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) store.delete(oldest[0])
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

/** 由音质标签/格式/码率推断该流所需的会员层级 */
function sodaStreamRequiredTier(stream) {
  stream = stream && typeof stream === 'object' ? stream : {}
  let requiredTier = sodaNormalizeRequiredTier(
    stream.requiredTier || stream.required_tier || stream.membershipTier || stream.membership_tier || '',
  )
  const quality = normalizeText(stream.quality || stream.definition || '').toLowerCase().replace(/[-_\s]/g, '')
  const format = normalizeText(stream.format || '').toLowerCase()
  const bitrate = sodaNormalizeBitrateKbps(stream.bitrate)
  if (/svip|supervip|hires|highres|highresolution|master|atmos|dolby|spatial/.test(quality)) {
    requiredTier = sodaHigherRequiredTier(requiredTier, 'svip')
  } else if (/lossless|flac|sq/.test(quality) || /flac|alac|wav/.test(format) || bitrate >= 900) {
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
  stream.requiredTier = sodaStreamRequiredTier(stream)
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
  const entry = sodaStreamFromObject(value, { auth: ownAuth, duration: ownDuration, keyHint })
  if (entry) out.push(entry)
  Object.keys(value).forEach((key) => {
    sodaCollectVideoModelStreams(value[key], key, { auth: ownAuth, duration: ownDuration }, out)
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
    out.push({
      id: String((item && (item.id || item.artist_id || item.open_id)) || ''),
      name,
    })
  })
  const fallback = normalizeText(base.artist_name || display.artist_name || related.artist_name || (track && track.artist_name) || (media && media.artist_name))
  if (fallback && !out.length) {
    fallback.split(/\s*\/\s*|\s*,\s*|\s*&\s*/).forEach((name) => {
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
function mapSodaMedia(raw, index, query) {
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
  if (artistName) song.artists = [{ id: normalizeText(author.id || author.author_id), name: artistName }]
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

function extractSodaPcSearchItems(payload) {
  const data = (payload && payload.data) || payload || {}
  const groups = pickArray(data.result_groups, data.resultGroups, data.search_result && data.search_result.result_groups, payload && payload.result_groups)
  const items = []
  groups.forEach((group) => {
    const groupData = group && (group.data || group.items || group.list || group.result)
    if (Array.isArray(groupData)) items.push(...groupData)
    else items.push(...extractSodaMediaList(groupData))
  })
  return items.length ? items : extractSodaMediaList(data)
}

/** PC Web 搜索（需登录）：luna/pc/search/track */
async function handleSodaPcSearch(keywords, limit, cookieText, offset) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) throw new Error('QISHUI_COOKIE_REQUIRED')
  const requestCount = Math.max(1, Math.min(50, Number(limit) || 8))
  offset = Math.max(0, Number(offset) || 0)
  const json = await sodaWebRequestJson('/luna/pc/search/track', sodaPcAppParams({
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
  const rawItems = extractSodaPcSearchItems(json)
  const songs = mapSodaMediaList(rawItems, keywords).slice(0, limit)
  const data = (json && json.data) || json || {}
  const resultData = pickObject(data.search_result, data.searchResult, data)
  const nextCursor = normalizeText(resultData.next_cursor || resultData.nextCursor || data.next_cursor || data.nextCursor || '')
  const hasMoreFlag = resultData.has_more
  const hasMore =
    typeof hasMoreFlag === 'boolean' ? hasMoreFlag : Number(hasMoreFlag) > 0 || !!nextCursor || songs.length >= limit
  return { source: 'pc-session', songs, rawCount: rawItems.length, offset, nextOffset: offset + songs.length, nextCursor, hasMore }
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
    // 本页已满 且 （本地排序集还有剩余 或 上游候选窗口还没拉到上限）
    hasMore: songs.length >= limit && (offset + songs.length < rankedSongs.length || requestLimit < 100),
    message: songs.length ? '' : '汽水公开搜索暂时没有返回匹配结果。',
  }
}

/** 统一搜索入口：登录优先 PC 会话搜索，失败/未登录回退公开目录（结果缓存 2 分钟） */
async function handleSodaSearch(keywords, limit, cookieText, offset) {
  keywords = normalizeText(keywords)
  limit = Math.max(1, Math.min(50, Number(limit) || 20))
  offset = Math.max(0, Number(offset) || 0)
  if (!keywords) return { source: 'none', songs: [], message: '缺少关键词' }
  const loggedIn = sodaCookieHasLogin(normalizeSodaCookieInput(cookieText))
  const cacheKey =
    keywords.toLowerCase() + '|' + limit + '|' + offset + '|' + (loggedIn ? sodaCookieFingerprint(cookieText) : 'public')
  return sodaSearchCache.wrap(cacheKey, 2 * 60 * 1000, async () => {
    let pcSearchError = ''
    if (loggedIn) {
      try {
        return await handleSodaPcSearch(keywords, limit, cookieText, offset)
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

/** 个性化推荐 feed（需登录）：song-tab 两路径尝试 + 媒体库回退 */
async function fetchSodaWebFeedSongs(cookieText, limit) {
  const cookie = normalizeSodaCookieInput(cookieText)
  if (!sodaCookieHasLogin(cookie)) {
    return { source: 'none', songs: [], error: 'QISHUI_COOKIE_REQUIRED' }
  }
  limit = Math.max(1, Math.min(50, Number(limit) || 8))
  const cacheKey = 'web-feed|' + sodaCookieFingerprint(cookie) + '|' + limit
  return sodaFeedCache.wrap(cacheKey, 90 * 1000, async () => {
    const candidates = [
      { path: '/luna/feed/song-tab', params: { cursor: 0, cnt: limit, count: limit } },
      { path: '/luna/pc/feed/song-tab', params: { cursor: 0, cnt: limit, count: limit } },
    ]
    let lastErr = null
    for (const item of candidates) {
      try {
        const json = await sodaWebRequestJson(item.path, item.params, cookie, { timeoutMs: 8000 })
        const rawItems = extractSodaMediaList(json)
        const songs = mapSodaMediaList(rawItems, 'web-feed').slice(0, limit)
        if (songs.length) return { source: 'song-tab', songs, rawCount: rawItems.length }
      } catch (err) {
        lastErr = err
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

/** 上游评论 → 统一结构 { id,user:{name,avatarUrl},content,likes,time,pinned?,replies? } */
function mapSodaComment(raw) {
  raw = raw && typeof raw === 'object' ? raw : {}
  const comment = pickObject(raw.comment, raw.comment_info, raw.commentInfo, raw)
  const user = pickObject(comment.user, comment.user_info, comment.userInfo, comment.author, raw.user, raw.user_info, raw.author)
  const timeRaw = Number(
    comment.create_time || comment.createTime || comment.created_at || comment.createdAt || comment.time || raw.create_time || raw.time || 0,
  ) || 0
  const out = {
    id: normalizeText(comment.id || comment.comment_id || comment.commentId || raw.id || ''),
    user: {
      name: normalizeText(user.nickname || user.nick_name || user.nickName || user.name || user.screen_name || ''),
      avatarUrl: qishuiFirstImageUrl(
        '~c5_100x100.jpg',
        user.avatar_url,
        user.avatarUrl,
        user.avatar,
        user.medium_avatar_url,
        user.larger_avatar_url,
      ),
    },
    content: normalizeLyricBody(comment.text || comment.content || comment.comment_text || comment.commentText || ''),
    likes: Number(comment.like_count || comment.likeCount || comment.digg_count || comment.diggCount || comment.liked_count || 0) || 0,
    time: timeRaw && timeRaw < 10000000000 ? timeRaw * 1000 : timeRaw,
  }
  if (sodaExplicitPositive(comment.pinned || comment.is_pinned || comment.stick_top || comment.is_stick)) out.pinned = true
  const repliesRaw = pickArray(comment.reply_list, comment.replies, comment.reply_comments)
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

async function fetchSodaPcTrackV2Post(trackId, cookieText) {
  const body = JSON.stringify({
    track_id: trackId,
    media_type: 'track',
    queue_type: 'favorite_track_playlist',
    scene_name: 'library',
  })
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
  const json = await requestJson(qishuiPcUrl('/luna/pc/track_v2', sodaPcAppParams({ track_id: trackId, media_type: 'track' }, cookieText)), {
    timeoutMs: 10000,
    headers: Object.assign(sodaWebHeaders(cookieText, { sessionOnly: true, pcApp: true }), {
      Referer: 'https://www.qishui.com/',
    }),
  })
  const err = sodaPcStatusError(json, 'SODA_PC_TRACK_V2_GET_FAILED')
  if (err) throw err
  return json
}

/** track_v2 元数据（POST 优先，GET 兜底，20s 微缓存 + 45s 失败负缓存） */
async function fetchSodaPcTrackV2(trackId, cookieText) {
  const cookie = normalizeSodaCookieInput(cookieText)
  const cacheKey = 'track-v2-meta|' + sodaCookieFingerprint(cookie) + '|' + normalizeText(trackId)
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
        return await fetchSodaPcTrackV2Post(trackId, cookie)
      } catch (postError) {
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
async function fetchSodaPlayerInfo(playerInfoUrl, cookieText, membership) {
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
  const streams = list.map((item) => sodaStreamFromObject(item)).filter(Boolean)
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
  const audioInfo = pickObject(track.audio_info, track.audioInfo, payload && payload.audio_info, payload && payload.audioInfo)
  const playInfoList = pickArray(audioInfo.play_info_list, audioInfo.PlayInfoList, audioInfo.playInfoList)
  const streams = playInfoList.map((item) => sodaStreamFromObject(item)).filter(Boolean)
  const videoModel = player.video_model || player.VideoModel || player.videoModel || track.video_model || track.VideoModel || ''
  sodaCollectVideoModelStreams(videoModel, '', {}, streams)
  const bitRates = pickArray(track.bit_rates, track.bitRates, audioInfo.bit_rates, audioInfo.bitRates, payload && payload.bit_rates, payload && payload.bitRates)
  const fallbackStreams = bitRates.map((item) => sodaStreamFromObject(item)).filter(Boolean)
  return { track, player, streams, fallbackStreams }
}

/** 从 track_v2 负载解析可播下载信息；拿不到时抛带错误码的异常（VIP/SVIP/会员未知） */
async function resolveSodaDownloadInfo(trackId, payload, cookieText, membership) {
  const collected = collectSodaTrackV2Streams(payload)
  const playerInfoUrl = qishuiObjectString(collected.player, ['url_player_info', 'URLPlayerInfo', 'urlPlayerInfo'])
  if (playerInfoUrl) {
    try {
      const stream = await fetchSodaPlayerInfo(playerInfoUrl, cookieText, membership)
      if (stream) collected.streams.push(stream)
    } catch (err) {
      collected.playerInfoError = (err && err.message) || String(err)
    }
  }
  const best =
    sodaBestStreamCandidateForMembership(collected.streams, membership) ||
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
  return Object.assign(collected, { best })
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
    payload = await fetchSodaPcTrackV2(id, cookie)
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
      const stream = resolved.best
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
    const profileSource = await sodaWebRequestJson('/luna/pc/me', sodaPcAppParams({}, cookie), cookie, {
      bases: [QISHUI_WEB_PC_API_BASE],
      noDefaultParams: true,
      sessionOnly: true,
      pcApp: true,
      timeoutMs: 6500,
    })
    const profile = sodaProfileFromMeData((profileSource && profileSource.data) || profileSource || {})
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
      const result = await handleSodaSearch(keywords, limit, sodaRequestCookie(req), offset)
      res.json({ songs: result.songs || [], source: result.source || '', message: result.message || undefined })
    } catch (err) {
      sodaSendError(res, 'Search', err, { songs: [] })
    }
  })

  // 3. 个性化推荐 feed（需登录）
  app.get('/api/soda/feed', async (req, res) => {
    try {
      const cookie = sodaRequestCookie(req)
      if (!sodaRequireLogin(res, cookie)) return
      const limit = sodaClampInt(req.query.limit, 12, 1, 50)
      const feed = await fetchSodaWebFeedSongs(cookie, limit)
      res.json({ name: '汽水推荐', songs: feed.songs || [], error: feed.error || undefined })
    } catch (err) {
      sodaSendError(res, 'Feed', err, { songs: [] })
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
          name: '汽水我的喜欢',
          coverUrl: likedCard.cover || likedTracks.map((song) => song.coverUrl).find(Boolean) || '',
          trackCount: likedTracks.length || Number(likedCard.trackCount) || 0,
          isLikedLike: true,
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
        })
      })
      const recentTracks = library.recentTracks || []
      if (recentTracks.length) {
        playlists.push({
          id: SODA_WEB_RECENT_PLAYLIST_ID,
          name: '汽水最近播放',
          coverUrl: recentTracks.map((song) => song.coverUrl).find(Boolean) || '',
          trackCount: recentTracks.length,
          isLikedLike: false,
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
