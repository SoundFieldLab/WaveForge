import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dedupeQQModules, isHiddenQQMusicHallShelf, isQQStarLightCard, qqCardPlaylist, qqModuleIdentity, qqModuleInstanceIdentity, type QQExploreCard, type QQExploreModule } from '../src/features/qqExplore/model'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')

function card(overrides: Partial<QQExploreCard> = {}): QQExploreCard {
  return {
    id: '211111',
    feedKey: '500_513_211111',
    type: 500,
    subtype: 513,
    style: 0,
    jumpType: 3003,
    title: '百万收藏',
    subtitle: '账号推荐',
    coverUrl: 'https://example.test/cover.jpg',
    reason: '为你推荐',
    content: '',
    classification: '',
    layerTitle: '',
    layerClassifyTitle: '',
    layerElementPic0: '',
    layerElementPic1: '',
    layerElementPic2: '',
    typeTag: '',
    lowerTags: [],
    countContent: '',
    twoColumn: false,
    isFavorite: false,
    favoriteCount: '',
    commentCount: '',
    badges: [],
    feedbackToken: 'feedback-token',
    appendToken: 'append-token',
    canRequestSimilar: true,
    songs: [],
    action: { type: 'open-playlist', playlistId: '211111' },
    ...overrides,
  }
}

function module(id: string, cards: QQExploreCard[]): QQExploreModule {
  return { id, instanceId: `instance-${id}`, title: '推荐', style: 0, source: 'qq-native-recommend-feed', refresh: null, cards }
}

describe('QQ native Explore contracts', () => {
  it('filters only the requested MusicHall columns by source-level shelf labels', () => {
    expect(isHiddenQQMusicHallShelf({ id: '1', title: '数字专辑', style: 0, nicheStyle: 0, serverOrder: 0, cards: [] })).toBe(false)
    expect(isHiddenQQMusicHallShelf({ id: '1', title: '数字专辑', style: 0, nicheStyle: 0, serverOrder: 0, cards: [card() as any] })).toBe(true)
    expect(isHiddenQQMusicHallShelf({ id: '2', title: '推荐歌单', style: 0, nicheStyle: 0, serverOrder: 1, cards: [card() as any] })).toBe(false)
    expect(isHiddenQQMusicHallShelf({ id: '3', title: '直播精选', style: 0, nicheStyle: 0, serverOrder: 2, cards: [card() as any] })).toBe(true)
    expect(isHiddenQQMusicHallShelf({ id: '4', title: '编辑甄选', style: 0, nicheStyle: 0, serverOrder: 3, cards: [card() as any] })).toBe(true)
  })

  it('filters only unsupported star-light cards from the recommendation feed', () => {
    expect(isQQStarLightCard(card({ type: 217, action: { type: 'unsupported' }, title: '典藏星光卡即刻拥有' }))).toBe(true)
    expect(isQQStarLightCard(card({ type: 217, action: { type: 'unsupported' }, title: '普通权益卡' }))).toBe(false)
    expect(isQQStarLightCard(card({ type: 500, title: '星光推荐' }))).toBe(false)
  })

  it('converts server-driven playlist cards without guessing an id', () => {
    expect(qqCardPlaylist(card())).toEqual({
      id: '211111',
      name: '百万收藏',
      description: '为你推荐',
      coverUrl: 'https://example.test/cover.jpg',
      platform: 'qq',
      source: 'qq-native-personalized',
    })
    expect(qqCardPlaylist(card({ action: { type: 'unsupported' } }))).toBeNull()
  })

  it('deduplicates identical cards and merges changed cards in one shelf', () => {
    const first = module('301', [card()])
    const duplicate = module('301', [card()])
    const changed = module('301', [card({ id: '211207', feedKey: '500_513_211207' })])
    const result = dedupeQQModules([first, duplicate, changed])
    expect(result).toHaveLength(1)
    expect(result[0].cards.map(item => item.id)).toEqual(['211111', '211207'])
  })

  it('merges repeated personalized flow shelves while preserving card order', () => {
    const first = module('315', [card({ id: '1', feedKey: '200_0_1' })])
    const second = module('315', [card({ id: '2', feedKey: '200_0_2' })])
    second.title = '更新后的专属乐流标题'
    const result = dedupeQQModules([first, second])
    expect(result).toHaveLength(1)
    expect(result[0].cards.map(item => item.id)).toEqual(['1', '2'])
  })

  it('deduplicates repeated cards inside one response module', () => {
    const repeated = card({ feedKey: '' })
    const result = dedupeQQModules([module('315', [repeated, { ...repeated }])])
    expect(result[0].cards).toHaveLength(1)
  })

  it('keeps different experiment layouts separate while ignoring dynamic titles', () => {
    const first = module('315', [card({ id: '1', feedKey: '200_0_1' })])
    const renamed = module('315', [card({ id: '2', feedKey: '200_0_2' })])
    renamed.title = '动态专属乐流标题'
    const alternate = { ...module('315', [card({ id: '3', feedKey: '200_0_3' })]), style: 99 }
    expect(qqModuleIdentity(first)).toBe(qqModuleIdentity(renamed))
    const result = dedupeQQModules([first, renamed, alternate])
    expect(result).toHaveLength(2)
    expect(result[0].cards.map(item => item.id)).toEqual(['1', '2'])
    expect(result[1].cards.map(item => item.id)).toEqual(['3'])
  })

  it('keeps module instance identity separate from shelf merge identity', () => {
    const first = module('315', [card()])
    const repeated = { ...module('315', [card()]), instanceId: 'instance-layout-2' }
    expect(qqModuleIdentity(first)).toBe(qqModuleIdentity(repeated))
    expect(qqModuleInstanceIdentity(first)).toBe('instance-315')
    expect(qqModuleInstanceIdentity(repeated)).toBe('instance-layout-2')
    expect(qqModuleInstanceIdentity({ ...first, instanceId: '' })).toBe(qqModuleIdentity(first))
  })

  it('maps verified Android top-card, lower-tag, and count fields from exact sources', () => {
    const server = read('local-server.mjs')
    expect(server).toContain('classification: String(extraInfo?.cardid ?? \'\')')
    expect(server).toContain('const playlistExt = parseQQNativeDisplayValue(extraInfo?.PlaylistExt)')
    expect(server).toContain('layerTitle: String(first?.LayerTitle ?? \'\')')
    expect(server).toContain('layerClassifyTitle: String(first?.LayerClassifyTitle ?? \'\')')
    expect(server).toContain('layerElementPic0: normalizeQQImageUrl(first?.LayerElementPic0)')
    expect(server).toContain('layerElementPic1: normalizeQQImageUrl(first?.LayerElementPic1)')
    expect(server).toContain('layerElementPic2: normalizeQQImageUrl(first?.LayerElementPic2)')
    expect(server).toContain("typeTag: cardStyle === 302 ? String(miscellany.typeTag ?? '') : ''")
    expect(server).toContain('const cardModel = parseQQNativeDisplayValue(card?.miscellany?.CardModel)')
    expect(server).toContain('tag: String(tag?.Tag ?? \'\')')
    expect(server).toContain('link: isAllowedQQExploreUrl(tag?.Link) ? String(tag.Link) : \'\'')
    expect(server).toContain('tagId: String(tag?.TagID ?? \'\')')
    expect(server).toContain('fromType: String(tag?.FromType ?? \'\')')
    expect(server).toContain('iconUrl: normalizeQQImageUrl(tag?.IconUrl)')
    expect(server).toContain('const rawExts = parseQQNativeDisplayValue(tag?.Exts)')
    expect(server).toContain("countContent: cardStyle === 302 ? String(miscellany.cnt_content ?? '')")
    expect(server).not.toContain('card?.cnt ?? miscellany.cnt_content')
    expect(server).toContain("if (Number(card?.style) === 302) return String(miscellany.fav_cnt_content ?? '')")
    expect(server).toContain('miscellany.fav_cnt_content ?? miscellany.song_cnt ?? miscellany.SongCnt')
    expect(server).not.toContain('favoriteCount: String(card?.miscellany?.song_cnt')
  })

  it('derives an opaque stable instance id from raw shelf placement and first feed key', () => {
    const server = read('local-server.mjs')
    expect(server).toContain('JSON.stringify([shelf?.layout ?? null, shelf?.position ?? null, firstFeedKey])')
    expect(server).toContain('instanceId: qqNativeModuleInstanceId(shelf, qqNativeFeedKey(rawCards[0]))')
    expect(server).toContain("return `qq-native-${qqHash33(rawIdentity).toString(36)}`")
  })

  it('uses the Android MusicU protocol and request-scoped credentials', () => {
    const server = read('local-server.mjs')
    expect(server).toContain('ct: 11')
    expect(server).toContain("platform: 'android'")
    expect(server).toContain("'User-Agent': 'QQMusic 20.8.0.8 Android'")
    expect(server).toContain("const requestCookie = resolveRequestCookie(String(req.body?.cookie || ''))")
    expect(server).toContain('refresh_info: {')
    expect(server).toContain('v_uniq: Array.isArray(options.feedKeys)')
  })

  it('keeps native feed out of the shared QQ payload path', () => {
    const server = read('local-server.mjs')
    const route = server.slice(server.indexOf("app.get('/api/explore/qq'"), server.indexOf("app.get('/api/explore/qq/radio/next'"))
    expect(route).not.toContain('nativeFeedPromise')
    expect(route).not.toContain('qqNative:')
  })

  it('renders QQ as an independent page and keeps Daily 30 across feed refreshes', () => {
    const view = read('src/components/ExploreView.tsx')
    const controller = read('src/features/qqExplore/useQQExploreController.ts')
    const page = read('src/features/qqExplore/QQExplorePage.tsx')
    const server = read('local-server.mjs')
    expect(view).toContain("{platform === 'qq' ? (\n            <QQExplorePage")
    expect(view).not.toContain('<QQNativeExploreContent')
    expect(controller).toContain('const LOAD_MORE_BATCHES = 5')
    expect(controller).toContain('batch < LOAD_MORE_BATCHES')
    expect(controller).toContain('loadingMoreProgress: batch + 1')
    expect(controller).toContain('daily30: previous.snapshot.daily30')
    expect(controller).toContain('const refreshModule = useCallback')
    expect(controller).toContain('module.refresh,')
    expect(controller).toContain('targetIdentity = qqModuleIdentity(module)')
    expect(controller).toContain("QQ 音乐未返回新的栏目内容，已保留当前推荐")
    expect(page).toContain('previousOverride')
    expect(page).toContain('result === false')
    expect(page).toContain('favoritePendingRef.current.has(key)')
    expect(page).toContain('QQ 客户端专属')
    expect(server).toContain('logQQUnsupportedCardSummary')
    expect(page).toContain('favoriteOwnerRef.current = owner')
    expect(page).toContain('setFavoritesReady(false)')
    expect(page).toContain('favoriteOverrides.has(key)')
    expect(page).toContain('SongStateBadges')
    expect(page).toContain('song.noCopyright')
    expect(page).toContain('grid grid-cols-1 items-start gap-3')
    expect(page).toContain('xl:grid-cols-5')
    expect(page).toContain('<HorizontalShelf')
    expect(page).toContain('edgeControls="hover"')
    expect(page).toContain('<QQExploreSkeleton />')
    expect(page).toContain('guessGeneration.current')
    expect(page).toContain('previousKey ? [previousKey] : []')
    expect(controller).toContain('refreshingModuleId: targetIdentity')
    expect(controller).toContain('moduleErrors: { ...previous.moduleErrors')
    expect(server).toContain('noCopyright =')
    expect(server).toContain('qqNativeDisplayBadges')
    expect(page).toContain("cookie={getExploreCookie('qq')}")
    expect(page).toContain('onConfiguredChange={onConfiguredChange}')
    expect(page).not.toContain('songCards.slice(0, 6)')
    expect(page).not.toContain('cards.slice(0, 12)')
    expect(page).toContain('grid-rows-3')
    expect(page).toContain('groupIntoRows(songCards)')
    expect(page).toContain('qqModuleInstanceIdentity(module)')
    expect(page).toContain('!isPersonalizedFlowModule(module)')
    expect(page).toContain('favoriteCount')
    expect(page).toContain('onSongContextMenu')
    expect(page).toContain('openResolvedSongContextMenu')
    expect(page).toContain("card.action.type === 'open-external'")
    expect(page).toContain('card.style === 304')
    expect(page).not.toContain('card.layerUrl || card.coverUrl || daily?.coverUrl')
    expect(page).toContain("'猜你喜欢': 'For You'")
    expect(page).toContain("'每日30首': 'Daily 30'")
    expect(page).toContain("'雷达模式': 'Fav Radar'")
    expect(page).toContain("guess: '猜你喜欢'")
    expect(page).toContain("daily: '每日30首'")
    expect(page).toContain("radar: '刷歌'")
    expect(page).toContain("kind === 'guess' ? 'For You'")
    expect(page).toContain('fetchQQGuessYouLikeBatch(batch, exclude, abortController.signal, 1)')
    expect(page).toContain('fetchQQGuessYouLikeBatch(batch, exclude, abortController.signal, 30)')
    expect(page).toContain('guessSongs.length > 0 ? guessSongs')
    expect(page).toContain('[authRevision, guessRefreshRevision, loggedIn]')
    expect(page).not.toContain('[authRevision, loggedIn, snapshot?.generatedAt]')
    expect(server).toContain('Math.max(0, batch - 1 + attempt)')
    expect(page).toContain("if (card.subtype === 510 && card.style === 202) return 'daily'")
    expect(page).toContain("if (card.subtype === 991 && card.style === 202) return 'radar'")
    expect(page).toContain('QQRadarPlayer')
    expect(page).toContain('进入刷歌模式')
    expect(page).toContain('qqRadarContinuation')
    expect(page).toContain("const ENTRY_ORDER = ['guess', 'daily', 'radar', 'top-fav', 'new-songs', 'star-mix'] as const")
    expect(page).toContain('const entries = topEntryCards(entryModule)')
    expect(page).toContain("const entryCover = kind === 'guess'")
    expect(page).toContain('entrySong.name')
    expect(page).toContain("entrySong.artists.map(artist => artist.name).join('/')")
    expect(page).toContain("else if (action.section === 'mvs') onOpenMVs()")
    expect(page).toContain('skillPlaylists.slice(0, 12)')
    expect(page).toContain('cards: module.cards.filter(card => !isQQStarLightCard(card))')
    expect(page).not.toContain('card.songs[0] || {')
    expect(page).toContain('aspect-square w-full overflow-hidden')
    expect(page).toContain('isHiddenQQRecommendationModule')
    expect(page).toContain('isUsableQQMusicHallCard')
    expect(page).toContain('cleanQQSubtitle(card.subtitle)')
    expect(page).not.toContain("{card.action.type === 'unsupported' ? 'QQ 客户端专属' : '打开'}")
    expect(page).not.toContain('guessExpanded')
    expect(page).not.toContain('展开猜你喜欢详情')
  })

  it('requests and returns the native MusicHall shelves without replacing legacy supplemental sections', () => {
    const server = read('local-server.mjs')
    const page = read('src/features/qqExplore/QQExplorePage.tsx')
    expect(server).toContain("'music.musicHall.MusicHallHomePage', 'GetHomePage'")
    expect(server).toContain('const [feed, musicHall] = await Promise.all')
    expect(server).toContain('feed, musicHall, daily30')
    expect(server).toContain('isAllowedQQExploreUrl')
    expect(page).toContain('musicHallShelves.map')
    expect(page).toContain('.sort((left, right) => left.serverOrder - right.serverOrder)')
    expect(page).not.toContain('HIDDEN_MUSIC_HALL_SHELVES')
    expect(page).not.toContain('HIDDEN_MUSIC_HALL_EXACT')
    expect(server).toContain('function normalizeQQImageCandidate(value, depth = 0)')
    expect(server).toContain('card?.image,')
    expect(server).toContain('card?.vector,')
    expect(server).toContain('miscellany.layer_url,')
    expect(server).toContain('const safeUrl = [card?.url, card?.link, card?.targetUrl')
    expect(server).toContain("return { type: 'unsupported' }")
    expect(page).toContain('AI 推荐歌单')
    expect(page).toContain('电台频道')
  })

  it('isolates private Daily 30 playlist details by request cookie', () => {
    const server = read('local-server.mjs')
    expect(server).toContain("const accountFingerprint = requestCookie ? qqHash33(requestCookie).toString(36) : 'guest'")
    expect(server).toContain('fetchQQPlaylistDetail(dailyCard.id, 30, cookie)')
    expect(server).toContain('...(requestCookie ? { Cookie: requestCookie } : {})')
  })

  it('keeps native feedback context on the server behind account-bound opaque tokens', () => {
    const server = read('local-server.mjs')
    const api = read('src/features/qqExplore/api.ts')
    expect(server).toContain('rememberQQFeedbackContext(card, accountFingerprint)')
    expect(server).toContain("'music.feedback.RecommendFeedback', 'GetRecommendConfigFeedBackItems'")
    expect(server).toContain("'music.feedback.RecommendFeedback', 'ReportConfigFb'")
    expect(server).toContain('context.accountFingerprint === accountFingerprint')
    expect(api).toContain("post('/feedback/options', { feedbackToken }")
    expect(api).toContain("post('/feedback/submit', { feedbackToken, optionTokens }")
  })

  it('uses QQ account APIs for recommendation preferences', () => {
    const server = read('local-server.mjs')
    expect(server).toContain("'music.recommend.RecommendWidget', 'GetForyouConfigItems'")
    expect(server).toContain("'music.recommend.RecommendWidget', 'SaveForyouConfigItems'")
    expect(server).toContain('{ Selections: selections }')
  })

  it('renders QQ title templates and resolves full shelves through one frontend request', () => {
    const server = read('local-server.mjs')
    const api = read('src/features/qqExplore/api.ts')
    const controller = read('src/features/qqExplore/useQQExploreController.ts')
    expect(server).toContain("titleTemplate.replaceAll('{String}', titleContent)")
    expect(server).toContain('input.Name || input.MID || input.Mid || input.SingerName')
    expect(server).toContain('value.MID || value.Mid')
    expect(server).toContain("app.post('/api/explore/qq/native/songs'")
    expect(server).toContain('req.body.cards.slice(0, 36)')
    expect(api).toContain("post<{ songs: Song[] }>('/songs'")
    expect(api).toContain("getApiBase()}${API_PATH}${path}")
    expect(controller).toContain('contextualController.current?.abort()')
    expect(controller).toContain('fetchQQExploreAppendShelf(card.appendToken, action, abortController.signal)')
    expect(controller).toContain('fetchQQExploreSimilarShelf(card.appendToken, abortController.signal)')
    expect(controller).toContain('abortController.signal.aborted || requestGeneration !== generation.current')
    expect(server).toContain("app.all('/api/explore/qq/radio/next'")
    expect(server).toContain('const input = { ...req.query, ...(req.body || {}) }')
  })

  it('degrades unsupported append shelves without surfacing a playback error', () => {
    const api = read('src/features/qqExplore/api.ts')
    expect(api).toContain('GetRecommendAppendShelf.*60001')
    expect(api).toContain('return { modules: [] }')
  })

  it('keeps the QQ preference and recommendation entries inside the right-click menu only', () => {
    const menu = read('src/components/SongContextMenu.tsx')
    const view = read('src/components/ExploreView.tsx')
    expect(menu).toContain('onAdjustPreferences?: () => void')
    expect(menu).toContain('onAdjustRecommendation?: (song: Song) => void')
    expect(menu).toContain("onAdjustPreferences && resolvedPlatform === 'qq'")
    expect(menu).toContain("onAdjustRecommendation && resolvedPlatform === 'qq'")
    expect(view).toContain("platform === 'qq' ? () => window.dispatchEvent(new Event('waveforge:qq-open-preferences'))")
    expect(view).toContain("platform === 'qq' ? song => window.dispatchEvent(new CustomEvent('waveforge:qq-open-recommendation-feedback'")
    const page = read('src/features/qqExplore/QQExplorePage.tsx')
    expect(page).toContain("window.addEventListener('waveforge:qq-open-preferences'")
    expect(page).toContain("window.addEventListener('waveforge:qq-open-recommendation-feedback'")
  })

  it('uses a real-account favorite heart on song rows instead of the feedback ellipsis', () => {
    const page = read('src/features/qqExplore/QQExplorePage.tsx')
    expect(page).toContain('const cardFavoriteKey = useCallback')
    expect(page).toContain('aria-label={isSongFavorite(resolvedSong, card)')
    expect(page).not.toContain('card.isFavorite ||')
    expect(page).not.toContain('MoreHorizontal')
  })
})
