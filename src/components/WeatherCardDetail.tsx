import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { getAqiDescriptor, getAqiLabel, type WeatherSnapshot } from '../services/weatherService'
import { localDateParts } from '../services/weatherTime'
import { getUvLabel, getWindDirection, WindCompass } from './weatherVisualTheme'

// 天气详情卡的二级弹窗：点击任意详情卡（紫外线/风/体感/湿度/能见度/气压/降水/日出/云量/露点/空气质量）
// 打开的 fuller 视图 —— 大数值 + 图表 + 说明，交互与月相页一致（点外部/ESC 关闭）。

export type WeatherCardKind = 'uv' | 'wind' | 'feels' | 'humidity' | 'visibility' | 'pressure' | 'precip' | 'sun' | 'cloud' | 'dew' | 'aqi'

interface CardDetailOverlayProps {
  card: WeatherCardKind | null
  weather: WeatherSnapshot | null
  onClose: () => void
}

const CARD_META: Record<WeatherCardKind, { title: string }> = {
  uv: { title: '紫外线指数' },
  wind: { title: '风' },
  feels: { title: '体感温度' },
  humidity: { title: '湿度' },
  visibility: { title: '能见度' },
  pressure: { title: '气压' },
  precip: { title: '降水' },
  sun: { title: '日出与日落' },
  cloud: { title: '云量' },
  dew: { title: '露点温度' },
  aqi: { title: '空气质量' },
}

/** 民用晨昏蒙影（civil twilight）时长：太阳从地平线下 6° 升到地平线（或反向）的分钟数。
 *  纯几何推算：分别求太阳在 0° 与 -6° 时的时角，取差——Apple「第一道晨光/最后一道暮光」
 *  与日出/日落的时间差就是这个值。极昼/极夜（无交点）回退中纬度典型 32 分钟。 */
function estimateCivilTwilightMinutes(latitude: number, date: Date): number {
  const dayOfYear = Math.floor((date.getTime() - new Date(date.getFullYear(), 0, 0).getTime()) / 86400000)
  // 太阳赤纬（近似）：-23.44° * cos(2π*(N+10)/365)
  const declination = -23.44 * Math.cos((2 * Math.PI * (dayOfYear + 10)) / 365)
  const latitudeRad = latitude * Math.PI / 180
  const declinationRad = declination * Math.PI / 180
  const cosLatitude = Math.cos(latitudeRad)
  const sinDeclination = Math.sin(declinationRad)
  const cosDeclination = Math.cos(declinationRad)
  const hourAngleDeg = (altitudeDegrees: number): number | null => {
    const cosH = (Math.sin(altitudeDegrees * Math.PI / 180) - Math.sin(latitudeRad) * sinDeclination) / (cosLatitude * cosDeclination)
    if (cosH < -1 || cosH > 1) return null
    return Math.acos(cosH) * 180 / Math.PI
  }
  const horizon = hourAngleDeg(0)
  const civil = hourAngleDeg(-6)
  if (horizon === null || civil === null) return 32
  return Math.round((Math.abs(horizon - civil) / 15) * 60)
}

function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60)
  const minutes = Math.round(totalMinutes % 60)
  return `${hours} 小时 ${minutes} 分钟`
}

function shiftTime(time: string, minutes: number): string {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return '--:--'
  date.setMinutes(date.getMinutes() + minutes)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** 日出日落附加数据：日照时长、晨昏蒙影、未来 7 天平均日出/日落（Apple 同款语义） */
function SunExtras({ sunrise, sunset, daylightDuration, sunshineDuration, daily, timeZone, latitude }: {
  sunrise: string
  sunset: string
  daylightDuration?: number
  sunshineDuration?: number
  daily: Array<{ date: string; sunrise: string; sunset: string }>
  timeZone?: string
  latitude?: number
}) {
  const twilightMinutes = useMemo(() => {
    const date = new Date(sunrise)
    if (Number.isNaN(date.getTime())) return 32
    return typeof latitude === 'number' && Number.isFinite(latitude)
      ? estimateCivilTwilightMinutes(latitude, date)
      : 32
  }, [sunrise, latitude])
  const firstLight = useMemo(() => shiftTime(sunrise, -twilightMinutes), [sunrise, twilightMinutes])
  const lastLight = useMemo(() => shiftTime(sunset, twilightMinutes), [sunset, twilightMinutes])
  const averages = useMemo(() => {
    const withSun = daily.filter(day => day.sunrise && day.sunset).slice(0, 7)
    if (withSun.length === 0) return null
    const toMinutes = (time: string) => {
      const date = new Date(time)
      return date.getHours() * 60 + date.getMinutes()
    }
    const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length)
    const fmt = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
    const sunriseValues = withSun.map(day => toMinutes(day.sunrise))
    const sunsetValues = withSun.map(day => toMinutes(day.sunset))
    // 平均日出/日落：简单算术平均会在跨 0 点（高纬夏季日出 04:xx 与冬季 07:xx）时失真，
    // 用向量平均（角度平均）处理时刻环绕
    const vectorAvg = (values: number[]) => {
      const rad = values.map(v => (v / 1440) * 2 * Math.PI)
      const x = rad.reduce((sum, r) => sum + Math.cos(r), 0) / rad.length
      const y = rad.reduce((sum, r) => sum + Math.sin(r), 0) / rad.length
      let angle = Math.atan2(y, x)
      if (angle < 0) angle += 2 * Math.PI
      return (angle / (2 * Math.PI)) * 1440
    }
    const longest = withSun.reduce((best, day) => {
      const minutes = toMinutes(day.sunset) - toMinutes(day.sunrise)
      return minutes > best.minutes ? { minutes, date: day.date } : best
    }, { minutes: -1, date: '' })
    return {
      sunrise: fmt(vectorAvg(sunriseValues)),
      sunset: fmt(vectorAvg(sunsetValues)),
      longest,
      sampleDays: withSun.length,
    }
  }, [daily])
  const todaySunrise = new Date(sunrise)
  const todaySunset = new Date(sunset)
  const todayDaylight = Number.isFinite(daylightDuration) && daylightDuration! > 0
    ? daylightDuration! / 60
    : Number.isFinite(todaySunrise.getTime()) && Number.isFinite(todaySunset.getTime())
      ? (todaySunset.getTime() - todaySunrise.getTime()) / 60000
      : 0
  return (
    <div className="mt-4 w-full overflow-hidden rounded-3xl border border-white/10">
      {[
        ['第一道晨光', firstLight],
        ['最后一道暮光', lastLight],
        ['总日照时间', formatDuration(todayDaylight)],
        ...(sunshineDuration && sunshineDuration > 0 ? [['直达日照', formatDuration(sunshineDuration / 60)] as [string, string]] : []),
      ].map(([label, value], index, all) => (
        <div key={label} className={`flex items-center justify-between px-5 py-3 text-sm ${index > 0 ? 'border-t border-white/8' : ''}`}>
          <span className="text-white/72">{label}</span>
          <span className="font-medium tabular-nums">{value}</span>
        </div>
      ))}
      {averages && (
        <>
          <div className="border-t border-white/10 px-5 pb-2 pt-3">
            <div className="text-[13px] font-medium text-white/82">日出日落平均时间</div>
            <div className="mt-0.5 text-[11px] text-white/40">基于未来 {averages.sampleDays} 天预报 · 最长日照 {formatDuration(averages.longest.minutes > 0 ? averages.longest.minutes : 0)}{averages.longest.date ? `（${Number(averages.longest.date.slice(5, 7))}月${Number(averages.longest.date.slice(8, 10))}日）` : ''}</div>
          </div>
          <div className="flex items-stretch border-t border-white/8">
            <div className="flex-1 px-5 py-3">
              <div className="text-[11px] text-white/45">平均日出</div>
              <div className="mt-0.5 text-lg font-light tabular-nums">{averages.sunrise}</div>
            </div>
            <div className="w-px bg-white/8" />
            <div className="flex-1 px-5 py-3">
              <div className="text-[11px] text-white/45">平均日落</div>
              <div className="mt-0.5 text-lg font-light tabular-nums">{averages.sunset}</div>
            </div>
          </div>
        </>
      )}
      <div className="border-t border-white/8 px-5 py-2 text-[11px] text-white/35">
        晨光/暮光为民用晨昏蒙影近似值{timeZone ? ' · 时区按当地时间显示' : ''}
      </div>
    </div>
  )
}

/** 迷你趋势图：面积填充折线 */
function MiniTrend({ values, labels, color = '#8ec9f5', unit = '', suffix = '' }: { values: number[]; labels: string[]; color?: string; unit?: string; suffix?: string }) {
  const w = 640
  const h = 190
  const padX = 10
  const padTop = 22
  const padBottom = 30
  const finite = values.filter(v => Number.isFinite(v))
  const safeValues = finite.length > 0 ? values : [0]
  const max = Math.max(...finite, 0)
  const min = Math.min(...finite, 0)
  const span = Math.max(0.001, max - min)
  const pts = safeValues.map((v, i) => {
    const x = padX + (i / Math.max(1, safeValues.length - 1)) * (w - padX * 2)
    const y = padTop + (1 - (v - min) / span) * (h - padTop - padBottom)
    return [x, y] as const
  })
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const areaPath = `${path} L${pts[pts.length - 1][0].toFixed(1)},${h - padBottom} L${pts[0][0].toFixed(1)},${h - padBottom} Z`
  const gradId = `trend-${color.replace(/[^a-z0-9]/gi, '')}`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="逐小时趋势图">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <path d={path} fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      {pts.map((p, i) => (
        i % 4 === 0 ? (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r="3" fill="#fff" />
            <text x={p[0]} y={p[1] - 10} textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.85)">{values[i]}{suffix}</text>
          </g>
        ) : null
      ))}
      {labels.map((label, i) => (
        i % 4 === 0 ? <text key={i} x={pts[i]?.[0] ?? 0} y={h - 8} textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">{label}</text> : null
      ))}
      <text x={padX} y={14} fontSize="11" fill="rgba(255,255,255,0.35)">{unit}</text>
    </svg>
  )
}

/** 日照弧线：太阳在当日轨道上的位置 */
function SunArc({ sunrise, sunset, updatedAt, timeZone }: { sunrise: string; sunset: string; updatedAt: number; timeZone?: string }) {
  const w = 560
  const h = 190
  const cx = w / 2
  const baseY = h - 36
  const r = 210
  const toMin = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16))
  const riseM = toMin(sunrise)
  const setM = toMin(sunset)
  const nowDate = new Date(updatedAt)
  const localNow = timeZone ? localDateParts(nowDate, timeZone) : { hour: nowDate.getHours(), minute: nowDate.getMinutes() }
  const nowMinutes = localNow.hour * 60 + localNow.minute
  const progress = Math.min(1, Math.max(0, (nowMinutes - riseM) / Math.max(1, setM - riseM)))
  const angle = Math.PI * (1 - progress)
  const sunX = cx - Math.cos(angle) * r * 0.92
  const sunY = baseY - Math.sin(angle) * (r * 0.52)
  const below = nowMinutes < riseM || nowMinutes > setM
  const dayMinutes = Math.max(0, setM - riseM)
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
        <path d={`M ${cx - r * 0.92} ${baseY} Q ${cx} ${baseY - r * 1.04}, ${cx + r * 0.92} ${baseY}`} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="2" strokeDasharray="1 7" strokeLinecap="round" />
        <line x1={cx - r} y1={baseY} x2={cx + r} y2={baseY} stroke="rgba(255,255,255,0.4)" strokeWidth="2" strokeLinecap="round" />
        <circle cx={sunX} cy={sunY} r="13" fill={below ? 'rgba(255,255,255,0.25)' : '#ffd257'} />
        {below && <circle cx={sunX} cy={sunY} r="13" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2" strokeDasharray="3 4" />}
        <text x={cx - r} y={baseY + 22} textAnchor="middle" fontSize="13" fill="rgba(255,255,255,0.6)">{sunrise.slice(11, 16)}</text>
        <text x={cx + r} y={baseY + 22} textAnchor="middle" fontSize="13" fill="rgba(255,255,255,0.6)">{sunset.slice(11, 16)}</text>
      </svg>
      <div className="mt-1 text-center text-[13px] text-white/55">昼长 {Math.floor(dayMinutes / 60)} 小时 {dayMinutes % 60} 分钟{below ? ' · 太阳在地平线下' : ''}</div>
    </div>
  )
}

export default function WeatherCardDetailOverlay({ card, weather, onClose }: CardDetailOverlayProps) {
  // 挂起（所属模式层被切走）时不渲染这个 portal：portal 挂在 body 上，不受挂起层
  // visibility:hidden 约束，留着会盖住当前模式。只隐藏不卸载，切回来状态原样。
  const parked = useModeParked()
  if (typeof document === 'undefined') return null

  const hourlyLabels = useMemo(() => {
    if (!weather) return []
    return weather.hourly.slice(0, 25).map((hour, index) => index === 0 ? '现在' : `${hour.time.slice(11, 13)}时`)
  }, [weather])

  const currentHourly = useMemo(() => {
    if (!weather) return undefined
    return weather.hourly.find(item => item.time >= weather.current.time) ?? weather.hourly[0]
  }, [weather])

  const meta = card ? CARD_META[card] : null

  if (parked) return null

  return createPortal(
    <AnimatePresence>
      {card && weather && meta && (
        <motion.div
          className="fixed inset-0 z-[420] flex items-center justify-center overflow-hidden bg-transparent p-4 text-white sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="max-h-[calc(100vh-2rem)] max-h-[calc(100dvh-2rem)] w-full max-w-[640px] overflow-y-auto overscroll-contain rounded-[32px] border border-white/14 bg-slate-950/85 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl sm:max-h-[calc(100dvh-3rem)] sm:p-7"
            role="dialog"
            aria-modal="true"
            aria-labelledby="weather-card-detail-title"
            data-tv-scope
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div id="weather-card-detail-title" className="text-lg font-semibold">{meta.title}</div>
              <button
                type="button"
                autoFocus
                onClick={onClose}
                aria-label={`关闭${meta.title}详情`}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-white/70 transition-colors hover:bg-white/16"
              >
                <X className="h-4.5 w-4.5" />
              </button>
            </div>

            <div className="mt-5">
              {card === 'uv' && (
                <>
                  <div className="flex items-end gap-3">
                    <span className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.daily[0]?.uvIndexMax || 0)}</span>
                    <span className="pb-1 text-lg text-white/75">{getUvLabel(weather.daily[0]?.uvIndexMax || 0)}</span>
                  </div>
                  <div className="relative mt-4 h-2 rounded-full" style={{ background: 'linear-gradient(90deg,#5ac8fa,#32d74b,#ffd60a,#ff9f0a,#ff453a,#bf5af2)' }}>
                    <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900" style={{ left: `${Math.min(100, (Math.min(11, weather.daily[0]?.uvIndexMax || 0) / 11) * 100)}%` }} />
                  </div>
                  <p className="mt-3 text-sm text-white/55">今日紫外线最强时段约 11:00–15:00，长时间户外建议防晒。</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.uvIndex))} labels={hourlyLabels} color="#bf5af2" unit="UV 指数" /></div>
                </>
              )}
              {card === 'wind' && (
                <>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.windSpeed)}<span className="ml-2 text-lg text-white/65">km/h</span></div>
                      <div className="mt-2 text-sm text-white/60">{getWindDirection(weather.current.windDirection)}风 · 阵风 {Math.round(weather.current.windGusts)} km/h</div>
                    </div>
                    <WindCompass degree={weather.current.windDirection} />
                  </div>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.windSpeed))} labels={hourlyLabels} color="#7dd3fc" unit="风速 km/h" /></div>
                </>
              )}
              {card === 'feels' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.apparentTemperature)}°</div>
                  <p className="mt-2 text-sm text-white/55">体感综合了湿度与风速对体感温度的影响，实际温度 {Math.round(weather.current.temperature)}°。</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.apparentTemperature))} labels={hourlyLabels} color="#fca5a5" unit="体感温度 °" /></div>
                </>
              )}
              {card === 'humidity' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.humidity)}%</div>
                  <p className="mt-2 text-sm text-white/55">相对湿度 {Math.round(weather.current.humidity) > 75 ? '较高，体感闷湿。' : Math.round(weather.current.humidity) < 40 ? '较低，注意补水。' : '适中，体感舒适。'}</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.humidity ?? weather.current.humidity))} labels={hourlyLabels} color="#67e8f9" unit="湿度 %" /></div>
                </>
              )}
              {card === 'visibility' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.max(0.1, weather.current.visibility / 1000).toFixed(1)}<span className="ml-2 text-lg text-white/65">公里</span></div>
                  <p className="mt-2 text-sm text-white/55">{weather.current.visibility >= 10000 ? '视野非常好，远眺清晰。' : '能见度偏低，出行注意安全。'}</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.visibility / 100) / 10)} labels={hourlyLabels} color="#a5b4fc" unit="能见度 公里" /></div>
                </>
              )}
              {card === 'pressure' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.pressure)}<span className="ml-2 text-lg text-white/65">百帕</span></div>
                  <p className="mt-2 text-sm text-white/55">地面气压{weather.current.pressure >= 1013 ? '偏高，天气稳定。' : '偏低，注意天气变化。'}</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.pressure ?? weather.current.pressure))} labels={hourlyLabels} color="#c4b5fd" unit="气压 百帕" /></div>
                </>
              )}
              {card === 'precip' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{weather.current.precipitation.toFixed(1)}<span className="ml-2 text-lg text-white/65">毫米</span></div>
                  <p className="mt-2 text-sm text-white/55">今日降水概率 {Math.round(weather.daily[0]?.precipitationProbability || 0)}%，未来 24 小时降水分布如下。</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.precipitationProbability))} labels={hourlyLabels} color="#38bdf8" unit="降水概率 %" suffix="%" /></div>
                </>
              )}
              {card === 'sun' && weather.daily[0]?.sunrise && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-white/55">日出</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[0].sunrise.slice(11, 16)}</div>
                    </div>
                    <div>
                      <div className="text-sm text-white/55">日落</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[0].sunset.slice(11, 16)}</div>
                    </div>
                  </div>
                  <div className="mt-3"><SunArc sunrise={weather.daily[0].sunrise} sunset={weather.daily[0].sunset} updatedAt={weather.updatedAt} timeZone={weather.timezone} /></div>
                  <SunExtras
                    sunrise={weather.daily[0].sunrise}
                    sunset={weather.daily[0].sunset}
                    daylightDuration={weather.daily[0].daylightDuration}
                    sunshineDuration={weather.daily[0].sunshineDuration}
                    daily={weather.daily}
                    timeZone={weather.timezone}
                    latitude={weather.location.latitude}
                  />
                </>
              )}
              {card === 'cloud' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.cloudCover ?? 0)}<span className="ml-2 text-lg text-white/65">%</span></div>
                  <p className="mt-2 text-sm text-white/55">{(weather.current.cloudCover ?? 0) < 35 ? '天空以晴为主。' : (weather.current.cloudCover ?? 0) < 70 ? '云量适中，间或有阳光。' : '云层厚密，天空阴沉。'}</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.cloudCover ?? 0))} labels={hourlyLabels} color="#93c5fd" unit="云量 %" suffix="%" /></div>
                </>
              )}
              {card === 'dew' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(currentHourly?.dewPoint ?? 0)}°</div>
                  <p className="mt-2 text-sm text-white/55">露点接近气温时空气接近饱和，{(currentHourly?.dewPoint ?? 0) >= 21 ? '闷热感明显。' : (currentHourly?.dewPoint ?? 0) >= 16 ? '略感潮湿。' : '体感较为干爽。'}</p>
                  <div className="mt-4"><MiniTrend values={weather.hourly.slice(0, 25).map(h => Math.round(h.dewPoint ?? 0))} labels={hourlyLabels} color="#5eead4" unit="露点温度 °" /></div>
                </>
              )}
              {card === 'aqi' && (
                <>
                  <div className="flex items-baseline gap-3">
                    <span className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.airQuality?.aqi ?? 0)}</span>
                    <span className="text-lg font-semibold" style={{ color: getAqiDescriptor(weather.airQuality?.aqi ?? Number.NaN).color }}>{getAqiLabel(weather.airQuality?.aqi ?? Number.NaN)}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                      <div className="text-white/45">PM2.5</div>
                      <div className="mt-1 font-medium tabular-nums">{Math.round(weather.airQuality?.pm25 ?? 0)} μg/m³</div>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
                      <div className="text-white/45">PM10</div>
                      <div className="mt-1 font-medium tabular-nums">{Math.round(weather.airQuality?.pm10 ?? 0)} μg/m³</div>
                    </div>
                  </div>
                  {(weather.airQuality?.hourlyAqi?.length ?? 0) > 0 && (
                    <div className="mt-4">
                      <MiniTrend
                        values={weather.airQuality!.hourlyAqi.map(item => Math.round(item.aqi))}
                        labels={weather.airQuality!.hourlyAqi.map((item, index) => index === 0 ? '现在' : `${item.time.slice(11, 13)}时`)}
                        color={getAqiDescriptor(weather.airQuality?.aqi ?? Number.NaN).color}
                        unit="AQI 指数"
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}