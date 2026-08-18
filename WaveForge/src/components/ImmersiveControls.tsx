import { motion } from 'framer-motion'
import { AudioLines, Captions, Home, Languages } from 'lucide-react'
import { useState, useEffect } from 'react'
import QuickSettings from './QuickSettings'
import { useTvMode, useRemoteCursorMode } from '../tv/tvCore'

interface ImmersiveControlsProps {
  onHomeClick: () => void
  onOpenMixingStudio?: (anchorRect?: DOMRect) => void
  onTranslationToggle: () => void
  translationEnabled: boolean
  hasTranslation: boolean
  onRomanToggle: () => void
  romanEnabled: boolean
  hasRoman: boolean
  playerTheme?: 'light' | 'dark'
  isPureMusic?: boolean // 新增：是否为纯音乐
}

export default function ImmersiveControls({
  onHomeClick,
  onOpenMixingStudio,
  onTranslationToggle,
  translationEnabled,
  hasTranslation,
  onRomanToggle,
  romanEnabled,
  hasRoman,
  playerTheme = 'dark',
  isPureMusic = false, // 默认非纯音乐
}: ImmersiveControlsProps) {
  const [isVisible, setIsVisible] = useState(true)
  const [isHovered, setIsHovered] = useState(false)
  // TV 遥控器模式：控件常驻（方向键可聚焦）。手机遥控器连上（光标模式）时恢复真实 hover。
  const tvMode = useTvMode()
  const remoteCursorMode = useRemoteCursorMode()
  const effectiveHovered = (tvMode && !remoteCursorMode) || isHovered
  // TV 紧凑布局：按钮/间距更小、更适配遥控器排版（手机遥控器连上时用 PC 式布局）
  const tvCompact = tvMode && !remoteCursorMode

  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  // 监听主题色变化
  useEffect(() => {
    const handleAccentColorChange = (e: CustomEvent) => {
      setAccentColor(e.detail)
    }
    
    window.addEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    
    return () => {
      window.removeEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    }
  }, [])

  useEffect(() => {
    // 当鼠标离开后3秒自动隐藏（TV 模式常驻，不自动隐藏）
    if (!effectiveHovered) {
      const hideTimer = setTimeout(() => {
        setIsVisible(false)
      }, 3000)

      return () => clearTimeout(hideTimer)
    }
  }, [effectiveHovered])

  const handleMouseEnter = () => {
    setIsHovered(true)
    setIsVisible(true)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  const featureButtonCount = (hasTranslation ? 1 : 0) + (hasRoman ? 1 : 0)
  const rowRem = tvCompact ? 3.2 : 4 // 每个按钮行占位高度（rem），TV 紧凑更小
  const romanButtonTop = hasTranslation ? `${(tvCompact ? 6.4 : 8)}rem` : `${(tvCompact ? 3.2 : 4)}rem`
  const quickSettingsTop = `${(tvCompact ? 3.2 : 4) + featureButtonCount * rowRem}rem`
  const mixingStudioTop = `${(tvCompact ? 6.4 : 8) + featureButtonCount * rowRem}rem`
  const btnPad = tvCompact ? 'p-2.5' : 'p-3' // 按钮内边距
  const iconCls = tvCompact ? 'w-5 h-5' : 'w-6 h-6' // 图标尺寸
  const featureButtonTransition = {
    duration: 0.48,
    ease: [0.22, 1, 0.36, 1] as const,
  }

  return (
    <div
      className="fixed top-[34px] right-0 z-40"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ width: tvCompact ? '104px' : '120px', height: tvCompact ? `${158 + featureButtonCount * 38}px` : `${214 + featureButtonCount * 50}px` }}
    >
      {/* Home按钮 */}
      <motion.button
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: isVisible ? 0 : 60,
          opacity: isVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
        }}
        whileHover={{ scale: 1.1, x: -2 }}
        whileTap={{ scale: 0.9 }}
        onClick={onHomeClick}
        className={`absolute top-0 right-6 ${btnPad} rounded-full backdrop-blur-md border transition-colors ${
          playerTheme === 'dark'
            ? 'bg-black/40 hover:bg-black/60 border-white/20'
            : 'bg-white/50 hover:bg-white/70 border-black/20'
        }`}
      >
        <Home className={`${iconCls} ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
      </motion.button>

      {/* 翻译按钮 - 只在有翻译时显示 */}
      {hasTranslation && (
        <motion.button
          key="translation-button"
          initial={{ x: 44, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: isVisible ? 0 : 44,
            opacity: isVisible ? 1 : 0,
            scale: isVisible ? 1 : 0.96,
            filter: isVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={{ scale: 1.06, x: -3, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onTranslationToggle}
          className={`absolute top-16 right-6 ${btnPad} rounded-full backdrop-blur-md border transition-colors overflow-hidden`}
          style={{
            backgroundColor: translationEnabled
              ? accentColor
              : playerTheme === 'dark' 
                ? 'rgba(0,0,0,0.4)' 
                : 'rgba(255,255,255,0.5)',
            borderColor: translationEnabled
              ? `${accentColor}66`
              : playerTheme === 'dark'
                ? 'rgba(255,255,255,0.2)'
                : 'rgba(0,0,0,0.2)',
            boxShadow: translationEnabled
              ? `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`
              : '0 4px 12px rgba(0,0,0,0.15)',
          }}
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
              color: translationEnabled ? '#fff' : playerTheme === 'dark' ? '#fff' : '#000'
            }}
          />
        </motion.button>
      )}

      {/* 罗马音按钮 - 只在当前歌曲有罗马音时显示 */}
      {hasRoman && (
        <motion.button
          key="roman-button"
          initial={{ x: 44, opacity: 0, scale: 0.96, filter: 'blur(6px)' }}
          animate={{
            x: isVisible ? 0 : 44,
            opacity: isVisible ? 1 : 0,
            scale: isVisible ? 1 : 0.96,
            filter: isVisible ? 'blur(0px)' : 'blur(6px)',
          }}
          transition={featureButtonTransition}
          whileHover={{ scale: 1.06, x: -3, transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
          whileTap={{ scale: 0.96 }}
          onClick={onRomanToggle}
          className={`absolute right-6 ${btnPad} rounded-full backdrop-blur-md border transition-colors overflow-hidden`}
          style={{
            top: romanButtonTop,
            backgroundColor: romanEnabled
              ? accentColor
              : playerTheme === 'dark'
                ? 'rgba(0,0,0,0.4)'
                : 'rgba(255,255,255,0.5)',
            borderColor: romanEnabled
              ? `${accentColor}66`
              : playerTheme === 'dark'
                ? 'rgba(255,255,255,0.2)'
                : 'rgba(0,0,0,0.2)',
            boxShadow: romanEnabled
              ? `0 0 20px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.3)`
              : '0 4px 12px rgba(0,0,0,0.15)',
          }}
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
              color: romanEnabled ? '#fff' : playerTheme === 'dark' ? '#fff' : '#000'
            }}
          />
        </motion.button>
      )}

      {/* 快速设置按钮 */}
      <motion.div
        initial={{ x: 0, opacity: 1 }}
        animate={{
          x: isVisible ? 0 : 60,
          opacity: isVisible ? 1 : 0,
        }}
        transition={{
          type: 'spring',
          damping: 25,
          stiffness: 300,
          mass: 0.8,
          delay: 0.1,
        }}
        className="absolute right-6"
        style={{ top: quickSettingsTop }}
      >
        <QuickSettings 
          forceClose={!isVisible}
          playerTheme={playerTheme}
          isPureMusic={isPureMusic} // 传递纯音乐标识
        />
      </motion.div>

      {/* 调音室按钮 */}
      {onOpenMixingStudio && (
        <motion.button
          initial={{ x: 0, opacity: 1 }}
          animate={{ x: isVisible ? 0 : 60, opacity: isVisible ? 1 : 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300, mass: 0.8, delay: 0.16 }}
          whileHover={{ scale: 1.1, x: -2 }}
          whileTap={{ scale: 0.9 }}
          onClick={(e) => onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())}
          className={`absolute right-6 ${btnPad} rounded-full backdrop-blur-md border transition-colors ${
            playerTheme === 'dark'
              ? 'bg-black/40 hover:bg-black/60 border-white/20'
              : 'bg-white/50 hover:bg-white/70 border-black/20'
          }`}
          style={{ top: mixingStudioTop }}
          aria-label="打开调音室"
        >
          <AudioLines className={`${iconCls} ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
        </motion.button>
      )}
    </div>
  )
}
