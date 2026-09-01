// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ 设置镜像机制声明（后续维护者 / AI 协作必读）⚠️
//
// 本组件是【简约模式设置】= 整软件的"总设置"。WaveForge 共 4 个界面模式
// （简约 / 传统 / 探索 / 桌面，后续可能更多），其中【全局功能性设置】通过
//   services/globalSettingsRegistry.ts（设置注册表，同键同事件双向同步）
//   components/MirroredGlobalSettings.tsx（按各模式设计语言渲染的镜像 UI）
// 自动镜像到传统 / 探索 / 桌面三个模式的设置界面。
//
// 因此在本面板新增设置项时，先判断它属于哪一类：
// 1. 全局功能设置（播放 / 歌词 / 性能 / 桌面集成 / 网络等，对所有模式生效）：
//    ✅ 除了写本面板的简约 UI，【必须】同步在 services/globalSettingsRegistry.ts
//      登记一条（read/write 与本面板读写同一存储键、派发同一事件），
//      其他模式的设置页就会自动出现该功能，无需逐模式手写 UI；
//    ✅ 如需自定义控件（如字体选择器 FontPicker），在 MirroredGlobalSettings.tsx
//      里为注册表的 control.kind 增加对应渲染分支（classic / panel 两种风格）。
//    ❌ 只写本面板不登记 = 其他模式的用户永远看不到这个功能开关。
// 2. 简约模式专属的自定义 / 外观设置（只影响简约模式自身，如"自定义首页显示内容"）：
//    不需要登记，写在这里即可。
// ═══════════════════════════════════════════════════════════════════════════
import React, { memo, useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { X, Settings as SettingsIcon, User, Palette, Sparkles, Info, ExternalLink, Github, ChevronRight, ChevronLeft, Trash2, Heart, Copy, ClipboardPaste, KeyRound, Code2, Users, BadgeCheck, CheckCircle2, Gift, Headphones, MonitorSmartphone, Gamepad2, Eye, EyeOff, FileText, Music, FolderHeart, Trash, AlertTriangle } from 'lucide-react'
import LoginButton from './LoginButton'
import type { AppleUserInfo } from '../services/appleAuth'
import type { StemModelProgress } from '../electron'
import {
  MUSIC_PLATFORMS,
  PLATFORM_LABELS,
  PLATFORM_VISIBILITY_EVENT,
  PLATFORM_ORDER_EVENT,
  getHiddenPlatforms,
  getPlatformOrder,
  setPlatformOrder,
  setPlatformHidden,
  type MusicPlatform,
} from '../services/platforms'
import HomeCustomizeModal from './HomeCustomizeModal'
import DeviceInfoModal from './DeviceInfoModal'
import AudioQualitySettingsModal from './AudioQualitySettingsModal'
import FontPicker from './FontPicker'
import RemoteControlSettingsModal from './RemoteControlSettingsModal'
import RemoteControlGuideModal from './RemoteControlGuideModal'
import CacheClearModal from './CacheClearModal'
import LegalAgreement from './legal/LegalAgreement'
import { LocaleSwitcher, type LocaleCode } from '../i18n'
import packageInfo from '../../package.json'
import { getVersionDisplay } from '../services/versionInfo'
import { VERSION_HISTORY } from '../services/versionHistory'
import { getDebugPanelVisible, setDebugPanelVisible } from '../tv/debugStore'
import { setTvFocus } from '../tv/tvCore'
import { isTvModeActive, TV_SCALE_OPTIONS, getTvScale, setTvScale, applyTvScale } from '../platform'
import {
  loadPlaybackShortcutSettings,
  savePlaybackShortcutSettings,
  type PlaybackShortcutSettings,
} from '../services/playbackShortcutSettings'
import type { DesktopLyricsColorMode, DesktopLyricsSettings, TaskbarWidgetSettings } from '../electron'
import { parseStoredBoolean } from '../utils/storage'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  loadAudioQualitySettings,
  type AudioQualityPreference,
} from '../services/audioQualitySettings'
import {
  getAppleMusicSettings,
  type AppleMusicSettings,
} from '../services/appleMusic'
import { checkBridgeRunning, ensureBridgeRunning, bridgeShowWindow, bridgeHideWindow, getState as getAppleBridgeState } from '../services/appleWebViewBridge'
import BilibiliLoginPanel from './BilibiliLoginPanel'
import BilibiliProfileModal from './BilibiliProfileModal'
import VmpStatusCard from './VmpStatusCard'
import {
  isBilibiliLoggedIn,
  getStoredBilibiliUser,
  getBilibiliRemainingDays,
  clearBilibiliLocal,
  clearBilibiliLoginExpiry,
  logoutBilibiliServer,
  resolveBiliPic,
  getLocalMvMarks,
  removeLocalMvMark,
  clearAllMvMatchCache,
} from '../services/bilibiliApi'

type UpdateCheckState = {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error'
  message?: string
}
/** 检查到的更新详情（查看详情/下载弹窗由全局 UpdateManager 承接） */
type UpdateDetail = {
  version: string
  notes: string
  hotUrls?: string[]
  hotSha?: string
  installUrls?: string[]
  installSha?: string
}
type DeviceGrant = { feature: string; label: string; issuedAt: number; expiresAt: number | null; note?: string }
type DeviceState = { status: 'idle' | 'loading' | 'ready' | 'error'; deviceId: string; storage?: 'registry' | 'file'; grants: DeviceGrant[]; message?: string }

const audioQualityLabel = (quality: AudioQualityPreference) => ({
  auto: '自动最高',
  standard: '标准',
  high: '高品质',
  'very-high': '超高品质',
  lossless: '无损',
  'hi-res': 'Hi-Res',
}[quality])

const appLogoUrl = new URL('../../logo.png', import.meta.url).href

const compareVersions = (left: string, right: string) => {
  const parse = (value: string) => value.replace(/^v/i, '').split(/[.-]/).slice(0, 3).map(part => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
  }
  return 0
}

interface SettingsPanelProps {
  show: boolean
  onClose: () => void
  // TV 设置：打开远程遥控器配对弹窗（App 层控制 RemoteControlModal）
  onOpenRemote?: () => void
  // 登录状态
  neteaseLoggedIn: boolean
  neteaseUsername: string
  onNeteaseLogin: (cookie: string) => void
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  neteaseVip: boolean
  qqVip: boolean
  onQQLogin: (cookie: string) => void
  onQQLogout: () => void
  appleLoggedIn: boolean
  appleUsername: string
  onAppleLogin: (user: AppleUserInfo | null) => void
  onAppleLogout: () => void
  // 新三平台登录态
  spotifyLoggedIn: boolean
  spotifyUsername: string
  onSpotifyLogin: (cookie: string, username?: string) => void
  onSpotifyLogout: () => void
  kugouLoggedIn: boolean
  kugouUsername: string
  onKugouLogin: (cookie: string, username?: string) => void
  onKugouLogout: () => void
  sodaLoggedIn: boolean
  sodaUsername: string
  onSodaLogin: (cookie: string, username?: string, extra?: { avatar?: string; userId?: string }) => void
  onSodaLogout: () => void
  playerTheme?: 'light' | 'dark'
}

// 模型下载速率/剩余时间展示
const formatDownloadSpeed = (bytesPerSec: number) => {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return ''
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`
  if (bytesPerSec >= 1024) return `${Math.round(bytesPerSec / 1024)} KB/s`
  return `${bytesPerSec} B/s`
}
const formatDownloadEta = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 1) return '即将完成'
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function SettingsPanel({
  show,
  onClose,
  onOpenRemote,
  neteaseLoggedIn,
  neteaseUsername,
  onNeteaseLogin,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  neteaseVip,
  qqVip,
  onQQLogin,
  onQQLogout,
  appleLoggedIn,
  appleUsername,
  onAppleLogin,
  onAppleLogout,
  spotifyLoggedIn,
  spotifyUsername,
  onSpotifyLogin,
  onSpotifyLogout,
  kugouLoggedIn,
  kugouUsername,
  onKugouLogin,
  onKugouLogout,
  sodaLoggedIn,
  sodaUsername,
  onSodaLogin,
  onSodaLogout,
  playerTheme = 'dark',
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<'tv' | 'account' | 'advanced' | 'personalization' | 'about'>('account')
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const switchTab = (tab: 'tv' | 'account' | 'advanced' | 'personalization' | 'about') => {
    setActiveTab(tab)
    requestAnimationFrame(() => contentScrollRef.current?.scrollTo({ top: 0, behavior: 'auto' }))
  }
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'

  // 隐藏平台（账号区块）：默认全部显示，用户可隐藏不常用的平台
  const [hiddenPlatforms, setHiddenPlatforms] = useState<MusicPlatform[]>(() => getHiddenPlatforms())
  useEffect(() => {
    const sync = () => setHiddenPlatforms(getHiddenPlatforms())
    window.addEventListener(PLATFORM_VISIBILITY_EVENT, sync)
    return () => window.removeEventListener(PLATFORM_VISIBILITY_EVENT, sync)
  }, [])

  // 平台卡片右上角小眼睛：切换隐藏当前平台（至少保留一个，隐藏第三个时 toast 提示）
  const togglePlatformVisibility = (platform: MusicPlatform, currentlyVisible: boolean) => {
    if (currentlyVisible) {
      // 隐藏：若当前可见平台只有这一个，则不允许（toast 提示）
      const visibleCount = MUSIC_PLATFORMS.filter(p => !hiddenPlatforms.includes(p)).length
      if (visibleCount <= 1) {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '您至少需要保留一个平台以正常使用本软件', type: 'info' }
        }))
        return
      }
      setPlatformHidden(platform, true)
    } else {
      setPlatformHidden(platform, false)
    }
  }

  // 平台排序（设置-账号：用户自定义顺序，三模式继承）
  const [platformOrder, setPlatformOrderState] = useState<MusicPlatform[]>(() => getPlatformOrder())
  useEffect(() => {
    const sync = () => setPlatformOrderState(getPlatformOrder())
    window.addEventListener(PLATFORM_ORDER_EVENT, sync)
    return () => window.removeEventListener(PLATFORM_ORDER_EVENT, sync)
  }, [])
  
  const [wordByWordLyrics, setWordByWordLyrics] = useState(() => {
    const saved = localStorage.getItem('wordByWordLyrics')
    return parseStoredBoolean(saved, true)
  })
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return parseStoredBoolean(saved, true)
  })
  const [showUpNextOutsidePlayer, setShowUpNextOutsidePlayer] = useState(() => {
    const saved = localStorage.getItem('showUpNextOutsidePlayer')
    return parseStoredBoolean(saved, false)
  })
  
  const [upNextSeconds, setUpNextSeconds] = useState(() => {
    const saved = localStorage.getItem('upNextSeconds')
    return saved !== null ? parseInt(saved) : 10
  })
  
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6' // 默认蓝色
  })
  // 远程遥控器设置（二级菜单弹窗）
  const [showRemoteSettings, setShowRemoteSettings] = useState(false)
  // TV：遥控器可视化教学弹窗
  const [showRemoteGuide, setShowRemoteGuide] = useState(false)
  // TV：每次启动自动打开远程遥控器配对界面（默认关闭）
  const [tvAutoOpenRemote, setTvAutoOpenRemote] = useState(() => {
    try {
      return localStorage.getItem('tvAutoOpenRemote') === '1'
    } catch {
      return false
    }
  })
  // TV：识别码 + 测试码
  const [tvRedeemCode, setTvRedeemCode] = useState('')
  const [showTvRedeemModal, setShowTvRedeemModal] = useState(false)
  const [showTvDeviceId, setShowTvDeviceId] = useState(false)
  const [tvRedeemState, setTvRedeemState] = useState<{ status: 'idle' | 'redeeming'; message: string | null }>({ status: 'idle', message: null })
  const [tvLicense, setTvLicense] = useState<{ deviceId: string; grants: Array<{ feature: string; label: string; expiresAt?: number }> }>({ deviceId: '', grants: [] })
  const [showLocalMvMarks, setShowLocalMvMarks] = useState(false)
  const [localMvMarks, setLocalMvMarks] = useState<ReturnType<typeof getLocalMvMarks>>([])
  const [playbackShortcutSettings, setPlaybackShortcutSettings] = useState(loadPlaybackShortcutSettings)
  
  // 第三方歌词源设置
  const [thirdPartyLyricsEnabled, setThirdPartyLyricsEnabled] = useState(() => {
    const saved = localStorage.getItem('thirdPartyLyricsEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const [adaptiveLyrics, setAdaptiveLyrics] = useState(() => {
    const saved = localStorage.getItem('adaptiveLyrics')
    return parseStoredBoolean(saved, true)
  })
  
  const [primaryLyricsSource, setPrimaryLyricsSource] = useState<string>(() => {
    const saved = localStorage.getItem('primaryLyricsSource')
    return saved || 'AMLL'
  })

  // ── Apple Music 设置 ──
  const [appleMusic, setAppleMusic] = useState<AppleMusicSettings>(() => getAppleMusicSettings())
  // Apple 原生音源开关（Cider 式直连；默认开，localStorage 独立存储）
  const [appleNativeStreamEnabled, setAppleNativeStreamEnabled] = useState(() => localStorage.getItem('appleNativeStream') !== 'false')

  // Apple Music 播放面（WebView2 bridge）状态与窗口开关
  const [appleBridgeWindowVisible, setAppleBridgeWindowVisible] = useState(false)
  const [appleBridgeBusy, setAppleBridgeBusy] = useState(false)
  const [appleBridgeReady, setAppleBridgeReady] = useState(false)
  const [appleBridgeAuthorized, setAppleBridgeAuthorized] = useState(false)
  useEffect(() => {
    let disposed = false
    checkBridgeRunning().then((ok) => {
      if (disposed) return
      setAppleBridgeReady(ok)
      if (ok) setAppleBridgeAuthorized(getAppleBridgeState().authorized)
    })
    return () => { disposed = true }
  }, [])
  const toggleAppleBridgeWindow = async () => {
    if (appleBridgeWindowVisible) {
      await bridgeHideWindow()
      setAppleBridgeWindowVisible(false)
      return
    }
    setAppleBridgeBusy(true)
    try {
      // 未运行时先拉起（可能等待 WebView2 冷启动），再显示窗口供登录
      const ok = await ensureBridgeRunning()
      if (ok) await bridgeShowWindow()
      setAppleBridgeReady(ok)
      setAppleBridgeAuthorized(ok && getAppleBridgeState().authorized)
      setAppleBridgeWindowVisible(ok)
    } finally {
      setAppleBridgeBusy(false)
    }
  }

  // ── 哔哩哔哩「看歌」账号 ──
  const [biliLoggedIn, setBiliLoggedIn] = useState(() => isBilibiliLoggedIn())
  const [biliUser, setBiliUser] = useState(() => getStoredBilibiliUser())
  const [biliRemainingDays, setBiliRemainingDays] = useState(() => getBilibiliRemainingDays())
  const [showBiliLogin, setShowBiliLogin] = useState(false)
  const [showBiliProfile, setShowBiliProfile] = useState(false)

  const refreshBiliAuth = () => {
    setBiliLoggedIn(isBilibiliLoggedIn())
    setBiliUser(getStoredBilibiliUser())
    setBiliRemainingDays(getBilibiliRemainingDays())
  }

  const handleBiliLogout = () => {
    clearBilibiliLocal()
    clearBilibiliLoginExpiry()
    void logoutBilibiliServer().catch(() => undefined)
    refreshBiliAuth()
    window.dispatchEvent(new CustomEvent('bilibili-auth-changed', { detail: { loggedIn: false } }))
  }

  useEffect(() => {
    const onBiliAuthChanged = () => refreshBiliAuth()
    window.addEventListener('bilibili-auth-changed', onBiliAuthChanged as EventListener)
    return () => window.removeEventListener('bilibili-auth-changed', onBiliAuthChanged as EventListener)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateAppleMusic = (patch: Partial<AppleMusicSettings>) => {
    const next = { ...appleMusic, ...patch }
    setAppleMusic(next)
    localStorage.setItem('appleMusicEnabled', JSON.stringify(next.enabled))
    localStorage.setItem('appleDeveloperToken', next.developerToken)
    localStorage.setItem('appleMediaUserToken', next.mediaUserToken)
    localStorage.setItem('appleStorefront', next.storefront)
    localStorage.setItem('appleLyricLang', next.lyricLang)
    localStorage.setItem('applePreferCover', JSON.stringify(next.preferAppleCover))
    localStorage.setItem('appleDuetColors', JSON.stringify(next.duetColors))
  }

  // 登录 Apple Music 后自动开启 Apple Music 歌词
  useEffect(() => {
    if (appleLoggedIn && !appleMusic.enabled) {
      updateAppleMusic({ enabled: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appleLoggedIn])

  const [crossPlatformFallbackEnabled, setCrossPlatformFallbackEnabled] = useState(() => {
    const saved = localStorage.getItem('crossPlatformFallbackEnabled')
    return parseStoredBoolean(saved, false)
  })
  const [hideHomeAccountId, setHideHomeAccountId] = useState(() => (
    parseStoredBoolean(localStorage.getItem('hideHomeAccountId'), false)
  ))

  const handleHideHomeAccountIdChange = () => {
    const nextValue = !hideHomeAccountId
    setHideHomeAccountId(nextValue)
    localStorage.setItem('hideHomeAccountId', String(nextValue))
    window.dispatchEvent(new CustomEvent('privacy-settings-changed', {
      detail: { hideHomeAccountId: nextValue },
    }))
  }
  
  // 首页自定义弹窗状态
  const [showHomeCustomize, setShowHomeCustomize] = useState(false)
  const [showAudioQuality, setShowAudioQuality] = useState(false)
  const [audioQualitySettings, setAudioQualitySettings] = useState(loadAudioQualitySettings)

  useEffect(() => {
    const handleAudioQualityChange = () => setAudioQualitySettings(loadAudioQualitySettings())
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
    return () => window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, handleAudioQualityChange)
  }, [])

  // 桌面播放器（独立置顶小窗口）设置
  const [desktopPlayerEnabled, setDesktopPlayerEnabled] = useState(false)
  const [desktopPlayerForm, setDesktopPlayerForm] = useState<'card' | 'bar'>('card')
  const [desktopLyricsSettings, setDesktopLyricsSettings] = useState<DesktopLyricsSettings>({
    enabled: false,
    fontSize: 58,
    fontFamily: '',
    colorMode: 'auto',
    orientation: 'horizontal',
    doubleLine: false,
    translationEnabled: false,
    romajiEnabled: false,
    traditionalEnabled: false,
    locked: false,
  })

  useEffect(() => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.getInitialState === 'function'
    if (!hasBridge) return
    ;(window as any).electron.desktopPlayer
      .getInitialState()
      .then((snapshot: any) => {
        setDesktopPlayerEnabled(Boolean(snapshot?.enabled))
        setDesktopPlayerForm(snapshot?.form === 'bar' ? 'bar' : 'card')
      })
      .catch(() => undefined)
  }, [])

  // 小窗口点 X 关闭后同步开关状态
  useEffect(() => {
    const syncEnabled = (event: Event) => {
      setDesktopPlayerEnabled(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener('desktopPlayerEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopPlayerEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopPlayerToggle = async (enabled: boolean) => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setEnabled === 'function'
    setDesktopPlayerEnabled(enabled)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setEnabled(enabled)
      setDesktopPlayerEnabled(Boolean(result?.enabled ?? enabled))
    } catch {
      setDesktopPlayerEnabled(false)
    }
  }

  const handleDesktopPlayerFormChange = async (form: 'card' | 'bar') => {
    const hasBridge = typeof (window as any).electron?.desktopPlayer?.setForm === 'function'
    setDesktopPlayerForm(form)
    if (!hasBridge) return
    try {
      const result = await (window as any).electron.desktopPlayer.setForm(form)
      setDesktopPlayerForm(result?.form === 'bar' ? 'bar' : 'card')
    } catch {
      // 保留当前选择
    }
  }

  // 任务栏迷你播控（贴任务栏带）设置
  const [taskbarWidgetEnabledState, setTaskbarWidgetEnabledState] = useState(false)
  const [taskbarWidgetSettings, setTaskbarWidgetSettings] = useState<TaskbarWidgetSettings>({
    enabled: false,
    position: 'right',
    width: 340,
    mode: 'normal',
    darken: false,
    darkenLevel: 0.5,
    hideControls: false,
  })

  useEffect(() => {
    const api = window.electron?.taskbarWidget
    if (!api) return
    void api.getSettings().then((settings) => {
      setTaskbarWidgetSettings(settings)
      setTaskbarWidgetEnabledState(settings.enabled)
    }).catch(() => undefined)
  }, [])

  const handleTaskbarWidgetToggle = async (enabled: boolean) => {
    setTaskbarWidgetEnabledState(enabled)
    setTaskbarWidgetSettings(previous => ({ ...previous, enabled }))
    const api = window.electron?.taskbarWidget
    if (!api) return
    try {
      const result = await api.setEnabled(enabled)
      if (result?.success) setTaskbarWidgetEnabledState(Boolean(result.enabled))
    } catch {
      setTaskbarWidgetEnabledState(false)
      setTaskbarWidgetSettings(previous => ({ ...previous, enabled: false }))
    }
  }

  const handleTaskbarWidgetUpdate = async (partial: Partial<TaskbarWidgetSettings>) => {
    setTaskbarWidgetSettings(previous => ({ ...previous, ...partial }))
    const api = window.electron?.taskbarWidget
    if (!api) return
    try {
      const result = await api.updateSettings(partial)
      setTaskbarWidgetSettings(result)
    } catch {
      // 保留当前选择
    }
  }

  useEffect(() => {
    const api = window.electron?.desktopLyrics
    if (!api) return
    void api.getSettings().then(setDesktopLyricsSettings).catch(() => undefined)
    const syncEnabled = (event: Event) => {
      setDesktopLyricsSettings(previous => ({
        ...previous,
        enabled: Boolean((event as CustomEvent<boolean>).detail),
      }))
    }
    window.addEventListener('desktopLyricsEnabledChanged', syncEnabled)
    return () => window.removeEventListener('desktopLyricsEnabledChanged', syncEnabled)
  }, [])

  const handleDesktopLyricsToggle = async (enabled: boolean) => {
    setDesktopLyricsSettings(previous => ({ ...previous, enabled }))
    try {
      const result = await window.electron?.desktopLyrics?.setEnabled(enabled)
      if (result) setDesktopLyricsSettings(previous => ({ ...previous, enabled: result.enabled }))
    } catch {
      setDesktopLyricsSettings(previous => ({ ...previous, enabled: false }))
    }
  }

  const updateDesktopLyrics = async (partial: Partial<DesktopLyricsSettings>) => {
    setDesktopLyricsSettings(previous => ({ ...previous, ...partial }))
    try {
      const result = await window.electron?.desktopLyrics?.updateSettings(partial)
      if (result) setDesktopLyricsSettings(result)
    } catch {
      // Electron 桥接不可用时保留界面预览值。
    }
  }
  
  // 缓存清理弹窗状态
  const [showCacheClear, setShowCacheClear] = useState(false)
  
  // 法律声明弹窗状态
  const [showLegalModal, setShowLegalModal] = useState(false)
  // 法律声明弹窗语言（右上角切换）
  const [legalLocale, setLegalLocale] = useState<LocaleCode>('zh-CN')
  const [showDeviceIdModal, setShowDeviceIdModal] = useState(false)
  const [showDeviceInfo, setShowDeviceInfo] = useState(false)
  const [tvScale, setTvScaleState] = useState<number>(() => getTvScale())
  const [tvInfo, setTvInfo] = useState<Record<string, string | number | boolean> | null>(null)
  const [pendingTvScale, setPendingTvScale] = useState<number | null>(null)
  const [tvScaleCountdown, setTvScaleCountdown] = useState(10)
  const tvScaleCountdownRef = useRef(10)
  const tvScaleCancelRef = useRef<HTMLButtonElement | null>(null)

  // 点击缩放档位：先实时预览（改 viewport），弹确认框，10 秒不确认自动还原
  const previewTvScale = useCallback((v: number) => {
    if (v === tvScale) return
    applyTvScale(v)
    setPendingTvScale(v)
    tvScaleCountdownRef.current = 10
    setTvScaleCountdown(10)
  }, [tvScale])

  const confirmTvScale = useCallback(() => {
    if (pendingTvScale != null) {
      setTvScaleState(pendingTvScale)
      setTvScale(pendingTvScale)
    }
    setPendingTvScale(null)
  }, [pendingTvScale])

  const cancelTvScale = useCallback(() => {
    // 还原到上一次已应用的 DPI
    applyTvScale(getTvScale())
    setPendingTvScale(null)
    setTvScaleState(getTvScale())
  }, [])

  // 倒计时：超时自动还原（等同取消）
  useEffect(() => {
    if (pendingTvScale == null) return
    tvScaleCountdownRef.current = 10
    setTvScaleCountdown(10)
    // 弹窗打开时默认焦点放在「取消」上：按确认键直接还原
    if (tvScaleCancelRef.current) setTvFocus(tvScaleCancelRef.current)
    const timer = window.setInterval(() => {
      tvScaleCountdownRef.current -= 1
      if (tvScaleCountdownRef.current <= 0) {
        window.clearInterval(timer)
        cancelTvScale()
      } else {
        setTvScaleCountdown(tvScaleCountdownRef.current)
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [pendingTvScale, cancelTvScale])
  useEffect(() => {
    if (!show || !isTvModeActive()) return
    const native = (window as any).WaveForgeNative
    if (native?.getDeviceInfo) {
      try { setTvInfo(JSON.parse(String(native.getDeviceInfo()))) } catch { setTvInfo(null) }
    }
  }, [show])
  const [showRedeemModal, setShowRedeemModal] = useState(false)
  const [deviceIdForModal, setDeviceIdForModal] = useState('')
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckState>({ status: 'idle' })
  const [updateDetail, setUpdateDetail] = useState<UpdateDetail | null>(null)
  const [pendingUpdate, setPendingUpdate] = useState<{ version: string; stagedAt?: number } | null>(null)
  const [showVersionHistory, setShowVersionHistory] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(() => parseStoredBoolean(localStorage.getItem('autoCheckUpdate'), true))
  const [skippedVersion, setSkippedVersion] = useState<string | null>(() => localStorage.getItem('skippedUpdateVersion'))

  // 待应用更新常驻提示（上次「稍后」/ 已下载完成的更新，重启即生效）
  useEffect(() => {
    void window.electron?.update?.getPending?.().then((p) => {
      if (p?.version) setPendingUpdate(p)
    }).catch(() => {})
  }, [])
  const [deviceState, setDeviceState] = useState<DeviceState>({ status: 'idle', deviceId: '', grants: [] })
  const [redeemCode, setRedeemCode] = useState('')
  const [redeemMessage, setRedeemMessage] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)

  // 灰色歌曲跨平台补全：开启前必须阅读免责声明并等待倒计时结束
  const [showFallbackDisclaimer, setShowFallbackDisclaimer] = useState(false)
  const [fallbackCountdown, setFallbackCountdown] = useState(20)

  useEffect(() => {
    if (!showFallbackDisclaimer || fallbackCountdown <= 0) return
    const timer = window.setTimeout(() => setFallbackCountdown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [showFallbackDisclaimer, fallbackCountdown])

  const confirmFallbackEnable = () => {
    setCrossPlatformFallbackEnabled(true)
    localStorage.setItem('crossPlatformFallbackEnabled', JSON.stringify(true))
    setShowFallbackDisclaimer(false)
    window.dispatchEvent(new CustomEvent('showToast', {
      detail: { message: '已开启灰色歌曲跨平台补全', type: 'success' },
    }))
  }

  // 删除识别码与测试码：确认弹窗（10 秒倒计时）
  const [showDeleteLicenseModal, setShowDeleteLicenseModal] = useState(false)
  const [deleteLicenseCountdown, setDeleteLicenseCountdown] = useState(10)

  useEffect(() => {
    if (!showDeleteLicenseModal || deleteLicenseCountdown <= 0) return
    const timer = window.setTimeout(() => setDeleteLicenseCountdown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [showDeleteLicenseModal, deleteLicenseCountdown])

  const confirmDeleteLicense = async () => {
    setShowDeleteLicenseModal(false)
    try {
      const result = await window.electron?.deviceLicense?.reset()
      if (result?.success) {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '已删除识别码与测试码，本机将生成新的设备标识', type: 'success' },
        }))
        void loadDeviceState()
      } else {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: result?.error || '删除失败，请重试', type: 'error' },
        }))
      }
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '删除失败，请重试', type: 'error' },
      }))
    }
  }

  const loadDeviceState = async () => {
    // TV：设备识别码 = Android 系统 ANDROID_ID（原生桥提供），无桌面端授权/兑换体系
    const native = (window as any).WaveForgeNative
    if (native?.getDeviceId) {
      try {
        const id = String(native.getDeviceId() || '')
        setDeviceState({ status: 'ready', deviceId: id, grants: [] })
      } catch {
        setDeviceState({ status: 'error', deviceId: '', grants: [], message: '设备识别码读取失败' })
      }
      return
    }
    const api = window.electron?.deviceLicense
    if (!api) {
      setDeviceState({ status: 'error', deviceId: '', grants: [], message: '当前环境不支持设备授权功能' })
      return
    }
    setDeviceState(previous => ({ ...previous, status: 'loading', message: undefined }))
    try {
      const result = await api.getState()
      if (result.success) {
        setDeviceState({ status: 'ready', deviceId: result.deviceId, storage: result.storage, grants: result.grants })
      } else {
        setDeviceState({ status: 'error', deviceId: '', grants: [], message: result.error })
      }
    } catch (error) {
      setDeviceState({ status: 'error', deviceId: '', grants: [], message: error instanceof Error ? error.message : '设备识别码读取失败' })
    }
  }

  useEffect(() => {
    if (show && activeTab === 'about' && deviceState.status === 'idle') void loadDeviceState()
  }, [show, activeTab, deviceState.status])

  const copyDeviceId = async () => {
    setDeviceState(previous => ({ ...previous, status: 'loading', message: undefined }))
    try {
      const native = (window as any).WaveForgeNative
      if (native?.getDeviceId) {
        // TV：用原生桥的 ANDROID_ID 作为识别码，直接复制到剪贴板
        const id = deviceState.deviceId || String(native.getDeviceId() || '')
        try {
          await navigator.clipboard.writeText(id)
        } catch {
          // ignore
        }
        setDeviceState(previous => ({ ...previous, status: 'ready', deviceId: id }))
        setDeviceIdForModal(id)
        setShowDeviceIdModal(true)
        setRedeemMessage(null)
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '设备识别码已自动复制到剪贴板', type: 'success' },
        }))
        return
      }
      const result = await window.electron?.deviceLicense?.copyDeviceId()
      if (!result) {
        throw new Error('Device license bridge is unavailable')
      }
      if (!result.success) {
        throw new Error(result.error)
      }

      setDeviceState(previous => ({
        ...previous,
        status: 'ready',
        deviceId: result.deviceId,
        storage: result.storage,
      }))
      setDeviceIdForModal(result.deviceId)
      setShowDeviceIdModal(true)
      setRedeemMessage(null)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: {
          message: '设备识别码已自动复制到剪贴板',
          type: 'success',
        },
      }))
    } catch (error) {
      console.error('获取设备识别码失败:', error)
      setDeviceState(previous => ({ ...previous, status: 'error', message: '设备识别码获取失败' }))
      setRedeemMessage(null)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: {
          message: '设备识别码获取失败，请重启 WaveForge 后重试',
          type: 'error',
        },
      }))
    }
  }

  // ── TV：识别码 + 测试码（走设备内置 Node 后端，RSA 公钥签名验证） ──
  // 识别码：真机为 Android ANDROID_ID（原生桥）；浏览器 ?tv=1 调试用本地模拟 ID。
  const getTvDeviceId = () => {
    const native = (window as any).WaveForgeNative
    if (native?.getDeviceId) {
      try {
        const id = String(native.getDeviceId() || '')
        if (id) return id
      } catch {
        // fallthrough
      }
    }
    try {
      let id = localStorage.getItem('tvDebugDeviceId')
      if (!id) {
        id = `WF-TV-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
        localStorage.setItem('tvDebugDeviceId', id)
      }
      return id
    } catch {
      return 'WF-TV-DEBUG'
    }
  }
  const loadTvLicense = async () => {
    const deviceId = getTvDeviceId()
    try {
      const res = await fetch(
        `http://localhost:3001/api/tv/license/status?deviceId=${encodeURIComponent(deviceId)}`,
        { cache: 'no-store' }
      )
      if (res.ok) {
        const data = await res.json()
        setTvLicense({ deviceId: data.deviceId || '', grants: data.grants || [] })
      }
    } catch {
      // ignore
    }
  }
  const tvRedeem = async () => {
    const code = tvRedeemCode.trim()
    if (!code) {
      setTvRedeemState({ status: 'idle', message: '请输入测试码' })
      return
    }
    setTvRedeemState({ status: 'redeeming', message: null })
    try {
      const res = await fetch('http://localhost:3001/api/tv/license/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceId: getTvDeviceId() }),
      })
      const data = await res.json()
      if (data.ok) {
        setTvLicense({ deviceId: data.deviceId || tvLicense.deviceId, grants: data.grants || [] })
        setTvRedeemState({ status: 'idle', message: data.message || '测试码验证成功' })
        setTvRedeemCode('')
      } else {
        setTvRedeemState({ status: 'idle', message: data.error || '测试码验证失败' })
      }
    } catch {
      setTvRedeemState({ status: 'idle', message: '测试码验证失败，请重试' })
    }
  }
  const toggleTvAutoOpenRemote = (enabled: boolean) => {
    setTvAutoOpenRemote(enabled)
    try {
      localStorage.setItem('tvAutoOpenRemote', enabled ? '1' : '0')
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (show && activeTab === 'tv' && isTvModeActive()) void loadTvLicense()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, activeTab])

  const pasteRedeemCode = async () => {
    setRedeemMessage(null)
    let clipboardText = ''

    try {
      const readClipboard = window.electron?.deviceLicense?.readClipboard
      if (readClipboard) {
        try {
          const result = await readClipboard()
          if (result.success) clipboardText = result.text
        } catch (error) {
          console.warn('通过 Electron 读取剪贴板失败，尝试浏览器接口:', error)
        }
      }

      if (!clipboardText && navigator.clipboard?.readText) {
        clipboardText = await navigator.clipboard.readText()
      }

      const code = clipboardText.trim()
      if (!code) {
        setRedeemMessage({ type: 'error', text: '剪贴板中没有可粘贴的内容' })
        return
      }

      setRedeemCode(code)
      setRedeemMessage(null)
    } catch (error) {
      console.error('读取剪贴板失败:', error)
      setRedeemMessage({ type: 'error', text: '无法读取剪贴板，请手动粘贴' })
    }
  }

  const redeemDeviceCode = async () => {
    if (!redeemCode.trim()) {
      setRedeemMessage({ type: 'error', text: '请输入测试码' })
      return
    }
    setRedeemMessage({ type: 'info', text: '正在验证测试码…' })
    try {
      const result = await window.electron?.deviceLicense?.redeem(redeemCode.trim())
      if (!result) {
        setRedeemMessage({ type: 'error', text: '暂时无法提交测试码' })
      } else if (result.success) {
        setDeviceState(previous => ({ ...previous, status: 'ready', grants: result.grants }))
        setRedeemCode('')
        setRedeemMessage(null)
        setShowRedeemModal(false)
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: {
            message: result.message || '测试码验证成功',
            type: 'success',
          },
        }))
      } else {
        setRedeemMessage({ type: 'error', text: result.error })
      }
    } catch (error) {
      console.error('测试码验证失败:', error)
      setRedeemMessage({ type: 'error', text: '测试码验证失败，请重试' })
    }
  }

  /** 打开外部链接：TV 走原生浏览器（ACTION_VIEW），桌面/网页用 window.open */
  const openExternal = (url: string) => {
    const native = (window as any).WaveForgeNative
    if (native?.openExternal) {
      native.openExternal(url)
      return
    }
    window.open(url, '_blank')
  }

  const checkForUpdates = async () => {
    setUpdateCheck({ status: 'checking', message: '正在检查…' })
    try {
      // Android（TV/平板）：交给原生更新器——它知道本机 versionCode 且能下载安装
      const nativeBridge = (window as any).WaveForgeNative
      if (nativeBridge?.checkForUpdates) {
        nativeBridge.checkForUpdates()
        setUpdateCheck({ status: 'current', message: '已开始检查，如有新版本将弹出提示' })
        return
      }

      // 桌面/网页：拉多源更新清单（Gitee 主源 → ghproxy 加速的 GitHub → GitHub 直连），比较版本号
      const { UPDATE_MANIFEST_URLS, withDownloadProxies } = await import('../services/updateConstants')
      let manifest: { version?: string; notes?: string; artifacts?: Record<string, { urls?: string[]; sha256?: string }> } | null = null
      let httpStatus = 0
      for (const url of UPDATE_MANIFEST_URLS) {
        try {
          const res = await fetch(url, { cache: 'no-store' })
          if (res.ok) {
            manifest = await res.json()
            break
          }
          httpStatus = res.status // 404 等：清单大概率还没发布
        } catch {
          // 网络异常，继续尝试下一个源
        }
      }
      if (!manifest?.version) {
        // 区分「未发布」与「网络问题」，方便用户判断
        throw new Error(httpStatus ? `更新清单不可用（HTTP ${httpStatus}），请确认已发布更新` : '更新清单不可用，请检查网络')
      }

      const remoteVersion = String(manifest.version)
      if (compareVersions(remoteVersion, packageInfo.version) <= 0) {
        setUpdateCheck({ status: 'current', message: `当前版本 ${packageInfo.version} 为最新版本` })
        return
      }

      const winArtifact = manifest.artifacts?.['win-x64']
      const hotArtifact = manifest.artifacts?.['win-x64-hot']
      const winUrl = winArtifact?.urls?.[0]
      const hotUrl = hotArtifact?.urls?.[0]
      const detail: UpdateDetail = {
        version: remoteVersion,
        notes: manifest.notes || '',
        hotUrls: hotUrl ? withDownloadProxies(hotUrl) : undefined,
        hotSha: hotArtifact?.sha256 || '',
        installUrls: winUrl ? withDownloadProxies(winUrl) : undefined,
        installSha: winArtifact?.sha256 || '',
      }
      setUpdateDetail(detail)
      setUpdateCheck({ status: 'available', message: `当前版本：${packageInfo.version}  新版本：${getVersionDisplay(remoteVersion)}` })
      // 详情/下载/就绪/重启弹窗由全局 UpdateManager 承接（应用内美化弹窗）
      window.dispatchEvent(new CustomEvent('waveforge:update-open-details', { detail }))
    } catch (error) {
      setUpdateCheck({ status: 'error', message: `检查失败：${error instanceof Error ? error.message : '网络不可用'}` })
    }
  }

  const openUpdateDetails = () => {
    if (updateDetail?.version) {
      window.dispatchEvent(new CustomEvent('waveforge:update-open-details', { detail: updateDetail }))
    }
  }

  // 待更新已就绪：拉起 updater 并立即退出重启（重启后即为新版本）
  const handleRestartForUpdate = async () => {
    await window.electron?.update?.applyPending?.()
    await window.electron?.update?.restartForUpdate?.()
  }

  // 跳过此版本：把当前最新版本记入跳过列表，自动检测不再提示；手动检查仍可更新
  const handleSkipVersion = async () => {
    try {
      const { fetchUpdateManifest } = await import('../services/updateConstants')
      const manifest = await fetchUpdateManifest()
      const remote = manifest?.version
      if (!remote) {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前无法获取更新清单，请稍后再试', type: 'info' } }))
        return
      }
      if (compareVersions(remote, packageInfo.version) <= 0) {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '当前已是最新版本，无需跳过', type: 'info' } }))
        return
      }
      localStorage.setItem('skippedUpdateVersion', remote)
      setSkippedVersion(remote)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已跳过版本 ${getVersionDisplay(remote)} 的更新提示，仍可手动检查更新`, type: 'success' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '跳过失败，请检查网络', type: 'error' } }))
    }
  }

  const handleUnskipVersion = () => {
    localStorage.removeItem('skippedUpdateVersion')
    setSkippedVersion(null)
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已恢复该版本的更新提示', type: 'success' } }))
  }
  
  const [gpuAcceleration, setGpuAcceleration] = useState(() => {
    const saved = localStorage.getItem('gpuAcceleration')
    return parseStoredBoolean(saved, true)
  })
  const [gpuStatus, setGpuStatus] = useState<{
    actualEnabled: boolean
    featureStatus: Record<string, string>
    gpu: { deviceString?: string; vendorString?: string; driverVersion?: string } | null
    gpus: Array<{ deviceString: string; vendorString: string; active: boolean; kind: 'discrete' | 'integrated' | 'unknown' }>
  } | null>(null)
  const [gpuPreference, setGpuPreference] = useState<'auto' | 'discrete' | 'integrated'>('auto')

  // 全局高刷：显示器信息 + 开关 + 可选档位（null = 跟随显示器最高）
  const [highRefreshEnabled, setHighRefreshEnabled] = useState(false)
  const [highRefreshHz, setHighRefreshHz] = useState<number | null>(null)
  const [displayInfo, setDisplayInfo] = useState<{
    highRefreshEnabled: boolean
    highRefreshHz: number | null
    currentHz: number
    primary: number
    mainWindowDisplayId: number
    error?: string
    displays?: Array<{ id: number; isPrimary: boolean; isMainWindow: boolean; bounds: { x: number; y: number; width: number; height: number }; workArea: { x: number; y: number; width: number; height: number }; frequency: number; scaleFactor: number; label: string }>
  } | null>(null)
  const HIGH_REFRESH_OPTIONS = [30, 60, 120, 144, 200, 240, 300, 360]

  const refreshDisplayInfo = useCallback(() => {
    void window.electron?.display?.getInfo().then(info => {
      if (!info) return
      setHighRefreshEnabled(Boolean(info.highRefreshEnabled))
      setHighRefreshHz(info.highRefreshHz ?? null)
      setDisplayInfo(info)
    }).catch(error => console.warn('读取显示器信息失败:', error))
  }, [])

  useEffect(() => { refreshDisplayInfo() }, [refreshDisplayInfo])

  const handleHighRefreshToggle = async (enabled: boolean) => {
    setHighRefreshEnabled(enabled)
    try {
      // 开启时默认跟随显示器最高（null）；用户后续可在档位里改
      const result = await window.electron?.display.setHighRefresh(enabled, enabled ? highRefreshHz : null)
      if (result) setHighRefreshEnabled(result.enabled)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: enabled ? `全局高刷已开启（${result?.hz || '跟随显示器'}Hz）` : '已关闭全局高刷', type: 'info' } }))
      refreshDisplayInfo()
    } catch (error) {
      setHighRefreshEnabled(!enabled)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '切换全局高刷失败，请重试', type: 'error' } }))
    }
  }

  const handleHighRefreshHzChange = async (hz: number | null) => {
    setHighRefreshHz(hz)
    if (!highRefreshEnabled) return
    try {
      const result = await window.electron?.display.setHighRefresh(true, hz)
      if (result) window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已切换为 ${hz || '跟随显示器最高'}Hz`, type: 'info' } }))
      refreshDisplayInfo()
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '切换刷新率失败，请重试', type: 'error' } }))
    }
  }

  useEffect(() => {
    let cancelled = false
    void window.electron?.system.getHardwareAcceleration().then(result => {
      if (cancelled) return
      setGpuAcceleration(result.enabled)
      setGpuPreference(result.gpuPreference || 'discrete')
      setGpuStatus({
        actualEnabled: result.actualEnabled,
        featureStatus: result.featureStatus,
        gpu: result.gpu,
        gpus: result.gpus || [],
      })
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
    }).catch(error => console.warn('读取硬件加速设置失败:', error))
    return () => { cancelled = true }
  }, [])

  const [audioAnalyzerEnabled, setAudioAnalyzerEnabled] = useState(() => {
    const saved = localStorage.getItem('audioAnalyzerEnabled')
    return parseStoredBoolean(saved, true)
  })

  // 开发者模式（调试阶段 TV 端默认开，正式版默认关）
  const [developerMode, setDeveloperMode] = useState(() => {
    const saved = localStorage.getItem('developerMode')
    return parseStoredBoolean(saved, isTvModeActive())
  })
  // 过渡调试：开启后切歌/过渡时右上角弹窗显示引擎/策略/DJ 效果清单
  const [transitionDebugEnabled, setTransitionDebugEnabled] = useState(() => {
    try {
      return localStorage.getItem('waveforge:transition-debug') === '1'
    } catch {
      return false
    }
  })
  const handleTransitionDebugToggle = (enabled: boolean) => {
    setTransitionDebugEnabled(enabled)
    try {
      localStorage.setItem('waveforge:transition-debug', enabled ? '1' : '0')
    } catch {
      // 忽略持久化失败（隐身模式等）
    }
  }

  // 全屏模式设置
  const [fullscreenMode, setFullscreenMode] = useState<'kiosk' | 'normal'>(() => {
    const saved = localStorage.getItem('fullscreenMode')
    return (saved as 'kiosk' | 'normal') || 'kiosk'
  })

  // 视频播放完毕行为设置
  const [videoEndBehavior, setVideoEndBehavior] = useState<'next' | 'close' | 'replay'>(() => {
    const saved = localStorage.getItem('videoEndBehavior')
    return (saved as 'next' | 'close' | 'replay') || 'close'
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
  
  // 预设主题色
  const presetColors = [
    { name: '天空蓝', value: '#3B82F6' },
    { name: '翡翠绿', value: '#10B981' },
    { name: '紫罗兰', value: '#8B5CF6' },
    { name: '玫瑰红', value: '#EC4899' },
    { name: '橙黄色', value: '#F59E0B' },
    { name: '珊瑚红', value: '#EF4444' },
    { name: '青色', value: '#06B6D4' },
    { name: '石板灰', value: '#64748B' },
  ]

  // 保存逐字歌词设置
  const handleWordByWordToggle = (enabled: boolean) => {
    setWordByWordLyrics(enabled)
    localStorage.setItem('wordByWordLyrics', JSON.stringify(enabled))
    // 触发自定义事件，通知其他组件
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
  }

  // 保存即将播放提示设置
  const handleUpNextToggle = (enabled: boolean) => {
    setUpNextEnabled(enabled)
    localStorage.setItem('upNextEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('upNextEnabledChanged'))
  }

  const handleShowUpNextOutsidePlayerToggle = (enabled: boolean) => {
    setShowUpNextOutsidePlayer(enabled)
    localStorage.setItem('showUpNextOutsidePlayer', JSON.stringify(enabled))
    window.dispatchEvent(new Event('showUpNextOutsidePlayerChanged'))
  }
  
  const handleUpNextSecondsChange = (seconds: number) => {
    const newSeconds = Math.max(5, Math.min(30, seconds))
    setUpNextSeconds(newSeconds)
    localStorage.setItem('upNextSeconds', newSeconds.toString())
    window.dispatchEvent(new CustomEvent('upNextSecondsChanged', { detail: newSeconds }))
  }

  // 保存翻译设置
  const handleTranslationToggle = (enabled: boolean) => {
    setTranslationEnabled(enabled)
    localStorage.setItem('translationEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }

  const handleTranslationPositionChange = (position: 'traditional' | 'bottom-right') => {
    setTranslationPosition(position)
    localStorage.setItem('translationPosition', position)
    window.dispatchEvent(new Event('translationSettingsChanged'))
  }
  
  // 保存主题色设置
  const handleAccentColorChange = (color: string) => {
    setAccentColor(color)
    localStorage.setItem('accentColor', color)
    window.dispatchEvent(new CustomEvent('accentColorChanged', { detail: color }))
  }

  const updatePlaybackShortcutSettings = (patch: Partial<PlaybackShortcutSettings>) => {
    setPlaybackShortcutSettings(savePlaybackShortcutSettings(patch))
  }
  
  const handleGpuAccelerationToggle = async (enabled: boolean) => {
    try {
      const result = await window.electron?.system.setHardwareAcceleration(enabled)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuAcceleration(result.enabled)
      localStorage.setItem('gpuAcceleration', JSON.stringify(result.enabled))
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result.enabled ? 'GPU 加速已打开，重启软件后生效' : 'GPU 加速已关闭，重启软件后生效', type: 'info' }
      }))
    } catch (error) {
      console.error('保存硬件加速设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '硬件加速设置保存失败', type: 'error' }
      }))
    }
  }

  const handleGpuPreferenceChange = async (preference: 'auto' | 'discrete' | 'integrated') => {
    try {
      const result = await window.electron?.system.setGpuPreference(preference)
      if (!result?.success) throw new Error('主进程未保存设置')
      setGpuPreference(result.gpuPreference)
      const labels: Record<'auto' | 'discrete' | 'integrated', string> = {
        auto: '自动',
        discrete: '独立显卡',
        integrated: '核显',
      }
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: `已切换为${labels[result.gpuPreference]}，重启软件后生效`, type: 'info' }
      }))
    } catch (error) {
      console.error('保存显卡偏好设置失败:', error)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '显卡偏好设置保存失败', type: 'error' }
      }))
    }
  }

  const handleAudioAnalyzerToggle = (enabled: boolean) => {
    setAudioAnalyzerEnabled(enabled)
    localStorage.setItem('audioAnalyzerEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new CustomEvent('audioAnalyzerEnabledChanged', { detail: enabled }))
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { message: enabled ? '音频频谱分析已启用' : '音频频谱分析已禁用（性能模式）', type: 'success' }
    }))
  }

  // 开发者模式切换
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

  // 全屏模式切换
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
  
  // 视频播放完毕行为设置
  const handleVideoEndBehaviorChange = (behavior: 'next' | 'close' | 'replay') => {
    setVideoEndBehavior(behavior)
    localStorage.setItem('videoEndBehavior', behavior)
    window.dispatchEvent(new CustomEvent('videoEndBehaviorChanged', { detail: behavior }))
    
    const messages = {
      close: '视频播放完毕后将显示重播按钮',
      replay: '视频播放完毕后将自动重播',
      next: '视频播放完毕后将自动续播下一个'
    }
    
    window.dispatchEvent(new CustomEvent('showToast', { 
      detail: { 
        message: messages[behavior], 
        type: 'success' 
      }
    }))
  }
  
  // Crossfade 和 Gapless 设置
  const [crossfadeEnabled, setCrossfadeEnabled] = useState(() => {
    const saved = localStorage.getItem('crossfadeEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [crossfadeDuration, setCrossfadeDuration] = useState(() => {
    const saved = localStorage.getItem('crossfadeDuration')
    return saved ? parseFloat(saved) : 4
  })
  
  const [gaplessEnabled, setGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('gaplessEnabled')
    return parseStoredBoolean(saved, false)
  })
  
  const [albumGaplessEnabled, setAlbumGaplessEnabled] = useState(() => {
    const saved = localStorage.getItem('albumGaplessEnabled')
    return parseStoredBoolean(saved, true)
  })
  
  const [autoMixEnabled, setAutoMixEnabled] = useState(() => {
    const saved = localStorage.getItem('autoMixEnabled')
    return parseStoredBoolean(saved, false)
  })

  const [autoMixBeatMatching, setAutoMixBeatMatching] = useState(() => {
    const saved = localStorage.getItem('autoMixBeatMatching')
    return parseStoredBoolean(saved, true)
  })

  const [autoMixSkipSilence, setAutoMixSkipSilence] = useState(() => {
    const saved = localStorage.getItem('autoMixSkipSilence')
    return parseStoredBoolean(saved, true)
  })

  const [autoMixMinDuration, setAutoMixMinDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMinDuration')
    return saved ? parseFloat(saved) : 2
  })

  const [autoMixMaxDuration, setAutoMixMaxDuration] = useState(() => {
    const saved = localStorage.getItem('autoMixMaxDuration')
    return saved ? parseFloat(saved) : 12
  })
  const [autoMixEnhanced, setAutoMixEnhanced] = useState(() => {
    const saved = localStorage.getItem('autoMixEnhanced')
    return parseStoredBoolean(saved, false)
  })
  const [autoMixTransitionIntensity, setAutoMixTransitionIntensity] = useState<'subtle' | 'standard' | 'strong'>(() => {
    const saved = localStorage.getItem('autoMixTransitionIntensity')
    return saved === 'subtle' || saved === 'strong' ? saved : 'standard'
  })
  const [autoMixAiMix, setAutoMixAiMix] = useState(() => {
    const saved = localStorage.getItem('autoMixAiMix')
    return parseStoredBoolean(saved, false)
  })
  // AI 混音引擎可用性（null=检测中 / true=可用 / false=未安装）
  const [aiMixAvailable, setAiMixAvailable] = useState<boolean | null>(null)
  // 序号防竞态：模型下载完成/删除后的重探不能覆盖更早的在途结果
  const aiMixProbeSeq = useRef(0)
  const probeAiMixAvailable = useCallback(async () => {
    const seq = ++aiMixProbeSeq.current
    try {
      const status = await window.electron?.render?.aiMixStatus?.()
      if (seq === aiMixProbeSeq.current) setAiMixAvailable(status?.available === true)
    } catch {
      if (seq === aiMixProbeSeq.current) setAiMixAvailable(false)
    }
  }, [])
  useEffect(() => {
    if (!autoMixEnabled || !autoMixEnhanced) return
    setAiMixAvailable(null)
    void probeAiMixAvailable()
  }, [autoMixEnabled, autoMixEnhanced, probeAiMixAvailable])

  // AI 混音模型（DJTransGAN 仓库 + 权重）下载/删除管理
  const [aiModelStatus, setAiModelStatus] = useState<{
    installed: boolean
    repoReady: boolean
    weightsReady: boolean
    pythonFound: boolean
    depsReady: boolean
    engineAvailable: boolean
    repoDir: string
  } | null>(null)
  const [aiModelProgress, setAiModelProgress] = useState<{
    status: 'idle' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled' | 'deleting'
    phase: 'python' | 'pip' | 'deps' | 'repo' | 'weights' | 'delete' | null
    phaseLabel: string | null
    phasePercent: number
    overallPercent: number
    error: string | null
    done: boolean
    downloadSpeed: number
    downloadEta: number | null
  } | null>(null)
  const [showAiModelDownloadDialog, setShowAiModelDownloadDialog] = useState(false)
  const [showAiModelDeleteDialog, setShowAiModelDeleteDialog] = useState(false)

  // AutoMix Enhanced 核心的可选 HTDemucs 分轨模型。未安装时增强版仍使用现有 v2 DSP。
  const [stemModelStatus, setStemModelStatus] = useState<{
    installed: boolean
    modelReady: boolean
    runtimeReady: boolean
    supported: boolean
    modelPath: string
    runtimePath: string
    root: string
    version: number
    download: StemModelProgress
  } | null>(null)
  const [stemModelProgress, setStemModelProgress] = useState<StemModelProgress | null>(null)
  const probeStemModelStatus = useCallback(async () => {
    try {
      const status = await window.electron?.stemModel?.getStatus?.()
      if (status) {
        setStemModelStatus(status)
        if (status.download?.status && status.download.status !== 'idle') setStemModelProgress(status.download)
      }
    } catch { /* 可选模型探测失败保持 v2 DSP */ }
  }, [])
  useEffect(() => {
    if (!autoMixEnabled || !autoMixEnhanced) return
    void probeStemModelStatus()
    const off = window.electron?.stemModel?.onProgress?.((progress) => {
      setStemModelProgress(progress)
      if (progress.status === 'done') {
        void probeStemModelStatus()
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: 'HTDemucs 分轨模型安装完成，增强版将自动使用分轨混音', type: 'success' },
        }))
      }
    })
    return () => off?.()
  }, [autoMixEnabled, autoMixEnhanced, probeStemModelStatus])
  const handleStemModelDownload = () => {
    const confirmed = window.confirm('下载 HTDemucs 分轨模型与运行环境？\n\n下载约 138MB，安装后 AutoMix 增强版会自动使用人声/鼓/贝斯分轨混音；不下载也可继续使用 DSP 兼容模式。')
    if (!confirmed) return
    void window.electron?.stemModel?.download?.()
  }
  const handleStemModelResume = () => { void window.electron?.stemModel?.download?.() }
  const handleStemModelPause = () => { void window.electron?.stemModel?.pause?.() }
  const handleStemModelCancel = () => { void window.electron?.stemModel?.cancel?.(); setStemModelProgress(null) }
  const handleStemModelDelete = () => {
    const confirmed = window.confirm('删除 HTDemucs 分轨模型和运行环境？\n\nAutoMix 增强版会继续使用 DSP 兼容模式，标准 AutoMix 不受影响。')
    if (!confirmed) return
    window.dispatchEvent(new Event('waveforge:track-stem-cache-clearing'))
    void window.electron?.stemModel?.delete?.().then(result => {
      if (result?.ok) {
        setStemModelProgress(null)
        void probeStemModelStatus()
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已删除 HTDemucs 模型，增强版继续使用 DSP 兼容模式', type: 'success' } }))
      }
    })
  }

  const probeAiModelStatus = useCallback(async () => {
    try {
      const status = await window.electron?.aiModel?.getStatus?.()
      if (status) setAiModelStatus(status)
    } catch { /* 探测失败保持现状 */ }
  }, [])

  useEffect(() => {
    if (!autoMixEnabled || !autoMixEnhanced) return
    void probeAiModelStatus()
    const off = window.electron?.aiModel?.onProgress?.((progress) => {
      setAiModelProgress(progress)
      // 下载完成（含从暂停/错误恢复后完成）：toast 提示，并重探引擎可用性（
      // 开关的 aiMixAvailable 之前探测时权重可能还没就绪）
      if (progress.done && progress.status === 'done') {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: 'DJTransGAN 模型下载完成，AI 混音已可用', type: 'success' },
        }))
        void probeAiModelStatus()
        void probeAiMixAvailable()
      }
    })
    return () => off?.()
  }, [autoMixEnabled, autoMixEnhanced, probeAiModelStatus, probeAiMixAvailable])

  const handleAiModelDownload = () => {
    setShowAiModelDownloadDialog(false)
    void window.electron?.aiModel?.download?.()
  }
  const handleAiModelPause = () => {
    void window.electron?.aiModel?.pause?.()
  }
  const handleAiModelResume = () => {
    void window.electron?.aiModel?.download?.()
  }
  const handleAiModelCancel = () => {
    void window.electron?.aiModel?.cancel?.()
    setAiModelProgress(null)
  }
  const handleAiModelDelete = () => {
    setShowAiModelDeleteDialog(false)
    void (async () => {
      const result = await window.electron?.aiModel?.delete?.()
      if (result?.ok) {
        // DJTransGAN 是严格可选扩展：删除模型同时持久化关闭，避免后续计划继续
        // 标记 aiMix=true、反复冷启动失败后才回退 DSP。
        setAutoMixAiMix(false)
        localStorage.setItem('autoMixAiMix', 'false')
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '已删除 DJTransGAN 模型并关闭实验扩展', type: 'success' },
        }))
        setAiModelProgress(null)
      } else {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: result?.error || '删除模型失败', type: 'error' },
        }))
      }
      void probeAiModelStatus()
      void probeAiMixAvailable() // 删除后同步禁用 AI 混音开关
    })()
  }

  // ── 代理自动配置（高级设置）：网络不佳时扫描本地代理端口，模型下载/更新走代理 ──
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyScanning, setProxyScanning] = useState(false)
  const [proxyList, setProxyList] = useState<Array<{ host: string; port: number; type: string; latency: number }>>([])
  const [proxyState, setProxyState] = useState<{ enabled: boolean; proxy: { host: string; port: number; type: string } | null }>({ enabled: false, proxy: null })
  const [proxyLatency, setProxyLatency] = useState<{
    status: 'testing' | 'done'
    result: {
      baidu: { timeout: boolean; total: number; loss: number; lossRate: number; avgLatency: number; minLatency: number; maxLatency: number }
      github: { timeout: boolean; total: number; loss: number; lossRate: number; avgLatency: number; minLatency: number; maxLatency: number }
      google: { timeout: boolean; total: number; loss: number; lossRate: number; avgLatency: number; minLatency: number; maxLatency: number }
    } | null
  } | null>(null)

  // 触发联通测试并展示（开关开启/重启仍开启时后台测）；75s 兜底超时显示"连接超时"
  const probeAndShow = () => {
    setProxyLatency({ status: 'testing', result: null })
    const timeoutResult = {
      baidu: { timeout: true, total: 0, loss: 0, lossRate: 100, avgLatency: 0, minLatency: 0, maxLatency: 0 },
      github: { timeout: true, total: 0, loss: 0, lossRate: 100, avgLatency: 0, minLatency: 0, maxLatency: 0 },
      google: { timeout: true, total: 0, loss: 0, lossRate: 100, avgLatency: 0, minLatency: 0, maxLatency: 0 },
    }
    const guard = window.setTimeout(() => setProxyLatency({ status: 'done', result: timeoutResult }), 75_000)
    void window.electron?.proxyManager?.probe?.()
      .then((r) => { window.clearTimeout(guard); if (r) setProxyLatency(r) })
      .catch(() => { window.clearTimeout(guard); setProxyLatency({ status: 'done', result: timeoutResult }) })
  }

  useEffect(() => {
    const refresh = () => {
      void window.electron?.proxyManager?.getState?.().then((s) => {
        if (s) { setProxyEnabled(s.enabled); setProxyState(s) }
      }).catch(() => {})
      // 功能开启时测 ping（重启后仍开启：后台测完填入）
      void window.electron?.proxyManager?.getLatency?.().then((r) => {
        if (r) setProxyLatency(r)
        else if (proxyEnabled) probeAndShow()
      }).catch(() => {})
    }
    refresh()
    // 主进程自动关闭（运行中断开/启动无代理）时同步开关状态
    const off = window.electron?.proxyManager?.onNotice?.(() => refresh())
    const offLatency = window.electron?.proxyManager?.onLatency?.((r) => { if (r) setProxyLatency(r) })
    return () => { off?.(); offLatency?.() }
  }, [])

  const handleProxyToggle = (enabled: boolean) => {
    setProxyEnabled(enabled)
    if (!enabled) {
      void window.electron?.proxyManager?.disable?.().then((s) => { if (s) setProxyState(s) }).catch(() => {})
      setProxyList([])
      return
    }
    // 开启：扫描本地代理端口并自动选最优
    setProxyScanning(true)
    void (async () => {
      try {
        const list = await window.electron?.proxyManager?.scan?.()
        const found = list || []
        setProxyList(found)
        if (found.length > 0) {
          const best = found[0]
          const s = await window.electron?.proxyManager?.enable?.(best.port)
          if (s) { setProxyState(s); setProxyEnabled(true) }
          probeAndShow() // 开启即测一次 ping 延迟/丢包
          window.dispatchEvent(new CustomEvent('showToast', {
            detail: { message: `已自动配置代理 127.0.0.1:${best.port}（延迟 ${best.latency}ms）`, type: 'success' },
          }))
        } else {
          setProxyEnabled(false)
          window.dispatchEvent(new CustomEvent('showToast', {
            detail: { message: '未检测到可用的本地代理，请确认代理软件已开启', type: 'error' },
          }))
        }
      } catch {
        setProxyEnabled(false)
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '代理扫描失败', type: 'error' },
        }))
      } finally {
        setProxyScanning(false)
      }
    })()
  }

  const handleProxyRescan = () => {
    setProxyScanning(true)
    void (async () => {
      try {
        const list = await window.electron?.proxyManager?.scan?.()
        const found = list || []
        setProxyList(found)
        if (found.length > 0) {
          const best = found[0]
          const s = await window.electron?.proxyManager?.enable?.(best.port)
          if (s) setProxyState(s)
        } else {
          window.dispatchEvent(new CustomEvent('showToast', {
            detail: { message: '未检测到可用的本地代理', type: 'error' },
          }))
        }
      } catch {
        window.dispatchEvent(new CustomEvent('showToast', {
          detail: { message: '代理扫描失败', type: 'error' },
        }))
      } finally {
        setProxyScanning(false)
      }
    })()
  }
  
  const handleCrossfadeToggle = (enabled: boolean) => {
    // Crossfade 和 AutoMix、Gapless 互斥
    if (enabled) {
      if (autoMixEnabled) {
        setAutoMixEnabled(false)
        localStorage.setItem('autoMixEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
      }
      if (gaplessEnabled) {
        setGaplessEnabled(false)
        localStorage.setItem('gaplessEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
      }
    }
    setCrossfadeEnabled(enabled)
    localStorage.setItem('crossfadeEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleCrossfadeDurationChange = (duration: number) => {
    const newDuration = Math.max(1, Math.min(12, duration))
    setCrossfadeDuration(newDuration)
    localStorage.setItem('crossfadeDuration', newDuration.toString())
    window.dispatchEvent(new Event('crossfadeSettingsChanged'))
  }
  
  const handleGaplessToggle = (enabled: boolean) => {
    // Gapless 和 Crossfade、AutoMix 互斥
    if (enabled) {
      if (crossfadeEnabled) {
        setCrossfadeEnabled(false)
        localStorage.setItem('crossfadeEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      }
      if (autoMixEnabled) {
        setAutoMixEnabled(false)
        localStorage.setItem('autoMixEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('autoMixSettingsChanged'))
      }
    }
    setGaplessEnabled(enabled)
    localStorage.setItem('gaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('gaplessSettingsChanged'))
  }
  
  const handleAlbumGaplessToggle = (enabled: boolean) => {
    setAlbumGaplessEnabled(enabled)
    localStorage.setItem('albumGaplessEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('albumGaplessSettingsChanged'))
  }

  const handleAutoMixToggle = (enabled: boolean) => {
    // AutoMix 和 Crossfade、Gapless 互斥
    if (enabled) {
      if (crossfadeEnabled) {
        setCrossfadeEnabled(false)
        localStorage.setItem('crossfadeEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('crossfadeSettingsChanged'))
      }
      if (gaplessEnabled) {
        setGaplessEnabled(false)
        localStorage.setItem('gaplessEnabled', JSON.stringify(false))
        window.dispatchEvent(new Event('gaplessSettingsChanged'))
      }
    }
    setAutoMixEnabled(enabled)
    localStorage.setItem('autoMixEnabled', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
    // 探针：用户点击开关的瞬间写入后端日志（独立于 App 的事件链）
    window.electron?.automixLog?.('settings-toggle', `autoMixEnabled=${enabled}`).catch(() => undefined)
  }

  const handleAutoMixBeatMatchingToggle = (enabled: boolean) => {
    setAutoMixBeatMatching(enabled)
    localStorage.setItem('autoMixBeatMatching', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixSkipSilenceToggle = (enabled: boolean) => {
    setAutoMixSkipSilence(enabled)
    localStorage.setItem('autoMixSkipSilence', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixMinDurationChange = (duration: number) => {
    const newDuration = Math.max(1, Math.min(autoMixMaxDuration - 1, duration))
    setAutoMixMinDuration(newDuration)
    localStorage.setItem('autoMixMinDuration', newDuration.toString())
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }

  const handleAutoMixMaxDurationChange = (duration: number) => {
    const newDuration = Math.max(autoMixMinDuration + 1, Math.min(20, duration))
    setAutoMixMaxDuration(newDuration)
    localStorage.setItem('autoMixMaxDuration', newDuration.toString())
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
  }
  const handleAutoMixEnhancedChange = (enabled: boolean) => {
    setAutoMixEnhanced(enabled)
    localStorage.setItem('autoMixEnhanced', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
    window.electron?.automixLog?.('settings-toggle', `autoMixEnhanced=${enabled}`).catch(() => undefined)
  }
  const handleAutoMixIntensityChange = (intensity: 'subtle' | 'standard' | 'strong') => {
    setAutoMixTransitionIntensity(intensity)
    localStorage.setItem('autoMixTransitionIntensity', intensity)
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
    window.electron?.automixLog?.('settings-toggle', `autoMixTransitionIntensity=${intensity}`).catch(() => undefined)
  }
  const handleAutoMixAiMixToggle = (enabled: boolean) => {
    setAutoMixAiMix(enabled)
    localStorage.setItem('autoMixAiMix', JSON.stringify(enabled))
    window.dispatchEvent(new Event('autoMixSettingsChanged'))
    window.electron?.automixLog?.('settings-toggle', `autoMixAiMix=${enabled}`).catch(() => undefined)
  }

  // 深浅色主题：与播放页快捷设置共用同一存储与事件，App 监听后统一更新
  const handlePlayerThemeChange = (newTheme: 'dark' | 'light') => {
    localStorage.setItem('playerTheme', newTheme)
    window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: newTheme }))
  }

  return (
    <AnimatePresence>
      {show && (
        <React.Fragment key="settings-modal">
          {/* 背景遮罩 */}
          <motion.div
            key="settings-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          onClick={onClose}
          className={`fixed inset-0 backdrop-blur-sm z-40 ${playerTheme === 'dark' ? 'bg-black/60' : 'bg-white/40'}`}
        />

        {/* 设置面板 */}
        <motion.div
            key="settings-panel"
            data-tv-scope
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            className={`fixed right-0 top-0 h-full w-full z-50 shadow-2xl overflow-hidden ${isTvModeActive() ? 'max-w-2xl' : 'max-w-md'}`}
          >
            {/* 液态玻璃背景层 - 增强版 */}
            <div className="absolute inset-0">
              {/* 主背景 - 根据主题变化 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(15,15,25,0.85) 30%, rgba(25,15,35,0.8) 70%, rgba(0,0,0,0.75) 100%)'
                    : 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(245,245,250,0.85) 30%, rgba(250,245,255,0.8) 70%, rgba(255,255,255,0.75) 100%)',
                  backdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                  WebkitBackdropFilter: 'blur(24px) saturate(170%) brightness(1.05)',
                }}
              />
              
              {/* 多层光泽效果 */}
              <div 
                className="absolute inset-0"
                style={{
                  background: playerTheme === 'dark'
                    ? 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.15) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.08) 0%, transparent 40%)'
                    : 'radial-gradient(circle at 20% 15%, rgba(255,255,255,0.9) 0%, transparent 40%), radial-gradient(circle at 80% 85%, rgba(255,255,255,0.5) 0%, transparent 40%)',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 细微噪点纹理 */}
              <div 
                className="absolute inset-0 opacity-30"
                style={{
                  backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 200 200\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\' opacity=\'0.05\'/%3E%3C/svg%3E")',
                  pointerEvents: 'none',
                }}
              />
              
              {/* 左边框高光 - 增强版 */}
              <div 
                className="absolute inset-y-0 left-0 w-px"
                style={{
                  background: playerTheme === 'dark'
                    ? 'linear-gradient(to bottom, transparent, rgba(255,255,255,0.3), transparent)'
                    : 'linear-gradient(to bottom, transparent, rgba(0,0,0,0.2), transparent)',
                }}
              />
              
              {/* 边框高光 */}
              <div 
                className="absolute inset-0"
                style={{
                  border: playerTheme === 'dark' 
                    ? '1.5px solid rgba(255,255,255,0.2)'
                    : '1.5px solid rgba(0,0,0,0.15)',
                  boxShadow: playerTheme === 'dark'
                    ? '0 20px 60px rgba(0,0,0,0.5), 0 0 1px rgba(255,255,255,0.2), inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -1px 1px rgba(0,0,0,0.2)'
                    : '0 20px 60px rgba(0,0,0,0.2), 0 0 1px rgba(255,255,255,0.8), inset 0 1px 1px rgba(255,255,255,0.9), inset 0 -1px 1px rgba(0,0,0,0.05)',
                  pointerEvents: 'none',
                  borderRadius: '0',
                }}
              />
            </div>
            
            {/* Content area */}
            <div className="relative z-10 h-full flex flex-col">
            {/* 头部 */}
            <div className={`flex items-center justify-between p-6 border-b ${
              playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
            }`}>
              <div className="flex items-center gap-3">
                <SettingsIcon className={`w-6 h-6 ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`} />
                <h2 className={`text-2xl font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>设置</h2>
              </div>
              <button
                onClick={onClose}
                className="relative p-2 rounded-full transition-all duration-300 group overflow-hidden"
                style={{
                  backdropFilter: 'blur(20px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                }}
              >
                {/* 液态玻璃背景层 */}
                <div 
                  className="absolute inset-0 transition-all duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)'
                      : 'linear-gradient(135deg, rgba(0,0,0,0.08) 0%, rgba(0,0,0,0.04) 100%)',
                    backdropFilter: 'blur(20px)',
                    WebkitBackdropFilter: 'blur(20px)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* Hover 效果层 */}
                <div 
                  className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'radial-gradient(circle at center, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0.1) 100%)'
                      : 'radial-gradient(circle at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.08) 100%)',
                    borderRadius: '9999px',
                  }}
                />
                
                {/* 边框光泽 */}
                <div 
                  className="absolute inset-0"
                  style={{
                    border: playerTheme === 'dark' 
                      ? '1px solid rgba(255,255,255,0.2)'
                      : '1px solid rgba(0,0,0,0.15)',
                    borderRadius: '9999px',
                    boxShadow: playerTheme === 'dark'
                      ? 'inset 0 1px 1px rgba(255,255,255,0.2), 0 2px 8px rgba(0,0,0,0.2)'
                      : 'inset 0 1px 1px rgba(255,255,255,0.5), 0 2px 8px rgba(0,0,0,0.1)',
                  }}
                />
                
                <ChevronLeft className={`w-6 h-6 relative z-10 transition-transform duration-300 group-hover:scale-110 ${
                  playerTheme === 'dark' ? 'text-white/80' : 'text-black/80'
                }`} />
              </button>
            </div>

            {/* Tabs：激活项下方为蓝色指示条（layoutId 共享布局动画，切换时丝滑滑到选中 tab 下方） */}
            <div className={`relative flex border-b ${playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'}`}>
              {isTvModeActive() && (
                <button
                  onClick={() => switchTab('tv')}
                  className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                    activeTab === 'tv'
                      ? playerTheme === 'dark'
                        ? 'text-white'
                        : 'text-black'
                      : playerTheme === 'dark'
                      ? 'text-white/60 hover:text-white/80'
                      : 'text-black/60 hover:text-black/80'
                  }`}
                >
                  <MonitorSmartphone className="w-5 h-5" />
                  TV设置
                  {activeTab === 'tv' && (
                    <motion.div
                      layoutId="settings-tab-indicator"
                      className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                      style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                </button>
              )}
              <button
                onClick={() => switchTab('account')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'account'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <User className="w-5 h-5" />
                账号
                {activeTab === 'account' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('personalization')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'personalization'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Sparkles className="w-5 h-5" />
                个性化
                {activeTab === 'personalization' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('advanced')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'advanced'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Palette className="w-5 h-5" />
                高级
                {activeTab === 'advanced' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
              <button
                onClick={() => switchTab('about')}
                className={`relative flex-1 py-4 px-4 flex items-center justify-center gap-2 transition-colors ${
                  activeTab === 'about'
                    ? playerTheme === 'dark'
                      ? 'text-white'
                      : 'text-black'
                    : playerTheme === 'dark'
                    ? 'text-white/60 hover:text-white/80'
                    : 'text-black/60 hover:text-black/80'
                }`}
              >
                <Info className="w-5 h-5" />
                关于
                {activeTab === 'about' && (
                  <motion.div
                    layoutId="settings-tab-indicator"
                    className="absolute bottom-0 left-1/4 right-1/4 h-[3px] rounded-full"
                    style={{ backgroundColor: accentColor, boxShadow: `0 0 8px ${accentColor}66` }}
                    transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                  />
                )}
              </button>
            </div>

            {/* Content area */}
            <div ref={contentScrollRef} className="p-6 overflow-y-auto h-[calc(100vh-140px)]">
              {activeTab === 'tv' && (
                <div className="space-y-6">
                  {/* 远程遥控器 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>远程遥控器</h3>
                    <div className="space-y-3">
                      {/* 扫码配对（打开 App 层的 RemoteControlModal） */}
                      <button
                        onClick={() => onOpenRemote?.()}
                        className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                            <MonitorSmartphone className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div className="text-left min-w-0">
                            <div className={`${textPrimary} font-medium`}>扫码配对手机遥控</div>
                            <div className={`${textSecondary} text-sm truncate`}>手机扫码，用手机遥控 TV</div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                      </button>

                      {/* 遥控器个性化（外观/右上角按钮/手势） */}
                      <button
                        onClick={() => setShowRemoteSettings(true)}
                        className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                            <SettingsIcon className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div className="text-left min-w-0">
                            <div className={`${textPrimary} font-medium`}>遥控器个性化</div>
                            <div className={`${textSecondary} text-sm truncate`}>外观 · 右上角按钮 · 触摸板手势</div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                      </button>

                      {/* 每次启动自动打开远程遥控器 */}
                      <label className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} flex items-center justify-between gap-6 cursor-pointer`}>
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium`}>每次启动自动打开远程遥控器</div>
                          <div className={`${textSecondary} text-sm mt-0.5`}>开机后自动弹出手机配对二维码，免去先用遥控器进入</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={tvAutoOpenRemote}
                            onChange={(event) => toggleTvAutoOpenRemote(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: tvAutoOpenRemote ? accentColor : '' }} />
                        </label>
                      </label>

                      {/* 遥控器可视化（按键教学） */}
                      <button
                        onClick={() => setShowRemoteGuide(true)}
                        className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                            <Gamepad2 className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div className="text-left min-w-0">
                            <div className={`${textPrimary} font-medium`}>遥控器可视化</div>
                            <div className={`${textSecondary} text-sm truncate`}>认识遥控器按键 · 逐个动画演示</div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                      </button>
                    </div>
                  </div>

                  {/* 设备配置检查 + 性能模式 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>性能与设备</h3>
                    <div className={`${bgCard} rounded-2xl border ${borderColor} p-4`}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium`}>设备配置检查</div>
                          <div className={`${textSecondary} text-sm mt-0.5`}>查看 TV 内存/存储/CPU，选择性能模式</div>
                        </div>
                        <button
                          onClick={() => setShowDeviceInfo(true)}
                          className="shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
                          style={{ backgroundColor: accentColor }}
                        >
                          配置检查
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* DPI 适配（TV 端界面缩放 + 显示器信息） */}
                  <div className="mt-6">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>DPI 适配</h3>
                    <div className={`${bgCard} rounded-2xl border ${borderColor} p-4`}>
                      <div className={`${textPrimary} font-medium mb-1`}>界面缩放</div>
                      <div className={`${textSecondary} text-sm mb-3`}>按电视尺寸调整 UI 大小，实时生效</div>
                      <div className="flex flex-wrap gap-2">
                        {TV_SCALE_OPTIONS.map(v => (
                          <button
                            key={v}
                            onClick={() => previewTvScale(v)}
                            className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                              tvScale === v ? 'text-white' : `${hoverBg} ${textSecondary}`
                            }`}
                            style={tvScale === v ? { backgroundColor: accentColor } : undefined}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      <div className={`mt-4 pt-3 border-t ${borderColor} space-y-1.5`}>
                        <div className={`${textSecondary} text-sm`}>分辨率：<span className={textPrimary}>{tvInfo?.screenPx || '—'}</span></div>
                        <div className={`${textSecondary} text-sm`}>刷新率：<span className={textPrimary}>{tvInfo?.refreshRate || '—'}</span></div>
                        <div className={`${textSecondary} text-sm`}>显示模式：<span className={textPrimary}>{tvInfo?.displayMode || '—'}</span></div>
                        <div className={`${textSecondary} text-sm`}>HDR：<span className={textPrimary}>{tvInfo?.hdr ? '支持' : '不支持'}</span></div>
                      </div>
                    </div>
                  </div>

                  {/* 设备授权（与 PC 端关于页统一设计） */}
                  <div>
                    <div className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                      <div className="flex items-start gap-4 mb-4">
                        <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
                          <KeyRound className="w-5 h-5" />
                        </div>
                        <div className="min-w-0">
                          <h3 className={`text-lg font-semibold ${textPrimary}`}>设备授权</h3>
                          <p className={`text-sm ${textSecondary} mt-1.5 leading-6`}>仅用作设备标识，不会收集关于您设备的任何信息</p>
                        </div>
                      </div>
                      <button
                        onClick={() => setShowTvDeviceId(true)}
                        disabled={!tvLicense.deviceId}
                        className="w-full rounded-xl px-5 py-3.5 text-white font-semibold flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                        style={{ backgroundColor: accentColor, boxShadow: `0 10px 28px ${accentColor}24` }}
                      >
                        <Copy className="w-4 h-4" />
                        获取识别码
                      </button>

                      <div className="mt-4 pt-4 border-t" style={{ borderColor: borderColor }}>
                        <button
                          onClick={() => setShowTvRedeemModal(true)}
                          className={`w-full rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-5 py-3.5 font-semibold flex items-center justify-center gap-2 transition-colors`}
                        >
                          <CheckCircle2 className="w-4 h-4" />
                          测试码验证
                        </button>
                        {tvLicense.grants.length > 0 && (
                          <div className="mt-3 space-y-1.5">
                            {tvLicense.grants.map((grant) => (
                              <div key={grant.feature} className="flex items-center gap-2 text-sm">
                                <BadgeCheck className="w-4 h-4 flex-shrink-0" style={{ color: accentColor }} />
                                <span className={`${textPrimary}`}>{grant.label}</span>
                                {grant.expiresAt && (
                                  <span className={`${textTertiary} text-xs`}>有效期至 {new Date(grant.expiresAt).toLocaleDateString('zh-CN')}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'account' && (
                <div className="space-y-6">
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>音乐平台账号</h3>
                    <p className={`${textSecondary} text-sm mb-1`}>
                      登录后可以播放VIP歌曲、获取个人歌单
                    </p>
                    <p className={`${textTertiary} text-xs mb-6`}>
                      可拖拽平台卡片对平台进行显示排序
                    </p>

                    <div className="space-y-4">
                    {/* 平台账号卡片（按住卡片上下拖拽调整顺序，隐藏的平台不参与排序） */}
                    <Reorder.Group axis="y" values={platformOrder} onReorder={(next) => {
                      const valid = next.filter((p, i, arr) => MUSIC_PLATFORMS.includes(p) && arr.indexOf(p) === i)
                      setPlatformOrder(valid)
                      setPlatformOrderState(valid)
                    }} className="space-y-4">
                      {platformOrder.map(p => {
                        const hidden = hiddenPlatforms.includes(p)
                        const isNetease = p === 'netease'
                        const isQQ = p === 'qq'
                        const isApple = p === 'apple'
                        const isSpotify = p === 'spotify'
                        const isKugou = p === 'kugou'
                        const label = PLATFORM_LABELS[p]
                        const sub = isNetease ? '使用手机扫码登录' : isQQ ? '使用网页扫码登录' : isApple ? '使用网页登录' : isSpotify ? '使用 OAuth 授权登录' : isKugou ? '使用网页登录' : '使用抖音扫码登录'
                        const iconBg = isNetease ? 'bg-red-600' : isQQ ? 'bg-green-600' : isApple ? 'bg-pink-600' : isSpotify ? 'bg-[#1DB954]' : isKugou ? 'bg-[#FF7A00]' : 'bg-[#38BDF8]'
                        const iconSrc = isNetease ? 'https://s1.music.126.net/style/favicon.ico' : isQQ ? 'https://y.qq.com/favicon.ico' : isApple ? 'https://www.apple.com/favicon.ico' : ''
                        const iconFallback = isNetease ? '%E7%BD%91' : isQQ ? 'QQ' : isApple ? '%E8%8B%B9' : ''
                        const loggedIn = isNetease ? neteaseLoggedIn : isQQ ? qqLoggedIn : isApple ? appleLoggedIn : isSpotify ? spotifyLoggedIn : isKugou ? kugouLoggedIn : sodaLoggedIn
                        const username = isNetease ? neteaseUsername : isQQ ? qqUsername : isApple ? appleUsername : isSpotify ? spotifyUsername : isKugou ? kugouUsername : sodaUsername
                        const onLogin = isNetease ? onNeteaseLogin : isQQ ? onQQLogin : isApple ? (() => undefined) : isSpotify ? onSpotifyLogin : isKugou ? onKugouLogin : onSodaLogin
                        const onLogout = isNetease ? onNeteaseLogout : isQQ ? onQQLogout : isApple ? onAppleLogout : isSpotify ? onSpotifyLogout : isKugou ? onKugouLogout : onSodaLogout
                        return (
                          <Reorder.Item key={p} value={p} className="relative">
                            <motion.div
                              layout
                              animate={{ opacity: hidden ? 0.45 : 1, scale: hidden ? 0.98 : 1 }}
                              transition={{ duration: 0.25 }}
                              className={`${bgCard} rounded-xl p-4 border ${borderColor} relative cursor-grab active:cursor-grabbing`}
                            >
                              {/* 隐藏平台小眼睛（右上角） */}
                              <button
                                type="button"
                                onClick={() => togglePlatformVisibility(p, !hidden)}
                                className="absolute top-3 right-3 p-1.5 rounded-lg transition-colors hover:bg-white/10"
                                aria-label={hidden ? `显示${label}` : `隐藏${label}`}
                                title={hidden ? '显示平台' : '隐藏平台'}
                              >
                                {hidden
                                  ? <EyeOff className="w-4 h-4 text-white/40" />
                                  : <Eye className="w-4 h-4 text-white/40" />}
                              </button>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-3">
                                  <div className={`w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 ${iconBg} flex items-center justify-center`}>
                                    {iconSrc ? (
                                      <img
                                        src={iconSrc}
                                        alt={label}
                                        className="w-6 h-6"
                                        onError={(e) => {
                                          e.currentTarget.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext x="50" y="70" text-anchor="middle" fill="white" font-size="45" font-weight="bold"%3E' + iconFallback + '%3C/text%3E%3C/svg%3E'
                                        }}
                                      />
                                    ) : (
                                      <Music className="w-5 h-5 text-white" />
                                    )}
                                  </div>
                                  <div>
                                    <div className={`${textPrimary} font-medium`}>{label}</div>
                                    <div className={`${textTertiary} text-xs`}>{sub}</div>
                                  </div>
                                </div>
                              </div>
                              <div className="mt-4">
                                <LoginButton
                                  platform={p}
                                  isLoggedIn={loggedIn}
                                  username={username}
                                  onLogin={onLogin}
                                  onLogout={onLogout}
                                  onAppleLogin={isApple ? onAppleLogin : undefined}
                                  playerTheme={playerTheme}
                                />
                              </div>
                            </motion.div>
                          </Reorder.Item>
                        )
                      })}
                    </Reorder.Group>
                      {/* 哔哩哔哩「看歌」登录 */}
                      <motion.div
                        layout
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.25 }}
                        className={`${bgCard} rounded-xl p-4 border ${borderColor} relative`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg overflow-hidden flex-shrink-0 flex items-center justify-center" style={{ backgroundColor: '#FB7299' }}>
                              <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.765-1.56 3.761-1.004.996-2.263 1.52-3.773 1.574h-.854c-1.51-.054-2.769-.578-3.773-1.574-.996-.996-1.51-2.251-1.542-3.76v-1.804h-4.996v1.804c-.032 1.509-.546 2.764-1.542 3.76-1.004.996-2.263 1.52-3.773 1.574h-.854C1.75 20.554.491 20.03-.513 19.034c-1.004-.996-1.524-2.251-1.56-3.76v-7.36c.036-1.511.556-2.765 1.56-3.761C.49 2.157 1.75 1.633 3.26 1.58h.854c1.51.054 2.769.578 3.773 1.574.996.996 1.51 2.251 1.542 3.76v1.804h4.996V6.914c.032-1.509.546-2.764 1.542-3.76 1.004-.996 2.263-1.52 3.773-1.574z" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>哔哩哔哩</div>
                              <div className={`${textTertiary} text-xs`}>看歌模式 · 扫码登录解锁 1080P</div>
                            </div>
                          </div>
                          {biliLoggedIn && (
                            <span className="text-xs font-medium text-green-500">已登录</span>
                          )}
                        </div>
                        <div className="mt-4 flex items-center gap-3">
                          {biliLoggedIn ? (
                            <>
                              {biliUser?.face && (
                                <img src={resolveBiliPic(biliUser.face)} alt="" className="w-8 h-8 rounded-full bg-white/10 flex-shrink-0" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className={`${textPrimary} text-sm truncate`}>{biliUser?.uname || '哔哩哔哩用户'}</div>
                                <div className={`${textTertiary} text-xs`}>
                                  {biliUser?.vipType ? '大会员 · ' : ''}
                                  {biliRemainingDays != null ? `登录有效期约 ${biliRemainingDays} 天` : '已登录'}
                                </div>
                              </div>
                              <button
                                type="button"
                                onClick={handleBiliLogout}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:bg-white/10 text-white/70"
                              >
                                退出登录
                              </button>
                              <button
                                type="button"
                                onClick={() => setShowBiliProfile(true)}
                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-transform hover:scale-105"
                                style={{ backgroundColor: "#FB7299" }}
                              >
                                个人中心
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setShowBiliLogin(true)}
                              className="px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-transform hover:scale-105"
                              style={{ backgroundColor: '#FB7299' }}
                            >
                              扫码登录
                            </button>
                          )}
                        </div>
                      </motion.div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium`}>隐藏主页账号ID信息</div>
                          <div className={`${textTertiary} text-xs mt-1`}>隐藏个人信息中的 QQ号和网易云ID，录制视频时保护账号隐私</div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={hideHomeAccountId}
                          aria-label="隐藏主页账号ID信息"
                          onClick={handleHideHomeAccountIdChange}
                          className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${hideHomeAccountId ? '' : playerTheme === 'dark' ? 'bg-white/15' : 'bg-black/15'}`}
                          style={hideHomeAccountId ? { backgroundColor: accentColor } : undefined}
                        >
                          <span className={`pointer-events-none absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow-md transition-transform duration-200 ${hideHomeAccountId ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === 'personalization' && (
                <div className="space-y-6">
                  {/* 首页自定义 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>自定义首页</h3>
                    <button
                      onClick={() => setShowHomeCustomize(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Sparkles className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left">
                          <div className={`${textPrimary} font-medium`}>自定义首页显示内容</div>
                          <div className={`${textSecondary} text-sm`}>
                            分别配置网易云和QQ音乐的推荐模块
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放音质 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放音质</h3>
                    <button
                      onClick={() => setShowAudioQuality(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <Headphones className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                        <div className={`${textPrimary} font-medium`}>各平台播放音质</div>
                        <div className={`${textSecondary} text-sm truncate`}>
                          网易云：{audioQualityLabel(audioQualitySettings.netease)} · QQ音乐：{audioQualityLabel(audioQualitySettings.qq)} · Spotify：{audioQualityLabel(audioQualitySettings.spotify)} · 酷狗：{audioQualityLabel(audioQualitySettings.kugou)} · 汽水：{audioQualityLabel(audioQualitySettings.soda)}
                        </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>

                  {/* 播放快捷键 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放快捷键</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} space-y-4`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>播放页快捷键</div>
                          <div className={`${textSecondary} text-sm`}>在播放页使用方向键调节进度，并可用空格键播放或暂停</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.playbackPageEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ playbackPageEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.playbackPageEnabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {playbackShortcutSettings.playbackPageEnabled && (
                        <div className="pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          {([
                            ['右方向键快进', 'seekForwardSeconds'],
                            ['左方向键快退', 'seekBackwardSeconds'],
                          ] as const).map(([label, key]) => {
                            const seconds = playbackShortcutSettings[key]
                            const percent = ((seconds - 1) / 14) * 100
                            return (
                              <div key={key} className="flex items-center justify-between gap-5">
                                <div className={`${textPrimary} text-sm font-medium`}>{label}</div>
                                <div className="flex items-center gap-3">
                                  <input
                                    type="range"
                                    min="1"
                                    max="15"
                                    step="1"
                                    value={seconds}
                                    onChange={(event) => updatePlaybackShortcutSettings({ [key]: Number(event.target.value) })}
                                    className="w-36 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                    style={{
                                      background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${percent}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`,
                                    }}
                                  />
                                  <span className={`${textPrimary} text-sm font-semibold w-12 text-right`}>{seconds} 秒</span>
                                </div>
                              </div>
                            )
                          })}

                          <div className="flex items-center justify-between gap-6 pt-1">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>空格键播放 / 暂停</div>
                              <div className={`${textTertiary} text-xs`}>关闭后，在播放页按空格键不会触发播放控制</div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                              <input
                                type="checkbox"
                                checked={playbackShortcutSettings.spacePlayPauseEnabled}
                                onChange={(event) => updatePlaybackShortcutSettings({ spacePlayPauseEnabled: event.target.checked })}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.spacePlayPauseEnabled ? accentColor : '' }} />
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="pt-4 border-t flex items-center justify-between gap-6" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>键盘多媒体键支持</div>
                          <div className={`${textSecondary} text-sm`}>软件打开时，全局响应播放 / 暂停、上一曲和下一曲媒体键</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={playbackShortcutSettings.mediaKeysEnabled}
                            onChange={(event) => updatePlaybackShortcutSettings({ mediaKeysEnabled: event.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: playbackShortcutSettings.mediaKeysEnabled ? accentColor : '' }} />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* 即将播放提示 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放提示</h3>
                    
                    {/* 即将播放提示开关 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>即将播放提示</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前显示下一首歌曲信息
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={upNextEnabled}
                            onChange={(e) => handleUpNextToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: upNextEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 秒数设置 */}
                      {upNextEnabled && (
                        <div className="space-y-4 pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between gap-6">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>在播放页外显示播放提示</div>
                              <div className={`${textSecondary} text-xs`}>
                                在探索、简约首页和桌面模式的右上角显示提示
                              </div>
                            </div>
                            <label className="relative inline-flex shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={showUpNextOutsidePlayer}
                                onChange={(e) => handleShowUpNextOutsidePlayerToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: showUpNextOutsidePlayer ? accentColor : '' }} />
                            </label>
                          </div>
                          <div className="border-t pt-4" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className="flex items-center justify-between">
                            <div className={`${textPrimary} text-sm font-medium`}>提前显示时间</div>
                            <div className="flex items-center gap-3">
                              <input
                                type="range"
                                min="5"
                                max="30"
                                value={upNextSeconds}
                                onChange={(e) => handleUpNextSecondsChange(parseInt(e.target.value))}
                                className="w-32 h-2 rounded-lg appearance-none cursor-pointer range-slider-glass"
                                style={{
                                  background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((upNextSeconds - 5) / 25) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                                }}
                              />
                              <span className={`${textPrimary} text-sm font-medium w-12 text-right`}>{upNextSeconds}秒</span>
                            </div>
                          </div>
                          <div className={`${textTertiary} text-xs mt-2`}>
                            在歌曲结束前 {upNextSeconds} 秒显示下一首歌曲信息
                          </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* 歌词翻译位置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>歌词翻译</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>翻译显示位置</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择歌词翻译在播放界面的显示位置
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-3">
                        <button
                          onClick={() => {
                            setTranslationPosition('traditional')
                            localStorage.setItem('translationPosition', 'traditional')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'traditional' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'traditional'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'traditional' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'traditional' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>传统</div>
                              <div className={`${textTertiary} text-xs mt-1`}>显示于歌词下方</div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => {
                            setTranslationPosition('bottom-right')
                            localStorage.setItem('translationPosition', 'bottom-right')
                            window.dispatchEvent(new CustomEvent('translationPositionChanged', { detail: 'bottom-right' }))
                          }}
                          className={`p-4 rounded-xl transition-all border-2 ${
                            translationPosition === 'bottom-right'
                              ? 'border-2'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: translationPosition === 'bottom-right' ? accentColor : 'transparent',
                            backgroundColor: translationPosition === 'bottom-right' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex flex-col items-center gap-2">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} text-sm font-medium`}>现代</div>
                              <div className={`${textTertiary} text-xs mt-1`}>右下角浮动显示</div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 桌面歌词 */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面歌词</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用桌面歌词</div>
                          <div className={`${textSecondary} text-sm`}>将当前歌词显示在桌面上，悬停后可拖动、缩放并快速调整样式</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={desktopLyricsSettings.enabled}
                            onChange={(event) => handleDesktopLyricsToggle(event.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopLyricsSettings.enabled ? accentColor : '' }} />
                        </label>
                      </div>

                      {desktopLyricsSettings.enabled && (
                        <div className="mt-4 pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`${textPrimary} text-sm font-medium`}>字体大小</span>
                              <span className={`${textTertiary} text-xs tabular-nums`}>{desktopLyricsSettings.fontSize}</span>
                            </div>
                            <input
                              type="range"
                              min="26"
                              max="120"
                              step="2"
                              value={desktopLyricsSettings.fontSize}
                              onChange={(event) => updateDesktopLyrics({ fontSize: Number(event.target.value) })}
                              className="w-full"
                              style={{ accentColor }}
                            />
                          </div>

                          {/* 歌词字体：内置霞鹜文楷 / 得意黑（OFL 开源可商用）+ 推荐系统字体 + 本机字体 */}
                          <div className="mt-4">
                            <div className="flex items-center justify-between gap-4">
                              <div className="min-w-0">
                                <div className={`${textPrimary} text-sm font-medium`}>字体</div>
                                <div className={`${textTertiary} text-xs mt-0.5`}>内置霞鹜文楷 / 得意黑，也可选择本机字体</div>
                              </div>
                              <FontPicker
                                value={desktopLyricsSettings.fontFamily}
                                onChange={(family) => updateDesktopLyrics({ fontFamily: family })}
                                dark={playerTheme === 'dark'}
                                accent={accentColor}
                                buttonWidth={200}
                              />
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>字体颜色</div>
                            <div className="flex flex-wrap gap-3">
                              {([
                                ['auto', '随歌曲', 'linear-gradient(135deg,#67e8f9,#f9a8d4,#fde68a)'],
                                ['rose', '樱粉', '#f9a8d4'],
                                ['sky', '晴蓝', '#7dd3fc'],
                                ['gold', '暖金', '#fde68a'],
                                ['mint', '薄荷', '#86efac'],
                                ['white', '月白', '#f8fafc'],
                              ] as Array<[DesktopLyricsColorMode, string, string]>).map(([value, label, color]) => (
                                <button key={value} type="button" onClick={() => updateDesktopLyrics({ colorMode: value })} className="flex flex-col items-center gap-1.5">
                                  <span className="w-8 h-8 rounded-full p-1 transition-shadow" style={{ boxShadow: desktopLyricsSettings.colorMode === value ? `0 0 0 2px ${accentColor}` : '0 0 0 1px rgba(127,127,127,.22)' }}>
                                    <i className="block w-full h-full rounded-full" style={{ background: color }} />
                                  </span>
                                  <span className={`${textTertiary} text-[10px]`}>{label}</span>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-3">
                            {([
                              ['orientation', desktopLyricsSettings.orientation === 'vertical', '竖排显示'],
                              ['doubleLine', desktopLyricsSettings.doubleLine, '双行显示'],
                              ['traditionalEnabled', desktopLyricsSettings.traditionalEnabled, '繁体歌词'],
                            ] as const).map(([key, active, label]) => (
                              <button
                                key={key}
                                type="button"
                                onClick={() => updateDesktopLyrics(key === 'orientation'
                                  ? { orientation: active ? 'horizontal' : 'vertical' }
                                  : { [key]: !active })}
                                className="rounded-xl border px-3 py-2.5 text-xs transition-colors"
                                style={{
                                  color: active ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                  borderColor: active ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                  background: active ? `${accentColor}18` : 'transparent',
                                }}
                              >{label}</button>
                            ))}
                          </div>
                          <p className={`${textTertiary} text-xs leading-5`}>翻译与罗马音按钮会在当前整首歌曲包含对应歌词时，自动显示在桌面歌词工具栏中。</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 桌面播放器 */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>桌面播放器</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>桌面播放器</div>
                          <div className={`${textSecondary} text-sm`}>
                            独立置顶小窗口，支持右上角悬浮卡片与顶部居中的紧凑条状
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={desktopPlayerEnabled}
                            onChange={(e) => handleDesktopPlayerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: desktopPlayerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {desktopPlayerEnabled && (
                        <div className="pt-4 border-t" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }}>
                          <div className={`${textPrimary} text-sm font-medium mb-3`}>显示形态</div>
                          <div className="grid grid-cols-2 gap-3">
                            <button
                              onClick={() => handleDesktopPlayerFormChange('card')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'card' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'card'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v11H4z M8 9h5 M8 12h3 M16 9v4 M18 10v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>悬浮卡片</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>可拖动摆放，拖角调整大小</div>
                                </div>
                              </div>
                            </button>

                            <button
                              onClick={() => handleDesktopPlayerFormChange('bar')}
                              className="p-4 rounded-xl transition-all border-2"
                              style={{
                                borderColor: desktopPlayerForm === 'bar' ? accentColor : 'transparent',
                                backgroundColor: desktopPlayerForm === 'bar'
                                  ? `${accentColor}20`
                                  : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                              }}
                            >
                              <div className="flex flex-col items-center gap-2">
                                <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                                  <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 15h18v4H3z M5 17h6 M17 16.5v1.5 M19 16v2" />
                                  </svg>
                                </div>
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium`}>紧凑条状</div>
                                  <div className={`${textTertiary} text-xs mt-1`}>默认显示在屏幕顶部中央，支持完整控制</div>
                                </div>
                              </div>
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 任务栏迷你播控（贴任务栏带） */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>任务栏迷你播控</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用任务栏迷你播控</div>
                          <div className={`${textSecondary} text-sm`}>
                            在任务栏上显示迷你播控栏（封面 / 歌词 / 进度 / 控制），精确贴合任务栏高度，播放时显示当前歌词行
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={taskbarWidgetEnabledState}
                            onChange={(e) => void handleTaskbarWidgetToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: taskbarWidgetEnabledState ? accentColor : '' }} />
                        </label>
                      </div>

                      {taskbarWidgetEnabledState && (
                        <div className="mt-4 pt-4 border-t space-y-5" style={{ borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>位置</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['right', '右侧', '靠近系统托盘，不遮挡托盘区域'],
                                ['center', '居中', '任务栏水平居中显示'],
                              ] as const).map(([value, label, hint]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => void handleTaskbarWidgetUpdate({ position: value })}
                                  className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left"
                                  style={{
                                    color: taskbarWidgetSettings.position === value ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                    borderColor: taskbarWidgetSettings.position === value ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                    background: taskbarWidgetSettings.position === value ? `${accentColor}18` : 'transparent',
                                  }}
                                >
                                  <div className="font-medium">{label}</div>
                                  <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>显示模式</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['normal', '常规', '封面 + 上一曲/暂停/下一曲 + 歌词'],
                                ['pure', '纯享', '只显示当前播放的歌词'],
                              ] as const).map(([value, label, hint]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={() => void handleTaskbarWidgetUpdate({ mode: value })}
                                  className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left"
                                  style={{
                                    color: (taskbarWidgetSettings.mode || 'normal') === value ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                    borderColor: (taskbarWidgetSettings.mode || 'normal') === value ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                    background: (taskbarWidgetSettings.mode || 'normal') === value ? `${accentColor}18` : 'transparent',
                                  }}
                                >
                                  <div className="font-medium">{label}</div>
                                  <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-3`}>背景效果</div>
                            <div className="grid grid-cols-2 gap-3">
                              {([
                                ['darken', '暗化', '加深背景遮罩，文字更清晰'],
                              ] as const).map(([value, label, hint]) => {
                                const enabled = taskbarWidgetSettings[value] === true
                                return (
                                  <button
                                    key={value}
                                    type="button"
                                    onClick={() => void handleTaskbarWidgetUpdate({ [value]: !enabled } as Partial<TaskbarWidgetSettings>)}
                                    className="rounded-xl border px-3 py-2.5 text-xs transition-colors text-left flex items-center justify-between gap-2"
                                    style={{
                                      color: enabled ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                                      borderColor: enabled ? `${accentColor}99` : playerTheme === 'dark' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                      background: enabled ? `${accentColor}18` : 'transparent',
                                    }}
                                  >
                                    <span>
                                      <div className="font-medium">{label}</div>
                                      <div className={`${textTertiary} text-[10px] mt-0.5`}>{hint}</div>
                                    </span>
                                    <span className={`inline-block w-9 h-5 rounded-full relative shrink-0 transition-colors`} style={{ backgroundColor: enabled ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.2)' }}>
                                      <span className={`absolute top-[2px] start-[2px] w-4 h-4 rounded-full bg-white shadow transition-all`} style={{ transform: enabled ? 'translateX(16px)' : '' }} />
                                    </span>
                                  </button>
                                )
                              })}
                            </div>
                            {taskbarWidgetSettings.darken && (
                              <div className="mt-3">
                                <div className="flex items-center justify-between mb-2"><span className={`${textPrimary} text-xs font-medium`}>暗化程度</span><span className={`${textTertiary} text-[10px] tabular-nums`}>{Math.round(taskbarWidgetSettings.darkenLevel * 100)}%</span></div>
                                <input type="range" min="5" max="95" step="5" value={Math.round(taskbarWidgetSettings.darkenLevel * 100)} onChange={(e) => void handleTaskbarWidgetUpdate({ darkenLevel: Number(e.target.value) / 100 })} className="w-full" style={{ accentColor }} />
                              </div>
                            )}
                            {(taskbarWidgetSettings.mode || 'normal') === 'normal' && (
                              <div className="mt-3 flex items-center justify-between">
                                <span className={`${textPrimary} text-xs font-medium`}>隐藏控件</span>
                                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                                  <input type="checkbox" checked={taskbarWidgetSettings.hideControls} onChange={(e) => void handleTaskbarWidgetUpdate({ hideControls: e.target.checked })} className="sr-only peer" />
                                  <div className={`w-9 h-5 rounded-full relative shrink-0 transition-colors`} style={{ backgroundColor: taskbarWidgetSettings.hideControls ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.2)' }}>
                                    <span className={`absolute top-[2px] start-[2px] w-4 h-4 rounded-full bg-white shadow transition-all`} style={{ transform: taskbarWidgetSettings.hideControls ? 'translateX(16px)' : '' }} />
                                  </div>
                                </label>
                              </div>
                            )}
                            <p className={`${textTertiary} text-[10px] mt-2 leading-4`}>
                              仅 Windows 可用。迷你播控栏覆盖在任务栏带区域，只有播控按钮可点击，其余区域鼠标穿透。
                            </p>
                          </div>

                          <div>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`${textPrimary} text-sm font-medium`}>宽度</span>
                              <span className={`${textTertiary} text-xs tabular-nums`}>{taskbarWidgetSettings.width} px</span>
                            </div>
                            <input
                              type="range"
                              min="260"
                              max="420"
                              step="10"
                              value={taskbarWidgetSettings.width}
                              onChange={(e) => void handleTaskbarWidgetUpdate({ width: Number(e.target.value) })}
                              className="w-full"
                              style={{ accentColor }}
                            />
                          </div>
                          <p className={`${textTertiary} text-xs leading-5`}>
                            仅 Windows 可用。迷你播控栏覆盖在任务栏带区域，悬停时变为可交互；移出后自动鼠标穿透，不遮挡任务栏其他按钮。
                          </p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 全屏窗口模式设置（TV 端常驻全屏，无需设置） */}
                  <div data-tv-hide="desktop">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>窗口设置</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>全屏化窗口模式</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择全屏时的窗口行为
                        </div>
                      </div>
                      
                      {/* 全屏模式选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleFullscreenModeChange('kiosk')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'kiosk'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'kiosk' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'kiosk' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                覆盖整个屏幕包括任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleFullscreenModeChange('normal')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            fullscreenMode === 'normal'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: fullscreenMode === 'normal' ? accentColor : 'transparent',
                            backgroundColor: fullscreenMode === 'normal' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-12 h-12 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-6 h-6" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>全屏无边框</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                保留系统任务栏
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 视频播放设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>视频播放</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>视频播放完毕行为</div>
                        <div className={`${textSecondary} text-sm`}>
                          选择MV视频播放结束后的行为
                        </div>
                      </div>
                      
                      {/* 视频结束行为选项 */}
                      <div className="space-y-3">
                        <button
                          onClick={() => handleVideoEndBehaviorChange('close')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'close'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'close' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'close' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>不重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后显示重播按钮
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('replay')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'replay'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'replay' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'replay' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动重播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动回到开头重播
                              </div>
                            </div>
                          </div>
                        </button>
                        
                        <button
                          onClick={() => handleVideoEndBehaviorChange('next')}
                          className={`w-full p-4 rounded-lg border-2 transition-all text-left ${
                            videoEndBehavior === 'next'
                              ? 'border-current'
                              : 'border-transparent'
                          }`}
                          style={{
                            borderColor: videoEndBehavior === 'next' ? accentColor : 'transparent',
                            backgroundColor: videoEndBehavior === 'next' 
                              ? `${accentColor}20`
                              : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}30` }}>
                              <svg className="w-5 h-5" style={{ color: accentColor }} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                              </svg>
                            </div>
                            <div>
                              <div className={`${textPrimary} font-medium`}>自动续播</div>
                              <div className={`${textSecondary} text-sm mt-1`}>
                                播放完毕后自动播放下一个视频
                              </div>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  {/* 主题色设置 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>主题色</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      {/* 深浅色切换 */}
                      <div className="flex items-center justify-between mb-4 pb-4" style={{ borderBottom: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
                        <div className={`${textPrimary} font-medium`}>外观主题</div>
                        <div className="flex gap-2">
                          {(['dark', 'light'] as const).map((themeOption) => (
                            <button
                              key={themeOption}
                              onClick={() => handlePlayerThemeChange(themeOption)}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                              style={{
                                backgroundColor:
                                  playerTheme === themeOption
                                    ? accentColor
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.1)'
                                    : 'rgba(0,0,0,0.1)',
                                color:
                                  playerTheme === themeOption
                                    ? '#fff'
                                    : playerTheme === 'dark'
                                    ? 'rgba(255,255,255,0.6)'
                                    : 'rgba(0,0,0,0.6)',
                                boxShadow: playerTheme === themeOption ? `0 0 8px ${accentColor}30` : 'none',
                              }}
                            >
                              {themeOption === 'dark' ? (
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                              )}
                              {themeOption === 'dark' ? '深色' : '浅色'}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="mb-4">
                        <div className={`${textPrimary} font-medium mb-1`}>选择主题色</div>
                        <div className={`${textSecondary} text-sm`}>
                          自定义应用的强调色
                        </div>
                      </div>
                      
                      {/* 色板 */}
                      <div className="grid grid-cols-4 gap-3">
                        {presetColors.map((color) => (
                          <button
                            key={color.value}
                            onClick={() => handleAccentColorChange(color.value)}
                            className={`relative p-3 rounded-xl transition-all ${
                              accentColor === color.value 
                                ? 'ring-2 ring-offset-2 scale-105' 
                                : 'hover:scale-105'
                            }`}
                            style={{
                              backgroundColor: color.value,
                              '--tw-ring-color': color.value,
                              ringOffsetColor: playerTheme === 'dark' ? '#000' : '#fff',
                            } as React.CSSProperties}
                          >
                            <div className="aspect-square rounded-lg" />
                            {accentColor === color.value && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <svg className="w-6 h-6 text-white drop-shadow-lg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                          </button>
                        ))}
                      </div>
                      
                      {/* 色块下方显示颜色名称 */}
                      <div className={`mt-3 text-center ${textSecondary} text-sm`}>
                        当前：{presetColors.find(c => c.value === accentColor)?.name || '自定义'}
                      </div>
                    </div>
                  </div>

                  {/* 远程遥控器设置（卡片 → 二级菜单弹窗；TV 模式已移至「TV设置」tab） */}
                  {!isTvModeActive() && (
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>远程遥控器</h3>
                    <button
                      onClick={() => setShowRemoteSettings(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all flex items-center justify-between group`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${accentColor}20` }}>
                          <MonitorSmartphone className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div className="text-left min-w-0">
                          <div className={`${textPrimary} font-medium`}>遥控器个性化</div>
                          <div className={`${textSecondary} text-sm truncate`}>外观 · 右上角按钮 · 触摸板手势</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textTertiary} flex-shrink-0 group-hover:translate-x-1 transition-transform`} />
                    </button>
                  </div>
                  )}
                </div>
              )}

              {/* 高级标签页 */}
              {activeTab === 'advanced' && (
                <div className="space-y-6">
                  {/* 播放过渡效果 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>播放过渡</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      选择歌曲切换时的过渡效果，提升听感体验
                    </p>
                    
                    {/* Crossfade 渐入渐出 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>渐入渐出 (Crossfade)</div>
                          <div className={`${textSecondary} text-sm`}>
                            在歌曲结束前开始淡出，同时淡入下一首
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossfadeEnabled}
                            onChange={(e) => handleCrossfadeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossfadeEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* Crossfade 时长调节 */}
                      {crossfadeEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10">
                          <div className="flex items-center justify-between mb-2">
                            <span className={`${textSecondary} text-sm`}>过渡时长</span>
                            <span className={`${textPrimary} text-sm font-medium`}>{crossfadeDuration} 秒</span>
                          </div>
                          <input
                            type="range"
                            min="1"
                            max="12"
                            step="1"
                            value={crossfadeDuration}
                            onChange={(e) => handleCrossfadeDurationChange(parseInt(e.target.value))}
                            className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                            style={{
                              background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} ${((crossfadeDuration - 1) / 11) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)'} 100%)`
                            }}
                          />
                        </div>
                      )}
                    </div>
                    
                    {/* Gapless 无缝衔接 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>无缝衔接 (Gapless)</div>
                          <div className={`${textSecondary} text-sm`}>
                            预加载下一首并在歌曲边界连续切换；节拍分析由独立的 AutoMix 负责
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gaplessEnabled}
                            onChange={(e) => handleGaplessToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gaplessEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {gaplessEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
                          {/* 专辑融合 */}
                          <div className="flex items-center justify-between">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>专辑融合</div>
                              <div className={`${textSecondary} text-xs`}>
                                仅在同一专辑的相邻歌曲间使用尾部检测与 Equal Power 融合
                              </div>
                            </div>
                            <label className="relative inline-flex items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={albumGaplessEnabled}
                                onChange={(e) => handleAlbumGaplessToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: albumGaplessEnabled ? accentColor : '' }}></div>
                            </label>
                          </div>

                        </div>
                      )}
                    </div>

                    {/* AutoMix 智能混音 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mt-4`}>
                      <div className="flex items-center justify-between mb-3">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1 flex items-center gap-2`}>
                            <Sparkles className="w-4 h-4" />
                            智能混音 (AutoMix)
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: accentColor + '20', color: accentColor }}>AI</span>
                            <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/20 text-orange-400">Beta</span>
                          </div>
                          <div className={`${textSecondary} text-sm`}>
                            自动分析上下歌曲BPM节拍与能量进行混音过渡
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={autoMixEnabled}
                            onChange={(e) => handleAutoMixToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {autoMixEnabled && (
                        <div className="mt-4 pt-4 border-t border-white/10 space-y-4">
                          {/* 过渡引擎：标准 AutoMix（v1）/ AutoMix 增强版（v2） */}
                          <div>
                            <div className={`${textPrimary} text-sm font-medium mb-2`}>过渡引擎</div>
                            <div className="grid grid-cols-2 gap-2">
                              <button
                                onClick={() => handleAutoMixEnhancedChange(false)}
                                className={`px-3 py-2 rounded-lg text-sm transition-all ${textPrimary} ${
                                  !autoMixEnhanced ? 'border-current' : 'border-transparent'
                                }`}
                                style={{
                                  borderColor: !autoMixEnhanced ? accentColor : 'transparent',
                                  backgroundColor: !autoMixEnhanced
                                    ? `${accentColor}20`
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                                  color: !autoMixEnhanced ? accentColor : undefined,
                                }}
                              >
                                标准 AutoMix
                              </button>
                              <button
                                onClick={() => handleAutoMixEnhancedChange(true)}
                                className={`px-3 py-2 rounded-lg text-sm transition-all ${textPrimary} ${
                                  autoMixEnhanced ? 'border-current' : 'border-transparent'
                                }`}
                                style={{
                                  borderColor: autoMixEnhanced ? accentColor : 'transparent',
                                  backgroundColor: autoMixEnhanced
                                    ? `${accentColor}20`
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                                  color: autoMixEnhanced ? accentColor : undefined,
                                }}
                              >
                                AutoMix 增强版
                              </button>
                            </div>
                            <div className={`${textSecondary} text-xs mt-1`}>
                              {autoMixEnhanced
                                ? '调性匹配、乐句对齐、能量曲线与更丰富的过渡特效（鼓点/加速/混响虚化）'
                                : '节拍对齐 + 基础 DJ 效果（当前方案，保持稳定）'}
                            </div>
                          </div>

                          {autoMixEnhanced && (
                            <>
                              {/* v2 特效强度档位 */}
                              <div>
                                <div className={`${textPrimary} text-sm font-medium mb-2`}>特效强度</div>
                                <div className="grid grid-cols-3 gap-2">
                                  {(['subtle', 'standard', 'strong'] as const).map(level => (
                                    <button
                                      key={level}
                                      onClick={() => handleAutoMixIntensityChange(level)}
                                      className={`px-3 py-2 rounded-lg text-sm transition-all ${textPrimary}`}
                                      style={{
                                        borderColor: autoMixTransitionIntensity === level ? accentColor : 'transparent',
                                        backgroundColor: autoMixTransitionIntensity === level
                                          ? `${accentColor}20`
                                          : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                                        color: autoMixTransitionIntensity === level ? accentColor : undefined,
                                      }}
                                    >
                                      {level === 'subtle' ? '轻' : level === 'standard' ? '标准' : '强'}
                                    </button>
                                  ))}
                                </div>
                              </div>

                              {/* AutoMix Enhanced 分轨核心：HTDemucs 可选模型，缺失时继续 v2 DSP */}
                              <div className={`rounded-xl border p-3 ${playerTheme === 'dark' ? 'border-white/10 bg-white/[0.03]' : 'border-black/10 bg-black/[0.02]'}`}>
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className={`${textPrimary} text-sm font-medium mb-0.5`}>增强版分轨引擎（HTDemucs）</div>
                                    <div className={`${textSecondary} text-xs leading-relaxed`}>
                                      {stemModelStatus?.installed
                                        ? '已安装：过渡会分离人声、鼓、贝斯与其他乐器并分别交接'
                                        : stemModelProgress?.status === 'downloading'
                                          ? `正在从 ${stemModelProgress.host || '镜像'} 下载 ${stemModelProgress.asset || '模型'}… ${Math.round(stemModelProgress.percent)}%`
                                          : stemModelProgress?.status === 'paused'
                                            ? '下载已暂停，可断点继续'
                                            : stemModelProgress?.status === 'error'
                                              ? `下载失败：${stemModelProgress.error || '未知错误'}`
                                              : '未安装时仍可使用增强版 DSP；安装后自动升级为分轨混音'}
                                    </div>
                                  </div>
                                  <div className="flex flex-shrink-0 items-center gap-1.5">
                                    {stemModelStatus?.installed ? (
                                      <button type="button" onClick={handleStemModelDelete} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ color: '#f87171', background: playerTheme === 'dark' ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)' }}>删除</button>
                                    ) : stemModelProgress?.status === 'downloading' ? (
                                      <button type="button" onClick={handleStemModelPause} className="rounded-lg px-3 py-1.5 text-xs font-medium" style={{ color: playerTheme === 'dark' ? '#f2f3f7' : '#1c1d22', background: playerTheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>暂停</button>
                                    ) : stemModelProgress?.status === 'paused' ? (
                                      <>
                                        <button type="button" onClick={handleStemModelResume} className="rounded-lg px-3 py-1.5 text-xs font-medium text-white" style={{ background: accentColor }}>继续</button>
                                        <button type="button" onClick={handleStemModelCancel} className="rounded-lg px-2 py-1.5 text-xs" style={{ color: textSecondary }}>取消</button>
                                      </>
                                    ) : (
                                      <button type="button" onClick={handleStemModelDownload} disabled={stemModelStatus?.supported === false} className="rounded-lg px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40" style={{ background: accentColor }}>下载模型</button>
                                    )}
                                  </div>
                                </div>
                                {stemModelProgress && (stemModelProgress.status === 'downloading' || stemModelProgress.status === 'paused') && (
                                  <div className="mt-2 space-y-1">
                                    <div className={`h-1 rounded-full overflow-hidden ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                                      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, stemModelProgress.percent))}%`, background: accentColor }} />
                                    </div>
                                    <div className={`flex justify-between text-[10px] ${textSecondary}`}>
                                      <span>{stemModelProgress.speed > 0 ? formatDownloadSpeed(stemModelProgress.speed) : '准备下载'}</span>
                                      <span>{typeof stemModelProgress.eta === 'number' ? `剩余约 ${formatDownloadEta(stemModelProgress.eta)}` : ''}</span>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* DJTransGAN 严格可选扩展：不影响 AutoMix Enhanced / HTDemucs */}
                              <div className="flex items-center justify-between gap-4">
                                <div>
                                  <div className={`${textPrimary} text-sm font-medium mb-1`}>DJTransGAN 实验扩展（可选）</div>
                                  <div className={`${textSecondary} text-xs`}>
                                    {aiMixAvailable === true
                                      ? '可选使用学习式推子/EQ；60 秒长混音资源占用较高，默认关闭。关闭时不会启动 Torch worker'
                                      : aiMixAvailable === false
                                        ? '未安装，不影响增强版的 HTDemucs 分轨与 DSP 过渡'
                                        : '正在检测可选扩展…'}
                                  </div>
                                </div>
                                <label className={`relative inline-flex flex-shrink-0 items-center ${aiMixAvailable === true ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed'}`}>
                                  <input
                                    type="checkbox"
                                    checked={autoMixAiMix && aiMixAvailable === true}
                                    disabled={aiMixAvailable !== true}
                                    onChange={(event) => handleAutoMixAiMixToggle(event.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixAiMix ? accentColor : '' }}></div>
                                </label>
                              </div>

                              {/* DJTransGAN 模型：下载 / 进度 / 删除 */}
                              <div className={`rounded-xl border p-3 ${playerTheme === 'dark' ? 'border-white/10 bg-white/[0.03]' : 'border-black/10 bg-black/[0.02]'}`}>
                                <div className="flex items-center justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className={`${textPrimary} text-sm font-medium mb-0.5`}>DJTransGAN 模型</div>
                                    <div className={`${textSecondary} text-xs leading-relaxed`}>
                                      {aiModelProgress?.status === 'deleting'
                                        ? '正在删除模型…'
                                        : aiModelStatus?.installed
                                          ? '已安装，可直接使用 AI 混音'
                                          : aiModelProgress?.status === 'downloading'
                                            ? `${aiModelProgress.phaseLabel || '下载中'}… ${Math.round(aiModelProgress.phasePercent)}%`
                                            : aiModelProgress?.status === 'paused'
                                              ? '下载已暂停'
                                              : aiModelProgress?.status === 'error'
                                                ? `下载失败：${aiModelProgress.error || '未知错误'}`
                                                : aiModelStatus
                                                  ? aiModelStatus.repoReady && !aiModelStatus.weightsReady
                                                    ? '已下载仓库，缺少预训练权重'
                                                    : '未安装（点击下载将自动安装运行环境 + 模型）'
                                                  : '检测中…'}
                                    </div>
                                  </div>
                                  {aiModelProgress?.status === 'deleting' ? (
                                    <button
                                      type="button"
                                      disabled
                                      className="flex flex-shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
                                      style={{ color: playerTheme === 'dark' ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.55)', background: playerTheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}
                                    >
                                      <span className="inline-block h-3 w-3 rounded-full border-2 border-transparent animate-spin" style={{ borderTopColor: accentColor, borderRightColor: accentColor }} />
                                      删除中…
                                    </button>
                                  ) : aiModelStatus?.installed ? (
                                    <button
                                      type="button"
                                      onClick={() => setShowAiModelDeleteDialog(true)}
                                      className="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors"
                                      style={{
                                        color: '#f87171',
                                        background: playerTheme === 'dark' ? 'rgba(239,68,68,0.12)' : 'rgba(239,68,68,0.08)',
                                        border: '1px solid rgba(239,68,68,0.25)',
                                      }}
                                    >
                                      删除模型
                                    </button>
                                  ) : aiModelProgress?.status === 'downloading' || aiModelProgress?.status === 'paused' ? (
                                    <div className="flex flex-shrink-0 items-center gap-1.5">
                                      {aiModelProgress.status === 'paused' ? (
                                        <button type="button" onClick={handleAiModelResume} className="rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors hover:opacity-85" style={{ background: accentColor }}>继续</button>
                                      ) : (
                                        <button type="button" onClick={handleAiModelPause} className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ color: playerTheme === 'dark' ? '#f2f3f7' : '#1c1d22', background: playerTheme === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>暂停</button>
                                      )}
                                      <button type="button" onClick={handleAiModelCancel} className="rounded-lg px-3 py-1.5 text-xs font-medium transition-colors" style={{ color: playerTheme === 'dark' ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)', background: 'transparent', border: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)'}` }}>取消</button>
                                    </div>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setShowAiModelDownloadDialog(true)}
                                      className="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-transform hover:scale-[1.03] active:scale-95"
                                      style={{ background: accentColor }}
                                    >
                                      下载模型
                                    </button>
                                  )}
                                </div>
                                {aiModelProgress && (aiModelProgress.status === 'downloading' || aiModelProgress.status === 'paused') && (
                                  <div className="mt-2.5">
                                    <div className="flex items-center justify-between text-[11px] mb-1">
                                      <span className={textSecondary}>{aiModelProgress.phaseLabel || '下载中'}</span>
                                      <span className={textSecondary}>{Math.round(aiModelProgress.phasePercent)}%</span>
                                    </div>
                                    <div className={`h-1.5 w-full overflow-hidden rounded-full ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
                                      <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, aiModelProgress.phasePercent))}%`, background: accentColor }} />
                                    </div>
                                    {(aiModelProgress.downloadSpeed > 0 || typeof aiModelProgress.downloadEta === 'number') && (
                                      <div className="flex items-center justify-between text-[11px] mt-1">
                                        {aiModelProgress.downloadSpeed > 0 ? (
                                          <span className={textTertiary}>下载速度 {formatDownloadSpeed(aiModelProgress.downloadSpeed)}</span>
                                        ) : <span />}
                                        {typeof aiModelProgress.downloadEta === 'number' && (
                                          <span className={textTertiary}>剩余约 {formatDownloadEta(aiModelProgress.downloadEta)}</span>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            </>
                          )}

                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>节拍匹配</div>
                              <div className={`${textSecondary} text-xs`}>对齐重拍，并使用保留音高的渐进变速</div>
                            </div>
                            <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoMixBeatMatching}
                                onChange={(event) => handleAutoMixBeatMatchingToggle(event.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixBeatMatching ? accentColor : '' }}></div>
                            </label>
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <div className={`${textPrimary} text-sm font-medium mb-1`}>跳过首尾静音</div>
                              <div className={`${textSecondary} text-xs`}>选择混音点时避开前奏与尾部的静音区</div>
                            </div>
                            <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                              <input
                                type="checkbox"
                                checked={autoMixSkipSilence}
                                onChange={(event) => handleAutoMixSkipSilenceToggle(event.target.checked)}
                                className="sr-only peer"
                              />
                              <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: autoMixSkipSilence ? accentColor : '' }}></div>
                            </label>
                          </div>

                          {/* 过渡时长范围：仅标准版（v1）可调；增强版（v2）由算法按 BPM 智能决定 */}
                          {!autoMixEnhanced && (
                            <div>
                              <div className="flex items-center justify-between mb-2">
                                <div className={`${textPrimary} text-sm font-medium`}>过渡时长范围</div>
                                <div className={`${textSecondary} text-xs tabular-nums`}>{autoMixMinDuration}–{autoMixMaxDuration} 秒</div>
                              </div>
                              <div className="grid grid-cols-2 gap-4">
                                <label className={`${textSecondary} text-xs`}>
                                  最短
                                  <input
                                    type="range"
                                    min="1"
                                    max="19"
                                    step="1"
                                    value={autoMixMinDuration}
                                    onChange={(event) => handleAutoMixMinDurationChange(Number(event.target.value))}
                                    className="mt-2 w-full accent-current"
                                    style={{ color: accentColor }}
                                  />
                                </label>
                                <label className={`${textSecondary} text-xs`}>
                                  最长
                                  <input
                                    type="range"
                                    min="2"
                                    max="20"
                                    step="1"
                                    value={autoMixMaxDuration}
                                    onChange={(event) => handleAutoMixMaxDurationChange(Number(event.target.value))}
                                    className="mt-2 w-full accent-current"
                                    style={{ color: accentColor }}
                                  />
                                </label>
                              </div>
                              <div className={`${textSecondary} text-xs mt-2`}>实际时长会吸附到完整的 8 / 16 / 24 / 32 拍。</div>
                            </div>
                          )}
                          {autoMixEnhanced && (
                            <div className={`${textSecondary} text-xs`}>
                              增强版过渡时长由算法根据两首歌曲的 BPM 与能量自动决定，无需手动调整。
                            </div>
                          )}

                          <div className={`${bgCard} rounded-lg p-3 border ${borderColor}`}>
                            <div className="flex items-start gap-2">
                              <Info className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
                              <div className="text-xs">
                                <p className={`${textPrimary} font-medium mb-1`}>开发阶段提示</p>
                                <p className={`${textSecondary}`}>
                                  本功能当前处于开发阶段，可能会影响播放体验。我们正在持续优化算法，以提供更流畅的混音效果。
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 网易云不可用歌曲补全 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>网易云可用性增强</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      当网易云官方没有返回播放链接时，可尝试从其他公开音乐源匹配同一首歌
                    </p>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-6">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1 flex items-center gap-2`}>
                            灰色歌曲跨平台补全
                            <span className="text-xs px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>Enhanced</span>
                          </div>
                          <div className={`${textSecondary} text-sm`}>
                            仅补全免费但受版权或地区影响的歌曲；VIP 与付费专辑不会绕过平台权限
                          </div>
                        </div>
                        <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={crossPlatformFallbackEnabled}
                            onChange={(event) => {
                              const enabled = event.target.checked
                              if (enabled) {
                                // 开启前先弹出免责声明，确认后才真正启用
                                setFallbackCountdown(20)
                                setShowFallbackDisclaimer(true)
                              } else {
                                setCrossPlatformFallbackEnabled(false)
                                localStorage.setItem('crossPlatformFallbackEnabled', JSON.stringify(false))
                              }
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: crossPlatformFallbackEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        使用本地服务完成匹配，不会开启系统代理、安装证书或修改网络设置。关闭后立即恢复仅使用网易云官方链接。
                      </div>
                    </div>
                  </div>
                  
                  {/* 第三方歌词源 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>第三方歌词源</h3>
                    <p className={`${textSecondary} text-sm mb-6`}>
                      启用后将从社区歌词库获取更丰富的歌词内容，包括逐字歌词和翻译
                    </p>
                    
                    {/* 启用第三方歌词源 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用第三方歌词源</div>
                          <div className={`${textSecondary} text-sm`}>
                            从 AMLL TTML DB 和 Lrclib 等社区歌词库获取高质量歌词
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={thirdPartyLyricsEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setThirdPartyLyricsEnabled(enabled)
                              localStorage.setItem('thirdPartyLyricsEnabled', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: thirdPartyLyricsEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* 启用 Apple Music 歌词（已登录 AM 才可开启；登录后自动开启） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>启用 Apple Music 歌词</div>
                          <div className={`${textSecondary} text-sm`}>
                            {appleLoggedIn
                              ? 'Apple 逐音节歌词与翻译（登录 Apple Music 后自动启用）'
                              : '需先登录 Apple Music 账号后才可启用'}
                          </div>
                        </div>
                        <label className={`relative inline-flex items-center ${appleLoggedIn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
                          <input
                            type="checkbox"
                            checked={appleMusic.enabled}
                            disabled={!appleLoggedIn}
                            onChange={(e) => updateAppleMusic({ enabled: e.target.checked })}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: appleMusic.enabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* Apple 原生音源（Cider 式直连 AM，需 Widevine；失败自动回退网易云/QQ） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>Apple 原生音源</div>
                          <div className={`${textSecondary} text-sm`}>
                            直连 Apple 播放 AM 原版曲目（消除换源偏差），需浏览器/系统 Widevine 支持，失败自动回退网易云/QQ
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={appleNativeStreamEnabled}
                            onChange={(e) => {
                              const enabled = e.target.checked
                              setAppleNativeStreamEnabled(enabled)
                              localStorage.setItem('appleNativeStream', JSON.stringify(enabled))
                            }}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: appleNativeStreamEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                    </div>

                    {/* Apple Music 播放面（WebView2）：仅在原生 CENC 播放失败时作为兼容兜底；
                        兼容窗口保留独立登录会话，未授权时继续走网易云/QQ 载体兜底 */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>Apple Music 播放面</div>
                          <div className={`${textSecondary} text-sm`}>
                            Electron 原生 CENC 无法播放时才启用此兼容窗口；首次使用需在窗口内单独登录 Apple Music。
                            {appleBridgeReady
                              ? (appleBridgeAuthorized ? '播放面已授权 ✓' : '播放面未授权：点「打开窗口」登录后即可作为兼容兜底')
                              : '正常播放无需启动；原生 CENC 失败时会自动拉起，也可手动打开登录'}
                          </div>
                        </div>
                        <button
                          onClick={toggleAppleBridgeWindow}
                          disabled={appleBridgeBusy}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border ${borderColor} ${textPrimary} hover:opacity-80 disabled:opacity-50 whitespace-nowrap`}
                        >
                          {appleBridgeBusy ? '启动中…' : appleBridgeWindowVisible ? '隐藏窗口' : '打开窗口'}
                        </button>
                      </div>
                    </div>

                    {/* 自适应最佳歌词 */}
                    {thirdPartyLyricsEnabled && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                        <div className="flex items-center justify-between">
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>自适应最佳歌词</div>
                            <div className={`${textSecondary} text-sm`}>
                              自动适配最佳歌词源，若关闭将使用当前平台源
                            </div>
                          </div>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={adaptiveLyrics}
                              onChange={(e) => {
                                const enabled = e.target.checked
                                setAdaptiveLyrics(enabled)
                                localStorage.setItem('adaptiveLyrics', JSON.stringify(enabled))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: adaptiveLyrics ? accentColor : '' }}></div>
                          </label>
                        </div>
                      </div>
                    )}

                    {/* 歌词库选择 */}
                    {thirdPartyLyricsEnabled && adaptiveLyrics && (
                      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                        <div className={`${textPrimary} font-medium mb-3`}>首要歌词库</div>
                        <div className={`${textSecondary} text-sm mb-4`}>
                          仅请求当前歌曲平台及第三方来源，优先使用有逐字的歌词
                        </div>
                        
                        <div className="space-y-2">
                          {[
                            { key: 'AMLL', name: 'AMLL TTML DB', desc: '社区逐字歌词库（可含翻译与罗马音，以收录为准）' },
                            { key: 'Apple Music', name: 'Apple Music', desc: 'Apple Music 逐字歌词（对唱按演唱者着色）' },
                            { key: 'NetEase', name: '网易云音乐', desc: '仅网易云歌曲使用，其他平台自动回退' },
                            { key: 'QQMusic', name: 'QQ音乐', desc: '仅QQ歌曲使用，其他平台自动回退' },
                            { key: 'Platform', name: '当前平台', desc: '使用正在播放的平台' }
                          ].map((source) => (
                            <button
                              key={source.key}
                              onClick={() => {
                                setPrimaryLyricsSource(source.key)
                                localStorage.setItem('primaryLyricsSource', source.key)
                              }}
                              className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors border-2 ${
                                primaryLyricsSource === source.key
                                  ? playerTheme === 'dark'
                                    ? 'bg-white/5 hover:bg-white/10'
                                    : 'bg-black/5 hover:bg-black/10'
                                  : playerTheme === 'dark'
                                  ? 'bg-white/5 hover:bg-white/10 border-transparent'
                                  : 'bg-black/5 hover:bg-black/10 border-transparent'
                              }`}
                              style={{
                                borderColor: primaryLyricsSource === source.key ? accentColor : 'transparent',
                                backgroundColor: primaryLyricsSource === source.key 
                                  ? `${accentColor}20`
                                  : ''
                              }}
                            >
                              <div 
                                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center`}
                                style={{
                                  borderColor: primaryLyricsSource === source.key 
                                    ? accentColor 
                                    : playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                                  backgroundColor: primaryLyricsSource === source.key ? accentColor : 'transparent'
                                }}
                              >
                                {primaryLyricsSource === source.key && (
                                  <div className="w-2 h-2 rounded-full bg-white"></div>
                                )}
                              </div>
                              <div className="flex-1 text-left">
                                <div className={`${textPrimary} text-sm font-medium`}>{source.name}</div>
                                <div className={`${textTertiary} text-xs`}>{source.desc}</div>
                              </div>
                              {primaryLyricsSource === source.key && (
                                <div 
                                  className={`px-2 py-1 rounded ${textPrimary} text-xs font-medium`}
                                  style={{ backgroundColor: `${accentColor}50` }}
                                >
                                  首选
                                </div>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 性能优化 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>性能优化</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
                      {!isTvModeActive() && (
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>GPU 硬件加速</div>
                          <div className={`${textSecondary} text-sm`}>使用显卡加速渲染动画，提升流畅度</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={gpuAcceleration}
                            onChange={(e) => void handleGpuAccelerationToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: gpuAcceleration ? accentColor : '' }}></div>
                        </label>
                      </div>
                      )}
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        {isTvModeActive() ? (
                          <div>TV 端渲染由系统 WebView 自动管理（GPU 合成），无需手动配置。当前状态：{gpuStatus?.actualEnabled ? 'GPU 合成已启用' : '未知'}</div>
                        ) : (
                          <>
                            <div>建议保持开启。动态壁纸、歌词动画和界面合成依赖 GPU；关闭后界面可能明显卡顿。仅建议在显卡驱动兼容故障时关闭，重启后生效。</div>
                            {gpuStatus && (
                              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                                <span>{gpuStatus.actualEnabled ? '当前已启用 GPU 合成' : '当前使用软件渲染'}</span>
                                {gpuStatus.gpu && <span>{gpuStatus.gpu.deviceString || gpuStatus.gpu.vendorString || '已检测显卡'}{gpuStatus.gpu.driverVersion ? ` | 驱动 ${gpuStatus.gpu.driverVersion}` : ''}</span>}
                                {gpuStatus.actualEnabled !== gpuAcceleration && <span className="text-amber-400">当前设置尚未生效，请重启软件</span>}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`} data-tv-hide="desktop">
                      <div className="mb-3">
                        <div className={`${textPrimary} font-medium mb-1`}>显卡选择</div>
                        <div className={`${textSecondary} text-sm`}>优先使用哪块显卡进行加速渲染（切换后重启生效）</div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleGpuPreferenceChange('auto')}
                          className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'auto' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                          style={gpuPreference === 'auto' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                        >
                          自动
                        </button>
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'discrete').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('discrete')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '独立显卡'}</span>
                            <span className="ml-1.5 text-xs opacity-70">独显</span>
                          </button>
                        ))}
                        {(gpuStatus?.gpus ?? []).filter(g => g.kind === 'integrated').map(gpu => (
                          <button
                            key={gpu.vendorString + gpu.deviceString}
                            type="button"
                            onClick={() => void handleGpuPreferenceChange('integrated')}
                            className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                            style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                          >
                            <span className="font-medium">{gpu.deviceString || gpu.vendorString || '核显'}</span>
                            <span className="ml-1.5 text-xs opacity-70">核显</span>
                          </button>
                        ))}
                        {(!gpuStatus || (gpuStatus.gpus ?? []).filter(g => g.kind !== 'unknown').length === 0) && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('discrete')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'discrete' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'discrete' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              独立显卡
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGpuPreferenceChange('integrated')}
                              className={`rounded-lg border px-3 py-2 text-sm transition-all ${gpuPreference === 'integrated' ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
                              style={gpuPreference === 'integrated' ? { backgroundColor: accentColor } : { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }}
                            >
                              核显 / 集成显卡
                            </button>
                          </>
                        )}
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        默认使用独立显卡以获得最佳动画流畅度；笔记本想省电或独显驱动异常时可切换为核显或自动。切换后需重启软件生效。
                      </div>
                    </div>

                    {/* 全局高刷：渲染帧率跟随所在显示器刷新率（最高 300Hz） */}
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`} data-tv-hide="desktop">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>全局高刷</div>
                          <div className={`${textSecondary} text-sm`}>解除 60Hz 帧率限制，全局渲染跟随显示器刷新率（最高 360Hz），尤其提升播放页动画流畅度</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={highRefreshEnabled}
                            onChange={(e) => void handleHighRefreshToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: highRefreshEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {highRefreshEnabled && (
                        <>
                          {/* 档位选择：跟随显示器最高 / 30-360 */}
                          <div className="mt-4">
                            <div className={`mb-2 text-xs font-medium ${textSecondary}`}>渲染帧率</div>
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => void handleHighRefreshHzChange(null)}
                                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${highRefreshHz === null ? 'border-transparent text-white' : `${borderColor} ${textSecondary} hover:opacity-80`}`}
                                style={highRefreshHz === null ? { backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}44` } : undefined}
                              >
                                跟随显示器
                              </button>
                              {HIGH_REFRESH_OPTIONS.filter(hz => hz <= (displayInfo?.currentHz || 60)).map(hz => {
                                const active = highRefreshHz === hz
                                return (
                                  <button
                                    key={hz}
                                    type="button"
                                    onClick={() => void handleHighRefreshHzChange(hz)}
                                    className={`rounded-full border px-3 py-1.5 text-xs font-medium tabular-nums transition-all ${active ? 'border-transparent text-white' : `${borderColor} ${textSecondary} hover:opacity-80`}`}
                                    style={active ? { backgroundColor: accentColor, boxShadow: `0 0 10px ${accentColor}44` } : undefined}
                                    title={`${hz}Hz`}
                                  >
                                    {hz}
                                  </button>
                                )
                              })}
                            </div>
                            {highRefreshHz !== null && displayInfo && displayInfo.currentHz < highRefreshHz && (
                              <div className={`mt-2 text-[11px] text-amber-400`}>当前窗口所在显示器最高 {displayInfo.currentHz}Hz，已按此限制生效</div>
                            )}
                            {highRefreshHz === null && (
                              <div className={`mt-2 text-[11px] ${textTertiary}`}>跟随窗口所在显示器最高刷新率（当前 {displayInfo?.currentHz || 60}Hz），窗口移到其他显示器自动跟随</div>
                            )}
                          </div>
                        </>
                      )}

                      {displayInfo && (
                        <div className={`mt-3 space-y-1 rounded-lg p-3 text-xs ${textTertiary}`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[13px]" style={{ color: textPrimary }}>当前渲染帧率</span>
                            <span className="tabular-nums" style={{ color: highRefreshEnabled ? accentColor : undefined }}>{displayInfo.currentHz || 60} Hz</span>
                            {highRefreshEnabled && <span className="ml-1 rounded-full px-2 py-0.5 text-[10px] text-white" style={{ background: accentColor }}>高刷已开启</span>}
                          </div>
                          <div className="mt-2 space-y-0.5">
                            {displayInfo.displays?.map(display => (
                              <div key={display.id} className="flex items-center justify-between gap-2">
                                <span className="truncate">
                                  {display.isMainWindow ? '🖥️ ' : ''}{display.label}
                                  {display.isPrimary ? ' · 主屏' : ''}
                                  {display.isMainWindow ? ' · 窗口所在' : ''}
                                </span>
                                {display.frequency >= 120 && <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-400">高刷屏</span>}
                              </div>
                            ))}
                          </div>
                          {displayInfo.error && <div className="mt-1 text-amber-400">显示器信息读取失败：{displayInfo.error}</div>}
                          <div className="mt-1">开启后立即生效；窗口移到其他显示器时自动跟随该显示器刷新率。</div>
                        </div>
                      )}
                    </div>

                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>音频频谱分析</div>
                          <div className={`${textSecondary} text-sm`}>用于封面脉动等可视化效果</div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={audioAnalyzerEnabled}
                            onChange={(e) => handleAudioAnalyzerToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: audioAnalyzerEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>
                      <div className={`${textTertiary} text-xs mt-3 p-3 rounded-lg`} style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
                        关闭后会降低 CPU 占用，适合低性能设备或省电场景。
                      </div>
                    </div>
                  </div>

                  {/* 代理自动配置：模型下载 / 应用更新走本地代理 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>网络与代理</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className={`${textPrimary} font-medium mb-1`}>代理自动配置</div>
                          <div className={`${textSecondary} text-xs leading-relaxed`}>
                            网络环境不佳时，当您打开代理后请打开此功能，此功能会自动配置相关功能。
                            <br />
                            开启后自动扫描本机代理端口，模型下载与应用更新将走代理。
                          </div>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                          <input
                            type="checkbox"
                            checked={proxyEnabled}
                            disabled={proxyScanning}
                            onChange={(e) => handleProxyToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: proxyEnabled ? accentColor : '' }}></div>
                        </label>
                      </div>

                      {proxyScanning && (
                        <div className={`mt-3 text-xs ${textSecondary}`}>正在扫描本地代理端口…</div>
                      )}

                      {/* 当前连接信息 */}
                      {proxyEnabled && proxyState.proxy && (
                        <div className="mt-3 flex items-center gap-2 flex-wrap text-xs">
                          <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1" style={{ backgroundColor: `${accentColor}22`, color: accentColor, border: `1px solid ${accentColor}55` }}>
                            已连接
                          </span>
                          <span className={`${textPrimary}`}>端口：{proxyState.proxy.port}</span>
                          <span className={`${textPrimary}`}>地址：{proxyState.proxy.host}</span>
                          {(() => {
                            const cur = proxyList.find((p) => p.port === proxyState.proxy?.port)
                            return cur ? <span className={`${textPrimary}`}>探测延迟：{cur.latency}ms</span> : null
                          })()}
                          <button type="button" onClick={handleProxyRescan} disabled={proxyScanning} className="rounded-lg px-2.5 py-1 transition-colors" style={{ color: accentColor, background: `${accentColor}18`, border: `1px solid ${accentColor}44` }}>
                            重新扫描
                          </button>
                        </div>
                      )}

                      {/* 三路并行联通测试：网络联通（百度）/ GitHub / Google，各最多 8 次、整体超 1 分钟显示连接超时 */}
                      {proxyEnabled && (
                        <div className="mt-3 space-y-1.5">
                          {([
                            ['baidu', '网络联通状态'],
                            ['github', 'GitHub 联通状态'],
                            ['google', 'Google 联通状态'],
                          ] as const).map(([key, label]) => {
                            const item = proxyLatency?.status === 'done' ? proxyLatency.result?.[key] : null
                            return (
                              <div key={key} className={`flex items-center gap-2 text-xs ${textSecondary}`}>
                                <span className="w-28 shrink-0 whitespace-nowrap">{label}：</span>
                                {proxyLatency?.status === 'testing' ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="inline-block h-3 w-3 rounded-full border-2 border-transparent animate-spin" style={{ borderTopColor: accentColor, borderRightColor: accentColor }} />
                                    正在测试中…
                                  </span>
                                ) : item?.timeout ? (
                                  <span className="text-red-400">连接超时</span>
                                ) : item ? (
                                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                    <span className={item.avgLatency < 150 ? 'text-green-500' : item.avgLatency < 400 ? 'text-yellow-500' : 'text-red-400'}>
                                      延迟 {item.avgLatency}ms
                                    </span>
                                    <span className={textTertiary}>({item.minLatency}~{item.maxLatency}ms)</span>
                                    <span className={item.lossRate === 0 ? 'text-green-500' : 'text-red-400'}>
                                      丢包 {item.lossRate}%
                                    </span>
                                    {/* 只有被 1 分钟截止截断、没跑满 8 次时才显示 x/8（结果不完整） */}
                                    {item.total < 8 && (
                                      <span className={textTertiary}>{item.loss}/{item.total} 次</span>
                                    )}
                                  </span>
                                ) : (
                                  <span>等待测试…</span>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* 扫描结果列表 */}
                      {proxyList.length > 0 && (
                        <div className="mt-3 space-y-1.5">
                          <div className={`${textSecondary} text-xs mb-1`}>检测到的本地代理（按延迟排序）：</div>
                          {proxyList.map((p) => (
                            <button
                              key={p.port}
                              type="button"
                              disabled={proxyScanning}
                              onClick={() => void window.electron?.proxyManager?.enable?.(p.port).then((s) => { if (s) setProxyState(s) })}
                              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs transition-colors disabled:opacity-50"
                              style={{
                                background: proxyState.proxy?.port === p.port ? `${accentColor}20` : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)',
                                border: `1px solid ${proxyState.proxy?.port === p.port ? `${accentColor}66` : playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}`,
                              }}
                            >
                              <span className={`${textPrimary}`}>127.0.0.1:{p.port}</span>
                              <span className="flex items-center gap-2">
                                <span className={p.latency < 100 ? 'text-green-500' : p.latency < 300 ? 'text-yellow-500' : 'text-red-400'}>
                                  {p.latency}ms
                                </span>
                                {proxyState.proxy?.port === p.port && <span style={{ color: accentColor }}>使用中</span>}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* 开发者选项 */}
                  <div>
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>开发者选项</h3>
                    <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                      <div className="flex items-center justify-between mb-3">
                        <div className={`${textPrimary} font-medium`}>开发者模式</div>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={developerMode}
                            onChange={(e) => handleDeveloperModeToggle(e.target.checked)}
                            className="sr-only peer"
                          />
                          <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: developerMode ? accentColor : '' }}></div>
                        </label>
                      </div>
                      
                      {/* 警告文案 */}
                      {developerMode && (
                        <div className={`mt-3 p-3 rounded-lg ${playerTheme === 'dark' ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-yellow-100 border border-yellow-300'}`}>
                          <p className={`text-xs ${playerTheme === 'dark' ? 'text-yellow-300' : 'text-yellow-800'}`}>
                            ⚠️ 当前模式仅限调试作用，无问题情况下请勿打开
                          </p>
                        </div>
                      )}

                      {/* 调试面板子开关（开发者模式开启后显示） */}
                      {developerMode && (
                        <>
                          <div className="mt-3">
                            <VmpStatusCard
                              dark={playerTheme === 'dark'}
                              accent={accentColor}
                              borderColor={playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}
                            />
                          </div>
                          <div className="mt-3 rounded-xl border p-4" style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', borderColor: borderColor }}>
                          <div className={`${textPrimary} font-medium mb-2 text-sm`}>调试面板</div>
                          {[
                            { key: 'waveforge:debug-show-backend', label: '后端日志（左下）' },
                            { key: 'waveforge:debug-show-frontend', label: '前端日志（左下）' },
                            { key: 'waveforge:debug-show-perf', label: '性能面板（右上）' },
                          ].map((panel) => {
                            const on = getDebugPanelVisible(panel.key)
                            return (
                              <label key={panel.key} className="flex items-center justify-between py-1.5 cursor-pointer">
                                <span className={`text-xs ${textSecondary}`}>{panel.label}</span>
                                <span className="relative inline-flex items-center">
                                  <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={(e) => setDebugPanelVisible(panel.key, e.target.checked)}
                                    className="sr-only peer"
                                  />
                                  <span className={`w-9 h-5 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all`} style={{ backgroundColor: on ? accentColor : '' }}></span>
                                </span>
                              </label>
                            )
                          })}
                          {/* 过渡调试：显示过渡用的引擎/策略/效果清单弹窗 */}
                          <label className="flex items-center justify-between py-1.5 cursor-pointer">
                            <span className={`text-xs ${textSecondary}`}>过渡调试（右上角显示过渡详情）</span>
                            <span className="relative inline-flex items-center">
                              <input
                                type="checkbox"
                                checked={transitionDebugEnabled}
                                onChange={(e) => handleTransitionDebugToggle(e.target.checked)}
                                className="sr-only peer"
                              />
                              <span className={`w-9 h-5 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all`} style={{ backgroundColor: transitionDebugEnabled ? accentColor : '' }}></span>
                            </span>
                          </label>
                        </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* 缓存清理 */}
                  <div className="mt-8">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-4`}>缓存管理</h3>
                    
                    {/* 缓存清理按钮 */}
                    <button
                      onClick={() => setShowCacheClear(true)}
                      className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div 
                            className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{ backgroundColor: `${accentColor}20` }}
                          >
                            <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                          </div>
                          <div>
                            <div className={`${textPrimary} font-medium mb-1`}>缓存清理</div>
                            <div className={`${textSecondary} text-sm`}>
                              管理封面、歌单列表和错误日志缓存
                            </div>
                          </div>
                        </div>
                        <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                      </div>
                    </button>
                  </div>

                  {/* 打开 OOBE（首次启动）引导 */}
                  <button
                    onClick={() => {
                      try { localStorage.removeItem('waveforge:oobe-shown') } catch { /* ignore */ }
                      window.dispatchEvent(new CustomEvent('waveforge-trigger-oobe'))
                      window.dispatchEvent(new CustomEvent('showToast', {
                        detail: { message: '正在打开首次启动引导', type: 'info' },
                      }))
                    }}
                    className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Sparkles className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>打开 OOBE（首次启动）引导</div>
                          <div className={`${textSecondary} text-sm`}>手动打开主题选择 / 隐私条款 / 免责声明引导</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                    </div>
                  </button>

                  {/* 看歌本地标记库 */}
                  <button
                    type="button"
                    onClick={() => {
                      setLocalMvMarks(getLocalMvMarks())
                      setShowLocalMvMarks(true)
                    }}
                    className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <FolderHeart className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>看歌本地标记库</div>
                          <div className={`${textSecondary} text-sm`}>查看/移除你手动标记的歌曲对应 MV（{getLocalMvMarks().length} 条）</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                    </div>
                  </button>

                  {/* 清除 MV 匹配缓存 */}
                  <button
                    type="button"
                    onClick={() => {
                      if (!window.confirm('清除所有 MV 匹配缓存（24h 内存结果 + 手动标记 + 黑名单）？将重新搜索当前歌曲的 MV。')) return
                      clearAllMvMatchCache()
                      window.location.reload()
                    }}
                    className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} ${hoverBg} transition-all text-left`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                          <Trash2 className="w-5 h-5" style={{ color: accentColor }} />
                        </div>
                        <div>
                          <div className={`${textPrimary} font-medium mb-1`}>清除 MV 匹配缓存</div>
                          <div className={`${textSecondary} text-sm`}>MV 匹配结果不对/想换一个视频时使用（重搜当前歌曲）</div>
                        </div>
                      </div>
                      <ChevronRight className={`w-5 h-5 ${textSecondary}`} />
                    </div>
                  </button>
                </div>
              )}

              {/* 关于标签页 */}
              {activeTab === 'about' && (
                <div className="space-y-4 pb-4">
                  <section className={`${bgCard} rounded-2xl border ${borderColor} overflow-hidden`}>
                    <div className="p-5">
                      <div className="flex items-start justify-between gap-4 mb-5">
                        <div>
                          <div className={`text-xs font-semibold tracking-[0.2em] uppercase ${textTertiary} mb-2`}>About</div>
                          <h2 className={`text-2xl font-bold ${textPrimary}`}>关于 WaveForge</h2>
                        </div>
                        <span className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold ${playerTheme === 'dark' ? 'bg-white/10 text-white/70' : 'bg-black/5 text-black/60'}`}>
                          {getVersionDisplay(packageInfo.version)} · 预览版
                        </span>
                      </div>

                      <div className={`rounded-xl border ${borderColor} p-4 relative`}>
                        <div className="flex items-center gap-4 pr-10">
                          <img src={appLogoUrl} alt="WaveForge" className="w-14 h-14 rounded-xl object-cover shadow-lg shrink-0" />
                          <div className="min-w-0">
                            <p className={`text-xs ${textTertiary} mb-1`}>开发者</p>
                            <p className={`text-lg font-semibold leading-6 ${textPrimary}`}>Yoshino / Castorice</p>
                            <p className={`text-lg font-semibold leading-6 ${textPrimary}`}>IceFire_Icer</p>
                            <p className={`text-sm leading-6 ${textSecondary} mt-1`} style={{ textWrap: 'pretty' }}>WaveForge 澜音工坊的开发与维护</p>
                          </div>
                        </div>
                        <button
                          onClick={() => openExternal('https://www.afdian.com/a/Kirito666233')}
                          title="支持 WaveForge"
                          aria-label="支持 WaveForge"
                          className="absolute top-3 right-3 w-9 h-9 rounded-full flex items-center justify-center text-white transition-all hover:scale-110 hover:shadow-md"
                          style={{ background: `linear-gradient(135deg, ${accentColor}, #ff5b9d)`, boxShadow: `0 6px 16px ${accentColor}24` }}
                        >
                          <Heart className="w-4 h-4" fill="currentColor" />
                        </button>
                      </div>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        <div>
                          <p className={`font-medium ${textPrimary}`}>查看软件源代码</p>
                          <p className={`text-sm ${textSecondary} mt-1`}>选择国内 Gitee 或 GitHub 仓库</p>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3 w-full">
                          <button onClick={() => openExternal('https://gitee.com/kirito666233/wave-forge')} className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 flex items-center justify-center gap-2 transition-colors`}>
                            <Code2 className="w-4 h-4" /><span className="text-sm font-medium">Gitee</span><ExternalLink className="w-3.5 h-3.5 opacity-60" />
                          </button>
                          <button onClick={() => openExternal('https://github.com/YoshinoRinn/WaveForge')} className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 flex items-center justify-center gap-2 transition-colors`}>
                            <Github className="w-4 h-4" /><span className="text-sm font-medium">GitHub</span><ExternalLink className="w-3.5 h-3.5 opacity-60" />
                          </button>
                        </div>
                      </div>

                      <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                        {/* 检查新版本 + 版本历史 */}
                        <div className="flex gap-3 w-full">
                          <button onClick={() => void checkForUpdates()} disabled={updateCheck.status === 'checking'} className={`flex-1 py-3 px-4 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} font-medium transition-colors disabled:opacity-60`}>
                            {updateCheck.status === 'checking' ? '正在检查新版本…' : '检查新版本'}
                          </button>
                          <button onClick={() => setShowVersionHistory(true)} className={`py-3 px-4 rounded-xl border ${borderColor} ${textPrimary} text-sm font-medium transition-colors ${hoverBg}`}>版本历史</button>
                        </div>

                        {/* 检查结果：有更新 → 当前/新版本 + 查看详情；无更新 → 当前为最新 */}
                        {updateCheck.message && (
                          <div className="mt-3">
                            {updateCheck.status === 'available' ? (
                              <div className="flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}33` }}>
                                <span className={`text-sm ${textPrimary}`}>{updateCheck.message}</span>
                                <button onClick={openUpdateDetails} className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>查看详情</button>
                              </div>
                            ) : (
                              <p className={`${updateCheck.status === 'error' ? 'text-red-400' : textSecondary} text-center text-sm`}>{updateCheck.message}</p>
                            )}
                          </div>
                        )}

                        {/* 待应用更新常驻提示（上次「稍后」/ 已下载完成，重启即生效） */}
                        {pendingUpdate?.version && (
                          <div className="mt-3 flex items-center justify-between gap-3 rounded-xl px-4 py-3" style={{ background: `${accentColor}12`, border: `1px solid ${accentColor}33` }}>
                            <span className={`text-sm ${textPrimary}`}>新版本 {getVersionDisplay(pendingUpdate.version)} 已就绪，重启软件生效</span>
                            <button onClick={() => void handleRestartForUpdate()} className="shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: accentColor }}>立即重启</button>
                          </div>
                        )}

                        {/* 自动检测新版本（可关闭） */}
                        <div className="mt-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${textPrimary}`}>自动检测新版本</p>
                            <p className={`text-xs ${textTertiary} mt-0.5`}>每次启动时后台检测，发现新版本仅提示</p>
                          </div>
                          <label className="relative inline-flex flex-shrink-0 items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={autoCheckUpdate}
                              onChange={(e) => {
                                setAutoCheckUpdate(e.target.checked)
                                localStorage.setItem('autoCheckUpdate', JSON.stringify(e.target.checked))
                              }}
                              className="sr-only peer"
                            />
                            <div className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)]`} style={{ backgroundColor: autoCheckUpdate ? accentColor : '' }} />
                          </label>
                        </div>

                        {/* 跳过此版本：自动检测不再提示该版本，手动检查仍可更新 */}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`text-sm font-medium ${textPrimary}`}>跳过此版本</p>
                            <p className={`text-xs ${textTertiary} mt-0.5`}>
                              {skippedVersion
                                ? `已跳过版本 ${getVersionDisplay(skippedVersion)} 的更新提示，您仍可手动检查新版本进行更新`
                                : '当前版本不再提示更新，但是您仍可手动检查新版本进行更新'}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={skippedVersion ? handleUnskipVersion : () => void handleSkipVersion()}
                            className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${skippedVersion ? `${textSecondary} border ${borderColor} hover:bg-white/5` : 'text-white'}`}
                            style={skippedVersion ? undefined : { backgroundColor: accentColor }}
                          >
                            {skippedVersion ? '取消跳过' : '跳过此版本'}
                          </button>
                        </div>
                      </div>
                    </div>
                  </section>

                  <button
                    onClick={() => setShowLegalModal(true)}
                    className={`w-full group flex items-center justify-between gap-3 rounded-xl border px-4 py-3.5 transition-all hover:-translate-y-0.5 hover:shadow-lg ${playerTheme === 'dark' ? 'border-white/10 bg-white/5 hover:bg-white/10' : 'border-black/10 bg-black/5 hover:bg-black/10'}`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="text-left min-w-0">
                        <div className={`font-semibold truncate ${textPrimary}`}>法律声明 / 用户协议</div>
                        <div className={`text-xs ${textTertiary} mt-0.5 truncate`}>使用本软件即表示您已阅读并同意相关条款</div>
                      </div>
                    </div>
                    <ChevronRight className={`w-4 h-4 shrink-0 opacity-50 group-hover:translate-x-0.5 group-hover:opacity-90 transition-all`} style={{ color: accentColor }} />
                  </button>

                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                    <div className="flex items-start gap-4">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}><Users className="w-5 h-5" /></div>
                      <div>
                        <h3 className={`text-lg font-semibold ${textPrimary}`}>特别鸣谢 / 粉丝开发者</h3>
                        <p className={`mt-3 font-medium ${textPrimary}`}>WaveForge 澜音工坊群的各位</p>
                        <p className={`mt-1.5 text-sm leading-6 ${textSecondary}`}>感谢各位朋友们对软件的喜爱与鼓励。</p>
                      </div>
                    </div>
                  </section>

                  {!isTvModeActive() && (
                  <section className={`${bgCard} rounded-2xl border ${borderColor} p-5`}>
                    <div className="flex items-start gap-4 mb-5">
                      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
                        <KeyRound className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className={`text-lg font-semibold ${textPrimary}`}>设备授权</h3>
                        <p className={`text-sm ${textSecondary} mt-1.5 leading-6`}>仅用作设备标识，这不会收集关于您设备的任何信息</p>
                      </div>
                    </div>
                    <button
                      onClick={() => void copyDeviceId()}
                      disabled={deviceState.status === 'loading'}
                      className="w-full rounded-xl px-5 py-3.5 text-white font-semibold flex items-center justify-center gap-2 transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                      style={{ backgroundColor: accentColor, boxShadow: `0 10px 28px ${accentColor}24` }}
                    >
                      <Copy className="w-4 h-4" />
                      获取识别码
                    </button>
                    <div className={`mt-4 pt-4 border-t ${borderColor}`}>
                      <button
                        onClick={() => {
                          setRedeemMessage(null)
                          setShowRedeemModal(true)
                        }}
                        className={`w-full rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-5 py-3.5 font-semibold flex items-center justify-center gap-2 transition-colors`}
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        测试码验证
                      </button>
                      <button
                        onClick={() => {
                          setDeleteLicenseCountdown(10)
                          setShowDeleteLicenseModal(true)
                        }}
                        className={`w-full mt-2 rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-5 py-3.5 font-semibold flex items-center justify-center gap-2 transition-colors ${playerTheme === 'dark' ? 'hover:text-red-400 hover:border-red-400/40' : 'hover:text-red-600 hover:border-red-500/40'}`}
                      >
                        <Trash2 className="w-4 h-4" />
                        删除识别码与测试码
                      </button>
                      {deviceState.grants.length > 0 && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {deviceState.grants.map(grant => (
                            <span key={grant.feature} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium" style={{ backgroundColor: `${accentColor}18`, color: accentColor }}>
                              <BadgeCheck className="w-3.5 h-3.5" />
                              {grant.label}{grant.expiresAt ? ` · 至 ${new Date(grant.expiresAt * 1000).toLocaleDateString('zh-CN')}` : ' · 永久'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </section>
                  )}

                  <div className="flex items-center justify-center px-1">
                    <p className={`${textTertiary} text-xs`}>© 2026 WaveForge. All rights reserved.</p>
                  </div>
                </div>
              )}
                        </div>
</div> {/* 关闭内容层 div from line 144 */}
          </motion.div>
        </React.Fragment>
      )}
      
      {/* 首页自定义弹窗 */}
      <HomeCustomizeModal 
        key="home-customize-modal"
        show={showHomeCustomize}
        onClose={() => setShowHomeCustomize(false)}
        playerTheme={playerTheme}
        onBlurAdjustOpen={() => {
          // 当打开模糊度调整时，关闭设置面板
          onClose()
        }}
        onReopenRequest={() => {
          // 重新打开首页自定义面板
          setShowHomeCustomize(true)
        }}
      />
      
      {/* 缓存清理弹窗 */}
      {/* 播放音质弹窗 */}
      <AudioQualitySettingsModal
        key="audio-quality-settings-modal"
        show={showAudioQuality}
        onClose={() => setShowAudioQuality(false)}
        playerTheme={playerTheme}
        neteaseVip={neteaseVip}
        qqVip={qqVip}
        neteaseLoggedIn={neteaseLoggedIn}
        qqLoggedIn={qqLoggedIn}
        spotifyLoggedIn={spotifyLoggedIn}
        kugouLoggedIn={kugouLoggedIn}
        sodaLoggedIn={sodaLoggedIn}
      />

      {/* 远程遥控器设置弹窗 */}
      <RemoteControlSettingsModal
        show={showRemoteSettings}
        onClose={() => setShowRemoteSettings(false)}
        playerTheme={playerTheme}
      />

      <CacheClearModal 
        key="cache-clear-modal"
        show={showCacheClear}
        onClose={() => setShowCacheClear(false)}
        playerTheme={playerTheme}
      />
      
      {/* 测试码验证弹窗 */}
      {showRedeemModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => {
            setShowRedeemModal(false)
            setRedeemCode('')
            setRedeemMessage(null)
          }}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border ${
              playerTheme === 'dark'
                ? 'bg-zinc-900 border-zinc-800'
                : 'bg-white border-gray-200'
            } shadow-2xl overflow-hidden`}
          >
            <div className={`px-5 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>测试码验证</h2>
            </div>
            <div className="px-5 py-5">
              <p className={`text-sm leading-6 ${textSecondary}`}>请将获取到的测试码粘贴在下方</p>
              <div className="mt-4 flex items-stretch gap-3">
                <input
                  autoFocus
                  value={redeemCode}
                  onChange={(event) => {
                    setRedeemCode(event.target.value)
                    if (redeemMessage?.type === 'error') setRedeemMessage(null)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    void pasteRedeemCode()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && redeemMessage?.type !== 'info') void redeemDeviceCode()
                  }}
                  placeholder="WF1.……"
                  autoComplete="off"
                  spellCheck={false}
                  title="右键可直接粘贴"
                  className={`min-w-0 flex-1 rounded-xl border ${borderColor} ${
                    playerTheme === 'dark' ? 'bg-black/20' : 'bg-black/5'
                  } ${textPrimary} px-4 py-3 font-mono text-sm outline-none focus:ring-2`}
                  style={{ '--tw-ring-color': accentColor } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={() => void pasteRedeemCode()}
                  disabled={redeemMessage?.type === 'info'}
                  className={`shrink-0 rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-60`}
                >
                  <ClipboardPaste className="w-4 h-4" />
                  粘贴
                </button>
              </div>
              {redeemMessage && (
                <p className={`mt-3 text-sm ${redeemMessage.type === 'error' ? 'text-red-400' : textSecondary}`}>
                  {redeemMessage.text}
                </p>
              )}
              <div className="mt-5 grid grid-cols-2 gap-3">
                <button
                  onClick={() => {
                    setShowRedeemModal(false)
                    setRedeemCode('')
                    setRedeemMessage(null)
                  }}
                  disabled={redeemMessage?.type === 'info'}
                  className={`rounded-xl border ${borderColor} ${hoverBg} ${textPrimary} px-4 py-3 font-semibold transition-colors disabled:opacity-60`}
                >
                  取消
                </button>
                <button
                  onClick={() => void redeemDeviceCode()}
                  disabled={redeemMessage?.type === 'info'}
                  className="rounded-xl px-4 py-3 text-white font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
                  style={{ backgroundColor: accentColor }}
                >
                  确定
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 设备配置检查弹窗（TV 端性能模式选择） */}
      {/* DPI 缩放确认弹窗（独立焦点域，保证弹窗内方向键导航可用） */}
      {pendingTvScale != null && (
        <div data-tv-scope className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 pointer-events-auto">
          <div className={`rounded-2xl border p-6 w-[min(92vw,520px)] shadow-2xl ${
            playerTheme === 'dark' ? 'bg-[#0b1220]/95 border-white/10' : 'bg-white/95 border-black/10'
          }`}>
            <div className={`text-base font-medium leading-relaxed ${playerTheme === 'dark' ? 'text-white' : 'text-gray-900'}`}>
              DPI 缩放已切换为 {pendingTvScale}%，界面是否与预期相符？
            </div>
            <div className={`mt-1 text-sm ${playerTheme === 'dark' ? 'text-white/60' : 'text-gray-500'}`}>
              若无法操作，将在 <span className="font-semibold">10</span> 秒后自动还原至上一次 DPI
            </div>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button
                data-tv-focus
                onClick={() => confirmTvScale()}
                className={`rounded-xl px-6 py-2.5 text-sm font-semibold transition-colors ${
                  playerTheme === 'dark' ? 'text-white/80 hover:text-white bg-white/10' : 'text-gray-700 hover:text-gray-900 bg-black/5'
                }`}
              >
                应用
              </button>
              <button
                ref={tvScaleCancelRef}
                data-tv-focus
                onClick={() => cancelTvScale()}
                className="rounded-xl px-6 py-2.5 text-sm font-semibold text-white transition-colors"
                style={{ backgroundColor: accentColor }}
              >
                取消（{tvScaleCountdown}）
              </button>
            </div>
          </div>
        </div>
      )}

      <DeviceInfoModal show={showDeviceInfo} onClose={() => setShowDeviceInfo(false)} playerTheme={playerTheme} />

      {/* 哔哩哔哩「看歌」扫码登录弹窗 */}
      {showBiliProfile && (
        <BilibiliProfileModal onClose={() => setShowBiliProfile(false)} playerTheme={playerTheme} />
      )}

      {/* 看歌本地标记库弹窗 */}
      {showLocalMvMarks && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[80] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 sm:p-10"
          onClick={() => setShowLocalMvMarks(false)}
        >
          <motion.div
            initial={{ scale: 0.96, y: 14 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.96, y: 14 }}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-xl max-h-[80vh] rounded-2xl border overflow-hidden flex flex-col shadow-2xl ${playerTheme === 'dark' ? 'bg-[#0c0e1a]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'}`}
          >
            <div className={`flex items-center justify-between px-5 py-4 border-b ${borderColor}`}>
              <div>
                <h3 className={`text-base font-bold ${textPrimary}`}>看歌本地标记库</h3>
                <p className={`text-xs mt-0.5 ${textSecondary}`}>手动标记的歌曲对应的 MV（仅保存在本机，移除后恢复自动匹配）</p>
              </div>
              <button type="button" onClick={() => setShowLocalMvMarks(false)} className={`p-1.5 rounded-lg ${playerTheme === 'dark' ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {localMvMarks.length === 0 ? (
                <p className={`text-center text-sm py-10 ${textTertiary}`}>还没有标记记录。在看歌搜索失败时手动选择一个视频播放，15 秒后会询问是否标记为该歌曲的 MV。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {localMvMarks.map((m) => (
                    <div key={m.songKey} className={`flex items-center gap-3 rounded-xl p-2.5 ${bgCard}`}>
                      <div className="w-20 h-12 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                        {m.pic ? (
                          <img src={resolveBiliPic(m.pic)} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                        ) : null}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`truncate text-sm font-medium ${textPrimary}`}>{m.songTitle} <span className={`text-xs font-normal ${textTertiary}`}>· {m.artist}</span></p>
                        <p className={`truncate text-xs mt-0.5 ${textTertiary}`}>{m.videoTitle}</p>
                        <p className={`text-[11px] mt-0.5 ${textTertiary}`}>标记于 {new Date(m.markedAt).toLocaleDateString()}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          removeLocalMvMark(m.songKey)
                          setLocalMvMarks(getLocalMvMarks())
                        }}
                        className="p-2 rounded-lg text-red-400/80 hover:bg-red-500/15 hover:text-red-400 transition-colors flex-shrink-0"
                        title="移除标记"
                      >
                        <Trash size={16} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}

      {showBiliLogin && (
        <BilibiliLoginPanel
          onClose={() => setShowBiliLogin(false)}
          onLoginSuccess={() => {
            setShowBiliLogin(false)
            refreshBiliAuth()
          }}
        />
      )}

      {/* TV：测试码验证弹窗（参考 PC 端，无粘贴按钮） */}
      {showTvRedeemModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-tv-scope
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          style={{ background: playerTheme === 'dark' ? 'rgba(0,0,0,0.75)' : 'rgba(0,0,0,0.5)' }}
          onClick={() => {
            setShowTvRedeemModal(false)
            setTvRedeemCode('')
            setTvRedeemState({ status: 'idle', message: null })
          }}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border shadow-2xl overflow-hidden ${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'}`}
          >
            <div className={`px-5 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>测试码验证</h2>
            </div>
            <div className="px-5 py-5">
              <p className={`text-sm leading-6 ${textSecondary}`}>请将获取到的测试码输入在下方</p>
              <div className="mt-4 flex items-stretch gap-3">
                <input
                  autoFocus
                  value={tvRedeemCode}
                  onChange={(event) => {
                    setTvRedeemCode(event.target.value)
                    if (tvRedeemState.message?.includes('失败')) setTvRedeemState({ status: 'idle', message: null })
                  }}
                  placeholder="WF1.……"
                  autoComplete="off"
                  spellCheck={false}
                  className={`min-w-0 flex-1 rounded-xl border ${borderColor} ${playerTheme === 'dark' ? 'bg-black/20' : 'bg-black/5'} ${textPrimary} px-4 py-3 font-mono text-sm outline-none focus:ring-2`}
                  style={{ '--tw-ring-color': accentColor } as React.CSSProperties}
                />
                <button
                  type="button"
                  onClick={() => void tvRedeem()}
                  disabled={tvRedeemState.status === 'redeeming'}
                  className={`shrink-0 rounded-xl px-5 py-3 font-semibold text-white transition-opacity disabled:opacity-60`}
                  style={{ backgroundColor: accentColor }}
                >
                  {tvRedeemState.status === 'redeeming' ? '兑换中…' : '兑换'}
                </button>
              </div>
              {tvRedeemState.message && (
                <p className={`mt-3 text-sm ${tvRedeemState.message.includes('成功') ? 'text-green-400' : 'text-red-400'}`}>
                  {tvRedeemState.message}
                </p>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* TV：本机识别码弹窗（TV 无剪贴板，弹窗展示供查看/抄录） */}
      {showTvDeviceId && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          data-tv-scope
          className="fixed inset-0 z-[9990] flex items-center justify-center p-6"
          style={{ background: playerTheme === 'dark' ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.45)', backdropFilter: 'blur(6px)' }}
          onClick={() => setShowTvDeviceId(false)}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm rounded-3xl border p-6 text-center shadow-2xl"
            style={{
              background: playerTheme === 'dark' ? 'rgba(14,17,24,0.95)' : 'rgba(255,255,255,0.98)',
              borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)',
            }}
          >
            <div className="w-12 h-12 mx-auto rounded-2xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
              <KeyRound className="w-6 h-6" />
            </div>
            <h3 className={`mt-3 text-lg font-bold ${playerTheme === 'dark' ? 'text-white' : 'text-black'}`}>本机识别码</h3>
            <p className={`mt-1 text-xs ${playerTheme === 'dark' ? 'text-white/50' : 'text-black/50'}`}>
              请记录此识别码，向开发者兑换隐藏功能
            </p>
            <div
              className="mt-4 rounded-2xl border px-4 py-4 font-mono text-sm break-all select-all"
              style={{
                borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)',
                background: playerTheme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                color: playerTheme === 'dark' ? '#e6edf3' : '#111',
              }}
            >
              {tvLicense.deviceId || '加载中…'}
            </div>
            <button
              data-tv-focus
              tabIndex={-1}
              onClick={() => setShowTvDeviceId(false)}
              className="mt-5 w-full rounded-xl px-5 py-3 text-white font-semibold"
              style={{ backgroundColor: accentColor }}
            >
              确认
            </button>
          </motion.div>
        </motion.div>
      )}

      {/* TV：遥控器可视化教学弹窗 */}
      {showRemoteGuide && (
        <RemoteControlGuideModal onClose={() => setShowRemoteGuide(false)} playerTheme={playerTheme} />
      )}

      {/* 设备识别码弹窗 */}
      {showDeviceIdModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowDeviceIdModal(false)}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.94, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className={`w-full max-w-md rounded-2xl border ${
              playerTheme === 'dark'
                ? 'bg-zinc-900 border-zinc-800'
                : 'bg-white border-gray-200'
            } shadow-2xl overflow-hidden`}
          >
            <div className={`flex items-center justify-between px-5 py-4 border-b ${
              playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'
            }`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>设备识别码</h2>
              <button
                onClick={() => setShowDeviceIdModal(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
                aria-label="关闭"
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            <div className="px-5 py-5">
              <p className={`text-sm leading-6 ${textSecondary}`}>您的设备识别码为：</p>
              <div className={`mt-3 rounded-xl border ${borderColor} ${
                playerTheme === 'dark' ? 'bg-black/20' : 'bg-black/5'
              } px-4 py-4`}>
                <p className={`font-mono text-sm leading-6 break-all select-all ${textPrimary}`}>
                  {deviceIdForModal}
                </p>
              </div>
              <p className={`mt-4 text-sm leading-6 ${textSecondary}`}>
                请您前往对应平台进行兑换或标记。
              </p>
              <button
                onClick={() => setShowDeviceIdModal(false)}
                className="mt-5 w-full rounded-xl px-4 py-3 text-white font-semibold transition-opacity hover:opacity-90"
                style={{ backgroundColor: accentColor }}
              >
                确定
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* 法律声明弹窗 */}
      {showVersionHistory && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={() => setShowVersionHistory(false)}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-3xl shadow-2xl relative"
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(30,30,45,0.96) 0%, rgba(20,20,30,0.98) 50%, rgba(12,12,20,0.98) 100%)', backdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
            </div>
            <div className="relative z-10 p-5 border-b flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div>
                <h3 className="text-base font-semibold text-white">版本历史</h3>
                <p className="text-white/55 text-xs mt-0.5">WaveForge 澜音工坊 各版本更新内容</p>
              </div>
              <button type="button" onClick={() => setShowVersionHistory(false)} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>
            <div className="relative z-10 max-h-[60vh] overflow-y-auto p-5 space-y-5">
              {VERSION_HISTORY.map((entry) => (
                <div key={entry.version} className="rounded-2xl p-4" style={entry.current ? { background: 'rgba(99,102,241,0.14)', border: '1px solid rgba(99,102,241,0.35)' } : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-semibold text-white">v{entry.version}</span>
                    <span className="text-xs text-white/40">{entry.date}</span>
                    {entry.current && <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full text-white" style={{ background: 'rgba(99,102,241,0.6)' }}>当前版本</span>}
                  </div>
                  <pre className="text-xs leading-relaxed whitespace-pre-wrap text-white/75 font-sans" style={{ margin: 0 }}>{entry.notes}</pre>
                </div>
              ))}
            </div>
            <div className="relative z-10 p-5 pt-0">
              <button type="button" onClick={() => setShowVersionHistory(false)} className="w-full py-2.5 px-4 rounded-xl font-medium text-white transition-colors hover:bg-white/10" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>关闭</button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {showLegalModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowLegalModal(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-4xl w-full max-h-[85vh] overflow-hidden flex flex-col`}
          >
            {/* 标题栏 */}
            <div className={`flex items-center justify-between gap-3 px-6 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-xl font-bold ${textPrimary}`}>法律声明与用户协议</h2>
              <div className="flex items-center gap-2">
                <LocaleSwitcher locale={legalLocale} onChange={setLegalLocale} theme={playerTheme} accentColor={accentColor} />
                <button
                  onClick={() => setShowLegalModal(false)}
                  className={`p-2 rounded-lg ${hoverBg} transition-colors`}
                >
                  <X className={`w-5 h-5 ${textSecondary}`} />
                </button>
              </div>
            </div>
            
            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-8">
              <LegalAgreement theme={playerTheme} locale={legalLocale} />
            </div>
          </motion.div>
        </motion.div>
      )}
      {/* 灰色歌曲跨平台补全：开启前免责声明弹窗 */}
      {showFallbackDisclaimer && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowFallbackDisclaimer(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-lg w-full overflow-hidden flex flex-col`}
          >
            {/* 标题栏 */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>灰色歌曲跨平台补全 · 免责声明</h2>
              <button
                onClick={() => setShowFallbackDisclaimer(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className={`space-y-4 ${textSecondary} text-sm leading-relaxed`}>
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>开启前请仔细阅读</h3>
                  <p>
                    "灰色歌曲跨平台补全"会在网易云音乐官方未返回播放链接时，从其他公开音乐源匹配并播放同一首歌。开启该功能即表示您已知悉并同意以下内容：
                  </p>
                </section>
                <ul className={`list-disc pl-5 space-y-1.5`}>
                  <li>本功能属于第三方客户端的跨平台音源匹配，未获得各音乐平台的授权，可能违反相关平台的服务条款（如网易云音乐《服务条款》第 8.5 条、QQ音乐《服务许可协议》第 5.1.1 条等），可能导致账号风控、功能受限或账号封禁；</li>
                  <li>匹配到的音源可能与原曲在版本、歌手、音质、歌词等方面存在差异，仅供个人非商业性试听，其版权归原权利人所有；</li>
                  <li>本功能仅补全免费但受版权或地区影响的歌曲，不会绕过 VIP、付费专辑等平台付费权限；</li>
                  <li>因使用本功能产生的账号风险与相关纠纷，均由您自行与相关平台解决，软件开发者不承担任何责任。</li>
                </ul>
                <div className={`rounded-lg p-3 text-xs ${playerTheme === 'dark' ? 'bg-zinc-800/50' : 'bg-gray-100'} ${textTertiary}`}>
                  请仔细阅读以上内容。确认开启后，本软件将在本地保存您的选择；您可随时在设置中关闭该功能。
                </div>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowFallbackDisclaimer(false)}
                className={`px-5 py-2.5 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} text-sm font-medium transition-colors`}
              >
                取消
              </button>
              <button
                onClick={confirmFallbackEnable}
                disabled={fallbackCountdown > 0}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${fallbackCountdown > 0 ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-0.5 hover:shadow-lg'}`}
                style={{ backgroundColor: accentColor, boxShadow: fallbackCountdown > 0 ? undefined : `0 10px 28px ${accentColor}24` }}
              >
                确定{fallbackCountdown > 0 ? `（${fallbackCountdown}）` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
      {/* 删除识别码与测试码：确认弹窗（10 秒倒计时） */}
      {showDeleteLicenseModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowDeleteLicenseModal(false)}
        >
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
            className={`${playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-lg w-full overflow-hidden flex flex-col`}
          >
            {/* 标题栏 */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <h2 className={`text-lg font-bold ${textPrimary}`}>删除识别码与测试码</h2>
              <button
                onClick={() => setShowDeleteLicenseModal(false)}
                className={`p-2 rounded-lg ${hoverBg} transition-colors`}
              >
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>

            {/* 内容区域 */}
            <div className="flex-1 overflow-y-auto px-6 py-5">
              <div className={`space-y-4 ${textSecondary} text-sm leading-relaxed`}>
                <section>
                  <h3 className={`text-base font-semibold ${textPrimary} mb-2`}>请仔细阅读以下说明</h3>
                  <p>点击"确定"后将执行以下操作，且<strong className={textPrimary}>不可撤销</strong>：</p>
                </section>
                <ul className={`list-disc pl-5 space-y-1.5`}>
                  <li>删除保存在您本机的<strong className={textPrimary}>设备识别码</strong>（Windows 注册表与应用数据目录中的记录）；</li>
                  <li>删除本机记录的全部<strong className={textPrimary}>已兑换测试码</strong>与授权记录（兑换机制数据一并清除）；</li>
                  <li>下次启动本软件时会生成<strong className={textPrimary}>全新的设备标识</strong>，此前获得的测试码因与旧设备绑定将<strong className={textPrimary}>全部失效</strong>；</li>
                  <li>如需恢复原授权，需要<strong className={textPrimary}>卸载并重新安装</strong>本软件后重新获取测试码。</li>
                </ul>
                <div className={`rounded-lg p-3 text-xs ${playerTheme === 'dark' ? 'bg-zinc-800/50' : 'bg-gray-100'} ${textTertiary}`}>
                  识别码与测试码均仅存储于您的本机，不包含任何个人身份信息，也不会被上传。若您仍希望移除，请确认后继续。
                </div>
              </div>
            </div>

            {/* 底部按钮 */}
            <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'}`}>
              <button
                onClick={() => setShowDeleteLicenseModal(false)}
                className={`px-5 py-2.5 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} text-sm font-medium transition-colors`}
              >
                取消
              </button>
              <button
                onClick={() => void confirmDeleteLicense()}
                disabled={deleteLicenseCountdown > 0}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${deleteLicenseCountdown > 0 ? 'opacity-50 cursor-not-allowed' : 'hover:-translate-y-0.5 hover:shadow-lg'}`}
                style={{ backgroundColor: '#ef4444', boxShadow: deleteLicenseCountdown > 0 ? undefined : '0 10px 28px rgba(239, 68, 68, 0.24)' }}
              >
                确定{deleteLicenseCountdown > 0 ? `（${deleteLicenseCountdown}）` : ''}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* DJTransGAN 模型下载确认弹窗（参考删除歌单弹窗样式） */}
      {showAiModelDownloadDialog && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={() => setShowAiModelDownloadDialog(false)}
        >
          <motion.div
            data-tv-scope
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl relative"
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)', backdropFilter: 'blur(80px) saturate(200%)', WebkitBackdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }} />
            </div>
            <div className="relative z-10 p-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'rgba(251,191,36,0.18)' }}>
                  <AlertTriangle className="w-5 h-5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">下载 DJTransGAN 模型</h3>
                  <p className="text-white/70 text-sm mt-1 leading-relaxed">
                    将自动下载并安装运行环境与模型（约 400MB，需要几分钟），安装完成后可直接使用 AI 混音。
                  </p>
                </div>
                <button type="button" onClick={() => setShowAiModelDownloadDialog(false)} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>
            <div className="relative z-10 flex gap-3 p-4">
              <button
                type="button"
                onClick={() => setShowAiModelDownloadDialog(false)}
                className="flex-1 py-2.5 px-4 text-white/80 rounded-xl transition-colors hover:bg-white/10"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleAiModelDownload}
                className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white transition-transform hover:scale-[1.02]"
                style={{ background: 'linear-gradient(135deg, #7c6cff, #5a4bd8)', boxShadow: '0 4px 16px rgba(124,108,255,0.4)' }}
              >
                确认下载
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      {/* DJTransGAN 模型删除确认弹窗 */}
      {showAiModelDeleteDialog && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={() => setShowAiModelDeleteDialog(false)}
        >
          <motion.div
            data-tv-scope
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-3xl shadow-2xl relative"
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)', backdropFilter: 'blur(80px) saturate(200%)', WebkitBackdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }} />
            </div>
            <div className="relative z-10 p-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'rgba(239,68,68,0.18)' }}>
                  <AlertTriangle className="w-5 h-5 text-red-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">删除 DJTransGAN 模型</h3>
                  <p className="text-white/60 text-sm mt-1">
                    确定要删除已下载的 DJTransGAN 模型吗？
                  </p>
                  <p className="text-white/40 text-xs mt-1.5">
                    删除后 AI 混音（60s 长混音）将不可用，需重新下载。此操作不可撤销。
                  </p>
                </div>
                <button type="button" onClick={() => setShowAiModelDeleteDialog(false)} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>
            <div className="relative z-10 flex gap-3 p-4">
              <button
                type="button"
                onClick={() => setShowAiModelDeleteDialog(false)}
                className="flex-1 py-2.5 px-4 text-white/80 rounded-xl transition-colors hover:bg-white/10"
                style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleAiModelDelete}
                className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white"
                style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 4px 16px rgba(239,68,68,0.4)' }}
              >
                删除
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// 常驻挂载（保活首页自定义/模糊度子弹窗链路），播放中 App 约 1Hz 重渲染时
// props 稳定则跳过整棵子树重渲染，保留内部全部 hooks 与状态。
export default memo(SettingsPanel)
