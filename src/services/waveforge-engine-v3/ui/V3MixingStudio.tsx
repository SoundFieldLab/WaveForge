/**
 * WaveForge v3 调音室 —— HyperSoundEngine 风格新 UI
 *
 * 布局：左侧导航 + 主内容区 + 底部状态栏
 * 9 个页面：主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于
 */

import { useState, useSyncExternalStore } from 'react'
import { motion } from 'framer-motion'
import {
  Home, Sparkles, SlidersHorizontal, AudioLines, Activity,
  BarChart3, Settings, Info, X, Save, RotateCcw, Headphones, AudioWaveform,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { useHSETheme, toLegacyTheme } from './hse-theme'
import type { HSETheme } from './hse-theme'
import { HiResBadge, DtsXBadge, DolbyAtmosBadge } from './components/Badges'
import { RangeStyle } from './components/Primitives'
import { ContentViewport } from './components/ContentViewport'
import './hse-glass.css'

// 复用现有 v3 UI 的桥接与参数管理
import type { V3UiBridge } from './bridge'
import { useV3Params } from './hooks'
import type { PlaybackTimeStore } from '../../../audio/playbackTimeStore'
import { createDefaultParams } from '../src/types'

// 效果配置弹窗（复用既有 modals，主题经 toLegacyTheme 适配）
import { SpatialModal } from './modalsSpatial'
import { DynamicsModal } from './modalsDynamics'
import { LoudnessModal } from './modalsLoudness'
import type { EffectUiKey } from './effectsPanel'

/* ───── 各页面 ───── */
import HomePage from './pages/HomePage'
import ScenesPage from './pages/ScenesPage'
import EqPage from './pages/EqPage'
import SpatialPage from './pages/SpatialPage'
import SpatialAudioPage from './pages/SpatialAudioPage'
import DynamicsPage from './pages/DynamicsPage'
import AnalysisPage from './pages/AnalysisPage'
import TunerPage from './pages/TunerPage'
import AboutPage from './pages/AboutPage'

export interface V3MixingStudioProps {
  bridge: V3UiBridge
  onClose: () => void
  playerTheme: 'dark' | 'light'
  anchorRect?: { x: number; y: number; width: number; height: number } | null
  engineVersion?: string
  onSwitchEngine?: (version: string) => void
  availableEngines?: Array<{ id: string; displayName: string; description: string }>
  exportMp3?: (() => Promise<void>) | null
  exporting?: boolean
  /** 播放时钟 store（可选）：经适配层由 App 注入，供空间音效「随曲目播放」使用；缺省 = 独立运行 */
  playbackTimeStore?: PlaybackTimeStore
}

type PageKey =
  | 'home' | 'scenes' | 'eq'
  | 'spatial' | 'spatial-audio'
  | 'dynamics' | 'analysis' | 'tuner' | 'about'

interface NavItem {
  key: PageKey
  label: string
  icon: LucideIcon
}

const NAV_ITEMS: NavItem[] = [
  { key: 'home', label: '主页', icon: Home },
  { key: 'scenes', label: '音效场景', icon: Sparkles },
  { key: 'eq', label: '均衡器', icon: SlidersHorizontal },
  { key: 'spatial', label: '空间音效', icon: AudioLines },
  { key: 'spatial-audio', label: '空间音频', icon: Headphones },
  { key: 'dynamics', label: '动态调音', icon: Activity },
  { key: 'analysis', label: '分析', icon: BarChart3 },
  { key: 'tuner', label: '调音器', icon: Settings },
  { key: 'about', label: '关于', icon: Info },
]

const subscribeToNothing = () => () => undefined
const idlePlayback = () => false
const sessionSaveState = () => 'session' as const

/** 播放时钟只在播放/暂停变化时更新此小区域，连续进度不刷新调音室。 */
function PlaybackStatus({ store }: { store?: PlaybackTimeStore }) {
  const playing = useSyncExternalStore(store?.subscribe ?? subscribeToNothing,
    store ? () => store.getSnapshot().isPlaying : idlePlayback, idlePlayback)
  return <>
    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: playing ? '#16845D' : '#9AA9A4' }} />
    <span className="shrink-0 font-medium">HSE</span>
    <span className="hidden text-[#536B66] sm:inline">{playing ? '播放中' : '待机'}</span>
  </>
}

function SaveSettings({ bridge, accent }: { bridge: V3UiBridge; accent: string }) {
  const state = useSyncExternalStore(bridge.subscribeSaveState ?? subscribeToNothing,
    bridge.getSaveState ?? sessionSaveState, sessionSaveState)
  const label = state === 'saved' ? '设置已保存' : state === 'pending' ? '未保存 · 自动保存中' : state === 'error' ? '保存失败，请重试' : '仅当前会话'
  const save = () => {
    const ok = bridge.saveNow?.()
    window.dispatchEvent(new CustomEvent('showToast', { detail: {
      message: ok ? 'HSE 设置已保存' : '设置保存失败，请重试；当前试听参数仍然有效', type: ok ? 'info' : 'error',
    } }))
  }
  return <>
    <span role="status" className="max-w-40 text-xs" style={{ color: state === 'error' ? '#A63D27' : '#536B66' }}>{label}</span>
    {bridge.saveNow && <button type="button" onClick={save} className="hse-glass-button hse-glass-primary flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium text-white transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ outlineColor: accent }}>
      <Save aria-hidden="true" className="h-3.5 w-3.5" /> 保存设置
    </button>}
  </>
}

const PANEL_IN = `
@keyframes hse-panel-in {
  from { opacity: 0; transform: translate(var(--fx,0px), var(--fy,0px)) scale(0.92); }
  to { opacity: 1; transform: translate(0,0) scale(1); }
}
@keyframes hse-fade-up {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
`

export default function V3MixingStudio({
  bridge, onClose, playerTheme, anchorRect,
  engineVersion = 'v3', onSwitchEngine, availableEngines,
  exportMp3 = null, exporting = false, playbackTimeStore,
}: V3MixingStudioProps) {
  const theme = useHSETheme()
  const controller = useV3Params(bridge)
  const [activePage, setActivePage] = useState<PageKey>('home')
  const [effectModal, setEffectModal] = useState<string | null>(null)

  const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 0
  const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 0
  const fx = anchorRect ? anchorRect.x - cx : 0
  const fy = anchorRect ? anchorRect.y - cy : 0

  const scenes = bridge.getScenes()
  const activeSceneName = controller.params.customized
    ? '自定义'
    : (controller.params.sceneId ? scenes.find((s) => s.id === controller.params.sceneId)?.name ?? '无' : '无')

  const handleResetAll = () => {
    controller.replace(createDefaultParams(bridge.getSampleRate()))
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复默认（原声监听）', type: 'info' } }))
  }


  /** onNavigate：外部页（如主页快捷卡）跳转到指定页（空间音效现为顶级选项卡，直接切页） */
  const handleNavigate = (page: string): void => {
    setActivePage(page as PageKey)
  }

  const commonProps = { bridge, controller, theme, onOpenEffect: setEffectModal, onNavigate: handleNavigate, playbackTimeStore }

  const closeModal = () => setEffectModal(null)
  const legacyTheme = toLegacyTheme(theme)

  return (
    <>
      <style>{PANEL_IN}</style>
      <RangeStyle theme={theme} />
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-5"
        style={{ backgroundColor: 'rgba(21,58,55,0.24)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
        onClick={onClose}
      >
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="HyperSoundEngine 调音室"
          onClick={(e) => e.stopPropagation()}
          className="grid h-[min(920px,94vh)] min-h-0 w-full max-w-[1360px] overflow-hidden rounded-[22px]"
          style={{
            gridTemplateColumns: '176px minmax(0,1fr)',
            gridTemplateRows: '68px minmax(0,1fr) 64px',
            background: theme.panelBg,
            border: `1px solid ${theme.panelBorder}`,
            boxShadow: '0 20px 60px rgba(21,58,55,0.16)',
            color: '#153A37',
          }}
          initial={{ opacity: 0, scale: 0.96, x: fx * 0.12, y: fy * 0.12 }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 30 }}
        >
          <header
            className="col-span-2 flex min-w-0 items-center justify-between gap-4 px-5"
            style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: '#FBFDFC' }}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <AudioWaveform aria-hidden="true" className="h-5 w-5 shrink-0" style={{ color: theme.accentColor }} />
              <span className="truncate text-sm font-semibold">HyperSoundEngine</span>
              <span className="rounded-md px-2 py-1 text-[10px] font-semibold" style={{ color: theme.accentColor, background: theme.accentDim }}>HSE</span>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              {onSwitchEngine && (
                <div role="group" aria-label="切换音效引擎" className="hse-glass-group flex shrink-0 items-center gap-1 rounded-xl p-1">
                  {(availableEngines || [{ id: 'v1', displayName: 'v1', description: '' }, { id: 'v2', displayName: 'v2', description: '' }, { id: 'v3', displayName: 'HSE', description: 'HyperSoundEngine' }]).map((eng) => {
                    const active = engineVersion === eng.id
                    return <button key={eng.id} type="button" onClick={() => onSwitchEngine(eng.id)} title={eng.description}
                      aria-pressed={active}
                      className="hse-glass-choice min-h-8 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                      style={{ color: active ? theme.accentColor : '#536B66', outlineColor: theme.accentColor }}>
                      {eng.displayName}
                    </button>
                  })}
                </div>
              )}
              <div className="hidden items-center gap-3 rounded-lg px-2 py-1 sm:flex" style={{ background: '#F5F9F7' }}>
                <HiResBadge />
                <DtsXBadge />
                <DolbyAtmosBadge />
              </div>
              <button type="button" onClick={onClose} aria-label="关闭调音室" title="关闭调音室"
                className="hse-glass-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[#EEF6F3] focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: '#536B66', outlineColor: theme.accentColor }}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <nav aria-label="调音室页面" className="flex min-h-0 flex-col overflow-y-auto px-2.5 py-4" style={{ background: theme.navBg, borderRight: `1px solid ${theme.panelBorder}` }}>
            <div className="mb-2 px-2 text-[10px] font-semibold uppercase" style={{ color: '#758983' }}>工作区</div>
            <div className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const active = activePage === item.key
                const Icon = item.icon
                return <button key={item.key} type="button" onClick={() => setActivePage(item.key)} aria-current={active ? 'page' : undefined}
                  className="hse-glass-choice flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs transition-colors hover:bg-[#EEF6F3] focus-visible:outline-2 focus-visible:outline-offset-1"
                  style={{ color: active ? theme.accentColor : '#536B66', outlineColor: theme.accentColor }}>
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className={active ? 'font-semibold' : ''}>{item.label}</span>
                </button>
              })}
            </div>
            <div className="mt-auto border-t px-2 pt-4" style={{ borderColor: theme.panelBorder }}>
              <div className="text-[10px]" style={{ color: '#758983' }}>当前场景</div>
              <div className="mt-1 truncate text-xs font-medium" style={{ color: theme.accentColor }}>{activeSceneName}</div>
            </div>
          </nav>

          <ContentViewport pageKey={activePage}>
            <motion.div key={activePage} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
              {activePage === 'home' && <HomePage {...commonProps} />}
              {activePage === 'scenes' && <ScenesPage {...commonProps} />}
              {activePage === 'eq' && <EqPage {...commonProps} />}
              {activePage === 'spatial' && <SpatialPage {...commonProps} />}
              {activePage === 'spatial-audio' && <SpatialAudioPage {...commonProps} />}
              {activePage === 'dynamics' && <DynamicsPage {...commonProps} />}
              {activePage === 'analysis' && <AnalysisPage {...commonProps} />}
              {activePage === 'tuner' && <TunerPage {...commonProps} exportMp3={exportMp3} exporting={exporting} />}
              {activePage === 'about' && <AboutPage theme={theme} />}
            </motion.div>
          </ContentViewport>

          <footer className="col-span-2 flex min-w-0 items-center justify-between gap-4 border-t px-4" style={{ borderColor: theme.panelBorder, background: '#F8FBF9' }}>
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <PlaybackStatus store={playbackTimeStore} />
              <span className="hidden text-[#758983] sm:inline">{bridge.getSampleRate().toLocaleString()} Hz</span>
              <span className="truncate text-[#536B66]">场景：{activeSceneName}</span>
            </div>
            <div className="flex shrink-0 items-center gap-4">
              <button type="button" onClick={handleResetAll} title="恢复 HSE 默认参数" className="hse-glass-button flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-[#EEF6F3] focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: '#536B66', outlineColor: theme.accentColor }}>
                <RotateCcw className="h-3.5 w-3.5" /> 重置
              </button>
              <SaveSettings bridge={bridge} accent={theme.accentColor} />
            </div>
          </footer>
        </motion.div>
      </div>

      {/* 效果配置弹窗（由 onOpenEffect 触发，复用既有 modals） */}
      {effectModal && (() => {
        const key = effectModal as EffectUiKey
        if (key === 'reverb' || key === 'surround3d' || key === 'bassEnhancer') {
          return <SpatialModal effectKey={key} key={key} controller={controller} theme={legacyTheme} onClose={closeModal} />
        }
        if (key === 'loudnessCompensation' || key === 'loudnessNormalization') {
          return <LoudnessModal effectKey={key} key={key} controller={controller} theme={legacyTheme} onClose={closeModal} />
        }
        return <DynamicsModal effectKey={key} key={key} controller={controller} theme={legacyTheme} onClose={closeModal} />
      })()}
    </>
  )
}
