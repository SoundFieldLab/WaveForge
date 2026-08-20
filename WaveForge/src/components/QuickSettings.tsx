import { motion, AnimatePresence } from 'framer-motion'
import { memo, useState, useEffect } from 'react'
import { SlidersHorizontal, Plus, Minus, X } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface QuickSettingsProps {
  forceClose?: boolean
  playerTheme?: 'light' | 'dark'
  isPureMusic?: boolean
}

type CoverPulseMode = 'dynamic' | 'soft' | 'restless'
type WordByWordEffectMode = 'clear' | 'soft' | 'apple'
type LyricDisplayMode = 'modern' | 'immersive' | 'wallpaper' | 'glorious' | 'video'

// 大体积设置面板（约 900 行 JSX）：props 均为原语（forceClose/playerTheme/isPureMusic），
// memo 让 1Hz 播放重渲染（经 ImmersiveControls 传递）不再连带重渲染整个面板
export default memo(function QuickSettings({
  forceClose,
  playerTheme = 'dark',
  isPureMusic = false,
}: QuickSettingsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [activeSection, setActiveSection] = useState<'appearance' | 'features'>('appearance')

  // TV 遥控器 BACK：收起快捷设置下拉
  useTvBack(() => {
    if (isOpen) {
      setIsOpen(false)
      return true
    }
    return false
  }, [isOpen])

  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })

  useEffect(() => {
    const handleAccentColorChange = (e: CustomEvent) => {
      setAccentColor(e.detail)
    }
    window.addEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    return () => {
      window.removeEventListener('accentColorChanged', handleAccentColorChange as EventListener)
    }
  }, [])

  useEffect(() => {
    if (forceClose) {
      setIsOpen(false)
    }
  }, [forceClose])

  useEffect(() => {
    const handleLyricDisplayModeChange = (event: Event) => {
      const mode = (event as CustomEvent<LyricDisplayMode>).detail
      if (mode) {
        setLyricDisplayMode(mode)
        return
      }

      const saved = localStorage.getItem('lyricDisplayMode')
      setLyricDisplayMode(saved === 'immersive' || saved === 'wallpaper' || saved === 'glorious' || saved === 'video' ? saved : 'modern')
    }

    window.addEventListener('lyricDisplayModeChanged', handleLyricDisplayModeChange)
    return () => window.removeEventListener('lyricDisplayModeChanged', handleLyricDisplayModeChange)
  }, [])

  const [lyricSize, setLyricSize] = useState(() => {
    const saved = localStorage.getItem('lyricSize')
    return saved ? parseFloat(saved) : 2.8
  })

  const [lyricOffset, setLyricOffset] = useState(() => {
    const saved = localStorage.getItem('lyricOffset')
    return saved ? parseFloat(saved) : 0
  })

  const [wordByWord, setWordByWord] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [wordByWordEffectMode, setWordByWordEffectMode] = useState<WordByWordEffectMode>(() => {
    const saved = localStorage.getItem('wordByWordEffectMode')
    if (saved === 'soft' || saved === 'apple') return saved
    return 'clear'
  })

  const [lyricGlow, setLyricGlow] = useState(() => {
    const saved = localStorage.getItem('lyricGlow')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [coverPulseEnabled, setCoverPulseEnabled] = useState(() => {
    const saved = localStorage.getItem('coverPulseEnabled')
    return saved !== null ? JSON.parse(saved) : false
  })

  const [coverPulseMode, setCoverPulseMode] = useState<CoverPulseMode>(() => {
    const saved = localStorage.getItem('coverPulseMode')
    if (saved === 'precise') return 'restless'
    return saved === 'dynamic' || saved === 'restless' ? saved : 'soft'
  })

  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('playerTheme')
    return (saved as 'dark' | 'light') || 'dark'
  })

  const [backgroundEffect, setBackgroundEffect] = useState<'transparent' | 'blur' | 'immersive'>(() => {
    const saved = localStorage.getItem('backgroundEffect')
    return (saved as 'transparent' | 'blur' | 'immersive') || 'blur'
  })

  const [backgroundBlur, setBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('backgroundBlur')
    return saved ? parseFloat(saved) : 30
  })

  // MV 视频背景的独立模糊度（与封面背景两套设置）；当前是否 MV 视频背景由 App 广播
  const [mvBackgroundBlur, setMvBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('mvBackgroundBlur')
    const parsed = saved ? parseFloat(saved) : Number.NaN
    return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0
  })
  const [mvBackgroundActive, setMvBackgroundActive] = useState(false)
  useEffect(() => {
    const onActive = (e: Event) => setMvBackgroundActive((e as CustomEvent<boolean>).detail === true)
    window.addEventListener('mvBackgroundActiveChanged', onActive as EventListener)
    // 挂载时主动查询当前 MV 背景状态：本面板懒加载可能晚于 MV 激活，错过一次性广播
    window.dispatchEvent(new Event('mvBackgroundActiveQuery'))
    return () => window.removeEventListener('mvBackgroundActiveChanged', onActive as EventListener)
  }, [])

  const [showImmersiveBar, setShowImmersiveBar] = useState(() => {
    const saved = localStorage.getItem('showImmersiveBar')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [lyricDisplayMode, setLyricDisplayMode] = useState<LyricDisplayMode>(() => {
    const saved = localStorage.getItem('lyricDisplayMode')
    return saved === 'immersive' || saved === 'wallpaper' || saved === 'glorious' || saved === 'video' ? saved : 'modern'
  })

  const [modernAudioVisualizerEnabled, setModernAudioVisualizerEnabled] = useState(() => {
    const saved = localStorage.getItem('modernAudioVisualizerEnabled')
    return saved !== null ? JSON.parse(saved) : true
  })

  const [hideImmersiveSongInfo, setHideImmersiveSongInfo] = useState(() => {
    const saved = localStorage.getItem('hideImmersiveSongInfo')
    return saved !== null ? JSON.parse(saved) : false
  })

  const handleLyricSizeChange = (delta: number) => {
    const newSize = Math.max(1.5, Math.min(4.5, lyricSize + delta))
    setLyricSize(newSize)
    localStorage.setItem('lyricSize', newSize.toString())
    window.dispatchEvent(new CustomEvent('lyricSizeChanged', { detail: newSize }))
  }

  const handleLyricOffsetChange = (delta: number) => {
    const nextOffset = Math.max(-5, Math.min(5, lyricOffset + delta))
    const newOffset = Math.abs(nextOffset) < 0.05 ? 0 : nextOffset
    setLyricOffset(newOffset)
    localStorage.setItem('lyricOffset', newOffset.toString())
    window.dispatchEvent(new CustomEvent('lyricOffsetChanged', { detail: newOffset }))
  }

  const handleWordByWordToggle = () => {
    const newValue = !wordByWord
    setWordByWord(newValue)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(newValue))
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  const handleWordByWordEffectModeChange = (mode: WordByWordEffectMode) => {
    setWordByWordEffectMode(mode)
    localStorage.setItem('wordByWordEffectMode', mode)
    window.dispatchEvent(new CustomEvent('wordByWordEffectModeChanged', { detail: mode }))
  }

  const handleLyricGlowToggle = () => {
    const newValue = !lyricGlow
    setLyricGlow(newValue)
    localStorage.setItem('lyricGlow', JSON.stringify(newValue))
    window.dispatchEvent(new Event('lyricGlowChanged'))
  }

  const handleCoverPulseToggle = () => {
    const newValue = !coverPulseEnabled
    setCoverPulseEnabled(newValue)
    localStorage.setItem('coverPulseEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('coverPulseChanged', { detail: newValue }))
  }

  const handleCoverPulseModeChange = (mode: CoverPulseMode) => {
    setCoverPulseMode(mode)
    localStorage.setItem('coverPulseMode', mode)
    window.dispatchEvent(new CustomEvent('coverPulseModeChanged', { detail: mode }))
  }

  const handleThemeChange = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme)
    localStorage.setItem('playerTheme', newTheme)
    window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: newTheme }))
  }

  const handleBackgroundEffectChange = (effect: 'transparent' | 'blur' | 'immersive') => {
    setBackgroundEffect(effect)
    localStorage.setItem('backgroundEffect', effect)
    window.dispatchEvent(new CustomEvent('backgroundEffectChanged', { detail: effect }))
  }

  // 模糊滑块当前生效值/写回：MV 视频背景激活时操作 mvBackgroundBlur，封面背景时操作 backgroundBlur
  const activeBackgroundBlur = mvBackgroundActive ? mvBackgroundBlur : backgroundBlur

  const handleBackgroundBlurChange = (value: number) => {
    if (mvBackgroundActive) {
      setMvBackgroundBlur(value)
      window.dispatchEvent(new CustomEvent('mvBackgroundBlurChanged', { detail: value }))
    } else {
      setBackgroundBlur(value)
      window.dispatchEvent(new CustomEvent('backgroundBlurChanged', { detail: value }))
    }
  }

  const handleBackgroundBlurCommit = () => {
    if (mvBackgroundActive) {
      localStorage.setItem('mvBackgroundBlur', mvBackgroundBlur.toString())
    } else {
      localStorage.setItem('backgroundBlur', backgroundBlur.toString())
    }
  }

  const handleImmersiveBarToggle = () => {
    const newValue = !showImmersiveBar
    setShowImmersiveBar(newValue)
    localStorage.setItem('showImmersiveBar', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('immersiveBarChanged', { detail: newValue }))
  }

  const handleModernAudioVisualizerToggle = () => {
    const newValue = !modernAudioVisualizerEnabled
    setModernAudioVisualizerEnabled(newValue)
    localStorage.setItem('modernAudioVisualizerEnabled', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('modernAudioVisualizerChanged', { detail: newValue }))
  }

  const handleHideImmersiveSongInfoToggle = () => {
    const newValue = !hideImmersiveSongInfo
    setHideImmersiveSongInfo(newValue)
    localStorage.setItem('hideImmersiveSongInfo', JSON.stringify(newValue))
    window.dispatchEvent(new CustomEvent('hideImmersiveSongInfoChanged', { detail: newValue }))
  }

  const formatLyricOffset = (value: number) => {
    const normalized = Math.abs(value) < 0.05 ? 0 : value
    return normalized.toFixed(1)
  }

  return (
    <div className="relative">
      {/* 自定义滑块拇指为白色圆形 */}
      <style>{`
        .white-thumb::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #ffffff;
          cursor: pointer;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        .white-thumb::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: #ffffff;
          cursor: pointer;
          border: none;
          box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        }
        .white-thumb:focus {
          outline: none;
        }

        /* 滚动条样式 - 与边框主题一致 */
        .scrollbar-theme {
          scrollbar-width: thin;
          scrollbar-color: transparent transparent;
        }
        .scrollbar-theme::-webkit-scrollbar {
          width: 4px;
        }
        .scrollbar-theme::-webkit-scrollbar-track {
          background: transparent;
        }
        .scrollbar-theme::-webkit-scrollbar-thumb {
          border-radius: 10px;
        }
        .dark-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.3);
        }
        .dark-scrollbar {
          scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
        }
        .light-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(0, 0, 0, 0.3);
        }
        .light-scrollbar {
          scrollbar-color: rgba(0, 0, 0, 0.3) transparent;
        }
      `}</style>

      <motion.button
        whileHover={{ scale: 1.1, x: -2 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => setIsOpen(!isOpen)}
        className={`p-3 rounded-full backdrop-blur-md border transition-colors ${
          playerTheme === 'dark'
            ? 'bg-black/40 hover:bg-black/60 border-white/20'
            : 'bg-white/40 hover:bg-white/60 border-black/20'
        }`}
      >
        <SlidersHorizontal
          className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'} transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="fixed inset-0 z-40"
            />

            <motion.div
              initial={{ opacity: 0, scale: 0.9, x: 20, y: -20 }}
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, x: 20, y: -20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="absolute top-14 right-0 z-50 w-80 rounded-3xl overflow-hidden"
            >
              <div
                className="absolute inset-0"
                style={{
                  background:
                    playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(15,15,25,0.85) 30%, rgba(25,15,35,0.8) 70%, rgba(0,0,0,0.75) 100%)'
                      : 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(245,245,250,0.85) 30%, rgba(250,245,255,0.8) 70%, rgba(255,255,255,0.75) 100%)',
                  backdropFilter: 'blur(60px) saturate(200%) brightness(1.1)',
                  WebkitBackdropFilter: 'blur(60px) saturate(200%) brightness(1.1)',
                }}
              />

              <div
                className="absolute inset-0"
                style={{
                  background:
                    playerTheme === 'dark'
                      ? 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.15) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.08) 0%, transparent 40%)'
                      : 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.9) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.5) 0%, transparent 40%)',
                  pointerEvents: 'none',
                }}
              />

              <div
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage:
                    'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\' opacity=\'0.05\'/%3E%3C/svg%3E")',
                  pointerEvents: 'none',
                }}
              />

              <div
                className="absolute inset-0 rounded-3xl"
                style={{
                  border:
                    playerTheme === 'dark'
                      ? '1.5px solid rgba(255,255,255,0.2)'
                      : '1.5px solid rgba(0,0,0,0.15)',
                  boxShadow:
                    playerTheme === 'dark'
                      ? '0 20px 60px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.2), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.2)'
                      : '0 20px 60px rgba(0,0,0,0.2), 0 0 1px rgba(255,255,255,0.8), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 -1px 1px rgba(0,0,0,0.05)',
                  pointerEvents: 'none',
                }}
              />

              {/* 滚动容器：内容过多时出现滚动条，主题自动适配 */}
              <div
                className={`relative max-h-[50vh] overflow-y-auto p-4 space-y-3 scrollbar-theme ${
                  playerTheme === 'dark' ? 'dark-scrollbar' : 'light-scrollbar'
                }`}
              >
                <div
                  className={`flex items-center justify-between pb-2 border-b ${
                    playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
                  }`}
                >
                  <h3
                    className={`font-semibold text-sm flex-shrink-0 ${
                      playerTheme === 'dark' ? 'text-white' : 'text-black'
                    }`}
                  >
                    播放设置
                  </h3>
                  <div
                    className={`relative mx-3 flex w-28 flex-shrink-0 rounded-full p-0.5 ${
                      playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'
                    }`}
                  >
                    <motion.div
                      className="absolute top-0.5 bottom-0.5 w-[calc(50%-2px)] rounded-full"
                      animate={{ x: activeSection === 'appearance' ? 0 : 54 }}
                      transition={{ type: 'spring', stiffness: 420, damping: 32 }}
                      style={{
                        backgroundColor: accentColor,
                        boxShadow: `0 0 10px ${accentColor}35`,
                      }}
                    />
                    {([
                      ['appearance', '外观'],
                      ['features', '功能'],
                    ] as const).map(([section, label]) => (
                      <button
                        key={section}
                        onClick={() => setActiveSection(section)}
                        className="relative z-10 flex-1 py-1 text-xs font-medium transition-colors"
                        style={{
                          color:
                            activeSection === section
                              ? '#fff'
                              : playerTheme === 'dark'
                              ? 'rgba(255,255,255,0.65)'
                              : 'rgba(0,0,0,0.65)',
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setIsOpen(false)}
                    className={`p-1 rounded-full transition-colors flex-shrink-0 ${
                      playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/5'
                    }`}
                  >
                    <X
                      className={`w-4 h-4 ${
                        playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
                      }`}
                    />
                  </button>
                </div>

                {activeSection === 'appearance' ? (
                  <>
                    <div className="flex flex-col gap-2">
                      <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                        主题色
                      </span>
                      <div className="flex gap-2">
                        {(['dark', 'light'] as const).map((themeOption) => (
                          <button
                            key={themeOption}
                            onClick={() => handleThemeChange(themeOption)}
                            className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                            style={{
                              backgroundColor:
                                theme === themeOption
                                  ? accentColor
                                  : playerTheme === 'dark'
                                  ? 'rgba(255,255,255,0.1)'
                                  : 'rgba(0,0,0,0.1)',
                              color:
                                theme === themeOption
                                  ? '#fff'
                                  : playerTheme === 'dark'
                                  ? 'rgba(255,255,255,0.6)'
                                  : 'rgba(0,0,0,0.6)',
                              boxShadow: theme === themeOption ? `0 0 8px ${accentColor}30` : 'none',
                            }}
                          >
                            {themeOption === 'dark' ? '深色' : '浅色'}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                        背景律动
                      </span>
                      <button
                        onClick={handleCoverPulseToggle}
                        className="relative w-12 h-7 rounded-full transition-all duration-300"
                        style={{
                          backgroundColor: coverPulseEnabled
                            ? accentColor
                            : playerTheme === 'dark'
                            ? 'rgba(255,255,255,0.15)'
                            : 'rgba(0,0,0,0.15)',
                          boxShadow: coverPulseEnabled
                            ? `0 0 12px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                            : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                        }}
                      >
                        <motion.div
                          animate={{
                            x: coverPulseEnabled ? 22 : 2,
                            scale: coverPulseEnabled ? 1 : 0.9,
                          }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                          className="absolute top-1 w-5 h-5 bg-white rounded-full"
                          style={{
                            boxShadow: '0 2px 4px rgba(0,0,0,0.2), 0 0 2px rgba(0,0,0,0.1)',
                          }}
                        />
                      </button>
                    </div>

                    {coverPulseEnabled && (
                      <div className="flex flex-col gap-2">
                        <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                          律动效果
                        </span>
                        <div className="grid grid-cols-3 gap-2">
                          {([
                            ['dynamic', '动感'],
                            ['soft', '柔和'],
                            ['restless', '躁动'],
                          ] as const).map(([mode, label]) => (
                            <button
                              key={mode}
                              onClick={() => handleCoverPulseModeChange(mode)}
                              className="py-1.5 rounded-lg text-xs font-medium transition-all"
                              style={{
                                backgroundColor:
                                  coverPulseMode === mode
                                    ? accentColor
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.1)'
                                    : 'rgba(0,0,0,0.1)',
                                color:
                                  coverPulseMode === mode
                                    ? '#fff'
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.65)'
                                    : 'rgba(0,0,0,0.65)',
                                boxShadow: coverPulseMode === mode ? `0 0 8px ${accentColor}30` : 'none',
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                        背景效果
                      </span>
                      <div className="flex gap-2">
                        {(['transparent', 'blur', 'immersive'] as const).map((effect) => (
                          <button
                            key={effect}
                            onClick={() => handleBackgroundEffectChange(effect)}
                            className="flex-1 py-1.5 rounded-lg text-xs font-medium transition-all"
                            style={{
                              backgroundColor:
                                backgroundEffect === effect
                                  ? accentColor
                                  : playerTheme === 'dark'
                                  ? 'rgba(255,255,255,0.1)'
                                  : 'rgba(0,0,0,0.1)',
                              color:
                                backgroundEffect === effect
                                  ? '#fff'
                                  : playerTheme === 'dark'
                                  ? 'rgba(255,255,255,0.6)'
                                  : 'rgba(0,0,0,0.6)',
                              boxShadow:
                                backgroundEffect === effect ? `0 0 8px ${accentColor}30` : 'none',
                            }}
                          >
                            {effect === 'transparent' ? '通透' : effect === 'blur' ? '模糊' : '沉浸'}
                          </button>
                        ))}
                      </div>

                      {backgroundEffect === 'transparent' && (
                        <div className="flex flex-col gap-3 mt-3">
                          <div className="flex items-center justify-between">
                            <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                              模糊程度
                            </span>
                            <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                              {activeBackgroundBlur}px
                            </span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={activeBackgroundBlur}
                            onChange={(e) => handleBackgroundBlurChange(parseFloat(e.target.value))}
                            onMouseUp={handleBackgroundBlurCommit}
                            onTouchEnd={handleBackgroundBlurCommit}
                            className="white-thumb w-full h-1 rounded-full appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${activeBackgroundBlur}%, ${
                                playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
                              } ${activeBackgroundBlur}%, ${
                                playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
                              } 100%)`,
                            }}
                          />
                        </div>
                      )}

                      {backgroundEffect === 'immersive' && (
                        <div className="flex flex-col gap-3 mt-3">
                          <div className="flex items-center justify-between">
                            <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                              隐藏白条
                            </span>
                            <button
                              onClick={handleImmersiveBarToggle}
                              className="relative w-10 h-[22px] rounded-full transition-all duration-300"
                              style={{
                                backgroundColor: !showImmersiveBar
                                  ? accentColor
                                  : playerTheme === 'dark'
                                  ? 'rgba(255,255,255,0.15)'
                                  : 'rgba(0,0,0,0.15)',
                                boxShadow: !showImmersiveBar
                                  ? `0 0 10px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                                  : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                              }}
                            >
                              <motion.div
                                animate={{ x: !showImmersiveBar ? 20 : 2, scale: !showImmersiveBar ? 1 : 0.9 }}
                                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                                className="absolute top-[3px] w-4 h-4 bg-white rounded-full"
                                style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.2)' }}
                              />
                            </button>
                          </div>

                          <div className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                              <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                                模糊程度
                              </span>
                              <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                                {activeBackgroundBlur}px
                              </span>
                            </div>
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={activeBackgroundBlur}
                              onChange={(e) => handleBackgroundBlurChange(parseFloat(e.target.value))}
                              onMouseUp={handleBackgroundBlurCommit}
                              onTouchEnd={handleBackgroundBlurCommit}
                              className="white-thumb w-full h-1 rounded-full appearance-none cursor-pointer"
                              style={{
                                background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${activeBackgroundBlur}%, ${
                                  playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
                                } ${activeBackgroundBlur}%, ${
                                  playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'
                                } 100%)`,
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                          音频可视化
                        </span>
                        <p className={`mt-0.5 text-[11px] ${playerTheme === 'dark' ? 'text-white/45' : 'text-black/45'}`}>
                          在左下角显示实时频谱条
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label="切换现代模式音频可视化"
                        aria-pressed={modernAudioVisualizerEnabled}
                        onClick={handleModernAudioVisualizerToggle}
                        className="relative h-7 w-12 rounded-full transition-all duration-300"
                        style={{
                          backgroundColor: modernAudioVisualizerEnabled
                            ? accentColor
                            : playerTheme === 'dark'
                            ? 'rgba(255,255,255,0.15)'
                            : 'rgba(0,0,0,0.15)',
                          boxShadow: modernAudioVisualizerEnabled
                            ? `0 0 12px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                            : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                        }}
                      >
                        <motion.div
                          animate={{
                            x: modernAudioVisualizerEnabled ? 22 : 2,
                            scale: modernAudioVisualizerEnabled ? 1 : 0.9,
                          }}
                          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                          className="absolute top-1 h-5 w-5 rounded-full bg-white"
                          style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.2), 0 0 2px rgba(0,0,0,0.1)' }}
                        />
                      </button>
                    </div>

                    {lyricDisplayMode === 'immersive' && (
                      <div className="flex items-center justify-between">
                        <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                          隐藏歌名艺人
                        </span>
                        <button
                          onClick={handleHideImmersiveSongInfoToggle}
                          className="relative w-12 h-7 rounded-full transition-all duration-300"
                          style={{
                            backgroundColor: hideImmersiveSongInfo
                              ? accentColor
                              : playerTheme === 'dark'
                              ? 'rgba(255,255,255,0.15)'
                              : 'rgba(0,0,0,0.15)',
                            boxShadow: hideImmersiveSongInfo
                              ? `0 0 12px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                              : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                          }}
                        >
                          <motion.div
                            animate={{ x: hideImmersiveSongInfo ? 22 : 2, scale: hideImmersiveSongInfo ? 1 : 0.9 }}
                            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                            className="absolute top-1 w-5 h-5 bg-white rounded-full"
                            style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.2), 0 0 2px rgba(0,0,0,0.1)' }}
                          />
                        </button>
                      </div>
                    )}

                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                        歌词大小
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLyricSizeChange(-0.2)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20' : 'bg-black/10 hover:bg-black/20'
                          }`}
                        >
                          <Minus className={`w-3 h-3 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </button>
                        <span className={`text-sm w-12 text-center ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>
                          {lyricSize.toFixed(1)}
                        </span>
                        <button
                          onClick={() => handleLyricSizeChange(0.2)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20' : 'bg-black/10 hover:bg-black/20'
                          }`}
                        >
                          <Plus className={`w-3 h-3 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </button>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                        歌词偏移
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleLyricOffsetChange(-0.1)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20' : 'bg-black/10 hover:bg-black/20'
                          }`}
                        >
                          <Minus className={`w-3 h-3 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </button>
                        <span className={`text-sm w-12 text-center ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>
                          {formatLyricOffset(lyricOffset)}
                        </span>
                        <button
                          onClick={() => handleLyricOffsetChange(0.1)}
                          className={`p-1.5 rounded-lg transition-colors ${
                            playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20' : 'bg-black/10 hover:bg-black/20'
                          }`}
                        >
                          <Plus className={`w-3 h-3 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                        </button>
                      </div>
                    </div>

                    {!isPureMusic && (
                      <>
                        <div className="flex items-center justify-between">
                          <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                            逐字歌词
                          </span>
                          <button
                            onClick={handleWordByWordToggle}
                            className="relative w-12 h-7 rounded-full transition-all duration-300"
                            style={{
                              backgroundColor: wordByWord
                                ? accentColor
                                : playerTheme === 'dark'
                                ? 'rgba(255,255,255,0.15)'
                                : 'rgba(0,0,0,0.15)',
                              boxShadow: wordByWord
                                ? `0 0 12px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                                : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                            }}
                          >
                            <motion.div
                              animate={{ x: wordByWord ? 22 : 2, scale: wordByWord ? 1 : 0.9 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                              className="absolute top-1 w-5 h-5 bg-white rounded-full"
                              style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.2), 0 0 2px rgba(0,0,0,0.1)' }}
                            />
                          </button>
                        </div>

                        {wordByWord && (
                          <div className="flex flex-col gap-2">
                            <span className={`text-xs ${playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'}`}>
                              逐字效果
                            </span>
                            <div className="grid grid-cols-3 gap-2">
                              {([
                                ['clear', '清晰', '精准填充'],
                                ['soft', '柔和', '柔光扩散'],
                                ['apple', 'Apple', '逐词点亮'],
                              ] as const).map(([mode, label, hint]) => (
                                <button
                                  key={mode}
                                  onClick={() => handleWordByWordEffectModeChange(mode)}
                                  className="flex min-h-[48px] flex-col items-center justify-center rounded-lg px-1.5 py-1.5 text-xs font-medium leading-tight transition-all"
                                  style={{
                                    backgroundColor:
                                      wordByWordEffectMode === mode
                                        ? accentColor
                                        : playerTheme === 'dark'
                                        ? 'rgba(255,255,255,0.1)'
                                        : 'rgba(0,0,0,0.1)',
                                    color:
                                      wordByWordEffectMode === mode
                                        ? '#fff'
                                        : playerTheme === 'dark'
                                        ? 'rgba(255,255,255,0.65)'
                                        : 'rgba(0,0,0,0.65)',
                                    boxShadow:
                                      wordByWordEffectMode === mode ? `0 0 8px ${accentColor}30` : 'none',
                                  }}
                                >
                                  <span>{label}</span>
                                  <span
                                    className="mt-0.5 text-[10px] font-normal"
                                    style={{
                                      color: wordByWordEffectMode === mode
                                        ? 'rgba(255,255,255,0.78)'
                                        : playerTheme === 'dark'
                                        ? 'rgba(255,255,255,0.42)'
                                        : 'rgba(0,0,0,0.42)',
                                    }}
                                  >
                                    {hint}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between">
                          <span className={`text-sm ${playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'}`}>
                            歌词高光
                          </span>
                          <button
                            onClick={handleLyricGlowToggle}
                            className="relative w-12 h-7 rounded-full transition-all duration-300"
                            style={{
                              backgroundColor: lyricGlow
                                ? accentColor
                                : playerTheme === 'dark'
                                ? 'rgba(255,255,255,0.15)'
                                : 'rgba(0,0,0,0.15)',
                              boxShadow: lyricGlow
                                ? `0 0 12px ${accentColor}40, inset 0 1px 1px rgba(255,255,255,0.2)`
                                : 'inset 0 1px 2px rgba(0,0,0,0.1)',
                            }}
                          >
                            <motion.div
                              animate={{ x: lyricGlow ? 22 : 2, scale: lyricGlow ? 1 : 0.9 }}
                              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                              className="absolute top-1 w-5 h-5 bg-white rounded-full"
                              style={{ boxShadow: '0 2px 4px rgba(0,0,0,0.2), 0 0 2px rgba(0,0,0,0.1)' }}
                            />
                          </button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
})
