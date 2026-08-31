// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_CHANGED_EVENT, readSyncedPlatform, syncPlatformAcrossViews } from '../src/services/platformSync'

const keys = ['selectedPlatform', 'explorePlatform', 'traditionalPlatform', 'desktopModePlatform']

describe('platformSync', () => {
  beforeEach(() => localStorage.clear())

  it('syncs all four view keys and broadcasts once', () => {
    const listener = vi.fn()
    window.addEventListener(PLATFORM_CHANGED_EVENT, listener)
    syncPlatformAcrossViews('apple')
    expect(keys.map(key => localStorage.getItem(key))).toEqual(['apple', 'apple', 'apple', 'apple'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toBe('apple')
    // Rewriting the same value is a no-op and cannot create an event loop.
    syncPlatformAcrossViews('apple')
    expect(listener).toHaveBeenCalledTimes(1)
    window.removeEventListener(PLATFORM_CHANGED_EVENT, listener)
  })

  it('restores every supported platform across views and respects visibility', () => {
    const all = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda'] as const
    for (const platform of all) {
      localStorage.clear()
      syncPlatformAcrossViews(platform)
      expect(readSyncedPlatform(all, 'selectedPlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'explorePlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'traditionalPlatform')).toBe(platform)
      expect(readSyncedPlatform(all, 'desktopModePlatform')).toBe(platform)
    }
    localStorage.setItem('selectedPlatform', 'spotify')
    expect(readSyncedPlatform(['netease', 'qq'], 'desktopModePlatform')).toBe('netease')
  })

  it('rejects invalid legacy values and uses first visible platform', () => {
    localStorage.setItem('desktopModePlatform', 'legacy-platform')
    expect(readSyncedPlatform(['apple', 'qq'], 'desktopModePlatform')).toBe('apple')
  })
})
