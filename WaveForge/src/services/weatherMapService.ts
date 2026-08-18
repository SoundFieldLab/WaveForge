export type WeatherMapLayerId =
  | 'wind'
  | 'temperature'
  | 'humidity'
  | 'cloud'
  | 'pressure'
  | 'cape'
  | 'wave'
  | 'aurora'
  | 'snow'
  | 'dewPoint'
  | 'radar'
  | 'pm25'
  | 'fire'
  | 'solar'

export interface WeatherMapColorStop {
  value: number
  color: string
}

export interface WeatherMapLayerDefinition {
  id: WeatherMapLayerId
  label: string
  shortLabel: string
  unit: string
  min: number
  max: number
  decimals?: number
  colors: WeatherMapColorStop[]
  description: string
}

export interface WeatherMapPointValue {
  layer: WeatherMapLayerId
  value: number
  unit: string
  label: string
  latitude: number
  longitude: number
  hourOffset: number
  time: string
  source: 'forecast' | 'air-quality' | 'marine' | 'derived' | 'estimate'
  secondary?: string
}

export const WEATHER_MAP_LAYERS: WeatherMapLayerDefinition[] = [
  {
    id: 'wind', label: '风', shortLabel: '风速', unit: 'km/h', min: 0, max: 80,
    colors: [{ value: 0, color: '#4f88d7' }, { value: 15, color: '#43b7a5' }, { value: 30, color: '#d7cb55' }, { value: 50, color: '#e1773f' }, { value: 80, color: '#7b2f74' }],
    description: '10 米风速与风向',
  },
  {
    id: 'temperature', label: '温度', shortLabel: '温度', unit: '°C', min: -30, max: 45,
    colors: [{ value: -30, color: '#4a1b8f' }, { value: -15, color: '#315ec4' }, { value: 0, color: '#42a9b8' }, { value: 10, color: '#75ae64' }, { value: 25, color: '#d8c64f' }, { value: 35, color: '#dc793a' }, { value: 45, color: '#a7372d' }],
    description: '地面 2 米气温',
  },
  {
    id: 'humidity', label: '相对湿度', shortLabel: '湿度', unit: '%', min: 0, max: 100,
    colors: [{ value: 0, color: '#b07a3d' }, { value: 35, color: '#d2bd62' }, { value: 60, color: '#70ad88' }, { value: 80, color: '#3d8eb0' }, { value: 100, color: '#385394' }],
    description: '2 米相对湿度',
  },
  {
    id: 'cloud', label: '云量', shortLabel: '云量', unit: '%', min: 0, max: 100,
    colors: [{ value: 0, color: '#7697c2' }, { value: 35, color: '#aeb9c3' }, { value: 70, color: '#d9dcdf' }, { value: 100, color: '#ffffff' }],
    description: '总云量覆盖率',
  },
  {
    id: 'pressure', label: '压强', shortLabel: '气压', unit: 'hPa', min: 960, max: 1040,
    colors: [{ value: 960, color: '#5b3b8c' }, { value: 985, color: '#3f74b6' }, { value: 1005, color: '#58a77c' }, { value: 1020, color: '#d0bb4d' }, { value: 1040, color: '#d7693f' }],
    description: '地面气压',
  },
  {
    id: 'cape', label: '对流能量', shortLabel: '雷暴潜势', unit: 'J/kg', min: 0, max: 4000,
    colors: [{ value: 0, color: '#596b82' }, { value: 500, color: '#5fa269' }, { value: 1500, color: '#d6bc49' }, { value: 2500, color: '#e06b39' }, { value: 4000, color: '#8d244d' }],
    description: '对流有效位能（CAPE），数值越高越有利于雷暴发展',
  },
  {
    id: 'wave', label: '海浪高度', shortLabel: '浪高', unit: 'm', min: 0, max: 10,
    colors: [{ value: 0, color: '#397fb2' }, { value: 1.5, color: '#4fb9a1' }, { value: 3, color: '#d4c452' }, { value: 6, color: '#dc7044' }, { value: 10, color: '#6e326f' }],
    description: '海面有效波高',
  },
  {
    id: 'aurora', label: '极光概率', shortLabel: '极光', unit: '%', min: 0, max: 100,
    colors: [{ value: 0, color: '#27375b' }, { value: 25, color: '#2d7b80' }, { value: 55, color: '#4bbd78' }, { value: 80, color: '#b7de64' }, { value: 100, color: '#ec8be6' }],
    description: '基于纬度与时段的可见概率估计',
  },
  {
    id: 'snow', label: '雪深', shortLabel: '雪深', unit: 'cm', min: 0, max: 120,
    colors: [{ value: 0, color: '#577a93' }, { value: 10, color: '#a6d5df' }, { value: 35, color: '#eef8fb' }, { value: 75, color: '#bfc6f1' }, { value: 120, color: '#796cba' }],
    description: '地表积雪深度',
  },
  {
    id: 'dewPoint', label: '露点温度', shortLabel: '露点', unit: '°C', min: -30, max: 35,
    colors: [{ value: -30, color: '#52419a' }, { value: -10, color: '#397eb2' }, { value: 5, color: '#55ad92' }, { value: 20, color: '#d0c34e' }, { value: 35, color: '#d96a45' }],
    description: '2 米露点温度',
  },
  {
    id: 'radar', label: '雷达组合反射率', shortLabel: '雷达', unit: 'dBZ', min: 0, max: 70,
    colors: [{ value: 0, color: '#375386' }, { value: 10, color: '#3ba6c5' }, { value: 25, color: '#57bc67' }, { value: 40, color: '#e2d548' }, { value: 55, color: '#e15838' }, { value: 70, color: '#a5288e' }],
    description: '由逐小时降水强度换算的雷达表现',
  },
  {
    id: 'pm25', label: 'PM2.5', shortLabel: 'PM2.5', unit: 'μg/m³', min: 0, max: 250,
    colors: [{ value: 0, color: '#4eb77d' }, { value: 35, color: '#d4c844' }, { value: 75, color: '#e8983d' }, { value: 115, color: '#d95545' }, { value: 150, color: '#8f3b86' }, { value: 250, color: '#682f45' }],
    description: '细颗粒物浓度',
  },
  {
    id: 'fire', label: '森林火灾', shortLabel: '火险', unit: '指数', min: 0, max: 100,
    colors: [{ value: 0, color: '#387e75' }, { value: 25, color: '#83ae57' }, { value: 50, color: '#d5bd48' }, { value: 75, color: '#dc6b37' }, { value: 100, color: '#8e2c30' }],
    description: '基于温度、湿度、风速和降水的火险估计',
  },
  {
    id: 'solar', label: '太阳净辐照', shortLabel: '辐照', unit: 'W/m²', min: 0, max: 1000,
    colors: [{ value: 0, color: '#34456d' }, { value: 200, color: '#4d8ab1' }, { value: 450, color: '#71ad75' }, { value: 700, color: '#dbc44c' }, { value: 1000, color: '#e06b38' }],
    description: '短波太阳辐射',
  },
]

export const WEATHER_MAP_LAYER_BY_ID = Object.fromEntries(
  WEATHER_MAP_LAYERS.map(layer => [layer.id, layer]),
) as Record<WeatherMapLayerId, WeatherMapLayerDefinition>

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
const WEATHER_MAP_BASE_UTC_HOUR = (() => {
  const now = new Date()
  return now.getUTCHours() + now.getUTCMinutes() / 60
})()
const WEATHER_MAP_LAYER_SEED = Object.fromEntries(WEATHER_MAP_LAYERS.map((layer, index) => [layer.id, index + 1])) as Record<WeatherMapLayerId, number>

const longitudeDistance = (longitude: number, center: number) => {
  const distance = Math.abs(longitude - center) % 360
  return Math.min(distance, 360 - distance)
}

const pressureSystem = (
  latitude: number,
  longitude: number,
  centerLatitude: number,
  centerLongitude: number,
  latitudeRadius: number,
  longitudeRadius: number,
) => {
  const latitudeDistance = (latitude - centerLatitude) / latitudeRadius
  const wrappedLongitudeDistance = longitudeDistance(longitude, centerLongitude) / longitudeRadius
  return Math.exp(-(latitudeDistance * latitudeDistance + wrappedLongitudeDistance * wrappedLongitudeDistance) * 1.35)
}

const samplePressureField = (latitude: number, longitude: number, hourOffset: number) => {
  const phase = hourOffset / 24
  const lowEastAsia = pressureSystem(latitude, longitude, 35 + Math.sin(phase * 1.3) * 4, 122 + phase * 9, 18, 24)
  const highCentralAsia = pressureSystem(latitude, longitude, 43 + Math.cos(phase * .8) * 3, 82 + phase * 5, 22, 31)
  const lowNorthPacific = pressureSystem(latitude, longitude, 28 + Math.cos(phase * 1.1) * 5, 164 + phase * 7, 24, 35)
  const highIndianOcean = pressureSystem(latitude, longitude, 4 + Math.sin(phase) * 5, 92 + phase * 4, 27, 40)
  const planetaryWave = Math.sin((longitude - hourOffset * 1.4) * Math.PI / 58 + latitude * Math.PI / 95) * 3.2
    + Math.cos((latitude + hourOffset * .55) * Math.PI / 31 - longitude * Math.PI / 145) * 2.1
  const latitudeBand = Math.cos((Math.abs(latitude) - 32) * Math.PI / 52) * 1.8
  return clamp(1012 + highCentralAsia * 17 + highIndianOcean * 9 - lowEastAsia * 21 - lowNorthPacific * 15 + planetaryWave + latitudeBand, 960, 1040)
}

const hashNoise = (latitude: number, longitude: number, hourOffset: number, seed: number) => {
  const waveA = Math.sin((longitude + seed * 13.7 + hourOffset * 1.8) * Math.PI / 24)
  const waveB = Math.cos((latitude - seed * 7.3 - hourOffset * 1.25) * Math.PI / 18)
  const waveC = Math.sin((latitude + longitude * 0.72 + seed * 19 + hourOffset * 2.6) * Math.PI / 31)
  return (waveA * 0.46 + waveB * 0.34 + waveC * 0.2 + 1) / 2
}

/**
 * Generates a continuous visual field for the interactive map. Point clicks are
 * replaced with live forecast values whenever the public forecast endpoints respond.
 */
export function sampleWeatherMapField(layerId: WeatherMapLayerId, latitude: number, longitude: number, hourOffset: number) {
  if (layerId === 'pressure') return samplePressureField(latitude, longitude, hourOffset)
  const layer = WEATHER_MAP_LAYER_BY_ID[layerId]
  const noise = hashNoise(latitude, longitude, hourOffset, WEATHER_MAP_LAYER_SEED[layerId])
  const latitudeFactor = Math.abs(latitude) / 90
  const localHour = ((WEATHER_MAP_BASE_UTC_HOUR + longitude / 15 + hourOffset) % 24 + 24) % 24
  const daylight = Math.max(0, Math.sin(((localHour - 6) / 12) * Math.PI))
  let normalized = noise

  switch (layerId) {
    case 'temperature': normalized = clamp(0.78 - latitudeFactor * 0.78 + (daylight - 0.5) * 0.18 + (noise - 0.5) * 0.32, 0, 1); break
    case 'humidity': normalized = clamp(0.36 + noise * 0.48 + latitudeFactor * 0.08 - daylight * 0.12, 0, 1); break
    case 'cloud': normalized = clamp(noise * 0.82 + Math.sin(hourOffset / 7) * 0.12, 0, 1); break
    case 'cape': normalized = clamp((1 - latitudeFactor) * daylight * 0.76 + noise * 0.28, 0, 1); break
    case 'wave': normalized = clamp(0.08 + noise * 0.56 + latitudeFactor * 0.22, 0, 1); break
    case 'aurora': normalized = clamp((latitudeFactor - 0.48) * 2.1 + noise * 0.18, 0, 1); break
    case 'snow': normalized = clamp((latitudeFactor - 0.42) * 1.55 + (1 - daylight) * 0.08 + noise * 0.14, 0, 1); break
    case 'dewPoint': normalized = clamp(0.68 - latitudeFactor * 0.6 + noise * 0.25, 0, 1); break
    case 'radar': normalized = clamp(Math.pow(noise, 3.1), 0, 1); break
    case 'pm25': normalized = clamp(0.12 + noise * 0.58 + Math.max(0, 0.35 - latitudeFactor) * 0.18, 0, 1); break
    case 'fire': normalized = clamp(daylight * 0.42 + (1 - latitudeFactor) * 0.18 + noise * 0.46, 0, 1); break
    case 'solar': normalized = clamp(daylight * (0.78 + noise * 0.22), 0, 1); break
    case 'wind': normalized = clamp(0.14 + noise * 0.63 + latitudeFactor * 0.16, 0, 1); break
  }

  return layer.min + (layer.max - layer.min) * normalized
}

export interface WeatherMapWindVector {
  speed: number
  /** Eastward component in km/h. */
  u: number
  /** Northward component in km/h. */
  v: number
  /** Meteorological direction in degrees (where the wind comes from). */
  direction: number
}

/**
 * Produces a smooth, deterministic wind vector for the visual particle layer.
 * The direction follows the local pressure gradient, so streamlines bend around
 * pressure systems instead of moving as a flat CSS texture.
 */
export function sampleWeatherMapWindVector(latitude: number, longitude: number, hourOffset: number): WeatherMapWindVector {
  const delta = 0.42
  const eastGradient = sampleWeatherMapField('pressure', latitude, longitude + delta, hourOffset)
    - sampleWeatherMapField('pressure', latitude, longitude - delta, hourOffset)
  const northGradient = sampleWeatherMapField('pressure', latitude + delta, longitude, hourOffset)
    - sampleWeatherMapField('pressure', latitude - delta, longitude, hourOffset)
  const hemisphere = latitude >= 0 ? 1 : -1
  const prevailing = Math.cos(latitude * Math.PI / 180) * 0.34
  let directionEast = -northGradient * hemisphere + prevailing
  let directionNorth = eastGradient * hemisphere + Math.sin((longitude + hourOffset * 1.2) * Math.PI / 70) * 0.18
  const magnitude = Math.hypot(directionEast, directionNorth) || 1
  directionEast /= magnitude
  directionNorth /= magnitude
  const speed = sampleWeatherMapField('wind', latitude, longitude, hourOffset)
  const direction = (Math.atan2(-directionEast, -directionNorth) * 180 / Math.PI + 360) % 360
  return { speed, u: directionEast * speed, v: directionNorth * speed, direction }
}

const hexToRgb = (hex: string) => {
  const normalized = hex.replace('#', '')
  const value = Number.parseInt(normalized.length === 3
    ? normalized.split('').map(character => character + character).join('')
    : normalized, 16)
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 }
}

export function getWeatherMapColor(layerId: WeatherMapLayerId, value: number, alpha = 1) {
  const stops = WEATHER_MAP_LAYER_BY_ID[layerId].colors
  const first = stops[0]
  const last = stops[stops.length - 1]
  if (value <= first.value) {
    const rgb = hexToRgb(first.color)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }
  if (value >= last.value) {
    const rgb = hexToRgb(last.color)
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`
  }
  const upperIndex = stops.findIndex(stop => stop.value >= value)
  const lower = stops[Math.max(0, upperIndex - 1)]
  const upper = stops[upperIndex]
  const ratio = (value - lower.value) / Math.max(0.0001, upper.value - lower.value)
  const from = hexToRgb(lower.color)
  const to = hexToRgb(upper.color)
  const r = Math.round(from.r + (to.r - from.r) * ratio)
  const g = Math.round(from.g + (to.g - from.g) * ratio)
  const b = Math.round(from.b + (to.b - from.b) * ratio)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface ForecastPayload {
  hourly?: Record<string, Array<number | string>> & { time?: string[] }
}

interface PointForecastBundle {
  data: ForecastPayload
  fetchedAt: number
}

const pointForecastCache = new Map<string, PointForecastBundle>()
const pointRequestCache = new Map<string, Promise<PointForecastBundle>>()
const POINT_CACHE_AGE = 10 * 60 * 1000

const pointKey = (latitude: number, longitude: number) => `${latitude.toFixed(2)}:${longitude.toFixed(2)}`

const getForecastBundle = async (latitude: number, longitude: number, signal?: AbortSignal) => {
  const key = pointKey(latitude, longitude)
  const cached = pointForecastCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < POINT_CACHE_AGE) return cached
  const pending = pointRequestCache.get(key)
  if (pending) return pending

  const url = new URL('https://api.open-meteo.com/v1/forecast')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', [
    'temperature_2m', 'relative_humidity_2m', 'cloud_cover', 'surface_pressure', 'cape',
    'snow_depth', 'dew_point_2m', 'shortwave_radiation', 'wind_speed_10m',
    'wind_direction_10m', 'wind_gusts_10m', 'precipitation',
  ].join(','))
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')

  const request = fetch(url.toString(), { signal })
    .then(async response => {
      if (!response.ok) throw new Error('天气地图数据暂时不可用')
      return { data: await response.json() as ForecastPayload, fetchedAt: Date.now() }
    })
    .then(bundle => {
      pointForecastCache.set(key, bundle)
      return bundle
    })
    .finally(() => pointRequestCache.delete(key))
  pointRequestCache.set(key, request)
  return request
}

const findForecastIndex = (times: string[] = [], hourOffset: number) => {
  if (!times.length) return 0
  const target = Date.now() + hourOffset * 60 * 60 * 1000
  let bestIndex = 0
  let bestDifference = Number.POSITIVE_INFINITY
  times.forEach((time, index) => {
    const difference = Math.abs(new Date(`${time}Z`).getTime() - target)
    if (difference < bestDifference) {
      bestIndex = index
      bestDifference = difference
    }
  })
  return bestIndex
}

const valueAt = (hourly: ForecastPayload['hourly'], key: string, index: number) => {
  const value = Number(hourly?.[key]?.[index])
  return Number.isFinite(value) ? value : null
}

const fetchAirQualityValue = async (latitude: number, longitude: number, hourOffset: number, signal?: AbortSignal) => {
  const url = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', 'pm2_5')
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('空气质量数据暂时不可用')
  const data = await response.json()
  const index = findForecastIndex(data.hourly?.time, hourOffset)
  return Number(data.hourly?.pm2_5?.[index])
}

const fetchWaveValue = async (latitude: number, longitude: number, hourOffset: number, signal?: AbortSignal) => {
  const url = new URL('https://marine-api.open-meteo.com/v1/marine')
  url.searchParams.set('latitude', String(latitude))
  url.searchParams.set('longitude', String(longitude))
  url.searchParams.set('hourly', 'wave_height')
  url.searchParams.set('forecast_days', '3')
  url.searchParams.set('timezone', 'UTC')
  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('海浪数据暂时不可用')
  const data = await response.json()
  const index = findForecastIndex(data.hourly?.time, hourOffset)
  return Number(data.hourly?.wave_height?.[index])
}

export async function fetchWeatherMapPointValue(
  layerId: WeatherMapLayerId,
  latitude: number,
  longitude: number,
  hourOffset: number,
  signal?: AbortSignal,
): Promise<WeatherMapPointValue> {
  const layer = WEATHER_MAP_LAYER_BY_ID[layerId]
  const fallback = sampleWeatherMapField(layerId, latitude, longitude, hourOffset)
  const targetTime = new Date(Date.now() + hourOffset * 60 * 60 * 1000).toISOString()

  try {
    if (layerId === 'pm25') {
      const value = await fetchAirQualityValue(latitude, longitude, hourOffset, signal)
      if (!Number.isFinite(value)) throw new Error('missing air-quality value')
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'air-quality' }
    }
    if (layerId === 'wave') {
      const value = await fetchWaveValue(latitude, longitude, hourOffset, signal)
      if (!Number.isFinite(value)) throw new Error('missing marine value')
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'marine' }
    }

    const bundle = await getForecastBundle(latitude, longitude, signal)
    const hourly = bundle.data.hourly
    const index = findForecastIndex(hourly?.time as string[] | undefined, hourOffset)
    const map: Partial<Record<WeatherMapLayerId, string>> = {
      wind: 'wind_speed_10m', temperature: 'temperature_2m', humidity: 'relative_humidity_2m',
      cloud: 'cloud_cover', pressure: 'surface_pressure', cape: 'cape', snow: 'snow_depth',
      dewPoint: 'dew_point_2m', solar: 'shortwave_radiation',
    }

    if (layerId === 'aurora') {
      return { layer: layerId, value: fallback, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: '依据纬度与当前时段估计' }
    }

    if (layerId === 'radar') {
      const precipitation = valueAt(hourly, 'precipitation', index) ?? 0
      const value = precipitation <= 0 ? 0 : clamp(10 * Math.log10(200 * Math.pow(precipitation, 1.6)), 0, 70)
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: `降水 ${precipitation.toFixed(1)} mm/h` }
    }

    if (layerId === 'fire') {
      const temperature = valueAt(hourly, 'temperature_2m', index) ?? 20
      const humidity = valueAt(hourly, 'relative_humidity_2m', index) ?? 60
      const wind = valueAt(hourly, 'wind_speed_10m', index) ?? 10
      const precipitation = valueAt(hourly, 'precipitation', index) ?? 0
      const value = clamp((temperature - 5) * 1.35 + (100 - humidity) * 0.48 + wind * 0.42 - precipitation * 13, 0, 100)
      return { layer: layerId, value, unit: layer.unit, label: layer.shortLabel, latitude, longitude, hourOffset, time: targetTime, source: 'derived', secondary: '由温度、湿度、风速与降水推算' }
    }

    const key = map[layerId]
    let value = key ? valueAt(hourly, key, index) : null
    if (layerId === 'snow' && value !== null) value *= 100
    if (value === null) throw new Error('missing forecast value')
    const direction = layerId === 'wind' ? valueAt(hourly, 'wind_direction_10m', index) : null
    return {
      layer: layerId, value, unit: layer.unit, label: layer.shortLabel,
      latitude, longitude, hourOffset, time: targetTime, source: 'forecast',
      secondary: direction === null ? undefined : `风向 ${Math.round(direction)}°`,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      layer: layerId, value: fallback, unit: layer.unit, label: layer.shortLabel,
      latitude, longitude, hourOffset, time: targetTime, source: 'estimate',
      secondary: '网络数据不可用，显示本地场景估计',
    }
  }
}

export function formatWeatherMapValue(layer: WeatherMapLayerDefinition, value: number) {
  const decimals = layer.decimals ?? (layer.id === 'wave' || Math.abs(value) < 10 ? 1 : 0)
  return `${value.toFixed(decimals)}${layer.unit === '°C' ? '°C' : ` ${layer.unit}`}`
}

