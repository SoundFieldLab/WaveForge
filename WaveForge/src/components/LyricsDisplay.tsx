import { motion, AnimatePresence } from 'framer-motion'
import { useEffect, useState, useRef } from 'react'

interface LyricWord {
  word: string
  startTime: number
  duration: number
}

interface LyricLine {
  time: number
  text: string
  words?: LyricWord[]
  translation?: string
}

interface LyricsDisplayProps {
  currentTime: number
  isPlaying: boolean
  accentColor: string
  lyrics?: LyricLine[]
  translationEnabled?: boolean
  translationPosition?: 'traditional' | 'bottom-right'
  onCurrentTranslationChange?: (translation: string) => void
  onSeek?: (time: number) => void
}

export default function LyricsDisplay({ 
  currentTime, 
  isPlaying, 
  accentColor, 
  lyrics,
  translationEnabled = false,
  translationPosition = 'traditional',
  onCurrentTranslationChange,
  onSeek
}: LyricsDisplayProps) {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [, setManualScrollOffset] = useState(0) // 
  const [isManualScrolling, setIsManualScrolling] = useState(false)
  const [isJumping, setIsJumping] = useState(false)
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [hoverTimer, setHoverTimer] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [blinkingIndex, setBlinkingIndex] = useState<number | null>(null) // 
  const [showGlassFrame, setShowGlassFrame] = useState(false)
  const [returnTimer, setReturnTimer] = useState<ReturnType<typeof setTimeout> | null>(null) // 
  const [wordByWordEnabled, setWordByWordEnabled] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [lyricSize, setLyricSize] = useState(() => {
    const saved = localStorage.getItem('lyricSize')
    return saved ? parseFloat(saved) : 2.8
  })
  const [lyricGlow, setLyricGlow] = useState(() => {
    const saved = localStorage.getItem('lyricGlow')
    return saved !== null ? JSON.parse(saved) : true
  })
  const [lyricOffset, setLyricOffset] = useState(() => {
    const saved = localStorage.getItem('lyricOffset')
    return saved ? parseFloat(saved) : 0
  })
  const [animationMode, setAnimationMode] = useState<'elegant' | 'normal' | 'dynamic'>(() => {
    const saved = localStorage.getItem('animationMode')
    return (saved as 'elegant' | 'normal' | 'dynamic') || 'elegant'
  })
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const displayLyricsData = lyrics || []
  
  // 澶勭悊榧犳爣婊氳疆婊氬姩
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    
    // 璺宠浆鏈熼棿绂佺敤婊氬姩
    if (isJumping) return
    
    setIsManualScrolling(true)
    setManualScrollOffset(prev => {
      const delta = e.deltaY / 300 // 姣?00px婊氬姩1琛?
      const newOffset = prev + delta
      
      // 闄愬埗婊氬姩鑼冨洿锛氫笉鑳芥粴鍔ㄥ埌绗竴鍙ヤ箣鍓嶏紝涔熶笉鑳芥粴鍔ㄥ埌鏈€鍚庝竴鍙ヤ箣鍚?
      // 褰撳墠鎾斁绱㈠紩 + 鎵嬪姩鍋忕Щ = 瀹為檯鏄剧ず鐨勪腑蹇冧綅缃?
      const targetIndex = currentIndex + newOffset
      
      if (targetIndex < 0) {
        // 涓嶈兘婊氬姩鍒扮涓€鍙ヤ箣鍓?
        return -currentIndex
      } else if (targetIndex >= displayLyricsData.length - 1) {
        // 涓嶈兘婊氬姩鍒版渶鍚庝竴鍙ヤ箣鍚?
        return displayLyricsData.length - 1 - currentIndex
      }
      
      return newOffset
    })
    
    // 娓呴櫎涔嬪墠鐨勬粴鍔ㄨ鏃跺櫒
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    // 娓呴櫎鑷姩杩斿洖璁℃椂鍣?
    if (returnTimer) {
      clearTimeout(returnTimer)
      setReturnTimer(null)
    }
  }
  
  // 澶勭悊瀹瑰櫒榧犳爣绉诲嚭
  const handleContainerMouseLeave = () => {
    // 瀹瑰櫒榧犳爣绉诲嚭鏃讹紝鍚姩3绉掕繑鍥炶鏃跺櫒
    if (isManualScrolling) {
      if (returnTimer) {
        clearTimeout(returnTimer)
      }
      const timer = setTimeout(() => {
        setIsManualScrolling(false)
        setManualScrollOffset(0)
      }, 3000)
      setReturnTimer(timer)
    }
  }
  
  // 澶勭悊姝岃瘝鎮仠
  const handleLyricMouseEnter = (index: number) => {
    setHoveredIndex(index)
    setShowGlassFrame(false)
    setBlinkingIndex(null)
    
    // 娓呴櫎婊氬姩杩斿洖璁℃椂鍣?
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current)
      scrollTimeoutRef.current = null
    }
    
    // 娓呴櫎鑷姩杩斿洖璁℃椂鍣?
    if (returnTimer) {
      clearTimeout(returnTimer)
      setReturnTimer(null)
    }
    
    // 娓呴櫎涔嬪墠鐨勬偓鍋滆鏃跺櫒
    if (hoverTimer) {
      clearTimeout(hoverTimer)
    }
    
    // 鍙湪婊氬姩妯″紡涓嬪惎鐢?绉掑悗闂儊鍔熻兘
    if (isManualScrolling) {
      const timer = setTimeout(() => {
        setBlinkingIndex(index)
      }, 2000)
      
      setHoverTimer(timer)
    }
  }
  
  // 澶勭悊姝岃瘝绉诲嚭
  const handleLyricMouseLeave = () => {
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      setHoverTimer(null)
    }
    setShowGlassFrame(false)
    setBlinkingIndex(null)
    
    setTimeout(() => {
      setHoveredIndex(null)
    }, 300)
    
    // 榧犳爣绉诲嚭鍚庯紝3绉掑悗鑷姩鍥炲埌褰撳墠鎾斁浣嶇疆
    if (isManualScrolling) {
      if (returnTimer) {
        clearTimeout(returnTimer)
      }
      const timer = setTimeout(() => {
        setIsManualScrolling(false)
        setManualScrollOffset(0)
      }, 3000)
      setReturnTimer(timer)
    }
  }
  
  // 澶勭悊鐐瑰嚮璺宠浆
  const handleLyricClick = (time: number) => {
    if (onSeek && time >= 0) {
      onSeek(time)
      
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current)
        scrollTimeoutRef.current = null
      }
      if (hoverTimer) {
        clearTimeout(hoverTimer)
        setHoverTimer(null)
      }
      if (returnTimer) {
        clearTimeout(returnTimer)
        setReturnTimer(null)
      }
      
      setShowGlassFrame(false)
      setHoveredIndex(null)
      setBlinkingIndex(null)
      
      // 璁剧疆璺宠浆鏍囧織锛屽惎鐢ㄨ烦杞姩鐢?
      setIsJumping(true)
      
      // 濡傛灉鍦ㄦ粴鍔ㄦā寮忎笅锛屽厛娓呴櫎婊氬姩鐘舵€佸啀璺宠浆
      if (isManualScrolling) {
        setIsManualScrolling(false)
        setManualScrollOffset(0)
        
        // 绛夊緟鍔ㄧ敾瀹屾垚鍚庡啀娓呴櫎璺宠浆鏍囧織
        setTimeout(() => {
          setIsJumping(false)
        }, 600)
      } else {
        // 鎾斁妯″紡涓嬬洿鎺ヨ烦杞?
        // 600ms鍚庢竻闄よ烦杞爣蹇?
        setTimeout(() => {
          setIsJumping(false)
        }, 600)
      }
    }
  }
  
  // 监听localStorage变化
  useEffect(() => {
    const handleStorageChange = () => {
      const saved = localStorage.getItem('wordByWordLyrics')
      setWordByWordEnabled(saved !== null ? JSON.parse(saved) : true)
    }
    
    const handleLyricSizeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setLyricSize(customEvent.detail)
    }
    
    const handleLyricGlowChange = () => {
      const saved = localStorage.getItem('lyricGlow')
      setLyricGlow(saved !== null ? JSON.parse(saved) : true)
    }
    
    const handleLyricOffsetChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setLyricOffset(customEvent.detail)
    }
    
    const handleAnimationModeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setAnimationMode(customEvent.detail)
    }
    
    window.addEventListener('storage', handleStorageChange)
    window.addEventListener('wordByWordLyricsChanged', handleStorageChange)
    window.addEventListener('lyricSizeChanged', handleLyricSizeChange as EventListener)
    window.addEventListener('lyricGlowChanged', handleLyricGlowChange)
    window.addEventListener('lyricOffsetChanged', handleLyricOffsetChange as EventListener)
    window.addEventListener('animationModeChanged', handleAnimationModeChange as EventListener)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('wordByWordLyricsChanged', handleStorageChange)
      window.removeEventListener('lyricSizeChanged', handleLyricSizeChange as EventListener)
      window.removeEventListener('lyricGlowChanged', handleLyricGlowChange)
      window.removeEventListener('lyricOffsetChanged', handleLyricOffsetChange as EventListener)
      window.removeEventListener('animationModeChanged', handleAnimationModeChange as EventListener)
    }
  }, [translationEnabled, translationPosition])
  
  // 褰撴瓕璇嶆暟鎹彉鍖栨椂锛岄噸缃储寮?
  useEffect(() => {
    setCurrentIndex(0)
  }, [lyrics])

  useEffect(() => {
    if (displayLyricsData.length === 0) return
    const adjustedTime = currentTime + 0.5 + lyricOffset
    
    for (let i = displayLyricsData.length - 1; i >= 0; i--) {
      if (adjustedTime >= displayLyricsData[i].time) {
        if (currentIndex !== i) {
          setCurrentIndex(i)
          if (onCurrentTranslationChange) {
            onCurrentTranslationChange(displayLyricsData[i].translation ?? '')
          }
        }
        break
      }
    }
  }, [currentTime, displayLyricsData, currentIndex, onCurrentTranslationChange, lyricOffset])

  // 自动滚动到当前歌词
  useEffect(() => {
    if (isManualScrolling) return
    const el = containerRef.current?.querySelector(`[data-index="${currentIndex}"]`)
    if (el && containerRef.current) {
      const container = containerRef.current
      const elTop = (el as HTMLElement).offsetTop
      const targetScroll = elTop - container.clientHeight / 2 + (el as HTMLElement).offsetHeight / 2
      container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' })
    }
  }, [currentIndex, isManualScrolling])

  if (!lyrics || lyrics.length === 0) {
    return null
  }

  // 濮嬬粓鏄剧ず鎵€鏈夋瓕璇嶏紝涓嶈鍓?
  const displayLyrics = displayLyricsData

  // 浼樺寲鐨勯€愬瓧娓叉煋
  const renderLyricLine = (lyric: LyricLine, isCurrent: boolean) => {
    if (wordByWordEnabled && isCurrent && lyric.words && lyric.words.length > 0) {
      const currentMs = currentTime * 1000
      
      return (
        <span className="inline-flex flex-wrap gap-1">
          {lyric.words.filter(w => w.word && w.word.trim() !== '').map((word, wordIndex) => {
            const wordAbsStartTime = word.startTime
            const wordAbsEndTime = wordAbsStartTime + word.duration
            
            const isCompleted = currentMs >= wordAbsEndTime
            const isActive = currentMs >= wordAbsStartTime && currentMs < wordAbsEndTime
            
            return (
              <motion.span
                key={`${lyric.time}-${wordIndex}-${word.word}`}
                className="inline-block relative"
                initial={false}
                animate={{
  color: isActive || isCompleted ? '#ffffff' : 'rgba(255, 255, 255, 0.3)',
  textShadow: isActive && lyricGlow
    ? [`0 0 20px ${accentColor}`, `0 0 40px ${accentColor}80`, `0 0 60px ${accentColor}40`]
    : isCompleted && lyricGlow
    ? `0 0 15px ${accentColor}60`
    : 'none',
  filter: isActive && lyricGlow ? 'brightness(1.3)' : 'none',
}}
                transition={{
                  scale: {
                    duration: 0.2,
                    ease: [0.34, 1.56, 0.64, 1], // Apple Music 寮规€х紦鍔?
                  },
                  color: {
                    duration: 0.15,
                    ease: 'easeOut',
                  },
                  fontWeight: {
                    duration: 0.1,
                  }
                }}
                style={{
                  textShadow: isActive && lyricGlow
                    ? `0 0 40px ${accentColor}ff, 0 0 80px ${accentColor}cc, 0 0 120px ${accentColor}66, 0 6px 30px rgba(0,0,0,0.9)` 
                    : isCompleted && lyricGlow
                    ? `0 0 20px ${accentColor}66, 0 3px 10px rgba(0,0,0,0.6)`
                    : '0 2px 4px rgba(0,0,0,0.3)',
                  transformOrigin: 'center center',
                  filter: isActive && lyricGlow ? `brightness(1.3) saturate(1.4)` : 'none',
                  WebkitTextStroke: isActive && lyricGlow ? '0.3px rgba(255, 255, 255, 0.15)' : 'none',
                }}
              >
                {word.word}
              </motion.span>
            )
          })}
        </span>
      )
    }
    
    return lyric.text
  }

  // 鏍规嵁鍔ㄧ敾妯″紡鑾峰彇杩囨浮閰嶇疆
  const getTransitionConfig = () => {
    switch (animationMode) {
      case 'elegant':
        // 浼橀泤锛氭鍦ㄦ挱鏀锯啋宸叉挱鏄笎闅愶紝鏈挱鈫掓鍦ㄦ挱鏄€愭笎鏄剧幇
        return {
          layout: { duration: 0.6, ease: [0.34, 1.56, 0.64, 1] },
          opacity: { duration: 0.6, ease: [0.4, 0, 0.2, 1] },
          y: { duration: 0.6, ease: [0.4, 0, 0.2, 1] },
          scale: { duration: 0.5, ease: [0.34, 1.56, 0.64, 1] },
          fontSize: { duration: 0.6, ease: [0.34, 1.56, 0.64, 1] },
          fontWeight: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
        }
      case 'normal':
        // 鏅€氾細甯歌鐨勬晥鏋?
        return {
          layout: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
          opacity: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
          y: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
          scale: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
          fontSize: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
          fontWeight: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
        }
      case 'dynamic':
        // 鐏靛姩锛氭洿鏈夋椿鍔涚殑杩囨浮鏁堟灉
        return {
          layout: { duration: 0.35, ease: [0.68, -0.55, 0.265, 1.55] },
          opacity: { duration: 0.3, ease: [0.22, 1, 0.36, 1] },
          y: { duration: 0.35, ease: [0.68, -0.55, 0.265, 1.55] },
          scale: { duration: 0.3, ease: [0.68, -0.55, 0.265, 1.55] },
          fontSize: { duration: 0.35, ease: [0.68, -0.55, 0.265, 1.55] },
          fontWeight: { duration: 0.2, ease: [0.22, 1, 0.36, 1] },
        }
    }
  }

  // 使用鍔ㄧ敾閰嶇疆鍑芥暟，以澶嶉€変腑閰嶇疆鍙婂垽鏂?避免"已声明但未读取"警告
  const transitionConfig = getTransitionConfig()
  void transitionConfig

  return (
    <div 
      ref={containerRef}
      data-is-playing={isPlaying}
      className="w-full h-[500px] relative overflow-y-auto overflow-x-hidden pl-8 scrollbar-hide"
      onWheel={handleWheel}
      onMouseLeave={handleContainerMouseLeave}
    >
      {/* 姝岃瘝婊氬姩瀹瑰櫒 */}
      <div 
        className="absolute inset-0 flex flex-col items-start justify-start"
        style={{
          paddingTop: '120px',
          paddingBottom: '400px',
        }}
      >
        {displayLyrics.map((lyric, index) => {
          const globalIndex = index
          const isCurrent = globalIndex === currentIndex
          const isHovered = hoveredIndex === globalIndex
          
          // 璁＄畻涓庡綋鍓嶆挱鏀捐鐨勮窛绂?
          const distanceFromCurrent = Math.abs(globalIndex - currentIndex)
          
          const isBlinking = blinkingIndex === globalIndex
          
          // 閫忔槑搴﹁绠楋細褰撳墠鎾斁琛屽缁堥珮浜紝鏃犺鏄惁鍦ㄦ粴鍔ㄦā寮?
          let opacityValue = 0.3
          
          if (isCurrent) {
            // 褰撳墠鎾斁琛屽缁堜繚鎸侀珮浜?
            opacityValue = 1.0
          } else if (distanceFromCurrent === 1) {
            // 绱ч偦鐨勪笂涓嬪彞
            opacityValue = 0.7
          } else if (distanceFromCurrent === 2) {
            // 鍐嶅涓€灞?
            opacityValue = 0.5
          }
          
          // 濡傛灉鍦ㄦ粴鍔ㄦā寮忎笅锛屽叾浠栬鐨勯€忔槑搴︾粺涓€璁剧疆涓?.5
          if (isManualScrolling && !isCurrent) {
            opacityValue = Math.max(opacityValue, 0.5)
          }
          
          return (
            <motion.div
              data-index={globalIndex}
              key={`${lyric.time}-${globalIndex}`}
              className="text-left max-w-4xl relative mb-6 pointer-events-auto cursor-pointer"
              onMouseEnter={() => handleLyricMouseEnter(globalIndex)}
              onMouseLeave={handleLyricMouseLeave}
              onClick={() => handleLyricClick(lyric.time)}
              initial={{ opacity: 0, y: 20 }}
              animate={{ 
                opacity: isBlinking ? [opacityValue, 0.95, opacityValue] : opacityValue,
                y: 0 
              }}
              transition={{ 
                opacity: isBlinking 
                  ? { duration: 2.0, repeat: Infinity, ease: [0.4, 0, 0.6, 1] }
                  : { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
                y: { duration: 0.3 }
              }}
            >
              {/* 娑叉€佺幓鐠冩 */}
              <AnimatePresence>
                {isHovered && showGlassFrame && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    transition={{ duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
                    className="absolute inset-0 -m-4 rounded-2xl pointer-events-none z-0"
                    style={{
                      background: `linear-gradient(135deg, ${accentColor}15, ${accentColor}08)`,
                      backdropFilter: 'blur(20px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                      border: `1px solid ${accentColor}40`,
                      boxShadow: `
                        0 0 0 1px ${accentColor}20,
                        0 8px 32px ${accentColor}30,
                        inset 0 1px 0 rgba(255, 255, 255, 0.1),
                        inset 0 -1px 0 rgba(0, 0, 0, 0.1)
                      `,
                    }}
                  >
                    {/* 鍐呴儴楂樺厜 */}
                    <div 
                      className="absolute inset-0 rounded-2xl opacity-50"
                      style={{
                        background: `radial-gradient(circle at 50% 0%, ${accentColor}30, transparent 70%)`,
                      }}
                    />
                    {/* 娴佸姩鏁堟灉 */}
                    <motion.div
                      className="absolute inset-0 rounded-2xl"
                      animate={{
                        background: [
                          `linear-gradient(45deg, ${accentColor}00, ${accentColor}20, ${accentColor}00)`,
                          `linear-gradient(225deg, ${accentColor}00, ${accentColor}20, ${accentColor}00)`,
                        ],
                      }}
                      transition={{
                        duration: 2,
                        repeat: Infinity,
                        ease: 'linear',
                      }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>

              <motion.p
                className="font-medium leading-relaxed break-words relative z-10"
                initial={false}
                animate={{
                  fontSize: isCurrent 
                    ? `${lyricSize}rem` 
                    : `${lyricSize * 0.57}rem`,
                  fontWeight: isCurrent ? 700 : 400,
                  scale: isBlinking ? [1, 1.015, 1] : 1,
                }}
                transition={{
                  fontSize: { duration: 0.4, ease: [0.4, 0, 0.2, 1] },
                  fontWeight: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                  scale: isBlinking 
                    ? { duration: 2.0, repeat: Infinity, ease: [0.4, 0, 0.6, 1] }
                    : { duration: 0.3, ease: [0.34, 1.56, 0.64, 1] },
                }}
                style={{
                  color: isCurrent
                    ? '#ffffff' 
                    : isBlinking
                    ? 'rgba(255, 255, 255, 0.85)'
                    : 'rgba(255, 255, 255, 0.5)',
                  textShadow: isCurrent && !lyric.words && lyricGlow
                    ? `0 0 60px ${accentColor}cc, 0 0 100px ${accentColor}80, 0 0 140px ${accentColor}40, 0 6px 30px rgba(0,0,0,0.9)` 
                    : isBlinking
                    ? `0 0 50px ${accentColor}dd, 0 0 80px ${accentColor}99, 0 0 120px ${accentColor}55, 0 4px 20px rgba(0,0,0,0.7)`
                    : '0 2px 4px rgba(0,0,0,0.3)',
                  filter: isCurrent && lyricGlow 
                    ? 'brightness(1.2) saturate(1.1)' 
                    : isBlinking
                    ? 'brightness(1.15) saturate(1.2)'
                    : 'none',
                  WebkitTextStroke: isCurrent && lyricGlow ? '0.5px rgba(255, 255, 255, 0.1)' : 'none',
                }}
              >
                {renderLyricLine(lyric, isCurrent)}
              </motion.p>
              
              {/* 浼犵粺浣嶇疆鐨勭炕璇?*/}
              {translationEnabled && translationPosition === 'traditional' && lyric.translation && isCurrent && (
                <motion.p
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 0.6, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3 }}
                  className="text-white/60 text-lg mt-3 font-light italic relative z-10"
                  style={{
                    textShadow: '0 2px 8px rgba(0,0,0,0.5)',
                    letterSpacing: '0.02em',
                    paddingLeft: '0.5rem',
                    borderLeft: '3px solid rgba(255, 255, 255, 0.2)',
                  }}
                >
                  {lyric.translation}
                </motion.p>
              )}
            </motion.div>
          )
        })}
      </div>
    </div>
  )
}
