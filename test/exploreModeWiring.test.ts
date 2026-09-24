import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8')
const service = (name: string) => readFileSync(new URL(`../src/services/${name}`, import.meta.url), 'utf8')
const desktop = (name: string) => readFileSync(new URL(`../desktop/${name}`, import.meta.url), 'utf8')

describe('Explore mode wiring regressions', () => {
  it('bypasses the hidden legacy Apple payload pipeline', () => {
    const source = component('ExploreView.tsx').replace(/\r\n/g, '\n')
    expect(source).toContain("import { AppleExplorePanel } from './AppleExplorePanel'")
    expect(source).toContain("{platform === 'apple' ? (")
    expect(source).toContain('<AppleExplorePanel')
    expect(source).toContain('onOpenPlaylistPanel={handleApplePlaylist}')
  })

  it('guards Apple tab refreshes and supports catalog playlist removal', () => {
    const source = component('AppleExplorePanel.tsx').replace(/\r\n/g, '\n')
    expect(source).toContain('++pageRequestRef.current[target]')
    expect(source).toContain('pageRequestRef.current[target] !== requestId')
    // 登录后预取资料库：写法从独立 effect 折进了账号上下文 effect，意图不变（登录态下预取 library）
    expect(source).toContain("if (appleLoggedIn && tab !== 'library') void loadTab('library', true)")
    expect(source).toContain('removeApplePlaylistFromLibrary(libraryId)')
    expect(source).toContain('removeAppleSongFromLibrary(item.playId)')
    expect(source).toContain('if (!item.libraryId) continue')
    expect(source).not.toContain('rotate-45')
    expect(source).toContain('data-apple-explore-panel')
    expect(source).toContain('if (event.target instanceof HTMLImageElement) event.preventDefault()')
    expect(source).toContain('setSavedPlaylists(new Set())')
    expect(source).toContain('setCatalogLibraryIds(new Map())')
    expect(source).toContain("item.type === 'music-videos'")
    expect(source).toContain('section.items.every(item => item.type === section.items[0].type)')
    expect(source).toContain('onClick={() => setChartDetail(section)}')
    expect(source).toContain('disabled={libraryMutations.has(libraryKey)}')
    expect(source).toContain('appleStationToSong(item, undefined, storefront)')
    expect(source).toContain('void onSongSelect(song, [song]')
    expect(source).not.toContain("if (!station?.playId)")
    expect(component('../App.tsx')).toContain('const hasValidSongId = radioDescriptor || appleHlsStream')
    expect(source).toContain('<motion.div\n        whileHover={{ y: -3 }}')
    expect(source).toContain('aria-label={`播放${item.name}`}')
    // 电台卡不再带「加入资料库」按钮：实测官网电台卡没有该按钮（点击开详情抽屉，
    // 收藏走抽屉内的入口），因此这里断言它确实已移除，而不是留着无用的收藏控件。
    expect(source).not.toContain("aria-label={isSaved ? '从资料库移除' : '加入资料库'}")
    expect(source).not.toContain('disabled={libraryMutations.has(`station:${item.playId}`)}')
    expect(service('appleWebService.ts')).toContain('fields[stations]=name,url,artwork,editorialArtwork,editorialVideo,editorialNotes,playParams,isLive,airTime')
    expect(source).not.toContain('<motion.button\n        type="button"\n        whileHover={{ y: -3 }}\n        data-tv-focus\n        aria-label={`播放${item.name}`}')
    expect(source).toContain("onClick={(event) => { event.stopPropagation(); openSongMenu(event, item, items) }}")
    expect(source).toContain('const showId = item.playId || item.id')
    expect(source).toContain('const stationId = item.playId || item.id')
    // room/grouping/multiroom/curator 入口统一走 resolveExploreTarget + 层级栈，而不是就地切分 URL。
    expect(source).toContain('resolveExploreTarget(item.url)')
    expect(service('appleWebService.ts')).toContain('export function resolveExploreTarget')
    expect(service('appleWebService.ts')).toContain('viewMultiRoom')
    expect(service('appleWebService.ts')).toContain('fetchAppleGroupingPage')
    expect(service('appleWebService.ts')).toContain('fetchAppleMultiRoomPage')
    expect(service('appleWebService.ts')).toContain("kind === '345'")
    expect(service('appleWebService.ts')).toContain("kind === '404'")
    expect(source).toContain('void getAppleLovedSongIds(visibleSongIds)')
    expect(source).not.toContain('喜爱状态暂不可用')
    expect(source).toContain("window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '喜爱状态更新失败，请重试', type: 'error' } }))")
    expect(source).toContain('if (!appleLoggedIn) {\n      onLoginClick()')
    expect(component('ExploreView.tsx')).toContain('error={detailError}')
    expect(component('ExploreView.tsx')).toContain('onRetry={() => detailRetryRef.current?.()}')
    // Apple 专辑要拿到账号商店：详情弹窗改为常驻（冻结）后，来源变成冻结快照里的平台，语义不变
    expect(component('../App.tsx')).toContain("storefront={frozenAlbumDetail.platform === 'apple' ? appleStorefront : undefined}")
    expect(source).toContain('setArtistDrawer(null); void openAlbumDrawer(album)')
    expect(source).toContain('{stationDetail.station.url && (')
    expect(source).toContain('storefront={storefront}')
    expect(source).toContain('data-tv-scope')
  })

  it('wires direct MV playback separately from the MV browse modal', () => {
    const view = component('ExploreView.tsx')
    const modal = component('MVExploreModal.tsx')
    expect(view).toContain('directPlay={mvDirectPlay}')
    expect(view).toContain('setMvDirectPlay(false)')
    expect(modal).toContain('if (directPlay) {')
    expect(modal).toContain('onClose={onClose}')
  })

  // Apple 卡片与官网对齐的三处实测差异（视觉回归很容易再犯，故锁在源码接线层）：
  //  ① 竖版卡比例：官网实测 407×542 = 3:4；原 aspect-[125/181](≈0.69) 比官网窄高 8.6%。
  //  ② 宽卡比例：官网实测 540×310 ≈ 1.742；原 16/10(1.6) 偏矮、裁掉更多画面。
  //  ③ 卡内小标签与 E 标必须真的被渲染（此前数据取到了却没人用）。
  it('keeps Apple featured cards on the measured official aspect ratios', () => {
    const panel = component('AppleExplorePanel.tsx')
    // 去掉注释行再断言，避免把说明文字里的「原 125/181」当成仍在使用的类名
    const code = panel.split('\n').filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && !line.trim().startsWith('//')).join('\n')
    expect(code).toContain("portrait ? 'aspect-[3/4]' : 'aspect-[540/310]'")
    expect(code).not.toContain('aspect-[125/181]')
    expect(code).not.toContain('aspect-[16/10]')
    // 卡内小标签（官网「下一首」）与 E 标都要走归一后的值
    expect(code).toContain('resolveAppleCardMeta')
    expect(code).toContain('{cardLabel &&')
    expect(code).toContain('{explicitBadge}')
  })

  it('opens the player from Explore with an opaque first frame and waits for the MV frame', () => {
    const source = component('../App.tsx')
    const background = component('BilibiliMvBackground.tsx')
    expect(source).toContain("const enteringPlayerFromExplore = isPlaybackPage && enteredFromMode === 'explore'")
    expect(source).toContain('initial={enteringPlayerFromExplore ? { opacity: 1, y: 0, scale: 1 }')
    expect(source).toContain('className="absolute inset-0 h-screen w-full flex items-center justify-center overflow-hidden bg-black"')
    expect(source).toContain('&& mvBackgroundReady')
    expect(source).toContain('onReadyChange={setMvBackgroundReady}')
    expect(background).toContain('onReadyChange?: (ready: boolean) => void')
    expect(background).toContain("setPaintedSlots(prev => prev[slot] ? prev : { ...prev, [slot]: true })")
  })

  // MV 背景层在首页/看歌盖住它时仍常驻挂载。这里锁死「被遮挡就交给同一个 hidden 通道」：
  // 只有复用 hidden（暂停 + 保留缓冲 + 返回时按音频时钟硬同步），才能同时满足
  // ① 不在不可见时白解码 1080P；② 看歌↔歌词页来回切无缝接上且 MV 实时对准。
  // 若把 showHome 从这里去掉 → MV 会在首页背后持续解码（性能回归）；
  // 若改成卸载而非 hidden → 切回来要重新搜索拉流（体验回归）。
  it('treats a covering surface as the same temporary cover as watch mode for the MV layer', () => {
    const source = component('../App.tsx').replace(/\r\n/g, '\n')
    expect(source).toContain("hidden={lyricDisplayMode === 'video' || showHome}")
    // 电台/播客统一走 mvBackgroundSuppressed（= isAppleRadioPlayback || podcastPlayback）：
    // MV 图层挂载与此开关必须同源，否则会出现"歌词页透明等 MV、MV 却没挂载"的黑屏。
    expect(source).toContain('const mvBackgroundSuppressed = isAppleRadioPlayback || podcastPlayback')
    expect(source).toContain('enabled={mvBackgroundEnabled && !mvBackgroundSuppressed}')
    expect(source).toContain('{currentSong && !mvBackgroundSuppressed && (')
  })

  it('keeps Apple radio retries scoped to the active station', () => {
    const source = component('../App.tsx').replace(/\r\n/g, '\n')
    expect(source).toContain("import { decideAppleRadioFailure, getAppleRadioReconnectKey } from './services/appleRadioReconnect'")
    expect(source).toContain('if (appleRadioReconnectTimerRef.current !== null) {\n      window.clearTimeout(appleRadioReconnectTimerRef.current)')
    expect(source).toContain('if (latestKey !== decision.reconnectKey) return')
    expect(source).toContain("setAppleRadioError('Apple Music 电台未能启动播放，请重新连接')")
  })

  it('prefers the private Apple playback host for radio assets', () => {
    const source = desktop('main.cjs')
    expect(source).toContain("const APPLE_PLAY_ASSETS_HOSTS = ['https://amp-api.music.apple.com', 'https://api.music.apple.com']")
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

  it('adds a shared return-to-top control to the Explore home scroll container', () => {
    const source = component('ExploreView.tsx')
    expect(source).toContain("import ScrollToTop from './ScrollToTop'")
    expect(source).toContain('const exploreScrollRef = useRef<HTMLDivElement>(null)')
    expect(source).toContain('ref={exploreScrollRef}')
    expect(source).toContain('containerRef={exploreScrollRef}')
    expect(source).toContain('threshold={200}')
    expect(source).toContain('offsetBottom={currentSong ? 168 : 24}')
    expect(source).toContain('{!moreSection && !detailOpen && !settingsOpen && (')
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
