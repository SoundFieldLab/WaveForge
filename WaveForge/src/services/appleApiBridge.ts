/**
 * Apple Music amp-api 统一请求桥（解决渲染进程浏览器直连被 CORS 拦截的问题）
 *
 * 浏览器直连 https://amp-api.music.apple.com 会因 CORS 返回 Failed to fetch。
 * 这里统一走 Electron 主进程代理（无 CORS）；纯浏览器环境降级为直连兜底。
 */

export interface AppleApiResult {
  ok: boolean
  status: number
  data?: any
  error?: string
}

export async function appleApiRequest(
  path: string,
  options: {
    method?: string
    developerToken: string
    mediaUserToken?: string
    body?: unknown
    timeoutMs?: number
  }
): Promise<AppleApiResult> {
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

  // 2) 浏览器直连兜底（amp-api 通常无 CORS 放行，仅作后备）
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
    // 路径归一化：统一带 /v1 前缀
    const apiPath = path.startsWith('/v1') ? path : `/v1${path}`
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
