// 酷狗签名网关模块（借鉴 Mineradio 逆向成果，GPL-3.0）
// www.kugou.com 的 r=user/* 接口对服务端请求有 WAF（Access Deny），
// 但 gateway.kugou.com 的签名接口（Android/H5 双签名 + x-router）可用服务端直连。
// 盐值/算法为酷狗客户端逆向公开成果。
import crypto from 'node:crypto'

const KUGOU_HEADERS = {
  Referer: 'https://www.kugou.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}
const KUGOU_GATEWAY = 'https://gateway.kugou.com'
const KUGOU_APPID = 1005
const KUGOU_WEB_APPID = 1014
const KUGOU_CLIENTVER = 20489
const KUGOU_ANDROID_SALT = 'OIlwieks28dk2k092lksi2UIkp'
const KUGOU_H5_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
const KUGOU_H5_SRC_APPID = '2919'
const KUGOU_H5_CLIENTVER = '20000'
const KUGOU_SIGN_KEY_SALT = '57ae12eb6890223e355ccfcb74edf70d'
const KUGOU_GATEWAY_UA = 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi'
const KUGOU_H5_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const KUGOU_SEARCH_URL = 'http://songsearch.kugou.com/song_search_v2'
const KUGOU_PLAY_MOBILE = 'https://m.kugou.com/app/i/getSongInfo.php'
const KUGOU_PLAY_WEB = 'https://wwwapi.kugou.com/yy/index.php'
const KUGOU_LYRIC_SEARCH = 'https://krcs.kugou.com/search'
const KUGOU_LYRIC_DOWNLOAD = 'https://krcs.kugou.com/download'

// ─────────────────────────── 基础工具 ───────────────────────────

async function requestText(targetUrl, opts, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (opts && opts.timeout) || 12000)
  try {
    const resp = await fetch(targetUrl, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.headers,
      body: body || undefined,
      signal: controller.signal,
    })
    return await resp.text()
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(targetUrl, opts, body) {
  const text = await requestText(targetUrl, opts, body)
  try { return JSON.parse(text) } catch { return null }
}

function parseCookieString(cookie) {
  const out = {}
  String(cookie || '').split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx <= 0) return
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  })
  return out
}

function parseKuGooCompound(raw) {
  const out = {}
  let text = String(raw || '').trim()
  if (!text) return out
  try { text = decodeURIComponent(text) } catch { /* 保持原样 */ }
  text.split('&').forEach(part => {
    const idx = part.indexOf('=')
    if (idx <= 0) return
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  })
  return out
}

/** 从酷狗 Cookie 提取认证信息（userid/token/mid/dfid）；token 来自 KuGoo 复合值里的 t 字段 */
export function extractKugouAuth(cookie) {
  const obj = parseCookieString(cookie)
  const kugoo = parseKuGooCompound(obj.KuGoo || obj.kugou || obj.Kugou || '')
  const userid = String(
    obj.userid || obj.UserId || obj.KugooID || obj.kugouID ||
    kugoo.KugooID || kugoo.kugouID || kugoo.userid || kugoo.uid || '',
  ).replace(/\D/g, '')
  const token = String(obj.token || obj.Token || obj.t || obj.T || kugoo.t || kugoo.token || '').trim()
  const mid = String(obj.kg_mid || obj.KG_MID || obj.mid || '').trim()
  const dfid = String(obj.kg_dfid || obj.KG_DFID || obj.dfid || obj.DFID || '-').trim()
  const nickname = String(kugoo.NickName || kugoo.nickname || obj.NickName || obj.nickname || '').trim()
  const avatar = String(kugoo.Pic || kugoo.pic || obj.Pic || obj.avatar || '').trim()
  const loggedIn = !!(userid && userid !== '0') || !!(obj.KuGoo || obj.kugou || obj.Kugou)
  const playbackReady = !!(userid && userid !== '0' && token)
  return { userid, token, mid, dfid, nickname, avatar, loggedIn, playbackReady }
}

function buildKugouRequestCookie(cookie) {
  const obj = parseCookieString(cookie)
  const mid = obj.kg_mid || obj.KG_MID || ''
  const dfid = obj.kg_dfid || obj.KG_DFID || '-'
  const parts = []
  if (cookie) parts.push(String(cookie).trim())
  if (!mid) parts.push('kg_mid=' + mid)
  if (!dfid) parts.push('kg_dfid=' + dfid)
  const merged = {}
  parts.join('; ').split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx <= 0) return
    merged[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  })
  return Object.keys(merged).map(k => `${k}=${merged[k]}`).join('; ')
}

// ─────────────────────────── 签名 ───────────────────────────

function signatureH5Params(params, bodyObj) {
  const parts = Object.keys(params).sort().map(key => `${key}=${params[key]}`)
  if (bodyObj && typeof bodyObj === 'object') parts.push(JSON.stringify(bodyObj))
  return crypto.createHash('md5').update(`${KUGOU_H5_SALT}${parts.join('')}${KUGOU_H5_SALT}`).digest('hex')
}

function signatureAndroidParams(params, data) {
  const paramsString = Object.keys(params).sort()
    .map(key => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('')
  return crypto.createHash('md5').update(`${KUGOU_ANDROID_SALT}${paramsString}${data || ''}${KUGOU_ANDROID_SALT}`).digest('hex')
}

function signKey(hash, mid, userid, appid) {
  return crypto.createHash('md5').update(`${hash}${KUGOU_SIGN_KEY_SALT}${appid || KUGOU_APPID}${mid}${userid || 0}`).digest('hex')
}

function kugouCloudKey(hash) {
  return crypto.createHash('md5').update(String(hash || '') + 'kgcloud').digest('hex')
}

function buildKugouH5Params(auth, extra) {
  auth = auth || {}
  const now = Date.now()
  return Object.assign({
    srcappid: KUGOU_H5_SRC_APPID,
    clientver: KUGOU_H5_CLIENTVER,
    clienttime: now,
    mid: auth.mid || '',
    uuid: now,
    dfid: auth.dfid || '-',
    appid: KUGOU_WEB_APPID,
    token: auth.token || '',
    userid: auth.userid ? Number(auth.userid) : 0,
  }, extra || {})
}

/** H5 签名网关请求（用于用户歌单/收藏/播放等需登录接口） */
export async function kugouH5GatewayRequest(path, opts) {
  opts = opts || {}
  const auth = extractKugouAuth(opts.cookie || '')
  if (!auth.playbackReady) throw new Error('KUGOU_AUTH_REQUIRED')
  const bodyObj = opts.body == null ? null : (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body)
  const bodyText = bodyObj == null ? '' : JSON.stringify(bodyObj)
  const params = buildKugouH5Params(auth, opts.params || {})
  params.signature = signatureH5Params(params, bodyObj)
  const u = new URL(path, opts.baseURL || KUGOU_GATEWAY)
  Object.keys(params).forEach(key => u.searchParams.set(key, String(params[key])))
  const headers = Object.assign({}, KUGOU_HEADERS, {
    'User-Agent': KUGOU_H5_UA,
    Cookie: buildKugouRequestCookie(opts.cookie || ''),
  }, opts.headers || {})
  if (opts.router) headers['x-router'] = opts.router
  const json = await requestJson(u.toString(), { method: opts.method || (bodyObj == null ? 'GET' : 'POST'), headers }, bodyText || undefined)
  if (json && Number(json.status) === 0) {
    const err = new Error(json.error || json.msg || json.message || 'KUGOU_GATEWAY_FAILED')
    err.body = json
    throw err
  }
  return json
}

// ─────────────────────────── 播放 URL（四层策略） ───────────────────────────

function normalizeQualityPreference(q) {
  q = String(q || 'standard').toLowerCase()
  return ['jymaster', 'hires', 'lossless', 'exhigh', 'standard'].includes(q) ? q : 'standard'
}

function kugouQualityParam(requestedQuality) {
  const level = normalizeQualityPreference(requestedQuality)
  if (level === 'jymaster') return 'viper_tape'
  if (level === 'hires') return 'hires'
  if (level === 'lossless') return 'flac'
  if (level === 'exhigh') return '320'
  return '128'
}

function pickKugouPlayUrl(json) {
  if (!json) return ''
  const pick = (val) => (Array.isArray(val) ? val.find(Boolean) || '' : val || '')
  const data = json.data || {}
  return String(
    pick(json.url) || pick(json.play_url) || pick(json.backupUrl) ||
    pick(data.url) || pick(data.play_url) || pick(data.backupUrl) || '',
  ).replace(/\\\//g, '/').trim()
}

async function kugouPlayViaMobile(hash, albumId, cookie, userid) {
  const key = kugouCloudKey(hash)
  const u = new URL(KUGOU_PLAY_MOBILE)
  u.searchParams.set('cmd', 'playInfo')
  u.searchParams.set('hash', hash)
  u.searchParams.set('key', key)
  u.searchParams.set('album_id', albumId || '0')
  u.searchParams.set('pid', '1')
  u.searchParams.set('forceDown', '0')
  if (userid) u.searchParams.set('userid', userid)
  const json = await requestJson(u.toString(), {
    headers: { ...KUGOU_HEADERS, Referer: 'https://m.kugou.com/', Cookie: buildKugouRequestCookie(cookie) },
  })
  const url = json && (json.url || json.backup_url)
  if (json && Number(json.status) === 1 && url) {
    return { url: String(url).trim(), level: 'standard', source: 'mobile' }
  }
  const err = json && (json.error || json.errmsg || '')
  return { restricted: true, category: /付费|会员|vip/i.test(String(err)) ? 'vip_required' : 'url_unavailable', message: err || '酷狗未返回播放地址' }
}

async function kugouPlayViaWeb(hash, albumId, albumAudioId, cookie) {
  const auth = extractKugouAuth(cookie)
  const u = new URL(KUGOU_PLAY_WEB)
  u.searchParams.set('r', 'play/getdata')
  u.searchParams.set('hash', hash)
  u.searchParams.set('album_id', albumId || '0')
  if (albumAudioId) u.searchParams.set('album_audio_id', albumAudioId)
  u.searchParams.set('appid', String(KUGOU_WEB_APPID))
  u.searchParams.set('platid', '4')
  u.searchParams.set('mid', auth.mid || '')
  u.searchParams.set('dfid', auth.dfid || '-')
  u.searchParams.set('userid', auth.userid || '0')
  u.searchParams.set('token', auth.token || '')
  const json = await requestJson(u.toString(), {
    headers: { ...KUGOU_HEADERS, Cookie: buildKugouRequestCookie(cookie) },
  })
  const data = json && json.data
  const url = data && (data.play_url || data.play_backup_url)
  if (json && Number(json.status) === 1 && url) {
    const bitrate = Number(data.bitrate) || 0
    const level = bitrate >= 900 ? 'lossless' : (bitrate >= 300 ? 'exhigh' : 'standard')
    return { url: String(url).replace(/\\\//g, '/').trim(), level, source: 'web' }
  }
  const errMsg = String((json && (json.error || json.msg || (data && data.msg))) || '')
  return { restricted: true, category: /付费|会员|vip|登录/i.test(errMsg) ? 'vip_required' : 'url_unavailable', message: errMsg || '播放失败' }
}

/** 播放 URL 四层策略：H5（签名网关）→ Mobile（免费）→ Web（play/getdata 完整参数） */
export async function resolveKugouSongUrl(params, cookie) {
  params = params || {}
  const auth = extractKugouAuth(cookie)
  const hash = String(params.hash || params.fileHash || params.id || '').trim()
  const albumId = String(params.albumId || params.album_id || '').trim()
  const albumAudioId = Number(params.albumAudioId || params.album_audio_id || params.mixSongId || 0) || 0
  const requestedQuality = normalizeQualityPreference(params.quality)
  if (!hash) return { provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH' }

  const attempts = []
  // 1) H5 签名网关（需登录）
  if (auth.playbackReady) {
    try {
      const fileHash = hash.toLowerCase()
      const h5Params = buildKugouH5Params(auth, {
        album_id: Number(albumId || 0),
        area_code: 1,
        hash: fileHash,
        ssa_flag: 'is_fromtrack',
        version: 11430,
        quality: kugouQualityParam(requestedQuality),
        album_audio_id: albumAudioId,
        behavior: 'play',
        pid: 2,
        cmd: 26,
        pidversion: 3001,
        cdnBackup: 1,
        module: '',
      })
      h5Params.key = signKey(fileHash, auth.mid, auth.userid, KUGOU_WEB_APPID)
      h5Params.signature = signatureH5Params(h5Params, null)
      const u = new URL('/v5/url', KUGOU_GATEWAY)
      Object.keys(h5Params).forEach(key => u.searchParams.set(key, String(h5Params[key])))
      const json = await requestJson(u.toString(), {
        headers: { ...KUGOU_HEADERS, 'User-Agent': KUGOU_H5_UA, 'x-router': 'trackercdn.kugou.com', Cookie: buildKugouRequestCookie(cookie) },
      })
      const url = pickKugouPlayUrl(json)
      if (json && Number(json.status) === 1 && url) {
        attempts.push('h5')
        return { provider: 'kugou', url, playable: true, level: requestedQuality, source: 'h5', hash }
      }
    } catch { /* 尝试下一层 */ }
  }
  // 2) Mobile 免费直链
  const mobile = await kugouPlayViaMobile(hash, albumId, cookie, auth.userid)
  if (mobile.url) {
    attempts.push('mobile')
    return { provider: 'kugou', url: mobile.url, playable: true, level: 'standard', source: 'mobile', hash }
  }
  // 3) Web play/getdata（完整参数）
  if (auth.playbackReady) {
    const web = await kugouPlayViaWeb(hash, albumId, albumAudioId, cookie)
    if (web.url) {
      attempts.push('web')
      return { provider: 'kugou', url: web.url, playable: true, level: web.level, source: 'web', hash }
    }
  }
  const restriction = mobile.restricted || { category: 'url_unavailable', message: '酷狗未返回播放地址' }
  return {
    provider: 'kugou', url: '', playable: false,
    reason: restriction.category || 'url_unavailable',
    message: restriction.message || '酷狗未返回播放地址',
    attempts: attempts.join(','),
    hash,
  }
}

// ─────────────────────────── 用户歌单 / 收藏 / 歌词 ───────────────────────────

function decodeKugouDisplayText(text) {
  let raw = String(text || '').trim()
  if (!raw) return ''
  if (/%u[0-9a-fA-F]{4}/.test(raw)) {
    raw = raw.replace(/%u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  }
  if (/%[0-9a-fA-F]{2}/.test(raw) && !/[\u3400-\u9fff]/.test(raw)) {
    try { raw = decodeURIComponent(raw.replace(/\+/g, ' ')) } catch { /* 保持原样 */ }
  }
  return raw.trim()
}

function extractKugouGatewayPlaylistLists(data) {
  const candidates = [
    data && data.list,
    data && data.lists,
    data && data.info,
    data && data.songlist,
    data && data.data,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate
    if (candidate && Array.isArray(candidate.list)) return candidate.list
    if (candidate && Array.isArray(candidate.info)) return candidate.info
  }
  return []
}

function kugouCoverUrl(raw) {
  const url = String(raw || '').trim()
  if (!url) return ''
  return url.replace(/^http:\/\//i, 'https://').replace(/\{size\}/g, '400')
}

function mapKugouPlaylistItem(item) {
  item = item || {}
  return {
    id: String(item.specialid || item.listid || item.id || ''),
    name: decodeKugouDisplayText(item.specialname || item.listname || item.name || ''),
    coverUrl: kugouCoverUrl(item.img || item.icon || item.cover || ''),
    playcount: Number(item.playcount || item.play_count || 0) || undefined,
    songcount: Number(item.songcount || item.song_count || item.count || 0) || undefined,
    isMine: item.type === 1 || item.ismine === 1 || item.mine === 1,
  }
}

/** 用户歌单（H5 签名网关 /v7/get_all_list，绕开 www 域 WAF） */
export async function fetchKugouUserPlaylists(cookie) {
  const auth = extractKugouAuth(cookie)
  if (!auth.playbackReady) {
    return { success: false, error: 'KUGOU_AUTH_REQUIRED', message: '酷狗登录未完成（需要 KuGoo 会话与 token）', playlists: [] }
  }
  try {
    const json = await kugouH5GatewayRequest('/v7/get_all_list', {
      method: 'POST',
      cookie,
      router: 'cloudlist.service.kugou.com',
      params: { plat: 1 },
      body: {
        userid: Number(auth.userid),
        token: auth.token,
        total_ver: 979,
        type: 2,
        page: 1,
        pagesize: 50,
      },
    })
    const lists = extractKugouGatewayPlaylistLists((json && json.data) || {})
    const playlists = lists.map(mapKugouPlaylistItem).filter(pl => pl.id && pl.name)
    return {
      success: true,
      userId: auth.userid,
      nickname: decodeKugouDisplayText(auth.nickname) || '',
      avatar: auth.avatar || '',
      playlists,
    }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_PLAYLIST_FAILED', message: '酷狗歌单加载失败', playlists: [] }
  }
}

/** 歌单曲目（H5 签名网关 /v4/get_list_all_file） */
export async function fetchKugouPlaylistTracks(playlistId, cookie, limit = 50, page = 1) {
  const auth = extractKugouAuth(cookie)
  if (!auth.playbackReady) return { success: false, error: 'KUGOU_AUTH_REQUIRED', tracks: [] }
  const listid = String(playlistId || '').replace(/\D/g, '')
  if (!listid) return { success: false, error: 'MISSING_PLAYLIST_ID', tracks: [] }
  try {
    const json = await kugouH5GatewayRequest('/v4/get_list_all_file', {
      method: 'POST',
      cookie,
      router: 'cloudlist.service.kugou.com',
      params: { plat: 1 },
      body: {
        listid: Number(listid),
        userid: Number(auth.userid),
        area_code: 1,
        show_relate_goods: 0,
        pagesize: Math.max(1, Math.min(50, Number(limit) || 50)),
        allplatform: 1,
        show_cover: 1,
        type: 0,
        token: auth.token,
        page: Math.max(1, Number(page) || 1),
      },
    })
    const data = (json && json.data) || {}
    const chunk = data.info || data.songs || data.lists || []
    const tracks = chunk.map(item => {
      const hash = String(item.hash || item.fileHash || item.FileHash || '').toLowerCase()
      const filename = decodeKugouDisplayText(item.filename || item.songname || item.name || '')
      const sep = filename.indexOf(' - ')
      const singer = sep > 0 ? filename.slice(0, sep).trim() : ''
      const songName = sep > 0 ? filename.slice(sep + 3).trim() : filename
      return {
        hash,
        songName,
        singerName: singer,
        coverUrl: kugouCoverUrl(item.album_img || item.img || ''),
        duration: Number(item.duration || item.time || 0),
        albumId: String(item.album_id || ''),
        albumAudioId: Number(item.album_audio_id || item.audio_id || 0),
        fileId: String(item.fileid || item.file_id || ''),
      }
    }).filter(s => s.songName && s.hash)
    return { success: true, tracks, total: Number(data.count || 0) || tracks.length }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_PLAYLIST_TRACKS_FAILED', tracks: [] }
  }
}

/** 喜欢检查：拉取"我喜欢"歌单曲目 hash 集合 */
export async function kugouLikeCheckHashes(hashes, cookie) {
  const auth = extractKugouAuth(cookie)
  if (!auth.playbackReady) return { liked: {}, error: 'KUGOU_AUTH_REQUIRED' }
  const liked = {}
  const hashSet = new Set(hashes.map(h => String(h).toLowerCase()).filter(Boolean))
  if (!hashSet.size) return { liked: {} }
  // 分页拉"我喜欢"（type=2 的歌单列表中找 id=0/喜欢的默认歌单）
  try {
    const all = await fetchKugouUserPlaylists(cookie)
    const fav = (all.playlists || []).find(pl => pl.name && /我喜欢|默认歌单/.test(pl.name)) || (all.playlists || [])[0]
    if (fav) {
      for (let page = 1; page <= 6; page += 1) {
        const chunk = await fetchKugouPlaylistTracks(fav.id, cookie, 50, page)
        for (const track of chunk.tracks || []) {
          const h = String(track.hash).toLowerCase()
          if (hashSet.has(h)) liked[h] = true
        }
        if (!chunk.tracks || chunk.tracks.length < 50) break
      }
    }
  } catch { /* 忽略 */ }
  return { liked, listId: '' }
}

/** 加歌到歌单（含"我喜欢"默认歌单） */
export async function kugouAddSongToList(listId, song, cookie) {
  const auth = extractKugouAuth(cookie)
  if (!auth.playbackReady) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  let targetListId = String(listId || '').replace(/\D/g, '')
  if (!targetListId) {
    const all = await fetchKugouUserPlaylists(cookie)
    const fav = (all.playlists || []).find(pl => /我喜欢|默认歌单/.test(pl.name)) || (all.playlists || [])[0]
    targetListId = fav ? String(fav.id).replace(/\D/g, '') : ''
  }
  if (!targetListId) return { success: false, error: 'KUGOU_FAVORITE_LIST_NOT_FOUND' }
  const hash = String(song && (song.hash || song.fileHash || song.mid || song.id) || '').toLowerCase()
  if (!hash) return { success: false, error: 'MISSING_HASH' }
  const body = {
    userid: Number(auth.userid),
    token: auth.token,
    listid: Number(targetListId),
    list_ver: 0,
    type: 0,
    slow_upload: 1,
    scene: 'false;null',
    data: [{
      hash,
      songname: String(song.name || ''),
      filename: String(song.name || ''),
      singer: String((song.artists || []).map(a => a.name).join(',') || ''),
      albumid: String((song.album && song.album.id) || ''),
      album_audio_id: Number(song.albumAudioId || 0) || undefined,
    }],
  }
  await kugouH5GatewayRequest('/v6/add_song', {
    method: 'POST',
    cookie,
    router: 'cloudlist.service.kugou.com',
    params: { last_time: Math.floor(Date.now() / 1000), last_area: 'gztx', userid: auth.userid, token: auth.token },
    body,
  })
  return { success: true, liked: true, listId: targetListId }
}

/** 歌词（krcs.kugou.com，规范 LRC） */
export async function fetchKugouLyric(hash, albumAudioId, durationSec) {
  const fileHash = String(hash || '').trim()
  if (!fileHash) return { lyric: '', trans: '' }
  const search = await requestJson(`${KUGOU_LYRIC_SEARCH}?ver=1&man=yes&client=pc&keyword=&duration=${Math.max(0, Number(durationSec) || 0)}&hash=${encodeURIComponent(fileHash)}${albumAudioId ? `&album_audio_id=${albumAudioId}` : ''}`, { headers: KUGOU_HEADERS })
  const candidate = search && Array.isArray(search.candidates) && search.candidates[0]
  if (!candidate || !candidate.id) return { lyric: '', trans: '' }
  const lyricJson = await requestJson(`${KUGOU_LYRIC_DOWNLOAD}?ver=1&client=pc&id=${encodeURIComponent(String(candidate.id))}&accesskey=${encodeURIComponent(candidate.accesskey || '')}&fmt=lrc&charset=utf8`, { headers: KUGOU_HEADERS })
  let lyric = String((lyricJson && lyricJson.content) || '')
  if (lyric) {
    try {
      const buf = Buffer.from(lyric, 'base64')
      lyric = buf.toString('utf8')
    } catch { /* 已是明文 */ }
  }
  return { lyric, trans: '' }
}
