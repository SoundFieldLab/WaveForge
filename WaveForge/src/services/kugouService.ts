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
  albumName?: string
  duration?: number
  albumId?: string
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

/** 解析酷狗封面 URL：替换 CDN 的 {size} 占位并升级为 https */
function resolveKugouCover(url: string): string {
  if (!url) return ''
  return url
    .replace(/^http:\/\//i, 'https://')
    .replace(/\{size\}/g, '600x600')
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
    return Array.isArray(playlists) ? playlists : []
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
        coverUrl: resolveKugouCover(item.album_img || ''),
      },
    )).filter((t: KugouTrack | null): t is KugouTrack => Boolean(t && t.songName))
  } catch (e) {
    console.warn('[Kugou] 歌单详情获取失败:', e)
    return []
  }
}

/** 酷狗用户信息（需登录 cookie） */
export async function fetchKugouUserInfo(cookie?: string): Promise<KugouUserInfo | null> {
  const kgCookie = cookie || getPlatformCookie('kugou')
  if (!kgCookie) return null
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

/** 酷狗用户歌单（需登录 cookie） */
export async function fetchKugouUserPlaylists(cookie?: string): Promise<KugouPlaylist[]> {
  const kgCookie = cookie || getPlatformCookie('kugou')
  if (!kgCookie) return []
  try {
    const resp = await fetch(`${KG_API}/user/playlist?cookie=${encodeURIComponent(kgCookie)}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const playlists = await resp.json()
    return Array.isArray(playlists) ? playlists : []
  } catch (e) {
    console.warn('[Kugou] 用户歌单获取失败:', e)
    return []
  }
}

/** 酷狗播放 URL（需登录 cookie） */
export async function getKugouSongUrl(hash: string): Promise<string | null> {
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return null
  try {
    const resp = await fetch(`${KG_API}/song/url?hash=${encodeURIComponent(hash)}&cookie=${encodeURIComponent(cookie)}`, { cache: 'no-store' })
    if (!resp.ok) return null
    const json = await resp.json()
    if (!json?.url) return null
    return json.url
  } catch (e) {
    console.warn('[Kugou] 播放地址获取失败:', e)
    return null
  }
}

/** 酷狗歌词（需登录 cookie） */
export async function getKugouLyrics(hash: string): Promise<LyricLine[]> {
  const cookie = getPlatformCookie('kugou')
  if (!cookie) return []
  try {
    const resp = await fetch(`${KG_API}/lyric?hash=${encodeURIComponent(hash)}&cookie=${encodeURIComponent(cookie)}`, { cache: 'no-store' })
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
  return {
    id: Number(parseInt(hashStr.slice(0, 12), 16)) || 0,
    mid: hashStr,
    name: track.songName,
    artists: [{ name: track.singerName }],
    album: {
      id: track.albumId ? Number(parseInt(track.albumId.slice(0, 12), 16)) : undefined,
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
