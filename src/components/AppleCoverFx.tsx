/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useEffect, useRef } from 'react'

interface AppleCoverFxProps {
  /** 仅 Apple 命中的歌曲启用（封面粒子 + 动效） */
  enabled: boolean
  isPlaying: boolean
  /** 封面边长（CSS 像素） */
  size: number
  /** 封面圆角 */
  radius: number
  accentColor?: string
}

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  size: number
  alpha: number
  decay: number
  color: string
  phase: number
}

/** 节拍周期（与律动背景脉冲一致的 1.2s 时间驱动节拍） */
const BEAT_PERIOD = 1.2
// 高刷屏限 120fps：粒子每帧重绘开销大，120fps 与 240fps 肉眼无差异
const FRAME_MIN_INTERVAL_MS = 1000 / 120

const roundedRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/**
 * Apple Music 风格封面粒子动效：
 * - 每拍（1.2s 时间驱动）从封面中心向外迸发一批微光粒子，向上飘散淡出；
 * - 暂停时粒子缓慢消散，不消耗过多性能。
 */
export default function AppleCoverFx({ enabled, isPlaying, size, radius, accentColor = '#ffffff' }: AppleCoverFxProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const enabledRef = useRef(enabled)
  const playingRef = useRef(isPlaying)
  const sizeRef = useRef(size)
  const radiusRef = useRef(radius)
  const accentRef = useRef(accentColor)
  enabledRef.current = enabled
  playingRef.current = isPlaying
  sizeRef.current = size
  radiusRef.current = radius
  accentRef.current = accentColor

  useEffect(() => {
    if (!enabled) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    let elapsed = 0
    let particles: Particle[] = []
    let dpr = 1

    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(sizeRef.current * dpr))
      canvas.height = Math.max(1, Math.round(sizeRef.current * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()

    const spawn = (count: number) => {
      const size = sizeRef.current
      const palette = [accentRef.current, '#ffe3b8', '#ffffff', '#fff3d6']
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2
        const dist = size * (0.08 + Math.random() * 0.44)
        particles.push({
          x: size / 2 + Math.cos(angle) * dist,
          y: size / 2 + Math.sin(angle) * dist,
          vx: (Math.random() - 0.5) * 8,
          vy: -(3 + Math.random() * 16),
          size: 0.8 + Math.random() * 2.1,
          alpha: 0.35 + Math.random() * 0.45,
          decay: 0.012 + Math.random() * 0.02,
          color: palette[Math.floor(Math.random() * palette.length)],
          phase: Math.random() * Math.PI * 2,
        })
      }
    }

    const tick = (now: number) => {
      if (!enabledRef.current) {
        raf = 0
        return
      }
      // 限 120fps：dt 由实际执行的帧间隔计算，跳帧不影响粒子运动
      if (now - last < FRAME_MIN_INTERVAL_MS) {
        raf = requestAnimationFrame(tick)
        return
      }
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const currentSize = sizeRef.current

      if (playingRef.current) {
        elapsed += dt
        if (elapsed >= BEAT_PERIOD) {
          elapsed = 0
          spawn(6 + Math.floor(Math.random() * 4))
        }
      }

      ctx.clearRect(0, 0, currentSize, currentSize)
      ctx.save()
      roundedRectPath(ctx, 0, 0, currentSize, currentSize, radiusRef.current)
      ctx.clip()

      if (particles.length > 0) {
        particles.forEach(particle => {
          particle.x += particle.vx * dt
          particle.y += particle.vy * dt
          if (playingRef.current) particle.vy *= 1 - dt * 0.5
          else particle.vy *= 1 - dt * 1.4
          particle.alpha -= particle.decay * (playingRef.current ? 1 : 2.4)
          const twinkle = 0.65 + 0.35 * Math.sin(particle.phase + now / 380)
          const alpha = Math.max(0, particle.alpha)
          ctx.globalAlpha = alpha * twinkle
          ctx.fillStyle = particle.color
          ctx.beginPath()
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalAlpha = alpha * 0.45 * twinkle
          ctx.beginPath()
          ctx.arc(particle.x, particle.y, particle.size * 2.8, 0, Math.PI * 2)
          ctx.fill()
        })
        particles = particles.filter(particle => particle.alpha > 0.01 && particle.y > -14)
      }
      ctx.globalAlpha = 1
      ctx.restore()

      // 窗口隐藏、或无粒子且未播放时停帧，避免 60fps 空转（Electron backgroundThrottling 关闭）
      if (enabledRef.current && document.visibilityState !== 'hidden' && (playingRef.current || particles.length > 0)) {
        raf = requestAnimationFrame(tick)
      } else {
        raf = 0
      }
    }

    raf = requestAnimationFrame(tick)
    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    const onVisibilityChange = () => {
      // 窗口恢复可见时若已停帧则重启
      if (enabledRef.current && document.visibilityState === 'visible' && raf === 0) {
        raf = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      observer.disconnect()
    }
  }, [enabled])

  if (!enabled) return null
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ borderRadius: radius, zIndex: 5 }}
    />
  )
}
