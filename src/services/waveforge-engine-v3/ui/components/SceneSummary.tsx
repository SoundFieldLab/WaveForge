import type { ScenePreset, V3EngineParams } from '../../src/types'
import { SIMPLE_EQ_FREQUENCIES } from '../../src/types'
import type { HSETheme } from '../hse-theme'
import { EFFECT_META, effectEnabled } from '../effectsPanel'

/** 场景摘要仅依赖参数快照；实时测量数据不会影响场景状态。 */
export default function SceneSummary({ scene, params, theme }: { scene?: ScenePreset; params: V3EngineParams; theme: HSETheme }) {
  const enabled = (Object.keys(EFFECT_META) as (keyof typeof EFFECT_META)[]).filter((key) => effectEnabled(params, key))
  const points = params.eq.mode === 'simple'
    ? SIMPLE_EQ_FREQUENCIES.map((frequency, i) => ({ frequency, gain: params.eq.simpleBands[i] || 0 }))
    : params.eq.proBands.slice().sort((a, b) => a.frequency - b.frequency)
  const x = (frequency: number) => 12 + Math.max(0, Math.min(1, Math.log(frequency / 20) / Math.log(1000))) * 336
  const y = (gain: number) => 48 - Math.max(-20, Math.min(20, gain)) * 1.65
  const path = points.map((point, i) => (i ? 'L ' : 'M ') + x(point.frequency).toFixed(2) + ' ' + y(point.gain).toFixed(2)).join(' ')
  const isCustom = params.customized || !scene
  const metrics = [
    { label: '低音下潜', value: params.bassEnhancer.lowBoostDb.toFixed(1), unit: 'dB', enabled: params.bassEnhancer.enabled },
    { label: '立体声宽度', value: params.stereoWidth.toFixed(2), unit: '倍', enabled: true },
    { label: '低频单声道', value: `${Math.round((params.lowMonoAmount ?? 0) * 100)}`, unit: '%', enabled: (params.lowMonoAmount ?? 0) > 0.001 },
    { label: '次声高通', value: `${params.subsonicCutoffHz ?? 20}`, unit: 'Hz', enabled: params.subsonicEnabled === true },
    { label: '压缩比', value: params.compressor.ratio.toFixed(1) + ':1', unit: '', enabled: params.compressor.enabled },
    { label: '限幅阈值', value: params.limiter.thresholdDb.toFixed(1), unit: 'dBFS', enabled: params.limiter.enabled },
  ]
  return (
    <section className="@container min-w-0 space-y-4" aria-label="当前配置摘要">
      <div>
        <div className={'text-xs font-medium ' + theme.textSecondary}>当前配置</div>
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 mt-1.5">
          <h3 className={'text-xl font-semibold ' + theme.textPrimary}>{isCustom ? '自定义' : scene.name}</h3>
          {isCustom && scene && <span className={'text-xs ' + theme.textSecondary}>基于「{scene.name}」调整</span>}
        </div>
        <p className={'text-sm leading-relaxed mt-2 ' + theme.textSecondary}>
          {isCustom ? '当前音效已手动调整。保存为场景后，可以随时再次使用这套配置。' : (scene.description || '此场景包含均衡器与音效的完整配置。')}
        </p>
      </div>
      <div className="rounded-2xl px-4 pt-3 pb-2" style={{ background: theme.inputBg, border: `1px solid ${theme.cardBorder}` }}>
        <div className="flex justify-between gap-3">
          <span className={'text-xs font-medium ' + theme.textPrimary}>EQ 小预览</span>
          <span className={'text-xs ' + theme.textSecondary}>{params.eq.enabled ? (params.eq.mode === 'simple' ? '简约 5 段' : '专业 ' + params.eq.proBands.length + ' 段') : '均衡器已关闭'}</span>
        </div>
        <svg viewBox="0 0 360 104" className="w-full max-h-28 mt-2" role="img" aria-label="当前均衡器频段增益预览">
          <line x1="12" x2="348" y1="48" y2="48" stroke={theme.cardBorder} strokeDasharray="4 4" />
          {path && <path d={path} fill="none" stroke={theme.accentColor} strokeWidth="2" strokeLinejoin="round" opacity={params.eq.enabled ? 1 : 0.45} />}
          <text x="12" y="96" fontSize="11" fill="currentColor" className={theme.textSecondary}>20 Hz</text>
          <text x="348" y="96" textAnchor="end" fontSize="11" fill="currentColor" className={theme.textSecondary}>20 kHz</text>
          <text x="348" y="43" textAnchor="end" fontSize="10" fill="currentColor" className={theme.textSecondary}>0 dB</text>
        </svg>
      </div>
      <div>
        <div className={'text-xs font-medium mb-2 ' + theme.textPrimary}>已开启效果 · {enabled.length + (params.eq.enabled ? 1 : 0) + (params.spatial && params.spatial.mode !== 'off' ? 1 : 0)}</div>
        <div className="flex flex-wrap gap-2">
          {params.eq.enabled && <span className="rounded-full px-3 py-1 text-xs" style={{ color: theme.accentColor, background: theme.accentDim }}>均衡器</span>}
          {enabled.map((key) => <span key={key} className="rounded-full px-3 py-1 text-xs" style={{ color: theme.accentColor, background: theme.accentDim }}>{EFFECT_META[key].name}</span>)}
          {params.spatial && params.spatial.mode !== 'off' && <span className="rounded-full px-3 py-1 text-xs" style={{ color: theme.accentColor, background: theme.accentDim }}>空间音频</span>}
          {!enabled.length && !params.eq.enabled && (!params.spatial || params.spatial.mode === 'off') && <span className={'text-sm ' + theme.textSecondary}>所有效果已关闭，保留原声。</span>}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 pt-3 @min-[40rem]:grid-cols-4" style={{ borderTop: `1px solid ${theme.cardBorder}` }}>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt className={'text-xs ' + theme.textSecondary}>{metric.label}</dt>
            <dd className={'mt-1.5 text-lg font-semibold tabular-nums ' + theme.textPrimary}>
              {metric.enabled ? <>{metric.value}<span className={'text-xs font-normal ml-1 ' + theme.textSecondary}>{metric.unit}</span></> : <span className={'text-sm font-normal ' + theme.textSecondary}>已关闭</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
