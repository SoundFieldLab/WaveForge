import { describe, expect, it } from 'vitest'
import { createSongOwnedHandoff, readSongOwnedHandoff } from '../src/services/watchHandoff'

describe('watch handoff song ownership', () => {
  it('returns the handoff only for the song that created it', () => {
    const handoff = createSongOwnedHandoff('qq:previous', 122.8)

    expect(readSongOwnedHandoff(handoff, 'qq:previous', 0)).toBe(122.8)
    expect(readSongOwnedHandoff(handoff, 'qq:breezy', 0)).toBe(0)
  })

  it('rejects a previous-song MV when the watch player advances tracks', () => {
    const previousVideo = createSongOwnedHandoff('qq:previous', {
      bvid: 'BVPrevious',
      videoUrl: 'http://stream/previous',
    })

    expect(readSongOwnedHandoff(previousVideo, 'qq:breezy', null)).toBeNull()
  })
})
