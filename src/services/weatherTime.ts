export function localDateParts(date: Date, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date)
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    }
  } catch {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    }
  }
}

/** Convert an API local wall-clock value (without an offset) into an instant. */
export function zonedDateFromLocalString(value: string, timeZone?: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(value)
  if (!match) return null
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number)
  const second = match[6] ? Number(match[6]) : 0
  const wallClockUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  if (!timeZone) return new Date(wallClockUtc)

  const offsetAt = (instant: number) => {
    const parts = localDateParts(new Date(instant), timeZone)
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - instant
  }
  const firstOffset = offsetAt(wallClockUtc)
  const candidate = wallClockUtc - firstOffset
  const correctedOffset = offsetAt(candidate)
  return new Date(wallClockUtc - correctedOffset)
}

export const localMinutesFromWeatherTime = (value: string) => {
  // 上游只给日期（"2026-09-24"）时 slice(11,13) 得空串，而 Number('') === 0 且通过 isFinite，
  // 会让日出日落被当成 00:00（昼夜与天空体位置全错）。先要求长度够到 HH:MM 再解析。
  if (typeof value !== 'string' || value.length < 16) return null
  const hour = Number(value.slice(11, 13))
  const minute = Number(value.slice(14, 16))
  return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null
}

export function formatDateInTimezone(date: Date, timeZone?: string, options: Intl.DateTimeFormatOptions = {}) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { ...options, timeZone: timeZone || undefined }).format(date)
  } catch {
    return new Intl.DateTimeFormat('zh-CN', options).format(date)
  }
}

export function formatWeatherLocalDateTime(value: string, timeZone?: string, options: Intl.DateTimeFormatOptions = {}) {
  const date = zonedDateFromLocalString(value, timeZone)
  return date ? formatDateInTimezone(date, timeZone, options) : value
}
