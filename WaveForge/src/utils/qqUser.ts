/**
 * QQ 音乐用户资料在不同接口/版本中的字段名称不完全一致。
 * 统一从 creator/profile/user 等常见位置读取昵称，避免把 QQ 号当成显示名。
 */
export function getQQUserDisplayName(
  detail: any,
  fallbackUserId = '',
  fallback = 'QQ音乐用户'
): string {
  const candidates = [
    detail?.creator,
    detail?.data?.creator,
    detail?.user,
    detail?.data?.user,
    detail?.profile,
    detail?.data?.profile,
    detail,
  ]

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const name = [
      candidate.nick,
      candidate.nickname,
      candidate.name,
      candidate.hostname,
      candidate.hostName,
      candidate.username,
      candidate.userName,
    ].find(value => typeof value === 'string' && value.trim())
    if (name) return name.trim()
  }

  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('qq_username') || '' : ''
  if (stored && !/^QQ用户\d+$/.test(stored) && stored !== 'QQ音乐用户') return stored

  // 不再生成“QQ用户数字”作为歌单标题；只有确实没有资料时才使用通用兜底。
  void fallbackUserId
  return fallback
}

export function isQQFallbackDisplayName(value?: string): boolean {
  const name = String(value || '').trim()
  return !name || name === 'QQ音乐用户' || /^QQ用户\d+$/.test(name)
}
