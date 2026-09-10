import { motion } from 'framer-motion'
import { AudioLines, Captions, ChevronDown, Film, Home, Languages } from 'lucide-react'
import { useState, useEffect } from 'react'
import QuickSettings from './QuickSettings'
import StemMixerPopover, { type TrackStemControlModel } from './StemMixerPopover'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'

interface ImmersiveControlsProps {
  /** 播放页封面主色 */
  coverColor: string
  /** 布局变体：left = 沉浸模式专属——按钮列移到左上角，顶部带可收起的向下箭头；不传 = 传统右上角布局 */
  variant?: 'default' | 'left'
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
  /** 人声/伴奏分离控制句柄 */
  stemControl?: TrackStemControlModel
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

  // 左上角布局（沉浸模式专属）：按钮列贴左，顶部多一个可收起的向下箭头，
  // 其余按钮整体下移一行给箭头让位；收起后仅剩箭头常驻。
  const leftLayout = variant === 'left'
  const [collapsed, setCollapsed] = useState(false)
  const buttonsVisible = isVisible && !collapsed
  const sideCls = leftLayout ? 'left-0' : 'right-6'
  const hideX = leftLayout ? -60 : 60
  const featureHideX = leftLayout ? -44 : 44
  const hoverShiftX = leftLayout ? 3 : -3

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
  const stemRowCount = stemControl ? 1 : 0
  const rowRem = tvCompact ? 3.2 : 4 // 每个按钮行占位高度（rem），TV 紧凑更小
  // 左上角布局：箭头独占第一行，其余按钮整体下移一行
  const rowOffsetRem = leftLayout ? rowRem : 0
  const shiftTop = (top: string) => (leftLayout ? `calc(${top} + ${rowOffsetRem}rem)` : top)
  // 各按钮顶位置都按同一行高网格计算（不能混用 Tailwind top-16=4rem：TV 紧凑档会错位/重叠）
  // 左上角布局行序：箭头(0) → Home(4rem) → 翻译(8rem) → …整体比右上角布局多让出一行给箭头
  const homeButtonTop = leftLayout ? `${(tvCompact ? 3.2 : 4)}rem` : undefined
  const translationButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4)}rem`)
  const romanButtonTop = shiftTop(hasTranslation ? `${(tvCompact ? 6.4 : 8)}rem` : `${(tvCompact ? 3.2 : 4)}rem`)
  // MV 背景按钮：紧跟翻译/罗马音功能行的下一行
  const mvButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4) + (featureButtonCount - 1) * rowRem}rem`)
  const stemButtonTop = shiftTop(`${(tvCompact ? 3.2 : 4) + featureButtonCount * rowRem}rem`)
  const quickSettingsTop = shiftTop(`${(tvCompact ? 3.2 : 4) + (featureButtonCount + stemRowCount) * rowRem}rem`)
  const mixingStudioTop = shiftTop(`${(tvCompact ? 6.4 : 8) + (featureButtonCount + stemRowCount) * rowRem}rem`)
  const btnPad = tvCompact ? 'p-2.5' : 'p-3' // 按钮内边距
  const iconCls = tvCompact ? 'w-5 h-5' : 'w-6 h-6' // 图标尺寸
  const featureButtonTransition = {
    duration: 0.48,
    ease: [0.22, 1, 0.36, 1] as const,
  }

  // 统一按钮外观：左上角布局全部按钮（含收起箭头）用同款低透明度玻璃胶囊（AMLL 悬浮控件风格）；
  // 右上角默认布局维持原来的深色实底圆钮，互不影响。
  const unifiedGlassCls = leftLayout
    ? `rounded-full border backdrop-blur-md transition-colors duration-300 ${
        playerTheme === 'dark'
          ? 'border-white/10 bg-white/[0.06] hover:border-white/20 hover:bg-white/[0.13]'
          : 'border-black/10 bg-black/[0.05] hover:border-black/20 hover:bg-black/[0.10]'
      }`
    : `rounded-full backdrop-blur-md border transition-colors ${
        playerTheme === 'dark'
          ? 'bg-black/40 hover:bg-black/60 border-white/20'
          : 'bg-white/50 hover:bg-white/70 border-black/20'
      }`
  const unifiedGlassShadow = leftLayout
    ? playerTheme === 'dark'
      ? 'inset 0 1px 0 rgba(255,255,255,0.10), 0 2px 12px rgba(0,0,0,0.28)'
      : 'inset 0 1px 0 rgba(255,255,255,0.55), 0 2px 12px rgba(0,0,0,0.12)'
    : undefined
  // 功能开关按钮表面：启用态保留主题色高亮，未启用态（仅左布局）退成玻璃底
  const featureSurfaceStyle = (enabled: boolean) =>
    leftLayout && !enabled
      ? { boxShadow: unifiedGlassShadow }
      : {
          backgroundColor: enabled
            ? coverColor
            : playerTheme === 'dark'
              ? 'rgba(0,0,0,0.4)'
              : 'rgba(255,255,255,0.5)',
          borderColor: enabled
            ? `${coverColor}66`
            : playerTheme === 'dark'
              ? 'rgba(255,255,255,0.2)'
              : 'rgba(0,0,0,0.2)',
          boxShadow: enabled
            ? `0 0 20px ${coverColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`
            : '0 4px 12px rgba(0,0,0,0.15)',
        }
  const featureIconColor = (enabled: boolean) =>
    enabled
      ? '#fff'
      : leftLayout
        ? playerTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)'
        : playerTheme === 'dark' ? '#fff' : '#000'
  const neutralIconCls = playerTheme === 'dark'
    ? leftLayout ? 'text-white/90' : 'text-white'
    : leftLayout ? 'text-black/80' : 'text-black'

  return (
    <div
      className={`fixed top-[34px] z-40 ${leftLayout ? 'left-6' : 'right-0'}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={leftLayout
        ? { width: tvCompact ? '52px' : '60px', height: collapsed ? (tvCompact ? '56px' : '64px') : (tvCompact ? `${158 + (featureButtonCount + stemRowCount) * 38 + rowOffsetRem * 16}px` : `${214 + (featureButtonCount + stemRowCount) * 50 + rowOffsetRem * 16}px`) }
        : { width: tvCompact ? '104px' : '120px', height: tvCompact ? `${158 + (featureButtonCount + stemRowCount) * 38}px` : `${214 + (featureButtonCount + stemRowCount) * 50}px` }}
    >
      {/* 鼠标靠近感应区（隐形，仅左上角布局）：比按钮列大一圈，靠近即唤醒整组按钮 */}
      {leftLayout && (
        <div aria-hidden="true" className="absolute -left-8 -right-8 -top-8 -bottom-4" />
      )}

      {/* 收起箭头（仅沉浸模式左上角布局）：参考 AMLL/Apple 悬浮控件风格的低透明度玻璃胶囊——
          静置时若隐若现，hover 亮起并浮出小提示；展开态箭头轻微下浮引导收起。
          箭头随整组一起 3 秒渐隐、鼠标靠近重现——收起态闲置时画面完全干净 */}
      {leftLayout && (
        <motion.button
          type="button"
          onClick={() => {
            if (collapsed) setIsVisible(true)
            setCollapsed(c => !c)
          }}
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
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.88 }}
          className={`group absolute top-3 ${sideCls} flex items-center justify-center ${unifiedGlassCls}`}
          style={{
            padding: tvCompact ? 7 : 9,
            boxShadow: unifiedGlassShadow,
          }}
        >
          <motion.span
            className="block"
            initial={false}
            animate={{ rotate: collapsed ? 180 : 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
          >
            <ChevronDown
              className={`${tvCompact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} ${playerTheme === 'dark' ? 'text-white/90' : 'text-black/80'}`}
              strokeWidth={2.25}
            />
          </motion.span>
          {/* 悬停提示：延迟出现防闪烁（开源播放器 tooltip 惯例） */}
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute left-full top-1/2 ml-2.5 -translate-y-1/2 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] leading-none opacity-0 backdrop-blur-md transition-opacity duration-200 delay-500 group-hover:opacity-100 ${
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
        whileHover={{ scale: 1.1, x: hoverShiftX }}
        whileTap={{ scale: 0.9 }}
        onClick={onHomeClick}
        className={`absolute ${sideCls} ${leftLayout ? '' : 'top-0'} ${btnPad} ${unifiedGlassCls}`}
        style={{ ...(homeButtonTop ? { top: homeButtonTop } : {}), boxShadow: unifiedGlassShadow }}
      >
        <Home className={`${iconCls} ${neutralIconCls}`} />
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
          whileHover={{ scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onTranslationToggle}
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls} overflow-hidden`}
          style={{ top: translationButtonTop, ...featureSurfaceStyle(translationEnabled) }}
        >
          {/* 液态玻璃光泽层 */}
          {translationEnabled && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          <Languages
            className={`${iconCls} relative z-10`}
            style={{
              color: featureIconColor(translationEnabled)
            }}
          />
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
          whileHover={{ scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onRomanToggle}
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls} overflow-hidden`}
          style={{ top: romanButtonTop, ...featureSurfaceStyle(romanEnabled) }}
        >
          {romanEnabled && (
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
              }}
            />
          )}
          <Captions
            className={`${iconCls} relative z-10`}
            style={{
              color: featureIconColor(romanEnabled)
            }}
          />
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
        whileHover={{ scale: 1.06, x: hoverShiftX, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
        whileTap={{ scale: 0.96 }}
        onClick={onMvBackgroundToggle}
        aria-label="MV 背景"
        className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls} overflow-hidden`}
        style={{ top: mvButtonTop, ...featureSurfaceStyle(mvBackgroundEnabled) }}
      >
        {mvBackgroundEnabled && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: 'radial-gradient(circle at 30% 30%, rgba(255,255,255,0.3) 0%, transparent 60%)',
            }}
          />
        )}
        <Film
          className={`${iconCls} relative z-10`}
          style={{
            color: featureIconColor(mvBackgroundEnabled)
          }}
        />
      </motion.button>
      )}

      {/* 快速设置按钮 */}
      {stemControl && (
        <motion.div
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
            accentColor={coverColor}
            theme={playerTheme}
            variant="immersive"
            placement={leftLayout ? 'right' : 'left'}
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
        className={`absolute ${sideCls}`}
        style={{ top: quickSettingsTop }}
      >
        <QuickSettings
          forceClose={!buttonsVisible}
          playerTheme={playerTheme}
          isPureMusic={isPureMusic} // 传递纯音乐标识
          triggerClassName={leftLayout ? `${unifiedGlassCls} ${btnPad}` : undefined}
          triggerStyle={leftLayout ? { boxShadow: unifiedGlassShadow } : undefined}
          triggerIconColor={leftLayout ? (playerTheme === 'dark' ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.8)') : undefined}
        />
      </motion.div>

      {/* 调音室按钮 */}
      {onOpenMixingStudio && (
        <motion.button
          initial={{ x: 0, opacity: 1 }}
          animate={{ x: buttonsVisible ? 0 : hideX, opacity: buttonsVisible ? 1 : 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8, delay: 0.16 }}
          whileHover={{ scale: 1.1, x: hoverShiftX }}
          whileTap={{ scale: 0.9 }}
          onClick={(e) => onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())}
          className={`absolute ${sideCls} ${btnPad} ${unifiedGlassCls}`}
          style={{ top: mixingStudioTop, boxShadow: unifiedGlassShadow }}
          aria-label="打开调音室"
        >
          <AudioLines className={`${iconCls} ${neutralIconCls}`} />
        </motion.button>
      )}
    </div>
  )
}
