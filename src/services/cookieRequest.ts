/**
 * 登录态请求头构建：cookie 从 URL query 迁出的配套工具。
 * 后端 CORS 中间件会把 X-WaveForge-Cookie 回填进 req.query.cookie，路由零改动。
 * URL 会进后端错误日志与上游代理日志——凭据不应出现在 URL；新代码一律用 headers。
 */
import { getSecureToken } from './secureTokenStore'

/** 构建带登录态的请求头（cookie 为空时返回空对象）。 */
export function cookieHeaders(cookie?: string): Record<string, string> {
  const value = cookie ?? ''
  return value ? { 'X-WaveForge-Cookie': value } : {}
}

/** 快捷取平台登录态并构头（等价 cookieHeaders(getSecureToken(key))）。 */
export function cookieHeadersFor(key: string): Record<string, string> {
  return cookieHeaders(getSecureToken(key))
}

/**
 * fetch 包装：从 URL 剥离 cookie query 并转请求头（与 musicApi 的 splitCookieFromUrl 同逻辑）。
 * 供旧调用点最小改动迁移：fetch(...) → fetchWithCookieHeader(...)，其余参数不变。
 */
export async function fetchWithCookieHeader(url: string, init: RequestInit = {}): Promise<Response> {
  let cleanUrl = url
  const headers: Record<string, string> = {}
  try {
    const parsed = new URL(url)
    const cookie = parsed.searchParams.get('cookie')
    if (cookie) {
      parsed.searchParams.delete('cookie')
      cleanUrl = parsed.toString()
      headers['X-WaveForge-Cookie'] = cookie
    }
  } catch { /* 非法 URL 原样透传 */ }
  return fetch(cleanUrl, { ...init, headers: { ...headers, ...(init.headers || {}) } })
}
