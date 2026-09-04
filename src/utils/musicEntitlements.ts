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
