// 汽水音乐 PC 客户端「推荐」页复刻 —— 客户端默认落地页（hash 路由 /player-feed）。
//
// 版式取自客户端 PlayerBoxAudioFrame / PlayerBoxAudioInfo / PlayerBoxAction 的 SCSS：
//   外层 flex + padding 0 50px + gap 50px；
//   左列 width min(40vh,30vw) / max-width 40vh；封面 aspect-ratio 1 / radius 8px / 阴影 0 32px 64px rgba(0,0,0,.1)；
//   信息行 margin-top 32px / gap 12px；歌名 20px · 500；演唱者 14px · 500 · 白 60%；
//   「关注」胶囊 40x20 / 12px / 圆角 100px / 底色 white 10%；
//   右侧操作列 gap 17px / 高 50px，图标下数字 10px · 500 · 白 70%；
//   歌词列 flex-1 / max-width 500 / min-width 300 / width 30vw。
//
// 未在播放时给的是客户端的占位底色 + 一个「播放推荐」入口（客户端此时会自动拉推荐流）；
// 播放/收藏/评论一律回传 TraditionalView 的既有链路，本组件不自造播放。
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Heart, ListMusic, MessageSquare, Pause, Play, Waves } from 'lucide-react'
import type { LyricLine, Song } from '../../services/musicApi'
import { getProxiedImageUrl } from '../../services/musicApi'
import { fetchSodaMediaStats } from '../../services/sodaService'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'
import { pcCount, type PcTone } from './pcKit'
import { isCrossFilled, useCrossFillVersion } from '../../services/crossFillRegistry'

export interface SodaPcPlayerFeedStats {
  countComment?: number
  countCollected?: number
}

export interface SodaPcPlayerFeedProps {
  tone: PcTone
  accent: string
  /** 当前播放歌曲所属的专辑主色（客户端整页背景取它） */
  dominantColor?: string
  song: Song | null
  isPlaying: boolean
  liked: boolean
  onToggleFavorite?: () => void
  lyrics: LyricLine[]
  playbackTimeStore: PlaybackTimeStore
  /** 歌曲统计（评论数/收藏数）；缺省时组件自己按 song.mid 拉 /api/soda/media/stats */
  stats?: SodaPcPlayerFeedStats | null
  isVipOnly?: boolean
  onOpenComments: (song: Song) => void
  onOpenArtist?: (artistId: string, platform?: 'soda', artistName?: string) => void
  onPlayPause: () => void
  /** 拖动歌词行回跳播放位置（传统模式既有 seek 链路） */
  onSeek?: (time: number) => void
  /** 没有在播时：拉推荐流并开始播放（客户端进页面即自动播放推荐流） */
  onStartFeed: () => void
  feedLoading?: boolean
  feedCount?: number
  /** 打开右侧队列面板（waveforge 第三栏的入口） */
  onOpenQueue?: () => void
}

/** 客户端「纯音乐，请欣赏」这类无歌词占位 */
const NO_LYRIC_TEXT = '纯音乐，请欣赏'

/** 当前歌词行索引（与客户端 LyricsView 同一判定：取最后一个 time <= 播放位置的行） */
function currentLyricIndex(lyrics: LyricLine[], time: number): number {
  let index = -1
  for (let i = 0; i < lyrics.length; i += 1) {
    const t = lyrics[i]?.time
    if (typeof t !== 'number') continue
    if (t <= time) index = i
    else break
  }
  return index
}

/**
 * 活动行的逐字扫描。
 *
 * 客户端 LyricsView 的做法：整行套一个两段渐变 + `background-clip: text`，
 * 再用 `background-position-x` 把「已唱 / 未唱」的分界线扫过去。
 * 这里把同一手法**下沉到单字**：每个字一个 span，各自带 `linear-gradient(dim 50%, bright 50%)`
 * + `background-size: 200%`，用 `background-position-x: ratio%` 在字内平滑推进。
 * 好处是换行由浏览器自然处理（客户端要拿 canvas 量宽度自己断行），
 * 观感一致而实现简单得多。
 *
 * 性能：只有活动行会每帧改样式，且是直接写 DOM（不走 React setState），
 * 整列表不会因此重渲染。
 */
const ActiveLyricLine = memo(function ActiveLyricLine({
  line,
  playbackTimeStore,
  bright,
  dim,
}: {
  line: LyricLine
  playbackTimeStore: PlaybackTimeStore
  bright: string
  dim: string
}) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  // 逐字时间轴：有 words 用上游给的，没有就退化成「整行一次性点亮」（客户端对 LRC 也是这个行为）
  const timeline = useMemo(() => {
    const words = Array.isArray(line.words) ? line.words : []
    if (!words.length) return [] as Array<{ ch: string; startMs: number; durationMs: number }>
    return words.flatMap(word => {
      const text = String(word?.word ?? '')
      const chars = Array.from(text)
      if (!chars.length) return []
      const startMs = Number(word?.startTime) || 0
      const perChar = (Number(word?.duration) || 0) / chars.length
      return chars.map((ch, i) => ({ ch, startMs: startMs + perChar * i, durationMs: perChar }))
    })
  }, [line])

  useEffect(() => {
    const root = wrapRef.current
    if (!root) return
    const spans = Array.from(root.querySelectorAll<HTMLSpanElement>('span[data-ci]'))
    if (!spans.length) return
    const lineStartMs = (Number(line.time) || 0) * 1000
    // 逐字平滑：上游快照约 4Hz（一格一格跳），客户端是 rAF 里线性外推（useInterpolatedProgressSeconds）。
    // 这里同款：subscribe 收到新快照时对齐基准，rAF 里按 delta 推进；暂停/无快照推进时也按墙钟画，
    // 保证任何时刻扫线都连续。
    let baseSeconds = playbackTimeStore.getSnapshot().currentTime
    let baseAt = performance.now()
    let rafId = 0
    let playing = playbackTimeStore.getSnapshot().isPlaying
    const unsubscribe = playbackTimeStore.subscribe(() => {
      const snap = playbackTimeStore.getSnapshot()
      // 小幅回退（<0.5s，时钟漂移）直接忽略；真 seek 立即对齐（客户端同款保护）
      if (snap.currentTime < baseSeconds && baseSeconds - snap.currentTime < 0.5) return
      baseSeconds = snap.currentTime
      baseAt = performance.now()
      playing = snap.isPlaying
      paint()
    })
    const paint = () => {
      const elapsed = playing ? (performance.now() - baseAt) / 1000 : 0
      const nowSeconds = baseSeconds + elapsed
      const localMs = nowSeconds * 1000 - lineStartMs
      for (let i = 0; i < timeline.length; i += 1) {
        const span = spans[i]
        if (!span) continue
        const char = timeline[i]
        const ratio = char.durationMs > 0
          ? Math.min(1, Math.max(0, (localMs - char.startMs) / char.durationMs))
          : (localMs >= char.startMs ? 1 : 0)
        // 0% → 渐变前半（dim），100% → 后半（bright）
        const next = `${(ratio * 100).toFixed(2)}%`
        if (span.style.backgroundPositionX !== next) span.style.backgroundPositionX = next
      }
    }
    const tick = () => {
      paint()
      rafId = requestAnimationFrame(tick)
    }
    paint()
    rafId = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafId)
      unsubscribe()
    }
  }, [playbackTimeStore, line, timeline])

  const chars = timeline.length ? timeline : Array.from(String(line.text || '')).map(ch => ({ ch, startMs: 0, durationMs: 0 }))
  // 无逐字时间轴时整行一次性点亮（LRC 行，与客户端一致）
  const plainRatio = timeline.length ? null : 100

  return (
    <span ref={wrapRef} data-active-lyric="">
      {chars.map((char, i) => (
        <span
          key={`${i}-${char.ch}`}
          data-ci={i}
          style={{
            color: 'transparent',
            backgroundImage: `linear-gradient(to right, ${dim} 50%, ${bright} 50%)`,
            backgroundSize: '200% 100%',
            backgroundPositionX: plainRatio != null ? `${plainRatio}%` : '0%',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
          }}
        >
          {char.ch}
        </span>
      ))}
    </span>
  )
})

/**
 * 歌词列：与客户端 LyricsView 同构的「整列表滚动」视图。
 *   - 容器 `overflow:scroll` + 上下渐隐遮罩（客户端同款 mask-image），隐藏滚动条
 *   - 全部歌词行都在 DOM 里，非活动行统一暗色，活动行做逐字扫描
 *   - 自动滚动：活动行停靠在视口顶部下方 80px（客户端是 `offsetTop - 80`，**不是居中**）
 *   - 滚轮会暂停自动跟随 5 秒（客户端行为），点击任意行跳转
 */
const SodaPcLyricsPane = memo(function SodaPcLyricsPane({
  playbackTimeStore,
  lyrics,
  accent,
  tone,
  onSeek,
}: {
  playbackTimeStore: PlaybackTimeStore
  lyrics: LyricLine[]
  accent: string
  tone: PcTone
  onSeek?: (time: number) => void
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const scrollLockRef = useRef(0)
  const firstScrollRef = useRef(true)

  // 只在「活动行变化」时让组件重渲染：每帧都 setState 会把整列表 diff 一遍
  useEffect(() => {
    const update = () => {
      const seconds = playbackTimeStore.getSnapshot().currentTime
      const next = currentLyricIndex(lyrics, seconds)
      setActiveIndex(prev => (prev === next ? prev : next))
    }
    update()
    return playbackTimeStore.subscribe(update)
  }, [playbackTimeStore, lyrics])

  // 滚轮 → 暂停自动跟随 5 秒（客户端 useEventListener(scroller,'wheel') 同款）
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const onWheel = () => { scrollLockRef.current = Date.now() + 5000 }
    scroller.addEventListener('wheel', onWheel, { passive: true })
    return () => scroller.removeEventListener('wheel', onWheel)
  }, [])

  // 活动行变化 → 把它滚到「顶部下方 80px」（客户端 target = offsetTop - 80）。
  // 关键：scroller 必须 position:relative —— offsetTop 是相对**最近的定位祖先**算的；
  // 没有它 offsetTop 参照到外层页面，target 大得出界，滚动表现为「不动/乱跳」。
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || activeIndex < 0) return
    if (Date.now() < scrollLockRef.current) return
    const el = scroller.querySelector<HTMLElement>(`[data-pi="${activeIndex}"]`)
    if (!el) return
    const seconds = playbackTimeStore.getSnapshot().currentTime
    const isHead = lyrics.length ? seconds * 1000 <= Number(lyrics[0]?.time || 0) * 1000 : false
    const last = lyrics[lyrics.length - 1]
    const isTail = last ? seconds > Number(last.time || 0) + Number(last.endTime || last.time || 0) : false
    const target = isHead ? 0 : isTail ? scroller.scrollHeight : Math.max(0, el.offsetTop - 80)
    scroller.scrollTo({ top: target, behavior: firstScrollRef.current ? 'auto' : 'smooth' })
    firstScrollRef.current = false
  }, [activeIndex, lyrics, playbackTimeStore])

  // 切歌：回到顶部并恢复首屏滚动。
  // 触发依据用「歌词首行时间戳」而不是数组引用——上游对同一首歌可能重发新数组（引用变了内容没变），
  // 反过来真正切歌时首行时间几乎必变；用内容特征触发更可靠。
  const lyricsHeadTime = lyrics.length ? Number(lyrics[0]?.time ?? -1) : -1
  useEffect(() => {
    firstScrollRef.current = true
    scrollLockRef.current = 0
    scrollerRef.current?.scrollTo({ top: 0 })
  }, [lyricsHeadTime])

  const dark = tone === 'dark'
  const bright = dark ? 'rgba(255,255,255,.96)' : 'rgba(15,23,42,.95)'
  const dim = dark ? 'rgba(255,255,255,.42)' : 'rgba(15,23,42,.42)'
  const translationColor = dark ? 'rgba(255,255,255,.42)' : 'rgba(15,23,42,.42)'
  const hoverBg = dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.06)'

  if (!lyrics.length) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="font-semibold" style={{ fontSize: 20, color: dark ? 'rgba(255,255,255,.3)' : 'rgba(15,23,42,.3)' }}>
          {NO_LYRIC_TEXT}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={scrollerRef}
      data-testid="soda-pc-lyrics"
      className="soda-lyrics-scroller h-full w-full overflow-y-scroll"
      style={{
        // offsetTop 的参照祖先：必须是本滚动容器（客户端 .scroller 也是 position:relative）
        position: 'relative',
        // 客户端同款上下渐隐：顶部 6% 处快速淡出，50% 之后向底部淡出
        maskImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,.93) 6%, #000 50%, rgba(0,0,0,0) 100%)',
        WebkitMaskImage: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,.93) 6%, #000 50%, rgba(0,0,0,0) 100%)',
        scrollbarWidth: 'none',
        padding: '120px 0',
      }}
    >
      <div className="flex flex-col" style={{ gap: 8 }}>
        {lyrics.map((line, i) => {
          const text = String(line?.text || '')
          if (!text.trim()) return null
          const active = i === activeIndex
          return (
            <div
              key={`${i}-${line?.time ?? 0}`}
              data-pi={i}
              role="button"
              tabIndex={0}
              onClick={() => { if (typeof line?.time === 'number' && onSeek) onSeek(line.time) }}
              onKeyDown={event => { if (event.key === 'Enter' && typeof line?.time === 'number' && onSeek) onSeek(line.time) }}
              className="cursor-pointer text-left transition-colors"
              style={{ padding: 6, borderRadius: 8, fontSize: 24, fontWeight: 600, lineHeight: '34px' }}
              onMouseEnter={event => { event.currentTarget.style.background = hoverBg }}
              onMouseLeave={event => { event.currentTarget.style.background = '' }}
            >
              {active ? (
                <ActiveLyricLine line={line} playbackTimeStore={playbackTimeStore} bright={bright} dim={dim} />
              ) : (
                <span style={{ color: dim }}>{text}</span>
              )}
              {line?.translation ? (
                <div style={{ marginTop: 4, fontSize: 20, fontWeight: 600, color: translationColor }}>{line.translation}</div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
})

function SodaPcPlayerFeed({
  tone, accent, dominantColor, song, isPlaying, liked, onToggleFavorite,
  lyrics, playbackTimeStore, stats, isVipOnly,
  onOpenComments, onOpenArtist, onPlayPause, onSeek, onStartFeed, feedLoading, feedCount, onOpenQueue,
}: SodaPcPlayerFeedProps) {
  const dark = tone === 'dark'
  const cover = song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''
  const artists = song?.artists?.length ? song.artists : []
  const primaryArtist = artists[0]
  // 汽水是「伪艺人」约定：艺人页按歌手名取数（ArtistDetailModal 的 soda 分支）。
  // 真实 artist id 已保留在 song.artists[].mid 里，等上游有独立艺人接口时可直接切过去。
  const primaryArtistRef = primaryArtist?.name ? String(primaryArtist.name) : ''
  const [coverLoaded, setCoverLoaded] = useState(false)
  // 补源标记：这首汽水歌实际用的是别的平台音源（会员/版权限制时自动补全）。
  // 版本号订阅让登记变化时角标立即出现/消失。
  useCrossFillVersion()
  const crossFill = isCrossFilled(song)
  // 统计自己拉：调用方不必为了两个数字把 media/stats 的请求状态也管起来
  const [fetchedStats, setFetchedStats] = useState<SodaPcPlayerFeedStats | null>(null)
  const songKey = song ? String(song.mid || song.id || '') : ''

  useEffect(() => { setCoverLoaded(false) }, [cover])

  useEffect(() => {
    if (!songKey) { setFetchedStats(null); return }
    let cancelled = false
    void fetchSodaMediaStats(songKey)
      .then(value => { if (!cancelled) setFetchedStats(value) })
      .catch(() => { if (!cancelled) setFetchedStats(null) })
    return () => { cancelled = true }
  }, [songKey])

  const effectiveStats = stats !== undefined ? stats : fetchedStats

  // 整页底色：客户端取专辑主色做整屏渐变（这里用主色 + 深色基底，深浅色主题都能压住白字）
  const pageBackground = useMemo(() => {
    const base = dominantColor || accent
    if (dark) {
      return `linear-gradient(150deg, color-mix(in srgb, ${base} 42%, #0b1220) 0%, color-mix(in srgb, ${base} 18%, #070b14) 46%, #05070d 100%)`
    }
    return `linear-gradient(150deg, color-mix(in srgb, ${base} 30%, #f8fafc) 0%, color-mix(in srgb, ${base} 14%, #ffffff) 50%, #ffffff 100%)`
  }, [dominantColor, accent, dark])

  const subtle = dark ? 'rgba(255,255,255,.6)' : 'rgba(15,23,42,.6)'
  const faint = dark ? 'rgba(255,255,255,.7)' : 'rgba(15,23,42,.7)'
  const pillBg = dark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.08)'
  const pillText = dark ? 'rgba(255,255,255,.85)' : 'rgba(15,23,42,.85)'

  return (
    <div
      data-soda-pc-player-feed=""
      className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden"
      style={{ background: pageBackground }}
    >
      {!song ? (
        // 未在播放：客户端的占位底色 + 播放入口（客户端此时会自动起推荐流）
        <div className="flex flex-col items-center gap-5 px-10 text-center">
          <div className="flex h-[168px] w-[168px] items-center justify-center rounded-xl" style={{ background: pillBg }}>
            <Waves className="h-14 w-14" style={{ color: pillText }} />
          </div>
          <div>
            <p className={`text-[20px] font-medium ${dark ? 'text-white' : 'text-slate-900'}`}>推荐</p>
            <p className="mt-1.5 text-[13px]" style={{ color: subtle }}>
              {feedCount ? `为你准备了 ${feedCount} 首推荐，点下面开始播放` : '从推荐流开始听'}
            </p>
          </div>
          <button
            type="button"
            onClick={onStartFeed}
            disabled={feedLoading}
            className="flex items-center gap-2 rounded-full px-6 py-2.5 text-[14px] font-medium text-white transition disabled:opacity-50"
            style={{ background: accent }}
          >
            <Play className="h-4 w-4 fill-current" />
            {feedLoading ? '正在加载推荐…' : '播放推荐'}
          </button>
        </div>
      ) : (
        <div className="flex w-full items-center justify-center" style={{ padding: '0 50px', gap: 50 }}>
          {/* 左列：封面 + 歌名/演唱者 + 关注 + 喜欢/评论 */}
          <div className="flex shrink-0 flex-col items-start" style={{ width: 'min(40vh, 30vw)', maxWidth: '40vh' }}>
            <div
              className="relative w-full overflow-hidden"
              style={{ aspectRatio: '1 / 1', borderRadius: 8, boxShadow: dark ? '0 32px 64px rgba(0,0,0,.45)' : '0 32px 64px rgba(0,0,0,.1)' }}
            >
              {cover ? (
                <img
                  src={cover}
                  alt={`${song.name} 封面`}
                  onLoad={() => setCoverLoaded(true)}
                  className="h-full w-full object-cover transition-opacity duration-300"
                  style={{ opacity: coverLoaded ? 1 : 0 }}
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center" style={{ background: pillBg }}>
                  <ListMusic className="h-12 w-12" style={{ color: pillText }} />
                </div>
              )}
            </div>

            <div className="flex w-full" style={{ marginTop: 32, gap: 12 }}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center" style={{ fontSize: 20, fontWeight: 500, color: dark ? '#fff' : '#0f172a' }}>
                  <span className="min-w-0 truncate">{song.name}</span>
                  {isVipOnly && (
                    <span className="ml-1 inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] font-black" style={{ background: pillBg, color: pillText }}>VIP</span>
                  )}
                  {crossFill && (
                    <span
                      className="ml-1.5 inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] font-bold"
                      style={{ background: 'rgba(0,203,100,.18)', color: '#00CB64' }}
                      title={`音源来自${crossFill.from === 'netease' ? '网易云' : crossFill.from === 'qq' ? 'QQ 音乐' : crossFill.from === 'kugou' ? '酷狗' : '其他平台'}（汽水源不可播时自动补全），歌词仍按本曲时间轴同步`}
                    >
                      补
                    </span>
                  )}
                </div>
                <div className="flex items-center" style={{ fontSize: 14, fontWeight: 500, marginTop: 4, color: subtle }}>
                  <span className="min-w-0 truncate">{artists.map(a => a.name).filter(Boolean).join(' / ') || '未知歌手'}</span>
                  {primaryArtistRef && onOpenArtist && (
                    <button
                      type="button"
                      onClick={() => onOpenArtist(primaryArtistRef)}
                      className="ml-1.5 inline-flex h-5 shrink-0 items-center justify-center rounded-full transition hover:opacity-85"
                      style={{ width: 40, fontSize: 12, fontWeight: 500, background: pillBg, color: pillText }}
                    >
                      关注
                    </button>
                  )}
                </div>
              </div>

              {/* 客户端：图标在上、数字绝对定位在其下（gap 17px / 高 50px） */}
              <div className="flex shrink-0" style={{ gap: 17, height: 50 }}>
                <button
                  type="button"
                  onClick={onToggleFavorite}
                  className="relative flex flex-col items-center"
                  title={liked ? '取消喜欢' : '喜欢'}
                >
                  <Heart
                    className="h-8 w-8 transition"
                    style={{ color: liked ? accent : (dark ? '#fff' : '#0f172a'), fill: liked ? accent : 'transparent' }}
                  />
                  <span className="absolute whitespace-nowrap" style={{ top: 36, fontSize: 10, fontWeight: 500, color: faint }}>
                    {liked
                      ? (effectiveStats?.countCollected ? pcCount(effectiveStats.countCollected + 1) : '已喜欢')
                      : (effectiveStats?.countCollected ? pcCount(effectiveStats.countCollected) : '喜欢')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onOpenComments(song)}
                  className="relative flex flex-col items-center"
                  title="评论"
                >
                  <MessageSquare className="h-[29px] w-[29px] translate-y-px" style={{ color: dark ? '#fff' : '#0f172a' }} />
                  <span className="absolute whitespace-nowrap" style={{ top: 36, fontSize: 10, fontWeight: 500, color: faint }}>
                    {effectiveStats?.countComment ? pcCount(effectiveStats.countComment) : '评论'}
                  </span>
                </button>
              </div>
            </div>

            {/* 客户端此处的播放控制交给底部播放条；这里只补一个唤醒暂停的入口，方便空手起播 */}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={onPlayPause}
                className="flex h-9 w-9 items-center justify-center rounded-full transition"
                style={{ background: pillBg, color: pillText }}
                title={isPlaying ? '暂停' : '播放'}
              >
                {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 fill-current" />}
              </button>
              {onOpenQueue && (
                <button
                  type="button"
                  onClick={onOpenQueue}
                  className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[12px] transition"
                  style={{ background: pillBg, color: pillText }}
                  title="播放列表"
                >
                  <ListMusic className="h-3.5 w-3.5" />
                  播放列表
                </button>
              )}
            </div>
          </div>

          {/* 右列：歌词（客户端 LyricsView 的落位） */}
          <div className="relative min-w-[300px] max-w-[500px] flex-1 self-stretch" style={{ width: '30vw' }}>
            <SodaPcLyricsPane playbackTimeStore={playbackTimeStore} lyrics={lyrics} accent={accent} tone={tone} onSeek={onSeek} />
          </div>
        </div>
      )}
    </div>
  )
}

export default memo(SodaPcPlayerFeed)
