import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, Headphones, Heart, Play, Share2 } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl, isSameSong } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getPlatformCapabilities } from '../services/platforms'
import { subscribePlaylist } from '../services/playlistService'
import { APPLE_LIBRARY_ID, getLastAppleMutationResult, removeAppleTracksFromPlaylist } from '../services/appleCatalog'
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
  creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
  tags?: string[]
  platform?: MusicPlatform
  isLibrary?: boolean
  isCollected?: boolean
  isLike?: boolean
  /** 歌单被播放次数（QQ listennum / 网易云 playCount） */
  playCount?: number
  createTime?: number
} | null

interface TraditionalPlaylistDetailProps {
  playlist: Playlist
  songs: Song[]
  loading: boolean
  error?: string
  onRetry?: () => void
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
  onRemoveFromPlaylist?: (song: Song, playlistId: string) => void | Promise<void>
  onViewComments?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  userPlaylists?: any[]
  /** 当前登录用户名/头像：自建/我喜欢歌单无 creator 时展示 */
  ownUserName?: string
  ownUserAvatar?: string
  ownUserId?: string
  /** 点击创建者 → 打开其个人中心 */
  onOpenUserProfile?: (platform: MusicPlatform, userId: string, nickname?: string, avatarUrl?: string) => void
}

const formatPlayCount = (value: number) => {
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`
  return String(value)
}

const formatDuration = (milliseconds = 0) => {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
const songKey = (song: Song) => `${song.platform}:${song.appleId || song.mid || song.id || song.name}`
const coverOf = (song?: Song | null) => song?.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''

function TraditionalPlaylistDetail({
  playlist, songs, loading, error = '', onRetry, currentSong, playerTheme, accentColor, onClose, onSongSelect,
  onOpenArtist, onOpenAlbum, onPlayNext, onAddToFavorites, onRemoveFromFavorites, onAddToPlaylist, onRemoveFromPlaylist,
  onViewComments, onCopyInfo, userPlaylists = [], ownUserName, ownUserAvatar, ownUserId, onOpenUserProfile,
}: TraditionalPlaylistDetailProps) {
  const [menu, setMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({ show: false, x: 0, y: 0, song: null })
  const [collected, setCollected] = useState(Boolean(playlist?.isCollected))
  const [collecting, setCollecting] = useState(false)
  const dark = playerTheme === 'dark'
  const muted = dark ? 'text-white/50' : 'text-slate-500'
  const platform = playlist?.platform || 'netease'
  const playlistId = String(playlist?.id || playlist?.dirId || '')
  const canRemoveAppleTracks = platform === 'apple' && !playlist?.isLike && playlistId !== APPLE_LIBRARY_ID && !playlistId.startsWith('pl.')
  const canShare = getPlatformCapabilities(platform).sharePlaylist && (platform !== 'apple' || playlistId.startsWith('pl.'))
  const canSubscribePlaylist = getPlatformCapabilities(platform).subscribePlaylist
  const totalDuration = useMemo(() => songs.reduce((sum, song) => sum + (song.duration || 0), 0), [songs])
  const coverUrl = playlist?.coverImgUrl || playlist?.coverUrl || coverOf(songs[0])
  // 创建者：收藏歌单显示真实创建者；自建/我喜欢无 creator 时回退当前登录用户
  const creatorName = playlist?.creator?.nickname || ownUserName || ''
  const creatorId = playlist?.creator?.userId !== undefined && playlist?.creator?.userId !== null && String(playlist?.creator?.userId) !== ''
    ? String(playlist.creator.userId)
    : (playlist?.isCollected ? '' : (ownUserId || ''))
  const createdDate = playlist?.createTime ? (() => { const d = new Date(playlist.createTime); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })() : ''

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

  const removeAppleTrack = async (song: Song) => {
    const ok = await removeAppleTracksFromPlaylist(playlistId, [{
      catalogId: song.appleId && !String(song.appleId).startsWith('i.') ? song.appleId : undefined,
      libraryId: song.appleLibraryId || (String(song.appleId || '').startsWith('i.') ? song.appleId : undefined),
    }])
    if (!ok) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: getLastAppleMutationResult().error || '从 Apple 歌单移除失败，请重试', type: 'error' } }))
      return
    }
    window.dispatchEvent(new CustomEvent('playlist-content-changed', { detail: { platform: 'apple', type: 'playlist-tracks', playlistId } }))
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已从歌单移除', type: 'success' } }))
    onRetry?.()
  }

  const share = () => {
    const storefront = localStorage.getItem('appleExploreCountry') || localStorage.getItem('appleStorefront') || 'cn'
    const url = platform === 'apple'
      ? `https://music.apple.com/${encodeURIComponent(storefront)}/playlist/${encodeURIComponent(playlist?.name || 'playlist')}/${encodeURIComponent(playlistId)}`
      : platform === 'qq'
        ? `https://y.qq.com/n/ryqq/playlist/${playlistId}`
        : platform === 'spotify'
          ? `https://open.spotify.com/playlist/${playlistId}`
          : `https://music.163.com/#/playlist?id=${playlistId}`
    void navigator.clipboard?.writeText(url)
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '歌单链接已复制', type: 'success' } }))
  }

  return <div className="flex h-full min-h-0 flex-col">
    <main ref={listScrollRef} onScroll={handleListScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-6 lg:px-10">
      {loading ? <div className="flex h-72 items-center justify-center"><div className={`text-sm ${muted}`}>正在加载歌单...</div></div> : error ? (
        <div className={`flex h-72 flex-col items-center justify-center gap-3 text-sm ${muted}`}>
          <span>{error}</span>
          {onRetry && <button type="button" onClick={onRetry} className="rounded-full px-4 py-2 text-xs text-white" style={{ background: accentColor }}>重试</button>}
        </div>
      ) : (
        <>
          {/* 头部：封面 + 信息（QQ 音乐版式） */}
          <section className="flex flex-col gap-6 sm:flex-row">
            <div className="relative shrink-0">
              <img src={coverUrl} alt="" loading="lazy" className="h-44 w-44 rounded-2xl object-cover shadow-2xl" />
              {/* 耳机角标 = 歌单被播放次数；「我喜欢」不显示（QQ/网易云的我喜欢均无该数据） */}
              {!playlist?.isLike && (playlist?.playCount || 0) > 0 && (
                <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white backdrop-blur"><Headphones className="h-3 w-3" />{formatPlayCount(playlist?.playCount || 0)}</span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-3xl font-bold leading-tight">{playlist?.name || '歌单'}</h1>
              <div className={`mt-3 flex flex-wrap items-center gap-2 text-sm ${muted}`}>
                {(playlist?.creator?.avatarUrl || ownUserAvatar) ? <img src={playlist?.creator?.avatarUrl || ownUserAvatar} alt="" className="h-5 w-5 rounded-full object-cover" /> : null}
                {creatorId && onOpenUserProfile ? (
                  <button type="button" onClick={() => onOpenUserProfile(platform, creatorId, creatorName, playlist?.creator?.avatarUrl || ownUserAvatar)} className="transition hover:underline" style={{ color: accentColor }}>{creatorName}</button>
                ) : (
                  <span>{creatorName}</span>
                )}
                {createdDate && <span className={`text-xs ${muted}`}>{createdDate} 创建</span>}
                {(playlist?.tags || []).slice(0, 4).map(tag => <span key={String(tag)}>#{tag}</span>)}
              </div>
              <p className={`mt-2 max-w-3xl text-xs leading-5 ${muted}`}>{playlist?.description || playlist?.desc || `${songs.length || playlist?.trackCount || 0} 首歌曲 · ${Math.floor(totalDuration / 60000)} 分钟`}</p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button type="button" disabled={songs.length === 0} onClick={() => songs[0] && onSongSelect(songs[0], songs)} className="flex items-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium text-white disabled:opacity-45" style={{ background: accentColor }}><Play className="h-4 w-4 fill-current" />播放</button>
                {canSubscribePlaylist && <button type="button" onClick={() => void toggleCollection()} className={`flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm transition ${dark ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white/70 hover:bg-slate-100'}`}><Heart className={`h-4 w-4 ${collected ? 'fill-current' : ''}`} style={{ color: collected ? accentColor : undefined }} />{collected ? '已收藏' : '收藏'}</button>}
                {canShare && <button type="button" onClick={share} className={`flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm transition ${dark ? 'border-white/15 bg-white/5 hover:bg-white/10' : 'border-slate-200 bg-white/70 hover:bg-slate-100'}`}><Share2 className="h-4 w-4" />分享</button>}
              </div>
            </div>
          </section>

          {/* 歌曲列表：歌名/歌手 | 收藏 | 专辑 | 时长；整行右键打开菜单，无 ⋯ 按钮 */}
          <section className="mt-8">
            <div className="mb-3">
              <div className="inline-block border-b-2 pb-2 text-base font-semibold" style={{ borderColor: accentColor, color: accentColor }}>歌曲 {songs.length || playlist?.trackCount || 0}</div>
            </div>
            <div className={`grid grid-cols-[minmax(0,1fr)_44px_minmax(110px,.7fr)_58px] items-center gap-3 px-4 pb-2 text-xs ${muted}`}><span>歌名 / 歌手</span><span /><span className="hidden sm:block">专辑</span><span className="flex justify-end"><Clock3 className="h-3.5 w-3.5" /></span></div>
            {songs.length === 0 ? <div className={`rounded-xl border p-12 text-center text-sm ${muted} ${dark ? 'border-white/10' : 'border-slate-200'}`}>{platform === 'soda' && !isSodaLoggedIn() ? '登录汽水音乐后查看歌单歌曲' : '这个歌单还没有可播放的歌曲'}</div> : (
              <div className="relative" style={{ height: virtualListHeight }}>
                {visibleSongs.map(({ song, index }) => {
                  const active = currentSong ? isSameSong(song, currentSong) : false
                  return (
                    <div
                      key={`${songKey(song)}:${index}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => onSongSelect(song, songs)}
                      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSongSelect(song, songs) } }}
                      onContextMenu={event => { event.preventDefault(); setMenu({ show: true, x: event.clientX, y: event.clientY, song }) }}
                      className={`group absolute left-0 right-0 grid cursor-pointer grid-cols-[minmax(0,1fr)_44px_minmax(110px,.7fr)_58px] items-center gap-3 px-4 transition ${active ? (dark ? 'bg-white/10' : 'bg-pink-50') : dark ? 'hover:bg-white/[.055]' : 'hover:bg-slate-50'}`}
                      style={{ top: index * DETAIL_ROW_HEIGHT, height: DETAIL_ROW_HEIGHT }}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="relative shrink-0">
                          <img src={coverOf(song)} alt="" loading="lazy" className="h-10 w-10 rounded-lg object-cover" />
                          <span className="absolute inset-0 hidden items-center justify-center rounded-lg bg-black/40 group-hover:flex"><Play className="h-4 w-4 fill-current text-white" /></span>
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 text-sm" style={{ color: active ? accentColor : undefined }}>
                            <span className="truncate">{song.name}</span>
                            {song.vip ? <span className="shrink-0 rounded border px-1 text-[9px] leading-4" style={{ borderColor: accentColor, color: accentColor }}>VIP</span> : null}
                          </span>
                          {(() => {
                            const artist = song.artists?.[0]
                            const artistId = artist?.appleId || artist?.mid || artist?.id
                            return artistId && onOpenArtist ? (
                              <button type="button" onClick={event => { event.stopPropagation(); onOpenArtist(String(artistId), song.platform || platform) }} className={`block max-w-full truncate text-xs hover:underline ${muted}`}>{song.artists?.map(item => item.name).join(' / ')}</button>
                            ) : <span className={`block truncate text-xs ${muted}`}>{song.artists?.map(item => item.name).join(' / ')}</span>
                          })()}
                        </span>
                      </span>
                      <button type="button" onClick={event => { event.stopPropagation(); onAddToFavorites?.(song) }} aria-label="收藏歌曲" className={`flex justify-center transition hover:scale-110 ${muted}`}><Heart className="h-4 w-4" /></button>
                      <button type="button" onClick={event => { event.stopPropagation(); const albumId = song.album?.appleId || song.album?.mid || song.album?.id; if (albumId) onOpenAlbum?.(String(albumId), song.platform || platform) }} className={`hidden truncate text-left text-xs sm:block ${muted}`}>{song.album?.name || '未知专辑'}</button>
                      <span className={`text-right text-xs tabular-nums ${muted}`}>{formatDuration(song.duration)}</span>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </>
      )}
    </main>
    <SongContextMenu show={menu.show} x={menu.x} y={menu.y} song={menu.song} onClose={() => setMenu({ show: false, x: 0, y: 0, song: null })} onPlayNow={song => onSongSelect(song, songs)} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites} onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist} onRemoveFromPlaylist={onRemoveFromPlaylist ? song => { void onRemoveFromPlaylist(song, playlistId) } : canRemoveAppleTracks ? song => { void removeAppleTrack(song) } : undefined} currentPlaylistId={playlistId} onViewComments={onViewComments} onViewAlbum={song => { const albumId = song.album?.appleId || song.album?.mid || song.album?.id; if (albumId) onOpenAlbum?.(String(albumId), song.platform || platform) }} onViewArtist={song => { const artist = song.artists?.[0]; const artistId = artist?.appleId || artist?.mid || artist?.id; if (artistId) onOpenArtist?.(String(artistId), song.platform || platform) }} onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={platform} playerTheme={playerTheme} />
  </div>
}

export default memo(TraditionalPlaylistDetail)
