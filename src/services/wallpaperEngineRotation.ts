export interface WallpaperEngineWallpaper {
  id: string
  title: string
  description?: string
  type: 'video' | 'image' | 'web' | string
  file: string
  preview?: string | null
  tags?: string[]
  workshop?: string | null
  path?: string
}

export type WallpaperEngineRotationMode = 'sequential' | 'random'

export interface WallpaperEngineRotationSettings {
  enabled: boolean
  intervalMinutes: number
  mode: WallpaperEngineRotationMode
  selectedWallpaperIds: string[]
}

export const WALLPAPER_ENGINE_ROTATION_STORAGE_KEY = 'wallpaperEngineRotationSettings'
export const WALLPAPER_ENGINE_ROTATION_EVENT = 'wallpaperEngineRotationChanged'

const DEFAULT_SETTINGS: WallpaperEngineRotationSettings = {
  enabled: false,
  intervalMinutes: 15,
  mode: 'sequential',
  selectedWallpaperIds: [],
}

const normalizeIds = (value: unknown) => Array.isArray(value)
  ? Array.from(new Set(value.map(item => String(item || '').trim()).filter(Boolean)))
  : []

const normalizeInterval = (value: unknown) => {
  const interval = Number(value)
  if (!Number.isFinite(interval)) return DEFAULT_SETTINGS.intervalMinutes
  return Math.min(24 * 60, Math.max(1, Math.round(interval)))
}

export const loadWallpaperEngineRotationSettings = (): WallpaperEngineRotationSettings => {
  try {
    const saved = localStorage.getItem(WALLPAPER_ENGINE_ROTATION_STORAGE_KEY)
    if (!saved) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(saved) as Partial<WallpaperEngineRotationSettings>
    const selectedWallpaperIds = normalizeIds(parsed.selectedWallpaperIds)
    return {
      enabled: Boolean(parsed.enabled) && selectedWallpaperIds.length >= 2,
      intervalMinutes: normalizeInterval(parsed.intervalMinutes),
      mode: parsed.mode === 'random' ? 'random' : 'sequential',
      selectedWallpaperIds,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const saveWallpaperEngineRotationSettings = (
  settings: WallpaperEngineRotationSettings,
): WallpaperEngineRotationSettings => {
  const selectedWallpaperIds = normalizeIds(settings.selectedWallpaperIds)
  const normalized: WallpaperEngineRotationSettings = {
    enabled: Boolean(settings.enabled) && selectedWallpaperIds.length >= 2,
    intervalMinutes: normalizeInterval(settings.intervalMinutes),
    mode: settings.mode === 'random' ? 'random' : 'sequential',
    selectedWallpaperIds,
  }
  localStorage.setItem(WALLPAPER_ENGINE_ROTATION_STORAGE_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent<WallpaperEngineRotationSettings>(WALLPAPER_ENGINE_ROTATION_EVENT, { detail: normalized }))
  return normalized
}
