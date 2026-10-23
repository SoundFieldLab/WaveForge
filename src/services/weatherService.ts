import type { DesktopCustomizationSettings } from './desktopCustomization'
import { getApiBase } from './apiConfig'

export interface WeatherLocation {
  name: string
  province: string
  city: string
  district: string
  region: string
  country: string
  street?: string
  township?: string
  neighbourhood?: string
  formattedAddress?: string
  latitude: number
  longitude: number
  source: 'ip' | 'manual'
}

export interface WeatherLocationSearchResult {
  id: string
  label: string
  name: string
  countryCode: string
  country: string
  provinceCode: string
  province: string
  cityCode: string
  city: string
  districtCode: string
  district: string
  latitude: number | null
  longitude: number | null
}

export interface WeatherAlert {
  id: string
  level: 'moderate' | 'severe' | 'extreme'
  title: string
  message: string
}

export interface WeatherAirQuality {
  /** 欧洲 AQI（0-100+，越高越差） */
  aqi: number
  pm25: number
  pm10: number
  /** 美国环保署 AQI（可选） */
  usAqi?: number
  /** 其他污染物（μg/m³，可选） */
  ozone?: number
  nitrogenDioxide?: number
  sulphurDioxide?: number
  carbonMonoxide?: number
  /** 逐小时 AQI（用于趋势图） */
  hourlyAqi: Array<{ time: string; aqi: number }>
}

export const getAqiDescriptor = (aqi: number) => {
  if (!Number.isFinite(aqi)) return { label: '暂无数据', color: '#94a3b8' }
  if (aqi < 20) return { label: '优', color: '#22c55e' }
  if (aqi < 40) return { label: '良', color: '#eab308' }
  if (aqi < 60) return { label: '中等', color: '#f97316' }
  if (aqi < 80) return { label: '较差', color: '#ef4444' }
  if (aqi <= 100) return { label: '很差', color: '#a855f7' }
  return { label: '极差', color: '#881337' }
}
export const getAqiLabel = (aqi: number) => getAqiDescriptor(aqi).label
export const getCloudCoverLabel = (value: number) => value < 10 ? '晴朗无云' : value < 35 ? '少云' : value < 70 ? '多云' : '阴天'
export const getDewPointLabel = (value: number) => value < 10 ? '空气干燥' : value < 16 ? '体感舒适' : value < 21 ? '略感潮湿' : '潮湿闷热'

export interface WeatherCurrent {
  time: string
  temperature: number
  apparentTemperature: number
  humidity: number
  weatherCode: number
  isDay: boolean
  windSpeed: number
  windDirection: number
  windGusts: number
  pressure: number
  visibility: number
  precipitation: number
  cloudCover: number
}

export interface WeatherHour {
  time: string
  temperature: number
  apparentTemperature: number
  precipitationProbability: number
  precipitation: number
  snowfall: number
  weatherCode: number
  windSpeed: number
  windGusts: number
  /** 逐时风向（度，0=北风，气象惯例：风来的方向） */
  windDirection: number
  visibility: number
  uvIndex: number
  humidity: number
  pressure: number
  dewPoint: number
  cloudCover: number
  /** 地面积雪深度（米） */
  snowDepth: number
  /** 0°C 冻结层海拔（米） */
  freezingLevel: number
  /** 对流有效位能 CAPE（J/kg） */
  cape: number
  /** 短波辐射（W/m²，该小时平均） */
  shortwaveRadiation: number
  /** 分层云量：低云(≤3km)/中云(3-8km)/高云(>8km)，% */
  cloudCoverLow: number
  cloudCoverMid: number
  cloudCoverHigh: number
  /** 80 米高空风速（km/h，风机/高层参考） */
  windSpeed80m: number
  /** 晴空（无云）假设下的 UV 指数 */
  uvIndexClearSky: number
}

export interface WeatherDay {
  date: string
  weatherCode: number
  temperatureMax: number
  temperatureMin: number
  apparentTemperatureMax: number
  apparentTemperatureMin: number
  precipitationProbability: number
  precipitationSum: number
  /** 降雨/阵雨/降雪分项（毫米/厘米） */
  rainSum: number
  showersSum: number
  snowfallSum: number
  /** 有降水的小时数 */
  precipitationHours: number
  windSpeedMax: number
  windGustsMax: number
  /** 当日主导风向（度） */
  windDirectionDominant: number
  uvIndexMax: number
  /** 晴空（无云）条件下的 UV 峰值 */
  uvIndexClearSkyMax: number
  /** 日最大饱和水汽压差 VPD（kPa，干燥度指标） */
  vapourPressureDeficitMax?: number
  sunrise: string
  sunset: string
  /** 当日总日照时长（秒，Open-Meteo daylight_duration）；
   *  sunshine_duration 是直达日照（无云遮挡），晨昏蒙影等衍生值由 UI 侧从日出/日落推算 */
  daylightDuration?: number
  sunshineDuration?: number
  /** 太阳总辐射（MJ/m²，Apple「日照」卡的数值源） */
  shortwaveRadiationSum?: number
  /** 参考作物蒸散 ET₀（毫米） */
  et0Evapotranspiration?: number
  /** 月出/月落（ISO 字符串，可能为空——极昼极夜或月不出） */
  moonrise?: string
  moonset?: string
  /** 月相 0-1（0 新月 0.5 满月） */
  moonPhase?: number
}

export interface WeatherSnapshot {
  location: WeatherLocation
  timezone: string
  current: WeatherCurrent
  hourly: WeatherHour[]
  daily: WeatherDay[]
  alerts: WeatherAlert[]
  airQuality: WeatherAirQuality | null
  updatedAt: number
}

const WEATHER_CACHE_PREFIX = 'desktopWeatherSnapshot:'
const weatherSnapshotPending = new Map<string, Promise<WeatherSnapshot>>()
const WEATHER_CACHE_MAX_AGE = 10 * 60 * 1000
const LOCATION_SEARCH_CACHE_MAX_AGE = 5 * 60 * 1000
const locationSearchCache = new Map<string, { expiresAt: number; results: WeatherLocationSearchResult[] }>()
const LOCATION_SEARCH_CACHE_MAX_ENTRIES = 50

// 缓存原先无上限：每个新地名的搜索都会留下一条常驻条目（会话内单调增长）。
// 写入时顺带清掉过期项，再按 Map 插入序淘汰最旧的，控制内存占用。
function pruneLocationSearchCache(): void {
  const now = Date.now()
  for (const [key, entry] of locationSearchCache) {
    if (entry.expiresAt <= now) locationSearchCache.delete(key)
  }
  while (locationSearchCache.size > LOCATION_SEARCH_CACHE_MAX_ENTRIES) {
    const oldestKey = locationSearchCache.keys().next().value
    if (typeof oldestKey !== 'string') break
    locationSearchCache.delete(oldestKey)
  }
}
const locationSearchPending = new Map<string, Promise<WeatherLocationSearchResult[]>>()

export const WEATHER_LABELS: Record<number, string> = {
  0: '晴朗',
  1: '大致晴朗',
  2: '局部多云',
  3: '阴天',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '强毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '米雪',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '强雷暴伴冰雹',
}

export const getWeatherLabel = (code: number) => WEATHER_LABELS[code] || '天气变化'

export const getWeatherCacheKey = (settings: DesktopCustomizationSettings) =>
  // v4：新增分层云量/80m风/晴空UV/VPD 字段
  `${WEATHER_CACHE_PREFIX}v4:${settings.weatherLocationMode}:${settings.weatherLocationMode === 'manual'
    ? [settings.weatherCountryCode, settings.weatherProvinceCode, settings.weatherCityCode, settings.weatherDistrictCode || settings.weatherDistrict, settings.weatherLatitude, settings.weatherLongitude]
      .filter(value => value !== null && value !== undefined && value !== '')
      .join(':')
      .toLowerCase()
    : 'current-auto-v4'}`

const normalizePlaceName = (value: unknown) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[省市区县旗州盟特别行政区]$/g, '')

const isValidCoordinate = (latitude: number, longitude: number) =>
  Number.isFinite(latitude) && Number.isFinite(longitude)

const firstText = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value || '').trim()
    if (text) return text
  }
  return ''
}

const ADMINISTRATIVE_SUFFIX_ONLY = /^(?:省|市|区|县|旗|盟|州|特别行政区)$/

export const normalizeAdministrativeName = (value: unknown) => {
  const text = String(value || '').trim()
  if (!text || ADMINISTRATIVE_SUFFIX_ONLY.test(text)) return ''
  return text.replace(/^(?:省|市|区|县)(?=[^省市区县旗盟州])/u, '')
}

const normalizeLocationParts = <T extends Partial<WeatherLocation>>(location: T): T => {
  const province = normalizeAdministrativeName(location.province)
  const city = normalizeAdministrativeName(location.city)
  const district = normalizeAdministrativeName(location.district)
  const name = normalizeAdministrativeName(location.name)
  const hasInvalidAdministrativePart = [location.province, location.city, location.district]
    .some(value => ADMINISTRATIVE_SUFFIX_ONLY.test(String(value || '').trim()))
  return {
    ...location,
    name: name || district || city || province,
    province,
    city: normalizePlaceName(city) === normalizePlaceName(province) ? '' : city,
    district: normalizePlaceName(district) === normalizePlaceName(city) ? '' : district,
    formattedAddress: hasInvalidAdministrativePart ? '' : normalizeAdministrativeName(location.formattedAddress),
  }
}

const makeRegionLabel = (...values: unknown[]) => Array.from(new Set(values
  .map(value => String(value || '').trim())
  .filter(Boolean)
)).join(' · ')

const uniqueLocationParts = (...values: unknown[]) => Array.from(new Set(values
  .map(value => String(value || '').trim())
  .filter(Boolean)
))

const makeLocationSearchLabel = (country: string, province: string, city: string, district: string, name: string) =>
  uniqueLocationParts(country, province, city, district || name).join(' · ')

const waitForSearch = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value) },
      error => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

const searchRemoteWeatherLocations = async (keyword: string): Promise<WeatherLocationSearchResult[]> => {
  const openMeteoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
  openMeteoUrl.searchParams.set('name', keyword)
  openMeteoUrl.searchParams.set('count', '12')
  openMeteoUrl.searchParams.set('language', 'zh')
  openMeteoUrl.searchParams.set('format', 'json')
  try {
    const response = await fetch(openMeteoUrl.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    if (response.ok) {
      const data = await response.json()
      const results: WeatherLocationSearchResult[] = []
      for (const item of Array.isArray(data.results) ? data.results : []) {
        const latitude = Number(item.latitude)
        const longitude = Number(item.longitude)
        if (!isValidCoordinate(latitude, longitude)) continue
        const name = normalizeAdministrativeName(item.name)
        const country = firstText(item.country)
        const countryCode = firstText(item.country_code).toUpperCase()
        const province = normalizeAdministrativeName(item.admin1)
        const city = normalizeAdministrativeName(firstText(item.admin2, item.admin3))
        const district = normalizePlaceName(name) !== normalizePlaceName(city)
          && normalizePlaceName(name) !== normalizePlaceName(province) ? name : normalizeAdministrativeName(firstText(item.admin3, item.admin4))
        results.push({
          id: `open-meteo:${latitude}:${longitude}`,
          label: makeLocationSearchLabel(country, province, city, district, name),
          name, countryCode, country, provinceCode: '', province, cityCode: '', city,
          districtCode: '', district, latitude, longitude,
        })
      }
      if (results.length > 0) return results
    }
  } catch { /* 继续使用备用地理编码服务 */ }

  const nominatimUrl = new URL('https://nominatim.openstreetmap.org/search')
  nominatimUrl.searchParams.set('format', 'jsonv2')
  nominatimUrl.searchParams.set('q', keyword)
  nominatimUrl.searchParams.set('limit', '10')
  nominatimUrl.searchParams.set('addressdetails', '1')
  nominatimUrl.searchParams.set('accept-language', 'zh-CN')
  const response = await fetch(nominatimUrl.toString(), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
  if (!response.ok) return []
  const data = await response.json()
  const results: WeatherLocationSearchResult[] = []
  for (const item of Array.isArray(data) ? data : []) {
    const latitude = Number(item.lat)
    const longitude = Number(item.lon)
    if (!isValidCoordinate(latitude, longitude)) continue
    const address = item.address || {}
    const name = normalizeAdministrativeName(firstText(item.name, address.county, address.city, address.town, keyword))
    const country = firstText(address.country)
    const countryCode = firstText(address.country_code).toUpperCase()
    const province = normalizeAdministrativeName(firstText(address.province, address.state, address.region))
    const city = normalizeAdministrativeName(firstText(address.city, address.municipality, address.prefecture, address.town))
    let district = normalizeAdministrativeName(firstText(address.city_district, address.county, address.borough))
    if (!district && normalizePlaceName(name) !== normalizePlaceName(city) && normalizePlaceName(name) !== normalizePlaceName(province)) district = name
    results.push({
      id: `nominatim:${item.place_id || ''}:${latitude}:${longitude}`,
      label: makeLocationSearchLabel(country, province, city, district, name),
      name, countryCode, country, provinceCode: '', province, cityCode: '', city,
      districtCode: '', district, latitude, longitude,
    })
  }
  return results
}

// locationHierarchy 静态引入会把 country-state-city 的 country/state 字典
// （约 555KB JSON）和 china-area-data（约 203KB）拖进首屏 chunk。这里改为按需加载：
// 整条引用链是 weatherService ← backgroundPrefetch ← App，只在登录恢复后的后台预热里
// 触发，首屏并不需要它。缓存 Promise，失败时置空以便下次重试。
let chinaAreaSearchModule: Promise<typeof import('./locationHierarchy')> | null = null
const loadChinaAreaSearch = () => {
  if (!chinaAreaSearchModule) {
    chinaAreaSearchModule = import('./locationHierarchy').catch(() => {
      chinaAreaSearchModule = null
      return null as unknown as typeof import('./locationHierarchy')
    })
  }
  return chinaAreaSearchModule
}

export const searchWeatherLocations = async (
  query: string,
  signal?: AbortSignal,
): Promise<WeatherLocationSearchResult[]> => {
  const keyword = query.trim()
  if (keyword.length < 2) return []

  // 本地中国行政区匹配（数据懒加载）；加载失败则直接走远端地理编码。
  const hierarchy = await loadChinaAreaSearch()
  const localResults: WeatherLocationSearchResult[] = (hierarchy?.searchChinaAreas(keyword) ?? []).map(area => ({
    id: `china:${area.districtCode || area.cityCode || area.provinceCode}`,
    label: makeLocationSearchLabel('中国', area.province, area.city, area.district, area.district || area.city || area.province),
    name: area.district || area.city || area.province,
    countryCode: 'CN',
    country: '中国',
    provinceCode: area.provinceCode,
    province: area.province,
    cityCode: area.cityCode,
    city: area.city,
    districtCode: area.districtCode,
    district: area.district,
    latitude: null,
    longitude: null,
  }))
  if (localResults.length > 0) return localResults

  const cacheKey = keyword.toLocaleLowerCase('zh-CN').replace(/\s+/g, '')
  const cached = locationSearchCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.results
  let request = locationSearchPending.get(cacheKey)
  if (!request) {
    request = searchRemoteWeatherLocations(keyword).finally(() => locationSearchPending.delete(cacheKey))
    locationSearchPending.set(cacheKey, request)
  }
  const results = await waitForSearch(request, signal)
  const seen = new Set<string>()
  const uniqueResults = results.filter(result => {
    const key = `${result.label}:${result.latitude?.toFixed(3) || ''}:${result.longitude?.toFixed(3) || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
  locationSearchCache.set(cacheKey, { expiresAt: Date.now() + LOCATION_SEARCH_CACHE_MAX_AGE, results: uniqueResults })
  pruneLocationSearchCache()
  return uniqueResults
}

export const resolveWeatherLocationSearchResult = async (
  result: WeatherLocationSearchResult,
  signal?: AbortSignal,
): Promise<WeatherLocationSearchResult> => {
  if (result.latitude !== null && result.longitude !== null) return result
  const areaCode = result.districtCode || result.cityCode || result.provinceCode
  if (!areaCode) throw new Error('所选地区缺少可用坐标')
  const response = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${encodeURIComponent(areaCode)}.json`, { signal })
  if (!response.ok) throw new Error('暂时无法获取所选地区坐标')
  const data = await response.json()
  const center = Array.isArray(data.features) ? data.features[0]?.properties?.center : null
  const longitude = Number(center?.[0])
  const latitude = Number(center?.[1])
  if (!isValidCoordinate(latitude, longitude)) throw new Error('所选地区没有返回有效坐标')
  return { ...result, latitude, longitude }
}

export const getWeatherLocationName = (
  location: Partial<WeatherLocation>,
) => {
  const normalized = normalizeLocationParts(location)
  return firstText(
    normalized.street,
    normalized.township,
    normalized.neighbourhood,
    normalized.district,
    normalized.city,
    normalized.name,
    normalized.province,
    normalized.region,
    normalized.country,
    '当前位置',
  )
}

export const getWeatherLocationAddress = (
  location: Partial<WeatherLocation>,
) => {
  const normalized = normalizeLocationParts(location)
  return firstText(
    normalized.formattedAddress,
    uniqueLocationParts(normalized.province, normalized.city, normalized.district, normalized.township, normalized.street, normalized.neighbourhood).join(''),
    uniqueLocationParts(normalized.region, normalized.district, normalized.township, normalized.street).join(''),
    normalized.name,
    '当前位置',
  )
}

export const getWeatherLocationCompactName = (
  location: Partial<WeatherLocation>,
) => {
  const normalized = normalizeLocationParts(location)
  const formattedAddress = String(normalized.formattedAddress || '').trim()
  if (formattedAddress) {
    const administrativeParts = uniqueLocationParts(
      normalized.country,
      normalized.province,
      normalized.city,
      normalized.district,
      normalized.township,
    ).sort((left, right) => right.length - left.length)
    let compact = formattedAddress
    let changed = true
    while (changed) {
      changed = false
      for (const part of administrativeParts) {
        if (part && compact.startsWith(part)) {
          compact = compact.slice(part.length).trim()
          changed = true
        }
      }
    }
    compact = normalizeAdministrativeName(compact
      .replace(/^[，,、；;：:\s-]+/, '')
      .replace(/^(?:[^省市区县旗盟州]{1,20}(?:街道|镇|乡))/, '')
      .replace(/^[，,、；;：:\s-]+/, '')
      .trim())
    if (compact && compact !== formattedAddress) return compact
  }
  return firstText(
    normalized.neighbourhood,
    normalized.street,
    normalized.name,
    normalized.township,
    normalized.district,
    normalized.city,
    '当前位置',
  )
}

const normalizeReverseLocation = (
  data: Record<string, any>,
  latitude: number,
  longitude: number,
  fallback: Partial<WeatherLocation> = {},
): WeatherLocation => {
  const address = data.address || data.result?.address || data.result?.addressComponent || {}
  const province = firstText(data.province, address.province, address.state, address.region, fallback.province)
  const city = firstText(data.city, address.city, address.municipality, address.prefecture, address.town, fallback.city)
  const district = firstText(data.district, address.city_district, address.district, address.county, address.borough, fallback.district)
  const township = firstText(data.township, address.township, address.suburb, address.village, address.town, fallback.township)
  const neighbourhood = firstText(data.neighbourhood, address.neighbourhood, address.neighborhood, address.quarter, fallback.neighbourhood)
  const street = firstText(data.street, address.road, address.pedestrian, address.residential, address.footway, address.path, fallback.street)
  const country = firstText(data.country, address.country, fallback.country)
  const base = {
    ...fallback,
    name: firstText(fallback.name),
    region: firstText(fallback.region),
    province,
    city,
    district,
    township,
    neighbourhood,
    street,
    country,
    latitude,
    longitude,
    source: fallback.source || 'ip' as const,
  }
  const formattedAddress = firstText(data.formattedAddress, getWeatherLocationAddress(base))
  return {
    ...base,
    name: getWeatherLocationName({ ...base, name: firstText(data.name, fallback.name) }),
    region: makeRegionLabel(province, city, district),
    formattedAddress,
  }
}

const requestReverseLocation = async (url: string, signal?: AbortSignal) => {
  const response = await fetch(url, {
    signal,
    headers: { Accept: 'application/json', 'Accept-Language': 'zh-CN,zh;q=0.9' },
  })
  if (!response.ok) throw new Error(`反向定位服务 HTTP ${response.status}`)
  return response.json() as Promise<Record<string, any>>
}

export const resolveCoordinatesLocation = async (
  latitude: number,
  longitude: number,
  signal?: AbortSignal,
): Promise<WeatherLocation> => {
  const query = `latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`
  try {
    const data = await requestReverseLocation(`${getApiBase()}/location/reverse?${query}`, signal)
    if (data.success !== false) return normalizeReverseLocation(data, latitude, longitude)
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
  }

  try {
    const reverseUrl = new URL('https://nominatim.openstreetmap.org/reverse')
    reverseUrl.searchParams.set('format', 'jsonv2')
    reverseUrl.searchParams.set('lat', String(latitude))
    reverseUrl.searchParams.set('lon', String(longitude))
    reverseUrl.searchParams.set('zoom', '18')
    reverseUrl.searchParams.set('addressdetails', '1')
    reverseUrl.searchParams.set('accept-language', 'zh-CN')
    const data = await requestReverseLocation(reverseUrl.toString(), signal)
    return normalizeReverseLocation(data, latitude, longitude)
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return normalizeReverseLocation({}, latitude, longitude)
  }
}

export const getCachedWeather = (settings: DesktopCustomizationSettings, allowStale = false): WeatherSnapshot | null => {
  try {
    const raw = localStorage.getItem(getWeatherCacheKey(settings))
    if (!raw) return null
    const snapshot = JSON.parse(raw) as WeatherSnapshot
    const updatedAt = Number(snapshot.updatedAt)
    if (!Number.isFinite(updatedAt)) return null
    if (!allowStale && Date.now() - updatedAt > WEATHER_CACHE_MAX_AGE) return null
    // 结构校验：解析成功但内容残缺（半截写入/旧版本结构）当作无缓存，
    // 并把坏数据删掉自愈，避免每次读取都撞同一份垃圾
    const structurallyValid = Array.isArray(snapshot?.daily) && snapshot.daily.length > 0
      && Array.isArray(snapshot?.hourly) && snapshot.hourly.length > 0
      && snapshot?.current && Number.isFinite(snapshot.current.temperature)
    if (!structurallyValid) {
      try { localStorage.removeItem(getWeatherCacheKey(settings)) } catch { /* ignore */ }
      return null
    }
    const location = normalizeLocationParts(snapshot.location as Partial<WeatherLocation>) as WeatherLocation
    if (settings.weatherLocationMode === 'auto' && location.name === '当前位置' && !location.province && !location.city && !location.district) return null
    return { ...snapshot, location }
  } catch {
    // JSON 解析失败（写入中断/损坏）：删掉坏缓存自愈
    try { localStorage.removeItem(getWeatherCacheKey(settings)) } catch { /* ignore */ }
    return null
  }
}

const resolveBrowserLocation = async (signal?: AbortSignal): Promise<WeatherLocation> => {
  const systemLocation = await window.electron?.system?.getLocation?.()
  if (systemLocation?.success && isValidCoordinate(Number(systemLocation.latitude), Number(systemLocation.longitude))) {
    return resolveCoordinatesLocation(Number(systemLocation.latitude), Number(systemLocation.longitude), signal)
  }

  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    throw new Error('当前环境不支持精确定位')
  }

  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    let settled = false
    const finish = (callback: (value: any) => void, value: any) => {
      if (settled) return
      settled = true
      callback(value)
    }
    const timeout = window.setTimeout(() => finish(reject, new Error('精确定位超时')), 8000)
    const onAbort = () => {
      window.clearTimeout(timeout)
      finish(reject, new DOMException('定位已取消', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    navigator.geolocation.getCurrentPosition(
      value => {
        window.clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        finish(resolve, value)
      },
      error => {
        window.clearTimeout(timeout)
        signal?.removeEventListener('abort', onAbort)
        finish(reject, error)
      },
      { enableHighAccuracy: true, maximumAge: 5 * 60 * 1000, timeout: 7000 },
    )
  })

  const latitude = position.coords.latitude
  const longitude = position.coords.longitude
  if (!isValidCoordinate(latitude, longitude)) throw new Error('精确定位没有返回有效坐标')

  return resolveCoordinatesLocation(latitude, longitude, signal)
}

const resolveIpLocation = async (signal?: AbortSignal): Promise<WeatherLocation> => {
  const attempts: Array<{
    endpoint: string
    normalize: (data: Record<string, unknown>) => Record<string, unknown>
  }> = [
    {
      endpoint: getApiBase() + '/location/ip',
      normalize: data => data,
    },
    {
      endpoint: 'https://ipinfo.io/json',
      normalize: data => {
        const [latitude, longitude] = String(data.loc || '').split(',').map(Number)
        return { ...data, latitude, longitude }
      },
    },
    {
      endpoint: 'https://ipwho.is/?lang=zh-CN',
      normalize: data => data,
    },
    {
      endpoint: 'https://ipapi.co/json/',
      normalize: data => ({
        ...data,
        country: data.country_name || data.country,
      }),
    },
  ]

  for (const { endpoint, normalize } of attempts) {
    try {
      const response = await fetch(endpoint, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = normalize(await response.json())
      const latitude = Number(data.latitude)
      const longitude = Number(data.longitude)
      if (data.success === false || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new Error(String(data.error || data.message || '定位服务没有返回有效坐标'))
      }

      const ipLocation = normalizeReverseLocation(data, latitude, longitude, {
        name: firstText(data.district, data.city, data.name, data.region, data.country, '当前位置'),
        province: firstText(data.province, data.region),
        city: firstText(data.city),
        district: firstText(data.district),
        region: makeRegionLabel(data.province || data.region, data.city, data.district),
        country: firstText(data.country),
        source: 'ip',
      })

      try {
        const preciseLocation = await resolveCoordinatesLocation(latitude, longitude, signal)
        return normalizeReverseLocation({}, latitude, longitude, {
          ...ipLocation,
          ...preciseLocation,
          country: preciseLocation.country || ipLocation.country,
          province: preciseLocation.province || ipLocation.province,
          city: preciseLocation.city || ipLocation.city,
          district: preciseLocation.district || ipLocation.district,
          township: preciseLocation.township || ipLocation.township,
          neighbourhood: preciseLocation.neighbourhood || ipLocation.neighbourhood,
          street: preciseLocation.street || ipLocation.street,
          formattedAddress: preciseLocation.formattedAddress || ipLocation.formattedAddress,
          source: 'ip',
        })
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error
      }

      return ipLocation
    } catch (error) {
      if ((error as Error).name === 'AbortError') throw error
    }
  }

  throw new Error('自动定位服务暂时繁忙，请稍后重试或选择手动定位')
}

// 自动定位结果缓存：Windows 系统定位（PowerShell 子进程 1-3s）+ 逆地理（1-2s）是
// 刷新链最慢的两段，而 10 分钟内用户位置几乎不变。缓存命中时刷新只需一次预报请求。
const AUTO_LOCATION_CACHE_TTL = 10 * 60 * 1000
let autoLocationCache: { location: WeatherLocation; at: number } | null = null

const resolveAutoLocation = async (signal?: AbortSignal): Promise<WeatherLocation> => {
  if (autoLocationCache && Date.now() - autoLocationCache.at < AUTO_LOCATION_CACHE_TTL) {
    return autoLocationCache.location
  }
  try {
    const location = await resolveBrowserLocation(signal)
    autoLocationCache = { location, at: Date.now() }
    return location
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    // 精确定位失败降级 IP 定位：IP 结果同样进缓存
    const ipLocation = await resolveIpLocation(signal)
    autoLocationCache = { location: ipLocation, at: Date.now() }
    return ipLocation
  }
}

const resolveChinaAdministrativeLocation = async (
  settings: DesktopCustomizationSettings,
  signal?: AbortSignal,
): Promise<WeatherLocation | null> => {
  if (settings.weatherCountryCode.toUpperCase() !== 'CN') return null

  const areaCode = settings.weatherDistrictCode || settings.weatherCityCode || settings.weatherProvinceCode
  if (!areaCode) return null

  try {
    const response = await fetch(`https://geo.datav.aliyun.com/areas_v3/bound/${encodeURIComponent(areaCode)}.json`, { signal })
    if (!response.ok) return null
    const data = await response.json()
    const feature = Array.isArray(data.features) ? data.features[0] : null
    const center = feature?.properties?.center
    if (!Array.isArray(center) || center.length < 2) return null
    const longitude = Number(center[0])
    const latitude = Number(center[1])
    if (!isValidCoordinate(latitude, longitude)) return null

    return {
      name: settings.weatherDistrict || settings.weatherCity || settings.weatherProvince || String(feature.properties?.name || '当前位置'),
      province: settings.weatherProvince,
      city: settings.weatherCity,
      district: settings.weatherDistrict,
      region: [settings.weatherProvince, settings.weatherCity].filter(Boolean).join(' · '),
      country: settings.weatherCountry || '中国',
      latitude,
      longitude,
      source: 'manual',
    }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return null
  }
}

const resolveManualLocation = async (
  settings: DesktopCustomizationSettings,
  signal?: AbortSignal,
): Promise<WeatherLocation> => {
  // 三个字段都可能为空/undefined（手动定位但未选地区），直接 .trim() 会抛 TypeError 让天气加载失败
  const targetName = String(settings.weatherDistrict || settings.weatherCity || settings.weatherProvince || '').trim()
  if (settings.weatherLatitude !== null && settings.weatherLongitude !== null
    && isValidCoordinate(Number(settings.weatherLatitude), Number(settings.weatherLongitude)) && targetName) {
    const province = String(settings.weatherProvince ?? '').trim()
    const city = String(settings.weatherCity ?? '').trim()
    const district = String(settings.weatherDistrict ?? '').trim()
    return {
      name: district || city || province || targetName,
      province, city, district,
      region: makeRegionLabel(province, city, district),
      country: settings.weatherCountry || '\u4e2d\u56fd',
      formattedAddress: uniqueLocationParts(settings.weatherCountry, province, city, district).join(''),
      latitude: Number(settings.weatherLatitude),
      longitude: Number(settings.weatherLongitude),
      source: 'manual',
    }
  }
  if (!targetName) throw new Error('请完整选择天气地区')

  const chinaAdministrativeLocation = await resolveChinaAdministrativeLocation(settings, signal)
  if (chinaAdministrativeLocation) return chinaAdministrativeLocation

  const provinceName = normalizePlaceName(settings.weatherProvince)
  const cityName = normalizePlaceName(settings.weatherCity)
  const districtName = normalizePlaceName(settings.weatherDistrict)
  const queries = Array.from(new Set([
    settings.weatherDistrict,
    settings.weatherCity,
    settings.weatherProvince,
    [settings.weatherCity, settings.weatherDistrict].filter(Boolean).join(' '),
    [settings.weatherProvince, settings.weatherCity].filter(Boolean).join(' '),
  ].map(value => String(value || '').trim()).filter(Boolean)))

  const candidates: Record<string, unknown>[] = []
  for (const query of queries) {
    const url = new URL('https://geocoding-api.open-meteo.com/v1/search')
    url.searchParams.set('name', query)
    url.searchParams.set('count', '100')
    url.searchParams.set('language', 'zh')
    url.searchParams.set('format', 'json')
    if (settings.weatherCountryCode) url.searchParams.set('countryCode', settings.weatherCountryCode)
    let openMeteoCount = 0
    const response = await fetch(url.toString(), { signal })
    if (response.ok) {
      const data = await response.json()
      if (Array.isArray(data.results)) {
        openMeteoCount = data.results.length
        candidates.push(...data.results)
      }
    }

    if (openMeteoCount === 0) {
      const fallbackUrl = new URL('https://nominatim.openstreetmap.org/search')
      fallbackUrl.searchParams.set('format', 'jsonv2')
      fallbackUrl.searchParams.set('q', query)
      fallbackUrl.searchParams.set('limit', '20')
      fallbackUrl.searchParams.set('addressdetails', '1')
      fallbackUrl.searchParams.set('accept-language', 'zh-CN')
      if (settings.weatherCountryCode.toUpperCase() === 'CN') fallbackUrl.searchParams.set('countrycodes', 'cn')
      try {
        const fallbackResponse = await fetch(fallbackUrl.toString(), {
          signal,
          headers: { Accept: 'application/json' },
        })
        if (fallbackResponse.ok) {
          const fallbackResults = await fallbackResponse.json()
          if (Array.isArray(fallbackResults)) {
            candidates.push(...fallbackResults.map((item: Record<string, unknown>) => {
              const address = (item.address || {}) as Record<string, unknown>
              return {
                name: item.name || item.display_name,
                admin1: address.province || address.state,
                admin2: address.city || address.town || address.municipality,
                admin3: address.district || address.county,
                country: address.country,
                country_code: address.country_code,
                latitude: item.lat,
                longitude: item.lon,
              }
            }))
          }
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error
      }
    }

    if (candidates.length >= 100) break
  }

  const place = candidates
    .filter(candidate => isValidCoordinate(Number(candidate.latitude), Number(candidate.longitude)))
    .map(candidate => {
      const name = normalizePlaceName(candidate.name)
      const admins = [candidate.admin1, candidate.admin2, candidate.admin3, candidate.admin4].map(normalizePlaceName)
      let score = 0
      if (districtName && name === districtName) score += 60
      if (cityName && name === cityName) score += 42
      if (provinceName && name === provinceName) score += 28
      if (districtName && admins.includes(districtName)) score += 24
      if (cityName && admins.includes(cityName)) score += 18
      if (provinceName && admins.includes(provinceName)) score += 12
      if (String(candidate.country_code || '').toUpperCase() === settings.weatherCountryCode.toUpperCase()) score += 5
      return { candidate, score }
    })
    .sort((left, right) => right.score - left.score)[0]?.candidate

  if (!place) {
    const fullName = [settings.weatherCountry, settings.weatherProvince, settings.weatherCity, settings.weatherDistrict].filter(Boolean).join(' · ')
    throw new Error(`没有找到“${fullName || targetName}”，请稍后重试或改选上一级地区`)
  }

  return {
    name: settings.weatherDistrict || settings.weatherCity || String(place.name || targetName),
    province: settings.weatherProvince || String(place.admin1 || ''),
    city: settings.weatherCity || String(place.admin2 || place.admin3 || ''),
    district: settings.weatherDistrict,
    region: [settings.weatherProvince, settings.weatherCity].filter(Boolean).join(' · '),
    country: settings.weatherCountry || String(place.country || ''),
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    source: 'manual',
  }
}

const makeAlerts = (current: WeatherCurrent, hourly: WeatherHour[], daily: WeatherDay[]): WeatherAlert[] => {
  const nextHours = hourly.slice(0, 12)
  const alerts: WeatherAlert[] = []
  const maxApparent = Math.max(current.apparentTemperature, ...nextHours.map(hour => hour.apparentTemperature))
  const minApparent = Math.min(current.apparentTemperature, ...nextHours.map(hour => hour.apparentTemperature))
  const maxGust = Math.max(current.windGusts, ...nextHours.map(hour => hour.windGusts))
  const maxHourlyPrecipitation = Math.max(current.precipitation, ...nextHours.map(hour => hour.precipitation))
  const minVisibility = Math.min(current.visibility, ...nextHours.map(hour => hour.visibility))
  const severeCode = Math.max(current.weatherCode, ...nextHours.map(hour => hour.weatherCode), daily[0]?.weatherCode || 0)

  if (severeCode >= 96) {
    alerts.push({
      id: 'hail-thunderstorm',
      level: 'extreme',
      title: '强雷暴与冰雹风险',
      message: '未来 12 小时存在强雷暴或冰雹条件，请尽量避免户外活动并远离高处与金属设施。',
    })
  } else if (severeCode >= 95) {
    alerts.push({
      id: 'thunderstorm',
      level: 'severe',
      title: '雷暴风险',
      message: '未来 12 小时可能出现雷暴，请留意短时强降水和阵风。',
    })
  }

  if (maxGust >= 75) {
    alerts.push({
      id: 'strong-wind',
      level: maxGust >= 100 ? 'extreme' : 'severe',
      title: '强风提醒',
      message: `未来 12 小时阵风最高约 ${Math.round(maxGust)} km/h，请固定室外物品并远离临时搭建物。`,
    })
  }

  if (maxHourlyPrecipitation >= 15) {
    alerts.push({
      id: 'heavy-rain',
      level: maxHourlyPrecipitation >= 30 ? 'extreme' : 'severe',
      title: '强降水提醒',
      message: `小时降水量可能达到 ${Math.round(maxHourlyPrecipitation)} 毫米，低洼路段可能积水。`,
    })
  }

  if (maxApparent >= 38) {
    alerts.push({
      id: 'heat',
      level: maxApparent >= 42 ? 'extreme' : 'severe',
      title: '高温提醒',
      message: `未来 12 小时最高体感温度约 ${Math.round(maxApparent)}°，请减少高温时段外出并及时补水。`,
    })
  } else if (minApparent <= -15) {
    alerts.push({
      id: 'cold',
      level: minApparent <= -25 ? 'extreme' : 'severe',
      title: '严寒提醒',
      message: `未来 12 小时最低体感温度约 ${Math.round(minApparent)}°，请注意防寒和路面结冰。`,
    })
  }

  if (minVisibility <= 1000) {
    alerts.push({
      id: 'low-visibility',
      level: minVisibility <= 300 ? 'severe' : 'moderate',
      title: '低能见度提醒',
      message: `未来 12 小时能见度最低约 ${Math.max(0.1, minVisibility / 1000).toFixed(1)} 公里，驾车请降低车速。`,
    })
  }

  return alerts.slice(0, 3)
}

const toNumber = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback

export async function fetchWeatherSnapshot(
  settings: DesktopCustomizationSettings,
  signal?: AbortSignal
): Promise<WeatherSnapshot> {
  const location = settings.weatherLocationMode === 'manual'
    ? await resolveManualLocation(settings, signal)
    : await resolveAutoLocation(signal)

  const currentFields = [
    'temperature_2m', 'apparent_temperature', 'relative_humidity_2m', 'weather_code', 'is_day',
    'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'surface_pressure', 'visibility', 'precipitation', 'cloud_cover',
  ].join(',')
  const hourlyFields = [
    'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'snowfall',
    'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'visibility', 'uv_index',
    'relative_humidity_2m', 'surface_pressure', 'dew_point_2m', 'cloud_cover',
    'snow_depth', 'freezing_level_height', 'cape', 'shortwave_radiation',
    'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'wind_speed_80m', 'uv_index_clear_sky',
  ].join(',')
  const dailyFields = [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max',
    'apparent_temperature_min', 'precipitation_probability_max', 'precipitation_sum',
    'wind_speed_10m_max', 'wind_gusts_10m_max', 'uv_index_max', 'sunrise', 'sunset',
    'daylight_duration', 'sunshine_duration',
    'snowfall_sum', 'precipitation_hours', 'rain_sum', 'showers_sum',
    'shortwave_radiation_sum', 'uv_index_clear_sky_max', 'moonrise', 'moonset', 'moon_phase',
    'wind_direction_10m_dominant', 'et0_fao_evapotranspiration', 'vapour_pressure_deficit_max',
  ].join(',')
  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
  forecastUrl.searchParams.set('latitude', String(location.latitude))
  forecastUrl.searchParams.set('longitude', String(location.longitude))
  forecastUrl.searchParams.set('current', currentFields)
  forecastUrl.searchParams.set('hourly', hourlyFields)
  forecastUrl.searchParams.set('daily', dailyFields)
  forecastUrl.searchParams.set('timezone', 'auto')
  forecastUrl.searchParams.set('forecast_days', '10')

  // 空气质量（独立免费端点）：与主预报并行请求（省一整个串行 RTT，刷新明显更快），
  // 失败/超时（6s）不影响主数据——主预报不陪它等。
  const aqUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
  aqUrl.searchParams.set('latitude', String(location.latitude))
  aqUrl.searchParams.set('longitude', String(location.longitude))
  // 注意：air-quality API 不提供 pm1（传了会整单 400），其余 current 字段可任意组合
  aqUrl.searchParams.set('current', 'european_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,sulphur_dioxide,carbon_monoxide,us_aqi')
  aqUrl.searchParams.set('hourly', 'european_aqi')
  aqUrl.searchParams.set('timezone', 'auto')
  aqUrl.searchParams.set('forecast_days', '2')

  const [forecastResult, aqResult] = await Promise.allSettled([
    fetch(forecastUrl.toString(), { signal }),
    fetch(aqUrl.toString(), { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6_000)]) : AbortSignal.timeout(6_000) }),
  ])

  if (forecastResult.status === 'rejected') throw forecastResult.reason instanceof Error ? forecastResult.reason : new Error('天气预报服务暂时不可用')
  const response = forecastResult.value
  if (!response.ok) throw new Error('天气预报服务暂时不可用')
  const data = await response.json()
  if (data.error) throw new Error(data.reason || '天气预报返回错误')
  // 结构完整性守卫：字段组不齐（上游模型变更/半响应）宁可报错走重试/缓存，也不落一份残缺快照
  if (!Array.isArray(data.daily?.time) || data.daily.time.length === 0 || !Array.isArray(data.hourly?.time) || data.hourly.time.length === 0 || !data.current) {
    throw new Error('天气预报返回数据不完整')
  }

  // 空气质量解析：失败/超时静默（可选数据）
  let airQuality: WeatherAirQuality | null = null
  if (aqResult.status === 'fulfilled' && aqResult.value.ok) {
    try {
      const aqData = await aqResult.value.json()
      const aqi = toNumber(aqData.current?.european_aqi)
      if (Number.isFinite(aqi)) {
        airQuality = {
          aqi,
          pm25: toNumber(aqData.current?.pm2_5),
          pm10: toNumber(aqData.current?.pm10),
          usAqi: toNumber(aqData.current?.us_aqi),
          ozone: toNumber(aqData.current?.ozone),
          nitrogenDioxide: toNumber(aqData.current?.nitrogen_dioxide),
          sulphurDioxide: toNumber(aqData.current?.sulphur_dioxide),
          carbonMonoxide: toNumber(aqData.current?.carbon_monoxide),
          hourlyAqi: (aqData.hourly?.time || []).slice(0, 25).map((time: string, index: number) => ({
            time,
            aqi: toNumber(aqData.hourly?.european_aqi?.[index]),
          })),
        }
      }
    } catch { /* 空气质量为可选数据 */ }
  }

  const current: WeatherCurrent = {
    time: data.current?.time || '',
    temperature: toNumber(data.current?.temperature_2m),
    apparentTemperature: toNumber(data.current?.apparent_temperature),
    humidity: toNumber(data.current?.relative_humidity_2m),
    weatherCode: toNumber(data.current?.weather_code),
    isDay: toNumber(data.current?.is_day, 1) === 1,
    windSpeed: toNumber(data.current?.wind_speed_10m),
    windDirection: toNumber(data.current?.wind_direction_10m),
    windGusts: toNumber(data.current?.wind_gusts_10m),
    pressure: toNumber(data.current?.surface_pressure),
    visibility: toNumber(data.current?.visibility),
    precipitation: toNumber(data.current?.precipitation),
    cloudCover: toNumber(data.current?.cloud_cover),
  }

  const hourly: WeatherHour[] = (data.hourly?.time || []).map((time: string, index: number) => ({
    time,
    temperature: toNumber(data.hourly.temperature_2m?.[index]),
    apparentTemperature: toNumber(data.hourly.apparent_temperature?.[index]),
    precipitationProbability: toNumber(data.hourly.precipitation_probability?.[index]),
    precipitation: toNumber(data.hourly.precipitation?.[index]),
    snowfall: toNumber(data.hourly.snowfall?.[index]),
    weatherCode: toNumber(data.hourly.weather_code?.[index]),
    windSpeed: toNumber(data.hourly.wind_speed_10m?.[index]),
    windGusts: toNumber(data.hourly.wind_gusts_10m?.[index]),
    windDirection: toNumber(data.hourly.wind_direction_10m?.[index]),
    snowDepth: toNumber(data.hourly.snow_depth?.[index]),
    freezingLevel: toNumber(data.hourly.freezing_level_height?.[index]),
    cape: toNumber(data.hourly.cape?.[index]),
    shortwaveRadiation: toNumber(data.hourly.shortwave_radiation?.[index]),
    cloudCoverLow: toNumber(data.hourly.cloud_cover_low?.[index]),
    cloudCoverMid: toNumber(data.hourly.cloud_cover_mid?.[index]),
    cloudCoverHigh: toNumber(data.hourly.cloud_cover_high?.[index]),
    windSpeed80m: toNumber(data.hourly.wind_speed_80m?.[index]),
    uvIndexClearSky: toNumber(data.hourly.uv_index_clear_sky?.[index]),
    visibility: toNumber(data.hourly.visibility?.[index]),
    uvIndex: toNumber(data.hourly.uv_index?.[index]),
    humidity: toNumber(data.hourly.relative_humidity_2m?.[index]),
    pressure: toNumber(data.hourly.surface_pressure?.[index]),
    dewPoint: toNumber(data.hourly.dew_point_2m?.[index]),
    cloudCover: toNumber(data.hourly.cloud_cover?.[index]),
  }))

  const daily: WeatherDay[] = (data.daily?.time || []).map((date: string, index: number) => ({
    date,
    weatherCode: toNumber(data.daily.weather_code?.[index]),
    temperatureMax: toNumber(data.daily.temperature_2m_max?.[index]),
    temperatureMin: toNumber(data.daily.temperature_2m_min?.[index]),
    apparentTemperatureMax: toNumber(data.daily.apparent_temperature_max?.[index]),
    apparentTemperatureMin: toNumber(data.daily.apparent_temperature_min?.[index]),
    precipitationProbability: toNumber(data.daily.precipitation_probability_max?.[index]),
    precipitationSum: toNumber(data.daily.precipitation_sum?.[index]),
    rainSum: toNumber(data.daily.rain_sum?.[index]),
    showersSum: toNumber(data.daily.showers_sum?.[index]),
    snowfallSum: toNumber(data.daily.snowfall_sum?.[index]),
    precipitationHours: toNumber(data.daily.precipitation_hours?.[index]),
    windSpeedMax: toNumber(data.daily.wind_speed_10m_max?.[index]),
    windGustsMax: toNumber(data.daily.wind_gusts_10m_max?.[index]),
    windDirectionDominant: toNumber(data.daily.wind_direction_10m_dominant?.[index]),
    uvIndexMax: toNumber(data.daily.uv_index_max?.[index]),
    uvIndexClearSkyMax: toNumber(data.daily.uv_index_clear_sky_max?.[index]),
    vapourPressureDeficitMax: toNumber(data.daily.vapour_pressure_deficit_max?.[index]),
    sunrise: data.daily.sunrise?.[index] || '',
    sunset: data.daily.sunset?.[index] || '',
    daylightDuration: toNumber(data.daily.daylight_duration?.[index]),
    sunshineDuration: toNumber(data.daily.sunshine_duration?.[index]),
    shortwaveRadiationSum: toNumber(data.daily.shortwave_radiation_sum?.[index]),
    et0Evapotranspiration: toNumber(data.daily.et0_fao_evapotranspiration?.[index]),
    moonrise: data.daily.moonrise?.[index] || '',
    moonset: data.daily.moonset?.[index] || '',
    moonPhase: toNumber(data.daily.moon_phase?.[index]),
  }))

  const currentHourIndex = Math.max(0, hourly.findIndex(hour => hour.time >= current.time))
  const upcomingHourly = hourly.slice(currentHourIndex)
  const snapshot: WeatherSnapshot = {
    location,
    timezone: data.timezone || '',
    current,
    hourly: upcomingHourly,
    daily,
    alerts: makeAlerts(current, upcomingHourly, daily),
    airQuality,
    updatedAt: Date.now(),
  }

  // 写入前结构校验：残缺快照（上游字段变更/解析异常）不落盘——落了会把上一份好缓存
  // 覆盖掉，之后 15 分钟内 UI 只能渲染残缺数据（"--"/0 值）。
  const snapshotValid = Array.isArray(daily) && daily.length > 0 && upcomingHourly.length > 0
    && Number.isFinite(current.temperature) && current.time
  if (snapshotValid) {
    try {
      localStorage.setItem(getWeatherCacheKey(settings), JSON.stringify(snapshot))
    } catch {
      // 配额满（10 天 hourly 快照较大）：放弃缓存，本次快照照常返回
    }
  }
  return snapshot
}

export async function ensureWeatherSnapshot(
  settings: DesktopCustomizationSettings,
  options: { forceRefresh?: boolean; signal?: AbortSignal } = {}
): Promise<WeatherSnapshot> {
  if (!options.forceRefresh) {
    const cached = getCachedWeather(settings)
    if (cached) return cached
  }

  const cacheKey = getWeatherCacheKey(settings)
  // 主预报请求自动重试一次（指数退避 1.2s）：Open-Meteo 偶发抖动/超时不该直接把
  // 整个天气页打挂——重试仍失败才把错误抛给调用方（调用方还有 stale 缓存兜底）。
  const requestOnce = (): Promise<WeatherSnapshot> => {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 20_000)
    const callerAbort = () => controller.abort()
    options.signal?.addEventListener('abort', callerAbort, { once: true })
    const request = fetchWeatherSnapshot(settings, controller.signal).finally(() => {
      window.clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', callerAbort)
    })
    weatherSnapshotPending.set(cacheKey, request)
    const cleanup = () => {
      if (weatherSnapshotPending.get(cacheKey) === request) weatherSnapshotPending.delete(cacheKey)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  let request = weatherSnapshotPending.get(cacheKey)
  if (!request || options.forceRefresh) {
    request = (async () => {
      try {
        return await requestOnce()
      } catch (firstError) {
        // 调用方已中止：不重试，原样抛 AbortError
        if ((firstError as Error).name === 'AbortError') throw firstError
        await new Promise(resolve => window.setTimeout(resolve, 1200))
        if (options.signal?.aborted) throw firstError
        try {
          return await requestOnce()
        } catch (retryError) {
          if ((retryError as Error).name === 'AbortError') throw retryError
          // 两次都失败：抛首个错误（更有信息量），由调用方降级 stale 缓存
          throw firstError
        }
      }
    })()
  }

  if (!options.signal) return request
  if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<WeatherSnapshot>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    options.signal?.addEventListener('abort', abort, { once: true })
    request.then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort))
  })
}
