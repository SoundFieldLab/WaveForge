/**
 * 哔哩哔哩「看歌」播放表面（第 7 种歌词显示模式）
 *
 * 状态机：login → searching/loading → playing / confirm / none / error
 * - 未登录：整面登录门（登录后才允许看歌，避免低画质/试看/频繁弹登录）
 * - 自动匹配（findBestBilibiliMv，偏好感知）：高置信才自动播；低置信进候选确认（音频照常播）
 * - 播放失败自动回退：选中视频失效/受限（-404/-10403/大会员专享）→ 自动试下一候选，不卡错误页
 * - 「不喜欢」→ 该歌黑名单该 bvid，自动换下一个
 * - 视频自带声音与时间轴；B 站 CC 字幕（官方歌词/歌词翻译）渲染为时间同步字幕条
 * - 看歌设置：匹配偏好/自动门槛/视频结束行为/画质/字幕/关键词模板
 */

import { forwardRef, useImperativeHandle, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play, Pause, Volume2, VolumeX, ChevronLeft, ChevronRight,
  Search, X, Subtitles, CaptionsOff, ArrowLeft, RefreshCw, Eye, Clock, ListVideo, Music,
  Settings as SettingsIcon, ThumbsDown, RotateCcw, Home, ListMusic, Info, AudioLines, MessageCircle, MessageCircleOff, PlayCircle, Shuffle,
} from 'lucide-react'
import { useTvMode, useTvBack } from '../tv/tvCore'

/** B 站小电视图标（简化版 logo：圆角机身 + 顶部双鳍天线 + 屏幕） */
function BiliTvIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {/* 顶部双鳍天线 */}
      <path d="M8 5 L6.4 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 5 L17.6 2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {/* 圆角机身 */}
      <rect x="3.5" y="5" width="17" height="12.5" rx="2.2" stroke="currentColor" strokeWidth="1.6" />
      {/* 屏幕（内含播放三角） */}
      <rect x="6" y="7.5" width="12" height="7" rx="1.4" fill="currentColor" />
      <path d="M10.4 9.4v3.4l3-1.7-3-1.7z" fill="#FB7299" />
      {/* 底座 */}
      <rect x="9.5" y="18.2" width="5" height="1.6" rx="0.8" fill="currentColor" />
    </svg>
  )
}
import {
  findBestBilibiliMv,
  getBilibiliPlayUrl,
  getBilibiliView,
  getBilibiliSubtitles,
  getBilibiliSubtitleJson,
  getBilibiliDanmaku,
  getDanmakuSettings,
  saveDanmakuSettings,
  DANMAKU_SETTINGS_EVENT,
  searchBilibiliVideos,
  bilibiliStreamUrl,
  pickBestSubtitle,
  pickBestPage,
  songKeyOf,
  setBilibiliOverride,
  clearBilibiliOverride,
  getBilibiliOverride,
  getBilibiliBlacklist,
  addBilibiliBlacklist,
  formatBiliTime,
  qualityLabel,
  resolveBiliPic,
  isBilibiliLoggedIn,
  scoreCandidate,
  getBilibiliWatchSettings,
  saveBilibiliWatchSettings,
  getLocalMvMark,
  saveLocalMvMark,
  cleanSubtitleLines,
  WATCH_SETTINGS_EVENT,
  type DanmakuSettings,
  type BilibiliDanmakuItem,
  type MatchContext,
  type CandidateScore,
  type CandidateType,
  type BilibiliSubtitleLine,
  type BilibiliVideo,
  type BilibiliWatchSettings,
} from '../services/bilibiliApi'
import BilibiliLoginPanel from './BilibiliLoginPanel'
import BilibiliWatchSettingsModal from './BilibiliWatchSettingsModal'
import BilibiliProfileModal from './BilibiliProfileModal'
import BilibiliInteractPanel from './BilibiliInteractPanel'
import DanmakuLayer from './DanmakuLayer'
import { useColorThief } from '../hooks/useColorThief'
import { getEngineAdapter, getAvailableEngineIds, type IAudioEngineAdapter, type AudioGraphHandle } from '../services/audio-engine'
import { getAudioEngineVersion } from '../services/audioEngineVersion'
import { loadPlaybackShortcutSettings } from '../services/playbackShortcutSettings'
import { autoMixAnalysisService } from '../services/autoMixAnalysisService'

export interface BilibiliMvPlayerHandle {
  /** 返回 true 表示已接管播放/暂停（视频模式活动） */
  togglePlay: () => boolean
  /** 跳转视频进度（秒）——迷你播放器/桌面播放器控制视频用 */
  seekTo: (seconds: number) => void
  /** 设置视频音量（0-1）——迷你播放器/桌面播放器控制视频用 */
  setVolume: (value: number) => void
}

interface BilibiliMvPlayerProps {
  songTitle: string
  songArtist: string
  songArtists: string[]
  /** 歌曲时长（秒） */
  songDuration: number
  coverUrl: string
  platform?: string
  songId?: string | number
  playerTheme?: 'light' | 'dark'
  /** 全局音量（0-1，单一数据源）：与其它播放模式同步，改动经 onVideoStateChange 回写 */
  volume?: number
  onNext: () => void
  onPrevious: () => void
  /** 退回音频歌词模式 */
  onBackToAudio: () => void
  /** 视频是否正在占用播放（App 据此暂停/恢复音频引擎） */
  onVideoActiveChange?: (active: boolean) => void
  /** 搜索是否失败（App 据此显示兼容音频控件与右上角按钮组） */
  onSearchFailedChange?: (failed: boolean) => void
  /** 视频播放状态上报（播放/暂停/进度/时长/音量；迷你播放器与桌面小窗按视频进度显示） */
  onVideoStateChange?: (state: { playing: boolean; time: number; duration: number; volume: number }) => void
  /** 返回播放主页 */
  onHomeClick?: () => void
  /** 打开调音室（音效） */
  onOpenMixingStudio?: (anchorRect: { x: number; y: number; width: number; height: number }) => void
  /** 打开播放列表 */
  onOpenPlaylist?: () => void
  /** 点赞切换 */
  onToggleFavorite?: () => void
  liked?: boolean
  /** 即将播放的歌曲（预加载评分高的视频） */
  upcomingSongs?: Array<{ songTitle: string; songArtists: string[]; songDuration: number; platform?: string; id?: string | number }>
  /** 从歌词模式切来看歌时的续播位置（音频秒数；视频加载后 seek 到该处） */
  initialSeekSeconds?: number
  /** MV 背景已加载的视频流（复用避免重新缓冲；需与 initialBvid/initialCid 配合） */
  initialVideoUrl?: string
  initialCid?: number
  initialBvid?: string
  /** MV 背景已获取的播放接口 cacheKey：复用后跳过重新请求播放地址（音频/视频流同源生成） */
  initialCacheKey?: string
  /** 音频引擎当前位置读取器（秒）：视频加载完成后 seek 到引擎实时位置，消除加载期位置变陈旧导致的进度差 */
  getEnginePosition?: () => number
  /** 播放器是否为当前可见表面（回主页/被覆盖时禁用全局快捷键，避免误触发） */
  surfaceVisible?: boolean
}

type WatchStatus = 'login' | 'searching' | 'loading' | 'playing' | 'confirm' | 'none' | 'error'

const VOLUME_KEY = 'bilibiliVideoVolume'
const BILI_PINK = '#FB7299'

const TYPE_BADGES: Record<CandidateType, { label: string; color: string }> = {
  official: { label: '官方', color: '#FB7299' },
  live: { label: '现场', color: '#4C8DFF' },
  cover: { label: '翻唱', color: '#F5A623' },
  instrumental: { label: '演奏', color: '#8B7CF6' },
  lyrics: { label: '字幕', color: '#52C41A' },
  other: { label: '其他', color: '#8A8F99' },
}

function formatPlayCount(play: number): string {
  if (play >= 100000000) return `${(play / 100000000).toFixed(1)}亿`
  if (play >= 10000) return `${(play / 10000).toFixed(1)}万`
  return String(play || 0)
}

/** 平台显示名（qq 小写 → QQ） */
function platformDisplay(platform?: string): string {
  const p = String(platform || '').toLowerCase()
  if (p === 'qq') return 'QQ'
  if (p === 'netease') return '网易云'
  return platform || ''
}

const BilibiliMvPlayer = forwardRef<BilibiliMvPlayerHandle, BilibiliMvPlayerProps>(function BilibiliMvPlayer(
  {
    songTitle,
    songArtist,
    songArtists,
    songDuration,
    coverUrl,
    platform,
    songId,
    playerTheme = 'dark',
    volume: volumeProp = 0.7,
    onNext,
    onPrevious,
    onBackToAudio,
    onVideoActiveChange,
    onSearchFailedChange,
    onVideoStateChange,
    onHomeClick,
    onOpenMixingStudio,
    onOpenPlaylist,
    onToggleFavorite,
    liked = false,
    upcomingSongs,
    initialSeekSeconds,
    initialVideoUrl,
    initialCid,
    initialBvid,
    initialCacheKey,
    getEnginePosition,
    surfaceVisible = true,
  },
  ref,
) {
  const tvMode = useTvMode()

  // 看歌主题色：从当前歌曲封面提取主色调
  const { dominantColor } = useColorThief(coverUrl)
  const watchAccent = dominantColor || BILI_PINK

  const videoRef = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  /** 视频音效引擎：DASH 音频轨经统一音效 adapter（v1/v2/HSE 同 App 引擎）效果链输出 */
  const videoEffectsRef = useRef<{ ctx: AudioContext; adapter: IAudioEngineAdapter } | null>(null)
  /** 续播目标位置（音频秒数；加载新视频后 seek 一次即清除） */
  const initialSeekSecondsRef = useRef<number | null>(initialSeekSeconds ?? null)
  /** 引擎实时位置读取器：App 传的内联函数每次渲染都是新引用，经 ref 读取避免事件绑定 effect 反复重建 */
  const getEnginePositionRef = useRef(getEnginePosition)
  getEnginePositionRef.current = getEnginePosition
  /** MV 背景复用的视频流（bvid/cid/URL 匹配才复用，避免重新缓冲卡顿） */
  const initialVideoRef = useRef<{ bvid: string; cid: number; videoUrl: string; cacheKey?: string } | null>(
    initialVideoUrl && initialCid && initialBvid ? { bvid: initialBvid, cid: initialCid, videoUrl: initialVideoUrl, cacheKey: initialCacheKey } : null,
  )
  /** 无损切换画质：换流后视频/音频轨各自跳回原进度的目标（两者都消费完才清空） */
  const switchSeekRef = useRef<{ target: number; videoDone: boolean; audioDone: boolean } | null>(null)
  /** 新视频加载后音频轨淡入（从 0 到用户音量，配合引擎淡出做无缝拼接） */
  const fadeInOnLoadRef = useRef(false)
  /** 画质切换请求序号：多次快速点击时只认最后一次 */
  const qualitySwitchSeqRef = useRef(0)
  /** 双击静音恢复时的音量记忆 */
  const lastVolumeRef = useRef(0.8)
  /** 视频状态上报节流（播放中 timeupdate 最多每 1s 上报一次给 App） */
  const lastVideoStateReportRef = useRef(0)
  /** 音频轨音量渐变（等功率线性）：用于进入看歌淡入 / 切出淡出，避免双声爆音 */
  const fadeAudioVolume = (from: number, to: number, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const audio = audioRef.current
      if (!audio) return resolve()
      const startAt = performance.now()
      const step = () => {
        const t = Math.min(1, (performance.now() - startAt) / ms)
        audio.volume = from + (to - from) * t
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  const searchControllerRef = useRef<AbortController | null>(null)
  const controlsTimerRef = useRef<number | null>(null)
  /** 自动回退链（本次匹配的全部排序候选） */
  const fallbackChainRef = useRef<CandidateScore[]>([])
  /** 本次播放中已确认失败/被拉黑的 bvid，回退时跳过 */
  const failedBvidsRef = useRef<Set<string>>(new Set())

  const [settings, setSettings] = useState<BilibiliWatchSettings>(() => getBilibiliWatchSettings())
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const [loginReady, setLoginReady] = useState(() => isBilibiliLoggedIn())
  const [showBiliPanel, setShowBiliPanel] = useState(false)
  const showBiliPanelRef = useRef(false)
  showBiliPanelRef.current = showBiliPanel
  const [showLogin, setShowLogin] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showProfile, setShowProfile] = useState(false)

  const [status, setStatus] = useState<WatchStatus>('login')
  const [errorText, setErrorText] = useState('')
  const [candidates, setCandidates] = useState<CandidateScore[]>([])
  const [activeVideo, setActiveVideo] = useState<CandidateScore | null>(null)
  // 供 15 秒标记询问/切换视频判断的最新值
  const activeVideoRef = useRef<CandidateScore | null>(null)
  activeVideoRef.current = activeVideo

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const videoUrlRef = useRef<string | null>(null)
  videoUrlRef.current = videoUrl
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [quality, setQuality] = useState(0)
  const [playError, setPlayError] = useState('')

  // 字幕
  const [subtitles, setSubtitles] = useState<BilibiliSubtitleLine[]>([])
  const [subtitleOn, setSubtitleOn] = useState(false)
  const [currentSubtitle, setCurrentSubtitle] = useState('')
  // CC 字幕垂直位置（距底部 px，可拖拽 + 持久记忆）
  const [subtitlePos, setSubtitlePos] = useState<number>(() => {
    const saved = Number(localStorage.getItem('bilibili_subtitle_pos'))
    return Number.isFinite(saved) && saved >= 8 && saved <= 320 ? saved : 176
  })
  const subtitlePosRef = useRef(subtitlePos)
  subtitlePosRef.current = subtitlePos
  const subtitleDragRef = useRef<{ startY: number; startPos: number } | null>(null)
  const onSubtitlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    subtitleDragRef.current = { startY: e.clientY, startPos: subtitlePosRef.current }
  }
  const onSubtitlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!subtitleDragRef.current) return
    const next = Math.max(8, Math.min(320, subtitleDragRef.current.startPos - (e.clientY - subtitleDragRef.current.startY)))
    setSubtitlePos(next)
    subtitlePosRef.current = next
  }
  const onSubtitlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    subtitleDragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    try { localStorage.setItem('bilibili_subtitle_pos', String(subtitlePosRef.current)) } catch { /* 忽略 */ }
  }
  // 用户手动开关字幕的选择：非 null 时跨歌保持（加载新歌不再被默认值覆盖回开）
  const subtitleUserChoiceRef = useRef<boolean | null>(null)

  // 弹幕
  const [danmakuItems, setDanmakuItems] = useState<BilibiliDanmakuItem[]>([])
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(() => getDanmakuSettings())
  const [danmakuOn, setDanmakuOn] = useState(() => getDanmakuSettings().enabled)
  // 用户手动开关弹幕的选择：非 null 时跨歌保持（外部设置变化不再覆盖视频内手选）
  const danmakuUserChoiceRef = useRef<boolean | null>(null)

  // 快进/快退反馈（右上角动画指示）
  const [seekFeedback, setSeekFeedback] = useState<{ direction: 'forward' | 'backward'; seconds: number } | null>(null)
  const seekFeedbackTimerRef = useRef<number | null>(null)
  /** 键盘快进/快退调用的 seek（经 ref 避免每渲染重订阅监听器） */
  const handleSeekRef = useRef<(value: number) => void>(() => {})

  // 播放器控件
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(() => (
    Number.isFinite(volumeProp) && (volumeProp as number) >= 0 && (volumeProp as number) <= 1 ? (volumeProp as number) : 0.7
  ))
  // 全局音量（单一数据源）变化 → 同步本机音量（其它播放模式调整音量后看歌跟随）
  useEffect(() => {
    if (!Number.isFinite(volumeProp) || (volumeProp as number) < 0 || (volumeProp as number) > 1) return
    setVolume(volumeProp as number)
    setIsMuted(volumeProp === 0)
    const audio = audioRef.current
    if (audio) audio.volume = volumeProp as number
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volumeProp])
  const [videoTime, setVideoTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  // 底部控制条 / 左上角歌曲信息：联动自动隐藏（无操作 2 秒后隐藏，带动画）
  const [showControls, setShowControls] = useState(true)
  const [showTopInfo, setShowTopInfo] = useState(true)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const showVolumeSliderRef = useRef(false)
  showVolumeSliderRef.current = showVolumeSlider
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showReplay, setShowReplay] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerTypeFilter, setPickerTypeFilter] = useState<'all' | CandidateType>('all')
  const [manualKeyword, setManualKeyword] = useState('')
  const [manualSearching, setManualSearching] = useState(false)
  const [manualResults, setManualResults] = useState<CandidateScore[]>([])
  /** 手动搜索原始结果（不经评分/筛选，用户直接选择即播放） */
  const [manualRawResults, setManualRawResults] = useState<BilibiliVideo[]>([])
  /** 手动选择的视频正在播放（用于 15 秒后询问标记） */
  const [manualPlaybackMarkPrompt, setManualPlaybackMarkPrompt] = useState(false)
  const manualPlaybackMarkTimerRef = useRef<number | null>(null)
  /** 标记询问相关：当前歌 key */
  const manualMarkTargetRef = useRef<{ bvid: string; videoTitle: string; author: string; pic: string } | null>(null)
  const [showSongInfo, setShowSongInfo] = useState(false)
  // 画质
  const [acceptQuality, setAcceptQuality] = useState<number[]>([])
  const [showQualityMenu, setShowQualityMenu] = useState(false)
  // 本地 toast（换视频无候选 / 无字幕等提示）
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const volumeTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)

  const songKey = songKeyOf({ songTitle, artists: songArtists, songDuration, platform, id: songId })

  // ===== 工具 =====

  const clearControlsTimer = () => {
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = null
  }

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer()
    if (tvMode || !settingsRef.current.autoHideControls) return
    controlsTimerRef.current = window.setTimeout(() => {
      // 音量小药丸打开时不隐藏控件（避免小药丸被一起收走）；由再次点击音量按钮关闭
      if (videoRef.current && !videoRef.current.paused && !showVolumeSliderRef.current) {
        setShowControls(false)
        setShowTopInfo(false)
        // 底部栏隐藏时同时收回音量条/画质菜单，避免下次显示时残留
        setShowVolumeSlider(false)
        setShowQualityMenu(false)
      }
    }, 2000)
  }, [tvMode])

  /** 底部 / 左上角鼠标区域联动：只有悬停在底部栏位置才显示底部栏（连带左上信息）；
   *  只有悬停在左上角歌名处才单独显示左上信息；其余位置不弹控件，离开 2 秒后隐藏 */
  const handleContainerMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) return
    const y = e.clientY - rect.top
    const x = e.clientX - rect.left
    // 底部栏本体所在位置（含其上方弹出的画质菜单/音量小药丸）
    const inBottomBar = y > rect.height - 170
    const inPopupZone = (showQualityMenu || showVolumeSlider) && y > rect.height - 420
    const inBottom = inBottomBar || inPopupZone
    // 左上角歌名区域：只显示歌曲信息
    const inTopLeft = y < 130 && x < 320
    if (inBottom) {
      setShowTopInfo(true)
      setShowControls(true)
      // 悬停在底部栏/弹出菜单上时不安排自动隐藏：用户正在选择要点的按钮，
      // 鼠标移出底部区域（或离开容器）后才会走 scheduleControlsHide
    } else if (inTopLeft) {
      setShowTopInfo(true)
      setShowControls(false)
      scheduleControlsHide()
    } else {
      scheduleControlsHide()
    }
  }

  const showToast = useCallback((message: string) => {
    setToastMsg(message)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToastMsg(null), 2600)
  }, [])

  const reportVideoActive = useCallback(
    (active: boolean) => {
      onVideoActiveChange?.(active)
    },
    [onVideoActiveChange],
  )

  // ===== 视频加载（带自动回退链） =====

  const loadVideo = useCallback(
    (candidate: CandidateScore, chainIndex: number) => {
      const controller = new AbortController()
      searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      setStatus('loading')
      setPlayError('')
      setSubtitleOn(false)
      setSubtitles([])
      setCurrentSubtitle('')
      setShowReplay(false)
      setActiveVideo(candidate)
      setVideoUrl(null)
      setAudioUrl(null)
      // 新视频就绪后音频轨淡入（配合引擎淡出做无缝拼接）
      fadeInOnLoadRef.current = true
      // 切到新视频：取消 15 秒标记询问
      setManualPlaybackMarkPrompt(false)
      if (manualPlaybackMarkTimerRef.current !== null) {
        window.clearTimeout(manualPlaybackMarkTimerRef.current)
        manualPlaybackMarkTimerRef.current = null
      }

      void (async () => {
        try {
          let cid = candidate.cid || 0
          // MV 背景已加载同一视频 → 复用其视频流（cid 已知 + videoUrl 已缓冲），看歌免重新拉流卡顿
          let reuseVideoUrl: string | null = null
          let reuseCacheKey: string | null = null
          const initial = initialVideoRef.current
          if (initial && candidate.video.bvid === initial.bvid) {
            cid = initial.cid
            reuseVideoUrl = initial.videoUrl
            reuseCacheKey = initial.cacheKey || null
            initialVideoRef.current = null
          }
          if (!cid) {
            const view = await getBilibiliView(candidate.video.bvid, controller.signal)
            if (view.code !== 0) throw new Error(view.code === -404 ? '视频已失效或删除' : '获取视频信息失败')
            // 多 P（选集）视频：挑选最匹配歌曲的分 P（on vocal/歌名命中优先）
            if (Array.isArray(view.data.pages) && view.data.pages.length > 1) {
              const bestIndex = pickBestPage(view.data.pages, { songTitle, artists: songArtists })
              const chosen = view.data.pages[bestIndex]
              if (chosen?.cid) {
                cid = chosen.cid
                if (bestIndex > 0) console.log(`[看歌] 选集视频《${candidate.video.title}》选中第 ${bestIndex + 1} P（${chosen.part}）`)
              }
            }
            if (!cid) cid = view.data.cid
          }
          // 复用 MV 背景的 cacheKey：直接生成视频/音频流 URL，跳过播放地址请求（消除切换卡顿）
          let cacheKey: string
          if (reuseCacheKey) {
            cacheKey = reuseCacheKey
            const qn = settingsRef.current.targetQuality === 'auto' ? 127 : settingsRef.current.targetQuality
            setQuality(qn)
            setAcceptQuality([])
          } else {
            const qn = settingsRef.current.targetQuality === 'auto' ? 127 : settingsRef.current.targetQuality
            const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, qn, controller.signal)
            if (playInfo.code === -404) throw new Error('视频已失效或删除')
            if (playInfo.code !== 0 || !playInfo.cacheKey) throw new Error(playInfo.error || '获取播放地址失败')
            cacheKey = playInfo.cacheKey
            // 大会员专享画质：不报错，播放当前会话可用的最高画质（quality 已由服务端协商）
            setQuality(playInfo.quality)
            setAcceptQuality(Array.isArray(playInfo.acceptQuality) ? playInfo.acceptQuality : [])
          }
          setVideoUrl(reuseVideoUrl || bilibiliStreamUrl(cacheKey, 'video'))
          setAudioUrl(bilibiliStreamUrl(cacheKey, 'audio'))
          setStatus('playing')
          reportVideoActive(true)

          // 弹幕（非阻塞，失败不影响播放）；风控/瞬时失败重试一次
          setDanmakuItems([])
          const loadDanmaku = async (attempt = 0) => {
            if (controller.signal.aborted) return
            try {
              const dm = await getBilibiliDanmaku(cid, controller.signal)
              if (dm.code === 0) setDanmakuItems((dm.danmaku || []).slice().sort((a, b) => a.time - b.time))
              else if (attempt === 0) window.setTimeout(() => void loadDanmaku(1), 1500)
            } catch {
              if (attempt === 0) window.setTimeout(() => void loadDanmaku(1), 1500)
            }
          }
          void loadDanmaku()

          // 字幕（非阻塞，失败不影响播放）
          const subPref = settingsRef.current.subtitlePreference
          if (subPref !== 'off') {
            void (async () => {
              try {
                const subInfo = await getBilibiliSubtitles(candidate.video.bvid, cid, controller.signal)
                if (subInfo.code === 0 && subInfo.subtitles.length) {
                  const chosen = pickBestSubtitle(subInfo.subtitles, subPref)
                  if (chosen) {
                    const lines = await getBilibiliSubtitleJson(chosen.cacheKey, controller.signal)
                    // 清洗 AI 字幕噪音行（如整段只有"音乐"的分类标签），全噪音则视为无字幕
                    const clean = cleanSubtitleLines(lines)
                    if (clean.length) {
                      setSubtitles(clean)
                      // 已按用户偏好选出字幕（subPref !== 'off'）→ 默认开启；
                      // 用户手动开关过（subtitleUserChoiceRef 非 null）则跨歌保持其选择，不强制开
                      setSubtitleOn(subtitleUserChoiceRef.current ?? true)
                    }
                  }
                }
              } catch {
                // 字幕失败静默降级
              }
            })()
          }
        } catch (error) {
          if (controller.signal.aborted) return
          // 手动记住的视频若已无法播放（失效/受限），清除记忆避免每次切到这首歌都卡死
          if (getBilibiliOverride(songKey) === candidate.video.bvid) {
            clearBilibiliOverride(songKey)
          }
          // 自动回退：确凿失败（失效/受限）时尝试下一候选
          const message = error instanceof Error ? error.message : '视频加载失败'
          failedBvidsRef.current.add(candidate.video.bvid)
          const chain = fallbackChainRef.current
          const next = chain.find((c, i) => i > chainIndex && !failedBvidsRef.current.has(c.video.bvid))
          if (next) {
            const nextIndex = chain.indexOf(next)
            void loadVideo(next, nextIndex)
            return
          }
          setPlayError(message)
          setVideoUrl(null)
          setStatus('error')
          reportVideoActive(false)
        }
      })()
    },
    [reportVideoActive],
  )

  const searchSong = useCallback(
    async (forced = false) => {
      if (!loginReady) return
      const controller = new AbortController()
      searchControllerRef.current?.abort()
      searchControllerRef.current = controller
      setStatus('searching')
      setErrorText('')
      setCandidates([])
      setManualResults([])
      setShowPicker(false)
      setPickerTypeFilter('all')
      failedBvidsRef.current = new Set()
      fallbackChainRef.current = []
      reportVideoActive(false)

      const ctx: MatchContext = { songTitle, artists: songArtists, songDuration, platform, id: songId }
      try {
        const result = await findBestBilibiliMv(ctx, { signal: controller.signal, settings: settingsRef.current })
        if (controller.signal.aborted) return
        fallbackChainRef.current = result.fallbackChain || []
        setCandidates(result.candidates || [])
        if (result.status === 'auto' && result.best) {
          void loadVideo(result.best, Math.max(0, (result.fallbackChain || []).indexOf(result.best)))
        } else if (result.status === 'confirm') {
          setStatus('confirm')
        } else if (result.status === 'none') {
          setStatus('none')
        } else {
          setErrorText(result.error || '搜索失败')
          setStatus('error')
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setErrorText(error instanceof Error ? error.message : '搜索失败')
        setStatus('error')
      }
    },
    [loginReady, songTitle, songArtists, songDuration, platform, songId, loadVideo, reportVideoActive],
  )

  // 切歌 / 登录状态变化时重新搜索
  useEffect(() => {
    if (!loginReady) {
      setStatus('login')
      reportVideoActive(false)
      return
    }
    void searchSong(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, loginReady])

  // 预加载：为即将播放的歌曲提前匹配评分高的视频（findBestBilibiliMv 结果按歌缓存 24h，
  // 切到该歌时直接命中缓存秒播；不阻塞当前播放）
  useEffect(() => {
    if (!loginReady || !upcomingSongs?.length) return
    const preloadController = new AbortController()
    const ctxs = upcomingSongs.slice(0, 2)
    for (const upcoming of ctxs) {
      void findBestBilibiliMv(
        { songTitle: upcoming.songTitle, artists: upcoming.songArtists, songDuration: upcoming.songDuration, platform: upcoming.platform, id: upcoming.id },
        { signal: preloadController.signal, settings: settingsRef.current },
      ).catch(() => { /* 预加载失败静默 */ })
    }
    return () => preloadController.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey, loginReady, JSON.stringify(upcomingSongs || [])])

  // 其他入口（如设置面板）登录/登出后同步状态
  useEffect(() => {
    const onAuthChanged = () => {
      setLoginReady(isBilibiliLoggedIn())
    }
    window.addEventListener('bilibili-auth-changed', onAuthChanged as EventListener)
    return () => window.removeEventListener('bilibili-auth-changed', onAuthChanged as EventListener)
  }, [])

  // 看歌设置变化：刷新设置；已加载字幕时按新偏好重选
  useEffect(() => {
    const onSettingsChanged = (e: Event) => {
      setSettings(getBilibiliWatchSettings())
      const detail = (e as CustomEvent<BilibiliWatchSettings>).detail
      if (detail?.subtitlePreference === 'off') {
        setSubtitleOn(false)
      }
    }
    window.addEventListener(WATCH_SETTINGS_EVENT, onSettingsChanged as EventListener)
    return () => window.removeEventListener(WATCH_SETTINGS_EVENT, onSettingsChanged as EventListener)
  }, [])

  // 弹幕设置变化：刷新设置；视频内手动开关过弹幕时保持手选，不被外部设置覆盖
  useEffect(() => {
    const onDanmakuSettingsChanged = (e: Event) => {
      const detail = (e as CustomEvent<DanmakuSettings>).detail
      if (!detail) return
      setDanmakuSettings(detail)
      if (danmakuUserChoiceRef.current !== null) {
        setDanmakuOn(danmakuUserChoiceRef.current)
      } else {
        setDanmakuOn(detail.enabled)
      }
    }
    window.addEventListener(DANMAKU_SETTINGS_EVENT, onDanmakuSettingsChanged as EventListener)
    return () => window.removeEventListener(DANMAKU_SETTINGS_EVENT, onDanmakuSettingsChanged as EventListener)
  }, [])

  // 搜索失败上报：App 据此显示兼容音频控件与右上角按钮组（视频正常播放时隐藏）
  useEffect(() => {
    const failed = status === 'error' || status === 'none'
    onSearchFailedChange?.(failed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  // 卸载清理
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort()
      clearControlsTimer()
      if (volumeTimerRef.current !== null) window.clearTimeout(volumeTimerRef.current)
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
      reportVideoActive(false)
      // 销毁视频音效引擎（MediaElementAudioSourceNode 永久路由，仅随会话结束释放）
      const session = videoEffectsRef.current
      if (session) {
        videoEffectsRef.current = null
        try { session.adapter.dispose() } catch { /* 忽略 */ }
        try { void session.ctx.close() } catch { /* 忽略 */ }
      }
    }
  }, [reportVideoActive])

  // ===== 候选选择 / 自定义搜索 / 不喜欢 =====

  const switchToCandidate = useCallback(
    (candidate: CandidateScore) => {
      setBilibiliOverride(songKey, candidate.video.bvid)
      setShowPicker(false)
      void loadVideo(candidate, 0)
    },
    [songKey, loadVideo],
  )

  // ===== 手动搜索：原始结果直接播放 + 15 秒后询问标记 =====

  /** 播放手动搜索结果（不经评分；走完一次后询问是否标记为该歌 MV） */
  const playManualVideo = useCallback(
    (raw: BilibiliVideo) => {
      const candidate: CandidateScore = {
        video: raw,
        score: 0,
        signals: { officialMarker: false, mvMarker: false, negativeHit: false, hasArtist: false, nearDuration: false, hdMarker: false, uploaderMatchesArtist: false, ccSubtitle: false },
        rank: 0,
        officialVerifyType: -1,
        manualZhSubtitle: false,
        autoSubtitle: false,
        type: 'other',
      }
      // 回退链只用当前手动选择（"换一个视频/下一条"走手动结果列表）
      fallbackChainRef.current = [candidate]
      failedBvidsRef.current = new Set()
      manualMarkTargetRef.current = { bvid: raw.bvid, videoTitle: raw.title, author: raw.author, pic: raw.pic }
      setManualPlaybackMarkPrompt(false)
      if (manualPlaybackMarkTimerRef.current !== null) window.clearTimeout(manualPlaybackMarkTimerRef.current)
      void loadVideo(candidate, 0)
      // 15 秒后仍在此视频且未切换 → 询问标记（仅本地）
      manualPlaybackMarkTimerRef.current = window.setTimeout(() => {
        manualPlaybackMarkTimerRef.current = null
        if (activeVideoRef.current?.video.bvid === raw.bvid && videoUrlRef.current) {
          setManualPlaybackMarkPrompt(true)
        }
      }, 15000)
    },
    [loadVideo],
  )

  /** 确认标记：写入本地标记库（含 override，下次自动播） */
  const confirmManualMark = useCallback(() => {
    const target = manualMarkTargetRef.current
    if (!target) return
    saveLocalMvMark({
      songKey,
      songTitle,
      artist: songArtists.join('、'),
      bvid: target.bvid,
      videoTitle: target.videoTitle,
      pic: target.pic,
      author: target.author,
    })
    setManualPlaybackMarkPrompt(false)
    manualMarkTargetRef.current = null
    showToast('已标记为当前歌曲的 MV（可到设置→高级→看歌本地标记库 管理）')
  }, [songKey, songTitle, songArtists, showToast])

  const dismissManualMark = useCallback(() => {
    setManualPlaybackMarkPrompt(false)
    manualMarkTargetRef.current = null
  }, [])

  const dislikeCurrent = useCallback(() => {
    const current = activeVideo
    if (!current) return
    failedBvidsRef.current.add(current.video.bvid)
    // 手动搜索模式下："换一个视频"遍历手动结果列表（用户搜索的内容）
    if (manualRawResults.length > 0) {
      const nextRaw = manualRawResults.find((v) => !failedBvidsRef.current.has(v.bvid) && v.bvid !== current.video.bvid)
      if (nextRaw) {
        playManualVideo(nextRaw)
        return
      }
      showToast('手动搜索结果已播完')
      return
    }
    const chain = fallbackChainRef.current
    const next = chain.find((c) => !failedBvidsRef.current.has(c.video.bvid) && c.video.bvid !== current.video.bvid)
    if (next) {
      addBilibiliBlacklist(songKey, current.video.bvid)
      void loadVideo(next, chain.indexOf(next))
    } else {
      // 没有下一个评分视频：留在当前视频，弹提示
      showToast('当前歌曲暂无更多适配视频')
    }
  }, [activeVideo, songKey, loadVideo, showToast, manualRawResults, playManualVideo])

  /** 无损切换画质：不卸载播放表面（无"加载中"卡顿），仅替换视频/音频流并跳回原进度继续播 */
  const switchQuality = useCallback(
    async (qn: number) => {
      const current = activeVideo
      if (!current) return
      setShowQualityMenu(false)
      if (quality === qn) return
      const target = qn as BilibiliWatchSettings['targetQuality']
      saveBilibiliWatchSettings({ targetQuality: target })
      // 事件派发同步但 React 状态下次渲染才更新：立即同步 ref，保证重载读新画质
      settingsRef.current = { ...settingsRef.current, targetQuality: target }
      const seq = ++qualitySwitchSeqRef.current
      try {
        let cid = current.cid || 0
        if (!cid) {
          const view = await getBilibiliView(current.video.bvid)
          if (view.code === 0) cid = view.data.cid
        }
        if (!cid) throw new Error('获取视频信息失败')
        const qnValue = target === 'auto' ? 127 : target
        const playInfo = await getBilibiliPlayUrl(current.video.bvid, cid, qnValue)
        if (playInfo.code === -404) throw new Error('视频已失效或删除')
        if (playInfo.code !== 0 || !playInfo.cacheKey) throw new Error(playInfo.error || '获取播放地址失败')
        if (seq !== qualitySwitchSeqRef.current) return // 期间又有新的切换请求，作废本次
        // 记录当前进度，换流后视频/音频轨各自跳回
        switchSeekRef.current = { target: videoRef.current?.currentTime ?? 0, videoDone: false, audioDone: false }
        setQuality(playInfo.quality)
        setAcceptQuality(Array.isArray(playInfo.acceptQuality) ? playInfo.acceptQuality : [])
        setVideoUrl(bilibiliStreamUrl(playInfo.cacheKey, 'video'))
        setAudioUrl(bilibiliStreamUrl(playInfo.cacheKey, 'audio'))
      } catch (error) {
        showToast(error instanceof Error ? error.message : '切换画质失败')
      }
    },
    [activeVideo, quality, showToast],
  )

  /** 双击静音 / 双击恢复 */
  const toggleMute = () => {
    const next = !isMuted
    setIsMuted(next)
    const audio = audioRef.current
    if (!audio) return
    if (next) {
      lastVolumeRef.current = volume > 0 ? volume : 0.8
      audio.muted = true
      audio.volume = 0
    } else {
      audio.muted = false
      const v = lastVolumeRef.current
      setVolume(v)
      audio.volume = v
      try {
        localStorage.setItem(VOLUME_KEY, String(v))
      } catch {
        // 忽略
      }
    }
  }

  // 音量滑条（内联在底部控件栏内）：点击展开；鼠标离开音量区域约 1.5 秒后自动收回
  const volumeHoverRef = useRef(false)
  const volumeCloseTimerRef = useRef<number | null>(null)

  const toggleVolumeSlider = (e: React.MouseEvent) => {
    e.stopPropagation()
    const next = !showVolumeSlider
    setShowVolumeSlider(next)
    if (next) {
      volumeHoverRef.current = true
    } else {
      volumeHoverRef.current = false
      if (volumeCloseTimerRef.current !== null) window.clearTimeout(volumeCloseTimerRef.current)
      volumeCloseTimerRef.current = null
    }
  }

  const handleVolumeMouseEnter = () => {
    volumeHoverRef.current = true
    if (volumeCloseTimerRef.current !== null) window.clearTimeout(volumeCloseTimerRef.current)
    volumeCloseTimerRef.current = null
    clearControlsTimer()
  }

  const handleVolumeMouseLeave = () => {
    volumeHoverRef.current = false
    // 离开音量区域：1.5 秒后自动收回滑条
    if (volumeCloseTimerRef.current !== null) window.clearTimeout(volumeCloseTimerRef.current)
    volumeCloseTimerRef.current = window.setTimeout(() => {
      volumeCloseTimerRef.current = null
      setShowVolumeSlider(false)
    }, 1500)
  }

  const setVolumeFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = 1 - Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    handleVolumeChange(frac)
  }

  const handleVolumePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setVolumeFromPointer(e)
  }

  const handleVolumePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) setVolumeFromPointer(e)
  }

  const handleVolumePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  // 横向音量滑条（内联在底部控件栏内）：x 占比即音量
  const setVolumeFromPointerH = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    handleVolumeChange(frac)
  }
  const handleVolumePointerDownH = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setVolumeFromPointerH(e)
  }
  const handleVolumePointerMoveH = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons & 1) setVolumeFromPointerH(e)
  }
  const handleVolumePointerUpH = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  /** 字幕开关：开启时若当前无已加载字幕，按需拉取；没有可用的字幕则提示 */
  const toggleSubtitle = useCallback(async () => {
    const next = !subtitleOn
    subtitleUserChoiceRef.current = next
    setSubtitleOn(next)
    if (!next || subtitles.length || !activeVideo) {
      if (next && !activeVideo) {
        showToast('当前视频没有可用的字幕')
        setSubtitleOn(false)
      }
      return
    }
    const current = activeVideo
    try {
      let cid = current.cid || 0
      if (!cid) {
        const view = await getBilibiliView(current.video.bvid)
        if (view.code === 0) cid = view.data.cid
      }
      if (!cid) throw new Error('no cid')
      const pref = settingsRef.current.subtitlePreference === 'off' ? 'zh-any' : settingsRef.current.subtitlePreference
      const subInfo = await getBilibiliSubtitles(current.video.bvid, cid)
      if (subInfo.code === 0 && subInfo.subtitles.length) {
        const chosen = pickBestSubtitle(subInfo.subtitles, pref)
        if (chosen) {
          const lines = await getBilibiliSubtitleJson(chosen.cacheKey)
          // 与自动加载路径一致：过滤 AI 字幕噪音行（如"音乐"），全噪音视为无字幕
          const clean = cleanSubtitleLines(lines)
          if (clean.length) {
            setSubtitles(clean)
            return
          }
        }
      }
      showToast('当前视频没有可用的字幕')
      setSubtitleOn(false)
    } catch {
      showToast('当前视频没有可用的字幕')
      setSubtitleOn(false)
    }
  }, [subtitleOn, subtitles.length, activeVideo, showToast])

  const runManualSearch = useCallback(async () => {
    const keyword = manualKeyword.trim()
    if (!keyword || manualSearching) return
    const controller = new AbortController()
    setManualSearching(true)
    try {
      // 手动搜索：直接展示用户输入去 B 站搜的结果，不受评分/筛选管辖
      const r = await searchBilibiliVideos(keyword, 1, controller.signal)
      const results = (r.results || []).map((v) => ({
        bvid: v.bvid,
        title: v.title,
        author: v.author,
        play: v.play,
        duration: v.duration,
        pic: v.pic,
        typename: v.typename,
      }))
      setManualRawResults(results)
      setManualResults([])
      setShowPicker(false)
    } catch {
      setManualRawResults([])
    } finally {
      setManualSearching(false)
    }
  }, [manualKeyword, manualSearching])

  // ===== 视频元素事件 =====

  const handleTogglePlay = useCallback((): boolean => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !videoUrl) return false
    // 播放手势：恢复音效 AudioContext（自动播放策略兜底）
    const effects = videoEffectsRef.current
    if (effects?.ctx.state === 'suspended') void effects.ctx.resume().catch(() => undefined)
    if (video.paused) {
      void video.play().catch(() => undefined)
      void audio?.play().catch(() => undefined)
    } else {
      video.pause()
      audio?.pause()
    }
    return true
  }, [videoUrl])

  /** 上报当前视频播放状态（迷你播放器/桌面小窗按视频进度显示） */
  const reportVideoState = useCallback(() => {
    const video = videoRef.current
    const audio = audioRef.current
    onVideoStateChange?.({
      playing: Boolean(video && !video.paused && !video.ended),
      time: video?.currentTime || 0,
      duration: (video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : videoDuration) || 0,
      volume: audio ? audio.volume : volume,
    })
  }, [onVideoStateChange, videoDuration, volume])

  /** 跳转视频进度（秒）——迷你播放器/桌面播放器控制视频用 */
  const handleSeekTo = useCallback((seconds: number) => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video || !Number.isFinite(seconds)) return
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
    const t = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.5)))
    video.currentTime = t
    if (audio) audio.currentTime = t
    setVideoTime(t)
    reportVideoState()
  }, [reportVideoState])

  /** 设置视频音量（0-1）——迷你播放器/桌面播放器控制视频用 */
  const handleSetVolume = useCallback((value: number) => {
    handleVolumeChange(Math.max(0, Math.min(1, value)))
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      togglePlay: handleTogglePlay,
      seekTo: handleSeekTo,
      setVolume: handleSetVolume,
      /** 当前播放精确位置（秒）：优先取 DASH 音频轨（用户实际听到的时钟），视频轨 drift 校正前可能与音频差一点 */
      getCurrentTime: () => audioRef.current?.currentTime ?? videoRef.current?.currentTime ?? 0,
      /** 音频轨淡出（切回歌词模式时用，返回 Promise 完成时音量已为 0） */
      fadeOutAudio: () => fadeAudioVolume(audioRef.current?.volume ?? 0, 0, 200),
    }),
    [handleTogglePlay, handleSeekTo, handleSetVolume],
  )

  const handleVolumeChange = (value: number) => {
    const audio = audioRef.current
    setVolume(value)
    setIsMuted(value === 0)
    if (audio) audio.volume = value
    try {
      localStorage.setItem(VOLUME_KEY, String(value))
    } catch {
      // 忽略
    }
    reportVideoState()
  }

  const handleSeek = (value: number) => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    video.currentTime = value
    if (audio) audio.currentTime = value
    setVideoTime(value)
  }
  handleSeekRef.current = handleSeek

  // 方向键快进/快退（跟随"播放页快捷键"设置；右上角动画指示）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      if (!surfaceVisible) return
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const target = e.target instanceof HTMLElement ? e.target : null
      const isEditable = Boolean(target?.closest('input, textarea, select, button, [contenteditable="true"]'))
      if (isEditable) return
      if (!videoRef.current || !videoUrl) return
      const settings = loadPlaybackShortcutSettings()
      if (!settings.playbackPageEnabled) return
      e.preventDefault()
      const direction = e.key === 'ArrowRight' ? 'forward' : 'backward'
      const step = direction === 'forward' ? settings.seekForwardSeconds : settings.seekBackwardSeconds
      const video = videoRef.current
      const targetTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + (direction === 'forward' ? step : -step)))
      handleSeekRef.current(targetTime)
      setSeekFeedback({ direction, seconds: step })
      if (seekFeedbackTimerRef.current !== null) window.clearTimeout(seekFeedbackTimerRef.current)
      seekFeedbackTimerRef.current = window.setTimeout(() => setSeekFeedback(null), 900)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, surfaceVisible])

  const replayVideo = useCallback(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    video.currentTime = 0
    if (audio) audio.currentTime = 0
    void video.play().catch(() => undefined)
    void audio?.play().catch(() => undefined)
    setShowReplay(false)
  }, [])

  const handleVideoEnded = useCallback(() => {
    setIsPlaying(false)
    setShowControls(true)
    setShowTopInfo(true)
    const behavior = settingsRef.current.videoEndBehavior
    // 歌曲放完按设置正常切下一曲（B 站功能弹窗开着也切，保持弹幕/评论跟随当前视频）
    if (behavior === 'next') {
      reportVideoActive(false)
      onNext()
    } else if (behavior === 'replay') {
      replayVideo()
    } else {
      // hold：停在末帧，显示重播按钮
      setShowReplay(true)
    }
    reportVideoState()
  }, [onNext, reportVideoActive, replayVideo, reportVideoState])

  // 视频事件绑定
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    const onPlay = () => {
      setIsPlaying(true)
      setShowReplay(false)
      setShowControls(true)
      setShowTopInfo(true)
      // 播放中恢复音效 AudioContext（防止 suspended 导致静音）
      const effects = videoEffectsRef.current
      if (effects?.ctx.state === 'suspended') void effects.ctx.resume().catch(() => undefined)
      // 同步音频轨（DASH 音画分离）
      if (audio && audio.paused && audio.currentSrc) void audio.play().catch(() => undefined)
      reportVideoState()
      scheduleControlsHide()
    }
    const onPause = () => {
      setIsPlaying(false)
      setShowControls(true)
      setShowTopInfo(true)
      clearControlsTimer()
      if (audio) audio.pause()
      reportVideoState()
    }
    const onTimeUpdate = () => {
      setVideoTime(video.currentTime)
      if (subtitles.length && subtitleOn) {
        const t = video.currentTime
        let line = ''
        for (const s of subtitles) {
          if (t >= s.from && t < s.to) {
            line = s.content
            break
          }
        }
        setCurrentSubtitle(line)
      }
      // 播放中进度上报节流（1s 一次，供迷你播放器/桌面小窗显示视频进度）
      const now = Date.now()
      if (now - lastVideoStateReportRef.current >= 1000) {
        lastVideoStateReportRef.current = now
        reportVideoState()
      }
    }
    const onLoadedMetadata = () => {
      setVideoDuration(video.duration || 0)
      // 无损切换画质：视频轨就绪后跳回原进度并继续播放
      const s = switchSeekRef.current
      if (s && !s.videoDone) {
        s.videoDone = true
        const clamped = Math.min(s.target, Math.max(0, (video.duration || 0) - 8))
        if (clamped > 0) video.currentTime = clamped
        void video.play().catch(() => undefined)
        if (audio && audio.paused && audio.currentSrc) void audio.play().catch(() => undefined)
        if (s.audioDone) switchSeekRef.current = null
      }
      // 从歌词模式切来看歌：续播到音频刚才的位置（按视频时长钳制，保留结尾内容）。
      // 用引擎的实时位置而非挂载时捕获的旧位置：加载期间引擎仍在播放（静音淡出），
      // 捕获值会落后加载耗时，导致"进度差"。引擎已暂停时读取冻结位置同样正确。
      const seekTarget = initialSeekSecondsRef.current
      if (seekTarget != null && seekTarget > 0 && Number.isFinite(video.duration)) {
        const livePos = getEnginePositionRef.current ? Number(getEnginePositionRef.current()) || 0 : 0
        const target = Math.max(seekTarget, livePos > 0 ? livePos : seekTarget)
        const clamped = Math.min(target, Math.max(0, (video.duration || 0) - 8))
        if (clamped > 0) {
          video.currentTime = clamped
          if (audio) audio.currentTime = clamped
        }
        initialSeekSecondsRef.current = null
      }
      reportVideoState()
    }
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('ended', handleVideoEnded)
    video.addEventListener('error', () => {
      setPlayError('视频播放失败（可能已失效或网络异常）')
      setStatus('error')
      reportVideoActive(false)
    })
    const onAudioEnded = () => {
      // 音频先结束：跟随视频状态（视频 ended 触发 handleVideoEnded）
      if (video.ended) return
      if (Math.abs((video.duration || 0) - (audio?.currentTime || 0)) < 0.8) {
        handleVideoEnded()
      }
    }
    const onAudioLoaded = () => {
      // 无损切换画质：音频轨就绪后跳回原进度
      const s = switchSeekRef.current
      if (s && !s.audioDone) {
        s.audioDone = true
        if (audio && Number.isFinite(audio.duration)) {
          const clamped = Math.min(s.target, Math.max(0, (audio.duration || 0) - 8))
          if (clamped > 0) audio.currentTime = clamped
        }
        if (s.videoDone) switchSeekRef.current = null
      }
      // 音频轨就绪后同步续播位置（视频可能更早触发 loadedmetadata）
      const seekTarget = initialSeekSecondsRef.current
      if (seekTarget != null && seekTarget > 0 && audio && Number.isFinite(audio.duration)) {
        const clamped = Math.min(seekTarget, Math.max(0, (audio.duration || 0) - 8))
        if (clamped > 0) audio.currentTime = clamped
      }
      // 新视频音频轨淡入（进入看歌时配合引擎淡出无缝拼接）
      if (fadeInOnLoadRef.current && audio) {
        fadeInOnLoadRef.current = false
        audio.volume = 0
        void audio.play().catch(() => undefined)
        void fadeAudioVolume(0, volume, 250)
      }
    }
    audio?.addEventListener('ended', onAudioEnded)
    audio?.addEventListener('loadedmetadata', onAudioLoaded)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('ended', handleVideoEnded)
      audio?.removeEventListener('ended', onAudioEnded)
      audio?.removeEventListener('loadedmetadata', onAudioLoaded)
    }
    // videoUrl 必须入依赖：换源/回退/切歌后视频元素可能重建，需重新绑定事件（否则新元素无 play 处理器 → 音频轨不会启动）
  }, [subtitles, subtitleOn, videoUrl, handleVideoEnded, reportVideoActive, reportVideoState, scheduleControlsHide])

  // 漂移校正：DASH 音画分离的两条流因 fMP4 分段对齐会渐进失步（视频与音频越走越远）。
  // 每 4s 检查一次：偏差 >0.45s 时把视频拉回音频位置（音频是用户听到的时钟，视频跟随）。
  // 若本曲已有 beat_this/librosa 节拍分析缓存（automix 分析过），校正点吸附到"下一个节拍"再跳，
  // 跳变更具音乐性；无节拍数据时立即按音频位置校正。
  const watchTrackKey = `${platform || 'netease'}-${songId ?? ''}`
  useEffect(() => {
    if (!videoUrl || !audioUrl || !isPlaying) return
    let beatTimer: number | null = null
    const interval = window.setInterval(() => {
      const video = videoRef.current
      const audio = audioRef.current
      if (!video || !audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return
      if (video.seeking) return
      const drift = video.currentTime - audio.currentTime
      if (Math.abs(drift) <= 0.45) return
      const applySeek = (target: number) => {
        const v = videoRef.current
        if (!v) return
        v.currentTime = Math.max(0, Math.min(target, (v.duration || target) - 0.5))
      }
      // beat_this 节拍吸附：等音频走到下一个节拍时校正到该节拍时间
      const beats = autoMixAnalysisService.getCachedBeats(watchTrackKey, '', songDuration)
      if (beats && beats.length > 0) {
        const nextBeat = beats.find((b) => b > audio.currentTime + 0.15)
        if (nextBeat != null && nextBeat > audio.currentTime) {
          if (beatTimer !== null) window.clearTimeout(beatTimer)
          beatTimer = window.setTimeout(() => {
            const v = videoRef.current
            const a = audioRef.current
            if (!v || !a) return
            // 到节拍时偏差仍大 → 按当前音频位置直接校正（节拍目标已过期）
            applySeek(Math.abs(v.currentTime - a.currentTime) > 1.2 ? a.currentTime : nextBeat)
          }, Math.max(0, (nextBeat - audio.currentTime) * 1000))
          return
        }
      }
      applySeek(audio.currentTime)
    }, 4000)
    return () => {
      window.clearInterval(interval)
      if (beatTimer !== null) window.clearTimeout(beatTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl, audioUrl, isPlaying, watchTrackKey, songDuration])

  // 音量/静音应用到新视频（新视频就绪后会淡入，先置 0 避免瞬间满音量）
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    video.muted = true // DASH 视频轨无声音
    if (audio) {
      audio.volume = fadeInOnLoadRef.current ? 0 : volume
      audio.muted = isMuted
    }
  }, [videoUrl, audioUrl, volume, isMuted])

  // 视频音效：DASH 音频轨接入调音室同款效果链（读同一份设置，实时同步）
  // 仅当设置了任一音效/均衡器时才建立 Web Audio 路由——默认无音效时音频轨直出，
  // 避免 AudioContext（自动播放策略下 suspended）把音频静音。
  useEffect(() => {
    if (!audioUrl) return
    const audio = audioRef.current
    if (!audio) return
    // 读取当前效果设置，判断是否有启用中的音效
    let hasEnabledEffect = false
    try {
      const raw = localStorage.getItem('waveforge:audio-effects-settings')
      if (raw) {
        const parsed = JSON.parse(raw)
        const fx = parsed?.effects || {}
        hasEnabledEffect = Boolean(
          fx?.hall?.enabled || fx?.surround3d?.enabled || fx?.bassBoost?.enabled ||
          fx?.vocalBoost?.enabled || fx?.accompanimentBoost?.enabled || fx?.compressor?.enabled ||
          fx?.nightMode?.enabled || fx?.loudnessCompensation?.enabled || parsed?.eq?.enabled ||
          parsed?.normalizationEnabled,
        )
      }
    } catch { /* 忽略 */ }
    if (!hasEnabledEffect) return // 无音效：音频轨直出（不创建 MediaElementAudioSourceNode，避免永久路由导致静音）
    // 与 App 同款：按配置的引擎版本（v1/v2/HSE）走统一 adapter
    let session = videoEffectsRef.current
    if (!session) {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
        const ctx: AudioContext = new AudioCtx()
        const masterGain = ctx.createGain()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        analyser.connect(ctx.destination)
        ctx.createMediaElementSource(audio).connect(masterGain)
        const adapter = getEngineAdapter(getAudioEngineVersion(getAvailableEngineIds()))
        const handle: AudioGraphHandle = { audioContext: ctx, masterGain, analyser }
        void adapter.attach(handle).catch(() => { /* 通路不可用：保持直连 */ })
        // 自动播放策略下 AudioContext 默认 suspended：立即请求恢复，播放手势再兜底
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
        session = { ctx, adapter }
        videoEffectsRef.current = session
      } catch (error) {
        console.warn('[看歌] 视频音效引擎初始化失败:', error)
        return
      }
    }
    // 实时同步设置：v2 引擎暴露 updateSettings；v1/v3 在下次 attach（切歌）时读取最新存储生效
    const onEffectsChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const current = videoEffectsRef.current
      if (!detail || !current) return
      const engine = (current.adapter as unknown as { engine?: { updateSettings?: (s: unknown) => void } }).engine
      if (typeof engine?.updateSettings === 'function') engine.updateSettings(detail)
      if (current.ctx.state === 'suspended') void current.ctx.resume().catch(() => undefined)
    }
    window.addEventListener('waveforge:audio-effects-changed', onEffectsChanged as EventListener)
    return () => window.removeEventListener('waveforge:audio-effects-changed', onEffectsChanged as EventListener)
  }, [audioUrl])

  // 全屏状态监听
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // TV 遥控器 BACK：登录面板 → 设置 → 个人主页 → 候选列表 → 返回音频（仅播放器为可见表面时接管）
  useTvBack(() => {
    if (!surfaceVisible) return false
    if (showLogin) setShowLogin(false)
    else if (showSettings) setShowSettings(false)
    else if (showProfile) setShowProfile(false)
    else if (showPicker) setShowPicker(false)
    else onBackToAudio()
    return true
  })

  // ESC 键盘
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!surfaceVisible) return // 被主页覆盖时不接管，避免误退出看歌
      if (showLogin) setShowLogin(false)
      else if (showSettings) setShowSettings(false)
      else if (showProfile) setShowProfile(false)
      else if (showPicker) setShowPicker(false)
      else if (isFullscreen) return
      else onBackToAudio()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showLogin, showSettings, showProfile, showPicker, isFullscreen, onBackToAudio, surfaceVisible])

  // 空格键播放/暂停（跟随"播放页快捷键"设置；看歌模式下全局 PlayerControls 不渲染，需自行监听）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      if (!surfaceVisible) return // 被主页覆盖时不接管空格
      const settings = loadPlaybackShortcutSettings()
      if (!settings.playbackPageEnabled || !settings.spacePlayPauseEnabled) return
      if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const target = e.target instanceof HTMLElement ? e.target : null
      const isEditable = Boolean(target?.closest('input, textarea, select, button, [contenteditable="true"]'))
      if (isEditable) return
      if (!videoRef.current || !videoUrl) return // 仅视频就绪时接管
      e.preventDefault()
      handleTogglePlay()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleTogglePlay, videoUrl, surfaceVisible])

  const dark = playerTheme === 'dark'

  /** 当前会话可用的画质档位（降序；取自 playurl 返回的 acceptQuality） */
  const qualityOptions = useMemo(() => {
    const list = acceptQuality.length ? acceptQuality : quality > 0 ? [quality] : []
    return Array.from(new Set(list)).sort((a, b) => b - a)
  }, [acceptQuality, quality])

  // ===== 候选列表（登录门/确认态/更换视频共用，带类型徽章） =====
  const renderCandidateList = (list: CandidateScore[], emptyText: string) => (
    <div className="w-full max-w-3xl flex flex-col gap-2">
      {list.length === 0 ? (
        <div className={`text-center text-sm py-6 ${dark ? 'text-white/50' : 'text-black/50'}`}>{emptyText}</div>
      ) : (
        list.map((c) => {
          const badge = TYPE_BADGES[c.type] || TYPE_BADGES.other
          return (
            <button
              key={c.video.bvid}
              type="button"
              onClick={() => switchToCandidate(c)}
              className={`group flex items-center gap-3 rounded-xl p-2 text-left transition-colors ${
                dark ? 'hover:bg-white/10 bg-white/[0.04]' : 'hover:bg-black/5 bg-black/[0.03]'
              }`}
            >
              <img
                src={resolveBiliPic(c.video.pic)}
                alt=""
                referrerPolicy="no-referrer"
                className="w-20 h-12 object-cover rounded-lg flex-shrink-0 bg-white/10"
                loading="lazy"
                onError={(e) => {
                  const el = e.currentTarget
                  el.onerror = null
                  el.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" rx="4" fill="rgba(255,255,255,0.08)"/%3E%3Cpath d="M9 18V5l12-2v13" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/%3E%3Ccircle cx="6" cy="18" r="3" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/%3E%3Ccircle cx="18" cy="16" r="3" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/%3E%3C/svg%3E'
                }}
              />
              <div className="flex-1 min-w-0">
                <p className={`truncate text-sm font-medium ${dark ? 'text-white/90' : 'text-black/85'}`}>{c.video.title}</p>
                <p className={`mt-0.5 flex items-center gap-3 text-xs ${dark ? 'text-white/45' : 'text-black/45'}`}>
                  <span className="flex items-center gap-1"><Eye size={12} />{formatPlayCount(c.video.play)}</span>
                  <span className="flex items-center gap-1"><Clock size={12} />{formatBiliTime(c.video.duration)}</span>
                  <span className="truncate">{c.video.author}</span>
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white" style={{ backgroundColor: badge.color }}>
                  {badge.label}
                </span>
                {c.officialVerifyType === 2 && (
                  <span className="px-2 py-0.5 rounded-full text-[10px] bg-white/10 text-white/60">认证</span>
                )}
              </div>
            </button>
          )
        })
      )}
    </div>
  )

  const renderTypeFilter = () => (
    <div className="flex items-center gap-1.5 flex-wrap">
      {(['all', 'official', 'live', 'cover', 'instrumental', 'lyrics', 'other'] as const).map((t) => {
        const active = pickerTypeFilter === t
        const badge = t === 'all' ? { label: '全部', color: '#8A8F99' } : TYPE_BADGES[t]
        return (
          <button
            key={t}
            type="button"
            onClick={() => setPickerTypeFilter(t)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors border ${
              active ? 'text-white border-transparent' : dark ? 'bg-white/[0.06] border-white/10 text-white/55 hover:bg-white/[0.12]' : 'bg-black/[0.04] border-black/10 text-black/50 hover:bg-black/[0.08]'
            }`}
            style={active ? { backgroundColor: badge.color } : undefined}
          >
            {badge.label}
          </button>
        )
      })}
    </div>
  )

  const renderManualSearch = () => (
    <div className="w-full max-w-3xl flex flex-col gap-3">
      <div className="flex items-center gap-2 w-full">
        <input
          value={manualKeyword}
          onChange={(e) => setManualKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void runManualSearch()}
          placeholder={`搜索其他视频（如：${songTitle} MV）`}
          className={`flex-1 rounded-xl px-4 py-2 text-sm outline-none border ${
            dark
              ? 'bg-white/10 border-white/15 text-white placeholder-white/35 focus:border-white/40'
              : 'bg-black/5 border-black/10 text-black placeholder-black/30 focus:border-black/30'
          }`}
        />
        <button
          type="button"
          onClick={() => void runManualSearch()}
          disabled={manualSearching}
          className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white transition-opacity disabled:opacity-50"
          style={{ backgroundColor: BILI_PINK }}
        >
          {manualSearching ? <RefreshCw size={14} className="animate-spin" /> : <Search size={14} />}
          搜索
        </button>
      </div>
      {/* 手动搜索结果：原始 B 站结果（不经评分/筛选），点选即播放 */}
      {manualRawResults.length > 0 && (
        <div className={`max-h-80 overflow-y-auto rounded-xl border p-2 flex flex-col gap-1.5 ${dark ? 'border-white/10 bg-black/40' : 'border-black/10 bg-white/60'}`}>
          <p className={`px-1 text-xs ${dark ? 'text-white/40' : 'text-black/40'}`}>搜索结果（点选直接作为当前歌曲 MV 播放）：</p>
          {manualRawResults.map((v) => (
            <button
              key={v.bvid}
              type="button"
              onClick={() => playManualVideo(v)}
              className={`group flex items-center gap-3 rounded-lg p-2 text-left transition-colors w-full ${dark ? 'bg-white/[0.05] hover:opacity-85' : 'bg-black/[0.03] hover:opacity-85'}`}
            >
              <div className="relative w-20 h-12 rounded-lg overflow-hidden bg-white/10 flex-shrink-0">
                {v.pic ? (
                  <img src={resolveBiliPic(v.pic)} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                ) : null}
                <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 py-0.5 text-[9px] text-white">{formatBiliTime(v.duration)}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`truncate text-xs font-medium ${dark ? 'text-white' : 'text-black/90'}`}>{v.title}</p>
                <p className={`truncate text-[11px] mt-0.5 ${dark ? 'text-white/40' : 'text-black/40'}`}>{v.author} · {formatPlayCount(v.play)} 播放</p>
              </div>
              <PlayCircle size={18} className={`${dark ? 'text-white/40' : 'text-black/40'} opacity-0 group-hover:opacity-100`} />
            </button>
          ))}
        </div>
      )}
    </div>
  )

  // ===== 主渲染 =====
  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      data-tv-scope
      onMouseMove={handleContainerMouseMove}
      onMouseLeave={scheduleControlsHide}
    >
      {/* 模糊封面背景 */}
      {coverUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center scale-110"
          style={{ backgroundImage: `url(${coverUrl})`, filter: 'blur(40px) brightness(0.35)' }}
        />
      )}
      <div className="absolute inset-0 bg-black/50" />

      {/* 登录门：未登录完全不可用 */}
      {!loginReady ? (
        <div className="relative z-10 h-full flex flex-col items-center justify-center gap-6 px-8">
          <div className="p-4 rounded-2xl" style={{ backgroundColor: BILI_PINK }}>
            <svg className="w-10 h-10 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.765-1.56 3.761-1.004.996-2.263 1.52-3.773 1.574h-.854c-1.51-.054-2.769-.578-3.773-1.574-.996-.996-1.51-2.251-1.542-3.76v-1.804h-4.996v1.804c-.032 1.509-.546 2.764-1.542 3.76-1.004.996-2.263 1.52-3.773 1.574h-.854C1.75 20.554.491 20.03-.513 19.034c-1.004-.996-1.524-2.251-1.56-3.76v-7.36c.036-1.511.556-2.765 1.56-3.761C.49 2.157 1.75 1.633 3.26 1.58h.854c1.51.054 2.769.578 3.773 1.574.996.996 1.51 2.251 1.542 3.76v1.804h4.996V6.914c.032-1.509.546-2.764 1.542-3.76 1.004-.996 2.263-1.52 3.773-1.574z" />
            </svg>
          </div>
          <div className="text-center">
            <h2 className={`text-2xl font-bold mb-2 ${dark ? 'text-white' : 'text-black/90'}`}>看歌需要登录哔哩哔哩</h2>
            <p className={`text-sm max-w-md ${dark ? 'text-white/60' : 'text-black/55'}`}>
              未登录只能试看低画质并频繁要求登录，无法稳定获取视频。登录后可解锁 1080P 高画质，自动为当前歌曲寻找官方 MV 与字幕。
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowLogin(true)}
              className="rounded-xl px-6 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-105"
              style={{ backgroundColor: BILI_PINK }}
            >
              扫码登录哔哩哔哩
            </button>
            <button
              type="button"
              onClick={onBackToAudio}
              className={`rounded-xl px-6 py-2.5 text-sm font-medium transition-colors ${
                dark ? 'bg-white/10 text-white/80 hover:bg-white/20' : 'bg-black/10 text-black/70 hover:bg-black/20'
              }`}
            >
              暂不，继续听歌
            </button>
            <button
              type="button"
              onClick={() => setShowProfile(true)}
              className={`rounded-xl px-6 py-2.5 text-sm font-medium transition-colors ${
                dark ? 'bg-white/10 text-white/80 hover:bg-white/20' : 'bg-black/10 text-black/70 hover:bg-black/20'
              }`}
            >
              进入我的哔哩哔哩
            </button>
          </div>
        </div>
      ) : status === 'searching' || status === 'loading' ? (
        <div className="relative z-10 h-full flex flex-col items-center justify-center gap-4 px-8">
          <div
            className="w-14 h-14 rounded-full border-4 border-transparent animate-spin"
            style={{ borderTopColor: BILI_PINK, borderRightColor: BILI_PINK }}
          />
          <p className={`text-sm ${dark ? 'text-white/70' : 'text-black/60'}`}>
            {status === 'searching' ? `正在从哔哩哔哩寻找《${songTitle}》的 MV…` : '正在加载视频…'}
          </p>
          <p className={`text-xs ${dark ? 'text-white/35' : 'text-black/35'}`}>{songArtist}</p>
        </div>
      ) : status === 'playing' && videoUrl ? (
        <>
          {/* DASH 音频轨（音画分离，与视频同步；autoPlay 兜底换流后自动续播） */}
          <audio ref={audioRef} src={audioUrl || undefined} preload="auto" autoPlay />

          {/* 全屏视频（看歌模式：点击不暂停，避免误触中断观看） */}
          <video
            ref={videoRef}
            src={videoUrl}
            poster={resolveBiliPic(activeVideo?.video.pic || '')}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-contain z-10"
          />

          {/* 弹幕层（canvas，覆盖视频之上、字幕/控件之下）；时钟用音频时间（音画分离时视频可能未实际播放） */}
          {danmakuOn && danmakuItems.length > 0 && (
            <DanmakuLayer
              items={danmakuItems}
              settings={danmakuSettings}
              isPlaying={isPlaying}
              videoRef={videoRef}
              getTime={() => Math.max(audioRef.current?.currentTime ?? 0, videoRef.current?.currentTime ?? 0)}
            />
          )}

          {/* 快进/快退指示（右上角，避免与左上角歌曲信息/底部控件重叠） */}
          <AnimatePresence>
            {seekFeedback && (
              <motion.div
                key={seekFeedback.direction + seekFeedback.seconds}
                initial={{ opacity: 0, y: -10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="fixed right-8 top-20 z-[80] pointer-events-none min-w-40 rounded-full px-5 py-3 backdrop-blur-2xl"
                style={{
                  background: 'rgba(10, 14, 24, 0.74)',
                  border: '1px solid rgba(255,255,255,0.14)',
                  boxShadow: '0 12px 34px rgba(0,0,0,0.32)',
                }}
              >
                <div className="flex items-center justify-center gap-2 text-sm font-bold tracking-wide text-white">
                  <span>{seekFeedback.direction === 'forward' ? '▶▶' : '◀◀'}</span>
                  <span>{seekFeedback.direction === 'forward' ? '+' : '-'}{seekFeedback.seconds}s</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 字幕/歌词行（官方字幕即歌词） */}
          <AnimatePresence>
            {subtitleOn && currentSubtitle && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute z-30 left-1/2 -translate-x-1/2 w-[70%] text-center cursor-grab active:cursor-grabbing select-none"
                style={{ bottom: subtitlePos }}
                onPointerDown={onSubtitlePointerDown}
                onPointerMove={onSubtitlePointerMove}
                onPointerUp={onSubtitlePointerUp}
                title="拖动可调整字幕位置（自动记住）"
              >
                <p
                  className="inline-block px-4 py-1.5 rounded-xl bg-black/45 backdrop-blur-sm text-white leading-snug shadow-lg"
                  style={{ fontSize: settings.subtitleSize }}
                >
                  {currentSubtitle}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 左上：歌名 / 歌手（与底部栏联动自动隐藏） */}
          <AnimatePresence>
            {showTopInfo && (
              <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="absolute z-30 top-6 left-6 max-w-[46%] pointer-events-none"
              >
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-2xl font-bold text-white" style={{ textShadow: '0 2px 16px rgba(0,0,0,0.65)' }}>
                    {songTitle}
                  </h2>
                  {activeVideo?.type !== 'other' && activeVideo && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-white flex-shrink-0" style={{ backgroundColor: watchAccent }}>
                      {TYPE_BADGES[activeVideo.type].label}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-sm text-white/70" style={{ textShadow: '0 1px 8px rgba(0,0,0,0.6)' }}>{songArtist}</p>
                {activeVideo && (
                  <p className="mt-0.5 truncate text-xs text-white/45 max-w-[420px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.6)' }}>
                    {activeVideo.video.title}
                  </p>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 底部控制条：进度（长条无滑块）+ 上一曲/播放/下一曲（横向）+ 按钮组（联动左上信息自动隐藏） */}
          <AnimatePresence>
            {showControls && (
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 24 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
                className="absolute z-30 bottom-0 inset-x-0 px-6 pb-4 pt-14 bg-gradient-to-t from-black/75 via-black/30 to-transparent pointer-events-none"
              >
                {/* 单行：上一曲/播放/下一曲 + 时间 + 进度条（flex-1 止于右侧按钮组左侧）+ 右下角按钮组。
                    右侧按钮组位置不动；进度条不再通长。 */}
                <div className="flex items-center gap-3 pointer-events-auto">
                  <div className="flex items-center gap-1.5 flex-shrink-0" data-tv-arrows="play prev next">
                    <button type="button" onClick={onPrevious} className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 hover:bg-white/15 hover:text-white transition-colors" title="上一首">
                      <ChevronLeft size={20} />
                    </button>
                    <button
                      type="button"
                      onClick={handleTogglePlay}
                      className="w-11 h-11 rounded-full flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95"
                      style={{ backgroundColor: watchAccent, boxShadow: '0 4px 18px rgba(0,0,0,0.45)' }}
                      title={isPlaying ? '暂停' : '播放'}
                    >
                      {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} className="ml-0.5" fill="currentColor" />}
                    </button>
                    <button type="button" onClick={onNext} className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 hover:bg-white/15 hover:text-white transition-colors" title="下一首">
                      <ChevronRight size={20} />
                    </button>
                  </div>

                  {/* 进度条（长条无小白球，拖动可跳转） */}
                  <span className="text-xs text-white/70 w-10 text-right flex-shrink-0">{formatBiliTime(videoTime)}</span>
                  <input
                    type="range"
                    min={0}
                    max={videoDuration || 0}
                    value={videoTime}
                    onChange={(e) => handleSeek(parseFloat(e.target.value))}
                    className="flex-1 min-w-0 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-0 [&::-webkit-slider-thumb]:h-0"
                    style={{
                      background: `linear-gradient(to right, ${watchAccent} ${videoDuration ? (videoTime / videoDuration) * 100 : 0}%, rgba(255,255,255,0.2) ${videoDuration ? (videoTime / videoDuration) * 100 : 0}%)`,
                    }}
                  />
                  <span className="text-xs text-white/70 w-10 flex-shrink-0">{formatBiliTime(videoDuration)}</span>

                  {/* 右下角按钮组：并入同一行，紧跟在进度条右侧（进度条 flex-1 止于此处） */}
                  <div className="flex items-center gap-1.5 flex-shrink-0 pointer-events-auto">
                  {/* 画质徽章：点击弹出画质菜单切换 */}
                  {quality > 0 && (
                    <div className="relative">
                      <button
                        type="button"
                        title="切换画质"
                        onClick={() => setShowQualityMenu((v) => !v)}
                        className="h-8 px-2.5 rounded-full flex items-center text-[11px] font-semibold text-white transition-colors"
                        style={{ backgroundColor: quality >= 112 ? watchAccent : 'rgba(255,255,255,0.18)' }}
                      >
                        {qualityLabel(quality)}
                      </button>
                      <AnimatePresence>
                        {showQualityMenu && (
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 8 }}
                            transition={{ duration: 0.15 }}
                            className="absolute bottom-full right-0 mb-2 w-40 rounded-xl bg-black/85 backdrop-blur-xl border border-white/15 p-1.5 shadow-2xl z-40"
                          >
                            {qualityOptions.map((qn) => (
                              <button
                                key={qn}
                                type="button"
                                onClick={() => void switchQuality(qn)}
                                className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${quality === qn ? 'text-white bg-white/15' : 'text-white/65 hover:bg-white/10'}`}
                              >
                                {qualityLabel(qn)}
                              </button>
                            ))}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  <button
                    type="button"
                    title="歌曲信息"
                    onClick={() => setShowSongInfo((v) => !v)}
                    className="h-8 px-2.5 rounded-full backdrop-blur-md border border-white/15 flex items-center gap-1 text-xs transition-colors"
                    style={showSongInfo ? { backgroundColor: watchAccent, color: '#fff' } : { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.8)' }}
                  >
                    <Info size={14} />
                    信息
                  </button>
                  {subtitles.length > 0 && (
                    <button
                      type="button"
                      title={subtitleOn ? '关闭字幕' : '开启字幕'}
                      onClick={() => void toggleSubtitle()}
                      className="h-8 w-8 rounded-full backdrop-blur-md border border-white/15 flex items-center justify-center transition-colors"
                      style={subtitleOn ? { backgroundColor: watchAccent, color: '#fff' } : { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.75)' }}
                    >
                      {subtitleOn ? <Subtitles size={15} /> : <CaptionsOff size={15} />}
                    </button>
                  )}
                  <button
                    type="button"
                    title={danmakuOn ? '关闭弹幕' : '开启弹幕'}
                    onClick={() => {
                      const next = !danmakuOn
                      danmakuUserChoiceRef.current = next
                      setDanmakuOn(next)
                      // 持久化：弹幕开关重启后不丢（否则重挂载即回退默认开/关）
                      saveDanmakuSettings({ enabled: next })
                    }}
                    className="h-8 w-8 rounded-full backdrop-blur-md border border-white/15 flex items-center justify-center transition-colors"
                    style={danmakuOn ? { backgroundColor: watchAccent, color: '#fff' } : { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.75)' }}
                  >
                    {danmakuOn ? <MessageCircle size={15} /> : <MessageCircleOff size={15} />}
                  </button>
                  <button
                    type="button"
                    title="换一个视频"
                    onClick={dislikeCurrent}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <Shuffle size={15} />
                  </button>
                  <button
                    type="button"
                    title="更换视频"
                    onClick={() => setShowPicker(true)}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <ListVideo size={15} />
                  </button>
                  <button
                    type="button"
                    title="播放列表"
                    onClick={onOpenPlaylist}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <ListMusic size={15} />
                  </button>
                  <button
                    type="button"
                    title="调音室（音效）"
                    onClick={(e) => onOpenMixingStudio?.(e.currentTarget.getBoundingClientRect())}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <AudioLines size={15} />
                  </button>
                  <button
                    type="button"
                    title="看歌设置"
                    onClick={() => setShowSettings(true)}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <SettingsIcon size={15} />
                  </button>
                  <button
                    type="button"
                    title="B 站功能（点赞/投币/收藏/发弹幕/评论）"
                    onClick={() => setShowBiliPanel((v) => !v)}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center transition-colors text-white/75 hover:bg-white/20 hover:text-white"
                    style={showBiliPanel ? { backgroundColor: '#FB7299', color: '#fff', borderColor: 'transparent' } : undefined}
                  >
                    <BiliTvIcon size={16} />
                  </button>
                  <button
                    type="button"
                    title="返回主页"
                    onClick={onHomeClick}
                    className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                  >
                    <Home size={15} />
                  </button>

                  {/* 音量：内联在底部控件栏内（无悬浮弹窗/无缝隙），单击展开横向滑条、双击静音/恢复 */}
                  <div
                    className="flex items-center gap-1 rounded-full pl-1"
                    onMouseEnter={handleVolumeMouseEnter}
                    onMouseLeave={handleVolumeMouseLeave}
                  >
                    <AnimatePresence>
                      {showVolumeSlider && (
                        <motion.div
                          initial={{ width: 0, opacity: 0 }}
                          animate={{ width: 96, opacity: 1 }}
                          exit={{ width: 0, opacity: 0 }}
                          transition={{ duration: 0.18 }}
                          className="overflow-hidden"
                        >
                          <div
                            className="relative h-1.5 w-24 rounded-full bg-white/20 cursor-pointer"
                            onPointerDown={handleVolumePointerDownH}
                            onPointerMove={handleVolumePointerMoveH}
                            onPointerUp={handleVolumePointerUpH}
                          >
                            <div
                              className="absolute left-0 top-0 bottom-0 rounded-full"
                              style={{ backgroundColor: watchAccent, width: `${(isMuted ? 0 : volume) * 100}%` }}
                            />
                            <div
                              className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-md"
                              style={{ left: `calc(${(isMuted ? 0 : volume) * 100}% - 6px)` }}
                            />
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    <button
                      type="button"
                      title="音量（单击展开滑条，双击静音/恢复）"
                      onClick={toggleVolumeSlider}
                      onDoubleClick={toggleMute}
                      className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
                    >
                      {isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
                    </button>
                  </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 歌曲信息面板 */}
          <AnimatePresence>
            {showSongInfo && (
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="absolute z-40 right-6 top-6 w-72 rounded-2xl bg-black/60 backdrop-blur-xl border border-white/15 p-4 shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-semibold text-white/90">歌曲信息</span>
                  <button type="button" onClick={() => setShowSongInfo(false)} className="p-1 rounded-full text-white/60 hover:bg-white/10">
                    <X size={14} />
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  {coverUrl ? (
                    <img src={coverUrl} alt="" className="w-14 h-14 rounded-lg object-cover shadow-lg flex-shrink-0" />
                  ) : (
                    <div className="w-14 h-14 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0">
                      <Music size={22} className="text-white/50" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-white">{songTitle}</p>
                    <p className="truncate text-xs text-white/55 mt-0.5">{songArtist}</p>
                    <p className="truncate text-xs text-white/40 mt-1">{platform ? `${platformDisplay(platform)} · ${songDuration ? formatBiliTime(songDuration) : ''}` : formatBiliTime(songDuration)}</p>
                  </div>
                </div>
                {activeVideo && (
                  <div className="mt-3 pt-3 border-t border-white/10 space-y-1.5">
                    <p className="text-xs text-white/75">正在播放视频</p>
                    <p className="text-xs text-white/50 leading-relaxed">{activeVideo.video.title}</p>
                    <p className="text-xs text-white/40">UP主：{activeVideo.video.author} · 播放 {formatPlayCount(activeVideo.video.play)} · 时长 {formatBiliTime(activeVideo.video.duration)}</p>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* 重播按钮（hold 模式） */}
          <AnimatePresence>
            {showReplay && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="absolute inset-0 z-40 flex items-center justify-center bg-black/50"
              >
                <button
                  type="button"
                  onClick={replayVideo}
                  className="flex items-center gap-3 rounded-full bg-white/90 hover:bg-white text-black px-8 py-4 shadow-2xl transition-colors"
                >
                  <RotateCcw size={26} />
                  <span className="text-lg font-semibold">重播</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        // confirm / none / error：音频继续播，展示候选供确认
        <div className="relative z-10 h-full flex flex-col items-center justify-center gap-5 px-6 overflow-y-auto py-8">
          <div className={`text-center ${dark ? 'text-white/85' : 'text-black/80'}`}>
            <h2 className="text-xl font-bold mb-1">{songTitle}</h2>
            <p className={`text-sm ${dark ? 'text-white/50' : 'text-black/45'}`}>{songArtist} · 音频正常播放中</p>
          </div>

          {status === 'confirm' ? (
            <>
              <p className={`text-sm ${dark ? 'text-white/60' : 'text-black/50'}`}>
                以下视频可能匹配《{songTitle}》，点选一个开始看歌
              </p>
              {renderTypeFilter()}
              {renderCandidateList(
                candidates.filter((c) => pickerTypeFilter === 'all' || c.type === pickerTypeFilter),
                '暂无候选',
              )}
              {renderManualSearch()}
            </>
          ) : status === 'error' ? (
            <>
              <p className={`text-sm max-w-md text-center ${dark ? 'text-white/60' : 'text-black/55'}`}>
                {playError || errorText || '加载失败'}
              </p>
              <button
                type="button"
                onClick={() => void searchSong(true)}
                className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: BILI_PINK }}
              >
                <RefreshCw size={14} /> 重新搜索
              </button>
              {candidates.length > 0 && renderCandidateList(candidates, '')}
              {renderManualSearch()}
            </>
          ) : (
            <>
              <p className={`text-sm ${dark ? 'text-white/60' : 'text-black/50'}`}>
                {getBilibiliBlacklist(songKey).length > 0
                  ? `已跳过 ${getBilibiliBlacklist(songKey).length} 个你不喜欢的视频，可搜索其他关键词`
                  : '未找到合适的 MV，可尝试其他关键词'}
              </p>
              {renderManualSearch()}
              <button
                type="button"
                onClick={() => void searchSong(true)}
                className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white"
                style={{ backgroundColor: BILI_PINK }}
              >
                <RefreshCw size={14} /> 重新搜索
              </button>
            </>
          )}
        </div>
      )}

      {/* 更换视频 / 自定义搜索 浮层 */}
      <AnimatePresence>
        {showPicker && loginReady && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setShowPicker(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-2xl max-h-[70vh] overflow-y-auto rounded-2xl border p-5 ${
                dark ? 'bg-[#12141f]/95 border-white/10' : 'bg-white/95 border-black/10'
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <h3 className={`font-bold ${dark ? 'text-white' : 'text-black/85'}`}>选择视频（《{songTitle}》）</h3>
                <button type="button" onClick={() => setShowPicker(false)} className={`p-1.5 rounded-lg ${dark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
                  <X size={18} />
                </button>
              </div>
              {renderManualSearch()}
              <div className="mt-4 space-y-3">
                {renderTypeFilter()}
                {manualResults.length > 0
                  ? renderCandidateList(
                      manualResults.filter((c) => pickerTypeFilter === 'all' || c.type === pickerTypeFilter),
                      '',
                    )
                  : renderCandidateList(
                      candidates.filter((c) => pickerTypeFilter === 'all' || c.type === pickerTypeFilter),
                      '暂无候选，试试自定义搜索',
                    )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 本地 toast（换视频无候选 / 无字幕等提示） */}
      <AnimatePresence>
        {toastMsg && (
          <motion.div
            initial={{ opacity: 0, y: -16, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="absolute z-50 top-20 left-1/2 -translate-x-1/2 px-5 py-2.5 rounded-xl bg-black/75 backdrop-blur-md border border-white/15 text-sm text-white shadow-2xl pointer-events-none whitespace-nowrap"
          >
            {toastMsg}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 手动选择视频播放满 15 秒：询问是否标记为该歌 MV（仅本地） */}
      <AnimatePresence>
        {manualPlaybackMarkPrompt && (
          <motion.div
            initial={{ opacity: 0, y: -14, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.2 }}
            className="absolute z-[60] top-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3 rounded-2xl px-6 py-4 bg-black/85 backdrop-blur-xl border border-white/15 shadow-2xl"
            style={{ maxWidth: 'min(92vw, 420px)' }}
          >
            <p className="text-sm text-white text-center leading-relaxed">
              这个视频已播放 15 秒，是否将其标记为<br />《{songTitle}》的 MV？
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={confirmManualMark}
                className="rounded-lg px-4 py-1.5 text-xs font-semibold text-white transition-transform hover:scale-105"
                style={{ backgroundColor: BILI_PINK }}
              >
                标记
              </button>
              <button
                type="button"
                onClick={dismissManualMark}
                className="rounded-lg px-4 py-1.5 text-xs font-medium text-white/80 hover:bg-white/10 transition-colors"
              >
                不标记
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 登录弹窗 */}
      {showLogin && (
        <BilibiliLoginPanel
          onClose={() => setShowLogin(false)}
          onLoginSuccess={() => {
            setLoginReady(true)
            setShowLogin(false)
            void searchSong(true)
          }}
        />
      )}

      {/* 看歌设置弹窗 */}
      {showSettings && (
        <BilibiliWatchSettingsModal onClose={() => setShowSettings(false)} playerTheme={playerTheme} />
      )}

      {/* B 站个人主页 */}
      {showProfile && (
        <BilibiliProfileModal
          onClose={() => setShowProfile(false)}
          playerTheme={playerTheme}
          currentSongContext={{ songKey, songTitle }}
        />
      )}

      {/* B 站功能面板（点赞/投币/收藏/发弹幕/评论） */}
      {showBiliPanel && activeVideo && (
        <BilibiliInteractPanel
          bvid={activeVideo.video.bvid}
          aid={activeVideo.video.aid || 0}
          coverUrl={resolveBiliPic(activeVideo.video.pic || '')}
          cid={activeVideo.cid || 0}
          title={activeVideo.video.title}
          author={activeVideo.video.author}
          play={activeVideo.video.play}
          danmaku={activeVideo.video.danmaku}
          playerTheme={playerTheme}
          getCurrentTime={() => videoTime}
          onDanmakuSent={(text, time, mode, color) => {
            // 本地即时上屏（B 站审核前先显示），自己发的弹幕描边框突出
            setDanmakuItems((prev) => [...prev, { time, mode: mode || 1, fontSize: 25, color: color || 0xffffff, text, border: true }].sort((a, b) => a.time - b.time))
          }}
          onClose={() => setShowBiliPanel(false)}
        />
      )}
    </div>
  )
})

export default BilibiliMvPlayer
