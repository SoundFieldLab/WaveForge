/**
 * 汽水音乐服务（抖音音乐体系，www.douyin.com）
 *
 * 背景：
 * - 汽水音乐无公开消费者网页（sodamusic.com 已停用为占位页；api.qishui.com/luna 为 protobuf 签名接口）
 * - 抖音系接口需 a_bogus 签名
 * 方案（本文件 + 主进程 soda-scrape-search IPC）：
 * - 登录：抖音 passport 扫码（sso.douyin.com），捕获抖音会话 Cookie
 * - 搜索/探索：主进程隐藏窗口加载抖音搜索页（共享 session，登录后带会话），
 *   由页面自身渲染结果再抓取音乐卡片 —— 绕开签名，返回真实抖音音乐数据
 * - 播放：抖音音乐直链需要复杂签名，未登录/失败时由上层 resolvePlayableSong 降级网易云/QQ
 */

import type { Song } from './musicApi'
import { getPlatformCookie } from './platforms'

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
}

async function scrapeSearch(keyword: string, limit = 30): Promise<DouyinMusicItem[]> {
  const bridge = (window as any).electron
  if (!bridge?.sodaScrapeSearch) return []
  try {
    const result = await bridge.sodaScrapeSearch(keyword)
    if (!result?.success || !Array.isArray(result.items)) return []
    return result.items.slice(0, limit)
  } catch (e) {
    console.warn('[汽水] 搜索抓取失败:', e)
    return []
  }
}

/** 汽水音乐搜索（经主进程隐藏窗口抓取抖音音乐搜索结果） */
export async function searchSodaSongs(keyword: string, limit = 30): Promise<Song[]> {
  const items = await scrapeSearch(keyword, limit)
  return items.map(item => douyinMusicToSong(item))
}

/** 探索页数据：抖音热门关键词 × 搜索结果（真实抖音音乐） */
const SODA_EXPLORE_KEYWORDS = ['抖音热歌', '网络热歌', '热门歌曲', '新歌']

export async function fetchSodaExplore(): Promise<{ playlists: Array<{ id: string; name: string; coverUrl?: string }>; songs: Song[]; charts: Array<{ id: string; name: string; group: string; songs: Song[] }> }> {
  const collected = new Map<string, DouyinMusicItem>()
  for (const keyword of SODA_EXPLORE_KEYWORDS) {
    const items = await scrapeSearch(keyword, 24)
    for (const item of items) {
      if (item.id && !collected.has(item.id)) collected.set(item.id, item)
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

/** 汽水音乐播放 URL（抖音音乐直链需复杂签名，暂不可用 → 上层降级） */
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
      name: '',
      picUrl: item.cover || '',
    },
    duration: 0,
    platform: 'soda' as const,
    fee: 0,
    songType: 1,
    fusedSources: [],
  }
}
