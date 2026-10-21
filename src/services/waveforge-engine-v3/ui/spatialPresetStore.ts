/**
 * 我的空间方案：把 SpatialSettings 快照保存在本机，用于快速切回/对比。
 * 只存空间设置，不进入全局场景快照；数据完全本地，不上传。
 */
import type { SpatialSettings } from '../src/types'

const STORAGE_KEY = 'waveforge:hse-spatial-presets'
const MAX_PRESETS = 20

export interface SpatialPreset {
  id: string
  name: string
  createdAt: number
  settings: SpatialSettings
}

function readRaw(): unknown {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

/** 损坏/旧版本数据按空列表处理，避免整个页面因一个坏字段崩掉。 */
export function loadSpatialPresets(): SpatialPreset[] {
  const raw = readRaw()
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is SpatialPreset => {
    if (!item || typeof item !== 'object') return false
    const value = item as Partial<SpatialPreset>
    return typeof value.id === 'string' && typeof value.name === 'string'
      && typeof value.createdAt === 'number' && !!value.settings && typeof value.settings === 'object'
  }).slice(0, MAX_PRESETS)
}

function writePresets(presets: SpatialPreset[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.slice(0, MAX_PRESETS))) }
  catch { /* 隐私模式/配额满时仅本次不持久化 */ }
}

export function saveSpatialPreset(name: string, settings: SpatialSettings): SpatialPreset[] {
  const presets = loadSpatialPresets()
  const preset: SpatialPreset = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim().slice(0, 40) || `空间方案 ${presets.length + 1}`,
    createdAt: Date.now(),
    settings: JSON.parse(JSON.stringify(settings)) as SpatialSettings,
  }
  const next = [preset, ...presets].slice(0, MAX_PRESETS)
  writePresets(next)
  return next
}

export function deleteSpatialPreset(id: string): SpatialPreset[] {
  const next = loadSpatialPresets().filter((preset) => preset.id !== id)
  writePresets(next)
  return next
}
