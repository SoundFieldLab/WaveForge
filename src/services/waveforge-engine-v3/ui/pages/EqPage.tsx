/**
 * 均衡器页 —— 编辑控制优先，预设库作为快捷起点嵌入 EqPanel
 */

import { SlidersHorizontal } from 'lucide-react'
import { EqPanel as BaseEqPanel } from '../eqPanel'
import { toLegacyTheme } from '../hse-theme'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import { buildEq64Curve, type EqCurveAnchor } from '../../src/engine/EqCurve64'

interface EqPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

/**
 * 内置 EQ 预设库：按「音乐内容频点」锚点设计（底鼓 50–80 / 军鼓 200–240 / 贝斯 700–1k /
 * 人声 1–4k + 齿音 5–10k / 镲片与空气感 7–16k），应用时展开为 64 段曲线；
 * 30Hz 以下与 16kHz 以上保持平直（EqCurve64 会清零），不做无意义的次声/超声抬升。
 */
const EQ_PRESETS: { id: string; name: string; anchors: ReadonlyArray<EqCurveAnchor> }[] = [
  { id: 'flat', name: '平直', anchors: [] },
  { id: 'pop', name: '流行', anchors: [[50, 1.5], [80, 2], [120, 1], [200, -1], [300, -1], [500, 0], [800, 0.3], [1200, 0.5], [2500, 1.5], [4000, 2], [5000, 1], [7000, -0.5], [9000, 1], [12500, 2], [16000, 1.5]] },
  { id: 'rock', name: '摇滚', anchors: [[50, 2], [80, 2.5], [120, 1], [200, -1.5], [300, -1.8], [500, -0.5], [800, 0.5], [1200, 1], [2000, 1.5], [3000, 2], [4000, 2.5], [5000, 2], [7000, 1], [9000, 1.5], [12500, 1.5], [16000, 1]] },
  { id: 'bass', name: '低音增强', anchors: [[30, 1], [40, 3], [55, 4.5], [70, 5], [100, 4], [150, 2.5], [200, 1], [300, 0], [500, -1], [700, -0.8], [1000, -1], [2000, -1.2], [4000, -1], [8000, -0.8], [12500, -0.5], [16000, 0]] },
  { id: 'vocal', name: '人声', anchors: [[50, -1.5], [80, -2], [120, -1], [200, -0.5], [300, 0], [500, 0.8], [800, 1.5], [1200, 2], [2000, 2.5], [3000, 3], [4000, 2.5], [5000, 1.5], [7000, -1.5], [9000, 0], [12500, 0.5], [16000, 0.5]] },
  { id: 'bright', name: '明亮', anchors: [[80, 0], [120, 0], [200, 0], [500, 0], [1000, 0], [2000, 0.5], [3000, 1.5], [4000, 2], [5000, 2.5], [7000, 3], [9000, 3.5], [12500, 4], [14000, 4], [16000, 3.5]] },
  { id: 'warm', name: '温暖', anchors: [[50, 2], [80, 2.5], [120, 2], [200, 1.5], [300, 0.8], [500, 0], [1000, -0.3], [2000, -0.8], [3000, -1.2], [5000, -1.8], [7000, -2.2], [10000, -2.5], [12500, -2.8], [16000, -3]] },
]

export default function EqPage({ controller, theme }: EqPageProps) {
  const { params, patch } = controller
  const lt = toLegacyTheme(theme)

  const applyPreset = (preset: typeof EQ_PRESETS[number]) => {
    const bands = buildEq64Curve(preset.anchors)
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
