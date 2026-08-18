/**
 * 遥控器可视化教学弹窗（TV 端「TV设置」→ 遥控器可视化）：
 * 用动画逐个演示遥控器按键的作用。遥控器 UI 用 CSS 绘制（Android TV 遥控器样式），
 * 当前讲解的按键高亮 + 底部说明，支持自动播放与手动切换（适配遥控器方向键导航）。
 */
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronLeft, ChevronRight, Play, Pause, Power, Home as HomeIcon, ArrowLeft, RotateCcw, Search, Volume2, VolumeX, SkipBack, SkipForward, CirclePause, Menu as MenuIcon, CornerDownLeft } from 'lucide-react'

interface RemoteControlGuideModalProps {
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

interface RemoteKey {
  id: string
  label: string
  desc: string
}

const KEYS: RemoteKey[] = [
  { id: 'dpad', label: '方向键', desc: '上下左右移动选择框，在界面中选中项目' },
  { id: 'ok', label: '确定 (OK)', desc: '确认选择：进入歌单、打开歌曲、播放 / 暂停' },
  { id: 'back', label: '返回', desc: '返回上一级界面，或关闭当前弹窗 / 软键盘' },
  { id: 'home', label: '主页', desc: '无论在哪，一键回到首页' },
  { id: 'menu', label: '菜单', desc: '呼出当前歌曲的详情 / 操作' },
  { id: 'volume', label: '音量 + / -', desc: '调节 TV 音量；在音量滑块聚焦时微调' },
  { id: 'mute', label: '静音', desc: '一键静音，再按一次恢复' },
  { id: 'prevnext', label: '上一首 / 下一首', desc: '切换上一首或下一首歌曲' },
  { id: 'playpause', label: '播放 / 暂停', desc: '播放或暂停当前歌曲' },
  { id: 'search', label: '搜索', desc: '快速打开搜索，找歌 / 找歌单' },
]

const ACTIVE_COLOR = '#4fc3f7'

export default function RemoteControlGuideModal({ onClose, playerTheme = 'dark' }: RemoteControlGuideModalProps) {
  const [current, setCurrent] = useState(0)
  const [playing, setPlaying] = useState(true)
  const timerRef = useRef<number | null>(null)

  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/60' : 'text-black/60'
  const textTertiary = isDark ? 'text-white/40' : 'text-black/40'
  const borderColor = isDark ? 'border-white/10' : 'border-black/10'
  const bgPanel = isDark ? 'rgba(14,17,24,0.94)' : 'rgba(255,255,255,0.95)'

  const key = KEYS[current]

  // 自动播放：每隔一段时间切到下一个按键
  useEffect(() => {
    if (!playing) return
    timerRef.current = window.setInterval(() => {
      setCurrent((v) => (v + 1) % KEYS.length)
    }, 3800)
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, current])

  const goNext = () => setCurrent((v) => (v + 1) % KEYS.length)
  const goPrev = () => setCurrent((v) => (v - 1 + KEYS.length) % KEYS.length)

  // 高亮判定：当前讲解的按键组
  const isActive = (ids: string[]) => ids.includes(key.id)

  // 按键格子通用样式
  const keyBox = (active: boolean): React.CSSProperties => ({
    minWidth: 52,
    height: 44,
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.14)',
    background: active ? 'rgba(79,195,247,0.22)' : 'rgba(255,255,255,0.08)',
    color: active ? ACTIVE_COLOR : 'rgba(255,255,255,0.85)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
  })

  const highlight = (active: boolean): React.CSSProperties =>
    active
      ? { boxShadow: `0 0 0 2px ${ACTIVE_COLOR}, 0 0 18px rgba(79,195,247,0.55)`, borderColor: ACTIVE_COLOR, transform: 'scale(1.06)' }
      : { boxShadow: 'none', transform: 'scale(1)' }

  // 按键（带高亮过渡）
  const Key = ({ ids, children, extra }: { ids: string[]; children: React.ReactNode; extra?: React.CSSProperties }) => {
    const active = isActive(ids)
    return (
      <div style={{ ...keyBox(active), ...highlight(active), ...extra, transition: 'all .3s' }}>
        {children}
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[9000] flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.6)', padding: 24 }} onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ type: 'spring', damping: 26, stiffness: 300 }}
        onClick={(e) => e.stopPropagation()}
        data-tv-scope
        className="w-full max-w-md rounded-3xl border p-6 shadow-2xl"
        style={{ background: bgPanel, borderColor: borderColor, maxHeight: '92vh', overflowY: 'auto' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ backgroundColor: 'rgba(79,195,247,0.15)', color: ACTIVE_COLOR }}>
              <RotateCcw className="h-5 w-5" />
            </div>
            <div>
              <h2 className={`text-lg font-bold ${textPrimary}`}>遥控器可视化</h2>
              <p className={`text-xs ${textTertiary}`}>认识遥控器按键 · 第 {current + 1}/{KEYS.length} 个</p>
            </div>
          </div>
          <button onClick={onClose} data-tv-focus tabIndex={-1} className={`p-2 rounded-full transition-colors ${isDark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        {/* 遥控器 UI */}
        <div className="rounded-3xl p-5 mx-auto" style={{ width: 248, background: 'linear-gradient(160deg, #171c26, #0d1117)', border: '1px solid rgba(255,255,255,0.1)', boxShadow: '0 20px 50px rgba(0,0,0,0.45)' }}>
          {/* D-pad：方向键与中央 OK 分开留隙，OK 位于正中心 */}
          <div className="flex justify-center mb-3">
            <div style={{ position: 'relative', width: 150, height: 150 }}>
              <Key ids={['dpad']} extra={{ position: 'absolute', left: 49, top: 0, width: 52, height: 42 }}><span>▲</span></Key>
              <Key ids={['dpad']} extra={{ position: 'absolute', left: 0, top: 54, width: 42, height: 42 }}><span>◀</span></Key>
              <Key ids={['ok']} extra={{ position: 'absolute', left: 51, top: 54, width: 48, height: 42 }}><CornerDownLeft className="w-4 h-4" /></Key>
              <Key ids={['dpad']} extra={{ position: 'absolute', left: 108, top: 54, width: 42, height: 42 }}><span>▶</span></Key>
              <Key ids={['dpad']} extra={{ position: 'absolute', left: 49, top: 108, width: 52, height: 42 }}><span>▼</span></Key>
            </div>
          </div>

          {/* 返回 / 主页 / 菜单 */}
          <div className="flex justify-center gap-3 mb-3">
            <Key ids={['back']}><ArrowLeft className="w-4 h-4" /></Key>
            <Key ids={['home']}><HomeIcon className="w-4 h-4" /></Key>
            <Key ids={['menu']}><MenuIcon className="w-4 h-4" /></Key>
          </div>

          {/* 音量行 */}
          <div className="flex justify-center gap-3 mb-3">
            <Key ids={['volume']}><Volume2 className="w-4 h-4" /><span>－</span></Key>
            <Key ids={['mute']}><VolumeX className="w-4 h-4" /></Key>
            <Key ids={['volume']}><Volume2 className="w-4 h-4" /><span>＋</span></Key>
          </div>

          {/* 媒体行 */}
          <div className="flex justify-center gap-3 mb-3">
            <Key ids={['prevnext']}><SkipBack className="w-4 h-4" /></Key>
            <Key ids={['playpause']}><CirclePause className="w-4 h-4" /></Key>
            <Key ids={['prevnext']}><SkipForward className="w-4 h-4" /></Key>
          </div>

          {/* 搜索 */}
          <div className="flex justify-center">
            <Key ids={['search']} extra={{ minWidth: 88 }}><Search className="w-4 h-4" /><span>搜索</span></Key>
          </div>
        </div>

        {/* 当前按键说明 */}
        <div className="mt-5 min-h-[76px]">
          <AnimatePresence mode="wait">
            <motion.div
              key={key.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
            >
              <div className={`text-base font-bold ${textPrimary}`} style={{ color: ACTIVE_COLOR }}>{key.label}</div>
              <div className={`mt-1 text-sm leading-6 ${textSecondary}`}>{key.desc}</div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* 控制条 */}
        <div className="mt-4 flex items-center justify-center gap-3">
          <button
            data-tv-focus
            tabIndex={-1}
            onClick={goPrev}
            className="flex items-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all"
            style={{ background: 'rgba(79,195,247,0.15)', color: ACTIVE_COLOR }}
          >
            <ChevronLeft className="w-4 h-4" />上一个
          </button>
          <button
            data-tv-focus
            tabIndex={-1}
            onClick={() => setPlaying((v) => !v)}
            className="flex items-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all"
            style={{ background: 'rgba(255,255,255,0.1)', color: isDark ? '#fff' : '#000' }}
          >
            {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {playing ? '暂停演示' : '自动演示'}
          </button>
          <button
            data-tv-focus
            tabIndex={-1}
            onClick={goNext}
            className="flex items-center gap-1 rounded-xl px-4 py-2.5 text-sm font-semibold transition-all"
            style={{ background: 'rgba(79,195,247,0.15)', color: ACTIVE_COLOR }}
          >
            下一个<ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </div>
  )
}
