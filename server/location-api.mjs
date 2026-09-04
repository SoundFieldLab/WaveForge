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

const requestReverseLocation = async (latitude, longitude) => {
  const photonUrl = new URL('https://photon.komoot.io/reverse')
  photonUrl.searchParams.set('lat', String(latitude))
  photonUrl.searchParams.set('lon', String(longitude))

  const fallbackUrl = new URL('https://api.bigdatacloud.net/data/reverse-geocode-client')
  fallbackUrl.searchParams.set('latitude', String(latitude))
  fallbackUrl.searchParams.set('longitude', String(longitude))
  fallbackUrl.searchParams.set('localityLanguage', 'zh')

  const [photonResult, administrativeResult] = await Promise.allSettled([
    fetchJson(photonUrl.toString(), 'WaveForge/0.1 local desktop weather').then(normalizePhoton),
    fetchJson(fallbackUrl.toString(), 'WaveForge/0.1 local desktop weather').then(normalizeBigDataCloud),
  ])
  const photon = photonResult.status === 'fulfilled' ? photonResult.value : null
  const administrative = administrativeResult.status === 'fulfilled' ? administrativeResult.value : null
  const merged = mergeLocations(administrative, photon)
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
