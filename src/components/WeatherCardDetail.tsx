import { useMemo } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { getAqiLabel, type WeatherSnapshot } from '../services/weatherService'
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

/** 迷你趋势图：面积填充折线 */
function MiniTrend({ values, labels, color = '#8ec9f5', unit = '', suffix = '' }: { values: number[]; labels: string[]; color?: string; unit?: string; suffix?: string }) {
  const w = 640
  const h = 190
  const padX = 10
  const padTop = 22
  const padBottom = 30
  const finite = values.filter(v => Number.isFinite(v))
  const max = Math.max(...finite)
  const min = Math.min(...finite)
  const span = Math.max(0.001, max - min)
  const pts = values.map((v, i) => {
    const x = padX + (i / Math.max(1, values.length - 1)) * (w - padX * 2)
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
function SunArc({ sunrise, sunset, updatedAt }: { sunrise: string; sunset: string; updatedAt: number }) {
  const w = 560
  const h = 190
  const cx = w / 2
  const baseY = h - 36
  const r = 210
  const toMin = (t: string) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16))
  const riseM = toMin(sunrise)
  const setM = toMin(sunset)
  const nowDate = new Date(updatedAt)
  const nowM = nowDate.getHours() * 60 + nowDate.getMinutes()
  const progress = Math.min(1, Math.max(0, (nowM - riseM) / Math.max(1, setM - riseM)))
  const angle = Math.PI * (1 - progress)
  const sunX = cx - Math.cos(angle) * r * 0.92
  const sunY = baseY - Math.sin(angle) * (r * 0.52)
  const below = nowM < riseM || nowM > setM
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

  return createPortal(
    <AnimatePresence>
      {card && weather && meta && (
        <motion.div
          className="fixed inset-0 z-[420] flex items-start justify-center overflow-y-auto bg-slate-950/78 px-6 py-12 text-white backdrop-blur-2xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            className="w-full max-w-[640px] rounded-[32px] border border-white/10 bg-slate-900/55 p-7"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 18, opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={event => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-lg font-semibold">{meta.title}</div>
              <button
                type="button"
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
                  <div className="mt-3"><SunArc sunrise={weather.daily[0].sunrise} sunset={weather.daily[0].sunset} updatedAt={weather.updatedAt} /></div>
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
                    <span className="text-lg text-white/75">{getAqiLabel(weather.airQuality?.aqi ?? 0)}</span>
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
                        color="#4ade80"
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