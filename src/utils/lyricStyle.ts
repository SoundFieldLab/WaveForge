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

/** 风格 → 歌词切换动画 */
export const scrollStyleOfStyle = (style: LyricStyleMode): ScrollTransitionStyle =>
  style === 'modern' ? 'amodern' : 'classic'

/**
 * 逐字填充说明：两种风格共用「整行连续光带」填充（已唱亮 / 未唱暗，边界羽化），
 * 不再按词独立擦亮。差异只体现在光带宽度与滚动/行视觉上——
 * 柔和 = 大面积柔光扩散 + 传统滚动；摩登 = AMLL 式窄光带 + 弹簧滚动（无行级 y 位移）。
 * 光带宽度在 LyricsDisplay 的 getWordEffectConfig 里按风格取值。
 */
export const LYRIC_FILL_EFFECT_MODE: WordByWordEffectMode = 'soft'
