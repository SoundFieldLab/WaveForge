/**
 * 成就回检测（retro-check）：打开成就系统面板时自动扫描本机持久化状态，
 * 把"早已做过但成就系统上线前/未触发"的操作补发成已解锁成就（不弹窗——
 * 补发不算新解锁时刻，静默入账，面板里能看到解锁时间）。
 *
 * 检测源（全部 localStorage / 已有存档，不产生任何网络/IO 压力）：
 *  - 听歌记录：listeningLog 总条数 → first-play / play-100 / play-1000
 *  - 歌词模式：lyricDisplayMode 持久值 → theme-switcher / lyrics-viewer / mode-collector
 *  - 设置项：autoMixEnabled / 桌面歌词注册事件无法回溯，但 desktopLyrics 设置键、
 *    音质偏好、均衡器、语言、任务栏播控等键存在即视为用过
 */
import { awardIfNew, handleListenRecorded, handleLyricModeSwitched } from './triggers'
import { unlock, isUnlocked } from './core'

function ls(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

/** 播放里程碑：直接读听歌日志长度（比事件计数更准——上线前的历史也计入） */
function retrocheckPlays(): void {
  try {
    const raw = ls('waveforge:listening-log:v1')
    if (!raw) return
    const entries = JSON.parse(raw)
    const total = Array.isArray(entries) ? entries.length : 0
    awardIfNew('first-play', total >= 1)
    awardIfNew('play-100', total >= 100)
    awardIfNew('play-1000', total >= 1000)
  } catch { /* ignore */ }
}

/** 歌词模式：当前持久模式视为已体验 */
function retrocheckLyricModes(): void {
  const mode = ls('lyricDisplayMode')
  if (mode) handleLyricModeSwitched(mode)
}

/** 开关/设置型成就：对应键存在（或为 true）即补发 */
function retrocheckToggles(): void {
  awardIfNew('automix-first', ls('autoMixEnabled') === 'true')
  awardIfNew('volume-tuner', ls('waveforge:volume') !== null)
  awardIfNew('quality-seeker', ls('audioQualityPreference') !== null || ls('qqQualityPreference') !== null || ls('neteaseQualityPreference') !== null)
}

/** 桌面歌词（主进程状态，异步）：面板打开时顺带回查 */
export function retrocheckDesktopLyrics(): void {
  try {
    const api = (window as any).electron?.desktopLyrics
    api?.getSettings?.().then((settings: { enabled?: boolean } | null) => {
      if (settings?.enabled) awardIfNew('desktop-lyrics', true)
    }).catch(() => undefined)
  } catch { /* 非桌面环境忽略 */ }
}

/** 回检测总入口：成就面板 open 时调用（幂等，全部 awardIfNew 内部判重） */
export function runRetrocheck(): void {
  try {
    retrocheckPlays()
    retrocheckLyricModes()
    retrocheckToggles()
    retrocheckDesktopLyrics()
  } catch { /* ignore */ }
}

export { unlock, isUnlocked }
