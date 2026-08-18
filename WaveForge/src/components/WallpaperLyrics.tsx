import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import ProgressiveGlyphText from './ProgressiveGlyphText'

interface WallpaperLyricsProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  playerTheme: 'dark' | 'light'
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

interface ViewportSize { width: number; height: number }
interface WallpaperBlock {
  line: LyricLine
  sourceIndex: number
  visualIndex: number
  x: number
  y: number
  width: number
  height: number
  rotation: number
  fontSize: number
  hero: boolean
}
interface WallpaperLayout { blocks: WallpaperBlock[]; width: number; height: number }
interface CameraTarget { x: number; y: number; scale: number }
interface CameraState extends CameraTarget {
  velocityX: number
  velocityY: number
  velocityScale: number
  targetX: number
  targetY: number
  targetScale: number
  finalTarget: CameraTarget
  overviewUntil: number
}
interface RgbColor { red: number; green: number; blue: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

const parseRgbColor = (color: string): RgbColor | null => {
  const hex = color.trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? hex.split('').map(character => character + character).join('') : hex
    return {
      red: Number.parseInt(expanded.slice(0, 2), 16),
      green: Number.parseInt(expanded.slice(2, 4), 16),
      blue: Number.parseInt(expanded.slice(4, 6), 16),
    }
  }
  const rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i)
  if (!rgb) return null
  return { red: clamp(Number(rgb[1]), 0, 255), green: clamp(Number(rgb[2]), 0, 255), blue: clamp(Number(rgb[3]), 0, 255) }
}

const colorWithAlpha = (color: string, alpha: number) => {
  const parsed = parseRgbColor(color)
  return parsed ? `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${clamp(alpha, 0, 1)})` : color
}

const mixRgbColor = (from: RgbColor, to: RgbColor, amount: number) => {
  const mix = clamp(amount, 0, 1)
  const channel = (start: number, end: number) => Math.round(start + (end - start) * mix)
  return `rgb(${channel(from.red, to.red)}, ${channel(from.green, to.green)}, ${channel(from.blue, to.blue)})`
}

const resolveWallpaperPalette = (color: string, isDark: boolean) => {
  const accent = parseRgbColor(color) || { red: 108, green: 92, blue: 255 }
  const luminance = (accent.red * 0.2126 + accent.green * 0.7152 + accent.blue * 0.0722) / 255
  const vividAmount = isDark ? clamp((0.58 - luminance) * 0.42, 0.08, 0.28) : 0
  const vivid = mixRgbColor(accent, { red: 255, green: 255, blue: 255 }, vividAmount)
  return {
    vivid,
    surface: isDark
      ? mixRgbColor(accent, { red: 4, green: 5, blue: 8 }, 0.82)
      : mixRgbColor(accent, { red: 250, green: 250, blue: 252 }, 0.86),
    paper: isDark
      ? mixRgbColor(accent, { red: 10, green: 11, blue: 15 }, 0.72)
      : mixRgbColor(accent, { red: 255, green: 255, blue: 255 }, 0.78),
    primary: isDark
      ? mixRgbColor(accent, { red: 255, green: 255, blue: 255 }, 0.78)
      : mixRgbColor(accent, { red: 18, green: 18, blue: 22 }, 0.78),
    secondary: isDark
      ? mixRgbColor(accent, { red: 235, green: 238, blue: 247 }, 0.68)
      : mixRgbColor(accent, { red: 54, green: 55, blue: 64 }, 0.7),
    ghost: isDark
      ? mixRgbColor(accent, { red: 220, green: 224, blue: 236 }, 0.56)
      : mixRgbColor(accent, { red: 82, green: 84, blue: 96 }, 0.72),
  }
}

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

const buildWallpaperLayout = (lyrics: LyricLine[], viewport: ViewportSize, seed: string): WallpaperLayout => {
  const entries = lyrics.map((line, sourceIndex) => ({ line, sourceIndex })).filter(({ line }) => Boolean(line.text?.trim()))
  const columnCount = viewport.width < 760 ? 2 : viewport.width < 1260 ? 3 : 4
  const columnWidth = clamp(viewport.width * (columnCount === 2 ? 0.56 : columnCount === 3 ? 0.36 : 0.27), columnCount === 2 ? 250 : 290, 510)
  const columnGap = clamp(viewport.width * 0.075, 54, 128)
  const rowHeight = clamp(viewport.height * 0.28, 190, 255)
  const horizontalMargin = Math.max(viewport.width * 0.78, 700)
  const verticalMargin = Math.max(viewport.height * 0.72, 540)
  const contentWidth = columnCount * columnWidth + (columnCount - 1) * columnGap
  const seedOffset = hashText(seed) % columnCount

  const drafts = entries.map(({ line, sourceIndex }, visualIndex) => {
    const textColumns = Math.max(estimateTextColumns(line.text), 1)
    const row = Math.floor(visualIndex / columnCount)
    const lane = (visualIndex % columnCount + row * (columnCount > 2 ? 2 : 1) + seedOffset) % columnCount
    const hero = textColumns <= 22 && textColumns >= 4 && (visualIndex % 7 === 3 || seededUnit(`${seed}:${sourceIndex}:hero`) > 0.93)
    const width = hero ? Math.min(columnWidth * 1.38, contentWidth * 0.6) : columnWidth
    const fontSize = hero
      ? clamp(width / Math.max(Math.sqrt(textColumns) * 1.64, 5), 38, 70)
      : clamp(width / Math.max(Math.sqrt(textColumns) * 2.38, 8), 22, 38)
    const estimatedRows = Math.max(1, Math.ceil((textColumns * fontSize * 0.62) / width))
    return {
      line,
      sourceIndex,
      visualIndex,
      row,
      x: horizontalMargin + lane * (columnWidth + columnGap) + (hero && lane === columnCount - 1 ? columnWidth - width : 0)
        + (seededUnit(`${seed}:${sourceIndex}:x`) - 0.5) * columnGap * 0.44,
      width,
      height: Math.max(hero ? 160 : 116, estimatedRows * fontSize * 1.1 + 76),
      rotation: (seededUnit(`${seed}:${sourceIndex}:rotation`) - 0.5) * (hero ? 1.7 : 2.8),
      fontSize,
      hero,
    }
  })

  const rowCount = Math.max(1, Math.ceil(entries.length / columnCount))
  const rowHeights = new Array<number>(rowCount).fill(rowHeight)
  drafts.forEach(block => { rowHeights[block.row] = Math.max(rowHeights[block.row], block.height + 64) })
  const rowOffsets: number[] = []
  rowHeights.reduce((offset, height, row) => { rowOffsets[row] = offset; return offset + height }, 0)
  const blocks = drafts.map(({ row, ...block }) => ({
    ...block,
    y: verticalMargin + rowOffsets[row] + (seededUnit(`${seed}:${block.sourceIndex}:y`) - 0.5) * Math.min(rowHeights[row] * 0.12, 34),
  }))
  return {
    blocks,
    width: contentWidth + horizontalMargin * 2,
    height: verticalMargin * 2 + rowHeights.reduce((total, height) => total + height, 0),
  }
}

function useSpringCamera(worldRef: React.RefObject<HTMLDivElement | null>, target: CameraTarget, viewport: ViewportSize, reducedMotion: boolean) {
  const cameraRef = useRef<CameraState>({
    ...target,
    velocityX: 0,
    velocityY: 0,
    velocityScale: 0,
    targetX: target.x,
    targetY: target.y,
    targetScale: target.scale,
    finalTarget: target,
    overviewUntil: 0,
  })

  const rafIdRef = useRef(0)
  const runningRef = useRef(false)

  const startLoop = useCallback(() => {
    if (runningRef.current) return
    runningRef.current = true
    let previousTime = performance.now()
    const tick = (now: number) => {
      const state = cameraRef.current
      if (state.overviewUntil > 0 && now >= state.overviewUntil) {
        state.targetX = state.finalTarget.x
        state.targetY = state.finalTarget.y
        state.targetScale = state.finalTarget.scale
        state.overviewUntil = 0
      }
      const delta = Math.min(0.034, Math.max(0.001, (now - previousTime) / 1000))
      previousTime = now
      const stiffness = 56
      const damping = 14
      state.velocityX += (state.targetX - state.x) * stiffness * delta
      state.velocityY += (state.targetY - state.y) * stiffness * delta
      state.velocityScale += (state.targetScale - state.scale) * 70 * delta
      const decay = Math.exp(-damping * delta)
      state.velocityX *= decay
      state.velocityY *= decay
      state.velocityScale *= Math.exp(-16 * delta)
      state.x += state.velocityX * delta
      state.y += state.velocityY * delta
      state.scale += state.velocityScale * delta
      if (worldRef.current) {
        worldRef.current.style.transform = `translate3d(${state.x.toFixed(2)}px, ${state.y.toFixed(2)}px, 0) scale(${state.scale.toFixed(4)})`
      }

      // 静止检测：速度与位置误差都足够小时停止循环，目标变化会重新 startLoop
      const settled = state.overviewUntil === 0
        && Math.abs(state.velocityX) < 0.05
        && Math.abs(state.velocityY) < 0.05
        && Math.abs(state.velocityScale) < 0.001
        && Math.abs(state.targetX - state.x) < 0.1
        && Math.abs(state.targetY - state.y) < 0.1
        && Math.abs(state.targetScale - state.scale) < 0.001
      if (settled) {
        runningRef.current = false
        return
      }
      rafIdRef.current = requestAnimationFrame(tick)
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [worldRef])

  useEffect(() => {
    const state = cameraRef.current
    state.finalTarget = target
    if (reducedMotion) {
      Object.assign(state, target, { targetX: target.x, targetY: target.y, targetScale: target.scale, overviewUntil: 0 })
      if (worldRef.current) worldRef.current.style.transform = `translate3d(${target.x}px, ${target.y}px, 0) scale(${target.scale})`
      return
    }

    const distance = Math.hypot(target.x - state.x, target.y - state.y) / Math.max(1, Math.min(viewport.width, viewport.height))
    if (distance > 2.75) {
      const overviewScale = clamp(Math.min(state.scale, target.scale) * 0.58, 0.34, 0.68)
      const currentCenterX = -state.x / Math.max(0.001, state.scale)
      const currentCenterY = -state.y / Math.max(0.001, state.scale)
      const targetCenterX = -target.x / Math.max(0.001, target.scale)
      const targetCenterY = -target.y / Math.max(0.001, target.scale)
      state.targetScale = overviewScale
      state.targetX = -((currentCenterX + targetCenterX) * 0.5) * overviewScale
      state.targetY = -((currentCenterY + targetCenterY) * 0.5) * overviewScale
      state.overviewUntil = performance.now() + 470
    } else {
      state.targetX = target.x
      state.targetY = target.y
      state.targetScale = target.scale
      state.overviewUntil = 0
    }
    startLoop()
  }, [reducedMotion, target.scale, target.x, target.y, viewport.height, viewport.width, worldRef, startLoop])

  useEffect(() => {
    return () => cancelAnimationFrame(rafIdRef.current)
  }, [])
}

export default function WallpaperLyrics({
  lyrics, currentIndex, playbackTimeStore, timeOffset, accentColor, playerTheme, songTitle, songArtist, songAlbum,
  coverUrl, trackId, translationEnabled = false, romanEnabled = false, isTransitioning = false, onSeek,
}: WallpaperLyricsProps) {
  const prefersReducedMotion = Boolean(useReducedMotion())
  const containerRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<ViewportSize>({ width: 1440, height: 820 })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = () => {
      const bounds = container.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0) setViewport(previous => (
        Math.abs(previous.width - bounds.width) < 1 && Math.abs(previous.height - bounds.height) < 1
          ? previous
          : { width: bounds.width, height: bounds.height }
      ))
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  const seed = `${trackId ?? songTitle}:${songArtist}`
  const layout = useMemo(() => buildWallpaperLayout(lyrics, viewport, seed), [lyrics, seed, viewport])
  const activeBlock = useMemo(() => {
    const exact = layout.blocks.find(block => block.sourceIndex === currentIndex)
    if (exact) return exact
    for (let index = layout.blocks.length - 1; index >= 0; index -= 1) {
      if (layout.blocks[index].sourceIndex <= currentIndex) return layout.blocks[index]
    }
    return layout.blocks[0] || null
  }, [currentIndex, layout.blocks])

  const cameraScale = activeBlock
    ? viewport.width < 720
      ? clamp(viewport.width / Math.max(activeBlock.width * 1.18, 1), 0.78, 1.08)
      : activeBlock.hero ? 0.96 : clamp(viewport.width / Math.max(activeBlock.width * 3.2, 1), 0.98, 1.2)
    : 1
  const cameraTarget = useMemo<CameraTarget>(() => ({
    x: activeBlock ? -(activeBlock.x + activeBlock.width * 0.5) * cameraScale : -layout.width * 0.5,
    y: activeBlock ? -(activeBlock.y + activeBlock.height * 0.48) * cameraScale : -layout.height * 0.5,
    scale: cameraScale,
  }), [activeBlock, cameraScale, layout.height, layout.width])
  useSpringCamera(worldRef, cameraTarget, viewport, prefersReducedMotion)

  const visibleBlocks = useMemo(() => {
    if (!activeBlock) return []
    const horizontalRange = viewport.width * 2.2 / Math.max(0.4, cameraScale)
    const verticalRange = viewport.height * 2.1 / Math.max(0.4, cameraScale)
    const activeX = activeBlock.x + activeBlock.width * 0.5
    const activeY = activeBlock.y + activeBlock.height * 0.5
    return layout.blocks.filter(block => (
      Math.abs(block.visualIndex - activeBlock.visualIndex) <= 18
      || (Math.abs(block.x + block.width * 0.5 - activeX) <= horizontalRange
        && Math.abs(block.y + block.height * 0.5 - activeY) <= verticalRange)
    ))
  }, [activeBlock, cameraScale, layout.blocks, viewport.height, viewport.width])

  const isDark = playerTheme === 'dark'
  const wallpaperPalette = useMemo(() => resolveWallpaperPalette(accentColor, isDark), [accentColor, isDark])
  const wallpaperAccent = wallpaperPalette.vivid
  const wallpaperFill = mixRgbColor(
    parseRgbColor(wallpaperAccent) || { red: 132, green: 122, blue: 255 },
    { red: 255, green: 255, blue: 255 },
    isDark ? 0.76 : 0.34,
  )
  const primaryText = wallpaperPalette.primary
  const secondaryText = wallpaperPalette.secondary
  const ghostText = wallpaperPalette.ghost
  const ruleColor = isDark ? 'rgba(255,255,255,0.09)' : 'rgba(18,18,20,0.09)'

  return (
    <div ref={containerRef} className="relative h-full w-full min-h-[420px] overflow-hidden" style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 300ms ease', contain: 'layout paint style' }}>
      {coverUrl && <img src={coverUrl} alt="" draggable={false} className="pointer-events-none absolute inset-[-5%] h-[110%] w-[110%] object-cover" style={{ opacity: isDark ? 0.34 : 0.22, filter: 'blur(22px) saturate(1.28) contrast(1.08)', transform: 'translateZ(0) scale(1.03)', mixBlendMode: isDark ? 'screen' : 'multiply' }} />}
      <div className="absolute inset-0" style={{ backgroundColor: colorWithAlpha(wallpaperPalette.surface, isDark ? 0.82 : 0.88), backgroundImage: `radial-gradient(circle at 78% 18%, ${colorWithAlpha(wallpaperAccent, isDark ? 0.34 : 0.2)} 0%, transparent 50%), radial-gradient(circle at 18% 82%, ${colorWithAlpha(accentColor, isDark ? 0.2 : 0.14)} 0%, transparent 42%), linear-gradient(115deg, ${colorWithAlpha(wallpaperPalette.paper, isDark ? 0.78 : 0.84)} 0%, ${colorWithAlpha(wallpaperPalette.surface, isDark ? 0.72 : 0.82)} 100%)` }} />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: isDark ? 'repeating-linear-gradient(104deg, rgba(255,255,255,.018) 0 1px, transparent 1px 5px)' : 'repeating-linear-gradient(104deg, rgba(74,64,48,.025) 0 1px, transparent 1px 5px)' }} />
﻿      {coverUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-[4vw] top-[13vh] z-[1] h-[min(66vh,620px)] w-[min(38vw,520px)] overflow-hidden border border-white/15 shadow-2xl"
          style={{
            transform: 'rotate(5.5deg)',
            boxShadow: `0 36px 90px rgba(0,0,0,.48), 0 0 0 12px ${colorWithAlpha(wallpaperPalette.paper, 0.22)}, 0 0 54px ${colorWithAlpha(wallpaperAccent, 0.2)}`,
            WebkitMaskImage: 'linear-gradient(110deg, transparent 0%, black 17%, black 84%, transparent 100%)',
            maskImage: 'linear-gradient(110deg, transparent 0%, black 17%, black 84%, transparent 100%)',
          }}
        >
          <img src={coverUrl} alt="" draggable={false} className="h-full w-full object-cover" style={{ opacity: isDark ? .72 : .58, filter: 'saturate(1.16) contrast(1.08)' }} />
          <div className="absolute inset-0" style={{ background: `linear-gradient(145deg, ${colorWithAlpha(wallpaperPalette.paper, .12)}, transparent 42%, ${colorWithAlpha(wallpaperPalette.surface, .64)}), repeating-linear-gradient(0deg, rgba(255,255,255,.035) 0 1px, transparent 1px 4px)` }} />
          <div className="absolute bottom-5 left-6 right-6 border-t border-white/28 pt-3 font-mono text-[9px] font-bold uppercase tracking-[.34em]" style={{ color: primaryText }}>
            album print / {String((activeBlock?.visualIndex ?? 0) + 1).padStart(3, '0')}
          </div>
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 z-20" style={{ background: isDark ? 'radial-gradient(circle at center, transparent 32%, rgba(0,0,0,.16) 72%, rgba(0,0,0,.52) 100%)' : 'radial-gradient(circle at center, transparent 30%, rgba(255,255,255,.1) 68%, rgba(236,230,218,.46) 100%)' }} />

      <div ref={worldRef} className="absolute left-1/2 top-1/2" style={{ width: layout.width, height: layout.height, transformOrigin: '0 0', willChange: 'transform', backfaceVisibility: 'hidden' }}>
        <div className="absolute inset-0" style={{ backgroundColor: colorWithAlpha(wallpaperPalette.paper, isDark ? 0.46 : 0.36), backgroundImage: `linear-gradient(${ruleColor} 1px, transparent 1px), linear-gradient(90deg, ${ruleColor} 1px, transparent 1px)`, backgroundSize: '72px 72px' }} />
        <div aria-hidden="true" className="pointer-events-none absolute select-none whitespace-nowrap font-black uppercase leading-none" style={{ left: layout.width * 0.08, top: viewport.height * 0.28, fontSize: clamp(viewport.width * 0.13, 112, 230), color: 'transparent', WebkitTextStroke: `1px ${isDark ? 'rgba(255,255,255,.065)' : 'rgba(20,20,22,.07)'}`, letterSpacing: '-.06em' }}>LYRIC ARCHIVE</div>

        {visibleBlocks.map(block => {
          const isActive = block.sourceIndex === activeBlock?.sourceIndex
          const isPassed = block.sourceIndex < (activeBlock?.sourceIndex ?? -1)
          const distance = activeBlock ? Math.abs(block.visualIndex - activeBlock.visualIndex) : 0
          return (
            <button
              type="button"
              key={`${block.sourceIndex}-${block.visualIndex}`}
              onClick={() => onSeek?.(block.line.time)}
              className="absolute appearance-none border-0 bg-transparent p-0 text-left"
              style={{
                left: block.x,
                top: block.y,
                width: block.width,
                minHeight: block.height,
                transform: `rotate(${block.rotation}deg) translateZ(0)`,
                opacity: isActive ? 1 : clamp(0.76 - distance * 0.026, 0.18, 0.68),
                color: isActive ? primaryText : ghostText,
                cursor: onSeek ? 'pointer' : 'default',
                transition: 'opacity 420ms ease, color 420ms ease',
                contentVisibility: 'auto',
                containIntrinsicSize: `${Math.ceil(block.height)}px ${Math.ceil(block.width)}px`,
              }}
            >
              <div className="mb-3 flex items-center gap-2 font-mono text-[9px] font-bold uppercase tracking-[.28em]" style={{ color: isActive ? wallpaperAccent : secondaryText }}>
                <span className="inline-block h-2.5 w-2.5" style={{ backgroundColor: isActive ? wallpaperAccent : 'transparent', border: `1px solid ${isActive ? wallpaperAccent : secondaryText}`, boxShadow: isActive ? `0 0 14px ${colorWithAlpha(wallpaperAccent, .46)}` : 'none' }} />
                <span>{isActive ? 'now printing' : isPassed ? 'archive' : 'unprinted'}</span>
                <span className="ml-auto">{String(block.visualIndex + 1).padStart(3, '0')}</span>
              </div>
              <div className="whitespace-normal break-words font-semibold leading-[1.04] [overflow-wrap:anywhere]" style={{ fontSize: block.fontSize, fontWeight: block.hero ? 760 : 620, letterSpacing: block.hero ? '-.045em' : '-.025em', textShadow: isActive ? `0 0 ${block.hero ? 26 : 20}px ${colorWithAlpha(wallpaperAccent, .34)}, 0 8px 28px rgba(0,0,0,.32)` : isDark ? '0 2px 14px rgba(0,0,0,.38)' : 'none' }}>
                {isActive ? (
                  <ProgressiveGlyphText
                    line={block.line}
                    playbackTimeStore={playbackTimeStore}
                    timeOffset={timeOffset}
                    filledColor={wallpaperFill}
                    inactiveColor={colorWithAlpha(wallpaperPalette.primary, isDark ? 0.2 : 0.26)}
                    glowColor={colorWithAlpha(wallpaperAccent, 0.78)}
                  />
                ) : block.line.text}
              </div>
              {isActive && romanEnabled && block.line.roman?.trim() && <div className="mt-3 text-sm font-medium leading-snug" style={{ color: primaryText, opacity: .62 }}>{block.line.roman}</div>}
              {isActive && translationEnabled && block.line.translation?.trim() && <div className="mt-2 text-base leading-snug" style={{ color: primaryText, opacity: .76 }}>{block.line.translation}</div>}
              <div aria-hidden="true" className="mt-4 h-px w-full origin-left" style={{ background: isActive ? `linear-gradient(90deg, ${wallpaperAccent}, ${colorWithAlpha(wallpaperAccent, .34)} 62%, transparent)` : `linear-gradient(90deg, ${ruleColor}, transparent)`, transform: `scaleX(${isActive ? 1 : .72})`, transition: 'transform 420ms ease' }} />
            </button>
          )
        })}
      </div>

      <div className="pointer-events-none absolute left-7 top-7 z-30 sm:left-10 sm:top-9">
        <div className="flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-[.28em]" style={{ color: wallpaperAccent }}><span className="inline-block h-2 w-2" style={{ backgroundColor: wallpaperAccent, boxShadow: `0 0 12px ${colorWithAlpha(wallpaperAccent, .64)}` }} />WaveForge / Fume Paper</div>
        <h1 className="mt-3 max-w-[54vw] truncate text-xl font-semibold sm:text-2xl" style={{ color: primaryText }}>{songTitle}</h1>
        <p className="mt-1 max-w-[54vw] truncate text-xs sm:text-sm" style={{ color: secondaryText }}>{songArtist}{songAlbum ? ` · ${songAlbum}` : ''}</p>
      </div>
      <div aria-live="polite" className="sr-only">{activeBlock?.line.text || ''}</div>
    </div>
  )
}
