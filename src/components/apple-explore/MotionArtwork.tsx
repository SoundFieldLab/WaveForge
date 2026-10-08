/**
 * Apple 动态封面（motion artwork）：HLS 动画封面 + 三档可见性调度。
 *
 * 从 `AppleExplorePanel.tsx` 抽出为共用模块（2026-10-08），供「探索页」与「传统模式
 * Apple 客户端复刻页」共用同一套实现与缓存——两边的封面行为必须一致，避免各写一份漂移。
 * 抽出时逻辑逐行保持原样（含三档可见性、负缓存 TTL、挂起回收媒体的取舍注释）。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  MOTION_LOAD_MARGIN,
  MOTION_PLAY_MARGIN,
  MOTION_RETAIN_MARGIN,
  observeVisibility,
} from '../../utils/visibilityObserver'
import type { AppleWebItem } from '../../services/appleWebService'
import { fetchAppleResourceMotion } from '../../services/appleWebService'
import CachedImage from '../CachedImage'
import AnimatedArtworkCover from '../AnimatedArtworkCover'

function AppleExploreImage(props: React.ComponentProps<typeof CachedImage>) {
  return <CachedImage {...props} platform="apple" retainPrevious />
}

/** 音符占位图标（与探索页一致；不外引以免形成反向依赖） */
function MusicGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 17 4.2v9.47a3 3 0 1 1-2-2.83V8.06l-6 1.5v8.94Z" />
    </svg>
  )
}

// ─────────────────────────── 动态封面 ───────────────────────────

/** 播放页以覆盖层覆盖探索页时置 true：面板内所有动态封面视频暂停取流/播放 */
export const MotionSuspendContext = createContext(false)

/** 动态封面（web powerswoosh 同款）：HLS 流 → hls.js 播放；失败/无则静态帧/静态图 */
export function DynamicCover({ item, className, iconClassName }: { item: AppleWebItem; className?: string; iconClassName?: string }) {
  const suspended = useContext(MotionSuspendContext)
  // 挂起（播放页覆盖探索页 / 面板冻结）时要回收媒体，而不只是 pause：
  // pause 会留下 hls 实例 + MSE 缓冲 + 解码器。所以 suspended 进初始化 effect 依赖，
  // 冻结时走 cleanup 销毁引擎、清 src，解冻后重建。代价是切回来会从首帧重播
  //（poster 先顶上），这是「看不见就不占资源」换来的既定取舍。
  const suspendedRef = useRef(suspended)
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const motionHls = item.motionArtworkUrl

  useEffect(() => {
    suspendedRef.current = suspended
    const video = videoRef.current
    if (!video) return
    if (suspended || document.hidden) video.pause()
    else void video.play().catch(() => undefined)
  }, [suspended])

  useEffect(() => {
    if (!motionHls || videoFailed || suspended) return
    let hls: { destroy: () => void; __visibilityCleanup?: () => void } | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { default: Hls } = await import('hls.js')
        if (cancelled || !videoRef.current) return
        if (!Hls.isSupported()) { setVideoFailed(true); return }
        const inst = new Hls({ autoStartLoad: true, capLevelToPlayerSize: true, maxBufferLength: 8, backBufferLength: 0 })
        hls = inst
        inst.loadSource(motionHls)
        inst.attachMedia(videoRef.current)
        inst.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled || document.hidden || suspendedRef.current) return
          void videoRef.current?.play().catch(() => undefined)
        })
        const onVisibilityChange = () => {
          const video = videoRef.current
          if (!video) return
          if (document.hidden || suspendedRef.current) video.pause()
          else void video.play().catch(() => undefined)
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        inst.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal && !cancelled) setVideoFailed(true)
        })
        if (cancelled) document.removeEventListener('visibilitychange', onVisibilityChange)
        else hls.__visibilityCleanup = () => document.removeEventListener('visibilitychange', onVisibilityChange)
      } catch {
        if (!cancelled) setVideoFailed(true)
      }
    })()
    return () => {
      cancelled = true
      try { hls?.__visibilityCleanup?.() } catch { /* 忽略 */ }
      try { hls?.destroy() } catch { /* 忽略 */ }
      const video = videoRef.current
      if (video) {
        video.pause()
        video.removeAttribute('src')
        video.load()
      }
    }
  }, [motionHls, videoFailed, suspended])

  if (motionHls && !videoFailed) {
    return (
      <video
        ref={videoRef}
        poster={item.motionPosterUrl || item.artworkUrl || undefined}
        muted
        loop
        playsInline
        preload="metadata"
        className={className}
      />
    )
  }
  const staticSrc = item.motionPosterUrl || item.artworkUrl || item.heroArtworkUrl
  if (staticSrc) {
    return <img src={staticSrc} alt={item.name} loading="lazy" className={className} />
  }
  return (
    <div className={`${className} flex items-center justify-center bg-white/[0.06]`}>
      <MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} />
    </div>
  )
}

/** 歌单动态封面缓存（模块级：同页多卡共享，切 tab 不重复请求）。
 *  成功结果长期缓存；空结果（电台无动态图/请求早期失败）只保留 60s 负缓存后重试，
 *  避免启动早期一次失败就把卡片封面永久钉死成静态图。 */
const motionCache = new Map<string, { video?: string; poster?: string } | null>()
const motionCachedAt = new Map<string, number>()
const motionPending = new Map<string, Promise<{ video?: string; poster?: string } | null>>()
const MOTION_NULL_TTL_MS = 60_000

function loadResourceMotion(resourceType: 'playlists' | 'albums' | 'stations', resourceId: string, storefront: string): Promise<{ video?: string; poster?: string } | null> {
  const key = `${storefront}:${resourceType}:${resourceId}`
  if (motionCache.has(key)) {
    const cached = motionCache.get(key) ?? null
    if (cached || Date.now() - (motionCachedAt.get(key) || 0) < MOTION_NULL_TTL_MS) return Promise.resolve(cached)
    motionCache.delete(key)
    motionCachedAt.delete(key)
  }
  const pending = motionPending.get(key)
  if (pending) return pending
  const task = fetchAppleResourceMotion(resourceType, resourceId, storefront)
    .then(result => {
      motionCache.set(key, result)
      motionCachedAt.set(key, Date.now())
      motionPending.delete(key)
      return result
    })
    .catch(() => {
      motionCache.delete(key)
      motionCachedAt.delete(key)
      motionPending.delete(key)
      return null
    })
  motionPending.set(key, task)
  return task
}

export const isMotionResourceType = (type: AppleWebItem['type']): type is 'playlists' | 'albums' | 'stations' => type === 'playlists' || type === 'albums' || type === 'stations'

/** 带动态封面的卡片层（HLS 动画 + 静态封面打底 + 三档可见性调度）。 */
export function MotionArtworkCover({ item, storefront, className, iconClassName }: {
  item: AppleWebItem
  storefront: string
  className?: string
  iconClassName?: string
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  // 三档可见性，全部走共享 observer（同 margin 全页只建一个实例）：
  //  - loadVisible(400px)：一次性闩锁，只决定「要不要去查这张卡的动态封面数据」（结果有会话缓存，便宜）；
  //  - playVisible(150px)：**当前**是否在视口附近 → 决定播放/暂停；
  //  - retainVisible(1200px)：当前是否离视口不远 → 决定保留还是回收 HLS 管线。
  //
  // 旧实现把 400px 的「曾经可见」粘性标记直接当播放资格（active = pageVisible && everVisible && !suspended），
  // 于是滚过去的卡片永远算 active：货架上几十条 768×768 视频会在后台一直解码，
  // 切到别的平台后也只是 pause、MSE 缓冲与解码器全部留着——实测这就是「封面一多电脑就卡」的主因。
  // 现在「加载过」和「正在播」彻底分开：粘性只留给数据查询，播放与媒体保留都看当前距离。
  const [loadVisible, setLoadVisible] = useState(false)
  const [playVisible, setPlayVisible] = useState(false)
  const [retainVisible, setRetainVisible] = useState(false)
  const [pageVisible, setPageVisible] = useState(() => typeof document === 'undefined' || !document.hidden)
  const [motion, setMotion] = useState<{ video?: string; poster?: string } | null | undefined>(
    item.motionArtworkUrl ? { video: item.motionArtworkUrl, poster: item.motionPosterUrl } : undefined,
  )
  const itemKey = `${storefront}:${item.type}:${item.playId || item.id}`
  // 动态封面按目录资源 id 拉取：playId 缺失时回退资源 id（与 openStation 的取 id 规则一致）。
  const motionResourceId = item.playId || item.id
  const motionSuspended = useContext(MotionSuspendContext)
  useEffect(() => {
    setMotion(item.motionArtworkUrl ? { video: item.motionArtworkUrl, poster: item.motionPosterUrl } : undefined)
  }, [itemKey, item.motionArtworkUrl, item.motionPosterUrl])
  const active = pageVisible && playVisible && !motionSuspended
  // 面板冻结（切到别的平台、播放页覆盖）或滚出 1200px：连媒体一起回收，切回来按 URL 重建。
  // 重建到首帧之间显示 poster（本就叠在静态封面上，视觉上是一次淡替而非黑框）。
  const retainMedia = !motionSuspended && (playVisible || retainVisible)

  useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  useEffect(() => {
    const node = hostRef.current
    if (!node) return
    const stopObserving = [
      observeVisibility(node, MOTION_LOAD_MARGIN, { onEnter: () => setLoadVisible(true) }),
      observeVisibility(node, MOTION_PLAY_MARGIN, {
        onEnter: () => setPlayVisible(true),
        onExit: () => setPlayVisible(false),
      }),
      observeVisibility(node, MOTION_RETAIN_MARGIN, {
        onEnter: () => setRetainVisible(true),
        onExit: () => setRetainVisible(false),
      }),
    ]
    return () => { for (const stop of stopObserving) stop() }
  }, [])

  useEffect(() => {
    if (!loadVisible || motion !== undefined || !motionResourceId || !isMotionResourceType(item.type)) return
    let cancelled = false
    void loadResourceMotion(item.type, motionResourceId, storefront).then(result => {
      if (!cancelled) setMotion(result)
    }).catch(() => { if (!cancelled) setMotion(null) })
    return () => { cancelled = true }
  }, [loadVisible, item.type, motion, motionResourceId, storefront])

  return (
    <div
      ref={hostRef}
      className={`relative overflow-hidden ${className || ''}`}
    >
      {/* 静态层固定用作品封面（不用动态封面预览帧），避免动态数据到达后画面自行"变一下"。
          加载失败时给中性占位（此前没有 fallback，失败会露出浏览器的"破图 + alt 文本"）。 */}
      <AppleExploreImage
        src={item.artworkUrl || motion?.poster || ''}
        alt={item.name}
        className="h-full w-full object-cover"
        role="card"
        fallback={(
          <span aria-label={`${item.name} 封面占位`} className="flex h-full w-full items-center justify-center bg-white/[0.06]">
            <MusicGlyph className="h-7 w-7 opacity-40" />
          </span>
        )}
      />
      {motion?.video && (
        <AnimatedArtworkCover
          videoUrl={motion.video}
          posterUrl={motion.poster}
          staticCoverUrl={item.artworkUrl}
          active={active}
          retainMedia={retainMedia}
          className="absolute inset-0 h-full w-full"
          objectFit="cover"
          onError={() => setMotion(null)}
        />
      )}
      {!item.artworkUrl && !motion?.poster && <div className="absolute inset-0 flex items-center justify-center bg-white/[0.06]"><MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} /></div>}
    </div>
  )
}
