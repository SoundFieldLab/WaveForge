import { motion, AnimatePresence } from 'framer-motion'
import type { TransitionDebugInfo } from '../audio/types'

/**
 * TransitionDebugToast —— 过渡调试弹窗（右上角，位于「即将播放」UpNext 提示下方）。
 * 显示本次过渡实际使用的引擎 / 策略 / 编排的 DJ 效果清单 / 计划参数，
 * 供调试「为什么没效果 / 用了什么方式切歌」。
 * 显示与淡出时机由 App.tsx 驱动；开关在 设置 → 开发者选项 → 调试面板 → 过渡调试。
 */
interface TransitionDebugToastProps {
  info: TransitionDebugInfo | null
  playerTheme?: 'light' | 'dark'
}

const STRATEGY_LABEL: Record<string, string> = {
  'smart-rendered': '智能渲染',
  'smart-rendered-v2': '智能渲染',
  'beat-crossfade': '节拍交叉淡化',
  'fixed-crossfade': '交叉淡化',
  'gapless': '无缝拼接',
  'none': '无',
}
const STYLE_LABEL: Record<string, string> = {
  energetic: '高能量',
  atmospheric: '氛围',
  clean: '干净',
}
const INTENSITY_LABEL: Record<string, string> = {
  subtle: '轻',
  standard: '标准',
  strong: '强',
}

export default function TransitionDebugToast({ info, playerTheme = 'dark' }: TransitionDebugToastProps) {
  const isDark = playerTheme === 'dark'

  return (
    <AnimatePresence>
      {info && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.97 }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="fixed top-16 right-6 z-[9997] pointer-events-none"
        >
          <div
            className="px-4 py-3 rounded-2xl shadow-2xl max-w-[380px]"
            style={{
              background: isDark ? 'rgba(10, 12, 20, 0.72)' : 'rgba(255, 255, 255, 0.88)',
              backdropFilter: 'blur(24px) saturate(180%)',
              WebkitBackdropFilter: 'blur(24px) saturate(180%)',
              border: `1px solid ${isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.1)'}`,
              color: isDark ? '#fff' : '#1a1a1a',
              whiteSpace: 'pre-line',
            }}
          >
            <div className="text-sm font-semibold mb-1">
              {info.engine === 'v2' ? '🟢' : info.engine === 'fallback' ? '🟠' : '🔵'} 过渡 · {STRATEGY_LABEL[info.strategy] || info.strategy}
              {info.style && <> · <span style={{ color: STYLE_LABEL[info.style] === '高能量' ? '#F59E0B' : STYLE_LABEL[info.style] === '氛围' ? '#8B5CF6' : '#10B981' }}>{STYLE_LABEL[info.style]}</span></>}
              {info.intensity && <> · 强度:{INTENSITY_LABEL[info.intensity] || info.intensity}</>}
            </div>
            <div className="text-xs mb-1" style={{ color: isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>
              {info.effects?.length ? info.effects.join(' · ') : '（无附加特效）'}
            </div>
            <div className="text-[11px] tabular-nums" style={{ color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)' }}>
              {info.beatCount}拍 · {info.sourceBpm}→{info.targetBpm} BPM
              {typeof info.keyCompat === 'number' && <> · 调性兼容 {info.keyCompat.toFixed(2)}</>}
              {info.gainOffsetDb !== undefined && info.gainOffsetDb !== 0 && <> · 响度补偿 {info.gainOffsetDb > 0 ? '+' : ''}{info.gainOffsetDb.toFixed(1)}dB</>}
              {'\n'}置信 {info.confidence.toFixed(2)} · {info.rendererVersion}
            </div>
            {info.sourceProvider && (
              <div className="text-[11px] tabular-nums" style={{ color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
                分析来源: {info.sourceProvider} → {info.targetProvider}
              </div>
            )}
            {info.fallbackReason && (
              <div className="text-[11px] mt-1.5" style={{ color: '#F59E0B' }}>
                回退：{info.fallbackReason}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
