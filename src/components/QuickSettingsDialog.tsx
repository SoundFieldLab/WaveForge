import { motion, AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import {
  AudioLines,
  Disc3,
  Headphones,
  Languages,
  Layers,
  Palette,
  RotateCcw,
  Settings2,
  Shuffle,
  Type,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import {
  readLyricStyleMode,
  persistLyricStyleMode,
  type LyricStyleMode,
} from '../utils/lyricStyle'
import { setTransitionModeExclusive } from '../services/globalSettingsRegistry'
import { parseStoredBoolean } from '../utils/storage'
import type { QuickSettingsSection } from '../services/quickSettingsStore'
import type { QuickSettingsPlaybackContext } from './quickSettingsPlaybackContext'
import QuickSettingsPreview from './QuickSettingsPreview'
import FoliaTuningPanel from './FoliaTuningPanel'
import { getVisualizerRegistryEntry } from '../vendor/folia/components/visualizer/registry'
import { useModeParked } from '../utils/modeLayer'
import { buildQuickSettingsPalette, toRgba } from './quickSettingsPalette'
import { FOLIA_STYLES } from '../vendor/folia/stylesMeta'

/** 当前 Folia 样式是否有独立参数面板（registry entry 声明了 renderSettingsPanel 即有）。 */
const foliaStyleHasPanel = (style: string): boolean => {
  try {
    return typeof getVisualizerRegistryEntry(style as never)?.renderSettingsPanel === 'function'
  } catch {
    return false
  }
}

/** folia 样式 id → 中文名（二级弹窗标题用）。 */
const FOLIA_STYLE_ZH: Record<string, string> = Object.fromEntries(
  FOLIA_STYLES.map(style => [style.id, style.zhName]),
)

/**
 * 播放设置弹窗（原 QuickSettings 下拉面板）。
 *
 * ## 版式：机架控制台（2026-09-25 第九轮定稿，已刻意脱离 folia）
 *
 * 面板是一块「硬件机架控制台」，**上下两块**：
 *
 * 1. **上半块 = 监视器机箱**：居中的横版 16:9 屏幕（`h-full aspect-video`）+ 四角 accent 托架。
 *    高度 = **吃掉下半块之外的全部剩余**（`flex-1 min-h-[220px]`），所以视口越高预览越大。
 * 2. **下半块 = 设置**：顶部一行**横向分段 chip**（外观 / 功能 / 播放），下面是**等宽并排的机架槽**
 *    （`flex-1 basis-0`，槽数随分段变：外观 2 / 功能 4 / 播放 2），高度由父级拉伸，各槽上下严格对齐。
 *    高度**固定**为 `BOTTOM_BLOCK_HEIGHT`（`clamp(274px, 34vh, 306px)`）。
 *
 * 逐条差异（改版式前先读这一节，别再退回 folia 版式，也别退回上一版的
 * 「上半块写死 clamp + 下半块 flex-1」）：
 *
 * | 部位 | 旧（≤ 第八轮） | 现（第九轮） |
 * |---|---|---|
 * | 上半块高度 | 写死 `clamp(230px, 42vh, 420px)` | **`flex-1` 吃剩余**（预览随窗口变大） |
 * | 下半块高度 | `flex-1` 随内容 | **固定 `clamp(274px, 34vh, 306px)`**（预览才稳定） |
 * | 每槽控件数 | 最多 4 个（外观 01 槽） | **强制 ≤3 个**（多出的移到空槽） |
 * | 面板外边距 | `p-3 sm:p-5` | `p-2 sm:p-3` |
 * | 顶栏 / 主体内边距 | `py-3` / `p-4` | `py-2.5` / `p-3` |
 *
 * **为什么第九轮要把上下两块的 flex 角色互换**：第八轮为了让预览稳定，
 * 把上半块写死 clamp、下半块吃剩余 —— 结果是用户窗口（1402×817）下预览恒定
 * 只有 564×317，用户反馈「预览窗口怎么那么小」。真正该固定的是**下半块**：
 * 它的内容需求是个常量（最挤的一槽 ≤3 个控件），固定它之后上半块的剩余高度
 * 同样是个常量，既变大又不会随分段跳变。实测预览从 564×317 → 约 720×405。
 *
 * **为什么每槽必须 ≤3 个控件**：3 个控件（无论 toggle / preset / slider）实测
 * 卡片高约 227px（3×52 + 2×10 组距 + 51 卡头与内边距），4 个就要 289px。
 * `BOTTOM_BLOCK_HEIGHT` 的 274px 下限正是按 3 控件算的 —— 谁把某槽塞到 4 个，
 * 那个分段就会冒滚动条。条件开关（按歌词模式 / 背景效果出现）尤其危险，
 * 要放在**基础项最少的槽**里，别放在已经有 3 项的槽。
 *
 * **为什么预览必须在上方、且锁 16:9**：放右栏时它被拉成约 0.7:1 的竖长条，
 * 而真机播放面是横版 —— 比例一失真，用户没法从预览判断自己改的东西长什么样。
 * ⚠️ 屏幕必须靠 `h-full aspect-video` **反推宽度**；写 `w-full` 会算出约 646px 高把机箱顶爆，
 * 加 `min-h-[320px]` 同样会毁掉比例（第五轮踩过）。
 *
 * **为什么下半块「无需滚动条」**：下半块高度固定且下限 274px 已能容下最挤的槽；
 * 槽位横向并排 + 每槽自己的控件区 `flex-1 overflow-y-auto` 兜底 —— 正常窗口下永远不出现滚动条，
 * 极矮窗口里也只让**单个槽**滚，不会把整个弹窗撑出滚动条。

 * 为达成这一点，「功能」段被拆成 4 个槽（原「歌词呈现」里拆出「歌词细节」），每槽控件数压在 2~5 个。
 *
 * 保留的只有「四根支柱」本身，它们与 folia 无关、是这套控件能用的底线：
 * 面板纯色实心（`#18181b` / `white`）、选中态 = accent 描边 + 淡 accent 底、
 * 所有配色走 `buildQuickSettingsPalette(accentColor, playerTheme)`、明暗主题各自一套。
 *
 * ## 三个分段（分段名即 chip 名，测试按 `aria-label` 取按钮，不要改成带序号的名字）
 *
 * **外观**（01 界面与背景 / 02 背景细节 / 03 封面律动）、
 * **功能**（01 画面显示 / 02 歌词呈现 / 03 歌词细节 / 04 翻译与注音）、
 * **播放**（01 曲目过渡 / 02 专辑衔接）。
 * 纯音乐下「歌词细节」「翻译与注音」整槽不渲染，编号仍是 01/02，不留空号。
 * 每槽控件数上限 3（理由见上方「为什么每槽必须 ≤3 个控件」）。
 *
 * ### 版式上的易错点（改前先看）
 *
 * 1. **键位网格必须限宽**：`renderPresetGroup` 传 `columns` 时同时给 `maxWidth`。只写
 *    `repeat(N, minmax(0,1fr))` 的话，2 项的组会被拉成两枚巨型空盒，比 4 项组大一倍。
 * 2. **摇臂开关打开时滑块必须用白色**：滑块和轨道同为 accent 色 = 滑块隐形。
 *    行程 20px（内容宽 36 − 滑块 16），不是 18px。
 * 3. **槽位宽度预算有限**：4 槽并排时每槽内宽只剩约 246px（1180 面板），
 *    `翻译位置` 这种长标签的组只能 `columns: 2`；再切到 5 槽就会把「传统（行下方）」截断。
 *    所以功能段**只能 4 槽**，压低高度要靠「每槽 ≤3 控件」而不是继续加槽。
 * 4. **预览的装饰归本组件管**：四角托架写在这里，`QuickSettingsPreview` 只画屏幕本体。
 * 5. **不要再往面板里加读数/遥测文本**：滑块数值框的文本恰好是 `3.4` / `4s`，
 *    别处再出现同样的独立文本会让单测 `getByText` 双命中（原读数条就是因此被删掉的）。
 * 6. **条件开关要放在基础项最少的槽**：按歌词模式（沉浸 / 摩登）或背景效果（沉浸）
 *    出现的开关会让所在槽的控件数在某几个模式下 +1，放进 3 项的槽就会冒滚动条。
 *
 * ## 与版式无关的部分（换皮不能动）
 *
 * 二十余个存储键 + 二十余条 window CustomEvent 原样保留：它们本来就是全局通道，
 * 浮层还是弹窗、玻璃还是实心都不影响。过渡三开关的互斥规则直接复用
 * globalSettingsRegistry 导出的 `setTransitionModeExclusive`，不复制第二份。
 *
 * 宿主由 QuickSettingsHost 提供（唯一实例、portal 到 body）；本组件在打开那一刻才挂载，
 * 所以每次打开都会按最新存储值重新初始化，且 useTvBack 的栈序天然排在最后（遥控器 BACK 优先关它）。
 */
interface QuickSettingsDialogProps {
  playerTheme: 'light' | 'dark'
  isPureMusic: boolean
  initialSection: QuickSettingsSection
  /** 预览用的播放上下文（当前曲目 / 歌词 / 播放时间源），由 App 经 Host 透传 */
  playback?: QuickSettingsPlaybackContext | null
  /** Folia 歌词：当前样式 id 与参数面板所需的调参/提交回调（App 层持有） */
  foliaStyle?: string
  foliaTuning?: Record<string, unknown>
  onFoliaTuningCommit?: (next: Record<string, unknown>) => void
  onFoliaTuningReset?: () => void
  hasFoliaTuningOverride?: boolean
  onClose: () => void
}

type CoverPulseMode = 'dynamic' | 'soft' | 'restless'
type LyricDisplayMode = 'modern' | 'immersive' | 'wallpaper' | 'glorious' | 'multidimensional' | 'modeng' | 'video' | 'folia' | 'pv'
type BackgroundEffect = 'transparent' | 'blur' | 'immersive' | 'modern'
/** 播放过渡方式：关闭 / 渐入渐出 / 无缝衔接 / AutoMix（三者互斥） */
type TransitionMode = 'none' | 'crossfade' | 'gapless' | 'autoMix'

const LYRIC_DISPLAY_MODES: LyricDisplayMode[] = ['modern', 'immersive', 'wallpaper', 'glorious', 'multidimensional', 'modeng', 'video', 'folia', 'pv']

const LYRIC_MODE_LABELS: Record<LyricDisplayMode, string> = {
  modern: '现代',
  immersive: '沉浸式',
  wallpaper: '墙纸',
  glorious: '辉煌',
  multidimensional: '多维',
  modeng: '摩登',
  video: '看歌',
  folia: 'Folia',
  pv: 'PV',
}

const BACKGROUND_EFFECT_LABELS: Record<BackgroundEffect, string> = {
  transparent: '通透',
  blur: '模糊',
  modern: '摩登',
  immersive: '沉浸',
}

/**
 * 弹窗里可直接切换的歌词模式（与 App.tsx 顶部切换器同名）。
 * 只放「播放面歌词渲染」这几个：看歌需要先匹配到 MV、Folia/PV 是独立页面，
 * 留在 App 顶部切换器里更合适。若当前模式不在这六个里，会在末尾补一枚「当前模式」chip，
 * 避免出现「一个都没选中」的歧义。
 */
const QUICK_LYRIC_MODES: LyricDisplayMode[] = ['modern', 'immersive', 'wallpaper', 'glorious', 'multidimensional', 'modeng']

/** 推子刻度尺的格数（纯装饰，`aria-hidden`）。 */
const FADER_TICKS = 9

const readLyricDisplayMode = (): LyricDisplayMode => {
  const saved = localStorage.getItem('lyricDisplayMode')
  return LYRIC_DISPLAY_MODES.includes(saved as LyricDisplayMode) ? (saved as LyricDisplayMode) : 'modern'
}

const readTransitionMode = (): TransitionMode => {
  if (localStorage.getItem('gaplessEnabled') === 'true') return 'gapless'
  if (localStorage.getItem('autoMixEnabled') === 'true') return 'autoMix'
  if (localStorage.getItem('crossfadeEnabled') === 'true') return 'crossfade'
  return 'none'
}

export default memo(function QuickSettingsDialog({
  playerTheme,
  isPureMusic,
  initialSection,
  playback,
  foliaStyle,
  foliaTuning,
  onFoliaTuningCommit,
  onFoliaTuningReset,
  hasFoliaTuningOverride,
  onClose,
}: QuickSettingsDialogProps) {
  const [activeSection, setActiveSection] = useState<QuickSettingsSection>(initialSection)
  /** Folia 参数二级弹窗：从 02 槽入口按钮打开（参数多，槽内塞不下） */
  const [foliaSubDialogOpen, setFoliaSubDialogOpen] = useState(false)
  // 模式挂起守卫：portal 逃出模式层的 visibility，挂起时必须停止渲染（否则
  // 切模式后 Folia 参数弹窗会盖在当前模式顶部）；恢复时 open 状态也复位，
  // 避免切回播放页时它自己再展开一次（与顶部歌词下拉的 parked 行为同款）。
  const modeParked = useModeParked()
  useEffect(() => {
    if (modeParked) setFoliaSubDialogOpen(false)
  }, [modeParked])

  // 遥控器 BACK：关闭弹窗。本组件只在打开时挂载 → BACK 处理器后于播放页注册，天然是栈顶。
  useTvBack(() => {
    onClose()
    return true
  })

  // Esc 关闭（弹窗惯例；folia 的设置弹窗同样是 Esc 关最内层）
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const overlayMouseDownRef = useRef(false)

  const handleOverlayMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    overlayMouseDownRef.current = event.target === event.currentTarget
  }

  const handleBackdropClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const wasMouseDownOnOverlay = overlayMouseDownRef.current
    overlayMouseDownRef.current = false
    if (event.target !== event.currentTarget || !wasMouseDownOnOverlay) return
    onClose()
  }

  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })

  useEffect(() => {
    const handleAccentColorChange = (e: CustomEvent) => {
      setAccentColor(e.detail)
    }
    window.addEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    return () => {
      window.removeEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    }
  }, [])

  const [lyricSize, setLyricSize] = useState(() => {
    const saved = localStorage.getItem('lyricSize')
    return saved ? parseFloat(saved) : 2.8
  })

  const [lyricOffset, setLyricOffset] = useState(() => {
    const saved = localStorage.getItem('lyricOffset')
    return saved ? parseFloat(saved) : 0
  })

  const [wordByWord, setWordByWord] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [lyricStyle, setLyricStyle] = useState<LyricStyleMode>(readLyricStyleMode)

  const [lyricGlow, setLyricGlow] = useState(() => {
    const saved = localStorage.getItem('lyricGlow')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [coverPulseEnabled, setCoverPulseEnabled] = useState(() => {
    const saved = localStorage.getItem('coverPulseEnabled')
    return saved !== null ? JSON.parse(saved) : false
  })

  const [coverPulseMode, setCoverPulseMode] = useState<CoverPulseMode>(() => {
    const saved = localStorage.getItem('coverPulseMode')
    if (saved === 'precise') return 'restless'
    return saved === 'dynamic' || saved === 'restless' ? saved : 'soft'
  })

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('playerTheme')
    if (saved === 'light' || saved === 'dark') return saved
    return playerTheme === 'light' ? 'light' : 'dark'
  })

  // 外部（播放面 / 设置面板 / 引导页 / 其它模式）改主题时同步回来，
  // 避免弹窗开着时面板配色与真机不一致。
  // ⚠️ 渲染用的 `isDaylight` 必须取本地 `theme`，**不要**取 prop `playerTheme` ——
  //    prop 要等 App 收到 `playerThemeChanged` → setState → 重渲染弹窗才会变，
  //    用户看到的就是"点了一下，面板过一会儿才变色"。
  useEffect(() => {
    const handlePlayerThemeChange = (event: Event) => {
      const next = (event as CustomEvent<string>).detail
      if (next === 'dark' || next === 'light') {
        setTheme(next)
        return
      }
      const saved = localStorage.getItem('playerTheme')
      setTheme(saved === 'light' ? 'light' : 'dark')
    }

    window.addEventListener('playerThemeChanged', handlePlayerThemeChange as EventListener)
    return () => window.removeEventListener('playerThemeChanged', handlePlayerThemeChange as EventListener)
  }, [])

  const [backgroundEffect, setBackgroundEffect] = useState<BackgroundEffect>(() => {
    const saved = localStorage.getItem('backgroundEffect')
    return (saved as BackgroundEffect) || 'blur'
  })

  const [backgroundBlur, setBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('backgroundBlur')
    return saved ? parseFloat(saved) : 30
  })

  // MV 视频背景的独立模糊度（与封面背景两套设置）；当前是否 MV 视频背景由 App 广播
  const [mvBackgroundBlur, setMvBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('mvBackgroundBlur')
    const parsed = saved ? parseFloat(saved) : Number.NaN
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
  })
  const [mvBackgroundActive, setMvBackgroundActive] = useState(false)
  useEffect(() => {
    const onActive = (e: Event) => setMvBackgroundActive((e as CustomEvent<boolean>).detail === true)
    window.addEventListener('mvBackgroundActiveChanged', onActive as EventListener)
    // 挂载时主动查询当前 MV 背景状态：本弹窗是按需挂载，可能晚于 MV 激活，错过一次性广播
    window.dispatchEvent(new Event('mvBackgroundActiveQuery'))
    return () => window.removeEventListener('mvBackgroundActiveChanged', onActive as EventListener)
  }, [])

  const [showImmersiveBar, setShowImmersiveBar] = useState(() => {
    const saved = localStorage.getItem('showImmersiveBar')
    if (saved === null) return true
    // 同 PlayerControls：脏值容错，避免 JSON.parse 抛错炸掉设置弹窗
    return saved === 'true' || saved === '1'
  })

  const [lyricDisplayMode, setLyricDisplayMode] = useState<LyricDisplayMode>(readLyricDisplayMode)

  useEffect(() => {
    const handleLyricDisplayModeChange = (event: Event) => {
      const mode = (event as CustomEvent<LyricDisplayMode>).detail
      if (mode && LYRIC_DISPLAY_MODES.includes(mode)) {
        setLyricDisplayMode(mode)
        return
      }

      setLyricDisplayMode(readLyricDisplayMode())
    }

    window.addEventListener('lyricDisplayModeChanged', handleLyricDisplayModeChange)
    return () => window.removeEventListener('lyricDisplayModeChanged', handleLyricDisplayModeChange)
  }, [])

  const [modernAudioVisualizerEnabled, setModernAudioVisualizerEnabled] = useState(() => {
    const saved = localStorage.getItem('modernAudioVisualizerEnabled')
    return saved !== null ? JSON.parse(saved) : true
  })

  // 摩登模式"左右交替歌词"（独立 key waveforge_modeng_side_align，仅 modeng 显示该项，不影响其它模式）
  const [modengSideAlign, setModengSideAlign] = useState<boolean>(() => {
    try { return localStorage.getItem('waveforge_modeng_side_align') === 'true' } catch { return false }
  })
  const handleModengSideAlignToggle = () => {
    const next = !modengSideAlign
    setModengSideAlign(next)
    try { localStorage.setItem('waveforge_modeng_side_align', JSON.stringify(next)) } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent('waveforge:modeng-side-align', { detail: next }))
  }

  // 现代模式"左右交替歌词"（独立 key waveforge_lyrics_side_align，柔和/摩登两种样式通用；
  // LyricsDisplay 经 waveforge:lyrics-side-align 事件实时响应）。默认开启（真机默认行为），
  // 仅用户显式存过 'false' 才视为关闭。
  const [lyricsSideAlign, setLyricsSideAlign] = useState<boolean>(() => {
    try { return localStorage.getItem('waveforge_lyrics_side_align') !== 'false' } catch { return true }
  })
  const handleLyricsSideAlignToggle = () => {
    const next = !lyricsSideAlign
    setLyricsSideAlign(next)
    try { localStorage.setItem('waveforge_lyrics_side_align', String(next)) } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent('waveforge:lyrics-side-align', { detail: next }))
  }

  // 音质快捷切换（播放条音质按钮）显示开关：默认开启，关掉后播放条不显示该按钮。
  // 独立 key + 事件同步（App 与 PlayerControls 分别监听）。
  const [qualityQuickSwitch, setQualityQuickSwitch] = useState<boolean>(() => {
    try { return localStorage.getItem('waveforge:quality-quick-switch') !== 'false' } catch { return true }
  })
  const handleQualityQuickSwitchToggle = () => {
    const next = !qualityQuickSwitch
    setQualityQuickSwitch(next)
    try { localStorage.setItem('waveforge:quality-quick-switch', String(next)) } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent('waveforge:quality-quick-switch-changed', { detail: next }))
  }

  const [hideImmersiveSongInfo, setHideImmersiveSongInfo] = useState(() => {
    const saved = localStorage.getItem('hideImmersiveSongInfo')
    return saved !== null ? JSON.parse(saved) : false
  })

  /* ------------------------------------------------------------------ *
   * 歌词补充设置（翻译 / 罗马音）与播放过渡设置。
   * 存储键与事件与 globalSettingsRegistry 的同名条目完全一致，任意一端改动全软件同步；
   * 过渡三开关的互斥规则直接复用注册表导出的 setTransitionModeExclusive，不另写一份。
   * ------------------------------------------------------------------ */

  const [translationEnabled, setTranslationEnabled] = useState(() => parseStoredBoolean(localStorage.getItem('translationEnabled'), false))

  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => (
    localStorage.getItem('translationPosition') === 'bottom-right' ? 'bottom-right' : 'traditional'
  ))

  const [romanEnabled, setRomanEnabled] = useState(() => parseStoredBoolean(localStorage.getItem('romanEnabled'), false))

  const [transitionMode, setTransitionMode] = useState<TransitionMode>(readTransitionMode)

  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = Number(localStorage.getItem('crossfadeDuration'))
    return Number.isFinite(saved) && saved > 0 ? saved : 4
  })

  const [albumGaplessEnabled, setAlbumGaplessEnabled] = useState(() => (
    localStorage.getItem('albumGaplessEnabled') !== 'false'
  ))

  // 外部（播放面按钮列 / 其它模式设置）改动时同步回来，避免两边显示不一致
  useEffect(() => {
    const syncTranslation = () => {
      setTranslationEnabled(parseStoredBoolean(localStorage.getItem('translationEnabled'), false))
      setTranslationPosition(localStorage.getItem('translationPosition') === 'bottom-right' ? 'bottom-right' : 'traditional')
    }
    const syncRoman = () => {
      setRomanEnabled(parseStoredBoolean(localStorage.getItem('romanEnabled'), false))
    }
    const syncTransition = () => {
      setTransitionMode(readTransitionMode())
      const duration = Number(localStorage.getItem('crossfadeDuration'))
      setCrossfadeDuration(Number.isFinite(duration) && duration > 0 ? duration : 4)
      setAlbumGaplessEnabled(localStorage.getItem('albumGaplessEnabled') !== 'false')
    }

    window.addEventListener('translationSettingsChanged', syncTranslation)
    window.addEventListener('romanSettingsChanged', syncRoman)
    window.addEventListener('crossfadeSettingsChanged', syncTransition)
    window.addEventListener('gaplessSettingsChanged', syncTransition)
    window.addEventListener('autoMixSettingsChanged', syncTransition)
    window.addEventListener('albumGaplessSettingsChanged', syncTransition)
    return () => {
      window.removeEventListener('translationSettingsChanged', syncTranslation)
      window.removeEventListener('romanSettingsChanged', syncRoman)
      window.removeEventListener('crossfadeSettingsChanged', syncTransition)
      window.removeEventListener('gaplessSettingsChanged', syncTransition)
      window.removeEventListener('autoMixSettingsChanged', syncTransition)
      window.removeEventListener('albumGaplessSettingsChanged', syncTransition)
    }
  }, [])

  /* ------------------------------------------------------------------ *
   * 滑块语义的设置项：拖动只更新 state + 广播（预览要立刻反映），
   * 松手/键盘操作结束才落盘 —— folia 的 onSliderPointerDown / onSliderCommit 同款分工。
   * ------------------------------------------------------------------ */

  const handleLyricSizeChange = (value: number) => {
    const next = Math.max(1.5, Math.min(4.5, Math.round(value * 10) / 10))
    setLyricSize(next)
    window.dispatchEvent(new CustomEvent('lyricSizeChanged', { detail: next }))
  }
  const handleLyricSizeCommit = () => {
    localStorage.setItem('lyricSize', lyricSize.toString())
  }

  const handleLyricOffsetChange = (value: number) => {
    const clamped = Math.max(-5, Math.min(5, Math.round(value * 10) / 10))
    const next = Math.abs(clamped) < 0.05 ? 0 : clamped
    setLyricOffset(next)
    window.dispatchEvent(new CustomEvent('lyricOffsetChanged', { detail: next }))
  }
  const handleLyricOffsetCommit = () => {
    localStorage.setItem('lyricOffset', lyricOffset.toString())
  }

  const handleWordByWordToggle = () => {
    const newValue = !wordByWord
    setWordByWord(newValue)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(newValue))
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  const handleLyricStyleChange = (mode: LyricStyleMode) => {
    setLyricStyle(mode)
    persistLyricStyleMode(mode)
  }

  const handleLyricGlowToggle = () => {
    const newValue = !lyricGlow
    setLyricGlow(newValue)
    localStorage.setItem('lyricGlow', JSON.stringify(newValue))
    window.dispatchEvent(new Event('lyricGlowChanged'))
  }

  const handleCoverPulseToggle = () => {
    const newValue = !coverPulseEnabled
    setCoverPulseEnabled(newValue)
    localStorage.setItem('coverPulseEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('coverPulseChanged', { detail: newValue }))
  }

  const handleCoverPulseModeChange = (mode: CoverPulseMode) => {
    setCoverPulseMode(mode)
    localStorage.setItem('coverPulseMode', mode)
    window.dispatchEvent(new CustomEvent('coverPulseModeChanged', { detail: mode }))
  }

  const handleThemeChange = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme)
    localStorage.setItem('playerTheme', newTheme)
    window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: newTheme }))
  }

  const handleBackgroundEffectChange = (effect: BackgroundEffect) => {
    setBackgroundEffect(effect)
    localStorage.setItem('backgroundEffect', effect)
    window.dispatchEvent(new CustomEvent('backgroundEffectChanged', { detail: effect }))
  }

  // 模糊滑块当前生效值/写回：MV 视频背景激活时操作 mvBackgroundBlur，封面背景时操作 backgroundBlur
  const activeBackgroundBlur = mvBackgroundActive ? mvBackgroundBlur : backgroundBlur

  const handleBackgroundBlurChange = (value: number) => {
    if (mvBackgroundActive) {
      setMvBackgroundBlur(value)
      window.dispatchEvent(new CustomEvent('mvBackgroundBlurChanged', { detail: value }))
    } else {
      setBackgroundBlur(value)
      window.dispatchEvent(new CustomEvent('backgroundBlurChanged', { detail: value }))
    }
  }

  const handleBackgroundBlurCommit = () => {
    if (mvBackgroundActive) {
      localStorage.setItem('mvBackgroundBlur', mvBackgroundBlur.toString())
    } else {
      localStorage.setItem('backgroundBlur', backgroundBlur.toString())
    }
  }

  const handleImmersiveBarToggle = () => {
    const newValue = !showImmersiveBar
    setShowImmersiveBar(newValue)
    localStorage.setItem('showImmersiveBar', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('immersiveBarChanged', { detail: newValue }))
  }

  const handleModernAudioVisualizerToggle = () => {
    const newValue = !modernAudioVisualizerEnabled
    setModernAudioVisualizerEnabled(newValue)
    localStorage.setItem('modernAudioVisualizerEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('modernAudioVisualizerChanged', { detail: newValue }))
  }

  const handleHideImmersiveSongInfoToggle = () => {
    const newValue = !hideImmersiveSongInfo
    setHideImmersiveSongInfo(newValue)
    localStorage.setItem('hideImmersiveSongInfo', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('hideImmersiveSongInfoChanged', { detail: newValue }))
  }

  /* ------------------------------------------------------------------ *
   * 歌词补充设置 / 播放过渡设置
   * ------------------------------------------------------------------ */

  /**
   * 切歌词模式：只落盘 + 广播，**不要**在这里直接改 App 的 mode 状态。
   * App 的 `handleExternalLyricMode` 收到事件后会走完整切换流程（预加载目标模式 chunk、
   * 收起顶部模式切换器、丢弃过期请求），本地直接切会绕过 chunk 预加载导致播放页闪空。
   */
  const handleLyricDisplayModeSelect = (mode: LyricDisplayMode) => {
    if (mode === lyricDisplayMode) return
    setLyricDisplayMode(mode)
    localStorage.setItem('lyricDisplayMode', mode)
    window.dispatchEvent(new CustomEvent('lyricDisplayModeChanged', { detail: mode }))
  }

  const handleTranslationToggle = () => {
    const newValue = !translationEnabled
    setTranslationEnabled(newValue)
    localStorage.setItem('translationEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleTranslationPositionChange = (position: 'traditional' | 'bottom-right') => {
    setTranslationPosition(position)
    localStorage.setItem('translationPosition', position)
    window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: position }))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleRomanToggle = () => {
    const newValue = !romanEnabled
    setRomanEnabled(newValue)
    localStorage.setItem('romanEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new Event('romanSettingsChanged'))
  }

  /** 过渡方式四选一：互斥规则交给注册表，本地只按落盘结果刷新选中态。 */
  const handleTransitionModeChange = (mode: TransitionMode) => {
    if (mode === 'none') {
      for (const target of ['crossfade', 'gapless', 'autoMix'] as const) {
        setTransitionModeExclusive(target, false)
      }
    } else {
      setTransitionModeExclusive(mode, true)
    }
    setTransitionMode(readTransitionMode())
  }

  /**
   * 渐入渐出时长：与注册表同款「改一次写一次」，**不做拖动/提交分离**——
   * App 的 handleCrossfadeChange 收到事件时是从 localStorage 读值的，
   * 沿用滑块的「松手才落盘」会让引擎在拖动期间一直读到旧时长。
   */
  const handleCrossfadeDurationChange = (value: number) => {
    const next = Math.max(1, Math.min(12, Math.round(value * 2) / 2))
    setCrossfadeDuration(next)
    localStorage.setItem('crossfadeDuration', next.toString())
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }

  const handleAlbumGaplessToggle = () => {
    const newValue = !albumGaplessEnabled
    setAlbumGaplessEnabled(newValue)
    localStorage.setItem('albumGaplessEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new Event('albumGaplessSettingsChanged'))
  }

  const formatLyricOffset = (value: number) => {
    const normalized = Math.abs(value) < 0.05 ? 0 : value
    return normalized.toFixed(1)
  }

  /* ------------------------------------------------------------------ *
   * 控制台控件配方
   * ------------------------------------------------------------------ */

  // 面板整套配色由**本地** `theme` 派生（不是 prop `playerTheme`）——
  // 见上面 theme state 旁的注释：用 prop 会让面板在点击后延迟一拍才变色。
  const { isDaylight, accent: accentHex, primary, secondary, background: bgColor } = buildQuickSettingsPalette(accentColor, theme)

  const panelBgClass = isDaylight ? 'bg-white' : 'bg-[#18181b]'
  const panelBorderClass = isDaylight ? 'border-black/5' : 'border-white/10'
  const dividerClass = isDaylight ? 'border-black/10' : 'border-white/10'

  /** 机架槽 / 分区导轨的共用底：面板本色 + 极淡浮层，靠描边与 accent 竖轨成型。 */
  const surfaceStyle: CSSProperties = {
    backgroundColor: isDaylight ? 'rgba(0,0,0,0.032)' : 'rgba(255,255,255,0.032)',
    borderColor: toRgba(secondary, isDaylight ? 0.2 : 0.13),
  }

  /**
   * 键位选中态：单层 accent 描边（**不是** folia 那套 `inset 0 0 0 1px` 双环）+ 淡 accent 底，
   * 暗色下再补一层外发光当「背光」。亮色主题不加发光，避免糊边。
   * 亮色的未选中态描边要比暗色更重（0.22 vs 0.12）——浅底上 0.15 的灰边会淡到像空盒子。
   */
  const optionStyle = (selected: boolean): CSSProperties => (
    selected
      ? {
          borderColor: toRgba(accentHex, isDaylight ? 0.55 : 0.58),
          backgroundColor: toRgba(accentHex, isDaylight ? 0.13 : 0.19),
          color: primary,
          boxShadow: isDaylight ? 'none' : `0 2px 12px -5px ${toRgba(accentHex, 0.85)}`,
        }
      : {
          borderColor: toRgba(secondary, isDaylight ? 0.22 : 0.12),
          backgroundColor: isDaylight ? 'rgba(0,0,0,0.022)' : 'rgba(255,255,255,0.018)',
          color: secondary,
        }
  )

  /**
   * 机架槽：`01` 编号 + 图标 + 中文名 + 延伸到右端的细线（可挂右上角操作钮），
   * 左侧一条 accent 竖轨做槽位标识。**槽名不要带序号文本**——测试按可见名取分组标签。
   *
   * 版式（2026-09-24 第八轮）：槽位是**横向并排的机箱模块** —— `flex-1 basis-0` 等宽、
   * 高度由父级拉伸到整行（所以同段各槽顶端/底端对齐）。标题固定在顶部，
   * 控件区 `flex-1 overflow-y-auto` 兜底：正常窗口下永远不出现滚动条，
   * 只有在极矮窗口里才会**单独让这一槽**滚，而不是把整个弹窗撑出滚动条。
   */
  const renderSlot = (
    index: string,
    title: string,
    icon: LucideIcon,
    children: ReactNode,
    action?: ReactNode,
  ) => {
    const Icon = icon
    return (
      <section
        className="relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden rounded-[14px] border py-3 pl-4 pr-3.5"
        style={surfaceStyle}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0 h-full w-[2px]"
          style={{ backgroundColor: toRgba(accentHex, 0.5) }}
        />
        <header className="mb-2.5 flex shrink-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="font-mono text-[10px] font-semibold tabular-nums leading-none"
            style={{ color: toRgba(accentHex, 0.95) }}
          >
            {index}
          </span>
          <Icon size={13} style={{ color: secondary }} />
          <span className="shrink-0 text-[13px] font-semibold tracking-[0.01em]" style={{ color: primary }}>
            {title}
          </span>
          <span aria-hidden="true" className="h-px min-w-2 flex-1" style={{ backgroundColor: toRgba(secondary, 0.16) }} />
          {action}
        </header>
        <div
          className={`qs-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1 ${isDaylight ? 'qs-scroll-light' : ''}`}
        >
          {children}
        </div>
      </section>
    )
  }

  /**
   * 分组标签 + 等宽键位网格。
   *
   * `layout.columns` 给定列数时用 `repeat(N, minmax(0,1fr))` 并**限宽**（`N × 132px`）：
   * 不限宽的话 2 项的组（界面主题、歌词风格样式）会被 `1fr` 拉成两枚 250px 的巨型空盒，
   * 与 4 项组并排看比例全乱。限宽后键位统一在 130px 上下，左对齐、末尾留白，像一块键区。
   * 不传 `columns` 时退回 `auto-fit + keyMin`（列数由容器宽度决定）。
   *
   * 键位按钮必带 `aria-label` —— 内部有装饰节点时，可见文本不再等于可访问名。
   */
  const renderPresetGroup = (
    label: string,
    options: Array<{ value: string; label: string }>,
    current: string,
    onSelect: (value: string) => void,
    layout?: { keyMin?: number; columns?: number },
  ) => {
    const columns = layout?.columns
    const keyMin = layout?.keyMin ?? 82
    const gridStyle: CSSProperties = columns
      ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, maxWidth: `${columns * 132 + (columns - 1) * 6}px` }
      : { gridTemplateColumns: `repeat(auto-fit, minmax(${keyMin}px, 1fr))` }

    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="h-[6px] w-[6px] shrink-0 rounded-[1px]"
            style={{ backgroundColor: toRgba(secondary, 0.45) }}
          />
          <span className="shrink-0 text-[11.5px] font-medium" style={{ color: secondary }}>
            {label}
          </span>
          <span aria-hidden="true" className="h-px min-w-2 flex-1" style={{ backgroundColor: toRgba(secondary, 0.1) }} />
        </div>
        <div className="grid gap-1.5" style={gridStyle}>
          {options.map((option) => {
            const selected = current === option.value
            return (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={selected}
                onClick={() => onSelect(option.value)}
                className="relative flex min-w-0 items-center justify-center rounded-[7px] border px-2.5 py-[7px] text-[13px] leading-tight transition-all active:scale-[0.97]"
                style={optionStyle(selected)}
              >
                {selected ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-[6px] left-[3px] w-[2px] rounded-full"
                    style={{ backgroundColor: accentHex }}
                  />
                ) : null}
                <span className="truncate">{option.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  /**
   * 方形摇臂开关：轨道 `rounded-[6px]`，滑块是方形（不是 folia 的圆点），
   * 打开时轨道着 accent 底 + 暗色下点一圈光晕。`aria-label` = 行标题（测试按它取钮）。
   * 注意：标题所在的 div **只能含标题文本**（图标是 svg 无文本），否则按可见文本断言会失效。
   */
  const renderToggleRow = (
    label: string,
    checked: boolean,
    onToggle: () => void,
    config?: { description?: string; icon?: LucideIcon },
  ) => {
    const Icon = config?.icon
    return (
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-[12.5px] font-medium" style={{ color: primary }}>
            {Icon ? <Icon size={13} style={{ color: secondary }} /> : null}
            {label}
          </div>
          {config?.description ? (
            <div className="text-[11px] leading-relaxed" style={{ color: toRgba(secondary, 0.82) }}>
              {config.description}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={label}
          aria-pressed={checked}
          onClick={onToggle}
          className="h-[22px] w-[42px] shrink-0 rounded-[6px] border p-[2px] transition-colors"
          style={{
            borderColor: checked ? toRgba(accentHex, 0.75) : toRgba(secondary, 0.22),
            backgroundColor: checked ? toRgba(accentHex, isDaylight ? 0.22 : 0.34) : toRgba(secondary, 0.08),
            boxShadow: checked && !isDaylight ? `0 0 14px -4px ${toRgba(accentHex, 0.9)}` : 'none',
          }}
        >
          {/* 行程 = 内容宽(42-2边框-4内边距=36) − 滑块宽 16 = 20px，写死 18px 会差 2px 不到位。
              打开时滑块用白色（**不要**用 accentHex）：同色滑块压在 accent 轨道上等于隐形。 */}
          <span
            className="block h-[16px] w-[16px] rounded-[3px] transition-transform duration-200"
            style={{
              backgroundColor: checked ? '#ffffff' : toRgba(secondary, 0.62),
              transform: checked ? 'translateX(20px)' : 'translateX(0)',
              boxShadow: '0 1px 2px rgba(0,0,0,0.32)',
            }}
          />
        </button>
      </div>
    )
  }

  /**
   * 推子：底层灰轨 + accent 填充条 + 顶部透明 range（方形拇指）+ 底部刻度尺 + mono 数值框。
   * 填充宽度在 JS 里算，**不用 CSS 变量** —— `style` 里写 `'--x'` 的类型断言在
   * `CSSProperties`（弱类型、无索引签名）上不稳妥，分层绘制更省事也更好调。
   * `onCommit` 可省：多数项是「拖动广播、松手落盘」，但渐入渐出时长必须每次改动都落盘
   * （引擎收到广播时从存储读值），那一项就不传。
   */
  const renderSliderRow = (
    label: string,
    value: number,
    display: string,
    min: number,
    max: number,
    step: number,
    onChange: (value: number) => void,
    onCommit?: () => void,
  ) => {
    const ratio = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
    const trackColor = isDaylight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.10)'

    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-[12px]" style={{ color: secondary }}>
            {label}
          </span>
          <span
            className="shrink-0 rounded-[5px] border px-[6px] py-[2px] font-mono text-[10.5px] tabular-nums leading-none"
            style={{
              borderColor: toRgba(secondary, 0.18),
              backgroundColor: isDaylight ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.05)',
              color: primary,
            }}
          >
            {display}
          </span>
        </div>

        <div className="relative flex h-[18px] items-center">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 h-[6px] rounded-[2px]"
            style={{ backgroundColor: trackColor }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-0 h-[6px] rounded-[2px]"
            style={{ width: `${ratio * 100}%`, backgroundColor: toRgba(accentHex, 0.8) }}
          />
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            aria-label={label}
            onChange={(event) => onChange(parseFloat(event.target.value))}
            onPointerUp={onCommit}
            onKeyUp={onCommit}
            className="qs-fader relative z-10"
          />
        </div>

        <div aria-hidden="true" className="flex justify-between px-[1px]">
          {Array.from({ length: FADER_TICKS }).map((_, i) => (
            <span
              key={i}
              className="h-[4px] w-px"
              style={{
                backgroundColor:
                  i / (FADER_TICKS - 1) <= ratio + 0.001
                    ? toRgba(accentHex, 0.7)
                    : toRgba(secondary, isDaylight ? 0.24 : 0.3),
              }}
            />
          ))}
        </div>
      </div>
    )
  }

  /** 槽头右上角的「默认」小方钮（比 folia 的圆胶囊更方、更小）。 */
  const renderGhostChip = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-[6px] border px-2 py-[3px] text-[10.5px] transition-colors"
      style={{
        color: secondary,
        borderColor: toRgba(secondary, 0.18),
        backgroundColor: isDaylight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.04)',
      }}
    >
      <RotateCcw size={11} />
      {label}
    </button>
  )

  const sectionTabs: Array<{ id: QuickSettingsSection; label: string }> = [
    { id: 'appearance', label: '外观' },
    { id: 'features', label: '功能' },
    { id: 'playback', label: '播放' },
  ]

  const sectionIndex = Math.max(0, sectionTabs.findIndex(tab => tab.id === activeSection))

  /** 当前模式若不在这六项里（看歌 / Folia / PV），补一枚同名的选中 chip，避免「一个都没选中」。 */
  const lyricModeOptions = [
    ...QUICK_LYRIC_MODES.map(mode => ({ value: mode as string, label: LYRIC_MODE_LABELS[mode] })),
    ...(QUICK_LYRIC_MODES.includes(lyricDisplayMode)
      ? []
      : [{ value: lyricDisplayMode as string, label: LYRIC_MODE_LABELS[lyricDisplayMode] }]),
  ]

  const transitionOptions = [
    { value: 'none', label: '关闭' },
    { value: 'crossfade', label: '渐入渐出' },
    { value: 'gapless', label: '无缝衔接' },
    { value: 'autoMix', label: '智能混音' },
  ]

  const backgroundEffectOptions = (Object.keys(BACKGROUND_EFFECT_LABELS) as BackgroundEffect[])
    .map(effect => ({ value: effect as string, label: BACKGROUND_EFFECT_LABELS[effect] }))

  /** 监视器四角托架（纯装饰），给实时预览一块「仪器屏」的轮廓。 */
  const cornerBrackets = [
    'left-[-2px] top-[-2px] border-l-2 border-t-2 rounded-tl-[4px]',
    'right-[-2px] top-[-2px] border-r-2 border-t-2 rounded-tr-[4px]',
    'left-[-2px] bottom-[-2px] border-l-2 border-b-2 rounded-bl-[4px]',
    'right-[-2px] bottom-[-2px] border-r-2 border-b-2 rounded-br-[4px]',
  ]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      // exit 不做动画：关闭立即卸载。曾用 exit={{ opacity: 0 }} + 0.22s 过渡，但
      // 窗口失焦/后台标签下 framer 的 rAF 驱动会暂停，exit 永远停在半路 —— 遮罩以
      // opacity:0 但 pointer-events:auto 残留在全屏播放页上，拦截一切点击且"面板关不掉"。
      // 播放设置是功能性弹层，立即消失比"可能卡住的淡出"正确（若要动画须保证 rAF 常驻）。
      exit={{ opacity: 0, pointerEvents: 'none' }}
      transition={{ duration: 0 }}
      role="presentation"
      className="fixed inset-0 z-[140] flex items-stretch justify-center p-3 sm:items-center sm:p-6"
      style={{
        // 遮罩（弹窗外的背景）：压暗 + 高斯模糊 + 主色光晕三件套。
        // 原先只有一层纯黑 0.65，在深色播放面上等于「弹窗浮在虚空里」（用户反馈"外面没背景"）。
        backgroundColor: isDaylight ? 'rgba(242,243,247,0.74)' : 'rgba(8,9,13,0.7)',
        backdropFilter: 'blur(26px) saturate(125%)',
        WebkitBackdropFilter: 'blur(26px) saturate(125%)',
      }}
      onMouseDown={handleOverlayMouseDown}
      onClick={handleBackdropClick}
    >
      {/* 主色光晕：跟随封面主色，顶部最亮，避免整块遮罩死黑 */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(120% 85% at 50% -10%, ${toRgba(accentHex, isDaylight ? 0.18 : 0.26)} 0%, transparent 60%)` }}
      />
      <motion.div
        data-tv-scope
        role="dialog"
        aria-modal="true"
        aria-label="播放设置"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 18, scale: 0.98, pointerEvents: 'none' }}
        transition={{ duration: 0 }}
        className="relative m-auto flex max-h-[840px] w-full max-w-[1060px] flex-col overflow-hidden rounded-[20px] border"
        data-qs-theme={isDaylight ? 'light' : 'dark'}
        style={{
          // 面板本体（弹窗内的背景）：渐变实底 + 高光边 + 分层投影。
          // 原先是单色 bg-[#18181b] 压在同色遮罩上，几乎没有"抬起来"的层次感（用户反馈"里面也没背景"）。
          background: isDaylight
            ? 'linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(246,247,250,0.98) 100%)'
            : 'linear-gradient(180deg, rgba(38,41,54,0.99) 0%, rgba(20,21,29,0.99) 100%)',
          borderColor: isDaylight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.14)',
          boxShadow: isDaylight
            ? '0 40px 100px -28px rgba(15,18,30,0.42), inset 0 1px 0 rgba(255,255,255,0.9)'
            : '0 44px 120px -28px rgba(0,0,0,0.9), inset 0 1px 0 rgba(255,255,255,0.1)',
          backdropFilter: 'blur(40px) saturate(140%)',
          WebkitBackdropFilter: 'blur(40px) saturate(140%)',
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <style>{`
          /* 推子本体：透明轨道，方形拇指。
             轨道与填充条是它下面两层绝对定位的 div（宽度在 JS 里算），
             所以这里只负责「拇指 + 命中区域」。输入框高 18px = 拇指高，
             天然垂直居中，不需要 ::-webkit-slider-runnable-track 调 offset。 */
          .qs-fader {
            width: 100%;
            height: 18px;
            appearance: none;
            -webkit-appearance: none;
            background: transparent;
            cursor: pointer;
          }
          .qs-fader:focus { outline: none; }
          .qs-fader::-webkit-slider-runnable-track {
            height: 18px;
            background: transparent;
          }
          .qs-fader::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 11px;
            height: 18px;
            border-radius: 2px;
            background: #ffffff;
            border: 1px solid rgba(0, 0, 0, 0.38);
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
            transition: transform 0.12s ease;
          }
          .qs-fader::-webkit-slider-thumb:hover { transform: scaleX(1.3); }
          .qs-fader::-moz-range-track { height: 18px; background: transparent; }
          .qs-fader::-moz-range-thumb {
            width: 11px;
            height: 18px;
            border-radius: 2px;
            background: #ffffff;
            border: 1px solid rgba(0, 0, 0, 0.38);
          }

          /* 机架槽滚动条：细窄半透明，与弹窗主题一致。
             刻意不写标准的 scrollbar-width/scrollbar-color —— Chromium 一旦认了它们
             就会忽略 ::-webkit-scrollbar，细度会交给系统的 thin（8~11px 浅灰条）。 */
          .qs-scroll::-webkit-scrollbar { width: 5px; }
          .qs-scroll::-webkit-scrollbar-track { background: transparent; }
          .qs-scroll::-webkit-scrollbar-thumb {
            border-radius: 10px;
            background: rgba(255, 255, 255, 0.16);
          }
          .qs-scroll-light::-webkit-scrollbar-thumb { background: rgba(0, 0, 0, 0.16); }
        `}</style>

        {/* 顶栏：标题 + 分段 chip + 关闭。分段从底部搬到顶栏 —— 视线自上而下：先选段、再调项。
            chip 保留 `aria-label = 分段名`（可见文本前面带 `01` 序号，可访问名不能带序号）。 */}
        <header className={`flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 border-b px-4 py-3 sm:px-5 ${dividerClass}`}>
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="hidden h-8 w-[3px] shrink-0 rounded-full sm:block"
              style={{ backgroundColor: accentHex }}
            />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold tracking-[0.02em]" style={{ color: primary }}>
                播放设置
              </div>
              <div
                className="mt-[3px] truncate font-mono text-[9px] uppercase leading-none tracking-[0.3em]"
                style={{ color: toRgba(secondary, 0.7) }}
              >
                playback console
              </div>
            </div>
          </div>

          <nav
            aria-label="设置分段"
            className="order-3 flex w-full flex-wrap items-center gap-1.5 sm:order-none sm:ml-4 sm:w-auto"
          >
            {sectionTabs.map((tab, tabIndex) => {
              const active = activeSection === tab.id
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-label={tab.label}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setActiveSection(tab.id)}
                  className="relative flex shrink-0 items-center gap-2 overflow-hidden rounded-[9px] border px-3 py-[7px] transition-all active:scale-[0.97]"
                  style={optionStyle(active)}
                >
                  {active ? (
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-[5px] left-[3px] w-[2px] rounded-full"
                      style={{ backgroundColor: accentHex }}
                    />
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="font-mono text-[9px] font-semibold tabular-nums leading-none"
                    style={{ color: active ? toRgba(accentHex, 0.95) : toRgba(secondary, 0.55) }}
                  >
                    {`0${tabIndex + 1}`}
                  </span>
                  <span className="text-[12.5px] font-medium leading-none">{tab.label}</span>
                </button>
              )
            })}
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-2.5">
            <span
              aria-hidden="true"
              className="hidden font-mono text-[9.5px] uppercase leading-none tabular-nums tracking-[0.2em] md:block"
              style={{ color: toRgba(secondary, 0.65) }}
            >
              {`${String(sectionIndex + 1).padStart(2, '0')} / ${String(sectionTabs.length).padStart(2, '0')}`}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭播放设置"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] border transition-colors"
              style={{
                borderColor: toRgba(secondary, 0.18),
                backgroundColor: isDaylight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.04)',
                color: primary,
              }}
            >
              <X size={15} />
            </button>
          </div>
        </header>

        {/* 内容区：上半块是**实时预览监视器**（本弹窗的亮点，不可删），下半块是卡片网格。
            监视器封顶高度、卡片区独立滚动 —— 预览不再随分段内容忽大忽小，也不会挤掉设置项。 */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 p-4 sm:gap-3.5 sm:p-5">
          <div className="flex shrink-0 items-center justify-center" style={{ height: 'clamp(210px, 38vh, 380px)' }}>
            <div
              className="relative flex h-full shrink-0 items-center justify-center rounded-[16px] border p-3"
              style={{
                backgroundColor: isDaylight ? 'rgba(0,0,0,0.045)' : 'rgba(0,0,0,0.22)',
                borderColor: toRgba(secondary, isDaylight ? 0.2 : 0.13),
              }}
            >
              <div className="relative aspect-video h-full shrink-0">
                <QuickSettingsPreview
                  isDaylight={isDaylight}
                  accentColor={accentHex}
                  lyricDisplayMode={lyricDisplayMode}
                  backgroundEffect={backgroundEffect}
                  backgroundBlur={activeBackgroundBlur}
                  showImmersiveBar={showImmersiveBar}
                  lyricSize={lyricSize}
                  wordByWord={wordByWord}
                  lyricStyle={lyricStyle}
                  lyricGlow={lyricGlow}
                  coverPulseEnabled={coverPulseEnabled}
                  coverPulseMode={coverPulseMode}
                  hideSongInfo={lyricDisplayMode === 'immersive' && hideImmersiveSongInfo}
                  showVisualizer={modernAudioVisualizerEnabled}
                  playback={playback}
                />
                {cornerBrackets.map((position) => (
                  <span
                    key={position}
                    aria-hidden="true"
                    className={`pointer-events-none absolute h-4 w-4 ${position}`}
                    style={{ borderColor: toRgba(accentHex, 0.55) }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className={`qs-scroll min-h-0 flex-1 overflow-y-auto ${isDaylight ? 'qs-scroll-light' : ''}`}>
            <div className="grid grid-cols-1 gap-3 sm:gap-3.5 md:grid-cols-2 xl:grid-cols-3">
            {/* 机架槽：栅格自适应列数（窄窗 1 列 / 中 2 列 / 宽 3 列），同段各槽顶端对齐。
                槽数随分段变（外观 3 / 功能 4 / 播放 2），卡片高度由内容撑开 —— 不再有固定高度窗口，
                高窗口也不会留大片空白。 */}
            {activeSection === 'appearance' ? (
              <>
                {renderSlot(
                  '01',
                  '界面与背景',
                  Palette,
                  <>
                    {renderPresetGroup(
                      '界面主题',
                      [
                        { value: 'dark', label: '深色' },
                        { value: 'light', label: '浅色' },
                      ],
                      theme,
                      (value) => handleThemeChange(value as 'dark' | 'light'),
                      { columns: 2 },
                    )}

                    {renderPresetGroup(
                      '背景效果',
                      backgroundEffectOptions,
                      backgroundEffect,
                      (value) => handleBackgroundEffectChange(value as BackgroundEffect),
                      { columns: 4 },
                    )}

                    {renderToggleRow('音质快捷切换', qualityQuickSwitch, handleQualityQuickSwitchToggle, {
                      description: '播放条显示当前音质，点击可快速切换',
                      icon: Headphones,
                    })}
                  </>,
                  renderGhostChip('默认', () => {
                    handleThemeChange('dark')
                    handleBackgroundEffectChange('blur')
                    handleBackgroundBlurChange(30)
                    handleBackgroundBlurCommit()
                  }),
                )}

                {/* 02 槽：只放**按背景效果出现**的调节项。
                    第九轮把外观段从 2 槽拆成 3 槽 —— 原来「界面与背景」一槽 4 个控件、
                    「律动与显示」一槽 3 个，两槽都要 210~289px，共同撑着下半块高度。
                    拆成 3 槽、每槽 ≤2 个必现控件后，外观段的需求上限降到约 190px。
                    ⚠️ 「通透」「沉浸」之外没有可调项（模糊模式用的是写死的 40px），
                    给一行说明文案兜底，否则那两种背景下这一槽就是个空盒子。 */}
                {renderSlot(
                  '02',
                  '背景细节',
                  Layers,
                  <>
                    {(backgroundEffect === 'transparent' || backgroundEffect === 'immersive') &&
                      renderSliderRow(
                        '模糊程度',
                        activeBackgroundBlur,
                        `${activeBackgroundBlur}px`,
                        0,
                        100,
                        1,
                        handleBackgroundBlurChange,
                        handleBackgroundBlurCommit,
                      )}

                    {backgroundEffect === 'immersive' &&
                      renderToggleRow('隐藏白条', !showImmersiveBar, handleImmersiveBarToggle, {
                        description: '沉浸模式下收起底部进度条',
                        icon: Layers,
                      })}

                    {backgroundEffect !== 'transparent' && backgroundEffect !== 'immersive' ? (
                      <p
                        className="pt-0.5 text-[11.5px] leading-relaxed"
                        style={{ color: toRgba(secondary, 0.6) }}
                      >
                        当前背景效果使用固定参数，没有可调项。
                      </p>
                    ) : null}
                  </>,
                )}

                {renderSlot(
                  '03',
                  '封面律动',
                  Waves,
                  <>
                    {renderToggleRow('跟随节拍律动', coverPulseEnabled, handleCoverPulseToggle, {
                      description: '封面随低频能量起伏',
                      icon: Waves,
                    })}

                    {coverPulseEnabled &&
                      renderPresetGroup(
                        '律动效果',
                        [
                          { value: 'dynamic', label: '动感' },
                          { value: 'soft', label: '柔和' },
                          { value: 'restless', label: '躁动' },
                        ],
                        coverPulseMode,
                        (value) => handleCoverPulseModeChange(value as CoverPulseMode),
                        { columns: 3 },
                      )}
                  </>,
                )}
              </>
            ) : activeSection === 'features' ? (
              <>
                {/* 01 槽：画面上的附加显示。第九轮把「隐藏歌名艺人」「左右交替歌词」
                    这两个**按歌词模式出现**的开关从 03 槽挪过来 —— 它们留在 03 槽时，
                    「沉浸/摩登」下那一槽会变成 4 个控件、卡片要 289px 才不滚动。
                    挪到原本只有 1 个控件的这一槽后，任何模式都 ≤3 个控件。 */}
                {renderSlot(
                  '01',
                  '画面显示',
                  AudioLines,
                  <>
                    {renderToggleRow('实时频谱条', modernAudioVisualizerEnabled, handleModernAudioVisualizerToggle, {
                      description: '在左下角显示当前音频的频谱',
                      icon: AudioLines,
                    })}

                    {/* 「歌词偏移」原在 02 槽，但 02 槽的「歌词模式」是 6 项 3 列的键位网格、
                        本身就有两行高，再加两个滑杆就把那一槽顶到 needH 271（全场最高）。
                        挪到这里后 02 槽只剩 2 个控件，槽位需求上限整体降到约 221。 */}
                    {renderSliderRow(
                      '歌词偏移',
                      lyricOffset,
                      formatLyricOffset(lyricOffset),
                      -5,
                      5,
                      0.1,
                      handleLyricOffsetChange,
                      handleLyricOffsetCommit,
                    )}

                    {lyricDisplayMode === 'immersive' &&
                      renderToggleRow('隐藏歌名艺人', hideImmersiveSongInfo, handleHideImmersiveSongInfoToggle, {
                        description: '沉浸模式左上角只留歌词',
                        icon: Settings2,
                      })}

                    {lyricDisplayMode === 'modeng' &&
                      renderToggleRow('左右交替歌词', modengSideAlign, handleModengSideAlignToggle, {
                        description: '摩登模式按段落交替对齐两侧',
                      })}

                    {/* 现代模式（lyricDisplayMode === 'modern'）的左右交替：key 独立于摩登模式，
                        柔和/摩登两种歌词样式通用（LyricsDisplay 按行预计算对齐侧）。 */}
                    {lyricDisplayMode === 'modern' &&
                      renderToggleRow('左右交替歌词', lyricsSideAlign, handleLyricsSideAlignToggle, {
                        description: '对唱按演唱者左右分栏（柔和与摩登通用）',
                      })}

                    {/* 歌词大小从原 02 槽（歌词呈现）挪来：模式切换已由顶部下拉承担，
                        播放设置不再重复；字号是所有模式通用的画面属性，归 01 画面显示。 */}
                    {renderSliderRow(
                      '歌词大小',
                      lyricSize,
                      lyricSize.toFixed(1),
                      1.5,
                      4.5,
                      0.1,
                      handleLyricSizeChange,
                      handleLyricSizeCommit,
                    )}
                  </>,
                )}

                {renderSlot(
                  '02',
                  '歌词呈现',
                  Settings2,
                  <>
                    {lyricDisplayMode === 'folia' && foliaStyle ? (
                      <>
                        {/* Folia 参数改成**二级弹窗**（用户反馈：参数项多，塞在 02 槽
                            既溢出又挤压预览）。02 槽只留入口按钮 + 当前样式名；
                            点击打开独立弹窗，复用 FoliaTuningPanel 的大空间布局。 */}
                        <button
                          type="button"
                          onClick={() => setFoliaSubDialogOpen(true)}
                          className={`w-full rounded-xl border px-4 py-3 text-left transition-colors ${playerTheme === 'dark' ? 'border-white/12 bg-white/[0.05] hover:bg-white/[0.09]' : 'border-black/10 bg-black/[0.03] hover:bg-black/[0.06]'}`}
                        >
                          <span className={`block text-[13px] font-medium ${playerTheme === 'dark' ? 'text-white/90' : 'text-black/85'}`}>
                            {FOLIA_STYLE_ZH[foliaStyle] ?? foliaStyle} · 参数设置
                          </span>
                          <span className={`mt-0.5 block text-[11px] ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/45'}`}>
                            {foliaStyleHasPanel(foliaStyle)
                              ? '歌词动画 / 智能动感 / 字幕与背景等参数'
                              : '当前样式没有独立参数'}
                          </span>
                        </button>
                      </>
                    ) : (
                      /* 非 Folia 模式：02 槽保留原「歌词模式」网格（下拉切换器之外的快捷入口），
                         Folia 模式下隐藏 —— 模式切换已在顶部下拉，避免重复入口。 */
                      !isPureMusic &&
                      renderPresetGroup(
                        '歌词模式',
                        lyricModeOptions.filter(option => option.value !== 'folia'),
                        lyricDisplayMode,
                        (value) => handleLyricDisplayModeSelect(value as LyricDisplayMode),
                        { columns: 3 },
                      )
                    )}
                  </>,
                )}

                {/* 第三槽：歌词细节。从原「歌词呈现」里拆出来 —— 一个槽塞 8 个控件会把
                    下半块撑出滚动条（第八轮就是为这个拆的）。第九轮再把两个条件开关
                    （隐藏歌名艺人 / 左右交替歌词）挪去 01 槽，这里固定 3 个控件。
                    纯音乐没有歌词，整槽不渲染。 */}
                {!isPureMusic &&
                  renderSlot(
                    '03',
                    '歌词细节',
                    Type,
                    <>
                      {renderToggleRow('逐字歌词', wordByWord, handleWordByWordToggle, {
                        description: '按演唱进度逐字点亮，而不是整行切换',
                      })}

                      {renderPresetGroup(
                        '歌词风格样式',
                        [
                          { value: 'soft', label: '柔和' },
                          { value: 'modern', label: '摩登' },
                        ],
                        lyricStyle,
                        (value) => handleLyricStyleChange(value as LyricStyleMode),
                        { columns: 2 },
                      )}

                      {renderToggleRow('歌词高光', lyricGlow, handleLyricGlowToggle, {
                        description: '当前行叠加一层柔光',
                      })}
                    </>,
                  )}

                {!isPureMusic &&
                  renderSlot(
                    '04',
                    '翻译与注音',
                    Languages,
                    <>
                      {renderToggleRow('歌词翻译', translationEnabled, handleTranslationToggle, {
                        description: '在播放界面显示翻译',
                        icon: Languages,
                      })}

                      {translationEnabled &&
                        renderPresetGroup(
                          '翻译位置',
                          // 标签带上注册表里的 hint：同一个弹窗里「现代」既是歌词模式名，
                          // 单叫「现代」会让两处 chip 重名、也让用户分不清指的是位置。
                          [
                            { value: 'traditional', label: '传统（行下方）' },
                            { value: 'bottom-right', label: '现代（右下角）' },
                          ],
                          translationPosition,
                          (value) => handleTranslationPositionChange(value as 'traditional' | 'bottom-right'),
                          { columns: 2 },
                        )}

                      {renderToggleRow('罗马音', romanEnabled, handleRomanToggle, {
                        description: '为日文歌词显示罗马音注音',
                      })}
                    </>,
                  )}
              </>
            ) : (
              <>
                {renderSlot(
                  '01',
                  '曲目过渡',
                  Shuffle,
                  <>
                    {renderPresetGroup(
                      '过渡方式',
                      transitionOptions,
                      transitionMode,
                      (value) => handleTransitionModeChange(value as TransitionMode),
                      { columns: 4 },
                    )}

                    {transitionMode === 'crossfade' &&
                      renderSliderRow(
                        '渐入渐出时长',
                        crossfadeDuration,
                        `${crossfadeDuration}s`,
                        1,
                        12,
                        0.5,
                        handleCrossfadeDurationChange,
                      )}
                  </>,
                )}

                {renderSlot(
                  '02',
                  '专辑衔接',
                  Disc3,
                  renderToggleRow('专辑融合', albumGaplessEnabled, handleAlbumGaplessToggle, {
                    description: '同一专辑内的歌曲以无缝方式衔接',
                    icon: Disc3,
                  }),
                )}
              </>
            )}
            </div>
          </div>
        </div>

        {/* 页脚（「设置即时生效，改动会被记住」+「完成」按钮）已按用户要求移除：
            所有改动本来就是即时落盘的，这句话是废话；关闭用右上角的 ✕ / Esc / 点遮罩就够了。 */}
      </motion.div>

      {/* Folia 参数二级弹窗：02 槽入口按钮打开。portal 到 body —— 主弹窗 backdrop
          有 onMouseDown/onClick 关闭处理，弹层就地渲染会被遮罩点击误关。 */}
      {foliaSubDialogOpen && foliaStyle && onFoliaTuningCommit && !modeParked
        ? createPortal(
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.14 }}
              role="presentation"
              className="fixed inset-0 z-[150] flex items-center justify-center p-4 sm:p-6"
              style={{
                backgroundColor: isDaylight ? 'rgba(242,243,247,0.8)' : 'rgba(8,9,13,0.78)',
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
              }}
              onClick={() => setFoliaSubDialogOpen(false)}
            >
              <motion.div
                initial={{ scale: 0.97, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.98, opacity: 0 }}
                transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                role="dialog"
                aria-label={`Folia 歌词参数 · ${FOLIA_STYLE_ZH[foliaStyle] ?? foliaStyle}`}
                className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border"
                style={{
                  borderColor: toRgba(accentHex, 0.25),
                  backgroundColor: isDaylight ? 'rgba(250,250,252,0.98)' : 'rgba(12,14,26,0.98)',
                  boxShadow: `0 24px 70px rgba(0,0,0,0.55)`,
                }}
                onClick={event => event.stopPropagation()}
              >
                <div
                  className="flex shrink-0 items-center justify-between border-b px-4 py-3"
                  style={{ borderColor: toRgba(accentHex, 0.18) }}
                >
                  <div className="min-w-0">
                    <p className={`truncate text-sm font-semibold ${playerTheme === 'dark' ? 'text-white/92' : 'text-black/85'}`}>
                      {FOLIA_STYLE_ZH[foliaStyle] ?? foliaStyle} · 歌词参数
                    </p>
                    <p className={`mt-0.5 truncate text-[10px] ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'}`}>
                      设计来源 Project Folia · 改动即时生效
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFoliaSubDialogOpen(false)}
                    aria-label="关闭 Folia 参数"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors"
                    style={{
                      borderColor: toRgba(accentHex, 0.18),
                      backgroundColor: isDaylight ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.04)',
                      color: accentHex,
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
                <div className={`min-h-0 flex-1 overflow-y-auto p-3 ${playerTheme === 'dark' ? 'qs-scroll' : 'qs-scroll-light'}`}>
                  {foliaStyleHasPanel(foliaStyle) ? (
                    <FoliaTuningPanel
                      mode={foliaStyle}
                      tuning={foliaTuning}
                      onCommit={onFoliaTuningCommit}
                      onReset={onFoliaTuningReset ?? (() => {})}
                      hasOverride={Boolean(hasFoliaTuningOverride)}
                      playerTheme={playerTheme}
                      accentColor={accentHex}
                    />
                  ) : (
                    <p className={`rounded-lg px-2.5 py-2 text-[11px] leading-relaxed ${playerTheme === 'dark' ? 'bg-white/[0.05] text-white/50' : 'bg-black/[0.04] text-black/50'}`}>
                      当前样式没有独立参数。样式与显示/隐藏请在顶部下拉的歌词样式选择里调整。
                    </p>
                  )}
                </div>
              </motion.div>
            </motion.div>,
            document.body,
          )
        : null}
    </motion.div>
  )
})
