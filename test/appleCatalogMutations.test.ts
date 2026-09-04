import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequest = vi.fn()

vi.mock('../src/services/appleApiBridge', () => ({
  appleApiRequest: apiRequest,
}))

vi.mock('../src/services/appleAuth', () => ({
  AMP_API: 'https://amp-api.music.apple.com/v1',
  forwardToBackend: vi.fn(),
  getAppleCredentials: () => ({
    developerToken: 'developer-token',
    mediaUserToken: 'media-token',
    storefront: 'cn',
  }),
}))

vi.mock('../src/services/musicApi', () => ({
  searchSongs: vi.fn(),
}))

vi.mock('../src/services/appleMusic', () => ({
  searchAppleTracks: vi.fn(),
  toHighResArtwork: (value: string) => value.replace('{w}x{h}', '300x300'),
}))

const catalog = await import('../src/services/appleCatalog')

const resource = (id: string, name: string, catalogId?: string) => ({
  id,
  type: 'library-songs',
  attributes: { name, artistName: 'Artist', albumName: 'Album' },
  relationships: catalogId ? { catalog: { data: [{ id: catalogId, type: 'songs' }] } } : undefined,
})

describe('Apple catalog mutations', () => {
  beforeEach(() => apiRequest.mockReset())

  it('removes playlist tracks as catalog songs when a catalog id is available', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 204, data: null })

    await expect(catalog.removeAppleTracksFromPlaylist('p.playlist', [{
      catalogId: '12345',
      libraryId: 'i.library',
    }])).resolves.toBe(true)

    expect(apiRequest).toHaveBeenCalledWith('/v1/me/library/playlists/p.playlist/tracks', expect.objectContaining({
      method: 'DELETE',
      body: { data: [{ id: '12345', type: 'songs' }] },
    }))
  })

  it('resolves library ids before removal and falls back to library-songs for uploads', async () => {
    apiRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [resource('i.catalogued', 'Song', '67890')] } })
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [resource('i.uploaded', 'Upload')] } })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })

    await expect(catalog.removeAppleTracksFromPlaylist('p.playlist', ['i.catalogued', 'i.uploaded'])).resolves.toBe(true)

    expect(apiRequest.mock.calls[2][1]).toEqual(expect.objectContaining({
      method: 'DELETE',
      body: { data: [
        { id: '67890', type: 'songs' },
        { id: 'i.uploaded', type: 'library-songs' },
      ] },
    }))
  })

  it('adds uploaded tracks as library-songs when no catalog relation exists', async () => {
    apiRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [resource('i.uploaded', 'Upload')] } })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })

    await expect(catalog.addAppleTracksToPlaylist('p.playlist', [{ libraryId: 'i.uploaded' }])).resolves.toBe(true)

    expect(apiRequest.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: 'POST',
      body: { data: [{ id: 'i.uploaded', type: 'library-songs' }] },
    }))
  })

  it('creates a library playlist with top-level attributes', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 201, data: {} })
    await expect(catalog.createApplePlaylist('Road Trip', 'Weekend')).resolves.toBe(true)
    expect(apiRequest).toHaveBeenCalledWith('/v1/me/library/playlists', expect.objectContaining({
      method: 'POST',
      body: { attributes: { name: 'Road Trip', description: 'Weekend' } },
    }))
  })

  it('does not fall back to ratings for authentication or transient failures', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 401, data: { errors: [{ title: 'Unauthorized' }] } })
    await expect(catalog.setAppleSongLoved('12345', true)).resolves.toBe(false)
    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('falls back to ratings only when favorites is unsupported', async () => {
    apiRequest
      .mockResolvedValueOnce({ ok: false, status: 404, data: { errors: [{ title: 'Not Found' }] } })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
    await expect(catalog.setAppleSongLoved('12345', true)).resolves.toBe(true)
    expect(apiRequest).toHaveBeenCalledTimes(2)
    expect(apiRequest.mock.calls[1][0]).toBe('/v1/me/ratings/songs/12345')
  })

  it('reports AMP search failures so callers can fall back', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 503, data: null })
    await expect(catalog.searchAppleCatalogV1('Aimer', 'jp')).resolves.toEqual(expect.objectContaining({ errorStatus: 503 }))
  })

  it('uses favorites for loved songs without adding them to the library', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 204, data: null })
    await expect(catalog.setAppleSongLoved('12345', true)).resolves.toBe(true)
    expect(apiRequest).toHaveBeenCalledTimes(1)
    expect(apiRequest).toHaveBeenCalledWith('/v1/me/favorites?ids[songs]=12345', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('does not request unsupported stations in search or suggestions', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { results: {}, data: [] } })

    await catalog.searchAppleCatalogV1('test', 'jp')
    await catalog.getAppleSearchSuggestions('test', 'jp')

    expect(apiRequest).toHaveBeenCalledTimes(2)
    for (const [path] of apiRequest.mock.calls) {
      expect(path).toContain('types=songs,albums,artists,playlists')
      expect(path).not.toContain('stations')
    }
  })

  it('loads favorite songs as ordered catalog resources with storefront identity', async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [
          { id: 'fav.1', relationships: { resource: { data: [{ id: '102', type: 'songs' }] } } },
          { id: 'fav.2', relationships: { resource: { data: [{ id: '101', type: 'songs' }] } } },
        ] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [
          { id: '101', type: 'songs', attributes: { name: 'First', artistName: 'Artist' } },
          { id: '102', type: 'songs', attributes: { name: 'Second', artistName: 'Artist' } },
        ] },
      })

    const songs = await catalog.getAppleFavoriteSongs(100, 'jp')

    expect(songs.map(song => song.id)).toEqual(['102', '101'])
    expect(songs.every(song => song.storefront === 'jp')).toBe(true)
    expect(apiRequest.mock.calls[1][0]).toContain('/v1/catalog/jp/songs?ids=102%2C101')
  })

  it('preserves catalog artist and album relationships for library tracks', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [{
          id: 'i.song',
          type: 'library-songs',
          attributes: { name: 'Song', artistName: 'Artist', albumName: 'Album' },
          relationships: { catalog: { data: [{ id: '101', type: 'songs' }] } },
        }],
        included: [{
          id: '101',
          type: 'songs',
          attributes: { name: 'Song', artistName: 'Artist', albumName: 'Album' },
          relationships: {
            artists: { data: [{ id: 'artist.1', type: 'artists' }] },
            albums: { data: [{ id: 'album.1', type: 'albums' }] },
          },
        }],
      },
    })

    const tracks = await catalog.getAppleLibrarySongs(10)
    const song = catalog.appleLibraryTrackToSong(tracks[0])

    expect(song.artists[0].appleId).toBe('artist.1')
    expect(song.album.appleId).toBe('album.1')
  })

  it('resolves a catalog id before removing a song from the library', async () => {
    apiRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: { data: [resource('i.library', 'Song', '12345')] } })
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })

    await expect(catalog.removeAppleSongFromLibrary('12345')).resolves.toBe(true)
    expect(apiRequest.mock.calls[0][0]).toContain('filter[catalog-id]=12345')
    expect(apiRequest.mock.calls[1][0]).toBe('/v1/me/library/songs/i.library')
    expect(apiRequest.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'DELETE' }))
  })
})

describe('Apple catalog pagination', () => {
  beforeEach(() => apiRequest.mockReset())

  const catalogResource = (id: string, type: string, name: string) => ({
    id,
    type,
    attributes: {
      name,
      artistName: 'Artist',
      artwork: { url: 'https://example.test/{w}x{h}bb.jpg' },
    },
  })

  it.each([
    ['playlist tracks', () => catalog.getAppleCatalogPlaylistTracks('pl.1', 'jp', 3), 'songs'],
    ['artist albums', () => catalog.getAppleCatalogArtistAlbums('artist.1', 'jp', 3), 'albums'],
    ['artist videos', () => catalog.getAppleCatalogArtistMusicVideos('artist.1', 'jp', 3), 'music-videos'],
  ])('follows next links and deduplicates %s', async (_label, load, type) => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: [catalogResource('1', type, 'One'), catalogResource('2', type, 'Two')],
          next: `https://amp-api.music.apple.com/v1/catalog/jp/${type}?offset=2`,
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [catalogResource('2', type, 'Two'), catalogResource('3', type, 'Three')] },
      })

    const result = await load()
    expect(result.map(item => item.id)).toEqual(['1', '2', '3'])
    expect(apiRequest.mock.calls[1][0]).toBe(`/v1/catalog/jp/${type}?offset=2`)
  })

  it('reads favorite songs across pages and deduplicates ids', async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: [{ id: '101' }, { id: '102' }],
          next: '/v1/me/favorites/songs?offset=2',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ id: '102' }, { id: '103' }] },
      })

    await expect(catalog.getAppleFavoriteSongIds()).resolves.toEqual(['101', '102', '103'])
  })
})

describe('Apple library pagination and identities', () => {
  beforeEach(() => apiRequest.mockReset())

  it('follows next links and preserves catalog and library song ids', async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: [resource('i.one', 'One', '101')],
          next: '/v1/me/library/songs?offset=1&limit=1',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [resource('i.two', 'Two', '102')] },
      })

    const tracks = await catalog.getAppleLibrarySongs(2)
    expect(tracks.map(track => [track.id, track.catalogId])).toEqual([
      ['i.one', '101'],
      ['i.two', '102'],
    ])
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('paginates recent playback to the requested limit', async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          data: [{ id: '101', type: 'songs', attributes: { name: 'One', artistName: 'Artist' } }],
          next: '/v1/me/recent/played/tracks?offset=1&limit=1',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ id: '102', type: 'songs', attributes: { name: 'Two', artistName: 'Artist' } }] },
      })

    const tracks = await catalog.getAppleRecentPlayed(2)
    expect(tracks.map(track => track.id)).toEqual(['101', '102'])
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('maps catalog artist ids and artwork from included resources', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [{
          id: 'r.library-artist',
          type: 'library-artists',
          attributes: { name: 'Aimer' },
          relationships: { catalog: { data: [{ id: '3000', type: 'artists' }] } },
        }],
        included: [{
          id: '3000',
          type: 'artists',
          attributes: { name: 'Aimer', artwork: { url: 'https://example.test/{w}x{h}bb.jpg' } },
        }],
      },
    })

    const artists = await catalog.getAppleLibraryArtists(20)
    expect(artists[0]).toEqual(expect.objectContaining({
      id: 'r.library-artist',
      catalogId: '3000',
      name: 'Aimer',
    }))
    expect(artists[0].artworkUrl).toContain('300x300bb.jpg')
  })
})
