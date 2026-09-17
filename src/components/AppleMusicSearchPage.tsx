/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 搜索页（1:1 复刻 music.apple.com/cn/search）
 *
 * 实测官网结构（调试浏览器抓取，term=collage）：
 * - 顶部：搜索框 + 两档范围切换（在 Apple Music 中搜索 / 在资料库中搜索）
 * - 无关键词：落地视图（类别浏览）
 * - 有关键词：**6 个分区**，固定顺序
 *   最佳结果 → 艺人 → 专辑 → 歌曲 → 播放列表 → 音乐视频
 *   · 最佳结果：3 列横卡（257×88），60×60 封面 + 悬停播放，副标题「歌曲 · Gunna」
 *   · 艺人：圆形封面（实测 border-radius:50%）
 *   · 专辑 / 播放列表：方卡
 *   · 歌曲：**3 行 × 7 列**网格（434×85/项），整体横向滚动（scrollWidth 3285 > 可见 1167）
 *   · 音乐视频：16:9 视频卡
 * - 分区标题本身是**按钮**（带 chevron）：点它进入该分区的「聚焦视图」
 *   （官网实测：URL 不变，页面只留下这一个分区；浏览器后退回到全部结果）。
 *
 * 层级与返回（本站是软件不是浏览器，故显式提供返回按钮）：
 *   落地页（无关键词）→ 全部结果（有结果）→ 分区聚焦（点了某个分区标题）
 *   返回按钮在「不是最外层」时出现，逐级回退：聚焦 → 全部结果 → 落地页 → 隐藏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ArrowLeft, Loader2, Music, Play, Search as SearchIcon, X } from 'lucide-react'
import {
  searchAppleCatalogSections,
  searchAppleLibrarySections,
  getAppleSearchSuggestionItems,
  type AppleSearchSection,
  type AppleSearchSectionItem,
} from '../services/appleCatalog'
import { appleWebItemToSong, type AppleWebItem } from '../services/appleWebService'
import type { SongSelectHandler } from '../types/playbackNavigation'
import CachedImage from './CachedImage'
import { HorizontalShelf } from './apple-explore/HorizontalShelf'


export type AppleSearchScope = 'catalog' | 'library'

/** 类型 → 中文标签（官网副标题形如「歌曲 · 珂拉琪 Collage」） */
const SEARCH_TYPE_LABEL: Record<string, string> = {
  songs: '歌曲',
  albums: '专辑',
  artists: '艺人',
  playlists: '播放列表',
  'music-videos': '音乐视频',
  stations: '电台',
}

/** 歌曲区列数：官网实测 3 行 × 7 列，一屏约 3 列、可左右滑 */
const SONG_ROWS_PER_COLUMN = 3

interface AppleMusicSearchPageProps {
  playerTheme?: 'light' | 'dark'
  storefront?: string
  onSongSelect: SongSelectHandler
  playbackOrigin?: import('../types/playbackNavigation').PlaybackOrigin
  onOpenItem?: (item: AppleWebItem, items: AppleWebItem[]) => void
  onOpenPlaylist?: (playlist: { id: string; name: string; coverImgUrl: string; trackCount: number; creator: string; platform: 'apple' }) => void
  renderLanding?: () => React.ReactNode
}

/** 搜索分区 item → 探索页通用 item（复用现有分派逻辑） */
function toWebItem(item: AppleSearchSectionItem): AppleWebItem {
  return {
    id: item.id,
    playId: item.playId || item.id,
    type: item.type,
    name: item.name,
    subtitle: item.subtitle,
    artworkUrl: item.artworkUrl,
    artistName: item.type === 'songs' || item.type === 'albums' ? item.subtitle : undefined,
    curatorName: item.type === 'playlists' ? item.subtitle : undefined,
    durationMs: item.durationMs,
    trackCount: item.trackCount,
    contentRating: item.contentRating,
    url: item.url,
  } as AppleWebItem
}

export default function AppleMusicSearchPage({
  playerTheme = 'dark',
  storefront,
  onSongSelect,
  playbackOrigin,
  onOpenItem,
  onOpenPlaylist,
  renderLanding,
}: AppleMusicSearchPageProps) {
  const [term, setTerm] = useState('')
  const [scope, setScope] = useState<AppleSearchScope>('catalog')
  const [sections, setSections] = useState<AppleSearchSection[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState<Array<{ term: string; subtitle?: string; artworkUrl?: string }>>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [searched, setSearched] = useState(false)
  /** 分区聚焦视图（官网点分区标题后的状态）：只显示该分区 */
  const [focusedSectionId, setFocusedSectionId] = useState<AppleSearchSection['id'] | null>(null)
  const requestRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/55' : 'text-black/55'
  const textTertiary = isDark ? 'text-white/35' : 'text-black/35'

  // 返回按钮的层级：聚焦视图 → 搜索结果 → 落地页（最外层，无返回按钮）
  const canGoBack = Boolean(focusedSectionId) || searched || Boolean(term.trim())
  const goBack = useCallback(() => {
    // 逐级回退，与官网浏览器后退的语义一致
    if (focusedSectionId) { setFocusedSectionId(null); return }
    if (searched || term.trim()) {
      requestRef.current += 1
      setTerm('')
      setSections([])
      setSearched(false)
      setError('')
      setSuggestions([])
      setFocusedSectionId(null)
    }
  }, [focusedSectionId, searched, term])

  // ── 搜索建议（官网同款下拉） ──
  useEffect(() => {
    if (searched || term.trim().length < 1) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      void getAppleSearchSuggestionItems(term.trim(), storefront || 'cn').then(items => {
        if (!active) return
        setSuggestions(items.slice(0, 8).map(item => ({
          term: item.term,
          subtitle: item.kind === 'topResults'
            ? [SEARCH_TYPE_LABEL[item.type || ''] || '', item.subtitle].filter(Boolean).join(' · ')
            : undefined,
          artworkUrl: item.artworkUrl,
        })))
        setShowSuggestions(true)
      }).catch(() => { if (active) setSuggestions([]) })
    }, 260)
    return () => { active = false; window.clearTimeout(timer) }
  }, [term, searched, storefront])

  const runSearch = useCallback((keyword: string) => {
    const value = keyword.trim()
    if (!value) return
    const requestId = ++requestRef.current
    setTerm(keyword)
    setSearched(true)
    setShowSuggestions(false)
    setFocusedSectionId(null)
    setLoading(true)
    setError('')
    const task = scope === 'library'
      ? searchAppleLibrarySections(value)
      : searchAppleCatalogSections(value, storefront || 'cn')
    void task.then(result => {
      if (requestId !== requestRef.current) return
      setSections(result.sections)
      if (result.errorStatus !== undefined) setError('Apple Music 搜索失败，请稍后重试')
      setLoading(false)
    }).catch(() => {
      if (requestId !== requestRef.current) return
      setSections([])
      setError('Apple Music 搜索失败，请稍后重试')
      setLoading(false)
    })
  }, [scope, storefront])

  const playItem = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => {
    if (!item.playId) return
    const queue = siblings.filter(entry => entry.playId).map(entry => appleWebItemToSong(toWebItem(entry), storefront))
    const target = queue.find(song => String(song.id) === String(item.playId) || String(song.appleId) === String(item.playId))
      || appleWebItemToSong(toWebItem(item), storefront)
    onSongSelect(target, queue.length > 0 ? queue : [target], playbackOrigin)
  }

  const activate = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => {
    if (item.playId && (item.type === 'songs' || item.type === 'music-videos')) { playItem(item, siblings); return }
    if (item.type === 'playlists' && onOpenPlaylist) {
      onOpenPlaylist({
        id: item.id, name: item.name, coverImgUrl: item.artworkUrl || '',
        trackCount: item.trackCount || 0, creator: item.subtitle || 'Apple Music', platform: 'apple',
      })
      return
    }
    onOpenItem?.(toWebItem(item), siblings.map(toWebItem))
  }

  // ── 卡片实现（渲染函数，非内联组件：内联组件每次渲染都是新类型，会重建整棵子树） ──

  const renderTopResultCard = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => (
    <motion.div
      whileHover={{ y: -2 }}
      tabIndex={0}
      data-tv-focus
      className={`group flex cursor-pointer items-center gap-3 overflow-hidden rounded-xl border px-3 py-2 outline-none transition focus-visible:ring-2 focus-visible:ring-[#fa2d48] ${isDark ? 'border-white/[0.08] bg-white/[0.04] hover:bg-white/[0.07]' : 'border-black/[0.07] bg-black/[0.03] hover:bg-black/[0.06]'}`}
      onClick={() => activate(item, siblings)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item, siblings) } }}
    >
      <div className="relative h-[60px] w-[60px] shrink-0 overflow-hidden rounded-lg">
        {item.artworkUrl
          ? <CachedImage src={item.artworkUrl} alt={item.name} className="h-full w-full" role="compact" priority="visible" />
          : <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}><Music className="h-5 w-5 opacity-40" /></div>}
        {item.playId && (
          <button
            type="button"
            aria-label={`播放${item.name}`}
            onClick={event => { event.stopPropagation(); playItem(item, siblings) }}
            className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 backdrop-blur-[1px] transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Play className="h-5 w-5 fill-white text-white" />
          </button>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium leading-tight">{item.name}</p>
        <p className={`mt-0.5 truncate text-xs ${textTertiary}`}>
          {/* 艺人 subtitle 本身就是「艺人」，与类型名重复，去重后再拼（否则「艺人 · 艺人」） */}
          {[SEARCH_TYPE_LABEL[item.type] || '', item.subtitle]
            .filter(value => value && value !== SEARCH_TYPE_LABEL[item.type])
            .join(' · ') || SEARCH_TYPE_LABEL[item.type] || ''}
        </p>
      </div>
    </motion.div>
  )

  const renderArtistCard = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => (
    <motion.div
      whileHover={{ y: -3 }}
      tabIndex={0}
      data-tv-focus
      className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
      onClick={() => activate(item, siblings)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item, siblings) } }}
    >
      <div className={`relative aspect-square w-full overflow-hidden rounded-full border ${isDark ? 'border-white/[0.08]' : 'border-black/[0.06]'}`}>
        {item.artworkUrl
          ? <CachedImage src={item.artworkUrl} alt={item.name} className="h-full w-full transition duration-500 group-hover:scale-[1.03]" role="card" />
          : <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}><Music className="h-7 w-7 opacity-40" /></div>}
      </div>
      <p className="mt-2 truncate text-center text-[13px] font-medium">{item.name}</p>
      <p className={`mt-0.5 truncate text-center text-[11px] ${textTertiary}`}>艺人</p>
    </motion.div>
  )

  const renderSquareCard = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => (
    <motion.div
      whileHover={{ y: -3 }}
      tabIndex={0}
      data-tv-focus
      className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
      onClick={() => activate(item, siblings)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item, siblings) } }}
    >
      <div className="relative overflow-hidden rounded-lg">
        {/* 只用静态编辑封面（不用 editorialVideo 动态封面）。
            实测官网搜索页 0 个 video 元素：播放列表/专辑卡片全部是静态图。
            动态封面的构图与静态编辑图不同（实测「每周热门 100 首」这类卡片会在
            动态帧里丢掉顶部的标题条与 Apple Music 字标），套上去反而与官网不一致。 */}
        {item.artworkUrl
          ? <CachedImage src={item.artworkUrl} alt={item.name} className="aspect-square w-full transition duration-500 group-hover:scale-[1.03]" role="card" priority="visible" />
          : <div className={`flex aspect-square w-full items-center justify-center ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}><Music className="h-7 w-7 opacity-40" /></div>}
        {item.playId && (
          <button
            type="button"
            aria-label={`播放${item.name}`}
            onClick={event => { event.stopPropagation(); playItem(item, siblings) }}
            className="absolute right-2 bottom-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
          >
            <Play className="h-4 w-4 fill-current" />
          </button>
        )}
      </div>
      <p className="mt-2 truncate text-[13px] font-medium leading-tight">
        {item.name}
        {/^explicit$/i.test(String(item.contentRating || '')) && (
          <span className="ml-1 inline-flex h-[13px] w-[13px] translate-y-[1px] items-center justify-center rounded-[2px] bg-white/85 text-[9px] font-bold leading-none text-black">E</span>
        )}
      </p>
      {item.subtitle && <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>{item.subtitle}</p>}
    </motion.div>
  )

  /** 音乐视频：官网是 16:9 视频卡 */
  const renderVideoCard = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => (
    <motion.div
      whileHover={{ y: -3 }}
      tabIndex={0}
      data-tv-focus
      className="group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
      onClick={() => activate(item, siblings)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item, siblings) } }}
    >
      <div className="relative aspect-video overflow-hidden rounded-lg">
        {item.artworkUrl
          ? <CachedImage src={item.artworkUrl} alt={item.name} className="h-full w-full transition duration-500 group-hover:scale-[1.03]" role="card" />
          : <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}><Music className="h-7 w-7 opacity-40" /></div>}
        <button
          type="button"
          aria-label={`播放${item.name}`}
          onClick={event => { event.stopPropagation(); playItem(item, siblings) }}
          className="absolute right-2 bottom-2 flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-md transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Play className="h-4 w-4 fill-current" />
        </button>
      </div>
      <p className="mt-2 truncate text-[13px] font-medium leading-tight">{item.name}</p>
      {item.subtitle && <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>{item.subtitle}</p>}
    </motion.div>
  )

  const renderTrackRow = (item: AppleSearchSectionItem, siblings: AppleSearchSectionItem[]) => (
    <div
      tabIndex={0}
      data-tv-focus
      draggable={false}
      className={`group flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 outline-none transition focus-visible:ring-2 focus-visible:ring-[#fa2d48] ${isDark ? 'hover:bg-white/[0.05]' : 'hover:bg-black/[0.04]'}`}
      onClick={() => activate(item, siblings)}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(item, siblings) } }}
    >
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md">
        {item.artworkUrl
          ? <CachedImage src={item.artworkUrl} alt={item.name} className="h-full w-full" role="compact" />
          : <div className={`flex h-full w-full items-center justify-center ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}><Music className="h-4 w-4 opacity-40" /></div>}
        <button
          type="button"
          aria-label={`播放${item.name}`}
          onClick={event => { event.stopPropagation(); playItem(item, siblings) }}
          className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Play className="h-4 w-4 fill-white text-white" />
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
        {item.subtitle && <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>{item.subtitle}</p>}
      </div>
    </div>
  )

  /** 分区标题：可点（官网实测是带 chevron 的按钮）→ 进入该分区聚焦视图 */
  const renderSectionHeading = (section: AppleSearchSection) => (
    <button
      type="button"
      aria-label={`查看全部${section.title}`}
      onClick={() => { setFocusedSectionId(section.id); }}
      className="group flex items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
    >
      <h2 className="text-xl font-bold tracking-tight">{section.title}</h2>
      <svg viewBox="0 0 64 64" aria-hidden="true" className="h-4 w-4 text-white/45 transition group-hover:translate-x-0.5 group-hover:text-white">
        <path fill="currentColor" d="M19.817 61.863c1.48 0 2.672-.515 3.702-1.546l24.243-23.63c1.352-1.385 1.996-2.737 2.028-4.443 0-1.674-.644-3.09-2.028-4.443L23.519 4.138c-1.03-.998-2.253-1.513-3.702-1.513-2.994 0-5.409 2.382-5.409 5.344 0 1.481.612 2.833 1.739 3.96l20.99 20.347-20.99 20.283c-1.127 1.126-1.739 2.478-1.739 3.96 0 2.93 2.415 5.344 5.409 5.344" />
      </svg>
    </button>
  )

  const renderSection = (section: AppleSearchSection, showHeading = true) => {
    const heading = showHeading ? renderSectionHeading(section) : null
    if (section.id === 'top') {
      return (
        <section key={section.id} className="space-y-3">
          {heading}
          <div className="grid grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
            {section.items.map(item => <div key={`top-${item.type}-${item.id}`}>{renderTopResultCard(item, section.items)}</div>)}
          </div>
        </section>
      )
    }
    if (section.id === 'artists') {
      return (
        <section key={section.id} className="space-y-3">
          {heading}
          <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-5rem)/6)] min-w-[110px] shrink-0">
            {section.items.map(item => <div key={`ar-${item.id}`} className="min-w-0">{renderArtistCard(item, section.items)}</div>)}
          </HorizontalShelf>
        </section>
      )
    }
    if (section.id === 'songs') {
      // 官网实测：3 行 × 7 列，一屏约 3 列、整体横向滚动（不是把 21 首全铺开）
      return (
        <section key={section.id} className="space-y-3">
          {heading}
          <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-2rem)/3)] min-w-[300px] shrink-0">
            {chunkBy(section.items, SONG_ROWS_PER_COLUMN).map((column, columnIndex) => (
              <div key={`songs-col-${columnIndex}`} className="flex w-full flex-col gap-0.5">
                {column.map(item => <div key={`tr-${item.id}`} className="min-w-0">{renderTrackRow(item, section.items)}</div>)}
              </div>
            ))}
          </HorizontalShelf>
        </section>
      )
    }
    if (section.id === 'music-videos') {
      return (
        <section key={section.id} className="space-y-3">
          {heading}
          <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-2rem)/3)] min-w-[260px] shrink-0">
            {section.items.map(item => <div key={`mv-${item.id}`} className="min-w-0">{renderVideoCard(item, section.items)}</div>)}
          </HorizontalShelf>
        </section>
      )
    }
    // 专辑 / 播放列表：方卡货架
    return (
      <section key={section.id} className="space-y-3">
        {heading}
        <HorizontalShelf edgeControls="hover" ariaLabel={section.title} itemClassName="w-[calc((100%-6rem)/6)] min-w-[130px] shrink-0">
          {section.items.map(item => <div key={`sq-${item.type}-${item.id}`} className="min-w-0">{renderSquareCard(item, section.items)}</div>)}
        </HorizontalShelf>
      </section>
    )
  }

  const focusedSection = focusedSectionId ? sections.find(section => section.id === focusedSectionId) : null
  const noResults = searched && !loading && !error && sections.length === 0
  const showLanding = !searched && !term.trim()

  return (
    <div className={`${textPrimary}`} onDragStart={event => { if (event.target instanceof HTMLImageElement) event.preventDefault() }}>
      {/* ── 搜索框 + 范围切换（官网 search-scope-bar 同款） ── */}
      <div className="mb-7 flex flex-wrap items-center gap-3">
        {/* 返回按钮：非最外层才出现（聚焦视图 → 全部结果 → 落地页），带出现动画 */}
        <AnimatePresence initial={false}>
          {canGoBack && (
            <motion.button
              key="search-back"
              type="button"
              aria-label="返回上一层"
              initial={{ opacity: 0, x: -8, scale: 0.9 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: -8, scale: 0.9 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              onClick={goBack}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition ${isDark ? 'border-white/[0.1] bg-white/[0.05] hover:bg-white/[0.1]' : 'border-black/[0.1] bg-black/[0.04] hover:bg-black/[0.08]'}`}
            >
              <ArrowLeft className="h-4 w-4" />
            </motion.button>
          )}
        </AnimatePresence>

        <div className="relative min-w-[220px] flex-1">
          <SearchIcon className={`pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 ${textTertiary}`} />
          <input
            ref={inputRef}
            type="text"
            value={term}
            autoComplete="off"
            spellCheck={false}
            placeholder="搜索"
            onChange={event => { setTerm(event.target.value); setSearched(false); setFocusedSectionId(null) }}
            onFocus={() => { if (suggestions.length > 0) setShowSuggestions(true) }}
            onBlur={() => window.setTimeout(() => setShowSuggestions(false), 160)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); runSearch(term) }
              if (event.key === 'Escape') {
                // Esc 与返回按钮同语义：逐级回退
                if (canGoBack) { event.preventDefault(); goBack() }
              }
            }}
            className={`w-full rounded-xl border py-2.5 pl-10 pr-10 text-sm outline-none transition [&::-webkit-search-cancel-button]:hidden ${isDark ? 'border-white/[0.1] bg-white/[0.05] placeholder-white/35 focus:border-white/25' : 'border-black/[0.1] bg-black/[0.04] placeholder-black/35 focus:border-black/25'}`}
          />
          {/* 只用自绘的清除按钮：type=search 在 Chromium 会额外画一个原生 x，看起来像"两个 x" */}
          <AnimatePresence>
            {term && (
              <motion.button
                key="clear"
                type="button"
                aria-label="清除"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
                onClick={() => { requestRef.current += 1; setTerm(''); setSections([]); setSearched(false); setError(''); setSuggestions([]); setFocusedSectionId(null); inputRef.current?.focus() }}
                className={`absolute right-3 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full transition ${isDark ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
              >
                <X className="h-3.5 w-3.5 opacity-60" />
              </motion.button>
            )}
          </AnimatePresence>
          {/* 建议下拉：建议词 + 可点开的资源（官网同款两类） */}
          {showSuggestions && suggestions.length > 0 && (
            <div className={`absolute left-0 right-0 top-full z-30 mt-2 max-h-[320px] overflow-y-auto rounded-xl border shadow-2xl backdrop-blur-xl ${isDark ? 'border-white/[0.1] bg-[#141419]/95' : 'border-black/[0.08] bg-white/95'}`}>
              {suggestions.map((suggestion, index) => (
                <button
                  key={`${suggestion.term}-${index}`}
                  type="button"
                  onMouseDown={event => { event.preventDefault(); runSearch(suggestion.term) }}
                  className={`flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition ${isDark ? 'hover:bg-white/[0.07]' : 'hover:bg-black/[0.05]'}`}
                >
                  {suggestion.artworkUrl
                    ? <CachedImage src={suggestion.artworkUrl} alt="" className="h-9 w-9 shrink-0 rounded" role="compact" platform="apple" />
                    : <SearchIcon className={`ml-1.5 mr-0.5 h-3.5 w-3.5 shrink-0 ${textTertiary}`} />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{suggestion.term}</span>
                    {suggestion.subtitle && <span className={`block truncate text-[11px] ${textTertiary}`}>{suggestion.subtitle}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 范围切换（segmented control） */}
        <div className={`flex shrink-0 overflow-hidden rounded-full border ${isDark ? 'border-white/[0.1] bg-white/[0.04]' : 'border-black/[0.08] bg-black/[0.03]'}`}>
          {([['catalog', 'Apple Music'], ['library', '你的资料库']] as Array<[AppleSearchScope, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={scope === value}
              onClick={() => { setScope(value); if (searched && term.trim()) runSearch(term) }}
              className={`px-4 py-2 text-xs font-medium transition ${scope === value ? (isDark ? 'bg-white text-black' : 'bg-black text-white') : `${textSecondary} hover:opacity-80`}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── 空态 / 结果 ── */}
      {loading ? (
        <div className={`flex items-center justify-center gap-2 py-20 text-sm ${textSecondary}`}>
          <Loader2 className="h-4 w-4 animate-spin" /> 正在搜索…
        </div>
      ) : error ? (
        <div className={`flex flex-col items-center gap-4 py-16 text-center text-sm ${textSecondary}`}>
          <span>{error}</span>
          <button type="button" onClick={() => runSearch(term)} className={`rounded-full border px-4 py-2 ${isDark ? 'border-white/[0.12] hover:bg-white/[0.07]' : 'border-black/[0.1] hover:bg-black/[0.05]'}`}>重试</button>
        </div>
      ) : noResults ? (
        <div className={`flex flex-col items-center justify-center gap-1.5 py-20 text-center ${textSecondary}`}>
          <p className="text-base font-medium">没有搜索结果</p>
          <p className={`text-sm ${textTertiary}`}>请尝试使用其他搜索条件。</p>
        </div>
      ) : focusedSection ? (
        // 分区聚焦视图（官网点分区标题后的状态）：只留该分区
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            {sections.map(section => (
              <button
                key={`focus-tab-${section.id}`}
                type="button"
                aria-pressed={section.id === focusedSection.id}
                onClick={() => setFocusedSectionId(section.id)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${section.id === focusedSection.id ? (isDark ? 'bg-white text-black' : 'bg-black text-white') : `${textSecondary} ${isDark ? 'bg-white/[0.06] hover:bg-white/[0.12]' : 'bg-black/[0.05] hover:bg-black/[0.1]'}`}`}
              >
                {section.title}
              </button>
            ))}
          </div>
          {renderSection(focusedSection, false)}
        </div>
      ) : sections.length > 0 ? (
        <div className="space-y-9">{sections.map(section => renderSection(section))}</div>
      ) : showLanding && renderLanding ? (
        renderLanding()
      ) : null}
    </div>
  )
}

/** 列切分（歌曲区每列 3 行，官网 3×7 布局） */
function chunkBy<T>(items: T[], size: number): T[][] {
  const columns: T[][] = []
  for (let index = 0; index < items.length; index += size) columns.push(items.slice(index, index + size))
  return columns
}
