/**
 * WaveForge v3 调音室 UI —— 动态/调音类效果配置弹窗
 *
 * 动态压缩、齿音抑制、夜间模式、限幅器、智能均衡（IEQ）、变速变调、立体声宽度。
 * 使用 HSE 公共面板、数值滑块和独立启停控件。
 */

import { useRef } from 'react'
import { Activity, Mic2, Moon, Shield, Sparkles, Music, Columns2 } from 'lucide-react'
import type { V3Theme } from './theme'
import { InfoLine, Modal, Segmented, Slider, Toggle } from './primitives'
import type { V3ParamsController } from './hooks'
import { createDefaultParams } from '../src/types'
import type { MultibandBandSettings } from '../src/types'
import type { DynamicEqBandSettings } from '../src/dsp/DynamicEq'

/* ─────────────────────────── X-Y 触控板（声场拟物化） ─────────────────────────── */

/** 二维触控板：X/Y 双参数同时拖拽，替代两个独立左右滑块（规划书 B4「拟物化旋钮」） */
function XYPad({ x, y, xMin, xMax, yMin, yMax, xCenter, yCenter, onChange, theme, xLabels, yLabels, yDisabled = false }: {
  x: number
  y: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  xCenter: number
  yCenter: number
  onChange: (x: number, y: number) => void
  theme: V3Theme
  xLabels: { pos: number; label: string }[]
  yLabels: { pos: number; label: string }[]
  yDisabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const xPct = ((x - xMin) / (xMax - xMin)) * 100
  const yPct = (1 - (y - yMin) / (yMax - yMin)) * 100
  const cxPct = ((xCenter - xMin) / (xMax - xMin)) * 100
  const cyPct = (1 - (yCenter - yMin) / (yMax - yMin)) * 100

  const handle = (clientX: number, clientY: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    const nx = xMin + fx * (xMax - xMin)
    const ny = yMin + (1 - fy) * (yMax - yMin)
    onChange(Math.round(nx * 100) / 100, yDisabled ? y : Math.round(ny * 100) / 100)
  }

  return (
    <div role="group" aria-label="立体声宽度和中央差分比例二维调节，下方滑块可使用键盘精调" className="relative w-full rounded-xl overflow-hidden touch-none select-none" style={{ height: 180, background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
      <div
        ref={ref}
        className="absolute inset-0 cursor-crosshair"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handle(e.clientX, e.clientY) }}
        onPointerMove={(e) => { if (e.buttons === 1) handle(e.clientX, e.clientY) }}
      >
        {/* 网格 */}
        {[25, 50, 75].map((p) => (
          <div key={`v${p}`} className="absolute top-0 bottom-0" style={{ left: `${p}%`, width: 1, background: theme.glassBorder }} />
        ))}
        {[25, 50, 75].map((p) => (
          <div key={`h${p}`} className="absolute left-0 right-0" style={{ top: `${p}%`, height: 1, background: theme.glassBorder }} />
        ))}
        {/* 中心十字（原声基准点） */}
        <div className="absolute top-0 bottom-0" style={{ left: `${cxPct}%`, width: 1, background: `${theme.accentColor}66` }} />
        <div className="absolute left-0 right-0" style={{ top: `${cyPct}%`, height: 1, background: `${theme.accentColor}66` }} />
        {/* 拖拽手柄 */}
        <div
          className="absolute rounded-full"
          style={{
            left: `${xPct}%`, top: `${yPct}%`, width: 16, height: 16, transform: 'translate(-50%, -50%)',
            background: theme.accentColor, boxShadow: '0 0 0 4px #c8ede4',
          }}
        />
        {/* 手柄到中心的连线（直观显示偏离原声的程度） */}
        <svg className="absolute inset-0 pointer-events-none" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <line x1={`${cxPct}%`} y1={`${cyPct}%`} x2={`${xPct}%`} y2={`${yPct}%`} stroke={theme.accentColor} strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
        </svg>
      </div>
      {/* 轴标签 */}
      {yLabels.map((l) => <span key={l.label} className={`pointer-events-none absolute left-2 -translate-y-1/2 text-[10px] ${theme.textSecondary}`} style={{ top: `${Math.max(8, Math.min(88, (1 - (l.pos - yMin) / (yMax - yMin)) * 100))}%` }}>{l.label}</span>)}
      {xLabels.map((l) => <span key={l.label} className={`pointer-events-none absolute bottom-1 -translate-x-1/2 text-[10px] ${theme.textSecondary}`} style={{ left: `${Math.max(10, Math.min(90, (l.pos - xMin) / (xMax - xMin) * 100))}%` }}>{l.label}</span>)}
    </div>
  )
}

/* ─────────────────────────── 压缩传输曲线（参数可视化，规划书 B4） ─────────────────────────── */

/** 软拐点压缩输入→输出传输曲线，只根据参数变化更新。 */
function CompressorCurve({ thresholdDb, ratio, kneeDb, makeupDb, outputGain, mode, upwardMaxGainDb, theme }: {
  thresholdDb: number
  ratio: number
  kneeDb: number
  makeupDb: number
  outputGain: number
  mode: 'downward' | 'upward'
  upwardMaxGainDb: number
  theme: V3Theme
}) {
  const xMin = -60, xMax = 0
  const xPx = (db: number) => 10 + ((db - xMin) / (xMax - xMin)) * 95
  const yPx = (db: number) => 70 - ((Math.max(xMin, Math.min(0, db)) - xMin) / (xMax - xMin)) * 62
  const lo = thresholdDb - kneeDb / 2
  const hi = thresholdDb + kneeDb / 2
  const transfer = (x: number): number => {
    const slope = 1 - 1 / ratio
    let gainDb = 0
    if (mode === 'upward') {
      if (x < hi) gainDb = Math.min(upwardMaxGainDb, kneeDb <= 0 || x < lo
        ? (thresholdDb - x) * slope : slope * (hi - x) ** 2 / (2 * kneeDb))
    } else if (x > lo) {
      gainDb = -(kneeDb <= 0 || x > hi
        ? (x - thresholdDb) * slope : slope * (x - lo) ** 2 / (2 * kneeDb))
    }
    return x + gainDb + makeupDb + 20 * Math.log10(Math.max(outputGain, 1e-12))
  }
  const pts: string[] = []
  for (let i = 0; i <= 40; i++) {
    const xd = xMin + (i / 40) * (xMax - xMin)
    pts.push(`${xPx(xd).toFixed(2)},${yPx(transfer(xd)).toFixed(2)}`)
  }
  const curvePath = `M${pts.join(' L')}`
  const unityPath = `M${xPx(xMin)},${yPx(xMin)} L${xPx(xMax)},${yPx(xMax)}`
  return (
    <div className="relative w-full rounded-xl overflow-hidden mb-3" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}`, padding: 4 }}>
      <svg role="img" aria-label={`${mode === 'upward' ? '向上' : '向下'}压缩器输入输出传输曲线`} viewBox="0 0 110 80" className="w-full" style={{ height: 130 }}>
        {/* 网格 */}
        {[-40, -20].map((db) => <line key={`v${db}`} x1={xPx(db)} y1={8} x2={xPx(db)} y2={70} stroke={theme.glassBorder} strokeWidth={0.5} />)}
        {/* 1:1 参考线 */}
        <path d={unityPath} fill="none" stroke="#9AB2AB" strokeWidth={0.8} strokeDasharray="3 3" />
        {/* 阈值竖线 */}
        <line x1={xPx(thresholdDb)} y1={8} x2={xPx(thresholdDb)} y2={70} stroke={`${theme.accentColor}66`} strokeWidth={0.8} strokeDasharray="2 2" />
        {/* 传输曲线 */}
        <path d={curvePath} fill="none" stroke={theme.accentColor} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
        {/* 标签 */}
        <text x={xPx(thresholdDb)} y={76} textAnchor="middle" fontSize={6} fill={theme.accentColor}>T={thresholdDb}</text>
        <text x={10} y={76} textAnchor="start" fontSize={6} fill="#536b66">输入 dB →</text>
        <text x={106} y={12} textAnchor="end" fontSize={6} fill="#536b66">↑ 输出 dB</text>
      </svg>
    </div>
  )
}

/* ─────────────────────────── 动态压缩 ─────────────────────────── */

export function DynamicEqModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const d = params.dynamicEq ?? createDefaultParams(params.sampleRate).dynamicEq!
  const bands = d.bands?.length ? d.bands : [d]
  const updateBand = (index: number, change: Partial<DynamicEqBandSettings>) => {
    if (!d.bands?.length) { patch({ dynamicEq: { ...d, ...change } }); return }
    const next = d.bands.map((band) => ({ ...band }))
    next[index] = { ...next[index], ...change }
    patch({ dynamicEq: { ...d, bands: next } })
  }
  const addBand = () => {
    if (bands.length >= 8) return
    const base = bands[bands.length - 1]
    patch({ dynamicEq: { ...d, bands: [...bands.map((band) => ({ ...band })),
      { ...base, enabled: true, frequency: Math.min(20000, base.frequency * 2) }] } })
  }
  const removeBand = (index: number) => {
    const next = bands.filter((_, position) => position !== index)
    if (next.length === 1) patch({ dynamicEq: { ...d, ...next[0], bands: undefined } })
    else patch({ dynamicEq: { ...d, bands: next } })
  }
  return (
    <Modal title="动态均衡" icon={<Activity className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>每个频段独立检测和衰减，左右声道联动；可逐段控制阈值与时间。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用动态均衡</span>
        <Toggle label="启用动态均衡" checked={d.enabled} onChange={(enabled) => patch({ dynamicEq: { ...d, enabled } })} theme={theme} />
      </div>
      {bands.map((band, index) => <section key={index} className="mb-4 rounded-xl border p-3" style={{ borderColor: theme.glassBorder }}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className={`${theme.textPrimary} text-sm font-medium`}>频段 {index + 1}</span>
          <Toggle label={`启用动态均衡频段 ${index + 1}`} checked={band.enabled} onChange={(enabled) => updateBand(index, { enabled })} theme={theme} />
          {bands.length > 1 && <button type="button" onClick={() => removeBand(index)} className={`hse-glass-button rounded-lg px-2 py-1 text-xs ${theme.textSecondary}`}>删除频段</button>}
        </div>
        <Slider label="中心频率" value={band.frequency} min={20} max={Math.min(20000, params.sampleRate * 0.49)} step={1} onChange={(frequency) => updateBand(index, { frequency })} display={`${Math.round(band.frequency)} Hz`} theme={theme} />
        <Slider label="Q 值" value={band.q} min={0.1} max={18} step={0.1} onChange={(q) => updateBand(index, { q })} display={band.q.toFixed(1)} theme={theme} />
        <Slider label="触发阈值" value={band.thresholdDb} min={-80} max={0} step={1} onChange={(thresholdDb) => updateBand(index, { thresholdDb })} display={`${band.thresholdDb} dBFS`} theme={theme} />
        <Slider label="压缩比率" value={band.ratio} min={1} max={20} step={0.5} onChange={(ratio) => updateBand(index, { ratio })} display={`${band.ratio.toFixed(1)}:1`} theme={theme} />
        <Slider label="最大衰减" value={band.maxReductionDb} min={0} max={24} step={0.5} onChange={(maxReductionDb) => updateBand(index, { maxReductionDb })} display={`${band.maxReductionDb} dB`} theme={theme} />
        <Slider label="启动时间" value={band.attackMs} min={0.1} max={500} step={0.1} onChange={(attackMs) => updateBand(index, { attackMs })} display={`${band.attackMs.toFixed(1)} ms`} theme={theme} />
        <Slider label="释放时间" value={band.releaseMs} min={0.1} max={3000} step={0.1} onChange={(releaseMs) => updateBand(index, { releaseMs })} display={`${band.releaseMs.toFixed(1)} ms`} theme={theme} />
      </section>)}
      <button type="button" disabled={bands.length >= 8} onClick={addBand} className={`hse-glass-button mb-4 rounded-lg px-3 py-2 text-xs disabled:opacity-50 ${theme.textPrimary}`}>添加频段</button>
      <InfoLine theme={theme}>Q 值越大，控制频段越窄；比率 1:1 或最大衰减 0 dB 时保持原始频响。</InfoLine>
    </Modal>
  )
}

export function CompressorModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const c = params.compressor
  const mb = c.multiband ?? createDefaultParams(params.sampleRate).compressor.multiband!
  const updateBand = (key: 'low' | 'mid' | 'high', field: keyof MultibandBandSettings, value: number) => {
    patch({ compressor: { ...c, multiband: { ...mb, [key]: { ...mb[key], [field]: value } } } })
  }
  return (
    <Modal title="动态压缩" icon={<Activity className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>软拐点压缩器压平音量起伏，让轻的部分更清晰、重的部分不爆。</p>
      {c.mode !== 'multiband' && <CompressorCurve thresholdDb={c.thresholdDb} ratio={c.ratio} kneeDb={c.kneeDb} makeupDb={c.makeupDb} outputGain={c.outputGain} mode={c.mode === 'upward' ? 'upward' : 'downward'} upwardMaxGainDb={c.upwardMaxGainDb ?? 24} theme={theme} />}
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 动态压缩</span>
        <Toggle label="启用动态压缩" checked={c.enabled} onChange={(v) => patch({ compressor: { ...c, enabled: v } })} theme={theme} />
      </div>
      <Segmented label="压缩模式" options={[{ value: 'downward' as const, label: '向下' }, { value: 'upward' as const, label: '向上' }, { value: 'multiband' as const, label: '多段' }]} value={c.mode ?? 'downward'} onChange={(mode) => patch({ compressor: { ...c, mode } })} theme={theme} small />
      {c.mode === 'multiband' ? <>
        <Slider label="低/中分频" value={mb.lowMidHz} min={40} max={1000} step={10} onChange={(lowMidHz) => patch({ compressor: { ...c, multiband: { ...mb, lowMidHz } } })} display={`${Math.round(mb.lowMidHz)} Hz`} theme={theme} />
        <Slider label="中/高分频" value={mb.midHighHz} min={1000} max={12000} step={100} onChange={(midHighHz) => patch({ compressor: { ...c, multiband: { ...mb, midHighHz } } })} display={`${Math.round(mb.midHighHz)} Hz`} theme={theme} />
        {(['low', 'mid', 'high'] as const).map((key) => <section key={key} className="mb-4 rounded-xl border p-3" style={{ borderColor: theme.glassBorder }}>
          <h3 className={`${theme.textPrimary} mb-3 text-sm font-medium`}>{key === 'low' ? '低频' : key === 'mid' ? '中频' : '高频'}</h3>
          <Slider label="阈值" value={mb[key].thresholdDb} min={-60} max={0} step={1} onChange={(value) => updateBand(key, 'thresholdDb', value)} display={`${mb[key].thresholdDb} dB`} theme={theme} />
          <Slider label="比率" value={mb[key].ratio} min={1} max={20} step={0.5} onChange={(value) => updateBand(key, 'ratio', value)} display={`${mb[key].ratio.toFixed(1)}:1`} theme={theme} />
          <Slider label="拐点宽度" value={mb[key].kneeDb} min={0} max={20} step={0.5} onChange={(value) => updateBand(key, 'kneeDb', value)} display={`${mb[key].kneeDb.toFixed(1)} dB`} theme={theme} />
          <Slider label="起始时间" value={mb[key].attackMs} min={0} max={100} step={1} onChange={(value) => updateBand(key, 'attackMs', value)} display={`${mb[key].attackMs} ms`} theme={theme} />
          <Slider label="释放时间" value={mb[key].releaseMs} min={10} max={1000} step={10} onChange={(value) => updateBand(key, 'releaseMs', value)} display={`${mb[key].releaseMs} ms`} theme={theme} />
          <Slider label="频段补偿增益" value={mb[key].makeupDb} min={-12} max={12} step={0.5} onChange={(value) => updateBand(key, 'makeupDb', value)} display={`${mb[key].makeupDb.toFixed(1)} dB`} theme={theme} />
        </section>)}
      </> : <>
        <Slider label="阈值" value={c.thresholdDb} min={-60} max={0} step={1} onChange={(v) => patch({ compressor: { ...c, thresholdDb: v } })} display={`${c.thresholdDb} dB`} theme={theme} />
        <Slider label="比率" value={c.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, ratio: v } })} display={`${c.ratio.toFixed(1)}:1`} theme={theme} />
        <Slider label="拐点宽度" value={c.kneeDb} min={0} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, kneeDb: v } })} display={`${c.kneeDb.toFixed(1)} dB`} theme={theme} />
        <Slider label="起始时间" value={c.attackMs} min={0} max={100} step={1} onChange={(v) => patch({ compressor: { ...c, attackMs: v } })} display={`${c.attackMs} ms`} theme={theme} />
        <Slider label="释放时间" value={c.releaseMs} min={10} max={1000} step={10} onChange={(v) => patch({ compressor: { ...c, releaseMs: v } })} display={`${c.releaseMs} ms`} theme={theme} />
        {c.mode === 'upward' && <Slider label="最大提升" value={c.upwardMaxGainDb ?? 24} min={0} max={36} step={1} onChange={(upwardMaxGainDb) => patch({ compressor: { ...c, upwardMaxGainDb } })} display={`${c.upwardMaxGainDb ?? 24} dB`} theme={theme} />}
      </>}
      <Slider label="瞬态保留" value={c.transientPreserve ?? 0} min={0} max={1} step={0.05}
        onChange={(transientPreserve) => patch({ compressor: { ...c, transientPreserve } })}
        display={`${Math.round((c.transientPreserve ?? 0) * 100)}%`} theme={theme} />
      <Slider label="补偿增益" value={c.makeupDb} min={0} max={12} step={0.5} onChange={(v) => patch({ compressor: { ...c, makeupDb: v } })} display={`+${c.makeupDb.toFixed(1)} dB`} theme={theme} />
      <Slider label="输出增益" value={c.outputGain} min={0} max={2} step={0.05} onChange={(v) => patch({ compressor: { ...c, outputGain: v } })} display={`${c.outputGain.toFixed(2)} ×`} theme={theme} />
    </Modal>
  )
}

/* ─────────────────────────── 齿音抑制 ─────────────────────────── */

export function DeesserModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const d = params.deesser
  return (
    <Modal title="齿音抑制" icon={<Mic2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>检测 4–8 kHz 齿音频段并动态压低，减轻刺耳的齿音。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 齿音抑制</span>
        <Toggle label="启用齿音抑制" checked={d.enabled} onChange={(v) => patch({ deesser: { ...d, enabled: v } })} theme={theme} />
      </div>
      <Segmented
        label="齿音抑制模式"
        options={[
          { value: true as const, label: '分带式（推荐）' },
          { value: false as const, label: '宽带式' },
        ]}
        value={d.splitBand}
        onChange={(v) => patch({ deesser: { ...d, splitBand: v } })}
        theme={theme}
        small
      />
      <Slider label="中心频率" value={d.centerHz} min={2000} max={10000} step={100} onChange={(v) => patch({ deesser: { ...d, centerHz: v } })} display={`${(d.centerHz / 1000).toFixed(1)} kHz`} theme={theme} />
      <Slider label="触发阈值" value={d.thresholdDb} min={-50} max={0} step={1} onChange={(v) => patch({ deesser: { ...d, thresholdDb: v } })} display={`${d.thresholdDb} dB`} theme={theme} />
      <Slider label="压缩比率" value={d.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ deesser: { ...d, ratio: v } })} display={`${d.ratio.toFixed(1)}:1`} theme={theme} />
      <Slider label="起始时间" value={d.attackMs} min={0} max={10} step={0.1} onChange={(v) => patch({ deesser: { ...d, attackMs: v } })} display={`${d.attackMs.toFixed(1)} ms`} theme={theme} />
      <Slider label="释放时间" value={d.releaseMs} min={10} max={300} step={5} onChange={(v) => patch({ deesser: { ...d, releaseMs: v } })} display={`${d.releaseMs} ms`} theme={theme} />
      <Slider label="效果混合" value={d.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ deesser: { ...d, mix: v } })} display={`${Math.round(d.mix * 100)}%`} theme={theme} />
    </Modal>
  )
}

/* ─────────────────────────── 夜间模式 ─────────────────────────── */

export function NightModeModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const n = params.nightMode
  return (
    <Modal title="夜间模式" icon={<Moon className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>动态压缩与 6 kHz 高频衰减，减小深夜播放的音量起伏。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 夜间模式</span>
        <Toggle label="启用夜间模式" checked={n.enabled} onChange={(v) => patch({ nightMode: { ...n, enabled: v } })} theme={theme} />
      </div>
      <Slider label="强度" value={n.amount} min={0} max={10} step={1} onChange={(v) => patch({ nightMode: { ...n, amount: v } })} display={`${n.amount} 级`} theme={theme} />
      <InfoLine theme={theme}>强度为 0 时等效关闭；建议与音量自适应补偿同开，低音量听感更平衡。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 限幅器 ─────────────────────────── */

export function LimiterModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const l = params.limiter
  return (
    <Modal title="限幅器" icon={<Shield className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>前瞻式限幅保护输出，默认阈值 -1 dBFS；真峰值检测使用 4× 过采样。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 限幅器</span>
        <Toggle label="启用限幅器" checked={l.enabled} onChange={(v) => patch({ limiter: { ...l, enabled: v } })} theme={theme} />
      </div>
      <Slider label="阈值" value={l.thresholdDb} min={-12} max={0} step={0.1} onChange={(v) => patch({ limiter: { ...l, thresholdDb: v } })} display={`${l.thresholdDb.toFixed(1)} dBFS`} theme={theme} />
      <Slider label="前瞻时间" value={l.lookaheadMs} min={0} max={20} step={0.5} onChange={(v) => patch({ limiter: { ...l, lookaheadMs: v } })} display={`${l.lookaheadMs.toFixed(1)} ms`} theme={theme} />
      <Slider label="起始时间" value={l.attackMs} min={0} max={5} step={0.1} onChange={(v) => patch({ limiter: { ...l, attackMs: v } })} display={`${l.attackMs.toFixed(1)} ms`} theme={theme} />
      <Slider label="释放时间" value={l.releaseMs} min={20} max={500} step={10} onChange={(v) => patch({ limiter: { ...l, releaseMs: v } })} display={`${l.releaseMs} ms`} theme={theme} />
      <div className="flex items-center justify-between mb-2">
        <span className={`${theme.textSecondary} text-xs`}>真峰值检测（4× 过采样）</span>
        <Toggle label="真峰值检测" checked={l.truePeak} onChange={(v) => patch({ limiter: { ...l, truePeak: v } })} theme={theme} />
      </div>
      <InfoLine theme={theme}>增加前瞻时间会提高处理延迟。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 智能均衡 IEQ ─────────────────────────── */

export const IEQ_CURVES: { value: 'flat' | 'warm' | 'bright' | 'vocal'; label: string; hint: string }[] = [
  { value: 'flat', label: '平坦', hint: '中性直白，还原混音' },
  { value: 'warm', label: '温暖', hint: '中低频略厚' },
  { value: 'bright', label: '通透', hint: '高频更亮' },
  { value: 'vocal', label: '人声', hint: '突出人声频段' },
]

export function IeqModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const ieq = params.ieq
  return (
    <Modal title="智能均衡" icon={<Sparkles className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>实时分析频谱并与目标曲线对比，慢速平滑自动修正频响，不会跟随音乐抽吸。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 智能均衡</span>
        <Toggle label="启用智能均衡" checked={ieq.enabled} onChange={(v) => patch({ ieq: { ...ieq, enabled: v } })} theme={theme} />
      </div>
      <div className={`${theme.textSecondary} text-xs mb-1.5`}>目标曲线</div>
      <Segmented label="智能均衡目标曲线" options={IEQ_CURVES} value={ieq.targetCurve}
        onChange={(targetCurve) => patch({ ieq: { ...ieq, targetCurve } })} theme={theme} />
      <Slider label="修正强度" value={ieq.strength} min={0} max={1} step={0.01} onChange={(v) => patch({ ieq: { ...ieq, strength: v } })} display={`${Math.round(ieq.strength * 100)}%`} theme={theme} />
      <Slider label="平滑时间" value={ieq.timeConstantSec} min={0.5} max={10} step={0.1} onChange={(v) => patch({ ieq: { ...ieq, timeConstantSec: v } })} display={`${ieq.timeConstantSec.toFixed(1)} s`} theme={theme} />
      <InfoLine theme={theme}>强度为 0% 时只分析；建议使用默认的 3 s 平滑，减小音量抽吸。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 变速变调 ─────────────────────────── */

export function PitchModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const pitch = params.pitch
  return (
    <Modal title="变速变调" icon={<Music className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>独立调整音高和播放速度。改变音高可升降调，改变倍速可放慢或加快音乐。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 变速变调</span>
        <Toggle label="启用变速变调" checked={pitch.enabled} onChange={(v) => patch({ pitch: { ...pitch, enabled: v } })} theme={theme} />
      </div>
      <Slider label="变调" value={pitch.semitones} min={-10} max={10} step={0.5} onChange={(v) => patch({ pitch: { ...pitch, semitones: v } })} display={`${pitch.semitones > 0 ? '+' : ''}${pitch.semitones} 半音`} theme={theme} />
      <Slider label="倍速" value={pitch.rate} min={0.25} max={3} step={0.05} onChange={(v) => patch({ pitch: { ...pitch, rate: v } })} display={`${pitch.rate.toFixed(2)} ×`} theme={theme} />
      <InfoLine theme={theme}>音高与速度可独立调整；速度会改变音频时长。此开关同时启用空间音效页的 M/S 比例调节，原始比例为 0。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 立体声宽度 ─────────────────────────── */

export function StereoWidthModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const p = params
  const vb = p.pitch.voiceBalance
  return (
    <Modal title="立体声宽度" icon={<Columns2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-3`}>横向控制立体声宽度，纵向调整左右平均的中央信号（M）与左右差分信号（S）的比例；两者来自原曲声道组合。</p>
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className={`${theme.textPrimary} text-xs`}>启用 M/S 比例与变速变调</span>
        <Toggle label="启用 M/S 比例与变速变调" checked={p.pitch.enabled} onChange={(enabled) => patch({ pitch: { ...p.pitch, enabled } })} theme={theme} />
      </div>
      {/* X-Y 声场触控板（X=立体声宽度 0..2，Y=人声↔伴奏 -1..+1，中心=原声） */}
      <div className="mb-3">
        <XYPad
          x={p.stereoWidth} y={vb}
          yDisabled={!p.pitch.enabled}
          xMin={0} xMax={2} xCenter={1}
          yMin={-1} yMax={1} yCenter={0}
          onChange={(x, y) => patch({ stereoWidth: x, pitch: { ...p.pitch, voiceBalance: y } })}
          theme={theme}
          xLabels={[{ pos: 0, label: '单声道' }, { pos: 1, label: '原声' }, { pos: 2, label: '极宽' }]}
          yLabels={[{ pos: 1, label: '中央 M' }, { pos: 0, label: '原始比例' }, { pos: -1, label: '差分 S' }]}
        />
        <div className={`flex justify-between mt-1.5 text-[10px] ${theme.textTertiary}`}>
          <span>宽度 <span className="hse-mono">{p.stereoWidth.toFixed(2)} ×</span></span>
          <span>M/S 比例 <span className="hse-mono">{!p.pitch.enabled ? '未启用' : vb === 0 ? '原始比例' : vb > 0 ? `差分衰减 ${Math.round(vb * 100)}%` : `中央衰减 ${Math.round(-vb * 100)}%`}</span></span>
        </div>
      </div>
      <Slider label="立体声宽度（精调）" value={p.stereoWidth} min={0} max={2} step={0.05} onChange={(v) => patch({ stereoWidth: v })} display={`${p.stereoWidth.toFixed(2)} ×`} theme={theme} />
      <Slider label="差分 S ↔ 中央 M（精调）" value={vb} min={-1} max={1} step={0.05} disabled={!p.pitch.enabled}
        onChange={(v) => patch({ pitch: { ...p.pitch, voiceBalance: v } })}
        display={vb === 0 ? '原始比例' : vb > 0 ? `差分衰减 ${Math.round(vb * 100)}%` : `中央衰减 ${Math.round(-vb * 100)}%`} theme={theme} />
      <div className="my-3 h-px" style={{ backgroundColor: theme.glassBorder }} />
      <div className={`${theme.textPrimary} mb-1 text-sm font-medium`}>低频管理</div>
      <p className={`${theme.textSecondary} mb-2 text-xs leading-relaxed`}>单声道管理在截止频率以下逐渐收窄侧信号；次声高通位于空间效果和自定义节点之后、最终限幅之前。</p>
      <Slider label="低频收窄量" value={p.lowMonoAmount ?? 0} min={0} max={1} step={0.05}
        onChange={(v) => patch({ lowMonoAmount: v })} display={`${Math.round((p.lowMonoAmount ?? 0) * 100)}%`} theme={theme} />
      <Slider label="单声道过渡截止" value={p.lowMonoCutoffHz ?? 120} min={40} max={250} step={5}
        onChange={(v) => patch({ lowMonoCutoffHz: v })} display={`${p.lowMonoCutoffHz ?? 120} Hz`} theme={theme} />
      <div className="mt-2 flex items-center justify-between">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用次声高通</span>
        <Toggle label="启用次声高通" checked={p.subsonicEnabled ?? false}
          onChange={(v) => patch({ subsonicEnabled: v })} theme={theme} />
      </div>
      <Slider label="次声截止频率" value={p.subsonicCutoffHz ?? 20} min={10} max={40} step={1}
        onChange={(v) => patch({ subsonicCutoffHz: v })} display={`${p.subsonicCutoffHz ?? 20} Hz`} theme={theme} />
      <InfoLine theme={theme}>宽度 1.0 = 原始；0 = 单声道；2 = 极宽。M/S 比例与变速变调共用启用状态；关闭时仍可调整横向宽度。低频收窄量会在 20ms 内平滑跟随。</InfoLine>
    </Modal>
  )
}

/* 聚合导出：动态/调音类弹窗按 key 分发 */
export function DynamicsModal({ effectKey: key, controller, theme, onClose }: { effectKey: 'dynamicEq' | 'compressor' | 'deesser' | 'nightMode' | 'limiter' | 'ieq' | 'pitch' | 'stereoWidth'; controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  if (key === 'dynamicEq') return <DynamicEqModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'compressor') return <CompressorModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'deesser') return <DeesserModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'nightMode') return <NightModeModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'limiter') return <LimiterModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'ieq') return <IeqModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'pitch') return <PitchModal controller={controller} theme={theme} onClose={onClose} />
  return <StereoWidthModal controller={controller} theme={theme} onClose={onClose} />
}
