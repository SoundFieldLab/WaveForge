import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  ChevronDown,
  Clock3,
  Cloud,
  CloudRain,
  Compass,
  Eye,
  EyeOff,
  Gauge,
  Layers3,
  MapPin,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Waves,
  Wind,
} from 'lucide-react'
import type { WeatherSnapshot } from '../services/weatherService'
import {
  getEarthquakeLocationRisk,
  getNearbyEarthquakes,
  getTyphoonLocationRisk,
  type EarthquakeEvent,
  type EarthquakeLocationRisk,
  type HazardRiskLevel,
  type HazardSnapshot,
  type TyphoonForecastPoint,
  type TyphoonInfo,
  type TyphoonLocationRisk,
  type TyphoonTrackPoint,
} from '../services/hazardService'
import {
  fetchHazardWeatherLayer,
  type HazardWeatherLayerGrid,
  type HazardWeatherLayerOptions,
} from '../services/hazardWeatherLayerService'
import {
  EarthquakeSourceMap,
  HAZARD_MAP_HEIGHT,
  HAZARD_MAP_WIDTH,
  type HazardMapBaseLayer,
  HazardMapNavigationControls,
  HazardMapTiles,
  useHazardMapNavigation,
  WindParticleLayer,
} from './HazardMapPrimitives'

export type WeatherHazardTab = 'typhoon' | 'earthquake'

interface WeatherHazardsPanelProps {
  tab: WeatherHazardTab
  weather: WeatherSnapshot | null
  hazards: HazardSnapshot | null
  loading: boolean
  error?: string
  onRefresh: () => void
}

const WARNING_LINES = {
  hours24: [[105, 0], [105, 15], [113, 22], [119, 22], [119, 28], [127, 34]] as Array<[number, number]>,
  hours48: [[105, 0], [105, 15], [120, 0], [132, 15], [132, 34], [127, 34]] as Array<[number, number]>,
}

const riskStyles: Record<HazardRiskLevel, { border: string; background: string; text: string; label: string }> = {
  watch: { border: 'rgba(56,189,248,.4)', background: 'rgba(3,105,161,.2)', text: '#bae6fd', label: '关注' },
  warning: { border: 'rgba(251,191,36,.48)', background: 'rgba(146,64,14,.24)', text: '#fde68a', label: '警戒' },
  danger: { border: 'rgba(251,113,133,.55)', background: 'rgba(159,18,57,.3)', text: '#fecdd3', label: '风险' },
}

const formatTyphoonTime = (value: string) => {
  const digits = String(value || '').replace(/\D/g, '')
  if (digits.length < 12) return value || '--'
  return `${digits.slice(4, 6)}月${digits.slice(6, 8)}日 ${digits.slice(8, 10)}:${digits.slice(10, 12)}`
}

const typeLabel = (type: string) => ({
  TD: '热带低压', TS: '热带风暴', STS: '强热带风暴', TY: '台风', STY: '强台风', SuperTY: '超强台风',
}[type] || type || '热带气旋')

const pointColor = (type: string) => ({
  TD: '#22c55e', TS: '#38bdf8', STS: '#fde047', TY: '#fb923c', STY: '#f43f5e', SuperTY: '#d946ef',
}[type] || '#67e8f9')

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const distanceKm = (latitudeA: number, longitudeA: number, latitudeB: number, longitudeB: number) => {
  const radians = (degree: number) => degree * Math.PI / 180
  const deltaLatitude = radians(latitudeB - latitudeA)
  const deltaLongitude = radians(longitudeB - longitudeA)
  const a = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(latitudeA)) * Math.cos(radians(latitudeB)) * Math.sin(deltaLongitude / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function RiskBanner({ risk, icon: Icon }: { risk: TyphoonLocationRisk | EarthquakeLocationRisk; icon: typeof Waves }) {
  const style = riskStyles[risk.level]
  return (
    <div className="rounded-[26px] border px-5 py-4" style={{ borderColor: style.border, background: style.background }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-2xl bg-white/10 p-2"><Icon className="h-5 w-5" style={{ color: style.text }} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{risk.title}</span>
            <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ color: style.text, background: 'rgba(255,255,255,.1)' }}>{style.label}</span>
          </div>
          <p className="mt-1.5 text-sm leading-6 text-white/68">{risk.message}</p>
        </div>
      </div>
    </div>
  )
}

interface MapLayerState {
  precipitation: boolean
  clouds: boolean
  wind: boolean
}

function LayerToggle({ active, label, icon: Icon, onClick }: { active: boolean; label: string; icon: typeof Layers3; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-medium transition-colors ${active ? 'border-cyan-200/35 bg-cyan-300/16 text-cyan-50' : 'border-white/10 bg-black/20 text-white/50 hover:bg-white/10'}`}
    >
      <Icon className="h-3.5 w-3.5" />{label}
    </button>
  )
}

function TimeSelect<T extends number>({ value, options, suffix, onChange, label }: {
  value: T
  options: readonly T[]
  suffix: string
  onChange: (value: T) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const formatOption = (option: T) => option === .5 ? '30 分钟' : `${option} ${suffix}`

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative z-40">
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-8 min-w-[92px] items-center justify-between gap-2 rounded-full border border-cyan-100/20 bg-slate-950/52 px-3 text-[10px] font-medium text-white/78 shadow-inner outline-none transition hover:border-cyan-100/35 hover:bg-slate-900/72 focus-visible:ring-2 focus-visible:ring-cyan-200/35"
      >
        <span>{formatOption(value)}</span>
        <ChevronDown className={`h-3 w-3 text-cyan-100/55 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -5, scale: .97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -5, scale: .97 }}
            transition={{ duration: .14 }}
            role="listbox"
            className="absolute left-0 top-[calc(100%+7px)] min-w-full overflow-hidden rounded-2xl border border-white/16 bg-slate-950/94 p-1.5 shadow-[0_16px_38px_rgba(2,6,23,.48)] backdrop-blur-xl"
          >
            {options.map(option => (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={option === value}
                onClick={() => { onChange(option); setOpen(false) }}
                className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[10px] transition-colors ${option === value ? 'bg-cyan-300/18 text-cyan-50' : 'text-white/62 hover:bg-white/10 hover:text-white'}`}
              >
                <span>{formatOption(option)}</span>
                <span className={`h-1.5 w-1.5 rounded-full ${option === value ? 'bg-cyan-300 shadow-[0_0_8px_rgba(103,232,249,.8)]' : 'bg-transparent'}`} />
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

type DisplayTrackPoint = (TyphoonTrackPoint & { forecast: false }) | (TyphoonForecastPoint & { forecast: true; id: string })

function TyphoonTrackChart({ typhoon, weather }: { typhoon: TyphoonInfo; weather: WeatherSnapshot | null }) {
  const [show24HourLine, setShow24HourLine] = useState(true)
  const [show48HourLine, setShow48HourLine] = useState(true)
  const [layers, setLayers] = useState<MapLayerState>({ precipitation: false, clouds: false, wind: false })
  const [layerOptions, setLayerOptions] = useState<HazardWeatherLayerOptions>({ cloudHours: 1, precipitationHours: 24 })
  const [weatherLayer, setWeatherLayer] = useState<HazardWeatherLayerGrid | null>(null)
  const [weatherLayerLoading, setWeatherLayerLoading] = useState(false)
  const [weatherLayerError, setWeatherLayerError] = useState('')
  const [hoveredPoint, setHoveredPoint] = useState<{ point: DisplayTrackPoint; x: number; y: number } | null>(null)
  const [baseLayer, setBaseLayer] = useState<HazardMapBaseLayer>('topographic')
  const mapFrameRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const frame = mapFrameRef.current
    if (!frame) return
    const preventPageScroll = (event: WheelEvent) => event.preventDefault()
    frame.addEventListener('wheel', preventPageScroll, { passive: false })
    return () => frame.removeEventListener('wheel', preventPageScroll)
  }, [])

  const points = useMemo<DisplayTrackPoint[]>(() => {
    const actual = typhoon.track.slice(-72).map(point => ({ ...point, forecast: false as const }))
    const forecast = (typhoon.forecast || []).map((point, index) => ({ ...point, id: `forecast-${point.agency}-${point.hours}-${index}`, forecast: true as const }))
    return [...actual, ...forecast]
  }, [typhoon])

  const chart = useMemo(() => {
    if (points.length === 0) return null
    const normalized = points.map((point, index) => {
      let longitude = point.longitude
      if (index > 0) {
        const previous = points[index - 1].longitude
        if (longitude - previous > 180) longitude -= 360
        else if (longitude - previous < -180) longitude += 360
      }
      return { ...point, longitude } as DisplayTrackPoint
    })
    const actualNormalized = normalized.filter(point => !point.forecast)
    const forecastNormalized = normalized.filter(point => point.forecast)
    const pathPoints = actualNormalized.length > 0 ? actualNormalized : normalized
    const longitudes = pathPoints.map(point => point.longitude)
    const latitudes = pathPoints.map(point => point.latitude)
    forecastNormalized.forEach(point => {
      longitudes.push(point.longitude)
      latitudes.push(point.latitude)
    })
    const centerLongitude = longitudes.reduce((sum, value) => sum + value, 0) / longitudes.length
    let locationPoint = weather ? { longitude: weather.location.longitude, latitude: weather.location.latitude } : null
    if (locationPoint) {
      while (locationPoint.longitude - centerLongitude > 180) locationPoint.longitude -= 360
      while (locationPoint.longitude - centerLongitude < -180) locationPoint.longitude += 360
      const averageLatitude = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length
      const closeEnough = Math.abs(locationPoint.longitude - centerLongitude) < 38 && Math.abs(locationPoint.latitude - averageLatitude) < 28
      if (closeEnough) {
        longitudes.push(locationPoint.longitude)
        latitudes.push(locationPoint.latitude)
      } else {
        locationPoint = null
      }
    }
    const rawMinLon = Math.min(...longitudes)
    const rawMaxLon = Math.max(...longitudes)
    const rawMinLat = Math.min(...latitudes)
    const rawMaxLat = Math.max(...latitudes)
    const spanLongitude = clamp(rawMaxLon - rawMinLon + 9, 28, 64)
    const spanLatitude = clamp(rawMaxLat - rawMinLat + 7, 17, 38)
    const centerLon = (rawMinLon + rawMaxLon) / 2
    const centerLat = (rawMinLat + rawMaxLat) / 2
    const bounds = {
      minLongitude: centerLon - spanLongitude / 2,
      maxLongitude: centerLon + spanLongitude / 2,
      minLatitude: clamp(centerLat - spanLatitude / 2, -80, 80),
      maxLatitude: clamp(centerLat + spanLatitude / 2, -80, 80),
    }
    return { normalized, locationPoint, bounds }
  }, [points, weather?.location.latitude, weather?.location.longitude])

  const navigation = useHazardMapNavigation(chart?.bounds || null)
  const anyWeatherLayerEnabled = layers.precipitation || layers.clouds || layers.wind
  useEffect(() => {
    if (!chart || !anyWeatherLayerEnabled) return
    const controller = new AbortController()
    setWeatherLayerLoading(true)
    setWeatherLayerError('')
    fetchHazardWeatherLayer(chart.bounds, layerOptions, controller.signal)
      .then(setWeatherLayer)
      .catch(error => {
        if ((error as Error).name !== 'AbortError') setWeatherLayerError((error as Error).message || '图层数据暂时不可用')
      })
      .finally(() => {
        if (!controller.signal.aborted) setWeatherLayerLoading(false)
      })
    return () => controller.abort()
  }, [anyWeatherLayerEnabled, chart?.bounds.minLongitude, chart?.bounds.maxLongitude, chart?.bounds.minLatitude, chart?.bounds.maxLatitude, layerOptions.cloudHours, layerOptions.precipitationHours])

  if (!chart || !navigation) return <div className="flex h-64 items-center justify-center text-sm text-white/45">暂无可绘制路径</div>
  const { viewport } = navigation
  const actual = chart.normalized.filter(point => !point.forecast)
  const forecast = chart.normalized.filter(point => point.forecast)
  const actualPath = actual.map(point => `${viewport.x(point.longitude)},${viewport.y(point.latitude)}`).join(' ')
  const forecastBase = actual.at(-1)
  const forecastPath = [forecastBase, ...forecast].filter(Boolean).map(point => `${viewport.x(point!.longitude)},${viewport.y(point!.latitude)}`).join(' ')
  const warning24Path = WARNING_LINES.hours24.map(([longitude, latitude]) => `${viewport.x(longitude)},${viewport.y(latitude)}`).join(' ')
  const warning48Path = WARNING_LINES.hours48.map(([longitude, latitude]) => `${viewport.x(longitude)},${viewport.y(latitude)}`).join(' ')
  const projectedWind = (weatherLayer?.samples || []).map(sample => ({ ...sample, x: viewport.x(sample.longitude), y: viewport.y(sample.latitude) }))
  const toggleLayer = (key: keyof MapLayerState) => setLayers(current => ({ ...current, [key]: !current[key] }))
  const tooltipLeft = hoveredPoint ? clamp(hoveredPoint.x / HAZARD_MAP_WIDTH * 100, 4, 73) : 0
  const tooltipTop = hoveredPoint ? clamp(hoveredPoint.y / HAZARD_MAP_HEIGHT * 100, 5, 66) : 0

  return (
    <div className="overflow-hidden rounded-[26px] border border-white/10 bg-slate-950/25 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-white/82">实时路径地图</div>
          <div className="mt-1 text-[11px] text-white/42">地图 / 卫星影像 · 实况实线 · 预报虚线 · 悬停路径点查看数据</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LayerToggle active={show24HourLine} label="24小时警戒线" icon={show24HourLine ? Eye : EyeOff} onClick={() => setShow24HourLine(value => !value)} />
          <LayerToggle active={show48HourLine} label="48小时警戒线" icon={show48HourLine ? Eye : EyeOff} onClick={() => setShow48HourLine(value => !value)} />
        </div>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl border border-white/8 bg-black/15 p-2">
        <span className="flex items-center gap-1.5 px-1 text-[11px] text-white/40"><Layers3 className="h-3.5 w-3.5" />气象图层</span>
        <LayerToggle active={layers.precipitation} label="降雨" icon={CloudRain} onClick={() => toggleLayer('precipitation')} />
        {layers.precipitation && <TimeSelect value={layerOptions.precipitationHours} options={[24, 48, 72] as const} suffix="小时" label="降雨预报时效" onChange={precipitationHours => setLayerOptions(current => ({ ...current, precipitationHours }))} />}
        <LayerToggle active={layers.clouds} label="云图" icon={Cloud} onClick={() => toggleLayer('clouds')} />
        {layers.clouds && <TimeSelect value={layerOptions.cloudHours} options={[.5, 1, 3, 6] as const} suffix="小时" label="云图时效" onChange={cloudHours => setLayerOptions(current => ({ ...current, cloudHours }))} />}
        <LayerToggle active={layers.wind} label="流动风场" icon={Wind} onClick={() => toggleLayer('wind')} />
        {weatherLayerLoading && <span className="ml-auto flex items-center gap-1.5 text-[11px] text-cyan-100/55"><RefreshCw className="h-3 w-3 animate-spin" />加载图层</span>}
        {weatherLayerError && <span className="ml-auto text-[11px] text-rose-200/70">{weatherLayerError}</span>}
      </div>
      <div ref={mapFrameRef} className={`relative aspect-[960/500] overflow-hidden rounded-[20px] border border-white/10 bg-[#16324b] ${navigation.isDragging ? 'cursor-grabbing' : 'cursor-grab'}`} style={{ touchAction: 'none', overscrollBehavior: 'none' }} onMouseLeave={() => setHoveredPoint(null)} onWheel={navigation.onWheel} onPointerDown={navigation.onPointerDown} onPointerMove={navigation.onPointerMove} onPointerUp={navigation.onPointerUp} onPointerCancel={navigation.onPointerCancel}>
        <HazardMapTiles viewport={viewport} dim={baseLayer === 'satellite' ? .045 : (layers.clouds || layers.precipitation ? .08 : .12)} baseLayer={baseLayer} />
        <HazardMapNavigationControls navigation={navigation} baseLayer={baseLayer} onBaseLayerChange={setBaseLayer} />
        <svg viewBox={`0 0 ${HAZARD_MAP_WIDTH} ${HAZARD_MAP_HEIGHT}`} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <defs>
            <radialGradient id={`rain-${typhoon.id}`}><stop offset="0" stopColor="#7dd3fc" stopOpacity=".92" /><stop offset=".42" stopColor="#2563eb" stopOpacity=".56" /><stop offset=".72" stopColor="#7c3aed" stopOpacity=".28" /><stop offset="1" stopColor="#1d4ed8" stopOpacity="0" /></radialGradient>
            <radialGradient id={`cloud-${typhoon.id}`}><stop offset="0" stopColor="#fff" stopOpacity=".7" /><stop offset=".62" stopColor="#dbeafe" stopOpacity=".3" /><stop offset="1" stopColor="#dbeafe" stopOpacity="0" /></radialGradient>
            <filter id={`soft-${typhoon.id}`}><feGaussianBlur stdDeviation="14" /></filter>
          </defs>
          {layers.clouds && weatherLayer?.samples.map((sample, index) => (
            <ellipse key={`cloud-${index}`} cx={viewport.x(sample.longitude)} cy={viewport.y(sample.latitude)} rx={68 + sample.cloudCover * .68} ry={38 + sample.cloudCover * .42} fill={`url(#cloud-${typhoon.id})`} opacity={.12 + sample.cloudCover / 138} filter={`url(#soft-${typhoon.id})`} />
          ))}
          {layers.precipitation && weatherLayer?.samples.filter(sample => sample.precipitation > .15).map((sample, index) => (
            <circle key={`rain-${index}`} cx={viewport.x(sample.longitude)} cy={viewport.y(sample.latitude)} r={32 + Math.min(112, Math.sqrt(sample.precipitation) * 18)} fill={`url(#rain-${typhoon.id})`} opacity={Math.min(.92, .28 + sample.precipitation / 35)} />
          ))}
        </svg>
        {layers.wind && weatherLayer && <WindParticleLayer samples={projectedWind} />}
        <svg viewBox={`0 0 ${HAZARD_MAP_WIDTH} ${HAZARD_MAP_HEIGHT}`} className="absolute inset-0 h-full w-full" role="img" aria-label={`${typhoon.chineseName}台风实时路径地图`}>
          <defs>
            <linearGradient id={`typhoon-track-${typhoon.id}`} x1="0" x2="1"><stop offset="0" stopColor="#67e8f9" /><stop offset="1" stopColor="#fb7185" /></linearGradient>
          </defs>
          {show48HourLine && <polyline points={warning48Path} fill="none" stroke="#fde047" strokeWidth="3" strokeDasharray="10 8" strokeLinecap="round" strokeLinejoin="round" />}
          {show24HourLine && <polyline points={warning24Path} fill="none" stroke="#fb7185" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />}
          {show48HourLine && <text x={viewport.x(131.4)} y={viewport.y(31.7)} fill="#fef08a" fontSize="15" fontWeight="700" style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,.8)', strokeWidth: 4 }}>48小时</text>}
          {show24HourLine && <text x={viewport.x(126.4)} y={viewport.y(31.7)} fill="#fecdd3" fontSize="15" fontWeight="700" textAnchor="end" style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,.8)', strokeWidth: 4 }}>24小时</text>}
          {actualPath && <polyline points={actualPath} fill="none" stroke="rgba(2,6,23,.72)" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />}
          {actualPath && <polyline points={actualPath} fill="none" stroke={`url(#typhoon-track-${typhoon.id})`} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />}
          {forecastPath && <polyline points={forecastPath} fill="none" stroke="rgba(2,6,23,.7)" strokeWidth="7" strokeDasharray="10 9" strokeLinecap="round" strokeLinejoin="round" />}
          {forecastPath && <polyline points={forecastPath} fill="none" stroke="#fde68a" strokeWidth="3.5" strokeDasharray="10 9" strokeLinecap="round" strokeLinejoin="round" />}
          {actual.map((point, index) => {
            const visible = index % Math.max(1, Math.floor(actual.length / 20)) === 0 || index === actual.length - 1
            const x = viewport.x(point.longitude)
            const y = viewport.y(point.latitude)
            return <g key={point.id || `${point.time}-${index}`} onMouseEnter={() => setHoveredPoint({ point, x, y })} onFocus={() => setHoveredPoint({ point, x, y })}>
              {visible && <circle cx={x} cy={y} r={index === actual.length - 1 ? 9 : 4.6} fill={pointColor(point.type)} stroke="white" strokeWidth="1.8" />}
              <circle cx={x} cy={y} r="13" fill="transparent" className="cursor-pointer" tabIndex={0} />
            </g>
          })}
          {forecast.map((point, index) => {
            const x = viewport.x(point.longitude)
            const y = viewport.y(point.latitude)
            return <g key={point.id} onMouseEnter={() => setHoveredPoint({ point, x, y })} onFocus={() => setHoveredPoint({ point, x, y })}>
              <circle cx={x} cy={y} r="5" fill={pointColor(point.type) || '#fde68a'} stroke="rgba(15,23,42,.9)" strokeWidth="1.7" />
              <circle cx={x} cy={y} r="14" fill="transparent" className="cursor-pointer" tabIndex={0} />
            </g>
          })}
          {chart.locationPoint && <g transform={`translate(${viewport.x(chart.locationPoint.longitude)} ${viewport.y(chart.locationPoint.latitude)})`}><circle r="15" fill="rgba(255,255,255,.2)" /><circle r="6" fill="#fff" /><text x="18" y="5" fill="white" fontSize="14" fontWeight="600" style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,.75)', strokeWidth: 4 }}>当前位置</text></g>}
        </svg>
        {hoveredPoint && <div className="pointer-events-none absolute z-20 w-[220px] rounded-2xl border border-white/20 bg-slate-950/88 p-3 text-[11px] text-white shadow-2xl backdrop-blur-xl" style={{ left: `${tooltipLeft}%`, top: `${tooltipTop}%` }}>
          <div className="flex items-center justify-between gap-2"><span className="font-semibold text-white">{hoveredPoint.point.forecast ? `${hoveredPoint.point.agency || 'BABJ'} 预报` : typeLabel(hoveredPoint.point.type)}</span><span className="rounded-full px-2 py-0.5" style={{ background: `${pointColor(hoveredPoint.point.type)}28`, color: pointColor(hoveredPoint.point.type) }}>{hoveredPoint.point.forecast ? `+${hoveredPoint.point.hours}h` : '实况'}</span></div>
          <div className="mt-2 text-white/55">{formatTyphoonTime(hoveredPoint.point.time)}</div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-white/72"><span>位置</span><span className="text-right">{hoveredPoint.point.latitude.toFixed(1)}°N, {hoveredPoint.point.longitude.toFixed(1)}°E</span><span>最大风速</span><span className="text-right">{hoveredPoint.point.windSpeed || '--'} m/s</span><span>中心气压</span><span className="text-right">{hoveredPoint.point.pressure || '--'} hPa</span>{!hoveredPoint.point.forecast && <><span>移动</span><span className="text-right">{hoveredPoint.point.moveDirection || '--'} {hoveredPoint.point.moveSpeed || '--'} km/h</span></>}{weather && <><span>距当前位置</span><span className="text-right">{Math.round(distanceKm(weather.location.latitude, weather.location.longitude, hoveredPoint.point.latitude, hoveredPoint.point.longitude))} km</span></>}</div>
        </div>}
        {anyWeatherLayerEnabled && <div className="pointer-events-none absolute bottom-2 right-3 rounded-full bg-slate-950/62 px-2.5 py-1 text-[9px] text-white/62 backdrop-blur-md">{layers.precipitation ? `未来 ${layerOptions.precipitationHours}h 累计降雨` : ''}{layers.precipitation && layers.clouds ? ' · ' : ''}{layers.clouds ? `${layerOptions.cloudHours === .5 ? '30 分钟' : `${layerOptions.cloudHours}h`} 云图` : ''}{(layers.precipitation || layers.clouds) && layers.wind ? ' · ' : ''}{layers.wind ? '实时流动风场' : ''}</div>}
      </div>
    </div>
  )
}

function TyphoonPanel({ weather, hazards, loading, error, onRefresh }: Omit<WeatherHazardsPanelProps, 'tab'>) {
  const typhoons = hazards?.typhoons?.items || []
  const risk = weather ? getTyphoonLocationRisk(hazards, weather.location.latitude, weather.location.longitude) : null
  const [selectedId, setSelectedId] = useState('')
  useEffect(() => {
    if (typhoons.length > 0 && !typhoons.some(item => item.id === selectedId)) setSelectedId(risk?.typhoon.id || typhoons[0].id)
  }, [risk?.typhoon.id, selectedId, typhoons])
  const selected = typhoons.find(item => item.id === selectedId) || typhoons[0]

  return (
    <div className="mt-7 space-y-5">
      {risk && <RiskBanner risk={risk} icon={Waves} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-2xl font-semibold">西北太平洋活跃台风</h3><p className="mt-1 text-sm text-white/48">实时位置与中央气象台 BABJ 预报路径</p></div>
        <button type="button" onClick={onRefresh} disabled={loading} className="flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70 hover:bg-white/14 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
      </div>
      {loading && !hazards ? <div className="flex min-h-[360px] items-center justify-center text-white/55"><RefreshCw className="mr-2 h-5 w-5 animate-spin" />正在连接中央气象台…</div>
        : error && typhoons.length === 0 ? <div className="rounded-[26px] border border-rose-300/20 bg-rose-950/20 p-6 text-rose-100/75">{error}</div>
          : typhoons.length === 0 ? <div className="rounded-[28px] border border-white/10 bg-white/[0.04] p-10 text-center"><ShieldAlert className="mx-auto h-9 w-9 text-emerald-200/70" /><div className="mt-4 font-medium">当前没有中央气象台标记为活跃的台风</div><div className="mt-2 text-sm text-white/45">数据会随桌面天气自动更新，也可以点击右上角刷新。</div></div>
            : <>
              <div className="grid gap-3 md:grid-cols-2">{typhoons.map(typhoon => {
                const latest = typhoon.latest
                const selectedCard = selected?.id === typhoon.id
                return <button key={typhoon.id} type="button" onClick={() => setSelectedId(typhoon.id)} className="rounded-[26px] border p-5 text-left transition-colors" style={{ borderColor: selectedCard ? 'rgba(103,232,249,.42)' : 'rgba(255,255,255,.1)', background: selectedCard ? 'rgba(8,145,178,.13)' : 'rgba(255,255,255,.045)' }}>
                  <div className="flex items-start justify-between gap-3"><div><div className="text-lg font-semibold">{typhoon.number}号 {typhoon.chineseName}</div><div className="mt-1 text-xs uppercase tracking-[.14em] text-white/38">{typhoon.internationalName || 'UNNAMED'}</div></div><span className="rounded-full bg-emerald-400/12 px-2.5 py-1 text-[10px] font-semibold text-emerald-200/80">活动中</span></div>
                  {latest && <div className="mt-5 grid grid-cols-3 gap-3 text-xs"><div><Wind className="h-4 w-4 text-cyan-200/80" /><div className="mt-2 text-white/40">{latest.windSpeed} m/s</div></div><div><Gauge className="h-4 w-4 text-violet-200/80" /><div className="mt-2 text-white/40">{latest.pressure} hPa</div></div><div><Compass className="h-4 w-4 text-amber-200/80" /><div className="mt-2 text-white/40">{typeLabel(latest.type)}</div></div></div>}
                </button>
              })}</div>
              {selected && <>
                <TyphoonTrackChart typhoon={selected} weather={weather} />
                {selected.latest && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
                  ['实时位置', `${selected.latest.latitude.toFixed(1)}°N · ${selected.latest.longitude.toFixed(1)}°E`, MapPin],
                  ['中心风速', `${selected.latest.windSpeed} m/s`, Wind],
                  ['中心气压', `${selected.latest.pressure} hPa`, Gauge],
                  ['更新时间', formatTyphoonTime(selected.latest.time), Clock3],
                ].map(([label, value, Icon]) => {
                  const IconComponent = Icon as typeof MapPin
                  return <div key={String(label)} className="rounded-3xl border border-white/10 bg-white/[0.055] p-4"><IconComponent className="h-4 w-4 text-cyan-200/80" /><div className="mt-3 text-xs text-white/40">{String(label)}</div><div className="mt-1 text-sm font-medium">{String(value)}</div></div>
                })}</div>}
              </>}
            </>}
      <div className="border-t border-white/10 pt-4 text-xs leading-5 text-white/38">台风路径来源：中国气象局中央气象台台风网；底图数据来自 Esri / OpenStreetMap，降雨、云量与风场来自 Open-Meteo，仅作辅助可视化。请以当地气象部门发布的正式预警和防御指引为准。</div>
    </div>
  )
}

function EarthquakePanel({ weather, hazards, loading, error, onRefresh }: Omit<WeatherHazardsPanelProps, 'tab'>) {
  const risk = weather ? getEarthquakeLocationRisk(hazards, weather.location.latitude, weather.location.longitude) : null
  const nearby = weather ? getNearbyEarthquakes(hazards, weather.location.latitude, weather.location.longitude) : []
  const fallback = hazards?.earthquakes?.items.slice(0, 20).map(event => ({ event, distanceKm: Number.NaN, timestamp: Date.parse(event.time) })) || []
  const events = nearby.length > 0 ? nearby : fallback
  const [selectedId, setSelectedId] = useState('')
  const [hasInteracted, setHasInteracted] = useState(false)
  useEffect(() => {
    if (events.length === 0) return
    if ((!hasInteracted && !selectedId) || (selectedId && !events.some(item => item.event.id === selectedId))) {
      setSelectedId(events[0].event.id)
    }
  }, [events, hasInteracted, selectedId])
  return (
    <div className="mt-7 space-y-5">
      {risk && <RiskBanner risk={risk} icon={Activity} />}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h3 className="text-2xl font-semibold">地震监测</h3><p className="mt-1 text-sm text-white/48">点击事件查看震源参数和地图位置</p></div>
        <button type="button" onClick={onRefresh} disabled={loading} className="flex items-center gap-2 rounded-full border border-white/12 bg-white/8 px-4 py-2 text-sm text-white/70 hover:bg-white/14 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />刷新</button>
      </div>
      <div className="rounded-[24px] border border-amber-300/18 bg-amber-950/15 px-5 py-4 text-sm leading-6 text-amber-100/72"><RadioTower className="mr-2 inline h-4 w-4" />本板块使用{hazards?.earthquakes?.source || '中国地震台网中心公开地震目录'}生成位置提醒，不等同于面向终端设备的到秒地震预警。发生明显震感时请立即避险并遵循当地官方信息。</div>
      {loading && !hazards ? <div className="flex min-h-[360px] items-center justify-center text-white/55"><RefreshCw className="mr-2 h-5 w-5 animate-spin" />正在获取地震目录…</div>
        : error && events.length === 0 ? <div className="rounded-[26px] border border-rose-300/20 bg-rose-950/20 p-6 text-rose-100/75">{error}</div>
          : <>
            <div className="space-y-3">{events.map(({ event, distanceKm: eventDistance }) => {
              const magnitudeColor = event.magnitude >= 6 ? '#fda4af' : event.magnitude >= 5 ? '#fdba74' : event.magnitude >= 4 ? '#fde68a' : '#a5f3fc'
              const selected = event.id === selectedId
              const detailDistance = weather
                ? distanceKm(weather.location.latitude, weather.location.longitude, event.latitude, event.longitude)
                : eventDistance
              return <div key={event.id} className="overflow-hidden rounded-[24px] border transition-colors" style={{ borderColor: selected ? `${magnitudeColor}55` : 'rgba(255,255,255,.1)', background: selected ? `${magnitudeColor}12` : 'rgba(255,255,255,.05)' }}>
                <button type="button" onClick={() => { setHasInteracted(true); setSelectedId(current => current === event.id ? '' : event.id) }} aria-expanded={selected} aria-controls={`earthquake-detail-${event.id}`} className="grid w-full grid-cols-[72px_1fr_auto] items-center gap-4 px-4 py-4 text-left">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl text-lg font-bold" style={{ color: magnitudeColor, background: `${magnitudeColor}18`, border: `1px solid ${magnitudeColor}35` }}>M{event.magnitude.toFixed(1)}</div>
                  <div className="min-w-0"><div className="truncate font-medium">{event.location}</div><div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-white/44"><span>{event.time}</span><span>深度 {event.depth} km</span><span>{event.latitude.toFixed(2)}°, {event.longitude.toFixed(2)}°</span></div></div>
                  <div className="flex items-center gap-2 text-right text-xs text-white/45"><div>{Number.isFinite(eventDistance) ? <><div className="text-sm font-medium text-white/72">{Math.round(eventDistance)} km</div><div className="mt-1">距当前位置</div></> : selected ? '正在查看' : '查看详情'}</div><ChevronDown className={`h-4 w-4 shrink-0 transition-transform duration-300 ${selected ? 'rotate-180 text-white/75' : 'text-white/35'}`} /></div>
                </button>
                <AnimatePresence initial={false}>
                  {selected && <motion.div id={`earthquake-detail-${event.id}`} key={`earthquake-detail-${event.id}`} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ height: { duration: .28, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: .18 } }} className="overflow-hidden">
                    <div className="border-t border-white/10 p-4 pt-3">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-white/48"><span>震源详情 · {event.location}</span>{Number.isFinite(detailDistance) && <span>距当前位置约 {Math.round(detailDistance)} km</span>}</div>
                      <EarthquakeSourceMap event={event} currentLocation={weather ? { latitude: weather.location.latitude, longitude: weather.location.longitude } : null} />
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{[
                        ['震级', `M${event.magnitude.toFixed(1)}`],
                        ['震源深度', `${event.depth} km`],
                        ['震中坐标', `${event.latitude.toFixed(2)}°, ${event.longitude.toFixed(2)}°`],
                        ['发生时间', event.time],
                      ].map(([label, value]) => <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.045] px-3 py-3"><div className="text-[10px] text-white/38">{label}</div><div className="mt-1 text-xs font-medium text-white/75">{value}</div></div>)}</div>
                    </div>
                  </motion.div>}
                </AnimatePresence>
              </div>
            })}</div>
          </>}
      <div className="border-t border-white/10 pt-4 text-xs leading-5 text-white/38">数据来源：{hazards?.earthquakes?.source || '中国地震台网中心公开地震目录'}；底图数据来自 Esri / OpenStreetMap。震级、位置与时间可能随后续正式测定更新。</div>
    </div>
  )
}

export default function WeatherHazardsPanel(props: WeatherHazardsPanelProps) {
  return props.tab === 'typhoon'
    ? <TyphoonPanel {...props} />
    : <EarthquakePanel {...props} />
}

