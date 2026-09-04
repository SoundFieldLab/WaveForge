/**
 * 系统音效波形可视化 —— Apple 风格
 *
 * 设计：中央对称的圆角频谱条（从中心线向上下伸展），琥珀金渐变 + 顶部高光，
 * 目标值经惯性平滑（lerp）产生缓慢流动感；背景中央径向光晕。
 * 无音效时以柔和正弦缓慢起伏，有音效时幅度与速度提升。
 */

import { useEffect, useRef } from 'react'
import type { HSETheme } from '../hse-theme'

const BAR_COUNT = 44

export function WaveformVisualizer({ theme, active }: { theme: HSETheme; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const phaseRef = useRef(0)
  const levelsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0.06))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let width = 0
    let height = 0
    let lastFrame = 0
    const dpr = Math.min(2, window.devicePixelRatio || 1)

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      canvas.width = Math.max(1, rect.width * dpr)
      canvas.height = Math.max(1, rect.height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      // 限 60fps：相位按帧固定步进（按 60fps 调参），高刷屏全速跑会让波形加速流动且白耗 GPU
      const now = performance.now()
      if (lastFrame && now - lastFrame < 1000 / 60) {
        raf = requestAnimationFrame(draw)
        return
      }
      lastFrame = now
      ctx.clearRect(0, 0, width, height)
      const cx = width / 2
      const cy = height / 2
      const accent = theme.accentColor

      // 背景中央光晕（径向渐变）
      const glowR = Math.min(width, height) * 0.55
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR)
      glow.addColorStop(0, `${accent}1f`)
      glow.addColorStop(1, `${accent}00`)
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, width, height)

      // 中央基准线
      ctx.strokeStyle = `${accent}33`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, cy)
      ctx.lineTo(width, cy)
      ctx.stroke()

      // 相位推进（有音效更快）
      phaseRef.current += active ? 0.055 : 0.012

      const maxH = height * 0.46
      const levels = levelsRef.current
      const xs: number[] = []
      const top: { x: number; y: number }[] = []
      const bot: { x: number; y: number }[] = []
      for (let i = 0; i < BAR_COUNT; i++) {
        // 目标振幅：多层正弦叠加（偶/奇谐波 + 慢速包络），有音效时更强
        const t = phaseRef.current
        const target = active
          ? 0.28 +
            Math.abs(Math.sin(i * 0.42 + t * 1.4)) * 0.34 +
            Math.abs(Math.sin(i * 0.19 - t * 0.9)) * 0.2 +
            Math.sin(i * 0.07 + t * 0.5) * 0.12
          : 0.05 + Math.abs(Math.sin(i * 0.5 + t * 0.8)) * 0.06 + Math.sin(i * 0.13 + t * 0.35) * 0.03
        const clamped = Math.min(1, Math.max(0.03, target))
        // 惯性平滑（缓慢流动，Apple 风格）
        levels[i] += (clamped - levels[i]) * (active ? 0.16 : 0.05)
        const v = levels[i]
        const x = (i / (BAR_COUNT - 1)) * width
        xs.push(x)
        top.push({ x, y: cy - v * maxH })
        bot.push({ x, y: cy + v * maxH })
      }

      // 平滑曲线辅助：中点二次贝塞尔（替代生硬柱状，模拟模拟电路柔和感）
      const smoothPath = (pts: { x: number; y: number }[], closeToBottom?: { x: number; y: number }, reverse?: boolean) => {
        ctx.beginPath()
        if (pts.length === 0) return
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2
          const yc = (pts[i].y + pts[i + 1].y) / 2
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc)
        }
        const last = pts[pts.length - 1]
        ctx.lineTo(last.x, last.y)
        if (closeToBottom) {
          ctx.lineTo(closeToBottom.x, closeToBottom.y)
          const first = reverse ? pts[pts.length - 1] : pts[0]
          ctx.lineTo(first.x, first.y)
          ctx.closePath()
        }
      }

      // 上半曲线 + 下半曲线闭合填充
      const fillGrad = ctx.createLinearGradient(0, cy - maxH, 0, cy + maxH)
      fillGrad.addColorStop(0, `${accent}cc`)
      fillGrad.addColorStop(0.5, `${accent}44`)
      fillGrad.addColorStop(1, `${accent}cc`)
      ctx.fillStyle = fillGrad
      // 闭合区域：上曲线左→右，沿底曲线右→左回
      ctx.beginPath()
      ctx.moveTo(top[0].x, top[0].y)
      for (let i = 1; i < top.length - 1; i++) {
        const xc = (top[i].x + top[i + 1].x) / 2
        const yc = (top[i].y + top[i + 1].y) / 2
        ctx.quadraticCurveTo(top[i].x, top[i].y, xc, yc)
      }
      ctx.lineTo(top[top.length - 1].x, top[top.length - 1].y)
      for (let i = bot.length - 1; i > 0; i--) {
        const xc = (bot[i].x + bot[i - 1].x) / 2
        const yc = (bot[i].y + bot[i - 1].y) / 2
        ctx.quadraticCurveTo(bot[i].x, bot[i].y, xc, yc)
      }
      ctx.lineTo(bot[0].x, bot[0].y)
      ctx.closePath()
      ctx.fill()

      // 上沿描边高光（霓虹微光）
      ctx.strokeStyle = accent
      ctx.lineWidth = 1.5
      ctx.lineJoin = 'round'
      ctx.shadowColor = accent
      ctx.shadowBlur = 6
      smoothPath(top)
      ctx.stroke()
      // 下沿描边（淡）
      ctx.shadowBlur = 0
      ctx.strokeStyle = `${accent}88`
      ctx.lineWidth = 1
      smoothPath(bot)
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }

    draw()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [theme.accentColor, active])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}
