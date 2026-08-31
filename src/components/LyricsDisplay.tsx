import { motion, AnimatePresence, useReducedMotion, useSpring } from 'framer-motion'
import { EMPTY_AUDIO_PULSE_STORE, type AudioPulseStore } from '../hooks/useAudioPulse'
import { memo, useEffect, useLayoutEffect, useMemo, useState, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { reconcileBoundaryParentheses } from '../utils/lyricBoundaryParentheses'
import { normalizeSequentialWordTiming, prepareLyricWords } from '../utils/lyricWordTiming'
import { getAgentTintColor, getAppleMusicSettings } from '../services/appleMusic'

/** 十六进制色 → rgba（对唱演唱者着色用） */
const hexToRgba = (hex: string, alpha: number) => {
  const match = hex.match(/^#([\da-f]{6})$/i)?.[1]
  if (!match) return hex
  const red = Number.parseInt(match.slice(0, 2), 16)
  const green = Number.parseInt(match.slice(2, 4), 16)
  const blue = Number.parseInt(match.slice(4, 6), 16)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

interface LyricWord {
  word: string
  startTime: number
  duration: number
}

interface LyricLine {
  time: number
  text: string
  content?: string
  words?: LyricWord[]
  translation?: string
  roman?: string
  romanWords?: LyricWord[]
  isGeneratedInterlude?: boolean
  /** 前奏间奏（长前奏开头插入的）：用创新的波浪进度条；歌曲中间的正常间奏仍用三点 */
  isIntroInterlude?: boolean
  interludeStartTime?: number
  interludeEndTime?: number
  /** Apple Music 对唱：ttm:agent id（如 v1/v2） */
  agent?: string
  agentName?: string
}

type WordByWordEffectMode = 'clear' | 'soft' | 'apple'
type AppleLyricLinePhase = 'played' | 'current' | 'upcoming'

interface AppleLyricLineMotion {
  opacity: number
  scale: number
  y: number
  blur: number
}

export const getAppleLyricLineMotion = (
  phase: AppleLyricLinePhase,
  distance: number,
  isManualScrolling = false,
): AppleLyricLineMotion => {
  if (isManualScrolling) {
    return { opacity: phase === 'current' ? 1 : 0.72, scale: 1, y: 0, blur: 0 }
  }
  if (phase === 'current') return { opacity: 1, scale: 1, y: 0, blur: 0 }
  if (phase === 'played') {
    return distance === 1
      ? { opacity: 0.46, scale: 0.965, y: -2, blur: 1.4 }
      : { opacity: 0.3, scale: 0.955, y: 0, blur: 2.6 }
  }
  return distance === 1
    ? { opacity: 0.66, scale: 0.98, y: 3, blur: 0.9 }
    : { opacity: 0.38, scale: 0.97, y: 0, blur: 2.2 }
}

type ImmersiveLyricEffect = 'soft-focus' | 'float' | 'breathe' | 'cinematic' | 'minimal'
type BackgroundEffect = 'transparent' | 'blur' | 'immersive'

const LYRIC_TIMING_LEAD_SECONDS = 0.28
const LYRIC_FRAME_INTERVAL_MS = 1000 / 30
const INTERLUDE_HIDE_BEFORE_NEXT_SECONDS = 1
const INTERLUDE_MIN_GAP_SECONDS = 5

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))

// 在两种 CSS 颜色之间插值（仅 Apple 逐字模式“词整体渐亮”使用，不影响 clear/soft）。
const interpolateColor = (from: string, to: string, t: number) => {
  const parse = (color: string) => {
    const match = color.trim().match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i)
    if (!match) return null
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] !== undefined ? Number(match[4]) : 1,
    }
  }
  const start = parse(from)
  const end = parse(to)
  if (!start || !end) return to
  const k = clamp(t)
  return `rgba(${Math.round(start.r + (end.r - start.r) * k)}, ${Math.round(start.g + (end.g - start.g) * k)}, ${Math.round(start.b + (end.b - start.b) * k)}, ${(start.a + (end.a - start.a) * k).toFixed(3)})`
}

interface SmoothPlaybackTimeStore {
  getSnapshot: () => number
  subscribe: (listener: () => void) => () => void
  publish: (time: number) => void
}

const createSmoothPlaybackTimeStore = (initialTime: number): SmoothPlaybackTimeStore => {
  let snapshot = initialTime
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: time => {
      if (Math.abs(snapshot - time) < 0.0005) return
      snapshot = time
      listeners.forEach(listener => listener())
    },
  }
}

function SmoothPlaybackTime({
  store,
  children,
}: {
  store: SmoothPlaybackTimeStore
  children: (time: number) => ReactNode
}) {
  const time = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return <>{children(time)}</>
}

interface SustainGlowProfile {
  glowStartTime: number
  endTime: number
  strength: number
}

interface SustainWordMetric {
  index: number
  startTime: number
  duration: number
  complexity: number
  normalizedDuration: number
  characterCount: number
  isLatinWord: boolean
}

interface PreparedLyricWord {
  word: LyricWord
  originalIndex: number
}

interface PreparedLyricLine {
  lyric: LyricLine
  wordsWithIndex: PreparedLyricWord[]
  sustainProfiles: Map<number, SustainGlowProfile>
  romanWordsToRender: LyricWord[]
}

const EMPTY_SUSTAIN_PROFILES = new Map<number, SustainGlowProfile>()

interface RgbColor {
  red: number
  green: number
  blue: number
}

const stripSustainMarkup = (text: string) => text
  .replace(/([\u4e00-\u9fff]+)\s*[（]([\u3040-\u309f\u30a0-\u30ff]+)[）]/g, '$1')
  .trim()

const countVocalCharacters = (text: string) => Array.from(text)
  .filter(character => /[\p{L}\p{N}]/u.test(character))
  .length

const lowerMedian = (values: number[]) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

const buildSustainGlowProfiles = (words: LyricWord[], lineText: string) => {
  const metrics = words.flatMap<SustainWordMetric>((word, index) => {
    const text = stripSustainMarkup(word.word || '')
    const characterCount = countVocalCharacters(text)
    if (characterCount === 0 || !Number.isFinite(word.duration) || word.duration <= 8) return []
    const isLatinWord = /^[A-Za-z?-??-??-??-?'?-]+$/u.test(text)
    const complexity = isLatinWord
      ? clamp(Math.sqrt(characterCount) * 0.82, 1, 2.35)
      : clamp(Math.sqrt(characterCount), 1, 1.8)
    const duration = Math.max(1, word.duration)

    return [{
      index,
      startTime: Math.max(0, word.startTime),
      duration,
      complexity,
      normalizedDuration: duration / complexity,
      characterCount,
      isLatinWord,
    }]
  })

  if (metrics.length === 0) return new Map<number, SustainGlowProfile>()

  // 部分歌词源（LRC/TTML）会把整行包装成一个带时长的伪 word。严格排除这种数据，
  // Avoid classifying every character as a sustain when timing data is sparse.
  if (metrics.length === 1) {
    const normalizedWord = stripSustainMarkup(words[metrics[0].index].word).replace(/\s+/gu, '')
    const normalizedLine = stripSustainMarkup(lineText).replace(/\s+/gu, '')
    if (metrics[0].characterCount > 1 && normalizedWord === normalizedLine) {
      return new Map<number, SustainGlowProfile>()
    }
  }

  const baselineNormalizedDuration = metrics.length === 1
    ? 420
    : clamp(lowerMedian(metrics.map(metric => metric.normalizedDuration)), 180, 1050)
  const candidates = metrics.flatMap(metric => {
    const expectedDuration = baselineNormalizedDuration * metric.complexity
    const isFinalVocalWord = metric.index === metrics[metrics.length - 1].index
    // 延音触发门槛（比默认更严格：需要明显超出正常发音时长的词才会触发）
    const relativeMultiplier = isFinalVocalWord ? 1.7 : 2.0
    const minimumExcess = isFinalVocalWord ? 650 : 600
    const absoluteMinimum = metric.isLatinWord
      ? 1400 + Math.min(500, Math.max(0, metric.characterCount - 1) * 60)
      : 1300 + Math.min(400, Math.max(0, metric.characterCount - 1) * 120)
    const requiredDuration = Math.max(
      absoluteMinimum,
      expectedDuration * relativeMultiplier,
      expectedDuration + minimumExcess,
    )

    if (metric.duration < requiredDuration) return []

    const excessDuration = metric.duration - expectedDuration
    const score = metric.normalizedDuration / Math.max(1, baselineNormalizedDuration)
      + excessDuration / 1000
      + (isFinalVocalWord ? 0.08 : 0)
    const articulationDuration = clamp(expectedDuration, 360, metric.duration - 320)

    return [{
      metric,
      score,
      profile: {
        glowStartTime: metric.startTime + articulationDuration,
        endTime: metric.startTime + metric.duration,
        strength: clamp(0.76 + (metric.duration - requiredDuration) / 1200, 0.76, 1),
      } satisfies SustainGlowProfile,
    }]
  })
  // Limit sustain highlights to the strongest sixth of the line.
  const maximumProfiles = Math.max(1, Math.round(metrics.length * 0.15))
  return new Map(
    candidates
      .sort((left, right) => right.score - left.score)
      .slice(0, maximumProfiles)
      .map(candidate => [candidate.metric.index, candidate.profile]),
  )
}

const smoothStep = (value: number) => {
  const progress = clamp(value)
  return progress * progress * (3 - 2 * progress)
}

const getSustainGlowIntensity = (profile: SustainGlowProfile | undefined, currentMs: number) => {
  if (!profile || currentMs < profile.glowStartTime || currentMs >= profile.endTime) return 0
  const ramp = smoothStep((currentMs - profile.glowStartTime) / 220)
  const release = smoothStep((profile.endTime - currentMs) / 170)
  const breath = 0.95 + Math.sin((currentMs - profile.glowStartTime) / 620) * 0.05
  return clamp(ramp * release * breath * profile.strength)
}

const parseLyricAccentColor = (color: string): RgbColor | null => {
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

const resolveReadableSustainColor = (accentColor: string) => {
  const parsed = parseLyricAccentColor(accentColor)
  if (!parsed) return { css: 'rgb(188, 207, 255)', rgb: { red: 188, green: 207, blue: 255 } }

  const luminance = (parsed.red * 0.2126 + parsed.green * 0.7152 + parsed.blue * 0.0722) / 255
  const whiteMix = clamp((0.62 - luminance) / 0.72, 0.08, 0.64)
  const mixChannel = (value: number) => Math.round(value + (255 - value) * whiteMix)
  const rgb = {
    red: mixChannel(parsed.red),
    green: mixChannel(parsed.green),
    blue: mixChannel(parsed.blue),
  }
  return { css: `rgb(${rgb.red}, ${rgb.green}, ${rgb.blue})`, rgb }
}

const getSustainTextShadow = (color: RgbColor, intensity: number) => {
  const alpha = clamp(intensity)
  return [
    `0 0 ${4 + alpha * 4}px rgba(255,255,255,${0.22 + alpha * 0.32})`,
    `0 0 ${11 + alpha * 9}px rgba(${color.red},${color.green},${color.blue},${0.34 + alpha * 0.28})`,
    `0 0 ${24 + alpha * 20}px rgba(${color.red},${color.green},${color.blue},${0.14 + alpha * 0.22})`,
    '0 4px 16px rgba(0,0,0,0.68)',
  ].join(', ')
}

const isStandaloneInterludeMarker = (text: string) => {
  const compactText = text.trim().replace(/\s+/g, '')
  // 独立间奏/分隔标记行：空行、连续点号、省略号、句号、波浪线、短横线等
  return compactText === '' || /^(?:\.{3,}|…{3,}|·{3,}|。{3,}|~{2,}|-{2,}|—{2,})$/u.test(compactText)
}

const estimateLyricEndTime = (lyric: LyricLine, nextLyricTime: number) => {
  const timedWordEndMs = lyric.words?.reduce((latestEnd, word) => {
    if (!Number.isFinite(word.startTime) || !Number.isFinite(word.duration)) return latestEnd
    return Math.max(latestEnd, word.startTime + Math.max(0, word.duration))
  }, 0) || 0

  if (timedWordEndMs >= 400) {
    return Math.min(nextLyricTime, lyric.time + timedWordEndMs / 1000)
  }

  // Plain LRC has no line-end timestamp, so estimate conservatively from the visible text.
  const characterCount = Math.max(1, Array.from(lyric.text.trim()).length)
  const estimatedDuration = clamp(1.15 + characterCount * 0.25, 1.8, 5.8)
  return Math.min(nextLyricTime, lyric.time + estimatedDuration)
}

const buildLyricsWithGeneratedInterludes = (lyrics: LyricLine[]) => {
  // 过滤占位间奏行 + 元数据/标题行（词/曲/编曲署名、"歌名 - 歌手"标题）——这些行
  // 不该出现在歌词区；长前奏时若保留它们，前奏期会显示"编曲：xxx"或空
  const isMetadataLine = (text: string, time: number) => {
    const t = String(text || '').trim()
    if (/^(词|曲|编曲|作词|作曲|演唱|唱|歌手|专辑|制作|混音|母带|录音|作|编|监制|by|ti|ar|al|offset)\s*[:：]/i.test(t)) return true
    if (time < 2 && /^.{1,40}[-—–]\s*.{1,40}$/.test(t)) return true
    return false
  }
  const sourceLyrics = lyrics.filter(lyric => !isStandaloneInterludeMarker(lyric.text || '') && !isMetadataLine(lyric.text || '', lyric.time ?? 0))
  const result: LyricLine[] = []

  // 长前奏（第一句歌词很晚才出现，如 宫 21s 前奏）：在开头生成一条间奏（波浪进度条），
  // 前奏期显示波浪随进度填充；歌曲中间的间奏仍用三点（isIntroInterlude 区分）
  if (sourceLyrics.length > 0) {
    const introEnd = sourceLyrics[0].time - INTERLUDE_HIDE_BEFORE_NEXT_SECONDS
    if (introEnd > INTERLUDE_MIN_GAP_SECONDS) {
      result.push({
        time: LYRIC_TIMING_LEAD_SECONDS,
        text: '',
        isGeneratedInterlude: true,
        isIntroInterlude: true,
        interludeStartTime: 0,
        interludeEndTime: introEnd,
      })
    }
  }

  sourceLyrics.forEach((lyric, index) => {
    result.push(lyric)
    const nextLyric = sourceLyrics[index + 1]
    if (!nextLyric) return

    const interludeStartTime = estimateLyricEndTime(lyric, nextLyric.time)
    const interludeEndTime = nextLyric.time - INTERLUDE_HIDE_BEFORE_NEXT_SECONDS
    if (nextLyric.time - interludeStartTime <= INTERLUDE_MIN_GAP_SECONDS) return

    // Compensate for the normal lyric lead so the temporary row starts at the real line end.
    result.push({
      time: interludeStartTime + LYRIC_TIMING_LEAD_SECONDS,
      text: '',
      isGeneratedInterlude: true,
      interludeStartTime,
      interludeEndTime,
    })
  })

  return result
}

const alignRomanWordsToLyricTiming = (romanWords: LyricWord[], lyricWords: LyricWord[] = []) => {
  const roman = romanWords.filter(word => word.word?.trim())
  const source = lyricWords.filter(word => word.word?.trim())
  if (roman.length === 0 || source.length === 0) return roman

  if (roman.length === source.length) {
    return roman.map((word, index) => ({
      ...word,
      startTime: source[index].startTime,
      duration: Math.max(1, source[index].duration),
    }))
  }

  const sourceEnd = source.reduce(
    (end, word) => Math.max(end, word.startTime + Math.max(1, word.duration)),
    0
  )
  const hasIncreasingRomanTimes = roman.some((word, index) => (
    index > 0 && word.startTime > roman[index - 1].startTime
  ))

  if (hasIncreasingRomanTimes) {
    return roman.map((word, index) => {
      const startTime = Math.max(0, word.startTime)
      const nextStart = roman.slice(index + 1).find(next => next.startTime > startTime)?.startTime
      const rawEnd = startTime + Math.max(1, word.duration)
      const endTime = Math.min(rawEnd, nextStart ?? sourceEnd)
      return { ...word, startTime, duration: Math.max(1, endTime - startTime) }
    })
  }

  const totalCharacters = Math.max(1, roman.reduce((count, word) => count + Array.from(word.word).length, 0))
  let elapsedCharacters = 0
  return roman.map(word => {
    const characterCount = Math.max(1, Array.from(word.word).length)
    const startTime = sourceEnd * elapsedCharacters / totalCharacters
    elapsedCharacters += characterCount
    const endTime = sourceEnd * elapsedCharacters / totalCharacters
    return { ...word, startTime, duration: Math.max(1, endTime - startTime) }
  })
}

const prepareLyricLine = (lyric: LyricLine, sustainGlowEnabled: boolean): PreparedLyricLine => {
  const sequentialWords = prepareLyricWords(lyric)
  const sourceWords = normalizeSequentialWordTiming(lyric.words || [])
  const fixedRomanWords = lyric.romanWords
    ? reconcileBoundaryParentheses(lyric.roman || '', lyric.romanWords)
    : undefined
  const romanWordsToRender = lyric.romanWords?.length
    ? normalizeSequentialWordTiming(
        alignRomanWordsToLyricTiming(fixedRomanWords || lyric.romanWords, sourceWords)
      ).filter(word => Boolean(word.word?.trim()))
    : []

  return {
    lyric,
    wordsWithIndex: sequentialWords.map((word, originalIndex) => ({ word, originalIndex })),
    sustainProfiles: sustainGlowEnabled
      ? buildSustainGlowProfiles(sequentialWords, lyric.text || lyric.content || '')
      : EMPTY_SUSTAIN_PROFILES,
    romanWordsToRender,
  }
}

const estimateTextColumns = (text: string) => {
  return Array.from(text.trim()).reduce((columns, char) => {
    if (/\s/.test(char)) return columns + 0.35
    if (/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(char)) return columns + 2
    return columns + 1
  }, 0)
}

const getLongestTokenLength = (text: string) => Math.max(0, ...text.trim().split(/\s+/).map(token => token.length))

const isCrowdedLyricLine = (text: string, lyricSize: number) => {
  const columns = estimateTextColumns(text)
  const longestToken = getLongestTokenLength(text)
  return (
    columns > 24
    || longestToken > 22
    || (lyricSize >= 2.6 && columns > 18)
    || (lyricSize >= 3.2 && columns > 14)
    || (lyricSize >= 3.8 && columns > 12)
  )
}

interface LyricsDisplayProps {
  currentTime: number
  isPlaying: boolean
  accentColor: string
  lyrics?: LyricLine[]
  translationEnabled?: boolean
  translationPosition?: 'traditional' | 'bottom-right'
  onCurrentTranslationChange?: (translation: string) => void
  onSeek?: (time: number) => void
  romanEnabled?: boolean
  displayMode?: 'scroll' | 'single'
  scrollAlignment?: 'left' | 'center'
  layoutContext?: 'player' | 'desktop'
  lyricSizeOverride?: number
  wordByWordEnabledOverride?: boolean
  wordByWordEffectModeOverride?: WordByWordEffectMode
  lyricGlowOverride?: boolean
  sustainGlowEnabled?: boolean
  animationModeOverride?: 'elegant' | 'normal' | 'dynamic'
  singlePlacementMode?: 'dynamic' | 'centered'
  immersiveEffect?: ImmersiveLyricEffect
  immersiveAvoidTopLeft?: boolean
  backgroundEffect?: BackgroundEffect
  isTransitioning?: boolean
  trackId?: string | number
  pulseStore?: AudioPulseStore
  playerTheme?: 'light' | 'dark'
  /** 歌词切换动画：传统（原生 scrollTo 居中）或 崭新（弹簧 transform，零布局跳动，Apple Music 风） */
  scrollTransitionStyle?: 'classic' | 'amodern'
}

export default memo(function LyricsDisplay({ 
  currentTime, 
  isPlaying, 
  accentColor, 
  lyrics,
  translationEnabled = true,
  translationPosition = 'traditional',
  onCurrentTranslationChange,
  onSeek,
  romanEnabled = false,
  displayMode = 'scroll',
  scrollAlignment = 'left',
  layoutContext = 'player',
  lyricSizeOverride,
  wordByWordEnabledOverride,
  wordByWordEffectModeOverride,
  lyricGlowOverride,
  sustainGlowEnabled = false,
  animationModeOverride,
  singlePlacementMode = 'dynamic',
  immersiveEffect,
  immersiveAvoidTopLeft = true,
  backgroundEffect = 'blur',
  isTransitioning = false,
  trackId,
  pulseStore = EMPTY_AUDIO_PULSE_STORE,
  playerTheme = 'dark',
  scrollTransitionStyle = 'classic',
}: LyricsDisplayProps) {
  const isLightTheme = playerTheme === 'light'
  const isModernScroll = displayMode === 'scroll' && scrollTransitionStyle === 'amodern'
  // 浅色主题下歌词用深色文字，保证在淡白雾背景上可读
  const activeLyricColor = isLightTheme ? 'rgba(15, 15, 15, 0.92)' : 'rgba(255, 255, 255, 1)'
  const inactiveLyricColor = isLightTheme ? 'rgba(0, 0, 0, 0.38)' : 'rgba(255, 255, 255, 0.38)'
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [, setManualScrollOffset] = useState(0) // 
  const [isManualScrolling, setIsManualScrolling] = useState(false)
  const [isJumping, setIsJumping] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [hoverTimer, setHoverTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [blinkingIndex, setBlinkingIndex] = useState<number | null>(null) // 
  const [showGlassFrame, setShowGlassFrame] = useState(false)
  const [jumpTargetIndex, setJumpTargetIndex] = useState<number | null>(null)
  const [wordByWordEnabled, setWordByWordEnabled] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [wordByWordEffectMode, setWordByWordEffectMode] = useState<WordByWordEffectMode>(() => {
    const saved = localStorage.getItem('wordByWordEffectMode')
    if (saved === 'soft' || saved === 'apple') return saved
    return 'clear'
  })
  const [lyricSize, setLyricSize] = useState(() => {
    const saved = localStorage.getItem('lyricSize')
    return saved ? parseFloat(saved) : 2.8
  })
  const [lyricGlow, setLyricGlow] = useState(() => {
    const saved = localStorage.getItem('lyricGlow')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [lyricOffset, setLyricOffset] = useState(() => {
    const saved = localStorage.getItem('lyricOffset')
    return saved ? parseFloat(saved) : 0
  })
  const [animationMode, setAnimationMode] = useState<'elegant' | 'normal' | 'dynamic'>(() => {
    const saved = localStorage.getItem('animationMode')
    return (saved as 'elegant' | 'normal' | 'dynamic') || 'elegant'
  })
  const [storedImmersiveEffect, setStoredImmersiveEffect] = useState<ImmersiveLyricEffect>(() => {
    const saved = localStorage.getItem('immersiveLyricEffect')
    return (saved as ImmersiveLyricEffect) || 'soft-focus'
  })
  const effectiveLyricSize = lyricSizeOverride ?? lyricSize
  const effectiveWordByWordEnabled = wordByWordEnabledOverride ?? wordByWordEnabled
  const effectiveWordByWordEffectMode = wordByWordEffectModeOverride ?? wordByWordEffectMode
  const effectiveLyricGlow = lyricGlowOverride ?? lyricGlow
  const sustainGlowColor = useMemo(() => resolveReadableSustainColor(accentColor), [accentColor])
  const effectiveAnimationMode = animationModeOverride ?? animationMode
  const prefersReducedMotion = Boolean(useReducedMotion())
  const isAppleLineMode = displayMode === 'scroll'
    && effectiveWordByWordEnabled
    && effectiveWordByWordEffectMode === 'apple'
  const isDesktopLayout = layoutContext === 'desktop'
  const containerRef = useRef<HTMLDivElement>(null)
  // 崭新模式：弹簧 transform 滚动引擎（零布局跳动，Apple Music 风）
  const springY = useSpring(0, { stiffness: 190, damping: 26, mass: 1.1 })
  const springWrapRef = useRef<HTMLDivElement>(null)
  const [modernManualY, setModernManualY] = useState(0)
  const modernReturnTimerRef = useRef<number | null>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jumpAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPointerInsideRef = useRef(false)
  const isManualScrollingRef = useRef(isManualScrolling)
  const currentIndexRef = useRef(currentIndex)
  const rafTimeRef = useRef({ time: currentTime, startedAt: performance.now() })
  const lastLyricFrameRef = useRef(0)
  const wordRafRef = useRef<number | null>(null)
  const smoothTimeStoreRef = useRef<SmoothPlaybackTimeStore | null>(null)
  if (!smoothTimeStoreRef.current) {
    smoothTimeStoreRef.current = createSmoothPlaybackTimeStore(currentTime)
  }
  const activePulseLineRef = useRef<HTMLDivElement>(null)
  const lyricTextRefs = useRef<Record<number, HTMLParagraphElement | null>>({})

  currentIndexRef.current = currentIndex
  isManualScrollingRef.current = isManualScrolling

  const displayLyricsData = useMemo(
    () => buildLyricsWithGeneratedInterludes(lyrics || []),
    [lyrics]
  )
  const preparedLyricsData = useMemo(
    () => displayLyricsData.map(lyric => prepareLyricLine(lyric, sustainGlowEnabled)),
    [displayLyricsData, sustainGlowEnabled]
  )
  // 是否有需要逐字时钟的歌词（逐字词或注音逐字词）
  const hasWordTimedLines = useMemo(
    () => preparedLyricsData.some(line => line.wordsWithIndex.length > 0 || line.romanWordsToRender.length > 0),
    [preparedLyricsData]
  )
  // 是否有生成的间奏行（其圆点进度动画依赖平滑时钟）
  const hasGeneratedInterludes = useMemo(
    () => displayLyricsData.some(line => line.isGeneratedInterlude),
    [displayLyricsData]
  )
  // 无逐字歌词且无间奏动画时，30fps 平滑时钟无消费者，播放中应停止空转
  const needsSmoothPlaybackClock = hasWordTimedLines || hasGeneratedInterludes
  // 对唱歌词：统计演唱者数量（≥2 才着色），并读取用户设置开关
  const appleAgentCount = useMemo(
    () => new Set(displayLyricsData.map(line => line.agent).filter(Boolean)).size,
    [displayLyricsData]
  )
  const appleDuetColorsEnabled = useMemo(() => getAppleMusicSettings().duetColors, [])

  useEffect(() => {
    const updatePulseScale = () => {
      const node = activePulseLineRef.current
      if (!node) return
      const restlessPulse = pulseStore.getSnapshot().restless
      node.style.setProperty('--restless-lyric-scale', String(1.008 + restlessPulse * 0.021))
    }

    updatePulseScale()
    return pulseStore.subscribe(updatePulseScale)
  }, [pulseStore, currentIndex, displayMode])

  useEffect(() => {
    rafTimeRef.current = { time: currentTime, startedAt: performance.now() }
    smoothTimeStoreRef.current!.publish(currentTime)
  }, [currentTime])

  useEffect(() => {
    // 暂停、无逐字歌词且无间奏动画时无需 30fps 平滑时钟
    if (!isPlaying || !needsSmoothPlaybackClock) {
      if (wordRafRef.current !== null) {
        cancelAnimationFrame(wordRafRef.current)
        wordRafRef.current = null
      }
      return
    }

    const tick = () => {
      // 窗口隐藏时停帧（Electron backgroundThrottling 关闭，rAF 后台仍全速执行）
      if (document.visibilityState === 'hidden') {
        wordRafRef.current = null
        return
      }
      const now = performance.now()
      if (now - lastLyricFrameRef.current >= LYRIC_FRAME_INTERVAL_MS) {
        const elapsed = (now - rafTimeRef.current.startedAt) / 1000
        smoothTimeStoreRef.current!.publish(rafTimeRef.current.time + elapsed)
        lastLyricFrameRef.current = now
      }
      wordRafRef.current = requestAnimationFrame(tick)
    }

    const onVisibilityChange = () => {
      // 窗口恢复可见时重启平滑时钟（若组件仍应播放）
      if (document.visibilityState === 'visible' && wordRafRef.current === null) {
        wordRafRef.current = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    wordRafRef.current = requestAnimationFrame(tick)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (wordRafRef.current !== null) {
        cancelAnimationFrame(wordRafRef.current)
        wordRafRef.current = null
      }
    }
  }, [isPlaying, needsSmoothPlaybackClock])

  const clearReturnTimer = () => {
    if (returnTimerRef.current) {
      clearTimeout(returnTimerRef.current)
      returnTimerRef.current = null
    }
  }

  const scheduleReturnAfterPointerLeave = () => {
    clearReturnTimer()
    if (isModernScroll) {
      modernReturnTimerRef.current = window.setTimeout(() => {
        modernReturnTimerRef.current = null
        if (isPointerInsideRef.current) return
        setIsManualScrolling(false)
        setModernManualY(0)
      }, 2000)
      return
    }
    returnTimerRef.current = setTimeout(() => {
      returnTimerRef.current = null
      if (isPointerInsideRef.current) return

      isManualScrollingRef.current = false
      setIsManualScrolling(false)
      setManualScrollOffset(0)
      const activeIndex = currentIndexRef.current
      if (activeIndex >= 0) {
        scheduleScrollLineToCenter(activeIndex, 'smooth')
      }
    }, 2000)
  }

  const getCenteredScrollTop = (container: HTMLElement, el: HTMLElement) => {
    const containerRect = container.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    const currentDelta = (elRect.top + elRect.height / 2) - (containerRect.top + containerRect.height / 2)
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight)
    return clamp(container.scrollTop + currentDelta, 0, maxScroll)
  }

  const scrollLineToCenter = (index: number, behavior: ScrollBehavior = 'smooth') => {
    const container = containerRef.current
    const el = container?.querySelector(`[data-index="${index}"]`) as HTMLElement | null
    if (!container || !el) return

    container.scrollTo({ top: getCenteredScrollTop(container, el), behavior })
  }

  const scheduleScrollLineToCenter = (index: number, behavior: ScrollBehavior = 'smooth') => {
    requestAnimationFrame(() => {
      scrollLineToCenter(index, behavior)
      requestAnimationFrame(() => scrollLineToCenter(index, behavior))
    })
  }
  
  // 崭新模式：滚轮手动偏移（累积 px，2 秒无操作弹簧归位）
  // 手动偏移必须钳在歌词内容范围内：上滚最多到首句中心到焦点线（上方不出现空白）、
  // 下滚最多到末句中心到焦点线（下方不出现空白）——否则能一路滚出歌词到空白
  const clampModernManualY = (y: number): number => {
    const wrap = springWrapRef.current
    if (!wrap || displayLyricsData.length === 0) return y
    const cur = wrap.querySelector(`[data-index="${currentIndex}"]`) as HTMLElement | null
    const first = wrap.querySelector('[data-index="0"]') as HTMLElement | null
    const last = wrap.querySelector(`[data-index="${displayLyricsData.length - 1}"]`) as HTMLElement | null
    if (!cur || !first || !last) return y
    const curCenter = cur.offsetTop + cur.offsetHeight / 2
    const minY = first.offsetTop + first.offsetHeight / 2 - curCenter
    const maxY = last.offsetTop + last.offsetHeight / 2 - curCenter
    return clamp(y, Math.min(minY, maxY), Math.max(minY, maxY))
  }
  const handleModernWheel = (e: React.WheelEvent) => {
    if (isJumping) return
    isManualScrollingRef.current = true
    setIsManualScrolling(true)
    setModernManualY((prev) => {
      const next = prev + e.deltaY
      if (modernReturnTimerRef.current) { window.clearTimeout(modernReturnTimerRef.current); modernReturnTimerRef.current = null }
      return clampModernManualY(next)
    })
    scheduleReturnAfterPointerLeave()
  }

  // 处理鼠标滚轮滚动
  const handleWheel = (e: React.WheelEvent) => {
    if (isModernScroll) { handleModernWheel(e); return }
    // React onWheel may be passive, so this handler does not call preventDefault
    // Handle only the lyric scrolling state here
    
    // 璺宠浆鏈熼棿绂佺敤婊氬姩
    if (isJumping) return
    
    isManualScrollingRef.current = true
    setIsManualScrolling(true)
    setManualScrollOffset(prev => {
      const delta = e.deltaY / 300 // Move roughly one line per 300 pixels
      const newOffset = prev + delta
      
      // Keep the target between the first and last lyric lines
      // Playing index plus manual offset gives the visual center line
      const targetIndex = currentIndex + newOffset
      
      if (targetIndex < 0) {
        // Do not scroll before the first line
        return -currentIndex
      } else if (targetIndex >= displayLyricsData.length - 1) {
        // Do not scroll after the final line
        return displayLyricsData.length - 1 - currentIndex
      }
      
      return newOffset
    })
    
    // Never auto-return while the pointer is inside the lyric panel.
    clearReturnTimer()
  }

  const handleContainerMouseEnter = () => {
    isPointerInsideRef.current = true
    clearReturnTimer()
  }
  
  // 处理容器鼠标移出
  const handleContainerMouseLeave = () => {
    isPointerInsideRef.current = false
    if (isManualScrollingRef.current) {
      scheduleReturnAfterPointerLeave()
    }
  }
  
  // 处理歌词悬停
  const handleLyricMouseEnter = (index: number) => {
    setHoveredIndex(index)
    setShowGlassFrame(false)
    setBlinkingIndex(null)
    
    // Clear the scroll return timer
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    
    // Clear the automatic return timer
    clearReturnTimer()
    
    // 清除之前的悬停计时器
    if (hoverTimer) {
      clearTimeout(hoverTimer)
    }
    
    // Show delayed blink feedback only during manual scrolling
    if (isManualScrolling) {
      const timer = setTimeout(() => {
        setBlinkingIndex(index)
      }, 2000)
      
      setHoverTimer(timer)
    }
  }
  
  // 处理歌词移出
  const handleLyricMouseLeave = () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      setHoverTimer(null)
    }
    setShowGlassFrame(false)
    setBlinkingIndex(null)
    
    setTimeout(() => {
      setHoveredIndex(null)
    }, 300)
    
    // Keep the current position until the automatic return timer runs
  }
  
  // 处理点击跳转
  const handleLyricClick = (time: number, index: number) => {
    if (onSeek && time >= 0) {
      onSeek(time)
      
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = null
      }
      if (hoverTimer) {
        clearTimeout(hoverTimer)
        setHoverTimer(null)
      }
      clearReturnTimer()
      if (jumpAnimationTimerRef.current) {
        clearTimeout(jumpAnimationTimerRef.current)
      }
      
      setShowGlassFrame(false)
      setHoveredIndex(null)
      setBlinkingIndex(null)
      setJumpTargetIndex(index)
      
      // Mark this as an animated jump
      setIsJumping(true)
      isManualScrollingRef.current = false
      setIsManualScrolling(false)
      setManualScrollOffset(0)
      setModernManualY(0)
      scheduleScrollLineToCenter(index, 'smooth')

      jumpAnimationTimerRef.current = setTimeout(() => {
        setIsJumping(false)
        setJumpTargetIndex(null)
        jumpAnimationTimerRef.current = null
      }, 700)
    }
  }
  
  // Watch lyric preferences stored in localStorage
  useEffect(() => {
    const handleStorageChange = () => {
      const saved = localStorage.getItem('wordByWordLyrics')
      setWordByWordEnabled(saved !== null ? JSON.parse(saved) : true)
    }
    
    const handleLyricSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setLyricSize(customEvent.detail)
    }
    
    const handleLyricGlowChange = () => {
      const saved = localStorage.getItem('lyricGlow')
      setLyricGlow(saved !== null ? JSON.parse(saved) : true)
    }

    const handleWordByWordEffectModeChange = (e: Event) => {
      const customEvent = e as CustomEvent<WordByWordEffectMode>
      const next = customEvent.detail
      setWordByWordEffectMode(next === 'soft' || next === 'apple' ? next : 'clear')
    }
    
    const handleLyricOffsetChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setLyricOffset(customEvent.detail)
    }
    
    const handleAnimationModeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setAnimationMode(customEvent.detail)
    }

    const handleImmersiveEffectChange = (e: Event) => {
      const customEvent = e as CustomEvent<ImmersiveLyricEffect>
      setStoredImmersiveEffect(customEvent.detail || 'soft-focus')
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('wordByWordLyricsChanged', handleStorageChange)
    window.addEventListener('wordByWordEffectModeChanged', handleWordByWordEffectModeChange as EventListener)
    window.addEventListener('lyricSizeChanged', handleLyricSizeChange as EventListener)
    window.addEventListener('lyricGlowChanged', handleLyricGlowChange)
    window.addEventListener('lyricOffsetChanged', handleLyricOffsetChange as EventListener)
    window.addEventListener('animationModeChanged', handleAnimationModeChange as EventListener)
    window.addEventListener('immersiveLyricEffectChanged', handleImmersiveEffectChange as EventListener)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('wordByWordLyricsChanged', handleStorageChange)
      window.removeEventListener('wordByWordEffectModeChanged', handleWordByWordEffectModeChange as EventListener)
      window.removeEventListener('lyricSizeChanged', handleLyricSizeChange as EventListener)
      window.removeEventListener('lyricGlowChanged', handleLyricGlowChange)
      window.removeEventListener('lyricOffsetChanged', handleLyricOffsetChange as EventListener)
      window.removeEventListener('animationModeChanged', handleAnimationModeChange as EventListener)
      window.removeEventListener('immersiveLyricEffectChanged', handleImmersiveEffectChange as EventListener)
    }
  }, [translationEnabled, translationPosition])
  
  // Keep the lyric cursor atomic with a song/lyric payload change. Resetting to
  // -1 for one painted frame made a naturally transitioned song briefly show
  // its not-yet-playing opening lines before the next timeupdate corrected it.
  const prevTrackIdRef = useRef(trackId)
  useLayoutEffect(() => {
    const trackChanged = prevTrackIdRef.current !== trackId
    prevTrackIdRef.current = trackId
    const adjustedTime = currentTime + LYRIC_TIMING_LEAD_SECONDS + lyricOffset
    let nextIndex = -1
    if (trackChanged && displayLyricsData.length > 0) {
      // 切歌瞬间 currentTime 可能还是上一首的值（引擎位置一帧滞后），按它扫描会
      // 把焦点锚到新歌词的中部（用户实测"焦点莫名其妙跑到歌词中部"）。
      // 切歌一律先锚定第一句，等时间驱动 effect（currentTime 归位后）接管。
      nextIndex = 0
    } else {
      for (let index = displayLyricsData.length - 1; index >= 0; index -= 1) {
        if (adjustedTime >= displayLyricsData[index].time) {
          const line = displayLyricsData[index]
          const shouldPreselectNextLine = line.isGeneratedInterlude
            && line.interludeEndTime !== undefined
            && currentTime + lyricOffset >= line.interludeEndTime
            && index + 1 < displayLyricsData.length
          nextIndex = shouldPreselectNextLine ? index + 1 : index
          break
        }
      }
    }

    currentIndexRef.current = nextIndex
    setCurrentIndex(nextIndex)
    if (trackChanged) {
      if (modernReturnTimerRef.current !== null) {
        window.clearTimeout(modernReturnTimerRef.current)
        modernReturnTimerRef.current = null
      }
      if (jumpAnimationTimerRef.current !== null) {
        window.clearTimeout(jumpAnimationTimerRef.current)
        jumpAnimationTimerRef.current = null
      }
      isManualScrollingRef.current = false
      setIsManualScrolling(false)
      setManualScrollOffset(0)
      setModernManualY(0)
      setIsJumping(false)
      setJumpTargetIndex(null)
    }
    onCurrentTranslationChange?.(nextIndex >= 0 ? (displayLyricsData[nextIndex].translation ?? '') : '')
    // Old lyric lines are unmounted on song change, but their DOM nodes stay
    // referenced in this record forever. Clear it so refs don't accumulate
    // across songs.
    lyricTextRefs.current = {}
    // The lyric nodes already exist for the new payload during this layout
    // phase, so center synchronously before the browser can paint its top.
    if (nextIndex >= 0) scrollLineToCenter(nextIndex, 'auto')
  }, [displayLyricsData, trackId])

  useEffect(() => {
    return () => {
      if (returnTimerRef.current) {
        clearTimeout(returnTimerRef.current)
      }
      if (jumpAnimationTimerRef.current) {
        clearTimeout(jumpAnimationTimerRef.current)
      }
      if (modernReturnTimerRef.current !== null) {
        window.clearTimeout(modernReturnTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (displayLyricsData.length === 0) return
    const adjustedTime = currentTime + LYRIC_TIMING_LEAD_SECONDS + lyricOffset
    
    // 前奏期（第一句歌词还没到）：保持第一句显示而不是空白——
    // 长前奏（宫 21s 前奏）时歌词区必须可见，否则前奏期间一片空白
    if (adjustedTime < displayLyricsData[0].time) {
      if (currentIndex !== 0) {
        setCurrentIndex(0)
        if (onCurrentTranslationChange) {
          onCurrentTranslationChange(displayLyricsData[0].translation ?? '')
        }
      }
      return
    }
    
    for (let i = displayLyricsData.length - 1; i >= 0; i--) {
      if (adjustedTime >= displayLyricsData[i].time) {
        const activeLine = displayLyricsData[i]
        const realPlaybackTime = currentTime + lyricOffset
        const shouldPreselectNextLine = activeLine.isGeneratedInterlude
          && activeLine.interludeEndTime !== undefined
          && realPlaybackTime >= activeLine.interludeEndTime
          && i + 1 < displayLyricsData.length
        const nextIndex = shouldPreselectNextLine ? i + 1 : i

        if (currentIndex !== nextIndex) {
          setCurrentIndex(nextIndex)
          if (onCurrentTranslationChange) {
            const translation = displayLyricsData[nextIndex].translation ?? ''
            onCurrentTranslationChange(translation)
          }
        }
        break
      }
    }
  }, [currentTime, displayLyricsData, currentIndex, onCurrentTranslationChange, lyricOffset])

  // Automatically scroll to the active lyric
  useEffect(() => {
    if (isModernScroll || isManualScrolling) return
    if (currentIndex >= 0) {
      scheduleScrollLineToCenter(currentIndex, 'smooth')
    }
  }, [
    currentIndex,
    isManualScrolling,
    effectiveLyricSize,
    romanEnabled,
    translationEnabled,
    translationPosition,
    effectiveWordByWordEnabled,
    effectiveWordByWordEffectMode,
  ])

  useEffect(() => {
    if (isModernScroll || isManualScrolling || currentIndex < 0 || typeof ResizeObserver === 'undefined') return

    const container = containerRef.current
    const el = container?.querySelector(`[data-index="${currentIndex}"]`) as HTMLElement | null
    if (!container || !el) return

    let frame: number | null = null
    const recenter = () => {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => scrollLineToCenter(currentIndex, 'auto'))
    }
    const observer = new ResizeObserver(recenter)
    observer.observe(container)
    observer.observe(el)
    recenter()

    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [
    currentIndex,
    isManualScrolling,
    effectiveLyricSize,
    romanEnabled,
    translationEnabled,
    translationPosition,
    effectiveWordByWordEnabled,
    effectiveWordByWordEffectMode,
  ])

  // 崭新模式：弹簧 transform 驱动滚动（零布局跳动）
  useEffect(() => {
    if (!isModernScroll) return
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const track = springWrapRef.current
      if (!track) return
      const el = track.querySelector(`[data-index="${currentIndex}"]`) as HTMLElement | null
      if (!el) return
      const focalY = container.clientHeight * 0.36
      if (focalY <= 0) return  // 容器尚未完成布局，待 ResizeObserver 触发真实尺寸
      const relTop = el.offsetTop
      const target = focalY - (relTop + el.offsetHeight / 2) - modernManualY
      if (prefersReducedMotion) springY.jump(target)
      else springY.set(target)
    }
    // 初始测量：容器有尺寸时直接算，否则等 ResizeObserver 异步触发
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (springWrapRef.current) observer.observe(springWrapRef.current)
    return () => observer.disconnect()
  }, [isModernScroll, currentIndex, modernManualY, effectiveLyricSize, displayLyricsData, isManualScrolling, prefersReducedMotion, springY])

  if (!lyrics || lyrics.length === 0) {
    return null
  }

  // Render every lyric line without trimming the collection
  const displayLyrics = displayLyricsData

  const getLineTiming = (lineIndex: number, playbackTime = currentTime) => {
    const line = displayLyricsData[lineIndex]
    const nextLine = displayLyricsData[lineIndex + 1]
    const adjustedTime = playbackTime + LYRIC_TIMING_LEAD_SECONDS + lyricOffset
    const lineStart = line?.time ?? 0
    const lineEnd = nextLine?.time ?? lineStart + 4.2
    const duration = Math.max(1.2, lineEnd - lineStart)
    const progress = clamp((adjustedTime - lineStart) / duration)
    const upcomingProgress = lineIndex === currentIndex + 1
      ? clamp(1 - ((lineStart - adjustedTime) / Math.min(1.45, duration)))
      : 0
    const releaseElapsed = lineIndex === currentIndex - 1
      ? adjustedTime - lineEnd
      : -1
    const releaseProgress = releaseElapsed >= 0 && releaseElapsed <= 0.72
      ? clamp(releaseElapsed / 0.72)
      : 0

    return {
      progress,
      upcomingProgress,
      releaseProgress,
      glowPulse: Math.sin(progress * Math.PI),
    }
  }

  const getWordEffectConfig = (mode: WordByWordEffectMode) => {
    switch (mode) {
      case 'apple':
        // Apple Music 风格：词/字整体渐亮（不走 clear/soft 的 mask 填充路径）。
        // 独立配置，不影响 clear/soft。
        return {
          isSoft: true,
          isApple: true,
          wordRowGap: '0.12em',
          wordPaddingX: '0',
          linePaddingX: '0.14em',
          wordLineHeight: 1.26,
          inactiveColor: isLightTheme ? 'rgba(0, 0, 0, 0.36)' : 'rgba(255, 255, 255, 0.36)',
          inactiveFilter: 'none',
          fillExtension: 0,
          baseTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.24)' : '0 2px 9px rgba(0,0,0,0.24)',
          activeTextShadow: isLightTheme ? '0 2px 10px rgba(255,255,255,0.32)' : '0 0 16px rgba(255,255,255,0.28), 0 2px 10px rgba(0,0,0,0.34)',
          completedTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.3)' : '0 2px 9px rgba(0,0,0,0.3)',
        }
      case 'soft':
        return {
          isSoft: true,
          isApple: false,
          wordRowGap: '0.12em',
          wordPaddingX: '0',
          linePaddingX: '0.12em',
          wordLineHeight: 1.28,
          inactiveColor: isLightTheme ? 'rgba(0, 0, 0, 0.38)' : 'rgba(255, 255, 255, 0.38)',
          inactiveFilter: 'blur(0.3px)',
          fillExtension: 42,
          baseTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.24)' : '0 2px 9px rgba(0,0,0,0.24)',
          activeTextShadow: isLightTheme ? '0 3px 12px rgba(255,255,255,0.36)' : '0 0 14px rgba(255,255,255,0.25), 0 3px 12px rgba(0,0,0,0.36)',
          completedTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.3)' : '0 2px 9px rgba(0,0,0,0.3)',
        }
      case 'clear':
      default:
        return {
          isSoft: false,
          isApple: false,
          wordRowGap: '0.14em',
          wordPaddingX: '0',
          linePaddingX: '0.1em',
          wordLineHeight: 1.3,
          inactiveColor: isLightTheme ? 'rgba(0, 0, 0, 0.4)' : 'rgba(255, 255, 255, 0.4)',
          inactiveFilter: 'none',
          fillExtension: 0,
          baseTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.28)' : '0 2px 9px rgba(0,0,0,0.28)',
          activeTextShadow: isLightTheme ? '0 3px 12px rgba(255,255,255,0.4)' : '0 0 22px rgba(255,255,255,0.42), 0 3px 12px rgba(0,0,0,0.4)',
          completedTextShadow: isLightTheme ? '0 2px 9px rgba(255,255,255,0.3)' : '0 0 6px rgba(255,255,255,0.1), 0 2px 9px rgba(0,0,0,0.3)',
        }
    }
  }

  // 解析日语注音文本（振假名）
  const parseRubyText = (text: string): Array<{ base: string; ruby?: string }> => {
    const parts: Array<{ base: string; ruby?: string }> = []
    // 匹配模式：一个或多个汉字后跟（平假名/片假名）
    // 使用更严格的匹配：汉字后紧跟括号内的假名，支持全角和半角括号
    const rubyPattern = /([\u4e00-\u9fff]+)\s*[（]([\u3040-\u309f\u30a0-\u30ff]+)[）]/g
    
    let lastIndex = 0
    let match: RegExpExecArray | null
    
    while ((match = rubyPattern.exec(text)) !== null) {
      // Add plain text before the ruby annotation.
      if (match.index > lastIndex) {
        parts.push({ base: text.slice(lastIndex, match.index) })
      }
      
      // 添加带注音的汉字
      parts.push({
        base: match[1], // 汉字
        ruby: match[2]  // 鍋囧悕娉ㄩ煶
      })
      
      lastIndex = rubyPattern.lastIndex
    }
    
    // Add remaining plain text.
    
    if (lastIndex < text.length) {
      parts.push({ base: text.slice(lastIndex) })
    }
    
    return parts.length > 0 ? parts : [{ base: text }]
  }

  // 渲染带注音的文字
  const renderTextWithRuby = (text: string) => {
    const parts = parseRubyText(text)
    
    return parts.map((part, index) => {
      if (part.ruby) {
        // 使用 ruby 标签显示注音，CSS 会用 column-reverse 反转
        // 所以这里 base 写在前面，rt 写在后面，渲染后 rt 会在上方
        return (
          <ruby key={index}>
            {part.base}
            <rt>{part.ruby}</rt>
          </ruby>
        )
      }
      return <span key={index}>{part.base}</span>
    })
  }
  
  // 从文本中移除注音括号，只保留汉字
  const removeRubyAnnotations = (text: string): string => {
    // 只移除汉字后面的假名注音括号，不移除普通括号；匹配模式：一个或多个汉字后跟括号内的假名
    return text.replace(/([\u4e00-\u9fff]+)\s*[（]([\u3040-\u309f\u30a0-\u30ff]+)[）]/g, '$1')
  }
  // 优化的逐字渲染
  const renderLyricLine = (
    preparedLyric: PreparedLyricLine,
    isCurrent: boolean,
    lineIndex: number,
    minimalWordEffect = false,
    playbackTime = currentTime
  ) => {
    const { lyric, wordsWithIndex, sustainProfiles } = preparedLyric
    if (effectiveWordByWordEnabled && isCurrent && lyric.words && lyric.words.length > 0) {
      // 计算相对于行开始的当前时间（毫秒）
      const lineStartTime = lyric.time * 1000
      const absoluteCurrentMs = (playbackTime + lyricOffset) * 1000
      
      // ✨ 修复：逐字高亮延迟200ms，让高亮更准确地跟随演唱
      const WORD_BY_WORD_DELAY_MS = 200
      const currentMs = Math.max(0, absoluteCurrentMs - lineStartTime - WORD_BY_WORD_DELAY_MS)
      
      const effectConfig = getWordEffectConfig(effectiveWordByWordEffectMode)
      // 对唱行：未唱底色带演唱者色相（主唱保持默认灰，其余演唱者取调色板色）
      const lineInactiveColor = appleDuetColorsEnabled && appleAgentCount >= 2 && lyric.agent
        ? (() => {
            const tint = getAgentTintColor(lyric.agent, appleAgentCount, !isLightTheme)
            return tint ? hexToRgba(tint, 0.5) : effectConfig.inactiveColor
          })()
        : effectConfig.inactiveColor
      const getFillOverlayStyle = (fillWidth: number) => {
        if (!effectConfig.isSoft) {
          return {
            width: `${fillWidth}%`,
          }
        }

        const extendedWidth = Math.min(100, fillWidth + effectConfig.fillExtension)
        const fillEdge = extendedWidth > 0 ? fillWidth / extendedWidth * 100 : 0
        const featherStart = Math.max(0, fillEdge - 18)
        const featherShoulder = Math.max(featherStart, fillEdge - 6)
        const featherTail = fillEdge + (100 - fillEdge) * 0.54
        const fillMask = `linear-gradient(90deg,
          black 0%,
          black ${featherStart}%,
          rgba(0,0,0,0.94) ${featherShoulder}%,
          rgba(0,0,0,0.76) ${fillEdge}%,
          rgba(0,0,0,0.28) ${featherTail}%,
          transparent 100%)`
        return {
          width: `${extendedWidth}%`,
          WebkitMaskImage: fillMask,
          maskImage: fillMask,
        }
      }
      
      // Repair missing boundary parentheses in QQ YRC data.
      
      
      const renderSequencedCharacters = () => (
        wordsWithIndex.map(({ word, originalIndex }) => {
          // ✨ 安全检查：确保 word.word 存在
          if (!word.word) {
            return null
          }
          
          const originalWordText = word.word
          
          const wordText = removeRubyAnnotations(originalWordText) // 移除注音括号，只保留汉字
          const parsedParts = parseRubyText(originalWordText) // 解析注音结构
          const hasRuby = parsedParts.some(part => part.ruby) // 检查是否有注音
          const isSpace = wordText.trim() === ''

          if (isSpace) {
            return (
              <span
                key={`space-${lineIndex}-${originalIndex}`}
                aria-hidden="true"
                className="inline-block shrink-0"
                style={{ width: `${Math.max(1, Array.from(wordText).length) * 0.24}em` }}
              />
            )
          }

          const safeDuration = Math.max(word.duration, 1)
          const startTime = word.startTime
          const endTime = startTime + safeDuration
          const sustainGlowIntensity = effectiveLyricGlow
            ? getSustainGlowIntensity(sustainProfiles.get(originalIndex), currentMs)
            : 0
          const isSustainGlowActive = sustainGlowIntensity > 0.015
          const sustainTextShadow = isSustainGlowActive
            ? getSustainTextShadow(sustainGlowColor.rgb, sustainGlowIntensity)
            : ''
          
          // ✨ 修复：检测是否是英文单词（连续的拉丁字母）；英文单词也需要拆分成字母进行逐字高亮
          const isEnglishWord = /^[a-zA-Z]+$/.test(wordText)
          
          // Split annotated text by ruby units, otherwise by visible characters.
          // Apple 模式：纯中文词逐字推进，英文/其他词整词推进。
          const renderUnits: Array<{ base: string; ruby?: string }> = hasRuby
            ? parsedParts
            : effectConfig.isApple
            ? /^[\u4e00-\u9fff]+$/.test(wordText)
              ? Array.from(wordText).map(char => ({ base: char }))
              : [{ base: wordText }]
            : effectConfig.isSoft
            ? [{ base: wordText }]
            : Array.from(wordText).map(char => ({ base: char }))
          const charCount = renderUnits.reduce((sum, unit) => sum + unit.base.length, 0)
          const softLiftRaw = effectConfig.isSoft
            ? clamp((currentMs - (startTime - 180)) / 520)
            : 0
          const softLiftProgress = 1 - Math.pow(1 - softLiftRaw, 3)
          const softLiftStyle = effectConfig.isSoft
            ? {
                transform: `translateY(${(effectConfig.isApple ? -0.045 : -0.075) * softLiftProgress}em)`,
                transformOrigin: 'center bottom',
                willChange: 'transform' as const,
              }
            : undefined
          
          // Split timing across multi-character words.
          
          const shouldSplitTime = wordText.length > 1
          const charDuration = shouldSplitTime ? safeDuration / charCount : safeDuration

          // ── Apple 模式独立渲染：词/字整体渐亮（未唱灰 → 正在唱 ease-out 渐亮 → 已唱纯白）。
          // ── Apple 模式独立渲染：词内从左到右填充推进（对齐逆向“整行高亮重绘”）。
          // 未唱词 → 灰；当前词 → 灰底 + 白色填充从左到右推进；已唱词 → 纯白（填充层常驻，无切换灰闪）。
          if (effectConfig.isApple) {
            let unitCharIndex = 0
            const unitCount = Math.max(1, renderUnits.reduce((sum, unit) => sum + unit.base.length, 0))
            const unitDuration = safeDuration / unitCount
            const wordShadow = isSustainGlowActive
              ? sustainTextShadow
              : effectConfig.baseTextShadow
            return (
              <span
                key={`word-${lineIndex}-${originalIndex}`}
                className="inline-flex"
                style={{ marginRight: 0, ...softLiftStyle }}
              >
                {renderUnits.map((unit, unitIndex) => {
                  const unitChars = Array.from(unit.base)
                  const unitStart = startTime + unitCharIndex * unitDuration
                  unitCharIndex += unitChars.length
                  const unitEnd = unitStart + unitChars.length * unitDuration
                  const unitFullyFilled = currentMs >= unitEnd
                  const unitActive = !minimalWordEffect && currentMs >= unitStart && currentMs < unitEnd
                  const fillProgress = unitActive
                    ? clamp((currentMs - unitStart) / Math.max(1, unitEnd - unitStart))
                    : unitFullyFilled ? 1 : 0
                  const fillWidth = fillProgress * 100
                  const shouldShowFill = fillWidth > 0
                  const unitShadow = unitActive && effectiveLyricGlow
                    ? effectConfig.activeTextShadow
                    : unitFullyFilled
                    ? effectConfig.completedTextShadow
                    : wordShadow
                  return (
                    <span
                      key={`${unitIndex}-${unit.base}`}
                      className="inline-block relative py-[0.02em]"
                      style={{
                        color: unitFullyFilled ? 'transparent' : lineInactiveColor,
                        textShadow: unitShadow,
                        filter: isSustainGlowActive
                          ? `brightness(${1.03 + sustainGlowIntensity * 0.09}) saturate(${1.04 + sustainGlowIntensity * 0.14})`
                          : undefined,
                      }}
                    >
                      <span className="relative z-0">
                        {unit.ruby ? (
                          <ruby>
                            {unit.base}
                            <rt>{unit.ruby}</rt>
                          </ruby>
                        ) : (
                          unit.base
                        )}
                      </span>
                      {shouldShowFill && (
                        <span
                          aria-hidden="true"
                          className="absolute left-0 top-0 z-10 overflow-hidden whitespace-nowrap pointer-events-none"
                          style={{
                            width: `${fillWidth}%`,
                            color: activeLyricColor,
                            textShadow: 'none',
                            top: '50%',
                            transform: 'translateY(-50%)',
                          }}
                        >
                          {unit.ruby ? (
                            <ruby>
                              {unit.base}
                              <rt>{unit.ruby}</rt>
                            </ruby>
                          ) : (
                            unit.base
                          )}
                        </span>
                      )}
                    </span>
                  )
                })}
              </span>
            )
          }
          
          // Preserve the original animation for a single character
          if (charCount === 1) {
            const entryDuration = Math.min(240, Math.max(130, safeDuration * 0.34))
            const releaseDuration = Math.min(420, Math.max(220, safeDuration * 0.5))
            const entryProgress = clamp((currentMs - (startTime - entryDuration)) / entryDuration)
            const releaseProgress = clamp((currentMs - endTime) / releaseDuration)
            const activeProgress = isSpace ? 0 : Math.sin(clamp(entryProgress * (1 - releaseProgress)) * Math.PI / 2)
            const fillProgress = isSpace ? 0 : clamp((currentMs - startTime) / safeDuration)
            const fillWidth = fillProgress * 100
            const fullyFilled = currentMs >= endTime
            // 光晕效果只在单词的时间范围内显示
            const isInTimeRange = currentMs >= startTime && currentMs < endTime
            const isActiveCharacter = !minimalWordEffect && activeProgress > 0.015 && isInTimeRange
            const isRecentlyCompleted = fullyFilled && releaseProgress < 1
            // 填充效果：正在播放时显示进度，播放完成后显示100%
            const shouldShowFill = !isSpace && fillWidth > 0 && (isInTimeRange || fullyFilled)
            const displayFillWidth = fullyFilled ? 100 : fillWidth

            return (
              <span
                key={`word-${lineIndex}-${originalIndex}`}
                className={`lyric-word-effect inline-block relative py-[0.02em] ${isSustainGlowActive ? 'lyric-word-sustain-glow' : ''}`}
                data-sustain-glow={isSustainGlowActive ? 'true' : undefined}
                style={{
                  ['--word-progress' as string]: `${fillWidth}%`,
                  ['--word-accent' as string]: sustainGlowColor.css,
                  color: isSpace || fullyFilled ? 'transparent' : lineInactiveColor,
                  opacity: isSpace ? 0 : 1,
                  textShadow: isSustainGlowActive
                    ? sustainTextShadow
                    : isActiveCharacter && effectiveLyricGlow
                    ? effectConfig.activeTextShadow
                    : fullyFilled
                    // 唱完后白色填充层常驻显示，基础层不再需要阴影，
                    // 否则阴影从填充层边缘露出会让字显得“厚”。
                    ? 'none'
                    : effectConfig.baseTextShadow,
                  marginRight: isSpace ? '0.24em' : 0,
                  minWidth: 0,
                  filter: isSustainGlowActive
                    ? `brightness(${1.03 + sustainGlowIntensity * 0.09}) saturate(${1.04 + sustainGlowIntensity * 0.14})`
                    : fullyFilled ? 'none' : effectConfig.inactiveFilter,
                  // 词唱完瞬间辉光平滑衰减，不突变发暗（避免 30fps 流畅动画下“闪一下”）。
                  transition: 'text-shadow 180ms ease-out, filter 180ms ease-out',
                  ...softLiftStyle,
                }}
              >
                 <span className="relative z-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                   {hasRuby ? parsedParts.map((part, idx) => 
                     part.ruby ? (
                       <ruby key={idx}>
                         {part.base}
                         <rt>{part.ruby}</rt>
                       </ruby>
                     ) : (
                       <span key={idx}>{part.base}</span>
                     )
                   ) : wordText}
                  </span>
                  {shouldShowFill && displayFillWidth > 0 && (
                    <span
                     aria-hidden="true"
                     className="absolute left-0 top-0 z-10 overflow-hidden whitespace-nowrap pointer-events-none"
                     style={{
                       ...getFillOverlayStyle(displayFillWidth),
                       // 唱完后填充层保留为完整白色（不再卸载切换），
                       // 避免“填充层消失→基础层变色”瞬间露出灰色基底（敲下去+灰闪）。
                       ...(fullyFilled ? { WebkitMaskImage: 'none', maskImage: 'none' } : {}),
                       // 垂直居中对齐基础层文字（absolute top-0 会让 overlay 从顶部开始，
                       // 与行内居中的基础层文字错位 → 叠印像两个字、切换时“砸一下”）。
                       top: '50%',
                       transform: 'translateY(-50%)',
                       color: activeLyricColor,
                       textShadow: 'none',
                       transition: 'none',
                     }}
                   >
                     {hasRuby ? parsedParts.map((part, idx) => 
                       part.ruby ? (
                         <ruby key={idx}>
                           {part.base}
                           <rt>{part.ruby}</rt>
                         </ruby>
                       ) : (
                         <span key={idx}>{part.base}</span>
                       )
                     ) : wordText}
                   </span>
                 )}
              </span>
            )
          }
          
          // Render multi-character lyrics with per-character animation
          return (
             <span
              key={`word-${lineIndex}-${originalIndex}`}
              className="inline-flex"
              style={{ marginRight: 0, ...softLiftStyle }}
            >
              {(() => {
                let currentCharIndex = 0
                return renderUnits.map((unit, unitIndex) => {
                  const unitChars = Array.from(unit.base)
                  const unitCharCount = unitChars.length
                  const unitStartCharIndex = currentCharIndex
                  currentCharIndex += unitCharCount
                  
                  // Calculate the timing range for the complete unit.
                  
                  const unitStartTime = startTime + unitStartCharIndex * charDuration
                  const unitEndTime = startTime + currentCharIndex * charDuration
                  const unitDuration = unitEndTime - unitStartTime
                  
                  const entryDuration = Math.min(240, Math.max(130, unitDuration * 0.34))
                  const releaseDuration = Math.min(420, Math.max(220, unitDuration * 0.5))
                  const entryProgress = clamp((currentMs - (unitStartTime - entryDuration)) / entryDuration)
                  const releaseProgress = clamp((currentMs - unitEndTime) / releaseDuration)
                  const activeProgress = Math.sin(clamp(entryProgress * (1 - releaseProgress)) * Math.PI / 2)
                  const fillProgress = clamp((currentMs - unitStartTime) / unitDuration)
                  const fillWidth = fillProgress * 100
                  const fullyFilled = currentMs >= unitEndTime
                  // 光晕效果只在字符的时间范围内显示
                  const isInTimeRange = currentMs >= unitStartTime && currentMs < unitEndTime
                  const isActiveCharacter = !minimalWordEffect && activeProgress > 0.015 && isInTimeRange
                  const isRecentlyCompleted = fullyFilled && releaseProgress < 1
                  // 填充效果：正在播放时显示进度，播放完成后显示100%
                  const shouldShowFill = fillWidth > 0 && (isInTimeRange || fullyFilled)
                  const displayFillWidth = fullyFilled ? 100 : fillWidth

                   return (
                    <span
                      key={`unit-${lineIndex}-${originalIndex}-${unitIndex}`}
                      className={`lyric-word-effect inline-block relative py-[0.02em] ${isSustainGlowActive ? 'lyric-word-sustain-glow' : ''}`}
                      data-sustain-glow={isSustainGlowActive ? 'true' : undefined}
                      style={{
                        ['--word-progress' as string]: `${fillWidth}%`,
                        ['--word-accent' as string]: sustainGlowColor.css,
                        color: fullyFilled ? 'transparent' : lineInactiveColor,
                        opacity: 1,
                        textShadow: isSustainGlowActive
                          ? sustainTextShadow
                          : isActiveCharacter && effectiveLyricGlow
                          ? effectConfig.activeTextShadow
                          : fullyFilled
                          // 唱完后白色填充层常驻显示，基础层不再需要阴影，
                          // 否则阴影从填充层边缘露出会让字显得“厚”。
                          ? 'none'
                          : effectConfig.baseTextShadow,
                        paddingLeft: effectConfig.wordPaddingX,
                        paddingRight: effectConfig.wordPaddingX,
                        minWidth: 0,
                        filter: isSustainGlowActive
                          ? `brightness(${1.03 + sustainGlowIntensity * 0.09}) saturate(${1.04 + sustainGlowIntensity * 0.14})`
                          : fullyFilled ? 'none' : effectConfig.inactiveFilter,
                        // 词唱完瞬间辉光平滑衰减，不突变发暗（避免 30fps 流畅动画下“闪一下”）。
                        transition: 'text-shadow 180ms ease-out, filter 180ms ease-out',
                      }}
                    >
                      <span className="relative z-0">
                        {unit.ruby ? (
                          <ruby>
                            {unit.base}
                            <rt>{unit.ruby}</rt>
                          </ruby>
                        ) : (
                          unit.base
                        )}
                       </span>
                       {shouldShowFill && displayFillWidth > 0 && (
                         <span
                          aria-hidden="true"
                          className="absolute left-0 top-0 z-10 overflow-hidden whitespace-nowrap pointer-events-none"
                          style={{
                            ...getFillOverlayStyle(displayFillWidth),
                            // 唱完后填充层保留为完整白色（不再卸载切换），
                            // 避免“填充层消失→基础层变色”瞬间露出灰色基底（敲下去+灰闪）。
                            ...(fullyFilled ? { WebkitMaskImage: 'none', maskImage: 'none' } : {}),
                            // 垂直居中对齐基础层文字（absolute top-0 会让 overlay 从顶部开始，
                            // 与行内居中的基础层文字错位 → 叠印像两个字、切换时“砸一下”）。
                            top: '50%',
                            transform: 'translateY(-50%)',
                            color: activeLyricColor,
                            textShadow: 'none',
                            transition: 'none',
                          }}
                        >
                          {unit.ruby ? (
                            <ruby>
                              {unit.base}
                              <rt>{unit.ruby}</rt>
                            </ruby>
                          ) : (
                            unit.base
                          )}
                        </span>
                      )}
                    </span>
                  )
                })
              })()}
            </span>
          )
        })
      )
      
      return (
        <span
          className={`relative inline-flex w-full min-w-0 flex-wrap whitespace-normal break-words [overflow-wrap:anywhere] ${scrollAlignment === 'center' ? 'justify-center text-center' : ''}`}
          style={{
            columnGap: 0,
            rowGap: effectConfig.wordRowGap,
            paddingLeft: effectConfig.linePaddingX,
            paddingRight: effectConfig.linePaddingX,
            lineHeight: effectConfig.wordLineHeight,
          }}
        >
          {renderSequencedCharacters()}
        </span>
      )
    }
    
    if (lyric.isGeneratedInterlude && isCurrent) {
      const startTime = lyric.interludeStartTime ?? lyric.time
      const endTime = lyric.interludeEndTime ?? startTime + INTERLUDE_MIN_GAP_SECONDS
      const interludeProgress = clamp(
        (playbackTime + lyricOffset - startTime) / Math.max(0.1, endTime - startTime)
      )

      // 前奏间奏（isIntroInterlude）：音澜工坊风格的波形进度条——一排随正弦包络起伏的
      // 音柱（像音频可视化），进度从左到右点亮（主色+辉光），前沿一根音柱呼吸脉动。
      if (lyric.isIntroInterlude) {
        const WAVE_BARS = 26
        return (
          <span
            className="inline-flex items-center justify-center py-[0.12em] leading-none"
            style={{ gap: '0.22em', height: '1.05em', fontSize: '0.72em' }}
            aria-label="间奏"
          >
            {Array.from({ length: WAVE_BARS }).map((_, index) => {
              const t = index / (WAVE_BARS - 1)
              // 正弦包络 + 轻微错相抖动 → 波浪形音柱（不是单调柱子）
              const envelope = Math.abs(Math.sin(t * Math.PI * 2.4 + 0.35)) * 0.8 + 0.2
              const jitter = 0.85 + 0.28 * Math.sin(index * 1.9 + 0.7)
              const heightPct = Math.max(0.2, Math.min(1, envelope * jitter))
              const filled = interludeProgress >= t
              const isFrontier = interludeProgress > t - 0.07 && interludeProgress < t + 0.07
              return (
                <motion.span
                  key={index}
                  className="rounded-full"
                  style={{
                    width: '0.2em',
                    height: `${(heightPct * 1.0).toFixed(3)}em`,
                    backgroundColor: filled ? activeLyricColor : inactiveLyricColor,
                    opacity: filled ? 1 : 0.5,
                    boxShadow: filled ? `0 0 0.28em ${accentColor}88` : 'none',
                  }}
                  animate={isFrontier ? { scaleY: [1, 1.5, 1] } : { scaleY: 1 }}
                  transition={isFrontier ? { duration: 0.55, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
                />
              )
            })}
          </span>
        )
      }

      // 歌曲中间的间奏：保持原来的三个点（随进度逐个点亮）
      return (
        <motion.span
          className="inline-flex items-center justify-center py-[0.12em] leading-none"
          style={{ gap: '0.34em', fontSize: '0.68em' }}
          aria-label="间奏"
          animate={{ scale: [1, 1.045, 1] }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
        >
          {[0, 1, 2].map((index) => {
            const dotProgress = clamp(interludeProgress * 3 - index)
            const edge = dotProgress * 100
            const featherStart = Math.max(0, edge - 28)
            const featherEnd = Math.min(100, edge + 38)
            const dotMask = `linear-gradient(90deg, black 0%, black ${featherStart}%, rgba(0,0,0,0.78) ${edge}%, transparent ${featherEnd}%)`

            return (
              <span
                key={index}
                className="relative inline-block rounded-full"
                style={{ width: '0.84em', height: '0.84em', backgroundColor: inactiveLyricColor, opacity: 0.6 }}
              >
                {dotProgress > 0 && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full"
                    style={{
                      backgroundColor: activeLyricColor,
                      WebkitMaskImage: dotProgress >= 1 ? 'none' : dotMask,
                      maskImage: dotProgress >= 1 ? 'none' : dotMask,
                      filter: `drop-shadow(0 0 0.22em ${accentColor}99) blur(0.015em)`,
                    }}
                  />
                )}
              </span>
            )
          })}
        </motion.span>
      )
    }

    if (lyric.isGeneratedInterlude) return null
    // Non-word-timed mode still renders ruby annotations.
    return <>{renderTextWithRuby(lyric.text)}</>
  }

  // 根据动画模式获取过渡配置
  const getTransitionConfig = () => {
    switch (effectiveAnimationMode) {
      case 'elegant':
        // 优雅：正在播放→已播是渐隐，未播→正在播是逐渐显现
        return {
          layout: { duration: 0.95, ease: [0.25, 0.1, 0.25, 1] as const },
          opacity: { duration: 0.82, ease: [0.25, 0.1, 0.25, 1] as const },
          y: { duration: 0.9, ease: [0.25, 0.1, 0.25, 1] as const },
          scale: { duration: 0.86, ease: [0.25, 0.1, 0.25, 1] as const },
          fontSize: { duration: 0.95, ease: [0.25, 0.1, 0.25, 1] as const },
          fontWeight: { duration: 0.62, ease: [0.25, 0.1, 0.25, 1] as const },
        }
      case 'normal':
        // Normal transition preset
        return {
          layout: { duration: 0.62, ease: [0.25, 0.1, 0.25, 1] as const },
          opacity: { duration: 0.56, ease: [0.25, 0.1, 0.25, 1] as const },
          y: { duration: 0.6, ease: [0.25, 0.1, 0.25, 1] as const },
          scale: { duration: 0.56, ease: [0.25, 0.1, 0.25, 1] as const },
          fontSize: { duration: 0.62, ease: [0.25, 0.1, 0.25, 1] as const },
          fontWeight: { duration: 0.42, ease: [0.25, 0.1, 0.25, 1] as const },
        }
      case 'dynamic':
        // 灵动：更有活力的过渡效果
        return {
          layout: { duration: 0.58, ease: [0.2, 0.8, 0.2, 1] as const },
          opacity: { duration: 0.48, ease: [0.2, 0.8, 0.2, 1] as const },
          y: { duration: 0.56, ease: [0.2, 0.8, 0.2, 1] as const },
          scale: { duration: 0.52, ease: [0.2, 0.8, 0.2, 1] as const },
          fontSize: { duration: 0.58, ease: [0.2, 0.8, 0.2, 1] as const },
          fontWeight: { duration: 0.34, ease: [0.2, 0.8, 0.2, 1] as const },
        }
    }
  }

  // Build the transition config from the selected preset
  const transitionConfig = getTransitionConfig()

  if (displayMode === 'single') {
    const activeImmersiveEffect = immersiveEffect || storedImmersiveEffect
    const immersiveEffectConfig = {
      'soft-focus': {
        initial: { opacity: 0, x: 0, y: 10, scale: 0.9, filter: 'blur(28px) brightness(0.72)' },
        animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px) brightness(1)' },
        exit: { opacity: 0, x: 0, y: -8, scale: 1.05, filter: 'blur(24px) brightness(0.78)' },
        transition: { duration: 0.72, ease: [0.16, 1, 0.3, 1] as const },
        ambient: { y: [0, -3, 0], scale: [1, 1.014, 1], filter: ['brightness(1)', 'brightness(1.1)', 'brightness(1)'] },
        ambientTransition: { duration: 4.8, repeat: Infinity, ease: 'easeInOut' as const },
        textShadow: `0 0 38px ${accentColor}a8, 0 0 82px ${accentColor}58, 0 10px 36px rgba(0,0,0,0.76)`,
        letterSpacing: '0',
        fontScale: 1,
        textAlign: 'center' as const,
        widthScale: 1,
        showSweep: false,
      },
      float: {
        initial: { opacity: 0, x: 0, y: 64, scale: 0.9, filter: 'blur(8px) brightness(0.82)' },
        animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px) brightness(1)' },
        exit: { opacity: 0, x: 0, y: -48, scale: 1.04, filter: 'blur(7px) brightness(0.86)' },
        transition: { duration: 0.46, ease: [0.16, 1, 0.3, 1] as const },
        ambient: { y: [0, -12, 0], rotateZ: [0, -0.35, 0.25, 0], scale: [1, 1.012, 1] },
        ambientTransition: { duration: 4.9, repeat: Infinity, ease: 'easeInOut' as const },
        textShadow: `0 16px 42px rgba(0,0,0,0.7), 0 0 24px ${accentColor}50`,
        letterSpacing: '0',
        fontScale: 1,
        textAlign: 'center' as const,
        widthScale: 1,
        showSweep: false,
      },
      breathe: {
        initial: { opacity: 0, x: 0, y: 0, scale: 0.72, filter: 'blur(14px) brightness(0.62)' },
        animate: { opacity: 1, y: 0, scale: 1, filter: 'blur(0px) brightness(1)' },
        exit: { opacity: 0, x: 0, y: 0, scale: 1.18, filter: 'blur(16px) brightness(1.28)' },
        transition: { duration: 0.5, ease: [0.34, 1.56, 0.64, 1] as const },
        ambient: { scale: [0.98, 1.055, 0.98], filter: ['brightness(0.96)', 'brightness(1.24)', 'brightness(0.96)'] },
        ambientTransition: { duration: 2.45, repeat: Infinity, ease: 'easeInOut' as const },
        textShadow: `0 0 28px rgba(255,255,255,0.5), 0 0 70px ${accentColor}88, 0 8px 30px rgba(0,0,0,0.72)`,
        letterSpacing: '0',
        fontScale: 1,
        textAlign: 'center' as const,
        widthScale: 1,
        showSweep: false,
      },
      cinematic: {
        initial: { opacity: 0, x: -96, y: 0, scale: 1.08, filter: 'blur(4px) brightness(0.72)', clipPath: 'inset(0 100% 0 0 round 0.5rem)' },
        animate: { opacity: 1, x: 0, y: 0, scale: 1, filter: 'blur(0px) brightness(1)', clipPath: 'inset(0 0% 0 0 round 0.5rem)' },
        exit: { opacity: 0, x: 104, y: 0, scale: 0.96, filter: 'blur(5px) brightness(0.76)', clipPath: 'inset(0 0 0 100% round 0.5rem)' },
        transition: { duration: 0.64, ease: [0.22, 1, 0.36, 1] as const },
        ambient: { scale: [1, 1.045], x: [0, 18] },
        ambientTransition: { duration: 8.5, repeat: Infinity, repeatType: 'mirror' as const, ease: 'linear' as const },
        textShadow: `0 12px 34px rgba(0,0,0,0.86), 0 0 28px ${accentColor}35`,
        letterSpacing: '0.055em',
        fontScale: 0.9,
        textAlign: 'left' as const,
        widthScale: 1.14,
        showSweep: true,
      },
      minimal: {
        initial: { opacity: 0, x: 0, y: 0, scale: 1, filter: 'none' },
        animate: { opacity: 1, x: 0, y: 0, scale: 1, filter: 'none' },
        exit: { opacity: 0, x: 0, y: 0, scale: 1, filter: 'none' },
        transition: { duration: 0.18, ease: 'linear' as const },
        ambient: { y: 0, scale: 1, filter: 'brightness(1)' },
        ambientTransition: { duration: 0 },
        textShadow: '0 2px 10px rgba(0,0,0,0.58)',
        letterSpacing: '0',
        fontScale: 0.72,
        textAlign: 'center' as const,
        widthScale: 0.78,
        showSweep: false,
      },
    }[activeImmersiveEffect]
    let singleIndex = currentIndex
    const activeSingleLine = displayLyricsData[singleIndex]
    if (singleIndex < 0 || (!activeSingleLine?.text?.trim() && !activeSingleLine?.isGeneratedInterlude)) {
      const fallbackIndex = displayLyricsData.findIndex(lyric => lyric.text?.trim() || lyric.isGeneratedInterlude)
      singleIndex = fallbackIndex >= 0 ? fallbackIndex : currentIndex
    }
    const singleLyric = singleIndex >= 0 ? displayLyricsData[singleIndex] : null
    const singleLyricFontSize = singlePlacementMode === 'centered'
      ? Math.max(2.15, effectiveLyricSize * 1.3)
      : Math.max(3.2, effectiveLyricSize * 1.65)
    const singleLyricColumns = estimateTextColumns(singleLyric?.text || '')
    const singleLyricLongestToken = getLongestTokenLength(singleLyric?.text || '')
    const isLongImmersiveLine = singleLyricColumns > 32 || singleLyricLongestToken > 20
    const isMediumImmersiveLine = singleLyricColumns > 20 || singleLyricLongestToken > 13
    const placementSeed = Array.from(displayLyricsData[0]?.text || '').reduce(
      (hash, char) => ((hash * 31) + (char.codePointAt(0) || 0)) >>> 0,
      7
    )
    const compactPlacements = immersiveAvoidTopLeft
      ? [
          { left: 68, top: 25, width: 48 },
          { left: 34, top: 64, width: 52 },
          { left: 70, top: 48, width: 46 },
          { left: 50, top: 34, width: 60 },
          { left: 65, top: 65, width: 52 },
          { left: 35, top: 46, width: 48 },
        ]
      : [
          { left: 30, top: 27, width: 46 },
          { left: 70, top: 62, width: 48 },
          { left: 68, top: 34, width: 48 },
          { left: 34, top: 62, width: 50 },
          { left: 51, top: 45, width: 60 },
          { left: 30, top: 45, width: 46 },
        ]
    const mediumPlacements = [
      { left: 65, top: 31, width: 60 },
      { left: 39, top: 62, width: 64 },
      { left: 61, top: 52, width: 62 },
      { left: 48, top: 38, width: 68 },
    ]
    const longPlacements = [
      { left: 55, top: 39, width: 80 },
      { left: 50, top: 61, width: 84 },
      { left: 62, top: 49, width: 72 },
    ]
    const immersivePlacements = isLongImmersiveLine
      ? longPlacements
      : isMediumImmersiveLine
      ? mediumPlacements
      : compactPlacements
    const baseImmersivePlacement = immersivePlacements[
      Math.abs(singleIndex + placementSeed) % immersivePlacements.length
    ]
    const dynamicImmersivePlacement = activeImmersiveEffect === 'cinematic'
      ? {
          left: baseImmersivePlacement.left < 50 ? 42 : 59,
          top: baseImmersivePlacement.top,
          width: Math.max(66, baseImmersivePlacement.width),
        }
      : activeImmersiveEffect === 'minimal'
      ? {
          left: baseImmersivePlacement.left,
          top: Math.min(62, Math.max(34, baseImmersivePlacement.top)),
          width: baseImmersivePlacement.width,
        }
      : baseImmersivePlacement
    const immersivePlacement = singlePlacementMode === 'centered'
      ? {
          left: 50,
          top: 50,
          width: isLongImmersiveLine ? 88 : isMediumImmersiveLine ? 82 : 76,
        }
      : dynamicImmersivePlacement

    return (
      <div className={`relative h-full w-full overflow-hidden text-center ${isDesktopLayout ? 'min-h-[280px]' : 'min-h-[360px]'}`}>
        <AnimatePresence mode="sync" initial={false}>
          {singleLyric && (
            <motion.div
              key={`single-${singleIndex}-${singleLyric.time}-${singleLyric.text}`}
              data-index={singleIndex}
              initial={immersiveEffectConfig.initial}
              animate={immersiveEffectConfig.animate}
              exit={immersiveEffectConfig.exit}
              transition={immersiveEffectConfig.transition}
              onClick={() => handleLyricClick(singleLyric.interludeStartTime ?? singleLyric.time, singleIndex)}
              className="absolute max-h-full cursor-pointer px-5 sm:px-8"
              style={{
                left: `${immersivePlacement.left}%`,
                top: `${immersivePlacement.top}%`,
                width: `${Math.min(88, immersivePlacement.width * immersiveEffectConfig.widthScale)}%`,
                maxWidth: '68rem',
                translate: '-50% -50%',
                transformOrigin: 'center bottom',
                textAlign: immersiveEffectConfig.textAlign,
              }}
            >
              <motion.div
                animate={immersiveEffectConfig.ambient}
                transition={immersiveEffectConfig.ambientTransition}
                className="relative overflow-visible"
                style={{
                  transformOrigin: activeImmersiveEffect === 'cinematic' ? 'left center' : 'center center',
                }}
              >
                {immersiveEffectConfig.showSweep && (
                  <motion.span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-[-0.16em] top-[-0.12em] z-20 w-[16%]"
                    initial={{ left: '-24%', opacity: 0 }}
                    animate={{ left: ['-24%', '112%'], opacity: [0, 0.5, 0] }}
                    transition={{ duration: 2.8, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
                    style={{
                      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
                      filter: 'blur(12px)',
                      transform: 'skewX(-12deg)',
                    }}
                  />
                )}
                <motion.p
                  className={`font-bold leading-tight whitespace-normal break-words [overflow-wrap:anywhere] ${isLightTheme ? 'text-black/90' : 'text-white drop-shadow-[0_8px_34px_rgba(0,0,0,0.72)]'}`}
                  animate={{
                    fontSize: `clamp(1.9rem, ${singleLyricFontSize * immersiveEffectConfig.fontScale}rem, min(11vw, 18vh))`,
                  }}
                  transition={{ fontSize: transitionConfig.fontSize }}
                  style={{
                    textShadow: effectiveLyricGlow || activeImmersiveEffect !== 'minimal'
                      ? immersiveEffectConfig.textShadow
                      : '0 3px 12px rgba(0,0,0,0.62)',
                    maxWidth: '100%',
                    letterSpacing: immersiveEffectConfig.letterSpacing,
                  }}
                >
                  <SmoothPlaybackTime store={smoothTimeStoreRef.current!}>
                    {playbackTime => renderLyricLine(
                      preparedLyricsData[singleIndex],
                      true,
                      singleIndex,
                      activeImmersiveEffect === 'minimal',
                      playbackTime
                    )}
                  </SmoothPlaybackTime>
                </motion.p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    )
  }

  return (
    <div className={`relative h-full w-full overflow-hidden ${isDesktopLayout ? 'min-h-[320px] max-h-full' : 'min-h-[520px] max-h-[72vh]'}`}>
      <div 
        ref={containerRef}
        data-is-playing={isPlaying}
        className={`w-full h-full relative ${isModernScroll ? 'overflow-hidden' : 'overflow-y-auto'} overflow-x-hidden scrollbar-hide`}
        onWheel={handleWheel}
        onMouseEnter={handleContainerMouseEnter}
        onMouseLeave={handleContainerMouseLeave}
        style={isModernScroll ? undefined : {
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%)',
        }}
      >
      {/* 歌词滚动容器：过渡切歌时前一曲淡出快（0.18s）、后一曲淡入慢（0.5s），避免叠字难看 */}
      <AnimatePresence mode="wait">
        <motion.div
          key={trackId}
          initial={{ opacity: 0 }}
          animate={{
            opacity: isTransitioning ? 0 : 1,
            transition: isTransitioning
              ? { duration: 0.18, ease: 'easeIn' }
              : { duration: 0.5, ease: 'easeOut' },
          }}
          exit={{ opacity: 0, transition: { duration: 0.18, ease: 'easeIn' } }}
          className={`absolute inset-0 flex min-w-0 flex-col justify-start px-8 ${scrollAlignment === 'center' ? 'items-center' : 'items-start'}`}
          style={{
            paddingTop: '0',
            paddingBottom: '0',
          }}
        >
        {/* 崭新模式：弹簧 transform 轨道（替代原生 scroll，零布局跳动） */}
        <motion.div
          ref={springWrapRef}
          style={{ y: springY, willChange: 'transform' }}
          className="w-full"
        >
        <div
          aria-hidden="true"
          className="w-full shrink-0 pointer-events-none"
          style={{ height: isModernScroll ? '0%' : '46%' }}
        />
        {!isTransitioning && preparedLyricsData.map((preparedLyric, index) => {
          const lyric = preparedLyric.lyric
          const globalIndex = index
          const isCurrent = globalIndex === currentIndex
          const isInactiveGeneratedInterlude = Boolean(lyric.isGeneratedInterlude && !isCurrent)
          const isHovered = hoveredIndex === globalIndex
          const lineTiming = getLineTiming(globalIndex)
          
          // Distance from the active lyric line
          const distanceFromCurrent = Math.abs(globalIndex - currentIndex)
          
          const isBlinking = blinkingIndex === globalIndex
          // Keep the active line highlighted in every scroll mode
          let opacityValue = 0.3
          
          if (isCurrent) {
            // The active line remains fully highlighted
            opacityValue = 1.0
          } else if (distanceFromCurrent === 1) {
            // 绱ч偦鐨勪笂涓嬪彞
            opacityValue = 0.7
          } else if (distanceFromCurrent === 2) {
            // Fade lines that are two positions away
            opacityValue = 0.5
          }
          
          // During manual scrolling, keep other lines at least half visible
          if (isManualScrolling && !isCurrent) {
            opacityValue = Math.max(opacityValue, 0.5)
          }

          if (!isCurrent && lineTiming.upcomingProgress > 0) {
            opacityValue = Math.max(opacityValue, 0.46 + lineTiming.upcomingProgress * 0.28)
          }
          
          const lyricKey = `lyric-${globalIndex}-${lyric.time ?? 'notime'}`
          const crowdedCurrentLine = isCurrent && isCrowdedLyricLine(lyric.text, effectiveLyricSize)
          const skiaY = lineTiming.upcomingProgress > 0 ? 5 * (1 - lineTiming.upcomingProgress) : 0
          const timingBlur = backgroundEffect === 'immersive'
            ? 0
            : isCurrent
            ? 0
            : lineTiming.releaseProgress > 0
            ? Math.min(2.5, 0.5 + lineTiming.releaseProgress * 2.0)
            : lineTiming.upcomingProgress > 0
            ? Math.max(0, 1.05 - lineTiming.upcomingProgress * 1.05)
            : 0
          const immersiveDistanceBlur = 0
          const appleLinePhase: AppleLyricLinePhase = isCurrent
            ? 'current'
            : globalIndex < currentIndex ? 'played' : 'upcoming'
          const appleLineMotion = getAppleLyricLineMotion(
            appleLinePhase,
            distanceFromCurrent,
            isManualScrolling,
          )
          const lineFilter = isAppleLineMode
            ? `blur(${appleLineMotion.blur}px)`
            : isModernScroll
              ? (isManualScrolling ? 'none' : `blur(${isCurrent ? 0 : distanceFromCurrent >= 3 ? 3.4 : distanceFromCurrent >= 2 ? 2.2 : 1.1}px)`)
              : `blur(${Math.max(timingBlur, immersiveDistanceBlur)}px)`
          const lineFontSize = isModernScroll || isAppleLineMode
            ? `${effectiveLyricSize}rem`
            : isCurrent ? `${effectiveLyricSize}rem` : `${effectiveLyricSize * 0.63}rem`
          const lineFontWeight = isModernScroll ? 600 : (isAppleLineMode ? 500 : (isCurrent ? 700 : 400))
          const lineOpacity = isAppleLineMode ? appleLineMotion.opacity : opacityValue
          const lineY = isAppleLineMode ? appleLineMotion.y : skiaY
          const lineScale = isAppleLineMode
            ? appleLineMotion.scale
            : isModernScroll ? (isCurrent ? 1 : distanceFromCurrent >= 2 ? 0.74 : 0.80) : undefined
          const appleTransformTransition = prefersReducedMotion || isManualScrolling || isInactiveGeneratedInterlude
            ? { duration: 0 }
            : { type: 'spring' as const, stiffness: 320, damping: 30, mass: 0.8 }
          
          return (
            <motion.div
              ref={isCurrent ? activePulseLineRef : undefined}
              data-index={globalIndex}
              key={lyricKey}
              className={`${scrollAlignment === 'center' ? 'text-center mx-auto' : 'text-left'} w-full ${isDesktopLayout ? 'max-w-[62rem]' : 'max-w-[54rem]'} min-w-0 relative cursor-pointer ${
                isInactiveGeneratedInterlude
                  ? 'h-0 mb-0 overflow-hidden pointer-events-none'
                  : isDesktopLayout ? 'mb-5 pointer-events-auto' : 'mb-7 pointer-events-auto'
              }`}
              onMouseEnter={() => handleLyricMouseEnter(globalIndex)}
              onMouseLeave={handleLyricMouseLeave}
              onClick={() => handleLyricClick(lyric.interludeStartTime ?? lyric.time, globalIndex)}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 18, filter: 'blur(8px)' }}
              animate={{
                opacity: isBlinking ? [lineOpacity, 0.95, lineOpacity] : lineOpacity,
                y: lineY,
                filter: lineFilter,
                ...(lineScale === undefined ? {} : { scale: lineScale }),
              }}
              style={{
                transformOrigin: scrollAlignment === 'center' ? 'center center' : 'left center',
                scale: lineScale === undefined ? (isCurrent ? 'var(--restless-lyric-scale, 1.008)' : 1) : undefined,
                transition: lineScale === undefined ? 'scale 140ms cubic-bezier(0.22, 1, 0.36, 1)' : undefined,
                zIndex: isCurrent ? 2 : lineTiming.upcomingProgress > 0 ? 1 : 0,
              }}
              transition={{
                opacity: isBlinking
                  ? { duration: 2.0, repeat: Infinity, ease: [0.4, 0, 0.6, 1] }
                  : prefersReducedMotion ? { duration: 0 } : isAppleLineMode
                    ? { duration: 0.22, ease: [0.22, 1, 0.36, 1] }
                    : transitionConfig.opacity,
                y: isAppleLineMode ? appleTransformTransition : { duration: prefersReducedMotion ? 0 : 0.04, ease: 'linear' },
                scale: isAppleLineMode
                  ? appleTransformTransition
                  : isModernScroll && !prefersReducedMotion
                    ? { type: 'spring', stiffness: 240, damping: 24, mass: 0.9 }
                    : { duration: 0 },
                filter: { duration: prefersReducedMotion ? 0 : isAppleLineMode ? 0.3 : 0.45, ease: [0.22, 1, 0.36, 1] },
              }}
            >
              {/* 液态玻璃框 */}
              <AnimatePresence>
                {isHovered && showGlassFrame && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                    className="absolute inset-0 -m-4 rounded-2xl pointer-events-none z-0"
                    style={{
                      background: `linear-gradient(135deg, ${accentColor}15, ${accentColor}08)`,
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      border: `1px solid ${accentColor}40`,
                      boxShadow: `
                        0 0 0 1px ${accentColor}20,
                        0 8px 32px ${accentColor}30,
                        inset 0 1px 0 rgba(255, 255, 255, 0.1),
                        inset 0 -1px 0 rgba(0, 0, 0, 0.1)
                      `,
                    }}
                  >
                    {/* 内部高光 */}
                    <div
                      className="absolute inset-0 rounded-2xl opacity-50"
                      style={{
                        background: `radial-gradient(circle at 50% 0%, ${accentColor}30, transparent 70%)`,
                      }}
                    />
                    {/* 流动效果 */}
                    <motion.div
                      className="absolute inset-0 rounded-2xl"
                      animate={{
                        background: [
                          `linear-gradient(45deg, ${accentColor}00, ${accentColor}20, ${accentColor}00)`,
                          `linear-gradient(225deg, ${accentColor}00, ${accentColor}20, ${accentColor}00)`,
                        ],
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        ease: 'linear',
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <div
                className={[
                  'relative z-10 will-change-transform lyric-skia-line',
                  isCurrent ? 'lyric-skia-line-current' : '',
                  crowdedCurrentLine ? 'lyric-skia-line-crowded' : '',
                  lineTiming.upcomingProgress > 0 ? 'lyric-skia-line-upcoming' : '',
                ].filter(Boolean).join(' ')}
                style={{
                  ['--lyric-accent' as string]: accentColor,
                  ['--lyric-line-progress' as string]: lineTiming.progress,
                  ['--lyric-progress-position' as string]: '50%',
                  ['--lyric-glow-shift' as string]: '0px',
                  ['--lyric-glow-scale' as string]: 1,
                  ['--lyric-glow-opacity' as string]: 0,
                  ['--lyric-upcoming-opacity' as string]: lineTiming.upcomingProgress,
                }}
              >
              <motion.p
                ref={(node) => {
                  lyricTextRefs.current[globalIndex] = node
                }}
                className={`${scrollAlignment === 'center' ? 'text-center' : 'text-left'} font-medium leading-relaxed whitespace-normal break-words [overflow-wrap:anywhere] relative z-10 lyric-skia-text`}
                initial={false}
                animate={{
                  scale: isAppleLineMode ? 1 : (isCurrent ? 1.006 : 1),
                  y: isCurrent ? 0 : lineTiming.releaseProgress > 0 ? -3 * lineTiming.releaseProgress : 0,
                }}
                transition={{
                  scale: isBlinking 
                    ? { duration: 0 }
                    : transitionConfig.scale,
                  y: { duration: 0.04, ease: 'linear' },
                }}
                style={{
                  color: isCurrent
                    ? '#ffffff' 
                    : isBlinking
                    ? 'rgba(255, 255, 255, 0.85)'
                    : lineTiming.upcomingProgress > 0
                    ? `rgba(255, 255, 255, ${0.5 + lineTiming.upcomingProgress * 0.22})`
                    : 'rgba(255, 255, 255, 0.5)',
                  textShadow: isBlinking
                    ? `0 0 50px ${accentColor}dd, 0 0 80px ${accentColor}99, 0 0 120px ${accentColor}55, 0 4px 20px rgba(0,0,0,0.7)`
                    : '0 2px 4px rgba(0,0,0,0.3)',
                  filter: isBlinking
                    ? 'brightness(1.15) saturate(1.2)'
                    : isCurrent
                    ? 'brightness(1.08)'
                    : 'none',
                  maxWidth: '100%',
                  fontSize: lineFontSize,
                  fontWeight: lineFontWeight,
                  fontFamily: isAppleLineMode
                    ? "'SF Pro Display', 'PingFang SC', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Arial', sans-serif"
                    : undefined,
                  wordBreak: 'break-word',
                  overflowWrap: 'anywhere',
                  WebkitTextStroke: 'none',
                }}
              >
                {isCurrent ? (
                  <SmoothPlaybackTime store={smoothTimeStoreRef.current!}>
                    {playbackTime => renderLyricLine(preparedLyric, true, globalIndex, false, playbackTime)}
                  </SmoothPlaybackTime>
                ) : renderLyricLine(preparedLyric, false, globalIndex)}
              </motion.p>
              
              {/* Romanization is shown only for the active line */}
              {romanEnabled && lyric.roman && isCurrent && (
                <motion.p
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ 
                    opacity: 0.6, 
                    y: 0 
                  }}
                  exit={{ opacity: 0, y: -5 }}
                  transition={{ duration: 0.3 }}
                  className={`mt-2 font-light relative z-10 whitespace-normal break-words [overflow-wrap:anywhere] ${isLightTheme ? 'text-black/55' : 'text-white/60'}`}
                  style={{
                    fontSize: `${effectiveLyricSize * 0.45}rem`,
                    textShadow: '0 1px 4px rgba(0,0,0,0.4)',
                    letterSpacing: '0.05em',
                  }}
                >
                  {(() => {
                    // 如果有逐字罗马音，使用逐字渲染
                    if (effectiveWordByWordEnabled && lyric.romanWords && lyric.romanWords.length > 0) {
                      const lineStartTime = lyric.time * 1000

                      // Keep the romanized fill on the same isolated clock as the main active line.
                      return (
                        <SmoothPlaybackTime store={smoothTimeStoreRef.current!}>
                          {playbackTime => {
                            const absoluteCurrentMs = (playbackTime + lyricOffset) * 1000
                            const currentMs = Math.max(0, absoluteCurrentMs - lineStartTime - 200)

                            return (
                              <span className="inline-flex flex-wrap gap-x-1">
                                {preparedLyric.romanWordsToRender.map((word, idx) => {
                                  const startTime = word.startTime
                                  const endTime = startTime + Math.max(word.duration, 1)
                                  const fillProgress = clamp((currentMs - startTime) / Math.max(word.duration, 1))
                                  const fullyFilled = currentMs >= endTime
                                  const isInTimeRange = currentMs >= startTime && currentMs < endTime

                                  return (
                                    <span
                                      key={`roman-${idx}`}
                                      className="inline-block relative"
                                      style={{
                                        color: 'rgba(255, 255, 255, 0.4)',
                                      }}
                                    >
                                      {word.word}
                                      {(isInTimeRange || fullyFilled) && (
                                        <span
                                          aria-hidden="true"
                                          className="absolute left-0 top-0 overflow-hidden whitespace-nowrap pointer-events-none"
                                          style={{
                                            width: fullyFilled ? '100%' : `${fillProgress * 100}%`,
                                            color: 'rgba(255, 255, 255, 0.95)',
                                          }}
                                        >
                                          {word.word}
                                        </span>
                                      )}
                                    </span>
                                  )
                                })}
                              </span>
                            )
                          }}
                        </SmoothPlaybackTime>
                      )
                    }
                    
                    // 否则显示纯文本罗马音
                    return lyric.roman
                  })()}
                </motion.p>
              )}
              
              {/* Traditional translation is shown only for the active line */}
              {translationEnabled && translationPosition === 'traditional' && lyric.translation && lyric.translation.trim() !== '' && lyric.translation.trim() !== '//' && isCurrent && (
                <motion.p
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ 
                    opacity: 0.7, 
                    y: 0 
                  }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3 }}
                  className={`inline-block max-w-full text-lg mt-3 font-light italic relative z-10 whitespace-normal break-words [overflow-wrap:anywhere] ${isLightTheme ? 'text-black/60' : 'text-white/70'}`}
                  style={{
                    textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                    letterSpacing: '0.02em',
                    paddingLeft: '0.5rem',
                    borderLeft: '3px solid rgba(255, 255, 255, 0.3)',
                  }}
                >
                  {lyric.translation}
                </motion.p>
              )}
              </div>
            </motion.div>
          )
        })}
        <div
          aria-hidden="true"
          className="w-full shrink-0 pointer-events-none"
          style={{ height: isModernScroll ? '36%' : '56%' }}
        />
        </motion.div>
        </motion.div>
        </AnimatePresence>
      </div>
    </div>
  )
})

