/**
 * WaveForge v3 调音室 —— HyperSoundEngine 风格新 UI
 *
 * 布局：左侧导航 + 主内容区 + 底部状态栏
 * 8 个页面：主页 / 音效场景 / 均衡器 / 空间音效 / 动态调音 / 分析 / 调音器 / 关于
 */

import { useState, useMemo, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Home, Play, Sparkles, SlidersHorizontal, AudioLines, Activity,
  BarChart3, Settings, Info, X, Save, RotateCcw,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { useHSETheme, toLegacyTheme } from './hse-theme'
import type { HSETheme } from './hse-theme'
import { HiResBadge, DtsXBadge, DolbyAtmosBadge } from './components/Badges'
import { RangeStyle } from './components/Primitives'

// 复用现有 v3 UI 的桥接与参数管理
import type { V3UiBridge } from './bridge'
import { useV3Params } from './hooks'
import type { V3ParamsController } from './hooks'
import type { EngineStats } from '../src/types'
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
  exportWav?: (() => Promise<void>) | null
  exporting?: boolean
}

type PageKey = 'home' | 'scenes' | 'eq' | 'spatial' | 'dynamics' | 'analysis' | 'tuner' | 'about'

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
  { key: 'dynamics', label: '动态调音', icon: Activity },
  { key: 'analysis', label: '分析', icon: BarChart3 },
  { key: 'tuner', label: '调音器', icon: Settings },
  { key: 'about', label: '关于', icon: Info },
]

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
  exportWav = null, exporting = false,
}: V3MixingStudioProps) {
  const theme = useHSETheme()
  const controller = useV3Params(bridge)
  const [activePage, setActivePage] = useState<PageKey>('home')
  const [effectModal, setEffectModal] = useState<string | null>(null)
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())
  const statsTimerRef = useRef<number | null>(null)

  // 底部状态栏实时读数（300ms 轮询）
  useEffect(() => {
    const tick = () => setStats(bridge.getStats())
    tick()
    statsTimerRef.current = window.setInterval(tick, 300)
    return () => { if (statsTimerRef.current !== null) window.clearInterval(statsTimerRef.current) }
  }, [bridge])

  const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 0
  const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 0
  const fx = anchorRect ? anchorRect.x - cx : 0
  const fy = anchorRect ? anchorRect.y - cy : 0

  const scenes = useMemo(() => bridge.getScenes(), [bridge])
  const activeSceneName = controller.params.customized
    ? '自定义'
    : (controller.params.sceneId ? scenes.find((s) => s.id === controller.params.sceneId)?.name ?? '无' : '无')

  const handleResetAll = () => {
    controller.replace(createDefaultParams(bridge.getSampleRate()))
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复默认（原声监听）', type: 'info' } }))
  }

  const handleSaveScene = () => {
    const name = `我的场景 ${bridge.getScenes().filter((s) => !s.builtin).length + 1}`
    if (bridge.saveMyScene(name)) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已保存场景「${name}」`, type: 'info' } }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '我的场景已达上限（8 个）', type: 'error' } }))
    }
  }

  const commonProps = { bridge, controller, theme, onOpenEffect: setEffectModal, onNavigate: (page: string) => setActivePage(page as PageKey) }

  const closeModal = () => setEffectModal(null)
  const legacyTheme = toLegacyTheme(theme)

  return (
    <>
      <style>{PANEL_IN}</style>
      <RangeStyle theme={theme} />
      {/* 遮罩 */}
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-3"
        style={{
          backgroundColor: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(8px) saturate(140%)',
          WebkitBackdropFilter: 'blur(8px) saturate(140%)',
          animation: 'hse-panel-in 0.2s ease-out',
        }}
        onClick={onClose}
      >
        {/* 主面板（framer-motion 入场：锚点滑入 + 弹性缩放） */}
        <motion.div
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-[1100px] max-h-[92vh] flex overflow-hidden rounded-2xl shadow-2xl"
          style={{
            background: 'rgba(16, 16, 19, 0.72)',
            backdropFilter: 'blur(24px) saturate(150%)',
            WebkitBackdropFilter: 'blur(24px) saturate(150%)',
            border: '1px solid rgba(255,255,255,0.10)',
            boxShadow: '0 32px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
          initial={{ opacity: 0, scale: 0.9, x: fx, y: fy }}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        >
          {/* 微弱噪点叠加层（深炭灰质感，减少死黑感） */}
          <div className="pointer-events-none absolute inset-0 z-[1] rounded-2xl" style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
            opacity: 0.035,
            mixBlendMode: 'overlay',
          }} />
          {/* 左侧导航栏 */}
          <nav className="w-[150px] shrink-0 flex flex-col" style={{ background: theme.navBg, borderRight: `1px solid ${theme.panelBorder}` }}>
            {/* 品牌 */}
            <div className="px-4 pt-5 pb-4" style={{ borderBottom: `1px solid ${theme.panelBorder}` }}>
              <div className="text-sm font-bold text-white tracking-wide">HyperSoundEngine</div>
            </div>

            {/* 导航项 */}
            <div className="flex-1 py-3 space-y-0.5 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const active = activePage === item.key
                const Icon = item.icon
                return (
                  <motion.button
                    key={item.key}
                    type="button"
                    whileHover={{ x: 3 }}
                    whileTap={{ scale: 0.97 }}
                    transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    onClick={() => setActivePage(item.key)}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-xs transition-colors"
                    style={{
                      background: active ? theme.navActiveBg : 'transparent',
                      borderLeft: active ? `2px solid ${theme.accentColor}` : '2px solid transparent',
                      color: active ? '#fff' : 'rgba(255,255,255,0.55)',
                    }}
                  >
                    <Icon className="w-4 h-4" style={{ color: active ? theme.accentColor : 'rgba(255,255,255,0.45)' }} />
                    <span className={active ? 'font-medium' : ''}>{item.label}</span>
                  </motion.button>
                )
              })}
            </div>

            {/* 底部播放器控制 */}
            <div className="px-3 py-3" style={{ borderTop: `1px solid ${theme.panelBorder}` }}>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: `${theme.accentColor}22` }}>
                  <Play className="w-3.5 h-3.5" style={{ color: theme.accentColor }} />
                </div>
                <div className="overflow-hidden">
                  <div className="text-[10px] text-white/80 truncate">正在播放</div>
                  <div className="text-[10px] text-white/40 truncate">{activeSceneName}</div>
                </div>
              </div>
            </div>
          </nav>

          {/* 右侧主内容 */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* 顶部标题栏 */}
            <header
              className="flex items-center justify-between px-5 py-3 shrink-0"
              style={{ borderBottom: `1px solid ${theme.panelBorder}` }}
            >
              <div className="flex items-center gap-4">
                <span className="text-sm font-semibold text-white">调音室</span>
                {/* 引擎切换（displayName 由适配层注册表提供：v1 / v2 / HSE） */}
                {onSwitchEngine && (
                  <div className="flex items-center rounded-full px-1 py-0.5" style={{ background: theme.inputBg, border: `1px solid ${theme.panelBorder}` }}>
                    {(availableEngines || [{ id: 'v1', displayName: 'v1', description: '' }, { id: 'v2', displayName: 'v2', description: '' }, { id: 'v3', displayName: 'HSE', description: 'HyperSoundEngine' }]).map((eng) => (
                      <button
                        key={eng.id}
                        type="button"
                        onClick={() => onSwitchEngine(eng.id)}
                        title={eng.description}
                        className="px-2.5 py-0.5 rounded-full text-[10px] font-medium transition-all"
                        style={engineVersion === eng.id
                          ? { backgroundColor: theme.accentColor, color: '#fff' }
                          : { color: 'rgba(255,255,255,0.55)' }}
                      >
                        {eng.displayName}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-4">
                {/* 认证标志区（白色圆角衬底，保证深色面板上 logo 清晰可辨） */}
                <div className="flex items-center gap-3 rounded-xl bg-white/95 px-3 py-1.5 shadow-md">
                  <HiResBadge />
                  <DtsXBadge />
                  <DolbyAtmosBadge />
                </div>

                {/* 关闭按钮 */}
                <button type="button" className="p-1.5 rounded-md hover:bg-white/10 transition-colors" onClick={onClose} title="关闭调音室">
                  <X className="w-3.5 h-3.5 text-white/60" />
                </button>
              </div>
            </header>

            {/* 页面内容（切换时淡入上移） */}
            <main className="flex-1 overflow-y-auto p-4">
              <motion.div
                key={activePage}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
              >
                {activePage === 'home' && <HomePage {...commonProps} />}
                {activePage === 'scenes' && <ScenesPage {...commonProps} />}
                {activePage === 'eq' && <EqPage {...commonProps} />}
                {activePage === 'spatial' && <SpatialPage {...commonProps} />}
                {activePage === 'dynamics' && <DynamicsPage {...commonProps} />}
                {activePage === 'analysis' && <AnalysisPage {...commonProps} />}
                {activePage === 'tuner' && <TunerPage {...commonProps} exportWav={exportWav} exporting={exporting} />}
                {activePage === 'about' && <AboutPage theme={theme} />}
              </motion.div>
            </main>

            {/* 底部状态栏 */}
            <footer
              className="flex items-center justify-between px-4 py-2.5 text-[11px] shrink-0"
              style={{ borderTop: `1px solid ${theme.panelBorder}`, background: 'rgba(0,0,0,0.25)' }}
            >
              <div className="flex items-center gap-4">
                <span className="text-white/30">引擎版本：<span className="text-white/70">3.0.0</span></span>
                <span className="text-white/30">采样率：<span className="text-white/70">{bridge.getSampleRate()} Hz</span></span>
                <span className="text-white/30">延迟：<span className="text-white/70">{(stats.engineLatencySamples / bridge.getSampleRate() * 1000).toFixed(1)} ms</span></span>
              </div>

              <div className="flex items-center gap-4">
                <span className="text-white/30">当前场景：<span className="font-medium" style={{ color: theme.accentColor }}>{activeSceneName}</span></span>
                <span className="text-white/30">限幅衰减：<span className="text-white/70">{stats.limiterReductionDb.toFixed(1)} dB</span></span>
                <span className="text-white/30">响度：<span className="text-white/70">{Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'} LUFS</span></span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveScene}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] text-white transition-all hover:brightness-110 active:scale-95"
                  style={{ backgroundColor: theme.accentColor }}
                >
                  <Save className="w-3 h-3" /> 保存
                </button>
                <button
                  type="button"
                  onClick={handleResetAll}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-[11px] text-white/60 transition-all hover:bg-white/10"
                  style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.panelBorder}` }}
                >
                  <RotateCcw className="w-3 h-3" /> 重置
                </button>
              </div>
            </footer>
          </div>
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
