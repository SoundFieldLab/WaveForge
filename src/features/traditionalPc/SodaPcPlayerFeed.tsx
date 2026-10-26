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
      if (snap.currentTime < baseSeconds) resetSettled()
      baseSeconds = snap.currentTime
      baseAt = performance.now()
      playing = snap.isPlaying
      resetSettled()
      paint()
    })
    // 性能：backgroundImage 不可 GPU 合成，每帧全量重写会逼浏览器整行重绘。
    // 只在字的演唱比例处于开区间 (0,1) 时逐帧更新；唱满/未唱的字写一次终值后跳过
    // （settled 记录该字是否已到达终态，seek 回退时重置）。
    const BRIGHT_FILL = `linear-gradient(90deg, ${bright}, ${bright})`
    const DIM_FILL = `linear-gradient(90deg, ${dim}, ${dim})`
    const settled = new Array<boolean>(timeline.length).fill(false)
    const applyFill = (index: number, ratio: number) => {
      const span = spans[index]
      if (!span) return
      let next: string
      if (ratio >= 1) next = BRIGHT_FILL
      else if (ratio <= 0) next = DIM_FILL
      else {
        // 逐字柔边（对齐播放页 LyricsDisplay 的 getFillOverlayStyle 手感）：
        // 唱到的比例向两侧羽化——正在唱的字"中心亮、边缘柔"。FEATHER 是羽化半宽。
        const FEATHER = 0.35
        const from = Math.min(100, Math.max(0, (ratio - FEATHER) / (1 - 2 * FEATHER) * 100))
        const to = Math.min(100, Math.max(0, (ratio + FEATHER) / (1 - 2 * FEATHER) * 100))
        next = `linear-gradient(90deg, ${bright} ${from.toFixed(2)}%, ${dim} ${to.toFixed(2)}%)`
      }
      if (span.style.backgroundImage !== next) span.style.backgroundImage = next
    }
    const paint = () => {
      const elapsed = playing ? (performance.now() - baseAt) / 1000 : 0
      const nowSeconds = baseSeconds + elapsed
      const localMs = nowSeconds * 1000 - lineStartMs
      for (let i = 0; i < timeline.length; i += 1) {
        if (settled[i]) continue
        const char = timeline[i]
        const ratio = char.durationMs > 0
          ? Math.min(1, Math.max(0, (localMs - char.startMs) / char.durationMs))
          : (localMs >= char.startMs ? 1 : 0)
        applyFill(i, ratio)
        if (ratio >= 1 || ratio <= 0) settled[i] = true
      }
    }
    const resetSettled = () => { settled.fill(false) }
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
            // 初值=未唱（纯 dim）；paint() 每帧覆盖为柔边双色渐变。
            // 无逐字时间轴的 LRC 行由 plainRatio 直接定死为已唱亮色。
            backgroundImage: plainRatio != null
              ? `linear-gradient(90deg, ${bright}, ${bright})`
              : `linear-gradient(90deg, ${dim}, ${dim})`,
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

  // 整页底色：客户端取专辑主色做整屏渐变。专辑主色常接近黑（黑白封面、夜景封面），
  // 直接 color-mix 会整屏死黑——先把主色亮度提到最低 22%（保留色相），再叠加：
  //   ① 主色径向光晕（左上，画面"有背景"的主体） ② 150° 纵深渐变 ③ 右下暗角。
  const glowColor = useMemo(() => {
    const base = dominantColor || accent
    if (!dark) return base
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(base)
    if (!m) return base
    let [r, g, b] = [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0
    const l = (max + min) / 2
    const d = max - min
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h /= 6
    }
    // 亮度钳到 0.22..0.4、饱和至少 0.35：暗色封面也能衬出主题色的"光"
    const l2 = Math.min(0.4, Math.max(0.22, l))
    const s2 = Math.max(0.35, s)
    const c = (1 - Math.abs(2 * l2 - 1)) * s2
    const hp = h * 6
    const x = c * (1 - Math.abs((hp % 2) - 1))
    const m2 = l2 - c / 2
    const seg = Math.floor(hp) % 6
    const rgb: Array<[number, number, number]> = [
      [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
    ]
    const [r2, g2, b2] = rgb[seg]!
    return `rgb(${Math.round((r2 + m2) * 255)}, ${Math.round((g2 + m2) * 255)}, ${Math.round((b2 + m2) * 255)})`
  }, [dominantColor, accent, dark])
  const pageBackground = useMemo(() => {
    const base = dominantColor || accent
    if (dark) {
      return [
        `radial-gradient(1100px 620px at 18% 8%, ${glowColor}55 0%, transparent 62%)`,
        `radial-gradient(900px 520px at 86% 96%, ${glowColor}22 0%, transparent 60%)`,
        `linear-gradient(150deg, color-mix(in srgb, ${glowColor} 26%, #0b1220) 0%, color-mix(in srgb, ${base} 14%, #070b14) 46%, #05070d 100%)`,
      ].join(', ')
    }
    return `linear-gradient(150deg, color-mix(in srgb, ${base} 30%, #f8fafc) 0%, color-mix(in srgb, ${base} 14%, #ffffff) 50%, #ffffff 100%)`
  }, [dominantColor, accent, dark, glowColor])

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
        // 两列行必须自身撑满页面高度（父级是 flex，h-full 生效）：歌词列的
        // self-stretch 与内部 overflow 滚动都参照这里的高度——曾因缺 h-full
        // 被内容撑开，歌词容器 scrollHeight==clientHeight，自动滚动完全失效。
        <div className="flex h-full min-h-0 w-full items-center justify-center" style={{ padding: '0 64px', gap: 72 }}>
          {/* 左列：封面 + 歌名/演唱者 + 关注 + 喜欢/评论。入场：从下方 18px 淡入上浮 480ms */}
          <div
            className="flex shrink-0 flex-col items-start"
            style={{
              width: 'min(44vh, 32vw)',
              maxWidth: '44vh',
              animation: 'sodaFeedEnter 480ms cubic-bezier(0.22, 1, 0.36, 1) both',
            }}
          >
            <div
              className="relative w-full overflow-hidden"
              style={{ aspectRatio: '1 / 1', borderRadius: 12, boxShadow: dark ? '0 36px 80px rgba(0,0,0,.55), 0 12px 28px rgba(0,0,0,.35)' : '0 32px 64px rgba(0,0,0,.1)' }}
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

          {/* 右列：歌词（客户端 LyricsView 的落位）。入场：延迟 80ms 从右侧轻移淡入，与封面错峰 */}
          <div
            className="relative min-w-[300px] max-w-[560px] flex-1 self-stretch"
            style={{
              width: '32vw',
              maxWidth: 560,
              animation: 'sodaFeedEnter 520ms cubic-bezier(0.22, 1, 0.36, 1) 80ms both',
            }}
          >
            <SodaPcLyricsPane playbackTimeStore={playbackTimeStore} lyrics={lyrics} accent={accent} tone={tone} onSeek={onSeek} />
          </div>
        </div>
      )}
    </div>
  )
}

// 入场动画（封面/歌词列共用）：淡入 + 12~18px 位移，cubic-bezier 回弹收尾。
// 挂在全局 <style> 里会随组件重复注入，这里只输出一次 keyframes 由两个元素引用。
if (typeof document !== 'undefined' && !document.getElementById('soda-feed-enter-kf')) {
  const style = document.createElement('style')
  style.id = 'soda-feed-enter-kf'
  style.textContent = `@keyframes sodaFeedEnter { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }`
  document.head.appendChild(style)
}

export default memo(SodaPcPlayerFeed)
