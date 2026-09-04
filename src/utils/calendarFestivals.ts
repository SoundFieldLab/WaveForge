export interface CalendarFestival {
  name: string
  kind: 'holiday' | 'traditional' | 'observance'
}

const SOLAR_FESTIVALS: Record<string, CalendarFestival> = {
  '1-1': { name: '元旦', kind: 'holiday' },
  '2-14': { name: '情人节', kind: 'observance' },
  '3-8': { name: '妇女节', kind: 'observance' },
  '3-12': { name: '植树节', kind: 'observance' },
  '4-4': { name: '清明节', kind: 'traditional' },
  '5-1': { name: '劳动节', kind: 'holiday' },
  '5-4': { name: '青年节', kind: 'observance' },
  '6-1': { name: '儿童节', kind: 'observance' },
  '7-1': { name: '建党节', kind: 'observance' },
  '8-1': { name: '建军节', kind: 'observance' },
  '9-10': { name: '教师节', kind: 'observance' },
  '10-1': { name: '国庆节', kind: 'holiday' },
  '12-24': { name: '平安夜', kind: 'observance' },
  '12-25': { name: '圣诞节', kind: 'observance' },
  '12-31': { name: '跨年夜', kind: 'observance' },
}

const LUNAR_FESTIVALS: Record<string, CalendarFestival> = {
  '正-1': { name: '春节', kind: 'traditional' },
  '正-15': { name: '元宵节', kind: 'traditional' },
  '五-5': { name: '端午节', kind: 'traditional' },
  '七-7': { name: '七夕', kind: 'traditional' },
  '八-15': { name: '中秋节', kind: 'traditional' },
  '九-9': { name: '重阳节', kind: 'traditional' },
  '腊-8': { name: '腊八节', kind: 'traditional' },
}

const chineseCalendar = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
  month: 'long',
  day: 'numeric',
})

const getLunarParts = (date: Date) => {
  const parts = chineseCalendar.formatToParts(date)
  const month = parts.find(part => part.type === 'month')?.value.replace('月', '') || ''
  const day = Number(parts.find(part => part.type === 'day')?.value || 0)
  const leap = month.includes('闰')
  return { month: month.replace('闰', ''), day, leap }
}

const isNthWeekday = (date: Date, weekday: number, occurrence: number) => {
  if (date.getDay() !== weekday) return false
  return Math.ceil(date.getDate() / 7) === occurrence
}

export const getCalendarFestivals = (date: Date): CalendarFestival[] => {
  const festivals: CalendarFestival[] = []
  const solar = SOLAR_FESTIVALS[`${date.getMonth() + 1}-${date.getDate()}`]
  if (solar) festivals.push(solar)

  if (date.getMonth() === 4 && isNthWeekday(date, 0, 2)) {
    festivals.push({ name: '母亲节', kind: 'observance' })
  }
  if (date.getMonth() === 5 && isNthWeekday(date, 0, 3)) {
    festivals.push({ name: '父亲节', kind: 'observance' })
  }
  if (date.getMonth() === 10 && isNthWeekday(date, 4, 4)) {
    festivals.push({ name: '感恩节', kind: 'observance' })
  }

  try {
    const lunar = getLunarParts(date)
    if (!lunar.leap) {
      const traditional = LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`]
      if (traditional) festivals.push(traditional)
    }
    const tomorrow = new Date(date)
    tomorrow.setDate(date.getDate() + 1)
    const nextLunar = getLunarParts(tomorrow)
    if (nextLunar.month === '正' && nextLunar.day === 1) {
      festivals.push({ name: '除夕', kind: 'traditional' })
    }
  } catch {
    // Some older embedded Chromium builds do not expose the Chinese calendar.
  }

  return festivals
}

export const getLunarDateLabel = (date: Date) => {
  try {
    return chineseCalendar.format(date)
  } catch {
    return ''
  }
}
