import { beforeEach, describe, expect, it, vi } from 'vitest'

const { renameSpotifyPlaylist, spotifyFetch } = await import('../src/services/spotifyService')

describe('Spotify request semantics', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('spotify_access_token', 'token')
    vi.restoreAllMocks()
  })

  it('treats successful empty responses as success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    await expect(spotifyFetch('/me', { method: 'PUT' })).resolves.toEqual({ ok: true })
    await expect(renameSpotifyPlaylist('playlist', 'Renamed')).resolves.toBe(true)
  })
})
