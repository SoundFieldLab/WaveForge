import { useEffect, useState } from 'react'
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
  Navigation,
  Sun,
  Sunrise,
  Sunset,
  ThermometerSun,
  Umbrella,
  Wind,
  X,
  RefreshCw,
} from 'lucide-react'
import { getWeatherLabel, getWeatherLocationAddress, getWeatherLocationName, WeatherSnapshot } from '../services/weatherService'
import type { HazardSnapshot } from '../services/hazardService'
import WeatherHazardsPanel, { type WeatherHazardTab } from './WeatherHazardsPanel'
import WeatherMapExperience from './WeatherMapExperience'
// 纯函数/常量/类型与纯视觉组件从轻量模块复用（桌面小组件静态依赖它，避免把 leaflet 拉进桌面模式）。
import { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, type WeatherDetailsTab } from './weatherVisualTheme'
export { WeatherGlyph, getWeatherVisualTheme, WeatherAtmosphere, type WeatherVisualTheme, type WeatherSceneKind, type WeatherDetailsTab } from './weatherVisualTheme'

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

const getUvLabel = (value: number) => value < 3 ? '低' : value < 6 ? '中等' : value < 8 ? '较高' : value < 11 ? '很高' : '极高'
const getWindDirection = (degree: number) => {
  const directions = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return directions[Math.round(degree / 45) % 8]
}

export default function WeatherDetailsModal({ open, weather, onClose, onRefresh, loading, hazards, hazardLoading, hazardError = '', initialTab = 'weather', onHazardRefresh }: WeatherDetailsModalProps) {
  const [activeTab, setActiveTab] = useState<WeatherDetailsTab>(initialTab)
  const [weatherMapOpen, setWeatherMapOpen] = useState(false)

  useEffect(() => {
    if (open) setActiveTab(initialTab)
    else setWeatherMapOpen(false)
  }, [initialTab, open])

  // TV 遥控器 BACK：先收地图子层，再关弹窗（与 ESC 语义一致；带 open 守卫，
  // 本组件经 DesktopWidgetZone 常驻挂载，无守卫会吞掉全场景 BACK 键）
  useTvBack(() => {
    if (!open) return false
    if (weatherMapOpen) setWeatherMapOpen(false)
    else onClose()
    return true
  })

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (weatherMapOpen) setWeatherMapOpen(false)
        else onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose, weatherMapOpen])

  if (typeof document === 'undefined') return null
  const weatherTheme = getWeatherVisualTheme(weather?.current.weatherCode ?? 2, weather?.current.isDay ?? true)

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[400] overflow-hidden bg-slate-950 text-white"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <WeatherAtmosphere theme={weatherTheme} />
          <motion.div
            initial={{ y: 18, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 14, opacity: 0 }}
            transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
            className="absolute inset-0 overflow-y-auto custom-scrollbar"
          >
            <div className="relative mx-auto min-h-full w-full max-w-[1120px] px-7 py-8 md:px-12 md:py-10">
              <div className="flex items-start justify-between gap-6">
                <div>
                  <div className="text-sm font-medium tracking-[0.18em] text-white/60">
                    {weather?.location.source === 'ip' ? '我的位置 · 自动定位' : '自定义位置'}
                  </div>
                  <h2 className="mt-2 text-4xl font-semibold tracking-tight">{weather ? getWeatherLocationName(weather.location) : '天气'}</h2>
                  {weather && (
                    <p className="mt-1 text-sm text-white/55">
                      {getWeatherLocationAddress(weather.location)}
                    </p>
                  )}
                  {weather && (
                    <div className="mt-3 flex items-center gap-1.5 text-xs text-white/45">
                      <Clock3 className="h-3.5 w-3.5" />
                      {loading
                        ? '正在更新天气…'
                        : `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(weather.updatedAt)}`}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
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
              </div>

              <div className="mt-7 flex w-fit items-center gap-1 rounded-full border border-white/12 bg-black/15 p-1.5 backdrop-blur-xl">
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

              {activeTab !== 'weather' ? (
                <WeatherHazardsPanel
                  tab={activeTab}
                  weather={weather}
                  hazards={hazards}
                  loading={hazardLoading}
                  error={hazardError}
                  onRefresh={onHazardRefresh}
                />
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
                  <div className="mt-8 flex items-end justify-between gap-8 rounded-[30px] border border-white/10 bg-black/10 px-6 py-7">
                    <div>
                      <div className="text-[7.5rem] font-extralight leading-[0.82] tracking-[-0.08em] tabular-nums">
                        {Math.round(weather.current.temperature)}°
                      </div>
                      <div className="mt-6 text-2xl font-medium text-white/78">{getWeatherLabel(weather.current.weatherCode)}</div>
                      <div className="mt-2 text-base text-white/55">
                        最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}° · 最低 {Math.round(weather.daily[0]?.temperatureMin ?? weather.current.temperature)}°
                      </div>
                      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-sm text-white/55">
                        <span>体感 {Math.round(weather.current.apparentTemperature)}°</span>
                        <span>湿度 {Math.round(weather.current.humidity)}%</span>
                        <span>风速 {Math.round(weather.current.windSpeed)} km/h</span>
                      </div>
                    </div>
                    <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="h-28 w-28 text-white/90 drop-shadow-2xl" />
                  </div>

                  {weather.alerts.length > 0 && (
                    <div className="mt-8 space-y-3">
                      {weather.alerts.map(alert => (
                        <div
                          key={alert.id}
                          className="rounded-3xl border px-5 py-4"
                          style={{
                            borderColor: alert.level === 'extreme' ? 'rgba(251,113,133,0.55)' : 'rgba(251,191,36,0.45)',
                            background: alert.level === 'extreme' ? 'rgba(159,18,57,0.28)' : 'rgba(146,64,14,0.24)',
                          }}
                        >
                          <div className="flex items-start gap-3">
                            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
                            <div>
                              <div className="font-semibold">{alert.title}</div>
                              <p className="mt-1 text-sm leading-6 text-white/68">{alert.message}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <section className="weather-glass-panel mt-8 rounded-[30px] border border-white/10 p-5">
                    <div className="mb-4 flex items-center justify-between gap-3"><span className="text-sm font-medium text-white/55">未来 24 小时</span><span className="text-xs text-white/30">从现在到 24 小时后</span></div>
                    <div className="flex gap-3 overflow-x-auto pb-2 custom-scrollbar">
                      {weather.hourly.slice(0, 25).map((hour, index) => (
                        <div key={hour.time} className="flex min-w-[74px] flex-col items-center border-r border-white/10 px-3 py-4 last:border-r-0">
                          <span className="text-sm font-medium text-white/70">{formatHour(hour.time, index)}</span>
                          <WeatherGlyph code={hour.weatherCode} isDay={isHourDaylight(hour.time, weather)} className="my-4 h-7 w-7 text-white/85" />
                          <span className="text-lg font-semibold tabular-nums">{Math.round(hour.temperature)}°</span>
                          <span className="mt-2 text-xs font-medium text-cyan-200/75">{hour.precipitationProbability > 0 ? `${Math.round(hour.precipitationProbability)}%` : ' '}</span>
                        </div>
                      ))}
                    </div>
                  </section>

                  <section className="weather-glass-panel mt-5 rounded-[30px] border border-white/10 p-5">
                    <div className="mb-3 text-sm font-medium text-white/55">10 日天气预报</div>
                    <div className="divide-y divide-white/10">
                      {weather.daily.map((day, index) => {
                        const range = Math.max(1, day.temperatureMax - day.temperatureMin)
                        const overallMin = Math.min(...weather.daily.map(item => item.temperatureMin))
                        const overallMax = Math.max(...weather.daily.map(item => item.temperatureMax))
                        const overallRange = Math.max(1, overallMax - overallMin)
                        const left = ((day.temperatureMin - overallMin) / overallRange) * 100
                        const width = Math.max(12, (range / overallRange) * 100)
                        return (
                          <div key={day.date} className="grid grid-cols-[72px_52px_48px_1fr_48px] items-center gap-3 py-3.5">
                            <span className="font-medium">{formatWeekday(day.date, index)}</span>
                            <div className="flex flex-col items-center">
                              <WeatherGlyph code={day.weatherCode} className="h-6 w-6 text-white/85" />
                              {day.precipitationProbability > 0 && <span className="mt-1 text-[10px] text-cyan-200">{Math.round(day.precipitationProbability)}%</span>}
                            </div>
                            <span className="text-right tabular-nums text-white/45">{Math.round(day.temperatureMin)}°</span>
                            <div className="relative h-1.5 rounded-full bg-black/15">
                              <div
                                className="absolute h-full rounded-full bg-gradient-to-r from-cyan-300 via-amber-300 to-orange-400"
                                style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                              />
                            </div>
                            <span className="tabular-nums">{Math.round(day.temperatureMax)}°</span>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <WeatherMapExperience
                    weather={weather}
                    open={weatherMapOpen}
                    onOpen={() => setWeatherMapOpen(true)}
                    onClose={() => setWeatherMapOpen(false)}
                  />

                  <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-3">
                    {[
                      { icon: ThermometerSun, label: '体感温度', value: `${Math.round(weather.current.apparentTemperature)}°`, detail: `实际温度 ${Math.round(weather.current.temperature)}°` },
                      { icon: Wind, label: '风', value: `${Math.round(weather.current.windSpeed)} km/h`, detail: `${getWindDirection(weather.current.windDirection)}风 · 阵风 ${Math.round(weather.current.windGusts)}` },
                      { icon: Droplets, label: '湿度', value: `${Math.round(weather.current.humidity)}%`, detail: '当前相对湿度' },
                      { icon: Eye, label: '能见度', value: `${Math.max(0.1, weather.current.visibility / 1000).toFixed(1)} km`, detail: weather.current.visibility >= 10000 ? '视野良好' : '注意低能见度' },
                      { icon: Gauge, label: '气压', value: `${Math.round(weather.current.pressure)} hPa`, detail: '地面气压' },
                      { icon: Umbrella, label: '降水', value: `${weather.current.precipitation.toFixed(1)} mm`, detail: `今日概率 ${Math.round(weather.daily[0]?.precipitationProbability || 0)}%` },
                      { icon: Sun, label: '紫外线', value: `${Math.round(weather.daily[0]?.uvIndexMax || 0)} · ${getUvLabel(weather.daily[0]?.uvIndexMax || 0)}`, detail: '今日最高指数' },
                      { icon: Sunrise, label: '日出', value: formatTime(weather.daily[0]?.sunrise || ''), detail: `日落 ${formatTime(weather.daily[0]?.sunset || '')}` },
                      { icon: Navigation, label: '位置', value: getWeatherLocationName(weather.location), detail: getWeatherLocationAddress(weather.location) },
                    ].map(item => {
                      const Icon = item.icon
                      return (
                        <div key={item.label} className="weather-glass-panel min-h-[150px] rounded-[26px] border border-white/10 p-5">
                          <div className="flex items-center gap-2 text-sm font-medium text-white/48"><Icon className="h-4 w-4" />{item.label}</div>
                          <div className="mt-5 break-words text-2xl font-medium tracking-tight">{item.value}</div>
                          <div className="mt-2 text-sm leading-5 text-white/48">{item.detail}</div>
                        </div>
                      )
                    })}
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
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}


