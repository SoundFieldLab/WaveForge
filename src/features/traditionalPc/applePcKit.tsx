// 传统模式「Apple Music 客户端复刻」共用基件。
//
// 依据：对官方 Apple Music Windows 客户端（AppleInc.AppleMusicWin，WinUI 3 + 内容层 WebView2）
// 的零干扰取证——侧栏 UIA 树（名称/图标/缩进/行高）、资料库「歌曲」表格截图、
// 「广播」页面截图（用户提供）。配色取截图实测值（浅色）：
//   窗口/侧栏底 #f3f3f3、内容区 #eeeeee、表格行 #f9f9f9（隔行 #f3f3f3）、
//   分隔线 #e5e5e5、主文字 #252525、次级文字 #7a7a7a、选中胶囊 #eaeaea、品牌红 #fa233b。
// 深色沿用同一套语义（Apple 客户端深色外观），值取近似而不凭空的常规 Apple 深色板。
//
// 客户端内容页的两种页头（两张截图各见其一）都实现了：
//   · 大标题页（广播/资料库根页）：左对齐 34px 粗体标题；
//   · 表格页（资料库-歌曲）：居中小标题 + 右侧「过滤 / 显示选项」两个图标按钮的浅色工具条。
import { memo, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { MoreHorizontal, Music2, Pause, Play, Search, Star } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { MotionArtworkCover } from '../../components/apple-explore/MotionArtwork'
import type { AppleWebItem } from '../../services/appleWebService'
import type { Song } from '../../services/musicApi'

export type ApplePcTone = 'light' | 'dark'

export interface ApplePcTheme {
  tone: ApplePcTone
  /** 窗口/侧栏底（客户端 #f3f3f3） */
  background: string
  /** 内容区底（客户端 #eeeeee） */
  content: string
  /** 表格/工具条面板底（客户端 #f9f9f9） */
  panel: string
  /** 表格隔行底色 */
  rowAlt: string
  /** 列表悬停底色 */
  hover: string
  /** 选中胶囊（侧栏当前项，客户端 #eaeaea） */
  pill: string
  /** 搜索框底/描边 */
  fieldBg: string
  fieldBorder: string
  divider: string
  text: string
  secondary: string
  tertiary: string
  accent: string
  /** 跟随 tone 的文字色 class（用于 Tailwind 排版细节） */
  textClass: string
  secondaryClass: string
}

export const APPLE_PC_ACCENT = '#fa233b'

export function applePcTheme(tone: ApplePcTone): ApplePcTheme {
  if (tone === 'dark') {
    return {
      tone,
      background: '#232326',
      content: '#1c1c1e',
      panel: '#242426',
      rowAlt: '#1f1f21',
      hover: '#2e2e30',
      pill: '#3a3a3c',
      fieldBg: '#2c2c2e',
      fieldBorder: '#3a3a3c',
      divider: '#38383a',
      text: '#f5f5f7',
      secondary: '#9a9aa0',
      tertiary: '#7c7c81',
      accent: APPLE_PC_ACCENT,
      textClass: 'text-[#f5f5f7]',
      secondaryClass: 'text-[#9a9aa0]',
    }
  }
  return {
    tone,
    background: '#f3f3f3',
    content: '#eeeeee',
    panel: '#f9f9f9',
    rowAlt: '#f3f3f3',
    hover: '#e9e9e9',
    pill: '#eaeaea',
    fieldBg: '#fbfbfb',
    fieldBorder: '#e5e5e5',
    divider: '#e5e5e5',
    text: '#252525',
    secondary: '#7a7a7a',
    tertiary: '#a1a1a6',
    accent: APPLE_PC_ACCENT,
    textClass: 'text-[#252525]',
    secondaryClass: 'text-[#7a7a7a]',
  }
}

/* ------------------------------------------------------------------ *
 * 品牌图形
 * ------------------------------------------------------------------ */

/** Apple Music 双联音符（客户端应用图标里的白色音符；形状与探索页 MusicGlyph 同源）。 */
export function AppleMusicNoteGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} style={style} aria-hidden="true">
      <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 17 4.2v9.47a3 3 0 1 1-2-2.83V8.06l-6 1.5v8.94Z" />
    </svg>
  )
}

/** Apple Music 应用图标：圆角红底 + 白色音符（客户端标题栏/订阅页同款）。 */
export function AppleMusicAppIcon({ className = 'h-5 w-5', radius = 5 }: { className?: string; radius?: number }) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden ${className}`}
      style={{ borderRadius: radius, background: 'linear-gradient(180deg, #fb5c74 0%, #fa233b 55%, #e11c34 100%)' }}
      aria-hidden="true"
    >
      <AppleMusicNoteGlyph className="h-[62%] w-[62%] text-white" />
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 页面骨架
 * ------------------------------------------------------------------ */

/** 客户端内容区左右内边距（截图中标题/卡片距内容区左缘 40px）。 */
export const APPLE_PC_PAD = 40

/** 大标题页（广播/资料库根页）：34px 粗体、黑色（深色 #f5f5f7）。 */
export function ApplePcTitle({ children, theme, className = '' }: { children: ReactNode; theme: ApplePcTheme; className?: string }) {
  return (
    <h1 className={`text-[34px] font-bold leading-tight tracking-[-0.01em] ${theme.textClass} ${className}`} style={{ color: theme.text }}>
      {children}
    </h1>
  )
}

/** 表格页工具条：居中小标题 + 右侧图标按钮（客户端「过滤 / 显示选项」）。 */
export function ApplePcToolbar({ title, theme, actions }: { title: string; theme: ApplePcTheme; actions?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center border-b px-3" style={{ background: theme.panel, borderColor: theme.divider }}>
      <span className="w-32 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-center text-[13px] font-medium" style={{ color: theme.text }}>{title}</span>
      <span className="flex w-32 shrink-0 items-center justify-end gap-1">{actions}</span>
    </div>
  )
}

/** 工具条图标按钮（过滤/显示选项等）。 */
export function ApplePcIconButton({ children, onClick, title, theme, active = false }: { children: ReactNode; onClick?: () => void; title: string; theme: ApplePcTheme; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-7 w-7 items-center justify-center rounded-md transition"
      style={{ color: active ? theme.accent : theme.secondary, background: active ? theme.hover : undefined }}
      onMouseEnter={event => { if (!active) event.currentTarget.style.background = theme.hover }}
      onMouseLeave={event => { if (!active) event.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

/** 行内「播放全部」红色胶囊（客户端专辑/歌单头部的播放按钮）。 */
export function ApplePcPlayButton({ label = '播放', onClick, accent, disabled }: { label?: string; onClick?: () => void; accent: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium text-white transition hover:brightness-110 disabled:opacity-45"
      style={{ background: accent }}
    >
      <Play className="h-3.5 w-3.5 fill-current" />
      {label}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 封面
 * ------------------------------------------------------------------ */

/** 动态封面规格（与探索页 MotionArtworkCover 同一套实现与缓存）：
 *  resourceId 必须是**目录 id**（catalogId/playId）——库内 id（l./p. 前缀）拉不到动态封面，
 *  调用方拿不到目录 id 时不要传 motion（避免每张卡打一次 404）。 */
export interface ApplePcMotionSpec {
  id: string
  resourceId: string
  type: 'playlists' | 'albums' | 'stations'
  name: string
  storefront: string
  artworkUrl?: string
  /** 接口已带动态封面（editorialVideo）时直接给，省一次查询 */
  videoUrl?: string
  posterUrl?: string
}

export function ApplePcCover({ src, alt, className, rounded = 8, eager = false, overlay, motion }: {
  src?: string
  alt: string
  className: string
  rounded?: number
  eager?: boolean
  overlay?: ReactNode
  motion?: ApplePcMotionSpec | null
}) {
  // 尺寸类（aspect-*/w-full）始终挂在**最外层**：封面没加载完/加载失败时卡片也保持版式，
  // 内层图层一律 absolute inset-0（此前尺寸类挂在图片上，图片一失败卡片就塌成一条 alt 文本）。
  const url = (src || '').trim()
  const fallback = (
    <span
      aria-label={`${alt} 封面占位`}
      className="absolute inset-0 flex items-center justify-center"
      style={{ background: 'rgba(128,128,128,0.18)' }}
    >
      <Music2 className="h-1/3 w-1/3 opacity-50" />
    </span>
  )
  return (
    <span className={`relative block overflow-hidden ${className}`} style={{ borderRadius: rounded }}>
      {motion ? (
        // 动态封面：静态封面打底 + HLS 动画层（靠近视口自动播、离屏回收）——与探索页同一行为
        <MotionArtworkCover
          item={{
            id: motion.id,
            playId: motion.resourceId,
            type: motion.type,
            name: motion.name || alt,
            artworkUrl: motion.artworkUrl || url,
            motionArtworkUrl: motion.videoUrl,
            motionPosterUrl: motion.posterUrl,
          }}
          storefront={motion.storefront}
          className="absolute inset-0 h-full w-full"
        />
      ) : url ? (
        <CachedImage
          src={url}
          alt={alt}
          className="absolute inset-0 h-full w-full object-cover"
          lazy={!eager}
          priority="visible"
          role="card"
          platform="apple"
          retainPrevious
          fallback={fallback}
        />
      ) : fallback}
      {overlay}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 卡片
 * ------------------------------------------------------------------ */

export interface ApplePcCardItem {
  key: string
  coverUrl?: string
  title: string
  subtitle?: string
  /** 圆形封面（艺人） */
  round?: boolean
  onClick?: () => void
  onContextMenu?: (event: ReactMouseEvent) => void
  overlay?: ReactNode
  /** 动态封面（专辑/歌单/电台卡）：与探索页同一套 HLS 动画 + 可见性调度 */
  motion?: ApplePcMotionSpec | null
}

/** 方形封面网格（资料库专辑/艺人、播放列表）。 */
export function ApplePcCardGrid({ items, theme, columns = 5, size = 168, showPlayOnHover = true }: { items: ApplePcCardItem[]; theme: ApplePcTheme; columns?: number; size?: number; showPlayOnHover?: boolean }) {
  const colClass = columns >= 6
    ? 'grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6'
    : columns === 5
      ? 'grid-cols-3 md:grid-cols-4 xl:grid-cols-5'
      : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
  return (
    <div className={`grid gap-x-5 gap-y-7 ${colClass}`}>
      {items.map(item => (
        <button key={item.key} type="button" onClick={item.onClick} onContextMenu={item.onContextMenu} className="group block min-w-0 text-left" style={{ maxWidth: size }}>
          <ApplePcCover
            src={item.coverUrl}
            alt={item.title}
            className={item.round ? 'aspect-square w-full rounded-full' : 'aspect-square w-full'}
            rounded={item.round ? 999 : 8}
            eager={false}
            motion={item.round ? null : item.motion}
            overlay={
              <>
                {item.overlay}
                {showPlayOnHover && !item.round && item.onClick && (
                  <span className="absolute bottom-2 right-2 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full opacity-0 shadow-md transition group-hover:translate-y-0 group-hover:opacity-100" style={{ background: 'rgba(255,255,255,0.94)' }}>
                    <Play className="h-3.5 w-3.5 fill-current" style={{ color: theme.accent }} />
                  </span>
                )}
              </>
            }
          />
          <span className="mt-2 block truncate text-[14px] font-medium leading-snug" style={{ color: theme.text }}>{item.title}</span>
          {item.subtitle ? <span className="mt-0.5 block truncate text-[13px]" style={{ color: theme.secondary }}>{item.subtitle}</span> : null}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 歌曲表格（客户端「资料库-歌曲」实测列）
 * ------------------------------------------------------------------ */

export type ApplePcSongSortKey = 'title' | 'duration' | 'artist' | 'album' | 'playCount' | 'added'

export interface ApplePcSongRow {
  song: Song
  /** 资料库曲目 id（删除/收藏用） */
  libraryId?: string
  /** 目录 id（播放/收藏用） */
  catalogId?: string
  /** 类型列（Apple genreNames[0]） */
  genre?: string
  /** 播放次数列（Apple playCount） */
  playCount?: number
  /** 添加日期（客户端「最近添加」排序用） */
  dateAdded?: number
}

export interface ApplePcSongsTableProps {
  rows: ApplePcSongRow[]
  theme: ApplePcTheme
  /** 收藏（♥★）判定：按目录 id */
  lovedIds?: Set<string>
  onToggleLoved?: (row: ApplePcSongRow, next: boolean) => void
  onPlay?: (row: ApplePcSongRow, index: number) => void
  onMenu?: (event: ReactMouseEvent, song: Song) => void
  playingKey?: string
  isPlaying?: boolean
  loading?: boolean
  empty?: ReactNode
  /** 显示「类型 / 播放次数」列（数据缺失时调用方传 false，避免空列） */
  showGenre?: boolean
  showPlayCount?: boolean
  /** 显示「添加日期」列（资料库「最近添加」用） */
  showAdded?: boolean
  /** 表格工具条（客户端表格页头）：由页面传入标题与过滤/显示选项按钮 */
  toolbar?: ReactNode
  /** 关键词过滤（工具条「过滤」输入框的值由页面托管） */
  filter?: string
  /** 初始排序（「最近添加」用添加日期倒序；默认按标题升序） */
  initialSort?: { key: ApplePcSongSortKey; dir: 'asc' | 'desc' }
}

const APPLE_PC_SONG_COLUMNS: Array<{ key: ApplePcSongSortKey; label: string; width: number; sortable: boolean }> = [
  { key: 'title', label: '标题', width: 0, sortable: true },
  { key: 'duration', label: '时长', width: 48, sortable: true },
  { key: 'artist', label: '艺人', width: 141, sortable: true },
  { key: 'album', label: '专辑', width: 145, sortable: true },
  { key: 'playCount', label: '播放次数', width: 96, sortable: true },
]

/**
 * 客户端歌曲表：标题 / 时长 / 艺人 / 专辑 / 类型 / ♥ / 播放次数，
 * 行高 40px、隔行浅底、悬停出现「⋯」（走全局歌曲右键菜单）、行双击播放。
 * 表头点击排序（客户端表头带排序箭头）。
 */
export const ApplePcSongsTable = memo(function ApplePcSongsTable({
  rows, theme, lovedIds, onToggleLoved, onPlay, onMenu, playingKey, isPlaying,
  loading, empty, showGenre = true, showPlayCount = true, showAdded = false, toolbar, filter, initialSort,
}: ApplePcSongsTableProps) {
  const [sort, setSort] = useState<{ key: ApplePcSongSortKey; dir: 'asc' | 'desc' }>(() => initialSort ?? { key: 'title', dir: 'asc' })

  const filtered = useMemo(() => {
    const keyword = (filter || '').trim().toLowerCase()
    if (!keyword) return rows
    return rows.filter(row => {
      const song = row.song
      const haystack = [song.name, song.artists?.map(artist => artist.name).join('/'), song.album?.name, row.genre]
        .filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(keyword)
    })
  }, [rows, filter])

  const sorted = useMemo(() => {
    const list = [...filtered]
    const dir = sort.dir === 'asc' ? 1 : -1
    const value = (row: ApplePcSongRow) => {
      switch (sort.key) {
        case 'title': return row.song.name || ''
        case 'duration': return row.song.duration || 0
        case 'artist': return row.song.artists?.[0]?.name || ''
        case 'album': return row.song.album?.name || ''
        case 'playCount': return row.playCount || 0
        case 'added': return row.dateAdded || 0
        default: return ''
      }
    }
    list.sort((a, b) => {
      const av = value(a); const bv = value(b)
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv), 'zh-Hans-CN') * dir
    })
    return list
  }, [filtered, sort])

  const toggleSort = (key: ApplePcSongSortKey) => {
    setSort(prev => prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
  }

  const formatDuration = (ms?: number) => {
    const total = Math.round((Number(ms) || 0) / 1000)
    if (!total) return ''
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  /** 添加日期列（客户端与「播放时间」同口径：今年 MM-DD，跨年 YYYY-MM-DD）。 */
  const formatAdded = (value?: number) => {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (part: number) => String(part).padStart(2, '0')
    if (date.getFullYear() !== new Date().getFullYear()) return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  const headCell = (column: { key: ApplePcSongSortKey; label: string; width: number; sortable: boolean }) => {
    const active = sort.key === column.key
    return (
      <button
        key={column.key}
        type="button"
        onClick={() => column.sortable && toggleSort(column.key)}
        className="flex items-center gap-1 whitespace-nowrap text-left text-[12px] font-normal transition"
        style={{
          width: column.width ? column.width : undefined,
          flex: column.width ? '0 0 auto' : '1 1 262px',
          minWidth: column.width ? undefined : 140,
          color: active ? theme.text : theme.secondary,
        }}
      >
        {column.label}
        {active && (
          <svg viewBox="0 0 8 6" className="h-[6px] w-2 shrink-0" aria-hidden="true" style={{ transform: sort.dir === 'desc' ? 'rotate(180deg)' : undefined }}>
            <path d="M4 0 8 6H0z" fill={theme.secondary} />
          </svg>
        )}
      </button>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: theme.content }}>
      {toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto apple-pc-scroll">
        <div className="sticky top-0 z-10 flex items-center gap-0 border-b px-11" style={{ background: theme.panel, borderColor: theme.divider, height: 32 }}>
          {headCell(APPLE_PC_SONG_COLUMNS[0])}
          {headCell(APPLE_PC_SONG_COLUMNS[1])}
          {headCell(APPLE_PC_SONG_COLUMNS[2])}
          {headCell(APPLE_PC_SONG_COLUMNS[3])}
          {showGenre && <span className="whitespace-nowrap text-[12px]" style={{ flex: '0 0 110px', color: theme.secondary }}>类型</span>}
          <span className="flex items-center justify-center" style={{ flex: '0 0 56px', color: theme.secondary }}>
            <Star className="h-3.5 w-3.5" />
          </span>
          {showPlayCount && headCell(APPLE_PC_SONG_COLUMNS[4])}
          {showAdded && headCell({ key: 'added', label: '添加日期', width: 96, sortable: true })}
        </div>

        {loading ? (
          <div className="py-20 text-center text-[13px]" style={{ color: theme.secondary }}>正在加载…</div>
        ) : sorted.length === 0 ? (
          <>{empty ?? <ApplePcEmpty theme={theme} title={filter ? '没有匹配的歌曲' : '空空如也'} />}</>
        ) : sorted.map((row, index) => {
          const key = row.catalogId || row.libraryId || `${row.song.id}:${index}`
          const active = Boolean(playingKey) && playingKey === key
          const loved = Boolean(row.catalogId && lovedIds?.has(row.catalogId))
          return (
            <div
              key={`${key}:${index}`}
              onDoubleClick={() => onPlay?.(row, index)}
              onContextMenu={event => onMenu?.(event, row.song)}
              className="group flex items-center border-b px-11"
              style={{ height: 40, borderColor: theme.divider, background: index % 2 === 0 ? theme.panel : theme.rowAlt }}
            >
              <span className="flex min-w-0 items-center" style={{ flex: '1 1 262px', minWidth: 140 }}>
                <button
                  type="button"
                  onClick={() => onPlay?.(row, index)}
                  className="min-w-0 truncate text-left text-[13px]"
                  style={{ color: active ? theme.accent : theme.text }}
                  title={row.song.name}
                >
                  {row.song.name}
                </button>
                <span className="ml-2 hidden shrink-0 group-hover:flex">
                  <button
                    type="button"
                    onClick={event => { event.stopPropagation(); onMenu?.(event, row.song) }}
                    aria-label="更多"
                    className="flex h-5 w-5 items-center justify-center rounded"
                    style={{ color: theme.secondary }}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </span>
              </span>
              <span className="text-[12px] tabular-nums" style={{ flex: '0 0 48px', color: theme.secondary }}>{formatDuration(row.song.duration)}</span>
              <span className="truncate pr-2 text-[12px]" style={{ flex: '0 0 141px', color: theme.secondary }}>{row.song.artists?.map(artist => artist.name).join(', ')}</span>
              <span className="truncate pr-2 text-[12px]" style={{ flex: '0 0 145px', color: theme.secondary }} title={row.song.album?.name || ''}>{row.song.album?.name || ''}</span>
              {showGenre && <span className="truncate pr-2 text-[12px]" style={{ flex: '0 0 110px', color: theme.secondary }}>{row.genre || ''}</span>}
              <span className="flex justify-center" style={{ flex: '0 0 56px' }}>
                <button
                  type="button"
                  onClick={() => onToggleLoved?.(row, !loved)}
                  aria-label={loved ? '取消喜爱' : '喜爱'}
                  className="flex h-6 w-6 items-center justify-center rounded-full transition"
                >
                  <Star className="h-3.5 w-3.5" style={{ color: loved ? theme.accent : theme.tertiary, fill: loved ? theme.accent : 'transparent' }} />
                </button>
              </span>
              {showPlayCount && (
                <span className="text-[12px] tabular-nums" style={{ flex: '0 0 96px', color: theme.secondary }}>{row.playCount ? row.playCount : ''}</span>
              )}
              {showAdded && (
                <span className="text-[12px] tabular-nums" style={{ flex: '0 0 96px', color: theme.secondary }}>{formatAdded(row.dateAdded)}</span>
              )}
              {active && isPlaying ? <Pause className="ml-2 hidden h-3 w-3" /> : null}
            </div>
          )
        })}
      </div>
    </div>
  )
})

/** 过滤输入框（表格页工具条开启「过滤」后出现，客户端同款位置：标题右侧）。 */
export function ApplePcFilterField({ value, onChange, theme, placeholder = '搜索' }: { value: string; onChange: (next: string) => void; theme: ApplePcTheme; placeholder?: string }) {
  return (
    <label className="flex h-7 w-44 items-center gap-1.5 rounded-md px-2" style={{ background: theme.fieldBg, border: `1px solid ${theme.fieldBorder}` }}>
      <Search className="h-3.5 w-3.5 shrink-0" style={{ color: theme.tertiary }} />
      <input
        autoFocus
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none"
        style={{ color: theme.text }}
      />
    </label>
  )
}

/** 工具条上的列显示开关（「显示选项」）：真实影响表格列，不做死按钮。 */
export function ApplePcColumnMenu({ theme, showGenre, showPlayCount, onToggleGenre, onTogglePlayCount, onClose }: {
  theme: ApplePcTheme
  showGenre: boolean
  showPlayCount: boolean
  onToggleGenre: (next: boolean) => void
  onTogglePlayCount: (next: boolean) => void
  onClose: () => void
}) {
  const item = (label: string, checked: boolean, onChange: (next: boolean) => void) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] transition"
      style={{ color: theme.text }}
      onMouseEnter={event => { event.currentTarget.style.background = theme.hover }}
      onMouseLeave={event => { event.currentTarget.style.background = 'transparent' }}
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[9px] font-bold text-white" style={{ borderColor: checked ? theme.accent : theme.fieldBorder, background: checked ? theme.accent : 'transparent' }}>
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  )
  return (
    <div className="absolute right-2 top-9 z-30 w-40 rounded-lg p-1 shadow-xl" style={{ background: theme.panel, border: `1px solid ${theme.divider}`, position: 'absolute' }} onClick={event => event.stopPropagation()}>
      <div className="px-2.5 py-1 text-[11px]" style={{ color: theme.tertiary }}>显示的列</div>
      {item('类型', showGenre, onToggleGenre)}
      {item('播放次数', showPlayCount, onTogglePlayCount)}
      <button type="button" onClick={onClose} className="mt-0.5 w-full rounded-md px-2.5 py-1 text-left text-[12px]" style={{ color: theme.secondary }}>完成</button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 空态 / 工具
 * ------------------------------------------------------------------ */

export function ApplePcEmpty({ theme, title = '空空如也', description, action }: { theme: ApplePcTheme; title?: string; description?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: theme.tone === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)' }}>
        <Music2 className="h-7 w-7" style={{ color: theme.tertiary }} />
      </span>
      <p className="mt-4 text-[14px]" style={{ color: theme.secondary }}>{title}</p>
      {description ? <p className="mt-1 text-[12px]" style={{ color: theme.tertiary }}>{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** 页面级加载/报错（客户端内容区居中提示）。 */
export function ApplePcNotice({ theme, title, description, action, tone = 'muted' }: { theme: ApplePcTheme; title: string; description?: string; action?: ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-[15px] font-medium" style={{ color: tone === 'warning' ? theme.accent : theme.text }}>{title}</p>
      {description ? <p className="mt-2 max-w-md text-[13px] leading-relaxed" style={{ color: theme.secondary }}>{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}

/** 红色胶囊按钮（订阅/播放全部等客户端主操作）。 */
export function ApplePcPillButton({ label, onClick, accent, className = '', icon }: { label: string; onClick?: () => void; accent: string; className?: string; icon?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-full px-5 text-[14px] font-medium text-white transition hover:brightness-110 ${className}`}
      style={{ background: accent }}
    >
      {icon}
      {label}
    </button>
  )
}

/** 次要胶囊按钮（客户端「重试 / 以后再说」这类浅底操作）。 */
export function ApplePcGhostButton({ label, onClick, theme, className = '' }: { label: string; onClick?: () => void; theme: ApplePcTheme; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-9 items-center justify-center rounded-full px-5 text-[14px] font-medium transition ${className}`}
      style={{ background: theme.panel, border: `1px solid ${theme.divider}`, color: theme.text }}
    >
      {label}
    </button>
  )
}

/**
 * 订阅失效 / 无权限状态（Apple 资料库类接口在会员过期时会返回 40015 权限不足）。
 *
 * 文案用客户端自带说明（Apple Music 客户端的本地化串）：
 * 「当你的会员资格暂停后，你的 Apple Music 歌曲和播放列表将保留在资料库中，但不能播放或修改。」
 * ——这条正是客户端在订阅失效时对资料库的官方解释，本软件同样读不到资料库时如实展示，
 * 并提供与客户端一致的续订入口（免费试用 → 站内购买窗口）。
 */
export function ApplePcSubscriptionNotice({ theme, accent, detail, onRetry, onSubscribe }: {
  theme: ApplePcTheme
  accent: string
  /** 具体失败原因（来自服务层统一解读，例如「Apple Music 订阅已失效，暂时无法使用「资料库」…」） */
  detail?: string
  onRetry?: () => void
  onSubscribe: () => void
}) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center" data-testid="apple-pc-subscription-notice">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl" style={{ background: theme.tone === 'light' ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)' }}>
        <Star className="h-7 w-7" style={{ color: theme.tertiary }} />
      </span>
      <p className="mt-4 text-[16px] font-semibold" style={{ color: theme.text }}>Apple Music 订阅已失效</p>
      <p className="mt-2 max-w-[520px] text-[13px] leading-relaxed" style={{ color: theme.secondary }}>
        当你的会员资格暂停后，你的 Apple Music 歌曲和播放列表将保留在资料库中，但不能播放或修改。续订后本页会自动恢复。
      </p>
      {detail ? <p className="mt-1.5 max-w-[520px] text-[12px]" style={{ color: theme.tertiary }}>{detail}</p> : null}
      <div className="mt-5 flex items-center gap-3">
        <ApplePcPillButton label="免费试用" onClick={onSubscribe} accent={accent} />
        {onRetry ? <ApplePcGhostButton label="重试" onClick={onRetry} theme={theme} /> : null}
      </div>
    </div>
  )
}
