import { memo, useState, useEffect, useMemo, useRef } from 'react'
import { motion } from 'framer-motion'
import { X, Play, Music, Info, Loader, Heart, Disc3 } from 'lucide-react'
import { getAlbumDetail, getAlbumSongs, getArtistAlbums, Album, Song, getProxiedImageUrl, subscribeAlbum, isAlbumSubscribed, isSameSong } from '../services/musicApi'
import { fetchSodaAlbumTracks, collectSodaAlbum } from '../services/sodaService'
import type { MusicPlatform } from '../services/platforms'
import { getAppleAlbumDetail, appleSongToSong, getAppleLibraryPlaylists } from '../services/appleCatalog'
import CachedImage from './CachedImage'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import SongContextMenu from './SongContextMenu'
import { getUserPlaylists } from '../services/playlistService'
import { getReadableAccentColor } from '../utils/desktopAccentColor'
import { useTvBack } from '../tv/tvCore'

interface AlbumDetailModalProps {
  albumId: string | number
  platform: MusicPlatform
  storefront?: string
  onClose: () => void
  onSongSelect?: (song: Song, playlist?: Song[]) => void
  playerTheme?: 'light' | 'dark'
  neteaseVip?: boolean
  qqVip?: boolean
  currentSong?: Song | null
  accentColor?: string
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onCopyInfo?: (song: Song) => void
  /** 冻结：由 App 保持挂载但当前不可见（关闭弹窗）。隐藏时不消费返回键、不重建 DOM。 */
  suspended?: boolean
}

type TabType = 'songs' | 'info' | 'more'

// 汽水平台约定：外部把「专辑名」当作 albumId 字符串传入（汽水无独立专辑 ID 体系）。
// 名字可能经 URL 编码传递；解码失败（非法 % 序列）时回退原文，避免弹窗崩溃
const decodeSodaName = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

// 封面地址：汽水封面为字节 CDN 直链（p3-p3-xx.byteimg.com 类域名），
// 不拼网易云专用的 param= 宽高参数，直接用原始链接交给 <img>/CachedImage 渲染
const coverImageUrl = (platform: MusicPlatform, url: string | undefined | null): string =>
  platform === 'soda' ? String(url || '') : getProxiedImageUrl(String(url || ''))

function AlbumDetailModal({
  albumId,
  platform,
  storefront: explicitStorefront,
  onClose,
  onSongSelect,
  playerTheme = 'dark',
  neteaseVip = false,
  qqVip = false,
  currentSong = null,
  accentColor = '#ec4899',
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onOpenArtist,
  onOpenAlbum,
  onCopyInfo,
  suspended = false
}: AlbumDetailModalProps) {
  // TV 遥控器 BACK：关闭专辑详情弹窗（冻结隐藏时不消费返回键，交给上层）
  useTvBack(() => {
    if (suspended) return false
    onClose()
    return true
  }, [onClose, suspended])
  const [album, setAlbum] = useState<Album | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabType>('songs')
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
  // 选歌播放：退出动画零时长，弹窗当帧卸载。整屏 backdrop-filter 退出节点在播放页
  // 同时挂载时会被 Chromium 保留为残留合成层（首页同款故障），退出动画越久越易触发。
  const [instantClose, setInstantClose] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({
    show: false,
    x: 0,
    y: 0,
    song: null
  })
  const [subscribed, setSubscribed] = useState(false)
  const [subscribing, setSubscribing] = useState(false)
  // 同歌手其他专辑（专辑的下一级入口）
  const [artistAlbums, setArtistAlbums] = useState<Album[]>([])
  const [artistAlbumsLoading, setArtistAlbumsLoading] = useState(false)

  /** 专辑所属歌手 id：优先取 album.artist，其次取首曲的 ar[0] */
  const albumArtistId = useMemo(() => {
    const direct = typeof album?.artist === 'object' && album?.artist?.id ? String(album.artist.id) : ''
    if (direct) return direct
    const fromSong = songs.find(s => s.artists?.length)?.artists?.[0]?.id
    return fromSong ? String(fromSong) : ''
  }, [album, songs])

  // 切到「更多专辑」时才拉取，避免每次打开专辑都多发一次请求
  useEffect(() => {
    if (activeTab !== 'more' || !albumArtistId || artistAlbums.length > 0) return
    let cancelled = false
    setArtistAlbumsLoading(true)
    void getArtistAlbums(albumArtistId, platform, 30)
      .then(list => { if (!cancelled) setArtistAlbums((list || []).filter(item => String(item.id) !== String(album?.id))) })
      .catch(() => { if (!cancelled) setArtistAlbums([]) })
      .finally(() => { if (!cancelled) setArtistAlbumsLoading(false) })
    return () => { cancelled = true }
  }, [activeTab, albumArtistId, artistAlbums.length, platform, album?.id])

  // 冻结隐藏时收起右键菜单：组件被 App 冻结（不卸载），否则重开时菜单会残留在旧坐标。
  useEffect(() => {
    if (!suspended) return
    setContextMenu({ show: false, x: 0, y: 0, song: null })
  }, [suspended])
  
  const handleSubscribe = async () => {
    if (subscribing || !album) return
    setSubscribing(true)
    try {
      // 汽水：上游无逐专辑收藏读接口，初始态走 /api/soda/album/collect/check 用账号库缓存判归
      // （未命中证据不足时默认未收藏）；collectSodaAlbum 成功后仅本地翻转按钮状态。
      // 标识优先用接口解析出的真实专辑 id（album.mid），否则回退外部传入的「专辑名」原串
      if (platform === 'soda') {
        const ok = await collectSodaAlbum(String(album.mid || albumId), !subscribed)
        if (ok) setSubscribed(!subscribed)
        return
      }
      const data = await subscribeAlbum(String(album.id), !subscribed, platform)
      if (data) {
        setSubscribed(!subscribed)
      }
    } catch {
      /* ignore */
    } finally {
      setSubscribing(false)
    }
  }

  // 打开专辑详情时按当前账号是否已收藏初始化按钮状态（QQ 传 mid，网易云传数字 id）；
  // 汽水：上游无逐专辑收藏读接口——走本地只读路由 /api/soda/album/collect/check，
  // 从后端账号库聚合缓存（fetchSodaWebLibrary，90s TTL/每 cookie 指纹）判归，
  // 未登录/未命中证据不足时保持默认未收藏；收藏成功后的本地翻转行为不变
  useEffect(() => {
    if (!album || platform === 'apple') return
    let cancelled = false
    // 汽水标识优先用真实专辑 id（album.mid），否则回退外部传入的「专辑名」原串
    const id = platform === 'soda'
      ? String(album.mid || albumId)
      : platform === 'qq' ? String(album.mid || album.id) : String(album.id)
    setSubscribed(false)
    if (platform === 'soda') {
      void (async () => {
        try {
          const query = new URLSearchParams({ id })
          const sdCookie = localStorage.getItem('soda_token') || ''
          if (sdCookie) query.set('cookie', sdCookie)
          const response = await fetch(`http://localhost:3001/api/soda/album/collect/check?${query.toString()}`, { cache: 'no-store' })
          const payload = await response.json().catch(() => null)
          if (!cancelled && response.ok && payload?.loggedIn && payload?.collected) setSubscribed(true)
        } catch { /* 静默：保持默认未收藏 */ }
      })()
      return () => { cancelled = true }
    }
    void isAlbumSubscribed(id, platform).then((subscribedNow) => {
      if (!cancelled) setSubscribed(subscribedNow)
    })
    return () => { cancelled = true }
  }, [album, platform])
  
  // 滚动容器引用
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  
  // The modal surface is always darkened by the cover backdrop, independent
  // of the global player theme. Keep neutral text readable on that real surface.
  const textPrimary = 'text-white'
  const textSecondary = 'text-white/60'
  const textTertiary = 'text-white/40'
  const bgCard = 'bg-white/5'
  const borderColor = 'border-white/10'
  // 汽水暂无本地会员态：按非会员处理，Song.vip 为真的曲目始终显示 VIP 徽标
  const isVip = platform === 'netease' ? neteaseVip : platform === 'qq' ? qqVip : false
  const readableAccentColor = getReadableAccentColor(accentColor, '#dbeafe')

  // 判断是否是当前播放的歌曲
  const isCurrentSong = (song: Song) => isSameSong(currentSong, song)

  // 查找当前播放歌曲在列表中的索引
  const currentSongIndex = songs.findIndex(song => isCurrentSong(song))

  useEffect(() => {
    loadAlbumData()
  }, [albumId, platform, explicitStorefront])

  useEffect(() => {
    // Spotify / 汽水：歌单列表由平台自身登录态驱动（Spotify token / 汽水 soda_token cookie），
    // 不依赖本地 userId；未登录或接口失败时返回空数组，右键「添加到」自然保持为空。
    // 汽水加歌走 SongContextMenu 内置的 addSodaSongToPlaylist（playlistService.addSongToPlaylist
    // 的 soda 分支同源），成功/失败均有 toast，与 QQ/网易云走同一条通用路径
    if (platform === 'spotify' || platform === 'soda') {
      void getUserPlaylists(platform, '')
        .then(list => setUserPlaylists(Array.isArray(list) ? list : []))
        .catch(() => setUserPlaylists([]))
      return
    }
    // Apple：右键菜单歌单用资料库歌单（amp-api）
    if (platform === 'apple') {
      void getAppleLibraryPlaylists(100)
        .then(setUserPlaylists)
        .catch(() => setUserPlaylists([]))
      return
    }
    const userId = platform === 'qq'
      ? localStorage.getItem('qq_user_id') || ''
      : localStorage.getItem('netease_user_id') || ''
    const username = platform === 'qq'
      ? localStorage.getItem('qq_username') || ''
      : localStorage.getItem('netease_username') || ''
    if (!userId) {
      setUserPlaylists([])
      return
    }
    void getUserPlaylists(platform, userId, username)
      .then(setUserPlaylists)
      .catch(() => setUserPlaylists([]))
  }, [platform])

  const loadAlbumData = async () => {
    setLoading(true)
    setError(null)
    try {
      // Apple：iTunes Lookup 一次返回专辑信息与曲目（免 token）
      if (platform === 'apple') {
        const storefront = explicitStorefront || localStorage.getItem('appleStorefront') || 'cn'
        const detail = await getAppleAlbumDetail(String(albumId), storefront)
        if (detail?.incomplete) {
          setAlbum({
            id: Number(detail.album.id) || 0,
            name: detail.album.name,
            picUrl: detail.album.artworkUrl || '',
            artist: { name: detail.album.artistName },
            publishTime: detail.album.releaseDate ? Date.parse(detail.album.releaseDate) : undefined,
            platform: 'apple',
          })
          setSongs([])
          setError('Apple Music 未返回该专辑的曲目，请重试或检查地区设置')
        } else if (detail) {
          setAlbum({
            id: Number(detail.album.id) || 0,
            name: detail.album.name,
            picUrl: detail.album.artworkUrl || '',
            artist: { name: detail.album.artistName },
            publishTime: detail.album.releaseDate ? Date.parse(detail.album.releaseDate) : undefined,
            // 专辑简介来自 attributes.editorialNotes.standard（getAppleAlbumDetail 已请求 extend=editorialNotes）。
            description: detail.album.description,
            platform: 'apple',
          })
          setSongs(detail.tracks.map(track => appleSongToSong(track, storefront)))
        } else {
          setError('未找到该 Apple 专辑')
        }
        return
      }
      // 汽水音乐：纯数字串按专辑 id 查询、否则按专辑名查询（约定见 sodaService）。
      // 头部封面用接口返回的 coverUrl，缺失时兜底首曲封面；
      // 服务内部降级不抛错，失败/无曲目时返回空 tracks → 走列表空态文案
      if (platform === 'soda') {
        const key = decodeSodaName(String(albumId))
        const data = await fetchSodaAlbumTracks(key)
        setAlbum({
          id: Number((data.album.id || '').slice(0, 15)) || 0,
          mid: data.album.id || key,
          name: data.album.name || key,
          picUrl: data.album.coverUrl || data.tracks[0]?.album?.picUrl || '',
          artist: { name: data.tracks[0]?.artists?.[0]?.name || '' },
          size: data.tracks.length,
          platform: 'soda',
        })
        setSongs(data.tracks)
        return
      }
      const [albumData, songsData] = await Promise.all([
        getAlbumDetail(albumId, platform),
        getAlbumSongs(albumId, platform)
      ])
      setAlbum(albumData)
      setSongs(songsData)
    } catch (error) {
      console.error('加载专辑详情失败:', error)
      setAlbum(null)
      setSongs([])
      setError(error instanceof Error ? error.message : 'Failed to load album')
    } finally {
      setLoading(false)
    }
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp)
    return date.toLocaleDateString('zh-CN', { 
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit' 
    })
  }

  const handlePlayAll = () => {
    if (songs.length > 0 && onSongSelect) {
      setInstantClose(true)
      onSongSelect(songs[0], songs)
      onClose()
    }
  }

  // 冻结隐藏时不渲染 DOM：避免隐藏弹窗被 TV 焦点/点击命中。
  if (suspended) return null

  return (
    <>
      {/* 全屏背景层 - 透明+模糊+暗化 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={instantClose ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
        className="fixed inset-0 z-[300]"
        style={{ 
          pointerEvents: 'none',
          backdropFilter: 'blur(5px) brightness(0.92)',
          WebkitBackdropFilter: 'blur(5px) brightness(0.92)',
          backgroundColor: 'rgba(0, 0, 0, 0.08)'
        }}
      />
      
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={instantClose ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
        className="fixed inset-0 z-[301] flex items-center justify-center p-8"
        onClick={onClose}
      >
        <motion.div
          data-tv-scope
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={instantClose ? { scale: 0.9, opacity: 0, transition: { duration: 0 } } : { scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="rounded-3xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col overflow-hidden relative"
        >
          {/* 液态玻璃背景 - 使用专辑封面，只在弹窗内部 */}
          <div className="absolute inset-0 rounded-3xl overflow-hidden">
            {/* 专辑封面背景 */}
            {album?.picUrl && (
              <div
                className="absolute inset-0 bg-cover bg-center"
                style={{
                  backgroundImage: `url(${coverImageUrl(platform, album.picUrl)})`,
                  filter: 'blur(40px) brightness(0.6)',
                }}
              />
            )}
          
            {/* 液态玻璃效果 */}
            <div
              className="absolute inset-0"
              style={{
                background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)',
                backdropFilter: 'blur(80px) saturate(200%)',
                WebkitBackdropFilter: 'blur(80px) saturate(200%)',
              }}
            />
          

          
            {/* 边框高光 */}
            <div 
              className="absolute inset-0 rounded-3xl"
              style={{
                border: '1px solid rgba(255,255,255,0.2)',
                boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)',
                pointerEvents: 'none',
              }}
            />
          </div>

        {/* 内容区 */}
        <div className="relative z-10 flex flex-col h-full min-h-0">
          {/* 头部 - 专辑信息 */}
          <div className={`p-6 border-b ${borderColor} flex-shrink-0`}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader className={`w-6 h-6 ${textPrimary} animate-spin`} />
              </div>
            ) : error ? (
              <div className="flex items-center justify-between gap-4 py-8">
                <div className={`${textSecondary} text-sm`}>
                  {error}
                </div>
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors h-fit flex-shrink-0"
                >
                  <X className={`w-5 h-5 ${textPrimary}/60`} />
                </button>
              </div>
            ) : album ? (
              <div className="flex gap-4">
                {/* 专辑封面 */}
                <div className="w-28 h-28 rounded-lg overflow-hidden bg-white/5 flex-shrink-0 shadow-xl">
                  {album.picUrl ? (
                    <CachedImage 
                      src={coverImageUrl(platform, album.picUrl)}
                      alt={album.name}
                      className="w-full h-full object-cover"
                      role="compact"
                      size={256}
                      priority="visible"
                      fallback={
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className={`w-10 h-10 ${textPrimary}/20`} />
                        </div>
                      }
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Music className={`w-10 h-10 ${textPrimary}/20`} />
                    </div>
                  )}
                </div>

                {/* 专辑信息 */}
                <div className="flex-1 flex flex-col justify-center min-w-0">
                  <h1 className={`text-2xl font-bold ${textPrimary} mb-2 truncate`}>
                    {album.name}
                  </h1>
                  
                  <div className={`${textSecondary} space-y-1 mb-3`}>
                    <p className="text-sm truncate">
                      {(() => {
                        const artistName = typeof album.artist === 'string' ? album.artist : album.artist?.name || '未知艺人'
                        const artistId = typeof album.artist === 'object' && album.artist?.id ? String(album.artist.id) : ''
                        if (!artistId || !onOpenArtist) return artistName
                        return (
                          <button
                            type="button"
                            onClick={() => onOpenArtist(artistId, platform)}
                            className="cursor-pointer transition-colors hover:text-pink-400 hover:underline"
                            title={`查看歌手 ${artistName}`}
                          >
                            {artistName}
                          </button>
                        )
                      })()}
                    </p>
                    {album.publishTime && (
                      <p className="text-sm">{formatDate(album.publishTime)}</p>
                    )}
                  </div>

                  {/* 播放按钮 */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handlePlayAll}
                      className="px-6 py-2 text-slate-950 rounded-full font-medium transition-all flex items-center gap-2 w-fit text-sm"
                      style={{
                        backgroundColor: `${readableAccentColor}e6`,
                      }}
                      onMouseEnter={(e) => e.currentTarget.style.backgroundColor = readableAccentColor}
                      onMouseLeave={(e) => e.currentTarget.style.backgroundColor = `${readableAccentColor}e6`}
                    >
                      <Play className="w-4 h-4" fill="currentColor" />
                      播放专辑
                    </button>
                    {platform !== 'apple' && (
                    <button
                      onClick={handleSubscribe}
                      disabled={subscribing}
                      className={`px-4 py-2 rounded-full font-medium transition-all flex items-center gap-1.5 text-sm ${
                        subscribed
                          ? 'text-white'
                          : 'text-white/80 hover:text-white'
                      }`}
                      style={{
                        backgroundColor: subscribed ? `${readableAccentColor}` : 'rgba(255,255,255,0.12)',
                      }}
                    >
                      <Heart className={`w-4 h-4 ${subscribed ? 'fill-current' : ''}`} />
                      {subscribed ? '已收藏' : '收藏专辑'}
                    </button>
                    )}
                  </div>
                </div>

                {/* 关闭按钮 */}
                <button
                  onClick={onClose}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors h-fit flex-shrink-0"
                >
                  <X className={`w-5 h-5 ${textPrimary}/60`} />
                </button>
              </div>
            ) : null}
          </div>

          {/* 标签栏 */}
          <div className={`flex justify-between items-end px-6 pt-3 border-b ${borderColor} flex-shrink-0`}>
            <div className="flex gap-4">
              <button
                onClick={() => setActiveTab('songs')}
                className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                  activeTab === 'songs'
                    ? `${textPrimary}`
                    : `${textSecondary} hover:${textPrimary}`
                }`}
              >
                <Music className="w-4 h-4 inline mr-1.5" />
                歌曲
                {activeTab === 'songs' && (
                  <motion.div
                    layoutId="activeTabAlbum"
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ backgroundColor: readableAccentColor }}
                  />
                )}
              </button>
              <button
                onClick={() => setActiveTab('info')}
                className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                  activeTab === 'info'
                    ? `${textPrimary}`
                    : `${textSecondary} hover:${textPrimary}`
                }`}
              >
                <Info className="w-4 h-4 inline mr-1.5" />
                专辑信息
                {activeTab === 'info' && (
                  <motion.div
                    layoutId="activeTabAlbum"
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ backgroundColor: readableAccentColor }}
                  />
                )}
              </button>
              {/* 同歌手其他专辑：专辑的下一级入口（点击进入另一张专辑） */}
              {onOpenAlbum && albumArtistId && (
                <button
                  onClick={() => setActiveTab('more')}
                  className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                    activeTab === 'more'
                      ? `${textPrimary}`
                      : `${textSecondary} hover:${textPrimary}`
                  }`}
                >
                  <Disc3 className="w-4 h-4 inline mr-1.5" />
                  更多专辑
                  {activeTab === 'more' && (
                    <motion.div
                      layoutId="activeTabAlbum"
                      className="absolute bottom-0 left-0 right-0 h-0.5"
                      style={{ backgroundColor: readableAccentColor }}
                    />
                  )}
                </button>
              )}
            </div>
            {/* 歌曲数量显示 */}
            <div className={`${textSecondary} text-sm pb-3 pr-3`}>
              歌曲数量：{songs.length} 首
            </div>
          </div>

          {/* 内容区（添加滚动） */}
          <div 
            ref={scrollContainerRef}
            className="flex-1 min-h-0 overflow-y-auto p-4 scrollbar-thin"
            style={{
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255, 255, 255, 0.3) rgba(255, 255, 255, 0.1)'
            }}
          >
            {activeTab === 'songs' && (
                <div className="space-y-1">
                  {/* 表头 */}
                  <div className={`flex items-center gap-4 px-4 py-2 ${textTertiary} text-xs`}>
                    <div className="w-8 text-center">#</div>
                    <div className="w-10"></div>
                    <div className="flex-1">歌曲</div>
                    <div className="w-32">歌手</div>
                    <div className="w-20 text-right">时长</div>
                  </div>

                  {/* 歌曲列表 */}
                  {songs.map((song, index) => {
                    const isCurrent = isCurrentSong(song)
                    return (
                    <motion.div
                      key={`album-song-${index}`}
                      data-song-index={index}
                      whileHover={{ scale: 1.005 }}
                      onClick={() => {
                        if (onSongSelect) {
                          setInstantClose(true)
                          onSongSelect(song, songs)
                          onClose()
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setContextMenu({ show: true, x: event.clientX, y: event.clientY, song })
                      }}
                      style={isCurrent ? {
                        backgroundColor: `${readableAccentColor}33`,
                      } : undefined}
                      className={`flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-colors group ${
                        isCurrent ? '' : `hover:${bgCard}`
                      }`}
                      onMouseEnter={(e) => {
                        if (isCurrent) {
                          e.currentTarget.style.backgroundColor = `${readableAccentColor}4D`
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (isCurrent) {
                          e.currentTarget.style.backgroundColor = `${readableAccentColor}33`
                        }
                      }}
                    >
                      {/* 序号 */}
                      <div className={`w-8 text-center text-xs ${textTertiary} group-hover:${textPrimary}`}>
                        {String(index + 1).padStart(2, '0')}
                      </div>

                      {/* 封面 */}
                      <div className={`w-10 h-10 rounded-lg overflow-hidden ${bgCard} flex-shrink-0`}>
                        {song.album?.picUrl ? (
                          <CachedImage 
                            src={coverImageUrl(platform, song.album.picUrl)} 
                            alt={song.name} 
                            className="w-full h-full object-cover"
                            role="row"
                            size={64}
                            priority="visible"
                            fallback={
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className={`w-5 h-5 ${textPrimary}/20`} />
                              </div>
                            }
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <Music className={`w-5 h-5 ${textPrimary}/20`} />
                          </div>
                        )}
                      </div>

                      {/* 歌曲名 */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <h3 
                            className={`font-medium truncate transition-colors text-sm ${
                              isCurrent ? '' : textPrimary
                            }`}
                            style={isCurrent ? { color: readableAccentColor } : undefined}
                            onMouseEnter={(e) => {
                              if (!isCurrent) {
                                e.currentTarget.style.color = readableAccentColor
                              }
                            }}
                            onMouseLeave={(e) => {
                              if (!isCurrent) {
                                e.currentTarget.style.color = ''
                              }
                            }}
                          >
                            {song.name}
                          </h3>
                          {song.vip && !isVip && (
                            <span className="flex-shrink-0 px-1.5 py-0.5 text-xs font-bold rounded border border-yellow-500 text-yellow-500">
                              VIP
                            </span>
                          )}
                          {song.noCopyright && (
                            <span className={`flex-shrink-0 px-1.5 py-0.5 text-xs font-medium rounded bg-gray-600/80 ${textPrimary}/80`}>
                              无版权
                            </span>
                          )}
                        </div>
                      </div>

                      {/* 歌手 */}
                      <div 
                        className={`w-32 text-xs truncate ${
                          isCurrent ? '' : textSecondary
                        }`}
                        style={isCurrent ? { color: readableAccentColor, opacity: 0.8 } : undefined}
                      >
                        {song.artists?.map(a => a.name).join(', ')}
                      </div>

                      {/* 时长 */}
                      <div className={`w-20 text-right ${textTertiary} text-xs`}>
                        {formatDuration(song.duration)}
                      </div>
                    </motion.div>
                    )
                  })}

                  {/* 空态：汽水服务降级时静默返回空列表，与其它平台空态文案保持一致 */}
                  {songs.length === 0 && !loading && !error && (
                    <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                      <Music className="w-16 h-16 mb-4 opacity-20" />
                      <p>暂无歌曲</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'more' && (
                <div className={`${textPrimary} space-y-6`}>
                  <h3 className="text-xl font-bold mb-3">同歌手其他专辑</h3>
                  {artistAlbumsLoading ? (
                    <div className="flex min-h-32 items-center justify-center"><Loader className="w-6 h-6 animate-spin opacity-60" /></div>
                  ) : artistAlbums.length === 0 ? (
                    <p className={`${textSecondary} text-sm`}>暂无其他专辑</p>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                      {artistAlbums.map(item => (
                        <button
                          key={String(item.id)}
                          type="button"
                          onClick={() => onOpenAlbum?.(String(item.id), platform)}
                          className="text-left group"
                        >
                          <span className="relative block aspect-square overflow-hidden rounded-md">
                            <CachedImage src={coverImageUrl(platform, item.picUrl)} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.03]" role="card" />
                          </span>
                          <span className={`mt-2 line-clamp-2 text-sm ${textPrimary}`}>{item.name}</span>
                          {item.publishTime ? <span className={`mt-0.5 block text-xs ${textSecondary}`}>{String(item.publishTime).slice(0, 10)}</span> : null}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'info' && album && (
                <div className={`${textPrimary} space-y-6`}>
                  <div>
                    <h3 className="text-xl font-bold mb-3">专辑信息</h3>
                    <div className={`${textSecondary} space-y-2`}>
                      <div className="flex">
                        <span className="w-24 text-white/40">专辑名称:</span>
                        <span>{album.name}</span>
                      </div>
                      <div className="flex">
                        <span className="w-24 text-white/40">歌手:</span>
                        <span>{typeof album.artist === 'string' ? album.artist : album.artist?.name || '未知艺人'}</span>
                      </div>
                      {album.publishTime && (
                        <div className="flex">
                          <span className="w-24 text-white/40">发行时间:</span>
                          <span>{formatDate(album.publishTime)}</span>
                        </div>
                      )}
                      {album.size !== undefined && (
                        <div className="flex">
                          <span className="w-24 text-white/40">歌曲数量:</span>
                          <span>{album.size} 首</span>
                        </div>
                      )}
                      {album.genre && (
                        <div className="flex">
                          <span className="w-24 text-white/40">流派:</span>
                          <span>{album.genre}</span>
                        </div>
                      )}
                      {album.lan && (
                        <div className="flex">
                          <span className="w-24 text-white/40">语言:</span>
                          <span>{album.lan}</span>
                        </div>
                      )}
                      {album.company && (
                        <div className="flex">
                          <span className="w-24 text-white/40">唱片公司:</span>
                          <span>{album.company}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {album.description && (
                    <div>
                      <h3 className="text-xl font-bold mb-3">专辑简介</h3>
                      <p className={`${textSecondary} leading-relaxed whitespace-pre-wrap`}>
                        {album.description}
                      </p>
                    </div>
                  )}
                </div>
              )}
          </div>
        </div>

        {/* 滚动按钮组 - 弹窗外部右侧，相对于弹窗定位 */}
        {/* 回到顶部按钮 - 最下方 */}
        <ScrollToTop 
          containerRef={scrollContainerRef} 
          playerTheme={playerTheme}
          position="absolute"
          offsetRight={-60}
          offsetBottom={24}
        />
        
        {/* 跳转到当前播放歌曲按钮 - 在回到顶部按钮上方 */}
        {currentSongIndex !== -1 && (
          <ScrollToCurrentSong 
            containerRef={scrollContainerRef}
            currentSongIndex={currentSongIndex}
            playerTheme={playerTheme}
            position="absolute"
            offsetRight={-60}
            offsetBottom={88}
          />
        )}
      </motion.div>
    </motion.div>

    {contextMenu.song && (
      <SongContextMenu
        show={contextMenu.show}
        x={contextMenu.x}
        y={contextMenu.y}
        song={contextMenu.song}
        playerTheme={playerTheme}
        onClose={() => setContextMenu({ show: false, x: 0, y: 0, song: null })}
        onPlayNow={(song) => {
          // 右键"播放"也必须关闭专辑弹窗，否则播放页出现后弹窗还叠在上面
          setInstantClose(true)
          onSongSelect?.(song, songs)
          onClose()
        }}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onViewArtist={onOpenArtist ? (song) => {
          const artist = song.artists?.[0]
          // 汽水约定：歌手名即歌手标识（无独立 ID 体系）
          const targetId = platform === 'soda'
            ? artist?.name
            : platform === 'apple' ? (artist?.appleId || artist?.id)
              : platform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
          if (targetId) onOpenArtist(String(targetId), platform)
        } : undefined}
        onCopyInfo={onCopyInfo}
        userPlaylists={userPlaylists}
        platform={platform}
      />
    )}
    </>
  )
}

export default memo(AlbumDetailModal)
