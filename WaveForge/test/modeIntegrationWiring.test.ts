import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

describe('mode integration wiring', () => {
  it('keeps traditional playback controls and navigation reachable on narrower layouts', () => {
    const view = source('components/TraditionalView.tsx')
    expect(view).toContain("'pb-16 2xl:pb-0'")
    expect(view).toContain('2xl:hidden')
    expect(view).toContain('aria-label="打开最近播放"')
    expect(view).toContain('aria-label="打开个人中心"')
  })

  it('routes Desktop Soda recent playback through the Soda credential and endpoint', () => {
    const view = source('components/DesktopView.tsx')
    expect(view).toContain("getPlatformCookie('soda')")
    expect(view).toContain('/api/soda/recent?limit=50')
    expect(view).toContain('map(sodaMediaToSong)')
  })

  it('preserves Apple Explore nested playback state', () => {
    const panel = source('components/AppleExplorePanel.tsx')
    expect(panel).toContain("surface: 'explore-apple'")
    expect(panel).toContain('room: { id: roomDetail.id, name: roomDetail.name }')
    expect(panel).toContain('postItem: postDetail.item')
    expect(panel).toContain('chart: chartDetail')
    expect(panel).toContain("drawerType: 'station'")
  })

  it('guards banner detail requests and Explore overlays', () => {
    const view = source('components/ExploreView.tsx')
    expect(view).toContain('const requestId = ++detailRequestRef.current')
    expect(view).toContain('if (requestId !== detailRequestRef.current || controller.signal.aborted) return')
    expect(view).toContain('if (settingsOpen) { setSettingsOpen(false); return true }')
    expect(view).toContain('if (moreSection) { setMoreSection(null); return true }')
  })

  it('uses the authoritative playback clock and song-owned data for watch handoff', () => {
    const app = source('App.tsx')
    expect(app).toContain('const storePosition = audioPlayer.playbackTimeStore.getSnapshot().currentTime')
    expect(app).toContain('setWatchSyncSeek(createSongOwnedHandoff(handoffSongKey')
    expect(app).toContain('const currentWatchSeek = readSongOwnedHandoff(watchSyncSeek, currentWatchSongKey, 0)')
    expect(app).toContain('const currentInitialVideo = readSongOwnedHandoff(watchInitialVideo, currentWatchSongKey, null)')
    expect(app).not.toContain('const ownedEntry = readSongOwnedHandoff(watchSyncSeek, currentWatchSongKey, Number.NaN)')
    expect(app).toContain('getEnginePosition={() => Number(audioPlayerRef.current?.getAudioElement?.()?.currentTime) || 0}')
    expect(app).toContain("mvState?.songKey === handoffSongKey")
  })
})
