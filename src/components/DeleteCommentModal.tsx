import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface DeleteCommentModalProps {
  show: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: () => void
}

export default function DeleteCommentModal({ show, loading = false, onClose, onConfirm }: DeleteCommentModalProps) {
  // TV 遥控器 BACK：关闭删除评论确认弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={loading ? undefined : onClose}
            className="fixed inset-0 z-[10040] bg-black/70 backdrop-blur-sm"
          />
          <motion.div
            data-tv-scope
            initial={{ opacity: 0, scale: 0.92, y: 18 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 18 }}
            transition={{ type: 'spring', damping: 25, stiffness: 220 }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-comment-title"
            className="fixed left-1/2 top-1/2 z-[10041] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2"
          >
            <div
              className="overflow-hidden rounded-3xl border border-white/10"
              style={{
                background: 'rgba(30, 29, 40, 0.98)',
                backdropFilter: 'blur(40px)',
                boxShadow: '0 24px 80px rgba(0, 0, 0, 0.6)'
              }}
            >
              <div className="p-7">
                <div className="flex items-start gap-5">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-red-500/20">
                    <AlertTriangle className="h-7 w-7 text-red-400" />
                  </div>
                  <div className="min-w-0 pt-1">
                    <h3 id="delete-comment-title" className="mb-3 text-2xl font-bold text-white">删除评论</h3>
                    <p className="text-base leading-7 text-white/65">确定要删除这条评论吗？</p>
                    <p className="mt-2 text-sm leading-6 text-white/40">此操作不可撤销，评论及相关回复将从当前平台移除。</p>
                  </div>
                </div>
              </div>
              <div className="flex gap-4 border-t border-white/10 p-5">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-white/5 px-5 py-3.5 text-lg text-white/75 transition-colors hover:bg-white/10 disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                  取消
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-red-600 px-5 py-3.5 text-lg font-medium text-white transition-colors hover:bg-red-700 disabled:bg-red-500/35 disabled:text-white/45"
                >
                  <Trash2 className="h-5 w-5" />
                  {loading ? '删除中…' : '删除'}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
