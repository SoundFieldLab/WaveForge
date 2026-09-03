import { beforeEach, describe, expect, it, vi } from 'vitest'

const invalidatePlaylist = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    invalidatePlaylist,
    getCachedPlaylist: vi.fn(),
    cachePlaylist: vi.fn(),
  },
}))

const { getArtistAllSongs } = await import('../src/services/musicApi')
const { invalidateUserPlaylistsCache } = await import('../src/services/playlistService')

describe('platform pagination and cache contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('forwards QQ artist offsets to the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ songs: [], total: 80 }) })
    vi.stubGlobal('fetch', fetchMock)
    await getArtistAllSongs('artist-mid', 'qq', 40, 40)
    expect(String(fetchMock.mock.calls[0][0])).toContain('offset=40')
  })

  it('invalidates token-driven Spotify caches without a numeric user id', async () => {
    localStorage.setItem('spotify_access_token', 'token')
    invalidateUserPlaylistsCache('spotify', '')
    expect(invalidatePlaylist).toHaveBeenCalledTimes(1)
    expect(String(invalidatePlaylist.mock.calls[0][0])).toContain('spotify-session')
  })
})
