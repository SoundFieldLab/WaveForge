/**
 * 开发者场景编辑器 —— 微调内置组合场景并保存为参数覆盖
 *
 * 仅在开发者模式下从「音效场景」页进入。编辑的是场景快照的工作副本；
 * 「边调边听」开启时每次改动实时下发给引擎（保留当前音量通道，不被预设覆盖），
 * 保存写入 sceneStore 覆盖层（localStorage 持久化），可一键还原出厂默认值。
 */

import { useEffect, useMemo, useState } from 'react'
import { X, RotateCcw, Save, PencilRuler, Volume2 } from 'lucide-react'
import { Toggle, Slider, Segmented, RangeStyle } from './Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import { getSceneById } from '../../src/engine/ScenePresets'
import { PRO_EQ_DEFAULT_BANDS } from '../../src/types'
import type { ScenePreset, V3EngineParams, HarmonicType, ReverbType } from '../../src/types'

interface DevSceneEditorProps {
  scene: ScenePreset & { overridden?: boolean }
  theme: HSETheme
  bridge: V3UiBridge
  controller: V3ParamsController
  onClose: () => void
  /** 保存/还原成功后回调（父级刷新场景列表） */
  onSaved: () => void
}

const EQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']

function deepCopy(p: V3EngineParams): V3EngineParams {
  return JSON.parse(JSON.stringify(p)) as V3EngineParams
}

const fmtDb = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1).replace(/\.0$/, '')}dB`

export default function DevSceneEditor({ scene, theme, bridge, controller, onClose, onSaved }: DevSceneEditorProps) {
  const [draft, setDraft] = useState<V3EngineParams>(() => deepCopy(scene.params))
  const [preview, setPreview] = useState(true)

  // Esc 关闭（不保存）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 试听必须保留实时音量通道：预设快照不得固化用户音量（与 sceneStore 入库清洗同一约束）
  const pushPreview = (next: V3EngineParams) => {
    if (!preview) return
    controller.replace({ ...deepCopy(next), loudnessNormalization: controller.params.loudnessNormalization })
  }

  const update = (mut: (d: V3EngineParams) => void) => {
    const next = deepCopy(draft)
    mut(next)
    setDraft(next)
    pushPreview(next)
  }

  const setEqGain = (i: number, gain: number) => {
    update((d) => {
      d.eq.enabled = true
      d.eq.mode = 'pro'
      d.eq.bandCount = Math.max(d.eq.bandCount || 10, 10) as typeof d.eq.bandCount
      const bands = [...(d.eq.proBands ?? [])]
      while (bands.length < PRO_EQ_DEFAULT_BANDS.length) {
        bands.push({ frequency: PRO_EQ_DEFAULT_BANDS[bands.length], gain: 0, q: 1.1 })
      }
      bands[i] = { ...bands[i], gain }
      d.eq.proBands = bands
    })
  }

  const handleSave = () => {
    const ok = bridge.updateBuiltinScene(scene.id, draft)
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: ok
        ? { message: `已把微调保存进「${scene.name}」，重启后仍生效`, type: 'info' }
        : { message: '仅内置场景支持微调保存', type: 'error' },
    }))
    if (ok) onSaved()
  }

  const handleReset = () => {
    bridge.resetBuiltinScene(scene.id)
    // 以「还原后立刻生效的官方默认」为准（发布种子可能带默认覆盖，非代码原值）
    const effective = bridge.getScenes().find((s) => s.id === scene.id) ?? getSceneById(scene.id)
    if (effective) {
      setDraft(deepCopy(effective.params))
      pushPreview(effective.params)
    }
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `「${scene.name}」已还原为当前官方默认`, type: 'info' } }))
    onSaved()
  }

  const eqBands = useMemo(() => {
    const list = draft.eq.proBands ?? []
    return Array.from({ length: PRO_EQ_DEFAULT_BANDS.length }, (_, i) =>
      list[i] ?? { frequency: PRO_EQ_DEFAULT_BANDS[i], gain: 0, q: 1.1 },
    )
  }, [draft.eq.proBands])

  const sectionStyle = { background: theme.cardBg, border: `1px solid ${theme.cardBorder}` }
  const titleCls = `${theme.textSecondary} text-[11px] font-medium tracking-wide`

  return (
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)' }}
      onClick={onClose}
    >
      <RangeStyle theme={theme} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`编辑场景 ${scene.name}`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-3xl"
        style={{
          background: theme.panelBg,
          backdropFilter: theme.glassBlur,
          WebkitBackdropFilter: theme.glassBlur,
          border: `1px solid ${theme.panelBorder}`,
          boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
          outline: 'none',
        }}
      >
        {/* 头部 */}
        <div className="sticky top-0 z-10 px-5 pt-4 pb-3 flex items-center justify-between"
          style={{ background: theme.panelBg, borderBottom: `1px solid ${theme.panelBorder}` }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center"
              style={{ background: `${theme.accentColor}22`, border: `1px solid ${theme.accentColor}55` }}>
              <PencilRuler className="w-5 h-5" style={{ color: theme.accentColor }} />
            </div>
            <div>
              <div className={`${theme.textPrimary} text-sm font-semibold`}>编辑场景 · {scene.name}</div>
              <div className={`${theme.textTertiary} text-[10px]`}>
                开发者模式{scene.overridden ? ' · 已有本地微调' : ''}
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition-colors">
            <X className="w-4 h-4 text-white/60" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* 边调边听 */}
          <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={sectionStyle}>
            <div className="flex items-center gap-2 min-w-0">
              <Volume2 className="w-4 h-4 shrink-0" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-xs shrink-0`}>边调边听</span>
              <span className={`${theme.textTertiary} text-[10px] truncate`}>(改动即时下发引擎，不影响音量)</span>
            </div>
            <Toggle checked={preview} onChange={setPreview} theme={theme} />
          </div>

          {/* EQ 10 段 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <div className="flex items-center justify-between mb-1">
              <span className={titleCls}>均衡器（专业 10 段）</span>
              <Toggle checked={draft.eq.enabled} onChange={(v) => update((d) => { d.eq.enabled = v })} theme={theme} />
            </div>
            <div className="grid grid-cols-5 gap-x-4 gap-y-1">
              {eqBands.map((b, i) => (
                <Slider
                  key={`${EQ_LABELS[i]}-${i}`}
                  label={EQ_LABELS[i] ?? String(i)}
                  value={b.gain}
                  min={-12}
                  max={12}
                  step={0.5}
                  display={fmtDb(b.gain)}
                  onChange={(v) => setEqGain(i, v)}
                  theme={theme}
                />
              ))}
            </div>
          </div>

          {/* 动态压缩 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <div className="flex items-center justify-between mb-1">
              <span className={titleCls}>动态压缩</span>
              <Toggle checked={draft.compressor.enabled} onChange={(v) => update((d) => { d.compressor.enabled = v })} theme={theme} />
            </div>
            <Slider label="阈值" value={draft.compressor.thresholdDb} min={-60} max={0} step={1} display={`${Math.round(draft.compressor.thresholdDb)}dB`}
              onChange={(v) => update((d) => { d.compressor.thresholdDb = v })} theme={theme} />
            <Slider label="比率" value={draft.compressor.ratio} min={1} max={20} step={0.1} display={`${draft.compressor.ratio.toFixed(1)}:1`}
              onChange={(v) => update((d) => { d.compressor.ratio = v })} theme={theme} />
            <Slider label="拐点" value={draft.compressor.kneeDb} min={0} max={24} step={1} display={`${Math.round(draft.compressor.kneeDb)}dB`}
              onChange={(v) => update((d) => { d.compressor.kneeDb = v })} theme={theme} />
            <Slider label="启动" value={draft.compressor.attackMs} min={0} max={100} step={1} display={`${Math.round(draft.compressor.attackMs)}ms`}
              onChange={(v) => update((d) => { d.compressor.attackMs = v })} theme={theme} />
            <Slider label="释放" value={draft.compressor.releaseMs} min={20} max={1000} step={10} display={`${Math.round(draft.compressor.releaseMs)}ms`}
              onChange={(v) => update((d) => { d.compressor.releaseMs = v })} theme={theme} />
            <Slider label="补偿增益" value={draft.compressor.makeupDb} min={-12} max={24} step={0.5} display={fmtDb(draft.compressor.makeupDb)}
              onChange={(v) => update((d) => { d.compressor.makeupDb = v })} theme={theme} />
          </div>

          {/* 低音增强 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <div className="flex items-center justify-between mb-1">
              <span className={titleCls}>低音增强</span>
              <Toggle checked={draft.bassEnhancer.enabled} onChange={(v) => update((d) => { d.bassEnhancer.enabled = v })} theme={theme} />
            </div>
            <div className="flex items-center justify-between gap-3 py-1">
              <span className={`${theme.textTertiary} text-[11px] shrink-0`}>谐波类型</span>
              <Segmented<HarmonicType>
                options={[{ value: 'odd', label: '奇次' }, { value: 'even', label: '偶次' }, { value: 'atan', label: 'ATSR' }, { value: 'soft', label: 'tanh' }]}
                value={draft.bassEnhancer.harmonicType}
                onChange={(v) => update((d) => { d.bassEnhancer.harmonicType = v })}
                theme={theme}
                small
              />
            </div>
            <Slider label="截止频率" value={draft.bassEnhancer.cutoffHz} min={40} max={300} step={5} display={`${Math.round(draft.bassEnhancer.cutoffHz)}Hz`}
              onChange={(v) => update((d) => { d.bassEnhancer.cutoffHz = v })} theme={theme} />
            <Slider label="低音下潜" value={draft.bassEnhancer.lowBoostDb} min={-6} max={12} step={0.5} display={fmtDb(draft.bassEnhancer.lowBoostDb)}
              onChange={(v) => update((d) => { d.bassEnhancer.lowBoostDb = v })} theme={theme} />
            <Slider label="谐波增益" value={draft.bassEnhancer.harmonicGain} min={0} max={1} step={0.05} display={`${Math.round(draft.bassEnhancer.harmonicGain * 100)}%`}
              onChange={(v) => update((d) => { d.bassEnhancer.harmonicGain = v })} theme={theme} />
            <Slider label="干湿混合" value={draft.bassEnhancer.mix} min={0} max={1} step={0.05} display={`${Math.round(draft.bassEnhancer.mix * 100)}%`}
              onChange={(v) => update((d) => { d.bassEnhancer.mix = v })} theme={theme} />
            <Slider label="整体电平" value={draft.bassEnhancer.levelDb} min={-6} max={6} step={0.5} display={fmtDb(draft.bassEnhancer.levelDb)}
              onChange={(v) => update((d) => { d.bassEnhancer.levelDb = v })} theme={theme} />
          </div>

          {/* 齿音抑制 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <div className="flex items-center justify-between mb-1">
              <span className={titleCls}>齿音抑制</span>
              <Toggle checked={draft.deesser.enabled} onChange={(v) => update((d) => { d.deesser.enabled = v })} theme={theme} />
            </div>
            <Slider label="中心频率" value={draft.deesser.centerHz} min={4000} max={9000} step={50}
              display={`${draft.deesser.centerHz >= 1000 ? (draft.deesser.centerHz / 1000).toFixed(1) + 'k' : Math.round(draft.deesser.centerHz)}Hz`}
              onChange={(v) => update((d) => { d.deesser.centerHz = v })} theme={theme} />
            <Slider label="触发阈值" value={draft.deesser.thresholdDb} min={-60} max={-6} step={1} display={`${Math.round(draft.deesser.thresholdDb)}dB`}
              onChange={(v) => update((d) => { d.deesser.thresholdDb = v })} theme={theme} />
            <Slider label="压缩比率" value={draft.deesser.ratio} min={1} max={20} step={0.5} display={`${draft.deesser.ratio.toFixed(1)}:1`}
              onChange={(v) => update((d) => { d.deesser.ratio = v })} theme={theme} />
            <Slider label="混合" value={draft.deesser.mix} min={0} max={1} step={0.05} display={`${Math.round(draft.deesser.mix * 100)}%`}
              onChange={(v) => update((d) => { d.deesser.mix = v })} theme={theme} />
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className={`${theme.textTertiary} text-[11px] shrink-0`}>工作方式</span>
              <Segmented<boolean>
                options={[{ value: true, label: '分带式' }, { value: false, label: '宽带式' }]}
                value={draft.deesser.splitBand}
                onChange={(v) => update((d) => { d.deesser.splitBand = v })}
                theme={theme}
                small
              />
            </div>
          </div>

          {/* 算法混响 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <div className="flex items-center justify-between mb-1">
              <span className={titleCls}>混响（算法）</span>
              <Toggle
                checked={draft.reverb.enabled && draft.reverb.mode !== 'off'}
                onChange={(v) => update((d) => { d.reverb.enabled = v; if (d.reverb.mode === 'off') d.reverb.mode = 'algorithmic' })}
                theme={theme}
              />
            </div>
            <div className="flex items-center justify-between gap-3 py-1">
              <span className={`${theme.textTertiary} text-[11px] shrink-0`}>空间类型</span>
              <Segmented<ReverbType>
                options={[{ value: 'hall', label: '大厅' }, { value: 'room', label: '房间' }, { value: 'plate', label: '板式' }, { value: 'spring', label: '弹簧' }, { value: 'stage', label: '舞台' }]}
                value={draft.reverb.algorithmic.type}
                onChange={(v) => update((d) => { d.reverb.algorithmic.type = v })}
                theme={theme}
                small
              />
            </div>
            <Slider label="房间大小" value={draft.reverb.algorithmic.roomSize} min={0.1} max={1} step={0.05} display={`${Math.round(draft.reverb.algorithmic.roomSize * 100)}%`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.roomSize = v })} theme={theme} />
            <Slider label="阻尼" value={draft.reverb.algorithmic.damping} min={0} max={1} step={0.05} display={`${Math.round(draft.reverb.algorithmic.damping * 100)}%`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.damping = v })} theme={theme} />
            <Slider label="湿度" value={draft.reverb.algorithmic.wet} min={0} max={1} step={0.05} display={`${Math.round(draft.reverb.algorithmic.wet * 100)}%`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.wet = v })} theme={theme} />
            <Slider label="干度" value={draft.reverb.algorithmic.dry} min={0} max={1} step={0.05} display={`${Math.round(draft.reverb.algorithmic.dry * 100)}%`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.dry = v })} theme={theme} />
            <Slider label="预延迟" value={draft.reverb.algorithmic.preDelayMs} min={0} max={120} step={1} display={`${Math.round(draft.reverb.algorithmic.preDelayMs)}ms`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.preDelayMs = v })} theme={theme} />
            <Slider label="混响声场宽" value={draft.reverb.algorithmic.width} min={0} max={2} step={0.05} display={`${draft.reverb.algorithmic.width.toFixed(2)}x`}
              onChange={(v) => update((d) => { d.reverb.algorithmic.width = v })} theme={theme} />
          </div>

          {/* 声场 / 夜间 / 等响度补偿 */}
          <div className="rounded-xl p-3 space-y-1" style={sectionStyle}>
            <span className={titleCls}>声场与响度</span>
            <Slider label="M/S 立体声宽度" value={draft.stereoWidth} min={0} max={2} step={0.05} display={`${draft.stereoWidth.toFixed(2)}x`}
              onChange={(v) => update((d) => { d.stereoWidth = v })} theme={theme} />
            <div className="flex items-center justify-between">
              <span className={`${theme.textTertiary} text-[11px]`}>夜间模式</span>
              <Toggle checked={draft.nightMode.enabled} onChange={(v) => update((d) => { d.nightMode.enabled = v })} theme={theme} />
            </div>
            <Slider label="夜间强度" value={draft.nightMode.amount} min={0} max={10} step={0.5} display={draft.nightMode.amount.toFixed(1)}
              onChange={(v) => update((d) => { d.nightMode.amount = v; if (!d.nightMode.enabled && v > 0) d.nightMode.enabled = true })} theme={theme} />
            <div className="flex items-center justify-between pt-1">
              <span className={`${theme.textTertiary} text-[11px]`}>等响度补偿</span>
              <Toggle checked={draft.loudnessCompensation.enabled} onChange={(v) => update((d) => { d.loudnessCompensation.enabled = v })} theme={theme} />
            </div>
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className={`${theme.textTertiary} text-[11px] shrink-0`}>补偿曲线</span>
              <Segmented<string>
                options={[
                  { value: 'flat', label: '平直' }, { value: 'bass', label: '低频' }, { value: 'vocal', label: '人声' },
                  { value: 'warm', label: '温暖' }, { value: 'bright', label: '通透' }, { value: 'night', label: '夜间' },
                ]}
                value={draft.loudnessCompensation.preset}
                onChange={(v) => update((d) => {
                  d.loudnessCompensation.preset = v
                  d.loudnessCompensation.mode = 'preset'
                })}
                theme={theme}
                small
              />
            </div>
          </div>
        </div>

        {/* 底部操作条 */}
        <div className="sticky bottom-0 z-10 px-5 py-3 flex items-center gap-2"
          style={{ background: theme.panelBg, borderTop: `1px solid ${theme.panelBorder}` }}>
          <button
            type="button"
            onClick={handleReset}
            disabled={!scene.overridden}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white/60 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
          >
            <RotateCcw className="w-3 h-3" /> 还原出厂
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-xs text-white/70 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
          >
            关闭
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all hover:brightness-110"
            style={{ backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 4px 14px ${theme.accentColor}44` }}
          >
            <Save className="w-3.5 h-3.5" /> 保存到此场景
          </button>
        </div>
      </div>
    </div>
  )
}
