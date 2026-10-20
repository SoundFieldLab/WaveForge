/**
 * WaveForge v3 调音室 UI —— 均衡器页
 *
 * v3 EQ：简约 5 段 / 专业 1–64 段 + 级联 Q 补偿 + 锁定 + 曲线编辑器拖拽。
 * 预设（localStorage）格式：{mode, simpleBands, proBands}；完整 v3 分享串见调音器页。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Save, Trash2, RotateCcw, Lock, LockOpen, Info } from 'lucide-react'
import { PRO_EQ_DEFAULT_BANDS, PRO_EQ_20_BANDS, PRO_EQ_64_BANDS, MAX_PRO_EQ_BANDS } from '../src/types'
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

const FILTER_TYPE_OPTIONS: { value: NonNullable<EqBand['type']>; label: string }[] = [
  { value: 'peaking', label: '峰值' },
  { value: 'lowshelf', label: '低架' },
  { value: 'highshelf', label: '高架' },
  { value: 'lowpass', label: '低通' },
  { value: 'highpass', label: '高通' },
  { value: 'bandpass', label: '带通' },
  { value: 'notch', label: '陷波' },
  { value: 'allpass', label: '全通' },
]

function hasGainControl(type: EqBand['type']): boolean {
  return type === undefined || type === 'peaking' || type === 'lowshelf' || type === 'highshelf'
}

function BandNumberInput({ label, value, min, max, step, decimals, unit, disabled, theme, onCommit }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  decimals: number
  unit: string
  disabled: boolean
  theme: V3Theme
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(value.toFixed(decimals))
  const [editing, setEditing] = useState(false)
  const editingRef = useRef(false)
  const commit = () => {
    if (!editingRef.current) return
    editingRef.current = false
    const parsed = Number(draft)
    if (draft.trim() && Number.isFinite(parsed)) {
      const next = Number(Math.min(max, Math.max(min, parsed)).toFixed(decimals))
      if (next !== value) onCommit(next)
    }
    setEditing(false)
  }
  return (
    <label className={`${theme.textSecondary} text-[11px]`}>
      <span className="block mb-1">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" min={min} max={max} step={step} value={editing ? draft : value.toFixed(decimals)} disabled={disabled}
          onFocus={() => { setDraft(value.toFixed(decimals)); editingRef.current = true; setEditing(true) }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); e.currentTarget.blur() }
            if (e.key === 'Escape') { e.preventDefault(); editingRef.current = false; setEditing(false); e.currentTarget.blur() }
          }}
          className={`hse-glass-input min-w-0 flex-1 rounded-md px-2 py-1.5 text-xs tabular-nums outline-none focus-visible:ring-2 disabled:cursor-not-allowed ${theme.textPrimary}`} />
        <span>{unit}</span>
      </div>
    </label>
  )
}

export function EqPanel({ controller, theme, quickPresets }: { controller: V3ParamsController; theme: V3Theme; quickPresets?: ReactNode }) {
  const { params, patch } = controller
  const eq = params.eq
  const [presets, setPresets] = useState<EqPreset[]>(loadPresets)
  const [presetName, setPresetName] = useState('')
  const [selectedBand, setSelectedBand] = useState(0)
  const activeBandIndex = Math.min(selectedBand, Math.max(0, eq.proBands.length - 1))

  useEffect(() => {
    setSelectedBand((index) => Math.min(index, Math.max(0, eq.proBands.length - 1)))
  }, [eq.proBands.length])

  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Number.isFinite(value) ? value : min))

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
    const bands = preset.proBands.slice(0, MAX_PRO_EQ_BANDS)
    patchEq({ mode: preset.mode, bandCount: Math.max(1, bands.length), simpleBands: [...preset.simpleBands], proBands: bands.map((b) => ({ ...b })) })
  }

  const handleDeletePreset = (id: string) => {
    const next = presets.filter((p) => p.id !== id)
    setPresets(next)
    savePresets(next)
  }

  const handleResetEq = () => {
    patchEq({
      simpleBands: [0, 0, 0, 0, 0],
      proBands: eq.proBands.map((band) => ({ ...band, gain: 0, type: 'peaking' as const })),
    })
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '均衡器已全部归零', type: 'info' } }))
  }

  /**
   * 切换段数时同步重建 proBands：目标频点表包含旧频点则沿用其增益，新增频点补 0。
   * 64 段为近 1/6 倍频程布局，新频段默认 Q=8.9（与场景预设同一临界 Q），保证密集段不糊成一片。
   */
  const remapBands = (count: 10 | 20 | 64) => {
    const target = count === 20 ? PRO_EQ_20_BANDS : count === 64 ? PRO_EQ_64_BANDS : PRO_EQ_DEFAULT_BANDS
    const next = target.map((frequency) => {
      const existing = eq.proBands.find((band) => Math.abs(band.frequency - frequency) < 0.5)
      return { frequency, gain: existing?.gain ?? 0, q: existing?.q ?? (count === 64 ? 8.9 : 1.1), type: existing?.type }
    })
    const selectedFrequency = eq.proBands[activeBandIndex]?.frequency ?? next[0].frequency
    setSelectedBand(next.reduce((nearest, band, index) =>
      Math.abs(Math.log(band.frequency / selectedFrequency)) < Math.abs(Math.log(next[nearest].frequency / selectedFrequency)) ? index : nearest, 0))
    patchEq({ bandCount: count, proBands: next })
  }

  const addBand = () => {
    if (eq.locked || eq.proBands.length >= MAX_PRO_EQ_BANDS) return
    const next = eq.proBands.map((band) => ({ ...band })).sort((a, b) => a.frequency - b.frequency)
    let low = 20, bestLow = 20, bestHigh = 20000, largest = 0
    for (const high of [...next.map((band) => band.frequency), 20000]) {
      const gap = Math.log(high / low)
      if (gap > largest) { largest = gap; bestLow = low; bestHigh = high }
      low = high
    }
    const frequency = Math.sqrt(bestLow * bestHigh)
    const index = next.findIndex((band) => band.frequency > frequency)
    const insertion = index < 0 ? next.length : index
    next.splice(insertion, 0, { frequency, gain: 0, q: 1.1, type: 'peaking' })
    setSelectedBand(insertion)
    patchEq({ proBands: next, bandCount: next.length })
  }

  const removeBand = () => {
    if (eq.locked || eq.proBands.length <= 1) return
    const next = eq.proBands.filter((_, index) => index !== activeBandIndex)
    setSelectedBand(Math.min(activeBandIndex, next.length - 1))
    patchEq({ proBands: next, bandCount: next.length })
  }

  // 曲线编辑器数据源
  const curvePoints: EqPoint[] = eq.proBands.map((b) => ({ frequency: b.frequency, gain: hasGainControl(b.type) ? b.gain : 0 }))
  const setCurveGain = (index: number, gain: number) => {
    if (!hasGainControl(eq.proBands[index]?.type)) return
    const next = eq.proBands.map((b) => ({ ...b }))
    if (next[index]) next[index].gain = gain
    patchEq({ proBands: next })
  }

  const setBandField = (index: number, field: keyof EqBand, value: number) => {
    const next = eq.proBands.map((band) => ({ ...band }))
    const band = next[index]
    if (!band) return
    if (field === 'frequency') {
      const low = next[index - 1] ? Math.max(20, next[index - 1].frequency + 0.1) : 20
      const high = next[index + 1] ? Math.min(20000, next[index + 1].frequency - 0.1) : 20000
      band.frequency = Number(clamp(value, low, high).toFixed(1))
    } else if (field === 'gain') band.gain = clamp(value, -20, 20)
    else band.q = clamp(value, 0.1, 10)
    patchEq({ proBands: next })
  }

  const setBandType = (index: number, type: NonNullable<EqBand['type']>) => {
    const next = eq.proBands.map((band) => ({ ...band }))
    const band = next[index]
    if (!band) return
    // peaking 是历史默认值，写入它也能让分享串明确表达当前滤波器类型。
    band.type = type
    patchEq({ proBands: next })
  }

  return (
    <div className="@container space-y-5">
      <GlassRangeStyle theme={theme} />
      {/* 开关 + 模式 + 段数 + Q 补偿 + 锁定 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`${theme.textPrimary} font-medium`}>均衡器</div>
            <div className={`${theme.textSecondary} text-xs`}>调整各频段的增益{params.eq.locked && '（已锁定）'}</div>
          </div>
          <div className="flex items-center gap-3">
            {params.eq.locked && <Lock className="w-4 h-4" style={{ color: theme.accentColor }} />}
            <Toggle label="启用均衡器" checked={eq.enabled} onChange={(v) => patchEq({ enabled: v })} theme={theme} />
          </div>
        </div>
        {eq.enabled && (
          <div className="flex flex-wrap items-end gap-x-5 gap-y-4 mt-5 pt-4" style={{ borderTop: `1px solid ${theme.glassBorder}` }}>
            <div className="min-w-[190px] flex-1">
              <div className={`${theme.textSecondary} text-xs mb-2`}>编辑模式</div>
              <div className="hse-glass-group flex gap-1 rounded-xl p-1">
              {([{ value: 'simple' as const, label: '简约 5 段' }, { value: 'pro' as const, label: '专业' }]).map((m) => (
                <button key={m.value} type="button" onClick={() => patchEq({ mode: m.value })}
                  aria-pressed={eq.mode === m.value}
                  className={`hse-glass-choice flex-1 px-3 py-2 rounded-lg text-sm focus-visible:outline focus-visible:outline-2 ${eq.mode === m.value ? 'font-medium' : theme.textSecondary}`}>
                  {m.label}
                </button>
              ))}
              </div>
            </div>
            {eq.mode === 'pro' && (
              <div>
                <div className={`${theme.textSecondary} text-xs mb-2`}>频段数</div>
                <div className="hse-glass-group flex flex-wrap gap-1 rounded-xl p-1">
                {([{ value: 10 as const, label: '10 段' }, { value: 20 as const, label: '20 段' }, { value: 64 as const, label: '64 段' }]).map((n) => (
                  <button key={n.value} type="button" disabled={eq.locked} onClick={() => remapBands(n.value)} aria-pressed={eq.bandCount === n.value}
                    className={`hse-glass-choice px-3 py-2 rounded-lg text-sm focus-visible:outline focus-visible:outline-2 ${eq.bandCount === n.value ? 'font-medium' : theme.textSecondary}`}>
                    {n.label}
                  </button>
                ))}
                <button type="button" disabled={eq.locked || eq.proBands.length >= MAX_PRO_EQ_BANDS} onClick={addBand}
                  className={`hse-glass-choice rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.textSecondary}`}>添加频段</button>
                <button type="button" disabled={eq.locked || eq.proBands.length <= 1} onClick={removeBand}
                  className={`hse-glass-choice rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.textSecondary}`}>删除选中频段</button>
                </div>
                <div className={`${theme.textTertiary} mt-1 text-xs`}>{eq.proBands.length} / {MAX_PRO_EQ_BANDS} 段 · 内置预设微调集中在 30Hz–16kHz（次声/超声区保持平直）</div>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 pb-1">
            <div className="flex items-center gap-3 px-1 py-2">
              <span className={`${theme.textSecondary} text-xs`}>级联 Q 补偿</span>
              <Toggle label="级联 Q 补偿" checked={eq.qCompensation} onChange={(v) => patchEq({ qCompensation: v })} theme={theme} />
            </div>
            <button type="button" onClick={() => patchEq({ locked: !eq.locked })}
              aria-pressed={eq.locked}
              className={`hse-glass-choice flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs focus-visible:outline focus-visible:outline-2 ${eq.locked ? '' : theme.textSecondary}`}
              title={eq.locked ? '解锁均衡器' : '锁定均衡器（防误改）'}>
              {eq.locked ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
              {eq.locked ? '已锁定' : '锁定'}
            </button>
            </div>
          </div>
        )}
      </GlassCard>

      {!eq.enabled && (
        <GlassCard theme={theme}>
          <div className="flex items-start gap-3">
            <Info aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" style={{ color: theme.accentColor }} />
            <div className="min-w-0">
              <div className={`${theme.textPrimary} text-sm font-medium`}>均衡器已旁路</div>
              <div className={`${theme.textSecondary} mt-1 text-xs leading-relaxed`}>
                打开上方「启用均衡器」可编辑频段曲线、Q 值与滤波器类型；关闭时音频完全直通，不做任何频段处理。
              </div>
            </div>
          </div>
        </GlassCard>
      )}

      {quickPresets}

      {eq.enabled && (
        <>
          {eq.mode === 'simple' ? (
            <GlassCard theme={theme}>
              <div className="space-y-4">
                <InfoLine theme={theme}>往上加重该频段、往下减弱；建议从 0 开始微调。</InfoLine>
                <div className="grid gap-3 @min-[38rem]:grid-cols-2 @min-[58rem]:grid-cols-3">
                {SIMPLE_EQ_BANDS.map((band, i) => (
                  <div key={band.frequency} className="min-w-0 rounded-xl border p-3" style={{ background: theme.inputBg, borderColor: theme.glassBorder }}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`${theme.textSecondary} text-xs`}>{band.label}（{band.frequency}Hz）</span>
                      <span className={`${theme.textPrimary} text-xs font-medium tabular-nums`}>{eq.simpleBands[i] > 0 ? '+' : ''}{eq.simpleBands[i].toFixed(1)} dB</span>
                    </div>
                    <input type="range" min={-12} max={12} step={0.5} value={eq.simpleBands[i]} aria-label={`${band.label}增益`}
                      onChange={(e) => {
                        const next = [...eq.simpleBands]
                        next[i] = parseFloat(e.target.value)
                        patchEq({ simpleBands: next })
                      }}
                      disabled={eq.locked}
                      className="wf-glass-range hse-glass-range w-full h-2 rounded-full appearance-none cursor-pointer disabled:opacity-40"
                      style={{ background: theme.sliderTrack(eq.simpleBands[i], -12, 12) }} />
                    <div className={`${theme.textTertiary} text-xs mt-0.5`}>{band.hint}</div>
                  </div>
                ))}
                </div>
              </div>
            </GlassCard>
          ) : (
            <GlassCard theme={theme}>
              <div className="mb-4">
                <div className={`${theme.textSecondary} text-xs`}>拖动曲线上的点调整增益（对数频率轴）{eq.qCompensation ? '；Q 补偿已开启，自动修正相邻段叠加误差' : ''}</div>
              </div>
              <EqCurveEditor
                points={curvePoints}
                theme={theme}
                onChange={eq.locked ? undefined : setCurveGain}
                onSelect={setSelectedBand}
                selectedIndex={activeBandIndex}
                readonly={eq.locked}
                height={190}
                minDb={-20}
                maxDb={20}
              />
              {eq.proBands[activeBandIndex] && (
                <div className="grid grid-cols-2 @min-[680px]:grid-cols-4 gap-3 mt-4 rounded-xl p-3" aria-label="选中频段数值编辑" style={{ background: theme.inputBg }}>
                  {(['frequency', 'gain', 'q'] as const).map((field) => {
                    const band = eq.proBands[activeBandIndex]
                    const limits = field === 'frequency' ? { min: 20, max: 20000, step: 0.1, decimals: 1, unit: 'Hz' } : field === 'gain' ? { min: -20, max: 20, step: 0.1, decimals: 1, unit: 'dB' } : { min: 0.1, max: 10, step: 0.01, decimals: 2, unit: '' }
                    const labels = { frequency: '频率', gain: '增益', q: 'Q 值' }
                    return (
                      <BandNumberInput key={`${activeBandIndex}-${field}`} label={labels[field]} value={band[field]} min={limits.min} max={limits.max} step={limits.step} decimals={limits.decimals} unit={limits.unit} disabled={eq.locked || (field === 'gain' && !hasGainControl(band.type))} theme={theme}
                        onCommit={(value) => setBandField(activeBandIndex, field, value)} />
                    )
                  })}
                  <label className={`${theme.textSecondary} text-[11px]`}>
                    <span className="block mb-1">滤波器类型</span>
                    <select
                      value={eq.proBands[activeBandIndex].type ?? 'peaking'}
                      disabled={eq.locked}
                      aria-label="滤波器类型"
                      onChange={(e) => setBandType(activeBandIndex, e.target.value as NonNullable<EqBand['type']>)}
                      className={`hse-glass-input w-full rounded-md px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:cursor-not-allowed ${theme.textPrimary}`}
                    >
                      {FILTER_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </label>
                </div>
              )}
              <div className="grid grid-cols-2 @min-[680px]:grid-cols-3 @min-[900px]:grid-cols-4 gap-x-4 gap-y-2 mt-5">
                {eq.proBands.map((band, i) => (
                  <div key={i} className="rounded-lg p-2 text-left transition-colors"
                    style={{ background: activeBandIndex === i ? `${theme.accentColor}20` : 'transparent', outline: activeBandIndex === i ? `1px solid ${theme.accentColor}` : undefined }}>
                    <div className="flex items-center justify-between mb-0.5">
                      <button type="button" onClick={() => setSelectedBand(i)} aria-pressed={activeBandIndex === i} className={`${theme.textSecondary} text-[11px] tabular-nums underline-offset-2 hover:underline ${activeBandIndex === i ? 'font-semibold' : ''}`}>{Number(band.frequency.toFixed(1))} Hz</button>
                      <span className={`${theme.textPrimary} text-[11px] font-medium tabular-nums`}>
                        {FILTER_TYPE_OPTIONS.find((option) => option.value === (band.type ?? 'peaking'))?.label ?? '峰值'} · {hasGainControl(band.type) ? `${band.gain > 0 ? '+' : ''}${band.gain.toFixed(1)} dB` : '固定形状'}
                      </span>
                    </div>
                    <input type="range" min={-20} max={20} step={0.1} value={band.gain} aria-label={`${Number(band.frequency.toFixed(1))} Hz 增益`}
                      onFocus={() => setSelectedBand(i)}
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
                      disabled={eq.locked || !hasGainControl(band.type)}
                      className="wf-glass-range hse-glass-range w-full h-1.5 rounded-full appearance-none cursor-pointer disabled:opacity-40"
                      style={{ background: theme.sliderTrack(band.gain, -20, 20) }} />
                  </div>
                ))}
              </div>
            </GlassCard>
          )}

          {/* 我的预设与场景联动 */}
          <GlassCard theme={theme}>
            <SectionTitle theme={theme}>我的均衡器预设（{presets.length}/8）</SectionTitle>
            <div className="flex flex-wrap items-end gap-2 mb-4">
              <label className={`flex min-w-[180px] flex-1 flex-col gap-1.5 text-xs ${theme.textSecondary}`}>
                <span>预设名称</span>
                <TextInput value={presetName} onChange={setPresetName} label="预设名称" placeholder="为当前曲线命名" theme={theme} className="w-full py-2" />
              </label>
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
                      className={`hse-glass-button px-3 py-2 rounded-lg text-xs ${theme.textPrimary}`}>
                      {preset.name}
                    </button>
                    <button type="button" onClick={() => handleDeletePreset(preset.id)} aria-label={`删除均衡器预设「${preset.name}」`} className={`hse-glass-button rounded-lg p-2 ${theme.textTertiary}`}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 pt-4" style={{ borderTop: `1px solid ${theme.glassBorder}` }}>
              <InfoLine theme={theme}>
                场景方案与均衡器联动：音效场景页的每个场景都是「EQ 曲线 + 全部音效」的整包预设，切换场景时本页曲线随之同步；在此微调后可到音效场景页「保存为场景」固化为预设。
              </InfoLine>
            </div>
          </GlassCard>
        </>
      )}
    </div>
  )
}