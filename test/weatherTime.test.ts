import { describe, expect, it } from 'vitest'
import { formatDateInTimezone, localDateParts, localMinutesFromWeatherTime, zonedDateFromLocalString } from '../src/services/weatherTime'

describe('weather timezone helpers', () => {
  it('reads API wall-clock minutes without using the machine timezone', () => {
    expect(localMinutesFromWeatherTime('2026-09-05T23:45')).toBe(1425)
  })

  it('converts a target timezone wall clock into a stable instant', () => {
    const instant = zonedDateFromLocalString('2026-09-05T12:00', 'Asia/Shanghai')
    expect(instant).not.toBeNull()
    expect(localDateParts(instant!, 'Asia/Shanghai')).toMatchObject({ year: 2026, month: 9, day: 5, hour: 12, minute: 0 })
  })

  it('formats refresh timestamps in the weather location timezone', () => {
    const instant = new Date('2026-09-22T06:00:00.000Z')
    const options: Intl.DateTimeFormatOptions = {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }
    expect(formatDateInTimezone(instant, 'Asia/Shanghai', options)).toBe('14:00:00')
    expect(formatDateInTimezone(instant, 'UTC', options)).toBe('06:00:00')
  })
})
