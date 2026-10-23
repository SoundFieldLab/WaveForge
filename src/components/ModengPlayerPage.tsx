import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AudioLines,
  Captions,
  Eye,
  EyeOff,
  Film,
  Home,
  Languages,
  MessageCircle,
  MoreHorizontal,
  Music,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import { getResolvedArtworkUrl } from '../services/artworkLoader'
import { hasTrueWordTiming, prepareLyricWords } from '../utils/lyricWordTiming'
import { getAgentTintColor, getAppleMusicSettings } from '../services/appleMusic'
import QuickSettings from './QuickSettings'
import {
  evalCurve,
  LB_EASING,
  LB_THRESHOLD,
} from './modengLyricMotion'
import {
  AutomixHudBadge,
  AutomixHudProgressHint,
  useAutomixHudTime,
  type AutomixHudInfo,
} from './AutomixHudBadge'

export type { AutomixHudInfo } from './AutomixHudBadge'

/**
 * 摩登模式音量条显隐持久化 key（仅本模式使用，与其他歌词模式完全隔离）。
 * 默认显示；用户可通过音量条右上角的切换按钮关闭，下次进入仍记忆。
 */
const MODENG_VOLUME_BAR_VISIBLE_KEY = 'waveforge_modeng_volume_bar_visible'
/**
 * 摩登模式翻译显示持久化 key（与全局 translationEnabled 隔离，切到其他歌词模式不影响）。
 * 首次进入时以 props.translationEnabled 作为默认，之后仅记忆本模式用户选择。
 */
const MODENG_TRANSLATION_ENABLED_KEY = 'waveforge_modeng_translation_enabled'
/**
 * 摩登模式罗马音显示持久化 key（与全局 romanEnabled 隔离）。
 * 首次进入时以 props.romanEnabled 作为默认，之后仅记忆本模式用户选择。
 */
const MODENG_ROMAN_ENABLED_KEY = 'waveforge_modeng_roman_enabled'
/**
 * 摩登模式"左右交替歌词"持久化 key（独立开关，仅本模式，不影响其它歌词模式）。
 * 默认关闭；由快捷设置面板（仅 modeng 显示该项）切换，经 waveforge:modeng-side-align 事件即时同步。
 */
const MODENG_SIDE_ALIGN_KEY = 'waveforge_modeng_side_align'

const parseBool = (raw: string | null, fallback: boolean) => {
  if (raw === null) return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  try { return JSON.parse(raw) ? true : false } catch { return fallback }
}

const hexToRgba = (color: string, alpha: number) => {
  const hexMatch = color.match(/^#([\da-f]{6})$/i)?.[1]
  if (hexMatch) {
    const red = Number.parseInt(hexMatch.slice(0, 2), 16)
    const green = Number.parseInt(hexMatch.slice(2, 4), 16)
    const blue = Number.parseInt(hexMatch.slice(4, 6), 16)
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`
  }
  const rgbMatch = color.match(/rgb\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i)
  if (rgbMatch) {
    return `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, ${alpha})`
  }
  const rgbaMatch = color.match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/i)
  if (rgbaMatch) {
    const origAlpha = Number(rgbaMatch[4])
    return `rgba(${rgbaMatch[1]}, ${rgbaMatch[2]}, ${rgbaMatch[3]}, ${(origAlpha * alpha).toFixed(3)})`
  }
  // 无法识别的颜色：原样返回（退化为纯色不透明，不会影响功能）
  return color
}

interface ModengPlayerPageProps {
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
  /** Apple Music 命中的高清封面（优先显示 + 启用律动粒子动效） */
  appleCoverUrl?: string
  /** Apple Music 动态封面（图层叠加式，无/失败回退静态封面） */
  animatedCoverUrl?: string | null
  animatedCoverPoster?: string | null
  trackId?: string | number
  /** 翻译/罗马音显示：传入时作为受控状态；未传入时使用摩登模式本地持久化状态 */
  translationEnabled?: boolean
  romanEnabled?: boolean
  /** 当前歌曲是否含有翻译/罗马音：按钮无内容时置灰禁用 */
  hasTranslation?: boolean
  hasRoman?: boolean
  /** 翻译/罗马音切换回调（按钮点击时触发；供上层反向同步） */
  onTranslationToggle?: () => void
  onRomanToggle?: () => void
  /** 打开评论弹窗回调（点击右下角评论按钮） */
  onOpenComments?: () => void
  /** 回到主页回调（左下角 Home 按钮） */
  onHomeClick?: () => void
  /** MV 背景开关回调 + 当前启用态（左下角 MV 按钮，与全局设置同步） */
  onMvBackgroundToggle?: () => void
  mvBackgroundEnabled?: boolean
  /** MV 视频背景激活态（底层有 LazyBilibiliMvBackground 视频）：开启时本页底色透明、隐去封面模糊，让视频透出 */
  mvBackgroundActive?: boolean
  /** 打开调音室回调（左下角调音室按钮；anchorRect 用于锚定弹窗） */
  onOpenMixingStudio?: (anchorRect?: DOMRect) => void
  /** 更多菜单回调（封面区右上角 ⋯ 按钮，打开歌曲更多操作） */
  onMoreClick?: () => void
  isTransitioning?: boolean
  onSeek?: (time: number) => void
  onPlayPause?: () => void
  onPrevious?: () => void
  onNext?: () => void
  volume?: number
  onVolumeChange?: (volume: number) => void
  playMode?: 'sequential' | 'shuffle' | 'repeat'
  onPlayModeChange?: (mode: 'sequential' | 'shuffle' | 'repeat') => void
  duration?: number
  /** 纯音乐模式：true 时右栏不渲染歌词列，换成「纯音乐」居中占位（保证左栏控制条继续可用），与其他歌词模式隔离 */
  isPureMusic?: boolean
  /** AutoMix 过渡 HUD：armed=等待过渡（封面下方时间节点徽标），running=过渡进行中（进度条上方金色提示）；null=未武装 */
  automixHud?: AutomixHudInfo | null
  /** 过渡动画窗口进度 0-1（overlayProgress：最后 4 秒窗口归一化），驱动封面/标题交叉淡化 */
  transitionProgress?: number
  /** 过渡旧曲封面（交叉淡化的底层） */
  transitionFromCover?: string
  /** 过渡新曲封面（交叉淡化的顶层，armed 期间已按 critical 预载） */
  transitionToCover?: string
  /** 过渡新曲标题/艺人（标题双层淡切用） */
  transitionToTitle?: string
  /** HUD「关闭」的引擎动作：本曲不做智能混音（完整播放本曲，末尾只留短交叉）；由 App 注入 */
  onSkipAutomix?: () => void
  transitionToArtist?: string
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

const formatTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// 非当前行：距离当前行越远越淡、越糊（对齐 LyricsBlossom 原生颜色：次行 0x99EBEBF5=0.60 / 0x993C3C43=0.60。
//   原版 fade 0.40/0.32/… 太暗，±1 行与当前句之间层次感过强，把 distance=1 调回 ~0.60 后向远端阶梯性衰减，
//   使滚动视图里"近三行可读、远行逐渐淡化消失"更像 Skia 渲染的灰度渐变。
//   ▼ 2026-09-02 "过曝"修复：整体压暗一档，避免大量白字叠加成发白画面，同时保留近三行可读阶梯。）
// ⚠ 2026-09-12 实机比对校准（LyricsBlossom 窗口 1024×768 @DPI120，1:1 截图逐行实测）：
//   非当前行**不是**"越远越透明"，而是基本恒定在副文字色 0xa0ebebf5 = rgba(235,235,245,0.63)。
//   实测 distance 1..5 的文字 alpha = 0.578 / 0.578 / 0.534 / 0.508 / 0.326：前四行几乎一样亮，
//   层次感主要由**模糊**提供。原实现 0.52→0.40→0.30… 的陡降会让远处行过早暗掉/消失。
const LINE_FADE = [0.63, 0.58, 0.50, 0.42, 0.34, 0.26, 0.18]
// 非当前行 blur（单位 px × s）。
//   实机比对：非当前行的横向梯度只有当前行的 ~0.4 倍（当前行 grad 20-27 / 非当前行 grad 4-10），
//   视觉模糊明显强于原 2.0px 起点；远端行糊到几乎读不出，与原版观感一致。
const LINE_BLUR = [3.6, 4.8, 6.2, 7.8, 9.6, 11.4, 13.2]

const FONT_STACK =
  "-apple-system, 'SF Pro Display', 'PingFang SC', 'PingFang TC', 'Hiragino Sans GB', 'Noto Sans CJK SC', 'Helvetica Neue', 'Segoe UI', Roboto, Arial, sans-serif"

// 缓动曲线：ease-out（逐字渐亮）
//   AMLL 风格：四次方 ease-out（比三次方起步更慢、中段加速更快），
//   给"字从暗到亮"一种缓慢蓄力→快速点亮→柔和到位的 Apple Music 逐词点亮手感。
const easeOut = (t: number) => 1 - Math.pow(1 - t, 4)

// ▼ 动画体系：**LyricsBlossom 的 CSSCubicBezierTiming**（见 ./modengLyricMotion.ts）
//   逆向结论：LyricsBlossom **没有 spring 物理**，全部过渡都是三次贝塞尔 + 逐帧 tick。
//   之前本文件移植了 AMLL 的 spring 求解器（stiffness/damping/mass），动画时长由物理参数
//   涌现；与逆向规格不符 —— 现已整体替换为逆向的固定时长曲线：
//     行切换 / 相邻行位移 → back 型 (0.4, 0, 0.2, 1) @0.32s（0x2FA0C0）
//     当前行展开放大     → ease-in-out (0.42, 0, 0.58, 1) @0.3s（0x2B8620）
//     放大行淡入         → (0.4, 0, 0.2, 1) @0.45s（0x2FDC60 等三处）
//     行 alpha 淡入淡出  → 线性 dt/0.32 推进后再按 0.5 复位（0x2F6110）

// 整列滚动跟随速率（指数逼近，非弹簧）。
//   ⚠ 2026-09-12 实机比对校准：原值 0.36（且被 blend 侧 Math.min(0.95) 卡住）过慢 ——
//   指数逼近的**稳态滞后 = 目标移动速度 / rate**：目标以约 19px/s 推进时滞后 ≈ 53px（比一行还高），
//   播放中歌词会永远落后半行；暂停时切行更是几乎不收敛（实机截图 5 秒后当前行仍停在 285 而非锚点 315）。
//   而 LyricsBlossom 实测当前行**精确停在锚点**（8 张连拍 ctr 恒定 317/768 = 41.3%，无可见滞后）。
//   取 8 → 稳态滞后 ≈ 2.4px（可忽略），95% 收敛约 0.37s，与行切换曲线同量级。
const SCROLL_FOLLOW_RATE = 8

// —— Apple Gaussian 光粒子（背景律动第 2 层）——
//   分置于节拍光晕容器内（相对坐标 0..1），rAF 按 beat 双频段包络驱动"缓慢飘移 + 节拍脉动"，
//   复刻 Apple 封面高斯光斑散开的沉浸感。坐标/尺寸用基准值（951 画布），渲染时乘 s。
const PARTICLES = Array.from({ length: 14 }, (_, i) => {
  const angle = (i / 14) * Math.PI * 2 + 0.35
  const ring = 0.16 + (i % 5) * 0.12
  return {
    x: 0.5 + Math.cos(angle) * ring,
    y: 0.44 + Math.sin(angle) * ring * 0.62,
    size: 26 + (i % 6) * 12,  // 基础直径（px @951 基准）
    speed: 0.7 + (i % 4) * 0.28, // 呼吸/脉动倍频
    phase: (i % 7) / 7,          // 相位偏移 0..1
    drift: 14 + (i % 3) * 9,     // 缓慢横向飘移幅度（px @951 基准）
    peakY: 9 + (i % 4) * 6,      // 脉动上浮幅度（px @951 基准）
    amp: 0.10 + (i % 5) * 0.05,  // 峰值不透明度增量
    boost: 0.18 + (i % 3) * 0.10, // 峰值放大增量
    alpha: 0.05 + (i % 4) * 0.04, // 静息不透明度
  }
})

// 无障碍：尊重系统"减弱动态/减少运动"偏好（`prefers-reduced-motion: reduce`）。
//   开启时去掉缩放/辉光/粒子/滚动弹簧等装饰性运动，只保留逐字颜色随唱推进这一"信息本质"，
//   避免对前庭/光敏敏感用户造成眩晕。作用域仅本模式，不影响其它歌词模式。
const REDUCED_MOTION =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

// 逐字/逐行辅助混色常量（按 LyricsBlossom renderLine 反汇编）
//   已唱词 saveLayerAlpha：fadeOut = clamp01(1 - wordAnim)，
//   仅当 (1 - wordAnim) < 0.985 时才通过颜色回退让"刚唱完的字"快速从高亮色
//   回退到中性灰——对应 0x2F7C3E "0.985" 阈值指令。
const SUNG_FADE_THRESH = LB_THRESHOLD.sungFade

interface SizedWord {
  text: string
  startTime: number // 绝对秒
  endTime: number
  whitespace: boolean
}

const buildLineWords = (line: LyricLine): SizedWord[] => {
  if (!hasTrueWordTiming(line)) return []
  return prepareLyricWords(line).map(word => {
    const whitespace = /^\s+$/u.test(word.word)
    const start = line.time + Math.max(0, word.startTime) / 1000
    return {
      text: word.word,
      startTime: start,
      endTime: whitespace ? start : start + Math.max(0.001, word.duration) / 1000,
      whitespace,
    }
  })
}

export default function ModengPlayerPage({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  playerTheme,
  accentColor,
  songTitle,
  songArtist,
  coverUrl,
  appleCoverUrl,
  animatedCoverUrl,
  animatedCoverPoster,
  isTransitioning,
  onSeek,
  onPlayPause,
  onPrevious,
  onNext,
  volume = 1,
  onVolumeChange,
  playMode = 'sequential',
  onPlayModeChange,
  duration = 0,
  // 翻译/罗马音：优先使用摩登模式本地存储；缺失时回退 props 默认（上层全局设置）
  translationEnabled: translationEnabledProp,
  romanEnabled: romanEnabledProp,
  hasTranslation: hasTranslationProp,
  hasRoman: hasRomanProp,
  onTranslationToggle,
  onRomanToggle,
  onOpenComments,
  onHomeClick,
  onMvBackgroundToggle,
  mvBackgroundEnabled = false,
  mvBackgroundActive = false,
  onOpenMixingStudio,
  onMoreClick,
  isPureMusic = false,
  automixHud = null,
  transitionProgress = 0,
  transitionFromCover,
  transitionToCover,
  transitionToTitle,
  onSkipAutomix,
  transitionToArtist,
}: ModengPlayerPageProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 1312, height: 951 })
  // AutoMix 过渡徽标「关闭」：按排程键记忆（切歌/重新排程后自动恢复显示）
  const [automixHudDismissed, setAutomixHudDismissed] = useState(false)
  useEffect(() => {
    setAutomixHudDismissed(false)
  }, [automixHud?.key])
  const automixHudTime = useAutomixHudTime(playbackTimeStore)
  // 过渡期封面/标题交叉淡化：仅在过渡窗口内有新旧两份素材时启用（素材由 App 在 armed 期间预载）
  const coverTp = Math.max(0, Math.min(1, transitionProgress))
  const coverTransitionActive = isTransitioning && Boolean(transitionFromCover && transitionToCover) && coverTp > 0
  const titleTransitionActive = isTransitioning && Boolean(transitionToTitle) && coverTp > 0
  // 常规封面统一走 512 档解析地址：与 App 的过渡预载同档同键，commit 切回单层时直接命中缓存不闪
  const resolvedCover = coverUrl ? getResolvedArtworkUrl(coverUrl, { size: 512 }) : ''
  // 拖拽期间挂在 window 的 pointer 监听器：组件卸载时也要移除，避免外溢
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const scrubCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => {
    dragCleanupRef.current?.()
    scrubCleanupRef.current?.()
  }, [])

  // 歌词列拖拽预览：按下记录起点，移动累计 offset（>4px 视为拖拽，抑制行点击 seek），
  //   松手由 rAF 弹簧把 offset 回弹归零（配合端点橡皮筋阻力），实现"拖出预览 → 松手回位"。
  const startLyricScrub = (event: React.PointerEvent) => {
    scrubRef.current.active = true
    scrubRef.current.startY = event.clientY
    scrubRef.current.moved = false
    scrubRef.current.offset = 0
    const move = (e: PointerEvent) => {
      const dy = e.clientY - scrubRef.current.startY
      if (Math.abs(dy) > 4) scrubRef.current.moved = true
      scrubRef.current.offset = dy
    }
    const up = () => {
      scrubRef.current.active = false
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (scrubCleanupRef.current === up) scrubCleanupRef.current = null
    }
    scrubCleanupRef.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // 摩登模式音量条显隐：默认显示，localStorage 持久化（仅本模式使用）
  const [volumeBarVisible, setVolumeBarVisible] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(MODENG_VOLUME_BAR_VISIBLE_KEY)
      // 显式 '0' 才隐藏；未设置或异常时默认显示
      return raw === '0' ? false : true
    } catch {
      return true
    }
  })
  const toggleVolumeBar = () => {
    setVolumeBarVisible(prev => {
      const next = !prev
      try {
        localStorage.setItem(MODENG_VOLUME_BAR_VISIBLE_KEY, next ? '1' : '0')
      } catch {
        // 持久化失败时仅本次会话生效，不影响功能
      }
      return next
    })
  }

  // "是否有翻译/罗马音"：上层传了就用传入值（App 用全局判定），没传则按歌词推导。
  // 推导是必要的兜底——缺了它按钮会被误判成"没有内容"而禁用/置灰，用户点不动。
  const hasTranslation = hasTranslationProp ?? lyrics.some(line => Boolean(line.translation?.trim()))
  const hasRoman = hasRomanProp ?? lyrics.some(line => Boolean(line.roman?.trim() || line.romanWords?.length))

  // 摩登模式翻译开关：与全局 translationEnabled 隔离（仅 waveforge_modeng_*）
  const [translationEnabled, setTranslationEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(MODENG_TRANSLATION_ENABLED_KEY)
      if (raw === null) return Boolean(translationEnabledProp) // 首次进入：用上层全局设置初始化
      return parseBool(raw, Boolean(translationEnabledProp))
    } catch {
      return Boolean(translationEnabledProp)
    }
  })
  const toggleTranslation = () => {
    if (translationEnabledProp === undefined) {
      setTranslationEnabled(prev => {
        const next = !prev
        try { localStorage.setItem(MODENG_TRANSLATION_ENABLED_KEY, JSON.stringify(next)) } catch { /* noop */ }
        return next
      })
    }
    onTranslationToggle?.()
  }

  // 摩登模式罗马音开关：与全局 romanEnabled 隔离
  const [romanEnabled, setRomanEnabled] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(MODENG_ROMAN_ENABLED_KEY)
      if (raw === null) return Boolean(romanEnabledProp)
      return parseBool(raw, Boolean(romanEnabledProp))
    } catch {
      return Boolean(romanEnabledProp)
    }
  })
  const toggleRoman = () => {
    if (romanEnabledProp === undefined) {
      setRomanEnabled(prev => {
        const next = !prev
        try { localStorage.setItem(MODENG_ROMAN_ENABLED_KEY, JSON.stringify(next)) } catch { /* noop */ }
        return next
      })
    }
    onRomanToggle?.()
  }

  const effectiveTranslationEnabled = translationEnabledProp ?? translationEnabled
  const effectiveRomanEnabled = romanEnabledProp ?? romanEnabled
  const resolvedHasTranslation = hasTranslation ?? lyrics.some(line => Boolean(line.translation?.trim()))
  const resolvedHasRoman = hasRoman ?? lyrics.some(line => Boolean(line.roman?.trim()) || Boolean(line.romanWords?.length))

  // 摩登模式"左右交替歌词"开关：独立 key + 自定义事件（由快捷设置面板切换，隔离其它模式）。
  //   开启后按歌曲结构左右对齐：对唱按 agent 分工、普通歌按分段(句间隔大)奇数段右对齐/偶数段左对齐。
  const [sideAlign, setSideAlign] = useState<boolean>(() => {
    try { return localStorage.getItem(MODENG_SIDE_ALIGN_KEY) === 'true' } catch { return false }
  })
  useEffect(() => {
    const onChange = (e: Event) => setSideAlign((e as CustomEvent<boolean>).detail === true)
    window.addEventListener('waveforge:modeng-side-align', onChange as EventListener)
    return () => window.removeEventListener('waveforge:modeng-side-align', onChange as EventListener)
  }, [])

  useEffect(() => {
    const node = rootRef.current
    if (!node) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect && rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // 基准画布 1312×951（LyricsBlossom 真实窗口尺寸），整体等比缩放
  const s = size.height / 951
  const dark = playerTheme !== 'light'

  // 行高 / 当前行锚点 —— 2026-09-12 实机比对校准：
  //   实测 LyricsBlossom（1024×768 窗口）行间距 75~76px = 窗口高的 9.90%（原实现 11.36%，偏大 15%）；
  //   当前行中心稳定落在窗口高的 41.3%（实测 8 张连拍 ctr=317/768；受滚动边界影响会在 38~42% 间浮动）。
  const lineH = 94 * s
  const currentY = size.height * 0.41
  const leftPad = 52 * s
  const coverSize = 476 * s
  // 右侧歌词列位置：gap 120s ≈ 97px @768 窗口，匹配 LyricsBlossom 截图比例。
  //   - 第七轮：去掉原 Math.max(size.width*0.49, ...) 的"宽屏安全垫"（在 1900×973 上会把歌词推到 49% = 931px，
  //     离封面右边 391px，整屏空荡）。改为单一固定 gap。
  //   - 用户 2026-09-12 提供的 LyricsBlossom 截图显示封面与歌词列之间留白明显，
  //     当前行右侧仍有大量空间；60*s 太贴封面，120*s 更接近截图的呼吸感。
  const rightX = leftPad + coverSize + 120 * s

  const lineWords = useMemo(() => lyrics.map(buildLineWords), [lyrics])

  // ---- 封面采色：提取封面主色，用于驱动背景光晕色（startY 渐进模糊 + 主色脉动）----
  //      仅在摩登模式生效；从 <img> 封面通过 canvas 像素采样，得到饱和主色与暗色副色。
  //      使用 ref 避免每首歌 setState 重渲染，颜色值直接写入 DOM style，由下一次 render 时读入。
  const sampledCoverColorRef = useRef<{ dominant: string; dark: string } | null>(null)
  const [, forceCoverColorTick] = useState(0)
  const sampleCoverFromUrl = (url: string) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      try {
        const W = Math.min(img.naturalWidth, 160)
        const H = Math.min(img.naturalHeight, 160)
        const cv = document.createElement('canvas')
        cv.width = W
        cv.height = H
        const ctx = cv.getContext('2d')
        if (!ctx) return
        ctx.drawImage(img, 0, 0, W, H)
        const { data } = ctx.getImageData(0, 0, W, H)
        let rSum = 0, gSum = 0, bSum = 0, wSum = 0
        let drSum = 0, dgSum = 0, dbSum = 0, dwSum = 0
        for (let i = 0; i < data.length; i += 16) {
          const r = data[i], g = data[i + 1], b = data[i + 2]
          const maxC = Math.max(r, g, b), minC = Math.min(r, g, b)
          const lum = 0.299 * r + 0.587 * g + 0.114 * b
          const sat = maxC === 0 ? 0 : (maxC - minC) / maxC
          const weight = 1 + sat * 2.2
          if (lum > 55) {
            rSum += r * weight; gSum += g * weight; bSum += b * weight; wSum += weight
          }
          if (lum < 180) {
            drSum += r * weight; dgSum += g * weight; dbSum += b * weight; dwSum += weight
          }
        }
        const dom = wSum > 0 ? [rSum / wSum, gSum / wSum, bSum / wSum] : [180, 180, 200]
        const dk = dwSum > 0 ? [drSum / dwSum, dgSum / dwSum, dbSum / dwSum] : [40, 40, 52]
        sampledCoverColorRef.current = {
          dominant: `rgb(${Math.round(dom[0])}, ${Math.round(dom[1])}, ${Math.round(dom[2])})`,
          dark: `rgb(${Math.round(dk[0])}, ${Math.round(dk[1])}, ${Math.round(dk[2])})`,
        }
        forceCoverColorTick(x => x + 1) // 触发一次重新渲染以应用采色结果
      } catch {
        /* CORS / canvas 读取失败时保持默认（不会破坏其他功能） */
      }
    }
    img.src = url
  }
  useEffect(() => {
    const target = appleCoverUrl || coverUrl
    if (target) sampleCoverFromUrl(target)
    else { sampledCoverColorRef.current = null; forceCoverColorTick(x => x + 1) }
  }, [appleCoverUrl, coverUrl])

  // ---- 前一行 currentIndex：用于行切换瞬间的"进入/离开"动画（0.32s spring + 位移）----
  // 时间戳直接存 ref，rAF 中按 wall - switchAtRef 驱动，避免依赖 state 重渲染
  const switchAtRef = useRef(0)
  const springCurrIdxRef = useRef(currentIndex)
  // ▼ useLayoutEffect（非 useEffect）：springCurrIdxRef 必须在 paint 前同步更新，
  //   否则 rAF 闭包中的 currentIndex（旧值）与 springCurrIdxRef.current（useEffect 异步更新）
  //   在同一帧不同步 → 逐词循环处理新行但行级 forEach 仍把旧行当 current → 瞬态白屏。
  //   useLayoutEffect 在 React commit DOM 后、paint 前同步执行，消除 1 帧窗口。
  useLayoutEffect(() => {
    switchAtRef.current = performance.now()
    springCurrIdxRef.current = currentIndex
    // 注：滚动位置由 rAF 每帧驱动（scrollPosRef → translateY），这里不硬设 scrollPos，
    //   避免与 rAF 双源覆盖竞态。切行时 rAF 从当前 scrollPos 快速弹簧逼近新目标即可跟上进度。
  }, [currentIndex])
  // 行级 DOM 引用（供 rAF 写入 CSS var，避免 React 每帧 setState 重渲染整列）
  const lineDomRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  // 对唱歌词：演唱者数量 ≥2 时按 ttm:agent 着色（Apple 风格）
  const appleAgentCount = useMemo(
    () => new Set(lyrics.map(line => line.agent).filter(Boolean)).size,
    [lyrics],
  )
  const appleDuetColorsEnabled = useMemo(() => getAppleMusicSettings().duetColors, [])
  const agentTintOf = (agent: string | undefined) =>
    appleDuetColorsEnabled && appleAgentCount >= 2 && agent
      ? getAgentTintColor(agent, appleAgentCount, dark)
      : undefined
  /** 非当前行颜色：对唱行带演唱者色相 */
  const duetLineColor = (agent: string | undefined, fade: number) => {
    const tint = agentTintOf(agent)
    return tint ? hexToRgba(tint, fade) : undefined
  }
  /** 当前行未唱色：对唱行带演唱者色相（弱化） */
  const duetUnsungColor = (agent: string | undefined) => {
    const tint = agentTintOf(agent)
    return tint ? hexToRgba(tint, dark ? 0.5 : 0.42) : undefined
  }

  const parseRgba = (color: string): { r: number; g: number; b: number; a: number } => {
    const match = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/)
    if (!match) return { r: 255, g: 255, b: 255, a: 1 }
    return {
      r: Number(match[1]),
      g: Number(match[2]),
      b: Number(match[3]),
      a: match[4] === undefined ? 1 : Number(match[4]),
    }
  }
  // 未唱色 / 已唱色端点对齐 LyricsBlossom：暗色未唱 0xa0ebebf5=rgba(235,235,245,0.627) → 已唱 #ffffff；
  // 亮色未唱 0x963c3c43=rgba(60,60,67,0.588) → 已唱 #1c1c1e=rgb(28,28,30)
  // ▼ 2026-09-12 实机回归：此前"过曝修复"把未唱色压到 0.50/0.46，但 1:1 实测 LyricsBlossom 当前行内
  //   **未唱部分就是副文字色原值 0.627**（文字 alpha 实测 0.63），亮暗对比来自 mixColor 向纯白插值，
  //   而非压低底色。压低反而让"正在唱的字"与"未唱字"差异变小、整行发灰。
  const unsungColor = dark ? 'rgba(235,235,245,0.627)' : 'rgba(60,60,67,0.588)'
  const sungColorParsed = dark
    ? { r: 255, g: 255, b: 255, a: 1 }
    : { r: 28, g: 28, b: 30, a: 0.92 }
  const unsungColorParsed = dark
    ? { r: 235, g: 235, b: 245, a: 0.627 }
    : { r: 60, g: 60, b: 67, a: 0.588 }
  const mixWordColor = (tRaw: number, agent?: string) => {
    const tClamped = clamp01(tRaw)
    // —— saveLayerAlpha 已唱淡出（逆向 §2.2 0x2F7C7E "0.985" 阈值）：
    //    prog > 0.985 时，颜色从 sung 色向 unsung 色做 35% 回退（不透明度不变，
    //    纯颜色通道回退），等价于 Skia saveLayerAlpha(alpha) 重绘让"刚唱完的字"
    //    从高亮白/黑快速回到中性灰半透明。用颜色而非 opacity 实现，避免与
    //    enterAlpha 的 opacity 写入冲突。
    if (tClamped > SUNG_FADE_THRESH) {
      const windowP = clamp01((tClamped - SUNG_FADE_THRESH) / (1 - SUNG_FADE_THRESH))
      const retreat = 0.35 * windowP // sung → unsung 回退 35%
      const tintVal = duetUnsungColor(agent)
      const fromBase = tintVal ? parseRgba(tintVal) : unsungColorParsed
      const sungBase = tintVal ? parseRgba(tintVal) : sungColorParsed
      // 从 sung 色向 unsung 色插值 retreat 比例
      const r = Math.round(sungBase.r + (fromBase.r - sungBase.r) * retreat)
      const g = Math.round(sungBase.g + (fromBase.g - sungBase.g) * retreat)
      const b = Math.round(sungBase.b + (fromBase.b - sungBase.b) * retreat)
      const a = sungBase.a + (fromBase.a - sungBase.a) * retreat
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`
    }
    // 逐词线性混色：逆向确认 renderLine 不做缓动 —— mixColor(from, to, t)（0x15CAF0）
    //   直接以该词的演唱进度 t 做 ARGB 逐通道线性插值，故这里不加 easeOut 变形。
    const t = tClamped
    const tint = duetUnsungColor(agent)
    if (!tint) {
      // 未唱 alpha（暗 0.627 / 亮 0.588）→ 已唱 alpha，线性插值
      const a0 = unsungColorParsed.a
      const a1 = sungColorParsed.a
      const a = a0 + (a1 - a0) * t
      return dark ? `rgba(255,255,255,${a.toFixed(3)})` : `rgba(28,28,30,${a.toFixed(3)})`
    }
    const from = parseRgba(tint)
    const to = sungColorParsed
    const channel = (start: number, end: number) => Math.round(start + (end - start) * t)
    return `rgba(${channel(from.r, to.r)}, ${channel(from.g, to.g)}, ${channel(from.b, to.b)}, ${(from.a + (to.a - from.a) * t).toFixed(3)})`
  }


  // ---- 时间驱动：rAF 推进逐词混色 / 行弹簧动画 / 节拍背景 / 进度条 / 时间标签 ----
  // 高刷屏限 120fps：所有进度按真实时间计算，跳帧不影响正确性（纯时间推导，无累积误差）
  const wordColorRefs = useRef(new Map<string, HTMLSpanElement>())
  // Apple 背景和声（ttm:role="x-bg"）：主行下方的小字行，与主行同时逐字点亮
  const bgVocalWordRefs = useRef(new Map<string, HTMLSpanElement>())
  const bgVocalRowRefs = useRef(new Map<string, HTMLDivElement>())
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const elapsedRef = useRef<HTMLSpanElement | null>(null)
  const remainRef = useRef<HTMLSpanElement | null>(null)
  // 整列滚动 scrollSpring 状态（AMLL）：scrollPosRef.current 为当前滚动偏移（px，向下为正）。
  //   切行时 useLayoutEffect 同步对齐到当前行目标偏移；rAF 每帧按 scrollPosRef 写 translateY（唯一驱动）。
  const scrollPosRef = useRef(0)
  const scrollContentWrapRef = useRef<HTMLDivElement | null>(null)
  // 首帧 boot 标记（避免 effect 每次切行重建 paint 时丢失，导致首帧 transform 从不设置）
  const scrollBootRef = useRef(false)
  const beatHaloRef = useRef<HTMLDivElement | null>(null)      // 球体光晕层（节拍脉动）
  const beatHaloInnerRef = useRef<HTMLDivElement | null>(null) // 采色内层（节拍更敏感）
  const interludeWrapRef = useRef<HTMLDivElement | null>(null) // 间奏三点容器
  const durationRef = useRef(duration)
  // Apple Gaussian 光粒子 DOM 引用（rAF 直写，避免 setState 重渲染）
  const particleRefs = useRef<Array<HTMLDivElement | null>>([])
  // 歌词列拖拽预览（AMLL 触摸/指针滚动）：拖拽期间叠加 userOffset，松手橡皮筋回弹回跟随。
  //   moved 用于区分"点击 seek"与"拖拽滑动"，避免拖拽触发行 onClick 误 seek。
  const scrubRef = useRef({ active: false, startY: 0, moved: false, offset: 0 })
  durationRef.current = duration
  // 间奏三点：{ visible, countdown(到下一句秒数) }，间奏判定用 gap>4s。
  //   - 入场：第 1 点→第 2 点→第 3 点逐个点亮（各间隔 0.24s，共 ~0.48s 三点全部亮起）。
  //   - 主段：三点"一起呼吸"（完全同相位，零错峰）。
  //   - 退场：临近下一句错峰消点（3→2→1→开唱）；若间奏太短来不及点满三点则按时间显示到哪算哪。
  const interludeRef = useRef({ visible: false, remain: 0, gap: 0, fadeIn: 0, startedAt: 0 })
  // 当前正在唱的字 index（远程 rAF 用它做"切字时重置前一字"的簿记；-1 = 无）
  const activeWordIdxRef = useRef(-1)

  useEffect(() => {
    let raf = 0
    let anchorTime = 0
    let anchorWall = performance.now()
    let playing = false
    let lastPaint = 0
    // 节拍相位（0..1 循环），播放时按 0.9s 一圈（近似 4/4 拍 ~133BPM；不强依赖 Python beat 服务即可有律动感）
    let beatPhase = 0
    const BEAT_PERIOD_MS = 900

    const paint = (now: number, wall: number, dtMs: number) => {
      const t = now + timeOffset
      // 每帧先复位"滚动是否仍在收敛"标志（滚动块内按实际误差重新置位）
      ;(paint as any)._scrollSettling = false
      // —— C. 暂停冻结（时间锚点门控）——
      //   所有歌词动画统一由 wallForSpring 这一个时间锚点驱动：播放时锚点持续跟随墙钟；
      //   暂停时锚点停住 → 传入 evalCurve 的 elapsed 不再增长 → 曲线冻结在当前值。
      //   （逐词的演唱进度由播放时间 t 驱动，暂停时 t 本身不推进，天然冻结。）
      if (playing) {
        ;(paint as any)._frozenWall = wall
      }
      const wallForSpring = (paint as any)._frozenWall ?? wall
      const dt = dtMs > 0 ? dtMs : 16.6
      // —— 0. 行切换共用时间基准 ——
      //    ▼ ci = springCurrIdxRef.current（非闭包 currentIndex）：
      //    保证逐词循环与行级 forEach 用同一个 idx，消除 React commit DOM 后、
      //    useEffect 重建 rAF 闭包前的 1 帧不同步（白屏根因）。
      const ci = springCurrIdxRef.current
      // —— 1. 逐词高亮（回归 LyricsBlossom 实机：每词整字 ARGB 线性插值）——
      //   rAF 每帧直接写 el.style.color = mixWordColor(prog)，整字变色。
      //   用户 2026-09-12 提供的 LyricsBlossom 截图显示：当前行由整字明亮与整字暗淡交替组成，
      //   没有 background-clip:text 那种把单字竖着切开的渐变；中文单字被竖切尤其违和。
      //   保留 sung→unsung 35% 回退（saveLayerAlpha 语义，LyricsBlossom 实机行为），
      //   刚唱完的字会轻微回退到 unsung，让下一词的高亮更突出。
      const line = lyrics[ci]
      if (line) {
        const words = lineWords[ci] || []
        // 正在唱的字下标（prog∈(0,1)）：下面"切字时重置前一字"要用（与远程实现同一判定）
        let newActiveWord = -1
        if (words.length > 0) {
          words.forEach((word, wordIndex) => {
            if (word.whitespace) return
            const el = wordColorRefs.current.get(`w${ci}-${wordIndex}`)
            if (!el) return
            const span = Math.max(0.001, word.endTime - word.startTime)
            const prog = clamp01((t - word.startTime) / span)
            if (prog > 0 && prog < 1) newActiveWord = wordIndex
            el.style.color = mixWordColor(prog, line.agent)
          })
        } else {
          // no_syllable 退化（无逐词数据）：整行按线性混色推进。
          const el = wordColorRefs.current.get(`l${ci}`)
          if (el) {
            const progRaw = clamp01((t - line.time) / Math.max(0.3, Math.min(2, (lyrics[ci + 1]?.time ?? line.time + 2) - line.time)))
            el.style.color = mixWordColor(progRaw, line.agent)
          }
        }
        if (newActiveWord !== activeWordIdxRef.current) {
          // 切换字时把前一字 scale/填充 立即重置（避免回弹/渐变残留）
          const prevIdx = activeWordIdxRef.current
          if (prevIdx >= 0 && words[prevIdx] && !words[prevIdx].whitespace) {
            const prevEl = wordColorRefs.current.get(`w${ci}-${prevIdx}`)
            if (prevEl) {
              prevEl.style.transform = 'translateZ(0) scale(1)'
              // 清渐变填充：唱完的字应回实色(sung)，且必须去掉 text-fill:transparent 残留，
              // 否则该字会以透明填充渲染（无底色）→ 不可见。
              const prevPrevProg = clamp01(
                (t - words[prevIdx].startTime) / Math.max(0.001, words[prevIdx].endTime - words[prevIdx].startTime),
              )
              prevEl.style.color = prevPrevProg >= 1
                ? (dark ? 'rgba(255,255,255,1)' : 'rgba(28,28,30,0.95)')
                : (duetUnsungColor(line.agent) ?? unsungColor)
              prevEl.style.backgroundImage = 'none'
              prevEl.style.backgroundClip = 'border-box'
              prevEl.style.webkitBackgroundClip = 'border-box'
              prevEl.style.webkitTextFillColor = ''
            }
          }
          activeWordIdxRef.current = newActiveWord
        }

        // —— 1c. Apple 背景和声（TTML ttm:role="x-bg"）——
        //   主行下方的小字行，与主行同时进行、各自逐字点亮（对齐 Apple Music 的 x-bg 呈现）。
        //   和声整体比主行克制：未唱更暗、唱到才亮，整段随所属主行淡入淡出。
        const bgVocals = line.backgroundVocals || []
        bgVocals.forEach((vocal, vi) => {
          const lastWord = vocal.words?.[vocal.words.length - 1]
          const vocalEnd = vocal.endTime
            ?? (lastWord ? vocal.time + (lastWord.startTime + lastWord.duration) / 1000 : vocal.time + 1)
          const rowEl = bgVocalRowRefs.current.get(`bg${ci}-${vi}`)
          if (rowEl) {
            // AM 官方时序（用户实测）：和声随**主行激活**向下淡入——不使用和声自己的
            // begin（可能远晚于主行激活，主行唱半天和声才出现）；显示持续到主行窗口
            // 结束（和声唱完不提前消失），逐词亮度仍按和声自己的词时间。
            const fadeIn = clamp01((t - line.time) / 0.24)
            const fadeOut = clamp01((vocalEnd - t) / 0.36)
            rowEl.style.opacity = Math.min(fadeIn, fadeOut).toFixed(3)
          }
          ;(vocal.words || []).forEach((word, wi) => {
            const el = bgVocalWordRefs.current.get(`bg${ci}-${vi}-${wi}`)
            if (!el) return
            const absStart = vocal.time + word.startTime / 1000
            const absEnd = absStart + Math.max(word.duration, 1) / 1000
            el.style.opacity = t >= absEnd ? '0.95' : t >= absStart ? '0.72' : '0.32'
          })
        })
      }

      // —— 2. 行切换动画（LyricsBlossom CSSCubicBezierTiming，无弹簧）——
      //   行位移      0x2FA0C0  back (0.4, 0, 0.2, 1) @0.32s
      //   展开放大    0x2B8620  ease-in-out (0.42, 0, 0.58, 1) @0.3s
      //   放大行淡入  0x2FDC60  (0.4, 0, 0.2, 1) @0.45s
      //   （二进制里 scale 目标 3.0f / rect 外扩 10px 属内部渲染值，视觉语义是"当前行相对
      //     其余行展开放大"，此处换算为 0.88→1.0 的 scale + 8px 上浮。）
      //   ⚠ 行切换动画走**真实墙钟 wall**（而非 wallForSpring）：它是纯 UI 过渡，不是与
      //     播放联动的动画。若用被冻结的锚点，暂停状态下拖动进度条/点击某行 seek 时
      //     switchAt 会被刷新到当前墙钟、而锚点仍停在过去 → elapsed 变负 → 行 alpha 归零、
      //     整行不可见。逐词进度仍由播放时间 t 驱动，暂停时天然冻结，不受此影响。
      const switchSecFull = Math.max(0, (wall - switchAtRef.current) / 1000)
      const expandK = evalCurve(LB_EASING.easeInOut, switchSecFull)              // 0.3s 展开放大
      const expandFadeK = clamp01(switchSecFull / LB_EASING.expandFade.duration)  // 0.45s 放大行淡入
      const idx = springCurrIdxRef.current
      // 给当前行打 .modeng-current；降级行必须清空 rAF 写过的内联残留（词色 /
      //   行级 CSS 变量），否则"已经唱过去的行"会一直挂着高亮色。
      lineDomRefs.current.forEach((el, k) => {
        if (k === idx) {
          el.classList.add('modeng-current')
        } else if (el.classList.contains('modeng-current')) {
          // ▼ 从 current 降级为非 current：清 color / transform / opacity 内联残留。
          //   同时清掉逐字渐变用的三个 CSS 变量（sung/unsung/prog）和兜底 color，
          //   让该行立刻退回父级 lineColor 继承，否则会继续以 unsung 高 alpha 显字。
          const words = el.querySelectorAll<HTMLElement>('.modeng-word')
          for (let i = 0; i < words.length; i++) {
            const w = words[i]
            w.style.color = ''
            w.style.transform = ''
            w.style.opacity = ''
            w.style.transition = ''
            w.style.removeProperty('font-variation-settings')
            w.style.removeProperty('--modeng-word-prog')
            w.style.removeProperty('--modeng-word-sung')
            w.style.removeProperty('--modeng-word-unsung')
            w.style.fontWeight = ''
          }
          // 行级 CSS 变量清理
          el.style.removeProperty('--modeng-enter-y')
          el.style.removeProperty('--modeng-enter-scale')
          el.style.removeProperty('--modeng-enter-alpha')
          el.style.removeProperty('--modeng-leave-y')
          el.style.removeProperty('--modeng-leave-alpha')
          el.style.removeProperty('--modeng-next-y')
          el.classList.remove('modeng-current')
        } else {
          // 已是非 current：保留下次降级清理即可，每帧不做全扫描避免不必要的 DOM 查询
          el.classList.remove('modeng-current')
        }
      })
      const currentLineEl = lineDomRefs.current.get(idx)
      if (currentLineEl) {
        // 当前行进入：scale 走 ease-in-out 0.3s 从 0.88 展开到 1.0（展开放大钩子）；
        //   alpha 走 0.45s 淡入（放大行淡入）；Y 从 +8px 上浮就位（rect 外扩 10px 的观感）。
        //   (无障碍) 减弱动态：不做放大/上浮，只保留信息就位。
        const expandScale = REDUCED_MOTION ? 1 : 0.88 + 0.12 * expandK
        const enterAlpha = REDUCED_MOTION ? 1 : expandFadeK
        const enterY = REDUCED_MOTION ? 0 : 8 * s * (1 - expandK)
        currentLineEl.style.setProperty('--modeng-enter-y', `${enterY.toFixed(2)}px`)
        currentLineEl.style.setProperty('--modeng-enter-scale', expandScale.toFixed(4))
        currentLineEl.style.setProperty('--modeng-enter-alpha', enterAlpha.toFixed(4))
      }
      // 相邻行错峰跟随（逆向行步长系数 0.04s，0x2F76F7 循环步长）：
      //   离当前行每远一行，波浪延后 0.04s 启动，位移幅度随距离衰减 —— 形成"涟漪向外扩散"。
      //   位移由 back 曲线 k 从 0→1 收敛回 0（临时扰动，动画结束回到布局稳态，无跳变）；
      //   整列位置本身由下面的滚动跟随统一推进。
      const splitStrength = (d: number) => {
        const ad = Math.abs(d)
        if (ad === 1) return 1
        if (ad === 2) return 0.62
        if (ad === 3) return 0.38
        return 0
      }
      const SPLIT_STAGGER_S = LB_THRESHOLD.wordStep
      const writeSplit = (lineEl: HTMLDivElement | undefined, d: number) => {
        const ad = Math.abs(d)
        // 距当前行越远，位移曲线越晚启动（错峰波浪）
        const delayed = Math.max(0, switchSecFull - (ad - 1) * SPLIT_STAGGER_S)
        const kHere = evalCurve(LB_EASING.switch, delayed)
        // 位移：上一行向上（负）/ 下一行向下（正），随曲线收敛回 0；减弱动态时不做拆分
        const amt = REDUCED_MOTION ? 0 : (d < 0 ? -14 : 18) * (1 - kHere) * splitStrength(d)
        const varName = d < 0 ? '--modeng-leave-y' : '--modeng-next-y'
        if (lineEl && Math.abs(amt) > 0.01) {
          lineEl.style.setProperty(varName, `${amt.toFixed(2)}px`)
        } else if (lineEl) {
          lineEl.style.removeProperty(varName)
        }
      }
      writeSplit(lineDomRefs.current.get(idx - 1), -1)
      writeSplit(lineDomRefs.current.get(idx - 2), -2)
      writeSplit(lineDomRefs.current.get(idx - 3), -3)
      writeSplit(lineDomRefs.current.get(idx + 1), 1)
      writeSplit(lineDomRefs.current.get(idx + 2), 2)
      writeSplit(lineDomRefs.current.get(idx + 3), 3)

      // —— 3. 背景采色 + 节拍脉动（球体光晕 opacity+scale 跟随 beatPhase，
      //          精确复刻 LyricsBlossom `uHoldRatio` 强拍曲线：
      //          - 前 12% 时长（≈0~108ms）：hold = 常数 "强拍保持" 峰值 1.0
      //          - 0.12~0.44 段（≈320ms）：holdRatio 从 0 线性推进到 1，对应 env 按
      //            二次幂衰减 1 → 0，对齐 back 回弹 0.32s 曲线尾部
      //          - 0.44~1.0 段：空窗（env=0），下一拍重新激发。）
      {
        let holdRatio = 0 // uHoldRatio uniform
        let env = 0 // 球体光晕实际包络（1=峰值, 0=静息）——高频快拍（每拍起始强拍）
        // 双频段：bass 为半速慢涌（拍中段达到峰值，与外层 env 快拍互补），叠加出"低频沉稳铺底、
        //   高频快松弛紧"的分层律动，更贴近 Apple 封面光晕随低音/鼓点分频脉动的观感。
        let bass = 0
        if (playing) {
          if (beatPhase < 0.12) {
            holdRatio = 0 // 强拍保持段：uHoldRatio 尚未开始增长
            env = 1
          } else if (beatPhase < 0.44) {
            const p = (beatPhase - 0.12) / 0.32 // 0..1 (0.32s 衰减)
            holdRatio = p
            env = Math.pow(1 - p, 2.0) // quadratic decay
          } else {
            holdRatio = 1
            env = 0
          }
          // bass 半拍期慢涌：0→1 在拍中段达峰、拍末回落（与 env 错峰）
          bass = Math.pow(0.5 - 0.5 * Math.cos(beatPhase * Math.PI), 2)
        } else {
          holdRatio = 1
          env = 0
          bass = 0
        }
        if (beatHaloRef.current) {
          beatHaloRef.current.style.setProperty('--modeng-beat-env', env.toFixed(3))
          beatHaloRef.current.style.setProperty('--modeng-beat-hold-ratio', holdRatio.toFixed(3))
          // 外层白色球体轮廓：静息 0.035，峰值 +0.16 = 0.195（对齐 shader u_alpha*0.3529 的亮度级）
          beatHaloRef.current.style.opacity = playing
            ? (0.035 + 0.16 * env).toFixed(3)
            : '0.035'
        }
        if (beatHaloInnerRef.current) {
          // 内层采色膨胀：用 内层合成包络 innerEnv（快拍 env×0.55 + 慢涌 bass×0.45）驱动
          //   scale 1 → 1.24（球体轮廓膨胀）；与外层 opacity 同时回落，但低频分量让主色更稳。
          const innerEnv = 0.55 * env + 0.45 * bass
          const s = 1 + 0.24 * innerEnv
          beatHaloInnerRef.current.style.transform = `scale(${s.toFixed(3)})`
          // 内层 opacity：静息 0.08 保持基础 tint，峰值随合成包络抬升
          beatHaloInnerRef.current.style.opacity = (0.08 + 0.50 * innerEnv).toFixed(3)
        }
        // Apple Gaussian 光粒子：按双频段包络 + 各自相位脉动/飘移
        particleRefs.current.forEach((pEl, i) => {
          const p = PARTICLES[i]
          if (!pEl || !p) return
          // (无障碍) 减弱动态：隐藏装饰性光粒子，避免闪烁眩光
          if (REDUCED_MOTION) {
            pEl.style.opacity = '0'
            pEl.style.transform = 'translateZ(0)'
            return
          }
          // 缓慢横向飘移（不依赖节拍，营造"光斑缓慢散布"的悬浮感）
          const driftX = Math.sin(wall * 0.00012 + p.phase * Math.PI * 2) * p.drift * s
          // 脉动单元：各自倍频后的正弦呼吸（0.3 静止下限，暂停时静止）
          const pulseUnit = playing
            ? 0.5 + 0.5 * Math.sin(beatPhase * Math.PI * 2 * p.speed + p.phase * Math.PI * 2)
            : 0.3
          // 双频段合包络 × 呼吸单元：vstrong 拍时最盛，拍间随 bass 缓落
          const pEnv = Math.max(0, env * 0.55 + bass * 0.45) * (0.35 + 0.65 * pulseUnit)
          const yPx = pEnv * p.peakY * s
          const scale = 1 + pEnv * p.boost
          const opacity = p.alpha + pEnv * p.amp
          pEl.style.transform = `translate3d(${driftX.toFixed(1)}px, ${(-yPx).toFixed(1)}px, 0) scale(${scale.toFixed(3)})`
          pEl.style.opacity = opacity.toFixed(3)
        })
      }

      // —— 3.5 间奏三点检测：
      //   当前行（ci）与下一句的时间差 gap>4s，则进入间奏。
      //   仅在当前行已唱完（t >= lineEnd）且距离下一句仍有 >0.15s 时显示三点。
      //   - 入场逐个点亮：第 1 点(0.00s)→第 2 点(0.24s)→第 3 点(0.48s)，每点用 easeOutBack 0.20s 弹出。
      //   - 主段同步呼吸：三点完全同相位（零错峰），~0.9s 与 beat 同频，scale 1→1.30→1 sin² 曲线。
      //   - 退场：临近下一句时按 remain 错峰消点（3→2→1→开唱）。
      {
        const curLine = lyrics[ci]
        const nxtLine = lyrics[ci + 1]
        let visible = false
        let remain = 0
        let gap = 0
        let fadeIn = interludeRef.current.fadeIn
        let startedAt = interludeRef.current.startedAt
        if (curLine && nxtLine) {
          const curEnd = lineWords[ci]?.length
            ? Math.max(curLine.time, (lineWords[ci][lineWords[ci].length - 1].endTime))
            : Math.max(curLine.time, (lyrics[ci + 1]?.time ?? curLine.time + 1.5) - 0.05)
          gap = nxtLine.time - curEnd
          if (gap >= 4.0 && t >= curEnd - 0.05 && t < nxtLine.time - 0.15) {
            visible = true
            remain = Math.max(0, nxtLine.time - t)
            fadeIn = Math.min(1, fadeIn + dt / 450)
            if (startedAt === 0 || interludeRef.current.visible === false) startedAt = wall
          } else {
            fadeIn = Math.max(0, fadeIn - dt / 320)
            if (fadeIn <= 0.001) startedAt = 0
          }
        } else {
          fadeIn = Math.max(0, fadeIn - dt / 320)
          if (fadeIn <= 0.001) startedAt = 0
        }
        interludeRef.current.visible = visible
        interludeRef.current.remain = remain
        interludeRef.current.gap = gap
        interludeRef.current.fadeIn = fadeIn
        interludeRef.current.startedAt = startedAt
        // 三点动画（严格参考 DesktopLyrics `.dl-interlude-breathe` + 进度填充渐变）：
        //   - 呼吸周期 1.5s、ease-in-out 对称： translateY(-6~8px)*s + scale .92↔1.08 + opacity .70↔1.00
        //   - 三点错峰 120ms/点（同波形、同振幅，只做相位平移——呈现"整组同呼吸浪涌"效果）
        //   - 每点背景采用 progress×3 → --dot-fill 的线性渐变填充（左亮右暗，跟时间轴进度对齐）
        //   - 入场仍保留"逐个点亮"弹出（不写入背景 fill，fill 直接看进度）
        //   - 临近开唱仍错峰熄灭（3→2→1→开唱）
        if (interludeWrapRef.current && (fadeIn > 0.001 || visible)) {
          const BREATH_PERIOD_MS = 1500 // DL 基准 1.5s 呼吸（不是跟 0.9s beat，更平缓）
          const STAGGER_MS = 120        // DL 基准：120ms / 240ms
          const LIGHT_STAGGER_MS = 240  // 入场点亮：240ms / 480ms
          const LIGHT_POP_DUR_MS = 200
          // C. 间奏入场/呼吸/退场全链路走 wallForSpring：暂停时 sinceStart 停住 + 呼吸相位不推进
          const sinceStart = Math.max(0, wallForSpring - startedAt)
          // 呼吸相位（DL 0%,100% 对称低谷；50% 峰值），暂停时 wallForSpring 冻结 → % 运算值固定 → 相位冻结
          const globalPhase = playing
            ? ((wallForSpring % BREATH_PERIOD_MS) / BREATH_PERIOD_MS)
            : 0.5
          // 把 0~1 phase 映射到 ease-in-out 曲线 ~ sin²(π·phase) 的补，形成 0,1=低谷、0.5=峰值。
          //   breathUnit = 0 at edges, 1 at 0.5 (exactly match DL ease-in-out midpoint)
          const toEaseUnit = (p: number) => {
            const x = (p % 1) * Math.PI
            const s = Math.sin(x)
            return s * s // ∈ [0..1], 对称，两端0、中间1
          }
          // 入场整体 appearK（柔和铺开，避免点亮时 translate 直接大位移）
          const appearK = clamp01(sinceStart / 280)
          const appearEase = easeOut(appearK)
          // 退场：remain < 1.2s 开始压，最后 0.15s 快速灭掉
          let vanishAlpha = 1
          let vanishScale = 1
          if (visible) {
            const VANISH_WINDOW_S = 1.2
            if (remain < VANISH_WINDOW_S) {
              const vp = 1 - clamp01(remain / VANISH_WINDOW_S)
              vanishScale = 1 - 0.30 * vp
              vanishAlpha = 1 - easeOut(vp)
            }
          } else {
            vanishScale = 0.8
            vanishAlpha = 0
          }
          // 进度填充：gap>0 时按 (gap-remain)/gap 线性推进；
          //   每点 fill% = clamp( progress×3 - i , 0, 1 ) × 100%（逐点从空→满，对应 DL）
          const progress = gap > 0 ? clamp01((gap - remain) / gap) : 0
          // 容器：整体 opacity = fadeIn × vanishAlpha × appearEase；
          //        整体微缩放 vanishScale × appearEase（不叠加呼吸，呼吸交给每个 dot，保持错峰波形）
          const overallScale = appearEase * vanishScale
          const overallAlpha = fadeIn * vanishAlpha * appearEase
          interludeWrapRef.current.style.transform = `translateZ(0) scale(${overallScale.toFixed(3)})`
          interludeWrapRef.current.style.transformOrigin = 'left 45%'
          interludeWrapRef.current.style.opacity = overallAlpha.toFixed(3)
          // 间距&行高按 fadeIn 线性插值
          const padTop = 24 * s * fadeIn
          const padBottom = 22 * s * fadeIn
          const minH = 76 * s * fadeIn
          interludeWrapRef.current.style.setProperty('--modeng-interlude-pad-top', `${padTop.toFixed(1)}px`)
          interludeWrapRef.current.style.setProperty('--modeng-interlude-pad-bottom', `${padBottom.toFixed(1)}px`)
          interludeWrapRef.current.style.setProperty('--modeng-interlude-min-h', `${minH.toFixed(1)}px`)
          // 逐点：入场点亮 + DL 错峰呼吸 translateY/scale/opacity + 临近开唱错峰熄灭 + progress 填充渐变
          for (let i = 0; i < 3; i++) {
            const dot = interludeWrapRef.current.children[i] as HTMLElement | undefined
            if (!dot) continue
            // 1) 入场点亮：错峰 240ms
            const startI = i * LIGHT_STAGGER_MS
            const lightRaw = clamp01((sinceStart - startI) / LIGHT_POP_DUR_MS)
            const lightK = easeOut(lightRaw)
            const popScale = 0.70 + 0.30 * lightK // 0.7 → 1.0，无过冲
            const popAlpha = clamp01(lightRaw * 1.8)
            // 2) DL 基准呼吸：错峰 120ms/点；ease-in-out 对称曲线
            const localPhase = (globalPhase - (i * STAGGER_MS) / BREATH_PERIOD_MS + 1) % 1
            // (无障碍) 减弱动态：三点保持静态 0.70 亮度（不做呼吸/缩放）
            const bu = REDUCED_MOTION ? 0 : toEaseUnit(localPhase) // 0..1
            // DL: 0%,100% y=0 scale=.92 op=.7 ; 50% y=-.06em scale=1.08 op=1
            //   =>  scale = .92 + .16·bu  ; translateY = -7.2*s·bu  (s 是当前行 scale；12×s 圆点 ≈ .22em×(lineHeight 对应 em)，取 7.2s 等价 .06em 位移量级)
            //   =>  alpha = .70 + .30·bu
            const breathScale = 0.92 + 0.16 * bu
            const breathY = -7.2 * s * bu
            const breathAlpha = 0.70 + 0.30 * bu
            // 呼吸按入场完成度渐进混入（点亮前 55%→95% 过渡到 100%），避免入场弹入 + 呼吸叠加乱抖
            const breathMix = clamp01((lightRaw - 0.55) / 0.40)
            const mixedScale = popScale * (1 + (breathScale - 1) * breathMix)
            const mixedY = breathY * breathMix
            const mixedAlpha = popAlpha * (1 + (breathAlpha - 1) * breathMix)
            // 3) 临近开唱错峰熄灭
            let localVanish = 1
            let localVanishScale = 1
            if (visible && remain < (3 - i) * 0.30) {
              const localP = 1 - clamp01(remain / Math.max(0.001, (3 - i) * 0.30))
              localVanish = 1 - localP
              localVanishScale = 1 - 0.45 * localP
            } else if (!visible) {
              localVanish = 0
              localVanishScale = 0.85
            }
            const finalDotScale = mixedScale * localVanishScale
            const finalDotAlpha = mixedAlpha * localVanish
            dot.style.transform = `translateY(${mixedY.toFixed(2)}px) translateZ(0) scale(${finalDotScale.toFixed(3)})`
            dot.style.opacity = finalDotAlpha.toFixed(3)
            // 4) DL 式 --dot-fill 进度渐变填充（左亮右暗）：
            //     每点 fill% = clamp( progress*3 - i , 0..1 )；
            //     DL 用 linear-gradient(90deg, #fff 0 fill%, unsung 40% fill%)，对应"填色推进条"。
            const fill = Math.max(0, Math.min(1, progress * 3 - i))
            const fillPct = `${(fill * 100).toFixed(1)}%`
            dot.style.setProperty('--dot-fill', fillPct)
            // 动态写 background 覆盖 inline 默认色（仍然保持阴影由外层 box-shadow 提供）
            if (dark) {
              dot.style.background =
                `linear-gradient(90deg, rgba(235,235,245,0.95) 0 ${fillPct}, rgba(235,235,245,0.26) ${fillPct} 100%)`
            } else {
              dot.style.background =
                `linear-gradient(90deg, rgba(60,60,67,0.88) 0 ${fillPct}, rgba(60,60,67,0.20) ${fillPct} 100%)`
            }
          }
        } else if (interludeWrapRef.current) {
          const f = interludeRef.current.fadeIn
          interludeWrapRef.current.style.opacity = f > 0.001 ? String(f.toFixed(3)) : '0'
          // 未显示时也要把间距归零，避免留下空洞把翻译行顶开
          if (f <= 0.001) {
            interludeWrapRef.current.style.setProperty('--modeng-interlude-pad-top', '0px')
            interludeWrapRef.current.style.setProperty('--modeng-interlude-pad-bottom', '0px')
            interludeWrapRef.current.style.setProperty('--modeng-interlude-min-h', '0px')
          }
        }
      }

      // —— 4. 进度条 / 时间标签 ——
      //   注意：这几行写的是进度条（左栏）的样式，而第 5 段要读歌词列（右栏）的真实几何。
      //   写样式会作废布局缓存，紧接着读 rect 就强制同步重排（每帧一次，120fps 下开销可观）。
      //   进度条是绝对定位、且在另一列，它的宽度不影响歌词行几何，所以把这两组写操作
      //   挪到第 5 段之后：先读后写，读数与原先完全一致，且不再触发强制重排。
      const dur = durationRef.current
      const clampedNow = Math.min(t, dur > 0 ? dur : t)

      // —— 5. 整列滚动 scrollSpring（AMLL）：当前行居中，rAF 唯一驱动 translateY ——
      //   translateY 为正 = 内容下移；为负 = 内容上移。
      //   目标：让第 ci 行的中心停在 currentY。行高不恒定（罗马音/翻译/换行），
      //   因此用真实 DOM 几何（getBoundingClientRect）计算，避免估算 lineH 导致的越滚越偏。
      const wrapEl = scrollContentWrapRef.current
      const curLineEl = lineDomRefs.current.get(ci)
      const listCount = lyrics.length
      if (listCount > 0 && wrapEl && curLineEl) {
        const wrapTop = wrapEl.getBoundingClientRect().top
        const centerRel = curLineEl.getBoundingClientRect().top - wrapTop + curLineEl.offsetHeight / 2
        const targetOffset = currentY - centerRel
        // 可滚动范围（用首尾行真实中心）：
        //   topLimit    = 第 0 行居中时的 translateY（内容尽可能下移）
        //   bottomLimit = 最后一行居中时的 translateY（内容向上滚到底）
        const firstEl = lineDomRefs.current.get(0)
        const lastEl = lineDomRefs.current.get(listCount - 1)
        const firstCenter = firstEl ? firstEl.getBoundingClientRect().top - wrapTop + firstEl.offsetHeight / 2 : centerRel
        const lastCenter = lastEl ? lastEl.getBoundingClientRect().top - wrapTop + lastEl.offsetHeight / 2 : centerRel
        const topLimit = currentY - firstCenter
        const bottomLimit = currentY - lastCenter
        const baseTarget = Math.max(bottomLimit, Math.min(topLimit, targetOffset))
        const scr = scrubRef.current
        if (scr.active) {
          // 拖拽预览：跟随目标 + 用户位移，端部做橡皮筋阻力(0.35)，不硬裁 → 松手才回弹
          const userTarget = baseTarget + scr.offset
          let rubber: number
          if (userTarget > topLimit) {
            rubber = topLimit + (userTarget - topLimit) * 0.35
          } else if (userTarget < bottomLimit) {
            rubber = bottomLimit + (userTarget - bottomLimit) * 0.35
          } else {
            rubber = userTarget
          }
          scrollPosRef.current = rubber
        } else if (REDUCED_MOTION) {
          // (无障碍) 减弱动态：滚动立即跳到当前行，不做弹簧逼近
          scrollPosRef.current = baseTarget
          scr.offset = 0
        } else {
          // 松开：跟随弹簧 + 距离自适应速率（偏差大则更快逼近、偏差小则缓落，避免"梯跳"）。
          //   松手后若仍在回弹（scr.offset≠0），也要继续收敛到当前行（不受播放/暂停限制）。
          const returning = Math.abs(scr.offset) > 0.5
          const distErr = Math.abs(baseTarget - scrollPosRef.current)
          const rate = SCROLL_FOLLOW_RATE + Math.min(12, distErr / 24)
          const dtSec = dt / 1000
          const blend = 1 - Math.exp(-rate * (dtSec > 0 ? dtSec : 0.0166))
          if (!scrollBootRef.current) {
            scrollPosRef.current = baseTarget
            scrollBootRef.current = true
          }
          // 跟随不再受 playing 门控：暂停状态下拖动进度条 / 点击某行 seek 时，列表同样要平滑滚到
          //   新的当前行；否则当前行会跑出视口，用户看到的是一列错位的歌词（实机比对时发现的缺陷）。
          scrollPosRef.current += (baseTarget - scrollPosRef.current) * blend
          ;(paint as any)._scrollSettling = Math.abs(baseTarget - scrollPosRef.current) > 0.5
          // 回弹归位后清零用户位移，避免下次切行时残留偏移
          if (returning && Math.abs(baseTarget - scrollPosRef.current) < 0.5) scr.offset = 0
        }
        wrapEl.style.transform = `translateY(${scrollPosRef.current.toFixed(2)}px)`
      }

      // —— 5.5 进度条 / 时间标签（见第 4 段注释：挪到几何读取之后，避免每帧强制重排）——
      if (progressFillRef.current) {
        progressFillRef.current.style.width = dur > 0 ? `${clamp01(clampedNow / dur) * 100}%` : '0%'
      }
      if (elapsedRef.current) elapsedRef.current.textContent = formatTime(clampedNow)
      if (remainRef.current) remainRef.current.textContent = `-${formatTime(Math.max(0, dur - clampedNow))}`
      // —— 6. 暂停时是否仍需继续跑帧（供 tick 的 shouldRun 判断）——
      //   行切换窗口未走完 / 间奏仍在淡入淡出 / 拖拽回弹未归位 —— 任一成立就继续驱动，
      //   保证"暂停后 seek"也能看到完整的行进入动画，而不是卡在 opacity≈0 的首帧。
      ;(paint as any)._animating =
        (wall - switchAtRef.current) < (LB_EASING.expandFade.duration * 1000 + 150) ||
        interludeRef.current.fadeIn > 0.001 ||
        Math.abs(scrubRef.current.offset) > 0.5 ||
        (paint as any)._scrollSettling === true
    }

    // 暂停时是否仍需继续跑帧：行切换 / 橡皮筋回弹 / 间奏淡入淡出这类"UI 过渡"必须走完，
    //   否则暂停状态下拖动进度条或点击某行 seek 时，新行会永远停在入场首帧
    //   （alpha≈0 → 整行歌词不可见）。_animating 由 paint() 每帧写入。
    const shouldRun = () => playing || (paint as any)._animating === true

    const tick = (wall: number) => {
      if (lastPaint && wall - lastPaint < 1000 / 120) {
        raf = shouldRun() && document.visibilityState === 'visible' ? requestAnimationFrame(tick) : 0
        return
      }
      const dt = lastPaint ? (wall - lastPaint) : 16.6
      lastPaint = wall
      if (playing) beatPhase = (beatPhase + dt / BEAT_PERIOD_MS) % 1
      const extrapolated = playing ? (wall - anchorWall) / 1000 : 0
      paint(anchorTime + extrapolated, wall, dt)
      raf = shouldRun() && document.visibilityState === 'visible' ? requestAnimationFrame(tick) : 0
    }

    const sync = () => {
      const snapshot = playbackTimeStore.getSnapshot()
      anchorTime = snapshot.currentTime
      anchorWall = performance.now()
      playing = snapshot.isPlaying
      if (snapshot.duration > 0) durationRef.current = snapshot.duration
      paint(anchorTime, anchorWall, 16.6)
      if (shouldRun() && !raf && document.visibilityState === 'visible') raf = requestAnimationFrame(tick)
    }

    sync()
    const unsubscribe = playbackTimeStore.subscribe(sync)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && shouldRun() && !raf) raf = requestAnimationFrame(tick)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }
    // s 也必须入依赖：窗口尺寸变化会改变 s / lineH / currentY，而这些被 paint 闭包捕获；
    //   若不入依赖，rAF 仍按旧尺寸计算滚动与行距（实机比对时窗口尺寸不等于默认 951 即暴露：
    //   当前行会被滚到视口外，而非停在 41% 锚点）。
  }, [currentIndex, lyrics, lineWords, playbackTimeStore, timeOffset, s])

  // ---- 拖拽（进度条 / 音量） ----
  const dragBar = (event: React.PointerEvent<HTMLDivElement>, onFrac: (frac: number) => void) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const apply = (clientX: number) => onFrac(clamp01((clientX - rect.left) / rect.width))
    apply(event.clientX)
    const move = (e: PointerEvent) => apply(e.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (dragCleanupRef.current === up) dragCleanupRef.current = null
    }
    dragCleanupRef.current = up
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- 主题色（对齐 LyricsBlossom 逆向色板：暗色底 0xff202022 / 副文字 0xa0ebebf5；
  //      亮色底 0xfffafafc / 主文字 0xff1c1c1e / 副文字 0x963c3c43）----
  const c = dark
    ? {
        base: '#202022',
        lineSung: '#ffffff',
        lineUnsungCurrent: 'rgba(235,235,245,0.627)',
        title: '#ffffff',
        sub: 'rgba(235,235,245,0.629)',
        dim: 'rgba(235,235,245,0.4)',
        barTrack: 'rgba(255,255,255,0.25)',
        barFill: 'rgba(255,255,255,0.75)',
        volTrack: 'rgba(255,255,255,0.3)',
        volFill: 'rgba(255,255,255,0.6)',
        chip: 'rgba(255,255,255,0.12)',
        placeholder: '#48484a',
        placeholderIcon: 'rgba(255,255,255,0.28)',
        overlay: 'linear-gradient(180deg, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.12) 50%, rgba(0,0,0,0.50) 100%)',
        coverShadow: '0 24px 60px rgba(0,0,0,0.45)',
      }
    : {
        base: '#fafafc',
        lineSung: '#1c1c1e',
        lineUnsungCurrent: 'rgba(60,60,67,0.588)',
        title: '#1c1c1e',
        sub: 'rgba(60,60,67,0.588)',
        dim: 'rgba(60,60,67,0.4)',
        barTrack: 'rgba(0,0,0,0.15)',
        barFill: 'rgba(0,0,0,0.65)',
        volTrack: 'rgba(0,0,0,0.18)',
        volFill: 'rgba(0,0,0,0.5)',
        chip: 'rgba(0,0,0,0.08)',
        placeholder: '#d8d8dc',
        placeholderIcon: 'rgba(0,0,0,0.25)',
        overlay: 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.10) 55%, rgba(255,255,255,0.42) 100%)',
        coverShadow: '0 24px 60px rgba(0,0,0,0.18)',
      }

  const lineFadeFor = (distance: number) =>
    LINE_FADE[Math.min(Math.abs(distance) - 1, LINE_FADE.length - 1)] ?? 0.15
  const lineColor = (distance: number, agent?: string) => {
    const fade = lineFadeFor(distance)
    const tint = duetLineColor(agent, fade)
    if (tint) return tint
    // 亮色非当前行用 LyricsBlossom 主文字色 #1c1c1e=rgb(28,28,30) + fade
    return dark ? `rgba(255,255,255,${fade})` : `rgba(28,28,30,${Math.min(1, fade + 0.08)})`
  }
  const lineBlur = (distance: number) => {
    const d = Math.abs(distance)
    if (d === 0) return 0
    return (LINE_BLUR[Math.min(d - 1, LINE_BLUR.length - 1)] ?? 9) * s
  }

  // ---- 左右交替歌词：按歌曲结构决定每行对齐（Apple Music 特殊歌词风格，仅本模式）----
  //   对唱（≥2 演唱者）：按 agent 分工，后续演唱者的行靠右；
  //   普通歌：两句间隔 > PARAGRAPH_GAP_S 视为分段，奇数段靠右、偶数段靠左 → 形成"左→右→左"。
  const sideAgents = useMemo(
    () => Array.from(new Set(lyrics.map(l => l.agent).filter(Boolean))),
    [lyrics],
  )
  const PARAGRAPH_GAP_S = 2.0
  const lineSideOf = (index: number): 'left' | 'right' => {
    if (sideAgents.length >= 2) {
      const agent = lyrics[index]?.agent
      if (agent && sideAgents.indexOf(agent) % 2 === 1) return 'right'
      return 'left'
    }
    let paragraph = 0
    for (let i = 1; i <= index; i++) {
      if (lyrics[i] && lyrics[i - 1] && lyrics[i].time - lyrics[i - 1].time >= PARAGRAPH_GAP_S) paragraph++
    }
    return paragraph % 2 === 1 ? 'right' : 'left'
  }
  /** 单行最终对齐侧：未开启"左右交替"时统一靠左（与下方 alignItems 的 sideAlign 分支同义，供两处渲染复用） */
  const lineSideFor = (index: number) => (sideAlign ? lineSideOf(index) : 'left')

  const VolumeIcon = volume <= 0.001 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  return (
    <div
      ref={rootRef}
      className={`absolute inset-0 overflow-hidden select-none ${dark ? '' : 'modeng-lyric-light'}`}
      style={{
        background: mvBackgroundActive ? 'transparent' : c.base,
        // 封面兜底层淡入淡出：MV 对齐丢失（回退封面）时背景不硬切——
        // background 从透明到 base 过渡 500ms，配合 MV 层清槽让旧帧平滑退场
        transition: 'background 500ms ease-in-out',
        fontFamily: FONT_STACK,
        WebkitFontSmoothing: 'antialiased',
        MozOsxFontSmoothing: 'grayscale',
      } as React.CSSProperties}
    >
      <style>{`
        /* 摩登模式专属交互动画：与其他歌词模式完全隔离（作用域限定在 root 内部 className）。
           玻璃阴影参数对齐 LyricsBlossom SkSL shader：
             u_sigma  = 28 * s * k   （高斯半径，随交互强度 k 变化）
             u_offset =  6 * s * k   （Y 轴偏移，方向 [0, 6s]，k=进度 0..1）
             u_alpha  = 进度 × 0.3529（不透明度：最大 0.3529 对齐 0x5a alpha）
           用"多层 box-shadow 叠加"近似 SDF 软阴影，因为浏览器无原生 SDF 阴影：
             核心阴影 = 0 Ypx (sigma)px rgba(0,0,0,alpha)
             辅助近影 = 0 (Y/2)px (sigma/3)px rgba(0,0,0,alpha×0.85)
             高光描边 = inset 0 1px 0 rgba(255,255,255, 0.10 + k×0.10)
           k 的取值：idle=0.18、hover=0.52、active=0.10（按下时阴影"收近"对应物理贴近）。
           按钮按下态（缩小 0.92 + 加深玻璃阴影）+ 悬停（微放大 + 高光）。使用 cubic-bezier back 曲线对齐歌词的 spring。 */
        .modeng-btn {
          transition:
            transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1),
            background-color 200ms ease-out,
            box-shadow 200ms ease-out,
            border-color 200ms ease-out,
            filter 200ms ease-out,
            opacity 180ms ease-out,
            color 200ms ease-out;
          transform-origin: center center;
          transform-box: fill-box;
          user-select: none;
          -webkit-tap-highlight-color: transparent;
          outline: none;
          border: none;
          cursor: pointer;
          will-change: transform;
        }
        .modeng-btn:hover:not(:disabled) {
          transform: scale(1.06);
        }
        .modeng-btn:active:not(:disabled) {
          transform: scale(0.90);
          transition: transform 90ms cubic-bezier(0.4, 0, 0.2, 1), background-color 90ms ease-in, box-shadow 90ms ease-in, border-color 90ms ease-in;
        }
        .modeng-btn:focus-visible {
          outline: 2px solid rgba(255,255,255,0.35);
          outline-offset: 2px;
        }
        .modeng-btn:disabled {
          cursor: not-allowed;
          transform: scale(1) !important;
          filter: grayscale(0.2) !important;
        }
        /* 圆形"主按钮"（播放/暂停/上下首）：纯图标无底色。
           drop-shadow 按 SDF shader 比例：
             idle   k=0.10  → sigma=5.6  offset=1.2  alpha=0.035  → 0 1px 3px rgba(0,0,0,.20)
             hover  k=0.40  → sigma=22.4 offset=4.8  alpha=0.141  → 0 5px 22px rgba(0,0,0,.30) 叠加近影
             active k=0.08  → sigma=4.5  offset=0.96 alpha=0.028  → 0 1px 2px rgba(0,0,0,.25) */
        .modeng-btn-primary {
          filter:
            drop-shadow(0 1px 2px rgba(0,0,0,0.18))
            drop-shadow(0 1px 4px rgba(0,0,0,0.12));
        }
        .modeng-btn-primary:hover:not(:disabled) {
          filter:
            drop-shadow(0 2px 6px rgba(0,0,0,0.24))
            drop-shadow(0 5px 22px rgba(0,0,0,0.22));
        }
        .modeng-btn-primary:active:not(:disabled) {
          filter:
            drop-shadow(0 1px 2px rgba(0,0,0,0.30));
        }
        /* 页脚圆角按钮（翻译/罗马音/评论）：玻璃拟态 —— 多层阴影模拟 SDF。
           sigma=28×k×s，offset=6×k×s。为保持与分辨率无关，s 用"CSS 像素"近似常量 1（在 button 局部
           空间内），让 box-shadow 的实际像素值与 k 成正比。
           idle  : k=0.18 → σ≈5, off≈1.1, α≈0.064  → 阴影轻、近、淡
           hover : k=0.52 → σ≈15, off≈3.1, α≈0.184 → 阴影中、远、较深
           active: k=0.10 → σ≈3, off≈0.6, α≈0.035 → 阴影收近，并叠内阴影"下陷"
           高光描边：idle 0.07 / hover 0.18 / active 0.04，模拟玻璃顶光强度变化。 */
        .modeng-btn-chip {
          backdrop-filter: blur(8px) saturate(1.15);
          -webkit-backdrop-filter: blur(8px) saturate(1.15);
          border: 1px solid rgba(255,255,255,0.07);
          /* 3 层阴影 + 高光 = SDF 近似：
               1. 近距硬阴影（sigma/3）：0 1px 2px rgba(0,0,0, 0.064×1.35)
               2. 中距软阴影（sigma）  ：0 2px 6px rgba(0,0,0, 0.064)
               3. 远距扩散（sigma×2.4）：0 4px 14px rgba(0,0,0, 0.064×0.55)
               4. 高光内描边           ：inset 0 1px 0 rgba(255,255,255, 0.07)
          */
          box-shadow:
            0 1px 2px rgba(0,0,0, 0.086),
            0 2px 6px rgba(0,0,0, 0.064),
            0 4px 14px rgba(0,0,0, 0.035),
            inset 0 1px 0 rgba(255,255,255, 0.07);
        }
        .modeng-btn-chip:hover:not(:disabled) {
          border-color: rgba(255,255,255,0.18);
          /* k=0.52：alpha=0.184；高光 0.18 */
          box-shadow:
            0 2px 5px rgba(0,0,0, 0.248),
            0 4px 15px rgba(0,0,0, 0.184),
            0 8px 36px rgba(0,0,0, 0.101),
            inset 0 1px 0 rgba(255,255,255, 0.18);
        }
        .modeng-btn-chip:active:not(:disabled) {
          border-color: rgba(255,255,255,0.04);
          /* k=0.10：alpha=0.035；高光压低，内阴影下陷 */
          box-shadow:
            0 1px 2px rgba(0,0,0, 0.047),
            0 1px 3px rgba(0,0,0, 0.035),
            0 2px 8px rgba(0,0,0, 0.019),
            inset 0 2px 6px rgba(0,0,0, 0.28),
            inset 0 1px 0 rgba(255,255,255, 0.04);
        }
        /* 歌词行"进入/离开"动画：通过 CSS var 被 rAF 脚本写入数值（easeOut/0.32s）。
           transition 仅过渡 blur/color/font-size 等"行级稳态变化"；位移与缩放由 JS 每帧直写，避免与 transition 冲突。
           内部 inner-wrap 读取 --modeng-enter-y/--modeng-leave-y/--modeng-next-y（Y 轴位移）与
           --modeng-enter-scale（缩放）；--modeng-enter-alpha / --modeng-leave-alpha 控制淡入淡出。
           注意：位移统一在 translate3d 的第二个参数（Y 轴）；X 轴始终 0，避免把行挤出右栏左边界导致歌词左端被裁切。
        */
        .modeng-lyric-line > .modeng-line-wrap {
          transform:
            translate3d(
              0,
              calc(var(--modeng-enter-y, 0px) + var(--modeng-leave-y, 0px) + var(--modeng-next-y, 0px)),
              0
            )
            scale(var(--modeng-enter-scale, 1));
          opacity: calc(var(--modeng-enter-alpha, 1) * var(--modeng-leave-alpha, 1));
          will-change: transform, opacity;
          padding: 0 16px;
          box-sizing: border-box;
        }
        /* 逐词高亮：回归 LyricsBlossom 实机风格（也是用户新截图呈现的效果）。
           - 每一词/字一个独立颜色，由 rAF 每帧写 el.style.color = mixWordColor(prog)。
             整字做 ARGB 线性插值，不会出现 background-clip:text 那种"把一个字竖着切成两段"的观感；
             对中文单字尤其重要，截图里"美人画卷残留"等当前行都是整字明亮/整字暗淡交替。
           - 保留 Apple Music 带来的"smooth progression"手感：当前词 prog 在 0→1 之间时，
             颜色会从 unsung 连续插值到 sung，行间自然形成由亮到暗的推进，而不是硬跳。
           - 2026-09-12 修 descender 截断：已把主歌词文本行 line-height 从 1.15 提到 1.4，
             确保 y/g/p/q/j 下伸笔画在 inline-block 盒内，纯色渲染也不会被截。
        */
        .modeng-word {
          will-change: color;
          font-synthesis-weight: none;
        }
        /* 鼠标悬停在歌词区时，取消整列非当前行的模糊（LyricsBlossom 的"看清未播放歌词"手感）。
           CSS 直接 !important 覆盖行级 --modeng-line-blur 的 filter，零 JS / 零 React 重渲染。 */
        .modeng-lyric-list.modeng-hovering .modeng-line-wrap {
          filter: blur(0px) !important;
        }
        /* 鼠标所在行：显示胶囊底框（圆角矩形 + 0.216 alpha，与选区胶囊同 alpha 但整行覆盖）。
           line-wrap 已经包含 transform/transform-origin 等，所以给 ::before 加 position:absolute + z-index:-1
           需要先在 line-wrap 上建立独立层叠上下文（position:relative + z-index:0）。 */
        .modeng-line-wrap { position: relative; z-index: 0; }
        .modeng-line-wrap::before {
          content: '';
          position: absolute;
          left: 0; right: 0;
          top: 2%; bottom: 2%;
          border-radius: 0.32em;
          background: rgba(255, 255, 255, 1);
          opacity: 0;
          pointer-events: none;
          z-index: -1;
          transition: opacity 0.18s ease;
        }
        .modeng-lyric-line.modeng-line-hovered .modeng-line-wrap::before {
          opacity: 0.216;
        }
        .modeng-lyric-light .modeng-line-wrap::before {
          background: rgba(0, 0, 0, 1);
        }
        /* enableBlur：把整行 blur 从 JSX 内联 filter 统一收敛到类名 + CSS 变量。
           原因：JSX style 的 filter: blur() 与 transition.filter + 行内 transform 互相竞争，
           有时会让浏览器重绘整行（含重排）导致字级 rAF 动画掉帧。改为类名切换后，
           变化的只有 --modeng-line-blur 值，浏览器只更新 filter 值不重走 transition。 */
        .modeng-blur-enabled > .modeng-line-wrap {
          filter: blur(var(--modeng-line-blur, 0px));
        }
        /* enableScale：非当前行按距离的 scale 渐进（0.86→1.0，与 LINE_FADE 亮度同阶梯）。
           与行切换 enter-scale 叠加的思路：
             行切换的 --modeng-enter-scale 是"进入过程中"的临时 scale，最终会收敛到 1；
             本 scale 是"行稳定在视口时"的稳态 scale（current=1，distance↑ scale↓）。
             两者相乘：进入瞬间非 current 行 = 进入弹簧(0.92~1.0) × 稳态(0.86~1.0)，
             视觉上"远行更小、近行更大"，完全对齐 AMLL 逐行 scale spring 的稳态值。 */
        .modeng-lyric-line > .modeng-line-wrap {
          transform:
            translate3d(
              0,
              calc(var(--modeng-enter-y, 0px) + var(--modeng-leave-y, 0px) + var(--modeng-next-y, 0px) + var(--modeng-split-y, 0px)),
              0
            )
            scale(calc(var(--modeng-enter-scale, 1) * var(--modeng-distance-scale, 1)));
          opacity: calc(var(--modeng-enter-alpha, 1) * var(--modeng-leave-alpha, 1));
          will-change: transform, opacity;
          padding: 0 16px;
          box-sizing: border-box;
        }
        /* 辉光仅由"正在唱的字"承担（rAF 内联 text-shadow），不再给整行 .modeng-word 加常驻辉光。
           原因：整行白辉光会让当前句所有字一起发亮 → 逐字点亮对比被冲淡、整屏发白（"过曝"）。
           去掉后：亮面只跟着正在唱的字移动，逐字效果更清晰，整体更收敛。 */
        /* 歌词行按压反馈：最外层行容器在 :active 时轻压（缩放 + 微下沉），
           与按钮交互动画保持一致（0.09s 按下、0.18s 回弹）。transform 基类统一放这里，
           不再用 inline translateZ(0)，否则 :active 无法覆盖。 */
        .modeng-lyric-line {
          transform: translateZ(0);
          transform-origin: center center;
          transition: transform 90ms cubic-bezier(0.4, 0, 0.2, 1);
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .modeng-lyric-line:active {
          transform: translateZ(0) scale(0.965);
          transition: transform 50ms cubic-bezier(0.4, 0, 0.2, 1);
        }
      `}</style>

      {/* 律动背景：封面强模糊（startY 渐进模糊：上层略淡、底部强化模糊并加深暗色）+ 采色双层节拍光晕。
          Apple 高置信命中时优先用 AM 高清封面做模糊源，否则用平台封面。
          所有层 pointer-events:none，不阻挡任何交互。 */}
      {!mvBackgroundActive && (appleCoverUrl || coverUrl) ? (
        <>
          {/* 全尺寸基础层：中强模糊（opacity 淡入 600ms：封面层出现不突兀，
              与 MV 层清槽的时序交叉时旧帧平滑退场——封面残留案例的视觉半边修复） */}
          <img
            src={appleCoverUrl || coverUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 h-full w-full object-cover pointer-events-none animate-in fade-in duration-700"
            style={{
              transform: 'scale(1.25)',
              filter: `blur(${60 * s}px) brightness(${dark ? 0.60 : 1.02}) saturate(0.95)`,
            }}
          />
          {/* startY 渐进模糊：底部额外叠一层更强模糊 + 纵向渐暗（严格对齐 startY=38% 视口高度，
             LyricsBlossom shader 里从 startY 向下逐渐增大 blur 强度）。
             上半截(0~38%)：base 图 mid blur 担当；下半截(38%~100%)：本层强模糊 + 渐深 mask
             mask 起点 38%=透明 → 82% 加深 → 100%=全显，以复刻 startY 纵向渐变的球体光晕感。 */}
          <img
            src={appleCoverUrl || coverUrl}
            alt=""
            draggable={false}
            className="absolute left-0 right-0 bottom-0 w-full pointer-events-none"
            style={{
              top: `${size.height * 0.38}px`,
              objectFit: 'cover',
              transform: 'scale(1.32)',
              transformOrigin: 'center bottom',
              filter: `blur(${110 * s}px) brightness(${dark ? 0.42 : 0.92}) saturate(1.05)`,
              maskImage:
                'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.85) 82%, rgba(0,0,0,1) 100%)',
              WebkitMaskImage:
                'linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.85) 82%, rgba(0,0,0,1) 100%)',
            }}
          />
        </>
      ) : null}
      {/* 暗色主题 overlay（保持底色与对比度）+ 可选主色 tint（采色主导） */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: c.overlay }} />
      {sampledCoverColorRef.current ? (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `linear-gradient(160deg, ${hexToRgba(sampledCoverColorRef.current.dominant, dark ? 0.22 : 0.16)} 0%, transparent 55%, ${hexToRgba(sampledCoverColorRef.current.dark, dark ? 0.55 : 0.22)} 100%)`,
            mixBlendMode: dark ? 'screen' : 'multiply',
          }}
        />
      ) : null}

      {/* 节拍光晕：双层径向渐变 —— 外层白色柔光（球体轮廓）+ 内层采色主色（色彩脉动）。
         opacity/scale 由 rAF 脚本按 beat envelope 实时驱动，不依赖 CSS keyframes，避免与暂停/恢复不同步。 */}
      <div
        ref={beatHaloRef}
        className="absolute pointer-events-none"
        style={{
          left: 0,
          top: 0,
          width: (leftPad + coverSize + 40 * s),
          height: (coverSize + 160 * s),
          background: `radial-gradient(circle at 50% 42%, ${dark ? 'rgba(255,255,255,0.38)' : 'rgba(255,255,255,0.55)'} 0%, transparent 62%)`,
          opacity: 0.035,
          willChange: 'opacity, transform',
        }}
      >
        <div
          ref={beatHaloInnerRef}
          className="absolute inset-0 pointer-events-none"
          style={{
            background: sampledCoverColorRef.current
              ? `radial-gradient(circle at 50% 42%, ${hexToRgba(sampledCoverColorRef.current.dominant, dark ? 0.75 : 0.55)} 0%, transparent 60%)`
              : 'transparent',
            mixBlendMode: dark ? 'screen' : 'soft-light',
            transformOrigin: '50% 42%',
            transform: 'scale(1)',
            opacity: 0.15,
            willChange: 'transform, opacity',
          }}
        />
        {/* Apple Gaussian 光粒子：缓慢飘移 + 节拍脉动，白色高斯光斑散布（纯装饰，不挡交互） */}
        {PARTICLES.map((p, i) => (
          <div
            key={`modeng-particle-${i}`}
            ref={el => { particleRefs.current[i] = el }}
            className="absolute pointer-events-none"
            style={{
              left: `${(p.x * 100).toFixed(1)}%`,
              top: `${(p.y * 100).toFixed(1)}%`,
              width: p.size * s,
              height: p.size * s,
              marginLeft: -(p.size * s) / 2,
              marginTop: -(p.size * s) / 2,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${dark ? 'rgba(255,255,255,0.42)' : 'rgba(255,255,255,0.8)'} 0%, transparent 70%)`,
              mixBlendMode: dark ? 'screen' : 'soft-light',
              opacity: p.alpha,
              willChange: 'transform, opacity',
              transformOrigin: 'center center',
            }}
          />
        ))}
      </div>

      {/* 过渡期间本层保持可见：封面/标题走各自的双层交叉淡化，右栏歌词列做退场编排（见下方右栏样式） */}
      <div
        className="absolute inset-0"
      >
        {/* ---- 左栏：封面 + 信息 + 控制条（纯音乐时水平+垂直居中，不占用两栏空间） ---- */}
        <div
          className="absolute top-0 bottom-0"
          style={
            isPureMusic
              ? {
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: coverSize,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }
              : { left: leftPad, width: coverSize }
          }
        >
          {/* 内容包裹层：非纯音乐铺满高度、绝对定位子元素与原版坐标一致；纯音乐按内容高度包裹以配合 flex 垂直居中 */}
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: isPureMusic ? 950 * s : '100%',
            }}
          >
          {/* 封面（过渡期：新旧封面双层交叉淡化 + 反向 Ken Burns 缩放，融合交接而非生硬替换；
              Apple 命中时优先用 Apple 高清封面；已移除动态封面视频层 & 律动，保持纯静态避免抽搐） */}
          <div
            className="absolute overflow-hidden"
            style={{
              top: 113 * s,
              width: coverSize,
              height: coverSize,
              borderRadius: 14 * s,
              boxShadow: c.coverShadow,
              background: c.placeholder,
              transform: 'translateZ(0)',
              backfaceVisibility: 'hidden',
            }}
          >
            {coverTransitionActive ? (
              <>
                {/* 底层：旧封面，随过渡轻微放大退后 */}
                <img
                  src={transitionFromCover}
                  alt={songTitle}
                  draggable={false}
                  className="h-full w-full object-cover"
                  style={{
                    transform: `scale(${(1 + 0.05 * (1 - coverTp)).toFixed(4)}) translateZ(0)`,
                    transition: 'transform 320ms linear',
                    backfaceVisibility: 'hidden',
                  }}
                />
                {/* 顶层：新封面，淡入并从轻微放大回落到 1（旧退新进的「融合呼吸」） */}
                <img
                  src={transitionToCover}
                  alt={transitionToTitle || songTitle}
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover"
                  style={{
                    opacity: coverTp,
                    transform: `scale(${(1.05 - 0.05 * coverTp).toFixed(4)}) translateZ(0)`,
                    transition: 'opacity 320ms linear, transform 320ms linear',
                    backfaceVisibility: 'hidden',
                  }}
                />
              </>
            ) : appleCoverUrl || resolvedCover ? (
              <img
                src={appleCoverUrl || resolvedCover}
                alt={songTitle}
                draggable={false}
                className="h-full w-full object-cover"
                style={{ transform: 'translateZ(0)', backfaceVisibility: 'hidden' }}
              />
            ) : (
              <div className="h-full w-full flex items-center justify-center" style={{ transform: 'translateZ(0)' }}>
                <Music style={{ width: 190 * s, height: 190 * s, color: c.placeholderIcon }} strokeWidth={1.4} />
              </div>
            )}
          </div>

          {/* AutoMix 过渡徽标：封面下方显示过渡时间节点（个性化里可关） */}
          {automixHud && !automixHudDismissed && (
            <div
              className="absolute flex items-center justify-center"
              style={{ top: 597 * s, width: '100%', pointerEvents: 'none' }}
            >
              <div style={{ pointerEvents: 'auto' }}>
                <AutomixHudBadge
                  info={automixHud}
                  playbackTimeStore={playbackTimeStore}
                  scale={s}
                  colors={{ chip: dark ? 'rgba(15, 17, 24, 0.55)' : 'rgba(255, 255, 255, 0.62)', text: c.title, dim: c.dim }}
                  // 药丸底色 = 当前封面主题色的淡色（与 modern 页一致）
                  accentColor={accentColor}
                  onDismiss={() => { setAutomixHudDismissed(true); onSkipAutomix?.() }}
                />
              </div>
            </div>
          )}

          {/* 标题 / 艺人 + 更多按钮（过渡期：新旧歌曲信息双层交叉淡化，与封面同步） */}
          <div className="absolute flex items-start justify-between" style={{ top: 641 * s, width: coverSize }}>
            {titleTransitionActive ? (
              <div className="relative min-w-0 flex-1" style={{ minHeight: 46 * s }}>
                <div className="absolute inset-0" style={{ opacity: 1 - coverTp, transition: 'opacity 320ms linear' }}>
                  <div
                    className="truncate font-bold"
                    style={{ color: c.title, fontSize: 19 * s, lineHeight: `${25 * s}px` }}
                  >
                    {songTitle}
                  </div>
                  <div className="truncate" style={{ color: c.sub, fontSize: 15 * s, lineHeight: `${21 * s}px` }}>
                    {songArtist}
                  </div>
                </div>
                <div className="absolute inset-0" style={{ opacity: coverTp, transition: 'opacity 320ms linear' }}>
                  <div
                    className="truncate font-bold"
                    style={{ color: c.title, fontSize: 19 * s, lineHeight: `${25 * s}px` }}
                  >
                    {transitionToTitle}
                  </div>
                  <div className="truncate" style={{ color: c.sub, fontSize: 15 * s, lineHeight: `${21 * s}px` }}>
                    {transitionToArtist}
                  </div>
                </div>
              </div>
            ) : (
              <div className="min-w-0">
                <div
                  className="truncate font-bold"
                  style={{ color: c.title, fontSize: 19 * s, lineHeight: `${25 * s}px` }}
                >
                  {songTitle}
                </div>
                <div className="truncate" style={{ color: c.sub, fontSize: 15 * s, lineHeight: `${21 * s}px` }}>
                  {songArtist}
                </div>
              </div>
            )}
            <button
              type="button"
              aria-label="更多"
              onClick={e => {
                e.stopPropagation()
                onMoreClick?.()
              }}
              className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-full shrink-0"
              style={{ width: 36 * s, height: 36 * s, background: c.chip, color: c.title, marginTop: 2 * s }}
            >
              <MoreHorizontal style={{ width: 16 * s, height: 16 * s }} />
            </button>
          </div>

          {/* AutoMix 过渡提示：过渡前 10 秒「即将介入」，过渡中金色「过渡效果」 */}
          {automixHud && (
            <AutomixHudProgressHint
              info={automixHud}
              playbackTimeStore={playbackTimeStore}
              scale={s}
            />
          )}

          {/* 进度条 */}
          <div
            className="absolute cursor-pointer"
            style={{ top: 702 * s, width: coverSize, height: 12 * s }}
            onPointerDown={event => {
              if (!onSeek || durationRef.current <= 0) return
              dragBar(event, frac => onSeek(frac * durationRef.current))
            }}
          >
            <div
              className="absolute left-0 right-0 rounded-full"
              style={{ top: 4.5 * s, height: 3 * s, background: c.barTrack }}
            />
            <div
              ref={progressFillRef}
              className="absolute left-0 rounded-full"
              style={{ top: 4.5 * s, height: 3 * s, background: c.barFill, width: '0%' }}
            />
          </div>

          {/* 时间 */}
          <div
            className="absolute flex justify-between"
            style={{ top: 719 * s, width: coverSize, color: c.dim, fontSize: 10.5 * s }}
          >
            <span ref={elapsedRef}>0:00</span>
            <span ref={remainRef}>-0:00</span>
          </div>

          {/* 播放控制 */}
          <div
            className="absolute flex items-center justify-between"
            style={{ top: 752 * s, width: coverSize, height: 32 * s }}
          >
            <button
              type="button"
              aria-label="随机播放"
              className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-full"
              onClick={() => onPlayModeChange?.(playMode === 'shuffle' ? 'sequential' : 'shuffle')}
              style={{
                width: 32 * s,
                height: 32 * s,
                background: playMode === 'shuffle' ? c.barFill : c.chip,
                color: playMode === 'shuffle' ? (dark ? '#ffffff' : '#1c1c1e') : c.dim,
              }}
            >
              <Shuffle style={{ width: 16 * s, height: 16 * s }} />
            </button>
            <div className="flex items-center" style={{ gap: 46 * s }}>
              <button
                type="button"
                aria-label="上一首"
                className="modeng-btn flex items-center justify-center"
                onClick={onPrevious}
                style={{
                  color: c.title,
                  width: 44 * s,
                  height: 44 * s,
                  background: 'transparent',
                  boxShadow: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                <SkipBack style={{ width: 30 * s, height: 30 * s }} fill="currentColor" strokeWidth={0} />
              </button>
              <button
                type="button"
                aria-label="播放/暂停"
                className="modeng-btn flex items-center justify-center"
                onClick={onPlayPause}
                style={{
                  color: c.title,
                  width: 56 * s,
                  height: 56 * s,
                  background: 'transparent',
                  boxShadow: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                {isPlaying ? (
                  <Pause style={{ width: 36 * s, height: 36 * s }} fill="currentColor" strokeWidth={0} />
                ) : (
                  <Play style={{ width: 36 * s, height: 36 * s }} fill="currentColor" strokeWidth={0} />
                )}
              </button>
              <button
                type="button"
                aria-label="下一首"
                className="modeng-btn flex items-center justify-center"
                onClick={onNext}
                style={{
                  color: c.title,
                  width: 44 * s,
                  height: 44 * s,
                  background: 'transparent',
                  boxShadow: 'none',
                  border: 'none',
                  padding: 0,
                }}
              >
                <SkipForward style={{ width: 30 * s, height: 30 * s }} fill="currentColor" strokeWidth={0} />
              </button>
            </div>
            <button
              type="button"
              aria-label="循环播放"
              className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-full"
              onClick={() => onPlayModeChange?.(playMode === 'repeat' ? 'sequential' : 'repeat')}
              style={{
                width: 32 * s,
                height: 32 * s,
                background: playMode === 'repeat' ? c.barFill : c.chip,
                color: playMode === 'repeat' ? (dark ? '#ffffff' : '#1c1c1e') : c.dim,
              }}
            >
              <Repeat style={{ width: 16 * s, height: 16 * s }} />
            </button>
          </div>

          {/* 音量 */}
          <div className="absolute flex items-center" style={{ top: 828 * s, width: coverSize, gap: 10 * s }}>
            {/* 音量条显隐切换按钮：独立 absolute 定位在音量条右上角上方，不破坏音量条本体的对称布局。
                仅摩登模式使用，状态持久化在 MODENG_VOLUME_BAR_VISIBLE_KEY。 */}
            <button
              type="button"
              aria-label={volumeBarVisible ? '隐藏音量条' : '显示音量条'}
              aria-pressed={!volumeBarVisible}
              onClick={toggleVolumeBar}
              title={volumeBarVisible ? '隐藏音量条' : '显示音量条'}
              className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-full"
              style={{
                position: 'absolute',
                top: -22 * s,
                right: 0,
                width: 22 * s,
                height: 22 * s,
                background: c.chip,
                color: c.dim,
              }}
            >
              {volumeBarVisible ? (
                <EyeOff style={{ width: 12 * s, height: 12 * s }} />
              ) : (
                <Eye style={{ width: 12 * s, height: 12 * s }} />
              )}
            </button>
            {volumeBarVisible ? (
              <>
                <VolumeX style={{ width: 15 * s, height: 15 * s, color: c.dim, visibility: 'hidden' }} />
                <div
                  className="relative flex-1 cursor-pointer"
                  style={{ height: 12 * s }}
                  onPointerDown={event => dragBar(event, frac => onVolumeChange?.(frac))}
                >
                  <div
                    className="absolute left-0 right-0 rounded-full"
                    style={{ top: 4.5 * s, height: 3 * s, background: c.volTrack }}
                  />
                  <div
                    className="absolute left-0 rounded-full"
                    style={{ top: 4.5 * s, height: 3 * s, background: c.volFill, width: `${clamp01(volume) * 100}%` }}
                  />
                </div>
                <VolumeIcon style={{ width: 15 * s, height: 15 * s, color: c.dim }} />
              </>
            ) : null}
          </div>

          {/* 页脚 */}
          <div
            className="absolute flex items-center justify-between"
            style={{
              top: 898 * s,
              width: '100%', // 严格约束在父 cover 列宽内，避免溢出到歌词区（歌词区 <div onSeek> 会截获点击导致快进）
              position: 'absolute',
              zIndex: 3, // 在歌词/进度条之上，确保按钮点击不被下层元素截获
              pointerEvents: 'auto',
            }}
          >
            {/* 左下角：回到主页按钮（样式对齐右侧翻译按钮的玻璃 chip） */}
            <button
              type="button"
              aria-label="回到主页"
              aria-pressed={false}
              onClick={e => {
                e.stopPropagation()
                onHomeClick?.()
              }}
              title="回到主页"
              className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg"
              style={{
                width: 28 * s,
                height: 28 * s,
                background: c.chip,
                color: c.sub,
                zIndex: 4,
                pointerEvents: 'auto',
              }}
            >
              <Home style={{ width: 14 * s, height: 14 * s }} />
            </button>
            <div className="flex items-center" style={{ gap: 12 * s }}>
              {/* 翻译按钮：激活时使用高亮强调色；歌曲无翻译时置灰禁用 */}
              <button
                type="button"
                aria-label="翻译"
                aria-pressed={effectiveTranslationEnabled && Boolean(resolvedHasTranslation)}
                disabled={!resolvedHasTranslation}
                onClick={e => {
                  e.stopPropagation()
                  toggleTranslation()
                }}
                title={resolvedHasTranslation ? (effectiveTranslationEnabled ? '关闭翻译' : '显示翻译') : '当前歌曲暂无翻译'}
                className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  width: 28 * s,
                  height: 28 * s,
                  background: effectiveTranslationEnabled && resolvedHasTranslation ? c.barFill : c.chip,
                  color: effectiveTranslationEnabled && resolvedHasTranslation ? (dark ? '#ffffff' : '#1c1c1e') : c.sub,
                  zIndex: 4,
                  pointerEvents: 'auto',
                }}
              >
                <Languages style={{ width: 14 * s, height: 14 * s }} />
              </button>
              {/* 罗马音按钮：新增；用户右下角设置。无罗马音时禁用。*/}
              <button
                type="button"
                aria-label="罗马音"
                aria-pressed={effectiveRomanEnabled && Boolean(resolvedHasRoman)}
                disabled={!resolvedHasRoman}
                onClick={e => {
                  e.stopPropagation()
                  toggleRoman()
                }}
                title={resolvedHasRoman ? (effectiveRomanEnabled ? '关闭罗马音' : '显示罗马音') : '当前歌曲暂无罗马音'}
                className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  width: 28 * s,
                  height: 28 * s,
                  background: effectiveRomanEnabled && resolvedHasRoman ? c.barFill : c.chip,
                  color: effectiveRomanEnabled && resolvedHasRoman ? (dark ? '#ffffff' : '#1c1c1e') : c.sub,
                  zIndex: 4,
                  pointerEvents: 'auto',
                }}
              >
                <Captions style={{ width: 14 * s, height: 14 * s }} />
              </button>
              {/* MV 背景按钮：与全局 MV 背景设置同步 */}
              <button
                type="button"
                aria-label="MV 背景"
                aria-pressed={Boolean(mvBackgroundEnabled)}
                onClick={e => {
                  e.stopPropagation()
                  onMvBackgroundToggle?.()
                }}
                title={mvBackgroundEnabled ? '关闭 MV 背景' : '显示 MV 背景'}
                className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg"
                style={{
                  width: 28 * s,
                  height: 28 * s,
                  background: mvBackgroundEnabled ? c.barFill : c.chip,
                  color: mvBackgroundEnabled ? (dark ? '#ffffff' : '#1c1c1e') : c.sub,
                  zIndex: 4,
                  pointerEvents: 'auto',
                }}
              >
                <Film style={{ width: 14 * s, height: 14 * s }} />
              </button>
              {/* 快捷设置：触发按钮沿用左侧 chip 样式；面板已是全局居中弹窗（宿主在 App 层） */}
              <QuickSettings
                playerTheme={playerTheme}
                isPureMusic={isPureMusic}
                triggerClassName="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg"
                triggerWidth={28 * s}
                triggerHeight={28 * s}
                triggerIconSize={14 * s}
                triggerIconColor={c.sub}
              />
              {/* 调音室按钮：打开调音室弹窗，锚定在按钮位置 */}
              <button
                type="button"
                aria-label="打开调音室"
                onClick={e => {
                  e.stopPropagation()
                  onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())
                }}
                title="调音室"
                className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg"
                style={{
                  width: 28 * s,
                  height: 28 * s,
                  background: c.chip,
                  color: c.sub,
                  zIndex: 4,
                  pointerEvents: 'auto',
                }}
              >
                <AudioLines style={{ width: 14 * s, height: 14 * s }} />
              </button>
              {/* 评论按钮：无回调时禁用。*/}
              <button
                type="button"
                aria-label="评论"
                disabled={!onOpenComments}
                onClick={e => {
                  e.stopPropagation()
                  onOpenComments?.()
                }}
                title={onOpenComments ? '查看评论' : '评论功能不可用'}
                className="modeng-btn modeng-btn-chip flex items-center justify-center rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  width: 28 * s,
                  height: 28 * s,
                  background: c.chip,
                  color: c.sub,
                  zIndex: 4,
                  pointerEvents: 'auto',
                }}
              >
                <MessageCircle style={{ width: 14 * s, height: 14 * s }} />
              </button>
            </div>
          </div>
          {/* 内容包裹层结束 */}
          </div>
        </div>

        {/* ---- 右栏：逐词歌词（纯音乐时整栏不渲染，由左侧控制条独立居中） ---- */}
        {!isPureMusic && (
          <div
            className="modeng-lyric-list absolute top-0 bottom-0 right-0 overflow-hidden"
            style={{
              left: rightX,
              // 过渡编排：歌词不再整体消失，而是「柔和退场」（淡出至隐约可见 + 上浮 + 微缩），
              // commit 后新歌词反向入场。长过渡（30s+）期间歌词全程隐约在场，最后 4 秒窗口完成退场。
              opacity: isTransitioning ? 0.12 : 1,
              transform: isTransitioning ? `translateY(${-14 * s}px) scale(0.985)` : 'none',
              transition: isTransitioning
                ? 'opacity 900ms ease, transform 900ms ease'
                : 'opacity 600ms cubic-bezier(0.22,0.61,0.36,1), transform 600ms cubic-bezier(0.22,0.61,0.36,1)',
              willChange: isTransitioning ? 'opacity, transform' : 'auto',
            }}
            onPointerDown={startLyricScrub}
            onMouseEnter={e => {
              const list = e.currentTarget
              list.classList.add('modeng-hovering')
              // 鼠标进入时立即识别所在行（mousemove 之前就触发一次，避免延迟一帧才显示胶囊）
              const row = (e.relatedTarget as HTMLElement | null)?.closest?.('.modeng-lyric-line')
                ?? list.querySelector('.modeng-lyric-line')
              if (row) list.querySelectorAll('.modeng-lyric-line').forEach(el => el.classList.remove('modeng-line-hovered'))
              if (row) row.classList.add('modeng-line-hovered')
            }}
            onMouseMove={e => {
              // 用 closest 找鼠标当前所在的行；只更新类名（无 React 重渲染）。
              const list = e.currentTarget
              const row = (e.target as HTMLElement | null)?.closest?.('.modeng-lyric-line') as HTMLElement | null
              if (!row) return
              const prev = list.querySelector('.modeng-lyric-line.modeng-line-hovered')
              if (prev === row) return
              if (prev) prev.classList.remove('modeng-line-hovered')
              row.classList.add('modeng-line-hovered')
            }}
            onMouseLeave={e => {
              const list = e.currentTarget
              list.classList.remove('modeng-hovering')
              list.querySelectorAll('.modeng-lyric-line.modeng-line-hovered').forEach(el => el.classList.remove('modeng-line-hovered'))
            }}
          >
            <div
              ref={scrollContentWrapRef}
              style={{
                // 滚动位置由 rAF 唯一驱动（scrollPosRef → scrollContentWrapRef.translateY）。
                // JSX 不再写 transform，否则切行时 React 重渲染用 scrollOffset 硬跳、
                // 下一帧 rAF 又拿旧 scrollPosRef 拉回弹簧追，双源互相覆盖导致滚动回跳/跟不上进度。
                willChange: 'transform',
              }}
            >
            {lyrics.map((line, index) => {
              const distance = index - currentIndex
              const absDistance = Math.abs(distance)
              const isCurrent = distance === 0
              const words = lineWords[index]
              const lineBaseColor = isCurrent
                ? (duetUnsungColor(line.agent) ?? c.lineUnsungCurrent)
                : lineColor(distance, line.agent)
              // 修复：只有当前行的词用 unsung/sung 逐词混色驱动（rAF 循环只改 currentIndex）。
              // 非当前行（包括已播放的上一句）必须使用 distance 淡色，否则所有行的词 span 都
              // 被同一 unsungColor 覆盖父层的 lineBaseColor，导致上一句与当前句亮度一致。
              const wordInitialColor = isCurrent
                ? (duetUnsungColor(line.agent) ?? unsungColor)
                : lineColor(distance, line.agent)
              // A. 非当前行 scale 渐进（MIN_SCALE 0.86→1.0 随 LINE_FADE 同阶梯）。
              //   distance=1 时 LINE_FADE[0]=0.60 → scale = 0.86 + 0.14×0.40 = 0.916（次行略小）
              //   distance=2 时 LINE_FADE[1]=0.48 → scale = 0.86 + 0.14×0.52 = 0.933
              //   distance≥6→ scale=0.86 下限；current 行 distanceScale 强制 1.0（由 enter-scale 全权负责）
              const MIN_SCALE = 0.86
              const fadeVal = isCurrent ? 1 : (LINE_FADE[Math.min(absDistance - 1, LINE_FADE.length - 1)] ?? 0.15)
              const distanceScale = isCurrent
                ? 1.0
                : MIN_SCALE + (1 - MIN_SCALE) * (1 - fadeVal)
              // E. enableBlur：blur 值写入 CSS 变量，类名控制 filter 生效。
              //   distance=0 时不打 blur 类，避免 current 行的 text-shadow 与 blur filter 叠加变糊。
              const blurPx = isCurrent ? 0 : lineBlur(distance)
              const enableBlur = blurPx > 0.001
              return (
                <Fragment key={`${line.time}-${index}`}>
                <div
                  ref={el => {
                    if (el) {
                      lineDomRefs.current.set(index, el)
                      // E. 类名切换（挂到最外层，选择器 .modeng-blur-enabled > .modeng-line-wrap 生效）
                      el.classList.toggle('modeng-blur-enabled', enableBlur)
                    } else {
                      lineDomRefs.current.delete(index)
                    }
                  }}
                  onClick={() => { if (scrubRef.current.moved) return; onSeek?.(line.time) }}
                  className="modeng-lyric-line cursor-pointer"
                  style={{
                    minHeight: lineH,
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'center',
                    // 长行自动换行到下一行；多语言（含英文长单词）在必要时允许断词
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    // 字号实机校准：LyricsBlossom 当前行文字带高 27px（清晰行，1:1 实测）
                    //   → 字号 ≈ 31px @768 窗口 = 窗口高的 4.04% → 38.4 @951 基准。
                    //   原 46px 偏大约 17%（整屏歌词因此偏大、可读行数偏少）。
                    //   当前行 / 非当前行字号比取 1.15（实机目测约 1.12~1.16，原实现 1.21 偏大）。
                    fontSize: (isCurrent ? 38.5 : 33.5) * s,
                    fontWeight: isCurrent ? 700 : 600,
                    color: lineBaseColor,
                    // E. 不再内联 filter: blur() → 写 CSS var 由类名决定是否应用
                    ['--modeng-line-blur' as any]: `${blurPx.toFixed(2)}px`,
                    // A. 距离驱动的 scale（与 enter-scale 相乘，由 CSS calc 合成）
                    ['--modeng-distance-scale' as any]: distanceScale.toFixed(4),
                    opacity: absDistance > 7 ? 0 : 1,
                    transition:
                      'font-size 0.32s cubic-bezier(0.4,0,0.2,1), color 0.32s cubic-bezier(0.4,0,0.2,1), opacity 0.32s cubic-bezier(0.42,0,0.58,1)',
                    letterSpacing: 0.5 * s,
                  }}
                >
                  <div
                    className="modeng-line-wrap w-full"
                    style={{
                      // 左右交替歌词：按歌曲结构整块内容靠左/靠右（col 内 alignItems 控制横向对齐）。
                      // 默认（未开启 sideAlign）左对齐：每句歌词整体靠左，文字左对齐 → 整齐、可读。
                      display: 'flex',
                      flexDirection: 'column' as const,
                      alignItems: sideAlign
                        ? (lineSideOf(index) === 'right' ? 'flex-end' : 'flex-start')
                        : 'flex-start',
                    }}
                  >
                    {/* 罗马音行（逐字或整行）：仅当前行显示——LB/AM 实机非当前行只有主文字，
                        翻译/罗马音随行激活才展开（与柔和风格 isCurrent 条件一致）；
                        全行都渲染会让歌词列每行拖一条小尾巴，密度过高观感碎。
                        颜色不能走 lineColor(0)：LINE_FADE 表按"距离-1"取下标，distance=0
                        会取 [-1] → 回退 0.15，当前行罗马音会暗到几乎不可见——
                        当前行统一用 unsung 色（比主歌词略淡一档）。 */}
                    {isCurrent && effectiveRomanEnabled && Boolean(line.roman || line.romanWords?.length) ? (
                      <div
                        data-testid="modeng-roman"
                        style={{
                          fontSize: 17 * s,
                          fontWeight: 500,
                          color: duetUnsungColor(line.agent) ?? unsungColor,
                          letterSpacing: 0.5 * s,
                          lineHeight: 1,
                          marginBottom: 4 * s,
                          opacity: 0.9,
                        }}
                      >
                        {line.romanWords && line.romanWords.length > 0 ? (
                          line.romanWords.map((rw, ri) => (
                            <span
                              key={`rw-${index}-${ri}`}
                              className="inline-block"
                              style={{ marginRight: 0.5 * s }}
                            >
                              {rw.word}
                            </span>
                          ))
                        ) : (
                          <span>{line.roman}</span>
                        )}
                      </div>
                    ) : null}
                    {/* 主歌词文本行：允许长行自动换行；inline-block 词块在边界处自然折行，
                       中英文混排时长英文单词也会按 break-word 截断，避免最右侧被遮住。 */}
                    <div
                      className="flex flex-wrap items-center"
                      style={{
                        // line-height 1.15 → 1.4：内联盒子（inline-block 词块）需要装下 y/g/p/q/j 等
                        //   含下伸笔画的英文 descender。原 1.15 偏紧，背景渐变 + color:transparent
                        //   组合下，下伸笔画超出盒子 → 那部分字形没背景填充，看起来被"截掉"。
                        //   配合 .modeng-word padding-bottom:0.08em 双重保险。中文无 descender 不受影响。
                        lineHeight: 1.4,
                        maxWidth: '100%',
                        wordBreak: 'break-word',
                        overflowWrap: 'break-word',
                        // 左右交替：flex 容器的 text-align 不作用于布局（flex 子项忽略它），
                        //   但决定换行后各文本行的水平对齐；配合 alignItems 才能让"整块靠右 +
                        //   块内文字也靠右"（否则只有块框贴右、文字仍悬在左侧）。
                        textAlign: lineSideFor(index) === 'right' ? 'right' : 'left',
                        justifyContent: lineSideFor(index) === 'right' ? 'flex-end' : 'flex-start',
                      }}
                    >
                      {words && words.length > 0 ? (
                        words.map((word, wordIndex) =>
                          word.whitespace ? (
                            <span key={`ws-${wordIndex}`} style={{ whiteSpace: 'pre' }}>{word.text}</span>
                          ) : (
                            <span
                              key={`w-${wordIndex}`}
                              ref={el => {
                                if (el) wordColorRefs.current.set(`w${index}-${wordIndex}`, el)
                                else wordColorRefs.current.delete(`w${index}-${wordIndex}`)
                              }}
                              className="modeng-word inline-block"
                              // rAF 启动前用 color 渲染（纯色驱动，不再用 background-clip:text 渐变）。
                              //   isCurrent 行用 wordInitialColor（unsung 色）；
                              //   非当前行不写 inline style，走父 lineColor(distance) 继承。
                              style={isCurrent ? { color: wordInitialColor } : undefined}
                            >
                              {word.text}
                            </span>
                          ),
                        )
                      ) : (
                        <span
                          ref={el => {
                            if (el) wordColorRefs.current.set(`l${index}`, el)
                            else wordColorRefs.current.delete(`l${index}`)
                          }}
                          className="modeng-word inline-block"
                          style={isCurrent ? { color: wordInitialColor } : undefined}
                        >
                          {line.text}
                        </span>
                      )}
                    </div>
                    {/* Apple 背景和声（TTML ttm:role="x-bg"）：主行下方独立小字行，与主行同时逐字点亮。
                        仅在当前行渲染（和声依附所属主行进行），词级亮度由 rAF 随时间写入。
                        对唱行时和声继承该行左右分栏。 */}
                    {isCurrent && line.backgroundVocals?.length ? (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: lineSideFor(index) === 'right' ? 'flex-end' : 'flex-start',
                          marginTop: 4 * s,
                          willChange: 'opacity',
                        }}
                      >
                        {line.backgroundVocals.map((vocal, vi) => (
                          <div
                            key={`bg-${index}-${vi}`}
                            ref={el => {
                              if (el) bgVocalRowRefs.current.set(`bg${index}-${vi}`, el)
                              else bgVocalRowRefs.current.delete(`bg${index}-${vi}`)
                            }}
                            style={{
                              fontSize: (isCurrent ? 22 : 18) * s,
                              fontWeight: 500,
                              // 和声色：对唱 tint 优先；无 tint 时用未唱色（比主行 sung 白暗一档、
                              // 但远亮于 lineColor(0) 的 0.15 回退——否则和声黑/暗到不可见）。
                              color: duetUnsungColor(vocal.agentId || vocal.agent) ?? unsungColor,
                              letterSpacing: 0.4 * s,
                              lineHeight: 1.3,
                              opacity: 0,
                            }}
                          >
                            {vocal.words?.length
                              ? vocal.words.map((word, wi) => (
                                  <span
                                    key={`bgw-${index}-${vi}-${wi}`}
                                    ref={el => {
                                      if (el) bgVocalWordRefs.current.set(`bg${index}-${vi}-${wi}`, el)
                                      else bgVocalWordRefs.current.delete(`bg${index}-${vi}-${wi}`)
                                    }}
                                    className="inline-block"
                                    style={{ opacity: 0.32 }}
                                  >
                                    {word.word}
                                  </span>
                                ))
                              : vocal.text}
                          {(vocal.translation || vocal.romanization) && (
                            <div style={{ marginTop: '0.08em' }}>
                              {vocal.translation ? (
                                <div style={{ fontSize: '0.78em', opacity: 0.72, lineHeight: 1.4 }}>
                                  {vocal.translation}
                                </div>
                              ) : null}
                              {vocal.romanization ? (
                                <div style={{ fontSize: '0.72em', opacity: 0.6, lineHeight: 1.4, letterSpacing: '0.03em' }}>
                                  {vocal.romanization}
                                </div>
                              ) : null}
                            </div>
                          )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {/* 间奏三点：见 Fragment 尾部的独立 frame（.modeng-interlude-frame）——
                       旧版行内容器已删除（与独立 frame 双份渲染、ref 互相覆盖，rAF 只驱动得到其中一份）。 */}
                    {/* 翻译行：仅当前行显示（LB/AM 实机非当前行只有主文字，翻译随行激活展开）；
                        全行渲染会让歌词列每行拖一条小尾巴。 */}
                    {isCurrent && effectiveTranslationEnabled && line.translation?.trim() ? (
                      <div
                        data-testid="modeng-translation"
                        style={{
                          fontSize: 17 * s,
                          fontWeight: 500,
                          color: lineBaseColor,
                          letterSpacing: 0.3 * s,
                          lineHeight: 1,
                          // 间奏三点已迁出到独立 frame（见下方），这里恢复默认 5s 紧凑间距即可。
                          marginTop: 5 * s,
                        }}
                      >
                        {line.translation.trim()}
                      </div>
                    ) : null}
                  </div>
                </div>
                {/* 间奏三点独立帧：作为当前行的兄弟节点渲染，与歌词框完全脱钩。
                   - 仅 isCurrent 时存在；rAF 通过 fadeIn 控制可见度与上下间距（fadeIn=0 时上下间距与
                     minHeight 归零，不挤占布局；fadeIn=1 时三变量插值到 24s/22s/76s，独立成帧）。
                   - 不是 .modeng-lyric-line，鼠标 hover 时不参与行级胶囊逻辑（closest('.modeng-lyric-line') 不会匹配）。
                   - 三点错峰呼吸（~1.5s 周期，120ms/点相位差），临近下一句时按 remain 错峰熄灭对齐开唱时机。 */}
                {isCurrent ? (
                  <div
                    ref={el => { interludeWrapRef.current = el ?? null }}
                    className="modeng-interlude-frame modeng-interlude-dots"
                    style={{
                      // 与 .modeng-lyric-line 共享列宽（padding 0 16px 对齐行内边距），但本身不带 hover capsule / 行级 transform / minHeight。
                      // 留出 0~76s 的可伸缩高度，由 --modeng-interlude-min-h 控制；上下间距由 --modeng-interlude-pad-top/bottom 控制。
                      padding: '0 16px',
                      boxSizing: 'border-box',
                      marginTop: 'calc(var(--modeng-interlude-pad-top, 0px))',
                      marginBottom: 'calc(var(--modeng-interlude-pad-bottom, 0px))',
                      minHeight: 'calc(var(--modeng-interlude-min-h, 0px))',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 18 * s,
                      // 整体微缩放/透明度写在容器（fadeIn × vanish × appear），呼吸交由每个 dot。
                      opacity: 0,
                      transform: 'translateZ(0) scale(1)',
                      transformOrigin: 'left 45%',
                      willChange: 'transform, opacity, margin, min-height',
                      pointerEvents: 'none', // 不拦截行 hover / 点击；继续透传给歌词行
                    }}
                  >
                    {[0, 1, 2].map(i => (
                      <span
                        key={`dot-${index}-${i}`}
                        style={{
                          display: 'inline-block',
                          width: 12 * s,
                          height: 12 * s,
                          borderRadius: '50%',
                          background: dark ? 'rgba(235,235,245,0.78)' : 'rgba(60,60,67,0.72)',
                          boxShadow: dark
                            ? `0 0 ${10 * s}px rgba(255,255,255,0.18), 0 ${2 * s}px ${4 * s}px rgba(0,0,0,0.25)`
                            : `0 0 ${8 * s}px rgba(0,0,0,0.12), 0 ${2 * s}px ${4 * s}px rgba(0,0,0,0.10)`,
                          transform: 'translateZ(0) scale(1)',
                          transformOrigin: 'center center',
                          willChange: 'transform, opacity',
                          flexShrink: 0,
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                </Fragment>
              )
            })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
