// 传统模式独立歌手详情：不复用全局 ArtistDetailModal，数据走同一服务，渲染用传统设计语言。
import { memo, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Disc3, Music2, Play, Users } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getArtistAlbums, getArtistAllSongs, getArtistDetail, getArtistTopSongs, getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { platformLabel } from '../services/platforms'
import SongContextMenu from './SongContextMenu'
import type { PlaybackOrigin } from '../types/playbackNavigation'

const formatDuration = (milliseconds = 0) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const songKey = (song: Song) => `${song.platform}:${song.id || song.mid || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

type ArtistTab = 'hot' | 'all' | 'albums'

interface TraditionalArtistDetailProps {
  artistId: string
  platform: MusicPlatform
  accent: string
  isDark: boolean
  currentSong: Song | null
  onClose: () => void
  onSongSelect: (song: Song, songs: Song[], origin: PlaybackOrigin) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  userPlaylists?: any[]
}

function TraditionalArtistDetail({
  artistId, platform, accent, isDark, currentSong, onClose, onSongSelect,
  onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onViewComments, onCopyInfo, onOpenAlbum, userPlaylists = [],
}: TraditionalArtistDetailProps) {
  const [artist, setArtist] = useState<any>(null)
  const [hotSongs, setHotSongs] = useState<Song[]>([])
  const [allSongs, setAllSongs] = useState<Song[]>([])
  const [albums, setAlbums] = useState<any[]>([])
  const [tab, setTab] = useState<ArtistTab>('hot')
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const allPageRef = useRef(0)
  const muted = isDark ? 'text-white/50' : 'text-slate-500'


  useEffect(() => {
    if (!artistId) return
    let cancelled = false
    setLoading(true)
    setArtist(null)
    setHotSongs([])
    setAllSongs([])
    setAlbums([])
    setTab('hot')
    allPageRef.current = 0
    void Promise.allSettled([
      getArtistDetail(artistId, platform),
      getArtistTopSongs(artistId, platform),
      getArtistAlbums(artistId, platform, 100, 0),
    ]).then(([detailResult, hotResult, albumsResult]) => {
      if (cancelled) return
      if (detailResult.status === 'fulfilled') setArtist(detailResult.value)
      if (hotResult.status === 'fulfilled' && Array.isArray(hotResult.value)) setHotSongs(hotResult.value)
      if (albumsResult.status === 'fulfilled' && Array.isArray(albumsResult.value)) setAlbums(albumsResult.value)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [artistId, platform])

  // 全部歌曲分页加载
  useEffect(() => {
    if (!artistId || tab !== 'all') return
    let cancelled = false
    if (allPageRef.current === 0) setLoading(true)
    void getArtistAllSongs(artistId, platform, allPageRef.current, 40).then(result => {
      if (cancelled) return
      const next = result?.songs || []
      setAllSongs(prev => {
        const merged = new Map(prev.map(song => [songKey(song), song]))
        next.forEach(song => merged.set(songKey(song), song))
        return Array.from(merged.values())
      })
    }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [artistId, platform, tab])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const activeSongs = tab === 'hot' ? hotSongs : allSongs

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex h-16 shrink-0 items-center gap-3 border-b px-5 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
        <button type="button" onClick={onClose} className="rounded-full p-2 transition hover:bg-black/10" aria-label="返回"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0"><div className="text-sm font-medium">歌手详情</div><div className={`truncate text-xs ${muted}`}>{platformLabel(platform)}</div></div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10">
              {loading && tab !== 'all' ? <div className={`flex h-72 items-center justify-center text-sm ${muted}`}>正在加载歌手...</div> : (
                <>
                  <section className="flex flex-wrap items-center gap-6">
                    {artist?.picUrl ? <img src={getProxiedImageUrl(artist.picUrl)} alt="" className="h-32 w-32 rounded-full object-cover shadow-2xl" /> : <div className="flex h-32 w-32 items-center justify-center rounded-full" style={{ background: `${accent}22` }}><Music2 className="h-12 w-12" style={{ color: accent }} /></div>}
                    <div className="min-w-0 flex-1">
                      <div className={`mb-1 flex items-center gap-2 text-xs ${muted}`}><Music2 className="h-4 w-4" style={{ color: accent }} />歌手</div>
                      <h1 className="text-3xl font-semibold">{artist?.name || '歌手'}</h1>
                      <div className={`mt-2 flex flex-wrap items-center gap-3 text-xs ${muted}`}>
                        {artist?.fans ? <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" />{artist.fans > 10000 ? `${(artist.fans / 10000).toFixed(1)} 万` : artist.fans} 粉丝</span> : null}
                        {artist?.musicSize ? <span>{artist.musicSize} 首歌曲</span> : null}
                        {artist?.albumSize ? <span>{artist.albumSize} 张专辑</span> : null}
                      </div>
                      {artist?.briefDesc && <p className={`mt-3 line-clamp-2 max-w-2xl text-sm leading-6 ${muted}`}>{artist.briefDesc}</p>}
                      <button
                        type="button"
                        disabled={hotSongs.length === 0}
                        onClick={() => hotSongs[0] && onSongSelect(hotSongs[0], hotSongs, { mode: 'traditional', surface: 'traditional-artist', platform: artist?.platform || platform })}
                        className="mt-4 flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white disabled:opacity-45"
                        style={{ background: accent }}
                      >
                        <Play className="h-4 w-4 fill-current" />播放热门
                      </button>
                    </div>
                  </section>

                  <div className="mt-7 flex items-center gap-1 rounded-2xl border p-1" style={{ borderColor: isDark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.1)' }}>
                    {([['hot', '热门歌曲'], ['all', '全部歌曲'], ['albums', '专辑']] as Array<[ArtistTab, string]>).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => setTab(value)} className="flex-1 rounded-xl px-3 py-1.5 text-xs transition" style={tab === value ? { color: '#fff', background: accent } : undefined}>{label}</button>
                    ))}
                  </div>

                  {tab === 'albums' ? (
                    <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {albums.map((album, index) => (
                        <button key={`${album.id}:${index}`} type="button" onClick={() => album.id && onOpenAlbum?.(String(album.id), album.platform || platform)} className={`overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${isDark ? 'border-white/10 bg-white/[.04]' : 'border-slate-200 bg-white'}`}>
                          <img src={album.picUrl ? getProxiedImageUrl(album.picUrl) : ''} alt="" className="aspect-square w-full rounded-xl object-cover" />
                          <div className="mt-2 flex items-center gap-1.5 truncate text-sm"><Disc3 className="h-3.5 w-3.5 shrink-0 opacity-50" /><span className="truncate">{album.name}</span></div>
                          <div className={`text-xs ${muted}`}>{album.publishTime ? new Date(album.publishTime).getFullYear() : '专辑'}{album.size ? ` · ${album.size} 首` : ''}</div>
                        </button>
                      ))}
                      {albums.length === 0 && <div className={`col-span-full p-12 text-center text-sm ${muted}`}>暂无专辑</div>}
                    </div>
                  ) : (
                    <div className={`mt-6 overflow-hidden rounded-xl border ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                      <div className={`grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_56px_36px] items-center gap-3 border-b px-4 py-3 text-xs ${muted} ${isDark ? 'border-white/10 bg-white/[.035]' : 'border-slate-100 bg-slate-50'}`}>
                        <span>#</span><span>歌曲</span><span className="hidden sm:block">专辑</span><span><Play className="h-3 w-3" /></span><span />
                      </div>
                      {activeSongs.map((song, index) => {
                        const active = currentSong ? songKey(song) === songKey(currentSong) : false
                        return (
                          <div key={`${songKey(song)}:${index}`} className={`grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_56px_36px] items-center gap-3 px-4 py-2.5 transition ${active ? (isDark ? 'bg-white/10' : 'bg-pink-50') : isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}>
                            <button type="button" onClick={() => onSongSelect(song, activeSongs, { mode: 'traditional', surface: 'traditional-artist', platform: song.platform || platform })} className="flex h-7 w-7 items-center justify-center text-xs" style={{ color: active ? accent : undefined }}>{active ? <Play className="h-3.5 w-3.5 fill-current" /> : index + 1}</button>
                            <button type="button" onClick={() => onSongSelect(song, activeSongs, { mode: 'traditional', surface: 'traditional-artist', platform: song.platform || platform })} className="flex min-w-0 items-center gap-3 text-left">
                              <img src={coverOf(song)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" />
                              <span className="min-w-0"><span className={`block truncate text-sm ${active ? 'font-medium' : ''}`}>{song.name}</span><span className={`block truncate text-xs ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span></span>
                            </button>
                            <span className={`hidden truncate text-xs sm:block ${muted}`}>{song.album?.name || '未知专辑'}</span>
                            <span className={`text-xs tabular-nums ${muted}`}>{formatDuration(song.duration)}</span>
                            <button type="button" onClick={event => setMenu({ show: true, x: event.clientX, y: event.clientY, song })} aria-label="歌曲更多操作" className="rounded p-1 hover:bg-black/10"><span className="block h-1 w-1 rounded-full bg-current opacity-60" /><span className="mt-0.5 block h-1 w-1 rounded-full bg-current opacity-60" /><span className="mt-0.5 block h-1 w-1 rounded-full bg-current opacity-60" /></button>
                          </div>
                        )
                      })}
                      {activeSongs.length === 0 && !loading && <div className={`p-12 text-center text-sm ${muted}`}>暂无歌曲</div>}
                      {tab === 'all' && !loading && (
                        <div className="py-4 text-center">
                          <button type="button" onClick={() => { allPageRef.current += 40; void (async () => {
                            const result = await getArtistAllSongs(artistId, platform, allPageRef.current, 40).catch(() => ({ songs: [] as Song[], total: 0 }))
                            const next = result?.songs || []
                            setAllSongs(prev => {
                              const merged = new Map(prev.map(song => [songKey(song), song]))
                              next.forEach(song => merged.set(songKey(song), song))
                              return Array.from(merged.values())
                            })
                          })() }} className="rounded-full border px-5 py-2 text-xs transition hover:bg-white/10">加载更多</button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </main>
      <SongContextMenu show={menu.show} x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, activeSongs, { mode: 'traditional', surface: 'traditional-artist', platform: song.platform || platform })} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={onViewComments} onViewAlbum={song => song.album?.id && onOpenAlbum?.(String(song.album.id), song.platform || platform)} onViewArtist={() => undefined} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={menu.song?.platform || platform} playerTheme={isDark ? 'dark' : 'light'} />
    </div>
  )
}

export default memo(TraditionalArtistDetail)
