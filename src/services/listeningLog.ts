import type { Song } from './musicApi'

// src/services/listeningLog.ts
// WaveForge 本地听歌记录：每次实际开播记一条（含去重节流），用于「听歌报告」本地统计。
// 纯本地 localStorage，不上传；上限 3000 条 / 90 天，超限淘汰最旧。

const STORE_KEY = 'waveforge:listening-log:v1'
const DEDUPE_WINDOW_MS = 90 * 1000
const MAX_ENTRIES = 3000
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

export interface ListeningLogEntry {
  key: string
  name: string
  artist: string
  coverUrl: string
  platform: string
  ts: number
}

function loadEntries(): ListeningLogEntry[] {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.ts === 'number') : []
  } catch {
    return []
  }
}

function saveEntries(entries: ListeningLogEntry[]) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)))
  } catch { /* 存储满时静默失败 */ }
}

export function songKeyOf(song: Song): string {
  return `${song.platform || 'netease'}:${song.id || song.mid || song.name}`
}

/** 记录一次实际开播；同一首歌 90 秒内重复开播不重复计数 */
export function recordListen(song: Song): void {
  if (!song) return
  try {
    const entries = loadEntries()
    const now = Date.now()
    const key = songKeyOf(song)
    const last = entries[entries.length - 1]
    if (last && last.key === key && now - last.ts < DEDUPE_WINDOW_MS) return
    entries.push({
      key,
      name: String(song.name || ''),
      artist: Array.isArray(song.artists) ? song.artists.map(artist => artist.name).filter(Boolean).join(' / ') : String((song as any).artist?.name || ''),
      coverUrl: String(song.album?.picUrl || ''),
      platform: String(song.platform || 'netease'),
      ts: now,
    })
    const cutoff = now - MAX_AGE_MS
    saveEntries(entries.filter(entry => entry.ts >= cutoff))
  } catch { /* 统计失败不影响播放 */ }
}

export interface ListeningStats {
  /** 听过多少首（去重） */
  uniqueSongs: number
  /** 总播放次数 */
  totalPlays: number
  /** 每日播放次数（旧→新） */
  dayCounts: Array<{ date: string; count: number }>
  /** 播放次数最多的歌曲（含次数） */
  top: Array<{ name: string; artist: string; coverUrl: string; count: number }>
}

function dayStart(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 登出/换账号时清空听歌日志（本地统计数据，与平台无关但按账号语义展示） */
export function clearListeningLog(): void {
  try {
    localStorage.removeItem(STORE_KEY)
  } catch { /* ignore */ }
}
export function getListeningStats(range: 'week' | 'month'): ListeningStats {
  const entries = loadEntries()
  const days = range === 'week' ? 7 : 30
  const since = dayStart(Date.now()) - (days - 1) * 24 * 60 * 60 * 1000
  const inRange = entries.filter(entry => entry.ts >= since)
  const byDay = new Map<string, number>()
  for (let i = 0; i < days; i++) {
    const date = new Date(since + i * 24 * 60 * 60 * 1000)
    byDay.set(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, 0)
  }
  const countByKey = new Map<string, { entry: ListeningLogEntry; count: number }>()
  let totalPlays = 0
  for (const entry of inRange) {
    totalPlays++
    const date = new Date(entry.ts)
    const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    byDay.set(dateKey, (byDay.get(dateKey) || 0) + 1)
    const bucket = countByKey.get(entry.key) || { entry, count: 0 }
    bucket.count++
    countByKey.set(entry.key, bucket)
  }
  const dayCounts = [...byDay.entries()].map(([date, count]) => ({ date, count }))
  const top = [...countByKey.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
    .map(({ entry, count }) => ({ name: entry.name, artist: entry.artist, coverUrl: entry.coverUrl, count }))
  return { uniqueSongs: countByKey.size, totalPlays, dayCounts, top }
}

/** 概要（用于简要卡）：本周去重歌曲数 + 总次数 + 最爱一首 */
export function getListeningSummary(): { uniqueSongs: number; totalPlays: number; favorite: { name: string; artist: string; coverUrl: string; count: number } | null } {
  const stats = getListeningStats('week')
  const favorite = stats.top[0]
    ? { name: stats.top[0].name, artist: stats.top[0].artist, coverUrl: stats.top[0].coverUrl, count: stats.top[0].count }
    : null
  return { uniqueSongs: stats.uniqueSongs, totalPlays: stats.totalPlays, favorite }
}
