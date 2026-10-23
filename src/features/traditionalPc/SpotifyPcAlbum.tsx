// 传统模式 Spotify：官方专辑详情页（官方渐变头 + 心形收藏 + 曲目表）。
// 数据源：partner 桥 getAlbum（tracksV2/coverArt/saved/label）。
// 心形收藏走 changeMutation addToLibrary/removeFromLibrary（与歌单收藏同链）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Music2, Play, Shuffle, Heart } from 'lucide-react'
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
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  /** 艺人名点击 */
  onOpenArtist: (artistId: string) => void
  /** 右键菜单 */
  onSongMenu?: (event: { x: number; y: number; song: Song; songs?: Song[] }) => void
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

export default function SpotifyPcAlbum({ tone, accent, albumId, active, currentSong, onPlaySongs, onOpenArtist, onSongMenu }: SpotifyPcAlbumProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [album, setAlbum] = useState<PartnerAlbumFull | null>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchPartnerAlbumFull(albumId).catch(() => null)
      setAlbum(data)
      setSaved(Boolean(data?.saved))
    } finally {
      setLoading(false)
    }
  }, [albumId])

  useEffect(() => { if (active) void load() }, [active, load])

  const songs = useMemo(() => (album?.rows ?? []).map(r => trackToSong(r.track)), [album])

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

  if (loading && !album) return <p className="px-8 py-16 text-center text-sm" style={{ color: theme.secondary }}>加载中…</p>
  if (!album) return <p className="px-8 py-16 text-center text-sm" style={{ color: theme.secondary }}>专辑加载失败</p>

  return (
    <div className="pb-24" data-active={active}>
      {/* 官方渐变头 */}
      <div className="flex items-end gap-6 px-8 pb-6 pt-16"
        style={{ background: `linear-gradient(180deg, ${album.coverUrl ? `${accent}44` : 'rgba(80,56,160,.85)'}, rgba(18,18,18,.5) 95%), ${theme.background}` }}>
        {album.coverUrl
          ? <img src={album.coverUrl} alt="" className="h-[192px] w-[192px] rounded object-cover shadow-2xl" />
          : <span className="flex h-[192px] w-[192px] items-center justify-center rounded shadow-2xl" style={{ background: theme.panel }}>
              <Music2 className="h-16 w-16" style={{ color: theme.secondary }} />
            </span>}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold" style={{ color: theme.text }}>专辑</p>
          <h1 className="mt-2 mb-3 text-[clamp(2rem,5vw,4rem)] font-black leading-tight" style={{ color: theme.text }}>{album.name}</h1>
          <p className="flex flex-wrap items-center gap-1 text-sm" style={{ color: theme.text }}>
            {album.artists.map((a, i) => (
              <span key={a.id}>
                {i > 0 && <span style={{ color: theme.secondary }}>, </span>}
                <span className="cursor-pointer font-semibold hover:underline" onClick={() => onOpenArtist(a.id)}>{a.name}</span>
              </span>
            ))}
            <span style={{ color: theme.secondary }}>
              {album.year ? ` · ${album.year}` : ''}{album.trackCount ? ` · ${album.trackCount} 首歌曲` : ''}{album.durationMs > 0 ? `，${fmtTotal(album.durationMs)}` : ''}
            </span>
          </p>
          {album.label && <p className="mt-1 text-xs" style={{ color: theme.secondary }}>{album.label}</p>}
        </div>
      </div>

      {/* 操作行：播放 / 随机 / 心形收藏 */}
      <div className="flex items-center gap-6 px-8 py-6">
        {songs.length > 0 && (
          <button type="button" onClick={() => onPlaySongs(songs[0], songs, 0)}
            className="flex h-14 w-14 items-center justify-center rounded-full transition hover:scale-105"
            style={{ background: theme.accent, boxShadow: '0 8px 24px rgba(30,215,96,.4)' }} aria-label="播放">
            <Play className="h-6 w-6" fill="#000" color="#000" />
          </button>
        )}
        <Shuffle className="h-7 w-7" style={{ color: theme.secondary }} />
        <button type="button" onClick={toggleSaved} aria-label={saved ? '从音乐库移除' : '添加到音乐库'}
          className="rounded-full p-1 transition hover:scale-110" style={{ color: saved ? theme.accent : theme.secondary }}>
          <Heart className="h-8 w-8" fill={saved ? 'currentColor' : 'none'} />
        </button>
      </div>

      {/* 曲目表（官方列：# / 标题 / 播放次数 / 时长） */}
      <div className="px-8">
        <div className="grid items-center gap-4 border-b px-4 pb-2 text-xs" style={{ gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,2fr) 48px', borderColor: theme.divider, color: theme.secondary }}>
          <span className="text-center">#</span><span />
          <span>标题</span><span>播放次数</span>
          <span className="justify-self-end pr-2"><Clock className="h-4 w-4" /></span>
        </div>
        {album.rows.map((row, i) => {
          const isCurrent = currentSong?.mid === row.track.id
          return (
            <div key={row.uid ?? row.track.id + i}
              className="group grid items-center gap-4 rounded px-4 py-2 text-sm hover:bg-white/10"
              style={{
                gridTemplateColumns: '32px 40px minmax(0,3fr) minmax(0,2fr) 48px',
                color: isCurrent ? theme.accent : theme.text,
                background: isCurrent ? theme.panel : undefined,
              }}
              onDoubleClick={() => onPlaySongs(songs[i], songs, i)}
              onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song: songs[i], songs }) }}
            >
              <span className="group-hover:hidden text-center" style={{ color: theme.secondary }}>{row.trackNumber ?? i + 1}</span>
              <span className="hidden group-hover:justify-center text-white"><Play className="h-4 w-4" fill="currentColor" /></span>
              <span className="min-w-0">
                <span className="block truncate font-medium" style={{ color: isCurrent ? theme.accent : theme.text }}>{row.track.name}</span>
                <span className="block truncate text-xs hover:underline" style={{ color: theme.secondary }}>{row.track.artists.map(a => a.name).join(' / ')}</span>
              </span>
              <span className="truncate text-xs" style={{ color: theme.secondary }}>{row.playcount ? row.playcount.toLocaleString() : ''}</span>
              <span className="justify-self-end text-xs" style={{ color: theme.secondary }}>{fmtDuration(row.track.duration_ms)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
