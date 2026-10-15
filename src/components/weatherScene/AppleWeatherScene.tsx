import { useEffect, useRef } from 'react'
import moonUrl from '../../assets/weather/moon.webp'
import { APPLE_WEATHER_SCENES, APPLE_WEATHER_TEXTURES } from './appleWeatherAssets.generated'
import type { AppleWeatherSceneModel } from './weatherSceneModel'
import { advanceWeatherFrameDeadline, createWeatherScenePerformanceState, shouldRenderWeatherFrame, updateWeatherScenePerformance, WEATHER_SCENE_QUALITY } from './weatherScenePerformance'

interface AppleWeatherSceneProps {
  scene: AppleWeatherSceneModel
  active: boolean
  reducedMotion?: boolean
  className?: string
  onReady?: () => void
  onUnavailable?: () => void
}

interface Particle {
  x: number
  y: number
  size: number
  speed: number
  drift: number
  phase: number
  alpha: number
  frame: number
}

const PALETTES = {
  day: {
    clear: ['#126bc5', '#58a7e7', '#c4e5f7'], cloudy: ['#567184', '#8ea2b0', '#c2ccd1'], fog: ['#777d7d', '#a7aaa4', '#d1d0c5'],
    drizzle: ['#315e76', '#698b9c', '#b6c8ce'], rain: ['#183a51', '#496b7c', '#8ea4ac'], 'heavy-rain': ['#102a3c', '#304e60', '#70838b'],
    thunder: ['#555f68', '#68737b', '#858d91'], snow: ['#84909b', '#b4bdc4', '#e0e3e5'], 'partly-cloudy': ['#287bc0', '#75afd7', '#c8dce7'],
  },
  night: {
    clear: ['#020812', '#0b1c3a', '#214b78'], cloudy: ['#0b121c', '#283644', '#55616b'], fog: ['#111419', '#333940', '#62676a'],
    drizzle: ['#071523', '#1c3548', '#4a6370'], rain: ['#040c17', '#182c3e', '#405969'], 'heavy-rain': ['#030810', '#102233', '#314958'],
    thunder: ['#070812', '#222936', '#4a4e5c'], snow: ['#121923', '#34404c', '#68727b'], 'partly-cloudy': ['#050e1e', '#172d47', '#405c73'],
  },
} as const

const makeRandom = (seed: number) => {
  let value = seed || 1
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x100000000
  }
}

const texture = (name: string) => name === 'Moon.webp' ? moonUrl : APPLE_WEATHER_TEXTURES[name]?.url
const imageCache = new Map<string, Promise<HTMLImageElement | null>>()
const loadImage = (name: string) => {
  const url = texture(name)
  if (!url) return Promise.resolve(null)
  const cached = imageCache.get(url)
  if (cached) return cached
  const promise = new Promise<HTMLImageElement | null>(resolve => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => resolve(image)
    image.onerror = () => resolve(null)
    image.src = url
  })
  imageCache.set(url, promise)
  return promise
}
const loadImages = async (names: string[]) => {
  const entries = await Promise.all([...new Set(names)].map(async name => [name, await loadImage(name)] as const))
  return new Map(entries.filter((entry): entry is [string, HTMLImageElement] => Boolean(entry[1])))
}

const drawCover = (ctx: CanvasRenderingContext2D, image: CanvasImageSource, sourceWidth: number, sourceHeight: number, width: number, height: number, offsetX = 0) => {
  const scale = Math.max(width / sourceWidth, height / sourceHeight)
  const drawWidth = sourceWidth * scale
  const drawHeight = sourceHeight * scale
  ctx.drawImage(image, (width - drawWidth) / 2 + offsetX, (height - drawHeight) / 2, drawWidth, drawHeight)
}

const drawAtlasFrame = (ctx: CanvasRenderingContext2D, image: HTMLImageElement, frame: number, columns: number, rows: number, x: number, y: number, width: number, height: number) => {
  const column = frame % columns
  const row = Math.floor(frame / columns) % rows
  const sw = image.naturalWidth / columns
  const sh = image.naturalHeight / rows
  ctx.drawImage(image, column * sw, row * sh, sw, sh, x, y, width, height)
}

export default function AppleWeatherScene({ scene, active, reducedMotion = false, className = '', onReady, onUnavailable }: AppleWeatherSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) {
      onUnavailable?.()
      return
    }

    let disposed = false
    let raf = 0
    let resizeObserver: ResizeObserver | null = null
    let width = 1
    let height = 1
    let dpr = 1
    let nextFrameAt = 0
    let sampleStartedAt = 0
    let deliveredFrames = 0
    let renderCosts: number[] = []
    let performanceState = createWeatherScenePerformanceState()
    let backgroundGradient: CanvasGradient | null = null
    let shadeGradient: CanvasGradient | null = null
    let cleanupLoadedScene: (() => void) | null = null
    const random = makeRandom(scene.seed)
    const source = APPLE_WEATHER_SCENES[scene.id as keyof typeof APPLE_WEATHER_SCENES]
    if (!source) {
      onUnavailable?.()
      return
    }

    const makeParticles = (count: number, kind: 'rain' | 'snow' | 'fog' | 'star'): Particle[] => Array.from({ length: count }, () => ({
      x: random(), y: random(), size: kind === 'rain' ? 0.45 + random() * 1.7 : kind === 'star' ? 0.7 + random() * 2.2 : 0.35 + random() * 1.7,
      speed: kind === 'rain' ? 0.65 + random() * 1.15 : kind === 'snow' ? 0.025 + random() * 0.045 : kind === 'fog' ? 0.008 + random() * 0.009 : 0,
      drift: random() * 2 - 1, phase: random() * Math.PI * 2, alpha: 0.25 + random() * 0.7, frame: Math.floor(random() * 8),
    }))
    const denseRain = scene.kind === 'heavy-rain' || scene.kind === 'thunder'
    const rain = makeParticles(scene.kind === 'drizzle' ? 110 : denseRain ? 520 : 280, 'rain')
    const snow = makeParticles(250, 'snow')
    const fog = makeParticles(12, 'fog')
    const stars = makeParticles(150, 'star')

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      const nextDpr = Math.min(window.devicePixelRatio || 1, WEATHER_SCENE_QUALITY[performanceState.quality].dprCap)
      const nextWidth = Math.round(width * nextDpr)
      const nextHeight = Math.round(height * nextDpr)
      dpr = nextDpr
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      const palette = PALETTES[scene.isDay ? 'day' : 'night'][scene.kind]
      backgroundGradient = ctx.createLinearGradient(0, 0, 0, height)
      backgroundGradient.addColorStop(0, palette[0])
      backgroundGradient.addColorStop(0.55, palette[1])
      backgroundGradient.addColorStop(1, palette[2])
      shadeGradient = ctx.createLinearGradient(0, 0, 0, height)
      shadeGradient.addColorStop(0, 'rgba(255,255,255,0.025)')
      shadeGradient.addColorStop(0.65, 'rgba(0,0,0,0)')
      shadeGradient.addColorStop(1, 'rgba(0,8,18,0.3)')
    }

    const render = (images: Map<string, HTMLImageElement>, now: number) => {
      const t = reducedMotion ? 48 : now / 1000
      const palette = PALETTES[scene.isDay ? 'day' : 'night'][scene.kind]
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.fillStyle = backgroundGradient ?? palette[0]
      ctx.fillRect(0, 0, width, height)

      const image = (name: string) => images.get(name)
      const drawCloudAtlas = (name: string, index: number, y: number, scale: number, alpha: number, speed: number) => {
        const cloud = image(name)
        if (!cloud) return
        const columns = name.includes('Fringe') ? 4 : 2
        const rows = 2
        const frameWidth = cloud.naturalWidth / columns
        const frameHeight = cloud.naturalHeight / rows
        const targetWidth = width * scale
        const targetHeight = targetWidth * (frameHeight / frameWidth)
        const travel = width + targetWidth
        const x = ((index * width * 0.37 - t * speed * width) % travel + travel) % travel - targetWidth
        ctx.globalAlpha = alpha
        drawAtlasFrame(ctx, cloud, index, columns, rows, x, y * height, targetWidth, targetHeight)
      }

      if (!scene.isDay && (scene.kind === 'clear' || scene.kind === 'partly-cloudy')) {
        const moonSize = Math.min(width, height) * 0.28
          ctx.globalCompositeOperation = 'screen'
          ctx.globalAlpha = 0.78
          const moonImage = image('Moon.webp')
          if (moonImage) ctx.drawImage(moonImage, width * 0.68 - moonSize / 2, height * 0.1, moonSize, moonSize)
        const starImage = image('Star-Frames.heic')
        ctx.globalCompositeOperation = 'lighter'
        const particleRatio = WEATHER_SCENE_QUALITY[performanceState.quality].particleRatio
        const visibleStars = Math.ceil(stars.length * particleRatio)
        for (let index = 0; index < visibleStars; index += 1) {
          const star = stars[index]
          const twinkle = 0.45 + Math.sin(t * (1.2 + star.size * 0.3) + star.phase) * 0.4
          ctx.globalAlpha = star.alpha * twinkle
          const size = star.size * Math.max(1, width / 1100)
          if (starImage) drawAtlasFrame(ctx, starImage, star.frame, 2, 4, star.x * width, star.y * height * 0.82, size * 5, size * 5)
          else { ctx.fillStyle = '#fff'; ctx.fillRect(star.x * width, star.y * height * 0.82, size, size) }
        }
      }

      if (scene.kind === 'clear' && scene.isDay || scene.kind === 'partly-cloudy' && scene.isDay) {
        const sun = image('Sun-Left.heic')
        if (sun) {
          const size = Math.min(width, height) * 0.37
          ctx.globalCompositeOperation = 'screen'
          ctx.globalAlpha = 1
          ctx.drawImage(sun, -size * 0.08, -size * 0.05, size, size)
        }
        const ray = image('Ray-Cyan.heic')
        if (ray) {
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.translate(width * 0.13, height * 0.1)
          ctx.rotate(-0.78 + Math.sin(t * 0.7) * 0.035)
          ctx.globalAlpha = 0.35
          ctx.drawImage(ray, -width * 0.04, 0, width * 0.08, height * 0.75)
          ctx.restore()
        }
      }

      if (scene.kind === 'partly-cloudy' || scene.kind === 'cloudy') {
        if (scene.kind === 'cloudy') {
          const background = image('Cloudy-Background-One.heic')
          if (background) {
            ctx.globalAlpha = scene.isDay ? 0.62 : 0.42
            ctx.globalCompositeOperation = scene.isDay ? 'screen' : 'source-over'
            const h = Math.max(height * 0.42, width / 3)
            const w = h * 3
            const x = -((t * width / 360) % (w / 3))
            // 云背景图顶部有硬边（裁自原版 .caml，顶缘未羽化）：贴顶 y=2% 时图顶的亮灰
            // 带以"横贯全屏的灰条"直接可见（用户实测）。上移 6% 把硬边带出屏幕顶，
            // 高度补偿同量，保持底部覆盖不变。
            const tileY = -h * 0.06
            for (let repeat = -1; repeat < Math.ceil(width / w) + 2; repeat += 1) ctx.drawImage(background, x + repeat * w, tileY, w, h)
          }
        }
        const suffix = scene.isDay && scene.kind === 'partly-cloudy' ? 'Blue' : 'Neutral'
        ctx.globalCompositeOperation = 'source-over'
        drawCloudAtlas(`Cumulus-One-${suffix}.heic`, 0, 0.18, 1.25, 0.82, 0.0045)
        drawCloudAtlas(`Cumulus-Two-${suffix}.heic`, 2, 0.34, 1.42, 0.72, 0.005)
        drawCloudAtlas(`Cumulus-Three-${suffix}.heic`, 1, 0.48, 1.65, 0.7, 0.004)
        drawCloudAtlas(`Fringe-Large-${suffix}.heic`, 4, 0.28, 0.8, 0.42, 0.009)
      }

      if (scene.kind === 'drizzle') {
        const drizzle = image('Cloud-Drizzle.heic')
        if (drizzle) {
          ctx.globalAlpha = scene.isDay ? 0.82 : 0.58
          drawCover(ctx, drizzle, drizzle.naturalWidth, drizzle.naturalHeight, width, height * 0.58, Math.sin(t / 24) * width * 0.03)
        }
      }

      if (scene.kind === 'fog') {
        const fogImage = image('Cloud-Patch-One.heic')
        if (fogImage) {
          ctx.globalCompositeOperation = 'screen'
          const particleRatio = WEATHER_SCENE_QUALITY[performanceState.quality].particleRatio
          const visibleFog = Math.ceil(fog.length * particleRatio)
          for (let index = 0; index < visibleFog; index += 1) {
            const particle = fog[index]
            const targetWidth = width * (0.55 + particle.size * 0.22)
            const targetHeight = targetWidth
            const x = ((particle.x * width - t * particle.speed * width) % (width + targetWidth) + width + targetWidth) % (width + targetWidth) - targetWidth
            ctx.globalAlpha = particle.alpha * (scene.isDay ? 0.17 : 0.1)
            drawAtlasFrame(ctx, fogImage, particle.frame % 4, 2, 2, x, particle.y * height - targetHeight / 2, targetWidth, targetHeight)
          }
        }
      }

      if (scene.kind === 'thunder') {
        const main = image(scene.isDay ? 'Thunderstorm-Day-Main.heic' : 'Thunderstorm-Night-Main.heic')
        if (main) {
          ctx.globalCompositeOperation = 'lighter'
          ctx.globalAlpha = scene.isDay ? 0.88 : 0.72
          const drawHeight = height * 0.62
          const drawWidth = drawHeight * (main.naturalWidth / main.naturalHeight)
          const x = -((t * 14) % Math.max(1, drawWidth - width))
          ctx.drawImage(main, x, 0, drawWidth, drawHeight)
        }
        const cycle = (t + (scene.seed % 71)) % 66
        const flashIndex = Math.floor(cycle / 11)
        const flashPhase = cycle % 11
        if (flashPhase < 0.42) {
          const flicker = image(`Thunderstorm-${scene.isDay ? 'Day' : 'Night'}-Flicker-0${flashIndex + 1}.heic`)
          if (flicker) {
            ctx.globalCompositeOperation = 'screen'
            ctx.globalAlpha = Math.sin((flashPhase / 0.42) * Math.PI) * 0.95
            drawCover(ctx, flicker, flicker.naturalWidth, flicker.naturalHeight, width, height * 0.72, (flashIndex - 2.5) * width * 0.08)
          }
        }
      }

      if (scene.kind === 'rain' || scene.kind === 'heavy-rain' || scene.kind === 'thunder' || scene.kind === 'drizzle') {
        const drop = image('Raindrop.heic')
        const speedScale = scene.kind === 'drizzle' ? 0.58 : denseRain ? 1.2 : 0.86
        ctx.globalCompositeOperation = 'screen'
        const particleRatio = WEATHER_SCENE_QUALITY[performanceState.quality].particleRatio
        const visibleRain = Math.ceil(rain.length * particleRatio)
        for (let index = 0; index < visibleRain; index += 1) {
          const particle = rain[index]
          const y = ((particle.y + t * particle.speed * speedScale) % 1.25) * height - height * 0.12
          const x = (particle.x * width + y * 0.035 + particle.drift * 24) % width
          const dropHeight = (scene.kind === 'drizzle' ? 16 : denseRain ? 48 : 30) * particle.size
          ctx.globalAlpha = particle.alpha * (scene.kind === 'drizzle' ? 0.3 : 0.55)
          if (drop) ctx.drawImage(drop, x, y, Math.max(1, dropHeight * 0.1), dropHeight)
        }
      }

      if (scene.kind === 'snow') {
        const flake = image('Snow-Flake-Small.heic')
        ctx.globalCompositeOperation = 'screen'
        const particleRatio = WEATHER_SCENE_QUALITY[performanceState.quality].particleRatio
        const visibleSnow = Math.ceil(snow.length * particleRatio)
        for (let index = 0; index < visibleSnow; index += 1) {
          const particle = snow[index]
          const y = ((particle.y + t * particle.speed) % 1.12) * height - height * 0.06
          const x = (particle.x * width + Math.sin(t * 0.7 + particle.phase) * width * 0.025 + particle.drift * y * 0.045 + width) % width
          const size = (2.5 + particle.size * 7) * Math.max(0.8, width / 1400)
          ctx.globalAlpha = particle.alpha
          if (flake) ctx.drawImage(flake, x, y, size, size)
        }
      }

      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.fillStyle = shadeGradient ?? 'rgba(0,8,18,0.18)'
      ctx.fillRect(0, 0, width, height)
    }

    const imageNames = [...source.assets, ...(!scene.isDay && (scene.kind === 'clear' || scene.kind === 'partly-cloudy') ? ['Moon.webp'] : [])]
    loadImages(imageNames).then(images => {
      if (disposed) return
      const missing = imageNames.filter(asset => !images.has(asset))
      if (missing.length > 0) {
        onUnavailable?.()
        return
      }
      resize()
      render(images, reducedMotion ? 48000 : performance.now())
      onReady?.()

      const stopLoop = () => {
        cancelAnimationFrame(raf)
        raf = 0
      }
      const tick = (now: number) => {
        raf = 0
        if (disposed || document.hidden || !active) return
        const preset = WEATHER_SCENE_QUALITY[performanceState.quality]
        if (shouldRenderWeatherFrame(now, nextFrameAt, preset.fps)) {
          const startedAt = performance.now()
          render(images, now)
          renderCosts.push(performance.now() - startedAt)
          deliveredFrames += 1
          nextFrameAt = advanceWeatherFrameDeadline(now, nextFrameAt, preset.fps)
          if (sampleStartedAt === 0) sampleStartedAt = now
          if (now - sampleStartedAt >= 1000) {
            const nextState = updateWeatherScenePerformance(performanceState, renderCosts, deliveredFrames, Math.max(1000, now - sampleStartedAt))
            const qualityChanged = nextState.quality !== performanceState.quality
            performanceState = nextState
            renderCosts = []
            deliveredFrames = 0
            sampleStartedAt = now
            if (qualityChanged) resize()
          }
        }
        raf = requestAnimationFrame(tick)
      }
      const startLoop = () => {
        if (disposed || reducedMotion || document.hidden || raf) return
        nextFrameAt = 0
        sampleStartedAt = 0
        renderCosts = []
        deliveredFrames = 0
        raf = requestAnimationFrame(tick)
      }
      const handleVisibility = () => {
        if (document.hidden) stopLoop()
        else startLoop()
      }

      if (reducedMotion) render(images, 48000)
      else {
        document.addEventListener('visibilitychange', handleVisibility)
        startLoop()
      }
      resizeObserver = new ResizeObserver(() => {
        resize()
        sampleStartedAt = 0
        if (reducedMotion) render(images, 48000)
      })
      resizeObserver.observe(canvas)
      cleanupLoadedScene = () => {
        stopLoop()
        document.removeEventListener('visibilitychange', handleVisibility)
      }
    }).catch(() => onUnavailable?.())

    return () => {
      disposed = true
      cleanupLoadedScene?.()
      cancelAnimationFrame(raf)
      resizeObserver?.disconnect()
    }
  }, [active, onReady, onUnavailable, reducedMotion, scene])

  return <canvas ref={canvasRef} aria-hidden="true" className={`pointer-events-none h-full w-full ${className}`} data-apple-weather-scene={scene.id} />
}
