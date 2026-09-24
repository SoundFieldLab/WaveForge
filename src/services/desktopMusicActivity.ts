import type { Song } from './musicApi'
import type { MusicPlatform } from './platforms'

export interface DesktopHistoryEntry {
  song: Song
  playedAt: number
  playCount: number
  listenedSeconds: number
}

export interface DesktopDailyListening {
  date: string
  listenedSeconds: number
  songStarts: number
  platform?: MusicPlatform
}

export interface DesktopMusicActivity {
  history: DesktopHistoryEntry[]
  days: Record<string, DesktopDailyListening>
  lastSongKey: string
  lastStartedAt: number
}

const STORAGE_KEY = 'desktopMusicActivityV1'
export const DESKTOP_MUSIC_ACTIVITY_EVENT = 'desktopMusicActivityChanged'

const emptyActivity = (): DesktopMusicActivity => ({ history: [], days: {}, lastSongKey: '', lastStartedAt: 0 })
const songPlatform = (song: Song): MusicPlatform | null => song.platform || null

// Apple library IDs identify the user-owned item; catalog IDs are the fallback.
const songKey = (song: Song) => {
  const platform = songPlatform(song)
  if (!platform) return `unknown:${song.mid || song.appleLibraryId || song.appleId || song.id || ''}`
  if (platform === 'apple') return `apple:${song.appleLibraryId || song.appleId || (song.id ? String(song.id) : '')}`
  return `${platform}:${song.mid || song.id}`
}
const dayKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const platformDayKey = (platform: MusicPlatform, date: string) => `${platform}:${date}`

/** days 保留窗口：热力图最多展示 40 周，这里留出远超 UI 需求的余量再裁掉更早的日记录，
 *  避免「每个平台每天一条、永不清理」的长会话增长（history 已有 200 条上限，days 此前没有）。 */
const DAYS_RETENTION = 400

function pruneDays(days: Record<string, DesktopDailyListening>): Record<string, DesktopDailyListening> {
  const entries = Object.entries(days)
  if (entries.length <= DAYS_RETENTION) return days
  // 按日期字符串排序（YYYY-MM-DD 可直接字典序比较），保留最近的 DAYS_RETENTION 条
  return Object.fromEntries(
    entries.sort((a, b) => String(a[1]?.date || '').localeCompare(String(b[1]?.date || ''))).slice(-DAYS_RETENTION),
  )
}

export function loadDesktopMusicActivity(): DesktopMusicActivity {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<DesktopMusicActivity> | null
    if (!parsed) return emptyActivity()
    return {
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 200) : [],
      days: parsed.days && typeof parsed.days === 'object' ? pruneDays(parsed.days) : {},
      lastSongKey: typeof parsed.lastSongKey === 'string' ? parsed.lastSongKey : '',
      lastStartedAt: Number(parsed.lastStartedAt) || 0,
    }
  } catch {
    return emptyActivity()
  }
}

export function getDesktopActivityForPlatform(activity: DesktopMusicActivity, platform: MusicPlatform): DesktopMusicActivity {
  const history = activity.history.filter(entry => songPlatform(entry.song) === platform)
  const days = Object.fromEntries(Object.entries(activity.days).filter(([key, day]) => {
    return day.platform === platform || key.startsWith(`${platform}:`)
  }).map(([key, day]) => [key.startsWith(`${platform}:`) ? key.slice(platform.length + 1) : key, { ...day, platform }]))
  return { ...activity, history, days }
}

function save(activity: DesktopMusicActivity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(activity))
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(DESKTOP_MUSIC_ACTIVITY_EVENT, { detail: activity }))
  return activity
}

export function recordDesktopSongStart(song: Song) {
  const platform = songPlatform(song)
  if (!platform) return loadDesktopMusicActivity()
  const activity = loadDesktopMusicActivity()
  const key = songKey(song)
  const now = Date.now()
  if (activity.lastSongKey === key && now - activity.lastStartedAt < 30_000) return activity
  const existing = activity.history.find(entry => songKey(entry.song) === key)
  const nextEntry: DesktopHistoryEntry = existing
    ? { ...existing, song, playedAt: now, playCount: existing.playCount + 1 }
    : { song, playedAt: now, playCount: 1, listenedSeconds: 0 }
  const date = dayKey()
  const keyForDay = platformDayKey(platform, date)
  const currentDay = activity.days[keyForDay] || { date, platform, listenedSeconds: 0, songStarts: 0 }
  return save({
    ...activity,
    history: [nextEntry, ...activity.history.filter(entry => songKey(entry.song) !== key)].slice(0, 200),
    days: { ...activity.days, [keyForDay]: { ...currentDay, platform, songStarts: currentDay.songStarts + 1 } },
    lastSongKey: key,
    lastStartedAt: now,
  })
}

export function addDesktopListeningSeconds(song: Song, seconds: number) {
  const platform = songPlatform(song)
  if (!platform) return loadDesktopMusicActivity()
  const safeSeconds = Math.max(0, Math.min(30, Math.round(seconds)))
  if (!safeSeconds) return loadDesktopMusicActivity()
  const activity = loadDesktopMusicActivity()
  const key = songKey(song)
  const date = dayKey()
  const keyForDay = platformDayKey(platform, date)
  const currentDay = activity.days[keyForDay] || { date, platform, listenedSeconds: 0, songStarts: 0 }
  const history = activity.history.map(entry => songKey(entry.song) === key
    ? { ...entry, listenedSeconds: entry.listenedSeconds + safeSeconds }
    : entry)
  return save({
    ...activity,
    history,
    days: { ...activity.days, [keyForDay]: { ...currentDay, platform, listenedSeconds: currentDay.listenedSeconds + safeSeconds } },
  })
}

export function clearDesktopMusicActivity(platform?: MusicPlatform) {
  if (!platform) return save(emptyActivity())
  const activity = loadDesktopMusicActivity()
  const prefix = `${platform}:`
  const history = activity.history.filter(entry => songPlatform(entry.song) !== platform)
  const days = Object.fromEntries(Object.entries(activity.days).filter(([key, day]) => day.platform !== platform && !key.startsWith(prefix)))
  return save({
    history,
    days,
    lastSongKey: activity.lastSongKey.startsWith(prefix) ? '' : activity.lastSongKey,
    lastStartedAt: activity.lastSongKey.startsWith(prefix) ? 0 : activity.lastStartedAt,
  })
}

export function getDesktopSongKey(song: Song) {
  return songKey(song)
}
