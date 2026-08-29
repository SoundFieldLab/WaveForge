import { motion, AnimatePresence } from 'framer-motion'
import { Layers, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTvBack } from '../tv/tvCore'

interface FusionEnableConfirmModalProps {
  show: boolean
  onClose: () => void
  onConfirm: () => void
}

// 开启桌面融合穿透的确认弹窗：穿透需要把主窗口重建为透明窗口（会中断播放/重载界面），
// 确认后再由主进程执行重建。样式与删除歌单确认弹窗（DeletePlaylistModal）一致。
export default function FusionEnableConfirmModal({
  show,
  onClose,
  onConfirm,
}: FusionEnableConfirmModalProps) {
  // TV 遥控器 BACK：关闭确认弹窗
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
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}26` }}>
                  <Layers className="w-5 h-5" style={{ color: accentColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">启用桌面融合穿透</h3>
                  <p className="text-white/60 text-sm mt-1">
                    需要把主窗口重建为<span className="text-white">透明窗口</span>，以便透出真实桌面。
                  </p>
                  <p className="text-white/40 text-xs mt-1.5">
                    重建会重新加载界面，当前播放的音乐会中断。关闭桌面融合时会再次重建，恢复原生窗口。
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
                className="flex-1 py-2.5 px-4 text-white/80 rounded-xl transition-colors hover:bg-white/10 flex items-center justify-center gap-2"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                <X className="w-4 h-4" />
                取消
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="flex-1 py-2.5 px-4 rounded-xl font-medium transition-all flex items-center justify-center gap-2 text-white"
                style={{ background: 'linear-gradient(135deg, #ec4899, #8b5cf6)', boxShadow: '0 4px 16px rgba(236,72,153,0.35)' }}
              >
                <Layers className="w-4 h-4" />
                继续并重建窗口
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
