/**
 * 酷狗音乐服务（kugou.com 网页 API）
 *
 * 访问方式：酷狗接口不返回 CORS 头，渲染进程无法直连，
 * 全部经 local-server（localhost:3001 /api/kugou/*）代理转发。
 *
 * 分层：
 * - 公开接口（无需登录）：搜索 / 榜单 / 歌单 —— 供搜索与探索页
 * - 登录接口（需 kg_token cookie）：播放 URL / 歌词 / 用户歌单 / 用户信息
 *   未登录时播放自动降级：由上层 resolvePlayableSong 匹配网易云/QQ 同款。
 *
 * 音源约束：酷狗播放接口（wwwapi.kugou.com r=play/getdata）需登录 cookie，
 * 否则返回 err_code 30020。登录由 Electron 弹窗（createKugouLoginWindow）抓 kg_token。
 */

import type { Song, LyricLine } from './musicApi'
import { getPlatformCookie } from './platforms'
import { getApiBase } from './apiConfig'

// 统一走 apiConfig：用户设置远程网关（waveforge:apiBase）后仍打 localhost 会拿不到登录态
const KG_API = `${getApiBase()}/kugou`

// 酷狗请求统一加超时：这些调用原本只带 cache: 'no-store'、没有 AbortSignal，
// 上游挂起时前端会无限转圈（同仓库汽水 10s、Apple 5-6s、B站 12s 都有上限）。
// 取值需大于本地网关最坏耗时（kugou-gateway 三层候选各 12s），故用 30s 兜底而非 10s。
const KG_REQUEST_TIMEOUT_MS = 30_000
const kgFetch = (url: string, init?: RequestInit): Promise<Response> =>
  fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(KG_REQUEST_TIMEOUT_MS), ...init })

// ─────────────────────── 概念版（lite）凭据 ───────────────────────
// 扫码登录走酷狗概念版（与网页登录 token 不通用）：凭据 = { token, userid, dfid, mid, guid, dev, mac, webgl }。
// 有概念版凭据时优先走概念版通道（歌单/喜欢/播放），网页 cookie 作为兜底通道保留。

export interface KugouConceptCredential {
  token: string
  userid: string
  dfid?: string
  mid?: string
  guid?: string
  dev?: string
  mac?: string
  webgl?: string
  nickname?: string
  avatar?: string
}

const KUGOU_CONCEPT_KEY = 'kugou_concept_credential'

export function getKugouConceptCredential(): KugouConceptCredential | null {
  try {
    const raw = localStorage.getItem(KUGOU_CONCEPT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.token || !parsed.userid) return null
    return parsed as KugouConceptCredential
  } catch {
    return null
  }
}

export function saveKugouConceptCredential(credential: KugouConceptCredential): void {
  try {
    localStorage.setItem(KUGOU_CONCEPT_KEY, JSON.stringify(credential))
  } catch { /* 忽略存储失败 */ }
}

export function clearKugouConceptCredential(): void {
  try {
    localStorage.removeItem(KUGOU_CONCEPT_KEY)
  } catch { /* 忽略 */ }
}

/** 概念版通道可用性（扫码登录成功后为 true） */
export function hasKugouConceptCredential(): boolean {
  return Boolean(getKugouConceptCredential())
}

async function kgConceptPost(path: string, body: Record<string, unknown>): Promise<any> {
  const resp = await kgFetch(`${KG_API}/concept/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    let detail: any = null
    try { detail = await resp.json() } catch { /* 忽略 */ }
    const error = new Error(detail?.error || `酷狗概念版接口失败(${resp.status})`) as Error & { status?: number; errorCode?: number }
    error.status = resp.status
    // 上游错误码（如评论频控 60062）随异常透传，供调用方如实提示
    error.errorCode = typeof detail?.errorCode === 'number' ? detail.errorCode : undefined
    throw error
  }
  return resp.json()
}

export interface KugouTrack {
  hash: string
  songName: string
  singerName: string
  /** 歌手 id（歌手详情/相似歌曲跳转用；榜单/搜索/专辑接口提供） */
  singerId?: string
  albumName?: string
  duration?: number
  albumId?: string
  /** 专辑内音频 id（播放直链/歌词匹配用；注意与 mixSongId 不是同一个 id，见 kugouTrackToSong） */
  albumAudioId?: number
  /** mixsongid（评论/相似歌曲/播放直链/上报都只认它） */
  mixSongId?: number
  coverUrl?: string
  /** 320k/flac 音质文件 hash（用于播放 URL） */
  playHash?: string
  /** 歌单内文件 id（概念版取消喜欢/移出歌单用） */
  fileId?: string
}

export interface KugouPlaylist {
  specialid: string
  /** 概念版列表内的 listid（自建/默认歌单，加歌与「我喜欢」定位用） */
  listid?: string
  name: string
  coverUrl?: string
  playcount?: number
  songcount?: number
  /** 当前用户是否拥有该歌单 */
  isMine?: boolean
  /** 列表页内嵌的部分歌曲（hash + filename） */
  songs?: Array<{ hash: string; filename: string }>
}

export interface KugouRank {
  rankid: string
  rankname: string
  img: string
  classify: number
}

export interface KugouUserInfo {
  nickname: string
  user_id: string
  avatar: string
}

/** 解析酷狗封面 URL：CDN 的 {size} 占位替换为纯数字尺寸并升级为 https。
 *  注意：imge.kugou.com/mcommon/{size}/... 的有效尺寸是纯数字（400/200/150 等），
 *  不是 600x600——错误尺寸会返回 404 占位图导致封面全空。 */
export function resolveKugouCover(url: string): string {
  if (!url) return ''
  return url
    .replace(/^http:\/\//i, 'https://')
    .replace(/\{size\}/g, '400')
}

/** 解析酷狗榜单/歌单歌曲的 filename「歌手 - 歌名」 */
function parseKugouFilename(filename: string): { songName: string; singerName: string } {
  const sep = filename.indexOf(' - ')
  if (sep > 0) {
    return { singerName: filename.slice(0, sep).trim(), songName: filename.slice(sep + 3).trim() }
  }
  return { singerName: '', songName: filename.trim() }
}

/** 歌单列表内嵌歌曲（hash + filename）→ KugouTrack 列表（详情接口不可用时的兜底） */
export function parseKugouEmbeddedSongs(embedded: Array<{ hash: string; filename: string }>): KugouTrack[] {
  return embedded
    .map(item => trackFromHash(String(item.hash || ''), String(item.filename || '')))
    .filter((track: KugouTrack | null): track is KugouTrack => Boolean(track && track.songName))
}

function trackFromHash(hash: string, filename: string, extra?: Partial<KugouTrack>): KugouTrack | null {
  if (!hash || !filename) return null
  const { songName, singerName } = parseKugouFilename(filename)
  return { hash, songName, singerName, ...extra }
}

/** 搜索酷狗歌曲（公开接口，经代理） */
export async function searchKugouSongs(keyword: string, limit = 30): Promise<KugouTrack[]> {
  try {
    const resp = await kgFetch(`${KG_API}/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const list = await resp.json()
    if (!Array.isArray(list)) return []
    return list.map((item: any) => trackFromHash(
      String(item.FileHash || item.Hash || ''),
      String(item.SongName || item.filename || ''),
      {
        albumName: item.AlbumName ? String(item.AlbumName) : undefined,
        duration: item.Duration ? Number(item.Duration) : undefined,
        albumId: item.AlbumID ? String(item.AlbumID) : undefined,
        playHash: item.FileHash ? String(item.FileHash) : undefined,
        singerId: String((item.Singers && item.Singers[0] && item.Singers[0].id) || item.SingerId || '') || undefined,
        coverUrl: resolveKugouCover(item.Image || item.AlbumImage || ''),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 搜索失败:', e)
    return []
  }
}

/** 酷狗榜单分类列表 */
export async function fetchKugouRankList(): Promise<KugouRank[]> {
  try {
    const resp = await kgFetch(`${KG_API}/rank/list`, { cache: 'no-store' })
    if (!resp.ok) return []
    const ranks = await resp.json()
    return Array.isArray(ranks) ? ranks : []
  } catch (e) {
    console.warn('[Kugou] 榜单列表获取失败:', e)
    return []
  }
}

/** 新歌速递语种列（官方乐库为「华语/欧美/韩国」三列）。数据源：
 *  mobilecdn /api/v3/rank/newsong 的 type（1 华语 / 2 欧美 / 3 日语 / 4 韩国）——
 *  实测三列前三条与官方客户端截图逐字一致（榜单 74534/31310/31311 是另一套池子，对不上）。 */
export const KUGOU_NEWSONG_LANGUAGES = [
  { key: 'mandarin', label: '华语', subtitle: 'Mandarin', type: '1' },
  { key: 'western', label: '欧美', subtitle: 'Western', type: '2' },
  { key: 'korean', label: '韩国', subtitle: 'Korean', type: '4' },
] as const

export interface KugouNewSongColumn {
  key: string
  label: string
  subtitle: string
  tracks: KugouTrack[]
}

/** 新歌速递（mobilecdn rank/newsong，公开接口无需登录） */
export async function fetchKugouNewSongsByLang(type = '1', limit = 6): Promise<KugouTrack[]> {
  try {
    const resp = await kgFetch(`${KG_API}/rank/newsong?type=${encodeURIComponent(type)}&pagesize=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs.map((item: any) => trackFromHash(
      String(item.hash || ''),
      String(item.filename || ''),
      {
        duration: Number(item.duration) || undefined,
        albumId: item.album_id || undefined,
        albumAudioId: Number(item.album_audio_id) || undefined,
        singerId: String((item.authors && item.authors[0] && item.authors[0].author_id) || '') || undefined,
        coverUrl: resolveKugouCover(item.album_img || ''),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 新歌速递获取失败:', e)
    return []
  }
}

/** 三语种新歌（华语/欧美/韩国），任一语种失败只丢该列 */
export async function fetchKugouNewSongsByLanguage(limit = 6): Promise<KugouNewSongColumn[]> {
  const columns = await Promise.all(KUGOU_NEWSONG_LANGUAGES.map(async lang => ({
    key: lang.key,
    label: lang.label,
    subtitle: lang.subtitle,
    tracks: await fetchKugouNewSongsByLang(lang.type, limit).catch(() => [] as KugouTrack[]),
  })))
  return columns.filter(column => column.tracks.length > 0)
}

export async function fetchKugouRankInfo(rankid = '8888', limit = 30): Promise<KugouTrack[]> {
  try {
    const resp = await kgFetch(`${KG_API}/rank/info?rankid=${rankid}&pagesize=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs.map((item: any) => trackFromHash(
      String(item.hash || ''),
      String(item.filename || ''),
      {
        duration: Number(item.duration) || undefined,
        albumId: item.album_id || undefined,
        singerId: String((item.authors && item.authors[0] && item.authors[0].author_id) || '') || undefined,
        coverUrl: resolveKugouCover(item.album_img || ''),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 榜单歌曲获取失败:', e)
    return []
  }
}

/** 酷狗推荐歌单列表（m.kugou.com/plist/index，真实歌单） */
export async function fetchKugouPlaylists(limit = 24): Promise<KugouPlaylist[]> {
  try {
    const resp = await kgFetch(`${KG_API}/playlist/list?pagesize=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const playlists = await resp.json()
    return Array.isArray(playlists) ? playlists.map((item: any) => ({
      specialid: String(item.specialid || ''),
      name: String(item.name || ''),
      coverUrl: resolveKugouCover(String(item.img || item.icon || '')),
      playcount: Number(item.playcount) || undefined,
      songcount: Number(item.songcount) || undefined,
      songs: Array.isArray(item.songs) ? item.songs : undefined,
    })).filter(item => item.specialid && item.name) : []
  } catch (e) {
    console.warn('[Kugou] 歌单列表获取失败:', e)
    return []
  }
}

/** 酷狗歌单详情（含歌曲列表） */
export async function fetchKugouPlaylistDetail(specialid: string, limit = 50): Promise<KugouTrack[]> {
  try {
    const resp = await kgFetch(`${KG_API}/playlist/detail?specialid=${specialid}&pagesize=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs.map((item: any) => trackFromHash(
      String(item.hash || ''),
      String(item.filename || ''),
      {
        duration: Number(item.duration) || undefined,
        albumId: item.album_id || undefined,
        singerId: String(item.singerid || item.singer_id || '') || undefined,
        coverUrl: resolveKugouCover(item.album_img || ''),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 歌单详情获取失败:', e)
    return []
  }
}

/** 酷狗用户信息（需登录 cookie）：优先走隐藏窗口桥（绕开服务端 WAF），失败回退代理 */
export async function fetchKugouUserInfo(cookie?: string): Promise<KugouUserInfo | null> {
  const kgCookie = cookie || getPlatformCookie('kugou')
  if (!kgCookie) return null
  // VIP 身份落盘（audioQualitySettings.getPlatformVipState('kugou') 读 kugou_vip，
  // 此前无人写入导致酷狗 VIP 音质选项永远不可用）
  const persistVip = (info: unknown) => {
    try {
      const d = (info || {}) as Record<string, unknown>
      const raw = d.vip_level ?? d.is_vip ?? d.vip
      const vip = (typeof raw === 'number' && raw > 0) || raw === true || raw === 1
      localStorage.setItem('kugou_vip', vip ? 'true' : 'false')
    } catch { /* ignore */ }
  }
  // 桥接：真实 Chromium 页面内同源 fetch（www.kugou.com 对服务端 node fetch 有 TLS 指纹风控）
  const bridge = (window as any).electron?.kugouScrape
  if (bridge?.userInfo) {
    try {
      const result = await bridge.userInfo()
      if (result?.success && result.info && (result.info.nickname || result.info.user_id)) {
        persistVip(result.info)
        return result.info
      }
    } catch { /* 桥失败回退代理 */ }
  }
  try {
    const resp = await kgFetch(`${KG_API}/user/info?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const json = await resp.json()
    if (!json || json.error || (!json.nickname && !json.user_id)) return null
    persistVip(json)
    return json
  } catch (e) {
    console.warn('[Kugou] 用户信息获取失败:', e)
    return null
  }
}

/** 酷狗用户歌单（需登录）：概念版凭据优先（扫码登录），网页 cookie 兜底 */
export async function fetchKugouUserPlaylists(cookie?: string): Promise<KugouPlaylist[]> {
  const concept = getKugouConceptCredential()
  if (concept) {
    try {
      const result = await kgConceptPost('playlists', { credential: concept })
      if (result?.success && Array.isArray(result.playlists)) {
        return result.playlists.map((p: any) => ({
          specialid: String(p.id || ''),
          listid: String(p.listid || ''),
          name: String(p.name || ''),
          coverUrl: resolveKugouCover(String(p.coverUrl || '')),
          songcount: Number(p.songcount) || undefined,
          playcount: Number(p.playcount) || undefined,
          isMine: Boolean(p.isMine),
        })).filter((p: KugouPlaylist) => p.specialid && p.name)
      }
    } catch (e) {
      console.warn('[Kugou] 概念版歌单加载失败:', e)
    }
  }
  const kgCookie = cookie || getPlatformCookie('kugou')
  if (!kgCookie) return []
  try {
    const resp = await kgFetch(`${KG_API}/user/playlist?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
    if (resp.ok) {
      const playlists = await resp.json()
      if (Array.isArray(playlists)) {
        return playlists.map((p: any) => ({
          specialid: String(p.specialid || ''),
          name: String(p.name || ''),
          coverUrl: resolveKugouCover(String(p.img || '')),
          songcount: Number(p.songcount) || undefined,
          playcount: Number(p.playcount) || undefined,
          isMine: p.isMine,
        })).filter(p => p.specialid && p.name)
      }
    }
  } catch (e) {
    console.warn('[Kugou] 用户歌单代理失败，尝试桥:', e)
  }
  const bridge = (window as any).electron?.kugouScrape
  if (bridge?.userPlaylists) {
    try {
      const result = await bridge.userPlaylists()
      if (result?.success && Array.isArray(result.playlists)) {
        // 桥抓的是登录用户自己的 getplaylist 页（自建歌单），逐条标 isMine=true：
        // 漏标会让「添加到歌单」候选在桥接回退路径下全空（addablePlaylists 按 isMine 过滤）
        return result.playlists.map((p: { specialid: string; name: string; img?: string; songcount?: number; playcount?: number }) => ({
          specialid: p.specialid,
          name: p.name,
          coverUrl: resolveKugouCover(p.img || ''),
          songcount: p.songcount,
          playcount: p.playcount,
          isMine: true,
        }))
      }
    } catch { /* 桥失败 */ }
  }
  return []
}

/** 酷狗用户歌单曲目（H5 签名网关 /v4/get_list_all_file，需登录 cookie）。
 *  用户自建歌单/「我喜欢」的 id 是网关 listid，不是 m.kugou.com 公开歌单 specialid，
 *  公开歌单详情接口（playlist/detail）对这类 id 拿不到曲目，必须走此接口。
 *  分页合并全量曲目（单页 50 条，20 页封顶，防异常数据死循环）。 */
export async function fetchKugouUserPlaylistTracks(listid: string, page = 1, pagesize = 50): Promise<KugouTrack[]> {
  const concept = getKugouConceptCredential()
  if (concept && listid) {
    // 概念版通道：id 是 global_collection_id（如 collection_3_<uid>_2_0）
    try {
      const out: KugouTrack[] = []
      for (let p = Math.max(1, page); p <= 20; p += 1) {
        const json = await kgConceptPost('playlist/tracks', { credential: concept, id: listid, limit: 300, page: p })
        const rows = Array.isArray(json?.tracks) ? json.tracks : []
        for (const item of rows) {
          const track = trackFromHash(String(item.hash || ''), item.songName && item.singerName ? `${item.singerName} - ${item.songName}` : String(item.songName || ''), {
            duration: Number(item.duration || 0) || undefined,
            albumId: String(item.albumId || '') || undefined,
            albumName: item.albumName ? String(item.albumName) : undefined,
            albumAudioId: Number(item.albumAudioId || 0) || undefined,
            singerName: item.singerName ? String(item.singerName) : undefined,
            // 歌手 id 透传：右键「查看歌手」需要（网关从 singerinfo[0].id 带上）
            singerId: item.singerId ? String(item.singerId) : undefined,
            coverUrl: resolveKugouCover(String(item.coverUrl || '')),
            fileId: item.fileId ? String(item.fileId) : undefined,
          })
          if (track) out.push(track)
        }
        if (rows.length < 300) break
      }
      if (out.length) return out
    } catch (e) {
      console.warn('[Kugou] 概念版曲目获取失败:', e)
    }
  }
  const kgCookie = getPlatformCookie('kugou')
  if (!kgCookie || !listid) return []
  const out: KugouTrack[] = []
  const seen = new Set<string>()
  try {
    for (let p = Math.max(1, page); p <= 20; p += 1) {
      const query = new URLSearchParams({ listid, page: String(p), pagesize: String(pagesize), cookie: kgCookie })
      const resp = await kgFetch(`${KG_API}/user/playlist/tracks?${query.toString()}`, { cache: 'no-store' })
      if (!resp.ok) break
      const json = await resp.json()
      if (!Array.isArray(json.songs)) break
      let added = 0
      for (const item of json.songs) {
        const hash = String(item.hash || item.fileHash || '')
        if (!hash || seen.has(hash)) continue
        seen.add(hash)
        // 服务端网关返回 songName/singerName（已拆分），兼容 filename 形态
        const songName = String(item.songName || item.songname || '')
        const singerName = String(item.singerName || item.singername || '')
        const filename = songName && singerName ? `${singerName} - ${songName}` : (String(item.filename || '') || songName)
        const track = trackFromHash(hash, filename, {
          duration: Number(item.duration || 0) || undefined,
          albumId: String(item.albumId || item.album_id || ''),
          albumAudioId: Number(item.albumAudioId || item.album_audio_id || 0) || undefined,
          coverUrl: resolveKugouCover(String(item.coverUrl || item.album_img || '')),
        })
        if (track) {
          out.push(track)
          added += 1
        }
      }
      if (added < pagesize) break
    }
  } catch (e) {
    console.warn('[Kugou] 用户歌单曲目获取失败:', e)
  }
  return out
}

export interface KugouAlbum {
  albumid: string
  albumname: string
  singername: string
  singerid?: string
  imgurl?: string
  publishtime?: string
  songcount?: number
  intro?: string
}

export interface KugouAlbumDetail {
  album: KugouAlbum
  songs: KugouTrack[]
}

/** 酷狗专辑 → WaveForge Album（专辑详情/歌手专辑列表用） */
export function kugouAlbumToAlbum(album: KugouAlbum) {
  const publishTs = Number(new Date(String(album.publishtime || '').replace(' ', 'T')).getTime())
  return {
    id: Number(parseInt(String(album.albumid).slice(0, 12), 10)) || 0,
    mid: album.albumid,
    name: album.albumname,
    artist: { name: album.singername, id: album.singerid ? Number(album.singerid) || undefined : undefined },
    picUrl: album.imgurl || '',
    publishTime: Number.isFinite(publishTs) ? publishTs : undefined,
    description: album.intro || '',
    size: album.songcount,
    platform: 'kugou' as const,
  }
}

export interface KugouSinger {
  singerid: string
  singername: string
  imgurl?: string
  intro?: string
  songcount?: number
  mvcount?: number
  alias?: string
}

/** 酷狗新专辑列表（mobilecdn /api/v3/album/list，公开目录接口） */
export async function fetchKugouAlbumList(page = 1, pagesize = 24): Promise<KugouAlbum[]> {
  try {
    const resp = await kgFetch(`${KG_API}/album/list?page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.albums)) return []
    return json.albums.map((item: any) => ({
      albumid: String(item.albumid || ''),
      albumname: String(item.albumname || ''),
      singername: String(item.singername || ''),
      singerid: String(item.singerid || '') || undefined,
      imgurl: item.imgurl ? resolveKugouCover(String(item.imgurl)) : undefined,
      publishtime: String(item.publishtime || '') || undefined,
      songcount: Number(item.songcount || 0) || undefined,
    })).filter((a: { albumid?: string; albumname?: string }) => Boolean(a.albumid && a.albumname))
  } catch (e) {
    console.warn('[Kugou] 专辑列表获取失败:', e)
    return []
  }
}

/** 酷狗专辑详情（album/info + album/song） */
export async function fetchKugouAlbumDetail(albumid: string): Promise<KugouAlbumDetail | null> {
  try {
    const resp = await kgFetch(`${KG_API}/album/detail?albumid=${encodeURIComponent(albumid)}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const json = await resp.json()
    const album = json?.album
    if (!album || !Array.isArray(json.songs)) return null
    return {
      album: {
        albumid: String(album.albumid || albumid),
        albumname: String(album.albumname || ''),
        singername: String(album.singername || ''),
        singerid: String(album.singerid || '') || undefined,
        imgurl: album.imgurl ? resolveKugouCover(String(album.imgurl)) : undefined,
        publishtime: String(album.publishtime || '') || undefined,
        songcount: Number(album.songcount || json.songs.length) || undefined,
        intro: String(album.intro || '') || undefined,
      },
      songs: json.songs.map((item: any) => trackFromHash(
        String(item.hash || ''),
        String(item.filename || ''),
        {
          albumId: String(item.album_id || albumid || '') || undefined,
          albumName: album.albumname ? String(album.albumname) : undefined,
          duration: Number(item.duration || 0) || undefined,
          albumAudioId: Number(item.album_audio_id || item.audio_id || 0) || undefined,
          singerId: String(item.singerid || album.singerid || '') || undefined,
          coverUrl: resolveKugouCover(String(item.album_img || album.imgurl || '')),
        },
      )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName)),
    }
  } catch (e) {
    console.warn('[Kugou] 专辑详情获取失败:', e)
    return null
  }
}

/** 酷狗歌手详情（mobilecdn /api/v3/singer/info） */
export async function fetchKugouSingerDetail(singerid: string): Promise<KugouSinger | null> {
  try {
    const resp = await kgFetch(`${KG_API}/singer/detail?singerid=${encodeURIComponent(singerid)}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const s = (await resp.json())?.singer
    if (!s || !s.singername) return null
    return {
      singerid: String(s.singerid || singerid),
      singername: String(s.singername || ''),
      imgurl: s.imgurl ? resolveKugouCover(String(s.imgurl)) : undefined,
      intro: String(s.intro || '') || undefined,
      songcount: Number(s.songcount || 0) || undefined,
      mvcount: Number(s.mvcount || 0) || undefined,
      alias: String(s.alias || '') || undefined,
    }
  } catch (e) {
    console.warn('[Kugou] 歌手详情获取失败:', e)
    return null
  }
}

/** 酷狗歌手热门歌曲（singer/song；封面由服务端经歌手专辑映射补全） */
export async function fetchKugouSingerSongs(singerid: string, page = 1, pagesize = 50): Promise<KugouTrack[]> {
  try {
    const resp = await kgFetch(`${KG_API}/singer/song?singerid=${encodeURIComponent(singerid)}&page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs.map((item: any) => trackFromHash(
      String(item.hash || ''),
      String(item.filename || ''),
      {
        albumId: String(item.album_id || '') || undefined,
        duration: Number(item.duration || 0) || undefined,
        albumAudioId: Number(item.album_audio_id || item.audio_id || 0) || undefined,
        singerId: String(item.singerid || singerid || '') || undefined,
        coverUrl: resolveKugouCover(String(item.album_img || '')),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 歌手歌曲获取失败:', e)
    return []
  }
}

/** 酷狗歌手专辑列表（singer/album） */
export async function fetchKugouSingerAlbums(singerid: string, page = 1, pagesize = 100): Promise<KugouAlbum[]> {
  try {
    const resp = await kgFetch(`${KG_API}/singer/album?singerid=${encodeURIComponent(singerid)}&page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.albums)) return []
    return json.albums.map((item: any) => ({
      albumid: String(item.albumid || ''),
      albumname: String(item.albumname || ''),
      singername: String(item.singername || ''),
      singerid: String(item.singerid || singerid || '') || undefined,
      imgurl: item.imgurl ? resolveKugouCover(String(item.imgurl)) : undefined,
      publishtime: String(item.publishtime || '') || undefined,
      songcount: Number(item.songcount || 0) || undefined,
      intro: String(item.intro || '') || undefined,
    })).filter((a: { albumid?: string; albumname?: string }) => Boolean(a.albumid && a.albumname))
  } catch (e) {
    console.warn('[Kugou] 歌手专辑获取失败:', e)
    return []
  }
}

/** 酷狗播放 URL（四层策略：H5 签名网关 → Mobile 免费直链 → Web；付费歌曲返回 null 由上层匹配播放） */
export async function getKugouSongUrl(hash: string, extra: { albumId?: string; albumAudioId?: number } = {}): Promise<string | null> {
  if (!hash) return null
  const concept = getKugouConceptCredential()
  if (concept) {
    try {
      const json = await kgConceptPost('song/url', {
        credential: concept,
        hash,
        albumId: extra.albumId,
        albumAudioId: extra.albumAudioId,
      })
      if (json?.url) return String(json.url)
    } catch (e) {
      console.warn('[Kugou] 概念版播放地址获取失败:', e)
    }
  }
  try {
    const cookie = getPlatformCookie('kugou')
    const query = new URLSearchParams({ hash })
    if (extra.albumId) query.set('albumId', extra.albumId)
    if (extra.albumAudioId) query.set('album_audio_id', String(extra.albumAudioId))
    if (cookie) query.set('cookie', cookie)
    const resp = await kgFetch(`${KG_API}/song/url?${query.toString()}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const json = await resp.json()
    if (!json?.url) return null
    return json.url
  } catch (e) {
    console.warn('[Kugou] 播放地址获取失败:', e)
    return null
  }
}

/** 酷狗歌词（krcs.kugou.com，规范 LRC） */
export async function getKugouLyrics(hash: string, extra: { albumAudioId?: number; duration?: number } = {}): Promise<LyricLine[]> {
  if (!hash) return []
  try {
    const query = new URLSearchParams({ hash })
    if (extra.albumAudioId) query.set('album_audio_id', String(extra.albumAudioId))
    if (extra.duration) query.set('duration', String(extra.duration))
    const resp = await kgFetch(`${KG_API}/lyric?${query.toString()}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    const lrc = json?.lyric || ''
    if (!lrc || !lrc.includes('[')) return []
    const lines: LyricLine[] = []
    const timeRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
    for (const raw of lrc.split('\n')) {
      const match = raw.match(timeRe)
      const text = raw.replace(timeRe, '').trim()
      if (!match || !text) continue
      for (const m of match) {
        const parts = m.slice(1, -1).split(/[:.]/)
        const min = Number(parts[0] || 0)
        const sec = Number(parts[1] || 0)
        const frac = parts[2] ? Number(parts[2].padEnd(3, '0').slice(0, 3)) : 0
        lines.push({ time: min * 60 + sec + frac / 1000, text })
      }
    }
    return lines.sort((a, b) => a.time - b.time)
  } catch (e) {
    console.warn('[Kugou] 歌词获取失败:', e)
    return []
  }
}

/** 酷狗喜欢歌曲：概念版通道支持喜欢/取消（取消按 fileid 从「我喜欢」移除）；网页通道仅支持喜欢 */
export async function likeKugouSong(song: { hash?: string; mid?: string; name?: string; artists?: Array<{ name: string }>; album?: { id?: string | number }; fileId?: string }, like: boolean): Promise<boolean> {
  const concept = getKugouConceptCredential()
  if (concept) {
    try {
      const hash = String(song.hash || song.mid || '')
      if (!hash) return false
      let fileId = song.fileId
      if (!like && !fileId) {
        // 取消喜欢需要 fileid：查「我喜欢」映射（一次请求拿到全部命中项）
        const liked = await fetchKugouLikedFileIds([hash])
        fileId = liked[hash.toLowerCase()] || liked[hash.toUpperCase()] || ''
      }
      const json = await kgConceptPost('like', {
        credential: concept,
        liked: like,
        song: {
          hash,
          name: song.name || '',
          albumId: song.album?.id ? String(song.album.id) : '',
          artists: song.artists || [],
        },
        fileId: fileId || undefined,
      })
      return Boolean(json?.success)
    } catch (e) {
      console.warn('[Kugou] 概念版喜欢操作失败:', e)
      return false
    }
  }
  // 网页通道没有「取消喜欢」的轻接口：like=false 直接判为不支持（入口在能力表中隐藏）
  if (!like) return false
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return false
  try {
    const resp = await kgFetch(`${KG_API}/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ like, song: { hash: song.hash || song.mid, name: song.name, artists: song.artists }, cookie }),
    })
    if (!resp.ok) return false
    const json = await resp.json()
    return json?.result === 100
  } catch (e) {
    console.warn('[Kugou] 喜欢操作失败:', e)
    return false
  }
}

/** 概念版歌单加歌（listId 为概念版 specialid 时先映射回 listid；找不到则按数字直接使用） */
export async function addKugouSongToPlaylist(listId: string, song: { hash?: string; mid?: string; name?: string; artists?: Array<{ name: string }> }): Promise<boolean> {
  const concept = getKugouConceptCredential()
  if (concept) {
    try {
      const hash = String(song.hash || song.mid || '')
      if (!hash) return false
      let numericListId = String(listId || '').replace(/\D/g, '')
      if (!numericListId || String(listId || '').startsWith('collection_')) {
        const all = await fetchKugouUserPlaylists()
        const hit = all.find(p => p.specialid === listId) || all.find(p => p.isMine && p.listid)
        numericListId = String(hit?.listid || '2')
      }
      const json = await kgConceptPost('like', {
        credential: concept,
        liked: true,
        listid: numericListId,
        song: { hash, name: song.name || '', artists: song.artists || [] },
      })
      return Boolean(json?.success)
    } catch (e) {
      console.warn('[Kugou] 概念版加歌失败:', e)
      return false
    }
  }
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return false
  try {
    const resp = await kgFetch(`${KG_API}/playlist/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'add', pid: listId, song: { hash: song.hash || song.mid, name: song.name, artists: song.artists }, cookie }),
    })
    if (!resp.ok) return false
    const json = await resp.json()
    return json?.result === 100
  } catch (e) {
    console.warn('[Kugou] 加歌失败:', e)
    return false
  }
}

/** 电台（官方「频道」页签的真实内容：14 个分类 × 每类 20~70 个电台，含当前播放曲） */
export interface KugouRadioStation {
  fmid: string
  name: string
  coverUrl: string
  fmtype: number
  currentSong: { hash: string; audioId?: number; albumId?: string; name: string } | null
}
export interface KugouRadioClass { classid: string; name: string; stations: KugouRadioStation[] }

async function kgRadioPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const resp = await kgFetch(`${KG_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    return await resp.json() as T
  } catch (e) {
    console.warn('[Kugou] 电台接口失败:', path, e)
    return null
  }
}

export async function fetchKugouRadioClasses(): Promise<KugouRadioClass[]> {
  const credential = getKugouConceptCredential()
  const json = await kgRadioPost<{ success: boolean; data?: KugouRadioClass[] }>('/concept/radio/classes', { credential })
  return json?.data || []
}

export async function fetchKugouRadioSongs(fmid: string, fmtype = 2, size = 20): Promise<KugouTrack[]> {
  const credential = getKugouConceptCredential()
  const json = await kgRadioPost<{ success: boolean; tracks?: KugouTrack[] }>('/concept/radio/songs', { credential, fmid, fmtype, size })
  return json?.tracks || []
}
/** 频道内容（IP 专区，appid 1058 H5 通道；与官方客户端同源数据，不再依赖小程序嵌入） */
export interface KugouChannelDetail {
  id: string; name: string; type: string; suffix: string; cover: string; intro: string; heat: number; videoTotal: number; audioTotal: number
  /** 官方头部「歌单」页签的计数（情歌 3000 / DJ 3000 / 经典 3006） */
  playlistTotal?: number
}
export interface KugouChannelVideo { id: string; name: string; singer: string; coverUrl: string; duration?: number; publishTime?: string; albumAudioId?: number }
export interface KugouChannelSub { id: string; name: string; type: string; coverUrl: string }

async function kgIpPost<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const resp = await kgFetch(`${KG_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    return await resp.json() as T
  } catch (e) {
    console.warn('[Kugou] 频道接口失败:', path, e)
    return null
  }
}

export async function fetchKugouChannelDetail(ipId: string): Promise<KugouChannelDetail | null> {
  const json = await kgIpPost<{ success: boolean; data?: KugouChannelDetail }>('/concept/channel/detail', { ip_id: ipId })
  return json?.success && json.data ? json.data : null
}

export async function fetchKugouChannelSongs(ipId: string, page = 1, pagesize = 30): Promise<{ tracks: KugouTrack[]; total: number }> {
  const json = await kgIpPost<{ success: boolean; tracks?: KugouTrack[]; total?: number }>('/concept/channel/songs', { ip_id: ipId, page, pagesize })
  return { tracks: json?.tracks || [], total: Number(json?.total || 0) || 0 }
}

export async function fetchKugouChannelPlaylists(ipId: string, page = 1, pagesize = 12): Promise<KugouPlaylist[]> {
  const json = await kgIpPost<{ success: boolean; playlists?: any[] }>('/concept/channel/playlists', { ip_id: ipId, page, pagesize })
  return (json?.playlists || []).map((p: any) => ({
    specialid: String(p.id || ''),
    name: String(p.name || ''),
    coverUrl: String(p.coverUrl || ''),
    songcount: Number(p.songcount) || undefined,
    playcount: Number(p.playcount) || undefined,
    isMine: false,
  })).filter((p: KugouPlaylist) => p.specialid && p.name)
}

export async function fetchKugouChannelVideos(ipId: string, page = 1, pagesize = 6): Promise<{ videos: KugouChannelVideo[]; total: number }> {
  const json = await kgIpPost<{ success: boolean; videos?: KugouChannelVideo[]; total?: number }>('/concept/channel/videos', { ip_id: ipId, page, pagesize })
  return { videos: json?.videos || [], total: Number(json?.total || 0) || 0 }
}

export async function fetchKugouChannelSubChannels(ipId: string): Promise<KugouChannelSub[]> {
  const json = await kgIpPost<{ success: boolean; data?: KugouChannelSub[] }>('/concept/channel/sub', { ip_id: ipId })
  return json?.data || []
}

export async function fetchKugouChannelCollectCount(ipId: string): Promise<number> {
  const credential = getKugouConceptCredential()
  const json = await kgIpPost<{ success: boolean; count?: number }>('/concept/channel/collect-count', { credential, ip_id: ipId })
  return Number(json?.count || 0) || 0
}

/** 频道关注状态（collectlist /v1/get_collect_stat，与 H5 频道页「+关注」同族）：
 *  collectedListId 非空 = 已关注，取消关注时要把它回传；未登录也能读（此时只有总关注数）。 */
export interface KugouChannelCollectState {
  collected: boolean
  collectedListId: string
  collectedCount: number
}

export async function fetchKugouChannelCollectState(ipId: string): Promise<KugouChannelCollectState | null> {
  const credential = getKugouConceptCredential()
  const json = await kgIpPost<{ success: boolean; collected?: boolean; collectedListId?: string; collectedCount?: number }>(
    '/concept/channel/collect-stat',
    { credential, ip_id: ipId },
  )
  if (!json?.success) return null
  return {
    collected: Boolean(json.collected),
    collectedListId: String(json.collectedListId || ''),
    collectedCount: Number(json.collectedCount || 0) || 0,
  }
}

/** 关注频道（collectlist /v2/add_list）；name 必须传频道名，上游按它建关注记录。 */
export async function collectKugouChannel(ipId: string, name: string): Promise<boolean> {
  const credential = getKugouConceptCredential()
  if (!credential) return false
  const json = await kgIpPost<{ success: boolean }>('/concept/channel/collect', { credential, ip_id: ipId, name })
  return Boolean(json?.success)
}

/** 取消关注频道（collectlist /v2/del_list）；listId 来自 fetchKugouChannelCollectState。 */
export async function uncollectKugouChannel(listId: string): Promise<boolean> {
  const credential = getKugouConceptCredential()
  if (!credential || !listId) return false
  const json = await kgIpPost<{ success: boolean }>('/concept/channel/uncollect', { credential, listid: listId })
  return Boolean(json?.success)
}
/** 频道目录（官方"频道"页签的落地列表：48 个 IP 专区，含图标；内容页由酷狗小程序渲染） */
export interface KugouChannelZone { id: string; name: string; icon: string; summary: string; ipId: string; link: string }

export async function fetchKugouChannelZones(): Promise<KugouChannelZone[]> {
  try {
    const resp = await kgFetch(`${KG_API}/concept/channels/zones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!resp.ok) return []
    const json = await resp.json()
    return Array.isArray(json?.data) ? json.data : []
  } catch (e) {
    console.warn('[Kugou] 频道目录获取失败:', e)
    return []
  }
}

/** 酷狗歌单信息（详情页标题/封面/曲目数）。
 *  概念版凭据走 /v3/get_list_info（用户自建歌单也能拿到名字），否则从用户歌单列表里按 id 兜底。 */
export async function fetchKugouPlaylistInfo(playlistId: string): Promise<{ name: string; coverUrl: string; trackCount?: number; creator?: string } | null> {
  if (!playlistId) return null
  const concept = getKugouConceptCredential()
  if (concept) {
    try {
      const json = await kgConceptPost('playlist/info', { credential: concept, id: playlistId })
      if (json?.success && json.name) {
        return {
          name: String(json.name),
          coverUrl: resolveKugouCover(String(json.coverUrl || '')),
          trackCount: Number(json.songcount) || undefined,
          creator: json.creator ? String(json.creator) : undefined,
        }
      }
    } catch (e) {
      console.warn('[Kugou] 概念版歌单信息获取失败:', e)
    }
  }
  try {
    const all = await fetchKugouUserPlaylists()
    const hit = all.find(p => p.specialid === playlistId)
    if (hit) return { name: hit.name, coverUrl: hit.coverUrl || '', trackCount: hit.songcount }
  } catch { /* 忽略 */ }
  return null
}

/** 概念版「我喜欢」hash→fileid 映射（取消喜欢/移出歌单需要 fileid） */
export async function fetchKugouLikedFileIds(hashes: string[]): Promise<Record<string, string>> {
  const concept = getKugouConceptCredential()
  if (!concept || !hashes.length) return {}
  try {
    const json = await kgConceptPost('like/check', { credential: concept, hashes })
    return (json?.liked && typeof json.liked === 'object') ? json.liked : {}
  } catch (e) {
    console.warn('[Kugou] 概念版喜欢检查失败:', e)
    return {}
  }
}

/** 「我喜欢」曲目 hash 全集（喜欢状态缓存用；概念版优先，网页 cookie 兜底） */
export async function fetchKugouLikedHashes(): Promise<string[]> {
  const concept = getKugouConceptCredential()
  if (concept) {
    const all = await fetchKugouUserPlaylists()
    const fav = all.find(p => p.listid === '2') || all.find(p => /我喜欢/.test(p.name)) || all.find(p => p.isMine && p.listid)
    if (!fav) return []
    const tracks = await fetchKugouUserPlaylistTracks(fav.specialid)
    const ids = new Set<string>()
    for (const t of tracks) {
      if (!t.hash) continue
      ids.add(t.hash)
      ids.add(t.hash.toLowerCase())
    }
    return [...ids]
  }
  const kgCookie = getPlatformCookie('kugou') || localStorage.getItem('kugou_cookie') || ''
  if (!kgCookie) return []
  try {
    const listResp = await kgFetch(`${KG_API}/user/playlist?cookie=${encodeURIComponent(kgCookie)}`)
    if (!listResp.ok) return []
    const playlists = await listResp.json()
    if (!Array.isArray(playlists)) return []
    const fav = playlists.find((p: any) => /我喜欢|默认歌单/.test(String(p?.name || ''))) || playlists[0]
    const favListId = String(fav?.specialid || '')
    if (!favListId) return []
    const ids = new Set<string>()
    for (let page = 1; page <= 20; page += 1) {
      const resp = await kgFetch(`${KG_API}/user/playlist/tracks?listid=${encodeURIComponent(favListId)}&page=${page}&pagesize=50&cookie=${encodeURIComponent(kgCookie)}`)
      if (!resp.ok) break
      const json = await resp.json()
      const songs = Array.isArray(json?.songs) ? json.songs : []
      for (const item of songs) {
        const hash = String(item?.hash || '').trim()
        if (!hash) continue
        ids.add(hash)
        ids.add(hash.toLowerCase())
      }
      if (songs.length < 50) break
    }
    return [...ids]
  } catch (e) {
    console.warn('[Kugou] 喜欢歌曲列表获取失败:', e)
    return []
  }
}

/** 概念版：按 hash 从指定歌单移除（fileid 通过歌单曲目映射解析；网页通道不支持移除） */
export async function removeKugouSongFromPlaylist(playlistId: string, hash: string): Promise<boolean> {
  const concept = getKugouConceptCredential()
  if (!concept) throw new Error('酷狗音乐暂不支持从歌单移除歌曲：上游未提供移除歌曲的接口')
  const target = String(hash || '').toLowerCase()
  if (!target) return false
  const tracks = await fetchKugouUserPlaylistTracks(playlistId)
  const hit = tracks.find(t => t.hash.toLowerCase() === target && t.fileId)
  if (!hit?.fileId) throw new Error('未找到该歌曲在歌单内的文件 id，无法移除')
  const all = await fetchKugouUserPlaylists()
  const numericListId = all.find(p => p.specialid === playlistId)?.listid
    || String(playlistId).replace(/\D/g, '')
  // 概念版移除走 like=false 通道（服务端按 listid + fileid 删除）
  const json = await kgConceptPost('like', {
    credential: concept,
    liked: false,
    listid: numericListId || '2',
    fileId: hit.fileId,
  })
  return Boolean(json?.success)
}

// ─────────────────────── 探索页扩展板块（乐库/频道/分类/每日推荐）───────────────────────
// 概念版这些目录接口对「设备凭据」即可返回（无需登录）。未登录时用一份本地持久化的
// 游客设备身份，保证上游风控看到稳定的 guid/mid，避免每次请求换机导致限流。

export interface KugouGuestDevice {
  guid: string
  mid: string
  dev: string
  mac: string
  webgl: string
}

const KUGOU_GUEST_DEVICE_KEY = 'kugou_guest_device'

/** 游客设备身份（首次调用生成并落盘；登录用户直接用概念版凭据的设备字段） */
export function getKugouDeviceCredential(): KugouConceptCredential & Partial<KugouGuestDevice> {
  const concept = getKugouConceptCredential()
  if (concept) return concept
  try {
    const cached = JSON.parse(localStorage.getItem(KUGOU_GUEST_DEVICE_KEY) || 'null')
    if (cached?.guid && cached?.mid) return { token: '', userid: '0', ...cached }
  } catch { /* 忽略损坏缓存 */ }
  const guid = (globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').toUpperCase()
  // 上游只把这几个字段当设备标识（实测任意十进制/大写串均可），无需与网关的 md5 派生规则一致
  const digits = (text: string, length: number) => {
    let h = 2166136261
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    return `${h >>> 0}${text.length}`.padEnd(length, '7').slice(0, length)
  }
  const device: KugouGuestDevice = {
    guid,
    mid: digits(guid, 19),
    dev: digits(guid.slice(0, 8), 10).toUpperCase(),
    mac: Array.from({ length: 6 }, (_, i) => digits(`${guid}${i}`, 2).padStart(2, '0')).join(':').toUpperCase(),
    webgl: digits(`${guid}webgl`, 18),
  }
  try { localStorage.setItem(KUGOU_GUEST_DEVICE_KEY, JSON.stringify(device)) } catch { /* 忽略 */ }
  return { token: '', userid: '0', ...device }
}

/** 概念版歌曲条目（daily / newsong_publish / yueku.song 同构字段）→ KugouTrack */
function conceptSongToTrack(item: any): KugouTrack | null {
  const hash = String(item?.hash || item?.hash_320 || '')
  if (!hash) return null
  const songName = String(item?.songname || item?.ori_audio_name || item?.audio_name || '').trim()
  if (!songName) return null
  const singers: string[] = Array.isArray(item?.authors)
    ? item.authors.map((a: any) => String(a?.author_name || '')).filter(Boolean)
    : Array.isArray(item?.singerinfo)
      ? item.singerinfo.map((s: any) => String(s?.name || '')).filter(Boolean)
      : []
  const authorName = String(item?.author_name || item?.singername || singers.join('、') || '')
  const cover = resolveKugouCover(String(item?.sizable_cover || item?.album_sizable_cover || item?.trans_param?.union_cover || item?.imgurl || ''))
  const durationSec = Number(item?.timelength || 0) > 1000 ? Number(item.timelength) / 1000 : Number(item?.timelength || item?.time_length || item?.duration || 0)
  return {
    hash,
    songName,
    singerName: authorName,
    singerId: String(item?.authors?.[0]?.author_id || item?.singerinfo?.[0]?.id || '') || undefined,
    albumName: String(item?.album_name || '') || undefined,
    albumId: String(item?.album_id || '') || undefined,
    albumAudioId: Number(item?.album_audio_id || item?.audio_id || 0) || undefined,
    duration: durationSec > 0 ? durationSec : undefined,
    coverUrl: cover,
    playHash: String(item?.hash_320 || '') || undefined,
  }
}

export interface KugouDailyRecommendation {
  songs: KugouTrack[]
  /** 推荐批次日期（上游 creation_date，如 20261007）；缺失时为 undefined */
  date?: string
}

/** 每日推荐（/concept/daily，概念版凭据；未登录/失败返回空数组，由调用方展示空态） */
export async function fetchKugouDailyRecommend(): Promise<KugouDailyRecommendation> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('daily', { credential })
    const list = Array.isArray(json?.data?.song_list) ? json.data.song_list : []
    const songs = list.map(conceptSongToTrack).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t))
    return { songs, date: json?.data?.creation_date ? String(json.data.creation_date) : undefined }
  } catch (e) {
    console.warn('[Kugou] 每日推荐获取失败:', e)
    return { songs: [] }
  }
}

export interface KugouChannel {
  id: string
  name: string
  coverUrl?: string
  description?: string
  group?: string
  playCount?: number
  songCount?: number
}

/** 频道列表（/concept/channels）。上游对未订阅账号返回空：调用方按「空态」处理，不视为错误。 */
export async function fetchKugouChannels(page = 1, pagesize = 30): Promise<{ channels: KugouChannel[]; total?: number; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('channels', { credential, page, pagesize })
    const data = json?.data
    const rows = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : Array.isArray(data?.channel_list) ? data.channel_list : []
    const channels = rows.map((item: any) => ({
      id: String(item?.channel_id || item?.id || item?.channelId || ''),
      name: String(item?.channel_name || item?.name || item?.title || ''),
      coverUrl: resolveKugouCover(String(item?.cover || item?.icon || item?.img || item?.image || '')),
      description: String(item?.description || item?.desc || item?.intro || '') || undefined,
      group: String(item?.tag_name || item?.category || item?.group || '') || undefined,
      playCount: Number(item?.play_count || item?.playcount || 0) || undefined,
      songCount: Number(item?.song_count || item?.songcount || 0) || undefined,
    })).filter((c: KugouChannel) => c.id && c.name)
    return { channels, total: Number(data?.total) || channels.length }
  } catch (e) {
    // 频道接口对无订阅账号返回 status!=1（网关 502）：如实返回 error，由 UI 显示空态说明
    return { channels: [], error: e instanceof Error ? e.message : '频道接口不可用' }
  }
}

export interface KugouPlaylistTagGroup {
  id: string
  name: string
  tags: Array<{ id: string; name: string }>
}

/** 歌单分类标签树（/concept/playlist/tags，分组 + 子标签） */
export async function fetchKugouPlaylistTags(): Promise<{ groups: KugouPlaylistTagGroup[]; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('playlist/tags', { credential })
    const rows = Array.isArray(json?.data) ? json.data : []
    const groups = rows.map((group: any) => ({
      id: String(group?.tag_id || group?.id || ''),
      name: String(group?.tag_name || group?.name || ''),
      tags: (Array.isArray(group?.son) ? group.son : Array.isArray(group?.children) ? group.children : Array.isArray(group?.tags) ? group.tags : [])
        .map((tag: any) => ({ id: String(tag?.tag_id || tag?.id || ''), name: String(tag?.tag_name || tag?.name || '') }))
        .filter((tag: { id: string; name: string }) => tag.id && tag.name),
    })).filter((group: KugouPlaylistTagGroup) => group.id && group.name && group.tags.length > 0)
    return { groups }
  } catch (e) {
    return { groups: [], error: e instanceof Error ? e.message : '分类标签不可用' }
  }
}

export interface KugouSingerCard {
  singerid: string
  singername: string
  coverUrl?: string
  fansCount?: number
  heat?: number
}

/** 歌手目录（/concept/singers，按上游分组返回热门歌手） */
export async function fetchKugouSingerList(hotsize = 200): Promise<{ singers: KugouSingerCard[]; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('singers', { credential, hotsize })
    const groups = Array.isArray(json?.data) ? json.data : []
    const seen = new Set<string>()
    const singers: KugouSingerCard[] = []
    for (const group of groups) {
      for (const item of Array.isArray(group?.singer) ? group.singer : []) {
        const singerid = String(item?.singerid || '')
        if (!singerid || seen.has(singerid)) continue
        seen.add(singerid)
        singers.push({
          singerid,
          singername: String(item?.singername || ''),
          coverUrl: resolveKugouCover(String(item?.imgurl || item?.dycover?.first_frame_image || '')),
          fansCount: Number(item?.fanscount || 0) || undefined,
          heat: Number(item?.heat || 0) || undefined,
        })
      }
    }
    return { singers: singers.filter(s => s.singername) }
  } catch (e) {
    return { singers: [], error: e instanceof Error ? e.message : '歌手目录不可用' }
  }
}

export interface KugouTagPlaylist {
  specialid: string
  /** 概念版 global_collection_id（详情接口按此 id 取曲目） */
  globalSpecialId?: string
  name: string
  coverUrl: string
  playCount?: number
  trackCount?: number
  creator?: string
  intro?: string
  tags: string[]
}

function tagPlaylistFromItem(item: any): KugouTagPlaylist {
  const tags = Array.isArray(item?.tags)
    ? item.tags.map((tag: any) => String(tag?.tag_name || tag?.name || '')).filter(Boolean)
    : []
  const abtags = Array.isArray(item?.abtags)
    ? item.abtags.map((tag: any) => String(tag?.name || '')).filter(Boolean)
    : []
  return {
    specialid: String(item?.specialid || ''),
    globalSpecialId: String(item?.global_collection_id || '') || undefined,
    name: String(item?.specialname || item?.name || ''),
    coverUrl: resolveKugouCover(String(item?.imgurl || item?.flexible_cover || '')),
    playCount: Number(item?.play_count || 0) || undefined,
    trackCount: Number(item?.songcount || item?.percount || 0) || undefined,
    creator: String(item?.nickname || item?.singername || item?.user_name || '') || undefined,
    intro: String(item?.intro || '') || undefined,
    tags: [...new Set([...tags, ...abtags])],
  }
}

/** 分类歌单（/concept/playlist/by-tag）。上游不支持 tag 过滤，返回的是推荐池，
 *  调用方按 item.tags 做客户端筛选；hasNext 供「加载更多」翻页。 */
export async function fetchKugouPlaylistsByTag(
  categoryId = 0,
  page = 1,
  pagesize = 100,
): Promise<{ playlists: KugouTagPlaylist[]; hasNext: boolean; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('playlist/by-tag', { credential, category_id: categoryId, page, pagesize })
    const rows = Array.isArray(json?.data) ? json.data : []
    const playlists = rows.map(tagPlaylistFromItem).filter((p: KugouTagPlaylist) => p.specialid && p.name)
    return { playlists, hasNext: Boolean(json?.hasNext) }
  } catch (e) {
    return { playlists: [], hasNext: false, error: e instanceof Error ? e.message : '分类歌单不可用' }
  }
}

export interface KugouYueku {
  /** 乐库头条新歌（上游 info.song[0]） */
  headline?: KugouTrack
  newAlbums: KugouAlbum[]
  ranks: Array<{ rankid: string; rankname: string; coverUrl: string; playCount?: number }>
  /** 推荐歌单（官方乐库"推荐歌单"位，带播放量；id 为公开 specialid，可走公开详情） */
  recommendPlaylists: KugouTagPlaylist[]
}

/** 乐库首页（/concept/yueku）：乐库板块的新歌/专辑/榜单/推荐歌单/专区一次取回 */
export async function fetchKugouYueku(): Promise<{ yueku: KugouYueku | null; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('yueku', { credential })
    const info = json?.data?.info
    if (!info) return { yueku: null, error: '乐库数据为空' }
    const headline = Array.isArray(info.song) ? conceptSongToTrack(info.song[0]) : null
    const newAlbums: KugouAlbum[] = (Array.isArray(info.album) ? info.album : []).map((item: any) => ({
      albumid: String(item?.albumid || ''),
      albumname: String(item?.albumname || ''),
      singername: String(item?.singername || ''),
      singerid: String(item?.singerid || '') || undefined,
      imgurl: resolveKugouCover(String(item?.imgurl || '')),
      publishtime: String(item?.publishtime || '') || undefined,
      intro: String(item?.intro || '') || undefined,
    })).filter((album: KugouAlbum) => album.albumid && album.albumname)
    const ranks = (Array.isArray(info.rank) ? info.rank : []).map((item: any) => ({
      rankid: String(item?.rankid || ''),
      rankname: String(item?.rankname || ''),
      coverUrl: resolveKugouCover(String(item?.img_9 || item?.album_img_9 || item?.banner_9 || item?.imgurl || '')),
      playCount: Number(item?.play_times || 0) || undefined,
    })).filter((rank: { rankid: string; rankname: string }) => rank.rankid && rank.rankname)
    const recommendPlaylists = (Array.isArray(info.recommend) ? info.recommend : []).map((item: any) => {
      const extra = item?.extra || {}
      return tagPlaylistFromItem({
        ...extra,
        specialid: extra.specialid || item?.id,
        specialname: extra.specialname || item?.title,
        imgurl: item?.imgurl || extra.imgurl,
        songcount: extra.songcount,
        user_name: extra.user_name,
      })
    }).filter((playlist: KugouTagPlaylist) => playlist.specialid && playlist.name)
    return { yueku: { headline: headline || undefined, newAlbums, ranks, recommendPlaylists } }
  } catch (e) {
    return { yueku: null, error: e instanceof Error ? e.message : '乐库数据不可用' }
  }
}

export interface KugouNewSong {
  track: KugouTrack
  publishDate?: string
  albumName?: string
}

/** 新歌速递（/concept/newsongs）：官方乐库「新歌速递」同源，带作者头像与发布时间 */
export async function fetchKugouNewSongs(rankId = 21608, page = 1, pagesize = 60): Promise<{ songs: KugouNewSong[]; total?: number; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('newsongs', { credential, rank_id: rankId, page, pagesize })
    const rows = Array.isArray(json?.data) ? json.data : []
    const songs: KugouNewSong[] = []
    for (const item of rows) {
      const track = conceptSongToTrack(item)
      if (!track) continue
      songs.push({
        track,
        publishDate: item?.publish_date ? String(item.publish_date) : undefined,
        albumName: item?.album_name ? String(item.album_name) : undefined,
      })
    }
    return { songs, total: Number(json?.total) || songs.length }
  } catch (e) {
    return { songs: [], error: e instanceof Error ? e.message : '新歌速递不可用' }
  }
}

// ─────────────────────── 听书（概念版 longaudio 通道）───────────────────────
// 字段来自 2026-10-07 实测：
// - daily  → data.{ albums[], is_end }（专辑封面 sizable_cover 带 {size} 占位）
// - album  → data 是数组，且 cover 只是文件名，封面必须用 sizable_cover
// - audios → data 是数组；上游把 total 放在响应体顶层，网关只透传 data，
//            故翻页用「本页是否满页」判定（拿不到精确总数时不要伪造总数）
// 三个响应实测都没有「完结」类字段：卡片角标只在字段真实存在时渲染，绝不凭空置位。

export interface KugouLongaudioAlbum {
  albumId: string
  name: string
  author: string
  /** 多主播时逐个列出（daily 只有合并串，详情里才有 authors[]） */
  authors: string[]
  coverUrl: string
  intro: string
  playCount?: number
  /** 章节总数（daily 的 audio_total；详情接口不返回） */
  chapterCount?: number
  /** is_pay=1：上游按需付费/听书 VIP 专辑（角标「听书VIP」的唯一可用信号） */
  isPaid: boolean
  /** 上游若返回完结标记才会置位（实测 daily/album/audios 均无） */
  finished?: boolean
  /** 主分类标签（tag_info.tag_name，分类胶囊按它聚合） */
  primaryTag?: string
  /** album_tag / tag_info 展开后的标签集合 */
  tags: string[]
  /** album_label.label_name（豪门/逆袭 等内容标签） */
  label?: string
  publishDate?: string
  recommendReason?: string
}

export interface KugouLongaudioAlbumDetail {
  albumId: string
  name: string
  author: string
  authors: string[]
  coverUrl: string
  intro: string
  playCount?: number
  tags: string[]
  category?: string
  language?: string
  publishCompany?: string
  isPublished: boolean
  isPaid: boolean
}

export interface KugouLongaudioChapter {
  hash: string
  audioId?: number
  albumAudioId?: number
  name: string
  /** 秒（上游 timelength 是毫秒） */
  duration?: number
  sort: number
  disc: number
  /** 章节级付费/权限标记（实测均为 0；非 0 时 UI 标注「VIP」并在解析失败时如实提示） */
  payType: number
  privilege: number
  coverUrl?: string
}

const longaudioCover = (item: any): string => resolveKugouCover(String(
  item?.sizable_cover || item?.sizable_cover_h5 || item?.trans_param?.union_cover || item?.cover || '',
))

function longaudioAlbumFromDaily(item: any): KugouLongaudioAlbum | null {
  const albumId = String(item?.album_id || '')
  const name = String(item?.album_name || '').trim()
  if (!albumId || !name) return null
  const tagName = String(item?.tag_info?.tag_name || '').trim()
  const label = String(item?.album_label?.label_name || '').trim()
  return {
    albumId,
    name,
    author: String(item?.author_name || ''),
    authors: String(item?.author_name || '').split('、').map(a => a.trim()).filter(Boolean),
    coverUrl: longaudioCover(item),
    intro: String(item?.intro || ''),
    playCount: Number(item?.play_count || 0) || undefined,
    chapterCount: Number(item?.audio_total || 0) || undefined,
    isPaid: Number(item?.is_pay || 0) === 1,
    // 实测：daily 响应没有完结字段（is_finish/album_status 均未返回）
    finished: item?.is_finish === true || item?.is_finish === 1 ? true : undefined,
    primaryTag: tagName || undefined,
    tags: [tagName, label].filter(Boolean),
    label: label || undefined,
    publishDate: String(item?.publish_date || '') || undefined,
    recommendReason: String(item?.recommend_reason || item?.rank_tag_desc || '') || undefined,
  }
}

/** 听书每日推荐（/concept/longaudio/daily）。is_end 由上游给出，用于翻页。 */
export async function fetchKugouLongaudioDaily(page = 1, pagesize = 24): Promise<{ albums: KugouLongaudioAlbum[]; hasMore: boolean; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('longaudio/daily', { credential, page, pagesize })
    const rows = Array.isArray(json?.data?.albums) ? json.data.albums : []
    const albums = rows.map(longaudioAlbumFromDaily).filter((album: KugouLongaudioAlbum | null): album is KugouLongaudioAlbum => Boolean(album))
    return { albums, hasMore: rows.length > 0 && !json?.data?.is_end }
  } catch (e) {
    return { albums: [], hasMore: false, error: e instanceof Error ? e.message : '听书推荐不可用' }
  }
}

/** 听书专辑详情（/concept/longaudio/album，data 是数组） */
export async function fetchKugouLongaudioAlbumDetail(albumId: string): Promise<{ album: KugouLongaudioAlbumDetail | null; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('longaudio/album', { credential, ids: [albumId] })
    const row = Array.isArray(json?.data) ? json.data[0] : (json?.data?.album || null)
    if (!row) return { album: null, error: '上游没有返回该专辑' }
    const tags: string[] = (Array.isArray(row.album_tag) ? row.album_tag : [])
      .map((tag: any) => String(tag?.tag_name || '').trim()).filter((tag: string) => Boolean(tag))
    const authors: string[] = (Array.isArray(row.authors) ? row.authors : [])
      .map((author: any) => String(author?.author_name || '').trim()).filter((author: string) => Boolean(author))
    return {
      album: {
        albumId: String(row.album_id || albumId),
        name: String(row.album_name || ''),
        author: String(row.author_name || authors.join('、')),
        authors,
        coverUrl: longaudioCover(row),
        // 长简介优先：mix_intro/full_intro 更完整，intro 作为兜底
        intro: String(row.full_intro || row.mix_intro || row.intro || ''),
        playCount: Number(row.play_times || 0) || undefined,
        tags: [...new Set(tags)],
        category: String(row.category || '') || undefined,
        language: String(row.language || '') || undefined,
        publishCompany: String(row.publish_company || '') || undefined,
        isPublished: String(row.is_publish || '1') === '1',
        // 实测 /openapi/v2/broadcast 的 trans_param 只有 special_tag，没有 is_pay：
        // 详情页的 VIP 角标以列表项（daily 的 is_pay）为准，这里恒 false 只作类型占位
        isPaid: Number(row.trans_param?.is_pay || 0) === 1,
      },
    }
  } catch (e) {
    return { album: null, error: e instanceof Error ? e.message : '听书专辑详情不可用' }
  }
}

/** 听书章节列表（/concept/longaudio/audios，分页）。total 在响应体顶层、网关未透传，
 *  所以 hasMore 只能按「本页满页」推断，避免伪造总数。 */
export async function fetchKugouLongaudioChapters(albumId: string, page = 1, pagesize = 30): Promise<{ chapters: KugouLongaudioChapter[]; hasMore: boolean; error?: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('longaudio/audios', { credential, album_id: albumId, page, pagesize })
    const rows = Array.isArray(json?.data) ? json.data : []
    const chapters = rows.map((item: any): KugouLongaudioChapter | null => {
      const hash = String(item?.hash || item?.hash_128 || '')
      const name = String(item?.audio_name || '').trim()
      if (!hash || !name) return null
      const milliseconds = Number(item?.timelength || 0)
      return {
        hash,
        audioId: Number(item?.audio_id || 0) || undefined,
        albumAudioId: Number(item?.album_audio_id || 0) || undefined,
        name,
        duration: milliseconds > 0 ? Math.round(milliseconds / 1000) : undefined,
        sort: Number(item?.sort || 0) || 0,
        disc: Number(item?.disc || 1) || 1,
        payType: Number(item?.pay_type || 0) || 0,
        privilege: Number(item?.privilege || 0) || 0,
        coverUrl: longaudioCover(item) || undefined,
      }
    }).filter((chapter: KugouLongaudioChapter | null): chapter is KugouLongaudioChapter => Boolean(chapter))
    return { chapters, hasMore: chapters.length >= pagesize }
  } catch (e) {
    return { chapters: [], hasMore: false, error: e instanceof Error ? e.message : '听书章节不可用' }
  }
}

/** 听书章节直链（概念版 /v5/url，与歌曲同通道；失败时带上游原因供 UI 如实提示） */
export async function getKugouLongaudioUrl(
  hash: string,
  extra: { albumId?: string; albumAudioId?: number } = {},
): Promise<{ url: string | null; error?: string }> {
  if (!hash) return { url: null, error: '缺少章节 hash' }
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('longaudio/url', {
      credential,
      hash,
      albumId: extra.albumId,
      albumAudioId: extra.albumAudioId,
    })
    if (json?.url) return { url: String(json.url) }
    return { url: null, error: '上游没有返回可播放地址' }
  } catch (e) {
    return { url: null, error: e instanceof Error ? e.message : '听书播放地址获取失败' }
  }
}

/** 判断酷狗 Cookie 是否为有效登录态（KuGoo 网页会话 或 kg_token 客户端令牌） */
export function isKugouCookieValid(cookie: string): boolean {
  return Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
}

/** 是否已登录酷狗（概念版扫码凭据 或 网页 KuGoo/kg_token 凭据） */
export function isKugouLoggedIn(): boolean {
  return hasKugouConceptCredential() || isKugouCookieValid(getPlatformCookie('kugou'))
}

/** 酷狗歌曲 → WaveForge Song（id 用 hash 前 12 位转数字，避免 32 位 hex 溢出；mid 保留完整 hash） */
export function kugouTrackToSong(track: KugouTrack): Song {
  const hashStr = track.hash || ''
  const artistId = track.singerId ? Number(parseInt(String(track.singerId).slice(0, 12), 10)) || undefined : undefined
  return {
    id: Number(parseInt(hashStr.slice(0, 12), 16)) || 0,
    mid: hashStr,
    name: track.songName,
    artists: [{ name: track.singerName, id: artistId }],
    album: {
      // albumid 为十进制数字串，按 10 进制转数字（hash 才是 16 进制）
      id: track.albumId ? Number(parseInt(String(track.albumId).slice(0, 12), 10)) || undefined : undefined,
      mid: track.albumId || undefined,
      name: track.albumName || '',
      picUrl: track.coverUrl || '',
    },
    duration: (track.duration || 0) * 1000,
    platform: 'kugou' as const,
    // 评论/相似歌曲/播放直链/「最近播放」上报都只认 mixsongid（= 上游的 album_audio_id）。
    // 歌单条目里的 audio_id 是另一个 id：实测拿它调 cmtlist 报 60100、调 /v5/url 不回播放地址
    // （「酷狗未返回播放地址」的一类根因），所以优先取 mixSongId，缺了才退回 albumAudioId。
    kugouMixSongId: Number(track.mixSongId || track.albumAudioId || 0) || undefined,
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}

// ─────────────── 3.C：最近播放 / 播放上报 / 评论 / 歌单写操作 / 云盘 / 已购 ───────────────
// 全部走概念版通道（与扫码登录的凭据同源），路由见 local-server 的 /api/kugou/concept/*。

export interface KugouPlayRecord {
  /** mxid = album_audio_id/mixsongid（播放上报的必需字段） */
  mxid: number
  /** 播放时间（秒） */
  ot: number
  /** 播放次数 */
  pc: number
  track: KugouTrack
}

/** 上游条目 → KugouPlayRecord（纯函数，便于单测）。
 *  两种形状都要吃：原始上游是 `{ mxid, ot, pc, info: { hash, name, ... } }`，
 *  而本地网关 /concept/history 已把 info 拍平成顶层字段（hash/songName/...）——
 *  只认 info 会让「最近播放」页永远空白（实测该页面空态就是漏了拍平形状）。 */
export function mapKugouPlayRecord(item: any): KugouPlayRecord | null {
  if (!item) return null
  const info = item?.info || {}
  const hash = String(info.hash || item.hash || '').toLowerCase()
  const songName = String(info.name || item.songName || '').trim()
  if (!hash || !songName) return null
  const mxid = Number(item?.mxid || info.mixsongid || info.album_audio_id || item?.albumAudioId || 0) || 0
  const singerinfo = Array.isArray(info.singerinfo) ? info.singerinfo : []
  return {
    mxid,
    ot: Number(item?.ot || 0) || 0,
    pc: Number(item?.pc || 0) || 0,
    track: {
      hash,
      songName,
      singerName: String(info.singername || item.singerName || singerinfo.map((s: any) => s?.name).filter(Boolean).join('、') || ''),
      singerId: String(singerinfo[0]?.id || item.singerId || '') || undefined,
      albumId: String(info.album_id || item.albumId || '') || undefined,
      albumName: String(info.album_name || info.albumname || item.albumName || '') || undefined,
      albumAudioId: mxid || Number(info.mixsongid || info.audio_id || item.albumAudioId || 0) || undefined,
      duration: Math.round((Number(info.timelen || 0) || 0) / 1000) || Number(item.duration) || undefined,
      coverUrl: resolveKugouCover(String(info.trans_param?.union_cover || info.cover || item.coverUrl || '')),
    },
  }
}

/** 最近播放（真正的 /playhistory/v1/get_songs）。bp 传上一页返回的 bp 即翻页。 */
export async function fetchKugouPlayRecords(bp?: string): Promise<{ records: KugouPlayRecord[]; hasMore: boolean; bp: string }> {
  const credential = getKugouDeviceCredential()
  try {
    const json = await kgConceptPost('history', { credential, bp: bp || undefined })
    const rows = Array.isArray(json?.songs) ? json.songs : []
    const records = rows.map(mapKugouPlayRecord).filter((record: KugouPlayRecord | null): record is KugouPlayRecord => Boolean(record))
    return { records, hasMore: Boolean(json?.hasMore), bp: String(json?.bp || '') }
  } catch (e) {
    console.warn('[Kugou] 最近播放获取失败:', e)
    return { records: [], hasMore: false, bp: '' }
  }
}

/** 播放上报（mxid 优先取 Song.kugouMixSongId；缺失时服务端按 hash 反查）。
 *  失败静默：上报是旁路能力，不应影响播放。 */
export async function uploadKugouPlayRecord(song: {
  mid?: string
  hash?: string
  kugouMixSongId?: number
  albumAudioId?: number
}): Promise<boolean> {
  const credential = getKugouConceptCredential()
  if (!credential) return false
  const hash = String(song.mid || song.hash || '').trim()
  const mxid = Number(song.kugouMixSongId || song.albumAudioId || 0) || 0
  if (!mxid && !hash) return false
  try {
    const json = await kgConceptPost('playrecord/upload', {
      credential,
      mxid: mxid || undefined,
      hash: hash || undefined,
      ot: Math.floor(Date.now() / 1000),
    })
    return Boolean(json?.success)
  } catch (e) {
    console.warn('[Kugou] 播放上报失败（静默）:', e)
    return false
  }
}

export interface KugouComment {
  id: string
  content: string
  /** 发表时间（秒） */
  addtime: number
  userName: string
  userPic: string
  userId?: string
  likeCount: number
  hasLiked: boolean
  replyCount: number
  /** 楼层评论的 childrenid（hot_replylist 必传） */
  specialChildId: string
  /** 图片评论（列表接口 need_show_image=1 时返回 images[0].url） */
  picUrl?: string
  /** IP 属地（web 最新评论列表下发，如「江苏」） */
  location?: string
}

/** 酷狗评论时间统一成秒：实测 addtime 是 "2026-01-10 00:50:09" 本地时间串（另兼容数字时间戳） */
export function parseKugouCommentAddtime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // 13 位按毫秒、10 位按秒，统一输出秒
    return Math.max(0, Math.floor(value > 1e12 ? value / 1000 : value))
  }
  const text = String(value || '').trim()
  if (!text) return 0
  if (/^\d+$/.test(text)) return parseKugouCommentAddtime(Number(text))
  const parsed = new Date(text.replace(' ', 'T')).getTime()
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed / 1000)) : 0
}

/** 上游评论条目 → KugouComment（纯函数；字段名按实测响应，另兼容几个常见别名） */
export function mapKugouCommentItem(raw: any): KugouComment | null {
  const id = String(raw?.id ?? raw?.comment_id ?? '').trim()
  const content = String(raw?.content ?? '').trim()
  // 无正文的条目渲染为空行（评论列表只展示可读内容）
  if (!content) return null
  const like = raw?.like || {}
  // images：cmtlist（need_show_image=1）为对象数组 [{url,...}]；web 最新列表给字符串（空串=无图）
  const firstImage = Array.isArray(raw?.images) ? raw.images[0] : null
  const picUrl = String(firstImage?.url || (typeof raw?.images === 'string' ? raw.images : '') || '').trim()
  return {
    id,
    content,
    addtime: parseKugouCommentAddtime(raw?.addtime ?? raw?.add_time ?? 0),
    userName: String(raw?.user_name || raw?.nickname || '酷狗用户'),
    userPic: String(raw?.user_pic || raw?.user_avatar || ''),
    userId: String(raw?.user_id || raw?.userid || '') || undefined,
    likeCount: Number(like.count ?? like.likenum ?? raw?.like_count ?? 0) || 0,
    hasLiked: Boolean(like.haslike ?? raw?.haslike),
    replyCount: Number(raw?.reply_num ?? raw?.reply_count ?? 0) || 0,
    // 注意：只认 special_child_id；special_id 是歌曲级字段（实测 2364），传错会给上游 60102
    specialChildId: String(raw?.special_child_id || '').trim(),
    picUrl: picUrl || undefined,
    location: String(raw?.location || '').trim() || undefined,
  }
}

/** 热词 chip（cmtlist 的 hot_word_list[].content + count，实测无 keyword/name 字段） */
export interface KugouHotWord {
  word: string
  count: number
}

/** 分类标签 chip（cmtlist 的 classify_list[]：客户端第一排「歌曲相关 / 有图 / …」，点选走 comment/classify） */
export interface KugouCommentClassify {
  id: string
  name: string
  count: number
}

/** 歌曲评论列表（推荐序，按 mixsongid 分页；总数/最大页/歌曲级 specialId/热词/分类来自上游） */
export async function fetchKugouComments(
  mixSongId: number,
  page = 1,
  pagesize = 30,
): Promise<{ comments: KugouComment[]; total: number; maxPage: number; hotWords: KugouHotWord[]; classify: KugouCommentClassify[]; childrenId: string; error?: string }> {
  const credential = getKugouDeviceCredential()
  const mixsongid = Number(mixSongId) || 0
  if (!mixsongid) return { comments: [], total: 0, maxPage: 0, hotWords: [], classify: [], childrenId: '', error: '缺少歌曲 mixsongid（该曲目信息不完整）' }
  try {
    const json = await kgConceptPost('comment/list', { credential, mixsongid, page, pagesize })
    const data = json?.data || {}
    const rows = Array.isArray(data.list) ? data.list : []
    const comments = rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c))
    const hotWords = (Array.isArray(data.hot_word_list) ? data.hot_word_list : [])
      .map((item: any) => ({ word: String(item?.content ?? item?.keyword ?? item?.name ?? '').trim(), count: Number(item?.count) || 0 }))
      .filter((item: KugouHotWord) => item.word)
    const classify = (Array.isArray(data.classify) ? data.classify : [])
      .map((item: any) => ({
        id: String(item?.id ?? ''),
        name: String(item?.name ?? '').trim(),
        count: Number(item?.count) || 0,
      }))
      .filter((item: KugouCommentClassify) => item.id && item.name)
    return {
      comments,
      total: Number(data.count) || 0,
      maxPage: Number(data.maxPage) || 0,
      hotWords,
      classify,
      childrenId: String(data.childrenid || ''),
    }
  } catch (e) {
    return { comments: [], total: 0, maxPage: 0, hotWords: [], classify: [], childrenId: '', error: e instanceof Error ? e.message : '评论加载失败' }
  }
}

/** 分类评论（客户端第一排标签点选走后端 cmt_classify_list；type_id 来自 fetchKugouComments 的 classify[].id） */
export async function fetchKugouClassifyComments(
  mixSongId: number,
  typeId: string | number,
  page = 1,
  pagesize = 30,
  sort?: number,
): Promise<{ comments: KugouComment[]; total: number; maxPage: number; error?: string }> {
  const credential = getKugouDeviceCredential()
  const mixsongid = Number(mixSongId) || 0
  if (!mixsongid || !typeId) return { comments: [], total: 0, maxPage: 0, error: '缺少歌曲 mixsongid 或分类 id' }
  try {
    const json = await kgConceptPost('comment/classify', { credential, mixsongid, type_id: typeId, page, pagesize, sort })
    const data = json?.data || {}
    const rows = Array.isArray(data.list) ? data.list : []
    const comments = rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c))
    return { comments, total: Number(data.count) || 0, maxPage: Number(data.maxPage) || 0 }
  } catch (e) {
    return { comments: [], total: 0, maxPage: 0, error: e instanceof Error ? e.message : '分类评论加载失败' }
  }
}

/** 相似歌曲（官方客户端「相似歌曲」弹窗同源：标准版 /v3/album_audio/related）。
 *  入参必须是 mixsongid（= album_audio_id）：hash 与 audio_id 都不认（实测回空列表）。 */
export async function fetchKugouSimilarSongs(
  song: { kugouMixSongId?: number; albumAudioId?: number; mixSongId?: number },
  options: { page?: number; pagesize?: number; sort?: 'all' | 'hot' | 'new' | number } = {},
): Promise<KugouTrack[]> {
  const albumAudioId = Number(song?.kugouMixSongId || song?.albumAudioId || song?.mixSongId || 0) || 0
  if (!albumAudioId) return []
  try {
    const credential = getKugouDeviceCredential()
    const json = await kgConceptPost('similar', {
      credential,
      album_audio_id: albumAudioId,
      page: options.page || 1,
      pagesize: options.pagesize || 30,
      sort: options.sort ?? 'all',
    })
    return (Array.isArray(json?.songs) ? json.songs : []).map((item: any) => ({
      hash: String(item?.hash || '').toLowerCase(),
      songName: String(item?.songName || ''),
      singerName: String(item?.singerName || ''),
      singerId: item?.singerId ? String(item.singerId) : undefined,
      albumId: item?.albumId ? String(item.albumId) : undefined,
      albumName: String(item?.albumName || ''),
      albumAudioId: Number(item?.albumAudioId) || undefined,
      duration: Number(item?.duration) || undefined,
      coverUrl: resolveKugouCover(String(item?.coverUrl || '')),
    })).filter((track: KugouTrack) => track.hash && track.songName)
  } catch (e) {
    console.warn('[Kugou] 相似歌曲获取失败:', e)
    return []
  }
}

/** 酷狗歌曲详情（官方「歌曲详情」弹窗同源：词曲/专辑/发行时间/语种/风格）。
 *  入参与相似歌曲一致：mixsongid（Song.kugouMixSongId），hash 不认。 */
export interface KugouSongDetail {
  songName: string
  singerName: string
  singers: Array<{ id: string; name: string; avatar: string; country: string; birthday: string }>
  album: { id: string; name: string; publishDate: string; coverUrl: string }
  publishDate: string
  language: string
  genres: string[]
  duration?: number
  hash?: string
  qualities?: { standard: boolean; hq: boolean; sq: boolean; hires: boolean }
}

export async function fetchKugouSongDetail(
  song: { kugouMixSongId?: number; albumAudioId?: number; mixSongId?: number },
): Promise<KugouSongDetail | null> {
  const albumAudioId = Number(song?.kugouMixSongId || song?.albumAudioId || song?.mixSongId || 0) || 0
  if (!albumAudioId) return null
  try {
    const credential = getKugouDeviceCredential()
    const json = await kgConceptPost('song/detail', { credential, album_audio_id: albumAudioId })
    const data = json?.data
    if (!data || !data.songName) return null
    return {
      songName: String(data.songName || ''),
      singerName: String(data.singerName || ''),
      singers: Array.isArray(data.singers) ? data.singers.map((s: any) => ({
        id: String(s?.id || ''),
        name: String(s?.name || ''),
        avatar: resolveKugouCover(String(s?.avatar || '')),
        country: String(s?.country || ''),
        birthday: String(s?.birthday || ''),
      })).filter((s: { name: string }) => s.name) : [],
      album: {
        id: String(data.album?.id || ''),
        name: String(data.album?.name || ''),
        publishDate: String(data.album?.publishDate || ''),
        coverUrl: resolveKugouCover(String(data.album?.coverUrl || '')),
      },
      publishDate: String(data.publishDate || ''),
      language: String(data.language || ''),
      genres: Array.isArray(data.genres) ? data.genres.map(String).filter(Boolean) : [],
      duration: Number(data.duration) || undefined,
      hash: data.hash ? String(data.hash) : undefined,
      qualities: data.qualities,
    }
  } catch (e) {
    console.warn('[Kugou] 歌曲详情获取失败:', e)
    return null
  }
}

/** 评论数（web 签名裸 map；未登录设备凭据也可用） */
export async function fetchKugouCommentCount(hash: string): Promise<number> {
  if (!hash) return 0
  try {
    const credential = getKugouDeviceCredential()
    const json = await kgConceptPost('comment/count', { credential, hash })
    return Number(json?.count) || 0
  } catch (e) {
    console.warn('[Kugou] 评论数获取失败:', e)
    return 0
  }
}

/** 楼层评论（special_id = 父评论的 specialChildId；上游缺它返回 20006） */
export async function fetchKugouCommentFloor(params: {
  mixSongId?: number
  specialId: string
  tid?: string | number
  page?: number
  pagesize?: number
}): Promise<KugouComment[]> {
  if (!params.specialId) return []
  try {
    const credential = getKugouDeviceCredential()
    const json = await kgConceptPost('comment/floor', {
      credential,
      mixsongid: params.mixSongId || undefined,
      special_id: params.specialId,
      tid: params.tid,
      page: params.page || 1,
      pagesize: params.pagesize || 30,
    })
    const rows = Array.isArray(json?.data?.list) ? json.data.list : []
    return rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c))
  } catch (e) {
    console.warn('[Kugou] 楼层评论获取失败:', e)
    return []
  }
}

// ─────────────────────── 评论写操作 / 排序读（2026-10-07 实测通） ───────────────────────
// 发表 commentsv3/add、回复 commentsv2/reply、点赞 mlike handlelike、删除 commentsv2/delcomment、
// 最热 H5 /r/v1/rank/topliked、最新 commentsv2/getCommentWithLike。端点细节见 server/kugou-gateway.mjs。

/** 评论操作通用失败形状（带上游错误码，供 UI 如实提示频控 60062 等） */
export interface KugouCommentMutationResult {
  success: boolean
  id?: string
  error?: string
  errorCode?: number
}

function commentMutationError(e: unknown, fallback: string): KugouCommentMutationResult {
  const err = e as (Error & { errorCode?: number }) | null
  return {
    success: false,
    error: err instanceof Error ? err.message : fallback,
    errorCode: typeof err?.errorCode === 'number' ? err.errorCode : undefined,
  }
}

/** 发表歌曲评论（需概念版登录；成功返回 addid） */
export async function sendKugouComment(mixSongId: number, content: string): Promise<KugouCommentMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  const mixsongid = Number(mixSongId) || 0
  const text = String(content || '').trim()
  if (!mixsongid || !text) return { success: false, error: '评论内容不能为空' }
  try {
    const json = await kgConceptPost('comment/send', { credential, mixsongid, content: text })
    if (!json?.success) return { success: false, error: json?.error || '评论发表失败', errorCode: json?.errorCode }
    return { success: true, id: String(json.id || '') }
  } catch (e) {
    return commentMutationError(e, '评论发表失败')
  }
}

/** 回复评论/楼层（tid=被回复对象 id；pid=所属顶级评论 id，回复顶级评论传 0） */
export async function replyKugouComment(
  mixSongId: number,
  params: { commentId: string; pid?: string; content: string },
): Promise<KugouCommentMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  const mixsongid = Number(mixSongId) || 0
  const commentId = String(params.commentId || '').trim()
  const text = String(params.content || '').trim()
  if (!mixsongid || !commentId || !text) return { success: false, error: '回复内容不能为空' }
  try {
    const json = await kgConceptPost('comment/reply', {
      credential,
      mixsongid,
      content: text,
      comment_id: commentId,
      pid: String(params.pid || '0'),
    })
    if (!json?.success) return { success: false, error: json?.error || '回复发表失败', errorCode: json?.errorCode }
    return { success: true, id: String(json.id || '') }
  } catch (e) {
    return commentMutationError(e, '回复发表失败')
  }
}

/** 点赞/取消点赞（上游是 toggle；liked 传期望态，不符时服务端自动补一次翻转） */
export async function likeKugouCommentItem(
  commentId: string,
  specialId: string,
  liked: boolean,
): Promise<KugouCommentMutationResult & { isLiked?: boolean }> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  if (!commentId || !specialId) return { success: false, error: '评论信息不完整' }
  try {
    const json = await kgConceptPost('comment/like', { credential, comment_id: commentId, special_id: specialId, liked })
    if (!json?.success) return { success: false, error: json?.error || '点赞操作失败', errorCode: json?.errorCode }
    return { success: true, isLiked: Boolean(json.isLiked) }
  } catch (e) {
    return commentMutationError(e, '点赞操作失败')
  }
}

/** 删除自己的评论/楼层（commentsv2/delcomment）。
 *  实测（2026-10-07）：接口恒回 status=1（受理），但评论不会从列表移除——同设备身份发表+删除、
 *  15 分钟后仍可见、count 不回落；跨设备与同设备两种身份、childrenname/hash/special_id 等参数
 *  变体均如此。UI 侧据此置灰删除按钮，本封装保留供上游行为修正后跟进。 */
export async function deleteKugouCommentItem(
  commentId: string,
  specialId: string,
): Promise<KugouCommentMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  if (!commentId || !specialId) return { success: false, error: '评论信息不完整' }
  try {
    const json = await kgConceptPost('comment/delete', { credential, comment_id: commentId, special_id: specialId })
    if (!json?.success) return { success: false, error: json?.error || '删除评论失败', errorCode: json?.errorCode }
    return { success: true }
  } catch (e) {
    return commentMutationError(e, '删除评论失败')
  }
}

/** 最热评论（H5 榜单，按点赞量降序；specialId 取歌曲级 childrenid） */
export async function fetchKugouHotComments(
  mixSongId: number,
  specialId: string,
  page = 1,
  pagesize = 30,
): Promise<{ comments: KugouComment[]; total: number; tags: KugouHotWord[]; error?: string }> {
  const credential = getKugouDeviceCredential()
  if (!specialId) return { comments: [], total: 0, tags: [], error: '该曲目暂无最热评论榜单' }
  try {
    const json = await kgConceptPost('comment/hot', {
      credential,
      mixsongid: Number(mixSongId) || undefined,
      special_id: specialId,
      page,
      pagesize,
    })
    const rows = Array.isArray(json?.data?.list) ? json.data.list : []
    const tags = (Array.isArray(json?.data?.tags) ? json.data.tags : [])
      .map((tag: any) => ({ word: String(tag?.name || '').trim(), count: Number(tag?.count) || 0 }))
      .filter((tag: KugouHotWord) => tag.word)
    return { comments: rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c)), total: Number(json?.data?.count) || 0, tags }
  } catch (e) {
    return { comments: [], total: 0, tags: [], error: e instanceof Error ? e.message : '最热评论加载失败' }
  }
}

/** 最新评论（web commentsv2/getCommentWithLike；实测默认序=最新优先+官方置顶热评，含 IP 属地） */
export async function fetchKugouLatestComments(
  mixSongId: number,
  page = 1,
  pagesize = 30,
): Promise<{ comments: KugouComment[]; total: number; childrenId: string; error?: string }> {
  const credential = getKugouDeviceCredential()
  const mixsongid = Number(mixSongId) || 0
  if (!mixsongid) return { comments: [], total: 0, childrenId: '', error: '缺少歌曲 mixsongid（该曲目信息不完整）' }
  try {
    const json = await kgConceptPost('comment/latest', { credential, mixsongid, page, pagesize })
    const rows = Array.isArray(json?.data?.list) ? json.data.list : []
    return {
      comments: rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c)),
      total: Number(json?.data?.count) || 0,
      childrenId: String(json?.data?.childrenid || ''),
    }
  } catch (e) {
    return { comments: [], total: 0, childrenId: '', error: e instanceof Error ? e.message : '评论加载失败' }
  }
}

/** 热词过滤评论（热词来自 cmtlist 的 hot_word_list[].content） */
export async function fetchKugouHotWordComments(
  mixSongId: number,
  hotWord: string,
  page = 1,
  pagesize = 30,
): Promise<{ comments: KugouComment[]; total: number; error?: string }> {
  const credential = getKugouDeviceCredential()
  const mixsongid = Number(mixSongId) || 0
  const word = String(hotWord || '').trim()
  if (!mixsongid || !word) return { comments: [], total: 0, error: '缺少热词' }
  try {
    const json = await kgConceptPost('comment/hot-word', { credential, mixsongid, hot_word: word, page, pagesize })
    const rows = Array.isArray(json?.data?.list) ? json.data.list : []
    return {
      comments: rows.map(mapKugouCommentItem).filter((c: KugouComment | null): c is KugouComment => Boolean(c)),
      total: Number(json?.data?.count) || 0,
    }
  } catch (e) {
    return { comments: [], total: 0, error: e instanceof Error ? e.message : '热词评论加载失败' }
  }
}

/** 解析收藏歌单归属：global_collection_id 形如 collection_3_<uid>_<listid>_0。
 *  收藏接口必须带 ownerUserId+listid，公开 specialid（纯数字）无法收藏。 */
export function parseKugouCollectionOwner(collectionId: string): { ownerUserId: string; listid: string; gid: string } | null {
  const raw = String(collectionId || '').trim()
  const match = raw.match(/^collection_(\d+)_(\d+)_(\d+)_(\d+)$/)
  if (!match) return null
  return { ownerUserId: match[2], listid: match[3], gid: raw }
}

export interface KugouMutationResult {
  success: boolean
  id?: string
  listid?: string
  error?: string
}

/** 新建歌单（/cloudlist.service/v5/add_list type=0）；成功返回新歌单的 global_collection_id */
export async function createKugouUserPlaylist(name: string, isPrivate = false): Promise<KugouMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  const clean = String(name || '').trim()
  if (!clean) return { success: false, error: '歌单名称不能为空' }
  try {
    const json = await kgConceptPost('playlist/create', { credential, name: clean, privacy: isPrivate ? '1' : '0' })
    if (!json?.success) return { success: false, error: json?.error || '新建歌单失败' }
    return { success: true, id: String(json.globalCollectionId || ''), listid: String(json.listid || '') }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '新建歌单失败' }
  }
}

/** 收藏/取消收藏歌单。收藏要求 id 是 global_collection_id（含归属 uid/listid）；
 *  取消收藏按 listid 走 /v2/delete_list。 */
export async function collectKugouPlaylist(
  playlistId: string,
  subscribe = true,
  meta?: { name?: string; ownerUserId?: string; listid?: string; gid?: string },
): Promise<KugouMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    if (!subscribe) {
      const listid = String(meta?.listid || parseKugouCollectionOwner(playlistId)?.listid || '').replace(/\D/g, '')
      if (!listid) return { success: false, error: '缺少歌单 listid，无法取消收藏' }
      const json = await kgConceptPost('playlist/collect', { credential, subscribe: false, listid })
      if (!json?.success) return { success: false, error: json?.error || '取消收藏失败' }
      return { success: true, listid }
    }
    const parsed = parseKugouCollectionOwner(meta?.gid || playlistId)
    const ownerUserId = String(meta?.ownerUserId || parsed?.ownerUserId || '')
    const listid = String(meta?.listid || parsed?.listid || '')
    if (!ownerUserId || !listid) {
      return { success: false, error: '该歌单缺少归属信息（owner/listid），上游无法收藏' }
    }
    const json = await kgConceptPost('playlist/collect', {
      credential,
      subscribe: true,
      name: String(meta?.name || ''),
      ownerUserId,
      listid,
      gid: String(meta?.gid || parsed?.gid || ''),
    })
    if (!json?.success) return { success: false, error: json?.error || '收藏歌单失败' }
    return { success: true, id: String(json.globalCollectionId || ''), listid: String(json.listid || listid) }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '收藏歌单失败' }
  }
}

/** 删除/取消收藏歌单（type=1 取消收藏，type=0 删除自建歌单） */
export async function deleteKugouUserPlaylist(listid: string, type: 0 | 1 = 1): Promise<KugouMutationResult> {
  const credential = getKugouConceptCredential()
  if (!credential) return { success: false, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('playlist/delete', { credential, listid, type })
    if (!json?.success) return { success: false, error: json?.error || '删除歌单失败' }
    return { success: true, listid: String(listid) }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '删除歌单失败' }
  }
}

export interface KugouCloudSong {
  track: KugouTrack
  fileId?: string
  filesize?: number
}

/** 云盘列表（空盘返回空数组 + empty=true，不是错误） */
export async function fetchKugouUserCloud(
  page = 1,
  pagesize = 30,
): Promise<{ songs: KugouCloudSong[]; empty: boolean; total: number; error?: string }> {
  const credential = getKugouConceptCredential()
  if (!credential) return { songs: [], empty: true, total: 0, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('cloud', { credential, page, pagesize })
    const rows = Array.isArray(json?.songs) ? json.songs : []
    const songs = rows.map((item: any): KugouCloudSong => ({
      track: {
        hash: String(item?.hash || '').toLowerCase(),
        songName: String(item?.songName || ''),
        singerName: String(item?.singerName || ''),
        albumId: item?.albumId ? String(item.albumId) : undefined,
        albumAudioId: Number(item?.albumAudioId || 0) || undefined,
        duration: Number(item?.duration || 0) || undefined,
        coverUrl: resolveKugouCover(String(item?.coverUrl || '')),
        fileId: item?.fileId ? String(item.fileId) : undefined,
      },
      fileId: item?.fileId ? String(item.fileId) : undefined,
      filesize: Number(item?.filesize || 0) || undefined,
    })).filter((song: KugouCloudSong) => song.track.hash || song.track.songName)
    return { songs, empty: Boolean(json?.empty) || songs.length === 0, total: Number(json?.total) || songs.length }
  } catch (e) {
    return { songs: [], empty: true, total: 0, error: e instanceof Error ? e.message : '云盘加载失败' }
  }
}

export interface KugouPurchasedSong {
  track: KugouTrack
  goodsId?: string
  addTime?: number
}

/** 已购单曲（字段名上游未实测到数据，兼容 audio_info 与平铺两种形状） */
export async function fetchKugouPurchasedSongs(
  page = 1,
  pagesize = 50,
): Promise<{ songs: KugouPurchasedSong[]; total: number; error?: string }> {
  const credential = getKugouConceptCredential()
  if (!credential) return { songs: [], total: 0, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('purchased/songs', { credential, page, pagesize })
    const rows = Array.isArray(json?.goods) ? json.goods : []
    const songs = rows.map((item: any) => {
      const info = item?.audio_info || item?.audio || item || {}
      const hash = String(info.hash || '').toLowerCase()
      const songName = String(info.name || info.songname || info.audio_name || '').trim()
      if (!hash || !songName) return null
      return {
        goodsId: String(item?.goods_id || item?.id || '') || undefined,
        addTime: Number(item?.addtime || item?.add_time || 0) || undefined,
        track: {
          hash,
          songName,
          singerName: String(info.author_name || info.singername || info.singer_name || ''),
          singerId: String(info.author_id || '') || undefined,
          albumId: String(info.album_id || '') || undefined,
          albumName: String(info.album_name || '') || undefined,
          albumAudioId: Number(info.album_audio_id || info.audio_id || info.mixsongid || 0) || undefined,
          duration: Math.round((Number(info.timelen || info.timelength || info.duration || 0) || 0) / 1000) || undefined,
          coverUrl: resolveKugouCover(String(info.imgurl || info.cover || info.trans_param?.union_cover || '')),
        },
      } as KugouPurchasedSong
    }).filter((song: KugouPurchasedSong | null): song is KugouPurchasedSong => Boolean(song))
    return { songs, total: Number(json?.total) || songs.length }
  } catch (e) {
    return { songs: [], total: 0, error: e instanceof Error ? e.message : '已购音乐加载失败' }
  }
}

export interface KugouPurchasedAlbum {
  albumId: string
  name: string
  singerName: string
  coverUrl: string
  addTime?: number
}

/** 已购专辑（同样兼容 goods 内嵌与平铺两种形状） */
export async function fetchKugouPurchasedAlbums(
  page = 1,
  pagesize = 15,
): Promise<{ albums: KugouPurchasedAlbum[]; total: number; error?: string }> {
  const credential = getKugouConceptCredential()
  if (!credential) return { albums: [], total: 0, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('purchased/albums', { credential, page, pagesize })
    const rows = Array.isArray(json?.goods) ? json.goods : []
    const albums = rows.map((item: any) => {
      const info = item?.album_info || item?.album || item || {}
      const albumId = String(info.album_id || info.albumid || '')
      const name = String(info.album_name || info.albumname || '').trim()
      if (!albumId || !name) return null
      return {
        albumId,
        name,
        singerName: String(info.author_name || info.singername || ''),
        coverUrl: resolveKugouCover(String(info.imgurl || info.cover || info.sizable_cover || '')),
        addTime: Number(item?.addtime || item?.add_time || 0) || undefined,
      } as KugouPurchasedAlbum
    }).filter((album: KugouPurchasedAlbum | null): album is KugouPurchasedAlbum => Boolean(album))
    return { albums, total: Number(json?.total) || albums.length }
  } catch (e) {
    return { albums: [], total: 0, error: e instanceof Error ? e.message : '已购专辑加载失败' }
  }
}

/** 酷狗官方网页歌曲链接（右键「复制链接」用；hash 是稳定标识，album_id 可选） */
export function buildKugouSongLink(song: { mid?: string; hash?: string; album?: { mid?: string } }): string {
  const hash = String(song?.mid || song?.hash || '').trim()
  if (!hash) return ''
  const albumId = String(song?.album?.mid || '').trim()
  return albumId
    ? `https://www.kugou.com/song/#hash=${encodeURIComponent(hash)}&album_id=${encodeURIComponent(albumId)}`
    : `https://www.kugou.com/song/#hash=${encodeURIComponent(hash)}`
}

// 产品口径：本软件不做下载功能（入口与直链解析链路都不保留，避免留下"点了没反应"的假入口）。
// 需要「保存/导出」能力时走平台官方客户端，不在本软件内实现。

// ─────────────────────── 3.E 刷歌（youth 竖滑流）───────────────────────
// 上游实测：本账号 /youth/v3/user/get_dynamic 恒返回 list:[]（is_end=1），
// 卡片元素字段**无法实测**。因此这里不做「按猜的字段名严格映射、映射不上就丢卡片」的做法：
// - 数组原样透传：KugouYouthCard.raw 保存整个条目；
// - 曲目信息靠「结构识别」（对象树里出现 32 位 hex hash 的节点即视为曲目候选），
//   同时兼容 endpoints 文档给出的参考形态（hash/audio_id/author_name/authors[]/audio_info{}）；
// - 识别不出来时 song 为 null，UI 明确提示字段未识别，绝不静默丢数据。

export interface KugouYouthCard {
  /** 原始条目：字段未识别时 UI 仍按原样展示/透传 */
  raw: unknown
  /** 结构识别出的可播放曲目；识别不出为 null（不猜、不造） */
  song: Song | null
  /** 上报已听用的 mixsongid（识别不出为 0） */
  mixsongid: number
  /** 识别出的标题（识别不出为空串，UI 用兜底文案） */
  title: string
  artist: string
  coverUrl: string
}

const KUGOU_YOUTH_HASH_RE = /^[0-9a-f]{32}$/i
const KUGOU_YOUTH_URL_RE = /^https?:\/\//i
const KUGOU_YOUTH_MAX_DEPTH = 6

function isKugouYouthRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 结构扫描：找对象树里「自身含 32 位 hex hash 字段」的节点（不依赖固定字段名，仅要求键名像 hash/file） */
function findKugouYouthTrackNode(value: unknown, depth = 0): Record<string, any> | null {
  if (depth > KUGOU_YOUTH_MAX_DEPTH) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKugouYouthTrackNode(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!isKugouYouthRecord(value)) return null
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && KUGOU_YOUTH_HASH_RE.test(item.trim()) && /hash|file/i.test(key)) return value
  }
  for (const item of Object.values(value)) {
    const found = findKugouYouthTrackNode(item, depth + 1)
    if (found) return found
  }
  return null
}

/** 按「键名候选优先级 + 值校验」取值：多方兼容靠候选表，不绑定单一字段名 */
function pickKugouYouthString(source: Record<string, any>, patterns: RegExp[], validate?: (value: string) => boolean, rejectKey?: RegExp): string {
  for (const pattern of patterns) {
    for (const [key, value] of Object.entries(source)) {
      if (!pattern.test(key) || (rejectKey && rejectKey.test(key)) || typeof value !== 'string') continue
      const text = value.trim()
      if (!text || (validate && !validate(text))) continue
      return text
    }
  }
  return ''
}

function pickKugouYouthNumber(source: Record<string, any>, patterns: RegExp[]): number {
  for (const pattern of patterns) {
    for (const [key, value] of Object.entries(source)) {
      if (!pattern.test(key)) continue
      const num = Number(value)
      if (Number.isFinite(num) && num > 0) return num
    }
  }
  return 0
}

/** 歌手：先看 authors[]（参考形态），再看单值字段；数组元素允许是字符串或对象 */
function pickKugouYouthArtist(source: Record<string, any>, depth = 0): string {
  if (depth > 2) return ''
  for (const [key, value] of Object.entries(source)) {
    if (!/authors?|singers?/i.test(key) || !Array.isArray(value)) continue
    const names = value.map(item => {
      if (typeof item === 'string') return item.trim()
      if (isKugouYouthRecord(item)) {
        return String(item.author_name || item.singername || item.singer_name || item.name || '').trim()
      }
      return ''
    }).filter(Boolean)
    if (names.length) return names.join(' / ')
  }
  const single = pickKugouYouthString(source, [/author_?name/i, /singer_?name/i, /singername/i, /author$/i, /singer$/i, /artist/i])
  if (single) return single
  // 嵌套曲目对象（audio_info/song_info 等）里再找一层
  for (const value of Object.values(source)) {
    if (!isKugouYouthRecord(value)) continue
    const nested = pickKugouYouthString(value, [/author_?name/i, /singer_?name/i, /singername/i, /author$/i, /singer$/i, /artist/i]) ||
      pickKugouYouthArtist(value, depth + 1)
    if (nested) return nested
  }
  return ''
}

/** 标题：song/audio/filename 优先，name/title 兜底；嵌一层再找。
 *  宽松候选要排除 author/singer/album 之类键，否则 author_name 会被当成歌名。 */
const KUGOU_YOUTH_TITLE_STRONG = [/^song_?name$/i, /^songname$/i, /^audio_?name$/i, /^filename$/i, /^name$/i, /^title$/i]
const KUGOU_YOUTH_TITLE_LOOSE_REJECT = /author|singer|artist|album|playlist/i
function pickKugouYouthTitle(source: Record<string, any>): string {
  const direct = pickKugouYouthString(source, KUGOU_YOUTH_TITLE_STRONG) ||
    pickKugouYouthString(source, [/name/i, /title/i], undefined, KUGOU_YOUTH_TITLE_LOOSE_REJECT)
  if (direct) return direct
  for (const value of Object.values(source)) {
    if (!isKugouYouthRecord(value)) continue
    const nested = pickKugouYouthString(value, KUGOU_YOUTH_TITLE_STRONG) ||
      pickKugouYouthString(value, [/name/i, /title/i], undefined, KUGOU_YOUTH_TITLE_LOOSE_REJECT)
    if (nested) return nested
  }
  return ''
}

/** 封面：只认 http(s) 值，避免把路径/占位符当 URL；嵌套 trans_param.union_cover 也能取到 */
function pickKugouYouthCover(source: Record<string, any>, depth = 0): string {
  if (depth > 2) return ''
  const direct = pickKugouYouthString(source, [/cover/i, /imgurl/i, /img_?url/i, /union_?cover/i, /sizable_?cover/i, /pic/i, /poster/i], value => KUGOU_YOUTH_URL_RE.test(value))
  if (direct) return direct
  for (const value of Object.values(source)) {
    if (!isKugouYouthRecord(value)) continue
    const nested = pickKugouYouthCover(value, depth + 1)
    if (nested) return nested
  }
  return ''
}

/** 未识别卡片时给一个「像文案」的首个字符串（排除 id/hash/url 一类字段），仅用于兜底展示 */
function firstKugouYouthText(value: unknown, depth = 0): string {
  if (depth > 3) return ''
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstKugouYouthText(item, depth + 1)
      if (text) return text
    }
    return ''
  }
  if (!isKugouYouthRecord(value)) return ''
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' || !item.trim()) continue
    if (KUGOU_YOUTH_URL_RE.test(item) || /id$|hash$|url$|link$|token|time|date|count|num|type|code|_/i.test(key)) continue
    const text = item.trim()
    if (text.length > 0 && text.length <= 60) return text
  }
  for (const item of Object.values(value)) {
    const text = firstKugouYouthText(item, depth + 1)
    if (text) return text
  }
  return ''
}

/** 时长：timelen/timelength 是毫秒，duration/interval 是秒（两种形态都兼容；嵌一层也找） */
function pickKugouYouthDurationSeconds(source: Record<string, any>): number | undefined {
  const lookup = (record: Record<string, any>): number | undefined => {
    const ms = pickKugouYouthNumber(record, [/timelen/i, /timelength/i, /duration_?ms/i])
    if (ms > 0) return Math.round(ms / 1000)
    const seconds = pickKugouYouthNumber(record, [/duration/i, /interval/i, /seconds/i])
    return seconds > 0 ? Math.round(seconds) : undefined
  }
  const direct = lookup(source)
  if (direct) return direct
  for (const value of Object.values(source)) {
    if (!isKugouYouthRecord(value)) continue
    const nested = lookup(value)
    if (nested) return nested
  }
  return undefined
}

/** 单张动态卡片：结构识别曲目；识别不出保留 raw + 兜底标题，不做字段猜测 */
export function parseKugouYouthCard(raw: unknown): KugouYouthCard {
  const root = isKugouYouthRecord(raw) ? raw : {}
  const node = findKugouYouthTrackNode(raw) || root
  const hash = pickKugouYouthString(node, [/hash/i, /file_?hash/i], value => KUGOU_YOUTH_HASH_RE.test(value))
  const title = hash ? pickKugouYouthTitle(node) || pickKugouYouthTitle(root) : ''
  const artist = hash ? pickKugouYouthArtist(node) || pickKugouYouthArtist(root) : ''
  const coverUrl = resolveKugouCover(hash ? pickKugouYouthCover(node) || pickKugouYouthCover(root) : '')
  const mixsongid = hash
    ? pickKugouYouthNumber(node, [/^mixsongid$/i, /mixsongid/i, /album_audio_id/i, /^audio_?id$/i]) ||
      pickKugouYouthNumber(root, [/^mixsongid$/i, /mixsongid/i, /album_audio_id/i, /^audio_?id$/i])
    : 0
  const albumId = hash ? String(pickKugouYouthNumber(node, [/album_?id/i]) || pickKugouYouthNumber(root, [/album_?id/i]) || '') : ''
  const song = hash && title
    ? kugouTrackToSong({
        hash: hash.toLowerCase(),
        songName: title,
        singerName: artist || '未知歌手',
        albumId: albumId || undefined,
        albumAudioId: mixsongid || undefined,
        duration: pickKugouYouthDurationSeconds(node),
        coverUrl: coverUrl || undefined,
      })
    : null
  return {
    raw,
    song,
    mixsongid,
    title: song ? song.name : firstKugouYouthText(raw),
    artist: song ? (artist || '未知歌手') : '',
    coverUrl: song ? (coverUrl || '') : '',
  }
}

export function parseKugouYouthCards(rows: unknown): KugouYouthCard[] {
  if (!Array.isArray(rows)) return []
  return rows.map(parseKugouYouthCard)
}

export interface KugouYouthFeed {
  cards: KugouYouthCard[]
  isEnd: boolean
  lastCid: string
  /** 上游成功但列表为空（实测本账号恒如此）：UI 要展示「当前账号暂无动态」空态而不是报错 */
  empty: boolean
  error?: string
}

/** 刷歌动态流（/youth/v3/user/get_dynamic）。lastCid 只在翻页时传，首屏不传 */
export async function fetchKugouYouthDynamic(lastCid = ''): Promise<KugouYouthFeed> {
  const credential = getKugouConceptCredential()
  if (!credential) return { cards: [], isEnd: true, lastCid: '', empty: true, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('youth/dynamic', lastCid ? { credential, last_cid: lastCid } : { credential })
    const rows = Array.isArray(json?.list) ? json.list : []
    const cards = parseKugouYouthCards(rows)
    return {
      cards,
      isEnd: Boolean(json?.isEnd),
      lastCid: String(json?.lastCid || ''),
      empty: rows.length === 0,
      error: json?.success === false ? String(json?.error || '酷狗刷歌动态获取失败') : undefined,
    }
  } catch (e) {
    return { cards: [], isEnd: true, lastCid: '', empty: true, error: e instanceof Error ? e.message : '酷狗刷歌动态获取失败' }
  }
}

/** 刷歌最近动态（/youth/v3/user/recent_dynamic） */
export async function fetchKugouYouthRecent(): Promise<{ cards: KugouYouthCard[]; empty: boolean; error?: string }> {
  const credential = getKugouConceptCredential()
  if (!credential) return { cards: [], empty: true, error: '请先登录酷狗音乐（概念版扫码）' }
  try {
    const json = await kgConceptPost('youth/recent', { credential })
    const rows = Array.isArray(json?.list) ? json.list : []
    const cards = parseKugouYouthCards(rows)
    return {
      cards,
      empty: rows.length === 0,
      error: json?.success === false ? String(json?.error || '酷狗刷歌最近动态获取失败') : undefined,
    }
  } catch (e) {
    return { cards: [], empty: true, error: e instanceof Error ? e.message : '酷狗刷歌最近动态获取失败' }
  }
}

/** 上报已听（/youth/v2/report/listen_song）。失败不打断播放：只回执 boolean，由调用方决定是否忽略 */
export async function reportKugouYouthListen(mixsongid: number): Promise<boolean> {
  const credential = getKugouConceptCredential()
  if (!credential || !Number(mixsongid)) return false
  try {
    const json = await kgConceptPost('youth/listen', { credential, mixsongid: Number(mixsongid) })
    return Boolean(json?.success)
  } catch {
    return false
  }
}
