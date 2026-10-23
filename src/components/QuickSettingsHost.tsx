import { AnimatePresence } from 'framer-motion'
import { createPortal } from 'react-dom'
import QuickSettingsDialog from './QuickSettingsDialog'
import type { QuickSettingsPlaybackContext } from './quickSettingsPlaybackContext'
import { closeQuickSettings, useQuickSettingsState } from '../services/quickSettingsStore'

/**
 * 播放设置弹窗的**唯一宿主**：全软件只挂一份（App 层），不随播放页切换而重建。
 *
 * 为什么要 portal 到 body：播放面容器 `minimal-playback-surface` 带
 * `willChange: transform, opacity, filter` 且动画含 filter —— 它同时是 fixed 定位的包含块
 * 与独立层叠上下文；四个视图模式容器还是常驻 zIndex:2。弹窗就地渲染会被裁切、
 * 或被根级浮层（「即将播放」z-50、引擎切换提示 z-9998）盖住。
 * 仓库里同款逃逸手段见 App.tsx 的 MaybePortal 与顶部歌词模式切换。
 *
 * 形态参考开源项目 folia：弹窗宿主集中在一处（其 AppDialogs 里挂 SettingsModal），
 * 触发方只调 store 的 open/close，不自己渲染弹窗。
 *
 * 预览用的播放上下文（当前曲目 / 歌词 / 播放时间源）由 App 层以 prop 下发：
 * 宿主挂在 App 根节点，拿不到播放页的上下文，而这些信息只在 App 层有。
 */
export default function QuickSettingsHost({
  playback,
  foliaStyle,
  foliaTuning,
  onFoliaTuningCommit,
  onFoliaTuningReset,
  hasFoliaTuningOverride,
}: {
  playback?: QuickSettingsPlaybackContext | null
  foliaStyle?: string
  foliaTuning?: Record<string, unknown>
  onFoliaTuningCommit?: (next: Record<string, unknown>) => void
  onFoliaTuningReset?: () => void
  hasFoliaTuningOverride?: boolean
}) {
  const { isOpen, seq, section, playerTheme, isPureMusic } = useQuickSettingsState()

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        // key=seq：只在「关 → 开」时变化，保证每次打开都按最新存储值重新挂载面板
        <QuickSettingsDialog
          key={seq}
          playerTheme={playerTheme}
          isPureMusic={isPureMusic}
          initialSection={section}
          playback={playback}
          foliaStyle={foliaStyle}
          foliaTuning={foliaTuning}
          onFoliaTuningCommit={onFoliaTuningCommit}
          onFoliaTuningReset={onFoliaTuningReset}
          hasFoliaTuningOverride={hasFoliaTuningOverride}
          onClose={closeQuickSettings}
        />
      )}
    </AnimatePresence>,
    document.body,
  )
}
