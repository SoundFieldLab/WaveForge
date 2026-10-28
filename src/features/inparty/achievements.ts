/**
 * In Party 成就 → 全局成就系统桥接。
 *
 * In Party 原有的成就定义（原 inparty/achievements.ts 里的 ACHIEVEMENTS）迁入
 * 全局系统的「插件成就」板块：模块加载时把定义注册进全局注册表，
 * 并把原解锁记录（waveforge:inparty-achievements）迁移到全局存档（保留原时间戳）。
 *
 * session.ts 的 unlockAchievement / isAchievementUnlocked / bumpCounter /
 * notifyAchievement 等入口全部改为转发全局系统 —— 上层代码零改动。
 */
import { getAchievementDef, isUnlocked, registerAchievements, unlock } from '../../achievements/core'
import { notifyAchievement } from '../../achievements/ToastLayer'
export { notifyAchievement }

/* ── 原有成就定义（原样迁移，section: plugin）── */
const INPARTY_ACHIEVEMENTS: Array<{
  id: string
  tier: 'normal' | 'epic'
  title: string
  name: string
  desc: string
  icon: string
  hidden?: boolean
}> = [
  // ── 入门（normal）──
  { id: 'first-room', tier: 'normal', title: '进度已达成！', name: '开派对了', desc: '第一次创建 In Party 房间', icon: 'play' },
  { id: 'first-join', tier: 'normal', title: '进度已达成！', name: '新面孔', desc: '第一次加入别人的房间', icon: 'list' },
  { id: 'first-chat', tier: 'normal', title: '进度已达成！', name: '破冰者', desc: '发送第一条聊天消息', icon: 'sparkle' },
  { id: 'first-device', tier: 'normal', title: '进度已达成！', name: '接线完成', desc: '房间里第一次连上郊狼设备', icon: 'surround' },
  { id: 'first-control', tier: 'normal', title: '进度已达成！', name: '初次掌权', desc: '第一次成功控制别人的设备', icon: 'dj' },
  { id: 'first-shocked', tier: 'normal', title: '进度已达成！', name: '初体验', desc: '第一次被别人控制（有来有往才是派对）', icon: 'welcome' },

  // ── 社交（normal）──
  { id: 'first-friend', tier: 'normal', title: '进度已达成！', name: '交到朋友了', desc: '第一次添加好友', icon: 'list' },
  { id: 'friend-10', tier: 'epic', title: '挑战已完成！', name: '社交达人', desc: '累计 10 位好友', icon: 'grid' },
  { id: 'first-voice', tier: 'normal', title: '进度已达成！', name: '开麦了', desc: '第一次上麦连麦', icon: 'headphones' },
  { id: 'first-camera', tier: 'normal', title: '进度已达成！', name: 'Action！', desc: '第一次开播摄像头', icon: 'play' },
  { id: 'chat-100', tier: 'epic', title: '挑战已完成！', name: '话痨', desc: '累计发送 100 条消息', icon: 'sparkle' },
  { id: 'emoji-react', tier: 'normal', title: '进度已达成！', name: '点赞之交', desc: '第一次给消息贴表情回应', icon: 'list' },

  // ── 玩法（normal）──
  { id: 'duel-win', tier: 'normal', title: '进度已达成！', name: '决斗生还者', desc: '第一次在决斗中没输', icon: 'play' },
  { id: 'duel-streak-3', tier: 'normal', title: '进度已达成！', name: '三连胜', desc: '决斗连胜 3 场', icon: 'sparkle' },
  { id: 'duel-streak-5', tier: 'epic', title: '挑战已完成！', name: '不败战神', desc: '决斗连胜 5 场', icon: 'welcome' },
  { id: 'roulette-survivor', tier: 'normal', title: '进度已达成！', name: '欧皇附体', desc: '轮盘抽中「无事发生」', icon: 'sparkle' },
  { id: 'roulette-victim', tier: 'normal', title: '进度已达成！', name: '非酋时刻', desc: '轮盘抽中「风暴 10s」', icon: 'moon' },
  { id: 'game-first', tier: 'normal', title: '进度已达成！', name: '游戏人生', desc: '第一次参与玩法中心的游戏', icon: 'play' },
  { id: 'games-10', tier: 'epic', title: '挑战已完成！', name: '派对之王', desc: '累计参与 10 场玩法', icon: 'welcome' },
  { id: 'undercover-win', tier: 'epic', title: '挑战已完成！', name: '影帝', desc: '谁是卧底活到最后（无论阵营）', icon: 'palette' },
  { id: 'relay-survive', tier: 'normal', title: '进度已达成！', name: '电流接力手', desc: '接力电中成功传出（没断链）', icon: 'surround' },
  { id: 'dice-safe', tier: 'normal', title: '进度已达成！', name: '天选之人', desc: '惩罚骰子掷出安全格', icon: 'sparkle' },
  { id: 'dice-storm', tier: 'epic', title: '挑战已完成！', name: '命运的漩涡', desc: '惩罚骰子掷出风暴 8 秒', icon: 'moon' },

  // ── 互控/设备（normal+epic）──
  { id: 'wave-bind', tier: 'normal', title: '进度已达成！', name: '节奏主宰', desc: '第一次把自己的波形推给别人', icon: 'surround' },
  { id: 'quick-tease', tier: 'normal', title: '进度已达成！', name: '小恶魔', desc: '第一次用快捷电击「撩一下」', icon: 'bug' },
  { id: 'quick-punish', tier: 'epic', title: '挑战已完成！', name: '重拳出击', desc: '第一次用「惩罚」档快捷电击', icon: 'bug' },
  { id: 'control-50', tier: 'epic', title: '挑战已完成！', name: '电击大师', desc: '累计发出 50 条互控指令', icon: 'dj' },
  { id: 'pause-me', tier: 'normal', title: '进度已达成！', name: '安全第一', desc: '第一次使用紧急叫停（好习惯！）', icon: 'list' },
  { id: 'host-rhythm', tier: 'normal', title: '进度已达成！', name: '同频共振', desc: '第一次开启「跟随房主节奏」', icon: 'headphones' },

  // ── 隐藏彩蛋（epic，面板里显示 ???）──
  { id: 'hidden-admin', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: 'mystery', hidden: true },
  { id: 'hidden-mute', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: 'mystery', hidden: true },
  { id: 'hidden-kick', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: 'mystery', hidden: true },
  { id: 'hidden-redlight-hero', tier: 'epic', title: '挑战已完成！', name: '？？?', desc: '隐藏成就', icon: 'mystery', hidden: true },

  // ── 共振（一起听）共享成就墙 ──
  { id: 'rz-first-room', tier: 'normal', title: '进度已达成！', name: '一起听开张', desc: '第一次创建共振房间', icon: 'headphones' },
  { id: 'rz-first-join', tier: 'normal', title: '进度已达成！', name: '蹭听成功', desc: '第一次加入共振房间', icon: 'list' },
  { id: 'rz-first-chat', tier: 'normal', title: '进度已达成！', name: '房间话题王', desc: '第一次在共振房间发言', icon: 'sparkle' },
  { id: 'rz-listen-30min', tier: 'epic', title: '挑战已完成！', name: '同频三十分钟', desc: '在共振房间里跟播满 30 分钟', icon: 'vinyl' },
]

/* ── 注册 + 存量记录迁移（幂等，模块只加载一次）── */
registerAchievements('inparty', INPARTY_ACHIEVEMENTS)

const LEGACY_KEY = 'waveforge:inparty-achievements'
const MIGRATED_KEY = 'waveforge:inparty-achievements-migrated'

function migrateLegacyRecords(): void {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === '1') return
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const storeKey = 'waveforge:achievements'
        const existing = JSON.parse(localStorage.getItem(storeKey) || '[]')
        const known = new Set(existing.map((r: { id: string }) => r.id))
        for (const record of parsed) {
          if (record && typeof record.id === 'string' && typeof record.at === 'number' && !known.has(record.id) && getAchievementDef(record.id)) {
            existing.push(record)
            known.add(record.id)
          }
        }
        localStorage.setItem(storeKey, JSON.stringify(existing))
      }
    }
    localStorage.setItem(MIGRATED_KEY, '1')
    localStorage.removeItem(LEGACY_KEY)
  } catch { /* 迁移失败不影响主流程 */ }
}
migrateLegacyRecords()

/* ── 转发 API（session.ts / InPartyView.tsx 现有调用零改动）── */

/** inparty 成就解锁（转发全局系统）；返回是否新解锁 */
export function unlockAchievement(id: string): boolean {
  const isNew = unlock(id)
  if (isNew) notifyAchievement(id)
  return isNew
}

export function isAchievementUnlocked(id: string): boolean {
  return isUnlocked(id)
}

/** 计数器（累计类成就）——逻辑不变，存档键沿用 */
const COUNTER_KEY = 'waveforge:inparty-achievement-counters'

export function readCounters(): Record<string, number> {
  try {
    const raw = localStorage.getItem(COUNTER_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

export function bumpCounter(key: string): number {
  const counters = readCounters()
  const next = (counters[key] ?? 0) + 1
  counters[key] = next
  try { localStorage.setItem(COUNTER_KEY, JSON.stringify(counters)) } catch { /* ignore */ }
  return next
}
