import { motion } from 'framer-motion'
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { getResolvedArtworkUrl, preloadArtwork } from '../services/artworkLoader'

interface CrossfadeBackgroundProps {
  coverUrl: string
  transitionFromUrl?: string
  transitionToUrl?: string
  isTransitioning: boolean
  transitionProgress: number
  imageStyle: CSSProperties
}

function isUsableCover(url?: string): url is string {
  return Boolean(url?.trim() && !url.includes('picsum.photos'))
}

function CrossfadeBackground({
  coverUrl,
  transitionFromUrl,
  transitionToUrl,
  isTransitioning,
  transitionProgress,
  imageStyle,
}: CrossfadeBackgroundProps) {
  const resolvedCoverUrl = isUsableCover(coverUrl) ? getResolvedArtworkUrl(coverUrl, { role: 'background' }) : ''
  const resolvedTransitionFromUrl = isUsableCover(transitionFromUrl) ? getResolvedArtworkUrl(transitionFromUrl, { role: 'background' }) : ''
  const resolvedTransitionToUrl = isUsableCover(transitionToUrl) ? getResolvedArtworkUrl(transitionToUrl, { role: 'background' }) : ''
  const [visibleUrl, setVisibleUrl] = useState('')
  const [incomingUrl, setIncomingUrl] = useState('')
  const [readyTransitionToUrl, setReadyTransitionToUrl] = useState('')
  const requestSerialRef = useRef(0)

  useEffect(() => {
    if (!resolvedCoverUrl || isTransitioning) return
    if (resolvedCoverUrl === visibleUrl || resolvedCoverUrl === incomingUrl) return
    const serial = ++requestSerialRef.current
    void preloadArtwork(resolvedCoverUrl, { role: 'background', priority: 'critical', retries: 1 }).then(() => {
      if (serial === requestSerialRef.current) setIncomingUrl(resolvedCoverUrl)
    }).catch(() => {
      if (serial === requestSerialRef.current) setIncomingUrl('')
    })
  }, [incomingUrl, isTransitioning, resolvedCoverUrl, visibleUrl])

  // 兜底提升：淡入动画完成回调（onAnimationComplete）在快速连续切歌/动画中断时
  // 可能不触发，incomingUrl 永远不晋升为 visibleUrl → 封面停留在旧歌。这里用定时器
  // 强制在动画时长 + 余量后完成晋升（与动画回调幂等：先到者生效，后到者 no-op）。
  useEffect(() => {
    if (!incomingUrl) return
    const t = window.setTimeout(() => {
      setVisibleUrl(incomingUrl)
      setIncomingUrl('')
    }, 1200)
    return () => window.clearTimeout(t)
  }, [incomingUrl])


  const explicitTransition = Boolean(
    isTransitioning
      && resolvedTransitionFromUrl
      && resolvedTransitionToUrl
  )
  useEffect(() => {
    let cancelled = false
    if (!resolvedTransitionToUrl) {
      setReadyTransitionToUrl('')
      return
    }
    setReadyTransitionToUrl('')
    void preloadArtwork(resolvedTransitionToUrl, { role: 'background', priority: 'critical', retries: 1 }).then(() => {
      if (!cancelled) setReadyTransitionToUrl(resolvedTransitionToUrl)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [resolvedTransitionToUrl])
  const clampedProgress = Math.max(0, Math.min(1, transitionProgress))

  useEffect(() => {
    if (
      explicitTransition
      && readyTransitionToUrl
      && (resolvedCoverUrl === readyTransitionToUrl || clampedProgress >= 0.995)
    ) {
      setVisibleUrl(readyTransitionToUrl)
      setIncomingUrl('')
    }
  }, [clampedProgress, explicitTransition, readyTransitionToUrl, resolvedCoverUrl])

  const layerStyle = (url: string): CSSProperties => ({
    ...imageStyle,
    backgroundImage: `url(${url})`,
  })

  return (
    <div className="absolute inset-0 overflow-hidden">
      {visibleUrl && (
        <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(visibleUrl)} />
      )}

      {explicitTransition
        && resolvedTransitionFromUrl
        && resolvedTransitionFromUrl !== visibleUrl
        && (
          <div className="absolute inset-0 bg-cover bg-center" style={layerStyle(resolvedTransitionFromUrl)} />
        )}

      {explicitTransition && readyTransitionToUrl ? (
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{
            ...layerStyle(readyTransitionToUrl),
            opacity: clampedProgress,
            transition: `${imageStyle.transition || ''}, opacity 80ms linear`,
          }}
        />
      ) : incomingUrl ? (
        <motion.div
          key={incomingUrl}
          className="absolute inset-0 bg-cover bg-center"
          style={layerStyle(incomingUrl)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          onAnimationComplete={() => {
            setVisibleUrl(incomingUrl)
            setIncomingUrl('')
          }}
        />
      ) : null}
    </div>
  )
}

// memo 包装：transitionProgress 变化时仍会重渲染（背景过渡依赖），
// 但父级其他重渲染且 props 未变时可跳过。注意：App.tsx 中 imageStyle 为内联对象，
// 每次父渲染都会新建引用，会削弱 memo 命中率（transitionProgress 变化时本组件本就该渲染）。
export default memo(CrossfadeBackground)
