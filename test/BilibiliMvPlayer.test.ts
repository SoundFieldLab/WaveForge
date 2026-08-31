import { describe, expect, it } from 'vitest'
import { mvTimeToSongTime, songTimeToMvTime } from '../src/components/BilibiliMvPlayer'

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
})
