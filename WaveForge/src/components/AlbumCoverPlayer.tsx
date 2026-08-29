import { motion, AnimatePresence } from 'framer-motion'
import CachedImage from './CachedImage'
import AnimatedArtworkCover from './AnimatedArtworkCover'
import { memo, useState, useEffect, useRef } from 'react'
import { EMPTY_AUDIO_PULSE_STORE, type AudioPulseStore } from '../hooks/useAudioPulse'

interface Track {
  coverUrl: string
  dominantColor?: string | null
}

interface AlbumCoverPlayerProps {
  coverUrl: string
  isPlaying: boolean
  dominantColor: string | null
  trackId?: string | number
  isTransitioning?: boolean
  transitionProgress?: number
  transitionFromTrack?: Track | null
  transitionToTrack?: Track | null
  pulseStore?: AudioPulseStore
  /** Apple Music 动态封面（图层叠加式：有则盖在静态封面之上，无/失败回退静态） */
  animatedCoverUrl?: string | null
  animatedCoverPoster?: string | null
}

// memo 包装：transitionProgress 变化时仍会重渲染（过渡动画依赖），
// 但父级因 currentTime/toast 等其他状态重渲染且本组件 props 未变时可跳过。
// 注意 AnimatePresence 被 import 但未在 JSX 中使用，保留以维持原引用。
function AlbumCoverPlayer({ 
  coverUrl, 
  isPlaying, 
  dominantColor, 
  trackId,
  isTransitioning = false,
  transitionProgress = 0,
  transitionFromTrack = null,
  transitionToTrack = null,
  pulseStore = EMPTY_AUDIO_PULSE_STORE,
  animatedCoverUrl = null,
  animatedCoverPoster = null,
}: AlbumCoverPlayerProps) {
  const pulseSurfaceRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let pulseActive = false
    const applyPulse = () => {
      const surface = pulseSurfaceRef.current
      if (!surface) return
      const restlessPulse = pulseStore.getSnapshot().restless
      const nextPulseActive = restlessPulse > 0
      // transform 走合成器、廉价可每帧写；filter(brightness/saturate) 会触发整块封面重绘，
      // 仅在节拍爆发（restless>0）时写入，平时清空避免每帧 repaint
      surface.style.transform = `translate3d(0, 0, 0) scale(${1 + restlessPulse * 0.022})`
      if (nextPulseActive) {
        surface.style.filter = `brightness(${1 + restlessPulse * 0.045}) saturate(${1 + restlessPulse * 0.055})`
      } else if (surface.style.filter) {
        surface.style.filter = ''
      }
      if (nextPulseActive !== pulseActive) {
        pulseActive = nextPulseActive
        surface.style.transition = nextPulseActive
          ? 'transform 0.15s cubic-bezier(0.22, 1, 0.36, 1), filter 0.15s ease-out'
          : 'transform 0.32s ease-out, filter 0.32s ease-out'
      }
    }

    applyPulse()
    return pulseStore.subscribe(applyPulse)
  }, [pulseStore])
  // 使用本地 SVG 占位图
  const defaultCover = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAwIiBoZWlnaHQ9IjUwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNTAwIiBoZWlnaHQ9IjUwMCIgZmlsbD0iIzFhMWExYSIvPjx0ZXh0IHg9IjI1MCIgeT0iMjUwIiBmb250LWZhbWlseT0iQXJpYWwiIGZvbnQtc2l6ZT0iMjQiIGZpbGw9IiM2NjYiIHRleHQtYW5jaG9yPSJtaWRkbGUiPk5vIENvdmVyPC90ZXh0Pjwvc3ZnPg=='
  
  const validCoverUrl = coverUrl && coverUrl.trim() !== '' ? coverUrl : defaultCover
  
  // 用于跟踪过渡时的封面状态
  const [previousCoverUrl, setPreviousCoverUrl] = useState(validCoverUrl)
  const prevTrackIdRef = useRef(trackId)
  const hadActiveTransitionRef = useRef(false)
  const skipCompletedTransitionEntry = !isTransitioning && hadActiveTransitionRef.current

  useEffect(() => {
    hadActiveTransitionRef.current = isTransitioning && transitionProgress > 0
  }, [isTransitioning, transitionProgress])
  
  // 当 trackId 变化时，保存前一个封面作为过渡底层
  useEffect(() => {
    if (trackId !== prevTrackIdRef.current && prevTrackIdRef.current !== undefined) {
      setPreviousCoverUrl(validCoverUrl)
    }
    prevTrackIdRef.current = trackId
  }, [trackId, validCoverUrl])
  
  // 过渡时使用的封面（优先使用 transitionFromTrack/transitionToTrack）
  const fromCover = transitionFromTrack?.coverUrl || previousCoverUrl
  const toCover = transitionToTrack?.coverUrl || validCoverUrl

  return (
    <div
      ref={pulseSurfaceRef}
      className="relative mx-auto h-96 w-96 shrink-0"
      style={{
        transform: 'translate3d(0, 0, 0) scale(1)',
        filter: 'brightness(1) saturate(1)',
        transition: 'transform 0.32s ease-out, filter 0.32s ease-out',
        willChange: 'transform, filter',
      }}
    >

      {/* 封面图片容器 */}
      <div className="relative z-10 h-full w-full overflow-hidden rounded-3xl shadow-2xl">
        {isTransitioning && transitionProgress > 0 ? (
          // 过渡模式：双层叠加效果（类似 Apple Music）
          <div className="relative h-full w-full">
            {/* 底层：旧封面 */}
            <div className="absolute inset-0">
              <CachedImage
                src={fromCover}
                alt="Previous Album Cover"
                className="h-full w-full"
                lazy={false}
                fallback={
                  <img
                    src={defaultCover}
                    alt="No Cover"
                    className="h-full w-full object-cover"
                  />
                }
              />
            </div>
            
            {/* 顶层：新封面（根据过渡进度渐变） */}
            <motion.div
              className="absolute inset-0"
              style={{
                opacity: transitionProgress,
              }}
            >
              <CachedImage
                src={toCover}
                alt="Next Album Cover"
                className="h-full w-full"
                lazy={false}
                fallback={
                  <img
                    src={defaultCover}
                    alt="No Cover"
                    className="h-full w-full object-cover"
                  />
                }
              />
            </motion.div>
          </div>
        ) : (
          // 正常模式：单层封面
          <motion.div
            key={trackId}
            className="h-full w-full overflow-hidden rounded-3xl"
            initial={skipCompletedTransitionEntry ? false : { opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.6, ease: 'easeInOut' }}
          >
            <CachedImage
              src={validCoverUrl}
              alt="Album Cover"
              className="h-full w-full"
              lazy={false}
              fallback={
                <img
                  src={defaultCover}
                  alt="No Cover"
                  className="h-full w-full object-cover"
                />
              }
            />
            {/* Apple Music 动态封面图层：盖在静态封面之上；无/加载失败/开关关闭时
                不渲染，下层平台静态封面直接露出（永不替换显示封面） */}
            <AnimatedArtworkCover
              videoUrl={animatedCoverUrl}
              posterUrl={animatedCoverPoster}
              staticCoverUrl={validCoverUrl}
              active
              className="absolute inset-0 h-full w-full"
            />
          </motion.div>
        )}
      </div>
    </div>
  )
}

export default memo(AlbumCoverPlayer)