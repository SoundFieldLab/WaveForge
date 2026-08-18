// 官方灾害数据代理：中央气象台台风网 / 中国地震台网中心
const SOURCE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 WaveForge/0.1',
  Accept: 'application/json,text/plain,*/*',
}

const TYPHOON_CACHE_TTL = 5 * 60 * 1000
const EARTHQUAKE_CACHE_TTL = 2 * 60 * 1000
let typhoonCache = null
let typhoonCacheAt = 0
let typhoonPending = null
let earthquakeCache = null
let earthquakeCacheAt = 0
let earthquakePending = null

async function fetchText(url, { referer = '', timeout = 12000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { ...SOURCE_HEADERS, ...(referer ? { Referer: referer } : {}) },
    })
    if (!response.ok) throw new Error('上游服务返回 HTTP ' + response.status)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

function parseJsonpObject(text) {
  const source = String(text || '').trim()
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('上游返回的数据格式无效')
  return JSON.parse(source.slice(start, end + 1))
}

function normalizeTyphoonPoint(point) {
  if (!Array.isArray(point)) return null
  const forecasts = point[11] && typeof point[11] === 'object'
    ? Object.entries(point[11]).flatMap(([agency, rows]) => Array.isArray(rows)
      ? rows.map(row => ({
          agency,
          hours: Number(row?.[0]) || 0,
          time: String(row?.[1] || ''),
          longitude: Number(row?.[2]),
          latitude: Number(row?.[3]),
          pressure: Number(row?.[4]) || 0,
          windSpeed: Number(row?.[5]) || 0,
          type: String(row?.[7] || ''),
        })).filter(item => Number.isFinite(item.longitude) && Number.isFinite(item.latitude))
      : [])
    : []

  return {
    id: String(point[0] || ''),
    time: String(point[1] || ''),
    timestamp: Number(point[2]) || 0,
    type: String(point[3] || ''),
    longitude: Number(point[4]),
    latitude: Number(point[5]),
    pressure: Number(point[6]) || 0,
    windSpeed: Number(point[7]) || 0,
    moveDirection: String(point[8] || ''),
    moveSpeed: Number(point[9]) || 0,
    windRadii: Array.isArray(point[10]) ? point[10] : [],
    forecasts,
  }
}

async function loadTyphoons({ force = false } = {}) {
  const now = Date.now()
  if (!force && typhoonCache && now - typhoonCacheAt < TYPHOON_CACHE_TTL) return typhoonCache
  if (!force && typhoonPending) return typhoonPending

  typhoonPending = (async () => {
    const referer = 'https://typhoon.nmc.cn/web.html'
    const listText = await fetchText(
      'https://typhoon.nmc.cn/weatherservice/typhoon/jsons/list_default?t=' + Date.now(),
      { referer },
    )
    const list = parseJsonpObject(listText)?.typhoonList
    const activeRows = (Array.isArray(list) ? list : [])
      .filter(row => Array.isArray(row) && String(row[7] || '').toLowerCase() === 'start')
      .slice(0, 8)

    const settled = await Promise.allSettled(activeRows.map(async row => {
      const id = String(row[0] || '')
      const detailText = await fetchText(
        'https://typhoon.nmc.cn/weatherservice/typhoon/jsons/view_' + encodeURIComponent(id) + '?t=' + Date.now(),
        { referer },
      )
      const typhoon = parseJsonpObject(detailText)?.typhoon
      const rawPoints = Array.isArray(typhoon?.[8]) ? typhoon[8] : []
      const track = rawPoints.map(normalizeTyphoonPoint).filter(Boolean).slice(-120)
      const latest = track.at(-1) || null
      const forecast = latest?.forecasts?.filter(item => item.agency === 'BABJ') || latest?.forecasts || []
      return {
        id,
        internationalName: String(typhoon?.[1] || row[1] || ''),
        chineseName: String(typhoon?.[2] || row[2] || '未命名台风'),
        number: String(typhoon?.[3] || row[3] || ''),
        meaning: String(typhoon?.[6] || row[6] || ''),
        status: String(typhoon?.[7] || row[7] || 'start'),
        active: true,
        latest,
        forecast,
        track,
      }
    }))

    const data = settled
      .filter(result => result.status === 'fulfilled')
      .map(result => result.value)
      .sort((a, b) => Number(b.latest?.timestamp || 0) - Number(a.latest?.timestamp || 0))
    if (data.length === 0 && activeRows.length > 0) {
      const firstError = settled.find(result => result.status === 'rejected')
      throw firstError?.reason || new Error('台风路径暂时无法获取')
    }
    typhoonCache = {
      source: '中国气象局中央气象台台风网',
      sourceUrl: 'https://typhoon.nmc.cn/',
      updatedAt: Date.now(),
      items: data,
    }
    typhoonCacheAt = Date.now()
    return typhoonCache
  })().finally(() => { typhoonPending = null })

  return typhoonPending
}

async function loadEarthquakes({ force = false } = {}) {
  const now = Date.now()
  if (!force && earthquakeCache && now - earthquakeCacheAt < EARTHQUAKE_CACHE_TTL) return earthquakeCache
  if (!force && earthquakePending) return earthquakePending

  earthquakePending = (async () => {
    const text = await fetchText('https://www.ceic.ac.cn/data/data.json?t=' + Date.now(), {
      referer: 'https://www.ceic.ac.cn/',
    })
    const rows = JSON.parse(text)
    const items = (Array.isArray(rows) ? rows : []).map(row => ({
      id: String(row?.id || ''),
      time: String(row?.time || ''),
      latitude: Number(row?.latitude),
      longitude: Number(row?.longitude),
      depth: Number(row?.depth) || 0,
      magnitude: Number(row?.magnitude) || 0,
      location: String(row?.location || '未知区域'),
    })).filter(item => item.id && Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
      .slice(0, 300)

    earthquakeCache = {
      source: '中国地震台网中心地震目录',
      sourceUrl: 'https://www.ceic.ac.cn/',
      updatedAt: Date.now(),
      items,
    }
    earthquakeCacheAt = Date.now()
    return earthquakeCache
  })().finally(() => { earthquakePending = null })

  return earthquakePending
}

export function registerHazardRoutes(app) {
  app.get('/api/hazards/typhoons', async (req, res) => {
    try {
      const data = await loadTyphoons({ force: req.query.refresh === '1' })
      res.setHeader('Cache-Control', 'private, max-age=120')
      return res.json({ success: true, ...data })
    } catch (error) {
      console.warn('[台风数据] 获取失败:', error?.message || error)
      if (typhoonCache) return res.json({ success: true, ...typhoonCache, stale: true })
      return res.status(503).json({ success: false, error: '中央气象台台风数据暂时不可用' })
    }
  })

  app.get('/api/hazards/earthquakes', async (req, res) => {
    try {
      const data = await loadEarthquakes({ force: req.query.refresh === '1' })
      res.setHeader('Cache-Control', 'private, max-age=60')
      return res.json({ success: true, ...data })
    } catch (error) {
      console.warn('[地震数据] 获取失败:', error?.message || error)
      if (earthquakeCache) return res.json({ success: true, ...earthquakeCache, stale: true })
      return res.status(503).json({ success: false, error: '中国地震台网中心数据暂时不可用' })
    }
  })

  app.get('/api/hazards/snapshot', async (req, res) => {
    const force = req.query.refresh === '1'
    const [typhoons, earthquakes] = await Promise.allSettled([
      loadTyphoons({ force }),
      loadEarthquakes({ force }),
    ])
    const result = {
      success: typhoons.status === 'fulfilled' || earthquakes.status === 'fulfilled',
      updatedAt: Date.now(),
      typhoons: typhoons.status === 'fulfilled' ? typhoons.value : null,
      earthquakes: earthquakes.status === 'fulfilled' ? earthquakes.value : null,
      errors: {
        typhoons: typhoons.status === 'rejected' ? String(typhoons.reason?.message || typhoons.reason || '') : '',
        earthquakes: earthquakes.status === 'rejected' ? String(earthquakes.reason?.message || earthquakes.reason || '') : '',
      },
    }
    return res.status(result.success ? 200 : 503).json(result)
  })
}
