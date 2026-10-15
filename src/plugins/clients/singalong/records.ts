/**
 * 学歌 · 练习记录（纯 localStorage，按歌曲持久化）。
 *
 * 记三样：
 *   1. 整曲最佳成绩 + 练习次数 + 最近练习时间（曲库页排序/展示用）；
 *   2. 每句最佳分（跟唱模式的逐句 PB，歌词列表上显示历史最好成绩）；
 *   3. 最近练过的歌（最多 12 首，学歌首页「继续练」入口）。
 *
 * 键位设计：
 *   wf_singalong_records            → { [songKey]: SongRecord }
 *   wf_singalong_recent             → songKey[]（新的在前）
 */

export interface LineRecord {
  /** 该句历史最佳总分（0-100）。 */
  best: number
  /** 最佳成绩下的音准分。 */
  pitch?: number
  /** 最佳成绩下的节奏分。 */
  rhythm?: number
  /** 达到最佳成绩的时间戳。 */
  at: number
}

export interface SongRecord {
  /** 整曲最佳总分。 */
  bestTotal: number
  bestPitch?: number
  bestRhythm?: number
  /** 练习次数：每次「唱完至少一句并切歌/结算整曲」记一次。 */
  practiceCount: number
  /** 最近练习时间。 */
  lastAt: number
  /** 逐句最佳。 */
  lines: Record<string, LineRecord>
}

const RECORDS_KEY = 'wf_singalong_records'
const RECENT_KEY = 'wf_singalong_recent'
const RECENT_MAX = 12

function readRecords(): Record<string, SongRecord> {
  try {
    const raw = localStorage.getItem(RECORDS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeRecords(records: Record<string, SongRecord>) {
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(records))
  } catch {
    /* 存储不可用时静默 */
  }
  try { window.dispatchEvent(new Event('waveforge:singalong-records')) } catch { /* 非 DOM 环境（单测）忽略 */ }
}

export function getSongRecord(songKey: string): SongRecord | null {
  return readRecords()[songKey] || null
}

/** 某句的历史最佳（无记录返回 null）。 */
export function getLineBest(songKey: string, lineTime: number): LineRecord | null {
  return readRecords()[songKey]?.lines?.[String(lineTime)] || null
}

/**
 * 记录一行成绩：只有超过该句历史最佳才写入。
 * 返回是否刷新了 PB（用于「新纪录」动效）。
 */
export function recordLineScore(songKey: string, lineTime: number, score: { total: number; pitch: number; rhythm: number }): boolean {
  if (!songKey || score.total <= 0) return false
  const records = readRecords()
  const record = records[songKey] || { bestTotal: 0, practiceCount: 0, lastAt: 0, lines: {} }
  const key = String(lineTime)
  const existing = record.lines[key]
  if (existing && existing.best >= score.total) {
    record.lines[key] = existing
    records[songKey] = record
    writeRecords(records)
    return false
  }
  record.lines[key] = { best: score.total, pitch: score.pitch, rhythm: score.rhythm, at: Date.now() }
  records[songKey] = record
  writeRecords(records)
  return true
}

/**
 * 结算整曲：整曲最佳取「本次完成句的加权平均」与历史最佳的最大值；
 * practiceCount 每次 +1；写最近练习。
 * 返回是否刷新整曲 PB。
 */
export function recordSongAttempt(
  songKey: string,
  summary: { total: number; pitch: number; rhythm: number },
  sungLines: number,
): boolean {
  if (!songKey || sungLines <= 0) return false
  const records = readRecords()
  const record = records[songKey] || { bestTotal: 0, practiceCount: 0, lastAt: 0, lines: {} }
  let newBest = false
  if (summary.total > record.bestTotal) {
    record.bestTotal = summary.total
    record.bestPitch = summary.pitch
    record.bestRhythm = summary.rhythm
    newBest = true
  }
  record.practiceCount += 1
  record.lastAt = Date.now()
  records[songKey] = record
  writeRecords(records)
  pushRecent(songKey)
  return newBest
}

/* ------------------------------ 最近练习 ------------------------------ */

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((key: unknown): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

function pushRecent(songKey: string) {
  if (!songKey) return
  const recent = readRecent().filter(key => key !== songKey)
  recent.unshift(songKey)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)))
  } catch {
    /* ignore */
  }
  try { window.dispatchEvent(new Event('waveforge:singalong-records')) } catch { /* 非 DOM 环境忽略 */ }
}

export function getRecentSongKeys(): string[] {
  return readRecent()
}

/** 全部记录（练习曲库页用），按最近练习倒序。 */
export function getAllSongRecords(): Array<{ songKey: string; record: SongRecord }> {
  return Object.entries(readRecords())
    .map(([songKey, record]) => ({ songKey, record }))
    .sort((a, b) => b.record.lastAt - a.record.lastAt)
}

/** 删除一首歌的记录（练习曲库页的单条删除）。 */
export function removeSongRecord(songKey: string) {
  const records = readRecords()
  delete records[songKey]
  writeRecords(records)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(readRecent().filter(key => key !== songKey)))
  } catch {
    /* ignore */
  }
}
