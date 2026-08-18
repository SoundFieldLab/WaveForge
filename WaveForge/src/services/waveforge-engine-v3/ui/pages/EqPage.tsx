/**
 * 均衡器页 —— 顶部「预设库」快捷入口（10 段曲线一键应用）+ 复用 EqPanel 详细编辑
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

  return (
    <div className="space-y-3">
      {/* 预设库入口（显眼 chip 行） */}
      <div className="rounded-2xl p-3" style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}`, boxShadow: theme.cardGlow }}>
        <div className="flex items-center gap-2 mb-2.5">
          <SlidersHorizontal className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>预设库</span>
          <span className={`${theme.textTertiary} text-[10px] ml-auto`}>一键应用 10 段曲线</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EQ_PRESETS.map((p) => (
            <motion.button
              key={p.id}
              type="button"
              whileTap={{ scale: 0.95 }}
              onClick={() => applyPreset(p.gains)}
              className="px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all hover:brightness-110"
              style={{ backgroundColor: `${theme.accentColor}1f`, color: theme.accentColor, border: `1px solid ${theme.accentColor}33` }}
            >
              {p.name}
            </motion.button>
          ))}
        </div>
      </div>

      <BaseEqPanel controller={controller} theme={lt} />
    </div>
  )
}
