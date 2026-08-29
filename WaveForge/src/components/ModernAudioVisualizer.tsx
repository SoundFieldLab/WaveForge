import { motion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import { type AudioPulseStore } from '../hooks/useAudioPulse'

interface ModernAudioVisualizerProps {
  analyser: AnalyserNode | null
  isPlaying: boolean
  accentColor: string
  palette?: string[]
  playerTheme: 'dark' | 'light'
  pulseStore: AudioPulseStore
}

const BAR_COUNT = 64
const MIN_FREQUENCY = 45
const MAX_FREQUENCY = 16000
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const frequencyToMel = (frequency: number) => 2595 * Math.log10(1 + frequency / 700)
const melToFrequency = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1)

export default function ModernAudioVisualizer({
  analyser,
  isPlaying,
  accentColor,
  palette = [],
  playerTheme,
  pulseStore,
}: ModernAudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pulseSurfaceRef = useRef<HTMLDivElement | null>(null)
  const pulseGlowRef = useRef<HTMLDivElement | null>(null)
  const playingRef = useRef(isPlaying)
  const levelsRef = useRef(new Float32Array(BAR_COUNT))
  const previousTargetsRef = useRef(new Float32Array(BAR_COUNT))
  const sustainedLevelsRef = useRef(new Float32Array(BAR_COUNT))
  // Reuse the per-frame target buffer to avoid allocations at 30 FPS.
  const targetsBufferRef = useRef(new Float32Array(BAR_COUNT))
  const paletteKey = palette.join('|')
  const visualColors = useMemo(
    () => [accentColor, ...palette].filter((color, index, colors) => color && colors.indexOf(color) === index),
    // paletteKey keeps the effect stable when a parent recreates an equivalent palette array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accentColor, paletteKey],
  )
  const secondaryColor = visualColors[1] || accentColor

  useEffect(() => {
    playingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    const applyPulse = () => {
      const surface = pulseSurfaceRef.current
      const glow = pulseGlowRef.current
      const canvas = canvasRef.current
      if (!surface || !glow) return
      const restlessPulse = pulseStore.getSnapshot().restless
      const scale = 1 + restlessPulse * 0.028
      surface.style.transform = `translate3d(0, 0, 0) scale(${scale})`
      // 亮度改作用到画布（无 backdrop-filter），避免每次脉冲重栅格化 blur(28px) 背景
      if (canvas) canvas.style.filter = `brightness(${1 + restlessPulse * 0.08})`
      glow.style.opacity = String(Math.min(0.62, restlessPulse * 0.48))
      glow.style.transform = `translate3d(0, 0, 0) scale(${1 + restlessPulse * 0.04})`
    }

    applyPulse()
    return pulseStore.subscribe(applyPulse)
  }, [pulseStore])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const context = canvas.getContext('2d')
    if (!context) return

    const frequencyData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null
    const startBins = new Uint16Array(BAR_COUNT)
    const endBins = new Uint16Array(BAR_COUNT)
    const nyquist = analyser ? analyser.context.sampleRate / 2 : 24000
    const upperFrequency = Math.min(MAX_FREQUENCY, nyquist * 0.94)
    const minimumMel = frequencyToMel(MIN_FREQUENCY)
    const maximumMel = frequencyToMel(upperFrequency)
    if (frequencyData) {
      for (let index = 0; index < BAR_COUNT; index += 1) {
        const startRatio = index / BAR_COUNT
        const endRatio = (index + 1) / BAR_COUNT
        const startFrequency = melToFrequency(minimumMel + (maximumMel - minimumMel) * startRatio)
        const endFrequency = melToFrequency(minimumMel + (maximumMel - minimumMel) * endRatio)
        startBins[index] = Math.max(1, Math.floor(startFrequency / nyquist * frequencyData.length))
        endBins[index] = Math.min(frequencyData.length, Math.max(startBins[index] + 1, Math.ceil(endFrequency / nyquist * frequencyData.length)))
      }
    }
    const size = { width: 0, height: 0 }
    let animationFrame = 0
    let lastSample = 0
    let disposed = false
    // 渐变对象只依赖画布宽度与配色（配色在 effect 生命周期内不变），按宽度缓存；避免每帧新建 CanvasGradient 造成持续分配
    let cachedBarGradientWidth = -1
    let cachedBarGradient: CanvasGradient | null = null
    let cachedCenterLineGradient: CanvasGradient | null = null

    const resize = () => {
      const bounds = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      size.width = Math.max(1, bounds.width)
      size.height = Math.max(1, bounds.height)
      canvas.width = Math.round(size.width * dpr)
      canvas.height = Math.round(size.height * dpr)
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(canvas)
    resize()

    const draw = (now: number) => {
      if (disposed) return
      // 窗口隐藏时停帧：Electron backgroundThrottling 关闭后 rAF 在后台仍全速执行，
      // 避免隐藏播放时 30fps canvas 空转（与 useAudioAnalyzer 的可见性门控一致）
      if (document.visibilityState === 'hidden') return
      if (now - lastSample < 1000 / 30) {
        animationFrame = requestAnimationFrame(draw)
        return
      }
      lastSample = now
      {
        if (analyser && frequencyData && playingRef.current) {
          analyser.getByteFrequencyData(frequencyData)
        }

        const levels = levelsRef.current

        const targets = targetsBufferRef.current
        targets.fill(0)

        if (frequencyData && playingRef.current) {
          for (let index = 0; index < BAR_COUNT; index += 1) {
            const startBin = startBins[index]
            const endBin = endBins[index]
            let sum = 0
            let sumSquares = 0
            let peak = 0
            let samples = 0

            for (let bin = startBin; bin < endBin; bin += 1) {
              const value = frequencyData[bin] / 255
              sum += value
              sumSquares += value * value
              peak = Math.max(peak, value)
              samples += 1
            }

            const average = samples > 0 ? sum / samples : 0
            const rms = samples > 0 ? Math.sqrt(sumSquares / samples) : 0
            const frequencyRatio = index / (BAR_COUNT - 1)
            const bassControl = 0.66 + Math.min(1, frequencyRatio / 0.22) * 0.32
            const highLift = 1 + Math.pow(frequencyRatio, 1.3) * 0.28
            const energy = (average * 0.38 + rms * 0.44 + peak * 0.18) * bassControl * highLift
            targets[index] = Math.pow(clamp((energy - 0.035) / 0.82), 1.9)
          }
        }

        for (let index = 0; index < BAR_COUNT; index += 1) {
          let target = 0

          if (playingRef.current) {
            let neighborhood = 0
            let neighbors = 0
            for (let offset = -2; offset <= 2; offset += 1) {
              const neighborIndex = index + offset
              if (neighborIndex < 0 || neighborIndex >= BAR_COUNT) continue
              neighborhood += targets[neighborIndex]
              neighbors += 1
            }

            const localAverage = neighborhood / Math.max(1, neighbors)
            const spectralDetail = Math.max(0, targets[index] - localAverage)
            const transient = Math.max(0, targets[index] - previousTargetsRef.current[index])
            const sustained = sustainedLevelsRef.current[index]
            const baselineResponse = targets[index] > sustained ? 0.025 : 0.009
            sustainedLevelsRef.current[index] += (targets[index] - sustained) * baselineResponse
            const energyAboveBaseline = Math.max(0, targets[index] - sustainedLevelsRef.current[index] * 0.55)
            target = clamp(
              targets[index] * 0.24
              + energyAboveBaseline * 0.4
              + spectralDetail * 0.58
              + transient * 0.88,
              0,
              0.94
            )
            previousTargetsRef.current[index] += (targets[index] - previousTargetsRef.current[index]) * 0.34
          } else {
            previousTargetsRef.current[index] *= 0.82
            sustainedLevelsRef.current[index] *= 0.985
          }

          const response = target > levels[index] ? 0.52 : 0.28
          levels[index] += (target - levels[index]) * response
          if (!playingRef.current && levels[index] < 0.008) levels[index] = 0
        }
      }

      const width = size.width
      const height = size.height
      context.clearRect(0, 0, width, height)

      const levels = levelsRef.current
      const gap = 1.7
      const barWidth = Math.max(1, (width - gap * (BAR_COUNT - 1)) / BAR_COUNT)
      const maxBarHeight = height - 9
      if (cachedBarGradientWidth !== width) {
        cachedBarGradientWidth = width
        const gradient = context.createLinearGradient(0, 0, width, 0)
        if (visualColors.length === 1) {
          gradient.addColorStop(0, accentColor)
          gradient.addColorStop(0.5, 'rgba(255,255,255,0.92)')
          gradient.addColorStop(1, accentColor)
        } else {
          visualColors.forEach((color, index) => {
            gradient.addColorStop(index / Math.max(1, visualColors.length - 1), color)
          })
        }
        cachedBarGradient = gradient
        const centerLine = context.createLinearGradient(0, 0, width, 0)
        centerLine.addColorStop(0, 'rgba(170,176,192,0)')
        centerLine.addColorStop(0.12, 'rgba(170,176,192,0.32)')
        centerLine.addColorStop(0.88, 'rgba(170,176,192,0.32)')
        centerLine.addColorStop(1, 'rgba(170,176,192,0)')
        cachedCenterLineGradient = centerLine
      }
      context.fillStyle = cachedBarGradient || 'rgba(255,255,255,0.5)'

      // Draw the glow as one combined path. Applying a blur separately to all 64
      // bars forced dozens of shadow rasters per frame; this keeps the same halo
      // and the same bar animation with one shadow pass.
      let maximumLevel = 0
      context.save()
      context.beginPath()
      for (let index = 0; index < BAR_COUNT; index += 1) {
        const level = levels[index]
        maximumLevel = Math.max(maximumLevel, level)
        const barHeight = Math.max(2.5, 3 + level * maxBarHeight)
        const x = index * (barWidth + gap)
        const y = (height - barHeight) / 2
        context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 1.8))
      }
      context.globalAlpha = 0.16 + maximumLevel * 0.22
      context.shadowColor = accentColor
      context.shadowBlur = 7 + maximumLevel * 5
      context.fill()
      context.restore()

      context.shadowBlur = 0
      for (let index = 0; index < BAR_COUNT; index += 1) {
        const level = levels[index]
        const barHeight = Math.max(2.5, 3 + level * maxBarHeight)
        const x = index * (barWidth + gap)
        const y = (height - barHeight) / 2
        context.globalAlpha = 0.24 + level * 0.76
        context.beginPath()
        context.roundRect(x, y, barWidth, barHeight, Math.min(barWidth / 2, 1.8))
        context.fill()
      }

      context.fillStyle = cachedCenterLineGradient || 'rgba(170,176,192,0.3)'
      context.globalAlpha = playingRef.current ? 0.72 : 0.44
      context.fillRect(0, Math.floor(height / 2), width, 1)
      context.globalAlpha = 1
      const hasVisibleMotion = playingRef.current || maximumLevel > 0
      if (hasVisibleMotion && document.visibilityState === 'visible') animationFrame = requestAnimationFrame(draw)
    }

    const onVisibilityChange = () => {
      // 窗口恢复可见时若此前已停帧，则重启循环
      if (document.visibilityState === 'visible' && !disposed && animationFrame === 0) {
        animationFrame = requestAnimationFrame(draw)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    animationFrame = requestAnimationFrame(draw)
    return () => {
      disposed = true
      cancelAnimationFrame(animationFrame)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      resizeObserver.disconnect()
    }
  }, [analyser, accentColor, paletteKey, isPlaying])

  return (
    <motion.div
      initial={{ opacity: 0, x: -18, filter: 'blur(8px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: -18, filter: 'blur(8px)' }}
      transition={{ duration: 0.42, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden="true"
      className="pointer-events-none fixed bottom-8 left-8 z-40 h-20 w-[clamp(250px,25vw,360px)] max-xl:bottom-28 max-md:left-4 max-md:w-[calc(100vw-2rem)]"
    >
      <div
        ref={pulseGlowRef}
        className="absolute -inset-1 rounded-[1.75rem]"
        style={{
          opacity: 0,
          background: `color-mix(in srgb, ${accentColor} 54%, transparent)`,
          filter: 'blur(18px)',
          transition: 'opacity 0.14s ease-out, transform 0.14s ease-out',
          willChange: 'opacity, transform',
        }}
      />
      <div
        ref={pulseSurfaceRef}
        className="relative h-full w-full overflow-hidden rounded-3xl border px-4 py-2.5"
        style={{
          borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.3)',
          background: playerTheme === 'dark'
            ? `radial-gradient(ellipse at 18% 50%, color-mix(in srgb, ${accentColor} 24%, transparent), transparent 58%), radial-gradient(ellipse at 82% 50%, color-mix(in srgb, ${secondaryColor} 20%, transparent), transparent 58%), rgba(5,7,14,0.2)`
            : `radial-gradient(ellipse at 18% 50%, color-mix(in srgb, ${accentColor} 19%, transparent), transparent 58%), radial-gradient(ellipse at 82% 50%, color-mix(in srgb, ${secondaryColor} 16%, transparent), transparent 58%), rgba(255,255,255,0.4)`,
          backdropFilter: 'blur(28px) saturate(165%)',
          WebkitBackdropFilter: 'blur(28px) saturate(165%)',
          boxShadow: '0 16px 42px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.09)',
          transition: 'transform 0.14s cubic-bezier(0.22, 1, 0.36, 1), filter 0.14s ease-out',
          willChange: 'transform',
        }}
      >
        <canvas ref={canvasRef} className="block h-full w-full" />
      </div>
    </motion.div>
  )
}

