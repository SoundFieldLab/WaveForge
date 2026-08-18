import type { Song } from './musicApi'

export interface NeteaseJourneySong extends Song {
  rank?: number
  playCount?: number
  score?: number
}

export interface NeteaseJourneyPart {
  available: boolean
  error?: string
  data?: any
}

export interface NeteaseJourneyOverview {
  code: number
  uid: string
  rank: NeteaseJourneyPart & { songs: NeteaseJourneySong[] }
  report: NeteaseJourneyPart & {
    total?: any
    period?: any
    monthlyRank?: any
    todayRank?: any
    monthlySongs: NeteaseJourneySong[]
    todaySongs: NeteaseJourneySong[]
  }
  preference: NeteaseJourneyPart
  archive: NeteaseJourneyPart & { level?: any; subcount?: any }
}

export async function fetchNeteaseJourneyOverview(
  uid: string,
  cookie: string,
  signal?: AbortSignal,
): Promise<NeteaseJourneyOverview> {
  const response = await fetch(
    `http://localhost:3001/api/netease/journey/overview?uid=${encodeURIComponent(uid)}&cookie=${encodeURIComponent(cookie)}`,
    { signal },
  )
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body?.error || '网易云音乐旅程加载失败')
  return body as NeteaseJourneyOverview
}
