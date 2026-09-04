/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music amp-api 统一请求桥（解决渲染进程浏览器直连被 CORS 拦截的问题）
 *
 * 浏览器直连 https://amp-api.music.apple.com 会因 CORS 返回 Failed to fetch。
 * 通道优先级：
 * 1) Electron 主进程代理（无 CORS，生产首选）
 * 2) 本地 API 服务器代理（local-server.mjs /api/apple/amp，纯浏览器 dev 环境可用）
 * 3) 浏览器直连兜底（amp-api 通常无 CORS 放行，仅作后备）
 */

import { ensureAppleWebDevToken, prepareAppleDeveloperToken, shouldRefreshAppleDeveloperToken } from './appleMusicToken'

export interface AppleApiResult {
  ok: boolean
  status: number
  data?: any
  error?: string
}

/** 路径归一化：统一带 /v1 前缀 */
const normalizeApiPath = (path: string) => (path.startsWith('/v1') ? path : `/v1${path}`)

const runAppleApiRequest = async (
  path: string,
  options: {
    method?: string
    developerToken: string
    mediaUserToken?: string
    body?: unknown
    timeoutMs?: number
  },
): Promise<AppleApiResult> => {
  const apiPath = normalizeApiPath(path)

  // 1) Electron 主进程代理（优先）
  const bridge = (window as any).electron?.appleApi
  if (typeof bridge === 'function') {
    try {
      return await bridge(
        path,
        options.developerToken,
        options.mediaUserToken || '',
        options.method || 'GET',
        options.body === undefined ? null : JSON.stringify(options.body)
      )
    } catch (error) {
      return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }

  // 2) 本地 API 服务器代理（纯浏览器环境无 Electron 桥时兜底，同机 127.0.0.1 无 CORS）
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), options.timeoutMs || 12000)
    try {
      const response = await fetch(`http://localhost:3001/api/apple/amp?path=${encodeURIComponent(apiPath)}`, {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${options.developerToken}`,
          ...(options.mediaUserToken ? { 'Media-User-Token': options.mediaUserToken } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      })
      const text = await response.text()
      let data: any = null
      try { data = text ? JSON.parse(text) : null } catch { data = text }
      return { ok: response.ok, status: response.status, data }
    } finally {
      window.clearTimeout(timer)
    }
  } catch {
    // 本地服务器未启动 → 继续直连兜底
  }

  // 3) 浏览器直连兜底（amp-api 通常无 CORS 放行，仅作后备）
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs || 8000)
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.developerToken}`,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      Accept: 'application/json',
    }
    if (options.mediaUserToken) headers['Media-User-Token'] = options.mediaUserToken
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(`https://amp-api.music.apple.com${apiPath}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    const text = await response.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = text
    }
    return { ok: response.ok, status: response.status, data }
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  } finally {
    window.clearTimeout(timeout)
  }
}

/**
 * 统一 Apple API 请求。Developer Token 失效时刷新网页 token 并只重试一次；
 * Media User Token 无效仍原样返回 401/403，由业务层提示重新登录或订阅状态。
 */
export async function appleApiRequest(
  path: string,
  options: {
    method?: string
    developerToken: string
    mediaUserToken?: string
    body?: unknown
    timeoutMs?: number
  },
): Promise<AppleApiResult> {
  let developerToken = options.developerToken
  try {
    developerToken = await prepareAppleDeveloperToken(developerToken)
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }
  }

  let result = await runAppleApiRequest(path, { ...options, developerToken })
  if ((result.status !== 401 && result.status !== 403) || !shouldRefreshAppleDeveloperToken(developerToken)) {
    return result
  }

  try {
    const refreshedToken = await ensureAppleWebDevToken(true)
    if (!refreshedToken || refreshedToken === developerToken) return result
    localStorage.setItem('appleDeveloperToken', refreshedToken)
    result = await runAppleApiRequest(path, { ...options, developerToken: refreshedToken })
  } catch {
    // 保留第一次响应，业务层可据其状态给出准确提示。
  }
  return result
}
