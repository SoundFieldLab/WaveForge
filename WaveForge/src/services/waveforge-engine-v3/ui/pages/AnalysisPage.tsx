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

export default function AnalysisPage({ bridge, theme }: AnalysisPageProps) {
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())
  const [analysis, setAnalysis] = useState<EngineAnalysis>(() => bridge.getAnalysis())
  const [hearing, setHearing] = useState<V3HearingSession | null>(null)
  const timerRef = useRef<number | null>(null)
  // 频谱条 EMA 平滑（防 10fps 更新跳变，观感接近连续）
  const smoothedRef = useRef<number[] | null>(null)

  useEffect(() => {
    const tick = () => { setStats(bridge.getStats()); setAnalysis(bridge.getAnalysis()) }
    tick()
    timerRef.current = window.setInterval(tick, POLL_MS)
    return () => { if (timerRef.current !== null) window.clearInterval(timerRef.current) }
  }, [bridge])

  const beginHearing = useCallback(() => {
    bridge.beginHearing()
    setHearing(bridge.hearingStep())
  }, [bridge])

  const playStep = useCallback((freqHz: number, levelDb: number) => {
    window.dispatchEvent(new CustomEvent('v3HearingPlay', { detail: { freqHz, levelDb } }))
  }, [])

  const answerHearing = useCallback((heard: boolean) => {
    if (!hearing || !hearing.step) return
    playStep(hearing.step.freqHz, -60)
    const next = bridge.answerHearing(heard)
    setHearing(next)
    if (next.step) playStep(next.step.freqHz, next.step.levelDb)
  }, [hearing, bridge, playStep])

  const spectrum = analysis.spectrum
  const barData: number[] = (() => {
    if (!spectrum) return Array(BARS).fill(0)
    const len = spectrum.length
    // FFT bin 幅度归一化到 0dBFS：满幅正弦在 Hann 窗下的 bin 峰值 = N/4
    // （N = (len-1)*2），原实现把原始 bin 值当线性幅度直接取 dB，-47dB 以上
    // 的信号就会顶满条、显示毫无动态。除以 N/4 后 -80dBFS..0dBFS 映射 0..1。
    const normScale = 2 / (len - 1)
    const binHz = bridge.getSampleRate() / ((len - 1) * 2)
    const topHz = Math.min(20000, bridge.getSampleRate() / 2)
    const out: number[] = []
    for (let i = 0; i < BARS; i++) {
      // 对数频率轴（音乐频谱标准做法）：20Hz..topHz 等比均分，
      // 线性轴会把 20-100Hz 低音全挤进第一根条、低频分辨率归零
      const fLo = SPECTRUM_MIN_HZ * Math.pow(topHz / SPECTRUM_MIN_HZ, i / BARS)
      const fHi = SPECTRUM_MIN_HZ * Math.pow(topHz / SPECTRUM_MIN_HZ, (i + 1) / BARS)
      const kLo = Math.max(1, Math.floor(fLo / binHz))
      const kHi = Math.min(len - 1, Math.ceil(fHi / binHz))
      let peak = 0
      for (let k = kLo; k <= kHi; k++) peak = Math.max(peak, (spectrum[k] ?? 0) * normScale)
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
  const freqLabel = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : Math.round(f)) + 'Hz'

  /** 把 0..1 的柱值序列转成 Catmull-Rom→三次贝塞尔平滑面积路径（SVG viewBox 100×40） */
  const spectrumPath = (() => {
    const n = barData.length
    if (n === 0) return ''
    const W = 100, H = 40, pad = 1
    const pts: Array<[number, number]> = barData.map((v, i) => [
      (i / (n - 1)) * W,
      H - pad - v * (H - pad * 2),
    ])
    // Catmull-Rom → 三次贝塞尔（张力 0.5）：模拟模拟电路柔和感
    let d = `M ${pts[0][0].toFixed(2)} ${(H - pad).toFixed(2)} L ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`
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
    d += ` L ${pts[n - 1][0].toFixed(2)} ${(H - pad).toFixed(2)} Z`
    return d
  })()

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 响度读数（Bento Grid：整合响度大字号主卡 + 3 个次级 + GR 仪表） */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>响度与电平</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {/* 主卡：整合响度（大字号 + 微型趋势条） */}
          <div className="col-span-3 sm:col-span-1 row-span-2 rounded-xl p-3 flex flex-col justify-between" style={{ background: `${theme.accentColor}14`, border: `1px solid ${theme.accentColor}33` }}>
            <div className={`${theme.textTertiary} text-[10px]`}>整合响度</div>
            <div className="hse-mono font-semibold leading-none" style={{ color: theme.accentColor, fontSize: 30 }}>
              {Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'}
              <span className="text-xs ml-0.5 opacity-70">LUFS</span>
            </div>
            <div className="h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
              <div className="h-full transition-all duration-300" style={{ width: `${Math.max(4, Math.min(100, (stats.lufsIntegrated + 30) / 26 * 100))}%`, background: theme.accentColor }} />
            </div>
          </div>
          {/* 次级三格 */}
          {[
            { label: '短时响度', value: Number.isFinite(stats.lufsMomentary) ? stats.lufsMomentary.toFixed(1) + ' LUFS' : '—' },
            { label: 'LRA', value: Number.isFinite(stats.lra) ? stats.lra.toFixed(1) + ' LU' : '—' },
            { label: '峰值 / 真峰值', value: `${stats.peakDb.toFixed(1)} / ${stats.truePeakDb.toFixed(1)} dBFS` },
          ].map((item) => (
            <div key={item.label} className="px-3 py-2 rounded-lg bg-white/5 border border-white/10">
              <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
              <div className={`hse-mono ${theme.textPrimary} font-medium mt-0.5`}>{item.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className={`${theme.textSecondary} text-xs`}>限幅衰减（GR）</span>
            <span className={`hse-mono ${theme.textPrimary} text-xs font-medium`}>{stats.limiterReductionDb.toFixed(1)} dB</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.08)' }}>
            <div className="h-full transition-all duration-200" style={{ width: `${Math.min(100, -stats.limiterReductionDb * 5)}%`, background: theme.accentColor }} />
          </div>
        </div>
      </GlassCard>

      {/* 频谱（平滑贝塞尔面积曲线，替代生硬柱状图） */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Activity className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>实时频谱</span>
        </div>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-24" style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="hse-spec-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={theme.accentColor} stopOpacity={0.55} />
              <stop offset="100%" stopColor={theme.accentColor} stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <path d={spectrumPath} fill="url(#hse-spec-grad)" />
          <path d={spectrumPath} fill="none" stroke={theme.accentColor} strokeWidth={0.7} vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 3px ${theme.accentGlow})` }} />
        </svg>
        <div className="flex justify-between mt-1">
          <span className={`${theme.textTertiary} text-[10px]`}>20Hz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>200Hz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>2kHz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>20kHz</span>
        </div>
        {feats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3 text-xs">
            {[
              { label: 'RMS', value: feats.rms.toFixed(3) },
              { label: '频谱质心', value: freqLabel(feats.centroidHz) },
              { label: '滚降点', value: freqLabel(feats.rolloffHz) },
              { label: '平坦度', value: feats.flatness.toFixed(3) },
              { label: '波峰因子', value: feats.crest.toFixed(1) },
            ].map((item) => (
              <div key={item.label} className="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10">
                <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
                <div className={`${theme.textPrimary} font-medium`}>{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      {/* 听力测试 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Ear className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>听力测试</span>
        </div>
        {!hearing ? (
          <div className="flex flex-col items-center py-4 gap-3">
            <div className={`${theme.textSecondary} text-xs text-center max-w-sm`}>在安静环境中佩戴耳机，测试会逐频点播放由低到高的纯音，请凭「是否听到」作答，得到个人听阈曲线。</div>
            <button type="button" onClick={beginHearing}
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm text-white transition-all hover:brightness-110 active:scale-95"
              style={{ backgroundColor: theme.accentColor }}>
              <Play className="w-4 h-4" /> 开始测试
            </button>
          </div>
        ) : hearing.done ? (
          <div className="flex flex-col items-center py-2 gap-3">
            <div className={`${theme.textPrimary} text-sm font-medium`}>测试完成 🎉</div>
            {hearing.audiogram.length > 0 ? (
              <div className="w-full space-y-1.5">
                {hearing.audiogram.map((pt) => (
                  <div key={pt.freqHz} className="flex items-center justify-between px-3 py-1.5 rounded-lg text-xs bg-white/5 border border-white/10">
                    <span className={`${theme.textSecondary}`}>{freqLabel(pt.freqHz)}</span>
                    <span className="font-medium" style={{ color: theme.accentColor }}>{pt.thresholdDb.toFixed(1)} dB</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`${theme.textTertiary} text-xs`}>无数据（未作答）</div>
            )}
            <button type="button" onClick={beginHearing}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs transition-all hover:brightness-110 ${theme.textSecondary}`}
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}>
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
                    className="flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm text-white transition-all hover:brightness-110 active:scale-95"
                    style={{ backgroundColor: theme.accentColor }}>
                    <Check className="w-4 h-4" /> 听到了
                  </button>
                  <button type="button" onClick={() => answerHearing(false)}
                    className={`flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm transition-all hover:brightness-110 active:scale-95 ${theme.textSecondary}`}
                    style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}>
                    <X className="w-4 h-4" /> 没听到
                  </button>
                </div>
              </>
            )}
            <button type="button" onClick={() => { bridge.resetHearing(); setHearing(null) }}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs transition-all hover:brightness-110 ${theme.textSecondary}`}
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}>
              <RotateCcw className="w-3.5 h-3.5" /> 退出测试
            </button>
          </div>
        )}
      </GlassCard>
    </div>
  )
}
