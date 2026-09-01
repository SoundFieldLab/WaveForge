import type { DesktopCustomizationSettings } from './desktopCustomization'

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
  province: string
  city: string
  district: string
  latitude: number
  longitude: number
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
  /** 逐小时 AQI（用于趋势图） */
  hourlyAqi: Array<{ time: string; aqi: number }>
}

export const getAqiLabel = (aqi: number) => aqi < 20 ? '优' : aqi < 40 ? '良' : aqi < 60 ? '中等' : aqi < 80 ? '较差' : aqi <= 100 ? '很差' : '严重污染'
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
  visibility: number
  uvIndex: number
  humidity: number
  pressure: number
  dewPoint: number
  cloudCover: number
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
  windSpeedMax: number
  windGustsMax: number
  uvIndexMax: number
  sunrise: string
  sunset: string
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
const WEATHER_CACHE_MAX_AGE = 15 * 60 * 1000

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
  `${WEATHER_CACHE_PREFIX}${settings.weatherLocationMode}:${settings.weatherLocationMode === 'manual'
    ? [settings.weatherCountryCode, settings.weatherProvinceCode, settings.weatherCityCode, settings.weatherDistrictCode || settings.weatherDistrict, settings.weatherLatitude, settings.weatherLongitude]
      .filter(value => value !== null && value !== undefined && value !== '')
      .join(':')
      .toLowerCase()
    : 'current-auto-v2'}`

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

export const searchWeatherLocations = async (
  query: string,
  signal?: AbortSignal,
): Promise<WeatherLocationSearchResult[]> => {
  const keyword = query.trim()
  if (keyword.length < 2) return []

  const openMeteoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search')
  openMeteoUrl.searchParams.set('name', keyword)
  openMeteoUrl.searchParams.set('count', '12')
  openMeteoUrl.searchParams.set('language', 'zh')
  openMeteoUrl.searchParams.set('format', 'json')

  const nominatimUrl = new URL('https://nominatim.openstreetmap.org/search')
  nominatimUrl.searchParams.set('format', 'jsonv2')
  nominatimUrl.searchParams.set('q', keyword)
  nominatimUrl.searchParams.set('limit', '10')
  nominatimUrl.searchParams.set('addressdetails', '1')
  nominatimUrl.searchParams.set('accept-language', 'zh-CN')

  const [openMeteoResponse, nominatimResponse] = await Promise.allSettled([
    fetch(openMeteoUrl.toString(), { signal, headers: { Accept: 'application/json' } }),
    fetch(nominatimUrl.toString(), { signal, headers: { Accept: 'application/json' } }),
  ])

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const results: WeatherLocationSearchResult[] = []

  if (openMeteoResponse.status === 'fulfilled' && openMeteoResponse.value.ok) {
    const data = await openMeteoResponse.value.json()
    for (const item of Array.isArray(data.results) ? data.results : []) {
      const latitude = Number(item.latitude)
      const longitude = Number(item.longitude)
      if (!isValidCoordinate(latitude, longitude)) continue
      const name = firstText(item.name)
      const country = firstText(item.country)
      const countryCode = firstText(item.country_code).toUpperCase()
      const province = firstText(item.admin1)
      const city = firstText(item.admin2, item.admin3)
      const district = normalizePlaceName(name) !== normalizePlaceName(city)
        && normalizePlaceName(name) !== normalizePlaceName(province) ? name : firstText(item.admin3, item.admin4)
      results.push({
        id: `open-meteo:${latitude}:${longitude}`,
        label: makeLocationSearchLabel(country, province, city, district, name),
        name, countryCode, country, province, city, district, latitude, longitude,
      })
    }
  }

  if (nominatimResponse.status === 'fulfilled' && nominatimResponse.value.ok) {
    const data = await nominatimResponse.value.json()
    for (const item of Array.isArray(data) ? data : []) {
      const latitude = Number(item.lat)
      const longitude = Number(item.lon)
      if (!isValidCoordinate(latitude, longitude)) continue
      const address = item.address || {}
      const name = firstText(item.name, address.county, address.city, address.town, keyword)
      const country = firstText(address.country)
      const countryCode = firstText(address.country_code).toUpperCase()
      const province = firstText(address.province, address.state, address.region)
      const city = firstText(address.city, address.municipality, address.prefecture, address.town)
      let district = firstText(address.city_district, address.county, address.borough)
      if (!district && normalizePlaceName(name) !== normalizePlaceName(city) && normalizePlaceName(name) !== normalizePlaceName(province)) district = name
      results.push({
        id: `nominatim:${item.place_id || ''}:${latitude}:${longitude}`,
        label: makeLocationSearchLabel(country, province, city, district, name),
        name, countryCode, country, province, city, district, latitude, longitude,
      })
    }
  }

  const seen = new Set<string>()
  return results.filter(result => {
    const key = `${result.label}:${result.latitude.toFixed(3)}:${result.longitude.toFixed(3)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 12)
}
export const getWeatherLocationName = (
  location: Partial<WeatherLocation>,
) => firstText(
  location.street,
  location.township,
  location.neighbourhood,
  location.district,
  location.city,
  location.name,
  location.province,
  location.region,
  location.country,
  '当前位置',
)

export const getWeatherLocationAddress = (
  location: Partial<WeatherLocation>,
) => firstText(
  location.formattedAddress,
  uniqueLocationParts(location.province, location.city, location.district, location.township, location.street, location.neighbourhood).join(''),
  uniqueLocationParts(location.region, location.district, location.township, location.street).join(''),
  location.name,
  '当前位置',
)

export const getWeatherLocationCompactName = (
  location: Partial<WeatherLocation>,
) => {
  const formattedAddress = String(location.formattedAddress || '').trim()
  if (formattedAddress) {
    const administrativeParts = uniqueLocationParts(
      location.country,
      location.province,
      location.city,
      location.district,
      location.township,
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
    compact = compact
      .replace(/^[，,、；;：:\s-]+/, '')
      .replace(/^(?:[^省市区县旗盟州]{1,20}(?:街道|镇|乡))/, '')
      .replace(/^[，,、；;：:\s-]+/, '')
      .trim()
    if (compact && compact !== formattedAddress) return compact
  }
  return firstText(
    location.neighbourhood,
    location.street,
    location.name,
    location.township,
    location.district,
    location.city,
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
    const data = await requestReverseLocation(`http://127.0.0.1:3001/api/location/reverse?${query}`, signal)
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
    if (!allowStale && Date.now() - snapshot.updatedAt > WEATHER_CACHE_MAX_AGE) return null
    const location = snapshot.location as Partial<WeatherLocation>
    if (settings.weatherLocationMode === 'auto' && location.name === '当前位置' && !location.province && !location.city && !location.district) return null
    return snapshot
  } catch {
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
      endpoint: 'http://127.0.0.1:3001/api/location/ip',
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

const resolveAutoLocation = async (signal?: AbortSignal): Promise<WeatherLocation> => {
  try {
    return await resolveBrowserLocation(signal)
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    return resolveIpLocation(signal)
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
  const targetName = (settings.weatherDistrict || settings.weatherCity || settings.weatherProvince).trim()
  if (settings.weatherLatitude !== null && settings.weatherLongitude !== null
    && isValidCoordinate(Number(settings.weatherLatitude), Number(settings.weatherLongitude)) && targetName) {
    const province = settings.weatherProvince.trim()
    const city = settings.weatherCity.trim()
    const district = settings.weatherDistrict.trim()
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
    'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'visibility', 'uv_index', 'relative_humidity_2m', 'surface_pressure',
    'dew_point_2m', 'cloud_cover',
  ].join(',')
  const dailyFields = [
    'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max',
    'apparent_temperature_min', 'precipitation_probability_max', 'precipitation_sum',
    'wind_speed_10m_max', 'wind_gusts_10m_max', 'uv_index_max', 'sunrise', 'sunset',
  ].join(',')
  const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast')
  forecastUrl.searchParams.set('latitude', String(location.latitude))
  forecastUrl.searchParams.set('longitude', String(location.longitude))
  forecastUrl.searchParams.set('current', currentFields)
  forecastUrl.searchParams.set('hourly', hourlyFields)
  forecastUrl.searchParams.set('daily', dailyFields)
  forecastUrl.searchParams.set('timezone', 'auto')
  forecastUrl.searchParams.set('forecast_days', '10')

  const response = await fetch(forecastUrl.toString(), { signal })
  if (!response.ok) throw new Error('天气预报服务暂时不可用')
  const data = await response.json()
  if (data.error) throw new Error(data.reason || '天气预报返回错误')

  // 空气质量（独立免费端点，失败不影响主数据）
  let airQuality: WeatherAirQuality | null = null
  try {
    const aqUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality')
    aqUrl.searchParams.set('latitude', String(location.latitude))
    aqUrl.searchParams.set('longitude', String(location.longitude))
    aqUrl.searchParams.set('current', 'european_aqi,pm2_5,pm10')
    aqUrl.searchParams.set('hourly', 'european_aqi')
    aqUrl.searchParams.set('timezone', 'auto')
    aqUrl.searchParams.set('forecast_days', '2')
    const aqResponse = await fetch(aqUrl.toString(), { signal })
    if (aqResponse.ok) {
      const aqData = await aqResponse.json()
      const aqi = toNumber(aqData.current?.european_aqi)
      if (aqi > 0) {
        airQuality = {
          aqi,
          pm25: toNumber(aqData.current?.pm2_5),
          pm10: toNumber(aqData.current?.pm10),
          hourlyAqi: (aqData.hourly?.time || []).slice(0, 25).map((time: string, index: number) => ({
            time,
            aqi: toNumber(aqData.hourly?.european_aqi?.[index]),
          })),
        }
      }
    }
  } catch { /* 空气质量为可选数据 */ }

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
    windSpeedMax: toNumber(data.daily.wind_speed_10m_max?.[index]),
    windGustsMax: toNumber(data.daily.wind_gusts_10m_max?.[index]),
    uvIndexMax: toNumber(data.daily.uv_index_max?.[index]),
    sunrise: data.daily.sunrise?.[index] || '',
    sunset: data.daily.sunset?.[index] || '',
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

  localStorage.setItem(getWeatherCacheKey(settings), JSON.stringify(snapshot))
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
  let request = weatherSnapshotPending.get(cacheKey)
  if (!request || options.forceRefresh) {
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 20_000)
    request = fetchWeatherSnapshot(settings, controller.signal).finally(() => window.clearTimeout(timeoutId))
    weatherSnapshotPending.set(cacheKey, request)
    const cleanup = () => {
      if (weatherSnapshotPending.get(cacheKey) === request) weatherSnapshotPending.delete(cacheKey)
    }
    void request.then(cleanup, cleanup)
  }

  if (!options.signal) return request
  if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError')
  return new Promise<WeatherSnapshot>((resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    options.signal?.addEventListener('abort', abort, { once: true })
    request.then(resolve, reject).finally(() => options.signal?.removeEventListener('abort', abort))
  })
}
