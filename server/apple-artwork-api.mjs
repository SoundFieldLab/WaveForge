/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 动态封面（Animated Artwork）服务端代理
 *
 * 渲染进程直连 amp-api 有 CORS 限制，且自定义 Origin 头在浏览器 fetch 里不可设，
 * 因此整个链路放在本地服务端完成：
 * 1. 从 music.apple.com 页面主 JS bundle 提取网页版媒体 JWT（kid=WebPlayKid）
 * 2. amp-api 按 storefront 轮询搜索（cn/hk/tw/us/gb/jp/de/fr），打分匹配曲目/专辑
 * 3. albums/{id}?extend=editorialVideo 拿动态封面 HLS（motionDetailSquare 优先）
 * 4. 解析 master 播放列表，按场景挑 AVC 变体（小封面 ≤640 / 全屏背景 ≤1080）
 *
 * 参考实现：github.com/bunnykek/Apple-Music-Animated-Artwork-Fetcher
 * （技术路线按公开接口自行实现）
 */

const AMP_API_BASE = 'https://amp-api.music.apple.com/v1/catalog'
const STOREFRONTS = ['cn', 'hk', 'tw', 'us', 'gb', 'jp', 'de', 'fr']
const MOTION_KEYS = ['motionDetailSquare', 'motionSquareVideo1x1', 'motionDetailTall']
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 内存 token 缓存（按 JWT exp 提前 10 分钟过期） */
let cachedToken = null
let cachedTokenExp = 0
let tokenPromise = null

const base64urlToJson = (segment) => {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

const getTokenExp = (jwt) => {
  try {
    const payload = base64urlToJson(jwt.split('.')[1])
    const exp = Number(payload.exp)
    if (Number.isFinite(exp) && exp > 0) return exp * 1000 - 10 * 60 * 1000
  } catch { /* 解析失败按未知处理 */ }
  return 0
}

/** 从 music.apple.com 的主 JS bundle 提取 kid=WebPlayKid 的 JWT */
const fetchFreshToken = async () => {
  const pageResp = await fetch('https://music.apple.com/us/album/positions-deluxe-edition/1553944254', {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  })
  if (!pageResp.ok) throw new Error(`apple page HTTP ${pageResp.status}`)
  const page = await pageResp.text()
  const assetPath = /crossorigin src="(\/assets\/index.+?\.js)"/.exec(page)?.[1]
  if (!assetPath) throw new Error('apple music page asset not found')
  const jsResp = await fetch(`https://music.apple.com${assetPath}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(15000),
  })
  if (!jsResp.ok) throw new Error(`apple bundle HTTP ${jsResp.status}`)
  const js = await jsResp.text()
  const jwtRegex = /e[yw][A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*\.[A-Za-z0-9\-_]{2,}(?:(?:\.[A-Za-z0-9\-_]{2,}){2})?/g
  for (const jwt of js.match(jwtRegex) || []) {
    try {
      const header = base64urlToJson(jwt.split('.')[0])
      if (header?.kid === 'WebPlayKid') return jwt
    } catch { /* 尝试下一个候选 */ }
  }
  throw new Error('WebPlayKid token not found in bundle')
}

const getWebToken = async () => {
  if (cachedToken && cachedTokenExp > Date.now()) return cachedToken
  if (tokenPromise) return tokenPromise
  tokenPromise = fetchFreshToken()
    .then((token) => {
      cachedToken = token
      cachedTokenExp = getTokenExp(token) || Date.now() + 6 * 60 * 60 * 1000
      return token
    })
    .finally(() => { tokenPromise = null })
  return tokenPromise
}

const clearToken = () => {
  cachedToken = null
  cachedTokenExp = 0
}

const ampFetchJson = async (url) => {
  const token = await getWebToken()
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'https://music.apple.com',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  })
  if (resp.status === 401 || resp.status === 403) {
    clearToken()
    throw new Error(`apple api auth failed: ${resp.status}`)
  }
  if (!resp.ok) throw new Error(`apple api HTTP ${resp.status}`)
  return resp.json()
}

/** 文本归一化（比较用）：去括号内容与装饰字符 */
const normalize = (text) => String(text ?? '')
  .toLowerCase()
  .replace(/（.*?）|\(.*?\)|【.*?】|\[.*?]/g, '')
  .replace(/[\u3010\u3011\u005b\u005d\uff08\uff09()]/g, '')
  .replace(/[\u200b\u200b\u00ad]/g, '')
  .replace(/\s+/g, ' ')
  .trim()

/** 严格匹配校验：标题必须命中（相等或包含），歌手或时长二选一验证——
 *  避免同名不同曲误判（WaveForge 高置信匹配规则，比 LCS 打分更严） */
const isHighConfidenceMatch = (item, query) => {
  const t = normalize(item.name)
  const songT = normalize(query.title)
  if (!songT || !t) return false
  const titleOk = t === songT || t.includes(songT) || songT.includes(t)
  if (!titleOk) return false
  const a = normalize(item.artistName)
  const songA = normalize(query.artist)
  const artistOk = songA && a && (a === songA || a.includes(songA) || songA.includes(a))
  const durationOk = query.duration
    ? Math.abs((item.durationMs || 0) - query.duration) < 3000
    : false
  return artistOk || durationOk
}

const searchCandidates = async (term) => {
  for (const storefront of STOREFRONTS) {
    try {
      const url = `${AMP_API_BASE}/${storefront}/search?term=${encodeURIComponent(term)}&types=albums,songs&limit=10`
      const data = await ampFetchJson(url)
      const results = data?.results ?? {}
      const albums = results.albums?.data ?? []
      const songs = results.songs?.data ?? []
      const list = []
      for (const song of songs) {
        const attrs = song.attributes ?? {}
        const relationships = song.relationships ?? {}
        list.push({
          id: song.id,
          resourceType: 'song',
          storefront,
          name: attrs.name ?? '',
          artistName: attrs.artistName ?? '',
          albumName: attrs.albumName ?? '',
          albumId: relationships.albums?.data?.[0]?.id ?? null,
          durationMs: attrs.durationMs ?? 0,
        })
      }
      // editorialVideo 挂在专辑上：专辑结果直接补入（部分歌的动态封面只在专辑维度）
      for (const album of albums) {
        const attrs = album.attributes ?? {}
        list.push({
          id: album.id,
          resourceType: 'album',
          storefront,
          name: attrs.name ?? '',
          artistName: attrs.artistName ?? '',
          albumName: attrs.name ?? '',
          albumId: album.id,
          durationMs: 0,
        })
      }
      if (list.length) return list
    } catch (error) {
      console.warn(`[AppleArtwork] search failed (${storefront}):`, error.message)
    }
  }
  return []
}

const getEditorialVideo = async (albumId, preferredStorefront) => {
  const storefronts = [preferredStorefront, ...STOREFRONTS.filter((s) => s !== preferredStorefront)]
  for (const storefront of storefronts) {
    try {
      const data = await ampFetchJson(`${AMP_API_BASE}/${storefront}/albums/${albumId}?extend=editorialVideo`)
      const editorialVideo = data?.data?.[0]?.attributes?.editorialVideo
      if (!editorialVideo) continue
      for (const key of MOTION_KEYS) {
        const motion = editorialVideo[key]
        if (!motion?.video) continue
        const posterUrl = motion.previewFrame?.url
          ? String(motion.previewFrame.url).replace(/\{w\}x\{h\}/, '600x600')
          : null
        return { masterUrl: motion.video, posterUrl, storefront }
      }
    } catch (error) {
      console.warn(`[AppleArtwork] editorialVideo failed (${storefront}):`, error.message)
    }
  }
  return null
}

/** HLS master 解析：挑 AVC 变体中不超过 maxEdge 的最高档（无 AVC 时取中档） */
const pickVariantUrl = (masterText, masterUrl, maxEdge) => {
  try {
    const lines = masterText.split(/\r?\n/)
    const variants = []
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue
      let uri = ''
      for (let next = i + 1; next < lines.length; next++) {
        const candidate = lines[next].trim()
        if (!candidate) continue
        if (candidate.startsWith('#')) break
        uri = candidate
        break
      }
      if (!uri) continue
      const codecs = /CODECS="([^"]*)"/.exec(lines[i])?.[1] ?? ''
      const resolution = /RESOLUTION=(\d+x\d+)/.exec(lines[i])?.[1] ?? ''
      const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0)
      const [width = 0, height = 0] = resolution.split('x').map(Number)
      variants.push({ uri, codecs, width, height, bandwidth })
    }
    if (!variants.length) return masterUrl
    const isAvc = (codecs) => /avc1|avc3|mp4v/i.test(codecs)
    const pool = variants.filter((v) => isAvc(v.codecs))
    const candidates = pool.length ? pool : variants
    const withRes = candidates.filter((v) => v.width > 0 && v.height > 0)
    const within = withRes.filter((v) => Math.max(v.width, v.height) <= maxEdge)
    const sorted = (within.length ? within : (withRes.length ? withRes : candidates))
      .sort((a, b) => (Math.max(b.width, b.height) || 0) - (Math.max(a.width, a.height) || 0) || b.bandwidth - a.bandwidth)
    const chosen = pool.length ? sorted[0] : sorted[Math.floor(sorted.length / 2)] ?? sorted[0]
    if (!chosen) return masterUrl
    try {
      return new URL(chosen.uri, masterUrl).href
    } catch {
      return chosen.uri
    }
  } catch {
    return masterUrl
  }
}

/** 结果缓存（LRU 50）+ 同 key 并发去重 */
const resultCache = new Map()
const pending = new Map()
const MAX_CACHE = 50

export function registerAppleArtworkRoutes(app) {
  app.get('/api/apple/animated-cover', async (req, res) => {
    const title = String(req.query.title || '').trim()
    const artist = String(req.query.artist || '').trim()
    const album = String(req.query.album || '').trim()
    const duration = Number(req.query.duration) || 0
    if (!title) return res.status(400).json({ code: -1, error: 'title 必填' })

    const cacheKey = `${title}|${artist}|${album}|${duration}`
    if (resultCache.has(cacheKey)) return res.json({ code: 0, ...(resultCache.get(cacheKey) || { cover: null }) })
    if (pending.has(cacheKey)) {
      const result = await pending.get(cacheKey)
      return res.json({ code: 0, ...result })
    }

    const task = (async () => {
      const term = [title, artist].filter(Boolean).slice(0, 2).join(' ')
      const candidates = await searchCandidates(term)
      // 严格高置信匹配优先；歌曲结果优先于专辑（有时长可校验）
      const matched = candidates.find((item) => item.resourceType === 'song' && isHighConfidenceMatch(item, { title, artist, duration }))
        ?? candidates.find((item) => isHighConfidenceMatch(item, { title, artist, duration }))
      if (!matched) return { cover: null }

      let albumId = matched.albumId
      if (!albumId && matched.resourceType === 'song') {
        try {
          const data = await ampFetchJson(`${AMP_API_BASE}/${matched.storefront}/songs/${matched.id}?include=albums`)
          albumId = data?.data?.[0]?.relationships?.albums?.data?.[0]?.id ?? null
        } catch { /* 无专辑关系则放弃 */ }
      }
      if (!albumId) return { cover: null }

      const editorial = await getEditorialVideo(albumId, matched.storefront)
      if (!editorial) return { cover: null }

      // master → 按场景变体（小封面 640 / 全屏背景 1080）
      let videoUrl = editorial.masterUrl
      let videoUrlImmersive = editorial.masterUrl
      try {
        const masterResp = await fetch(editorial.masterUrl, {
          headers: { 'User-Agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        })
        if (masterResp.ok) {
          const masterText = await masterResp.text()
          videoUrl = pickVariantUrl(masterText, editorial.masterUrl, 640)
          videoUrlImmersive = pickVariantUrl(masterText, editorial.masterUrl, 1080)
        }
      } catch (error) {
        console.warn('[AppleArtwork] master resolve failed, use master directly:', error.message)
      }

      return {
        cover: {
          videoUrl,
          videoUrlImmersive,
          posterUrl: editorial.posterUrl,
          albumId: String(albumId),
          storefront: editorial.storefront,
        },
      }
    })()

    pending.set(cacheKey, task)
    try {
      const result = await task
      resultCache.set(cacheKey, result)
      if (resultCache.size > MAX_CACHE) {
        resultCache.delete(resultCache.keys().next().value)
      }
      res.json({ code: 0, ...result })
    } catch (error) {
      res.status(502).json({ code: -1, error: error.message || '获取动态封面失败' })
    } finally {
      pending.delete(cacheKey)
    }
  })
}
