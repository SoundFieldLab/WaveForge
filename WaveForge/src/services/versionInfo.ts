/**
 * 版本代号（A 方案：水声主题，贴合"澜音=波澜的声音"）。
 * 内部版本号仍是 0.x.y（更新系统/versionCode 依赖），这里只美化对外展示：
 *   `0.1.4「涟漪 さざなみ」`
 * patch 版本沿用所属 minor 的代号（0.1.x → 涟漪）。
 *
 * 完整规划（0.1 → 1.0，水声由轻到重）：
 *   0.1 涟漪 → 0.2 潮汐 → 0.3 涌浪 → 0.4 海风 → 0.5 潮鸣
 *   → 0.6 深蓝 → 0.7 极光 → 0.8 白浪 → 0.9 深渊 → 1.0 澜（正式版收束）
 * 1.0 起统一沿用"澜 おおなみ"。
 */

export interface VersionCodename {
  zh: string
  ja: string
  romaji: string
}

const CODENAMES: Record<number, VersionCodename> = {
  0: { zh: '澜', ja: 'おおなみ', romaji: 'ōnami' },
  1: { zh: '涟漪', ja: 'さざなみ', romaji: 'sazanami' },
  2: { zh: '潮汐', ja: 'ちょうせき', romaji: 'chōseki' },
  3: { zh: '涌浪', ja: 'うねり', romaji: 'uneri' },
  4: { zh: '海风', ja: 'うみかぜ', romaji: 'umikaze' },
  5: { zh: '潮鸣', ja: 'しおなり', romaji: 'shionari' },
  6: { zh: '深蓝', ja: 'こんぺき', romaji: 'konpeki' },
  7: { zh: '极光', ja: 'オーロラ', romaji: 'ōrora' },
  8: { zh: '白浪', ja: 'しらなみ', romaji: 'shiranami' },
  9: { zh: '深渊', ja: 'しんえん', romaji: "shin'en" },
}

export function getVersionCodename(version: string): VersionCodename | null {
  const parts = String(version).replace(/^v/i, '').split('.')
  const major = parseInt(parts[0] || '', 10)
  const minor = parseInt(parts[1] || '', 10)
  // 1.0 起为正式版，统一收在"澜"（大波）
  if (major >= 1) return CODENAMES[0] || null
  return CODENAMES[minor] || null
}

/** 对外展示：0.1.4「涟漪 さざなみ」 */
export function getVersionDisplay(version: string): string {
  const v = String(version).replace(/^v/i, '')
  const c = getVersionCodename(version)
  return c ? `${v}「${c.zh} ${c.ja}」` : v
}
