// 传统模式「Spotify 客户端」搜索页（官方搜索 1:1）：
// 顶部大搜索框 + 「全部 / 歌曲 / 歌单 / 专辑 / 艺人」结果页签。
// 数据源：官方 partner 桥 searchTracks / searchPlaylists / searchAlbums / searchArtists（全部真数据）。
// 歌单/专辑/艺人行点击 → 官方详情链（歌单进外壳详情、专辑进官方专辑页、艺人进官方艺人页）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Song } from '../../services/musicApi'
import { spotifyPcTheme } from './spotifyPcKit'

export interface SpotifyPcSearchProps {
  tone: 'dark' | 'light'
  accent: string
  initialKeyword: string
  active: boolean
  currentSong: Song | null
  onPlaySongs: (song: Song, songs: Song[], index: number) => void
  onOpenAlbum?: (albumId: string) => void
  onOpenArtist?: (artistId: string) => void
  /** 歌单点击（走外壳详情） */
  onOpenPlaylist?: (playlistId: string) => void
  /** 右键菜单（WaveForge 全局菜单，含官方项） */
  onSongMenu?: (event: { x: number; y: number; song: Song; songs?: Song[] }) => void
}

interface SearchResults {
  tracks: Array<{ id: string; name: string; artist: string; artistId?: string; albumName: string; albumId?: string; coverUrl: string; durationMs: number }>
  playlists: Array<{ id: string; name: string; owner: string; description: string; coverUrl: string }>
  albums: Array<{ id: string; name: string; artist: string; artistId?: string; year?: string; coverUrl: string }>
  artists: Array<{ id: string; name: string; coverUrl: string }>
}

type Tab = 'all' | 'tracks' | 'playlists' | 'albums' | 'artists'

async function runSearch(keyword: string): Promise<SearchResults> {
  const b = (window as any).electron?.spotifyPartner
  if (!b) return { tracks: [], playlists: [], albums: [], artists: [] }
  const out: SearchResults = { tracks: [], playlists: [], albums: [], artists: [] }
  // 官方分区搜索（四个 op 并行，全部真数据）
  const [tracksRes, playlistsRes, albumsRes, artistsRes] = await Promise.allSettled([
    b.request('query', { name: 'searchTracks', variables: { searchTerm: keyword, offset: 0, limit: 30 } }),
    b.request('query', { name: 'searchPlaylists', variables: { searchTerm: keyword, offset: 0, limit: 20 } }),
    b.request('query', { name: 'searchAlbums', variables: { searchTerm: keyword, offset: 0, limit: 20 } }),
    b.request('query', { name: 'searchArtists', variables: { searchTerm: keyword, offset: 0, limit: 20 } }),
  ])
  try {
    const res = tracksRes.status === 'fulfilled' ? tracksRes.value : null
    const rows = res?.data?.searchV2?.tracksV2?.items ?? []
    out.tracks = rows.map((row: any) => {
      const d = row?.item?.data ?? row?.data
      return {
        id: String(d?.uri ?? '').replace('spotify:track:', ''),
        name: String(d?.name ?? ''),
        artist: (d?.albumOfTrack?.artists?.items ?? d?.artists?.items ?? []).map((a: any) => a?.profile?.name ?? a?.name ?? '').filter(Boolean).join(' / '),
        artistId: (d?.albumOfTrack?.artists?.items ?? d?.artists?.items ?? [])[0]?.uri?.replace('spotify:artist:', ''),
        albumName: String(d?.albumOfTrack?.name ?? ''),
        albumId: String(d?.albumOfTrack?.uri ?? '').replace('spotify:album:', '') || undefined,
        coverUrl: d?.albumOfTrack?.coverArt?.sources?.[0]?.url ?? '',
        durationMs: Number(d?.duration?.totalMilliseconds) || 0,
      }
    }).filter((t: any) => t.id && t.name)
  } catch { /* 保持空 */ }
  try {
    const res = playlistsRes.status === 'fulfilled' ? playlistsRes.value : null
    const items = res?.data?.searchV2?.playlists?.items ?? []
    out.playlists = items.map((row: any) => {
      const d = row?.data
      return {
        id: String(d?.uri ?? '').replace('spotify:playlist:', ''),
        name: String(d?.name ?? ''),
        owner: String(d?.ownerV2?.data?.name ?? d?.ownerV2?.data?.username ?? ''),
        description: String(d?.description ?? ''),
        coverUrl: d?.coverArt?.sources?.[0]?.url ?? d?.images?.items?.[0]?.sources?.[0]?.url ?? '',
      }
    }).filter((p: any) => p.id && p.name)
  } catch { /* 保持空 */ }
  try {
    const res = albumsRes.status === 'fulfilled' ? albumsRes.value : null
    const items = res?.data?.searchV2?.albums?.items ?? []
    out.albums = items.map((row: any) => {
      const d = row?.data
      return {
        id: String(d?.uri ?? '').replace('spotify:album:', ''),
        name: String(d?.name ?? ''),
        artist: (d?.artists?.items ?? []).map((a: any) => a?.profile?.name ?? '').filter(Boolean).join(' / '),
        artistId: (d?.artists?.items ?? [])[0]?.uri?.replace('spotify:artist:', ''),
        year: d?.date?.year ? String(d.date.year) : undefined,
        coverUrl: d?.coverArt?.sources?.[0]?.url ?? '',
      }
    }).filter((a: any) => a.id && a.name)
  } catch { /* 保持空 */ }
  try {
    const res = artistsRes.status === 'fulfilled' ? artistsRes.value : null
    const items = res?.data?.searchV2?.artists?.items ?? []
    out.artists = items.map((row: any) => {
      const d = row?.data
      return {
        id: String(d?.uri ?? '').replace('spotify:artist:', ''),
        name: String(d?.profile?.name ?? d?.name ?? ''),
        coverUrl: d?.visuals?.avatarImage?.sources?.[0]?.url ?? d?.visuals?.sources?.[0]?.url ?? '',
      }
    }).filter((a: any) => a.id && a.name)
  } catch { /* 保持空 */ }
  return out
}

export default function SpotifyPcSearch({ tone, accent, initialKeyword, active, currentSong, onPlaySongs, onOpenAlbum, onOpenArtist, onOpenPlaylist, onSongMenu }: SpotifyPcSearchProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [keyword, setKeyword] = useState(initialKeyword)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTab] = useState<Tab>('all')

  const search = useCallback(async (kw: string) => {
    if (!kw.trim()) { setResults(null); return }
    setLoading(true)
    setResults(await runSearch(kw.trim()))
    setLoading(false)
  }, [])

  useEffect(() => {
    if (active && initialKeyword) void search(initialKeyword)
  }, [active, initialKeyword, search])

  const fmtDuration = (ms?: number) => {
    if (!ms || ms <= 0) return '-:--'
    const total = Math.round(ms / 1000)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'all', label: '全部' },
    { key: 'tracks', label: '歌曲' },
    { key: 'playlists', label: '歌单' },
    { key: 'albums', label: '专辑' },
    { key: 'artists', label: '艺人' },
  ]

  return (
    <div className="flex h-full" style={{ background: theme.background }} data-active={active}>
      {/* 左栏（与 SpotifyPcShell 同宽同风格，官方搜索页自带左栏） */}
      <aside className="flex min-h-0 flex-col overflow-hidden border-r" style={{ width: 300, background: theme.content, borderColor: theme.divider }}>
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-lg font-bold" style={{ color: theme.text }}>音乐库</h2>
        </div>
        <div className="px-4 pb-2">
          <div className="flex gap-2">
            <button type="button" className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: theme.panel, color: theme.secondary }}>歌单</button>
            <button type="button" className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: theme.panel, color: theme.secondary }}>艺人</button>
          </div>
        </div>
      </aside>
      {/* 右侧搜索主区 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 大搜索框 */}
      <div className="px-8 pb-6 pt-10">
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void search(keyword) }}
          placeholder="想播放什么？"
          className="w-full max-w-xl rounded-full px-6 py-4 text-lg font-semibold outline-none"
          style={{ background: theme.panel, color: theme.text, border: `1px solid ${theme.divider}` }}
        />
      </div>

      {/* 页签 */}
      {results && (
        <div className="flex items-center gap-3 px-8 pb-4">
          {tabs.map(t => (
            <button key={t.key} type="button" onClick={() => setTab(t.key)}
              className="rounded-full px-4 py-1.5 text-sm font-semibold transition"
              style={{ background: tab === t.key ? theme.accent : theme.panel, color: tab === t.key ? '#000' : theme.text }}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      {/* 结果 */}
      {loading && <p className="px-8 py-10 text-center text-sm" style={{ color: theme.secondary }}>搜索中…</p>}
      {results && !loading && (
        <div className="px-8 pb-24">
          {/* 歌曲行 */}
          {(tab === 'all' || tab === 'tracks') && results.tracks.length > 0 && (
            <>
              {tab === 'tracks' && <h2 className="mb-4 text-xl font-bold" style={{ color: theme.text }}>歌曲</h2>}
              <div className="rounded-xl p-2" style={{ background: theme.content }}>
                {(tab === 'all' ? results.tracks.slice(0, 8) : results.tracks).map((t, i) => {
                  const song: Song = {
                    id: Number(parseInt(t.id.slice(0, 12), 36)) || 0,
                    mid: t.id,
                    name: t.name,
                    artists: t.artist.split(' / ').map(n => ({ name: n })),
                    album: { name: t.albumName, picUrl: t.coverUrl },
                    duration: t.durationMs,
                    platform: 'spotify',
                  }
                  const allSongs: Song[] = results.tracks.map(x => ({
                    id: Number(parseInt(x.id.slice(0, 12), 36)) || 0, mid: x.id, name: x.name,
                    artists: x.artist.split(' / ').map(n => ({ name: n })),
                    album: { name: x.albumName, picUrl: x.coverUrl }, duration: x.durationMs, platform: 'spotify',
                  }))
                  const isCurrent = currentSong?.mid === t.id
                  return (
                    <div key={t.id + i}
                      className="grid items-center gap-4 rounded px-3 py-2 text-sm hover:bg-white/5"
                      style={{ gridTemplateColumns: '24px 40px minmax(0,3fr) minmax(0,2fr) 64px', color: isCurrent ? accent : theme.text }}
                      onDoubleClick={() => onPlaySongs(song, allSongs, i)}
                      onContextMenu={e => { e.preventDefault(); onSongMenu?.({ x: e.clientX, y: e.clientY, song, songs: allSongs }) }}
                    >
                      <span className="text-center" style={{ color: theme.secondary }}>{i + 1}</span>
                      {t.coverUrl ? <img src={t.coverUrl} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded" style={{ background: theme.panel }} />}
                      <span className="min-w-0">
                        <span className="block truncate font-medium" style={{ color: isCurrent ? accent : theme.text }}>{t.name}</span>
                        <span className="block truncate text-xs" style={{ color: theme.secondary }}>{t.artist}</span>
                      </span>
                      <span className="truncate text-xs" style={{ color: theme.secondary }}>{t.albumName}</span>
                      <span className="text-xs" style={{ color: theme.secondary }}>{fmtDuration(t.durationMs)}</span>
                    </div>
                  )
                })}
              </div>
            </>
          )}
          {/* 歌单网格 */}
          {(tab === 'all' || tab === 'playlists') && results.playlists.length > 0 && (
            <>
              {tab === 'playlists' && <h2 className="mb-4 mt-6 text-xl font-bold" style={{ color: theme.text }}>歌单</h2>}
              <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {(tab === 'all' ? results.playlists.slice(0, 5) : results.playlists).map(p => (
                  <button key={p.id} type="button" onClick={() => onOpenPlaylist?.(p.id)} className="group rounded-lg p-3 text-left transition hover:bg-white/5">
                    <span className="mb-3 block aspect-square w-full overflow-hidden rounded-md shadow-lg" style={{ background: theme.panel }}>
                      {p.coverUrl ? <img src={p.coverUrl} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" /> : <span className="block h-full w-full" style={{ background: theme.panel }} />}
                    </span>
                    <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{p.name}</span>
                    <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>歌单 · {p.owner || p.description}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 专辑网格 */}
          {(tab === 'all' || tab === 'albums') && results.albums.length > 0 && (
            <>
              {tab === 'albums' && <h2 className="mb-4 mt-6 text-xl font-bold" style={{ color: theme.text }}>专辑</h2>}
              <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {(tab === 'all' ? results.albums.slice(0, 5) : results.albums).map(a => (
                  <button key={a.id} type="button" onClick={() => onOpenAlbum?.(a.id)} className="group rounded-lg p-3 text-left transition hover:bg-white/5">
                    <span className="mb-3 block aspect-square w-full overflow-hidden rounded-md shadow-lg" style={{ background: theme.panel }}>
                      {a.coverUrl ? <img src={a.coverUrl} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" /> : <span className="block h-full w-full" style={{ background: theme.panel }} />}
                    </span>
                    <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                    <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>{a.year ? `${a.year} · ` : ''}{a.artist}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {/* 艺人圆形网格 */}
          {(tab === 'all' || tab === 'artists') && results.artists.length > 0 && (
            <>
              {tab === 'artists' && <h2 className="mb-4 mt-6 text-xl font-bold" style={{ color: theme.text }}>艺人</h2>}
              <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {(tab === 'all' ? results.artists.slice(0, 5) : results.artists).map(a => (
                  <button key={a.id} type="button" onClick={() => onOpenArtist?.(a.id)} className="group rounded-lg p-3 text-center transition hover:bg-white/5">
                    <span className="mx-auto mb-3 block aspect-square w-full max-w-[160px] overflow-hidden rounded-full shadow-lg" style={{ background: theme.panel }}>
                      {a.coverUrl ? <img src={a.coverUrl} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" /> : <span className="block h-full w-full" style={{ background: theme.panel }} />}
                    </span>
                    <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                    <span className="mt-1 block text-xs" style={{ color: theme.secondary }}>艺人</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {results.tracks.length === 0 && results.playlists.length === 0 && results.albums.length === 0 && results.artists.length === 0 && (
            <p className="py-10 text-center text-sm" style={{ color: theme.secondary }}>没有找到与「{keyword}」相关的内容</p>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
