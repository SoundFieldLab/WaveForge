import { describe, expect, it } from 'vitest'
import { mvTimeToSongTime, songTimeToMvTime, syncWatchVideoOnSurfaceRestore } from '../src/components/BilibiliMvPlayer'

describe('BilibiliMvPlayer signed watch timeline', () => {
  it('maps positive MV intro offsets in both directions', () => {
    expect(songTimeToMvTime(30, 4)).toBe(34)
    expect(mvTimeToSongTime(34, 4)).toBe(30)
  })

  it('preserves negative offsets instead of clamping their sign', () => {
    expect(songTimeToMvTime(30, -3)).toBe(27)
    expect(mvTimeToSongTime(27, -3)).toBe(30)
  })

  it('round-trips arbitrary signed offsets', () => {
    for (const offset of [-19.89, -0.5, 0, 0.5, 19.89]) {
      expect(mvTimeToSongTime(songTimeToMvTime(42.25, offset), offset)).toBeCloseTo(42.25, 10)
    }
  })

  it('performs one clamped video sync when the watch surface is restored', () => {
    const video = { duration: 60, currentTime: 0 } as HTMLVideoElement
    const audio = { currentTime: 75 } as HTMLAudioElement

    expect(syncWatchVideoOnSurfaceRestore(video, audio)).toBe(true)
    expect(video.currentTime).toBe(59.5)
  })

  it('does not seek without a usable audio clock', () => {
    const video = { duration: 60, currentTime: 12 } as HTMLVideoElement

    expect(syncWatchVideoOnSurfaceRestore(video, null)).toBe(false)
    expect(video.currentTime).toBe(12)
  })
})
