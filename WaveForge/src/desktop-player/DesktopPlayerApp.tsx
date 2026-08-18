import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { DesktopPlayerSnapshot, DesktopPlayerControlAction, DesktopPlayerBridgeAPI } from '../electron'
import { reconcileBoundaryParentheses } from '../utils/lyricBoundaryParentheses'
import {
  getInterpolatedDesktopProgress,
  publishDesktopRealtime,
  useDesktopRealtimeSnapshot,
} from '../desktopRealtimeStore'

const DEFAULT_STATE: DesktopPlayerSnapshot = {
  song: null,
  lyric: null,
  playing: false,
  spectrum: [0, 0, 0, 0, 0],
  enabled: false,
  form: 'card',
  accentColor: '#ec4899',
  playlist: [],
  currentIndex: -1,
  progress: 0, duration: 0,
  hasTranslation: false,
  hasRomaji: false,
  volume: 0.5,
  muted: false,
  page: 'home',
}

const getBridge = () => (window as { desktopPlayer?: DesktopPlayerBridgeAPI }).desktopPlayer
const clamp = (value: number) => Math.max(0, Math.min(1, value))

function WaveBars({ className, maxHeight, accent, playing }: {
  className: string
  maxHeight: number
  accent: string
  playing: boolean
}) {
  const { spectrum } = useDesktopRealtimeSnapshot()
  const bars = [0, 1, 2, 3, 4].map(index => clamp(Number(spectrum[index]) || 0))
  return (
    <div className={`${className}${playing ? ' is-playing' : ''}`} style={{ '--dp-accent': accent } as CSSProperties} aria-label="音频可视化">
      {bars.map((value, index) => (
        <span
          key={index}
          className="dp-wave-bar"
          style={{ height: `${8 + Math.max(playing ? 0.12 : 0, value) * maxHeight}px`, '--bar-index': index } as CSSProperties}
        />
      ))}
    </div>
  )
}

function Icon({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{children}</svg>
}

const PrevIcon = () => <Icon><path d="M7 5v14M18 6l-8 6 8 6z" /></Icon>
const NextIcon = () => <Icon><path d="M17 5v14M6 6l8 6-8 6z" /></Icon>
const PlayIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
const PauseIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
const CloseIcon = () => <Icon size={15}><path d="M6 6l12 12M18 6L6 18" /></Icon>
const ListIcon = () => <Icon><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" /></Icon>
const TranslateIcon = () => <Icon><path d="M4 5h7M7.5 3v2M5 8c1 2 2.5 3.5 5 5M10 8c-.8 2.1-2.4 4-5 5M13 19l3.5-9 3.5 9M14.2 16h4.6" /></Icon>
const RomajiIcon = () => <span className="dp-letter-icon">あ</span>


type DesktopWord = NonNullable<DesktopPlayerSnapshot['lyric']>['words'][number]
const FALLBACK_FIRST_WORD_DURATION_MS = 140

function restoreLyricWordSpacing(words: DesktopWord[], lineText: string) {
  const expanded = words.flatMap(word => {
    if (/^\s+$/u.test(word.word)) return [{ ...word, duration: 0 }]
    const leading = word.word.match(/^\s+/u)?.[0] || ''
    const trailing = word.word.match(/\s+$/u)?.[0] || ''
    const content = word.word.slice(leading.length, word.word.length - trailing.length || undefined)
    const result: DesktopWord[] = []
    if (leading) result.push({ word: leading, startTime: word.startTime, duration: 0 })
    if (content) result.push({ ...word, word: content })
    if (trailing) result.push({ word: trailing, startTime: word.startTime + Math.max(0, word.duration), duration: 0 })
    return result.length ? result : [word]
  })
  const normalizedText = lineText.trim().replace(/\s+/gu, ' ')
  const visible = expanded.map((word, index) => word.word.trim() ? index : -1).filter(index => index >= 0)
  const insertSpaceAfter = new Set<number>()
  let cursor = 0
  visible.forEach((wordIndex, visibleIndex) => {
    const token = expanded[wordIndex].word.trim()
    const tokenIndex = normalizedText.indexOf(token, cursor)
    if (tokenIndex < 0) return
    const tokenEnd = tokenIndex + token.length
    const separator = normalizedText.slice(tokenEnd).match(/^\s+/u)?.[0] || ''
    cursor = tokenEnd + separator.length
    const nextIndex = visible[visibleIndex + 1]
    if (!separator || nextIndex === undefined) return
    if (!expanded.slice(wordIndex + 1, nextIndex).some(word => /^\s+$/u.test(word.word))) insertSpaceAfter.add(wordIndex)
  })
  return expanded.flatMap((word, index) => insertSpaceAfter.has(index)
    ? [word, { word: ' ', startTime: word.startTime + Math.max(0, word.duration), duration: 0 }]
    : [word])
}

function normalizeSequentialWordTiming(words: NonNullable<DesktopPlayerSnapshot['lyric']>['words']) {
  if (!words.length) return words
  const visible = words.map((word, index) => word.word?.trim() ? index : -1).filter(index => index >= 0)
  if (!visible.length) return words
  const starts: number[] = []
  visible.forEach((wordIndex, visibleIndex) => {
    const word = words[wordIndex]
    const rawStart = Number.isFinite(word.startTime) ? Math.max(0, word.startTime) : 0
    if (visibleIndex === 0) starts.push(rawStart)
    else {
      const previousStart = starts[visibleIndex - 1]
      const previousWord = words[visible[visibleIndex - 1]]
      const minimumGap = rawStart <= previousStart || !(Number.isFinite(previousWord.duration) && previousWord.duration > 8)
        ? FALLBACK_FIRST_WORD_DURATION_MS : 1
      starts.push(rawStart >= previousStart + minimumGap ? rawStart : previousStart + minimumGap)
    }
  })
  const normalized = words.map(word => ({ ...word }))
  visible.forEach((wordIndex, visibleIndex) => {
    const word = words[wordIndex]
    const startTime = starts[visibleIndex]
    const nextStart = starts[visibleIndex + 1]
    const rawDuration = Number.isFinite(word.duration) && word.duration > 8 ? word.duration : FALLBACK_FIRST_WORD_DURATION_MS
    normalized[wordIndex] = {
      ...word, startTime,
      duration: nextStart === undefined ? Math.max(1, rawDuration) : Math.max(1, Math.min(rawDuration, nextStart - startTime)),
    }
  })
  let previousEnd = 0
  normalized.forEach(word => {
    if (word.word?.trim()) previousEnd = word.startTime + word.duration
    else {
      word.startTime = previousEnd
      word.duration = 0
    }
  })
  return normalized
}

function alignRomanWordsToLyricTiming(romanWords: DesktopWord[], lyricWords: DesktopWord[]) {
  const roman = romanWords.filter(word => word.word?.trim())
  const source = lyricWords.filter(word => word.word?.trim())
  if (!roman.length || !source.length) return roman
  if (roman.length === source.length) return roman.map((word, index) => ({ ...word, startTime: source[index].startTime, duration: Math.max(1, source[index].duration) }))
  const sourceEnd = source.reduce((end, word) => Math.max(end, word.startTime + Math.max(1, word.duration)), 0)
  const increasing = roman.some((word, index) => index > 0 && word.startTime > roman[index - 1].startTime)
  if (increasing) return roman.map((word, index) => {
    const startTime = Math.max(0, word.startTime)
    const nextStart = roman.slice(index + 1).find(next => next.startTime > startTime)?.startTime
    return { ...word, startTime, duration: Math.max(1, Math.min(startTime + Math.max(1, word.duration), nextStart ?? sourceEnd) - startTime) }
  })
  const totalCharacters = Math.max(1, roman.reduce((count, word) => count + Array.from(word.word).length, 0))
  let elapsed = 0
  return roman.map(word => {
    const count = Math.max(1, Array.from(word.word).length)
    const startTime = sourceEnd * elapsed / totalCharacters
    elapsed += count
    return { ...word, startTime, duration: Math.max(1, sourceEnd * elapsed / totalCharacters - startTime) }
  })
}

function fixQQMissingParentheses(lyric: NonNullable<DesktopPlayerSnapshot['lyric']>) {
  const words = reconcileBoundaryParentheses(lyric.line, lyric.words || [])
  const romanWords = reconcileBoundaryParentheses(lyric.romaji || '', lyric.romanWords || [])
  return { words, romanWords }
}

function buildFallbackWords(line: string, durationSeconds: number): DesktopWord[] {
  const characters = Array.from(line)
  const visibleCount = Math.max(1, characters.filter(character => !/^\s$/u.test(character)).length)
  const unitDuration = Math.max(45, durationSeconds * 1000 / visibleCount)
  let startTime = 0
  return characters.map(character => {
    if (/^\s$/u.test(character)) return { word: character, startTime, duration: 0 }
    const word = { word: character, startTime, duration: unitDuration }
    startTime += unitDuration
    return word
  })
}

function TimedWords({ words, elapsedMs, className = '' }: { words: DesktopWord[]; elapsedMs: number; className?: string }) {
  return <>{words.map((word, wordIndex) => {
    if (/^\s+$/u.test(word.word)) return <span key={`space-${wordIndex}`}>{word.word}</span>
    const characters = Array.from(word.word)
    const duration = Math.max(1, word.duration)
    const characterDuration = duration / Math.max(1, characters.length)
    return <span key={`word-${wordIndex}`}>{characters.map((character, characterIndex) => {
      const start = word.startTime + characterDuration * characterIndex
      const fill = clamp((elapsedMs - start) / characterDuration)
      return <span key={characterIndex} className={`dp-lyric-word ${className}`} style={{ '--word-fill': `${fill * 100}%` } as CSSProperties}>{character}</span>
    })}{className === 'roman' && wordIndex < words.length - 1 ? ' ' : null}</span>
  })}</>
}

function InterludeDots({ state, progress: currentProgress }: { state: DesktopPlayerSnapshot; progress: number }) {
  const lyric = state.lyric!
  const now = currentProgress + 0.2
  const start = lyric.interludeStartTime ?? lyric.lineStart
  const end = lyric.interludeEndTime ?? start + 5
  const progress = clamp((now - start) / Math.max(.1, end - start))
  return <div className="dp-interlude" aria-label="间奏">{[0, 1, 2].map(index => <span key={index} style={{ '--dot-fill': `${clamp(progress * 3 - index) * 100}%` } as CSSProperties} />)}</div>
}

function LyricMarquee({ progress, lineStart, lineDuration, playing, contentKey, children }: {
  progress: number
  lineStart: number
  lineDuration: number
  playing: boolean
  contentKey: string
  children: ReactNode
}) {
  const viewportRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [overflowWidth, setOverflowWidth] = useState(0)
  const [, forceMarqueeTick] = useState(0)

  useEffect(() => {
    if (!viewportRef.current || !trackRef.current) {
      setOverflowWidth(0)
      return
    }
    const measure = () => {
      const viewport = viewportRef.current
      const track = trackRef.current
      if (!viewport || !track) return
      setOverflowWidth(Math.max(0, track.scrollWidth - viewport.clientWidth))
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (observer && viewportRef.current) observer.observe(viewportRef.current)
    if (observer && trackRef.current) observer.observe(trackRef.current)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [contentKey])

  useEffect(() => {
    if (!playing || overflowWidth <= 0) return
    // 窗口隐藏（document.visibilityState !== 'visible'）时暂停节拍定时器，
    // 恢复可见时重新启动，避免常驻 30fps setInterval 空转 setState 消耗 CPU/功耗。
    let marqueeTimer: number | null = null
    const startMarqueeTimer = () => {
      if (marqueeTimer !== null) return
      marqueeTimer = window.setInterval(() => forceMarqueeTick(value => value + 1), 1000 / 30)
    }
    const stopMarqueeTimer = () => {
      if (marqueeTimer !== null) {
        window.clearInterval(marqueeTimer)
        marqueeTimer = null
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startMarqueeTimer()
      else stopMarqueeTimer()
    }
    startMarqueeTimer()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopMarqueeTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [playing, overflowWidth])

  const safeDuration = Math.max(1.8, lineDuration || 4.2)
  const elapsedSeconds = Math.max(0, progress - lineStart)
  const lead = Math.min(.72, safeDuration * .15)
  const tail = Math.min(.58, safeDuration * .12)
  const range = Math.max(.45, safeDuration - lead - tail)
  const raw = Math.max(0, Math.min(1, (elapsedSeconds - lead) / range))
  const eased = raw * raw * (3 - 2 * raw)

  return (
    <span ref={viewportRef} className={`dp-lyric-marquee${overflowWidth > 0 ? ' is-overflowing' : ''}`}>
      <span ref={trackRef} className="dp-lyric-track" style={{ transform: `translate3d(${-overflowWidth * eased}px, 0, 0)` }}>
        {children}
      </span>
    </span>
  )
}

function LyricLineView({ state, showTranslation, showRomaji, compact = false }: {
  state: DesktopPlayerSnapshot
  showTranslation: boolean
  showRomaji: boolean
  compact?: boolean
}) {
  // 词组结构只由歌词行内容决定，与播放进度无关。IPC 每 100ms 推送新快照会让
  // lyric 对象引用变化，这里按内容签名缓存计算结果，避免每 tick 重建多份数组。
  const lyricWordsMemoRef = useRef<{ signature: string; words: DesktopWord[]; romanWords: DesktopWord[] } | null>(null)
  const realtime = useDesktopRealtimeSnapshot()
  const [, forceLocalLyricTick] = useState(0)
  useEffect(() => {
    if (!state.playing || !state.lyric?.words?.length) return
    // 窗口隐藏时暂停逐字刷新定时器，恢复可见时重新启动（避免常驻 60ms setInterval 空转）。
    let lyricTimer: number | null = null
    const startLyricTimer = () => {
      if (lyricTimer !== null) return
      lyricTimer = window.setInterval(() => forceLocalLyricTick(value => value + 1), 60)
    }
    const stopLyricTimer = () => {
      if (lyricTimer !== null) {
        window.clearInterval(lyricTimer)
        lyricTimer = null
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startLyricTimer()
      else stopLyricTimer()
    }
    startLyricTimer()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopLyricTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [state.playing, state.lyric?.line, state.lyric?.words?.length])
  const interpolatedProgress = getInterpolatedDesktopProgress(realtime, state.playing)
  const lyric = state.lyric
  if (!lyric) return <div className={`dp-lyric${compact ? ' compact' : ''}`}>&nbsp;</div>
  if (lyric.isInterlude) return <div className={`dp-lyric${compact ? ' compact' : ''}`}><InterludeDots state={state} progress={interpolatedProgress} /></div>
  if (!lyric.line) return <div className={`dp-lyric${compact ? ' compact' : ''}`}>&nbsp;</div>
  const elapsedMs = (interpolatedProgress - lyric.lineStart) * 1000

  const signature = [
    lyric.line,
    lyric.lineStart,
    lyric.lineDuration || 0,
    (lyric.words || []).length,
    (lyric.romanWords || []).length,
    lyric.romaji || '',
  ].join('\u0001')

  let words: DesktopWord[]
  let romanWords: DesktopWord[]
  if (lyricWordsMemoRef.current?.signature === signature) {
    words = lyricWordsMemoRef.current.words
    romanWords = lyricWordsMemoRef.current.romanWords
  } else {
    const fixed = fixQQMissingParentheses(lyric)
    const sourceWords = fixed.words.length ? fixed.words : buildFallbackWords(lyric.line, lyric.lineDuration || 4.2)
    words = normalizeSequentialWordTiming(restoreLyricWordSpacing(sourceWords, lyric.line))
    const romanSource = fixed.romanWords.length
      ? fixed.romanWords
      : (lyric.romaji || '').trim().split(/\s+/u).filter(Boolean).map(word => ({ word, startTime: 0, duration: 0 }))
    romanWords = normalizeSequentialWordTiming(alignRomanWordsToLyricTiming(romanSource, normalizeSequentialWordTiming(sourceWords)))
    lyricWordsMemoRef.current = { signature, words, romanWords }
  }

  return (
    <div className={`dp-lyric${compact ? ' compact' : ''}`}>
      <div className="dp-lyric-main">
        <LyricMarquee progress={interpolatedProgress} lineStart={lyric.lineStart} lineDuration={lyric.lineDuration || 0} playing={state.playing} contentKey={`${lyric.line}\u0001${words.length}`}>
          {words.length ? <TimedWords words={words} elapsedMs={elapsedMs} /> : <span className="dp-lyric-word complete">{lyric.line}</span>}
        </LyricMarquee>
      </div>
      {showRomaji && lyric.romaji?.trim() ? <div className="dp-lyric-secondary romaji"><LyricMarquee progress={interpolatedProgress} lineStart={lyric.lineStart} lineDuration={lyric.lineDuration || 0} playing={state.playing} contentKey={`${lyric.romaji || ''}\u0001${romanWords.length}`}>{romanWords.length
        ? <TimedWords words={romanWords} elapsedMs={elapsedMs} className="roman" />
        : lyric.romaji}</LyricMarquee></div> : null}
      {showTranslation && lyric.translation?.trim() ? <div className="dp-lyric-secondary"><LyricMarquee progress={interpolatedProgress} lineStart={lyric.lineStart} lineDuration={lyric.lineDuration || 0} playing={state.playing} contentKey={lyric.translation}>{lyric.translation}</LyricMarquee></div> : null}
    </div>
  )
}

function ToolButton({ title, active = false, disabled = false, onClick, children, count }: {
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
  count?: number
}) {
  return (
    <button className={`dp-tool-btn${active ? ' active' : ''}`} aria-label={title} aria-pressed={active} disabled={disabled} onClick={onClick}>
      {children}{typeof count === 'number' ? <span className="dp-tool-count">{count}</span> : null}
    </button>
  )
}

function ControlPanel({ state, title, artists, showTranslation, setShowTranslation, showRomaji, setShowRomaji, showPlaylist, setShowPlaylist, sendControl, currentRef }: {
  state: DesktopPlayerSnapshot
  title: string
  artists: string
  showTranslation: boolean
  setShowTranslation: (value: boolean) => void
  showRomaji: boolean
  setShowRomaji: (value: boolean) => void
  showPlaylist: boolean
  setShowPlaylist: (value: boolean) => void
  sendControl: (action: DesktopPlayerControlAction, payload?: number) => void
  currentRef: React.RefObject<HTMLButtonElement | null>
}) {
  const hasTranslation = state.hasTranslation || Boolean(state.lyric?.translation?.trim())
  const hasRomaji = state.hasRomaji || Boolean(state.lyric?.romaji?.trim()) || Boolean(state.lyric?.romanWords?.length)
  return (
    <div className="dp-panel-content">
      <div className="dp-panel-heading"><strong>{title}</strong><span>{artists || '未知歌手'}</span></div>
      <div className="dp-transport">
        <button className="dp-ctrl-btn" aria-label="上一曲" onClick={() => sendControl('prev')}><PrevIcon /></button>
        <button className="dp-ctrl-btn primary" aria-label="播放或暂停" onClick={() => sendControl('toggle')}>{state.playing ? <PauseIcon /> : <PlayIcon />}</button>
        <button className="dp-ctrl-btn" aria-label="下一曲" onClick={() => sendControl('next')}><NextIcon /></button>
      </div>
      <div className="dp-tool-row">
        {hasTranslation ? <ToolButton title="显示翻译" active={showTranslation} onClick={() => setShowTranslation(!showTranslation)}><TranslateIcon /></ToolButton> : null}
        {hasRomaji ? <ToolButton title="显示罗马音" active={showRomaji} onClick={() => setShowRomaji(!showRomaji)}><RomajiIcon /></ToolButton> : null}
        <ToolButton title="播放列表" active={showPlaylist} count={state.playlist.length} onClick={() => setShowPlaylist(!showPlaylist)}><ListIcon /></ToolButton>
        <button className="dp-tool-btn dp-close" aria-label="关闭桌面播放器" onClick={() => sendControl('close')}><CloseIcon /></button>
      </div>
      {showPlaylist ? (
        <div className="dp-playlist" role="listbox" aria-label="当前播放列表">
          {state.playlist.length ? state.playlist.map(item => {
            const current = item.index === state.currentIndex
            return (
              <button
                key={item.index}
                ref={current ? currentRef : undefined}
                className={`dp-playlist-item${current ? ' current' : ''}`}
                aria-current={current ? 'true' : undefined}
                onClick={() => sendControl('select-index', item.index)}
              >
                <span className="idx">{current ? <span className="dp-now-playing"><i /><i /><i /></span> : item.index + 1}</span>
                <span className="song-copy"><strong>{item.name}</strong>{item.artists ? <small>{item.artists}</small> : null}</span>
                {current ? <span className="playing-label">正在播放</span> : null}
              </button>
            )
          }) : <div className="dp-empty-list">当前队列暂无歌曲</div>}
        </div>
      ) : null}
    </div>
  )
}

export default function DesktopPlayerApp() {
  const [state, setState] = useState<DesktopPlayerSnapshot>(DEFAULT_STATE)
  const [expanded, setExpanded] = useState(false)
  const [closing, setClosing] = useState(false)
  const [direction, setDirection] = useState<'up' | 'down'>('down')
  const [showPlaylist, setShowPlaylist] = useState(false)
  const [showTranslation, setShowTranslation] = useState(true)
  const [showRomaji, setShowRomaji] = useState(true)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const shellRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const currentItemRef = useRef<HTMLButtonElement>(null)
  const suppressClickRef = useRef(false)
  const collapseTimerRef = useRef<number | null>(null)
  const closingTimerRef = useRef<number | null>(null)
  const closingReportFrameRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const collapsedHeightRef = useRef(0)

  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return
    const apply = (snapshot: Partial<DesktopPlayerSnapshot>) => {
      if (!snapshot) return
      publishDesktopRealtime(snapshot)
      const lowFrequency = { ...snapshot }
      delete lowFrequency.progress
      delete lowFrequency.spectrum
      if (Object.keys(lowFrequency).length > 0) {
        setState(previous => ({ ...DEFAULT_STATE, ...previous, ...lowFrequency }))
      }
    }
    bridge.getState().then(apply).catch(() => undefined)
    return bridge.onState(apply)
  }, [])

  useEffect(() => {
    const updateViewportHeight = () => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', updateViewportHeight)
    return () => window.removeEventListener('resize', updateViewportHeight)
  }, [])


  useEffect(() => {
    if (!showPlaylist) return
    const frame = requestAnimationFrame(() => {
      const item = currentItemRef.current
      const list = item?.parentElement
      if (!list || !item) return
      const itemTop = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      list.scrollTop = Math.max(0, itemTop - item.offsetHeight - 4)
    })
    return () => cancelAnimationFrame(frame)
  }, [showPlaylist, state.currentIndex])

  useEffect(() => {
    const panel = panelRef.current
    if (!expanded || !panel) return
    const report = () => getBridge()?.reportContentHeight(collapsedHeightRef.current + panel.scrollHeight)
    const frame = requestAnimationFrame(report)
    const observer = new ResizeObserver(report)
    observer.observe(panel)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [expanded, showPlaylist, state.playlist.length])

  const sendControl = (action: DesktopPlayerControlAction, payload?: number) => getBridge()?.sendControl(action, payload)

  const toggleExpanded = async (next = !expanded) => {
    if (closing || next === expanded) return
    const bridge = getBridge()
    if (next) {
      collapsedHeightRef.current = window.innerHeight
      const result = await bridge?.setExpanded(true).catch(() => undefined)
      if (!mountedRef.current) return
      if (result?.direction) setDirection(result.direction)
      setExpanded(true)
      return
    }
    setClosing(true)
    await bridge?.setExpanded(false).catch(() => undefined)
    if (!mountedRef.current) return
    if (closingTimerRef.current !== null) window.clearTimeout(closingTimerRef.current)
    closingTimerRef.current = window.setTimeout(() => {
      closingTimerRef.current = null
      if (!mountedRef.current) return
      setExpanded(false)
      setClosing(false)
      if (collapsedHeightRef.current) {
        closingReportFrameRef.current = requestAnimationFrame(() => {
          closingReportFrameRef.current = null
          bridge?.reportContentHeight(collapsedHeightRef.current)
        })
      }
    }, 220)
  }

  const clearCollapseTimer = () => {
    if (collapseTimerRef.current !== null) window.clearTimeout(collapseTimerRef.current)
    collapseTimerRef.current = null
  }
  const armCollapseTimer = () => {
    clearCollapseTimer()
    collapseTimerRef.current = window.setTimeout(() => void toggleExpanded(false), 2400)
  }
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearCollapseTimer()
      if (closingTimerRef.current !== null) window.clearTimeout(closingTimerRef.current)
      closingTimerRef.current = null
      if (closingReportFrameRef.current !== null) cancelAnimationFrame(closingReportFrameRef.current)
      closingReportFrameRef.current = null
    }
  }, [])

  const startDrag = (event: ReactMouseEvent) => {
    if (event.button !== 0 || (event.target as Element).closest('button, .dp-playlist, .dp-resizer')) return
    const bridge = getBridge()
    bridge?.startDrag({ x: event.screenX, y: event.screenY })
    const originX = event.screenX
    const originY = event.screenY
    let frame = 0
    let latest: MouseEvent | null = null
    let dragging = false
    const flush = () => {
      frame = 0
      if (dragging && latest) bridge?.dragTo({ x: latest.screenX, y: latest.screenY })
    }
    const onMove = (moveEvent: MouseEvent) => {
      latest = moveEvent
      const distance = Math.abs(moveEvent.screenX - originX) + Math.abs(moveEvent.screenY - originY)
      if (distance > 4) {
        dragging = true
        suppressClickRef.current = true
      }
      if (dragging && !frame) frame = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame)
      if (dragging && latest) bridge?.dragTo({ x: latest.screenX, y: latest.screenY })
      bridge?.endDrag()
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleSurfaceClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    void toggleExpanded()
  }

  const startResize = (event: ReactMouseEvent, edge: 'nw' | 'ne' | 'sw' | 'se') => {
    event.preventDefault()
    event.stopPropagation()
    const bridge = getBridge()
    bridge?.startResize({ x: event.screenX, y: event.screenY, edge })
    let frame = 0
    let latest: MouseEvent | null = null
    const flush = () => {
      frame = 0
      if (latest) bridge?.resizeTo({ x: latest.screenX, y: latest.screenY })
    }
    const onMove = (moveEvent: MouseEvent) => {
      latest = moveEvent
      if (!frame) frame = requestAnimationFrame(flush)
    }
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame)
      if (latest) bridge?.resizeTo({ x: latest.screenX, y: latest.screenY })
      bridge?.endResize()
      collapsedHeightRef.current = expanded ? collapsedHeightRef.current : window.innerHeight
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const accent = state.accentColor || '#ec4899'
  const title = state.song?.name || '未在播放'
  const artists = state.song?.artists || ''
  const cover = state.song?.coverUrl || ''
  const panel = expanded ? (
    <div ref={panelRef} className={`dp-panel ${direction}${closing ? ' closing' : ''}`} onMouseDown={startDrag}>
      <ControlPanel
        state={state} title={title} artists={artists}
        showTranslation={showTranslation} setShowTranslation={setShowTranslation}
        showRomaji={showRomaji} setShowRomaji={setShowRomaji}
        showPlaylist={showPlaylist} setShowPlaylist={setShowPlaylist}
        sendControl={sendControl} currentRef={currentItemRef}
      />
    </div>
  ) : null

  const surface = state.form === 'bar' ? (
    <div className="dp-bar-surface" onMouseDown={startDrag} onClick={handleSurfaceClick}>
      {cover ? <img className="dp-bar-cover" src={cover} alt="" draggable={false} /> : <div className="dp-bar-cover empty">♪</div>}
      <div className="dp-bar-copy">
        <div className="dp-bar-title">{title}{artists ? <span>{artists}</span> : null}</div>
        <LyricLineView state={state} showTranslation={showTranslation} showRomaji={showRomaji} compact />
      </div>
      <WaveBars className="dp-bar-wave" maxHeight={22} accent={accent} playing={state.playing} />
    </div>
  ) : (
    <div
      className={`dp-card-surface${expanded ? ' expanded' : ''}`}
      style={{ height: Math.max(102, (expanded ? collapsedHeightRef.current : viewportHeight) - 2) }}
      onMouseDown={startDrag}
      onClick={handleSurfaceClick}
    >
      {cover ? <img className="dp-card-cover" src={cover} alt="" draggable={false} /> : <div className="dp-card-cover empty">♪</div>}
      <div className="dp-card-copy">
        <div className="dp-card-title">{title}</div>
        {artists ? <div className="dp-card-artist">{artists}</div> : null}
        <LyricLineView state={state} showTranslation={showTranslation} showRomaji={showRomaji} />
      </div>
      <WaveBars className="dp-card-wave" maxHeight={38} accent={accent} playing={state.playing} />
    </div>
  )

  return (
    <div className={`dp-root dp-${state.form}-root direction-${direction}`} style={{ '--dp-accent': accent } as CSSProperties}>
      <div ref={shellRef} className={`dp-shell dp-${state.form}`} onMouseEnter={clearCollapseTimer} onMouseLeave={() => expanded && armCollapseTimer()}>
        {direction === 'up' ? panel : null}
        {surface}
        {direction === 'down' ? panel : null}
        {state.form === 'card' ? (['nw', 'ne', 'sw', 'se'] as const).map(edge => (
          <div key={edge} className={`dp-resizer ${edge}`} onMouseDown={event => startResize(event, edge)} aria-label="拖拽调整卡片大小" />
        )) : null}
      </div>
    </div>
  )
}
