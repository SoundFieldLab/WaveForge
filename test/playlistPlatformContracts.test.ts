import { beforeEach, describe, expect, it, vi } from 'vitest'

const invalidatePlaylist = vi.fn().mockResolvedValue(undefined)
const clearPlaylistsForPlatform = vi.fn().mockResolvedValue(undefined)
vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    invalidatePlaylist,
    clearPlaylistsForPlatform,
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
    // 失效升级为按平台整组清理：调用方传的 userId 形态不一（真实 id / 空 → session 键），
    // 只删单键会漏掉并存的其他形态键。platform 维度即完整失效。
    expect(clearPlaylistsForPlatform).toHaveBeenCalledWith('spotify')
  })
})
