import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Disc3, Heart, HeartOff, MessageCircle, UserRound, Info } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getPlatformCapabilities, getPlatformFavoriteLabels } from '../services/platforms'
import SongContextMenu from './SongContextMenu'

type RadialDirection = 'up' | 'down' | 'left' | 'right' | 'up-left' | 'up-right' | 'down-left' | 'down-right'

interface PlaybackRadialMenuProps {
  song: Song
  accentColor: string
  liked: boolean
  userPlaylists: any[]
  playerTheme?: 'light' | 'dark'
  onPlayNow: (song: Song) => void
  onPlayNext: (song: Song) => void
  onToggleFavorite: (song: Song, liked: boolean) => void
  onAddToFavorites: (song: Song) => void
  onRemoveFromFavorites: (song: Song) => void
  onAddToPlaylist: (song: Song, playlistId: string) => void
  onViewComments: (song: Song) => void
  onViewAlbum: (song: Song) => void
  onViewArtist: (song: Song) => void
  onCopyInfo: (song: Song) => void
  onContextMenuOpen?: () => void
}

const LONG_PRESS_MS = 1500
const DIRECTION_THRESHOLD = 38

export default function PlaybackRadialMenu({
  song,
  accentColor,
  liked,
  userPlaylists,
  playerTheme = 'dark',
  onPlayNow,
  onPlayNext,
  onToggleFavorite,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onViewAlbum,
  onViewArtist,
  onCopyInfo,
  onContextMenuOpen,
}: PlaybackRadialMenuProps) {
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0 })
  const [radialCenter, setRadialCenter] = useState<{ x: number; y: number } | null>(null)
  const [selectedDirection, setSelectedDirection] = useState<RadialDirection | null>(null)
  const originRef = useRef({ x: 0, y: 0 })
  const selectedDirectionRef = useRef<RadialDirection | null>(null)
  const trackingRef = useRef(false)
  const radialVisibleRef = useRef(false)
  const longPressTimerRef = useRef<number | null>(null)
  const songRef = useRef(song)
  const likedRef = useRef(liked)
  const contextMenuOpenRef = useRef(onContextMenuOpen)
  const actionsRef = useRef({ onToggleFavorite, onViewComments, onViewAlbum, onViewArtist })
  songRef.current = song
  likedRef.current = liked
  contextMenuOpenRef.current = onContextMenuOpen
  actionsRef.current = { onToggleFavorite, onViewComments, onViewAlbum, onViewArtist }

  useEffect(() => {
    const clearLongPressTimer = () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }

    const resetGesture = () => {
      clearLongPressTimer()
      trackingRef.current = false
      radialVisibleRef.current = false
      selectedDirectionRef.current = null
      setSelectedDirection(null)
      setRadialCenter(null)
    }

    const isPlaybackPageTarget = (target: EventTarget | null) => (
      target instanceof Element && Boolean(target.closest('[data-waveforge-playback-page="true"]'))
    )

    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || !isPlaybackPageTarget(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-song-context-menu="true"]')) return

      event.preventDefault()
      clearLongPressTimer()
      setContextMenu(previous => ({ ...previous, show: false }))
      // 先复位上一轮手势残留（径向盘/方向）：mouseup 若未在文档内发生（如按住拖出窗外），
      // resetGesture 不会执行，这里重开手势前先清掉，避免径向盘滞留
      resetGesture()
      trackingRef.current = true
      radialVisibleRef.current = false
      originRef.current = { x: event.clientX, y: event.clientY }
      selectedDirectionRef.current = null
      setSelectedDirection(null)

      longPressTimerRef.current = window.setTimeout(() => {
        if (!trackingRef.current) return
        radialVisibleRef.current = true
        setRadialCenter({ ...originRef.current })
        longPressTimerRef.current = null
      }, LONG_PRESS_MS)
    }

    const handleMouseMove = (event: MouseEvent) => {
      if (!trackingRef.current || !radialVisibleRef.current) return
      const deltaX = event.clientX - originRef.current.x
      const deltaY = event.clientY - originRef.current.y
      const distance = Math.hypot(deltaX, deltaY)
      let direction: RadialDirection | null = null

      if (distance >= DIRECTION_THRESHOLD) {
        const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI
        const octant = Math.round((angle + 180) / 45) % 8
        const directions: RadialDirection[] = ['left', 'up-left', 'up', 'up-right', 'right', 'down-right', 'down', 'down-left']
        direction = directions[octant]
      }

      if (direction !== selectedDirectionRef.current) {
        selectedDirectionRef.current = direction
        setSelectedDirection(direction)
      }
    }

    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 2 || !trackingRef.current) return
      event.preventDefault()
      const wasRadialGesture = radialVisibleRef.current
      const direction = selectedDirectionRef.current

      if (wasRadialGesture) {
        const currentSong = songRef.current
        if (direction === 'up') actionsRef.current.onToggleFavorite(currentSong, likedRef.current)
        else if (direction === 'down' && getPlatformCapabilities(currentSong.platform || 'netease').comments) actionsRef.current.onViewComments(currentSong)
        else if (direction === 'left') actionsRef.current.onViewArtist(currentSong)
        else if (direction === 'right') actionsRef.current.onViewAlbum(currentSong)
        else if (direction === 'up-left') {
          window.dispatchEvent(new CustomEvent('waveforge:show-song-detail', { detail: currentSong }))
        }
        resetGesture()
        return
      }

      clearLongPressTimer()
      trackingRef.current = false
      setContextMenu({ show: true, x: originRef.current.x, y: originRef.current.y })
      contextMenuOpenRef.current?.()
    }

    const handleContextMenu = (event: MouseEvent) => {
      if (!isPlaybackPageTarget(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-song-context-menu="true"]')) return
      event.preventDefault()
    }

    const handleWindowBlur = () => resetGesture()
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    window.addEventListener('blur', handleWindowBlur)

    return () => {
      clearLongPressTimer()
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('blur', handleWindowBlur)
    }
  }, [])

  const favoriteLabels = getPlatformFavoriteLabels(song.platform || 'netease')
  const supportsComments = getPlatformCapabilities(song.platform || 'netease').comments
  const options: Array<{
    direction: RadialDirection
    label: string
    Icon: typeof Heart
    className: string
  }> = [
    { direction: 'up', label: liked ? favoriteLabels.remove : favoriteLabels.add, Icon: liked ? HeartOff : Heart, className: 'left-1/2 top-3 -translate-x-1/2' },
    ...(supportsComments ? [{ direction: 'down' as const, label: '查看评论', Icon: MessageCircle, className: 'bottom-3 left-1/2 -translate-x-1/2' }] : []),
    { direction: 'left', label: '查看歌手', Icon: UserRound, className: 'left-3 top-1/2 -translate-y-1/2' },
    { direction: 'right', label: '查看专辑', Icon: Disc3, className: 'right-3 top-1/2 -translate-y-1/2' },
    { direction: 'up-left', label: '查看详情', Icon: Info, className: 'left-3 top-3' },
  ]

  return (
    <>
      <SongContextMenu
        show={contextMenu.show}
        x={contextMenu.x}
        y={contextMenu.y}
        song={song}
        onClose={() => setContextMenu(previous => ({ ...previous, show: false }))}
        onPlayNow={onPlayNow}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onViewAlbum={onViewAlbum}
        onViewArtist={onViewArtist}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists}
        platform={song.platform || 'netease'}
        playerTheme={playerTheme}
        hideFavoriteAction={liked}
      />

      <AnimatePresence>
        {radialCenter && (
          <div
            className="pointer-events-none fixed z-[10020] h-64 w-64 -translate-x-1/2 -translate-y-1/2"
            style={{ left: radialCenter.x, top: radialCenter.y }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.72, rotate: -8 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              exit={{ opacity: 0, scale: 0.82 }}
              transition={{ type: 'spring', stiffness: 360, damping: 26 }}
              className="relative h-full w-full rounded-full border border-white/15 bg-black/55 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-3xl"
            >
              <div className="absolute inset-7 rounded-full border border-white/10" />
              <div className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-white/10 shadow-inner">
                <div className="flex h-full items-center justify-center px-2 text-center text-[11px] font-medium text-white/65">
                  {selectedDirection ? '松开执行' : '拖动选择'}
                </div>
              </div>

              {options.map(({ direction, label, Icon, className }) => {
                const selected = selectedDirection === direction
                return (
                  <div key={direction} className={`absolute ${className}`}>
                    <motion.div
                      animate={{ scale: selected ? 1.12 : 1, opacity: selectedDirection && !selected ? 0.48 : 1 }}
                      className="flex min-w-20 flex-col items-center gap-1 rounded-2xl px-3 py-2 text-white"
                      style={{
                        backgroundColor: selected ? `${accentColor}42` : 'rgba(255,255,255,0.07)',
                        boxShadow: selected ? `0 0 24px ${accentColor}55, inset 0 0 0 1px ${accentColor}88` : 'inset 0 0 0 1px rgba(255,255,255,0.07)',
                      }}
                    >
                      <Icon className="h-5 w-5" style={{ color: selected ? accentColor : 'rgba(255,255,255,0.86)' }} />
                      <span className="whitespace-nowrap text-[11px] font-medium">{label}</span>
                    </motion.div>
                  </div>
                )
              })}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
