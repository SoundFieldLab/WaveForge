/**
 * 歌词风格样式：把原先分离的「逐字效果」与「歌词切换动画」两个设置合并为一种风格。
 *
 * - 柔和（soft）  ：柔光扩散逐字 + 传统滚动
 * - 摩登（modern）：Apple 逐词点亮逐字 + 弹簧滚动
 *
 * 旧设置（wordByWordEffectMode / lyricScrollTransitionStyle）不再暴露给用户，
 * 读取时做一次等价迁移：Apple 逐字或崭新滚动 → 摩登，其余 → 柔和。
 */
export type LyricStyleMode = 'soft' | 'modern'

/** 逐字效果：clear 仅保留给桌面播放器等内部覆盖使用，不再出现在设置项中。 */
export type WordByWordEffectMode = 'clear' | 'soft' | 'apple'

/** 滚动动画：classic 原生居中滚动 / amodern 弹簧 transform 滚动。 */
export type ScrollTransitionStyle = 'classic' | 'amodern'

export const LYRIC_STYLE_MODE_KEY = 'lyricStyleMode'
export const LYRIC_STYLE_MODE_EVENT = 'lyricStyleModeChanged'

export const readLyricStyleMode = (): LyricStyleMode => {
  try {
    const saved = localStorage.getItem(LYRIC_STYLE_MODE_KEY)
    if (saved === 'soft' || saved === 'modern') return saved
    if (localStorage.getItem('wordByWordEffectMode') === 'apple') return 'modern'
    if (localStorage.getItem('lyricScrollTransitionStyle') === 'amodern') return 'modern'
  } catch { /* 存储不可用（隐私模式等）时用默认值 */ }
  return 'soft'
}

export const persistLyricStyleMode = (mode: LyricStyleMode): void => {
  try {
    localStorage.setItem(LYRIC_STYLE_MODE_KEY, mode)
  } catch { /* 忽略写入失败 */ }
  window.dispatchEvent(new CustomEvent(LYRIC_STYLE_MODE_EVENT, { detail: mode }))
}

/** 风格 → 逐字效果 */
export const wordEffectModeOfStyle = (style: LyricStyleMode): WordByWordEffectMode =>
  style === 'modern' ? 'apple' : 'soft'

/** 风格 → 歌词切换动画 */
export const scrollStyleOfStyle = (style: LyricStyleMode): ScrollTransitionStyle =>
  style === 'modern' ? 'amodern' : 'classic'
