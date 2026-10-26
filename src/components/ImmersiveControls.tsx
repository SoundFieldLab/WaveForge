import { motion } from 'framer-motion'
import { AudioLines, Captions, ChevronDown, Film, Home, Languages } from 'lucide-react'
import { useState, useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import QuickSettings from './QuickSettings'
import StemMixerPopover, { type TrackStemControlModel } from './StemMixerPopover'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'

/**
 * 墙纸模式紧凑控件条的挂载锚点：WallpaperLyrics 渲染在拍立得相纸正下方，
 * compact 变体经 createPortal 挂入以贴合封面；锚点不存在（无封面/未就绪）时回退右上角悬浮条。
 * 事件在锚点挂载/卸载时由 WallpaperLyrics 广播，控件条据此重新定位。
 */
export const WALLPAPER_CONTROLS_ANCHOR_ID = 'wf-wallpaper-controls-anchor'
export const WALLPAPER_CONTROLS_ANCHOR_CHANGE_EVENT = 'wf-wallpaper-controls-anchor-change'

/**
 * 辉煌模式紧凑控件条的挂载锚点：GloriousLyrics 渲染在竖版封面卡片正下方。
 * 与墙纸模式共用同一套小尺寸横向按钮条（glorious 变体），只是锚点不同——
 * 两个模式各自持有自己的锚点元素，互不干扰；锚点不存在（无封面）时回退右上角小条。
 */
export const GLORIOUS_CONTROLS_ANCHOR_ID = 'wf-glorious-controls-anchor'
export const GLORIOUS_CONTROLS_ANCHOR_CHANGE_EVENT = 'wf-glorious-controls-anchor-change'

interface ImmersiveControlsProps {
  /** 播放页封面主色（App 由封面取色 useColorThief 提供，缺封面时给中性色）。
   *  播放面的高亮一律用它，不再读设置里的主题色——避免"设置主题色"与"当前封面"两套颜色在播放面上打架。 */
  coverColor: string
  /** 布局变体：left = 沉浸模式专属——按钮列贴左上角，收起箭头是**屏幕右上角**的独立浮标
   *（右缘与「即将播放」弹框同为 24px，弹框出现时刻纵向避让到其下沿以下）；
   *  slab = 现代模式专用——**与 left 同一套玻璃板形态**（整列收进一块玻璃板、行透明、
   *  选中用封面主色平涂 + 左缘指示条），但位置仍走默认布局：无收起箭头、无弹框避让、
   *  容器贴 right-0 而行贴 right-6，纵向也不含箭头那一行；
   *  compact = 墙纸模式专属——右上角一条横向小按钮条（墙纸歌词卡片满屏漂移，纵向大按钮列会大面积遮挡）；
   *  glorious = 辉煌模式专属——同款小尺寸横向按钮条，但挂到竖版封面卡片正下方（GloriousLyrics 提供锚点）；
   *  不传/default = 传统右上角纵向按钮列（folia / 多维在用，**改这几个别动这个分支**） */
  variant?: 'default' | 'left' | 'slab' | 'compact' | 'glorious'
  onHomeClick: () => void
  onOpenMixingStudio?: (anchorRect?: DOMRect) => void
  onTranslationToggle: () => void
  translationEnabled: boolean
  hasTranslation: boolean
  onRomanToggle: () => void
  romanEnabled: boolean
  hasRoman: boolean
  /** 不传则不显示 MV 背景按钮（如全屏播放器） */
  onMvBackgroundToggle?: () => void
  mvBackgroundEnabled?: boolean
  playerTheme?: 'light' | 'dark'
  isPureMusic?: boolean // 新增：是否为纯音乐
  /** 隐藏右上角 Home 按钮（摩登模式改用自身左下角页脚的 Home，避免重复） */
  hideHome?: boolean
  /** 人声/伴奏分离控制句柄（App 每首歌按平台下发，Apple 曲目不传）；
   *  传入时在功能行之后、快速设置之前追加一行"人声与乐器调节"按钮（StemMixerPopover）。 */
  stemControl?: TrackStemControlModel
}

/** 悬停提示（开源播放器 tooltip 惯例）：延迟 500ms 出现防闪烁；
 *  side=left/right 用于贴边的纵向按钮列（提示浮在按钮侧边），side=bottom/top 用于横向按钮条（提示浮在按钮下方/上方） */
function ControlTooltip({ label, side = 'left', dark }: { label: string; side?: 'left' | 'right' | 'top' | 'bottom'; dark: boolean }) {
  const sideCls = side === 'bottom'
    ? 'top-full left-1/2 -translate-x-1/2 mt-2'
    : side === 'top'
      ? 'bottom-full left-1/2 -translate-x-1/2 mb-2'
      : `top-1/2 -translate-y-1/2 ${side === 'left' ? 'right-full mr-2.5' : 'left-full ml-2.5'}`
  return (
    <span
      aria-hidden="true"
      className={`pointer-events-none absolute z-10 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] leading-none opacity-0 backdrop-blur-md transition-opacity duration-200 delay-500 group-hover:opacity-100 ${sideCls} ${
        dark ? 'border-white/10 bg-black/70 text-white/90' : 'border-black/10 bg-white/85 text-black/80'
      }`}
      style={{ boxShadow: '0 4px 14px rgba(0,0,0,0.22)' }}
    >
      {label}
    </span>
  )
}

export default function ImmersiveControls({
  coverColor,
  variant = 'default',
  onHomeClick,
  onOpenMixingStudio,
  onTranslationToggle,
  translationEnabled,
  hasTranslation,
  onRomanToggle,
  romanEnabled,
  hasRoman,
  onMvBackgroundToggle,
  mvBackgroundEnabled = false,
  playerTheme = 'dark',
  isPureMusic = false, // 默认非纯音乐
  hideHome = false,
  stemControl,
}: ImmersiveControlsProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isHovered, setIsHovered] = useState(false)
  // TV 遥控器模式：控件常驻（方向键可聚焦）。手机遥控器连上（光标模式）时恢复真实 hover。
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const effectiveHovered = (tvMode && !remoteCursorMode) || isHovered
  // TV 紧凑布局：按钮/间距更小、更适配遥控器排版（手机遥控器连上时用 PC 式布局）
  const tvCompact = tvMode && !remoteCursorMode

  // 沉浸模式布局：整组控件（顶部一行收起箭头 + 下方按钮列）在**屏幕右上角**，
  // 右缘与「即将播放」弹框同为 24px。弹框出现时整组一起下移避让（见 railAvoidY），
  // 箭头与各按钮的相对排布保持"箭头独占第一行、功能按钮依次向下"不变；
  // 收起后列内按钮整体向右隐去，仅箭头常驻。
  const immersiveRail = variant === 'left'
  // 玻璃板形态：沉浸模式（`left`）首创，`slab` 是同形态的**现代歌词模式**版。
  // ⚠️ 两套判断必须分清，混用会连带改掉别人：
  //   · `slabRail` 管**形态** —— 整列收进一块玻璃板、行透明、选中用封面主色平涂 + 左缘指示条；
  //   · `immersiveRail` 管**位置** —— 容器贴右 6、多一行收起箭头（rowOffsetRem）、弹框避让、收起态。
  // 现代模式要的是「沉浸的形态 + 默认布局的位置」：无箭头、无避让、容器 right-0 而行 right-6，
  // 所以下面凡是形态相关（配色/材质/圆角/悬浮反馈/板本体）一律用 `slabRail`，
  // 凡是位置相关一律保留 `immersiveRail`。
  const slabRail = immersiveRail || variant === 'slab'
  // 紧凑横向条布局（墙纸/辉煌模式专属）：见 variant 注释；提前返回，不参与下方纵向列的排版计算
  const compactLayout = variant === 'compact'
  const gloriousLayout = variant === 'glorious'
  const inlineStripLayout = compactLayout || gloriousLayout
  // 两种紧凑布局共用同一套按钮条渲染，只有锚点不同（辉煌挂在竖版封面卡片下方）
  const anchorId = gloriousLayout ? GLORIOUS_CONTROLS_ANCHOR_ID : WALLPAPER_CONTROLS_ANCHOR_ID
  const anchorChangeEvent = gloriousLayout ? GLORIOUS_CONTROLS_ANCHOR_CHANGE_EVENT : WALLPAPER_CONTROLS_ANCHOR_CHANGE_EVENT
  const [collapsed, setCollapsed] = useState(false)
  // 紧凑布局：封面下方锚点元素（WallpaperLyrics / GloriousLyrics 渲染；
  // 懒加载顺序不定，挂载时同步 + 锚点变化事件双保险）
  const [inlineAnchor, setInlineAnchor] = useState<HTMLElement | null>(null)
  // 右上角「即将播放 / 即将进入过渡」弹框的实测底边（0 = 当前没有弹框）。
  // 沉浸模式整组控件都在右上角 right-6，与弹框共用同一条右边距；弹框 z-50 高于控件组 z-40，
  // 不做纵向避让就会互压。这里测量弹框底边，整组据此统一下移到弹框下方（相对排布不变）。
  const [upNextBottom, setUpNextBottom] = useState(0)
  const buttonsVisible = isVisible && !collapsed
  // 两种纵向列布局都在右侧：沉浸模式容器贴 right-6 → 列内元素 right-0；默认布局容器贴 right-0 → 列内元素 right-6
  const sideCls = immersiveRail ? 'right-0' : 'right-6'
  // 收起时统一朝右隐去（容器在右侧），hover 时向左浮出
  const hideX = 60
  const featureHideX = 44
  const hoverShiftX = -3
  // ⚠️ 悬浮/按压反馈在**沉浸模式（玻璃板）里必须关掉位移与放大**：
  //   行宽 = 板宽，而 `x: -3` 会把高亮整体左移、`scale` 又让它比板宽出 6%~10%，
  //   两者叠加后高亮方块左缘**冒出板外约 4.4px**、右缘**离板右缘还差 1.6px**，
  //   看起来就是「悬浮时亮起来的像素和原来空着的那块板对不上」。
  //   （这套位移/放大是为「右上角各自独立的圆钮」调的，收进板里就不再成立。）
  //   板内改为：悬浮只换底色（`hover:bg-*`），按压只做**向内**微缩 0.94，保证高亮永远落在板内。

  // 播放面高亮色 = 封面主色（App 由 useColorThief 下发；无封面时是中性色），不读设置里的主题色：
  // 播放面上"当前封面"才是唯一有效的视觉锚点，改设置主题色不应改变正在播放这张封面下的按钮配色。
  const accentColor = coverColor

  // ── 沉浸模式（variant='left'）按钮**形态**：整体玻璃工具条 ─────────────────────────────
  // ⚠️ 这里只改「形态」，**配色与材质值一律沿用原配方**——玻璃底色 bg-white/[0.06]（浅色 bg-black/[0.05]）、
  // 描边 border-white/10、backdrop-blur-md、启用态的 accent 平涂与它的 20px 辉光，一处颜色都没动。
  // 唯一的改动是把原来「一排各自成形的玻璃圆钮」收进**一块玻璃板**：
  //   ① 底板（slab）承载整列，圆角矩形 + 原配方玻璃（原先分散在每个圆钮上的底色/描边/模糊/阴影整块化）；
  //   ② 板上每行是**透明的方形行**，去掉各自的圆底与描边，悬停时才浮出原来那层淡淡的填充；
  //   ③ 选中行用封面主色平涂（沿用原启用态配方），并在底板左缘外挂一条同色指示条。
  // 形态参考（GitHub 开源）：
  //   · 竖向活动栏「整列一个容器 + 选中项指示条」这套范式 —— VS Code 活动栏、Discord 活动栏、
  //     Radix UI / shadcn 的 Sidebar；
  //   · Magic UI（dillionverma/magicui）MagicCard 的"一块面板 + 面板内高亮"分层思路。
  // 交互、aria-label、行位网格、按钮尺寸、3 秒自动隐藏、弹框避让、收起动画全部保持不变。

  /** 封面主色 → rgba(a)。colorThief 给的是 hex，但保不齐上游哪天改成 rgb()/hsl()：
   *  旧写法直接拼 `${accentColor}66` 遇到非 hex 会**静默失效**（描边与辉光凭空消失，还不报错）。
   *  coverColor 声明上必传，但调用点/单测可能真的不传 → 这里必须容错：
   *  本函数在渲染期就会被求值，一旦抛异常会把整个控件组渲染炸掉。 */
  const accentWithAlpha = (alpha: number) => {
    const value = typeof accentColor === 'string' ? accentColor.trim() : ''
    if (!value) return `rgba(255,255,255,${alpha})`
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
    if (hex) {
      const body = hex[1].length === 3 ? hex[1].split('').map(char => char + char).join('') : hex[1]
      const n = Number.parseInt(body, 16)
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
    }
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
    if (rgb) {
      const [r, g, b] = rgb[1].split(',').map(part => part.trim())
      if (r && g && b) return `rgba(${r}, ${g}, ${b}, ${alpha})`
    }
    return `color-mix(in srgb, ${value} ${Math.round(alpha * 100)}%, transparent)`
  }

  // 紧凑布局：同步封面下方锚点（锚点随封面有无而挂载/卸载，
  // WallpaperLyrics / GloriousLyrics 各自广播事件通知重定位）
  useEffect(() => {
    if (!inlineStripLayout) return
    const sync = () => {
      setInlineAnchor(document.getElementById(anchorId))
    }
    sync()
    window.addEventListener(anchorChangeEvent, sync)
    return () => window.removeEventListener(anchorChangeEvent, sync)
  }, [inlineStripLayout, anchorId, anchorChangeEvent])

  // 沉浸模式收起箭头：持续测量右上角「即将播放」弹框的底边，供箭头避让（仅沉浸模式需要）。
  // 弹框由 App 按播放进度挂载/卸载，没有现成事件可订阅 → 观察 body 的 childList
  // （不跟踪属性/文本，避免歌词滚动触发无谓测量）+ 120ms 节流。
  useEffect(() => {
    if (!immersiveRail) return
    let timer = 0
    const measure = () => {
      const card = document.querySelector<HTMLElement>('[data-wf-upnext-card]')
      if (!card) {
        setUpNextBottom(0)
        return
      }
      // 用 computedStyle.top + offsetHeight 而不是 getBoundingClientRect()：
      // 弹框入场是带 transform 的弹簧动画，rect 会测到动画中途的中间位置（实测测出 72px，真值 122px），
      // 而 offsetHeight 不受 transform 影响，算出来的底边始终是落位后的真实底边。
      const top = Number.parseFloat(window.getComputedStyle(card).top) || 0
      setUpNextBottom(Math.round(top + card.offsetHeight))
    }
    const schedule = () => {
      if (timer) return
      timer = window.setTimeout(() => {
        timer = 0
        measure()
      }, 120)
    }
    measure()
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      if (timer) window.clearTimeout(timer)
    }
  }, [immersiveRail])

  useEffect(() => {
    // 进入播放页默认显示，3 秒无操作整组渐隐（含箭头本身）；鼠标靠近（hover）立即唤醒，离开后再计 3 秒。
    // 依赖 collapsed：触屏点箭头展开后（无 hover 事件）也重新计时。TV 模式常驻不自动隐藏。
    if (!effectiveHovered) {
      const hideTimer = setTimeout(() => {
        setIsVisible(false)
      }, 3000)

      return () => clearTimeout(hideTimer)
    }
  }, [effectiveHovered, collapsed])

  const handleMouseEnter = () => {
    setIsHovered(true)
    setIsVisible(true)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  const showMvButton = typeof onMvBackgroundToggle === 'function'
  const featureButtonCount = (hasTranslation ? 1 : 0) + (hasRoman ? 1 : 0) + (showMvButton ? 1 : 0) // MV 背景按钮常驻
  // 人声分轨行：有句柄时插在功能行之后、快速设置之前（Apple 曲目不传 → 整行不存在，后续按钮自动上移）
  const stemRow = stemControl ? 1 : 0
  const railRowCount = featureButtonCount + stemRow
  const rowRem = tvCompact ? 3.2 : 4 // 每个按钮行占位高度（rem），TV 紧凑更小
  // 沉浸模式：收起箭头仍然独占列内第一行（整组一起搬到右上角，箭头与按钮的相对排布保持不变），
  // 因此其余按钮整体下移一行给它让位。
  const rowOffsetRem = immersiveRail ? rowRem : 0
  const shiftTop = (top: string) => (immersiveRail ? `calc(${top} + ${rowOffsetRem}rem)` : top)
  // 各按钮顶位置都按同一行高网格计算（不能混用 Tailwind top-16=4rem：TV 紧凑档会错位/重叠）
  // 沉浸模式行序：箭头(第一行) → Home(4rem) → 翻译(8rem) → 罗马音(12rem) → …
  const homeButtonTop = immersiveRail ? `${(tvCompact ? 3.2 : 4)}rem` : undefined
  // 整组避让：无「即将播放」弹框时控件组顶部 = 34px（与其它模式的右上角按钮列同高）；
  // 弹框出现时整组一起下移，让箭头的视口位置落到「弹框下沿 + 12px」（箭头在列内固定 top-3）。
  const railTopPx = tvCompact ? 26 : 34
  const arrowInRailPx = 12 // 箭头在列内的 top（top-3）
  const railAvoidY = upNextBottom > 0 ? Math.max(0, upNextBottom + 12 - (railTopPx + arrowInRailPx)) : 0
  const translationButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4)}rem`)
  const romanButtonTop = shiftTop(hasTranslation ? `${(tvCompact ? 6.4 : 8)}rem` : `${(tvCompact ? 3.2 : 4)}rem`)
  // MV 背景按钮：紧跟翻译/罗马音功能行的下一行
  const mvButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4) + (featureButtonCount - 1) * rowRem}rem`)
  // 人声分轨按钮：功能行之后独占一行；快速设置/调音室整体再下移 railRowCount 行
  const stemButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4) + featureButtonCount * rowRem}rem`)
  const quickSettingsTop = shiftTop(`${(tvCompact ? 3.2 : 4) + railRowCount * rowRem}rem`)
  const mixingStudioTop = shiftTop(`${(tvCompact ? 6.4 : 8) + railRowCount * rowRem}rem`)
  const btnPad = tvCompact ? 'p-2.5' : 'p-3' // 按钮内边距
  const iconCls = tvCompact ? 'w-5 h-5' : 'w-6 h-6' // 图标尺寸
  const featureButtonTransition = {
    duration: 0.48,
    ease: [0.22, 1, 0.36, 1] as const,
  }
  // 工具条底板尺寸：行宽 = 按钮实际占位（PC 12px 内边距 + 24px 图标 = 48；TV 10px + 20px = 40），
  // 行高 = 同一网格的拍长（PC 64 / TV 51.2），下留白与箭头的 top-3 对齐（12px）。
  const slabWidthPx = tvCompact ? 40 : 48
  const slabRowPx = tvCompact ? 51.2 : 64
  // 行高网格（沉浸模式，板顶 = 容器 0）：
  //   第 0 行 = 收起箭头（`top-3` → 板的上留白天然是 12px）
  //   之后每行 slabRowPx = Home / 各功能行 / 人声分轨 / 快速设置 / 调音室
  // 最后一行：有调音室按钮时是调音室（比快速设置再往下一行 → 基址多一行），否则就是快速设置
  const slabLastRowBasePx = onOpenMixingStudio ? (tvCompact ? 102.4 : 128) : (tvCompact ? 51.2 : 64)
  // ⚠️ 必须再加**一行**（`railRowCount + 1`）：除 Home 外所有按钮的 top 都经过 `shiftTop`，整列比基址
  //   多下移一行给箭头让位。漏算这一行时板底会短一行，最后一行按钮从板子里掉出去（实测溢出 52px，
  //   而 `rowsInsideSlab` 只校验上/左/右三边，看不出来 —— 校验必须连底边一起查）。
  // 板高 = 最后一行顶 + 一行行高 + 与上留白对齐的下留白（12px）。
  // 板高 = 最后一行底 + 下留白 12px。
  // 沉浸模式板顶 = 容器 0（箭头独占第一行、它在 12px 处），所以高度从 0 算到「最后一行底 + 12」；
  // 现代模式没有箭头行（按钮从 Home 的 top-0 起），板顶必须上移 12px 才能让上下留白对称，
  // 于是再多算板顶那 12px。
  const slabTopPx = immersiveRail ? 0 : -12
  const slabHeightPx = Math.round(
    immersiveRail
      ? slabLastRowBasePx + (railRowCount + 1) * slabRowPx + slabWidthPx + 12
      : slabLastRowBasePx + railRowCount * slabRowPx + slabWidthPx + 12 + 12,
  )
  // 收起后列内只剩箭头（容器高度也收到单行），板必须同步缩到「箭头 + 上下各 12px 留白」：
  // 板若跟着 buttonsVisible 一起淡出，收起态的箭头就成了一枚没有玻璃底的裸图标（原设计箭头自带圆底）。
  const slabCollapsedHeightPx = slabWidthPx + 24

  // 统一按钮外观：沉浸模式已改成「板 + 透明行」，所以行本身不再有底色/描边/模糊（全在底板上），
  // 只保留 hover 时那层淡淡的填充（数值沿用原来的 hover 底色，未改配色）；
  // 右上角默认布局维持原来的液态玻璃圆钮（参考 AMLL Player / Apple Music 悬浮控件）不动。
  // ⚠️ 行的圆角必须与底板一致（两边都是 `rounded-[18px]`）：行宽 = 板宽，圆角不同心时
  //   悬浮高亮会在四角"切"出板的弧线，看起来就是一个方角块浮在圆角板里（实测原来是 14 vs 18）。
  const unifiedGlassCls = slabRail
    ? `rounded-[18px] transition-colors duration-300 ${
        playerTheme === 'dark' ? 'hover:bg-white/[0.13]' : 'hover:bg-black/[0.10]'
      }`
    : `group rounded-full border backdrop-blur-xl transition-colors duration-300 ${
        playerTheme === 'dark'
          ? 'border-white/15 bg-white/[0.08] hover:border-white/25 hover:bg-white/[0.16]'
          : 'border-black/10 bg-white/45 hover:border-black/20 hover:bg-white/65'
      }`
  // 沉浸模式：这份阴影现在专供**工具条底板**（原来分散在每个圆钮上）；默认布局仍是圆钮自己的阴影。
  const unifiedGlassShadow = slabRail
    ? playerTheme === 'dark'
      ? 'inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 12px rgba(0,0,0,0.28)'
      : 'inset 0 1px 0 rgba(255,255,255,0.55), 0 2px 12px rgba(0,0,0,0.12)'
    : playerTheme === 'dark'
      ? 'inset 0 1px 0 rgba(255,255,255,0.12), 0 4px 16px rgba(0,0,0,0.30)'
      : 'inset 0 1px 0 rgba(255,255,255,0.65), 0 4px 16px rgba(0,0,0,0.12)'
  // 功能开关按钮表面：启用态保留主题色高亮，未启用态退成玻璃底（两种布局统一）
  const featureSurfaceStyle = (enabled: boolean) => {
    // 沉浸模式的选中态改由「板内主色行 + 左缘指示条」承担（见 immersiveActiveLayers），
    // 行本身保持透明 → 这里不再给行任何底色/描边/阴影。
    if (slabRail) return {}
    return enabled
      ? {
          backgroundColor: accentColor,
          borderColor: `${accentColor}66`,
          boxShadow: `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`,
        }
      : { boxShadow: unifiedGlassShadow }
  }
  const featureIconColor = (enabled: boolean) =>
    enabled
      ? '#fff'
      : playerTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)'
  const neutralIconCls = playerTheme === 'dark'
    ? slabRail ? 'text-white/90' : 'text-white/95'
    : slabRail ? 'text-black/80' : 'text-black/85'

  // 沉浸模式非功能按钮（Home / 播放设置 / 调音室）不再自带玻璃底 → 内联样式为空；
  // 非沉浸模式退化成原来的内联阴影，其余分支的渲染结果逐字节不变。
  const glassBaseStyle: CSSProperties = slabRail ? {} : { boxShadow: unifiedGlassShadow }

  /** 选中行：沿用原启用态的**封面主色平涂**配方（底色 + 20px 主色辉光 + 上缘内高光），
   *  并在底板左缘外挂一条同色指示条（竖向工具条的选中指示）。
   *  纯装饰层（aria-hidden + pointer-events-none），不参与交互与可访问性；
   *  **只有玻璃板形态**（沉浸 `left` / 现代 `slab`）渲染——其它布局沿用各自原有的圆钮 /
   *  横向小条配方，颜色与形态都不动。 */
  const slabActiveLayers = (active: boolean) => (
    slabRail && active ? (
      <>
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[18px]"
          style={{
            backgroundColor: accentColor,
            boxShadow: `0 0 20px ${accentWithAlpha(0.25)}, inset 0 1px 1px rgba(255,255,255,0.3)`,
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-[-7px] top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full"
          style={{ backgroundColor: accentColor }}
        />
      </>
    ) : null
  )

  // ── 紧凑横向按钮条（variant='compact' 墙纸模式 / variant='glorious' 辉煌模式）──────
  // 一条横向小玻璃按钮条（按钮 36px 含边框，图标 18px；默认纵向列是 50px / 24px）：
  // 墙纸模式的歌词卡片满屏漂移且可点击 seek，原 120px 宽纵向大按钮列会大面积遮挡，改为单行小条贴右上角；
  // 辉煌模式则统一挂到竖版封面卡片正下方（按钮小、不遮挡右上的封面画廊与左侧大字号歌词）。
  // 外观/启用态高亮/3 秒自动隐藏/tooltip 与其他模式同语言，两种模式的按钮语义完全一致。
  if (inlineStripLayout) {
    const compactIcon = 'h-[18px] w-[18px]'
    const compactHover = { scale: 1.08 }
    const compactTap = { scale: 0.94 }
    // 锚点仍在文档中才启用"封面下方贴合"形态（isConnected 防止锚点被卸载后 portal 进脱离文档的节点）
    const anchorEl = inlineAnchor?.isConnected ? inlineAnchor : null
    const underCover = anchorEl !== null
    // 贴合封面时：tooltip 浮上方、隐退时向下滑出；右上角回退形态维持原方向
    const tipSide = underCover ? 'top' : 'bottom'
    const hideY = underCover ? 10 : -14
    const strip = (
      <motion.div
        initial={{ y: hideY, opacity: 0 }}
        animate={{ y: buttonsVisible ? 0 : hideY, opacity: buttonsVisible ? 1 : 0 }}
        transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8 }}
        className="flex items-center gap-1.5"
      >
          {!hideHome && (
            <motion.button
              type="button"
              whileHover={compactHover}
              whileTap={compactTap}
              onClick={onHomeClick}
              aria-label="回到主界面"
              className={`relative p-2 ${unifiedGlassCls}`}
              style={{ boxShadow: unifiedGlassShadow }}
            >
              <Home className={`${compactIcon} ${neutralIconCls}`} />
              <ControlTooltip label="回到主界面" side={tipSide} dark={playerTheme === 'dark'} />
            </motion.button>
          )}

          {hasTranslation && (
            <motion.button
              type="button"
              whileHover={compactHover}
              whileTap={compactTap}
              onClick={onTranslationToggle}
              aria-label="切换翻译歌词"
              className={`relative p-2 ${unifiedGlassCls}`}
              style={featureSurfaceStyle(translationEnabled)}
            >
              {translationEnabled && (
                <div
                  className="absolute inset-0 rounded-full pointer-events-none"
                  style={{ background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)' }}
                />
              )}
              <Languages
                className={`${compactIcon} relative z-10`}
                style={{ color: featureIconColor(translationEnabled) }}
              />
              <ControlTooltip label="翻译歌词" side={tipSide} dark={playerTheme === 'dark'} />
            </motion.button>
          )}

          {hasRoman && (
            <motion.button
              type="button"
              whileHover={compactHover}
              whileTap={compactTap}
              onClick={onRomanToggle}
              aria-label="切换罗马音歌词"
              className={`relative p-2 ${unifiedGlassCls}`}
              style={featureSurfaceStyle(romanEnabled)}
            >
              {romanEnabled && (
                <div
                  className="absolute inset-0 rounded-full pointer-events-none"
                  style={{ background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)' }}
                />
              )}
              <Captions
                className={`${compactIcon} relative z-10`}
                style={{ color: featureIconColor(romanEnabled) }}
              />
              <ControlTooltip label="罗马音歌词" side={tipSide} dark={playerTheme === 'dark'} />
            </motion.button>
          )}

          {showMvButton && (
            <motion.button
              type="button"
              whileHover={compactHover}
              whileTap={compactTap}
              onClick={onMvBackgroundToggle}
              aria-label="MV 背景"
              className={`relative p-2 ${unifiedGlassCls}`}
              style={featureSurfaceStyle(mvBackgroundEnabled)}
            >
              {mvBackgroundEnabled && (
                <div
                  className="absolute inset-0 rounded-full pointer-events-none"
                  style={{ background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)' }}
                />
              )}
              <Film
                className={`${compactIcon} relative z-10`}
                style={{ color: featureIconColor(mvBackgroundEnabled) }}
              />
              <ControlTooltip label="MV 背景" side={tipSide} dark={playerTheme === 'dark'} />
            </motion.button>
          )}

          <div className="group relative">
            <QuickSettings
              playerTheme={playerTheme}
              isPureMusic={isPureMusic}
              triggerClassName={`p-2 ${unifiedGlassCls}`}
              triggerStyle={{ boxShadow: unifiedGlassShadow }}
              triggerIconSize={18}
              triggerIconColor={playerTheme === 'dark' ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.85)'}
              triggerAriaLabel="播放设置"
            />
            <ControlTooltip label="播放设置" side={tipSide} dark={playerTheme === 'dark'} />
          </div>

          {onOpenMixingStudio && (
            <motion.button
              type="button"
              whileHover={compactHover}
              whileTap={compactTap}
              onClick={(e) => onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())}
              className={`relative p-2 ${unifiedGlassCls}`}
              style={{ boxShadow: unifiedGlassShadow }}
              aria-label="打开调音室"
            >
              <AudioLines className={`${compactIcon} ${neutralIconCls}`} />
              <ControlTooltip label="打开调音室" side={tipSide} dark={playerTheme === 'dark'} />
            </motion.button>
          )}
        </motion.div>
    )
    if (anchorEl) {
      // 贴合态：portal 进封面下方锚点（墙纸=相纸下方 / 辉煌=竖版封面卡片下方），条右缘与封面右缘对齐
      return createPortal(
        <div className="flex w-full justify-end" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
          {strip}
        </div>,
        anchorEl,
      )
    }
    // 回退态：锚点不存在（无封面/懒加载未就绪）→ 右上角横向小条，功能不丢
    return (
      <div
        className="fixed top-[34px] right-4 z-40"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {strip}
      </div>
    )
  }

  return (
    <div
      // 沉浸模式整组贴右边缘 24px（与「即将播放」弹框同一右边距）；默认布局容器贴右边缘 0。
      // top 走 inline style：沉浸模式要整体做弹框避让（railAvoidY），两种布局都由此统一给出。
      className={`fixed z-40 ${immersiveRail ? 'right-6' : 'right-0'}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={immersiveRail
        ? {
            width: tvCompact ? '52px' : '60px',
            height: collapsed ? (tvCompact ? '56px' : '64px') : (tvCompact ? `${158 + railRowCount * 38 + rowOffsetRem * 16}px` : `${214 + railRowCount * 50 + rowOffsetRem * 16}px`),
            top: railTopPx + railAvoidY,
            // 弹框出现/消失时整组一起平移，不改变箭头与按钮之间的相对排布
            transition: 'top 0.34s cubic-bezier(0.22, 1, 0.36, 1)',
          }
        : {
            width: tvCompact ? '104px' : '120px',
            height: tvCompact ? `${158 + railRowCount * 38}px` : `${214 + railRowCount * 50}px`,
            top: railTopPx,
          }}
    >
      {/* 鼠标靠近感应区（隐形，仅沉浸模式）：比按钮列大一圈，靠近即唤醒整组按钮 */}
      {immersiveRail && (
        <div aria-hidden="true" className="absolute -left-8 -right-8 -top-8 -bottom-4" />
      )}

      {/* 工具条底板（玻璃板形态：沉浸 `left` + 现代 `slab`）：整列行收进这一块玻璃板。
          底色/描边/模糊/阴影全部沿用原来分散在各圆钮上的那套值（bg-white/[0.06] + border-white/10 +
          backdrop-blur-md + unifiedGlassShadow），只是从"每个按钮一块"整块化成"整列一块"。
          整组隐退时与按钮同向、同速滑出（translateX(hideX) + 淡出），否则按钮走了板还在。
          收起时只**缩高**不滑出（板缩到箭头那一行），保证箭头始终踩在玻璃上。
          `pointer-events-none`：板是纯装饰，行间 16px 的空隙原本是点击穿透的，别让它把点击吃掉。
          渲染在按钮之前 → 所有按钮都画在板上面（它们都是 absolute、z-index auto，按 DOM 顺序叠）。

          定位用 `sideCls` 跟行对齐：沉浸模式容器贴 right-6 → 行在 right-0；
          现代模式容器贴 right-0 → 行在 right-6（板必须跟着行走，否则整块板会歪在屏幕边缘）。
          纵向起点 `slabTopPx`：沉浸模式是容器 0（箭头在 12px 处），现代模式是 -12px
          （没有箭头行，板顶要上提 12px 才和底部留白对称）。 */}
      {slabRail && (
        <div
          aria-hidden="true"
          data-wf-immersive-slab=""
          className={`pointer-events-none absolute ${sideCls} rounded-[18px] border backdrop-blur-md ${
            playerTheme === 'dark'
              ? 'border-white/10 bg-white/[0.06]'
              : 'border-black/10 bg-black/[0.05]'
          }`}
          style={{
            top: slabTopPx,
            width: `${slabWidthPx}px`,
            height: `${immersiveRail && collapsed ? slabCollapsedHeightPx : slabHeightPx}px`,
            boxShadow: unifiedGlassShadow,
            opacity: isVisible ? 1 : 0,
            transform: isVisible ? 'none' : `translateX(${hideX}px)`,
            transition:
              'height 0.34s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.34s cubic-bezier(0.22, 1, 0.36, 1), transform 0.34s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        />
      )}

      {/* 收起箭头（仅沉浸模式）：整组控件（箭头 + 按钮列）一起位于**屏幕右上角**，
          箭头独占板内第一行、下方依次是 Home／翻译／罗马音／MV…——与搬位置之前完全同一套相对排布。
          右边距与「即将播放」弹框同为 24px；避让由整组容器统一承担（railAvoidY → 容器 top），
          所以箭头不会被弹框压住，也不需要靠 z-index 抢层级（弹框 z-50 > 控件组 z-40，保持弹框优先）。
          形态：与列内按钮同款"透明方行"，静置时只有底板可见，hover 浮出填充；
          尺寸显式写成与按钮同宽同高（w-12 h-12 / TV w-10 h-10），否则它按自身内边距撑出的方盒
          会比其它行窄一截，在板上左右不对齐。
          整组 3 秒渐隐、鼠标靠近重现；hover 箭头本身也会续命，不会"鼠标停在上面却消失"。 */}
      {immersiveRail && (
        <motion.button
          type="button"
          onClick={() => {
            if (collapsed) setIsVisible(true)
            setCollapsed(c => !c)
          }}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          aria-label={collapsed ? '展开控制按钮' : '收起控制按钮'}
          initial={{ opacity: 1 }}
          animate={{
            opacity: isVisible ? 1 : 0,
            y: isVisible && !collapsed ? [0, 2.5, 0] : 0,
          }}
          transition={{
            opacity: { duration: 0.45, ease: 'easeOut' },
            y: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
          }}
          whileHover={immersiveRail ? undefined : { scale: 1.06, x: hoverShiftX }}
          whileTap={immersiveRail ? { scale: 0.94 } : { scale: 0.88 }}
          data-wf-immersive-arrow=""
          className={`group absolute ${sideCls} flex items-center justify-center ${unifiedGlassCls}`}
          style={{
            // 展开时它是板内第一行（top 12px → 与板的上留白对齐，同宽同高）；
            // 收起时列内只剩它一个 → **撑满整块板**（同宽、同高、同圆角）。
            // 以前无论展开/收起都固定 top-3 + 一行高，收起后板上下各留 12px 点不亮，
            // 悬浮看起来就是「亮起来的像素区域跟板对不上」。
            top: collapsed ? 0 : 12,
            width: `${slabWidthPx}px`,
            height: `${collapsed ? slabCollapsedHeightPx : slabWidthPx}px`,
          }}
        >
          <motion.span
            className="block"
            initial={false}
            animate={{ rotate: collapsed ? 180 : 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <ChevronDown
              className={`${tvCompact ? 'h-4 w-4' : 'h-5 w-5'} ${playerTheme === 'dark' ? 'text-white/90' : 'text-black/75'}`}
              strokeWidth={2.25}
            />
          </motion.span>
          {/* 悬停提示：在按钮**左侧**浮出（右边缘元素朝右会出屏），延迟出现防闪烁（开源播放器 tooltip 惯例） */}
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute right-full top-1/2 mr-2.5 -translate-y-1/2 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] leading-none opacity-0 backdrop-blur-md transition-opacity duration-200 delay-500 group-hover:opacity-100 ${
              playerTheme === 'dark'
                ? 'border-white/10 bg-black/70 text-white/90'
                : 'border-black/10 bg-white/85 text-black/80'
            }`}
            style={{ boxShadow: '0 4px 14px rgba(0,0,0,0.22)' }}
          >
            {collapsed ? '展开控制' : '收起控制'}
          </span>
        </motion.button>
      )}

      {/* Home按钮 */}
      {!hideHome && (
      <motion.button
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: buttonsVisible ? 0 : hideX,
          opacity: buttonsVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
        }}
        whileHover={slabRail ? undefined : { scale: 1.06, x: hoverShiftX }}
        whileTap={slabRail ? { scale: 0.94 } : { scale: 0.96 }}
        onClick={onHomeClick}
        aria-label="回到主界面"
        className={`absolute ${sideCls} ${immersiveRail ? '' : 'top-0'} ${btnPad} ${unifiedGlassCls}`}
        style={{ ...glassBaseStyle, ...(homeButtonTop ? { top: homeButtonTop } : {}) }}
      >
        <Home className={`${iconCls} ${neutralIconCls}`} />
        {!immersiveRail && <ControlTooltip label="回到主界面" dark={playerTheme === 'dark'} />}
      </motion.button>
      )}

      {/* 翻译按钮 - 只在有翻译时显示 */}
      {hasTranslation && (
        <motion.button
          key="translation-button"
          initial={{ x: featureHideX, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: buttonsVisible ? 0 : featureHideX,
            opacity: buttonsVisible ? 1 : 0,
            scale: buttonsVisible ? 1 : 0.96,
            filter: buttonsVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={slabRail ? undefined : { scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={slabRail ? { scale: 0.94 } : { scale: 0.96 }}
          onClick={onTranslationToggle}
          aria-label="切换翻译歌词"
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls}`}
          style={{ top: translationButtonTop, ...featureSurfaceStyle(translationEnabled) }}
        >
          {/* 液态玻璃光泽层（rounded-full 自剪裁，不依赖 overflow-hidden，给 tooltip 留空间）。
              玻璃板形态已改用方形行 + 主色平涂，圆形光泽层会露出圆边，所以只在原圆钮布局下渲染。 */}
          {translationEnabled && !slabRail && (
            <div
              className="absolute inset-0 rounded-full pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          {slabActiveLayers(translationEnabled)}
          <Languages
            className={`${iconCls} relative z-10`}
            style={{
              color: featureIconColor(translationEnabled)
            }}
          />
          {!immersiveRail && <ControlTooltip label="翻译歌词" dark={playerTheme === 'dark'} />}
        </motion.button>
      )}

      {/* 罗马音按钮 - 只在当前歌曲有罗马音时显示 */}
      {hasRoman && (
        <motion.button
          key="roman-button"
          initial={{ x: featureHideX, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: buttonsVisible ? 0 : featureHideX,
            opacity: buttonsVisible ? 1 : 0,
            scale: buttonsVisible ? 1 : 0.96,
            filter: buttonsVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={slabRail ? undefined : { scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={slabRail ? { scale: 0.94 } : { scale: 0.96 }}
          onClick={onRomanToggle}
          aria-label="切换罗马音歌词"
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls}`}
          style={{ top: romanButtonTop, ...featureSurfaceStyle(romanEnabled) }}
        >
          {romanEnabled && !slabRail && (
            <div
              className="absolute inset-0 rounded-full pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          {slabActiveLayers(romanEnabled)}
          <Captions
            className={`${iconCls} relative z-10`}
            style={{
              color: featureIconColor(romanEnabled)
            }}
          />
          {!immersiveRail && <ControlTooltip label="罗马音歌词" dark={playerTheme === 'dark'} />}
        </motion.button>
      )}

      {/* MV 背景按钮 - 常驻（罗马音下方），仅在提供回调时显示 */}
      {showMvButton && (
      <motion.button
        key="mv-background-button"
        initial={{ x: featureHideX, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
        animate={{
          x: buttonsVisible ? 0 : featureHideX,
          opacity: buttonsVisible ? 1 : 0,
          scale: buttonsVisible ? 1 : 0.96,
          filter: buttonsVisible ? 'blur(0px)' : 'blur(6px)',
        }}
        transition={featureButtonTransition}
        // ⚠️ 这一对原本漏了板内判断（沉浸模式改玻璃板时只改了翻译/罗马音），
        //    结果 MV 按钮在板里悬浮时会左移 3px 且放大 6% → 高亮冒出板外。
        //    现在和其余行统一：板内禁位移/放大，按压只向内缩。
        whileHover={slabRail ? undefined : { scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
        whileTap={slabRail ? { scale: 0.94 } : { scale: 0.96 }}
        onClick={onMvBackgroundToggle}
        aria-label="MV 背景"
        className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls}`}
        style={{ top: mvButtonTop, ...featureSurfaceStyle(mvBackgroundEnabled) }}
      >
        {mvBackgroundEnabled && !slabRail && (
          <div
            className="absolute inset-0 rounded-full pointer-events-none"
            style={{
              background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
            }}
          />
        )}
        {slabActiveLayers(mvBackgroundEnabled)}
        <Film
          className={`${iconCls} relative z-10`}
          style={{
            color: featureIconColor(mvBackgroundEnabled)
          }}
        />
        {!immersiveRail && <ControlTooltip label="MV 背景" dark={playerTheme === 'dark'} />}
      </motion.button>
      )}

      {/* 人声与乐器调节（分轨混音）：App 仅在非 Apple 曲目下发句柄，未下发则整行不存在。
          与功能开关同款入场动画/隐退位移，行位由 stemButtonTop 统一网格给出。 */}
      {stemControl && (
        <motion.div
          key="stem-mixer-button"
          initial={{ x: featureHideX, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: buttonsVisible ? 0 : featureHideX,
            opacity: buttonsVisible ? 1 : 0,
            scale: buttonsVisible ? 1 : 0.96,
            filter: buttonsVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          className={`absolute ${sideCls}`}
          style={{ top: stemButtonTop }}
        >
          <StemMixerPopover
            control={stemControl}
            accentColor={accentColor}
            theme={playerTheme}
            variant="immersive"
            /* 左上角布局（沉浸模式）按钮列贴左 → 面板向右展开；右上角布局向左展开 */
            placement={immersiveRail ? 'right' : 'left'}
            size={tvCompact ? 'compact' : 'default'}
          />
        </motion.div>
      )}

      {/* 快速设置按钮 */}
      <motion.div
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: buttonsVisible ? 0 : hideX,
          opacity: buttonsVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
          delay: 0.1,
        }}
        className={`group absolute ${sideCls}`}
        style={{ top: quickSettingsTop }}
      >
        <QuickSettings
          playerTheme={playerTheme}
          isPureMusic={isPureMusic} // 传递纯音乐标识
          triggerClassName={`${unifiedGlassCls} ${btnPad}`}
          triggerStyle={glassBaseStyle}
          triggerIconColor={
            playerTheme === 'dark'
              ? slabRail ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.95)'
              : slabRail ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.85)'
          }
          triggerAriaLabel="播放设置"
        />
        {!immersiveRail && <ControlTooltip label="播放设置" dark={playerTheme === 'dark'} />}
      </motion.div>

      {/* 调音室按钮 */}
      {onOpenMixingStudio && (
        <motion.button
          initial={{ x: 0, opacity: 1 }}
          animate={{ x: buttonsVisible ? 0 : hideX, opacity: buttonsVisible ? 1 : 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8, delay: 0.16 }}
          // ⚠️ 同上：这对原本在板内还写着 scale 1.1 + 左移 3px，是"独立圆钮"时代的配方，
          //    收进板后会让高亮比板宽出 10%，看起来就是「悬浮亮起的区域跟板对不上」。
          whileHover={slabRail ? undefined : { scale: 1.06, x: hoverShiftX }}
          whileTap={slabRail ? { scale: 0.94 } : { scale: 0.96 }}
          onClick={(e) => onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())}
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls}`}
          style={{ ...glassBaseStyle, top: mixingStudioTop }}
          aria-label="打开调音室"
        >
          <AudioLines className={`${iconCls} ${neutralIconCls}`} />
          {!immersiveRail && <ControlTooltip label="打开调音室" dark={playerTheme === 'dark'} />}
        </motion.button>
      )}
    </div>
  )
}
