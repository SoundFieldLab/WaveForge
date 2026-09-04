/**
 * 平台登录有效期管理
 *
 * 背景：三个平台的登录态都只存 localStorage（无过期时间戳），token/cookie 静默失效后
 * 软件仍显示"已登录"但请求失败，用户要手动重登才能恢复。
 *
 * 本模块在登录时记录预估有效期，个人中心显示剩余天数，到期提示重新登录：
 * - 网易云 cookie：官方有效期约 30 天
 * - QQ 音乐 cookie：官方有效期约 30 天
 * - Apple media-user-token：登录会话较长，预估 180 天
 * - Apple developer-token：JWT 有真实 exp，用真实值（约 70 天）
 */

import type { MusicPlatform } from './platforms'

export interface LoginExpiry {
  /** 登录时间戳（ms） */
  loggedAt: number
  /** 预估过期时间戳（ms） */
  expiresAt: number
}

const KEY_PREFIX = 'wf_login_expiry_'

/** 各平台预估有效期（ms） */
const DEFAULT_DURATIONS: Record<MusicPlatform, number> = {
  netease: 30 * 24 * 60 * 60 * 1000,
  qq: 30 * 24 * 60 * 60 * 1000,
  apple: 180 * 24 * 60 * 60 * 1000,
  spotify: 60 * 24 * 60 * 60 * 1000, // OAuth refresh token 长期有效，access token 约 1 小时（自动刷新）
  kugou: 30 * 24 * 60 * 60 * 1000,
  soda: 30 * 24 * 60 * 60 * 1000,
}

const STOREFRONT_MAP: Record<string, MusicPlatform> = {
  netease: 'netease',
  qq: 'qq',
  apple: 'apple',
}

/** 登录时记录有效期 */
export function recordLogin(platform: MusicPlatform, expiresAtOverride?: number): void {
  const loggedAt = Date.now()
  const expiresAt = expiresAtOverride || loggedAt + (DEFAULT_DURATIONS[platform] || 30 * 24 * 60 * 60 * 1000)
  try {
    localStorage.setItem(KEY_PREFIX + platform, JSON.stringify({ loggedAt, expiresAt }))
  } catch {
    // 忽略存储失败
  }
}

/** 读取某平台有效期记录 */
export function getLoginExpiry(platform: MusicPlatform): LoginExpiry | null {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + platform)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed.expiresAt !== 'number') return null
    return { loggedAt: parsed.loggedAt || 0, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}

/** 某平台是否已过期 */
export function isLoginExpired(platform: MusicPlatform): boolean {
  const expiry = getLoginExpiry(platform)
  if (!expiry) return false
  return Date.now() > expiry.expiresAt
}

/** 剩余毫秒（已过期返回 <=0） */
export function getRemainingMs(platform: MusicPlatform): number {
  const expiry = getLoginExpiry(platform)
  if (!expiry) return 0
  return expiry.expiresAt - Date.now()
}

/** 剩余天数（向上取整，已过期返回 0） */
export function getRemainingDays(platform: MusicPlatform): number {
  const ms = getRemainingMs(platform)
  if (ms <= 0) return 0
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

/** 清除某平台有效期记录（登出/重登时调用） */
export function clearLoginExpiry(platform: MusicPlatform): void {
  try {
    localStorage.removeItem(KEY_PREFIX + platform)
  } catch {
    // 忽略
  }
}

/** 获取当前平台剩余天数（个人中心显示用），无记录返回 null（不显示） */
export function getPlatformRemainingDays(platform: string): number | null {
  const mapped = STOREFRONT_MAP[platform]
  if (!mapped) return null
  const expiry = getLoginExpiry(mapped)
  if (!expiry) return null
  return getRemainingDays(mapped)
}
