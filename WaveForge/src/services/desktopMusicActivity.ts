import type { Song } from './musicApi'

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
}

interface DesktopMusicActivity {
  history: DesktopHistoryEntry[]
  days: Record<string, DesktopDailyListening>
  lastSongKey: string
  lastStartedAt: number
}

const STORAGE_KEY = 'desktopMusicActivityV1'
export const DESKTOP_MUSIC_ACTIVITY_EVENT = 'desktopMusicActivityChanged'

const emptyActivity = (): DesktopMusicActivity => ({ history: [], days: {}, lastSongKey: '', lastStartedAt: 0 })
const songKey = (song: Song) => `${song.platform || 'netease'}:${song.mid || song.id}`
const dayKey = (date = new Date()) => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function loadDesktopMusicActivity(): DesktopMusicActivity {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<DesktopMusicActivity> | null
    if (!parsed) return emptyActivity()
    return {
      history: Array.isArray(parsed.history) ? parsed.history.slice(0, 200) : [],
      days: parsed.days && typeof parsed.days === 'object' ? parsed.days : {},
      lastSongKey: typeof parsed.lastSongKey === 'string' ? parsed.lastSongKey : '',
      lastStartedAt: Number(parsed.lastStartedAt) || 0,
    }
  } catch {
    return emptyActivity()
  }
}

function save(activity: DesktopMusicActivity) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(activity))
  window.dispatchEvent(new CustomEvent(DESKTOP_MUSIC_ACTIVITY_EVENT, { detail: activity }))
  return activity
}

export function recordDesktopSongStart(song: Song) {
  const activity = loadDesktopMusicActivity()
  const key = songKey(song)
  const now = Date.now()
  // React 状态抖动或模式切换不会被误记成再次播放。
  if (activity.lastSongKey === key && now - activity.lastStartedAt < 30_000) return activity
  const existing = activity.history.find(entry => songKey(entry.song) === key)
  const nextEntry: DesktopHistoryEntry = existing
    ? { ...existing, song, playedAt: now, playCount: existing.playCount + 1 }
    : { song, playedAt: now, playCount: 1, listenedSeconds: 0 }
  const today = dayKey()
  const currentDay = activity.days[today] || { date: today, listenedSeconds: 0, songStarts: 0 }
  return save({
    ...activity,
    history: [nextEntry, ...activity.history.filter(entry => songKey(entry.song) !== key)].slice(0, 200),
    days: { ...activity.days, [today]: { ...currentDay, songStarts: currentDay.songStarts + 1 } },
    lastSongKey: key,
    lastStartedAt: now,
  })
}

export function addDesktopListeningSeconds(song: Song, seconds: number) {
  const safeSeconds = Math.max(0, Math.min(30, Math.round(seconds)))
  if (!safeSeconds) return loadDesktopMusicActivity()
  const activity = loadDesktopMusicActivity()
  const key = songKey(song)
  const today = dayKey()
  const currentDay = activity.days[today] || { date: today, listenedSeconds: 0, songStarts: 0 }
  const history = activity.history.map(entry => songKey(entry.song) === key
    ? { ...entry, listenedSeconds: entry.listenedSeconds + safeSeconds }
    : entry)
  return save({
    ...activity,
    history,
    days: { ...activity.days, [today]: { ...currentDay, listenedSeconds: currentDay.listenedSeconds + safeSeconds } },
  })
}

export function clearDesktopMusicActivity() {
  return save(emptyActivity())
}

export function getDesktopSongKey(song: Song) {
  return songKey(song)
}
