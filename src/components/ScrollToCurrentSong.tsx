import { useState, useEffect, useRef } from 'react'
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
  /** 同槽位让位偏移：回到顶部按钮可见时由调用方传入 64（按钮高 48 + 间距 16），本按钮 bottom 从 offsetBottom 平滑过渡到 offsetBottom + slotOffsetBottom */
  slotOffsetBottom?: number
  /** 面板打开且列表中出现当前播放歌曲时，自动滚动定位到该歌曲（智能播放/从歌单选歌后返回的场景） */
  autoScroll?: boolean
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
  slotOffsetBottom = 0,
  autoScroll = false,
}) => {
  const resolvedContainerRef = containerRef ?? scrollContainerRef
  const resolvedTheme = theme ?? playerTheme ?? 'dark'
  const resolvedSongIndex = currentSongIndex ?? (currentSongId == null ? -1 : 0)
  const [showButton, setShowButton] = useState(false)

  const currentRowTop = () => {
    const rowHeight = cardHeight + cardGapY
    const rowIndex = Math.floor(resolvedSongIndex / Math.max(1, cardsPerRow))
    return rowIndex * rowHeight + contentPaddingTop
  }

  const scrollToCurrentSong = () => {
    const container = resolvedContainerRef?.current
    if (!container || resolvedSongIndex === -1) return
    const targetScrollTop = currentRowTop() - container.clientHeight / 2 + cardHeight / 2
    container.scrollTo({ top: Math.max(0, targetScrollTop), behavior: 'smooth' })
  }

  // 按钮显示条件（rAF 合并滚动判定）：列表可滚动 + 当前歌曲整行在可视区外（留 visibilityMargin 余量）。
  // 不要求已滚动过阈值：打开面板时歌曲在屏外（如重新打开上次听了一半的歌单）也应立即出现定位入口。
  // threshold 仍保留为"行必须已滚出超过该距离才算远离"，避免刚滚出 1px 就闪现按钮。
  const showButtonRef = useRef(false)
  const scrollCheckFrameRef = useRef<number | null>(null)
  useEffect(() => {
    const container = resolvedContainerRef?.current
    if (!container || resolvedSongIndex === -1) {
      showButtonRef.current = false
      setShowButton(false)
      return
    }
    const update = () => {
      const rowTop = currentRowTop()
      const rowBottom = rowTop + cardHeight
      const viewTop = container.scrollTop
      const viewBottom = viewTop + container.clientHeight
      // 行底在可视区上缘之上（上方屏外）或行顶在可视区下缘之下（下方屏外），且超出 threshold 距离
      const rowOutOfView = rowBottom <= viewTop - threshold + visibilityMargin || rowTop >= viewBottom + threshold - visibilityMargin
      const next = container.scrollHeight > container.clientHeight && rowOutOfView
      if (next === showButtonRef.current) return
      showButtonRef.current = next
      setShowButton(next)
    }
    const handleScroll = () => {
      if (scrollCheckFrameRef.current !== null) return
      scrollCheckFrameRef.current = window.requestAnimationFrame(() => {
        scrollCheckFrameRef.current = null
        update()
      })
    }
    update()
    container.addEventListener('scroll', handleScroll)
    window.addEventListener('resize', handleScroll)
    return () => {
      container.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)
      if (scrollCheckFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollCheckFrameRef.current)
        scrollCheckFrameRef.current = null
      }
    }
  }, [resolvedContainerRef, resolvedSongIndex, threshold, cardsPerRow, cardHeight, cardGapY, contentPaddingTop, visibilityMargin])

  // 自动定位：仅当索引从 -1（无）变为有效值（面板打开/歌曲就位）时触发一次，
  // 等入场动画/布局稳定后再滚，避免 clientHeight 未就绪导致定位偏移
  const prevSongIndexRef = useRef(-1)
  useEffect(() => {
    const prev = prevSongIndexRef.current
    prevSongIndexRef.current = resolvedSongIndex
    if (!autoScroll || resolvedSongIndex === -1 || prev !== -1) return
    const timer = window.setTimeout(scrollToCurrentSong, 350)
    return () => window.clearTimeout(timer)
  }, [autoScroll, resolvedSongIndex])

  const bgColor = resolvedTheme === 'dark' ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
  const textColor = resolvedTheme === 'dark' ? 'text-white/80' : 'text-black/80'
  const borderColor = resolvedTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  // 同槽位让位：回到顶部按钮出现时，本按钮从底部槽位平滑上移到其上方（slotOffsetBottom）
  const restBottom = offsetBottom + slotOffsetBottom

  return (
    <AnimatePresence>
      {showButton && resolvedSongIndex !== -1 && (
        <motion.button
          type="button"
          initial={{ opacity: 0, scale: 0.8, y: 20 }}
          animate={{ opacity: 1, scale: 1, y: 0, bottom: restBottom }}
          exit={{ opacity: 0, scale: 0.8, y: 20 }}
          whileHover={{ scale: 1.05, y: -2 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          onClick={scrollToCurrentSong}
          aria-label="滚动到当前歌曲"
          className={`${position} z-50 w-12 h-12 rounded-full ${bgColor} backdrop-blur-xl ${textColor} border ${borderColor} shadow-[0_8px_32px_rgba(0,0,0,0.12)] flex items-center justify-center`}
          style={{
            ...(offsetLeft !== undefined ? { left: `${offsetLeft}px` } : { right: `${offsetRight}px` }),
            bottom: restBottom,
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
