/**
 * 移动端共享 UI 基件：图标（内联 SVG）、封面、歌曲行、轻提示、加载态、格式化工具。
 * 独立于桌面端组件（不复用 PlayerControls 等 PC 布局），保证移动端视觉自成体系。
 */
import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import CachedImage from '../components/CachedImage'
import { getProxiedImageUrl, qqSongCoverUrl, type Song } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { platformLabel } from '../services/platforms'

// ── 图标（线性 SVG，24 网格，currentColor）──
type IconProps = { size?: number; className?: string }
const svg = (path: ReactNode, extra?: string) => memo(({ size = 24, className }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"
    className={[className, extra].filter(Boolean).join(' ')} aria-hidden>
    {path}
  </svg>
))

export const IconHome = svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></>)
export const IconSearch = svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>)
export const IconLibrary = svg(<><path d="M4 4v16" /><path d="M9 4v16" /><path d="m14 5 5 15" /></>)
export const IconSettings = svg(<><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z" /></>)
export const IconPlay = svg(<path d="M7 4.8v14.4c0 .9.98 1.45 1.74.95l11.1-7.2a1.13 1.13 0 0 0 0-1.9L8.74 3.85A1.13 1.13 0 0 0 7 4.8z" />, 'fill-current')
export const IconPause = svg(<><rect x="6" y="4" width="4" height="16" rx="1.2" /><rect x="14" y="4" width="4" height="16" rx="1.2" /></>, 'fill-current')
export const IconNext = svg(<><path d="M5 5.5v13l9-6.5z" /><path d="M18 5v14" /></>, 'fill-current')
export const IconPrev = svg(<><path d="M19 5.5v13l-9-6.5z" /><path d="M6 5v14" /></>, 'fill-current')
export const IconShuffle = svg(<><path d="M3 6h3.5c5.5 0 8.5 12 14 12H21" /><path d="M3 18h3.5c2.2 0 3.9-2 5.2-4.4" /><path d="M13.6 9.9C14.9 7.8 16.5 6 18.5 6H21" /><path d="m18 3 3 3-3 3" /><path d="m18 15 3 3-3 3" /></>)
export const IconRepeat = svg(<><path d="M17 2.5 21 6l-4 3.5" /><path d="M3 12V9a3 3 0 0 1 3-3h15" /><path d="m7 21.5-4-3.5 4-3.5" /><path d="M21 12v3a3 3 0 0 1-3 3H3" /></>)
export const IconRepeatOne = svg(<><path d="M17 2.5 21 6l-4 3.5" /><path d="M3 12V9a3 3 0 0 1 3-3h15" /><path d="m7 21.5-4-3.5 4-3.5" /><path d="M21 12v3a3 3 0 0 1-3 3H3" /><path d="M12 15V9l-1.5 1.2" /></>)
export const IconQueue = svg(<><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h10" /><path d="m18.5 15.5 3 2.5-3 2.5" /></>)
export const IconHeart = svg(<path d="M12 20.5s-7.5-4.7-9.4-9.3C1.2 7.7 3.4 4.5 6.7 4.5c2 0 3.6 1.1 5.3 3.3 1.7-2.2 3.3-3.3 5.3-3.3 3.3 0 5.5 3.2 4.1 6.7-1.9 4.6-9.4 9.3-9.4 9.3z" />)
export const IconHeartFilled = svg(<path d="M12 20.5s-7.5-4.7-9.4-9.3C1.2 7.7 3.4 4.5 6.7 4.5c2 0 3.6 1.1 5.3 3.3 1.7-2.2 3.3-3.3 5.3-3.3 3.3 0 5.5 3.2 4.1 6.7-1.9 4.6-9.4 9.3-9.4 9.3z" />, 'fill-current')
export const IconChevronLeft = svg(<path d="m14.5 5-7 7 7 7" />)
export const IconChevronRight = svg(<path d="m9.5 5 7 7-7 7" />)
export const IconClose = svg(<><path d="m5.5 5.5 13 13" /><path d="m18.5 5.5-13 13" /></>)
export const IconVolume = svg(<><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z" /><path d="M15.5 9a4.3 4.3 0 0 1 0 6" /><path d="M18 6.5a8 8 0 0 1 0 11" /></>)
export const IconMore = svg(<><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>, 'fill-current')
export const IconDownload = svg(<><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>)
export const IconUser = svg(<><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5c1.5-3.5 4.2-5 7.5-5s6 1.5 7.5 5" /></>)
export const IconRefresh = svg(<><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 3.5V8h-4.5" /></>)
export const IconFire = svg(<path d="M12 3s1 2.2-.8 4.6C9.6 9.7 7 11 7 14a5 5 0 0 0 10 0c0-1.6-.7-2.7-1.4-3.6-.5 1-1.2 1.6-2.1 1.9.5-2.5-.3-6-1.5-9.3z" />)
export const IconClock = svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>)
export const IconChevronDown = svg(<path d="m5 9.5 7 7 7-7" />)
export const IconPlayCircle = svg(<><circle cx="12" cy="12" r="9" /><path d="M10 8.6v6.8c0 .8.9 1.3 1.6.9l5-3.4c.6-.4.6-1.4 0-1.8l-5-3.4c-.7-.4-1.6.1-1.6.9z" /></>)
export const IconSearchDel = svg(<><circle cx="12" cy="12" r="8.5" /><path d="M9.5 9.5l5 5M14.5 9.5l-5 5" /></>)

// ── 工具 ──
export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function fmtCount(n?: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}

/** 歌曲封面（平台感知：QQ 走 y.gtimg 规律，其余走代理）。 */
export function songCoverUrl(song: Song | null | undefined, size = 300): string {
  if (!song) return ''
  const qq = qqSongCoverUrl(song)
  if (qq) return getProxiedImageUrl(qq, size)
  if (song.album?.picUrl) return getProxiedImageUrl(song.album.picUrl, size)
  return ''
}

export function songArtists(song: Song | null | undefined): string {
  if (!song) return ''
  return (song.artists || []).map(a => a.name).filter(Boolean).join(' / ')
}

// ── 封面卡片 ──
export const Cover = memo(function Cover({ song, url, size = 300, className, rounded = 12 }: {
  song?: Song | null
  url?: string
  size?: number
  className?: string
  rounded?: number
}) {
  const src = url || songCoverUrl(song, size)
  return (
    <div className={`wf-m-cover ${className || ''}`} style={{ borderRadius: rounded }}>
      {src ? (
        <CachedImage src={src} alt="" size={size} fit="cover" platform={song?.platform} />
      ) : (
        <div className="wf-m-cover-fallback"><IconMusicNote /></div>
      )}
    </div>
  )
})

export const IconMusicNote = svg(<><circle cx="8" cy="17.5" r="3" /><circle cx="18" cy="15.5" r="3" /><path d="M11 17.5V6l10-2v11.5" /></>)

// ── VIP / 无版权角标 ──
export function SongBadges({ song }: { song: Song }) {
  return (
    <span className="wf-m-badges">
      {song.vip && <span className="wf-m-badge-vip">VIP</span>}
      {song.noCopyright && <span className="wf-m-badge-gray">无版权</span>}
    </span>
  )
}

// ── 歌曲行 ──
export interface SongRowProps {
  song: Song
  index?: number
  active?: boolean
  playing?: boolean
  favorite?: boolean
  onTap?: (song: Song, index: number) => void
  onFavorite?: (song: Song) => void
  trailing?: ReactNode
}

export const SongRow = memo(function SongRow({ song, index = -1, active, playing, favorite, onTap, onFavorite, trailing }: SongRowProps) {
  const platformTag = song.platform ? platformLabel(song.platform) : ''
  return (
    <button
      type="button"
      className={`wf-m-song-row ${active ? 'is-active' : ''}`}
      onClick={() => onTap?.(song, index)}
    >
      {index >= 0 && (
        <span className={`wf-m-song-index ${active ? 'is-active' : ''}`}>
          {active && playing ? <IconPause size={12} /> : index + 1}
        </span>
      )}
      <Cover song={song} size={96} rounded={8} className="wf-m-song-cover" />
      <span className="wf-m-song-meta">
        <span className="wf-m-song-name">
          {song.name}
          <SongBadges song={song} />
        </span>
        <span className="wf-m-song-sub">
          {songArtists(song)}
          {song.album?.name ? ` · ${song.album.name}` : ''}
          {!songArtists(song) && platformTag ? platformTag : ''}
        </span>
      </span>
      {onFavorite && (
        <span
          role="button"
          className={`wf-m-song-heart ${favorite ? 'is-on' : ''}`}
          onClick={e => { e.stopPropagation(); onFavorite(song) }}
        >
          {favorite ? <IconHeartFilled size={20} /> : <IconHeart size={20} />}
        </span>
      )}
      {trailing}
    </button>
  )
})

// ── 轻提示（模块级事件，任意处 fire）──
type ToastKind = 'info' | 'success' | 'error'
interface ToastItem { id: number; text: string; kind: ToastKind }

let toastSeq = 1
const toastListeners = new Set<(items: ToastItem[]) => void>()
let toastItems: ToastItem[] = []

export function mobileToast(text: string, kind: ToastKind = 'info') {
  const item: ToastItem = { id: toastSeq++, text, kind }
  toastItems = [...toastItems.slice(-2), item]
  toastListeners.forEach(l => l(toastItems))
  window.setTimeout(() => {
    toastItems = toastItems.filter(t => t.id !== item.id)
    toastListeners.forEach(l => l(toastItems))
  }, 2600)
}

export function MobileToastHost() {
  const [items, setItems] = useState<ToastItem[]>([])
  useEffect(() => {
    toastListeners.add(setItems)
    return () => { toastListeners.delete(setItems) }
  }, [])
  return (
    <div className="wf-m-toasts">
      {items.map(t => (
        <div key={t.id} className={`wf-m-toast is-${t.kind}`}>{t.text}</div>
      ))}
    </div>
  )
}

// ── 加载骨架 / 空态 ──
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="wf-m-loading">
      <span className="wf-m-spinner" />
      {label && <span>{label}</span>}
    </div>
  )
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="wf-m-empty">
      <p>{text}</p>
      {action}
    </div>
  )
}

export function ErrorRetry({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="wf-m-empty">
      <p>{text}</p>
      <button type="button" className="wf-m-btn" onClick={onRetry}>
        <IconRefresh size={16} /> 重试
      </button>
    </div>
  )
}

// ── 平台徽标色 ──
export const PLATFORM_ACCENT: Record<MusicPlatform, string> = {
  netease: '#e60026',
  qq: '#31c27c',
  apple: '#fa2d48',
  spotify: '#1db954',
  kugou: '#2ca7f8',
  soda: '#ffc200',
}

// ── 骨架屏（官方 App 首屏加载态：shimmer 渐变扫过）──
export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="wf-m-skel-grid">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="wf-m-skel-card">
          <div className="wf-m-skel-cover wf-m-skel" />
          <div className="wf-m-skel-line wf-m-skel" style={{ width: '86%' }} />
          <div className="wf-m-skel-line wf-m-skel" style={{ width: '54%' }} />
        </div>
      ))}
    </div>
  )
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div className="wf-m-skel-rows">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="wf-m-skel-row">
          <div className="wf-m-skel-thumb wf-m-skel" />
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="wf-m-skel-line wf-m-skel" style={{ width: '62%' }} />
            <div className="wf-m-skel-line wf-m-skel" style={{ width: '40%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── 分区标题（官方样式：左侧主标题 + 可选「更多」箭头）──
export function SectionHeader({ title, onMore }: { title: string; onMore?: () => void }) {
  return (
    <div className="wf-m-sec-head">
      <h3 className="wf-m-sec-title">{title}</h3>
      {onMore && (
        <button type="button" className="wf-m-sec-more" onClick={onMore}>
          更多 <IconChevronRight size={13} />
        </button>
      )}
    </div>
  )
}

// ── 播放量角标（封面左下：▶ 5.5万）──
export function PlayCountBadge({ count }: { count?: number }) {
  if (!count || count <= 0) return null
  return <span className="wf-m-playcount"><IconPlay size={9} />{fmtCount(count)}</span>
}

// ── 触控安全的长列表（懒渲染 + 触底加载）──
export function useLazyList(total: number, step = 60) {
  const [visible, setVisible] = useState(Math.min(step, total))
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    setVisible(Math.min(step, total))
  }, [total, step])
  useEffect(() => {
    const el = sentinelRef.current
    if (!el || visible >= total) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setVisible(v => Math.min(v + step, total))
      }
    }, { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [visible, total, step])
  return { visible, sentinelRef }
}
