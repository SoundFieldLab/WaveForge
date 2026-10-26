// 传统模式 Spotify：官方专辑详情页 1:1（对齐官方桌面客户端）：
//   头部：封面 + 「单曲/专辑/EP」类型标签 + 大标题 + 圆头像 owner 行（艺人 · 年份 · N 首歌曲 · 时长）
//   操作行：播放/暂停圆钮 + 曲目预览缩略图 + 随机 + ⊕ 收藏 + … 菜单 | 右侧「列表」密度切换
//   曲目表：# / 标题（播放中绿色 + 均衡器动画） / 播放量 / 行内 ⊕ 收藏 / 时长 / … 右键菜单
//   尾部：精确发行日 + ©/℗ 版权行；「更多来自 X 的内容」横排 + 查看唱片目录
// 数据源：partner 桥 getAlbum（type/copyright/date/moreAlbumsByArtist/单曲 saved/playcount）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ListPlus, Music2, Pause, Play, PlusCircle, Shuffle, Clock, MoreHorizontal, X, Ban, Share, Radio as RadioIcon } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { spotifyPcTheme } from './spotifyPcKit'
import { fetchPartnerAlbumFull, type PartnerAlbumFull } from '../../services/spotifyPartnerData'
import type { SpotifyTrack } from '../../services/spotifyService'

export interface SpotifyPcAlbumProps {
  tone: 'dark' | 'light'
  accent: string
  albumId: string
  active: boolean
  currentSong: Song | null
  isPlaying: boolean
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  onPlayPause: () => void
  /** 加入播放队列（…菜单） */
  onPlayNext?: (song: Song) => void
  /** 艺人名点击 */
  onOpenArtist: (artistId: string) => void
  /** 专辑卡片点击（更多来自 X 的内容横排） */
  onOpenAlbum: (albumId: string) => void
  /** 右键菜单 */
  onSongMenu?: (event: { x: number; y: number; song: Song; songs?: Song[] }) => void
}

const fmtDuration = (ms?: number) => {
  if (!ms || ms <= 0) return '-:--'
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
/** 官方时长格式：2 分钟 4 秒 / 1 小时 3 分钟 */
const fmtTotalVerbose = (ms: number) => {
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h} 小时 ${m} 分钟`
  if (m > 0) return s > 0 ? `${m} 分钟 ${s} 秒` : `${m} 分钟`
  return `${s} 秒`
}
const fmtPreciseDate = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}
const albumTypeLabel = (t?: string) => (t === 'SINGLE' ? '单曲' : t === 'EP' ? 'EP' : '专辑')

function trackToSong(t: SpotifyTrack): Song {
  return {
    id: Number(parseInt(t.id.slice(0, 12), 36)) || 0,
    mid: t.id,
    name: t.name,
    artists: t.artists.map(a => ({ name: a.name })),
    album: { name: t.album?.name ?? '', picUrl: t.album?.images?.[0]?.url ?? '' },
    duration: t.duration_ms ?? 0,
    platform: 'spotify',
  }
}

/** 官方播放中均衡器（3 根绿条跳动） */
function Equalizer() {
  return (
    <span className="wf-eq flex h-3.5 items-end justify-center gap-0.5">
      <span /><span /><span />
    </span>
  )
}

export default function SpotifyPcAlbum({ tone, accent, albumId, active, currentSong, isPlaying, onPlaySongs, onPlayPause, onPlayNext, onOpenArtist, onOpenAlbum, onSongMenu }: SpotifyPcAlbumProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [album, setAlbum] = useState<PartnerAlbumFull | null>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)
  const [savedTrackIds, setSavedTrackIds] = useState<Set<string>>(new Set())
  const [compact, setCompact] = useState(false)
  const [moreMenuOpen, setMoreMenuOpen] = useState(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!moreMenuOpen) return
    const onDown = (e: MouseEvent) => { if (!moreMenuRef.current?.contains(e.target as Node)) setMoreMenuOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [moreMenuOpen])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchPartnerAlbumFull(albumId).catch(() => null)
      setAlbum(data)
      setSaved(Boolean(data?.saved))
      setSavedTrackIds(new Set((data?.rows ?? []).filter(r => r.saved).map(r => String(r.track.id))))
    } finally {
      setLoading(false)
    }
  }, [albumId])

  useEffect(() => { if (active) void load() }, [active, load])

  const songs = useMemo(() => (album?.rows ?? []).map(r => trackToSong(r.track)), [album])
  const isCurrentAlbum = Boolean(currentSong && songs.some(s => s.mid === currentSong.mid))

  const toggleSaved = () => {
    if (!albumId) return
    const next = !saved
    setSaved(next) // 乐观更新
    void (async () => {
      const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok: boolean }> } } }).electron?.spotifyPartner
      if (!bridge) return
      const res = await bridge.request('library', { uri: `spotify:album:${albumId}`, saved: next }).catch(() => null)
      if (!res?.ok) {
        setSaved(!next)
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: next ? '收藏专辑失败' : '取消收藏失败', type: 'error' } }))
      } else {
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: next ? '已添加到你的音乐库' : '已从音乐库移除', type: 'success' } }))
      }
    })()
  }

  // 行内单曲收藏（官方 ⊕/✓）
  const toggleTrackSaved = (trackId: string) => {
    const next = !savedTrackIds.has(trackId)
    setSavedTrackIds(prev => { const s = new Set(prev); if (next) s.add(trackId); else s.delete(trackId); return s })
    const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok?: boolean }> } } }).electron?.spotifyPartner
    void bridge?.request('library', { uri: `spotify:track:${trackId}`, saved: next }).then((res: { ok?: boolean } | null | undefined) => {
      if (!res?.ok) setSavedTrackIds(prev => { const s = new Set(prev); if (next) s.delete(trackId); else s.add(trackId); return s })
    }).catch(() => undefined)
  }

  if (loading && !album) return <p className="px-8 py-16 text-center text-sm" style={{ color: theme.secondary }}>加载中…</p>
  if (!album) return <p className="px-8 py-16 text-center text-sm" style={{ color: theme.secondary }}>专辑加载失败</p>

  const firstArtist = album.artists[0]
  const playingHere = isCurrentAlbum && isPlaying
  const gridCols = compact
    ? '24px minmax(0,3fr) 130px 96px 40px'
    : '24px 40px minmax(0,3fr) 130px 40px 48px 40px'

  return (
    <div className="pb-24" data-active={active}>
      {/* 官方头部：封面 + 类型标签 + 大标题 + 圆头像 owner 行 */}
      <div className="flex items-end gap-6 px-8 pb-6 pt-16"
        style={{ background: `linear-gradient(180deg, ${album.coverUrl ? `${accent}44` : 'rgba(80,56,160,.85)'}, rgba(18,18,18,.5) 95%), ${theme.background}` }}>
        {album.coverUrl
          ? <img src={album.coverUrl} alt="" className="h-[192px] w-[192px] rounded object-cover shadow-2xl" />
          : <span className="flex h-[192px] w-[192px] items-center justify-center rounded shadow-2xl" style={{ background: theme.panel }}>
              <Music2 className="h-16 w-16" style={{ color: theme.secondary }} />
            </span>}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold" style={{ color: theme.text }}>{albumTypeLabel(album.albumType)}</p>
          <h1 className="mt-2 mb-3 text-[clamp(2rem,5vw,4rem)] font-black leading-tight" style={{ color: theme.text }}>{album.name}</h1>
          <p className="flex flex-wrap items-center gap-1.5 text-sm" style={{ color: theme.text }}>
            {firstArtist && (
              <span className="flex items-center gap-1.5">
                {firstArtist.avatarUrl
                  ? <img src={firstArtist.avatarUrl} alt="" className="h-6 w-6 rounded-full object-cover" />
                  : <span className="h-6 w-6 rounded-full" style={{ background: theme.panel }} />}
                <span className="cursor-pointer font-semibold hover:underline" onClick={() => onOpenArtist(firstArtist.id)}>{firstArtist.name}</span>
              </span>
            )}
            {album.artists.slice(1).map(a => (
              <span key={a.id}>
                <span style={{ color: theme.secondary }}>, </span>
                <span className="cursor-pointer font-semibold hover:underline" onClick={() => onOpenArtist(a.id)}>{a.name}</span>
              </span>
            ))}
            <span style={{ color: theme.secondary }}>
              {album.year ? ` · ${album.year}` : ''}{album.trackCount ? ` · ${album.trackCount} 首歌曲` : ''}{album.durationMs > 0 ? `，${fmtTotalVerbose(album.durationMs)}` : ''}
            </span>
          </p>
        </div>
      </div>

      {/* 操作行：播放/暂停圆钮 + 预览缩略图 + 随机 + ⊕ 收藏 + … 菜单 | 右侧「列表」密度切换 */}
      <div className="flex items-center gap-5 px-8 py-6">
        {songs.length > 0 && (
          <button type="button" onClick={() => { if (isCurrentAlbum) onPlayPause(); else onPlaySongs(songs[0], songs, 0) }}
            className="flex h-14 w-14 items-center justify-center rounded-full transition hover:scale-105"
            style={{ background: theme.accent, boxShadow: '0 8px 24px rgba(30,215,96,.4)' }} aria-label={playingHere ? '暂停' : '播放'}>
            {playingHere ? <Pause className="h-6 w-6" fill="#000" color="#000" /> : <Play className="ml-0.5 h-6 w-6" fill="#000" color="#000" />}
          </button>
        )}
        {songs[0] && album.coverUrl && (
          <button type="button" onClick={() => onPlaySongs(songs[0], songs, 0)} title="滚动浏览此专辑的曲目预览"
            className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg border-2 transition hover:scale-105"
            style={{ borderColor: 'rgba(255,255,255,.6)' }} aria-label="滚动浏览此专辑的曲目预览">
            <img src={album.coverUrl} alt="" className="h-full w-full object-cover" />
          </button>
        )}
        <button type="button" onClick={() => {
          const shuffled = [...songs]
          for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]] }
          onPlaySongs(shuffled[0], shuffled, 0)
        }} className="rounded p-1 transition hover:scale-105" style={{ color: theme.secondary }} aria-label="随机播放">
          <Shuffle className="h-7 w-7" />
        </button>
        <button type="button" onClick={toggleSaved} aria-label={saved ? '从音乐库移除' : '添加到音乐库'}
          className="rounded-full p-1 transition hover:scale-110" style={{ color: saved ? theme.accent : theme.secondary }}>
          {saved ? <Check className="h-8 w-8" style={{ color: theme.accent }} /> : <PlusCircle className="h-8 w-8" strokeWidth={1.5} />}
        </button>
        <div className="relative" ref={moreMenuRef}>
          <button type="button" onClick={() => setMoreMenuOpen(v => !v)}
            className="rounded-full border border-transparent p-2 transition hover:border-white/30" style={{ color: theme.secondary }} aria-label="更多专辑选项">
            <MoreHorizontal className="h-5 w-5" />
          </button>
          {moreMenuOpen && (
            <div className="absolute left-0 top-10 z-40 w-56 overflow-hidden rounded-md py-1 shadow-2xl" style={{ background: '#282828' }} role="menu">
              {([
                { key: 'queue', label: '添加到播放队列', icon: ListPlus, action: () => { for (const s of songs) onPlayNext?.(s); setMoreMenuOpen(false) } },
                { key: 'save', label: saved ? '从音乐库移除' : '添加到音乐库', icon: saved ? X : PlusCircle, action: () => { toggleSaved(); setMoreMenuOpen(false) } },
                { key: 'share', label: '分享', icon: Share, action: () => {
                  // 官方分享链接格式：open.spotify.com/album/<id>?si=<16 位十六进制>
                  const si = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
                  void navigator.clipboard?.writeText(`https://open.spotify.com/album/${albumId}?si=${si}`).then(() =>
                    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已复制专辑链接', type: 'success' } })),
                  ).catch(() => undefined)
                  setMoreMenuOpen(false)
                } },
                { key: 'radio', label: '转至专辑电台', icon: RadioIcon, action: () => {
                  if (!songs[0]) return
                  const bridge = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<{ ok?: boolean; data?: { uri?: string } | null }> } } }).electron?.spotifyPartner
                  void bridge?.request('radio', { id: String(songs[0].mid ?? '') }).then(res => {
                    const uri = res?.data?.uri
                    if (res?.ok && uri) window.dispatchEvent(new CustomEvent('waveforge:open-playlist', { detail: { platform: 'spotify', playlistId: String(uri).replace('spotify:playlist:', '') } }))
                  }).catch(() => undefined)
                  setMoreMenuOpen(false)
                } },
                { key: 'ban', label: '不要播放此艺人的歌曲', icon: Ban, action: () => {
                  let banned: string[] = []
                  try { banned = JSON.parse(localStorage.getItem('waveforge:spotify-banned-artists') || '[]') } catch { banned = [] }
                  if (firstArtist && !banned.includes(firstArtist.name)) banned.push(firstArtist.name)
                  localStorage.setItem('waveforge:spotify-banned-artists', JSON.stringify(banned))
                  window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '将不再播放此艺人的歌曲', type: 'success' } }))
                  setMoreMenuOpen(false)
                } },
              ] as Array<{ key: string; label: string; icon: typeof X; action: () => void }>).map(item => (
                <button key={item.key} type="button" role="menuitem" onClick={item.action}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition hover:bg-white/10" style={{ color: '#fff' }}>
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setCompact(v => !v)}
          className="ml-auto flex items-center gap-1.5 text-xs font-bold transition hover:opacity-80" style={{ color: theme.secondary }} aria-label="切换列表密度">
          列表 <ListPlus className="h-4 w-4" />
        </button>
      </div>

      {/* 曲目表（官方列：# / 标题 / 播放量 / ⊕ / 时长 / …） */}
      <div className="px-8">
        <div className="grid items-center gap-4 border-b px-4 pb-2 text-xs" style={{ gridTemplateColumns: gridCols, borderColor: theme.divider, color: theme.secondary }}>
          <span className="text-center">#</span>
          {!compact && <span />}
          <span>标题</span>
          <span className="text-right">播放量</span>
          {!compact && <span />}
          <span className="justify-self-end pr-1"><Clock className="h-4 w-4" /></span>
          {!compact && <span />}
        </div>
        {album.rows.map((row, i) => {
          const isCurrent = currentSong?.mid === row.track.id
          return (
            <div key={row.uid ?? row.track.id + i}
              className="group grid items-center gap-4 rounded px-4 py-2 text-sm hover:bg-white/10"
              style={{
                gridTemplateColumns: gridCols,
                color: isCurrent ? theme.accent : theme.text,
                background: isCurrent ? theme.panel : undefined,
              }}
              onDoubleClick={() => onPlaySongs(songs[i], songs, i)}
              onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song: songs[i], songs }) }}
            >
              <span className="text-center" style={{ color: theme.secondary }}>
                {isCurrent ? <Equalizer /> : <span className="group-hover:hidden">{row.trackNumber ?? i + 1}</span>}
                <span className={`hidden group-hover:justify-center text-white ${isCurrent ? '' : 'group-hover:block'}`}><Play className="h-4 w-4" fill="currentColor" /></span>
              </span>
              {!compact && (row.track.album?.images?.[0]?.url || album.coverUrl
                ? <img src={row.track.album?.images?.[0]?.url || album.coverUrl} alt="" className="h-10 w-10 rounded object-cover" />
                : <span className="h-10 w-10 rounded" style={{ background: theme.panel }} />)}
              <span className="min-w-0">
                <span className={`block truncate font-medium ${isCurrent ? '' : ''}`} style={{ color: isCurrent ? theme.accent : theme.text }}>{row.track.name}</span>
                <span className="flex items-center gap-1.5 text-xs" style={{ color: theme.secondary }}>
                  {row.explicit && <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold" style={{ background: theme.panel, color: theme.secondary }}>E</span>}
                  {album.artists.length === 1
                    ? <span className="cursor-pointer truncate hover:underline" onClick={() => onOpenArtist(album.artists[0].id)}>{album.artists[0].name}</span>
                    : <span className="truncate">{row.track.artists.map(a => a.name).join(' / ')}</span>}
                </span>
              </span>
              <span className="truncate text-right text-xs" style={{ color: theme.secondary }}>{row.playcount ? row.playcount.toLocaleString('en-US') : ''}</span>
              {!compact && (
                <button type="button" aria-label={savedTrackIds.has(row.track.id) ? '从已点赞的歌曲中移除' : '添加至“已点赞的歌曲”'}
                  onClick={e => { e.stopPropagation(); toggleTrackSaved(row.track.id) }}
                  className="justify-self-center rounded-full p-1 transition hover:scale-110">
                  {savedTrackIds.has(row.track.id)
                    ? <Check className="h-4 w-4" style={{ color: theme.accent }} />
                    : <PlusCircle className="h-4 w-4 opacity-0 transition group-hover:opacity-100" style={{ color: theme.secondary }} />}
                </button>
              )}
              <span className="justify-self-end text-xs" style={{ color: theme.secondary }}>{fmtDuration(row.track.duration_ms)}</span>
              {!compact && (
                <button type="button" aria-label={`更多有关“${firstArtist?.name ?? ''}”的“${row.track.name}”的选项`}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); onSongMenu?.({ x: e.clientX, y: e.clientY, song: songs[i], songs }) }}
                  className="justify-self-end rounded-full p-1 opacity-0 transition group-hover:opacity-100" style={{ color: theme.secondary }}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* 官方尾部：精确发行日 + ©/℗ 版权行 */}
      {(album.preciseDate || album.copyrightItems.length > 0) && (
        <div className="mt-6 space-y-1 px-12 text-xs" style={{ color: theme.secondary }}>
          {album.preciseDate && <p>{fmtPreciseDate(album.preciseDate)}</p>}
          {album.copyrightItems.map((c, i) => (
            <p key={i}>{c.type === 'C' ? '©' : c.type === 'P' ? '℗' : '·'} {c.text}</p>
          ))}
        </div>
      )}

      {/* 官方「更多来自 X 的内容」横排 + 查看唱片目录 */}
      {(album.moreAlbums ?? []).length > 0 && firstArtist && (
        <div className="mt-10 px-8">
          <div className="mb-4 flex items-end justify-between">
            <h2 className="text-2xl font-bold" style={{ color: theme.text }}>更多来自 {firstArtist.name} 的内容</h2>
            <button type="button" onClick={() => onOpenArtist(firstArtist.id)}
              className="flex items-center text-xs font-bold transition hover:opacity-80" style={{ color: theme.secondary }}>
              查看唱片目录
            </button>
          </div>
          <div className="drag-scroll-x flex gap-4 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
            {album.moreAlbums.map(a => (
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
                <span className="block text-xs" style={{ color: theme.secondary }}>{a.year || '最新发布'} · {a.type}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
