import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { CSSProperties, MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Settings } from 'lucide-react'
import ModeSelectionCards, { type ModeSelectionMode } from './ModeSelectionCards'
import { useTvBack } from '../tv/tvCore'

export const MODE_SELECTION_PANEL_HEIGHT = 210
// 切换模式前先让面板和被下移的当前界面完整收回。
// 如果来源视图在退出动画尚未结束时卸载，Framer Motion 会把 210px 的
// 中间 transform 留给交叉淡入的下一视图，表现为顶部一整块空栏。
export const MODE_SELECTION_CLOSE_MS = 380

// 模式可见性自定义：控制模式选择下拉菜单里显示哪些模式卡片。
const MODE_VISIBILITY_KEY = 'waveforge_visible_modes'
const ALL_MODES: ModeSelectionMode[] = ['explore', 'minimal', 'desktop']
const MODE_NAMES: Record<ModeSelectionMode, string> = {
  explore: '探索',
  minimal: '简约',
  desktop: '桌面',
}

function loadVisibleModes(): ModeSelectionMode[] {
  try {
    const raw = localStorage.getItem(MODE_VISIBILITY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((mode: unknown): mode is ModeSelectionMode =>
          ALL_MODES.includes(mode as ModeSelectionMode))
        // 简约模式始终显示，历史设置里即使缺失也要补回
        const withMinimal = valid.includes('minimal') ? valid : ['minimal' as ModeSelectionMode, ...valid]
        if (withMinimal.length > 0) return withMinimal
      }
    }
  } catch (error) {
    console.warn('读取模式可见设置失败:', error)
  }
  return [...ALL_MODES]
}

interface ModeSelectionPanelProps {
  currentMode: ModeSelectionMode
  onClose: () => void
  onSelect: (mode: ModeSelectionMode) => void
  exploreAccentRgb?: string
}

export default function ModeSelectionPanel({
  currentMode,
  onClose,
  onSelect,
  exploreAccentRgb = '49, 230, 139',
}: ModeSelectionPanelProps) {
  const [showCustomize, setShowCustomize] = useState(false)
  const [playerTheme, setPlayerTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('playerTheme')
    return (saved as 'dark' | 'light') || 'dark'
  })
  const isLight = playerTheme === 'light'

  // TV 遥控器 BACK：关闭模式选择面板（先收起自定义弹层再收面板）
  useTvBack(() => {
    if (showCustomize) {
      setShowCustomize(false)
      return true
    }
    onClose()
    return true
  }, [showCustomize, onClose])

  useEffect(() => {
    const handleThemeChange = (e: Event) => setPlayerTheme((e as CustomEvent).detail)
    window.addEventListener('playerThemeChanged', handleThemeChange as EventListener)
    return () => window.removeEventListener('playerThemeChanged', handleThemeChange as EventListener)
  }, [])

  const [visibleModes, setVisibleModes] = useState<ModeSelectionMode[]>(() => {
    const loaded = loadVisibleModes()
    return loaded.includes(currentMode) ? loaded : [...loaded, currentMode]
  })

  // 同步其他视图修改的模式可见性设置
  useEffect(() => {
    const handleVisibilityChanged = () => setVisibleModes(loadVisibleModes())
    window.addEventListener('waveforge-modes-visibility-changed', handleVisibilityChanged)
    return () => window.removeEventListener('waveforge-modes-visibility-changed', handleVisibilityChanged)
  }, [])

  // 当前所在模式始终保留在可见列表里
  const ensureMinimalVisible = (modes: ModeSelectionMode[]): ModeSelectionMode[] =>
    modes.includes('minimal') ? modes : ['minimal', ...modes]
  const effectiveVisibleModes = ensureMinimalVisible(
    visibleModes.includes(currentMode)
      ? visibleModes
      : [...visibleModes, currentMode]
  )

  const toggleModeVisibility = (mode: ModeSelectionMode) => {
    const isVisible = effectiveVisibleModes.includes(mode)
    // 不能隐藏当前所在模式、简约模式，也不能隐藏最后一个可见模式
    if (isVisible) {
      if (mode === currentMode) return
      if (mode === 'minimal') return
      if (effectiveVisibleModes.length <= 1) return
    }
    const next = isVisible
      ? effectiveVisibleModes.filter((item) => item !== mode)
      : [...effectiveVisibleModes, mode]
    try {
      localStorage.setItem(MODE_VISIBILITY_KEY, JSON.stringify(next))
    } catch (error) {
      console.warn('保存模式可见设置失败:', error)
    }
    setVisibleModes(next)
    window.dispatchEvent(new Event('waveforge-modes-visibility-changed'))
  }

  const handlePanelClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!showCustomize) return
    if ((event.target as HTMLElement).closest('[data-mode-customize]')) return
    setShowCustomize(false)
  }

  const background = isLight
    ? currentMode === 'minimal'
      ? 'radial-gradient(circle at 50% -32%, rgba(168,85,247,0.16), transparent 58%), linear-gradient(135deg, #f6f3f9, #efeef3)'
      : currentMode === 'explore'
        ? `radial-gradient(circle at 50% -32%, rgba(${exploreAccentRgb},0.14), transparent 58%), linear-gradient(135deg, #f0f6f3, #eef1f4)`
        : 'radial-gradient(circle at 50% -32%, rgba(59,130,246,0.14), transparent 58%), linear-gradient(135deg, #f0f4f9, #eef0f4)'
    : currentMode === 'minimal'
      ? 'radial-gradient(circle at 50% -32%, rgba(168,85,247,0.34), transparent 58%), linear-gradient(135deg, rgb(20,13,34), rgb(6,7,14))'
      : currentMode === 'explore'
        ? `radial-gradient(circle at 50% -32%, rgba(${exploreAccentRgb},0.34), transparent 58%), linear-gradient(135deg, rgb(7,24,27), rgb(5,8,15))`
        : 'radial-gradient(circle at 50% -32%, rgba(59,130,246,0.34), transparent 58%), linear-gradient(135deg, rgb(9,22,42), rgb(5,7,14))'

  return createPortal(
    <motion.div
      key={`mode-selection-panel-${currentMode}`}
      data-tv-scope
      initial={{ y: '-100%' }}
      animate={{ y: 0 }}
      exit={{ y: '-100%' }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      className={`fixed inset-x-0 top-0 z-[100] ${isLight ? 'text-black/85' : 'text-white'}`}
      style={{
        willChange: 'transform',
        backfaceVisibility: 'hidden',
        transform: 'translateZ(0)',
      } as CSSProperties}
    >
      <div
        className={`relative flex items-start justify-center overflow-hidden border-b px-8 pt-4 ${isLight ? 'border-black/10 shadow-[0_20px_70px_rgba(0,0,0,0.12)]' : 'border-white/15 shadow-[0_20px_70px_rgba(0,0,0,0.34)]'}`}
        style={{ height: MODE_SELECTION_PANEL_HEIGHT, background, backgroundColor: isLight ? '#f2f1ec' : '#080b12' }}
        onClick={handlePanelClick}
      >
        <div className="w-full max-w-4xl">
          <h2 className="mb-3 text-center text-xl font-bold">模式选择</h2>
          <div className="flex items-center justify-center gap-4">
            <ModeSelectionCards
              currentMode={currentMode}
              exploreAccentRgb={exploreAccentRgb}
              onSelect={onSelect}
              visibleModes={effectiveVisibleModes}
            />
          </div>
        </div>
        <button
          type="button"
          aria-label="自定义模式显示"
          title="显示 / 隐藏模式"
          data-mode-customize
          onClick={(event) => {
            event.stopPropagation()
            setShowCustomize((value) => !value)
          }}
          className={`absolute bottom-4 right-8 z-30 flex h-9 w-9 items-center justify-center rounded-full border transition-[background-color,color] ${isLight ? 'border-black/10 bg-black/[0.06] text-black/70 hover:bg-black/[0.12] hover:text-black' : 'border-white/15 bg-white/[0.08] text-white/85 hover:bg-white/[0.16] hover:text-white'}`}
        >
          <Settings className="h-[18px] w-[18px]" />
        </button>
      </div>

      <AnimatePresence>
        {showCustomize && (
          <motion.div
            key="mode-customize-popover"
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            data-mode-customize
            className={`absolute right-8 top-[204px] z-40 w-64 rounded-2xl border p-2 backdrop-blur-2xl ${isLight ? 'border-black/10 bg-white/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.15)]' : 'border-white/15 bg-[#0c0e1a]/[0.97] shadow-[0_18px_50px_rgba(0,0,0,0.55)]'}`}
            style={{ willChange: 'transform, opacity' }}
          >
            <p className={`px-2 pb-1.5 pt-1 text-[11px] font-semibold tracking-[0.08em] ${isLight ? 'text-black/50' : 'text-white/55'}`}>显示 / 隐藏模式</p>
            {ALL_MODES.map((mode) => {
              const isVisible = effectiveVisibleModes.includes(mode)
              const isCurrent = currentMode === mode
              // 简约模式始终显示；当前模式与最后一个可见模式也不可隐藏
              const locked = isCurrent || mode === 'minimal' || (isVisible && effectiveVisibleModes.length <= 1)
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={locked}
                  onClick={() => toggleModeVisibility(mode)}
                  className={`flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${isLight ? 'hover:bg-black/[0.05]' : 'hover:bg-white/[0.07]'}`}
                >
                  <span className="flex flex-col leading-tight">
                    <span className={`text-sm font-medium ${isLight ? 'text-black/85' : 'text-white/95'}`}>{MODE_NAMES[mode]}</span>
                    <span className={`mt-0.5 text-[10px] ${isLight ? 'text-black/40' : 'text-white/45'}`}>
                      {mode === 'minimal' ? '始终显示' : (isCurrent ? '当前模式' : (isVisible ? '显示中' : '已隐藏'))}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors duration-200 ${isVisible ? 'bg-emerald-400/80' : isLight ? 'bg-black/15' : 'bg-white/15'}`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left] duration-200 ${isVisible ? 'left-[18px]' : 'left-0.5'}`}
                    />
                  </span>
                </button>
              )
            })}
            <p className={`px-2 pb-1 pt-1.5 text-[10px] leading-snug ${isLight ? 'text-black/35' : 'text-white/35'}`}>
              简约模式始终显示；当前模式与最后一个可见模式不可隐藏
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex justify-center -mt-px">
        <button
          type="button"
          aria-label="收起模式选择"
          onClick={onClose}
          className={`group relative flex h-9 w-[200px] items-center justify-center overflow-hidden rounded-b-2xl border border-t-0 transition-colors ${isLight ? 'border-black/15 bg-black/[0.06] shadow-[0_12px_34px_rgba(0,0,0,0.1),inset_0_-1px_0_rgba(0,0,0,0.06)] hover:bg-black/[0.1]' : 'border-white/25 bg-white/[0.09] shadow-[0_12px_34px_rgba(0,0,0,0.24),inset_0_-1px_0_rgba(255,255,255,0.08)] hover:bg-white/[0.16]'}`}
        >
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 backdrop-blur-xl backdrop-saturate-150 ${isLight ? 'bg-[linear-gradient(180deg,rgba(255,255,255,0.5),rgba(255,255,255,0.2))]' : 'bg-[linear-gradient(180deg,rgba(255,255,255,0.12),rgba(255,255,255,0.035))]'}`}
          />
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-5 top-0 h-px bg-gradient-to-r from-transparent to-transparent ${isLight ? 'via-black/20' : 'via-white/45'}`}
          />
          <svg className={`relative z-10 h-6 w-6 drop-shadow ${isLight ? 'text-black/80' : 'text-white/95'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path d="M5 15l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
          </svg>
        </button>
      </div>
    </motion.div>,
    document.body,
  )
}
