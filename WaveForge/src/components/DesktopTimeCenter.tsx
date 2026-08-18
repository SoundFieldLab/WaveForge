import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlarmClock,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock3,
  Globe2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  TimerReset,
  Trash2,
  X,
} from 'lucide-react'
import { useDesktopFocusTimer } from '../hooks/useDesktopFocusTimer'
import { getCalendarFestivals, getLunarDateLabel } from '../utils/calendarFestivals'

interface DesktopTimeCenterProps {
  open: boolean
  onClose: () => void
  accentColor: string
  initialTab?: TimeCenterTab
}

type TimeCenterTab = 'calendar' | 'world' | 'focus'

interface WorldCity {
  id: string
  name: string
  country: string
  timeZone: string
  x: number
  y: number
}

interface WorldMapData {
  viewBox: string
  locations: Array<{ id: string; name: string; path: string }>
}

const WORLD_CITIES: WorldCity[] = [
  { id: 'shanghai', name: '上海', country: '中国', timeZone: 'Asia/Shanghai', x: 83.6, y: 53.7 },
  { id: 'beijing', name: '北京', country: '中国', timeZone: 'Asia/Shanghai', x: 82.5, y: 50.5 },
  { id: 'tokyo', name: '东京', country: '日本', timeZone: 'Asia/Tokyo', x: 88.6, y: 52.1 },
  { id: 'seoul', name: '首尔', country: '韩国', timeZone: 'Asia/Seoul', x: 85.2, y: 51.2 },
  { id: 'singapore', name: '新加坡', country: '新加坡', timeZone: 'Asia/Singapore', x: 78.7, y: 64.1 },
  { id: 'delhi', name: '新德里', country: '印度', timeZone: 'Asia/Kolkata', x: 71.3, y: 54.4 },
  { id: 'dubai', name: '迪拜', country: '阿联酋', timeZone: 'Asia/Dubai', x: 65.4, y: 55.9 },
  { id: 'london', name: '伦敦', country: '英国', timeZone: 'Europe/London', x: 49.9, y: 46.4 },
  { id: 'paris', name: '巴黎', country: '法国', timeZone: 'Europe/Paris', x: 50.6, y: 47.3 },
  { id: 'moscow', name: '莫斯科', country: '俄罗斯', timeZone: 'Europe/Moscow', x: 60.4, y: 45.0 },
  { id: 'cairo', name: '开罗', country: '埃及', timeZone: 'Africa/Cairo', x: 58.6, y: 54.1 },
  { id: 'johannesburg', name: '约翰内斯堡', country: '南非', timeZone: 'Africa/Johannesburg', x: 57.7, y: 73.8 },
  { id: 'new-york', name: '纽约', country: '美国', timeZone: 'America/New_York', x: 29.4, y: 50.3 },
  { id: 'los-angeles', name: '洛杉矶', country: '美国', timeZone: 'America/Los_Angeles', x: 17.3, y: 52.6 },
  { id: 'vancouver', name: '温哥华', country: '加拿大', timeZone: 'America/Vancouver', x: 15.8, y: 47.2 },
  { id: 'mexico-city', name: '墨西哥城', country: '墨西哥', timeZone: 'America/Mexico_City', x: 22.6, y: 57.8 },
  { id: 'sao-paulo', name: '圣保罗', country: '巴西', timeZone: 'America/Sao_Paulo', x: 37.2, y: 73.1 },
  { id: 'honolulu', name: '檀香山', country: '美国', timeZone: 'Pacific/Honolulu', x: 6.3, y: 57.1 },
  { id: 'sydney', name: '悉尼', country: '澳大利亚', timeZone: 'Australia/Sydney', x: 91.9, y: 76.6 },
]

const WORLD_CLOCK_STORAGE_KEY = 'desktopWorldClockCities'
const FOCUS_TIMER_DRAFT_STORAGE_KEY = 'desktopFocusTimerDraft'

const PRECISE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
const PRECISE_DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
})

const getZonedParts = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value || 0)
  return { hour: number('hour') % 24, minute: number('minute'), second: number('second') }
}

const formatRemaining = (remainingMs: number) => {
  const seconds = Math.ceil(remainingMs / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${rest.toString().padStart(2, '0')}`
}

function AnalogClock({ city, now, accentColor }: { city: WorldCity; now: Date; accentColor: string }) {
  const time = getZonedParts(now, city.timeZone)
  const hourAngle = ((time.hour % 12) + time.minute / 60) * 30
  const minuteAngle = (time.minute + time.second / 60) * 6
  const secondAngle = time.second * 6
  const isDay = time.hour >= 6 && time.hour < 18

  return (
    <div
      className="relative h-20 w-20 shrink-0 rounded-full border shadow-inner"
      style={{
        borderColor: isDay ? 'rgba(255,255,255,0.48)' : 'rgba(255,255,255,0.2)',
        background: isDay ? 'linear-gradient(145deg, #f8fafc, #cbd5e1)' : 'linear-gradient(145deg, #111827, #020617)',
      }}
      aria-label={`${city.name}模拟时钟`}
    >
      {[0, 3, 6, 9].map(index => (
        <span
          key={index}
          className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full"
          style={{
            background: isDay ? '#334155' : 'rgba(255,255,255,0.72)',
            transform: `translate(-50%, -50%) rotate(${index * 90}deg) translateY(-31px)`,
          }}
        />
      ))}
      <span
        className="absolute bottom-1/2 left-1/2 h-[22px] w-[3px] origin-bottom rounded-full"
        style={{ background: isDay ? '#0f172a' : '#f8fafc', transform: `translateX(-50%) rotate(${hourAngle}deg)` }}
      />
      <span
        className="absolute bottom-1/2 left-1/2 h-[29px] w-[2px] origin-bottom rounded-full"
        style={{ background: isDay ? '#334155' : '#cbd5e1', transform: `translateX(-50%) rotate(${minuteAngle}deg)` }}
      />
      <span
        className="absolute bottom-1/2 left-1/2 h-[31px] w-px origin-bottom"
        style={{ background: accentColor, transform: `translateX(-50%) rotate(${secondAngle}deg)` }}
      />
      <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: accentColor }} />
    </div>
  )
}

function PreciseClock() {
  const initialNow = useMemo(() => new Date(), [])
  const timeRef = useRef<HTMLSpanElement>(null)
  const millisecondsRef = useRef<HTMLSpanElement>(null)
  const dateRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let previousSecond = -1
    let previousDateKey = ''
    let previousMilliseconds = ''

    const updateClock = () => {
      const now = new Date()
      const milliseconds = `.${now.getMilliseconds().toString().padStart(3, '0')}`

      if (milliseconds !== previousMilliseconds && millisecondsRef.current) {
        millisecondsRef.current.textContent = milliseconds
        previousMilliseconds = milliseconds
      }

      const second = Math.floor(now.getTime() / 1000)
      if (second === previousSecond) return
      previousSecond = second
      if (timeRef.current) timeRef.current.textContent = PRECISE_TIME_FORMATTER.format(now)

      const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`
      if (dateKey !== previousDateKey && dateRef.current) {
        dateRef.current.textContent = PRECISE_DATE_FORMATTER.format(now)
        previousDateKey = dateKey
      }
    }

    let animationFrame: number | null = null
    let lastUpdate = 0

    const frameLoop = (timestamp: number) => {
      if (timestamp - lastUpdate >= 30) {
        lastUpdate = timestamp
        updateClock()
      }
      animationFrame = window.requestAnimationFrame(frameLoop)
    }

    const stop = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
        animationFrame = null
      }
    }
    const start = () => {
      if (document.visibilityState !== 'visible' || animationFrame !== null) return
      updateClock()
      animationFrame = window.requestAnimationFrame(frameLoop)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    start()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  return (
    <div className="min-w-[255px]">
      <div className="flex items-baseline gap-2 text-white">
        <span ref={timeRef} className="text-[2.2rem] font-semibold leading-none tracking-[-0.05em] tabular-nums">{PRECISE_TIME_FORMATTER.format(initialNow)}</span>
        <span ref={millisecondsRef} className="text-lg tabular-nums text-white/38">.{initialNow.getMilliseconds().toString().padStart(3, '0')}</span>
      </div>
      <div ref={dateRef} className="mt-2 text-xs tracking-[0.12em] text-white/38">{PRECISE_DATE_FORMATTER.format(initialNow)}</div>
    </div>
  )
}

function MonthCalendar({ accentColor }: { accentColor: string }) {
  const today = useMemo(() => new Date(), [])
  const [visibleMonth, setVisibleMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1))
  const [selectedDate, setSelectedDate] = useState(today)
  const days = useMemo(() => {
    const start = new Date(visibleMonth)
    start.setDate(1 - start.getDay())
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start)
      date.setDate(start.getDate() + index)
      return date
    })
  }, [visibleMonth])
  const selectedFestivals = getCalendarFestivals(selectedDate)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_240px] gap-5">
      <div className="min-h-0 rounded-[26px] border border-white/10 bg-white/[0.045] p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-xl font-semibold text-white">{visibleMonth.getFullYear()} 年 {visibleMonth.getMonth() + 1} 月</div>
            <div className="mt-1 text-xs text-white/40">完整月历 · 公历与传统节日</div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setVisibleMonth(new Date(today.getFullYear(), today.getMonth(), 1))} className="rounded-full border border-white/10 px-3 py-2 text-xs text-white/65 hover:bg-white/10">今天</button>
            <button type="button" aria-label="上个月" onClick={() => setVisibleMonth(value => new Date(value.getFullYear(), value.getMonth() - 1, 1))} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-white/70 hover:bg-white/10"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" aria-label="下个月" onClick={() => setVisibleMonth(value => new Date(value.getFullYear(), value.getMonth() + 1, 1))} className="flex h-9 w-9 items-center justify-center rounded-full border border-white/10 text-white/70 hover:bg-white/10"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-medium text-white/38">
          {'日一二三四五六'.split('').map(day => <div key={day} className="py-1">周{day}</div>)}
        </div>
        <div className="mt-1 grid grid-cols-7 gap-1.5">
          {days.map(date => {
            const activeMonth = date.getMonth() === visibleMonth.getMonth()
            const isToday = date.toDateString() === today.toDateString()
            const selected = date.toDateString() === selectedDate.toDateString()
            const festivals = getCalendarFestivals(date)
            return (
              <button
                key={`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`}
                type="button"
                onClick={() => setSelectedDate(date)}
                className="relative h-[68px] overflow-hidden rounded-2xl border p-2 text-left transition hover:bg-white/10"
                style={{
                  borderColor: selected ? accentColor : isToday ? `${accentColor}88` : 'rgba(255,255,255,0.06)',
                  background: selected ? `${accentColor}42` : isToday ? `${accentColor}18` : 'rgba(255,255,255,0.025)',
                  opacity: activeMonth ? 1 : 0.34,
                }}
              >
                <span className="text-sm font-semibold tabular-nums text-white/88">{date.getDate()}</span>
                {festivals[0] && <span className="mt-2 block truncate text-[10px] font-medium" style={{ color: festivals[0].kind === 'holiday' ? '#fda4af' : '#fde68a' }}>{festivals[0].name}</span>}
                {isToday && <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full" style={{ background: accentColor, boxShadow: `0 0 8px ${accentColor}` }} />}
              </button>
            )
          })}
        </div>
      </div>
      <aside className="flex flex-col rounded-[26px] border border-white/10 bg-white/[0.045] p-5">
        <div className="text-sm text-white/42">选中日期</div>
        <div className="mt-3 text-5xl font-semibold tracking-[-0.06em] text-white">{selectedDate.getDate()}</div>
        <div className="mt-2 text-sm text-white/72">{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', weekday: 'long' }).format(selectedDate)}</div>
        <div className="mt-2 text-xs text-white/40">农历 {getLunarDateLabel(selectedDate)}</div>
        <div className="my-5 h-px bg-white/10" />
        <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/35">节日与纪念日</div>
        <div className="mt-3 space-y-2">
          {selectedFestivals.length > 0 ? selectedFestivals.map(festival => (
            <div key={festival.name} className="rounded-2xl border border-white/8 bg-white/5 px-3 py-3 text-sm text-white/80">
              <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: festival.kind === 'holiday' ? '#fb7185' : '#fbbf24' }} />
              {festival.name}
            </div>
          )) : <div className="rounded-2xl border border-dashed border-white/10 px-3 py-5 text-center text-xs text-white/30">这一天暂无特殊节日</div>}
        </div>
      </aside>
    </div>
  )
}

function WorldClock({ accentColor, now }: { accentColor: string; now: Date }) {
  const [worldMap, setWorldMap] = useState<WorldMapData | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(WORLD_CLOCK_STORAGE_KEY) || '[]')
      return Array.isArray(saved) && saved.length ? saved : ['shanghai', 'london', 'new-york', 'tokyo']
    } catch {
      return ['shanghai', 'london', 'new-york', 'tokyo']
    }
  })
  const [showPicker, setShowPicker] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let active = true
    import('@svg-maps/world').then(module => {
      if (active) setWorldMap(module.default as WorldMapData)
    })
    return () => {
      active = false
    }
  }, [])

  const selectedCities = selectedIds.map(id => WORLD_CITIES.find(city => city.id === id)).filter(Boolean) as WorldCity[]
  const availableCities = WORLD_CITIES.filter(city => !selectedIds.includes(city.id) && `${city.name}${city.country}`.toLowerCase().includes(query.toLowerCase()))
  const updateSelection = (ids: string[]) => {
    setSelectedIds(ids)
    localStorage.setItem(WORLD_CLOCK_STORAGE_KEY, JSON.stringify(ids))
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto pr-1 custom-scrollbar">
      <div className="relative h-[300px] overflow-hidden rounded-[28px] border border-white/10 bg-[#07101c]">
        <div className="absolute inset-0 opacity-80" style={{ background: 'radial-gradient(circle at 78% 45%, rgba(56,189,248,.15), transparent 30%), linear-gradient(90deg, rgba(2,6,23,.9), rgba(15,23,42,.45), rgba(2,6,23,.9))' }} />
        <svg aria-hidden="true" viewBox={worldMap?.viewBox || '0 0 1010 666'} preserveAspectRatio="none" className="absolute inset-0 h-full w-full text-slate-300/28">
          <g fill="currentColor" stroke="rgba(186,207,235,.2)" strokeWidth="0.65" vectorEffect="non-scaling-stroke">
            {worldMap?.locations.map(country => <path key={country.id} d={country.path} />)}
          </g>
          {[168, 336, 505, 673, 842].map(x => <line key={x} x1={x} x2={x} y1="0" y2="666" stroke="rgba(148,163,184,.08)" strokeWidth="0.75" vectorEffect="non-scaling-stroke" />)}
        </svg>
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/55 via-transparent to-amber-400/[0.04]" />
        {selectedCities.map(city => {
          const time = getZonedParts(now, city.timeZone)
          const isDay = time.hour >= 6 && time.hour < 18
          return (
            <div key={city.id} className="absolute -translate-x-1/2 -translate-y-1/2" style={{ left: `${city.x}%`, top: `${city.y}%` }}>
              <div className="relative flex flex-col items-center">
                <span className="h-3 w-3 rounded-full border-2 border-white/75" style={{ background: isDay ? '#fbbf24' : '#818cf8', boxShadow: `0 0 18px ${isDay ? '#fbbf24' : '#818cf8'}` }} />
                <span className="mt-1 whitespace-nowrap rounded-full bg-slate-950/75 px-2 py-1 text-[10px] text-white/80 backdrop-blur-md">{city.name} {time.hour.toString().padStart(2, '0')}:{time.minute.toString().padStart(2, '0')}</span>
              </div>
            </div>
          )
        })}
        <div className="absolute left-5 top-5">
          <div className="flex items-center gap-2 text-sm font-medium text-white"><Globe2 className="h-4 w-4" style={{ color: accentColor }} />世界时钟地图</div>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between">
        <div><div className="font-medium text-white">已添加城市</div><div className="mt-1 text-xs text-white/38">最多显示 8 个世界时钟</div></div>
        <button type="button" onClick={() => setShowPicker(true)} disabled={selectedIds.length >= 8} className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-35" style={{ background: accentColor, boxShadow: `0 8px 24px ${accentColor}35` }}><Plus className="h-4 w-4" />添加城市</button>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {selectedCities.map(city => (
          <div key={city.id} className="group flex items-center gap-4 rounded-[24px] border border-white/10 bg-white/[0.045] p-4">
            <AnalogClock city={city} now={now} accentColor={accentColor} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2"><div className="truncate font-semibold text-white">{city.name}</div><button type="button" aria-label={`移除${city.name}`} onClick={() => updateSelection(selectedIds.filter(id => id !== city.id))} className="flex h-7 w-7 items-center justify-center rounded-full text-white/0 transition group-hover:bg-white/10 group-hover:text-white/55"><Trash2 className="h-3.5 w-3.5" /></button></div>
              <div className="mt-1 text-xs text-white/38">{city.country}</div>
              <div className="mt-2 text-xl font-semibold tabular-nums text-white/85">{new Intl.DateTimeFormat('zh-CN', { timeZone: city.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)}</div>
            </div>
          </div>
        ))}
      </div>
      <AnimatePresence>
        {showPicker && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[430] flex items-center justify-center bg-black/65 p-8 backdrop-blur-md" onMouseDown={event => event.target === event.currentTarget && setShowPicker(false)}>
            <motion.div initial={{ y: 18, scale: .97 }} animate={{ y: 0, scale: 1 }} exit={{ y: 18, scale: .97 }} className="w-full max-w-lg rounded-[28px] border border-white/12 bg-slate-950/95 p-5 shadow-2xl">
              <div className="flex items-center justify-between"><div><div className="text-lg font-semibold text-white">添加世界时钟</div><div className="mt-1 text-xs text-white/38">选择城市后会立即显示在地图上</div></div><button type="button" onClick={() => setShowPicker(false)} className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-white/65"><X className="h-4 w-4" /></button></div>
              <div className="mt-4 flex items-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-3"><Search className="h-4 w-4 text-white/35" /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索城市或国家" className="h-11 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/25" /></div>
              <div className="mt-3 grid max-h-[330px] grid-cols-2 gap-2 overflow-y-auto custom-scrollbar">
                {availableCities.map(city => <button key={city.id} type="button" onClick={() => { updateSelection([...selectedIds, city.id]); setShowPicker(false); setQuery('') }} className="rounded-2xl border border-white/8 bg-white/[0.04] p-3 text-left transition hover:border-white/20 hover:bg-white/10"><div className="text-sm font-medium text-white">{city.name}</div><div className="mt-1 text-xs text-white/35">{city.country}</div></button>)}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function DurationNumberField({
  label,
  value,
  max,
  disabled,
  accentColor,
  onChange,
}: {
  label: string
  value: number
  max: number
  disabled: boolean
  accentColor: string
  onChange: (value: number) => void
}) {
  const updateValue = (nextValue: number) => {
    if (disabled) return
    onChange(Math.max(0, Math.min(max, Math.round(nextValue || 0))))
  }

  return (
    <div className="relative rounded-2xl border border-white/10 bg-black/15 p-3 pr-12 transition focus-within:border-white/25 focus-within:bg-white/[0.035]">
      <label className="block">
        <span className="text-xs text-white/38">{label}</span>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          max={max}
          value={value}
          onChange={event => updateValue(Number(event.target.value))}
          disabled={disabled}
          className="mt-1 w-full bg-transparent text-3xl font-semibold tabular-nums text-white outline-none [appearance:textfield] disabled:opacity-40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
      </label>
      <div className="absolute bottom-2.5 right-2.5 top-2.5 grid w-8 grid-rows-2 overflow-hidden rounded-xl border border-white/10 bg-white/[0.055] shadow-inner">
        <button
          type="button"
          aria-label={`增加${label}`}
          disabled={disabled || value >= max}
          onClick={() => updateValue(value + 1)}
          className="flex items-center justify-center border-b border-white/8 text-white/45 transition hover:bg-white/10 hover:text-white disabled:opacity-20"
          style={{ color: value < max ? accentColor : undefined }}
        >
          <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
        <button
          type="button"
          aria-label={`减少${label}`}
          disabled={disabled || value <= 0}
          onClick={() => updateValue(value - 1)}
          className="flex items-center justify-center text-white/45 transition hover:bg-white/10 hover:text-white disabled:opacity-20"
          style={{ color: value > 0 ? accentColor : undefined }}
        >
          <ChevronDown className="h-3.5 w-3.5" strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}

function FocusTimer({ accentColor }: { accentColor: string }) {
  const { timer, remainingMs, start, pause, resume, stop } = useDesktopFocusTimer()
  const [taskLabel, setTaskLabel] = useState(() => timer.label || '')
  const [sessionGoal, setSessionGoal] = useState(() => timer.sessionGoal || 4)
  const [durationDraft, setDurationDraft] = useState(() => {
    try {
      const savedDraft = JSON.parse(localStorage.getItem(FOCUS_TIMER_DRAFT_STORAGE_KEY) || 'null') as { hours?: number; minutes?: number } | null
      return {
        hours: Math.max(0, Math.min(23, Math.round(savedDraft?.hours ?? 0))),
        minutes: Math.max(0, Math.min(59, Math.round(savedDraft?.minutes ?? 25))),
      }
    } catch {
      return { hours: 0, minutes: 25 }
    }
  })
  const { hours, minutes } = durationDraft
  const active = timer.status === 'running' || timer.status === 'paused'
  const progress = timer.durationMs > 0 ? Math.min(100, ((timer.durationMs - remainingMs) / timer.durationMs) * 100) : 0
  const startConfiguredTimer = () => start((Math.max(0, hours) * 60 + Math.max(0, minutes)) * 60 * 1000, { label: taskLabel.trim(), phase: 'focus', sessionGoal })
  const startBreak = () => {
    const longBreak = timer.completedSessions > 0 && timer.completedSessions % sessionGoal === 0
    start((longBreak ? 15 : 5) * 60 * 1000, { label: longBreak ? '长休息' : '短休息', phase: longBreak ? 'longBreak' : 'shortBreak', sessionGoal })
  }

  useEffect(() => {
    localStorage.setItem(FOCUS_TIMER_DRAFT_STORAGE_KEY, JSON.stringify(durationDraft))
  }, [durationDraft])

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] gap-5">
      <div className="flex min-h-[430px] flex-col items-center justify-center rounded-[30px] border border-white/10 bg-white/[0.045] p-8 text-center">
        <div className="relative flex h-64 w-64 items-center justify-center rounded-full" style={{ background: `conic-gradient(${accentColor} ${progress}%, rgba(255,255,255,.08) 0)` }}>
          <div className="absolute inset-3 rounded-full bg-[#0a0f1c] shadow-inner" />
          <div className="relative">
            <div className="text-xs font-medium uppercase tracking-[0.22em] text-white/36">{timer.status === 'paused' ? '已暂停' : active ? (timer.phase === 'focus' ? '专注中' : '休息中') : '准备开始'}</div>
            <div className="mt-3 text-5xl font-semibold tracking-[-0.05em] tabular-nums text-white">{formatRemaining(active ? remainingMs : (hours * 60 + minutes) * 60 * 1000)}</div>
            <div className="mt-3 max-w-44 truncate text-xs text-white/42">{active ? timer.label || (timer.phase === 'focus' ? '保持专注' : '放松一下') : taskLabel || '设置本轮任务'}</div>
          </div>
        </div>
        {active && <div className="mt-7 flex items-center gap-3"><button type="button" onClick={timer.status === 'running' ? pause : resume} className="flex h-12 items-center gap-2 rounded-full px-6 text-sm font-medium text-slate-950" style={{ background: accentColor }}>{timer.status === 'running' ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}{timer.status === 'running' ? '暂停' : '继续'}</button><button type="button" onClick={stop} className="flex h-12 items-center gap-2 rounded-full border border-white/12 bg-white/5 px-6 text-sm text-white/70"><TimerReset className="h-4 w-4" />结束</button></div>}
      </div>
      <aside className="rounded-[30px] border border-white/10 bg-white/[0.045] p-5">
        <div className="flex items-center gap-2 font-medium text-white"><AlarmClock className="h-5 w-5" style={{ color: accentColor }} />设置专注时间</div>
        <p className="mt-2 text-xs leading-5 text-white/40">增强番茄钟 · 已完成 {timer.completedSessions} / {sessionGoal} 轮</p>
        <input disabled={active} value={taskLabel} onChange={event => setTaskLabel(event.target.value)} placeholder="本轮专注任务，例如：整理歌单" className="mt-4 w-full rounded-2xl border border-white/10 bg-white/5 px-3 py-3 text-xs text-white outline-none placeholder:text-white/25 disabled:opacity-40" />
        <div className="mt-5 grid grid-cols-2 gap-3">
          <DurationNumberField label="小时" value={hours} max={23} disabled={active} accentColor={accentColor} onChange={value => setDurationDraft(current => ({ ...current, hours: value }))} />
          <DurationNumberField label="分钟" value={minutes} max={59} disabled={active} accentColor={accentColor} onChange={value => setDurationDraft(current => ({ ...current, minutes: value }))} />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          {[25, 45, 60, 90].map(preset => {
            const selected = hours * 60 + minutes === preset
            return <button key={preset} type="button" disabled={active} onClick={() => setDurationDraft({ hours: Math.floor(preset / 60), minutes: preset % 60 })} className="rounded-2xl border py-3 text-sm transition hover:bg-white/10 disabled:opacity-35" style={{ borderColor: selected ? `${accentColor}90` : 'rgba(255,255,255,.08)', background: selected ? `${accentColor}38` : 'rgba(255,255,255,.04)', color: selected ? '#fff' : 'rgba(255,255,255,.65)' }}>{preset >= 60 ? `${preset / 60} 小时` : `${preset} 分钟`}</button>
          })}
        </div>
        <label className="mt-4 block text-xs text-white/42">每组番茄数：<b className="text-white">{sessionGoal}</b><input disabled={active} type="range" min="2" max="8" value={sessionGoal} onChange={event => setSessionGoal(Number(event.target.value))} className="mt-2 w-full" style={{ accentColor }} /></label>
        <button type="button" disabled={active || hours * 60 + minutes < 1} onClick={startConfiguredTimer} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-semibold text-slate-950 transition hover:brightness-110 disabled:opacity-35" style={{ background: accentColor, boxShadow: `0 10px 30px ${accentColor}35` }}><Play className="h-4 w-4" fill="currentColor" />开始专注</button>
        <button type="button" disabled={active} onClick={startBreak} className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-full border border-white/12 bg-white/5 text-xs text-white/65 transition hover:bg-white/10 disabled:opacity-35"><Clock3 className="h-4 w-4" />{timer.completedSessions > 0 && timer.completedSessions % sessionGoal === 0 ? '开始 15 分钟长休息' : '开始 5 分钟短休息'}</button>
      </aside>
    </div>
  )
}

export default function DesktopTimeCenter({ open, onClose, accentColor, initialTab = 'calendar' }: DesktopTimeCenterProps) {
  const [tab, setTab] = useState<TimeCenterTab>('calendar')
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
  }, [initialTab, open])

  useEffect(() => {
    if (!open) return
    const interval = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(interval)
  }, [open])

  useEffect(() => {
    if (!open) return
    const handleKey = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  const tabs: Array<{ id: TimeCenterTab; label: string; icon: typeof CalendarDays }> = [
    { id: 'calendar', label: '日历', icon: CalendarDays },
    { id: 'world', label: '世界时钟', icon: Globe2 },
    { id: 'focus', label: '专注计时', icon: Clock3 },
  ]
  const isDaytime = now.getHours() >= 6 && now.getHours() < 18
  const theme = isDaytime
    ? {
        overlay: 'radial-gradient(circle at 50% 0%, rgba(125,211,252,.24), transparent 46%), rgba(5,18,30,.62)',
        panel: 'linear-gradient(145deg, rgba(35,82,113,.97), rgba(16,48,73,.97) 52%, rgba(25,65,83,.97))',
        ambient: `radial-gradient(circle at 12% 0%, rgba(186,230,253,.18), transparent 34%), radial-gradient(circle at 88% 8%, ${accentColor}24, transparent 30%)`,
      }
    : {
        overlay: 'radial-gradient(circle at 50% 0%, rgba(67,56,202,.16), transparent 44%), rgba(0,0,0,.78)',
        panel: 'linear-gradient(145deg, rgba(8,13,24,.98), rgba(7,12,24,.98) 52%, rgba(13,15,33,.98))',
        ambient: `radial-gradient(circle at 14% 0%, rgba(59,130,246,.12), transparent 32%), radial-gradient(circle at 88% 8%, ${accentColor}18, transparent 28%)`,
      }

  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[400] flex items-center justify-center p-6 backdrop-blur-2xl" style={{ background: theme.overlay }} onMouseDown={event => event.target === event.currentTarget && onClose()}>
          <motion.div initial={{ opacity: 0, y: 24, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .98 }} transition={{ type: 'spring', damping: 28, stiffness: 320 }} className="relative flex h-[min(850px,92vh)] w-[min(1180px,94vw)] flex-col overflow-hidden rounded-[34px] border border-white/12 shadow-[0_40px_120px_rgba(0,0,0,.65)]" style={{ background: theme.panel }}>
            <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: theme.ambient }} />
            <header className="relative z-10 flex items-center gap-5 border-b border-white/10 px-6 py-5">
              <PreciseClock />
              <nav className="flex flex-1 items-center justify-center gap-2">
                {tabs.map(item => { const Icon = item.icon; const active = item.id === tab; return <button key={item.id} type="button" onClick={() => setTab(item.id)} className="flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm transition hover:bg-white/10" style={{ borderColor: active ? `${accentColor}aa` : 'rgba(255,255,255,.08)', background: active ? `${accentColor}3d` : 'rgba(255,255,255,.035)', boxShadow: active ? `inset 0 0 0 1px ${accentColor}18, 0 6px 20px ${accentColor}18` : 'none', color: active ? '#fff' : 'rgba(255,255,255,.48)' }}><Icon className="h-4 w-4" />{item.label}</button> })}
              </nav>
              <button type="button" onClick={onClose} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/65 transition hover:bg-white/12"><X className="h-5 w-5" /></button>
            </header>
            <main className="relative z-10 flex min-h-0 flex-1 p-5">
              {tab === 'calendar' && <MonthCalendar accentColor={accentColor} />}
              {tab === 'world' && <WorldClock accentColor={accentColor} now={now} />}
              {tab === 'focus' && <FocusTimer accentColor={accentColor} />}
            </main>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export { formatRemaining }
