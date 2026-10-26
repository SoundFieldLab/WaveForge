/**
 * 移动端登录态：精简版各平台登录/登出处理器。
 *
 * 凭据一律走 secureTokenStore（加密存储，localStorage 明文回退）——
 * 与桌面/TV 同一存储，后端按请求级 cookie 读取（getPlatformCookie）。
 * 登录成功后广播 waveforge-auth-changed（探索页缓存按账号失效）。
 */
import { useCallback, useEffect, useState } from 'react'
import { getSecureToken, setSecureToken } from '../services/secureTokenStore'
import { recordLogin, clearLoginExpiry } from '../services/loginExpiry'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { mobileToast } from './ui'

export interface PlatformAccount {
  loggedIn: boolean
  userId: string
  username: string
  avatar: string
}

interface AccountSnapshot {
  [platform: string]: PlatformAccount
}

const API_BASE = 'http://localhost:3001'

/** 从 localStorage 恢复账号快照（桌面/TV 端写入的键位同一套）。 */
export function readAccountSnapshot(): AccountSnapshot {
  const read = (p: MusicPlatform): PlatformAccount => {
    let loggedIn = false
    let userId = ''
    try {
      if (p === 'qq') {
        loggedIn = localStorage.getItem('qq_logged_in') === 'true' && Boolean(getSecureToken('qq_cookie'))
        userId = localStorage.getItem('qq_user_id') || ''
      } else if (p === 'netease') {
        loggedIn = Boolean(getSecureToken('netease_cookie')) && localStorage.getItem('netease_logged_in') !== 'false'
        userId = localStorage.getItem('netease_user_id') || ''
      } else if (p === 'kugou') {
        const cookie = getSecureToken('kugou_cookie')
        loggedIn = Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
        userId = localStorage.getItem('kugou_user_id') || ''
      } else if (p === 'soda') {
        loggedIn = Boolean(getSecureToken('soda_token'))
        userId = localStorage.getItem('soda_user_id') || ''
      } else if (p === 'spotify') {
        loggedIn = Boolean(getSecureToken('spotify_access_token'))
        userId = localStorage.getItem('spotify_user_id') || ''
      } else if (p === 'apple') {
        loggedIn = localStorage.getItem('apple_logged_in') === 'true'
        userId = ''
      }
    } catch { /* ignore */ }
    let username = ''
    let avatar = ''
    try {
      const prefix = p === 'qq' ? 'qq' : p
      username = localStorage.getItem(`${prefix}_username`) || localStorage.getItem(`${prefix}_nickname`) || ''
      avatar = localStorage.getItem(`${prefix}_avatar`) || ''
    } catch { /* ignore */ }
    return { loggedIn, userId, username, avatar }
  }
  const snapshot: AccountSnapshot = {}
  const platforms: MusicPlatform[] = ['netease', 'qq', 'kugou', 'soda', 'apple', 'spotify']
  platforms.forEach(p => { snapshot[p] = read(p) })
  return snapshot
}

function fireAuthChanged() {
  window.dispatchEvent(new CustomEvent('waveforge-auth-changed'))
}

/** QQ 登录（原生扫码窗口抓到 cookie 后回传）。 */
export async function mobileQQLogin(cookie: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/qq/user/setCookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: cookie }),
    })
    const data = await res.json()
    if (data.result !== 100 || !data.data?.uin) {
      mobileToast(data.errorTip || 'QQ 登录失败', 'error')
      return false
    }
    const uin = String(data.data.uin)
    setSecureToken('qq_cookie', cookie)
    setSecureToken('qqCookie', cookie)
    localStorage.setItem('qq_logged_in', 'true')
    localStorage.setItem('qq_user_id', uin)
    recordLogin('qq')
    try {
      const detailRes = await fetch(`${API_BASE}/api/qq/user/detail?id=${uin}`)
      const detail = await detailRes.json()
      const profile = detail?.data?.profile || detail?.profile
      if (profile?.nick) localStorage.setItem('qq_username', profile.nick)
      if (profile?.headurl) localStorage.setItem('qq_avatar', `https:${profile.headurl}`)
    } catch { /* 资料失败不回滚登录 */ }
    fireAuthChanged()
    return true
  } catch {
    mobileToast('QQ 登录失败，请检查网络', 'error')
    return false
  }
}

/** 网易云登录（Cookie 粘贴 / 二维码面板回传）。 */
export async function mobileNeteaseLogin(cookie: string): Promise<boolean> {
  if (!cookie || !/MUSIC_U=/.test(cookie)) {
    mobileToast('Cookie 需包含 MUSIC_U 字段', 'error')
    return false
  }
  setSecureToken('netease_cookie', cookie)
  setSecureToken('neteaseCookie', cookie)
  try {
    // 验证必须走 X-WaveForge-Cookie 自定义头（后端 CORS 中间件回填 req.query.cookie）：
    // 浏览器禁止 JS 设置 Cookie 头（fetch 会被静默剥离），直接用 Cookie 头验证永远失败。
    const res = await fetch(`${API_BASE}/api/netease/user/account`, {
      headers: { 'X-WaveForge-Cookie': cookie },
    })
    const data = await res.json()
    const profile = data?.profile
    if (profile?.userId) {
      localStorage.setItem('netease_user_id', String(profile.userId))
      localStorage.setItem('netease_username', profile.nickname || '网易云用户')
      localStorage.setItem('netease_avatar', profile.avatarUrl || '')
      recordLogin('netease')
      fireAuthChanged()
      return true
    }
    // cookie 无效：立即清理，避免半登录态
    setSecureToken('netease_cookie', '')
    setSecureToken('neteaseCookie', '')
    mobileToast('Cookie 无效或已过期', 'error')
    return false
  } catch {
    fireAuthChanged()
    return true // cookie 已存，账号资料等有网时再拉
  }
}

/** 酷狗登录（扫码面板回传 cookie）。 */
export function mobileKugouLogin(cookie: string, username?: string, extra?: { userId?: string; avatar?: string }): boolean {
  const loggedIn = Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
  if (!loggedIn) return false
  setSecureToken('kugou_cookie', cookie)
  if (username) localStorage.setItem('kugou_username', username)
  if (extra?.userId) localStorage.setItem('kugou_user_id', extra.userId)
  if (extra?.avatar) localStorage.setItem('kugou_avatar', extra.avatar)
  recordLogin('kugou')
  fireAuthChanged()
  return true
}

/** 汽水登录（面板回传 token）。 */
export function mobileSodaLogin(token: string, username?: string, extra?: { userId?: string; avatar?: string }): boolean {
  if (!token) return false
  setSecureToken('soda_token', token)
  if (username) localStorage.setItem('soda_username', username)
  if (extra?.userId) localStorage.setItem('soda_user_id', String(extra.userId))
  if (extra?.avatar) localStorage.setItem('soda_avatar', extra.avatar)
  recordLogin('soda')
  fireAuthChanged()
  return true
}

/** 登出（按平台清理凭据 + 本地标记）。 */
export function mobileLogout(platform: MusicPlatform): void {
  try {
    if (platform === 'qq') {
      setSecureToken('qq_cookie', '')
      setSecureToken('qqCookie', '')
      localStorage.removeItem('qq_logged_in')
      localStorage.removeItem('qq_user_id')
      void fetch(`${API_BASE}/api/qq/cookie`, { method: 'DELETE' }).catch(() => undefined)
    } else if (platform === 'netease') {
      setSecureToken('netease_cookie', '')
      setSecureToken('neteaseCookie', '')
      localStorage.removeItem('netease_user_id')
      localStorage.removeItem('netease_username')
      localStorage.removeItem('netease_avatar')
    } else if (platform === 'kugou') {
      setSecureToken('kugou_cookie', '')
      localStorage.removeItem('kugou_user_id')
      localStorage.removeItem('kugou_username')
      localStorage.removeItem('kugou_avatar')
    } else if (platform === 'soda') {
      setSecureToken('soda_token', '')
      localStorage.removeItem('soda_user_id')
      localStorage.removeItem('soda_username')
      localStorage.removeItem('soda_avatar')
    } else if (platform === 'spotify') {
      setSecureToken('spotify_access_token', '')
    } else if (platform === 'apple') {
      localStorage.removeItem('apple_logged_in')
      localStorage.removeItem('apple_user')
    }
    clearLoginExpiry(platform)
    fireAuthChanged()
    mobileToast('已退出登录')
  } catch {
    mobileToast('退出失败', 'error')
  }
}

/** 登录态 hook：快照 + 登录/登出后自动刷新。 */
export function useAccounts(): { accounts: AccountSnapshot; refresh: () => void } {
  const [accounts, setAccounts] = useState<AccountSnapshot>(() => readAccountSnapshot())
  const refresh = useCallback(() => setAccounts(readAccountSnapshot()), [])
  useEffect(() => {
    window.addEventListener('waveforge-auth-changed', refresh)
    return () => window.removeEventListener('waveforge-auth-changed', refresh)
  }, [refresh])
  return { accounts, refresh }
}

export { platformLabel }
