/**
 * 凭据安全存储（渲染层门面）：把各平台登录态从 localStorage 迁到主进程
 * safeStorage（Windows DPAPI）加密落盘。启动时一次性把 localStorage 里遗留的
 * 明文凭据迁入并从 localStorage 删除（单向迁移，失败保留原值）。
 *
 * 为什么不是"直接读写主进程"：现有几十处调用点是同步的 localStorage.getItem，
 * 全量改成 async 影响面过大。这里在模块内存里缓存最近一次读到的值——首次
 * hydrate 完成后，get 同步返回缓存；set 先写缓存再异步落盘（fire-and-forget）。
 * XSS 即使得手只能拿到当前会话内存中的值，拿不到落盘的加密 blob，
 * 且刷新/重启后没有 localStorage 可整包读走。
 */
import { isDesktop } from '../platform'

const MIGRATION_FLAG = 'secure-store:migrated'
// 需要迁移的 localStorage 凭据键（与 App.tsx/LoginView/bilibiliApi 等写入点一致）
const MIGRATION_KEYS = [
  'qq_cookie', 'qqCookie',
  'netease_cookie', 'neteaseCookie',
  'kugou_cookie',
  'kugou_concept_credential',
  'soda_token',
  'spotify_access_token', 'spotify_refresh_token',
  'appleDeveloperToken', 'appleMediaUserToken',
  'bilibili_cookie', 'bilibili_user',
] as const

const cache = new Map<string, string>()
let hydrated = false
let hydrationPromise: Promise<void> | null = null

const bridge = (): { set: (k: string, v: string) => Promise<{ success: boolean; error?: string }>; get: (k: string) => Promise<{ success: boolean; value: string | null; available?: boolean }> } | undefined =>
  (window as unknown as { electron?: { secureStore?: { set: (k: string, v: string) => Promise<{ success: boolean; error?: string }>; get: (k: string) => Promise<{ success: boolean; value: string | null; available?: boolean }> } } }).electron?.secureStore

function lsGet(key: string): string {
  try { return localStorage.getItem(key) || '' } catch { return '' }
}

function lsRemove(key: string): void {
  try { localStorage.removeItem(key) } catch { /* ignore */ }
}

/** 启动时调用：等主进程桥就绪后做一次迁移 + hydrate。内部幂等。 */
/** hydrate 是否完成（供启动竞态补偿判断；内部用 window 标记，方便渲染层任意时机同步查询） */
export function isSecureStoreHydrated(): boolean {
  try { return Boolean((window as unknown as { __secureStoreHydrated?: boolean }).__secureStoreHydrated) } catch { return hydrated }
}

export function initSecureTokenStore(): void {
  if (!isDesktop() || hydrated || hydrationPromise) return
  hydrationPromise = (async () => {
    const api = bridge()
    if (!api) { hydrated = true; return }
    try {
      // 1) 迁移 localStorage 遗留明文 → 加密存储（成功后删除明文）
      if (lsGet(MIGRATION_FLAG) !== '1') {
        for (const key of MIGRATION_KEYS) {
          const value = lsGet(key)
          if (!value) continue
          const result = await api.set(key, value).catch(() => null)
          if (result?.success) lsRemove(key)
        }
        try { localStorage.setItem(MIGRATION_FLAG, '1') } catch { /* ignore */ }
      }
      // 2) hydrate：把已存的加密凭据读进内存缓存
      for (const key of MIGRATION_KEYS) {
        const result = await api.get(key).catch(() => null)
        if (result?.success && result.value) cache.set(key, result.value)
      }
    } finally {
      hydrated = true
      try { (window as unknown as { __secureStoreHydrated?: boolean }).__secureStoreHydrated = true } catch { /* ignore */ }
      // hydrate 完成再广播：App 的登录态 useState 初始化跑在 hydrate 之前（异步竞态），
      // 不广播的话重启后 netease/kugou/soda/spotify 会误判成未登录（QQ 有 localStorage
      // 'qq_logged_in' 兜底才幸免）。监听方见 App.tsx 登录态恢复段。
      try { window.dispatchEvent(new CustomEvent('secure-store:hydrated')) } catch { /* ignore */ }
    }
  })()
}

/** 同步读（与 localStorage.getItem 同型）：优先内存缓存，回退 localStorage（未迁移项）。 */
export function getSecureToken(key: string): string {
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  return lsGet(key)
}

/** 写入：内存缓存即时生效，桌面端异步落加密存储并清掉 localStorage 明文副本。 */
export function setSecureToken(key: string, value: string): void {
  if (value) {
    cache.set(key, value)
  } else {
    cache.delete(key)
  }
  const api = bridge()
  if (!api) return
  void (value ? api.set(key, value) : api.set(key, '')).then((result) => {
    // 落盘成功才清 localStorage 明文（失败保留，下次启动重试迁移）
    if (result?.success) lsRemove(key)
  }).catch(() => undefined)
}

/** 删除（登出用）：清缓存 + 清加密存储 + 清 localStorage。 */
export function removeSecureToken(key: string): void {
  cache.delete(key)
  lsRemove(key)
  const api = bridge()
  if (api) void api.set(key, '').catch(() => undefined)
}
