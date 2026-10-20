/**
 * 均衡器页 —— 编辑控制优先，预设库作为快捷起点嵌入 EqPanel
 */

import { SlidersHorizontal } from 'lucide-react'
import { EqPanel as BaseEqPanel } from '../eqPanel'
import { toLegacyTheme } from '../hse-theme'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import { buildEq64Curve } from '../../src/engine/EqCurve64'

interface EqPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

/**
 * 内置 EQ 预设库：10 个历史锚点 + 预设专属窄带 trims，应用时展开为 64 段曲线
 * （与内置场景同一套 EqCurve64：PRO_EQ_64_BANDS + Q 8.9 + 级联 Q 补偿）。
 */
const EQ_PRESETS: { id: string; name: string; gains: readonly number[]; trims?: ReadonlyArray<readonly [number, number]> }[] = [
  { id: 'flat', name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'pop', name: '流行', gains: [3, 2.5, 1.5, 0.5, -0.5, 0, 1, 2, 2.5, 1.5], trims: [[315, -0.6], [1250, 0.6], [3150, -0.6], [12500, 0.8]] },
  { id: 'rock', name: '摇滚', gains: [2.5, 2, 0.5, -1.5, -1.5, 0, 1.5, 2.5, 3, 2], trims: [[80, 0.8], [250, -0.8], [2500, 0.8], [10000, 0.6]] },
  { id: 'bass', name: '低音增强', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0], trims: [[40, 0.8], [100, -0.5], [200, 0.4]] },
  { id: 'vocal', name: '人声', gains: [-2, -1, 0, 1, 2, 3, 3, 2.5, 1, 0], trims: [[1000, 0.8], [3150, 0.6], [6300, -0.5]] },
  { id: 'bright', name: '明亮', gains: [0, 0, 0, 0, 0, 1, 2, 3, 4, 4], trims: [[6300, 0.5], [12500, 0.8]] },
  { id: 'warm', name: '温暖', gains: [3, 2.5, 2, 1, 0, 0, -0.5, -1.5, -2.5, -3], trims: [[200, 0.5], [6300, -0.6]] },
]

export default function EqPage({ controller, theme }: EqPageProps) {
  const { params, patch } = controller
  const lt = toLegacyTheme(theme)

  const applyPreset = (preset: typeof EQ_PRESETS[number]) => {
    const bands = buildEq64Curve(preset.gains, preset.trims)
    patch({
      eq: {
        ...params.eq,
        enabled: true,
        mode: 'pro',
        bandCount: bands.length,
        proBands: bands,
      },
    })
  }

  const presetLibrary = (
      <section className="hse-glass-card rounded-2xl p-4" aria-label="均衡器预设库" style={{ background: theme.cardBg, border: `1px solid ${theme.cardBorder}` }}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <SlidersHorizontal className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>预设库</span>
          <span className={`${theme.textSecondary} text-xs ml-auto`}>一键应用 64 段曲线</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {EQ_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p)}
              className={`hse-glass-button px-3 py-2 rounded-lg text-xs font-medium ${theme.textPrimary}`}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>
  )

  return <BaseEqPanel controller={controller} theme={lt} quickPresets={presetLibrary} />
}
