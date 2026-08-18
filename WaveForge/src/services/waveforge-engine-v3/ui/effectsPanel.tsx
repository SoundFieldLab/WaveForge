/**
 * WaveForge v3 调音室 UI —— 音效场景页（场景栏 + 效果卡片网格 + 响度相关卡片）
 *
 * 布局沿用 v1/v2 调音室：场景方案区（chips）+ 音效卡片（可叠加，"使用/已启用"式
 * 大按钮切换开关，点卡片本体开配置弹窗）+ 频响补偿/响度归一化独立卡片行。
 * v3 新增卡片：齿音抑制、智能均衡、限幅器、变速变调、立体声宽度、混响（双路由）。
 */

import { AudioLines, Headphones, Music2, Activity, Moon, Mic2, Sparkles, Shield, Music, Columns2, Volume2, Gauge, RotateCcw, Save, Info, Trash2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { V3EngineParams } from '../src/types'
import { createDefaultParams } from '../src/types'
import type { V3UiBridge } from './bridge'
import type { V3Theme } from './theme'
import { ActionButton, Chip, GlassCard, GlassRangeStyle, InfoLine, SectionTitle, TextInput, Toggle } from './primitives'
import type { DeepPartial, V3ParamsController } from './hooks'

/** 可配置效果卡片 id（含响度类，响度类以独立行呈现但共用弹窗） */
export type EffectUiKey =
  | 'reverb' | 'surround3d' | 'bassEnhancer' | 'compressor' | 'nightMode'
  | 'deesser' | 'ieq' | 'limiter' | 'pitch' | 'stereoWidth'
  | 'loudnessCompensation' | 'loudnessNormalization'

export const EFFECT_META: Record<EffectUiKey, { name: string; desc: string; intro: string; icon: LucideIcon; row?: boolean }> = {
  reverb: {
    name: '混响', desc: '卷积 / 算法双路由', intro: 'v3 混响支持两种路由：分区卷积混响（可导入 IR，带去周期化处理）与算法混响（大厅/房间/板式/弹簧/舞台五种类型），可自由切换。', icon: AudioLines,
  },
  surround3d: {
    name: '3D 环绕', desc: '耳机内环绕旋转', intro: '轻量立体声旋转实现：在圆形图上拖动圆点调整角度与距离，并设置旋转方向与速度，让声音在耳机内绕头旋转。', icon: Headphones,
  },
  bassEnhancer: {
    name: '低音增强', desc: '虚拟低频谐波', intro: '通过低通提取低频并生成谐波（偶次/奇次/ATSR/软饱和四种非线性），让小型设备也能感知到低频冲击力。', icon: Music2,
  },
  compressor: {
    name: '动态压缩', desc: '让响度更平稳', intro: '软拐点压缩器压平音量起伏：阈值越低压缩越狠、比率越大效果越强，补偿增益弥补压缩损失的电平。', icon: Activity,
  },
  nightMode: {
    name: '夜间模式', desc: '压缩增强 + 高频衰减', intro: '深夜语义：动态压缩增强 + 6kHz 高频衰减，低音量听感不刺耳。强度 0-10 级。', icon: Moon,
  },
  deesser: {
    name: '齿音抑制', desc: '分带 / 宽带', intro: '侧链带通检测 4-8kHz 齿音频段并压低：分带式只压高频带（推荐），宽带式整体压缩。', icon: Mic2,
  },
  ieq: {
    name: '智能均衡', desc: '目标曲线自动修正', intro: '分析当前频谱并与目标曲线（平坦/温暖/通透/人声）对比，慢速平滑自动修正，避免跟随音乐抽吸。', icon: Sparkles,
  },
  limiter: {
    name: '限幅器', desc: '前瞻 + 真峰值', intro: '前瞻式限幅保护输出：4× 过采样真峰值检测，默认 -1dBFS 阈值，杜绝削波。', icon: Shield,
  },
  pitch: {
    name: '变速变调', desc: '相位声码器 / LGPL 链接', intro: '独立变调与变速（相位声码器自研实现；可选 soundtouchjs LGPL 链接或 signalsmith WASM 路径）。', icon: Music,
  },
  stereoWidth: {
    name: '立体声宽度', desc: 'M/S 宽度 + 人声比例', intro: '基于中/侧声道分离：宽度 0-2 控制声场开合，人声比例 -1..+1 在伴奏与纯人声之间滑动（卡拉OK级）。', icon: Columns2,
  },
  loudnessCompensation: {
    name: '音量自适应补偿', desc: '等响度按音量通用曲线', intro: '低音量下人耳对低频/高频不敏感：按系统音量动态补偿低频（最高 +12dB）与高频（最高 +6dB），音量恢复后自动回平；也可选场景预设或自定义频段。', icon: Volume2, row: true,
  },
  loudnessNormalization: {
    name: '响度归一化', desc: '引擎内实时 BS.1770', intro: '逐曲实时测量响度并对齐目标（默认 -14 LUFS），切换歌曲音量一致；引擎内测量，无需外部服务。', icon: Gauge, row: true,
  },
}

/** 网格卡片顺序（响度类两卡以独立行呈现） */
const GRID_KEYS: EffectUiKey[] = ['reverb', 'surround3d', 'bassEnhancer', 'compressor', 'nightMode', 'deesser', 'ieq', 'limiter', 'pitch', 'stereoWidth']
const ROW_KEYS: EffectUiKey[] = ['loudnessCompensation', 'loudnessNormalization']

export interface EffectsPanelProps {
  controller: V3ParamsController
  bridge: V3UiBridge
  theme: V3Theme
  /** 打开效果配置弹窗（弹窗内容在 modals 文件中） */
  onOpenEffect: (key: EffectUiKey) => void
}

/** 由参数快照判定某个效果的启用态（响度类走独立字段） */
export function effectEnabled(p: V3EngineParams, key: EffectUiKey): boolean {
  switch (key) {
    case 'reverb': return p.reverb.enabled && p.reverb.mode !== 'off'
    case 'surround3d': return p.surround3d.enabled
    case 'bassEnhancer': return p.bassEnhancer.enabled
    case 'compressor': return p.compressor.enabled
    case 'nightMode': return p.nightMode.enabled && p.nightMode.amount > 0
    case 'deesser': return p.deesser.enabled
    case 'ieq': return p.ieq.enabled
    case 'limiter': return p.limiter.enabled
    case 'pitch': return p.pitch.enabled
    case 'stereoWidth': return Math.abs(p.stereoWidth - 1) > 0.001 || Math.abs(p.pitch.voiceBalance) > 0.001
    case 'loudnessCompensation': return p.loudnessCompensation.enabled
    case 'loudnessNormalization': return p.loudnessNormalization.enabled
  }
}

/** 切换效果的 enabled（响度类独立字段；pitch 开启时同时视为变速变调启用） */
export function patchEffectEnabled(patch: (partial: DeepPartial<V3EngineParams>) => void, p: V3EngineParams, key: EffectUiKey, on: boolean): void {
  switch (key) {
    case 'reverb': patch({ reverb: { ...p.reverb, enabled: on } }); return
    case 'surround3d': patch({ surround3d: { ...p.surround3d, enabled: on } }); return
    case 'bassEnhancer': patch({ bassEnhancer: { ...p.bassEnhancer, enabled: on } }); return
    case 'compressor': patch({ compressor: { ...p.compressor, enabled: on } }); return
    case 'nightMode': patch({ nightMode: { ...p.nightMode, enabled: on } }); return
    case 'deesser': patch({ deesser: { ...p.deesser, enabled: on } }); return
    case 'ieq': patch({ ieq: { ...p.ieq, enabled: on } }); return
    case 'limiter': patch({ limiter: { ...p.limiter, enabled: on } }); return
    case 'pitch': patch({ pitch: { ...p.pitch, enabled: on } }); return
    case 'stereoWidth': {
      // 宽度卡无独立开关：开启=回默认（宽 1 / 人声比例 0），关闭=… 这里用"恢复"语义
      if (!on) {
        patch({ stereoWidth: 1, pitch: { ...p.pitch, voiceBalance: 0 } })
      } else {
        patch({ stereoWidth: p.stereoWidth === 1 ? 1.3 : p.stereoWidth, pitch: { ...p.pitch, voiceBalance: 0 } })
      }
      return
    }
    case 'loudnessCompensation': patch({ loudnessCompensation: { ...p.loudnessCompensation, enabled: on } }); return
    case 'loudnessNormalization': patch({ loudnessNormalization: { ...p.loudnessNormalization, enabled: on } }); return
  }
}

export function EffectsPanel({ controller, bridge, theme, onOpenEffect }: EffectsPanelProps) {
  const { params, patch, replace } = controller
  const [sceneName, setSceneName] = useState('')
  const [scenes, setScenes] = useState(() => bridge.getScenes())

  const refreshScenes = () => setScenes(bridge.getScenes())

  const activeSceneName = params.customized ? '自定义' : (params.sceneId ? scenes.find((s) => s.id === params.sceneId)?.name ?? '无' : '无')

  const handleApplyScene = (id: string) => {
    bridge.applyScene(id)
    replace(bridge.getParams())
  }

  const handleSaveScene = () => {
    const name = sceneName.trim() || `我的场景 ${bridge.getScenes().filter((s) => !s.builtin).length + 1}`
    if (bridge.saveMyScene(name)) {
      refreshScenes()
      setSceneName('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '我的场景已达上限（8 个）', type: 'error' } }))
    }
  }

  const handleDeleteScene = (id: string) => {
    bridge.deleteMyScene(id)
    refreshScenes()
  }

  const handleResetAll = () => {
    replace(createDefaultParams(bridge.getSampleRate()))
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复默认（原声监听）', type: 'info' } }))
  }

  const renderEffectCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <div
        key={key}
        role="button"
        tabIndex={0}
        onClick={() => onOpenEffect(key)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onOpenEffect(key) }}
        className="relative cursor-pointer rounded-2xl p-3 flex flex-col items-center gap-2 transition-all hover:brightness-110"
        style={{
          background: enabled ? `${theme.accentColor}26` : theme.glassCard,
          backdropFilter: theme.glassCardBlur,
          WebkitBackdropFilter: theme.glassCardBlur,
          border: `1px solid ${enabled ? theme.accentColor : theme.glassBorder}`,
          boxShadow: enabled ? `0 0 16px ${theme.accentColor}44` : '0 4px 14px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.12)',
        }}
      >
        <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: `${theme.accentColor}22`, color: theme.accentColor }}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <div className={`text-xs font-medium ${theme.textPrimary} text-center leading-tight`}>{meta.name}</div>
        <div className={`${theme.textTertiary} text-[10px] text-center leading-tight -mt-1`}>{meta.desc}</div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); patchEffectEnabled(patch, params, key, !enabled) }}
          className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors"
          style={enabled
            ? { backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 0 10px ${theme.accentColor}55` }
            : { backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: theme.dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.7)' }}
        >
          {enabled ? '已启用' : '使用'}
        </button>
      </div>
    )
  }

  const renderRowCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <GlassCard key={key} theme={theme}>
        <div className="flex items-center justify-between">
          <div>
            <div className={`${theme.textPrimary} font-medium flex items-center gap-2`}>
              <Icon className="w-4 h-4" style={{ color: theme.accentColor }} />
              {meta.name}
            </div>
            <div className={`${theme.textSecondary} text-xs mt-0.5`}>{meta.intro}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <Toggle checked={enabled} onChange={(v) => patchEffectEnabled(patch, params, key, v)} theme={theme} />
            <ActionButton onClick={() => onOpenEffect(key)} theme={theme}>配置</ActionButton>
          </div>
        </div>
      </GlassCard>
    )
  }

  return (
    <div className="space-y-3">
      <GlassRangeStyle theme={theme} />
      {/* 场景方案区 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}
          hint={<span>当前：<span className="font-medium" style={{ color: theme.accentColor }}>{activeSceneName}</span>{params.customized && '（已手动调整）'}</span>}>
          场景方案
        </SectionTitle>
        <div className="flex items-center gap-2 mb-3">
          <TextInput value={sceneName} onChange={setSceneName} placeholder="场景名称" theme={theme} className="w-28" />
          <ActionButton onClick={handleResetAll} theme={theme} ghost title="恢复默认（录音棚场景，关闭全部音效）">
            <RotateCcw className="w-3.5 h-3.5" /> 恢复默认
          </ActionButton>
          <ActionButton onClick={handleSaveScene} theme={theme}>
            <Save className="w-3.5 h-3.5" /> 保存为场景
          </ActionButton>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
          {scenes.map((scene) => {
            const active = !params.customized && params.sceneId === scene.id
            return (
              <Chip key={scene.id} active={active} onClick={() => handleApplyScene(scene.id)} theme={theme}
                deleteButton={!scene.builtin ? (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDeleteScene(scene.id) }}
                    className={`absolute -top-1.5 -right-1.5 p-1 rounded-full ${theme.dark ? 'bg-black/70' : 'bg-white/80'} shadow-md`}
                    title="删除场景"
                  >
                    <Trash2 className="w-3 h-3" style={{ color: theme.textSecondary }} />
                  </button>
                ) : undefined}
              >
                <div className={`text-xs font-medium ${active ? '' : theme.textPrimary}`} style={active ? { color: theme.accentColor } : undefined}>
                  {scene.builtin ? '' : '★ '}{scene.name}
                </div>
                {scene.description && <div className={`${theme.textTertiary} text-[10px] mt-0.5 max-w-[130px] leading-snug line-clamp-2`}>{scene.description}</div>}
              </Chip>
            )
          })}
        </div>
        <InfoLine theme={theme}>
          <span>点击场景一键应用整套听感；手动调整过参数后再次点击场景会直接覆盖当前设置（建议先保存为场景）。</span>
        </InfoLine>
      </GlassCard>

      {/* 效果卡片网格（可叠加） */}
      <GlassCard theme={theme}>
        <SectionTitle theme={theme}>音效（可叠加，点卡片配置）</SectionTitle>
        <div className="grid grid-cols-4 gap-2.5">
          {GRID_KEYS.map(renderEffectCard)}
        </div>
      </GlassCard>

      {/* 响度相关独立卡片（与音效卡片分离：响度类设置） */}
      <SectionTitle icon={<Volume2 className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}>响度相关</SectionTitle>
      {ROW_KEYS.map(renderRowCard)}
      <InfoLine theme={theme}>
        <span><Info className="w-3 h-3 shrink-0" /> 音量自适应补偿与响度归一化可同时开启：补偿负责频响感知，归一化负责音量对齐。</span>
      </InfoLine>
    </div>
  )
}