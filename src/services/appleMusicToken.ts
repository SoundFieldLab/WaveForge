/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music Developer Token 获取（免密钥，gamdl / Cider-fork 同款做法）
 *
 * Apple 网页播放器把可用的 MusicKit 开发者令牌（iss=AMPWebPlay，约 70 天有效）
 * 内置在前端资源中。我们定时从 Apple 网页提取并缓存，用户无需提供任何开发者密钥。
 * 优先级：Electron 主进程（无 CORS）→ 公共 CORS 代理（Web 环境）。
 */

const WEB_TOKEN_KEY = 'appleWebDevToken'
const WEB_TOKEN_EXP_KEY = 'appleWebDevTokenExp'
/** 剩余有效期不足 24 小时时主动刷新 */
const REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000

const ALLORIGINS = 'https://api.allorigins.win/raw?url='

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const json = decodeURIComponent(escape(atob(padded)))
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

function extractTokenFromBundleJs(js: string): string | null {
  const match = js.match(/"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"/)
  return match ? match[0].replace(/"/g, '') : null
}

async function fetchViaCorsProxy(url: string): Promise<string> {
  const response = await fetch(`${ALLORIGINS}${encodeURIComponent(url)}`)
  if (!response.ok) throw new Error(`代理请求失败 (${response.status})`)
  return response.text()
}

/** 直接拉取 Apple 网页开发者令牌（不读缓存） */
export async function fetchAppleWebDevToken(): Promise<{ token: string; expiresAt: number }> {
  // 1) Electron 主进程（无 CORS，最可靠）
  const electronBridge = window.electron?.appleFetchDevToken
  if (electronBridge) {
    const result = await electronBridge()
    if (result?.success && result.token) {
      return { token: result.token, expiresAt: result.expiresAt || 0 }
    }
    throw new Error(result?.error || '主进程获取令牌失败')
  }

  // 2) Web 兜底：经 CORS 代理抓主页 → bundle → 提取 JWT
  const homeHtml = await fetchViaCorsProxy('https://music.apple.com/')
  const bundleMatch = homeHtml.match(/assets\/index[~-][^"']+\.js/)
  if (!bundleMatch) throw new Error('未能定位 Apple 前端资源')
  const bundleJs = await fetchViaCorsProxy(`https://music.apple.com/${bundleMatch[0]}`)
  const token = extractTokenFromBundleJs(bundleJs)
  if (!token) throw new Error('前端资源中未找到开发者令牌')
  const payload = decodeJwtPayload(token)
  const expiresAt = payload && typeof payload.exp === 'number' ? payload.exp * 1000 : 0
  return { token, expiresAt }
}

/** 读取缓存的令牌（未过期且剩余时间充足则直接返回） */
export function getCachedAppleWebDevToken(): { token: string; expiresAt: number } | null {
  try {
    const token = localStorage.getItem(WEB_TOKEN_KEY)
    const expRaw = localStorage.getItem(WEB_TOKEN_EXP_KEY)
    const expiresAt = expRaw ? Number(expRaw) : 0
    if (!token) return null
    if (expiresAt > Date.now() + REFRESH_THRESHOLD_MS) {
      return { token, expiresAt }
    }
    return null
  } catch {
    return null
  }
}

/** 确保拿到可用的开发者令牌：优先缓存，失效则重新抓取并缓存 */
export async function ensureAppleWebDevToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = getCachedAppleWebDevToken()
    if (cached) return cached.token
  }
  const fresh = await fetchAppleWebDevToken()
  try {
    localStorage.setItem(WEB_TOKEN_KEY, fresh.token)
    localStorage.setItem(WEB_TOKEN_EXP_KEY, String(fresh.expiresAt))
  } catch {
    // 存储失败不影响本次使用
  }
  return fresh.token
}

/** 清除缓存的网页令牌（登出/手动清理时调用） */
export function clearAppleWebDevToken(): void {
  localStorage.removeItem(WEB_TOKEN_KEY)
  localStorage.removeItem(WEB_TOKEN_EXP_KEY)
}
