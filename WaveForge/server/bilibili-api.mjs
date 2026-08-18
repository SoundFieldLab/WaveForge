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

const STREAM_CACHE_TTL = 10 * 60 * 1000
const WBI_CACHE_TTL = 60 * 60 * 1000

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
      res.json({
        code: 0,
        data: {
          bvid: data.bvid,
          aid: data.aid,
          cid: page.cid || 0,
          title: data.title || '',
          duration: data.duration || 0,
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
            officialVerifyType: data.owner?.official_verify?.type ?? -1,
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
        const subCacheKey = `bili_sub_${bvid}_${cid}_${s.lan || 'xx'}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        subtitleJsonCache.set(subCacheKey, { url: s.subtitle_url, createdAt: Date.now() })
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
    const entry = key ? subtitleJsonCache.get(key) : undefined
    if (!entry) return res.status(410).json({ code: -1, error: '字幕缓存已过期，请重新获取' })
    try {
      const json = await fetchBiliJson(entry.url, { referer: BILI_REFERER })
      res.json(json)
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '字幕拉取失败' })
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
          officialVerify: card.official_verify?.type ?? 0,
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

  // 观看历史（需登录）
  app.get('/api/bilibili/history', async (req, res) => {
    const pn = Math.max(1, Number(req.query.pn) || 1)
    const ps = Math.min(30, Math.max(1, Number(req.query.ps) || 15))
    await ensureBuvid3()
    try {
      const json = await fetchBiliJson(`${API_BASE}/x/web-interface/history/cursor`, {
        params: { ps, pn },
        cookie: req.query.cookie,
      })
      if (json.code !== 0) {
        return res.status(json.code === -101 ? 401 : 502).json({ code: json.code, error: json.message || '获取历史失败' })
      }
      const list = (json.data?.list || []).map((h) => ({
        bvid: h.bvid || '',
        aid: h.aid || 0,
        title: h.title || '',
        pic: h.pic || '',
        play: h.stat?.view || 0,
        duration: h.duration || 0,
        author: h.author_name || h.author?.name || '',
        mid: h.author_mid || h.author?.mid || 0,
        typename: h.type ? String(h.type) : '',
        progress: h.progress || 0,
        viewAt: h.view_at || 0,
      }))
      res.json({ code: 0, data: { list, cursor: json.data?.cursor || null } })
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
