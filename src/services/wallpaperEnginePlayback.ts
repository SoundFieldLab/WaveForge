/**
 * Wallpaper Engine 壁纸播放参数（音量 / 帧率 / 视差 / 音频响应）。
 *
 * 与轮换设置同一模式：localStorage 持久化 + 自定义事件广播，
 * DesktopView 持有状态并下发渲染链（WWGL / legacy / <video>）。
 */

export type WallpaperEngineFpsLimit = 60 | 30 | 24

export interface WallpaperEnginePlaybackSettings {
  /** 壁纸音量 0..100（WWGL 场景音量默认静音起步；视频走 video.volume） */
  volume: number
  /** 帧率上限（渲染循环跳帧；60=默认档） */
  fpsLimit: WallpaperEngineFpsLimit
  /** 鼠标视差（legacy window 监听 / WWGL pushPointer 喂入） */
  parallaxEnabled: boolean
  /** 音频响应（spectrumBus → g_Audio* uniform / WWGL audio.snapshot） */
  audioReactiveEnabled: boolean
}

export const WALLPAPER_ENGINE_PLAYBACK_STORAGE_KEY = 'wallpaperEnginePlaybackSettings'
export const WALLPAPER_ENGINE_PLAYBACK_EVENT = 'wallpaperEnginePlaybackChanged'

const DEFAULT_SETTINGS: WallpaperEnginePlaybackSettings = {
  volume: 80,
  fpsLimit: 60,
  parallaxEnabled: true,
  audioReactiveEnabled: true,
}

const clampVolume = (value: unknown) => {
  const volume = Number(value)
  if (!Number.isFinite(volume)) return DEFAULT_SETTINGS.volume
  return Math.min(100, Math.max(0, Math.round(volume)))
}

const normalizeFpsLimit = (value: unknown): WallpaperEngineFpsLimit =>
  value === 30 || value === 24 ? value : 60

export const loadWallpaperEnginePlaybackSettings = (): WallpaperEnginePlaybackSettings => {
  try {
    const saved = localStorage.getItem(WALLPAPER_ENGINE_PLAYBACK_STORAGE_KEY)
    if (!saved) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(saved) as Partial<WallpaperEnginePlaybackSettings>
    return {
      volume: clampVolume(parsed.volume),
      fpsLimit: normalizeFpsLimit(parsed.fpsLimit),
      parallaxEnabled: parsed.parallaxEnabled === undefined ? DEFAULT_SETTINGS.parallaxEnabled : Boolean(parsed.parallaxEnabled),
      audioReactiveEnabled: parsed.audioReactiveEnabled === undefined ? DEFAULT_SETTINGS.audioReactiveEnabled : Boolean(parsed.audioReactiveEnabled),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const saveWallpaperEnginePlaybackSettings = (
  settings: WallpaperEnginePlaybackSettings,
): WallpaperEnginePlaybackSettings => {
  const normalized: WallpaperEnginePlaybackSettings = {
    volume: clampVolume(settings.volume),
    fpsLimit: normalizeFpsLimit(settings.fpsLimit),
    parallaxEnabled: Boolean(settings.parallaxEnabled),
    audioReactiveEnabled: Boolean(settings.audioReactiveEnabled),
  }
  try {
    localStorage.setItem(WALLPAPER_ENGINE_PLAYBACK_STORAGE_KEY, JSON.stringify(normalized))
  } catch { /* 配额满忽略 */ }
  window.dispatchEvent(new CustomEvent<WallpaperEnginePlaybackSettings>(WALLPAPER_ENGINE_PLAYBACK_EVENT, { detail: normalized }))
  return normalized
}
