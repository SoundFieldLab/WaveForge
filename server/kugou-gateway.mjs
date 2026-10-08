// 酷狗签名网关模块（借鉴 Mineradio 逆向成果，GPL-3.0）
// www.kugou.com 的 r=user/* 接口对服务端请求有 WAF（Access Deny），
// 但 gateway.kugou.com 的签名接口（Android/H5 双签名 + x-router）可用服务端直连。
// 盐值/算法为酷狗客户端逆向公开成果。
import crypto from 'node:crypto'
import QRCode from 'qrcode'

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

// ─────────────────────── 概念版（lite）通道 ───────────────────────
// 概念版是酷狗官方另一个客户端（appid 3116 / clientver 11440），签名盐、RSA 公钥与
// 标准版/网页版都不同，token 也不通用（登录返回的 token 只在该版本的接口上有效）。
// 参考实现：Folia 捆绑的 kugoumusicapi（MIT）——这里用 node:crypto 复刻，不引新依赖。

const KUGOU_LITE_APPID = 3116
const KUGOU_LITE_CLIENTVER = 11440
const KUGOU_LITE_ANDROID_SALT = 'LnT6xpN3khm36zse0QzvmgTZ3waWdRSA'
const KUGOU_LITE_SIGN_KEY_SALT = '185672dd44712f60bb1736df5a377e82'
const KUGOU_LITE_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDECi0Np2UR87scwrvTr72L6oO01rBbbBPriSDFPxr3Z5syug0O24QyQO8bg27+0+4kBzTBTBOZ/WWU0WryL1JSXRTXLgFVxtzIY41Pe7lPOgsfTCn5kZcvKhYKJesKnnJDNr5/abvTGf+rHG3YRwsCHcQ08/q6ifSioBszvb3QiwIDAQAB
-----END PUBLIC KEY-----`
const KUGOU_LITE_LOGIN_APPID = 1001 // 扫码请求头 appid（qrcode_txt 内嵌的是概念版 appid）
const KUGOU_LITE_QR_PAGE = 'https://h5.kugou.com/apps/loginQRCode/html/index.html'
// 扫码轮询的状态快照（key → "3116=1 1001=1"），只在状态推进时打日志，避免刷屏
const kugouQrStatusSnapshots = new Map()
// 无封面歌单的首曲封面兜底缓存（collectionId → { cover, at }），避免每次打开歌单列表都多打一轮请求
const kugouCoverFallbackCache = new Map()
// 逐曲封面缓存（hash → { cover, at }）：权限接口的 union_cover，给无版权曲目补封面
const kugouCoverByHashCache = new Map()

/** 概念版设备身份（GUID→十进制 MID，与 kugoumusicapi 的 createDeviceCookies 一致） */
export function createKugouDeviceIdentity() {
  const guid = crypto.randomUUID().replace(/-/g, '').toUpperCase()
  return {
    guid,
    mid: BigInt(`0x${crypto.createHash('md5').update(guid).digest('hex')}`).toString(10),
    dev: crypto.randomBytes(5).toString('hex').toUpperCase(),
    mac: Array.from(crypto.randomBytes(6)).map(v => v.toString(16).padStart(2, '0')).join(':').toUpperCase(),
    webgl: BigInt(`0x${crypto.randomBytes(8).toString('hex')}`).toString(10),
  }
}

/** AES-128-CBC（key/iv 都由 6 字符随机串的 md5 派生：前 16 位做 key、后 16 位做 iv） */
function kugouLiteAes(rawKey, text, decrypt) {
  const digest = crypto.createHash('md5').update(String(rawKey)).digest('hex')
  const key = Buffer.from(digest.slice(0, 16), 'utf8')
  const iv = Buffer.from(digest.slice(16, 32), 'utf8')
  if (decrypt) {
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv)
    return Buffer.concat([d.update(Buffer.from(text, 'base64')), d.final()]).toString('utf8')
  }
  const c = crypto.createCipheriv('aes-128-cbc', key, iv)
  return Buffer.concat([c.update(String(text), 'utf8'), c.final()]).toString('base64')
}

function kugouLiteSignatureAndroid(params, data) {
  const parts = Object.keys(params).sort()
    .map(key => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : params[key]}`)
    .join('')
  return crypto.createHash('md5').update(`${KUGOU_LITE_ANDROID_SALT}${parts}${data || ''}${KUGOU_LITE_ANDROID_SALT}`).digest('hex')
}

function kugouLiteSignatureWeb(params) {
  const parts = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('')
  return crypto.createHash('md5').update(`${KUGOU_H5_SALT}${parts}${KUGOU_H5_SALT}`).digest('hex')
}

function kugouLiteDeviceCookies(cred) {
  cred = cred || {}
  return {
    guid: cred.guid || '',
    mid: cred.mid || '',
    dev: cred.dev || '',
    mac: cred.mac || '',
    webgl: cred.webgl || '',
    dfid: cred.dfid || '-',
  }
}

function kugouLiteHeaders(device, clienttimeSec) {
  return {
    'User-Agent': KUGOU_GATEWAY_UA,
    dfid: device.dfid,
    clienttime: String(clienttimeSec),
    mid: device.mid,
    'kg-rc': '1',
    'kg-thash': '5d816a0',
    'kg-rec': '1',
    'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
  }
}

/** 组装概念版默认参数（与 kugoumusicapi util/request.js 的 defaultParams 对齐） */
function kugouLiteParams(cred, extra, clientverOverride) {
  const device = kugouLiteDeviceCookies(cred)
  const now = Math.floor(Date.now() / 1000)
  const params = {
    dfid: device.dfid,
    mid: device.mid,
    uuid: '-',
    appid: KUGOU_LITE_APPID,
    clientver: clientverOverride || KUGOU_LITE_CLIENTVER,
    clienttime: now,
  }
  if (cred && cred.token) params.token = String(cred.token)
  if (cred && cred.userid) params.userid = Number(cred.userid)
  return Object.assign(params, extra || {})
}

/** 概念版签名网关请求（android 签名；返回解析后的 JSON） */
async function kugouLiteRequest({ cred, baseURL, path, method = 'GET', params, body, router, headers: extraHeaders, timeout = 12000 }) {
  const device = kugouLiteDeviceCookies(cred)
  const merged = kugouLiteParams(cred, params)
  const bodyText = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body))
  merged.signature = kugouLiteSignatureAndroid(merged, bodyText)
  const u = new URL(path, baseURL || KUGOU_GATEWAY)
  Object.keys(merged).forEach(key => u.searchParams.set(key, String(merged[key])))
  const headers = Object.assign(kugouLiteHeaders(device, merged.clienttime), body == null ? {} : { 'Content-Type': 'application/json' }, extraHeaders || {})
  if (router) headers['x-router'] = router
  const text = await requestText(u.toString(), { method: body == null ? 'GET' : method, headers, timeout }, bodyText || undefined)
  try { return JSON.parse(text) } catch { return null }
}

/** 概念版设备注册（userservice.kugou.com r_register_dev，AES+RSA 加密载荷）→ dfid */
export async function registerKugouDevice(cred) {
  const device = kugouLiteDeviceCookies(cred)
  const rawKey = crypto.randomBytes(3).toString('hex')
  const payload = JSON.stringify({
    availableRamSize: 4983533568, availableRomSize: 48114719, availableSDSize: 48114717,
    basebandVer: '', batteryLevel: 100, batteryStatus: 3, brand: 'Redmi', buildSerial: 'unknown', device: 'marble',
    imei: device.guid, imsi: '', manufacturer: 'Xiaomi', uuid: device.guid,
    accelerometer: false, accelerometerValue: '', gravity: false, gravityValue: '', gyroscope: false, gyroscopeValue: '',
    light: false, lightValue: '', magnetic: false, magneticValue: '', orientation: false, orientationValue: '',
    pressure: false, pressureValue: '', step_counter: false, step_counterValue: '', temperature: false, temperatureValue: '',
  })
  const dataStr = kugouLiteAes(rawKey, payload, false)
  const p = crypto.publicEncrypt(
    { key: KUGOU_LITE_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(JSON.stringify({ aes: rawKey, uid: Number(cred?.userid) || 0, token: cred?.token || '' }), 'utf8'),
  ).toString('hex')
  const params = kugouLiteParams(cred, { part: 1, platid: 1, p })
  const signature = kugouLiteSignatureAndroid(params, dataStr)
  const u = new URL('/risk/v2/r_register_dev', 'https://userservice.kugou.com')
  Object.keys(params).forEach(key => u.searchParams.set(key, String(params[key])))
  u.searchParams.set('signature', signature)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12000)
  try {
    const resp = await fetch(u.toString(), {
      method: 'POST',
      headers: Object.assign(kugouLiteHeaders(device, params.clienttime), { 'Content-Type': 'application/octet-stream' }),
      body: dataStr,
      signal: controller.signal,
    })
    const buf = Buffer.from(await resp.arrayBuffer())
    let json = null
    try { json = JSON.parse(kugouLiteAes(rawKey, buf.toString('base64'), true)) } catch { json = null }
    const dfid = json && json.data && json.data.dfid
    return dfid ? String(dfid) : ''
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

/** 生成概念版扫码登录二维码（登录在酷狗 App 内确认）。
 *  注意：登录接口返回的 qrcode_img 实测编码的不是本次请求的 qrcode（尺寸/内容都对不上），
 *  必须像 kugoumusicapi 一样用 URL `.../loginQRCode/html/index.html?qrcode=<key>` 自己渲染。 */
export async function createKugouQrLogin() {
  const device = createKugouDeviceIdentity()
  // 设备注册偶发返回空（酷狗风控限流），重试两次；失败也能扫码（后续按需再注册）
  let dfid = ''
  for (let attempt = 0; attempt < 3 && !dfid; attempt += 1) {
    dfid = await registerKugouDevice(device)
  }
  const params = kugouLiteParams({ ...device, dfid }, {
    appid: KUGOU_LITE_LOGIN_APPID,
    type: 1,
    plat: 4,
    qrcode_txt: `${KUGOU_LITE_QR_PAGE}?appid=${KUGOU_LITE_APPID}&`,
    srcappid: KUGOU_H5_SRC_APPID,
  })
  params.signature = kugouLiteSignatureWeb(params)
  const u = new URL('/v2/qrcode', 'https://login-user.kugou.com')
  Object.keys(params).forEach(key => u.searchParams.set(key, String(params[key])))
  const json = await requestJson(u.toString(), { headers: KUGOU_HEADERS })
  const key = json && json.data && json.data.qrcode
  if (!key) return null
  const url = `${KUGOU_LITE_QR_PAGE}?qrcode=${key}`
  let image = ''
  let imageSource = 'local'
  try {
    image = await QRCode.toDataURL(url, { scale: 10, margin: 1, errorCorrectionLevel: 'M' })
  } catch {
    // 自渲染失败才退回接口图（接口图与轮询 key 未必一致，仅作兜底展示）
    image = String((json.data && json.data.qrcode_img) || '')
    imageSource = 'upstream'
  }
  console.log(`[酷狗扫码] 创建 key=${key.slice(0, 12)}… dfid=${dfid || '(空)'} 图=${imageSource} url=${url}`)
  return {
    key: String(key),
    image,
    url,
    device: { ...device, dfid },
  }
}

/** 查询扫码状态：0=过期 1=待扫 2=待确认 4=成功（返回 token/userid）。
 *  请求 key 时用的 appid 是 1001（key 以它结尾），轮询用概念版 appid 3116；
 *  两个 appid 都查一遍并取状态更靠前的那个，避免扫码结果落在任一命名空间时漏掉。 */
export async function checkKugouQrLogin(key, device) {
  const results = []
  for (const appid of [KUGOU_LITE_APPID, KUGOU_LITE_LOGIN_APPID]) {
    try {
      const params = kugouLiteParams({ ...kugouLiteDeviceCookies(device) }, {
        plat: 4,
        appid,
        srcappid: KUGOU_H5_SRC_APPID,
        qrcode: String(key),
      })
      params.signature = kugouLiteSignatureWeb(params)
      const u = new URL('/v2/get_userinfo_qrcode', 'https://login-user.kugou.com')
      Object.keys(params).forEach(k => u.searchParams.set(k, String(params[k])))
      const json = await requestJson(u.toString(), { headers: KUGOU_HEADERS })
      const data = (json && json.data) || {}
      // 诊断信息只留在后端日志：扫不动时看这里就能判断是「授权没落到这个 key」还是「凭据回收失败」
      console.log(`[酷狗扫码][${String(key).slice(0, 8)}] appid=${appid} → ${JSON.stringify(json).slice(0, 200)}`)
      results.push({
        appid,
        status: Number(data.status) || 0,
        token: data.token ? String(data.token) : '',
        userid: data.userid ? String(data.userid) : '',
        nickname: data.nickname ? String(data.nickname) : '',
        avatar: data.pic ? String(data.pic) : '',
      })
    } catch { /* 单个 appid 查询失败不阻塞另一个 */ }
  }
  const rank = r => (r.status === 4 ? 4 : r.status === 2 ? 3 : r.status === 1 ? 2 : 1)
  const withToken = results.find(r => r.status === 4 && r.token && r.userid)
  const best = withToken || results.slice().sort((a, b) => rank(b) - rank(a))[0]
  // 状态发生推进（扫码/确认/过期）时补一条汇总，便于在后端日志里一眼看到转折点
  const summary = results.map(r => `${r.appid}=${r.status}`).join(' ')
  if (kugouQrStatusSnapshots.get(String(key)) !== summary) {
    kugouQrStatusSnapshots.set(String(key), summary)
    if (kugouQrStatusSnapshots.size > 20) {
      const oldest = kugouQrStatusSnapshots.keys().next().value
      kugouQrStatusSnapshots.delete(oldest)
    }
    console.log(`[酷狗扫码][${String(key).slice(0, 8)}] 状态 ${summary}`)
  }
  if (!best) return { status: 1, token: '', userid: '', nickname: '', avatar: '' }
  const { appid: _bestAppid, ...bestPublic } = best
  // 登录成功时若设备还没拿到 dfid（创建期注册被限流），这里补一次注册：
  // 此时已有 token/userid，注册成功率更高；dfid 是后续取播放直链的必要设备标识。
  if (bestPublic.status === 4 && bestPublic.token && !kugouLiteDeviceCookies(device).dfid) {
    const lateDfid = await registerKugouDevice({ ...kugouLiteDeviceCookies(device), token: bestPublic.token, userid: bestPublic.userid })
    if (lateDfid) {
      bestPublic.dfid = lateDfid
      console.log(`[酷狗扫码][${String(key).slice(0, 8)}] 登录后补注册设备 dfid=${String(lateDfid).slice(0, 8)}…`)
    }
  }
  // 登录成功时补齐昵称/头像（扫码接口通常不带），供前端登录后立即显示
  if (bestPublic.status === 4 && bestPublic.token) {
    const profile = await fetchKugouConceptProfile({ ...kugouLiteDeviceCookies(device), ...bestPublic, dfid: bestPublic.dfid || kugouLiteDeviceCookies(device).dfid })
    if (profile) {
      if (!bestPublic.nickname && profile.nickname) bestPublic.nickname = profile.nickname
      if (!bestPublic.avatar && profile.avatar) bestPublic.avatar = profile.avatar
      if (!bestPublic.userid && profile.userid) bestPublic.userid = profile.userid
      console.log(`[酷狗扫码][${String(key).slice(0, 8)}] 资料补齐 nickname=${profile.nickname || '(空)'} avatar=${profile.avatar ? '有' : '无'}`)
    }
  }
  return bestPublic
}

/** 概念版用户资料：歌单接口的条目自带 list_create_username / create_user_pic，
 *  比 /v3/get_my_info（裸 RSA 签名）简单可靠，登录后用它补齐昵称与头像。 */
export async function fetchKugouConceptProfile(cred) {
  if (!cred || !cred.token || !cred.userid) return null
  try {
    const result = await fetchKugouConceptUserPlaylists(cred)
    if (!result.success) return null
    const withName = (result.playlists || []).find(pl => pl.raw && pl.raw.list_create_username)
    if (!withName) return null
    const raw = withName.raw
    return {
      userid: String(raw.list_create_userid || cred.userid || ''),
      nickname: decodeKugouDisplayText(raw.list_create_username || ''),
      avatar: String(raw.create_user_pic || '').replace(/^http:\/\//i, 'https://'),
    }
  } catch (error) {
    console.warn('[酷狗扫码] 用户资料获取异常:', error?.message || error)
    return null
  }
}

/** 概念版用户歌单（/v7/get_all_list，type=2 含自建与收藏） */
export async function fetchKugouConceptUserPlaylists(cred) {
  if (!cred || !cred.token || !cred.userid) {
    return { success: false, error: 'KUGOU_AUTH_REQUIRED', playlists: [] }
  }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v7/get_all_list',
      method: 'POST',
      router: 'cloudlist.service.kugou.com',
      params: { plat: 1, userid: Number(cred.userid), token: cred.token },
      body: { userid: Number(cred.userid), token: cred.token, total_ver: 979, type: 2, page: 1, pagesize: 100 },
    })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_PLAYLIST_FAILED', errorCode: json && json.error_code, playlists: [] }
    }
    const list = (json.data && (json.data.info || json.data.list || json.data.lists)) || []
    const playlists = list.map(item => ({
      id: String(item.global_collection_id || item.list_create_gid || item.listid || ''),
      listid: String(item.listid || item.list_create_listid || ''),
      name: decodeKugouDisplayText(item.name || item.specialname || ''),
      coverUrl: kugouCoverUrl(item.pic || item.img || ''),
      songcount: Number(item.count || item.m_count || 0) || undefined,
      playcount: Number(item.playcount || 0) || undefined,
      isMine: String(item.list_create_userid || '') === String(cred.userid),
      raw: item,
    })).filter(pl => pl.id && pl.name)
    // 「我喜欢」「默认收藏」这类自动歌单没有自定义封面，用首曲封面兜底（带 10 分钟缓存）
    await Promise.all(playlists.filter(pl => !pl.coverUrl && pl.listid).map(async pl => {
      const cached = kugouCoverFallbackCache.get(pl.id)
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) { pl.coverUrl = cached.cover; return }
      const first = await fetchKugouConceptPlaylistTracks(cred, pl.id, 1, 1)
      const cover = (first.tracks || [])[0]?.coverUrl || ''
      if (cover) {
        kugouCoverFallbackCache.set(pl.id, { cover, at: Date.now() })
        pl.coverUrl = cover
      }
    }))
    return { success: true, userId: String(cred.userid), playlists }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_PLAYLIST_FAILED', playlists: [] }
  }
}

/** 从 collection_3_<uid>_<listid>_0 或纯数字里取数字 listid */
function kugouListIdOf(value) {
  const raw = String(value || '').trim()
  if (/^\d+$/.test(raw)) return Number(raw)
  const match = raw.match(/(\d+)_\d+$/)
  return match ? Number(match[1]) : 0
}

/** 概念版批量封面：/v2/get_res_privilege/lite 的 trans_param.union_cover。
 *  无版权曲目在歌单接口里 cover/albuminfo 都被抹掉，只有权限接口还带封面。 */
async function kugouLiteCoverMap(cred, hashes) {
  const map = {}
  const unique = [...new Set((hashes || []).map(h => String(h || '').toLowerCase()).filter(Boolean))]
  const pending = unique.filter(h => {
    const cached = kugouCoverByHashCache.get(h)
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) { map[h] = cached.cover; return false }
    return true
  })
  for (let i = 0; i < pending.length; i += 50) {
    const batch = pending.slice(i, i + 50)
    try {
      const json = await kugouLiteRequest({
        cred,
        path: '/v2/get_res_privilege/lite',
        method: 'POST',
        router: 'media.store.kugou.com',
        body: {
          appid: KUGOU_LITE_APPID,
          area_code: 1,
          behavior: 'play',
          clientver: KUGOU_LITE_CLIENTVER,
          need_hash_offset: 1,
          relate: 1,
          support_verify: 1,
          resource: batch.map(hash => ({ type: 'audio', page_id: 0, hash, album_id: 0 })),
          qualities: ['128', '320', 'flac'],
        },
      })
      const rows = Array.isArray(json && json.data) ? json.data : []
      for (const row of rows) {
        const hash = String((row && row.hash) || '').toLowerCase()
        const cover = row && row.trans_param && row.trans_param.union_cover
        if (hash && cover) {
          const url = kugouCoverUrl(cover)
          map[hash] = url
          kugouCoverByHashCache.set(hash, { cover: url, at: Date.now() })
        }
      }
    } catch { /* 单批失败不影响其它批次 */ }
  }
  return map
}

/** 概念版歌单曲目（/v4/get_list_all_file，listid 为数字）。
 *  实测 /pubsongs/v2/get_other_list_file_nofilt（Folia 用的那个）会漏歌：
 *  同一账号下「我喜欢」只回 45/50，「珂拉琪」直接 0/17；v4 端点两个歌单都完整。 */
export async function fetchKugouConceptPlaylistTracks(cred, collectionId, limit = 100, page = 1) {
  const listid = kugouListIdOf(collectionId)
  if (!listid) return { success: false, error: 'MISSING_PLAYLIST_ID', tracks: [] }
  const pagesize = Math.max(1, Math.min(300, Number(limit) || 100))
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v4/get_list_all_file',
      method: 'POST',
      router: 'cloudlist.service.kugou.com',
      params: { plat: 1 },
      body: {
        listid,
        userid: Number(cred?.userid) || 0,
        area_code: 1,
        show_relate_goods: 0,
        pagesize,
        allplatform: 1,
        show_cover: 1,
        type: 0,
        token: cred?.token || '',
        page: Math.max(1, Number(page) || 1),
      },
    })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.errmsg || json.msg)) || 'KUGOU_PLAYLIST_TRACKS_FAILED', tracks: [] }
    }
    const data = json.data || {}
    const rows = data.info || data.songs || []
    const tracks = rows.map(item => {
      const hash = String(item.hash || '').toLowerCase()
      const singerinfo = Array.isArray(item.singerinfo) ? item.singerinfo : []
      const singer = singerinfo.map(a => a && a.name).filter(Boolean).join('、')
      const filename = decodeKugouDisplayText(item.name || item.filename || '')
      const clean = filename.replace(/\.(mp3|flac|m4a|ape|wav|ogg|aac)$/i, '')
      const sep = clean.indexOf(' - ')
      const albuminfo = item.albuminfo || {}
      return {
        hash,
        songName: sep > 0 ? clean.slice(sep + 3) : clean,
        singerName: singer || (sep > 0 ? clean.slice(0, sep) : ''),
        // 歌手 id：右键「查看歌手」与歌手详情跳转依赖它（singerinfo[0].id）
        singerId: String((singerinfo[0] && singerinfo[0].id) || '') || undefined,
        albumId: String(item.album_id || albuminfo.id || ''),
        albumName: decodeKugouDisplayText(albuminfo.name || item.album_name || ''),
        albumAudioId: Number(item.audio_id || item.album_audio_id || 0) || undefined,
        mixSongId: Number(item.mixsongid || item.mix_song_id || 0) || undefined,
        fileId: String(item.fileid || ''),
        duration: Math.round((Number(item.timelen || item.duration || 0) || 0) / 1000) || undefined,
        coverUrl: kugouCoverUrl(item.cover || ''),
      }
    }).filter(t => t.hash && t.songName)
    // 歌单接口对无版权曲目不回封面（cover 为空、albuminfo 被清），用权限接口的 union_cover 补
    if (tracks.some(t => !t.coverUrl)) {
      const coverMap = await kugouLiteCoverMap(cred, tracks.map(t => t.hash))
      for (const track of tracks) {
        if (!track.coverUrl && coverMap[track.hash]) track.coverUrl = coverMap[track.hash]
      }
    }
    return { success: true, tracks, total: Number(data.count || 0) || tracks.length }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_PLAYLIST_TRACKS_FAILED', tracks: [] }
  }
}

/** 概念版歌单信息（/v3/get_list_info，pubsongs.kugou.com）：详情页标题/封面/曲目数 */
export async function fetchKugouConceptPlaylistInfo(cred, collectionId) {
  const raw = String(collectionId || '').trim()
  if (!raw) return null
  const gid = raw.startsWith('collection_')
    ? raw
    : `collection_3_${cred?.userid || ''}_${kugouListIdOf(raw)}_0`
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v3/get_list_info',
      method: 'POST',
      router: 'pubsongs.kugou.com',
      body: { data: [{ global_collection_id: gid }], userid: Number(cred?.userid) || 0, token: cred?.token || '' },
    })
    const info = json && (Array.isArray(json.data) ? json.data[0] : json.data)
    if (!info || typeof info !== 'object') return null
    return {
      id: gid,
      listid: String(info.list_create_listid || kugouListIdOf(gid) || ''),
      name: decodeKugouDisplayText(info.name || ''),
      coverUrl: kugouCoverUrl(info.pic || ''),
      songcount: Number(info.count || info.m_count || 0) || undefined,
      creator: decodeKugouDisplayText(info.list_create_username || ''),
    }
  } catch {
    return null
  }
}

/** 概念版「我喜欢」列表（找到 is_def=2 的默认歌单，返回其曲目 hash→fileid 映射） */
export async function fetchKugouConceptLikedMap(cred, hashes) {
  const liked = {}
  const hashSet = new Set((hashes || []).map(h => String(h).toLowerCase()).filter(Boolean))
  if (!hashSet.size) return { liked, listid: '' }
  const all = await fetchKugouConceptUserPlaylists(cred)
  if (!all.success) return { liked, listid: '', error: all.error }
  const fav = (all.playlists || []).find(pl => pl.raw && (Number(pl.raw.is_def) === 2 || Number(pl.raw.list_create_listid) === 2))
    || (all.playlists || []).find(pl => pl.isMine && /我喜欢/.test(pl.name))
  if (!fav) return { liked, listid: '' }
  const listid = fav.listid || '2'
  let page = 1
  while (page <= 10) {
    const chunk = await fetchKugouConceptPlaylistTracks(cred, fav.id, 300, page)
    for (const track of chunk.tracks || []) {
      if (hashSet.has(track.hash)) liked[track.hash] = track.fileId || ''
    }
    if (!chunk.success || !chunk.tracks || chunk.tracks.length < 300) break
    page += 1
  }
  return { liked, listid }
}

/** 概念版加歌（喜欢=加入默认「我喜欢」歌单，listid=2） */
export async function kugouConceptAddSong(cred, listid, song) {
  const hash = String((song && (song.hash || song.fileHash)) || '').toLowerCase()
  if (!hash) return { success: false, error: 'MISSING_HASH' }
  const target = String(listid || '2').replace(/\D/g, '') || '2'
  const name = String((song && (song.songName || song.name)) || '')
  const singer = String((song && (song.singerName || (Array.isArray(song.artists) && song.artists.map(a => a.name).join('、')))) || '')
  try {
    const clienttime = Math.floor(Date.now() / 1000)
    const json = await kugouLiteRequest({
      cred,
      path: '/cloudlist.service/v6/add_song',
      method: 'POST',
      params: { last_time: clienttime, last_area: 'gztx', userid: Number(cred.userid), token: cred.token },
      body: {
        userid: Number(cred.userid),
        token: cred.token,
        listid: Number(target),
        list_ver: 0,
        type: 0,
        slow_upload: 1,
        scene: 'false;null',
        data: [{
          number: 1,
          name: singer ? `${singer} - ${name}` : name,
          hash,
          size: 0,
          sort: 0,
          timelen: 0,
          bitrate: 0,
          album_id: Number((song && song.albumId) || 0) || 0,
          mixsongid: Number((song && (song.mixSongId || song.albumAudioId)) || 0) || 0,
        }],
      },
    })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.msg || json.errmsg)) || 'KUGOU_ADD_SONG_FAILED' }
    }
    return { success: true, listId: target }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_ADD_SONG_FAILED' }
  }
}

/** 概念版移出歌单（取消喜欢 = 从「我喜欢」按 fileid 删除） */
export async function kugouConceptRemoveSong(cred, listid, fileIds) {
  const ids = (Array.isArray(fileIds) ? fileIds : [fileIds]).map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)
  if (!ids.length) return { success: false, error: 'MISSING_FILE_ID' }
  const target = String(listid || '2').replace(/\D/g, '') || '2'
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v4/delete_songs',
      method: 'POST',
      router: 'cloudlist.service.kugou.com',
      body: {
        listid: Number(target),
        userid: Number(cred.userid),
        data: ids.map(fileid => ({ fileid })),
        type: 0,
        token: cred.token,
        list_ver: 0,
      },
    })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.msg || json.errmsg)) || 'KUGOU_REMOVE_SONG_FAILED' }
    }
    return { success: true }
  } catch (err) {
    return { success: false, error: err.message || 'KUGOU_REMOVE_SONG_FAILED' }
  }
}

function kugouLiteQualityCandidates(quality) {
  const level = normalizeQualityPreference(quality)
  if (level === 'jymaster') return ['viper_tape', 'flac', '320', '128']
  if (level === 'hires') return ['high', 'flac', '320', '128']
  if (level === 'lossless') return ['flac', '320', '128']
  if (level === 'exhigh') return ['320', '128']
  return ['128']
}

/** 概念版播放直链（/v5/url，android 签名 + 概念版 page_id/pid；按音质降级重试） */
export async function resolveKugouConceptSongUrl(cred, params) {
  params = params || {}
  const hash = String(params.hash || '').toLowerCase().trim()
  if (!hash) return { provider: 'kugou', url: '', playable: false, error: 'MISSING_HASH' }
  const albumId = Number(params.albumId || params.album_id || 0) || 0
  const albumAudioId = Number(params.albumAudioId || params.album_audio_id || 0) || 0
  const device = kugouLiteDeviceCookies(cred)
  let lastRestriction = null
  for (const quality of kugouLiteQualityCandidates(params.quality)) {
    const merged = kugouLiteParams(cred, {
      album_id: albumId,
      area_code: 1,
      hash,
      ssa_flag: 'is_fromtrack',
      version: 11430,
      page_id: 967177915,
      quality,
      album_audio_id: albumAudioId,
      behavior: 'play',
      pid: 411,
      cmd: 26,
      pidversion: 3001,
      IsFreePart: params.freePart ? 1 : 0,
      ppage_id: '356753938,823673182,967485191',
      cdnBackup: 1,
      module: '',
    }, 11430)
    merged.key = crypto.createHash('md5')
      .update(`${hash}${KUGOU_LITE_SIGN_KEY_SALT}${KUGOU_LITE_APPID}${device.mid}${Number(cred?.userid) || 0}`)
      .digest('hex')
    merged.signature = kugouLiteSignatureAndroid(merged, '')
    const u = new URL('/v5/url', KUGOU_GATEWAY)
    Object.keys(merged).forEach(k => u.searchParams.set(k, String(merged[k])))
    const json = await requestJson(u.toString(), {
      headers: Object.assign(kugouLiteHeaders(device, merged.clienttime), { 'x-router': 'trackercdn.kugou.com' }),
    })
    const url = pickKugouPlayUrl(json)
    if (json && Number(json.status) === 1 && url) {
      return { provider: 'kugou', url, playable: true, level: quality, source: 'concept', hash }
    }
    const errCode = json && Number(json.error_code)
    const message = String((json && (json.error || json.errmsg)) || '') || `酷狗未返回播放地址(${errCode || json?.status || '?'})`
    const vipBlocked = errCode === 35104 || errCode === 20018 || json?.status === 2
    lastRestriction = {
      category: vipBlocked ? 'vip_required' : 'url_unavailable',
      message,
    }
  }
  return {
    provider: 'kugou', url: '', playable: false,
    reason: lastRestriction ? lastRestriction.category : 'url_unavailable',
    message: lastRestriction ? lastRestriction.message : '酷狗未返回播放地址',
    hash,
  }
}

/** 歌词（krcs.kugou.com，规范 LRC） */
// ── 探索页扩展板块（对齐官方客户端：乐库/频道/分类/听书）────────────────────
// 这几个接口返回结构差异大且字段多在变，网关只做「取数」，字段映射放到客户端/下一层做，
// 避免这里猜错结构导致静默丢数据。

/** 每日推荐歌曲（/everyday_song_recommend，x-router everydayrec） */
export async function fetchKugouDailyRecommend(cred) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/everyday_song_recommend',
      method: 'POST',
      router: 'everydayrec.service.kugou.com',
      params: { platform: 'android' },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_DAILY_FAILED' }
  }
}

/** 每日推荐歌单的历史（/everyday/api/v1/get_history，mode=list|song；需登录）。
 *  注意：这是「推荐歌单的历史」，不是最近播放（最近播放见 fetchKugouPlayRecords）。
 *  mode=song 必须同时带 history_name+date（先取 mode=list 拿到这组字段），否则上游 error_code 200511。 */
export async function fetchKugouRecommendHistory(cred, mode = 'list', date, historyName) {
  const requestMode = mode === 'song' ? 'song' : 'list'
  if (requestMode === 'song' && (!date || !historyName)) {
    return { success: false, error: 'MISSING_HISTORY_NAME_OR_DATE', message: 'mode=song 需要 history_name 与 date（先取 mode=list）', data: null }
  }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/everyday/api/v1/get_history',
      method: 'POST',
      router: 'everydayrec.service.kugou.com',
      params: {
        mode: requestMode,
        platform: 'android',
        ...(date ? { date } : {}),
        ...(historyName ? { history_name: historyName } : {}),
      },
    })
    // 该接口不返回 status 字段：有 data 即视为成功
    return { success: Boolean(json && json.data), data: (json && json.data) || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_HISTORY_FAILED' }
  }
}

/** 频道目录（/v1/zone/index，IP 专区）：官方"频道"页签的落地列表（48 个频道，含图标）。
 *  实测该账号 channel_all_list（订阅频道）恒空，官方页面用的是这份专区目录；
 *  专区内容页由酷狗小程序（miniapp.kugou.com）渲染，ip_id 嵌在 special_link 的 path 参数里。 */
export async function fetchKugouChannelZones() {
  try {
    const json = await kugouLiteRequest({
      cred: null,
      path: '/v1/zone/index',
      method: 'GET',
      router: 'yuekucategory.kugou.com',
      params: {},
    })
    const list = (json && json.data && Array.isArray(json.data.list)) ? json.data.list : []
    const channels = list.map(item => {
      const link = String(item.special_link || '')
      let ipId = ''
      try {
        const outer = new URLSearchParams(link.split('?').slice(1).join('?'))
        const innerPath = outer.get('path') || ''
        ipId = innerPath.split('?')[1] ? (new URLSearchParams(innerPath.split('?')[1]).get('ip_id') || '') : ''
      } catch { ipId = '' }
      return {
        id: String(item.id || ''),
        name: decodeKugouDisplayText(item.name || ''),
        icon: kugouCoverUrl(item.icon || ''),
        summary: String(item.summary || ''),
        ipId,
        link,
      }
    }).filter(item => item.id && item.name)
    return { success: channels.length > 0, data: channels }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_CHANNEL_ZONES_FAILED', data: [] }
  }
}

// ── 频道（IP 专区）内容通道：appid 1058 + H5 签名（含 body），与酷狗 H5 小程序完全一致 ──
// 实测：游客设备即可读（无需登录）；关注数需要登录凭据。签名算法 = 既有 signatureH5Params。
const KUGOU_IP_APPID = '1058'
const KUGOU_IP_CLIENTVER = '1000'
// 频道接口游客可读：没有凭据时用一份稳定的游客设备身份（每次换 mid 会显得可疑）
let kugouIpGuestDevice = null

/** 频道接口请求（POST 带 JSON body / GET 无 body，签名都走 H5 含 body 形式）
 *  appid 覆盖的原因：collectlist 关注写接口用 appid=1058 会拒我们的 token（error 20018），
 *  实测同一 token 在 appid=3116（概念版）下被接受，故登录态请求改走 3116。 */
async function kugouIpRequest({ cred, path, method = 'POST', params, body, timeout = 12000, appid }) {
  const hasCredMid = Boolean(cred && kugouLiteDeviceCookies(cred).mid)
  const device = hasCredMid ? kugouLiteDeviceCookies(cred) : (kugouIpGuestDevice = kugouIpGuestDevice || { ...createKugouDeviceIdentity(), dfid: '-' })
  const merged = {
    appid: appid || KUGOU_IP_APPID,
    clientver: KUGOU_IP_CLIENTVER,
    clienttime: Math.floor(Date.now() / 1000),
    mid: device.mid || '',
    uuid: device.mid || '',
    dfid: device.dfid || '-',
    srcappid: KUGOU_H5_SRC_APPID,
    ...(params || {}),
  }
  if (cred && cred.token) merged.token = String(cred.token)
  if (cred && cred.userid) merged.userid = Number(cred.userid)
  const bodyText = body == null ? '' : JSON.stringify(body)
  // signatureH5Params 期望 body 为对象（内部自行 stringify）；传字符串会让签名漏掉 body
  merged.signature = signatureH5Params(merged, body)
  const u = new URL(path, KUGOU_GATEWAY)
  Object.keys(merged).forEach(key => u.searchParams.set(key, String(merged[key])))
  const text = await requestText(u.toString(), {
    method,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      Referer: 'https://m.kugou.com/',
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    timeout,
  }, bodyText || undefined)
  try { return JSON.parse(text) } catch { return null }
}

/** 频道详情：基础信息（名称/类型/封面/简介/计数）+ 人气 */
export async function fetchKugouChannelDetail(ipId) {
  const id = String(ipId || '').trim()
  if (!id) return { success: false, error: 'MISSING_IP_ID' }
  try {
    const [infoJson, heatJson] = await Promise.all([
      kugouIpRequest({ path: '/openapi/v1/ip', body: { data: [{ ip_id: id }], is_publish: '1', show_pre: 0, ip_id: id } }),
      kugouIpRequest({ path: '/openapi/kmr/v2/ip', body: { fields: 'heat', data: [{ entity_id: id }] } }),
    ])
    const entry = infoJson && Array.isArray(infoJson.data) ? infoJson.data[0] : null
    if (!entry || !entry.base) {
      return { success: false, error: (infoJson && (infoJson.errmsg || infoJson.error_msg)) || 'KUGOU_CHANNEL_DETAIL_FAILED' }
    }
    const heat = heatJson && Array.isArray(heatJson.data) ? Number(heatJson.data[0] && heatJson.data[0].heat && heatJson.data[0].heat.heat || 0) : 0
    const cover = String((entry.pic && (entry.pic.avatar_square || entry.pic.avatar)) || entry.base.avatar || '')
    return {
      success: true,
      data: {
        id,
        // 展示名取 config.title：情歌专区的实体名是「爱情」，官方页面头部用的是 config.title「情歌」
        // （DJ/经典等一并核对过；config.title 为空时才回退实体名）
        name: decodeKugouDisplayText((entry.config && entry.config.title) || entry.base.name || ''),
        type: String(entry.base.type || ''),
        suffix: String(entry.base.suffix || ''),
        cover: cover.replace(/^http:\/\//i, 'https://'),
        intro: decodeKugouDisplayText(entry.intro || ''),
        heat,
        videoTotal: Number((entry.count && entry.count.video_total) || 0) || 0,
        audioTotal: Number((entry.count && entry.count.audio_total) || 0) || 0,
        // 官方头部还有「歌单」页签（情歌 3000 / DJ 3000 / 经典 3006），来源就是这个字段
        playlistTotal: Number((entry.count && entry.count.playlist_total) || 0) || 0,
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_CHANNEL_DETAIL_FAILED' }
  }
}

/** 频道单曲（/fm.service/v2/ip_song_list_page） */
export async function fetchKugouChannelSongs(ipId, page = 1, pagesize = 30) {
  const json = await kugouIpRequest({
    path: '/fm.service/v2/ip_song_list_page',
    body: { ip_id: String(ipId || ''), page: Math.max(1, Number(page) || 1), pagesize: Math.max(1, Math.min(50, Number(pagesize) || 30)), query: 'ip' },
  })
  if (!json || Number(json.status) !== 1) return { success: false, error: (json && json.errmsg) || 'KUGOU_CHANNEL_SONGS_FAILED', tracks: [] }
  const rows = Array.isArray(json.data) ? json.data : []
  const tracks = rows.map(row => {
    const base = row.base || {}
    const audio = row.audio_info || {}
    const trans = audio.trans_param || {}
    return {
      hash: String(audio.hash || '').toLowerCase(),
      songName: decodeKugouDisplayText(base.songname || ''),
      singerName: decodeKugouDisplayText(base.author_name || ''),
      albumId: String(base.album_id || ''),
      albumName: decodeKugouDisplayText(base.album_name || ''),
      albumAudioId: Number(base.album_audio_id || 0) || undefined,
      mixSongId: Number(base.mixsongid || base.album_audio_id || 0) || undefined,
      duration: Math.round(Number(audio.timelength || 0) / 1000) || undefined,
      coverUrl: kugouCoverUrl(trans.union_cover || ''),
    }
  }).filter(track => track.hash && track.songName)
  return { success: true, tracks, total: Number(json.total || 0) || tracks.length }
}

/** 频道歌单（/ocean/v6/pubsongs/list_info_for_ip；参数名是 ip，不是 ip_id） */
export async function fetchKugouChannelPlaylists(ipId, page = 1, pagesize = 12) {
  const json = await kugouIpRequest({
    path: '/ocean/v6/pubsongs/list_info_for_ip',
    method: 'GET',
    params: { ip: String(ipId || ''), page: Math.max(1, Number(page) || 1), pagesize: Math.max(1, Math.min(50, Number(pagesize) || 12)), sort: 4 },
  })
  if (!json || Number(json.status || json.errcode) !== 1) return { success: false, error: (json && json.errmsg) || 'KUGOU_CHANNEL_PLAYLISTS_FAILED', playlists: [] }
  const info = (json.data && json.data.info) || []
  const playlists = info.map(item => ({
    id: String(item.list_create_gid || ''),
    name: decodeKugouDisplayText(item.name || item.listname || ''),
    coverUrl: kugouCoverUrl(item.pic || item.img || ''),
    songcount: Number(item.count || 0) || undefined,
    playcount: Number(item.play_count || 0) || undefined,
    creator: decodeKugouDisplayText(item.list_create_username || ''),
  })).filter(item => item.id && item.name)
  return { success: true, playlists, total: Number(json.total || 0) || playlists.length }
}

/** 频道视频（/openapi/v1/ip/videos） */
export async function fetchKugouChannelVideos(ipId, page = 1, pagesize = 6) {
  const json = await kugouIpRequest({
    path: '/openapi/v1/ip/videos',
    body: { ip_id: String(ipId || ''), sort: 3, page: Math.max(1, Number(page) || 1), pagesize: Math.max(1, Math.min(50, Number(pagesize) || 6)), query: 0 },
  })
  if (!json || Number(json.status) !== 1) return { success: false, error: (json && json.errmsg) || 'KUGOU_CHANNEL_VIDEOS_FAILED', videos: [] }
  const rows = Array.isArray(json.data) ? json.data : []
  const videos = rows.map(row => {
    const base = row.base || {}
    return {
      id: String(base.video_id || ''),
      name: decodeKugouDisplayText(base.mv_name || ''),
      singer: decodeKugouDisplayText(base.singer || ''),
      coverUrl: kugouCoverUrl(base.hdpic || base.thumb || ''),
      duration: Math.round(Number(base.duration || 0) / 1000) || undefined,
      publishTime: String(base.publish_time || ''),
      albumAudioId: Number(base.album_audio_id || 0) || undefined,
    }
  }).filter(v => v.id && v.name)
  return { success: true, videos, total: Number(json.total || 0) || videos.length }
}

/** 频道下的子频道/关联频道（/listkmrp3/v2/ip/rec，三个模块 id 合并去重） */
export async function fetchKugouChannelSubChannels(ipId) {
  const id = String(ipId || '')
  const modules = ['1fa359f4b469', '1c4dfbad8488', 'a486790305a2']
  const results = await Promise.all(modules.map(module_id => kugouIpRequest({
    path: '/listkmrp3/v2/ip/rec',
    body: { ip_id: id, module_id, show_pre: 0, page: 1, pagesize: 6, query: 'page' },
  }).catch(() => null)))
  const channels = []
  const seen = new Set()
  for (const json of results) {
    const rows = json && Array.isArray(json.data) ? json.data : []
    for (const row of rows) {
      const ip = row && row.ip
      const base = ip && ip.base
      if (!base || !base.ip_id) continue
      const ipIdValue = String(base.ip_id)
      if (seen.has(ipIdValue)) continue
      seen.add(ipIdValue)
      channels.push({
        id: ipIdValue,
        name: decodeKugouDisplayText(base.name || ''),
        type: String(base.type || ''),
        coverUrl: kugouCoverUrl((ip.pic && (ip.pic.avatar_square || ip.pic.avatar)) || ''),
      })
    }
  }
  return { success: channels.length > 0, data: channels }
}

/** 频道关注数（/collectlist/v1/get_collect_count，需登录；实为频道总关注数，未登录时上游也返回） */
export async function fetchKugouChannelCollectCount(cred, ipId) {
  const id = Number(String(ipId || '').replace(/\D/g, '')) || 0
  if (!id) return { success: false, error: 'MISSING_IP_ID' }
  const json = await kugouIpRequest({
    cred,
    path: '/collectlist/v1/get_collect_count',
    appid: cred && cred.token ? KUGOU_LITE_APPID : undefined,
    params: { dtype: 'ip' },
    body: { token: String((cred && cred.token) || ''), userid: Number((cred && cred.userid)) || 0, data: [{ source: 14, list_create_userid: 0, list_create_listid: id }] },
  })
  const row = json && Array.isArray(json.data) ? json.data[0] : null
  return { success: Number(json && json.error_code) === 0 && Number(json && json.status) === 1, count: Number((row && (row.count || row.collect_count)) || 0) || 0 }
}

/** 频道关注状态（/collectlist/v1/get_collect_stat，需登录）：
 *  返回 collected（是否已关注）、collected_listid（取消关注要用的记录 id，'0' 表示未关注）、collected_count（关注数）。
 *  来源：H5 小程序频道页 bundle 内 `post('/v1/get_collect_stat',{dtype:'ip'})`，参数与 get_collect_count 同族（source=14 表示频道）。
 *  实测（2026-10-07）：appid=1058 会拒 token（error 20018），换 appid=3116 后读/写全部走通。 */
export async function fetchKugouChannelCollectStat(cred, ipId) {
  const id = Number(String(ipId || '').replace(/\D/g, '')) || 0
  if (!id) return { success: false, error: 'MISSING_IP_ID' }
  const json = await kugouIpRequest({
    cred,
    path: '/collectlist/v1/get_collect_stat',
    appid: cred && cred.token ? KUGOU_LITE_APPID : undefined,
    params: { dtype: 'ip' },
    body: { token: String((cred && cred.token) || ''), userid: Number((cred && cred.userid)) || 0, ret_collected_count: 1, data: [{ source: 14, list_create_userid: 0, list_create_listid: id }] },
  })
  const row = json && Array.isArray(json.data) ? json.data[0] : null
  const listid = row ? String(row.collected_listid ?? '') : ''
  return {
    success: Number(json && json.error_code) === 0 && Number(json && json.status) === 1,
    collected: Boolean(row && Number(row.collected) === 1) || Boolean(listid && listid !== '0'),
    collectedListId: listid === '0' ? '' : listid,
    collectedCount: Number((row && (row.count || row.collected_count)) || 0) || 0,
    error: (json && (json.errmsg || json.error)) || (listid || Number(json && json.error_code) === 0 ? undefined : 'KUGOU_CHANNEL_COLLECT_STAT_FAILED'),
  }
}

/** 关注频道（/collectlist/v2/add_list，H5「+关注」同源；name 为频道名，上游要求非空）。
 *  成功判定用 error_code=0 && status=1；返回 data.info.listid（该用户的关注记录 id）。 */
export async function collectKugouChannel(cred, ipId, name) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const id = Number(String(ipId || '').replace(/\D/g, '')) || 0
  if (!id) return { success: false, error: 'MISSING_IP_ID' }
  const json = await kugouIpRequest({
    cred,
    path: '/collectlist/v2/add_list',
    appid: KUGOU_LITE_APPID,
    params: { dtype: 'ip' },
    body: {
      token: String(cred.token),
      userid: Number(cred.userid) || 0,
      type: 1,
      source: 14,
      list_create_userid: 0,
      list_create_listid: id,
      total_ver: 1,
      name: String(name || ''),
    },
  })
  const ok = Number(json && json.error_code) === 0 && Number(json && json.status) === 1
  const info = json && json.data && json.data.info
  return { success: ok, listid: info ? String(info.listid || '') : '', error: ok ? undefined : ((json && (json.errmsg || json.error)) || `KUGOU_CHANNEL_COLLECT_FAILED(${Number(json && json.error_code) || 0})`) }
}

/** 取消关注频道（/collectlist/v2/del_list；listid 来自 get_collect_stat 的 collected_listid） */
export async function uncollectKugouChannel(cred, listid) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const numeric = Number(String(listid || '').replace(/\D/g, '')) || 0
  if (!numeric) return { success: false, error: 'MISSING_LIST_ID' }
  const json = await kugouIpRequest({
    cred,
    path: '/collectlist/v2/del_list',
    appid: KUGOU_LITE_APPID,
    params: { dtype: 'ip' },
    body: { token: String(cred.token), userid: Number(cred.userid) || 0, type: 1, source: 14, listid: numeric, total_ver: 1 },
  })
  const ok = Number(json && json.error_code) === 0 && Number(json && json.status) === 1
  return { success: ok, error: ok ? undefined : ((json && (json.errmsg || json.error)) || `KUGOU_CHANNEL_UNCOLLECT_FAILED(${Number(json && json.error_code) || 0})`) }
}

/** 电台分类与电台列表（/v1/class_fm_song，x-router fm.service.kugou.com）。
 *  官方客户端「频道」页签的真实内容：data.class_list[] = 分类（晚上/DJ/语言/主题/场景/心情/风格…），
 *  每类 fmlist[] = 电台（fmid/fmname/imgurl + songlist[] 当前播放曲）。 */
export async function fetchKugouRadioClasses(cred) {
  try {
    const clienttime = Date.now()
    const key = crypto.createHash('md5')
      .update(`${KUGOU_LITE_APPID}${KUGOU_LITE_ANDROID_SALT}${KUGOU_LITE_CLIENTVER}${clienttime}`)
      .digest('hex')
    const json = await kugouLiteRequest({
      cred,
      path: '/v1/class_fm_song',
      method: 'POST',
      router: 'fm.service.kugou.com',
      body: {
        kguid: Number(cred?.userid) || 0,
        clienttime,
        mid: kugouLiteDeviceCookies(cred).mid || (kugouIpGuestDevice = kugouIpGuestDevice || { ...createKugouDeviceIdentity(), dfid: '-' }).mid,
        platform: 'android',
        clientver: KUGOU_LITE_CLIENTVER,
        uid: Number(cred?.userid) || 0,
        get_tracker: 1,
        key,
        appid: KUGOU_LITE_APPID,
      },
    })
    if (!json || !json.data || !json.data.class_list) console.warn('[酷狗电台] 上游返回:', JSON.stringify(json).slice(0, 220))
    const classes = (json && json.data && json.data.class_list) || []
    const mapped = classes.map(cls => ({
      classid: String(cls.classid || ''),
      name: decodeKugouDisplayText(cls.classname || cls.name || ''),
      stations: (cls.fmlist || []).map(fm => {
        const cur = Array.isArray(fm.songlist) ? fm.songlist[0] : null
        return {
          fmid: String(fm.fmid || ''),
          name: decodeKugouDisplayText(fm.fmname || ''),
          coverUrl: kugouCoverUrl(fm.imgurl || (fm.banner && fm.banner.imgurl) || ''),
          fmtype: Number(fm.fmtype || 0) || 2,
          currentSong: cur ? {
            hash: String(cur.hash || '').toLowerCase(),
            audioId: Number(cur.audio_id || 0) || undefined,
            albumId: String(cur.album_id || ''),
            name: decodeKugouDisplayText(cur.name || ''),
          } : null,
        }
      }).filter(station => station.fmid && station.name),
    })).filter(cls => cls.name && cls.stations.length)
    return { success: mapped.length > 0, data: mapped }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_RADIO_CLASSES_FAILED', data: [] }
  }
}

/** 电台曲单（/v1/app_song_list_offset，x-router fm.service.kugou.com；offset=-1 表示取当前流） */
export async function fetchKugouRadioSongs(cred, fmid, fmtype = 2, size = 20) {
  const id = String(fmid || '').trim()
  if (!id) return { success: false, error: 'MISSING_FMID', tracks: [] }
  try {
    const clienttime = Date.now()
    const key = crypto.createHash('md5')
      .update(`${KUGOU_LITE_APPID}${KUGOU_LITE_ANDROID_SALT}${KUGOU_LITE_CLIENTVER}${clienttime}`)
      .digest('hex')
    const json = await kugouLiteRequest({
      cred,
      path: '/v1/app_song_list_offset',
      method: 'POST',
      router: 'fm.service.kugou.com',
      body: {
        appid: KUGOU_LITE_APPID,
        area_code: 1,
        clienttime,
        clientver: KUGOU_LITE_CLIENTVER,
        data: [{ fmid: id, fmtype: Number(fmtype) || 2, offset: -1, size: Math.max(1, Math.min(50, Number(size) || 20)), singername: '' }],
        get_tracker: 1,
        key,
        mid: kugouLiteDeviceCookies(cred).mid || (kugouIpGuestDevice = kugouIpGuestDevice || { ...createKugouDeviceIdentity(), dfid: '-' }).mid,
        uid: Number(cred?.userid) || 0,
      },
    })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.errmsg || json.msg)) || 'KUGOU_RADIO_SONGS_FAILED', tracks: [] }
    }
    if (process.env.KUGOU_DEBUG_RADIO) console.warn('[radio-songs] raw:', JSON.stringify(json).slice(0, 1500))
    const data = json.data
    // fm_songs 的 data 是 [{ fmid, size, songs:[...] }]：容器里才是曲目（实测 2026-10-07）
    const list = Array.isArray(data) ? data : ((data && (data.songlist || data.songs || data.info || data.list)) || [])
    const rows = list
      .flatMap(item => (item && Array.isArray(item.songs)) ? item.songs : [item])
      .filter(item => item && (item.hash || item.filename))
    const tracks = rows.map(item => {
      const hash = String(item.hash || '').toLowerCase()
      const rawName = decodeKugouDisplayText(item.name || item.filename || '')
      const sep = rawName.indexOf(' - ')
      return {
        hash,
        songName: sep > 0 ? rawName.slice(sep + 3) : rawName,
        singerName: sep > 0 ? rawName.slice(0, sep) : '',
        albumId: String(item.album_id || ''),
        albumAudioId: Number(item.audio_id || item.album_audio_id || 0) || undefined,
        mixSongId: Number(item.mixsongid || item.audio_id || 0) || undefined,
        fileId: String(item.fileid || ''),
        duration: Math.round(Number(item.timelen || item.duration || 0) || 0) || undefined,
        coverUrl: kugouCoverUrl((item.trans_param && item.trans_param.union_cover) || ''),
      }
    }).filter(track => track.hash && track.songName)
    return { success: true, tracks, total: tracks.length }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_RADIO_SONGS_FAILED', tracks: [] }
  }
}
/** 频道列表（/youth/v2/channel/channel_all_list，概念版） */
export async function fetchKugouChannels(cred, page = 1, pagesize = 30) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/youth/v2/channel/channel_all_list',
      method: 'GET',
      params: { page: Math.max(1, Number(page) || 1), pagesize: Math.max(1, Math.min(50, Number(pagesize) || 30)), type: 1 },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_CHANNELS_FAILED' }
  }
}

/** 歌单分类标签（/pubsongs/v1/get_tags_by_type，tag_type=collection） */
export async function fetchKugouPlaylistTags(cred) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/pubsongs/v1/get_tags_by_type',
      method: 'POST',
      body: { tag_type: 'collection', tag_id: 0, source: 3 },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_TAGS_FAILED' }
  }
}

/** 乐库首页（/v1/yueku/recommend_v2，概念版乐库页同源）：新歌/专辑/榜单/歌单专区一次取回。
 *  实测游客设备凭据可用（不需要登录），因此探索页乐库板块不依赖概念版扫码凭据。
 *  返回 data.info.{song,album,rank,recommend}，字段映射由客户端 kugouService 做（不在这里猜结构）。 */
export async function fetchKugouYueku(cred) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v1/yueku/recommend_v2',
      method: 'GET',
      params: { operator: 7, plat: 0, type: 11, area_code: 1, req_multi: 1 },
      router: 'service.mobile.kugou.com',
    })
    return { success: Number(json?.status) === 1 || Boolean(json?.data), data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_YUEKU_FAILED' }
  }
}

/** 新歌速递（/musicadservice/container/v1/newsong_publish）：rank_id 21608=华语新歌速递（实测唯一可用档） */
export async function fetchKugouNewSongs(cred, rankId = 21608, page = 1, pagesize = 30) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/musicadservice/container/v1/newsong_publish',
      method: 'POST',
      body: {
        rank_id: Number(rankId) || 21608,
        userid: Number(cred?.userid) || 0,
        page: Math.max(1, Number(page) || 1),
        pagesize: Math.max(1, Math.min(100, Number(pagesize) || 30)),
        tags: [],
      },
    })
    const rows = Array.isArray(json?.data) ? json.data : []
    return { success: Number(json?.error_code || 0) === 0, data: rows, total: Number(json?.total) || rows.length }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_NEWSONG_FAILED', data: [] }
  }
}

/** 歌手目录（/ocean/v6/singer/list）：按分组返回热门歌手（含头像/粉丝数），游客可用 */
export async function fetchKugouSingerList(cred, hotsize = 200) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/ocean/v6/singer/list',
      method: 'GET',
      params: { hotsize: Math.max(1, Math.min(500, Number(hotsize) || 200)), musician: 0, sextype: 0, showtype: 2, type: 0 },
    })
    const groups = Array.isArray(json?.data?.info) ? json.data.info : []
    return { success: groups.length > 0, data: groups }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_SINGER_LIST_FAILED', data: [] }
  }
}

/** 分类歌单（/v2/special_recommend，x-router specialrec）：categoryid 0=推荐；返回歌单带中英文标签与播放量。
 *  上游不支持按 tag 过滤（tagids 参数实测无效），标签过滤在客户端按条目标签做。 */
export async function fetchKugouPlaylistsByTag(cred, categoryId = 0, page = 1, pagesize = 100) {
  try {
    const clienttime = Math.floor(Date.now() / 1000)
    const appid = KUGOU_LITE_APPID
    const clientver = KUGOU_LITE_CLIENTVER
    const json = await kugouLiteRequest({
      cred,
      path: '/v2/special_recommend',
      method: 'POST',
      router: 'specialrec.service.kugou.com',
      body: {
        appid,
        mid: cred?.mid || '-',
        clientver,
        platform: 'android',
        clienttime: String(clienttime),
        userid: Number(cred?.userid) || 0,
        module_id: 1,
        page: Math.max(1, Number(page) || 1),
        pagesize: Math.max(1, Math.min(100, Number(pagesize) || 100)),
        key: crypto.createHash('md5').update(`${appid}${KUGOU_LITE_ANDROID_SALT}${clientver}${clienttime}`).digest('hex'),
        special_recommend: {
          withtag: 1,
          withsong: 1,
          sort: 1,
          ugc: 1,
          is_selected: 0,
          withrecommend: 1,
          area_code: 1,
          categoryid: Number(categoryId) || 0,
        },
        req_multi: 1,
        retrun_min: 5,
        return_special_falg: 1,
      },
    })
    const list = Array.isArray(json?.data?.special_list) ? json.data.special_list : []
    return { success: list.length > 0, data: list, hasNext: Boolean(json?.data?.has_next) }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_TAG_PLAYLIST_FAILED', data: [] }
  }
}

/** 听书·每日推荐（/longaudio/v1/home_new/daily_recommend） */
export async function fetchKugouLongaudioDaily(cred, page = 1, pagesize = 30) {
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/longaudio/v1/home_new/daily_recommend',
      method: 'POST',
      params: { module_id: 1, size: Math.max(1, Math.min(50, Number(pagesize) || 30)), page: Math.max(1, Number(page) || 1) },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_LONGAUDIO_FAILED' }
  }
}

/** 听书·专辑详情（/openapi/v2/broadcast，KG-TID 78） */
export async function fetchKugouLongaudioAlbum(cred, albumIds) {
  const ids = (Array.isArray(albumIds) ? albumIds : String(albumIds || '').split(',')).map(id => String(id || '').trim()).filter(Boolean).slice(0, 10)
  if (!ids.length) return { success: false, error: 'MISSING_ALBUM_ID', data: null }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/openapi/v2/broadcast',
      method: 'POST',
      params: { 'KG-TID': '78' },
      body: {
        data: ids.map(album_id => ({ album_id })),
        show_album_tag: 1,
        fields: 'album_name,album_id,category,authors,sizable_cover,intro,author_name,trans_param,album_tag,mix_intro,full_intro,is_publish',
      },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_LONGAUDIO_ALBUM_FAILED' }
  }
}

/** 听书·章节列表（/longaudio/v2/album_audios，x-router openapi.kugou.com） */
export async function fetchKugouLongaudioAudios(cred, albumId, page = 1, pagesize = 30) {
  if (!albumId) return { success: false, error: 'MISSING_ALBUM_ID', data: null }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/longaudio/v2/album_audios',
      method: 'POST',
      router: 'openapi.kugou.com',
      params: { 'KG-TID': '78' },
      body: {
        album_id: Number(albumId) || albumId,
        area_code: 1,
        tagid: 0,
        page: Math.max(1, Number(page) || 1),
        pagesize: Math.max(1, Math.min(100, Number(pagesize) || 30)),
      },
    })
    return { success: Number(json?.status) === 1, data: json?.data || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_LONGAUDIO_AUDIOS_FAILED' }
  }
}

/** 概念版歌词/播放：听书音频走同一套 /v5/url（hash 来自章节列表） */
export async function resolveKugouLongaudioUrl(cred, params) {
  return resolveKugouConceptSongUrl(cred, params)
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

// ─────────── 最近播放 / 播放上报 / 评论 / 歌单写操作 / 云盘 / 已购（3.C）───────────
// 端点与参数取自 D:\opencode\.tmp-kugou-endpoints.md（实测结论）。网关层只做取数与最小映射，
// 上层 kugouService 再翻译成领域对象；不在这里猜字段以外的语义。

const KUGOU_STANDARD_APPID = 1005
const KUGOU_STANDARD_CLIENTVER = 20489
// 评论读取的游客设备身份（error mid 10002 回退用；与凭据设备无关）
let kugouCommentGuestDevice = null
const KUGOU_COMMENT_SONG_CODE = 'fc4be23b4e972707f36b8a828a93ba8a'
// 标准版 RSA 公钥（Folia kugoumusicapi util/crypto.js）：云盘 p 载荷在概念版公钥失败时的兜底
const KUGOU_STANDARD_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDIAG7QOELSYoIJvTFJhMpe1s/gbjDJX51HBNnEl5HXqTW6lQ7LC8jr9fWZTwusknp+sVGzwd40MwP6U5yDE27M/X1+UR4tvOGOqp94TJtQ1EPnWGWXngpeIW5GxoQGao1rmYWAu6oi1z9XkChrsUdC6DJE5E221wf/4WLFxwAtRQIDAQAB
-----END PUBLIC KEY-----`

/** 二进制响应（arraybuffer）请求：AES 加密的响应体不能用 resp.text() 读，会损坏字节 */
async function requestBuffer(targetUrl, opts, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (opts && opts.timeout) || 12000)
  try {
    const resp = await fetch(targetUrl, {
      method: (opts && opts.method) || 'GET',
      headers: opts && opts.headers,
      body: body || undefined,
      signal: controller.signal,
    })
    return Buffer.from(await resp.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

/** 概念版带签名的 arraybuffer 请求（删除歌单用；params 不注入默认值，与上游实测请求逐字一致） */
async function kugouLiteArrayBufferRequest({ cred, path, params, body, router }) {
  const device = kugouLiteDeviceCookies(cred)
  const merged = Object.assign({}, params || {})
  const bodyText = typeof body === 'string' ? body : JSON.stringify(body == null ? null : body)
  merged.signature = kugouLiteSignatureAndroid(merged, bodyText)
  const u = new URL(path, KUGOU_GATEWAY)
  Object.keys(merged).forEach(key => u.searchParams.set(key, String(merged[key])))
  const headers = Object.assign(kugouLiteHeaders(device, merged.clienttime || Math.floor(Date.now() / 1000)), { 'Content-Type': 'application/octet-stream' })
  if (router) headers['x-router'] = router
  return requestBuffer(u.toString(), { method: 'POST', headers }, bodyText)
}

/** 无签名 JSON 请求（已购单曲/专辑：上游 openapi 不校验 android 签名，参数全部走 body） */
async function kugouPlainJsonRequest(cred, path, body) {
  const device = kugouLiteDeviceCookies(cred)
  const clienttime = Math.floor(Date.now() / 1000)
  const u = new URL(path, KUGOU_GATEWAY)
  const headers = Object.assign(kugouLiteHeaders(device, clienttime), { 'Content-Type': 'application/json' })
  return requestJson(u.toString(), { method: 'POST', headers }, JSON.stringify(body == null ? {} : body))
}

/** 权限接口按 hash 反查 mxid（=album_audio_id）：上报播放缺 mxid 时兜底 */
async function kugouLiteLookupMixSongId(cred, hash) {
  const fileHash = String(hash || '').toLowerCase()
  if (!fileHash) return 0
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/v2/get_res_privilege/lite',
      method: 'POST',
      router: 'media.store.kugou.com',
      body: {
        appid: KUGOU_LITE_APPID,
        area_code: 1,
        behavior: 'play',
        clientver: KUGOU_LITE_CLIENTVER,
        need_hash_offset: 1,
        relate: 1,
        support_verify: 1,
        resource: [{ type: 'audio', page_id: 0, hash: fileHash, album_id: 0 }],
        qualities: ['128', '320', 'flac'],
      },
    })
    const row = Array.isArray(json && json.data)
      ? json.data.find(item => String((item && item.hash) || '').toLowerCase() === fileHash)
      : null
    return Number(row && (row.album_audio_id || row.audio_id || row.mixsongid)) || 0
  } catch {
    return 0
  }
}

/** 真正的最近播放（/playhistory/v1/get_songs；bp 为上一页响应的 data.bp，回传即翻页） */
export async function fetchKugouPlayRecords(cred, options = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', songs: [], hasMore: false }
  try {
    const body = {
      token: String(cred.token),
      userid: Number(cred.userid) || 0,
      source_classify: 'app',
      to_subdivide_sr: 1,
    }
    const bp = String(options.bp || '').trim()
    if (bp) body.bp = bp
    const json = await kugouLiteRequest({ cred, path: '/playhistory/v1/get_songs', method: 'POST', body })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_PLAYRECORDS_FAILED', errorCode: json && json.error_code, songs: [], hasMore: false }
    }
    const data = json.data || {}
    const rows = Array.isArray(data.songs) ? data.songs : []
    const songs = rows.map(item => {
      const info = (item && item.info) || {}
      const singerinfo = Array.isArray(info.singerinfo) ? info.singerinfo : []
      const mxid = Number(item && item.mxid || info.mixsongid || info.album_audio_id || 0) || 0
      return {
        mxid,
        ot: Number(item && item.ot || 0) || 0,
        pc: Number(item && item.pc || 0) || 0,
        hash: String(info.hash || '').toLowerCase(),
        songName: decodeKugouDisplayText(info.name || ''),
        singerName: decodeKugouDisplayText(info.singername || singerinfo.map(a => a && a.name).filter(Boolean).join('、')),
        singerId: String((singerinfo[0] && singerinfo[0].id) || '') || undefined,
        albumId: String(info.album_id || '') || undefined,
        albumName: decodeKugouDisplayText(info.album_name || info.albumname || '') || undefined,
        albumAudioId: mxid || Number(info.mixsongid || info.audio_id || 0) || undefined,
        duration: Math.round((Number(info.timelen || 0) || 0) / 1000) || undefined,
        coverUrl: kugouCoverUrl((info.trans_param && info.trans_param.union_cover) || info.cover || ''),
      }
    }).filter(song => song.hash && song.songName)
      // 官方「最近播放」按播放时间倒序；上游同秒内的条目顺序不稳定，这里按 ot 稳定排序
      .sort((a, b) => (b.ot || 0) - (a.ot || 0))
    return {
      success: true,
      songs,
      hasMore: Boolean(data.has_more),
      bp: String(data.bp == null ? '' : data.bp),
      finished: Boolean(data.bp_finished),
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PLAYRECORDS_FAILED', songs: [], hasMore: false }
  }
}

/** 播放上报（/playhistory/v1/upload_songs?plat=3）；ot 必须是秒，mxid 缺失时按 hash 反查 */
export async function uploadKugouPlayRecord(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const ot = Math.max(0, Math.floor(Number(params.ot) || Date.now() / 1000))
  let mxid = Number(params.mxid) || 0
  if (!mxid && params.hash) mxid = await kugouLiteLookupMixSongId(cred, params.hash)
  if (!mxid) return { success: false, error: 'MISSING_MXID' }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/playhistory/v1/upload_songs',
      method: 'POST',
      params: { plat: 3 },
      body: {
        songs: [{ mxid, op: 1, ot, pc: Math.max(1, Number(params.pc) || 1) }],
        token: String(cred.token),
        userid: Number(cred.userid) || 0,
      },
    })
    const row = json && json.data && Array.isArray(json.data.songs) ? json.data.songs[0] : null
    const code = Number(row && row.code) || 0
    return { success: code === 1, code, mxid }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PLAYRECORD_UPLOAD_FAILED', mxid }
  }
}

/** 歌曲评论列表（/mcomment/v1/cmtlist；需 mixsongid） */
export async function fetchKugouSongComments(cred, params = {}) {
  const mixsongid = Number(params.mixsongid) || 0
  if (!mixsongid) return { success: false, error: 'MISSING_MIXSONGID', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  try {
    let json = await kugouLiteRequest({
      cred,
      path: '/mcomment/v1/cmtlist',
      method: 'POST',
      params: {
        mixsongid,
        need_show_image: 1,
        // 上游实测分页参数名以 page 下发（模块内部映射 p）；两个都带，防止上游版本只认其中一个
        page,
        p: page,
        pagesize,
        show_classify: 1,
        show_hotword_list: 1,
        extdata: 0,
        code: KUGOU_COMMENT_SONG_CODE,
      },
    })
    // 实测：用「外部来源的设备 mid + 我们的 token」会被上游拒为 error mid(10002)；
    // 评论读取是公开数据，这里换成自有一份游客设备身份重试一次（自带 mid 的扫码凭据不受影响）
    if (json && Number(json.error_code || json.err_code) === 10002) {
      kugouCommentGuestDevice = kugouCommentGuestDevice || { ...createKugouDeviceIdentity(), dfid: '-' }
      json = await kugouLiteRequest({
        cred: kugouCommentGuestDevice,
        path: '/mcomment/v1/cmtlist',
        method: 'POST',
        params: {
          mixsongid,
          need_show_image: 1,
          page,
          p: page,
          pagesize,
          show_classify: 1,
          show_hotword_list: 1,
          extdata: 0,
          code: KUGOU_COMMENT_SONG_CODE,
        },
      })
    }
    if (!json || Number(json.status) !== 1 || (json.err_code != null && Number(json.err_code) !== 0)) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_COMMENTS_FAILED', errorCode: json && (json.error_code || json.err_code), data: null }
    }
    // 实测 cmtlist 的 count/list/maxPage/hot_word_list 在响应顶层（不在 data 包装里）；兼容 data 包装形态
    const normalized = json.data && typeof json.data === 'object'
      ? json.data
      : {
          count: json.count,
          list: json.list,
          maxPage: json.maxPage,
          hot_word_list: json.hot_word_list,
          childrenid: json.childrenid,
        }
    // show_classify:1 下发的分类列表（客户端第一排过滤标签：「歌曲相关 / 有图 / 烟花 / …」），
    // 实测字段名 classify_list，条目形如 { id: 13, label: '歌曲相关', icon, cnt: 4135 }；
    // 同响应里还有 tag[]（首项是「全部 + 总数」）。两者都归一化成 [{ id, name, count }]、
    // tag 归一化成 [{ name, count }]，UI 直接拿来渲染 chips。
    const classifyRaw = normalized.classify_list || normalized.classify || json.classify_list || json.classify
    const classify = Array.isArray(classifyRaw)
      ? classifyRaw.map(entry => ({
          id: String((entry && (entry.id ?? entry.type_id ?? entry.typeId)) ?? ''),
          name: decodeKugouDisplayText((entry && (entry.label ?? entry.name ?? entry.title)) || ''),
          count: Number((entry && (entry.cnt ?? entry.count ?? entry.num)) || 0) || 0,
        })).filter(entry => entry.id && entry.name)
      : []
    const tagRaw = normalized.tag || json.tag
    const tags = Array.isArray(tagRaw)
      ? tagRaw.map(entry => ({
          name: decodeKugouDisplayText((entry && (entry.name ?? entry.label)) || ''),
          count: Number((entry && (entry.count ?? entry.cnt)) || 0) || 0,
        })).filter(entry => entry.name)
      : []
    return { success: true, data: { ...normalized, classify, tags } }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENTS_FAILED', data: null }
  }
}

/** 评论数（web 签名 /index.php?r=comments/getcommentsnum；响应是裸 map {"<hash>": 391}） */
export async function fetchKugouCommentCount(cred, hash) {
  const fileHash = String(hash || '').toLowerCase()
  if (!fileHash) return { success: false, count: 0, error: 'MISSING_HASH' }
  try {
    const device = kugouLiteDeviceCookies(cred)
    const params = kugouLiteParams(cred, { r: 'comments/getcommentsnum', code: KUGOU_COMMENT_SONG_CODE, hash: fileHash })
    params.signature = kugouLiteSignatureWeb(params)
    const u = new URL('/index.php', KUGOU_GATEWAY)
    Object.keys(params).forEach(key => u.searchParams.set(key, String(params[key])))
    const headers = Object.assign(kugouLiteHeaders(device, params.clienttime), { 'x-router': 'sum.comment.service.kugou.com' })
    const json = await requestJson(u.toString(), { headers })
    // 裸 map：键是请求的 hash；个别版本会回对象包装，这里按三种形状兜底
    const raw = json && typeof json === 'object'
      ? (json[fileHash] ?? json[hash] ?? (Object.values(json)[0]))
      : json
    const count = Number(raw) || 0
    return { success: true, count }
  } catch (error) {
    return { success: false, count: 0, error: error?.message || 'KUGOU_COMMENT_COUNT_FAILED' }
  }
}

/** 楼层评论（/mcomment/v1/hot_replylist；special_id 必传，否则 20006） */
export async function fetchKugouCommentFloor(cred, params = {}) {
  const specialId = String(params.specialId || params.childrenid || '').trim()
  const tid = String(params.tid || '').trim()
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID', data: null }
  // 实测：childrenid 单独传 → err_code 10002；tid 必须是评论 id（传 special_id 会 60102）
  if (!tid) return { success: false, error: 'MISSING_TID', message: '楼层评论需要评论 id（tid）', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/mcomment/v1/hot_replylist',
      method: 'POST',
      params: {
        childrenid: specialId,
        tid,
        need_show_image: 1,
        page,
        p: page,
        pagesize,
        show_classify: 1,
        show_hotword_list: 1,
        code: KUGOU_COMMENT_SONG_CODE,
        ...(Number(params.mixsongid) ? { mixsongid: Number(params.mixsongid) } : {}),
      },
    })
    // 楼层响应的 list 也在顶层；err_code !== 0（如 60102）视为失败
    if (!json || Number(json.status) !== 1 || Number(json.err_code || 0) !== 0 || !Array.isArray(json.list)) {
      return {
        success: false,
        error: (json && (json.error || json.msg)) || 'KUGOU_COMMENT_FLOOR_FAILED',
        errorCode: json && (json.error_code || json.err_code),
        data: null,
      }
    }
    return { success: true, data: { list: json.list, count: Number(json.comments_num) || 0, childrenid: json.childrenid, tid: json.tid } }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_FLOOR_FAILED', data: null }
  }
}

// ─────────────────────── 酷狗评论写操作 / 读增强（web commentsv2/3 家族 + mlike） ───────────────────────
// 2026-10-07 实测（概念版扫码凭据，appid 3116）：
// - 写接口不在 gateway.kugou.com：发表/回复/删除在 mcomment.kugou.com/index.php?r=...，
//   点赞在 mlike.kugou.com/like/handlelike（来自酷狗「神评」活动页 bundle）。
// - 身份用概念版参数即可（appid=3116/clientver=11440 + clienttoken=概念版 token），
//   key = md5(3116 + lite 盐 + 11440 + clienttime + mid [+ JSON body])；实测可写。
// - 列表接口 getCommentWithLike 必须带 extdata（缺它实测 err_code=10002）。
// - 排序：实测 sort/order/sort_type/sort_method/sortMethod 等参数对该接口全部无效（返回同序）；
//   「最热」另有 per-song 的 H5 榜单 /r/v1/rank/topliked（实测按点赞量返回）。
const KUGOU_COMMENT_WEB_HOST = 'https://mcomment.kugou.com'
const KUGOU_COMMENT_LIKE_HOST = 'https://mlike.kugou.com'
// 该 H5 评论服务只监听 http（https 直连被拒），随上方 topad 返回的 url 一致
const KUGOU_COMMENT_H5_HOST = 'http://m.comment.service.kugou.com'
// handlelike 的 assign 盐（酷狗神评活动页内联 bundle 实测）
const KUGOU_COMMENT_LIKE_ASSIGN_SALT = '949ad1dac503e48ad6e86bb841383485'

function kugouCommentWebHeaders(cred, withJsonBody) {
  const device = kugouLiteDeviceCookies(cred)
  const headers = {
    'User-Agent': KUGOU_H5_UA,
    Referer: 'https://www.kugou.com/',
    // web 家族按 cookie 里 kg_mid/kg_dfid 关联设备；身份校验实际用 clienttoken
    Cookie: `kg_mid=${device.mid}; kg_dfid=${device.dfid}`,
    'x-router': 'm.comment.service.kugou.com',
  }
  if (withJsonBody) headers['Content-Type'] = 'application/json; charset=UTF-8'
  return headers
}

/** 组装 web 评论写接口的公共参数（含 key 签名；body 参与签名时传 withBody） */
function kugouCommentWebAuth(cred, withBody) {
  const device = kugouLiteDeviceCookies(cred)
  const clienttime = String(Math.floor(Date.now() / 1000))
  const key = crypto.createHash('md5')
    .update(`${KUGOU_LITE_APPID}${KUGOU_LITE_ANDROID_SALT}${KUGOU_LITE_CLIENTVER}${clienttime}${device.mid}${withBody || ''}`)
    .digest('hex')
  return {
    kugouid: String((cred && cred.userid) || ''),
    ver: '6',
    clienttoken: String((cred && cred.token) || ''),
    appid: String(KUGOU_LITE_APPID),
    clientver: String(KUGOU_LITE_CLIENTVER),
    mid: device.mid,
    clienttime,
    uuid: '-',
    dfid: device.dfid,
    key,
  }
}

/** 评论池资源解析：childrenid(special_child_id) + childrenname（发表/回复都要求） */
async function kugouCommentResolveResource(cred, mixsongid) {
  if (!mixsongid) return { specialId: '', songName: '' }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/mcomment/v1/cmtlist',
      method: 'POST',
      params: {
        mixsongid,
        need_show_image: 1,
        page: 1,
        p: 1,
        pagesize: 1,
        extdata: 0,
        code: KUGOU_COMMENT_SONG_CODE,
        show_classify: 1,
        show_hotword_list: 1,
      },
    })
    const first = json && Array.isArray(json.list) ? json.list[0] : null
    return {
      specialId: String((json && json.childrenid) || (first && first.special_child_id) || ''),
      songName: decodeKugouDisplayText((first && (first.special_child_name || first.song_show_text)) || ''),
    }
  } catch {
    return { specialId: '', songName: '' }
  }
}

/** 发表评论（POST commentsv3/add；body JSON {data:{content, album_audio_id, images}}）
 *  实测成功：{"status":1,"err_code":0,"msg":"发送成功","addid":1250099147} */
export async function sendKugouSongComment(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const content = String(params.content || '').trim()
  if (!content) return { success: false, error: 'EMPTY_CONTENT' }
  const mixsongid = Number(params.mixsongid) || 0
  let specialId = String(params.specialId || params.special_id || '').trim()
  let songName = String(params.songName || params.song_name || '').trim()
  if (!specialId || !songName) {
    const resolved = await kugouCommentResolveResource(cred, mixsongid)
    specialId = specialId || resolved.specialId
    songName = songName || resolved.songName
  }
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID' }
  try {
    const payload = { data: { content, album_audio_id: mixsongid || undefined, images: Array.isArray(params.images) ? params.images : [] } }
    const body = JSON.stringify(payload)
    const query = new URLSearchParams({
      r: 'commentsv3/add',
      code: KUGOU_COMMENT_SONG_CODE,
      childrenid: specialId,
      childrenname: songName,
      ...kugouCommentWebAuth(cred, body),
    })
    const json = await requestJson(
      `${KUGOU_COMMENT_WEB_HOST}/index.php?${query}`,
      { method: 'POST', headers: kugouCommentWebHeaders(cred, true), timeout: 12000 },
      body,
    )
    if (!json || Number(json.status) !== 1 || Number(json.err_code) !== 0) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_SEND_FAILED', errorCode: json && json.err_code }
    }
    return { success: true, id: String(json.addid || ''), message: json.msg }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_SEND_FAILED' }
  }
}

/** 回复评论/楼层（POST commentsv2/reply，查询参数即全部字段）
 *  tid=被回复对象 id；pid=所属顶级评论 id（回复顶级评论时为 0）；is_t 由 pid 推导（pid=0 → 1）。
 *  实测成功：{"status":1,"err_code":0,"msg":"发送成功","cmtid":1250099173,"addid":776220419} */
export async function replyKugouSongComment(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const content = String(params.content || '').trim()
  if (!content) return { success: false, error: 'EMPTY_CONTENT' }
  const tid = String(params.tid || params.commentId || '').trim()
  if (!tid) return { success: false, error: 'MISSING_TID' }
  const pid = String(params.pid || '0')
  const isT = params.isT == null ? (pid === '0' ? '1' : '0') : String(params.isT)
  const mixsongid = Number(params.mixsongid) || 0
  let specialId = String(params.specialId || params.special_id || '').trim()
  let songName = String(params.songName || params.song_name || '').trim()
  if (!specialId || !songName) {
    const resolved = await kugouCommentResolveResource(cred, mixsongid)
    specialId = specialId || resolved.specialId
    songName = songName || resolved.songName
  }
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID' }
  try {
    const query = new URLSearchParams({
      r: 'commentsv2/reply',
      code: KUGOU_COMMENT_SONG_CODE,
      childrenid: specialId,
      childrenname: songName,
      content,
      tid,
      is_t: isT,
      pid,
      ...kugouCommentWebAuth(cred),
    })
    const json = await requestJson(`${KUGOU_COMMENT_WEB_HOST}/index.php?${query}`, { method: 'POST', headers: kugouCommentWebHeaders(cred, false), timeout: 12000 })
    if (!json || Number(json.status) !== 1 || Number(json.err_code) !== 0) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_REPLY_FAILED', errorCode: json && json.err_code }
    }
    return { success: true, id: String(json.cmtid || json.addid || ''), replyId: String(json.addid || ''), message: json.msg }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_REPLY_FAILED' }
  }
}

/** 点赞/取消点赞（GET mlike.kugou.com/like/handlelike；上游是 toggle）
 *  assign = md5(code + clienttime + 固定盐)，clienttime 与 timestamp 一致。
 *  实测：{"status":1,"err_code":0,"msg":"点赞成功","islike":1,"object":1771023722}
 *  liked 传入期望态：一次调用后若与期望不符（并发/重复点击）再补一次翻转。 */
export async function likeKugouComment(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const commentId = String(params.commentId || params.cid || '').trim()
  if (!commentId) return { success: false, error: 'MISSING_COMMENT_ID' }
  const specialId = String(params.specialId || params.special_id || params.childrenid || '').trim()
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID' }
  const device = kugouLiteDeviceCookies(cred)
  const callOnce = async () => {
    const clienttime = String(Math.floor(Date.now() / 1000))
    const assign = crypto.createHash('md5').update(`${KUGOU_COMMENT_SONG_CODE}${clienttime}${KUGOU_COMMENT_LIKE_ASSIGN_SALT}`).digest('hex')
    const query = new URLSearchParams({
      childrenid: specialId,
      object: commentId,
      assign,
      kugouid: String(cred.userid),
      appid: String(KUGOU_LITE_APPID),
      clienttoken: String(cred.token),
      mid: device.mid,
      timestamp: clienttime,
      modulecode: KUGOU_COMMENT_SONG_CODE,
      format: 'jsonp',
      from: 'phone',
    })
    return requestJson(`${KUGOU_COMMENT_LIKE_HOST}/like/handlelike?${query}`, { headers: { 'User-Agent': KUGOU_H5_UA, Referer: 'https://www.kugou.com/', Cookie: `kg_mid=${device.mid}; kg_dfid=${device.dfid}` }, timeout: 12000 })
  }
  try {
    let json = await callOnce()
    if (!json || Number(json.status) !== 1 || Number(json.err_code) !== 0) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_LIKE_FAILED', errorCode: json && json.err_code }
    }
    let isLiked = Number(json.islike) === 1
    const expected = params.liked == null ? null : Boolean(params.liked)
    if (expected !== null && isLiked !== expected) {
      json = await callOnce()
      if (!json || Number(json.status) !== 1 || Number(json.err_code) !== 0) {
        return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_LIKE_FAILED', errorCode: json && json.err_code }
      }
      isLiked = Number(json.islike) === 1
    }
    return { success: true, isLiked, message: json.msg }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_LIKE_FAILED' }
  }
}

/** 删除自己的评论/楼层（GET commentsv2/delcomment；cid=评论 id，tid=所在楼层父评论 id）
 *  实测（2026-10-07 复核）：恒回 {"status":1,"msg":""}（受理），删别人评论返回 status=0；
 *  但 status=1 只代表受理——同设备身份发表+删除、15 分钟后评论仍可见、列表 count 不回落，
 *  childrenname/hash/special_id/POST 等参数变体均无效。实际移除疑似走审核队列，UI 不提供删除。 */
export async function deleteKugouSongComment(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const cid = String(params.commentId || params.cid || '').trim()
  if (!cid) return { success: false, error: 'MISSING_COMMENT_ID' }
  const specialId = String(params.specialId || params.special_id || params.childrenid || '').trim()
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID' }
  try {
    const query = new URLSearchParams({
      r: 'commentsv2/delcomment',
      code: KUGOU_COMMENT_SONG_CODE,
      childrenid: specialId,
      cid,
      tid: String(params.tid || cid),
      ...kugouCommentWebAuth(cred),
    })
    const json = await requestJson(`${KUGOU_COMMENT_WEB_HOST}/index.php?${query}`, { headers: kugouCommentWebHeaders(cred, false), timeout: 12000 })
    if (!json || Number(json.status) !== 1) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_DELETE_FAILED', errorCode: json && json.err_code }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_DELETE_FAILED' }
  }
}

/** 单曲最热评论（H5 /r/v1/rank/topliked；实测按点赞量排序，p/pagesize 可翻页）
 *  tag[] 是该页的标签 chips（全部/最热，官方下发）。 */
export async function fetchKugouHotComments(cred, params = {}) {
  const specialId = String(params.specialId || params.special_id || params.childrenid || '').trim()
  if (!specialId) return { success: false, error: 'MISSING_SPECIAL_ID', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  try {
    const query = new URLSearchParams({
      code: KUGOU_COMMENT_SONG_CODE,
      childrenid: specialId,
      p: String(page),
      pagesize: String(pagesize),
    })
    const json = await requestJson(`${KUGOU_COMMENT_H5_HOST}/r/v1/rank/topliked?${query}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        Referer: 'http://m.kugou.com/',
        Cookie: kugouCommentWebHeaders(cred, false).Cookie,
      },
      timeout: 12000,
    })
    if (!json || Number(json.err_code) !== 0 || !Array.isArray(json.list)) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_HOT_FAILED', errorCode: json && json.err_code, data: null }
    }
    return {
      success: true,
      data: {
        list: json.list,
        count: Number(json.count) || 0,
        tags: Array.isArray(json.tag) ? json.tag : [],
        currentPage: Number(json.current_page) || page,
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_HOT_FAILED', data: null }
  }
}

/** 网页版列表（POST commentsv2/getCommentWithLike；实测 extdata 必传，否则 10002）
 *  默认序=最新评论优先 + 官方置顶热评（实测 sort/order/sort_type/sort_method 参数全部无效）。 */
export async function fetchKugouWebCommentList(cred, params = {}) {
  const mixsongid = Number(params.mixsongid) || 0
  if (!mixsongid) return { success: false, error: 'MISSING_MIXSONGID', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  try {
    const query = new URLSearchParams({
      r: 'commentsv2/getCommentWithLike',
      code: KUGOU_COMMENT_SONG_CODE,
      mixsongid: String(mixsongid),
      p: String(page),
      pagesize: String(pagesize),
      extdata: '0',
    })
    const json = await requestJson(`${KUGOU_COMMENT_WEB_HOST}/index.php?${query}`, { method: 'POST', headers: kugouCommentWebHeaders(cred, false), timeout: 12000 })
    if (!json || Number(json.err_code) !== 0 || !Array.isArray(json.list)) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENTS_FAILED', errorCode: json && json.err_code, data: null }
    }
    return {
      success: true,
      data: {
        list: json.list,
        count: Number(json.count) || 0,
        combineCount: Number(json.combine_count) || 0,
        maxPage: Number(json.maxPage) || 0,
        currentPage: Number(json.current_page) || page,
        childrenid: String(json.childrenid || ''),
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENTS_FAILED', data: null }
  }
}

/** 按热词过滤评论（POST /mcomment/v1/get_hot_word；热词来自 cmtlist 的 hot_word_list）
 *  实测 hot_word=晴天 → err_code=0，count=300，按热度返回。 */
export async function fetchKugouHotWordComments(cred, params = {}) {
  const mixsongid = Number(params.mixsongid) || 0
  const hotWord = String(params.hotWord || params.hot_word || '').trim()
  if (!mixsongid) return { success: false, error: 'MISSING_MIXSONGID', data: null }
  if (!hotWord) return { success: false, error: 'MISSING_HOT_WORD', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/mcomment/v1/get_hot_word',
      method: 'POST',
      params: {
        mixsongid,
        need_show_image: 1,
        p: page,
        page,
        pagesize,
        hot_word: hotWord,
        extdata: '0',
        code: KUGOU_COMMENT_SONG_CODE,
      },
    })
    if (!json || (json.err_code != null && Number(json.err_code) !== 0) || !Array.isArray(json.list)) {
      return { success: false, error: (json && (json.msg || json.message)) || 'KUGOU_COMMENT_WORD_FAILED', errorCode: json && json.err_code, data: null }
    }
    return { success: true, data: { list: json.list, count: Number(json.count) || 0, maxPage: Number(json.maxPage) || 0, childrenid: String(json.childrenid || '') } }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_WORD_FAILED', data: null }
  }
}

/** 歌曲详情（POST /kmr/v2/audio，x-router openapi.kugou.com + KG-TID 238；入参 album_audio_id = mixsongid）。
 *  官方客户端「歌曲详情」弹窗的数据源：歌名/歌手（含国籍/生日）/专辑（含发行时间/封面）/
 *  发行日期/语种/风格标签，一次请求全拿。fields 不给只回 base，等价于空壳。 */
export async function fetchKugouSongDetail(cred, params = {}) {
  const albumAudioId = Number(params.albumAudioId ?? params.album_audio_id ?? params.mixsongid) || 0
  if (!albumAudioId) return { success: false, error: 'MISSING_ALBUM_AUDIO_ID', data: null }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/kmr/v2/audio',
      method: 'POST',
      router: 'openapi.kugou.com',
      headers: { 'KG-TID': '238' },
      body: {
        data: [{ entity_id: albumAudioId }],
        fields: 'base,album_info,authors.base,tags,audio_info',
      },
    })
    const row = Array.isArray(json && json.data) ? json.data[0] : null
    if (!json || Number(json.status) !== 1 || !row || !Object.keys(row).length) {
      return { success: false, error: (json && (json.errmsg || json.error)) || 'KUGOU_SONG_DETAIL_EMPTY', data: null }
    }
    const base = row.base || {}
    const albumInfo = row.album_info || {}
    const audioInfo = row.audio_info || {}
    const authors = Array.isArray(row.authors) ? row.authors.map(a => a && a.base).filter(Boolean) : []
    const tags = Array.isArray(row.tags) ? row.tags : []
    // 风格：客户端按 pid 分层，弹窗里取一级/流行分类的前几个名字（排除「活动」这类运营标签）
    const genres = tags.filter(tag => tag && tag.name && Number(tag.pid) > 0).map(tag => tag.name)
    return {
      success: true,
      data: {
        songName: decodeKugouDisplayText(base.songname || ''),
        singerName: decodeKugouDisplayText(base.author_name || ''),
        singers: authors.map(author => ({
          id: String(author.author_id || ''),
          name: decodeKugouDisplayText(author.author_name || ''),
          avatar: kugouCoverUrl(author.avatar || ''),
          country: decodeKugouDisplayText(author.country || ''),
          birthday: String(author.birthday || ''),
        })),
        album: {
          id: String(base.album_id || albumInfo.album_id || ''),
          name: decodeKugouDisplayText(base.album_name || albumInfo.album_name || ''),
          publishDate: String(albumInfo.publish_date || base.publish_date || ''),
          coverUrl: kugouCoverUrl(albumInfo.cover || ''),
        },
        publishDate: String(base.publish_date || ''),
        language: decodeKugouDisplayText(base.language || ''),
        genres,
        duration: Math.round((Number(audioInfo.timelength || 0) || 0) / 1000) || undefined,
        hash: String(audioInfo.hash || '').toLowerCase() || undefined,
        qualities: {
          standard: Boolean(audioInfo.timelength_128 || audioInfo.filesize_128),
          hq: Boolean(audioInfo.hash_320),
          sq: Boolean(audioInfo.hash_flac),
          hires: Boolean(audioInfo.hash_high || audioInfo.hash_super),
        },
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_SONG_DETAIL_FAILED', data: null }
  }
}

/** 分类评论（POST /mcomment/v1/cmt_classify_list；type_id 来自 cmtlist 的分类列表）
 *  官方客户端第一排过滤标签（「歌曲相关 / 有图 / 烟花 / …」）点下去走的就是这里。 */
export async function fetchKugouCommentClassify(cred, params = {}) {
  const mixsongid = Number(params.mixsongid) || 0
  const typeId = Number(params.typeId ?? params.type_id) || 0
  if (!mixsongid) return { success: false, error: 'MISSING_MIXSONGID', data: null }
  if (!typeId) return { success: false, error: 'MISSING_TYPE_ID', data: null }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  // 参考实现只透传 sort=2（倒序），其余一律按 1；上游不接受其它取值
  const sortMethod = Number(params.sort) === 2 ? 2 : 1
  const requestParams = {
    mixsongid,
    need_show_image: 1,
    p: page,
    page,
    pagesize,
    type_id: typeId,
    sort_method: sortMethod,
    extdata: '0',
    code: KUGOU_COMMENT_SONG_CODE,
  }
  try {
    let json = await kugouLiteRequest({ cred, path: '/mcomment/v1/cmt_classify_list', method: 'POST', params: requestParams })
    // 与 cmtlist 同一套游客设备回退（外部 mid + 我们的 token 会被判 10002）
    if (json && Number(json.error_code || json.err_code) === 10002) {
      kugouCommentGuestDevice = kugouCommentGuestDevice || { ...createKugouDeviceIdentity(), dfid: '-' }
      json = await kugouLiteRequest({ cred: kugouCommentGuestDevice, path: '/mcomment/v1/cmt_classify_list', method: 'POST', params: requestParams })
    }
    if (!json || Number(json.status) !== 1 || (json.err_code != null && Number(json.err_code) !== 0)) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_COMMENT_CLASSIFY_FAILED', errorCode: json && (json.error_code || json.err_code), data: null }
    }
    return {
      success: true,
      data: {
        list: Array.isArray(json.list) ? json.list : [],
        count: Number(json.count) || 0,
        maxPage: Number(json.maxPage) || 0,
        childrenid: String(json.childrenid || ''),
      },
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_COMMENT_CLASSIFY_FAILED', data: null }
  }
}

// ─────────────────────── 相似歌曲（标准版 /v3/album_audio/related）───────────────────────
// 官方客户端「相似歌曲」弹窗的数据源。与概念版通道不同：这条走标准版 CDN（appid 1005 /
// clientver 12329），签名是固定盐 + 参数排序 md5，且**不带默认参数**——设备身份只放请求头
// （dfid/mid/clienttime），token 不参与（公开接口，游客设备可读）。
// 必传 album_audio_id（= mixsongid）：客户端弹窗的入参就是它，hash 不认。
const KUGOU_RELATED_CLIENTVER = 12329
const KUGOU_RELATED_BASE = 'https://listkmrp3cdnretry.kugou.com'

export async function fetchKugouSimilarSongs(cred, params = {}) {
  const albumAudioId = Number(params.albumAudioId ?? params.album_audio_id ?? params.mixSongId) || 0
  if (!albumAudioId) return { success: false, error: 'MISSING_ALBUM_AUDIO_ID', songs: [], total: 0 }
  const page = Math.max(1, Number(params.page) || 1)
  const pagesize = Math.max(1, Math.min(50, Number(params.pagesize) || 30))
  const sortMap = { all: 1, hot: 2, new: 3 }
  const query = {
    album_audio_id: albumAudioId,
    appid: KUGOU_STANDARD_APPID,
    area_code: 1,
    clientver: KUGOU_RELATED_CLIENTVER,
    page,
    pagesize,
    show_input: 1,
    show_type: Number(params.showType ?? params.show_type) || 0,
    sort: sortMap[params.sort] || (Number(params.sort) >= 1 && Number(params.sort) <= 3 ? Number(params.sort) : 1),
    type: Number(params.type) || 0,
    version: 1,
  }
  query.signature = signatureAndroidParams(query)
  const device = kugouLiteDeviceCookies(cred)
  try {
    const u = new URL('/v3/album_audio/related', KUGOU_RELATED_BASE)
    Object.keys(query).forEach(key => u.searchParams.set(key, String(query[key])))
    const json = await requestJson(u.toString(), { method: 'GET', headers: kugouLiteHeaders(device, Math.floor(Date.now() / 1000)) })
    const data = json && json.data && !Array.isArray(json.data) ? json.data : {}
    const rows = Array.isArray(data.list) ? data.list
      : Array.isArray(data.songs) ? data.songs
        : Array.isArray(json && json.data) ? json.data
          : []
    if (!rows.length) {
      return {
        success: Number(json && json.status) === 1 || Number(json && json.errcode) === 0,
        songs: [],
        total: 0,
        error: (json && (json.error || json.errmsg || json.msg)) || 'KUGOU_SIMILAR_EMPTY',
      }
    }
    // related 通道的条目是嵌套结构：base（曲目元数据）/ audio_info（hash/时长）/ authors（歌手），
    // 且**不返回封面**——这里复用权限接口的 union_cover 按 hash 批量补，保证弹窗有图。
    const songs = rows.map(item => {
      const base = (item && item.base) || {}
      const audioInfo = (item && item.audio_info) || {}
      const authors = Array.isArray(item && item.authors)
        ? item.authors.map(a => (a && a.base) || a).filter(Boolean)
        : []
      const singer = authors.map(a => a.author_name).filter(Boolean).join('、')
        || decodeKugouDisplayText(base.author_name || '')
      return {
        hash: String(audioInfo.hash || base.hash || '').toLowerCase(),
        songName: decodeKugouDisplayText(base.songname || ''),
        singerName: singer,
        singerId: String((authors[0] && authors[0].author_id) || '') || undefined,
        albumId: String(base.album_id || '') || undefined,
        albumName: decodeKugouDisplayText(base.album_name || ''),
        albumAudioId: Number(base.album_audio_id || base.audio_id || 0) || undefined,
        duration: Math.round((Number(audioInfo.timelength || 0) || 0) / 1000) || undefined,
        coverUrl: '',
      }
    }).filter(song => song.hash && song.songName)
    if (songs.some(song => !song.coverUrl)) {
      const coverMap = await kugouLiteCoverMap(cred, songs.map(song => song.hash))
      for (const song of songs) {
        if (!song.coverUrl && coverMap[song.hash]) song.coverUrl = coverMap[song.hash]
      }
    }
    return { success: true, songs, total: Number(data.total || json.total) || songs.length }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_SIMILAR_FAILED', songs: [], total: 0 }
  }
}

/** add_list 成功判定：data.info 可能是对象或数组，code===1 且带回 listid 才算成功 */
function kugouAddListResult(json) {
  const info = json && json.data && json.data.info
  const entry = Array.isArray(info) ? info[0] : info
  if (!entry || Number(entry.code) !== 1 || !entry.listid) {
    const message = (entry && (entry.err || entry.error || entry.msg)) || (json && (json.error || json.msg)) || 'KUGOU_PLAYLIST_MUTATION_FAILED'
    return { success: false, error: message, errorCode: json && json.error_code }
  }
  return {
    success: true,
    listid: String(entry.listid),
    globalCollectionId: String(entry.global_collection_id || ''),
  }
}

/** 新建歌单（/cloudlist.service/v5/add_list，type=0） */
export async function createKugouUserPlaylist(cred, name, isPrivate) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const cleanName = String(name || '').trim()
  if (!cleanName) return { success: false, error: 'MISSING_NAME' }
  try {
    const clienttime = Math.floor(Date.now() / 1000)
    const json = await kugouLiteRequest({
      cred,
      path: '/cloudlist.service/v5/add_list',
      method: 'POST',
      params: { last_time: clienttime, last_area: 'gztx', userid: Number(cred.userid), token: cred.token },
      body: {
        userid: Number(cred.userid),
        token: cred.token,
        total_ver: 0,
        name: cleanName,
        type: 0,
        source: 1,
        is_pri: isPrivate ? 1 : 0,
        list_create_gid: '',
        from_shupinmv: 0,
      },
    })
    return kugouAddListResult(json)
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PLAYLIST_CREATE_FAILED' }
  }
}

/** 收藏歌单（同 add_list，type=1；上游是「跳转复制」，不会自动搬歌）。
 *  ownerUserId/listid 为歌单归属（从 global_collection_id `collection_3_<uid>_<listid>_0` 解析）。 */
export async function collectKugouPlaylist(cred, params = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const ownerUserId = String(params.ownerUserId || '').replace(/\D/g, '')
  const listid = String(params.listid || '').replace(/\D/g, '')
  if (!ownerUserId || !listid) return { success: false, error: 'MISSING_PLAYLIST_OWNER' }
  try {
    const clienttime = Math.floor(Date.now() / 1000)
    const json = await kugouLiteRequest({
      cred,
      path: '/cloudlist.service/v5/add_list',
      method: 'POST',
      params: { last_time: clienttime, last_area: 'gztx', userid: Number(cred.userid), token: cred.token },
      body: {
        userid: Number(cred.userid),
        token: cred.token,
        total_ver: 0,
        name: String(params.name || ''),
        type: 1,
        source: 1,
        is_pri: 0,
        list_create_userid: Number(ownerUserId),
        list_create_listid: Number(listid),
        list_create_gid: String(params.gid || ''),
        from_shupinmv: 0,
        jump_copy: 2,
      },
    })
    return kugouAddListResult(json)
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PLAYLIST_COLLECT_FAILED' }
  }
}

/** 删除/取消收藏歌单（/v2/delete_list；AES+RSA p，arraybuffer + AES 解密）。
 *  type=1 取消收藏（默认），type=0 删除自建歌单；listid 为数字 listid。 */
export async function deleteKugouUserPlaylist(cred, listid, type = 1) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const numericListId = Number(String(listid || '').replace(/\D/g, '')) || 0
  if (!numericListId) return { success: false, error: 'MISSING_LIST_ID' }
  try {
    const rawKey = crypto.randomBytes(3).toString('hex')
    const bodyText = kugouLiteAes(rawKey, JSON.stringify({ listid: numericListId, total_ver: 0, type: Number(type) === 0 ? 0 : 1 }), false)
    const p = crypto.publicEncrypt(
      { key: KUGOU_LITE_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(JSON.stringify({ aes: rawKey, uid: Number(cred.userid) || 0, token: String(cred.token || '') }), 'utf8'),
    ).toString('hex').toUpperCase()
    const clienttime = Math.floor(Date.now() / 1000)
    const buf = await kugouLiteArrayBufferRequest({
      cred,
      path: '/v2/delete_list',
      router: 'cloudlist.service.kugou.com',
      params: {
        clienttime,
        key: crypto.createHash('md5').update(`${KUGOU_LITE_APPID}${KUGOU_LITE_ANDROID_SALT}${KUGOU_LITE_CLIENTVER}${clienttime}`).digest('hex'),
        last_area: 'gztx',
        clientver: KUGOU_LITE_CLIENTVER,
        appid: KUGOU_LITE_APPID,
        last_time: clienttime,
        p,
      },
      body: bodyText,
    })
    const text = kugouLiteAes(rawKey, buf.toString('base64'), true)
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    const info = json && json.data && json.data.info
    const entry = Array.isArray(info) ? info[0] : info
    if (!json || Number(entry && entry.code) !== 1) {
      return { success: false, error: (entry && (entry.err || entry.error)) || 'KUGOU_PLAYLIST_DELETE_FAILED', data: json }
    }
    return { success: true, data: json }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PLAYLIST_DELETE_FAILED' }
  }
}

/** 云盘列表（mcloudservice /v1/get_list；独立路径：AES body + RSA p，响应 arraybuffer 解密）。
 *  空云盘 data.list === ''（字符串而不是数组）。 */
export async function fetchKugouUserCloud(cred, page = 1, pagesize = 30) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', songs: [] }
  const payload = {
    page: Math.max(1, Number(page) || 1),
    pagesize: Math.max(1, Math.min(100, Number(pagesize) || 30)),
    getkmr: 1,
  }
  const device = kugouLiteDeviceCookies(cred)
  // 概念版凭据优先配对概念版 RSA 公钥；不匹配时再用标准版公钥重试（两条通道 p 载荷不同）
  const rsaKeys = [KUGOU_LITE_RSA_PUBLIC_KEY, KUGOU_STANDARD_RSA_PUBLIC_KEY]
  let lastJson = null
  for (const rsaKey of rsaKeys) {
    try {
      const rawKey = crypto.randomBytes(3).toString('hex')
      const encryptedBody = Buffer.from(kugouLiteAes(rawKey, JSON.stringify(payload), false), 'base64')
      const clienttime = Math.floor(Date.now() / 1000)
      const p = crypto.publicEncrypt(
        { key: rsaKey, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(JSON.stringify({ aes: rawKey, uid: Number(cred.userid) || 0, token: String(cred.token || '') }), 'utf8'),
      ).toString('hex').toUpperCase()
      const params = {
        clienttime,
        mid: String(cred.mid || ''),
        key: crypto.createHash('md5').update(`${KUGOU_STANDARD_APPID}${KUGOU_ANDROID_SALT}${KUGOU_STANDARD_CLIENTVER}${clienttime}`).digest('hex'),
        clientver: KUGOU_STANDARD_CLIENTVER,
        appid: KUGOU_STANDARD_APPID,
        p,
      }
      const u = new URL('/v1/get_list', 'https://mcloudservice.kugou.com')
      Object.keys(params).forEach(key => u.searchParams.set(key, String(params[key])))
      const headers = Object.assign(kugouLiteHeaders(device, clienttime), { 'Content-Type': 'application/octet-stream' })
      const buf = await requestBuffer(u.toString(), { method: 'POST', headers }, encryptedBody)
      const text = kugouLiteAes(rawKey, buf.toString('base64'), true)
      const json = JSON.parse(text)
      lastJson = json
      if (json && !json.error && json.data) break
    } catch { /* 换下一把公钥重试 */ }
  }
  if (!lastJson) return { success: false, error: 'KUGOU_CLOUD_FAILED', songs: [] }
  const list = lastJson && lastJson.data && lastJson.data.list
  const rows = Array.isArray(list) ? list : []
  const songs = rows.map(item => {
    const filename = decodeKugouDisplayText(item.filename || item.name || '')
    const sep = filename.indexOf(' - ')
    return {
      hash: String(item.hash || item.file_hash || '').toLowerCase(),
      songName: sep > 0 ? filename.slice(sep + 3) : filename,
      singerName: sep > 0 ? filename.slice(0, sep) : String(item.singername || ''),
      albumId: String(item.album_id || '') || undefined,
      albumAudioId: Number(item.album_audio_id || item.audio_id || item.mixsongid || 0) || undefined,
      fileId: String(item.fileid || item.file_id || '') || undefined,
      duration: Math.round((Number(item.timelen || item.duration || 0) || 0) / 1000) || undefined,
      coverUrl: kugouCoverUrl(item.cover || item.img || ''),
      filesize: Number(item.filesize || item.size || 0) || undefined,
    }
  }).filter(song => song.hash || song.songName)
  return {
    success: true,
    songs,
    empty: !Array.isArray(list) || rows.length === 0,
    total: Number(lastJson && lastJson.data && (lastJson.data.total || lastJson.data.count)) || songs.length,
  }
}

/** 已购单曲（/openapi/copyright/v1/audio/get_goods；无签名路径，参数全走 body） */
export async function fetchKugouPurchasedSongs(cred, page = 1, pagesize = 50) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', goods: [] }
  try {
    const json = await kugouPlainJsonRequest(cred, '/openapi/copyright/v1/audio/get_goods', {
      appid: KUGOU_STANDARD_APPID,
      userid: Number(cred.userid) || 0,
      token: String(cred.token || ''),
      page: Math.max(1, Number(page) || 1),
      pagesize: Math.max(1, Math.min(100, Number(pagesize) || 50)),
      clientver: String(KUGOU_STANDARD_CLIENTVER),
      deleted: 0,
      need_audio_info: 1,
      area_code: '1',
    })
    if (!json || (!json.data && !json.status)) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_PURCHASED_SONGS_FAILED', goods: [] }
    }
    const data = json.data || {}
    return { success: true, goods: Array.isArray(data.goods) ? data.goods : [], total: Number(data.total) || 0 }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PURCHASED_SONGS_FAILED', goods: [] }
  }
}

/** 已购专辑（/openapi/v1/copyright/get_album_goods；无签名路径） */
export async function fetchKugouPurchasedAlbums(cred, page = 1, pagesize = 15) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', goods: [] }
  try {
    const json = await kugouPlainJsonRequest(cred, '/openapi/v1/copyright/get_album_goods', {
      appid: KUGOU_STANDARD_APPID,
      userid: Number(cred.userid) || 0,
      token: String(cred.token || ''),
      page: Math.max(1, Number(page) || 1),
      pagesize: Math.max(1, Math.min(50, Number(pagesize) || 15)),
      clientver: String(KUGOU_STANDARD_CLIENTVER),
      deleted: 0,
    })
    if (!json || (!json.data && !json.status)) {
      return { success: false, error: (json && (json.error || json.msg)) || 'KUGOU_PURCHASED_ALBUMS_FAILED', goods: [] }
    }
    const data = json.data || {}
    return { success: true, goods: Array.isArray(data.goods) ? data.goods : [], total: Number(data.total) || 0 }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_PURCHASED_ALBUMS_FAILED', goods: [] }
  }
}

// ── 3.E 刷歌（youth 竖滑流）──────────────────────────────────────────────────
// 上游实测：本账号 /youth/v3/user/get_dynamic 恒返回 list:[] + is_end:1（无订阅/新账号），
// 因此**卡片元素字段无法实测**。网关只做「取数 + data 原样透传」：
// 不裁剪 list/元素字段、不在这里猜字段名，兼容解析放到客户端 kugouService（多形态结构识别）。
const KUGOU_YOUTH_REPORT_CLIENTVER = '10566'
const KUGOU_YOUTH_REPORT_UA = 'Android13-1070-10566-201-0-ReportPlaySongToServerProtocol-wifi'

/** 刷歌动态流（/youth/v3/user/get_dynamic，无参数；last_cid 只有调用方明确给出时才带，不臆造翻页参数） */
export async function fetchKugouYouthDynamic(cred, options = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', data: null, list: [] }
  const lastCid = options.lastCid == null ? '' : String(options.lastCid)
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/youth/v3/user/get_dynamic',
      method: 'GET',
      params: lastCid ? { last_cid: lastCid } : {},
    })
    const data = json && json.data && typeof json.data === 'object' ? json.data : null
    return {
      success: Number(json?.status) === 1 && Number(json?.error_code || 0) === 0,
      data,
      list: data && Array.isArray(data.list) ? data.list : [],
      isEnd: Boolean(data && data.is_end),
      lastCid: data && data.last_cid != null ? String(data.last_cid) : '',
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_YOUTH_DYNAMIC_FAILED', data: null, list: [] }
  }
}

/** 刷歌最近动态（/youth/v3/user/recent_dynamic，无参数） */
export async function fetchKugouYouthRecent(cred) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED', data: null, list: [] }
  try {
    const json = await kugouLiteRequest({
      cred,
      path: '/youth/v3/user/recent_dynamic',
      method: 'GET',
    })
    const data = json && json.data && typeof json.data === 'object' ? json.data : null
    return {
      success: Number(json?.status) === 1 && Number(json?.error_code || 0) === 0,
      data,
      list: data && Array.isArray(data.list) ? data.list : [],
    }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_YOUTH_RECENT_FAILED', data: null, list: [] }
  }
}

/** 刷歌上报已听（/youth/v2/report/listen_song?clientver=10566，body {mixsongid}）。
 *  UA 换成 ReportPlaySongToServerProtocol 专用串；kugouLiteRequest 不支持改 UA，
 *  故这里按同一套签名/设备头自己发一次（追加实现，不动既有请求器）。 */
export async function reportKugouYouthListen(cred, options = {}) {
  if (!cred || !cred.token || !cred.userid) return { success: false, error: 'KUGOU_AUTH_REQUIRED' }
  const mixsongid = Number(options.mixsongid) || 0
  if (!mixsongid) return { success: false, error: 'MISSING_MIXSONGID' }
  try {
    const device = kugouLiteDeviceCookies(cred)
    const merged = kugouLiteParams(cred, {}, KUGOU_YOUTH_REPORT_CLIENTVER)
    const bodyText = JSON.stringify({ mixsongid })
    merged.signature = kugouLiteSignatureAndroid(merged, bodyText)
    const u = new URL('/youth/v2/report/listen_song', KUGOU_GATEWAY)
    Object.keys(merged).forEach(key => u.searchParams.set(key, String(merged[key])))
    const headers = Object.assign(kugouLiteHeaders(device, merged.clienttime), {
      'Content-Type': 'application/json',
      'User-Agent': KUGOU_YOUTH_REPORT_UA,
    })
    const text = await requestText(u.toString(), { method: 'POST', headers, timeout: 12000 }, bodyText)
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    const success = Number(json?.status) === 1 && Number(json?.error_code || 0) === 0
    return { success, status: Number(json?.status) || 0, data: (json && json.data) || null }
  } catch (error) {
    return { success: false, error: error?.message || 'KUGOU_YOUTH_LISTEN_FAILED' }
  }
}
