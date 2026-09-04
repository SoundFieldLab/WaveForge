export interface HazardWeatherLayerBounds {
  minLongitude: number
  maxLongitude: number
  minLatitude: number
  maxLatitude: number
}

export interface HazardWeatherLayerOptions {
  cloudHours: 0.5 | 1 | 3 | 6
  precipitationHours: 24 | 48 | 72
}

export interface HazardWeatherLayerSample {
  longitude: number
  latitude: number
  precipitation: number
  cloudCover: number
  windSpeed: number
  windDirection: number
}

export interface HazardWeatherLayerGrid {
  updatedAt: number
  cloudHours: HazardWeatherLayerOptions['cloudHours']
  precipitationHours: HazardWeatherLayerOptions['precipitationHours']
  samples: HazardWeatherLayerSample[]
}

const CACHE_TTL = 5 * 60 * 1000
const layerCache = new Map<string, HazardWeatherLayerGrid>()

const roundedKey = (bounds: HazardWeatherLayerBounds, options: HazardWeatherLayerOptions) => [
  bounds.minLongitude,
  bounds.maxLongitude,
  bounds.minLatitude,
  bounds.maxLatitude,
].map(value => Math.round(value * 2) / 2).join(':') + `:${options.cloudHours}:${options.precipitationHours}`

const safeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const interpolatedCloudCover = (values: unknown[], targetHours: number) => {
  if (values.length === 0) return 0
  const lowerIndex = Math.max(0, Math.floor(targetHours))
  const upperIndex = Math.min(values.length - 1, Math.ceil(targetHours))
  const lower = safeNumber(values[lowerIndex])
  const upper = safeNumber(values[upperIndex], lower)
  const ratio = targetHours - lowerIndex
  return Math.max(0, Math.min(100, lower + (upper - lower) * ratio))
}

export async function fetchHazardWeatherLayer(
  bounds: HazardWeatherLayerBounds,
  options: HazardWeatherLayerOptions,
  signal?: AbortSignal,
): Promise<HazardWeatherLayerGrid> {
  const key = roundedKey(bounds, options)
  const cached = layerCache.get(key)
  if (cached && Date.now() - cached.updatedAt < CACHE_TTL) return cached

  // 54 个格点比原来的 35 个更细腻，同时仍能把请求 URL 控制在稳定范围内。
  const columns = 9
  const rows = 6
  const coordinates = Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    return {
      longitude: bounds.minLongitude + (column / (columns - 1)) * (bounds.maxLongitude - bounds.minLongitude),
      latitude: bounds.maxLatitude - (row / (rows - 1)) * (bounds.maxLatitude - bounds.minLatitude),
    }
  })
  const params = new URLSearchParams({
    latitude: coordinates.map(item => item.latitude.toFixed(3)).join(','),
    longitude: coordinates.map(item => item.longitude.toFixed(3)).join(','),
    current: 'wind_speed_10m,wind_direction_10m',
    hourly: 'precipitation,cloud_cover',
    forecast_days: '4',
    wind_speed_unit: 'ms',
    timezone: 'UTC',
  })
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`气象图层服务返回 HTTP ${response.status}`)
  const payload = await response.json()
  const rowsPayload = Array.isArray(payload) ? payload : [payload]
  const samples = rowsPayload.map((item: any, index: number) => {
    const hourlyPrecipitation = Array.isArray(item?.hourly?.precipitation) ? item.hourly.precipitation : []
    const hourlyCloudCover = Array.isArray(item?.hourly?.cloud_cover) ? item.hourly.cloud_cover : []
    const precipitation = hourlyPrecipitation
      .slice(0, options.precipitationHours)
      .reduce((sum: number, value: unknown) => sum + Math.max(0, safeNumber(value)), 0)
    return {
      longitude: safeNumber(item?.longitude, coordinates[index]?.longitude),
      latitude: safeNumber(item?.latitude, coordinates[index]?.latitude),
      precipitation,
      cloudCover: interpolatedCloudCover(hourlyCloudCover, options.cloudHours),
      windSpeed: Math.max(0, safeNumber(item?.current?.wind_speed_10m)),
      windDirection: safeNumber(item?.current?.wind_direction_10m),
    }
  }).filter((item: HazardWeatherLayerSample) => Number.isFinite(item.longitude) && Number.isFinite(item.latitude))

  const result: HazardWeatherLayerGrid = {
    updatedAt: Date.now(),
    cloudHours: options.cloudHours,
    precipitationHours: options.precipitationHours,
    samples,
  }
  layerCache.set(key, result)
  return result
}
