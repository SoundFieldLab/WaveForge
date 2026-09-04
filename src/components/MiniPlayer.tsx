import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, SkipForward, SkipBack, Volume2, VolumeX } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import CachedImage from './CachedImage'

interface MiniPlayerProps {
  show: boolean
  coverUrl: string
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  title: string
  artist: string
  currentLyric: string
  hasLyrics?: boolean
  accentColor?: string
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onClick: () => void
}

// 颜色提取工具：从图片URL提取主色（取平均RGB）
const extractColorFromImage = (url: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = url

    const finish = () => {
      // 释放解码后的封面图，避免每切一首歌都残留一张整图解码位图
      img.onload = null
      img.onerror = null
      img.src = ''
    }

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          finish()
          return reject('Canvas not supported')
        }

        // 缩略图尺寸，加快采样
        const size = 50
        canvas.width = size
        canvas.height = size
        ctx.drawImage(img, 0, 0, size, size)

        const imageData = ctx.getImageData(0, 0, size, size)
        const data = imageData.data
        // 采样完成后立即释放封面图与 Canvas 像素缓冲
        finish()
        canvas.width = 0
        canvas.height = 0
        let r = 0,
          g = 0,
          b = 0,
          count = 0

        // 采样所有像素（跳过透明）
        for (let i = 0; i < data.length; i += 4) {
          const alpha = data[i + 3]
          if (alpha < 128) continue
          r += data[i]
          g += data[i + 1]
          b += data[i + 2]
          count++
        }

        if (count === 0) return reject('No opaque pixel')

        const avgR = Math.round(r / count)
        const avgG = Math.round(g / count)
        const avgB = Math.round(b / count)
        resolve(`rgb(${avgR}, ${avgG}, ${avgB})`)
      } catch (err) {
        reject(err)
      }
    }

    img.onerror = () => reject('Image load failed')
  })
}

export default function MiniPlayer({
  show,
  coverUrl,
  isPlaying,
  currentTime,
  duration,
  volume,
  title,
  artist,
  currentLyric,
  hasLyrics = true,
  accentColor = '#3b82f6',
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onClick
}: MiniPlayerProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [extractedColor, setExtractedColor] = useState<string>(accentColor)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const [volumeBeforeMute, setVolumeBeforeMute] = useState(1.0)
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 当封面变化时提取颜色
  useEffect(() => {
    if (!coverUrl) return

    let isMounted = true
    extractColorFromImage(coverUrl)
      .then(color => {
        if (isMounted) setExtractedColor(color)
      })
      .catch(() => {
        // 回退到传入的 accentColor
        if (isMounted) setExtractedColor(accentColor)
      })

    return () => { isMounted = false }
  }, [coverUrl, accentColor])

  // 计算进度
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0
  const strokeWidth = 3
  const perimeter = 80 * 4
  const progressLength = (progress / 100) * perimeter

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const minutes = Math.floor(seconds / 60)
    return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
  }

  const handleVolumeButtonClick = () => {
    setShowVolumeSlider(true)
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
    }
  }

  const handleVolumeButtonDoubleClick = () => {
    if (volume > 0) {
      setVolumeBeforeMute(volume)
      onVolumeChange(0)
    } else {
      onVolumeChange(volumeBeforeMute > 0 ? volumeBeforeMute : 1.0)
    }
  }

  const handleVolumeAreaLeave = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
    }
    volumeTimeoutRef.current = setTimeout(() => {
      setShowVolumeSlider(false)
    }, 1000)
  }

  const handleVolumeAreaEnter = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
      volumeTimeoutRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (volumeTimeoutRef.current) {
        clearTimeout(volumeTimeoutRef.current)
      }
    }
  }, [])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ x: 120, y: 120, scale: 0.7, opacity: 0 }}
          animate={{ x: 0, y: 0, scale: 1.21, opacity: 1 }}
          exit={{ x: 80, y: 80, scale: 0.8, opacity: 0 }}
          transition={{ type: 'spring', damping: 24, stiffness: 220 }}
          className="fixed bottom-6 right-6 z-50 origin-bottom-right"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <motion.div
            animate={{ width: isHovered ? 326 : 92, height: isHovered ? 126 : 92 }}
            transition={{ type: 'spring', damping: 25, stiffness: 260 }}
            className="relative origin-bottom-right"
          >
            <motion.div
              animate={{ opacity: isHovered ? 1 : 0 }}
              className="absolute inset-0 overflow-hidden rounded-[22px]"
              style={{
                border: `1px solid ${extractedColor}66`,
                boxShadow: '0 14px 42px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.16)'
              }}
            />
            <AnimatePresence initial={false}>
              {isHovered && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 overflow-hidden rounded-[22px]">
                  <CachedImage src={coverUrl} alt="" className="h-full w-full scale-125 object-cover blur-2xl" draggable={false} />
                  <div className="absolute inset-0 bg-black/55 backdrop-blur-xl" />
                  <div className="absolute inset-0 bg-gradient-to-br from-white/10 via-transparent to-black/35" />
                </motion.div>
              )}
            </AnimatePresence>

            {/* 信息和控制区域 - 悬停时展开 */}
            <AnimatePresence>
              {isHovered && (
                <motion.div
                  initial={{ x: 24, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: 20, opacity: 0 }}
                  transition={{ duration: 0.22 }}
                  onClick={(event) => event.stopPropagation()}
                  className="absolute inset-y-0 left-0 right-[78px] z-10 flex flex-col px-4 py-2"
                >
                  {/* 第一行：标题和艺术家 */}
                  <div className="min-w-0 flex items-baseline gap-2">
                    <div className="truncate text-[14px] font-semibold text-white">{title}</div>
                    <div className="truncate text-[12px] text-white/55">{artist}</div>
                  </div>

                  {/* 第二行：歌词，支持滚动 - 固定高度防止进度条跳动 */}
                  <div className="w-full overflow-hidden mt-0.5 h-[20px] flex items-center">
                    <AnimatePresence mode="wait">
                      <motion.div 
                        key={currentLyric || 'no-lyric'} 
                        initial={{ y: 4, opacity: 0 }} 
                        animate={{ y: 0, opacity: 1 }} 
                        exit={{ y: -4, opacity: 0 }} 
                        className="text-left w-full"
                      >
                        {currentLyric && currentLyric.length > 25 ? (
                          <div className="overflow-hidden">
                            <div className="inline-block animate-[scroll_12s_linear_infinite] whitespace-nowrap text-[13px] font-medium text-white/75">
                              {currentLyric}&nbsp;&nbsp;&nbsp;&nbsp;{currentLyric}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[13px] font-medium text-white/75 truncate">
                            {currentLyric || (hasLyrics ? '' : '暂无歌词')}
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  {/* 进度条 */}
                  <div className="mt-auto flex items-center gap-1.5 text-[9px] text-white/45">
                    <span>{formatTime(currentTime)}</span>
                    <input
                      aria-label="播放进度"
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={0.1}
                      value={Math.min(currentTime, duration || 0)}
                      onChange={(event) => onSeek(Number(event.target.value))}
                      className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-transparent [&::-moz-range-thumb]:h-0 [&::-moz-range-thumb]:w-0 [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-0 [&::-webkit-slider-thumb]:w-0 [&::-webkit-slider-thumb]:appearance-none"
                      style={{ background: `linear-gradient(to right, ${extractedColor} 0%, ${extractedColor} ${progress}%, rgba(255,255,255,0.18) ${progress}%, rgba(255,255,255,0.18) 100%)` }}
                    />
                    <span>{formatTime(duration)}</span>
                  </div>

                  {/* 播放控制按钮 */}
                  <div className="mt-auto flex items-center gap-1">
                    <button onClick={onPrevious} className="rounded-full p-1.5 text-white/75 transition hover:bg-white/10 hover:text-white" aria-label="上一曲"><SkipBack className="h-3.5 w-3.5" fill="currentColor" /></button>
                    <button onClick={onPlayPause} className="rounded-full p-2 text-white shadow-lg" style={{ backgroundColor: extractedColor }} aria-label={isPlaying ? '暂停' : '播放'}>
                      {isPlaying ? <Pause className="h-3.5 w-3.5" fill="currentColor" /> : <Play className="h-3.5 w-3.5" fill="currentColor" />}
                    </button>
                    <button onClick={onNext} className="rounded-full p-1.5 text-white/75 transition hover:bg-white/10 hover:text-white" aria-label="下一曲"><SkipForward className="h-3.5 w-3.5" fill="currentColor" /></button>
                    
                    {/* 音量控制 */}
                    <button 
                      onClick={handleVolumeButtonClick}
                      onDoubleClick={handleVolumeButtonDoubleClick}
                      className="rounded-full p-1.5 text-white/75 transition hover:bg-white/10 hover:text-white ml-auto" 
                      aria-label="音量"
                    >
                      {volume === 0 ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>

                  {/* 音量滑块 - 独立定位，液态玻璃风格 */}
                  <AnimatePresence>
                    {showVolumeSlider && (
                      <motion.div
                        initial={{ y: 10, opacity: 0, scale: 0.95 }}
                        animate={{ y: 0, opacity: 1, scale: 1 }}
                        exit={{ y: 10, opacity: 0, scale: 0.95 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        className="absolute bottom-2 right-2 flex items-center gap-2 rounded-full px-3 py-1.5 shadow-lg"
                        style={{
                          background: 'rgba(255, 255, 255, 0.1)',
                          backdropFilter: 'blur(20px) saturate(180%)',
                          WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                          border: '1px solid rgba(255, 255, 255, 0.18)',
                          boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
                        }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseEnter={handleVolumeAreaEnter}
                        onMouseLeave={handleVolumeAreaLeave}
                      >
                        <span className="text-[10px] text-white/80 w-8 text-right font-medium">{Math.round(volume * 100)}%</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.01}
                          value={volume}
                          onChange={(e) => onVolumeChange(Number(e.target.value))}
                          className="h-1 w-16 cursor-pointer appearance-none rounded-full bg-transparent [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full"
                          style={{ 
                            background: `linear-gradient(to right, ${extractedColor} 0%, ${extractedColor} ${volume * 100}%, rgba(255,255,255,0.25) ${volume * 100}%, rgba(255,255,255,0.25) 100%)`,
                          }}
                          aria-label="音量调节"
                        />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>

          {/* 封面 + 进度环 */}
          <motion.div
            whileHover={{ scale: 1.05 }}
            onClick={onClick}
            animate={{ right: isHovered ? 0 : 6, bottom: isHovered ? 0 : 6 }}
            transition={{ type: 'spring', damping: 25, stiffness: 260 }}
            className="absolute z-20 h-20 w-20 cursor-pointer"
          >
            <AnimatePresence>
              {!isHovered && (
                <motion.svg
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute -inset-[6px] h-[92px] w-[92px]"
                  viewBox="0 0 92 92"
                  style={{ filter: `drop-shadow(0 0 8px ${extractedColor}60)`, pointerEvents: 'none' }}
                >
                  <rect x="6" y="6" width="80" height="80" rx="12" stroke="rgba(255, 255, 255, 0.15)" strokeWidth={strokeWidth} fill="none" />
                  <path
                    d={`M ${6 + 12} ${6} L ${6 + 80 - 12} ${6} Q ${6 + 80} ${6} ${6 + 80} ${6 + 12} L ${6 + 80} ${6 + 80 - 12} Q ${6 + 80} ${6 + 80} ${6 + 80 - 12} ${6 + 80} L ${6 + 12} ${6 + 80} Q ${6} ${6 + 80} ${6} ${6 + 80 - 12} L ${6} ${6 + 12} Q ${6} ${6} ${6 + 12} ${6}`}
                    stroke={extractedColor}
                    strokeWidth={strokeWidth}
                    fill="none"
                    strokeDasharray={perimeter}
                    strokeDashoffset={perimeter - progressLength}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.3s ease' }}
                  />
                </motion.svg>
              )}
            </AnimatePresence>

            {/* 封面图片 */}
            <div
              className="relative h-20 w-20 overflow-hidden rounded-xl bg-black/40"
              style={{
                border: '2px solid rgba(255, 255, 255, 0.2)',
                boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
              }}
            >
              <AnimatePresence initial={false} mode="sync">
                <motion.div
                  key={coverUrl || 'empty-cover'}
                  initial={{ x: 24, opacity: 0, scale: 1.08 }}
                  animate={{ x: 0, opacity: 1, scale: 1 }}
                  exit={{ x: -24, opacity: 0, scale: 0.94 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="absolute inset-0"
                >
                  <CachedImage
                    src={coverUrl}
                    alt={`${title} 封面`}
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
