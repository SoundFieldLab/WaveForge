import type { Song } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'

export type EntitlementTier = 'unknown' | 'free' | 'vip' | 'svip'

export type PlatformEntitlements = Record<MusicPlatform, EntitlementTier>

const TIER_RANK: Record<EntitlementTier, number> = {
  unknown: -1,
  free: 0,
  vip: 1,
  svip: 2,
}

export const normalizeEntitlementTier = (value: unknown): EntitlementTier => {
  const normalized = String(value ?? '').trim().toLowerCase()
  if (normalized === 'free' || normalized === 'vip' || normalized === 'svip') return normalized
  return 'unknown'
}

export const entitlementTierFromVip = (isVip: boolean): EntitlementTier => isVip ? 'vip' : 'free'

export const entitlementTierFromSpotifyProduct = (product: unknown): EntitlementTier => {
  const normalized = String(product ?? '').trim().toLowerCase()
  if (normalized === 'premium') return 'vip'
  if (normalized === 'free' || normalized === 'open') return 'free'
  return 'unknown'
}

export const entitlementTierFromSodaMembership = (membership: {
  isVip?: boolean
  isSvip?: boolean
  vipLabel?: string
  membershipKnown?: boolean
  membershipStatus?: unknown
  vipLevel?: number
} | null | undefined): EntitlementTier => {
  if (!membership) return 'unknown'
  const reported = normalizeEntitlementTier(membership.membershipStatus)
  if (reported !== 'unknown') return reported
  if (membership.isSvip || Number(membership.vipLevel) >= 2 || /\bsvip\b/i.test(membership.vipLabel || '')) return 'svip'
  if (membership.isVip || Number(membership.vipLevel) === 1 || /\bvip\b/i.test(membership.vipLabel || '')) return 'vip'
  return membership.membershipKnown ? 'free' : 'unknown'
}

export const createPlatformEntitlements = (values: Partial<PlatformEntitlements> = {}): PlatformEntitlements => ({
  netease: 'unknown',
  qq: 'unknown',
  apple: 'unknown',
  spotify: 'unknown',
  kugou: 'unknown',
  soda: 'unknown',
  ...values,
})

export const getSongRequiredTier = (song: Pick<Song, 'requiredTier' | 'vip'>): EntitlementTier => {
  const explicit = normalizeEntitlementTier(song.requiredTier)
  if (explicit !== 'unknown') return explicit
  return song.vip ? 'vip' : 'free'
}

export const entitlementSatisfies = (activeTier: EntitlementTier, requiredTier: EntitlementTier): boolean => {
  if (activeTier === 'unknown' || requiredTier === 'unknown') return false
  return TIER_RANK[activeTier] >= TIER_RANK[requiredTier]
}

export const shouldShowEntitlementBadge = (
  song: Pick<Song, 'requiredTier' | 'vip'>,
  activeTier: EntitlementTier,
): boolean => {
  const requiredTier = getSongRequiredTier(song)
  return requiredTier !== 'free' && !entitlementSatisfies(activeTier, requiredTier)
}

const isActiveFlag = (value: unknown) => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value > 0
  if (typeof value === 'string') return /^(?:1|true|yes|active|open|enabled)$/i.test(value.trim()) || Number(value) > 0
  return false
}

const firstDefined = (source: any, keys: string[]) => {
  for (const key of keys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return source[key]
  }
  return undefined
}

/**
 * QQ 音乐的超级会员（Super VIP，比绿钻更高一级）识别：只有 lvinfo 里出现 svip 徽章
 * （实测形如 `svip7.png`）或显式 superVip/svip 字段才算，绝不把绿钻当超级会员。
 * 两者权益不同：绿钻=SQ 无损/HQ 192k，超级会员才有 杜比全景声 / 臻品母带4.0 / 臻品音质2.0。
 */
export const detectQQMusicSvip = (payload: any): boolean => {
  const candidates = [payload?.creator, payload?.data?.creator, payload?.data, payload].filter(Boolean)
  if (candidates.some(candidate => isActiveFlag(firstDefined(candidate, ['superVip', 'super_vip', 'svip', 'isSvip', 'is_svip'])))) return true
  const membershipLists = candidates.flatMap(candidate => [candidate?.lvinfo, candidate?.svipInfo, candidate?.svip_info]).filter(Array.isArray)
  return membershipLists.some(list => list.some((membership: any) => {
    const description = [membership?.iconurl, membership?.iconUrl, membership?.name, membership?.title, membership?.text, membership?.desc]
      .filter(Boolean).join(' ')
    return /svip|super\s*vip|超级会员/i.test(description)
  }))
}

/**
 * QQ 音乐的用户详情接口存在多套返回结构。这里同时识别显式会员字段、
 * 绿钻等级字段和 lvinfo 徽章，避免只认 `svip` 图标导致普通绿钻被漏判。
 */
export const detectQQMusicVip = (payload: any): boolean => {
  const candidates = [payload?.creator, payload?.data?.creator, payload?.data, payload].filter(Boolean)
  const explicitKeys = [
    'isVip', 'is_vip', 'vip', 'vipType', 'vip_type', 'vipFlag', 'vip_flag',
    'greenVip', 'green_vip', 'greenVipLevel', 'green_vip_level',
    'musicVip', 'music_vip', 'musicVipLevel', 'music_vip_level',
    'superVip', 'super_vip', 'svip',
  ]

  if (candidates.some(candidate => isActiveFlag(firstDefined(candidate, explicitKeys)))) return true

  const membershipLists = candidates.flatMap(candidate => [
    candidate?.lvinfo,
    candidate?.vipInfo,
    candidate?.vip_info,
    candidate?.memberships,
  ]).filter(Array.isArray)

  return membershipLists.some(list => list.some((membership: any) => {
    const description = [
      membership?.iconurl,
      membership?.iconUrl,
      membership?.name,
      membership?.title,
      membership?.text,
      membership?.desc,
      membership?.type,
    ].filter(Boolean).join(' ')
    if (!/(?:s?vip|绿钻|音乐包|music\s*vip|green\s*diamond)/i.test(description)) return false

    const status = firstDefined(membership, ['active', 'isActive', 'is_open', 'isOpen', 'open', 'status', 'enable', 'enabled'])
    const level = firstDefined(membership, ['level', 'lv', 'vipLevel', 'vip_level'])
    return status === undefined && level === undefined ? true : isActiveFlag(status) || isActiveFlag(level)
  }))
}
