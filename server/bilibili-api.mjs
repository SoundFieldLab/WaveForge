/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 哔哩哔哩「看歌」后端模块（server/bilibili-api.mjs）
 *
 * 为 WaveForge 的 B 站 MV 自动播放模式提供：
 *  - WBI 签名搜索（x/web-interface/wbi/search/type）
 *  - 视频详情 / 播放地址（playurl，登录解锁 1080p；大会员专享画质受限）
 *  - 视频流代理（CDN 需 Referer 且无 CORS，本地回环带 Range 转发支持 seek）
 *  - CC 字幕（x/player/wbi/v2，官方 MV 字幕即歌词/歌词翻译）
 *  - 扫码登录（passport qrcode generate/poll，成功抓 SESSDATA）
 *
 * 安全约定（与 local-server.mjs 的 QQ cookie 单事实源一致）：
 *  - 全局 bilibiliCookie 只在登录/显式设置接口更新；
 *  - 播放/读取路由一律用 resolveBiliCookie(req.query.cookie) 只读；
 *  - /api/bilibili/stream 只按缓存 key 取内部生成的 URL，不代理任意 URL（无 SSRF 面）。
 */

import crypto from 'node:crypto'
import { Readable } from 'stream'
import { inflateRawSync, gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

const BILI_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const BILI_REFERER = 'https://www.bilibili.com'
const API_BASE = 'https://api.bilibili.com'
const PASSPORT_BASE = 'https://passport.bilibili.com'

/** WBI mixin key 置换表（B 站标准算法） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

// ===== 全局状态（单进程） =====

/** B 站登录态（SESSDATA 等）——登录/显式设置接口更新，读取路由只读 */
let bilibiliCookie = ''
/** 匿名指纹 cookie（buvid3/buvid4），提升未携带时的接口可用度与画质 */
let bilibiliBuvid3 = ''
let bilibiliBuvid4 = ''
/** WBI 密钥缓存（1h） */
let wbiCache = { imgKey: '', subKey: '', fetchedAt: 0 }
/** playurl durl 缓存：cacheKey -> { urls, createdAt }（10min TTL） */
const streamCache = new Map()
/** 字幕 JSON 缓存：subCacheKey -> { url, createdAt }（10min TTL） */
const subtitleJsonCache = new Map()
/** 弹幕缓存：cid -> { items, createdAt }（10min TTL） */
const danmakuCache = new Map()

const STREAM_CACHE_TTL = 10 * 60 * 1000
const WBI_CACHE_TTL = 60 * 60 * 1000
const DANMAKU_CACHE_TTL = 10 * 60 * 1000

// ===== 基础工具 =====

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

function md5Hex(text) {
  return crypto.createHash('md5').update(text).digest('hex')
}

/** 本次请求有效 Cookie：请求自带时仅本次使用，绝不回写全局 */
function resolveBiliCookie(cookie) {
  if (typeof cookie === 'string' && cookie.trim()) return cookie.trim()
  return bilibiliCookie
}

function pruneCache(map, ttl) {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - entry.createdAt > ttl) map.delete(key)
  }
}

/** 带 UA/Referer/Cookie 的 B 站请求（12s 超时），返回 Response */
async function fetchBili(url, { params, cookie, referer = BILI_REFERER, headers = {}, signal } = {}) {
  let finalUrl = url
  if (params) finalUrl = `${url}?${new URLSearchParams(params).toString()}`
  const effectiveCookie = buildCookieHeader(resolveBiliCookie(cookie))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    return await fetch(finalUrl, {
      signal: signal || controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': BILI_UA,
        Referer: referer,
        Accept: 'application/json, text/plain, */*',
        ...(effectiveCookie ? { Cookie: effectiveCookie } : {}),
        ...headers,
      },
    })
  } finally {
    clearTimeout(timer)
  }
}

/** 组装请求 Cookie：buvid3/4 打底 + 用户 Cookie（去重） */
function buildCookieHeader(cookie) {
  const parts = []
  if (bilibiliBuvid3 && !String(cookie || '').includes('buvid3=')) {
    parts.push(`buvid3=${bilibiliBuvid3}`)
    if (bilibiliBuvid4 && !String(cookie || '').includes('buvid4=')) parts.push(`buvid4=${bilibiliBuvid4}`)
  }
  if (cookie) parts.push(cookie)
  return parts.join('; ')
}

/** 拉取并缓存匿名 buvid3/4 指纹（登录与未登录都提升接口可用度、降低风控） */
async function ensureBuvid3() {
  if (bilibiliBuvid3) return bilibiliBuvid3
  try {
    const json = await fetchBiliJson(`${API_BASE}/x/frontend/finger/spi`, { referer: 'https://www.bilibili.com/' })
    bilibiliBuvid3 = json.data?.b_3 || ''
    bilibiliBuvid4 = json.data?.b_4 || ''
  } catch {
    bilibiliBuvid3 = ''
  }
  return bilibiliBuvid3
}

async function fetchBiliJson(url, options) {
  const res = await fetchBili(url, options)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return { code: -1, message: text.slice(0, 200) }
  }
}

/** 带风控重试的 B 站 JSON 请求：-352/-412（风控）短暂等待后重试一次 */
async function fetchBiliJsonWithRiskRetry(url, options) {
  let json = await fetchBiliJson(url, options)
  if (json.code === -352 || json.code === -412) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    json = await fetchBiliJson(url, options)
  }
  return json
}

/** 获取 WBI 密钥（nav 接口的 wbi_img，缓存 1h） */
async function ensureWbiKeys() {
  if (wbiCache.imgKey && Date.now() - wbiCache.fetchedAt < WBI_CACHE_TTL) return wbiCache
  const json = await fetchBiliJson(`${API_BASE}/x/web-interface/nav`, { referer: 'https://www.bilibili.com/' })
  const img = json.data?.wbi_img?.img_url
  const sub = json.data?.wbi_img?.sub_url
  if (!img || !sub) throw new Error('获取 WBI 密钥失败')
  wbiCache = {
    imgKey: img.split('/').pop().split('.')[0],
    subKey: sub.split('/').pop().split('.')[0],
    fetchedAt: Date.now(),
  }
  return wbiCache
}

/** 给参数补 WBI 签名（wts + w_rid），返回可直接拼 URL 的参数对象 */
async function wbiSign(params) {
  const { imgKey, subKey } = await ensureWbiKeys()
  const mixinKey = getMixinKey(imgKey + subKey)
  const wts = Math.round(Date.now() / 1000)
  const payload = { ...params, wts }
  const query = Object.keys(payload)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(payload[k])}`)
    .join('&')
  return { ...payload, w_rid: md5Hex(query + mixinKey) }
}

/** 搜索结果 duration 兼容 "3:43" / "1:02:03" / 秒数 多种格式 */
function parseSearchDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const hms = value.trim().match(/^(?:(\d+):)?(\d+):(\d+)$/)
    if (hms) return (Number(hms[1]) || 0) * 3600 + Number(hms[2]) * 60 + Number(hms[3])
    const ms = value.trim().match(/^(\d+):(\d+)$/)
    if (ms) return Number(ms[1]) * 60 + Number(ms[2])
    const num = Number(value)
    if (Number.isFinite(num) && num > 0) return num
  }
  return 0
}

/** 从 Set-Cookie 数组提取指定名字的 cookie 值 */
function extractCookieValue(setCookieArray, name) {
  for (const raw of setCookieArray || []) {
    const part = String(raw || '').split(';')[0].trim()
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return ''
}

const officialVerifyCache = new Map()
const OFFICIAL_VERIFY_CACHE_TTL = 60 * 60 * 1000

async function getOfficialVerifyType(mid, cookie) {
  const numericMid = Number(mid) || 0
  if (!numericMid) return -1
  const cached = officialVerifyCache.get(numericMid)
  if (cached && Date.now() - cached.at < OFFICIAL_VERIFY_CACHE_TTL) return cached.type
  try {
    const json = await fetchBiliJsonWithRiskRetry(`${API_BASE}/x/web-interface/card`, { params: { mid: numericMid }, cookie })
    const type = Number(json.data?.card?.official_verify?.type)
    const normalized = type === 0 || type === 1 ? type : -1
    officialVerifyCache.set(numericMid, { at: Date.now(), type: normalized })
    return normalized
  } catch {
    return -1
  }
}

// ===== 路由注册 =====

export function registerBilibiliRoutes(app) {
  // 搜索视频（WBI 签名）
  app.get('/api/bilibili/search', async (req, res) => {
    const keyword = String(req.query.keyword || '').trim()
    const page = Math.max(1, Number(req.query.page) || 1)
    if (!keyword) return res.status(400).json({ code: -1, error: 'keyword 必填' })
    await ensureBuvid3()
    try {
      const signed = await wbiSign({ search_type: 'video', keyword, page })
      const json = await fetchBiliJsonWithRiskRetry(`${API_BASE}/x/web-interface/wbi/search/type`, { params: signed, cookie: req.query.cookie })
      if (json.code !== 0) {
        return res.status(502).json({ code: json.code, error: json.message || '搜索失败（可能触发风控）' })
      }
      const results = (json.data?.result || [])
        .map((item) => ({
          bvid: item.bvid || '',
          aid: item.aid || 0,
          title: String(item.title || '').replace(/<[^>]*>/g, ''),
          duration: parseSearchDuration(item.duration),
          play: item.play || 0,
          danmaku: item.danmaku || 0,
          author: item.author || '',
          mid: item.mid || 0,
          pic: item.pic || '',
          typename: item.typename || '',
        }))
        .filter((item) => item.bvid)
      res.json({ code: 0, results, page })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '搜索失败' })
    }
  })

  // 视频详情（cid / 作者认证 / copyright）
  app.get('/api/bilibili/view', async (req, res) => {
    const bvid = String(req.query.bvid || '').trim()
    if (!bvid) return res.status(400).json({ code: -1, error: 'bvid 必填' })
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/web-interface/view`, { params: { bvid }, cookie: req.query.cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '视频不存在' })
      const data = json.data || {}
      const page = (data.pages || [])[0] || {}
      const officialVerifyType = await getOfficialVerifyType(data.owner?.mid, req.query.cookie)
      res.json({
        code: 0,
        data: {
          bvid: data.bvid,
          aid: data.aid,
          cid: page.cid || 0,
          title: data.title || '',
          duration: data.duration || 0,
          play: data.stat?.view || 0,
          pic: data.pic || '',
          desc: data.desc || '',
          copyright: data.copyright || 0,
          pubdate: data.pubdate || 0,
          // 选集（多 P）信息：部分视频含 on vocal / off vocal 等多个版本
          pages: Array.isArray(data.pages)
            ? data.pages.map((p) => ({ cid: p.cid || 0, page: p.page || 0, part: String(p.part || ''), duration: p.duration || 0 }))
            : [],
          owner: {
            mid: data.owner?.mid || 0,
            name: data.owner?.name || '',
            face: data.owner?.face || '',
            officialVerifyType,
          },
        },
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取详情失败' })
    }
  })

  // 播放地址：DASH 全画质（4K/HDR/杜比/1080P+/1080P60），视频流 + 音频流分离
  // fnval=4048 开启 DASH+4K+AV1；请求的 qn 越高可拿到的格式越全（最终画质受登录/VIP 限制）
  app.get('/api/bilibili/playurl', async (req, res) => {
    const bvid = String(req.query.bvid || '').trim()
    const cid = Number(req.query.cid)
    if (!bvid || !cid) return res.status(400).json({ code: -1, error: 'bvid/cid 必填' })
    await ensureBuvid3()
    const requestedQn = Math.max(16, Number(req.query.qn) || 80)
    const fnval = 4048
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/player/playurl`, {
        params: { bvid, cid, qn: Math.max(requestedQn, 120), fnval, fnver: 0, fourk: 1 },
        cookie: req.query.cookie,
      })
      if (json.code === -404) return res.json({ code: -404, error: '视频已失效或删除' })
      if (json.code !== 0 || !json.data) return res.status(502).json({ code: json.code || -1, error: json.message || '获取播放地址失败' })
      const data = json.data

      // 视频流选择：目标 qn 精确命中 → 否则取 ≤qn 的最高档 → 逐级降级
      const videoStreams = Array.isArray(data.dash?.video) ? data.dash.video : []
      const pickVideo = (targetQn) => {
        if (!videoStreams.length) return null
        const byId = (id) => videoStreams.find((s) => s.id === id)
        const exact = byId(targetQn)
        if (exact) return exact
        const candidates = videoStreams
          .filter((s) => s.id <= targetQn)
          .sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth)
        return candidates[0] || null
      }
      // 登录/VIP 上限：accept_quality 表示该会话实际可用的全部档位
      const acceptQuality = Array.isArray(data.accept_quality) ? data.accept_quality : []
      const maxAccept = acceptQuality.length ? Math.max(...acceptQuality) : requestedQn
      const effectiveTarget = Math.min(requestedQn, maxAccept)
      const video = pickVideo(effectiveTarget)

      // 音频流：优先最高码率（30280/30250 > 30232 > 30216）；杜比/无损在 dash.dolby / dash.flac
      const audioStreams = Array.isArray(data.dash?.audio) ? data.dash.audio : []
      const pickAudio = () => {
        const sorted = [...audioStreams].sort((a, b) => b.id - a.id || b.bandwidth - a.bandwidth)
        return sorted[0] || null
      }
      const audio = pickAudio()

      if (!video || !audio) return res.status(502).json({ code: -10403, error: '该视频当前无可播放流（可能仅大会员专享）' })

      const cacheKey = `bili_${bvid}_${cid}_${video.id}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      streamCache.set(cacheKey, {
        urls: [video.baseUrl || video.base_url || '', audio.baseUrl || audio.base_url || ''],
        sizes: [video.size || 0, audio.size || 0],
        videoId: video.id,
        audioId: audio.id,
        createdAt: Date.now(),
      })
      pruneCache(streamCache, STREAM_CACHE_TTL)
      // 大会员专享：接受的画质整体 < 480p 视为受限（前端据此跳过该候选）
      const vipLimited = acceptQuality.length > 0 && acceptQuality.every((q) => q <= 32)
      res.json({
        code: 0,
        quality: video.id,
        acceptQuality,
        vipLimited,
        cacheKey,
        durlCount: 2,
        hasDolby: Boolean(data.dash?.dolby),
        hasFlac: Boolean(data.dash?.flac),
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取播放地址失败' })
    }
  })

  // 视频流代理：只接受 playurl 生成的缓存 key，带 Referer 转发，透传 Range 支持 seek
  // type=video → 视频流；type=audio → 音频流（DASH 音画分离）
  app.get('/api/bilibili/stream', async (req, res) => {
    const key = String(req.query.key || '')
    const type = String(req.query.type || 'video') === 'audio' ? 1 : 0
    const entry = key ? streamCache.get(key) : undefined
    if (!entry) return res.status(410).json({ error: '播放地址已过期，请重新获取' })
    const url = entry.urls[type]
    if (!url) return res.status(404).json({ error: '视频分片不存在' })

    const range = req.headers.range
    const fetchOptions = {
      headers: {
        'User-Agent': BILI_UA,
        Referer: BILI_REFERER,
        ...(range ? { Range: range } : {}),
      },
      redirect: 'follow',
    }

    try {
      let upstream = await fetch(url, fetchOptions)
      // CDN 重定向后可能丢失 Referer 导致 403/400：用最终 URL 重试一次
      if (!upstream.ok && upstream.redirected) {
        upstream = await fetch(upstream.url, fetchOptions)
      }
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(upstream.status).json({ error: `上游返回 ${upstream.status}` })
      }

      res.status(upstream.status === 206 ? 206 : 200)
      res.set({
        'Content-Type': type === 0 ? 'video/mp4' : 'audio/mp4',
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Cache-Control': 'public, max-age=3600',
      })
      const contentLength = upstream.headers.get('content-length')
      if (contentLength) res.set('Content-Length', contentLength)
      const contentRange = upstream.headers.get('content-range')
      if (contentRange) res.set('Content-Range', contentRange)

      const body = Readable.fromWeb(upstream.body)
      body.on('error', () => res.destroy())
      res.on('close', () => body.destroy())
      body.pipe(res)
    } catch (error) {
      if (!res.headersSent) res.status(502).json({ error: error.message || '流式转发失败' })
      else res.destroy()
    }
  })

  // CC 字幕元数据（官方 MV 字幕即歌词；优先人工字幕）
  app.get('/api/bilibili/subtitles', async (req, res) => {
    const bvid = String(req.query.bvid || '').trim()
    const cid = Number(req.query.cid)
    if (!bvid || !cid) return res.status(400).json({ code: -1, error: 'bvid/cid 必填' })
    await ensureBuvid3()
    try {
      const signed = await wbiSign({ bvid, cid })
      const json = await fetchBiliJson(`${API_BASE}/x/player/wbi/v2`, { params: signed, cookie: req.query.cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '获取字幕失败' })
      const subtitles = (json.data?.subtitle?.subtitles || []).map((s) => {
        // 稳定 key（bvid+cid+lan）：服务端重启后 /subtitle 可据 key 反查重建，不再随机串+内存缓存一重启就 410
        const subCacheKey = `bili_sub_${bvid}_${cid}_${s.lan || 'xx'}`
        // B 站返回协议相对 URL（//aisubtitle.hdslb.com/...），Node fetch 需补 https: 否则解析失败
        const subUrl = String(s.subtitle_url || '')
        subtitleJsonCache.set(subCacheKey, { url: subUrl.startsWith('//') ? `https:${subUrl}` : subUrl, createdAt: Date.now() })
        pruneCache(subtitleJsonCache, STREAM_CACHE_TTL)
        return {
          lan: s.lan || '',
          lanDoc: s.lan_doc || '',
          aiType: typeof s.ai_type === 'number' ? s.ai_type : (String(s.lan || '').startsWith('ai-') ? 1 : 0),
          cacheKey: subCacheKey,
        }
      })
      res.json({ code: 0, subtitles })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取字幕失败' })
    }
  })

  // 字幕 JSON 代理（字幕文件在 hdslb 域，需 Referer）
  app.get('/api/bilibili/subtitle', async (req, res) => {
    const key = String(req.query.key || '')
    let entry = key ? subtitleJsonCache.get(key) : undefined
    // 缓存 miss（常见于服务端热重启）→ 从稳定 key 反查 bvid/cid/lan 重建字幕 URL，避免 410 静默失效
    if (!entry && key) {
      const match = key.match(/^bili_sub_([A-Za-z0-9]+)_(\d+)_(.+)$/)
      if (match) {
        try {
          await ensureBuvid3()
          const [, bvid, cid, lan] = match
          const signed = await wbiSign({ bvid, cid: Number(cid) })
          const meta = await fetchBiliJson(`${API_BASE}/x/player/wbi/v2`, { params: signed, cookie: req.query.cookie })
          const s = (meta.data?.subtitle?.subtitles || []).find((x) => String(x.lan || '') === lan)
          if (s) {
            const subUrl = String(s.subtitle_url || '')
            entry = { url: subUrl.startsWith('//') ? `https:${subUrl}` : subUrl, createdAt: Date.now() }
            subtitleJsonCache.set(key, entry)
          }
        } catch {
          // 重建失败走 410
        }
      }
    }
    if (!entry) return res.status(410).json({ code: -1, error: '字幕缓存已过期，请重新获取' })
    try {
      const json = await fetchBiliJson(entry.url, { referer: BILI_REFERER })
      // B 站字幕文件格式为 { body: [{from,to,location,content}] }，前端按裸数组消费 → 提取 body
      if (json && typeof json === 'object' && Array.isArray(json.body)) {
        res.json(json.body)
      } else if (Array.isArray(json)) {
        res.json(json)
      } else {
        res.json([])
      }
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '字幕拉取失败' })
    }
  })

  // ===== 弹幕 protobuf（seg.so）解码 =====
  // B 站已将弹幕迁移到 protobuf 端点 /x/v2/dm/web/seg.so（旧 XML list.so/comment.bilibili.com
  // 对迁移视频返回空列表元信息 XML）。返回 DanmakuSeg { repeated DanmakuElem elems = 1; int64 next = 3; }
  // DanmakuElem: 1=id(int64) 2=progress(int32,毫秒) 3=mode 4=fontsize 5=color(uint32)
  //              6=midHash 7=content 8=ctime 9=weight 10=action 11=pool 12=idStr 13=attr
  const decodeVarint = (buf, offset) => {
    let result = 0n
    let shift = 0n
    let o = offset
    while (o < buf.length) {
      const byte = buf[o++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return [result, o]
      shift += 7n
    }
    throw new Error('弹幕 protobuf varint 越界')
  }
  const parseDanmakuElem = (buf) => {
    const elem = {}
    let o = 0
    while (o < buf.length) {
      const [tag, o2] = decodeVarint(buf, o)
      o = o2
      const field = Number(tag >> 3n)
      const wire = Number(tag & 7n)
      if (wire === 0) {
        const [v, o3] = decodeVarint(buf, o)
        o = o3
        elem[field] = v
      } else if (wire === 2) {
        const [len, o3] = decodeVarint(buf, o)
        o = o3
        elem[field] = buf.slice(o, o + Number(len))
        o += Number(len)
      } else if (wire === 5) {
        elem[field] = buf.readUInt32LE(o)
        o += 4
      } else {
        o += 8
      }
    }
    return elem
  }
  const parseDanmakuSeg = (buf) => {
    const items = []
    let next = null
    let o = 0
    while (o < buf.length) {
      const [tag, o2] = decodeVarint(buf, o)
      o = o2
      const field = Number(tag >> 3n)
      const wire = Number(tag & 7n)
      if (wire === 2) {
        const [len, o3] = decodeVarint(buf, o)
        o = o3
        const chunk = buf.slice(o, o + Number(len))
        o += Number(len)
        if (field === 1) {
          const elem = parseDanmakuElem(chunk)
          const text = elem[7] ? elem[7].toString('utf8') : ''
          const mode = Number(elem[3] || 1n)
          items.push({
            time: Number(elem[2] || 0n) / 1000, // progress 毫秒 → 秒
            mode,
            fontSize: Number(elem[4] || 25n),
            color: Number(elem[5] || 0xffffffn),
            text,
          })
        }
      } else if (wire === 0) {
        const [v, o3] = decodeVarint(buf, o)
        o = o3
        if (field === 3) next = Number(v) // 下一段索引；<=0 表示已无更多段
      } else {
        o += wire === 5 ? 4 : 8
      }
    }
    return { items, next }
  }
  const fetchDanmakuSegs = async (cid) => {
    const all = []
    let idx = 1
    const seen = new Set()
    for (let guard = 0; guard < 30; guard++) {
      if (seen.has(idx)) break
      seen.add(idx)
      const url = `${API_BASE}/x/v2/dm/web/seg.so?type=1&oid=${cid}&segment_index=${idx}`
      const resp = await fetchBili(url, { referer: BILI_REFERER })
      if (!resp.ok) throw new Error(`seg.so HTTP ${resp.status}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length < 2) break
      const { items, next } = parseDanmakuSeg(buf)
      all.push(...items)
      if (next == null || next <= 0) break
      idx = next
    }
    return all
  }
  // 旧 XML 弹幕（seg.so 无数据时的兜底；模式/颜色/字号齐全）
  const parseDanmakuXml = (xml) => {
    const items = []
    const re = /<d p="([^"]+)">([^<]*)<\/d>/g
    let m
    while ((m = re.exec(xml))) {
      const p = m[1].split(',')
      items.push({
        time: parseFloat(p[0]) || 0,
        mode: parseInt(p[1], 10) || 1, // 1/6 滚动 4 底部 5 顶部 7 高级
        fontSize: parseInt(p[2], 10) || 25,
        color: parseInt(p[3], 10) || 0xffffff,
        text: m[2]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'"),
      })
    }
    return items
  }
  const fetchDanmakuXml = async (url) => {
    const resp = await fetchBili(url, { referer: BILI_REFERER })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buf = Buffer.from(await resp.arrayBuffer())
    // Node fetch 会按 Content-Encoding 自动解压 → 直接拿到的可能就是明文 XML；
    // 若否则尝试 deflate-raw / gzip / deflate / brotli 逐种解压
    const direct = buf.toString('utf8')
    if (direct.includes('<d p=')) return direct
    // 合法但无弹幕的明文 XML（<i> 根节点存在、没有任何 <d> 节点）：返回空串表示"已确认无弹幕"
    if (direct.includes('<i') || direct.trimStart().startsWith('<?xml')) return ''
    for (const fn of [() => inflateRawSync(buf), () => gunzipSync(buf), () => inflateSync(buf), () => brotliDecompressSync(buf)]) {
      try {
        const text = fn().toString('utf8')
        if (text.includes('<d p=')) return text
        if (text.includes('<i')) return ''
      } catch {
        // 尝试下一种解压方式
      }
    }
    throw new Error('弹幕数据解析失败')
  }
  app.get('/api/bilibili/danmaku', async (req, res) => {
    const cid = Number(req.query.cid)
    if (!cid) return res.status(400).json({ code: -1, error: 'cid 必填' })
    const cached = danmakuCache.get(cid)
    if (cached && Date.now() - cached.createdAt < DANMAKU_CACHE_TTL) {
      return res.json({ code: 0, danmaku: cached.items })
    }
    try {
      // 弹幕接口必须带 buvid3 cookie，否则极易触发风控（此前路由漏调 ensureBuvid3）
      await ensureBuvid3()
      let items = []
      let lastError = ''
      // fetchedOk：任一数据源成功响应过（含"已确认该视频无弹幕"）。
      // 全部数据源都传输失败时绝不能把空结果缓存/当成功返回——否则瞬时网络抖动
      // 会让该视频弹幕被空缓存"毒化"10 分钟，渲染端收到 code:0 也永远不会重试。
      let fetchedOk = false
      // 优先 protobuf seg.so（B 站现行弹幕源）；空/失败回退旧 XML
      try {
        items = await fetchDanmakuSegs(cid)
        fetchedOk = true
      } catch (segError) {
        lastError = `seg.so: ${segError instanceof Error ? segError.message : String(segError)}`
        console.warn(`[Bilibili] seg.so 弹幕失败，回退 XML:`, lastError)
      }
      if (items.length === 0) {
        // seg.so 为空（无弹幕/历史老视频数据不全）也走 XML 兜底二次确认
        for (const url of [
          `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`,
          `https://comment.bilibili.com/${cid}.xml`,
        ]) {
          try {
            const xml = await fetchDanmakuXml(url)
            fetchedOk = true
            if (xml) {
              items = parseDanmakuXml(xml)
              break
            }
          } catch (error) {
            lastError = lastError || `${url.includes('list.so') ? 'list.so' : 'comment.xml'}: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
      if (items.length > 0) {
        danmakuCache.set(cid, { items, createdAt: Date.now() })
        pruneCache(danmakuCache, DANMAKU_CACHE_TTL)
        return res.json({ code: 0, danmaku: items })
      }
      if (fetchedOk) {
        // 数据源确认无弹幕：返回空列表并缓存（视频确实无弹幕，或全部为高级弹幕命令）
        danmakuCache.set(cid, { items: [], createdAt: Date.now() })
        return res.json({ code: 0, danmaku: [] })
      }
      // 全部数据源传输失败：不缓存，返回非 0 让渲染端稍后重试
      res.status(502).json({ code: -1, error: lastError || '弹幕接口暂不可用' })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取弹幕失败' })
    }
  })

  // ===== B 站交互端点（发弹幕/评论/投币/点赞/收藏，均需登录 cookie + WBI + CSRF） =====

  /** 取 cookie 中的 CSRF token（bili_jct） */
  const csrfOf = (cookie) => {
    const m = String(resolveBiliCookie(cookie) || '').match(/bili_jct=([^;]+)/)
    return m ? m[1] : ''
  }
  /** POST form 到 B 站（WBI 签名 + CSRF），返回 JSON */
  const postBiliForm = async (url, params, { cookie, csrf } = {}) => {
    const signed = await wbiSign(params)
    const effectiveCookie = resolveBiliCookie(cookie)
    const token = csrf || csrfOf(effectiveCookie)
    const body = new URLSearchParams({ ...signed, ...(token ? { csrf: token } : {}) })
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 12000)
    try {
      const raw = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'User-Agent': BILI_UA,
          Referer: BILI_REFERER,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(effectiveCookie ? { Cookie: buildCookieHeader(effectiveCookie) } : {}),
        },
        body,
      })
      const text = await raw.text()
      try {
        return JSON.parse(text)
      } catch {
        return { code: -1, message: text.slice(0, 200) }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  // 发弹幕（同步 B 站）：type=1 视频弹幕，progress 为毫秒
  app.post('/api/bilibili/danmaku', async (req, res) => {
    const { cid, bvid, aid, msg, progress, color = 0xffffff, fontsize = 25, mode = 1 } = req.body || {}
    if (!cid || !msg) return res.status(400).json({ code: -1, error: 'cid/msg 必填' })
    const cookie = req.body.cookie || req.query.cookie
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/v2/dm/post`, {
        type: 1,
        oid: String(cid),
        msg,
        bvid: bvid || '',
        aid: aid || '',
        progress: String(Math.max(0, Math.round(Number(progress) || 0))),
        color: String(color),
        fontsize: String(fontsize),
        mode: String(mode),
        pool: '0',
        plat: '1',
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '发送弹幕失败' })
      res.json({ code: 0, data: json.data })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '发送弹幕失败' })
    }
  })

  // 评论列表（type=1 视频；mode=3 按热度，pn 分页）
  app.get('/api/bilibili/comments', async (req, res) => {
    const aid = Number(req.query.aid)
    const pn = Number(req.query.pn) || 1
    if (!aid) return res.status(400).json({ code: -1, error: 'aid 必填' })
    try {
      const signed = await wbiSign({ type: 1, oid: String(aid), mode: 3, pn, ps: 20 })
      const json = await fetchBiliJson(`${API_BASE}/x/v2/reply/main`, {
        params: signed,
        cookie: req.query.cookie,
      })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '获取评论失败' })
      const page = json.data?.page || {}
      const replies = json.data?.replies || []
      // 附带顶层评论数/游标，供分页
      res.json({
        code: 0,
        replies,
        page: { num: page.num, size: page.size, total: json.data?.top_replies ? undefined : page.total },
        cursor: json.data?.cursor || null,
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取评论失败' })
    }
  })

  // 某条评论的回复（root 游标分页）
  app.get('/api/bilibili/comment/replies', async (req, res) => {
    const { aid, rpid } = req.query
    const pn = Number(req.query.pn) || 1
    if (!aid || !rpid) return res.status(400).json({ code: -1, error: 'aid/rpid 必填' })
    try {
      const signed = await wbiSign({ type: 1, oid: String(aid), root: String(rpid), ps: 20, pn })
      const json = await fetchBiliJson(`${API_BASE}/x/v2/reply/reply`, {
        params: signed,
        cookie: req.query.cookie,
      })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '获取回复失败' })
      res.json({ code: 0, replies: json.data?.replies || [], page: json.data?.page || {} })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取回复失败' })
    }
  })

  // 发评论 / 回复（root+parent 存在即为回复）
  app.post('/api/bilibili/comment', async (req, res) => {
    const { aid, message, root, parent } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid || !message) return res.status(400).json({ code: -1, error: 'aid/message 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/v2/reply/add`, {
        type: '1',
        oid: String(aid),
        message,
        ...(root ? { root: String(root) } : {}),
        ...(parent ? { parent: String(parent) } : {}),
        post_type: '1',
        platform: '1',
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '发送评论失败' })
      res.json({ code: 0, data: json.data })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '发送评论失败' })
    }
  })

  // 删除评论（需登录且为本人）
  app.post('/api/bilibili/comment/del', async (req, res) => {
    const { aid, rpid } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid || !rpid) return res.status(400).json({ code: -1, error: 'aid/rpid 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/v2/reply/del`, {
        oid: String(aid),
        rpid: String(rpid),
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '删除评论失败' })
      res.json({ code: 0 })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '删除评论失败' })
    }
  })

  // 点赞/取消赞评论（action: 1 点赞，2 取消）
  app.post('/api/bilibili/comment/like', async (req, res) => {
    const { aid, rpid, action = 1 } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid || !rpid) return res.status(400).json({ code: -1, error: 'aid/rpid 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/v2/reply/action`, {
        oid: String(aid),
        rpid: String(rpid),
        action: String(action),
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '评论点赞失败' })
      res.json({ code: 0 })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '评论点赞失败' })
    }
  })

  // 投币（multiply 1/2；select_like 1=同时点赞）
  app.post('/api/bilibili/coin', async (req, res) => {
    const { aid, multiply = 1, selectLike = 0 } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid) return res.status(400).json({ code: -1, error: 'aid 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/web-interface/coin/add`, {
        aid: String(aid),
        multiply: String(multiply),
        select_like: String(selectLike),
        cross_domain: '1',
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '投币失败' })
      res.json({ code: 0, data: json.data })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '投币失败' })
    }
  })

  // 视频点赞（like: 1 点赞，2 取消）
  app.post('/api/bilibili/like', async (req, res) => {
    const { aid, like = 1 } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid) return res.status(400).json({ code: -1, error: 'aid 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/web-interface/archive/like`, {
        aid: String(aid),
        like: String(like),
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '点赞失败' })
      res.json({ code: 0 })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '点赞失败' })
    }
  })

  // 收藏/取消收藏（type=2 视频；add_media_ids 添加，del_media_ids 取消）
  app.post('/api/bilibili/fav', async (req, res) => {
    const { aid, addMediaIds, delMediaIds } = req.body || {}
    const cookie = req.body.cookie || req.query.cookie
    if (!aid) return res.status(400).json({ code: -1, error: 'aid 必填' })
    if (!csrfOf(cookie)) return res.status(401).json({ code: -401, error: '需要登录（B 站扫码登录）' })
    try {
      const json = await postBiliForm(`${API_BASE}/x/v3/fav/resource/deal`, {
        rid: String(aid),
        type: '2',
        ...(addMediaIds ? { add_media_ids: String(addMediaIds) } : {}),
        ...(delMediaIds ? { del_media_ids: String(delMediaIds) } : {}),
      }, { cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, message: json.message || '收藏失败' })
      res.json({ code: 0, data: json.data })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '收藏失败' })
    }
  })

  // 交互状态汇总（未登录返回 0）：点赞态/投币数/今日剩余硬币/收藏态/收藏夹列表
  app.get('/api/bilibili/interaction', async (req, res) => {
    const aid = Number(req.query.aid)
    if (!aid) return res.status(400).json({ code: -1, error: 'aid 必填' })
    const cookie = req.query.cookie
    const out = { isLike: 0, coin: 0, todayCoins: 0, favoured: 0, favFolders: [] }
    try {
      if (csrfOf(cookie)) {
        // 收藏夹列表需要用户自己的 mid（DedeUserID），传 0 会返回空
        const myMid = String(resolveBiliCookie(cookie) || '').match(/DedeUserID=(\d+)/)?.[1] || '0'
        const [likeJson, coinsJson, todayJson, favedJson, favListJson] = await Promise.all([
          fetchBiliJson(`${API_BASE}/x/web-interface/archive/has/like`, { params: { aid: String(aid) }, cookie }),
          fetchBiliJson(`${API_BASE}/x/web-interface/archive/coins`, { params: { aid: String(aid) }, cookie }),
          fetchBiliJson(`${API_BASE}/x/web-interface/coin/today`, { cookie }),
          fetchBiliJson(`${API_BASE}/x/v2/fav/video/favoured`, { params: { aid: String(aid) }, cookie }),
          fetchBiliJson(`${API_BASE}/x/v3/fav/folder/created/list-all`, { params: { up_mid: myMid, type: '2' }, cookie }),
        ])
        out.isLike = likeJson.data?.like === 1 ? 1 : 0
        out.coin = Number(coinsJson.data?.multiply || 0)
        out.todayCoins = Number(todayJson.data?.coins || 0)
        out.favoured = favedJson.data?.favoured === 1 ? 1 : 0
        out.favFolders = Array.isArray(favListJson.data?.list) ? favListJson.data.list.map((f) => ({ id: f.id, name: f.title || f.name })) : []
      }
      res.json({ code: 0, data: out })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取交互状态失败' })
    }
  })

  // 扫码登录：生成二维码
  app.get('/api/bilibili/login/qr/generate', async (req, res) => {
    try {
      await ensureBuvid3()
      const json = await fetchBiliJson(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, {
        referer: 'https://passport.bilibili.com/h5-app/passport/login',
      })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '生成二维码失败' })
      res.json({ code: 0, url: json.data.url, qrcodeKey: json.data.qrcode_key })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '生成二维码失败' })
    }
  })

  // 扫码登录：轮询状态；成功后抓取 SESSDATA 等登录 cookie 存入全局
  app.get('/api/bilibili/login/qr/check', async (req, res) => {
    const qrcodeKey = String(req.query.key || '')
    if (!qrcodeKey) return res.status(400).json({ code: -1, error: 'key 必填' })
    try {
      const upstream = await fetchBili(`${PASSPORT_BASE}/x/passport-login/web/qrcode/poll`, {
        params: { qrcode_key: qrcodeKey },
      })
      const json = await upstream.json()
      const data = json.data || {}
      if (data.code === 0) {
        const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : []
        const sessdata = extractCookieValue(setCookies, 'SESSDATA')
        const biliJct = extractCookieValue(setCookies, 'bili_jct')
        const dedeUserId = extractCookieValue(setCookies, 'DedeUserID')
        const dedeCk = extractCookieValue(setCookies, 'DedeUserID__ckMd5')
        const buvid = extractCookieValue(setCookies, 'buvid3')
        const buvid4 = extractCookieValue(setCookies, 'buvid4')
        if (buvid) bilibiliBuvid3 = buvid
        if (buvid4) bilibiliBuvid4 = buvid4
        const parts = []
        if (sessdata) parts.push(`SESSDATA=${sessdata}`)
        if (biliJct) parts.push(`bili_jct=${biliJct}`)
        if (dedeUserId) parts.push(`DedeUserID=${dedeUserId}`)
        if (dedeCk) parts.push(`DedeUserID__ckMd5=${dedeCk}`)
        if (parts.length) bilibiliCookie = parts.join('; ')
        return res.json({
          code: 0,
          status: parts.length ? 'ok' : 'scanned',
          cookie: parts.length ? bilibiliCookie : '',
          userName: data.url ? '' : '',
        })
      }
      const statusMap = { 86101: 'pending', 86090: 'scanned', 86038: 'expired' }
      res.json({ code: 0, status: statusMap[data.code] || 'unknown' })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '轮询失败' })
    }
  })

  // 显式设置 cookie（应用启动时从 localStorage 恢复）
  app.post('/api/bilibili/cookie', (req, res) => {
    const cookie = String(req.body?.cookie || '').trim()
    if (!cookie) return res.status(400).json({ code: -1, error: 'cookie 必填' })
    bilibiliCookie = cookie
    res.json({ code: 0, ok: true })
  })

  // 登出
  app.delete('/api/bilibili/cookie', (req, res) => {
    bilibiliCookie = ''
    res.json({ code: 0, ok: true })
  })

  // 当前登录用户信息（nav）
  app.get('/api/bilibili/user', async (req, res) => {
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/web-interface/nav`, { cookie: req.query.cookie })
      const data = json.data || {}
      if (json.code !== 0 || !data.isLogin) {
        return res.json({ code: 0, isLogin: false })
      }
      res.json({
        code: 0,
        isLogin: true,
        mid: data.mid || 0,
        uname: data.uname || '',
        face: data.face || '',
        vipType: data.vipStatus === 1 ? data.vipType || 0 : 0,
        level: data.level_info?.current_level ?? 0,
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取用户信息失败' })
    }
  })

  // ===== B 站个人主页 =====

  // 用户公开资料（card 接口：未登录也可查他人；比 space/wbi/acc/info 宽松）
  app.get('/api/bilibili/space/acc', async (req, res) => {
    const mid = Number(req.query.mid)
    if (!mid) return res.status(400).json({ code: -1, error: 'mid 必填' })
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/web-interface/card`, { params: { mid }, cookie: req.query.cookie })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '获取用户资料失败' })
      const card = json.data?.card || {}
      const vip = json.data?.vip || {}
      // 顶栏背景：card 接口的 top_photo 时常为空（未设自定义皮肤的用户尤甚）。
      // 1) x/space/wbi/acc/info 的 data.top_photo（B 站空间页渲染顶图的权威字段，需 WBI+登录态）
      // 2) x/space/topphoto/mall（皮肤商城：未设自定义皮肤的用户返回默认活动横幅，需登录）
      let topPhoto = json.data?.top_photo || ''
      if (!topPhoto) {
        try {
          // acc/info 需 WBI + 登录 cookie 的 CSRF token（bili_jct）+ web_location，缺 token 即使带 cookie 也易风控
          const rawCookie = String(req.query.cookie || '')
          const jctMatch = rawCookie.match(/bili_jct=([^;]+)/)
          const token = jctMatch ? jctMatch[1] : ''
          const signed = await wbiSign({ mid, platform: 'web', web_location: '1550101', ...(token ? { token } : {}) })
          const accJson = await fetchBiliJsonWithRiskRetry(`${API_BASE}/x/space/wbi/acc/info`, {
            params: { ...signed, mid, platform: 'web', web_location: '1550101', ...(token ? { token } : {}) },
            cookie: rawCookie,
          })
          topPhoto = accJson.data?.top_photo || ''
        } catch {
          // 忽略，走 mall 兜底
        }
      }
      if (!topPhoto) {
        try {
          const mallJson = await fetchBiliJson(`${API_BASE}/x/space/topphoto/mall`, {
            params: { mid, web_location: '333.1387' },
            cookie: req.query.cookie,
          })
          const mallData = mallJson.data
          if (mallData && mallJson.code === 0) {
            const list = Array.isArray(mallData.list) ? mallData.list : Array.isArray(mallData) ? mallData : []
            const current = mallData.current && typeof mallData.current === 'object' ? mallData.current : null
            const used = list.find((s) => s && (s.is_use === true || s.is_use === 1 || s.current === true)) || list[0] || null
            const skin = current || used
            topPhoto = (skin?.pic || skin?.image || skin?.img || '') || ''
          }
        } catch {
          // 拿不到顶栏图就留空，前端用渐变兜底
        }
      }
      res.json({
        code: 0,
        data: {
          mid: Number(card.mid) || mid,
          name: card.name || '',
          face: card.face || '',
          sign: card.sign || '',
          level: card.level_info?.current_level ?? 0,
          vipType: vip.vipStatus === 1 ? vip.vipType || 0 : 0,
          fans: card.fans || 0,
          attention: card.attention || 0,
          likes: card.likes || 0,
          officialVerify: card.official_verify?.type ?? -1,
          // 个人主页皮肤横幅（用户可自换，按用户当前设置；B 站给的是原始 URL，前端再拼尺寸后缀）
          topPhoto,
        },
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取用户资料失败' })
    }
  })

  // 用户投稿列表（WBI 签名；未登录可查公开投稿；-352 风控重试一次）
  app.get('/api/bilibili/space/videos', async (req, res) => {
    const mid = Number(req.query.mid)
    const pn = Math.max(1, Number(req.query.pn) || 1)
    const ps = Math.min(30, Math.max(1, Number(req.query.ps) || 10))
    if (!mid) return res.status(400).json({ code: -1, error: 'mid 必填' })
    await ensureBuvid3()
    try {
      const signed = await wbiSign({ mid, pn, ps })
      const json = await fetchBiliJsonWithRiskRetry(`${API_BASE}/x/space/wbi/arc/search`, { params: signed, cookie: req.query.cookie })
      if (json.code !== 0) {
        return res.status(502).json({ code: json.code, error: json.message || '获取投稿失败（可能触发风控）' })
      }
      const list = (json.data?.list?.vlist || []).map((v) => ({
        bvid: v.bvid || '',
        aid: v.aid || 0,
        title: v.title || '',
        pic: v.pic || '',
        play: v.play || 0,
        duration: typeof v.length === 'string' ? parseSearchDuration(v.length) : Number(v.length) || 0,
        author: v.author || '',
        mid: v.mid || mid,
        typename: v.typeid ? String(v.typeid) : '',
        pubdate: v.created || 0,
      }))
      res.json({ code: 0, data: { list, total: json.data?.page?.count || 0 } })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取投稿失败' })
    }
  })

  // 收藏夹列表（需登录；看歌本身要求登录，本人收藏夹为主场景）
  app.get('/api/bilibili/fav/folders', async (req, res) => {
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/v3/fav/folder/created/list-all`, {
        params: { up_mid: Number(req.query.mid) || 0 },
        cookie: req.query.cookie,
      })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '获取收藏夹失败' })
      const list = (json.data?.list || []).map((f) => ({
        id: f.id || 0,
        title: f.title || '',
        mediaCount: f.media_count || 0,
        cover: f.cover || '',
      }))
      res.json({ code: 0, data: { list } })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取收藏夹失败' })
    }
  })

  // 收藏夹内容
  app.get('/api/bilibili/fav/list', async (req, res) => {
    const mediaId = Number(req.query.mediaId)
    const pn = Math.max(1, Number(req.query.pn) || 1)
    const ps = Math.min(20, Math.max(1, Number(req.query.ps) || 10))
    if (!mediaId) return res.status(400).json({ code: -1, error: 'mediaId 必填' })
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/v3/fav/resource/list`, {
        params: { media_id: mediaId, pn, ps },
        cookie: req.query.cookie,
      })
      if (json.code !== 0) return res.status(502).json({ code: json.code, error: json.message || '获取收藏内容失败' })
      const list = (json.data?.medias || []).map((m) => ({
        bvid: m.bvid || '',
        aid: m.id || 0,
        title: m.title || '',
        pic: m.cover || '',
        play: m.cnt_info?.play || 0,
        duration: m.duration || 0,
        author: m.upper?.name || '',
        mid: m.upper?.mid || 0,
        typename: m.type ? String(m.type) : '',
        pubdate: m.pubtime || 0,
      }))
      res.json({ code: 0, data: { list, total: json.data?.info?.media_count || 0, folderTitle: json.data?.info?.title || '' } })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取收藏内容失败' })
    }
  })

  // 观看历史（需登录）：B 站 cursor 接口不认 pn，用 max/view_at 游标分页
  app.get('/api/bilibili/history', async (req, res) => {
    const ps = Math.min(30, Math.max(1, Number(req.query.ps) || 15))
    const max = Math.max(0, Number(req.query.max) || 0)
    const viewAt = Math.max(0, Number(req.query.viewAt) || 0)
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/web-interface/history/cursor`, {
        params: { ps, business: 'archive', max, view_at: viewAt },
        cookie: req.query.cookie,
      })
      if (json.code !== 0) {
        return res.status(json.code === -101 ? 401 : 502).json({ code: json.code, error: json.message || '获取历史失败' })
      }
      const list = (json.data?.list || [])
        // 只保留普通视频（archive）：直播/番剧等混合类型没有 bvid，无法用视频播放器播
        .filter((h) => !h.type || h.type === 'archive' || h.type === 'video')
        .map((h) => {
          const history = h.history || {}
          // bvid 可能出现在顶层 / history 对象 / uri（bilibili://video/BVxxx）三处，逐个兜底
          const uriBvid = String(h.uri || '').match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i)?.[1]
            || String(h.uri || '').match(/\/video\/(BV[0-9A-Za-z]+)/i)?.[1]
            || ''
          return {
            bvid: h.bvid || history.bvid || uriBvid || '',
            aid: h.aid || history.oid || 0,
            title: h.title || '',
            // 历史项封面字段是 cover（不是 pic）
            pic: h.pic || h.cover || '',
            play: h.stat?.view ?? h.view_count ?? 0,
            duration: h.duration || 0,
            author: h.author_name || h.author?.name || history.author_name || '',
            mid: h.author_mid || h.author?.mid || 0,
            typename: h.type ? String(h.type) : '',
            progress: h.progress || 0,
            viewAt: h.view_at || 0,
          }
        })
        // 没有 bvid 的项（残留异常数据）不返回，前端不会再点到"bvid 必填"
        .filter((v) => v.bvid)
      const cursor = json.data?.cursor || null
      res.json({
        code: 0,
        data: { list, cursor, hasMore: cursor?.has_more === 1 },
      })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取历史失败' })
    }
  })

  // 关注列表（需登录）
  app.get('/api/bilibili/followings', async (req, res) => {
    const mid = Number(req.query.mid)
    const pn = Math.max(1, Number(req.query.pn) || 1)
    const ps = Math.min(30, Math.max(1, Number(req.query.ps) || 12))
    if (!mid) return res.status(400).json({ code: -1, error: 'mid 必填' })
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/relation/followings`, {
        params: { vmid: mid, pn, ps, order: 'desc' },
        cookie: req.query.cookie,
      })
      if (json.code !== 0) {
        return res.status(json.code === -101 ? 401 : 502).json({ code: json.code, error: json.message || '获取关注列表失败' })
      }
      const list = (json.data?.list || []).map((u) => ({
        mid: u.mid || 0,
        uname: u.uname || '',
        face: u.face || '',
        sign: u.sign || '',
      }))
      res.json({ code: 0, data: { list, total: json.data?.total || 0 } })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取关注列表失败' })
    }
  })
}
