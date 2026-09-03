import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8')

describe('Explore mode wiring regressions', () => {
  it('bypasses the hidden legacy Apple payload pipeline', () => {
    const source = component('ExploreView.tsx')
    expect(source.replace(/\r\n/g, '\n')).toContain("if (platform === 'apple') {\n      setLoading(false)\n      setError('')\n      return")
    expect(source).toContain('onOpenPlaylistPanel={handleApplePlaylist}')
  })

  it('guards Apple tab refreshes and supports catalog playlist removal', () => {
    const source = component('AppleExplorePanel.tsx')
    expect(source).toContain('++pageRequestRef.current[target]')
    expect(source).toContain('pageRequestRef.current[target] !== requestId')
    expect(source).toContain("if (appleLoggedIn) void loadTab('library')")
    expect(source).toContain('removeApplePlaylistFromLibrary(libraryId)')
    expect(source).toContain('removeAppleSongFromLibrary(item.playId)')
    expect(source).toContain('setSavedPlaylists(new Set())')
    expect(source).toContain('setCatalogLibraryIds(new Map())')
    expect(source).toContain("item.type === 'music-videos'")
    expect(source).toContain('disabled={isLibrarySaved}')
    expect(source).toContain('data-tv-scope')
  })

  it('preserves nested Apple Explore playback origins', () => {
    const panel = component('AppleExplorePanel.tsx')
    const view = component('ExploreView.tsx')
    expect(panel).toContain("surface: 'explore-apple'")
    expect(panel).toContain("drawerType: 'station'")
    expect(panel).toContain("drawerType: 'album'")
    expect(panel).toContain("drawerType: 'artist'")
    expect(view).toContain('restorePlaybackOrigin={restorePlaybackOrigin}')
  })

  it('uses the normalized playlist search response and exposes local retry', () => {
    const source = component('SearchPanel.tsx')
    expect(source).toContain('setPlaylistResults(data.playlists)')
    expect(source).not.toContain('data?.result?.playlists')
    expect(source).toContain("setSearchError(error instanceof Error ? error.message : '搜索失败，请稍后重试')")
    expect(source).toContain('if (selectedAlbum)')
    expect(source).toContain('else if (selectedArtist)')
  })
})
