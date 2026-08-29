// 传统模式独立专辑详情：不复用全局 AlbumDetailModal，数据走同一服务，渲染用传统设计语言。
import { memo, useEffect, useState } from 'react'
import { ArrowLeft, Clock3, Disc3, Play } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getAlbumDetail, getAlbumSongs, getProxiedImageUrl } from '../services/musicApi'
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

interface TraditionalAlbumDetailProps {
  albumId: string | null
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
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  userPlaylists?: any[]
}

function TraditionalAlbumDetail({
  albumId, platform, accent, isDark, currentSong, onClose, onSongSelect,
  onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onViewComments, onCopyInfo, onOpenArtist, userPlaylists = [],
}: TraditionalAlbumDetailProps) {
  const [album, setAlbum] = useState<any>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [menu, setMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const muted = isDark ? 'text-white/50' : 'text-slate-500'


  useEffect(() => {
    if (!albumId) return
    let cancelled = false
    setLoading(true)
    setAlbum(null)
    setSongs([])
    void Promise.allSettled([
      getAlbumDetail(albumId, platform),
      getAlbumSongs(albumId, platform),
    ]).then(([detailResult, songsResult]) => {
      if (cancelled) return
      if (detailResult.status === 'fulfilled') setAlbum(detailResult.value)
      if (songsResult.status === 'fulfilled' && Array.isArray(songsResult.value)) setSongs(songsResult.value)
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [albumId, platform])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex h-16 shrink-0 items-center gap-3 border-b px-5 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
        <button type="button" onClick={onClose} className="rounded-full p-2 transition hover:bg-black/10" aria-label="返回"><ArrowLeft className="h-5 w-5" /></button>
        <div className="min-w-0"><div className="text-sm font-medium">专辑详情</div><div className={`truncate text-xs ${muted}`}>{platformLabel(platform)}</div></div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10">
              {loading ? <div className={`flex h-72 items-center justify-center text-sm ${muted}`}>正在加载专辑...</div> : (
                <>
                  <section className="grid gap-6 md:grid-cols-[200px_minmax(0,1fr)]">
                    <img src={album?.picUrl ? getProxiedImageUrl(album.picUrl) : ''} alt="" className="aspect-square w-full max-w-[200px] rounded-xl object-cover shadow-2xl" />
                    <div className="min-w-0 self-center">
                      <div className={`mb-2 flex items-center gap-2 text-xs ${muted}`}><Disc3 className="h-4 w-4" style={{ color: accent }} />专辑</div>
                      <h1 className="text-2xl font-semibold">{album?.name || '专辑'}</h1>
                      <p className={`mt-2 text-sm ${muted}`}>{album?.artist?.name || '未知歌手'}{album?.publishTime ? ` · ${new Date(album.publishTime).getFullYear()}` : ''}{album?.size ? ` · ${album.size} 首` : ''}</p>
                      {album?.description && <p className={`mt-3 line-clamp-3 max-w-2xl text-sm leading-6 ${muted}`}>{album.description}</p>}
                      <button
                        type="button"
                        disabled={songs.length === 0}
                        onClick={() => songs[0] && onSongSelect(songs[0], songs, { mode: 'traditional', surface: 'traditional-album', platform: album?.platform || platform })}
                        className="mt-5 flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white disabled:opacity-45"
                        style={{ background: accent }}
                      >
                        <Play className="h-4 w-4 fill-current" />播放全部
                      </button>
                    </div>
                  </section>
                  <section className="mt-8">
                    <div className={`overflow-hidden rounded-xl border ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
                      <div className={`grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_56px_36px] items-center gap-3 border-b px-4 py-3 text-xs ${muted} ${isDark ? 'border-white/10 bg-white/[.035]' : 'border-slate-100 bg-slate-50'}`}>
                        <span>#</span><span>歌曲</span><span className="hidden sm:block">歌手</span><span><Clock3 className="h-3.5 w-3.5" /></span><span />
                      </div>
                      {songs.map((song, index) => {
                        const active = currentSong ? songKey(song) === songKey(currentSong) : false
                        return (
                          <div key={`${songKey(song)}:${index}`} className={`grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_56px_36px] items-center gap-3 px-4 py-2.5 transition ${active ? (isDark ? 'bg-white/10' : 'bg-pink-50') : isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}>
                            <button type="button" onClick={() => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-album', platform: song.platform || platform })} className="flex h-7 w-7 items-center justify-center text-xs" style={{ color: active ? accent : undefined }}>{active ? <Play className="h-3.5 w-3.5 fill-current" /> : index + 1}</button>
                            <button type="button" onClick={() => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-album', platform: song.platform || platform })} className="flex min-w-0 items-center gap-3 text-left">
                              <img src={coverOf(song)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" />
                              <span className="min-w-0"><span className={`block truncate text-sm ${active ? 'font-medium' : ''}`}>{song.name}</span><span className={`block truncate text-xs ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span></span>
                            </button>
                            <button type="button" onClick={() => song.artists?.[0]?.id && onOpenArtist?.(String(song.artists[0].id), song.platform || platform)} className={`hidden truncate text-left text-xs sm:block ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ') || '未知歌手'}</button>
                            <span className={`text-xs tabular-nums ${muted}`}>{formatDuration(song.duration)}</span>
                            <button type="button" onClick={event => setMenu({ show: true, x: event.clientX, y: event.clientY, song })} aria-label="歌曲更多操作" className="rounded p-1 hover:bg-black/10"><span className="block h-1 w-1 rounded-full bg-current opacity-60" /><span className="mt-0.5 block h-1 w-1 rounded-full bg-current opacity-60" /><span className="mt-0.5 block h-1 w-1 rounded-full bg-current opacity-60" /></button>
                          </div>
                        )
                      })}
                      {songs.length === 0 && <div className={`p-12 text-center text-sm ${muted}`}>这个专辑还没有可播放的歌曲</div>}
                    </div>
                  </section>
                </>
              )}
      </main>
      <SongContextMenu show={menu.show} x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-album', platform: song.platform || platform })} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={onViewComments} onViewAlbum={() => undefined} onViewArtist={song => song.artists?.[0]?.id && onOpenArtist?.(String(song.artists[0].id), song.platform || platform)} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={menu.song?.platform || platform} playerTheme={isDark ? 'dark' : 'light'} />
    </div>
  )
}

export default memo(TraditionalAlbumDetail)
