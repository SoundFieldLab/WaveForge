/**
 * 均衡器页 —— 编辑控制优先，预设库作为快捷起点嵌入 EqPanel
 */

import { motion } from 'framer-motion'
import { SlidersHorizontal } from 'lucide-react'
import { EqPanel as BaseEqPanel } from '../eqPanel'
import { toLegacyTheme } from '../hse-theme'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import { PRO_EQ_DEFAULT_BANDS } from '../../src/types'

interface EqPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

/** 10 段 EQ 预设库（频率对应 PRO_EQ_DEFAULT_BANDS：31.5/63/125/250/500/1k/2k/4k/8k/16k） */
const EQ_PRESETS: { id: string; name: string; gains: number[] }[] = [
  { id: 'flat', name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'pop', name: '流行', gains: [3, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5] },
  { id: 'rock', name: '摇滚', gains: [2.5, 2, 0.5, -1.5, -1.5, 0, 1.5, 2.5, 3, 2] },
  { id: 'bass', name: '低音增强', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { id: 'vocal', name: '人声', gains: [-2, -1, 0, 1, 2, 3, 3, 2.5, 1, 0] },
  { id: 'bright', name: '明亮', gains: [0, 0, 0, 0, 0, 1, 2, 3, 4, 4] },
  { id: 'warm', name: '温暖', gains: [3, 2.5, 2, 1, 0, 0, -0.5, -1.5, -2.5, -3] },
]

export default function EqPage({ controller, theme }: EqPageProps) {
  const { params, patch } = controller
  const lt = toLegacyTheme(theme)

  const applyPreset = (gains: number[]) => {
    patch({
      eq: {
        ...params.eq,
        enabled: true,
        mode: 'pro',
        bandCount: 10,
        proBands: PRO_EQ_DEFAULT_BANDS.map((f, i) => ({ frequency: f, gain: gains[i] ?? 0, q: 1.1 })),
      },
    })
  }

  const presetLibrary = (
      <section className="hse-glass-card rounded-2xl p-4" aria-label="均衡器预设库" style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <SlidersHorizontal className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>预设库</span>
          <span className={`${theme.textSecondary} text-xs ml-auto`}>一键应用 10 段曲线</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EQ_PRESETS.map((p) => (
            <motion.button
              key={p.id}
              type="button"
              whileTap={{ scale: 0.95 }}
              onClick={() => applyPreset(p.gains)}
              className={`hse-glass-button px-3 py-2 rounded-lg text-xs font-medium ${theme.textPrimary}`}
            >
              {p.name}
            </motion.button>
          ))}
        </div>
      </section>
  )

  return <BaseEqPanel controller={controller} theme={lt} quickPresets={presetLibrary} />
}
