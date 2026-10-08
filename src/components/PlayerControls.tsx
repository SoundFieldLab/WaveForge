import { useState, useRef, useEffect } from 'react'
import { Play, Pause, SkipBack, SkipForward, List, Repeat, Repeat1, Shuffle, Volume2, VolumeX, AudioWaveform, Crown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useDGLabStatus, getDGLabClient, loadDGLabSettings, DGLAB_SETTINGS_EVENT } from '../plugins/clients/DGLabClient'
import { isPluginEnabled } from '../services/pluginStore'
import {
  loadPlaybackShortcutSettings,
  PLAYBACK_SHORTCUT_SETTINGS_EVENT,
  type PlaybackShortcutSettings,
} from '../services/playbackShortcutSettings'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  getPlatformQualityPreference,
  getPlatformSvipState,
  getPlatformVipState,
  getQualityOptions,
  getQualityTier,
  isVipOnlyResolvedQuality,
  loadAudioQualitySettings,
  resolvedQualityDisplayName,
  resolvedQualityShortLabel,
  saveAudioQualitySettings,
  type AudioQualitySettings,
  type QualityOptionValue,
} from '../services/audioQualitySettings'
import { getLastResolvedQuality } from '../services/musicApi'
import { getCrossFillSource, useCrossFillVersion } from '../services/crossFillRegistry'
import type { MusicPlatform } from '../services/platforms'
import { getApiBase } from '../services/apiConfig'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'
import { AUTOMIX_HUD_GOLD } from './AutomixHudBadge'

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
  backgroundEffect?: 'transparent' | 'blur' | 'immersive' | 'modern'
  isTransitioning?: boolean
  isAutoMixTransition?: boolean
  /** AutoMix Pro（v2）：过渡指示显示「AutoMix Pro」（缺省时与历史一致） */
  enhancedAutoMix?: boolean
  /** automix 介入（armed/准备/过渡中）即显示 Pro 字样（不等过渡动画窗口） */
  enhancedAutoMixActive?: boolean
  /** 增强渲染的引擎名（'AutoMix Pro' / 'AutoMix Enhanced'）；缺省按 Pro 显示 */
  transitionEngineLabel?: string
  transitionStartTime?: number | null
  immersiveTranslation?: string
  immersiveRoman?: string
  showImmersiveTranslation?: boolean
  showImmersiveRoman?: boolean
  /** 音质快捷切换：当前歌曲平台（提供且开关开启时显示音质按钮） */
  songPlatform?: MusicPlatform
  /** 音质快捷切换：当前歌曲 mid/id（QQ 用于拉取"这首歌实际支持哪些音质"列表） */
  songId?: string | number
  /** 音质快捷切换开关（快捷设置 → 外观；默认开，关闭后不渲染按钮） */
  qualityQuickSwitchEnabled?: boolean
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

const ENGINE_LABEL_APPEAR_DELAY_MS = 160
const ENGINE_LABEL_MIN_VISIBLE_MS = 1400

/**
 * AutoMix 引擎名（AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless）的稳定化：
 * - 出现要求条件持续 APPEAR_DELAY 才亮，出现后至少保持 MIN_VISIBLE —— 过渡状态机
 *   在 armed / running / 视觉窗口之间的瞬时抖动不会再让提示闪进闪出（用户看到的「抽风」）；
 * - 可见期间锁定文案：引擎名在过渡中切换（如 Enhanced 与 Gapless 交替）不影响已显示的字。
 */
function useStableEngineLabel(active: boolean, label: string) {
  const [visible, setVisible] = useState(false)
  const [lockedText, setLockedText] = useState('')
  const visibleRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const shownAtRef = useRef(0)
  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    if (active) {
      if (visibleRef.current) return clearTimer
      clearTimer()
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        visibleRef.current = true
        shownAtRef.current = Date.now()
        setVisible(true)
      }, ENGINE_LABEL_APPEAR_DELAY_MS)
      return clearTimer
    }
    if (!visibleRef.current) return clearTimer
    const remaining = ENGINE_LABEL_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current)
    clearTimer()
    if (remaining <= 0) {
      visibleRef.current = false
      setVisible(false)
    } else {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        visibleRef.current = false
        setVisible(false)
      }, remaining)
    }
    return clearTimer
  }, [active])
  useEffect(() => {
    if (visible) setLockedText(label)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])
  return { visible, text: visible ? (lockedText || label) : label }
}

/**
 * 引擎名徽标：显示在小白条上方（悬浮、不进文档流，不顶动条体）。
 * 配色按引擎档位区分（用户定制）：
 *   · Gapless / AutoMix 标准 → 白色（可读性投影，无辉光层）
 *   · AutoMix Pro            → 粉色 + 粉色辉光呼吸
 *   · AutoMix Enhanced       → 金色 + 金色辉光呼吸
 * 辉光实现：**强静态 text-shadow（三层）+ 单节点 opacity 呼吸**——不新增模糊图层。
 * 历史教训（2026-10-05 用户反馈「进入过渡/切到第二首各有一下卡顿」）：上一版用两层
 * blur 副本做辉光，而标签显隐的时机恰是过渡的两个交界瞬间，新增图层会在这些时刻触发
 * 整页重新合成 → 卡顿。静态 text-shadow 光栅化一次，呼吸只动 opacity，零额外图层。
 * 结构：外层只负责显隐（inline opacity + transition），内层负责呼吸（动画只作用于内层）。
 * 组件常驻挂载，只切换 opacity，避免条件挂载的重新淡入造成闪动。
 */
const AUTOMIX_PRO_PINK = '#FF6EC9'

function AutomixEngineLabel({ visible, text, tone, className = '' }: { visible: boolean; text: string; tone: 'dark' | 'light'; className?: string }) {
  const isPro = text.includes('Pro')
  const isEnhanced = text.includes('Enhanced')
  const glowColor = isPro ? AUTOMIX_PRO_PINK : isEnhanced ? AUTOMIX_HUD_GOLD : null
  const baseColor = glowColor ?? (tone === 'dark' ? 'rgba(255,255,255,0.94)' : 'rgba(15,18,26,0.88)')
  const textShadow = glowColor
    ? `0 0 10px ${glowColor}d9, 0 0 24px ${glowColor}80, 0 0 44px ${glowColor}59, 0 2px 8px rgba(0,0,0,0.65)`
    : tone === 'dark' ? '0 2px 10px rgba(0,0,0,0.65)' : '0 1px 6px rgba(255,255,255,0.55)'
  return (
    <span
      aria-hidden={!visible}
      className={`pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap text-xs font-medium leading-none ${className}`}
      style={{
        opacity: visible ? 1 : 0,
        transition: 'opacity 0.28s ease',
      }}
    >
      <span
        className="block"
        style={{
          color: baseColor,
          letterSpacing: '0.12em',
          textShadow,
          // 呼吸只作用于本层：动画激活时覆盖本层 opacity，不影响外层显隐
          ...(glowColor
            ? {
                animation: 'automixGlowBreathe 3.2s ease-in-out infinite',
                animationPlayState: visible ? 'running' : 'paused',
              }
            : {}),
        }}
      >
        {text}
      </span>
    </span>
  )
}

/**
 * 播放条音质快捷切换：显示当前平台偏好音质的短标签（如 标准/高品质/无损/杜比），
 * 点击弹出档位列表直接切换。QQ 平台弹层会拉取"这首歌实际支持哪些音质"（歌曲详情
 * qualityLevels），支持的档位可选；平台报告但确实没有取流实现的档位（Hi-Res/杜比）置灰标注
 * 「暂未支持」——AAC 三档（192k/96k/48k，C600/C400/C200 前缀）已实现取流，可选。
 * 设置写入走 saveAudioQualitySettings（全端同键同事件，App 侧监听后失效预载缓存；
 * 新音质随新的播放链接生效）。默认开启，可在 快捷设置 → 外观 → 音质快捷切换 关闭。
 */
type QualityMenuEntry = {
  key: string
  label: string
  /** null = 平台报告该档存在、但当前取流管线暂未支持 */
  value: QualityOptionValue | null
  requiresVip?: boolean
  /** 会员档位：vip=绿钻，svip=超级会员（与官方客户端两级标注一致） */
  tier?: 'vip' | 'svip'
}

/** QQ 歌曲详情 qualityLevels 的 size_* 键 → 我们已实现的取流档位（AAC 前缀映射已实测校准）。 */
const QQ_QUALITY_LEVEL_TO_PREFERENCE: Record<string, QualityOptionValue> = {
  size_flac: 'lossless',
  size_320mp3: 'high',
  size_192aac: '192aac',
  size_128mp3: 'standard',
  size_96aac: '96aac',
  size_48aac: '48aac',
  // 超级会员高端档：官方逐曲档位（独立音轨，文件名前缀见服务端 QQ_PREMIUM_TIERS）
  size_dolby: 'dolby',
  size_master: 'master',
  size_atmos2: 'atmos2',
}

/** 服务端「实际解析档」原始值 → 本曲 qualityLevels 的 size_* 键：元数据偶发漏档
 *  （size_*=0 但 vkey 实际能出流）时，把实际在播档补回弹层列表用。 */
const QQ_RESOLVED_RAW_TO_LEVEL_KEY: Record<string, string> = {
  flac: 'size_flac',
  '320': 'size_320mp3',
  '192aac': 'size_192aac',
  '128': 'size_128mp3',
  '96aac': 'size_96aac',
  m4a: 'size_96aac',
  '48aac': 'size_48aac',
  dolby: 'size_dolby',
  master: 'size_master',
  atmos2: 'size_atmos2',
}

/** 已有取流实现的逐曲档位（列表只显示这些）：SQ/HQ/标准/流畅/省流 + 臻品母带4.0。
 *  Hi-Res / 杜比全景声 / 臻品音质2.0 / NAC 暂未打通，按"支持啥显示啥"的原则不列。 */
const QQ_IMPLEMENTED_LEVEL_KEYS = new Set(['size_master', 'size_flac', 'size_320mp3', 'size_192aac', 'size_128mp3', 'size_96aac', 'size_48aac'])

/** 本曲档位列表的码率序（高→低），与服务端 sort 一致（NAC 76k 位于 96k 与 48k 之间）。 */
const QQ_LEVEL_SIZE_ORDER = ['size_master', 'size_atmos2', 'size_hires', 'size_dolby', 'size_flac', 'size_320mp3', 'size_192aac', 'size_128mp3', 'size_96aac', 'size_nac', 'size_48aac']

/** QQ 本曲可用音质（qualityLevels）的模块级缓存：切歌即预取，弹层打开时直接命中，
 *  不再出现「先显示通用档位列表、拉到本曲详情后再换成本曲列表」的闪现。 */
type QualityLevelEntry = { key: string; label: string }
const qqSongLevelsCache = new Map<string, { levels: QualityLevelEntry[] | null; at: number }>()
const QQ_SONG_LEVELS_TTL = 30 * 60 * 1000

async function fetchQQSongLevels(songId: string | number, signal?: AbortSignal): Promise<QualityLevelEntry[] | null> {
  const res = await fetch(
    `${getApiBase()}/qq/song/detail?mid=${encodeURIComponent(String(songId))}`,
    { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(6000)]) },
  )
  const data = await res.json().catch(() => null)
  const levels = data?.song?.qualityLevels
  return Array.isArray(levels) && levels.length > 0
    ? levels.map((level: { key: string; label?: string }) => ({ key: String(level.key), label: String(level.label || level.key) }))
    : null
}

/** 偏好档 → 本曲 qualityLevels 的 size_* 键：手动选择的档位不在本曲元数据列表里时
 *  （服务端会自动回落到本曲可播的最近一档），把它补进列表保持选中态可见。 */
const QQ_PREFERENCE_TO_LEVEL_KEY: Partial<Record<QualityOptionValue, string>> = {
  lossless: 'size_flac',
  high: 'size_320mp3',
  '192aac': 'size_192aac',
  standard: 'size_128mp3',
  '96aac': 'size_96aac',
  '48aac': 'size_48aac',
}

function QualityQuickSwitch({
  platform,
  songId,
  playerTheme,
  accentColor,
  compact = false,
}: {
  platform: MusicPlatform
  songId?: string | number
  playerTheme: 'light' | 'dark'
  accentColor: string
  compact?: boolean
}) {
  const [, forceQualityRefresh] = useState(0)
  const [menuOpen, setMenuOpen] = useState(false)
  const [songLevels, setSongLevels] = useState<QualityLevelEntry[] | null>(null)
  const [levelsLoading, setLevelsLoading] = useState(false)
  // 补源分流（音质与供源平台绑定）：这首歌若正由其它平台供源（补源），音质档位/偏好按
  // 供源平台读——汽水歌借 QQ 音源时，弹层展示和保存的都是 QQ 的档位表。
  useCrossFillVersion()
  const crossFillSource = getCrossFillSource({ platform, id: songId })
  const qualityPlatform: MusicPlatform = crossFillSource?.platform || platform
  const qualitySongId: string | number | undefined = crossFillSource?.carrierId
    ? (qualityPlatform === 'qq' && crossFillSource.carrierId.length === 14 ? crossFillSource.carrierId : crossFillSource.carrierId)
    : songId
  useEffect(() => {
    const handleAudioQualityChange = () => forceQualityRefresh(value => value + 1)
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
    // 会员状态随登录/登出变化（qq_vip / netease_vip / soda_entitlement 在登录链路落盘）：
    // 音质弹层的金字/皇冠规则依赖它，auth 事件驱动一次重渲染。
    const handleAuthChange = () => forceQualityRefresh(value => value + 1)
    window.addEventListener('waveforge-auth-changed', handleAuthChange)
    return () => {
      window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
      window.removeEventListener('waveforge-auth-changed', handleAuthChange)
    }
  }, [])

  // 本曲音质：切歌时预取（不等弹层打开），弹层打开时同步读缓存 → 不再闪现通用列表。
  useEffect(() => {
    if (qualityPlatform !== 'qq' || qualitySongId == null) {
      setSongLevels(null)
      setLevelsLoading(false)
      return
    }
    const key = String(qualitySongId)
    const cached = qqSongLevelsCache.get(key)
    if (cached && Date.now() - cached.at < QQ_SONG_LEVELS_TTL) {
      setSongLevels(cached.levels)
      setLevelsLoading(false)
      return
    }
    const controller = new AbortController()
    setLevelsLoading(true)
    void fetchQQSongLevels(qualitySongId, controller.signal)
      .then(levels => {
        if (controller.signal.aborted) return
        qqSongLevelsCache.set(key, { levels, at: Date.now() })
        // 缓存上限：30 条足够覆盖近期切歌（超出丢最旧）
        while (qqSongLevelsCache.size > 30) {
          const oldest = qqSongLevelsCache.keys().next().value
          if (oldest === undefined) break
          qqSongLevelsCache.delete(oldest)
        }
        setSongLevels(levels)
        setLevelsLoading(false)
      })
      .catch(() => {
        if (controller.signal.aborted) return
        setSongLevels(null)
        setLevelsLoading(false)
      })
    return () => controller.abort()
  }, [platform, songId])

  const isDark = playerTheme === 'dark'
  const options = getQualityOptions(qualityPlatform)
  const preference = getPlatformQualityPreference(qualityPlatform)
  const current = options.find(option => option.value === preference) ?? options[0]
  // QQ 本曲档位在途：先只出「自动」+ 读取提示，避免拿通用列表顶上后又切换（用户看到的"闪一下"）。
  const qqLevelsPending = qualityPlatform === 'qq' && qualitySongId != null && !songLevels && levelsLoading

  // 会员检测：读各平台登录链路维护的会员状态（qq_vip / netease_vip / soda_entitlement，
  // 登录与启动恢复时刷新，auth 事件驱动重渲染）——会员档一律金字，非会员才加皇冠。
  // 供源平台的会员状态才是这根弹层该用的（借 QQ 音源就看 QQ 权益）。
  const isVipUser = getPlatformVipState(qualityPlatform)
  const isSvipUser = getPlatformSvipState(qualityPlatform)

  // 「自动（…）」括号与徽标显示当前实际档位短名：取本曲最近一次播放链接解析回的真实档位
  // （按歌曲记录，无记录则回落偏好档短名）。此前按平台记录，换歌后会残留上一首的档位。
  const resolvedQuality = getLastResolvedQuality(qualityPlatform, qualitySongId)
  const autoLabel = resolvedQuality ? `自动（${resolvedQualityShortLabel(qualityPlatform, resolvedQuality)}）` : '自动'
  // 实际在播的是会员档（如 SQ）→「自动」行按会员样式渲染（金字；非会员加皇冠）
  const autoRequiresVip = resolvedQuality ? isVipOnlyResolvedQuality(qualityPlatform, resolvedQuality) : false
  // 徽标口径对齐 QQ 官方 bar：显示实际在播档位短名（手动档回落时也如实反映），无记录时显示偏好档
  const badgeLabel = resolvedQuality
    ? resolvedQualityShortLabel(qualityPlatform, resolvedQuality)
    : current.shortLabel

  // 本曲列表 + 两类补挂：①实际在播档（元数据偶发漏档，服务端已按 vkey 事实解析）；
  // ②手动偏好档（跨曲持久，服务端自动回落到本曲可播的最近一档，选中态不能丢）。
  // 均按码率序插回，保证列表顺序稳定。
  const resolvedLevelKey = qualityPlatform === 'qq' && resolvedQuality
    ? QQ_RESOLVED_RAW_TO_LEVEL_KEY[resolvedQuality]
    : undefined
  const resolvedPreferenceValue = resolvedLevelKey
    ? QQ_QUALITY_LEVEL_TO_PREFERENCE[resolvedLevelKey]
    : undefined
  const songLevelEntries: QualityMenuEntry[] | null = songLevels && qualityPlatform === 'qq'
    ? (() => {
        const levels = [...songLevels]
        if (resolvedLevelKey && resolvedPreferenceValue && resolvedQuality
          && !levels.some(level => level.key === resolvedLevelKey)) {
          levels.push({ key: resolvedLevelKey, label: resolvedQualityDisplayName(qualityPlatform, resolvedQuality) })
        }
        const preferredLevelKey = preference !== 'auto' ? QQ_PREFERENCE_TO_LEVEL_KEY[preference] : undefined
        if (preferredLevelKey && !levels.some(level => level.key === preferredLevelKey)) {
          const preferredOption = options.find(option => option.value === preference)
          if (preferredOption) levels.push({ key: preferredLevelKey, label: preferredOption.label })
        }
        levels.sort((a, b) => {
          const ia = QQ_LEVEL_SIZE_ORDER.indexOf(a.key)
          const ib = QQ_LEVEL_SIZE_ORDER.indexOf(b.key)
          return (ia < 0 ? QQ_LEVEL_SIZE_ORDER.length : ia) - (ib < 0 ? QQ_LEVEL_SIZE_ORDER.length : ib)
        })
        return levels
          // 只列「我们有取流实现」的档位：Hi-Res / 杜比全景声 / 臻品音质2.0 / NAC 目前取不到流，
          // 列出来只会变成"点了没反应/提示不支持"（用户明确要求：支持啥显示啥，不支持就别列）。
          .filter(level => QQ_IMPLEMENTED_LEVEL_KEYS.has(level.key))
          .map(level => {
            const value = QQ_QUALITY_LEVEL_TO_PREFERENCE[level.key] ?? null
            const tier = value ? getQualityTier('qq', value) : undefined
            return { key: level.key, label: level.label, value, requiresVip: Boolean(tier), tier }
          })
      })()
    : null

  // 手动档在本曲回落（如选了 SQ 但本曲只出到 320）→ 列表底部一行说明实际在播档
  const manualFallbackName = preference !== 'auto' && resolvedQuality && resolvedPreferenceValue !== preference
    ? resolvedQualityDisplayName(qualityPlatform, resolvedQuality)
    : null

  const entries: QualityMenuEntry[] = songLevelEntries
    ? [
        { key: 'auto', label: autoLabel, value: 'auto', requiresVip: autoRequiresVip, tier: autoRequiresVip ? 'vip' : undefined },
        ...songLevelEntries,
      ]
    : qqLevelsPending
    ? [{ key: 'auto', label: autoLabel, value: 'auto', requiresVip: autoRequiresVip, tier: autoRequiresVip ? 'vip' : undefined }]
    : options.map(option => ({
        key: String(option.value),
        label: option.value === 'auto' ? autoLabel : option.label,
        value: option.value,
        requiresVip: option.requiresVip || (option.value === 'auto' && autoRequiresVip),
        tier: option.tier || (option.value === 'auto' && autoRequiresVip ? 'vip' : undefined),
      }))

  // 超级会员档独立成一栏（对齐官方面板：顶部「超级会员独家尊享」+ 下方常规档位列表），
  // 且只列本曲真的支持、且我们取得到流的档位
  const premiumEntries = entries.filter(entry => entry.tier === 'svip' && entry.value !== null)
  const standardEntries = entries.filter(entry => entry.tier !== 'svip' && entry.value !== null)

  const select = (value: QualityOptionValue) => {
    // 保存到供源平台：借 QQ 音源时改的是 QQ 的偏好，下次取流才真正用得上
    saveAudioQualitySettings({ [qualityPlatform]: value } as Partial<AudioQualitySettings>)
    setMenuOpen(false)
  }

  /** 音质行：会员档金字 + 官方口径的两级标注（VIP / 超级会员），只渲染有取流实现的档位。 */
  const renderQualityRow = (entry: QualityMenuEntry, premium: boolean) => {
    if (entry.value == null) return null
    const selected = entry.value === preference
    return (
      <button
        key={entry.key}
        type="button"
        onClick={() => select(entry.value as QualityOptionValue)}
        className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors ${
          selected
            ? /* 选中态 = hover 同款高亮（常驻），主题色叠加在深色菜单上不可见，用户已确认弃用 */
              isDark ? 'bg-white/10 text-white/85' : 'bg-black/10 text-black/80'
            : isDark ? 'text-white/85 hover:bg-white/10' : 'text-black/80 hover:bg-black/10'
        }`}
      >
        <span className={`flex-1 truncate ${premium ? 'font-medium' : ''}`} style={entry.requiresVip ? { color: '#fbbf24' } : undefined}>
          {entry.label}
        </span>
        {/* 官方客户端口径：绿钻档标「VIP」，超级会员档标「超级会员」（都配金皇冠）；
            当前账号已有该级别时不再重复提示 */}
        {entry.tier === 'svip' ? (
          <span className="flex flex-shrink-0 items-center gap-0.5 text-[10px] font-medium text-amber-400">
            {!isSvipUser && <Crown className="h-3 w-3" />}超级会员
          </span>
        ) : entry.tier === 'vip' ? (
          <span className="flex flex-shrink-0 items-center gap-0.5 text-[10px] font-medium text-amber-400">
            {!isVipUser && <Crown className="h-3 w-3" />}VIP
          </span>
        ) : null}
      </button>
    )
  }

  return (
    <div className="relative flex items-center">
      <motion.button
        whileHover={{ scale: 1.06 }}
        whileTap={{ scale: 0.95 }}
        onClick={() => setMenuOpen(open => !open)}
        className={`${compact ? 'px-1.5 py-1' : 'px-2 py-1'} flex items-center justify-center rounded-full transition-colors ${
          playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
        }`}
        title={`播放音质：${resolvedQuality ? resolvedQualityDisplayName(qualityPlatform, resolvedQuality) : current.label}（点击切换）`}
      >
        {/* 只显示文字（省位置）：按钮紧贴文案，不做固定宽度——用户反馈长胶囊太占位置 */}
        <span className={`text-center text-[11px] font-medium leading-none ${playerTheme === 'dark' ? 'text-white/85' : 'text-black/75'}`}>
          {badgeLabel}
        </span>
      </motion.button>

      <AnimatePresence>
        {menuOpen && (
          <>
            {/* 点击空白处关闭 */}
            <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.95 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-full right-0 mb-2 z-50 min-w-[10.5rem] max-w-[16rem] rounded-xl p-1.5 backdrop-blur-3xl whitespace-nowrap"
              style={{
                background: isDark ? 'rgba(20, 22, 30, 0.92)' : 'rgba(250, 250, 250, 0.95)',
                border: isDark ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(0,0,0,0.1)',
                boxShadow: '0 12px 32px rgba(0,0,0,0.35)',
              }}
              data-tv-arrows="quality"
            >
              <div className={`px-2.5 py-1 text-center text-[10px] ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                播放音质
              </div>
              {premiumEntries.length > 0 && (
                <>
                  <div className={`px-2.5 pb-1 pt-0.5 text-[10px] font-medium ${isDark ? 'text-amber-300/80' : 'text-amber-600/90'}`}>
                    超级会员独家尊享
                  </div>
                  {premiumEntries.map(entry => renderQualityRow(entry, true))}
                  <div className={`mx-2 my-1 ${isDark ? 'h-px bg-white/10' : 'h-px bg-black/10'}`} />
                </>
              )}
              {standardEntries.map(entry => renderQualityRow(entry, false))}
              {manualFallbackName && (
                <div className={`flex items-center px-2.5 py-1.5 text-[11px] ${isDark ? 'text-white/45' : 'text-black/45'}`}>
                  <span className="truncate">实际在播：{manualFallbackName}</span>
                </div>
              )}
              {qqLevelsPending && (
                <div className={`flex items-center gap-2 px-2.5 py-1.5 text-[12px] ${isDark ? 'text-white/45' : 'text-black/45'}`}>
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
                  正在读取本曲可用档位…
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
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
  transitionEngineLabel,
  transitionStartTime = null,
  immersiveTranslation = '',
  immersiveRoman = '',
  showImmersiveTranslation = false,
  showImmersiveRoman = false,
  songPlatform,
  songId,
  qualityQuickSwitchEnabled = true,
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
  // 拖动进度条期间歌曲自动切换：复位拖动状态，否则松手时会拿旧曲目的比例去 seek 新曲目。
  //（以 duration 变化作为换歌信号：同一首曲目内时长不会变。）
  useEffect(() => {
    setIsDragging(false)
    setDragValue(0)
  }, [duration])
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
  const [, setIsProgressBarExpanded] = useState(false)
  const [shortcutSettings, setShortcutSettings] = useState(loadPlaybackShortcutSettings)
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
    // 播放面配色只认传入的封面主色（App 由 useColorThief 下发），不再自己读设置里的主题色
    window.addEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
    return () => {
      window.removeEventListener(PLAYBACK_SHORTCUT_SETTINGS_EVENT, handleSettingsChange)
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
      // TV 遥控：方向键导航由 tvCore 在捕获阶段处理并 preventDefault；这里必须让路，
      // 否则切焦点会顺带 seek/改音量（播放页/歌曲详情里尤其明显）。长按连发也不该重复触发。
      if (e.defaultPrevented || e.repeat) return
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

  /**
   * 换轨滑行：AutoMix 的视觉轨道在过渡 90% 处把时间线从源曲切到目标曲（进度条/时间数字
   * 本会"啪"地跳到新曲位置）。这里只在**过渡期间**（transitionStartTime != null，用户拖动
   * 与普通 seek 不受影响）对这个大跳变做 ~420ms 的 smoothstep 滑行，让它"滑过去"而不是跳过去。
   */
  const glideRafRef = useRef<number | null>(null)
  const glideRef = useRef<{ from: number; startedAt: number } | null>(null)
  const lastTimeRef = useRef(currentTime)
  const [glideTime, setGlideTime] = useState<number | null>(null)
  useEffect(() => {
    const previous = lastTimeRef.current
    lastTimeRef.current = currentTime
    if (isDragging || transitionStartTime === null) {
      glideRef.current = null
      if (glideTime !== null) setGlideTime(null)
      return
    }
    const delta = currentTime - previous
    if (!Number.isFinite(delta) || Math.abs(delta) < 1.5) return
    glideRef.current = { from: previous, startedAt: performance.now() }
    const step = () => {
      const glide = glideRef.current
      if (!glide) {
        glideRafRef.current = null
        return
      }
      const t = Math.min(1, (performance.now() - glide.startedAt) / 420)
      const eased = t * t * (3 - 2 * t)
      const latest = lastTimeRef.current
      setGlideTime(glide.from + (latest - glide.from) * eased)
      if (t < 1) glideRafRef.current = requestAnimationFrame(step)
      else {
        glideRef.current = null
        glideRafRef.current = null
        setGlideTime(null)
      }
    }
    if (glideRafRef.current !== null) cancelAnimationFrame(glideRafRef.current)
    glideRafRef.current = requestAnimationFrame(step)
  }, [currentTime, isDragging, transitionStartTime, glideTime])
  useEffect(() => () => { if (glideRafRef.current !== null) cancelAnimationFrame(glideRafRef.current) }, [])

  // 滑行期间把显示值夹在当前曲时长内：进度条从"接近满格"平滑回卷到目标曲的百分比，
  // 而不是先钉在 100% 再落到新位置（时长与时间数字同步变化，观感一致）。
  const displayTime = isDragging
    ? dragValue
    : (glideTime !== null ? Math.min(glideTime, duration > 0 ? duration : glideTime) : currentTime)
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
          {/* 配色用封面主色的自适应版本（progressFillColor 已按明暗主题钳制亮度，保证在这层遮罩上可读） */}
          <div className="flex items-center justify-center gap-2 text-sm font-bold tracking-wide" style={{ color: progressFillColor }}>
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
  // 过渡指示：动画窗口内 = 正在过渡；增强档已介入（混音音频在放、动画还没到点）也显示。
  // 文案只写引擎名，且**只可能是这四个**：AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless
  //（App 用 transitionEngineDisplayName 统一映射后传进来）。既不再出现「即将介入 / 正在介入」，
  //  也不再出现「过渡」这种没有归属的通用词——纯交叉淡化等情况直接不显示。
  const inTransitionAnimation = isTransitioning && inAnimationWindow
  const showTransitionBadge = inTransitionAnimation || enhancedAutoMixActive
  const engineLabel = transitionEngineLabel || ''
  // 稳压后的引擎名提示（去抖 + 最短驻留 + 文案锁定），渲染在小白条内
  const engineBadge = useStableEngineLabel(showTransitionBadge, engineLabel)
  
  // 进度条发光强度

  // ---- 展开态右侧控件组（播放列表 / 音量 / 播放模式 / DGLab）----
  // 此前是绝对定位 right-5 的独立簇 + 进度行 pr-[12rem] 预留：两套宽度必须人肉对齐，
  // 任何偏差都会变成「时长 ↔ 音质 ↔ 图标」之间的空洞（用户先后两次反馈割裂）。
  // 现在整组并入进度行（见 renderProgressContent），与时长、音质徽标共享同一套 gap 间距。
  const renderExpandedSideControls = (compactLayout: boolean, forImmersive: boolean) => (
    <>
      <motion.button
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.95 }}
        onClick={onPlaylistClick}
        className={`${compactLayout ? 'p-1.5' : 'p-2'} rounded-full transition-colors ${
          playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
        }`}
      >
        <List className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
      </motion.button>

      {/* 音量控制区域 */}
      <div className="relative flex items-center">
        <motion.button
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.95 }}
          onClick={handleVolumeButtonClick}
          className={`${compactLayout ? 'p-1.5' : 'p-2'} rounded-full transition-colors ${
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
              {...(forImmersive ? {
                onMouseEnter: () => {
                  if (volumeCloseTimerRef.current !== null) {
                    window.clearTimeout(volumeCloseTimerRef.current)
                    volumeCloseTimerRef.current = null
                  }
                },
                onMouseLeave: () => {
                  if (volumeCloseTimerRef.current !== null) {
                    window.clearTimeout(volumeCloseTimerRef.current)
                    volumeCloseTimerRef.current = null
                  }
                  volumeCloseTimerRef.current = setTimeout(() => {
                    volumeCloseTimerRef.current = null
                    setShowVolumeSlider(false)
                  }, 800)
                },
              } : {})}
              style={{
                background: forImmersive
                  ? (playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.4) 100%)'
                      : 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.7) 100%)')
                  : (playerTheme === 'dark'
                      ? backgroundEffect === 'transparent'
                        ? 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 100%)'
                        : 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.3) 100%)'
                      : backgroundEffect === 'transparent'
                      ? 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.05) 100%)'
                      : 'linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.6) 100%)'),
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
        className={`${compactLayout ? 'p-1.5' : 'p-2'} rounded-full transition-colors ${
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
          className={`relative ${compactLayout ? 'p-1.5' : 'p-2'} rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
          title={dglabOutputOn ? '暂停波形输出（不断开连接）' : '恢复波形输出'}
        >
          <AudioWaveform className={`w-4 h-4 ${dglabOutputOn ? 'text-amber-300' : 'text-white/25'}`} />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full" style={{ background: dglabOutputOn ? '#FFE89C' : '#64748b' }} />
        </motion.button>
      )}
    </>
  )

  // ---- 进度条 UI（正常模式和沉浸展开共用） ----
  // sliderWidthClass 传弹性类（flex-1 min-w-…）：640px 展开条里固定宽度 + 两侧按钮集群
  // 会结构性溢出（时间文字被下一首/音质按钮压住，2026-10-04 实测间距 -2~2px）。
  // 现在进度内容跟随可用宽度自适应：展开态左侧用 pl 预留上一首/播放/下一首集群，
  // 右侧控件组（音质徽标 + 列表/音量/模式）直接并进本行尾部共享 gap —— 右侧不再需要预留。
  const renderProgressContent = (sliderWidthClass: string, containerClassName: string = '', compactLayout = false, forImmersive = false) => (
    <div className={`flex flex-col gap-1 w-full ${containerClassName}`}>
      <div className="flex items-center gap-2">
        <span className={`text-xs font-medium min-w-[38px] text-center leading-none ${
          playerTheme === 'dark' ? 'text-white/80' : 'text-black/70'
        }`}>
          {formatTime(displayTime)}
        </span>

        <div className={`relative ${sliderWidthClass} flex items-center`} data-tv-arrows="seek">          <input
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
            // 只过渡高度：背景是"随播放进度变化"的 linear-gradient 字符串，
            // transition-all 会试图逐帧插值渐变（每次 timeupdate 重绘整条滑轨）——
            // 用户反馈的"控件动画有点卡、帧率不够"主要来自这里。
            className={`progress-slider w-full h-1.5 hover:h-2.5 rounded-full appearance-none cursor-pointer transition-[height] duration-200 ${isLiveStream ? 'opacity-60' : ''}`}
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

        {/* 展开态右侧整组控件（音质徽标 + 播放列表/音量/播放模式/DGLab）：
            与时长、滑轨同处一个 flex 行、共享 gap-2 间距 —— 此前「绝对定位右锚定簇 + 固定预留」
            两套宽度对不齐，先后出现「时长 ↔ 音质」50px 与「音质 ↔ 图标」~60px 的空洞（用户两次反馈）。
            淡入时序沿用原簇的 0.25s 延迟，展开时与左侧控制按钮同步出现。 */}
        {isExpanded && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.22, delay: 0.25, ease: 'easeOut' }}
            className="flex items-center gap-2"
          >
            {songPlatform && qualityQuickSwitchEnabled && (
              <QualityQuickSwitch
                platform={songPlatform}
                songId={songId}
                playerTheme={playerTheme}
                accentColor={accentColor}
                compact={compactLayout}
              />
            )}
            {renderExpandedSideControls(compactLayout, forImmersive)}
          </motion.div>
        )}
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
          {/* 引擎名：悬浮在小白条/药丸上方（锚定常驻容器——药丸与白条两种状态都显示）。
              金色仅 AutoMix Enhanced；Pro 粉色辉光呼吸；Gapless/标准白色。稳压防抖见 useStableEngineLabel。 */}
          <AutomixEngineLabel visible={engineBadge.visible} text={engineBadge.text} tone={playerTheme} />
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

          {/* 过渡提示已上移到整列上方（绝对定位），这里不再占位 */}

          {/* 药丸播放控件 */}
          <AnimatePresence>
            {showPill && (
              <motion.div
                initial={{ y: 100, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 100, opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8 }}
                className="pointer-events-auto relative mb-3"
                onMouseEnter={handleImmersivePillEnter}
                onMouseLeave={handleImmersivePillLeave}
              >
                {/* 引擎名提示已改为直接渲染在药丸内顶部（见下方 AutomixEngineLabel），
                    不再悬挂在条外——位置固定、文案与显隐都做了稳压，不再抖动。 */}
                <motion.div
                  initial={{ width: tvCompact ? '480px' : '360px' }}
                  animate={{
                    width: tvCompact ? '480px' : isExpanded ? '640px' : '360px',
                    // 药丸总高锁死为原值（TV 紧凑 32px / 展开 44px / 收起 36px）：右侧控件并入进度行后，
                    // 行高由 32px 图标按钮主导，内边距相应收窄补偿，视觉高度与旧版绝对定位簇完全一致。
                    paddingTop: tvCompact ? (isExpanded ? '2px' : '10px') : isExpanded ? '6px' : '12px',
                    paddingBottom: tvCompact ? (isExpanded ? '2px' : '10px') : isExpanded ? '6px' : '12px',
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
                  {/* 引擎名已恢复悬浮在条上方（锚定外层常驻容器，白条/药丸两种状态都显示） */}
                  {/* 两侧预留与药丸宽度同步动画（同曲线同延迟）：否则收起时 padding 瞬间清零、
                      宽度还在 640→360 的动画中，进度内容会突然拉满整条（用户看到的"退出动画变形"） */}
                  <div
                    className={`flex items-center justify-center ${isExpanded ? 'pl-[8.25rem]' : ''}`}
                    style={{ transition: `padding 0.35s ease ${isExpanded ? '0s' : '0.2s'}` }}
                  >
                    <motion.div
                      className="w-full"
                      animate={{ scale: 1, opacity: isExpanded ? 1 : 0.7 }}
                      transition={{ duration: 0.3, delay: isExpanded ? 0.15 : 0.15, ease: 'easeInOut' }}
                    >
                      {/* TV 紧凑药丸（480px）并入右侧控件后行内固定宽度更大，滑轨下限相应收窄防溢出 */}
                      {renderProgressContent(tvCompact ? 'flex-1 min-w-[4rem]' : 'flex-1 min-w-[7rem]', tvCompact ? 'gap-1.5' : 'gap-3', tvCompact, true)}
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
                          className="p-2.5 rounded-full transition-colors" style={{ backgroundColor: accentColor }}>
                          {isPlaying ? <Pause className="w-4 h-4" style={{ color: iconColor }} /> : <Play className="w-4 h-4 ml-0.5" style={{ color: iconColor }} />}
                        </motion.button>
                        <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.95 }} onClick={onNext} disabled={!onNext}
                          className={`p-2 rounded-full transition-colors disabled:opacity-30 ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}>
                          <SkipForward className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </motion.button>
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
        {/* 引擎名：悬浮在条上方（金色仅 Enhanced；Pro 粉色辉光呼吸；Gapless/标准白色）。稳压防抖见 useStableEngineLabel */}
        <AutomixEngineLabel visible={engineBadge.visible} text={engineBadge.text} tone={playerTheme} />
        <motion.div
          initial={{ width: '360px' }}
          animate={{
            width: isExpanded ? '640px' : '360px',
            // 药丸总高锁死为原值（展开 44px / 收起 36px）：右侧控件并入进度行后行高由
            // 32px 图标按钮主导，内边距收窄补偿，视觉高度与旧版绝对定位簇完全一致。
            paddingTop: isExpanded ? '6px' : '12px',
            paddingBottom: isExpanded ? '6px' : '12px',
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
          {/* 引擎名已恢复悬浮在条上方（见本容器开头 AutomixEngineLabel） */}
          {/* 进度条区域：展开态左侧 pl 预留上一首/播放/下一首集群，右侧控件组并入行尾共享 gap，
              滑块弹性自适应；任何宽度下时间文字都不会再与两侧按钮相压。
              预留与药丸宽度同步动画（同曲线同延迟），收起中不会出现进度内容拉满整条的中间态 */}
          <div
            className={`flex items-center justify-center ${isExpanded ? 'pl-[8.25rem]' : ''}`}
            style={{ transition: `padding 0.35s ease ${isExpanded ? '0s' : '0.2s'}` }}
          >
            <motion.div
              className="w-full"
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
              {renderProgressContent('flex-1 min-w-[7rem]', 'gap-3')}
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
                  className="p-2.5 rounded-full transition-colors"
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

        </motion.div>
      </div>
    </>
  )
}
