import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import L, { type Coords, type DoneCallback, type GridLayerOptions, type LatLng, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Activity,
  AirVent,
  Aperture,
  ChevronRight,
  CircleDotDashed,
  Cloud,
  CloudFog,
  CloudLightning,
  Crosshair,
  Droplets,
  Flame,
  Gauge,
  Layers3,
  LocateFixed,
  Map as MapIcon,
  Minus,
  MountainSnow,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Snowflake,
  Sparkles,
  Sun,
  Thermometer,
  Waves,
  Wind,
  X,
  type LucideIcon,
} from 'lucide-react'
import { resolveCoordinatesLocation, type WeatherSnapshot } from '../services/weatherService'
import {
  fetchWeatherMapPointValue,
  formatWeatherMapValue,
  getWeatherMapColor,
  sampleWeatherMapField,
  sampleWeatherMapWindVector,
  WEATHER_MAP_LAYER_BY_ID,
  WEATHER_MAP_LAYERS,
  type WeatherMapLayerDefinition,
  type WeatherMapLayerId,
  type WeatherMapPointValue,
} from '../services/weatherMapService'

interface WeatherMapExperienceProps {
  weather: WeatherSnapshot
  open: boolean
  onOpen: () => void
  onClose: () => void
}

const layerIcons: Record<WeatherMapLayerId, LucideIcon> = {
  wind: Wind,
  temperature: Thermometer,
  humidity: Droplets,
  cloud: Cloud,
  pressure: Gauge,
  cape: CloudLightning,
  wave: Waves,
  aurora: Sparkles,
  snow: MountainSnow,
  dewPoint: CloudFog,
  radar: Radar,
  pm25: CircleDotDashed,
  fire: Flame,
  solar: Sun,
}

const sourceLabels: Record<WeatherMapPointValue['source'], string> = {
  forecast: '逐小时预报',
  'air-quality': '空气质量预报',
  marine: '海洋预报',
  derived: '预报推算',
  estimate: '场景估计',
}

const tileXToLongitude = (x: number, zoom: number) => x / Math.pow(2, zoom) * 360 - 180
const tileYToLatitude = (y: number, zoom: number) => {
  const radians = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, zoom))))
  return radians * 180 / Math.PI
}

const longitudeToTilePixel = (longitude: number, zoom: number, tileSize: number) =>
  (longitude + 180) / 360 * Math.pow(2, zoom) * tileSize

const latitudeToTilePixel = (latitude: number, zoom: number, tileSize: number) => {
  const limitedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude))
  const radians = limitedLatitude * Math.PI / 180
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * Math.pow(2, zoom) * tileSize
}

class WeatherReferenceGridLayer extends L.GridLayer {
  createTile(coords: Coords, done: DoneCallback): HTMLElement {
    const canvas = document.createElement('canvas')
    const tileSize = this.getTileSize()
    canvas.width = tileSize.x
    canvas.height = tileSize.y
    canvas.className = 'weather-map-reference-tile'
    const context = canvas.getContext('2d')
    if (!context) {
      done(undefined, canvas)
      return canvas
    }

    window.requestAnimationFrame(() => {
      const originX = coords.x * tileSize.x
      const originY = coords.y * tileSize.y
      const project = (longitude: number, latitude: number) => ({
        x: longitudeToTilePixel(longitude, coords.z, tileSize.x) - originX,
        y: latitudeToTilePixel(latitude, coords.z, tileSize.y) - originY,
      })

      const gridStep = coords.z <= 3 ? 30 : coords.z <= 5 ? 10 : 5
      context.strokeStyle = 'rgba(49, 63, 67, .08)'
      context.lineWidth = 1
      context.setLineDash([3, 5])
      for (let longitude = -180; longitude <= 180; longitude += gridStep) {
        const top = project(longitude, 85)
        const bottom = project(longitude, -85)
        if (top.x < -2 || top.x > tileSize.x + 2) continue
        context.beginPath()
        context.moveTo(top.x, top.y)
        context.lineTo(bottom.x, bottom.y)
        context.stroke()
      }
      for (let latitude = -80; latitude <= 80; latitude += gridStep) {
        const left = project(-180, latitude)
        const right = project(180, latitude)
        if (left.y < -2 || left.y > tileSize.y + 2) continue
        context.beginPath()
        context.moveTo(left.x, left.y)
        context.lineTo(right.x, right.y)
        context.stroke()
      }

      context.setLineDash([])

      // Administrative boundaries and place names come from the real basemap.

      done(undefined, canvas)
    })
    return canvas
  }
}

const WEATHER_FIELD_TILE_CACHE_LIMIT = 900
const weatherFieldTileCache = new Map<string, ImageData>()

const cacheWeatherFieldTile = (key: string, image: ImageData) => {
  if (weatherFieldTileCache.has(key)) weatherFieldTileCache.delete(key)
  weatherFieldTileCache.set(key, image)
  if (weatherFieldTileCache.size > WEATHER_FIELD_TILE_CACHE_LIMIT) {
    const oldestKey = weatherFieldTileCache.keys().next().value
    if (oldestKey) weatherFieldTileCache.delete(oldestKey)
  }
}

class WeatherFieldGridLayer extends L.GridLayer {
  readonly layerId: WeatherMapLayerId
  readonly hourOffset: number

  constructor(layerId: WeatherMapLayerId, hourOffset: number, options?: GridLayerOptions) {
    super(options)
    this.layerId = layerId
    this.hourOffset = hourOffset
  }

  // Keep this method synchronous (one declared argument). Leaflet uses the
  // function arity to decide whether a tile is async; calling `done` before the
  // tile is registered leaves the canvas without `leaflet-tile-loaded`, which
  // makes every weather field visually transparent.
  createTile(coords: Coords): HTMLElement {
    const canvas = document.createElement('canvas')
    const tileSize = this.getTileSize()
    canvas.width = tileSize.x
    canvas.height = tileSize.y
    canvas.className = 'weather-map-field-tile'
    const context = canvas.getContext('2d')

    if (!context) return canvas

    const sampleCanvas = document.createElement('canvas')
    const sampleSize = 14
    sampleCanvas.width = sampleSize
    sampleCanvas.height = sampleSize
    const sampleContext = sampleCanvas.getContext('2d')
    if (!sampleContext) return canvas

    const cacheKey = `${this.layerId}:${this.hourOffset}:${coords.z}:${coords.x}:${coords.y}`
    const cached = weatherFieldTileCache.get(cacheKey)
    if (cached) {
      sampleContext.putImageData(cached, 0, 0)
    } else {
      for (let y = 0; y < sampleSize; y += 1) {
        for (let x = 0; x < sampleSize; x += 1) {
          const tileX = coords.x + x / (sampleSize - 1)
          const tileY = coords.y + y / (sampleSize - 1)
          const longitude = tileXToLongitude(tileX, coords.z)
          const latitude = tileYToLatitude(tileY, coords.z)
          const value = sampleWeatherMapField(this.layerId, latitude, longitude, this.hourOffset)
          sampleContext.fillStyle = getWeatherMapColor(this.layerId, value, 1)
          sampleContext.fillRect(x, y, 1, 1)
        }
      }
      cacheWeatherFieldTile(cacheKey, sampleContext.getImageData(0, 0, sampleSize, sampleSize))
    }

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'medium'
    context.drawImage(sampleCanvas, 0, 0, tileSize.x, tileSize.y)
    return canvas
  }
}

interface WeatherWindParticle {
  x: number
  y: number
  age: number
  maxAge: number
}

interface WeatherWindGridCell {
  u: number
  v: number
  speed: number
}

class WeatherWindParticleLayer extends L.Layer {
  private mapInstance: LeafletMap | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private animationFrame = 0
  private vectorTimer = 0
  private lastFrameTime = 0
  private lastVectorHour = Number.NaN
  private hourOffset = 0
  private moving = false
  private width = 0
  private height = 0
  private columns = 0
  private rows = 0
  private particles: WeatherWindParticle[] = []
  private vectorGrid: WeatherWindGridCell[] = []
  private readonly reducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  onAdd(map: LeafletMap): this {
    this.mapInstance = map
    this.canvas = L.DomUtil.create('canvas', 'weather-map-flow-canvas') as HTMLCanvasElement
    this.context = this.canvas.getContext('2d')
    const pane = map.getPane('weatherMapWindPane') || map.getPane('overlayPane')
    pane?.appendChild(this.canvas)
    map.on('movestart zoomstart', this.handleMoveStart)
    map.on('moveend zoomend resize', this.handleMoveEnd)
    // 窗口隐藏时暂停粒子循环（rAF 后台不执行，但保留帧引用与矢量场会空耗；
    // 隐藏时主动停帧，回到可见时恢复）
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
    this.resetCanvas()
    this.restart()
    return this
  }

  onRemove(map: LeafletMap): this {
    map.off('movestart zoomstart', this.handleMoveStart)
    map.off('moveend zoomend resize', this.handleMoveEnd)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    window.cancelAnimationFrame(this.animationFrame)
    window.clearTimeout(this.vectorTimer)
    this.canvas?.remove()
    this.canvas = null
    this.context = null
    this.mapInstance = null
    this.particles = []
    this.vectorGrid = []
    return this
  }

  setHourOffset(value: number): this {
    this.hourOffset = value
    if (Math.abs(value - this.lastVectorHour) >= 0.45) this.scheduleVectorField()
    return this
  }

  private handleVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      // 停掉待执行的帧，动画循环不再自我续帧
      if (this.animationFrame !== 0) {
        window.cancelAnimationFrame(this.animationFrame)
        this.animationFrame = 0
      }
      return
    }
    // 回到可见：校验画布/矢量场/移动状态后恢复循环
    this.restart()
  }

  private handleMoveStart = () => {
    this.moving = true
    if (this.canvas) this.canvas.style.opacity = '.34'
  }

  private handleMoveEnd = () => {
    this.moving = false
    if (this.canvas) this.canvas.style.opacity = '1'
    this.resetCanvas()
  }

  private resetCanvas = () => {
    const map = this.mapInstance
    const canvas = this.canvas
    const context = this.context
    if (!map || !canvas || !context) return
    const size = map.getSize()
    this.width = Math.max(1, size.x)
    this.height = Math.max(1, size.y)
    const pixelRatio = 1
    canvas.width = Math.round(this.width * pixelRatio)
    canvas.height = Math.round(this.height * pixelRatio)
    canvas.style.width = `${this.width}px`
    canvas.style.height = `${this.height}px`
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    context.clearRect(0, 0, this.width, this.height)
    const areaFactor = Math.min(1.35, Math.max(.72, this.width * this.height / 1_050_000))
    const count = Math.round((this.reducedMotion ? 70 : 240) * areaFactor)
    this.particles = Array.from({ length: count }, (_, index) => this.createParticle(index))
    this.rebuildVectorField()
  }

  private createParticle = (seed: number): WeatherWindParticle => ({
    x: (seed * 137.508 + Math.random() * 47) % Math.max(1, this.width),
    y: (seed * 83.173 + Math.random() * 61) % Math.max(1, this.height),
    age: seed % 80,
    maxAge: 64 + seed % 72,
  })

  private resetParticle = (particle: WeatherWindParticle, seed: number) => {
    const replacement = this.createParticle(seed + Math.floor(Math.random() * 997))
    particle.x = replacement.x
    particle.y = replacement.y
    particle.age = 0
    particle.maxAge = replacement.maxAge
  }

  private scheduleVectorField = () => {
    if (this.moving || this.vectorTimer) return
    this.vectorTimer = window.setTimeout(() => {
      this.vectorTimer = 0
      this.rebuildVectorField()
    }, 230)
  }

  private rebuildVectorField = () => {
    const map = this.mapInstance
    if (!map || this.width <= 0 || this.height <= 0) return
    const spacing = this.reducedMotion ? 72 : 54
    this.columns = Math.ceil(this.width / spacing) + 1
    this.rows = Math.ceil(this.height / spacing) + 1
    const grid: WeatherWindGridCell[] = []
    for (let row = 0; row < this.rows; row += 1) {
      const y = row / Math.max(1, this.rows - 1) * this.height
      for (let column = 0; column < this.columns; column += 1) {
        const x = column / Math.max(1, this.columns - 1) * this.width
        const latLng = map.containerPointToLatLng([x, y])
        const vector = sampleWeatherMapWindVector(latLng.lat, latLng.lng, this.hourOffset)
        grid.push({ u: vector.u, v: vector.v, speed: vector.speed })
      }
    }
    this.vectorGrid = grid
    this.lastVectorHour = this.hourOffset
    this.restart()
  }

  // 在画布/网格就绪且未移动时重启粒子循环（空闲时 animate 会自行停止；
  // 窗口隐藏时不启动，避免后台空转）
  private restart = () => {
    if (this.animationFrame !== 0) return
    if (document.visibilityState === 'hidden') return
    if (this.moving || !this.canvas || !this.context || this.vectorGrid.length === 0) return
    this.animationFrame = window.requestAnimationFrame(this.animate)
  }

  private fieldAt = (x: number, y: number): WeatherWindGridCell => {
    if (this.vectorGrid.length === 0 || this.columns < 2 || this.rows < 2) return { u: 0, v: 0, speed: 0 }
    const gx = Math.max(0, Math.min(this.columns - 1.001, x / Math.max(1, this.width) * (this.columns - 1)))
    const gy = Math.max(0, Math.min(this.rows - 1.001, y / Math.max(1, this.height) * (this.rows - 1)))
    const left = Math.floor(gx)
    const top = Math.floor(gy)
    const right = Math.min(this.columns - 1, left + 1)
    const bottom = Math.min(this.rows - 1, top + 1)
    const tx = gx - left
    const ty = gy - top
    const sample = (column: number, row: number) => this.vectorGrid[row * this.columns + column]
    const topLeft = sample(left, top)
    const topRight = sample(right, top)
    const bottomLeft = sample(left, bottom)
    const bottomRight = sample(right, bottom)
    const interpolate = (key: keyof WeatherWindGridCell) => {
      const topValue = topLeft[key] * (1 - tx) + topRight[key] * tx
      const bottomValue = bottomLeft[key] * (1 - tx) + bottomRight[key] * tx
      return topValue * (1 - ty) + bottomValue * ty
    }
    return { u: interpolate('u'), v: interpolate('v'), speed: interpolate('speed') }
  }

  private animate = (timestamp: number) => {
    // 空闲/移动/无数据/窗口隐藏时停止循环，避免空转；由 rebuildVectorField 触发 restart 重新开始
    if (this.moving || document.visibilityState === 'hidden' || !this.context || !this.canvas || this.vectorGrid.length === 0) {
      this.animationFrame = 0
      return
    }
    const frameInterval = this.reducedMotion ? 120 : 32
    if (timestamp - this.lastFrameTime < frameInterval) {
      this.animationFrame = window.requestAnimationFrame(this.animate)
      return
    }
    this.lastFrameTime = timestamp
    const context = this.context
    context.globalCompositeOperation = 'destination-in'
    context.fillStyle = this.reducedMotion ? 'rgba(0,0,0,.76)' : 'rgba(0,0,0,.925)'
    context.fillRect(0, 0, this.width, this.height)
    context.globalCompositeOperation = 'source-over'
    context.lineCap = 'round'

    this.particles.forEach((particle, index) => {
      const field = this.fieldAt(particle.x, particle.y)
      const magnitude = Math.hypot(field.u, field.v)
      if (magnitude < .05) {
        this.resetParticle(particle, index + Math.round(timestamp))
        return
      }
      const speedRatio = Math.min(1, field.speed / 72)
      const distance = .55 + speedRatio * 2.05
      const nextX = particle.x + field.u / magnitude * distance
      const nextY = particle.y - field.v / magnitude * distance
      context.beginPath()
      context.moveTo(particle.x, particle.y)
      context.lineTo(nextX, nextY)
      const hue = 208 - speedRatio * 42
      context.strokeStyle = `hsla(${hue}, 92%, ${40 + speedRatio * 18}%, ${.42 + speedRatio * .43})`
      context.lineWidth = .72 + speedRatio * 1.08
      context.stroke()
      particle.x = nextX
      particle.y = nextY
      particle.age += 1
      if (particle.age > particle.maxAge || nextX < -12 || nextX > this.width + 12 || nextY < -12 || nextY > this.height + 12) {
        this.resetParticle(particle, index + Math.round(timestamp))
      }
    })

    this.animationFrame = window.requestAnimationFrame(this.animate)
  }
}

interface IsobarPoint {
  x: number
  y: number
}

interface IsobarSegment {
  level: number
  from: IsobarPoint
  to: IsobarPoint
}

class WeatherIsobarLayer extends L.Layer {
  private mapInstance: LeafletMap | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private drawTimer = 0
  private hourOffset = 0
  private lastDrawHour = Number.NaN
  private moving = false
  private width = 0
  private height = 0

  onAdd(map: LeafletMap): this {
    this.mapInstance = map
    this.canvas = L.DomUtil.create('canvas', 'weather-map-isobar-canvas') as HTMLCanvasElement
    this.context = this.canvas.getContext('2d')
    const pane = map.getPane('weatherMapIsobarPane') || map.getPane('overlayPane')
    pane?.appendChild(this.canvas)
    map.on('movestart zoomstart', this.handleMoveStart)
    map.on('moveend zoomend resize', this.handleMoveEnd)
    this.resetCanvas()
    return this
  }

  onRemove(map: LeafletMap): this {
    map.off('movestart zoomstart', this.handleMoveStart)
    map.off('moveend zoomend resize', this.handleMoveEnd)
    window.clearTimeout(this.drawTimer)
    this.canvas?.remove()
    this.canvas = null
    this.context = null
    this.mapInstance = null
    return this
  }

  setHourOffset(value: number): this {
    this.hourOffset = value
    if (Math.abs(value - this.lastDrawHour) >= .75) this.scheduleDraw()
    return this
  }

  private handleMoveStart = () => {
    this.moving = true
    if (this.canvas) this.canvas.style.opacity = '.68'
  }

  private handleMoveEnd = () => {
    this.moving = false
    if (this.canvas) this.canvas.style.opacity = '1'
    this.resetCanvas()
  }

  private resetCanvas = () => {
    const map = this.mapInstance
    const canvas = this.canvas
    const context = this.context
    if (!map || !canvas || !context) return
    const size = map.getSize()
    this.width = Math.max(1, size.x)
    this.height = Math.max(1, size.y)
    const pixelRatio = Math.min(1.15, window.devicePixelRatio || 1)
    canvas.width = Math.round(this.width * pixelRatio)
    canvas.height = Math.round(this.height * pixelRatio)
    canvas.style.width = `${this.width}px`
    canvas.style.height = `${this.height}px`
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]))
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    this.draw()
  }

  private scheduleDraw = () => {
    if (this.moving || this.drawTimer) return
    this.drawTimer = window.setTimeout(() => {
      this.drawTimer = 0
      this.draw()
    }, 280)
  }

  private draw = () => {
    const map = this.mapInstance
    const context = this.context
    if (!map || !context || this.moving || this.width <= 0 || this.height <= 0) return
    context.clearRect(0, 0, this.width, this.height)
    const spacing = this.width > 1500 ? 34 : 30
    const columns = Math.ceil(this.width / spacing) + 1
    const rows = Math.ceil(this.height / spacing) + 1
    const values: number[][] = []
    let minimum = Number.POSITIVE_INFINITY
    let maximum = Number.NEGATIVE_INFINITY
    for (let row = 0; row < rows; row += 1) {
      const rowValues: number[] = []
      const y = row / Math.max(1, rows - 1) * this.height
      for (let column = 0; column < columns; column += 1) {
        const x = column / Math.max(1, columns - 1) * this.width
        const latLng = map.containerPointToLatLng([x, y])
        const value = sampleWeatherMapField('pressure', latLng.lat, latLng.lng, this.hourOffset)
        rowValues.push(value)
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
      values.push(rowValues)
    }

    const segments: IsobarSegment[] = []
    const firstLevel = Math.ceil(minimum / 4) * 4
    const lastLevel = Math.floor(maximum / 4) * 4
    const pointOnEdge = (edge: number, level: number, column: number, row: number, corners: number[]): IsobarPoint => {
      const cellWidth = this.width / Math.max(1, columns - 1)
      const cellHeight = this.height / Math.max(1, rows - 1)
      const interpolate = (a: number, b: number) => Math.max(0, Math.min(1, (level - a) / ((b - a) || 1)))
      if (edge === 0) return { x: (column + interpolate(corners[0], corners[1])) * cellWidth, y: row * cellHeight }
      if (edge === 1) return { x: (column + 1) * cellWidth, y: (row + interpolate(corners[1], corners[2])) * cellHeight }
      if (edge === 2) return { x: (column + interpolate(corners[3], corners[2])) * cellWidth, y: (row + 1) * cellHeight }
      return { x: column * cellWidth, y: (row + interpolate(corners[0], corners[3])) * cellHeight }
    }

    for (let level = firstLevel; level <= lastLevel; level += 4) {
      for (let row = 0; row < rows - 1; row += 1) {
        for (let column = 0; column < columns - 1; column += 1) {
          const corners = [values[row][column], values[row][column + 1], values[row + 1][column + 1], values[row + 1][column]]
          const edgePairs: Array<[number, number]> = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[3], corners[2]], [corners[0], corners[3]]]
          const crossings = edgePairs
            .map(([a, b], edge) => ((a < level && b >= level) || (a >= level && b < level)) ? edge : -1)
            .filter(edge => edge >= 0)
          if (crossings.length === 2) {
            segments.push({ level, from: pointOnEdge(crossings[0], level, column, row, corners), to: pointOnEdge(crossings[1], level, column, row, corners) })
          } else if (crossings.length === 4) {
            const center = corners.reduce((sum, value) => sum + value, 0) / 4
            const pairs = center >= level ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]]
            pairs.forEach(([fromEdge, toEdge]) => segments.push({
              level,
              from: pointOnEdge(fromEdge, level, column, row, corners),
              to: pointOnEdge(toEdge, level, column, row, corners),
            }))
          }
        }
      }
    }

    const strokeSegments = () => {
      context.beginPath()
      segments.forEach(segment => {
        context.moveTo(segment.from.x, segment.from.y)
        context.lineTo(segment.to.x, segment.to.y)
      })
      context.stroke()
    }
    context.save()
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 3
    context.strokeStyle = 'rgba(15,23,42,.34)'
    strokeSegments()
    context.lineWidth = 1.25
    context.strokeStyle = 'rgba(255,255,255,.94)'
    strokeSegments()
    context.restore()

    const occupied: IsobarPoint[] = []
    const visibleLevels = Array.from(new Set(segments.map(segment => segment.level)))
    context.font = '600 10px Inter, system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    visibleLevels.forEach((level, levelIndex) => {
      const levelSegments = segments.filter(segment => segment.level === level)
      if (levelSegments.length === 0) return
      const targets = this.width > 1100 ? [.28, .68] : [.5]
      targets.forEach((target, targetIndex) => {
        let best: IsobarSegment | null = null
        let bestScore = Number.POSITIVE_INFINITY
        for (const [index, segment] of levelSegments.entries()) {
          const midpoint = { x: (segment.from.x + segment.to.x) / 2, y: (segment.from.y + segment.to.y) / 2 }
          if (midpoint.y < 38 || midpoint.y > this.height - 80) continue
          const score = Math.abs(midpoint.x / this.width - target) + Math.abs(midpoint.y / this.height - ((levelIndex * .17 + targetIndex * .31) % .72 + .14)) * .35 + index * .00001
          if (score < bestScore && occupied.every(point => Math.hypot(point.x - midpoint.x, point.y - midpoint.y) > 82)) {
            best = segment
            bestScore = score
          }
        }
        if (!best) return
        const midpoint = { x: (best.from.x + best.to.x) / 2, y: (best.from.y + best.to.y) / 2 }
        occupied.push(midpoint)
        const label = String(level)
        const labelWidth = context.measureText(label).width + 12
        const labelHeight = 17
        const radius = 8
        context.fillStyle = 'rgba(255,255,255,.94)'
        context.beginPath()
        context.moveTo(midpoint.x - labelWidth / 2 + radius, midpoint.y - labelHeight / 2)
        context.arcTo(midpoint.x + labelWidth / 2, midpoint.y - labelHeight / 2, midpoint.x + labelWidth / 2, midpoint.y + labelHeight / 2, radius)
        context.arcTo(midpoint.x + labelWidth / 2, midpoint.y + labelHeight / 2, midpoint.x - labelWidth / 2, midpoint.y + labelHeight / 2, radius)
        context.arcTo(midpoint.x - labelWidth / 2, midpoint.y + labelHeight / 2, midpoint.x - labelWidth / 2, midpoint.y - labelHeight / 2, radius)
        context.arcTo(midpoint.x - labelWidth / 2, midpoint.y - labelHeight / 2, midpoint.x + labelWidth / 2, midpoint.y - labelHeight / 2, radius)
        context.closePath()
        context.fill()
        context.fillStyle = '#334155'
        context.fillText(label, midpoint.x, midpoint.y + .5)
      })
    })
    this.lastDrawHour = this.hourOffset
  }
}

const formatCoordinate = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`

const formatMapTime = (hourOffset: number, timezone?: string) => {
  const target = new Date(Date.now() + hourOffset * 60 * 60 * 1000)
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: timezone || undefined,
    }).format(target)
  } catch {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(target)
  }
}

const getTimeCaption = (hourOffset: number) => {
  const rounded = Math.round(hourOffset * 10) / 10
  return rounded === 0 ? '现在' : `${rounded.toFixed(1)} 小时后`
}

function WeatherMapLegend({ layer, compact = false }: { layer: WeatherMapLayerDefinition; compact?: boolean }) {
  const gradient = `linear-gradient(to top, ${layer.colors.map(stop => stop.color).join(', ')})`
  const ticks = [layer.max, layer.min + (layer.max - layer.min) * .75, layer.min + (layer.max - layer.min) * .5, layer.min + (layer.max - layer.min) * .25, layer.min]
  return (
    <div className={compact ? 'flex items-center gap-2' : 'flex items-stretch gap-2'}>
      {compact ? (
        <>
          <div className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(to right, ${layer.colors.map(stop => stop.color).join(', ')})` }} />
          <span className="text-[10px] text-white/55">{layer.unit}</span>
        </>
      ) : (
        <>
          <div className="flex h-[300px] flex-col justify-between py-1 text-right text-sm font-semibold text-white drop-shadow-md">
            {ticks.map((tick, index) => <span key={index}>{Math.round(tick)}</span>)}
            <span>{layer.unit}</span>
          </div>
          <div className="h-[300px] w-5 rounded-full border border-white/15 shadow-lg" style={{ background: gradient }} />
        </>
      )}
    </div>
  )
}

function WeatherMapPreview({ weather, onOpen }: Pick<WeatherMapExperienceProps, 'weather' | 'onOpen'>) {
  const layer = WEATHER_MAP_LAYER_BY_ID.temperature
  const currentValue = weather.current.temperature
  const previewStyle = {
    '--weather-map-preview-color': getWeatherMapColor('temperature', currentValue, .76),
  } as CSSProperties

  return (
    <button
      type="button"
      onClick={onOpen}
      className="weather-map-preview group relative mt-5 w-full overflow-hidden rounded-[30px] border border-white/10 text-left shadow-[0_20px_60px_rgba(5,15,30,.16)]"
      style={previewStyle}
    >
      <div className="weather-map-preview-base absolute inset-0" />
      <div className="weather-map-preview-field absolute inset-0" />
      <svg className="absolute inset-0 h-full w-full opacity-70" viewBox="0 0 1000 260" preserveAspectRatio="none" aria-hidden="true">
        <g fill="none" stroke="rgba(28,47,60,.5)" strokeWidth="2">
          <path d="M-40 65 C90 20 150 92 270 58 S470 22 550 70 S760 112 1040 42" />
          <path d="M15 250 C130 172 215 226 314 164 S480 140 585 205 S810 246 1012 150" />
          <path d="M118 -15 C165 58 140 118 207 171 S285 220 255 290" />
          <path d="M520 -20 C482 54 545 88 514 148 S548 220 620 280" />
          <path d="M807 -20 C742 45 790 107 758 158 S792 225 880 280" />
        </g>
        <g fill="rgba(255,255,255,.82)" fontSize="17" fontWeight="600">
          <text x="95" y="74">{weather.location.province || '区域'}</text>
          <text x="335" y="132">{weather.location.city || weather.location.name}</text>
          <text x="615" y="88">{weather.location.district || '周边地区'}</text>
          <text x="790" y="195">未来 48h</text>
        </g>
      </svg>
      <div className="relative flex min-h-[220px] flex-col justify-between p-6">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white/72"><MapIcon className="h-4 w-4" />天气地图</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">查看专业气象图层</div>
            <div className="mt-1 text-sm text-white/62">温度、风、湿度、云量、气压与更多模式</div>
          </div>
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/18 bg-black/18 transition-transform group-hover:translate-x-1 group-hover:bg-black/28">
            <ChevronRight className="h-5 w-5" />
          </span>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="rounded-2xl border border-white/15 bg-black/18 px-4 py-3 backdrop-blur-xl">
            <div className="text-[11px] text-white/48">当前位置温度</div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{Math.round(currentValue)}°C</div>
          </div>
          <div className="rounded-full border border-white/14 bg-black/16 px-4 py-2 backdrop-blur-xl"><WeatherMapLegend layer={layer} compact /></div>
        </div>
      </div>
    </button>
  )
}

function LayerButton({ layer, active, onClick }: { layer: WeatherMapLayerDefinition; active: boolean; onClick: () => void }) {
  const Icon = layerIcons[layer.id]
  return (
    <button
      type="button"
      onClick={onClick}
      title={layer.description}
      className="weather-map-layer-button group flex min-w-0 items-center gap-2 rounded-2xl px-2 py-2 text-left transition-colors"
      data-active={active ? 'true' : 'false'}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-700/90 text-white transition-colors group-hover:bg-slate-600" data-icon-active={active ? 'true' : 'false'}>
        <Icon className="h-[18px] w-[18px]" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-slate-800">{layer.label}</span>
        <span className="mt-0.5 block truncate text-[9px] text-slate-500">{layer.shortLabel}</span>
      </span>
    </button>
  )
}

interface WeatherFieldLayerPair {
  layerId: WeatherMapLayerId | null
  currentHour: number
  nextHour: number
  current: WeatherFieldGridLayer | null
  next: WeatherFieldGridLayer | null
}

const getWeatherFieldOpacity = (layerId: WeatherMapLayerId) => layerId === 'cloud' ? .62 : .78

function WeatherMapModal({ weather, open, onClose }: Pick<WeatherMapExperienceProps, 'weather' | 'open' | 'onClose'>) {
  const mapElementRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const popupCardRef = useRef<HTMLDivElement | null>(null)
  const popupFrameRef = useRef(0)
  const timelineInputRef = useRef<HTMLInputElement | null>(null)
  const timelineTimeLabelRef = useRef<HTMLSpanElement | null>(null)
  const timelineOffsetLabelRef = useRef<HTMLSpanElement | null>(null)
  const currentLocationMarkerRef = useRef<L.CircleMarker | null>(null)
  const currentLocationHaloRef = useRef<L.CircleMarker | null>(null)
  const selectedMarkerRef = useRef<L.CircleMarker | null>(null)
  const placeLookupControllerRef = useRef<AbortController | null>(null)
  const windLayerRef = useRef<WeatherWindParticleLayer | null>(null)
  const isobarLayerRef = useRef<WeatherIsobarLayer | null>(null)
  const fieldLayersRef = useRef<WeatherFieldLayerPair>({
    layerId: null,
    currentHour: -1,
    nextHour: -1,
    current: null,
    next: null,
  })
  const selectedPointRef = useRef<LatLng | null>(null)
  const activeLayerIdRef = useRef<WeatherMapLayerId>('temperature')
  const hourOffsetRef = useRef(0)
  const locationRef = useRef({ latitude: weather.location.latitude, longitude: weather.location.longitude })
  const timezoneRef = useRef(weather.timezone)
  const [activeLayerId, setActiveLayerId] = useState<WeatherMapLayerId>('temperature')
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [hourOffset, setHourOffset] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [windWaves, setWindWaves] = useState(false)
  const [isobars, setIsobars] = useState(false)
  const [selectedPoint, setSelectedPoint] = useState<LatLng | null>(null)
  const [selectedPlaceName, setSelectedPlaceName] = useState<string | null>(null)
  const [pointValue, setPointValue] = useState<WeatherMapPointValue | null>(null)
  const [pointLoading, setPointLoading] = useState(false)
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number } | null>(null)
  const activeLayer = WEATHER_MAP_LAYER_BY_ID[activeLayerId]

  activeLayerIdRef.current = activeLayerId
  selectedPointRef.current = selectedPoint
  locationRef.current = { latitude: weather.location.latitude, longitude: weather.location.longitude }
  timezoneRef.current = weather.timezone

  const updatePopupPosition = useCallback(() => {
    if (popupFrameRef.current) return
    popupFrameRef.current = window.requestAnimationFrame(() => {
      popupFrameRef.current = 0
      const map = mapRef.current
      const selected = selectedPointRef.current
      if (!map || !selected) return
      const point = map.latLngToContainerPoint(selected)
      if (popupCardRef.current) {
        popupCardRef.current.style.left = `${point.x}px`
        popupCardRef.current.style.top = `${point.y}px`
      } else {
        setPopupPosition({ x: point.x, y: point.y })
      }
    })
  }, [])

  const clearFieldLayers = useCallback(() => {
    const map = mapRef.current
    const pair = fieldLayersRef.current
    if (map && pair.current && map.hasLayer(pair.current)) map.removeLayer(pair.current)
    if (map && pair.next && map.hasLayer(pair.next)) map.removeLayer(pair.next)
    fieldLayersRef.current = { layerId: null, currentHour: -1, nextHour: -1, current: null, next: null }
  }, [])

  const createFieldLayer = useCallback((layerId: WeatherMapLayerId, forecastHour: number, opacity: number) => {
    const map = mapRef.current
    if (!map) return null
    const layer = new WeatherFieldGridLayer(layerId, forecastHour, {
      tileSize: 256,
      opacity,
      pane: 'weatherMapFieldPane',
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    })
    layer.addTo(map)
    layer.getContainer()?.classList.add('weather-map-field-layer')
    return layer
  }, [])

  const syncFieldLayers = useCallback((value: number, force = false) => {
    const map = mapRef.current
    if (!map) return
    const layerId = activeLayerIdRef.current
    const bounded = Math.max(0, Math.min(48, value))
    const currentHour = Math.min(48, Math.floor(bounded))
    const nextHour = Math.min(48, currentHour + 1)
    const baseOpacity = getWeatherFieldOpacity(layerId)
    let pair = fieldLayersRef.current

    if (force || pair.layerId !== layerId || pair.currentHour !== currentHour) {
      const canPromote = !force
        && pair.layerId === layerId
        && pair.nextHour === currentHour
        && pair.next !== null

      if (canPromote) {
        if (pair.current && map.hasLayer(pair.current)) map.removeLayer(pair.current)
        pair.current = pair.next
        pair.currentHour = currentHour
        pair.next = null
        pair.nextHour = nextHour
      } else {
        clearFieldLayers()
        pair = fieldLayersRef.current
        pair.layerId = layerId
        pair.currentHour = currentHour
        pair.nextHour = nextHour
        pair.current = createFieldLayer(layerId, currentHour, baseOpacity)
      }

      pair.layerId = layerId
      if (nextHour !== currentHour && !pair.next) {
        pair.nextHour = nextHour
        pair.next = createFieldLayer(layerId, nextHour, 0)
      }
      fieldLayersRef.current = pair
    }

    pair = fieldLayersRef.current
    const fraction = nextHour === currentHour ? 0 : bounded - currentHour
    // Source-over blending two semi-transparent layers with simple linear opacity
    // makes the combined field more transparent around every half-hour, which looks
    // like a flash. Keep the total alpha constant while interpolating frame colors.
    const nextOpacity = baseOpacity * fraction
    const currentOpacity = fraction <= 0
      ? baseOpacity
      : baseOpacity * (1 - fraction) / (1 - nextOpacity)
    pair.current?.setOpacity(currentOpacity)
    pair.next?.setOpacity(nextOpacity)
  }, [clearFieldLayers, createFieldLayer])

  const updateTimelineDom = useCallback((value: number) => {
    const input = timelineInputRef.current
    if (input) {
      input.value = value.toFixed(2)
      input.style.setProperty('--weather-map-progress', `${value / 48 * 100}%`)
    }
    if (timelineTimeLabelRef.current) {
      timelineTimeLabelRef.current.textContent = `${formatMapTime(value, timezoneRef.current)} · ${getTimeCaption(value)}`
    }
    if (timelineOffsetLabelRef.current) timelineOffsetLabelRef.current.textContent = `+${value.toFixed(1)}h`
  }, [])

  const applyHourOffset = useCallback((value: number) => {
    const bounded = Math.max(0, Math.min(48, value))
    hourOffsetRef.current = bounded
    syncFieldLayers(bounded)
    windLayerRef.current?.setHourOffset(bounded)
    isobarLayerRef.current?.setHourOffset(bounded)
    updateTimelineDom(bounded)
  }, [syncFieldLayers, updateTimelineDom])

  useEffect(() => {
    if (!open || !mapElementRef.current || mapRef.current) return
    const initialLocation = locationRef.current
    const map = L.map(mapElementRef.current, {
      center: [initialLocation.latitude, initialLocation.longitude],
      zoom: 6,
      minZoom: 2,
      maxZoom: 11,
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: true,
      preferCanvas: true,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      inertia: true,
      inertiaDeceleration: 3400,
      inertiaMaxSpeed: 1200,
    })
    mapRef.current = map

    const panes: Array<[string, string, boolean]> = [
      ['weatherMapBasePane', '200', false],
      ['weatherMapFieldPane', '320', false],
      ['weatherMapWindPane', '360', true],
      ['weatherMapIsobarPane', '385', true],
      ['weatherMapReferencePane', '400', true],
      ['weatherMapMarkerPane', '445', false],
    ]
    panes.forEach(([name, zIndex, pointerless]) => {
      const pane = map.createPane(name)
      pane.style.zIndex = zIndex
      if (pointerless) pane.style.pointerEvents = 'none'
    })

    const baseLayer = L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 19,
      pane: 'weatherMapBasePane',
      className: 'weather-map-base-tile',
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    }).addTo(map)
    baseLayer.on('tileerror', event => {
      const tile = event.tile as HTMLImageElement
      if (tile.dataset.weatherMapFallback === 'true') return
      tile.dataset.weatherMapFallback = 'true'
      tile.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${event.coords.z}/${event.coords.y}/${event.coords.x}`
    })

    new WeatherReferenceGridLayer({
      tileSize: 256,
      pane: 'weatherMapReferencePane',
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    }).addTo(map)

    const getPopupPosition = (latLng: LatLng) => {
      const point = map.latLngToContainerPoint(latLng)
      const size = map.getSize()
      return {
        x: Math.max(132, Math.min(size.x - 132, point.x)),
        y: Math.max(190, Math.min(size.y - 72, point.y)),
      }
    }

    const selectMapPoint = (latLng: LatLng, placeName: string | null) => {
      placeLookupControllerRef.current?.abort()
      selectedPointRef.current = latLng
      setSelectedPoint(latLng)
      setSelectedPlaceName(placeName)
      setPointValue(null)
      setPointLoading(true)
      setPopupPosition(getPopupPosition(latLng))

      if (!placeName) {
        const controller = new AbortController()
        placeLookupControllerRef.current = controller
        resolveCoordinatesLocation(latLng.lat, latLng.lng, controller.signal)
          .then(location => {
            if (controller.signal.aborted || selectedPointRef.current !== latLng) return
            const chineseName = location.district || location.city || location.name || location.region
            if (chineseName && chineseName !== '????') setSelectedPlaceName(chineseName)
          })
          .catch(error => {
            if ((error as Error).name !== 'AbortError') console.warn('[WeatherMap] Failed to resolve map place:', error)
          })
      }
    }

    const currentHalo = L.circleMarker([initialLocation.latitude, initialLocation.longitude], {
      pane: 'weatherMapMarkerPane',
      radius: 14,
      stroke: false,
      fillColor: '#4f72ff',
      fillOpacity: .18,
      interactive: false,
    }).addTo(map)
    const currentMarker = L.circleMarker([initialLocation.latitude, initialLocation.longitude], {
      pane: 'weatherMapMarkerPane',
      radius: 6.5,
      color: '#fff',
      weight: 3,
      fillColor: '#4f72ff',
      fillOpacity: 1,
      interactive: false,
    }).addTo(map)
    currentMarker.bindTooltip('当前位置', {
      permanent: true,
      direction: 'right',
      offset: [10, 0],
      className: 'weather-map-current-tooltip',
    })
    currentLocationHaloRef.current = currentHalo
    currentLocationMarkerRef.current = currentMarker

    map.on('click', event => selectMapPoint(event.latlng, null))
    map.on('move zoom resize', updatePopupPosition)
    const container = map.getContainer()
    L.DomEvent.disableScrollPropagation(container)
    window.setTimeout(() => {
      map.invalidateSize()
      syncFieldLayers(hourOffsetRef.current, true)
    }, 80)

    return () => {
      placeLookupControllerRef.current?.abort()
      placeLookupControllerRef.current = null
      window.cancelAnimationFrame(popupFrameRef.current)
      popupFrameRef.current = 0
      clearFieldLayers()
      map.off()
      map.remove()
      mapRef.current = null
      currentLocationMarkerRef.current = null
      currentLocationHaloRef.current = null
      selectedMarkerRef.current = null
      windLayerRef.current = null
      isobarLayerRef.current = null
    }
  }, [clearFieldLayers, open, syncFieldLayers, updatePopupPosition])

  useEffect(() => {
    const point: [number, number] = [weather.location.latitude, weather.location.longitude]
    currentLocationMarkerRef.current?.setLatLng(point)
    currentLocationHaloRef.current?.setLatLng(point)
  }, [weather.location.latitude, weather.location.longitude])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !open) return
    if (!selectedPoint) {
      if (selectedMarkerRef.current && map.hasLayer(selectedMarkerRef.current)) map.removeLayer(selectedMarkerRef.current)
      selectedMarkerRef.current = null
      return
    }
    if (!selectedMarkerRef.current) {
      selectedMarkerRef.current = L.circleMarker(selectedPoint, {
        pane: 'weatherMapMarkerPane',
        radius: 5,
        color: '#fff',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: .95,
        interactive: false,
      }).addTo(map)
    } else {
      selectedMarkerRef.current.setLatLng(selectedPoint)
    }
    updatePopupPosition()
  }, [open, selectedPoint, updatePopupPosition])

  useEffect(() => {
    if (!open || !mapRef.current) return
    clearFieldLayers()
    syncFieldLayers(hourOffsetRef.current, true)
  }, [activeLayerId, clearFieldLayers, open, syncFieldLayers])

  useEffect(() => {
    applyHourOffset(hourOffset)
  }, [applyHourOffset, hourOffset])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !open) return
    const shouldShow = activeLayerId === 'wind' || windWaves
    if (shouldShow && !windLayerRef.current) {
      windLayerRef.current = new WeatherWindParticleLayer().setHourOffset(hourOffsetRef.current).addTo(map)
    } else if (!shouldShow && windLayerRef.current) {
      map.removeLayer(windLayerRef.current)
      windLayerRef.current = null
    }
  }, [activeLayerId, open, windWaves])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !open) return
    if (isobars && !isobarLayerRef.current) {
      isobarLayerRef.current = new WeatherIsobarLayer().setHourOffset(hourOffsetRef.current).addTo(map)
    } else if (!isobars && isobarLayerRef.current) {
      map.removeLayer(isobarLayerRef.current)
      isobarLayerRef.current = null
    }
  }, [isobars, open])

  const pointForecastHour = Math.round(hourOffset)
  useEffect(() => {
    if (!selectedPoint || !open) return
    setPointLoading(true)
    const controller = new AbortController()
    const requestedLayer = selectedPlaceName ? 'temperature' : activeLayerId
    const timeoutId = window.setTimeout(() => {
      fetchWeatherMapPointValue(requestedLayer, selectedPoint.lat, selectedPoint.lng, pointForecastHour, controller.signal)
        .then(value => setPointValue(value))
        .catch(error => {
          if (!controller.signal.aborted) console.warn('[WeatherMap] Failed to read point forecast:', error)
        })
        .finally(() => {
          if (!controller.signal.aborted) setPointLoading(false)
        })
    }, 110)
    return () => {
      window.clearTimeout(timeoutId)
      controller.abort()
    }
  }, [activeLayerId, open, pointForecastHour, selectedPlaceName, selectedPoint])

  useEffect(() => {
    if (!playing || !open) return
    let previous = performance.now()
    let lastUiUpdate = previous
    let animationFrame = 0
    const animateTimeline = (now: number) => {
      const elapsed = Math.min(80, Math.max(0, now - previous))
      previous = now
      let next = hourOffsetRef.current + elapsed / 1000
      if (next >= 48) next %= 48
      applyHourOffset(next)
      if (now - lastUiUpdate >= 180) {
        lastUiUpdate = now
        setHourOffset(next)
      }
      animationFrame = window.requestAnimationFrame(animateTimeline)
    }
    animationFrame = window.requestAnimationFrame(animateTimeline)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      setHourOffset(hourOffsetRef.current)
    }
  }, [applyHourOffset, open, playing])

  useEffect(() => {
    if (!open) {
      setPlaying(false)
      setLayerPanelOpen(false)
      setSelectedPoint(null)
      selectedPointRef.current = null
      setSelectedPlaceName(null)
      setPointValue(null)
      setPopupPosition(null)
    }
  }, [open])

  const centerOnWeather = () => mapRef.current?.flyTo(
    [weather.location.latitude, weather.location.longitude],
    Math.max(6, mapRef.current.getZoom()),
    { duration: .65 },
  )
  const timeLabel = formatMapTime(hourOffset, weather.timezone)
  const closePoint = () => {
    selectedPointRef.current = null
    setSelectedPoint(null)
    setSelectedPlaceName(null)
    setPointValue(null)
    setPopupPosition(null)
  }
  const handleTimelineChange = (value: number) => {
    setPlaying(false)
    applyHourOffset(value)
    setHourOffset(value)
  }

  if (typeof document === 'undefined') return null
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[520] overflow-hidden bg-[#d9d7c7] text-slate-900"
          initial={{ opacity: 0, scale: .995 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: .995 }}
          transition={{ duration: .22 }}
        >
          <div ref={mapElementRef} className="absolute inset-0" />
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,.04),transparent_25%,rgba(28,35,40,.05))]" />

          <div className="absolute left-5 top-5 z-[540] md:left-6 md:top-6">
            <button
              type="button"
              onClick={() => setLayerPanelOpen(value => !value)}
              aria-expanded={layerPanelOpen}
              className="weather-map-layer-trigger flex h-11 items-center gap-2 rounded-full border border-white/55 bg-white/90 px-4 text-sm font-semibold text-slate-800 shadow-lg backdrop-blur-xl transition-colors hover:bg-white"
            >
              <Layers3 className="h-[18px] w-[18px]" />
              图层
              <ChevronRight className={`h-4 w-4 transition-transform ${layerPanelOpen ? 'rotate-90' : ''}`} />
            </button>
            <AnimatePresence>
              {layerPanelOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -8, scale: .98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: .98 }}
                  transition={{ duration: .16 }}
                  className="weather-map-layer-panel absolute left-0 top-14 w-[min(88vw,410px)] rounded-[24px] border border-white/55 bg-white/88 p-3 shadow-[0_18px_45px_rgba(15,23,42,.22)] backdrop-blur-2xl"
                >
                  <div className="mb-2.5 flex items-center justify-between px-1">
                    <div>
                      <div className="text-xs font-semibold text-slate-800">专业天气图层</div>
                      <div className="mt-0.5 text-[9px] text-slate-500">当前：{activeLayer.label}</div>
                    </div>
                    <span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-medium text-blue-600">14 种模式</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {WEATHER_MAP_LAYERS.map(layer => (
                      <LayerButton key={layer.id} layer={layer} active={layer.id === activeLayerId} onClick={() => { setActiveLayerId(layer.id); setLayerPanelOpen(false) }} />
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="absolute right-5 top-5 z-[540] md:right-7 md:top-6">
            <button type="button" onClick={onClose} title="关闭天气地图" aria-label="关闭天气地图" className="weather-map-round-control"><X className="h-5 w-5" /></button>
          </div>

          <div className="absolute bottom-24 right-4 z-[546] flex flex-col items-end gap-2 md:bottom-6 md:right-6">
            <div className="w-[148px] space-y-2 rounded-2xl border border-white/45 bg-white/88 p-2.5 shadow-lg backdrop-blur-xl">
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-slate-700">
                <span>风 / 海浪</span>
                <input type="checkbox" checked={windWaves} onChange={event => setWindWaves(event.target.checked)} className="weather-map-toggle" />
              </label>
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-slate-700">
                <span>等压线</span>
                <input type="checkbox" checked={isobars} onChange={event => setIsobars(event.target.checked)} className="weather-map-toggle" />
              </label>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={centerOnWeather} title="定位到当前位置" aria-label="定位到当前位置" className="weather-map-round-control weather-map-round-control-compact"><Crosshair className="h-[18px] w-[18px]" /></button>
              <button type="button" onClick={() => mapRef.current?.zoomIn()} title="放大" aria-label="放大地图" className="weather-map-round-control weather-map-round-control-compact"><Plus className="h-5 w-5" /></button>
              <button type="button" onClick={() => mapRef.current?.zoomOut()} title="缩小" aria-label="缩小地图" className="weather-map-round-control weather-map-round-control-compact"><Minus className="h-5 w-5" /></button>
            </div>
          </div>

          <div className="absolute right-6 top-1/2 z-[540] hidden -translate-y-1/2 md:block">
            <WeatherMapLegend layer={activeLayer} />
          </div>

          <div className="absolute left-1/2 top-5 z-[540] -translate-x-1/2 rounded-full border border-white/30 bg-white/82 px-5 py-2 text-center shadow-lg backdrop-blur-xl">
            <div className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4" />{activeLayer.label}</div>
            <div className="mt-0.5 text-[10px] text-slate-500">{activeLayer.description}</div>
          </div>

          {selectedPoint && popupPosition && (
            <div
              ref={popupCardRef}
              className="weather-map-point-card absolute z-[550] w-[240px] rounded-2xl bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,.32)]"
              style={{ left: popupPosition.x, top: popupPosition.y }}
            >
              <button type="button" onClick={closePoint} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700" aria-label="关闭数据卡片"><X className="h-4 w-4" /></button>
              {selectedPlaceName ? (
                <>
                  <div className="pr-6 text-base font-semibold text-slate-800">{selectedPlaceName}</div>
                  <div className="mt-0.5 text-[10px] text-slate-400">{formatCoordinate(selectedPoint.lat, 'N', 'S')}, {formatCoordinate(selectedPoint.lng, 'E', 'W')}</div>
                </>
              ) : (
                <div className="pr-6 text-sm text-slate-600">
                  {formatCoordinate(selectedPoint.lat, 'N', 'S')}, {formatCoordinate(selectedPoint.lng, 'E', 'W')}
                </div>
              )}
              {!pointValue ? (
                <div className="mt-3 flex items-center gap-2 text-sm text-slate-500"><RefreshCw className="h-4 w-4 animate-spin" />正在获取数据</div>
              ) : (
                <>
                  <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{formatWeatherMapValue(WEATHER_MAP_LAYER_BY_ID[pointValue.layer], pointValue.value)}</div>
                  <div className="mt-1 text-sm text-slate-600">{pointValue.label} · {getTimeCaption(pointValue.hourOffset)}</div>
                  {pointValue.secondary && <div className="mt-2 text-xs leading-5 text-slate-500">{pointValue.secondary}</div>}
                  <div className="mt-2 flex items-center gap-1.5 text-[10px] text-slate-400">
                    <span>{sourceLabels[pointValue.source]}</span>
                    {pointLoading && <><span>·</span><RefreshCw className="h-3 w-3 animate-spin" /><span>更新中</span></>}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="absolute bottom-4 left-1/2 z-[545] w-[calc(100vw-24px)] -translate-x-1/2 md:bottom-5 md:w-[min(52vw,690px)] md:min-w-[500px]">
            <div className="rounded-[18px] border border-white/40 bg-white/80 px-3 py-2 shadow-[0_12px_28px_rgba(15,23,42,.16)] backdrop-blur-2xl">
              <div className="mb-0.5 flex items-center justify-between px-1 text-[10px] font-medium text-slate-600">
                <span ref={timelineTimeLabelRef}>{timeLabel} · {getTimeCaption(hourOffset)}</span>
                <span className="tabular-nums">未来 48 小时</span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setPlaying(value => !value)}
                  title={playing ? '暂停 48 小时预览' : '播放未来 48 小时'}
                  aria-label={playing ? '暂停天气动画' : '播放天气动画'}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-600 text-white shadow-md transition-transform hover:scale-105"
                >
                  {playing ? <Pause className="h-3.5 w-3.5 fill-current" /> : <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />}
                </button>
                <input
                  ref={timelineInputRef}
                  type="range"
                  min="0"
                  max="48"
                  step="0.05"
                  defaultValue={hourOffset}
                  onInput={event => handleTimelineChange(Number(event.currentTarget.value))}
                  className="weather-map-timeline min-w-0 flex-1"
                  style={{ '--weather-map-progress': `${hourOffset / 48 * 100}%` } as CSSProperties}
                  aria-label="未来 48 小时天气预览"
                />
                <span ref={timelineOffsetLabelRef} className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-800">+{hourOffset.toFixed(1)}h</span>
              </div>
            </div>
          </div>

        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

export default function WeatherMapExperience({ weather, open, onOpen, onClose }: WeatherMapExperienceProps) {
  return (
    <>
      <WeatherMapPreview weather={weather} onOpen={onOpen} />
      <WeatherMapModal weather={weather} open={open} onClose={onClose} />
    </>
  )
}




