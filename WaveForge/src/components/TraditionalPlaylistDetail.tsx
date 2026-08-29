import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, Heart, MoreHorizontal, Play, Share2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getPlatformCapabilities } from '../services/platforms'
import { subscribePlaylist } from '../services/playlistService'
import { isSodaLoggedIn } from '../services/sodaService'
import SongContextMenu from './SongContextMenu'

type Playlist = {
  id: number | string
  dirId?: number | string
  name: string
  coverImgUrl?: string
  coverUrl?: string
  trackCount?: number
  description?: string
  desc?: string
  creator?: { nickname?: string; avatarUrl?: string }
  tags?: string[]
  platform?: MusicPlatform
  isCollected?: boolean
} | null

interface TraditionalPlaylistDetailProps {
  playlist: Playlist
  songs: Song[]
  loading: boolean
  currentSong: Song | null
  playerTheme: 'light' | 'dark'
  accentColor: string
  onClose: () => void
  onSongSelect: (song: Song, songs: Song[]) => void
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

const formatDuration = (milliseconds = 0) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const songKey = (song: Song) => `${song.platform}:${song.id || song.mid || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

function TraditionalPlaylistDetail({
  playlist, songs, loading, currentSong, playerTheme, accentColor, onClose, onSongSelect,
  onOpenArtist, onOpenAlbum, onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist,
  onViewComments, onCopyInfo, userPlaylists = [],
}: TraditionalPlaylistDetailProps) {
  const [menu, setMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const [collected, setCollected] = useState(Boolean(playlist?.isCollected))
  const [collecting, setCollecting] = useState(false)
  const dark = playerTheme === 'dark'
  const muted = dark ? 'text-white/50' : 'text-slate-500'
  const platform = playlist?.platform || 'netease'
  // 汽水歌单也显示「收藏」按钮：走 sodaService.collectSodaPlaylist（能力表暂未放开 subscribePlaylist）
  const canSubscribePlaylist = getPlatformCapabilities(platform).subscribePlaylist || platform === 'soda'
  const totalDuration = useMemo(() => songs.reduce((sum, song) => sum + (song.duration || 0), 0), [songs])
  const coverUrl = playlist?.coverImgUrl || playlist?.coverUrl || coverOf(songs[0])

  // ── 大列表虚拟化：几千首歌单只渲染可见行，避免一次性渲染全部行 + 全部封面请求打穿代理 ──
  const DETAIL_ROW_HEIGHT = 62
  const DETAIL_OVERSCAN = 8
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 })
  const pendingViewportRef = useRef<{ scrollTop: number; height: number } | null>(null)
  const viewportFrameRef = useRef<number | null>(null)
  const listScrollRef = useRef<HTMLDivElement | null>(null)

  const commitViewport = useCallback((scrollTop: number, height: number) => {
    pendingViewportRef.current = { scrollTop, height }
    if (viewportFrameRef.current !== null) return
    viewportFrameRef.current = window.requestAnimationFrame(() => {
      viewportFrameRef.current = null
      setViewport(pendingViewportRef.current || { scrollTop: 0, height: 0 })
    })
  }, [])
  const handleListScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const container = event.currentTarget
    commitViewport(container.scrollTop, container.clientHeight)
  }, [commitViewport])
  const viewportHeight = viewport.height || (typeof window === 'undefined' ? 640 : Math.max(320, window.innerHeight * 0.7))
  const visibleStart = Math.max(0, Math.floor(viewport.scrollTop / DETAIL_ROW_HEIGHT) - DETAIL_OVERSCAN)
  const visibleEnd = Math.min(songs.length, Math.ceil((viewport.scrollTop + viewportHeight) / DETAIL_ROW_HEIGHT) + DETAIL_OVERSCAN)
  const visibleSongs = useMemo(
    () => songs.slice(visibleStart, visibleEnd).map((song, offset) => ({ song, index: visibleStart + offset })),
    [songs, visibleStart, visibleEnd],
  )
  const virtualListHeight = songs.length * DETAIL_ROW_HEIGHT
  useEffect(() => () => { if (viewportFrameRef.current !== null) window.cancelAnimationFrame(viewportFrameRef.current) }, [])

  useEffect(() => { setCollected(Boolean(playlist?.isCollected)) }, [playlist?.id, playlist?.isCollected])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const toggleCollection = async () => {
    if (!playlist || collecting || !canSubscribePlaylist) return
    setCollecting(true)
    try {
      if (platform === 'soda') {
        // 汽水：抖音收藏网关（通用 subscribePlaylist 不覆盖汽水），成功后本地翻转状态
        const { collectSodaPlaylist } = await import('../services/sodaService')
        const ok = await collectSodaPlaylist(String(playlist.id || playlist.dirId || ''), !collected)
        if (!ok) throw new Error(collected ? '汽水取消收藏失败' : '汽水收藏歌单失败')
      } else {
        const result = await subscribePlaylist(String(playlist.id || playlist.dirId || ''), !collected, platform)
        if (result?.error || result?.errMsg) throw new Error(result.error || result.errMsg)
      }
      setCollected(value => !value)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: collected ? '已取消收藏歌单' : '已收藏歌单', type: 'success' } }))
    } catch (error) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: error instanceof Error ? error.message : '歌单收藏失败，请重试', type: 'error' } }))
    } finally { setCollecting(false) }
  }

  const share = () => {
    const url = platform === 'qq' ? `https://y.qq.com/n/ryqq/playlist/${playlist?.id || playlist?.dirId || ''}` : `https://music.163.com/#/playlist?id=${playlist?.id || ''}`
    void navigator.clipboard?.writeText(url)
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单链接已复制', type: 'success' } }))
  }

  return <div className="flex h-full min-h-0 flex-col">
    <header className={`flex h-16 shrink-0 items-center gap-3 border-b px-5 ${dark ? 'border-white/10' : 'border-slate-200'}`}><div className="min-w-0"><div className="text-sm font-medium">歌单详情</div><div className={`truncate text-xs ${muted}`}>{playlist?.creator?.nickname || '来自音乐馆'}</div></div></header>
    <main ref={listScrollRef} onScroll={handleListScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10">
      {loading ? <div className="flex h-72 items-center justify-center"><div className={`text-sm ${muted}`}>正在加载歌单...</div></div> : <><section className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]"><img src={coverUrl} alt="" loading="lazy" className="aspect-square w-full max-w-[220px] rounded-xl object-cover shadow-2xl" /><div className="min-w-0 self-center"><div className={`mb-2 text-xs ${muted}`}>精选歌单</div><h1 className="text-2xl font-semibold">{playlist?.name || '歌单'}</h1><p className={`mt-3 max-w-2xl text-sm leading-6 ${muted}`}>{playlist?.description || playlist?.desc || '把喜欢的声音收集在这里，按下播放即可从第一首开始。'}</p><div className={`mt-4 flex flex-wrap gap-2 text-xs ${muted}`}><span>{playlist?.creator?.nickname || 'WaveForge 用户'}</span><span>·</span><span>{songs.length || playlist?.trackCount || 0} 首歌曲</span><span>·</span><span>{Math.floor(totalDuration / 60000)} 分钟</span></div><div className="mt-5 flex flex-wrap gap-2"><button type="button" disabled={songs.length === 0} onClick={() => songs[0] && onSongSelect(songs[0], songs)} className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium text-white disabled:opacity-45" style={{ background: accentColor }}><Play className="h-4 w-4 fill-current" />播放全部</button>{canSubscribePlaylist && <button type="button" onClick={() => void toggleCollection()} className={`flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm ${dark ? 'border-white/15 hover:bg-white/10' : 'border-slate-200 hover:bg-slate-100'}`}><Heart className={`h-4 w-4 ${collected ? 'fill-current' : ''}`} style={{ color: collected ? accentColor : undefined }} />{collected ? '已收藏' : '收藏'}</button>}{platform !== 'soda' && <button type="button" onClick={share} className={`flex items-center gap-2 rounded-full border px-4 py-2.5 text-sm ${dark ? 'border-white/15 hover:bg-white/10' : 'border-slate-200 hover:bg-slate-100'}`}><Share2 className="h-4 w-4" />分享</button>}</div></div></section>
        <section className="mt-9"><div className="mb-3 flex items-center justify-between"><div><h2 className="text-lg font-semibold">歌曲</h2><p className={`mt-1 text-xs ${muted}`}>{songs.length} 首 · {Math.floor(totalDuration / 60000)} 分钟</p></div></div><div className={`overflow-hidden rounded-xl border ${dark ? 'border-white/10' : 'border-slate-200'}`}><div className={`grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_58px_36px] items-center gap-3 border-b px-4 py-3 text-xs ${muted} ${dark ? 'border-white/10 bg-white/[.035]' : 'border-slate-100 bg-slate-50'}`}><span>#</span><span>歌曲</span><span className="hidden sm:block">专辑</span><span><Clock3 className="h-3.5 w-3.5" /></span><span /></div>
          {songs.length === 0 ? <div className={`p-12 text-center text-sm ${muted}`}>{platform === 'soda' && !isSodaLoggedIn() ? '登录汽水音乐后查看歌单歌曲' : '这个歌单还没有可播放的歌曲'}</div> : (
            <div className="relative" style={{ height: virtualListHeight }}>
              {visibleSongs.map(({ song, index }) => {
                const active = currentSong ? songKey(song) === songKey(currentSong) : false
                return (
                  <div key={`${songKey(song)}:${index}`} className={`absolute left-0 right-0 grid grid-cols-[42px_minmax(0,1fr)_minmax(110px,.7fr)_58px_36px] items-center gap-3 border-b px-4 py-2.5 text-left transition ${dark ? 'border-white/5' : 'border-slate-100'} ${active ? (dark ? 'bg-white/10' : 'bg-pink-50') : dark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`} style={{ top: index * DETAIL_ROW_HEIGHT, height: DETAIL_ROW_HEIGHT }}>
                    <button type="button" onClick={() => onSongSelect(song, songs)} className="flex h-7 w-7 items-center justify-center text-xs" style={{ color: active ? accentColor : undefined }}>{active ? <Play className="h-3.5 w-3.5 fill-current" /> : index + 1}</button>
                    <button type="button" onClick={() => onSongSelect(song, songs)} className="flex min-w-0 items-center gap-3 text-left"><img src={coverOf(song)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" /><span className="min-w-0"><span className="block truncate text-sm">{song.name}</span><span className={`block truncate text-xs ${muted}`}>{song.artists?.map(artist => artist.name).join(' / ')}</span></span></button>
                    <button type="button" onClick={() => song.album?.id && onOpenAlbum?.(String(song.album.id), song.platform || platform)} className={`hidden truncate text-left text-xs sm:block ${muted}`}>{song.album?.name || '未知专辑'}</button>
                    <span className={`text-xs ${muted}`}>{formatDuration(song.duration)}</span>
                    <button type="button" onClick={event => setMenu({ show: true, x: event.clientX, y: event.clientY, song })} aria-label="歌曲更多操作" className="rounded p-1 hover:bg-black/10"><MoreHorizontal className="h-4 w-4" /></button>
                  </div>
                )
              })}
            </div>
          )}
        </div></section></>}
    </main>
    <SongContextMenu show={menu.show} x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, songs)} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onViewComments={onViewComments} onViewAlbum={song => song.album?.id && onOpenAlbum?.(String(song.album.id), song.platform || platform)} onViewArtist={song => song.artists?.[0]?.id && onOpenArtist?.(String(song.artists[0].id), song.platform || platform)} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={platform} playerTheme={playerTheme} />
  </div>
}

export default memo(TraditionalPlaylistDetail)
