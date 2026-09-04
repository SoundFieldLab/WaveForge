/**
 * 主页 —— 系统总览
 *
 * 参考图：系统音效可视化 + 音效模式快捷卡片 + 音量控制 + 环境音效快捷
 */

import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { Volume2, Power, Music2, Zap, AudioLines } from 'lucide-react'
import { GlassCard, Toggle, Slider, RangeStyle } from '../components/Primitives'
import { WaveformVisualizer } from '../components/WaveformVisualizer'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import type { EngineStats } from '../../src/types'
import { createDefaultParams } from '../../src/types'

interface HomePageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  /** 跳转到指定页面（如场景预设页） */
  onNavigate?: (page: string) => void
}

/** 音效模式 → v3 场景映射（Hi-Fi=录音棚监听平直 / 增强=现场感低频冲击 / 影院=浩渺环绕） */
const QUICK_SCENES = [
  { id: 'studio', name: 'Hi-Fi 模式', desc: '原声还原，细节丰富', icon: Music2 },
  { id: 'enhanced', name: '增强模式', desc: '现场感与低频冲击', icon: Zap },
  { id: 'dts', name: '影院模式', desc: '沉浸环绕，震撼体验', icon: AudioLines },
]

/** 环境音效 → 混响类型映射（v3 算法混响 5 型：hall/room/plate/spring/stage） */
const AMBIENCE_OPTIONS = [
  { key: 'off', label: '关闭', type: null },
  { key: 'hall', label: '音乐厅', type: 'hall' },
  { key: 'plate', label: '录音室', type: 'plate' },
  { key: 'stage', label: '演唱会', type: 'stage' },
  { key: 'room', label: '地下室', type: 'room' },
  { key: 'custom', label: '自定义', type: 'custom' },
] as const

/** 是否任一「音效类」模块启用（系统音效总开关状态；EQ/限幅为默认开启的保护项，不计入） */
function anyEffectOn(p: ReturnType<V3UiBridge['getParams']>): boolean {
  return p.reverb.enabled || p.surround3d.enabled || p.bassEnhancer.enabled ||
    p.compressor.enabled || p.nightMode.enabled || p.deesser.enabled ||
    p.ieq.enabled || p.pitch.enabled ||
    p.loudnessCompensation.enabled || p.loudnessNormalization.enabled ||
    Math.abs(p.stereoWidth - 1) > 0.001 || Math.abs(p.pitch.voiceBalance) > 0.001
}

export default function HomePage({ bridge, controller, theme, onOpenEffect, onNavigate }: HomePageProps) {
  const { params, patch, replace } = controller
  const [volume, setVolume] = useState(params.loudnessCompensation.volumePercent)
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())
  const timerRef = useRef<number | null>(null)

  // 统计卡实时轮询（与底部状态栏一致）
  useEffect(() => {
    const tick = () => setStats(bridge.getStats())
    tick()
    timerRef.current = window.setInterval(tick, 300)
    return () => { if (timerRef.current !== null) window.clearInterval(timerRef.current) }
  }, [bridge])

  const handleApplyScene = (id: string) => {
    bridge.applyScene(id)
    replace(bridge.getParams())
  }

  const isAnyEffectOn = anyEffectOn(params)

  /** 系统音效总开关：开启/关闭两态 Toggle。
   *  - 关闭态（!isAnyEffectOn）：点击 = 开启，默认应用 'enhanced'（增强模式）场景预设；
   *  - 开启态（isAnyEffectOn）：点击 = 关闭，恢复默认（原声监听，所有音效关闭）。
   *  bridge.applyScene 已内置保留 loudnessNormalization 状态（音量独立于场景预设）。 */
  const handleMasterToggle = () => {
    if (isAnyEffectOn) {
      replace(createDefaultParams(bridge.getSampleRate()))
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已关闭音效（原声监听）', type: 'info' } }))
    } else {
      bridge.applyScene('enhanced')
      replace(bridge.getParams())
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已开启增强模式', type: 'info' } }))
    }
  }

  /** 音量 0-100 → 引擎输出增益 dB（0%=-60dB 静音，100%=0dB 原声）；经响度归一化外部增益通道生效 */
  const volumeToGainDb = (v: number) => Math.round((v - 100) * 0.6)

  const handleVolumeChange = (v: number) => {
    setVolume(v)
    const ln = params.loudnessNormalization
    patch({
      loudnessNormalization: {
        ...ln,
        enabled: true,
        useRealtimeMeter: false,
        externalGainDb: volumeToGainDb(v),
        minGainDb: -60,
        maxGainDb: 12,
      },
    })
  }

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 系统音效可视化 */}
      <div className="flex gap-4">
        <GlassCard theme={theme} className="flex-1" style={{ minHeight: 260 }}>
          <div className="flex items-center justify-between mb-2">
            <span className={`${theme.textPrimary} text-sm font-medium`}>系统音效</span>
            <button
              type="button"
              onClick={handleMasterToggle}
              className="p-2 rounded-full transition-colors"
              style={{ background: isAnyEffectOn ? 'rgba(255,255,255,0.06)' : `${theme.accentColor}33` }}
              title={isAnyEffectOn ? '关闭全部音效（恢复默认）' : '开启音效（增强模式）'}
            >
              <Power className="w-4 h-4" style={{ color: isAnyEffectOn ? 'rgba(255,255,255,0.35)' : theme.accentColor }} />
            </button>
          </div>
          <div className="relative rounded-xl overflow-hidden" style={{ height: 200 }}>
            <WaveformVisualizer theme={theme} active={isAnyEffectOn} />
          </div>
        </GlassCard>

        {/* 右侧快捷信息 */}
        <div className="w-[220px] shrink-0 space-y-3">
          <GlassCard theme={theme}>
            <div className={`${theme.textSecondary} text-[10px] mb-1`}>整合响度</div>
            <div className={`hse-mono ${theme.textPrimary} text-lg font-semibold`} style={{ color: theme.accentColor }}>
              {Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'} <span className="text-xs">LUFS</span>
            </div>
          </GlassCard>
          <GlassCard theme={theme}>
            <div className={`${theme.textSecondary} text-[10px] mb-1`}>引擎延迟</div>
            <div className={`hse-mono ${theme.textPrimary} text-lg font-semibold`}>
              {(stats.engineLatencySamples / bridge.getSampleRate() * 1000).toFixed(1)} <span className="text-xs">ms</span>
            </div>
          </GlassCard>
          <GlassCard theme={theme}>
            <div className={`${theme.textSecondary} text-[10px] mb-1`}>限幅衰减</div>
            <div className={`hse-mono ${theme.textPrimary} text-lg font-semibold`} style={{ color: stats.limiterReductionDb < -0.1 ? '#fbbf24' : undefined }}>
              {stats.limiterReductionDb.toFixed(1)} <span className="text-xs">dB</span>
            </div>
          </GlassCard>
        </div>
      </div>

      {/* 音效模式快捷卡片 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className={`${theme.textPrimary} text-sm font-medium`}>音效模式</div>
          <button
            type="button"
            onClick={() => onNavigate?.('scenes')}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] text-white/70 transition-all hover:brightness-110"
            style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}
            title="跳转到场景预设页，可应用全部 11 个内置场景与自定义场景"
          >
            更多场景
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
        <div className="flex gap-2.5">
          {QUICK_SCENES.map((sc) => {
            const Icon = sc.icon
            const active = params.sceneId === sc.id && !params.customized
            return (
              <motion.button
                key={sc.id}
                type="button"
                whileHover={{ y: -2 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleApplyScene(sc.id)}
                className="relative flex-1 rounded-2xl px-3 py-3 text-left transition-colors"
                style={{
                  background: active
                    ? `linear-gradient(135deg, ${theme.accentDim} 0%, rgba(18,18,22,0.8) 100%)`
                    : theme.cardBg,
                  border: `1px solid ${active ? theme.accentColor : theme.cardBorder}`,
                  boxShadow: active ? `0 0 20px ${theme.accentGlow}` : theme.cardGlow,
                }}
              >
                <motion.div
                  className="w-9 h-9 rounded-xl flex items-center justify-center mb-2"
                  style={{ background: `${theme.accentColor}22` }}
                  animate={{ scale: active ? 1.1 : 1 }}
                  transition={{ type: 'spring', stiffness: 350, damping: 18 }}
                >
                  <Icon className="w-4.5 h-4.5" style={{ color: theme.accentColor }} />
                </motion.div>
                <div className={`${theme.textPrimary} text-[13px] font-medium mb-0.5 truncate`}>{sc.name}</div>
                <div className={`${theme.textTertiary} text-[10px] truncate`}>{sc.desc}</div>
                {active && <div className="absolute top-2 right-2 w-2 h-2 rounded-full" style={{ background: theme.accentColor, boxShadow: `0 0 6px ${theme.accentColor}` }} />}
              </motion.button>
            )
          })}
        </div>
      </div>

      {/* 音量控制（引擎输出增益，实时生效） */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-3 mb-3">
          <Volume2 className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>音量控制</span>
          <span className={`hse-mono ${theme.textSecondary} text-xs ml-auto`}>{volume}% · {volumeToGainDb(volume) > 0 ? '+' : ''}{volumeToGainDb(volume)}dB</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
          className="wf-hse-range w-full h-2 rounded-full appearance-none cursor-pointer"
          style={{ background: theme.sliderTrack(volume, 0, 100) }}
        />
        <div className="flex justify-between mt-1.5">
          {Array.from({ length: 21 }).map((_, i) => {
            const pct = i * 5
            const major = pct === 0 || pct === 50 || pct === 100
            const filled = pct <= volume
            return (
              <div
                key={i}
                className="w-0.5 rounded-full"
                style={{
                  height: major ? 11 : 6,
                  background: filled ? theme.accentColor : 'rgba(255,255,255,0.14)',
                  opacity: major ? 1 : 0.7,
                }}
              />
            )
          })}
        </div>
        <div className={`${theme.textTertiary} text-[10px] mt-1.5`}>拖动即时改变输出响度（0% 静音 ~ 100% 原声，经引擎增益通道）。</div>
      </GlassCard>

      {/* 环境音效快捷 */}
      <div>
        <div className={`${theme.textPrimary} text-sm font-medium mb-2`}>环境音效</div>
        <div className="flex gap-2">
          {AMBIENCE_OPTIONS.map((env) => {
            const isActive = env.type !== null && env.type !== 'custom'
              ? params.reverb.enabled && params.reverb.mode === 'algorithmic' && params.reverb.algorithmic.type === env.type
              : env.key === 'off' ? !params.reverb.enabled : false
            return (
              <button
                key={env.key}
                type="button"
                onClick={() => {
                  if (env.key === 'off') {
                    patch({ reverb: { ...params.reverb, enabled: false } })
                  } else if (env.type !== 'custom') {
                    patch({
                      reverb: {
                        ...params.reverb,
                        enabled: true,
                        mode: 'algorithmic',
                        algorithmic: { ...params.reverb.algorithmic, type: env.type as 'hall' | 'room' | 'plate' | 'spring' | 'stage' },
                      },
                    })
                  } else {
                    onOpenEffect('reverb')
                  }
                }}
                className="flex-1 rounded-xl py-3 flex flex-col items-center gap-1.5 transition-all"
                style={{
                  background: isActive ? `${theme.accentDim}` : theme.cardBg,
                  border: `1px solid ${isActive ? theme.accentColor : theme.cardBorder}`,
                }}
              >
                <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: isActive ? `${theme.accentColor}33` : 'rgba(255,255,255,0.05)' }}>
                  <AudioLines className="w-3.5 h-3.5" style={{ color: isActive ? theme.accentColor : 'rgba(255,255,255,0.35)' }} />
                </div>
                <span className={`text-[11px] ${isActive ? theme.textPrimary : theme.textTertiary}`}>{env.label}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
