import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

/** App.tsx 里七个同级整屏模式层容器（key="xxx-mode"）。新增模式层时必须一并登记。 */
const MODE_LAYER_KEYS = ['explore-mode', 'desktop-mode', 'resonance-mode', 'traditional-mode', 'minimal-mode', 'singalong-mode', 'inparty-mode']

/** 从标签起始 '<' 扫到该标签的结束 '>'（跳过 {} / () / [] 与字符串里的 '>'） */
function findTagEnd(text: string, tagStart: number): number {
  let depth = 0
  let quote: string | null = null
  for (let i = tagStart; i < text.length; i += 1) {
    const char = text[i]
    if (quote) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
    else if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') depth -= 1
    else if (char === '>' && depth === 0) return i
  }
  throw new Error('未找到标签结束符')
}

/** 取出每个模式层容器的起始标签文本 */
function readModeLayerTags(app: string): Array<{ key: string; tag: string }> {
  return MODE_LAYER_KEYS.map(key => {
    const keyAt = app.indexOf(`key="${key}"`)
    expect(keyAt, `${key} 层不存在`).toBeGreaterThan(-1)
    const tagStart = app.lastIndexOf('<', keyAt)
    return { key, tag: app.slice(tagStart, findTagEnd(app, tagStart) + 1) }
  })
}

/** 扫描 App.tsx 里实际存在的模式层 key（新增模式层时用于强制登记） */
function discoverModeLayerKeys(app: string): string[] {
  const keys = new Set<string>()
  for (const match of app.matchAll(/key="([a-z][a-z0-9-]*-mode)"/g)) keys.add(match[1])
  return [...keys].sort()
}

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
    // 多声道空间输入接管时元素 src 是静音时钟 WAV，导出源必须优先取播放器记录的原曲 URL。
    expect(app).toContain("sourceUrl: audioPlayer.getPlaybackSource()?.url || mixingStudioAudio?.src || undefined")
    expect(app).toContain('调音室是全模式共享弹层')
    // 探索页进入播放页：探索页保持挂载（覆盖层模式），返回不重载
    expect(app).toContain("const exploreKeptAlive = isPlaybackPage && enteredFromMode === 'explore' && viewMode === 'explore'")
    // 跨模式切换同样不卸载：已访问过的模式只隐藏（parked），切回不重新请求、不重建 DOM
    expect(app).toContain("const parkedExplore = visitedModes.has('explore')")
    expect(app).toContain('const exploreSuspended = exploreKeptAlive || parkedExplore')
    expect(app).toContain('motionSuspended={exploreSuspended}')
  })

  it('hides every parked mode layer so it cannot cover the active mode', () => {
    const app = source('App.tsx')
    // 新增模式层必须一并登记：这里动态扫描 App.tsx 里所有 `key="xxx-mode"` 容器，
    // 数量/名称对不上就失败——否则新层会绕过下面「必须走 modeLayerStyle」的检查，
    // 「挂起层盖住当前模式」那类事故就会再发生一次。
    expect(discoverModeLayerKeys(app), '新增视图模式层：请登记到 MODE_LAYER_KEYS，并用 modeLayerStyle 处理挂起')
      .toEqual([...MODE_LAYER_KEYS].sort())

    const tags = readModeLayerTags(app)
    const tagOf = (key: string) => tags.find(item => item.key === key)!.tag

    // 五个模式层是同级整屏容器，靠 z-index 分层、靠 DOM 顺序兜底。挂起层（切走但保留挂载）
    // 必须「z-index 降到 1 + visibility: hidden」同时成立——只做其中一个，挂起层仍会画在
    // 当前模式之上：简约层自带不透明黑底（bg-black）且 DOM 顺序在最后，漏掉隐藏就是
    // 「从简约切到传统/探索/桌面后整屏黑屏，且所有点击被它吞掉」。
    // 层叠样式必须来自共享的 modeLayerStyle，禁止在这些容器上手写 z-index / visibility。
    for (const { key, tag } of tags) {
      expect(tag, `${key} 的层叠样式必须走 modeLayerStyle`).toContain('modeLayerStyle(')
      expect(tag, `${key} 不应手写 z-index`).not.toMatch(/\bzIndex\s*:/)
      expect(tag, `${key} 不应手写 visibility`).not.toMatch(/\bvisibility\s*:/)
    }

    // 挂起态要真的接上：这四个层会被保留挂载，接错变量等于没隐藏
    expect(tagOf('explore-mode')).toContain('suspended: exploreSuspended')
    expect(tagOf('desktop-mode')).toContain('suspended: parkedDesktop')
    expect(tagOf('traditional-mode')).toContain('suspended: traditionalSuspended')
    expect(tagOf('minimal-mode')).toContain('suspended: parkedMinimal')
    // 简约层作为播放页覆盖探索页时才抬高到最上层（与挂起互斥）
    expect(tagOf('minimal-mode')).toContain('overlayAbove: exploreKeptAlive')

    // 挂起层不能跑重活：MV 背景解码也走同一个 hidden 通道（gameModeFrozen 同属「完全不可见」）
    expect(app).toContain('hidden={lyricDisplayMode === \'video\' || showHome || parkedMinimal || gameModeFrozen}')
  })

  it('keeps playback-surface portals from escaping a parked mode layer', () => {
    const app = source('App.tsx')
    const lines = app.split('\n')
    // 简约播放面的顶部歌词样式下拉、看歌控件是 portal 到 body 的：portal 逃出了挂起层的
    // visibility:hidden，留在原地就会盖在当前模式顶部——现象是「桌面模式下顶部下拉本该切模式，
    // 出来的却是歌词样式面板」，以及看歌控件浮在桌面上。
    // 合法例外只有两个：MaybePortal 自身实现（只做「渲染到 body / 原地渲染」的分发）、
    // App 级 Toast 容器（顶层常驻，不属于任何模式层，任何模式下都该显示）。
    const escapes = lines
      .map((line, index) => ({ line, no: index + 1, near: lines.slice(index, index + 6).join('\n') }))
      .filter(({ line }) => /createPortal\(|MaybePortal active=\{/.test(line))
      .filter(({ line, near }) => !line.includes('{children}') && !near.includes('toasts.map'))
    expect(
      escapes.length,
      `portal 逃逸点数量变了（当前在 App.tsx 第 ${escapes.map(item => item.no).join('/')} 行）：新增逃逸点要么带 !parkedMinimal，要么（真全局层）登记进本用例的例外`,
    ).toBe(3)
    for (const { line, no } of escapes) {
      expect(line, `App.tsx:${no} 的 portal 逃逸必须带挂起条件 !parkedMinimal`).toContain('parkedMinimal')
    }
    // 光不渲染还不够：面板 open 状态也必须在挂起时复位，否则切回播放页会自己展开一次
    expect(app).toContain('if (!parkedMinimal) return')
    expect(app).toContain('setShowLyricModePanel(false)')
  })

  it('keeps every mode-internal portal behind the parked gate', () => {
    const app = source('App.tsx')
    // 1) 每个模式层容器都要提供挂起状态（Provider 数量 = 模式层数量），否则层内浮层读不到
    const providers = app.match(/<ModeParkedContext\.Provider value=\{[^}]+\}>/g) || []
    expect(providers.length, '每个模式层容器都要包一层 ModeParkedContext.Provider（见 src/utils/modeLayer.ts）')
      .toBe(MODE_LAYER_KEYS.length)
    for (const value of ['exploreSuspended', 'parkedDesktop', 'traditionalSuspended', 'parkedMinimal']) {
      expect(providers.some(item => item.includes(value)), `模式层容器缺少挂起值 ${value}`).toBe(true)
    }

    // 2) 层内 portal 到 body 的浮层必须自己让位：CSS 的 visibility 管不到 portal（它在 DOM 上是
    //    body 的子节点，不是挂起层的后代）。踩过的坑：顶部歌词样式下拉盖住桌面模式的模式选择入口、
    //    从桌面模式切走后天气详情弹窗仍留在屏幕上。
    const allowList: Record<string, string> = {
      'App.tsx': 'App 内的 portal 用 !parkedMinimal 显式守住（见上一条用例）',
      'components/RemoteCursor.tsx': 'App 顶层 TV 遥控光标，任意模式都该显示',
      'components/SimilarSongsPanel.tsx': 'App 顶层全局弹层，不属于任何模式层',
      'components/ImmersiveControls.tsx': 'portal 到层内封面下方锚点（getElementById(anchorId)，墙纸/辉煌模式同层元素），挂起层的 visibility 已覆盖，未逃出模式层',
      'components/QuickSettingsHost.tsx': 'App 顶层全局弹层（与调音室同为全模式共享，见 App.tsx 挂载点注释），不挂在任何模式层内，useModeParked 恒为 false',
      'services/waveforge-engine-v3/ui/components/SpatialWorldView.tsx': 'portal 到自身容器，仍在模式层内',
    }
    const read = (relative: string) => readFileSync(new URL(`../src/${relative}`, import.meta.url), 'utf8')
    const offenders = (readdirSync(new URL('../src', import.meta.url), { recursive: true }) as string[])
      .map(entry => entry.split('\\').join('/'))
      .filter(entry => entry.endsWith('.tsx') && !allowList[entry])
      .filter(entry => read(entry).includes('createPortal('))
      .filter(entry => !read(entry).includes('useModeParked'))
    expect(offenders, `这些文件 portal 到 body 却没读挂起状态，切模式后会盖住当前模式：${offenders.join('、')}`).toEqual([])
  })

  it('keeps Explore song selection in place with its mini player', () => {
    const app = source('App.tsx')
    const explore = source('components/ExploreView.tsx')
    const settingsPanel = source('components/ExploreSettingsPanel.tsx')
    // 原地切歌的模式集合：探索/传统/共振都要保持当前视图挂载（共振换歌由房主权威状态驱动，
    // 若在此被切到 minimal，成员会被踢出共振界面）。断言「意图」而不是整行字面量，
    // 避免以后新增原地模式时必须同步改写这行断言。
    expect(app).toContain('const playsInPlace = !isRadioSelection && (')
    expect(app).toContain("originMode === 'traditional'")
    expect(app).toContain("originMode === 'explore'")
    expect(app).toContain("originMode === 'resonance'")
    expect(app).toContain("const exploreRadioOverlay = isRadioSelection && originMode === 'explore'")
    expect(app).toContain("if (viewMode !== 'minimal' && !playsInPlace && !exploreRadioOverlay)")
    expect(app).toContain("if (originMode === 'explore')")
    expect(app).toContain('setShowHome(true)')
    expect(app).toContain('} else if (!playsInPlace) {')
    // 新增导航偏好：点击歌曲可直接进入播放页（探索页保持挂载，返回原样呈现）
    expect(settingsPanel).toContain('openPlayerOnSongSelect')
    expect(app).toContain('exploreOpenPlayerPref')
    // 歌单详情选歌后不再自动关闭，方便继续挑歌
    expect(explore).toContain('歌单详情覆盖层保持打开')
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
    // 2026-10-17 P3：API 基址统一走 getApiBase()（支持 waveforge:apiBase 覆盖），
    // 源码里不再有硬编码的完整 URL，断言改为路由路径本身。
    expect(view).toContain('/soda/recent?limit=50')
    expect(view).toContain('map(sodaMediaToSong)')
  })

  it('preserves Apple Explore nested playback state', () => {
    const panel = source('components/AppleExplorePanel.tsx')
    expect(panel).toContain("surface: 'explore-apple'")
    // room 归属来自「嵌套层级栈」的栈顶（room/grouping/multiroom/curator 可任意互相进入，
    // 旧实现是单一 roomDetail，重构后泛化为有序栈）。这里断言输出契约：
    // 只有 room 类型的活动层才写入 room: { id, name }，且取值来自该层自身。
    expect(panel).toContain("activeLayer.kind === 'room' ? { room: { id: activeLayer.id, name: activeLayer.name } }")
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

describe('模式切换过渡动画：简易风格必须在暖目标下也播放', () => {
  // 回归背景（用户实测 2026-10-06）：`handleTransitionStart` 曾把遮罩条件写成
  // `(complexStyle || !warmTarget)` —— 选「简易」后，本次会话已挂载过的模式（暖目标）
  // 完全不出遮罩，观感就是"简易动画没了，只剩复杂"。简易风格也应在暖目标下播自己的
  // 动画（窗口压短：MODE_TRANSITION_SIMPLE_MIN_MS），只是不做复杂档的 chunk 预加载。
  const app = source('App.tsx')

  it('两个派发入口（模式卡片 / viewModeChanged 兜底）都按 warmTarget 出遮罩', () => {
    expect(app).not.toContain('(complexStyle || !warmTarget)')
    const quickAssignments = app.match(/quick: warmTarget/g) || []
    expect(quickAssignments.length).toBe(2)
  })

  it('简易风格的暖目标窗口使用独立常量（1.3s），复杂快速档仍是 850ms', () => {
    expect(app).toContain('const MODE_TRANSITION_SIMPLE_MIN_MS = 1300')
    expect(app).toContain("modeTransitionStyleRef.current === 'simple' ? MODE_TRANSITION_SIMPLE_MIN_MS : MODE_TRANSITION_QUICK_MIN_MS")
  })
})
