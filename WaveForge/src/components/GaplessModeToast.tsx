import { motion, AnimatePresence } from 'framer-motion'

/**
 * GaplessModeToast —— 切歌完成后右上角弹出的小弹窗，告知本次衔接使用的 gapless 方案。
 * 位置与引擎切换提示一致（右上角 top-16 right-6），顶部「即将播放」UpNext 不受影响。
 * 显示与淡出时机由 App.tsx 驱动（2.5s 后自动清除 message）。
 */
interface GaplessModeToastProps {
  message: string | null
  playerTheme?: 'light' | 'dark'
}

export default function GaplessModeToast({ message, playerTheme = 'dark' }: GaplessModeToastProps) {
  const isDark = playerTheme === 'dark'

  return (
    <AnimatePresence>
      {message && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.97 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="fixed top-16 right-6 z-[9998] pointer-events-none"
        >
          <div
            className="px-4 py-2.5 rounded-2xl text-sm font-medium shadow-2xl"
            style={{
              background: isDark ? 'rgba(10, 12, 20, 0.55)' : 'rgba(255, 255, 255, 0.82)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}`,
              color: isDark ? '#fff' : '#1a1a1a',
            }}
          >
            {message}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
