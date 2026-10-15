import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowUp } from 'lucide-react'

interface ScrollToTopProps {
  containerRef?: React.RefObject<HTMLElement | null>
  scrollContainerRef?: React.RefObject<HTMLElement | null>
  threshold?: number
  playerTheme?: 'light' | 'dark'
  theme?: 'light' | 'dark'
  position?: 'fixed' | 'absolute' | 'sticky'
  offsetRight?: number
  offsetLeft?: number
  offsetBottom?: number
  /** position='sticky' 时生效：外层 sticky 容器类（如 'sticky bottom-6 flex justify-end pr-6'），
   *  由调用方放进滚动容器的内容流末尾，按钮钉在滚动视口底部而非随内容滚走。 */
  stickyWrapperClassName?: string
  /** 按钮可见性变化回调：供同槽位的「定位当前歌曲」按钮让位（上移）等联动 */
  onVisibilityChange?: (visible: boolean) => void
}

const ScrollToTop: React.FC<ScrollToTopProps> = ({
  containerRef,
  scrollContainerRef,
  threshold = 300,
  playerTheme,
  theme,
  position = 'fixed',
  offsetRight = 24,
  offsetLeft,
  offsetBottom = 24,
  stickyWrapperClassName = 'sticky bottom-6 z-30 flex justify-end pr-6 pointer-events-none',
  onVisibilityChange,
}) => {
  const resolvedContainerRef = containerRef ?? scrollContainerRef
  const resolvedTheme = theme ?? playerTheme ?? 'dark'
  const [showButton, setShowButton] = useState(false)
  // rAF 合并滚动判定：同一帧内多次 scroll 只执行一次，且布尔值未变时跳过 setState
  const showButtonRef = useRef(false)
  const scrollCheckFrameRef = useRef<number | null>(null)

  // 可见性变化通知（供同槽位的定位歌曲按钮让位联动）；ref 包装避免判定 effect 依赖回调引用
  const onVisibilityRef = useRef(onVisibilityChange)
  onVisibilityRef.current = onVisibilityChange
  const reportVisibility = useCallback((next: boolean) => {
    if (onVisibilityRef.current && showButtonRef.current !== next) onVisibilityRef.current(next)
  }, [])

  useEffect(() => {
    const container = resolvedContainerRef?.current
    if (!container) return

    const handleScroll = () => {
      if (scrollCheckFrameRef.current !== null) return
      scrollCheckFrameRef.current = window.requestAnimationFrame(() => {
        scrollCheckFrameRef.current = null
        const next = container.scrollHeight > container.clientHeight && container.scrollTop > threshold
        if (next === showButtonRef.current) return
        showButtonRef.current = next
        setShowButton(next)
        reportVisibility(next)
      })
    }
    handleScroll()
    reportVisibility(showButtonRef.current && container.scrollHeight > container.clientHeight && container.scrollTop > threshold)
    container.addEventListener('scroll', handleScroll)
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (scrollCheckFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollCheckFrameRef.current)
        scrollCheckFrameRef.current = null
      }
    }
  }, [resolvedContainerRef, threshold, reportVisibility])

  const scrollToTop = () => {
    resolvedContainerRef?.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const bgColor = resolvedTheme === 'dark' ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
  const textColor = resolvedTheme === 'dark' ? 'text-white/80' : 'text-black/80'
  const borderColor = resolvedTheme === 'dark' ? 'border-white/10' : 'border-black/10'

  return (
    <AnimatePresence>
      {showButton && (
        position === 'sticky' ? (
          // sticky 模式：外层容器钉在滚动视口底部，按钮本体不定位（由外层 flex 决定位置）。
          <motion.div key="stt-sticky" className={stickyWrapperClassName}>
            <motion.button
              type="button"
              initial={{ opacity: 0, scale: 0.8, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, y: 12 }}
              whileHover={{ scale: 1.05, y: -2 }}
              whileTap={{ scale: 0.95 }}
              onClick={scrollToTop}
              aria-label="返回顶部"
              className={`pointer-events-auto w-12 h-12 rounded-full ${bgColor} backdrop-blur-xl ${textColor} border ${borderColor} shadow-[0_8px_32px_rgba(0,0,0,0.12)] flex items-center justify-center transition-all duration-300`}
              style={{
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              }}
            >
              <ArrowUp className="w-5 h-5" />
            </motion.button>
          </motion.div>
        ) : (
          <motion.button
            key="stt-float"
            type="button"
            initial={{ opacity: 0, scale: 0.8, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 20 }}
            whileHover={{ scale: 1.05, y: -2 }}
            whileTap={{ scale: 0.95 }}
            onClick={scrollToTop}
            aria-label="返回顶部"
            className={`${position} z-50 w-12 h-12 rounded-full ${bgColor} backdrop-blur-xl ${textColor} border ${borderColor} shadow-[0_8px_32px_rgba(0,0,0,0.12)] flex items-center justify-center transition-all duration-300`}
            style={{
              ...(offsetLeft !== undefined ? { left: `${offsetLeft}px` } : { right: `${offsetRight}px` }),
              bottom: `${offsetBottom}px`,
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
            }}
          >
            <ArrowUp className="w-5 h-5" />
          </motion.button>
        )
      )}
    </AnimatePresence>
  )
}

export default ScrollToTop
