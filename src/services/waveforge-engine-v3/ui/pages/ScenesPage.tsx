/**
 * 音效场景页 —— 场景预设 + 效果卡片
 */

import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Sparkles, Save, RotateCcw, Trash2, Volume2, PencilRuler, FileDown, FileUp, FileCode2, ChevronRight } from 'lucide-react'
import { GlassCard, Toggle, RangeStyle } from '../components/Primitives'
import DevSceneEditor from '../components/DevSceneEditor'
import type { HSETheme } from '../hse-theme'
import { MAX_MY_SCENES, type V3UiBridge } from '../bridge'
import { isDevMode, HSE_DEV_MODE_EVENT } from '../sceneStore'
import type { V3ParamsController } from '../hooks'
import {
  EFFECT_META, effectEnabled, patchEffectEnabled,
} from '../effectsPanel'
import type { EffectUiKey } from '../effectsPanel'
import type { ScenePreset } from '../../src/types'
import { createDefaultParams } from '../../src/types'
import SceneSummary from '../components/SceneSummary'

interface ScenesPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
}

const GRID_KEYS: EffectUiKey[] = ['reverb', 'surround3d', 'crossfeed', 'bassEnhancer', 'compressor', 'dynamicEq', 'nightMode', 'deesser', 'ieq', 'limiter', 'pitch', 'stereoWidth']
const ROW_KEYS: EffectUiKey[] = ['loudnessCompensation', 'loudnessNormalization']

export default function ScenesPage({ bridge, controller, theme, onOpenEffect }: ScenesPageProps) {
  const { params, patch, replace } = controller
  const [sceneName, setSceneName] = useState('')
  const [scenes, setScenes] = useState(() => bridge.getScenes())
  // 开发者模式：内置场景微调编辑（场景数据由引擎 sceneStore 持久化）
  const [devMode, setDevMode] = useState(isDevMode)
  const [editingId, setEditingId] = useState<string | null>(null)
  const importFileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const sync = () => setDevMode(isDevMode())
    window.addEventListener(HSE_DEV_MODE_EVENT, sync)
    return () => window.removeEventListener(HSE_DEV_MODE_EVENT, sync)
  }, [])

  const refreshScenes = () => setScenes(bridge.getScenes())

  const handleApplyScene = (id: string) => {
    bridge.applyScene(id)
    replace(bridge.getParams())
    refreshScenes()
  }

  const openSceneEditor = (scene: ScenePreset) => {
    handleApplyScene(scene.id) // 先应用，保证试听上下文一致
    setEditingId(scene.id)
  }

  const handleSaveScene = () => {
    try {
      const name = sceneName.trim() || `我的场景 ${bridge.getScenes().filter((s) => !s.builtin).length + 1}`
      if (bridge.saveMyScene(name)) {
        refreshScenes()
        setSceneName('')
        notify(`已保存场景「${name}」`)
      } else {
        notify(`已达 ${MAX_MY_SCENES} 个上限，请先删除旧场景`, 'error')
      }
    } catch {
      notify('场景保存失败，无法写入本地存储。请检查存储空间后重试。', 'error')
    }
  }

  const handleDeleteScene = (id: string) => {
    try {
      bridge.deleteMyScene(id)
      refreshScenes()
    } catch {
      notify('场景删除失败，无法写入本地存储。请检查存储空间后重试。', 'error')
    }
  }

  // —— 开发者模式工具（场景库备份 / 导入）——
  const notify = (message: string, type: 'info' | 'error' = 'info') =>
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))

  const handleExportLibrary = () => {
    try {
      const json = bridge.exportSceneLibrary()
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `hse-scene-library-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      notify('场景库已导出（内置微调 + 我的场景）')
    } catch {
      notify('导出失败', 'error')
    }
  }

  // 「写回仓库」路径：优先经 Electron 直接写回仓库源文件（开发模式）；失败则退化为手动下载替换
  const handleExportPublishSeed = async () => {
    try {
      const ts = bridge.exportPublishSeed()
      const host = window as unknown as {
        electron?: { writeHseSceneSeed?: (content: string) => Promise<{ ok: boolean; path?: string; error?: string }> }
      }
      const res = await host.electron?.writeHseSceneSeed?.(ts)?.catch(() => null)
      if (res?.ok) {
        notify(`已自动写回 ${res.path ?? 'builtinSceneSeed.ts'} —— 重启 dev 使其编译生效，之后 commit/push 即全员同步`)
        return
      }
      const blob = new Blob([ts], { type: 'text/x-typescript' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'builtinSceneSeed.ts'
      a.click()
      URL.revokeObjectURL(url)
      notify(res?.error ? `自动写回失败（${res.error}），已改为下载 —— 请手动替换 src/services/waveforge-engine-v3/src/engine/builtinSceneSeed.ts 并提交` : '当前环境不支持直接写盘，已改为下载 —— 请手动替换 src/services/waveforge-engine-v3/src/engine/builtinSceneSeed.ts 并提交', 'info')
    } catch {
      notify('导出发布种子失败', 'error')
    }
  }

  const handleImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const counts = bridge.importSceneLibrary(text)
      refreshScenes()
      notify(`已导入：内置微调 ${counts.overrides} 个、我的场景 ${counts.myScenes} 个`)
    } catch (err) {
      notify(`导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
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
      <article
        key={key}
        aria-label={`${meta.name}音效`}
        className="relative flex min-w-0 flex-col gap-3 rounded-2xl p-3.5 transition-colors"
        style={{
          background: theme.cardBg,
          border: `1px solid ${theme.cardBorder}`,
        }}
      >
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: theme.panelBg }}>
            <Icon className="h-[18px] w-[18px]" style={{ color: theme.accentColor }} />
          </div>
          <div className="min-w-0">
            <div className={`text-sm font-medium leading-tight ${theme.textPrimary}`}>{meta.name}</div>
            <div className={`mt-1 text-xs leading-relaxed ${theme.textSecondary}`}>{meta.desc}</div>
          </div>
        </div>
        <div className="mt-auto grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => patchEffectEnabled(patch, params, key, !enabled)}
            aria-label={`${meta.name}启停`}
            aria-pressed={enabled}
            className={`hse-glass-button ${enabled ? 'hse-glass-choice' : theme.textSecondary} relative min-h-9 rounded-lg px-2 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2`}
          >
            {enabled ? '已启用' : '未启用'}
          </button>
          <button type="button" onClick={() => onOpenEffect(key)} className={`hse-glass-button flex min-h-9 items-center justify-center gap-1 rounded-lg px-2 text-xs focus-visible:outline-2 ${theme.textSecondary}`} aria-label={`配置${meta.name}`}>
            配置参数 <ChevronRight className="h-3 w-3 shrink-0" />
          </button>
        </div>
      </article>
    )
  }

  const renderRowCard = (key: EffectUiKey) => {
    const meta = EFFECT_META[key]
    const enabled = effectEnabled(params, key)
    const Icon = meta.icon
    return (
      <GlassCard key={key} theme={theme}>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Icon className="w-4 h-4" style={{ color: theme.accentColor }} />
            <div>
              <div className={`${theme.textPrimary} text-sm font-medium`}>{meta.name}</div>
              <div className={`${theme.textSecondary} text-xs leading-relaxed mt-1`}>{meta.desc}</div>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0 ml-auto">
            <Toggle label={`启用${meta.name}`} checked={enabled} onChange={(v) => patchEffectEnabled(patch, params, key, v)} theme={theme} />
            <button
              type="button"
              onClick={() => onOpenEffect(key)}
              aria-label={`配置${meta.name}`}
              className={`hse-glass-button px-3 py-2 rounded-lg text-xs focus-visible:outline-2 ${theme.textSecondary}`}
            >
              配置
            </button>
          </div>
        </div>
      </GlassCard>
    )
  }

  return (
    <div className="@container space-y-6">
      <RangeStyle theme={theme} />

      {/* 场景方案 */}
      <GlassCard theme={theme}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>场景方案</span>
          </div>
          <span className="text-xs" style={{ color: theme.accentColor }}>当前：{activeSceneName}{params.customized ? '（已调整）' : ''}</span>
        </div>

        {/* 开发者模式工具条 */}
        {devMode && (
          <div className="flex flex-wrap items-center gap-2 mb-3 px-2.5 py-1.5 rounded-lg" style={{ background: `${theme.accentColor}14`, border: `1px solid ${theme.accentColor}33` }}>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ color: theme.accentColor, border: `1px solid ${theme.accentColor}55` }}>开发者模式</span>
            <button
              type="button"
              onClick={() => {
                const sel = scenes.find((s) => s.id === params.sceneId)
                if (sel?.builtin) openSceneEditor(sel)
                else notify('请先在左侧选择一个内置场景')
              }}
              className={`hse-glass-button flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] focus-visible:outline-2 ${theme.textPrimary}`}
            >
              <PencilRuler className="w-3 h-3" /> 编辑当前场景
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={handleExportLibrary}
              className={`hse-glass-button flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] focus-visible:outline-2 ${theme.textSecondary}`}
            >
              <FileDown className="w-3 h-3" /> 导出场景库
            </button>
            <button
              type="button"
              onClick={() => { void handleExportPublishSeed() }}
              title="把微调自动写回仓库默认值（dev 模式），随版本分发给所有用户"
              className={`hse-glass-button flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] focus-visible:outline-2 ${theme.textSecondary}`}
            >
              <FileCode2 className="w-3 h-3" /> 写回发布种子
            </button>
            <button
              type="button"
              onClick={() => importFileRef.current?.click()}
              className={`hse-glass-button flex items-center gap-1 px-2 py-1.5 rounded-md text-[11px] focus-visible:outline-2 ${theme.textSecondary}`}
            >
              <FileUp className="w-3 h-3" /> 导入场景库
            </button>
            <input ref={importFileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { void handleImportFile(e) }} />
          </div>
        )}

        <div className="grid items-start gap-6 @min-[820px]:grid-cols-[minmax(280px,0.95fr)_minmax(0,1.25fr)]">
          <div>
          <div className={`${theme.textSecondary} text-xs mb-3`}>全部场景 · {scenes.length}</div>
          <div className="grid grid-cols-2 @min-[560px]:grid-cols-3 @min-[820px]:grid-cols-2 gap-2" role="group" aria-label="场景列表">
            {scenes.map((scene) => {
              const active = !params.customized && params.sceneId === scene.id
              return (
                <div key={scene.id} className="relative min-w-0 flex items-center gap-1">
                  <button type="button" aria-pressed={active} onClick={() => handleApplyScene(scene.id)}
                    data-active={active}
                    className={`${active ? 'hse-glass-choice' : 'hse-glass-button'} min-w-0 min-h-12 flex-1 rounded-xl px-3 py-3 text-left text-xs focus-visible:outline focus-visible:outline-2`}>
                    <span className={`block truncate font-medium ${active ? '' : theme.textPrimary}`}>{!scene.builtin && '★ '}{scene.name}</span>
                    {scene.builtin && scene.overridden && <span className="block text-[10px] mt-0.5" style={{ color: theme.accentColor }}>本地微调</span>}
                  </button>
                  {!scene.builtin && <button type="button" onClick={() => handleDeleteScene(scene.id)} title={`删除场景「${scene.name}」`} aria-label={`删除场景「${scene.name}」`} className={`hse-glass-button p-2 rounded-lg ${theme.textTertiary} hover:text-red-600 focus-visible:outline focus-visible:outline-2`}><Trash2 className="w-4 h-4" /></button>}
                  {scene.builtin && devMode && <button type="button" onClick={() => openSceneEditor(scene)} title={`微调场景「${scene.name}」`} aria-label={`微调场景「${scene.name}」`} className="hse-glass-button p-2 rounded-lg focus-visible:outline focus-visible:outline-2" style={{ color: theme.accentColor }}><PencilRuler className="w-4 h-4" /></button>}
                </div>
              )
            })}
          </div>
          </div>

          <div className="min-w-0 flex flex-col gap-4">
            <SceneSummary scene={scenes.find((s) => s.id === params.sceneId)} params={params} theme={theme} />
            <div className="flex flex-wrap items-end gap-3 pt-3" style={{ borderTop: `1px solid ${theme.cardBorder}` }}>
              <label className="flex min-w-[180px] flex-1 flex-col gap-1.5 text-xs">
                <span className={theme.textSecondary}>场景名称</span>
                <input value={sceneName} onChange={(e) => setSceneName(e.target.value)} placeholder={`我的场景 ${scenes.filter((s) => !s.builtin).length + 1}`}
                  className={`hse-glass-input w-full rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2 ${theme.textPrimary}`} />
              </label>
              <button type="button" onClick={handleSaveScene} className="hse-glass-button hse-glass-primary flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2">
                <Save className="w-4 h-4" /> 保存为场景
              </button>
              <button type="button" onClick={handleResetAll} className={`hse-glass-button flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${theme.textSecondary}`}>
                <RotateCcw className="w-4 h-4" /> 恢复默认
              </button>
            </div>
          </div>
        </div>
      </GlassCard>

      {/* 效果卡片 */}
      <GlassCard theme={theme}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
          <h3 className={`${theme.textPrimary} text-sm font-medium`}>叠加音效</h3>
          <span className={`${theme.textSecondary} text-xs`}>独立启停，配置参数随时可调</span>
        </div>
        <div className="grid gap-3 @min-[34rem]:grid-cols-2 @min-[58rem]:grid-cols-3">
          {GRID_KEYS.map(renderEffectCard)}
        </div>
      </GlassCard>

      {/* 响度相关 */}
      <section className="space-y-4" aria-label="响度相关音效">
      <h3 className={`${theme.textPrimary} text-sm font-medium flex items-center gap-2`}>
        <Volume2 className="w-4 h-4" style={{ color: theme.accentColor }} /> 响度相关
      </h3>
      <div className="grid items-start gap-4 @min-[900px]:grid-cols-2">{ROW_KEYS.map(renderRowCard)}</div>
      </section>

      {/* 开发者模式：内置场景微调编辑器 */}
      {editingId && (() => {
        const editingScene = scenes.find((s) => s.id === editingId && s.builtin)
        return editingScene ? (
          <DevSceneEditor
            key={editingScene.id}
            scene={editingScene}
            theme={theme}
            bridge={bridge}
            controller={controller}
            onClose={() => setEditingId(null)}
            onSaved={refreshScenes}
          />
        ) : null
      })()}
    </div>
  )
}
