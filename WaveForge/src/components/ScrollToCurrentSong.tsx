import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const TargetIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="2" />
  </svg>
)

interface ScrollToCurrentSongProps {
  containerRef?: React.RefObject<HTMLDivElement | null>
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>
  currentSongIndex?: number
  currentSongId?: string | number
  threshold?: number
  playerTheme?: 'light' | 'dark'
  theme?: 'light' | 'dark'
  position?: 'fixed' | 'absolute'
  offsetRight?: number
  offsetLeft?: number
  offsetBottom?: number
  cardsPerRow?: number
  cardHeight?: number
  cardGapY?: number
  contentPaddingTop?: number
  visibilityMargin?: number
}

const ScrollToCurrentSong: React.FC<ScrollToCurrentSongProps> = ({
  containerRef,
  scrollContainerRef,
  currentSongIndex,
  currentSongId,
  threshold = 300,
  playerTheme,
  theme,
  position = 'fixed',
  offsetRight = 24,
  offsetLeft,
  offsetBottom = 24,
  cardsPerRow = 1,
  cardHeight = 180,
  cardGapY = 20,
  contentPaddingTop = 32,
  visibilityMargin = 12,
}) => {
  const resolvedContainerRef = containerRef ?? scrollContainerRef
  const resolvedTheme = theme ?? playerTheme ?? 'dark'
  const resolvedSongIndex = currentSongIndex ?? (currentSongId == null ? -1 : 0)
  const [showButton, setShowButton] = useState(false)

  useEffect(() => {
    const container = resolvedContainerRef?.current
    if (!container || resolvedSongIndex === -1) {
      setShowButton(false)
      return
    }
    const handleScroll = () => {
      const rowHeight = cardHeight + cardGapY
      const rowIndex = Math.floor(resolvedSongIndex / Math.max(1, cardsPerRow))
      const targetTop = rowIndex * rowHeight + contentPaddingTop
      const targetBottom = targetTop + cardHeight
      const viewportTop = container.scrollTop + visibilityMargin
      const viewportBottom = container.scrollTop + container.clientHeight - visibilityMargin
      const currentSongIsVisible = targetTop >= viewportTop && targetBottom <= viewportBottom

      setShowButton(
        container.scrollHeight > container.clientHeight
        && container.scrollTop > threshold
        && !currentSongIsVisible
      )
    }
    handleScroll()
    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [
    cardGapY,
    cardHeight,
    cardsPerRow,
    contentPaddingTop,
    resolvedContainerRef,
    resolvedSongIndex,
    threshold,
    visibilityMargin,
  ])

  const scrollToCurrentSong = () => {
    const container = resolvedContainerRef?.current
    if (!container || resolvedSongIndex === -1) return
    const rowHeight = cardHeight + cardGapY
    const rowIndex = Math.floor(resolvedSongIndex / Math.max(1, cardsPerRow))
    const targetRowTop = rowIndex * rowHeight + contentPaddingTop
    const targetScrollTop = targetRowTop - container.clientHeight / 2 + cardHeight / 2
    container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
  }

  const bgColor = resolvedTheme === 'dark' ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
  const textColor = resolvedTheme === 'dark' ? 'text-white/80' : 'text-black/80'
  const borderColor = resolvedTheme === 'dark' ? 'border-white/10' : 'border-black/10'

  return (
    <AnimatePresence>
      {showButton && resolvedSongIndex !== -1 && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.8, y: 20 }}
          whileHover={{ scale: 1.05, y: -2 }}
          whileTap={{ scale: 0.95 }}
          onClick={scrollToCurrentSong}
          aria-label="滚动到当前歌曲"
          className={`${position} z-50 w-12 h-12 rounded-full ${bgColor} backdrop-blur-xl ${textColor} border ${borderColor} shadow-[0_8px_32px_rgba(0,0,0,0.12)] flex items-center justify-center transition-all duration-300`}
          style={{
            ...(offsetLeft !== undefined ? { left: `${offsetLeft}px` } : { right: `${offsetRight}px` }),
            bottom: `${offsetBottom}px`,
            backdropFilter: 'blur(20px) saturate(180%)',
            WebkitBackdropFilter: 'blur(20px) saturate(180%)',
          }}
        >
          <TargetIcon className="w-5 h-5" />
        </motion.button>
      )}
    </AnimatePresence>
  )
}

export default ScrollToCurrentSong
