import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { ChevronDown } from 'lucide-react'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { getAqiDescriptor, getAqiLabel, getWeatherLabel, type WeatherSnapshot, type WeatherHour } from '../services/weatherService'
import { localDateParts } from '../services/weatherTime'
import { sunSkyPosition } from '../services/moonPhase'
import { getUvLabel, getWindDirection, WindCompass } from './weatherVisualTheme'
import { MoonDisc } from './MoonPhaseExperience'

// 天气详情卡的二级弹窗：点击任意详情卡（紫外线/风/体感/湿度/能见度/气压/降水/日出/云量/露点/空气质量）
// 打开的 fuller 视图 —— 大数值 + 图表 + 说明 + 日期选择 + 每日摘要/比较，交互与月相页一致（点外部/ESC 关闭）。

export type WeatherCardKind = 'uv' | 'wind' | 'feels' | 'humidity' | 'visibility' | 'pressure' | 'precip' | 'sun' | 'cloud' | 'dew' | 'aqi' | 'snow' | 'daylight' | 'moonrise' | 'freezing'

interface CardDetailOverlayProps {
  card: WeatherCardKind | null
  weather: WeatherSnapshot | null
  /** 关闭；传入 kind 时语义为"切换到该指标弹窗"（父级置新 card 而非关闭） */
  onClose: (nextCard?: WeatherCardKind) => void
}

const CARD_META: Record<WeatherCardKind, { title: string }> = {
  uv: { title: '紫外线指数' },
  wind: { title: '风' },
  feels: { title: '天气状况' },
  humidity: { title: '湿度' },
  visibility: { title: '能见度' },
  pressure: { title: '气压' },
  precip: { title: '降水' },
  sun: { title: '日出与日落' },
  cloud: { title: '云量' },
  dew: { title: '露点温度' },
  aqi: { title: '空气质量' },
  snow: { title: '降雪' },
  daylight: { title: '日照' },
  moonrise: { title: '月出与月落' },
  freezing: { title: '冻结高度' },
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 顶部日期选择条（Apple 式）：周几 + 日期大字，选中日蓝底圆点；点选后所有图表切到该日 */
function DaySelector({ weather, selected, onChange }: { weather: WeatherSnapshot; selected: number; onChange: (index: number) => void }) {
  const todayParts = localDateParts(new Date(), weather.timezone)
  const todayDateString = `${todayParts.year}-${String(todayParts.month).padStart(2, '0')}-${String(todayParts.day).padStart(2, '0')}`
  const items = weather.daily.slice(0, 10).map((day, index) => {
    const weekday = new Date(`${day.date}T12:00:00`).getDay()
    const dayNumber = Number(day.date.slice(8, 10))
    return { index, weekday: index === 0 ? '今天' : WEEKDAY_LABELS[weekday], dayNumber, isToday: day.date === todayDateString }
  })
  return (
    <div className="wf-no-scrollbar -mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1">
      {items.map(item => (
        <button
          key={item.index}
          type="button"
          onClick={() => onChange(item.index)}
          aria-pressed={selected === item.index}
          className={`flex min-w-[54px] flex-col items-center gap-1.5 rounded-2xl px-2.5 py-2 transition-colors ${selected === item.index ? 'bg-sky-500/30' : 'hover:bg-white/8'}`}
        >
          <span className={`text-[11px] font-medium ${selected === item.index ? 'text-sky-200' : 'text-white/45'}`}>{item.weekday}</span>
          <span className={`flex h-8 w-8 items-center justify-center rounded-full text-[15px] font-semibold tabular-nums ${
            selected === item.index ? 'bg-sky-400 text-slate-950' : item.isToday ? 'text-sky-300' : 'text-white/85'
          }`}>{item.dayNumber}</span>
        </button>
      ))}
    </div>
  )
}

/** 每日摘要卡（Apple 式）：选中日的自然语言段落；dayIndex=0 时以"现在"开头（图 1069 样式） */
function DailySummary({ weather, dayIndex, kind }: { weather: WeatherSnapshot; dayIndex: number; kind: WeatherCardKind }) {
  const text = useMemo(() => {
    const day = weather.daily[dayIndex]
    if (!day) return ''
    const hours = weather.hourly.filter(hour => hour.time.slice(0, 10) === day.date)
    if (hours.length === 0) return ''
    const fmtTime = (time: string) => `${time.slice(11, 13)}:${time.slice(14, 16)}`
    const temps = hours.map(hour => hour.temperature)
    const maxTemp = Math.max(...temps)
    const minTemp = Math.min(...temps)
    const apparent = hours.map(hour => hour.apparentTemperature)
    const maxApparent = Math.max(...apparent)
    const minApparent = Math.min(...apparent)
    const precipSum = hours.reduce((sum, hour) => sum + Math.max(0, hour.precipitation), 0)
    const precipProb = Math.max(...hours.map(hour => hour.precipitationProbability))
    const gustMax = Math.max(...hours.map(hour => hour.windGusts || 0))
    const uvMax = Math.max(...hours.map(hour => hour.uvIndex || 0))
    const visibilityMin = Math.min(...hours.map(hour => hour.visibility || 0))
    const parts: string[] = []
    // Apple 式开头：dayIndex=0 用"现在 X°，<天况>"实时句
    if (dayIndex === 0) {
      parts.push(`现在 ${Math.round(weather.current.temperature)}°，${getWeatherLabel(weather.current.weatherCode)}。`)
    } else {
      parts.push(`${Number(day.date.slice(5, 7))}月${Number(day.date.slice(8, 10))}日，${getWeatherConditionText(hours)}。`)
    }
    parts.push(`气温 ${Math.round(minTemp)}° 至 ${Math.round(maxTemp)}°，体感 ${Math.round(minApparent)}° 至 ${Math.round(maxApparent)}°`)
    if (precipProb >= 30 || precipSum >= 0.2) {
      const wet = hours.filter(hour => hour.precipitation >= 0.1)
      const first = wet[0]
      parts.push(`降水概率最高 ${Math.round(precipProb)}%，累计约 ${precipSum.toFixed(1)} 毫米${first ? `，${fmtTime(first.time)} 前后开始` : ''}`)
    } else {
      parts.push('预计无明显降水')
    }
    if (gustMax >= 25) parts.push(`阵风最高可达 ${Math.round(gustMax)} 公里/时`)
    if (uvMax >= 3) parts.push(`紫外线最强 ${Math.round(uvMax)}（${getUvLabel(uvMax)}），注意防晒`)
    if (visibilityMin < 5000) parts.push('部分时段能见度较低，出行留意')
    return parts.join('。') + (parts.length > 1 ? '。' : '')
  }, [weather, dayIndex])
  if (!text) return null
  return (
    <div className="mt-6">
      <SectionTitle>每日摘要</SectionTitle>
      <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-[15px] leading-7 text-white/85">{text}</div>
      <KindFootnote kind={kind} />
    </div>
  )
}

/** Apple 式"关于 XX"科普段（图 1066/1071/1072/1074 底部说明文字） */
function KindFootnote({ kind }: { kind: WeatherCardKind }) {
  const text: Partial<Record<WeatherCardKind, string>> = {
    feels: '体感温度传达身体感觉到的冷暖，与实际温度可能不尽相同。体感温度受湿度、光照和风影响。',
    uv: '世界卫生组织 (WHO) 的紫外线指数 (UVI) 测量紫外线辐射。UVI 越高，潜在伤害就越大，造成伤害的速度也越快。WHO 建议在 UVI 等级为 3 级（中等）或更高时，使用太阳镜、防晒霜、帽子和防晒衣物。',
    wind: '风速的计算取短时间内的平均值。阵风是高于此平均值的短暂强风。阵风的持续时间通常低于 20 秒。',
    humidity: '相对湿度，一般简称为湿度，是空气中含水量与空气可容纳水量的比值。气温越高，空气可容纳的水量就越多。若相对湿度接近 100%，则意味着可能结露或起雾。',
    dew: '露点温度是露水凝结所需降至的温度。它可用于判断人体所感觉的空气湿度，露点温度越高，体感湿度越高。若露点温度与当前温度相同，则意味着相对湿度达 100%，可能结露或起雾。',
    visibility: '能见度会告诉你你可以清晰地看到多远以外的物体，如建筑和山丘等。能见度测量大气透明度，不考虑光照强度或障碍物。能见度 10 公里及以上为良好。',
    pressure: '气压的显著急剧变化可用于预测天气变化。例如，气压下降通常意味着天气变差，气压上升则意味着天气好转。',
    precip: '降水量是指在某一时段内，从天空降落到地面的液态或固态（经融化后）降水，未经蒸发、渗透、流失而在水平面上积聚的深度。',
    cloud: '云量是天空被云遮蔽的比例。云量影响昼夜温差与降水可能性：云层厚密时白天升温慢、夜间降温也慢。',
    snow: '降雪量按融化后的水当量记录，积雪深度则是地面上实际积雪的厚度。新增降雪与积雪深度会因融化、压实而不同。',
    daylight: '日照时长反映当日太阳可供利用的光照资源，受季节和云量共同影响。太阳总辐射（MJ/m²）是全天到达地面的太阳能总量。',
    moonrise: '月亮每天平均延迟约 50 分钟升起。月出月落时间随月相与观测地位置逐日变化，满月前后整夜可见月亮。',
    freezing: '冻结高度是大气中 0°C 等温面的海拔高度，决定了降水以雨或雪的形式落地，是冬季出行与山区活动的重要参考。',
  }
  const content = text[kind]
  if (!content) return null
  return (
    <div className="mt-6">
      <SectionTitle>关于{CARD_META[kind].title}</SectionTitle>
      <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-sm leading-6 text-white/62">{content}</div>
    </div>
  )
}

const getWeatherConditionText = (hours: WeatherHour[]) => {
  const counts = new Map<number, number>()
  for (const hour of hours) counts.set(hour.weatherCode, (counts.get(hour.weatherCode) || 0) + 1)
  let dominant = 0
  let maxCount = -1
  for (const [code, count] of counts) if (count > maxCount) { dominant = code; maxCount = count }
  if (dominant === 0) return '天气晴朗'
  if (dominant <= 2) return '多云为主'
  if (dominant <= 48) return '以阴雾天气为主'
  if (dominant <= 57) return '有毛毛雨'
  if (dominant <= 67 || (dominant >= 80 && dominant <= 82)) return '有降雨过程'
  if (dominant <= 77) return '有降雪'
  if (dominant >= 95) return '有雷雨天气'
  return '天气多变'
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[19px] font-semibold tracking-tight">{children}</div>
}

/** 蒲福风级换算（km/h 阈值，0-12 级） */
const windSpeedBeaufortKmh = (kmh: number) => {
  const thresholds = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 117]
  for (let level = 0; level < thresholds.length; level += 1) {
    if (kmh < thresholds[level]) return level
  }
  return 12
}

/** AQI 等级建议语（Apple 式） */
const aqiAdvisory = (aqi: number) => {
  if (!Number.isFinite(aqi)) return ''
  if (aqi < 20) return '空气非常洁净，适合一切户外活动。'
  if (aqi < 40) return '空气质量可以接受，绝大多数人可正常户外活动。'
  if (aqi < 60) return '敏感人群应减少长时间户外剧烈活动。'
  if (aqi < 80) return '建议减少户外活动，外出可佩戴口罩。'
  return '尽量留在室内并开启空气净化。'
}

/** 污染物行（Apple 空气质量页样式：名称 + 浓度 + 按相对等级着色）。
 *  浓度阈值参考欧洲 AQI 分级对应的污染物浓度限值（μg/m³）。 */
const pollutantRows = (aq: WeatherSnapshot['airQuality']) => {
  if (!aq) return [] as Array<{ label: string; text: string; color: string }>
  const levelColor = (value: number | undefined, good: number, fair: number, poor: number) => {
    const safe = Number(value)
    if (!Number.isFinite(safe) || safe <= 0) return 'rgba(148,163,184,.5)'
    if (safe <= good) return '#22c55e'
    if (safe <= fair) return '#eab308'
    if (safe <= poor) return '#f97316'
    return '#ef4444'
  }
  const fmt = (value: number | undefined, unit = ' μg/m³') => Number.isFinite(value) && (value as number) > 0
    ? `${Math.round(value as number) * 10 / 10}${unit}`
    : '—'
  const rows: Array<{ label: string; text: string; color: string }> = [
    { label: 'PM2.5', text: fmt(aq.pm25), color: levelColor(aq.pm25, 10, 20, 25) },
    { label: 'PM10', text: fmt(aq.pm10), color: levelColor(aq.pm10, 20, 40, 50) },
    { label: '臭氧 O₃', text: fmt(aq.ozone), color: levelColor(aq.ozone, 60, 100, 120) },
    { label: '二氧化氮 NO₂', text: fmt(aq.nitrogenDioxide), color: levelColor(aq.nitrogenDioxide, 40, 90, 120) },
    { label: '二氧化硫 SO₂', text: fmt(aq.sulphurDioxide), color: levelColor(aq.sulphurDioxide, 40, 80, 100) },
  ]
  if (Number.isFinite(aq.carbonMonoxide) && (aq.carbonMonoxide ?? 0) > 0) rows.push({ label: '一氧化碳 CO', text: fmt(aq.carbonMonoxide), color: levelColor(aq.carbonMonoxide, 4000, 8000, 12000) })
  return rows
}

/** 风向箭头（气象惯例：箭头指向风吹去的方向；windDirection 是风来的方向，画时 +180°） */
function WindArrowGlyph({ degree, className = '' }: { degree: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={{ transform: `rotate(${(degree + 180) % 360}deg)` }} aria-hidden="true">
      <path d="M12 3 L12 21 M12 3 L7.5 8 M12 3 L16.5 8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** 风卡顶部的逐时风向箭头排（Apple 风详情同款） */
function WindDirectionStrip({ hours }: { hours: WeatherHour[] }) {
  if (hours.length === 0) return null
  return (
    <div className="wf-no-scrollbar -mx-1 mt-3 flex gap-0 overflow-x-auto px-1">
      {hours.slice(0, 13).map((hour, index) => (
        <div key={hour.time} className="flex min-w-[46px] flex-1 flex-col items-center gap-1 border-r border-white/8 py-1 last:border-r-0">
          <WindArrowGlyph degree={hour.windDirection} className="h-4 w-4 text-white/85" />
          <span className="text-[10px] text-white/40">{index === 0 ? '现在' : `${hour.time.slice(11, 13)}时`}</span>
        </div>
      ))}
    </div>
  )
}

/** 阵风双层曲线：亮色=平均风速（下方填充），暗色=阵风（Apple 风详情同款） */
function WindGustTrend({ hours }: { hours: WeatherHour[] }) {
  const values = hours.map(hour => Math.round(hour.windSpeed))
  const gusts = hours.map(hour => Math.round(hour.windGusts || 0))
  const w = 640
  const h = 210
  const padX = 14
  const padTop = 26
  const padBottom = 30
  const all = [...values, ...gusts].filter(Number.isFinite)
  const max = Math.max(4, ...all) * 1.08
  const pts = (series: number[]) => series.map((v, i) => {
    const x = padX + (i / Math.max(1, series.length - 1)) * (w - padX * 2)
    const y = padTop + (1 - v / max) * (h - padTop - padBottom)
    return [x, y] as const
  })
  const toPath = (points: Array<readonly [number, number]>) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ')
  const gustPts = pts(gusts)
  const windPts = pts(values)
  const windArea = `${toPath(windPts)} L${windPts[windPts.length - 1][0].toFixed(1)},${h - padBottom} L${windPts[0][0].toFixed(1)},${h - padBottom} Z`
  const gradId = 'wind-gust-trend'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="风速与阵风逐时曲线">
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#34d399" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#0f766e" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      {/* 横向刻度线 + 数值轴 */}
      {[0.25, 0.5, 0.75].map(ratio => (
        <line key={ratio} x1={padX} y1={padTop + ratio * (h - padTop - padBottom)} x2={w - padX} y2={padTop + ratio * (h - padTop - padBottom)} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
      ))}
      <text x={w - padX + 2} y={padTop + 4} fontSize="11" fill="rgba(255,255,255,0.4)" textAnchor="start">{Math.round(max)}</text>
      <text x={w - padX + 2} y={h - padBottom + 3} fontSize="11" fill="rgba(255,255,255,0.4)" textAnchor="start">0</text>
      <path d={toPath(gustPts)} fill="none" stroke="#166534" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d={windArea} fill={`url(#${gradId})`} />
      <path d={toPath(windPts)} fill="none" stroke="#4ade80" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
      {/* 顶部逐点数值（每 4 小时） */}
      {gusts.map((gust, i) => i % 4 === 1 ? (
        <text key={`g-${i}`} x={gustPts[i][0]} y={gustPts[i][1] - 8} textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.6)">{gust}</text>
      ) : null)}
      {values.map((value, i) => i % 4 === 1 ? (
        <text key={`v-${i}`} x={windPts[i][0]} y={windPts[i][1] - 8} textAnchor="middle" fontSize="11" fill="rgba(255,255,255,0.88)">{value}</text>
      ) : null)}
      {/* 底部时刻轴 */}
      {hours.map((hour, i) => i % 6 === 0 ? (
        <text key={`t-${i}`} x={windPts[i][0]} y={h - 8} textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">{i === 0 ? '现在' : `${hour.time.slice(11, 13)}时`}</text>
      ) : null)}
    </svg>
  )
}

/** 每日比较卡（Apple 式）：今天（或选中日）与前一天的同指标对比，双行条形 */
function DailyComparison({ weather, dayIndex, kind }: { weather: WeatherSnapshot; dayIndex: number; kind: WeatherCardKind }) {
  const compare = useMemo(() => {
    const today = weather.daily[dayIndex]
    const yesterday = weather.daily[dayIndex - 1]
    if (!today || !yesterday) return null
    const metric = (day: typeof today): { label: string; value: number; unit: string } | null => {
      switch (kind) {
        case 'uv': return { label: '最高紫外线指数', value: Math.round(day.uvIndexMax), unit: '' }
        case 'wind': return { label: '最大阵风', value: Math.round(day.windGustsMax), unit: ' 公里/时' }
        case 'feels': return { label: '最高体感温度', value: Math.round(day.apparentTemperatureMax), unit: '°' }
        case 'humidity': {
          const dayHours = weather.hourly.filter(hour => hour.time.slice(0, 10) === day.date)
          if (dayHours.length === 0) return null
          return { label: '平均湿度', value: Math.round(dayHours.reduce((sum, hour) => sum + (hour.humidity ?? 0), 0) / dayHours.length), unit: '%' }
        }
        case 'visibility': {
          const dayHours = weather.hourly.filter(hour => hour.time.slice(0, 10) === day.date)
          if (dayHours.length === 0) return null
          return { label: '平均能见度', value: Math.round(dayHours.reduce((sum, hour) => sum + hour.visibility, 0) / dayHours.length / 100) / 10, unit: ' 公里' }
        }
        case 'pressure': {
          const dayHours = weather.hourly.filter(hour => hour.time.slice(0, 10) === day.date)
          if (dayHours.length === 0) return null
          return { label: '最高气压', value: Math.round(Math.max(...dayHours.map(hour => hour.pressure ?? 0))), unit: ' 百帕' }
        }
        case 'precip': return { label: '总降水', value: Math.round(day.precipitationSum * 10) / 10, unit: ' 毫米' }
        case 'cloud': return { label: '最高气温', value: Math.round(day.temperatureMax), unit: '°' }
        case 'dew': return { label: '最低气温', value: Math.round(day.temperatureMin), unit: '°' }
        case 'aqi': return null
        case 'sun': return null
        default: return null
      }
    }
    const current = metric(today)
    const previous = metric(yesterday)
    if (!current || !previous || !Number.isFinite(current.value) || !Number.isFinite(previous.value)) return null
    const maxValue = Math.max(1, Math.abs(current.value), Math.abs(previous.value))
    const sentence = current.value > previous.value
      ? `${Number(today.date.slice(8, 10))}日的${current.label}比${Number(yesterday.date.slice(8, 10))}日高。`
      : current.value < previous.value
        ? `${Number(today.date.slice(8, 10))}日的${current.label}比${Number(yesterday.date.slice(8, 10))}日低。`
        : `${Number(today.date.slice(8, 10))}日的${current.label}与${Number(yesterday.date.slice(8, 10))}日相当。`
    return { current, previous, maxValue, sentence, todayLabel: dayIndex === 0 ? '今天' : `${Number(today.date.slice(8, 10))}日`, yesterdayLabel: dayIndex === 1 ? '昨天' : `${Number(yesterday.date.slice(8, 10))}日` }
  }, [weather, dayIndex, kind])
  if (!compare) return null
  return (
    <div className="mt-6">
      <SectionTitle>每日比较</SectionTitle>
      <div className="rounded-3xl bg-white/[0.05] px-5 py-4">
        <div className="text-[15px] leading-7 text-white/85">{compare.sentence}</div>
        <div className="mt-4 space-y-3">
          {[{ label: compare.todayLabel, value: compare.current.value, bright: true }, { label: compare.yesterdayLabel, value: compare.previous.value, bright: false }].map(row => (
            <div key={row.label} className="flex items-center gap-3">
              <span className={`w-14 shrink-0 rounded-lg px-2 py-1.5 text-center text-[13px] font-semibold ${row.bright ? 'bg-white text-slate-950' : 'bg-white/12 text-white/70'}`}>{row.label}</span>
              <div className="relative h-2.5 flex-1 rounded-full bg-white/8">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full ${row.bright ? 'bg-sky-400' : 'bg-white/35'}`}
                  style={{ width: `${Math.min(100, Math.abs(row.value) / compare.maxValue * 100)}%` }}
                />
              </div>
              <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{row.value}{compare.current.unit}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
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

/** 逐时降水条形图（Apple 降水详情同款）：蓝柱=当小时降水毫米数，灰色短柱=该小时概率有无但雨量为 0 */
function PrecipitationBars({ hours }: { hours: WeatherHour[] }) {
  const w = 640
  const h = 190
  const padBottom = 26
  const max = Math.max(0.6, ...hours.map(hour => hour.precipitation))
  const barW = Math.max(5, (w / Math.max(1, hours.length)) * 0.55)
  const gap = w / Math.max(1, hours.length)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="逐小时降水量">
      <line x1="0" y1={h - padBottom} x2={w} y2={h - padBottom} stroke="rgba(255,255,255,0.25)" strokeWidth="1" />
      {hours.map((hour, index) => {
        const x = index * gap + (gap - barW) / 2
        const rainHeight = (hour.precipitation / max) * (h - padBottom - 14)
        const hasChance = hour.precipitationProbability >= 20 && hour.precipitation < 0.05
        return (
          <g key={hour.time}>
            {hasChance && <rect x={x} y={h - padBottom - 5} width={barW} height={5} rx="2.5" fill="rgba(148,163,184,0.35)" />}
            {hour.precipitation >= 0.02 && (
              <rect x={x} y={h - padBottom - rainHeight} width={barW} height={Math.max(3, rainHeight)} rx={Math.min(3, barW / 2)} fill="#38bdf8" />
            )}
          </g>
        )
      })}
      {hours.map((hour, index) => index % 6 === 0 ? (
        <text key={`t-${hour.time}`} x={index * gap + gap / 2} y={h - 6} textAnchor="middle" fontSize="12" fill="rgba(255,255,255,0.5)">{index === 0 ? '现在' : `${hour.time.slice(11, 13)}时`}</text>
      ) : null)}
    </svg>
  )
}

/** 日出详情的当日太阳弧线（Apple 式）：曲线=太阳当日高度轨迹，水平亮线=地平线，
 *  弧线在地平线上的部分亮、下方暗；当前位置小圆点在曲线上。 */
function SunElevationChart({ sunrise, sunset, updatedAt, timeZone, latitude, longitude }: {
  sunrise: string
  sunset: string
  updatedAt: number
  timeZone?: string
  latitude: number
  longitude: number
}) {
  const w = 640
  const h = 240
  const padX = 16
  const padBottom = 26
  const chartH = h - padBottom
  // 太阳高度角曲线：-15°(下) 到 +75°(上) 映射到图表纵向
  const altitudeRange = { min: -18, max: 72 }
  const yFor = (altitude: number) => 12 + (1 - (altitude - altitudeRange.min) / (altitudeRange.max - altitudeRange.min)) * (chartH - 12)
  const samples = useMemo(() => {
    // 从当地 0 时到 24 时，每 10 分钟采样一次太阳高度角
    const base = new Date(`${sunrise.slice(0, 10)}T00:00:00`)
    if (Number.isNaN(base.getTime())) return []
    const list: Array<{ minutes: number; altitude: number }> = []
    for (let minutes = 0; minutes <= 1440; minutes += 10) {
      const sample = new Date(base.getTime() + minutes * 60000)
      const { altitude } = sunSkyPosition(sample, latitude, longitude)
      list.push({ minutes, altitude })
    }
    return list
  }, [sunrise, latitude, longitude])
  const xFor = (minutes: number) => padX + (minutes / 1440) * (w - padX * 2)
  const nowDate = new Date(updatedAt)
  const localNow = timeZone ? localDateParts(nowDate, timeZone) : { hour: nowDate.getHours(), minute: nowDate.getMinutes() }
  const nowMinutes = localNow.hour * 60 + localNow.minute
  const nowAltitude = samples.length > 0
    ? samples[Math.min(samples.length - 1, Math.floor(nowMinutes / 10))].altitude
    : 0
  const horizonY = yFor(0)
  // 分成地上/地下两段折线
  const abovePath = samples.filter(s => s.altitude >= 0).map(s => `${xFor(s.minutes).toFixed(1)},${yFor(s.altitude).toFixed(1)}`).join(' ')
  const belowPath = samples.filter(s => s.altitude < 0).map(s => `${xFor(s.minutes).toFixed(1)},${yFor(s.altitude).toFixed(1)}`).join(' ')
  const fmtHour = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}时`
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="当日太阳高度弧线">
      <line x1={padX} y1={horizonY} x2={w - padX} y2={horizonY} stroke="rgba(255,255,255,0.55)" strokeWidth="1.6" />
      {abovePath && <polyline points={abovePath} fill="none" stroke="#e8eef6" strokeWidth="3" strokeLinecap="round" opacity="0.92" />}
      {belowPath && <polyline points={belowPath} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="2.4" strokeLinecap="round" />}
      {/* 当前位置圆点 */}
      <circle cx={xFor(nowMinutes)} cy={yFor(Math.max(altitudeRange.min, Math.min(altitudeRange.max, nowAltitude)))} r="7" fill={nowAltitude >= 0 ? '#ffd257' : 'rgba(255,255,255,0.4)'} stroke={nowAltitude >= 0 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.6)'} strokeWidth="1.5" />
      {[0, 360, 720, 1080, 1440].map(minutes => (
        <text key={minutes} x={xFor(minutes)} y={h - 6} textAnchor={minutes === 0 ? 'start' : minutes === 1440 ? 'end' : 'middle'} fontSize="12" fill="rgba(255,255,255,0.5)">{fmtHour(minutes)}</text>
      ))}
    </svg>
  )
}

/** 12 个月日出日落平均表（Apple 式）：每月一行 = 日出 — 蓝条 — 日落。
 *  用天文近似离线推算当月 15 日在该纬度的日出/日落，无需额外数据源。 */
function MonthlySunTable({ latitude, longitude }: { latitude: number; longitude: number }) {
  const rows = useMemo(() => {
    const year = new Date().getFullYear()
    const fmt = (date: Date) => {
      const hours = date.getHours()
      const minutes = date.getMinutes()
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
    }
    const toMinutes = (date: Date) => date.getHours() * 60 + date.getMinutes()
    const list: Array<{ month: number; sunrise: string; sunset: string; startRatio: number; widthRatio: number }> = []
    let minStart = Number.POSITIVE_INFINITY
    let maxEnd = Number.NEGATIVE_INFINITY
    const raw = Array.from({ length: 12 }, (_, month) => {
      // 当月 15 日正午附近的日出日落：二分太阳高度角过 0 的时刻
      const noon = new Date(year, month, 15, 12, 0, 0, 0)
      const findCross = (rising: boolean) => {
        let low = 0
        let high = 1440
        const altitudeAt = (minutes: number) => sunSkyPosition(new Date(new Date(year, month, 15).getTime() + minutes * 60000), latitude, longitude).altitude
        for (let i = 0; i < 12; i += 1) {
          const mid = (low + high) / 2
          const altitude = altitudeAt(mid)
          if (rising ? altitude < 0 : altitude > 0) low = mid
          else high = mid
        }
        return (low + high) / 2
      }
      const riseMinutes = findCross(true)
      const setMinutes = findCross(false)
      const sunriseDate = new Date(new Date(year, month, 15).getTime() + riseMinutes * 60000)
      const sunsetDate = new Date(new Date(year, month, 15).getTime() + setMinutes * 60000)
      return { month, sunriseDate, sunsetDate }
    })
    for (const row of raw) {
      minStart = Math.min(minStart, toMinutes(row.sunriseDate))
      maxEnd = Math.max(maxEnd, toMinutes(row.sunsetDate))
    }
    const span = Math.max(1, maxEnd - minStart)
    for (const row of raw) {
      list.push({
        month: row.month + 1,
        sunrise: fmt(row.sunriseDate),
        sunset: fmt(row.sunsetDate),
        startRatio: (toMinutes(row.sunriseDate) - minStart) / span,
        widthRatio: (toMinutes(row.sunsetDate) - toMinutes(row.sunriseDate)) / span,
      })
    }
    return list
  }, [latitude, longitude])
  return (
    <div className="mt-6">
      <SectionTitle>日出日落平均时间</SectionTitle>
      <div className="overflow-hidden rounded-3xl bg-white/[0.05]">
        {rows.map((row, index) => (
          <div key={row.month} className={`flex items-center gap-3 px-5 py-3 ${index > 0 ? 'border-t border-white/8' : ''}`}>
            <span className="w-11 shrink-0 text-[15px] font-semibold">{row.month}月</span>
            <span className="w-12 shrink-0 text-right text-sm tabular-nums text-white/62">{row.sunrise}</span>
            <div className="relative h-[3px] flex-1 rounded-full bg-white/10">
              <div className="absolute inset-y-0 rounded-full bg-sky-400" style={{ left: `${row.startRatio * 100}%`, width: `${Math.max(6, row.widthRatio * 100)}%` }} />
            </div>
            <span className="w-12 shrink-0 text-sm tabular-nums text-white/62">{row.sunset}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 px-1 text-[11px] text-white/35">按当前定位纬度推算每月 15 日的日出日落 · 极昼极夜地区可能不准</p>
    </div>
  )
}
/** 图表上方的 Apple 式逐时小数值排（图 1065/1070/1072：每个时刻一个数字） */
function HourlyValueStrip({ values, labels }: { values: number[]; labels: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="wf-no-scrollbar -mx-1 mb-1 flex gap-0 overflow-x-auto px-1">
      {values.slice(0, 13).map((value, index) => (
        <span key={index} className="min-w-[46px] flex-1 border-r border-white/8 py-1 text-center text-[12px] tabular-nums text-white/78 last:border-r-0">{value}</span>
      ))}
    </div>
  )
}

/** 气压趋势箭头排（图 1074）：↓=下降 =-平稳 ↑=上升，按 2 小时窗口斜率判断 */
function PressureTrendStrip({ hours }: { hours: WeatherHour[] }) {
  if (hours.length === 0) return null
  const cells: Array<{ time: string; trend: 'up' | 'flat' | 'down' }> = []
  for (let index = 0; index < Math.min(13, hours.length); index += 2) {
    const window = hours.slice(index, index + 3)
    if (window.length < 2) break
    const delta = window[window.length - 1].pressure - window[0].pressure
    cells.push({
      time: hours[index].time,
      trend: delta <= -0.8 ? 'down' : delta >= 0.8 ? 'up' : 'flat',
    })
  }
  const glyph = { up: '↑', flat: '=', down: '↓' }
  return (
    <div className="wf-no-scrollbar -mx-1 mb-1 flex gap-0 overflow-x-auto px-1">
      {cells.map((cell, index) => (
        <span key={cell.time} className="min-w-[46px] flex-1 border-r border-white/8 py-1 text-center text-[15px] font-medium text-white/85 last:border-r-0">{glyph[cell.trend]}</span>
      ))}
    </div>
  )
}

/** 详情卡右上角的指标切换菜单（图 1067）：分组列出全部指标，点选切换 */
function CardSwitcherMenu({ current, onSelect }: { current: WeatherCardKind; onSelect: (kind: WeatherCardKind) => void }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', onKey) }
  }, [open])
  const GROUPS: Array<{ label: string; items: WeatherCardKind[] }> = [
    { label: '温度与体感', items: ['feels', 'uv', 'humidity', 'dew'] },
    { label: '降水与天空', items: ['precip', 'snow', 'cloud', 'visibility'] },
    { label: '风与气压', items: ['wind', 'pressure'] },
    { label: '太阳与月亮', items: ['sun', 'daylight', 'moonrise'] },
    { label: '环境', items: ['aqi', 'freezing'] },
  ]
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label="切换指标"
        aria-expanded={open}
        className="flex h-9 items-center gap-1 rounded-full bg-white/8 px-3.5 text-white/70 transition-colors hover:bg-white/16"
      >
        <span className="text-[13px] font-medium">{CARD_META[current].title}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: .97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: .97 }}
            transition={{ duration: .15 }}
            role="listbox"
            className="absolute right-0 top-[calc(100%+8px)] z-20 max-h-[70vh] w-[240px] overflow-y-auto rounded-2xl border border-white/14 bg-slate-900/95 p-1.5 shadow-[0_16px_40px_rgba(0,0,0,.5)] backdrop-blur-xl"
          >
            {GROUPS.map(group => (
              <div key={group.label}>
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-white/32">{group.label}</div>
                {group.items.map(kind => (
                  <button
                    key={kind}
                    type="button"
                    role="option"
                    aria-selected={kind === current}
                    onClick={() => { onSelect(kind); setOpen(false) }}
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${kind === current ? 'bg-white/12 font-semibold text-white' : 'text-white/65 hover:bg-white/8 hover:text-white'}`}
                  >
                    <span>{CARD_META[kind].title}</span>
                    {kind === current && <span className="text-sky-300">✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MiniTrend({ values, labels, color = '#8ec9f5', unit = '', suffix = '' }: { values: number[]; labels: string[]; color?: string; unit?: string; suffix?: string }) {
  const w = 640
  const h = 190
  const padX = 10
  const padTop = 22
  const padBottom = 30
  const finite = values.filter(v => Number.isFinite(v))
  // NaN 会沿 y 计算传播成 NaN 坐标（图上出现"NaN"文字），一律用过滤后的序列画
  const safeValues = finite.length > 0 ? finite : [0]
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
  const [selectedDay, setSelectedDay] = useState(0)
  // 换卡片时回到"今天"
  useEffect(() => { setSelectedDay(0) }, [card])
  if (typeof document === 'undefined') return null

  // 选中日的逐时序列（dayIndex=0 时从"现在"开始截 25h；其余日取全天）
  const dayHours = useMemo(() => {
    if (!weather) return [] as WeatherHour[]
    if (selectedDay === 0) return weather.hourly.slice(0, 25)
    const date = weather.daily[selectedDay]?.date
    return date ? weather.hourly.filter(hour => hour.time.slice(0, 10) === date) : []
  }, [weather, selectedDay])

  const dayLabels = useMemo(() => dayHours.map((hour, index) =>
    selectedDay === 0 && index === 0 ? '现在' : `${hour.time.slice(11, 13)}时`,
  ), [dayHours, selectedDay])

  const dayValue = (pick: (hour: WeatherHour) => number) => dayHours.map(hour => Math.round(pick(hour)))

  const currentHourly = useMemo(() => {
    if (!weather) return undefined
    return weather.hourly.find(item => item.time >= weather.current.time) ?? weather.hourly[0]
  }, [weather])

  // 图 1069 降水总量：现在时刻前后各 24 小时的累计降水
  const pastPrecipSum = useMemo(() => {
    if (!weather) return 0
    const now = weather.current.time
    return weather.hourly.filter(hour => hour.time < now).slice(-24).reduce((sum, hour) => sum + Math.max(0, hour.precipitation), 0)
  }, [weather])
  const futurePrecipSum = useMemo(() => {
    if (!weather) return 0
    const now = weather.current.time
    return weather.hourly.filter(hour => hour.time >= now).slice(0, 24).reduce((sum, hour) => sum + Math.max(0, hour.precipitation), 0)
  }, [weather])

  const meta = card ? CARD_META[card] : null

  if (parked) return null

  return createPortal(
    <AnimatePresence>
      {card && weather && meta && (
        <motion.div
          className="wf-no-scrollbar fixed inset-0 z-[420] flex items-start justify-center overflow-y-auto bg-transparent p-4 text-white sm:p-6"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={() => onClose()}
        >
          <motion.div
            className="my-auto max-h-[calc(100vh-2rem)] max-h-[calc(100dvh-2rem)] w-full max-w-[640px] shrink-0 overflow-y-auto overscroll-contain rounded-[32px] border border-white/14 bg-slate-950/85 p-5 shadow-[0_24px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl sm:max-h-[calc(100dvh-3rem)] sm:p-7"
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
              <div className="flex items-center gap-2">
                {/* Apple 式指标切换菜单：不关弹窗直接换指标 */}
                <CardSwitcherMenu current={card} onSelect={kind => { if (kind !== card) { setSelectedDay(0); onClose(kind) } }} />
                <button
                  type="button"
                  autoFocus
                  onClick={() => onClose()}
                  aria-label={`关闭${meta.title}详情`}
                  className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-white/70 transition-colors hover:bg-white/16"
                >
                  <X className="h-4.5 w-4.5" />
                </button>
              </div>
            </div>

            <div className="mt-5">
              {/* Apple 式日期选择条：切换后图表/摘要/比较全部跟随 */}
              {card !== 'aqi' && <DaySelector weather={weather} selected={selectedDay} onChange={setSelectedDay} />}
              {card === 'uv' && (
                <>
                  <div className="flex items-end gap-3">
                    <span className="text-[44px] font-light leading-none tabular-nums">{Math.round(Math.max(...dayValue(h => h.uvIndex), weather.daily[selectedDay]?.uvIndexMax || 0))}</span>
                    <span className="pb-1 text-lg text-white/75">{getUvLabel(weather.daily[selectedDay]?.uvIndexMax || 0)}</span>
                  </div>
                  <div className="relative mt-4 h-2 rounded-full" style={{ background: 'linear-gradient(90deg,#5ac8fa,#32d74b,#ffd60a,#ff9f0a,#ff453a,#bf5af2)' }}>
                    <span className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-slate-900" style={{ left: `${Math.min(100, (Math.min(11, weather.daily[selectedDay]?.uvIndexMax || 0) / 11) * 100)}%` }} />
                  </div>
                  {/* WHO UVI 分级标注（Apple 式左轴） */}
                  <div className="mt-2 flex justify-between text-[11px] text-white/40">
                    {['低', '中等', '高', '很高', '极高'].map(label => <span key={label}>{label}</span>)}
                  </div>
                  {/* 晴空对照：说明云对 UV 的削减 */}
                  {selectedDay === 0 && Number.isFinite(dayHours[0]?.uvIndexClearSky) && (
                    <p className="mt-2 text-[12px] text-white/45">
                      当前云量下 UV {Math.round(dayValue(h => h.uvIndex)[0] ?? 0)}；若万里无云约为 {Math.round(dayHours[0]!.uvIndexClearSky)}（晴空峰值 {Math.round(weather.daily[selectedDay]?.uvIndexClearSkyMax || 0)}）。
                    </p>
                  )}
                  {/* 图 1065 句式：当前等级 + 达到中等及以上的时间区间 */}
                  <p className="mt-3 text-sm text-white/55">{(() => {
                    const nowUv = dayValue(h => h.uvIndex)[0] ?? 0
                    const significant = dayHours.map(hour => hour.uvIndex).filter(value => value >= 3)
                    if (significant.length === 0) return `当前 ${nowUv}（${getUvLabel(nowUv)}）。全天紫外线均低于中等。`
                    const first = dayHours.find(hour => hour.uvIndex >= 3)
                    const last = [...dayHours].reverse().find(hour => hour.uvIndex >= 3)
                    const firstTime = first ? first.time.slice(11, 16) : '--:--'
                    const lastTime = last ? last.time.slice(11, 16) : '--:--'
                    const levelText = getUvLabel(Math.max(...significant))
                    return `当前${getUvLabel(nowUv)}。${firstTime} 至 ${lastTime} 达到${levelText}或更高等级。`
                  })()}</p>
                  {dayHours.length > 0 && <HourlyValueStrip values={dayValue(h => h.uvIndex)} labels={dayLabels} />}
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.uvIndex)} labels={dayLabels} color="#bf5af2" unit="UV 指数" /></div>}
                </>
              )}
              {card === 'wind' && (
                <>
                  {/* Apple 头部格式：X 级 + 方向，副行 阵风 X 米/秒（图 1059） */}
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[44px] font-light leading-none tabular-nums">{windSpeedBeaufortKmh(selectedDay === 0 ? weather.current.windSpeed : weather.daily[selectedDay]?.windSpeedMax || 0)}</span>
                        <span className="text-2xl font-light text-white/85">{getWindDirection(weather.current.windDirection)}</span>
                      </div>
                      <div className="mt-2 text-sm text-white/60">阵风：{Math.round((selectedDay === 0 ? weather.current.windGusts : weather.daily[selectedDay]?.windGustsMax || 0) / 3.6)} 米/秒</div>
                    </div>
                    <WindCompass degree={weather.current.windDirection} />
                  </div>
                  {/* Apple 式逐时风向箭头排 */}
                  <WindDirectionStrip hours={dayHours} />
                  {/* 80 米高空风对照（风机/高层楼层参考） */}
                  {selectedDay === 0 && Number.isFinite(dayHours[0]?.windSpeed80m) && (dayHours[0]!.windSpeed80m ?? 0) > 0 && (
                    <p className="mt-3 text-[12px] text-white/45">
                      80 米高空风速约 {Math.round(dayHours[0]!.windSpeed80m)} 公里/时（地面 {Math.round(weather.current.windSpeed)} 公里/时），高空风更强时利于污染物扩散。
                    </p>
                  )}
                  {dayHours.length > 0 && <div className="mt-3"><WindGustTrend hours={dayHours} /></div>}
                </>
              )}
              {card === 'feels' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.current.apparentTemperature)}°</div>
                  <p className="mt-2 text-sm text-white/55">体感综合了湿度与风速对体感温度的影响，实际温度 {Math.round(weather.current.temperature)}°。</p>
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.apparentTemperature)} labels={dayLabels} color="#fca5a5" unit="体感温度 °" /></div>}
                  {/* 图 1069 降水总量卡：过去 24h / 未来 24h */}
                  <div className="mt-6">
                    <SectionTitle>降水总量</SectionTitle>
                    <div className="overflow-hidden rounded-3xl bg-white/[0.05]">
                      <div className="flex items-center justify-between px-5 py-3.5">
                        <div>
                          <div className="text-[11px] text-white/40">过去 24 小时</div>
                          <div className="mt-0.5 flex items-center gap-2 text-sm font-semibold"><span className="h-2.5 w-2.5 rounded-full bg-sky-400" />降雨</div>
                        </div>
                        <span className="text-base font-medium tabular-nums text-sky-300">{pastPrecipSum.toFixed(1)} 毫米</span>
                      </div>
                      <div className="flex items-center justify-between border-t border-white/8 px-5 py-3.5">
                        <div>
                          <div className="text-[11px] text-white/40">未来 24 小时</div>
                          <div className="mt-0.5 text-sm font-semibold">降水</div>
                        </div>
                        <span className="text-base font-medium tabular-nums text-white/70">{futurePrecipSum.toFixed(1)} 毫米</span>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {card === 'humidity' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(dayHours[0]?.humidity ?? weather.current.humidity)}%</div>
                  <p className="mt-2 text-sm text-white/55">相对湿度 {Math.round(weather.current.humidity) > 75 ? '较高，体感闷湿。' : Math.round(weather.current.humidity) < 40 ? '较低，注意补水。' : '适中，体感舒适。'}</p>
                  {dayHours.length > 0 && <HourlyValueStrip values={dayValue(h => h.humidity ?? weather.current.humidity)} labels={dayLabels} />}
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.humidity ?? weather.current.humidity)} labels={dayLabels} color="#67e8f9" unit="湿度 %" /></div>}
                </>
              )}
              {card === 'visibility' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.max(0.1, (dayHours[0]?.visibility ?? weather.current.visibility) / 1000).toFixed(1)}<span className="ml-2 text-lg text-white/65">公里</span></div>
                  <p className="mt-2 text-sm text-white/55">{weather.current.visibility >= 10000 ? '视野非常好，远眺清晰。' : '能见度偏低，出行注意安全。'}</p>
                  {dayHours.length > 0 && <HourlyValueStrip values={dayHours.map(h => Math.round(h.visibility / 100) / 10)} labels={dayLabels} />}
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayHours.map(h => Math.round(h.visibility / 100) / 10)} labels={dayLabels} color="#a5b4fc" unit="能见度 公里" /></div>}
                </>
              )}
              {card === 'pressure' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(dayHours[0]?.pressure ?? weather.current.pressure)}<span className="ml-2 text-lg text-white/65">百帕</span></div>
                  {/* 副标题：与 3 小时前比较的瞬时趋势（图 1074 "正在下降"） */}
                  <div className="mt-1 text-sm text-white/60">{(() => {
                    const window = dayHours.slice(0, 4)
                    if (window.length < 2) return '气压平稳'
                    const delta = window[window.length - 1].pressure - window[0].pressure
                    return delta <= -1 ? '正在下降' : delta >= 1 ? '正在上升' : '气压平稳'
                  })()}</div>
                  {dayHours.length > 0 && <div className="mt-3"><PressureTrendStrip hours={dayHours} /></div>}
                  {dayHours.length > 0 && <HourlyValueStrip values={dayValue(h => h.pressure ?? weather.current.pressure)} labels={dayLabels} />}
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.pressure ?? weather.current.pressure)} labels={dayLabels} color="#c4b5fd" unit="气压 百帕" /></div>}
                </>
              )}
              {card === 'precip' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{(weather.daily[selectedDay]?.precipitationSum ?? weather.current.precipitation).toFixed(1)}<span className="ml-2 text-lg text-white/65">毫米</span></div>
                  <p className="mt-2 text-sm text-white/55">{selectedDay === 0 ? '今日' : `${Number(weather.daily[selectedDay]?.date.slice(8, 10))}日`}降水概率 {Math.round(weather.daily[selectedDay]?.precipitationProbability || 0)}%，逐小时降水量如下。</p>
                  {dayHours.length > 0 && <div className="mt-4"><PrecipitationBars hours={dayHours} /></div>}
                </>
              )}
              {card === 'sun' && weather.daily[selectedDay]?.sunrise && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-white/55">日出</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[selectedDay].sunrise.slice(11, 16)}</div>
                    </div>
                    <div>
                      <div className="text-sm text-white/55">日落</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[selectedDay].sunset.slice(11, 16)}</div>
                    </div>
                  </div>
                  <div className="mt-3"><SunElevationChart sunrise={weather.daily[selectedDay].sunrise} sunset={weather.daily[selectedDay].sunset} updatedAt={weather.updatedAt} timeZone={weather.timezone} latitude={weather.location.latitude} longitude={weather.location.longitude} /></div>
                  <SunExtras
                    sunrise={weather.daily[selectedDay].sunrise}
                    sunset={weather.daily[selectedDay].sunset}
                    daylightDuration={weather.daily[selectedDay].daylightDuration}
                    sunshineDuration={weather.daily[selectedDay].sunshineDuration}
                    daily={weather.daily}
                    timeZone={weather.timezone}
                    latitude={weather.location.latitude}
                  />
                  {/* 当前太阳实时位置（与月亮卡的方位/高度信息对称；按定位坐标实时推算） */}
                  {selectedDay === 0 && typeof weather.location.latitude === 'number' && typeof weather.location.longitude === 'number' && (() => {
                    const sun = sunSkyPosition(new Date(), weather.location.latitude, weather.location.longitude)
                    const day0 = weather.daily[0]
                    const daylightSeconds = day0?.daylightDuration ?? 0
                    const daylightMinutes = Math.round(daylightSeconds / 60)
                    return (
                      <div className="mt-4 overflow-hidden rounded-3xl bg-white/[0.05]">
                        <div className="flex items-center justify-between px-5 py-3">
                          <span className="flex items-center gap-2.5 text-sm text-white/78">
                            <span className="inline-block h-3 w-3 rounded-full" style={{ background: 'radial-gradient(circle at 40% 35%, #fff7db, #ffd75e 60%, #f5a623)', boxShadow: '0 0 10px rgba(255,205,90,.6)' }} />
                            太阳位置
                          </span>
                          <span className="text-sm font-medium tabular-nums">
                            {sun.visible
                              ? `${getWindDirection(sun.azimuth)}方 · 高度 ${Math.round(sun.altitude)}°`
                              : '地平线下'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
                          <span className="text-sm text-white/78">昼长</span>
                          <span className="text-sm font-medium tabular-nums">{daylightMinutes > 0 ? `${Math.floor(daylightMinutes / 60)} 小时 ${daylightMinutes % 60} 分钟` : '—'}</span>
                        </div>
                        <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
                          <span className="text-sm text-white/78">今日太阳总辐射</span>
                          <span className="text-sm font-medium tabular-nums">{(day0?.shortwaveRadiationSum ?? 0).toFixed(1)} MJ/m²</span>
                        </div>
                        <div className="flex items-center justify-between border-t border-white/8 px-5 py-3">
                          <span className="text-sm text-white/78">今日峰值紫外线</span>
                          <span className="text-sm font-medium tabular-nums">UV {Math.round(day0?.uvIndexMax || 0)}（{getUvLabel(day0?.uvIndexMax || 0)}）</span>
                        </div>
                      </div>
                    )
                  })()}
                  {selectedDay === 0 && typeof weather.location.latitude === 'number' && typeof weather.location.longitude === 'number' && (
                    <MonthlySunTable latitude={weather.location.latitude} longitude={weather.location.longitude} />
                  )}
                </>
              )}
              {card === 'cloud' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{selectedDay === 0 ? Math.round(weather.current.cloudCover ?? 0) : Math.round(dayHours.reduce((max, h) => Math.max(max, h.cloudCover ?? 0), 0))}<span className="ml-2 text-lg text-white/65">%</span></div>
                  <p className="mt-2 text-sm text-white/55">{(weather.current.cloudCover ?? 0) < 35 ? '天空以晴为主。' : (weather.current.cloudCover ?? 0) < 70 ? '云量适中，间或有阳光。' : '云层厚密，天空阴沉。'}</p>
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.cloudCover ?? 0)} labels={dayLabels} color="#93c5fd" unit="云量 %" suffix="%" /></div>}
                  {/* 分层云量（Apple 云量详情同款）：低/中/高三层各自逐时曲线 */}
                  {selectedDay === 0 && dayHours.length > 0 && (
                    <div className="mt-6">
                      <SectionTitle>分层云量</SectionTitle>
                      <div className="overflow-hidden rounded-3xl bg-white/[0.05]">
                        {([
                          ['低云（≤3 公里）', (h: WeatherHour) => h.cloudCoverLow, '#60a5fa'],
                          ['中云（3-8 公里）', (h: WeatherHour) => h.cloudCoverMid, '#38bdf8'],
                          ['高云（>8 公里）', (h: WeatherHour) => h.cloudCoverHigh, '#a5b4fc'],
                        ] as const).map(([label, pick, color], index) => {
                          const now = dayHours[0]
                          return (
                            <div key={label} className={`flex items-center gap-3 px-5 py-3 ${index > 0 ? 'border-t border-white/8' : ''}`}>
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                              <span className="flex-1 text-sm text-white/78">{label}</span>
                              <span className="text-sm font-medium tabular-nums">{Math.round(pick(now))}%</span>
                            </div>
                          )
                        })}
                      </div>
                      <div className="mt-3"><MiniTrend values={dayHours.map(h => Math.round(h.cloudCoverLow))} labels={dayLabels} color="#60a5fa" unit="低云 %" suffix="%" /></div>
                    </div>
                  )}
                </>
              )}
              {card === 'dew' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round(dayHours[0]?.dewPoint ?? currentHourly?.dewPoint ?? 0)}°</div>
                  <p className="mt-2 text-sm text-white/55">露点接近气温时空气接近饱和，{(dayHours[0]?.dewPoint ?? currentHourly?.dewPoint ?? 0) >= 21 ? '闷热感明显。' : (dayHours[0]?.dewPoint ?? currentHourly?.dewPoint ?? 0) >= 16 ? '略感潮湿。' : '体感较为干爽。'}</p>
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayValue(h => h.dewPoint ?? 0)} labels={dayLabels} color="#5eead4" unit="露点温度 °" /></div>}
                </>
              )}
              {card === 'aqi' && (
                <>
                  <div className="flex items-baseline gap-3">
                    <span className="text-[44px] font-light leading-none tabular-nums">{Math.round(weather.airQuality?.aqi ?? 0)}</span>
                    <span className="text-lg font-semibold" style={{ color: getAqiDescriptor(weather.airQuality?.aqi ?? Number.NaN).color }}>{getAqiLabel(weather.airQuality?.aqi ?? Number.NaN)}</span>
                  </div>
                  {/* 欧洲标准说明 + 美国标准对照（Apple 同时给出两套标准） */}
                  <p className="mt-2 text-sm text-white/55">
                    欧洲环境署 AQI 标准{Number.isFinite(weather.airQuality?.usAqi) ? ` · 美国 EPA AQI ${Math.round(weather.airQuality!.usAqi!)}` : ''}。
                    {aqiAdvisory(weather.airQuality?.aqi ?? Number.NaN)}
                  </p>
                  {/* 污染物浓度网格（Apple 式：每种污染物一行，按相对污染度着色） */}
                  <div className="mt-4 overflow-hidden rounded-3xl bg-white/[0.05]">
                    {pollutantRows(weather.airQuality).map((row, index) => (
                      <div key={row.label} className={`flex items-center justify-between px-5 py-3 ${index > 0 ? 'border-t border-white/8' : ''}`}>
                        <span className="flex items-center gap-2.5 text-sm">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: row.color }} />
                          <span className="text-white/78">{row.label}</span>
                        </span>
                        <span className="text-sm font-medium tabular-nums text-white/88">{row.text}</span>
                      </div>
                    ))}
                  </div>
                  {/* 逐时 AQI 数值排 + 趋势图 */}
                  {weather.airQuality?.hourlyAqi?.length ? (
                    <>
                      <HourlyValueStrip
                        values={weather.airQuality.hourlyAqi.map(item => Math.round(item.aqi))}
                        labels={weather.airQuality.hourlyAqi.map((item, index) => index === 0 ? '现在' : `${item.time.slice(11, 13)}时`)}
                      />
                      <div className="mt-3">
                        <MiniTrend
                          values={weather.airQuality.hourlyAqi.map(item => Math.round(item.aqi))}
                          labels={weather.airQuality.hourlyAqi.map((item, index) => index === 0 ? '现在' : `${item.time.slice(11, 13)}时`)}
                          color={getAqiDescriptor(weather.airQuality?.aqi ?? Number.NaN).color}
                          unit="AQI 指数"
                        />
                      </div>
                    </>
                  ) : null}
                  {/* 每日摘要/比较（AQI 用逐时 AQI 数据） */}
                  {weather.airQuality?.hourlyAqi?.length ? (
                    <>
                      <div className="mt-6">
                        <SectionTitle>每日摘要</SectionTitle>
                        <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-[15px] leading-7 text-white/85">{(() => {
                          const items = weather.airQuality!.hourlyAqi
                          const values = items.map(item => item.aqi).filter(Number.isFinite)
                          const max = Math.max(...values)
                          const min = Math.min(...values)
                          const peak = items.find(item => item.aqi === max)
                          const worst = getAqiLabel(max)
                          const best = getAqiLabel(min)
                          return `今天空气质量${getAqiLabel(values[0])}，AQI 范围 ${Math.round(min)} 至 ${Math.round(max)}，最差时段约 ${peak ? peak.time.slice(11, 13) : '--'} 点（${worst}），最好时段为${best}。`
                        })()}</div>
                      </div>
                      <div className="mt-6">
                        <SectionTitle>每日比较</SectionTitle>
                        <div className="rounded-3xl bg-white/[0.05] px-5 py-4">
                          <div className="text-[15px] leading-7 text-white/85">{(() => {
                            // 与未来 48h 内后半段（更远时段）均值对比：预报内自比较
                            const items = weather.airQuality!.hourlyAqi
                            const firstHalf = items.slice(0, Math.floor(items.length / 2))
                            const secondHalf = items.slice(Math.floor(items.length / 2))
                            const avg = (list: typeof items) => list.reduce((sum, item) => sum + item.aqi, 0) / Math.max(1, list.length)
                            const delta = avg(firstHalf) - avg(secondHalf)
                            if (!Number.isFinite(delta) || Math.abs(delta) < 1) return '未来半天空气质量与之后基本相当。'
                            return delta > 0 ? '未来半天空气质量比之后略差，之后会好转。' : '未来半天空气质量比之后更好。'
                          })()}</div>
                        </div>
                      </div>
                    </>
                  ) : null}
                  <div className="mt-6">
                    <SectionTitle>关于空气质量指数</SectionTitle>
                    <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-sm leading-6 text-white/62">
                      空气质量指数（AQI）综合 PM2.5、PM10、臭氧、二氧化氮等污染物浓度计算，数值越低空气越洁净。欧洲环境署标准下 0-20 为优、20-40 为良、40-60 为中等；敏感人群在中等级以上应减少长时间户外剧烈活动。
                    </div>
                  </div>
                </>
              )}

              {card === 'snow' && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">
                    {Math.round((weather.daily[selectedDay]?.snowfallSum ?? 0) * 10) / 10}
                    <span className="ml-2 text-lg text-white/65">厘米</span>
                  </div>
                  <p className="mt-2 text-sm text-white/55">
                    {(weather.daily[selectedDay]?.snowfallSum ?? 0) > 0
                      ? `当日新增降雪 ${Math.round((weather.daily[selectedDay]?.snowfallSum ?? 0) * 10) / 10} 厘米，地面积雪 ${(dayHours[0]?.snowDepth ?? 0) > 0 ? `${(dayHours[0]!.snowDepth * 100).toFixed(0)} 厘米` : '无'}。`
                      : '当日预计无降雪。'}
                  </p>
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayHours.map(h => Math.round(h.snowDepth * 100))} labels={dayLabels} color="#e0f2fe" unit="积雪深度 厘米" /></div>}
                  {/* 分项降水构成（Apple 降水详情同款结构） */}
                  <div className="mt-6">
                    <SectionTitle>降水构成</SectionTitle>
                    <div className="overflow-hidden rounded-3xl bg-white/[0.05]">
                      {[
                        ['降雨', weather.daily[selectedDay]?.rainSum ?? 0, '#38bdf8'],
                        ['阵雨', weather.daily[selectedDay]?.showersSum ?? 0, '#22d3ee'],
                        ['降雪（水当量）', weather.daily[selectedDay]?.snowfallSum ?? 0, '#e0f2fe'],
                      ].map(([label, value, color], index) => {
                        const total = Math.max(0.001, (weather.daily[selectedDay]?.rainSum ?? 0) + (weather.daily[selectedDay]?.showersSum ?? 0) + (weather.daily[selectedDay]?.snowfallSum ?? 0))
                        return (
                          <div key={String(label)} className={`flex items-center gap-3 px-5 py-3 ${index > 0 ? 'border-t border-white/8' : ''}`}>
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: String(color) }} />
                            <span className="flex-1 text-sm text-white/78">{String(label)}</span>
                            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
                              <div className="h-full rounded-full" style={{ width: `${Math.min(100, (Number(value) / total) * 100)}%`, background: String(color) }} />
                            </div>
                            <span className="w-16 text-right text-sm font-medium tabular-nums">{Math.round(Number(value) * 10) / 10} 毫米</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
              {card === 'daylight' && weather.daily[selectedDay] && (
                <>
                  <div className="text-[44px] font-light leading-none tabular-nums">{formatDuration((weather.daily[selectedDay].sunshineDuration ?? 0) / 60)}</div>
                  <p className="mt-2 text-sm text-white/55">直达日照（WMO 标准：直接辐射超过 120 W/m² 的时长）。</p>
                  <div className="mt-4 overflow-hidden rounded-3xl bg-white/[0.05]">
                    {[
                      ['总日照时间', formatDuration((weather.daily[selectedDay].daylightDuration ?? 0) / 60)],
                      ['太阳总辐射', `${(weather.daily[selectedDay].shortwaveRadiationSum ?? 0).toFixed(1)} MJ/m²`],
                      ['参考蒸散 ET₀', `${(weather.daily[selectedDay].et0Evapotranspiration ?? 0).toFixed(1)} 毫米`],
                      ['日出 / 日落', `${weather.daily[selectedDay].sunrise.slice(11, 16)} / ${weather.daily[selectedDay].sunset.slice(11, 16)}`],
                    ].map(([label, value], index) => (
                      <div key={label} className={`flex items-center justify-between px-5 py-3 text-sm ${index > 0 ? 'border-t border-white/8' : ''}`}>
                        <span className="text-white/72">{label}</span>
                        <span className="font-medium tabular-nums">{value}</span>
                      </div>
                    ))}
                  </div>
                  {dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayHours.map(h => Math.round(h.shortwaveRadiation))} labels={dayLabels} color="#fbbf24" unit="短波辐射 W/m²" /></div>}
                  <div className="mt-6">
                    <SectionTitle>关于日照</SectionTitle>
                    <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-sm leading-6 text-white/62">
                      总日照时间是从日出到日落的全长；直达日照只统计太阳直射辐射足够强的时段（云层会显著削减）。太阳总辐射是到达地面的全部太阳能，参考蒸散 ET₀ 则反映当日天气下的水分蒸发能力，常用于农业灌溉决策。
                    </div>
                  </div>
                </>
              )}
              {card === 'moonrise' && weather.daily[selectedDay] && (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <div className="text-sm text-white/55">月出</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[selectedDay].moonrise ? weather.daily[selectedDay].moonrise.slice(11, 16) : '--:--'}</div>
                    </div>
                    <div>
                      <div className="text-sm text-white/55">月落</div>
                      <div className="text-[30px] font-light tabular-nums">{weather.daily[selectedDay].moonset ? weather.daily[selectedDay].moonset.slice(11, 16) : '--:--'}</div>
                    </div>
                  </div>
                  {/* 依据当前时刻判断月亮状态（图 1057 底部卡语义） */}
                  <p className="mt-3 text-sm text-white/55">{(() => {
                    const day = weather.daily[selectedDay]
                    if (!day?.moonrise || !day?.moonset) return '今日月亮可能整日在地平线上或下（高纬度或特殊月相时段）。'
                    const parts = weather.timezone ? localDateParts(new Date(), weather.timezone) : { hour: new Date().getHours(), minute: new Date().getMinutes() }
                    const nowMinutes = parts.hour * 60 + parts.minute
                    const toMinutes = (time: string) => Number(time.slice(11, 13)) * 60 + Number(time.slice(14, 16))
                    const rise = toMinutes(day.moonrise)
                    const set = toMinutes(day.moonset)
                    const above = rise <= set ? nowMinutes >= rise && nowMinutes < set : nowMinutes >= rise || nowMinutes < set
                    if (selectedDay > 0) {
                      const nextDay = weather.daily[selectedDay + 1]
                      const delay = nextDay?.moonrise && day.moonrise
                        ? Math.round((toMinutes(nextDay.moonrise) - rise + 1440) % 1440)
                        : null
                      return `月亮 ${String(Math.floor(rise / 60)).padStart(2, '0')}:${String(rise % 60).padStart(2, '0')} 升起${delay !== null ? `，比前一日晚约 ${delay} 分钟` : ''}。`
                    }
                    return above
                      ? `月亮现在在地平线上，${set > nowMinutes ? `${String(Math.floor(set / 60)).padStart(2, '0')}:${String(set % 60).padStart(2, '0')} 月落` : `明日 ${day.moonrise.slice(11, 16)} 月出`}。`
                      : `月亮现在在地平线下，${rise > nowMinutes ? `${String(Math.floor(rise / 60)).padStart(2, '0')}:${String(rise % 60).padStart(2, '0')} 月出` : `明日 ${weather.daily[selectedDay + 1]?.moonrise?.slice(11, 16) ?? '--:--'} 月出`}。`
                  })()}</p>
                  <div className="mt-4 overflow-hidden rounded-3xl border border-white/10">
                    {weather.daily.slice(0, 7).map((day, index) => (
                      <div key={day.date} className={`flex items-center justify-between px-5 py-3 text-sm ${index > 0 ? 'border-t border-white/8' : ''}`}>
                        <span className="text-white/72">{index === 0 ? '今天' : `${Number(day.date.slice(5, 7))}月${Number(day.date.slice(8, 10))}日`}</span>
                        <span className="flex items-center gap-4 tabular-nums">
                          <span className="text-white/62">月出 {day.moonrise ? day.moonrise.slice(11, 16) : '--'}</span>
                          <span className="text-white/62">月落 {day.moonset ? day.moonset.slice(11, 16) : '--'}</span>
                          {Number.isFinite(day.moonPhase) && <MoonDisc phase={day.moonPhase!} className="w-6" />}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {card === 'freezing' && (
                <>
                  {/* 冻结高度只有"现在起"的逐时预报；选中未来日时显示近代表值并说明 */}
                  <div className="text-[44px] font-light leading-none tabular-nums">{Math.round((dayHours[0]?.freezingLevel ?? weather.hourly[0]?.freezingLevel ?? 0)).toLocaleString('zh-CN')}<span className="ml-2 text-lg text-white/65">米</span></div>
                  <p className="mt-2 text-sm text-white/55">
                    {selectedDay > 0 ? '冻结高度仅提供逐小时预报（未来 48 小时），此处显示当前值供参考。'
                      : (dayHours[0]?.freezingLevel ?? 0) <= 500 ? '冻结层极低，近地面气温接近冰点，降水可能以雪的形式出现。'
                        : (dayHours[0]?.freezingLevel ?? 0) <= 1500 ? '冻结层较低，高山地区有降雪条件。'
                          : '冻结层较高，降水以雨为主。'}
                  </p>
                  {selectedDay === 0 && dayHours.length > 0 && <div className="mt-4"><MiniTrend values={dayHours.map(h => Math.round(h.freezingLevel))} labels={dayLabels} color="#94a3b8" unit="冻结高度 米" /></div>}
                  <div className="mt-6">
                    <SectionTitle>关于冻结高度</SectionTitle>
                    <div className="rounded-3xl bg-white/[0.05] px-5 py-4 text-sm leading-6 text-white/62">
                      冻结高度是大气中 0°C 等温面的海拔。地面与冻结层之间的温度决定了降水落地时是雨还是雪——冻结层越低，降雪的可能性越大。它也是航空和山区出行关注的重要指标。
                    </div>
                  </div>
                </>
              )}

              {/* Apple 式：每日摘要 + 每日比较（逐时数据可得的卡片） */}
              {weather.hourly.length > 0 && card !== 'aqi' && card !== 'sun' && (
                <DailySummary weather={weather} dayIndex={selectedDay} kind={card} />
              )}
              {weather.hourly.length > 0 && card !== 'aqi' && card !== 'sun' && (
                <DailyComparison weather={weather} dayIndex={selectedDay} kind={card} />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}