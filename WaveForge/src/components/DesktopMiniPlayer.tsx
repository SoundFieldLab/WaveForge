/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { motion } from 'framer-motion'
import { Play, Pause, SkipForward, SkipBack } from 'lucide-react'
import { Song } from '../services/musicApi'
import React from 'react'

interface DesktopMiniPlayerProps {
  currentSong: Song | null
  isPlaying: boolean
  currentTime: number
  duration: number
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  cardBlurAmount: number
  onEnterPlayer?: () => void
  accentColor?: string
  currentLyric?: string
  underOverlay?: boolean
}

function DesktopMiniPlayer({
  currentSong,
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onNext,
  onPrevious,
  cardBlurAmount,
  onEnterPlayer,
  accentColor = '#8b5cf6',
  currentLyric = '',
  underOverlay = false,
}: DesktopMiniPlayerProps) {
  if (!currentSong) return null

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <motion.div
      initial={{ y: -100, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: -100, opacity: 0 }}
      transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      className={`fixed top-6 left-1/2 max-w-[44vw] -translate-x-1/2 cursor-pointer ${underOverlay ? 'pointer-events-none z-10' : 'z-50'}`}
      data-desktop-interactive
      style={{
        width: 'clamp(400px, 42vw, 600px)',
      }}
      onClick={() => {
        if (onEnterPlayer) {
          onEnterPlayer()
        }
      }}
    >
      <div
        className="rounded-2xl overflow-hidden border border-white/20 shadow-2xl transition-all hover:scale-[1.02]"
        style={{
          background: 'rgba(0, 0, 0, 0.4)',
          backdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
          WebkitBackdropFilter: `blur(${cardBlurAmount}px) saturate(180%)`,
        }}
      >
        {/* 进度条 */}
        <div className="h-1 bg-white/10 relative">
          <motion.div
            className="h-full w-full origin-left"
            animate={{ scaleX: Math.max(0, Math.min(1, progress / 100)) }}
            style={{
              background: accentColor,
              willChange: 'transform',
            }}
            transition={{ duration: 0.3, ease: 'linear' }}
          />
        </div>

        {/* 主内容 */}
        <div className="flex items-center gap-3 px-4 py-3 min-[1360px]:gap-4 min-[1360px]:px-6 min-[1360px]:py-4">
          {/* 封面 */}
          <img
            src={currentSong.album?.picUrl || ''}
            alt={currentSong.name}
            className="h-12 w-12 rounded-lg shadow-lg min-[1360px]:h-14 min-[1360px]:w-14"
            draggable={false}
          />

          {/* 歌曲信息 */}
          <div className="flex-1 min-w-0">
            <h3 className="text-white font-semibold text-base truncate">
              {currentSong.name}
            </h3>
            <p className="text-white/60 text-sm truncate">
              {currentSong.artists?.map((a: any) => a.name).join(', ')}
            </p>
            {/* 当前歌词 */}
            {currentLyric && (
              <p className="text-white/50 text-xs truncate mt-1 italic">
                {currentLyric}
              </p>
            )}
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center gap-2 min-[1360px]:gap-3">
            {/* 上一曲 */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={(e) => {
                e.stopPropagation()
                onPrevious()
              }}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-all flex items-center justify-center"
            >
              <SkipBack className="w-4 h-4 text-white" fill="currentColor" />
            </motion.button>

            {/* 播放/暂停 */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={(e) => {
                e.stopPropagation()
                onPlayPause()
              }}
              className="w-10 h-10 rounded-full shadow-lg flex items-center justify-center transition-all"
              style={{
                background: accentColor,
              }}
            >
              {isPlaying ? (
                <Pause className="w-5 h-5 text-white" fill="currentColor" />
              ) : (
                <Play className="w-5 h-5 text-white" fill="currentColor" />
              )}
            </motion.button>

            {/* 下一曲 */}
            <motion.button
              whileHover={{ scale: 1.1 }}
              whileTap={{ scale: 0.95 }}
              onClick={(e) => {
                e.stopPropagation()
                onNext()
              }}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 transition-all flex items-center justify-center"
            >
              <SkipForward className="w-4 h-4 text-white" fill="currentColor" />
            </motion.button>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

export default React.memo(DesktopMiniPlayer)
