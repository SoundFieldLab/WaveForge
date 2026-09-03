/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PlaylistCarousel3D from '../src/components/PlaylistCarousel3D'

vi.mock('../src/platform', () => ({ isTvModeActive: () => false }))
vi.mock('../src/tv/tvCore', () => ({
  setTvFocus: vi.fn(),
  useTvFocus: () => null,
}))

afterEach(cleanup)

describe('Desktop playlist carousel', () => {
  it('passes the selected playlist platform through unchanged', () => {
    const onPlaylistSelect = vi.fn()
    const playlist = {
      id: 'spotify-playlist',
      name: 'Spotify Mix',
      coverImgUrl: 'https://example.test/cover.jpg',
      platform: 'spotify' as const,
      ownedByMe: true,
    }

    render(
      <PlaylistCarousel3D
        playlists={[playlist]}
        platform="netease"
        onPlaylistSelect={onPlaylistSelect}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Spotify Mix' }))
    expect(onPlaylistSelect).toHaveBeenCalledWith(playlist)
  })
})
