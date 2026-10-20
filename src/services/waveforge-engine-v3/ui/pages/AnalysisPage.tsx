/**
 * 分析页 —— 实时频谱 + LUFS/GR + 特征 + 听力测试
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { Activity, Ear, Play, RotateCcw, Check, X } from 'lucide-react'
import { GlassCard, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3HearingSession } from '../bridge'
import type { V3ParamsController } from '../hooks'
import type { EngineStats, EngineAnalysis } from '../../src/types'

interface AnalysisPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

const POLL_MS = 100
const BARS = 32
const SPECTRUM_MIN_HZ = 20
const freqLabel = (f: number) => Number.isFinite(f) ? (f >= 1000 ? `${(f / 1000).toFixed(1)} kHz` : `${Math.round(f)} Hz`) : '—'

export default function AnalysisPage({ bridge, theme }: AnalysisPageProps) {
  return (
    <div className="@container space-y-5">
      <RangeStyle theme={theme} />
      <p className={`${theme.textSecondary} text-sm leading-relaxed`}>播放音乐时查看响度、电平与频谱；听力测试可单独开始。</p>
      <RealtimeAnalysis bridge={bridge} theme={theme} />
      <HearingTest bridge={bridge} theme={theme} />
    </div>
  )
}

/** 高频测量刷新只发生在本区，不触发听力测试控件重绘。 */
function RealtimeAnalysis({ bridge, theme }: Pick<AnalysisPageProps, 'bridge' | 'theme'>) {
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())
  const [analysis, setAnalysis] = useState<EngineAnalysis>(() => bridge.getAnalysis())
  const timerRef = useRef<number | null>(null)
  // 频谱条 EMA 平滑（防 10fps 更新跳变，观感接近连续）
  const smoothedRef = useRef<number[] | null>(null)

  useEffect(() => {
    const tick = () => { setStats(bridge.getStats()); setAnalysis(bridge.getAnalysis()) }
    tick()
    timerRef.current = window.setInterval(tick, POLL_MS)
    return () => { if (timerRef.current !== null) window.clearInterval(timerRef.current) }
  }, [bridge])

  const spectrum = analysis.spectrum
  const barData: number[] = (() => {
    const sampleRate = bridge.getSampleRate()
    if (!spectrum || spectrum.length <= 1 || !Number.isFinite(sampleRate) || sampleRate <= 40) return Array(BARS).fill(0)
    const len = spectrum.length
    // FFT bin 幅度归一化到 0dBFS：满幅正弦在 Hann 窗下的 bin 峰值 = N/4
    // （N = (len-1)*2），原实现把原始 bin 值当线性幅度直接取 dB，-47dB 以上
    // 的信号就会顶满条、显示毫无动态。除以 N/4 后 -80dBFS..0dBFS 映射 0..1。
    const normScale = 2 / (len - 1)
    const binHz = sampleRate / ((len - 1) * 2)
    const topHz = Math.min(20000, sampleRate / 2)
    const out: number[] = []
    for (let i = 0; i < BARS; i++) {
      // 对数频率轴（音乐频谱标准做法）：20Hz..topHz 等比均分，
      // 线性轴会把 20-100Hz 低音全挤进第一根条、低频分辨率归零
      const fLo = SPECTRUM_MIN_HZ * Math.pow(topHz / SPECTRUM_MIN_HZ, i / BARS)
      const fHi = SPECTRUM_MIN_HZ * Math.pow(topHz / SPECTRUM_MIN_HZ, (i + 1) / BARS)
      const kLo = Math.max(1, Math.floor(fLo / binHz))
      const kHi = Math.min(len - 1, Math.ceil(fHi / binHz))
      let peak = 0
      for (let k = kLo; k <= kHi; k++) {
        const magnitude = spectrum[k] ?? 0
        if (Number.isFinite(magnitude)) peak = Math.max(peak, magnitude * normScale)
      }
      const db = 20 * Math.log10(Math.max(peak, 1e-4))
      out.push(Math.min(1, Math.max(0, (db + 80) / 80)))
    }
    // 一阶 EMA 平滑（α=0.45），并随新一帧长度复位缓存
    const prev = smoothedRef.current
    if (prev && prev.length === out.length) {
      for (let i = 0; i < out.length; i++) out[i] = prev[i] + 0.45 * (out[i] - prev[i])
    }
    smoothedRef.current = out
    return out
  })()

  const feats = analysis.features

  /** 频谱线与面积分开绘制，填充的闭合边不作为信号曲线显示。 */
  const spectrumPath = (() => {
    const n = barData.length
    if (n === 0) return ''
    const W = 100, H = 40, pad = 1
    const pts: Array<[number, number]> = barData.map((v, i) => [
      (i / Math.max(1, n - 1)) * W,
      H - pad - v * (H - pad * 2),
    ])
    // Catmull-Rom → 三次贝塞尔，保持频率点的原始位置。
    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[i + 2] ?? p2
      const c1x = p1[0] + (p2[0] - p0[0]) / 6
      const c1y = p1[1] + (p2[1] - p0[1]) / 6
      const c2x = p2[0] - (p3[0] - p1[0]) / 6
      const c2y = p2[1] - (p3[1] - p1[1]) / 6
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2[0].toFixed(2)} ${p2[1].toFixed(2)}`
    }
    return d
  })()
  const spectrumFillPath = spectrumPath ? `${spectrumPath} L 100 39 L 0 39 Z` : ''

  return (
    <div className="grid items-start gap-5 @min-[52rem]:grid-cols-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
      {/* 响度读数与频谱在宽内容区并排，实时轮询仍限制在本组件内。 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>响度与电平</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {/* 主卡：整合响度（大字号 + 微型趋势条） */}
          <div className="row-span-3 flex flex-col justify-between gap-5 rounded-xl p-3" style={{ background: theme.accentDim, border: `1px solid ${theme.cardBorder}` }}>
            <div className={`${theme.textSecondary} text-[10px]`}>整合响度</div>
            <div className="hse-mono font-semibold leading-none" style={{ color: theme.accentColor, fontSize: 30 }}>
              {Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'}
              <span className="text-xs ml-0.5">LUFS</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full" style={{ background: theme.trackBg }}>
              <div className="h-full transition-all duration-300" style={{ width: `${Number.isFinite(stats.lufsIntegrated) ? Math.max(0, Math.min(100, (stats.lufsIntegrated + 30) / 26 * 100)) : 0}%`, background: theme.accentColor }} />
            </div>
          </div>
          {/* 次级三格 */}
          {[
            { label: '瞬时响度', value: Number.isFinite(stats.lufsMomentary) ? stats.lufsMomentary.toFixed(1) + ' LUFS' : '—' },
            { label: 'LRA', value: Number.isFinite(stats.lra) ? stats.lra.toFixed(1) + ' LU' : '—' },
            { label: '峰值 / 真峰值', value: `${Number.isFinite(stats.peakDb) ? stats.peakDb.toFixed(1) : '—'} / ${Number.isFinite(stats.truePeakDb) ? stats.truePeakDb.toFixed(1) : '—'} dBFS` },
          ].map((item) => (
            <div key={item.label} className="min-w-0 rounded-lg border px-3 py-2" style={{ background: theme.panelBg, borderColor: theme.cardBorder }}>
              <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
              <div className={`hse-mono ${theme.textPrimary} mt-0.5 break-words text-xs font-medium`}>{item.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className={`${theme.textSecondary} text-xs`}>限幅衰减（GR）</span>
            <span className={`hse-mono ${theme.textPrimary} text-xs font-medium`}>{Number.isFinite(stats.limiterReductionDb) ? stats.limiterReductionDb.toFixed(1) : '—'} dB</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full" style={{ background: theme.trackBg }}>
            <div className="h-full transition-all duration-200" style={{ width: `${Number.isFinite(stats.limiterReductionDb) ? Math.max(0, Math.min(100, -stats.limiterReductionDb * 5)) : 0}%`, background: theme.accentColor }} />
          </div>
        </div>
      </GlassCard>

      {/* 频谱（平滑贝塞尔面积曲线，替代生硬柱状图） */}
      <GlassCard theme={theme} className="@container">
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>实时频谱</span>
        </div>
        <svg role="img" aria-label="实时频谱，20 Hz 至 20 kHz" viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-36 rounded-xl" style={{ background: theme.inputBg }}>
          <path d={spectrumFillPath} fill={theme.accentColor} fillOpacity={0.08} />
          {[10, 20, 30].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke={theme.cardBorder} vectorEffect="non-scaling-stroke" />)}
          <path d={spectrumPath} fill="none" stroke={theme.accentColor} strokeWidth={0.7} vectorEffect="non-scaling-stroke" />
        </svg>
        <div className="flex justify-between mt-1">
          <span className={`${theme.textTertiary} text-[10px]`}>20 Hz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>200 Hz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>2 kHz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>20 kHz</span>
        </div>
        {feats && (
          <div className="grid grid-cols-2 gap-3 mt-4 text-xs @min-[30rem]:grid-cols-3">
            {[
              { label: 'RMS', value: Number.isFinite(feats.rms) ? feats.rms.toFixed(3) : '—' },
              { label: '频谱质心', value: freqLabel(feats.centroidHz) },
              { label: '滚降点', value: freqLabel(feats.rolloffHz) },
              { label: '平坦度', value: Number.isFinite(feats.flatness) ? feats.flatness.toFixed(3) : '—' },
              { label: '波峰因子', value: Number.isFinite(feats.crest) ? feats.crest.toFixed(1) : '—' },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border px-2 py-1.5" style={{ background: theme.panelBg, borderColor: theme.cardBorder }}>
                <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
                <div className={`hse-mono ${theme.textPrimary} font-medium`}>{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

    </div>
  )
}

function HearingTest({ bridge, theme }: Pick<AnalysisPageProps, 'bridge' | 'theme'>) {
  const [hearing, setHearing] = useState<V3HearingSession | null>(null)

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent('v3HearingStop'))
    bridge.resetHearing()
  }, [bridge])

  const playStep = useCallback((freqHz: number, levelDb: number) => {
    window.dispatchEvent(new CustomEvent('v3HearingStop'))
    window.dispatchEvent(new CustomEvent('v3HearingPlay', { detail: { freqHz, levelDb } }))
  }, [])

  const beginHearing = useCallback(() => {
    bridge.beginHearing()
    const step = bridge.hearingStep()
    setHearing(step)
    if (step.step) playStep(step.step.freqHz, step.step.levelDb)
  }, [bridge, playStep])

  const answerHearing = useCallback((heard: boolean) => {
    if (!hearing || !hearing.step) return
    window.dispatchEvent(new CustomEvent('v3HearingStop'))
    const next = bridge.answerHearing(heard)
    setHearing(next)
    if (next.step) playStep(next.step.freqHz, next.step.levelDb)
  }, [hearing, bridge, playStep])

  return (
      <GlassCard theme={theme} className="@container">
        <div className="flex items-center gap-2 mb-3">
          <Ear className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>听力测试</span>
        </div>
        {!hearing ? (
          <div className="flex flex-wrap items-center justify-between gap-5 py-2">
            <div className={`${theme.textSecondary} max-w-xl flex-1 basis-64 text-xs leading-relaxed`}>在安静环境中佩戴耳机，测试会逐频点播放由低到高的纯音，请凭「是否听到」作答，得到个人听阈曲线。</div>
            <button type="button" onClick={beginHearing}
              className="hse-glass-button hse-glass-primary flex min-h-10 shrink-0 items-center gap-1.5 rounded-xl px-5 py-2 text-sm text-white">
              <Play className="w-4 h-4" /> 开始测试
            </button>
          </div>
        ) : hearing.done ? (
          <div className="flex flex-col items-center py-2 gap-3">
            <div className={`${theme.textPrimary} text-sm font-medium`}>测试完成</div>
            {hearing.audiogram.length > 0 ? (
              <div className="grid w-full gap-2 @min-[28rem]:grid-cols-2 @min-[50rem]:grid-cols-3">
                {hearing.audiogram.map((pt) => (
                  <div key={pt.freqHz} className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs" style={{ background: theme.panelBg, borderColor: theme.cardBorder }}>
                    <span className={`${theme.textSecondary}`}>{freqLabel(pt.freqHz)}</span>
                    <span className="hse-mono font-medium" style={{ color: theme.accentColor }}>{pt.thresholdDb.toFixed(1)} dB</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`${theme.textTertiary} text-xs`}>无数据（未作答）</div>
            )}
            <button type="button" onClick={beginHearing}
              className={`hse-glass-button flex min-h-9 items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs ${theme.textSecondary}`}>
              <RotateCcw className="w-3.5 h-3.5" /> 重新测试
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center py-2 gap-3">
            <div className="flex items-center gap-4 text-xs">
              <span className={`${theme.textSecondary}`}>频点 {Math.min(hearing.freqIndex + 1, 7)}/7</span>
              <span className={`${theme.textPrimary} font-medium`} style={{ color: theme.accentColor }}>
                {hearing.step ? freqLabel(hearing.step.freqHz) : '—'}
              </span>
              <span className={`${theme.textSecondary}`}>轮次 {Math.min(hearing.round + 1, 5)}/5</span>
            </div>
            {hearing.step && (
              <>
                <div className={`${theme.textPrimary} text-sm font-medium`}>{hearing.step.levelDb.toFixed(0)} dB</div>
                <div className={`${theme.textTertiary} text-[11px]`}>刚才的音量你是否能听到？</div>
                <div className="flex gap-3">
                  <button type="button" onClick={() => answerHearing(true)}
                    className="hse-glass-button hse-glass-primary flex min-h-10 items-center gap-1.5 rounded-xl px-5 py-2 text-sm text-white">
                    <Check className="w-4 h-4" /> 听到了
                  </button>
                  <button type="button" onClick={() => answerHearing(false)}
                    className={`hse-glass-button flex min-h-10 items-center gap-1.5 rounded-xl px-5 py-2 text-sm ${theme.textSecondary}`}>
                    <X className="w-4 h-4" /> 没听到
                  </button>
                </div>
              </>
            )}
            <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('v3HearingStop')); bridge.resetHearing(); setHearing(null) }}
              className={`hse-glass-button flex min-h-9 items-center gap-1.5 rounded-xl px-4 py-1.5 text-xs ${theme.textSecondary}`}>
              <RotateCcw className="w-3.5 h-3.5" /> 退出测试
            </button>
          </div>
        )}
      </GlassCard>
  )
}
