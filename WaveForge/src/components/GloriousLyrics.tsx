import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useEffect, useMemo, useRef } from 'react'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import { buildTimedLyricGlyphs } from '../utils/lyricWordTiming'
import ProgressiveGlyphText from './ProgressiveGlyphText'

interface GloriousLyricsProps {
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

interface RgbColor {
  red: number
  green: number
  blue: number
}


interface GloriousScene {
  left: string
  top: string
  width: string
  align: 'left' | 'center' | 'right'
  rotation: number
  enterX: number
  enterY: number
}

const SCENES: GloriousScene[] = [
  { left: '11%', top: '37%', width: '74%', align: 'left', rotation: -2.2, enterX: -70, enterY: 28 },
  { left: '18%', top: '31%', width: '72%', align: 'right', rotation: 1.8, enterX: 74, enterY: -18 },
  { left: '12%', top: '43%', width: '78%', align: 'center', rotation: 0, enterX: 0, enterY: 48 },
  { left: '20%', top: '35%', width: '67%', align: 'left', rotation: 2.8, enterX: -22, enterY: -54 },
]

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

const hashText = (value: string) => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

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
  return {
    red: clamp(Number(rgb[1]), 0, 255),
    green: clamp(Number(rgb[2]), 0, 255),
    blue: clamp(Number(rgb[3]), 0, 255),
  }
}

const mixColor = (from: RgbColor, to: RgbColor, amount: number) => {
  const progress = clamp(amount)
  const channel = (start: number, end: number) => Math.round(start + (end - start) * progress)
  return `rgb(${channel(from.red, to.red)}, ${channel(from.green, to.green)}, ${channel(from.blue, to.blue)})`
}

const colorWithAlpha = (color: string, alpha: number) => {
  const parsed = parseRgbColor(color)
  if (!parsed) return color
  return `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${clamp(alpha)})`
}

const resolvePalette = (accentColor: string) => {
  const accent = parseRgbColor(accentColor) || { red: 116, green: 92, blue: 255 }
  const luminance = (accent.red * 0.2126 + accent.green * 0.7152 + accent.blue * 0.0722) / 255
  const vivid = mixColor(accent, { red: 255, green: 255, blue: 255 }, luminance < 0.34 ? 0.24 : 0.06)

  return {
    vivid,
    highlight: mixColor(accent, { red: 255, green: 255, blue: 255 }, 0.22),
    cool: mixColor(accent, { red: 226, green: 232, blue: 244 }, 0.12),
    shadow: mixColor(accent, { red: 5, green: 6, blue: 12 }, 0.78),
    surface: mixColor(accent, { red: 7, green: 8, blue: 14 }, 0.86),
  }
}

const findVisibleLine = (lyrics: LyricLine[], startIndex: number, direction: -1 | 1) => {
  for (let index = startIndex; index >= 0 && index < lyrics.length; index += direction) {
    if (lyrics[index]?.text?.trim()) return { line: lyrics[index], index }
  }
  return null
}

export default function GloriousLyrics({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  accentColor,
  songTitle,
  songArtist,
  songAlbum,
  coverUrl,
  trackId,
  translationEnabled = false,
  romanEnabled = false,
  isTransitioning = false,
  onSeek,
}: GloriousLyricsProps) {
  const prefersReducedMotion = Boolean(useReducedMotion())
  const active = findVisibleLine(lyrics, Math.max(0, currentIndex), currentIndex < 0 ? 1 : -1)
    || findVisibleLine(lyrics, 0, 1)
  const activeIndex = active?.index ?? -1
  const currentLine = active?.line
  const previous = findVisibleLine(lyrics, activeIndex - 1, -1)
  const next = findVisibleLine(lyrics, activeIndex + 1, 1)
  const palette = useMemo(() => resolvePalette(accentColor), [accentColor])
  const scene = SCENES[Math.max(0, activeIndex) % SCENES.length]
  const wordTimingAvailable = useMemo(
    () => Boolean(currentLine && buildTimedLyricGlyphs(currentLine).length > 0),
    [currentLine],
  )
  const lineNumber = String(Math.max(1, activeIndex + 1)).padStart(2, '0')
  const totalLines = String(Math.max(1, lyrics.filter(line => line.text?.trim()).length)).padStart(2, '0')

  return (
    <div
      className="relative h-full min-h-[440px] w-full overflow-hidden text-white"
      style={{ opacity: isTransitioning ? 0 : 1, transition: 'opacity 380ms ease', backgroundColor: palette.surface }}
    >
      <style>{`
        @keyframes glorious-drift {
          0%, 100% { transform: translate3d(-2%, -1%, 0) scale(1.08); }
          50% { transform: translate3d(2%, 1%, 0) scale(1.14); }
        }
        @keyframes glorious-scan {
          0% { transform: translate3d(-24%, 0, 0); opacity: 0; }
          16% { opacity: .34; }
          70% { opacity: .08; }
          100% { transform: translate3d(120%, 0, 0); opacity: 0; }
        }
        @keyframes glorious-orbit {
          to { transform: rotate(360deg); }
        }
      `}</style>

      {coverUrl && (
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <img
            src={coverUrl}
            alt=""
            draggable={false}
            className="absolute inset-[-8%] h-[116%] w-[116%] object-cover"
            style={{
              opacity: 0.48,
              filter: 'blur(24px) saturate(1.35) brightness(0.68)',
              animation: isPlaying && !prefersReducedMotion ? 'glorious-drift 13s ease-in-out infinite' : undefined,
            }}
          />
        </div>
      )}

﻿      {coverUrl && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-[3vw] top-[15vh] z-[2] aspect-square w-[min(36vw,540px)]"
          style={{ transform: 'rotate(8deg)' }}
        >
          <div className="absolute inset-[-5%] border border-white/10" style={{ transform: 'rotate(-3deg)', background: colorWithAlpha(palette.vivid, .08) }} />
          <div
            className="absolute inset-0 overflow-hidden border border-white/25"
            style={{ boxShadow: `0 42px 110px rgba(0,0,0,.62), 0 0 70px ${colorWithAlpha(palette.vivid, .24)}` }}
          >
            <img src={coverUrl} alt="" draggable={false} className="h-full w-full object-cover" style={{ filter: 'saturate(1.22) contrast(1.08) brightness(.82)' }} />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(115deg, rgba(255,255,255,.18), transparent 28%, rgba(0,0,0,.08) 55%, rgba(0,0,0,.62))' }} />
            <div className="absolute inset-x-0 bottom-0 border-t border-white/20 bg-black/35 px-6 py-4 backdrop-blur-md">
              <div className="font-mono text-[9px] font-bold uppercase tracking-[.34em] text-white/65">featured cover / side a</div>
              <div className="mt-2 truncate text-sm font-semibold text-white/90">{songTitle}</div>
            </div>
          </div>
          <span className="absolute -bottom-8 left-8 h-px w-[72%]" style={{ background: `linear-gradient(90deg, ${palette.highlight}, transparent)` }} />
        </div>
      )}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{
          background: `radial-gradient(circle at 74% 23%, ${colorWithAlpha(palette.vivid, 0.38)} 0%, transparent 38%), radial-gradient(circle at 22% 77%, ${colorWithAlpha(palette.cool, 0.22)} 0%, transparent 42%), linear-gradient(112deg, ${colorWithAlpha(palette.surface, 0.96)} 0%, ${colorWithAlpha(palette.shadow, 0.88)} 54%, rgba(3,3,8,.94) 100%)`,
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 opacity-35"
        aria-hidden="true"
        style={{
          backgroundImage: 'linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          WebkitMaskImage: 'linear-gradient(110deg, black, transparent 72%)',
          maskImage: 'linear-gradient(110deg, black, transparent 72%)',
        }}
      />
      <div
        className="pointer-events-none absolute -left-[18vw] top-[12vh] h-[1px] w-[74vw] origin-right rotate-[21deg]"
        aria-hidden="true"
        style={{ background: `linear-gradient(90deg, transparent, ${colorWithAlpha(palette.highlight, 0.78)}, transparent)`, boxShadow: `0 0 24px ${palette.vivid}` }}
      />
      <div
        className="pointer-events-none absolute -right-[20vw] bottom-[19vh] h-[1px] w-[82vw] -rotate-[17deg]"
        aria-hidden="true"
        style={{ background: `linear-gradient(90deg, transparent, ${colorWithAlpha(palette.cool, 0.72)}, transparent)` }}
      />

      {!prefersReducedMotion && isPlaying && (
        <div
          className="pointer-events-none absolute inset-y-0 -left-1/4 w-1/3 skew-x-[-18deg]"
          aria-hidden="true"
          style={{
            background: `linear-gradient(90deg, transparent, ${colorWithAlpha(palette.highlight, 0.2)}, transparent)`,
            filter: 'blur(8px)',
            animation: 'glorious-scan 8.5s ease-in-out infinite',
          }}
        />
      )}

      <div className="pointer-events-none absolute inset-7 z-20 border border-white/[0.12] sm:inset-10" aria-hidden="true">
        <span className="absolute -left-px -top-px h-1 w-20" style={{ background: palette.highlight, boxShadow: `0 0 20px ${palette.vivid}` }} />
        <span className="absolute -left-px -top-px h-24 w-px bg-white/55" />
        <span className="absolute -bottom-px -right-px h-px w-36 bg-white/55" />
        <span className="absolute -bottom-px -right-px h-28 w-px" style={{ background: palette.cool }} />
      </div>

      <div className="pointer-events-none absolute left-[7vw] top-[9vh] z-30 max-w-[48vw]">
        <div className="flex items-center gap-3 font-mono text-[10px] font-bold uppercase tracking-[0.34em]" style={{ color: palette.highlight }}>
          <span className="h-2 w-2 rotate-45" style={{ background: palette.highlight, boxShadow: `0 0 18px ${palette.vivid}` }} />
          WaveForge / Glorious
        </div>
        <h1 className="mt-4 truncate text-xl font-semibold tracking-[-0.03em] text-white sm:text-2xl">{songTitle}</h1>
        <p className="mt-1 truncate text-xs font-medium tracking-[0.08em] text-white/55 sm:text-sm">
          {songArtist}{songAlbum ? ` · ${songAlbum}` : ''}
        </p>
      </div>

      <div
        className="pointer-events-none absolute -left-[1.5vw] bottom-[8vh] z-0 max-w-[95vw] select-none overflow-hidden whitespace-nowrap font-black uppercase leading-none"
        aria-hidden="true"
        style={{
          color: 'transparent',
          fontSize: 'clamp(6rem, 17vw, 17rem)',
          letterSpacing: '-0.075em',
          WebkitTextStroke: `1px ${colorWithAlpha(palette.cool, 0.16)}`,
          transform: 'skewX(-8deg)',
        }}
      >
        {songTitle || 'GLORIOUS'}
      </div>

      <div className="pointer-events-none absolute right-[6vw] top-[8vh] z-20 flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.28em] text-white/42">
        <span>{wordTimingAvailable ? 'word sync / direct' : 'line timing / fallback'}</span>
        <span className="h-px w-16" style={{ background: `linear-gradient(90deg, ${palette.highlight}, transparent)` }} />
        <span className="text-white/75">{lineNumber} / {totalLines}</span>
      </div>

      {previous && (
        <motion.button
          type="button"
          onClick={() => onSeek?.(previous.line.time)}
          className="absolute left-[7vw] top-[23vh] z-20 max-w-[30vw] appearance-none border-0 bg-transparent p-0 text-left text-xs font-semibold tracking-[0.08em] text-white/30 hover:text-white/52"
          animate={{ opacity: 0.72 }}
          style={{ cursor: onSeek ? 'pointer' : 'default' }}
        >
          <span className="mr-3 font-mono text-[9px]" style={{ color: palette.cool }}>PREV</span>
          {previous.line.text}
        </motion.button>
      )}

      <AnimatePresence mode="wait">
        {currentLine && (
          <motion.div
            key={`${activeIndex}-${currentLine.time}-${currentLine.text}`}
            className="absolute z-10"
            initial={{
              opacity: 0,
              x: prefersReducedMotion ? 0 : scene.enterX,
              y: prefersReducedMotion ? 0 : scene.enterY,
              scale: prefersReducedMotion ? 1 : 0.9,
            }}
            animate={{
              opacity: 1,
              x: 0,
              y: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              x: prefersReducedMotion ? 0 : -scene.enterX * 0.42,
              y: prefersReducedMotion ? 0 : -28,
              scale: prefersReducedMotion ? 1 : 1.06,
            }}
            transition={{ duration: prefersReducedMotion ? 0.01 : 0.58, ease: [0.16, 1, 0.3, 1] }}
            style={{
              left: scene.left,
              top: scene.top,
              width: scene.width,
              rotate: `${scene.rotation}deg`,
              textAlign: scene.align,
            }}
          >
            <div
              aria-hidden="true"
              className={`mb-4 flex items-center gap-3 ${scene.align === 'right' ? 'justify-end' : scene.align === 'center' ? 'justify-center' : 'justify-start'}`}
            >
              <span className="font-mono text-[9px] font-bold uppercase tracking-[0.34em]" style={{ color: palette.highlight }}>
                live typography
              </span>
              <span className="h-px w-24" style={{ background: `linear-gradient(90deg, ${palette.highlight}, transparent)` }} />
            </div>

            <button
              type="button"
              onClick={() => onSeek?.(currentLine.time)}
              className="appearance-none border-0 bg-transparent p-0 font-black leading-[0.96] tracking-[-0.055em] [overflow-wrap:anywhere]"
              style={{
                color: 'white',
                cursor: onSeek ? 'pointer' : 'default',
                fontSize: 'clamp(2.9rem, 7.4vw, 7.8rem)',
                maxWidth: '100%',
              }}
            >
              <ProgressiveGlyphText
                line={currentLine}
                playbackTimeStore={playbackTimeStore}
                timeOffset={timeOffset}
                filledColor="rgb(255,255,255)"
                inactiveColor="rgba(255,255,255,.21)"
                glowColor={colorWithAlpha(palette.vivid, 0.86)}
              />
            </button>

            {(romanEnabled && currentLine.roman?.trim()) && (
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-5 text-sm font-semibold tracking-[0.12em] text-white/52"
              >
                {currentLine.roman}
              </motion.p>
            )}
            {(translationEnabled && currentLine.translation?.trim()) && (
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-2 text-base font-medium text-white/72"
              >
                {currentLine.translation}
              </motion.p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {next && (
        <motion.button
          type="button"
          onClick={() => onSeek?.(next.line.time)}
          className="absolute bottom-[17vh] right-[7vw] z-20 max-w-[33vw] appearance-none border-0 bg-transparent p-0 text-right text-sm font-semibold tracking-[0.05em] text-white/34 hover:text-white/58"
          animate={isPlaying && !prefersReducedMotion ? { x: [0, -5, 0] } : { x: 0 }}
          transition={{ duration: 3.2, repeat: isPlaying ? Infinity : 0, ease: 'easeInOut' }}
          style={{ cursor: onSeek ? 'pointer' : 'default' }}
        >
          {next.line.text}
          <span className="ml-3 font-mono text-[9px]" style={{ color: palette.highlight }}>NEXT</span>
        </motion.button>
      )}

      <div
        className="pointer-events-none absolute bottom-[8vh] left-[7vw] z-20 flex h-16 w-16 items-center justify-center rounded-full border border-white/16"
        aria-hidden="true"
        style={{ animation: isPlaying && !prefersReducedMotion ? 'glorious-orbit 18s linear infinite' : undefined }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: palette.highlight, boxShadow: `0 0 16px ${palette.vivid}` }} />
        <span className="absolute -top-1 h-2 w-px" style={{ background: palette.cool }} />
      </div>

      {Array.from({ length: 9 }, (_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className="pointer-events-none absolute z-0 h-px"
          style={{
            left: `${8 + (index * 17) % 82}%`,
            top: `${18 + (index * 23) % 68}%`,
            width: `${24 + (index * 19) % 86}px`,
            background: index % 2 === 0 ? colorWithAlpha(palette.highlight, 0.28) : 'rgba(255,255,255,0.12)',
            transform: `rotate(${index % 3 === 0 ? -12 : index % 3 === 1 ? 0 : 16}deg)`,
          }}
        />
      ))}

      <div aria-live="polite" className="sr-only">{currentLine?.text || ''}</div>
    </div>
  )
}
