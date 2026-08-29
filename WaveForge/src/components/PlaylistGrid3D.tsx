import type { MusicPlatform } from '../services/platforms'
import { useState, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { motion } from 'framer-motion'
import { Play, Clock } from 'lucide-react'
import { Song, resolveSongAlbumIdentifier } from '../services/musicApi'
import { debugLog } from '../utils/debugLog'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import SongContextMenu from './SongContextMenu'
import DeleteSongModal from './DeleteSongModal'

// 3D网格歌单视图组件 - 简化版本，移除拖拽功能
interface PlaylistGrid3DProps {
  songs: Song[]
  loading: boolean
  onPlaySong: (song: Song, queue: Song[]) => void
  formatDuration: (ms: number) => string
  platform: MusicPlatform
  neteaseVip: boolean
  qqVip: boolean
  currentSong?: Song | null
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onRemoveFromPlaylist?: (song: Song) => void | Promise<unknown>
  onViewComments?: (song: Song) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onCopyInfo?: (song: Song) => void
  userPlaylists?: any[]
  currentPlaylistId?: string
  isCurrentPlaylistLiked?: boolean
}

// 单个歌曲卡片组件
interface SongCardProps {
  song: Song
  index: number
  onPlay: () => void
  onPlayNext: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void
  formatDuration: (ms: number) => string
  cardWidth: number
  cardHeight: number
  isVip: boolean
  isCurrentSong: boolean
}

const SongCard = ({ song, onPlay, onPlayNext, onContextMenu, formatDuration, cardWidth, cardHeight, isVip, isCurrentSong }: SongCardProps) => {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <motion.div
      className="group"
      style={{
        width: cardWidth,
        minHeight: cardHeight,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={onPlay}
      onContextMenu={onContextMenu}
      whileHover={{ scale: 1.05 }}
      transition={{ duration: 0.2 }}
    >
      <div
        className="rounded-xl p-3 flex flex-col items-center border transition-all duration-300 shadow-lg hover:shadow-2xl cursor-pointer relative h-full"
        style={{
          backgroundColor: isCurrentSong ? 'rgba(236, 72, 153, 0.15)' : 'rgba(255, 255, 255, 0.05)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderColor: isCurrentSong 
            ? 'rgba(236, 72, 153, 0.5)' 
            : (isHovered ? 'rgba(255, 255, 255, 0.3)' : 'rgba(255, 255, 255, 0.1)'),
          boxShadow: isCurrentSong ? '0 0 20px rgba(236, 72, 153, 0.3)' : undefined,
        }}
      >
        {/* 封面区域 */}
        <div className="w-full aspect-square rounded-lg overflow-hidden bg-zinc-800/60 relative shadow-inner flex items-center justify-center shrink-0 mb-3">
          {song.album?.picUrl ? (
            <img
              src={song.album.picUrl}
              alt={song.name}
              className="w-full h-full object-cover"
              loading="lazy"
              draggable="false"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-zinc-700 to-zinc-900 flex items-center justify-center">
              <Play className="w-12 h-12 text-white/20" />
            </div>
          )}

          {/* VIP 标签 - 只对非VIP用户显示 */}
          {(song.vip || song.fee === 1 || song.fee === 4) && !isVip && (
            <div className="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-yellow-500/90 text-yellow-900 text-xs font-bold backdrop-blur-sm">
              VIP
            </div>
          )}
        </div>

        {/* 歌曲信息 */}
        <div className="w-full flex-1 flex flex-col min-h-0">
          <h3 className={`font-medium text-sm line-clamp-2 mb-1 leading-tight transition-colors ${
            isCurrentSong ? 'text-pink-400' : 'text-white'
          }`}>
            {song.name}
          </h3>
          <p className={`text-xs line-clamp-1 mb-2 transition-colors ${
            isCurrentSong ? 'text-pink-300/70' : 'text-white/60'
          }`}>
            {song.artists?.map(a => a.name).join(', ') || '未知艺术家'}
          </p>

          {/* 底部信息 */}
          <div className="flex items-center justify-between text-xs text-white/50 mt-auto">
            <div className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>{formatDuration(song.duration)}</span>
            </div>
          </div>
        </div>

        {/* 下一曲播放按钮 */}
        <motion.button
          onClick={(e) => {
            e.stopPropagation()
            onPlayNext()
          }}
          className="absolute bottom-3 right-3 w-8 h-8 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 hover:from-pink-600 hover:to-purple-700 flex items-center justify-center shadow-lg transition-all opacity-0 group-hover:opacity-100"
          title="下一曲播放"
        >
          <svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6 4v16l12-8z M18 4h2v16h-2z" />
          </svg>
        </motion.button>
      </div>
    </motion.div>
  )
}

export default function PlaylistGrid3D({
  songs,
  loading,
  onPlaySong,
  formatDuration,
  platform,
  neteaseVip,
  qqVip,
  currentSong,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onViewComments,
  onOpenAlbum,
  onOpenArtist,
  onCopyInfo,
  userPlaylists = [],
  currentPlaylistId,
  isCurrentPlaylistLiked = false,
}: PlaylistGrid3DProps) {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 1000, height: 600 }) // 使用更合理的默认值
  const [scrollTop, setScrollTop] = useState(0)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [contextMenu, setContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    song: Song | null
  }>({ show: false, x: 0, y: 0, song: null })
  const [pendingRemoval, setPendingRemoval] = useState<{
    song: Song
    fromFavorites: boolean
  } | null>(null)
  const [removalLoading, setRemovalLoading] = useState(false)

  const closeContextMenu = () => setContextMenu({ show: false, x: 0, y: 0, song: null })

  // 根据平台判断用户是否是VIP
  const isVip = platform === 'netease' ? neteaseVip : qqVip
  
  // 判断歌曲是否为当前播放的歌曲
  const isSongCurrent = (song: Song) => {
    if (!currentSong) return false
    return currentSong.id === song.id && currentSong.platform === song.platform
  }
  
  // 计算当前播放歌曲在列表中的索引
  const currentSongIndex = songs.findIndex(song => isSongCurrent(song))
  
  // 调试日志
  useEffect(() => {
    debugLog(`🎵 [PlaylistGrid3D] 接收到 ${songs.length} 首歌曲`)
    debugLog(`📐 [PlaylistGrid3D] 容器尺寸: ${containerSize.width}x${containerSize.height}`)
  }, [songs.length, containerSize])

  // 从 localStorage 读取卡片大小设置
  const getCardSize = () => {
    const size = localStorage.getItem('desktopPlaylistCardSize') || 'medium'
    const sizeMap = {
      small: { width: 160, height: 260 },
      medium: { width: 200, height: 300 },
      large: { width: 240, height: 340 },
    }
    return sizeMap[size as keyof typeof sizeMap] || sizeMap.medium
  }

  const cardSize = getCardSize()
  const CARD_WIDTH = cardSize.width
  const CARD_HEIGHT = cardSize.height
  const CARD_GAP_X = 20
  const CARD_GAP_Y = 20

  // 监听容器尺寸
  useEffect(() => {
    if (!containerElement) return
    
    const updateSize = () => {
      if (containerElement) {
        const newSize = {
          width: containerElement.clientWidth,
          height: containerElement.clientHeight,
        }
        debugLog(`📏 [PlaylistGrid3D] 更新容器尺寸: ${newSize.width}x${newSize.height}`)
        setContainerSize(newSize)
      }
    }
    
    // 立即更新
    updateSize()
    
    // 延迟更新，确保 DOM 完全渲染
    setTimeout(updateSize, 100)
    setTimeout(updateSize, 300)
    
    const resizeObserver = new ResizeObserver(updateSize)
    resizeObserver.observe(containerElement)
    window.addEventListener('resize', updateSize)
    
    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [containerElement])

  // 监听 localStorage 变化，实时更新卡片大小
  useEffect(() => {
    const handleStorageChange = () => {
      // 强制重新渲染
      setContainerSize(prev => ({ ...prev }))
    }
    
    window.addEventListener('storage', handleStorageChange)
    // 也监听自定义事件（用于同一页面内的更新）
    window.addEventListener('desktopPlaylistCardSizeChanged', handleStorageChange)
    
    return () => {
      window.removeEventListener('storage', handleStorageChange)
      window.removeEventListener('desktopPlaylistCardSizeChanged', handleStorageChange)
    }
  }, [])

  // 根据容器宽度计算每行显示的卡片数
  const cardsPerRow = useMemo(() => {
    const availableWidth = containerSize.width
    const cardTotalWidth = CARD_WIDTH + CARD_GAP_X
    const maxCards = Math.floor(availableWidth / cardTotalWidth)
    const result = Math.max(2, maxCards) // 至少显示2张
    
    debugLog(`🔢 [PlaylistGrid3D] 每行卡片数计算:`, {
      容器宽度: availableWidth,
      卡片宽度: CARD_WIDTH,
      间隙: CARD_GAP_X,
      卡片总宽: cardTotalWidth,
      计算结果: maxCards,
      最终值: result
    })
    
    return result
  }, [containerSize.width, CARD_WIDTH, CARD_GAP_X])

  // 虚拟滚动计算
  const { visibleItems, totalHeight, offsetY } = useMemo(() => {
    const rowHeight = CARD_HEIGHT + CARD_GAP_Y
    const totalRows = Math.ceil(songs.length / cardsPerRow)
    const totalHeight = totalRows * rowHeight + 64 // 加上 padding

    debugLog(`📊 [PlaylistGrid3D] 虚拟滚动计算:`, {
      歌曲总数: songs.length,
      每行卡片数: cardsPerRow,
      总行数: totalRows,
      总高度: totalHeight,
      当前滚动位置: scrollTop,
      容器高度: containerSize.height,
      卡片高度: CARD_HEIGHT,
      行高: rowHeight
    })

    // 如果歌曲数量为0，返回空
    if (songs.length === 0) {
      return {
        visibleItems: [],
        totalHeight: 0,
        offsetY: 0
      }
    }

    // 计算可见区域
    const startRow = Math.floor(scrollTop / rowHeight)
    const endRow = Math.ceil((scrollTop + containerSize.height) / rowHeight)
    
    // 预加载上下各2行
    const bufferRows = 2
    const visibleStartRow = Math.max(0, startRow - bufferRows)
    const visibleEndRow = Math.min(totalRows, endRow + bufferRows)
    
    const startIndex = visibleStartRow * cardsPerRow
    const endIndex = Math.min(songs.length, visibleEndRow * cardsPerRow)
    
    debugLog(`👁️ [PlaylistGrid3D] 可见范围:`, {
      可见行范围: `${visibleStartRow} - ${visibleEndRow}`,
      可见索引范围: `${startIndex} - ${endIndex}`,
      实际渲染歌曲数: endIndex - startIndex
    })
    
    return {
      visibleItems: songs.slice(startIndex, endIndex).map((song, i) => ({
        song,
        index: startIndex + i
      })),
      totalHeight,
      offsetY: visibleStartRow * rowHeight
    }
  }, [songs, cardsPerRow, scrollTop, containerSize.height, CARD_HEIGHT, CARD_GAP_Y])

  // 监听滚动
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      debugLog('⚠️ [PlaylistGrid3D] 滚动容器未就绪，无法添加滚动监听')
      return
    }

    const handleScroll = () => {
      setScrollTop(container.scrollTop)
      debugLog(`📜 [PlaylistGrid3D] 滚动事件触发，当前位置: ${container.scrollTop}px`)
    }

    debugLog('✅ [PlaylistGrid3D] 已添加滚动监听')
    container.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      debugLog('🗑️ [PlaylistGrid3D] 移除滚动监听')
      container.removeEventListener('scroll', handleScroll)
    }
  }, [containerElement])

  const handlePlaySong = (song: Song) => {
    onPlaySong(song, songs)
  }

  const handlePlayNext = (song: Song) => {
    if (onPlayNext) {
      onPlayNext(song)
      return
    }
    // 兼容旧版桌面模式的事件通道。
    const event = new CustomEvent('addToPlayNext', { detail: song })
    window.dispatchEvent(event)
  }

  const handleContextMenu = (event: ReactMouseEvent<HTMLDivElement>, song: Song) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({ show: true, x: event.clientX, y: event.clientY, song })
  }

  const handleConfirmRemoval = async () => {
    if (!pendingRemoval) return
    setRemovalLoading(true)
    try {
      if (pendingRemoval.fromFavorites) {
        await onRemoveFromFavorites?.(pendingRemoval.song)
      } else {
        await onRemoveFromPlaylist?.(pendingRemoval.song)
      }
      setPendingRemoval(null)
    } finally {
      setRemovalLoading(false)
    }
  }

  if (loading) {
    return (
      <div key="playlist-loading" className="flex flex-1 items-center justify-center overflow-hidden">
        <div className="flex flex-col items-center gap-4">
          <div className="flex h-10 items-center gap-2" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="block h-8 w-2 animate-pulse rounded-full bg-gradient-to-t from-white/80 to-white/30 [animation-duration:900ms]"
                style={{
                  animationDelay: `${i * 140}ms`,
                }}
              />
            ))}
          </div>
          <p className="text-white/60 text-sm">加载歌曲中...</p>
        </div>
      </div>
    )
  }

  if (songs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-white/60">暂无歌曲</p>
      </div>
    )
  }

  return (
    <>
      <div
        key="playlist-grid"
        ref={(el) => {
          setContainerElement(el)
          scrollContainerRef.current = el
          if (el) {
            debugLog(`📦 [PlaylistGrid3D] 容器元素已设置:`, {
              实际宽度: el.clientWidth,
              实际高度: el.clientHeight,
              滚动高度: el.scrollHeight,
              offsetWidth: el.offsetWidth,
              scrollWidth: el.scrollWidth
            })
          }
        }}
        className="flex-1 relative overflow-y-auto overflow-x-hidden"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent',
        }}
      >
        <div style={{ height: totalHeight, position: 'relative', width: '100%' }}>
          <div
            className="grid gap-5 p-8"
            style={{
              gridTemplateColumns: `repeat(${cardsPerRow}, ${CARD_WIDTH}px)`,
              justifyContent: 'center',
              position: 'absolute',
              top: offsetY,
              left: 0,
              right: 0,
              width: '100%',
            }}
          >
              {visibleItems.map(({ song, index }) => (
                <div key={song.id} data-song-index={index}>
                  <SongCard
                    song={song}
                    index={index}
                    onPlay={() => handlePlaySong(song)}
                    onPlayNext={() => handlePlayNext(song)}
                    onContextMenu={(event) => handleContextMenu(event, song)}
                    formatDuration={formatDuration}
                    cardWidth={CARD_WIDTH}
                    cardHeight={CARD_HEIGHT}
                    isVip={isVip}
                    isCurrentSong={isSongCurrent(song)}
                  />
                </div>
            ))}
          </div>
        </div>
      </div>
      
      {/* 回到顶部按钮 - 右下角 */}
      <ScrollToTop 
        containerRef={scrollContainerRef} 
        threshold={200}
        playerTheme="dark"
        position="fixed"
        offsetRight={24}
        offsetBottom={24}
      />
      
      {/* 定位到当前歌曲按钮 - 回到顶部按钮上方 */}
      <ScrollToCurrentSong
        containerRef={scrollContainerRef}
        currentSongIndex={currentSongIndex}
        threshold={200}
        playerTheme="dark"
        position="fixed"
        offsetRight={24}
        offsetBottom={88}
        cardsPerRow={cardsPerRow}
        cardHeight={CARD_HEIGHT}
        cardGapY={CARD_GAP_Y}
      />

      {contextMenu.song && (
        <SongContextMenu
          show={contextMenu.show}
          x={contextMenu.x}
          y={contextMenu.y}
          song={contextMenu.song}
          onClose={closeContextMenu}
          onPlayNow={(song) => {
            handlePlaySong(song)
            closeContextMenu()
          }}
          onPlayNext={(song) => {
            handlePlayNext(song)
            closeContextMenu()
          }}
          onAddToFavorites={onAddToFavorites ? (song) => {
            onAddToFavorites(song)
            closeContextMenu()
          } : undefined}
          onRemoveFromFavorites={onRemoveFromFavorites ? (song) => {
            if (isCurrentPlaylistLiked) {
              setPendingRemoval({ song, fromFavorites: true })
            } else {
              void onRemoveFromFavorites(song)
            }
            closeContextMenu()
          } : undefined}
          onAddToPlaylist={onAddToPlaylist ? (song, playlistId) => {
            onAddToPlaylist(song, playlistId)
            closeContextMenu()
          } : undefined}
          onRemoveFromPlaylist={onRemoveFromPlaylist ? (song) => {
            setPendingRemoval({ song, fromFavorites: false })
            closeContextMenu()
          } : undefined}
          onViewComments={onViewComments ? (song) => {
            onViewComments(song)
            closeContextMenu()
          } : undefined}
          onViewAlbum={onOpenAlbum ? async (song) => {
            const songPlatform = (song.platform || platform) as 'netease' | 'qq'
            const albumId = await resolveSongAlbumIdentifier(song, songPlatform)
            if (albumId) onOpenAlbum(albumId, songPlatform)
            closeContextMenu()
          } : undefined}
          onViewArtist={onOpenArtist ? (song) => {
            const songPlatform = (song.platform || platform) as MusicPlatform
            const artist = song.artists?.[0]
            // 汽水无艺人 ID，约定传歌手名
            const artistId = songPlatform === 'soda' ? (artist?.name || artist?.id)
              : songPlatform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
            if (artistId) onOpenArtist(String(artistId), songPlatform)
            closeContextMenu()
          } : undefined}
          onCopyInfo={onCopyInfo ? (song) => {
            onCopyInfo(song)
            closeContextMenu()
          } : undefined}
          userPlaylists={userPlaylists}
          platform={platform}
          hideFavoriteAction={isCurrentPlaylistLiked}
          currentPlaylistId={currentPlaylistId}
        />
      )}

      <DeleteSongModal
        show={Boolean(pendingRemoval)}
        songName={pendingRemoval?.song.name || ''}
        fromFavorites={pendingRemoval?.fromFavorites}
        loading={removalLoading}
        onClose={() => {
          if (!removalLoading) setPendingRemoval(null)
        }}
        onConfirm={() => { void handleConfirmRemoval() }}
      />
    </>
  )
}
