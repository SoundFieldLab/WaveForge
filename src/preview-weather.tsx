// 开发用预览页：/preview-weather.html，不被应用引用、不进生产构建入口。
// 渲染真实的 WeatherDetailsModal（mock 数据）与桌面卡片两种模式做视觉验收。
import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CloudSun } from 'lucide-react'
import './index.css'
import WeatherDetailsModal from './components/WeatherDetailsModal'
import { WeatherSimpleCard } from './components/WeatherSimpleCard'
import { WeatherAtmosphere, WeatherRainGlass, WeatherGlyph, getWeatherVisualTheme, isRainySceneKind, type WeatherSceneKind } from './components/weatherVisualTheme'
import type { WeatherSnapshot } from './services/weatherService'

const KIND_TO_CODE: Record<WeatherSceneKind, number> = {
  clear: 0,
  'partly-cloudy': 2,
  cloudy: 3,
  fog: 45,
  drizzle: 51,
  rain: 63,
  'heavy-rain': 65,
  thunder: 95,
  snow: 73,
}

const KINDS: WeatherSceneKind[] = ['clear', 'partly-cloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'heavy-rain', 'thunder', 'snow']
const KIND_LABELS: Record<WeatherSceneKind, string> = {
  clear: '晴', 'partly-cloudy': '多云', cloudy: '阴', fog: '雾',
  drizzle: '毛毛雨', rain: '雨', 'heavy-rain': '大雨', thunder: '雷暴', snow: '雪',
}

const pad = (n: number) => String(n).padStart(2, '0')
const fmtLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`

function buildMock(kind: WeatherSceneKind, isDay: boolean): WeatherSnapshot {
  const code = KIND_TO_CODE[kind]
  const now = new Date()
  now.setMinutes(0, 0, 0)
  const today = new Date(now)
    const hourly = Array.from({ length: 26 }, (_, i) => {
      const t = new Date(now.getTime() + i * 3600000)
      const hourCode = i > 0 && i % 7 === 0 ? (code === 0 ? 2 : 1) : code
      return {
        time: fmtLocal(t),
        temperature: 27 + Math.round(2 * Math.sin(i / 3.4)),
        apparentTemperature: 29 + Math.round(2 * Math.sin(i / 3.4)),
        precipitationProbability: ['drizzle', 'rain', 'heavy-rain', 'thunder'].includes(kind) ? 30 + ((i * 13) % 55) : (i * 7) % 24,
        precipitation: 0.2,
        snowfall: kind === 'snow' ? 0.8 : 0,
        weatherCode: hourCode,
        windSpeed: 8 + (i % 5) * 2,
        windGusts: 15 + (i % 4) * 3,
        visibility: kind === 'fog' ? 900 : 24000,
        uvIndex: t.getHours() >= 6 && t.getHours() < 19 ? Math.max(0, Math.round(8 - Math.abs(t.getHours() - 13) * 1.4)) : 0,
        humidity: 62 + (i % 7) * 4,
        pressure: 1006 + (i % 5) - 2,
        dewPoint: 21 + (i % 4) - 1,
        cloudCover: kind === 'clear' ? 12 + (i % 5) * 4 : kind === 'partly-cloudy' ? 48 : 90,
      }
    })
  const daily = Array.from({ length: 10 }, (_, i) => {
    const d = new Date(today.getTime() + i * 86400000)
    const date = fmtLocal(d).slice(0, 10)
    return {
      date,
      weatherCode: i % 4 === 3 ? (code === 0 ? 2 : 0) : code,
      temperatureMax: 32 - (i % 3),
      temperatureMin: 25 + (i % 2),
      apparentTemperatureMax: 34,
      apparentTemperatureMin: 24,
      precipitationProbability: ['drizzle', 'rain', 'heavy-rain', 'thunder'].includes(kind) ? 55 + ((i * 11) % 40) : (i * 9) % 30,
      precipitationSum: 1.2,
      windSpeedMax: 12,
      windGustsMax: 22,
      uvIndexMax: kind === 'clear' ? 8 : kind === 'snow' ? 1 : 4,
      sunrise: `${date}T05:47`,
      sunset: `${date}T18:58`,
    }
  })
  return {
    location: { name: '吴中区', province: '江苏省', city: '苏州', district: '吴中区', region: '华东', country: '中国', latitude: 31.26, longitude: 120.62, source: 'manual' },
    timezone: 'auto',
    current: {
      time: fmtLocal(now),
      temperature: 27,
      apparentTemperature: 30,
      humidity: 71,
      weatherCode: code,
      isDay,
      windSpeed: 8,
      windDirection: 135,
      windGusts: 15,
      pressure: 1006,
      visibility: kind === 'fog' ? 900 : 24000,
      precipitation: 0.3,
      cloudCover: kind === 'clear' ? 14 : kind === 'partly-cloudy' ? 46 : 92,
    },
    hourly,
    daily,
    alerts: kind === 'thunder' ? [{ id: 'mock-alert', level: 'moderate' as const, title: '雷暴风险', message: '未来 12 小时可能出现雷雨，请留意短时强降水和阵风。' }] : [],
    airQuality: {
      aqi: 38,
      pm25: 14.6,
      pm10: 27.3,
      hourlyAqi: Array.from({ length: 25 }, (_, i) => ({
        time: hourly[i].time,
        aqi: 30 + ((i * 17) % 38),
      })),
    },
    updatedAt: Date.now(),
  }
}

type View = 'modal' | 'full-card' | 'simple-card'

function Preview() {
  const [kind, setKind] = useState<WeatherSceneKind>('clear')
  const [isDay, setIsDay] = useState(() => { const h = new Date().getHours(); return h >= 6 && h < 19 })
  const [view, setView] = useState<View>('modal')
  const weather = useMemo(() => buildMock(kind, isDay), [kind, isDay])
  const theme = getWeatherVisualTheme(weather.current.weatherCode, weather.current.isDay)

  return (
    <div className="min-h-screen bg-slate-950 p-5 text-white">
      <div className="mx-auto flex max-w-[1240px] flex-wrap items-center gap-2">
        {KINDS.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className="rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
            style={{ background: kind === k ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)', color: kind === k ? '#fff' : 'rgba(255,255,255,0.6)' }}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-white/15" />
        <button type="button" onClick={() => setIsDay(v => !v)} className="rounded-full bg-white/6 px-3.5 py-1.5 text-xs text-white/75">
          {isDay ? '白天' : '夜晚'}
        </button>
        <span className="mx-1 h-4 w-px bg-white/15" />
        {([['modal', '详情弹窗'], ['full-card', '完整卡片'], ['simple-card', '简约卡片']] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className="rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors"
            style={{ background: view === v ? 'rgba(125,211,252,0.2)' : 'rgba(255,255,255,0.06)', color: view === v ? '#bae6fd' : 'rgba(255,255,255,0.6)' }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'modal' ? (
        <div className="mx-auto mt-4 max-w-[1240px] rounded-3xl border border-white/8">
          <WeatherDetailsModal open weather={weather} onClose={() => setView('full-card')} onRefresh={() => {}} loading={false} hazards={null} hazardLoading={false} onHazardRefresh={() => {}} onHazardEnsure={() => {}} />
        </div>
      ) : (
        <div className="mx-auto mt-4 grid w-full max-w-[1240px] grid-cols-1 gap-5 md:grid-cols-2">
          {[0, 1].map(i => (
            <div
              key={i}
              role="button"
              tabIndex={0}
              className="desktop-widget-card relative isolate w-full overflow-hidden rounded-[28px] text-left text-white outline-none"
              style={{
                background: theme.cardBackground,
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.11), 0 16px 42px rgba(15,23,42,0.12)',
                minHeight: 208,
              }}
            >
              {view === 'full-card' ? (
                <>
                  <WeatherAtmosphere theme={theme} compact />
                  <div className="relative z-10 px-5 pb-4 pt-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-white/70">
                      <span className="truncate">吴中区 · 位置 {i + 1}</span>
                    </div>
                    <div className="mt-3 flex items-end justify-between">
                      <div>
                        <span className="text-[3.4rem] font-semibold leading-[0.9] tabular-nums">27°</span>
                        <div className="mt-1.5 text-sm font-medium text-white/82">{KIND_LABELS[kind]}</div>
                        <div className="mt-0.5 text-xs text-white/55">体感 30° · 最高 32°</div>
                      </div>
                      <WeatherGlyph code={weather.current.weatherCode} isDay={weather.current.isDay} className="mb-1 h-14 w-14" />
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-2.5 text-[11px] text-white/65">
                      <span>8 km/h</span>
                      <span className="text-center">71%</span>
                      <span className="text-right">45% 降水</span>
                    </div>
                  </div>
                  {isRainySceneKind(theme.kind) && <WeatherRainGlass kind={theme.kind} className="absolute inset-0 z-20" />}
                </>
              ) : (
                <WeatherSimpleCard weather={weather} locationLabel={i === 0 ? '吴中区' : '张家港'} />
              )}
            </div>
          ))}
        </div>
      )}
      {/* 详情弹窗占位提示（弹窗是 fixed 全屏） */}
      {view === 'modal' && <div className="pointer-events-none fixed bottom-3 left-1/2 z-[500] -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-xs text-white/60">滚动验收 iPad 版式 · 点右上 ✕ 回到卡片预览<CloudSun className="ml-1 inline h-3 w-3" /></div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Preview />)
