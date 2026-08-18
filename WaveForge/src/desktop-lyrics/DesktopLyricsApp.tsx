import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import {
  AlignJustify, Languages, LockKeyhole, LockKeyholeOpen, Minus, MoveVertical, Palette,
  Pause, Play, Plus, RotateCcw, Settings, SkipBack, SkipForward, Type, X,
} from 'lucide-react'
import * as OpenCC from 'opencc-js'
import type {
  DesktopLyricsBridgeAPI, DesktopLyricsColorMode, DesktopLyricsSettings,
  DesktopPlayerLyricWord, DesktopPlayerSnapshot,
} from '../electron'
import {
  getInterpolatedDesktopProgress,
  publishDesktopRealtime,
  useDesktopRealtimeSnapshot,
} from '../desktopRealtimeStore'
import { prepareLyricWords } from '../utils/lyricWordTiming'

const DEFAULT_STATE: DesktopPlayerSnapshot = {
  song: null, lyric: null, playing: false, spectrum: [0, 0, 0, 0, 0], enabled: false,
  form: 'card', accentColor: '#ec4899', playlist: [], currentIndex: -1, progress: 0, duration: 0,
  hasTranslation: false, hasRomaji: false, volume: 0.5, muted: false, page: 'home',
}

const DEFAULT_SETTINGS: DesktopLyricsSettings = {
  enabled: false, fontSize: 58, colorMode: 'auto', orientation: 'horizontal',
  doubleLine: false, translationEnabled: false, romajiEnabled: false, traditionalEnabled: false, locked: false,
}

const COLOR_PRESETS: Array<{ value: DesktopLyricsColorMode; label: string; color: string }> = [
  { value: 'auto', label: '随歌曲', color: 'linear-gradient(135deg,#67e8f9,#f9a8d4,#fde68a)' },
  { value: 'rose', label: '樱粉', color: '#f9a8d4' },
  { value: 'sky', label: '晴蓝', color: '#7dd3fc' },
  { value: 'gold', label: '暖金', color: '#fde68a' },
  { value: 'mint', label: '薄荷', color: '#86efac' },
  { value: 'white', label: '月白', color: '#f8fafc' },
]

const STATIC_COLORS: Record<Exclude<DesktopLyricsColorMode, 'auto'>, string> = {
  rose: '#f9a8d4', sky: '#7dd3fc', gold: '#fde68a', mint: '#86efac', white: '#f8fafc',
}

const toTraditional = OpenCC.Converter({ from: 'cn', to: 'tw' })
const bridge = () => (window as { desktopLyrics?: DesktopLyricsBridgeAPI }).desktopLyrics

function parseCssColor(color: string): [number, number, number] | null {
  const value = color.trim()
  const shortHex = value.match(/^#([\da-f])([\da-f])([\da-f])$/iu)
  if (shortHex) return shortHex.slice(1).map(part => Number.parseInt(part + part, 16)) as [number, number, number]
  const hex = value.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu)
  if (hex) return hex.slice(1).map(part => Number.parseInt(part, 16)) as [number, number, number]
  const rgb = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/iu)
  if (!rgb) return null
  return rgb.slice(1, 4).map(part => Math.max(0, Math.min(255, Number(part)))) as [number, number, number]
}

// 封面主色可能非常暗。只提升明度、不改变色相关系，保证桌面上仍然能读出“歌曲主题色”。
function makeReadableThemeColor(color: string) {
  const rgb = parseCssColor(color)
  if (!rgb) return '#f9a8d4'
  const brightness = (rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114) / 255
  if (brightness >= .64) return `rgb(${rgb.map(Math.round).join(', ')})`
  const whiteMix = Math.min(.68, (.64 - brightness) / Math.max(.01, 1 - brightness))
  return `rgb(${rgb.map(channel => Math.round(channel + (255 - channel) * whiteMix)).join(', ')})`
}

// 参照播放页“现代-逐字-柔和”模式：填充区向前延伸并用渐变 mask 羽化边缘。
const SOFT_FILL_EXTENSION = 42

function getSoftFillMask(fillPercent: number, vertical: boolean) {
  const extendedWidth = Math.min(100, fillPercent + SOFT_FILL_EXTENSION)
  const fillEdge = extendedWidth > 0 ? fillPercent / extendedWidth * 100 : 0
  const featherStart = Math.max(0, fillEdge - 18)
  const featherShoulder = Math.max(featherStart, fillEdge - 6)
  const featherTail = fillEdge + (100 - fillEdge) * 0.54
  return {
    extendedWidth,
    mask: `linear-gradient(${vertical ? '180deg' : '90deg'}, black 0%, black ${featherStart}%, rgba(0,0,0,0.94) ${featherShoulder}%, rgba(0,0,0,0.76) ${fillEdge}%, rgba(0,0,0,0.28) ${featherTail}%, transparent 100%)`,
  }
}

function InterludeDots({ lyric, playing }: { lyric: NonNullable<DesktopPlayerSnapshot['lyric']>; playing: boolean }) {
  const realtime = useDesktopRealtimeSnapshot()
  const [, forceLocalTick] = useState(0)
  useEffect(() => {
    if (!playing) return
    // 窗口隐藏时暂停节拍定时器，恢复可见时重新启动（避免常驻 30fps setInterval 空转）。
    let interludeTimer: number | null = null
    const startInterludeTimer = () => {
      if (interludeTimer !== null) return
      interludeTimer = window.setInterval(() => forceLocalTick(value => value + 1), 1000 / 30)
    }
    const stopInterludeTimer = () => {
      if (interludeTimer !== null) {
        window.clearInterval(interludeTimer)
        interludeTimer = null
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') startInterludeTimer()
      else stopInterludeTimer()
    }
    startInterludeTimer()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stopInterludeTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [playing, lyric.interludeStartTime, lyric.interludeEndTime])
  const now = getInterpolatedDesktopProgress(realtime, playing) + 0.2
  const start = lyric.interludeStartTime ?? lyric.lineStart
  const end = lyric.interludeEndTime ?? start + 5
  const progress = Math.max(0, Math.min(1, (now - start) / Math.max(0.1, end - start)))
  return (
    <span className="dl-interlude" aria-label="间奏">
      {[0, 1, 2].map(index => (
        <span key={index} style={{ '--dot-fill': (Math.max(0, Math.min(1, progress * 3 - index)) * 100) + '%' } as CSSProperties} />
      ))}
    </span>
  )
}

function LyricText({ text, words, playing, lineStart, lineDuration, color, filledColor, traditional, vertical, className = '' }: {
  text: string
  words?: DesktopPlayerLyricWord[]
  playing: boolean
  lineStart: number
  lineDuration: number
  color: string
  filledColor: string
  traditional: boolean
  vertical: boolean
  className?: string
}) {
  const realtime = useDesktopRealtimeSnapshot()
  const [, forceLocalTick] = useState(0)
  const viewportRef = useRef<HTMLSpanElement>(null)
  const trackRef = useRef<HTMLSpanElement>(null)
  const [overflowWidth, setOverflowWidth] = useState(0)
  useEffect(() => {
    if (!playing) return
    // 窗口隐藏时暂停逐字刷新定时器，恢复可见时重新启动（避免常驻 30fps setInterval 空转）。
    let lyricTimer: number | null = null
    const startLyricTimer = () => {
      if (lyricTimer !== null) return
      lyricTimer = window.setInterval(() => forceLocalTick(value => value + 1), 1000 / 30)
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
  }, [playing, text, words?.length])
  const progress = getInterpolatedDesktopProgress(realtime, playing)
  const convertedText = traditional ? toTraditional(text) : text
  const normalizedWords = useMemo(
    () => prepareLyricWords({ time: lineStart, text, words: words || [] }),
    [words, text, lineStart],
  )
  useEffect(() => {
    if (vertical || !viewportRef.current || !trackRef.current) {
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
  }, [convertedText, normalizedWords.length, traditional, vertical, lineStart, lineDuration])

  const elapsedMs = Math.max(0, (progress - lineStart) * 1000)
  const wordContent = traditional || !normalizedWords.length
    ? convertedText
    : normalizedWords.map((word, index) => {
      const shownWord = word.word
      const duration = Math.max(90, Number(word.duration) || 180)
      const fill = Math.max(0, Math.min(1, (elapsedMs - 200 - Number(word.startTime || 0)) / duration))
      const fillPercent = fill * 100
      const fullyFilled = fill >= 1
      const isFilling = fill > 0 && !fullyFilled
      const softMask = getSoftFillMask(fillPercent, vertical)
      const liftRaw = Math.max(0, Math.min(1, (elapsedMs - 200 - Number(word.startTime || 0) + 180) / 520))
      const liftProgress = 1 - Math.pow(1 - liftRaw, 3)
      return (
        <span
          key={index + '-' + word.word}
          className="dl-word"
          style={{
            '--word-fill': fillPercent + '%',
            '--lyric-color': color,
            '--lyric-filled-color': filledColor,
            transform: 'translateY(' + (-0.075 * liftProgress) + 'em)',
          } as CSSProperties}
        >
          <span className="dl-word-base" style={fullyFilled ? { color: filledColor } : undefined}>{shownWord}</span>
          {isFilling && (
            <span
              className="dl-word-filled"
              aria-hidden
              style={{
                ...(vertical ? { height: softMask.extendedWidth + '%' } : { width: softMask.extendedWidth + '%' }),
                WebkitMaskImage: softMask.mask,
                maskImage: softMask.mask,
              }}
            >
              {shownWord}
            </span>
          )}
        </span>
      )
    })

  if (vertical) return <span className={className} aria-label={convertedText}>{wordContent}</span>
  const safeDuration = Math.max(1.8, lineDuration || 4.2)
  const elapsedSeconds = Math.max(0, progress - lineStart)
  const lead = Math.min(.72, safeDuration * .15)
  const tail = Math.min(.58, safeDuration * .12)
  const range = Math.max(.45, safeDuration - lead - tail)
  const raw = Math.max(0, Math.min(1, (elapsedSeconds - lead) / range))
  const eased = raw * raw * (3 - 2 * raw)
  return (
    <span ref={viewportRef} className={'dl-marquee ' + (overflowWidth > 0 ? 'is-overflowing ' : '') + className} aria-label={convertedText}>
      <span ref={trackRef} className="dl-marquee-track" style={{ transform: 'translate3d(' + (-overflowWidth * eased) + 'px, 0, 0)' }}>
        {wordContent}
      </span>
    </span>
  )
}

function Toggle({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button type="button" className={`dl-toggle ${checked ? 'is-on' : ''}`} onClick={onClick}>
      <span>{label}</span><i />
    </button>
  )
}

export default function DesktopLyricsApp() {
  const [state, setState] = useState(DEFAULT_STATE)
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [hovered, setHovered] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [unlockVisible, setUnlockVisible] = useState(false)
  const mousePassthroughRef = useRef(false)
  const unlockHideTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const api = bridge()
    if (!api) return
    const applyState = (snapshot: Partial<DesktopPlayerSnapshot>) => {
      publishDesktopRealtime(snapshot)
      const lowFrequency = { ...snapshot }
      delete lowFrequency.progress
      delete lowFrequency.spectrum
      if (Object.keys(lowFrequency).length > 0) {
        setState(previous => ({ ...DEFAULT_STATE, ...previous, ...lowFrequency }))
      }
    }
    const applySettings = (next: DesktopLyricsSettings) => {
      const merged = { ...DEFAULT_SETTINGS, ...next }
      mousePassthroughRef.current = merged.locked
      setSettings(merged)
      void api.setMousePassthrough(merged.locked)
    }
    void api.getState().then(applyState)
    void api.getSettings().then(applySettings)
    const offState = api.onState(applyState)
    const offSettings = api.onSettings(applySettings)
    return () => {
      offState()
      offSettings()
      if (mousePassthroughRef.current) {
        mousePassthroughRef.current = false
        void api.setMousePassthrough(false)
      }
    }
  }, [])

  useEffect(() => () => {
    if (unlockHideTimerRef.current !== null) window.clearTimeout(unlockHideTimerRef.current)
  }, [])

  const update = (partial: Partial<DesktopLyricsSettings>) => {
    setSettings(previous => ({ ...previous, ...partial }))
    void bridge()?.updateSettings(partial).then(setSettings)
  }

  const setMousePassthrough = (passthrough: boolean) => {
    if (mousePassthroughRef.current === passthrough) return
    mousePassthroughRef.current = passthrough
    void bridge()?.setMousePassthrough(passthrough)
  }

  const cancelUnlockHide = () => {
    if (unlockHideTimerRef.current !== null) {
      window.clearTimeout(unlockHideTimerRef.current)
      unlockHideTimerRef.current = null
    }
  }

  const scheduleUnlockHide = () => {
    cancelUnlockHide()
    unlockHideTimerRef.current = window.setTimeout(() => {
      unlockHideTimerRef.current = null
      setUnlockVisible(false)
      setMousePassthrough(true)
    }, 2000)
  }

  const showUnlock = () => {
    setUnlockVisible(true)
    scheduleUnlockHide()
  }

  const setLocked = (locked: boolean) => {
    setSettingsOpen(false)
    void bridge()?.setPanelOpen(false)
    setSettings(previous => ({ ...previous, locked }))
    if (locked) {
      showUnlock()
    } else {
      cancelUnlockHide()
      setUnlockVisible(false)
      setMousePassthrough(false)
    }
    void bridge()?.updateSettings({ locked }).then(next => {
      setSettings({ ...DEFAULT_SETTINGS, ...next })
      setMousePassthrough(locked)
    })
  }

  const toggleSettingsPanel = () => {
    if (settings.locked) return
    const open = !settingsOpen
    setSettingsOpen(open)
    void bridge()?.setPanelOpen(open)
  }

  const closeSettings = () => {
    if (!settingsOpen) return
    setSettingsOpen(false)
    void bridge()?.setPanelOpen(false)
  }

  const color = settings.colorMode === 'auto'
    ? makeReadableThemeColor(state.accentColor || '#f9a8d4')
    : STATIC_COLORS[settings.colorMode]
  // 已唱歌词始终使用高对比月白色，主题色仅用于未唱部分和辉光。
  const filledColor = '#ffffff'
  const lyric = state.lyric
  const currentText = lyric?.line?.trim() || state.song?.name || 'WaveForge 澜音工坊'
  const translation = settings.translationEnabled && state.hasTranslation ? lyric?.translation?.trim() || '' : ''
  const romaji = settings.romajiEnabled && state.hasRomaji ? lyric?.romaji?.trim() || '' : ''
  const next = lyric?.nextLine?.trim() || ''
  // 双行时翻译优先占据第二行；单行注释模式遵循“原文、罗马音、翻译”的阅读顺序。
  const secondaryText = settings.doubleLine
    ? (translation || romaji || next)
    : (romaji || translation)
  const showSecondary = Boolean(secondaryText)
  const showExtraAnnotation = !settings.doubleLine && Boolean(translation || romaji)

  const beginDrag = (event: ReactPointerEvent) => {
    if (settings.locked || event.button !== 0 || (event.target as HTMLElement).closest('button,input,.dl-settings-panel,.dl-resize')) return
    bridge()?.startDrag({ x: event.screenX, y: event.screenY })
    const move = (nextEvent: PointerEvent) => bridge()?.dragTo({ x: nextEvent.screenX, y: nextEvent.screenY })
    const up = () => {
      bridge()?.endDrag()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  const beginResize = (edge: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw') => (event: ReactPointerEvent) => {
    if (settings.locked) return
    event.stopPropagation()
    bridge()?.startResize({ x: event.screenX, y: event.screenY, edge })
    const move = (nextEvent: PointerEvent) => bridge()?.resizeTo({ x: nextEvent.screenX, y: nextEvent.screenY })
    const up = () => {
      bridge()?.endResize()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
  }

  return (
    <main
      className={`dl-shell ${!settings.locked && (hovered || settingsOpen) ? 'is-active' : ''} ${settings.locked ? 'is-locked' : ''} is-${settings.orientation} ${settings.doubleLine ? 'is-double' : ''}`}
      style={{
        '--font-size': `${settings.fontSize}px`,
        '--lyric-color': color,
        '--lyric-filled-color': filledColor,
      } as CSSProperties}
      onPointerEnter={() => { if (!settings.locked) setHovered(true) }}
      onPointerLeave={() => { setHovered(false); if (!settingsOpen) setSettingsOpen(false) }}
      onPointerMove={event => {
        if (settings.locked) {
          const target = document.elementFromPoint(event.clientX, event.clientY)
          setMousePassthrough(!target?.closest('.dl-unlock'))
          showUnlock()
        } else {
          setMousePassthrough(false)
        }
      }}
      onPointerDown={beginDrag}
    >
      {settings.locked && unlockVisible && (
        <button className="dl-unlock" title="解锁桌面歌词" onPointerEnter={() => setMousePassthrough(false)} onClick={() => setLocked(false)}>
          <LockKeyholeOpen /><span>解锁</span>
        </button>
      )}

      <div className="dl-toolbar" onPointerDown={event => event.stopPropagation()}>
        <button title="上一首" onClick={() => bridge()?.sendControl('prev')}><SkipBack /></button>
        <button title={state.playing ? '暂停' : '播放'} onClick={() => bridge()?.sendControl('toggle')}>{state.playing ? <Pause /> : <Play />}</button>
        <button title="下一首" onClick={() => bridge()?.sendControl('next')}><SkipForward /></button>
        <span className="dl-divider" />
        <button title="减小字体" onClick={() => update({ fontSize: settings.fontSize - 4 })}><Minus /></button>
        <button title="增大字体" onClick={() => update({ fontSize: settings.fontSize + 4 })}><Plus /></button>
        <button className={settings.orientation === 'vertical' ? 'is-selected' : ''} title="横排/竖排" onClick={() => update({ orientation: settings.orientation === 'horizontal' ? 'vertical' : 'horizontal' })}><MoveVertical /></button>
        <button className={settings.doubleLine ? 'is-selected' : ''} title="切换单行/双行" onClick={() => update({ doubleLine: !settings.doubleLine })}><AlignJustify /></button>
        {state.hasTranslation && <button className={settings.translationEnabled ? 'is-selected' : ''} title="翻译歌词" onClick={() => update({ translationEnabled: !settings.translationEnabled })}><Languages /></button>}
        {state.hasRomaji && <button className={settings.romajiEnabled ? 'is-selected' : ''} title="罗马音" onClick={() => update({ romajiEnabled: !settings.romajiEnabled })}><span className="dl-kana">あ</span></button>}
        <button className={settings.traditionalEnabled ? 'is-selected' : ''} title="显示繁体歌词" onClick={() => update({ traditionalEnabled: !settings.traditionalEnabled })}><span className="dl-han">繁</span></button>
        <button className={settingsOpen ? 'is-selected' : ''} title="桌面歌词设置" onClick={toggleSettingsPanel}><Settings /></button>
        <button title="锁定桌面歌词" onClick={() => setLocked(true)}><LockKeyhole /></button>
        <button className="dl-close" title="关闭桌面歌词" onClick={() => bridge()?.sendControl('close')}><X /></button>
      </div>

      <section className="dl-content">
        <div className="dl-primary">
          {lyric?.isInterlude ? (
            <InterludeDots lyric={lyric} playing={state.playing} />
          ) : (
            <LyricText
              text={currentText}
              words={lyric?.words}
              playing={state.playing}
              lineStart={lyric?.lineStart || 0}
              lineDuration={lyric?.lineDuration || 0}
              color={color}
              filledColor={filledColor}
              traditional={settings.traditionalEnabled}
              vertical={settings.orientation === 'vertical'}
            />
          )}
        </div>
        {showSecondary && (
          <div className="dl-secondary">
            {settings.traditionalEnabled ? toTraditional(secondaryText) : secondaryText}
          </div>
        )}
        {showExtraAnnotation && translation && romaji && (
          <div className="dl-tertiary">{settings.traditionalEnabled ? toTraditional(translation) : translation}</div>
        )}
      </section>

      {settingsOpen && (
        <div className="dl-settings-overlay" onPointerDown={event => { event.stopPropagation(); closeSettings() }}>
        <aside className="dl-settings-panel" onPointerDown={event => event.stopPropagation()}>
          <header><Settings /><span>桌面歌词设置</span><button className="dl-settings-close" onClick={closeSettings}><X /></button></header>
          <label className="dl-range-row">
            <span><Type />字体大小</span><b>{settings.fontSize}</b>
            <input type="range" min="26" max="120" step="2" value={settings.fontSize} onChange={event => update({ fontSize: Number(event.target.value) })} />
          </label>
          <div className="dl-setting-title"><Palette />字体颜色</div>
          <div className="dl-colors">
            {COLOR_PRESETS.map(preset => (
              <button key={preset.value} title={preset.label} className={settings.colorMode === preset.value ? 'is-selected' : ''} onClick={() => update({ colorMode: preset.value })}>
                <i style={{ background: preset.color }} />
              </button>
            ))}
          </div>
          <Toggle checked={settings.orientation === 'vertical'} label="竖排显示" onClick={() => update({ orientation: settings.orientation === 'horizontal' ? 'vertical' : 'horizontal' })} />
          <Toggle checked={settings.doubleLine} label="双行显示" onClick={() => update({ doubleLine: !settings.doubleLine })} />
          {state.hasTranslation && <Toggle checked={settings.translationEnabled} label="翻译歌词" onClick={() => update({ translationEnabled: !settings.translationEnabled })} />}
          {state.hasRomaji && <Toggle checked={settings.romajiEnabled} label="罗马音歌词" onClick={() => update({ romajiEnabled: !settings.romajiEnabled })} />}
          <Toggle checked={settings.traditionalEnabled} label="显示繁体歌词" onClick={() => update({ traditionalEnabled: !settings.traditionalEnabled })} />
          <button className="dl-reset" onClick={() => update({ fontSize: 58, colorMode: 'auto', orientation: 'horizontal', doubleLine: false, translationEnabled: false, romajiEnabled: false, traditionalEnabled: false, locked: false })}><RotateCcw />恢复默认</button>
          <footer><LockKeyhole />窗口始终置顶</footer>
        </aside>
        </div>
      )}

      {(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).map(edge => (
        <i key={edge} className={`dl-resize dl-resize-${edge}`} onPointerDown={beginResize(edge)} />
      ))}
    </main>
  )
}
