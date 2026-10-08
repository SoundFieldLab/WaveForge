import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { isTvModeActive } from '../platform'
import { isPerfModeEnhanced } from '../tv/perfMode'

/**
 * 登录弹窗共用的动态背景：
 * 渐变底 → 三色光晕（景深）→ 光带 → 漂浮粒子 → 暗角/遮罩。
 * 所有装饰层都用 transform/opacity 动画（GPU 友好）；TV 弱 GPU 下切换为静态版本。
 * 网易云/QQ（LoginView）与酷狗/汽水/Spotify 等独立登录弹窗共用，保证风格统一。
 */

interface GlowSpec {
  size: string
  color: string
  top: string
  left: string
  duration: number
  drift: number[]
  lift: number[]
}

const GLOWS: GlowSpec[] = [
  { size: '46vw', color: 'rgba(255, 105, 180, 0.45)', top: '10%', left: '6%', duration: 14, drift: [0, 70, 0], lift: [0, 40, 0] },
  { size: '40vw', color: 'rgba(122, 92, 255, 0.42)', top: '44%', left: '58%', duration: 18, drift: [0, -60, 0], lift: [0, -45, 0] },
  { size: '32vw', color: 'rgba(0, 190, 255, 0.28)', top: '62%', left: '16%', duration: 22, drift: [0, 50, 0], lift: [0, -30, 0] },
]

// 确定性伪随机：避免每次渲染重新洗牌（粒子会跳）
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** 单个光晕（radial-gradient 自带羽化，无需 filter blur 也够柔和） */
function Glow({ spec, animated }: { spec: GlowSpec; animated: boolean }) {
  return (
    <motion.div
      className="absolute rounded-full pointer-events-none"
      style={{
        width: spec.size,
        height: spec.size,
        top: spec.top,
        left: spec.left,
        background: `radial-gradient(circle, ${spec.color} 0%, transparent 68%)`,
        filter: animated ? 'blur(40px)' : 'blur(24px)',
        willChange: 'transform',
      }}
      animate={animated ? { x: spec.drift, y: spec.lift, scale: [1, 1.15, 1] } : undefined}
      transition={animated ? { duration: spec.duration, repeat: Infinity, ease: 'easeInOut' } : undefined}
    />
  )
}

/** 漂浮光点（粒子） */
function Particles({ animated }: { animated: boolean }) {
  const dots = useMemo(() => Array.from({ length: 22 }, (_, i) => ({
    left: `${seeded(i, 11) * 100}%`,
    top: `${40 + seeded(i, 12) * 60}%`,
    size: 2 + Math.round(seeded(i, 13) * 4),
    rise: 120 + seeded(i, 14) * 260,
    drift: (seeded(i, 15) - 0.5) * 80,
    duration: 9 + seeded(i, 16) * 12,
    delay: seeded(i, 17) * 10,
    opacity: 0.25 + seeded(i, 18) * 0.4,
    tint: seeded(i, 19) > 0.6 ? 'rgba(255,170,220,0.9)' : seeded(i, 19) > 0.3 ? 'rgba(180,160,255,0.9)' : 'rgba(150,220,255,0.85)',
  })), [])
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {dots.map((d, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full"
          style={{
            left: d.left,
            top: d.top,
            width: d.size,
            height: d.size,
            background: d.tint,
            boxShadow: `0 0 ${d.size * 3}px ${d.tint}`,
            opacity: animated ? undefined : d.opacity * 0.7,
            willChange: 'transform, opacity',
          }}
          animate={animated ? { y: [0, -d.rise], x: [0, d.drift, 0], opacity: [0, d.opacity, 0] } : undefined}
          transition={animated ? { duration: d.duration, repeat: Infinity, ease: 'linear', delay: d.delay } : undefined}
        />
      ))}
    </div>
  )
}

export default function LoginBackdrop() {
  // TV 弱 GPU：装饰性光晕/粒子非增强档一律静态化，避免持续合成开销
  const animated = !isTvModeActive() || isPerfModeEnhanced()
  return (
    <>
      {/* 渐变底 */}
      <motion.div
        className="absolute inset-0"
        animate={{
          background: [
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #3d1b2d 0%, #2e0f1a 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #1b2d3d 0%, #141026 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
          ],
        }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* 三色光晕（景深） */}
      {GLOWS.map((spec, i) => <Glow key={i} spec={spec} animated={animated} />)}

      {/* 斜向光带 */}
      <div
        className="absolute -top-1/4 left-1/5 w-[46vw] h-[150vh] rotate-[24deg] pointer-events-none"
        style={{ background: 'linear-gradient(to bottom, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.015) 45%, transparent 100%)' }}
      />

      {/* 漂浮粒子 */}
      <Particles animated={animated} />

      {/* 暗角 + 遮罩：卡片区域更聚焦 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 35%, rgba(0,0,0,0.45) 100%)' }}
      />
      <div className="absolute inset-0 bg-black/15" />
    </>
  )
}
