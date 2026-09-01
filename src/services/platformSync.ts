import { MUSIC_PLATFORMS, type MusicPlatform } from './platforms'

/** 四个主视图共享的平台持久化键。 */
const PLATFORM_KEYS = ['selectedPlatform', 'explorePlatform', 'traditionalPlatform', 'desktopModePlatform'] as const
export const PLATFORM_CHANGED_EVENT = 'waveforge-platform-changed'

export function isMusicPlatform(value: unknown): value is MusicPlatform {
  return typeof value === 'string' && (MUSIC_PLATFORMS as readonly string[]).includes(value)
}

/**
 * 从四视图任一历史键恢复平台，并立即按当前可见平台归一化。
 * preferredKey 优先，避免旧视图残留值覆盖最近一次全局选择。
 */
export function readSyncedPlatform(
  visiblePlatforms: readonly MusicPlatform[],
  preferredKey: typeof PLATFORM_KEYS[number],
): MusicPlatform {
  const order = [preferredKey, ...PLATFORM_KEYS.filter(key => key !== preferredKey)]
  for (const key of order) {
    const value = localStorage.getItem(key)
    if (isMusicPlatform(value) && visiblePlatforms.includes(value)) return value
  }
  return visiblePlatforms[0] || 'netease'
}

/** 任一视图切换平台时同步所有视图并广播给短暂并存/常驻消费者。 */
export function syncPlatformAcrossViews(platform: MusicPlatform): void {
  if (!isMusicPlatform(platform)) return
  let changed = false
  for (const key of PLATFORM_KEYS) {
    try {
      if (localStorage.getItem(key) !== platform) {
        localStorage.setItem(key, platform)
        changed = true
      }
    } catch { /* 存储不可用时忽略 */ }
  }
  if (changed) {
    try { window.dispatchEvent(new CustomEvent<MusicPlatform>(PLATFORM_CHANGED_EVENT, { detail: platform })) } catch { /* 忽略 */ }
  }
}
