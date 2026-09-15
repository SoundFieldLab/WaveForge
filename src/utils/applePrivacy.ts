/**
 * Apple 账号隐私脱敏设置（个人中心使用）
 *
 * 背景：Apple 会用账号真实姓名给个人电台命名（形如「熠的电台」，station id 以 `ra.u-` 开头）。
 * 直播/录屏时真名直接暴露在界面上并不合适，因此提供两层保护：
 * 1) 个人中心敏感字段默认以波浪占位显示，点小眼睛后才显示真实内容（选择会被记住）。
 * 2) 可选的「个人电台名自动保护」：开启后全局把该电台名显示为「**的电台」。
 */

const MASK_KEY = 'waveforge:privacy:maskAccountFields'
const PROTECT_STATION_KEY = 'waveforge:privacy:protectPersonalStation'
const PERSONAL_STATION_KEY = 'waveforge:privacy:personalStation'

export const PERSONAL_STATION_MASK = '**的电台'

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return raw === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* 忽略存储不可用 */
  }
}

/** 个人中心敏感字段默认是否遮罩（默认遮罩；用户点过小眼睛后记住状态）。 */
export function isAccountFieldsMasked(): boolean {
  return readFlag(MASK_KEY, true)
}

export function setAccountFieldsMasked(masked: boolean): void {
  writeFlag(MASK_KEY, masked)
}

/** 个人电台名自动保护（默认关闭）。 */
export function isPersonalStationProtected(): boolean {
  return readFlag(PROTECT_STATION_KEY, false)
}

export function setPersonalStationProtected(protect: boolean): void {
  writeFlag(PROTECT_STATION_KEY, protect)
  try {
    window.dispatchEvent(new CustomEvent('apple-privacy-changed'))
  } catch {
    /* 忽略 */
  }
}

/** 用户个人电台（`ra.u-` 前缀）——Apple 用真实姓名命名的那一个。 */
export interface ApplePersonalStationInfo {
  id: string
  name: string
}

export function getCachedPersonalStation(): ApplePersonalStationInfo | null {
  try {
    const raw = localStorage.getItem(PERSONAL_STATION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.id === 'string' && typeof parsed.name === 'string') return parsed
  } catch {
    /* 忽略 */
  }
  return null
}

export function cachePersonalStation(info: ApplePersonalStationInfo | null): void {
  try {
    if (!info) localStorage.removeItem(PERSONAL_STATION_KEY)
    else localStorage.setItem(PERSONAL_STATION_KEY, JSON.stringify(info))
  } catch {
    /* 忽略 */
  }
}

/** Apple 个人电台的 station id 前缀（`ra.u-` = user station）。 */
export function isPersonalStationId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith('ra.u-')
}

/** 展示用名称：开启保护且命中个人电台时替换为「**的电台」。 */
export function protectStationName(name: string, stationId?: string): string {
  if (!isPersonalStationProtected()) return name
  const cached = getCachedPersonalStation()
  if (isPersonalStationId(stationId)) return PERSONAL_STATION_MASK
  if (cached && (name === cached.name || name === `${cached.name}`)) return PERSONAL_STATION_MASK
  return name
}
