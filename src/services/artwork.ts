import { getApiBase } from './apiConfig'

export type ArtworkRole = 'row' | 'compact' | 'card' | 'hero' | 'player' | 'background' | 'texture'
export type ArtworkPriority = 'critical' | 'visible' | 'deferred'

const SIZE_BUCKETS = [64, 128, 256, 512, 1024] as const
const DEFAULT_ROLE_SIZE: Record<ArtworkRole, number> = {
  row: 64,
  compact: 128,
  card: 256,
  hero: 512,
  player: 512,
  background: 1024,
  texture: 1024,
}

const NETEASE_IMAGE_HOST = /(^|\.)(music\.126\.net|music\.163\.com)$/i
const QQ_IMAGE_HOST = /(^|\.)(y\.gtimg\.cn|qqmusic\.qq\.com)$/i
const APPLE_IMAGE_HOST = /(^|\.)(mzstatic\.com|apple\.com)$/i
const KUGOU_IMAGE_HOST = /(^|\.)(kugou\.com|kgimg\.com)$/i

export function getArtworkSizeBucket(requested: number): number {
  const safe = Number.isFinite(requested) ? Math.max(1, requested) : 512
  return SIZE_BUCKETS.find(size => size >= safe) || SIZE_BUCKETS[SIZE_BUCKETS.length - 1]
}

export function getArtworkRoleSize(role: ArtworkRole, cssPixels?: number, dpr?: number): number {
  const pixelRatio = Number.isFinite(dpr) && Number(dpr) > 0
    ? Math.min(3, Number(dpr))
    : typeof window !== 'undefined'
      ? Math.min(3, Math.max(1, window.devicePixelRatio || 1))
      : 1
  return getArtworkSizeBucket((cssPixels || DEFAULT_ROLE_SIZE[role]) * pixelRatio)
}

function isCoverProxy(url: URL): boolean {
  try {
    const proxy = new URL(`${getApiBase()}/cover`)
    if (url.origin === proxy.origin && url.pathname === proxy.pathname) return true
  } catch {
    // Fall through to the stable local route check.
  }
  return /^(?:localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)
    && url.port === '3001'
    && url.pathname === '/api/cover'
}

export function unwrapArtworkSource(input: string): string {
  let current = String(input || '').trim()
  for (let depth = 0; depth < 2; depth += 1) {
    try {
      const parsed = new URL(current)
      if (!isCoverProxy(parsed)) return current
      const nested = parsed.searchParams.get('url') || ''
      if (!/^https?:\/\//i.test(nested) || nested === current) return current
      current = nested
    } catch {
      return current
    }
  }
  return current
}

export function resizeArtworkSource(sourceUrl: string, size: number): string {
  const bucket = getArtworkSizeBucket(size)
  try {
    const url = new URL(sourceUrl)
    const host = url.hostname
    if (NETEASE_IMAGE_HOST.test(host)) {
      // 不能用 searchParams/new URL 往返重编码：网易云封面常带 `enlarge=1|imageView=1` 与无值参数
      // `watermark`，重编码会把 `=` 变 %3D、`watermark` 变 `watermark=`，上游直接 400
      // （实测「发现-音乐」大量频道封面因此加载失败）。改成纯字符串拼接，保留原始编码。
      //
      // 必须幂等：同一张图会被解析两次（CachedImage 先解析出渲染地址，preloadArtwork 再解析一次），
      // 已带 `param=NyN` 时必须替换而不是追加，否则两次解析结果不相等，组件会判定加载结果与
      // 当前地址不一致而一直停在空占位符（实测歌单详情封面整块空白）。
      const existing = /([?&])param=\d+y\d+/i
      if (existing.test(sourceUrl)) return sourceUrl.replace(existing, `$1param=${bucket}y${bucket}`)
      const joiner = sourceUrl.includes('?') ? '&' : '?'
      return `${sourceUrl}${joiner}param=${bucket}y${bucket}`
    }
    if (QQ_IMAGE_HOST.test(host)) {
      const requested = bucket > 300 ? 500 : 300
      url.pathname = url.pathname.replace(/T002R\d+x\d+/i, `T002R${requested}x${requested}`)
      return url.toString()
    }
    if (APPLE_IMAGE_HOST.test(host)) {
      // mzstatic 的占位符必须全部替换，否则整条 URL 直接 404/加载失败：
      // 实测 {f} 未替换 → 404；{c} 用 cc（居中方形裁切）——用 bb 会因原图是 4:1 只返回细条，拉伸后严重模糊。
      url.pathname = url.pathname
        .replace(/(?:\{w\}|%7Bw%7D)/gi, String(bucket))
        .replace(/(?:\{h\}|%7Bh%7D)/gi, String(bucket))
        .replace(/(?:\{c\}|%7Bc%7D)/gi, 'cc')
        .replace(/(?:\{f\}|%7Bf%7D)/gi, 'jpg')
        .replace(/\d+x\d+bb(?=\.[a-z]+$)/i, `${bucket}x${bucket}bb`)
      return url.toString()
    }
    if (KUGOU_IMAGE_HOST.test(host)) {
      url.pathname = url.pathname.replace(/\{size\}/gi, String(bucket))
      return url.toString()
    }
  } catch {
    return sourceUrl
  }
  return sourceUrl
}

export interface ResolveArtworkOptions {
  role?: ArtworkRole
  cssPixels?: number
  dpr?: number
  size?: number
  platform?: string
}

export function resolveArtworkUrl(input: string, options: ResolveArtworkOptions = {}): string {
  const source = unwrapArtworkSource(input)
  if (!/^https?:\/\//i.test(source)) return ''
  const size = options.size
    ? getArtworkSizeBucket(options.size)
    : getArtworkRoleSize(options.role || 'player', options.cssPixels, options.dpr)
  const rendition = resizeArtworkSource(source, size)
  return `${getApiBase()}/cover?url=${encodeURIComponent(rendition)}`
}
