/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Image, Monitor, Upload, Trash2, Video, Check, RotateCcw, RefreshCw, ImageIcon, ChevronRight, ArrowLeft, Clock, LayoutDashboard, CloudSun, LocateFixed, MapPin, Captions, Sparkles, Hourglass, CheckCircle2, CalendarDays, CalendarClock, ListTodo, NotebookPen, Target, History, WandSparkles, ListMusic, Heart, Library, BarChart3, CalendarRange, Radio, AudioLines, Rocket, Cpu, Volume2, Timer, Shuffle, ListOrdered, Settings2 } from 'lucide-react'
import { desktopWallpaperManager, DesktopWallpaperFile, DesktopWallpaperMode, DesktopWallpaperPlayMode, RandomImageSource, DesktopWallpaperSwitchMode } from '../services/desktopWallpaperManager'
import {
  DESKTOP_CUSTOMIZATION_EVENT,
  DesktopCustomizationSettings,
  DesktopWidgetSide,
  DesktopWidgetType,
  loadDesktopCustomization,
  saveDesktopCustomization,
} from '../services/desktopCustomization'
import type {
  WallpaperEngineRotationSettings,
  WallpaperEngineWallpaper,
} from '../services/wallpaperEngineRotation'
import type { LocationOption } from '../services/locationHierarchy'
import { MirroredGlobalSettings, makeSkin } from './MirroredGlobalSettings'
import type { MirrorActionId } from '../services/globalSettingsRegistry'

// 全局设置镜像里的共享弹窗（按需加载，与简约 / 传统 / 探索模式同一组件）
const LazyAudioQualityModal = lazy(() => import('./AudioQualitySettingsModal'))
const LazyCacheClearModal = lazy(() => import('./CacheClearModal'))
const LazyRemoteSettingsModal = lazy(() => import('./RemoteControlSettingsModal'))

interface DesktopSettingsModalProps {
  show: boolean
  onClose: () => void
  weWallpapers: WallpaperEngineWallpaper[]
  weLoading: boolean
  weError: string | null
  selectedWeWallpaper: string | null
  wallpaperSyncEnabled: boolean
  onScanWeWallpapers: () => void
  onSelectWeWallpaper: (wallpaper: WallpaperEngineWallpaper) => void
  wallpaperRotation: WallpaperEngineRotationSettings
  onWallpaperRotationChange: (settings: WallpaperEngineRotationSettings) => void
  onWallpaperSyncToggle: (enabled: boolean) => void
  onOpenCustomizer: () => void
  /** 音质设置弹窗需要的平台登录态（全局设置镜像） */
  neteaseLoggedIn?: boolean
  qqLoggedIn?: boolean
  neteaseVip?: boolean
  qqVip?: boolean
}

type SubmenuType = null | 'customize' | 'wallpaper' | 'wallpaper-engine' | 'global'
type LocationHierarchyModule = typeof import('../services/locationHierarchy')

export default function DesktopSettingsModal({
  show,
  onClose,
  weWallpapers,
  weLoading,
  weError,
  selectedWeWallpaper,
  wallpaperSyncEnabled,
  onScanWeWallpapers,
  onSelectWeWallpaper,
  wallpaperRotation,
  onWallpaperRotationChange,
  onWallpaperSyncToggle,
  onOpenCustomizer,
  neteaseLoggedIn = false,
  qqLoggedIn = false,
  neteaseVip = false,
  qqVip = false,
}: DesktopSettingsModalProps) {
  // 二级菜单状态
  const [activeSubmenu, setActiveSubmenu] = useState<SubmenuType>(null)
  // 全局设置镜像里打开的共享弹窗（音质 / 缓存清理 / 遥控器个性化）
  const [globalModal, setGlobalModal] = useState<MirrorActionId | null>(null)
  // 二级菜单滚动记忆：进子菜单回到顶部，返回主菜单恢复离开时的位置
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const mainMenuScrollTopRef = useRef(0)

  const enterSubmenu = (submenu: Exclude<SubmenuType, null>) => {
    const el = contentScrollRef.current
    if (el) mainMenuScrollTopRef.current = el.scrollTop
    setActiveSubmenu(submenu)
  }

  // 层级切换后的滚动应用：进子菜单 → 顶；返回主菜单 → 恢复。
  // 等 0.2s 退场动画结束后再滚动，避免退场中的旧内容跳位。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = contentScrollRef.current
      if (!el) return
      el.scrollTop = activeSubmenu === null ? mainMenuScrollTopRef.current : 0
    }, 230)
    return () => window.clearTimeout(timer)
  }, [activeSubmenu])

  // 关闭弹窗时回到主菜单（下次打开从主菜单顶部开始）
  useEffect(() => {
    if (!show) {
      setActiveSubmenu(null)
      return
    }
    // 重新打开：从主菜单顶部开始
    const el = contentScrollRef.current
    if (el) el.scrollTop = 0
  }, [show])
  const [desktopCustomization, setDesktopCustomization] = useState<DesktopCustomizationSettings>(() => loadDesktopCustomization())
  const [locationHierarchy, setLocationHierarchy] = useState<LocationHierarchyModule | null>(null)
  
  // 壁纸相关状态
  const [wallpapers, setWallpapers] = useState<DesktopWallpaperFile[]>([])
  const [wallpaperMode, setWallpaperMode] = useState<DesktopWallpaperMode>('single')
  const [playMode, setPlayMode] = useState<DesktopWallpaperPlayMode>('single')
  const [switchMode, setSwitchMode] = useState<DesktopWallpaperSwitchMode>('manual')
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [customInterval, setCustomInterval] = useState('')
  const [showCustomInterval, setShowCustomInterval] = useState(false)
  const [randomImageSource, setRandomImageSource] = useState<RandomImageSource>('bing')
  const [customApiUrl, setCustomApiUrl] = useState('')
  const [showCustomUrlInput, setShowCustomUrlInput] = useState(false)
  const [currentWallpaperIndex, setCurrentWallpaperIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Wallpaper Engine 手动选择的壁纸
  const [selectedWallpaperEngineId, setSelectedWallpaperEngineId] = useState<string | null>(() => {
    const saved = localStorage.getItem('selectedWallpaperEngineId')
    return saved || null
  })

  // 歌单卡片大小
  const [playlistCardSize, setPlaylistCardSize] = useState(() => {
    const saved = localStorage.getItem('desktopPlaylistCardSize')
    return saved || 'medium'
  })
  
  // GPU 加速设置
  const [gpuAcceleration, setGpuAcceleration] = useState(() => {
    const saved = localStorage.getItem('gpuAcceleration')
    return saved !== null ? JSON.parse(saved) : false
  })

  // 启动时从主进程同步真实 GPU 加速状态，避免与设置面板不一致
  useEffect(() => {
    let cancelled = false
    void window.electron?.system.getHardwareAcceleration().then(result => {
      if (cancelled) return
      setGpuAcceleration(result.enabled)
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  
  // 歌词组件模式设置
  const [lyricsComponentMode, setLyricsComponentMode] = useState<'virtualized' | 'standard'>(() => {
    const saved = localStorage.getItem('lyricsComponentMode')
    return (saved as 'virtualized' | 'standard') || 'virtualized'
  })

  // 开发者模式
  const [developerMode, setDeveloperMode] = useState(() => {
    const saved = localStorage.getItem('developerMode')
    return saved !== null ? JSON.parse(saved) : false
  })

  // 全屏模式设置
  const [fullscreenMode, setFullscreenMode] = useState<'kiosk' | 'normal'>(() => {
    const saved = localStorage.getItem('fullscreenMode')
    return (saved as 'kiosk' | 'normal') || 'kiosk'
  })

  // 背景模糊度设置 (0-20)
  const [backgroundBlur, setBackgroundBlur] = useState(() => {
    const saved = localStorage.getItem('desktopBackgroundBlur')
    return saved !== null ? parseInt(saved) : 0
  })

  // 背景暗化度设置 (0-70)，默认保持原始壁纸亮度
  const [backgroundDim, setBackgroundDim] = useState(() => {
    const saved = localStorage.getItem('desktopBackgroundDim')
    return saved !== null ? parseInt(saved) : 0
  })

  // 监听开发者模式变化，实现跨组件同步
  useEffect(() => {
    const handleDeveloperModeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      const enabled = customEvent.detail
      setDeveloperMode(enabled)
    }

    window.addEventListener('developerModeChanged', handleDeveloperModeChange)
    return () => {
      window.removeEventListener('developerModeChanged', handleDeveloperModeChange)
    }
  }, [])



  // 加载壁纸数据
  useEffect(() => {
    if (show) {
      loadWallpaperData()
      const next = loadDesktopCustomization()
      setDesktopCustomization(next)
      setBackgroundBlur(next.backgroundBlur)
      setBackgroundDim(next.backgroundDim)
    }
  }, [show])

  useEffect(() => {
    const handleCustomizationChange = (event: Event) => {
      const next = (event as CustomEvent<DesktopCustomizationSettings>).detail || loadDesktopCustomization()
      setDesktopCustomization(next)
      setBackgroundBlur(next.backgroundBlur)
      setBackgroundDim(next.backgroundDim)
    }
    window.addEventListener(DESKTOP_CUSTOMIZATION_EVENT, handleCustomizationChange)
    return () => window.removeEventListener(DESKTOP_CUSTOMIZATION_EVENT, handleCustomizationChange)
  }, [])

  useEffect(() => {
    if (!show || activeSubmenu !== 'customize' || locationHierarchy) return
    let cancelled = false
    import('../services/locationHierarchy').then(module => {
      if (!cancelled) setLocationHierarchy(module)
    })
    return () => {
      cancelled = true
    }
  }, [activeSubmenu, locationHierarchy, show])

  const weatherCountries = useMemo(
    () => locationHierarchy?.getCountries() || [],
    [locationHierarchy],
  )
  const weatherProvinces = useMemo(
    () => locationHierarchy?.getProvinces(desktopCustomization.weatherCountryCode) || [],
    [desktopCustomization.weatherCountryCode, locationHierarchy],
  )
  const [weatherCities, setWeatherCities] = useState<LocationOption[]>([])
  const [weatherCitiesLoading, setWeatherCitiesLoading] = useState(false)
  // 城市数据懒加载（country-state-city 的 city.json 约 7.9MB，仅非中国地区需要，
  // 通过 dynamic import 按需加载；中国地区直接用本地 china-area-data）。
  useEffect(() => {
    let cancelled = false
    const countryCode = desktopCustomization.weatherCountryCode
    const provinceCode = desktopCustomization.weatherProvinceCode
    if (!countryCode || !provinceCode || !locationHierarchy) {
      setWeatherCities([])
      setWeatherCitiesLoading(false)
      return
    }
    setWeatherCitiesLoading(true)
    void locationHierarchy.getCities(countryCode, provinceCode).then(cities => {
      if (cancelled) return
      setWeatherCities(cities)
      setWeatherCitiesLoading(false)
    }).catch(() => {
      if (cancelled) return
      setWeatherCities([])
      setWeatherCitiesLoading(false)
    })
    return () => { cancelled = true }
  }, [desktopCustomization.weatherCountryCode, desktopCustomization.weatherProvinceCode, locationHierarchy])
  const weatherDistricts = useMemo(
    () => locationHierarchy?.getDistricts(
      desktopCustomization.weatherCountryCode,
      desktopCustomization.weatherProvinceCode,
      desktopCustomization.weatherCityCode,
    ) || [],
    [
      desktopCustomization.weatherCityCode,
      desktopCustomization.weatherCountryCode,
      desktopCustomization.weatherProvinceCode,
      locationHierarchy,
    ],
  )

  const updateDesktopCustomization = (next: DesktopCustomizationSettings) => {
    setDesktopCustomization(next)
    saveDesktopCustomization(next)
  }

  const toggleDesktopWidget = (side: DesktopWidgetSide, widget: DesktopWidgetType) => {
    const currentWidgets = desktopCustomization[side]
    const nextWidgets = currentWidgets.includes(widget)
      ? currentWidgets.filter(item => item !== widget)
      : [...currentWidgets, widget]
    updateDesktopCustomization({ ...desktopCustomization, [side]: nextWidgets })
  }

  const loadWallpaperData = async () => {
    const files = await desktopWallpaperManager.getWallpapers()
    const settings = desktopWallpaperManager.getSettings()
    
    setWallpapers(files)
    setWallpaperMode(settings.mode)
    setPlayMode(settings.playMode || 'single')
    setSwitchMode(settings.switchMode || 'manual')
    setIntervalMinutes(settings.intervalMinutes || 30)
    setRandomImageSource(settings.randomImageSource)
    setCustomApiUrl(settings.customApiUrl)
    setCurrentWallpaperIndex(settings.currentIndex)
  }

  // 处理文件上传
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    setError('')

    const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB in bytes

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      
      // 提前检查文件大小
      if (file.size > MAX_FILE_SIZE) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(2)
        setError(`文件 "${file.name}" 大小为 ${sizeMB}MB，超过了 1GB 的限制`)
        setUploading(false)
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
        return
      }

      const result = await desktopWallpaperManager.addWallpaper(file)
      
      if (!result.success) {
        setError(result.error || '上传失败')
        break
      }
    }

    setUploading(false)
    await loadWallpaperData()
    
    // 标记用户选择了自定义上传壁纸
    desktopWallpaperManager.saveSettings({ 
      mode: 'single',
      lastWallpaperSource: 'custom-upload'
    })
    
    // 触发壁纸变化事件
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
    
    // 清空 input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // 删除壁纸
  const handleDeleteWallpaper = async (id: string) => {
    await desktopWallpaperManager.removeWallpaper(id)
    await loadWallpaperData()
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 选择壁纸
  const handleSelectWallpaper = async (index: number) => {
    await desktopWallpaperManager.setCurrentWallpaper(index)
    setCurrentWallpaperIndex(index)
    // 标记用户选择了自定义上传壁纸
    desktopWallpaperManager.saveSettings({ 
      mode: 'single',
      lastWallpaperSource: 'custom-upload'
    })
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 保存壁纸模式
  const handleWallpaperModeChange = (mode: DesktopWallpaperMode) => {
    setWallpaperMode(mode)
    desktopWallpaperManager.saveSettings({ mode })
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 保存随机图片源
  const handleRandomImageSourceChange = (source: RandomImageSource) => {
    setRandomImageSource(source)
    if (source === 'custom') {
      setShowCustomUrlInput(true)
    } else {
      setShowCustomUrlInput(false)
    }
    // 切换到随机 API 模式，并记录用户选择了随机 API
    desktopWallpaperManager.saveSettings({ 
      randomImageSource: source,
      mode: 'random-api',
      lastWallpaperSource: 'random-api'
    })
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 保存自定义API URL
  const handleSaveCustomUrl = () => {
    desktopWallpaperManager.saveSettings({ 
      customApiUrl,
      mode: 'random-api',
      lastWallpaperSource: 'random-api'
    })
    setShowCustomUrlInput(false)
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 保存播放模式
  const handlePlayModeChange = (mode: DesktopWallpaperPlayMode) => {
    setPlayMode(mode)
    desktopWallpaperManager.saveSettings({ playMode: mode })
    // 重新启动自动切换
    desktopWallpaperManager.startAutoSwitch()
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  // 保存切换模式
  const handleSwitchModeChange = (mode: DesktopWallpaperSwitchMode) => {
    setSwitchMode(mode)
    desktopWallpaperManager.saveSettings({ switchMode: mode })
    // 重新启动自动切换
    desktopWallpaperManager.startAutoSwitch()
  }

  // 保存切换间隔
  const handleIntervalChange = (minutes: number) => {
    setIntervalMinutes(minutes)
    desktopWallpaperManager.saveSettings({ intervalMinutes: minutes })
    // 重新启动自动切换
    desktopWallpaperManager.startAutoSwitch()
  }

  // 保存自定义间隔
  const handleSaveCustomInterval = () => {
    const minutes = parseInt(customInterval)
    if (minutes > 0) {
      handleIntervalChange(minutes)
      setShowCustomInterval(false)
      setCustomInterval('')
    }
  }

  // 重置为默认壁纸
  const handleResetToDefault = async () => {
    await desktopWallpaperManager.resetToDefault()
    await loadWallpaperData()
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  const canUploadMore = wallpapers.length < 6

  // 保存 Wallpaper Engine 联动设置
  const handleWallpaperSyncToggle = (enabled: boolean) => {
    onWallpaperSyncToggle(enabled)
  }

  // 立即同步：主进程对系统壁纸的检测是 10 秒轮询（见 desktop/main.cjs），
  // 这里主动向主进程查询一次最新壁纸并触发前端刷新，免去等待下一次轮询。
  const [syncNowLoading, setSyncNowLoading] = useState(false)
  const handleWallpaperSyncNow = async () => {
    setSyncNowLoading(true)
    try {
      await desktopWallpaperManager.getCurrentWallpaper()
      window.dispatchEvent(new Event('desktopWallpaperChanged'))
    } catch (error) {
      console.error('立即同步壁纸失败:', error)
    } finally {
      setSyncNowLoading(false)
    }
  }

  // 保存歌单卡片大小
  const handleCardSizeChange = (size: string) => {
    setPlaylistCardSize(size)
    localStorage.setItem('desktopPlaylistCardSize', size)
    window.dispatchEvent(new CustomEvent('desktopPlaylistCardSizeChanged', { detail: size }))
  }
  
  // GPU 加速开关处理（与主进程同步，重启后生效）
  const handleGpuAccelerationToggle = async (enabled: boolean) => {
    try {
      const result = await window.electron?.system.setHardwareAcceleration(enabled)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuAcceleration(result.enabled)
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
      window.dispatchEvent(new CustomEvent('gpuAccelerationChanged', { detail: result.enabled }))
      const message = result.enabled ? 'GPU加速已打开，重启软件以生效' : 'GPU加速已关闭，重启软件以生效'
      window.dispatchEvent(new CustomEvent('showToast', { 
        detail: { message, type: 'info' }
      }))
    } catch (error) {
      console.error('保存 GPU 加速设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', { 
        detail: { message: 'GPU 加速设置保存失败', type: 'error' }
      }))
    }
  }
  
  // 歌词组件模式切换处理
  const handleLyricsComponentModeChange = (mode: 'virtualized' | 'standard') => {
    setLyricsComponentMode(mode)
    localStorage.setItem('lyricsComponentMode', mode)
    window.dispatchEvent(new CustomEvent('lyricsComponentModeChanged', { detail: mode }))
  }

  // 开发者模式切换处理
  const handleDeveloperModeToggle = (enabled: boolean) => {
    setDeveloperMode(enabled)
    localStorage.setItem('developerMode', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('developerModeChanged', { detail: enabled }))
    
    // 通知 Electron 后端
    if (window.electron?.developerMode) {
      window.electron.developerMode.set(enabled).catch((err: Error) => {
        console.error('Failed to set developer mode:', err)
      })
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '开发者模式已启用' : '开发者模式已禁用', type: 'info' }
    }))
  }

  // 全屏模式切换处理
  const handleFullscreenModeChange = async (mode: 'kiosk' | 'normal') => {
    setFullscreenMode(mode)
    localStorage.setItem('fullscreenMode', mode)
    window.dispatchEvent(new CustomEvent('fullscreenModeChanged', { detail: mode }))
    
    // 如果当前已经是全屏状态，立即应用新的全屏模式
    if (window.electron?.system?.isFullscreen) {
      const status = await window.electron.system.isFullscreen()
      if (status.fullscreen || status.kiosk) {
        // 先退出全屏
        await window.electron.system.setFullscreen(false, false)
        // 再使用新的模式进入全屏
        await window.electron.system.setFullscreen(true, mode === 'kiosk')
        
        window.dispatchEvent(new CustomEvent('showToast', { 
          detail: { 
            message: mode === 'kiosk' ? '已切换到全屏模式（覆盖任务栏）' : '已切换到全屏无边框模式（保留任务栏）', 
            type: 'success' 
          }
        }))
      }
    }
  }

  // 背景模糊度切换处理
  const handleBackgroundBlurChange = (blur: number) => {
    setBackgroundBlur(blur)
    updateDesktopCustomization({ ...desktopCustomization, backgroundBlur: blur })
  }

  const handleBackgroundDimChange = (dim: number) => {
    setBackgroundDim(dim)
    updateDesktopCustomization({ ...desktopCustomization, backgroundDim: dim })
  }

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[200]"
          />

          {/* 设置弹窗 */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[672px] z-[201]"
          >
            {/* 玻璃态卡片 */}
            <div 
              className="mx-4 rounded-3xl overflow-hidden shadow-2xl"
              style={{
                background: 'linear-gradient(135deg, rgba(0,0,0,0.85) 0%, rgba(15,15,25,0.9) 50%, rgba(0,0,0,0.85) 100%)',
                backdropFilter: 'blur(20px) saturate(170%)',
                WebkitBackdropFilter: 'blur(20px) saturate(170%)',
                border: '1px solid rgba(255,255,255,0.1)',
              }}
            >
              {/* 头部 */}
              <div className="flex items-center justify-between p-6 border-b border-white/10">
                {activeSubmenu ? (
                  <>
                    <button
                      onClick={() => setActiveSubmenu(null)}
                      className="flex items-center gap-2 text-white/60 hover:text-white transition-colors"
                    >
                      <ArrowLeft className="w-5 h-5" />
                      <span>返回</span>
                    </button>
                    <h2 className="text-2xl font-bold text-white">
                      {activeSubmenu === 'customize' && '自定义桌面'}
                      {activeSubmenu === 'wallpaper' && '自定义壁纸'}
                      {activeSubmenu === 'wallpaper-engine' && 'WallpaperEngine'}
                      {activeSubmenu === 'global' && '全局设置'}
                    </h2>
                  </>
                ) : (
                  <h2 className="text-2xl font-bold text-white">桌面模式设置</h2>
                )}
                <button
                  onClick={onClose}
                  className="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 transition-all flex items-center justify-center"
                >
                  <X className="w-5 h-5 text-white" />
                </button>
              </div>

              {/* 内容区域 */}
              <div ref={contentScrollRef} className="p-6 space-y-6 max-h-[60vh] overflow-y-auto custom-scrollbar">
                <AnimatePresence mode="wait" initial={false}>
                  {!activeSubmenu ? (
                    // 一级菜单
                    <motion.div
                      key="main-menu"
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 20 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-6"
                    >
                      <button
                        onClick={() => {
                          onClose()
                          onOpenCustomizer()
                        }}
                        className="w-full bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all text-left"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-cyan-500/20 flex items-center justify-center">
                              <LayoutDashboard className="w-5 h-5 text-cyan-300" />
                            </div>
                            <div>
                              <h3 className="text-lg font-semibold text-white">自定义桌面</h3>
                              <p className="text-white/60 text-sm">进入桌面预览，拖放元素到显示位置</p>
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-white/40" />
                        </div>
                      </button>

                      {/* 自定义壁纸卡片 */}
                      <button
                        onClick={() => enterSubmenu('wallpaper')}
                        className="w-full bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all text-left"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-pink-500/20 flex items-center justify-center">
                              <ImageIcon className="w-5 h-5 text-pink-400" />
                            </div>
                            <div>
                              <h3 className="text-lg font-semibold text-white">自定义壁纸</h3>
                              <p className="text-white/60 text-sm">上传图片、随机壁纸</p>
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-white/40" />
                        </div>
                      </button>

                      {/* Wallpaper Engine 联动 */}
                      <div>
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center">
                            <Monitor className="w-5 h-5 text-purple-400" />
                          </div>
                          <h3 className="text-lg font-semibold text-white">壁纸联动</h3>
                        </div>
                        
                        <div className="mb-3 bg-white/5 rounded-xl p-4 border border-white/10">
                          <div className="flex items-center justify-between">
                            <div>
                              <div className="text-white font-medium mb-1">Wallpaper Engine 同步</div>
                              <div className="text-white/60 text-sm">
                                自动同步 Wallpaper Engine 的桌面壁纸作为背景
                              </div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={wallpaperSyncEnabled}
                                onChange={(e) => handleWallpaperSyncToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 bg-white/20 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: wallpaperSyncEnabled ? '#8b5cf6' : '' }}></div>
                            </label>
                          </div>
                          {wallpaperSyncEnabled && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              className="mt-4 pt-4 border-t border-white/10"
                            >
                              <p className="text-white/40 text-xs">
                                同步当前主屏WallpaperEngine壁纸（功能性壁纸无法同步）
                                <br />
                                无法同步将默认使用Windows壁纸
                                <br />
                                壁纸检测为主进程 10 秒轮询，非实时；可点击下方按钮立即同步
                              </p>
                              <button
                                type="button"
                                onClick={handleWallpaperSyncNow}
                                disabled={syncNowLoading}
                                className="mt-3 inline-flex items-center gap-2 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 disabled:opacity-45 px-3 py-2 text-xs text-purple-200 transition-colors"
                              >
                                <RefreshCw className={`w-4 h-4 ${syncNowLoading ? 'animate-spin' : ''}`} />
                                {syncNowLoading ? '同步中…' : '立即同步'}
                              </button>
                            </motion.div>
                          )}
                        </div>
                      </div>

                      {/* WallpaperEngine 卡片 */}
                      <button
                        onClick={() => enterSubmenu('wallpaper-engine')}
                        className="w-full bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all text-left"
                        disabled={wallpaperSyncEnabled}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-indigo-500/20 flex items-center justify-center">
                              <Monitor className="w-5 h-5 text-indigo-400" />
                            </div>
                            <div>
                              <h3 className="text-lg font-semibold text-white">浏览壁纸引擎</h3>
                              <p className="text-white/60 text-sm">
                                {wallpaperSyncEnabled 
                                  ? '请先关闭同步功能' 
                                  : selectedWallpaperEngineId 
                                    ? '已选择壁纸' 
                                    : '将壁纸引擎中壁纸手动加载至桌面模式'}
                              </p>
                            </div>
                          </div>
                          <ChevronRight className={`w-5 h-5 ${wallpaperSyncEnabled ? 'text-white/20' : 'text-white/40'}`} />
                        </div>
                      </button>

                      {/* 歌单显示设置 */}
                      <div>
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center">
                            <Image className="w-5 h-5 text-blue-400" />
                          </div>
                          <h3 className="text-lg font-semibold text-white">歌单显示</h3>
                        </div>
                        
                        {/* 卡片大小 */}
                        <div className="bg-white/5 rounded-xl p-4 border border-white/10 mb-3">
                          <div className="mb-3">
                            <div className="text-white font-medium mb-1">歌单卡片大小</div>
                            <div className="text-white/60 text-sm">调整歌单封面的显示大小</div>
                          </div>
                          
                          <div className="grid grid-cols-3 gap-3">
                            {[
                              { value: 'small', label: '小', size: '160px' },
                              { value: 'medium', label: '中', size: '200px' },
                              { value: 'large', label: '大', size: '240px' },
                            ].map((option) => (
                              <button
                                key={option.value}
                                onClick={() => handleCardSizeChange(option.value)}
                                className={`p-3 rounded-lg transition-all border-2`}
                                style={{
                                  borderColor: playlistCardSize === option.value ? '#3b82f6' : 'transparent',
                                  backgroundColor: playlistCardSize === option.value 
                                    ? 'rgba(59,130,246,0.2)'
                                    : 'rgba(255,255,255,0.05)'
                                }}
                              >
                                <div className="text-white font-medium text-sm">{option.label}</div>
                                <div className="text-white/40 text-xs mt-1">{option.size}</div>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* 性能优化和歌词设置 */}
                      <div>
                        <div className="flex items-center gap-3 mb-3">
                          <div className="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center">
                            <Monitor className="w-5 h-5 text-green-400" />
                          </div>
                          <h3 className="text-lg font-semibold text-white">高级设置</h3>
                        </div>
                        
                        {/* 全屏窗口模式 */}
                        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                          <div className="mb-3">
                            <div className="text-white font-medium mb-1">全屏化窗口模式</div>
                            <div className="text-white/60 text-sm">选择全屏时的窗口行为</div>
                          </div>
                          
                          <div className="space-y-3">
                            <button
                              onClick={() => handleFullscreenModeChange('kiosk')}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all border-2`}
                              style={{
                                borderColor: fullscreenMode === 'kiosk' ? '#3b82f6' : 'transparent',
                                backgroundColor: fullscreenMode === 'kiosk' 
                                  ? 'rgba(59,130,246,0.2)'
                                  : 'rgba(255,255,255,0.05)'
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0`}
                                style={{
                                  borderColor: fullscreenMode === 'kiosk' ? '#3b82f6' : 'rgba(255,255,255,0.4)',
                                  backgroundColor: fullscreenMode === 'kiosk' ? '#3b82f6' : 'transparent'
                                }}
                              >
                                {fullscreenMode === 'kiosk' && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className="text-white text-sm font-medium">全屏</div>
                                <div className="text-white/40 text-xs">覆盖整个屏幕包括任务栏（推荐）</div>
                              </div>
                            </button>
                            
                            <button
                              onClick={() => handleFullscreenModeChange('normal')}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all border-2`}
                              style={{
                                borderColor: fullscreenMode === 'normal' ? '#3b82f6' : 'transparent',
                                backgroundColor: fullscreenMode === 'normal' 
                                  ? 'rgba(59,130,246,0.2)'
                                  : 'rgba(255,255,255,0.05)'
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0`}
                                style={{
                                  borderColor: fullscreenMode === 'normal' ? '#3b82f6' : 'rgba(255,255,255,0.4)',
                                  backgroundColor: fullscreenMode === 'normal' ? '#3b82f6' : 'transparent'
                                }}
                              >
                                {fullscreenMode === 'normal' && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className="text-white text-sm font-medium">全屏无边框</div>
                                <div className="text-white/40 text-xs">保留系统任务栏</div>
                              </div>
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* 全局设置入口（镜像简约模式的总设置，见 globalSettingsRegistry） */}
                      <button
                        onClick={() => enterSubmenu('global')}
                        className="w-full bg-white/5 hover:bg-white/10 rounded-xl p-4 border border-white/10 transition-all text-left"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-violet-500/20 flex items-center justify-center">
                              <Settings2 className="w-5 h-5 text-violet-300" />
                            </div>
                            <div>
                              <h3 className="text-lg font-semibold text-white">全局设置</h3>
                              <p className="text-white/60 text-sm">播放 / 歌词 / 快捷键 / 性能等整软件开关，与简约模式实时同步</p>
                            </div>
                          </div>
                          <ChevronRight className="w-5 h-5 text-white/40" />
                        </div>
                      </button>
                    </motion.div>
                  ) : activeSubmenu === 'customize' ? (
                    <motion.div
                      key="customize-submenu"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-5"
                    >
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <p className="text-sm leading-6 text-white/60">
                          左右区域默认保持空白，可自由添加元素。超出屏幕高度后可直接在对应区域滚动。
                        </p>
                      </div>

                      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                        <div className="mb-4 flex items-center gap-3">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/20">
                            <Captions className="h-5 w-5 text-violet-300" />
                          </div>
                          <div>
                            <div className="font-semibold text-white">桌面歌词样式</div>
                            <div className="mt-1 text-xs text-white/40">歌词会自动避开 mini 播放器和左右组件</div>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                          {([
                            { value: 'traditional' as const, label: '传统', description: '居中滚动，保留上下文歌词', icon: Captions },
                            { value: 'modern' as const, label: '现代', description: '播放页沉浸式单行歌词动效', icon: Sparkles },
                          ]).map(option => {
                            const selected = desktopCustomization.desktopLyricStyle === option.value
                            const Icon = option.icon
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => updateDesktopCustomization({ ...desktopCustomization, desktopLyricStyle: option.value })}
                                className="relative overflow-hidden rounded-xl border p-4 text-left transition-all"
                                style={{
                                  borderColor: selected ? 'rgba(167,139,250,0.72)' : 'rgba(255,255,255,0.08)',
                                  background: selected
                                    ? 'linear-gradient(135deg, rgba(124,58,237,0.28), rgba(76,29,149,0.12))'
                                    : 'rgba(255,255,255,0.035)',
                                }}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <Icon className="h-5 w-5 text-violet-200" />
                                  <div
                                    className="flex h-5 w-5 items-center justify-center rounded-full border"
                                    style={{
                                      borderColor: selected ? '#a78bfa' : 'rgba(255,255,255,0.3)',
                                      background: selected ? '#8b5cf6' : 'transparent',
                                    }}
                                  >
                                    {selected && <Check className="h-3.5 w-3.5 text-white" />}
                                  </div>
                                </div>
                                <div className="mt-4 font-medium text-white">{option.label}</div>
                                <div className="mt-1 text-xs leading-5 text-white/42">{option.description}</div>
                              </button>
                            )
                          })}
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        {(['left', 'right'] as DesktopWidgetSide[]).map(side => (
                          <div key={side} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                            <div className="mb-4 flex items-center justify-between">
                              <div>
                                <div className="font-semibold text-white">{side === 'left' ? '左侧区域' : '右侧区域'}</div>
                                <div className="mt-1 text-xs text-white/40">可同时加入多个元素</div>
                              </div>
                              <div className={`h-8 w-12 rounded-lg border border-white/15 ${side === 'left' ? 'bg-gradient-to-r from-cyan-400/35 to-white/5' : 'bg-gradient-to-l from-cyan-400/35 to-white/5'}`} />
                            </div>

                            <div className="space-y-2">
                              {([
                                { type: 'datetime' as const, label: '时间日期', description: '大号时间与当天日期', icon: Clock },
                                { type: 'weather' as const, label: '天气', description: '城市实时天气与风速', icon: CloudSun },
                                { type: 'dayProgress' as const, label: '今日进度', description: '今日与今年的进度读数', icon: Hourglass },
                                { type: 'calendar' as const, label: '完整日历', description: '月历、农历与特殊节日', icon: CalendarDays },
                                { type: 'notes' as const, label: '便签清单', description: '待办、完成状态与优先级', icon: ListTodo },
                                { type: 'memo' as const, label: '备忘录', description: '独立记录灵感与提醒', icon: NotebookPen },
                                { type: 'habits' as const, label: '习惯打卡', description: '每天坚持的小习惯', icon: Target },
                                { type: 'countdown' as const, label: '重要日倒数', description: '纪念日与截止日期', icon: CalendarClock },
                                { type: 'recentlyPlayed' as const, label: '最近播放', description: '快速回到最近歌曲', icon: History },
                                { type: 'dailyRecommendations' as const, label: '每日推荐', description: '个性化推荐与换一批', icon: WandSparkles },
                                { type: 'playQueue' as const, label: '播放队列', description: '查看当前播放顺序', icon: ListMusic },
                                { type: 'favoriteSongs' as const, label: '收藏速览', description: '我喜欢的音乐', icon: Heart },
                                { type: 'playlistShortcuts' as const, label: '歌单快捷入口', description: '固定常用歌单', icon: Library },
                                { type: 'listeningStats' as const, label: '听歌统计', description: '今日、本周与常听歌手', icon: BarChart3 },
                                { type: 'musicCalendar' as const, label: '音乐日历', description: '每日听歌热力图', icon: CalendarRange },
                                { type: 'artistUpdates' as const, label: '歌手动态', description: '近期常听歌手入口', icon: Radio },
                                { type: 'spectrum' as const, label: '音频频谱', description: '当前音乐实时律动', icon: AudioLines },
                                { type: 'quickLauncher' as const, label: '快捷启动器', description: '应用、文件夹与网页', icon: Rocket },
                                { type: 'systemStatus' as const, label: '系统状态', description: 'CPU、内存与磁盘', icon: Cpu },
                                { type: 'volumeControl' as const, label: '音量控制', description: 'WaveForge 输出音量', icon: Volume2 },
                              ]).map(option => {
                                const selected = desktopCustomization[side].includes(option.type)
                                const Icon = option.icon
                                return (
                                  <button
                                    key={option.type}
                                    type="button"
                                    onClick={() => toggleDesktopWidget(side, option.type)}
                                    className="flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all"
                                    style={{
                                      borderColor: selected ? 'rgba(34,211,238,0.65)' : 'rgba(255,255,255,0.08)',
                                      background: selected ? 'rgba(34,211,238,0.14)' : 'rgba(255,255,255,0.035)',
                                    }}
                                  >
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/10">
                                      <Icon className="h-4.5 w-4.5 text-white/80" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                      <div className="text-sm font-medium text-white">{option.label}</div>
                                      <div className="truncate text-xs text-white/40">{option.description}</div>
                                    </div>
                                    <div
                                      className="flex h-5 w-5 items-center justify-center rounded-full border"
                                      style={{
                                        borderColor: selected ? '#22d3ee' : 'rgba(255,255,255,0.3)',
                                        background: selected ? '#22d3ee' : 'transparent',
                                      }}
                                    >
                                      {selected && <Check className="h-3.5 w-3.5 text-slate-950" />}
                                    </div>
                                  </button>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>

                      {(desktopCustomization.left.includes('weather') || desktopCustomization.right.includes('weather')) && (
                        <motion.div
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="rounded-2xl border border-white/10 bg-white/5 p-4"
                        >
                          <div className="mb-3 flex items-center gap-2 text-sm font-medium text-white">
                            <CloudSun className="h-4 w-4 text-cyan-300" />
                            天气位置
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <button
                              type="button"
                              onClick={() => updateDesktopCustomization({ ...desktopCustomization, weatherLocationMode: 'auto' })}
                              className="flex items-center gap-3 rounded-xl border p-3 text-left transition-all"
                              style={{
                                borderColor: desktopCustomization.weatherLocationMode === 'auto' ? 'rgba(34,211,238,0.65)' : 'rgba(255,255,255,0.08)',
                                background: desktopCustomization.weatherLocationMode === 'auto' ? 'rgba(34,211,238,0.14)' : 'rgba(255,255,255,0.035)',
                              }}
                            >
                              <LocateFixed className="h-5 w-5 text-cyan-300" />
                              <div>
                                <div className="text-sm font-medium text-white">自动定位</div>
                                <div className="mt-0.5 text-xs text-white/40">依据公网 IP 定位到区县</div>
                              </div>
                            </button>
                            <button
                              type="button"
                              onClick={() => updateDesktopCustomization({ ...desktopCustomization, weatherLocationMode: 'manual' })}
                              className="flex items-center gap-3 rounded-xl border p-3 text-left transition-all"
                              style={{
                                borderColor: desktopCustomization.weatherLocationMode === 'manual' ? 'rgba(34,211,238,0.65)' : 'rgba(255,255,255,0.08)',
                                background: desktopCustomization.weatherLocationMode === 'manual' ? 'rgba(34,211,238,0.14)' : 'rgba(255,255,255,0.035)',
                              }}
                            >
                              <MapPin className="h-5 w-5 text-cyan-300" />
                              <div>
                                <div className="text-sm font-medium text-white">手动地区</div>
                                <div className="mt-0.5 text-xs text-white/40">国家、省、市、区县级联选择</div>
                              </div>
                            </button>
                          </div>

                          {desktopCustomization.weatherLocationMode === 'manual' ? (
                            <motion.div
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              className="mt-3 grid grid-cols-2 gap-2"
                            >
                              <label className="space-y-1.5">
                                <span className="px-1 text-[11px] text-white/40">国家或地区</span>
                                <select
                                  value={desktopCustomization.weatherCountryCode}
                                  disabled={!locationHierarchy}
                                  onChange={event => {
                                    const option = weatherCountries.find(item => item.code === event.target.value)
                                    updateDesktopCustomization({
                                      ...desktopCustomization,
                                      weatherCountryCode: event.target.value,
                                      weatherCountry: option?.name || '',
                                      weatherProvinceCode: '',
                                      weatherProvince: '',
                                      weatherCityCode: '',
                                      weatherCity: '',
                                      weatherDistrictCode: '',
                                      weatherDistrict: '',
                                      weatherLatitude: null,
                                      weatherLongitude: null,
                                    })
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60 disabled:opacity-45"
                                >
                                  {!locationHierarchy && <option>正在加载地区数据…</option>}
                                  {weatherCountries.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}
                                </select>
                              </label>

                              <label className="space-y-1.5">
                                <span className="px-1 text-[11px] text-white/40">省 / 直辖市 / 州</span>
                                <select
                                  value={desktopCustomization.weatherProvinceCode}
                                  disabled={!desktopCustomization.weatherCountryCode || weatherProvinces.length === 0}
                                  onChange={event => {
                                    const option = weatherProvinces.find(item => item.code === event.target.value)
                                    updateDesktopCustomization({
                                      ...desktopCustomization,
                                      weatherProvinceCode: event.target.value,
                                      weatherProvince: option?.name || '',
                                      weatherCityCode: '',
                                      weatherCity: '',
                                      weatherDistrictCode: '',
                                      weatherDistrict: '',
                                      weatherLatitude: null,
                                      weatherLongitude: null,
                                    })
                                  }}
                                  className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60 disabled:opacity-45"
                                >
                                  <option value="">请选择</option>
                                  {weatherProvinces.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}
                                </select>
                              </label>

                              <label className="space-y-1.5">
                                <span className="px-1 text-[11px] text-white/40">市 / 地区</span>
                                  <select
                                    value={desktopCustomization.weatherCityCode}
                                    disabled={!desktopCustomization.weatherProvinceCode || (weatherCities.length === 0 && !weatherCitiesLoading)}
                                    onChange={event => {
                                      const option = weatherCities.find(item => item.code === event.target.value)
                                      updateDesktopCustomization({
                                        ...desktopCustomization,
                                        weatherCityCode: event.target.value,
                                        weatherCity: option?.name || '',
                                        weatherDistrictCode: '',
                                        weatherDistrict: '',
                                        weatherLatitude: null,
                                        weatherLongitude: null,
                                      })
                                    }}
                                    className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60 disabled:opacity-45"
                                  >
                                    {weatherCitiesLoading
                                      ? <option>正在加载城市数据…</option>
                                      : <option value="">请选择</option>}
                                    {weatherCities.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}
                                  </select>
                              </label>

                              <label className="space-y-1.5">
                                <span className="px-1 text-[11px] text-white/40">区 / 县 / 县级市</span>
                                {desktopCustomization.weatherCountryCode === 'CN' ? (
                                  <select
                                    value={desktopCustomization.weatherDistrictCode}
                                    disabled={!desktopCustomization.weatherCityCode || weatherDistricts.length === 0}
                                    onChange={event => {
                                      const option = weatherDistricts.find(item => item.code === event.target.value)
                                      updateDesktopCustomization({
                                        ...desktopCustomization,
                                        weatherDistrictCode: event.target.value,
                                        weatherDistrict: option?.name || '',
                                        weatherLatitude: null,
                                        weatherLongitude: null,
                                      })
                                    }}
                                    className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60 disabled:opacity-45"
                                  >
                                    <option value="">请选择</option>
                                    {weatherDistricts.map(option => <option key={option.code} value={option.code}>{option.name}</option>)}
                                  </select>
                                ) : (
                                  <input
                                    value={desktopCustomization.weatherDistrict}
                                    disabled={!desktopCustomization.weatherCityCode}
                                    onChange={event => setDesktopCustomization({
                                      ...desktopCustomization,
                                      weatherDistrictCode: '',
                                      weatherDistrict: event.target.value,
                                      weatherLatitude: null,
                                      weatherLongitude: null,
                                    })}
                                    onBlur={() => saveDesktopCustomization(desktopCustomization)}
                                    placeholder="输入当地行政区（可选）"
                                    className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/25 focus:border-cyan-400/60 disabled:opacity-45"
                                  />
                                )}
                              </label>

                              <div className="col-span-2 rounded-xl bg-white/[0.04] px-3 py-2 text-xs text-white/45">
                                {desktopCustomization.weatherDistrict
                                  ? `当前天气位置：${[desktopCustomization.weatherCountry, desktopCustomization.weatherProvince, desktopCustomization.weatherCity, desktopCustomization.weatherDistrict].filter(Boolean).join(' · ')}`
                                  : '选择到区、县或县级市后，将使用该行政区中心坐标获取天气。'}
                              </div>
                            </motion.div>
                          ) : (
                            <div className="mt-3 rounded-xl bg-cyan-400/[0.07] px-4 py-3 text-xs leading-5 text-white/50">
                              自动定位会先获取网络出口坐标，再通过反向地理编码细化到区、县或县级市；使用代理或 VPN 时，位置可能随网络出口变化。
                            </div>
                          )}
                          <p className="mt-2 text-xs text-white/35">天气组件每 15 分钟刷新；点击桌面天气卡片可查看小时与 10 日预报。</p>
                        </motion.div>
                      )}
                    </motion.div>
                  ) : activeSubmenu === 'wallpaper' ? (
                    // 壁纸二级菜单
                    <motion.div
                      key="wallpaper-submenu"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-6"
                    >
                      {/* 壁纸模式选择 */}
                      <div>
                        <div className="text-white font-medium mb-3">壁纸模式</div>
                        <div className="grid grid-cols-2 gap-3">
                          <button
                            onClick={() => handleWallpaperModeChange('single')}
                            className={`p-4 rounded-xl transition-all border-2 text-left`}
                            style={{
                              borderColor: wallpaperMode === 'single' ? '#ec4899' : 'transparent',
                              backgroundColor: wallpaperMode === 'single' 
                                ? 'rgba(236,72,153,0.2)'
                                : 'rgba(255,255,255,0.05)'
                            }}
                          >
                            <div className="text-white font-medium">上传壁纸</div>
                            <div className="text-white/60 text-sm mt-1">自定义图片或视频</div>
                          </button>
                          <button
                            onClick={() => handleWallpaperModeChange('random-api')}
                            className={`p-4 rounded-xl transition-all border-2 text-left`}
                            style={{
                              borderColor: wallpaperMode === 'random-api' ? '#ec4899' : 'transparent',
                              backgroundColor: wallpaperMode === 'random-api' 
                                ? 'rgba(236,72,153,0.2)'
                                : 'rgba(255,255,255,0.05)'
                            }}
                          >
                            <div className="text-white font-medium">随机图片</div>
                            <div className="text-white/60 text-sm mt-1">在线图片源</div>
                          </button>
                        </div>
                      </div>

                      {/* 上传壁纸模式 */}
                      {wallpaperMode === 'single' && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="space-y-4"
                        >
                          {/* 上传区域 */}
                          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                            <div className="flex items-center justify-between mb-3">
                              <div className="text-white font-medium">
                                壁纸文件 ({wallpapers.length}/6)
                              </div>
                              {canUploadMore && (
                                <button
                                  onClick={() => fileInputRef.current?.click()}
                                  disabled={uploading}
                                  className="px-4 py-2 rounded-lg bg-pink-500 hover:bg-pink-600 transition-all text-white font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {uploading ? '上传中...' : '上传'}
                                </button>
                              )}
                            </div>

                            {/* 隐藏的文件输入 */}
                            <input
                              ref={fileInputRef}
                              type="file"
                              accept="image/*,video/*"
                              multiple
                              onChange={handleFileSelect}
                              className="hidden"
                            />

                            {/* 错误提示 */}
                            {error && (
                              <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-200 text-sm"
                              >
                                {error}
                              </motion.div>
                            )}

                            {/* 提示信息 */}
                            <div className="text-white/40 text-xs">
                              支持图片和视频，最多12个文件，单个不超过1GB
                            </div>

                            {/* 壁纸列表 */}
                            {wallpapers.length > 0 && (
                              <div className="grid grid-cols-2 gap-3 mt-3">
                                {wallpapers.map((wallpaper, index) => (
                                  <div
                                    key={wallpaper.id}
                                    className={`relative rounded-lg overflow-hidden border-2 transition-all cursor-pointer`}
                                    style={{
                                      borderColor: currentWallpaperIndex === index ? '#ec4899' : 'transparent'
                                    }}
                                    onClick={() => handleSelectWallpaper(index)}
                                  >
                                    {/* 预览 */}
                                    <div className="aspect-video bg-zinc-800">
                                      {wallpaper.type === 'image' ? (
                                        <img
                                          src={wallpaper.dataUrl}
                                          alt={wallpaper.name}
                                          className="w-full h-full object-cover"
                                        />
                                      ) : (
                                        <video
                                          src={wallpaper.dataUrl}
                                          className="w-full h-full object-cover"
                                          muted
                                        />
                                      )}
                                    </div>
                                    
                                    {/* 信息叠加 */}
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex flex-col justify-end p-2">
                                      <div className="flex items-center gap-1 text-xs">
                                        {wallpaper.type === 'image' ? (
                                          <ImageIcon className="w-3 h-3 text-white/60" />
                                        ) : (
                                          <Video className="w-3 h-3 text-white/60" />
                                        )}
                                        <span className="text-white/60">{wallpaper.format.toUpperCase()}</span>
                                        <span className="text-white/40">·</span>
                                        <span className="text-white/40">{desktopWallpaperManager.formatSize(wallpaper.size)}</span>
                                      </div>
                                    </div>

                                    {/* 当前选中标识 */}
                                    {currentWallpaperIndex === index && (
                                      <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-pink-500 flex items-center justify-center">
                                        <Check className="w-4 h-4 text-white" />
                                      </div>
                                    )}

                                    {/* 删除按钮 */}
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleDeleteWallpaper(wallpaper.id)
                                      }}
                                      className="absolute top-2 left-2 w-6 h-6 rounded-full bg-red-500/80 hover:bg-red-500 flex items-center justify-center transition-all"
                                    >
                                      <Trash2 className="w-3 h-3 text-white" />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          {/* 播放模式选择 - 仅在有壁纸时显示 */}
                          {wallpapers.length > 0 && (
                            <>
                              <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                                <div className="text-white font-medium mb-3">播放模式</div>
                                <div className="grid grid-cols-3 gap-3">
                                  <button
                                    onClick={() => handlePlayModeChange('single')}
                                    className={`p-3 rounded-lg transition-all border-2 text-center`}
                                    style={{
                                      borderColor: playMode === 'single' ? '#ec4899' : 'transparent',
                                      backgroundColor: playMode === 'single' 
                                        ? 'rgba(236,72,153,0.2)'
                                        : 'rgba(255,255,255,0.05)'
                                    }}
                                  >
                                    <div className="text-white font-medium text-sm">单张图片</div>
                                    <div className="text-white/40 text-xs mt-1">手动选择</div>
                                  </button>
                                  <button
                                    onClick={() => handlePlayModeChange('sequential')}
                                    className={`p-3 rounded-lg transition-all border-2 text-center`}
                                    style={{
                                      borderColor: playMode === 'sequential' ? '#ec4899' : 'transparent',
                                      backgroundColor: playMode === 'sequential' 
                                        ? 'rgba(236,72,153,0.2)'
                                        : 'rgba(255,255,255,0.05)'
                                    }}
                                  >
                                    <div className="text-white font-medium text-sm">顺序循环</div>
                                    <div className="text-white/40 text-xs mt-1">自动切换</div>
                                  </button>
                                  <button
                                    onClick={() => handlePlayModeChange('random')}
                                    className={`p-3 rounded-lg transition-all border-2 text-center`}
                                    style={{
                                      borderColor: playMode === 'random' ? '#ec4899' : 'transparent',
                                      backgroundColor: playMode === 'random' 
                                        ? 'rgba(236,72,153,0.2)'
                                        : 'rgba(255,255,255,0.05)'
                                    }}
                                  >
                                    <div className="text-white font-medium text-sm">随机循环</div>
                                    <div className="text-white/40 text-xs mt-1">随机切换</div>
                                  </button>
                                </div>
                              </div>

                              {/* 切换时机 - 仅在循环模式下显示 */}
                              {(playMode === 'sequential' || playMode === 'random') && (
                                <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                                  <div className="text-white font-medium mb-3 flex items-center gap-2">
                                    <Clock className="w-4 h-4" />
                                    切换时机
                                  </div>
                                  <div className="grid grid-cols-3 gap-3">
                                    <button
                                      onClick={() => handleSwitchModeChange('manual')}
                                      className={`p-3 rounded-lg transition-all border-2 text-center`}
                                      style={{
                                        borderColor: switchMode === 'manual' ? '#ec4899' : 'transparent',
                                        backgroundColor: switchMode === 'manual' 
                                          ? 'rgba(236,72,153,0.2)'
                                          : 'rgba(255,255,255,0.05)'
                                      }}
                                    >
                                      <div className="text-white font-medium text-sm">手动切换</div>
                                      <div className="text-white/40 text-xs mt-1">点击切换</div>
                                    </button>
                                    <button
                                      onClick={() => handleSwitchModeChange('interval')}
                                      className={`p-3 rounded-lg transition-all border-2 text-center`}
                                      style={{
                                        borderColor: switchMode === 'interval' ? '#ec4899' : 'transparent',
                                        backgroundColor: switchMode === 'interval' 
                                          ? 'rgba(236,72,153,0.2)'
                                          : 'rgba(255,255,255,0.05)'
                                      }}
                                    >
                                      <div className="text-white font-medium text-sm">定时切换</div>
                                      <div className="text-white/40 text-xs mt-1">按时间</div>
                                    </button>
                                    <button
                                      onClick={() => handleSwitchModeChange('on-startup')}
                                      className={`p-3 rounded-lg transition-all border-2 text-center`}
                                      style={{
                                        borderColor: switchMode === 'on-startup' ? '#ec4899' : 'transparent',
                                        backgroundColor: switchMode === 'on-startup' 
                                          ? 'rgba(236,72,153,0.2)'
                                          : 'rgba(255,255,255,0.05)'
                                      }}
                                    >
                                      <div className="text-white font-medium text-sm">启动时切换</div>
                                      <div className="text-white/40 text-xs mt-1">仅一次</div>
                                    </button>
                                  </div>
                                </div>
                              )}

                              {/* 切换间隔 - 仅在定时切换模式下显示 */}
                              {(playMode === 'sequential' || playMode === 'random') && switchMode === 'interval' && (
                                <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                                  <div className="text-white font-medium mb-3">切换间隔</div>
                                  <div className="grid grid-cols-4 gap-3 mb-3">
                                    {[10, 30, 60].map((minutes) => (
                                      <button
                                        key={minutes}
                                        onClick={() => handleIntervalChange(minutes)}
                                        className={`p-3 rounded-lg transition-all border-2 text-center`}
                                        style={{
                                          borderColor: intervalMinutes === minutes ? '#ec4899' : 'transparent',
                                          backgroundColor: intervalMinutes === minutes 
                                            ? 'rgba(236,72,153,0.2)'
                                            : 'rgba(255,255,255,0.05)'
                                        }}
                                      >
                                        <div className="text-white font-medium text-sm">{minutes}分钟</div>
                                      </button>
                                    ))}
                                    <button
                                      onClick={() => setShowCustomInterval(true)}
                                      className={`p-3 rounded-lg transition-all border-2 text-center`}
                                      style={{
                                        borderColor: ![10, 30, 60].includes(intervalMinutes) ? '#ec4899' : 'transparent',
                                        backgroundColor: ![10, 30, 60].includes(intervalMinutes) 
                                          ? 'rgba(236,72,153,0.2)'
                                          : 'rgba(255,255,255,0.05)'
                                      }}
                                    >
                                      <div className="text-white font-medium text-sm">
                                        {![10, 30, 60].includes(intervalMinutes) ? `${intervalMinutes}分钟` : '自定义'}
                                      </div>
                                    </button>
                                  </div>

                                  {/* 自定义间隔输入 */}
                                  {showCustomInterval && (
                                    <motion.div
                                      initial={{ opacity: 0, height: 0 }}
                                      animate={{ opacity: 1, height: 'auto' }}
                                      className="space-y-3"
                                    >
                                      <input
                                        type="number"
                                        min="1"
                                        value={customInterval}
                                        onChange={(e) => setCustomInterval(e.target.value)}
                                        placeholder="输入分钟数"
                                        className="w-full px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-pink-400"
                                      />
                                      <div className="flex gap-2">
                                        <button
                                          onClick={handleSaveCustomInterval}
                                          className="flex-1 py-2 px-4 rounded-lg bg-pink-500 hover:bg-pink-600 transition-all text-white font-medium"
                                        >
                                          保存
                                        </button>
                                        <button
                                          onClick={() => {
                                            setShowCustomInterval(false)
                                            setCustomInterval('')
                                          }}
                                          className="flex-1 py-2 px-4 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-white font-medium"
                                        >
                                          取消
                                        </button>
                                      </div>
                                    </motion.div>
                                  )}
                                </div>
                              )}

                              {/* 重置为默认按钮 */}
                              <button
                                onClick={handleResetToDefault}
                                className="w-full py-3 px-4 rounded-lg bg-white/10 hover:bg-white/20 transition-all text-white font-medium flex items-center justify-center gap-2"
                              >
                                <RotateCcw className="w-4 h-4" />
                                重置为默认壁纸
                              </button>
                            </>
                          )}
                        </motion.div>
                      )}

                      {/* 随机图片模式 */}
                      {wallpaperMode === 'random-api' && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="space-y-3"
                        >
                          <div className="bg-white/5 rounded-xl p-4 border border-white/10">
                            <div className="text-white font-medium mb-3">随机图片来源</div>
                            <div className="grid grid-cols-2 gap-3">
                              {[
                                { value: 'bing' as RandomImageSource, label: 'Bing 每日壁纸', desc: '高质量风景' },
                                { value: 'landscape' as RandomImageSource, label: '自然风景', desc: '自然美景' },
                                { value: 'anime' as RandomImageSource, label: '动漫二次元', desc: '随机动漫图' },
                                { value: 'custom' as RandomImageSource, label: '自定义 API', desc: '添加自定义链接' },
                              ].map((option) => (
                                <button
                                  key={option.value}
                                  onClick={() => handleRandomImageSourceChange(option.value)}
                                  className={`p-3 rounded-lg transition-all border-2 text-left`}
                                  style={{
                                    borderColor: randomImageSource === option.value ? '#ec4899' : 'transparent',
                                    backgroundColor: randomImageSource === option.value 
                                      ? 'rgba(236,72,153,0.2)'
                                      : 'rgba(255,255,255,0.05)'
                                  }}
                                >
                                  <div className="text-white font-medium text-sm">{option.label}</div>
                                  <div className="text-white/40 text-xs mt-1">{option.desc}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* 自定义API URL输入 */}
                          {randomImageSource === 'custom' && (
                            <motion.div
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              className="bg-white/5 rounded-xl p-4 border border-white/10"
                            >
                              <div className="text-white font-medium mb-3">自定义随机图片 API</div>
                              <div className="space-y-3">
                                <input
                                  type="text"
                                  value={customApiUrl}
                                  onChange={(e) => setCustomApiUrl(e.target.value)}
                                  placeholder="https://example.com/random-image.jpg"
                                  className="w-full px-4 py-2 bg-white/10 border border-white/20 rounded-lg text-white placeholder-white/40 focus:outline-none focus:border-pink-400"
                                />
                                <button
                                  onClick={handleSaveCustomUrl}
                                  className="w-full py-2 px-4 rounded-lg bg-pink-500 hover:bg-pink-600 transition-all text-white font-medium"
                                >
                                  保存并应用
                                </button>
                                <div className="text-white/40 text-xs">
                                  提示：输入返回随机图片的 API 地址，每次刷新将获取新图片
                                </div>
                              </div>
                            </motion.div>
                          )}
                        </motion.div>
                      )}
                    </motion.div>
                  ) : activeSubmenu === 'wallpaper-engine' ? (
                    // WallpaperEngine 二级菜单
                    <motion.div
                      key="wallpaper-engine-submenu"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-6"
                    >
                      <div className="text-white/60 text-sm mb-4">
                        从您的 WallpaperEngine 库中选择动态壁纸作为背景
                      </div>

                      {/* 提示：需要关闭同步 */}
                      {wallpaperSyncEnabled && (
                        <div className="bg-amber-500/20 border border-amber-500/50 rounded-xl p-4">
                          <div className="flex items-start gap-3">
                            <div className="text-amber-400 mt-0.5">⚠️</div>
                            <div>
                              <div className="text-amber-200 font-medium mb-1">需要关闭同步功能</div>
                              <div className="text-amber-200/80 text-sm">
                                请先在上一级菜单中关闭"Wallpaper Engine 同步"，才能手动选择壁纸
                              </div>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* WallpaperEngine 壁纸列表 */}
                      {!wallpaperSyncEnabled && (
                        <div>
                          <div className="flex items-center justify-between mb-3">
                            <div className="text-white font-medium">可用壁纸</div>
                            <button
                              onClick={onScanWeWallpapers}
                              disabled={weLoading}
                              className="px-4 py-2 rounded-lg bg-pink-500 hover:bg-pink-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all text-white text-sm font-medium flex items-center gap-2"
                            >
                              {weLoading ? (
                                <>
                                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                  扫描中...
                                </>
                              ) : (
                                <>
                                  <RotateCcw className="w-4 h-4" />
                                  扫描壁纸
                                </>
                              )}
                            </button>
                          </div>

                          <div className="mb-4 rounded-2xl border border-white/10 bg-white/[0.045] p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex min-w-0 items-start gap-3">
                                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-pink-500/15 text-pink-200"><Timer className="h-5 w-5" /></div>
                                <div>
                                  <div className="font-medium text-white">自动切换已选壁纸</div>
                                  <div className="mt-1 text-xs leading-5 text-white/45">只会轮换你单独勾选的壁纸，不会默认使用整个壁纸库。</div>
                                </div>
                              </div>
                              <button
                                type="button"
                                disabled={wallpaperRotation.selectedWallpaperIds.length < 2}
                                onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, enabled: !wallpaperRotation.enabled })}
                                className={`relative mt-1 h-7 w-12 shrink-0 rounded-full transition ${wallpaperRotation.enabled ? 'bg-pink-500' : 'bg-white/15'} disabled:cursor-not-allowed disabled:opacity-35`}
                                aria-label="自动切换 Wallpaper Engine 壁纸"
                                aria-pressed={wallpaperRotation.enabled}
                              >
                                <span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow transition-all ${wallpaperRotation.enabled ? 'left-6' : 'left-1'}`} />
                              </button>
                            </div>

                            <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] gap-3">
                              <label className="rounded-xl border border-white/8 bg-black/20 p-3">
                                <span className="text-[11px] text-white/45">切换间隔（分钟）</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={1440}
                                  value={wallpaperRotation.intervalMinutes}
                                  onChange={event => onWallpaperRotationChange({ ...wallpaperRotation, intervalMinutes: Number(event.target.value) })}
                                  className="mt-2 h-9 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white outline-none focus:border-pink-400/60"
                                />
                              </label>
                              <div className="rounded-xl border border-white/8 bg-black/20 p-3">
                                <div className="text-[11px] text-white/45">切换方式</div>
                                <div className="mt-2 grid grid-cols-2 gap-2">
                                  <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, mode: 'sequential' })} className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs transition ${wallpaperRotation.mode === 'sequential' ? 'border-pink-400/60 bg-pink-500/16 text-pink-100' : 'border-white/8 bg-white/[0.035] text-white/55'}`}><ListOrdered className="h-3.5 w-3.5" />顺序</button>
                                  <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, mode: 'random' })} className={`flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs transition ${wallpaperRotation.mode === 'random' ? 'border-pink-400/60 bg-pink-500/16 text-pink-100' : 'border-white/8 bg-white/[0.035] text-white/55'}`}><Shuffle className="h-3.5 w-3.5" />随机</button>
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
                              <span className={wallpaperRotation.selectedWallpaperIds.length >= 2 ? 'text-emerald-300/85' : 'text-amber-200/75'}>
                                已选择 {wallpaperRotation.selectedWallpaperIds.length} 张{wallpaperRotation.selectedWallpaperIds.length < 2 ? '，至少选择 2 张才能开启' : ''}
                              </span>
                              {wallpaperRotation.selectedWallpaperIds.length > 0 && (
                                <button type="button" onClick={() => onWallpaperRotationChange({ ...wallpaperRotation, enabled: false, selectedWallpaperIds: [] })} className="text-white/45 transition hover:text-white/75">清空选择</button>
                              )}
                            </div>
                          </div>

                          {/* 错误提示 */}
                          {weError && (
                            <div className="mb-4 p-3 bg-red-500/20 border border-red-500/50 rounded-xl text-red-200 text-sm">
                              {weError}
                            </div>
                          )}

                          {/* 壁纸网格 */}
                          {weWallpapers.length > 0 ? (
                            <div className="grid grid-cols-2 gap-3 max-h-[400px] overflow-y-auto pr-2" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.3) transparent' }}>
                              {weWallpapers.map((wallpaper) => {
                                const participatesInRotation = wallpaperRotation.selectedWallpaperIds.includes(wallpaper.id)
                                return (
                                <motion.div
                                  key={wallpaper.id}
                                  whileHover={{ scale: 1.03 }}
                                  onClick={() => onSelectWeWallpaper(wallpaper)}
                                  className={`relative aspect-video rounded-xl overflow-hidden cursor-pointer border-2 transition-all ${
                                    selectedWeWallpaper === wallpaper.id
                                      ? 'border-pink-500 shadow-lg shadow-pink-500/30'
                                      : participatesInRotation
                                        ? 'border-cyan-400/70 shadow-lg shadow-cyan-500/15'
                                        : 'border-white/10 hover:border-white/30'
                                  }`}
                                >
                                  <button
                                    type="button"
                                    onClick={event => {
                                      event.stopPropagation()
                                      const selectedWallpaperIds = participatesInRotation
                                        ? wallpaperRotation.selectedWallpaperIds.filter(id => id !== wallpaper.id)
                                        : [...wallpaperRotation.selectedWallpaperIds, wallpaper.id]
                                      onWallpaperRotationChange({
                                        ...wallpaperRotation,
                                        enabled: wallpaperRotation.enabled && selectedWallpaperIds.length >= 2,
                                        selectedWallpaperIds,
                                      })
                                    }}
                                    className={`absolute left-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-lg border backdrop-blur-md transition ${participatesInRotation ? 'border-cyan-300/70 bg-cyan-400/80 text-slate-950' : 'border-white/20 bg-black/45 text-white/65 hover:bg-black/65'}`}
                                    aria-label={participatesInRotation ? '从自动轮换中移除' : '加入自动轮换'}
                                    title={participatesInRotation ? '从自动轮换中移除' : '加入自动轮换'}
                                  >
                                    {participatesInRotation ? <Check className="h-4 w-4" /> : <span className="h-2.5 w-2.5 rounded-[3px] border border-current" />}
                                  </button>
                                  {wallpaper.preview ? (
                                    <img
                                      src={`http://localhost:3001${wallpaper.preview}`}
                                      alt={wallpaper.title}
                                      className="w-full h-full object-cover"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none'
                                      }}
                                    />
                                  ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-purple-500/20 to-pink-500/20 flex items-center justify-center">
                                      <ImageIcon className="w-8 h-8 text-white/30" />
                                    </div>
                                  )}
                                  
                                  {/* 标题覆盖层 */}
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-2">
                                    <div className="w-full">
                                      <div className="text-white text-xs font-medium truncate">
                                        {wallpaper.title}
                                      </div>
                                      <div className="flex items-center gap-2 mt-1">
                                        {wallpaper.type === 'video' && (
                                          <span className="px-1.5 py-0.5 bg-pink-500/80 rounded text-[10px] text-white">
                                            视频
                                          </span>
                                        )}
                                        {wallpaper.type === 'web' && (
                                          <span className="px-1.5 py-0.5 bg-blue-500/80 rounded text-[10px] text-white">
                                            Web
                                          </span>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* 选中标记 */}
                                  {selectedWeWallpaper === wallpaper.id && (
                                    <div className="absolute top-2 right-2 w-6 h-6 bg-pink-500 rounded-full flex items-center justify-center">
                                      <Check className="w-4 h-4 text-white" />
                                    </div>
                                  )}
                                </motion.div>
                                )
                              })}
                            </div>
                          ) : !weLoading && !weError ? (
                            <div className="text-center py-12">
                              <ImageIcon className="w-12 h-12 text-white/20 mx-auto mb-3" />
                              <div className="text-white/40 text-sm mb-4">
                                点击"扫描壁纸"按钮开始扫描
                              </div>
                            </div>
                          ) : null}

                          {/* 功能说明 */}
                          <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                            <div className="text-blue-200 text-sm">
                              💡 <strong>功能说明：</strong>
                              <br />
                              • 此功能将扫描您的 WallpaperEngine 安装目录
                              <br />
                              • 列出所有支持的动态壁纸预览图
                              <br />
                              • 点击壁纸立即应用，左上角勾选框控制是否参与自动轮换
                              <br />
                              • 随机模式会避开当前壁纸，顺序模式会从当前壁纸的下一张继续
                            </div>
                          </div>
                        </div>
                      )}
                    </motion.div>
                  ) : activeSubmenu === 'global' ? (
                    // 全局设置二级菜单：镜像注册表（services/globalSettingsRegistry），
                    // 与简约 / 传统 / 探索模式同键同事件，任意一端修改全软件同步。
                    <motion.div
                      key="global-settings-submenu"
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -20 }}
                      transition={{ duration: 0.2 }}
                      className="space-y-4"
                    >
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
                        <p className="text-sm leading-6 text-white/60">
                          这里是整软件通用的设置（播放 / 歌词 / 快捷键 / 桌面集成 / 性能 / 网络等），
                          与简约模式设置实时双向同步，对所有模式生效。
                        </p>
                      </div>
                      <MirroredGlobalSettings
                        variant="panel"
                        onOpenModal={setGlobalModal}
                        skin={makeSkin({
                          dark: true,
                          accent: '#a78bfa',
                          radius: 12,
                          cardBg: 'rgba(255,255,255,0.05)',
                          cardBorder: 'rgba(255,255,255,0.1)',
                          controlBg: 'rgba(255,255,255,0.06)',
                        })}
                      />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              {/* 全局设置里的共享弹窗（与简约 / 传统 / 探索模式同一组件） */}
              <Suspense fallback={null}>
                {globalModal === 'audio-quality' && (
                  <LazyAudioQualityModal show onClose={() => setGlobalModal(null)} playerTheme="dark" neteaseVip={neteaseVip} qqVip={qqVip} neteaseLoggedIn={neteaseLoggedIn} qqLoggedIn={qqLoggedIn} />
                )}
                {globalModal === 'cache-clear' && (
                  <LazyCacheClearModal show onClose={() => setGlobalModal(null)} playerTheme="dark" />
                )}
                {globalModal === 'remote-settings' && (
                  <LazyRemoteSettingsModal show onClose={() => setGlobalModal(null)} playerTheme="dark" />
                )}
              </Suspense>

              {/* 底部 */}
              <div className="p-6 border-t border-white/10">
                <button
                  onClick={onClose}
                  className="w-full py-3 px-6 rounded-xl bg-white/10 hover:bg-white/20 transition-all text-white font-medium"
                >
                  完成
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
