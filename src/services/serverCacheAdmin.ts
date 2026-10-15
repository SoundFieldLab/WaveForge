import { getApiBase } from './apiConfig'

/**
 * 服务端（local-server，端口 3001）内存缓存的清理入口。
 *
 * 这些缓存活在服务端进程里，与渲染端的 IndexedDB / 内存缓存是两回事：前端此前只有
 * 图片代理一个清理入口（放在 artworkLoader 里，语义上也只对封面），其余全部够不着——
 * 汽水解密缓存最多 256MB、歌词缓存、B 站播放地址/字幕/弹幕缓存，用户点「清理全部」
 * 之后它们仍然留在进程里。
 *
 * 失败一律静默降级：缓存会随 TTL 自行过期，清理属于尽力而为，不该让整个清理流程报错。
 */
async function postCacheClear(path: string): Promise<void> {
  try {
    const response = await fetch(`${getApiBase()}${path}`, { method: 'POST', signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch {
    // 后端未运行 / 旧版本没有该路由时忽略：本地缓存已清，服务端缓存会随 TTL 过期
  }
}

export type ServerCacheScope = 'all' | 'images' | 'lyrics'

/** 图片代理进程内的 LRU 缓存（128MB 上限 / 6 小时 TTL）。 */
export async function clearBackendImageCache(): Promise<void> {
  await postCacheClear('/cache/image/clear')
}

/**
 * 服务端其余内存缓存。
 * - scope='lyrics'：只清网易云 / QQ 歌词缓存（对应设置页的「歌词」按钮）
 * - scope='images'：只清图片代理
 * - scope='all'（默认）：图片 + 歌词 + 汽水解密缓存 + B 站播放地址/字幕/弹幕
 */
export async function clearBackendServerCaches(scope: ServerCacheScope = 'all'): Promise<void> {
  await postCacheClear(`/cache/server/clear?scope=${encodeURIComponent(scope)}`)
}
