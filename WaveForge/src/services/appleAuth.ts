/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 账号认证与用户信息
 *
 * 登录凭据：
 * - Developer Token（JWT，Authorization: Bearer）——需开发者密钥签发，网上有公开生成器
 * - Media-User-Token（需登录 Apple Music 账号的会话令牌）
 *
 * 校验 / 用户信息端点（逆向文档确认）：
 * - GET /v1/me/storefront        → 校验凭据 + 返回用户 storefront
 * - GET /v1/me/social-profile    → data.attributes.name / artwork（账户名与头像）
 */

import { appleApiRequest } from './appleApiBridge'

export interface AppleUserInfo {
  name: string
  avatarUrl?: string
  storefront: string
  /** Apple ID 邮箱（账户摘要提取，可选） */
  email?: string
  /** 账单真实姓名（账户摘要提取，仅个人中心展示，不当显示名） */
  realName?: string
  /** 账单寄送地址（账户摘要提取，仅个人中心展示） */
  billingAddress?: string
  /** 国家或地区（账户摘要提取） */
  country?: string
  /** 付款类型（账户摘要提取） */
  paymentType?: string
  /** Apple 账户余额（账户摘要提取） */
  accountBalance?: string
  /** 出生日期（account.apple.com 个人信息页） */
  birthday?: string
  /** 语言（account.apple.com 个人信息页） */
  language?: string
  /** 双重认证（account.apple.com 登录与安全性页） */
  twoFactor?: string
  /** 受信任设备数（account.apple.com 登录与安全性页） */
  trustedDevices?: string
  /** 密码上次更新（account.apple.com 登录与安全性页） */
  passwordUpdated?: string
  /** 通知电子邮件（account.apple.com 登录与安全性页） */
  notificationEmail?: string
  /** 通过 Apple 登录的 App 数（account.apple.com 登录与安全性页） */
  signInWithApple?: string
  /** 关联设备列表（account.apple.com 设备页） */
  devices?: Array<{ name: string; model: string; icon?: string }>
  /** 账户页信息图标（登录时一次性抓取存本地，展示时直接使用） */
  icons?: Record<string, string>
}

export const AMP_API = 'https://amp-api.music.apple.com/v1'

/** 最近一次 amp-api 请求失败的路径与状态码（供登录面板精确提示 401/403） */
let lastApiError: { path: string; status: number } | null = null

export function getLastAppleApiError(): { path: string; status: number } | null {
  return lastApiError
}

/** 把诊断信息转发到主进程控制台（后台窗口可见，便于用户直接复制） */
export const forwardToBackend = (message: string) => {
  try {
    const bridge = (window as any).electron
    if (bridge && typeof bridge.log === 'function') bridge.log(`[AppleAuth] ${message}`)
  } catch {
    // 无 Electron 桥（纯浏览器）时忽略
  }
}

export interface AppleCredentials {
  developerToken: string
  mediaUserToken: string
  storefront: string
}

export function getAppleCredentials(): AppleCredentials {
  return {
    developerToken: localStorage.getItem('appleDeveloperToken') || '',
    mediaUserToken: localStorage.getItem('appleMediaUserToken') || '',
    storefront: localStorage.getItem('appleStorefront') || 'cn',
  }
}

export function getAppleAuthState(): { loggedIn: boolean; name: string; avatarUrl?: string; email?: string; realName?: string; billingAddress?: string; country?: string; paymentType?: string; accountBalance?: string; birthday?: string; language?: string; twoFactor?: string; trustedDevices?: string; passwordUpdated?: string; notificationEmail?: string; signInWithApple?: string; devices?: Array<{ name: string; model: string; icon?: string }>; icons?: Record<string, string>; storefront: string } {
  const name = localStorage.getItem('appleAccountName') || ''
  const avatarUrl = localStorage.getItem('appleAvatarUrl') || undefined
  const email = localStorage.getItem('appleAccountEmail') || undefined
  const realName = localStorage.getItem('appleAccountRealName') || undefined
  const billingAddress = localStorage.getItem('appleAccountBillingAddress') || undefined
  const country = localStorage.getItem('appleAccountCountry') || undefined
  const paymentType = localStorage.getItem('appleAccountPaymentType') || undefined
  const accountBalance = localStorage.getItem('appleAccountBalance') || undefined
  const birthday = localStorage.getItem('appleAccountBirthday') || undefined
  const language = localStorage.getItem('appleAccountLanguage') || undefined
  const twoFactor = localStorage.getItem('appleAccountTwoFactor') || undefined
  const trustedDevices = localStorage.getItem('appleAccountTrustedDevices') || undefined
  const passwordUpdated = localStorage.getItem('appleAccountPasswordUpdated') || undefined
  const notificationEmail = localStorage.getItem('appleAccountNotificationEmail') || undefined
  const signInWithApple = localStorage.getItem('appleAccountSignInWithApple') || undefined
  let devices: Array<{ name: string; model: string; icon?: string }> | undefined
  try {
    const raw = localStorage.getItem('appleAccountDevices')
    if (raw) devices = JSON.parse(raw)
  } catch { /* 忽略 */ }
  let icons: Record<string, string> | undefined
  try {
    const raw = localStorage.getItem('appleAccountIcons')
    if (raw) icons = JSON.parse(raw)
  } catch { /* 忽略 */ }
  const storefront = localStorage.getItem('appleStorefront') || 'cn'
  const credentials = getAppleCredentials()
  return {
    loggedIn: Boolean(credentials.developerToken && credentials.mediaUserToken && name),
    name,
    avatarUrl,
    email,
    realName,
    billingAddress,
    country,
    paymentType,
    accountBalance,
    birthday,
    language,
    twoFactor,
    trustedDevices,
    passwordUpdated,
    notificationEmail,
    signInWithApple,
    devices,
    icons,
    storefront,
  }
}

export function clearAppleLogin(): void {
  localStorage.removeItem('appleAccountName')
  localStorage.removeItem('appleAvatarUrl')
  localStorage.removeItem('appleAccountEmail')
  localStorage.removeItem('appleAccountRealName')
  localStorage.removeItem('appleAccountBillingAddress')
  localStorage.removeItem('appleAccountCountry')
  localStorage.removeItem('appleAccountPaymentType')
  localStorage.removeItem('appleAccountBalance')
  localStorage.removeItem('appleAccountBirthday')
  localStorage.removeItem('appleAccountLanguage')
  localStorage.removeItem('appleAccountTwoFactor')
  localStorage.removeItem('appleAccountTrustedDevices')
  localStorage.removeItem('appleAccountPasswordUpdated')
  localStorage.removeItem('appleAccountNotificationEmail')
  localStorage.removeItem('appleAccountSignInWithApple')
  localStorage.removeItem('appleAccountDevices')
  localStorage.removeItem('appleAccountIcons')
  localStorage.removeItem('appleDeveloperToken')
  localStorage.removeItem('appleMediaUserToken')
  localStorage.removeItem('appleStorefront')
  localStorage.removeItem('appleWebDevToken')
  localStorage.removeItem('appleWebDevTokenExp')
  localStorage.removeItem('wf_login_expiry_apple')
}

export function saveAppleLogin(user: AppleUserInfo): void {
  if (user.name) localStorage.setItem('appleAccountName', user.name)
  if (user.avatarUrl) localStorage.setItem('appleAvatarUrl', user.avatarUrl)
  if (user.storefront) localStorage.setItem('appleStorefront', user.storefront)
  if (user.email) localStorage.setItem('appleAccountEmail', user.email)
  if (user.realName) localStorage.setItem('appleAccountRealName', user.realName)
  if (user.billingAddress) localStorage.setItem('appleAccountBillingAddress', user.billingAddress)
  if (user.country) localStorage.setItem('appleAccountCountry', user.country)
  if (user.paymentType) localStorage.setItem('appleAccountPaymentType', user.paymentType)
  if (user.accountBalance) localStorage.setItem('appleAccountBalance', user.accountBalance)
  if (user.birthday) localStorage.setItem('appleAccountBirthday', user.birthday)
  if (user.language) localStorage.setItem('appleAccountLanguage', user.language)
  if (user.twoFactor) localStorage.setItem('appleAccountTwoFactor', user.twoFactor)
  if (user.trustedDevices) localStorage.setItem('appleAccountTrustedDevices', user.trustedDevices)
  if (user.passwordUpdated) localStorage.setItem('appleAccountPasswordUpdated', user.passwordUpdated)
  if (user.notificationEmail) localStorage.setItem('appleAccountNotificationEmail', user.notificationEmail)
  if (user.signInWithApple) localStorage.setItem('appleAccountSignInWithApple', user.signInWithApple)
  if (user.devices && user.devices.length) {
    try { localStorage.setItem('appleAccountDevices', JSON.stringify(user.devices)) } catch { /* 忽略 */ }
  }
  if (user.icons && Object.keys(user.icons).length) {
    try { localStorage.setItem('appleAccountIcons', JSON.stringify(user.icons)) } catch { /* 忽略 */ }
  }
}

const appleFetch = async (path: string, credentials: AppleCredentials, timeoutMs = 8000): Promise<any | null> => {
  // 走统一桥接（Electron 主进程代理优先，规避浏览器 CORS；纯浏览器直连兜底）
  const result = await appleApiRequest(path, {
    developerToken: credentials.developerToken,
    mediaUserToken: credentials.mediaUserToken,
    timeoutMs,
  })
  if (!result.ok) {
    lastApiError = { path, status: result.status }
    const detail = result.error || (typeof result.data === 'string' && result.data.length > 0
      ? (result.data.length > 200 ? `${result.data.slice(0, 200)}…` : result.data)
      : '')
    const logLine = result.status > 0
      ? `${path} HTTP ${result.status}：${detail}`
      : `${path} 网络错误：${detail || 'Failed to fetch'}`
    console.warn(`[AppleAuth] ${logLine}`)
    forwardToBackend(logLine)
    return null
  }
  return result.data
}

const toAvatarUrl = (artwork?: { url?: string }): string | undefined => {
  if (!artwork?.url) return undefined
  // artwork.url 形如 {w}x{h}bb.jpg —— 替换为 200×200
  return artwork.url.replace(/\{w\}x\{h\}bb/g, '200x200bb')
}

/**
 * 校验 Apple 凭据并拉取用户信息。
 * - storefront 失败 → 凭据无效
 * - social-profile 失败 → 仅返回 storefront（已登录但无资料）
 */
export async function validateAppleLogin(
  developerToken: string,
  mediaUserToken: string,
  storefront = 'cn',
): Promise<{ ok: boolean; user?: AppleUserInfo; error?: string }> {
  const credentials: AppleCredentials = { developerToken, mediaUserToken, storefront }

  const storefrontData = await appleFetch('/me/storefront', credentials)
  if (!storefrontData) {
    let detail = ''
    if (lastApiError && lastApiError.path === '/me/storefront') {
      detail = lastApiError.status === 0
        ? '（网络请求失败或被浏览器拦截，请检查网络）'
        : `（/v1/me/storefront HTTP ${lastApiError.status}${lastApiError.status === 403 ? '：账号可能无 Apple Music 订阅权限' : ''}）`
    }
    return { ok: false, error: `凭据无效或已过期${detail}` }
  }
  const resolvedStorefront = storefrontData?.data?.[0]?.id || storefront

  // 统一收集名字 / 头像（多源 + 兜底，保证两者都非空）
  let resolvedName = ''
  let resolvedAvatar = ''

  const profile = await appleFetch('/me/social-profile', credentials)
  if (profile?.data) {
    // social-profile 返回 data 为数组 [{ attributes: { name, artwork } }]，需解包
    const profileItem = Array.isArray(profile.data) ? profile.data[0] : profile.data
    const attributes = profileItem?.attributes || profileItem || {}
    resolvedName = attributes.name || attributes.nickname || profileItem?.name || ''
    resolvedAvatar = toAvatarUrl(attributes.artwork) || ''
    if (!resolvedName) {
      try {
        forwardToBackend(`/me/social-profile 未含用户名，字段：${Object.keys(attributes).join(',')}；结构：${JSON.stringify(attributes).slice(0, 300)}`)
      } catch {
        forwardToBackend('/me/social-profile 未含用户名（无法序列化）')
      }
    }
  } else {
    forwardToBackend('/me/social-profile 未返回数据（部分账号/地区不提供社交资料）')
  }

  // 名字兜底：/v1/me/account（部分账号能返回 Apple ID 昵称）
  let accountName = ''
  try {
    const account = await appleFetch('/me/account', credentials)
    if (account) {
      accountName = findNameInResponse(account)
      if (!accountName) {
        forwardToBackend(`/v1/me/account 未找到名字字段，原始结构：${JSON.stringify(account).slice(0, 300)}`)
      }
    }
  } catch {
    // 忽略
  }

  const finalName = resolvedName || accountName || 'Apple Music 用户'
  // 头像兜底：首字母头像（彩色圆 + 首字母，同 Apple 官方初始头像风格），保证头像永不为空。
  // 真实头像若存在于 social-profile artwork 或 Apple 账号页 og:image，会由上层覆盖。
  const finalAvatar = resolvedAvatar || generateInitialsAvatar(finalName)

  return {
    ok: true,
    user: {
      name: finalName,
      avatarUrl: finalAvatar,
      storefront: resolvedStorefront,
    },
  }
}

/**
 * Apple 官方 monogram（首字母头像）规则：
 * - 英文名：有空格取各单词首字母（Oea Per → OP）；无空格取前两个字母（Oewwq → OE）
 * - 中文/韩文/日文等非空格分隔语言：取第一个字符（芳乃213 → 芳）
 * - 底色为 Apple 官方灰色系，字为淡白色
 */
export function generateInitialsAvatar(name: string, bg = '#8e8e93'): string {
  const clean = (name || '').trim().replace(/\s+/g, ' ')
  if (!clean) return ''
  const isCJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af\u3400-\u4dbf]/.test(clean)
  let initials = ''
  if (isCJK) {
    // 中文/韩文/日文：取第一个字符
    initials = clean.charAt(0)
  } else if (clean.includes(' ')) {
    // 英文有空格：取各单词首字母（最多 2 个）
    initials = clean.split(' ').map(w => w.charAt(0)).join('').toUpperCase().slice(0, 2)
  } else {
    // 英文无空格：取前两个字母
    initials = clean.slice(0, 2).toUpperCase()
  }
  if (!initials) initials = (clean.charAt(0) || '?').toUpperCase()
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="64" fill="${bg}"/><text x="64" y="64" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif" font-size="48" font-weight="500" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${initials}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/** 递归查找响应里的"名字"类字段（name/accountName/fullName/appleId…），尽力提取显示名 */
function findNameInResponse(input: unknown, depth = 0): string {
  if (depth > 6 || input === null || input === undefined) return ''
  if (typeof input === 'string') return ''
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findNameInResponse(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  if (typeof input === 'object') {
    const record = input as Record<string, unknown>
    const priority = ['accountName', 'fullName', 'displayName', 'appleId', 'name', 'firstName', 'nickname']
    for (const key of priority) {
      const value = record[key]
      if (typeof value === 'string' && value.trim().length > 0) {
        // firstName/lastName 需要合并
        if (key === 'firstName') {
          const lastName = record['lastName']
          const joined = `${value}${typeof lastName === 'string' && lastName ? ` ${lastName}` : ''}`.trim()
          if (joined) return joined
        }
        return value.trim()
      }
    }
    for (const value of Object.values(record)) {
      const found = findNameInResponse(value, depth + 1)
      if (found) return found
    }
  }
  return ''
}

/**
 * Cider 同款：用登录窗口抓取的 itunes cookie 调 buy.itunes.apple.com/account/web/info，
 * 拿 Apple ID 的真实昵称。拿不到返回空串（调用方回退占位名）。
 */
export async function resolveAppleAccountName(cookies: string): Promise<string> {
  const bridge = (window as any).electron?.appleAccountInfo
  if (typeof bridge !== 'function' || !cookies) return ''
  try {
    const result = await bridge(cookies)
    if (!result?.ok) {
      forwardToBackend(`buy.itunes 账号信息 HTTP ${result?.status ?? '错误'}：${result?.error || ''}`)
      return ''
    }
    const name = findNameInResponse(result.data)
    if (name) {
      forwardToBackend(`Apple ID 昵称获取成功：${name}`)
      return name
    }
    forwardToBackend(`buy.itunes 账号信息未找到名字字段，原始结构：${JSON.stringify(result.data).slice(0, 400)}`)
    return ''
  } catch (error) {
    forwardToBackend(`账号信息获取失败：${error instanceof Error ? error.message : String(error)}`)
    return ''
  }
}

/**
 * 直接向 Apple 账号体系要名字与头像：
 * 用登录窗口抓取的全量会话 cookie（含 Apple ID / idmsa 域）访问 Apple 账号资料页，
 * 解析页面中的姓名与头像（og:image / 头像图）。SPA 页面可能无服务端渲染内容，尽力而为。
 */
export async function resolveAppleAccountProfile(allCookies: string): Promise<{ name: string; avatarUrl: string }> {
  const bridge = (window as any).electron?.appleFetchAccount
  if (typeof bridge !== 'function' || !allCookies) return { name: '', avatarUrl: '' }
  try {
    const result = await bridge(allCookies)
    if (!result?.ok || !result.html) {
      forwardToBackend(`Apple 账号资料页获取失败：${result?.error || `HTTP ${result?.status ?? ''}`}`)
      return { name: '', avatarUrl: '' }
    }
    const html = String(result.html)

    // 名字：常见账号页会内嵌姓名 JSON（accountName / fullName / firstName+lastName / dsPersonId 关联）
    let name = ''
    const namePatterns = [
      /"accountName"\s*:\s*"([^"]+)"/i,
      /"fullName"\s*:\s*"([^"]+)"/i,
      /"displayName"\s*:\s*"([^"]+)"/i,
      /"firstName"\s*:\s*"([^"]+)"[^}]*"lastName"\s*:\s*"([^"]+)"/i,
    ]
    for (const pattern of namePatterns) {
      const match = html.match(pattern)
      if (match) {
        name = match[2] ? `${match[1]} ${match[2]}`.trim() : match[1].trim()
        if (name) break
      }
    }
    // 头像：og:image / twitter:image / avatar 图
    let avatarUrl = ''
    const avatarPatterns = [
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i,
    ]
    for (const pattern of avatarPatterns) {
      const match = html.match(pattern)
      if (match && /^https?:\/\//i.test(match[1])) {
        avatarUrl = match[1]
        break
      }
    }
    if (avatarUrl && /\{w\}x\{h\}/.test(avatarUrl)) {
      avatarUrl = avatarUrl.replace(/\{w\}x\{h\}bb/g, '200x200bb').replace(/\{w\}x\{h\}/g, '200x200')
    }
    forwardToBackend(`Apple 账号页解析：name=${name || '未找到'} avatar=${avatarUrl ? '已找到' : '未找到'}（页面长度 ${html.length}）`)
    return { name, avatarUrl }
  } catch (error) {
    forwardToBackend(`Apple 账号页解析失败：${error instanceof Error ? error.message : String(error)}`)
    return { name: '', avatarUrl: '' }
  }
}
