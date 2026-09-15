import crypto from 'node:crypto'

// server/netease-native-explore.mjs

const HOME_PATH = '/api/homepage/block/page'
const FLOW_PATH = '/api/homepage/block/page/unlimited/flow'
const PODCAST_PATH = '/api/podcast/home/tab/v2/get'
const SIMILAR_PATHS = {
  songs: '/api/v1/discovery/simiSong',
  playlists: '/api/discovery/simiPlaylist',
  users: '/api/discovery/simiUser',
}
const DAILY_PATH = '/api/v3/discovery/recommend/songs'
const ROAM_PATH = '/api/v1/radio/get'
const HEART_PATH = '/api/playmode/intelligence/list'
const DAILY_PODCAST_PATH = '/api/my/podcast/tab/recommend'
const DAILY_HISTORY_PATH = '/api/discovery/recommend/songs/history/recent'
const DAILY_HISTORY_DETAIL_PATH = '/api/discovery/recommend/songs/history/detail'
const DAILY_STYLE_CONFIG_PATH = '/api/homepage/daily/song/config/get'
const DAILY_STYLE_SONGS_PATH = '/api/homepage/category/daily/song/list'
const RED_COUNT_PATH = '/api/song/red/count'
// 现代首页（Link Platform）：scene -> position -> page
const LINK_PAGE_PATH = '/api/link/page/rcmd/resource/show'
const LINK_POSITION_PATH = '/api/link/position/show/resource'
const CUBE_PAGE_PATH = '/api/cube/render/page/protocol'
const TOPLIST_PATH = '/api/toplist/detail/v2'
const PLAYLIST_SQUARE_PATH = '/api/playlist/square/block/page'
const PODCAST_INFINITE_PATH = '/api/podcast/rcmd/tab/infinite/blocks/get'
const TAG_PLAYLISTS_PATH = '/api/tag/tab/playlists'
const SIMI_SONG_PATH = '/api/v1/discovery/simiSong'
const ARTIST_TOP_SONG_PATH = '/api/v1/artist/top/song'
const VOICE_CATEGORY_PATH = '/api/voicelist/all/category/get'
const DJRADIO_HOT_PATH = '/api/djradio/hot'
const DJRADIO_BY_USER_PATH = '/api/djradio/get/byuser/v1'
const SONG_DETAIL_PATH = '/api/v3/song/detail'
const VIP_LEVEL_PATH = '/api/vipnewcenter/app/level/myvip'
const VIP_ACCOUNT_CARD_PATH = '/api/vipnewcenter/app/resource/newaccountpage'
const VIP_CONFIG_PATH = '/api/music-vip-configuration/config/query'
const VIP_RECOMMEND_SONGS_PATH = '/api/vipnewcenter/app/viptab/recommend/song/list'
export const TAG_PLAYLISTS_MAX_IDS = 50

/** 逗号分隔的纯数字 ID 列表 */
function parseIdList(raw, limit = 10) {
  const values = String(raw ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (values.some(value => !/^\d+$/.test(value))) return []
  return [...new Set(values)].slice(0, limit)
}
export const LINK_PAGE_CODES = ['HOME_RECOMMEND_PAGE', 'HOME_DISCOVERY_PAGE']
export const PODCAST_TAB_PAGE_CODE = 'INFINITE_PODCAST_HOMEPAGE_PODCAST_TAB'
export const MUSIC_CHANNEL_POSITION = 'music_top_tab_full'
export const RED_COUNT_BATCH_LIMIT = 40
const RED_COUNT_CONCURRENCY = 6
const RED_COUNT_TIMEOUT_MS = 8_000
const RED_COUNT_CACHE_TTL_MS = 5 * 60_000

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16)
}

export function responseBody(result) {
  const body = result?.body ?? result ?? {}
  if (!body || typeof body !== 'object') return { code: 502, message: '网易云返回了无效响应' }
  const { cookie: _cookie, ...safeBody } = body
  return safeBody
}

export function isAccountScopedCookie(cookie) {
  const match = String(cookie || '').match(/(?:^|;\s*)MUSIC_U=([^;]*)/)
  return Boolean(match?.[1]?.trim())
}

export function authenticatedProfile(statusBody, accountBody) {
  const profileOf = body => [
    body?.profile,
    body?.data?.profile,
    body?.account?.profile,
    body?.data?.account?.profile,
    body?.data?.userProfile,
  ].find(profile => /^\d+$/.test(String(profile?.userId || profile?.id || '')))
  const statusProfile = profileOf(statusBody)
  const accountProfile = profileOf(accountBody)
  const profiles = [accountProfile, statusProfile].filter(Boolean)
  if (profiles.length === 0) return null
  const ids = new Set(profiles.map(profile => String(profile.userId || profile.id)))
  if (ids.size !== 1) return null
  const profile = accountProfile || statusProfile
  return {
    userId: [...ids][0],
    nickname: String(profile?.nickname || statusProfile?.nickname || ''),
    avatarUrl: String(profile?.avatarUrl || statusProfile?.avatarUrl || '').replace(/^http:/, 'https:'),
  }
}

export function sessionReason(cookie, statusBody, accountBody, profile) {
  if (!isAccountScopedCookie(cookie)) return 'missing-account-cookie'
  if (profile) return ''
  const statusProfile = statusBody?.profile || statusBody?.data?.profile
  const accountProfile = accountBody?.profile || accountBody?.data?.profile
  const statusId = String(statusProfile?.userId || statusProfile?.id || '')
  const accountId = String(accountProfile?.userId || accountProfile?.id || '')
  if (/^\d+$/.test(statusId) && /^\d+$/.test(accountId) && statusId !== accountId) return 'profile-mismatch'
  return 'upstream-profile-missing'
}

export function arrayResponseData(body) {
  return Array.isArray(body) ? body : body?.data ?? body
}

function createTimedCache(ttlMs, maxEntries = 24) {
  const entries = new Map()
  return {
    get(key) {
      const item = entries.get(key)
      if (!item || item.expiresAt <= Date.now()) {
        entries.delete(key)
        return null
      }
      return item.value
    },
    set(key, value) {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs })
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    },
  }
}

const homeCache = createTimedCache(90_000)
const podcastCache = createTimedCache(3 * 60_000)
const redCountCache = createTimedCache(RED_COUNT_CACHE_TTL_MS, 1_000)
const linkPageCache = createTimedCache(60_000, 48)
const channelCache = createTimedCache(5 * 60_000)
const cubeCache = createTimedCache(5 * 60_000, 64)
const toplistCache = createTimedCache(5 * 60_000)
const squareCache = createTimedCache(90_000, 48)
const podcastInfiniteCache = createTimedCache(2 * 60_000, 48)
const tagPlaylistsCache = createTimedCache(2 * 60_000, 128)
const podcastCategoriesCache = createTimedCache(5 * 60_000)
const vipPageCache = createTimedCache(5 * 60_000)

async function callPrivate(getNeteaseApi, uri, data, cookie, crypto = 'weapi') {
  const api = getNeteaseApi()
  if (!api?.api) throw new Error('网易云 API 尚未初始化')
  const result = await api.api({ uri, data, crypto, cookie: String(cookie || '') })
  return responseBody(result)
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

export function parseRedCountIds(rawIds, limit = RED_COUNT_BATCH_LIMIT) {
  const values = String(rawIds ?? '').split(',').map(value => value.trim())
  if (values.length === 1 && !values[0]) throw new Error('请提供歌曲 ID')
  if (values.some(value => !/^\d+$/.test(value))) throw new Error('歌曲 ID 必须是逗号分隔的数字')

  const ids = [...new Set(values)]
  if (ids.length > limit) throw new Error(`一次最多查询 ${limit} 首歌曲`)
  return ids
}

export function redCountFromBody(body) {
  if (Number(body?.code) !== 200) throw new Error(body?.message || body?.error || '网易云红心数量请求失败')
  const value = body?.data?.count ?? body?.data?.redCount ?? body?.data ?? body?.count ?? body?.redCount
  const count = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('网易云返回了无效红心数量')
  return count
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export function formatRedCountBatch(ids, results) {
  const counts = {}
  const errors = {}
  ids.forEach((id, index) => {
    const result = results[index]
    if (result?.ok) counts[id] = result.count
    else errors[id] = result?.error || '请求失败'
  })
  return { code: 200, counts, errors, nativeProtocol: 'netease-android-9.5.81' }
}

function defaultExtInfo(raw) {
  if (raw) {
    try { return JSON.stringify(JSON.parse(String(raw))) } catch { /* use the client-compatible default */ }
  }
  return JSON.stringify({
    netstat: 1,
    guideToastLastShow: 0,
    carrier: '',
    abInfo: { 'hp-new-homepageV3.1': '' },
    requestLongVideoBanner: true,
    refreshType: 1,
    forceFreshForNewUser: false,
  })
}

export function registerNeteaseNativeExploreRoutes(app, { getNeteaseApi }) {
  app.get('/api/netease/native/session-status', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      if (!isAccountScopedCookie(cookie)) return res.json({ code: 200, authenticated: false, reason: 'missing-account-cookie' })
      const api = getNeteaseApi()
      if (!api?.login_status || !api?.user_account) throw new Error('网易云账号接口尚未初始化')
      const [statusResult, accountResult] = await Promise.all([api.login_status({ cookie }), api.user_account({ cookie })])
      const statusBody = responseBody(statusResult)
      const accountBody = responseBody(accountResult)
      const profile = authenticatedProfile(statusBody, accountBody)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ code: 200, authenticated: Boolean(profile), profile, reason: sessionReason(cookie, statusBody, accountBody, profile) })
    } catch (error) {
      res.status(502).json({ code: 502, authenticated: null, error: error?.message || '网易云账号状态验证失败' })
    }
  })

  app.get('/api/netease/native/home', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const refresh = String(req.query.refresh || '') === '1'
      const cursor = String(req.query.cursor || '')
      const cacheKey = `${fingerprint(cookie)}:${cursor || 'first'}`
      if (!refresh) {
        const cached = homeCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, HOME_PATH, {
        cursor: cursor || null,
        adextjson: String(req.query.adextjson || ''),
        refresh,
        extInfo: defaultExtInfo(req.query.extInfo),
      }, cookie)
      const payload = {
        ...body,
        nativeProtocol: 'netease-android-9.5.81',
        accountScoped: isAccountScopedCookie(cookie),
        generatedAt: Date.now(),
      }
      if (Number(body.code) === 200) homeCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云原生推荐加载失败' })
    }
  })

  app.get('/api/netease/native/unlimited-flow', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, FLOW_PATH, {}, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云首页乐流加载失败' })
    }
  })

  app.get('/api/netease/native/daily-songs', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, DAILY_PATH, { ispush: false }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云每日推荐加载失败' })
    }
  })

  app.get('/api/netease/native/daily-history', async (req, res) => {
    try {
      const date = String(req.query.date || '')
      const uri = date ? DAILY_HISTORY_DETAIL_PATH : DAILY_HISTORY_PATH
      const body = await callPrivate(getNeteaseApi, uri, date ? { date } : {}, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云历史日推加载失败' })
    }
  })

  app.get('/api/netease/native/daily-style', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const categoryId = String(req.query.categoryId || '')
      const tagId = String(req.query.tagId || '')
      const uri = categoryId || tagId ? DAILY_STYLE_SONGS_PATH : DAILY_STYLE_CONFIG_PATH
      const data = uri === DAILY_STYLE_CONFIG_PATH ? {} : {
        source: 'dailyrecommend',
        tagId,
        categoryId,
        songId: Number(req.query.songId) || 0,
      }
      const body = await callPrivate(getNeteaseApi, uri, data, cookie)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云风格日推加载失败' })
    }
  })

  app.get('/api/netease/native/roam', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, ROAM_PATH, {
        mode: String(req.query.mode || 'DEFAULT'),
        subMode: String(req.query.subMode || ''),
        limit: Math.max(1, Math.min(50, Number(req.query.limit) || 30)),
        entranceType: String(req.query.entranceType || ''),
        unplaySongIds: String(req.query.unplaySongIds || '[]'),
        fmCascadeModeStr: String(req.query.fmCascadeModeStr || ''),
        openAidj: String(req.query.openAidj || '') === '1',
        aidjReqTimes: Math.max(0, Number(req.query.aidjReqTimes) || 0),
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ code: 200, data: arrayResponseData(body), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云私人漫游加载失败' })
    }
  })

  app.get('/api/netease/native/heart-mode', async (req, res) => {
    try {
      const songId = String(req.query.songId || '')
      const playlistId = String(req.query.playlistId || '')
      if (!/^\d+$/.test(songId) || !/^\d+$/.test(playlistId)) return res.status(400).json({ code: 400, error: '心动模式需要歌曲和我喜欢歌单' })
      const body = await callPrivate(getNeteaseApi, HEART_PATH, {
        songId,
        type: String(req.query.type || 'fromPlayOne'),
        playlistId,
        startMusicId: String(req.query.startMusicId || songId),
        count: Math.max(1, Math.min(50, Number(req.query.count) || 30)),
        extJson: String(req.query.extJson || '{}'),
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云心动模式加载失败' })
    }
  })

  app.get('/api/netease/native/red-counts', async (req, res) => {
    let ids
    try {
      ids = parseRedCountIds(req.query.ids)
    } catch (error) {
      return res.status(400).json({ code: 400, error: error?.message || '歌曲 ID 无效' })
    }

    const cookie = String(req.query.cookie || '')
    const results = await mapWithConcurrency(ids, RED_COUNT_CONCURRENCY, async id => {
      const cached = redCountCache.get(id)
      if (cached !== null) return { ok: true, count: cached }
      try {
        const body = await withTimeout(
          callPrivate(getNeteaseApi, RED_COUNT_PATH, { songId: id }, cookie),
          RED_COUNT_TIMEOUT_MS,
          '网易云红心数量请求超时',
        )
        const count = redCountFromBody(body)
        redCountCache.set(id, count)
        return { ok: true, count }
      } catch (error) {
        return { ok: false, error: error?.message || '请求失败' }
      }
    })

    res.setHeader('Cache-Control', 'private, max-age=60')
    res.json(formatRedCountBatch(ids, results))
  })

  app.get('/api/netease/native/similar-context', async (req, res) => {
    try {
      const songId = String(req.query.songId || '')
      if (!/^\d+$/.test(songId)) return res.status(400).json({ code: 400, error: '请提供当前歌曲 ID' })
      const cookie = String(req.query.cookie || '')
      const data = { songid: Number(songId) }
      const [songs, playlists, users] = await Promise.allSettled(
        Object.values(SIMILAR_PATHS).map(uri => withTimeout(
          callPrivate(getNeteaseApi, uri, data, cookie),
          12_000,
          '相似推荐子请求超时',
        )),
      )
      const value = result => result.status === 'fulfilled' ? result.value : { code: 502, error: result.reason?.message || '请求失败' }
      res.setHeader('Cache-Control', 'private, max-age=60')
      res.json({ code: 200, songId, songs: value(songs), playlists: value(playlists), users: value(users), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云相似推荐加载失败' })
    }
  })

  app.get('/api/netease/native/program-detail', async (req, res) => {
    try {
      const id = String(req.query.id || '')
      if (!/^\d+$/.test(id)) return res.status(400).json({ code: 400, error: '请提供节目 ID' })
      const api = getNeteaseApi()
      if (!api?.dj_program_detail) return res.status(503).json({ code: 503, error: '网易云节目接口未初始化' })
      const result = await api.dj_program_detail({ id, cookie: String(req.query.cookie || '') })
      const body = responseBody(result)
      res.setHeader('Cache-Control', 'private, max-age=120')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云节目加载失败' })
    }
  })

  app.get('/api/netease/native/daily-podcast', async (req, res) => {
    try {
      const body = await callPrivate(getNeteaseApi, DAILY_PODCAST_PATH, {
        scenePageCode: 'PAGE_MY_PODCAST',
        blockCode: 'MY_PAGE_PODCAST_RECOMMEND',
      }, String(req.query.cookie || ''))
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ code: 200, data: arrayResponseData(body), nativeProtocol: 'netease-android-9.5.81' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云每日播客加载失败' })
    }
  })

  app.get('/api/netease/native/podcast-home', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      const cached = podcastCache.get(cacheKey)
      if (cached) return res.json(cached)
      const body = await callPrivate(getNeteaseApi, PODCAST_PATH, {
        pageCode: 'PODCAST_TAB_V2',
        subParams: String(req.query.subParams || '{}'),
      }, cookie)
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.90' }
      if (Number(body.code) === 200) podcastCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云播客推荐加载失败' })
    }
  })

  // Link Platform 页面：推荐页(HOME_RECOMMEND_PAGE) / 发现-音乐-精选(HOME_DISCOVERY_PAGE)
  app.get('/api/netease/native/link-page', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const pageCode = String(req.query.pageCode || '')
      if (!LINK_PAGE_CODES.includes(pageCode)) return res.status(400).json({ code: 400, error: '不支持的页面代码' })
      const cursor = String(req.query.cursor || '0')
      const refresh = String(req.query.refresh || '') === '1'
      // 翻页（cursor>0）必须回传上一页的 blockCodeOrderList，且必须是原始 JSON 字符串
      // （实测 9.5.90：传数组会 500；缺该字段也会 500）
      let orderString = ''
      const rawOrder = String(req.query.order || '')
      if (rawOrder) {
        try {
          const parsed = JSON.parse(rawOrder)
          orderString = Array.isArray(parsed) ? JSON.stringify(parsed.map(String)) : String(rawOrder)
        } catch {
          const list = rawOrder.split(',').map(value => value.trim()).filter(Boolean)
          orderString = list.length > 0 ? JSON.stringify(list) : ''
        }
      }
      const cacheKey = `${fingerprint(cookie)}:${pageCode}:${cursor || '0'}`
      if (!refresh && cursor === '0') {
        const cached = linkPageCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const data = {
        pageCode,
        cursor: /^\d+$/.test(cursor) ? Number(cursor) : cursor,
        isFirstScreen: (!cursor || cursor === '0') ? 'true' : 'false',
        refresh: refresh ? 'true' : 'false',
        header: '{}',
        e_r: true,
      }
      if (orderString) data.blockCodeOrderList = orderString
      const body = await callPrivate(getNeteaseApi, LINK_PAGE_PATH, data, cookie, 'eapi')
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.90', accountScoped: isAccountScopedCookie(cookie) }
      if (Number(body.code) === 200 && cursor === '0') linkPageCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云页面加载失败' })
    }
  })

  // 发现-音乐 频道列表（music_top_tab_full）
  app.get('/api/netease/native/music-channels', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      if (String(req.query.refresh || '') !== '1') {
        const cached = channelCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, LINK_POSITION_PATH, {
        positionCode: MUSIC_CHANNEL_POSITION,
        header: '{}',
        e_r: true,
      }, cookie, 'eapi')
      const channelItems = body?.data?.generalizedSceneShow?.generalizedMap?.nowChannelItems
      const payload = {
        code: Number(body.code) === 200 ? 200 : Number(body.code) || 502,
        nativeProtocol: 'netease-android-9.5.90',
        channels: Array.isArray(channelItems) ? channelItems : [],
      }
      if (payload.code === 200) channelCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云频道列表加载失败' })
    }
  })

  // 曲风频道页面协议（cube-renderer-rn），pageId 来自频道 url 的 page 参数
  app.get('/api/netease/native/cube-page', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const pageId = String(req.query.pageId || '')
      if (!/^[a-z0-9]{8,64}$/i.test(pageId)) return res.status(400).json({ code: 400, error: '请提供有效的页面 ID' })
      const cacheKey = `${fingerprint(cookie)}:${pageId}`
      if (String(req.query.refresh || '') !== '1') {
        const cached = cubeCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, CUBE_PAGE_PATH, { pageId, scene: 'music' }, cookie, 'weapi')
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.90' }
      if (Number(body.code) === 200) cubeCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云曲风页面加载失败' })
    }
  })

  // 排行榜（发现-音乐-排行榜）
  app.get('/api/netease/native/toplist', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      if (String(req.query.refresh || '') !== '1') {
        const cached = toplistCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, TOPLIST_PATH, {}, cookie, 'eapi')
      const payload = { code: Number(body.code) === 200 ? 200 : Number(body.code) || 502, nativeProtocol: 'netease-android-9.5.90', data: arrayResponseData(body) }
      if (payload.code === 200) toplistCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云排行榜加载失败' })
    }
  })

  // 歌单广场（发现-音乐-歌单）
  app.get('/api/netease/native/playlist-square', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const categoryName = String(req.query.categoryName || '推荐')
      const offset = Math.max(0, Number(req.query.offset) || 0)
      const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20))
      const cacheKey = `${fingerprint(cookie)}:${categoryName}:${offset}:${limit}`
      if (String(req.query.refresh || '') !== '1') {
        const cached = squareCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, PLAYLIST_SQUARE_PATH, { categoryName, offset, limit }, cookie, 'weapi')
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.90' }
      if (Number(body.code) === 200) squareCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云歌单广场加载失败' })
    }
  })

  // 发现-播客 无限流（听书同为该接口，本项目不接入）
  app.get('/api/netease/native/podcast-infinite', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const pageCode = String(req.query.pageCode || PODCAST_TAB_PAGE_CODE)
      if (pageCode !== PODCAST_TAB_PAGE_CODE) return res.status(400).json({ code: 400, error: '不支持的播客页面代码' })
      const cursor = String(req.query.cursor || '')
      const cacheKey = `${fingerprint(cookie)}:${pageCode}:${cursor || '0'}`
      if (String(req.query.refresh || '') !== '1' && !cursor) {
        const cached = podcastInfiniteCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, PODCAST_INFINITE_PATH, {
        pageCode,
        isFirstScreen: cursor ? 'false' : 'true',
        cursor: cursor || undefined,
        header: '{}',
        e_r: true,
        extInfo: JSON.stringify({ isTabEntry: '1', rnVersion: '1.0.0' }),
      }, cookie, 'eapi')
      const payload = { ...body, nativeProtocol: 'netease-android-9.5.90' }
      if (Number(body.code) === 200 && !cursor) podcastInfiniteCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, no-store')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云播客无限流加载失败' })
    }
  })

  // 播客「全部分类」：一级/二级分类（App 内 RN 页的站内替代）
  app.get('/api/netease/native/podcast-categories', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      if (String(req.query.refresh || '') !== '1') {
        const cached = podcastCategoriesCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, VOICE_CATEGORY_PATH, {}, cookie, 'weapi')
      const payload = { code: Number(body.code) === 200 ? 200 : Number(body.code) || 502, nativeProtocol: 'netease-android-9.5.90', data: arrayResponseData(body) }
      if (payload.code === 200) podcastCategoriesCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云播客分类加载失败' })
    }
  })

  // 分类下的播客（/api/djradio/hot，cateId 来自分类接口）
  app.get('/api/netease/native/podcast-category-radios', async (req, res) => {
    try {
      const categoryId = String(req.query.categoryId || '')
      if (!/^\d+$/.test(categoryId)) return res.status(400).json({ code: 400, error: '请提供分类 ID' })
      const limit = Math.max(1, Math.min(60, Number(req.query.limit) || 18))
      const offset = Math.max(0, Number(req.query.offset) || 0)
      const cookie = String(req.query.cookie || '')
      const body = await callPrivate(getNeteaseApi, DJRADIO_HOT_PATH, { cateId: Number(categoryId), limit, offset }, cookie, 'weapi')
      res.setHeader('Cache-Control', 'private, max-age=120')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.90' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云分类播客加载失败' })
    }
  })

  // 我的播客（电台订阅）
  app.get('/api/netease/native/my-podcasts', async (req, res) => {
    try {
      const userId = String(req.query.userId || '')
      if (!/^\d+$/.test(userId)) return res.status(400).json({ code: 400, error: '请提供用户 ID' })
      const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30))
      const offset = Math.max(0, Number(req.query.offset) || 0)
      const cookie = String(req.query.cookie || '')
      const body = await callPrivate(getNeteaseApi, DJRADIO_BY_USER_PATH, { userId: Number(userId), limit, offset }, cookie, 'weapi')
      res.setHeader('Cache-Control', 'private, no-store')
      res.json({ ...body, nativeProtocol: 'netease-android-9.5.90' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云我的播客加载失败' })
    }
  })

  // VIP 频道：App 是 RN 会员门户，这里用同一批接口取「会员等级 + 权益 + 推荐」站内渲染
  // VIP 频道：按 App 真实结构（会员卡 + 权益图标 + 每天免费听VIP歌曲）取数
  app.get('/api/netease/native/vip-page', async (req, res) => {
    try {
      const cookie = String(req.query.cookie || '')
      const cacheKey = fingerprint(cookie)
      if (String(req.query.refresh || '') !== '1') {
        const cached = vipPageCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const [cardBody, levelBody, configBody, songBody] = await Promise.all([
        callPrivate(getNeteaseApi, VIP_ACCOUNT_CARD_PATH, { groupName: 't2' }, cookie, 'eapi').catch(() => null),
        callPrivate(getNeteaseApi, VIP_LEVEL_PATH, {}, cookie, 'eapi').catch(() => null),
        callPrivate(getNeteaseApi, VIP_CONFIG_PATH, { configName: 'vip.tab.rights' }, cookie, 'eapi').catch(() => null),
        callPrivate(getNeteaseApi, VIP_RECOMMEND_SONGS_PATH, {}, cookie, 'eapi').catch(() => null),
      ])
      const card = cardBody?.data || {}
      const levels = levelBody?.data || {}
      // /music-vip-configuration/config/query 的 data 是 JSON 字符串
      let config = configBody?.data
      if (typeof config === 'string') { try { config = JSON.parse(config) } catch { config = null } }
      const songsData = songBody?.data || {}
      const reasons = new Map((Array.isArray(songsData.reasonList) ? songsData.reasonList : [])
        .map(item => [String(item?.songId || ''), String(item?.reason || '')]))
      const payload = {
        code: 200,
        nativeProtocol: 'netease-android-9.5.90',
        card: {
          levelImage: String(card?.mainTitle?.imgUrl || ''),
          level: Number(card?.mainTitle?.vipCurrLevel || levels?.levelInfo?.level || 0),
          nextLevel: Number(card?.mainTitle?.nextLevel || 0),
          percent: Number(card?.mainTitle?.subPercent || 0),
          carousels: (Array.isArray(card?.subTitle?.carousels) ? card.subTitle.carousels : []).map(String),
          buttonTitle: String(card?.buttonTitle?.title || ''),
          buttonUrl: String(card?.buttonTitle?.jumpUrl || ''),
        },
        level: {
          levelTitle: String(levels?.levelInfo?.levelTitle || ''),
          nextLevelTitle: String(levels?.levelInfo?.nextLevelTitle || ''),
          growthPoint: Number(levels?.levelInfo?.growthPoint || 0),
          nextLevelGrowthPoint: Number(levels?.levelInfo?.nextLevelGrowthPoint || 0),
        },
        privileges: (Array.isArray(config?.vip) ? config.vip : [])
          .map(item => ({ title: String(item?.title || ''), icon: String(item?.icon || '') }))
          .filter(item => item.title),
        songs: (Array.isArray(songsData.songInfoList) ? songsData.songInfoList : []).map(song => ({
          ...song,
          reason: reasons.get(String(song?.id || '')) || '',
        })),
      }
      vipPageCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云会员页加载失败' })
    }
  })

  // 歌曲详情（新歌新碟这类只给 orpheus://song/<id> 的卡片，先取详情再播放）
  app.get('/api/netease/native/song-detail', async (req, res) => {
    try {
      const ids = parseIdList(req.query.ids, 20)
      if (ids.length === 0) return res.status(400).json({ code: 400, error: '请提供歌曲 ID' })
      const cookie = String(req.query.cookie || '')
      const body = await callPrivate(getNeteaseApi, SONG_DETAIL_PATH, { c: JSON.stringify(ids.map(id => ({ id: Number(id) }))) }, cookie, 'weapi')
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.json({ code: Number(body.code) === 200 ? 200 : Number(body.code) || 502, songs: body.songs || body.data?.songs || [], nativeProtocol: 'netease-android-9.5.90' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云歌曲详情加载失败' })
    }
  })

  // 相似歌曲：以「推荐页相似歌曲卡片」自带的种子歌曲 id 拉相似歌曲（不依赖当前播放）
  app.get('/api/netease/native/similar-songs', async (req, res) => {
    try {
      const ids = parseIdList(req.query.ids, 3)
      if (ids.length === 0) return res.status(400).json({ code: 400, error: '请提供种子歌曲 ID' })
      const cookie = String(req.query.cookie || '')
      const results = await Promise.all(ids.map(id => withTimeout(
        callPrivate(getNeteaseApi, SIMI_SONG_PATH, { songid: Number(id), limit: 20 }, cookie, 'weapi'),
        12_000, '相似歌曲子请求超时',
      ).catch(() => null)))
      const songs = []
      const seen = new Set()
      for (const body of results) {
        const list = body?.songs || body?.data?.songs || []
        for (const song of Array.isArray(list) ? list : []) {
          const songId = String(song?.id || '')
          if (!songId || seen.has(songId)) continue
          seen.add(songId)
          songs.push(song)
        }
      }
      res.setHeader('Cache-Control', 'private, max-age=120')
      res.json({ code: 200, songs, seeds: ids, nativeProtocol: 'netease-android-9.5.90' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云相似歌曲加载失败' })
    }
  })

  // 相似艺人：以卡片自带艺人 id 取热门歌曲（不依赖当前播放）
  app.get('/api/netease/native/artist-radio', async (req, res) => {
    try {
      const ids = parseIdList(req.query.ids, 3)
      if (ids.length === 0) return res.status(400).json({ code: 400, error: '请提供艺人 ID' })
      const cookie = String(req.query.cookie || '')
      const results = await Promise.all(ids.map(id => withTimeout(
        callPrivate(getNeteaseApi, ARTIST_TOP_SONG_PATH, { id: Number(id) }, cookie, 'weapi'),
        12_000, '艺人热门歌曲子请求超时',
      ).catch(() => null)))
      const songs = []
      const seen = new Set()
      for (const body of results) {
        const list = body?.songs || body?.data?.songs || []
        for (const song of Array.isArray(list) ? list : []) {
          const songId = String(song?.id || '')
          if (!songId || seen.has(songId)) continue
          seen.add(songId)
          songs.push(song)
        }
      }
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.json({ code: 200, songs, seeds: ids, nativeProtocol: 'netease-android-9.5.90' })
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云相似艺人加载失败' })
    }
  })

  // 曲风页里只下发 id 的卡片，用该接口批量补封面/标题/播放量（eapi /api/tag/tab/playlists）
  app.get('/api/netease/native/tag-playlists', async (req, res) => {
    try {
      const raw = String(req.query.ids || '').trim()
      if (!raw) return res.status(400).json({ code: 400, error: '请提供歌单 ID' })
      const ids = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))]
      if (ids.some(id => !/^\d+$/.test(id))) return res.status(400).json({ code: 400, error: '歌单 ID 必须是逗号分隔的数字' })
      if (ids.length > TAG_PLAYLISTS_MAX_IDS) return res.status(400).json({ code: 400, error: `一次最多查询 ${TAG_PLAYLISTS_MAX_IDS} 个歌单` })
      const cookie = String(req.query.cookie || '')
      const cacheKey = `${fingerprint(cookie)}:${ids.join(',')}`
      if (String(req.query.refresh || '') !== '1') {
        const cached = tagPlaylistsCache.get(cacheKey)
        if (cached) return res.json(cached)
      }
      const body = await callPrivate(getNeteaseApi, TAG_PLAYLISTS_PATH, { ids: ids.join(',') }, cookie, 'eapi')
      const payload = { code: Number(body.code) === 200 ? 200 : Number(body.code) || 502, nativeProtocol: 'netease-android-9.5.90', data: arrayResponseData(body) }
      if (payload.code === 200) tagPlaylistsCache.set(cacheKey, payload)
      res.setHeader('Cache-Control', 'private, max-age=120')
      res.json(payload)
    } catch (error) {
      res.status(502).json({ code: 502, error: error?.message || '网易云歌单详情加载失败' })
    }
  })
}
