/**
 * B 站视频全屏播放器浮层（个人主页/收藏/历史点播用）
 *
 * bvid → view(cid) → playurl → 流代理 全链路复用；带 CC 字幕（官方字幕即歌词）、
 * 进度续播（历史记录）、可"设为当前歌曲的 MV"（写入该歌 override）。
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Play, Pause, Volume2, VolumeX, Maximize, Minimize, X, RotateCcw, Subtitles, CaptionsOff, Link2,
} from 'lucide-react'
import { useTvMode, useTvBack } from '../tv/tvCore'
import {
  getBilibiliView,
  getBilibiliPlayUrl,
  getBilibiliSubtitles,
  getBilibiliSubtitleJson,
  bilibiliStreamUrl,
  pickBestSubtitle,
  formatBiliTime,
  qualityLabel,
  setBilibiliOverride,
  getBilibiliWatchSettings,
  WATCH_SETTINGS_EVENT,
  type BilibiliSubtitleLine,
  type BilibiliWatchSettings,
} from '../services/bilibiliApi'

interface BilibiliVideoPlayerOverlayProps {
  bvid: string
  title?: string
  onClose: () => void
  /** 续播进度（秒，观看历史用） */
  initialSeek?: number
  /** 提供后显示「设为当前歌曲 MV」按钮 */
  setAsMvContext?: { songKey: string; songTitle: string } | null
}

export default function BilibiliVideoPlayerOverlay({ bvid, title, onClose, initialSeek, setAsMvContext }: BilibiliVideoPlayerOverlayProps) {
  const tvMode = useTvMode()
  useTvBack(() => {
    onClose()
    return true
  })

  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const controlsTimerRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<BilibiliWatchSettings>(() => getBilibiliWatchSettings())

  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [quality, setQuality] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [videoTitle, setVideoTitle] = useState(title || '')

  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [volume, setVolume] = useState(0.9)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [showControls, setShowControls] = useState(true)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showReplay, setShowReplay] = useState(false)
  const [seekApplied, setSeekApplied] = useState(false)

  const [subtitles, setSubtitles] = useState<BilibiliSubtitleLine[]>([])
  const [subtitleOn, setSubtitleOn] = useState(false)
  const [currentSubtitle, setCurrentSubtitle] = useState('')

  const [mvSetHint, setMvSetHint] = useState('')

  useEffect(() => {
    const onSettings = (e: Event) => setSettings(getBilibiliWatchSettings())
    window.addEventListener(WATCH_SETTINGS_EVENT, onSettings as EventListener)
    return () => window.removeEventListener(WATCH_SETTINGS_EVENT, onSettings as EventListener)
  }, [])

  const clearControlsTimer = () => {
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    controlsTimerRef.current = null
  }

  const scheduleControlsHide = useCallback(() => {
    clearControlsTimer()
    if (tvMode || !settings.autoHideControls) return
    controlsTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) setShowControls(false)
    }, 3000)
  }, [tvMode, settings.autoHideControls])

  // 加载视频
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setLoadError('')
    setSeekApplied(false)
    void (async () => {
      try {
        const view = await getBilibiliView(bvid, controller.signal)
        if (view.code !== 0) throw new Error(view.code === -404 ? '视频已失效或删除' : '获取视频信息失败')
        if (!videoTitle) setVideoTitle(view.data.title)
        const cid = view.data.cid
        const qn = settings.targetQuality === 'auto' ? 80 : settings.targetQuality
        const play = await getBilibiliPlayUrl(bvid, cid, qn, controller.signal)
        if (play.code !== 0 || !play.cacheKey) throw new Error(play.error || '获取播放地址失败')
        if (play.vipLimited && play.quality <= 32) throw new Error('该视频高画质仅限大会员')
        setQuality(play.quality)
        setVideoUrl(bilibiliStreamUrl(play.cacheKey))

        // 字幕
        const subPref = settings.subtitlePreference
        if (subPref !== 'off') {
          const subInfo = await getBilibiliSubtitles(bvid, cid, controller.signal).catch(() => null)
          if (subInfo && subInfo.code === 0 && subInfo.subtitles.length) {
            const chosen = pickBestSubtitle(subInfo.subtitles, subPref)
            if (chosen) {
              const lines = await getBilibiliSubtitleJson(chosen.cacheKey, controller.signal).catch(() => [] as BilibiliSubtitleLine[])
              if (Array.isArray(lines) && lines.length) {
                setSubtitles(lines)
                setSubtitleOn(chosen.aiType === 0)
              }
            }
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : '加载失败')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => {
      controller.abort()
      clearControlsTimer()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bvid])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play().catch(() => undefined)
    else video.pause()
  }

  const replayVideo = () => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = 0
    void video.play().catch(() => undefined)
    setShowReplay(false)
  }

  const handleSetAsMv = () => {
    if (!setAsMvContext) return
    setBilibiliOverride(setAsMvContext.songKey, bvid)
    setMvSetHint(`已设为《${setAsMvContext.songTitle}》的 MV，回到看歌将自动播放`)
    window.setTimeout(() => setMvSetHint(''), 3500)
  }

  // 视频事件
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => {
      setIsPlaying(true)
      setShowReplay(false)
      setShowControls(true)
      scheduleControlsHide()
    }
    const onPause = () => {
      setIsPlaying(false)
      setShowControls(true)
      clearControlsTimer()
    }
    const onTimeUpdate = () => {
      setCurrentTime(video.currentTime)
      // 续播：loadedmetadata 后跳一次进度
      if (!seekApplied && initialSeek && initialSeek > 5 && video.duration && video.currentTime < 1) {
        video.currentTime = Math.min(initialSeek, Math.max(0, video.duration - 5))
        setSeekApplied(true)
      }
      if (subtitles.length && subtitleOn) {
        const t = video.currentTime
        let line = ''
        for (const s of subtitles) {
          if (t >= s.from && t < s.to) { line = s.content; break }
        }
        setCurrentSubtitle(line)
      }
    }
    const onLoaded = () => setDuration(video.duration || 0)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('ended', () => {
      setIsPlaying(false)
      setShowReplay(true)
      setShowControls(true)
    })
    video.addEventListener('error', () => setLoadError('视频播放失败（可能已失效或网络异常）'))
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('loadedmetadata', onLoaded)
    }
  }, [subtitles, subtitleOn, initialSeek, seekApplied, scheduleControlsHide])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = isMuted
  }, [videoUrl, volume, isMuted])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // ESC
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isFullscreen) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen, onClose])

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
    if (!isFullscreen) containerRef.current.requestFullscreen?.().catch(() => undefined)
    else document.exitFullscreen?.().catch(() => undefined)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[95] bg-black/95 flex items-center justify-center"
      data-tv-scope
      onMouseMove={() => {
        setShowControls(true)
        scheduleControlsHide()
      }}
    >
      <div ref={containerRef} className="relative w-full h-full flex flex-col">
        {/* 顶部栏 */}
        <AnimatePresence>
          {showControls && (
            <motion.div
              initial={{ opacity: 0, y: -16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }}
              className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4 flex items-center justify-between gap-4"
            >
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-white text-lg font-semibold">{videoTitle || title || 'B 站视频'}</h2>
                {quality > 0 && (
                  <span className="inline-block mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-semibold text-white" style={{ backgroundColor: quality >= 80 ? '#FB7299' : 'rgba(255,255,255,0.25)' }}>
                    {qualityLabel(quality)}
                  </span>
                )}
              </div>
              {setAsMvContext && (
                <button
                  type="button"
                  onClick={handleSetAsMv}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white hover:bg-white/15 transition-colors"
                  title={`设为《${setAsMvContext.songTitle}》的 MV`}
                >
                  <Link2 size={14} /> 设为当前歌曲MV
                </button>
              )}
              <button type="button" onClick={onClose} className="p-2 text-white/80 hover:text-white rounded-lg hover:bg-white/10 transition-colors">
                <X size={22} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 视频区 */}
        <div className="flex-1 flex items-center justify-center relative">
          {loading ? (
            <div className="text-white text-center">
              <div className="w-14 h-14 border-4 border-white/20 border-t-[#FB7299] rounded-full animate-spin mx-auto mb-4" />
              <p className="text-sm text-white/70">加载中…</p>
            </div>
          ) : loadError ? (
            <div className="text-white text-center px-8">
              <p className="text-lg">{loadError}</p>
              <button type="button" onClick={onClose} className="mt-4 px-5 py-2 rounded-lg bg-white/10 text-white/80 hover:bg-white/20 text-sm">
                关闭
              </button>
            </div>
          ) : videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                autoPlay
                playsInline
                className="max-w-full max-h-full cursor-pointer"
                onClick={togglePlay}
              />
              {/* 字幕 */}
              <AnimatePresence>
                {subtitleOn && currentSubtitle && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    className="absolute bottom-24 left-1/2 -translate-x-1/2 w-[80%] text-center pointer-events-none z-20"
                  >
                    <p className="inline-block px-4 py-1.5 rounded-xl bg-black/45 backdrop-blur-sm text-white leading-snug shadow-lg" style={{ fontSize: settings.subtitleSize }}>
                      {currentSubtitle}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
              {/* 重播 */}
              <AnimatePresence>
                {showReplay && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    className="absolute inset-0 flex items-center justify-center bg-black/50 z-20"
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
          ) : null}

          {/* 设为MV提示 */}
          <AnimatePresence>
            {mvSetHint && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute top-16 left-1/2 -translate-x-1/2 z-30 rounded-xl bg-[#FB7299] text-white text-sm px-4 py-2 shadow-xl"
              >
                {mvSetHint}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 底部控制栏 */}
        <AnimatePresence>
          {videoUrl && !loading && showControls && (
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/85 to-transparent p-4"
              data-tv-arrows="seek volume"
            >
              <div className="flex items-center gap-3">
                <span className="text-xs text-white/70 w-10 text-right">{formatBiliTime(currentTime)}</span>
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  value={currentTime}
                  onChange={(e) => {
                    const video = videoRef.current
                    if (!video) return
                    const t = parseFloat(e.target.value)
                    video.currentTime = t
                    setCurrentTime(t)
                  }}
                  className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                  style={{
                    background: `linear-gradient(to right, #FB7299 ${duration ? (currentTime / duration) * 100 : 0}%, rgba(255,255,255,0.2) ${duration ? (currentTime / duration) * 100 : 0}%)`,
                  }}
                />
                <span className="text-xs text-white/70 w-10">{formatBiliTime(duration)}</span>
              </div>
              <div className="flex items-center gap-2 mt-2">
                <button type="button" onClick={togglePlay} className="p-2 rounded-full text-white hover:bg-white/15 transition-colors">
                  {isPlaying ? <Pause size={26} /> : <Play size={26} />}
                </button>
                <button type="button" onClick={() => { const v = videoRef.current; if (!v) return; v.muted = !isMuted; setIsMuted(!isMuted) }} className="p-2 rounded-lg text-white hover:bg-white/15 transition-colors ml-1">
                  {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const vol = parseFloat(e.target.value)
                    setVolume(vol)
                    setIsMuted(vol === 0)
                    if (videoRef.current) videoRef.current.volume = vol
                  }}
                  className="w-24 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                />
                {subtitles.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSubtitleOn((v) => !v)}
                    className={`p-2 rounded-lg transition-colors ml-2 ${subtitleOn ? 'text-white bg-white/25' : 'text-white/70 hover:bg-white/15'}`}
                  >
                    {subtitleOn ? <Subtitles size={18} /> : <CaptionsOff size={18} />}
                  </button>
                )}
                <button type="button" onClick={toggleFullscreen} className="p-2 rounded-lg text-white hover:bg-white/15 transition-colors ml-auto">
                  {isFullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}
