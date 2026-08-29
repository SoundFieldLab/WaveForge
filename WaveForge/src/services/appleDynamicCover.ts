/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 动态封面（Animated Artwork）渲染端服务。
 * 数据链路在本地服务端（server/apple-artwork-api.mjs）：web token 提取 →
 * amp-api storefront 搜索 → editorialVideo → HLS 变体选择。
 * 这里只做请求封装 + 会话级缓存 + 设置门控。
 */

export interface AppleDynamicCoverData {
  /** 小封面场景的动态封面地址（HLS 媒体/主播放列表） */
  videoUrl: string
  /** 全屏背景场景的动态封面地址（更高分辨率变体） */
  videoUrlImmersive: string
  /** 预览帧（可作 poster） */
  posterUrl: string | null
  albumId: string
  storefront: string
}

const API_ENDPOINT = 'http://localhost:3001/api/apple/animated-cover'
const CACHE_MAX = 50
const cache = new Map<string, AppleDynamicCoverData | null>()

/** 动态封面总开关（与 Apple Music 歌词设置相互独立，默认关闭） */
export function isAppleDynamicCoverEnabled(): boolean {
  try {
    return localStorage.getItem('appleDynamicCoverEnabled') === 'true'
  } catch {
    return false
  }
}

export function setAppleDynamicCoverEnabled(enabled: boolean): void {
  try {
    localStorage.setItem('appleDynamicCoverEnabled', enabled ? 'true' : 'false')
  } catch { /* 忽略 */ }
  window.dispatchEvent(new CustomEvent('appleDynamicCoverSettingChanged', { detail: enabled }))
}

/**
 * 查询某首歌的 Apple Music 动态封面。
 * 返回 null 表示：未开启 / 该曲无动态封面 / 匹配失败（调用方回退静态封面）。
 */
export async function getAppleDynamicCover(query: {
  title: string
  artist: string
  album?: string
  duration?: number
  signal?: AbortSignal
}): Promise<AppleDynamicCoverData | null> {
  // 动态封面走免登录 web token（服务端提取），与 AM 歌词登录/开关完全独立
  if (!isAppleDynamicCoverEnabled()) return null
  const title = query.title?.trim()
  if (!title) return null
  const cacheKey = `${title}|${query.artist || ''}|${query.album || ''}`
  if (cache.has(cacheKey)) return cache.get(cacheKey) ?? null

  try {
    const params = new URLSearchParams({ title, artist: query.artist || '', album: query.album || '' })
    if (query.duration) params.set('duration', String(Math.round(query.duration)))
    const resp = await fetch(`${API_ENDPOINT}?${params.toString()}`, { signal: query.signal })
    if (!resp.ok) return null
    const json = await resp.json()
    const result = json?.code === 0 && json.cover ? (json.cover as AppleDynamicCoverData) : null
    cache.set(cacheKey, result)
    if (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    return result
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') return null
    console.warn('[AppleDynamicCover] 查询失败:', (error as Error)?.message)
    return null
  }
}

/** 清空会话缓存（设置变化/手动刷新时） */
export function clearAppleDynamicCoverCache(): void {
  cache.clear()
}
