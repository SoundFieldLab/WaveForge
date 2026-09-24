import { beforeEach, describe, expect, it } from 'vitest'
import {
  addDesktopListeningSeconds,
  clearDesktopMusicActivity,
  getDesktopActivityForPlatform,
  getDesktopSongKey,
  loadDesktopMusicActivity,
  recordDesktopSongStart,
} from '../src/services/desktopMusicActivity'
import type { Song } from '../src/services/musicApi'

const song = (overrides: Partial<Song>): Song => ({
  id: 1,
  name: '测试歌曲',
  artists: [{ name: '测试歌手' }],
  album: { name: '测试专辑', picUrl: '' },
  duration: 180000,
  ...overrides,
})

describe('desktop music activity platform isolation', () => {
  beforeEach(() => localStorage.clear())

  it('prefers Apple library ID, then catalog ID, for activity identity', () => {
    expect(getDesktopSongKey(song({ platform: 'apple', id: 0, appleId: '123', appleLibraryId: 'i.library' }))).toBe('apple:i.library')
    expect(getDesktopSongKey(song({ platform: 'apple', id: 0, appleId: '123' }))).toBe('apple:123')
    expect(getDesktopSongKey(song({ platform: 'netease', id: 123 }))).toBe('netease:123')
  })

  it('keeps history and daily totals separated by song platform', () => {
    const netease = song({ platform: 'netease', id: 1 })
    const apple = song({ platform: 'apple', id: 0, appleId: 'a1' })
    recordDesktopSongStart(netease)
    addDesktopListeningSeconds(netease, 20)
    recordDesktopSongStart(apple)
    addDesktopListeningSeconds(apple, 30)

    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'netease').history).toHaveLength(1)
    expect(getDesktopActivityForPlatform(activity, 'apple').history).toHaveLength(1)
    expect(getDesktopActivityForPlatform(activity, 'netease').days).toEqual(expect.objectContaining({
      [new Date().toLocaleDateString('sv-SE')]: expect.objectContaining({ listenedSeconds: 20, platform: 'netease' }),
    }))
    expect(getDesktopActivityForPlatform(activity, 'apple').days).toEqual(expect.objectContaining({
      [new Date().toLocaleDateString('sv-SE')]: expect.objectContaining({ listenedSeconds: 30, platform: 'apple' }),
    }))
  })

  it('clears only the selected platform activity', () => {
    recordDesktopSongStart(song({ platform: 'netease', id: 1 }))
    recordDesktopSongStart(song({ platform: 'apple', id: 0, appleId: 'a1' }))

    clearDesktopMusicActivity('apple')

    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'apple').history).toEqual([])
    expect(getDesktopActivityForPlatform(activity, 'netease').history).toHaveLength(1)
  })

  it('does not assign legacy unscoped daily totals to Netease', () => {
    localStorage.setItem('desktopMusicActivityV1', JSON.stringify({
      history: [],
      days: { '2026-09-06': { date: '2026-09-06', listenedSeconds: 99, songStarts: 3 } },
      lastSongKey: '',
      lastStartedAt: 0,
    }))
    const activity = loadDesktopMusicActivity()
    expect(getDesktopActivityForPlatform(activity, 'netease').days).toEqual({})
  })
})

describe('desktop music activity days retention', () => {
  beforeEach(() => localStorage.clear())

  it('prunes the oldest day buckets beyond the retention window', () => {
    // 造 500 天记录（历史只保留 200、days 此前无上限）
    const days: Record<string, { date: string; platform: string; listenedSeconds: number; songStarts: number }> = {}
    for (let i = 0; i < 500; i += 1) {
      const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000)
      const key = d.toISOString().slice(0, 10)
      days[`netease:${key}`] = { date: key, platform: 'netease', listenedSeconds: i, songStarts: 1 }
    }
    localStorage.setItem('desktopMusicActivityV1', JSON.stringify({
      history: [], days, lastSongKey: '', lastStartedAt: 0,
    }))

    const activity = loadDesktopMusicActivity()
    const kept = Object.keys(activity.days)
    expect(kept).toHaveLength(400)
    // 最新的保留
    expect(kept).toContain('netease:2025-05-14')
    // 最旧的被裁掉
    expect(kept).not.toContain('netease:2024-01-01')
  })

  it('leaves small day maps untouched', () => {
    localStorage.setItem('desktopMusicActivityV1', JSON.stringify({
      history: [],
      days: { 'netease:2026-09-20': { date: '2026-09-20', platform: 'netease', listenedSeconds: 60, songStarts: 1 } },
      lastSongKey: '', lastStartedAt: 0,
    }))
    const activity = loadDesktopMusicActivity()
    expect(Object.keys(activity.days)).toEqual(['netease:2026-09-20'])
  })
})
