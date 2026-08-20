/**
 * 汽水音乐服务（抖音音乐体系）
 *
 * 数据源（借鉴 Mineradio 逆向成果）：
 * - 搜索/探索：火山引擎公开目录 API（api-vehicle.volcengine.com，无需登录/签名），
 *   经 local-server 代理（/api/qishui/search、/api/qishui/detail）。
 * - 歌词：火山详情接口返回 lyric_text。
 * - 播放：抖音音乐直链需登录与音频解密，暂不可用 → 由上层 resolvePlayableSong 匹配网易云/QQ 播放。
 * - 登录：抖音 passport 扫码（sso.douyin.com），捕获抖音会话 Cookie。
 */

import type { Song, LyricLine } from './musicApi'
import { getPlatformCookie } from './platforms'

const QISHUI_API = 'http://localhost:3001/api/qishui'

export function getSodaToken(): string {
  return getPlatformCookie('soda')
}

/** 是否已登录汽水音乐（抖音会话：sessionid 等） */
export function isSodaLoggedIn(): boolean {
  const cookie = getSodaToken()
  return Boolean(cookie && /sessionid|sid_guard|uid_tt|passport/i.test(cookie))
}

export interface DouyinMusicItem {
  id: string
  name: string
  author?: string
  cover?: string
  text?: string
  durationMs?: number
  album?: string
}

/** 火山引擎公开目录搜索（替代抖音 DOM 抓取；失败时回退 DOM 桥） */
async function publicSearch(keyword: string, limit = 30): Promise<DouyinMusicItem[]> {
  try {
    const resp = await fetch(`${QISHUI_API}/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    if (!Array.isArray(json.songs)) return []
    return json.songs.map((s: { id?: string; name?: string; artist?: string; coverUrl?: string; durationMs?: number; album?: string }) => ({
      id: String(s.id || ''),
      name: String(s.name || ''),
      author: String(s.artist || ''),
      cover: String(s.coverUrl || ''),
      durationMs: Number(s.durationMs || 0),
      album: String(s.album || ''),
    })).filter((s: { id: string; name: string }) => s.id && s.name)
  } catch (e) {
    console.warn('[汽水] 公开搜索失败:', e)
    return []
  }
}

/** 抓取超时：主进程隐藏窗口每轮最长 6s，这里兜底 8s，避免首页/探索无限转圈 */
const SCRAPE_TIMEOUT_MS = 8000

async function scrapeSearch(keyword: string, limit = 30): Promise<DouyinMusicItem[]> {
  const bridge = (window as any).electron
  if (!bridge?.sodaScrapeSearch) return []
  try {
    const result = await Promise.race([
      bridge.sodaScrapeSearch(keyword),
      new Promise<null>(resolve => setTimeout(() => resolve(null), SCRAPE_TIMEOUT_MS)),
    ])
    if (!result?.success || !Array.isArray(result.items)) return []
    return result.items.slice(0, limit)
  } catch (e) {
    console.warn('[汽水] 搜索抓取失败:', e)
    return []
  }
}

/** 汽水音乐搜索（优先火山公开目录，回退抖音 DOM 抓取） */
export async function searchSodaSongs(keyword: string, limit = 30): Promise<Song[]> {
  const items = await publicSearch(keyword, limit)
  const source = items.length ? items : await scrapeSearch(keyword, limit)
  return source.map(item => douyinMusicToSong(item))
}

/** 探索页数据：抖音热门关键词 × 公开目录搜索（真实汽水音乐，快且稳） */
const SODA_EXPLORE_KEYWORDS = ['抖音热歌', '网络热歌', '热门歌曲', '新歌']

export async function fetchSodaExplore(): Promise<{ playlists: Array<{ id: string; name: string; coverUrl?: string }>; songs: Song[]; charts: Array<{ id: string; name: string; group: string; songs: Song[] }> }> {
  const collected = new Map<string, DouyinMusicItem>()
  // 关键词并行：优先公开目录，全失败再并行 DOM 抓取（各带超时，绝不卡死）
  const publicResults = await Promise.allSettled(SODA_EXPLORE_KEYWORDS.map(keyword => publicSearch(keyword, 24)))
  let anyPublic = false
  for (const result of publicResults) {
    if (result.status !== 'fulfilled' || !result.value.length) continue
    anyPublic = true
    for (const item of result.value) {
      if (item.id && !collected.has(item.id)) collected.set(item.id, item)
    }
  }
  if (!anyPublic) {
    const scrapeResults = await Promise.allSettled(SODA_EXPLORE_KEYWORDS.map(keyword => scrapeSearch(keyword, 24)))
    for (const result of scrapeResults) {
      if (result.status !== 'fulfilled') continue
      for (const item of result.value) {
        if (item.id && !collected.has(item.id)) collected.set(item.id, item)
      }
    }
  }
  const all = [...collected.values()].slice(0, 40)
  const charts = SODA_EXPLORE_KEYWORDS.slice(0, 3).map((keyword, index) => ({
    id: `soda-hot-${index}`,
    name: `抖音${keyword}榜`,
    group: '汽水音乐',
    songs: all.slice(index * 8, index * 8 + 8).map(douyinMusicToSong),
  })).filter(chart => chart.songs.length > 0)
  return {
    playlists: [],
    songs: all.map(douyinMusicToSong),
    charts,
  }
}

/** 汽水音乐歌词（火山详情接口 lyric_text） */
export async function getSodaLyrics(id: string): Promise<LyricLine[]> {
  if (!id) return []
  try {
    const resp = await fetch(`${QISHUI_API}/detail?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
    if (!resp.ok) return []
    const json = await resp.json()
    const lrc = String(json?.lyric || '')
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
    console.warn('[汽水] 歌词获取失败:', e)
    return []
  }
}

/** 汽水音乐播放 URL（抖音直链需登录与解密，暂不可用 → 上层降级） */
export async function getSodaSongUrl(_hash: string): Promise<string | null> {
  return null
}

/** 抖音音乐 → WaveForge Song（id 用抖音 music_id；mid 保留原始 id） */
export function douyinMusicToSong(item: DouyinMusicItem): Song {
  const rawId = String(item.id || '')
  const name = item.name || item.text || '未知歌曲'
  const author = item.author || ''
  return {
    id: Number(rawId.slice(0, 15)) || 0,
    mid: rawId,
    name,
    artists: author ? [{ name: author }] : [],
    album: {
      name: item.album || '',
      picUrl: item.cover || '',
    },
    duration: item.durationMs || 0,
    platform: 'soda' as const,
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}
