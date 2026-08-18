import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, MonitorSmartphone, Moon, Sun } from 'lucide-react'
import { isTvModeActive } from '../platform'

interface RemoteControlSettingsModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

const TOP_RIGHT_ACTIONS = [
  ['song', '查看歌曲'],
  ['comment', '查看评论'],
  ['artist', '查看歌手'],
  ['favorite', '我喜欢'],
  // TV 上无桌面歌词窗口：动作列表动态过滤（见组件内 actions 变量）
  ['desktop-lyrics', '桌面歌词'],
  ['mode-switch', '模式切换'],
] as const

export default function RemoteControlSettingsModal({ show, onClose, playerTheme = 'dark' }: RemoteControlSettingsModalProps) {
  const dark = playerTheme === 'dark'
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => localStorage.getItem('remoteTheme') === 'light' ? 'light' : 'dark')
  const [topRightAction, setTopRightAction] = useState<string>(() => {
    const saved = localStorage.getItem('remoteTopRightAction')
    return ['comment', 'artist', 'favorite', 'desktop-lyrics', 'mode-switch'].includes(saved || '') ? saved! : 'song'
  })
  const [gestures, setGestures] = useState<{ doubleTap: boolean; swipe: boolean; twoFinger: boolean; twoFingerTap: boolean }>(() => {
    try {
      const saved = localStorage.getItem('remoteGestures')
      if (saved) return { doubleTap: true, swipe: true, twoFinger: true, twoFingerTap: true, ...JSON.parse(saved) }
    } catch { /* ignore */ }
    return { doubleTap: true, swipe: true, twoFinger: true, twoFingerTap: true }
  })

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  const syncRemote = (patch: Record<string, unknown>) => {
    void window.electron?.remote?.updateSettings?.(patch as any)
  }

  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'
  const textTertiary = dark ? 'text-white/40' : 'text-black/45'
  const bgCard = dark ? 'bg-white/5' : 'bg-black/5'
  const borderColor = dark ? 'border-white/10' : 'border-black/10'

  const applyTheme = (t: 'dark' | 'light') => {
    setTheme(t)
    localStorage.setItem('remoteTheme', t)
    syncRemote({ theme: t })
  }
  const applyAction = (action: string) => {
    setTopRightAction(action)
    localStorage.setItem('remoteTopRightAction', action)
    syncRemote({ topRightAction: action })
  }
  const toggleGesture = (key: 'doubleTap' | 'swipe' | 'twoFinger' | 'twoFingerTap') => {
    setGestures(prev => {
      const next = { ...prev, [key]: !prev[key] }
      localStorage.setItem('remoteGestures', JSON.stringify(next))
      syncRemote({ gestures: next })
      return next
    })
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[80]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            data-tv-scope
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[90] shadow-2xl overflow-hidden flex flex-col"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            style={{
              background: dark ? 'rgba(12, 15, 24, 0.94)' : 'rgba(250, 250, 250, 0.96)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              borderLeft: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <div className={`flex-shrink-0 p-6 border-b ${borderColor} flex items-center justify-between`}>
              <div>
                <h2 className={`text-2xl font-bold ${textPrimary} flex items-center gap-2`}><MonitorSmartphone className="w-6 h-6" style={{ color: accentColor }} />远程遥控器</h2>
                <p className={`${textSecondary} text-sm mt-1`}>自定义手机遥控器的外观、右上角按钮与触摸板手势</p>
              </div>
              <button type="button" onClick={onClose} className={`p-2 rounded-full transition-colors ${bgCard} hover:bg-white/10`} aria-label="关闭"><X className={`w-5 h-5 ${textPrimary}`} /></button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-8" style={{ scrollbarWidth: 'thin' }}>
              {/* 外观 */}
              <div>
                <h3 className={`text-base font-semibold ${textPrimary} mb-3`}>遥控器外观</h3>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    ['dark', '深色', <Moon key="m" className="w-5 h-5" />],
                    ['light', '浅色', <Sun key="s" className="w-5 h-5" />],
                  ] as const).map(([value, label, icon]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => applyTheme(value)}
                      className={`flex items-center justify-center gap-2 py-3 rounded-xl border-2 text-sm font-medium transition-all ${theme === value ? 'text-white' : textSecondary}`}
                      style={theme === value ? { backgroundColor: `${accentColor}22`, borderColor: accentColor } : { backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', borderColor: 'transparent' }}
                    >
                      <span style={{ color: theme === value ? accentColor : undefined }}>{icon}</span>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 右上角按钮 */}
              <div>
                <h3 className={`text-base font-semibold ${textPrimary} mb-3`}>右上角按钮功能</h3>
                <div className="grid grid-cols-3 gap-2">
                  {TOP_RIGHT_ACTIONS.filter(([value]) => !(isTvModeActive() && value === 'desktop-lyrics')).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => applyAction(value)}
                      className={`py-2.5 rounded-lg text-xs font-medium border-2 transition-all ${topRightAction === value ? 'text-white' : textSecondary}`}
                      style={topRightAction === value ? { backgroundColor: accentColor, borderColor: accentColor } : { backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', borderColor: 'transparent' }}
                    >{label}</button>
                  ))}
                </div>
              </div>

              {/* 触摸板手势 */}
              <div>
                <h3 className={`text-base font-semibold ${textPrimary} mb-3`}>触摸板手势</h3>
                <div className="grid grid-cols-4 gap-2">
                  {([
                    {
                      key: 'doubleTap' as const,
                      label: '双击播放',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <circle cx="9" cy="12" r="4.5" />
                          <circle cx="15" cy="12" r="4.5" opacity=".55" />
                        </svg>
                      ),
                    },
                    {
                      key: 'swipe' as const,
                      label: '横滑切歌',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M8 12H3M21 12h-5" />
                          <path d="M5 9l-2 3 2 3M19 9l2 3-2 3" />
                        </svg>
                      ),
                    },
                    {
                      key: 'twoFinger' as const,
                      label: '双指滚动',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <circle cx="8" cy="12" r="3" />
                          <circle cx="16" cy="12" r="3" />
                          <path d="M8 8V4M16 8V4M8 16v4M16 16v4" />
                          <path d="M6 5l2-2 2 2M14 5l2-2 2 2M6 19l2 2 2-2M14 19l2 2 2-2" />
                        </svg>
                      ),
                    },
                    {
                      key: 'twoFingerTap' as const,
                      label: '双指右键',
                      icon: (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-5 h-5">
                          <circle cx="12" cy="12" r="8" opacity=".5" />
                          <circle cx="8" cy="12" r="3" />
                          <circle cx="16" cy="12" r="3" />
                        </svg>
                      ),
                    },
                  ]).map((gesture) => {
                    const on = gestures[gesture.key]
                    return (
                      <button
                        key={gesture.key}
                        type="button"
                        onClick={() => toggleGesture(gesture.key)}
                        className={`flex flex-col items-center gap-1.5 py-3 rounded-lg border-2 transition-all ${on ? 'text-white' : textSecondary}`}
                        style={on ? { backgroundColor: `${accentColor}22`, borderColor: accentColor } : { backgroundColor: dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', borderColor: 'transparent' }}
                      >
                        <span style={{ color: on ? accentColor : undefined }}>{gesture.icon}</span>
                        <span className="text-xs">{gesture.label}</span>
                        <span className="w-4 h-4 rounded flex items-center justify-center" style={{ background: on ? accentColor : 'transparent', border: on ? 'none' : `1.5px solid ${dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'}` }}>
                          {on && <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3"><path d="M5 13l4 4L19 7" /></svg>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <p className={`${textTertiary} text-xs leading-relaxed`}>设置会立即保存并同步到已连接的设备。</p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
