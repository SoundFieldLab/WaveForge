// 传统模式「Spotify 客户端」——完整官方复刻外壳（对齐官方三栏布局）：
//  左栏：『音乐库』标题 + 创建/放大按钮 + 歌单|艺人页签 + 搜索框 + 最近播放排序 + 条目列表（已点赞置顶）
//  中栏：当前选中条目的详情（已点赞的歌曲官方紫渐变页 / 歌单详情 / 艺人页 / 发现主页）
//  底部：官方播放条（专辑封面 + 曲名/艺人 + 随机/上一首/播放/下一首/循环）
// 本组件是「自管外壳」：内部导航自管（与 KugouPcShell 同模式），右侧第三栏由 WaveForge 保留。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronLeft, ChevronRight, House, Plus, ArrowUpRight, Search, ListFilter,
  Shuffle, SkipBack, SkipForward, Play, Pause, Repeat, Music2, Heart, Clock, Disc3, Check, X, ChevronDown,
  BadgeCheck, MoreHorizontal, Ban, Radio as RadioIcon, Flag, Share, Volume2, VolumeX, ListPlus, PlusCircle, ArrowDown,
} from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { spotifyPcTheme } from './spotifyPcKit'
import {
  fetchPartnerMyPlaylists, fetchPartnerLibraryArtists, fetchPartnerLikedRows, fetchPartnerPlaylistDetailFull,
} from '../../services/spotifyPartnerData'
import SpotifyPcHome, { SPOTIFY_BROWSE_CATEGORIES, idOf, type HomeSectionItemPublic as HomeSectionItem } from './SpotifyPcHome'
import SpotifyPcCategory from './SpotifyPcCategory'
import SpotifyPcAlbum from './SpotifyPcAlbum'
import type { PcActions } from './types'
import type { SpotifyPlaylist, SpotifyTrack } from '../../services/spotifyService'

export interface SpotifyPcShellProps {
  tone: 'dark' | 'light'
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  currentSong: Song | null
  isPlaying: boolean
  active: boolean
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  onPlayPause: () => void
  onNext: () => void
  onPrevious: () => void
  onLoginClick?: () => void
  onSongMenu?: (event: { x: number; y: number; song: Song; songs?: Song[] }) => void
  /** 歌单卡片点击（WaveForge 全局歌单详情链） */
  onOpenPlaylist: (playlistId: string) => void
  /** 艺人卡片点击 */
  onOpenArtist: (artistId: string) => void
  /** 专辑点击（走 WaveForge 全局专辑详情链） */
  onOpenAlbum?: (albumId: string) => void
  /** 全局路由直达艺人页（page.name === artist 时携带） */
  initialArtistId?: string
  /** 顶栏搜索提交（走 WaveForge 全局搜索页） */
  onSearchSubmit?: (keyword: string) => void
  /** 加入播放队列（官方预览层队列按钮） */
  onPlayNext?: (song: Song) => void
  /** 初始进入设置视图（全局设置路由对 Spotify 保侧栏：由外壳承载设置页） */
  initialSettings?: boolean
  /** 设置页内容渲染（WaveForge 设置面板由 TraditionalView 传入） */
  renderSettings?: () => ReactNode
}

type View =
  | { kind: 'home' }
  | { kind: 'liked' }
  | { kind: 'playlist'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'category'; title: string; bg: string; accent: string }
  | { kind: 'section'; title: string; items: HomeSectionItem[] }
  | { kind: 'browse' }
  | { kind: 'album'; id: string }
  | { kind: 'recents' }
  | { kind: 'settings' }

interface SidebarEntry {
  kind: 'playlist' | 'artist'
  id: string
  name: string
  coverUrl?: string
  subtitle: string
  isLikedSongs?: boolean
}

/** 官方 home/profile 快照（partner 桥返回 { ok, data } 包装）的渲染层局部类型 */
type PartnerSnapshot = { ok?: boolean; data?: {
  profile?: { followingArtists?: SnapshotArtist[] }
  home?: { sectionContainer?: { sections?: { items?: SnapshotSection[] } } }
} }
type SnapshotArtist = { uri?: string; name?: string; imageUrl?: string }
type SnapshotSection = {
  uri?: string
  data?: { title?: { transformedLabel?: string } }
  sectionItems?: { items?: Array<{
    uri?: string
    content?: { data?: { profile?: { name?: string }; visuals?: { avatarImage?: { sources?: Array<{ url?: string }> } }; items?: { items?: Array<{ entity?: { _uri?: string } }> } } }
  }> }
}

const fmtDuration = (ms?: number) => {
  if (!ms || ms <= 0) return '-:--'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const fmtTotal = (ms: number) => {
  const h = Math.floor(ms / 3600000)
  const m = Math.round((ms % 3600000) / 60000)
  return h > 0 ? `${h} 小时 ${m} 分钟` : `${m} 分钟`
}
const fmtDate = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 横排拖动滚动（官方/Apple 同款：按住左右拖，拖动吞掉 click；ref 回调可复用给多行） */
function useDragScrollRef() {
  return useCallback((el: HTMLElement | null) => {
    if (!el) return
    let startX = 0
    let startLeft = 0
    let dragging = false
    let moved = false
    const down = (e: PointerEvent) => {
      if (e.pointerType === 'touch' || e.button !== 0) return
      dragging = true
      moved = false
      startX = e.clientX
      startLeft = el.scrollLeft
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      const dx = e.clientX - startX
      if (!moved && Math.abs(dx) > 5) { moved = true; el.style.cursor = 'grabbing' }
      if (moved) el.scrollLeft = startLeft - dx
    }
    const up = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      el.style.cursor = ''
      try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    const clickCapture = (e: MouseEvent) => {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false }
    }
    el.style.cursor = 'grab'
    el.style.userSelect = 'none'
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('click', clickCapture, true)
  }, [])
}

export default function SpotifyPcShell({
  tone, accent, loggedIn, username, avatar, currentSong, isPlaying, active,
  onPlaySongs, onPlayPause, onNext, onPrevious, onLoginClick, onSongMenu, onOpenPlaylist, onOpenArtist, onOpenAlbum, onSearchSubmit, initialArtistId, initialSettings, renderSettings, onPlayNext,
}: SpotifyPcShellProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [view, setView] = useState<View>(initialSettings ? { kind: 'settings' } : initialArtistId ? { kind: 'artist', id: initialArtistId } : { kind: 'home' })
  // 已点赞排序下拉显隐（点击外部关闭）
  const [likedSortOpen, setLikedSortOpen] = useState(false)
  const likedSortMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!likedSortOpen) return
    const onDown = (e: MouseEvent) => { if (!likedSortMenuRef.current?.contains(e.target as Node)) setLikedSortOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [likedSortOpen])
  const [entries, setEntries] = useState<SidebarEntry[]>([])
  const [artistEntries, setArtistEntries] = useState<SidebarEntry[]>([])
  // 官方默认不筛选（歌单+艺人合并展示）；点页签筛选，再点 X 退出
  const [libTab, setLibTab] = useState<'playlist' | 'artist' | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [liked, setLiked] = useState<Array<{ track: SpotifyTrack; addedAt?: string }>>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [pl, likedRows, artists] = await Promise.all([
        fetchPartnerMyPlaylists(50).catch(() => null),
        fetchPartnerLikedRows(500).catch(() => null),
        fetchPartnerLibraryArtists(100).catch(() => null),
      ])
      setLiked(likedRows ?? [])
      const list: SidebarEntry[] = []
      // 已点赞的歌曲固定置顶（官方绿心）
      list.push({ kind: 'playlist', id: 'liked', name: '已点赞的歌曲', subtitle: `歌单 · ${username}`, coverUrl: '', isLikedSongs: true })
      for (const p of pl ?? []) {
        if (p.name === '已点赞的歌曲') continue
        list.push({ kind: 'playlist', id: p.id, name: p.name, coverUrl: p.coverUrl ?? '', subtitle: `歌单 · ${p.owner ?? username}` })
      }
      setEntries(list)
      // 资料库艺人：libraryV3 为主，空/失败时用官方 profile 快照的关注艺人兜底（去重合并）
      const libArtists = artists ?? []
      let snapArtists: Array<{ id: string; name: string; avatarUrl?: string }> = []
      if (libArtists.length === 0) {
        try {
          const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<PartnerSnapshot> } } }).electron?.spotifyPartner
          const snap = b ? await b.request('profile_snapshot') : null
          const unwrapped = ((snap as PartnerSnapshot)?.data ?? snap) as PartnerSnapshot['data']
          snapArtists = (unwrapped?.profile?.followingArtists ?? []).map((a: SnapshotArtist) => ({
            id: String(a.uri ?? '').replace('spotify:artist:', ''),
            name: String(a.name ?? ''),
            avatarUrl: a.imageUrl,
          })).filter((a: SnapshotArtist & { id: string; name: string }) => a.id && a.name)
        } catch { /* ignore */ }
      }
      const seenArtist = new Set(libArtists.map((a: { id: string }) => a.id))
      setArtistEntries([...libArtists, ...snapArtists.filter((a: { id: string }) => !seenArtist.has(a.id))]
        .map((a: { id: string; name: string; avatarUrl?: string }) => ({ kind: 'artist' as const, id: a.id, name: a.name, coverUrl: a.avatarUrl, subtitle: '艺人' })))
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => {
    if (active && loggedIn) void load()
  }, [active, loggedIn, load])

  // 顶栏「浏览」按钮 → 官方浏览页（全局事件由 TraditionalView 顶栏派发）
  useEffect(() => {
    const handler = () => setView({ kind: 'browse' })
    window.addEventListener('waveforge:spotify-browse', handler)
    return () => window.removeEventListener('waveforge:spotify-browse', handler)
  }, [])
  // 顶栏账户菜单「最近播放」→ 官方最近播放页
  useEffect(() => {
    const handler = () => setView({ kind: 'recents' })
    window.addEventListener('waveforge:spotify-recents', handler)
    return () => window.removeEventListener('waveforge:spotify-recents', handler)
  }, [])

  // ── 本机播放历史（最近播放页数据源之一）：当前 Spotify 歌变化即落一条 ──
  const HISTORY_KEY = 'waveforge:spotify-play-history'
  useEffect(() => {
    if (!currentSong || (currentSong.platform || 'spotify') !== 'spotify') return
    let history: Array<{ kind: 'song'; id: string; name: string; cover: string; artist: string; at: number }> = []
    try { history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') } catch { history = [] }
    if (history[0]?.id === currentSong.mid) return
    history.unshift({
      kind: 'song', id: String(currentSong.mid ?? ''), name: currentSong.name,
      cover: currentSong.album?.picUrl ?? '',
      artist: (currentSong.artists ?? []).map(a => a.name).join(' / '),
      at: Date.now(),
    })
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 100))) } catch { /* ignore */ }
  }, [currentSong])

  const likedSongs: Song[] = useMemo(() => liked.map(r => {
    const t = r.track
    return {
      id: Number(parseInt(t.id.slice(0, 12), 36)) || 0,
      mid: t.id,
      name: t.name,
      artists: t.artists.map((a: { name: string }) => ({ name: a.name })),
      album: { name: t.album?.name ?? '', picUrl: t.album?.images?.[0]?.url ?? '' },
      duration: t.duration_ms ?? 0,
      platform: 'spotify',
    }
  }), [liked])
  const likedAddedAt = useMemo(() => liked.map(r => r.addedAt), [liked])

  // 已点赞排序（官方四项：自定义顺序/标题/艺人/添加日期）
  const [libSortRecents, setLibSortRecents] = useState(false)
  const [likedSort, setLikedSort] = useState<'custom' | 'title' | 'artist' | 'added'>('custom')
  const likedOrder = useMemo(() => {
    const indices = likedSongs.map((_, i) => i)
    if (likedSort === 'title') indices.sort((a, b) => likedSongs[a].name.localeCompare(likedSongs[b].name, 'zh-Hans-CN'))
    else if (likedSort === 'artist') indices.sort((a, b) => (likedSongs[a].artists[0]?.name ?? '').localeCompare(likedSongs[b].artists[0]?.name ?? '', 'zh-Hans-CN'))
    else if (likedSort === 'added') indices.sort((a, b) => new Date(likedAddedAt[b] ?? 0).getTime() - new Date(likedAddedAt[a] ?? 0).getTime())
    return indices
  }, [likedSongs, likedAddedAt, likedSort])
  // 播放/右键仍以「原始顺序」为队列上下文（官方语义：排序只是视图），但展示行按排序走
  const likedViewRows = useMemo(() => likedOrder.map(i => ({ song: likedSongs[i], addedAt: likedAddedAt[i], originIndex: i })), [likedOrder, likedSongs, likedAddedAt])

  // ── 详情数据加载 ──
  const [detail, setDetail] = useState<{ name: string; desc: string; cover: string; owner: string; count: number; durationMs: number; rows: Array<{ track: SpotifyTrack; addedAt?: string; albumUri?: string; uid?: string }> } | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (view.kind !== 'playlist') { setDetail(null); return }
    setDetailLoading(true)
    fetchPartnerPlaylistDetailFull(view.id).then(d => {
      if (cancelled) return
      setDetail(d ? {
        name: d.name,
        desc: d.description,
        cover: d.coverUrl,
        owner: d.ownerName || username,
        count: d.trackCount || d.rows.length,
        durationMs: d.durationMs || d.rows.reduce((acc, r) => acc + (r.track.duration_ms ?? 0), 0),
        rows: d.rows.map(r => ({ track: r.track, addedAt: r.addedAt, albumUri: r.albumUri, uid: r.uid })),
      } : null)
      setDetailLoading(false)
    }).catch(() => { if (!cancelled) setDetailLoading(false) })
    return () => { cancelled = true }
  }, [view, username])

  // 播放控件由 WaveForge 全局底部播放条承担（官方布局不含双播放条）

  if (!loggedIn) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: theme.background }}>
        <button type="button" onClick={onLoginClick}
          className="rounded-full px-8 py-3 text-sm font-bold text-black transition hover:brightness-110"
          style={{ background: theme.accent }}>
          登录 Spotify
        </button>
      </div>
    )
  }

  // 在资料库中搜索：过滤条目列表（官方行为）；回车则跳全局搜索页。
  // 不筛选时官方合并展示歌单+艺人（已点赞置顶）
  const baseItems = libTab === 'playlist' ? entries : libTab === 'artist' ? artistEntries : [...entries, ...artistEntries]
  const sidebarItems = baseItems
    .filter(item => !searchKeyword.trim() || item.name.toLowerCase().includes(searchKeyword.trim().toLowerCase()))
  const activeId = view.kind === 'playlist' ? view.id : view.kind === 'liked' ? 'liked' : view.kind === 'artist' ? view.id : ''
  const openCreatePlaylist = () => {
    // 创建歌单走官方两步（创建+入资料库）；未登录先登录
    if (!loggedIn) { onLoginClick?.(); return }
    const name = `我的歌单 ${new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`
    const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; data?: { uri?: string } }> } } }).electron?.spotifyPartner
    if (!bridge) return
    void bridge.request('playlist_create', { name, description: '' }).then(res => {
      const uri = res?.data?.uri ?? ''
      const newId = String(uri).replace('spotify:playlist:', '')
      if (res?.ok && newId) {
        void load().then(() => setView({ kind: 'playlist', id: newId }))
      }
    }).catch(() => undefined)
  }

  // 官方页面头部渐变随内容滚动：全宽渐变层放在根容器（横跨左栏+中栏），
  // 中栏滚动时同步 translateY，滚过头部后渐变随之离场（官方视觉）。
  const bleedRef = useRef<HTMLDivElement>(null)
  const mainScrollRef = useRef<HTMLElement>(null)
  // 壳内导航栈：顶栏返回键先弹这里（waveforge:spotify-back），弹空再走全局历史
  const viewStackRef = useRef<View[]>([])
  const poppingRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  const prevViewRef = useRef<View>(view)
  useEffect(() => {
    if (poppingRef.current) { poppingRef.current = false; prevViewRef.current = view; return }
    if (prevViewRef.current !== view) { viewStackRef.current.push(prevViewRef.current); prevViewRef.current = view }
    // 同步返回栈深度给顶栏返回箭头（disabled 态放行）
    try { (window as unknown as { __spotifyShellBackDepth?: number }).__spotifyShellBackDepth = viewStackRef.current.length } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('waveforge:spotify-back-availability'))
  }, [view])
  useEffect(() => {
    const handler = (e: Event) => {
      if (!activeRef.current) return
      const prev = viewStackRef.current.pop()
      if (!prev) return
      e.preventDefault()
      poppingRef.current = true
      setView(prev)
    }
    window.addEventListener('waveforge:spotify-back', handler)
    return () => window.removeEventListener('waveforge:spotify-back', handler)
  }, [])
  const bleedGradient = view.kind === 'liked'
    ? 'linear-gradient(180deg, rgba(80,56,160,.9), rgba(18,18,18,0) 100%)'
    : view.kind === 'playlist'
      ? 'linear-gradient(180deg, rgba(80,56,160,.85), rgba(18,18,18,0) 100%)'
      : view.kind === 'artist'
        ? 'linear-gradient(180deg, rgba(80,80,120,.8), rgba(18,18,18,0) 100%)'
        : ''
  useEffect(() => {
    if (bleedRef.current) bleedRef.current.style.transform = 'translateY(0px)'
  }, [view])

  return (
    <div className="flex h-full flex-col" style={{ background: theme.background }} data-active={active}>
      <div className="relative flex min-h-0 flex-1">
        {/* 官方头部渐变：全宽（官方侧栏透明叠在渐变上） */}
        {bleedGradient && (
          <div ref={bleedRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0 will-change-transform"
            style={{ height: 340, background: bleedGradient }} />
        )}
        {/* ── 左栏：音乐库（官方浮动圆角面板，渐变从面板四周透出） ── */}
        <aside className="relative z-10 m-2 flex min-h-0 flex-col overflow-hidden rounded-lg" style={{ width: 300, background: theme.content }}>
          <div className="flex items-center justify-between px-4 pb-2 pt-4">
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => setView({ kind: 'home' })} aria-label="主页"
                className="rounded p-1 transition hover:opacity-70" style={{ color: view.kind === 'home' ? theme.accent : theme.secondary }}>
                <House className="h-5 w-5" />
              </button>
              <h2 className="text-lg font-bold" style={{ color: theme.text }}>音乐库</h2>
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={openCreatePlaylist} className="rounded p-1 transition hover:opacity-70" style={{ color: theme.secondary }} title="创建歌单"><Plus className="h-5 w-5" /></button>
              <button type="button" className="rounded p-1 transition hover:opacity-70" style={{ color: theme.secondary }} title="放大"><ArrowUpRight className="h-5 w-5" /></button>
            </div>
          </div>
          {/* 页签 + 搜索 + 最近播放（官方交互：搜索点击展开；选中的页签带 X 退出筛选） */}
          <div className="px-4 pb-2">
            <div className="flex gap-2">
              {(['playlist', 'artist'] as const).map(tab => {
                const label = tab === 'playlist' ? '歌单' : '艺人'
                const isActive = libTab === tab
                return (
                  <button key={tab} type="button"
                    onClick={() => setLibTab(isActive ? null : tab)}
                    className="flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold"
                    style={{ background: isActive ? theme.text : theme.panel, color: isActive ? theme.background : theme.secondary }}>
                    {isActive && (
                      <span role="button" aria-label={`清除${label}筛选`} tabIndex={0}
                        onClick={e => { e.stopPropagation(); setLibTab(null) }}
                        onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); setLibTab(null) } }}
                        className="-ml-1 flex rounded-full p-0.5 transition hover:bg-black/10">
                        <X className="h-3 w-3" />
                      </span>
                    )}
                    {label}
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex items-center justify-between">
              {searchOpen ? (
                <div className="flex flex-1 items-center gap-2 rounded-md px-2.5 py-1.5" style={{ background: theme.panel }}>
                  <Search className="h-3.5 w-3.5 shrink-0" style={{ color: theme.secondary }} />
                  <input
                    autoFocus
                    value={searchKeyword}
                    onChange={e => setSearchKeyword(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && searchKeyword.trim()) { onSearchSubmit?.(searchKeyword.trim()); setSearchKeyword(''); setSearchOpen(false) }
                      if (e.key === 'Escape') { setSearchOpen(false); setSearchKeyword('') }
                    }}
                    placeholder="在资料库中搜索"
                    className="w-full bg-transparent text-xs outline-none"
                    style={{ color: theme.text }}
                  />
                  <button type="button" onClick={() => { setSearchOpen(false); setSearchKeyword('') }} className="shrink-0 rounded p-0.5 transition hover:opacity-70" style={{ color: theme.secondary }} aria-label="关闭搜索">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-between">
                  <button type="button" onClick={() => setSearchOpen(true)} className="rounded p-1 transition hover:opacity-70" style={{ color: theme.secondary }} aria-label="在资料库中搜索">
                    <Search className="h-4 w-4" />
                  </button>
                  <button type="button" className="flex items-center gap-1 text-xs transition hover:opacity-80"
                    style={{ color: libSortRecents ? theme.accent : theme.secondary }} title="最近播放"
                    onClick={() => { setLibSortRecents(v => !v); if (view.kind === 'liked') setLikedSort(libSortRecents ? 'custom' : 'added') }}>
                    <ListFilter className="h-3.5 w-3.5" /> 最近播放
                  </button>
                </div>
              )}
              {searchOpen && <span className="w-16 shrink-0" />}
            </div>
          </div>
          {/* 条目列表 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {loading && <p className="px-3 py-4 text-xs" style={{ color: theme.secondary }}>加载中…</p>}
            {sidebarItems.map(item => {
              const isActive = activeId === item.id
              return (
                <button
                  key={item.kind + item.id}
                  type="button"
                  onClick={() => setView(item.kind === 'artist' ? { kind: 'artist', id: item.id } : item.id === 'liked' ? { kind: 'liked' } : { kind: 'playlist', id: item.id })}
                  className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition"
                  style={{ background: isActive ? theme.hover : 'transparent' }}
                  onMouseEnter={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = theme.hover }}
                  onMouseLeave={e => { if (!isActive) (e.currentTarget as HTMLButtonElement).style.background = isActive ? theme.hover : 'transparent' }}
                >
                  <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded" style={{ background: theme.panel }}>
                    {item.isLikedSongs ? (
                      <span className="flex h-[70%] w-[70%] items-center justify-center rounded" style={{ background: 'linear-gradient(135deg,#450af5,#8e8ee5)' }}>
                        <Heart className="h-5 w-5" fill="#fff" color="#fff" />
                      </span>
                    ) : item.coverUrl ? (
                      <img src={item.coverUrl} alt="" className={`h-full w-full object-cover ${item.kind === 'artist' ? 'rounded-full' : ''}`} />
                    ) : (
                      <Music2 className="h-5 w-5" style={{ color: theme.secondary }} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium" style={{ color: item.isLikedSongs ? theme.accent : item.kind === 'artist' ? theme.accent : theme.text }}>{item.name}</span>
                    <span className="block truncate text-xs" style={{ color: theme.secondary }}>{item.subtitle}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── 中栏：详情区 ── */}
        <main ref={mainScrollRef} onScroll={e => { if (bleedRef.current) bleedRef.current.style.transform = `translateY(${-e.currentTarget.scrollTop}px)` }}
          className="relative z-10 min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {/* 发现主页（官方风：新增内容/你的歌单/周五新歌/热门电台/浏览全部） */}
          {view.kind === 'home' && (
            <SpotifyPcHome
              tone={tone}
              accent={accent}
              loggedIn={loggedIn}
              username={username}
              avatar={avatar}
              actions={{} as PcActions}
              active={active}
              currentSong={currentSong}
              onLoginClick={onLoginClick}
              onOpenPlaylist={id => { if (id === 'liked') setView({ kind: 'liked' }); else setView({ kind: 'playlist', id }) }}
              onOpenArtist={artistId => setView({ kind: 'artist', id: artistId })}
              onOpenAlbum={albumId => setView({ kind: 'album', id: albumId })}
              onOpenCategory={(title, bg, catAccent) => setView({ kind: 'category', title, bg, accent: catAccent })}
              onOpenSection={(title, items) => setView({ kind: 'section', title, items })}
            />
          )}

          {/* 官方分类页（浏览全部磁贴进入：分类歌单网格） */}
          {view.kind === 'category' && (
            <SpotifyPcCategory
              tone={tone}
              categoryTitle={view.title}
              categoryBg={view.bg}
              categoryAccent={view.accent}
              active={active}
              onOpenPlaylist={id => setView({ kind: 'playlist', id })}
            />
          )}

          {/* 官方分区二级页（首页「显示全部」进入：该分区全部条目网格，与官方二级页同构） */}
          {view.kind === 'section' && (
            <div className="pb-24" data-active={active}>
              <div className="px-8 pb-4 pt-14">
                <h1 className="text-3xl font-black" style={{ color: theme.text }}>{view.title}</h1>
              </div>
              <div className="grid grid-cols-2 gap-4 px-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
                {view.items.map((item, i) => {
                  const kind = item.content?.__typename?.includes('Playlist') ? 'playlist' : item.content?.__typename?.includes('Artist') ? 'artist' : item.content?.__typename?.includes('Album') ? 'album' : 'unknown'
                  const d = item.content?.data
                  const name = d?.name ?? d?.profile?.name ?? ''
                  const cover = d?.coverArt?.sources?.[0]?.url ?? d?.images?.items?.[0]?.sources?.[0]?.url ?? d?.visuals?.avatarImage?.sources?.[0]?.url ?? ''
                  const sub = kind === 'playlist' ? `歌单 · ${d?.ownerV2?.data?.name ?? ''}` : kind === 'artist' ? '艺人' : kind === 'album' ? `${d?.date?.year ? `${d.date.year} · ` : ''}${(d?.artists?.items ?? []).map(a => a?.profile?.name ?? '').filter(Boolean).join(' / ')}` : ''
                  const open = () => {
                    if (kind === 'playlist') setView({ kind: 'playlist', id: idOf(item.uri ?? d?.uri) })
                    else if (kind === 'artist') setView({ kind: 'artist', id: idOf(item.uri ?? d?.uri) })
                    else if (kind === 'album') setView({ kind: 'album', id: idOf(item.uri ?? d?.uri) })
                  }
                  return (
                    <button key={(item.uri ?? '') + i} type="button" onClick={open} className="group text-left">
                      <span className={`relative mb-3 block aspect-square w-full overflow-hidden shadow-lg ${kind === 'artist' ? 'rounded-full' : 'rounded-md'}`} style={{ background: theme.panel }}>
                        {cover
                          ? <img src={cover} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />
                          : <span className="flex h-full w-full items-center justify-center"><Music2 className="h-10 w-10" style={{ color: theme.secondary }} /></span>}
                        <span className="absolute bottom-2 right-2 flex h-12 w-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100"
                          style={{ background: theme.accent }}>
                          <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="#000"><path d="M8 5v14l11-7z" /></svg>
                        </span>
                      </span>
                      <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{name}</span>
                      <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>{sub}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* 官方浏览页（顶栏「浏览」按钮进入：官方分类磁贴） */}
          {view.kind === 'browse' && (
            <div className="px-8 pb-24 pt-14" data-active={active}>
              <h1 className="mb-6 text-3xl font-black" style={{ color: theme.text }}>浏览全部</h1>
              <div className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
                {SPOTIFY_BROWSE_CATEGORIES.map((cat, i) => (
                  <button key={`${cat.title}-${i}`} type="button" onClick={() => setView({ kind: 'category', title: cat.title, bg: cat.bg, accent: cat.accent })}
                    className="relative aspect-[10/7] w-full overflow-hidden rounded-lg text-left transition hover:brightness-110"
                    style={{ background: cat.bg }}>
                    <span className="absolute left-4 top-3.5 max-w-[70%] text-xl font-bold leading-tight text-white">{cat.title}</span>
                    <span className="absolute -bottom-2 -right-3 flex h-24 w-24 rotate-[25deg] items-center justify-center overflow-hidden rounded-md shadow-2xl"
                      style={{ background: cat.accent }}>
                      <Disc3 className="h-12 w-12 text-white/85" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 官方专辑详情页（getAlbum 桥） */}
          {view.kind === 'album' && (
            <SpotifyPcAlbum
              tone={tone}
              accent={accent}
              albumId={view.id}
              active={active}
              currentSong={currentSong}
              isPlaying={isPlaying}
              onPlaySongs={onPlaySongs}
              onPlayPause={onPlayPause}
              onPlayNext={onPlayNext}
              onOpenArtist={onOpenArtist}
              onOpenAlbum={albumId => setView({ kind: 'album', id: albumId })}
              onSongMenu={onSongMenu}
            />
          )}

          {/* 官方最近播放页（账户菜单进入）：按日期分组的播放历史 */}
          {view.kind === 'recents' && (
            <RecentsInline
              theme={theme}
              active={active}
              username={username}
              knownPlaylists={entries}
              knownArtists={artistEntries}
              onOpenArtist={onOpenArtist}
              onOpenPlaylist={id => { if (id === 'liked') setView({ kind: 'liked' }); else setView({ kind: 'playlist', id }) }}
            />
          )}

          {/* 设置（全局设置路由由外壳承载：保左栏，官方同款布局） */}
          {view.kind === 'settings' && renderSettings?.()}

          {/* 已点赞的歌曲（官方紫渐变详情页） */}
          {view.kind === 'liked' && (
            <>
              <div className="flex items-end gap-6 px-8 pb-6 pt-16">
                <span className="flex h-[192px] w-[192px] items-center justify-center rounded shadow-2xl"
                  style={{ background: 'linear-gradient(135deg,#450af5,#8e8ee5)' }}>
                  <Heart className="h-16 w-16" fill="#fff" color="#fff" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold" style={{ color: theme.text }}>歌单</p>
                  <h1 className="mt-2 mb-4 text-[clamp(2rem,5vw,4.5rem)] font-black leading-tight tracking-tight" style={{ color: theme.text }}>已点赞的歌曲</h1>
                  <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: theme.text }}>
                    <span className="font-semibold">{username}</span>
                    <span style={{ color: theme.secondary }}>· {likedSongs.length} 首歌曲,</span>
                    <span style={{ color: theme.secondary }}>{fmtTotal(likedSongs.reduce((acc, t) => acc + (t.duration ?? 0), 0))}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-6 px-8 py-6">
                {likedSongs.length > 0 && (
                  <button type="button" onClick={() => onPlaySongs(likedSongs[0], likedSongs, 0)}
                    className="flex h-14 w-14 items-center justify-center rounded-full transition hover:scale-105"
                    style={{ background: theme.accent, boxShadow: '0 8px 24px rgba(30,215,96,.4)' }} aria-label="播放">
                    <Play className="h-6 w-6" fill="#000" color="#000" />
                  </button>
                )}
                <Shuffle className="h-7 w-7" style={{ color: theme.secondary }} />
              </div>
              <div className="px-8 pb-24">
                {/* 排序选择器（官方「最近播放/自定义顺序/标题/艺人/添加日期」下拉） */}
                <div className="relative mb-2 flex justify-end px-4" ref={likedSortMenuRef}>
                  <button type="button" onClick={() => setLikedSortOpen(v => !v)}
                    className="flex items-center gap-1.5 text-xs font-semibold transition hover:opacity-80" style={{ color: theme.secondary }}>
                    <ListFilter className="h-3.5 w-3.5" />
                    {likedSort === 'custom' ? '自定义顺序' : likedSort === 'title' ? '标题' : likedSort === 'artist' ? '艺人' : '添加日期'}
                  </button>
                  {likedSortOpen && (
                    <div className="absolute right-4 top-6 z-30 w-44 overflow-hidden rounded-md border py-1 shadow-2xl"
                      style={{ background: '#282828', borderColor: theme.divider }}>
                      {([
                        { key: 'custom', label: '自定义顺序' },
                        { key: 'title', label: '标题' },
                        { key: 'artist', label: '艺人' },
                        { key: 'added', label: '添加日期' },
                      ] as const).map(opt => (
                        <button key={opt.key} type="button" onClick={() => { setLikedSort(opt.key); setLikedSortOpen(false) }}
                          className="flex w-full items-center justify-between px-4 py-2 text-left text-sm transition hover:bg-white/10"
                          style={{ color: likedSort === opt.key ? theme.accent : '#fff' }}>
                          <span>{opt.label}</span>
                          {likedSort === opt.key && <Check className="h-4 w-4" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* 官方表头：# / 标题 / 专辑 / 添加日期 / 时长 */}
                <div className="grid items-center gap-4 border-b px-4 pb-2 text-xs" style={{ gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,3fr) minmax(0,2fr) 48px', borderColor: theme.divider, color: theme.secondary }}>
                  <span className="text-center">#</span><span />
                  <span>标题</span><span>专辑</span><span>添加日期</span>
                  <span className="justify-self-end pr-2"><Clock className="h-4 w-4" /></span>
                </div>
                {likedViewRows.map(({ song, addedAt, originIndex }, viewIndex) => (
                  <div key={(song.mid ?? String(song.id)) + originIndex}
                    className="group grid items-center gap-4 rounded px-4 py-2 text-sm hover:bg-white/10"
                    style={{
                      gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,3fr) minmax(0,2fr) 48px',
                      color: currentSong?.mid === song.mid ? theme.accent : theme.text,
                      background: currentSong?.mid === song.mid ? theme.panel : undefined,
                    }}
                    onDoubleClick={() => onPlaySongs(song, likedSongs, originIndex)}
                    onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song, songs: likedSongs }) }}
                  >
                    <span className="group-hover:hidden text-center" style={{ color: theme.secondary }}>{viewIndex + 1}</span>
                    <span className="hidden group-hover:justify-center text-white"><Play className="h-4 w-4" fill="currentColor" /></span>
                    {song.album?.picUrl ? <img src={song.album.picUrl} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded" style={{ background: theme.panel }} />}
                    <span className="min-w-0">
                      <span className="block truncate font-medium" style={{ color: currentSong?.mid === song.mid ? theme.accent : theme.text }}>{song.name}</span>
                      <span
                        className="block truncate text-xs hover:underline cursor-pointer"
                        style={{ color: theme.secondary }}
                        onClick={e => { e.stopPropagation(); const first = liked[originIndex]?.track?.artists?.[0]?.id; if (first) onOpenArtist(first) }}
                      >
                        {song.artists.map(a => a.name).join(' / ')}
                      </span>
                    </span>
                    <span
                      className="truncate text-xs hover:underline cursor-pointer"
                      style={{ color: theme.secondary }}
                      onClick={e => { e.stopPropagation(); const albumId = liked[originIndex]?.track?.album?.id; if (albumId) setView({ kind: 'album', id: albumId }) }}
                    >
                      {song.album?.name ?? ''}
                    </span>
                    <span className="truncate text-xs" style={{ color: theme.secondary }}>{fmtDate(addedAt)}</span>
                    <span className="justify-self-end text-xs" style={{ color: theme.secondary }}>{fmtDuration(song.duration)}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* 歌单详情 */}
          {view.kind === 'playlist' && (
            detailLoading ? <p className="px-8 py-16 text-center" style={{ color: theme.secondary }}>加载中…</p>
            : detail ? (
              <>
                <div className="flex items-end gap-6 px-8 pb-6 pt-16">
                  {detail.cover
                    ? <img src={detail.cover} alt="" className="h-[192px] w-[192px] rounded object-cover shadow-2xl" />
                    : <span className="flex h-[192px] w-[192px] items-center justify-center rounded shadow-2xl" style={{ background: theme.panel }}>
                        <Music2 className="h-16 w-16" style={{ color: theme.secondary }} />
                      </span>}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-bold" style={{ color: theme.text }}>歌单</p>
                    <h1 className="mt-2 mb-3 text-[clamp(2rem,5vw,4rem)] font-black leading-tight" style={{ color: theme.text }}>{detail.name}</h1>
                    {detail.desc && <p className="mb-2 text-sm" style={{ color: theme.secondary }}>{detail.desc}</p>}
                    <p className="text-sm" style={{ color: theme.text }}>
                      <span className="font-semibold">{detail.owner}</span>
                      <span style={{ color: theme.secondary }}> · {detail.count} 首歌曲</span>
                      {detail.durationMs > 0 && <span style={{ color: theme.secondary }}>, {fmtTotal(detail.durationMs)}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-6 px-8 py-6">
                  {detail.rows.length > 0 && (
                    <button type="button"
                      onClick={() => {
                        const songs = playlistSongs(detail.rows)
                        onPlaySongs(songs[0], songs, 0)
                      }}
                      className="flex h-14 w-14 items-center justify-center rounded-full transition hover:scale-105"
                      style={{ background: theme.accent, boxShadow: '0 8px 24px rgba(30,215,96,.4)' }} aria-label="播放">
                      <Play className="h-6 w-6" fill="#000" color="#000" />
                    </button>
                  )}
                  <Shuffle className="h-7 w-7" style={{ color: theme.secondary }} />
                </div>
                <div className="px-8 pb-24">
                  {/* 官方表头：# / 标题 / 专辑 / 添加日期 / 时长 */}
                  <div className="grid items-center gap-4 border-b px-4 pb-2 text-xs" style={{ gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,3fr) minmax(0,2fr) 48px', borderColor: theme.divider, color: theme.secondary }}>
                    <span className="text-center">#</span><span />
                    <span>标题</span><span>专辑</span><span>添加日期</span>
                    <span className="justify-self-end pr-2"><Clock className="h-4 w-4" /></span>
                  </div>
                  {detail.rows.map((row, i) => (
                    <div key={row.uid ?? row.track.id + i}
                      className="group grid items-center gap-4 rounded px-4 py-2 text-sm hover:bg-white/10"
                      style={{
                        gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,3fr) minmax(0,2fr) 48px',
                        color: currentSong?.mid === row.track.id ? theme.accent : theme.text,
                        background: currentSong?.mid === row.track.id ? theme.panel : undefined,
                      }}
                      onDoubleClick={() => {
                        const songs = playlistSongs(detail.rows)
                        onPlaySongs(songs[i], songs, i)
                      }}
                      onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song: songs0(detail.rows, i), songs: playlistSongs(detail.rows) }) }}
                    >
                      <span className="group-hover:hidden text-center" style={{ color: theme.secondary }}>{i + 1}</span>
                      <span className="hidden group-hover:justify-center text-white"><Play className="h-4 w-4" fill="currentColor" /></span>
                      {row.track.album?.images?.[0]?.url
                        ? <img src={row.track.album.images[0].url} alt="" className="h-10 w-10 rounded object-cover" />
                        : <span className="flex h-10 w-10 items-center justify-center rounded" style={{ background: theme.panel }}>
                            <Music2 className="h-4 w-4" style={{ color: theme.secondary }} />
                          </span>}
                      <span className="min-w-0">
                        <span className="block truncate font-medium" style={{ color: currentSong?.mid === row.track.id ? theme.accent : theme.text }}>{row.track.name}</span>
                        <span className="block truncate text-xs hover:underline" style={{ color: theme.secondary }}>{row.track.artists.map(a => a.name).join(' / ')}</span>
                      </span>
                      <span
                        className="truncate text-xs hover:underline cursor-pointer"
                        style={{ color: theme.secondary }}
                        onClick={e => { e.stopPropagation(); const albumId = row.albumUri || row.track.album?.id; if (albumId) setView({ kind: 'album', id: albumId }) }}
                      >
                        {row.track.album?.name ?? ''}
                      </span>
                      <span className="truncate text-xs" style={{ color: theme.secondary }}>{fmtDate(row.addedAt)}</span>
                      <span className="justify-self-end text-xs" style={{ color: theme.secondary }}>{fmtDuration(row.track.duration_ms)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : <p className="px-8 py-16 text-center" style={{ color: theme.secondary }}>歌单加载失败</p>
          )}

          {/* 艺人页 */}
          {view.kind === 'artist' && (
            <SpotifyArtistInline artistId={view.id} active={active} onPlaySongs={onPlaySongs} theme={theme} accent={accent} onOpenAlbum={albumId => setView({ kind: 'album', id: albumId })} onSongMenu={onSongMenu} onOpenLiked={() => setView({ kind: 'liked' })} onOpenPlaylistId={id => setView({ kind: 'playlist', id })} onOpenRelatedArtist={id => { setView({ kind: 'artist', id }); mainScrollRef.current?.scrollTo({ top: 0 }) }} onPlayNext={onPlayNext} />
          )}
        </main>
      </div>
    </div>
  )
}

// 便利函数：从 detail 行取 Song（供右键菜单/播放）
function songs0(rows: Array<{ track: SpotifyTrack }>, i: number): Song {
  const t = rows[i].track
  return {
    id: Number(parseInt(t.id.slice(0, 12), 36)) || 0, mid: t.id, name: t.name,
    artists: t.artists.map((a: { name: string }) => ({ name: a.name })),
    album: { name: t.album?.name ?? '', picUrl: t.album?.images?.[0]?.url ?? '' },
    duration: t.duration_ms ?? 0, platform: 'spotify',
  }
}

function playlistSongs(rows: Array<{ track: SpotifyTrack }>): Song[] {
  return rows.map(r => songs0(rows, rows.indexOf(r)))
}

/** 艺人页内联组件（复用 queryArtistOverview；官方艺人页布局） */
function SpotifyArtistInline({ artistId, active, onPlaySongs, theme, accent, onOpenAlbum, onSongMenu, onOpenLiked, onOpenPlaylistId, onOpenRelatedArtist, onPlayNext }: {
  artistId: string
  active: boolean
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  theme: ReturnType<typeof spotifyPcTheme>
  accent: string
  onOpenAlbum: (albumId: string) => void
  onSongMenu?: (event: { x: number; y: number; song: Song; songs?: Song[] }) => void
  onOpenLiked?: () => void
  onOpenPlaylistId?: (playlistId: string) => void
  onOpenRelatedArtist?: (artistId: string) => void
  onPlayNext?: (song: Song) => void
}) {
  const [data, setData] = useState<{
    name: string; avatarUrl: string; verified: boolean; followers: number; monthly: number
    topTracks: Array<{ id: string; name: string; artist: string; coverUrl: string; durationMs: number; playcount: number; albumName: string; explicit: boolean }>
    albums: Array<{ id: string; name: string; coverUrl: string; year?: string; tracks: number }>
    singles: Array<{ id: string; name: string; coverUrl: string; year?: string; tracks: number }>
    latest: { id: string; name: string; coverUrl: string; year?: string; type: string } | null
    popularReleases: Array<{ id: string; name: string; coverUrl: string; year?: string; type: string }>
    bio: string
    featuredPlaylists: Array<{ id: string; name: string; coverUrl: string; owner: string }>
    relatedArtists: Array<{ id: string; name: string; coverUrl: string }>
    pick: { name: string; coverUrl: string; subtitle: string; albumId: string } | null
  } | null>(null)

  const load = useCallback(async () => {
    const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok: boolean; data?: any }> } } }).electron?.spotifyPartner
    if (!b) return
    const res = await b.request('query', { name: 'queryArtistOverview', variables: { uri: `spotify:artist:${artistId}`, locale: 'zh-CN', includePrerelease: false } })
    const au = res?.data?.artistUnion
    if (!au) return
    const profile = au.profile ?? {}
    // 桌面端 schema：热门曲目在 discography.topTracks.items[].track（扁平 Track 节点：
    // name/uri/playcount/duration/artists.items/albumOfTrack{coverArt,uri}）
    const topTracks = (au.discography?.topTracks?.items ?? []).map((item: any) => {
      const d = item?.track ?? item?.data ?? item
      const id = String(d?.uri ?? '').replace('spotify:track:', '')
      return {
        id,
        name: String(d?.name ?? ''),
        artist: (d?.artists?.items ?? d?.albumOfTrack?.artists?.items ?? []).map((a: any) => a?.profile?.name ?? '').filter(Boolean).join(' / '),
        coverUrl: d?.albumOfTrack?.coverArt?.sources?.[0]?.url ?? '',
        durationMs: Number(d?.duration?.totalMilliseconds) || Number(d?.trackDuration?.totalMilliseconds) || 0,
        playcount: Number(d?.playcount) || 0,
        albumName: '',
        explicit: Boolean(d?.explicit),
      }
    }).filter((t: any) => t.id)
    topTracks.sort((a: any, b: any) => b.playcount - a.playcount)
    const albums = (au.discography?.albums?.items ?? []).map((item: any) => {
      const rel = item?.releases?.items?.[0]
      return { id: String(rel?.uri ?? '').replace('spotify:album:', ''), name: String(rel?.name ?? ''), coverUrl: rel?.coverArt?.sources?.[0]?.url ?? '', year: rel?.date?.year ? String(rel.date.year) : '', tracks: Number(rel?.tracks?.totalCount) || 0 }
    }).filter((a: any) => a.id)
    // 官方艺人页 discography 分「专辑」「单曲和合辑」两区（same release mapping）
    const singles = (au.discography?.singles?.items ?? []).map((item: any) => {
      const rel = item?.releases?.items?.[0]
      return { id: String(rel?.uri ?? '').replace('spotify:album:', ''), name: String(rel?.name ?? ''), coverUrl: rel?.coverArt?.sources?.[0]?.url ?? '', year: rel?.date?.year ? String(rel.date.year) : '', tracks: Number(rel?.tracks?.totalCount) || 0 }
    }).filter((a: any) => a.id)
    // 官方「艺人之选」缺省数据源 + 「唱片目录-热门新歌」页签：discography.latest / popularReleasesAlbums
    const relOf = (item: any) => {
      const rel = item && (item.releases?.items?.[0] ?? item)
      if (!rel?.uri) return null
      return { id: String(rel.uri).replace('spotify:album:', ''), name: String(rel.name ?? ''), coverUrl: rel?.coverArt?.sources?.[0]?.url ?? '', year: rel?.date?.year ? String(rel.date.year) : '', type: String(rel.__typename ?? 'Album').includes('Single') ? '单曲' : '专辑' }
    }
    const latestRelease = relOf(au.discography?.latest)
    const popularReleases = (au.discography?.popularReleasesAlbums?.items ?? [])
      .map(relOf).filter((x: any) => x?.id && (!latestRelease || x.id !== latestRelease.id))
      .slice(0, 20) as Array<{ id: string; name: string; coverUrl: string; year?: string; type: string }>
    setData({
      name: String(profile.name ?? '艺人'),
      // 头像在 au.visuals.avatarImage（不在 profile.visuals）
      avatarUrl: String(au.visuals?.avatarImage?.sources?.[0]?.url ?? profile.visuals?.avatarImage?.sources?.[0]?.url ?? ''),
      verified: Boolean(au.onPlatformReputationTrait?.verification?.isVerified ?? profile.verified),
      followers: Number(au.stats?.followers ?? 0),
      monthly: Number(au.stats?.monthlyListeners ?? 0),
      topTracks, albums, singles,
      latest: latestRelease,
      popularReleases,
      bio: String(profile.biography?.text ?? ''),
      // 官方「含有此艺人的歌单」：featuringV2 优先，discoveredOnV2 补充（条目可能是 GenericError，过滤掉）
      // 封面在 images.items[0].sources[0]（pickasso CDN），owner 在 ownerV2.data.name
      featuredPlaylists: [...(au.relatedContent?.featuringV2?.items ?? []), ...(au.relatedContent?.discoveredOnV2?.items ?? [])]
        .map((it: any) => {
          const d = it?.data ?? it
          const uri = String(d?.uri ?? it?.uri ?? '')
          const name = String(d?.name ?? d?.profile?.name ?? '')
          if (!uri.startsWith('spotify:playlist:') || !name || d?.__typename === 'GenericError') return null
          return {
            id: uri.replace('spotify:playlist:', ''),
            name,
            coverUrl: d?.images?.items?.[0]?.sources?.[0]?.url ?? d?.coverArt?.sources?.[0]?.url ?? d?.images?.[0]?.url ?? '',
            owner: String(d?.ownerV2?.data?.name ?? d?.owner?.name ?? d?.owner?.display_name ?? ''),
          }
        })
        .filter(Boolean)
        .filter((p: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.id === p.id) === i)
        .slice(0, 20) as Array<{ id: string; name: string; coverUrl: string; owner: string }>,
      // 官方「粉丝也喜欢」：relatedArtists 圆形艺人排
      relatedArtists: (au.relatedContent?.relatedArtists?.items ?? [])
        .map((it: any) => {
          const d = it?.data ?? it
          const uri = String(d?.uri ?? it?.uri ?? '')
          const name = String(d?.profile?.name ?? d?.name ?? '')
          if (!uri.startsWith('spotify:artist:') || !name) return null
          return { id: uri.replace('spotify:artist:', ''), name, coverUrl: d?.visuals?.avatarImage?.sources?.[0]?.url ?? d?.images?.[0]?.url ?? '' }
        })
        .filter(Boolean)
        .filter((a: any, i: number, arr: any[]) => arr.findIndex((x: any) => x.id === a.id) === i) as Array<{ id: string; name: string; coverUrl: string }>,
      // 艺人之选（官方口径）：goods.artistPick 优先，缺省用 discography.latest（最新发布）
      pick: au.goods?.artistPick?.data ? {
        name: String(au.goods.artistPick.data.name ?? au.goods.artistPick.data.album?.name ?? ''),
        coverUrl: au.goods.artistPick.data.coverArt?.sources?.[0]?.url ?? '',
        subtitle: String(au.goods.artistPick.str ?? '单曲'),
        albumId: String(au.goods.artistPick.data.uri ?? au.goods.artistPick.data.album?.uri ?? '').replace('spotify:album:', ''),
      } : latestRelease ? {
        name: latestRelease.name,
        coverUrl: latestRelease.coverUrl,
        subtitle: '单曲',
        albumId: latestRelease.id,
      } : null,
    })
  }, [artistId])

  useEffect(() => { if (active) void load() }, [active, load])

  // 官方「你已点赞」卡片 + 行内喜欢状态：都以用户喜欢列表为真值源
  const [likedCount, setLikedCount] = useState<number | null>(null)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!active || !artistId) return
    let cancelled = false
    void import('../../services/spotifyPartnerData').then(({ fetchPartnerLikedRows }) =>
      fetchPartnerLikedRows(500).then(rows => {
        if (cancelled) return
        const count = (rows ?? []).filter(r => (r.track?.artists ?? []).some(a => a.id === artistId)).length
        setLikedCount(count)
        setSavedIds(new Set((rows ?? []).map(r => String(r.track?.id ?? '')).filter(Boolean)))
      }).catch(() => setLikedCount(null)),
    )
    return () => { cancelled = true }
  }, [active, artistId])

  // 行内喜欢切换（桥 library 写操作 + 乐观更新）
  const toggleSaved = (trackId: string) => {
    const next = !savedIds.has(trackId)
    setSavedIds(prev => { const s = new Set(prev); if (next) s.add(trackId); else s.delete(trackId); return s })
    const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok?: boolean }> } } }).electron?.spotifyPartner
    void bridge?.request('library', { uri: `spotify:track:${trackId}`, saved: next }).then(res => {
      if (!res?.ok) setSavedIds(prev => { const s = new Set(prev); if (next) s.delete(trackId); else s.add(trackId); return s })
    }).catch(() => undefined)
  }

  // 关注态（官方艺人页「关注/正在关注」按钮）：Web API 查询失败时用官方快照兜底
  const dragScrollRef = useDragScrollRef()
  const [showAllTop, setShowAllTop] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  // 官方「曲目预览」全屏层（预览按钮进入；轮播热门曲目，随真实时长自动前进）
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [previewProgress, setPreviewProgress] = useState(0)
  const [previewMenuOpen, setPreviewMenuOpen] = useState(false)
  const [previewMuted, setPreviewMuted] = useState(false)
  const [discogChip, setDiscogChip] = useState<'popular' | 'albums' | 'singles'>('popular')
  useEffect(() => {
    if (!previewOpen) return
    const t = data?.topTracks[previewIndex]
    if (!t) return
    const startedAt = Date.now()
    setPreviewProgress(0)
    const timer = setInterval(() => {
      const ratio = (Date.now() - startedAt) / Math.max(t.durationMs, 8000)
      if (ratio >= 1) setPreviewIndex(i => (i + 1) % (data?.topTracks.length || 1))
      else setPreviewProgress(ratio)
    }, 400)
    return () => clearInterval(timer)
  }, [previewOpen, previewIndex, data])
  const moreMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreMenuOpen) return
    const onDown = (e: MouseEvent) => { if (!moreMenuRef.current?.contains(e.target as Node)) setMoreMenuOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [moreMenuOpen])
  const [followed, setFollowed] = useState<boolean | null>(null)
  useEffect(() => {
    if (!active || !artistId) return
    let cancelled = false
    void import('../../services/spotifyService').then(({ areSpotifyArtistsFollowed }) =>
      areSpotifyArtistsFollowed([artistId]).then(async set_ => {
        if (cancelled) return
        if (set_.has(artistId)) { setFollowed(true); return }
        // Web API 未命中时用官方 profile 快照兜底（429 池饱和时 contains 不可靠）
        const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<PartnerSnapshot> } } }).electron?.spotifyPartner
        if (!b) { setFollowed(false); return }
        const snap = await b.request('profile_snapshot').catch(() => null)
        const data = ((snap as PartnerSnapshot)?.data ?? snap) as PartnerSnapshot['data']
        // 快照文件里 followingArtists 在顶层（profile 下只有公开歌单）
        const following = (data?.profile?.followingArtists ?? (data as { followingArtists?: Array<{ uri?: string }> })?.followingArtists ?? [])
        setFollowed(following.some(a => String(a.uri ?? '').endsWith(artistId)))
      }),
    ).catch(() => setFollowed(null))
    return () => { cancelled = true }
  }, [active, artistId])

  const toggleFollow = () => {
    const next = !followed
    setFollowed(next) // 乐观更新
    void import('../../services/spotifyService').then(({ followSpotifyArtists }) =>
      followSpotifyArtists([artistId], next).then(ok => {
        if (!ok) setFollowed(!next)
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: ok ? (next ? '已关注艺人' : '已取消关注') : '操作失败，请检查登录状态', type: ok ? 'success' : 'error' } }))
        if (ok) window.dispatchEvent(new CustomEvent('playlist-content-changed', { detail: { platform: 'spotify', type: 'follow-artists' } }))
      }),
    ).catch(() => setFollowed(!next))
  }

  if (!data) return <p className="px-8 py-16 text-center" style={{ color: theme.secondary }}>加载中…</p>

  const topSongs: Song[] = data.topTracks.map(t => ({
    id: Number(parseInt(t.id.slice(0, 12), 36)) || 0, mid: t.id, name: t.name,
    artists: t.artist.split(' / ').map(n => ({ name: n })),
    album: { name: t.albumName, picUrl: t.coverUrl },
    duration: t.durationMs, platform: 'spotify',
  }))

  // 官方格式：83.6万 / 8998万 / 1.3亿（万以下一位小数，整万不带 .0）
  const fmtF = (n: number) => n >= 100000000 ? `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}亿` : n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万` : String(n)
  const chipKeyIsLatest = (a: { id: string }) => Boolean(data.latest && a.id === data.latest.id)
  const previewTrack = data.topTracks[previewIndex]

  return (
    <div>
      {/* 官方头部：圆头像左 + 右侧（认证徽章 / 大名 / 每月听众） */}
      <div className="relative flex items-end gap-6 px-8 pb-6 pt-20">
        {data.avatarUrl
          ? <img src={data.avatarUrl} alt="" className="h-[192px] w-[192px] rounded-full object-cover shadow-2xl" />
          : <span className="flex h-[192px] w-[192px] items-center justify-center rounded-full shadow-2xl" style={{ background: theme.panel }} />}
        <div className="min-w-0 flex-1">
          {data.verified && (
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium" style={{ color: theme.text }}>
              <BadgeCheck className="h-5 w-5" style={{ color: '#4cb3ff' }} fill="#4cb3ff" />
              已获 Spotify 认证
            </p>
          )}
          <h1 className="text-[clamp(2rem,5vw,4.5rem)] font-black leading-tight" style={{ color: theme.text }}>{data.name}</h1>
          {data.monthly > 0 && <p className="mt-3 text-sm" style={{ color: theme.text }}>每月有 {fmtF(data.monthly)} 名听众</p>}
        </div>
      </div>
      {/* 官方操作行：播放（绿圆）/ 随机 / 关注 / ...（菜单对齐官方：取消关注/不播放/电台/举报/分享） */}
      <div className="flex items-center gap-6 px-8 py-6">
        {topSongs.length > 0 && (
          <button type="button" onClick={() => onPlaySongs(topSongs[0], topSongs, 0)}
            className="flex h-14 w-14 items-center justify-center rounded-full transition hover:scale-105"
            style={{ background: theme.accent, boxShadow: '0 8px 24px rgba(30,215,96,.4)' }} aria-label="播放">
            <Play className="h-6 w-6" fill="#000" color="#000" />
          </button>
        )}
        {topSongs.length > 0 && (
          <button type="button" onClick={() => { setPreviewIndex(0); setPreviewOpen(true); onPlaySongs(topSongs[0], topSongs, 0) }}
            className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg border-2 transition hover:scale-105"
            style={{ borderColor: 'rgba(255,255,255,.6)' }} aria-label="滚动浏览此艺人的曲目预览" title="滚动浏览此艺人的曲目预览">
            {topSongs[0].album?.picUrl
              ? <img src={topSongs[0].album.picUrl} alt="" className="h-full w-full object-cover" />
              : <span className="flex h-full w-full items-center justify-center" style={{ background: theme.panel }}><Play className="h-4 w-4" fill="currentColor" /></span>}
          </button>
        )}
        <button type="button" onClick={() => {
          // 官方随机：随机打散热门曲目后从随机一首开始播
          const shuffled = [...topSongs]
          for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]] }
          onPlaySongs(shuffled[0], shuffled, 0)
        }} className="rounded p-1 transition hover:scale-105" style={{ color: theme.secondary }} aria-label="随机播放">
          <Shuffle className="h-7 w-7" />
        </button>
        <button type="button" onClick={toggleFollow}
          className="rounded-full border px-5 py-1.5 text-sm font-bold transition hover:scale-105"
          style={{ borderColor: followed ? 'rgba(255,255,255,.6)' : theme.text, color: theme.text }}>
          {followed ? '正在关注' : '关注'}
        </button>
        <div className="relative" ref={moreMenuRef}>
          <button type="button" onClick={() => setMoreMenuOpen(v => !v)}
            className="rounded-full border border-transparent p-2 transition hover:border-white/30" style={{ color: theme.secondary }} aria-label="更多">
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {moreMenuOpen && (
            <div className="absolute left-0 top-10 z-40 w-56 overflow-hidden rounded-md py-1 shadow-2xl" style={{ background: '#282828' }} role="menu">
              {([
                { key: 'follow', label: followed ? '取消关注' : '关注', icon: X, green: true, action: toggleFollow },
                { key: 'ban', label: '不要播放此艺人的歌曲', icon: Ban, action: () => {
                  let banned: string[] = []
                  try { banned = JSON.parse(localStorage.getItem('waveforge:spotify-banned-artists') || '[]') } catch { banned = [] }
                  if (!banned.includes(data.name)) banned.push(data.name)
                  localStorage.setItem('waveforge:spotify-banned-artists', JSON.stringify(banned))
                  window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '将不再播放此艺人的歌曲', type: 'success' } }))
                } },
                { key: 'radio', label: '转至艺人电台', icon: RadioIcon, action: () => {
                  if (!topSongs[0]) return
                  const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok?: boolean; data?: { uri?: string } | null }> } } }).electron?.spotifyPartner
                  void bridge?.request('radio', { id: topSongs[0].mid }).then(res => {
                    const uri = res?.data?.uri
                    if (res?.ok && uri) window.dispatchEvent(new CustomEvent('waveforge:open-playlist', { detail: { platform: 'spotify', playlistId: String(uri).replace('spotify:playlist:', '') } }))
                  }).catch(() => undefined)
                } },
                { key: 'report', label: '举报', icon: Flag, external: true, action: () => {
                  const url = `https://support.spotify.com/report-abuse/?context=artist&uri=spotify:artist:${artistId}`
                  const shell = (window as unknown as { electron?: { shell?: { openExternal?: (u: string) => void } } }).electron?.shell
                  if (shell?.openExternal) shell.openExternal(url)
                  else window.open(url, '_blank')
                } },
                { key: 'share', label: '分享', icon: Share, action: () => {
                  void navigator.clipboard?.writeText(`https://open.spotify.com/artist/${artistId}`).then(() =>
                    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已复制艺人链接', type: 'success' } })),
                  ).catch(() => undefined)
                } },
              ] as Array<{ key: string; label: string; icon: typeof X; green?: boolean; external?: boolean; action: () => void }>).map(item => (
                <button key={item.key} type="button" role="menuitem" onClick={() => { setMoreMenuOpen(false); item.action() }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-white/10" style={{ color: item.green ? theme.accent : '#fff' }}>
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.external && <ArrowUpRight className="h-4 w-4 opacity-60" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {/* 热门（官方：收起 1 列 5 行，显示更多后 2 列 10 行）+ 右侧「你已点赞」「艺人之选」卡 */}
      {(topSongs.length > 0 || (likedCount ?? 0) > 0 || data.pick) && (
        <div className="flex flex-wrap items-start gap-8 px-8 pb-8">
          {topSongs.length > 0 && (
            <div className="min-w-0 flex-1" style={{ minWidth: 460 }}>
              <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>热门</h2>
              <div className={showAllTop ? 'grid gap-x-8 xl:grid-cols-2' : ''}>
                {(showAllTop ? data.topTracks : data.topTracks.slice(0, 5)).map((t, i) => (
                  <div key={t.id}
                    className="group grid items-center gap-4 rounded px-3 py-2 text-sm hover:bg-white/10"
                    style={{ gridTemplateColumns: '24px 40px minmax(0,1fr) 110px 56px 40px', color: theme.text }}
                    onDoubleClick={() => onPlaySongs(topSongs[i], topSongs, i)}
                    onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song: topSongs[i], songs: topSongs }) }}
                  >
                    <span className="group-hover:hidden text-center" style={{ color: theme.secondary }}>{i + 1}</span>
                    <span className="hidden group-hover:justify-center text-white"><Play className="h-4 w-4" fill="currentColor" /></span>
                    {t.coverUrl ? <img src={t.coverUrl} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded" style={{ background: theme.panel }} />}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{t.name}</span>
                      <span className="flex items-center gap-1.5 text-xs" style={{ color: theme.secondary }}>
                        {t.explicit && <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold" style={{ background: theme.panel, color: theme.secondary }}>E</span>}
                        <span className="truncate">{t.artist}</span>
                      </span>
                    </span>
                    <span className="truncate text-right text-xs" style={{ color: theme.secondary }}>{t.playcount.toLocaleString('en-US')}</span>
                    <span className="justify-self-end text-xs" style={{ color: theme.secondary }}>{fmtDuration(t.durationMs)}</span>
                    <button type="button" aria-label={savedIds.has(t.id) ? '取消喜欢' : '喜欢'}
                      onClick={e => { e.stopPropagation(); toggleSaved(t.id) }}
                      className="justify-self-end rounded-full p-1 transition hover:scale-110">
                      <Heart className={`h-4 w-4 ${savedIds.has(t.id) ? 'fill-current' : 'opacity-0 group-hover:opacity-100'}`} style={{ color: savedIds.has(t.id) ? theme.accent : theme.secondary }} />
                    </button>
                  </div>
                ))}
              </div>
              {data.topTracks.length > 5 && (
                <button type="button" onClick={() => setShowAllTop(v => !v)}
                  className="mt-3 px-3 text-sm font-bold transition hover:scale-105" style={{ color: theme.secondary }}>
                  {showAllTop ? '显示更少' : '显示更多'}
                </button>
              )}
            </div>
          )}
          <div className="flex shrink-0 gap-10">
            {(likedCount ?? 0) > 0 && (
              <div className="w-[210px]">
                <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>你已点赞</h2>
                <button type="button" onClick={onOpenLiked} className="flex w-full items-center gap-4 rounded-lg p-3 text-left transition hover:bg-white/5">
                  <span className="relative shrink-0">
                    {data.avatarUrl
                      ? <img src={data.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
                      : <span className="h-16 w-16 rounded-full" style={{ background: theme.panel }} />}
                    <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full" style={{ background: theme.accent }}>
                      <Heart className="h-3 w-3" fill="#000" color="#000" />
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-lg font-bold" style={{ color: theme.text }}>{likedCount} 首歌曲</span>
                    <span className="block truncate text-xs" style={{ color: theme.secondary }}>创建者：{data.name}</span>
                  </span>
                </button>
              </div>
            )}
            {data.pick && (
              <div className="w-[210px]">
                <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>艺人之选</h2>
                <button type="button" className="flex w-full items-center gap-4 rounded-lg p-3 text-left transition hover:bg-white/5"
                  onClick={() => { const id = data.pick?.albumId; if (id) onOpenAlbum(id) }}>
                  {data.pick.coverUrl
                    ? <img src={data.pick.coverUrl} alt="" className="h-16 w-16 shrink-0 rounded object-cover" />
                    : <span className="h-16 w-16 shrink-0 rounded" style={{ background: theme.panel }} />}
                  <span className="min-w-0">
                    <span className="mb-1 inline-flex items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-2" style={{ background: 'rgba(255,255,255,.12)' }}>
                      {data.avatarUrl && <img src={data.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />}
                      <span className="text-[10px] font-bold" style={{ color: theme.text }}>{data.name}</span>
                    </span>
                    <span className="block truncate text-sm font-bold" style={{ color: theme.text }}>{data.pick.name}</span>
                    <span className="block truncate text-xs" style={{ color: theme.secondary }}>{data.pick.subtitle}</span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {/* 官方「唱片目录」：热门新歌/专辑/单曲和 EP 页签 + 最新发布副标题 + 悬停播放 */}
      {(() => {
        const chips = [
          { key: 'popular', label: '热门新歌' },
          { key: 'albums', label: '专辑' },
          { key: 'singles', label: '单曲和 EP' },
        ] as const
        const listFor = (key: typeof chips[number]['key']) => {
          if (key === 'albums') return [...data.albums].map(a => ({ ...a, type: '专辑' }))
          if (key === 'singles') return [...data.singles].map(a => ({ ...a, type: '单曲' }))
          return [...(data.latest ? [{ ...data.latest }] : []), ...data.popularReleases]
        }
        const current = listFor(discogChip)
        return (current.length > 0 && (
          <div className="px-8 pb-8">
            <div className="mb-4 flex items-end justify-between">
              <h2 className="text-2xl font-bold" style={{ color: theme.text }}>唱片目录</h2>
              <button type="button" className="flex items-center text-xs font-bold transition hover:opacity-80" style={{ color: theme.secondary }}
                onClick={() => onOpenAlbum(current[0].id)}>
                显示全部
              </button>
            </div>
            <div className="mb-4 flex gap-2">
              {chips.map(chip => (
                <button key={chip.key} type="button" onClick={() => setDiscogChip(chip.key)}
                  className="rounded-full px-3 py-1.5 text-xs font-bold transition"
                  style={{ background: discogChip === chip.key ? theme.text : theme.panel, color: discogChip === chip.key ? theme.background : theme.secondary }}>
                  {chip.label}
                </button>
              ))}
            </div>
            <div ref={dragScrollRef} className="drag-scroll-x flex gap-4">
              {current.map((a, i) => (
                <button key={a.id} type="button" className="group w-[172px] shrink-0 rounded-lg p-3 text-left transition hover:bg-white/5"
                  onClick={() => onOpenAlbum(a.id)}>
                  <span className="relative mb-3 block aspect-square w-full overflow-hidden rounded shadow-lg" style={{ background: theme.panel }}>
                    {a.coverUrl && <img src={a.coverUrl} alt="" className="h-full w-full object-cover" />}
                    <span className="absolute bottom-2 right-2 flex h-12 w-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100"
                      style={{ background: theme.accent }}>
                      <Play className="ml-0.5 h-5 w-5" fill="#000" color="#000" />
                    </span>
                  </span>
                  <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                  <span className="block text-xs" style={{ color: theme.secondary }}>
                    {chipKeyIsLatest(a)
                      ? `最新发布 · ${data.singles.some(s => s.id === a.id) ? '单曲' : '专辑'}`
                      : `${a.year || ''}${a.year ? ' · ' : ''}${a.type}`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))
      })()}
      {/* 官方「关于」卡：大图横幅 + 圆头像 + 原始月听众数 + 简介 */}
      {(data.avatarUrl || data.bio) && (
        <div className="px-8 pb-8">
          <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>关于</h2>
          <div className="overflow-hidden rounded-xl" style={{ background: theme.content }}>
            {data.avatarUrl && (
              <div className="relative flex h-[280px] items-center justify-center" style={{ backgroundImage: `url(${data.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center 20%' }}>
                <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(18,18,18,.25), rgba(18,18,18,.75))' }} />
                <div className="relative flex flex-col items-center">
                  {data.avatarUrl && <img src={data.avatarUrl} alt="" className="h-28 w-28 rounded-full object-cover shadow-2xl" />}
                  {data.monthly > 0 && <p className="mt-3 text-lg font-bold" style={{ color: '#fff' }}>每月有 {data.monthly.toLocaleString('en-US')} 名听众</p>}
                </div>
              </div>
            )}
            {data.bio && <p className="max-h-40 overflow-y-auto whitespace-pre-line px-6 py-4 text-sm leading-relaxed" style={{ color: theme.secondary }}>{data.bio}</p>}
          </div>
        </div>
      )}
      {/* 官方「含有此艺人的歌单」：featuring/discoveredOn 横排 */}
      {(data.featuredPlaylists ?? []).length > 0 && (
        <div className="px-8 pb-8">
          <div className="mb-4 flex items-end justify-between">
            <h2 className="text-2xl font-bold" style={{ color: theme.text }}>含有此艺人的歌单</h2>
            <button type="button" className="flex items-center text-xs font-bold transition hover:opacity-80" style={{ color: theme.secondary }}
              onClick={() => onOpenPlaylistId?.(data.featuredPlaylists[0].id)}>
              显示全部 <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          <div ref={dragScrollRef} className="drag-scroll-x flex gap-4">
            {data.featuredPlaylists.map(p => (
              <button key={p.id} type="button" className="group w-[172px] shrink-0 rounded-lg p-3 text-left transition hover:bg-white/5"
                onClick={() => onOpenPlaylistId?.(p.id)}>
                {p.coverUrl
                  ? <img src={p.coverUrl} alt="" className="mb-3 aspect-square w-full rounded object-cover shadow-lg" />
                  : <span className="mb-3 flex aspect-square w-full items-center justify-center rounded shadow-lg" style={{ background: theme.panel }}><Music2 className="h-8 w-8" style={{ color: theme.secondary }} /></span>}
                <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{p.name}</span>
                <span className="block truncate text-xs" style={{ color: theme.secondary }}>{p.owner ? `歌单 · ${p.owner}` : '歌单'}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* 官方「粉丝也喜欢」：圆形艺人排 */}
      {(data.relatedArtists ?? []).length > 0 && (
        <div className="px-8 pb-24">
          <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>粉丝也喜欢</h2>
          <div ref={dragScrollRef} className="drag-scroll-x flex gap-4">
            {data.relatedArtists.map(a => (
              <button key={a.id} type="button" className="group w-[172px] shrink-0 rounded-lg p-3 text-center transition hover:bg-white/5"
                onClick={() => onOpenRelatedArtist?.(a.id)}>
                {a.coverUrl
                  ? <img src={a.coverUrl} alt="" className="mx-auto mb-3 aspect-square w-full rounded-full object-cover shadow-lg" />
                  : <span className="mx-auto mb-3 flex aspect-square w-full items-center justify-center rounded-full shadow-lg" style={{ background: theme.panel }}><Music2 className="h-8 w-8" style={{ color: theme.secondary }} /></span>}
                <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                <span className="block text-xs" style={{ color: theme.secondary }}>艺人</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {/* 官方「曲目预览」层：居中圆角面板 + 封面取色毛玻璃扩散背景 */}
      {previewOpen && previewTrack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(0,0,0,.8)' }} onClick={() => setPreviewOpen(false)}>
          <div className="relative flex h-[82%] w-[68%] flex-col overflow-hidden rounded-2xl shadow-2xl" style={{ background: '#181818' }} onClick={e => e.stopPropagation()}>
            {/* 官方背景：封面取色扩散 + 毛玻璃（模糊封面铺底 + 暗化） */}
            <div aria-hidden className="absolute inset-0 z-0">
              {previewTrack.coverUrl
                ? <img src={previewTrack.coverUrl} alt="" className="h-full w-full scale-150 object-cover opacity-45 blur-3xl" />
                : null}
              <div className="absolute inset-0" style={{ background: 'rgba(10,10,10,.55)' }} />
            </div>
            {/* 底缘中央：下一首封面探出（官方同款，被面板底边裁切） */}
            <div className="pointer-events-none absolute inset-x-0 -bottom-16 z-0 flex justify-center">
              {(() => {
                const nextTrack = data.topTracks[(previewIndex + 1) % (data.topTracks.length || 1)]
                return nextTrack?.coverUrl ? <img src={nextTrack.coverUrl} alt="" className="h-40 w-40 rounded-lg object-cover opacity-90 shadow-2xl" /> : null
              })()}
            </div>
            {/* 顶缘中央：上一首封面探出（官方三封面轮播） */}
            <div className="pointer-events-none absolute inset-x-0 -top-16 z-0 flex justify-center">
              {(() => {
                const prevTrack = data.topTracks[(previewIndex - 1 + data.topTracks.length) % (data.topTracks.length || 1)]
                return prevTrack?.coverUrl ? <img src={prevTrack.coverUrl} alt="" className="h-40 w-40 rounded-lg object-cover opacity-90 shadow-2xl" /> : null
              })()}
            </div>
            {/* 顶栏：艺人名 + 右侧音量(点击静音)/律动频谱/关闭 */}
            <div className="relative z-10 flex items-center justify-between px-9 pt-6 pb-4">
              <p className="text-lg font-bold" style={{ color: '#fff' }}>{data.name}</p>
              <div className="flex items-center gap-6" style={{ color: '#b3b3b3' }}>
                <button type="button" onClick={() => { setPreviewMuted(v => !v); window.dispatchEvent(new CustomEvent('waveforge:toggle-mute')) }}
                  aria-label={previewMuted ? '取消静音' : '静音'} className="transition hover:opacity-70">
                  {previewMuted ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
                </button>
                <MiniSpectrum />
                <button type="button" onClick={() => setPreviewOpen(false)} aria-label="关闭预览" className="transition hover:opacity-70">
                  <X className="h-6 w-6" />
                </button>
              </div>
            </div>
            {/* 中部：左曲名(悬停下划线)/艺人/进度 + 大封面 + 两侧频谱 + 最右操作列 */}
            <div className="relative z-10 flex min-h-0 flex-1 items-center justify-center gap-14 px-14" onWheel={e => {
              // 官方交互：预览层鼠标上下滚动直接切歌（切到上/下一首并播放）
              const target = e.deltaY > 0
                ? (previewIndex + 1) % (data.topTracks.length || 1)
                : (previewIndex - 1 + data.topTracks.length) % (data.topTracks.length || 1)
              setPreviewIndex(target)
              onPlaySongs(topSongs[target], topSongs, target)
            }}>
              <div className="w-[360px] shrink-0">
                <button type="button" onClick={() => onPlaySongs(topSongs[previewIndex], topSongs, previewIndex)}
                  className="mb-2 text-5xl font-black transition hover:underline decoration-2 underline-offset-8" style={{ color: '#fff' }}>
                  {previewTrack.name}
                </button>
                <p className="mt-5 mb-12 text-sm" style={{ color: '#b3b3b3' }}>{previewTrack.artist}</p>
                <div className="h-0.5 w-full rounded-full" style={{ background: 'rgba(255,255,255,.25)' }}>
                  <span className="block h-full rounded-full bg-white" style={{ width: `${previewProgress * 100}%` }} />
                </div>
              </div>
              <div className="relative flex items-center gap-5">
                <PreviewSpectrum progress={previewProgress} />
                {previewTrack.coverUrl
                  ? <img src={previewTrack.coverUrl} alt="" className="h-[320px] w-[320px] rounded-xl object-cover shadow-2xl" />
                  : <span className="h-[320px] w-[320px] rounded-xl" style={{ background: theme.panel }} />}
                <PreviewSpectrum progress={previewProgress} />
              </div>
              <div className="relative z-20 flex flex-col items-center gap-7" style={{ color: '#fff' }}>
                <button type="button" aria-label="更多"
                  onClick={e => { setPreviewMenuOpen(false); onSongMenu?.({ x: e.clientX, y: e.clientY, song: topSongs[previewIndex], songs: topSongs }) }}
                  className="transition hover:opacity-70"><MoreHorizontal className="h-5 w-5" /></button>
                <button type="button" aria-label="分享" onClick={() => {
                  // 官方分享链接格式：open.spotify.com/track/<id>?si=<16 位十六进制>
                  const si = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
                  void navigator.clipboard?.writeText(`https://open.spotify.com/track/${previewTrack.id}?si=${si}`).then(() =>
                    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已复制歌曲链接', type: 'success' } })),
                  ).catch(() => undefined)
                }} className="transition hover:opacity-70"><Share className="h-5 w-5" /></button>
                <button type="button" aria-label="添加到播放队列" onClick={() => onPlayNext?.(topSongs[previewIndex])} className="transition hover:opacity-70"><ListPlus className="h-5 w-5" /></button>
                <button type="button" aria-label="添加到音乐库" onClick={() => toggleSaved(previewTrack.id)} className="transition hover:scale-105">
                  {savedIds.has(previewTrack.id)
                    ? <span className="flex h-7 w-7 items-center justify-center rounded-full" style={{ background: theme.accent }}><Check className="h-4 w-4" color="#000" /></span>
                    : <PlusCircle className="h-7 w-7" strokeWidth={1.5} />}
                </button>
              </div>
            </div>
            {/* 底部：头像 + 艺人名（点击进艺人页） + 月听众 + 关注中 chip | 右侧「下一步」（直接切歌） */}
            <div className="relative z-10 flex items-center justify-between px-10 pb-8 pt-4">
              <button type="button" onClick={() => { setPreviewOpen(false); onOpenRelatedArtist?.(artistId) }} className="flex items-center gap-3 text-left transition hover:opacity-80">
                <div className="flex items-center gap-3">
                  {data.avatarUrl && <img src={data.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />}
                  <p className="text-sm font-semibold" style={{ color: '#fff' }}>{data.name}</p>
                  {data.monthly > 0 && <p className="text-sm" style={{ color: '#b3b3b3' }}>· {fmtF(data.monthly)}</p>}
                </div>
                <span className="rounded-full px-3.5 py-1 text-xs font-bold" style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}>{followed ? '关注中' : '关注'}</span>
              </button>
              <button type="button" onClick={() => {
                const target = (previewIndex + 1) % (data.topTracks.length || 1)
                setPreviewIndex(target)
                onPlaySongs(topSongs[target], topSongs, target)
              }}
                className="flex items-center gap-2 rounded-full px-6 py-3 text-base font-bold text-black transition hover:scale-105" style={{ background: 'rgba(255,255,255,.85)' }}>
                下一步 <ArrowDown className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 官方预览层右上角的律动小频谱图标（3 根跳动条） */
function MiniSpectrum() {
  return (
    <span className="flex h-5 w-5 items-end justify-center gap-0.5" aria-hidden>
      {[0, 1, 2].map(b => (
        <span key={b} className="wf-spec-mini" style={{ animationDelay: `${b * 0.2}s` }} />
      ))}
    </span>
  )
}

/** 官方预览层封面两侧的频谱（横向频谱条随进度律动；官方「音频可用律动」指示） */
function PreviewSpectrum({ progress }: { progress: number }) {
  return (
    <span className="wf-spec flex w-16 flex-col justify-center gap-2.5" aria-hidden>
      {[0, 1, 2, 3, 4].map(b => (
        <span key={b} style={{ animationDelay: `${b * 0.18}s`, width: `${55 + ((b * 37 + Math.floor(progress * 60)) % 45)}%` }} />
      ))}
    </span>
  )
}

/** 官方「最近播放」页（账户菜单进入）：按日期分组的播放历史。
 *  数据源：本机播放历史（useEffect 落盘）+ 官方 home 快照「最近播放」板块 + 资料库歌单兜底。
 *  行样式对齐官方：日期组标题（今天/昨天/M月D日周X）+ 56px 圆角封面行。 */
function RecentsInline({ theme, active, username, knownPlaylists, knownArtists, onOpenArtist, onOpenPlaylist }: {
  theme: ReturnType<typeof spotifyPcTheme>
  active: boolean
  username: string
  knownPlaylists: SidebarEntry[]
  knownArtists: SidebarEntry[]
  onOpenArtist: (artistId: string) => void
  onOpenPlaylist: (playlistId: string) => void
}) {
  interface Row { kind: 'song' | 'artist' | 'playlist'; id: string; name: string; cover: string; subtitle: string; at: number; circular?: boolean }
  const [rows, setRows] = useState<Row[]>([])
  useEffect(() => {
    if (!active) return
    const merged: Row[] = []
    // 1) 本机播放历史
    try {
      const history = JSON.parse(localStorage.getItem('waveforge:spotify-play-history') || '[]') as Array<{ id: string; name: string; cover: string; artist: string; at: number }>
      for (const h of history) {
        if (!h.name) continue
        merged.push({ kind: 'song', id: h.id, name: h.name, cover: h.cover ?? '', subtitle: h.artist || '歌曲', at: h.at ?? 0 })
      }
    } catch { /* ignore */ }
    // 2) 官方 home 快照「最近播放」板块（ListResponseWrapper：实体在 content.data.items.items[].entity）
    void (async () => {
      const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok?: boolean; data?: unknown }> } } }).electron?.spotifyPartner
      if (!b) { setRows(merged); return }
      const plName = new Map(knownPlaylists.map(p => [p.id, p]))
      const arName = new Map(knownArtists.map(a => [a.id, a]))
      const seen = new Set(merged.map(r => r.id))
      for (const facet of ['all', 'music'] as const) {
        try {
          const res = await b.request('home_snapshot', { facet })
          const snap = ((res as PartnerSnapshot)?.data ?? res) as PartnerSnapshot['data']
          const sections = snap?.home?.sectionContainer?.sections?.items ?? []
          const rec = sections.find((s: SnapshotSection) => s.data?.title?.transformedLabel === '最近播放')
          for (const item of rec?.sectionItems?.items ?? []) {
            type Entity = { _uri?: string }
            const lists = item?.content?.data?.items?.items as Array<{ entity?: Entity }> | undefined
            for (const entry of lists ?? []) {
              const uri = String(entry?.entity?._uri ?? '')
              if (!uri || seen.has(uri)) continue
              if (uri.startsWith('spotify:artist:')) {
                const id = uri.replace('spotify:artist:', '')
                const known = arName.get(id)
                if (!known) continue
                seen.add(uri)
                merged.push({ kind: 'artist', id, name: known.name, cover: known.coverUrl ?? '', subtitle: '艺人 · 已播放 1 首歌曲', at: 0, circular: true })
              } else if (uri.startsWith('spotify:playlist:')) {
                const id = uri.replace('spotify:playlist:', '')
                const known = plName.get(id)
                if (!known) continue
                seen.add(uri)
                merged.push({ kind: 'playlist', id, name: known.name, cover: known.coverUrl ?? '', subtitle: `歌单 · ${known.isLikedSongs ? '已添加歌单' : username}`, at: 0 })
              }
            }
          }
        } catch { /* ignore */ }
      }
      merged.sort((a, b) => b.at - a.at)
      setRows(merged.slice(0, 60))
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, knownPlaylists, knownArtists])

  // 日期分组（官方口径：今天 / 昨天 / M月D日周X / YYYY年M月D日）
  const groupLabel = (at: number): string => {
    if (!at) return '更早'
    const d = new Date(at)
    const now = new Date()
    const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000)
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
    if (diffDays <= 0) return '今天'
    if (diffDays === 1) return '昨天'
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日${week}`
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  }
  const groups: Array<{ label: string; rows: Row[] }> = []
  for (const row of rows) {
    const label = groupLabel(row.at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.rows.push(row)
    else groups.push({ label, rows: [row] })
  }

  return (
    <div className="px-8 pb-24 pt-14">
      <h1 className="mb-6 text-3xl font-black" style={{ color: theme.text }}>最近播放</h1>
      {groups.length === 0 && <p className="text-sm" style={{ color: theme.secondary }}>暂无播放记录</p>}
      {groups.map(group => (
        <div key={group.label} className="mb-8">
          <h2 className="mb-3 text-xl font-bold" style={{ color: theme.text }}>{group.label}</h2>
          {group.rows.map((row, i) => (
            <button key={row.kind + row.id + i} type="button"
              onClick={() => { if (row.kind === 'artist') onOpenArtist(row.id); else if (row.kind === 'playlist') onOpenPlaylist(row.id) }}
              className="flex w-full items-center gap-4 rounded-md px-2 py-2 text-left transition hover:bg-white/10">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md" style={{ background: theme.panel, borderRadius: row.circular ? '50%' : undefined }}>
                {row.cover
                  ? <img src={row.cover} alt="" className="h-full w-full object-cover" />
                  : row.kind === 'playlist'
                    ? <span className="flex h-[70%] w-[70%] items-center justify-center rounded" style={{ background: 'linear-gradient(135deg,#450af5,#8e8ee5)' }}><Heart className="h-5 w-5" fill="#fff" color="#fff" /></span>
                    : <Music2 className="h-5 w-5" style={{ color: theme.secondary }} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{row.name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: theme.secondary }}>
                  {row.kind === 'playlist' && <Check className="h-3 w-3" style={{ color: theme.accent }} />}
                  {row.subtitle}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0" style={{ color: theme.secondary }} />
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
