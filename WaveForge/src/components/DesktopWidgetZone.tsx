import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  AlarmClock,
  CalendarDays,
  CloudSun,
  Droplets,
  Hourglass,
  LocateFixed,
  MapPin,
  Pause,
  Play,
  Wind,
  Waves,
  Activity,
  X,
} from 'lucide-react'
import type { DesktopCustomizationSettings, DesktopWidgetSide, DesktopWidgetType } from '../services/desktopCustomization'
import {
  ensureWeatherSnapshot,
  getCachedWeather,
  getWeatherLabel,
  getWeatherLocationAddress,
  getWeatherLocationCompactName,
  WeatherSnapshot,
} from '../services/weatherService'
// 天气主题纯函数/类型/纯视觉组件走轻量模块（无 leaflet）；模态框本体（含 leaflet 地图）懒加载。
import { getWeatherVisualTheme, WeatherAtmosphere, WeatherGlyph, type WeatherDetailsTab } from './weatherVisualTheme'
const WeatherDetailsModal = lazy(() => import('./WeatherDetailsModal'))
import DesktopTimeCenter, { formatRemaining } from './DesktopTimeCenter'
import { useDesktopFocusTimer } from '../hooks/useDesktopFocusTimer'
import { getCalendarFestivals } from '../utils/calendarFestivals'
import { CountdownWidget, HabitsWidget, MemoWidget, NotesWidget } from './DesktopProductivityWidgets'
import DesktopExtraWidget, { type DesktopMusicWidgetContext } from './DesktopExtraWidgets'
import {
  ensureHazardSnapshot,
  getCachedHazardSnapshot,
  getEarthquakeLocationRisk,
  getTyphoonLocationRisk,
  type HazardSnapshot,
} from '../services/hazardService'

interface DesktopWidgetZoneProps {
  side: DesktopWidgetSide
  settings: DesktopCustomizationSettings
  cardBlurAmount: number
  accentColor: string
  onOverlayOpenChange?: (open: boolean) => void
  layerState?: 'base' | 'active' | 'behind'
  musicContext: DesktopMusicWidgetContext
}

function WidgetShell({
  children,
  cardBlurAmount,
  className = '',
  accentColor,
  background,
}: {
  children: ReactNode
  cardBlurAmount: number
  className?: string
  accentColor?: string
  background?: string
}) {
  const panelBackground = background || (accentColor
    ? `linear-gradient(145deg, ${accentColor}38, rgba(8,12,24,0.42) 48%, rgba(255,255,255,0.08))`
    : 'linear-gradient(135deg, rgba(8,12,24,0.46), rgba(18,24,42,0.24))')

  return (
    <div
      className={`desktop-widget-card relative isolate w-full overflow-hidden rounded-[28px] text-white ${className}`}
      style={{
        background: panelBackground,
        backgroundClip: 'padding-box',
        backdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(150%)`,
        WebkitBackdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(150%)`,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.11), 0 16px 42px rgba(15,23,42,0.12)',
        contain: 'layout paint style',
        contentVisibility: 'auto',
        containIntrinsicSize: '220px',
      }}
    >
      {children}
    </div>
  )
}

function DateTimeWidget({ cardBlurAmount, accentColor, onOverlayOpenChange, focusOnly = false, replaceTimeDuringFocus = false }: { cardBlurAmount: number; accentColor: string; onOverlayOpenChange?: (open: boolean) => void; focusOnly?: boolean; replaceTimeDuringFocus?: boolean }) {
  const [now, setNow] = useState(() => new Date())
  const [showTimeCenter, setShowTimeCenter] = useState(false)
  const [timeCenterTab, setTimeCenterTab] = useState<'world' | 'focus'>('world')
  const { timer: focusTimer, remainingMs, pause, resume, stop } = useDesktopFocusTimer()

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  const dateText = new Intl.DateTimeFormat('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  }).format(now)

  const focusActive = focusTimer.status === 'running' || focusTimer.status === 'paused'
  const openTimeCenter = (tab: 'world' | 'focus') => {
    setTimeCenterTab(tab)
    onOverlayOpenChange?.(true)
    setShowTimeCenter(true)
  }

  if (focusOnly && !focusActive) return null

  return (
    <>
      <div className="w-full space-y-2.5">
        {!focusOnly && !(focusActive && replaceTimeDuringFocus) && <button type="button" onClick={() => openTimeCenter('world')} className="block w-full text-left outline-none transition-transform hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.99]" aria-label="打开时间、日历与世界时钟">
          <WidgetShell cardBlurAmount={cardBlurAmount} accentColor={accentColor} className="px-5 py-4">
            <div>
              <div className="text-[3.35rem] font-semibold leading-none tracking-[-0.05em] tabular-nums drop-shadow-xl">
                {now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
              </div>
              <div className="mt-3 text-sm font-medium tracking-[0.16em] text-white/65">{dateText}</div>
            </div>
          </WidgetShell>
        </button>}

        <AnimatePresence initial={false}>
          {focusActive && (
            <motion.div initial={{ opacity: 0, height: 0, y: -8 }} animate={{ opacity: 1, height: 'auto', y: 0 }} exit={{ opacity: 0, height: 0, y: -8 }} className="overflow-hidden rounded-[28px] outline-none transition-transform hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70" role="button" tabIndex={0} aria-label="打开专注计时" onClick={() => openTimeCenter('focus')} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openTimeCenter('focus') } }}>
              <WidgetShell cardBlurAmount={cardBlurAmount} accentColor={accentColor} className="cursor-pointer px-4 py-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-white/55"><AlarmClock className="h-3.5 w-3.5" style={{ color: accentColor }} />{focusTimer.status === 'paused' ? '专注已暂停' : '正在专注'}</div>
                    <div className="mt-2 text-2xl font-semibold tabular-nums text-white">{formatRemaining(remainingMs)}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={event => { event.stopPropagation(); focusTimer.status === 'running' ? pause() : resume() }} aria-label={focusTimer.status === 'running' ? '暂停专注计时' : '继续专注计时'} className="flex h-10 w-10 items-center justify-center rounded-full text-slate-950" style={{ background: accentColor }}>{focusTimer.status === 'running' ? <Pause className="h-4 w-4" fill="currentColor" /> : <Play className="h-4 w-4" fill="currentColor" />}</button>
                    <button type="button" onClick={event => { event.stopPropagation(); stop() }} aria-label="结束专注计时" className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/5 text-white/60"><X className="h-4 w-4" /></button>
                  </div>
                </div>
                <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(100, ((focusTimer.durationMs - remainingMs) / focusTimer.durationMs) * 100)}%`, background: accentColor }} /></div>
              </WidgetShell>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <DesktopTimeCenter open={showTimeCenter} onClose={() => { setShowTimeCenter(false); onOverlayOpenChange?.(false) }} accentColor={accentColor} initialTab={timeCenterTab} />
    </>
  )
}

function DayProgressWidget({ cardBlurAmount, accentColor, onOverlayOpenChange }: { cardBlurAmount: number; accentColor: string; onOverlayOpenChange?: (open: boolean) => void }) {
  const [now, setNow] = useState(() => new Date())
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000)
    return () => window.clearInterval(timer)
  }, [])

  const startOfDay = new Date(now)
  startOfDay.setHours(0, 0, 0, 0)
  const dayProgress = Math.min(100, Math.max(0, ((now.getTime() - startOfDay.getTime()) / (24 * 60 * 60 * 1000)) * 100))
  const startOfYear = new Date(now.getFullYear(), 0, 1)
  const startOfNextYear = new Date(now.getFullYear() + 1, 0, 1)
  const yearProgress = Math.min(100, Math.max(0, ((now.getTime() - startOfYear.getTime()) / (startOfNextYear.getTime() - startOfYear.getTime())) * 100))
  const startOfWeek = new Date(startOfDay)
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7))
  const startOfNextWeek = new Date(startOfWeek)
  startOfNextWeek.setDate(startOfWeek.getDate() + 7)
  const weekProgress = Math.min(100, Math.max(0, ((now.getTime() - startOfWeek.getTime()) / (startOfNextWeek.getTime() - startOfWeek.getTime())) * 100))
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const monthProgress = Math.min(100, Math.max(0, ((now.getTime() - startOfMonth.getTime()) / (startOfNextMonth.getTime() - startOfMonth.getTime())) * 100))
  const closeDetails = () => { setShowDetails(false); onOverlayOpenChange?.(false) }
  const progressItems = [
    { label: '今天', value: dayProgress, detail: `剩余 ${Math.floor((24 * 60 - now.getHours() * 60 - now.getMinutes()) / 60)} 小时 ${(24 * 60 - now.getHours() * 60 - now.getMinutes()) % 60} 分钟` },
    { label: '本周', value: weekProgress, detail: `第 ${Math.ceil((now.getDate() + new Date(now.getFullYear(), now.getMonth(), 1).getDay()) / 7)} 周` },
    { label: '本月', value: monthProgress, detail: `${now.getMonth() + 1} 月共 ${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()} 天` },
    { label: '今年', value: yearProgress, detail: `${now.getFullYear()} 年` },
  ]

  useEffect(() => {
    if (!showDetails) return
    const handleKey = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && closeDetails()
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [showDetails])

  return (
    <>
      <button type="button" onClick={() => { onOverlayOpenChange?.(true); setShowDetails(true) }} className="block w-full text-left outline-none transition-transform hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[.99]">
        <WidgetShell cardBlurAmount={cardBlurAmount + 10} accentColor={accentColor} background="linear-gradient(145deg, rgba(7,15,30,.64), rgba(30,41,59,.50))" className="overflow-hidden px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-white/70">
              <Hourglass className="h-4 w-4" style={{ color: accentColor }} />
              今日进度
            </div>
            <div className="text-xs tabular-nums text-white/45">{Math.round(dayProgress)}%</div>
          </div>
          <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${dayProgress}%`, background: `linear-gradient(90deg, ${accentColor}, rgba(255,255,255,0.86))`, boxShadow: `0 0 18px ${accentColor}88` }} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-2xl px-3 py-2" style={{ background: `${accentColor}1f` }}><div className="text-white/38">今年</div><div className="mt-1 text-base font-semibold tabular-nums">{Math.round(yearProgress)}%</div></div>
            <div className="rounded-2xl px-3 py-2" style={{ background: `${accentColor}1a` }}><div className="text-white/38">剩余</div><div className="mt-1 text-base font-semibold tabular-nums">{Math.floor((24 * 60 - now.getHours() * 60 - now.getMinutes()) / 60)}h {(24 * 60 - now.getHours() * 60 - now.getMinutes()) % 60}m</div></div>
          </div>
        </WidgetShell>
      </button>
      <AnimatePresence>
        {showDetails && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 p-6 backdrop-blur-2xl" onMouseDown={event => event.target === event.currentTarget && closeDetails()}>
            <motion.div initial={{ opacity: 0, y: 20, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 14, scale: .98 }} className="w-[min(720px,90vw)] rounded-[34px] border border-white/12 bg-[#09101e]/98 p-6 text-white shadow-[0_40px_120px_rgba(0,0,0,.68)]">
              <div className="flex items-center justify-between"><div><div className="flex items-center gap-2 text-lg font-semibold"><Hourglass className="h-5 w-5" style={{ color: accentColor }} />时间进度</div><div className="mt-1 text-xs text-white/38">{now.getFullYear()} 年 {now.getMonth() + 1} 月 {now.getDate()} 日</div></div><button type="button" onClick={closeDetails} className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/5 text-white/60 hover:bg-white/10"><X className="h-5 w-5" /></button></div>
              <div className="mt-6 grid grid-cols-2 gap-3">{progressItems.map(item => <div key={item.label} className="rounded-[24px] border border-white/8 bg-white/[.04] p-4"><div className="flex items-center justify-between"><span className="text-sm text-white/65">{item.label}</span><span className="text-xl font-semibold tabular-nums">{Math.round(item.value)}%</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-white/8"><div className="h-full rounded-full" style={{ width: `${item.value}%`, background: `linear-gradient(90deg, ${accentColor}, #fff)` }} /></div><div className="mt-3 text-xs text-white/32">{item.detail}</div></div>)}</div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function CalendarWidget({ cardBlurAmount, accentColor, onOverlayOpenChange }: { cardBlurAmount: number; accentColor: string; onOverlayOpenChange?: (open: boolean) => void }) {
  const today = new Date()
  const [showTimeCenter, setShowTimeCenter] = useState(false)
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
  monthStart.setDate(1 - monthStart.getDay())
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(monthStart)
    date.setDate(monthStart.getDate() + index)
    return date
  })

  return (
    <>
      <button type="button" onClick={() => { onOverlayOpenChange?.(true); setShowTimeCenter(true) }} className="block w-full text-left outline-none transition-transform hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.99]" aria-label="打开完整日历">
        <WidgetShell cardBlurAmount={cardBlurAmount + 10} accentColor={accentColor} background="linear-gradient(145deg, rgba(7,15,30,.64), rgba(30,41,59,.50))" className="px-4 py-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white/72"><CalendarDays className="h-4 w-4" style={{ color: accentColor }} />{today.getFullYear()} 年 {today.getMonth() + 1} 月</div>
          <div className="grid grid-cols-7 gap-1 text-center text-[9px] text-white/30">{'日一二三四五六'.split('').map(day => <span key={day}>{day}</span>)}</div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            {days.map(date => {
              const active = date.toDateString() === today.toDateString()
              const inMonth = date.getMonth() === today.getMonth()
              const festival = getCalendarFestivals(date)[0]
              return <div key={date.toISOString()} className="relative flex h-7 items-center justify-center rounded-lg text-[10px] font-medium tabular-nums" style={{ color: inMonth ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.18)', background: active ? `${accentColor}55` : 'rgba(255,255,255,.025)', outline: active ? `1px solid ${accentColor}` : 'none' }}>{date.getDate()}{festival && <span className="absolute bottom-0.5 h-0.5 w-0.5 rounded-full" style={{ background: festival.kind === 'holiday' ? '#fb7185' : '#fbbf24' }} />}</div>
            })}
          </div>
        </WidgetShell>
      </button>
      <DesktopTimeCenter open={showTimeCenter} onClose={() => { setShowTimeCenter(false); onOverlayOpenChange?.(false) }} accentColor={accentColor} />
    </>
  )
}

function WeatherWidget({ settings, cardBlurAmount, accentColor, onOverlayOpenChange }: {
  settings: DesktopCustomizationSettings
  cardBlurAmount: number
  accentColor: string
  onOverlayOpenChange?: (open: boolean) => void
}) {
  const [weather, setWeather] = useState<WeatherSnapshot | null>(() => getCachedWeather(settings, true))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [detailsTab, setDetailsTab] = useState<WeatherDetailsTab>('weather')
  const [hazards, setHazards] = useState<HazardSnapshot | null>(() => getCachedHazardSnapshot())
  const [hazardLoading, setHazardLoading] = useState(false)
  const [hazardError, setHazardError] = useState('')
  const requestControllerRef = useRef<AbortController | null>(null)
  const hazardControllerRef = useRef<AbortController | null>(null)
  const weatherIdentity = `${settings.weatherLocationMode}:${settings.weatherLocationMode === 'manual'
    ? [settings.weatherCountryCode, settings.weatherProvinceCode, settings.weatherCityCode, settings.weatherDistrictCode || settings.weatherDistrict, settings.weatherLatitude, settings.weatherLongitude]
      .filter(value => value !== null && value !== undefined && value !== '')
      .join(':')
      .toLowerCase()
    : 'current-ip'}`

  const refreshWeather = useCallback(async (force = false) => {
    const cached = getCachedWeather(settings)
    if (cached && !force) {
      setWeather(cached)
      setError('')
      return
    }

    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setLoading(true)
    let timedOut = false
    const timeout = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, 20_000)
    try {
      const snapshot = await ensureWeatherSnapshot(settings, { forceRefresh: force, signal: controller.signal })
      setWeather(snapshot)
      setError('')
    } catch (fetchError) {
      if (timedOut) {
        setError('天气刷新超时，请检查网络后重试')
      } else if ((fetchError as Error).name !== 'AbortError') {
        setError((fetchError as Error).message || '暂时无法获取天气')
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null
        setLoading(false)
      }
    }
  }, [settings, weatherIdentity])

  useEffect(() => {
    const staleCache = getCachedWeather(settings, true)
    requestControllerRef.current?.abort()
    setWeather(staleCache)
    setError('')
    // 后台预取若已生成新鲜缓存则直接复用；缓存过期时才重新定位并请求。
    void refreshWeather(false)
    const timer = window.setInterval(() => void refreshWeather(true), 15 * 60 * 1000)
    return () => {
      window.clearInterval(timer)
      requestControllerRef.current?.abort()
    }
  }, [refreshWeather, weatherIdentity])

  const refreshHazards = useCallback(async (force = false) => {
    hazardControllerRef.current?.abort()
    const controller = new AbortController()
    hazardControllerRef.current = controller
    setHazardLoading(true)
    try {
      const snapshot = await ensureHazardSnapshot({ forceRefresh: force, signal: controller.signal })
      if (controller.signal.aborted) return
      setHazards(snapshot)
      setHazardError([snapshot.errors.typhoons, snapshot.errors.earthquakes].filter(Boolean).join('；'))
    } catch (fetchError) {
      if ((fetchError as Error).name !== 'AbortError') {
        setHazardError((fetchError as Error).message || '灾害信息暂时不可用')
      }
    } finally {
      if (hazardControllerRef.current === controller) {
        hazardControllerRef.current = null
        setHazardLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!weather) return
    let disposed = false
    let idleHandle: number | null = null
    let fallbackTimer: number | null = null
    const load = () => {
      if (!disposed && document.visibilityState === 'visible') void refreshHazards(false)
    }
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (idleWindow.requestIdleCallback) {
      idleHandle = idleWindow.requestIdleCallback(load, { timeout: 2200 })
    } else {
      fallbackTimer = window.setTimeout(load, 500)
    }
    const timer = window.setInterval(load, 10 * 60 * 1000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && (!hazards || Date.now() - hazards.updatedAt > 10 * 60 * 1000)) load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      window.clearInterval(timer)
      if (idleHandle !== null) idleWindow.cancelIdleCallback?.(idleHandle)
      if (fallbackTimer !== null) window.clearTimeout(fallbackTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      hazardControllerRef.current?.abort()
    }
  }, [refreshHazards, weather?.location.latitude, weather?.location.longitude])

  const weatherTheme = useMemo(
    () => weather ? getWeatherVisualTheme(weather.current.weatherCode, weather.current.isDay) : null,
    [weather?.current.isDay, weather?.current.weatherCode]
  )
  const alert = weather?.alerts[0]
  const typhoonRisk = useMemo(() => weather ? getTyphoonLocationRisk(hazards, weather.location.latitude, weather.location.longitude) : null, [hazards, weather?.location.latitude, weather?.location.longitude])
  const earthquakeRisk = useMemo(() => weather ? getEarthquakeLocationRisk(hazards, weather.location.latitude, weather.location.longitude) : null, [hazards, weather?.location.latitude, weather?.location.longitude])
  const locationLabel = weather ? getWeatherLocationCompactName(weather.location)
    : (settings.weatherLocationMode === 'auto'
      ? '正在定位'
      : settings.weatherDistrict || settings.weatherCity || settings.weatherProvince || '未设置地区')
  const locationAddress = weather ? getWeatherLocationAddress(weather.location) : locationLabel
  const precipitationChance = Math.round(weather?.daily[0]?.precipitationProbability || weather?.hourly[0]?.precipitationProbability || 0)

  const openDetails = (tab: WeatherDetailsTab = 'weather') => {
    setDetailsTab(tab)
    onOverlayOpenChange?.(true)
    setShowDetails(true)
  }
  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openDetails('weather')
    }
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => openDetails('weather')}
        onKeyDown={handleCardKeyDown}
        className="desktop-widget-card relative isolate w-full overflow-hidden rounded-[28px] text-left text-white outline-none transition-transform hover:scale-[1.018] focus-visible:ring-2 focus-visible:ring-white/70 active:scale-[0.99]"
        style={{
          background: weatherTheme?.cardBackground || `linear-gradient(135deg, ${accentColor}66, rgba(8,12,24,0.42))`,
          backgroundClip: 'padding-box',
          backdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(160%)`,
          WebkitBackdropFilter: `blur(${Math.max(14, cardBlurAmount + 8)}px) saturate(160%)`,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.11), 0 16px 42px rgba(15,23,42,0.12)',
        contain: 'layout paint style',
        contentVisibility: 'auto',
        containIntrinsicSize: '220px',
        }}
        aria-label={`查看${locationAddress}天气详情`}
      >
        {weatherTheme && <WeatherAtmosphere theme={weatherTheme} compact />}
        <div className="relative z-10 px-5 pb-4 pt-4">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-white/70">
            {settings.weatherLocationMode === 'auto'
              ? <LocateFixed className="h-3.5 w-3.5 shrink-0" />
              : <MapPin className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate leading-5" title={locationAddress}>{locationLabel}</span>
          </div>

          <div className="mt-4 flex items-end justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-start gap-1">
                <span className="text-[3.65rem] font-semibold leading-[0.86] tracking-[-0.08em] tabular-nums">
                  {weather ? Math.round(weather.current.temperature) : loading ? '···' : '--'}
                </span>
                <span className="pt-1 text-2xl font-light">°</span>
              </div>
              <div className="mt-3 truncate text-sm font-medium text-white/82">
                {weather ? getWeatherLabel(weather.current.weatherCode) : error || (loading ? '正在获取天气' : '点击重试')}
              </div>
              {weather && (
                <div className="mt-1 text-xs text-white/55">
                  体感 {Math.round(weather.current.apparentTemperature)}° · 最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}°
                </div>
              )}
            </div>
            {weather ? (
              <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="mb-1 h-14 w-14 shrink-0 text-white/90 drop-shadow-lg" />
            ) : (
              <CloudSun className="mb-1 h-14 w-14 shrink-0 text-white/70 drop-shadow-lg" />
            )}
          </div>

          {weather && (
            <>
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-white/10 pt-3 text-[11px] text-white/65">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Wind className="h-3.5 w-3.5 shrink-0 text-cyan-100/80" />
                  <span className="truncate">{Math.round(weather.current.windSpeed)} km/h</span>
                </div>
                <div className="flex min-w-0 items-center gap-1.5">
                  <Droplets className="h-3.5 w-3.5 shrink-0 text-cyan-100/80" />
                  <span className="truncate">{Math.round(weather.current.humidity)}%</span>
                </div>
                <div className="truncate text-right">{precipitationChance}% 降水</div>
              </div>
            </>
          )}
        </div>

        {alert && (
          <div
            className="relative z-10 flex items-start gap-2.5 border-t px-5 py-3"
            style={{
              borderColor: alert.level === 'extreme' ? 'rgba(251,113,133,0.36)' : 'rgba(251,191,36,0.3)',
              background: alert.level === 'extreme' ? 'rgba(159,18,57,0.28)' : 'rgba(146,64,14,0.22)',
            }}
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-amber-100">{alert.title}</div>
              <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/58">{alert.message}</div>
            </div>
          </div>
        )}
      </div>

      {(typhoonRisk || earthquakeRisk) && (
        <div className="mt-2.5 w-full space-y-2">
          {typhoonRisk && (
            <button type="button" onClick={() => openDetails('typhoon')} className="relative isolate flex w-full items-start gap-3 overflow-hidden rounded-[22px] border border-rose-200/30 px-4 py-3 text-left text-white [box-shadow:none] transition-colors hover:border-rose-100/45 active:brightness-95" style={{ background: 'radial-gradient(circle at 82% 44%, rgba(251,113,133,.28), transparent 34%), radial-gradient(circle at 17% 110%, rgba(56,189,248,.16), transparent 48%), linear-gradient(135deg, rgba(76,5,25,.88), rgba(51,16,38,.78) 54%, rgba(30,41,59,.72))' }}>
              <div aria-hidden="true" className="pointer-events-none absolute right-5 top-6 h-16 w-16 rounded-full border border-rose-100/20 border-b-transparent border-l-rose-200/35 bg-transparent" />
              <Waves className="relative z-10 mt-0.5 h-4 w-4 shrink-0 text-rose-200" />
              <div className="relative z-10 min-w-0 flex-1">
                <div className="text-xs font-semibold text-rose-100">台风动态</div>
                <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/58">{typhoonRisk.message}</div>
                {typhoonRisk.typhoon.latest && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-white/48"><span>{typhoonRisk.typhoon.latest.windSpeed} m/s</span><span>{typhoonRisk.typhoon.latest.pressure} hPa</span><span>移速 {typhoonRisk.typhoon.latest.moveSpeed} km/h</span></div>}
              </div>
            </button>
          )}
          {earthquakeRisk && (
            <button type="button" onClick={() => openDetails('earthquake')} className="flex w-full items-start gap-3 rounded-[22px] border border-amber-300/25 bg-amber-950/25 px-4 py-3 text-left text-white transition-transform hover:scale-[1.012] active:scale-[0.99]">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-amber-200" />
              <div className="min-w-0"><div className="text-xs font-semibold text-amber-100">地震监测提醒</div><div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-white/58">{earthquakeRisk.message}</div></div>
            </button>
          )}
        </div>
      )}

      <Suspense fallback={null}>
        <WeatherDetailsModal
          open={showDetails}
          weather={weather}
          onClose={() => { setShowDetails(false); onOverlayOpenChange?.(false) }}
          onRefresh={() => void refreshWeather(true)}
          loading={loading}
          hazards={hazards}
          hazardLoading={hazardLoading}
          hazardError={hazardError}
          initialTab={detailsTab}
          onHazardRefresh={() => void refreshHazards(true)}
        />
      </Suspense>
    </>
  )
}

function DesktopWidgetZone({ side, settings, cardBlurAmount, accentColor, onOverlayOpenChange, layerState = 'base', musicContext }: DesktopWidgetZoneProps) {
  const widgets = useMemo(() => settings[side], [settings, side])
  const zoneRef = useRef<HTMLDivElement>(null)
  const baseHeightRef = useRef(0)
  const [replaceTimeDuringFocus, setReplaceTimeDuringFocus] = useState(false)
  const [scrollFades, setScrollFades] = useState({ top: false, bottom: false })
  const { timer: focusTimer } = useDesktopFocusTimer(false)
  const focusActive = focusTimer.status === 'running' || focusTimer.status === 'paused'
  const hasDateTimeHere = widgets.includes('datetime')
  const hasDateTimeAnywhere = settings.left.includes('datetime') || settings.right.includes('datetime')
  const temporaryFocusSide: DesktopWidgetSide = settings.left.length <= settings.right.length ? 'left' : 'right'
  const renderTemporaryFocus = focusActive && !hasDateTimeAnywhere && side === temporaryFocusSide
  const updateScrollFades = useCallback(() => {
    const zone = zoneRef.current
    if (!zone) return
    const next = {
      top: zone.scrollTop > 4,
      bottom: zone.scrollTop + zone.clientHeight < zone.scrollHeight - 4,
    }
    setScrollFades(current => current.top === next.top && current.bottom === next.bottom ? current : next)
  }, [])

  useLayoutEffect(() => {
    const measure = () => {
      const zone = zoneRef.current
      if (!zone) return
      if (!focusActive) {
        baseHeightRef.current = zone.scrollHeight
        setReplaceTimeDuringFocus(false)
        return
      }
      if (!hasDateTimeHere) {
        setReplaceTimeDuringFocus(false)
        return
      }
      const availableHeight = window.innerHeight - zone.getBoundingClientRect().top - 24
      const baseHeight = baseHeightRef.current || Math.max(0, zone.scrollHeight - 128)
      setReplaceTimeDuringFocus(baseHeight + 128 > availableHeight)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [focusActive, hasDateTimeHere, widgets])

  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(updateScrollFades)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollFades) : null
    if (zoneRef.current) observer?.observe(zoneRef.current)
    window.addEventListener('resize', updateScrollFades)
    return () => {
      window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', updateScrollFades)
    }
  }, [updateScrollFades, widgets])

  if (widgets.length === 0 && !renderTemporaryFocus) return null

  const renderWidget = (widget: DesktopWidgetType) => {
    if (widget === 'datetime') return <DateTimeWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} replaceTimeDuringFocus={replaceTimeDuringFocus} />
    if (widget === 'weather') return <WeatherWidget key={widget} settings={settings} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'dayProgress') return <DayProgressWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'calendar') return <CalendarWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'notes') return <NotesWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'memo') return <MemoWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'habits') return <HabitsWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    if (widget === 'countdown') return <CountdownWidget key={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />
    return <DesktopExtraWidget key={widget} type={widget} cardBlurAmount={cardBlurAmount} accentColor={accentColor} context={musicContext} onOverlayOpenChange={onOverlayOpenChange} />
  }

  return (
    <div
      className={`absolute top-3 ${layerState === 'active' ? 'z-[70]' : layerState === 'behind' ? 'z-20' : 'z-30'} ${side === 'left' ? 'left-3' : 'right-3'}`}
      style={{ width: 'clamp(244px, calc(22vw + 24px), 328px)', maxHeight: 'calc(100vh - 24px)' }}
    >
      <div
        ref={zoneRef}
        onScroll={updateScrollFades}
        className={`desktop-widget-scroller w-full scrollbar-hide flex max-w-full flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 py-3 [&>*]:shrink-0 ${side === 'left' ? 'items-start' : 'items-end'}`}
        style={{ maxHeight: 'calc(100vh - 24px)', overscrollBehavior: 'contain', scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {widgets.map(renderWidget)}
        {renderTemporaryFocus && <DateTimeWidget key="temporary-focus" focusOnly cardBlurAmount={cardBlurAmount} accentColor={accentColor} onOverlayOpenChange={onOverlayOpenChange} />}
      </div>
      <AnimatePresence>
        {scrollFades.top && <motion.div aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute left-3 right-3 top-0 z-10 h-14" style={{ background: 'linear-gradient(to bottom, rgba(8,10,28,.29), rgba(8,10,28,.12) 42%, transparent)', maskImage: 'linear-gradient(to bottom, #000 5%, rgba(0,0,0,.72) 48%, transparent)', WebkitMaskImage: 'linear-gradient(to bottom, #000 5%, rgba(0,0,0,.72) 48%, transparent)' }} />}
        {scrollFades.bottom && <motion.div aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="pointer-events-none absolute bottom-0 left-3 right-3 z-10 h-14" style={{ background: 'linear-gradient(to top, rgba(8,10,28,.29), rgba(8,10,28,.12) 42%, transparent)', backdropFilter: 'blur(3.6px) saturate(112%)', WebkitBackdropFilter: 'blur(3.6px) saturate(112%)', maskImage: 'linear-gradient(to top, #000 5%, rgba(0,0,0,.72) 48%, transparent)', WebkitMaskImage: 'linear-gradient(to top, #000 5%, rgba(0,0,0,.72) 48%, transparent)' }} />}
      </AnimatePresence>
    </div>
  )
}

export default memo(DesktopWidgetZone)
