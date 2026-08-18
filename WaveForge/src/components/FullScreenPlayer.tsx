import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AlbumCoverPlayer from './AlbumCoverPlayer'
import LyricsDisplay from './LyricsDisplay'
import TranslationDisplay from './TranslationDisplay'
import ImmersiveControls from './ImmersiveControls'
import PlayerControls from './PlayerControls'
import { Song, LyricLine } from '../services/musicApi'
import { stableTrackKey } from '../audio/PlaybackQueue'

const CURSOR_HIDE_DELAY = 7_000

interface Track {
  coverUrl: string
  dominantColor?: string | null
}

interface FullScreenPlayerProps {
  currentSong: Song
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  lyrics: LyricLine[]
  dominantColor: string | null
  translationEnabled: boolean
  translationPosition: 'bottom-right' | 'below-lyric'
  currentTranslation: string
  romanEnabled: boolean
  hasTranslation: boolean
  hasRoman: boolean
  playerTheme: 'light' | 'dark'
  isPureMusic: boolean
  isTransitioning: boolean
  transitionProgress?: number
  transitionFromTrack?: Track | null
  transitionToTrack?: Track | null
  
  onHomeClick: () => void
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onCurrentTranslationChange: (translation: string) => void
  onTranslationToggle: () => void
  onRomanToggle: () => void
}

export default function FullScreenPlayer({
  currentSong,
  isPlaying,
  currentTime,
  duration,
  volume,
  lyrics,
  dominantColor,
  translationEnabled,
  translationPosition,
  currentTranslation,
  romanEnabled,
  hasTranslation,
  hasRoman,
  playerTheme,
  isPureMusic,
  isTransitioning,
  transitionProgress = 0,
  transitionFromTrack = null,
  transitionToTrack = null,
  onHomeClick,
  onPlayPause,
  onNext,
  onPrevious,
  onSeek,
  onVolumeChange,
  onCurrentTranslationChange,
  onTranslationToggle,
  onRomanToggle,
}: FullScreenPlayerProps) {
  const [cursorHidden, setCursorHidden] = useState(false)
  const cursorTimerRef = useRef<number | null>(null)
  const lastMouseMovementRef = useRef(Date.now())

  useEffect(() => {
    const scheduleCursorCheck = (delay = CURSOR_HIDE_DELAY) => {
      cursorTimerRef.current = window.setTimeout(() => {
        const idleTime = Date.now() - lastMouseMovementRef.current

        if (idleTime >= CURSOR_HIDE_DELAY) {
          setCursorHidden(true)
          cursorTimerRef.current = null
          return
        }

        scheduleCursorCheck(CURSOR_HIDE_DELAY - idleTime)
      }, delay)
    }

    const handleMouseMove = () => {
      lastMouseMovementRef.current = Date.now()
      setCursorHidden(false)

      if (cursorTimerRef.current === null) {
        scheduleCursorCheck()
      }
    }

    lastMouseMovementRef.current = Date.now()
    scheduleCursorCheck()
    window.addEventListener('mousemove', handleMouseMove, { passive: true })

    return () => {
      window.removeEventListener('mousemove', handleMouseMove)

      if (cursorTimerRef.current !== null) {
        window.clearTimeout(cursorTimerRef.current)
        cursorTimerRef.current = null
      }
    }
  }, [])

  const currentSongKey = stableTrackKey(currentSong)
  const currentTrack = {
    coverUrl: currentSong?.album?.picUrl || '',
    title: currentSong?.name || '',
    artist: currentSong?.artists?.map((a: any) => a.name).join(', ') || '',
  }
  const lyricsTranslationPosition = translationPosition === 'below-lyric' ? 'traditional' : 'bottom-right'

  return (
    <div
      className={`playback-page h-screen w-full flex items-center justify-center overflow-hidden relative p-8 ${
        cursorHidden ? 'playback-cursor-hidden' : ''
      }`}
    >
      {/* 沉浸式控制按钮组 - 右上角 */}
      <ImmersiveControls
        onHomeClick={() => {
          console.log('🎵 [FullScreenPlayer] Home 按钮被点击')
          onHomeClick()
        }}
        onTranslationToggle={onTranslationToggle}
        translationEnabled={translationEnabled}
        hasTranslation={hasTranslation}
        onRomanToggle={onRomanToggle}
        romanEnabled={romanEnabled}
        hasRoman={hasRoman}
        playerTheme={playerTheme}
        isPureMusic={isPureMusic}
      />

      {(() => {
        // 使用状态中的纯音乐标志
        return isPureMusic ? (
          /* 纯音乐时居中显示 */
          <motion.div
            key={`no-lyrics-${currentSongKey}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: isTransitioning ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="absolute inset-0 flex flex-col items-center justify-center gap-8"
          >
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ 
                opacity: isTransitioning ? 0 : 1, 
                y: 0,
                scale: isTransitioning ? 0.95 : 1
              }}
              transition={{ delay: 0.2, duration: 0.5, ease: 'easeInOut' }}
            >
              <AlbumCoverPlayer
                coverUrl={currentTrack.coverUrl}
                isPlaying={isPlaying}
                dominantColor={dominantColor}
                trackId={currentSong.id ?? currentSong.mid ?? currentSongKey}
                isTransitioning={isTransitioning}
                transitionProgress={transitionProgress}
                transitionFromTrack={transitionFromTrack}
                transitionToTrack={transitionToTrack}
              />
            </motion.div>

            {/* 歌曲信息 */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ 
                opacity: isTransitioning ? 0 : 1, 
                y: 0 
              }}
              transition={{ delay: 0.3, duration: 0.5, ease: 'easeInOut' }}
              className="text-center space-y-3"
            >
              <h1 className="text-4xl font-bold text-white drop-shadow-lg">{currentSong.name}</h1>
              <p className="text-xl text-white/80 drop-shadow-md">{currentSong.artists.map((a: any) => a.name).join(', ')}</p>
            </motion.div>
          </motion.div>
        ) : (
          /* 有歌词时左右布局 */
          <motion.div
            key={`with-lyrics-${currentSongKey}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: isTransitioning ? 0 : 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: 'easeInOut' }}
            className="w-full max-w-7xl h-[85vh] flex gap-12 items-center"
          >
            {/* 左侧：封面展示区 */}
            <motion.div
              key={`cover-${currentSongKey}`}
              initial={{ opacity: 0, x: -30, scale: 0.95 }}
              animate={{ 
                opacity: isTransitioning ? 0 : 1, 
                x: 0,
                scale: isTransitioning ? 0.95 : 1
              }}
              exit={{ opacity: 0, x: -30 }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
              className="flex-1 flex flex-col items-center justify-center gap-6"
            >
              <AlbumCoverPlayer
                coverUrl={currentTrack.coverUrl}
                isPlaying={isPlaying}
                dominantColor={dominantColor}
                trackId={currentSong.id ?? currentSong.mid ?? currentSongKey}
                isTransitioning={isTransitioning}
                transitionProgress={transitionProgress}
                transitionFromTrack={transitionFromTrack}
                transitionToTrack={transitionToTrack}
              />
              
              {/* 歌曲信息 */}
              <div className="text-center space-y-2">
                <h1 className={`text-3xl font-bold ${playerTheme === 'dark' ? 'text-white drop-shadow-lg' : 'text-black/90'}`}>{currentSong.name}</h1>
                <p className={`text-lg ${playerTheme === 'dark' ? 'text-white/80 drop-shadow-md' : 'text-black/60'}`}>{currentSong.artists.map((a: any) => a.name).join(', ')}</p>
              </div>
            </motion.div>

            {/* 右侧：歌词显示区 */}
            <motion.div
              key={`lyrics-${currentSongKey}`}
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: isTransitioning ? 0 : 1, x: 0 }}
              exit={{ opacity: 0, x: 30 }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
              className="flex-1 flex flex-col justify-between h-full min-h-0 py-8"
            >
              {/* 歌词显示 */}
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={currentSongKey}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: isTransitioning ? 0 : 1, y: 0 }}
                    exit={{ opacity: 0, y: -20 }}
                    transition={{ duration: 0.5, ease: 'easeInOut' }}
                    className="w-full h-full min-h-0"
                  >
                    <LyricsDisplay
                      lyrics={lyrics}
                      currentTime={currentTime}
                      isPlaying={isPlaying}
                      accentColor={dominantColor || '#fff'}
                      translationEnabled={translationEnabled}
                      translationPosition={lyricsTranslationPosition}
                      onCurrentTranslationChange={onCurrentTranslationChange}
                      onSeek={onSeek}
                      romanEnabled={romanEnabled}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* 右下角翻译显示 */}
              <TranslationDisplay
                translation={currentTranslation}
                show={translationEnabled && translationPosition === 'bottom-right'}
                songId={currentSong?.id}
              />
            </motion.div>
          </motion.div>
        )
      })()}

      {/* 全局播放控制器 - 固定在底部 */}
      <PlayerControls
        isPlaying={isPlaying}
        currentTime={currentTime}
        duration={duration}
        volume={volume}
        onPlayPause={onPlayPause}
        onNext={onNext}
        onPrevious={onPrevious}
        onSeek={onSeek}
        onVolumeChange={onVolumeChange}
        accentColor={dominantColor || '#ffffff'}
        playerTheme={playerTheme}
      />
    </div>
  )
}
