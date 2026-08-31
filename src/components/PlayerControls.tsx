import { useState, useRef, useEffect } from 'react'
import { Play, Pause, SkipBack, SkipForward, List, Repeat, Repeat1, Shuffle, Volume2, VolumeX, AudioWaveform } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDGLabStatus, getDGLabClient, loadDGLabSettings, DGLAB_SETTINGS_EVENT } from '../plugins/clients/DGLabClient'
import { isPluginEnabled } from '../services/pluginStore'
import {
  loadPlaybackShortcutSettings,
  PLAYBACK_SHORTCUT_SETTINGS_EVENT,
  type PlaybackShortcutSettings,
} from '../services/playbackShortcutSettings'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'
import StemMixerPopover, { type TrackStemControlModel } from './StemMixerPopover'

interface PlayerControlsProps {
  isPlaying: boolean
  currentTime: number
  duration: number
  /** 直播流（Apple 电台等）：显示 LIVE 指示、禁拖动进度 */
  live?: boolean
  volume?: number
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange?: (volume: number) => void
  onPrevious?: () => void
  onNext?: () => void
  onPlaylistClick?: () => void
  accentColor: string
  transitionFromAccentColor?: string
  transitionToAccentColor?: string
  transitionProgress?: number
  playMode?: 'sequential' | 'shuffle' | 'repeat'
  onPlayModeChange?: () => void
  playerTheme?: 'light' | 'dark'
  backgroundEffect?: 'transparent' | 'blur' | 'immersive'
  isTransitioning?: boolean
  isAutoMixTransition?: boolean
  /** AutoMix 增强版（v2）：过渡指示显示「AutoMix 增强版」独立样式（缺省时与历史一致） */
  enhancedAutoMix?: boolean
  /** automix 介入（armed/准备/过渡中）即显示增强版字样（不等过渡动画窗口） */
  enhancedAutoMixActive?: boolean
  transitionStartTime?: number | null
  immersiveTranslation?: string
  immersiveRoman?: string
  showImmersiveTranslation?: boolean
  showImmersiveRoman?: boolean
  stemControl?: TrackStemControlModel
}

function getContrastColor(hexColor: string | null | undefined): string {
  const rgb = parseCssColor(hexColor)
  if (!rgb) return '#ffffff'
  const { r, g, b } = rgb
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  return brightness > 128 ? '#000000' : '#ffffff'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function parseCssColor(color: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!color) return null

  const trimmed = color.trim()
  const rgbMatch = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(trimmed)
  if (rgbMatch) {
    return {
      r: clamp(Math.round(Number(rgbMatch[1])), 0, 255),
      g: clamp(Math.round(Number(rgbMatch[2])), 0, 255),
      b: clamp(Math.round(Number(rgbMatch[3])), 0, 255)
    }
  }

  let hex = trimmed.replace('#', '')
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  }
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16)
  }
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }) {
  const nr = r / 255
  const ng = g / 255
  const nb = b / 255
  const max = Math.max(nr, ng, nb)
  const min = Math.min(nr, ng, nb)
  let h = 0
  let s = 0
  const l = (max + min) / 2

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case nr:
        h = (ng - nb) / d + (ng < nb ? 6 : 0)
        break
      case ng:
        h = (nb - nr) / d + 2
        break
      default:
        h = (nr - ng) / d + 4
        break
    }
    h /= 6
  }

  return { h: h * 360, s, l }
}

function hslToRgb(h: number, s: number, l: number) {
  const hue = (((h % 360) + 360) % 360) / 360
  if (s === 0) {
    const value = Math.round(l * 255)
    return { r: value, g: value, b: value }
  }

  const hueToRgb = (p: number, q: number, t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255)
  }
}

function getAdaptiveProgressColor(accentColor: string, playerTheme: 'light' | 'dark') {
  const rgb = parseCssColor(accentColor)
  if (!rgb) {
    return playerTheme === 'light' ? 'rgb(112, 106, 96)' : 'rgb(216, 212, 202)'
  }

  const hsl = rgbToHsl(rgb)
  const isBlue = hsl.h >= 190 && hsl.h <= 255
  const saturationCeiling = playerTheme === 'light'
    ? (isBlue ? 0.26 : 0.38)
    : (isBlue ? 0.34 : 0.48)
  const lightnessMin = playerTheme === 'light' ? 0.30 : 0.58
  const lightnessMax = playerTheme === 'light' ? 0.48 : 0.76

  const adjusted = hslToRgb(
    hsl.h,
    clamp(hsl.s, 0, saturationCeiling),
    clamp(hsl.l, lightnessMin, lightnessMax)
  )

  return `rgb(${adjusted.r}, ${adjusted.g}, ${adjusted.b})`
}

function mixCssColors(from: string, to: string, progress: number) {
  const fromRgb = parseCssColor(from)
  const toRgb = parseCssColor(to)
  if (!fromRgb || !toRgb) return progress >= 0.5 ? to : from

  const amount = clamp(progress, 0, 1)
  const mixChannel = (start: number, end: number) => Math.round(start + (end - start) * amount)
  return `rgb(${mixChannel(fromRgb.r, toRgb.r)}, ${mixChannel(fromRgb.g, toRgb.g)}, ${mixChannel(fromRgb.b, toRgb.b)})`
}

export default function PlayerControls({
  playMode = 'sequential',
  onPlayModeChange,
  isPlaying,
  currentTime,
  duration,
  live = false,
  volume,
  onVolumeChange,
  onPlayPause,
  onSeek,
  onPrevious,
  onNext,
  onPlaylistClick,
  accentColor,
  transitionFromAccentColor,
  transitionToAccentColor,
  transitionProgress = 0,
  playerTheme = 'dark',
  backgroundEffect = 'blur',
  isTransitioning = false,
  isAutoMixTransition = false,
  enhancedAutoMix = false,
  enhancedAutoMixActive = false,
  transitionStartTime = null,
  immersiveTranslation = '',
  immersiveRoman = '',
  showImmersiveTranslation = false,
  showImmersiveRoman = false,
  stemControl,
}: PlayerControlsProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  // TV 遥控器模式：无鼠标，控件常驻显示（isHovered 视为恒真）。
  // 但手机遥控器连上（光标模式）时恢复真实 hover，让虚拟鼠标驱动展开，与 PC 一致。
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const effectiveHovered = (tvMode && !remoteCursorMode) || isHovered
  // TV 遥控器模式（无远程遥控光标）：药丸常驻但采用紧凑 TV 布局（更小、适配 D-pad 排版）；
  // 手机遥控器连上时恢复 PC 式 hover 展开布局。
  const tvCompact = tvMode && !remoteCursorMode
  const [dragValue, setDragValue] = useState(0)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  // DG-LAB 波形输出启禁（仅连接后显示，最右侧按钮）
  const dglabStatus = useDGLabStatus()
  const [dglabOutputOn, setDglabOutputOn] = useState(() => loadDGLabSettings().outputEnabled)
  useEffect(() => {
    const handler = () => setDglabOutputOn(loadDGLabSettings().outputEnabled)
    window.addEventListener(DGLAB_SETTINGS_EVENT, handler)
    return () => window.removeEventListener(DGLAB_SETTINGS_EVENT, handler)
  }, [])
  const dglabConnected = isPluginEnabled('dglab') && dglabStatus.state === 'bound'
  /** 音量条打开时间（3 秒宽限：打开后短暂移动不因离开大药丸而关闭） */
  const volumeOpenedAtRef = useRef(0)
  /** 音量滑条延迟关闭定时器：离开大药丸先给鼠标留出移到小药丸的时间，小药丸 hover 会取消 */
  const volumeCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isProgressBarExpanded, setIsProgressBarExpanded] = useState(false)
  const [shortcutSettings, setShortcutSettings] = useState(loadPlaybackShortcutSettings)
  const [settingsAccentColor, setSettingsAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [seekFeedback, setSeekFeedback] = useState<{
    direction: 'forward' | 'backward'
    seconds: number
    targetTime: number
  } | null>(null)
  const seekFeedbackRef = useRef<typeof seekFeedback>(null)
  const seekFeedbackTimerRef = useRef<number | null>(null)
  const currentTimeRef = useRef(currentTime)
  const durationRef = useRef(duration)
  const currentVolumeRef = useRef(volume ?? 1)
  const shortcutSettingsRef = useRef(shortcutSettings)
  const onSeekRef = useRef(onSeek)
  const onPlayPauseRef = useRef(onPlayPause)
  const onVolumeChangeRef = useRef(onVolumeChange)

  currentTimeRef.current = currentTime
  durationRef.current = duration
  currentVolumeRef.current = volume ?? 1
  shortcutSettingsRef.current = shortcutSettings
  onSeekRef.current = onSeek
  onPlayPauseRef.current = onPlayPause
  onVolumeChangeRef.current = onVolumeChange

  useEffect(() => {
    const handleSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<PlaybackShortcutSettings>).detail
      setShortcutSettings(detail || loadPlaybackShortcutSettings())
    }
    const handleAccentColorChange = (event: Event) => {
      setSettingsAccentColor((event as CustomEvent<string>).detail || localStorage.getItem('accentColor') || '#3B82F6')
    }
    window.addEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
    window.addEventListener('accentColorChanged', handleAccentColorChange)
    return () => {
      window.removeEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
      window.removeEventListener('accentColorChanged', handleAccentColorChange)
    }
  }, [])

  // 沉浸模式白条设置
  const [showImmersiveBar, setShowImmersiveBar] = useState(() => {
    const saved = localStorage.getItem('showImmersiveBar')
    return saved !== null ? JSON.parse(saved) : true
  })

  // 沉浸模式状态
  const [immersiveTransition, setImmersiveTransition] = useState(false)
  const [immersiveReady, setImmersiveReady] = useState(() => backgroundEffect === 'immersive')
  const [pillExiting, setPillExiting] = useState(false)
  const prevBackgroundEffectRef = useRef(backgroundEffect)
  const immersiveTimerRef = useRef<number | null>(null)
  const pillAutoHideTimerRef = useRef<number | null>(null)
  const pillExitTimerRef = useRef<number | null>(null)

  // 监听 QuickSettings 中白条设置变化
  useEffect(() => {
    const handleImmersiveBarChange = (e: CustomEvent) => {
      setShowImmersiveBar(e.detail)
    }
    window.addEventListener('immersiveBarChanged', handleImmersiveBarChange as EventListener)
    return () => {
      window.removeEventListener('immersiveBarChanged', handleImmersiveBarChange as EventListener)
    }
  }, [])

  // 清除所有沉浸模式定时器的辅助函数
  const clearAllImmersiveTimers = () => {
    if (immersiveTimerRef.current) clearTimeout(immersiveTimerRef.current)
    if (pillExitTimerRef.current) clearTimeout(pillExitTimerRef.current)
  }

  // 检测背景效果从非沉浸切换到沉浸，触发过渡动画
  useEffect(() => {
    const prev = prevBackgroundEffectRef.current
    const curr = backgroundEffect
    prevBackgroundEffectRef.current = curr

    if (curr === 'immersive' && prev !== 'immersive') {
      clearAllImmersiveTimers()
      setImmersiveTransition(true)
      setImmersiveReady(false)
      setPillExiting(false)
      setIsHovered(false)

      // 350ms 后药丸退出完成，显示白条
      immersiveTimerRef.current = window.setTimeout(() => {
        setImmersiveTransition(false)
        setImmersiveReady(true)
        setPillExiting(true)

        // 药丸退出动画 300ms 后，显示白条
        pillExitTimerRef.current = window.setTimeout(() => {
          setPillExiting(false)
        }, 300)
      }, 350)
    } else if (curr !== 'immersive') {
      setImmersiveTransition(false)
      setImmersiveReady(false)
      setPillExiting(false)
      clearAllImmersiveTimers()
    }

    return () => clearAllImmersiveTimers()
  }, [backgroundEffect])

  // 组件卸载时清理所有定时器
  useEffect(() => {
    return () => {
      clearAllImmersiveTimers()
      if (pillAutoHideTimerRef.current) clearTimeout(pillAutoHideTimerRef.current)
    }
  }, [])

  const lastClickTimeRef = useRef(0)
  const progressHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentVolume = volume ?? 1
  const isMuted = currentVolume === 0
  const isImmersive = backgroundEffect === 'immersive'
  const isExpanded = isImmersive ? (effectiveHovered || isDragging) : (!isPlaying || effectiveHovered || isDragging)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null
      const isEditable = Boolean(target?.closest('input, textarea, select, button, [contenteditable="true"]'))
      const settings = shortcutSettingsRef.current
      if (isEditable || !settings.playbackPageEnabled || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (durationRef.current <= 0) return
        e.preventDefault()
        const direction: 'forward' | 'backward' = e.key === 'ArrowRight' ? 'forward' : 'backward'
        const step = direction === 'forward' ? settings.seekForwardSeconds : settings.seekBackwardSeconds
        const activeFeedback = seekFeedbackRef.current
        const baseTime = activeFeedback?.targetTime ?? currentTimeRef.current
        const targetTime = clamp(
          baseTime + (direction === 'forward' ? step : -step),
          0,
          durationRef.current,
        )
        const nextFeedback = {
          direction,
          seconds: activeFeedback?.direction === direction ? activeFeedback.seconds + step : step,
          targetTime,
        }
        seekFeedbackRef.current = nextFeedback
        setSeekFeedback(nextFeedback)
        onSeekRef.current(targetTime)

        if (seekFeedbackTimerRef.current !== null) window.clearTimeout(seekFeedbackTimerRef.current)
        seekFeedbackTimerRef.current = window.setTimeout(() => {
          seekFeedbackRef.current = null
          setSeekFeedback(null)
          seekFeedbackTimerRef.current = null
        }, 1100)
        return
      }

      if ((e.code === 'Space' || e.key === ' ') && settings.spacePlayPauseEnabled) {
        if (e.repeat) return
        e.preventDefault()
        onPlayPauseRef.current()
        return
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const step = 0.05
        const currentVolume = currentVolumeRef.current
        const newVolume = e.key === 'ArrowUp'
          ? Math.min(1, currentVolume + step)
          : Math.max(0, currentVolume - step)
        onVolumeChangeRef.current?.(newVolume)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      if (progressHideTimerRef.current) {
        clearTimeout(progressHideTimerRef.current)
      }
      if (seekFeedbackTimerRef.current !== null) {
        window.clearTimeout(seekFeedbackTimerRef.current)
      }
    }
  }, [])

  const handleVolumeButtonClick = () => {
    const now = Date.now()
    const timeSinceLastClick = now - lastClickTimeRef.current

    if (timeSinceLastClick < 300) {
      onVolumeChange && onVolumeChange(isMuted ? 0.5 : 0)
      setShowVolumeSlider(false)
      lastClickTimeRef.current = 0
      return
    }

    setShowVolumeSlider(prev => {
      const next = !prev
      if (next) {
        volumeOpenedAtRef.current = Date.now()
        if (volumeCloseTimerRef.current !== null) {
          window.clearTimeout(volumeCloseTimerRef.current)
          volumeCloseTimerRef.current = null
        }
      }
      return next
    })
    lastClickTimeRef.current = now
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value)
    setDragValue(value)
  }

  const handleSeekMouseUp = (e: React.MouseEvent<HTMLInputElement>) => {
    const value = Number((e.target as HTMLInputElement).value)
    setIsDragging(false)
    onSeek(value)
  }

  const handleSeekTouchEnd = (e: React.TouchEvent<HTMLInputElement>) => {
    const value = Number((e.target as HTMLInputElement).value)
    setIsDragging(false)
    onSeek(value)
  }

  const handleProgressMouseEnter = () => {
    if (progressHideTimerRef.current) {
      clearTimeout(progressHideTimerRef.current)
      progressHideTimerRef.current = null
    }
    setIsProgressBarExpanded(true)
  }

  const handleProgressMouseLeave = () => {
    if (isDragging) return
    progressHideTimerRef.current = setTimeout(() => {
      setIsProgressBarExpanded(false)
      progressHideTimerRef.current = null
    }, 300)
  }

  const handlePlayerMouseLeave = () => {
    setIsHovered(false)
    if (progressHideTimerRef.current) {
      clearTimeout(progressHideTimerRef.current)
      progressHideTimerRef.current = null
    }
    if (!isDragging) {
      setIsProgressBarExpanded(false)
    }
    // 音量滑条：离开大药丸不立即关闭，给鼠标移到小药丸留出时间；小药丸 hover 会取消定时器
    if (volumeCloseTimerRef.current !== null) {
      window.clearTimeout(volumeCloseTimerRef.current)
      volumeCloseTimerRef.current = null
    }
    volumeCloseTimerRef.current = setTimeout(() => {
      volumeCloseTimerRef.current = null
      setShowVolumeSlider(false)
    }, 800)
  }

  const displayTime = isDragging ? dragValue : currentTime
  // 过渡期间合成 currentTime 可能超过源曲时长（AI 长混音从源曲深处起步）：
  // 显示时长自适应为 max(原时长, 当前时间)，进度条/总时长跟随，不再顶着曲尾不动。
  const effectiveDuration = Math.max(duration, displayTime)
  // 直播流（Apple 电台）：时长恒为 0，进度条不走、总时长显示 LIVE 徽标
  const isLiveStream = Boolean(live)
  const progressPercent = isLiveStream ? 0 : (displayTime / effectiveDuration) * 100
  const iconColor = getContrastColor(accentColor)
  const isLightTheme = playerTheme === 'light'
  const progressAccentColor = isTransitioning && transitionToAccentColor
    ? mixCssColors(transitionFromAccentColor || accentColor, transitionToAccentColor, transitionProgress)
    : accentColor
  const progressFillColor = getAdaptiveProgressColor(progressAccentColor, playerTheme)
  const progressTrackColor = isLightTheme ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.16)'
  const volumeTrackColor = progressTrackColor
  const seekFeedbackProgress = duration > 0 && seekFeedback
    ? clamp((seekFeedback.targetTime / duration) * 100, 0, 100)
    : 0

  const renderSeekFeedback = () => (
    <AnimatePresence>
      {seekFeedback && (
        <motion.div
          key={seekFeedback.direction}
          initial={{ opacity: 0, y: -10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.97 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="fixed left-8 top-20 z-[80] pointer-events-none min-w-44 rounded-full px-5 py-3 backdrop-blur-2xl"
          style={{
            background: playerTheme === 'dark' ? 'rgba(10, 14, 24, 0.74)' : 'rgba(255, 255, 255, 0.76)',
            border: playerTheme === 'dark' ? '1px solid rgba(255,255,255,0.14)' : '1px solid rgba(0,0,0,0.1)',
            boxShadow: playerTheme === 'dark' ? '0 12px 34px rgba(0,0,0,0.32)' : '0 12px 34px rgba(0,0,0,0.14)',
          }}
        >
          <div className="flex items-center justify-center gap-2 text-sm font-bold tracking-wide" style={{ color: settingsAccentColor }}>
            <span>{seekFeedback.direction === 'forward' ? '▶▶' : '◀◀'}</span>
            <span>{seekFeedback.direction === 'forward' ? '+' : '-'}{seekFeedback.seconds}s</span>
          </div>
          <div className="mt-2 h-1 w-full overflow-hidden rounded-full" style={{ backgroundColor: progressTrackColor }}>
            <motion.div
              className="h-full rounded-full"
              animate={{ width: `${seekFeedbackProgress}%` }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              style={{ backgroundColor: progressFillColor }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
  
  // 动画窗口：过渡动画（流光/发光）只在 currentTime 到达 transitionStartTime（=动画起点）
  // 后开始。AI 长混音的音频过渡远早于动画点开始，不加门控会跟着 60s 混音全程亮。
  // transitionStartTime 为 null（普通交叉淡化/gapless）时视为始终在窗口内（v1 行为不变）。
  const inAnimationWindow = transitionStartTime === null || currentTime >= transitionStartTime
  // 检查是否即将过渡：动画窗口内（automix 动画起点）或歌曲自然结束前 5 秒
  const isNearTransition = (isTransitioning && inAnimationWindow) || (duration - currentTime <= 5 && duration - currentTime > 0)
  // 过渡指示：动画窗口内 = AutoMix Enhanced（金色）；介入中（running 未到动画窗口）= AutoMix 正在介入（白色）
  const inTransitionAnimation = isTransitioning && inAnimationWindow
  const showTransitionBadge = inTransitionAnimation || enhancedAutoMixActive
  const badgeIsEnhanced = inTransitionAnimation && enhancedAutoMix
  const transitionLabel = inTransitionAnimation
    ? (enhancedAutoMix ? 'AutoMix Enhanced' : isAutoMixTransition ? 'AutoMix' : '过渡')
    : (enhancedAutoMixActive ? 'AutoMix 正在介入' : '')
  
  // 进度条发光强度
  const glowIntensity = isNearTransition ? 1.5 : 1

  // ---- 进度条 UI（正常模式和沉浸展开共用） ----
  const renderProgressContent = (sliderWidthClass: string, containerClassName: string = '') => (
    <div className={`flex flex-col gap-1 ${containerClassName}`}>
      <div className="flex items-center">
        <span className={`text-xs font-medium min-w-[38px] text-center leading-none ${
          playerTheme === 'dark' ? 'text-white/80' : 'text-black/70'
        }`}>
          {formatTime(displayTime)}
        </span>

        <div className={`relative ${sliderWidthClass} flex items-center`} data-tv-arrows="seek">
          <input
            type="range"
            min="0"
            max={effectiveDuration}
            value={displayTime}
            disabled={isLiveStream}
            onMouseDown={() => setIsDragging(true)}
            onTouchStart={() => setIsDragging(true)}
            onChange={handleSeekChange}
            onMouseUp={handleSeekMouseUp}
            onTouchEnd={handleSeekTouchEnd}
            className={`progress-slider w-full h-1.5 hover:h-2.5 rounded-full appearance-none cursor-pointer transition-all duration-200 ${isLiveStream ? 'opacity-60' : ''}`}
            style={{
              background: `linear-gradient(to right, ${progressFillColor} 0%, ${progressFillColor} ${progressPercent}%, ${progressTrackColor} ${progressPercent}%, ${progressTrackColor} 100%)`,
            }}
          />
        </div>

        <span className={`text-xs font-medium min-w-[38px] text-center leading-none ${
          playerTheme === 'dark' ? 'text-white/80' : 'text-black/70'
        }`}>
          {isLiveStream ? (
            <span className="inline-flex items-center gap-1 font-semibold" style={{ color: progressFillColor }}>
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
              直播
            </span>
          ) : (
            formatTime(effectiveDuration)
          )}
        </span>
      </div>
    </div>
  )

  // ---- 沉浸模式：白条 hover 处理 ----
  const handleImmersiveBarEnter = () => {
    clearAllImmersiveTimers()
    if (pillAutoHideTimerRef.current) {
      clearTimeout(pillAutoHideTimerRef.current)
      pillAutoHideTimerRef.current = null
    }
    setIsHovered(true)
  }

  // ---- 沉浸模式：药丸 hover 处理 ----
  const handleImmersivePillEnter = () => {
    if (pillAutoHideTimerRef.current) {
      clearTimeout(pillAutoHideTimerRef.current)
      pillAutoHideTimerRef.current = null
    }
    setIsHovered(true)
  }

  const handleImmersivePillLeave = () => {
    // 2秒后自动隐藏药丸，显示白条
    pillAutoHideTimerRef.current = window.setTimeout(() => {
      setIsHovered(false)
      pillAutoHideTimerRef.current = null

      // 药丸退出动画 350ms 后，显示白条
      pillExitTimerRef.current = window.setTimeout(() => {
        setPillExiting(false)
      }, 350)
    }, 2000)
  }

  // ---- 沉浸模式渲染：小白条 + 药丸弹出 ----
  const renderImmersiveLayout = () => {
    const inTransition = immersiveTransition && !immersiveReady
    const showPill = effectiveHovered || inTransition || pillExiting
    const secondsUntilTransition = transitionStartTime === null ? Number.POSITIVE_INFINITY : transitionStartTime - currentTime
    const isTransitionBarPreview = !showImmersiveBar && secondsUntilTransition > 0 && secondsUntilTransition <= 2
    const showBar = immersiveReady && !effectiveHovered && !pillExiting && (
      showImmersiveBar || isTransitionBarPreview || isTransitioning
    )

    return (
      <>
        <div className="fixed bottom-0 left-0 right-0 z-50 flex flex-col items-center pointer-events-none">
          <AnimatePresence>
            {(showImmersiveRoman || showImmersiveTranslation) && (
              <motion.div
                key={`${immersiveRoman}-${immersiveTranslation}`}
                initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
                transition={{ duration: 0.36, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-none mb-4 flex max-w-[min(82vw,760px)] flex-col items-center gap-1 text-center"
              >
                {showImmersiveRoman && (
                  <p className={`text-sm font-medium tracking-[0.08em] ${playerTheme === 'dark' ? 'text-white/62 drop-shadow-[0_3px_12px_rgba(0,0,0,0.72)]' : 'text-black/55'}`}>
                    {immersiveRoman}
                  </p>
                )}
                {showImmersiveTranslation && (
                  <p className={`text-base font-medium ${playerTheme === 'dark' ? 'text-white/82 drop-shadow-[0_4px_16px_rgba(0,0,0,0.78)]' : 'text-black/75'}`}>
                    {immersiveTranslation}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 过渡提示 - 药丸上方，流光效果（仅在动画窗口内显示，避免 AI 长混音全程亮） */}
          <AnimatePresence>
            {showTransitionBadge && (
              <motion.div
                key={transitionLabel}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="pointer-events-none mb-2"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span
                  className="text-xs font-medium"
                  style={{
                    color: badgeIsEnhanced ? 'rgba(255,215,0,0.98)' : 'rgba(255,255,255,0.9)',
                    letterSpacing: '0.1em',
                    textShadow: badgeIsEnhanced
                      ? '0 0 20px rgba(255,200,0,0.85), 0 0 40px rgba(255,180,0,0.45), 0 2px 8px rgba(0,0,0,0.5)'
                      : '0 0 20px rgba(255,255,255,0.6), 0 2px 8px rgba(0,0,0,0.5)',
                    animation: 'glow 2s ease-in-out infinite',
                  }}
                >
                  {transitionLabel}
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 药丸播放控件 */}
          <AnimatePresence>
            {showPill && (
              <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8 }}
                className="pointer-events-auto mb-3"
                onMouseEnter={handleImmersivePillEnter}
                onMouseLeave={handleImmersivePillLeave}
              >
                <motion.div
                  initial={{ width: tvCompact ? '480px' : '360px' }}
                  animate={{
                    width: tvCompact ? '480px' : isExpanded ? '640px' : '360px',
                    paddingTop: tvCompact ? '10px' : isExpanded ? '16px' : '12px',
                    paddingBottom: tvCompact ? '10px' : isExpanded ? '16px' : '12px',
                  }}
                  transition={{ duration: 0.35, delay: isExpanded ? 0 : 0.2, ease: [0.32, 0.72, 0, 1] }}
                  className="relative rounded-full backdrop-blur-3xl px-5"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.4) 100%)'
                      : 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.7) 100%)',
                    backdropFilter: 'blur(40px) saturate(180%)',
                    WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                    boxShadow: playerTheme === 'dark'
                      ? `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)`
                      : `0 8px 32px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.1)`,
                  }}
                >
                  <div className="flex items-center justify-center">
                    <motion.div
                      animate={{ scale: 1, opacity: isExpanded ? 1 : 0.7 }}
                      transition={{ duration: 0.3, delay: isExpanded ? 0.15 : 0.15, ease: 'easeInOut' }}
                    >
                      {renderProgressContent(tvCompact ? 'w-40' : 'w-56', tvCompact ? 'gap-1.5' : 'gap-3')}
                    </motion.div>
                  </div>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ opacity: 0, x: 150 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 150 }}
                        transition={{
                          opacity: { duration: 0.22, delay: isExpanded ? 0.25 : 0, ease: 'easeOut' },
                          x: { duration: 0.28, delay: isExpanded ? 0.25 : 0, ease: [0.32, 0.72, 0, 1] },
                        }}
                        className={`absolute left-5 top-1/2 -translate-y-1/2 flex items-center ${tvCompact ? 'gap-1.5' : 'gap-2'}`}
                      >
                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={onPrevious} disabled={!onPrevious}
                          className={`${tvCompact ? 'p-1.5' : 'p-2'} rounded-full transition-colors disabled:opacity-30 ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                          <SkipBack className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </motion.button>
                        <motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={onPlayPause}
                          className="p-2.5 rounded-full transition-all" style={{ backgroundColor: accentColor }}>
                          {isPlaying ? <Pause className="w-4 h-4" style={{ color: iconColor }} /> : <Play className="w-4 h-4 ml-0.5" style={{ color: iconColor }} />}
                        </motion.button>
                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={onNext} disabled={!onNext}
                          className={`p-2 rounded-full transition-colors disabled:opacity-30 ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                          <SkipForward className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </motion.button>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <AnimatePresence>
                    {isExpanded && (
                      <motion.div
                        initial={{ opacity: 0, x: -150 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -150 }}
                        transition={{
                          opacity: { duration: 0.22, delay: isExpanded ? 0.25 : 0, ease: 'easeOut' },
                          x: { duration: 0.28, delay: isExpanded ? 0.25 : 0, ease: [0.32, 0.72, 0, 1] },
                        }}
                        className={`absolute right-5 top-1/2 -translate-y-1/2 flex items-center ${tvCompact ? 'gap-1.5' : 'gap-2'}`}
                      >
                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={onPlaylistClick}
                          className={`${tvCompact ? 'p-1.5' : 'p-2'} rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                          <List className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                        </motion.button>
                        {stemControl && (
                          <StemMixerPopover control={stemControl} accentColor={accentColor} theme={playerTheme} />
                        )}
                        <div className="relative flex items-center">
                          <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={handleVolumeButtonClick}
                            className={`p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                            {isMuted ? <VolumeX className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} /> : <Volume2 className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />}
                          </motion.button>
                          <AnimatePresence>
                            {showVolumeSlider && (
                              <motion.div initial={{ opacity: 0, y: 8, scale: 0.95 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.95 }} transition={{ duration: 0.15 }}
                                className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 rounded-full backdrop-blur-3xl whitespace-nowrap"
                                data-tv-arrows="volume"
                                onMouseEnter={() => {
                                  if (volumeCloseTimerRef.current !== null) {
                                    window.clearTimeout(volumeCloseTimerRef.current)
                                    volumeCloseTimerRef.current = null
                                  }
                                }}
                                onMouseLeave={() => {
                                  if (volumeCloseTimerRef.current !== null) {
                                    window.clearTimeout(volumeCloseTimerRef.current)
                                    volumeCloseTimerRef.current = null
                                  }
                                  volumeCloseTimerRef.current = setTimeout(() => {
                                    volumeCloseTimerRef.current = null
                                    setShowVolumeSlider(false)
                                  }, 800)
                                }}
                                style={{
                                  background: playerTheme === 'dark'
                                    ? 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.4) 100%)'
                                    : 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.7) 100%)',
                                  backdropFilter: 'blur(40px) saturate(180%)',
                                  WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                                  boxShadow: playerTheme === 'dark'
                                    ? `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1), 0 0 60px ${accentColor}20`
                                    : `0 8px 32px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.1), 0 0 60px ${accentColor}30`,
                                }}>
                                <input type="range" min="0" max="1" step="0.01" value={currentVolume} onChange={(e) => onVolumeChange && onVolumeChange(parseFloat(e.target.value))}
                                  className="volume-slider-horizontal relative z-10 w-20 h-1.5 rounded-full"
                                  style={{
                                    background: `linear-gradient(to right, ${progressFillColor} 0%, ${progressFillColor} ${currentVolume * 100}%, ${volumeTrackColor} ${currentVolume * 100}%, ${volumeTrackColor} 100%)`,
                                    boxShadow: playerTheme === 'dark'
                                      ? 'inset 0 1px 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.22)'
                                      : 'inset 0 1px 1px rgba(255,255,255,0.52), 0 1px 4px rgba(0,0,0,0.1)',
                                  }} />
                                <span className="relative z-10 text-xs font-semibold" style={{
                                  color: playerTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)',
                                  textShadow: playerTheme === 'dark' ? '0 1px 2px rgba(0,0,0,0.45)' : '0 1px 1px rgba(255,255,255,0.45)',
                                }}>{Math.round(currentVolume * 100)}%</span>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={onPlayModeChange}
                          className={`p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                          {playMode === 'shuffle' && <Shuffle className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />}
                          {playMode === 'repeat' && <Repeat1 className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />}
                          {playMode === 'sequential' && <Repeat className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/35'}`} />}
                        </motion.button>
                        {dglabConnected && (
                          <motion.button
                            whileHover={{ scale: 1.1 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={() => { const next = !dglabOutputOn; setDglabOutputOn(next); getDGLabClient().setOutputEnabled(next) }}
                            className={`relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                            title={dglabOutputOn ? '暂停波形输出（不断开连接）' : '恢复波形输出'}
                          >
                            <AudioWaveform className={`w-4 h-4 ${dglabOutputOn ? 'text-amber-300' : 'text-white/25'}`} />
                            <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full" style={{ background: dglabOutputOn ? '#FFE89C' : '#64748b' }} />
                          </motion.button>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 小白条 */}
          <AnimatePresence>
            {showBar && (
              <motion.div
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 12, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="pointer-events-auto cursor-pointer mb-6"
                onMouseEnter={handleImmersiveBarEnter}
              >
                <div
                  className="w-96 h-1.5 rounded-full"
                  style={{
                    background: 'rgba(255, 255, 255, 0.4)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
                  }}
                />
              </motion.div>
            )}
          </AnimatePresence>

          {/* 隐藏小白条只隐藏视觉元素，底部热区始终保留。 */}
          {!showPill && !showBar && (
            <div
              className="pointer-events-auto fixed bottom-0 left-1/2 h-12 w-[28rem] -translate-x-1/2"
              onMouseEnter={handleImmersiveBarEnter}
              aria-hidden="true"
            />
          )}
        </div>
      </>
    )
  }

  // 沉浸模式：使用独立的白条+弹出药丸布局
  if (isImmersive) {
    return (
      <>
        <style>{`
          .volume-slider-horizontal {
            -webkit-appearance: none;
            appearance: none;
            background: transparent;
            border: none;
            outline: none;
            cursor: pointer;
          }
          .volume-slider-horizontal::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 0;
            height: 0;
            background: transparent;
            border-radius: 50%;
            box-shadow: none;
            border: 0;
          }
          .volume-slider-horizontal::-moz-range-thumb {
            width: 0;
            height: 0;
            background: transparent;
            border-radius: 50%;
            box-shadow: none;
            border: 0;
          }
          .volume-slider-horizontal::-ms-thumb {
            width: 0;
            height: 0;
            background: transparent;
            border-radius: 50%;
            box-shadow: none;
            border: 0;
          }
          .volume-slider-horizontal::-webkit-slider-runnable-track {
            background: transparent;
            border: none;
          }
          .volume-slider-horizontal::-moz-range-track {
            background: transparent;
            border: none;
          }
          .volume-slider-horizontal::-ms-track {
            background: transparent;
            border: none;
            color: transparent;
          }
        `}</style>
        {renderSeekFeedback()}
        {renderImmersiveLayout()}
      </>
    )
  }

  return (
    <>
      <style>{`
        .volume-slider-horizontal {
          -webkit-appearance: none;
          appearance: none;
          background: transparent;
          border: none;
          outline: none;
          cursor: pointer;
        }
        .volume-slider-horizontal::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 0;
          height: 0;
          background: transparent;
          border-radius: 50%;
          box-shadow: none;
          border: 0;
        }
        .volume-slider-horizontal::-moz-range-thumb {
          width: 0;
          height: 0;
          background: transparent;
          border-radius: 50%;
          box-shadow: none;
          border: 0;
        }
        .volume-slider-horizontal::-ms-thumb {
          width: 0;
          height: 0;
          background: transparent;
          border-radius: 50%;
          box-shadow: none;
          border: 0;
        }
        .volume-slider-horizontal::-webkit-slider-runnable-track {
          background: transparent;
          border: none;
        }
        .volume-slider-horizontal::-moz-range-track {
          background: transparent;
          border: none;
        }
        .volume-slider-horizontal::-ms-track {
          background: transparent;
          border: none;
          color: transparent;
        }
      `}</style>

      {renderSeekFeedback()}

      <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center">
        {/* 过渡提示 - 药丸上方，流光效果（仅在动画窗口内显示） */}
        <AnimatePresence>
          {isTransitioning && inAnimationWindow && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="pointer-events-none mb-2"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <span
                className="text-xs font-medium"
                style={{
                  color: 'rgba(255,255,255,0.9)',
                  letterSpacing: '0.1em',
                  textShadow: '0 0 20px rgba(255,255,255,0.6), 0 2px 8px rgba(0,0,0,0.5)',
                  animation: 'glow 2s ease-in-out infinite',
                }}
              >
                {transitionLabel}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <motion.div
          initial={{ width: '360px' }}
          animate={{
            width: isExpanded ? '640px' : '360px',
            paddingTop: isExpanded ? '16px' : '12px',
            paddingBottom: isExpanded ? '16px' : '12px',
          }}
          transition={{ 
            duration: 0.35,
            delay: isExpanded ? 0 : 0.2,
            ease: [0.32, 0.72, 0, 1]
          }}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={handlePlayerMouseLeave}
          className="relative rounded-full backdrop-blur-3xl px-5"
          style={{
            background: playerTheme === 'dark'
              ? backgroundEffect === 'transparent'
                ? 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 100%)'
                : 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.3) 100%)'
              : backgroundEffect === 'transparent'
              ? 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.05) 100%)'
              : 'linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.6) 100%)',
            boxShadow: playerTheme === 'dark'
              ? `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)`
              : `0 8px 32px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.1)`,
          }}
        >
          {/* 进度条区域 */}
          <div className="flex items-center justify-center">
            <motion.div
              animate={{
                scale: 1,
                opacity: isExpanded ? 1 : 0.7
              }}
              transition={{ 
                duration: 0.3,
                delay: isExpanded ? 0.15 : 0.15,
                ease: "easeInOut"
              }}
            >
              {renderProgressContent('w-56', 'gap-3')}
            </motion.div>
          </div>

          {/* 左侧控制按钮 */}
          <AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={{ opacity: 0, x: 150 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 150 }}
                transition={{
                  opacity: { duration: 0.22, delay: isExpanded ? 0.25 : 0, ease: "easeOut" },
                  x: { duration: 0.28, delay: isExpanded ? 0.25 : 0, ease: [0.32, 0.72, 0, 1] },
                }}
                className="absolute left-5 top-1/2 -translate-y-1/2 flex items-center gap-2"
              >
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onPrevious}
                  disabled={!onPrevious}
                  className={`p-2 rounded-full transition-colors disabled:opacity-30 ${
                    playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  <SkipBack className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onPlayPause}
                  className="p-2.5 rounded-full transition-all"
                  style={{
                    backgroundColor: accentColor,
                  }}
                >
                  {isPlaying ? (
                    <Pause className="w-4 h-4" style={{ color: iconColor }} />
                  ) : (
                    <Play className="w-4 h-4 ml-0.5" style={{ color: iconColor }} />
                  )}
                </motion.button>

                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onNext}
                  disabled={!onNext}
                  className={`p-2 rounded-full transition-colors disabled:opacity-30 ${
                    playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  <SkipForward className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                </motion.button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 右侧功能按钮 */}
          <AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={{ opacity: 0, x: -150 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -150 }}
                transition={{
                  opacity: { duration: 0.22, delay: isExpanded ? 0.25 : 0, ease: "easeOut" },
                  x: { duration: 0.28, delay: isExpanded ? 0.25 : 0, ease: [0.32, 0.72, 0, 1] },
                }}
                className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-2"
              >
                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onPlaylistClick}
                  className={`p-2 rounded-full transition-colors ${
                    playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  <List className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                </motion.button>

                {stemControl && (
                  <StemMixerPopover control={stemControl} accentColor={accentColor} theme={playerTheme} />
                )}

                {/* 音量控制区域 */}
                <div className="relative flex items-center">
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={handleVolumeButtonClick}
                    className={`p-2 rounded-full transition-colors ${
                      playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                    }`}
                  >
                    {isMuted ? (
                      <VolumeX className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                    ) : (
                      <Volume2 className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                    )}
                  </motion.button>

                  <AnimatePresence>
                    {showVolumeSlider && (
                      <motion.div
                        initial={{ opacity: 0, y: 8, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 8, scale: 0.95 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 flex items-center gap-2 px-3 py-2 rounded-full backdrop-blur-3xl whitespace-nowrap"
                        data-tv-arrows="volume"
                        style={{
                          background: playerTheme === 'dark'
                            ? backgroundEffect === 'transparent'
                              ? 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 100%)'
                              : 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.3) 100%)'
                            : backgroundEffect === 'transparent'
                            ? 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.05) 100%)'
                            : 'linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.6) 100%)',
                          backdropFilter: 'blur(40px) saturate(180%)',
                          WebkitBackdropFilter: 'blur(40px) saturate(180%)',
                          boxShadow: playerTheme === 'dark'
                            ? `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1), 0 0 60px ${accentColor}20`
                            : `0 8px 32px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.1), 0 0 60px ${accentColor}30`,
                        }}
                      >
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={currentVolume}
                          onChange={(e) => onVolumeChange && onVolumeChange(parseFloat(e.target.value))}
                          className="volume-slider-horizontal relative z-10 w-20 h-1.5 rounded-full"
                          style={{
                            background: `linear-gradient(to right, ${progressFillColor} 0%, ${progressFillColor} ${currentVolume * 100}%, ${volumeTrackColor} ${currentVolume * 100}%, ${volumeTrackColor} 100%)`,
                            boxShadow: playerTheme === 'dark'
                              ? 'inset 0 1px 1px rgba(255,255,255,0.2), 0 1px 4px rgba(0,0,0,0.22)'
                              : 'inset 0 1px 1px rgba(255,255,255,0.52), 0 1px 4px rgba(0,0,0,0.1)',
                          }}
                        />
                        <span
                          className="relative z-10 text-xs font-semibold"
                          style={{
                            color: playerTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)',
                            textShadow: playerTheme === 'dark' ? '0 1px 2px rgba(0,0,0,0.45)' : '0 1px 1px rgba(255,255,255,0.45)',
                          }}
                        >
                          {Math.round(currentVolume * 100)}%
                        </span>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <motion.button
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={onPlayModeChange}
                  className={`p-2 rounded-full transition-colors ${
                    playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  {playMode === 'shuffle' && <Shuffle className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />}
                  {playMode === 'repeat' && <Repeat1 className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />}
                  {playMode === 'sequential' && <Repeat className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/35'}`} />}
                </motion.button>
                {dglabConnected && (
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => { const next = !dglabOutputOn; setDglabOutputOn(next); getDGLabClient().setOutputEnabled(next) }}
                    className={`relative p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                    title={dglabOutputOn ? '暂停波形输出（不断开连接）' : '恢复波形输出'}
                  >
                    <AudioWaveform className={`w-4 h-4 ${dglabOutputOn ? 'text-amber-300' : 'text-white/25'}`} />
                    <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full" style={{ background: dglabOutputOn ? '#FFE89C' : '#64748b' }} />
                  </motion.button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </>
  )
}
