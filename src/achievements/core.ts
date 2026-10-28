/**
 * 全局成就系统 —— 核心注册表与存档。
 *
 * 结构：成就分两个板块（section）
 *  - 'app'    全局成就：软件本体行为解锁（OOBE、播放、探索……）
 *  - 'plugin' 插件成就：In Party / 共振等插件玩法解锁（现有 inparty/achievements.ts 的存量迁移）
 *
 * 存档：localStorage `waveforge:achievements`（id + 解锁时间戳）。
 * 解锁事件：`waveforge:achievement-unlocked`（detail: id）→ ToastLayer 弹窗。
 *
 * BUG英雄联动兑换码：limited 码 feature 固定为 `achievement.bug-hero`，
 * 兑换成功即解锁（见 App.tsx 兑换成功回调与 license-studio 签发约定）。
 */

export type AchievementTier = 'normal' | 'epic'
export type AchievementSection = 'app' | 'plugin'

export interface AchievementDef {
  id: string
  section: AchievementSection
  tier: AchievementTier
  /** 弹窗标题行（normal「进度已达成！」/ epic「挑战已完成！」） */
  title: string
  /** 成就名（弹窗副标题 / 面板列表标题） */
  name: string
  /** 解锁条件描述（面板里显示） */
  desc: string
  /** 图标 key（icons.tsx 注册表；隐藏成就解锁前用 'mystery'） */
  icon: string
  /** 隐藏成就：解锁前在面板显示 ??? */
  hidden?: boolean
}

/* ── 全局成就定义（app 板块）── */
export const GLOBAL_ACHIEVEMENTS: AchievementDef[] = [
  {
    id: 'welcome',
    section: 'app', tier: 'epic',
    title: '挑战已完成！', name: '欢迎！！！',
    desc: '完成初始设置引导', icon: 'welcome',
  },
  {
    id: 'first-play',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '初试啼声',
    desc: '第一次播放歌曲', icon: 'play',
  },
  {
    id: 'play-100',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '耳朵怀孕了',
    desc: '累计播放 100 首歌曲', icon: 'headphones',
  },
  {
    id: 'play-1000',
    section: 'app', tier: 'epic',
    title: '挑战已完成！', name: '音乐 Lifetime',
    desc: '累计播放 1000 首歌曲', icon: 'vinyl',
  },
  {
    id: 'lyrics-viewer',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '眼前一亮！',
    desc: '第一次进入沉浸歌词页', icon: 'sparkle',
  },
  {
    id: 'mode-collector',
    section: 'app', tier: 'epic',
    title: '挑战已完成！', name: '全图鉴收藏家',
    desc: '体验过全部 8 种歌词模式', icon: 'grid',
  },
  {
    id: 'automix-first',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '初次登台 DJ',
    desc: '第一次开启智能混音', icon: 'dj',
  },
  {
    id: 'spatial-audio',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '声临其境',
    desc: '第一次开启空间音频', icon: 'surround',
  },
  {
    id: 'night-owl',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '深夜电台',
    desc: '在凌晨 2 点到 4 点之间听歌', icon: 'moon',
  },
  {
    id: 'early-bird',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '晨间旋律',
    desc: '在早上 5 点到 7 点之间听歌', icon: 'sunrise',
  },
  {
    id: 'playlist-creator',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '策展人',
    desc: '第一次创建自己的歌单', icon: 'list',
  },
  {
    id: 'desktop-lyrics',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '桌面歌词点亮',
    desc: '第一次开启桌面歌词', icon: 'desktop',
  },
  {
    id: 'theme-switcher',
    section: 'app', tier: 'normal',
    title: '进度已达成！', name: '换装大师',
    desc: '切换过歌词显示模式', icon: 'palette',
  },
  {
    id: 'bug-hero',
    section: 'app', tier: 'epic',
    title: '挑战已完成！', name: 'BUG 英雄',
    desc: '开发者颁发的荣誉：发现并上报了重大 BUG', icon: 'bug',
  },
]

/** 插件板块：当前只有 In Party 存量成就（inparty/achievements.ts 内定义）。 */
export const PLUGIN_SECTION_LABEL: Record<string, string> = {
  inparty: 'In Party',
  resonance: '共振',
}

/* ── 全部成就（全局 + 运行时注册的插件成就）── */
const registry = new Map<string, AchievementDef>()
for (const def of GLOBAL_ACHIEVEMENTS) registry.set(def.id, def)

/** 插件运行时注册（inparty/achievements.ts 迁移数据在模块加载时调用） */
export function registerAchievements(section: string, defs: Array<Omit<AchievementDef, 'section'>>): void {
  for (const def of defs) {
    if (!registry.has(def.id)) registry.set(def.id, { ...def, section: 'plugin' })
  }
}

export function getAchievementDef(id: string): AchievementDef | undefined {
  return registry.get(id)
}

export function getAllAchievements(): AchievementDef[] {
  return Array.from(registry.values())
}

/* ── 本机存档 ── */

const STORE_KEY = 'waveforge:achievements'

export interface AchievementRecord {
  id: string
  /** 解锁时间戳（毫秒） */
  at: number
}

export function readUnlockedRecords(): AchievementRecord[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item) => item && typeof item.id === 'string' && typeof item.at === 'number')
      : []
  } catch {
    return []
  }
}

export function isUnlocked(id: string): boolean {
  return readUnlockedRecords().some((record) => record.id === id)
}

/** 解锁（幂等）。返回 true 表示是新解锁（调用方据此弹 Toast）。 */
export function unlock(id: string): boolean {
  const def = registry.get(id)
  if (!def) return false
  const records = readUnlockedRecords()
  if (records.some((record) => record.id === id)) return false
  records.push({ id, at: Date.now() })
  try { localStorage.setItem(STORE_KEY, JSON.stringify(records)) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('waveforge:achievement-unlocked', { detail: id }))
  return true
}

/** 面板统计 */
export function achievementSummary(): { unlocked: number; total: number; percent: number } {
  const unlocked = readUnlockedRecords().length
  const total = registry.size
  return { unlocked, total, percent: total > 0 ? Math.round((unlocked / total) * 100) : 0 }
}
