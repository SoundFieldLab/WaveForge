import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearNeteaseRecentCache,
  fetchNeteaseRecentSongs,
  getNeteaseArtwork,
  normalizeNeteaseRecentSong,
} from '../src/services/neteaseRecentPlayback'

afterEach(() => {
  clearNeteaseRecentCache()
  vi.restoreAllMocks()
})

describe('netease recent playback mapping', () => {
  it('normalizes nested album artwork variants', () => {
    const raw = {
      resource: {
        song: {
          id: 123,
          name: 'Test song',
          ar: [{ id: 1, name: 'Artist' }],
          al: { name: 'Album', picurl: 'https://p1.music.126.net/a.jpg' },
        },
      },
    }
    expect(getNeteaseArtwork(raw)).toBe('https://p1.music.126.net/a.jpg')
    expect(normalizeNeteaseRecentSong(raw)?.album.picUrl).toBe('https://p1.music.126.net/a.jpg')
  })

  it('shares a short-lived request for the same account and limit', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { list: [{ resource: { id: 1, name: 'Song', al: { picUrl: 'https://p1.music.126.net/a.jpg' } } }] },
    }), { status: 200 }))

    const [first, second] = await Promise.all([
      fetchNeteaseRecentSongs('cookie-a', 100),
      fetchNeteaseRecentSongs('cookie-a', 100),
    ])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(first.songs[0]?.album.picUrl).toBe('https://p1.music.126.net/a.jpg')
    expect(second.total).toBe(1)
  })

  it('isolates different account cookies', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => new Response(JSON.stringify({
      data: { list: [{ resource: { id: String(url).includes('cookie-a') ? 1 : 2, name: 'Song', al: { picUrl: 'https://p1.music.126.net/a.jpg' } } }] },
    }), { status: 200 }))

    const first = await fetchNeteaseRecentSongs('cookie-a', 100)
    const second = await fetchNeteaseRecentSongs('cookie-b', 100)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(first.songs[0]?.id).toBe(1)
    expect(second.songs[0]?.id).toBe(2)
  })
})
