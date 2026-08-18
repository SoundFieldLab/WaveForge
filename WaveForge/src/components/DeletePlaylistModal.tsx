import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTvBack } from '../tv/tvCore'

interface DeletePlaylistModalProps {
  show: boolean
  onClose: () => void
  onConfirm: () => void
  playlistName: string
  loading?: boolean
}

export default function DeletePlaylistModal({
  show,
  onClose,
  onConfirm,
  playlistName,
  loading = false
}: DeletePlaylistModalProps) {
  // TV 遥控器 BACK：关闭删除歌单确认弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={onClose}
        >
          <motion.div
            data-tv-scope
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl relative"
          >
            {/* 液态玻璃背景 */}
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)', backdropFilter: 'blur(80px) saturate(200%)', WebkitBackdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }} />
            </div>

            <div className="relative z-10 p-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'rgba(239,68,68,0.18)' }}>
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">删除歌单</h3>
                  <p className="text-white/60 text-sm mt-1">
                    确定要删除歌单「<span className="text-white">{playlistName}</span>」吗？
                  </p>
                  <p className="text-white/40 text-xs mt-1.5">
                    此操作不可撤销，歌单内的歌曲将被移除。
                  </p>
                </div>
                <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>

            <div className="relative z-10 flex gap-3 p-4">
              <button
                type="button"
                onClick={onClose}
                disabled={loading}
                className="flex-1 py-2.5 px-4 text-white/80 rounded-xl transition-colors hover:bg-white/10 flex items-center justify-center gap-2"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <X className="w-4 h-4" />
                取消
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={loading}
                className={`flex-1 py-2.5 px-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 ${
                  loading ? 'text-white/30 cursor-not-allowed' : 'text-white'
                }`}
                style={loading
                  ? { background: 'rgba(239,68,68,0.25)' }
                  : { background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 4px 16px rgba(239,68,68,0.4)' }}
              >
                <Trash2 className="w-4 h-4" />
                {loading ? '删除中...' : '删除'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
