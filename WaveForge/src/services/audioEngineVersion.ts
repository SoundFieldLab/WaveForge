/**
 * 音效引擎版本入口
 *
 * 引擎版本号是字符串（如 'v1'/'v2'/'v3'，未来可扩展 'v4'...），由适配层注册表
 * 动态决定哪些可用（见 src/services/audio-engine/）。本模块只管版本号的存取与默认值，
 * 不写死具体有哪些版本——新增引擎无需改此文件。
 *
 * 切换记录在 localStorage，App 启动时据此实例化对应引擎；切换接口提供热切换（暂停音乐后
 * 替换音频图效果链）与冷切换（仅保存配置，下次启动生效）两条路径。
 */

/**
 * 引擎版本号。字符串类型，支持未来扩展（v4/v5...）。
 * 具体可用版本由适配层注册表决定（getAvailableEngines()）。
 */
export type AudioEngineVersion = string

/** 默认引擎版本（注册表的第一个引擎，通常是 v1） */
const DEFAULT_VERSION = 'v1'

const VERSION_KEY = 'waveforge:audio-engine-version'
/** 已移除的旧版 v3（机型预设版）残留存储键：与新 v3（waveforge:v3-*）无关联，顺带清理 */
const LEGACY_V3_STORAGE_KEYS = [
  'waveforge:audio-effects-v3-settings',
  'waveforge:audio-effects-v3-scenes',
]

/**
 * 读取已保存的引擎版本。返回 null 表示未设置（由调用方决定默认值）。
 * 不在此处硬编码默认值——由适配层注册表决定（注册表第一项）。
 */
export function getSavedAudioEngineVersion(): string | null {
  try {
    return localStorage.getItem(VERSION_KEY)
  } catch {
    return null
  }
}

/**
 * 读取引擎版本，带默认值回退。
 * @param availableVersions 适配层注册的可用版本列表（第一个作为默认）
 */
export function getAudioEngineVersion(availableVersions?: string[]): string {
  const saved = getSavedAudioEngineVersion()
  if (saved && (!availableVersions || availableVersions.includes(saved))) {
    // 合法的已保存版本；顺带清掉旧机型预设版 v3 的残留存储
    if (saved === 'v3') {
      try {
        for (const k of LEGACY_V3_STORAGE_KEYS) localStorage.removeItem(k)
      } catch { /* noop */ }
    }
    return saved
  }
  return (availableVersions && availableVersions.length > 0) ? availableVersions[0] : DEFAULT_VERSION
}

export function setAudioEngineVersion(version: AudioEngineVersion): void {
  try {
    localStorage.setItem(VERSION_KEY, version)
  } catch {
    // 忽略存储失败
  }
}
