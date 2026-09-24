import { createHash } from 'node:crypto'
import dns from 'node:dns'
import net from 'node:net'
import { ByteLruCache, readResponseWithLimit } from './byte-lru-cache.mjs'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_CACHE_ITEM_BYTES = 10 * 1024 * 1024
const DEFAULT_CACHE_HEADERS = 'private, max-age=3600'
const DEFAULT_MAX_INFLIGHT = 32
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const IMAGE_TYPES = new Set([
  'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/jpg', 'image/png',
  'image/vnd.microsoft.icon', 'image/webp', 'image/x-icon',
])
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'

export class ImageProxyError extends Error {
  constructor(status, message, cause) {
    super(message, cause ? { cause } : undefined)
    this.name = 'ImageProxyError'
    this.status = status
  }
}

function parseIPv4(address) {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return null
  return parts.reduce((value, part) => (value * 256) + Number(part), 0) >>> 0
}

function inIPv4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (base & mask)
}

export function isBlockedIpAddress(address) {
  const normalized = String(address || '').split('%', 1)[0].toLowerCase()
  if (net.isIP(normalized) === 4) {
    const value = parseIPv4(normalized)
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ]
    return blocked.some(([base, prefix]) => inIPv4Range(value, parseIPv4(base), prefix))
  }
  if (net.isIP(normalized) !== 6) return true

  const mapped = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isBlockedIpAddress(mapped[1])
  // Public IPv6 unicast is 2000::/3. Explicitly reject documentation space inside it.
  return !/^[23][0-9a-f]{3}:/i.test(normalized) || /^2001:db8:/i.test(normalized)
}

function isLocalCoverEndpoint(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return url.protocol === 'http:' && url.port === '3001' &&
    (host === 'localhost' || host === '127.0.0.1' || host === '::1') &&
    url.pathname === '/api/cover'
}

function isLocalCoverWrapper(url) {
  const params = [...url.searchParams.keys()]
  return isLocalCoverEndpoint(url) && !url.username && !url.password && !url.hash &&
    url.searchParams.getAll('url').length === 1 && params.every(name => name === 'url' || name === 'devMode')
}

export function canonicalizeImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 16_384) throw new ImageProxyError(400, 'Invalid image url')
  let url
  try {
    url = new URL(rawUrl)
    for (let depth = 0; depth < 5 && isLocalCoverWrapper(url); depth += 1) {
      url = new URL(url.searchParams.get('url'))
    }
  } catch (error) {
    throw new ImageProxyError(400, 'Invalid image url', error)
  }
  if (isLocalCoverEndpoint(url) || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new ImageProxyError(400, 'Invalid image url')
  }
  url.hash = ''
  return url.href
}

async function lookupWithSignal(lookup, hostname, signal) {
  if (signal.aborted) throw signal.reason
  let onAbort
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        onAbort = () => reject(signal.reason || new Error('aborted'))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

async function validatePublicUrl(rawUrl, lookup, signal) {
  const url = new URL(rawUrl)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new ImageProxyError(400, 'Image URL is not public')
  }
  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) throw new ImageProxyError(400, 'Image URL is not public')
    return
  }
  let addresses
  try {
    addresses = await lookupWithSignal(lookup, hostname, signal)
  } catch (error) {
    throw new ImageProxyError(signal.aborted ? 504 : 502, signal.aborted ? 'Image request timed out' : 'Image DNS lookup failed', error)
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => isBlockedIpAddress(address))) {
    throw new ImageProxyError(400, 'Image URL is not public')
  }
}

function requestHeaders(url) {
  const hostname = new URL(url).hostname
  const referer = /(^|\.)(?:music\.163\.com|music\.126\.net)$/i.test(hostname)
    ? 'https://music.163.com/'
    : /(^|\.)(?:mzstatic\.com|apple\.com)$/i.test(hostname)
      ? 'https://music.apple.com/'
      : /(^|\.)(?:y\.gtimg\.cn|qqmusic\.qq\.com)$/i.test(hostname)
        ? 'https://y.qq.com/'
        : undefined
  return {
    'User-Agent': USER_AGENT,
    ...(referer ? { Referer: referer } : {}),
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
}

async function fetchImage(rawUrl, { fetchImpl, lookup, signal, maxRedirects, maxBytes }) {
  let currentUrl = rawUrl
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await validatePublicUrl(currentUrl, lookup, signal)
    let response
    try {
      response = await fetchImpl(currentUrl, { headers: requestHeaders(currentUrl), redirect: 'manual', signal })
    } catch (error) {
      throw new ImageProxyError(signal.aborted ? 504 : 502, signal.aborted ? 'Image request timed out' : 'Failed to fetch image', error)
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      response.body?.cancel?.().catch?.(() => undefined)
      if (hop === maxRedirects) throw new ImageProxyError(502, 'Too many image redirects')
      const location = response.headers.get('location')
      if (!location) throw new ImageProxyError(502, 'Image redirect is missing location')
      try {
        currentUrl = canonicalizeImageUrl(new URL(location, currentUrl).href)
      } catch (error) {
        if (error instanceof ImageProxyError && error.status === 400) throw new ImageProxyError(502, 'Invalid image redirect', error)
        throw error
      }
      continue
    }
    if (!response.ok) throw new ImageProxyError(response.status, `Image upstream returned ${response.status}`)
    const contentType = String(response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
    if (!IMAGE_TYPES.has(contentType)) throw new ImageProxyError(415, 'Image upstream returned an unsupported MIME type')
    let buffer
    try {
      buffer = await readResponseWithLimit(response, maxBytes, signal)
    } catch (error) {
      if (signal.aborted) throw new ImageProxyError(504, 'Image request timed out', error)
      if (/byte limit|content-length/.test(error?.message || '')) throw new ImageProxyError(413, 'Image is too large', error)
      throw new ImageProxyError(502, 'Failed to read image', error)
    }
    return { buffer, type: contentType, etag: `"${createHash('sha256').update(buffer).digest('base64url')}"` }
  }
  throw new ImageProxyError(502, 'Too many image redirects')
}

/** 上游偶发限流（QQ 图床实测会回 429/503）：这些状态值得等一拍重试一次，把「封面失败」变成「慢一点」。 */
const UPSTREAM_RETRY_STATUSES = new Set([429, 500, 502, 503, 504])
const UPSTREAM_RETRY_DELAY_MS = 500

async function fetchImageWithRetry(url, options) {
  try {
    return await fetchImage(url, options)
  } catch (error) {
    const status = error instanceof ImageProxyError ? error.status : 0
    const signal = options.signal
    if (signal?.aborted || !UPSTREAM_RETRY_STATUSES.has(status)) throw error
    await new Promise(resolve => {
      const timer = setTimeout(resolve, UPSTREAM_RETRY_DELAY_MS)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
    if (signal?.aborted) throw error
    return await fetchImage(url, options)
  }
}

function etagMatches(header, etag) {
  if (typeof header !== 'string') return false
  return header.split(',').some(value => {
    const tag = value.trim()
    return tag === '*' || tag === etag || tag.replace(/^W\//, '') === etag
  })
}

/**
 * 内容寻址的图床：URL 里带图片 id / 尺寸参数，同一 URL 的内容不会变，
 * 可以让浏览器长期缓存（此前只有 mzstatic 享受，其余图床仅 1h，导致反复 304/回源）。
 * netease（param=NxN）/ QQ（T002R 尺寸）/ kugou（{size}）都由渲染端改写尺寸，URL 即内容版本。
 */
const IMMUTABLE_ARTWORK_HOST_PATTERN = /(^|\.)(mzstatic\.com|music\.126\.net|y\.gtimg\.cn|kgimg\.com|kugou\.com)$/i

function isImmutableArtworkHost(url) {
  try {
    return IMMUTABLE_ARTWORK_HOST_PATTERN.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function setImageHeaders(res, entry, cacheControl, includeLength = true) {
  const headers = {
    'Content-Type': entry.type,
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': cacheControl,
    ETag: entry.etag,
    'X-Content-Type-Options': 'nosniff',
  }
  if (includeLength) headers['Content-Length'] = String(entry.buffer.length)
  res.set(headers)
}

export function createImageProxy(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    lookup = dns.promises.lookup,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxCacheItemBytes = DEFAULT_CACHE_ITEM_BYTES,
    maxRedirects = 5,
    cacheControl = DEFAULT_CACHE_HEADERS,
    maxInflight = DEFAULT_MAX_INFLIGHT,
    cache = new ByteLruCache({ maxBytes: 128 * 1024 * 1024, maxEntries: 800, ttlMs: 6 * 60 * 60 * 1000 }),
  } = options
  if (!Number.isSafeInteger(maxInflight) || maxInflight <= 0) throw new TypeError('maxInflight must be a positive safe integer')
  const inFlight = new Map()

  async function load(key) {
    const cached = cache.get(key)
    if (cached) return cached
    let pending = inFlight.get(key)
    if (!pending) {
      if (inFlight.size >= maxInflight) throw new ImageProxyError(503, 'Too many image requests in progress')
      pending = (async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const entry = await fetchImageWithRetry(key, { fetchImpl, lookup, signal: controller.signal, maxRedirects, maxBytes })
          if (entry.buffer.length <= maxCacheItemBytes) cache.set(key, entry, entry.buffer.length)
          return entry
        } finally {
          clearTimeout(timer)
        }
      })()
      inFlight.set(key, pending)
      pending.finally(() => inFlight.delete(key)).catch(() => undefined)
    }
    return pending
  }

  async function handler(req, res) {
    try {
      const key = canonicalizeImageUrl(req.query?.url)
      const entry = await load(key)
      // Apple mzstatic 的 URL 是内容寻址（含不可变内容 UUID），实测同 URL 二次加载不重新校验，
      // 因此对这类图直接声明不可变长缓存；其余图床保持原有短缓存策略。
      const effectiveCacheControl = isImmutableArtworkHost(key)
        ? 'public, max-age=31536000, immutable'
        : cacheControl
      if (etagMatches(req.headers?.['if-none-match'], entry.etag)) {
        setImageHeaders(res, entry, effectiveCacheControl, false)
        return res.status(304).end()
      }
      setImageHeaders(res, entry, effectiveCacheControl)
      return res.status(200).send(entry.buffer)
    } catch (error) {
      const status = error instanceof ImageProxyError ? error.status : 500
      const message = error instanceof ImageProxyError ? error.message : 'Failed to load image'
      if (status >= 500) console.error('[ImageProxy]', error?.cause?.message || error?.message || error)
      if (res.headersSent) return res.destroy()
      return res.status(status).set({
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'private, no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      }).send(message)
    }
  }

  return { handler, cache, inFlight, maxInflight }
}

export function registerImageProxyRoutes(app, options) {
  const proxy = createImageProxy(options)
  app.get('/api/cover', proxy.handler)
  app.get('/api/proxy-image', proxy.handler)
  return proxy
}
