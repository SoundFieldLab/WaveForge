export interface TyphoonForecastPoint {
  agency: string
  hours: number
  time: string
  longitude: number
  latitude: number
  pressure: number
  windSpeed: number
  type: string
}

export interface TyphoonTrackPoint {
  id: string
  time: string
  timestamp: number
  type: string
  longitude: number
  latitude: number
  pressure: number
  windSpeed: number
  moveDirection: string
  moveSpeed: number
  windRadii: unknown[]
  forecasts: TyphoonForecastPoint[]
}

export interface TyphoonInfo {
  id: string
  internationalName: string
  chineseName: string
  number: string
  meaning: string
  status: string
  active: boolean
  latest: TyphoonTrackPoint | null
  forecast: TyphoonForecastPoint[]
  track: TyphoonTrackPoint[]
}

export interface EarthquakeEvent {
  id: string
  time: string
  latitude: number
  longitude: number
  depth: number
  magnitude: number
  location: string
}

interface HazardCollection<T> {
  source: string
  sourceUrl: string
  updatedAt: number
  stale?: boolean
  items: T[]
}

export interface HazardSnapshot {
  updatedAt: number
  typhoons: HazardCollection<TyphoonInfo> | null
  earthquakes: HazardCollection<EarthquakeEvent> | null
  errors: { typhoons: string; earthquakes: string }
}

export type HazardRiskLevel = 'watch' | 'warning' | 'danger'

export interface TyphoonLocationRisk {
  level: HazardRiskLevel
  distanceKm: number
  typhoon: TyphoonInfo
  closestPoint: TyphoonTrackPoint | TyphoonForecastPoint
  forecast: boolean
  title: string
  message: string
}

export interface EarthquakeLocationRisk {
  level: HazardRiskLevel
  distanceKm: number
  ageHours: number
  event: EarthquakeEvent
  title: string
  message: string
}

const API_BASE = 'http://localhost:3001/api'
const MEMORY_CACHE_TTL = 2 * 60 * 1000
let cachedSnapshot: HazardSnapshot | null = null
let cachedAt = 0
let pendingSnapshot: Promise<HazardSnapshot> | null = null

const normalizeSnapshot = (payload: any): HazardSnapshot => ({
  updatedAt: Number(payload?.updatedAt) || Date.now(),
  typhoons: payload?.typhoons && Array.isArray(payload.typhoons.items)
    ? { ...payload.typhoons, items: payload.typhoons.items }
    : null,
  earthquakes: payload?.earthquakes && Array.isArray(payload.earthquakes.items)
    ? { ...payload.earthquakes, items: payload.earthquakes.items }
    : null,
  errors: {
    typhoons: String(payload?.errors?.typhoons || ''),
    earthquakes: String(payload?.errors?.earthquakes || ''),
  },
})

const waitForSignal = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

export async function ensureHazardSnapshot(options: { forceRefresh?: boolean; signal?: AbortSignal } = {}): Promise<HazardSnapshot> {
  const { forceRefresh = false, signal } = options
  if (!forceRefresh && cachedSnapshot && Date.now() - cachedAt < MEMORY_CACHE_TTL) return cachedSnapshot
  if (!forceRefresh && pendingSnapshot) return waitForSignal(pendingSnapshot, signal)

  const request = (async () => {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 18_000)
    try {
      const response = await fetch(`${API_BASE}/hazards/snapshot${forceRefresh ? '?refresh=1' : ''}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok && !payload?.success) throw new Error(payload?.error || '灾害信息暂时不可用')
      const normalized = normalizeSnapshot(payload)
      cachedSnapshot = normalized
      cachedAt = Date.now()
      return normalized
    } finally {
      window.clearTimeout(timeout)
    }
  })()

  if (!forceRefresh) pendingSnapshot = request
  try {
    return await waitForSignal(request, signal)
  } finally {
    if (pendingSnapshot === request) pendingSnapshot = null
  }
}

export function getCachedHazardSnapshot(): HazardSnapshot | null {
  return cachedSnapshot
}

export function haversineDistanceKm(latitude1: number, longitude1: number, latitude2: number, longitude2: number) {
  const radians = (value: number) => value * Math.PI / 180
  const lat1 = radians(latitude1)
  const lat2 = radians(latitude2)
  const deltaLat = radians(latitude2 - latitude1)
  const wrappedLongitudeDelta = ((longitude2 - longitude1 + 540) % 360) - 180
  const deltaLon = radians(wrappedLongitudeDelta)
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function getTyphoonLocationRisk(snapshot: HazardSnapshot | null, latitude: number, longitude: number): TyphoonLocationRisk | null {
  if (!snapshot?.typhoons || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  let candidate: { distanceKm: number; typhoon: TyphoonInfo; point: TyphoonTrackPoint | TyphoonForecastPoint; forecast: boolean } | null = null

  for (const typhoon of snapshot.typhoons.items) {
    const points: Array<{ point: TyphoonTrackPoint | TyphoonForecastPoint; forecast: boolean }> = []
    if (typhoon.latest) points.push({ point: typhoon.latest, forecast: false })
    for (const point of typhoon.forecast || []) points.push({ point, forecast: true })
    for (const item of points) {
      const distanceKm = haversineDistanceKm(latitude, longitude, item.point.latitude, item.point.longitude)
      if (!candidate || distanceKm < candidate.distanceKm) candidate = { distanceKm, typhoon, point: item.point, forecast: item.forecast }
    }
  }

  if (!candidate || candidate.distanceKm > 900) return null
  const level: HazardRiskLevel = candidate.distanceKm <= 220 ? 'danger' : candidate.distanceKm <= 500 ? 'warning' : 'watch'
  const distance = Math.round(candidate.distanceKm)
  return {
    level,
    distanceKm: candidate.distanceKm,
    typhoon: candidate.typhoon,
    closestPoint: candidate.point,
    forecast: candidate.forecast,
    title: level === 'danger' ? '台风正在接近当前位置' : level === 'warning' ? '当前位置进入台风关注范围' : '附近海域有活跃台风',
    message: `${candidate.typhoon.number ? `${candidate.typhoon.number}号` : ''}${candidate.typhoon.chineseName}距当前位置约 ${distance} km${candidate.forecast ? '（中央气象台预报路径）' : ''}`,
  }
}

const parseChinaTime = (value: string) => {
  const normalized = String(value || '').trim().replace(' ', 'T')
  const timestamp = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? normalized : `${normalized}+08:00`)
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function getEarthquakeLocationRisk(snapshot: HazardSnapshot | null, latitude: number, longitude: number): EarthquakeLocationRisk | null {
  if (!snapshot?.earthquakes || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  const now = Date.now()
  const candidates = snapshot.earthquakes.items.map(event => {
    const ageHours = Math.max(0, (now - parseChinaTime(event.time)) / 3_600_000)
    const distanceKm = haversineDistanceKm(latitude, longitude, event.latitude, event.longitude)
    return { event, ageHours, distanceKm }
  }).filter(item => item.ageHours <= 48 && (
    (item.event.magnitude >= 3 && item.distanceKm <= 120)
    || (item.event.magnitude >= 4 && item.distanceKm <= 400)
    || (item.event.magnitude >= 5 && item.distanceKm <= 800)
  )).sort((a, b) => (b.event.magnitude / Math.max(60, b.distanceKm)) - (a.event.magnitude / Math.max(60, a.distanceKm)))

  const candidate = candidates[0]
  if (!candidate) return null
  const level: HazardRiskLevel = candidate.distanceKm <= 120 || candidate.event.magnitude >= 6
    ? 'danger'
    : candidate.distanceKm <= 350 || candidate.event.magnitude >= 5
      ? 'warning'
      : 'watch'
  return {
    level,
    distanceKm: candidate.distanceKm,
    ageHours: candidate.ageHours,
    event: candidate.event,
    title: level === 'danger' ? '当前位置附近发生地震' : '当前位置收到地震监测提醒',
    message: `${candidate.event.location}发生 M${candidate.event.magnitude.toFixed(1)} 地震，距当前位置约 ${Math.round(candidate.distanceKm)} km`,
  }
}

export function getNearbyEarthquakes(snapshot: HazardSnapshot | null, latitude: number, longitude: number, limit = 24) {
  if (!snapshot?.earthquakes) return []
  return snapshot.earthquakes.items.map(event => ({
    event,
    distanceKm: haversineDistanceKm(latitude, longitude, event.latitude, event.longitude),
    timestamp: parseChinaTime(event.time),
  })).filter(item => item.distanceKm <= 1800 || item.event.magnitude >= 6)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}