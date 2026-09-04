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

const KG_API = 'http://localhost:3001/api/kugou'

export interface KugouTrack {
  hash: string
  songName: string
  singerName: string
  /** 歌手 id（歌手详情/相似歌曲跳转用；榜单/搜索/专辑接口提供） */
  singerId?: string
  albumName?: string
  duration?: number
  albumId?: string
  /** 专辑内音频 id（播放直链/歌词匹配用） */
  albumAudioId?: number
  coverUrl?: string
  /** 320k/flac 音质文件 hash（用于播放 URL） */
  playHash?: string
}

export interface KugouPlaylist {
  specialid: string
  name: string
  coverUrl?: string
  playcount?: number
  songcount?: number
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
    const resp = await fetch(`${KG_API}/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/rank/list`, { cache: 'no-store' })
    if (!resp.ok) return []
    const ranks = await resp.json()
    return Array.isArray(ranks) ? ranks : []
  } catch (e) {
    console.warn('[Kugou] 榜单列表获取失败:', e)
    return []
  }
}

/** 酷狗榜单歌曲（TOP500=8888，飙升=6666，网络新歌榜=5990 等） */
export async function fetchKugouRankInfo(rankid = '8888', limit = 30): Promise<KugouTrack[]> {
  try {
    const resp = await fetch(`${KG_API}/rank/info?rankid=${rankid}&pagesize=${limit}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/playlist/list?pagesize=${limit}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/playlist/detail?specialid=${specialid}&pagesize=${limit}`, { cache: 'no-store' })
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
  // 桥接：真实 Chromium 页面内同源 fetch（www.kugou.com 对服务端 node fetch 有 TLS 指纹风控）
  const bridge = (window as any).electron?.kugouScrape
  if (bridge?.userInfo) {
    try {
      const result = await bridge.userInfo()
      if (result?.success && result.info && (result.info.nickname || result.info.user_id)) {
        return result.info
      }
    } catch { /* 桥失败回退代理 */ }
  }
  try {
    const resp = await fetch(`${KG_API}/user/info?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const json = await resp.json()
    if (!json || json.error || (!json.nickname && !json.user_id)) return null
    return json
  } catch (e) {
    console.warn('[Kugou] 用户信息获取失败:', e)
    return null
  }
}

/** 酷狗用户歌单（需登录 cookie）：优先走签名网关代理（服务端直连），失败回退隐藏窗口桥 */
export async function fetchKugouUserPlaylists(cookie?: string): Promise<KugouPlaylist[]> {
  const kgCookie = cookie || getPlatformCookie('kugou')
  if (!kgCookie) return []
  try {
    const resp = await fetch(`${KG_API}/user/playlist?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
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
        return result.playlists.map((p: { specialid: string; name: string; img?: string; songcount?: number; playcount?: number }) => ({
          specialid: p.specialid,
          name: p.name,
          coverUrl: resolveKugouCover(p.img || ''),
          songcount: p.songcount,
          playcount: p.playcount,
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
  const kgCookie = getPlatformCookie('kugou')
  if (!kgCookie || !listid) return []
  const out: KugouTrack[] = []
  const seen = new Set<string>()
  try {
    for (let p = Math.max(1, page); p <= 20; p += 1) {
      const query = new URLSearchParams({ listid, page: String(p), pagesize: String(pagesize), cookie: kgCookie })
      const resp = await fetch(`${KG_API}/user/playlist/tracks?${query.toString()}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/album/list?page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/album/detail?albumid=${encodeURIComponent(albumid)}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/singer/detail?singerid=${encodeURIComponent(singerid)}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/singer/song?singerid=${encodeURIComponent(singerid)}&page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/singer/album?singerid=${encodeURIComponent(singerid)}&page=${page}&pagesize=${pagesize}`, { cache: 'no-store' })
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
  try {
    const cookie = getPlatformCookie('kugou')
    const query = new URLSearchParams({ hash })
    if (extra.albumId) query.set('albumId', extra.albumId)
    if (extra.albumAudioId) query.set('album_audio_id', String(extra.albumAudioId))
    if (cookie) query.set('cookie', cookie)
    const resp = await fetch(`${KG_API}/song/url?${query.toString()}`, { cache: 'no-store' })
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
    const resp = await fetch(`${KG_API}/lyric?${query.toString()}`, { cache: 'no-store' })
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

/** 酷狗喜欢歌曲（H5 签名网关；like=false 目前仅返回支持标记，真实移除待网关适配） */
export async function likeKugouSong(song: { hash?: string; mid?: string; name?: string; artists?: Array<{ name: string }>; album?: { id?: string | number } }, like: boolean): Promise<boolean> {
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return false
  try {
    const resp = await fetch(`${KG_API}/like`, {
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

/** 酷狗歌单加歌（H5 签名网关） */
export async function addKugouSongToPlaylist(listId: string, song: { hash?: string; mid?: string; name?: string; artists?: Array<{ name: string }> }): Promise<boolean> {
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return false
  try {
    const resp = await fetch(`${KG_API}/playlist/tracks`, {
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

/** 判断酷狗 Cookie 是否为有效登录态（KuGoo 网页会话 或 kg_token 客户端令牌） */
export function isKugouCookieValid(cookie: string): boolean {
  return Boolean(cookie && (/KuGoo=/.test(cookie) || /KugooID=/.test(cookie) || /kg_token/.test(cookie)))
}

/** 是否已登录酷狗（有 KuGoo/kg_token 登录凭据） */
export function isKugouLoggedIn(): boolean {
  return isKugouCookieValid(getPlatformCookie('kugou'))
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
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}
