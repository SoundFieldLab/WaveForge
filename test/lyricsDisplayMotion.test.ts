import { describe, expect, it } from 'vitest'
import { getAppleLyricLineMotion } from '../src/components/LyricsDisplay'

describe('getAppleLyricLineMotion', () => {
  it('keeps the current line fully visible and settled', () => {
    expect(getAppleLyricLineMotion('current', 0)).toEqual({
      opacity: 1,
      scale: 1,
      y: 0,
      blur: 0,
    })
  })

  it('releases the played line upward with less emphasis', () => {
    expect(getAppleLyricLineMotion('played', 1)).toEqual({
      opacity: 0.46,
      scale: 0.965,
      y: -2,
      blur: 1.4,
    })
  })

  it('stages the upcoming line below the focus position', () => {
    expect(getAppleLyricLineMotion('upcoming', 1)).toEqual({
      opacity: 0.66,
      scale: 0.98,
      y: 3,
      blur: 0.9,
    })
  })

  it('keeps distant lines stable and distinguishes played from upcoming', () => {
    expect(getAppleLyricLineMotion('played', 3)).toEqual({
      opacity: 0.3,
      scale: 0.955,
      y: 0,
      blur: 2.6,
    })
    expect(getAppleLyricLineMotion('upcoming', 3)).toEqual({
      opacity: 0.38,
      scale: 0.97,
      y: 0,
      blur: 2.2,
    })
  })

  it('uses a clear, settled browsing state during manual scrolling', () => {
    expect(getAppleLyricLineMotion('played', 1, true)).toEqual({
      opacity: 0.72,
      scale: 1,
      y: 0,
      blur: 0,
    })
    expect(getAppleLyricLineMotion('current', 0, true).opacity).toBe(1)
  })
})
