/**
 * 全局成就触发器：软件本体行为的成就解锁判定。
 *
 * 数据源：
 *  - 播放里程碑：listeningLog（recordListen 时 dispatch 的 waveforge:listen-recorded 事件）
 *  - 时段成就：同上（凌晨 2-4 点 / 清晨 5-7 点开播）
 *  - OOBE 完成：OobeGuide complete() dispatch 的 waveforge:oobe-completed
 *    （允许音乐的等 5 秒淡出结束后再弹；拒绝音乐的 1 秒后弹）
 *  - BUG英雄：兑换码 feature=achievement.bug-hero，App.tsx 兑换成功回调调 unlockBugHero()
 *  - 歌词模式切换 / 沉浸歌词进入 / 空间音频 / 智能混音 / 桌面歌词 / 建歌单：
 *    各自的设置持久化点直接调 core.unlock（本模块只集中常见路径）
 */
import { isUnlocked, unlock } from './core'
import { notifyAchievement } from './ToastLayer'

/** 解锁 + 弹窗（新解锁才弹） */
export function award(id: string): void {
  try {
    if (unlock(id)) notifyAchievement(id)
  } catch { /* 成就失败不影响主流程 */ }
}

/** 已解锁则跳过（供外部条件成就：歌词模式全体验等需要先读状态再判定的场景） */
export function awardIfNew(id: string, condition: boolean): void {
  if (condition) award(id)
}

/* ── 播放里程碑 ── */

const PLAY_COUNT_KEY = 'waveforge:achievement-play-count'

function bumpPlayCount(): number {
  try {
    const next = (parseInt(localStorage.getItem(PLAY_COUNT_KEY) || '0', 10) || 0) + 1
    localStorage.setItem(PLAY_COUNT_KEY, String(next))
    return next
  } catch {
    return 0
  }
}

export function handleListenRecorded(): void {
  try {
    const count = bumpPlayCount()
    awardIfNew('first-play', count >= 1)
    awardIfNew('play-100', count >= 100)
    awardIfNew('play-1000', count >= 1000)
    const hour = new Date().getHours()
    awardIfNew('night-owl', hour >= 2 && hour < 4)
    awardIfNew('early-bird', hour >= 5 && hour < 7)
  } catch { /* ignore */ }
}

/* ── OOBE 完成 ── */

/** OobeGuide complete() 时调用；bgmAllowed 决定是否等音乐淡出 */
export function handleOobeComplete(bgmAllowed: boolean): void {
  if (bgmAllowed) {
    // 音乐 5 秒淡出 → 淡出结束后 1 秒
    window.setTimeout(() => award('welcome'), 5000 + 1000)
  } else {
    window.setTimeout(() => award('welcome'), 1000)
  }
}

/* ── BUG英雄（兑换码联动）── */

export const BUG_HERO_FEATURE = 'achievement.bug-hero'

/** 兑换成功回调：feature 匹配即解锁 BUG英雄 */
export function unlockBugHeroIfGranted(features: string[]): void {
  if (features.includes(BUG_HERO_FEATURE)) award('bug-hero')
}

/* ── 单点成就（各设置持久化点直接调用）── */

export const awardFirstPlay = () => award('first-play')
export const awardLyricsViewer = () => award('lyrics-viewer')
export const awardAutomixFirst = () => award('automix-first')
export const awardSpatialAudio = () => award('spatial-audio')
export const awardDesktopLyrics = () => award('desktop-lyrics')
export const awardPlaylistCreator = () => award('playlist-creator')

/** 歌词模式切换：记录已体验模式集合，集齐 8 种解锁全图鉴 */
const SEEN_MODES_KEY = 'waveforge:achievement-seen-lyric-modes'
const ALL_LYRIC_MODES_TOTAL = 8

export function handleLyricModeSwitched(mode: string): void {
  try {
    award('theme-switcher')
    if (mode === 'video' || mode === 'modeng') return // 看歌/摩登不计入沉浸歌词页
    const seen = new Set<string>(JSON.parse(localStorage.getItem(SEEN_MODES_KEY) || '[]'))
    seen.add(mode)
    localStorage.setItem(SEEN_MODES_KEY, JSON.stringify(Array.from(seen)))
    if (seen.size >= ALL_LYRIC_MODES_TOTAL - 2) {
      // 8 种 = immersive/wallpaper/glorious/multidimensional/folia/modern/video/modeng，
      // 收集 6 种非视频类即视为体验覆盖（video/modeng 常驻入口）
      award('mode-collector')
    }
    if (mode === 'immersive' && !isUnlocked('lyrics-viewer')) award('lyrics-viewer')
  } catch { /* ignore */ }
}
