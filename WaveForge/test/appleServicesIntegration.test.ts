import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequest = vi.fn()
const catalogSummary = vi.fn()
const catalogTracks = vi.fn()
const favoriteSongIds = vi.fn()
const addTracks = vi.fn()
const removeTracks = vi.fn()
const createPlaylist = vi.fn()
const updatePlaylist = vi.fn()
const deletePlaylist = vi.fn()
const mutationResult = vi.fn(() => ({ ok: false, status: 500, error: 'mutation failed' }))

vi.mock('../src/services/appleApiBridge', () => ({ appleApiRequest: apiRequest }))
vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({
    developerToken: 'developer-token',
    mediaUserToken: 'media-token',
    storefront: 'jp',
  }),
}))
vi.mock('../src/services/appleMusic', () => ({
  toHighResArtwork: (value: string) => value,
}))
vi.mock('../src/services/appleCatalog', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/appleCatalog')>()
  return {
    ...original,
    getAppleCatalogPlaylistSummary: catalogSummary,
    getAppleCatalogPlaylistTracks: catalogTracks,
    getAppleFavoriteSongIds: favoriteSongIds,
    addAppleTracksToPlaylist: addTracks,
    removeAppleTracksFromPlaylist: removeTracks,
    createApplePlaylist: createPlaylist,
    updateApplePlaylist: updatePlaylist,
    deleteApplePlaylist: deletePlaylist,
    getLastAppleMutationResult: mutationResult,
  }
})
vi.mock('../src/services/indexedDBCache', () => ({
  indexedDBCache: {
    getCachedPlaylist: vi.fn(),
    cachePlaylist: vi.fn(),
    invalidatePlaylist: vi.fn(),
  },
}))

const { fetchAppleRadioPage, fetchHomeRecentlyAdded, appleWebItemToSong } = await import('../src/services/appleWebService')
const {
  addSongToPlaylist,
  createPlaylist: createPlatformPlaylist,
  deletePlaylist: deletePlatformPlaylist,
  getLikedSongs,
  getPlaylistDetail,
  removeSongFromPlaylist,
  subscribePlaylist,
  updatePlaylist: updatePlatformPlaylist,
} = await import('../src/services/playlistService')

describe('Apple service integration', () => {
  beforeEach(() => {
    apiRequest.mockReset()
    catalogSummary.mockReset()
    catalogTracks.mockReset()
    favoriteSongIds.mockReset()
    addTracks.mockReset().mockResolvedValue(true)
    removeTracks.mockReset().mockResolvedValue(true)
    createPlaylist.mockReset().mockResolvedValue(true)
    updatePlaylist.mockReset().mockResolvedValue(true)
    deletePlaylist.mockReset().mockResolvedValue(true)
    mutationResult.mockClear()
  })

  it('normalizes recently-added library resource types and preserves both ids', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [
          {
            id: 'i.song',
            type: 'library-songs',
            attributes: { name: 'Song', artistName: 'Artist' },
            relationships: { catalog: { data: [{ id: '101', type: 'songs' }] } },
          },
          {
            id: 'l.album',
            type: 'library-albums',
            attributes: { name: 'Album', artistName: 'Artist' },
            relationships: { catalog: { data: [{ id: '201', type: 'albums' }] } },
          },
          {
            id: 'p.playlist',
            type: 'library-playlists',
            attributes: { name: 'Playlist', curatorName: 'Me' },
            relationships: { catalog: { data: [{ id: '301', type: 'playlists' }] } },
          },
        ],
      },
    })

    const section = await fetchHomeRecentlyAdded()
    expect(section?.items.map(item => ({
      type: item.type,
      playId: item.playId,
      libraryId: item.libraryId,
      catalogId: item.catalogId,
    }))).toEqual([
      { type: 'songs', playId: '101', libraryId: 'i.song', catalogId: '101' },
      { type: 'albums', playId: '201', libraryId: 'l.album', catalogId: '201' },
      { type: 'playlists', playId: '301', libraryId: 'p.playlist', catalogId: '301' },
    ])
  })

  it('propagates recently-added library ids into playable songs', async () => {
    const song = appleWebItemToSong({
      id: 'i.song',
      playId: '101',
      libraryId: 'i.song',
      catalogId: '101',
      type: 'songs',
      name: 'Song',
      artistName: 'Artist',
    }, 'jp')
    expect(song.appleId).toBe('101')
    expect(song.appleLibraryId).toBe('i.song')
    expect(song.appleStorefront).toBe('jp')
  })

  it('passes the current storefront through Apple playlist details and tracks', async () => {
    catalogSummary.mockResolvedValue({ id: 'pl.1', name: 'Playlist' })
    catalogTracks.mockResolvedValue([{ id: '101', name: 'Song', artistName: 'Artist' }])

    const detail = await getPlaylistDetail('pl.1', 'apple')

    expect(catalogSummary).toHaveBeenCalledWith('pl.1', 'jp')
    expect(catalogTracks).toHaveBeenCalledWith('pl.1', 'jp')
    expect(detail.tracks[0].appleStorefront).toBe('jp')
  })

  it('keeps recent catalog songs out of library identity', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [{
          id: '101',
          type: 'songs',
          attributes: { name: 'Recent Song', artistName: 'Artist' },
        }],
      },
    })

    const { getAppleRecentPlayed, appleSongToSong } = await import('../src/services/appleCatalog')
    const tracks = await getAppleRecentPlayed()
    const song = appleSongToSong(tracks[0])

    expect(song.appleId).toBe('101')
    expect(song.appleLibraryId).toBeUndefined()
    expect(song.appleStorefront).toBe('jp')
  })

  it('uses canonical station ids from editorial show-card links', async () => {
    apiRequest.mockResolvedValue({
      ok: true,
      status: 200,
      data: {
        data: [{
          relationships: {
            tabs: {
              data: [{
                id: 'subscriber',
                relationships: {
                  children: {
                    data: [{
                      id: 'show-container',
                      attributes: { editorialElementKind: '385', name: '节目' },
                      relationships: {
                        children: {
                          data: [{
                            id: 'editorial-card',
                            attributes: {
                              designTag: 'Yeonjun',
                              editorialElementKind: '394',
                              link: { url: '/cn/station/yeonjun/ra.6801240640' },
                            },
                          }],
                        },
                      },
                    }],
                  },
                },
              }],
            },
          },
        }],
      },
    })

    const page = await fetchAppleRadioPage('cn')
    const item = page.sections.find(section => section.kind === 'show-cards')?.items[0]

    expect(item).toEqual(expect.objectContaining({
      id: 'editorial-card',
      type: 'stations',
      playId: 'ra.6801240640',
    }))
    expect(item?.playId).not.toBe('editorial-card')
  })

  it('routes generic playlist mutations to Apple helpers without backend fallthrough', async () => {
    const backendFetch = vi.fn(() => Promise.reject(new Error('unexpected backend request')))
    vi.stubGlobal('fetch', backendFetch)

    await expect(addSongToPlaylist('p.list', '101', '', 'apple')).resolves.toMatchObject({ platform: 'apple' })
    await expect(removeSongFromPlaylist('p.list', 'i.song', '', 'apple')).resolves.toMatchObject({ platform: 'apple' })
    await expect(createPlatformPlaylist('New List', 'apple')).resolves.toMatchObject({ platform: 'apple' })
    await expect(updatePlatformPlaylist('p.list', 'apple', { name: 'Renamed', desc: 'Description' })).resolves.toMatchObject({ platform: 'apple' })
    await expect(deletePlatformPlaylist('p.list', 'apple')).resolves.toMatchObject({ platform: 'apple' })
    await expect(subscribePlaylist('p.list', true, 'apple')).rejects.toThrow('不支持独立的收藏')

    expect(addTracks).toHaveBeenCalledWith('p.list', ['101'])
    expect(removeTracks).toHaveBeenCalledWith('p.list', ['i.song'])
    expect(createPlaylist).toHaveBeenCalledWith('New List')
    expect(updatePlaylist).toHaveBeenCalledWith('p.list', { name: 'Renamed', description: 'Description' })
    expect(deletePlaylist).toHaveBeenCalledWith('p.list')
    expect(backendFetch).not.toHaveBeenCalled()
  })

  it('uses favorites as the Apple liked-song source without playlist-name matching', async () => {
    favoriteSongIds.mockResolvedValue(['101', '102'])

    await expect(getLikedSongs('', 'apple')).resolves.toEqual({ ids: ['101', '102'] })
  })
})
