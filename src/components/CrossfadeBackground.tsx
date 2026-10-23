import { motion } from 'framer-motion'
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { getResolvedArtworkUrl, preloadArtwork, getArtworkCacheKey, getArtworkEpoch, subscribeArtworkEpoch } from '../services/artworkLoader'
import type { ArtworkLoadOptions } from '../services/artworkLoader'
import { imageCache } from '../utils/imageCache'

interface CrossfadeBackgroundProps {
  coverUrl: string
  transitionFromUrl?: string
  transitionToUrl?: string
  isTransitioning: boolean
  transitionProgress: number
  imageStyle: CSSProperties
  /**
   * 背景源图目标尺寸（px）。不传时按 background 档位（128）取图；
   * 播放页按「实际模糊半径」传入更大尺寸，模糊为 0 时避免 128 源图铺满全屏的糊。
   */
  artworkSize?: number
}

function isUsableCover(url?: string): url is string {
  return Boolean(url?.trim() && !url.includes('picsum.photos'))
}

/**
 * 播放页封面卡同源的「立即可用」档位（512 桶）：
 * 封面卡（CachedImage role=player size=512）已显示新歌封面时，这一档必然已在内存缓存——
 * 背景层直接复用它先换掉上一曲画面，不等全屏大档下载（实测代理不健康时大档挂 6s+，
 * 期间背景一直停留在上一曲封面，用户感知为"切歌了背景还是上一首"）。
 */
const INTERIM_ARTWORK_SIZE = 512
/** 切歌后新封面（任何档位）多久未就绪就把上一曲画面淡出：宁可短暂露出底色渐变，也不显示别的歌 */
const STALE_COVER_HIDE_MS = 2500

function CrossfadeBackground({
  coverUrl,
  transitionFromUrl,
  transitionToUrl,
  isTransitioning,
  transitionProgress,
  imageStyle,
  artworkSize,
}: CrossfadeBackgroundProps) {
  // 解析与预加载必须用同一组档位参数，否则 artworkLoader 的缓存键会分裂成两条。
  // useMemo 保持引用稳定：下面两个 effect 依赖它，每次渲染新建对象会导致无限预加载。
  const resolveOptions: ArtworkLoadOptions = useMemo(
    () => (artworkSize ? { size: artworkSize } : { role: 'background' }),
    [artworkSize],
  )
  const resolvedCoverUrl = isUsableCover(coverUrl) ? getResolvedArtworkUrl(coverUrl, resolveOptions) : ''
  const resolvedTransitionFromUrl = isUsableCover(transitionFromUrl) ? getResolvedArtworkUrl(transitionFromUrl, resolveOptions) : ''
  const resolvedTransitionToUrl = isUsableCover(transitionToUrl) ? getResolvedArtworkUrl(transitionToUrl, resolveOptions) : ''
  const [visibleUrl, setVisibleUrl] = useState('')
  const [incomingUrl, setIncomingUrl] = useState('')
  const [readyTransitionToUrl, setReadyTransitionToUrl] = useState('')
  const requestSerialRef = useRef(0)
  // 失败自愈：preload 失败（如平台档位 404/瞬时限流）时若只把 incomingUrl 复位为 ''，
  // 依赖不会有任何 state 变化 → effect 不再重跑 → 背景永远黑屏（实测表现为"过 1 分钟
  // 等切歌/过渡才突然有背景"）。这里按退避定时强制重跑，最多 3 次。
  const [retryNonce, setRetryNonce] = useState(0)
  const retryStateRef = useRef<{ url: string; attempts: number }>({ url: '', attempts: 0 })
  const retryTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current)
  }, [])
  // stale-hide 定时器回调读取的最新展示层（effect 闭包里的 state 可能已过期）
  const visibleUrlRef = useRef(visibleUrl)
  visibleUrlRef.current = visibleUrl
  const incomingUrlRef = useRef(incomingUrl)
  incomingUrlRef.current = incomingUrl
  // 新封面迟迟未就绪时隐藏上一曲画面（不隐藏过渡叠加层，那由 isTransitioning 分支渲染）
  const [staleHidden, setStaleHidden] = useState(false)
  const staleTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (staleTimerRef.current !== null) window.clearTimeout(staleTimerRef.current)
  }, [])

  // 立即可用的过渡档：目标全屏档大于 512 时才探测（更小档位没有"升级"一说）。
  // 订阅 artwork epoch：封面卡稍后加载完成时本组件能跟着重查缓存，及时换上。
  const artworkEpoch = useSyncExternalStore(subscribeArtworkEpoch, getArtworkEpoch, getArtworkEpoch)
  const canUseInterim = Boolean(artworkSize && artworkSize > INTERIM_ARTWORK_SIZE)
  const resolvedInterimUrl = canUseInterim && isUsableCover(coverUrl)
    ? getResolvedArtworkUrl(coverUrl, { size: INTERIM_ARTWORK_SIZE })
    : ''
  // artworkEpoch 参与依赖：任何封面加载完成都可能让这里从空变为命中
  const cachedInterimUrl = useMemo(() => {
    if (!resolvedInterimUrl || resolvedInterimUrl === resolvedCoverUrl) return ''
    const key = getArtworkCacheKey(resolvedInterimUrl, { size: INTERIM_ARTWORK_SIZE })
    return (key && imageCache.get(key)) || ''
  }, [resolvedInterimUrl, resolvedCoverUrl, artworkEpoch])

  useEffect(() => {
    if (!resolvedCoverUrl || isTransitioning) return
    if (resolvedCoverUrl === visibleUrl || resolvedCoverUrl === incomingUrl) return
    // 换歌后重置退避计数（同一次挂载内按 URL 记）
    if (retryStateRef.current.url !== resolvedCoverUrl) {
      retryStateRef.current = { url: resolvedCoverUrl, attempts: 0 }
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }
    const serial = ++requestSerialRef.current
    const clearStaleTimer = () => {
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current)
        staleTimerRef.current = null
      }
    }
    // 过渡档已就绪：立即淡入换掉上一曲画面（全屏档就绪后再无缝升级）
    if (cachedInterimUrl && cachedInterimUrl !== visibleUrl && cachedInterimUrl !== incomingUrl) {
      clearStaleTimer()
      setStaleHidden(false)
      setIncomingUrl(cachedInterimUrl)
    } else if (visibleUrl && visibleUrl !== resolvedCoverUrl && visibleUrl !== cachedInterimUrl) {
      // 上一曲画面还挂着、新歌任何档位都没就绪：限时后撤下旧画面（见 staleHidden）
      clearStaleTimer()
      staleTimerRef.current = window.setTimeout(() => {
        staleTimerRef.current = null
        // 触发时再核对：已在新歌任何档位上则不隐藏
        if (incomingUrlRef.current === resolvedCoverUrl || incomingUrlRef.current === resolvedInterimUrl) return
        if (visibleUrlRef.current === resolvedCoverUrl || visibleUrlRef.current === resolvedInterimUrl) return
        setStaleHidden(true)
      }, STALE_COVER_HIDE_MS)
    }
    void preloadArtwork(resolvedCoverUrl, { ...resolveOptions, priority: 'critical', retries: 1 }).then(() => {
      if (serial !== requestSerialRef.current) return
      clearStaleTimer()
      setStaleHidden(false)
      setIncomingUrl(resolvedCoverUrl)
      retryStateRef.current.attempts = 0
    }).catch(() => {
      if (serial !== requestSerialRef.current) return
      // 只撤"全屏大档"的淡入：过渡档（512）可能正在渐入/已展示，撤掉会把正确的新歌画面也打回
      setIncomingUrl(current => (current === resolvedCoverUrl ? '' : current))
      const attempts = retryStateRef.current.attempts
      if (attempts >= 3 || retryTimerRef.current !== null) return
      retryStateRef.current = { url: resolvedCoverUrl, attempts: attempts + 1 }
      // 前两次短退避会被 artworkLoader 的 15s 失败 TTL 立刻拒绝，属预期内的廉价探测
      const RETRY_DELAYS_MS = [4_000, 16_000, 30_000]
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        setRetryNonce(value => value + 1)
      }, RETRY_DELAYS_MS[attempts])
    })
  }, [incomingUrl, isTransitioning, resolvedCoverUrl, resolveOptions, visibleUrl, retryNonce, cachedInterimUrl, resolvedInterimUrl])

  // 换歌（coverUrl 变化）即重置隐藏状态：上一轮的 staleHidden 不能压住新歌的首次淡入
  const prevCoverSourceRef = useRef(coverUrl)
  useEffect(() => {
    if (prevCoverSourceRef.current !== coverUrl) {
      prevCoverSourceRef.current = coverUrl
      setStaleHidden(false)
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current)
        staleTimerRef.current = null
      }
    }
  }, [coverUrl])

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
    void preloadArtwork(resolvedTransitionToUrl, { ...resolveOptions, priority: 'critical', retries: 1 }).then(() => {
      if (!cancelled) setReadyTransitionToUrl(resolvedTransitionToUrl)
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [resolvedTransitionToUrl, resolveOptions])
  const clampedProgress = Math.max(0, Math.min(1, transitionProgress))

  useEffect(() => {
    if (
      explicitTransition
      && readyTransitionToUrl
      && (resolvedCoverUrl === readyTransitionToUrl || clampedProgress >= 0.995)
    ) {
      setVisibleUrl(readyTransitionToUrl)
      setIncomingUrl('')
      setStaleHidden(false)
    }
  }, [clampedProgress, explicitTransition, readyTransitionToUrl, resolvedCoverUrl])

  const layerStyle = (url: string): CSSProperties => ({
    ...imageStyle,
    backgroundImage: `url(${url})`,
  })
  // 只在非过渡态隐藏：过渡叠加层有自己的渲染分支，不受 staleHidden 影响
  const hideStaleCover = staleHidden && !explicitTransition

  return (
    <div className="absolute inset-0 overflow-hidden">
      {visibleUrl && !hideStaleCover && (
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
