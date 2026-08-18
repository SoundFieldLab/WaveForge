import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import ProgressiveGlyphText from './ProgressiveGlyphText'

interface MultidimensionalLyricsProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  trackId?: string | number
  translationEnabled?: boolean
  romanEnabled?: boolean
  isTransitioning?: boolean
  onSeek?: (time: number) => void
}

interface DimensionBlock {
  line: LyricLine
  sourceIndex: number
  visualIndex: number
  x: number
  y: number
  z: number
  rotateX: number
  rotateY: number
  rotateZ: number
  width: number
  fontSize: number
  inactiveFontSize: number
}
interface CameraTarget { x: number; y: number; z: number; rotateX: number; rotateY: number }
interface CameraState extends CameraTarget {
  velocityX: number
  velocityY: number
  velocityZ: number
  velocityRotateX: number
  velocityRotateY: number
  target: CameraTarget
  finalTarget: CameraTarget
  overviewUntil: number
}
interface RgbColor { red: number; green: number; blue: number }

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const hashText = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
const seededUnit = (value: string) => (hashText(value) % 10000) / 10000
const estimateTextColumns = (text: string) => Array.from(text.trim()).reduce((columns, character) => {
  if (/\s/u.test(character)) return columns + 0.34
  if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(character)) return columns + 1
  return columns + 0.58
}, 0)

const parseRgbColor = (color: string): RgbColor | null => {
  const hex = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map(character => character + character).join('') : hex
    return { red: Number.parseInt(expanded.slice(0, 2), 16), green: Number.parseInt(expanded.slice(2, 4), 16), blue: Number.parseInt(expanded.slice(4, 6), 16) }
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (!rgb) return null
  return { red: clamp(Number(rgb[1]), 0, 255), green: clamp(Number(rgb[2]), 0, 255), blue: clamp(Number(rgb[3]), 0, 255) }
}
const rgba = (color: string, alpha: number) => {
  const parsed = parseRgbColor(color)
  return parsed ? `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${clamp(alpha, 0, 1)})` : color
}
const mixColor = (color: string, target: RgbColor, amount: number) => {
  const parsed = parseRgbColor(color) || { red: 122, green: 112, blue: 255 }
  const mix = clamp(amount, 0, 1)
  const channel = (from: number, to: number) => Math.round(from + (to - from) * mix)
  return `rgb(${channel(parsed.red, target.red)}, ${channel(parsed.green, target.green)}, ${channel(parsed.blue, target.blue)})`
}

const buildDimensionLayout = (lyrics: LyricLine[], seed: string): DimensionBlock[] => {
  return lyrics
    .map((line, sourceIndex) => ({ line, sourceIndex }))
    .filter(item => Boolean(item.line.text?.trim()))
    .map(({ line, sourceIndex }, visualIndex) => {
      const phase = visualIndex * 0.79 + seededUnit(`${seed}:phase`) * Math.PI * 2
      const side = visualIndex % 2 === 0 ? -1 : 1
      const textColumns = Math.max(1, estimateTextColumns(line.text))
      const width = clamp(660 + (seededUnit(`${seed}:${sourceIndex}:w`) - 0.5) * 150, 560, 740)
      const fontSize = clamp(width / Math.max(7.2, Math.sqrt(textColumns) * 1.62), 44, 92)
      return {
        line,
        sourceIndex,
        visualIndex,
        x: Math.sin(phase) * 310 + side * (54 + seededUnit(`${seed}:${sourceIndex}:x`) * 92),
        y: visualIndex * 282 + Math.cos(phase * 0.72) * 44,
        z: Math.cos(phase * 0.58) * 290 + (seededUnit(`${seed}:${sourceIndex}:z`) - 0.5) * 120,
        rotateX: (seededUnit(`${seed}:${sourceIndex}:rx`) - 0.5) * 7,
        rotateY: -Math.sin(phase) * 16 + side * 4,
        rotateZ: (seededUnit(`${seed}:${sourceIndex}:rz`) - 0.5) * 3.2,
        width,
        fontSize,
        inactiveFontSize: clamp(fontSize * 0.68, 32, 58),
      }
    })
}

function useDimensionCamera(worldRef: React.RefObject<HTMLDivElement | null>, desired: CameraTarget, reducedMotion: boolean) {
  const stateRef = useRef<CameraState>({
    ...desired,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    velocityRotateX: 0,
    velocityRotateY: 0,
    target: desired,
    finalTarget: desired,
    overviewUntil: 0,
  })

  const rafIdRef = useRef(0)
  const runningRef = useRef(false)

  // 启动/重启弹簧循环；静止时自动停止，目标变化时由下方 effect 重新触发，避免空转消耗 CPU
  const startLoop = useCallback(() => {
    if (runningRef.current) return
    runningRef.current = true
    let previous = performance.now()
    const tick = (now: number) => {
      const state = stateRef.current
      if (state.overviewUntil > 0 && now >= state.overviewUntil) {
        state.target = state.finalTarget
        state.overviewUntil = 0
      }
      const delta = Math.min(0.034, Math.max(0.001, (now - previous) / 1000))
      previous = now
      const positionStiffness = 48
      const rotationStiffness = 42
      const damping = Math.exp(-13.5 * delta)
      state.velocityX = (state.velocityX + (state.target.x - state.x) * positionStiffness * delta) * damping
      state.velocityY = (state.velocityY + (state.target.y - state.y) * positionStiffness * delta) * damping
      state.velocityZ = (state.velocityZ + (state.target.z - state.z) * positionStiffness * delta) * damping
      state.velocityRotateX = (state.velocityRotateX + (state.target.rotateX - state.rotateX) * rotationStiffness * delta) * damping
      state.velocityRotateY = (state.velocityRotateY + (state.target.rotateY - state.rotateY) * rotationStiffness * delta) * damping
      state.x += state.velocityX * delta
      state.y += state.velocityY * delta
      state.z += state.velocityZ * delta
      state.rotateX += state.velocityRotateX * delta
      state.rotateY += state.velocityRotateY * delta
      if (worldRef.current) {
        worldRef.current.style.transform = `translate3d(${-state.x.toFixed(2)}px, ${-state.y.toFixed(2)}px, ${state.z.toFixed(2)}px) rotateX(${state.rotateX.toFixed(3)}deg) rotateY(${state.rotateY.toFixed(3)}deg)`
      }

      // 静止检测：速度与位置误差都足够小时停止循环（目标变化会重新 startLoop）
      const speed = Math.abs(state.velocityX) + Math.abs(state.velocityY) + Math.abs(state.velocityZ)
        + Math.abs(state.velocityRotateX) + Math.abs(state.velocityRotateY)
      const positionError = Math.abs(state.target.x - state.x) + Math.abs(state.target.y - state.y)
        + Math.abs(state.target.z - state.z) + Math.abs(state.target.rotateX - state.rotateX)
        + Math.abs(state.target.rotateY - state.rotateY)
      if (state.overviewUntil === 0 && speed < 0.05 && positionError < 0.1) {
        runningRef.current = false
        return
      }
      rafIdRef.current = requestAnimationFrame(tick)
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [worldRef])

  useEffect(() => {
    const state = stateRef.current
    state.finalTarget = desired
    if (reducedMotion) {
      Object.assign(state, desired, { target: desired, overviewUntil: 0 })
      if (worldRef.current) {
        worldRef.current.style.transform = `translate3d(${-desired.x}px, ${-desired.y}px, ${desired.z}px) rotateX(${desired.rotateX}deg) rotateY(${desired.rotateY}deg)`
      }
      return
    }

    const distance = Math.hypot(desired.x - state.x, desired.y - state.y, desired.z - state.z)
    if (distance > 920) {
      state.target = {
        x: (state.x + desired.x) * 0.5,
        y: (state.y + desired.y) * 0.5,
        z: Math.min(state.z, desired.z) - 520,
        rotateX: (state.rotateX + desired.rotateX) * 0.28,
        rotateY: (state.rotateY + desired.rotateY) * 0.28,
      }
      state.overviewUntil = performance.now() + 480
    } else {
      state.target = desired
      state.overviewUntil = 0
    }
    startLoop()
  }, [desired.rotateX, desired.rotateY, desired.x, desired.y, desired.z, reducedMotion, worldRef, startLoop])

  useEffect(() => {
    return () => cancelAnimationFrame(rafIdRef.current)
  }, [])
}

export default function MultidimensionalLyrics({
  lyrics, currentIndex, playbackTimeStore, timeOffset, isPlaying, accentColor, songTitle, songArtist, songAlbum, coverUrl,
  trackId, translationEnabled = false, romanEnabled = false, isTransitioning = false, onSeek,
}: MultidimensionalLyricsProps) {
  const reducedMotion = Boolean(useReducedMotion())
  const worldRef = useRef<HTMLDivElement>(null)
  const seed = `${trackId ?? songTitle}:${songArtist}`
  const blocks = useMemo(() => buildDimensionLayout(lyrics, seed), [lyrics, seed])
  const active = useMemo(() => {
    const exact = blocks.find(block => block.sourceIndex === currentIndex)
    if (exact) return exact
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index].sourceIndex <= currentIndex) return blocks[index]
    }
    return blocks[0] || null
  }, [blocks, currentIndex])

  const desiredCamera = useMemo<CameraTarget>(() => active ? ({
    x: active.x,
    y: active.y,
    z: 96 - active.z,
    rotateX: -active.rotateX * 0.72 - 1.8,
    rotateY: -active.rotateY * 0.6,
  }) : ({ x: 0, y: 0, z: 96, rotateX: -2, rotateY: 0 }), [active])
  useDimensionCamera(worldRef, desiredCamera, reducedMotion)

  const visibleBlocks = useMemo(() => active
    ? blocks.filter(block => Math.abs(block.visualIndex - active.visualIndex) <= 5)
    : [], [active, blocks])
  const brightAccent = mixColor(accentColor, { red: 235, green: 224, blue: 255 }, 0.38)
  const activeNumber = String((active?.visualIndex ?? 0) + 1).padStart(3, '0')
  const totalNumber = String(Math.max(1, blocks.length)).padStart(3, '0')

  return (
    <div className="relative h-full min-h-[440px] w-full overflow-hidden bg-[#05060c] text-white" style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 320ms ease', contain: 'layout paint style' }}>
      {coverUrl && <img src={coverUrl} alt="" draggable={false} className="pointer-events-none absolute inset-[-5%] h-[110%] w-[110%] object-cover" style={{ opacity: .2, filter: 'blur(20px) saturate(1.3)', transform: 'translateZ(0) scale(1.04)' }} />}
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(circle at 18% 22%, ${rgba(accentColor, .26)}, transparent 38%), radial-gradient(circle at 82% 70%, ${rgba(brightAccent, .18)}, transparent 34%), linear-gradient(145deg, rgba(4,5,12,.92), rgba(8,9,20,.82) 48%, rgba(3,4,9,.96))` }} />
      <div className="pointer-events-none absolute inset-0 opacity-55" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)', backgroundSize: '56px 56px', maskImage: 'radial-gradient(circle at center, black, transparent 82%)', WebkitMaskImage: 'radial-gradient(circle at center, black, transparent 82%)' }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 35%, rgba(0,0,0,.24) 72%, rgba(0,0,0,.7) 100%)' }} />

      <div className="absolute inset-0" style={{ perspective: '1100px', perspectiveOrigin: '50% 48%' }}>
        <div ref={worldRef} className="absolute left-1/2 top-1/2" style={{ transformStyle: 'preserve-3d', willChange: 'transform', backfaceVisibility: 'hidden' }}>
          {visibleBlocks.map(block => {
            const distance = active ? block.visualIndex - active.visualIndex : 0
            const isActive = distance === 0
            const opacity = isActive ? 1 : clamp(0.5 - Math.abs(distance) * 0.072, 0.08, 0.42)
            return (
              <button
                type="button"
                key={`${block.sourceIndex}-${block.visualIndex}`}
                onClick={() => onSeek?.(block.line.time)}
                className="absolute appearance-none border-0 bg-transparent p-0 text-left text-white"
                style={{
                  width: block.width,
                  transform: `translate3d(${block.x}px, ${block.y}px, ${block.z}px) translate(-50%, -50%) rotateX(${block.rotateX}deg) rotateY(${block.rotateY}deg) rotateZ(${block.rotateZ}deg)`,
                  transformStyle: 'preserve-3d',
                  opacity,
                  cursor: onSeek ? 'pointer' : 'default',
                  transition: 'opacity 420ms ease',
                  pointerEvents: Math.abs(distance) <= 2 ? 'auto' : 'none',
                }}
              >
                <div className="mb-4 flex items-center gap-3 font-mono text-[9px] font-semibold uppercase tracking-[.34em]" style={{ color: isActive ? brightAccent : 'rgba(255,255,255,.35)', transform: 'translateZ(18px)' }}>
                  <span className="h-px w-16" style={{ background: `linear-gradient(90deg, ${isActive ? brightAccent : 'rgba(255,255,255,.25)'}, transparent)` }} />
                  <span>{isActive ? 'focus plane' : distance < 0 ? 'memory layer' : 'incoming layer'}</span>
                  <span className="ml-auto">{String(block.visualIndex + 1).padStart(3, '0')}</span>
                </div>
                <div
                  className="font-black leading-[.98] tracking-[-.052em] [overflow-wrap:anywhere]"
                  style={{
                    fontSize: `${isActive ? block.fontSize : block.inactiveFontSize}px`,
                    transform: `translateZ(${isActive ? 52 : 8}px)`,
                    transformStyle: 'preserve-3d',
                    textShadow: isActive ? `0 14px 44px rgba(0,0,0,.72), 0 0 34px ${rgba(accentColor, .22)}` : '0 10px 30px rgba(0,0,0,.54)',
                  }}
                >
                  {isActive ? (
                    <ProgressiveGlyphText
                      line={block.line}
                      playbackTimeStore={playbackTimeStore}
                      timeOffset={timeOffset}
                      filledColor="rgb(255,255,255)"
                      inactiveColor="rgba(255,255,255,.2)"
                      glowColor={rgba(brightAccent, .88)}
                    />
                  ) : block.line.text}
                </div>
                {isActive && romanEnabled && block.line.roman?.trim() && <div className="mt-5 text-sm font-semibold tracking-[.14em] text-white/50" style={{ transform: 'translateZ(34px)' }}>{block.line.roman}</div>}
                {isActive && translationEnabled && block.line.translation?.trim() && <div className="mt-2 text-lg font-medium text-white/72" style={{ transform: 'translateZ(28px)' }}>{block.line.translation}</div>}
                <div className="mt-5 h-px w-full" style={{ background: `linear-gradient(90deg, ${isActive ? brightAccent : 'rgba(255,255,255,.18)'}, transparent 72%)`, transform: `translateZ(${isActive ? 26 : 2}px)` }} />
              </button>
            )
          })}
        </div>
      </div>

      <div className="pointer-events-none absolute left-8 top-8 z-20 sm:left-11 sm:top-10">
        <div className="flex items-center gap-3 font-mono text-[10px] font-bold uppercase tracking-[.36em]" style={{ color: brightAccent }}><span className="h-2 w-2 rotate-45" style={{ background: brightAccent, boxShadow: `0 0 18px ${rgba(accentColor, .7)}` }} />WaveForge / Multidimensional</div>
        <h1 className="mt-4 max-w-[50vw] truncate text-xl font-semibold text-white/92 sm:text-2xl">{songTitle}</h1>
        <p className="mt-1 max-w-[50vw] truncate text-xs text-white/48 sm:text-sm">{songArtist}{songAlbum ? ` · ${songAlbum}` : ''}</p>
      </div>

      <div className="pointer-events-none absolute bottom-9 left-9 z-20 flex items-end gap-4 sm:bottom-12 sm:left-12">
        <span className="font-mono text-4xl font-black tracking-[-.08em] text-white/90">{activeNumber}</span>
        <span className="mb-1 font-mono text-xs tracking-[.22em] text-white/34">/ {totalNumber}</span>
        <span className="mb-2 h-px w-28" style={{ background: `linear-gradient(90deg, ${brightAccent}, transparent)` }} />
        <span className="mb-1 font-mono text-[9px] uppercase tracking-[.28em] text-white/35">{isPlaying ? 'camera tracking' : 'camera suspended'}</span>
      </div>
      <div aria-live="polite" className="sr-only">{active?.line.text || ''}</div>
    </div>
  )
}
