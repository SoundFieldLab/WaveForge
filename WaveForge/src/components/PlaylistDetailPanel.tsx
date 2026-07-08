import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, Music, Play, Clock } from 'lucide-react'
import { Song } from '../services/musicApi'
import { useState, useRef, useEffect } from 'react'

interface PlaylistDetailPanelProps {
  show: boolean
  playlist: {
    id: number
    name: string
    coverImgUrl: string
    trackCount: number
    description?: string
  } | null
  songs: Song[]
  loading: boolean
  onClose: () => void
  onSongSelect: (song: Song, playlist: Song[]) => void
}

export default function PlaylistDetailPanel({
  show,
  playlist,
  songs,
  loading,
  onClose,
  onSongSelect
}: PlaylistDetailPanelProps) {
  const [heightVh, setHeightVh] = useState(80) // 从80vh开始，最大90vh
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  
  // 监听滚动事件 - 渐进式调整高度
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    
    const handleScroll = () => {
      const scrollTop = container.scrollTop
      
      // 根据滚动位置计算高度：0px -> 80vh, 30px -> 90vh
      // 非常快速响应
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
      
      setHeightVh(newHeight)
    }
    
    container.addEventListener('scroll', handleScroll, { passive: true })
    
    return () => {
      container.removeEventListener('scroll', handleScroll)
    }
  }, [show])
  
  // 重置状态
  useEffect(() => {
    if (!show) {
      setHeightVh(80)
    }
  }, [show])
  
  // 格式化时长
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
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
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
            className="fixed inset-x-0 bottom-0 z-50 flex justify-center"
            onClick={onClose}
            style={{
              height: `${heightVh}vh`,
              transition: 'height 0.2s ease-out'
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-4xl h-full flex flex-col relative"
              style={{
                borderTopLeftRadius: '32px',
                borderTopRightRadius: '32px',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                borderBottom: 'none',
                boxShadow: '0 -8px 32px 0 rgba(0, 0, 0, 0.5), inset 0 1px 0 0 rgba(255, 255, 255, 0.1)',
                overflow: 'hidden'
              }}
            >
              {/* 封面背景 - 液态玻璃效果 */}
              {playlist?.coverImgUrl ? (
                <div className="absolute inset-0 z-0" style={{ borderTopLeftRadius: '32px', borderTopRightRadius: '32px' }}>
                  {/* 模糊的封面背景 */}
                  <div 
                    className="absolute inset-0"
                    style={{
                      backgroundImage: `url(${playlist.coverImgUrl})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                      filter: 'blur(60px) brightness(0.8)',
                      transform: 'scale(1.2)',
                    }}
                  />
                  {/* 液态玻璃遮罩 - 多层渐变 */}
                  <div 
                    className="absolute inset-0"
                    style={{
                      background: 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.8) 100%)',
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
                  background: 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.8) 100%)',
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
                className="flex flex-col items-center pt-2 pb-1 cursor-pointer hover:bg-white/5 transition-colors flex-shrink-0"
              >
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  className="p-1 rounded-full"
                >
                  <ChevronDown className="w-5 h-5 text-white/60" />
                </motion.div>
                <div className="w-10 h-0.5 bg-white/20 rounded-full" />
              </div>

              {/* 歌单头部信息 */}
              {playlist && (
                <div className="flex items-center gap-4 px-6 py-3 border-b border-white/10 flex-shrink-0">
                  {/* 封面 */}
                  <div className="w-20 h-20 rounded-lg overflow-hidden bg-white/10 flex-shrink-0 shadow-xl">
                    {playlist.coverImgUrl ? (
                      <img 
                        src={playlist.coverImgUrl} 
                        alt={playlist.name} 
                        className="w-full h-full object-cover" 
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music className="w-8 h-8 text-white/20" />
                      </div>
                    )}
                  </div>

                  {/* 歌单信息 */}
                  <div className="flex-1 min-w-0">
                    <h2 className="text-xl font-bold text-white mb-1.5 truncate">
                      {playlist.name}
                    </h2>
                    <div className="flex items-center gap-3 text-white/60 text-xs">
                      <span>{playlist.trackCount} 首歌曲</span>
                      {songs.length > 0 && (
                        <span className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5" />
                          总时长 {Math.floor(songs.reduce((acc, song) => acc + song.duration, 0) / 60000)} 分钟
                        </span>
                      )}
                    </div>

                    {/* 播放全部按钮 */}
                    {songs.length > 0 && (
                      <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onSongSelect(songs[0], songs)
                        }}
                        className="mt-2 px-4 py-1.5 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white rounded-full font-medium transition-all flex items-center gap-1.5 text-sm"
                      >
                        <Play className="w-3.5 h-3.5" fill="currentColor" />
                        播放全部
                      </motion.button>
                    )}
                  </div>
                </div>
              )}

              {/* 歌曲列表 - 支持向下滚动，卡片向上移动 */}
              <div 
                ref={scrollContainerRef}
                className="flex-1 overflow-y-auto"
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'rgba(255, 255, 255, 0.3) rgba(255, 255, 255, 0.1)'
                }}
              >
                <div className="px-8 py-4">
                  {loading ? (
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
                          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
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
                      <div className="flex items-center gap-2">
                        <motion.span
                          className="text-white/90 text-base font-light tracking-wide"
                          animate={{ opacity: [0.4, 1, 0.4] }}
                          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
                        >
                          正在加载
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
                  ) : songs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-32">
                      <Music className="w-12 h-12 text-white/20 mb-2" />
                      <div className="text-white/60">暂无歌曲</div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {songs.map((song, index) => (
                        <div
                          key={`${song.id || song.mid || 'song'}-${index}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onSongSelect(song, songs)
                          }}
                          className="flex items-center gap-3 p-2 rounded-lg cursor-pointer transition-all group hover:bg-white/8 hover:scale-[1.01]"
                        >
                          {/* 序号 */}
                          <div className="w-6 text-center text-white/40 text-xs group-hover:text-white/60">
                            {index + 1}
                          </div>

                          {/* 封面 */}
                          <div className="w-10 h-10 rounded-md overflow-hidden bg-white/10 flex-shrink-0">
                            {song.album?.picUrl ? (
                              <img 
                                src={song.album.picUrl} 
                                alt={song.name} 
                                className="w-full h-full object-cover" 
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-4 h-4 text-white/20" />
                              </div>
                            )}
                          </div>

                          {/* 歌曲信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="text-white text-sm font-medium truncate group-hover:text-pink-400 transition-colors">
                              {song.name}
                            </div>
                            <div className="text-white/50 text-xs truncate">
                              {song.artists?.map((a: any) => a.name).join(', ')}
                            </div>
                          </div>

                          {/* 专辑 */}
                          <div className="hidden md:block text-white/40 text-xs truncate max-w-[200px]">
                            {song.album?.name || '-'}
                          </div>

                          {/* 时长 */}
                          <div className="text-white/40 text-xs w-12 text-right">
                            {formatDuration(song.duration)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              </div> {/* 结束内容层 */}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
