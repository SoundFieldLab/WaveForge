import { memo, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X, Play, Music, Loader2, Sparkles } from 'lucide-react'
import { isTvModeActive } from '../platform'
import { Song } from '../services/musicApi'
import CachedImage from './CachedImage'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import { useTvBack } from '../tv/tvCore'

interface PlaylistPanelProps {
  show: boolean
  onClose: () => void
  playlist: Song[]
  currentIndex: number
  onSongSelect: (index: number) => void
  neteaseVip?: boolean
  qqVip?: boolean
  currentPlatform?: 'netease' | 'qq' | 'apple' | 'spotify' | 'kugou' | 'soda'
  onSmartReorder?: () => void
  isSmartReordering?: boolean
  smartReorderProgress?: { completed: number; total: number }
  playerTheme?: 'light' | 'dark'
}

const PLAYLIST_CARD_HEIGHT = 96
const PLAYLIST_ROW_GAP = 8
const PLAYLIST_ROW_HEIGHT = PLAYLIST_CARD_HEIGHT + PLAYLIST_ROW_GAP
const PLAYLIST_OVERSCAN = 5

/** 记忆化行组件：歌曲列表大时避免每行随滚动/重渲染重复渲染 */
const PlaylistRow = memo(function PlaylistRow({
  song,
  index,
  isCurrent,
  isDark,
  isVip,
  platform,
  onSongSelect,
}: {
  song: Song
  index: number
  isCurrent: boolean
  isDark: boolean
  isVip: boolean
  platform: string
  onSongSelect: (index: number) => void
}) {
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.012, x: -2 }}
      whileTap={{ scale: 0.99 }}
      onClick={() => onSongSelect(index)}
      className="absolute inset-x-0 flex w-full cursor-pointer items-center gap-4 overflow-hidden rounded-2xl px-4 text-left"
      style={{
        top: 0,
        height: `${PLAYLIST_CARD_HEIGHT}px`,
        background: isCurrent
          ? isDark
            ? 'linear-gradient(135deg, rgba(255,255,255,0.19), rgba(255,255,255,0.11))'
            : 'linear-gradient(135deg, rgba(0,0,0,0.12), rgba(0,0,0,0.07))'
          : isDark
            ? 'linear-gradient(135deg, rgba(255,255,255,0.065), rgba(255,255,255,0.035))'
            : 'linear-gradient(135deg, rgba(0,0,0,0.05), rgba(0,0,0,0.025))',
        border: isCurrent
          ? isDark ? '1px solid rgba(255,255,255,0.22)' : '1px solid rgba(0,0,0,0.18)'
          : isDark ? '1px solid rgba(255,255,255,0.045)' : '1px solid rgba(0,0,0,0.04)',
        boxShadow: isCurrent ? '0 10px 24px rgba(0,0,0,0.18)' : 'none',
      }}
    >
      <div className="flex w-10 shrink-0 items-center justify-center">
        {isCurrent ? (
          <motion.div
            animate={{ scale: [1, 1.14, 1] }}
            transition={{ repeat: Infinity, duration: 1.6 }}
          >
            <Play className={`h-5 w-5 ${isDark ? 'fill-white text-white drop-shadow-lg' : 'fill-black text-black'}`} />
          </motion.div>
        ) : (
          <span className={`text-base font-semibold ${isDark ? 'text-white/50' : 'text-black/45'}`}>{index + 1}</span>
        )}
      </div>

      <div className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl shadow-md ring-1 ${isDark ? 'bg-white/10 ring-white/15' : 'bg-black/5 ring-black/10'}`}>
        {song.album?.picUrl ? (
          <CachedImage
            src={song.album.picUrl}
            alt={song.name}
            className="h-full w-full object-cover"
            fallback={
              <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                <Music className={`h-6 w-6 ${isDark ? 'text-white/30' : 'text-black/30'}`} />
              </div>
            }
          />
        ) : (
          <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
            <Music className={`h-6 w-6 ${isDark ? 'text-white/30' : 'text-black/30'}`} />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className={`truncate text-base font-semibold ${isCurrent ? (isDark ? 'text-white' : 'text-black/90') : isDark ? 'text-white/90' : 'text-black/80'}`}>
          {song.name}
        </div>
        <div className={`mt-1 truncate text-sm ${isCurrent ? (isDark ? 'text-white/70' : 'text-black/60') : isDark ? 'text-white/50' : 'text-black/50'}`}>
          {Array.isArray(song.artists) ? song.artists.map(artist => artist.name).join(', ') : '未知艺人'}
        </div>
      </div>

      {(song.fee === 1 || song.fee === 4 || song.vip) && !isVip && (
        <CrownIcon isDark={isDark} />
      )}
    </motion.button>
  )
})

function CrownIcon({ isDark }: { isDark: boolean }) {
  // lucide Crown 图标
  return (
    <svg className="h-5 w-5 shrink-0 text-yellow-400 drop-shadow-lg" viewBox="0 0 24 24" fill="currentColor">
      <path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 4v2H5v-2h14z" />
    </svg>
  )
}

function PlaylistPanel({
  show,
  onClose,
  playlist,
  currentIndex,
  onSongSelect,
  neteaseVip = false,
  qqVip = false,
  currentPlatform = 'netease',
  onSmartReorder,
  isSmartReordering = false,
  smartReorderProgress,
  playerTheme = 'dark',
}: PlaylistPanelProps) {
  const isVip = currentPlatform === 'netease' ? neteaseVip : qqVip
  const isDark = playerTheme === 'dark'
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // TV 遥控器 BACK 关闭面板
  useTvBack(() => {
    onClose()
    return true
  })

  const onSelect = useCallback((index: number) => onSongSelect(index), [onSongSelect])

  // @tanstack/react-virtual：固定行高 + overscan，滚动只渲染可见行
  const rowVirtualizer = useVirtualizer({
    count: playlist.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => PLAYLIST_ROW_HEIGHT,
    overscan: PLAYLIST_OVERSCAN,
  })

  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className={`fixed inset-0 z-40 ${isDark ? 'bg-black/45' : 'bg-white/40'}`}
          />

          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="fixed right-0 top-0 z-50 h-full w-full max-w-md shadow-2xl"
            data-tv-scope
            style={{
              background: isDark
                ? 'linear-gradient(180deg, rgba(10, 10, 16, 0.82) 0%, rgba(4, 5, 10, 0.74) 100%)'
                : 'linear-gradient(180deg, rgba(252, 252, 250, 0.88) 0%, rgba(246, 246, 244, 0.82) 100%)',
              backdropFilter: 'blur(26px) saturate(135%)',
              WebkitBackdropFilter: 'blur(26px) saturate(135%)',
              borderLeft: isDark ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid rgba(0, 0, 0, 0.08)',
              boxShadow: isDark ? '-18px 0 48px rgba(0, 0, 0, 0.34)' : '-18px 0 48px rgba(0, 0, 0, 0.12)',
              willChange: 'transform',
            }}
          >
            <div className={`flex items-center justify-between border-b p-6 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
              <div className="flex items-center gap-3">
                <Music className={`h-6 w-6 ${isDark ? 'text-white' : 'text-black/85'}`} />
                <div>
                  <h2 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black/90'}`}>播放列表</h2>
                  <p className={`text-sm ${isDark ? 'text-white/60' : 'text-black/55'}`}>{playlist.length} 首歌曲</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {onSmartReorder && !isTvModeActive() && (
                  <motion.button
                    type="button"
                    whileHover={!isSmartReordering ? { scale: 1.03 } : undefined}
                    whileTap={!isSmartReordering ? { scale: 0.97 } : undefined}
                    onClick={onSmartReorder}
                    disabled={isSmartReordering || playlist.length - Math.max(currentIndex + 1, 0) < 2}
                    title="按音色、和声与速度使用 HAM-2 重排后续歌曲"
                    className={`flex items-center gap-2 rounded-full border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isDark ? 'border-white/10 bg-white/8 text-white/80 hover:bg-white/14' : 'border-black/10 bg-black/5 text-black/70 hover:bg-black/10'}`}
                  >
                    {isSmartReordering ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                    <span>
                      {isSmartReordering && smartReorderProgress
                        ? `${smartReorderProgress.completed}/${smartReorderProgress.total}`
                        : '智能重排'}
                    </span>
                  </motion.button>
                )}
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.08, rotate: 90 }}
                  whileTap={{ scale: 0.94 }}
                  onClick={onClose}
                  aria-label="关闭播放列表"
                  className={`rounded-full p-2 transition-colors ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                >
                  <X className={`h-6 w-6 ${isDark ? 'text-white/60' : 'text-black/60'}`} />
                </motion.button>
              </div>
            </div>

            <div
              ref={scrollContainerRef}
              className="h-[calc(100vh-100px)] overflow-y-auto p-4"
            >
              {playlist.length === 0 ? (
                <div className={`flex h-full flex-col items-center justify-center ${isDark ? 'text-white/40' : 'text-black/40'}`}>
                  <Music className="mb-4 h-16 w-16" />
                  <p>播放列表为空</p>
                </div>
              ) : (
                <div className="relative w-full" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                  {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    const song = playlist[virtualRow.index]
                    return (
                      <div
                        key={virtualRow.key}
                        className="absolute inset-x-0"
                        style={{
                          transform: `translateY(${virtualRow.start}px)`,
                          height: `${virtualRow.size}px`,
                        }}
                      >
                        <PlaylistRow
                          song={song}
                          index={virtualRow.index}
                          isCurrent={virtualRow.index === currentIndex}
                          isDark={isDark}
                          isVip={isVip}
                          platform={currentPlatform}
                          onSongSelect={onSelect}
                        />
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <ScrollToCurrentSong
              containerRef={scrollContainerRef}
              currentSongIndex={currentIndex}
              threshold={160}
              playerTheme={playerTheme}
              position="absolute"
              offsetLeft={-64}
              offsetBottom={88}
              cardHeight={PLAYLIST_CARD_HEIGHT}
              cardGapY={PLAYLIST_ROW_GAP}
              contentPaddingTop={16}
            />
            <ScrollToTop
              containerRef={scrollContainerRef}
              threshold={160}
              playerTheme={playerTheme}
              position="absolute"
              offsetLeft={-64}
              offsetBottom={24}
            />
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

export default memo(PlaylistPanel)
