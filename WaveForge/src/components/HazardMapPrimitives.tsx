import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import type { EarthquakeEvent } from '../services/hazardService'
import type { HazardWeatherLayerSample } from '../services/hazardWeatherLayerService'

export const HAZARD_MAP_WIDTH = 960
export const HAZARD_MAP_HEIGHT = 500

export interface HazardMapBounds {
  minLongitude: number
  maxLongitude: number
  minLatitude: number
  maxLatitude: number
}

export type HazardMapBaseLayer = 'topographic' | 'satellite'

export interface HazardMapTile {
  key: string
  href: string
  satelliteHref: string
  fallbackHref: string
  x: number
  y: number
  width: number
  height: number
}

export interface HazardMapCenter {
  longitude: number
  latitude: number
}

export interface HazardMapViewport {
  bounds: HazardMapBounds
  center: HazardMapCenter
  zoom: number
  fitZoom: number
  x: (longitude: number) => number
  y: (latitude: number) => number
  longitudeAt: (x: number) => number
  latitudeAt: (y: number) => number
  tiles: HazardMapTile[]
}

export interface HazardMapViewportOptions {
  zoom?: number
  center?: HazardMapCenter
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const worldSize = (zoom: number) => 256 * (2 ** zoom)
const worldX = (longitude: number, zoom: number) => ((longitude + 180) / 360) * worldSize(zoom)
const worldY = (latitude: number, zoom: number) => {
  const safeLatitude = clamp(latitude, -85.0511, 85.0511)
  const radians = safeLatitude * Math.PI / 180
  return (1 - Math.log(Math.tan(radians) + (1 / Math.cos(radians))) / Math.PI) / 2 * worldSize(zoom)
}
const longitudeFromWorldX = (value: number, zoom: number) => value / worldSize(zoom) * 360 - 180
const latitudeFromWorldY = (value: number, zoom: number) => {
  const n = Math.PI - (2 * Math.PI * value) / worldSize(zoom)
  return Math.atan(Math.sinh(n)) * 180 / Math.PI
}

export function createHazardMapViewport(bounds: HazardMapBounds, options: HazardMapViewportOptions = {}): HazardMapViewport {
  const calculateFitZoom = () => {
    for (let candidate = 7; candidate >= 3; candidate -= 1) {
      const horizontalSpan = Math.abs(worldX(bounds.maxLongitude, candidate) - worldX(bounds.minLongitude, candidate))
      const verticalSpan = Math.abs(worldY(bounds.minLatitude, candidate) - worldY(bounds.maxLatitude, candidate))
      if (horizontalSpan <= HAZARD_MAP_WIDTH && verticalSpan <= HAZARD_MAP_HEIGHT) return candidate
    }
    return 3
  }
  const fitZoom = calculateFitZoom()
  const zoom = clamp(options.zoom ?? fitZoom, fitZoom, 13)
  const fittedCenterWorldX = (worldX(bounds.minLongitude, zoom) + worldX(bounds.maxLongitude, zoom)) / 2
  const fittedCenterWorldY = (worldY(bounds.maxLatitude, zoom) + worldY(bounds.minLatitude, zoom)) / 2
  const center = options.center || {
    longitude: longitudeFromWorldX(fittedCenterWorldX, zoom),
    latitude: latitudeFromWorldY(fittedCenterWorldY, zoom),
  }
  const left = worldX(center.longitude, zoom) - HAZARD_MAP_WIDTH / 2
  const right = left + HAZARD_MAP_WIDTH
  const top = worldY(center.latitude, zoom) - HAZARD_MAP_HEIGHT / 2
  const bottom = top + HAZARD_MAP_HEIGHT
  const x = (longitude: number) => worldX(longitude, zoom) - left
  const y = (latitude: number) => worldY(latitude, zoom) - top
  const longitudeAt = (screenX: number) => longitudeFromWorldX(left + screenX, zoom)
  const latitudeAt = (screenY: number) => latitudeFromWorldY(top + screenY, zoom)
  const tileSize = 256
  const tileCount = 2 ** zoom
  const tiles: HazardMapTile[] = []
  const minTileX = Math.floor(left / tileSize)
  const maxTileX = Math.floor(right / tileSize)
  const minTileY = Math.max(0, Math.floor(top / tileSize))
  const maxTileY = Math.min(tileCount - 1, Math.floor(bottom / tileSize))
  for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
    for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
      const normalizedTileX = ((tileX % tileCount) + tileCount) % tileCount
      const upstream = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${zoom}/${tileY}/${normalizedTileX}`
      const satellite = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${tileY}/${normalizedTileX}`
      const fallback = `https://tile.openstreetmap.de/${zoom}/${normalizedTileX}/${tileY}.png`
      tiles.push({
        key: `${zoom}-${tileX}-${tileY}`,
        href: upstream,
        satelliteHref: satellite,
        fallbackHref: fallback,
        x: tileX * tileSize - left,
        y: tileY * tileSize - top,
        width: tileSize + 1,
        height: tileSize + 1,
      })
    }
  }
  const visibleBounds = {
    minLongitude: longitudeAt(0),
    maxLongitude: longitudeAt(HAZARD_MAP_WIDTH),
    minLatitude: latitudeAt(HAZARD_MAP_HEIGHT),
    maxLatitude: latitudeAt(0),
  }
  return { bounds: visibleBounds, center, zoom, fitZoom, x, y, longitudeAt, latitudeAt, tiles }
}

export interface HazardMapNavigation {
  viewport: HazardMapViewport
  isDragging: boolean
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void
  zoomIn: () => void
  zoomOut: () => void
  reset: () => void
}

export function useHazardMapNavigation(bounds: HazardMapBounds | null): HazardMapNavigation | null {
  const fitViewport = useMemo(() => bounds ? createHazardMapViewport(bounds) : null, [bounds?.minLongitude, bounds?.maxLongitude, bounds?.minLatitude, bounds?.maxLatitude])
  const [view, setView] = useState<{ zoom: number; center: HazardMapCenter } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; centerWorldX: number; centerWorldY: number; zoom: number } | null>(null)

  useEffect(() => {
    if (!fitViewport) {
      setView(null)
      return
    }
    setView({ zoom: fitViewport.zoom, center: fitViewport.center })
    setIsDragging(false)
  }, [fitViewport?.fitZoom, fitViewport?.center.longitude, fitViewport?.center.latitude])

  const viewport = useMemo(() => {
    if (!fitViewport || !view) return null
    return createHazardMapViewport(bounds!, { zoom: view.zoom, center: view.center })
  }, [bounds, fitViewport, view])

  const setZoom = (nextZoom: number) => {
    if (!viewport) return
    setView(current => current ? { ...current, zoom: clamp(nextZoom, viewport.fitZoom, 13) } : current)
  }

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!viewport) return
    event.preventDefault()
    event.stopPropagation()
    event.nativeEvent.stopImmediatePropagation?.()
    const rect = event.currentTarget.getBoundingClientRect()
    const screenX = clamp(((event.clientX - rect.left) / rect.width) * HAZARD_MAP_WIDTH, 0, HAZARD_MAP_WIDTH)
    const screenY = clamp(((event.clientY - rect.top) / rect.height) * HAZARD_MAP_HEIGHT, 0, HAZARD_MAP_HEIGHT)
    const nextZoom = clamp(viewport.zoom + (event.deltaY < 0 ? 1 : -1), viewport.fitZoom, 13)
    if (nextZoom === viewport.zoom) return
    const anchorLongitude = viewport.longitudeAt(screenX)
    const anchorLatitude = viewport.latitudeAt(screenY)
    const nextCenter = {
      longitude: longitudeFromWorldX(worldX(anchorLongitude, nextZoom) - (screenX - HAZARD_MAP_WIDTH / 2), nextZoom),
      latitude: latitudeFromWorldY(worldY(anchorLatitude, nextZoom) - (screenY - HAZARD_MAP_HEIGHT / 2), nextZoom),
    }
    setView({ zoom: nextZoom, center: nextCenter })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!viewport || event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centerWorldX: worldX(viewport.center.longitude, viewport.zoom),
      centerWorldY: worldY(viewport.center.latitude, viewport.zoom),
      zoom: viewport.zoom,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setIsDragging(true)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    const scaleX = HAZARD_MAP_WIDTH / Math.max(1, rect.width)
    const scaleY = HAZARD_MAP_HEIGHT / Math.max(1, rect.height)
    setView({
      zoom: drag.zoom,
      center: {
        longitude: longitudeFromWorldX(drag.centerWorldX - (event.clientX - drag.startX) * scaleX, drag.zoom),
        latitude: latitudeFromWorldY(drag.centerWorldY - (event.clientY - drag.startY) * scaleY, drag.zoom),
      },
    })
  }

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
    setIsDragging(false)
  }

  if (!viewport) return null
  return {
    viewport,
    isDragging,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp: stopDragging,
    onPointerCancel: stopDragging,
    zoomIn: () => setZoom(viewport.zoom + 1),
    zoomOut: () => setZoom(viewport.zoom - 1),
    reset: () => fitViewport && setView({ zoom: fitViewport.zoom, center: fitViewport.center }),
  }
}

export function HazardMapNavigationControls({ navigation, baseLayer, onBaseLayerChange }: {
  navigation: HazardMapNavigation
  baseLayer: HazardMapBaseLayer
  onBaseLayerChange: (layer: HazardMapBaseLayer) => void
}) {
  return (
    <div onPointerDown={event => event.stopPropagation()} className="pointer-events-auto absolute right-3 top-3 z-30 flex flex-col overflow-hidden rounded-xl border border-white/20 bg-slate-950/75 text-white shadow-xl backdrop-blur-md">
      <div className="flex flex-col border-b border-white/10 p-1">
        {([['topographic', '地图'], ['satellite', '卫星']] as const).map(([layer, label]) => (
          <button key={layer} type="button" onClick={() => onBaseLayerChange(layer)} className={`min-w-[54px] rounded-lg px-2.5 py-1.5 text-[10px] transition-colors ${baseLayer === layer ? 'bg-cyan-300/20 text-cyan-100' : 'text-white/55 hover:bg-white/10 hover:text-white/80'}`} aria-pressed={baseLayer === layer}>{label}</button>
        ))}
      </div>
      <button type="button" onClick={navigation.zoomIn} className="flex h-8 w-full items-center justify-center text-lg text-white/80 transition-colors hover:bg-white/15" aria-label="放大地图">+</button>
      <button type="button" onClick={navigation.zoomOut} className="flex h-8 w-full items-center justify-center border-t border-white/10 text-lg text-white/80 transition-colors hover:bg-white/15" aria-label="缩小地图">−</button>
      <button type="button" onClick={navigation.reset} className="border-t border-white/10 px-2 py-1 text-[9px] text-white/65 transition-colors hover:bg-white/15" aria-label="恢复地图范围">复位</button>
    </div>
  )
}
export function HazardMapTiles({ viewport, dim = 0.22, baseLayer = 'topographic' }: { viewport: HazardMapViewport; dim?: number; baseLayer?: HazardMapBaseLayer }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#c8d8dd]">
      {viewport.tiles.map(tile => (
        <img
          key={`${baseLayer}-${tile.key}`}
          src={baseLayer === 'satellite' ? tile.satelliteHref : tile.href}
          data-fallback-src={baseLayer === 'satellite' ? tile.href : tile.fallbackHref}
          alt=""
          draggable={false}
          className="pointer-events-none absolute max-w-none select-none"
          style={{
            left: `${tile.x / HAZARD_MAP_WIDTH * 100}%`,
            top: `${tile.y / HAZARD_MAP_HEIGHT * 100}%`,
            width: `${tile.width / HAZARD_MAP_WIDTH * 100}%`,
            height: `${tile.height / HAZARD_MAP_HEIGHT * 100}%`,
          }}
          onError={event => {
            const image = event.currentTarget
            const fallback = image.dataset.fallbackSrc
            if (fallback && image.src !== fallback) {
              image.src = fallback
              return
            }
            image.style.opacity = '0'
          }}
        />
      ))}
      <div className="absolute inset-0" style={{ background: `rgba(3, 15, 32, ${dim})` }} />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_55%_42%,transparent_20%,rgba(2,8,23,.16)_100%)]" />
    </div>
  )
}

interface ProjectedWindSample extends HazardWeatherLayerSample {
  x: number
  y: number
}

export function WindParticleLayer({ samples }: { samples: ProjectedWindSample[] }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stableSamples = useMemo(() => samples.filter(sample => Number.isFinite(sample.x) && Number.isFinite(sample.y)), [samples])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || stableSamples.length === 0) return
    const context = canvas.getContext('2d')
    if (!context) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const pixelRatio = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(HAZARD_MAP_WIDTH * pixelRatio)
    canvas.height = Math.round(HAZARD_MAP_HEIGHT * pixelRatio)
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)

    const particleCount = reducedMotion ? 70 : 320
    const particles = Array.from({ length: particleCount }, (_, index) => ({
      x: (index * 137.5) % HAZARD_MAP_WIDTH,
      y: (index * 83.3 + (index % 7) * 29) % HAZARD_MAP_HEIGHT,
      age: index % 90,
      maxAge: 70 + (index % 75),
    }))

    const fieldAt = (x: number, y: number) => {
      let weightSum = 0
      let speed = 0
      let vectorX = 0
      let vectorY = 0
      stableSamples.forEach(sample => {
        const dx = sample.x - x
        const dy = sample.y - y
        const weight = 1 / (1600 + dx * dx + dy * dy)
        const radians = sample.windDirection * Math.PI / 180
        vectorX += -Math.sin(radians) * sample.windSpeed * weight
        vectorY += Math.cos(radians) * sample.windSpeed * weight
        speed += sample.windSpeed * weight
        weightSum += weight
      })
      if (weightSum <= 0) return { vx: 0, vy: 0, speed: 0 }
      return { vx: vectorX / weightSum, vy: vectorY / weightSum, speed: speed / weightSum }
    }

    const resetParticle = (particle: typeof particles[number], seed: number) => {
      particle.x = (seed * 193.7 + performance.now() * 0.017) % HAZARD_MAP_WIDTH
      particle.y = (seed * 97.1 + performance.now() * 0.011) % HAZARD_MAP_HEIGHT
      particle.age = 0
      particle.maxAge = 65 + seed % 85
    }

    let frame = 0
    let lastFrameTime = 0
    let animationFrame = 0
    const frameInterval = 33 // ~30fps，降低连续绘制的 CPU 占用

    const draw = (timestamp = 0) => {
      if (!reducedMotion && timestamp - lastFrameTime < frameInterval) {
        animationFrame = window.requestAnimationFrame(draw)
        return
      }
      if (!reducedMotion) lastFrameTime = timestamp

      context.globalCompositeOperation = 'destination-in'
      context.fillStyle = reducedMotion ? 'rgba(0,0,0,.80)' : 'rgba(0,0,0,.95)'
      context.fillRect(0, 0, HAZARD_MAP_WIDTH, HAZARD_MAP_HEIGHT)
      context.globalCompositeOperation = 'source-over'
      context.lineCap = 'round'
      particles.forEach((particle, index) => {
        const field = fieldAt(particle.x, particle.y)
        const velocityScale = reducedMotion ? 0.12 : 0.31
        const nextX = particle.x + field.vx * velocityScale
        const nextY = particle.y + field.vy * velocityScale
        const normalizedSpeed = clamp(field.speed / 24, 0, 1)
        const hue = 194 - normalizedSpeed * 56
        context.beginPath()
        context.moveTo(particle.x, particle.y)
        context.lineTo(nextX, nextY)
        context.strokeStyle = `hsla(${hue}, 92%, ${72 - normalizedSpeed * 10}%, ${0.32 + normalizedSpeed * 0.5})`
        context.lineWidth = 0.75 + normalizedSpeed * 1.25
        context.stroke()
        particle.x = nextX
        particle.y = nextY
        particle.age += 1
        if (particle.age > particle.maxAge || nextX < -20 || nextX > HAZARD_MAP_WIDTH + 20 || nextY < -20 || nextY > HAZARD_MAP_HEIGHT + 20 || field.speed < 0.2) {
          resetParticle(particle, index + frame)
        }
      })
      frame += 1
      if (!reducedMotion) animationFrame = window.requestAnimationFrame(draw)
    }

    draw()
    return () => window.cancelAnimationFrame(animationFrame)
  }, [stableSamples])

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full mix-blend-screen" aria-hidden="true" />
}

export function EarthquakeSourceMap({ event, currentLocation }: {
  event: EarthquakeEvent
  currentLocation?: { latitude: number; longitude: number } | null
}) {
  const [baseLayer, setBaseLayer] = useState<HazardMapBaseLayer>('topographic')
  const bounds = useMemo(() => {
    const includeCurrent = currentLocation && Math.abs(currentLocation.longitude - event.longitude) < 28 && Math.abs(currentLocation.latitude - event.latitude) < 20
    const longitudes = includeCurrent ? [event.longitude, currentLocation.longitude] : [event.longitude]
    const latitudes = includeCurrent ? [event.latitude, currentLocation.latitude] : [event.latitude]
    const centerLongitude = longitudes.reduce((sum, value) => sum + value, 0) / longitudes.length
    const centerLatitude = latitudes.reduce((sum, value) => sum + value, 0) / latitudes.length
    const longitudeSpan = clamp(Math.max(...longitudes) - Math.min(...longitudes) + 9, 12, 28)
    const latitudeSpan = clamp(Math.max(...latitudes) - Math.min(...latitudes) + 7, 9, 20)
    return {
      minLongitude: centerLongitude - longitudeSpan / 2,
      maxLongitude: centerLongitude + longitudeSpan / 2,
      minLatitude: clamp(centerLatitude - latitudeSpan / 2, -80, 80),
      maxLatitude: clamp(centerLatitude + latitudeSpan / 2, -80, 80),
    }
  }, [currentLocation?.latitude, currentLocation?.longitude, event.id, event.latitude, event.longitude])
  const navigation = useHazardMapNavigation(bounds)
  if (!navigation) return <div className="aspect-[960/500] rounded-[22px] border border-white/10 bg-[#17314a]" />

  const { viewport } = navigation
  const epicenterX = viewport.x(event.longitude)
  const epicenterY = viewport.y(event.latitude)
  const currentX = currentLocation ? viewport.x(currentLocation.longitude) : Number.NaN
  const currentY = currentLocation ? viewport.y(currentLocation.latitude) : Number.NaN
  const showsCurrent = Number.isFinite(currentX) && Number.isFinite(currentY) && currentX > 0 && currentX < HAZARD_MAP_WIDTH && currentY > 0 && currentY < HAZARD_MAP_HEIGHT

  return (
    <div
      className={`relative aspect-[960/500] overflow-hidden rounded-[22px] border border-white/10 bg-[#17314a] ${navigation.isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
      style={{ touchAction: 'none' }}
      onWheel={navigation.onWheel}
      onPointerDown={navigation.onPointerDown}
      onPointerMove={navigation.onPointerMove}
      onPointerUp={navigation.onPointerUp}
      onPointerCancel={navigation.onPointerCancel}
    >
      <HazardMapTiles viewport={viewport} dim={baseLayer === 'satellite' ? 0.045 : 0.08} baseLayer={baseLayer} />
      <HazardMapNavigationControls navigation={navigation} baseLayer={baseLayer} onBaseLayerChange={setBaseLayer} />
      <svg viewBox={`0 0 ${HAZARD_MAP_WIDTH} ${HAZARD_MAP_HEIGHT}`} className="pointer-events-none absolute inset-0 h-full w-full" role="img" aria-label={`${event.location}震源地图`}>
        <defs>
          <radialGradient id={`quake-glow-${event.id}`}>
            <stop offset="0" stopColor="#fff" stopOpacity=".92" />
            <stop offset=".18" stopColor="#fb7185" stopOpacity=".8" />
            <stop offset="1" stopColor="#e11d48" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx={epicenterX} cy={epicenterY} r="72" fill={`url(#quake-glow-${event.id})`} opacity=".55" />
        {[28, 50, 76].map((radius, index) => <circle key={radius} cx={epicenterX} cy={epicenterY} r={radius} fill="none" stroke="#fda4af" strokeWidth={2 - index * .35} opacity={.72 - index * .16} className="earthquake-pulse-ring" style={{ animationDelay: `${-index * .65}s` }} />)}
        <circle cx={epicenterX} cy={epicenterY} r="10" fill="#fb7185" stroke="white" strokeWidth="3" />
        <path d={`M ${epicenterX - 6} ${epicenterY} H ${epicenterX + 6} M ${epicenterX} ${epicenterY - 6} V ${epicenterY + 6}`} stroke="#fff" strokeWidth="2" />
        <text x={clamp(epicenterX + 16, 18, HAZARD_MAP_WIDTH - 220)} y={clamp(epicenterY - 15, 28, HAZARD_MAP_HEIGHT - 20)} fill="white" fontSize="15" fontWeight="700" style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,.82)', strokeWidth: 5 }}>震中 M{event.magnitude.toFixed(1)}</text>
        {showsCurrent && <g transform={`translate(${currentX} ${currentY})`}><circle r="15" fill="rgba(34,211,238,.24)" /><circle r="6" fill="#cffafe" stroke="#0e7490" strokeWidth="2" /><text x="17" y="5" fill="white" fontSize="14" fontWeight="600" style={{ paintOrder: 'stroke', stroke: 'rgba(2,6,23,.8)', strokeWidth: 4 }}>当前位置</text></g>}
      </svg>
      <div className="pointer-events-none absolute bottom-2 left-3 rounded-full bg-slate-950/62 px-2.5 py-1 text-[9px] text-white/62 backdrop-blur-md">{baseLayer === 'satellite' ? '卫星影像 · ' : ''}滚轮缩放 · 按住拖动</div>
    </div>
  )
}


