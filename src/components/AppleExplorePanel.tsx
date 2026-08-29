/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 专属探索面板（1:1 复刻 music.apple.com 的 主页 / 新发现 / 广播 / 资料库）
 *
 * - 主页：listen-now 个性化组（最近播放 / 专属推荐 / 口味组…），首项为 powerswoosh 大卡
 * - 新发现：编辑徽章卡网格（designBadge：推荐歌单/新专辑/新单曲…）+ 宽幅横幅 + 歌曲网格 + 排行榜
 * - 广播：推荐单集宽幅大卡 + 新近内容/热门电台/风格电台方卡网格 + 电台主持人节目卡
 * - 资料库：最近添加 / 艺人 / 专辑 / 歌曲 / 专属推荐
 *
 * 动作接线：
 * - 歌曲：点击播放（统一链路：AM 原生 → 网易云/QQ 载体回退）；♥ 喜欢；「…」右键菜单
 * - 歌单：点击打开详情（曲目可播）；＋ 收藏歌单；hover 播放动态封面（editorialVideo）
 * - 电台：点击站内直播播放（/v1/play/assets 取流 + HLS + Widevine EME）；
 *   封面 hover 显示「详情」按钮 → 电台详情抽屉（动态封面 / 描述 / 加入资料库 / 浏览器打开）
 *
 * 地区：固定使用账号商店（个性化内容绑定账号 storefront），无地区切换。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  ChevronRight, Compass, Disc3, ExternalLink, Heart, Info, LayoutGrid, Library, ListMusic, Loader2, LogIn, MoreHorizontal, Play, Plus, Radio, Sparkles, Trophy, UserRound, X,
} from 'lucide-react'
import type { SongSelectHandler } from '../types/playbackNavigation'
import type { Song } from '../services/musicApi'
import { resolveAppleRadioStream, type AppleNativeStream } from '../services/applePlayback'
import {
  addAppleMusicVideoToLibrary,
  addApplePlaylistToLibrary,
  addAppleAlbumToLibrary,
  addAppleSongToLibrary,
  addAppleStationToLibrary,
  appleStationToSong,
  appleWebItemToSong,
  fetchAppleBrowsePage,
  fetchAppleChartsPage,
  fetchAppleHomePage,
  fetchAppleLibraryPage,
  fetchApplePlaylistMotion,
  fetchApplePlaylistTracksForPlay,
  fetchApplePostDetail,
  fetchAppleRadioPage,
  fetchAppleRoomPage,
  fetchAppleStationDetail,
  fetchLibraryAlbumTracksForPlay,
  fetchLibraryArtistAlbumsForDrawer,
  fetchLibraryPlaylistTracksForPlay,
  setAppleFavorite,
  type ApplePostDetail,
  type AppleWebItem,
  type AppleWebPage,
  type AppleWebSection,
} from '../services/appleWebService'
import type { AppleLibraryAlbum } from '../services/appleCatalog'
import AppleSearchBrowse from './AppleSearchBrowse'
import AppleVideoModal from './AppleVideoModal'

// ─────────────────────────── 动态封面 ───────────────────────────

/** 动态封面（web powerswoosh 同款）：HLS 流 → hls.js 播放；失败/无则静态帧/静态图 */
function DynamicCover({ item, className, iconClassName }: { item: AppleWebItem; className?: string; iconClassName?: string }) {
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const motionHls = item.motionArtworkUrl
  useEffect(() => {
    if (!motionHls || videoFailed) return
    let hls: { destroy: () => void } | null = null
    let cancelled = false
    ;(async () => {
      try {
        const { default: Hls } = await import('hls.js')
        if (cancelled || !videoRef.current) return
        if (!Hls.isSupported()) { setVideoFailed(true); return }
        const inst = new Hls({ autoStartLoad: true, capLevelToPlayerSize: true, maxBufferLength: 12, backBufferLength: 0 })
        hls = inst
        inst.loadSource(motionHls)
        inst.attachMedia(videoRef.current)
        inst.on(Hls.Events.MANIFEST_PARSED, () => {
          if (cancelled) return
          void videoRef.current?.play().catch(() => undefined)
        })
        inst.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal && !cancelled) setVideoFailed(true)
        })
      } catch {
        if (!cancelled) setVideoFailed(true)
      }
    })()
    return () => {
      cancelled = true
      try { hls?.destroy() } catch { /* 忽略 */ }
    }
  }, [motionHls, videoFailed])

  if (motionHls && !videoFailed) {
    return (
      <video
        ref={videoRef}
        poster={item.motionPosterUrl || item.artworkUrl || undefined}
        muted
        loop
        playsInline
        preload="metadata"
        className={className}
      />
    )
  }
  const staticSrc = item.motionPosterUrl || item.artworkUrl || item.heroArtworkUrl
  if (staticSrc) {
    return <img src={staticSrc} alt={item.name} loading="lazy" className={className} />
  }
  return (
    <div className={`${className} flex items-center justify-center bg-white/[0.06]`}>
      <MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} />
    </div>
  )
}

/** 歌单动态封面缓存（模块级：同页多卡共享，切 tab 不重复请求） */
const motionCache = new Map<string, { video: string; poster?: string } | null>()
const motionPending = new Map<string, Promise<{ video: string; poster?: string } | null>>()

function loadPlaylistMotion(playlistId: string, storefront: string): Promise<{ video: string; poster?: string } | null> {
  if (motionCache.has(playlistId)) return Promise.resolve(motionCache.get(playlistId) ?? null)
  const pending = motionPending.get(playlistId)
  if (pending) return pending
  const task = fetchApplePlaylistMotion(playlistId, storefront)
    .then(result => {
      motionCache.set(playlistId, result)
      motionPending.delete(playlistId)
      return result
    })
    .catch(() => {
      motionCache.set(playlistId, null)
      motionPending.delete(playlistId)
      return null
    })
  motionPending.set(playlistId, task)
  return task
}

/**
 * 歌单卡封面：静态图打底 + hover 时拉取 editorialVideo 动态封面并播放（web 同款交互）。
 * 鼠标移出暂停（不销毁，再次 hover 直接续播）。
 */
function MotionPlaylistCover({ item, storefront, className, iconClassName }: {
  item: AppleWebItem
  storefront: string
  className?: string
  iconClassName?: string
}) {
  const [motion, setMotion] = useState<{ video: string; poster?: string } | null | undefined>(
    () => (motionCache.has(item.playId) ? motionCache.get(item.playId) ?? null : undefined),
  )
  const [videoFailed, setVideoFailed] = useState(false)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<{ destroy: () => void } | null>(null)

  const start = useCallback(async () => {
    if (motion === null || videoFailed) return
    let videoUrl = motion?.video
    if (!videoUrl) {
      const loaded = await loadPlaylistMotion(item.playId, storefront)
      setMotion(loaded)
      if (!loaded) return
      videoUrl = loaded.video
    }
    const video = videoRef.current
    if (!video) return
    if (!hlsRef.current) {
      try {
        const { default: Hls } = await import('hls.js')
        if (!Hls.isSupported()) { setVideoFailed(true); return }
        const inst = new Hls({ autoStartLoad: false, capLevelToPlayerSize: true, maxBufferLength: 10, backBufferLength: 0 })
        hlsRef.current = inst
        inst.on(Hls.Events.MANIFEST_PARSED, () => { void videoRef.current?.play().catch(() => undefined) })
        inst.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean }) => {
          if (data?.fatal) setVideoFailed(true)
        })
        inst.loadSource(videoUrl)
        inst.attachMedia(video)
      } catch {
        setVideoFailed(true)
      }
    } else {
      void video.play().catch(() => undefined)
    }
  }, [motion, videoFailed, item.playId, storefront])

  const pause = useCallback(() => {
    videoRef.current?.pause()
  }, [])

  useEffect(() => () => {
    try { hlsRef.current?.destroy() } catch { /* 忽略 */ }
  }, [])

  const showVideo = motion !== null && motion !== undefined && !videoFailed
  return (
    <div
      className={`relative overflow-hidden ${className || ''}`}
      onMouseEnter={() => { void start() }}
      onMouseLeave={pause}
    >
      <img
        src={motion?.poster || item.artworkUrl || ''}
        alt={item.name}
        loading="lazy"
        className="h-full w-full object-cover"
      />
      {showVideo && (
        <video
          ref={videoRef}
          muted
          loop
          playsInline
          preload="none"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {!item.artworkUrl && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/[0.06]">
          <MusicGlyph className={iconClassName || 'h-7 w-7 opacity-40'} />
        </div>
      )}
    </div>
  )
}

// ─────────────────────────── 面板 ───────────────────────────

type AmTab = 'home' | 'browse' | 'radio' | 'categories' | 'charts' | 'library'

const TABS: Array<{ id: AmTab; label: string; icon: typeof Sparkles }> = [
  { id: 'home', label: '主页', icon: Sparkles },
  { id: 'browse', label: '新发现', icon: Compass },
  { id: 'radio', label: '广播', icon: Radio },
  { id: 'categories', label: '分类', icon: LayoutGrid },
  { id: 'charts', label: '排行榜', icon: Trophy },
  { id: 'library', label: '资料库', icon: Library },
]

interface AppleExplorePanelProps {
  appleLoggedIn: boolean
  appleUsername: string
  appleAvatar?: string
  /** 账号 storefront（cn/us/hk/tw…），缺省 'cn' */
  defaultStorefront?: string
  accentColor?: string
  accentRgb?: string
  playerTheme?: 'light' | 'dark'
  onSongSelect: SongSelectHandler
  onLoginClick: () => void
  onOpenAlbum?: (albumId: string, platform: 'apple') => void
  /** 打开探索页现成歌单详情面板（PlaylistDetailPanel） */
  onOpenPlaylistPanel?: (playlist: { id: string; name: string; coverUrl?: string; creator?: string; trackCount?: number; description?: string; platform: 'apple' }) => void
  /** 打开现成艺人详情（ArtistDetailModal） */
  onOpenArtistPanel?: (artistId: string, platform: 'apple') => void
  /** 歌曲「…」菜单（复用探索页 SongContextMenu） */
  onSongContextMenu?: (event: React.MouseEvent, song: Song, songs: Song[]) => void
  /** 探索页「刷新」按钮信号（变化时强制重载当前页签；AM 无「换一批」，刷新入口上移到探索页顶栏） */
  refreshSignal?: number
}

const PAGE_FETCHERS: Record<Exclude<AmTab, 'categories'>, (storefront: string) => Promise<AppleWebPage>> = {
  home: fetchAppleHomePage,
  browse: fetchAppleBrowsePage,
  radio: fetchAppleRadioPage,
  charts: fetchAppleChartsPage,
  library: fetchAppleLibraryPage,
}

/** 可作为歌曲播放的类型（电台/艺人/视频不可直接播放） */
const isPlayableItem = (item: AppleWebItem) =>
  Boolean(item.playId) && !['stations', 'artists', 'music-videos', 'uploaded-videos'].includes(item.type)

/** Apple audioTraits → 列表卡音质徽标（web 歌曲行同款；与歌曲详情保持一致） */
function songTraitLabel(item: AppleWebItem): string {
  const traits = item.audioTraits || []
  if (traits.includes('spatial')) return '空间音频'
  if (traits.includes('atmos')) return '杜比全景声'
  if (traits.includes('lossless') || traits.includes('lossless-alac') || traits.includes('hi-res-lossless')) return '无损'
  return ''
}

export function AppleExplorePanel({
  appleLoggedIn,
  appleUsername,
  defaultStorefront,
  accentColor = '#fa2d48',
  playerTheme = 'dark',
  onSongSelect,
  onLoginClick,
  onOpenAlbum,
  onOpenPlaylistPanel,
  onOpenArtistPanel,
  onSongContextMenu,
  refreshSignal,
}: AppleExplorePanelProps) {
  const storefront = defaultStorefront || 'cn'
  const [tab, setTab] = useState<AmTab>('home')
  const [pages, setPages] = useState<Partial<Record<AmTab, AppleWebPage>>>({})
  /** 分类页重挂载信号（刷新用） */
  const [categoriesVersion, setCategoriesVersion] = useState(0)
  // 注意：初始必须全 false。loadTab 有「loading[target] 为 true 则跳过」的防重入保护，
  // 若 home 初始为 true，挂载时的 loadTab('home') 会直接 return，主页永远卡在骨架屏。
  const [loading, setLoading] = useState<Record<AmTab, boolean>>({ home: false, browse: false, radio: false, categories: false, charts: false, library: false })
  const [errors, setErrors] = useState<Partial<Record<AmTab, string>>>({})
  const [favorited, setFavorited] = useState<Set<string>>(() => new Set())
  const [savedPlaylists, setSavedPlaylists] = useState<Set<string>>(() => new Set())
  const [playlistDetail, setPlaylistDetail] = useState<{ playlist: AppleWebItem; tracks: Song[]; loadingTracks: boolean } | null>(null)
  const [albumDrawer, setAlbumDrawer] = useState<{ album: AppleWebItem; tracks: Song[]; loadingTracks: boolean } | null>(null)
  const [artistDrawer, setArtistDrawer] = useState<{ artist: AppleWebItem; albums: AppleWebItem[]; loading: boolean } | null>(null)
  const [stationDetail, setStationDetail] = useState<{ station: AppleWebItem; loading: boolean } | null>(null)
  /** 排行榜抽屉（歌曲/专辑榜：点榜单卡打开完整排名列表） */
  const [chartDetail, setChartDetail] = useState<AppleWebSection | null>(null)
  /** 正在取流的电台 id（防连点重复请求） */
  const playingStationsRef = useRef<Set<string>>(new Set())
  /** 音乐视频播放弹窗（站内 webPlayback + HLS + Widevine） */
  const [videoItem, setVideoItem] = useState<AppleWebItem | null>(null)
  /** 帖子详情弹窗（艺人分享 /post/…） */
  const [postDetail, setPostDetail] = useState<{ item: AppleWebItem; detail: ApplePostDetail | null; loading: boolean } | null>(null)
  /** 探索更多 room 页（按风格浏览/年代之声/…；/room/{id} 编辑树） */
  const [roomDetail, setRoomDetail] = useState<{ id: string; name: string; page: AppleWebPage | null; loading: boolean } | null>(null)

  const isDark = playerTheme === 'dark'
  const cardBg = isDark ? 'bg-white/[0.05]' : 'bg-black/[0.04]'
  const cardBorder = isDark ? 'border-white/[0.09]' : 'border-black/[0.08]'

  const loadTab = useCallback(async (target: Exclude<AmTab, 'categories'>, force = false) => {
    if (!force && (pages[target] || loading[target])) return
    setLoading(prev => ({ ...prev, [target]: true }))
    setErrors(prev => ({ ...prev, [target]: undefined }))
    try {
      const page = await PAGE_FETCHERS[target](storefront)
      setPages(prev => ({ ...prev, [target]: page }))
    } catch (error) {
      setErrors(prev => ({ ...prev, [target]: error instanceof Error ? error.message : '加载失败' }))
    } finally {
      setLoading(prev => ({ ...prev, [target]: false }))
    }
  }, [pages, loading, storefront])

  useEffect(() => {
    void loadTab('home')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (tab !== 'home' && tab !== 'categories') void loadTab(tab)
  }, [tab, loadTab])

  // 探索页顶栏「刷新」按钮（AM 无「换一批」）：信号变化时强制重载当前页签
  const refreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (refreshSignal === undefined || refreshSignal === refreshSignalRef.current) return
    refreshSignalRef.current = refreshSignal
    if (tab === 'categories') {
      // 分类页：重挂载 AppleSearchBrowse 触发重新拉取
      setCategoriesVersion(v => v + 1)
    } else {
      void loadTab(tab, true)
    }
  }, [refreshSignal, tab, loadTab])

  const currentPage = pages[tab]
  const currentLoading = loading[tab]
  const currentError = errors[tab]

  // ── 动作 ──

  const playItem = useCallback((item: AppleWebItem) => {
    if (!isPlayableItem(item)) return
    const song = appleWebItemToSong(item, storefront)
    void onSongSelect(song)
  }, [onSongSelect, storefront])

  const playItemWithQueue = useCallback((item: AppleWebItem, items: AppleWebItem[]) => {
    if (!isPlayableItem(item)) return
    const songs = items
      .filter(entry => isPlayableItem(entry))
      .map(entry => appleWebItemToSong(entry, storefront))
    if (songs.length === 0) return
    void onSongSelect(appleWebItemToSong(item, storefront), songs)
  }, [onSongSelect, storefront])

  const openSongMenu = useCallback((event: React.MouseEvent, item: AppleWebItem, items: AppleWebItem[]) => {
    if (!onSongContextMenu || !item.playId || item.type !== 'songs') return
    const songs = items
      .filter(entry => entry.playId && entry.type === 'songs')
      .map(entry => appleWebItemToSong(entry, storefront))
    onSongContextMenu(event, appleWebItemToSong(item, storefront), songs.length > 0 ? songs : [appleWebItemToSong(item, storefront)])
  }, [onSongContextMenu, storefront])

  const toggleFavorite = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn || !item.playId) return
    const next = !favorited.has(item.playId)
    const ok = await setAppleFavorite('songs', item.playId, next)
    if (ok) {
      setFavorited(prev => {
        const clone = new Set(prev)
        if (next) clone.add(item.playId)
        else clone.delete(item.playId)
        return clone
      })
    }
  }, [appleLoggedIn, favorited])

  const openPlaylist = useCallback(async (item: AppleWebItem) => {
    if (!item.playId) return
    setPlaylistDetail({ playlist: item, tracks: [], loadingTracks: true })
    // 库内歌单（l./p. id）走 me 接口取曲目（含 catalog 关联可播）；目录歌单走 catalog
    const tracks = item.isLibrary
      ? await fetchLibraryPlaylistTracksForPlay(item.playId).catch(() => [])
      : await fetchApplePlaylistTracksForPlay(item.playId, storefront).catch(() => [])
    setPlaylistDetail(prev => prev && prev.playlist.id === item.id
      ? { playlist: prev.playlist, tracks, loadingTracks: false }
      : prev)
  }, [storefront])

  const openPlaylistPanel = useCallback((item: AppleWebItem) => {
    // 库内歌单：目录接口取不到曲目，走本面板抽屉（me 接口）
    if (item.isLibrary) {
      void openPlaylist(item)
      return
    }
    if (onOpenPlaylistPanel) {
      onOpenPlaylistPanel({
        id: item.playId || item.id,
        name: item.name,
        coverUrl: item.artworkUrl,
        creator: item.curatorName,
        trackCount: item.trackCount,
        description: item.description,
        platform: 'apple',
      })
    } else {
      void openPlaylist(item)
    }
  }, [onOpenPlaylistPanel, openPlaylist])

  /** 库专辑 → 曲目抽屉（/v1/me/library/albums/{id}/tracks） */
  const openAlbumDrawer = useCallback(async (item: AppleWebItem) => {
    if (!item.playId) return
    setAlbumDrawer({ album: item, tracks: [], loadingTracks: true })
    const tracks = await fetchLibraryAlbumTracksForPlay(item.playId).catch(() => [])
    setAlbumDrawer(prev => prev && prev.album.id === item.id
      ? { album: prev.album, tracks, loadingTracks: false }
      : prev)
  }, [])

  /** 库艺人 → 专辑列表抽屉（/v1/me/library/artists/{id}/albums） */
  const openArtistDrawer = useCallback(async (item: AppleWebItem) => {
    if (!item.playId) return
    setArtistDrawer({ artist: item, albums: [], loading: true })
    const albums = await fetchLibraryArtistAlbumsForDrawer(item.playId).catch(() => [])
    const albumItems: AppleWebItem[] = albums.map((album: AppleLibraryAlbum) => ({
      id: album.id,
      playId: album.id,
      type: 'albums',
      isLibrary: true,
      name: album.name,
      subtitle: album.artistName,
      artworkUrl: album.artworkUrl,
      artistName: album.artistName,
      releaseDate: album.releaseDate,
      trackCount: album.trackCount,
    }))
    setArtistDrawer(prev => prev && prev.artist.id === item.id
      ? { artist: prev.artist, albums: albumItems, loading: false }
      : prev)
  }, [])

  /** 电台 → 详情抽屉（/v1/catalog/{sf}/stations/{id} + 动态封面） */
  const openStation = useCallback(async (item: AppleWebItem) => {
    if (!item.playId) return
    setStationDetail({ station: item, loading: true })
    const detail = await fetchAppleStationDetail(item.playId, storefront).catch(() => null)
    setStationDetail(prev => prev && prev.station.id === item.id
      ? { station: detail || prev.station, loading: false }
      : prev)
  }, [storefront])

  /** 站内直播播放电台：/v1/play/assets 取流（Cider 同款）→ HLS + Widevine EME → 单曲队列 */
  const playStation = useCallback(async (item: AppleWebItem) => {
    if (!item.playId) return
    if (!appleLoggedIn) {
      onLoginClick()
      return
    }
    if (playingStationsRef.current.has(item.playId)) return
    playingStationsRef.current.add(item.playId)
    const notifyFail = (message: string) => {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message, type: 'error' } }))
    }
    try {
      // 编辑元素里的 station 常只带 id（无 playParams）→ 补拉详情拿 playParams
      let station: AppleWebItem | null = item.playParams?.id ? item : null
      if (!station) station = await fetchAppleStationDetail(item.playId, storefront).catch(() => null)
      if (!station?.playId) {
        notifyFail('电台详情获取失败，请稍后重试')
        return
      }
      // 个别电台 resource 自带 offers[0].hlsUrl（免 play/assets 直接可播）
      let stream: AppleNativeStream | null = null
      if (station.offersHlsUrl) {
        stream = {
          url: station.offersHlsUrl.replace(/^manifest:\/\//, 'https://'),
          masterUrl: station.offersHlsUrl,
          licenseAdamId: station.playParams?.id || station.playId,
          songId: station.playId,
          live: true,
        }
      } else {
        stream = await resolveAppleRadioStream(station.playId, station.playParams).catch(() => null)
      }
      if (!stream) {
        notifyFail('电台直播流获取失败（可能需要订阅 Apple Music 或登录态已过期）')
        return
      }
      // isLive=false 的点播单集按 VOD 处理（hls.js 可拿真实时长与进度）；
      // 直播/未标注一律按直播（否则滑动窗口时长会让进度条来回走）
      if (station.isLive === false) stream.live = false
      const song = appleStationToSong(station, stream, storefront)
      onSongSelect(song, [song])
    } finally {
      playingStationsRef.current.delete(item.playId)
    }
  }, [appleLoggedIn, onLoginClick, onSongSelect, storefront])

  /** 音乐视频：站内播放（webPlayback 取流 + HLS + Widevine，<video> 元素） */
  const playVideo = useCallback((item: AppleWebItem) => {
    if (!item.playId) {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '该视频暂不可播放', type: 'error' } }))
      return
    }
    setVideoItem(item)
  }, [])

  /** 帖子详情（艺人分享 /post/…）：尽力取详情，失败用卡片信息兜底 */
  const openPost = useCallback(async (item: AppleWebItem) => {
    if (!item.id) return
    setPostDetail({ item, detail: null, loading: true })
    const detail = await fetchApplePostDetail(item.id, storefront).catch(() => null)
    setPostDetail(prev => prev && prev.item.id === item.id
      ? { item: prev.item, detail: detail || prev.detail, loading: false }
      : prev)
  }, [storefront])

  /** 探索更多 room 页：/room/{id} 编辑树 → 复用整页分区渲染 */
  const openRoom = useCallback(async (item: AppleWebItem) => {
    const roomId = String(item.url || '').split('/').pop() || item.id
    if (!roomId) return
    setRoomDetail({ id: roomId, name: item.name || '探索', page: null, loading: true })
    const page = await fetchAppleRoomPage(roomId, storefront).catch(() => null)
    setRoomDetail(prev => prev && prev.id === roomId
      ? { ...prev, page: page || { sections: [], hero: null, personalized: false, sourceLabel: 'room 加载失败' }, loading: false }
      : prev)
  }, [storefront])

  /** 通用「加入资料库」（歌曲/专辑/视频；成功切换 + 态） */
  const saveToLibrary = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn || !item.playId) return
    const key = `lib:${item.type}:${item.playId}`
    const ok = item.type === 'songs'
      ? await addAppleSongToLibrary(item.playId)
      : item.type === 'albums'
        ? await addAppleAlbumToLibrary(item.playId)
        : item.type === 'music-videos'
          ? await addAppleMusicVideoToLibrary(item.playId)
          : false
    if (ok) {
      setSavedPlaylists(prev => new Set(prev).add(key))
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '已添加到资料库', type: 'success' } }))
    }
  }, [appleLoggedIn])

  const savePlaylist = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn || !item.playId) return
    const ok = item.type === 'playlists' ? await addApplePlaylistToLibrary(item.playId) : false
    if (ok) {
      setSavedPlaylists(prev => new Set(prev).add(item.playId))
    }
  }, [appleLoggedIn])

  const saveStation = useCallback(async (item: AppleWebItem) => {
    if (!appleLoggedIn || !item.playId) return
    const ok = await addAppleStationToLibrary(item.playId)
    if (ok) {
      setSavedPlaylists(prev => new Set(prev).add(`st:${item.playId}`))
    }
  }, [appleLoggedIn])

  const openExternal = useCallback((url?: string) => {
    if (!url) return
    const bridge = (window as any).electron
    if (bridge?.openExternal) void bridge.openExternal(url)
    else window.open(url, '_blank', 'noopener')
  }, [])

  // ── 卡片子组件 ──

  /** 新发现徽章卡（web /new 主视觉：大图 + 左上角 designBadge + 名称/策划人） */
  const FeaturedCard = ({ item, items }: { item: AppleWebItem; items: AppleWebItem[] }) => {
    const isPlaylist = item.type === 'playlists'
    return (
      <motion.div
        whileHover={{ y: -3 }}
        className="group min-w-0 cursor-pointer"
        onClick={() => {
          if (isPlaylist) openPlaylistPanel(item)
          else if (item.type === 'albums') onOpenAlbum ? onOpenAlbum(item.playId || item.id, 'apple') : void 0
          else if (item.type === 'stations') void playStation(item)
          else playItemWithQueue(item, items)
        }}
      >
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
          {isPlaylist ? (
            <MotionPlaylistCover item={item} storefront={storefront} className="aspect-[16/10] w-full" />
          ) : item.artworkUrl ? (
            <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-[16/10] w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
          ) : (
            <div className="flex aspect-[16/10] w-full items-center justify-center bg-white/[0.06]">
              <MusicGlyph className="h-8 w-8 opacity-40" />
            </div>
          )}
          {item.badge && (
            <span className="absolute left-3 top-3 z-10 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium text-white/90 backdrop-blur-md">
              {item.badge}
            </span>
          )}
          {/* 描述叠加层（web 卡片同款：底部渐变 + 编辑描述） */}
          {item.description && (
            <>
              <div className="absolute inset-x-0 bottom-0 h-2/3 bg-[linear-gradient(0deg,rgba(6,9,14,0.88)_0%,rgba(6,9,14,0.4)_55%,transparent_100%)]" />
              <p className="absolute inset-x-0 bottom-0 z-10 line-clamp-2 px-3.5 pb-3 text-xs leading-relaxed text-white/75">
                {item.description}
              </p>
            </>
          )}
          {/* hover 播放按钮 */}
          {item.playId && item.type !== 'artists' && (
            <span
              role="button"
              tabIndex={0}
              onClick={(event) => { event.stopPropagation(); if (item.type === 'stations') void playStation(item); else playItemWithQueue(item, items) }}
              className="absolute right-3 top-3 z-10 flex h-10 w-10 items-center justify-center rounded-full text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100"
              style={{ background: accentColor }}
              aria-label={`播放${item.name}`}
            >
              <Play className="h-4 w-4 fill-current" />
            </span>
          )}
        </div>
        <div className="mt-2 px-0.5">
          <p className="truncate text-sm font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 truncate text-xs text-white/40">{item.curatorName || item.artistName || item.subtitle || 'Apple Music'}</p>
        </div>
      </motion.div>
    )
  }

  /** 宽幅横幅（web [320] 编辑元素：4320×1080 大图 + 左上角徽章 + 底部标题/文案） */
  const BannerCard = ({ section, wide = false }: { section: AppleWebSection; wide?: boolean }) => {
    const item = section.items[0]
    return (
      <motion.div
        whileHover={{ y: -2 }}
        className={`group relative w-full cursor-pointer overflow-hidden rounded-2xl border border-white/[0.08] ${wide ? '' : 'min-h-[220px]'}`}
        onClick={() => {
          if (item) {
            if (item.type === 'stations') void playStation(item)
            else if (item.type === 'playlists') openPlaylistPanel(item)
            else if (item.type === 'albums') onOpenAlbum ? onOpenAlbum(item.playId || item.id, 'apple') : void 0
            else playItem(item)
          }
        }}
      >
        {section.bannerUrl ? (
          <img src={section.bannerUrl} alt={section.title} loading="lazy" className="absolute inset-0 h-full w-full object-cover transition duration-700 group-hover:scale-[1.02]" />
        ) : (
          <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(250,45,72,0.25),rgba(10,10,14,0.9))]" />
        )}
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.88)_5%,rgba(6,9,14,0.25)_55%,rgba(6,9,14,0.05)_100%)]" />
        <div className="relative flex min-h-[220px] flex-col justify-end p-5 md:p-7">
          {section.tag && (
            <p className="mb-2 line-clamp-1 text-xs font-medium text-white/60">{section.tag}</p>
          )}
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              {section.title && (
                <span className="mb-1.5 inline-block rounded-md bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white/85 backdrop-blur-md">
                  {section.title}
                </span>
              )}
              <h3 className="truncate text-xl font-semibold md:text-2xl">{item?.name || section.title}</h3>
              {item?.subtitle && <p className="mt-1 truncate text-sm text-white/55">{item.subtitle}</p>}
            </div>
            {item?.playId && item.type !== 'artists' && (
              <span
                role="button"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation()
                  if (item.type === 'stations') void playStation(item)
                  else if (item.type === 'playlists') openPlaylistPanel(item)
                  else playItem(item)
                }}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100"
                style={{ background: accentColor }}
                aria-label={`播放${item?.name || section.title}`}
              >
                <Play className="h-4 w-4 fill-current" />
              </span>
            )}
          </div>
        </div>
      </motion.div>
    )
  }

  /** 电台方卡（web 新近内容/热门电台：方图 + 名称 + 「…」） */
  const StationCard = ({ item }: { item: AppleWebItem }) => {
    const isSaved = savedPlaylists.has(`st:${item.playId}`)
    return (
      <motion.div
        whileHover={{ y: -3 }}
        className="group min-w-0 cursor-pointer"
        onClick={() => void playStation(item)}
      >
        <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
          {item.artworkUrl ? (
            <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
          ) : (
            <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
              <Radio className="h-7 w-7 opacity-40" />
            </div>
          )}
          {item.isLive && (
            <span className="absolute left-2.5 top-2.5 rounded-md bg-[#fa2d48] px-1.5 py-0.5 text-[10px] font-semibold text-white">直播中</span>
          )}
          <button
            type="button"
            aria-label={isSaved ? '已加入资料库' : '加入资料库'}
            onClick={(event) => { event.stopPropagation(); void saveStation(item) }}
            className={`absolute right-2 top-2 z-20 flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-md transition ${
              isSaved ? 'bg-white/90 text-[#fa2d48]' : 'bg-black/40 text-white/75 opacity-0 group-hover:opacity-100'
            }`}
          >
            <Plus className={`h-4 w-4 ${isSaved ? 'rotate-45' : ''}`} />
          </button>
          {/* hover 播放按钮：点击即站内直播 */}
          <span
            role="button"
            tabIndex={0}
            aria-label={`播放${item.name}`}
            onClick={(event) => { event.stopPropagation(); void playStation(item) }}
            className="absolute inset-0 z-10 flex items-center justify-center opacity-0 transition group-hover:opacity-100"
          >
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full text-[#0a0f14] shadow-xl"
              style={{ background: accentColor }}
            >
              <Play className="h-5 w-5 fill-current" />
            </span>
          </span>
          {/* 详情按钮：电台详情抽屉（保存/浏览器打开） */}
          <button
            type="button"
            aria-label="电台详情"
            onClick={(event) => { event.stopPropagation(); void openStation(item) }}
            className="absolute bottom-2 right-2 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white/80 opacity-0 backdrop-blur-md transition hover:bg-black/65 group-hover:opacity-100"
          >
            <Info className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-2 px-0.5">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/40">{item.showName || 'Apple Music 电台'}</p>
        </div>
      </motion.div>
    )
  }

  /** 歌曲行（web 歌曲网格：封面 + 名称 + 艺人 + 「…」菜单） */
  const SongRow = ({ item, items, rank }: { item: AppleWebItem; items: AppleWebItem[]; rank?: number }) => {
    const isFav = favorited.has(item.playId)
    return (
      <div
        className="group flex min-w-0 cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/[0.05]"
        onClick={() => playItemWithQueue(item, items)}
        onContextMenu={(event) => openSongMenu(event, item, items)}
      >
        {typeof rank === 'number' ? (
          <span className={`w-6 shrink-0 text-center text-sm tabular-nums ${rank <= 3 ? 'font-semibold' : 'text-white/35'}`} style={rank <= 3 ? { color: accentColor } : undefined}>
            {rank}
          </span>
        ) : (
          <span className="w-6 shrink-0" />
        )}
        <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg">
          {item.artworkUrl ? (
            <img src={item.artworkUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/[0.06]">
              <MusicGlyph className="h-5 w-5 opacity-40" />
            </div>
          )}
          <span
            className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition group-hover:opacity-100"
            aria-hidden="true"
          >
            <Play className="h-4 w-4 fill-white text-white" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-white/40">
            {songTraitLabel(item) && (
              <span className="shrink-0 rounded border border-white/15 bg-white/[0.06] px-1 py-px text-[10px] font-medium leading-tight text-white/60">
                {songTraitLabel(item)}
              </span>
            )}
            <span className="truncate">{item.artistName || item.subtitle}</span>
          </p>
        </div>
        <button
          type="button"
          aria-label="添加到资料库"
          onClick={(event) => { event.stopPropagation(); void saveToLibrary(item) }}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
            savedPlaylists.has(`lib:songs:${item.playId}`) ? 'text-[#fa2d48]' : 'text-white/50 opacity-0 hover:bg-white/10 group-hover:opacity-100'
          }`}
        >
          <Plus className={`h-4 w-4 ${savedPlaylists.has(`lib:songs:${item.playId}`) ? 'rotate-45' : ''}`} />
        </button>
        <button
          type="button"
          aria-label="喜欢"
          onClick={(event) => { event.stopPropagation(); void toggleFavorite(item) }}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition ${
            isFav ? 'text-[#fa2d48]' : 'text-white/50 opacity-0 hover:bg-white/10 group-hover:opacity-100'
          }`}
        >
          <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />
        </button>
        <button
          type="button"
          aria-label="更多操作"
          onClick={(event) => openSongMenu(event, item, items)}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white/50 opacity-0 transition hover:bg-white/10 group-hover:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    )
  }

  /** 节目卡（web [394]：宽幅横幅 + 节目名） */
  const ShowCard = ({ item }: { item: AppleWebItem }) => (
    <motion.div
      whileHover={{ y: -3 }}
      className="group relative min-w-0 cursor-pointer overflow-hidden rounded-2xl border border-white/[0.08]"
      onClick={() => item.type === 'stations' ? void playStation(item) : openExternal(item.url)}
    >
      {item.bannerUrl ? (
        <img src={item.bannerUrl} alt={item.name} loading="lazy" className="aspect-[16/9] w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
      ) : (
        <div className="flex aspect-[16/9] w-full items-center justify-center bg-white/[0.06]">
          <Radio className="h-7 w-7 opacity-40" />
        </div>
      )}
      <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.85)_0%,rgba(6,9,14,0.15)_60%,transparent_100%)]" />
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 p-3.5">
        <p className="min-w-0 truncate text-sm font-semibold">{item.name}</p>
        <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/45 opacity-0 transition group-hover:opacity-100" />
      </div>
    </motion.div>
  )

  /** 主页横向行卡片（歌曲/歌单/专辑/艺人/电台） */
  const RowCard = ({ item, items }: { item: AppleWebItem; items: AppleWebItem[] }) => {
    const isFav = favorited.has(item.playId)
    const isSaved = savedPlaylists.has(item.playId)
    const isPlaylist = item.type === 'playlists'
    const isArtist = item.type === 'artists'
    const isStation = item.type === 'stations'
    return (
      <motion.div
        whileHover={{ y: -3 }}
        className={`group w-40 shrink-0 cursor-pointer rounded-2xl border ${cardBorder} ${cardBg} p-2`}
        onClick={() => {
          if (isPlaylist) openPlaylistPanel(item)
          else if (isArtist) onOpenArtistPanel ? onOpenArtistPanel(item.playId || item.id, 'apple') : void openArtistDrawer(item)
          else if (isStation) void playStation(item)
          else if (item.type === 'rooms') void openRoom(item)
          else if (item.type === 'albums') {
            // 库内专辑（l. 库 id）：iTunes Lookup 查不到，走 me 接口曲目抽屉
            if (item.isLibrary) void openAlbumDrawer(item)
            else onOpenAlbum ? onOpenAlbum(item.playId || item.id, 'apple') : void 0
          }
          else playItemWithQueue(item, items)
        }}
      >
        <div className="relative overflow-hidden rounded-xl">
          {isPlaylist ? (
            <MotionPlaylistCover item={item} storefront={storefront} className="aspect-square w-full" />
          ) : item.artworkUrl ? (
            <img src={item.artworkUrl} alt={item.name} loading="lazy" className={`w-full object-cover ${isArtist ? 'aspect-square rounded-full' : 'aspect-square'}`} />
          ) : (
            <div className={`flex aspect-square w-full items-center justify-center ${isDark ? 'bg-white/[0.07]' : 'bg-black/[0.06]'}`}>
              {isArtist ? <UserRound className="h-7 w-7 opacity-40" /> : isStation ? <Radio className="h-7 w-7 opacity-40" /> : <MusicGlyph className="h-7 w-7 opacity-40" />}
            </div>
          )}
          {isStation && item.isLive && (
            <span className="absolute left-2 top-2 rounded-md bg-[#fa2d48] px-1.5 py-0.5 text-[10px] font-semibold text-white">直播中</span>
          )}
          {!isArtist && !isStation && item.playId && (
            <button
              type="button"
              aria-label={isPlaylist ? '收藏歌单' : item.type === 'albums' ? '添加到资料库' : '喜欢'}
              onClick={(event) => {
                event.stopPropagation()
                if (isPlaylist) void savePlaylist(item)
                else if (item.type === 'albums') void saveToLibrary(item)
                else void toggleFavorite(item)
              }}
              className={`absolute right-1.5 top-1.5 flex h-8 w-8 items-center justify-center rounded-full backdrop-blur-md transition ${
                (isPlaylist ? isSaved : item.type === 'albums' ? savedPlaylists.has(`lib:albums:${item.playId}`) : isFav)
                  ? 'bg-white/90 text-[#fa2d48]'
                  : 'bg-black/35 text-white/72 opacity-0 group-hover:opacity-100'
              }`}
            >
              {isPlaylist
                ? <Plus className={`h-4 w-4 ${isSaved ? 'rotate-45' : ''}`} />
                : item.type === 'albums'
                  ? <Plus className={`h-4 w-4 ${savedPlaylists.has(`lib:albums:${item.playId}`) ? 'rotate-45' : ''}`} />
                  : <Heart className={`h-4 w-4 ${isFav ? 'fill-current' : ''}`} />}
            </button>
          )}
        </div>
        <div className="mt-2 px-1 pb-1">
          <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-white/45">{item.curatorName || item.artistName || item.showName || item.subtitle || 'Apple Music'}</p>
        </div>
      </motion.div>
    )
  }

  // ── 分区渲染 ──

  const renderSection = (section: AppleWebSection) => {
    switch (section.kind) {
      case 'featured-cards':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} />
            <div className="grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2 xl:grid-cols-3">
              {section.items.map(item => <FeaturedCard key={`${section.id}-${item.id}`} item={item} items={section.items} />)}
            </div>
          </section>
        )
      case 'banner':
        return (
          <section key={section.id}>
            <BannerCard section={section} />
          </section>
        )
      case 'show-cards':
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.items.map(item => <ShowCard key={`${section.id}-${item.id}`} item={item} />)}
            </div>
          </section>
        )
      case 'grid': {
        const firstType = section.items[0]?.type
        const isSongs = firstType === 'songs'
        const isStations = firstType === 'stations'
        const isVideos = firstType === 'music-videos' || firstType === 'uploaded-videos'
        const isPosts = firstType === 'posts'
        const isRooms = firstType === 'rooms'
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} />
            {isSongs ? (
              <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
                {section.items.slice(0, 30).map((item, index) => (
                  <SongRow key={`${section.id}-${item.id}`} item={item} items={section.items} />
                ))}
              </div>
            ) : isPosts ? (
              /* 艺人分享帖子（/post/…）：点开帖子详情弹窗 */
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  <motion.div
                    key={`${section.id}-${item.id}`}
                    whileHover={{ y: -3 }}
                    className="group min-w-0 cursor-pointer"
                    onClick={() => void openPost(item)}
                  >
                    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      {item.artworkUrl ? (
                        <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                          <UserRound className="h-7 w-7 opacity-40" />
                        </div>
                      )}
                      <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100">
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="line-clamp-2 text-[13px] font-medium leading-tight">{item.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/40">{item.artistName || item.subtitle || 'Apple Music'}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : isRooms ? (
              /* 探索更多（按风格/年代/心情/来自全球 /room/{id}）：点开 room 编辑页 */
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  <motion.div
                    key={`${section.id}-${item.id}`}
                    whileHover={{ y: -3 }}
                    className="group min-w-0 cursor-pointer"
                    onClick={() => void openRoom(item)}
                  >
                    <div className="relative flex aspect-square w-full items-center justify-center overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      {item.artworkUrl ? (
                        <img src={item.artworkUrl} alt={item.name} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <Compass className="h-8 w-8 opacity-35" />
                      )}
                      <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100">
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/40">探索</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : isVideos ? (
              /* 视频内容（艺人分享等）：方卡 + 站内播放 */
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  <motion.div
                    key={`${section.id}-${item.id}`}
                    whileHover={{ y: -3 }}
                    className="group min-w-0 cursor-pointer"
                    onClick={() => playVideo(item)}
                  >
                    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      {item.artworkUrl ? (
                        <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                          <MusicGlyph className="h-7 w-7 opacity-40" />
                        </div>
                      )}
                      <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100">
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/40">{item.artistName || item.subtitle || 'Apple Music'}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  isStations
                    ? <StationCard key={`${section.id}-${item.id}`} item={item} />
                    : <RowCard key={`${section.id}-${item.id}`} item={item} items={section.items} />
                ))}
              </div>
            )}
          </section>
        )
      }
      case 'chart': {
        const chartItemType = section.items[0]?.type
        // 歌曲/专辑榜：整榜一张卡（封面 + 榜名），点开抽屉看完整排名（web /new/top-charts 同款）
        if (chartItemType === 'songs' || chartItemType === 'albums') {
          const cover = section.items[0]?.artworkUrl
          const unit = chartItemType === 'songs' ? '首' : '张'
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle={`Top ${section.items.length} ${unit} · 点击查看完整榜单`} />
              <motion.button
                type="button"
                whileHover={{ y: -3 }}
                onClick={() => setChartDetail(section)}
                className="group flex w-full items-center gap-4 rounded-2xl border border-white/[0.08] bg-white/[0.04] p-3 text-left transition hover:bg-white/[0.07]"
              >
                <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-xl">
                  {cover ? (
                    <img src={cover} alt={section.title} loading="lazy" className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center bg-white/[0.06]">
                      <Trophy className="h-7 w-7 opacity-40" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-semibold">{section.title}</p>
                  <p className="mt-1 truncate text-xs text-white/40">
                    {section.items.slice(0, 3).map(item => item.name).join(' · ')}
                  </p>
                </div>
                <ChevronRight className="h-5 w-5 shrink-0 text-white/25 transition group-hover:text-white/60" />
              </motion.button>
            </section>
          )
        }
        // 地区榜（每周热门100/城市榜）：条目本身就是歌单 → 歌单卡网格，点开进歌单详情
        if (chartItemType === 'playlists') {
          return (
            <section key={section.id} className="space-y-3">
              <SectionTitle title={section.title} subtitle="各地区榜单 · 点击进入" />
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  <div key={`${section.id}-${item.id}`} className="group min-w-0 cursor-pointer" onClick={() => openPlaylistPanel(item)}>
                    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      {item.artworkUrl ? (
                        <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                          <ListMusic className="h-7 w-7 opacity-40" />
                        </div>
                      )}
                      <span className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100" style={{ background: accentColor }}>
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <div className="mt-2 px-0.5">
                      <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                      <p className="mt-0.5 truncate text-[11px] text-white/40">{item.curatorName || 'Apple Music 榜单'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        }
        // 视频榜：视频卡网格（站内播放）
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle="热门音乐视频" />
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {section.items.map(item => (
                <div key={`${section.id}-${item.id}`} className="group min-w-0 cursor-pointer" onClick={() => playVideo(item)}>
                  <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                    {item.artworkUrl ? (
                      <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                        <MusicGlyph className="h-7 w-7 opacity-40" />
                      </div>
                    )}
                    <span className="absolute bottom-3 right-3 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/85 opacity-0 backdrop-blur-md transition group-hover:opacity-100">
                      <Play className="h-4 w-4 fill-current" />
                    </span>
                  </div>
                  <div className="mt-2 px-0.5">
                    <p className="truncate text-[13px] font-medium leading-tight">{item.name}</p>
                    <p className="mt-0.5 truncate text-[11px] text-white/40">{item.artistName || item.subtitle || 'Apple Music'}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      }
      case 'curators':
        return null // 搜索落地页在 SearchPanel 渲染
      case 'row':
      default:
        return (
          <section key={section.id} className="space-y-3">
            <SectionTitle title={section.title} subtitle={section.subtitle} />
            <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
              {section.items.map(item => <RowCard key={`${section.id}-${item.id}`} item={item} items={section.items} />)}
              {section.items.length === 0 && (
                <div className="w-full rounded-2xl px-4 py-6 text-sm text-white/36">暂无内容</div>
              )}
            </div>
          </section>
        )
    }
  }

  const SectionTitle = ({ title, subtitle }: { title: string; subtitle?: string }) => (
    <div className="flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-lg font-semibold tracking-tight">{title}</h3>
        {subtitle && <p className="mt-0.5 truncate text-xs text-white/42">{subtitle}</p>}
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-white/25" />
    </div>
  )

  /**
   * 渲染整页分区：连续的 banner（如广播页「推荐单集」多张宽幅大卡）
   * 合并为 2 列网格（web /radio 同款并排布局），其余分区原样渲染。
   */
  const renderAllSections = (sections: AppleWebSection[]) => {
    const nodes: ReactNode[] = []
    let index = 0
    while (index < sections.length) {
      const section = sections[index]
      if (section.kind === 'banner') {
        const banners: AppleWebSection[] = []
        while (index < sections.length && sections[index].kind === 'banner') {
          banners.push(sections[index])
          index += 1
        }
        if (banners.length === 1) {
          nodes.push(renderSection(banners[0]))
        } else {
          nodes.push(
            <section key={`${banners[0].id}-banner-grid`} className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {banners.map(banner => <BannerCard key={banner.id} section={banner} />)}
            </section>,
          )
        }
      } else {
        nodes.push(renderSection(section))
        index += 1
      }
    }
    return nodes
  }

  const skeleton = (
    <div className="space-y-10">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="space-y-3">
          <div className={`h-5 w-44 rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'}`} />
          <div className="flex gap-3">
            {[0, 1, 2, 3, 4].map((card) => (
              <div key={card} className={`h-44 w-40 shrink-0 rounded-2xl ${cardBg} ${isDark ? 'bg-white/[0.05]' : 'bg-black/[0.04]'}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )

  // ── 歌单详情抽屉 ──
  const playlistDrawer = playlistDetail && (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setPlaylistDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-4">
            {playlistDetail.playlist.artworkUrl
              ? <img src={playlistDetail.playlist.artworkUrl} alt="" className="h-16 w-16 rounded-2xl object-cover" />
              : <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.07]"><ListMusic className="h-6 w-6 opacity-50" /></div>}
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{playlistDetail.playlist.name}</h3>
              <p className="mt-0.5 text-xs text-white/45">{playlistDetail.playlist.curatorName || 'Apple Music 编辑'} · {playlistDetail.tracks.length} 首</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setPlaylistDetail(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {renderTrackRows(playlistDetail.loadingTracks, playlistDetail.tracks)}
      </motion.div>
    </div>
  )

  /** 曲目列表行（歌单/专辑抽屉共用） */
  function renderTrackRows(loadingTracks: boolean, tracks: Song[]) {
    return (
      <div className="mt-4 max-h-[58vh] overflow-y-auto px-3 pb-6">
        {loadingTracks && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
            <Loader2 className="h-4 w-4 animate-spin" /> 正在加载曲目…
          </div>
        )}
        {!loadingTracks && tracks.length === 0 && (
          <div className="py-10 text-center text-sm text-white/40">没有加载到曲目</div>
        )}
        {tracks.map((song, index) => (
          <div
            key={`${song.appleId || song.id}-${index}`}
            className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.06]"
            onClick={() => void onSongSelect(song)}
          >
            <span className="w-5 text-center text-xs text-white/30">{index + 1}</span>
            {song.album?.picUrl
              ? <img src={song.album.picUrl} alt="" className="h-10 w-10 rounded-lg object-cover" />
              : <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/[0.07]"><MusicGlyph className="h-5 w-5 opacity-40" /></div>}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{song.name}</p>
              <p className="truncate text-xs text-white/45">{song.artists.map(artist => artist.name).join(' / ')}</p>
            </div>
            <button
              type="button"
              aria-label="播放"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 transition group-hover:opacity-100"
              onClick={(event) => { event.stopPropagation(); void onSongSelect(song) }}
            >
              <Play className="h-4 w-4 fill-current" />
            </button>
          </div>
        ))}
      </div>
    )
  }

  const albumDrawerEl = albumDrawer && (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setAlbumDrawer(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-4">
            {albumDrawer.album.artworkUrl
              ? <img src={albumDrawer.album.artworkUrl} alt="" className="h-16 w-16 rounded-2xl object-cover" />
              : <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.07]"><Disc3 className="h-6 w-6 opacity-50" /></div>}
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{albumDrawer.album.name}</h3>
              <p className="mt-0.5 text-xs text-white/45">{albumDrawer.album.artistName || '专辑'} · {albumDrawer.tracks.length} 首</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setAlbumDrawer(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {renderTrackRows(albumDrawer.loadingTracks, albumDrawer.tracks)}
      </motion.div>
    </div>
  )

  const artistDrawerEl = artistDrawer && (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setArtistDrawer(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-4">
            {artistDrawer.artist.artworkUrl
              ? <img src={artistDrawer.artist.artworkUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
              : <div className="flex h-16 w-16 items-center justify-center rounded-full bg-white/[0.07]"><UserRound className="h-7 w-7 opacity-50" /></div>}
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{artistDrawer.artist.name}</h3>
              <p className="mt-0.5 text-xs text-white/45">资料库专辑 {artistDrawer.albums.length} 张</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setArtistDrawer(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 max-h-[60vh] overflow-y-auto px-4 pb-6">
          {artistDrawer.loading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/45">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在加载专辑…
            </div>
          )}
          {!artistDrawer.loading && artistDrawer.albums.length === 0 && (
            <div className="py-10 text-center text-sm text-white/40">资料库中没有该艺人的专辑</div>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {artistDrawer.albums.map(album => (
              <motion.div
                key={album.id}
                whileHover={{ y: -2 }}
                onClick={() => void openAlbumDrawer(album)}
                className="group cursor-pointer rounded-2xl border border-white/[0.08] bg-white/[0.05] p-2"
              >
                {album.artworkUrl
                  ? <img src={album.artworkUrl} alt={album.name} loading="lazy" className="aspect-square w-full rounded-xl object-cover" />
                  : <div className="aspect-square w-full rounded-xl bg-white/[0.06] flex items-center justify-center"><Disc3 className="h-7 w-7 opacity-40" /></div>}
                <p className="mt-2 truncate text-[13px] font-medium">{album.name}</p>
                <p className="truncate text-[11px] text-white/45">{album.artistName}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </div>
  )

  /** 排行榜抽屉（歌曲/专辑榜完整排名：名次 + 封面 + 名称 + 艺人，点行播放） */
  /** 帖子详情弹窗（艺人分享 /post/…） */
  const postDetailEl = postDetail && (
    <div className="fixed inset-0 z-[180] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setPostDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="relative h-52 w-full overflow-hidden">
          {postDetail.item.artworkUrl ? (
            <img src={postDetail.item.artworkUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-white/[0.05]">
              <UserRound className="h-10 w-10 opacity-40" />
            </div>
          )}
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(12,16,23,1)_0%,rgba(12,16,23,0.25)_60%,transparent_100%)]" />
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setPostDetail(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-md hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-6 pt-2">
          <h3 className="text-xl font-semibold">{postDetail.item.name}</h3>
          <p className="mt-1 text-xs text-white/45">{postDetail.item.artistName || postDetail.item.subtitle || 'Apple Music 艺人分享'}</p>
          {postDetail.loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载帖子…
            </div>
          )}
          {postDetail.detail?.body && (
            <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-white/70">{postDetail.detail.body}</p>
          )}
          {postDetail.detail?.media && postDetail.detail.media.length > 0 && (
            <div className="mt-5 space-y-2">
              <p className="text-xs font-medium text-white/45">帖子内容</p>
              {postDetail.detail.media.map(media => (
                <button
                  key={`${media.type}-${media.id}`}
                  type="button"
                  onClick={() => {
                    if (media.type === 'songs') playItemWithQueue(media, (postDetail.detail?.media || []).filter(m => m.type === 'songs'))
                    else if (media.type === 'music-videos') playVideo(media)
                    else if (media.type === 'playlists') openPlaylistPanel(media)
                    else if (media.type === 'albums') onOpenAlbum ? onOpenAlbum(media.playId || media.id, 'apple') : void 0
                  }}
                  className="flex w-full items-center gap-3 rounded-xl border border-white/[0.08] bg-white/[0.04] p-2.5 text-left transition hover:bg-white/[0.08]"
                >
                  {media.artworkUrl ? (
                    <img src={media.artworkUrl} alt="" className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/[0.06]">
                      {media.type === 'music-videos' ? <MusicGlyph className="h-5 w-5 opacity-50" /> : <ListMusic className="h-5 w-5 opacity-50" />}
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{media.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-white/40">
                      {media.artistName || media.subtitle || ({ songs: '歌曲', albums: '专辑', 'music-videos': '音乐视频', playlists: '歌单' } as Record<string, string>)[media.type] || 'Apple Music'}
                    </span>
                  </span>
                  <Play className="ml-auto h-4 w-4 shrink-0 text-white/40" />
                </button>
              ))}
            </div>
          )}
          {!postDetail.loading && !postDetail.detail && (
            <p className="mt-4 text-sm text-white/40">帖子详情暂不可用，可前往 Apple Music 网页查看。</p>
          )}
        </div>
      </motion.div>
    </div>
  )

  const chartDrawer = chartDetail && (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setChartDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[82vh] w-full max-w-2xl overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.07]">
              <Trophy className="h-5 w-5 text-white/60" />
            </span>
            <div>
              <h3 className="line-clamp-1 text-xl font-semibold">{chartDetail.title}</h3>
              <p className="mt-0.5 text-xs text-white/45">{chartDetail.items.length} 项 · Apple Music 官方榜单</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setChartDetail(null)}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/[0.08] text-white/70 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 max-h-[58vh] overflow-y-auto px-3 pb-6">
          {chartDetail.items.map((item, index) => (
            <div
              key={`${chartDetail.id}-${item.id}`}
              className="group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition hover:bg-white/[0.06]"
              onClick={() => {
                if (item.type === 'playlists') openPlaylistPanel(item)
                else if (item.type === 'albums') onOpenAlbum ? onOpenAlbum(item.playId || item.id, 'apple') : void 0
                else if (item.type === 'music-videos') playVideo(item)
                else playItemWithQueue(item, chartDetail.items)
              }}
            >
              <span className={`w-7 shrink-0 text-center text-sm tabular-nums ${index < 3 ? 'font-semibold' : 'text-white/30'}`} style={index < 3 ? { color: accentColor } : undefined}>
                {index + 1}
              </span>
              {item.artworkUrl ? (
                <img src={item.artworkUrl} alt={item.name} loading="lazy" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
              ) : (
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/[0.07]">
                  <MusicGlyph className="h-5 w-5 opacity-40" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{item.name}</p>
                <p className="truncate text-xs text-white/45">{item.artistName || item.curatorName || item.subtitle || 'Apple Music'}</p>
              </div>
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 transition group-hover:opacity-100"
                aria-hidden="true"
              >
                <Play className="h-4 w-4 fill-current" />
              </span>
            </div>
          ))}
        </div>
      </motion.div>
    </div>
  )

  /** 电台详情抽屉（web /station 同款：动态封面 + 描述 + 加入资料库 + 浏览器打开） */
  const stationDrawer = stationDetail && (
    <div className="fixed inset-0 z-[170] flex items-end justify-center bg-black/60 backdrop-blur-sm" onClick={() => setStationDetail(null)}>
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-t-[28px] border-t border-white/[0.1] bg-[#0c1017] text-white shadow-2xl"
      >
        {/* 动态封面头部 */}
        <div className="relative h-44 w-full overflow-hidden">
          <DynamicCover item={stationDetail.station} className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(12,16,23,1)_0%,rgba(12,16,23,0.25)_60%,transparent_100%)]" />
          <button
            type="button"
            aria-label="关闭"
            onClick={() => setStationDetail(null)}
            className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white/80 backdrop-blur-md hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
          {stationDetail.station.isLive && (
            <span className="absolute left-4 top-4 rounded-md bg-[#fa2d48] px-2 py-1 text-[11px] font-semibold text-white">直播中</span>
          )}
        </div>
        <div className="p-6 pt-2">
          <h3 className="text-xl font-semibold">{stationDetail.station.name}</h3>
          <p className="mt-1 text-xs text-white/45">
            {stationDetail.station.showName || 'Apple Music 电台'}
            {stationDetail.station.airTime?.start && !stationDetail.station.isLive
              ? ` · 播出 ${new Date(stationDetail.station.airTime.start).toLocaleDateString('zh-CN')}`
              : ''}
          </p>
          {stationDetail.loading && (
            <div className="mt-3 flex items-center gap-2 text-xs text-white/40">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在加载电台详情…
            </div>
          )}
          {stationDetail.station.description && (
            <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-white/60">{stationDetail.station.description}</p>
          )}
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => { setStationDetail(null); void playStation(stationDetail.station) }}
              className="flex flex-1 items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold"
              style={{ background: accentColor, color: '#0a0f14' }}
            >
              <Play className="h-4 w-4 fill-current" /> 播放电台
            </button>
            <button
              type="button"
              disabled={!appleLoggedIn}
              onClick={() => void saveStation(stationDetail.station)}
              className={`flex flex-1 items-center justify-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.06] py-3 text-sm font-semibold ${appleLoggedIn ? 'text-white/80 hover:bg-white/[0.1]' : 'opacity-40'}`}
            >
              <Plus className="h-4 w-4" /> 加入资料库
            </button>
            <button
              type="button"
              aria-label="在 Apple Music 打开"
              onClick={() => openExternal(stationDetail.station.url)}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/[0.12] bg-white/[0.06] text-white/70 transition hover:bg-white/[0.1]"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          </div>
          {!appleLoggedIn && <p className="mt-2 text-center text-xs text-white/40">登录后可收藏电台；播放直播需登录 Apple Music</p>}
        </div>
      </motion.div>
    </div>
  )

  return (
    <div className="space-y-6">
      {/* 未登录提示 */}
      {!appleLoggedIn && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
          <p className="text-sm text-white/55">
            <span className="mr-2"><Sparkles className="inline h-4 w-4" /></span>
            登录 Apple Music 后这里会变成你的个性化主页（最近播放 / 专属推荐 / 口味推荐）与最近收听的电台。
          </p>
          <button
            type="button"
            onClick={onLoginClick}
            className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold"
            style={{ background: accentColor, color: '#0a0f14' }}
          >
            <LogIn className="h-4 w-4" /> 登录 Apple Music
          </button>
        </div>
      )}

      {/* 页签 + 商店标识（商店 chip 放资料库右侧；刷新入口在探索页顶栏「换一批」位置） */}
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`flex h-10 items-center gap-2 rounded-full px-5 text-sm font-medium transition ${
              tab === id
                ? 'text-[#081017]'
                : 'border border-white/[0.1] bg-white/[0.045] text-white/60 hover:bg-white/[0.09] hover:text-white'
            }`}
            style={tab === id ? { background: accentColor } : undefined}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
        <span className="rounded-full border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 text-xs uppercase text-white/40">
          {storefront} 商店
        </span>
      </div>

      {/* 内容 */}
      {roomDetail && (
        <div className="space-y-6">
          <button
            type="button"
            onClick={() => setRoomDetail(null)}
            className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.045] px-4 py-2 text-sm text-white/70 transition hover:bg-white/[0.09] hover:text-white"
          >
            <ChevronRight className="h-4 w-4 rotate-180" /> 返回
          </button>
          <h2 className="text-2xl font-semibold">{roomDetail.name}</h2>
          {roomDetail.loading ? skeleton : roomDetail.page ? (
            <>
              {renderAllSections(roomDetail.page.sections)}
              {roomDetail.page.sections.length === 0 && (
                <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
                  {roomDetail.page.sourceLabel}
                </div>
              )}
            </>
          ) : (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
              room 加载失败
            </div>
          )}
        </div>
      )}
      {!roomDetail && (<>
      {currentError && (
        <div className="rounded-2xl border border-rose-300/15 bg-rose-300/[0.08] px-4 py-3 text-sm text-rose-100/80">
          加载失败：{currentError}
        </div>
      )}
      {tab === 'categories' ? (
        /* 分类（web /search 类别浏览同款：curator 网格 → 点击进入 curator 详情） */
        <AppleSearchBrowse
          key={categoriesVersion}
          playerTheme={playerTheme}
          onSongSelect={onSongSelect}
          onOpenPlaylist={(playlist) =>
            openPlaylistPanel({
              id: playlist.id,
              playId: playlist.id,
              type: 'playlists',
              name: playlist.name,
              artworkUrl: playlist.coverImgUrl,
              curatorName: playlist.creator,
              trackCount: playlist.trackCount,
            })
          }
        />
      ) : currentLoading && !currentPage ? (
        skeleton
      ) : currentPage ? (
        <>
          <div className="space-y-8">
            {/* 主页主视觉大卡（web powerswoosh：动态封面优先） */}
            {tab === 'home' && currentPage.hero && (
              <section className="relative overflow-hidden rounded-[28px] border border-white/[0.09] shadow-2xl shadow-black/20">
                <div className="absolute inset-0">
                  <DynamicCover item={currentPage.hero} className="h-full w-full object-cover" />
                  <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(6,9,14,0.9)_8%,rgba(6,9,14,0.25)_58%,rgba(6,9,14,0.08)_100%)]" />
                </div>
                <div className="relative flex min-h-[280px] flex-col justify-end p-6 md:p-9">
                  <div className="mb-auto flex items-center gap-2 text-xs font-medium text-white/65">
                    <Sparkles className="h-4 w-4" style={{ color: accentColor }} />
                    Apple Music · 专属推荐
                  </div>
                  {currentPage.hero.artworkUrl || currentPage.hero.heroArtworkUrl ? (
                    <img
                      src={currentPage.hero.heroArtworkUrl || currentPage.hero.artworkUrl}
                      alt=""
                      className="mb-4 h-24 w-24 rounded-2xl object-cover shadow-lg md:h-28 md:w-28"
                    />
                  ) : null}
                  <h2 className="max-w-xl text-2xl font-semibold leading-tight md:text-4xl">{currentPage.hero.name}</h2>
                  {currentPage.hero.subtitle && <p className="mt-1.5 max-w-lg text-sm text-white/58">{currentPage.hero.subtitle}</p>}
                  <div className="mt-5 flex items-center gap-3">
                    {currentPage.hero.type === 'songs' && currentPage.hero.playId ? (
                      <button
                        type="button"
                        onClick={() => playItem(currentPage.hero!)}
                        className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#0a0f14] transition hover:brightness-110"
                        style={{ background: accentColor }}
                      >
                        <Play className="h-4 w-4 fill-current" /> 立即播放
                      </button>
                    ) : (currentPage.hero.type === 'playlists' || currentPage.hero.type === 'stations') && currentPage.hero.playId ? (
                      <button
                        type="button"
                        onClick={() => currentPage.hero!.type === 'stations'
                          ? void playStation(currentPage.hero!)
                          : openPlaylistPanel(currentPage.hero!)}
                        className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold text-[#0a0f14] transition hover:brightness-110"
                        style={{ background: accentColor }}
                      >
                        <ListMusic className="h-4 w-4" /> {currentPage.hero.type === 'stations' ? '播放电台' : '打开歌单'}
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
            )}
            {renderAllSections(currentPage.sections)}
            {currentPage.sections.length === 0 && (
              <div className="rounded-2xl border border-white/[0.08] bg-white/[0.035] px-6 py-14 text-center text-sm text-white/40">
                {currentPage.sourceLabel}
              </div>
            )}
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.07] pt-5 text-xs text-white/28">
            <span>来源：{currentPage.sourceLabel}</span>
            <span>{currentPage.personalized ? '已个性化' : '公开内容'}</span>
          </footer>
        </>
      ) : null}
      </>)}
      {playlistDrawer}
      {albumDrawerEl}
      {artistDrawerEl}
      {chartDrawer}
      {stationDrawer}
      {postDetailEl}
      {videoItem && (
        <AppleVideoModal
          item={videoItem}
          onClose={() => setVideoItem(null)}
        />
      )}
    </div>
  )
}

/** 歌曲占位图标（内联，避免额外依赖） */
function MusicGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M9 18.5a3 3 0 1 1-2-2.83V6.2a1 1 0 0 1 .76-.97l8-2A1 1 0 0 1 17 4.2v9.47a3 3 0 1 1-2-2.83V8.06l-6 1.5v8.94Z" />
    </svg>
  )
}
