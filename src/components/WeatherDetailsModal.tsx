import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTvBack } from '../tv/tvCore'
import { AnimatePresence, motion } from 'framer-motion'
import {
  AlertTriangle,
  Cloud,
  Clock3,
  Droplets,
  Eye,
  Gauge,
  Leaf,
  Sun,
  Sunrise,
  ThermometerSun,
  Umbrella,
  Wind,
  X,
  RefreshCw,
  Moon as MoonLucide,
} from 'lucide-react'
import { getWeatherLabel, getWeatherLocationAddress, getWeatherLocationName, getAqiLabel, getCloudCoverLabel, getDewPointLabel, WeatherSnapshot, type WeatherHour } from '../services/weatherService'
import { moonInfoAt } from '../services/moonPhase'
import type { HazardSnapshot } from '../services/hazardService'
import WeatherHazardsPanel, { type WeatherHazardTab } from './WeatherHazardsPanel'
import WeatherMapExperience from './WeatherMapExperience'
import MoonPhaseExperience, { MoonDisc } from './MoonPhaseExperience'
import WeatherCardDetailOverlay, { type WeatherCardKind } from './WeatherCardDetail'
import { IconSunrise, IconSunset } from './AppleWeatherIcon'
// 纯函数/常量/类型与纯视觉组件从轻量模块复用（桌面小组件静态依赖它，避免把 leaflet 拉进桌面模式）。
import { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, WeatherRainGlass, isRainySceneKind, getUvLabel, getWindDirection, WindCompass, WeatherSkyTip, type WeatherDetailsTab } from './weatherVisualTheme'
import { computeSkyBodies } from '../services/moonPhase'
export { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, WeatherRainGlass, isRainySceneKind, type WeatherVisualTheme, type WeatherSceneKind, type WeatherDetailsTab } from './weatherVisualTheme'

interface WeatherDetailsModalProps {
  open: boolean
  weather: WeatherSnapshot | null
  onClose: () => void
  onRefresh: () => void
  loading: boolean
  hazards: HazardSnapshot | null
  hazardLoading: boolean
  hazardError?: string
  initialTab?: WeatherDetailsTab
  onHazardRefresh: () => void
}

const formatTime = (value: string) => value ? value.slice(11, 16) : '--:--'
const formatHour = (value: string, index: number) => index === 0 ? '现在' : `${value.slice(11, 13)}时`
const isHourDaylight = (time: string, weather: WeatherSnapshot) => {
  const date = time.slice(0, 10)
  const day = weather.daily.find(item => item.date === date)
  if (!day?.sunrise || !day?.sunset) return weather.current.isDay
  return time >= day.sunrise && time < day.sunset
}
const formatWeekday = (value: string, index: number) => {
  if (index === 0) return '今天'
  const date = new Date(`${value}T12:00:00`)
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(date)
}

type HourlyItem = { kind: 'hour'; hour: WeatherHour; index: number } | { kind: 'sun'; rise: boolean; time: string; label: string }

/** 苹果风详情卡：小标题 + 大数值 + 说明文字；传入 onClick 后整卡可点开详情弹窗 */
function DetailCard({ icon: Icon, label, value, detail, className = '', children, onClick }: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: React.ReactNode
  detail?: React.ReactNode
  className?: string
  children?: React.ReactNode
  onClick?: () => void
}) {
  const body = (
    <>
      <div className="flex items-center gap-2 text-sm font-medium text-white/52"><Icon className="h-4 w-4" />{label}</div>
      {children ?? (
        <>
          <div className="mt-auto pt-4 text-[28px] font-semibold leading-8 tracking-tight">{value}</div>
          <div className="mt-1.5 text-[13px] leading-5 text-white/50">{detail}</div>
        </>
      )}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`weather-glass-panel flex min-h-[148px] h-full w-full flex-col rounded-[26px] border border-white/10 p-5 text-left transition-transform hover:scale-[1.015] ${className}`}
      >
        {body}
      </button>
    )
  }
  return (
    <div className={`weather-glass-panel flex min-h-[148px] flex-col rounded-[26px] border border-white/10 p-5 ${className}`}>
      {body}
    </div>
  )
}

/** 月相缩略盘（卡片内） */
function MoonDiscSmall({ phase }: { phase: number }) {
  return <MoonDisc phase={phase} className="w-[52px] shrink-0" soft={false} />
}

export default function WeatherDetailsModal({ open, weather, onClose, onRefresh, loading, hazards, hazardLoading, hazardError = '', initialTab = 'weather', onHazardRefresh }: WeatherDetailsModalProps) {
  const [activeTab, setActiveTab] = useState<WeatherDetailsTab>(initialTab)
  const [weatherMapOpen, setWeatherMapOpen] = useState(false)
  const [moonOpen, setMoonOpen] = useState(false)
  const [detailCard, setDetailCard] = useState<WeatherCardKind | null>(null)

  useEffect(() => {
    if (open) setActiveTab(initialTab)
    else { setWeatherMapOpen(false); setMoonOpen(false); setDetailCard(null) }
  }, [initialTab, open])

  // TV 遥控器 BACK：先收地图/月亮/详情子层，再关弹窗（与 ESC 语义一致；带 open 守卫，
  // 本组件经 DesktopWidgetZone 常驻挂载，无守卫会吞掉全场景 BACK 键）
  useTvBack(() => {
    if (!open) return false
    if (weatherMapOpen) setWeatherMapOpen(false)
    else if (moonOpen) setMoonOpen(false)
    else if (detailCard) setDetailCard(null)
    else onClose()
    return true
  })

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (weatherMapOpen) setWeatherMapOpen(false)
        else if (moonOpen) setMoonOpen(false)
        else if (detailCard) setDetailCard(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, weatherMapOpen, moonOpen, detailCard])

  // 每小时卡片：在日出/日落的真实时刻插入特殊槽位（苹果样式）
  const hourlyItems = useMemo<HourlyItem[]>(() => {
    if (!weather) return []
    const items: HourlyItem[] = []
    const day0 = weather.daily[0]
    const hours = weather.hourly.slice(0, 25)
    hours.forEach((hour, index) => {
      if (day0?.sunrise && day0?.sunset && index > 0) {
        const prev = hours[index - 1].time
        if (prev < day0.sunrise && hour.time >= day0.sunrise) items.push({ kind: 'sun', rise: true, time: formatTime(day0.sunrise), label: '日出' })
        if (prev < day0.sunset && hour.time >= day0.sunset) items.push({ kind: 'sun', rise: false, time: formatTime(day0.sunset), label: '日落' })
      }
      items.push({ kind: 'hour', hour, index })
    })
    return items
  }, [weather])

  // 每小时条：按住拖拽横向浏览（替代滚动条）
  const hourlyScrollRef = useRef<HTMLDivElement | null>(null)
  const hourlyDrag = useRef({ active: false, startX: 0, startScroll: 0 })
  const onHourlyPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse') return
    const el = hourlyScrollRef.current
    if (!el) return
    hourlyDrag.current = { active: true, startX: event.clientX, startScroll: el.scrollLeft }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onHourlyPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = hourlyScrollRef.current
    const drag = hourlyDrag.current
    if (!drag.active || !el) return
    el.scrollLeft = drag.startScroll - (event.clientX - drag.startX)
  }
  const endHourlyDrag = () => { hourlyDrag.current.active = false }

  // 当前月相（打开时实时计算）
  const moonInfo = useMemo(() => {
    const info = moonInfoAt(new Date())
    return { name: info.phaseName, illumination: info.illumination, nextFull: Math.max(1, Math.ceil(info.nextFullMoonDays)), phase: info.phase }
  }, [open])

  // 当前时刻露点温度（取最近一小时）
  const currentDewPoint = useMemo(() => {
    if (!weather) return 0
    const hour = weather.hourly.find(item => item.time >= weather.current.time)
    return Math.round(hour?.dewPoint ?? 0)
  }, [weather])

  // 太阳/月亮实时天体位置（按定位纬经度推算），用于背景摆放与方位 tips
  const skyBodies = useMemo(() => {
    if (!weather || typeof weather.location.latitude !== 'number' || typeof weather.location.longitude !== 'number') return undefined
    return computeSkyBodies(new Date(), weather.location.latitude, weather.location.longitude)
  }, [weather, open])

  // 每小时卡片右上角的动态提示：降水/特殊天气预期 + 阵风极值
  const hourlyTip = useMemo(() => {
    if (!weather) return ''
    const hours = weather.hourly.slice(0, 25)
    const SPECIAL: Array<[(code: number) => boolean, string]> = [
      [c => c >= 96, '强雷雨'],
      [c => c === 95, '雷阵雨'],
      [c => c === 65, '暴雨'],
      [c => c === 63, '中雨'],
      [c => c === 82, '强阵雨'],
      [c => c === 85 || c === 86 || c === 66 || c === 67 || c === 56 || c === 57, '雨夹雪'],
      [c => c === 80 || c === 81, '阵雨'],
      [c => c === 61, '小雨'],
      [c => c >= 71 && c <= 77, '降雪'],
      [c => c >= 51 && c <= 55, '毛毛雨'],
    ]
    const hit = hours.find(h => (h.precipitationProbability >= 30 || h.precipitation > 0.15) && SPECIAL.some(([pred]) => pred(h.weatherCode)))
    const gustMax = Math.round(Math.max(...hours.map(h => h.windGusts || 0)))
    const windPart = `阵风最大 ${gustMax} 公里/时`
    if (hit) {
      const label = SPECIAL.find(([pred]) => pred(hit.weatherCode))![1]
      const time = hit.time === weather.hourly[0]?.time ? '现在' : `${hit.time.slice(11, 13)} 点左右`
      return `${time}预计有${label} · ${windPart}`
    }
    const fogNow = weather.current.weatherCode === 45 || weather.current.weatherCode === 48
    return `${fogNow ? '当前有雾 · ' : '未来 24 小时无明显降水 · '}${windPart}`
  }, [weather])

  if (typeof document === 'undefined') return null
  const weatherTheme = getWeatherVisualTheme(weather?.current.weatherCode ?? 2, weather?.current.isDay ?? true)

  const tabBar = (
    <div className="flex w-fit items-center gap-1 rounded-full border border-white/12 bg-black/15 p-1.5 backdrop-blur-xl">
      {([
        ['weather', '天气'],
        ['typhoon', '台风'],
        ['earthquake', '地震'],
      ] as const).map(([tab, label]) => (
        <button
          key={tab}
          type="button"
          onClick={() => setActiveTab(tab)}
          className="rounded-full px-5 py-2.5 text-sm font-medium transition-colors"
          style={{
            color: activeTab === tab ? '#fff' : 'rgba(255,255,255,.56)',
            background: activeTab === tab ? 'rgba(255,255,255,.16)' : 'transparent',
            boxShadow: activeTab === tab ? 'inset 0 0 0 1px rgba(255,255,255,.12)' : 'none',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] overflow-hidden bg-slate-950 text-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <WeatherAtmosphere theme={weatherTheme} skyBodies={activeTab === 'weather' && weather ? skyBodies : undefined} />
          {activeTab === 'weather' && weather && skyBodies && <WeatherSkyTip skyBodies={skyBodies} isDay={weather.current.isDay} />}
          <motion.div
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 overflow-y-auto custom-scrollbar"
          >
            <div className="relative mx-auto min-h-full w-full max-w-[1560px] px-7 pb-9 pt-7 md:px-12 xl:max-w-[1720px]">
              <div className="absolute right-6 top-6 flex items-center gap-2 md:right-10 md:top-8">
                {weather && (
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    title="刷新天气"
                    aria-label="刷新天气"
                    className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 transition-colors hover:bg-white/20 disabled:opacity-50"
                  >
                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  title="关闭天气详情"
                  aria-label="关闭天气详情"
                  className="flex h-11 w-11 items-center justify-center rounded-full border border-white/15 bg-white/10 transition-colors hover:bg-white/20"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {activeTab !== 'weather' ? (
                <>
                  {/* 台风/地震页：保持原左上角布局 */}
                  <div className="pt-2">
                    <div className="text-sm font-medium tracking-[0.18em] text-white/60">
                      {weather?.location.source === 'ip' ? '我的位置 · 自动定位' : '自定义位置'}
                    </div>
                    <h2 className="mt-2 text-4xl font-semibold tracking-tight">{weather ? getWeatherLocationName(weather.location) : '天气'}</h2>
                  </div>
                  <div className="mt-6">{tabBar}</div>
                  <WeatherHazardsPanel
                    tab={activeTab}
                    weather={weather}
                    hazards={hazards}
                    loading={hazardLoading}
                    error={hazardError}
                    onRefresh={onHazardRefresh}
                  />
                </>
              ) : !weather ? (
                <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                  <Cloud className="mb-5 h-16 w-16 text-white/45" />
                  <div className="text-xl font-medium">暂时无法获取天气</div>
                  <button
                    type="button"
                    onClick={onRefresh}
                    disabled={loading}
                    className="mt-5 rounded-full bg-white/15 px-5 py-2.5 text-sm font-medium transition-colors hover:bg-white/25 disabled:opacity-50"
                  >
                    {loading ? '正在刷新…' : '重新获取'}
                  </button>
                </div>
              ) : (
                <>
                  {/* —— iPad 版式：居中头部 —— */}
                  <div className="flex flex-col items-center pt-2 text-center">
                    <div className="text-sm font-medium tracking-[0.18em] text-white/62">
                      {weather.location.source === 'ip' ? '我的位置 · 自动定位' : '自定义位置'}
                    </div>
                    <h2 className="mt-1.5 text-[2rem] font-semibold tracking-tight">{getWeatherLocationName(weather.location)}</h2>
                    <p className="mt-0.5 text-sm text-white/50">{getWeatherLocationAddress(weather.location)}</p>
                    <div className="mt-4 text-[6rem] font-extralight leading-[0.95] tracking-[-0.06em] tabular-nums md:text-[7rem]">
                      {Math.round(weather.current.temperature)}°
                    </div>
                    <div className="mt-2 text-lg text-white/80">
                      最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}° · 最低 {Math.round(weather.daily[0]?.temperatureMin ?? weather.current.temperature)}°
                    </div>
                    <div className="mt-1 text-[22px] font-medium">{getWeatherLabel(weather.current.weatherCode)}</div>
                    <div className="mt-2 flex items-center gap-1.5 text-xs text-white/45">
                      <Clock3 className="h-3.5 w-3.5" />
                      {loading ? '正在更新天气…' : `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(weather.updatedAt)}`}
                    </div>
                    <div className="mt-5">{tabBar}</div>
                  </div>

                  {weather.alerts.length > 0 && (
                    <div className="mt-5 space-y-3">
                      {weather.alerts.map(alert => (
                        <div
                          key={alert.id}
                          className="weather-glass-panel rounded-[26px] border px-5 py-4"
                          style={{
                            borderColor: alert.level === 'extreme' ? 'rgba(251,113,133,0.55)' : 'rgba(251,191,36,0.45)',
                            background: alert.level === 'extreme' ? 'rgba(159,18,57,0.28)' : 'rgba(146,64,14,0.24)',
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                            <div>
                              <div className="text-sm font-semibold text-amber-100">{alert.title}</div>
                              <p className="mt-1.5 text-[13px] leading-5 text-white/68">{alert.message}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* —— 玻璃卡片网格（列数随窗口自适应） —— */}
                  <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {/* 每小时天气预报（含日出/日落槽位；按住左右拖拽浏览） */}
                    <section className="weather-glass-panel rounded-[26px] border border-white/10 p-5 md:col-span-2 lg:col-span-3 xl:col-span-4">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-sm font-medium text-white/55"><Clock3 className="h-4 w-4" />每小时天气预报</span>
                        <span className="text-xs text-white/40">{hourlyTip}</span>
                      </div>
                      <div
                        ref={hourlyScrollRef}
                        className="flex select-none gap-1.5 overflow-x-auto pb-1 wf-no-scrollbar cursor-grab active:cursor-grabbing"
                        onPointerDown={onHourlyPointerDown}
                        onPointerMove={onHourlyPointerMove}
                        onPointerUp={endHourlyDrag}
                        onPointerCancel={endHourlyDrag}
                      >
                        {hourlyItems.map((item, index) => item.kind === 'sun' ? (
                          <div key={`sun-${index}`} className="flex min-w-[66px] flex-col items-center rounded-2xl px-2 py-3">
                            <span className="text-[13px] font-medium text-amber-200/90">{item.time}</span>
                            {item.rise ? <IconSunrise className="my-3 h-8 w-8" /> : <IconSunset className="my-3 h-8 w-8" />}
                            <span className="mt-auto pt-2 text-[13px] text-amber-200/75">{item.label}</span>
                          </div>
                        ) : (
                          <div key={item.hour.time} className="flex min-w-[66px] flex-col items-center border-r border-white/10 px-2 py-3 last:border-r-0">
                            <span className="text-[13px] font-medium text-white/72">{formatHour(item.hour.time, item.index)}</span>
                            <WeatherGlyph code={item.hour.weatherCode} isDay={isHourDaylight(item.hour.time, weather)} className="my-3 h-8 w-8" />
                            <span className="text-[15px] font-semibold tabular-nums">{Math.round(item.hour.temperature)}°</span>
                            <span className="mt-1 min-h-[16px] text-[11px] font-medium text-cyan-200/75">{item.hour.precipitationProbability > 0 ? `${Math.round(item.hour.precipitationProbability)}%` : ' '}</span>
                          </div>
                        ))}
                      </div>
                    </section>

                    {/* 10 日天气预报（左上大卡：3 卡宽 × 4 卡高；行高自动均分，小屏时内部滚动） */}
                    <section className="weather-glass-panel flex flex-col overflow-hidden rounded-[26px] border border-white/10 p-4 md:col-span-2 lg:col-span-1 lg:row-span-2 lg:max-h-[320px] xl:col-span-2 xl:row-span-4 xl:max-h-none">
                      <div className="mb-1 flex shrink-0 items-center gap-2 text-sm font-medium text-white/55"><Sun className="h-4 w-4" />10 日天气预报</div>
                      <div className="flex min-h-0 flex-1 flex-col divide-y divide-white/8 overflow-y-auto custom-scrollbar">
                        {weather.daily.map((day, index) => {
                          const range = Math.max(1, day.temperatureMax - day.temperatureMin)
                          const overallMin = Math.min(...weather.daily.map(item => item.temperatureMin))
                          const overallMax = Math.max(...weather.daily.map(item => item.temperatureMax))
                          const overallRange = Math.max(1, overallMax - overallMin)
                          const left = ((day.temperatureMin - overallMin) / overallRange) * 100
                          const width = Math.max(12, (range / overallRange) * 100)
                          return (
                            <div key={day.date} className="grid flex-1 grid-cols-[52px_34px_38px_1fr_38px] items-center gap-2 py-1">
                              <span className="text-sm font-medium">{formatWeekday(day.date, index)}</span>
                              <div className="flex flex-col items-center">
                                <WeatherGlyph code={day.weatherCode} className="h-5 w-5" />
                                {day.precipitationProbability > 0 && <span className="text-[9px] leading-3 text-cyan-200">{Math.round(day.precipitationProbability)}%</span>}
                              </div>
                              <span className="text-right text-[13px] tabular-nums text-white/48">{Math.round(day.temperatureMin)}°</span>
                              <div className="relative h-1 rounded-full bg-black/15">
                                <div
                                  className="absolute h-full rounded-full bg-gradient-to-r from-cyan-300 via-amber-300 to-orange-400"
                                  style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                                />
                              </div>
                              <span className="text-[13px] tabular-nums">{Math.round(day.temperatureMax)}°</span>
                            </div>
                          )
                        })}
                      </div>
                    </section>

                    {/* 右侧 2×2：标准高度的四张卡 */}
                    <DetailCard icon={Sun} label="紫外线指数" onClick={() => setDetailCard('uv')}>
                      <div className="mt-4 text-[30px] font-semibold leading-9">{Math.round(weather.daily[0]?.uvIndexMax || 0)}</div>
                      <div className="text-sm text-white/62">{getUvLabel(weather.daily[0]?.uvIndexMax || 0)}</div>
                      <div className="relative mt-3 h-1.5 rounded-full" style={{ background: 'linear-gradient(90deg,#5ac8fa,#32d74b,#ffd60a,#ff9f0a,#ff453a,#bf5af2)' }}>
                        <span
                          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900"
                          style={{ left: `${Math.min(100, (Math.min(11, weather.daily[0]?.uvIndexMax || 0) / 11) * 100)}%` }}
                        />
                      </div>
                      <div className="mt-2.5 text-[13px] text-white/50">白天外出注意防晒。</div>
                    </DetailCard>

                    <DetailCard icon={Wind} label="风" onClick={() => setDetailCard('wind')}>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[30px] font-semibold leading-9 tabular-nums">{Math.round(weather.current.windSpeed)}<span className="ml-1 text-base font-normal text-white/62">km/h</span></div>
                          <div className="mt-1 text-[13px] leading-5 text-white/50">{getWindDirection(weather.current.windDirection)}风 · 阵风 {Math.round(weather.current.windGusts)}</div>
                        </div>
                        <WindCompass degree={weather.current.windDirection} />
                      </div>
                    </DetailCard>

                    <button type="button" onClick={() => setMoonOpen(true)} className="text-left">
                      <div className="weather-glass-panel flex h-full min-h-[148px] flex-col rounded-[26px] border border-white/10 p-5 transition-transform hover:scale-[1.015]">
                        <div className="flex items-center gap-2 text-sm font-medium text-white/52"><MoonLucide className="h-4 w-4" />月亮</div>
                        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                          <div>
                            <div className="text-[26px] font-semibold leading-8 tracking-tight">{moonInfo.name}</div>
                            <div className="mt-1.5 text-[13px] text-white/50">照射范围 {Math.round(moonInfo.illumination * 100)}%</div>
                            <div className="text-[13px] text-white/50">下次满月 {moonInfo.nextFull} 天</div>
                          </div>
                          <MoonDiscSmall phase={moonInfo.phase} />
                        </div>
                      </div>
                    </button>

                    <DetailCard icon={Sunrise} label="日出" value={formatTime(weather.daily[0]?.sunrise || '')} detail={`日落 ${formatTime(weather.daily[0]?.sunset || '')}`} onClick={() => setDetailCard('sun')} />


                    {/* 其余详情瓷片（点击进入详情弹窗） */}
                    <DetailCard icon={ThermometerSun} label="体感温度" value={`${Math.round(weather.current.apparentTemperature)}°`} detail={`实际温度 ${Math.round(weather.current.temperature)}°`} onClick={() => setDetailCard('feels')} />
                    <DetailCard icon={Droplets} label="湿度" value={`${Math.round(weather.current.humidity)}%`} detail="当前相对湿度" onClick={() => setDetailCard('humidity')} />
                    <DetailCard icon={Eye} label="能见度" value={`${Math.max(0.1, weather.current.visibility / 1000).toFixed(1)} 公里`} detail={weather.current.visibility >= 10000 ? '视野非常好。' : '注意低能见度。'} onClick={() => setDetailCard('visibility')} />
                    <DetailCard icon={Gauge} label="气压" value={`${Math.round(weather.current.pressure)} 百帕`} detail="地面气压" onClick={() => setDetailCard('pressure')} />
                    <DetailCard icon={Umbrella} label="降水" value={`${weather.current.precipitation.toFixed(1)} 毫米`} detail={`今日概率 ${Math.round(weather.daily[0]?.precipitationProbability || 0)}%`} onClick={() => setDetailCard('precip')} className="lg:col-span-2 xl:col-span-1" />
                    <DetailCard icon={Cloud} label="云量" value={`${Math.round(weather.current.cloudCover ?? 0)}%`} detail={getCloudCoverLabel(weather.current.cloudCover ?? 0)} onClick={() => setDetailCard('cloud')} />
                    <DetailCard icon={Droplets} label="露点温度" value={`${Math.round(currentDewPoint)}°`} detail={getDewPointLabel(currentDewPoint)} onClick={() => setDetailCard('dew')} />
                    {weather.airQuality ? (
                      <DetailCard icon={Leaf} label="空气质量" onClick={() => setDetailCard('aqi')}>
                        <div className="mt-auto flex items-baseline gap-2 pt-4">
                          <span className="text-[28px] font-semibold leading-8 tabular-nums">{Math.round(weather.airQuality.aqi)}</span>
                          <span className="text-base font-normal text-white/68">{getAqiLabel(weather.airQuality.aqi)}</span>
                        </div>
                        <div className="mt-1.5 text-[13px] text-white/50">PM2.5 {Math.round(weather.airQuality.pm25)} · PM10 {Math.round(weather.airQuality.pm10)} μg/m³</div>
                      </DetailCard>
                    ) : (
                      <DetailCard icon={Leaf} label="空气质量" value="—" detail="暂无空气质量数据" />
                    )}

                    {/* 天气地图 */}
                    <div className="lg:col-span-3 xl:col-span-4 [&>button]:mt-0">
                      <WeatherMapExperience
                        weather={weather}
                        open={weatherMapOpen}
                        onOpen={() => setWeatherMapOpen(true)}
                        onClose={() => setWeatherMapOpen(false)}
                      />
                    </div>
                  </div>

                  <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-5 text-xs text-white/35">
                    <span>数据来源：Open-Meteo · 风险提醒由预报数据生成</span>
                    <button type="button" onClick={onRefresh} disabled={loading} className="rounded-full bg-white/10 px-4 py-2 text-white/65 hover:bg-white/15 disabled:opacity-50">
                      {loading ? '刷新中…' : '刷新天气'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.div>
          {/* 月相页（月亮卡片点击进入） */}
          <MoonPhaseExperience weather={weather} open={moonOpen} onOpen={() => setMoonOpen(true)} onClose={() => setMoonOpen(false)} />
          {/* 详情卡二级弹窗（苹果式：所有卡片均可点开） */}
          <WeatherCardDetailOverlay card={detailCard} weather={weather} onClose={() => setDetailCard(null)} />
          {/* 雨滴打在玻璃上的效果：盖在内容层之上，模拟整个天气视图是块被雨淋的玻璃 */}
          {isRainySceneKind(weatherTheme.kind) && <WeatherRainGlass kind={weatherTheme.kind} className="absolute inset-0" />}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
