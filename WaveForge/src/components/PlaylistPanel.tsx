import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Music } from 'lucide-react'
import { Song } from '../services/musicApi'

interface PlaylistPanelProps {
  show: boolean
  onClose: () => void
  playlist: Song[]
  currentIndex: number
  onSongSelect: (index: number) => void
}

export default function PlaylistPanel({ show, onClose, playlist, currentIndex, onSongSelect }: PlaylistPanelProps) {
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
                        key={`${song.id || song.mid || 'song'}-${index}`}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.02 }}
                        whileHover={{ scale: 1.02 }}
                        onClick={() => onSongSelect(index)}
                        className={`group flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all ${
                          isCurrent
                            ? 'bg-white/20 shadow-lg'
                            : 'bg-white/5 hover:bg-white/10'
                        }`}
                        style={{
                          backdropFilter: 'blur(10px)',
                          WebkitBackdropFilter: 'blur(10px)',
                        }}
                      >
                        {/* 序号或播放图标 */}
                        <div className="w-8 flex items-center justify-center">
                          {isCurrent ? (
                            <motion.div
                              animate={{ scale: [1, 1.2, 1] }}
                              transition={{ repeat: Infinity, duration: 1.5 }}
                            >
                              <Play className="w-4 h-4 text-white fill-white" />
                            </motion.div>
                          ) : (
                            <span className="text-white/40 text-sm font-medium">
                              {index + 1}
                            </span>
                          )}
                        </div>

                        {/* 封面 */}
                        <div className="w-12 h-12 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                          {song.album?.picUrl ? (
                            <img
                              src={song.album.picUrl}
                              alt={song.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-5 h-5 text-white/20" />
                            </div>
                          )}
                        </div>

                        {/* 歌曲信息 */}
                        <div className="flex-1 min-w-0">
                          <div className={`font-medium truncate ${
                            isCurrent ? 'text-white' : 'text-white/80'
                          }`}>
                            {song.name}
                          </div>
                          <div className="text-white/50 text-sm truncate">
                            {song.artists.map(a => a.name).join(', ')}
                          </div>
                        </div>

                        {/* VIP标识 */}
                        {song.fee === 1 && (
                          <div className="px-2 py-0.5 border border-yellow-500 rounded text-yellow-500 text-xs">
                            VIP
                          </div>
                        )}
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
