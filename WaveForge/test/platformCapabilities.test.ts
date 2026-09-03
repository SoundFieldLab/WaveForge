import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from '../src/services/platforms'
import { spotifyTrackToSong } from '../src/services/spotifyService'

describe('platform capability contracts', () => {
  it('exposes only supported playlist operations', () => {
    expect(getPlatformCapabilities('netease')).toMatchObject({ searchPlaylists: true, updatePlaylist: true, deletePlaylist: true, sharePlaylist: true, removeTracksFromPlaylist: true })
    expect(getPlatformCapabilities('qq')).toMatchObject({ searchPlaylists: true, updatePlaylist: false, deletePlaylist: true, sharePlaylist: true, removeTracksFromPlaylist: true })
    expect(getPlatformCapabilities('apple')).toMatchObject({ searchPlaylists: true, updatePlaylist: true, deletePlaylist: true, subscribePlaylist: false, removeTracksFromPlaylist: true })
    expect(getPlatformCapabilities('spotify')).toMatchObject({ searchPlaylists: true, updatePlaylist: true, deletePlaylist: false, sharePlaylist: true, removeTracksFromPlaylist: true })
    expect(getPlatformCapabilities('kugou')).toMatchObject({ searchPlaylists: false, createPlaylist: false, removeTracksFromPlaylist: false })
    expect(getPlatformCapabilities('soda')).toMatchObject({ searchPlaylists: false, createPlaylist: false, removeTracksFromPlaylist: false, recentPlayed: true })
  })

  it('preserves Spotify artist and album identifiers in Song mappings', () => {
    const song = spotifyTrackToSong({
      id: 'track-id',
      name: 'Track',
      artists: [{ id: 'artist-id', name: 'Artist' }],
      album: { id: 'album-id', name: 'Album', images: [{ url: 'cover' }] },
    })
    expect(song.mid).toBe('track-id')
    expect(song.artists[0].mid).toBe('artist-id')
    expect(song.album.mid).toBe('album-id')
  })

  it('preserves Spotify playlist ownership metadata in the shared service', () => {
    const source = readFileSync(new URL('../src/services/playlistService.ts', import.meta.url), 'utf8')
    expect(source).toContain('trackCount: p.tracksTotal ?? 0')
    expect(source).toContain('owner: p.owner')
    expect(source).toContain('ownedByMe: p.ownedByMe')
  })

  it('wires Spotify session expiry into App authentication state', () => {
    const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(source).toContain("window.addEventListener('spotify-session-expired', handleSpotifySessionExpired)")
    expect(source).toContain("setSpotifyUserId(String(result.userId))")
    expect(source).toContain("setSpotifyUserId('')")
  })
})
