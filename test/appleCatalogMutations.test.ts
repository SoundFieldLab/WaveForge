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

  /**
   * 回归：联想接口**必须带 kinds**。
   *
   * 官网抓包实测 amp-api-edge `/v1/catalog/{sf}/search/suggestions` 用
   * `kinds=terms,topResults`；此前只发 types=…，服务端直接 400
   *（"One or more kinds must be specified"），联想词永远为空。
   */
  it('联想请求带 kinds=terms,topResults（缺了会 400，联想永远为空）', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { results: { suggestions: [] } } })
    await catalog.getAppleSearchSuggestionItems('我', 'cn')
    expect(apiRequest).toHaveBeenCalledTimes(1)
    const [path] = apiRequest.mock.calls[0]
    expect(path).toContain('kinds=terms,topResults')
  })

  it('解析联想响应：terms 取建议词、topResults 带类型/资源 id/封面', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        results: {
          suggestions: [
            { kind: 'terms', searchTerm: '我不难过', displayTerm: '我不难过' },
            { kind: 'terms', searchTerm: '我好想你', displayTerm: '我好想你' },
            {
              kind: 'topResults',
              content: {
                id: '255921025',
                type: 'songs',
                attributes: {
                  name: '我不难过',
                  artistName: '孙燕姿',
                  artwork: { url: 'https://is1-ssl.mzstatic.com/image/thumb/x/{w}x{h}bb.jpg' },
                },
              },
            },
          ],
        },
      },
    })

    const items = await catalog.getAppleSearchSuggestionItems('我', 'cn')
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({ kind: 'terms', term: '我不难过' })
    expect(items[2]).toMatchObject({
      kind: 'topResults',
      term: '我不难过',
      type: 'songs',
      id: '255921025',
      subtitle: '孙燕姿',
    })
    // 封面走 toHighResArtwork（见上方 mock，替换为 300x300）
    expect(items[2].artworkUrl).toContain('300x300')
  })

  it('兼容旧调用只返回建议词（不含 topResults）', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        results: {
          suggestions: [
            { kind: 'terms', displayTerm: '关键词一' },
            { kind: 'topResults', content: { id: '1', type: 'songs', attributes: { name: '某歌' } } },
          ],
        },
      },
    })
    await expect(catalog.getAppleSearchSuggestions('x', 'cn')).resolves.toEqual(['关键词一'])
  })

  // 「喜爱歌曲」读取已改为走资料库歌单（实测 favorites 读取端点恒 404，
  // 详见 appleFavoriteSongsRead.test.ts 的说明）。此用例保留原有意图：
  // 顺序保持、目录资源解析、storefront 归属正确。
  it('loads favorite songs as ordered catalog resources with storefront identity', async () => {
    apiRequest
      // 1) 资料库歌单列表：找到「喜爱歌曲」
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ id: 'p.LOVED', type: 'library-playlists', attributes: { name: '喜爱歌曲' } }] },
      })
      // 2) 该歌单的曲目（顺序即喜爱顺序）
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [
          { id: 'i.1', type: 'library-songs', attributes: { name: 'Second' }, relationships: { catalog: { data: [{ id: '102', type: 'songs' }] } } },
          { id: 'i.2', type: 'library-songs', attributes: { name: 'First' }, relationships: { catalog: { data: [{ id: '101', type: 'songs' }] } } },
        ] },
      })
      // 3) 目录补全
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
    const catalogCall = apiRequest.mock.calls.find(call => String(call[0]).includes('/v1/catalog/jp/songs?ids='))
    expect(catalogCall?.[0]).toContain('/v1/catalog/jp/songs?ids=102%2C101')
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

  it('uses included catalog artwork when a library playlist has no artwork', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [{
          id: 'library.playlist',
          type: 'library-playlists',
          attributes: { name: 'Road Trip' },
          relationships: { catalog: { data: [{ id: 'catalog.playlist', type: 'playlists' }] } },
        }],
        included: [{
          id: 'catalog.playlist',
          type: 'playlists',
          attributes: { artwork: { url: 'https://example.test/{w}x{h}bb.jpg' } },
        }],
      },
    })

    await expect(catalog.getAppleLibraryPlaylists(10)).resolves.toEqual([
      expect.objectContaining({
        id: 'library.playlist',
        catalogId: 'catalog.playlist',
        artworkUrl: 'https://example.test/300x300bb.jpg',
      }),
    ])
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
    expect(apiRequest.mock.calls[0][1]).toEqual(expect.objectContaining({
      developerToken: 'developer-token',
      mediaUserToken: 'media-token',
    }))
    expect(apiRequest.mock.calls[1][0]).toBe(`/v1/catalog/jp/${type}?offset=2`)
  })

  it('marks a collection-only album response as incomplete instead of a zero-track success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{
          wrapperType: 'collection',
          collectionId: 201,
          collectionName: 'Album',
          artistName: 'Artist',
          trackCount: 12,
        }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(catalog.getAppleAlbumDetail('201', 'jp')).resolves.toMatchObject({
      album: { id: '201', name: 'Album' },
      tracks: [],
      incomplete: true,
    })
    vi.unstubAllGlobals()
  })

  it('requests playlist tracks without relationship expansion that stalls Apple AMP', async () => {
    apiRequest.mockResolvedValue({ ok: true, status: 200, data: { data: [] } })

    await catalog.getAppleCatalogPlaylistTracks('pl.personal', 'cn', 100)

    expect(apiRequest.mock.calls[0][0]).toBe('/v1/catalog/cn/playlists/pl.personal/tracks?limit=100')
    expect(apiRequest.mock.calls[0][0]).not.toContain('include=')
  })

  it('propagates catalog playlist request failures instead of returning an empty list', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 401, data: null })
    await expect(catalog.getAppleCatalogPlaylistTracks('pl.1', 'jp')).rejects.toMatchObject({ status: 401 })
  })

  it('distinguishes an unavailable favorites endpoint from an empty favorite list', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 404, data: { errors: [{ title: 'Not Found' }] } })
    await expect(catalog.getAppleFavoriteSongIds()).resolves.toBeNull()
  })

  // 「喜爱歌曲」现走资料库歌单的 tracks 接口（该接口自身分页由 fetchAppleMePages 处理）。
  // 此用例保留原有意图：跨批去重，且只回传数字目录 id。
  it('reads favorite songs from the liked playlist and deduplicates ids', async () => {
    apiRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [{ id: 'p.LOVED', type: 'library-playlists', attributes: { name: '喜爱歌曲' } }] },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { data: [
          { id: 'i.1', attributes: { name: 'A' }, relationships: { catalog: { data: [{ id: '101', type: 'songs' }] } } },
          { id: 'i.2', attributes: { name: 'B' }, relationships: { catalog: { data: [{ id: '102', type: 'songs' }] } } },
          // 同曲重复 + 非数字 id（应被丢弃）
          { id: 'i.3', attributes: { name: 'A2' }, relationships: { catalog: { data: [{ id: '102', type: 'songs' }] } } },
          { id: 'i.4', attributes: { name: 'Local' }, relationships: { catalog: { data: [] } } },
        ] },
      })

    await expect(catalog.getAppleFavoriteSongIds()).resolves.toEqual(['101', '102'])
  })
})

describe('Apple library pagination and identities', () => {
  beforeEach(() => apiRequest.mockReset())

  it('propagates library playlist request failures instead of returning an empty list', async () => {
    apiRequest.mockResolvedValue({ ok: false, status: 403, data: null })
    await expect(catalog.getApplePlaylistTracks('p.library')).rejects.toMatchObject({ status: 403 })
  })

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
