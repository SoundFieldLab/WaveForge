/**
 * In Party 成就系统（Minecraft 风格：进度已达成 / 挑战已完成）。
 *
 * 两档：
 *  - normal  「进度已达成！」（黄字，木头箱图标风）——常规里程碑
 *  - epic    「挑战已完成！」（紫字，附魔弓图标风）——高难/搞笑隐藏成就
 *
 * 触发点全部来自会话事件（玩法结算/互控/社交/设备），由 session 调 unlock。
 * 已解锁列表只存本机（localStorage），跨房间累积。
 * 弹窗由 UI 层的 AchievementToast 渲染（右上角，MC 像素框）。
 */

export type AchievementTier = 'normal' | 'epic'

export interface AchievementDef {
  id: string
  tier: AchievementTier
  /** 弹窗标题（「进度已达成！」/「挑战已完成！」的正文） */
  title: string
  /** 弹窗副标题（成就名，如「知识就是力量」「劲弩手」） */
  name: string
  /** 触发描述（成就面板里显示的解锁条件） */
  desc: string
  /** MC 风格像素 emoji（弹窗左侧图标） */
  icon: string
}

/** 全部成就定义 */
export const ACHIEVEMENTS: AchievementDef[] = [
  // ── 入门（normal）──
  { id: 'first-room', tier: 'normal', title: '进度已达成！', name: '开派对了', desc: '第一次创建 In Party 房间', icon: '🎉' },
  { id: 'first-join', tier: 'normal', title: '进度已达成！', name: '新面孔', desc: '第一次加入别人的房间', icon: '🚪' },
  { id: 'first-chat', tier: 'normal', title: '进度已达成！', name: '破冰者', desc: '发送第一条聊天消息', icon: '💬' },
  { id: 'first-device', tier: 'normal', title: '进度已达成！', name: '接线完成', desc: '房间里第一次连上郊狼设备', icon: '🔌' },
  { id: 'first-control', tier: 'normal', title: '进度已达成！', name: '初次掌权', desc: '第一次成功控制别人的设备', icon: '🎛️' },
  { id: 'first-shocked', tier: 'normal', title: '进度已达成！', name: '初体验', desc: '第一次被别人控制（有来有往才是派对）', icon: '⚡' },

  // ── 社交（normal）──
  { id: 'first-friend', tier: 'normal', title: '进度已达成！', name: '交到朋友了', desc: '第一次添加好友', icon: '🤝' },
  { id: 'friend-10', tier: 'epic', title: '挑战已完成！', name: '社交达人', desc: '累计 10 位好友', icon: '👑' },
  { id: 'first-voice', tier: 'normal', title: '进度已达成！', name: '开麦了', desc: '第一次上麦连麦', icon: '🎙️' },
  { id: 'first-camera', tier: 'normal', title: '进度已达成！', name: 'Action！', desc: '第一次开播摄像头', icon: '🎬' },
  { id: 'chat-100', tier: 'epic', title: '挑战已完成！', name: '话痨', desc: '累计发送 100 条消息', icon: '🗣️' },
  { id: 'emoji-react', tier: 'normal', title: '进度已达成！', name: '点赞之交', desc: '第一次给消息贴表情回应', icon: '👍' },

  // ── 玩法（normal）──
  { id: 'duel-win', tier: 'normal', title: '进度已达成！', name: '决斗生还者', desc: '第一次在决斗中没输', icon: '⚔️' },
  { id: 'duel-streak-3', tier: 'normal', title: '进度已达成！', name: '三连胜', desc: '决斗连胜 3 场', icon: '🔥' },
  { id: 'duel-streak-5', tier: 'epic', title: '挑战已完成！', name: '不败战神', desc: '决斗连胜 5 场', icon: '🏆' },
  { id: 'roulette-survivor', tier: 'normal', title: '进度已达成！', name: '欧皇附体', desc: '轮盘抽中「无事发生」', icon: '🍀' },
  { id: 'roulette-victim', tier: 'normal', title: '进度已达成！', name: '非酋时刻', desc: '轮盘抽中「风暴 10s」', icon: '🌪️' },
  { id: 'game-first', tier: 'normal', title: '进度已达成！', name: '游戏人生', desc: '第一次参与玩法中心的游戏', icon: '🎮' },
  { id: 'games-10', tier: 'epic', title: '挑战已完成！', name: '派对之王', desc: '累计参与 10 场玩法', icon: '🎊' },
  { id: 'undercover-win', tier: 'epic', title: '挑战已完成！', name: '影帝', desc: '谁是卧底活到最后（无论阵营）', icon: '🎭' },
  { id: 'relay-survive', tier: 'normal', title: '进度已达成！', name: '电流接力手', desc: '接力电中成功传出（没断链）', icon: '🤾' },
  { id: 'dice-safe', tier: 'normal', title: '进度已达成！', name: '天选之人', desc: '惩罚骰子掷出安全格', icon: '🛡️' },
  { id: 'dice-storm', tier: 'epic', title: '挑战已完成！', name: '命运的漩涡', desc: '惩罚骰子掷出风暴 8 秒', icon: '🌀' },

  // ── 互控/设备（normal+epic）──
  { id: 'wave-bind', tier: 'normal', title: '进度已达成！', name: '节奏主宰', desc: '第一次把自己的波形推给别人', icon: '🌊' },
  { id: 'quick-tease', tier: 'normal', title: '进度已达成！', name: '小恶魔', desc: '第一次用快捷电击「撩一下」', icon: '😈' },
  { id: 'quick-punish', tier: 'epic', title: '挑战已完成！', name: '重拳出击', desc: '第一次用「惩罚」档快捷电击', icon: '👊' },
  { id: 'control-50', tier: 'epic', title: '挑战已完成！', name: '电击大师', desc: '累计发出 50 条互控指令', icon: '🧙' },
  { id: 'pause-me', tier: 'normal', title: '进度已达成！', name: '安全第一', desc: '第一次使用紧急叫停（好习惯！）', icon: '🛑' },
  { id: 'host-rhythm', tier: 'normal', title: '进度已达成！', name: '同频共振', desc: '第一次开启「跟随房主节奏」', icon: '🎶' },

  // ── 隐藏彩蛋（epic，面板里显示 ???）──
  { id: 'hidden-admin', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: '❓' },
  { id: 'hidden-mute', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: '❓' },
  { id: 'hidden-kick', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: '❓' },
  { id: 'hidden-redlight-hero', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: '❓' },

  // ── 共振（一起听）共享成就墙 ──
  { id: 'rz-first-room', tier: 'normal', title: '进度已达成！', name: '一起听开张', desc: '第一次创建共振房间', icon: '🎵' },
  { id: 'rz-first-join', tier: 'normal', title: '进度已达成！', name: '蹭听成功', desc: '第一次加入共振房间', icon: '🎧' },
  { id: 'rz-first-chat', tier: 'normal', title: '进度已达成！', name: '房间话题王', desc: '第一次在共振房间发言', icon: '💭' },
  { id: 'rz-listen-30min', tier: 'epic', title: '挑战已完成！', name: '同频三十分钟', desc: '在共振房间里跟播满 30 分钟', icon: '⏳' },
]

export const ACHIEVEMENT_MAP = new Map(ACHIEVEMENTS.map(def => [def.id, def]))

/** 未解锁的隐藏成就显示 ??? */
export function displayDef(def: AchievementDef, unlocked: boolean): AchievementDef {
  if (def.id.startsWith('hidden-') && !unlocked) {
    return { ...def, title: '？？？', name: '隐藏成就', desc: '继续玩下去就会发现…', icon: '❓' }
  }
  return def
}

/* ── 本机存档 ── */

const UNLOCKED_KEY = 'waveforge:inparty-achievements'

export interface AchievementRecord {
  id: string
  at: number
}

export function readUnlockedAchievements(): AchievementRecord[] {
  try {
    const raw = localStorage.getItem(UNLOCKED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string') : []
  } catch {
    return []
  }
}

export function isAchievementUnlocked(id: string): boolean {
  return readUnlockedAchievements().some(record => record.id === id)
}

/** 解锁（幂等）；返回是否是「新解锁」（决定要不要弹窗） */
export function unlockAchievement(id: string): boolean {
  if (!ACHIEVEMENT_MAP.has(id)) return false
  const records = readUnlockedAchievements()
  if (records.some(record => record.id === id)) return false
  records.push({ id, at: Date.now() })
  try { localStorage.setItem(UNLOCKED_KEY, JSON.stringify(records)) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('waveforge:inparty-achievement', { detail: id }))
  return true
}

/** 计数器（累计类成就：聊天 100 条/互控 50 条/玩法 10 场） */
const COUNTER_KEY = 'waveforge:inparty-achievement-counters'

export function readCounters(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COUNTER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** 计数 +1 并返回新值 */
export function bumpCounter(key: string): number {
  const counters = readCounters()
  const next = (counters[key] ?? 0) + 1
  counters[key] = next
  try { localStorage.setItem(COUNTER_KEY, JSON.stringify(counters)) } catch { /* ignore */ }
  return next
}

/** 成就统计（面板顶部） */
export function achievementSummary(): { unlocked: number; total: number; percent: number } {
  const unlocked = readUnlockedAchievements().length
  const total = ACHIEVEMENTS.length
  return { unlocked, total, percent: Math.round((unlocked / total) * 100) }
}
