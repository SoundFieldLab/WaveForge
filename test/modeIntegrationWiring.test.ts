import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

describe('mode integration wiring', () => {
  it('keeps traditional playback controls and navigation reachable on narrower layouts', () => {
    const view = source('components/TraditionalView.tsx')
    expect(view).toContain('aria-label="打开最近播放"')
    expect(view).toContain('aria-label="打开个人中心"')
  })

  it('treats the playback page and mixing studio as shared mode surfaces', () => {
    const app = source('App.tsx')
    expect(app).toContain("const isPlaybackPage = Boolean(currentSong) && (showSharedPlayer || (viewMode === 'minimal' && !showHome))")
    expect(app).toContain("const renderedMode: ViewMode = isPlaybackPage ? 'minimal' : viewMode")
    expect(app).toContain('onOpenPlayer={viewCallbacks.onOpenPlayer}')
    expect(app).toContain('const originMode = viewModeRef.current')
    expect(app).toContain("playbackOriginRef.current = origin ||")
    expect(app).toContain('const mixingStudioAudio = showMixingStudio ? audioPlayer.getAudioElement() : null')
    expect(app).toContain('sourceUrl: mixingStudioAudio?.src || undefined')
    expect(app).toContain('调音室是全模式共享弹层')
    expect(app).not.toContain("setEnteredFromMode('explore')")
  })

  it('keeps Explore song selection in place with its mini player', () => {
    const app = source('App.tsx')
    const explore = source('components/ExploreView.tsx')
    expect(app).toContain("const playsInPlace = !isRadioSelection && (originMode === 'traditional' || originMode === 'explore')")
    expect(app).toContain("if (viewMode !== 'minimal' && (!playsInPlace || isRadioSelection))")
    expect(app).toContain("if (originMode === 'explore')")
    expect(app).toContain('setShowHome(true)')
    expect(app).toContain('} else if (!playsInPlace) {')
    expect(explore).toContain("continuation: 'explore-infinite'")
    expect(explore).toContain('show={Boolean(currentSong) && !detailOpen}')
    expect(explore).toContain('onClick={onOpenPlayer}')
  })

  it('gates the Traditional spectrum to its preference and visible right column', () => {
    const app = source('App.tsx')
    expect(app).toContain("window.addEventListener('traditionalPreferencesChanged', syncPreference)")
    expect(app).toContain("window.matchMedia('(min-width: 1180px)')")
    expect(app).toContain('traditionalSpectrumVisible && traditionalRightColumnVisible')
  })

  it('keeps playback surfaces on cover-derived color instead of settings accent', () => {
    const app = source('App.tsx')
    const immersive = source('components/ImmersiveControls.tsx')
    const controls = source('components/PlayerControls.tsx')
    expect(app).toContain('const playbackCoverColor = coverColorStatus ===')
    expect(app).not.toContain('coverPalette[0] || extractedColor || userAccentColor')
    expect(app).not.toContain('userAccentColor')
    expect(app).toContain('coverColor={playbackCoverColor}')
    expect(immersive).toContain('coverColor: string')
    expect(immersive).not.toContain("localStorage.getItem('accentColor')")
    expect(controls).not.toContain('settingsAccentColor')
  })
  it('preserves watch handoff timing without changing MV source selection', () => {
    const app = source('App.tsx')
    const player = source('components/BilibiliMvPlayer.tsx')
    const playerHook = source('hooks/useAudioPlayer.ts')
    expect(app).toContain('lyricModeHandlerRef.current(mode)')
    expect(app).toContain('watchHandoffPendingRef.current = true')
    expect(app).toContain('audioPlayerRef.current?.seek(restored)')
    expect(player).toContain('resolveWatchSongTime')
    expect(player).toContain("media.removeAttribute('src')")
    expect(player).toContain('onPointerCancel={onSubtitlePointerCancel}')
    expect(player).toContain('aria-label="字幕位置，可拖动调整"')
    expect(player).not.toContain('title="拖动可调整字幕位置（自动记住）"')
    expect(player).toContain('initialSeekSeconds')
    expect(playerHook).toContain("cancelScheduledTransition('audio player unmounted'")
    expect(app).not.toContain('findBestBilibiliMv =')
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

  it('guards Traditional async and audio lifecycle teardown', () => {
    const view = source('components/TraditionalView.tsx')
    const app = source('App.tsx')
    const bridge = source('services/appleWebViewBridge.ts')
    const player = source('hooks/useAudioPlayer.ts')
    expect(view).toContain('playlistAbortRef.current?.abort()')
    expect(view).toContain('platform: originPlatform')
    expect(view).toContain("document.addEventListener('visibilitychange', onVisibilityChange)")
    expect(view).toContain("prefers-reduced-motion: reduce")
    expect(view).toContain("typeof context.roundRect === 'function'")
    expect(app).toContain('clearExternalSpectrum()')
    expect(bridge).toContain('generation !== pollGeneration')
    expect(bridge).toContain('pollGeneration += 1')
    expect(player).toContain("cancelScheduledTransition('audio player unmounted', false, false)")
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

  it('restores the background MV playback signal after leaving watch mode', () => {
    const app = source('App.tsx')
    const publishIndex = app.indexOf('setIsPlaying(true)')
    const playIndex = app.indexOf('const playPromise = engineEl.play()')
    expect(publishIndex).toBeGreaterThan(-1)
    expect(playIndex).toBeGreaterThan(publishIndex)
    expect(app).toContain("lyricDisplayModeRef.current === 'video' || activeEngineEl !== engineEl || !engineEl.paused")
    expect(app).toContain('if (!watchResumeHeldAtEndRef.current && engineEl.paused)')
    expect(app).toContain('}, [lyricDisplayMode, watchVideoActive])')
  })
})
