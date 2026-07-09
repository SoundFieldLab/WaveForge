import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Music, Crown } from 'lucide-react'
import { Song } from '../services/musicApi'

interface PlaylistPanelProps {
  show: boolean
  onClose: () => void
  playlist: Song[]
  currentIndex: number
  onSongSelect: (index: number) => void
  neteaseVip?: boolean
  qqVip?: boolean
  currentPlatform?: 'netease' | 'qq'
}

export default function PlaylistPanel({ show, onClose, playlist, currentIndex, onSongSelect, neteaseVip = false, qqVip = false, currentPlatform = 'netease' }: PlaylistPanelProps) {
  const isVip = currentPlatform === 'netease' ? neteaseVip : qqVip
  
  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
          />

          {/* 播放列表面板 - 液态玻璃效果 */}
          <motion.div
            initial={{ x: '100%', scale: 0.95 }}
            animate={{ x: 0, scale: 1 }}
            exit={{ x: '100%', scale: 0.95 }}
            transition={{ 
              type: 'spring', 
              damping: 25, 
              stiffness: 200,
              mass: 0.8
            }}
            className="fixed right-0 top-0 h-full w-full max-w-md z-50 shadow-2xl"
            style={{
              background: 'rgba(0, 0, 0, 0.7)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              borderLeft: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
            }}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <div className="flex items-center gap-3">
                <Music className="w-6 h-6 text-white" />
                <div>
                  <h2 className="text-2xl font-bold text-white">播放列表</h2>
                  <p className="text-white/60 text-sm">{playlist.length} 首歌曲</p>
                </div>
              </div>
              <motion.button
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X className="w-6 h-6 text-white/60" />
              </motion.button>
            </div>

            {/* 播放列表 */}
            <div className="overflow-y-auto h-[calc(100vh-100px)] p-4">
              {playlist.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-white/40">
                  <Music className="w-16 h-16 mb-4" />
                  <p>播放列表为空</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {playlist.map((song, index) => {
                    const isCurrent = index === currentIndex
                    return (
                      <motion.div
                        key={`queue-song-${index}`}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.02 }}
                        whileHover={{ scale: 1.02, y: -2 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => onSongSelect(index)}
                        className={`group relative flex items-center gap-4 p-4 rounded-2xl cursor-pointer transition-all overflow-hidden ${
                          isCurrent
                            ? 'bg-white/20 shadow-lg ring-2 ring-white/30'
                            : 'bg-white/5 hover:bg-white/10'
                        }`}
                        style={{
                          backdropFilter: 'blur(20px)',
                          WebkitBackdropFilter: 'blur(20px)',
                          minHeight: '80px'
                        }}
                      >
                        {/* 背景封面模糊效果 */}
                        {song.album?.picUrl && (
                          <div 
                            className="absolute inset-0 opacity-20"
                            style={{
                              backgroundImage: `url(${song.album.picUrl})`,
                              backgroundSize: 'cover',
                              backgroundPosition: 'center',
                              filter: 'blur(20px)',
                              transform: 'scale(1.1)'
                            }}
                          />
                        )}
                        
                        {/* 渐变遮罩 */}
                        <div 
                          className="absolute inset-0"
                          style={{
                            background: isCurrent 
                              ? 'linear-gradient(135deg, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0.05) 100%)'
                              : 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.1) 100%)'
                          }}
                        />
                        
                        {/* 内容层 */}
                        <div className="relative flex items-center gap-4 w-full z-10">
                          {/* 序号或播放图标 */}
                          <div className="w-10 flex items-center justify-center flex-shrink-0">
                            {isCurrent ? (
                              <motion.div
                                animate={{ scale: [1, 1.2, 1] }}
                                transition={{ repeat: Infinity, duration: 1.5 }}
                              >
                                <Play className="w-5 h-5 text-white fill-white drop-shadow-lg" />
                              </motion.div>
                            ) : (
                              <span className="text-white/50 text-base font-semibold">
                                {index + 1}
                              </span>
                            )}
                          </div>

                          {/* 封面 - 加大 */}
                          <div className="w-16 h-16 rounded-xl overflow-hidden bg-white/10 flex-shrink-0 shadow-lg ring-2 ring-white/20">
                            {song.album?.picUrl ? (
                              <img
                                src={song.album.picUrl}
                                alt={song.name}
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-white/10 to-white/5">
                                <Music className="w-6 h-6 text-white/30" />
                              </div>
                            )}
                          </div>

                          {/* 歌曲信息 */}
                          <div className="flex-1 min-w-0">
                            <div className={`font-semibold truncate text-base ${
                              isCurrent ? 'text-white drop-shadow-md' : 'text-white/90'
                            }`}>
                              {song.name}
                            </div>
                            <div className={`text-sm truncate mt-1 ${
                              isCurrent ? 'text-white/70' : 'text-white/50'
                            }`}>
                              {song.artists.map(a => a.name).join(', ')}
                            </div>
                          </div>

                          {/* VIP标识 - 只在非VIP用户看VIP歌曲时显示 */}
                          {(song.fee === 1 || song.fee === 4 || song.vip) && !isVip && (
                            <Crown className="w-5 h-5 text-yellow-400 flex-shrink-0 drop-shadow-lg" />
                          )}
                        </div>
                      </motion.div>
                    )
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
