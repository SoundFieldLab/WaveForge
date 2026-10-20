/**
 * 动态调音页 —— 压缩 / 齿音 / 限幅 / 夜间 / IEQ / 变速变调
 */

import { Activity, Mic2, Moon, Shield, Sparkles, Music, Settings2 } from 'lucide-react'
import { GlassCard, Toggle, Slider, Segmented, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import { createDefaultParams } from '../../src/types'

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

export default function DynamicsPage({ controller, theme, onOpenEffect }: DynamicsPageProps) {
  const { params, patch } = controller
  const c = params.compressor
  const d = params.deesser
  const n = params.nightMode
  const l = params.limiter
  const ieq = params.ieq
  const pitch = params.pitch

  const summary = (enabled: boolean, text: string) => (
    <p className={`${theme.textSecondary} mb-4 text-xs leading-relaxed`}>
      <span className="font-medium" style={{ color: enabled ? theme.accentColor : undefined }}>{enabled ? '已启用' : '已关闭'}</span>
      <span className="mx-1.5" aria-hidden="true">·</span>{text}
    </p>
  )

  const details = (key: string, name: string) => (
    <button type="button" onClick={() => onOpenEffect(key)} aria-label={`${name}详细设置`}
      className={`hse-glass-button mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 py-2 text-xs ${theme.textSecondary}`}>
      <Settings2 className="h-3.5 w-3.5" /> 详细设置
    </button>
  )

  return (
    <div className="@container space-y-5">
      <RangeStyle theme={theme} />
      <p className={`${theme.textSecondary} text-sm leading-relaxed`}>各项效果可以独立启停并叠加。先调整常用参数，再进入详细设置精调。</p>

      <div className="columns-1 gap-5 @min-[44rem]:columns-2">
        {/* 动态压缩 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>动态均衡</span>
            </div>
            <Toggle label="启用动态均衡" checked={params.dynamicEq?.enabled === true} onChange={(enabled) => patch({ dynamicEq: { ...(params.dynamicEq ?? createDefaultParams(params.sampleRate).dynamicEq!), enabled } })} theme={theme} />
          </div>
          {summary(params.dynamicEq?.enabled === true, '只在指定频段过强时降低增益，轻声时恢复。')}
          {details('dynamicEq', '动态均衡')}
        </GlassCard>

        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>动态压缩</span>
            </div>
            <Toggle label="启用动态压缩" checked={c.enabled} onChange={(v) => patch({ compressor: { ...c, enabled: v } })} theme={theme} />
          </div>
          {summary(c.enabled, '收拢强弱起伏，让声音保持稳定。')}
          {c.enabled && (
            <div className="space-y-1">
              <Segmented
                label="压缩模式"
                options={[{ value: 'downward' as const, label: '向下' }, { value: 'upward' as const, label: '向上' }, { value: 'multiband' as const, label: '多段' }]}
                value={c.mode ?? 'downward'}
                onChange={(mode) => patch({ compressor: { ...c, mode } })}
                theme={theme}
                small
              />
              {c.mode !== 'multiband' && <>
                <Slider label="阈值" value={c.thresholdDb} min={-60} max={0} step={1} onChange={(v) => patch({ compressor: { ...c, thresholdDb: v } })} display={`${c.thresholdDb.toFixed(1)} dB`} theme={theme} />
                <Slider label="比率" value={c.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, ratio: v } })} display={`${c.ratio.toFixed(1)}:1`} theme={theme} />
              </>}
              {c.mode === 'multiband' && (() => {
                const mb = c.multiband ?? createDefaultParams(params.sampleRate).compressor.multiband!
                return <>
                  <Slider label="低/中分频" value={mb.lowMidHz} min={40} max={1000} step={10} onChange={(v) => patch({ compressor: { ...c, mode: 'multiband', multiband: { ...mb, lowMidHz: v } } })} display={`${Math.round(mb.lowMidHz)} Hz`} theme={theme} />
                  <Slider label="中/高分频" value={mb.midHighHz} min={1000} max={12000} step={100} onChange={(v) => patch({ compressor: { ...c, mode: 'multiband', multiband: { ...mb, midHighHz: v } } })} display={`${Math.round(mb.midHighHz)} Hz`} theme={theme} />
                  <p className={`${theme.textTertiary} text-[11px]`}>低、中、高频段的阈值和时间参数在详细设置中调整。</p>
                </>
              })()}
              {c.mode === 'upward' && <p className={`${theme.textTertiary} text-[11px]`}>低于阈值的声音会向上补偿，比例越高，弱声越接近阈值。</p>}
              <Slider label="补偿增益" value={c.makeupDb} min={0} max={12} step={0.5} onChange={(v) => patch({ compressor: { ...c, makeupDb: v } })} display={`+${c.makeupDb.toFixed(1)} dB`} theme={theme} />
            </div>
          )}
          {details('compressor', '动态压缩')}
        </GlassCard>

        {/* 齿音抑制 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Mic2 className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>齿音抑制</span>
            </div>
            <Toggle label="启用齿音抑制" checked={d.enabled} onChange={(v) => patch({ deesser: { ...d, enabled: v } })} theme={theme} />
          </div>
          {summary(d.enabled, '压低人声中突出的齿音与嘶声。')}
          {d.enabled && (
            <div className="space-y-1">
              <Segmented label="齿音抑制模式" options={[{ value: true, label: '分带式' }, { value: false, label: '宽带式' }]} value={d.splitBand} onChange={(v) => patch({ deesser: { ...d, splitBand: v } })} theme={theme} small />
              <Slider label="中心频率" value={d.centerHz} min={2000} max={10000} step={100} onChange={(v) => patch({ deesser: { ...d, centerHz: v } })} display={`${(d.centerHz / 1000).toFixed(1)} kHz`} theme={theme} />
              <Slider label="触发阈值" value={d.thresholdDb} min={-50} max={0} step={1} onChange={(v) => patch({ deesser: { ...d, thresholdDb: v } })} display={`${d.thresholdDb.toFixed(1)} dB`} theme={theme} />
            </div>
          )}
          {details('deesser', '齿音抑制')}
        </GlassCard>

        {/* 夜间模式 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Moon className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>夜间模式</span>
            </div>
            <Toggle label="启用夜间模式" checked={n.enabled} onChange={(v) => patch({ nightMode: { ...n, enabled: v } })} theme={theme} />
          </div>
          {summary(n.enabled, '减小动态起伏，适合低音量聆听。')}
          {n.enabled && (
            <Slider label="强度" value={n.amount} min={0} max={10} step={1} onChange={(v) => patch({ nightMode: { ...n, amount: v } })} display={`${n.amount} 级`} theme={theme} />
          )}
          {details('nightMode', '夜间模式')}
        </GlassCard>

        {/* 限幅器 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>限幅器</span>
            </div>
            <Toggle label="启用限幅器" checked={l.enabled} onChange={(v) => patch({ limiter: { ...l, enabled: v } })} theme={theme} />
          </div>
          {summary(l.enabled, '限制输出峰值，控制突然出现的强音。')}
          {l.enabled && (
            <div className="space-y-1">
              <Slider label="阈值" value={l.thresholdDb} min={-12} max={0} step={0.1} onChange={(v) => patch({ limiter: { ...l, thresholdDb: v } })} display={`${l.thresholdDb.toFixed(1)} dBFS`} theme={theme} />
              <div className="flex items-center justify-between mt-1">
                <span className={`${theme.textSecondary} text-xs`}>真峰值检测（4× 过采样）</span>
                <Toggle label="真峰值检测" checked={l.truePeak} onChange={(v) => patch({ limiter: { ...l, truePeak: v } })} theme={theme} />
              </div>
            </div>
          )}
          {details('limiter', '限幅器')}
        </GlassCard>

        {/* 智能均衡 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>智能均衡 IEQ</span>
            </div>
            <Toggle label="启用智能均衡" checked={ieq.enabled} onChange={(v) => patch({ ieq: { ...ieq, enabled: v } })} theme={theme} />
          </div>
          {summary(ieq.enabled, '按目标音色与修正强度调整频谱。')}
          {ieq.enabled && (
            <div className="space-y-1">
              <Segmented label="智能均衡目标曲线" options={[...IEQ_CURVES]} value={ieq.targetCurve}
                onChange={(targetCurve) => patch({ ieq: { ...ieq, targetCurve } })} theme={theme} small />
              <Slider label="修正强度" value={ieq.strength} min={0} max={1} step={0.01} onChange={(v) => patch({ ieq: { ...ieq, strength: v } })} display={`${Math.round(ieq.strength * 100)}%`} theme={theme} />
            </div>
          )}
          {details('ieq', '智能均衡')}
        </GlassCard>

        {/* 变速变调 */}
        <GlassCard theme={theme} className="mb-5 break-inside-avoid">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Music className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>变速变调</span>
            </div>
            <Toggle label="启用变速变调" checked={pitch.enabled} onChange={(v) => patch({ pitch: { ...pitch, enabled: v } })} theme={theme} />
          </div>
          {summary(pitch.enabled, '分别调整音高与播放速度。')}
          {pitch.enabled && (
            <div className="space-y-1">
              <Slider label="变调" value={pitch.semitones} min={-10} max={10} step={0.5} onChange={(v) => patch({ pitch: { ...pitch, semitones: v } })} display={`${pitch.semitones > 0 ? '+' : ''}${pitch.semitones} 半音`} theme={theme} />
              <Slider label="倍速" value={pitch.rate} min={0.25} max={3} step={0.05} onChange={(v) => patch({ pitch: { ...pitch, rate: v } })} display={`${pitch.rate.toFixed(2)} ×`} theme={theme} />
            </div>
          )}
          {details('pitch', '变速变调')}
        </GlassCard>
      </div>
    </div>
  )
}
