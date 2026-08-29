import { useState, useEffect, useRef, useCallback, memo, type CSSProperties, type ReactElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Play, Music, Disc, Video, Info, Loader, ListMusic, Calendar, Eye, Users, Heart, UserPlus, UserCheck } from 'lucide-react'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { getArtistDetail, getArtistTopSongs, getArtistAllSongs, getArtistAlbums, getArtistMVs, Artist, Song, Album, getProxiedImageUrl, resolveSongAlbumIdentifier, subscribeArtist, getSimilarArtists, isArtistFollowed, isSameSong } from '../services/musicApi'
import { fetchSodaArtistSongs } from '../services/sodaService'
import type { MusicPlatform } from '../services/platforms'
import { getAppleArtistDetail, getAppleCatalogArtist, getAppleCatalogArtistAlbums, getAppleCatalogArtistMusicVideos, getAppleCatalogRelatedArtists, appleSongToSong, getAppleLibraryPlaylists } from '../services/appleCatalog'
import CachedImage from './CachedImage'
import AlbumDetailModal from './AlbumDetailModal'
import VideoPlayer from './VideoPlayer'
import AppleVideoModal from './AppleVideoModal'
import type { AppleWebItem } from '../services/appleWebService'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import { useTvBack } from '../tv/tvCore'
import SongContextMenu from './SongContextMenu'
import { getUserPlaylists } from '../services/playlistService'
import { getReadableAccentColor } from '../utils/desktopAccentColor'

type TabType = 'hotSongs' | 'allSongs' | 'albums' | 'videos' | 'similarArtists' | 'info'

const formatDuration = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// 汽水平台约定：外部把「歌手名」当作 artistId 字符串传入（汽水无独立艺人 ID 体系）。
// 名字可能经 URL 编码传递；解码失败（非法 % 序列）时回退原文，避免弹窗崩溃
const decodeSodaName = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

interface ArtistSongRowProps {
  song: Song
  index: number
  isCurrent: boolean
  playerTheme: 'light' | 'dark'
  accentColor: string
  readableAccentColor: string
  isVip: boolean
  onSelect: (song: Song) => void
  onContextMenu: (event: React.MouseEvent, song: Song) => void
}

// memo 歌曲行：全部歌曲/热门歌曲列表可达上千行，任一状态变化（分页、关注、右键菜单等）
// 都会触发整表重渲染；抽取为 memo 组件后，只有 props 变化的行才会重渲染。
const ArtistSongRow = memo(function ArtistSongRow({
  song, index, isCurrent, playerTheme, accentColor, readableAccentColor, isVip,
  onSelect, onContextMenu,
}: ArtistSongRowProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  return (
    <motion.div
      data-song-index={index}
      onClick={() => onSelect(song)}
      onContextMenu={(e) => onContextMenu(e, song)}
      style={isCurrent ? { backgroundColor: `${readableAccentColor}33` } : undefined}
      className={`flex items-center gap-4 p-3 rounded-xl cursor-pointer transition-colors group ${
        isCurrent
          ? ''
          : `hover:${bgCard}`
      }`}
      onMouseEnter={(e) => {
        if (isCurrent) {
          e.currentTarget.style.backgroundColor = `${accentColor}4D`
        }
      }}
      onMouseLeave={(e) => {
        if (isCurrent) {
          e.currentTarget.style.backgroundColor = `${accentColor}33`
        }
      }}
    >
      {/* 序号 */}
      <div
        className={`w-8 text-center text-xs ${
          isCurrent
            ? 'font-medium'
            : `${textTertiary}`
        }`}
        style={isCurrent ? { color: readableAccentColor } : undefined}
      >
        {index + 1}
      </div>

      {/* 封面 */}
      <div className={`w-10 h-10 rounded-lg overflow-hidden ${bgCard} flex-shrink-0`}>
        {song.album?.picUrl ? (
          <CachedImage
            src={song.album.picUrl}
            alt={song.name}
            className="w-full h-full object-cover"
            fallback={
              <div className="w-full h-full flex items-center justify-center">
                <Music className={`w-4 h-4 ${textPrimary}/20`} />
              </div>
            }
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Music className={`w-4 h-4 ${textPrimary}/20`} />
          </div>
        )}
      </div>

      {/* 歌曲信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3
            className={`font-medium truncate text-sm transition-colors ${
              isCurrent
                ? ''
                : textPrimary
            }`}
            style={isCurrent ? { color: readableAccentColor } : undefined}
            onMouseEnter={(e) => {
              if (!isCurrent) {
                e.currentTarget.style.color = accentColor
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
        <p
          className={`text-xs truncate ${
            isCurrent ? '' : textSecondary
          }`}
          style={isCurrent ? { color: readableAccentColor, opacity: 0.8 } : undefined}
        >
          {song.album?.name}
        </p>
      </div>

      {/* 时长 */}
      <div className={`${textTertiary} text-xs`}>
        {formatDuration(song.duration)}
      </div>
    </motion.div>
  )
})

// 全部歌曲虚拟化行：react-window List 的行组件（index/style 由库注入 + rowProps）。
// 前 N 行渲染歌曲，最后一行渲染「加载更多/已加载全部」提示（rowCount 多计一行）。
// 与组件内 isCurrentSong 同逻辑（无闭包依赖，供模块级虚拟行使用）
const songIsCurrent = (song: Song, currentSong: Song | null | undefined) =>
  isSameSong(currentSong, song)

// 全部歌曲虚拟化行数据（不含 index/style，由 react-window 注入）
type AllSongsRowData = {
  songs: Song[]
  currentSong: Song | null | undefined
  playerTheme: 'light' | 'dark'
  accentColor: string
  readableAccentColor: string
  isVip: boolean
  onSelect: (song: Song) => void
  onContextMenu: (event: React.MouseEvent, song: Song) => void
  loading: boolean
  hasMore: boolean
  textPrimary: string
  textSecondary: string
  textTertiary: string
}

// 虚拟化已限制同时渲染的行数，行组件无需再 memo。
function AllSongsRow({ index, style, ...data }: RowComponentProps<AllSongsRowData>): ReactElement | null {
  const {
    songs,
    currentSong,
    playerTheme,
    accentColor,
    readableAccentColor,
    isVip,
    onSelect,
    onContextMenu,
    loading,
    hasMore,
    textPrimary,
    textSecondary,
    textTertiary,
  } = data
  if (index < songs.length) {
    const song = songs[index]
    return (
      <div style={style} className="px-4">
        <ArtistSongRow
          song={song}
          index={index}
          isCurrent={songIsCurrent(song, currentSong)}
          playerTheme={playerTheme}
          accentColor={accentColor}
          readableAccentColor={readableAccentColor}
          isVip={isVip}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      </div>
    )
  }
  // 列表尾部提示行：加载中显示 spinner；加载完成且无更多时显示总数；还有更多时（列表仍在续页间隙）不渲染内容
  return (
    <div style={style} className="flex items-center justify-center">
      {loading ? (
        <div className="flex items-center justify-center gap-2">
          <Loader className={`w-6 h-6 ${textPrimary}/60 animate-spin`} />
          <span className={`${textSecondary} text-sm`}>加载更多...</span>
        </div>
      ) : hasMore ? null : (
        <span className={`${textTertiary} text-sm`}>已加载全部 {songs.length} 首歌曲</span>
      )}
    </div>
  )
}

interface ArtistAlbumCardProps {
  album: Album
  playerTheme: 'light' | 'dark'
  onOpen: (album: Album) => void
}

// memo 专辑卡片：艺人专辑最多 1000 张，避免无关状态变化时整网格重渲染
const ArtistAlbumCard = memo(function ArtistAlbumCard({ album, playerTheme, onOpen }: ArtistAlbumCardProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  return (
    <motion.div
      whileHover={{ scale: 1.05 }}
      onClick={() => onOpen(album)}
      className={`rounded-xl overflow-hidden ${bgCard} cursor-pointer transition-all group`}
    >
      {/* 专辑封面 */}
      <div className="aspect-square relative overflow-hidden bg-white/5">
        {album.picUrl ? (
          <CachedImage
            src={album.picUrl}
            alt={album.name}
            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
            fallback={
              <div className="w-full h-full flex items-center justify-center">
                <Disc className={`w-16 h-16 ${textPrimary}/20`} />
              </div>
            }
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Disc className={`w-16 h-16 ${textPrimary}/20`} />
          </div>
        )}
      </div>

      {/* 专辑信息 */}
      <div className="p-3">
        <h3 className={`${textPrimary} font-medium truncate mb-1`}>
          {album.name}
        </h3>
        <div className="flex items-center gap-2 text-xs">
          <Calendar className={`w-3 h-3 ${textTertiary}`} />
          <p className={`${textSecondary} truncate`}>
            {album.publishTime ? new Date(album.publishTime).getFullYear() : '未知'}
          </p>
        </div>
        {album.size && (
          <div className="flex items-center gap-2 text-xs mt-1">
            <ListMusic className={`w-3 h-3 ${textTertiary}`} />
            <p className={`${textSecondary}`}>
              {album.size} 首歌曲
            </p>
          </div>
        )}
      </div>
    </motion.div>
  )
})

interface ArtistMvCardProps {
  mv: any
  index: number
  playerTheme: 'light' | 'dark'
  onOpen: (mv: any, index: number) => void
}

// memo MV 卡片：MV 最多 1000 条，避免无关状态变化时整网格重渲染
const ArtistMvCard = memo(function ArtistMvCard({ mv, index, playerTheme, onOpen }: ArtistMvCardProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  return (
    <motion.div
      whileHover={{ scale: 1.03 }}
      onClick={() => onOpen(mv, index)}
      className={`rounded-lg overflow-hidden ${bgCard} cursor-pointer transition-all group`}
    >
      {/* MV封面 */}
      <div className="aspect-video relative overflow-hidden bg-white/5">
        {mv.imgurl16v9 || mv.imgurl ? (
          <CachedImage
            src={mv.imgurl16v9 || mv.imgurl}
            alt={mv.name}
            className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
            fallback={
              <div className="w-full h-full flex items-center justify-center">
                <Video className={`w-12 h-12 ${textPrimary}/20`} />
              </div>
            }
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Video className={`w-12 h-12 ${textPrimary}/20`} />
          </div>
        )}

        {/* 时长标签 */}
        {mv.duration && (
          <div className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white text-xs">
            {formatDuration(mv.duration)}
          </div>
        )}

        {/* 悬停播放按钮 */}
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="w-12 h-12 rounded-full bg-white/90 flex items-center justify-center">
            <Play className="w-6 h-6 text-gray-900 ml-0.5" fill="currentColor" />
          </div>
        </div>
      </div>

      {/* MV信息 */}
      <div className="p-2.5">
        <h3 className={`${textPrimary} font-medium mb-1.5 line-clamp-2 text-sm`}>
          {mv.name}
        </h3>
        <div className="flex items-center gap-3 text-xs">
          {mv.playCount && (
            <div className="flex items-center gap-1">
              <Eye className={`w-3 h-3 ${textTertiary}`} />
              <span className={`${textSecondary}`}>
                {mv.playCount > 10000
                  ? `${(mv.playCount / 10000).toFixed(1)}万`
                  : mv.playCount}
              </span>
            </div>
          )}
          {mv.publishTime && (
            <div className="flex items-center gap-1">
              <Calendar className={`w-3 h-3 ${textTertiary}`} />
              <span className={`${textSecondary}`}>
                {new Date(mv.publishTime).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
})

interface ArtistDetailModalProps {
  artistId: string | number
  platform: MusicPlatform
  onClose: () => void
  onSongSelect?: (song: Song, playlist?: Song[]) => void
  playerTheme?: 'light' | 'dark'
  neteaseVip?: boolean
  qqVip?: boolean
  initialAlbumId?: string | number // 初始打开的专辑ID
  onAlbumOpen?: (albumId: string | number) => void // 当用户打开专辑时的回调
  initialTab?: TabType // 初始标签页
  onTabChange?: (tab: TabType) => void // 标签页变化时的回调
  currentSong?: Song | null // 当前播放的歌曲
  accentColor?: string
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onCopyInfo?: (song: Song) => void
}

export default function ArtistDetailModal({
  artistId,
  platform,
  onClose,
  onSongSelect,
  playerTheme = 'dark',
  neteaseVip = false,
  qqVip = false,
  initialAlbumId,
  onAlbumOpen,
  initialTab = 'hotSongs',
  onTabChange,
  currentSong,
  accentColor = '#ec4899',
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onOpenArtist,
  onCopyInfo
}: ArtistDetailModalProps) {
  // TV 遥控器 BACK：关闭艺人详情弹窗
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const [artist, setArtist] = useState<Artist | null>(null)
  const [hotSongs, setHotSongs] = useState<Song[]>([])
  const [allSongs, setAllSongs] = useState<Song[]>([])
  const [allSongsOffset, setAllSongsOffset] = useState(0) // 全部歌曲的偏移量
  const [allSongsHasMore, setAllSongsHasMore] = useState(true) // 是否还有更多歌曲
  const [albums, setAlbums] = useState<Album[]>([])
  const [mvs, setMvs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingAllSongs, setLoadingAllSongs] = useState(false)
  const [loadingAlbums, setLoadingAlbums] = useState(false)
  const [loadingMVs, setLoadingMVs] = useState(false)
  const [allSongsError, setAllSongsError] = useState<string | null>(null) // 全部歌曲加载错误
  const [hotSongsError, setHotSongsError] = useState<string | null>(null) // 热门歌曲加载错误
  // 汽水仅「精选」标签有数据源，初始标签收敛到精选
  const [activeTab, setActiveTab] = useState<TabType>(platform === 'soda' ? 'hotSongs' : initialTab)
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null)
  const [selectedMV, setSelectedMV] = useState<{ id: number | string; name: string; platform?: 'netease' | 'qq'; index: number } | null>(null)
  /** Apple 音乐视频：站内播放弹窗（webPlayback + HLS） */
  const [appleMvItem, setAppleMvItem] = useState<AppleWebItem | null>(null)
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
  // 选歌播放：退出动画零时长，弹窗当帧卸载。整屏 backdrop-filter 退出节点在播放页
  // 同时挂载时会被 Chromium 保留为残留合成层（首页同款故障），退出动画越久越易触发。
  const [instantClose, setInstantClose] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    show: boolean
    x: number
    y: number
    song: Song | null
    sourceSongs: Song[]
  }>({ show: false, x: 0, y: 0, song: null, sourceSongs: [] })
  const [following, setFollowing] = useState(false)
  const [followingLoading, setFollowingLoading] = useState(false)
  const [followError, setFollowError] = useState('')
  const [similarArtists, setSimilarArtists] = useState<any[]>([])
  const allSongsScrollRef = useRef<HTMLDivElement>(null) // 全部歌曲滚动容器的引用
  const hotSongsScrollRef = useRef<HTMLDivElement>(null) // 热门歌曲滚动容器的引用
  // 虚拟化列表：react-window List 的外层 div 即滚动容器。allSongs 激活时把它的
  // DOM 元素同步进 allSongsScrollRef（供 ScrollToTop/ScrollToCurrentSong 使用），
  // 离开 allSongs 时恢复为外层内容容器。外层容器用函数 ref 保存，避免被覆盖。
  const allSongsOuterRef = useRef<HTMLDivElement | null>(null)
  const allSongsListRef = useRef<ListImperativeAPI | null>(null)
  // 歌曲行固定高度（p-3 上下留白 + 40px 封面）；列表尾部提示条高度
  const ALL_SONG_ROW_HEIGHT = 64
  useEffect(() => {
    if (activeTab !== 'allSongs') return
    const listEl = allSongsListRef.current?.element ?? null
    if (listEl) allSongsScrollRef.current = listEl
    return () => {
      allSongsScrollRef.current = allSongsOuterRef.current
    }
  }, [activeTab, allSongs.length])
  
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  // 汽水暂无本地会员态：按非会员处理，Song.vip 为真的曲目始终显示 VIP 徽标
  const isVip = platform === 'netease' ? neteaseVip : platform === 'qq' ? qqVip : false
  const readableAccentColor = getReadableAccentColor(accentColor, '#dbeafe')

  // 格式化粉丝数显示
  const formatFansCount = (fans: number): string => {
    if (fans >= 10000) {
      return `${(fans / 10000).toFixed(1)}万`
    }
    return fans.toString()
  }

  // 关注/取关歌手
  const handleFollow = async () => {
    if (followingLoading || !artist) return
    setFollowingLoading(true)
    setFollowError('')
    try {
      const id = platform === 'qq' ? String(artist.mid || artist.id) : String(artist.id)
      await subscribeArtist(id, !following, platform)
      setFollowing(!following)
    } catch (error) {
      // 静默失败会让用户以为点按无效（QQ 关注接口仅支持部分登录方式）
      const message = error instanceof Error ? error.message : '关注歌手失败'
      setFollowError(message.includes('请使用网易云') ? message : `${message}，可尝试在网易云音乐中关注`)
    }
    finally { setFollowingLoading(false) }
  }

  // 拉取相似歌手
  useEffect(() => {
    let cancelled = false
    const fetch = async () => {
      if (!artist || platform === 'apple' || platform === 'soda') return
      try {
        const id = platform === 'qq' ? String(artist.mid || artist.id) : String(artist.id)
        const data = await getSimilarArtists(id, platform)
        if (!cancelled && data) {
          const list = data.artists || data.data?.list || data.data?.artists || []
          setSimilarArtists(list.slice(0, 8))
        }
      } catch { /* ignore */ }
    }
    fetch()
    return () => { cancelled = true }
  }, [artist, platform])

  // 判断是否是当前播放的歌曲
  const isCurrentSong = (song: Song) => isSameSong(currentSong, song)

  // 查找当前播放歌曲在热门歌曲列表中的索引
  const currentHotSongIndex = hotSongs.findIndex(song => isCurrentSong(song))
  
  // 查找当前播放歌曲在全部歌曲列表中的索引
  const currentAllSongIndex = allSongs.findIndex(song => isCurrentSong(song))

  const handleContextMenu = (e: React.MouseEvent, song: Song, sourceSongs: Song[]) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ show: true, x: e.clientX, y: e.clientY, song, sourceSongs })
  }

  useEffect(() => {
    // Apple：右键菜单歌单用资料库歌单（amp-api）
    if (platform === 'apple') {
      void getAppleLibraryPlaylists(100)
        .then(setUserPlaylists)
        .catch(() => setUserPlaylists([]))
      return
    }
    // Spotify / 汽水：歌单列表由平台自身登录态驱动（Spotify token / 汽水 soda_token cookie），
    // 不依赖本地 userId；未登录或接口失败时 fetchUserPlaylists 返回空数组，
    // 右键「添加到」自然保持为空。汽水已登录时 platforms.addTracksToPlaylist=true，
    // 真实自建歌单可经 addSodaSongToPlaylist 加歌。
    if (platform === 'spotify' || platform === 'soda') {
      void getUserPlaylists(platform, '')
        .then(list => setUserPlaylists(Array.isArray(list) ? list : []))
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

  useEffect(() => {
    // 清空所有数据，准备加载新艺人
    setArtist(null)
    setHotSongs([])
    setAllSongs([])
    setAllSongsOffset(0)
    setAllSongsHasMore(true)
    setAlbums([])
    setMvs([])
    
    // 加载新艺人数据
    loadArtistData()

    // 恢复来源/记忆的标签页（initialTab，含 全部歌曲/MV/相似歌手/详情/专辑）；
    // 无显式初始标签时默认 'hotSongs'，与"每次打开回精选"的原行为一致。
    // 不能写死 'hotSongs'：否则从播放页返回（home 恢复）时所有标签都被重置回精选。
    setActiveTab(platform === 'soda' ? 'hotSongs' : initialTab)
  }, [artistId, platform])

  // 如果有初始专辑ID，加载专辑数据后自动打开该专辑
  useEffect(() => {
    if (initialAlbumId && albums.length > 0) {
      // 与 handleAlbumOpen 的 onAlbumOpen(album.mid || album.id) 保持同一键序：
      // 优先 mid（QQ 专辑 mid 为字符串 id），并 String 归一，避免 id/mid 数字字符串不一致匹配失败
      const album = albums.find(a => String(a.mid || a.id) === String(initialAlbumId))
      if (album) {
        setSelectedAlbum(album)
        setActiveTab('albums') // 切换到专辑标签
      }
    }
  }, [initialAlbumId, albums])

  // 当切换到"全部歌曲"标签时加载数据
  useEffect(() => {
    if (activeTab === 'allSongs' && allSongs.length === 0 && !loadingAllSongs) {
      loadAllSongs(true) // 首次加载
    }
    if (activeTab === 'albums' && albums.length === 0 && !loadingAlbums) {
      loadAlbums()
    }
    if (activeTab === 'videos' && mvs.length === 0 && !loadingMVs) {
      loadMVs()
    }
  }, [activeTab, artistId, platform])

  // 通知父组件标签页变化
  useEffect(() => {
    if (onTabChange) {
      onTabChange(activeTab)
    }
  }, [activeTab, onTabChange])

  const loadArtistData = async () => {
    setLoading(true)
    setHotSongsError(null) // 清除之前的错误
    try {
      // Apple：iTunes Lookup 返回艺人信息 + 热门歌曲（免 token）；
      // 目录接口补 简介/高清封面，相关艺人尽力而为
      if (platform === 'apple') {
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const [detail, catalog, related] = await Promise.allSettled([
          getAppleArtistDetail(String(artistId), storefront),
          getAppleCatalogArtist(String(artistId), storefront),
          getAppleCatalogRelatedArtists(String(artistId), storefront),
        ])
        if (detail.status === 'fulfilled' && detail.value) {
          const d = detail.value
          setArtist({
            id: Number(d.artist.id) || 0,
            name: d.artist.name,
            picUrl: (catalog.status === 'fulfilled' && catalog.value?.artworkUrl) || d.artist.artworkUrl || '',
            description: catalog.status === 'fulfilled' ? catalog.value?.bio : undefined,
            platform: 'apple',
          })
          setHotSongs(d.topSongs.map(song => appleSongToSong(song, storefront)))
        } else {
          setHotSongsError('未找到该 Apple 艺人')
        }
        if (related.status === 'fulfilled') {
          setSimilarArtists(related.value.map(ra => ({ id: ra.id, name: ra.name, picUrl: ra.artworkUrl })))
        }
        setLoading(false)
        return
      }
      // 汽水音乐：逆向无艺人详情接口，不做额外请求——外部把「歌手名」当 artistId 传入，
      // 直接以名字构造头部信息；热门歌曲走 fetchSodaArtistSongs（上限 50，
      // 服务内部降级不抛错，失败/无结果返回空数组 → 复用「暂无热门歌曲」空态文案）
      if (platform === 'soda') {
        const name = decodeSodaName(String(artistId))
        setArtist({ id: 0, name, picUrl: '', platform: 'soda' })
        const songs = await fetchSodaArtistSongs(name, 50)
        setHotSongs(songs)
        return
      }
      const [artistData, songsData] = await Promise.all([
        getArtistDetail(artistId, platform),
        getArtistTopSongs(artistId, platform)
      ])
      console.log('🎵 [ArtistDetailModal] 加载艺人数据完成')
      console.log('  艺人信息:', artistData)
      console.log('  艺人粉丝数 artistData.fans:', artistData?.fans, typeof artistData?.fans)
      console.log('  粉丝数检查条件:', {
        'fans !== undefined': artistData?.fans !== undefined,
        'fans > 0': artistData && (artistData.fans ?? 0) > 0,
        'fans值': artistData?.fans
      })
      console.log('  热门歌曲数量:', songsData.length)
      console.log('  热门歌曲前3首:', songsData.slice(0, 3))
      setArtist(artistData)
      setHotSongs(songsData)
      console.log('🎵 [ArtistDetailModal] State已更新, hotSongs.length:', songsData.length)
    } catch (error) {
      console.error('加载艺人详情失败:', error)
      setHotSongsError('网络错误，请稍后重试')
    } finally {
      setLoading(false)
    }
  }

  // 打开歌手详情时按当前账号是否已关注初始化按钮状态（QQ 传 mid，网易云传数字 id）；
  // 汽水无关注查询接口，跳过（按钮本身也不渲染）
  useEffect(() => {
    if (!artist || platform === 'apple' || platform === 'soda' || platform === 'kugou') return
    let cancelled = false
    const id = platform === 'qq' ? String(artist.mid || artist.id) : String(artist.id)
    setFollowing(false)
    setFollowError('')
    void isArtistFollowed(id, platform).then((followed) => {
      if (!cancelled) setFollowing(followed)
    })
    return () => { cancelled = true }
  }, [artist, platform])

  const loadAllSongs = async (reset: boolean = false) => {
    if (loadingAllSongs) return
    
    setLoadingAllSongs(true)
    setAllSongsError(null) // 清除之前的错误
    try {
      const offset = reset ? 0 : allSongsOffset
      const limit = 200 // 每次加载200首
      
      console.log(`📀 [ArtistDetailModal] 加载全部歌曲, offset: ${offset}, limit: ${limit}, platform: ${platform}`)
      
      let formattedSongs: Song[] = []
      let total = 0
      let hasMore = false
      
      if (platform === 'netease') {
        // 网易云音乐：调用全部歌曲接口
        const response = await fetch(`http://localhost:3001/api/netease/artist/songs?id=${artistId}&limit=${limit}&offset=${offset}`)
        const data = await response.json()
        
        // 检查是否有错误
        if (data.error && data.songs.length === 0) {
          console.error(`📀 [ArtistDetailModal] 加载失败: ${data.error}`)
          setAllSongsError('网络错误，加载失败')
          setLoadingAllSongs(false)
          return
        }
        
        const newSongs = data.songs || []
        total = data.total || newSongs.length
        hasMore = data.more || false
        
        console.log(`📀 [ArtistDetailModal] 网易云获取到 ${newSongs.length} 首歌曲, 总数: ${total}`)
        console.log(`📀 [ArtistDetailModal] 前3首歌曲:`, newSongs.slice(0, 3).map((s: any) => ({
          id: s.id,
          name: s.name,
          artists: s.ar?.map((a: any) => a.name).join(', ')
        })))
        
        // 转换格式
        formattedSongs = newSongs.map((item: any) => ({
          id: item.id,
          name: item.name,
          artists: item.ar || item.artists || [],
          album: {
            id: item.al?.id || item.album?.id,
            name: item.al?.name || item.album?.name || '',
            picUrl: item.al?.picUrl || item.album?.picUrl || ''
          },
          duration: item.dt || item.duration || 0,
          platform: 'netease' as const,
          vip: item.fee === 1 || item.fee === 4,
          noCopyright: item.privilege?.st < 0 || item.privilege?.playMaxbr === 0
        }))
      } else {
        // QQ音乐：调用后端API，传入offset和limit（使用mid参数）
        const response = await fetch(`http://localhost:3001/api/qq/artist/songs?mid=${artistId}&limit=${limit}`)
        const data = await response.json()
        const newSongs = data.songs || []
        total = data.total || 0
        
        console.log(`📀 [ArtistDetailModal] QQ音乐获取到 ${newSongs.length} 首歌曲, 总数: ${total}`)
        
        // 转换格式（后端已经返回标准化的格式）
        formattedSongs = newSongs.map((item: any) => ({
          id: item.songid,
          mid: item.songmid,
          name: item.songname,
          artists: item.singer?.map((s: any) => ({ name: s.name, mid: s.mid })) || [],
          album: {
            id: item.albumid,
            mid: item.albummid,
            name: item.albumname || '',
            picUrl: item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : ''
          },
          duration: item.interval * 1000,
          platform: 'qq' as const,
          vip: item.pay?.payplay === 1
        }))
      }
      
      if (reset) {
        setAllSongs(formattedSongs)
        setAllSongsOffset(formattedSongs.length)
      } else {
        setAllSongs(prev => [...prev, ...formattedSongs])
        setAllSongsOffset(prev => prev + formattedSongs.length)
      }
      
      // 检查是否还有更多歌曲
      if (platform === 'netease') {
        setAllSongsHasMore(hasMore)
      } else {
        const currentTotal = reset ? formattedSongs.length : allSongsOffset + formattedSongs.length
        setAllSongsHasMore(currentTotal < total)
      }
      
    } catch (error) {
      console.error('加载艺人全部歌曲失败:', error)
      setAllSongsError('网络错误，请稍后重试')
    } finally {
      setLoadingAllSongs(false)
    }
  }

  const loadAlbums = async () => {
    setLoadingAlbums(true)
    try {
      console.log('📀 [ArtistDetailModal] 加载专辑:', artistId, platform)

      // Apple：目录艺人专辑（amp-api catalog artists/{id}/albums）
      if (platform === 'apple') {
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const albumsData = await getAppleCatalogArtistAlbums(String(artistId), storefront, 200)
        setAlbums(albumsData.map(album => ({
          id: Number(album.id) || 0,
          name: album.name,
          picUrl: album.artworkUrl || '',
          artist: { name: album.artistName },
          publishTime: album.releaseDate ? Date.parse(album.releaseDate) : undefined,
          size: album.trackCount,
          platform: 'apple' as const,
        })))
        setLoadingAlbums(false)
        return
      }

      // 分页加载所有专辑
      let allAlbums: Album[] = []
      let page = 0
      const pageSize = 100
      let hasMore = true
      
      while (hasMore) {
        const albumsData = await getArtistAlbums(artistId, platform, pageSize, page * pageSize)
        console.log(`📀 [ArtistDetailModal] 第${page + 1}页专辑数据:`, albumsData.length)
        
        if (albumsData.length > 0) {
          allAlbums = [...allAlbums, ...albumsData]
          page++
          
          // 如果返回的数量少于pageSize，说明没有更多了
          if (albumsData.length < pageSize) {
            hasMore = false
          }
        } else {
          hasMore = false
        }
        
        // 为了避免无限循环，最多加载10页
        if (page >= 10) {
          hasMore = false
        }
      }
      
      console.log('📀 [ArtistDetailModal] 专辑总数:', allAlbums.length)
      setAlbums(allAlbums)
    } catch (error) {
      console.error('加载艺人专辑失败:', error)
    } finally {
      setLoadingAlbums(false)
    }
  }

  const loadMVs = async () => {
    setLoadingMVs(true)
    try {
      console.log('🎬 [ArtistDetailModal] 加载MV:', artistId, platform)

      // Apple：目录艺人音乐视频（amp-api catalog artists/{id}/music-videos）
      if (platform === 'apple') {
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const videos = await getAppleCatalogArtistMusicVideos(String(artistId), storefront, 100)
        setMvs(videos.map(video => ({
          id: video.id,
          name: video.name,
          imgurl16v9: video.artworkUrl || '',
          imgurl: video.artworkUrl || '',
          duration: video.durationMs,
          artist: video.artistName,
          platform: 'apple' as const,
        })))
        setLoadingMVs(false)
        return
      }

      // 分页加载所有MV
      let allMVs: any[] = []
      let page = 0
      const pageSize = 100
      let hasMore = true
      
      while (hasMore) {
        const mvsData = await getArtistMVs(artistId, platform, pageSize, page * pageSize)
        console.log(`🎬 [ArtistDetailModal] 第${page + 1}页MV数据:`, mvsData.length)
        
        if (mvsData.length > 0) {
          allMVs = [...allMVs, ...mvsData]
          page++
          
          // 如果返回的数量少于pageSize，说明没有更多了
          if (mvsData.length < pageSize) {
            hasMore = false
          }
        } else {
          hasMore = false
        }
        
        // 为了避免无限循环，最多加载10页
        if (page >= 10) {
          hasMore = false
        }
      }
      
      console.log('🎬 [ArtistDetailModal] MV总数:', allMVs.length)
      setMvs(allMVs)
    } catch (error) {
      console.error('加载艺人MV失败:', error)
    } finally {
      setLoadingMVs(false)
    }
  }

  // 处理滚动事件，检测是否到达底部
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (activeTab !== 'allSongs' || !allSongsHasMore || loadingAllSongs) return
    
    const target = e.currentTarget
    const scrollTop = target.scrollTop
    const scrollHeight = target.scrollHeight
    const clientHeight = target.clientHeight
    
    // 当滚动到距离底部200px时，加载更多
    if (scrollHeight - scrollTop - clientHeight < 200) {
      console.log('📀 [ArtistDetailModal] 触发加载更多')
      loadAllSongs(false)
    }
  }

  const handlePlayAll = () => {
    // 播放全部按钮始终播放热门歌曲
    if (hotSongs.length > 0 && onSongSelect) {
      setInstantClose(true)
      onSongSelect(hotSongs[0], hotSongs)
      onClose()
    }
  }

  // 稳定回调：供 memo 列表项使用，保证父级重渲染时回调引用不变
  const handleSongRowSelect = useCallback((song: Song) => {
    if (onSongSelect) {
      // 区分来源：全部歌曲使用 allSongs 队列，热门歌曲使用 hotSongs 队列
      const sourceSongs = allSongs.includes(song) ? allSongs : hotSongs
      setInstantClose(true)
      onSongSelect(song, sourceSongs)
      onClose()
    }
  }, [onSongSelect, allSongs, hotSongs, onClose])

  const handleSongContextMenu = useCallback((event: React.MouseEvent, song: Song) => {
    handleContextMenu(event, song, allSongs.includes(song) ? allSongs : hotSongs)
  }, [allSongs, hotSongs])

  const handleAlbumOpen = useCallback((album: Album) => {
    setSelectedAlbum(album)
    // 通知父组件专辑被打开
    if (onAlbumOpen) {
      // QQ音乐必须使用 mid (字符串格式)，网易云使用 id
      onAlbumOpen(album.mid || album.id!)
    }
  }, [onAlbumOpen])

  const handleMvOpen = useCallback((mv: any, index: number) => {
    // Apple 音乐视频：站内播放弹窗（webPlayback + HLS + Widevine）
    if (platform === 'apple') {
      setAppleMvItem({
        id: String(mv.id || ''),
        playId: String(mv.id || ''),
        type: 'music-videos',
        name: mv.name || '',
        artistName: mv.artist || '',
        artworkUrl: mv.imgurl16v9 || mv.imgurl || '',
      })
      return
    }
    setSelectedMV({ id: mv.id, name: mv.name, platform: mv.platform, index })
  }, [platform])

  // 使用艺人头像作为背景
  const backgroundImage = artist?.picUrl || ''

  return (
    <>
      {/* 全屏背景层 - 透明+模糊+暗化 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={instantClose ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
        className="fixed inset-0 z-[70]"
        style={{ 
          pointerEvents: 'none',
          backdropFilter: 'blur(4px) brightness(0.95)',
          WebkitBackdropFilter: 'blur(4px) brightness(0.95)',
          backgroundColor: 'rgba(0, 0, 0, 0.05)'
        }}
      />
      
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={instantClose ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
        className="fixed inset-0 z-[71] flex items-center justify-center p-8"
        onClick={() => {
          // 当子模态框（专辑详情或视频播放器）打开时，不响应背景点击
          // 避免误触导致关闭艺人详情
          if (selectedAlbum || selectedMV) {
            return
          }
          onClose()
        }}
      >
        <motion.div
          data-tv-scope
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={instantClose ? { scale: 0.9, opacity: 0, transition: { duration: 0 } } : { scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="rounded-3xl shadow-2xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden relative"
        >
        
        {/* 液态玻璃背景层 - 使用艺人头像，只在弹窗内部 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden">
          {/* 艺人头像背景 */}
          {backgroundImage && (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{
                backgroundImage: `url(${getProxiedImageUrl(backgroundImage)})`,
                filter: 'blur(40px) brightness(0.6)',
              }}
            />
          )}
        
          {/* 液态玻璃效果 */}
          <div
            className="absolute inset-0"
            style={{
              background: playerTheme === 'dark' 
                ? 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)'
                : 'linear-gradient(135deg, rgba(255,255,255,0.3) 0%, rgba(240,240,245,0.5) 50%, rgba(255,255,255,0.4) 100%)',
              backdropFilter: 'blur(80px) saturate(200%)',
              WebkitBackdropFilter: 'blur(80px) saturate(200%)',
            }}
          />
          
          {/* 动态光晕 */}
          <motion.div
            className="absolute w-[500px] h-[500px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(59, 130, 246, 0.2) 0%, transparent 70%)',
              filter: 'blur(60px)',
              top: '-10%',
              left: '-5%',
            }}
            animate={{
              x: [0, 50, 0],
              y: [0, 30, 0],
              scale: [1, 1.1, 1],
            }}
            transition={{
              duration: 15,
              repeat: Infinity,
              ease: 'easeInOut',
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
        <div className="relative z-10 flex flex-col h-full">
          {/* 头部 - 艺人信息 */}
          <div className={`p-6 border-b ${borderColor} flex-shrink-0`}>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader className={`w-6 h-6 ${textPrimary} animate-spin`} />
              </div>
            ) : artist ? (
              <div className="flex gap-4 relative">
                {/* 艺人头像 */}
                <div className="w-28 h-28 rounded-full overflow-hidden bg-white/5 flex-shrink-0 shadow-xl">
                  {artist.picUrl ? (
                    <CachedImage 
                      src={getProxiedImageUrl(artist.picUrl)}
                      alt={artist.name}
                      className="w-full h-full object-cover"
                      fallback={
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className={`w-10 h-10 ${textPrimary}/20`} />
                        </div>
                      }
                    />
                  ) : platform === 'soda' ? (
                    // 汽水无艺人头像数据：歌手名首字符占位块（半透明渐变底，贴现有深色主题）
                    <div className={`w-full h-full flex items-center justify-center bg-gradient-to-br ${playerTheme === 'dark' ? 'from-white/15 to-white/5' : 'from-black/10 to-black/5'}`}>
                      <span className={`text-4xl font-bold select-none ${playerTheme === 'dark' ? 'text-white/70' : 'text-black/50'}`}>
                        {[...(artist.name || '?').trim()][0] || '?'}
                      </span>
                    </div>
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Music className={`w-10 h-10 ${textPrimary}/20`} />
                    </div>
                  )}
                </div>

                {/* 艺人信息 */}
                <div className="flex-1 flex flex-col justify-center min-w-0">
                  <div className="flex items-baseline gap-2 mb-2 flex-wrap">
                    <h1 className={`text-2xl font-bold ${textPrimary} truncate`}>
                      {artist.name}
                    </h1>
                    {artist.alias && Array.isArray(artist.alias) && artist.alias.length > 0 && (
                      <span className={`text-sm ${textSecondary} truncate`}>
                        {artist.alias.join(' / ')}
                      </span>
                    )}
                  </div>
                  
                  {/* 艺人详细信息 */}
                  <div className={`${textSecondary} text-sm space-y-1 mb-3`}>
                    {/* 歌曲数、专辑数 */}
                    <div className="flex gap-3 flex-wrap">
                      {artist.musicSize !== undefined && (
                        <span>歌曲: {artist.musicSize}</span>
                      )}
                      {artist.albumSize !== undefined && (
                        <span>专辑: {artist.albumSize}</span>
                      )}
                    </div>
                  </div>

                  {/* 播放按钮和关注 */}
                  <div className="flex items-center justify-between w-full">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handlePlayAll}
                        className="px-6 py-2 text-white rounded-full font-medium transition-all flex items-center gap-2 w-fit text-sm"
                        style={{
                          backgroundColor: `${readableAccentColor}e6`,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = readableAccentColor}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = `${readableAccentColor}e6`}
                      >
                        <Play className="w-4 h-4" fill="currentColor" />
                        播放全部
                      </button>
                      {/* 汽水无关注/订阅歌手接口，不渲染「关注」按钮 */}
                      {platform !== 'apple' && platform !== 'soda' && platform !== 'kugou' && (
                      <button
                        onClick={handleFollow}
                        disabled={followingLoading}
                        className={`px-3 py-2 rounded-full font-medium transition-all flex items-center gap-1.5 text-sm ${
                          following ? 'text-white' : 'text-white/80 hover:text-white'
                        }`}
                        style={{
                          backgroundColor: following ? `${readableAccentColor}` : 'rgba(255,255,255,0.12)',
                        }}
                      >
                        {following ? <UserCheck className="w-4 h-4" /> : <UserPlus className="w-4 h-4" />}
                        {following ? '已关注' : '关注'}
                      </button>
                      )}
                    </div>
                    
                    {/* 粉丝数徽章 */}
                    {artist.fans !== undefined && artist.fans > 0 && (
                      <motion.div
                        initial={{ opacity: 0, scale: 0.8 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.3, delay: 0.2 }}
                      >
                        <div className={`${bgCard} backdrop-blur-md rounded-2xl px-5 py-2.5 shadow-lg border ${borderColor} hover:scale-105 transition-transform`}>
                          <div className="flex items-center gap-3">
                            <div className={`p-1.5 rounded-full ${playerTheme === 'dark' ? 'bg-pink-500/20' : 'bg-pink-500/10'}`}>
                              <Users className="w-4 h-4 text-pink-500" />
                            </div>
                            <div className="text-left">
                              <div className={`text-xs ${textTertiary} font-medium leading-tight`}>粉丝</div>
                              <div className={`text-base font-bold ${textPrimary} leading-tight`}>
                                {formatFansCount(artist.fans)}
                              </div>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </div>

                  {/* 关注失败提示（QQ 关注接口仅支持部分登录方式） */}
                  {followError && (
                    <p className="mt-2 text-xs text-red-400" role="alert">
                      {followError}
                    </p>
                  )}
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
          <div className={`flex gap-4 px-6 pt-3 border-b ${borderColor} flex-shrink-0`}>
            <button
              onClick={() => setActiveTab('hotSongs')}
              className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                activeTab === 'hotSongs'
                  ? `${textPrimary}`
                  : `${textSecondary} hover:${textPrimary}`
              }`}
            >
              <Music className="w-4 h-4 inline mr-1.5" />
              精选
              {activeTab === 'hotSongs' && (
                <motion.div
                   
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: readableAccentColor }}
                />
              )}
            </button>
            {/* 汽水无艺人专辑列表接口，不显示「专辑」标签 */}
            {platform !== 'soda' && (
            <button
              onClick={() => setActiveTab('albums')}
              className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                activeTab === 'albums'
                  ? `${textPrimary}`
                  : `${textSecondary} hover:${textPrimary}`
              }`}
            >
              <Disc className="w-4 h-4 inline mr-1.5" />
              专辑
              {activeTab === 'albums' && (
                <motion.div
                   
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: readableAccentColor }}
                />
              )}
            </button>
            )}
            {/* 汽水无 MV 数据源，不显示「视频」标签 */}
            {platform !== 'soda' && platform !== 'kugou' && (
            <button
              onClick={() => setActiveTab('videos')}
              className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                activeTab === 'videos'
                  ? `${textPrimary}`
                  : `${textSecondary} hover:${textPrimary}`
              }`}
            >
              <Video className="w-4 h-4 inline mr-1.5" />
              视频
              {activeTab === 'videos' && (
                <motion.div
                   
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: readableAccentColor }}
                />
              )}
            </button>
            )}
            {/* 汽水仅能按名检索热门歌曲（无全量分页接口），不显示「全部歌曲」标签 */}
            {platform !== 'apple' && platform !== 'soda' && (
            <button
              onClick={() => setActiveTab('allSongs')}
              className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                activeTab === 'allSongs'
                  ? `${textPrimary}`
                  : `${textSecondary} hover:${textPrimary}`
              }`}
            >
              <ListMusic className="w-4 h-4 inline mr-1.5" />
              全部歌曲
              {activeTab === 'allSongs' && (
                <motion.div
                   
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: readableAccentColor }}
                />
              )}
            </button>
            )}

            {/* 相似歌手 — 仅在获取到相似歌手后显示 */}
            {similarArtists.length > 0 && (
              <button
                onClick={() => setActiveTab('similarArtists')}
                className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                  activeTab === 'similarArtists'
                    ? `${textPrimary}`
                    : `${textSecondary} hover:${textPrimary}`
                }`}
              >
                <Users className="w-4 h-4 inline mr-1.5" />
                相似歌手
                {activeTab === 'similarArtists' && (
                  <div
                    className="absolute bottom-0 left-0 right-0 h-0.5"
                    style={{ backgroundColor: readableAccentColor }}
                  />
                )}
              </button>
            )}
            
            {/* 弹性空间，将歌手详情推到右边 */}
            <div className="flex-1"></div>
            
            <button
              onClick={() => setActiveTab('info')}
              className={`pb-3 px-3 font-medium transition-all relative text-sm ${
                activeTab === 'info'
                  ? `${textPrimary}`
                  : `${textSecondary} hover:${textPrimary}`
              }`}
            >
              <Info className="w-4 h-4 inline mr-1.5" />
              歌手详情
              {activeTab === 'info' && (
                <motion.div
                   
                  className="absolute bottom-0 left-0 right-0 h-0.5"
                  style={{ backgroundColor: readableAccentColor }}
                />
              )}
            </button>
          </div>

          {/* 内容区（添加滚动） */}
          <div 
            ref={(el) => { allSongsOuterRef.current = el }}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto p-4 custom-scrollbar"
            style={{
              scrollbarWidth: 'thin',
              scrollbarColor: playerTheme === 'dark' 
                ? 'rgba(255,255,255,0.3) rgba(255,255,255,0.05)' 
                : 'rgba(0,0,0,0.3) rgba(0,0,0,0.05)'
            }}
          >
            <style>{`
              .custom-scrollbar::-webkit-scrollbar {
                width: 8px;
              }
              .custom-scrollbar::-webkit-scrollbar-track {
                background: ${playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'};
                border-radius: 4px;
              }
              .custom-scrollbar::-webkit-scrollbar-thumb {
                background: ${playerTheme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)'};
                border-radius: 4px;
              }
              .custom-scrollbar::-webkit-scrollbar-thumb:hover {
                background: ${playerTheme === 'dark' ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)'};
              }
            `}</style>
            {/* 热门歌曲 */}
            {activeTab === 'hotSongs' && (
              <div className="space-y-1" ref={hotSongsScrollRef}>
                {hotSongs.length > 0 ? (
                  <>
                    {hotSongs.map((song, index) => (
                      <ArtistSongRow
                        key={`hot-song-${song.platform}-${song.mid || song.id}-${index}`}
                        song={song}
                        index={index}
                        isCurrent={isCurrentSong(song)}
                        playerTheme={playerTheme}
                        accentColor={accentColor}
                        readableAccentColor={readableAccentColor}
                        isVip={isVip}
                        onSelect={handleSongRowSelect}
                        onContextMenu={handleSongContextMenu}
                      />
                    ))}
                  </>
                ) : hotSongsError ? (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Music className="w-16 h-16 mb-4 opacity-20" />
                    <p className="mb-4">{hotSongsError}</p>
                    <button
                      onClick={() => loadArtistData()}
                      className="px-4 py-2 rounded-lg hover:opacity-80 transition-opacity"
                      style={{ backgroundColor: accentColor, color: 'white' }}
                    >
                      重试
                    </button>
                  </div>
                ) : (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Music className="w-16 h-16 mb-4 opacity-20" />
                    <p>暂无热门歌曲</p>
                  </div>
                )}
              </div>
            )}

            {/* 全部歌曲 */}
            {activeTab === 'allSongs' && (
              <div className="space-y-1">
                {allSongs.length > 0 ? (
                  <>
                    {/* 全部歌曲虚拟化列表：仅渲染可视区行 + overscan，千级列表不再全量挂载 DOM */}
                    <List<AllSongsRowData>
                      listRef={allSongsListRef}
                      className="custom-scrollbar"
                      style={{ height: '100%', width: '100%' }}
                      onScroll={handleScroll}
                      rowCount={allSongs.length + 1}
                      rowHeight={ALL_SONG_ROW_HEIGHT}
                      overscanCount={10}
                      rowComponent={AllSongsRow}
                      rowProps={{
                        songs: allSongs,
                        currentSong,
                        playerTheme,
                        accentColor,
                        readableAccentColor,
                        isVip,
                        onSelect: handleSongRowSelect,
                        onContextMenu: handleSongContextMenu,
                        loading: loadingAllSongs,
                        hasMore: allSongsHasMore,
                        textPrimary,
                        textSecondary,
                        textTertiary,
                      }}
                    />
                  </>
                ) : loadingAllSongs ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader className={`w-8 h-8 ${textPrimary}/60 animate-spin`} />
                    <p className={`${textSecondary} mt-4`}>加载中...</p>
                  </div>
                ) : allSongsError ? (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Music className="w-16 h-16 mb-4 opacity-20" />
                    <p className="mb-4">{allSongsError}</p>
                    <button
                      onClick={() => loadAllSongs(true)}
                      className="px-4 py-2 rounded-lg hover:opacity-80 transition-opacity"
                      style={{ backgroundColor: accentColor, color: 'white' }}
                    >
                      重试
                    </button>
                  </div>
                ) : (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Music className="w-16 h-16 mb-4 opacity-20" />
                    <p>暂无歌曲</p>
                  </div>
                )}
              </div>
            )}

            {/* 专辑 */}
            {activeTab === 'albums' && (
              <div className="space-y-2">
                {loadingAlbums ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader className={`w-8 h-8 ${textPrimary}/60 animate-spin`} />
                    <p className={`${textSecondary} mt-4`}>加载中...</p>
                  </div>
                ) : albums.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {albums.slice(0, 100).map((album) => (
                      <ArtistAlbumCard
                        key={`album-${album.platform}-${album.mid || album.id}`}
                        album={album}
                        playerTheme={playerTheme}
                        onOpen={handleAlbumOpen}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Disc className="w-16 h-16 mb-4 opacity-20" />
                    <p>暂无专辑</p>
                  </div>
                )}
              </div>
            )}

            {/* 视频 */}
            {activeTab === 'videos' && (
              <div className="space-y-2">
                {loadingMVs ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader className={`w-8 h-8 ${textPrimary}/60 animate-spin`} />
                    <p className={`${textSecondary} mt-4`}>加载中...</p>
                  </div>
                ) : mvs.length > 0 ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {mvs.slice(0, 100).map((mv, index) => (
                      <ArtistMvCard
                        key={`mv-${mv.platform}-${mv.id}-${index}`}
                        mv={mv}
                        index={index}
                        playerTheme={playerTheme}
                        onOpen={handleMvOpen}
                      />
                    ))}
                  </div>
                ) : (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Video className="w-16 h-16 mb-4 opacity-20" />
                    <p>暂无视频</p>
                  </div>
                )}
              </div>
            )}

            {/* 相似歌手 */}
            {activeTab === 'similarArtists' && (
              <div className={`${textPrimary} space-y-4`}>
                {similarArtists.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {similarArtists.map((sa: any, i: number) => {
                      const name = sa.name || sa.artistName || ''
                      // QQ: sa.pic_url || sa.picurl; 网易云: sa.img1v1Url || sa.picUrl
                      const pic = sa.pic_url || sa.picurl || sa.img1v1Url || sa.picUrl || sa.artistPic || sa.singer_pic || sa.headPic || sa.singerPic || sa.pic || sa.avatarUrl || ''
                      const saId = sa.id || sa.artistId || sa.singer_id || 0
                      const saMid = sa.mid || sa.singer_mid || ''
                      return (
                        <button
                          key={saId || i}
                          onClick={() => {
                            if (onOpenArtist) {
                              const id = platform === 'qq' ? String(saMid || saId) : String(saId)
                              onOpenArtist(id, platform)
                            }
                          }}
                          className="flex flex-col items-center gap-2 p-3 rounded-xl transition-colors hover:bg-white/10 text-left"
                        >
                          <div className="w-20 h-20 rounded-full overflow-hidden bg-white/10 shrink-0">
                            {pic ? (
                              <img src={getProxiedImageUrl(pic, 150)} alt={name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center"><Music className="w-6 h-6 text-white/40" /></div>
                            )}
                          </div>
                          <span className={`text-xs text-center truncate w-full ${textSecondary}`}>{name}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div className={`flex flex-col items-center justify-center py-20 ${textSecondary}`}>
                    <Users className="w-16 h-16 mb-4 opacity-20" />
                    <p>暂无相似歌手</p>
                  </div>
                )}
              </div>
            )}

            {/* 详情 */}
            {activeTab === 'info' && artist && (
              <div className={`${textPrimary} space-y-6`}>
                {/* 简要描述 */}
                {(artist.description || artist.briefDesc) && (
                  <div>
                    <h3 className="text-xl font-bold mb-3">艺人简介</h3>
                    <p className={`${textSecondary} leading-relaxed whitespace-pre-wrap`}>
                      {artist.description || artist.briefDesc}
                    </p>
                  </div>
                )}

                {/* QQ音乐基本资料 */}
                {artist.platform === 'qq' && artist.basic && artist.basic.item && artist.basic.item.length > 0 && (
                  <div>
                    <h3 className="text-xl font-bold mb-3">基本资料</h3>
                    <div className={`${bgCard} rounded-xl p-4 space-y-2.5`}>
                      {artist.basic.item.map((info: any, index: number) => (
                        <div key={index} className="flex">
                          <span className={`${textSecondary} w-24 flex-shrink-0`}>{info.key}：</span>
                          <span className={`${textPrimary} flex-1`}>{info.value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* QQ音乐其他信息（从艺历程、荣誉记录等） */}
                {artist.platform === 'qq' && artist.other && artist.other.item && artist.other.item.length > 0 && (
                  <div className="space-y-6">
                    {artist.other.item.map((section: any, index: number) => (
                      <div key={index}>
                        <h3 className="text-xl font-bold mb-3">{section.key}</h3>
                        <p className={`${textSecondary} leading-relaxed whitespace-pre-wrap`}>
                          {section.value}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* 网易云音乐详细介绍（经历等） */}
                {artist.platform === 'netease' && artist.intro && artist.intro.length > 0 && (
                  <div className="space-y-6">
                    {artist.intro.map((section, index) => (
                      <div key={index}>
                        <h3 className="text-xl font-bold mb-3">{section.ti}</h3>
                        <p className={`${textSecondary} leading-relaxed whitespace-pre-wrap`}>
                          {section.txt}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* 相似歌手 */}
                {similarArtists.length > 0 && (
                  <div>
                    <h3 className="text-xl font-bold mb-3">相似歌手</h3>
                    <div className="grid grid-cols-4 gap-3">
                      {similarArtists.map((sa: any, i: number) => {
                        const name = sa.name || sa.artistName || ''
                        const pic = sa.picUrl || sa.img1v1Url || sa.artistPic || ''
                        const saId = sa.id || sa.artistId || 0
                        const saMid = sa.mid || ''
                        return (
                          <button
                            key={saId || i}
                            onClick={() => {
                              if (onOpenArtist) {
                                const id = platform === 'qq' ? String(saMid || saId) : String(saId)
                                onOpenArtist(id, platform)
                              }
                            }}
                            className="flex flex-col items-center gap-1.5 p-2 rounded-xl transition-colors hover:bg-white/10"
                          >
                            <div className="w-16 h-16 rounded-full overflow-hidden bg-white/10">
                              {pic ? <img src={getProxiedImageUrl(pic, 150)} alt={name} className="w-full h-full object-cover" /> : <Music className="w-6 h-6 m-auto text-white/40" />}
                            </div>
                            <span className={`text-xs truncate w-full text-center ${textSecondary}`}>{name}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 如果没有任何描述 */}
                {!artist.description && 
                 !artist.briefDesc && 
                 (!artist.intro || artist.intro.length === 0) && 
                 (!artist.basic || !artist.basic.item || artist.basic.item.length === 0) &&
                 (!artist.other || !artist.other.item || artist.other.item.length === 0) && (
                  <div className={`${textSecondary}`}>
                    <p>暂无详细信息</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        
        {/* 滚动按钮组 - 弹窗外部右侧，相对于弹窗定位 */}
        
        {/* 回到顶部按钮 - 最下方 */}
        {activeTab === 'hotSongs' && (
          <ScrollToTop 
            containerRef={hotSongsScrollRef} 
            threshold={300}
            playerTheme={playerTheme}
            position="absolute"
            offsetRight={-60}
            offsetBottom={24}
          />
        )}
        
        {activeTab === 'allSongs' && (
          <ScrollToTop 
            containerRef={allSongsScrollRef} 
            threshold={300}
            playerTheme={playerTheme}
            position="absolute"
            offsetRight={-60}
            offsetBottom={24}
          />
        )}
        
        {/* 跳转到当前播放歌曲按钮 - 在回到顶部按钮上方，只有当前歌曲存在时显示 */}
        {activeTab === 'hotSongs' && currentHotSongIndex !== -1 && (
          <ScrollToCurrentSong
            containerRef={hotSongsScrollRef}
            currentSongIndex={currentHotSongIndex}
            threshold={300}
            playerTheme={playerTheme}
            position="absolute"
            offsetRight={-60}
            offsetBottom={88}
          />
        )}
        
        {/* 跳转到当前播放歌曲按钮 - 全部歌曲 */}
        {activeTab === 'allSongs' && currentAllSongIndex !== -1 && (
          <ScrollToCurrentSong
            containerRef={allSongsScrollRef}
            currentSongIndex={currentAllSongIndex}
            threshold={300}
            playerTheme={playerTheme}
            position="absolute"
            offsetRight={-60}
            offsetBottom={88}
          />
        )}
        </motion.div>
      </motion.div>

      {/* 专辑详情弹窗 */}
      <AnimatePresence>
        {selectedAlbum && (
          <AlbumDetailModal
            albumId={selectedAlbum.mid || selectedAlbum.id!}
            platform={platform}
            onClose={() => setSelectedAlbum(null)}
            onSongSelect={(song, songs) => {
              // 从艺人弹窗内的专辑子视图选歌：播放的同时必须把艺人弹窗一并关闭，
              // 否则播放页出现后艺人/专辑界面还叠在上面
              setInstantClose(true)
              onSongSelect?.(song, songs)
              setSelectedAlbum(null)
              onClose()
            }}
            playerTheme={playerTheme}
            neteaseVip={neteaseVip}
            qqVip={qqVip}
            currentSong={currentSong}
            accentColor={accentColor}
            onPlayNext={onPlayNext}
            onAddToFavorites={onAddToFavorites}
            onRemoveFromFavorites={onRemoveFromFavorites}
            onAddToPlaylist={onAddToPlaylist}
            onViewComments={onViewComments}
            onOpenArtist={onOpenArtist}
            onCopyInfo={onCopyInfo}
          />
        )}
      </AnimatePresence>

      {contextMenu.song && (
        <SongContextMenu
          show={contextMenu.show}
          x={contextMenu.x}
          y={contextMenu.y}
          song={contextMenu.song}
          playerTheme={playerTheme}
          onClose={() => setContextMenu({ show: false, x: 0, y: 0, song: null, sourceSongs: [] })}
          onPlayNow={(song) => {
            // 右键"播放"也必须关闭艺人弹窗，否则播放页出现后弹窗还叠在上面
            setInstantClose(true)
            onSongSelect?.(song, contextMenu.sourceSongs)
            onClose()
          }}
          onPlayNext={onPlayNext}
          onAddToFavorites={onAddToFavorites}
          onRemoveFromFavorites={onRemoveFromFavorites}
          onAddToPlaylist={onAddToPlaylist}
          onViewComments={onViewComments}
          onViewAlbum={async (song) => {
            // 汽水约定：专辑名即专辑标识（无独立 ID 体系），由歌曲信息直接构造专辑弹窗
            if (platform === 'soda') {
              if (!song.album?.name) return
              setSelectedAlbum({
                id: 0,
                mid: song.album.name,
                name: song.album.name,
                picUrl: song.album.picUrl || '',
                artist: { name: song.artists?.[0]?.name || '未知艺人' },
                platform,
              })
              return
            }
            const albumId = await resolveSongAlbumIdentifier(song, platform)
            if (!albumId) return
            setSelectedAlbum({
              id: platform === 'netease' ? Number(albumId) : Number(song.album?.id || 0),
              mid: platform === 'qq' ? albumId : undefined,
              name: song.album?.name || '专辑',
              picUrl: song.album?.picUrl || '',
              artist: {
                name: song.artists?.[0]?.name || '未知艺人',
                id: song.artists?.[0]?.id,
                mid: song.artists?.[0]?.mid
              },
              platform
            })
          }}
          onViewArtist={onOpenArtist ? (song) => {
            const targetArtist = song.artists?.[0]
            // 汽水约定：歌手名即歌手标识（无独立 ID 体系）
            const targetId = platform === 'soda'
              ? targetArtist?.name
              : platform === 'qq' ? (targetArtist?.mid || targetArtist?.id) : targetArtist?.id
            if (targetId) onOpenArtist(String(targetId), platform)
          } : undefined}
          onCopyInfo={onCopyInfo}
          userPlaylists={userPlaylists}
          platform={platform}
        />
      )}

      {/* 视频播放器 */}
      <AnimatePresence>
        {selectedMV && (
          <VideoPlayer
            mvId={selectedMV.id}
            mvName={selectedMV.name}
            platform={selectedMV.platform || 'netease'}
            onClose={() => setSelectedMV(null)}
            mvList={mvs.map(mv => ({ id: mv.id, name: mv.name, platform: mv.platform }))}
            currentIndex={selectedMV.index}
          />
        )}
        {appleMvItem && (
          <AppleVideoModal
            item={appleMvItem}
            onClose={() => setAppleMvItem(null)}
          />
        )}
      </AnimatePresence>
    </>
  )
}
