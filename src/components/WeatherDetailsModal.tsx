import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { useTvBack } from '../tv/tvCore'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  AlertTriangle,
  ChevronRight,
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
import { getWeatherLabel, getWeatherLocationAddress, getWeatherLocationName, getAqiDescriptor, getAqiLabel, getCloudCoverLabel, getDewPointLabel, WeatherSnapshot, type WeatherHour } from '../services/weatherService'
import { moonInfoAt } from '../services/moonPhase'
import type { HazardSnapshot } from '../services/hazardService'
import WeatherHazardsPanel from './WeatherHazardsPanel'
import WeatherMapExperience from './WeatherMapExperience'
import ScrollToTop from './ScrollToTop'
import ErrorBoundary from './ErrorBoundary'
import MoonPhaseExperience, { MoonDisc } from './MoonPhaseExperience'
import WeatherCardDetailOverlay, { type WeatherCardKind } from './WeatherCardDetail'
import { IconSunrise, IconSunset } from './AppleWeatherIcon'
// 纯函数/常量/类型与纯视觉组件从轻量模块复用（桌面小组件静态依赖它，避免把 leaflet 拉进桌面模式）。
import { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, WeatherRainGlass, isRainySceneKind, getUvLabel, getWindDirection, WindCompass, type WeatherDetailsTab } from './weatherVisualTheme'
import { computeSkyBodies, azimuthDirection } from '../services/moonPhase'
import { createAppleWeatherSceneModel } from './weatherScene/weatherSceneModel'
import { formatDateInTimezone } from '../services/weatherTime'
import HourlyForecastRainGlass from './weatherScene/HourlyForecastRainGlass'
import WeatherDayDetail from './WeatherDayDetail'

const AppleWeatherScene = lazy(() => import('./weatherScene/AppleWeatherScene'))
export { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, WeatherRainGlass, isRainySceneKind, type WeatherVisualTheme, type WeatherSceneKind, type WeatherDetailsTab } from './weatherVisualTheme'

interface WeatherDetailsModalProps {
  open: boolean
  weather: WeatherSnapshot | null
  onClose: () => void
  onRefresh: () => void
  loading: boolean
  hazards: HazardSnapshot | null
  hazardLoading: boolean
  hazardErrors?: { typhoons: string; earthquakes: string }
  hazardTransportError?: string
  initialTab?: WeatherDetailsTab
  onHazardRefresh: () => void
  onHazardEnsure: () => void
}

const formatTime = (value: string) => value ? value.slice(11, 16) : '--:--'
const formatHour = (value: string, index: number) => index === 0 ? '现在' : `${value.slice(11, 13)}时`
/** 分钟数 → "X 小时 Y 分钟"（卡片紧凑显示用） */
const formatDurationShort = (totalMinutes: number) => {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = Math.round(totalMinutes % 60)
  if (hours <= 0) return `${minutes} 分钟`
  return `${hours} 小时 ${minutes} 分钟`
}
const getSnowLabel = (snowfallSum: number) => snowfallSum > 0 ? '当日有降雪' : '当日预计无降雪'
/** 秒 → "X 小时 Y 分钟"（昼长显示） */
const formatDaylight = (seconds: number) => {
  const totalMinutes = Math.round(seconds / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours <= 0) return `${minutes} 分钟`
  return `${hours} 小时 ${minutes} 分钟`
}
const isHourDaylight = (time: string, weather: WeatherSnapshot) => {
  const date = time.slice(0, 10)
  const day = weather.daily.find(item => item.date === date)
  if (!day?.sunrise || !day?.sunset) return weather.current.isDay
  return time >= day.sunrise && time < day.sunset
}
const WEEKDAY_FORMATTER = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' })
const formatWeekday = (value: string, index: number) => {
  if (index === 0) return '今天'
  const date = new Date(`${value}T12:00:00`)
  return WEEKDAY_FORMATTER.format(date)
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
  return <MoonDisc phase={phase} className="w-[76px] shrink-0" soft={false} />
}

export default function WeatherDetailsModal({ open, weather, onClose, onRefresh, loading, hazards, hazardLoading, hazardErrors, hazardTransportError = '', initialTab = 'weather', onHazardRefresh, onHazardEnsure }: WeatherDetailsModalProps) {
  // 挂起（所属模式层被切走）时不渲染这个 portal：portal 挂在 body 上，不受挂起层
  // visibility:hidden 约束，留着会盖住当前模式。只隐藏不卸载，切回来状态原样。
  const parked = useModeParked()
  const [activeTab, setActiveTab] = useState<WeatherDetailsTab>(initialTab)
  const [weatherMapOpen, setWeatherMapOpen] = useState(false)
  const [moonOpen, setMoonOpen] = useState(false)
  const [detailCard, setDetailCard] = useState<WeatherCardKind | null>(null)
  const [selectedDayIndex, setSelectedDayIndex] = useState<number | null>(null)
  const [appleSceneUnavailable, setAppleSceneUnavailable] = useState(false)
  const [appleSceneReady, setAppleSceneReady] = useState(false)
  const prefersReducedMotion = useReducedMotion()
  const appleScene = useMemo(() => weather ? createAppleWeatherSceneModel(weather) : null, [weather])
  const sceneId = appleScene?.id || ''
  const sceneIdRef = useRef(sceneId)
  sceneIdRef.current = sceneId
  const markAppleSceneUnavailable = useCallback(() => {
    if (sceneIdRef.current === sceneId) setAppleSceneUnavailable(true)
  }, [sceneId])
  const markAppleSceneReady = useCallback(() => {
    if (sceneIdRef.current === sceneId) setAppleSceneReady(true)
  }, [sceneId])
  const secondaryOverlayOpen = weatherMapOpen || moonOpen || detailCard !== null || selectedDayIndex !== null
  // 背景动画只在「全屏天气地图」或「台风/地震页」时暂停；居中小弹窗（详情卡/月相）
  // 不遮挡天空，保持云/雨/月亮动画继续动（冻结看起来像卡死）。
  const weatherAnimationActive = open && activeTab === 'weather' && !weatherMapOpen
  // 天气主视图滚动容器（内容超一屏后显示「回到顶部」）
  const weatherScrollRef = useRef<HTMLDivElement | null>(null)
  const openDetailCard = useCallback((card: WeatherCardKind) => {
    setWeatherMapOpen(false)
    setMoonOpen(false)
    setDetailCard(card)
  }, [])
  const openMoon = useCallback(() => {
    setWeatherMapOpen(false)
    setDetailCard(null)
    setMoonOpen(true)
  }, [])
  const openWeatherMap = useCallback(() => {
    setMoonOpen(false)
    setDetailCard(null)
    setWeatherMapOpen(true)
  }, [])

  useEffect(() => {
    if (open) {
      setAppleSceneUnavailable(false)
      setAppleSceneReady(false)
    }
  }, [open, appleScene?.id])

  useEffect(() => {
    if (open) setActiveTab(initialTab)
    else { setWeatherMapOpen(false); setMoonOpen(false); setDetailCard(null) }
  }, [initialTab, open])

  useEffect(() => {
    if (open && activeTab !== 'weather' && !hazards) onHazardEnsure()
  }, [activeTab, hazards, onHazardEnsure, open])

  // TV 遥控器 BACK：先收地图/月亮/详情子层，再关弹窗（与 ESC 语义一致；带 open 守卫，
  // 本组件经 DesktopWidgetZone 常驻挂载，无守卫会吞掉全场景 BACK 键）
  useTvBack(() => {
    if (!open) return false
    if (weatherMapOpen) setWeatherMapOpen(false)
    else if (moonOpen) setMoonOpen(false)
    else if (selectedDayIndex !== null) setSelectedDayIndex(null)
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

  // 每小时卡右上角的动态提示：降水/特殊天气预期 + 阵风极值
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

  // 逐小时卡三态视图（Apple 式）：condition=气温天气 / precipitation=降水强度概率 / wind=风速级
  const [hourlyView, setHourlyView] = useState<'condition' | 'precipitation' | 'wind'>('condition')
  // 10 日预报卡三态视图（图 1055/1056：温度条 / 降水迷你柱 / 风迷你曲线）
  const [dailyView, setDailyView] = useState<'condition' | 'precipitation' | 'wind'>('condition')
  const windSpeedBeaufort = (kmh: number) => {
    const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 117]
    let level = 12
    for (let i = 0; i < thresholds.length; i += 1) { if (kmh < thresholds[i]) { level = i; break } }
    return level
  }
  // 每日逐时序列缓存键：日期 → 当天 hours（10 日卡的降水/风迷你图用）
  const dailyHours = useMemo(() => {
    const map = new Map<string, WeatherHour[]>()
    if (weather) {
      for (const hour of weather.hourly) {
        const date = hour.time.slice(0, 10)
        const list = map.get(date)
        if (list) list.push(hour)
        else map.set(date, [hour])
      }
    }
    return map
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

  // 内部还挂着时间进度 / 台风 / 地震 / 天气图 / 月相几个子浮层，它们同样 portal 到 body——
  // 这里返回 null 就一并挡住了，不需要各自再判一次。
  if (parked) return null

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] overflow-hidden bg-slate-950 text-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: weatherTheme.background }} />
          {(!appleScene || appleSceneUnavailable) && <WeatherAtmosphere theme={weatherTheme} active skyBodies={activeTab === 'weather' && weather ? skyBodies : undefined} />}
          {appleScene && !appleSceneUnavailable && (
            <Suspense fallback={null}>
              <AppleWeatherScene
                scene={appleScene}
                active={weatherAnimationActive}
                reducedMotion={Boolean(prefersReducedMotion)}
                onReady={markAppleSceneReady}
                onUnavailable={markAppleSceneUnavailable}
                className={`absolute inset-0 z-[1] transition-opacity duration-300 ${appleSceneReady ? 'opacity-100' : 'opacity-0'}`}
              />
            </Suspense>
          )}
          <motion.div
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 z-[3] overflow-y-auto wf-no-scrollbar"
            ref={weatherScrollRef}
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
                  {/* 台风/地震页：保持原左上角布局；面板内容随 tab 切换淡入上移（不再生硬直切） */}
                  <div className="pt-2">
                    <div className="text-sm font-medium tracking-[0.18em] text-white/60">
                      {weather?.location.source === 'ip' ? '我的位置 · 自动定位' : '自定义位置'}
                    </div>
                    <h2 className="mt-2 text-4xl font-semibold tracking-tight">{weather ? getWeatherLocationName(weather.location) : '天气'}</h2>
                  </div>
                  <div className="mt-6">{tabBar}</div>
                  {/* tab 切换过渡：不用 mode="wait"（串行等待 0.5s+ 显得卡）；改为
                      极短交叉淡入——新内容立即可交互，只有轻量透明度过渡 */}
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.div
                      key={activeTab}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1, transition: { duration: 0.18, ease: 'easeOut' } }}
                      exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    >
                      <WeatherHazardsPanel
                        tab={activeTab}
                        weather={weather}
                        hazards={hazards}
                        loading={hazardLoading}
                        errors={hazardErrors}
                        transportError={hazardTransportError}
                        onRefresh={onHazardRefresh}
                      />
                    </motion.div>
                  </AnimatePresence>
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
                    <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-white/45">
                      <Clock3 className="h-3.5 w-3.5" />
                      {loading ? '正在更新天气…' : `更新于 ${formatDateInTimezone(new Date(weather.updatedAt), weather.timezone, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}`}
                      {/* 数据陈旧提示：请求失败回退旧缓存时（数据仍在但不是最新的） */}
                      {!loading && Date.now() - weather.updatedAt > 60 * 60 * 1000 && (
                        <span className="text-amber-200/70">· 数据可能已过期</span>
                      )}
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
                    {/* 每小时天气预报（含日出/日落槽位；按住左右拖拽浏览；三态视图切换） */}
                    <section className="weather-glass-panel relative isolate overflow-hidden rounded-[26px] border border-white/10 p-5 [clip-path:inset(0_round_26px)] md:col-span-2 lg:col-span-3 xl:col-span-4">
                      <div className="relative z-[1]">
                        <div className="mb-4 flex items-center justify-between gap-3">
                        <span className="flex items-center gap-2 text-sm font-medium text-white/55">
                          <Clock3 className="h-4 w-4" />
                          {hourlyView === 'condition' ? '天气状况' : hourlyView === 'precipitation' ? '降水' : '风'}
                          <span className="ml-1 text-xs text-white/38">
                            {hourlyView === 'condition' ? '气温 (°C)' : hourlyView === 'precipitation' ? '强度 · 降雨概率' : '风速 (级) · 阵风'}
                          </span>
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="hidden text-xs text-white/40 md:block">{hourlyView === 'condition' ? hourlyTip : ''}</span>
                          {/* Apple 式三态切换：天气状况 / 降水 / 风 */}
                          <div className="flex items-center gap-0.5 rounded-full border border-white/12 bg-black/20 p-1">
                            {([
                              ['condition', Cloud],
                              ['precipitation', Droplets],
                              ['wind', Wind],
                            ] as const).map(([view, Icon]) => (
                              <button
                                key={view}
                                type="button"
                                onClick={() => setHourlyView(view)}
                                aria-label={view === 'condition' ? '按天气状况查看' : view === 'precipitation' ? '按降水查看' : '按风查看'}
                                aria-pressed={hourlyView === view}
                                className={`flex h-7 w-9 items-center justify-center rounded-full transition-colors ${hourlyView === view ? 'bg-white/18 text-white' : 'text-white/45 hover:text-white/75'}`}
                              >
                                <Icon className="h-4 w-4" />
                              </button>
                            ))}
                          </div>
                        </div>
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
                        ) : hourlyView === 'condition' ? (
                          <div key={item.hour.time} className="flex min-w-[66px] flex-col items-center border-r border-white/10 px-2 py-3 last:border-r-0">
                            <span className="text-[13px] font-medium text-white/72">{formatHour(item.hour.time, item.index)}</span>
                            <WeatherGlyph code={item.hour.weatherCode} isDay={isHourDaylight(item.hour.time, weather)} className="my-3 h-8 w-8" />
                            <span className="text-[15px] font-semibold tabular-nums">{Math.round(item.hour.temperature)}°</span>
                            <span className="mt-1 min-h-[16px] text-[11px] font-medium text-cyan-200/75">{item.hour.precipitationProbability > 0 ? `${Math.round(item.hour.precipitationProbability)}%` : ' '}</span>
                          </div>
                        ) : hourlyView === 'precipitation' ? (
                          // Apple 降水视图：按小时画强度柱（相对高度），柱下概率百分比
                          <div key={item.hour.time} className="flex min-w-[66px] flex-col items-center border-r border-white/10 px-2 py-3 last:border-r-0">
                            <span className="text-[13px] font-medium text-white/72">{formatHour(item.hour.time, item.index)}</span>
                            <div className="relative my-3 flex h-8 w-8 items-end justify-center overflow-hidden rounded-lg bg-white/[0.04]">
                              <div
                                className="w-2.5 rounded-full bg-gradient-to-t from-sky-500 to-cyan-300"
                                style={{ height: `${Math.min(100, Math.max(3, item.hour.precipitation / 4 * 100))}%` }}
                              />
                            </div>
                            <span className="mt-1 min-h-[16px] text-[11px] font-medium text-sky-200/80">{Math.round(item.hour.precipitation * 10) / 10 > 0 ? `${Math.round(item.hour.precipitation * 10) / 10}毫米` : `${Math.round(item.hour.precipitationProbability)}%`}</span>
                          </div>
                        ) : (
                          // Apple 风视图：蒲福风级大数字 + 小"级"字，底部阵风
                          <div key={item.hour.time} className="flex min-w-[66px] flex-col items-center border-r border-white/10 px-2 py-3 last:border-r-0">
                            <span className="text-[13px] font-medium text-white/72">{formatHour(item.hour.time, item.index)}</span>
                            <div className="my-3 flex h-8 items-baseline justify-center gap-0.5">
                              <span className="text-[22px] font-semibold leading-none tabular-nums">{windSpeedBeaufort(item.hour.windSpeed)}</span>
                              <span className="text-[11px] text-white/50">级</span>
                            </div>
                            <span className="mt-1 min-h-[16px] text-[11px] font-medium text-emerald-200/75">阵风 {Math.round(item.hour.windGusts)}</span>
                          </div>
                        ))}
                      </div>
                      </div>
                      {isRainySceneKind(weatherTheme.kind) && appleScene && (
                        <HourlyForecastRainGlass
                          kind={weatherTheme.kind}
                          precipitation={weather.current.precipitation}
                          seed={appleScene.seed}
                          active={weatherAnimationActive}
                          reducedMotion={Boolean(prefersReducedMotion)}
                          className="absolute inset-0 z-[2]"
                        />
                      )}
                    </section>

                    {/* 10 日天气预报（左上大卡；三态视图：温度条 / 降水迷你柱 / 风迷你曲线） */}
                    <section className="weather-glass-panel flex flex-col overflow-hidden rounded-[26px] border border-white/10 p-4 md:col-span-2 lg:col-span-1 lg:row-span-2 lg:max-h-[320px] xl:col-span-2 xl:row-span-4 xl:max-h-none">
                      <div className="mb-1 flex shrink-0 items-center justify-between gap-2">
                        <span className="flex items-center gap-2 text-sm font-medium text-white/55">
                          <Sun className="h-4 w-4" />10 日天气预报
                          <span className="text-xs text-white/38">{dailyView === 'condition' ? '气温' : dailyView === 'precipitation' ? '降水' : '风速 (级)'}</span>
                        </span>
                        <div className="flex items-center gap-0.5 rounded-full border border-white/12 bg-black/20 p-1">
                          {([
                            ['condition', Cloud],
                            ['precipitation', Droplets],
                            ['wind', Wind],
                          ] as const).map(([view, Icon]) => (
                            <button
                              key={view}
                              type="button"
                              onClick={() => setDailyView(view)}
                              aria-label={view === 'condition' ? '按气温查看' : view === 'precipitation' ? '按降水查看' : '按风查看'}
                              aria-pressed={dailyView === view}
                              className={`flex h-6 w-8 items-center justify-center rounded-full transition-colors ${dailyView === view ? 'bg-white/18 text-white' : 'text-white/45 hover:text-white/75'}`}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="flex min-h-0 flex-1 flex-col divide-y divide-white/8 overflow-y-auto wf-no-scrollbar">
                        {weather.daily.map((day, index) => {
                          const range = Math.max(1, day.temperatureMax - day.temperatureMin)
                          const overallMin = Math.min(...weather.daily.map(item => item.temperatureMin))
                          const overallMax = Math.max(...weather.daily.map(item => item.temperatureMax))
                          const overallRange = Math.max(1, overallMax - overallMin)
                          const left = ((day.temperatureMin - overallMin) / overallRange) * 100
                          const width = Math.max(12, (range / overallRange) * 100)
                          const dayHoursFor = dailyHours.get(day.date) || []
                          const precipMax = Math.max(0.5, ...dayHoursFor.map(hour => hour.precipitation))
                          const windLevels = dayHoursFor.map(hour => windSpeedBeaufort(hour.windSpeed))
                          const windMinLevel = windLevels.length > 0 ? Math.min(...windLevels) : 0
                          const windMaxLevel = windLevels.length > 0 ? Math.max(...windLevels) : 0
                          return (
                            <button type="button" onClick={() => setSelectedDayIndex(index)} aria-label={`查看${formatWeekday(day.date, index)}详细预报`} key={day.date} className="grid flex-1 grid-cols-[52px_34px_1fr_64px_14px] items-center gap-2 rounded-lg py-1 text-left transition-colors hover:bg-white/[0.055] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/65">
                              <span className="text-sm font-medium">{formatWeekday(day.date, index)}</span>
                              <div className="flex flex-col items-center">
                                <WeatherGlyph code={day.weatherCode} className="h-5 w-5" />
                                {dailyView === 'condition' && day.precipitationProbability > 0 && <span className="text-[9px] leading-3 text-cyan-200">{Math.round(day.precipitationProbability)}%</span>}
                              </div>
                              {dailyView === 'condition' ? (
                                // 温度条视图：最低+条+最高占满中间 1fr 列
                                <div className="grid grid-cols-[38px_1fr_38px] items-center gap-2">
                                  <span className="text-right text-[13px] tabular-nums text-white/48">{Math.round(day.temperatureMin)}°</span>
                                  <div className="relative h-1 rounded-full bg-black/15">
                                    <div
                                      className="absolute h-full rounded-full bg-gradient-to-r from-cyan-300 via-amber-300 to-orange-400"
                                      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                                    />
                                  </div>
                                  <span className="text-[13px] tabular-nums">{Math.round(day.temperatureMax)}°</span>
                                </div>
                              ) : dailyView === 'precipitation' ? (
                                // 图 1055 行样式：24 根迷你柱 + 右侧"毫米/概率%"上下两行（64px 值列内不换行）
                                <div className="flex h-7 items-end gap-[1.5px]">
                                  {dayHoursFor.length > 0 ? dayHoursFor.slice(0, 24).map(hour => (
                                    <span
                                      key={hour.time}
                                      className={`w-[3px] rounded-sm ${hour.precipitation >= 0.05 ? 'bg-sky-400' : 'bg-white/12'}`}
                                      style={{ height: `${Math.max(12, hour.precipitation / precipMax * 100)}%` }}
                                    />
                                  )) : <span className="text-[11px] text-white/35">暂无逐时数据</span>}
                                </div>
                              ) : (
                                // 图 1056 行样式：迷你风速曲线（阵风暗线 + 主线 + 底部渐变填充）
                                <svg viewBox="0 0 120 24" className="h-7 w-full" preserveAspectRatio="none" aria-hidden="true">
                                  <defs>
                                    <linearGradient id={`wind-row-${day.date}`} x1="0" y1="0" x2="0" y2="1">
                                      <stop offset="0%" stopColor="#34d399" stopOpacity="0.35" />
                                      <stop offset="100%" stopColor="#0f766e" stopOpacity="0.04" />
                                    </linearGradient>
                                  </defs>
                                  <polyline
                                    points={dayHoursFor.slice(0, 24).map((hour, hourIndex) => {
                                      const level = windSpeedBeaufort(hour.windGusts || hour.windSpeed)
                                      return `${(hourIndex / Math.max(1, Math.min(23, dayHoursFor.length - 1))) * 120},${22 - (level / 8) * 20}`
                                    }).join(' ')}
                                    fill="none" stroke="#166534" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.85"
                                  />
                                  <polyline
                                    points={dayHoursFor.slice(0, 24).map((hour, hourIndex) => {
                                      const level = windSpeedBeaufort(hour.windSpeed)
                                      return `${(hourIndex / Math.max(1, Math.min(23, dayHoursFor.length - 1))) * 120},${22 - (level / 8) * 20}`
                                    }).join(' ')}
                                    fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                                  />
                                </svg>
                              )}
                              {/* 右值列：降水=毫米+概率两行；风=级数区间；温度视图空（温度在条两端） */}
                              {dailyView === 'precipitation' ? (
                                <span className="flex flex-col items-end leading-tight">
                                  <span className="text-[12px] tabular-nums text-white/85">{Math.round(day.precipitationSum * 10) / 10} 毫米</span>
                                  <span className="text-[11px] tabular-nums text-sky-300">{Math.round(day.precipitationProbability)}%</span>
                                </span>
                              ) : dailyView === 'wind' ? (
                                <span className="text-right text-[12px] tabular-nums text-emerald-200/90">{windMinLevel}-{windMaxLevel} 级</span>
                              ) : (
                                <span />
                              )}
                              <ChevronRight className="h-3.5 w-3.5 text-white/25" />
                            </button>
                          )
                        })}
                      </div>
                    </section>

                    {/* 右侧 2×2：标准高度的四张卡 */}
                    <DetailCard icon={Sun} label="紫外线指数" onClick={() => openDetailCard('uv')}>
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

                    <DetailCard icon={Wind} label="风" onClick={() => openDetailCard('wind')}>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[30px] font-semibold leading-9 tabular-nums">{Math.round(weather.current.windSpeed)}<span className="ml-1 text-base font-normal text-white/62">km/h</span></div>
                          <div className="mt-1 text-[13px] leading-5 text-white/50">{getWindDirection(weather.current.windDirection)}风 · 阵风 {Math.round(weather.current.windGusts)}</div>
                        </div>
                        <WindCompass degree={weather.current.windDirection} />
                      </div>
                    </DetailCard>

                    <button type="button" onClick={openMoon} className="text-left">
                      <div className="weather-glass-panel flex h-full min-h-[148px] flex-col rounded-[26px] border border-white/10 p-5 transition-transform hover:scale-[1.015]">
                        <div className="flex items-center gap-2 text-sm font-medium text-white/52"><MoonLucide className="h-4 w-4" />月亮</div>
                        <div className="mt-auto flex items-end justify-between gap-2 pt-3">
                          <div>
                            <div className="text-[26px] font-semibold leading-8 tracking-tight">{moonInfo.name}</div>
                            <div className="mt-1.5 text-[13px] text-white/50">照射范围 {Math.round(moonInfo.illumination * 100)}%</div>
                            <div className="text-[13px] text-white/50">下次满月 {moonInfo.nextFull} 天</div>
                            {/* 方位/高度从左上角 SkyTip 移到这里（实时天体位置） */}
                            {skyBodies && (
                              <div className="mt-1 text-[13px] text-white/50">
                                {skyBodies.moon.visible
                                  ? `月亮在${azimuthDirection(skyBodies.moon.azimuth)}方 · 高度 ${Math.round(skyBodies.moon.altitude)}°`
                                  : '月亮在地平线下'}
                              </div>
                            )}
                          </div>
                          <MoonDiscSmall phase={moonInfo.phase} />
                        </div>
                      </div>
                    </button>

                    <DetailCard icon={Sunrise} label="日出" onClick={() => openDetailCard('sun')}>
                      <div className="mt-auto flex items-end justify-between gap-2 pt-4">
                        <div>
                          <div className="text-[30px] font-semibold leading-9 tabular-nums">{formatTime(weather.daily[0]?.sunrise || '')}</div>
                          <div className="mt-1 text-[13px] text-white/50">日落 {formatTime(weather.daily[0]?.sunset || '')}</div>
                          {/* 与月亮卡对称的实时太阳位置（方位/高度），太阳在地平线下时显示昼长 */}
                          <div className="mt-1 text-[13px] text-white/50">
                            {skyBodies
                              ? (skyBodies.sun.visible
                                ? `太阳在${azimuthDirection(skyBodies.sun.azimuth)}方 · 高度 ${Math.round(skyBodies.sun.altitude)}°`
                                : `昼长 ${formatDaylight(weather.daily[0]?.daylightDuration ?? 0)}`)
                              : `日落 ${formatTime(weather.daily[0]?.sunset || '')}`}
                          </div>
                        </div>
                        {/* 迷你太阳圆盘：与月亮缩略盘同尺寸同构图 */}
                        <span className="relative block h-[76px] w-[76px] shrink-0 rounded-full"
                          style={{ background: 'radial-gradient(circle, rgba(255,236,170,0.35) 0%, rgba(255,222,130,0.08) 55%, transparent 70%)' }}>
                          <span className="absolute left-1/2 top-1/2 h-[46px] w-[46px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{ background: 'radial-gradient(circle at 42% 38%, #fff7db 0%, #ffd75e 55%, #f5a623 100%)', boxShadow: '0 0 22px rgba(255,205,90,0.55)' }} />
                        </span>
                      </div>
                    </DetailCard>


                    {/* 其余详情瓷片（点击进入详情弹窗） */}
                    <DetailCard icon={ThermometerSun} label="体感温度" value={`${Math.round(weather.current.apparentTemperature)}°`} detail={`实际温度 ${Math.round(weather.current.temperature)}°`} onClick={() => openDetailCard('feels')} />
                    <DetailCard icon={Droplets} label="湿度" value={`${Math.round(weather.current.humidity)}%`} detail="当前相对湿度" onClick={() => openDetailCard('humidity')} />
                    <DetailCard icon={Eye} label="能见度" value={`${Math.max(0.1, weather.current.visibility / 1000).toFixed(1)} 公里`} detail={weather.current.visibility >= 10000 ? '视野非常好。' : '注意低能见度。'} onClick={() => openDetailCard('visibility')} />
                    <DetailCard icon={Gauge} label="气压" value={`${Math.round(weather.current.pressure)} 百帕`} detail="地面气压" onClick={() => openDetailCard('pressure')} />
                    <DetailCard icon={Umbrella} label="降水" value={`${weather.current.precipitation.toFixed(1)} 毫米`} detail={`今日概率 ${Math.round(weather.daily[0]?.precipitationProbability || 0)}%`} onClick={() => openDetailCard('precip')} className="lg:col-span-2 xl:col-span-1" />
                    <DetailCard icon={Cloud} label="云量" value={`${Math.round(weather.current.cloudCover ?? 0)}%`} detail={getCloudCoverLabel(weather.current.cloudCover ?? 0)} onClick={() => openDetailCard('cloud')} />
                    <DetailCard icon={Droplets} label="露点温度" value={`${Math.round(currentDewPoint)}°`} detail={getDewPointLabel(currentDewPoint)} onClick={() => openDetailCard('dew')} />
                    {weather.airQuality ? (
                      <DetailCard icon={Leaf} label="空气质量" onClick={() => openDetailCard('aqi')}>
                        <div className="mt-auto flex items-baseline gap-2 pt-4">
                          <span className="text-[28px] font-semibold leading-8 tabular-nums">{Math.round(weather.airQuality.aqi)}</span>
                          <span className="text-base font-semibold" style={{ color: getAqiDescriptor(weather.airQuality.aqi).color }}>{getAqiLabel(weather.airQuality.aqi)}</span>
                        </div>
                        <div className="mt-1.5 text-[13px] text-white/50">PM2.5 {Math.round(weather.airQuality.pm25)} · PM10 {Math.round(weather.airQuality.pm10)} μg/m³</div>
                      </DetailCard>
                    ) : (
                      <DetailCard icon={Leaf} label="空气质量" value="—" detail="暂无空气质量数据" />
                    )}

                    {/* API 扩展卡：日照 / 降雪 / 月出月落 / 冻结高度 */}
                    <DetailCard icon={Sun} label="日照" value={formatDurationShort((weather.daily[0]?.sunshineDuration ?? 0) / 60)} detail={`太阳总辐射 ${Math.round((weather.daily[0]?.shortwaveRadiationSum ?? 0) * 10) / 10} MJ/m²`} onClick={() => openDetailCard('daylight')} />
                    <DetailCard icon={Cloud} label="降雪" value={`${Math.round((weather.daily[0]?.snowfallSum ?? 0) * 10) / 10} 厘米`} detail={getSnowLabel(weather.daily[0]?.snowfallSum ?? 0)} onClick={() => openDetailCard('snow')} />
                    <DetailCard icon={MoonLucide} label="月出月落" value={weather.daily[0]?.moonrise ? weather.daily[0].moonrise.slice(11, 16) : '--:--'} detail={`月落 ${weather.daily[0]?.moonset ? weather.daily[0].moonset.slice(11, 16) : '--:--'}`} onClick={() => openDetailCard('moonrise')} />
                    <DetailCard icon={Gauge} label="冻结高度" value={`${Math.round(weather.hourly[0]?.freezingLevel ?? 0).toLocaleString('zh-CN')} 米`} detail="0°C 等温面海拔" onClick={() => openDetailCard('freezing')} />

                    {/* 天气地图 */}
                    <div className="lg:col-span-3 xl:col-span-4 [&>button]:mt-0">
                      <ErrorBoundary inline inlineLabel="天气地图加载出错">
                        <WeatherMapExperience
                          weather={weather}
                          open={weatherMapOpen}
                          onOpen={openWeatherMap}
                          onClose={() => setWeatherMapOpen(false)}
                        />
                      </ErrorBoundary>
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
          {/* 回到顶部：天气/台风/地震页内容超一屏后显示（出现机制与歌单列表一致：
              超过一屏 + 阈值才出现，滚回顶部自动隐藏）。
              挂在滚动容器外层（弹窗视口层），absolute 才能固定在右下角而不是随内容滚走。 */}
          {!secondaryOverlayOpen && (
            <ScrollToTop containerRef={weatherScrollRef} position="absolute" offsetBottom={28} offsetRight={30} />
          )}
          {/* 月相页（月亮卡片点击进入） */}
          <ErrorBoundary inline inlineLabel="月相展示出错">
            <MoonPhaseExperience weather={weather} open={moonOpen} onOpen={openMoon} onClose={() => setMoonOpen(false)} />
          </ErrorBoundary>
          {/* 详情卡二级弹窗（苹果式：所有卡片均可点开；右上角菜单可直接切换指标） */}
          <WeatherCardDetailOverlay card={detailCard} weather={weather} onClose={nextCard => nextCard ? setDetailCard(nextCard) : setDetailCard(null)} />
          {weather && selectedDayIndex !== null && <WeatherDayDetail open dayIndex={selectedDayIndex} weather={weather} onClose={() => setSelectedDayIndex(null)} onSelectDay={setSelectedDayIndex} />}
          {/* 雨滴打在玻璃上的效果：盖在内容层之上，模拟整个天气视图是块被雨淋的玻璃 */}
          {isRainySceneKind(weatherTheme.kind) && <WeatherRainGlass kind={weatherTheme.kind} active={weatherAnimationActive} className="absolute inset-0 z-[4]" />}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
