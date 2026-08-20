/**
 * 音效场景页 —— 场景预设 + 效果卡片
 */

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Sparkles, Save, RotateCcw, Trash2, Volume2, Gauge } from 'lucide-react'
import { GlassCard, Toggle, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import { MAX_MY_SCENES, type V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import {
  EFFECT_META, effectEnabled, patchEffectEnabled,
} from '../effectsPanel'
import type { EffectUiKey } from '../effectsPanel'
import { createDefaultParams } from '../../src/types'

interface ScenesPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

const GRID_KEYS: EffectUiKey[] = ['reverb', 'surround3d', 'bassEnhancer', 'compressor', 'nightMode', 'deesser', 'ieq', 'limiter', 'pitch', 'stereoWidth']
const ROW_KEYS: EffectUiKey[] = ['loudnessCompensation', 'loudnessNormalization']

export default function ScenesPage({ bridge, controller, theme, onOpenEffect }: ScenesPageProps) {
  const { params, patch, replace } = controller
  const [sceneName, setSceneName] = useState('')
  const [scenes, setScenes] = useState(() => bridge.getScenes())

  const refreshScenes = () => setScenes(bridge.getScenes())

  const handleApplyScene = (id: string) => {
    bridge.applyScene(id)
    replace(bridge.getParams())
    refreshScenes()
  }

  const handleSaveScene = () => {
    const name = sceneName.trim() || `我的场景 ${bridge.getScenes().filter((s) => !s.builtin).length + 1}`
    if (bridge.saveMyScene(name)) {
      refreshScenes()
      setSceneName('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已达 ${MAX_MY_SCENES} 个上限，请先删除旧场景`, type: 'error' } }))
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

  const activeSceneName = params.customized ? '自定义' : (params.sceneId ? scenes.find((s) => s.id === params.sceneId)?.name ?? '无' : '无')

  const renderEffectCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <motion.div
        key={key}
        role="button"
        tabIndex={0}
        whileHover={{ y: -2 }}
        onClick={() => onOpenEffect(key)}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) onOpenEffect(key) }}
        className="relative cursor-pointer rounded-xl p-3 flex flex-col items-center gap-2 transition-colors"
        animate={{ opacity: enabled ? 1 : 0.62 }}
        style={{
          background: enabled ? `${theme.accentDim}` : theme.cardBg,
          border: `1px solid ${enabled ? theme.accentColor : theme.cardBorder}`,
          boxShadow: enabled ? `0 0 14px ${theme.accentGlow}` : theme.cardGlow,
        }}
      >
        {/* 激活呼吸灯：边框辉光缓慢明灭 */}
        {enabled && (
          <motion.div
            className="pointer-events-none absolute inset-0 rounded-xl"
            style={{ boxShadow: `inset 0 0 12px ${theme.accentColor}55` }}
            animate={{ opacity: [0.35, 0.7, 0.35] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}
        <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${theme.accentColor}22` }}>
          <Icon className="w-5 h-5" style={{ color: theme.accentColor }} />
        </div>
        <div className={`text-xs font-medium ${theme.textPrimary} text-center leading-tight`}>{meta.name}</div>
        <div className={`${theme.textTertiary} text-[10px] text-center leading-tight -mt-1`}>{meta.desc}</div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); patchEffectEnabled(patch, params, key, !enabled) }}
          className="relative w-full py-1.5 rounded-lg text-[11px] font-medium transition-colors"
          style={enabled
            ? { backgroundColor: theme.accentColor, color: '#fff' }
            : { backgroundColor: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }}
        >
          {enabled ? '已启用' : '使用'}
        </button>
      </motion.div>
    )
  }

  const renderRowCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <GlassCard key={key} theme={theme}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon className="w-4 h-4" style={{ color: theme.accentColor }} />
            <div>
              <div className={`${theme.textPrimary} text-sm font-medium`}>{meta.name}</div>
              <div className={`${theme.textTertiary} text-[10px]`}>{meta.desc}</div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-3">
            <Toggle checked={enabled} onChange={(v) => patchEffectEnabled(patch, params, key, v)} theme={theme} />
            <button
              type="button"
              onClick={() => onOpenEffect(key)}
              className="px-2.5 py-1 rounded-lg text-[11px] text-white/70 transition-all hover:brightness-110"
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}
            >
              配置
            </button>
          </div>
        </div>
      </GlassCard>
    )
  }

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 场景方案 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>场景方案</span>
          </div>
          <span className="text-xs" style={{ color: theme.accentColor }}>当前：{activeSceneName}{params.customized ? '（已调整）' : ''}</span>
        </div>

        <div className="flex gap-3">
          {/* 左：场景列表（纵向，替代横向滚动条） */}
          <div className="w-[168px] shrink-0 flex flex-col gap-1.5 max-h-[220px] overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin' }}>
            {scenes.map((scene) => {
              const active = !params.customized && params.sceneId === scene.id
              return (
                <button
                  key={scene.id}
                  type="button"
                  onClick={() => handleApplyScene(scene.id)}
                  className="relative rounded-lg px-2.5 py-2 text-left transition-all hover:brightness-110"
                  style={{
                    background: active ? `${theme.accentDim}` : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${active ? theme.accentColor : 'rgba(255,255,255,0.08)'}`,
                  }}
                >
                  <div className={`text-xs font-medium truncate ${active ? '' : theme.textPrimary}`} style={active ? { color: theme.accentColor } : undefined}>
                    {!scene.builtin && '★ '}{scene.name}
                  </div>
                  {!scene.builtin && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDeleteScene(scene.id) }}
                      className="absolute -top-1.5 -right-1.5 p-1 rounded-full bg-black/70 shadow-md"
                    >
                      <Trash2 className="w-3 h-3 text-white/50" />
                    </button>
                  )}
                </button>
              )
            })}
          </div>

          {/* 右：选中场景详情 + 操作 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {(() => {
              const sel = scenes.find((s) => s.id === params.sceneId)
              return (
                <>
                  <div className={`${theme.textPrimary} text-sm font-medium mb-1 truncate`}>
                    {params.customized ? '自定义' : sel ? sel.name : '未选择'}
                    {params.customized && <span className={`${theme.textTertiary} text-[10px] ml-1`}>(已调整)</span>}
                  </div>
                  <div className={`${theme.textSecondary} text-[11px] leading-relaxed mb-3`}>
                    {params.customized ? '当前参数已偏离任一场景快照，可保存为新场景或恢复默认。' : sel?.description ?? '选择左侧场景即可一键应用完整参数快照。'}
                  </div>
                </>
              )
            })()}
            <div className="flex items-center gap-2 mt-auto">
              <input
                value={sceneName}
                onChange={(e) => setSceneName(e.target.value)}
                placeholder="场景名称"
                className="px-3 py-1.5 rounded-lg text-xs outline-none text-white bg-white/5 border border-white/10 w-32"
              />
              <button
                type="button"
                onClick={handleResetAll}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white/60 bg-white/5 border border-white/10 hover:bg-white/10 transition-colors"
              >
                <RotateCcw className="w-3 h-3" /> 恢复默认
              </button>
              <button
                type="button"
                onClick={handleSaveScene}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110"
                style={{ backgroundColor: theme.accentColor }}
              >
                <Save className="w-3 h-3" /> 保存为场景
              </button>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* 效果卡片 */}
      <GlassCard theme={theme}>
        <div className={`${theme.textPrimary} text-sm font-medium mb-3`}>音效（可叠加，点卡片配置）</div>
        <div className="grid grid-cols-5 gap-2.5">
          {GRID_KEYS.map(renderEffectCard)}
        </div>
      </GlassCard>

      {/* 响度相关 */}
      <div className={`${theme.textPrimary} text-sm font-medium flex items-center gap-2 mb-2`}>
        <Volume2 className="w-4 h-4" style={{ color: theme.accentColor }} /> 响度相关
      </div>
      {ROW_KEYS.map(renderRowCard)}
    </div>
  )
}
