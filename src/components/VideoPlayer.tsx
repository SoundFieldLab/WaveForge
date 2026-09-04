import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Pause, Volume2, VolumeX, Maximize, Minimize } from 'lucide-react'
import { getMVPlaybackInfo, getMVDetail } from '../services/musicApi'
import { useTvMode, useTvBack } from '../tv/tvCore'

interface MV {
  id: number | string
  name: string
  platform?: 'netease' | 'qq'
}

interface VideoPlayerProps {
  mvId: number | string
  mvName: string
  platform?: 'netease' | 'qq'
  onClose: () => void
  mvList?: MV[] // MV列表（用于自动续播）
  currentIndex?: number // 当前MV在列表中的索引
}

export default function VideoPlayer({ mvId, mvName, platform = 'netease', onClose, mvList, currentIndex }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [playError, setPlayError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [mvDetail, setMvDetail] = useState<any>(null)
  const [showVolumeSlider, setShowVolumeSlider] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const volumeTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const [videoEndBehavior, setVideoEndBehavior] = useState<'next' | 'close' | 'replay'>('next')
  const [showReplayButton, setShowReplayButton] = useState(false) // 显示重播按钮
  const [currentMVIndex, setCurrentMVIndex] = useState(currentIndex ?? 0) // 当前播放的MV索引

  // 监听视频播放完毕后行为设置变化
  useEffect(() => {
    const handleVideoEndBehaviorChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setVideoEndBehavior(customEvent.detail)
    }

    // 初始化设置
    const saved = localStorage.getItem('videoEndBehavior')
    if (saved) {
      setVideoEndBehavior(saved as 'next' | 'close' | 'replay')
    }

    window.addEventListener('videoEndBehaviorChanged', handleVideoEndBehaviorChange)
    return () => {
      window.removeEventListener('videoEndBehaviorChanged', handleVideoEndBehaviorChange)
    }
  }, [])

  // 播放指定MV
  const playMV = async (index: number) => {
    if (!mvList || index < 0 || index >= mvList.length) return
    
    const mv = mvList[index]
    setCurrentMVIndex(index)
    setIsLoading(true)
    setShowReplayButton(false)
    setPlayError(null)
    
    try {
      console.log('🎬 开始加载MV:', mv.id, mv.name, 'platform:', mv.platform)
      
      // 获取MV详情
      const detail = await getMVDetail(mv.id, mv.platform || 'netease')
      if (detail) {
        setMvDetail(detail)
        console.log('✅ MV详情加载成功:', detail)
      }
      
      // 获取播放地址
      const info = await getMVPlaybackInfo(mv.id, 1080, mv.platform || 'netease')
      if (info.url) {
        setVideoUrl(info.url)
        setPlayError(null)
        console.log('✅ MV URL加载成功:', info.url)
      } else {
        setVideoUrl(null)
        setPlayError(info.error || '无法获取MV播放地址')
        console.error('❌ 无法获取MV播放地址:', info.error || '')
      }
    } catch (error) {
      console.error('加载MV失败:', error)
    } finally {
      setIsLoading(false)
    }
  }

  // 获取MV播放地址
  useEffect(() => {
    let cancelled = false
    const fetchMVUrl = async () => {
      setIsLoading(true)
      setShowReplayButton(false)
      setPlayError(null)
      try {
        console.log('🎬 开始加载MV:', mvId, mvName, 'platform:', platform)
        
        // 获取MV详情
        const detail = await getMVDetail(mvId, platform)
        if (detail && !cancelled) {
          setMvDetail(detail)
          console.log('✅ MV详情加载成功:', detail)
        }
        
        // 获取播放地址
        const info = await getMVPlaybackInfo(mvId, 1080, platform)
        if (cancelled) return
        if (info.url) {
          setVideoUrl(info.url)
          setPlayError(null)
          console.log('✅ MV URL加载成功:', info.url)
        } else {
          setVideoUrl(null)
          setPlayError(info.error || '无法获取MV播放地址')
          console.error('❌ 无法获取MV播放地址:', info.error || '')
        }
      } catch (error) {
        if (!cancelled) console.error('加载MV失败:', error)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchMVUrl()
    return () => { cancelled = true }
  }, [mvId, mvName, platform])

  // 播放/暂停
  const togglePlay = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation() // 阻止事件冒泡
    }
    if (!videoRef.current) return
    
    if (isPlaying) {
      videoRef.current.pause()
    } else {
      videoRef.current.play()
    }
  }

  // 静音切换
  const toggleMute = (e?: React.MouseEvent) => {
    if (e) {
      e.stopPropagation() // 阻止事件冒泡
    }
    if (!videoRef.current) return
    videoRef.current.muted = !isMuted
    setIsMuted(!isMuted)
  }

  // 显示/隐藏音量滑块
  const toggleVolumeSlider = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowVolumeSlider(!showVolumeSlider)
  }

  // 鼠标移出音量控制区域时的处理
  const handleVolumeMouseLeave = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
    }
    volumeTimeoutRef.current = setTimeout(() => {
      setShowVolumeSlider(false)
    }, 2000)
  }

  // 鼠标进入音量控制区域时取消隐藏
  const handleVolumeMouseEnter = () => {
    if (volumeTimeoutRef.current) {
      clearTimeout(volumeTimeoutRef.current)
    }
  }

  // 清理定时器
  useEffect(() => {
    return () => {
      if (volumeTimeoutRef.current) {
        clearTimeout(volumeTimeoutRef.current)
      }
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [])

  // 鼠标移动时显示控件
  const tvMode = useTvMode()
  // TV 遥控器 BACK 关闭播放器
  useTvBack(() => {
    onClose()
    return true
  })
  const handleMouseMove = () => {
    setShowControls(true)

    // TV 遥控器模式：控件常驻（无鼠标移动事件，靠焦点导航到控件）。
    if (tvMode) {
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
      return
    }

    // 清除之前的定时器
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current)
    }
    
    // 3秒后隐藏控件
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) {
        setShowControls(false)
      }
    }, 3000)
  }

  // 监听播放状态变化
  useEffect(() => {
    if (isPlaying) {
      // 播放时启动隐藏定时器
      handleMouseMove()
    } else {
      // 暂停时显示控件
      setShowControls(true)
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current)
      }
    }
  }, [isPlaying])

  // 全屏切换
  const toggleFullscreen = async (e: React.MouseEvent) => {
    e.stopPropagation() // 阻止事件冒泡
    
    // 优先使用 Electron 的全屏 API（能覆盖任务栏）
    const electronSystem = window.electron?.system
    if (electronSystem?.setFullscreen) {
      try {
        // 获取当前全屏模式设置
        const fullscreenMode = localStorage.getItem('fullscreenMode') || 'kiosk'
        const isKiosk = fullscreenMode === 'kiosk'
        
        if (!isFullscreen) {
          await electronSystem.setFullscreen(true, isKiosk)
          setIsFullscreen(true)
        } else {
          await electronSystem.setFullscreen(false, false)
          setIsFullscreen(false)
        }
        return
      } catch (error) {
        console.error('Electron 全屏切换失败:', error)
      }
    }
    
    // 降级到浏览器 fullscreen API
    if (!containerRef.current) return
    
    if (!isFullscreen) {
      if (containerRef.current.requestFullscreen) {
        containerRef.current.requestFullscreen()
      }
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen()
      }
    }
  }

  // 进度条拖动
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return
    const time = parseFloat(e.target.value)
    videoRef.current.currentTime = time
    setCurrentTime(time)
  }

  // 音量调节
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!videoRef.current) return
    const vol = parseFloat(e.target.value)
    videoRef.current.volume = vol
    setVolume(vol)
    setIsMuted(vol === 0)
  }

  // 视频事件监听
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    const handleTimeUpdate = () => setCurrentTime(video.currentTime)
    const handleLoadedMetadata = () => setDuration(video.duration)
    const handleEnded = () => {
      setIsPlaying(false)
      
      // 根据设置执行不同的行为
      console.log('🎬 视频播放完毕，当前行为设置:', videoEndBehavior)
      
      switch (videoEndBehavior) {
        case 'close':
          // 不重播 - 显示重播按钮
          console.log('🎬 视频播放完毕，显示重播按钮')
          setShowReplayButton(true)
          break
        case 'replay':
          // 重新播放
          console.log('🎬 视频播放完毕，重新播放')
          video.currentTime = 0
          video.play()
          setShowReplayButton(false)
          break
        case 'next':
          // 连播下一个
          console.log('🎬 视频播放完毕，尝试播放下一个')
          if (mvList && currentMVIndex < mvList.length - 1) {
            // 有下一个视频，自动播放
            console.log('🎬 播放下一个MV，索引:', currentMVIndex + 1)
            playMV(currentMVIndex + 1)
          } else {
            // 没有下一个视频，显示重播按钮
            console.log('🎬 已是最后一个MV，显示重播按钮')
            setShowReplayButton(true)
          }
          break
      }
    }

    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('timeupdate', handleTimeUpdate)
    video.addEventListener('loadedmetadata', handleLoadedMetadata)
    video.addEventListener('ended', handleEnded)

    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('timeupdate', handleTimeUpdate)
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('ended', handleEnded)
    }
  }, [videoUrl, videoEndBehavior, onClose, mvList, currentMVIndex])

  // 全屏状态监听
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  // 格式化时间
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // ESC键关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isFullscreen) {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isFullscreen])

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] bg-black/95 flex items-center justify-center"
      data-tv-scope
      onMouseMove={handleMouseMove}
      onClick={(e) => {
        // 只有点击背景区域才关闭，点击视频播放器内部不关闭
        if (e.target === e.currentTarget) {
          onClose()
        }
      }}
    >
      <div ref={containerRef} className="relative w-full h-full flex flex-col">
        {/* 顶部标题栏 */}
        <AnimatePresence>
          {showControls && (
            <motion.div 
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.2 }}
              className="absolute top-0 left-0 right-0 z-10 bg-gradient-to-b from-black/80 to-transparent p-4 flex items-center justify-between"
              onMouseEnter={() => {
                if (controlsTimeoutRef.current) {
                  clearTimeout(controlsTimeoutRef.current)
                }
              }}
            >
              <div className="flex-1">
                <h2 className="text-white text-xl font-semibold">{mvDetail?.name || mvName}</h2>
                {mvDetail?.artistName && (
                  <p className="text-white/70 text-sm mt-1">{mvDetail.artistName}</p>
                )}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onClose()
                }}
                className="text-white/80 hover:text-white transition-colors p-2 rounded-lg hover:bg-white/10"
              >
                <X size={24} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 视频播放器 */}
        <div className="flex-1 flex items-center justify-center relative" onClick={(e) => e.stopPropagation()}>
          {isLoading ? (
            <div className="text-white text-center">
              <div className="w-16 h-16 border-4 border-white/20 border-t-white rounded-full animate-spin mx-auto mb-4"></div>
              <p className="text-lg">加载中...</p>
            </div>
          ) : videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                className="max-w-full max-h-full cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation()
                  togglePlay()
                }}
                autoPlay
              />
              
              {/* 重播按钮 - 视频播放完毕后显示 */}
              <AnimatePresence>
                {showReplayButton && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    className="absolute inset-0 flex items-center justify-center bg-black/50"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <motion.button
                      whileHover={{ scale: 1.1 }}
                      whileTap={{ scale: 0.9 }}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (videoRef.current) {
                          videoRef.current.currentTime = 0
                          videoRef.current.play()
                          setShowReplayButton(false)
                        }
                      }}
                      className="bg-white/90 hover:bg-white text-black rounded-full p-6 shadow-2xl transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <Play size={32} fill="currentColor" />
                        <span className="text-xl font-semibold">重播</span>
                      </div>
                    </motion.button>
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <div className="text-white text-center px-8">
              <p className="text-lg">无法加载视频</p>
              <p className="text-sm text-white/60 mt-2">{playError || '该MV可能暂时无法播放'}</p>
            </div>
          )}
        </div>

        {/* 底部控制栏 */}
        <AnimatePresence>
          {videoUrl && !isLoading && showControls && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              transition={{ duration: 0.2 }}
              className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-black/80 to-transparent p-4"
              data-tv-arrows="seek volume"
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => {
                if (controlsTimeoutRef.current) {
                  clearTimeout(controlsTimeoutRef.current)
                }
              }}
            >
              {/* 进度条 */}
              <div className="mb-3">
                <input
                  type="range"
                  min={0}
                  max={duration || 0}
                  value={currentTime}
                  onChange={handleSeek}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full h-1 bg-white/20 rounded-lg appearance-none cursor-pointer
                    [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 
                    [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                />
                <div className="flex justify-between text-white/70 text-xs mt-1">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
                </div>
              </div>

              {/* 控制按钮 */}
              <div className="flex items-center gap-4">
                {/* 播放/暂停 */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    togglePlay()
                  }}
                  className="text-white hover:bg-white/10 p-2 rounded-lg transition-colors"
                >
                  {isPlaying ? <Pause size={24} /> : <Play size={24} />}
                </button>

                {/* 音量控制 */}
                <div 
                  className="flex items-center gap-2 relative"
                  onMouseEnter={handleVolumeMouseEnter}
                  onMouseLeave={handleVolumeMouseLeave}
                >
                  <button
                    onClick={toggleVolumeSlider}
                    className="text-white hover:bg-white/10 p-2 rounded-lg transition-colors"
                  >
                    {isMuted ? <VolumeX size={20} /> : <Volume2 size={20} />}
                  </button>
                  <AnimatePresence>
                    {showVolumeSlider && (
                      <motion.input
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 80 }}
                        exit={{ opacity: 0, width: 0 }}
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={isMuted ? 0 : volume}
                        onChange={handleVolumeChange}
                        onClick={(e) => e.stopPropagation()}
                        className="h-1 bg-white/20 rounded-lg appearance-none cursor-pointer
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2 [&::-webkit-slider-thumb]:h-2 
                          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                      />
                    )}
                  </AnimatePresence>
                </div>

                {/* 全屏按钮 */}
                <button
                  onClick={toggleFullscreen}
                  className="text-white hover:bg-white/10 p-2 rounded-lg transition-colors ml-auto"
                >
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


