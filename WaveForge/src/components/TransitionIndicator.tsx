import { AnimatePresence, motion } from 'framer-motion'
import type { TransitionState, TransitionStrategy } from '../audio/types'

interface TransitionIndicatorProps {
  state: TransitionState
  strategy?: TransitionStrategy
  fallbackReason?: string
  accentColor: string
  playerTheme?: 'light' | 'dark'
}

const strategyLabels: Record<TransitionStrategy, string> = {
  'smart-rendered': '智能 DJ 逐拍混音',
  'beat-crossfade': '节拍对齐淡化',
  'fixed-crossfade': '固定淡入淡出',
  gapless: '专辑无缝播放',
  none: '普通播放',
}

function statusText(state: TransitionState, strategy?: TransitionStrategy) {
  if (state === 'preparing-next') return '正在分析并准备下一首'
  if (state === 'armed') return `已准备：${strategyLabels[strategy || 'none']}`
  if (state === 'running-transition') return `正在过渡：${strategyLabels[strategy || 'none']}`
  if (state === 'failed') return '智能过渡准备失败，播放将自动降级'
  return ''
}

export default function TransitionIndicator({
  state,
  strategy,
  fallbackReason,
  accentColor,
  playerTheme = 'dark',
}: TransitionIndicatorProps) {
  const show = state === 'preparing-next' || state === 'armed' || state === 'running-transition' || state === 'failed'
  const text = statusText(state, strategy)

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.98 }}
          transition={{ duration: 0.2 }}
          className="fixed left-1/2 top-11 z-[10020] -translate-x-1/2 pointer-events-none"
        >
          <div
            className="max-w-[min(88vw,560px)] rounded-full border px-4 py-2 text-center shadow-2xl backdrop-blur-xl"
            style={{
              color: playerTheme === 'dark' ? '#fff' : '#111827',
              borderColor: `${accentColor}66`,
              background: playerTheme === 'dark' ? 'rgba(8, 10, 16, 0.82)' : 'rgba(255, 255, 255, 0.88)',
              boxShadow: `0 8px 32px ${accentColor}2e`,
            }}
          >
            <div className="flex items-center justify-center gap-2 text-sm font-medium">
              <motion.span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: state === 'failed' ? '#f59e0b' : accentColor }}
                animate={state === 'preparing-next' || state === 'running-transition' ? { opacity: [0.35, 1, 0.35] } : undefined}
                transition={{ duration: 1.2, repeat: Infinity }}
              />
              <span>{text}</span>
            </div>
            {fallbackReason && state !== 'preparing-next' && (
              <div className="mt-0.5 truncate text-[11px] opacity-65">已降级：{fallbackReason}</div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
