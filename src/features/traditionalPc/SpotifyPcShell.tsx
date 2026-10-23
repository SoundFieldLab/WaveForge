// 传统模式「Spotify 客户端」——完整官方复刻外壳（对齐官方三栏布局）：
//  左栏：『音乐库』标题 + 创建/放大按钮 + 歌单|艺人页签 + 搜索框 + 最近播放排序 + 条目列表（已点赞置顶）
//  中栏：当前选中条目的详情（已点赞的歌曲官方紫渐变页 / 歌单详情 / 艺人页 / 发现主页）
//  底部：官方播放条（专辑封面 + 曲名/艺人 + 随机/上一首/播放/下一首/循环）
// 本组件是「自管外壳」：内部导航自管（与 KugouPcShell 同模式），右侧第三栏由 WaveForge 保留。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft, ChevronRight, House, Plus, ArrowUpRight, Search, ListFilter,
  Shuffle, SkipBack, SkipForward, Play, Pause, Repeat, Music2, Heart, Clock, Check,
} from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { spotifyPcTheme } from './spotifyPcKit'
import {
  fetchPartnerMyPlaylists, fetchPartnerLibraryArtists, fetchPartnerLikedRows, fetchPartnerPlaylistDetailFull,
} from '../../services/spotifyPartnerData'
import SpotifyPcHome from './SpotifyPcHome'
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
}

type View =
  | { kind: 'home' }
  | { kind: 'liked' }
  | { kind: 'playlist'; id: string }
  | { kind: 'artist'; id: string }
  | { kind: 'category'; title: string; bg: string; accent: string }
  | { kind: 'album'; id: string }

interface SidebarEntry {
  kind: 'playlist' | 'artist'
  id: string
  name: string
  coverUrl?: string
  subtitle: string
  isLikedSongs?: boolean
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

export default function SpotifyPcShell({
  tone, accent, loggedIn, username, avatar, currentSong, isPlaying, active,
  onPlaySongs, onPlayPause, onNext, onPrevious, onLoginClick, onSongMenu, onOpenPlaylist, onOpenArtist, onOpenAlbum, onSearchSubmit, initialArtistId,
}: SpotifyPcShellProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [view, setView] = useState<View>(initialArtistId ? { kind: 'artist', id: initialArtistId } : { kind: 'home' })
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
  const [libTab, setLibTab] = useState<'playlist' | 'artist'>('playlist')
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
      setArtistEntries((artists ?? []).map(a => ({ kind: 'artist', id: a.id, name: a.name, coverUrl: a.avatarUrl, subtitle: '艺人' })))
    } finally {
      setLoading(false)
    }
  }, [username])

  useEffect(() => {
    if (active && loggedIn) void load()
  }, [active, loggedIn, load])

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

  // 在资料库中搜索：过滤条目列表（官方行为）；回车则跳全局搜索页
  const sidebarItems = (libTab === 'playlist' ? entries : artistEntries)
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

  return (
    <div className="flex h-full flex-col" style={{ background: theme.background }} data-active={active}>
      <div className="flex min-h-0 flex-1">
        {/* ── 左栏：音乐库 ── */}
        <aside className="flex min-h-0 flex-col overflow-hidden border-r" style={{ width: 300, background: theme.content, borderColor: theme.divider }}>
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
          {/* 页签 + 搜索 + 最近播放 */}
          <div className="px-4 pb-2">
            <div className="flex gap-2">
              <button type="button" onClick={() => setLibTab('playlist')}
                className="rounded-full px-3 py-1 text-xs font-bold"
                style={{ background: libTab === 'playlist' ? theme.text : theme.panel, color: libTab === 'playlist' ? theme.background : theme.secondary }}>歌单</button>
              <button type="button" onClick={() => setLibTab('artist')}
                className="rounded-full px-3 py-1 text-xs font-bold"
                style={{ background: libTab === 'artist' ? theme.text : theme.panel, color: libTab === 'artist' ? theme.background : theme.secondary }}>艺人</button>
            </div>
            <div className="mt-3 flex items-center justify-between">
              <div className="flex flex-1 items-center gap-2 rounded-md px-2.5 py-1.5" style={{ background: theme.panel }}>
                <Search className="h-3.5 w-3.5 shrink-0" style={{ color: theme.secondary }} />
                <input
                  value={searchKeyword}
                  onChange={e => setSearchKeyword(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && searchKeyword.trim()) { onSearchSubmit?.(searchKeyword.trim()); setSearchKeyword('') } }}
                  placeholder="在资料库中搜索"
                  className="w-full bg-transparent text-xs outline-none"
                  style={{ color: theme.text }}
                />
              </div>
              <button type="button" className="ml-2 flex shrink-0 items-center gap-1 text-xs transition hover:opacity-80"
                style={{ color: libSortRecents ? theme.accent : theme.secondary }} title="最近播放"
                onClick={() => { setLibSortRecents(v => !v); if (view.kind === 'liked') setLikedSort(libSortRecents ? 'custom' : 'added') }}>
                <ListFilter className="h-3.5 w-3.5" /> 最近播放
              </button>
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
                    <span className="block truncate text-sm font-medium" style={{ color: item.isLikedSongs ? theme.accent : theme.text }}>{item.name}</span>
                    <span className="block truncate text-xs" style={{ color: theme.secondary }}>{item.subtitle}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        {/* ── 中栏：详情区 ── */}
        <main className="min-h-0 flex-1 overflow-y-auto" style={{ background: theme.background }}>
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

          {/* 官方专辑详情页（getAlbum 桥） */}
          {view.kind === 'album' && (
            <SpotifyPcAlbum
              tone={tone}
              accent={accent}
              albumId={view.id}
              active={active}
              currentSong={currentSong}
              onPlaySongs={onPlaySongs}
              onOpenArtist={onOpenArtist}
              onSongMenu={onSongMenu}
            />
          )}

          {/* 已点赞的歌曲（官方紫渐变详情页） */}
          {view.kind === 'liked' && (
            <>
              <div className="flex items-end gap-6 px-8 pb-6 pt-16"
                style={{ background: 'linear-gradient(180deg, rgba(80,56,160,.9), rgba(18,18,18,.5) 95%)' }}>
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
                <div className="flex items-end gap-6 px-8 pb-6 pt-16"
                  style={{ background: 'linear-gradient(180deg, rgba(80,56,160,.85), rgba(18,18,18,.5) 95%)' }}>
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
            <SpotifyArtistInline artistId={view.id} active={active} onPlaySongs={onPlaySongs} theme={theme} accent={accent} onOpenAlbum={albumId => setView({ kind: 'album', id: albumId })} />
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
function SpotifyArtistInline({ artistId, active, onPlaySongs, theme, accent, onOpenAlbum }: {
  artistId: string
  active: boolean
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  theme: ReturnType<typeof spotifyPcTheme>
  accent: string
  onOpenAlbum: (albumId: string) => void
}) {
  const [data, setData] = useState<{
    name: string; avatarUrl: string; verified: boolean; followers: number
    topTracks: Array<{ id: string; name: string; artist: string; coverUrl: string; durationMs: number; playcount: number; albumName: string }>
    albums: Array<{ id: string; name: string; coverUrl: string; year?: string; tracks: number }>
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
      }
    }).filter((t: any) => t.id)
    topTracks.sort((a: any, b: any) => b.playcount - a.playcount)
    const albums = (au.discography?.albums?.items ?? []).map((item: any) => {
      const rel = item?.releases?.items?.[0]
      return { id: String(rel?.uri ?? '').replace('spotify:album:', ''), name: String(rel?.name ?? ''), coverUrl: rel?.coverArt?.sources?.[0]?.url ?? '', year: rel?.date?.year ? String(rel.date.year) : '', tracks: Number(rel?.tracks?.totalCount) || 0 }
    }).filter((a: any) => a.id)
    setData({
      name: String(profile.name ?? '艺人'),
      // 头像在 au.visuals.avatarImage（不在 profile.visuals）
      avatarUrl: String(au.visuals?.avatarImage?.sources?.[0]?.url ?? profile.visuals?.avatarImage?.sources?.[0]?.url ?? ''),
      verified: Boolean(profile.verified),
      followers: Number(au.stats?.followers ?? 0),
      topTracks, albums,
    })
  }, [artistId])

  useEffect(() => { if (active) void load() }, [active, load])

  // 关注态（官方艺人页「关注/正在关注」按钮）：进入页面查一次，点按真实写
  const [followed, setFollowed] = useState<boolean | null>(null)
  useEffect(() => {
    if (!active || !artistId) return
    void import('../../services/spotifyService').then(({ areSpotifyArtistsFollowed }) =>
      areSpotifyArtistsFollowed([artistId]).then(set_ => setFollowed(set_.has(artistId))),
    ).catch(() => setFollowed(null))
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
    id: 0, mid: t.id, name: t.name,
    artists: t.artist.split(' / ').map(n => ({ name: n })),
    album: { name: t.albumName, picUrl: t.coverUrl },
    duration: t.durationMs, platform: 'spotify',
  }))

  const fmtF = (n: number) => n >= 100000000 ? `${(n / 100000000).toFixed(1)}亿` : n >= 10000 ? `${Math.round(n / 10000)}万` : String(n)

  return (
    <div>
      <div className="relative flex items-end gap-6 px-8 pb-6 pt-20"
        style={{ background: 'linear-gradient(180deg, rgba(80,80,120,.8), rgba(18,18,18,.4) 90%), var(--bg)', ['--bg' as string]: theme.background }}>
        {data.avatarUrl
          ? <img src={data.avatarUrl} alt="" className="h-[180px] w-[180px] rounded-full object-cover shadow-2xl" />
          : <span className="flex h-[180px] w-[180px] items-center justify-center rounded-full shadow-2xl" style={{ background: theme.panel }} />}
        <div className="min-w-0 flex-1">
          {data.verified && <p className="mb-2 flex items-center gap-1 text-sm font-semibold" style={{ color: '#4cb3ff' }}>认证艺人</p>}
          <h1 className="text-[clamp(2rem,5vw,4.5rem)] font-black leading-tight" style={{ color: theme.text }}>{data.name}</h1>
          {data.followers > 0 && <p className="mt-3 text-sm" style={{ color: theme.text }}>{fmtF(data.followers)} 位粉丝</p>}
        </div>
        {/* 官方「关注/正在关注」按钮（真实写入 /me/following） */}
        <button type="button" onClick={toggleFollow}
          className="mb-2 shrink-0 rounded-full border px-6 py-2 text-sm font-bold transition hover:scale-105"
          style={{
            borderColor: followed ? 'rgba(255,255,255,.6)' : theme.text,
            color: theme.text,
            background: followed ? 'transparent' : 'transparent',
          }}>
          {followed ? '正在关注' : '关注'}
        </button>
      </div>
      {topSongs.length > 0 && (
        <div className="px-8 pb-8">
          <h2 className="mb-4 text-xl font-bold" style={{ color: theme.text }}>热门曲目</h2>
          <div className="rounded-xl p-2" style={{ background: theme.content }}>
                {data.topTracks.slice(0, 10).map((t, i) => (
              <div key={t.id}
                className="grid items-center gap-4 rounded px-3 py-2 text-sm hover:bg-white/5"
                style={{ gridTemplateColumns: '24px 40px minmax(0,3fr) minmax(0,2fr) 64px 64px', color: theme.text }}
                onDoubleClick={() => onPlaySongs(topSongs[i], topSongs, i)}
              >
                <span className="text-center" style={{ color: theme.secondary }}>{i + 1}</span>
                {t.coverUrl ? <img src={t.coverUrl} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded" style={{ background: theme.panel }} />}
                <span className="min-w-0">
                  <span className="block truncate font-medium">{t.name}</span>
                  <span className="block truncate text-xs" style={{ color: theme.secondary }}>{t.artist}</span>
                </span>
                <span className="truncate text-xs" style={{ color: theme.secondary }}>{t.albumName}</span>
                <span className="text-xs" style={{ color: theme.secondary }}>{fmtF(t.playcount)}</span>
                <span className="text-xs" style={{ color: theme.secondary }}>{fmtDuration(t.durationMs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {(data.albums ?? []).length > 0 && (
        <div className="px-8 pb-24">
          <h2 className="mb-4 text-xl font-bold" style={{ color: theme.text }}>专辑</h2>
          <div className="grid grid-cols-3 gap-5 lg:grid-cols-5 xl:grid-cols-6">
            {data.albums.map(a => (
              <button key={a.id} type="button" className="group rounded-lg p-3 text-left transition hover:bg-white/5"
                onClick={() => onOpenAlbum(a.id)}>
                {a.coverUrl && <img src={a.coverUrl} alt="" className="mb-3 aspect-square w-full rounded object-cover shadow-lg" />}
                <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                <span className="block text-xs" style={{ color: theme.secondary }}>{a.year}{a.tracks ? ` · ${a.tracks} 首` : ''}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
