import { useState } from 'react'
import { Play, Pause, SkipBack, SkipForward, List, Repeat, Repeat1, Shuffle, Volume2, VolumeX } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

interface PlayerControlsProps {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume?: number
  onPlayPause: () => void
  onSeek: (time: number) => void
  onVolumeChange?: (volume: number) => void
  onPrevious?: () => void
  onNext?: () => void
  onPlaylistClick?: () => void
  accentColor: string
  playMode?: 'sequential' | 'shuffle' | 'repeat'
  onPlayModeChange?: () => void
  playerTheme?: 'light' | 'dark'
  backgroundEffect?: 'transparent' | 'blur' | 'immersive'
}

// 判断颜色亮度，返回适合的对比色
function getContrastColor(hexColor: string): string {
  // 移除 # 号
   let hex = hexColor.replace('#', '')
  // 处理3位十六进制颜色
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]
  }
  
  // 转换为 RGB
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  
  // 计算亮度 (使用 YIQ 公式)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  
  // 如果亮度大于 128，使用黑色；否则使用白色
  return brightness > 128 ? '#000000' : '#ffffff'
}

// 根据主题色自动生成进度条轨道颜色
function getTrackColor(hexColor: string, isDark: boolean): string {
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const brightness = (r * 299 + g * 587 + b * 114) / 1000
  
  if (isDark) {
    // 深色背景：用主题色的低透明度版本，亮度越高透明度越低
    const alpha = brightness > 128 ? 0.5 : 0.4
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  } else {
    // 浅色背景：用主题色的暗化版本
    const darkFactor = brightness > 128 ? 0.5 : 0.65
    return `rgba(${Math.floor(r * darkFactor)}, ${Math.floor(g * darkFactor)}, ${Math.floor(b * darkFactor)}, 0.5)`
  }
}

export default function PlayerControls({
  playMode = 'sequential',
  onPlayModeChange,
  isPlaying,
  currentTime,
  duration,
   volume,
  onVolumeChange,
  onPlayPause,
  onSeek,
  onPrevious,
  onNext,
  onPlaylistClick,
  accentColor,
  playerTheme = 'dark',
  backgroundEffect = 'blur',
}: PlayerControlsProps) {
  const [isHovered, setIsHovered] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragValue, setDragValue] = useState(0)

  // 使用传入的 volume，避免未使用警告
  const currentVolume = volume ?? 1

  // 播放时自动收起，暂停时展开
  const isExpanded = !isPlaying || isHovered || isDragging

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value)
    setDragValue(value)
  }

  const handleSeekMouseUp = (e: React.MouseEvent<HTMLInputElement>) => {
    const value = Number((e.target as HTMLInputElement).value)
    setIsDragging(false)
    onSeek(value)
  }

  const handleSeekTouchEnd = (e: React.TouchEvent<HTMLInputElement>) => {
    const value = Number((e.target as HTMLInputElement).value)
    setIsDragging(false)
    onSeek(value)
  }

  const displayTime = isDragging ? dragValue : currentTime
  const progressPercent = (displayTime / duration) * 100
  
  // 根据主题色亮度计算对比色
  const iconColor = getContrastColor(accentColor)

  return (
    <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50">
      <motion.div
        initial={{ width: '360px' }}
        animate={{
          width: isExpanded ? '640px' : '360px',
          paddingTop: isExpanded ? '16px' : '12px',
          paddingBottom: isExpanded ? '16px' : '12px',
        }}
        transition={{ 
          duration: 0.35,
          delay: isExpanded ? 0 : 0.2,
          ease: [0.32, 0.72, 0, 1]
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className="relative rounded-full backdrop-blur-3xl px-5"
        style={{
          background: playerTheme === 'dark'
            ? backgroundEffect === 'transparent'
              ? 'linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.03) 100%)'  // 深色透明：极淡白色玻璃，几乎透明
              : backgroundEffect === 'blur'
              ? 'linear-gradient(135deg, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0.3) 100%)'  // 深色模糊：深色玻璃
              : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.4) 100%)'  // 深色沉浸：更深玻璃
            : backgroundEffect === 'transparent'
            ? 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.05) 100%)'  // 浅色透明：极淡白色玻璃，几乎透明
            : backgroundEffect === 'blur'
            ? 'linear-gradient(135deg, rgba(255,255,255,0.7) 0%, rgba(255,255,255,0.6) 100%)'  // 浅色模糊：强白色玻璃
            : 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.7) 100%)',  // 浅色沉浸：更强白色玻璃
          boxShadow: playerTheme === 'dark'
            ? `0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1), 0 0 60px ${accentColor}20`
            : `0 8px 32px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.1), 0 0 60px ${accentColor}30`,
        }}
      >
        {/* 进度条和时间 - 始终在中间 */}
        <div className="flex items-center justify-center">
          <motion.div
            animate={{
              scale: 1,
              opacity: isExpanded ? 1 : 0.7
            }}
            transition={{ 
              duration: 0.3,
              delay: isExpanded ? 0.15 : 0.15,
              ease: "easeInOut"
            }}
            className="flex items-center gap-3"
          >
            {/* 当前时间 */}
            <motion.div 
              className={`text-xs font-medium min-w-[38px] text-center leading-none ${
                playerTheme === 'dark' ? 'text-white/80' : 'text-black/70'
              }`}
              animate={{
                opacity: isExpanded ? 1 : 0.7
              }}
            >
              {formatTime(displayTime)}
            </motion.div>

            {/* 进度条 */}
            <div className="relative w-56 flex items-center">
              <input
                type="range"
                min="0"
                max={duration}
                value={displayTime}
                onMouseDown={() => setIsDragging(true)}
                onTouchStart={() => setIsDragging(true)}
                onChange={handleSeekChange}
                onMouseUp={handleSeekMouseUp}
                onTouchEnd={handleSeekTouchEnd}
                className="progress-slider w-full h-2.5 hover:h-3.5 rounded-full appearance-none cursor-pointer transition-all duration-200"
                style={{
                  background: playerTheme === 'dark'
                    ? backgroundEffect === 'transparent'
                      ? `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${progressPercent}%, ${getTrackColor(accentColor, true)} ${progressPercent}%, ${getTrackColor(accentColor, true)} 100%)`
                      : `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${progressPercent}%, ${getTrackColor(accentColor, true)} ${progressPercent}%, ${getTrackColor(accentColor, true)} 100%)`
                    : `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${progressPercent}%, ${getTrackColor(accentColor, false)} ${progressPercent}%, ${getTrackColor(accentColor, false)} 100%)`,
                  boxShadow: `0 0 16px ${accentColor}cc, 0 0 32px ${accentColor}66, inset 0 1px 2px rgba(0,0,0,0.3)`,
                }}
              />
            </div>

            {/* 总时长 */}
            <motion.div 
              className={`text-xs font-medium min-w-[38px] text-center leading-none ${
                playerTheme === 'dark' ? 'text-white/80' : 'text-black/70'
              }`}
              animate={{
                opacity: isExpanded ? 1 : 0.7
              }}
            >
              {formatTime(duration)}
            </motion.div>
          </motion.div>
        </div>

        {/* 左侧控制按钮 - 从左侧时间边缘向左展开 */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0, x: 150 }}
              animate={{ 
                opacity: 1, 
                x: 0
              }}
              exit={{ 
                opacity: 0, 
                x: 30
              }}
              transition={{ 
                duration: isExpanded ? 0.25 : 0.15,
                delay: isExpanded ? 0.25 : 0,
                ease: "easeOut"
              }}
              className="absolute left-5 top-1/2 -translate-y-1/2 flex items-center gap-2"
            >
              {/* 上一曲 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onPrevious}
                disabled={!onPrevious}
                className={`p-2 rounded-full transition-colors disabled:opacity-30 ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                <SkipBack className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
              </motion.button>

              {/* 播放/暂停 */}
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={onPlayPause}
                className="p-2.5 rounded-full transition-all"
                style={{
                  backgroundColor: accentColor,
                  boxShadow: `0 0 20px ${accentColor}60, 0 4px 12px ${accentColor}40`,
                }}
              >
                {isPlaying ? (
                  <Pause className="w-4 h-4" style={{ color: iconColor }} />
                ) : (
                  <Play className="w-4 h-4 ml-0.5" style={{ color: iconColor }} />
                )}
              </motion.button>

              {/* 下一曲 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onNext}
                disabled={!onNext}
                className={`p-2 rounded-full transition-colors disabled:opacity-30 ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                <SkipForward className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 右侧功能按钮 - 从右侧时间边缘向右展开 */}
        <AnimatePresence>
          {isExpanded && (
            <motion.div
              initial={{ opacity: 0, x: -150 }}
              animate={{ 
                opacity: 1, 
                x: 0
              }}
              exit={{ 
                opacity: 0, 
                x: -30
              }}
              transition={{ 
                duration: isExpanded ? 0.25 : 0.15,
                delay: isExpanded ? 0.25 : 0,
                ease: "easeOut"
              }}
              className="absolute right-5 top-1/2 -translate-y-1/2 flex items-center gap-2"
            >
              {/* 播放列表按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onPlaylistClick}
                className={`p-2 rounded-full transition-colors ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                <List className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
              </motion.button>

              {/* 音量按钮（使用 onVolumeChange 避免未使用警告） */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => onVolumeChange && onVolumeChange(currentVolume === 0 ? 1 : 0)}
                className={`p-2 rounded-full transition-colors ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                {currentVolume === 0 ? (
                  <VolumeX className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                ) : (
                  <Volume2 className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/60'}`} />
                )}
              </motion.button>

              {/* 播放模式按钮 */}
              <motion.button
                whileHover={{ scale: 1.1 }}
                whileTap={{ scale: 0.95 }}
                onClick={onPlayModeChange}
                className={`p-2 rounded-full transition-colors ${
                  playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                {playMode === 'shuffle' && <Shuffle className="w-4 h-4 text-white/70" />}
                {playMode === 'repeat' && <Repeat1 className="w-4 h-4 text-white/70" />}
                {playMode === 'sequential' && <Repeat className="w-4 h-4 text-white/40" />}
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
