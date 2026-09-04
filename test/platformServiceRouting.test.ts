import { beforeEach, describe, expect, it, vi } from 'vitest'

const searchSpotifyPlaylists = vi.fn()
const fetchSpotifyAlbum = vi.fn()
const fetchSpotifyArtistTopTracks = vi.fn()
const spotifyTrackToSong = vi.fn((track: any) => ({
  id: 1,
  mid: track.id,
  name: track.name,
  artists: track.artists || [],
  album: track.album || { name: '', picUrl: '' },
  duration: 0,
  platform: 'spotify',
}))
const fetchSodaAlbumTracks = vi.fn()
const fetchSodaArtistSongs = vi.fn()

vi.mock('../src/services/spotifyService', () => ({
  searchSpotifyPlaylists,
  fetchSpotifyAlbum,
  fetchSpotifyArtistTopTracks,
  spotifyTrackToSong,
}))
vi.mock('../src/services/sodaService', () => ({
  fetchSodaAlbumTracks,
  fetchSodaArtistSongs,
}))

const { getAlbumDetail, getAlbumSongs, getArtistAllSongs, searchPlaylists } = await import('../src/services/musicApi')

describe('cross-platform service routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unexpected legacy request'))))
  })

  it('normalizes Spotify playlist search without legacy backend requests', async () => {
    searchSpotifyPlaylists.mockResolvedValue([{ id: 'sp-list', name: 'Mix', coverUrl: 'cover', tracksTotal: 12, owner: 'owner' }])
    await expect(searchPlaylists('mix', 'spotify')).resolves.toEqual({ playlists: [{
      id: 'sp-list', name: 'Mix', coverImgUrl: 'cover', trackCount: 12, creator: 'owner', platform: 'spotify',
    }] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['kugou', 'soda'] as const)('marks %s playlist search unsupported', async platform => {
    await expect(searchPlaylists('mix', platform)).resolves.toEqual({ playlists: [], unsupported: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes Spotify album tracks through Spotify services', async () => {
    fetchSpotifyAlbum.mockResolvedValue({ songs: [{ id: 'track', name: 'Song', artists: [{ name: 'Artist', id: 'artist' }], album: { id: 'album', name: 'Album' } }] })
    const songs = await getAlbumSongs('album', 'spotify')
    expect(fetchSpotifyAlbum).toHaveBeenCalledWith('album')
    expect(songs[0]).toMatchObject({ mid: 'track', platform: 'spotify' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('routes Soda album and artist details through Soda services', async () => {
    fetchSodaAlbumTracks.mockResolvedValue({ album: { id: '42', name: 'Album', coverUrl: 'cover' }, tracks: [{ name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album', picUrl: 'cover' } }] })
    fetchSodaArtistSongs.mockResolvedValue([{ name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album', picUrl: 'cover' } }])
    await expect(getAlbumDetail('42', 'soda')).resolves.toMatchObject({ mid: '42', name: 'Album', platform: 'soda' })
    await expect(getArtistAllSongs('Artist', 'soda', 0, 20)).resolves.toMatchObject({ total: 1 })
    expect(fetch).not.toHaveBeenCalled()
  })
})
