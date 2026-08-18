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
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, ChevronLeft, ChevronRight,
  Search, X, Subtitles, CaptionsOff, ArrowLeft, RefreshCw, Eye, Clock, ListVideo, Music,
  Settings as SettingsIcon, ThumbsDown, RotateCcw, Home, Heart, ListMusic, Info, AudioLines,
} from 'lucide-react'
import { useTvMode, useTvBack } from '../tv/tvCore'
import {
  findBestBilibiliMv,
  getBilibiliPlayUrl,
  getBilibiliView,
  getBilibiliSubtitles,
  getBilibiliSubtitleJson,
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
  getStoredBilibiliUser,
  scoreCandidate,
  getBilibiliWatchSettings,
  WATCH_SETTINGS_EVENT,
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
import { useColorThief } from '../hooks/useColorThief'
import { AudioEffectsEngine } from '../services/audio-effects-v2/AudioEffectsEngine'

export interface BilibiliMvPlayerHandle {
  /** 返回 true 表示已接管播放/暂停（视频模式活动） */
  togglePlay: () => boolean
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
  onNext: () => void
  onPrevious: () => void
  /** 退回音频歌词模式 */
  onBackToAudio: () => void
  /** 视频是否正在占用播放（App 据此暂停/恢复音频引擎） */
  onVideoActiveChange?: (active: boolean) => void
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
    onNext,
    onPrevious,
    onBackToAudio,
    onVideoActiveChange,
    onHomeClick,
    onOpenMixingStudio,
    onOpenPlaylist,
    onToggleFavorite,
    liked = false,
    upcomingSongs,
    initialSeekSeconds,
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
  /** 视频音效引擎：DASH 音频轨经 Web Audio 效果链输出（与调音室同引擎、同设置） */
  const videoEffectsRef = useRef<{ ctx: AudioContext; engine: AudioEffectsEngine } | null>(null)
  /** 续播目标位置（音频秒数；加载新视频后 seek 一次即清除） */
  const initialSeekSecondsRef = useRef<number | null>(initialSeekSeconds ?? null)
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
  const [showLogin, setShowLogin] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  // 头像信息只在登录态变化时重读（播放器 timeupdate 4Hz 重渲染，避免每次读 localStorage）
  const storedBiliUser = useMemo(() => getStoredBilibiliUser(), [loginReady])

  const [status, setStatus] = useState<WatchStatus>('login')
  const [errorText, setErrorText] = useState('')
  const [candidates, setCandidates] = useState<CandidateScore[]>([])
  const [activeVideo, setActiveVideo] = useState<CandidateScore | null>(null)

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [quality, setQuality] = useState(0)
  const [playError, setPlayError] = useState('')

  // 字幕
  const [subtitles, setSubtitles] = useState<BilibiliSubtitleLine[]>([])
  const [subtitleOn, setSubtitleOn] = useState(false)
  const [currentSubtitle, setCurrentSubtitle] = useState('')

  // 播放器控件
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(() => {
    const saved = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 0.8
  })
  const [videoTime, setVideoTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showReplay, setShowReplay] = useState(false)
  const [showPicker, setShowPicker] = useState(false)
  const [pickerTypeFilter, setPickerTypeFilter] = useState<'all' | CandidateType>('all')
  const [manualKeyword, setManualKeyword] = useState('')
  const [manualSearching, setManualSearching] = useState(false)
  const [manualResults, setManualResults] = useState<CandidateScore[]>([])
  const [showSongInfo, setShowSongInfo] = useState(false)

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
      if (videoRef.current && !videoRef.current.paused) setShowControls(false)
    }, 3000)
  }, [tvMode])

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

      void (async () => {
        try {
          let cid = candidate.cid || 0
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
          const qn = settingsRef.current.targetQuality === 'auto' ? 127 : settingsRef.current.targetQuality
          const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, qn, controller.signal)
          if (playInfo.code === -404) throw new Error('视频已失效或删除')
          if (playInfo.code !== 0 || !playInfo.cacheKey) throw new Error(playInfo.error || '获取播放地址失败')
          // 大会员专享画质：不报错，播放当前会话可用的最高画质（quality 已由服务端协商）
          setQuality(playInfo.quality)
          setVideoUrl(bilibiliStreamUrl(playInfo.cacheKey, 'video'))
          setAudioUrl(bilibiliStreamUrl(playInfo.cacheKey, 'audio'))
          setStatus('playing')
          reportVideoActive(true)

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
                    if (Array.isArray(lines) && lines.length) {
                      setSubtitles(lines)
                      setSubtitleOn(chosen.aiType === 0) // 人工字幕默认开启，AI 字幕默认关
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

  // 卸载清理
  useEffect(() => {
    return () => {
      searchControllerRef.current?.abort()
      clearControlsTimer()
      reportVideoActive(false)
      // 销毁视频音效引擎（MediaElementAudioSourceNode 永久路由，仅随会话结束释放）
      const session = videoEffectsRef.current
      if (session) {
        videoEffectsRef.current = null
        try { session.engine.dispose() } catch { /* 忽略 */ }
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

  const dislikeCurrent = useCallback(() => {
    const current = activeVideo
    if (!current) return
    addBilibiliBlacklist(songKey, current.video.bvid)
    failedBvidsRef.current.add(current.video.bvid)
    const chain = fallbackChainRef.current
    const next = chain.find((c) => !failedBvidsRef.current.has(c.video.bvid) && c.video.bvid !== current.video.bvid)
    if (next) {
      void loadVideo(next, chain.indexOf(next))
    } else {
      setStatus('confirm')
      setCandidates((prev) => prev.filter((c) => c.video.bvid !== current.video.bvid))
      setVideoUrl(null)
      reportVideoActive(false)
    }
  }, [activeVideo, songKey, loadVideo, reportVideoActive])

  const runManualSearch = useCallback(async () => {
    const keyword = manualKeyword.trim()
    if (!keyword || manualSearching) return
    const controller = new AbortController()
    setManualSearching(true)
    try {
      const r = await searchBilibiliVideos(keyword, 1, controller.signal)
      const ctx: MatchContext = { songTitle, artists: songArtists, songDuration, platform, id: songId }
      const results = (r.results || [])
        .map((v) => scoreCandidate(v, ctx, { preference: settingsRef.current.matchPreference }))
        .filter((c) => c.score !== -Infinity)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
      setManualResults(results)
    } catch {
      setManualResults([])
    } finally {
      setManualSearching(false)
    }
  }, [manualKeyword, manualSearching, songTitle, songArtists, songDuration, platform, songId])

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

  useImperativeHandle(ref, () => ({ togglePlay: handleTogglePlay }), [handleTogglePlay])

  const toggleMute = () => {
    const video = videoRef.current
    const audio = audioRef.current
    const next = !isMuted
    setIsMuted(next)
    if (video) video.muted = true // DASH 视频轨无声音，静音只作用于音频轨
    if (audio) audio.muted = next
  }

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
  }

  const handleSeek = (value: number) => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    video.currentTime = value
    if (audio) audio.currentTime = value
    setVideoTime(value)
  }

  const toggleFullscreen = async () => {
    const electronSystem = (window as any).electron?.system
    if (electronSystem?.setFullscreen) {
      try {
        const isKiosk = (localStorage.getItem('fullscreenMode') || 'kiosk') === 'kiosk'
        if (!isFullscreen) {
          await electronSystem.setFullscreen(true, isKiosk)
          setIsFullscreen(true)
        } else {
          await electronSystem.setFullscreen(false, false)
          setIsFullscreen(false)
        }
        return
      } catch {
        // 降级浏览器全屏
      }
    }
    if (!containerRef.current) return
    if (!isFullscreen) {
      containerRef.current.requestFullscreen?.().catch(() => undefined)
    } else {
      document.exitFullscreen?.().catch(() => undefined)
    }
  }

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
    const behavior = settingsRef.current.videoEndBehavior
    if (behavior === 'next') {
      reportVideoActive(false)
      onNext()
    } else if (behavior === 'replay') {
      replayVideo()
    } else {
      // hold：停在末帧，显示重播按钮
      setShowReplay(true)
    }
  }, [onNext, reportVideoActive, replayVideo])

  // 视频事件绑定
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    const onPlay = () => {
      setIsPlaying(true)
      setShowReplay(false)
      setShowControls(true)
      // 播放中恢复音效 AudioContext（防止 suspended 导致静音）
      const effects = videoEffectsRef.current
      if (effects?.ctx.state === 'suspended') void effects.ctx.resume().catch(() => undefined)
      // 同步音频轨（DASH 音画分离）
      if (audio && audio.paused && audio.currentSrc) void audio.play().catch(() => undefined)
      scheduleControlsHide()
    }
    const onPause = () => {
      setIsPlaying(false)
      setShowControls(true)
      clearControlsTimer()
      if (audio) audio.pause()
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
    }
    const onLoadedMetadata = () => {
      setVideoDuration(video.duration || 0)
      // 从歌词模式切来看歌：续播到音频刚才的位置（按视频时长钳制，保留结尾内容）
      const seekTarget = initialSeekSecondsRef.current
      if (seekTarget != null && seekTarget > 0 && Number.isFinite(video.duration)) {
        const clamped = Math.min(seekTarget, Math.max(0, (video.duration || 0) - 8))
        if (clamped > 0) {
          video.currentTime = clamped
          if (audio) audio.currentTime = clamped
        }
        initialSeekSecondsRef.current = null
      }
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
      // 音频轨就绪后同步续播位置（视频可能更早触发 loadedmetadata）
      const seekTarget = initialSeekSecondsRef.current
      if (seekTarget != null && seekTarget > 0 && audio && Number.isFinite(audio.duration)) {
        const clamped = Math.min(seekTarget, Math.max(0, (audio.duration || 0) - 8))
        if (clamped > 0) audio.currentTime = clamped
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
  }, [subtitles, subtitleOn, handleVideoEnded, reportVideoActive, scheduleControlsHide])

  // 音量/静音应用到新视频
  useEffect(() => {
    const video = videoRef.current
    const audio = audioRef.current
    if (!video) return
    video.muted = true // DASH 视频轨无声音
    if (audio) {
      audio.volume = volume
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
    // 每个视频建一条独立效果链；同一 audio 元素只允许 createMediaElementSource 一次，
    // 首次创建后永久路由，故整个看歌会话复用同一 context/引擎（audio 元素跨视频复用）
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
        const engine = new AudioEffectsEngine()
        engine.attach({ audioContext: ctx, masterGain, analyser })
        // 自动播放策略下 AudioContext 默认 suspended：立即请求恢复，播放手势再兜底
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
        session = { ctx, engine }
        videoEffectsRef.current = session
      } catch (error) {
        console.warn('[看歌] 视频音效引擎初始化失败:', error)
        return
      }
    } else {
      // 已建会话：重新应用当前设置（本地存储为最新源）
      try {
        const raw = localStorage.getItem('waveforge:audio-effects-settings')
        if (raw) {
          const parsed = JSON.parse(raw)
          session.engine.updateSettings(parsed)
        }
      } catch {
        // 忽略
      }
    }
    // 实时同步设置
    const onEffectsChanged = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail && videoEffectsRef.current) {
        videoEffectsRef.current.engine.updateSettings(detail)
        if (videoEffectsRef.current.ctx.state === 'suspended') {
          void videoEffectsRef.current.ctx.resume().catch(() => undefined)
        }
      }
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

  // TV 遥控器 BACK：登录面板 → 设置 → 个人主页 → 候选列表 → 返回音频
  useTvBack(() => {
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
      if (showLogin) setShowLogin(false)
      else if (showSettings) setShowSettings(false)
      else if (showProfile) setShowProfile(false)
      else if (showPicker) setShowPicker(false)
      else if (isFullscreen) return
      else onBackToAudio()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showLogin, showSettings, showProfile, showPicker, isFullscreen, onBackToAudio])

  const dark = playerTheme === 'dark'

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
    <div className="flex items-center gap-2 w-full max-w-3xl">
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
  )

  // ===== 主渲染 =====
  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      data-tv-scope
      onMouseMove={() => {
        setShowControls(true)
        scheduleControlsHide()
      }}
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
          {/* DASH 音频轨（音画分离，与视频同步） */}
          <audio ref={audioRef} src={audioUrl || undefined} preload="auto" />

          {/* 全屏视频 */}
          <video
            ref={videoRef}
            src={videoUrl}
            autoPlay
            playsInline
            muted
            className="absolute inset-0 w-full h-full object-contain z-10"
            onClick={() => {
              handleTogglePlay()
            }}
          />

          {/* 字幕/歌词行（官方字幕即歌词） */}
          <AnimatePresence>
            {subtitleOn && currentSubtitle && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute z-30 left-1/2 -translate-x-1/2 bottom-28 w-[70%] text-center pointer-events-none"
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

          {/* 左上：歌名 / 歌手 */}
          <div className="absolute z-30 top-6 left-6 max-w-[46%]">
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
          </div>

          {/* 左侧小药丸：上一首 / 播放暂停 / 下一首 */}
          <div
            className="absolute z-30 left-6 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1.5 rounded-full bg-black/35 backdrop-blur-md border border-white/15 py-2 px-1.5"
            data-tv-arrows="play prev next"
          >
            <button type="button" onClick={onPrevious} className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 hover:bg-white/15 hover:text-white transition-colors" title="上一首">
              <ChevronLeft size={20} />
            </button>
            <button
              type="button"
              onClick={handleTogglePlay}
              className="w-12 h-12 rounded-full flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95"
              style={{ backgroundColor: watchAccent, boxShadow: '0 4px 18px rgba(0,0,0,0.45)' }}
              title={isPlaying ? '暂停' : '播放'}
            >
              {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} className="ml-0.5" fill="currentColor" />}
            </button>
            <button type="button" onClick={onNext} className="w-9 h-9 rounded-full flex items-center justify-center text-white/80 hover:bg-white/15 hover:text-white transition-colors" title="下一首">
              <ChevronRight size={20} />
            </button>
          </div>

          {/* 底部：进度 + 音量（左下），按钮组（右下） */}
          <div className="absolute z-30 bottom-6 right-6 left-6 flex items-end justify-between gap-4 pointer-events-none">
            <div className="flex items-center gap-3 pointer-events-auto flex-1 min-w-0 max-w-[420px]">
              <span className="text-xs text-white/70 w-10 text-right flex-shrink-0">{formatBiliTime(videoTime)}</span>
              <input
                type="range"
                min={0}
                max={videoDuration || 0}
                value={videoTime}
                onChange={(e) => handleSeek(parseFloat(e.target.value))}
                className="flex-1 min-w-0 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                style={{
                  background: `linear-gradient(to right, ${watchAccent} ${videoDuration ? (videoTime / videoDuration) * 100 : 0}%, rgba(255,255,255,0.2) ${videoDuration ? (videoTime / videoDuration) * 100 : 0}%)`,
                }}
              />
              <span className="text-xs text-white/70 w-10 flex-shrink-0">{formatBiliTime(videoDuration)}</span>
              <button type="button" onClick={toggleMute} className="p-2 rounded-full text-white/70 hover:bg-white/15 transition-colors flex-shrink-0" title="静音">
                {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={isMuted ? 0 : volume}
                onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                className="w-16 h-1 bg-white/20 rounded-full appearance-none cursor-pointer flex-shrink-0
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
              />
            </div>

            <div className="flex items-center gap-1.5 pointer-events-auto flex-wrap justify-end">
              {quality > 0 && (
                <span
                  className="h-8 px-2.5 rounded-full flex items-center text-[11px] font-semibold text-white"
                  style={{ backgroundColor: quality >= 112 ? watchAccent : 'rgba(255,255,255,0.18)' }}
                >
                  {qualityLabel(quality)}
                </span>
              )}
              <button
                type="button"
                title="歌曲信息"
                onClick={() => setShowSongInfo(true)}
                className="h-8 px-2.5 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center gap-1 text-white/80 hover:bg-white/20 hover:text-white transition-colors text-xs"
              >
                <Info size={14} />
                信息
              </button>
              <button
                type="button"
                title={liked ? '取消喜欢' : '喜欢'}
                onClick={onToggleFavorite}
                className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center transition-colors"
                style={liked ? { color: watchAccent, borderColor: `${watchAccent}66` } : { color: 'rgba(255,255,255,0.75)' }}
              >
                <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
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
                title={subtitleOn ? '关闭字幕' : '开启字幕'}
                onClick={() => setSubtitleOn((v) => !v)}
                className="h-8 w-8 rounded-full backdrop-blur-md border border-white/15 flex items-center justify-center transition-colors"
                style={subtitleOn ? { backgroundColor: watchAccent, color: '#fff' } : { backgroundColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.75)' }}
              >
                {subtitleOn ? <Subtitles size={15} /> : <CaptionsOff size={15} />}
              </button>
              <button
                type="button"
                title="换一个视频"
                onClick={dislikeCurrent}
                className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-red-300 transition-colors"
              >
                <ThumbsDown size={15} />
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
                title="全屏"
                onClick={toggleFullscreen}
                className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
              >
                {isFullscreen ? <Minimize size={15} /> : <Maximize size={15} />}
              </button>
              {loginReady && storedBiliUser?.face && (
                <button
                  type="button"
                  title="我的哔哩哔哩"
                  onClick={() => setShowProfile(true)}
                  className="h-8 w-8 rounded-full p-0.5 ring-2 ring-white/25 hover:ring-[#FB7299]/70 transition-all flex-shrink-0 overflow-hidden"
                >
                  <img src={resolveBiliPic(storedBiliUser.face)} alt="" className="w-full h-full rounded-full object-cover bg-white/10" />
                </button>
              )}
              <button
                type="button"
                title="返回主页"
                onClick={onHomeClick}
                className="h-8 w-8 rounded-full bg-white/10 backdrop-blur-md border border-white/15 flex items-center justify-center text-white/75 hover:bg-white/20 hover:text-white transition-colors"
              >
                <Home size={15} />
              </button>
            </div>
          </div>

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
                    <p className="truncate text-xs text-white/40 mt-1">{platform ? `${platform} · ${songDuration ? formatBiliTime(songDuration) : ''}` : formatBiliTime(songDuration)}</p>
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
    </div>
  )
})

export default BilibiliMvPlayer
