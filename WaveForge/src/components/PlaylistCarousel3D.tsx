import type { MusicPlatform } from '../services/platforms'
import { memo, useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, useMotionValue, animate } from 'framer-motion'
import { Heart, History } from 'lucide-react'
import { setTvFocus, useTvFocus } from '../tv/tvCore'
import { isTvModeActive } from '../platform'

interface Playlist {
  id: string | number
  name: string
  coverImgUrl: string
  trackCount?: number
  playCount?: number
  description?: string
  isLike?: boolean
  isRecent?: boolean
  covers?: string[]
}

interface PlaylistCarousel3DProps {
  playlists: Playlist[]
  onPlaylistSelect: (playlist: Playlist) => void
  platform: MusicPlatform
  initialFocusedIndex?: number
  /** TV 紧凑模式：卡片/间距/容器高度按比例缩小，适配遥控器桌面模式常驻显示 */
  compact?: boolean
}

const CARD_GAP = 280
const DRAG_PIXELS_PER_CARD = 150
const VISIBLE_RADIUS = 4
// TV 紧凑模式缩放系数：卡片 240→160，间距 280→186，容器 370→~247
const COMPACT_SCALE = 0.667

function PlaylistCarousel3D({ playlists, onPlaylistSelect, platform, initialFocusedIndex = 0, compact = false }: PlaylistCarousel3DProps) {
  const [focusedIndex, setFocusedIndex] = useState(initialFocusedIndex)
  const wheelTimeout = useRef<NodeJS.Timeout | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const focusedIndexRef = useRef(0)
  const pointerStartXRef = useRef(0)
  const dragStartIndexRef = useRef(0)
  const didDragRef = useRef(false)
  const pressedPlaylistIndexRef = useRef<number | null>(null)
  const progressPointerStartXRef = useRef(0)
  const isProgressDraggingRef = useRef(false)
  const dragOffsetX = useMotionValue(0)
  // 鼠标静止点击由容器 finishPointerDrag 已处理（onPlaylistSelect/navigateTo），
  // 卡片 onClick 会再次触发；用短时标志去重，遥控器合成 click（无 pointer 序列）不受影响。
  const suppressClickRef = useRef(false)
  const cardGap = compact ? CARD_GAP * COMPACT_SCALE : CARD_GAP
  const dragPixelsPerCard = compact ? DRAG_PIXELS_PER_CARD * COMPACT_SCALE : DRAG_PIXELS_PER_CARD

  const navigateTo = useCallback((requestedIndex: number) => {
    if (playlists.length === 0) return
    const currentIndex = focusedIndexRef.current
    const nextIndex = Math.max(0, Math.min(playlists.length - 1, requestedIndex))
    if (nextIndex === currentIndex) return

    dragOffsetX.stop()
    const distance = nextIndex - currentIndex
    // 邻近切换保留连续位移；大跨度跳转直接换页，避免跨越数百张卡片。
    dragOffsetX.set(Math.abs(distance) <= VISIBLE_RADIUS ? distance * cardGap : 0)
    focusedIndexRef.current = nextIndex
    setFocusedIndex(nextIndex)
    // TV 遥控器：data-tv-arrows="horizontal" 把左右键穿透给本组件导航，
    // 但 tvCore 的焦点环不会自动跟随，这里把焦点环同步到新激活卡片
    if (isTvModeActive()) {
      requestAnimationFrame(() => {
        const card = containerRef.current?.querySelector<HTMLElement>(`[data-playlist-index="${nextIndex}"]`)
        if (card) setTvFocus(card)
      })
    }
    requestAnimationFrame(() => {
      animate(dragOffsetX, 0, { duration: 0.34, ease: [0.22, 1, 0.36, 1] })
    })
  }, [dragOffsetX, playlists.length, cardGap])

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const pressedCard = (event.target as HTMLElement).closest<HTMLElement>('[data-playlist-index]')
    const pressedIndex = pressedCard ? Number(pressedCard.dataset.playlistIndex) : Number.NaN
    pressedPlaylistIndexRef.current = Number.isInteger(pressedIndex) ? pressedIndex : null
    event.currentTarget.setPointerCapture(event.pointerId)
    dragOffsetX.stop()
    dragOffsetX.set(0)
    pointerStartXRef.current = event.clientX
    dragStartIndexRef.current = focusedIndexRef.current
    didDragRef.current = false
    isDraggingRef.current = true
    setIsDragging(true)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const rawDelta = event.clientX - pointerStartXRef.current
    if (Math.abs(rawDelta) > 9) didDragRef.current = true

    // 连续浮点索引：拖动过程中卡片实时跟随指针移动，焦点随取整自然切换，
    // 一次拖动可以连续跨过多张歌单；卡片绝对位置始终等于 (i - floatIndex) * CARD_GAP，
    // 因此焦点切换瞬间位置连续，不会出现整卡跳变/闪烁。
    const floatIndex = Math.max(0, Math.min(
      playlists.length - 1,
      dragStartIndexRef.current - rawDelta / dragPixelsPerCard
    ))
    const nextIndex = Math.round(floatIndex)
    if (focusedIndexRef.current !== nextIndex) {
      focusedIndexRef.current = nextIndex
      setFocusedIndex(nextIndex)
    }
    dragOffsetX.set((focusedIndexRef.current - floatIndex) * cardGap)
  }

  const finishPointerDrag = (event?: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const wasDrag = didDragRef.current
    const pressedIndex = pressedPlaylistIndexRef.current
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    isDraggingRef.current = false
    didDragRef.current = false
    pressedPlaylistIndexRef.current = null
    setIsDragging(false)
    dragOffsetX.stop()

    if (wasDrag) {
      // 焦点已在拖动过程中实时更新（round(floatIndex)），松手只需平滑归中。
      requestAnimationFrame(() => {
        animate(dragOffsetX, 0, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
      })
      return
    }

    requestAnimationFrame(() => {
      animate(dragOffsetX, 0, { duration: 0.36, ease: [0.22, 1, 0.36, 1] })
    })

    // Pointer capture makes the container the click target. Resolve the originally
    // pressed card here so a stationary click remains reliable after dragging support.
    if (pressedIndex !== null && playlists[pressedIndex]) {
      if (pressedIndex === focusedIndexRef.current) {
        suppressClickRef.current = true
        onPlaylistSelect(playlists[pressedIndex])
      } else {
        navigateTo(pressedIndex)
      }
    }
  }

  // 处理鼠标滚轮
  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault()
    if (wheelTimeout.current) clearTimeout(wheelTimeout.current)
    
    wheelTimeout.current = setTimeout(() => {
      const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY
      if (Math.abs(delta) > 20) {
        navigateTo(focusedIndexRef.current + (delta > 0 ? 1 : -1))
      }
    }, 70)
  }, [navigateTo])

  // TV 遥控器：当前焦点元素（keydown 穿透判定 + 外部焦点进入歌单栏自动居中）
  const tvFocus = useTvFocus()
  // 用 ref 镜像避免 keydown effect 因焦点变化反复重绑定（每次导航焦点都变）
  const tvFocusRef = useRef<HTMLElement | null>(null)
  tvFocusRef.current = tvFocus

  // 处理键盘方向键
  useEffect(() => {
    let lastTime = 0
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // TV 遥控器模式：焦点在歌单栏内时 tvCore 的 data-tv-arrows 会把左右键
      // 穿透给本组件处理（此时才 navigateTo）；焦点在歌单栏外时左右键由 tvCore
      // 空间导航接管，这里跳过，避免同一按键触发两次导航。
      const f = tvFocusRef.current
      if (isTvModeActive() && f && !containerRef.current?.contains(f)) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        
        const now = Date.now()
        if (now - lastTime < 100) return // 100ms 节流
        lastTime = now
        
        navigateTo(focusedIndexRef.current + (e.key === 'ArrowLeft' ? -1 : 1))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigateTo])

  // 添加滚轮监听
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [handleWheel])

  useEffect(() => {
    focusedIndexRef.current = initialFocusedIndex
    setFocusedIndex(initialFocusedIndex)
    dragOffsetX.set(0)
  }, [dragOffsetX, platform, initialFocusedIndex])

  useEffect(() => {
    const clampedIndex = Math.max(0, Math.min(playlists.length - 1, focusedIndexRef.current))
    focusedIndexRef.current = clampedIndex
    setFocusedIndex(clampedIndex)
  }, [playlists.length])

  // TV 遥控器：焦点从歌单栏外部（按钮组/顶部模式切换）导航进入某张卡片时，
  // 把它平滑移到舞台中央（与"点击侧边卡片只居中不打开"交互一致）。
  // navigateTo 内部会同步焦点环到居中卡片，避免这里的居中与实际焦点错位。
  useEffect(() => {
    if (!isTvModeActive()) return
    const card = tvFocus?.closest?.('[data-playlist-index]')
    if (!card) return
    const idx = Number((card as HTMLElement).dataset.playlistIndex)
    if (Number.isInteger(idx) && idx !== focusedIndexRef.current) {
      navigateTo(idx)
    }
  }, [tvFocus, navigateTo])

  useEffect(() => () => {
    if (wheelTimeout.current) clearTimeout(wheelTimeout.current)
    dragOffsetX.stop()
  }, [dragOffsetX])

  const visiblePlaylists = useMemo(() => {
    const start = Math.max(0, focusedIndex - VISIBLE_RADIUS)
    const end = Math.min(playlists.length, focusedIndex + VISIBLE_RADIUS + 1)
    return playlists.slice(start, end).map((playlist, offset) => ({
      playlist,
      index: start + offset,
    }))
  }, [focusedIndex, playlists])

  if (playlists.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-white/40 text-sm">暂无歌单</p>
      </div>
    )
  }

  const handleProgressClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (Math.abs(event.clientX - progressPointerStartXRef.current) > 5) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    navigateTo(Math.round(ratio * Math.max(0, playlists.length - 1)))
  }

  return (
    <div 
      ref={containerRef}
      className="group relative flex items-center justify-center overflow-hidden pb-12"
      data-tv-arrows="horizontal"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointerDrag}
      onPointerCancel={finishPointerDrag}
      style={{ 
        perspective: '1200px',
        cursor: isDragging ? 'grabbing' : 'grab',
        userSelect: 'none',
        height: compact ? `${Math.round(370 * COMPACT_SCALE)}px` : '370px',
        paddingBottom: compact ? `${Math.round(48 * COMPACT_SCALE)}px` : '48px',
        transform: 'translate3d(0, 0, 0)',
        isolation: 'isolate',
        contain: 'layout paint style',
        touchAction: 'pan-y',
      }}
    >
      {/* 固定窗口只渲染当前歌单前后少量卡片，歌单数量不再影响拖拽性能。 */}
      <motion.div className="absolute inset-x-0 bottom-16 top-0 flex items-center justify-center" style={{ x: dragOffsetX, willChange: 'transform' }}>
      {visiblePlaylists.map(({ playlist, index: i }) => {
        const distance = i - focusedIndex
        const isActive = distance === 0
        
        // 计算位置和状态
        const scale = isActive ? 1.1 : 1 - Math.abs(distance) * 0.15
        const opacity = isActive ? 1 : Math.max(0.3, 0.6 - Math.abs(distance) * 0.15)
        const xOffset = distance * cardGap // 卡片间距随紧凑模式缩放
        const zIndex = 10 - Math.abs(distance)
        const rotateY = distance > 0 ? -15 : distance < 0 ? 15 : 0 // Y轴旋转

        return (
          <PlaylistCard
            key={playlist.id || `playlist-${i}`}
            index={i}
            playlist={playlist}
            platform={platform}
            isActive={isActive}
            scale={scale}
            opacity={opacity}
            xOffset={xOffset}
            zIndex={zIndex}
            rotateY={rotateY}
            compact={compact}
            onKeyboardActivate={() => {
              // 鼠标静止点击已由容器处理（suppressClickRef），跳过避免重复打开；
              // 遥控器 OK 合成的 click 没有 pointer 序列，正常走这里
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              if (isActive) {
                onPlaylistSelect(playlist)
              } else {
                // 点击任意侧边卡片时，只将它平滑移动到舞台中央，不直接打开详情。
                navigateTo(i)
              }
            }}
          />
        )
      })}
      </motion.div>

      {/* 固定复杂度的页码与进度条，替代按歌单数量生成的圆点。 */}
      <div className="absolute bottom-1 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/10 bg-black/30 px-3 py-2">
        <span className="min-w-[4.8rem] text-center text-[11px] font-medium tabular-nums text-white/62">
          {focusedIndex + 1} / {playlists.length}
        </span>
        <button
          type="button"
          onPointerDown={event => {
            progressPointerStartXRef.current = event.clientX
            isProgressDraggingRef.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            event.stopPropagation()
          }}
          onPointerMove={event => {
            if (!isProgressDraggingRef.current) return
            const bounds = event.currentTarget.getBoundingClientRect()
            const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
            navigateTo(Math.round(ratio * Math.max(0, playlists.length - 1)))
          }}
          onPointerUp={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            isProgressDraggingRef.current = false
          }}
          onPointerCancel={event => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            isProgressDraggingRef.current = false
          }}
          onClick={handleProgressClick}
          className="relative h-1.5 w-44 overflow-hidden rounded-full bg-white/18"
          role="slider"
          aria-valuemin={1}
          aria-valuemax={playlists.length}
          aria-valuenow={focusedIndex + 1}
          aria-label={`当前第 ${focusedIndex + 1} 个歌单，共 ${playlists.length} 个`}
        >
          <motion.span
            className="absolute inset-y-0 w-7 rounded-full bg-white/90"
            animate={{
              left: playlists.length <= 1
                ? '0px'
                : `calc(${(focusedIndex / (playlists.length - 1)) * 100}% - ${(focusedIndex / (playlists.length - 1)) * 28}px)`,
            }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          />
        </button>
      </div>

      {/* 箭头使用纯 CSS 显隐，不再在每次鼠标移动时触发 React 重渲染。 */}
      {focusedIndex > 0 && (
        <button
          type="button"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => navigateTo(focusedIndex - 1)}
          className="absolute left-4 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 opacity-0 transition-[opacity,background-color] hover:bg-black/45 group-hover:opacity-100"
        >
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}
      {focusedIndex < playlists.length - 1 && (
        <button
          type="button"
          onPointerDown={event => event.stopPropagation()}
          onClick={() => navigateTo(focusedIndex + 1)}
          className="absolute right-4 top-1/2 z-20 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/30 opacity-0 transition-[opacity,background-color] hover:bg-black/45 group-hover:opacity-100"
        >
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  )
}

// 单个歌单卡片组件
interface PlaylistCardProps {
  playlist: Playlist
  platform: MusicPlatform
  index: number
  isActive: boolean
  scale: number
  opacity: number
  xOffset: number
  zIndex: number
  rotateY: number
  onKeyboardActivate: () => void
  compact?: boolean
}

const PlaylistCard = memo(function PlaylistCard({ playlist, platform, index, isActive, scale, opacity, xOffset, zIndex, rotateY, onKeyboardActivate, compact = false }: PlaylistCardProps) {
  const cardSize = compact ? Math.round(240 * COMPACT_SCALE) : 240
  return (
    <motion.div
      data-playlist-index={index}
      initial={false}
      animate={{
        scale: scale,
        opacity: opacity,
        rotateY: rotateY,
      }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      role="button"
      tabIndex={isActive ? 0 : -1}
      aria-label={playlist.name}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onKeyboardActivate()
        }
      }}
      className="absolute cursor-pointer rounded-[18px] shadow-[0_18px_48px_rgba(0,0,0,0.24)]"
      style={{
        x: xOffset,
        zIndex,
        width: `${cardSize}px`,
        height: `${cardSize}px`,
        transformStyle: 'preserve-3d',
        willChange: 'transform, opacity',
      }}
      onClick={() => onKeyboardActivate()}
    >
      <motion.div
        className="relative isolate h-full w-full overflow-hidden rounded-[18px]"
        style={{
          clipPath: 'inset(0 round 18px)',
          WebkitClipPath: 'inset(0 round 18px)',
          backgroundColor: 'transparent',
        }}
        whileHover={isActive ? { scale: 1.05 } : {}}
        whileTap={{ scale: 0.98 }}
      >
        {/* 封面图片：最近播放使用 2x2 封面宫格，与简约模式一致 */}
        {playlist.isRecent ? (
          <div className="grid h-full w-full grid-cols-2 grid-rows-2">
            {Array.from({ length: 4 }).map((_, coverIndex) => {
              const cover = playlist.covers?.[coverIndex]
              return cover ? (
                <img key={coverIndex} src={cover} alt="" className="h-full w-full object-cover" draggable={false} />
              ) : (
                <div key={coverIndex} className="flex h-full w-full items-center justify-center bg-white/10">
                  <History className="h-6 w-6 text-white/30" />
                </div>
              )
            })}
          </div>
        ) : (
          <img
            src={playlist.coverImgUrl}
            alt={playlist.name}
            className="block h-full w-full rounded-[18px] object-cover"
            loading={isActive ? 'eager' : 'lazy'}
            decoding="async"
            draggable={false}
          />
        )}

        {platform === 'qq' && playlist.isLike && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
            <Heart
              className="h-[42%] w-[42%] fill-white/75 text-white/75"
              strokeWidth={0}
              style={{ filter: 'drop-shadow(0 4px 14px rgba(0, 0, 0, 0.28)) blur(0.7px)' }}
            />
          </div>
        )}
        
        {/* 渐变遮罩 */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] rounded-b-[18px]"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0.24) 54%, transparent)' }}
        />
        
        {/* 歌单信息 */}
        <div className={`absolute bottom-0 left-0 right-0 ${compact ? 'p-2' : 'p-4'}`}>
          <h3 className={`text-white font-bold line-clamp-2 mb-1 ${compact ? 'text-xs' : 'text-base'}`}>
            {playlist.name}
          </h3>
          {playlist.trackCount !== undefined && (
            <p className={`text-white/70 ${compact ? 'text-[10px]' : 'text-xs'}`}>
              {playlist.trackCount} 首歌曲
            </p>
          )}
        </div>

        {/* 激活状态指示 */}
        {isActive && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="pointer-events-none absolute inset-0 rounded-[18px] border-4 border-white/50"
          />
        )}
      </motion.div>
    </motion.div>
  )
})

export default memo(PlaylistCarousel3D)
