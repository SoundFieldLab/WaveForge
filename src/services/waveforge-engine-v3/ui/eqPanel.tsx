/**
 * WaveForge v3 调音室 UI —— 均衡器页
 *
 * v3 EQ：简约 5 段 / 专业 10-20 段 + 级联 Q 补偿 + 锁定 + 曲线编辑器拖拽。
 * 预设（localStorage）格式：{mode, simpleBands, proBands}；完整 v3 分享串见调音器页。
 */

import { useCallback, useState } from 'react'
import { SlidersHorizontal, Save, Trash2, RotateCcw, Lock, LockOpen } from 'lucide-react'
import { PRO_EQ_DEFAULT_BANDS, PRO_EQ_20_BANDS } from '../src/types'
import type { EqBand, EqMode, V3EngineParams } from '../src/types'
import type { V3Theme } from './theme'
import { ActionButton, GlassCard, GlassRangeStyle, InfoLine, SectionTitle, TextInput, Toggle } from './primitives'
import { EqCurveEditor, type EqPoint } from './eqCurveEditor'
import type { DeepPartial, V3ParamsController } from './hooks'

const PRESETS_KEY = 'waveforge:v3-eq-presets'

interface EqPreset {
  id: string
  name: string
  mode: EqMode
  simpleBands: number[]
  proBands: EqBand[]
}

function loadPresets(): EqPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY)
    return raw ? (JSON.parse(raw) as EqPreset[]) : []
  } catch {
    return []
  }
}

function savePresets(presets: EqPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
  } catch {
    // 忽略
  }
}

export const SIMPLE_EQ_BANDS = [
  { frequency: 80, label: '低音', hint: '80Hz 以下，影响鼓点与贝斯的厚度' },
  { frequency: 250, label: '中低', hint: '250Hz，影响低频氛围与中低频饱满度' },
  { frequency: 1000, label: '中音', hint: '1kHz，影响人声与主奏乐器的存在感' },
  { frequency: 4000, label: '中高', hint: '4kHz，影响清晰度与齿音附近的临场感' },
  { frequency: 12000, label: '高音', hint: '12kHz，影响空气感与高频光泽' },
]

export function EqPanel({ controller, theme }: { controller: V3ParamsController; theme: V3Theme }) {
  const { params, patch } = controller
  const eq = params.eq
  const [presets, setPresets] = useState<EqPreset[]>(loadPresets)
  const [presetName, setPresetName] = useState('')

  const patchEq = useCallback((p: DeepPartial<V3EngineParams['eq']>) => {
    patch({ eq: { ...eq, ...p } })
  }, [patch, eq])

  const handleSavePreset = () => {
    const name = presetName.trim() || `均衡器 ${presets.length + 1}`
    if (presets.length >= 8) return
    const next = [...presets, { id: `${Date.now()}`, name, mode: eq.mode, simpleBands: [...eq.simpleBands], proBands: eq.proBands.map((b) => ({ ...b })) }]
    setPresets(next)
    savePresets(next)
    setPresetName('')
  }

  const handleApplyPreset = (preset: EqPreset) => {
    patchEq({ mode: preset.mode, simpleBands: [...preset.simpleBands], proBands: preset.proBands.map((b) => ({ ...b })) })
  }

  const handleDeletePreset = (id: string) => {
    const next = presets.filter((p) => p.id !== id)
    setPresets(next)
    savePresets(next)
  }

  const handleResetEq = () => {
    patchEq({
      simpleBands: [0, 0, 0, 0, 0],
      proBands: PRO_EQ_DEFAULT_BANDS.map((frequency) => ({ frequency, gain: 0, q: 1.1 })),
    })
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器已全部归零', type: 'info' } }))
  }

  /** 切换段数时同步重建 proBands：目标频点表包含旧频点则沿用其增益，新增频点补 0 */
  const remapBands = (count: 10 | 20) => {
    const target = count === 20 ? PRO_EQ_20_BANDS : PRO_EQ_DEFAULT_BANDS
    const next = target.map((frequency) => ({
      frequency,
      gain: eq.proBands.find((b) => Math.abs(b.frequency - frequency) < 0.5)?.gain ?? 0,
      q: 1.1,
    }))
    patchEq({ bandCount: count, proBands: next })
  }

  // 曲线编辑器数据源
  const curvePoints: EqPoint[] = eq.proBands.map((b) => ({ frequency: b.frequency, gain: b.gain }))
  const setCurveGain = (index: number, gain: number) => {
    const next = eq.proBands.map((b) => ({ ...b }))
    if (next[index]) next[index].gain = gain
    patchEq({ proBands: next })
  }

  return (
    <div className="space-y-4">
      <GlassRangeStyle theme={theme} />
      {/* 场景联动说明：场景=含 EQ 在内的整包快照，切换场景 EQ 曲线随之更新 */}
      <InfoLine theme={theme}>
        场景方案与均衡器联动：音效场景页的每个场景都是「EQ 曲线 + 全部音效」的整包预设，切换场景时本页曲线随之同步；在此微调后可到音效场景页「保存为场景」固化为预设。
      </InfoLine>
      {/* 开关 + 模式 + 段数 + Q 补偿 + 锁定 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`${theme.textPrimary} font-medium`}>均衡器</div>
            <div className={`${theme.textSecondary} text-xs`}>调整各频段的增益{params.eq.locked && '（已锁定）'}</div>
          </div>
          <div className="flex items-center gap-3">
            {params.eq.locked && <Lock className="w-4 h-4" style={{ color: theme.accentColor }} />}
            <Toggle checked={eq.enabled} onChange={(v) => patchEq({ enabled: v })} theme={theme} />
          </div>
        </div>
        {eq.enabled && (
          <div className="flex flex-wrap gap-2 mt-3">
            <div className="flex gap-1.5 flex-1 min-w-[180px]">
              {([{ value: 'simple' as const, label: '简约 5 段' }, { value: 'pro' as const, label: '专业' }]).map((m) => (
                <button key={m.value} type="button" onClick={() => patchEq({ mode: m.value })}
                  className={`flex-1 py-2 rounded-lg text-sm transition-all ${eq.mode === m.value ? 'text-white font-medium' : theme.textSecondary + ' ' + (theme.dark ? 'bg-white/5' : 'bg-black/5')}`}
                  style={eq.mode === m.value ? { backgroundColor: theme.accentColor, boxShadow: `0 4px 14px ${theme.accentColor}44` } : undefined}>
                  {m.label}
                </button>
              ))}
            </div>
            {eq.mode === 'pro' && (
              <div className="flex gap-1.5">
                {([{ value: 10 as const, label: '10 段' }, { value: 20 as const, label: '20 段' }]).map((n) => (
                  <button key={n.value} type="button" onClick={() => remapBands(n.value)}
                    className={`px-3 py-2 rounded-lg text-xs transition-all ${eq.bandCount === n.value ? 'text-white font-medium' : theme.textSecondary + ' ' + (theme.dark ? 'bg-white/5' : 'bg-black/5')}`}
                    style={eq.bandCount === n.value ? { backgroundColor: theme.accentColor } : undefined}>
                    {n.label}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2 px-3 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
              <span className={`${theme.textSecondary} text-xs`}>级联 Q 补偿</span>
              <Toggle checked={eq.qCompensation} onChange={(v) => patchEq({ qCompensation: v })} theme={theme} />
            </div>
            <button type="button" onClick={() => patchEq({ locked: !eq.locked })}
              className={`flex items-center gap-1 px-3 py-2 rounded-lg text-xs transition-all ${eq.locked ? 'text-white' : theme.textSecondary}`}
              style={eq.locked ? { backgroundColor: theme.accentColor, boxShadow: `0 0 10px ${theme.accentColor}55` } : { background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}
              title={eq.locked ? '解锁均衡器' : '锁定均衡器（防误改）'}>
              {eq.locked ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
              {eq.locked ? '已锁定' : '锁定'}
            </button>
          </div>
        )}
      </GlassCard>

      {eq.enabled && (
        <>
          {eq.mode === 'simple' ? (
            <GlassCard theme={theme}>
              <div className="space-y-3">
                <InfoLine theme={theme}>往上加重该频段、往下减弱；建议从 0 开始微调。</InfoLine>
                {SIMPLE_EQ_BANDS.map((band, i) => (
                  <div key={band.frequency}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`${theme.textSecondary} text-xs`}>{band.label}（{band.frequency}Hz）</span>
                      <span className={`${theme.textPrimary} text-xs font-medium`}>{eq.simpleBands[i] > 0 ? '+' : ''}{eq.simpleBands[i].toFixed(1)}dB</span>
                    </div>
                    <input type="range" min={-12} max={12} step={0.5} value={eq.simpleBands[i]}
                      onChange={(e) => {
                        const next = [...eq.simpleBands]
                        next[i] = parseFloat(e.target.value)
                        patchEq({ simpleBands: next })
                      }}
                      disabled={eq.locked}
                      className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer disabled:opacity-40"
                      style={{ background: theme.sliderTrack(eq.simpleBands[i], -12, 12) }} />
                    <div className={`${theme.textTertiary} text-xs mt-0.5`}>{band.hint}</div>
                  </div>
                ))}
              </div>
            </GlassCard>
          ) : (
            <GlassCard theme={theme}>
              <div className="mb-2">
                <div className={`${theme.textSecondary} text-xs`}>拖动曲线上的点调整增益（对数频率轴）{eq.qCompensation ? '；Q 补偿已开启，自动修正相邻段叠加误差' : ''}</div>
              </div>
              <EqCurveEditor
                points={curvePoints}
                theme={theme}
                onChange={eq.locked ? undefined : setCurveGain}
                readonly={eq.locked}
                height={190}
              />
              <div className="grid gap-x-4 mt-2" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                {eq.proBands.map((band, i) => (
                  <div key={band.frequency} className="mb-1.5">
                    <div className="flex items-center justify-between mb-0.5">
                      <span className={`${theme.textSecondary} text-[11px]`}>{band.frequency >= 1000 ? `${band.frequency / 1000}k` : band.frequency}Hz</span>
                      <span className={`${theme.textPrimary} text-[11px] font-medium`}>{band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}dB</span>
                    </div>
                    <input type="range" min={-12} max={12} step={0.5} value={band.gain}
                      onChange={(e) => {
                        const next = eq.proBands.map((b) => ({ ...b }))
                        next[i].gain = parseFloat(e.target.value)
                        patchEq({ proBands: next })
                      }}
                      onDoubleClick={() => {
                        const next = eq.proBands.map((b) => ({ ...b }))
                        next[i].gain = 0
                        patchEq({ proBands: next })
                      }}
                      disabled={eq.locked}
                      className="wf-glass-range w-full h-1.5 rounded-full appearance-none cursor-pointer disabled:opacity-40"
                      style={{ background: theme.sliderTrack(band.gain, -12, 12) }} />
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {/* 预设 */}
          <GlassCard theme={theme}>
            <SectionTitle theme={theme}>预设（{presets.length}/8）</SectionTitle>
            <div className="flex gap-2 mb-3">
              <TextInput value={presetName} onChange={setPresetName} placeholder="预设名称" theme={theme} className="flex-1 py-2" />
              <ActionButton onClick={handleSavePreset} disabled={presets.length >= 8} theme={theme}>
                <Save className="w-4 h-4" /> 保存
              </ActionButton>
              <ActionButton onClick={handleResetEq} theme={theme} ghost title="所有频段增益归零，恢复平坦曲线">
                <RotateCcw className="w-3 h-3" /> 清空
              </ActionButton>
            </div>
            {presets.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <div key={preset.id} className="flex items-center gap-1">
                    <button type="button" onClick={() => handleApplyPreset(preset)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-opacity hover:opacity-80 ${theme.textPrimary}`}
                      style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}`, backdropFilter: 'blur(8px)' }}>
                      {preset.name}
                    </button>
                    <button type="button" onClick={() => handleDeletePreset(preset.id)} className={`p-1 ${theme.textTertiary} hover:${theme.textPrimary}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </GlassCard>
        </>
      )}
    </div>
  )
}