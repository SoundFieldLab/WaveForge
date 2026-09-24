import { useEffect, useRef } from 'react'
import { APPLE_WEATHER_SCENES, APPLE_WEATHER_TEXTURES } from './appleWeatherAssets.generated'
import type { AppleWeatherSceneModel } from './weatherSceneModel'

interface AppleWeatherCompactSceneProps {
  scene: AppleWeatherSceneModel
  active?: boolean
  reducedMotion?: boolean
  className?: string
  onReady?: () => void
  onUnavailable?: () => void
}


const COMPACT_PALETTES = {
  day: {
    clear: ['#176fc4', '#5aaee9', '#bfe0f4'], 'partly-cloudy': ['#2f7fbe', '#78b6d8', '#c3dce7'], cloudy: ['#526b7c', '#8298a6', '#c1cbd0'], fog: ['#737b7d', '#a7aaa5', '#d0d0c7'],
    drizzle: ['#315e76', '#6b8e9f', '#b6c8ce'], rain: ['#1b4057', '#527486', '#a0b4ba'], 'heavy-rain': ['#112c40', '#3b5a6b', '#718790'], thunder: ['#4b5660', '#68747d', '#8a9398'], snow: ['#7c8f9e', '#afbec8', '#dce2e5'],
  },
  night: {
    clear: ['#030a17', '#102a51', '#315d8a'], 'partly-cloudy': ['#061124', '#1a3453', '#3e5c74'], cloudy: ['#0b1420', '#263746', '#52616c'], fog: ['#11171c', '#333c43', '#636b6d'],
    drizzle: ['#071625', '#203b4e', '#4d6875'], rain: ['#050e1a', '#1a3144', '#425c6b'], 'heavy-rain': ['#030914', '#112638', '#334d5d'], thunder: ['#070a16', '#242d3b', '#4c5563'], snow: ['#131d28', '#354452', '#687681'],
  },
} as const

const makeRandom = (seed: number) => {
  let value = seed || 1
  return () => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value / 0x100000000
  }
}

const imageCache = new Map<string, Promise<HTMLImageElement | null>>()
const loadImage = (name: string) => {
  const url = APPLE_WEATHER_TEXTURES[name]?.url
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

const drawAtlasFrame = (ctx: CanvasRenderingContext2D, image: HTMLImageElement, frame: number, columns: number, rows: number, x: number, y: number, width: number, height: number) => {
  const column = frame % columns
  const row = Math.floor(frame / columns) % rows
  const sw = image.naturalWidth / columns
  const sh = image.naturalHeight / rows
  ctx.drawImage(image, column * sw, row * sh, sw, sh, x, y, width, height)
}

const drawCover = (ctx: CanvasRenderingContext2D, image: HTMLImageElement, width: number, height: number, targetWidth: number, targetHeight: number, offsetX = 0) => {
  const scale = Math.max(targetWidth / width, targetHeight / height)
  const drawWidth = width * scale
  const drawHeight = height * scale
  ctx.drawImage(image, (targetWidth - drawWidth) / 2 + offsetX, (targetHeight - drawHeight) / 2, drawWidth, drawHeight)
}

const sceneAssetNames = (scene: AppleWeatherSceneModel) => {
  const suffix = scene.isDay && scene.kind === 'partly-cloudy' ? 'Blue' : 'Neutral'
  if (scene.kind === 'clear') return scene.isDay ? ['Sun-Left.heic', 'Ray-Cyan.heic', 'Lens-Flare-Medium.heic'] : ['Star-Frames.heic', 'Meteor.heic']
  if (scene.kind === 'partly-cloudy') return scene.isDay ? ['Sun-Left.heic', `Cumulus-One-${suffix}.heic`, `Cumulus-Two-${suffix}.heic`, 'Ray-Cyan.heic'] : ['Star-Frames.heic', `Cumulus-One-${suffix}.heic`, `Cumulus-Two-${suffix}.heic`]
  if (scene.kind === 'cloudy') return ['Cloudy-Background-One.heic', 'Cumulus-One-Neutral.heic', 'Cumulus-Two-Neutral.heic', 'Fringe-Large-Neutral.heic']
  if (scene.kind === 'fog') return ['Cloud-Patch-One.heic']
  if (scene.kind === 'drizzle') return ['Cloud-Drizzle.heic', 'Raindrop.heic']
  if (scene.kind === 'rain' || scene.kind === 'heavy-rain') return ['Raindrop-Tile-Heavy.heic', 'Raindrop.heic']
  if (scene.kind === 'thunder') return [scene.isDay ? 'Thunderstorm-Day-Main.heic' : 'Thunderstorm-Night-Main.heic', scene.isDay ? 'Thunderstorm-Day-Flicker-01.heic' : 'Thunderstorm-Night-Flicker-01.heic', 'Raindrop.heic']
  return ['Snow-Flake-Small.heic']
}

export default function AppleWeatherCompactScene({ scene, active = true, reducedMotion = false, className = '', onReady, onUnavailable }: AppleWeatherCompactSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const activeRef = useRef(active)
  const startLoopRef = useRef<(() => void) | null>(null)
  const stopLoopRef = useRef<(() => void) | null>(null)
  activeRef.current = active
  useEffect(() => {
    if (active) startLoopRef.current?.()
    else stopLoopRef.current?.()
  }, [active])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) {
      onUnavailable?.()
      return
    }

    let disposed = false
    let raf = 0
    let visible = true
    let width = 1
    let height = 1
    let dpr = 1
    let last = 0
    const random = makeRandom(scene.seed ^ 0x51f15e)
    const assets = sceneAssetNames(scene)
    const source = APPLE_WEATHER_SCENES[scene.id as keyof typeof APPLE_WEATHER_SCENES]
    if (!source || assets.length === 0) {
      onUnavailable?.()
      return
    }

    const denseRain = scene.kind === 'heavy-rain' || scene.kind === 'thunder'
    const rainCount = scene.kind === 'drizzle' ? 28 : denseRain ? 90 : 56
    const snowCount = scene.kind === 'snow' ? 48 : 0
    const starCount = !scene.isDay && (scene.kind === 'clear' || scene.kind === 'partly-cloudy') ? 32 : 0
    const particles = (count: number, type: 'rain' | 'snow' | 'star') => Array.from({ length: count }, () => ({
      x: random(), y: random(), size: type === 'rain' ? 0.6 + random() * 1.4 : type === 'star' ? 0.8 + random() * 1.5 : 0.8 + random() * 1.8,
      speed: type === 'rain' ? 0.65 + random() * 0.9 : type === 'snow' ? 0.025 + random() * 0.035 : 0,
      drift: random() * 2 - 1, phase: random() * Math.PI * 2, alpha: 0.28 + random() * 0.62,
    }))
    const rain = particles(rainCount, 'rain')
    const snow = particles(snowCount, 'snow')
    const stars = particles(starCount, 'star')

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      dpr = Math.min(window.devicePixelRatio || 1, width < 280 ? 1.25 : 1.5)
      const nextWidth = Math.round(width * dpr)
      const nextHeight = Math.round(height * dpr)
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth
        canvas.height = nextHeight
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'medium'
    }

    const render = (images: Map<string, HTMLImageElement>, now: number) => {
      const palette = COMPACT_PALETTES[scene.isDay ? 'day' : 'night'][scene.kind]
      const gradient = ctx.createLinearGradient(0, 0, width, height)
      gradient.addColorStop(0, palette[0])
      gradient.addColorStop(0.56, palette[1])
      gradient.addColorStop(1, palette[2])
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, width, height)
      const t = reducedMotion ? 48 : now / 1000
      const image = (name: string) => images.get(name)

      if (starCount) {
        const starImage = image('Star-Frames.heic')
        ctx.globalCompositeOperation = 'lighter'
        for (const star of stars) {
          ctx.globalAlpha = star.alpha * (0.55 + 0.35 * Math.sin(t * 1.2 + star.phase))
          const size = star.size * Math.max(0.8, width / 270)
          if (starImage) drawAtlasFrame(ctx, starImage, Math.floor(star.phase * 2), 2, 4, star.x * width, star.y * height * 0.78, size * 4, size * 4)
          else { ctx.fillStyle = '#fff'; ctx.fillRect(star.x * width, star.y * height, size, size) }
        }
      }

      if (scene.isDay && (scene.kind === 'clear' || scene.kind === 'partly-cloudy')) {
        const sun = image('Sun-Left.heic')
        if (sun) {
          const size = Math.min(width, height) * 0.66
          ctx.globalCompositeOperation = 'screen'
          ctx.globalAlpha = 0.95
          ctx.drawImage(sun, -size * 0.1, -size * 0.08, size, size)
        }
        const ray = image('Ray-Cyan.heic')
        if (ray) {
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.globalAlpha = 0.25
          ctx.translate(width * 0.08, height * 0.04)
          ctx.rotate(-0.74 + Math.sin(t * 0.7) * 0.03)
          ctx.drawImage(ray, 0, 0, Math.max(25, width * 0.14), height * 0.95)
          ctx.restore()
        }
      }

      if (scene.kind === 'cloudy') {
        const background = image('Cloudy-Background-One.heic')
        if (background) {
          ctx.globalCompositeOperation = scene.isDay ? 'screen' : 'source-over'
          ctx.globalAlpha = scene.isDay ? 0.68 : 0.45
          const drawHeight = height * 0.64
          const drawWidth = drawHeight * (background.naturalWidth / background.naturalHeight)
          const offset = -((t * width / 360) % Math.max(1, drawWidth / 3))
          for (let repeat = -1; repeat < 4; repeat += 1) ctx.drawImage(background, offset + repeat * drawWidth, 0, drawWidth, drawHeight)
        }
      }

      if (scene.kind === 'partly-cloudy' || scene.kind === 'cloudy') {
        const suffix = scene.isDay && scene.kind === 'partly-cloudy' ? 'Blue' : 'Neutral'
        const one = image(`Cumulus-One-${suffix}.heic`)
        const two = image(`Cumulus-Two-${suffix}.heic`)
        const fringe = image(`Fringe-Large-${suffix}.heic`)
        ctx.globalCompositeOperation = 'source-over'
        if (one) { ctx.globalAlpha = 0.74; const w = width * 0.92; drawAtlasFrame(ctx, one, 0, 2, 2, ((-t * width * 0.015) % (width * 1.8)) - width * 0.25, height * 0.14, w, w * 0.48) }
        if (two) { ctx.globalAlpha = 0.64; const w = width * 1.1; drawAtlasFrame(ctx, two, 1, 2, 2, ((-t * width * 0.012) % (width * 1.8)) - width * 0.1, height * 0.3, w, w * 0.5) }
        if (fringe) { ctx.globalAlpha = 0.32; const w = width * 0.75; drawAtlasFrame(ctx, fringe, 2, 4, 2, ((-t * width * 0.024) % (width * 1.7)) - width * 0.18, height * 0.2, w, w * 0.5) }
      }

      if (scene.kind === 'drizzle') {
        const cloud = image('Cloud-Drizzle.heic')
        if (cloud) { ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = scene.isDay ? 0.8 : 0.58; drawCover(ctx, cloud, cloud.naturalWidth, cloud.naturalHeight, width, height * 0.72, Math.sin(t / 20) * width * 0.03) }
      }

      if (scene.kind === 'fog') {
        const patch = image('Cloud-Patch-One.heic')
        if (patch) {
          ctx.globalCompositeOperation = 'screen'
          for (let index = 0; index < 3; index += 1) {
            ctx.globalAlpha = scene.isDay ? 0.12 : 0.08
            const size = width * (0.72 + index * 0.1)
            const x = ((-t * width * 0.012 + index * width * 0.42) % (width + size)) - size
            drawAtlasFrame(ctx, patch, index, 2, 2, x, height * (0.16 + index * 0.2), size, size * 0.72)
          }
        }
      }

      if (scene.kind === 'thunder') {
        const main = image(scene.isDay ? 'Thunderstorm-Day-Main.heic' : 'Thunderstorm-Night-Main.heic')
        if (main) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = scene.isDay ? 0.78 : 0.62; drawCover(ctx, main, main.naturalWidth, main.naturalHeight, width, height * 0.72, -((t * 8) % Math.max(1, width * 0.15))) }
        const flicker = image(scene.isDay ? 'Thunderstorm-Day-Flicker-01.heic' : 'Thunderstorm-Night-Flicker-01.heic')
        const pulse = (Math.sin(t * 0.42 + scene.seed) + 1) / 2
        if (flicker && pulse > 0.975) { ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = (pulse - 0.975) * 35; drawCover(ctx, flicker, flicker.naturalWidth, flicker.naturalHeight, width, height * 0.7) }
      }

      if (scene.kind === 'rain' || scene.kind === 'heavy-rain' || scene.kind === 'thunder' || scene.kind === 'drizzle') {
        const drop = image('Raindrop.heic')
        ctx.globalCompositeOperation = 'screen'
        const speedScale = scene.kind === 'drizzle' ? 0.55 : denseRain ? 1.12 : 0.82
        for (const particle of rain) {
          const y = ((particle.y + t * particle.speed * speedScale) % 1.22) * height - height * 0.12
          const x = (particle.x * width + y * 0.035 + particle.drift * 12 + width) % width
          const dropHeight = (scene.kind === 'drizzle' ? 11 : denseRain ? 28 : 20) * particle.size
          ctx.globalAlpha = particle.alpha * (scene.kind === 'drizzle' ? 0.26 : 0.42)
          if (drop) ctx.drawImage(drop, x, y, Math.max(1, dropHeight * 0.1), dropHeight)
        }
      }

      if (scene.kind === 'snow') {
        const flake = image('Snow-Flake-Small.heic')
        ctx.globalCompositeOperation = 'screen'
        for (const particle of snow) {
          const y = ((particle.y + t * particle.speed) % 1.12) * height - height * 0.06
          const x = (particle.x * width + Math.sin(t * 0.7 + particle.phase) * width * 0.06 + particle.drift * y * 0.06 + width) % width
          const size = (1.4 + particle.size * 3.2) * Math.max(0.8, width / 280)
          ctx.globalAlpha = particle.alpha * 0.78
          if (flake) ctx.drawImage(flake, x, y, size, size)
        }
      }

      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      const shade = ctx.createLinearGradient(0, 0, 0, height)
      shade.addColorStop(0, 'rgba(255,255,255,0.035)')
      shade.addColorStop(0.62, 'rgba(0,0,0,0)')
      shade.addColorStop(1, 'rgba(0,8,18,0.24)')
      ctx.fillStyle = shade
      ctx.fillRect(0, 0, width, height)
    }

    const stop = () => { cancelAnimationFrame(raf); raf = 0 }
    const start = (images: Map<string, HTMLImageElement>) => {
      if (disposed || reducedMotion || !activeRef.current || !visible || raf) return
      last = performance.now()
      const tick = (now: number) => {
        raf = 0
        if (disposed || document.hidden || !activeRef.current || !visible) return
        if (now - last >= 1000 / 30) { last = now; render(images, now) }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    Promise.all(assets.map(async name => [name, await loadImage(name)] as const)).then(entries => {
      if (disposed) return
      const images = new Map(entries.filter((entry): entry is [string, HTMLImageElement] => Boolean(entry[1])))
      const required = assets[0]
      if (!images.has(required)) { onUnavailable?.(); return }
      resize()
      render(images, 0)
      onReady?.()
      if (!reducedMotion) start(images)
      const resizeObserver = new ResizeObserver(() => resize())
      resizeObserver.observe(canvas)
      const intersectionObserver = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
        visible = entries[0]?.isIntersecting ?? true
        if (visible) { resize(); start(images) } else stop()
      }, { threshold: 0.05 })
      intersectionObserver?.observe(canvas)
    startLoopRef.current = () => start(images)
    stopLoopRef.current = stop
    cleanup = () => {
      startLoopRef.current = null
      stopLoopRef.current = null
      resizeObserver.disconnect()
      intersectionObserver?.disconnect()
    }
    }).catch(() => onUnavailable?.())

    let cleanup = () => undefined
    const visibility = () => document.hidden ? stop() : undefined
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      stop()
      cleanup()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [onReady, onUnavailable, reducedMotion, scene])

  return <canvas ref={canvasRef} aria-hidden="true" data-apple-weather-compact-scene={scene.id} className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />
}
