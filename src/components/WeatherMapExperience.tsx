import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useModeParked } from '../utils/modeLayer'
import { AnimatePresence, motion } from 'framer-motion'
import L, { type Coords, type DoneCallback, type GridLayerOptions, type LatLng, type Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
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
  Map as MapIcon,
  Minus,
  MountainSnow,
  Pause,
  Play,
  Plus,
  Radar,
  RefreshCw,
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
  getWeatherGridFramePair,
  getWeatherMapColor,
  interpolateWeatherGridFrame,
  loadWeatherGrid,
  sampleWeatherGridScalar,
  sampleWeatherGridWindVector,
  sampleWeatherMapField,
  sampleWeatherMapWindVector,
  WEATHER_MAP_LAYER_BY_ID,
  WEATHER_MAP_LAYERS,
  type WeatherGrid,
  type WeatherGridField,
  type WeatherGridFrame,
  type WeatherGridFramePair,
  type WeatherMapLayerDefinition,
  type WeatherMapLayerId,
  type WeatherMapPointValue,
} from '../services/weatherMapService'
import {
  smoothWeatherContourPath,
  stitchWeatherContourSegments,
  weatherContourPathLength,
  weatherContourPointAt,
  advanceWeatherMapPlayback,
} from '../services/weatherMapRendering'

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

const WEATHER_GRID_FIELD_BY_LAYER: Partial<Record<WeatherMapLayerId, WeatherGridField>> = {
  wind: 'wind_speed_10m',
  temperature: 'temperature_2m',
  humidity: 'relative_humidity_2m',
  cloud: 'cloud_cover',
  pressure: 'surface_pressure',
  radar: 'precipitation',
}

const isInsideWeatherGrid = (frame: WeatherGridFrame, latitude: number, longitude: number) => {
  const longitudeSpan = ((frame.bounds.east - frame.bounds.west) % 360 + 360) % 360
  const longitudeOffset = ((longitude - frame.bounds.west) % 360 + 360) % 360
  return latitude >= frame.bounds.south && latitude <= frame.bounds.north && longitudeOffset <= longitudeSpan
}

const sampleGridLayerValue = (layerId: WeatherMapLayerId, frame: WeatherGridFrame, latitude: number, longitude: number) => {
  const field = WEATHER_GRID_FIELD_BY_LAYER[layerId]
  if (!field || !isInsideWeatherGrid(frame, latitude, longitude)) return null
  const value = sampleWeatherGridScalar(frame, field, latitude, longitude)
  if (layerId === 'radar') return value <= 0 ? 0 : Math.max(0, Math.min(70, 10 * Math.log10(200 * Math.pow(value, 1.6))))
  return value
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
  readonly frame: WeatherGridFrame | null

  constructor(layerId: WeatherMapLayerId, hourOffset: number, frame: WeatherGridFrame | null, options?: GridLayerOptions) {
    super(options)
    this.layerId = layerId
    this.hourOffset = hourOffset
    this.frame = frame
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

    const frameKey = this.frame
      ? `${this.frame.timestamp}:${this.frame.bounds.north.toFixed(2)}:${this.frame.bounds.south.toFixed(2)}:${this.frame.bounds.east.toFixed(2)}:${this.frame.bounds.west.toFixed(2)}`
      : `estimate:${this.hourOffset}`
    const cacheKey = `${this.layerId}:${frameKey}:${coords.z}:${coords.x}:${coords.y}`
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
          const realValue = this.frame ? sampleGridLayerValue(this.layerId, this.frame, latitude, longitude) : null
          const value = realValue ?? sampleWeatherMapField(this.layerId, latitude, longitude, this.hourOffset)
          const alpha = this.layerId === 'radar' && value <= 0 ? 0 : 1
          sampleContext.fillStyle = getWeatherMapColor(this.layerId, value, alpha)
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
  private frame: WeatherGridFrame | null = null
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
    // addTo 前调用的 setFrame 因 mapInstance 未就绪不会重建矢量场（且引用相同时
    // setFrame 直接去重跳过），这里强制重建一次——否则粒子层挂上后一直空白，
    // 直到用户缩放/平移触发 handleMoveEnd 才突然出现。
    this.rebuildVectorField()
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

  setFrame(frame: WeatherGridFrame | null): this {
    if (this.frame === frame) return this
    this.frame = frame
    this.scheduleVectorField()
    return this
  }

  setHourOffset(value: number): this {
    this.hourOffset = value
    if (!this.frame && Math.abs(value - this.lastVectorHour) >= 0.45) this.scheduleVectorField()
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
    const pixelRatio = Math.min(1.5, window.devicePixelRatio || 1)
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
        const vector = this.frame && isInsideWeatherGrid(this.frame, latLng.lat, latLng.lng)
          ? sampleWeatherGridWindVector(this.frame, latLng.lat, latLng.lng)
          : sampleWeatherMapWindVector(latLng.lat, latLng.lng, this.hourOffset)
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
    const elapsedSeconds = this.lastFrameTime > 0 ? Math.min(.08, Math.max(.012, (timestamp - this.lastFrameTime) / 1000)) : frameInterval / 1000
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
      const displayPixelsPerSecond = 18 + field.speed * 1.55
      const distance = displayPixelsPerSecond * elapsedSeconds
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
  private frame: WeatherGridFrame | null = null
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

  setFrame(frame: WeatherGridFrame | null): this {
    if (this.frame === frame) return this
    this.frame = frame
    this.scheduleDraw()
    return this
  }

  setHourOffset(value: number): this {
    this.hourOffset = value
    if (!this.frame && Math.abs(value - this.lastDrawHour) >= .75) this.scheduleDraw()
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
        const value = this.frame && isInsideWeatherGrid(this.frame, latLng.lat, latLng.lng)
          ? sampleWeatherGridScalar(this.frame, 'surface_pressure', latLng.lat, latLng.lng)
          : sampleWeatherMapField('pressure', latLng.lat, latLng.lng, this.hourOffset)
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

    const contourPaths = stitchWeatherContourSegments(segments)
      .map(path => ({ ...path, points: smoothWeatherContourPath(path.points, path.closed, 2) }))
      .filter(path => weatherContourPathLength(path.points) >= 46)
    const strokePaths = () => {
      context.beginPath()
      contourPaths.forEach(path => {
        path.points.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y))
      })
      context.stroke()
    }
    context.save()
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.lineWidth = 3
    context.strokeStyle = 'rgba(15,23,42,.28)'
    strokePaths()
    context.lineWidth = 1.15
    context.strokeStyle = 'rgba(255,255,255,.9)'
    strokePaths()
    context.restore()

    const occupied: IsobarPoint[] = []
    const visibleLevels = Array.from(new Set(contourPaths.map(path => path.level)))
    context.font = '600 10px Inter, system-ui, sans-serif'
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    visibleLevels.forEach((level, levelIndex) => {
      const levelPaths = contourPaths.filter(path => path.level === level)
      if (levelPaths.length === 0) return
      const targets = this.width > 1100 ? [.3, .7] : [.5]
      targets.forEach((target, targetIndex) => {
        let best: { point: IsobarPoint; angle: number } | null = null
        let bestScore = Number.POSITIVE_INFINITY
        for (const [index, path] of levelPaths.entries()) {
          const candidate = weatherContourPointAt(path.points, Math.max(.18, Math.min(.82, target)))
          const midpoint = candidate.point
          if (midpoint.y < 38 || midpoint.y > this.height - 80) continue
          const score = Math.abs(midpoint.x / this.width - target) + Math.abs(midpoint.y / this.height - ((levelIndex * .17 + targetIndex * .31) % .72 + .14)) * .35 + index * .00001
          if (score < bestScore && occupied.every(point => Math.hypot(point.x - midpoint.x, point.y - midpoint.y) > 92)) {
            best = candidate
            bestScore = score
          }
        }
        if (!best) return
        const midpoint = best.point
        occupied.push(midpoint)
        const label = String(level)
        const labelWidth = context.measureText(label).width + 12
        context.save()
        context.translate(midpoint.x, midpoint.y)
        context.rotate(best.angle)
        context.fillStyle = 'rgba(255,255,255,.9)'
        context.fillRect(-labelWidth / 2, -8, labelWidth, 16)
        context.fillStyle = '#334155'
        context.fillText(label, 0, .5)
        context.restore()
      })
    })
    this.lastDrawHour = this.hourOffset
  }
}

const formatCoordinate = (value: number, positive: string, negative: string) =>
  `${Math.abs(value).toFixed(2)}°${value >= 0 ? positive : negative}`

// 时间轴播放时 updateTimelineDom 每帧都要格式化时间（约 60 次/秒），formatter 按 timeZone 缓存复用；
// 原先每帧 new 一个 Intl.DateTimeFormat——构造本身比 format 还贵。
const mapTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const invalidMapTimeZones = new Set<string>()
const getMapTimeFormatter = (timezone?: string): Intl.DateTimeFormat => {
  const key = timezone || ''
  const cached = mapTimeFormatters.get(key)
  if (cached) return cached
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }
  const formatter = new Intl.DateTimeFormat('zh-CN', timezone ? { ...options, timeZone: timezone } : options)
  mapTimeFormatters.set(key, formatter)
  return formatter
}

const formatMapTime = (hourOffset: number, timezone?: string) => {
  const target = new Date(Date.now() + hourOffset * 60 * 60 * 1000)
  if (timezone && invalidMapTimeZones.has(timezone)) return getMapTimeFormatter(undefined).format(target)
  try {
    return getMapTimeFormatter(timezone).format(target)
  } catch {
    // 无效 timeZone 等：记下来并退回不带时区的 formatter（同样走缓存），避免每帧重复抛错
    if (timezone) invalidMapTimeZones.add(timezone)
    return getMapTimeFormatter(undefined).format(target)
  }
}

const getTimeCaption = (hourOffset: number) => {
  const rounded = Math.round(hourOffset * 10) / 10
  return rounded === 0 ? '现在' : `${rounded.toFixed(1)} 小时后`
}

function WeatherMapLegend({ layer, compact = false }: { layer: WeatherMapLayerDefinition; compact?: boolean }) {
  const colorStops = layer.colors.map(stop => `${stop.color} ${Math.max(0, Math.min(100, (stop.value - layer.min) / (layer.max - layer.min) * 100))}%`).join(', ')
  const gradient = `linear-gradient(to top, ${colorStops})`
  const ticks = [...layer.colors].reverse()
  return (
    <div className={compact ? 'flex items-center gap-2' : 'flex items-stretch gap-2'}>
      {compact ? (
        <>
          <div className="h-2 w-28 rounded-full" style={{ background: `linear-gradient(to right, ${colorStops})` }} />
          <span className="text-[10px] text-white/55">{layer.unit}</span>
        </>
      ) : (
        <>
          <div className="relative h-[300px] min-w-11 text-sm font-semibold text-white drop-shadow-md">
            {ticks.map(tick => (
              <span key={tick.value} className="absolute right-0 -translate-y-1/2" style={{ top: `${100 - (tick.value - layer.min) / (layer.max - layer.min) * 100}%` }}>{Math.round(tick.value)}</span>
            ))}
            {layer.unit !== '°C' && <span className="absolute bottom-0 right-0 translate-y-5 text-[11px]">{layer.unit}</span>}
          </div>
          <div className="h-[300px] w-5 rounded-full border border-white/15 shadow-lg" style={{ background: gradient }} />
        </>
      )}
    </div>
  )
}

/**
 * 预览卡的真实地图底图：以定位点为中心的"全景地图"实景瓦片拼幅。
 * 直接复用天气地图在线瓦片源（高德 + ArcGIS 兜底），无需引入 Leaflet。
 * zoom 13 为街道级实景（路网/街区形状清晰可见）；3×2 瓦片网格保持 1:1 纵横比
 * 拼接后按像素精确居中（定位点恒在卡片中央），地名注记不再被压扁。
 * 高德底图是 GCJ-02 坐标系，WGS-84 的 GPS 定位坐标需先转换，否则 13 级下
 * 定位点会偏离实际位置约 30 像素（约 500 米）。
 */
const PREVIEW_ZOOM = 13
const PREVIEW_ROWS = 2

// WGS-84 → GCJ-02（火星坐标）：高德底图坐标系的标准偏移算法
const transformWgs84ToGcj02 = (latitude: number, longitude: number): [number, number] => {
  const outOfChina = longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271
  if (outOfChina) return [latitude, longitude]
  const a = 6378245.0
  const ee = 0.00669342162296594323
  const transformLat = (x: number, y: number) => {
    let result = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
    result += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
    result += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
    return result
  }
  const transformLng = (x: number, y: number) => {
    let result = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    result += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
    result += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
    result += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
    return result
  }
  const dLat = transformLat(longitude - 105, latitude - 35)
  const dLng = transformLng(longitude - 105, latitude - 35)
  const radLat = latitude / 180 * Math.PI
  let magic = Math.sin(radLat)
  magic = 1 - ee * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  return [
    latitude + dLat * 180 / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI),
    longitude + dLng * 180 / (a / sqrtMagic * Math.cos(radLat) * Math.PI),
  ]
}

function WeatherMapPreviewTiles({ latitude, longitude }: { latitude: number; longitude: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight })
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const tiles = useMemo(() => {
    const [gcjLatitude, gcjLongitude] = transformWgs84ToGcj02(latitude, longitude)
    if (!Number.isFinite(gcjLatitude) || !Number.isFinite(gcjLongitude)) return null
    // 列数按卡片纵横比动态取：cover 铺满时瓦片不放大（保持原生清晰度）。
    // 卡片约 4.5:1 → rows=2 时需要 ≥9 列；窄卡片自然缩到 3~4 列。
    const aspect = viewport.height > 0 ? Math.max(1, viewport.width / viewport.height) : 3
    const columns = Math.max(3, Math.min(12, Math.ceil(PREVIEW_ROWS * aspect) + 1))
    const zoom = PREVIEW_ZOOM
    const size = 256 * (2 ** zoom)
    const x = ((gcjLongitude + 180) / 360) * size
    const clampLatitude = Math.max(-85.0511, Math.min(85.0511, gcjLatitude))
    const radians = clampLatitude * Math.PI / 180
    const y = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * size
    const tileX = Math.floor(x / 256)
    const tileY = Math.floor(y / 256)
    const maxTile = 2 ** zoom - 1
    const grid: Array<{ key: string; row: number; column: number; upstream: string; arcgis: string }> = []
    for (let row = 0; row < PREVIEW_ROWS; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const tileColumn = tileX + column - Math.floor(columns / 2)
        const tileRow = Math.max(0, Math.min(maxTile, tileY + row - Math.floor(PREVIEW_ROWS / 2)))
        const wrappedColumn = ((tileColumn % (maxTile + 1)) + maxTile + 1) % (maxTile + 1)
        grid.push({
          key: `${wrappedColumn}-${tileRow}`,
          row,
          column,
          upstream: `https://webst01.is.autonavi.com/appmaptile?style=7&x=${wrappedColumn}&y=${tileRow}&z=${zoom}`,
          arcgis: `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${zoom}/${tileRow}/${wrappedColumn}`,
        })
      }
    }
    return {
      columnCount: columns,
      // 定位点在拼幅内的精确相对位置（拼幅以中央瓦片为中心向两侧展开）
      fractionX: (x - (tileX - Math.floor(columns / 2)) * 256) / (columns * 256),
      fractionY: (y - (tileY - Math.floor(PREVIEW_ROWS / 2)) * 256) / (PREVIEW_ROWS * 256),
      grid,
    }
  }, [latitude, longitude, viewport.width, viewport.height])

  if (!tiles) return <div className="weather-map-preview-base absolute inset-0" />

  // 拼幅显示尺寸：以宽铺满为基准（瓦片保持 1:1 不变形）；列数已按纵横比取够，
  // 高度不足的部分由拼幅纵向裁切自然覆盖。定位点恒在卡片正中。
  const displayWidth = viewport.width
  const displayHeight = displayWidth * (PREVIEW_ROWS / tiles.columnCount)
  const offsetX = viewport.width / 2 - tiles.fractionX * displayWidth
  const offsetY = viewport.height / 2 - tiles.fractionY * displayHeight

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div
        className="absolute"
        style={{ width: displayWidth, height: displayHeight, left: offsetX, top: offsetY, visibility: viewport.width ? 'visible' : 'hidden' }}
      >
        {tiles.grid.map(tile => (
          <img
            key={tile.key}
            src={tile.upstream}
            data-fallback-src={tile.arcgis}
            alt=""
            draggable={false}
            className="absolute select-none"
            style={{ left: `${tile.column * 100 / tiles.columnCount}%`, top: `${tile.row * 100 / PREVIEW_ROWS}%`, width: `${100 / tiles.columnCount}%`, height: `${100 / PREVIEW_ROWS}%` }}
            onError={event => {
              const image = event.currentTarget
              const fallback = image.dataset.fallbackSrc
              if (fallback && image.src !== fallback) { image.src = fallback; return }
              image.style.opacity = '0'
            }}
          />
        ))}
      </div>
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(10,22,38,.18),transparent_38%,rgba(8,16,30,.34))]" />
      {/* 定位点恒在卡片正中（拼幅按定位点居中裁切） */}
      <div className="pointer-events-none absolute left-1/2 top-1/2">
        <span className="absolute -left-[7px] -top-[7px] block h-3.5 w-3.5 rounded-full border-2 border-white bg-sky-500 shadow-[0_0_10px_rgba(14,165,233,.9)]" />
        <span className="absolute -left-[14px] -top-[14px] block h-7 w-7 animate-ping rounded-full border border-sky-300/70" />
      </div>
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
      <WeatherMapPreviewTiles latitude={weather.location.latitude} longitude={weather.location.longitude} />
      {/* 左侧信息带渐变：保证文字可读，右侧留出通透的实景 */}
      <div className="weather-map-preview-field absolute inset-0 opacity-45" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(8,18,32,.58)_0%,rgba(8,18,32,.30)_34%,transparent_60%)]" />
      <div className="relative flex min-h-[240px] flex-col justify-between p-6">
        <div className="flex items-start justify-between gap-5">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white/72"><MapIcon className="h-4 w-4" />全景地图</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">实景地图 · 直观天气</div>
            <div className="mt-1 text-sm text-white/62">街道级实景底图 · 点击进入温度、风、湿度等 14 种专业图层</div>
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
  currentFrameKey: number
  nextFrameKey: number
  current: WeatherFieldGridLayer | null
  next: WeatherFieldGridLayer | null
}

const getWeatherFieldOpacity = (layerId: WeatherMapLayerId) => layerId === 'cloud' ? .62 : .78

// 地图偏好持久化键（底图样式/当前图层/动画图层开关）
const MAP_PREF_KEY = 'waveforge:weatherMapPrefs'

// 天气地图底图工厂：street=高德街道图（GCJ-02 坐标系，注记全中文）；
// satellite=Esri World Imagery（WGS-84，真实卫星实景）。图层样式/缓存策略一致。
const createBaseTileLayer = (style: 'street' | 'satellite') => style === 'satellite'
  ? L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19,
      pane: 'weatherMapBasePane',
      className: 'weather-map-base-tile',
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    })
  : L.tileLayer('https://webst0{s}.is.autonavi.com/appmaptile?style=7&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 19,
      pane: 'weatherMapBasePane',
      className: 'weather-map-base-tile',
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    })

function WeatherMapModal({ weather, open, onClose }: Pick<WeatherMapExperienceProps, 'weather' | 'open' | 'onClose'>) {
  // 挂起（所属模式层被切走）时不渲染这个 portal：portal 挂在 body 上，不受挂起层
  // visibility:hidden 约束，留着会盖住当前模式。只隐藏不卸载，切回来状态原样。
  const parked = useModeParked()
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
  const baseLayerRef = useRef<L.TileLayer | null>(null)
  const fieldLayersRef = useRef<WeatherFieldLayerPair>({
    layerId: null,
    currentFrameKey: -1,
    nextFrameKey: -1,
    current: null,
    next: null,
  })
  const selectedPointRef = useRef<LatLng | null>(null)
  const activeLayerIdRef = useRef<WeatherMapLayerId | null>('temperature')
  const hourOffsetRef = useRef(0)
  const locationRef = useRef({ latitude: weather.location.latitude, longitude: weather.location.longitude })
  const timezoneRef = useRef(weather.timezone)
  const weatherGridRef = useRef<WeatherGrid | null>(null)
  const gridRequestRef = useRef<AbortController | null>(null)
  const gridRequestIdRef = useRef(0)
  const [gridStatus, setGridStatus] = useState<'loading' | 'forecast' | 'estimate'>('loading')
  // activeLayerId=null 表示用户点掉了当前图层（纯底图模式），再点其它图层恢复。
  // 底图样式/天气图层/动画开关跨会话记忆（localStorage，弹窗重开甚至重启应用后保持）。
  const [activeLayerId, setActiveLayerId] = useState<WeatherMapLayerId | null>(() => {
    try { return (localStorage.getItem(MAP_PREF_KEY + ':layer') as WeatherMapLayerId) || 'temperature' } catch { return 'temperature' }
  })
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  const [hourOffset, setHourOffset] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState<0.5 | 1 | 2>(1)
  const [windWaves, setWindWaves] = useState(() => { try { return localStorage.getItem(MAP_PREF_KEY + ':windWaves') === '1' } catch { return false } })
  const [isobars, setIsobars] = useState(() => { try { return localStorage.getItem(MAP_PREF_KEY + ':isobars') === '1' } catch { return false } })
  // 底图样式：street=高德街道图（GCJ-02），satellite=Esri 世界影像（WGS-84，真实实景）
  const [baseStyle, setBaseStyle] = useState<'street' | 'satellite'>(() => {
    try { return localStorage.getItem(MAP_PREF_KEY + ':base') === 'satellite' ? 'satellite' : 'street' } catch { return 'street' }
  })
  const [selectedPoint, setSelectedPoint] = useState<LatLng | null>(null)
  const [selectedPlaceName, setSelectedPlaceName] = useState<string | null>(null)
  const [pointValue, setPointValue] = useState<WeatherMapPointValue | null>(null)
  const [pointLoading, setPointLoading] = useState(false)
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number } | null>(null)
  const activeLayer = activeLayerId ? WEATHER_MAP_LAYER_BY_ID[activeLayerId] : null

  // 偏好持久化：写入即存，下一次打开（甚至重启）自动恢复
  useEffect(() => { try { localStorage.setItem(MAP_PREF_KEY + ':layer', activeLayerId ?? '') } catch {} }, [activeLayerId])
  useEffect(() => { try { localStorage.setItem(MAP_PREF_KEY + ':base', baseStyle) } catch {} }, [baseStyle])
  useEffect(() => { try { localStorage.setItem(MAP_PREF_KEY + ':windWaves', windWaves ? '1' : '0') } catch {} }, [windWaves])
  useEffect(() => { try { localStorage.setItem(MAP_PREF_KEY + ':isobars', isobars ? '1' : '0') } catch {} }, [isobars])

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
    fieldLayersRef.current = { layerId: null, currentFrameKey: -1, nextFrameKey: -1, current: null, next: null }
  }, [])

  const createFieldLayer = useCallback((layerId: WeatherMapLayerId, forecastHour: number, frame: WeatherGridFrame | null, opacity: number) => {
    const map = mapRef.current
    if (!map) return null
    const layer = new WeatherFieldGridLayer(layerId, forecastHour, frame, {
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
    // activeLayerId 为 null = 用户点掉了图层（纯底图模式）：移除全部天气场图层即可
    if (layerId === null) {
      clearFieldLayers()
      return
    }
    const grid = weatherGridRef.current
    const framePair: WeatherGridFramePair | null = grid
      ? getWeatherGridFramePair(grid, Date.now() + bounded * 60 * 60 * 1000)
      : null
    const currentHour = Math.min(48, Math.floor(bounded))
    const nextHour = Math.min(48, currentHour + 1)
    const currentFrameKey = framePair?.current.timestamp ?? currentHour
    const nextFrameKey = framePair?.next.timestamp ?? nextHour
    const baseOpacity = getWeatherFieldOpacity(layerId)
    let pair = fieldLayersRef.current

    if (force || pair.layerId !== layerId || pair.currentFrameKey !== currentFrameKey) {
      const canPromote = !force
        && pair.layerId === layerId
        && pair.nextFrameKey === currentFrameKey
        && pair.next !== null

      if (canPromote) {
        if (pair.current && map.hasLayer(pair.current)) map.removeLayer(pair.current)
        pair.current = pair.next
        pair.currentFrameKey = currentFrameKey
        pair.next = null
        pair.nextFrameKey = nextFrameKey
      } else {
        clearFieldLayers()
        pair = fieldLayersRef.current
        pair.layerId = layerId
        pair.currentFrameKey = currentFrameKey
        pair.nextFrameKey = nextFrameKey
        pair.current = createFieldLayer(layerId, currentHour, framePair?.current || null, baseOpacity)
      }

      pair.layerId = layerId
      if (nextFrameKey !== currentFrameKey && !pair.next) {
        pair.nextFrameKey = nextFrameKey
        pair.next = createFieldLayer(layerId, nextHour, framePair?.next || null, 0)
      }
      fieldLayersRef.current = pair
    }

    pair = fieldLayersRef.current
    const fraction = framePair?.ratio ?? (nextHour === currentHour ? 0 : bounded - currentHour)
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
    const grid = weatherGridRef.current
    const realFrame = grid ? (() => {
      const pair = getWeatherGridFramePair(grid, Date.now() + bounded * 60 * 60 * 1000)
      return pair.current === pair.next ? pair.current : interpolateWeatherGridFrame(pair.current, pair.next, pair.ratio)
    })() : null
    windLayerRef.current?.setFrame(realFrame).setHourOffset(bounded)
    isobarLayerRef.current?.setFrame(realFrame).setHourOffset(bounded)
    updateTimelineDom(bounded)
  }, [syncFieldLayers, updateTimelineDom])

  useEffect(() => {
    if (!open || !mapElementRef.current || mapRef.current) return
    const initialLocation = locationRef.current
    // 初始即街道级放大视图（12 级 ≈ 街区尺度），与预览卡"全景地图"衔接；
    // maxZoom 17 支持继续放大到楼宇细节。
    const map = L.map(mapElementRef.current, {
      center: [initialLocation.latitude, initialLocation.longitude],
      zoom: 12,
      minZoom: 3,
      maxZoom: 17,
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      preferCanvas: true,
      zoomAnimation: false,
      fadeAnimation: false,
      markerZoomAnimation: false,
      inertia: true,
      inertiaDeceleration: 3400,
      inertiaMaxSpeed: 1200,
      // 滚轮缩放手感：默认 wheelPxPerZoomLevel=60，普通鼠标滚轮一格 deltaY≈100-120
      // 会一次跨 2 档，配合 zoomAnimation:false 的硬切看起来"缩放过头、不跟手"。
      // 提高阈值后每 notch 稳定缩 1 档，且 scrollWheelZoom 默认锚定光标位置。
      scrollWheelZoom: true,
      wheelPxPerZoomLevel: 120,
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

    const baseLayer = createBaseTileLayer(baseStyle).addTo(map)
    baseLayer.on('tileerror', event => {
      const tile = event.tile as HTMLImageElement
      if (tile.dataset.weatherMapFallback === 'true') return
      tile.dataset.weatherMapFallback = 'true'
      tile.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${event.coords.z}/${event.coords.y}/${event.coords.x}`
    })
    baseLayerRef.current = baseLayer

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
    const refreshWeatherGrid = () => {
      const bounds = map.getBounds()
      const center = map.getCenter()
      const latitudeSpan = Math.min(70, Math.max(2, bounds.getNorth() - bounds.getSouth()))
      const longitudeSpan = Math.min(160, Math.max(3, bounds.getEast() - bounds.getWest()))
      const gridBounds = {
        north: Math.min(85, center.lat + latitudeSpan * .58),
        south: Math.max(-85, center.lat - latitudeSpan * .58),
        east: center.lng + longitudeSpan * .58,
        west: center.lng - longitudeSpan * .58,
      }
      const requestId = ++gridRequestIdRef.current
      gridRequestRef.current?.abort()
      const controller = new AbortController()
      gridRequestRef.current = controller
      setGridStatus('loading')
      loadWeatherGrid(gridBounds, controller.signal)
        .then(grid => {
          if (controller.signal.aborted || requestId !== gridRequestIdRef.current) return
          weatherGridRef.current = grid
          setGridStatus('forecast')
          clearFieldLayers()
          applyHourOffset(hourOffsetRef.current)
        })
        .catch(error => {
          if (controller.signal.aborted || requestId !== gridRequestIdRef.current) return
          console.warn('[WeatherMap] Failed to load viewport grid:', error)
          weatherGridRef.current = null
          setGridStatus('estimate')
          applyHourOffset(hourOffsetRef.current)
        })
    }
    map.on('moveend', refreshWeatherGrid)
    refreshWeatherGrid()
    const container = map.getContainer()
    L.DomEvent.disableScrollPropagation(container)
    const invalidateSizeTimer = window.setTimeout(() => {
      map.invalidateSize()
      syncFieldLayers(hourOffsetRef.current, true)
    }, 80)

    return () => {
      placeLookupControllerRef.current?.abort()
      gridRequestRef.current?.abort()
      gridRequestIdRef.current += 1
      weatherGridRef.current = null
      gridRequestRef.current = null
      window.clearTimeout(invalidateSizeTimer)
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
      baseLayerRef.current = null
    }
  }, [clearFieldLayers, open, syncFieldLayers, updatePopupPosition])

  // 底图切换：先加新层再移除旧层，避免瞬间露出背景；瓦片容错兜底两样式通用。
  useEffect(() => {
    const map = mapRef.current
    const current = baseLayerRef.current
    if (!map || !current) return
    const newLayer = createBaseTileLayer(baseStyle)
    newLayer.on('tileerror', event => {
      const tile = event.tile as HTMLImageElement
      if (tile.dataset.weatherMapFallback === 'true') return
      tile.dataset.weatherMapFallback = 'true'
      tile.src = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${event.coords.z}/${event.coords.y}/${event.coords.x}`
    })
    newLayer.addTo(map)
    baseLayerRef.current = newLayer
    map.removeLayer(current)
  }, [baseStyle])

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
    // 风/海浪是独立动画图层：开关打开即显示（可选叠加在任意天气图层或纯地图上）
    const shouldShow = windWaves
    if (shouldShow && !windLayerRef.current) {
      const grid = weatherGridRef.current
      const frame = grid ? (() => {
        const pair = getWeatherGridFramePair(grid, Date.now() + hourOffsetRef.current * 60 * 60 * 1000)
        return pair.current === pair.next ? pair.current : interpolateWeatherGridFrame(pair.current, pair.next, pair.ratio)
      })() : null
      windLayerRef.current = new WeatherWindParticleLayer().setFrame(frame).setHourOffset(hourOffsetRef.current).addTo(map)
    } else if (!shouldShow && windLayerRef.current) {
      map.removeLayer(windLayerRef.current)
      windLayerRef.current = null
    }
  }, [activeLayerId, open, windWaves])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !open) return
    if (isobars && !isobarLayerRef.current) {
      const grid = weatherGridRef.current
      const frame = grid ? (() => {
        const pair = getWeatherGridFramePair(grid, Date.now() + hourOffsetRef.current * 60 * 60 * 1000)
        return pair.current === pair.next ? pair.current : interpolateWeatherGridFrame(pair.current, pair.next, pair.ratio)
      })() : null
      isobarLayerRef.current = new WeatherIsobarLayer().setFrame(frame).setHourOffset(hourOffsetRef.current).addTo(map)
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
    const requestedLayer = activeLayerId ?? 'temperature'
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
      const next = advanceWeatherMapPlayback(hourOffsetRef.current, elapsed, playbackSpeed)
      applyHourOffset(next)
      if (now - lastUiUpdate >= 100 || next >= 48) {
        lastUiUpdate = now
        setHourOffset(next)
      }
      if (next >= 48) {
        setPlaying(false)
        return
      }
      animationFrame = window.requestAnimationFrame(animateTimeline)
    }
    animationFrame = window.requestAnimationFrame(animateTimeline)
    return () => {
      window.cancelAnimationFrame(animationFrame)
      setHourOffset(hourOffsetRef.current)
    }
  }, [applyHourOffset, open, playbackSpeed, playing])

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
  if (parked) return null

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
                      <div className="mt-0.5 text-[9px] text-slate-500">当前：{activeLayer ? activeLayer.label : '纯地图（再点图层恢复）'}</div>
                    </div>
                    <span className="rounded-full bg-blue-50 px-2 py-1 text-[9px] font-medium text-blue-600">14 种模式</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {WEATHER_MAP_LAYERS.map(layer => (
                      <LayerButton key={layer.id} layer={layer} active={layer.id === activeLayerId} onClick={() => { setActiveLayerId(current => current === layer.id ? null : layer.id); setLayerPanelOpen(false) }} />
                    ))}
                  </div>
                  <div className="mt-3 border-t border-slate-200/70 pt-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase text-slate-500">底图样式</div>
                    <div className="grid grid-cols-2 gap-2">
                      {([
                        ['street', '街道地图', '高德 · 中文注记路网'],
                        ['satellite', '实景卫星', 'Esri · 真实影像'],
                      ] as const).map(([style, label, description]) => (
                        <button
                          key={style}
                          type="button"
                          onClick={() => setBaseStyle(style)}
                          aria-pressed={baseStyle === style}
                          className={`rounded-2xl border px-3 py-2.5 text-left transition-colors ${baseStyle === style ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white/70 hover:bg-slate-50'}`}
                        >
                          <span className={`block text-xs font-semibold ${baseStyle === style ? 'text-blue-700' : 'text-slate-700'}`}>{label}</span>
                          <span className="mt-0.5 block text-[9px] text-slate-500">{description}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 border-t border-slate-200/70 pt-3">
                    <div className="mb-2 text-[10px] font-semibold uppercase text-slate-500">动画图层</div>
                    <div className="space-y-2 rounded-2xl bg-slate-100/75 p-3">
                      <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-slate-700">
                        <span>风 / 海浪</span>
                        <input type="checkbox" checked={windWaves} onChange={event => setWindWaves(event.target.checked)} className="weather-map-toggle" />
                      </label>
                      <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-medium text-slate-700">
                        <span>等压线</span>
                        <input type="checkbox" checked={isobars} onChange={event => setIsobars(event.target.checked)} className="weather-map-toggle" />
                      </label>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-slate-700">播放速度</span>
                      <div className="flex items-center gap-1" aria-label="天气动画播放速度">
                        {([0.5, 1, 2] as const).map(speed => (
                          <button key={speed} type="button" onClick={() => setPlaybackSpeed(speed)} aria-pressed={playbackSpeed === speed} className={`h-7 min-w-10 rounded-lg px-2 text-[10px] font-semibold tabular-nums transition-colors ${playbackSpeed === speed ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600 hover:bg-slate-300'}`}>{speed}×</button>
                        ))}
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="absolute right-5 top-5 z-[540] md:right-7 md:top-6">
            <button type="button" onClick={onClose} title="关闭天气地图" aria-label="关闭天气地图" className="weather-map-round-control"><X className="h-5 w-5" /></button>
          </div>

          <div className="absolute bottom-24 right-4 z-[546] flex items-end md:bottom-6 md:right-6">
            <div className="flex gap-2">
              <button type="button" onClick={centerOnWeather} title="定位到当前位置" aria-label="定位到当前位置" className="weather-map-round-control weather-map-round-control-compact"><Crosshair className="h-[18px] w-[18px]" /></button>
              <button type="button" onClick={() => mapRef.current?.zoomIn()} title="放大" aria-label="放大地图" className="weather-map-round-control weather-map-round-control-compact"><Plus className="h-5 w-5" /></button>
              <button type="button" onClick={() => mapRef.current?.zoomOut()} title="缩小" aria-label="缩小地图" className="weather-map-round-control weather-map-round-control-compact"><Minus className="h-5 w-5" /></button>
            </div>
          </div>

          {activeLayer && (
            <div className="absolute right-6 top-1/2 z-[540] hidden -translate-y-1/2 md:block">
              <WeatherMapLegend layer={activeLayer} />
            </div>
          )}

          <div className="absolute left-1/2 top-5 z-[540] -translate-x-1/2 rounded-full border border-white/30 bg-white/82 px-5 py-2 text-center shadow-lg backdrop-blur-xl">
            <div className="flex items-center gap-2 text-sm font-semibold"><Layers3 className="h-4 w-4" />{activeLayer ? activeLayer.label : '纯地图'}</div>
            <div className="mt-0.5 flex items-center justify-center gap-1.5 text-[10px] text-slate-500">
              <span>{activeLayer ? activeLayer.description : '仅显示底图，点图层按钮叠加天气'}</span>
              <span>·</span>
              <span className={gridStatus === 'forecast' ? 'text-emerald-700' : gridStatus === 'loading' ? 'text-blue-700' : 'text-amber-700'}>
                {gridStatus === 'forecast' ? '真实预报网格' : gridStatus === 'loading' ? '加载预报网格' : '本地估算'}
              </span>
            </div>
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
              <div className="mb-1 flex items-center justify-between px-1 text-[10px] font-medium text-slate-600">
                <span ref={timelineTimeLabelRef}>{timeLabel} · {getTimeCaption(hourOffset)}</span>
                <span className="tabular-nums">未来 48 小时</span>
              </div>
              <div className="weather-map-timeline-scale ml-[42px] mr-[58px] grid grid-cols-9 text-[9px] tabular-nums text-slate-500">
                {[0, 6, 12, 18, 24, 30, 36, 42, 48].map((value, index) => (
                  <span key={value} className={index === 0 ? 'text-left' : index === 8 ? 'text-right' : 'text-center'}>{value === 0 ? '现在' : value === 24 ? '明天' : value === 48 ? '后天' : `+${value}h`}</span>
                ))}
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




