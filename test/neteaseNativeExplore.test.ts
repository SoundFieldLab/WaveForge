import { describe, expect, it } from 'vitest'
import { normalizeNeteaseSongs } from '../src/features/neteaseExplore/api'
import { dedupeNeteaseResources, normalizeNeteaseBlock, normalizeNeteaseDailyPodcast, normalizeNeteaseFlow, normalizeNeteaseHome } from '../src/features/neteaseExplore/model'
import {
  RED_COUNT_BATCH_LIMIT,
  arrayResponseData,
  authenticatedProfile,
  formatRedCountBatch,
  isAccountScopedCookie,
  parseRedCountIds,
  redCountFromBody,
  registerNeteaseNativeExploreRoutes,
  responseBody,
  sessionReason,
} from '../server/netease-native-explore.mjs'

// test/neteaseNativeExplore.test.ts

describe('NetEase native recommendation feed', () => {
  it('normalizes native song and playlist resources without losing raw blocks', () => {
    const home = normalizeNeteaseHome({
      accountScoped: true,
      generatedAt: 10,
      data: {
        hasMore: true,
        cursor: 'next',
        blockCodeOrderList: ['PLAYLIST_BLOCK', 'SONG_BLOCK'],
        blocks: [
          {
            blockCode: 'SONG_BLOCK',
            showType: 'HOMEPAGE_SLIDE_SONGLIST_ALIGN',
            uiElement: { mainTitle: { title: '根据你喜爱的歌曲推荐' } },
            creatives: [{
              creativeId: 'song-1',
              uiElement: { mainTitle: { title: 'Song' }, subTitle: { title: 'Artist' } },
              creativeExtInfoVO: { songData: { id: 1, name: 'Song', ar: [{ id: 2, name: 'Artist' }], al: { id: 3, name: 'Album', picUrl: 'http://cover' }, dt: 123 } },
            }],
          },
          {
            blockCode: 'PLAYLIST_BLOCK',
            showType: 'HOMEPAGE_SLIDE_PLAYLIST',
            creatives: [{ creativeId: 'list-1', resources: [{ resourceId: '42', resourceType: 'playlist', action: 'orpheus://playlist/42', uiElement: { mainTitle: { title: 'Radar' }, image: { imageUrl: 'http://playlist' } } }] }],
          },
        ],
      },
    })

    expect(home.blocks.map(block => block.blockCode)).toEqual(['PLAYLIST_BLOCK', 'SONG_BLOCK'])
    expect(home.blocks[0].resources[0].playlist?.id).toBe('42')
    expect(home.blocks[1].resources[0].song).toMatchObject({ id: 1, name: 'Song', platform: 'netease' })
    expect(home.rawBlocks).toHaveLength(2)
    expect(home.hasMore).toBe(true)
    expect(home.cursor).toBe('next')
  })

  it('recursively extracts resources from server DSL payloads', () => {
    const block = normalizeNeteaseBlock({
      positionCode: 'PAGE_RECOMMEND_SCENE_PLAYLIST_LOCATION',
      dslData: {
        nested: {
          resources: [{ resourceId: '99', resourceType: 'playList', action: 'orpheus://playlist/99', name: 'Scene list', coverUrl: 'http://image' }],
        },
      },
    }, 0)

    expect(block.resources).toHaveLength(1)
    expect(block.resources[0].playlist).toMatchObject({ id: '99', name: 'Scene list' })
    expect(block.resources[0].coverUrl).toBe('https://image')
    expect(block.raw.dslData).toBeDefined()
  })

  it('maps captured mobile resource types to executable PC actions', () => {
    const resources = [
      { resourceType: 'list', resourceId: '10', action: 'orpheus://playlist/10?autoplay=0', uiElement: { mainTitle: { title: 'List' } } },
      { resourceType: 'album', resourceId: '20', action: 'orpheus://album/20', uiElement: { mainTitle: { title: 'Album' } } },
      { creativeType: 'voice', creativeId: '30', action: 'orpheus://program/30', uiElement: { mainTitle: { title: 'Program' } } },
      { creativeType: 'voiceList', creativeId: '40', action: 'orpheus://djradio/40', uiElement: { mainTitle: { title: 'Radio' } } },
      { resourceType: 'MV', resourceId: '50', songData: { id: 5, name: 'Song', mv: 51, ar: [], al: {} }, mainTitle: { title: 'MV' } },
      { resourceType: 'COMMENT', resourceId: '60', songData: { id: 6, name: 'Comment song', ar: [], al: {} }, mainTitle: { title: 'Comment' } },
      { creativeType: 'myPodcast', creativeId: '70', action: 'orpheus://rnpage?component=rn-podcast-my', uiElement: { mainTitle: { title: 'Mine' } } },
    ].map((value, index) => normalizeNeteaseBlock({ blockCode: `B${index}`, showType: 'UNKNOWN', creatives: [value] }, index).resources[0])

    expect(resources.map(resource => resource.action.type)).toEqual([
      'playlist', 'album', 'program', 'radio', 'mv', 'comments', 'podcast-mine',
    ])
  })

  it('preserves native shortcut artwork and song favorite semantics', () => {
    const [resource] = normalizeNeteaseBlock({
      blockCode: 'DRAGON',
      showType: 'DRAGON_BALL',
      creatives: [{
        creativeId: 'daily',
        resourceId: '101',
        resourceType: 'song',
        uiElement: {
          mainTitle: { title: '每日推荐' },
          image: { imageUrl: 'http://image' },
          purePictureUrl: { purePictureUrl: 'http://pure-image' },
          purePicture: { purePicture: true },
          purePicName: { purePicName: 'daily' },
          rcmdShowType: { rcmdShowType: 'WITH_BACKGROUND' },
        },
        songData: { id: 101, name: 'Song', ar: [], al: {}, starred: true, starredNum: 99 },
        resourceInteractInfo: { collect: true, liked: false },
      }],
    }, 0).resources

    expect(resource).toMatchObject({
      coverUrl: 'https://image',
      purePictureUrl: 'https://pure-image',
      purePicture: true,
      purePicName: 'daily',
      recommendationShowType: 'WITH_BACKGROUND',
      isFavorite: true,
      favoriteCount: 99,
    })

    const comment = normalizeNeteaseBlock({
      creatives: [{ resourceId: '102', resourceType: 'COMMENT', songData: { id: 102, name: 'Commented', ar: [], al: {} }, resourceInteractInfo: { liked: true } }],
    }, 0).resources[0]
    expect(comment.isFavorite).toBe(false)
  })

  it('normalizes the dedicated daily-podcast response into a channel', () => {
    expect(normalizeNeteaseDailyPodcast({ voiceListId: 7, voiceListName: 'Daily voice', coverUrl: 'http://voice', category: 'Music' }, 0)).toMatchObject({
      id: '7',
      name: 'Daily voice',
      coverUrl: 'https://voice',
      group: 'Music',
      platform: 'netease',
    })
  })

  it('keeps unknown flow resources available for generic rendering', () => {
    const flow = normalizeNeteaseFlow({ data: { hasMore: true, resources: [{ resourceType: 'COMMENT', resourceId: '8', mainTitle: { title: 'A comment' }, extInfo: { futureField: true } }] } })
    expect(flow.hasMore).toBe(true)
    expect(flow.resources[0]).toMatchObject({ id: '8', type: 'comment', title: 'A comment' })
    expect(flow.resources[0].raw.extInfo.futureField).toBe(true)
  })

  it('normalizes raw arrays and heart-mode songInfo wrappers', () => {
    const songs = normalizeNeteaseSongs([
      { id: 101, name: 'Raw song', ar: [{ id: 1, name: 'Artist' }], al: { id: 2, name: 'Album', picUrl: 'http://cover' }, dt: 1200 },
      { songInfo: { id: 102, name: 'Heart song', artists: [{ id: 3, name: 'Singer' }], album: { id: 4, name: 'Heart album' }, duration: 2300 } },
    ])

    expect(songs).toHaveLength(2)
    expect(songs[0]).toMatchObject({ id: 101, platform: 'netease', duration: 1200 })
    expect(songs[0].album.picUrl).toBe('https://cover')
    expect(songs[1]).toMatchObject({ id: 102, name: 'Heart song', duration: 2300 })
  })

  it('accepts a valid profile from either account endpoint and rejects mismatches', () => {
    expect(authenticatedProfile(
      { code: 200, data: { profile: { userId: 42, nickname: 'Status' } } },
      { code: 301 },
    )).toMatchObject({ userId: '42', nickname: 'Status' })
    expect(authenticatedProfile(
      { code: 200 },
      { code: 200, data: { account: { profile: { id: 42, nickname: 'Account', avatarUrl: 'http://avatar' } } } },
    )).toEqual({ userId: '42', nickname: 'Account', avatarUrl: 'https://avatar' })
    expect(authenticatedProfile(
      { data: { profile: { userId: 42 } } },
      { profile: { userId: 43 } },
    )).toBeNull()
    expect(sessionReason('MUSIC_U=token', { profile: { userId: 42 } }, { profile: { userId: 43 } }, null)).toBe('profile-mismatch')
  })

  it('merges native roots, keeps deep artwork, and deduplicates entities by stable id', () => {
    const block = normalizeNeteaseBlock({
      creatives: [{ resourceId: '7', resourceType: 'song', action: 'orpheus://song/7?source=a', songData: { id: 7, name: 'Same song', ar: [], al: {} } }],
      dslData: { nested: { resourceId: '7', resourceType: 'song', action: 'orpheus://song/7?source=b', songData: { id: 7, name: 'Same song', ar: [], al: {} } } },
      crossPlatformConfig: { dslContent: { tile: { resourceId: '9', resourceType: 'playlist', action: 'orpheus://playlist/9', mainTitle: { title: 'Deep list' }, resourceExtInfo: { coverImageUrl: 'http://deep-cover' } } } },
    }, 0)

    expect(block.resources).toHaveLength(2)
    expect(block.resources.find(resource => resource.id === '9')).toMatchObject({ title: 'Deep list', coverUrl: 'https://deep-cover' })
    expect(dedupeNeteaseResources([...block.resources, block.resources[0]])).toHaveLength(2)
  })

  it('deduplicates initial flow and song API batches by entity id', () => {
    const resource = (action: string) => ({ resourceId: '8', resourceType: 'song', action, songData: { id: 8, name: 'One', ar: [], al: {} } })
    expect(normalizeNeteaseFlow({ data: { resources: [resource('orpheus://song/8?a=1'), resource('orpheus://song/8?a=2')] } }).resources).toHaveLength(1)
    expect(normalizeNeteaseSongs([{ id: 8, name: 'One', ar: [], al: {} }, { id: 8, name: 'One again', ar: [], al: {} }])).toHaveLength(1)
  })

  it('extracts nested artwork objects and preserves artist and scene section semantics', () => {
    const block = normalizeNeteaseBlock({
      blockCode: 'ARTIST_HOT',
      showType: 'HOMEPAGE_ARTIST_HOT',
      uiElement: { mainTitle: { title: 'LiSA等艺人热门金曲' } },
      resources: [{
        resourceId: 'artist-song-1',
        resourceType: 'song',
        mainTitle: { title: '听·LiSA热门精选|ADAMAS (TV Size)' },
        uiElement: { image: { image: { imageUrl: 'http://lisa-cover' } } },
        songData: { id: 399, name: 'ADAMAS', ar: [{ name: 'LiSA' }], al: { picUrl: 'http://album-cover' } },
      }],
    }, 0)
    expect(block.title).toBe('LiSA等艺人热门金曲')
    expect(block.resources[0]).toMatchObject({ title: '听·LiSA热门精选|ADAMAS (TV Size)', coverUrl: 'https://lisa-cover' })
  })

  it('inherits parent shortcut artwork and labels into resourceInfoList children', () => {
    const block = normalizeNeteaseBlock({
      showType: 'DRAGON_BALL',
      creatives: [{
        creativeId: 'shortcut-parent',
        mainTitle: { title: '漫游' },
        subTitle: { title: '多样频道无限畅听' },
        coverImageUrl: 'http://roam-cover',
        resourceInfoList: [{ resourceId: 'roam-1', resourceType: 'radio', action: 'orpheus://rnpage?component=roam' }],
      }],
    }, 0)
    expect(block.resources[0]).toMatchObject({ title: '漫游', subtitle: '多样频道无限畅听', coverUrl: 'https://roam-cover' })
  })

  it('normalizes a program mainSong using the shared song contract', () => {
    const [song] = normalizeNeteaseSongs([{ song: { id: 3363556036, name: 'Program audio', ar: [{ name: 'Host' }], al: { name: 'Radio' }, dt: 3210 } }])
    expect(song).toMatchObject({ id: 3363556036, name: 'Program audio', duration: 3210, platform: 'netease' })
  })

  it('preserves raw array bodies and strips upstream cookies', () => {
    const raw = [{ id: 1 }, { id: 2 }]
    expect(arrayResponseData(raw)).toBe(raw)
    expect(arrayResponseData({ data: raw })).toBe(raw)
    expect(responseBody({ body: { code: 200, cookie: ['secret'], data: raw } })).toEqual({ code: 200, data: raw })
  })

  it('only treats MUSIC_U as an authenticated account cookie', () => {
    expect(isAccountScopedCookie('MUSIC_A=anonymous')).toBe(false)
    expect(isAccountScopedCookie('foo=1; MUSIC_U=user-token; bar=2')).toBe(true)
    expect(isAccountScopedCookie('NOT_MUSIC_U=value')).toBe(false)
  })

  it('parses, trims, and deduplicates red-count ids', () => {
    expect(parseRedCountIds(' 186016,42,186016 ')).toEqual(['186016', '42'])
    expect(() => parseRedCountIds('')).toThrow('请提供歌曲 ID')
    expect(() => parseRedCountIds('1,nope')).toThrow('歌曲 ID 必须是逗号分隔的数字')
  })

  it('enforces the red-count hard limit after deduplication', () => {
    const ids = Array.from({ length: RED_COUNT_BATCH_LIMIT }, (_, index) => String(index + 1))
    expect(parseRedCountIds([...ids, ids[0]].join(','))).toHaveLength(RED_COUNT_BATCH_LIMIT)
    expect(() => parseRedCountIds([...ids, '999'].join(','))).toThrow(`一次最多查询 ${RED_COUNT_BATCH_LIMIT} 首歌曲`)
  })

  it('normalizes valid red-count bodies and rejects invalid counts', () => {
    expect(redCountFromBody({ code: 200, data: { count: 12 } })).toBe(12)
    expect(redCountFromBody({ code: 200, data: '34' })).toBe(34)
    expect(() => redCountFromBody({ code: 500, message: 'upstream failed' })).toThrow('upstream failed')
    expect(() => redCountFromBody({ code: 200, data: { count: -1 } })).toThrow('网易云返回了无效红心数量')
  })

  it('formats red counts keyed by id with per-item errors', () => {
    expect(formatRedCountBatch(['1', '2'], [
      { ok: true, count: 7 },
      { ok: false, error: 'timeout' },
    ])).toEqual({
      code: 200,
      counts: { 1: 7 },
      errors: { 2: 'timeout' },
      nativeProtocol: 'netease-android-9.5.81',
    })
  })

  it('uses the private red-count transport and preserves partial success', async () => {
    const routes = new Map<string, Function>()
    const calls: Array<{ uri: string; data: { songId: string }; crypto: string }> = []
    const app = { get: (path: string, handler: Function) => routes.set(path, handler) }
    const api = {
      api: async (request: { uri: string; data: { songId: string }; crypto: string }) => {
        calls.push(request)
        if (request.data.songId === '2') throw new Error('upstream failed')
        return { body: { code: 200, data: { count: Number(request.data.songId) * 10 } } }
      },
    }
    registerNeteaseNativeExploreRoutes(app, { getNeteaseApi: () => api })

    const response: { statusCode: number; headers: Record<string, string>; body?: unknown } = {
      statusCode: 200,
      headers: {},
    }
    const res = {
      status(code: number) { response.statusCode = code; return this },
      setHeader(name: string, value: string) { response.headers[name] = value },
      json(body: unknown) { response.body = body; return body },
    }
    const handler = routes.get('/api/netease/native/red-counts')
    expect(handler).toBeDefined()
    await handler?.({ query: { ids: '1,2,1' } }, res)

    expect(response.statusCode).toBe(200)
    expect(calls).toHaveLength(2)
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ uri: '/api/song/red/count', data: { songId: '1' }, crypto: 'weapi' }),
      expect.objectContaining({ uri: '/api/song/red/count', data: { songId: '2' }, crypto: 'weapi' }),
    ]))
    expect(response.body).toMatchObject({ counts: { 1: 10 }, errors: { 2: 'upstream failed' } })
  })
})
