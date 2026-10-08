// 传统模式「官方 PC 客户端复刻」共用基件。
//
// 为什么单独抽一层：QQ 音乐 PC 与网易云 PC 都是「左栏导航 + 中栏列表页」的经典三栏布局，
// 两个平台的页面骨架完全同构（大标题 / 页签 / 操作条 / 歌曲表格 / 封面网格），
// 差异只在配色与少量行内元素（角标、喜欢列、播放时间列）。这里把同构部分收敛成基件，
// 平台页面只负责拿数据 + 拼装，避免两套页面各写一遍表格导致样式漂移。
//
// 主题：两个官方客户端都有浅色/深色两套皮肤，这里用 tone 参数化（与全软件 playerTheme 同源），
// 布局尺寸/层级/交互与官方一致，配色跟随当前主题。
import { memo, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { ChevronRight, Heart, MoreHorizontal, Music2, Pause, Play, Search } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { getProxiedImageUrl } from '../../services/musicApi'
import type { Song } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'

export type PcTone = 'light' | 'dark'
/** 平台风格：决定表格列、角标形态与强调色语义（QQ 绿 / 网易云红 / 酷狗橙由 accent 传入覆盖）。
 *  kugou 复用 netease 的默认分支，仅靠 accent 与数据源区分（酷狗客户端二级页与网易云同构）；
 *  apple = Apple Music 客户端复刻（红色强调、客户端圆角、不摆 QQ/网易云的角标）。 */
export type PcSkin = 'qq' | 'netease' | 'kugou' | 'apple'

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 播放量/收藏数：与官方一致的中文单位（万 / 亿，保留 1 位小数）。 */
export function pcCount(value?: number | null): string {
  const n = Number(value || 0)
  if (!n) return ''
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

/**
 * 时长格式化（官方表格里的时长列格式）。
 * 入参是 `Song.duration`，**毫秒**（全项目 Song.duration 均为毫秒，见 musicApi.ts）；
 * 兼容误传秒值的情况：小于 10000 视为秒，避免出现 5000:00 这种明显错值。
 */
export function pcDuration(duration?: number | null): string {
  const raw = Math.max(0, Math.floor(Number(duration) || 0))
  if (!raw) return '--:--'
  const totalSeconds = raw < 10000 ? raw : Math.round(raw / 1000)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 时间戳(ms) -> 客户端「播放时间」列格式：今年只显示 MM-DD，跨年显示 YYYY-MM-DD。 */
export function pcDateTime(value?: number | null): string {
  const ms = Number(value || 0)
  if (!ms) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const now = new Date()
  if (date.getFullYear() !== now.getFullYear()) return `${date.getFullYear()}-${month}-${day}`
  return `${month}-${day}`
}

/** 歌曲唯一键（跨平台并存的队列里必须带 platform）。 */
export function pcSongKey(song?: Song | null): string {
  if (!song) return ''
  return `${song.platform || ''}:${song.id || song.mid || song.name || ''}`
}

export function pcSongArtwork(song?: Song | null): string {
  const raw = song?.album?.picUrl || ''
  return raw ? getProxiedImageUrl(raw) : ''
}

/** 一整个列表的稳定键序列：用于「播放全部」时把列表交给播放器。 */
export function pcSongKeys(songs: Song[]): string[] {
  return songs.map(pcSongKey)
}

/* ------------------------------------------------------------------ *
 * 主题 token
 * ------------------------------------------------------------------ */

export interface PcTheme {
  tone: PcTone
  /** 主文字色 class */
  text: string
  /** 次级文字 class（歌手名、副标题、表头） */
  subtle: string
  /** 更弱的文字（时间、说明） */
  faint: string
  /** 卡片/浮层底色 class */
  surface: string
  /** 列表 hover 底色 class */
  hover: string
  /** 分割线 class */
  divider: string
  /** 页签未选中文字 */
  tabIdle: string
  /** 白色/黑色实体按钮（客户端「播放全部」的次要按钮风格） */
  solidBtn: string
  /** 半透明胶囊按钮底 */
  chipIdle: string
}

export function pcTheme(tone: PcTone): PcTheme {
  if (tone === 'dark') {
    return {
      tone,
      text: 'text-white/92',
      subtle: 'text-white/56',
      faint: 'text-white/35',
      surface: 'bg-white/[0.06]',
      hover: 'hover:bg-white/[0.07]',
      divider: 'border-white/10',
      tabIdle: 'text-white/55 hover:text-white/85',
      solidBtn: 'bg-white/10 text-white/85 hover:bg-white/[0.16]',
      chipIdle: 'bg-white/[0.07] text-white/60 hover:bg-white/[0.12] hover:text-white/85',
    }
  }
  return {
    tone,
    text: 'text-slate-900',
    subtle: 'text-slate-500',
    faint: 'text-slate-400',
    surface: 'bg-black/[0.035]',
    hover: 'hover:bg-black/[0.045]',
    divider: 'border-black/[0.08]',
    tabIdle: 'text-slate-500 hover:text-slate-900',
    solidBtn: 'bg-black/[0.05] text-slate-700 hover:bg-black/[0.09]',
    chipIdle: 'bg-black/[0.045] text-slate-600 hover:bg-black/[0.08] hover:text-slate-900',
  }
}

/* ------------------------------------------------------------------ *
 * 封面
 * ------------------------------------------------------------------ */

export const PcCover = memo(function PcCover({
  src,
  alt,
  className,
  rounded = 'rounded-lg',
  overlay,
  eager = false,
}: {
  src?: string
  alt: string
  className: string
  rounded?: string
  /** 叠加在封面上的角标层（播放量、播放按钮等） */
  overlay?: ReactNode
  eager?: boolean
}) {
  const url = src ? getProxiedImageUrl(src) : ''
  // 占位取中性半透明灰：浅色/深色两套皮肤下都看得见（原来的黑色 7% 在深色主题里等于隐形）
  const placeholder = (
    <span aria-label={`${alt} 封面占位`} className={`${className} ${rounded} flex items-center justify-center bg-[rgba(128,128,128,0.20)] text-[rgba(165,165,165,0.8)]`}>
      <Music2 className="h-1/3 w-1/3 opacity-70" />
    </span>
  )
  return (
    <span className={`relative block overflow-hidden ${rounded} ${className}`}>
      {url
        ? <CachedImage src={url} alt={alt} className={`h-full w-full object-cover`} lazy={!eager} priority={eager ? 'visible' : 'visible'} role="card" fallback={placeholder} />
        : placeholder}
      {overlay}
    </span>
  )
})

/** 封面左上/右下的播放量角标（官方两平台都有）。 */
export function PcCountBadge({ value, className = '' }: { value?: number | null; className?: string }) {
  const label = pcCount(value)
  if (!label) return null
  return (
    <span className={`pointer-events-none absolute left-1.5 top-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm ${className}`}>
      <HeadphoneGlyph />
      {label}
    </span>
  )
}

function HeadphoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <path d="M4 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2Z" />
      <path d="M20 14a2 2 0 0 1 2 2v2a2 2 0 0 1-4 0v-2a2 2 0 0 1 2-2Z" />
    </svg>
  )
}

/* ------------------------------------------------------------------ *
 * 标题 / 页签 / 胶囊 / 按钮
 * ------------------------------------------------------------------ */

/** 区块标题：「官方歌单 >」这种带箭头的分节标题。 */
export function PcSectionTitle({ title, more, onMore, theme, className = '' }: { title: string; more?: string; onMore?: () => void; theme: PcTheme; className?: string }) {
  return (
    <div className={`mb-3 flex items-center gap-1 ${className}`}>
      <h2 className={`text-[17px] font-semibold ${theme.text}`}>{title}</h2>
      <button
        type="button"
        onClick={onMore}
        disabled={!onMore}
        className={`flex items-center gap-0.5 text-[13px] ${onMore ? theme.subtle : 'opacity-0'}`}
      >
        {more || '更多'}
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

export interface PcTabItem { key: string; label: string; count?: number }

/** 下划线页签（客户端歌曲/评论/收藏者、单曲/播客/歌单…）。 */
export function PcTabs({ items, value, onChange, accent, theme, size = 'md' }: { items: PcTabItem[]; value: string; onChange: (key: string) => void; accent: string; theme: PcTheme; size?: 'md' | 'lg' }) {
  return (
    <div className={`flex items-end gap-6 ${size === 'lg' ? 'text-[17px]' : 'text-[15px]'}`}>
      {items.map(item => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={`relative -mb-px pb-2 transition ${active ? 'font-semibold' : theme.tabIdle}`}
            style={active ? { color: accent } : undefined}
          >
            {item.label}
            {typeof item.count === 'number' ? <span className="ml-0.5 text-[12px] opacity-70">{item.count}</span> : null}
            {active && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full" style={{ background: accent }} />}
          </button>
        )
      })}
    </div>
  )
}

/** 胶囊页签（精选/歌单广场/排行榜、收藏专辑/收藏的 MV…）。 */
export function PcChips({ items, value, onChange, accent, theme, className = '' }: { items: PcTabItem[]; value: string; onChange: (key: string) => void; accent: string; theme: PcTheme; className?: string }) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      {items.map(item => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            className={`rounded-full px-3.5 py-1.5 text-[13px] transition ${active ? 'font-medium' : theme.chipIdle}`}
            style={active ? { background: accent, color: '#fff' } : undefined}
          >
            {item.label}
          </button>
        )
      })}
    </div>
  )
}

/** 主按钮：客户端「播放全部」的实心彩底胶囊。 */
export function PcPrimaryButton({ label, icon, onClick, accent, disabled, className = '' }: { label: string; icon?: ReactNode; onClick?: () => void; accent: string; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-white transition disabled:opacity-45 ${className}`}
      style={{ background: accent }}
    >
      {icon ?? <Play className="h-3.5 w-3.5 fill-current" />}
      {label}
    </button>
  )
}

/** 次要按钮：客户端工具栏里的浅底胶囊（下载 / 批量 / 收藏…）。 */
export function PcGhostButton({ label, icon, onClick, theme, disabled, className = '' }: { label: string; icon?: ReactNode; onClick?: () => void; theme: PcTheme; disabled?: boolean; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition disabled:opacity-45 ${theme.solidBtn} ${className}`}
    >
      {icon}
      {label}
    </button>
  )
}

/** 圆形图标按钮（工具栏右端 搜索/排序/视图/筛选）。 */
export function PcIconButton({ children, onClick, title, theme, active = false, accent }: { children: ReactNode; onClick?: () => void; title?: string; theme: PcTheme; active?: boolean; accent?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex h-7 w-7 items-center justify-center rounded-full transition ${active ? '' : `${theme.subtle} ${theme.hover}`}`}
      style={active && accent ? { color: accent, background: `${accent}1f` } : undefined}
    >
      {children}
    </button>
  )
}

/** 页面大标题（喜欢 / 最近播放 / 我喜欢的音乐…）。 */
export function PcPageTitle({ title, subtitle, extra, theme }: { title: string; subtitle?: ReactNode; extra?: ReactNode; theme: PcTheme }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className={`text-[24px] font-semibold leading-tight ${theme.text}`}>{title}</h1>
        {subtitle ? <div className={`mt-1 text-[12px] ${theme.subtle}`}>{subtitle}</div> : null}
      </div>
      {extra}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌曲表格
 * ------------------------------------------------------------------ */

export interface PcSongTableColumns {
  /** 序号列（网易云有，QQ 的列表页有） */
  index?: boolean
  /** 喜欢（红心）列 */
  like?: boolean
  /** 专辑列 */
  album?: boolean
  /** 时长列 */
  duration?: boolean
  /** 播放时间列（最近播放页） */
  playedAt?: boolean
  /** 文件大小列（云盘文件） */
  size?: boolean
}

export const PC_DEFAULT_COLUMNS: PcSongTableColumns = { index: true, like: true, album: true, duration: true }

/** 行内角标：QQ 的 VIP / 试听 / MV，网易云的 独家 / 超清母带 / VIP / 试听 / MV。 */
export function PcSongBadges({ song, skin }: { song: Song; skin: PcSkin }) {
  // Apple Music 客户端列表不带 VIP/试听/独家角标（音质标识另行处理），这里整体不渲染。
  if (skin === 'apple') return null
  const badges: Array<{ label: string; color: string; border?: boolean }> = []
  const vip = Boolean(song.vip || song.requiredTier)
  if (skin === 'qq') {
    if (vip) badges.push({ label: 'VIP', color: '#f5a623' })
    if (song.noCopyright) badges.push({ label: '试听', color: '#f5a623', border: true })
    if ((song as { hasMv?: boolean }).hasMv) badges.push({ label: 'MV', color: '#5aabf5', border: true })
  } else {
    if ((song as { exclusive?: boolean }).exclusive) badges.push({ label: '独家', color: '#e0513f', border: true })
    if ((song as { highestQuality?: string }).highestQuality === 'master') badges.push({ label: '超清母带', color: '#d8a35a' })
    else if ((song as { highestQuality?: string }).highestQuality) badges.push({ label: '高音质', color: '#d8a35a' })
    if (vip) badges.push({ label: 'VIP', color: '#e0513f', border: true })
    if (song.noCopyright) badges.push({ label: '试听', color: '#e0513f', border: true })
    if ((song as { hasMv?: boolean }).hasMv) badges.push({ label: 'MV', color: '#e0513f', border: true })
  }
  if (!badges.length) return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1 align-middle">
      {badges.map(badge => (
        <span
          key={badge.label}
          className="rounded-[3px] px-1 py-[1px] text-[10px] leading-[13px]"
          style={badge.border
            ? { color: badge.color, border: `1px solid ${badge.color}80` }
            : { color: '#fff', background: badge.color }}
        >
          {badge.label}
        </span>
      ))}
    </span>
  )
}

export interface PcSongTableProps {
  songs: Song[]
  skin: PcSkin
  theme: PcTheme
  accent: string
  columns?: PcSongTableColumns
  /** 当前播放歌曲键（pcSongKey），行会高亮 */
  playingKey?: string
  isPlaying?: boolean
  onPlay?: (song: Song, index: number) => void
  onMenu?: (event: ReactMouseEvent, song: Song) => void
  likedKeys?: Set<string>
  /** 红心判定回调：优先于 likedKeys（父层用 favoriteStatusService 的实时快照时更省事） */
  isLiked?: (song: Song) => boolean
  onToggleLike?: (song: Song, liked: boolean) => void
  loading?: boolean
  empty?: ReactNode
  /** 行右键/悬浮时右侧出现的操作（客户端 hover 才显示），由页面注入 */
  rowActions?: (song: Song, index: number) => ReactNode
  /** 额外列（如「喜欢」列换成别的），放在时长之前 */
  extraColumn?: { title: string; render: (song: Song, index: number) => ReactNode; width?: number }
}

/**
 * 客户端歌曲列表：与官方 PC 同构的表格（序号 / 标题 / 专辑 / 喜欢 / 时长）。
 * 两平台差异（网易云序号列起始、QQ 无独立序号列、行高、角标）由 columns + skin 控制。
 */
export const PcSongTable = memo(function PcSongTable({
  songs, skin, theme, accent, columns = PC_DEFAULT_COLUMNS, playingKey, isPlaying,
  onPlay, onMenu, likedKeys, isLiked, onToggleLike, loading, empty, rowActions,
}: PcSongTableProps) {
  if (loading) {
    return (
      <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
    )
  }
  if (!songs.length) {
    return <>{empty ?? <PcEmpty theme={theme} title="暂无内容" />}</>
  }
  const showAlbum = columns.album !== false
  const showLike = columns.like !== false
  const showDuration = columns.duration !== false
  const showIndex = Boolean(columns.index)
  return (
    <div className="w-full">
      {/* 表头 */}
      <div className={`flex items-center gap-3 border-b pb-2 text-[12px] ${theme.subtle} ${theme.divider}`}>
        {showIndex && <span className="w-8 shrink-0 text-center">#</span>}
        <span className="min-w-0 flex-1">标题</span>
        {showAlbum && <span className="hidden w-[26%] shrink-0 truncate lg:block">专辑</span>}
        {columns.playedAt && <span className="hidden w-[90px] shrink-0 text-right md:block">播放时间</span>}
        {columns.size && <span className="hidden w-[72px] shrink-0 text-right md:block">大小</span>}
        {showLike && <span className="w-[56px] shrink-0 text-center">喜欢</span>}
        {showDuration && <span className="w-[56px] shrink-0 text-right">时长</span>}
      </div>
      {songs.map((song, index) => {
        const key = pcSongKey(song)
        const active = Boolean(playingKey) && key === playingKey
        const liked = isLiked ? isLiked(song) : (likedKeys?.has(key) ?? false)
        return (
          <div
            key={`${key}:${index}`}
            onDoubleClick={() => onPlay?.(song, index)}
            onContextMenu={event => onMenu?.(event, song)}
            className={`group flex items-center gap-3 rounded-md py-[6px] text-[13px] transition ${theme.hover}`}
          >
            {showIndex && (
              <span className="w-8 shrink-0 text-center text-[12px]" style={active ? { color: accent } : undefined}>
                <span className={`tabular-nums ${active ? 'hidden' : 'block group-hover:hidden'} ${theme.faint}`}>{String(index + 1).padStart(2, '0')}</span>
                <button
                  type="button"
                  onClick={() => onPlay?.(song, index)}
                  className={`${active ? 'block' : 'hidden group-hover:flex'} mx-auto items-center justify-center`}
                  aria-label={`播放 ${song.name}`}
                >
                  {active && isPlaying
                    ? <Pause className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                    : <Play className="h-3.5 w-3.5 fill-current" style={{ color: active ? accent : undefined }} />}
                </button>
              </span>
            )}
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <PcCover src={pcSongArtwork(song)} alt={song.name} className="h-10 w-10 shrink-0" rounded={skin === 'qq' ? 'rounded-md' : 'rounded-md'} />
              <span className="min-w-0 flex-1">
                <span className={`flex items-center gap-1.5 ${active ? 'font-medium' : ''}`} style={active ? { color: accent } : undefined}>
                  <span className={`truncate ${active ? '' : theme.text}`}>{song.name}</span>
                  <PcSongBadges song={song} skin={skin} />
                  {/* hover 行内操作（官方在鼠标悬浮行时出现） */}
                  <span className="hidden shrink-0 items-center gap-1 group-hover:flex">{rowActions?.(song, index)}</span>
                </span>
                <span className={`mt-[2px] block truncate text-[12px] ${theme.subtle}`}>
                  {(song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')}
                </span>
              </span>
            </span>
            {showAlbum && (
              <span className="hidden w-[26%] shrink-0 lg:block">
                <button
                  type="button"
                  className={`block max-w-full truncate text-left text-[12px] ${theme.subtle} hover:underline`}
                  title={song.album?.name || ''}
                >
                  {song.album?.name || ''}
                </button>
              </span>
            )}
            {columns.playedAt && <span className={`hidden w-[90px] shrink-0 text-right text-[12px] md:block ${theme.faint}`}>{pcDateTime((song as { playedAt?: number }).playedAt)}</span>}
            {columns.size && <span className={`hidden w-[72px] shrink-0 text-right text-[12px] md:block ${theme.faint}`}>{(song as { fileSize?: number }).fileSize ? `${((song as { fileSize?: number }).fileSize! / 1048576).toFixed(1)}M` : ''}</span>}
            {showLike && (
              <span className="w-[56px] shrink-0 text-center">
                <button
                  type="button"
                  onClick={() => onToggleLike?.(song, !liked)}
                  aria-label={liked ? '取消喜欢' : '喜欢'}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                  style={{ opacity: liked ? 1 : undefined }}
                >
                  <Heart className={`h-4 w-4 ${liked ? '' : theme.faint}`} style={liked ? { color: accent, fill: accent } : undefined} />
                </button>
              </span>
            )}
            {showDuration && <span className={`w-[56px] shrink-0 text-right text-[12px] tabular-nums ${theme.faint}`}>{pcDuration(song.duration)}</span>}
          </div>
        )
      })}
    </div>
  )
})

/** 行内小图标按钮（hover 操作：播放/下载/评论…）。 */
export function PcRowAction({ children, onClick, title, theme }: { children: ReactNode; onClick?: () => void; title?: string; theme: PcTheme }) {
  return (
    <button
      type="button"
      onClick={event => { event.stopPropagation(); onClick?.() }}
      onDoubleClick={event => event.stopPropagation()}
      title={title}
      aria-label={title}
      className={`flex h-5 w-5 items-center justify-center rounded-full ${theme.faint} hover:bg-black/10`}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 卡片网格 / 空态 / 工具条
 * ------------------------------------------------------------------ */

export interface PcCardItem {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  playCount?: number | null
  /** 封面下方两行说明（官方「官方歌单」卡：标题 | 副标题在同一行） */
  caption?: string
  onClick?: () => void
  onContextMenu?: (event: ReactMouseEvent) => void
  rounded?: string
}

/**
 * 封面卡片网格。官方客户端的歌单/专辑/歌手网格：封面 + 角标 + 标题，可选两行副标题。
 */
export function PcCardGrid({ items, theme, accent, columns = 6, size = 'md', showPlayOnHover = true }: { items: PcCardItem[]; theme: PcTheme; accent: string; columns?: number; size?: 'sm' | 'md' | 'lg'; showPlayOnHover?: boolean }) {
  const colClass = columns >= 6
    ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
    : columns === 4
      ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5'
  const titleSize = size === 'sm' ? 'text-[12px]' : size === 'lg' ? 'text-[14px]' : 'text-[13px]'
  return (
    <div className={`grid gap-x-3 gap-y-5 ${colClass}`}>
      {items.map(item => (
        <button
          key={item.key}
          type="button"
          onClick={item.onClick}
          onContextMenu={item.onContextMenu}
          className="group block text-left"
        >
          <PcCover
            src={item.coverUrl}
            alt={item.title}
            className="aspect-square w-full"
            rounded={item.rounded || 'rounded-[8px]'}
            overlay={
              <>
                <PcCountBadge value={item.playCount} />
                {showPlayOnHover && (
                  <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full bg-white/95 opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100">
                    <Play className="h-3.5 w-3.5 fill-current" style={{ color: accent }} />
                  </span>
                )}
              </>
            }
          />
          <span className={`mt-2 line-clamp-2 ${titleSize} leading-snug ${theme.text}`}>{item.title}</span>
          {item.subtitle ? <span className={`mt-0.5 line-clamp-2 block text-[11px] leading-snug ${theme.faint}`}>{item.subtitle}</span> : null}
        </button>
      ))}
    </div>
  )
}

/** 空态：官方客户端同款「空空如也」。 */
export function PcEmpty({ theme, title = '空空如也', description, action }: { theme: PcTheme; title?: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <span className={`flex h-16 w-16 items-center justify-center rounded-2xl ${theme.surface}`}>
        <Music2 className={`h-7 w-7 ${theme.faint}`} />
      </span>
      <p className={`mt-4 text-[14px] ${theme.subtle}`}>{title}</p>
      {description ? <p className={`mt-1 text-[12px] ${theme.faint}`}>{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** 灰底提示条（「关注的歌手请至…」「含 24 首 VIP 歌曲…」）。 */
export function PcNoticeBar({ children, theme, onClose, action }: { children: ReactNode; theme: PcTheme; onClose?: () => void; action?: ReactNode }) {
  return (
    <div className={`mb-4 flex items-center justify-between gap-3 rounded-md px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-2">
        {action}
        {onClose && (
          <button type="button" onClick={onClose} className={`text-[14px] leading-none ${theme.faint} hover:opacity-80`} aria-label="关闭">×</button>
        )}
      </div>
    </div>
  )
}

/** 表格右上角的搜索入口（客户端列表页右端都有）。 */
export function PcTableSearch({ value, onChange, placeholder = '搜索', accent, theme, onSearch }: { value: string; onChange: (next: string) => void; placeholder?: string; accent: string; theme: PcTheme; onSearch?: () => void }) {
  return (
    <label className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] ${theme.surface}`}>
      <Search className={`h-3.5 w-3.5 ${theme.faint}`} />
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') onSearch?.() }}
        placeholder={placeholder}
        className={`w-24 bg-transparent outline-none placeholder:opacity-70 ${theme.text}`}
        style={{ color: undefined }}
      />
      <span className="sr-only" style={{ background: accent }} />
    </label>
  )
}

/** 更多（…）按钮：客户端工具栏里的省略号菜单入口。 */
export function PcMoreButton({ theme, onClick }: { theme: PcTheme; onClick?: () => void }) {
  return <PcIconButton theme={theme} title="更多"><MoreHorizontal className="h-4 w-4" /></PcIconButton>
}

/* ------------------------------------------------------------------ *
 * 头部（歌单/专辑/歌手详情通用）
 * ------------------------------------------------------------------ */

export interface PcDetailHeaderProps {
  coverUrl?: string
  title: string
  /** 标题右侧的小图标位（网易云歌单标题后有「分享」等） */
  titleExtra?: ReactNode
  description?: ReactNode
  creator?: { name: string; avatar?: string; onClick?: () => void }
  meta?: ReactNode
  actions?: ReactNode
  theme: PcTheme
  skin: PcSkin
  playCount?: number | null
}

/**
 * 二级页头部：官方客户端「大封面 + 标题 + 简介 + 创建者 + 操作条」布局。
 * QQ 与网易云在此处几乎一致，只有封面尺寸与圆角差异（QQ 12px 圆角、网易云 8px）。
 */
export function PcDetailHeader({ coverUrl, title, titleExtra, description, creator, meta, actions, theme, skin, playCount }: PcDetailHeaderProps) {
  // Apple Music 客户端的专辑/歌单头图更大、圆角 10px（QQ 184/12px，网易云 190/8px）
  const coverSize = skin === 'qq' ? 'h-[184px] w-[184px]' : skin === 'apple' ? 'h-[200px] w-[200px]' : 'h-[190px] w-[190px]'
  return (
    <div className="mb-5 flex gap-6">
      <PcCover
        src={coverUrl}
        alt={title}
        eager
        className={`${coverSize} shrink-0 shadow-sm`}
        rounded={skin === 'qq' ? 'rounded-xl' : 'rounded-lg'}
        overlay={<PcCountBadge value={playCount} className="bottom-2 left-2 top-auto" />}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h1 className={`min-w-0 flex-1 text-[22px] font-semibold leading-tight ${theme.text}`}>{title}</h1>
          {titleExtra}
        </div>
        {meta ? <div className={`mt-2 text-[12px] ${theme.subtle}`}>{meta}</div> : null}
        {description ? <div className={`mt-2 line-clamp-3 text-[12px] leading-relaxed ${theme.subtle}`}>{description}</div> : null}
        {creator ? (
          <button type="button" onClick={creator.onClick} className="mt-3 flex items-center gap-2 text-left">
            <PcCover src={creator.avatar} alt={creator.name} className="h-6 w-6 shrink-0" rounded="rounded-full" />
            <span className={`text-[12px] ${theme.subtle} hover:underline`}>{creator.name}</span>
          </button>
        ) : null}
        {actions ? <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

/** 行内「加载更多」/「暂无更多」分隔（客户端列表底部）。 */
export function PcListFooter({ theme, label }: { theme: PcTheme; label: string }) {
  return <div className={`py-6 text-center text-[12px] ${theme.faint}`}>{label}</div>
}

export const pcNoop = () => {}

/** 供页面 style 计算用（例如跟随封面的主题色底）。 */
export function pcTint(color: string, alpha: number): CSSProperties {
  return { background: `${color}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, '0')}` }
}

export type { Song, MusicPlatform }
