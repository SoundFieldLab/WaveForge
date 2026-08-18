import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Music, Play, Clock, Crown, Heart, Info, Radio } from 'lucide-react'
import { Song, getProxiedImageUrl, resolveSongAlbumIdentifier } from '../services/musicApi'
import { getPlatformCapabilities } from '../services/platforms'
import type { MusicPlatform } from '../services/platforms'
import { subscribePlaylist } from '../services/playlistService'
import { useState, useRef, useEffect, useCallback, useMemo, memo, type UIEvent } from 'react'
import CachedImage from './CachedImage'
import { imageCache } from '../utils/imageCache'
import SongContextMenu from './SongContextMenu'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import CommentModal from './CommentModal'
import DeleteSongModal from './DeleteSongModal'
import { useTvBack } from '../tv/tvCore'

const DETAIL_ROW_HEIGHT = 60
const DETAIL_CARD_HEIGHT = 56
const DETAIL_OVERSCAN = 8

interface PlaylistDetailPanelProps {
  show: boolean
  overlayZ?: number // 弹窗层级（默认 40/50；跨弹窗打开时传更高值置于其上）
  playlist: {
    id: number | string
    dirId?: number | string
    name: string
    coverImgUrl: string
    trackCount: number
    description?: string
    desc?: string
    creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
    tags?: string[]
    createTime?: number
    commentCount?: number
    platform?: MusicPlatform
    userId?: number | string
    isLike?: boolean
    isCollected?: boolean
  } | null
  songs: Song[]
  loading: boolean
  onClose: () => void
  onSongSelect: (song: Song, playlist: Song[]) => void
  neteaseVip?: boolean
  qqVip?: boolean
  currentPlatform?: MusicPlatform
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onRemoveFromPlaylist?: (song: Song, playlistId: string) => void | Promise<void>
  onRemoveFromFavorites?: (song: Song) => unknown
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  userPlaylists?: any[]
  currentSong?: Song | null
  playerTheme?: 'light' | 'dark'
  accentColor?: string
}

function PlaylistDetailPanel({
  show,
  overlayZ,
  playlist,
  songs,
  loading,
  onClose,
  onSongSelect,
  neteaseVip = false,
  qqVip = false,
  currentPlatform = 'netease',
  onOpenArtist,
  onOpenAlbum,
  onPlayNext,
  onAddToFavorites,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onRemoveFromFavorites,
  onViewComments,
  onCopyInfo,
  userPlaylists = [],
  currentSong = null,
  playerTheme = 'dark',
  accentColor = '#ec4899'
}: PlaylistDetailPanelProps) {
  // TV 遥控器 BACK：关闭歌单详情面板
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const isVip = currentPlatform === 'netease' ? neteaseVip : qqVip
  const [heightVh, setHeightVh] = useState(80) // 从80vh开始，最大90vh
  const [subscribing, setSubscribing] = useState(false)
  const [collected, setCollected] = useState(Boolean(playlist?.isCollected))
  const [smartLoading, setSmartLoading] = useState(false)

  // 网易云智能播放（playmode/intelligence）：按当前歌单/歌曲生成智能续播列表
  const handleSmartPlay = async () => {
    if (!playlist || songs.length === 0 || smartLoading) return
    const cookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
    if (!cookie) return
    setSmartLoading(true)
    try {
      const res = await fetch(
        `http://localhost:3001/api/netease/playmode/intelligence/list?cookie=${encodeURIComponent(cookie)}&id=${encodeURIComponent(String(songs[0].id))}&pid=${encodeURIComponent(String(playlist.id))}`
      )
      const data = await res.json()
      const raw = Array.isArray(data?.data) ? data.data : []
      const smartSongs: Song[] = raw.map((s: any) => ({
        id: s.id,
        name: s.name || '',
        artists: Array.isArray(s.ar) ? s.ar.map((a: any) => ({ id: a.id, name: a.name })) : [],
        album: s.al ? { name: s.al.name, picUrl: s.al.picUrl || '' } : { name: '', picUrl: '' },
        duration: s.dt || 0,
        platform: 'netease'
      })).filter((s: Song) => s.id)
      if (smartSongs.length > 0) onSongSelect(smartSongs[0], smartSongs)
    } catch {
      /* 智能播放失败静默 */
    } finally {
      setSmartLoading(false)
    }
  }
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const [imagesLoaded, setImagesLoaded] = useState(false)
  const [loadedImageCount, setLoadedImageCount] = useState(0)
  const [showPlaylistInfo, setShowPlaylistInfo] = useState(false)
  const [pendingRemoval, setPendingRemoval] = useState<{
    song: Song
    fromFavorites: boolean
  } | null>(null)
  const [removalLoading, setRemovalLoading] = useState(false)
  const viewportFrameRef = useRef<number | null>(null)
  const pendingViewportRef = useRef({ scrollTop: 0, height: 0 })
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  // 高度渐变同样走 rAF 合并：滚动高频触发时同一帧只提交一次 setState
  const heightFrameRef = useRef<number | null>(null)
  const pendingHeightRef = useRef(80)

  // 同步收藏状态（切换歌单时刷新）
  useEffect(() => {
    setCollected(Boolean(playlist?.isCollected))
  }, [playlist?.id, playlist?.isCollected])

  const handleSubscribe = async () => {
    if (!playlist || subscribing) return
    setSubscribing(true)
    try {
      const next = !collected
      const platform = playlist.platform || currentPlatform
      const result = await subscribePlaylist(String(playlist.id), next, platform)
      // 后端成功响应可能带 message（如 QQ 的「已收藏歌单」），不能把 message 当错误
      if (result && (result.error || result.errMsg)) {
        throw new Error(result.error || result.errMsg)
      }
      if (result && result.result != null && result.result !== 100 && result.result !== 0) {
        throw new Error('收藏操作失败，请重试')
      }
      setCollected(next)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: next ? '已收藏歌单' : '已取消收藏', type: 'success' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '收藏操作失败，请重试', type: 'error' } }))
    } finally {
      setSubscribing(false)
    }
  }
  
  // 右键菜单相关状态
  const [contextMenu, setContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    song: Song | null
  }>({
    show: false,
    x: 0,
    y: 0,
    song: null
  })
  
  // 判断歌曲是否为当前播放的歌曲
  const isSongCurrent = (song: Song) => {
    if (!currentSong) return false
    return currentSong.id === song.id && currentSong.platform === song.platform
  }
  
  // 计算当前播放歌曲在列表中的索引
  const currentSongIndex = useMemo(() => {
    if (!currentSong) return -1
    return songs.findIndex(song => song.id === currentSong.id && song.platform === currentSong.platform)
  }, [currentSong, songs])
  const totalDurationMinutes = useMemo(
    () => Math.floor(songs.reduce((total, song) => total + song.duration, 0) / 60000),
    [songs]
  )

  const commitViewport = useCallback((scrollTop: number, height: number) => {
    pendingViewportRef.current = { scrollTop, height }
    if (viewportFrameRef.current !== null) return
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null
      setViewport(pendingViewportRef.current)
    })
  }, [])

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget
    commitViewport(container.scrollTop, container.clientHeight)
  }

  const viewportHeight = viewport.height || (typeof window === 'undefined' ? 640 : Math.max(320, window.innerHeight * 0.7))
  const visibleStart = Math.max(0, Math.floor(viewport.scrollTop / DETAIL_ROW_HEIGHT) - DETAIL_OVERSCAN)
  const visibleEnd = Math.min(
    songs.length,
    Math.ceil((viewport.scrollTop + viewportHeight) / DETAIL_ROW_HEIGHT) + DETAIL_OVERSCAN
  )
  const visibleSongs = useMemo(
    () => songs.slice(visibleStart, visibleEnd).map((song, offset) => ({ song, index: visibleStart + offset })),
    [songs, visibleStart, visibleEnd]
  )
  const virtualListHeight = songs.length * DETAIL_ROW_HEIGHT

  const handleConfirmRemoval = async () => {
    if (!pendingRemoval || !playlist) return
    setRemovalLoading(true)
    try {
      if (pendingRemoval.fromFavorites) {
        await onRemoveFromFavorites?.(pendingRemoval.song)
      } else {
        await onRemoveFromPlaylist?.(
          pendingRemoval.song,
          String(playlist.dirId || playlist.id)
        )
      }
      setPendingRemoval(null)
    } finally {
      setRemovalLoading(false)
    }
  }
  
  // 监听滚动事件 - 渐进式调整高度
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    
    const handleScroll = () => {
      const scrollTop = container.scrollTop
      
      // 根据滚动位置计算高度：0px -> 80vh, 30px -> 90vh
      const maxScroll = 30 // 只需滚动30px就达到最大高度
      const minHeight = 80
      const maxHeight = 90
      
      let newHeight: number
      if (scrollTop <= 0) {
        newHeight = minHeight
      } else if (scrollTop >= maxScroll) {
        newHeight = maxHeight
      } else {
        // 使用线性映射
        const progress = scrollTop / maxScroll
        newHeight = minHeight + (maxHeight - minHeight) * progress
      }
      
      // rAF 合并：同一帧内多次 scroll 只提交一次 setHeightVh
      pendingHeightRef.current = newHeight
      if (heightFrameRef.current !== null) return
      heightFrameRef.current = window.requestAnimationFrame(() => {
        heightFrameRef.current = null
        setHeightVh(pendingHeightRef.current)
      })
    }
    
    container.addEventListener('scroll', handleScroll, { passive: true })
    
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (heightFrameRef.current !== null) {
        window.cancelAnimationFrame(heightFrameRef.current)
        heightFrameRef.current = null
      }
    }
  }, [show])

  useEffect(() => {
    if (!show) {
      setViewport({ scrollTop: 0, height: 0 })
      return
    }
    const container = scrollContainerRef.current
    if (!container) return
    commitViewport(container.scrollTop, container.clientHeight)
    const observer = new ResizeObserver(() => commitViewport(container.scrollTop, container.clientHeight))
    observer.observe(container)
    return () => observer.disconnect()
  }, [commitViewport, show])

  useEffect(() => () => {
    if (viewportFrameRef.current !== null) window.cancelAnimationFrame(viewportFrameRef.current)
    if (heightFrameRef.current !== null) window.cancelAnimationFrame(heightFrameRef.current)
  }, [])
  
  // 重置状态
  useEffect(() => {
    if (!show) {
      setHeightVh(80)
      setImagesLoaded(false)
      setLoadedImageCount(0)
      setShowPlaylistInfo(false)
    }
  }, [show])
  
  // 监听歌曲加载和封面预加载
  useEffect(() => {
    if (!show || loading || songs.length === 0) {
      if (!show || loading) {
        setImagesLoaded(false)
        setLoadedImageCount(0)
      }
      return
    }
    if (imagesLoaded) return

    const songsToPreload = songs.slice(0, 20)
    const imagesToLoad = [...new Set(songsToPreload
      .map(song => song.album?.picUrl)
      .filter((url): url is string => Boolean(url)))]

    if (imagesToLoad.length === 0) {
      setImagesLoaded(true)
      return
    }

    let cancelled = false
    let loadedCount = 0
    let revealTimer: number | null = null
    const totalImages = imagesToLoad.length
    const images: HTMLImageElement[] = []

    const handleImageLoad = () => {
      if (cancelled) return
      loadedCount++
      setLoadedImageCount(loadedCount)
      if (loadedCount >= totalImages && revealTimer === null) {
        revealTimer = window.setTimeout(() => {
          revealTimer = null
          if (!cancelled) setImagesLoaded(true)
        }, 100)
      }
    }

    imagesToLoad.forEach(url => {
      const proxyUrl = getProxiedImageUrl(url)
      if (imageCache.get(proxyUrl)) {
        handleImageLoad()
        return
      }
      const image = new Image()
      images.push(image)
      image.onload = () => {
        if (cancelled) return
        imageCache.set(proxyUrl, proxyUrl)
        handleImageLoad()
      }
      image.onerror = handleImageLoad
      image.src = proxyUrl
    })

    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        console.warn('[PlaylistDetail] cover preload timed out; showing list')
        setImagesLoaded(true)
      }
    }, 5000)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
      if (revealTimer !== null) window.clearTimeout(revealTimer)
      for (const image of images) {
        image.onload = null
        image.onerror = null
        image.src = ''
      }
    }
  }, [songs, loading, show, imagesLoaded])
  
  // Format duration.
  const formatDuration = (ms: number) => {
    const minutes = Math.floor(ms / 60000)
    const seconds = Math.floor((ms % 60000) / 1000)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
            onClick={onClose}
            className={`fixed inset-0 backdrop-blur-sm ${playerTheme === 'dark' ? 'bg-black/60' : 'bg-white/40'}`}
            style={{ zIndex: overlayZ ? overlayZ - 10 : 40 }}
          />

          {/* 歌单详情面板 */}
          <motion.div
            initial={{ y: '100%' }}
            animate={{ 
              y: 0,
            }}
            exit={{ y: '100%' }}
            transition={{ 
              y: { 
                type: 'spring', 
                damping: 35, 
                stiffness: 350,
                mass: 0.8
              },
            }}
            className="fixed inset-x-0 bottom-0 flex justify-center"
            onClick={onClose}
            style={{
              height: `${heightVh}vh`,
              zIndex: overlayZ || 50,
              transition: 'height 0.2s ease-out'
            }}
          >
            {/* 包装容器 - 包含主容器和按钮，使按钮能相对于主容器定位 */}
            <div 
              data-tv-scope
              className="w-full max-w-4xl h-full relative"
              onClick={(e) => e.stopPropagation()}
            >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full h-full flex flex-col relative"
              style={{
                borderTopLeftRadius: '32px',
                borderTopRightRadius: '32px',
                border: playerTheme === 'dark' ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid rgba(0,0,0,0.12)',
                borderBottom: 'none',
                boxShadow: playerTheme === 'dark'
                  ? '0 -8px 32px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 0 rgba(255, 255, 255, 0.1)'
                  : '0 -8px 32px 0 rgba(0,0,0,0.15), inset 0 1px 0 0 rgba(255,255,255,0.8)',
                overflow: 'hidden'
              }}
            >
              {/* 封面背景 - 液态玻璃效果 */}
              {playlist?.coverImgUrl ? (
                <div className="absolute inset-0 z-0" style={{ borderTopLeftRadius: '32px', borderTopRightRadius: '32px' }}>
                  {/* 模糊的封面背景 - 使用代理URL */}
                  <div 
                    className="absolute inset-0"
                    style={{
                      backgroundImage: `url(http://localhost:3001/api/proxy-image?url=${encodeURIComponent(playlist.coverImgUrl)})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      filter: playerTheme === 'dark' ? 'blur(60px) brightness(0.8)' : 'blur(60px) brightness(1.05)',
                      transform: 'scale(1.2)',
                    }}
                  />
                  {/* 液态玻璃遮罩 - 多层渐变 */}
                  <div 
                    className="absolute inset-0"
                    style={{
                      background: playerTheme === 'dark'
                        ? 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.8) 100%)'
                        : 'linear-gradient(135deg, rgba(252,252,250,0.82) 0%, rgba(246,246,244,0.74) 50%, rgba(250,250,248,0.8) 100%)',
                      backdropFilter: 'blur(80px) saturate(180%)',
                      WebkitBackdropFilter: 'blur(80px) saturate(180%)',
                    }}
                  />
                  {/* 光泽效果 */}
                  <div 
                    className="absolute inset-0"
                    style={{
                      background: 'radial-gradient(circle at 30% 20%, rgba(255,255,255,0.15) 0%, transparent 50%)',
                      pointerEvents: 'none',
                    }}
                  />
                  {/* 边缘高光 */}
                  <div 
                    className="absolute inset-x-0 top-0 h-px"
                    style={{
                      background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                    }}
                  />
                </div>
              ) : (
                // 没有封面时的默认背景
                <div className="absolute inset-0 z-0" style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.8) 100%)'
                    : 'linear-gradient(135deg, rgba(252,252,250,0.82) 0%, rgba(246,246,244,0.74) 50%, rgba(250,250,248,0.8) 100%)',
                  backdropFilter: 'blur(80px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(80px) saturate(180%)',
                  borderTopLeftRadius: '32px',
                  borderTopRightRadius: '32px'
                }} />
              )}
              
              {/* 内容层 - 相对定位在背景之上 */}
              <div className="relative z-10 flex flex-col h-full">
              {/* 顶部拖拽指示器和关闭按钮 - 整条可点击 */}
              <div 
                onClick={onClose}
                className={`flex flex-col items-center pt-2 pb-1 cursor-pointer transition-colors flex-shrink-0 ${playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'}`}
              >
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  className="p-1 rounded-full"
                >
                  <ChevronDown className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}`} />
                </motion.div>
                <div className={`w-10 h-0.5 rounded-full ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'}`} />
              </div>

              {/* 歌单头部信息 */}
              {playlist && (
                <div className={`flex items-center gap-4 px-6 py-3 border-b flex-shrink-0 ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
                  {/* 封面 */}
                  <div className={`relative w-20 h-20 rounded-lg overflow-hidden flex-shrink-0 shadow-xl ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                    {playlist.coverImgUrl ? (
                      <CachedImage 
                        src={playlist.coverImgUrl} 
                        alt={playlist.name} 
                        className="w-full h-full object-cover"
                        lazy={false}
                        fallback={
                          <div className="w-full h-full flex items-center justify-center">
                            <Music className={`w-8 h-8 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                          </div>
                        }
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music className={`w-8 h-8 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                      </div>
                    )}
                    {playlist.platform === 'qq' && playlist.isLike && (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden="true">
                        <Heart
                          className="h-[42%] w-[42%] fill-white/75 text-white/75"
                          strokeWidth={0}
                          style={{ filter: 'drop-shadow(0 2px 8px rgba(0, 0, 0, 0.28)) blur(0.6px)' }}
                        />
                      </div>
                    )}
                  </div>

                  {/* 歌单信息 */}
                  <div className="flex-1 min-w-0">
                    <h2 className={`text-xl font-bold mb-1.5 truncate ${playerTheme === 'dark' ? 'text-white' : 'text-black/85'}`}>
                      {playlist.name}
                    </h2>
                    <div className={`flex items-center gap-3 text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}`}>
                      <span>{songs.length < Number(playlist.trackCount || 0) ? `已加载 ${songs.length} / ${playlist.trackCount} 首` : `${playlist.trackCount} 首歌曲`}</span>
                      {songs.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          总时长 {totalDurationMinutes} 分钟
                        </span>
                      )}
                    </div>

                    {/* 播放全部 + 收藏 */}
                    <div className="mt-2 flex items-center gap-2">
                      {songs.length > 0 && (
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSongSelect(songs[0], songs)
                          }}
                          className="px-4 py-1.5 text-white rounded-full font-medium transition-all flex items-center gap-1.5 text-sm"
                          style={{
                            backgroundColor: `${accentColor}e6`,
                          }}
                          onMouseEnter={(e) => e.currentTarget.style.backgroundColor = accentColor}
                          onMouseLeave={(e) => e.currentTarget.style.backgroundColor = `${accentColor}e6`}
                        >
                          <Play className="w-3.5 h-3.5" fill="currentColor" />
                          播放全部
                        </motion.button>
                      )}
                      {/* 智能播放：仅网易云（无其他平台接口） */}
                      {(playlist.platform === 'netease' || currentPlatform === 'netease') && songs.length > 0 && (
                        <motion.button
                          whileHover={{ scale: 1.05 }}
                          whileTap={{ scale: 0.95 }}
                          disabled={smartLoading}
                          onClick={(e) => {
                            e.stopPropagation()
                            void handleSmartPlay()
                          }}
                          className={`px-4 py-1.5 rounded-full font-medium transition-all flex items-center gap-1.5 text-sm disabled:opacity-50 ${playerTheme === 'dark' ? 'border border-white/20 text-white/80 hover:bg-white/10' : 'border border-black/15 text-black/70 hover:bg-black/10'}`}
                        >
                          <Radio className={`w-3.5 h-3.5 ${smartLoading ? 'animate-pulse' : ''}`} />
                          智能播放
                        </motion.button>
                      )}
                      {getPlatformCapabilities(playlist.platform || currentPlatform).subscribePlaylist && (
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        disabled={subscribing}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleSubscribe()
                        }}
                        className={`px-4 py-1.5 rounded-full font-medium transition-all flex items-center gap-1.5 text-sm disabled:opacity-50 ${collected ? '' : playerTheme === 'dark' ? 'border border-white/20 text-white/80 hover:bg-white/10' : 'border border-black/15 text-black/70 hover:bg-black/10'}`}
                        style={collected ? { backgroundColor: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55` } : undefined}
                      >
                        <Heart className={`w-3.5 h-3.5 ${collected ? 'fill-current' : ''}`} />
                        {collected ? '已收藏' : '收藏'}
                      </motion.button>
                      )}
                    </div>
                  </div>

                  {(
                    <motion.button
                      whileHover={{ scale: 1.03 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={(event) => {
                        event.stopPropagation()
                        setShowPlaylistInfo(true)
                      }}
                      className={`ml-auto px-4 py-2 rounded-xl border transition-all flex items-center gap-2 ${playerTheme === 'dark' ? 'border-white/10 bg-white/5 hover:bg-white/10 hover:border-white/20 text-white/80 hover:text-white' : 'border-black/10 bg-black/5 hover:bg-black/10 hover:border-black/20 text-black/70 hover:text-black'}`}
                    >
                      <Info className="w-4 h-4" />
                      详情
                    </motion.button>
                  )}
                </div>
              )}

              {/* 歌曲列表 - 支持向下滚动，卡片向上移动 */}
              <div 
                ref={scrollContainerRef}
                onScroll={handleListScroll}
                className="flex-1 overflow-y-auto"
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: playerTheme === 'dark' ? 'rgba(255, 255, 255, 0.3) rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.3) rgba(0, 0, 0, 0.08)'
                }}
              >
                <div className="px-8 py-4">
                  {loading || (songs.length > 0 && !imagesLoaded) ? (
                    <div className="flex flex-col items-center justify-center h-64 gap-6">
                      {/* 优雅的音符加载动画 */}
                      <div className="relative w-20 h-20">
                        {/* 外圈光晕 */}
                        <motion.div
                          className="absolute inset-0 rounded-full bg-gradient-to-r from-pink-500/20 to-purple-500/20"
                          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.2, 0.5] }}
                          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                        />
                        {/* 中圈旋转 */}
                        <motion.div
                          className="absolute inset-2 rounded-full border-2 border-gradient-to-r from-pink-500 to-purple-500"
                          style={{
                            borderImage: 'linear-gradient(135deg, #ec4899, #a855f7) 1',
                          }}
                          animate={{ rotate: 360 }}
                          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                        />
                        {/* 内圈音符图标 */}
                        <motion.div
                          className="absolute inset-0 flex items-center justify-center"
                          animate={{ scale: [1, 1.1, 1] }}
                          transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                        >
                          <Music className="w-8 h-8 text-pink-400" />
                        </motion.div>
                      </div>
                      {/* 优雅的加载文字 */}
                      <div className="flex flex-col items-center gap-2">
                        <div className="flex items-center gap-2">
                          <motion.span
                            className={`text-base font-light tracking-wide ${playerTheme === 'dark' ? 'text-white/90' : 'text-black/70'}`}
                            animate={{ opacity: [0.4, 1, 0.4] }}
                            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                          >
                            正在加载歌单
                          </motion.span>
                          <div className="flex gap-1">
                            {[0, 1, 2].map((i) => (
                              <motion.div
                                key={i}
                                className="w-1.5 h-1.5 rounded-full bg-pink-400"
                                animate={{ opacity: [0.3, 1, 0.3], y: [0, -4, 0] }}
                                transition={{
                                  duration: 1.5,
                                  repeat: Infinity,
                                  delay: i * 0.2,
                                  ease: "easeInOut"
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : songs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32">
                      <Music className={`w-12 h-12 mb-2 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                      <div className={playerTheme === 'dark' ? 'text-white/60' : 'text-black/55'}>当前歌单暂无歌曲</div>
                    </div>
                  ) : (
                    <div className="relative w-full" style={{ height: `${virtualListHeight}px` }}>
                      {visibleSongs.map(({ song, index }) => {
                        const isCurrentSong = isSongCurrent(song)
                        return (
                        <div
                          key={`playlist-song-${song.platform || currentPlatform}-${song.mid || song.id}-${index}`}
                          data-song-index={index}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSongSelect(song, songs)
                          }}
                          onContextMenu={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setContextMenu({
                              show: true,
                              x: e.clientX,
                              y: e.clientY,
                              song: song
                            })
                          }}
                          className={`absolute inset-x-0 flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-colors group ${
                            isCurrentSong 
                              ? 'bg-pink-500/20 hover:bg-pink-500/30'
                              : playerTheme === 'dark' ? 'hover:bg-white/8' : 'hover:bg-black/5'
                          }`}
                          style={{
                            top: `${index * DETAIL_ROW_HEIGHT}px`,
                            height: `${DETAIL_CARD_HEIGHT}px`
                          }}
                        >
                          {/* 序号 */}
                          <div className={`w-6 text-center text-xs group-hover:opacity-80 ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'}`}>
                            {index + 1}
                          </div>

                          {/* 封面 */}
                          <div className={`w-10 h-10 rounded-md overflow-hidden flex-shrink-0 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                            {song.album?.picUrl ? (
                              <CachedImage 
                                src={song.album.picUrl} 
                                alt={song.name} 
                                className="w-full h-full object-cover"
                                lazy={false}
                                fallback={
                                  <div className="w-full h-full flex items-center justify-center">
                                    <Music className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                                  </div>
                                }
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className={`w-4 h-4 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} />
                              </div>
                            )}
                          </div>

                          {/* 歌曲信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <div className={`text-sm font-medium truncate transition-colors ${
                                isCurrentSong
                                  ? playerTheme === 'dark' ? 'text-pink-400' : 'text-pink-600'
                                  : playerTheme === 'dark' ? 'text-white group-hover:text-pink-400' : 'text-black/85 group-hover:text-pink-600'
                              }`}>
                                {song.name}
                              </div>
                              {/* VIP标识 - 只在非VIP用户看VIP歌曲时显示 */}
                              {(song.fee === 1 || song.fee === 4 || song.vip) && !isVip && (
                                <Crown className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                              )}
                            </div>
                            <div className={`text-xs truncate ${
                              isCurrentSong
                                ? playerTheme === 'dark' ? 'text-pink-300/70' : 'text-pink-600/70'
                                : playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'
                            }`}>
                              {song.artists?.map((a: any) => a.name).join(', ')}
                            </div>
                          </div>

                          {/* 专辑 */}
                          <div className={`hidden md:block text-xs truncate max-w-[200px] ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'}`}>
                            {song.album?.name || '-'}
                          </div>

                          {/* 时长 */}
                          <div className={`text-xs w-12 text-right ${playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'}`}>
                            {formatDuration(song.duration)}
                          </div>
                        </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
              </div> {/* 结束内容层 */}
            </div> {/* 结束主容器 */}
            
            {/* 返回顶部和跳转到当前歌曲按钮 - 在主容器外部，相对于包装容器定位 */}
            <ScrollToTop 
              containerRef={scrollContainerRef} 
              threshold={200}
              playerTheme={playerTheme}
              position="absolute"
              offsetRight={-60}
              offsetBottom={24}
            />
            <ScrollToCurrentSong
              containerRef={scrollContainerRef}
              currentSongIndex={currentSongIndex}
              threshold={200}
              playerTheme={playerTheme}
              position="absolute"
              offsetRight={-60}
              offsetBottom={88}
              cardHeight={DETAIL_CARD_HEIGHT}
              cardGapY={DETAIL_ROW_HEIGHT - DETAIL_CARD_HEIGHT}
              contentPaddingTop={16}
            />
            </div> {/* 结束包装容器 */}
          </motion.div>
        </>
      )}
      
      {playlist && (
        <CommentModal
          isOpen={showPlaylistInfo}
          onClose={() => setShowPlaylistInfo(false)}
          song={null}
          resourceType="playlist"
          playlist={{ ...playlist, platform: currentPlatform }}
        />
      )}

      {/* 右键菜单 */}
      {contextMenu.song && (
        <SongContextMenu
          show={contextMenu.show}
          x={contextMenu.x}
          y={contextMenu.y}
          song={contextMenu.song}
          playerTheme={playerTheme}
          onClose={() => setContextMenu({ show: false, x: 0, y: 0, song: null })}
          onPlayNow={(song) => {
            onSongSelect(song, songs)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onPlayNext={(song) => {
            onPlayNext?.(song)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onAddToFavorites={(song) => {
            onAddToFavorites?.(song)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onAddToPlaylist={(song, playlistId) => {
            onAddToPlaylist?.(song, playlistId)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onRemoveFromPlaylist={onRemoveFromPlaylist ? (song) => {
            setPendingRemoval({ song, fromFavorites: false })
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          } : undefined}
          onRemoveFromFavorites={onRemoveFromFavorites ? (song) => {
            if (playlist?.isLike) setPendingRemoval({ song, fromFavorites: true })
            else void onRemoveFromFavorites(song)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          } : undefined}
          onViewComments={(song) => {
            onViewComments?.(song)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onViewAlbum={async (song) => {
            const songPlatform = song.platform || currentPlatform
            const albumId = await resolveSongAlbumIdentifier(song, songPlatform)
            if (albumId) {
              onOpenAlbum?.(albumId, songPlatform)
            }
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onViewArtist={(song) => {
            const songPlatform = song.platform || currentPlatform
            const artist = song.artists?.[0]
            const artistId = songPlatform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
            if (artistId) onOpenArtist?.(String(artistId), songPlatform)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          onCopyInfo={(song) => {
            onCopyInfo?.(song)
            setContextMenu({ show: false, x: 0, y: 0, song: null })
          }}
          userPlaylists={userPlaylists}
          platform={currentPlatform}
          hideFavoriteAction={Boolean(playlist?.isLike)}
          currentPlaylistId={playlist ? String(playlist.dirId || playlist.id) : undefined}
        />
      )}

      <DeleteSongModal
        show={Boolean(pendingRemoval)}
        songName={pendingRemoval?.song.name || ''}
        fromFavorites={Boolean(pendingRemoval?.fromFavorites)}
        loading={removalLoading}
        onClose={() => {
          if (!removalLoading) setPendingRemoval(null)
        }}
        onConfirm={() => void handleConfirmRemoval()}
      />
    </AnimatePresence>
  )
}

export default memo(PlaylistDetailPanel)



