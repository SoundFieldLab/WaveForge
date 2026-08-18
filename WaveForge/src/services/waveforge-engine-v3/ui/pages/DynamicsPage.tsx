/**
 * 动态调音页 —— 压缩 / 齿音 / 限幅 / 夜间 / IEQ / 变速变调
 */

import { Activity, Mic2, Moon, Shield, Sparkles, Music } from 'lucide-react'
import { GlassCard, Toggle, Slider, Segmented, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'

interface DynamicsPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

const IEQ_CURVES = [
  { value: 'flat', label: '平坦' },
  { value: 'warm', label: '温暖' },
  { value: 'bright', label: '通透' },
  { value: 'vocal', label: '人声' },
] as const

export default function DynamicsPage({ controller, theme }: DynamicsPageProps) {
  const { params, patch } = controller
  const c = params.compressor
  const d = params.deesser
  const n = params.nightMode
  const l = params.limiter
  const ieq = params.ieq
  const pitch = params.pitch

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 动态压缩 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>动态压缩</span>
          </div>
          <Toggle checked={c.enabled} onChange={(v) => patch({ compressor: { ...c, enabled: v } })} theme={theme} />
        </div>
        {c.enabled && (
          <div className="space-y-2">
            <Slider label="阈值" value={c.thresholdDb} min={-60} max={0} step={1} onChange={(v) => patch({ compressor: { ...c, thresholdDb: v } })} display={`${c.thresholdDb}dB`} theme={theme} />
            <Slider label="比率" value={c.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, ratio: v } })} display={`${c.ratio.toFixed(1)}:1`} theme={theme} />
            <Slider label="补偿增益" value={c.makeupDb} min={0} max={12} step={0.5} onChange={(v) => patch({ compressor: { ...c, makeupDb: v } })} display={`+${c.makeupDb.toFixed(1)}dB`} theme={theme} />
          </div>
        )}
      </GlassCard>

      {/* 齿音抑制 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Mic2 className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>齿音抑制</span>
          </div>
          <Toggle checked={d.enabled} onChange={(v) => patch({ deesser: { ...d, enabled: v } })} theme={theme} />
        </div>
        {d.enabled && (
          <div className="space-y-2">
            <Segmented options={[{ value: true, label: '分带式' }, { value: false, label: '宽带式' }]} value={d.splitBand} onChange={(v) => patch({ deesser: { ...d, splitBand: v } })} theme={theme} small />
            <Slider label="中心频率" value={d.centerHz} min={2000} max={10000} step={100} onChange={(v) => patch({ deesser: { ...d, centerHz: v } })} display={`${d.centerHz >= 1000 ? (d.centerHz / 1000).toFixed(1) + 'k' : d.centerHz}Hz`} theme={theme} />
            <Slider label="触发阈值" value={d.thresholdDb} min={-50} max={0} step={1} onChange={(v) => patch({ deesser: { ...d, thresholdDb: v } })} display={`${d.thresholdDb}dB`} theme={theme} />
          </div>
        )}
      </GlassCard>

      {/* 夜间模式 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Moon className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>夜间模式</span>
          </div>
          <Toggle checked={n.enabled} onChange={(v) => patch({ nightMode: { ...n, enabled: v } })} theme={theme} />
        </div>
        {n.enabled && (
          <Slider label="强度" value={n.amount} min={0} max={10} step={1} onChange={(v) => patch({ nightMode: { ...n, amount: v } })} display={`${n.amount} 级`} theme={theme} />
        )}
      </GlassCard>

      {/* 限幅器 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>限幅器</span>
          </div>
          <Toggle checked={l.enabled} onChange={(v) => patch({ limiter: { ...l, enabled: v } })} theme={theme} />
        </div>
        {l.enabled && (
          <div className="space-y-2">
            <Slider label="阈值" value={l.thresholdDb} min={-12} max={0} step={0.1} onChange={(v) => patch({ limiter: { ...l, thresholdDb: v } })} display={`${l.thresholdDb.toFixed(1)}dBFS`} theme={theme} />
            <div className="flex items-center justify-between mt-1">
              <span className={`${theme.textSecondary} text-xs`}>真峰值检测（4× 过采样）</span>
              <Toggle checked={l.truePeak} onChange={(v) => patch({ limiter: { ...l, truePeak: v } })} theme={theme} />
            </div>
          </div>
        )}
      </GlassCard>

      {/* 智能均衡 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>智能均衡 IEQ</span>
          </div>
          <Toggle checked={ieq.enabled} onChange={(v) => patch({ ieq: { ...ieq, enabled: v } })} theme={theme} />
        </div>
        {ieq.enabled && (
          <div className="space-y-2">
            <div className="flex gap-1.5 mb-2">
              {IEQ_CURVES.map((cv) => (
                <button key={cv.value} type="button" onClick={() => patch({ ieq: { ...ieq, targetCurve: cv.value } })}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] transition-all ${ieq.targetCurve === cv.value ? 'text-white font-medium' : theme.textSecondary}`}
                  style={ieq.targetCurve === cv.value ? { backgroundColor: theme.accentColor } : { background: 'rgba(255,255,255,0.06)' }}>
                  {cv.label}
                </button>
              ))}
            </div>
            <Slider label="修正强度" value={ieq.strength} min={0} max={1} step={0.01} onChange={(v) => patch({ ieq: { ...ieq, strength: v } })} display={`${Math.round(ieq.strength * 100)}%`} theme={theme} />
          </div>
        )}
      </GlassCard>

      {/* 变速变调 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Music className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>变速变调</span>
          </div>
          <Toggle checked={pitch.enabled} onChange={(v) => patch({ pitch: { ...pitch, enabled: v } })} theme={theme} />
        </div>
        {pitch.enabled && (
          <div className="space-y-2">
            <Slider label="变调" value={pitch.semitones} min={-10} max={10} step={0.5} onChange={(v) => patch({ pitch: { ...pitch, semitones: v } })} display={`${pitch.semitones > 0 ? '+' : ''}${pitch.semitones} 半音`} theme={theme} />
            <Slider label="倍速" value={pitch.rate} min={0.25} max={3} step={0.05} onChange={(v) => patch({ pitch: { ...pitch, rate: v } })} display={`${pitch.rate.toFixed(2)}x`} theme={theme} />
          </div>
        )}
      </GlassCard>
    </div>
  )
}
