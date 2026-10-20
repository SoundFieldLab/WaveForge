/**
 * WaveForge v3 调音室 —— HyperSoundEngine 风格新 UI
 *
 * 布局：左侧导航 + 主内容区 + 底部状态栏
 * 9 个页面：主页 / 音效场景 / 均衡器 / 空间音效 / 空间音频 / 动态调音 / 分析 / 调音器 / 关于
 */

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  Home, Sparkles, SlidersHorizontal, AudioLines, Activity,
  BarChart3, Settings, Info, X, Save, RotateCcw, Headphones, AudioWaveform,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { useHSETheme, toLegacyTheme, themeVariables } from './hse-theme'
import type { HSETheme } from './hse-theme'
import { RangeStyle } from './components/Primitives'
import { OutputStatus } from './components/OutputStatus'
import { useStateFeedback } from './feedback'
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
  exportWav?: (() => Promise<void>) | null
  exporting?: boolean
  /** 独立试听宿主提供的传输控件。 */
  transportControls?: ReactNode
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
const sessionSaveState = () => 'session' as const

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
    <span role="status" className="max-w-40 text-xs" style={{ color: state === 'error' ? '#a6362a' : '#536b66' }}>{label}</span>
    {bridge.saveNow && <button type="button" onClick={save} className="hse-glass-button hse-glass-primary flex h-9 items-center gap-1.5 rounded-lg px-3.5 text-xs font-medium transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ outlineColor: accent }}>
      <Save aria-hidden="true" className="h-3.5 w-3.5" /> 保存设置
    </button>}
  </>
}



export default function V3MixingStudio({
  bridge, onClose,
  engineVersion = 'v3', onSwitchEngine, availableEngines,
  exportMp3 = null, exportWav = null, exporting = false, playbackTimeStore, transportControls,
}: V3MixingStudioProps) {
  const theme = useHSETheme()
  const controller = useV3Params(bridge)
  const shellRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<HTMLDivElement>(null)
  useStateFeedback(controller.params.sceneId, sceneRef)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    shellRef.current?.focus()
    return () => { document.body.style.overflow = overflow; previous?.focus() }
  }, [])
  const [activePage, setActivePage] = useState<PageKey>('home')
  const [effectModal, setEffectModal] = useState<string | null>(null)


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

      <RangeStyle theme={theme} />
      <div
        className="hse-ui fixed inset-0 z-[70] flex items-center justify-center p-3 sm:p-5"
        style={{ ...themeVariables(theme), backgroundColor: 'rgba(21,58,55,0.24)', backdropFilter: 'blur(5px)', WebkitBackdropFilter: 'blur(5px)' }}
        onClick={onClose}
      >
        <div
          ref={shellRef}
          tabIndex={-1}
          onKeyDown={(event) => {
            if (effectModal || document.querySelector('.hse-floating-layer')) return
            if (event.key === 'Escape') { event.stopPropagation(); onClose(); return }
            if (event.key !== 'Tab') return
            const controls = Array.from(shellRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
              .filter(control => control.getClientRects().length > 0)
            const first = controls[0], last = controls[controls.length - 1]
            if (event.shiftKey && (document.activeElement === first || document.activeElement === shellRef.current)) { event.preventDefault(); last?.focus() }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === shellRef.current)) { event.preventDefault(); first?.focus() }
          }}
          role="dialog"
          aria-modal="true"
          aria-label="HyperSoundEngine 调音室"
          onClick={(e) => e.stopPropagation()}
          className="hse-studio-shell grid h-[min(920px,94dvh)] min-h-0 w-full max-w-[1360px] overflow-hidden rounded-[22px]"
          style={{
            background: theme.panelBg,
            border: `1px solid ${theme.panelBorder}`,
            boxShadow: '0 20px 60px rgba(21,58,55,0.16)',
            color: '#153a37',
          }}
        >
          <header
            className="col-span-2 flex min-w-0 items-center justify-between gap-4 px-5"
            style={{ borderBottom: `1px solid ${theme.panelBorder}`, background: '#fbfdfc' }}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <AudioWaveform aria-hidden="true" className="h-5 w-5 shrink-0" style={{ color: theme.accentColor }} />
              <span className="hse-studio-brand truncate text-sm font-semibold">HyperSoundEngine</span>
              <span className="shrink-0 rounded-md px-2 py-1 text-[10px] font-semibold" style={{ color: theme.accentColor, background: theme.accentDim }}>HSE 3.5</span>
            </div>
            <div className="hse-studio-header-actions flex min-w-0 items-center gap-3">
              {transportControls}
              {onSwitchEngine && (
                <div role="group" aria-label="切换音效引擎" className="hse-glass-group flex shrink-0 items-center gap-1 rounded-xl p-1">
                  {(availableEngines || [{ id: 'v1', displayName: 'v1', description: '' }, { id: 'v2', displayName: 'v2', description: '' }, { id: 'v3', displayName: 'HSE', description: 'HSE 3.5' }]).map((eng) => {
                    const active = engineVersion === eng.id
                    return <button key={eng.id} type="button" onClick={() => onSwitchEngine(eng.id)} title={eng.description}
                      aria-pressed={active}
                      className="hse-glass-choice min-h-8 rounded-lg px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
                      style={{ color: active ? theme.accentColor : '#536b66', outlineColor: theme.accentColor }}>
                      {eng.displayName}
                    </button>
                  })}
                </div>
              )}
              <span className="hse-mono hidden text-xs text-[#536b66] sm:inline">DSP / 双声道输出</span>
              <button type="button" onClick={onClose} aria-label="关闭调音室" title="关闭调音室"
                className="hse-glass-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[#eef6f3] focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{ color: '#536b66', outlineColor: theme.accentColor }}>
                <X className="h-4 w-4" />
              </button>
            </div>
          </header>

          <nav aria-label="调音室页面" className="hse-nav flex min-h-0 flex-col overflow-y-auto px-2.5 py-4" style={{ background: theme.navBg, borderRight: `1px solid ${theme.panelBorder}` }}>
            <div className="hse-nav-caption mb-3 px-3 text-[11px] font-medium" style={{ color: '#536b66' }}>工作区</div>
            <div className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const active = activePage === item.key
                const Icon = item.icon
                return <button key={item.key} type="button" onClick={() => setActivePage(item.key)} aria-current={active ? 'page' : undefined} aria-label={item.label} title={item.label}
                  className="hse-glass-choice flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-xs transition-colors hover:bg-[#eef6f3] focus-visible:outline-2 focus-visible:outline-offset-1"
                  style={{ color: active ? theme.accentColor : '#536b66', outlineColor: theme.accentColor }}>
                  <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className={`hse-nav-label ${active ? 'font-semibold' : ''}`}>{item.label}</span>
                </button>
              })}
            </div>
            <div ref={sceneRef} className="hse-nav-scene mt-auto border-t px-3 pt-4" style={{ borderColor: theme.panelBorder }}>
              <div className="text-[10px]" style={{ color: '#536b66' }}>当前场景</div>
              <div className="mt-1 truncate text-xs font-medium" style={{ color: theme.accentColor }}>{activeSceneName}</div>
            </div>
          </nav>

          <ContentViewport pageKey={activePage}>
            <div key={activePage}>
              {activePage === 'home' && <HomePage {...commonProps} />}
              {activePage === 'scenes' && <ScenesPage {...commonProps} />}
              {activePage === 'eq' && <EqPage {...commonProps} />}
              {activePage === 'spatial' && <SpatialPage {...commonProps} />}
              {activePage === 'spatial-audio' && <SpatialAudioPage {...commonProps} />}
              {activePage === 'dynamics' && <DynamicsPage {...commonProps} />}
              {activePage === 'analysis' && <AnalysisPage {...commonProps} />}
              {activePage === 'tuner' && <TunerPage {...commonProps} exportMp3={exportMp3} exportWav={exportWav} exporting={exporting} />}
              {activePage === 'about' && <AboutPage theme={theme} />}
            </div>
          </ContentViewport>

          <footer className="hse-studio-footer col-span-2 flex min-w-0 items-center justify-between gap-4 border-t px-4" style={{ borderColor: theme.panelBorder, background: '#F8FBF9' }}>
            <OutputStatus bridge={bridge} gainDb={controller.params.loudnessNormalization.externalGainDb ?? 0} />
            <div className="flex shrink-0 items-center gap-4">
              <button type="button" onClick={handleResetAll} title="恢复 HSE 默认参数" className="hse-glass-button flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors hover:bg-[#eef6f3] focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: '#536b66', outlineColor: theme.accentColor }}>
                <RotateCcw className="h-3.5 w-3.5" /> 重置
              </button>
              <SaveSettings bridge={bridge} accent={theme.accentColor} />
            </div>
          </footer>
        </div>
      </div>

      {/* 效果配置弹窗（由 onOpenEffect 触发，复用既有 modals） */}
      {effectModal && (() => {
        const key = effectModal as EffectUiKey
        if (key === 'reverb' || key === 'surround3d' || key === 'crossfeed' || key === 'bassEnhancer') {
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
