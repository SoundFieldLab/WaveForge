/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 酷狗探索页「发现」分区：对齐酷狗概念版「发现」tab 的真机结构（2026-10-15 抓包）。
 *
 * 顶层：
 *  - 红心 Radio 轮播（官方顶部播放卡 + 右侧圆盘队列，图3 交互：点击播放整组）
 *  - 卡片流：pxy/listen 还原的板块序列（VIP专属推荐 / 小众宝藏佳作 / 概念er新推 /
 *    私人专属好歌 / 喜欢这首歌的TA也喜欢 / AI免费听 / 潮流尝鲜 / 曲风盲盒 / 频道推荐 /
 *    喜欢「标签」的TA也喜欢），滚动到底自动翻页加载下一批
 *  - 每个歌曲板块右侧「>」进入二级聚合页（图4：播放全部 + 完整列表 + 推荐语）
 *  - 曲风盲盒：横向 tag 卡 + 换一批（随机心动）
 *  - 频道推荐「>」进入频道页：页签（推荐/周榜/次元/AI/放松/私藏/学习/国风/流行）+
 *    三列瀑布流（45/页，滚动加载）
 *
 * 去广告：y_lab（概念实验室：邀好友得年卡/组队领VIP/下载券）与服务端同层剔除；
 * banner 接口不实现。数据全部来自真实接口，取不到时展示明确空态，不造假。
 *
 * PC 适配：横向滚动条 + 鼠标滚轮横滑；栅格在宽屏 2/3/4 列自适应；hover 出播放按钮。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  Heart,
  ListPlus,
  Loader2,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Shuffle,
  Sparkles,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import type { Song } from '../../services/musicApi'
import {
  fetchKugouDiscoverBlindbox,
  fetchKugouDiscoverSections,
  fetchKugouDiscoverWaterfall,
  fetchKugouHeartRadioSongs,
  likeKugouSong,
  kugouDiscoverSongToTrack,
  resolveKugouCover,
  type KugouDiscoverSection,
  type KugouDiscoverSong,
  type KugouDiscoverStyleTag,
  type KugouDiscoverChannel,
  type KugouHeartRadioSong,
  type KugouWaterfallChannel,
  type KugouChannelTab,
  fetchKugouDiscoverChannelTabs,
} from '../../services/kugouService'

export interface KugouDiscoverHandlers {
  /** 用 KugouTrack 组队列起播（走既有概念版播放通道） */
  onPlayTracks: (tracks: ReturnType<typeof kugouDiscoverSongToTrack>[], startIndex?: number) => void
  /** 打开频道详情（复用既有「频道」板块的详情面板） */
  onOpenChannel?: (channel: { id: string; name: string }) => void
  /** 打开酷狗搜索（频道搜索兜底） */
  onOpenSearch?: (keyword: string) => void
  /** 歌曲行红心切换（整首歌曲上下文：hash/name/歌手/专辑齐全，上游 /v6/add_song 需要 name） */
  onToggleLike?: (song: KugouDiscoverSong, next: boolean) => void
  /** 歌曲右键菜单（PC 端：加入队列/查看评论等，与其它平台一致） */
  onSongContextMenu?: (event: React.MouseEvent, song: KugouDiscoverSong, songs: KugouDiscoverSong[]) => void
}

interface KugouDiscoverBoardProps extends KugouDiscoverHandlers {
  accent: string
  accentRgb: string
  exploreCardBg: string
  loggedIn: boolean
}

// ─────────────────────────── 基础件 ───────────────────────────

const KgImg = memo(function KgImg({ src, alt, className = '', iconClassName = 'h-5 w-5' }: { src?: string; alt: string; className?: string; iconClassName?: string }) {
  return (
    <CachedImage
      src={src || ''}
      alt={alt}
      className={className}
      draggable={false}
      lazy
      priority="visible"
      fallback={
        <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgba(0,180,220,0.5),rgba(90,140,255,0.35))] text-white/80">
          <Music2 className={iconClassName} />
        </div>
      }
    />
  )
})

/**
 * 横向货架（对齐 App「左右滑动」交互 + WaveForge QQ/Apple 页的拖拽 rail 体验）：
 * - 拖拽滑动：指针按住拖动，松手带惯性并吸附到卡片边界（HorizontalShelf 同款）
 * - 悬停边缘出现左右箭头，按页翻（一次约一屏的 82%）
 * - 边缘渐隐遮罩提示可继续滑动
 * 注意：不做「滚轮转横滚」——货架嵌在纵向滚动页里，抢占滚轮会和上下滚动打架。
 */
function HScroll({ children, className = '', ariaLabel = '横向推荐' }: { children: React.ReactNode; className?: string; ariaLabel?: string }) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const animationRef = useRef<number | null>(null)
  const suppressActivationRef = useRef(false)
  const suppressTimerRef = useRef<number | null>(null)
  const dragRef = useRef({ pointerId: -1, startX: 0, startScrollLeft: 0, lastX: 0, lastTime: 0, velocity: 0, moved: false })
  const [canLeft, setCanLeft] = useState(false)
  const [canRight, setCanRight] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [hotEdge, setHotEdge] = useState<'left' | 'right' | null>(null)

  const updateEdges = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    setCanLeft(el.scrollLeft > 2)
    setCanRight(el.scrollLeft < max - 2)
  }, [])

  const cancelAnimation = useCallback(() => {
    if (animationRef.current === null) return
    cancelAnimationFrame(animationRef.current)
    animationRef.current = null
  }, [])

  const animateTo = useCallback((requested: number, duration = 280) => {
    const el = viewportRef.current
    if (!el) return
    cancelAnimation()
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    const target = Math.min(max, Math.max(0, requested))
    const start = el.scrollLeft
    if (Math.abs(target - start) < 1) { el.scrollLeft = target; updateEdges(); return }
    const startedAt = performance.now()
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      el.scrollLeft = start + (target - start) * eased
      updateEdges()
      if (progress < 1) animationRef.current = requestAnimationFrame(step)
      else animationRef.current = null
    }
    animationRef.current = requestAnimationFrame(step)
  }, [cancelAnimation, updateEdges])

  const scrollPage = useCallback((direction: -1 | 1) => {
    const el = viewportRef.current
    if (!el) return
    const distance = Math.max(280, el.clientWidth * 0.82)
    animateTo(el.scrollLeft + direction * distance)
  }, [animateTo])

  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    updateEdges()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(updateEdges) : null
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      cancelAnimation()
      if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current)
    }
  }, [updateEdges, cancelAnimation])

  const suppressActivationAfterDrag = () => {
    suppressActivationRef.current = true
    if (suppressTimerRef.current !== null) window.clearTimeout(suppressTimerRef.current)
    suppressTimerRef.current = window.setTimeout(() => { suppressActivationRef.current = false }, 500)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    const el = viewportRef.current
    if (!el) return
    cancelAnimation()
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: el.scrollLeft, lastX: event.clientX, lastTime: event.timeStamp, velocity: 0, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current
    const drag = dragRef.current
    if (!el || drag.pointerId !== event.pointerId) return
    const distance = event.clientX - drag.startX
    if (Math.abs(distance) >= 6 && !drag.moved) {
      drag.moved = true
      el.setPointerCapture?.(event.pointerId)
      setDragging(true)
    }
    if (!drag.moved) return
    event.preventDefault()
    const elapsed = event.timeStamp - drag.lastTime
    if (elapsed > 0) {
      const v = -(event.clientX - drag.lastX) / elapsed
      drag.velocity = drag.velocity * 0.65 + v * 0.35
    }
    drag.lastX = event.clientX
    drag.lastTime = event.timeStamp
    el.scrollLeft = drag.startScrollLeft - distance
    updateEdges()
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const el = viewportRef.current
    const drag = dragRef.current
    if (!el || drag.pointerId !== event.pointerId) return
    if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture?.(event.pointerId)
    drag.pointerId = -1
    setDragging(false)
    if (!drag.moved) { updateEdges(); return }
    suppressActivationAfterDrag()
    const projected = cancelled ? el.scrollLeft : el.scrollLeft + drag.velocity * 180
    animateTo(projected, cancelled ? 0 : 160)
  }

  const suppressClick = (event: React.MouseEvent) => {
    if (!suppressActivationRef.current) return
    event.preventDefault()
    event.stopPropagation()
  }

  const EDGE_FADE = '26px'
  const maskStyle: React.CSSProperties = (() => {
    const left = canLeft ? `transparent 0, #000 ${EDGE_FADE}` : null
    const right = canRight ? `#000 calc(100% - ${EDGE_FADE}), transparent 100%` : null
    if (!left && !right) return {}
    return {
      maskImage: `linear-gradient(90deg, ${left ?? '#000 0'}, ${right ?? '#000 100%'})`,
      WebkitMaskImage: `linear-gradient(90deg, ${left ?? '#000 0'}, ${right ?? '#000 100%'})`,
    } as React.CSSProperties
  })()

  return (
    <div
      className={`relative ${className}`}
      onPointerMove={event => {
        if (event.pointerType === 'touch') return
        const bounds = event.currentTarget.getBoundingClientRect()
        const localX = event.clientX - bounds.left
        setHotEdge(localX <= 52 ? 'left' : localX >= bounds.width - 52 ? 'right' : null)
      }}
      onPointerLeave={() => setHotEdge(null)}
    >
      <div
        ref={viewportRef}
        role="region"
        aria-label={ariaLabel}
        tabIndex={0}
        onScroll={updateEdges}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={event => finishDrag(event)}
        onPointerCancel={event => finishDrag(event, true)}
        onDragStart={event => event.preventDefault()}
        onClickCapture={suppressClick}
        onContextMenuCapture={suppressClick}
        onKeyDown={event => {
          if (event.key === 'ArrowLeft') { event.preventDefault(); scrollPage(-1) }
          if (event.key === 'ArrowRight') { event.preventDefault(); scrollPage(1) }
        }}
        className={`kg-discover-hscroll wf-no-scrollbar flex select-none gap-4 overflow-x-auto overscroll-x-contain pb-1 ${dragging ? 'cursor-grabbing' : ''}`}
        style={{ touchAction: 'pan-y pinch-zoom', ...maskStyle }}
      >
        {children}
      </div>
      {canLeft && (
        <button
          type="button"
          aria-label="向左浏览"
          onClick={() => scrollPage(-1)}
          className={`absolute -left-4 top-1/2 z-30 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white/75 shadow-lg backdrop-blur transition hover:bg-white/15 hover:text-white ${hotEdge === 'left' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <ChevronRight className="h-4 w-4 rotate-180" />
        </button>
      )}
      {canRight && (
        <button
          type="button"
          aria-label="向右浏览"
          onClick={() => scrollPage(1)}
          className={`absolute -right-4 top-1/2 z-30 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white/75 shadow-lg backdrop-blur transition hover:bg-white/15 hover:text-white ${hotEdge === 'right' ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

function SectionTitle({ title, subtitle, onMore, playAll }: { title: string; subtitle?: string; onMore?: () => void; playAll?: () => void }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <h3 className="truncate text-lg font-semibold tracking-tight text-white md:text-xl">{title}</h3>
        {subtitle && <span className="truncate text-xs text-white/38">{subtitle}</span>}
        {playAll && (
          <button
            type="button"
            onClick={playAll}
            className="ml-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#1F7FD8] shadow-md transition hover:scale-105 hover:brightness-100"
            aria-label={`播放${title}`}
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}
      </div>
      {onMore && (
        <button
          type="button"
          onClick={onMore}
          className="flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1.5 text-white/35 transition hover:bg-white/[0.07] hover:text-white/80"
          aria-label={`更多${title}`}
        >
          <ChevronRight className="h-4.5 w-4.5" />
        </button>
      )}
    </div>
  )
}

function BoardState({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-10 text-center">
      <span className="mb-3 text-white/25">{icon}</span>
      <p className="text-sm font-medium text-white/70">{title}</p>
      {hint && <p className="mt-1.5 max-w-md text-xs leading-relaxed text-white/38">{hint}</p>}
      {action}
    </div>
  )
}

/** 歌单条目小行（频道卡下方说明行 / 二级页行） */
function formatCount(n?: number): string {
  const v = Number(n || 0)
  if (!v) return ''
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}亿`
  if (v >= 10_000) return `${(v / 10_000).toFixed(v >= 1_000_000 ? 0 : 1)}万`
  return String(v)
}

// ─────────────────────────── 红心 Radio ───────────────────────────

function HeartRadioCard({
  songs,
  accent,
  exploreCardBg,
  playing,
  refreshing,
  onPlay,
  onSongClick,
  onRefresh,
}: {
  songs: KugouHeartRadioSong[]
  accent: string
  exploreCardBg: string
  playing: boolean
  refreshing?: boolean
  onPlay: () => void
  onSongClick: (song: KugouHeartRadioSong, index: number) => void
  onRefresh?: () => void
}) {
  const first = songs[0]
  if (!first) return null
  return (
    <section data-kugou-discover-radio className="mb-10">
      <div className="flex items-stretch gap-4">
        {/* 主卡：官方红心 Radio 大卡 */}
        <motion.div
          whileHover={{ y: -3 }}
          className="group relative w-[340px] shrink-0 cursor-pointer overflow-hidden rounded-[26px] border border-white/[0.08] p-5"
          style={{ background: 'linear-gradient(150deg, #9AE6F8 0%, #6DB9F8 55%, #7FD0EE 100%)' }}
          onClick={onPlay}
          role="button"
          tabIndex={0}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onPlay() }}
        >
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-1.5 text-[26px] font-bold leading-tight text-[#0B2540]">
                红心
                <Heart className="h-6 w-6 fill-[#F87AA0] text-[#F87AA0]" />
                <span className="text-[22px]">RadiO</span>
              </div>
              <p className="mt-1 max-w-[190px] truncate text-xs font-medium text-[#0B2540]/75">
                {first.recDesc || '根据你的听歌口味推荐'}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-[#0B2540]/60">
                {first.songName} - {first.singerName}
              </p>
            </div>
            {/* 右上角切换按钮：App RadiO⇄ 换一批 */}
            <button
              type="button"
              onClick={event => { event.stopPropagation(); onRefresh?.() }}
              className="shrink-0 rounded-full p-1 text-[#0B2540]/60 transition hover:bg-white/30 hover:text-[#0B2540]"
              aria-label="换一批红心Radio"
              disabled={refreshing}
            >
              {refreshing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Shuffle className="h-5 w-5" />}
            </button>
          </div>
          {/* 底部声纹 + 播放按钮 */}
          <div className="mt-8 flex items-end justify-between">
            <div className="flex h-6 items-end gap-[3px]" aria-hidden>
              {Array.from({ length: 24 }).map((_, i) => (
                <span
                  key={i}
                  className="w-[3px] origin-bottom rounded-full bg-[#0B2540]/35 kg-radio-bar"
                  style={{ height: `${25 + Math.abs(Math.sin(i * 1.7)) * 75}%`, animationDelay: `${(i % 8) * 0.12}s` }}
                />
              ))}
            </div>
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-[#1F7FD8] shadow-lg transition group-hover:scale-105">
              {playing ? <Pause className="h-4.5 w-4.5 fill-current" /> : <Play className="h-4.5 w-4.5 fill-current" />}
            </span>
          </div>
        </motion.div>

        {/* 右侧圆盘队列：官方为后续曲目顺时针圆盘 */}
        <HScroll className="flex-1">
          {songs.slice(1, 7).map((song, index) => (
            <motion.button
              key={`${song.hash}-${index}`}
              type="button"
              whileHover={{ scale: 1.04 }}
              onClick={() => onSongClick(song, index + 1)}
              className="group relative h-full min-h-[168px] w-[168px] shrink-0 overflow-hidden rounded-full border border-white/[0.1]"
              style={{ backgroundColor: exploreCardBg }}
              aria-label={`播放 ${song.songName}`}
            >
              <KgImg src={song.coverUrl} alt={song.songName} className="h-full w-full object-cover" />
              <span className="absolute inset-0 bg-black/25 opacity-0 transition group-hover:opacity-100" />
              <span className="absolute inset-0 flex items-center justify-center opacity-0 transition group-hover:opacity-100">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-white/92 text-[#1F7FD8] shadow-xl">
                  <Play className="h-5 w-5 fill-current" />
                </span>
              </span>
              <span className="absolute inset-x-2 bottom-2 truncate rounded-full bg-black/55 px-2 py-1 text-center text-[10px] text-white/85">
                {song.songName}
              </span>
            </motion.button>
          ))}
        </HScroll>
      </div>
    </section>
  )
}

// ─────────────────────────── 歌曲板块（App 同款：一栏 4 首，左右滑动翻页） ───────────────────────────

/** 官方 App 歌曲行：全宽（封面56px + 歌名/歌手/推荐语 + 右侧红心），竖向排布、无分栏 */
function SongRowCard({
  song,
  index,
  onPlay,
  onPlayAll,
  onToggleLike,
  onContextMenu,
}: {
  song: KugouDiscoverSong
  index: number
  onPlay: () => void
  onPlayAll: () => void
  onToggleLike?: (song: KugouDiscoverSong, next: boolean) => void
  onContextMenu?: (event: React.MouseEvent) => void
}) {
  const rec = [song.recommender ? `${song.recommender} 推荐` : '', song.recInfo].filter(Boolean).join(' - ')
  // 红心乐观态：会话内以「本次点按」为准（发现页歌曲无回查接口；下次进入恢复服务端权威态）
  const [liked, setLiked] = useState(false)
  const hash = String(song.hash || '')
  return (
    <motion.div
      whileHover={{ y: -2 }}
      className="group flex min-w-0 cursor-pointer items-center gap-3.5 rounded-2xl px-2 py-2.5 transition hover:bg-white/[0.045]"
      onClick={onPlayAll}
      onContextMenu={onContextMenu}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onPlayAll() }}
    >
      <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-xl" style={{ backgroundColor: 'rgba(255,255,255,0.05)' }}>
        <KgImg src={song.coverUrl} alt={song.songName} className="h-full w-full object-cover" iconClassName="h-4 w-4" />
        <button
          type="button"
          onClick={event => { event.stopPropagation(); onPlay() }}
          className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100"
          aria-label={`播放 ${song.songName}`}
        >
          <Play className="h-5 w-5 fill-current text-white" />
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium leading-snug text-white/92">{song.songName}</p>
        <p className="mt-0.5 truncate text-[13px] text-white/50">{song.singerName}</p>
        {rec && <p className="mt-1 truncate text-xs leading-relaxed text-white/35">{rec}</p>}
      </div>
      {onToggleLike && hash ? (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            const next = !liked
            setLiked(next)
            onToggleLike(song, next)
          }}
          className="shrink-0 p-1"
          aria-label={liked ? '取消喜欢' : '喜欢'}
        >
          <Heart className={`h-5 w-5 transition ${liked ? 'fill-[#F87AA0] text-[#F87AA0]' : 'text-white/20 hover:fill-[#F87AA0] hover:text-[#F87AA0]'}`} />
        </button>
      ) : null}
    </motion.div>
  )
}

/** 杂志故事大卡（官方 App「小众宝藏佳作 / 喜欢这首歌的TA也喜欢」形态）：
 *  左大封面 + 右侧大字故事标题（推荐语首段）/ 歌名 / 歌手 / 推荐人胶囊；横滑一页一卡 */
function StoryCard({ song, exploreCardBg, onPlay }: { song: KugouDiscoverSong; exploreCardBg?: string; onPlay: () => void }) {
  const rec = [song.recommender ? `${song.recommender} 推荐` : '', song.recInfo].filter(Boolean).join(' - ')
  const headline = String(song.recInfo || song.songName || '').split('\n')[0].slice(0, 14)
  return (
    <motion.div
      whileHover={{ y: -3 }}
      className="group grid cursor-pointer grid-cols-1 overflow-hidden rounded-[22px] border border-white/[0.06] bg-white/[0.03] sm:grid-cols-[minmax(210px,300px)_1fr]"
      onClick={onPlay}
      role="button"
      tabIndex={0}
      onKeyDown={event => { if (event.key === 'Enter') onPlay() }}
    >
      <div className="relative aspect-square sm:aspect-auto sm:h-full sm:min-h-[240px]" style={{ backgroundColor: exploreCardBg || 'rgba(255,255,255,0.04)' }}>
        <KgImg src={song.coverUrl} alt={song.songName} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
        <span className="absolute bottom-3 right-3 flex h-11 w-11 translate-y-2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100">
          <Play className="h-5 w-5 fill-current" />
        </span>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-2 p-6">
        <p className="line-clamp-2 text-[26px] font-extrabold uppercase leading-tight tracking-wide" style={{ color: '#4E7FB0' }}>
          {headline}
        </p>
        <p className="mt-2 truncate text-[15px] font-semibold text-white/90">{song.songName}</p>
        <p className="truncate text-sm text-white/48">{song.singerName}</p>
        {song.recommender && (
          <span className="mt-2 inline-flex max-w-fit items-center gap-1.5 rounded-full bg-white/[0.07] px-2.5 py-1 text-[11px] text-white/45">
            {song.userPic && <img src={resolveKugouCover(song.userPic)} alt="" className="h-4 w-4 rounded-full object-cover" />}
            {song.recommender} 推荐
          </span>
        )}
        {rec && song.recInfo && song.recInfo.length > 14 && (
          <p className="line-clamp-2 text-xs leading-relaxed text-white/33">{rec}</p>
        )}
      </div>
    </motion.div>
  )
}

/** 杂志大卡板块（官方「小众宝藏佳作」形态）：横滑，一卡一故事 */
function MagazineSection({
  section,
  exploreCardBg,
  onPlayTracks,
  onToggleLike,
  onOpenDetail,
}: {
  section: KugouDiscoverSection
  exploreCardBg: string
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
  onOpenDetail: (section: KugouDiscoverSection) => void
}) {
  const songs = section.songs
  if (!songs.length) return null
  const tracks = songs.map(kugouDiscoverSongToTrack)
  return (
    <section data-kugou-discover-section={section.module} className="mb-10">
      <SectionTitle
        title={section.cardTitle || '推荐'}
        playAll={() => onPlayTracks(tracks, 0)}
        onMore={() => onOpenDetail(section)}
      />
      <HScroll ariaLabel={section.cardTitle || '宝藏佳作'}>
        {songs.slice(0, 10).map((song, index) => (
          <div key={`${song.mixSongId || song.hash}-${index}`} className="w-[calc((100%-1.3rem)/1.15)] shrink-0 sm:w-[calc((100%-2.6rem)/2.15)] lg:w-[calc((100%-3.9rem)/3.15)] min-[1900px]:w-[calc((100%-5.2rem)/4.15)]">
            <StoryCard song={song} exploreCardBg={exploreCardBg} onPlay={() => onPlayTracks(tracks, index)} />
          </div>
        ))}
      </HScroll>
    </section>
  )
}

/** 歌曲板块（官方 App 同款）：全宽行竖向列表，一屏 3 行，其余进「>」二级页 */
function SongListSection({
  section,
  onPlayTracks,
  onToggleLike,
  onSongContextMenu,
  onOpenDetail,
}: {
  section: KugouDiscoverSection
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
  onSongContextMenu?: KugouDiscoverHandlers['onSongContextMenu']
  onOpenDetail: (section: KugouDiscoverSection) => void
}) {
  const songs = section.songs
  if (!songs.length) return null
  const tracks = songs.map(kugouDiscoverSongToTrack)
  const playAll = () => onPlayTracks(tracks, 0)
  if (songs.length === 1) {
    return (
      <section data-kugou-discover-section={section.module} className="mb-10">
        <SectionTitle
          title={section.cardTitle || '推荐'}
          subtitle={section.info.songName ? undefined : section.info.labelDesc}
          playAll={playAll}
          onMore={() => onOpenDetail(section)}
        />
        <StoryCard song={songs[0]} onPlay={playAll} />
      </section>
    )
  }
  return (
    <section data-kugou-discover-section={section.module} className="mb-10">
      <SectionTitle
        title={section.cardTitle || '推荐'}
        subtitle={section.info.startDay && section.info.endDay ? undefined : section.info.labelDesc}
        playAll={playAll}
        onMore={() => onOpenDetail(section)}
      />
      <div className="flex flex-col">
        {songs.slice(0, 3).map((song, index) => (
          <SongRowCard
            key={`${song.mixSongId || song.hash}-${index}`}
            song={song}
            index={index}
            onPlay={() => onPlayTracks(tracks, index)}
            onPlayAll={() => onPlayTracks(tracks, index)}
            onToggleLike={onToggleLike}
            onContextMenu={onSongContextMenu ? event => onSongContextMenu(event, song, songs) : undefined}
          />
        ))}
      </div>
    </section>
  )
}

// ─────────────────────────── VIP 专属推荐（大卡双列） ───────────────────────────

function VipSection({
  section,
  accent,
  exploreCardBg,
  onPlayTracks,
  onToggleLike,
  onOpenDetail,
}: {
  section: KugouDiscoverSection
  accent: string
  exploreCardBg: string
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
  onOpenDetail: (section: KugouDiscoverSection) => void
}) {
  const songs = section.songs
  const [vipLiked, setVipLiked] = useState<Record<number, boolean>>({})
  if (!songs.length) return null
  const tracks = songs.map(kugouDiscoverSongToTrack)
  return (
    <section data-kugou-discover-section="vip" className="mb-10">
      <SectionTitle title={section.cardTitle || 'VIP专属推荐'} playAll={() => onPlayTracks(tracks, 0)} onMore={() => onOpenDetail(section)} />
      <HScroll ariaLabel={section.cardTitle || 'VIP专属推荐'}>
        {songs.slice(0, 10).map((song, index) => {
          const rec = song.recInfo ? String(song.recInfo) : ''
          return (
            <motion.div
              key={`${song.mixSongId || song.hash}-${index}`}
              whileHover={{ y: -4 }}
              className="group w-[calc((100%-2.5rem)/2.2)] shrink-0 cursor-pointer overflow-hidden rounded-[18px] border border-white/[0.06] p-4 sm:w-[calc((100%-3.75rem)/3.2)] lg:w-[calc((100%-5rem)/4.2)] min-[1900px]:w-[calc((100%-6.25rem)/5.2)]"
              style={{ background: 'linear-gradient(160deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))' }}
              onClick={() => onPlayTracks(tracks, index)}
              role="button"
              tabIndex={0}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onPlayTracks(tracks, index) }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-white/90">{song.songName}</p>
                  <p className="mt-1 truncate text-xs text-white/48">{song.singerName}</p>
                </div>
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    const next = !vipLiked[index]
                    setVipLiked(prev => ({ ...prev, [index]: next }))
                    void likeKugouSong(
                      { hash: song.hash, mid: song.hash, name: song.songName, artists: [{ name: song.singerName }], album: song.albumId ? { id: song.albumId } : undefined },
                      next,
                    )
                  }}
                  className="shrink-0 p-1"
                  aria-label={vipLiked[index] ? '取消喜欢' : '喜欢'}
                >
                  <Heart className={`h-4.5 w-4.5 transition ${vipLiked[index] ? 'fill-[#F87AA0] text-[#F87AA0]' : 'text-white/22 hover:fill-[#F87AA0] hover:text-[#F87AA0]'}`} />
                </button>
              </div>
              {/* 官方同款拍立得相纸：白色相框叠一张偏移底纸 */}
              <div className="relative mt-4 aspect-square">
                <span className="absolute left-3 top-4 h-full w-[88%] rounded-[10px] bg-black/[0.14]" aria-hidden />
                <div className="relative h-full w-[92%] overflow-hidden rounded-[10px] bg-white p-[3%] pb-[10%] shadow-md">
                  <div className="relative h-full w-full overflow-hidden rounded-[6px]" style={{ backgroundColor: exploreCardBg }}>
                    <KgImg src={song.coverUrl} alt={song.songName} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                    <span className="absolute left-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold text-[#FFD27A] backdrop-blur">VIP</span>
                  </div>
                </div>
              </div>
              {rec && <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-white/40">{rec}</p>}
              {song.recommender && (
                <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-white/33">
                  {song.userPic && <img src={resolveKugouCover(song.userPic)} alt="" className="h-4 w-4 rounded-full object-cover" />}
                  {song.recommender} 推荐
                </p>
              )}
            </motion.div>
          )
        })}
      </HScroll>
    </section>
  )
}

// ─────────────────────────── 曲风盲盒 · 随机心动 ───────────────────────────

function StyleBlindboxSection({
  tags,
  accent,
  exploreCardBg,
  onPlayTracks,
  onToggleLike,
  onRefresh,
  refreshing,
}: {
  tags: KugouDiscoverStyleTag[]
  accent: string
  exploreCardBg: string
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
  onRefresh: () => void
  refreshing: boolean
}) {
  if (!tags.length) return null
  return (
    <section data-kugou-discover-section="style" className="mb-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h3 className="text-lg font-semibold tracking-tight text-white md:text-xl">曲风盲盒·随机心动</h3>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-1.5 rounded-full border border-white/[0.1] bg-white/[0.055] px-3.5 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          换一批
        </button>
      </div>
      <HScroll>
        {tags.map((tag, tagIndex) => (
          <motion.div
            key={`${tag.labelName}-${tagIndex}`}
            whileHover={{ y: -4 }}
            className="group w-[440px] shrink-0 cursor-pointer overflow-hidden rounded-[20px] border border-white/[0.06]"
            style={{ background: tag.labelColor ? `linear-gradient(150deg, ${tag.labelColor}38, rgba(255,255,255,0.025))` : 'rgba(255,255,255,0.035)' }}
            onClick={() => tag.songs.length && onPlayTracks(tag.songs.map(kugouDiscoverSongToTrack), 0)}
            role="button"
            tabIndex={0}
            onKeyDown={event => { if (event.key === 'Enter' && tag.songs.length) onPlayTracks(tag.songs.map(kugouDiscoverSongToTrack), 0) }}
          >
            <div className="flex gap-4 p-5 pb-3">
              <div className="relative h-[150px] w-[150px] shrink-0 overflow-hidden rounded-[14px] bg-white/90 p-1.5 shadow-md" style={{ backgroundColor: exploreCardBg }}>
                <div className="h-full w-full overflow-hidden rounded-[10px]">
                  <KgImg src={tag.topCoverUrl || tag.coverUrl || tag.songs[0]?.coverUrl} alt={tag.labelName} className="h-full w-full object-cover" />
                </div>
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <p className="text-[22px] font-bold leading-tight" style={{ color: tag.labelColor || '#ffffff' }}>{tag.labelName}</p>
                <div className="mt-2 min-w-0 flex-1 space-y-2.5">
                  {tag.songs.slice(0, 3).map((song, i) => (
                    <p key={`${song.mixSongId || i}`} className="truncate text-[13px] text-white/78">
                      {song.songName} - {song.singerName}
                    </p>
                  ))}
                </div>
              </div>
            </div>
            {/* 官方同款底部条：desc + 圆形播放按钮 */}
            <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] bg-black/[0.12] px-5 py-3">
              <p className="min-w-0 truncate text-xs text-white/52">{tag.labelDesc || tag.labelName}</p>
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/22 text-white transition group-hover:bg-white group-hover:text-black">
                <Play className="h-3.5 w-3.5 fill-current" />
              </span>
            </div>
          </motion.div>
        ))}
      </HScroll>
    </section>
  )
}

// ─────────────────────────── 频道推荐（大卡） ───────────────────────────

function ChannelSection({
  channels,
  exploreCardBg,
  onOpenChannel,
  onOpenWaterfall,
}: {
  channels: KugouDiscoverChannel[]
  exploreCardBg: string
  onOpenChannel?: KugouDiscoverHandlers['onOpenChannel']
  onOpenWaterfall: () => void
}) {
  if (!channels.length) return null
  return (
    <section data-kugou-discover-section="channel" className="mb-10">
      <SectionTitle title="频道推荐" onMore={onOpenWaterfall} />
      <HScroll>
        {channels.slice(0, 9).map((channel, index) => (
          <motion.div
            key={`${channel.globalCollectionId || channel.userid || channel.name}-${index}`}
            whileHover={{ y: -4 }}
            className="group w-[300px] shrink-0 cursor-pointer"
            onClick={() => onOpenChannel?.({ id: channel.globalCollectionId || channel.userid || '', name: channel.name })}
            role="button"
            tabIndex={0}
            onKeyDown={event => { if (event.key === 'Enter') onOpenChannel?.({ id: channel.globalCollectionId || channel.userid || '', name: channel.name }) }}
          >
            <div className="relative aspect-[3/4] overflow-hidden rounded-[18px] border border-white/[0.08]" style={{ backgroundColor: exploreCardBg }}>
              <KgImg src={channel.pic} alt={channel.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
              <span className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-black/20" />
              <span className="absolute left-3 top-3 text-[15px] font-extrabold tracking-wide text-white drop-shadow">CHANNEL-K</span>
              <span className="absolute inset-x-3 bottom-3 flex items-end justify-between gap-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-white">{channel.name}</span>
                  <span className="mt-0.5 block text-[11px] text-white/62">{formatCount(channel.subscribeCount)}订阅</span>
                </span>
                <span className="shrink-0 rounded-full bg-white/22 px-3 py-1 text-[11px] text-white backdrop-blur transition group-hover:bg-white group-hover:text-black">订阅</span>
              </span>
            </div>
            {channel.intro && <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-white/38">{channel.intro}</p>}
          </motion.div>
        ))}
      </HScroll>
    </section>
  )
}

// ─────────────────────────── 喜欢「标签」的TA也喜欢（大图卡） ───────────────────────────

function TagSection({
  section,
  exploreCardBg,
  onPlayTracks,
  onToggleLike,
  onOpenDetail,
}: {
  section: KugouDiscoverSection
  exploreCardBg: string
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
  onOpenDetail: (section: KugouDiscoverSection) => void
}) {
  const songs = section.songs
  if (!songs.length || !section.info.labelName) return null
  const tracks = songs.map(kugouDiscoverSongToTrack)
  return (
    <section data-kugou-discover-section="tag" className="mb-10">
      {/* 官方 App 同款上标：标签卡顶部的分组小字（App 端为 Beta 分组文案） */}
      <p className="mb-1.5 text-xs text-white/32">宝藏音乐故事·为你推荐</p>
      <SectionTitle
        title={`喜欢「${section.info.labelName}」的TA也喜欢`}
        playAll={() => onPlayTracks(tracks, 0)}
        onMore={() => onOpenDetail(section)}
      />
      <motion.div
        whileHover={{ y: -3 }}
        className="group grid cursor-pointer grid-cols-1 gap-5 rounded-[24px] border border-white/[0.07] bg-white/[0.03] p-5 sm:grid-cols-[300px_1fr] xl:grid-cols-[380px_1fr]"
        onClick={() => onPlayTracks(tracks, 0)}
        role="button"
        tabIndex={0}
        onKeyDown={event => { if (event.key === 'Enter') onPlayTracks(tracks, 0) }}
      >
        <div className="relative aspect-square overflow-hidden rounded-[18px]" style={{ backgroundColor: exploreCardBg }}>
          <KgImg src={section.info.coverPic || songs[0]?.coverUrl} alt={section.info.labelName} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
          <span className="absolute bottom-2.5 right-2.5 flex h-10 w-10 translate-y-2 items-center justify-center rounded-full bg-white text-black opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100">
            <Play className="h-4.5 w-4.5 fill-current" />
          </span>
        </div>
        <div className="min-w-0 flex flex-col justify-center">
          <p className="text-[22px] font-bold leading-tight" style={{ color: section.info.labelColor || '#7FB2E8' }}>{section.info.labelName}</p>
          {section.info.labelDesc && <p className="mt-2 text-sm font-medium text-white/55">{section.info.labelDesc}</p>}
          <div className="mt-4 space-y-3">
            {songs.slice(0, 3).map((song, i) => (
              <div key={`${song.mixSongId || i}`} className="min-w-0">
                <p className="truncate text-[15px] font-medium text-white/90">{song.songName}</p>
                <p className="mt-0.5 truncate text-xs text-white/42">{song.singerName}</p>
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  )
}

// ─────────────────────────── 二级聚合页（板块「>」详情） ───────────────────────────

function DetailOverlay({
  section,
  accent,
  exploreCardBg,
  onClose,
  onPlayTracks,
  onToggleLike,
}: {
  section: KugouDiscoverSection
  accent: string
  exploreCardBg: string
  onClose: () => void
  onPlayTracks: KugouDiscoverHandlers['onPlayTracks']
  onToggleLike?: KugouDiscoverHandlers['onToggleLike']
}) {
  const tracks = useMemo(() => section.songs.map(kugouDiscoverSongToTrack), [section])
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    if (!query.trim()) return section.songs
    const q = query.trim().toLowerCase()
    return section.songs.filter(song =>
      song.songName.toLowerCase().includes(q) || song.singerName.toLowerCase().includes(q) || (song.recommender || '').toLowerCase().includes(q),
    )
  }, [section.songs, query])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex flex-col" data-kugou-discover-detail>
      {/* 官方同款浅蓝头部 */}
      <div className="relative shrink-0 px-6 pb-16 pt-5" style={{ background: 'linear-gradient(180deg, #6FC4F2 0%, #8ED2F5 100%)' }}>
        <button
          type="button"
          onClick={onClose}
          className="absolute left-5 top-5 flex h-9 w-9 items-center justify-center rounded-full text-[#0B2540] transition hover:bg-white/25"
          aria-label="返回"
        >
          <ChevronRight className="h-6 w-6 rotate-180" />
        </button>
        <h2 className="truncate text-center text-lg font-bold text-[#0B2540]">{section.cardTitle || '推荐歌曲'}</h2>
        {section.info.labelDesc && <p className="mt-0.5 truncate text-center text-xs text-[#0B2540]/65">{section.info.labelDesc}</p>}
      </div>
      <div className="relative -mt-10 flex-1 overflow-hidden rounded-t-[26px] bg-[#0B1119]">
        <div className="flex h-full flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
            <button
              type="button"
              onClick={() => tracks.length && onPlayTracks(tracks, 0)}
              className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-[#081017] transition hover:brightness-110"
              style={{ background: 'linear-gradient(135deg, #2FD2F6, #4C8DFF)' }}
            >
              <Play className="h-4 w-4 fill-current" /> 播放全部 ({section.songs.length})
            </button>
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索本页歌曲 / 推荐人"
              className="w-56 rounded-full border border-white/[0.1] bg-white/[0.05] px-4 py-1.5 text-xs text-white/80 outline-none transition placeholder:text-white/28 focus:border-white/25"
            />
          </div>
          <div className="mt-3 flex-1 overflow-y-auto px-4 pb-8">
            {filtered.map((song, index) => {
              const rec = [song.recommender ? `${song.recommender} 推荐` : '', song.recInfo].filter(Boolean).join(' - ')
              return (
                <div
                  key={`${song.mixSongId || song.hash}-${index}`}
                  className="group flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-white/[0.05]"
                  onClick={() => onPlayTracks(tracks, section.songs.indexOf(song))}
                >
                  <span className="w-7 shrink-0 text-center text-xs text-white/25">{String(index + 1).padStart(2, '0')}</span>
                  <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl" style={{ backgroundColor: exploreCardBg }}>
                    <KgImg src={song.coverUrl} alt={song.songName} className="h-full w-full object-cover" iconClassName="h-4 w-4" />
                    <span className="absolute inset-0 flex items-center justify-center bg-black/30 opacity-0 transition group-hover:opacity-100">
                      <Play className="h-4 w-4 fill-current text-white" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-white/88">{song.songName} - {song.singerName}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-white/38">{rec}</span>
                  </span>
                  <Heart className="h-4 w-4 shrink-0 text-white/20 transition group-hover:text-white/50" />
                  <ListPlus className="h-4 w-4 shrink-0 text-white/20 transition group-hover:text-white/50" />
                </div>
              )
            })}
            {filtered.length === 0 && (
              <p className="py-16 text-center text-sm text-white/38">没有匹配的歌曲</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── 频道页（瀑布流 + 页签） ───────────────────────────

const WATERFALL_TAB_LABELS: Record<string, string> = {
  week_rank: '', // 周榜是榜单页签，发现页内以「推荐」流兜底
}

function ChannelWaterfallOverlay({
  exploreCardBg,
  onClose,
  onOpenChannel,
  onOpenSearch,
}: {
  exploreCardBg: string
  onClose: () => void
  onOpenChannel?: KugouDiscoverHandlers['onOpenChannel']
  onOpenSearch?: KugouDiscoverHandlers['onOpenSearch']
}) {
  const [tabs, setTabs] = useState<KugouChannelTab[]>([])
  const [activeLabel, setActiveLabel] = useState('')
  const [channels, setChannels] = useState<KugouWaterfallChannel[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [isEnd, setIsEnd] = useState(false)
  const [error, setError] = useState('')
  const biIndexRef = useRef(0)

  const load = useCallback(async (label: string, reset: boolean) => {
    if (reset) {
      setLoading(true)
      setError('')
      biIndexRef.current = 0
    } else {
      setLoadingMore(true)
    }
    try {
      const result = await fetchKugouDiscoverWaterfall(reset ? 0 : biIndexRef.current + 45, label)
      biIndexRef.current = reset ? 0 : biIndexRef.current + 45
      setChannels(prev => {
        if (!reset) {
          const seen = new Set(prev.map(c => c.name))
          return [...prev, ...result.channels.filter(c => !seen.has(c.name))]
        }
        return result.channels
      })
      setIsEnd(result.isEnd)
    } catch (e) {
      if (reset) setError(e instanceof Error ? e.message : '频道加载失败')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await fetchKugouDiscoverChannelTabs()
        setTabs(rows)
      } catch { /* 页签失败不阻塞推荐流 */ }
      void load('', true)
    })()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[70] flex flex-col" data-kugou-discover-channel-page>
      <div className="relative shrink-0 px-6 pb-14 pt-5" style={{ background: 'linear-gradient(180deg, #6FC4F2 0%, #8ED2F5 100%)' }}>
        <button
          type="button"
          onClick={onClose}
          className="absolute left-5 top-5 flex h-9 w-9 items-center justify-center rounded-full text-[#0B2540] transition hover:bg-white/25"
          aria-label="返回"
        >
          <ChevronRight className="h-6 w-6 rotate-180" />
        </button>
        <h2 className="truncate text-center text-lg font-bold text-[#0B2540]">频道</h2>
      </div>
      <div className="relative -mt-8 flex-1 overflow-hidden rounded-t-[26px] bg-[#0B1119]">
        <div className="flex h-full flex-col">
          {/* 页签行（官方：我的/推荐/周榜/次元/AI/放松/私藏/学习/国风/流行） */}
          <div className="flex items-center gap-1 overflow-x-auto px-4 pt-4 pb-1" data-kugou-channel-tabs>
            <button
              type="button"
              onClick={() => { setActiveLabel(''); void load('', true) }}
              className={`shrink-0 rounded-full px-4 py-1.5 text-sm transition ${activeLabel === '' ? 'font-semibold text-[#081017]' : 'text-white/48 hover:bg-white/[0.07] hover:text-white/85'}`}
              style={activeLabel === '' ? { background: 'linear-gradient(135deg, #2FD2F6, #4C8DFF)' } : undefined}
            >
              推荐
            </button>
            {tabs.map(tab => {
              // 周榜（week_rank）/AI（ai_tab）没有瀑布流数据源，先不渲染入口
              if (tab.dataType === 'week_rank' || tab.dataType === 'ai_tab') return null
              return (
                <button
                  key={`${tab.tabId}-${tab.tabName}`}
                  type="button"
                  onClick={() => { setActiveLabel(tab.tabName); void load(tab.tabName, true) }}
                  className={`shrink-0 rounded-full px-4 py-1.5 text-sm transition ${activeLabel === tab.tabName ? 'font-semibold text-[#081017]' : 'text-white/48 hover:bg-white/[0.07] hover:text-white/85'}`}
                  style={activeLabel === tab.tabName ? { background: 'linear-gradient(135deg, #2FD2F6, #4C8DFF)' } : undefined}
                >
                  {tab.tabName}
                </button>
              )
            })}
          </div>
          {/* 瀑布流 */}
          <div className="flex-1 overflow-y-auto px-4 pb-10 pt-2" onScroll={event => {
            const el = event.currentTarget
            if (!loadingMore && !isEnd && !loading && el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
              void load(activeLabel, false)
            }
          }}>
            {loading ? (
              <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-white/50">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在加载频道…
              </div>
            ) : error ? (
              <BoardState
                icon={<Radio className="h-6 w-6" />}
                title="频道加载失败"
                hint={error}
                action={(
                  <button type="button" onClick={() => void load(activeLabel, true)} className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]" style={{ background: 'linear-gradient(135deg, #2FD2F6, #4C8DFF)' }}>
                    <RefreshCw className="h-3.5 w-3.5" /> 重试
                  </button>
                )}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-3 xl:grid-cols-4 min-[1900px]:grid-cols-5 min-[2400px]:grid-cols-6">
                  {channels.map((channel, index) => (
                    <motion.div
                      key={`${channel.globalCollectionId || channel.name}-${index}`}
                      whileHover={{ y: -4 }}
                      className="group cursor-pointer"
                      onClick={() => onOpenChannel?.({ id: channel.globalCollectionId || '', name: channel.name })}
                      role="button"
                      tabIndex={0}
                      onKeyDown={event => { if (event.key === 'Enter') onOpenChannel?.({ id: channel.globalCollectionId || '', name: channel.name }) }}
                    >
                      <div className="relative aspect-[3/4] overflow-hidden rounded-[16px] border border-white/[0.07]" style={{ backgroundColor: exploreCardBg }}>
                        <KgImg src={channel.pic} alt={channel.name} className="h-full w-full object-cover" />
                        <span className="absolute right-2 top-2 rounded-full bg-black/45 px-2.5 py-1 text-[11px] text-white/85 backdrop-blur transition group-hover:bg-white group-hover:text-black">+ 订阅</span>
                        {channel.members && channel.members.length > 0 && (
                          <span className="absolute bottom-2 left-2 flex -space-x-2">
                            {channel.members.map((m, mi) => (
                              <span key={`${m.nickName}-${mi}`} className="h-6 w-6 overflow-hidden rounded-full border border-white/60">
                                <KgImg src={m.userPic} alt={m.nickName} className="h-full w-full object-cover" iconClassName="h-3 w-3" />
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="absolute bottom-2 right-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/85">
                          {formatCount(channel.subscribeCount)}订阅
                        </span>
                      </div>
                      <p className="mt-2 truncate text-sm font-medium text-white/86">{channel.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/36">{channel.intro || (channel.tags || []).map(t => t.name).join(' / ')}</p>
                    </motion.div>
                  ))}
                </div>
                {loadingMore && (
                  <div className="flex items-center justify-center gap-2 py-6 text-sm text-white/45">
                    <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
                  </div>
                )}
                {isEnd && channels.length > 0 && (
                  <p className="py-6 text-center text-xs text-white/28">已经到底啦</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────── 主板块 ───────────────────────────

/** pxy 卡片流每批板块的翻页节奏：与抓包时序一致（每页 3 板块），滚动到底即取下一页 */
export default function KugouDiscoverBoard({ accent, accentRgb, exploreCardBg, loggedIn, onPlayTracks, onOpenChannel, onOpenSearch, onToggleLike, onSongContextMenu }: KugouDiscoverBoardProps) {
  const [sections, setSections] = useState<KugouDiscoverSection[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [isEnd, setIsEnd] = useState(false)
  const [radioSongs, setRadioSongs] = useState<KugouHeartRadioSong[]>([])
  const [radioError, setRadioError] = useState('')
  const [radioRefreshing, setRadioRefreshing] = useState(false)
  const [detail, setDetail] = useState<KugouDiscoverSection | null>(null)
  const [channelPage, setChannelPage] = useState(false)
  const [blindboxTags, setBlindboxTags] = useState<KugouDiscoverStyleTag[]>([])
  const [blindboxRefreshing, setBlindboxRefreshing] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const loadRadio = useCallback(async (flush = false) => {
    const result = await fetchKugouHeartRadioSongs(8, flush)
    if (flush && result.songs.length) {
      setRadioSongs(result.songs)
    } else if (!radioSongs.length || !flush) {
      setRadioSongs(result.songs)
    }
    setRadioError(result.error || '')
  }, [radioSongs.length])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      setError('')
      try {
        const first = await fetchKugouDiscoverSections(1)
        setSections(first)
        setPage(1)
        setIsEnd(first.length === 0)
      } catch (e) {
        setError(e instanceof Error ? e.message : '发现页加载失败')
      } finally {
        setLoading(false)
      }
      void loadRadio()
    })()
  }, [loadRadio])

  // 曲风盲盒板块到达后抽取 tags（板块流里自带第一批；换一批走 blindbox 接口）
  const styleTagsFromStream = useMemo(
    () => sections.filter(s => s.module === 'y_style').flatMap(s => s.styleTags),
    [sections],
  )
  useEffect(() => {
    if (!blindboxTags.length && styleTagsFromStream.length) setBlindboxTags(styleTagsFromStream)
  }, [styleTagsFromStream, blindboxTags.length])

  const refreshBlindbox = useCallback(async () => {
    setBlindboxRefreshing(true)
    try {
      const next = await fetchKugouDiscoverBlindbox()
      if (next.length) setBlindboxTags(next)
    } catch { /* 静默：换一批失败保留当前 */ }
    setBlindboxRefreshing(false)
  }, [])

  // 滚动加载下一批卡片
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || typeof IntersectionObserver !== 'function') return
    const io = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting || loading || loadingMore || isEnd) return
      void (async () => {
        setLoadingMore(true)
        try {
          const next = await fetchKugouDiscoverSections(page + 1)
          if (!next.length) { setIsEnd(true) } else {
            setPage(p => p + 1)
            setSections(prev => [...prev, ...next])
          }
        } catch { setIsEnd(true) }
        setLoadingMore(false)
      })()
    }, { rootMargin: '800px' })
    io.observe(el)
    return () => io.disconnect()
  }, [page, loading, loadingMore, isEnd])

  // 曲风盲盒板块不在卡片流首两批时补拉
  useEffect(() => {
    if (loading || isEnd) return
    if (!sections.some(s => s.module === 'y_style')) {
      void refreshBlindbox()
    } else if (!blindboxTags.length && styleTagsFromStream.length) {
      setBlindboxTags(styleTagsFromStream)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, isEnd])

  const playRadio = useCallback(() => {
    if (!radioSongs.length) return
    onPlayTracks(radioSongs.map(s => ({
      hash: s.hash,
      songName: s.songName,
      singerName: s.singerName,
      albumId: s.albumId,
      albumAudioId: s.albumAudioId,
      coverUrl: s.coverUrl,
      duration: s.duration,
    })), 0)
  }, [radioSongs, onPlayTracks])

  const playRadioAt = useCallback((song: KugouHeartRadioSong, index: number) => {
    const list = radioSongs.map(s => ({
      hash: s.hash,
      songName: s.songName,
      singerName: s.singerName,
      albumId: s.albumId,
      albumAudioId: s.albumAudioId,
      coverUrl: s.coverUrl,
      duration: s.duration,
    }))
    onPlayTracks(list, index)
  }, [radioSongs, onPlayTracks])

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center gap-2 rounded-[24px] border border-white/[0.07] bg-white/[0.03] text-sm text-white/50">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在加载酷狗发现页…
      </div>
    )
  }
  if (error && !sections.length) {
    return (
      <BoardState
        icon={<Sparkles className="h-6 w-6" />}
        title="发现页加载失败"
        hint={error}
        action={(
          <button
            type="button"
            onClick={() => { setSections([]); setPage(1); setIsEnd(false); void loadRadio() }}
            className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]"
            style={{ background: accent }}
          >
            <RefreshCw className="h-3.5 w-3.5" /> 重试
          </button>
        )}
      />
    )
  }

  const onOpenDetail = (section: KugouDiscoverSection) => setDetail(section)

  return (
    <div data-kugou-discover-root className="pb-16">
      {/* 红心 Radio 顶部 */}
      {radioSongs.length > 0 ? (
        <HeartRadioCard
          songs={radioSongs}
          accent={accent}
          exploreCardBg={exploreCardBg}
          playing={false}
          refreshing={radioRefreshing}
          onPlay={playRadio}
          onSongClick={playRadioAt}
          onRefresh={() => {
            if (radioRefreshing) return
            setRadioRefreshing(true)
            void loadRadio(true).finally(() => setRadioRefreshing(false))
          }}
        />
      ) : (
        <div className="mb-10">
          <BoardState
            icon={<Radio className="h-6 w-6" />}
            title={radioError || '红心Radio需要登录酷狗概念版'}
            hint={loggedIn ? '当前账号暂无红心Radio推荐' : '登录后根据你的听歌口味推荐'}
            action={null}
          />
        </div>
      )}

      {/* 卡片流：按官方板块顺序渲染 */}
      {sections.map((section, index) => {
        const key = `${section.module}-${index}`
        if (section.module === 'y_song_module_6') {
          return <VipSection key={key} section={section} accent={accent} exploreCardBg={exploreCardBg} onPlayTracks={onPlayTracks} onToggleLike={onToggleLike} onOpenDetail={onOpenDetail} />
        }
        if (section.module === 'y_song_module_4') {
          return <MagazineSection key={key} section={section} exploreCardBg={exploreCardBg} onPlayTracks={onPlayTracks} onToggleLike={onToggleLike} onOpenDetail={onOpenDetail} />
        }
        if (section.module === 'y_channel') {
          return <ChannelSection key={key} channels={section.channels} exploreCardBg={exploreCardBg} onOpenChannel={onOpenChannel} onOpenWaterfall={() => setChannelPage(true)} />
        }
        if (section.module === 'y_tag') {
          return <TagSection key={key} section={section} exploreCardBg={exploreCardBg} onPlayTracks={onPlayTracks} onToggleLike={onToggleLike} onOpenDetail={onOpenDetail} />
        }
        if (section.songs.length) {
          return <SongListSection key={key} section={section} onPlayTracks={onPlayTracks} onToggleLike={onToggleLike} onSongContextMenu={onSongContextMenu} onOpenDetail={onOpenDetail} />
        }
        return null
      })}

      {/* 曲风盲盒（有 tags 才渲染；换一批独立刷新） */}
      <StyleBlindboxSection
        tags={blindboxTags}
        accent={accent}
        exploreCardBg={exploreCardBg}
        onPlayTracks={onPlayTracks}
        onRefresh={() => void refreshBlindbox()}
        refreshing={blindboxRefreshing}
      />

      {/* 滚动加载哨兵 */}
      <div ref={sentinelRef} className="h-px" />
      {loadingMore && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-white/45">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载更多推荐…
        </div>
      )}
      {!loadingMore && !isEnd && sections.length > 0 && (
        <div className="flex items-center justify-center gap-1.5 py-6 text-xs text-white/28">
          下拉继续刷新
          <ChevronRight className="h-3.5 w-3.5 -rotate-90" />
        </div>
      )}
      {isEnd && sections.length > 0 && (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-white/28">
          已经到底啦 · 共 {sections.length} 个板块
        </div>
      )}

      {/* 二级页 */}
      {detail && (
        <DetailOverlay
          section={detail}
          accent={accent}
          exploreCardBg={exploreCardBg}
          onClose={() => setDetail(null)}
          onPlayTracks={onPlayTracks}
        />
      )}
      {channelPage && (
        <ChannelWaterfallOverlay
          exploreCardBg={exploreCardBg}
          onClose={() => setChannelPage(false)}
          onOpenChannel={onOpenChannel}
          onOpenSearch={onOpenSearch}
        />
      )}
    </div>
  )
}
