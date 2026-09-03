import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchAppleCatalogV1 = vi.fn()

vi.mock('../src/services/appleCatalog', () => ({
  searchAppleCatalogV1,
}))

vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({ storefront: 'jp' }),
}))

const { searchPlaylists } = await import('../src/services/musicApi')

describe('platform playlist search', () => {
  beforeEach(() => {
    searchAppleCatalogV1.mockReset()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected backend request'))))
  })

  it('maps Apple catalog playlists without calling the NetEase backend', async () => {
    searchAppleCatalogV1.mockResolvedValue({
      songs: [],
      albums: [],
      artists: [],
      playlists: [{
        id: 'pl.catalog',
        name: 'Apple Essentials',
        artworkUrl: 'https://example.test/cover.jpg',
        trackCount: 42,
        curatorName: 'Apple Music',
      }],
    })

    await expect(searchPlaylists('Aimer', 'apple', 20)).resolves.toEqual({
      playlists: [{
        id: 'pl.catalog',
        name: 'Apple Essentials',
        coverImgUrl: 'https://example.test/cover.jpg',
        trackCount: 42,
        creator: 'Apple Music',
        platform: 'apple',
      }],
    })
    expect(searchAppleCatalogV1).toHaveBeenCalledWith('Aimer', 'jp', 20)
    expect(fetch).not.toHaveBeenCalled()
  })
})
