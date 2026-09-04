/**
 * WaveForge v3 调音室 UI —— 分析页
 *
 * 实时读数：LUFS/LRA/峰值/真峰值 + 频谱条形图 + 频谱特征（质心/滚降/平坦度等）；
 * 听力测试流程（7 频点 × 5 轮二分逼近听阈），播放/合成由融合侧按 nextStep 电平执行。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, Ear, Play, RotateCcw, Check, X } from 'lucide-react'
import type { EngineAnalysis, EngineStats } from '../src/types'
import type { V3Theme } from './theme'
import type { V3UiBridge, V3HearingSession } from './bridge'
import { ActionButton, GlassCard, GlassRangeStyle, InfoLine, SectionTitle } from './primitives'
import type { V3ParamsController } from './hooks'

/** 轮询刷新（实时读数；播放时才需要，融合侧可改由事件驱动） */
const POLL_MS = 300

export function AnalysisPanel({ bridge, theme, controller }: { bridge: V3UiBridge; theme: V3Theme; controller: V3ParamsController }) {
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())
  const [analysis, setAnalysis] = useState<EngineAnalysis>(() => bridge.getAnalysis())
  const [hearing, setHearing] = useState<V3HearingSession | null>(null)
  const timerRef = useRef<number | null>(null)

  // 轮询引擎读数
  useEffect(() => {
    const tick = () => {
      setStats(bridge.getStats())
      setAnalysis(bridge.getAnalysis())
    }
    tick()
    timerRef.current = window.setInterval(tick, POLL_MS)
    return () => { if (timerRef.current !== null) window.clearInterval(timerRef.current) }
  }, [bridge])

  // 听力测试：播放当前步骤（融合侧接线：Web Audio 合成正弦 → 电平换算；此处用事件让宿主接管）
  const beginHearing = useCallback(() => {
    bridge.beginHearing()
    setHearing(bridge.hearingStep())
  }, [bridge])

  const playStep = useCallback((freqHz: number, levelDb: number) => {
    // 实际发声由融合侧监听 showToast 事件或替换本实现；这里派发宿主事件
    window.dispatchEvent(new CustomEvent('v3HearingPlay', { detail: { freqHz, levelDb } }))
  }, [])

  const answerHearing = useCallback((heard: boolean) => {
    if (!hearing || !hearing.step) return
    playStep(hearing.step.freqHz, -60) // 停止当前音
    const next = bridge.answerHearing(heard)
    setHearing(next)
    if (next.step) {
      playStep(next.step.freqHz, next.step.levelDb)
    }
  }, [hearing, bridge, playStep])

  // 频谱（dB 归一化到 0..1 条形）
  const spectrum = analysis.spectrum
  const BARS = 32
  const barData: number[] = (() => {
    if (!spectrum) return Array(BARS).fill(0)
    const out: number[] = []
    const step = Math.max(1, Math.floor(spectrum.length / BARS))
    for (let i = 0; i < BARS; i++) {
      const start = i * step
      const end = Math.min(spectrum.length, start + step)
      let peak = 0
      for (let j = start; j < end; j++) peak = Math.max(peak, spectrum[j] ?? 0)
      // 幅度 → dB（-80..0 → 0..1）
      const db = 20 * Math.log10(Math.max(peak, 1e-4))
      out.push(Math.min(1, Math.max(0, (db + 80) / 80)))
    }
    return out
  })()

  const feats = analysis.features
  const freqLabel = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(1)}k` : Math.round(f)) + 'Hz'

  return (
    <div className="space-y-3">
      <GlassRangeStyle theme={theme} />
      {/* 响度读数 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Activity className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}
          hint="引擎内实时 BS.1770 测量（限幅器前取样）">
          响度与电平
        </SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
          {([
            { label: '整合响度', value: Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) + ' LUFS' : '—' },
            { label: '短时响度', value: Number.isFinite(stats.lufsMomentary) ? stats.lufsMomentary.toFixed(1) + ' LUFS' : '—' },
            { label: 'LRA', value: Number.isFinite(stats.lra) ? stats.lra.toFixed(1) + ' LU' : '—' },
            { label: '峰值 / 真峰值', value: `${stats.peakDb.toFixed(1)} / ${stats.truePeakDb.toFixed(1)} dBFS` },
          ]).map((item) => (
            <div key={item.label} className="px-3 py-2 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
              <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
              <div className={`${theme.textPrimary} font-medium mt-0.5`}>{item.value}</div>
            </div>
          ))}
        </div>
        {/* 限幅衰减条 */}
        <div className="mt-3">
          <div className="flex items-center justify-between mb-1">
            <span className={`${theme.textSecondary} text-xs`}>限幅衰减（GR）</span>
            <span className={`${theme.textPrimary} text-xs font-medium`}>{stats.limiterReductionDb.toFixed(1)} dB</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
            <div className="h-full transition-all duration-200" style={{ width: `${Math.min(100, -stats.limiterReductionDb * 5)}%`, background: theme.accentColor, boxShadow: `0 0 8px ${theme.accentColor}66` }} />
          </div>
        </div>
      </GlassCard>

      {/* 频谱 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Activity className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}
          hint="2048 点 FFT 实时频谱（LoudnessComp 之后取样）">
          频谱
        </SectionTitle>
        <div className="flex items-end gap-[2px] h-24">
          {barData.map((v, i) => (
            <div key={i} className="flex-1 rounded-t-sm transition-all duration-150"
              style={{ height: `${Math.max(3, v * 100)}%`, background: v > 0.85 ? theme.accentColor : `${theme.accentColor}55`, opacity: 0.35 + 0.65 * v }} />
          ))}
        </div>
        <div className="flex justify-between mt-1">
          <span className={`${theme.textTertiary} text-[10px]`}>20Hz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>1kHz</span>
          <span className={`${theme.textTertiary} text-[10px]`}>20kHz</span>
        </div>
        {feats && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-3 text-xs">
            {([
              { label: 'RMS', value: feats.rms.toFixed(3) },
              { label: '频谱质心', value: freqLabel(feats.centroidHz) },
              { label: '滚降点', value: freqLabel(feats.rolloffHz) },
              { label: '平坦度', value: feats.flatness.toFixed(3) },
              { label: '波峰因子', value: feats.crest.toFixed(1) },
            ]).map((item) => (
              <div key={item.label} className="px-2 py-1.5 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
                <div className={`${theme.textTertiary} text-[10px]`}>{item.label}</div>
                <div className={`${theme.textPrimary} font-medium`}>{item.value}</div>
              </div>
            ))}
          </div>
        )}
      </GlassCard>

      {/* 听力测试 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Ear className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}
          hint="7 频点 × 5 轮二分逼近听阈（125Hz–8kHz，-60..0dB）">
          听力测试
        </SectionTitle>
        {!hearing ? (
          <div className="flex flex-col items-center py-4 gap-3">
            <div className={`${theme.textSecondary} text-xs text-center`}>在安静环境中佩戴耳机，测试会逐频点播放由低到高的纯音，请凭「是否听到」作答，得到个人听阈曲线。</div>
            <ActionButton onClick={beginHearing} theme={theme}>
              <Play className="w-4 h-4" /> 开始测试
            </ActionButton>
          </div>
        ) : hearing.done ? (
          <div className="flex flex-col items-center py-2 gap-3">
            <div className={`${theme.textPrimary} text-sm font-medium`}>测试完成 🎉</div>
            {hearing.audiogram.length > 0 ? (
              <div className="w-full space-y-1.5">
                {hearing.audiogram.map((pt) => (
                  <div key={pt.freqHz} className="flex items-center justify-between px-3 py-1.5 rounded-lg text-xs" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
                    <span className={`${theme.textSecondary}`}>{freqLabel(pt.freqHz)}</span>
                    <span className={`${theme.textPrimary} font-medium`} style={{ color: theme.accentColor }}>{pt.thresholdDb.toFixed(1)} dB</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`${theme.textTertiary} text-xs`}>无数据（未作答）</div>
            )}
            <ActionButton onClick={beginHearing} theme={theme} ghost>
              <RotateCcw className="w-3.5 h-3.5" /> 重新测试
            </ActionButton>
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
                    style={{ backgroundColor: theme.accentColor, boxShadow: `0 4px 14px ${theme.accentColor}44` }}>
                    <Check className="w-4 h-4" /> 听到了
                  </button>
                  <button type="button" onClick={() => answerHearing(false)}
                    className={`flex items-center gap-1.5 px-5 py-2 rounded-xl text-sm transition-all hover:brightness-110 active:scale-95 ${theme.textSecondary}`}
                    style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
                    <X className="w-4 h-4" /> 没听到
                  </button>
                </div>
              </>
            )}
            <ActionButton onClick={() => { bridge.resetHearing(); setHearing(null) }} theme={theme} ghost>
              <RotateCcw className="w-3.5 h-3.5" /> 退出测试
            </ActionButton>
          </div>
        )}
        <InfoLine theme={theme}>播放由融合侧监听 `v3HearingPlay` 事件合成纯音（正弦，电平按 dBFS 换算）；本页为状态机与流程 UI。</InfoLine>
      </GlassCard>
    </div>
  )
}