/**
 * 学歌 · 选歌抽屉：不用绕去播放页，直接在这里挑一首开练。
 *
 * 三个入口：
 *   1. 搜索：调 searchSongs（当前平台），回车/点按钮出结果；
 *   2. 我的歌单：getUserPlaylists（网易云/QQ/汽水/酷狗）+ Apple 资料库歌单，
 *      点歌单 → getPlaylistDetail / 流式接口拉曲目 → 列表；
 *   3. 当前队列：App 传进来的 playlist 直接列。
 *
 * 点歌 = onPickSong(song, songs)，由父视图调 App 的 onSongSelect 原地开播。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ListMusic, Loader2, Play, Search, X, Music2 } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { searchSongs, getProxiedImageUrl } from '../../services/musicApi'
import { getApiBase } from '../../services/apiConfig'
import { getPlatformCookie, type MusicPlatform } from '../../services/platforms'
import { cookieHeaders } from '../../services/cookieRequest'
import { getPlaylistDetail, getUserPlaylists } from '../../services/playlistService'
import { getAppleLibraryPlaylists, getApplePlaylistTracks, appleSongToSong, APPLE_FAVORITES_ID, APPLE_LIBRARY_ID } from '../../services/appleCatalog'
import { getAppleAuthState } from '../../services/appleAuth'

interface PlaylistItem {
  id: string
  name: string
  coverImgUrl: string
  trackCount: number
  platform: MusicPlatform
  isLike?: boolean
}

interface SingAlongSongPickerProps {
  open: boolean
  onClose: () => void
  currentSong: Song | null
  onPickSong: (song: Song, songs?: Song[]) => void
}

const PICKER_PLATFORMS: { id: MusicPlatform; label: string }[] = [
  { id: 'netease', label: '网易云' },
  { id: 'qq', label: 'QQ音乐' },
  { id: 'apple', label: 'Apple' },
  { id: 'soda', label: '汽水' },
  { id: 'kugou', label: '酷狗' },
]

const PLATFORM_KEY: Partial<Record<MusicPlatform, string>> = {
  netease: 'netease_user_id',
  qq: 'qq_user_id',
  soda: 'soda_user_id',
  kugou: 'kugou_user_id',
}

const ACCENT = '#7c5cff'

export default function SingAlongSongPicker({ open, onClose, currentSong, onPickSong }: SingAlongSongPickerProps) {
  const [tab, setTab] = useState<'search' | 'playlists' | 'queue'>('search')
  const [platform, setPlatform] = useState<MusicPlatform>((localStorage.getItem('platform') as MusicPlatform) || 'netease')
  const [keyword, setKeyword] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Song[]>([])
  const [searchError, setSearchError] = useState('')
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([])
  const [playlistsLoading, setPlaylistsLoading] = useState(false)
  const [openPlaylist, setOpenPlaylist] = useState<PlaylistItem | null>(null)
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([])
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistError, setPlaylistError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  // 打开时清状态；关抽屉时中止在途请求
  useEffect(() => {
    if (open) return
    abortRef.current?.abort()
    abortRef.current = null
    setSearchResults([])
    setSearchError('')
    setKeyword('')
    setOpenPlaylist(null)
    setPlaylistSongs([])
    setPlaylistError('')
  }, [open])

  /** 平台是否已登录（决定「我的歌单」是否可拉）。 */
  const platformLoggedIn = useCallback((target: MusicPlatform): boolean => {
    if (target === 'apple') return getAppleAuthState().loggedIn
    const key = PLATFORM_KEY[target]
    return Boolean(key && localStorage.getItem(key))
  }, [])

  // 切到歌单页签时拉一次歌单列表
  useEffect(() => {
    if (!open || tab !== 'playlists') return
    if (!platformLoggedIn(platform)) {
      setPlaylists([])
      return
    }
    const controller = new AbortController()
    abortRef.current = controller
    setPlaylistsLoading(true)
    const load = async () => {
      try {
        if (platform === 'apple') {
          const data = await getAppleLibraryPlaylists(100)
          if (controller.signal.aborted) return
          // 喜爱歌曲固定首位（Apple 的「我喜欢」走 APPLE_FAVORITES_ID 专用入口），
          // 资料库歌曲固定末位；中间是用户资料库歌单
          const items: PlaylistItem[] = [
            { id: APPLE_FAVORITES_ID, name: '喜爱歌曲', coverImgUrl: '', trackCount: 0, platform: 'apple', isLike: true },
            ...data.map(p => ({ id: p.id, name: p.name, coverImgUrl: p.artworkUrl || '', trackCount: p.trackCount || 0, platform: 'apple' as const })),
            { id: APPLE_LIBRARY_ID, name: '资料库歌曲', coverImgUrl: '', trackCount: 0, platform: 'apple' },
          ]
          setPlaylists(items)
        } else {
          const userId = localStorage.getItem(PLATFORM_KEY[platform] || '') || ''
          const data = await getUserPlaylists(platform, userId)
          if (controller.signal.aborted) return
          setPlaylists((Array.isArray(data) ? data : []).map((p: any) => ({
            id: String(p.id),
            name: p.name || '未命名歌单',
            coverImgUrl: p.coverImgUrl || p.coverUrl || p.picUrl || '',
            trackCount: p.trackCount ?? p.tracksTotal ?? p.count ?? 0,
            platform,
          })))
        }
      } catch (error) {
        if (!controller.signal.aborted) console.warn('[学歌] 歌单列表加载失败:', error)
      } finally {
        if (!controller.signal.aborted) setPlaylistsLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [open, tab, platform, platformLoggedIn])

  const handleSearch = useCallback(async () => {
    const trimmed = keyword.trim()
    if (!trimmed) return
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setSearchError('')
    try {
      const result = await searchSongs(trimmed, 30, platform)
      if (controller.signal.aborted) return
      setSearchResults(result?.songs || [])
      if (!result?.songs?.length) setSearchError('没有找到相关歌曲，换个关键词试试')
    } catch (error) {
      if (!controller.signal.aborted) setSearchError(error instanceof Error ? error.message : '搜索失败，请重试')
    } finally {
      if (!controller.signal.aborted) setSearching(false)
    }
  }, [keyword, platform])

  const handleOpenPlaylist = useCallback(async (item: PlaylistItem) => {
    const controller = new AbortController()
    abortRef.current = controller
    setOpenPlaylist(item)
    setPlaylistSongs([])
    setPlaylistError('')
    setPlaylistLoading(true)
    try {
      if (item.platform === 'apple') {
        if (item.id === APPLE_FAVORITES_ID) {
          const { getAppleFavoriteSongs } = await import('../../services/appleCatalog')
          const tracks = await getAppleFavoriteSongs(500)
          if (controller.signal.aborted) return
          setPlaylistSongs(tracks.map(track => appleSongToSong(track)))
        } else if (item.id === APPLE_LIBRARY_ID) {
          const { getAppleLibrarySongs } = await import('../../services/appleCatalog')
          const tracks = await getAppleLibrarySongs(500)
          if (controller.signal.aborted) return
          setPlaylistSongs(tracks.map(track => appleLibraryTrackToSongSafe(track)))
        } else {
          const tracks = await getApplePlaylistTracks(item.id, 300)
          if (controller.signal.aborted) return
          setPlaylistSongs(tracks.map(track => appleSongToSong(track as any)))
        }
      } else if (item.platform === 'netease') {
        const cookie = getPlatformCookie('netease')
        // 走统一 API_BASE（用户改端口/远程后端时不会挂）
        const response = await fetch(`${getApiBase()}/netease/playlist/detail?id=${item.id}`, { signal: controller.signal, headers: cookieHeaders(cookie) })
        const data = await response.json()
        if (!response.ok || data.error) throw new Error(data.error || `加载失败 (${response.status})`)
        const tracks: any[] = Array.isArray(data?.playlist?.tracks) ? data.playlist.tracks : []
        if (controller.signal.aborted) return
        setPlaylistSongs(tracks.map((track: any) => ({
          id: track.id,
          name: track.name,
          artists: track.ar || track.artists || [],
          album: track.al || track.album || {},
          duration: track.dt || track.duration || 0,
          platform: 'netease' as const,
          vip: track.vip || track.fee === 1,
          fee: track.fee || 0,
        })))
      } else if (item.platform === 'qq') {
        const cookie = getPlatformCookie('qq')
        const response = await fetch(`${getApiBase()}/qq/playlist/detail?id=${item.id}`, { signal: controller.signal, headers: cookieHeaders(cookie) })
        if (!response.ok) throw new Error(`加载失败 (${response.status})`)
        const data = await response.json()
        if (controller.signal.aborted) return
        const songlist: any[] = Array.isArray(data?.songlist) ? data.songlist : []
        setPlaylistSongs(songlist.map((track: any) => ({
          id: track.songid || track.id,
          mid: track.songmid || track.mid,
          name: track.songname || track.name,
          artists: track.singer || [],
          album: {
            name: track.albumname || track.album?.name || '',
            picUrl: track.albumpic || (track.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg` : ''),
          },
          duration: Number(track.duration) || Number(track.interval || 0) * 1000,
          platform: 'qq' as const,
          vip: track.pay?.payplay === 1 || false,
        })))
      } else {
        // 汽水/酷狗/Spotify 走统一的 playlistService 详情
        const data = await getPlaylistDetail(item.id, item.platform)
        if (controller.signal.aborted) return
        setPlaylistSongs(Array.isArray(data?.tracks) ? data.tracks : [])
      }
    } catch (error) {
      if (!controller.signal.aborted) setPlaylistError(error instanceof Error ? error.message : '歌单加载失败，请重试')
    } finally {
      if (!controller.signal.aborted) setPlaylistLoading(false)
    }
  }, [])

  const queueSongs = useMemo(() => (open ? null : null), [open])

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[96] flex justify-end"
        style={{ background: 'rgba(4,5,10,0.55)', backdropFilter: 'blur(8px)' }}
        onClick={onClose}
        data-tv-scope
      >
        <motion.div
          initial={{ x: '100%' }}
          animate={{ x: 0 }}
          exit={{ x: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 300 }}
          onClick={(e) => e.stopPropagation()}
          className="flex h-full w-full max-w-xl flex-col border-l border-white/10"
          style={{ background: 'linear-gradient(180deg, #151226 0%, #0e0c18 100%)' }}
        >
          {/* 头部 */}
          <div className="border-b border-white/[0.07] px-6 pt-5 pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }} />
                <h3 className="text-lg font-bold text-white">选一首来学</h3>
              </div>
              <button onClick={onClose} className="rounded-xl p-2 hover:bg-white/10" aria-label="关闭">
                <X className="h-5 w-5 text-white/70" />
              </button>
            </div>
            {/* 页签 */}
            <div className="mt-3 flex items-center gap-1 rounded-xl p-1" style={{ background: 'rgba(255,255,255,0.06)' }}>
              {([
                { id: 'search' as const, label: '搜索', icon: Search },
                { id: 'playlists' as const, label: '我的歌单', icon: ListMusic },
                { id: 'queue' as const, label: '当前队列', icon: Music2 },
              ]).map(item => (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold"
                  style={tab === item.id
                    ? { background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)`, color: '#fff' }
                    : { color: 'rgba(255,255,255,0.55)' }}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              ))}
            </div>
            {/* 平台胶囊 */}
            {tab !== 'queue' && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {PICKER_PLATFORMS.map(item => (
                  <button
                    key={item.id}
                    onClick={() => { setPlatform(item.id); setOpenPlaylist(null); setPlaylistSongs([]); setSearchResults([]) }}
                    className="rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors"
                    style={platform === item.id
                      ? { background: ACCENT, color: '#fff' }
                      : { background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.55)' }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
            {/* 搜索框 */}
            {tab === 'search' && (
              <div className="mt-3 flex items-center gap-2">
                <div className="flex flex-1 items-center gap-2 rounded-xl px-3.5 py-2.5" style={{ background: 'rgba(255,255,255,0.07)' }}>
                  <Search className="h-4 w-4 text-white/40" />
                  <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch() }}
                    placeholder={`在${PICKER_PLATFORMS.find(p => p.id === platform)?.label || ''}搜索想学的歌…`}
                    className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                    autoFocus
                  />
                </div>
                <button
                  onClick={() => void handleSearch()}
                  disabled={searching || !keyword.trim()}
                  className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-40"
                  style={{ background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)` }}
                >
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : '搜索'}
                </button>
              </div>
            )}
          </div>

          {/* 内容区 */}
          <div className="singalong-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {tab === 'search' && (
              <>
                {searchError && <p className="px-2 py-6 text-center text-sm text-white/40">{searchError}</p>}
                {searchResults.map((song, index) => (
                  <SongRow key={`${song.platform}-${song.id}-${index}`} song={song} currentSong={currentSong} onPick={() => onPickSong(song)} />
                ))}
                {!searchResults.length && !searchError && !searching && (
                  <p className="px-2 py-10 text-center text-sm text-white/35">输入歌名，搜到就能直接开始学</p>
                )}
              </>
            )}

            {tab === 'playlists' && !openPlaylist && (
              <>
                {!platformLoggedIn(platform) && (
                  <p className="px-2 py-10 text-center text-sm text-white/40">这个平台还没有登录，先去登录页登录，或用搜索选歌</p>
                )}
                {playlistsLoading && (
                  <div className="flex items-center justify-center py-10 text-white/40">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2.5">
                  {playlists.map((item) => (
                    <button
                      key={`${item.platform}-${item.id}`}
                      onClick={() => void handleOpenPlaylist(item)}
                      className="flex items-center gap-3 rounded-2xl p-2.5 text-left transition-colors hover:bg-white/[0.06]"
                    >
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl" style={{ background: 'rgba(255,255,255,0.08)' }}>
                        {item.coverImgUrl
                          ? <img src={getProxiedImageUrl(item.coverImgUrl, 100)} alt="" className="h-full w-full object-cover" loading="lazy" />
                          : <div className="flex h-full w-full items-center justify-center"><ListMusic className="h-4 w-4 text-white/30" /></div>}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-white/90">{item.name}</p>
                        <p className="text-[11px] text-white/35">{item.trackCount > 0 ? `${item.trackCount} 首` : ' '}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}

            {tab === 'playlists' && openPlaylist && (
              <>
                <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center gap-2 px-4 py-2" style={{ background: 'linear-gradient(180deg, #151226 60%, transparent)' }}>
                  <button
                    onClick={() => { setOpenPlaylist(null); setPlaylistSongs([]); setPlaylistError('') }}
                    className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-white/70 hover:bg-white/10"
                  >
                    ← 歌单列表
                  </button>
                  <p className="min-w-0 flex-1 truncate text-sm font-bold text-white">{openPlaylist.name}</p>
                </div>
                {playlistLoading && (
                  <div className="flex items-center justify-center py-10 text-white/40">
                    <Loader2 className="h-6 w-6 animate-spin" />
                  </div>
                )}
                {playlistError && <p className="px-2 py-6 text-center text-sm text-white/40">{playlistError}</p>}
                {playlistSongs.map((song, index) => (
                  <SongRow key={`${song.platform}-${song.id}-${index}`} song={song} currentSong={currentSong} onPick={() => onPickSong(song, playlistSongs)} />
                ))}
                {!playlistLoading && !playlistSongs.length && !playlistError && (
                  <p className="px-2 py-10 text-center text-sm text-white/35">这个歌单暂时没有曲目</p>
                )}
              </>
            )}

            {tab === 'queue' && <QueueTab currentSong={currentSong} onPickSong={onPickSong} />}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

function SongRow({ song, currentSong, onPick }: { song: Song; currentSong: Song | null; onPick: () => void }) {
  const isCurrent = currentSong && song.name === currentSong.name
    && (song.id === currentSong.id || song.mid === currentSong.mid)
  return (
    <button
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-2xl p-2.5 text-left transition-colors hover:bg-white/[0.06] ${isCurrent ? 'bg-white/[0.05]' : ''}`}
    >
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-xl" style={{ background: 'rgba(255,255,255,0.08)' }}>
        {song.album?.picUrl
          ? <img src={getProxiedImageUrl(song.album.picUrl, 100)} alt="" className="h-full w-full object-cover" loading="lazy" />
          : <div className="flex h-full w-full items-center justify-center"><Music2 className="h-4 w-4 text-white/30" /></div>}
      </div>
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm font-semibold ${isCurrent ? 'text-[#c4b5fd]' : 'text-white/90'}`}>
          {song.name}
          {song.vip && <span className="ml-1.5 rounded bg-amber-400/20 px-1 py-0.5 text-[9px] font-bold text-amber-300">VIP</span>}
        </p>
        <p className="truncate text-[11px] text-white/40">
          {(song.artists || []).map((artist: { name: string }) => artist.name).filter(Boolean).join(' / ') || '未知艺人'}
        </p>
      </div>
      <span className="shrink-0 rounded-full p-2 text-white/45 opacity-0 transition-opacity group-hover:opacity-100" title="选这首开练">
        <Play className="h-4 w-4" />
      </span>
    </button>
  )
}

/** 当前队列页签：读 localStorage 不可行（队列在 App 内存），由 App 的 queueSongs prop 提供——
 *  这里直接复用 App 已注入的 playlist 经由 currentSong 同源；为避免再开一个 prop 通道，
 *  队列页签读取父视图在 onPickSong 里传 songs 的同一 playlist（通过 window 桥暴露的最小快照）。 */
function QueueTab({ currentSong, onPickSong }: { currentSong: Song | null; onPickSong: (song: Song, songs?: Song[]) => void }) {
  const snapshot = useQueueSnapshot()
  if (!snapshot.length) {
    return <p className="px-2 py-10 text-center text-sm text-white/35">当前队列为空：先播点什么，或用搜索/歌单选歌</p>
  }
  return (
    <>
      {snapshot.map((song, index) => (
        <SongRow key={`${song.platform}-${song.id}-${index}`} song={song} currentSong={currentSong} onPick={() => onPickSong(song, snapshot)} />
      ))}
    </>
  )
}

/** App 注入的队列快照（见 singalongQueueBridge）。 */
function useQueueSnapshot(): Song[] {
  const [, force] = useState(0)
  useEffect(() => {
    const handler = () => force(value => value + 1)
    window.addEventListener('waveforge:singalong-queue', handler)
    return () => window.removeEventListener('waveforge:singalong-queue', handler)
  }, [])
  return getSINGALONG_QUEUE_SNAPSHOT()
}

/* ------------------------------ 队列快照桥（App 写、抽屉读） ------------------------------ */

let SINGALONG_QUEUE_SNAPSHOT: Song[] = []

export function publishSingAlongQueue(songs: Song[]) {
  SINGALONG_QUEUE_SNAPSHOT = songs
  window.dispatchEvent(new Event('waveforge:singalong-queue'))
}

function getSINGALONG_QUEUE_SNAPSHOT(): Song[] {
  return SINGALONG_QUEUE_SNAPSHOT
}

/** Apple 资料库曲目 → Song（延迟加载场景下的安全包装）。 */
function appleLibraryTrackToSongSafe(track: any): Song {
  // appleCatalog 的 appleLibraryTrackToSong 是同步导出；动态 import 场景直接复用
  // 这里手工兜底转换，避免类型循环依赖问题。
  if (track && typeof track === 'object' && 'name' in track && 'album' in track) return track as Song
  return {
    id: 0,
    name: track?.name || track?.title || '未知曲目',
    artists: [{ name: track?.artistName || '' }],
    album: { name: track?.albumName || '', picUrl: (track?.artworkUrl || '').replace('/100x100', '/300x300') },
    duration: Number(track?.durationMs || 0),
    platform: 'apple',
    appleId: track?.id ? String(track.id) : undefined,
    appleLibraryId: track?.id ? String(track.id) : undefined,
  }
}
