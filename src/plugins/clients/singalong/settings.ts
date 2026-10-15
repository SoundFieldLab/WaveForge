/**
 * 学歌插件 · 本地进度与设置（纯 localStorage，不外发）。
 *
 * 自学跟读模式下用户逐句标记「学会了」，按歌曲维度持久化：
 *   wf_singalong_progress:<songKey> → { [lineTimeMs]: 1 }
 * 跟唱练习模式的设置（麦克风自动开启、评分显示开关）同样存这里。
 */

/** 按歌曲 key 读取已学会的行（行起始时间 ms 为键）。 */
export function loadMasteredLines(songKey: string): Set<number> {
  try {
    const raw = localStorage.getItem(`wf_singalong_progress:${songKey}`)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is number => typeof value === 'number'))
  } catch {
    return new Set()
  }
}

/** 写回某首歌的已学会行集合（空集合删除整个键）。 */
export function saveMasteredLines(songKey: string, lines: Set<number>): void {
  try {
    const key = `wf_singalong_progress:${songKey}`
    if (lines.size === 0) {
      localStorage.removeItem(key)
      return
    }
    localStorage.setItem(key, JSON.stringify(Array.from(lines)))
  } catch {
    /* 存储不可用时静默失败 */
  }
}

/** 学歌全局设置（界面显示 + 练习行为偏好）。 */
export interface SingAlongSettings {
  /** 打开面板时自动开启麦克风（跟唱练习模式）。 */
  autoStartMic: boolean
  /** 显示翻译行。 */
  showTranslation: boolean
  /** 逐字光带效果（关闭退化为整行高亮；低配机/不喜欢动效时用）。 */
  wordByWord: boolean
  /** 歌词字号：normal（默认）/ large（练唱距离远时用）。 */
  lyricSize: 'normal' | 'large'
  /** 逐句停顿：自学模式下每句播完自动暂停，等你跟读/标记。 */
  pauseAfterLine: boolean
  /** 逐句停顿的等待秒数（跟唱模式下自动恢复播放的倒计时长度）。 */
  pauseDuration: number
  /** 指定麦克风（deviceId；空 = 系统默认）。 */
  micDeviceId: string
}

const SETTINGS_KEY = 'wf_singalong_settings'
const DEFAULT_SETTINGS: SingAlongSettings = {
  autoStartMic: true,
  showTranslation: true,
  wordByWord: true,
  lyricSize: 'normal',
  pauseAfterLine: false,
  pauseDuration: 5,
  micDeviceId: '',
}

export function loadSingAlongSettings(): SingAlongSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return {
      ...DEFAULT_SETTINGS,
      autoStartMic: parsed.autoStartMic !== false,
      showTranslation: parsed.showTranslation !== false,
      wordByWord: parsed.wordByWord !== false,
      lyricSize: parsed.lyricSize === 'large' ? 'large' : 'normal',
      pauseAfterLine: parsed.pauseAfterLine === true,
      pauseDuration: Number.isFinite(parsed.pauseDuration) ? Math.min(15, Math.max(2, Number(parsed.pauseDuration))) : DEFAULT_SETTINGS.pauseDuration,
      micDeviceId: typeof parsed.micDeviceId === 'string' ? parsed.micDeviceId : '',
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSingAlongSettings(settings: SingAlongSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    /* ignore */
  }
  try { window.dispatchEvent(new Event('waveforge:singalong-settings')) } catch { /* 非 DOM 环境（单测）忽略 */ }
}
