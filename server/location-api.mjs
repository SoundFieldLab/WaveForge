const REVERSE_CACHE_TTL = 6 * 60 * 60 * 1000
const REVERSE_CACHE_LIMIT = 200
const reverseCache = new Map()
const reversePending = new Map()

const text = (...values) => {
  for (const value of values) {
    const result = String(value || '').trim()
      .replace(/區/g, '区')
      .replace(/縣/g, '县')
      .replace(/鄉/g, '乡')
      .replace(/鎮/g, '镇')
      .replace(/臺/g, '台')
    if (result) return result
  }
  return ''
}

const unique = values => Array.from(new Set(values.map(value => String(value || '').trim()).filter(Boolean)))

const normalizeNominatim = data => {
  const address = data?.address || {}
  const province = text(address.province, address.state, address.region)
  const city = text(address.city, address.municipality, address.prefecture, address.town)
  const district = text(address.city_district, address.district, address.county, address.borough)
  const township = text(address.township, address.suburb, address.village, address.town)
  const neighbourhood = text(address.neighbourhood, address.quarter)
  const street = text(address.road, address.pedestrian, address.residential, address.footway, address.path)
  const houseNumber = text(address.house_number)
  const country = text(address.country)
  const formattedAddress = unique([province, city, district, township, street, houseNumber, neighbourhood]).join('')
    || text(data?.display_name)

  return {
    province,
    city,
    district,
    township,
    neighbourhood,
    street: [street, houseNumber].filter(Boolean).join(''),
    country,
    formattedAddress,
    displayName: text(data?.display_name),
    address,
    provider: 'nominatim',
  }
}

const normalizePhoton = data => {
  const properties = Array.isArray(data?.features) ? data.features[0]?.properties || {} : {}
  const province = text(properties.state)
  const city = text(properties.city)
  const district = text(properties.county)
  const township = text(properties.district, properties.locality)
  const street = text(properties.street)
  const neighbourhood = text(properties.name)
  const country = text(properties.country)
  const formattedAddress = unique([province, city, district, township, street, neighbourhood]).join('')

  return {
    province,
    city,
    district,
    township,
    neighbourhood,
    street,
    country,
    formattedAddress,
    displayName: formattedAddress,
    address: {},
    provider: 'photon',
  }
}

const normalizeBigDataCloud = data => {
  const admin = Array.isArray(data?.localityInfo?.administrative) ? data.localityInfo.administrative : []
  const subdivision = text(data?.principalSubdivision, admin.find(item => Number(item?.adminLevel) === 4)?.name)
  const city = text(data?.city, admin.find(item => Number(item?.adminLevel) === 5)?.name)
  const district = text(admin.find(item => Number(item?.adminLevel) === 6)?.name, admin.find(item => Number(item?.adminLevel) === 7)?.name)
  const township = text(admin.find(item => Number(item?.adminLevel) >= 8)?.name, data?.locality && data.locality !== district ? data.locality : '')
  const country = text(data?.countryName)
  const formattedAddress = unique([subdivision, city, district, township]).join('')

  return {
    province: subdivision,
    city,
    district,
    township,
    neighbourhood: '',
    street: '',
    country,
    formattedAddress,
    displayName: formattedAddress,
    address: {},
    provider: 'bigdatacloud',
  }
}

const fetchJson = async (url, userAgent) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 9000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'User-Agent': userAgent,
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  } finally {
    clearTimeout(timeout)
  }
}

const mergeLocations = (...locations) => {
  const valid = locations.filter(Boolean)
  const province = text(...valid.map(location => location.province))
  const city = text(...valid.map(location => location.city))
  const district = text(...valid.map(location => location.district))
  const township = text(...valid.map(location => location.township))
  const street = text(...valid.map(location => location.street))
  const neighbourhood = text(...valid.map(location => location.neighbourhood))
  const country = text(...valid.map(location => location.country))
  const formattedAddress = unique([province, city, district, township, street, neighbourhood]).join('')
    || text(...valid.map(location => location.formattedAddress))

  return {
    province,
    city,
    district,
    township,
    street,
    neighbourhood,
    country,
    formattedAddress,
    displayName: formattedAddress,
    address: {},
    provider: unique(valid.map(location => location.provider)).join('+'),
  }
}

const NEIGHBOURHOOD_CACHE_TTL = 24 * 60 * 60 * 1000
const NEIGHBOURHOOD_CACHE_LIMIT = 300
const neighbourhoodCache = new Map()

// Overpass 实例按可用性轮询：官方实例高峰期常 502/排队，kumi 镜像要求真实 UA。
// 任一实例成功后结果进 24h 缓存，同一坐标不会重复打网络。
const NEIGHBOURHOOD_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

// Overpass 查询坐标所在的带名居住区多边形（小区/村落）。OSM 对国内小区的标注是
// landuse=residential 命名多边形，常规逆地理接口不返回，必须用空间"点在多边形内"查询。
// 命中容差：GPS 坐标常落在小区边上而非内部，太紧会频繁查空；太松会显示隔壁小区。
const NEIGHBOURHOOD_RADIUS_M = 120

const resolveNeighbourhood = async (latitude, longitude) => {
  // 4 位小数（约 11 米）粒度缓存：同小区反反复复的查询只打一次 Overpass
  const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`
  const cached = neighbourhoodCache.get(cacheKey)
  if (cached && Date.now() - cached.updatedAt < NEIGHBOURHOOD_CACHE_TTL) return cached.name

  const query = `[out:json][timeout:8];(
    way["landuse"="residential"]["name"](around:${NEIGHBOURHOOD_RADIUS_M},${latitude.toFixed(6)},${longitude.toFixed(6)});
    relation["landuse"="residential"]["name"](around:${NEIGHBOURHOOD_RADIUS_M},${latitude.toFixed(6)},${longitude.toFixed(6)});
  );out tags center 6;`

  for (const endpoint of NEIGHBOURHOOD_ENDPOINTS) {
    try {
      const data = await fetchJson(`${endpoint}?data=${encodeURIComponent(query)}`, 'WaveForge/0.1 (local desktop weather neighbourhood lookup)')
      const elements = Array.isArray(data?.elements) ? data.elements : []
      let best = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const element of elements) {
        const name = String(element?.tags?.name || '').trim()
        const center = element?.center
        const elementLatitude = Number(center?.lat)
        const elementLongitude = Number(center?.lon)
        if (!name || !Number.isFinite(elementLatitude) || !Number.isFinite(elementLongitude)) continue
        // 距多边形中心超过 ~600m 的小区视为不相关（大居住区多边形中心可能在几百米外）
        const distanceMeters = Math.hypot(
          (elementLongitude - longitude) * Math.cos(latitude * Math.PI / 180) * 111_320,
          (elementLatitude - latitude) * 110_540,
        )
        if (distanceMeters > 600) continue
        if (distanceMeters < bestDistance) {
          best = name
          bestDistance = distanceMeters
        }
      }
      if (!best) return ''
      if (neighbourhoodCache.size >= NEIGHBOURHOOD_CACHE_LIMIT) neighbourhoodCache.delete(neighbourhoodCache.keys().next().value)
      neighbourhoodCache.set(cacheKey, { name: best, updatedAt: Date.now() })
      return best
    } catch {
      // 该实例拥堵/超时：换下一个实例；全部失败则静默降级（不影响行政三级地址返回）
    }
  }
  return ''
}

const requestReverseLocation = async (latitude, longitude) => {
  const photonUrl = new URL('https://photon.komoot.io/reverse')
  photonUrl.searchParams.set('lat', String(latitude))
  photonUrl.searchParams.set('lon', String(longitude))

  const fallbackUrl = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client')
  fallbackUrl.searchParams.set('latitude', String(latitude))
  fallbackUrl.searchParams.set('longitude', String(longitude))
  fallbackUrl.searchParams.set('localityLanguage', 'zh')

  const [photonResult, administrativeResult, neighbourhoodResult] = await Promise.allSettled([
    fetchJson(photonUrl.toString(), 'WaveForge/0.1 local desktop weather').then(normalizePhoton),
    fetchJson(fallbackUrl.toString(), 'WaveForge/0.1 local desktop weather').then(normalizeBigDataCloud),
    resolveNeighbourhood(latitude, longitude),
  ])
  const photon = photonResult.status === 'fulfilled' ? photonResult.value : null
  const administrative = administrativeResult.status === 'fulfilled' ? administrativeResult.value : null
  const neighbourhood = neighbourhoodResult.status === 'fulfilled' ? neighbourhoodResult.value : ''
  const merged = mergeLocations(administrative, photon)
  // Overpass 点内查询命中的小区名：OSM 系反查源（Photon/BigDataCloud/Nominatim）对国内
  // 小区几乎不返回 neighbourhood——居住区是带名 landuse 多边形，不是地址对象。命中后写入
  // neighbourhood 字段（前端取名优先级 street → township → neighbourhood，有路名时仍显示路名）。
  if (neighbourhood) {
    merged.neighbourhood = neighbourhood
    merged.formattedAddress = unique([merged.province, merged.city, merged.district, merged.township, merged.street, neighbourhood]).join('')
      || merged.formattedAddress
    merged.displayName = merged.formattedAddress
  }
  if (merged.formattedAddress) return merged

  const nominatimUrl = new URL('https://nominatim.openstreetmap.org/reverse')
  nominatimUrl.searchParams.set('format', 'jsonv2')
  nominatimUrl.searchParams.set('lat', String(latitude))
  nominatimUrl.searchParams.set('lon', String(longitude))
  nominatimUrl.searchParams.set('zoom', '18')
  nominatimUrl.searchParams.set('addressdetails', '1')
  nominatimUrl.searchParams.set('accept-language', 'zh-CN')
  const nominatim = normalizeNominatim(await fetchJson(
    nominatimUrl.toString(),
    'WaveForge/0.1 (local desktop weather reverse geocoder)',
  ))
  if (!nominatim.formattedAddress) throw new Error('反向定位服务没有返回有效地址')
  return nominatim
}

export function registerLocationRoutes(app) {
  app.get('/api/location/reverse', async (req, res) => {
    const latitude = Number(req.query.latitude ?? req.query.lat)
    const longitude = Number(req.query.longitude ?? req.query.lon)
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return res.status(400).json({ success: false, error: '经纬度参数无效' })
    }

    const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`
    const cached = reverseCache.get(cacheKey)
    if (cached && Date.now() - cached.updatedAt < REVERSE_CACHE_TTL) {
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return res.json({ success: true, ...cached.location, latitude, longitude, cached: true })
    }

    let pending = reversePending.get(cacheKey)
    if (!pending) {
      pending = requestReverseLocation(latitude, longitude)
      reversePending.set(cacheKey, pending)
      pending.finally(() => reversePending.delete(cacheKey)).catch(() => {})
    }

    try {
      const location = await pending
      if (reverseCache.size >= REVERSE_CACHE_LIMIT) reverseCache.delete(reverseCache.keys().next().value)
      reverseCache.set(cacheKey, { location, updatedAt: Date.now() })
      res.setHeader('Cache-Control', 'private, max-age=3600')
      return res.json({ success: true, ...location, latitude, longitude })
    } catch (error) {
      console.warn('[天气定位] 反向定位失败:', error?.message || error)
      if (cached) return res.json({ success: true, ...cached.location, latitude, longitude, cached: true, stale: true })
      return res.status(503).json({ success: false, error: '暂时无法解析当前位置的详细地址' })
    }
  })
}
