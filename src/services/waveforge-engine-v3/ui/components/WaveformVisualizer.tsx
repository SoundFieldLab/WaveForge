import { useEffect, useRef } from 'react'
import type { V3UiBridge } from '../bridge'

const SAMPLE_COUNT = 512
const FRAME_INTERVAL_MS = 1000 / 30

function drawChannel(
  ctx: CanvasRenderingContext2D,
  samples: Float32Array | null,
  x: number,
  centerY: number,
  width: number,
  height: number,
  color: string,
  dpr: number,
) {
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x, centerY)

  if (samples && samples.length > 1) {
    const amplitude = Math.max(2, height * 0.34)
    const step = Math.max(1, Math.floor(samples.length / SAMPLE_COUNT))
    const pointCount = Math.ceil(samples.length / step)
    const points: { x: number; y: number }[] = []
    let pointIndex = 0

    for (let i = 0; i < samples.length; i += step) {
      const px = x + (pointIndex / Math.max(1, pointCount - 1)) * width
      const value = Number.isFinite(samples[i]) ? samples[i] : 0
      const py = centerY - Math.max(-1, Math.min(1, value)) * amplitude
      points.push({ x: px, y: py })
      ctx.lineTo(px, py)
      pointIndex++
    }

    const last = samples[samples.length - 1]
    const lastPoint = {
      x: x + width,
      y: centerY - Math.max(-1, Math.min(1, Number.isFinite(last) ? last : 0)) * amplitude,
    }
    ctx.lineTo(lastPoint.x, lastPoint.y)
    points.push(lastPoint)

    ctx.save()
    ctx.globalAlpha = 0.14
    ctx.fillStyle = color
    ctx.lineTo(x + width, centerY)
    ctx.lineTo(x, centerY)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
  }

  ctx.stroke()

  if (!samples?.length) {
    ctx.fillStyle = color
    ctx.globalAlpha = 0.7
    ctx.beginPath()
    ctx.arc(x + 4 * dpr, centerY, 2 * dpr, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }
}

/** Draws samples from the engine bridge in a private animation loop, without React renders. */
export function WaveformVisualizer({
  bridge,
  onSignalChange,
  onChannelChange,
}: {
  bridge: V3UiBridge
  onSignalChange?: (hasSignal: boolean) => void
  onChannelChange?: (hasRight: boolean | null) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const lastHasSignalRef = useRef(false)
  const lastHasRightRef = useRef<boolean | null>(null)
  const onSignalChangeRef = useRef(onSignalChange)
  const onChannelChangeRef = useRef(onChannelChange)

  onSignalChangeRef.current = onSignalChange
  onChannelChangeRef.current = onChannelChange

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return

    let raf = 0
    let lastFrame = 0
    let width = 0
    let height = 0
    let dpr = 1
    let left: Float32Array | null = null
    let right: Float32Array | null = null

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = rect.width
      height = rect.height
      dpr = Math.min(2, window.devicePixelRatio || 1)
      canvas.width = Math.max(1, Math.round(width * dpr))
      canvas.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    resize()
    const observer = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(resize)
      : null
    observer?.observe(canvas)

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      if (now - lastFrame < FRAME_INTERVAL_MS) return
      lastFrame = now

      const waveform = bridge.getWaveform?.() ?? null
      left = waveform?.left ?? null
      right = waveform?.right ?? null
      const hasSignal = Boolean(left?.length && left.some((sample) => Math.abs(sample) > 0.001))
        || Boolean(right?.length && right.some((sample) => Math.abs(sample) > 0.001))
      if (lastHasSignalRef.current !== hasSignal) {
        lastHasSignalRef.current = hasSignal
        canvas.dataset.hasSignal = String(hasSignal)
        onSignalChangeRef.current?.(hasSignal)
      }
      const hasRight = waveform ? waveform.right !== null : null
      if (lastHasRightRef.current !== hasRight) {
        lastHasRightRef.current = hasRight
        onChannelChangeRef.current?.(hasRight)
      }

      ctx.clearRect(0, 0, width, height)
      const labelWidth = 24
      const plotX = labelWidth
      const plotWidth = Math.max(0, width - labelWidth)
      const laneHeight = height / 2
      const leftY = laneHeight / 2
      const rightY = laneHeight + laneHeight / 2

      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.strokeStyle = '#dce9e5'
      for (const y of [leftY, rightY]) {
        ctx.beginPath()
        ctx.moveTo(plotX, y)
        ctx.lineTo(width, y)
        ctx.stroke()
      }

      drawChannel(ctx, left, plotX, leftY, plotWidth, laneHeight, '#006a63', dpr)
      drawChannel(ctx, right, plotX, rightY, plotWidth, laneHeight, '#416986', dpr)
    }

    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      observer?.disconnect()
    }
  }, [bridge])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="实时立体声音频波形，左声道 L，右声道 R"
      className="block h-full w-full"
      data-has-signal="false"
    />
  )
}
