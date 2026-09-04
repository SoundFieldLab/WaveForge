// 传统模式独立搜索：不复用全局搜索弹层，在传统三栏布局的主区域内完成
// 「输入 → 歌曲/歌手/专辑/歌单 分栏结果 → 播放/右键操作」的完整流程。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Clock3, History, Loader2, Music2, Play, Search, SearchX, Trash2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl, searchAlbums, searchArtists, searchPlaylists, searchSongs } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getPlatformCapabilities, platformLabel } from '../services/platforms'
import SongContextMenu from './SongContextMenu'
import type { PlaybackOrigin } from '../types/playbackNavigation'

const formatDuration = (milliseconds = 0) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const songKey = (song: Song) => `${song.platform}:${song.id || song.mid || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

type SearchTab = 'songs' | 'artists' | 'albums' | 'playlists'

interface TraditionalSearchProps {
  platform: MusicPlatform
  accent: string
  isDark: boolean
  currentSong: Song | null
  onBack: () => void
  onSongSelect: (song: Song, songs: Song[], origin: PlaybackOrigin) => void
  onOpenPlaylist: (playlist: any) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  userPlaylists?: any[]
}

const TAB_LABELS: Array<[SearchTab, string]> = [
  ['songs', '歌曲'], ['artists', '歌手'], ['albums', '专辑'], ['playlists', '歌单'],
]
const supportsPlaylistSearch = (platform: MusicPlatform) => getPlatformCapabilities(platform).searchPlaylists

function TraditionalSearch({
  platform, accent, isDark, currentSong, onSongSelect, onOpenPlaylist,
  onOpenArtist, onOpenAlbum, onPlayNext, onAddToFavorites, onRemoveFromFavorites,
  onAddToPlaylist, onViewComments, onCopyInfo, userPlaylists = [],
}: TraditionalSearchProps) {
  const [keyword, setKeyword] = useState('')
  const [tab, setTab] = useState<SearchTab>('songs')
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [songs, setSongs] = useState<Song[]>([])
  const [artists, setArtists] = useState<any[]>([])
  const [albums, setAlbums] = useState<any[]>([])
  const [playlists, setPlaylists] = useState<any[]>([])
  const [error, setError] = useState('')
  const [songMenu, setSongMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const [history, setHistory] = useState<string[]>(() => {
    try { return Array.isArray(JSON.parse(localStorage.getItem(`waveforge:traditional-search-history:${platform}`) || '[]')) ? JSON.parse(localStorage.getItem(`waveforge:traditional-search-history:${platform}`) || '[]') : [] } catch { return [] }
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef(0)
  const debounceRef = useRef<number | null>(null)
  const previousTabRef = useRef<SearchTab>('songs')
  const availableTabs = TAB_LABELS.filter(([value]) => value !== 'playlists' || supportsPlaylistSearch(platform))

  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  const surface = isDark ? 'bg-white/[0.055] border-white/10' : 'bg-white/75 border-black/10'

  // 搜索历史：去重 + 上限 12，按平台分存（与简约模式 SearchPanel 同语义）
  const pushHistory = useCallback((kw: string) => {
    setHistory(prev => {
      const next = [kw, ...prev.filter(item => item !== kw)].slice(0, 12)
      localStorage.setItem(`waveforge:traditional-search-history:${platform}`, JSON.stringify(next))
      return next
    })
  }, [platform])
  const clearHistory = useCallback(() => {
    setHistory([])
    localStorage.removeItem(`waveforge:traditional-search-history:${platform}`)
  }, [platform])

  const runSearch = useCallback(async (query: string, targetTab: SearchTab) => {
    const trimmed = query.trim()
    if (!trimmed) return
    pushHistory(trimmed)
    const requestId = ++requestIdRef.current
    setLoading(true)
    setSearched(true)
    setError('')
    try {
      if (targetTab === 'songs') {
        const result = await searchSongs(trimmed, 30, platform)
        if (requestId !== requestIdRef.current) return
        setSongs(result.songs || [])
      } else if (targetTab === 'artists') {
        const result = await searchArtists(trimmed, platform)
        if (requestId !== requestIdRef.current) return
        setArtists(result || [])
      } else if (targetTab === 'albums') {
        const result = await searchAlbums(trimmed, platform)
        if (requestId !== requestIdRef.current) return
        setAlbums(result || [])
      } else {
        const data = await searchPlaylists(trimmed, platform)
        if (requestId !== requestIdRef.current) return
        if (data.unsupported) throw new Error(`${platformLabel(platform)}暂不支持歌单搜索`)
        setPlaylists(data.playlists || [])
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        console.error('传统模式搜索失败:', error)
        setError(error instanceof Error ? error.message : '搜索失败，请重试')
      }
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [platform, pushHistory])

  // 防抖：输入停顿 320ms 后自动搜歌曲（其他分栏在切到时再搜）
  useEffect(() => {
    const trimmed = keyword.trim()
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current)
    if (!trimmed) {
      requestIdRef.current += 1
      setSearched(false)
      setLoading(false)
      setError('')
      return
    }
    if (tab !== 'songs') return
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null
      void runSearch(trimmed, 'songs')
    }, 320)
    return () => { if (debounceRef.current !== null) window.clearTimeout(debounceRef.current) }
  }, [keyword, tab, runSearch])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => {
    if (previousTabRef.current === tab) return
    previousTabRef.current = tab
    if (tab !== 'songs' && keyword.trim()) void runSearch(keyword, tab)
  }, [tab, keyword, runSearch])

  useEffect(() => {
    if (tab === 'playlists' && !supportsPlaylistSearch(platform)) setTab('songs')
  }, [platform, tab])

  const submitSearch = () => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    void runSearch(keyword, tab)
  }

  const activeSong = (song: Song) => currentSong && songKey(song) === songKey(currentSong)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-5 flex items-center gap-3">
        
        <div className={`flex h-11 flex-1 items-center gap-2 rounded-2xl border px-4 ${surface}`}>
          <Search className="h-4 w-4 opacity-50" />
          <input
            ref={inputRef}
            value={keyword}
            onChange={event => setKeyword(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') submitSearch() }}
            placeholder={`搜索 ${platformLabel(platform)} 的歌曲、歌手、专辑或歌单`}
            className="h-full w-full bg-transparent text-sm outline-none"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin opacity-60" />}
        </div>
      </div>

      <div className="mb-4 flex items-center gap-1 rounded-2xl border p-1" style={{ borderColor: isDark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.1)' }}>
        {availableTabs.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className="relative rounded-xl px-4 py-1.5 text-xs transition"
            style={tab === value ? { color: '#fff', background: accent } : undefined}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!searched ? (
          history.length > 0 ? (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-sm font-semibold"><History className="h-4 w-4" style={{ color: accent }} />搜索历史</h2>
                <button type="button" onClick={clearHistory} className={`flex items-center gap-1 text-xs transition hover:opacity-70 ${muted}`}><Trash2 className="h-3.5 w-3.5" />清空</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {history.map(item => (
                  <button key={item} type="button" onClick={() => setKeyword(item)} className={`rounded-full border px-3 py-1.5 text-xs transition hover:bg-white/10 ${muted} ${surface}`}>{item}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: `${accent}22` }}>
                <Search className="h-7 w-7" style={{ color: accent }} />
              </div>
              <p className={`text-sm ${muted}`}>输入关键词，按下回车或稍等片刻自动搜索</p>
            </div>
          )
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-14 animate-pulse rounded-2xl bg-white/10" />)}
          </div>
        ) : error ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-16">
            <SearchX className="h-10 w-10 opacity-30" />
            <p className={`text-sm ${muted}`}>{error}</p>
            <button type="button" onClick={submitSearch} className="rounded-full px-4 py-2 text-xs text-white" style={{ background: accent }}>重试</button>
          </div>
        ) : tab === 'songs' ? (
          songs.length === 0 ? <EmptyHint keyword={keyword} /> : (
            <div className={`overflow-hidden rounded-2xl border ${surface}`}>
              {songs.map((song, index) => {
                const active = activeSong(song)
                return (
                  <div
                    key={songKey(song) + ':' + index}
                    role="button"
                    tabIndex={0}
                    onClick={() => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-search', platform: song.platform || platform })}
                    onContextMenu={event => { event.preventDefault(); setSongMenu({ show: true, x: event.clientX, y: event.clientY, song }) }}
                    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-search', platform: song.platform || platform }) } }}
                    className={`group grid cursor-pointer grid-cols-[36px_minmax(0,1fr)_minmax(100px,.6fr)_56px] items-center gap-3 border-b px-4 py-2.5 transition last:border-b-0 ${active ? (isDark ? 'bg-white/10' : 'bg-pink-50') : isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}
                  >
                    <span className="flex justify-center text-xs" style={{ color: active ? accent : undefined }}>
                      {active ? <Music2 className="h-3.5 w-3.5" style={{ color: accent }} /> : <span className={`${muted}`}>{index + 1}</span>}
                    </span>
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: `${accent}22` }}>
                        {coverOf(song) ? <img src={coverOf(song)} alt="" loading="lazy" className="h-full w-full object-cover" /> : <Music2 className="h-4 w-4 opacity-35" />}
                        <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/40 group-hover:flex"><Play className="h-4 w-4 fill-current text-white" /></span>
                      </span>
                      <span className="min-w-0">
                        <span className={`block truncate text-sm ${active ? 'font-medium' : ''}`}>{song.name}</span>
                        <span className={`block truncate text-xs ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span>
                      </span>
                    </span>
                    <span className={`hidden truncate text-xs sm:block ${muted}`}>{song.album?.name || '未知专辑'}</span>
                    <span className={`text-right text-xs tabular-nums ${muted}`}>{formatDuration(song.duration)}</span>
                  </div>
                )
              })}
            </div>
          )
        ) : tab === 'artists' ? (
          artists.length === 0 ? <EmptyHint keyword={keyword} /> : (
            <div className={`overflow-hidden rounded-2xl border ${surface}`}>
              {artists.map((artist, index) => (
                <button
                  key={`${artist.appleId || artist.mid || artist.id}:${index}`}
                  type="button"
                  onClick={() => {
                    const artistId = artist.appleId || artist.mid || artist.id
                    if (artistId) onOpenArtist?.(String(artistId), artist.platform || platform)
                  }}
                  className={`flex w-full items-center gap-3 border-b px-4 py-3 text-left transition last:border-b-0 ${isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}
                >
                  {artist.picUrl ? <img src={getProxiedImageUrl(artist.picUrl)} alt="" className="h-12 w-12 rounded-full object-cover" /> : <span className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: `${accent}22` }}><Music2 className="h-5 w-5 opacity-35" /></span>}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{artist.name}</span>
                    <span className={`block truncate text-xs ${muted}`}>{artist.musicSize ? `${artist.musicSize} 首歌曲` : '歌手'}</span>
                  </span>
                  <Play className="h-4 w-4 opacity-0 transition group-hover:opacity-60" />
                </button>
              ))}
            </div>
          )
        ) : tab === 'albums' ? (
          albums.length === 0 ? <EmptyHint keyword={keyword} /> : (
            <div className={`overflow-hidden rounded-2xl border ${surface}`}>
              {albums.map((album, index) => (
                <button
                  key={`${album.appleId || album.mid || album.id}:${index}`}
                  type="button"
                  onClick={() => {
                    const albumId = album.appleId || album.mid || album.id
                    if (albumId) onOpenAlbum?.(String(albumId), album.platform || platform)
                  }}
                  className={`flex w-full items-center gap-3 border-b px-4 py-3 text-left transition last:border-b-0 ${isDark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}
                >
                  <img src={album.picUrl ? getProxiedImageUrl(album.picUrl) : ''} alt="" className="h-12 w-12 rounded-xl object-cover" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{album.name}</span>
                    <span className={`block truncate text-xs ${muted}`}>{album.artist?.name || '未知歌手'}</span>
                  </span>
                  {album.publishTime ? <span className={`text-xs tabular-nums ${muted}`}>{new Date(album.publishTime).getFullYear()}</span> : <Clock3 className="h-4 w-4 opacity-40" />}
                </button>
              ))}
            </div>
          )
        ) : (
          playlists.length === 0 ? <EmptyHint keyword={keyword} /> : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {playlists.map((playlist, index) => (
                <button
                  key={`${playlist.id}:${index}`}
                  type="button"
                  onClick={() => onOpenPlaylist(playlist)}
                  className={`overflow-hidden rounded-2xl border p-2 text-left transition hover:-translate-y-1 ${surface}`}
                >
                  <img src={playlist.coverUrl || playlist.coverImgUrl || ''} alt="" className="aspect-square w-full rounded-xl object-cover" />
                  <div className="mt-2 truncate text-sm">{playlist.name}</div>
                  <div className={`truncate text-xs ${muted}`}>{playlist.trackCount ? `${playlist.trackCount} 首` : playlist.creator || '精选歌单'}</div>
                </button>
              ))}
            </div>
          )
        )}
      </div>

      <SongContextMenu
        show={songMenu.show} x={songMenu.x} y={songMenu.y} song={songMenu.song}
        onClose={() => setSongMenu({ show: false, x: 0, y: 0, song: null })}
        onPlayNow={song => onSongSelect(song, songs, { mode: 'traditional', surface: 'traditional-search', platform: song.platform || platform })}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onViewAlbum={song => {
          const albumId = song.album?.appleId || song.album?.mid || song.album?.id
          if (albumId) onOpenAlbum?.(String(albumId), song.platform || platform)
        }}
        onViewArtist={song => {
          const artist = song.artists?.[0]
          const artistId = artist?.appleId || artist?.mid || artist?.id
          if (artistId) onOpenArtist?.(String(artistId), song.platform || platform)
        }}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists}
        platform={songMenu.song?.platform || platform}
        playerTheme={isDark ? 'dark' : 'light'}
      />
    </div>
  )
}

function EmptyHint({ keyword }: { keyword: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 py-16">
      <SearchX className="h-10 w-10 opacity-30" />
      <p className="text-sm opacity-60">没有找到与「{keyword}」相关的结果</p>
    </div>
  )
}

export default memo(TraditionalSearch)
