import { useMemo } from 'react'
import { Navigation } from 'lucide-react'
import { getWeatherLabel, getWeatherLocationName, type WeatherSnapshot } from '../services/weatherService'
import { getWeatherVisualTheme, WeatherGlyph, type WeatherSceneKind } from './weatherVisualTheme'
import { IconSunrise, IconSunset } from './AppleWeatherIcon'

// 苹果桌面小组件风的简约天气卡片（图3 参考）：
// 左上城市+大温度，右上图标+天气+高低温，底部一排逐小时（含日出/日落槽位），
// 背景为按天气×时段的纯色渐变（晴夜深蓝 / 雨天灰 / 朝阳晚霞粉紫）。

const WEEKDAY_CACHE = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' })

interface WeatherSimpleCardProps {
  weather: WeatherSnapshot
  locationLabel: string
}

type Daypart = 'day' | 'night' | 'dawn' | 'dusk'

const SIMPLE_GRADIENTS: Record<Daypart, Partial<Record<WeatherSceneKind, string>>> = {
  day: {
    clear: 'linear-gradient(160deg,#2f8fd8 0%,#57b0e8 52%,#84c9f2 100%)',
    'partly-cloudy': 'linear-gradient(160deg,#3f8ec9 0%,#63a8d6 52%,#8fc0dc 100%)',
    cloudy: 'linear-gradient(160deg,#54697c 0%,#6f8291 52%,#8b9ba6 100%)',
    fog: 'linear-gradient(160deg,#5d6d78 0%,#7e8d96 52%,#9fabb1 100%)',
    snow: 'linear-gradient(160deg,#62809a 0%,#87a3b8 52%,#aec6d4 100%)',
  },
  dawn: {
    clear: 'linear-gradient(160deg,#4a5fc0 0%,#7a68b4 42%,#c97d9a 78%,#f0a184 100%)',
  },
  dusk: {
    clear: 'linear-gradient(160deg,#3c4a9e 0%,#6d5ba8 40%,#b56d95 74%,#e8947f 100%)',
  },
  night: {
    clear: 'linear-gradient(160deg,#101c33 0%,#1b2c4d 55%,#27406a 100%)',
    'partly-cloudy': 'linear-gradient(160deg,#0e1930 0%,#1a2842 55%,#263850 100%)',
    cloudy: 'linear-gradient(160deg,#0c1524 0%,#182335 55%,#263443 100%)',
    fog: 'linear-gradient(160deg,#101922 0%,#233040 55%,#3a4854 100%)',
    snow: 'linear-gradient(160deg,#16283c 0%,#2c4258 55%,#4a6478 100%)',
  },
}

const RAINY_KINDS: WeatherSceneKind[] = ['drizzle', 'rain', 'heavy-rain', 'thunder']

function simpleGradient(kind: WeatherSceneKind, daypart: Daypart): string {
  const table = SIMPLE_GRADIENTS[daypart]
  return table[kind] ?? table[daypart === 'night' ? 'clear' : 'clear'] ?? SIMPLE_GRADIENTS.day.clear!
}

export function WeatherSimpleCard({ weather, locationLabel }: WeatherSimpleCardProps) {
  const kind = getWeatherVisualTheme(weather.current.weatherCode, weather.current.isDay).kind
  const daypart = useMemo<Daypart>(() => {
    const day0 = weather.daily[0]
    const now = new Date()
    const minutesNow = now.getHours() * 60 + now.getMinutes()
    if (day0?.sunrise && day0?.sunset) {
      const [sh, sm] = day0.sunrise.slice(11, 16).split(':').map(Number)
      const [eh, em] = day0.sunset.slice(11, 16).split(':').map(Number)
      if (Number.isFinite(sh) && Number.isFinite(eh)) {
        if (minutesNow >= sh && minutesNow - sh <= 90) return 'dawn'
        if (minutesNow <= em && em - minutesNow <= 90) return 'dusk'
      }
    }
    return weather.current.isDay ? 'day' : 'night'
  }, [weather])

  // 朝阳晚霞渐变给所有天气共用（苹果的晚霞组件也不分天气）
  const background = (daypart === 'dawn' || daypart === 'dusk')
    ? SIMPLE_GRADIENTS[daypart].clear!
    : simpleGradient(kind, daypart)

  // 底部逐小时：与详情页一致，在日出/日落时刻插入特殊槽位
  const hourItems = useMemo(() => {
    const items: Array<{ key: string; time: string; icon: React.ReactNode; temp: string }> = []
    const day0 = weather.daily[0]
    const hours = weather.hourly.slice(0, 7)
    hours.forEach((hour, index) => {
      if (day0?.sunrise && day0?.sunset && index > 0) {
        const prev = hours[index - 1].time
        if (prev < day0.sunrise && hour.time >= day0.sunrise) {
          items.push({ key: 'sunrise', time: day0.sunrise.slice(11, 16), icon: <IconSunrise className="h-[18px] w-[18px]" />, temp: '日出' })
        }
        if (prev < day0.sunset && hour.time >= day0.sunset) {
          items.push({ key: 'sunset', time: day0.sunset.slice(11, 16), icon: <IconSunset className="h-[18px] w-[18px]" />, temp: '日落' })
        }
      }
      items.push({
        key: hour.time,
        time: index === 0 ? '现在' : `${hour.time.slice(11, 13)}时`,
        icon: <WeatherGlyph code={hour.weatherCode} isDay={hour.time >= (day0?.sunrise ?? '') && hour.time < (day0?.sunset ?? '99')} className="h-[18px] w-[18px]" />,
        temp: `${Math.round(hour.temperature)}°`,
      })
    })
    return items.slice(0, 6)
  }, [weather])

  const rainy = RAINY_KINDS.includes(kind)

  return (
    <div className="absolute inset-0 overflow-hidden rounded-[inherit]" style={{ background }} aria-hidden="false">
      <div className="relative flex h-full flex-col justify-between px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1 text-[13px] font-medium text-white/85">
              <span className="truncate">{locationLabel}</span>
              <Navigation className="h-3 w-3 shrink-0 text-white/55" style={{ transform: `rotate(${(weather.current.windDirection + 180) % 360}deg)` }} />
            </div>
            <div className="mt-0.5 text-[3.4rem] font-light leading-[1.02] tracking-[-0.06em] tabular-nums">
              {Math.round(weather.current.temperature)}°
            </div>
          </div>
          <div className="flex flex-col items-end pt-0.5">
            <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="h-8 w-8" />
            <span className="mt-1.5 text-[13px] font-medium text-white/88">{getWeatherLabel(weather.current.weatherCode)}</span>
            <span className="mt-0.5 text-[12px] text-white/62">
              最高 {Math.round(weather.daily[0]?.temperatureMax ?? weather.current.temperature)}° 最低 {Math.round(weather.daily[0]?.temperatureMin ?? weather.current.temperature)}°
            </span>
          </div>
        </div>

        <div className="flex items-end justify-between gap-1 px-0.5">
          {hourItems.map(item => (
            <div key={item.key} className="flex min-w-0 flex-col items-center gap-1">
              <span className="text-[11px] font-medium text-white/72">{item.time}</span>
              {item.icon}
              <span className={`text-[12px] font-semibold tabular-nums ${item.temp === '日出' || item.temp === '日落' ? 'text-amber-200/90' : 'text-white/92'}`}>{item.temp}</span>
            </div>
          ))}
        </div>
      </div>
      {/* 简约卡片保持苹果小组件的干净观感，不加淋雨效果；雨天用一层薄雨雾提示 */}
      {rainy && <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_120%,rgba(160,200,230,0.14),transparent_62%)]" />}
    </div>
  )
}
