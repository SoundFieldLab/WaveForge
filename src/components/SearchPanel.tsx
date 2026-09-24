import { useState, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, X, Music, History, Clock, User, Disc, Sparkles, TrendingUp, ListMusic, ArrowUpRight, Play } from 'lucide-react'
import { searchSongs, searchSuggest, searchArtists, searchAlbums, searchQuick, searchPlaylists, Song, Artist, Album, SearchSuggestion, getProxiedImageUrl, loadAlbumCovers, resolveSongAlbumIdentifier, searchHot } from '../services/musicApi'
import { mergeFusedSearchResults, type FusedSearchIntent, type MusicPlatform } from '../services/fusedSearch'
import { isPlatformVisible, platformLabel, PLATFORM_VISUAL_METADATA } from '../services/platforms'
import { useTvBack } from '../tv/tvCore'
import CachedImage from './CachedImage'
import ArtistDetailModal from './ArtistDetailModal'
import AlbumDetailModal from './AlbumDetailModal'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import type { PlaybackOrigin, SongSelectHandler } from '../types/playbackNavigation'
import SongContextMenu from './SongContextMenu'
import { getUserPlaylists } from '../services/playlistService'
import { searchAppleSongsAsSongs, searchAppleCatalogArtists, searchAppleCatalogAlbums, searchAppleCatalogV1, getAppleSearchSuggestionItems, getAppleLibraryPlaylists, appleSongToSong } from '../services/appleCatalog'
import { getAppleCredentials } from '../services/appleAuth'
import { parseStoredArray } from '../utils/storage'
import { debugLog } from '../utils/debugLog'

interface SearchPanelProps {
  onSongSelect: SongSelectHandler
  onClose: () => void
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  playerTheme?: 'light' | 'dark'
  neteaseVip?: boolean
  qqVip?: boolean
  neteaseLoggedIn?: boolean
  qqLoggedIn?: boolean
  appleLoggedIn?: boolean
  spotifyLoggedIn?: boolean
  kugouLoggedIn?: boolean
  currentSong?: Song | null
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  /** 打开歌单详情（内部面板）。不传时回退为外部浏览器打开 */
  onOpenPlaylist?: (playlist: { id: string; name: string; coverImgUrl: string; trackCount: number; creator: string; platform: MusicPlatform }) => void
  onCopyInfo?: (song: Song) => void
  onRestoreConsumed?: () => void
}

// 搜索历史本地存储key
const SEARCH_HISTORY_KEY_NETEASE = 'waveforge_search_history_netease'
const SEARCH_HISTORY_KEY_QQ = 'waveforge_search_history_qq'
const SEARCH_HISTORY_KEY_APPLE = 'waveforge_search_history_apple'
const SEARCH_HISTORY_KEY_SPOTIFY = 'waveforge_search_history_spotify'
const SEARCH_HISTORY_KEY_KUGOU = 'waveforge_search_history_kugou'
const SEARCH_HISTORY_KEY_SODA = 'waveforge_search_history_soda'
const SEARCH_HISTORY_KEY_FUSED = 'waveforge_search_history_fused'
const MAX_HISTORY = 5

// Apple 联想 topResults 的类型中文名（官网副标题形如「歌曲 · 孙燕姿」）
const APPLE_SUGGEST_TYPE_LABEL: Record<string, string> = {
  songs: '歌曲',
  albums: '专辑',
  artists: '艺人',
  playlists: '歌单',
  stations: '电台',
  'music-videos': '音乐视频',
}

// 搜索结果缓存上限：每次搜索缓存完整结果集（约 100 首歌对象），面板是常驻单例，
// 不加上限会导致 Map 无限增长（内存泄漏）。超出上限时按 LRU 淘汰最旧的 cacheKey。
const SEARCH_CACHE_MAX = 10

// 每页结果数：行高压缩到 48px 左右后单屏可见约 8-10 行，
// 首屏 40 条 + 触底自动续载，既保证「一屏看到足够多」，
// 又不至于一次渲染上百行封面（CachedImage 会瞬时排队）。
const SEARCH_PAGE_SIZE = 40

type SearchPlatform = MusicPlatform | 'fused'

const entityId = (entity: Artist | Album): string => String(entity.appleId || entity.mid || entity.id)

const getSearchHistoryKey = (platform: SearchPlatform): string => {
  if (platform === 'fused') return SEARCH_HISTORY_KEY_FUSED
  if (platform === 'qq') return SEARCH_HISTORY_KEY_QQ
  if (platform === 'apple') return SEARCH_HISTORY_KEY_APPLE
  if (platform === 'spotify') return SEARCH_HISTORY_KEY_SPOTIFY
  if (platform === 'kugou') return SEARCH_HISTORY_KEY_KUGOU
  if (platform === 'soda') return SEARCH_HISTORY_KEY_SODA
  return SEARCH_HISTORY_KEY_NETEASE
}

const withSearchTimeout = <T,>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = window.setTimeout(() => reject(new Error('融合搜索请求超时')), timeoutMs)
  promise.then(
    value => {
      window.clearTimeout(timer)
      resolve(value)
    },
    error => {
      window.clearTimeout(timer)
      reject(error)
    },
  )
})


/**
 * 向 LRU Map 写入并维护上限：set 时更新访问顺序（先删后插），
 * 超限时从队首淘汰最旧的 cacheKey。
 */
function setLruCache<K, V>(cache: Map<K, V>, key: K, value: V, maxEntries: number): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) break
    cache.delete(oldestKey as K)
  }
}

export default function SearchPanel({
  onSongSelect,
  onClose,
  restorePlaybackOrigin,
  playerTheme = 'dark',
  neteaseVip = false,
  qqVip = false,
  neteaseLoggedIn = false,
  qqLoggedIn = false,
  appleLoggedIn = false,
  spotifyLoggedIn = false,
  kugouLoggedIn = false,
  currentSong = null,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onCopyInfo,
  onRestoreConsumed
}: SearchPanelProps) {
  debugLog('🔍 SearchPanel 渲染', playerTheme)
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'
  // 宽屏卡片悬停：描边高光 + 轻微上浮 + 投影，替代只变背景色的「看不出来」反馈
  const hoverRing = playerTheme === 'dark' ? 'hover:ring-white/15' : 'hover:ring-black/10'
  const hoverLift = playerTheme === 'dark'
    ? 'hover:shadow-[0_12px_32px_-14px_rgba(0,0,0,0.75)]'
    : 'hover:shadow-[0_12px_32px_-14px_rgba(0,0,0,0.28)]'
  // 结果卡片网格：按容器可用宽度自动决定列数（宽屏铺满、窄屏自动降到 2-3 列）。
  // 最小宽度从 152px 提到 200px：超宽弹窗下不再被切成十几个拇指盖大小的小卡，
  // 单卡封面与标题恢复到一眼可读的尺寸（原先 152px 偏小，14 列太碎）。
  const cardGridStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))' }
  // 融合搜索的艺人与专辑是「小横条」，最小宽度更大才能保证文字不被压扁
  const entityGridStyle = { gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))' }

  // 紧凑筛选 chip：选中态用品牌色实底，未选中态玻璃底。
  // 去掉旧的 backdrop-blur-xl + shadow-lg（7 个按钮各自触发一次模糊合成），
  // 同时把按钮高度从 py-3 压到 py-1.5，把纵向空间让给结果列表。
  const platformChipClass = (isActive: boolean, activeClass: string) =>
    `px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors flex items-center gap-1.5 flex-shrink-0 ${
      isActive
        ? `${activeClass} text-white`
        : playerTheme === 'dark'
          ? 'bg-white/5 text-white/55 hover:bg-white/10 hover:text-white'
          : 'bg-black/5 text-black/55 hover:bg-black/10 hover:text-black'
    }`
  const typeChipClass = (isActive: boolean, activeClass: string) =>
    `px-2.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors flex items-center gap-1 flex-shrink-0 disabled:opacity-50 ${
      isActive
        ? `${activeClass} text-white`
        : playerTheme === 'dark'
          ? 'text-white/55 hover:bg-white/10 hover:text-white'
          : 'text-black/55 hover:bg-black/10 hover:text-black'
    }`
  
  const [keyword, setKeyword] = useState(() => {
    const saved = sessionStorage.getItem('waveforge_search_keyword')
    return saved || ''
  })
  const [allResults, setAllResults] = useState<Song[]>(() => {
    const saved = sessionStorage.getItem('waveforge_search_all_results')
    return parseStoredArray<Song>(saved)
  })
  const [displayedResults, setDisplayedResults] = useState<Song[]>(() => {
    const saved = sessionStorage.getItem('waveforge_search_displayed_results')
    return parseStoredArray<Song>(saved)
  })
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])

  // 融合结果按平台计数：此前在渲染体内做 4 次 filter().length（每次都全量遍历上百首），
  // 而本组件未 memo 且每次击键都会重渲染。一次遍历算完。
  const platformCounts = useMemo(() => {
    let qq = 0
    let netease = 0
    let apple = 0
    let other = 0
    for (const song of allResults) {
      const name = song.platform || 'netease'
      if (name === 'qq') qq += 1
      else if (name === 'netease') netease += 1
      else if (name === 'apple') apple += 1
      else other += 1
    }
    return { qq, netease, apple, other }
  }, [allResults])

  // QQ 快速联想（smartbox）：结构化返回歌手/歌曲/专辑
  const buildQqQuickSuggestions = async (keyword: string): Promise<SearchSuggestion[]> => {
    try {
      const data = await searchQuick(keyword)
      const raw = data?.data || {}
      const suggestions: SearchSuggestion[] = []
      ;(raw.singer?.itemlist || []).slice(0, 3).forEach((s: any) => {
        if (s?.name) suggestions.push({ keyword: s.name, type: 'artist' })
      })
      ;(raw.song?.itemlist || []).slice(0, 4).forEach((s: any) => {
        if (s?.name) suggestions.push({ keyword: s.name, type: 'song' })
      })
      ;(raw.album?.itemlist || []).slice(0, 2).forEach((a: any) => {
        if (a?.name) suggestions.push({ keyword: a.name, type: 'album' })
      })
      if (suggestions.length > 0) return suggestions
    } catch {
      /* smartbox 失败回退 */
    }
    return (await searchSuggest(keyword, 'qq')) || []
  }
  const [searchHistory, setSearchHistory] = useState<string[]>([]) // 搜索历史
  const [hotSearch, setHotSearch] = useState<any[]>([]) // 搜索热词
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false) // 加载更多状态
  const [searched, setSearched] = useState(() => {
    const saved = sessionStorage.getItem('waveforge_search_searched')
    return saved === 'true'
  })
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1) // 键盘选择的索引
  const [displayCount, setDisplayCount] = useState(() => {
    const saved = sessionStorage.getItem('waveforge_search_display_count')
    return saved ? Math.max(SEARCH_PAGE_SIZE, parseInt(saved) || SEARCH_PAGE_SIZE) : SEARCH_PAGE_SIZE
  })
  const scrollContainerRef = useRef<HTMLDivElement>(null) // 滚动容器引用
  const searchRequestRef = useRef(0)
  // 搜索结果缓存 per platform，避免切换平台后重新搜索
  const searchCacheRef = useRef<Map<string, {
    allResults: Song[]; artistResults: Artist[]; albumResults: Album[]; playlistResults: typeof playlistResults;
    artists: Artist[]; albums: Album[]; unavailable: MusicPlatform[]; intent: FusedSearchIntent
  }>>(new Map())
  const [songContextMenu, setSongContextMenu] = useState<{ show: boolean; x: number; y: number; song: Song | null }>({
    show: false,
    x: 0,
    y: 0,
    song: null,
  })
  const [contextUserPlaylists, setContextUserPlaylists] = useState<any[]>([])

  const openSongContextMenu = (event: ReactMouseEvent, song: Song) => {
    event.preventDefault()
    event.stopPropagation()
    setSongContextMenu({ show: true, x: event.clientX, y: event.clientY, song })
    setContextUserPlaylists([])
    const songPlatform = (song.platform || 'netease') as MusicPlatform
    // Apple：右键菜单歌单用资料库歌单（amp-api）
    if (songPlatform === 'apple') {
      void getAppleLibraryPlaylists(100)
        .then(setContextUserPlaylists)
        .catch(error => console.warn('Failed to load Apple search context playlists:', error))
      return
    }
    // 右键菜单歌单列表按歌曲自身平台解析归属键，禁止跨平台兜底：
    // - spotify（token）/ 汽水（cookie）：数据源不依赖 userId，空值也照常拉取；
    // - kugou：需 kugou_user_id（getUserPlaylists 对非 spotify/soda 平台按 userId 门禁）；
    // - qq/netease：各自 user_id + username。
    const playlistUserId = (() => {
      switch (songPlatform) {
        case 'qq': return localStorage.getItem('qq_user_id') || ''
        case 'kugou': return localStorage.getItem('kugou_user_id') || ''
        case 'spotify':
        case 'soda':
          return ''
        default: return localStorage.getItem('netease_user_id') || ''
      }
    })()
    if (songPlatform !== 'spotify' && songPlatform !== 'soda' && !playlistUserId) return
    const username = songPlatform === 'qq' ? (localStorage.getItem('qq_username') || '') : ''
    void getUserPlaylists(songPlatform, playlistUserId, username)
      .then(setContextUserPlaylists)
      .catch(error => console.warn('Failed to load search context playlists:', error))
  }
  
  // 从 sessionStorage 读取会话内的平台和搜索模式，否则从 localStorage 读取
  const [platform, setPlatform] = useState<SearchPlatform>(() => {
    const sessionSaved = sessionStorage.getItem('waveforge_search_platform')
    if (sessionSaved === 'qq' || sessionSaved === 'netease' || sessionSaved === 'apple' || sessionSaved === 'spotify' || sessionSaved === 'kugou' || sessionSaved === 'soda') {
      if (sessionSaved !== 'netease' && !isPlatformVisible(sessionSaved)) return 'netease'
      return sessionSaved
    }
    if (sessionSaved === 'fused') return 'fused'
    const saved = localStorage.getItem('waveforge_last_search_platform')
    if (saved === 'qq' || saved === 'netease' || saved === 'apple' || saved === 'spotify' || saved === 'kugou' || saved === 'soda') {
      if (saved !== 'netease' && !isPlatformVisible(saved)) return 'netease'
      return saved
    }
    return (saved === 'fused') ? 'fused' : 'netease'
  })
  const [searchType, setSearchType] = useState<'song' | 'artist' | 'album' | 'playlist'>(() => {
    const sessionSaved = sessionStorage.getItem('waveforge_search_type')
    if (sessionSaved === 'artist' || sessionSaved === 'album' || sessionSaved === 'song') return sessionSaved
    const saved = localStorage.getItem('waveforge_last_search_type')
    return (saved === 'artist' || saved === 'album' || saved === 'song') ? saved : 'song'
  })
  const previousPlatformRef = useRef<SearchPlatform>(platform)
  const previousSearchTypeRef = useRef(searchType)
  
  // 根据当前平台判断用户是否是VIP
  const isFused = platform === 'fused'
  const neteaseSessionActive = neteaseLoggedIn || Boolean(
    localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie')
  )
  const qqSessionActive = qqLoggedIn || Boolean(
    localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || localStorage.getItem('qq_logged_in') === 'true'
  )
  const isVipForPlatform = (songPlatform?: MusicPlatform) => songPlatform === 'qq' ? qqVip : songPlatform === 'netease' ? neteaseVip : false
  
  // 判断两首歌是否相同
  const isSameSong = (song1: Song | null | undefined, song2: Song | null | undefined) => {
    if (!song1 || !song2) return false
    // 优先使用 id 或 mid 比较
    if (song1.platform && song2.platform && song1.platform !== song2.platform) return false
    // Apple：id 可能为 0（库内曲目 l. 前缀非数字），用 appleId 判定
    const id1 = song1.mid || song1.appleId || (song1.id ? String(song1.id) : '')
    const id2 = song2.mid || song2.appleId || (song2.id ? String(song2.id) : '')
    if (id1 && id2) return id1 === id2
    // 否则使用名称和艺人比较
    return song1.name === song2.name && 
           song1.artists?.[0]?.name === song2.artists?.[0]?.name
  }
  
  // 歌手和专辑搜索结果
  const [artistResults, setArtistResults] = useState<Artist[]>(() => {
    const saved = sessionStorage.getItem('waveforge_search_artist_results')
    return parseStoredArray<Artist>(saved)
  })
  const [albumResults, setAlbumResults] = useState<Album[]>(() => {
    const saved = sessionStorage.getItem('waveforge_search_album_results')
    return parseStoredArray<Album>(saved)
  })
  const [playlistResults, setPlaylistResults] = useState<{ id: string; name: string; coverImgUrl: string; trackCount: number; creator: string; platform: MusicPlatform }[]>([])
  const [fusionUnavailablePlatforms, setFusionUnavailablePlatforms] = useState<MusicPlatform[]>([])
  const [fusionIntent, setFusionIntent] = useState<FusedSearchIntent>(() => {
    const saved = sessionStorage.getItem('waveforge_search_fusion_intent')
    return saved === 'artist' || saved === 'album' || saved === 'song' ? saved : 'mixed'
  })
  const [selectedArtist, setSelectedArtist] = useState<Artist | null>(null) // 选中的艺人
  const [selectedAlbum, setSelectedAlbum] = useState<Album | null>(null) // 选中的专辑
  const selectedArtistPlatform: MusicPlatform = selectedArtist?.platform || 'netease'
  const selectedAlbumPlatform: MusicPlatform = selectedAlbum?.platform || 'netease'
  const [selectedArtistAlbumId, setSelectedArtistAlbumId] = useState<string | number | undefined>()
  const [selectedArtistTab, setSelectedArtistTab] = useState<PlaybackOrigin['artistTab']>('hotSongs')
  // TV BACK closes the deepest search surface before dismissing the whole panel.
  useTvBack(() => {
    if (songContextMenu.show) {
      setSongContextMenu(previous => ({ ...previous, show: false }))
    } else if (selectedAlbum) {
      setSelectedAlbum(null)
    } else if (selectedArtist) {
      setSelectedArtist(null)
      setSelectedArtistAlbumId(undefined)
    } else {
      onClose()
    }
    return true
  }, [onClose, selectedAlbum, selectedArtist, songContextMenu.show])
  // 选歌播放：退出动画零时长，覆盖层当帧卸载。整屏 backdrop-filter 的退出节点在
  // 播放页同时挂载时会被 Chromium 保留为残留合成层（首页同款故障），退出动画越久越易触发。
  const [instantClose, setInstantClose] = useState(false)

  useEffect(() => {
    if (!restorePlaybackOrigin?.surface.startsWith('search')) return
    const restoredPlatform: SearchPlatform = restorePlaybackOrigin.searchMode === 'fused'
      ? 'fused'
      : (restorePlaybackOrigin.platform || platform)
    if (restoredPlatform !== platform) setPlatform(restoredPlatform)

    if (restorePlaybackOrigin.surface === 'search-album' && restorePlaybackOrigin.albumId) {
      const restoredAlbum = albumResults.find(album => entityId(album) === String(restorePlaybackOrigin.albumId))
        || ({
          id: restorePlaybackOrigin.platform === 'netease' ? Number(restorePlaybackOrigin.albumId) : 0,
          appleId: restorePlaybackOrigin.platform === 'apple' ? String(restorePlaybackOrigin.albumId) : undefined,
          mid: restorePlaybackOrigin.platform !== 'netease' && restorePlaybackOrigin.platform !== 'apple' ? String(restorePlaybackOrigin.albumId) : undefined,
          name: '',
          picUrl: '',
          platform: restorePlaybackOrigin.platform,
        } as Album)
      setSelectedArtist(null)
      setSelectedAlbum(restoredAlbum)
      return
    }

    if ((restorePlaybackOrigin.surface === 'search-artist' || restorePlaybackOrigin.surface === 'search-artist-album') && restorePlaybackOrigin.artistId) {
      const restoredArtist = artistResults.find(artist => entityId(artist) === String(restorePlaybackOrigin.artistId))
        || ({
          id: restorePlaybackOrigin.platform === 'netease' ? Number(restorePlaybackOrigin.artistId) : 0,
          appleId: restorePlaybackOrigin.platform === 'apple' ? String(restorePlaybackOrigin.artistId) : undefined,
          mid: restorePlaybackOrigin.platform !== 'netease' && restorePlaybackOrigin.platform !== 'apple' ? String(restorePlaybackOrigin.artistId) : undefined,
          name: '',
          platform: restorePlaybackOrigin.platform,
        } as Artist)
      setSelectedAlbum(null)
      setSelectedArtist(restoredArtist)
      setSelectedArtistAlbumId(restorePlaybackOrigin.albumId)
      setSelectedArtistTab(restorePlaybackOrigin.artistTab || (restorePlaybackOrigin.albumId ? 'albums' : 'hotSongs'))
      return
    }

    setSelectedArtist(null)
    setSelectedAlbum(null)
  }, [restorePlaybackOrigin?.revision])

  // 加载搜索热词
  useEffect(() => {
    let cancelled = false
    // Apple 无热词接口
    if (platform === 'apple') {
      setHotSearch([])
      return () => { cancelled = true }
    }
    const platformForHot = platform === 'fused' ? 'netease' : platform
    const fetchHot = async () => {
      const data = await searchHot(platformForHot as 'netease' | 'qq')
      if (!cancelled && data) {
        // 网易云: { code:200, result: { hots: [{ first:"热词", second:0 }] } }
        // QQ: { result:100, data: [{ k:"热词", n:1 }] }
        const neteaseList = data.result?.hots || data.hots
        const qqList = Array.isArray(data.data) ? data.data : null
        const list = neteaseList || qqList || []
        setHotSearch(list.slice(0, 10))
      }
    }
    fetchHot()
    return () => { cancelled = true }
  }, [platform])

  // 加载搜索历史
  useEffect(() => {
    // 平台切换时立即清空，避免残留上一平台的搜索历史
    setSearchHistory([])
    const key = getSearchHistoryKey(platform)
    const history = localStorage.getItem(key)
    if (history) {
      try {
        setSearchHistory(JSON.parse(history))
      } catch (e) {
        setSearchHistory([])
      }
    } else {
      setSearchHistory([])
    }
  }, [platform])

  // 保存搜索状态到 sessionStorage（会话内记忆）
  // 轻量标量键：随输入/翻页变化，写入成本可忽略。
  useEffect(() => {
    sessionStorage.setItem('waveforge_search_keyword', keyword)
    sessionStorage.setItem('waveforge_search_searched', searched.toString())
    sessionStorage.setItem('waveforge_search_platform', platform)
    sessionStorage.setItem('waveforge_search_type', searchType)
    sessionStorage.setItem('waveforge_search_display_count', displayCount.toString())
    sessionStorage.setItem('waveforge_search_fusion_intent', fusionIntent)
  }, [keyword, searched, platform, searchType, displayCount, fusionIntent])

  // 结果数组单独持久化：融合搜索下一次可含上百首 × 多平台，逐键序列化开销大，
  // 只在数组本身变化时写入（每个键各自 last-write-wins，与合并写入等价）。
  useEffect(() => {
    if (allResults.length > 0) {
      sessionStorage.setItem('waveforge_search_all_results', JSON.stringify(allResults))
    }
    if (displayedResults.length > 0) {
      sessionStorage.setItem('waveforge_search_displayed_results', JSON.stringify(displayedResults))
    }
    if (artistResults.length > 0) {
      sessionStorage.setItem('waveforge_search_artist_results', JSON.stringify(artistResults))
    }
    if (albumResults.length > 0) {
      sessionStorage.setItem('waveforge_search_album_results', JSON.stringify(albumResults))
    }
  }, [allResults, displayedResults, artistResults, albumResults])

  // 保存搜索历史
  const saveSearchHistory = (query: string) => {
    const key = getSearchHistoryKey(platform)
    const history = [...searchHistory]
    
    // 移除已存在的相同关键词
    const index = history.indexOf(query)
    if (index > -1) {
      history.splice(index, 1)
    }
    
    // 添加到开头
    history.unshift(query)
    
    // 只保留最近的
    const newHistory = history.slice(0, MAX_HISTORY)
    setSearchHistory(newHistory)
    localStorage.setItem(key, JSON.stringify(newHistory))
  }

  // 清空搜索历史
  const clearSearchHistory = () => {
    const key = getSearchHistoryKey(platform)
    setSearchHistory([])
    localStorage.removeItem(key)
  }

  // 监听平台切换，如果已搜索过则重新搜索
  useEffect(() => {
    // 保存平台选择
    localStorage.setItem('waveforge_last_search_platform', platform)

    // 首次挂载（包括 React StrictMode 的重复 effect）只恢复缓存，不重新发请求。
    if (previousPlatformRef.current === platform) return
    previousPlatformRef.current = platform
    if (searched && keyword.trim()) {
      handleSearch()
    }
  }, [platform])
  
  // 监听搜索类型切换
  useEffect(() => {
    // 保存搜索类型选择
    localStorage.setItem('waveforge_last_search_type', searchType)

    if (previousSearchTypeRef.current === searchType) return
    previousSearchTypeRef.current = searchType
    // 如果已搜索过且有关键词，重新搜索
    if (searched && keyword.trim()) {
      handleSearch()
    }
  }, [searchType])

  // 实时搜索建议
  useEffect(() => {
    // 如果已经搜索过，不显示建议
    if (searched) {
      setShowSuggestions(false)
      setSuggestions([])
      return
    }
    
    if (keyword.trim().length < 2) {
      setSuggestions([])
      setShowSuggestions(false)
      setSelectedIndex(-1)
      return
    }

    let active = true
    const timer = setTimeout(async () => {
      // 再次检查是否已搜索，防止搜索后建议重新出现
      if (searched) {
        setShowSuggestions(false)
        setSuggestions([])
        return
      }
      
      try {
        debugLog('🔍 正在获取搜索建议:', keyword.trim(), platform)
        const result = platform === 'fused'
          ? (await Promise.allSettled([
              searchSuggest(keyword.trim(), 'netease'),
              searchSuggest(keyword.trim(), 'qq'),
              searchQuick(keyword.trim()),
            ]))
              .flatMap(item => item.status === 'fulfilled' ? item.value : [])
              .filter((item, index, list) => list.findIndex(candidate => candidate.keyword.trim().toLocaleLowerCase() === item.keyword.trim().toLocaleLowerCase()) === index)
              .slice(0, 8)
          : platform === 'qq'
            ? await buildQqQuickSuggestions(keyword.trim())
            : platform === 'apple'
              // Apple：amp-api search/suggestions（web 播放器同款联想，需 Developer Token）。
              // 官网联想为「建议词 + 可点开的 topResults（带封面/艺人）」两类，这里一并保留。
              ? (await getAppleSearchSuggestionItems(keyword.trim(), localStorage.getItem('appleStorefront') || 'cn'))
                  .slice(0, 8)
                  .map(item => ({
                    keyword: item.term,
                    type: 'song' as const,
                    subtitle: item.kind === 'topResults'
                      ? [APPLE_SUGGEST_TYPE_LABEL[item.type || ''] || '', item.subtitle].filter(Boolean).join(' · ')
                      : undefined,
                    artworkUrl: item.artworkUrl,
                    appleType: item.type,
                    appleId: item.id,
                  }))
              : await searchSuggest(keyword.trim(), platform)
        if (!active) return
        debugLog('📝 搜索建议结果:', result)
        setSuggestions(result)
        setShowSuggestions(result.length > 0)
        setSelectedIndex(-1)
      } catch (error) {
        console.error('获取搜索建议失败:', error)
      }
    }, 300)

    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [keyword, platform, searched])

  const handleSearch = async (searchKeyword?: string) => {
    const finalKeyword = searchKeyword || keyword
    if (!finalKeyword.trim()) return
    
    const requestId = ++searchRequestRef.current
    setLoading(true)
    setSearchError('')
    setSearched(true)
    setShowSuggestions(false)
    setSelectedIndex(-1)
    setDisplayCount(SEARCH_PAGE_SIZE) // 重置显示数量
    // 新一轮搜索回到顶部，否则沿用上一轮滚动位置会直接触发触底续载
    lastAutoLoadRef.current = 0
    if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0
    
    const storefrontKey = platform === 'apple' || platform === 'fused'
      ? localStorage.getItem('appleStorefront') || 'cn'
      : ''
    const cacheKey = `${platform}:${searchType}:${storefrontKey}:${finalKeyword.trim().toLocaleLowerCase()}`
    const cached = searchCacheRef.current.get(cacheKey)
    if (cached) {
      setArtistResults(cached.artistResults)
      setAlbumResults(cached.albumResults)
      setAllResults(cached.allResults)
      setDisplayedResults(cached.allResults.slice(0, SEARCH_PAGE_SIZE))
      setPlaylistResults(cached.playlistResults || [])
      setFusionUnavailablePlatforms(cached.unavailable)
      setFusionIntent(cached.intent)
      setLoading(false)
      // 保存搜索历史
      saveSearchHistory(finalKeyword)
      return
    }
    
    // 重置结果
    setArtistResults([])
    setAlbumResults([])
    setAllResults([])
    setDisplayedResults([])
    setFusionUnavailablePlatforms([])
    
    // 保存搜索历史
    saveSearchHistory(finalKeyword)
    
    try {
      if (platform === 'fused') {
        // 融合搜索覆盖全部可搜索平台（汽水已接入逆向 Web API 搜索）
        const platforms: MusicPlatform[] = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda']
        const requests = platforms.flatMap(sourcePlatform => ([
          { sourcePlatform, kind: 'songs' as const, promise: withSearchTimeout(searchSongs(finalKeyword, 100, sourcePlatform)) },
          { sourcePlatform, kind: 'artists' as const, promise: withSearchTimeout(searchArtists(finalKeyword, sourcePlatform)) },
          { sourcePlatform, kind: 'albums' as const, promise: withSearchTimeout(searchAlbums(finalKeyword, sourcePlatform)) },
        ]))
        const requestResults = await Promise.allSettled(requests.map(request => request.promise))
        if (requestId !== searchRequestRef.current) return

        const unavailable = Array.from(new Set(requestResults.flatMap((result, index) => (
          result.status === 'rejected' ? [requests[index].sourcePlatform] : []
        ))))
        const songs: Song[] = []
        const artists: Artist[] = []
        const albums: Album[] = []
        requestResults.forEach((result, index) => {
          if (result.status !== 'fulfilled') return
          if (requests[index].kind === 'songs') songs.push(...(result.value as { songs: Song[] }).songs)
          if (requests[index].kind === 'artists') artists.push(...(result.value as Artist[]))
          if (requests[index].kind === 'albums') albums.push(...(result.value as Album[]))
        })
        const fused = mergeFusedSearchResults({
          keyword: finalKeyword,
          songs,
          artists,
          albums,
          entitlements: {
            netease: { loggedIn: neteaseSessionActive, vip: neteaseVip },
            qq: { loggedIn: qqSessionActive, vip: qqVip },
            apple: { loggedIn: appleLoggedIn, vip: appleLoggedIn },
            spotify: { loggedIn: spotifyLoggedIn, vip: false },
            kugou: { loggedIn: kugouLoggedIn, vip: false },
            soda: { loggedIn: Boolean(localStorage.getItem('soda_token')), vip: false },
          },
        })
        setFusionUnavailablePlatforms(unavailable)
        setFusionIntent(fused.intent)
        setArtistResults(fused.artists)
        setAlbumResults(fused.albums)
        setAllResults(fused.songs)
        setDisplayedResults(fused.songs.slice(0, SEARCH_PAGE_SIZE))
        // 缓存结果（LRU，超出上限自动淘汰最旧条目）
        setLruCache(searchCacheRef.current, cacheKey, {
          allResults: fused.songs, artistResults: fused.artists, albumResults: fused.albums, playlistResults: [],
          artists: fused.artists, albums: fused.albums, unavailable, intent: fused.intent
        }, SEARCH_CACHE_MAX)
      } else if (platform === 'apple') {
        // Apple Music 目录搜索：优先 amp-api（web 播放器同款，含歌单/电台），
        // 无 Developer Token 时回退 iTunes Search（免 token，无歌单）
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        const hasDevToken = Boolean(getAppleCredentials().developerToken)
        if (hasDevToken) {
          const searched = await searchAppleCatalogV1(finalKeyword, storefront, 25)
          if (requestId !== searchRequestRef.current) return
          if (searched.errorStatus !== undefined) {
            if (searchType === 'song') {
              const songs = await searchAppleSongsAsSongs(finalKeyword, storefront, 50)
              if (requestId !== searchRequestRef.current) return
              setAllResults(songs)
              setDisplayedResults(songs.slice(0, SEARCH_PAGE_SIZE))
            } else if (searchType === 'artist') {
              const artists = await searchAppleCatalogArtists(finalKeyword, storefront)
              if (requestId !== searchRequestRef.current) return
              setArtistResults(artists.map(artist => ({ id: Number(artist.id) || 0, appleId: artist.id, name: artist.name, picUrl: artist.artworkUrl || '', platform: 'apple' })))
            } else if (searchType === 'album') {
              const albums = await searchAppleCatalogAlbums(finalKeyword, storefront)
              if (requestId !== searchRequestRef.current) return
              setAlbumResults(albums.map(album => ({ id: Number(album.id) || 0, appleId: album.id, name: album.name, picUrl: album.artworkUrl || '', artist: { name: album.artistName }, platform: 'apple' })))
            } else {
              setPlaylistResults([])
            }
            return
          }
          const songs = searched.songs.map(song => appleSongToSong(song, storefront))
          const artists = searched.artists.map(artist => ({
            id: Number(artist.id) || 0,
            appleId: String(artist.id),
            name: artist.name,
            picUrl: artist.artworkUrl || '',
            platform: 'apple' as const,
          }))
          const albums = searched.albums.map(album => ({
            id: Number(album.id) || 0,
            appleId: String(album.id),
            name: album.name,
            picUrl: album.artworkUrl || '',
            artist: { name: album.artistName },
            platform: 'apple' as const,
          }))
          const playlists = searched.playlists.map(playlist => ({
            id: playlist.id,
            name: playlist.name,
            coverImgUrl: playlist.artworkUrl || '',
            trackCount: playlist.trackCount ?? 0,
            creator: playlist.curatorName || 'Apple Music 编辑',
            platform: 'apple' as const,
          }))
          setAllResults(songs)
          setDisplayedResults(songs.slice(0, SEARCH_PAGE_SIZE))
          setArtistResults(artists)
          setAlbumResults(albums)
          setPlaylistResults(playlists)
          setLruCache(searchCacheRef.current, cacheKey, {
            allResults: songs, artistResults: artists, albumResults: albums, playlistResults: playlists,
            artists: [], albums: [], unavailable: [], intent: 'mixed' as const,
          }, SEARCH_CACHE_MAX)
        } else if (searchType === 'song') {
          const songs = await searchAppleSongsAsSongs(finalKeyword, storefront, 50)
          if (requestId !== searchRequestRef.current) return
          setAllResults(songs)
          setDisplayedResults(songs.slice(0, SEARCH_PAGE_SIZE))
        } else if (searchType === 'artist') {
          const artists = await searchAppleCatalogArtists(finalKeyword, storefront)
          if (requestId !== searchRequestRef.current) return
          setArtistResults(artists.map(artist => ({
            id: Number(artist.id) || 0,
            appleId: String(artist.id),
            name: artist.name,
            picUrl: artist.artworkUrl || '',
            platform: 'apple',
          })))
        } else if (searchType === 'album') {
          const albums = await searchAppleCatalogAlbums(finalKeyword, storefront)
          if (requestId !== searchRequestRef.current) return
          setAlbumResults(albums.map(album => ({
            id: Number(album.id) || 0,
            appleId: String(album.id),
            name: album.name,
            picUrl: album.artworkUrl || '',
            artist: { name: album.artistName },
            platform: 'apple',
          })))
        } else if (searchType === 'playlist') {
          // 未登录无 dev token：暂无 AMP 歌单搜索，与旧行为一致为空
          setPlaylistResults([])
        }
      } else if (searchType === 'song') {
        const songResult = await searchSongs(finalKeyword, 100, platform)
        if (requestId !== searchRequestRef.current) return
        debugLog('🔍 搜索结果:', { songs: songResult.songs.length })
        setAllResults(songResult.songs)
        setDisplayedResults(songResult.songs.slice(0, SEARCH_PAGE_SIZE))
      } else if (searchType === 'artist') {
        const artists = await searchArtists(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        debugLog('🔍 艺人搜索结果:', { artists: artists.length })
        setArtistResults(artists)
      } else if (searchType === 'album') {
        debugLog('🔍 开始搜索专辑:', finalKeyword, 'platform:', platform)
        const albums = await searchAlbums(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        debugLog('🔍 专辑搜索结果:', { albums: albums.length, data: albums })
        debugLog('🔍 第一个专辑数据:', albums[0])
        setAlbumResults(albums)
        debugLog('🔍 专辑结果已设置，调用 setAlbumResults，长度:', albums.length)
      } else if (searchType === 'playlist') {
        debugLog('🔍 开始搜索歌单:', finalKeyword, 'platform:', platform)
        const data = await searchPlaylists(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        setPlaylistResults(data.playlists)
        if (data.unsupported) setSearchError(`${platformLabel(platform)}暂不支持歌单搜索`)
      }
    } catch (error) {
      console.error('❌ 搜索失败:', error)
      if (requestId === searchRequestRef.current) {
        setSearchError(error instanceof Error ? error.message : '搜索失败，请稍后重试')
      }
    } finally {
      debugLog('🔍 搜索完成，设置 loading = false')
      if (requestId === searchRequestRef.current) setLoading(false)
    }
  }

  // 切换搜索类型（不立即搜索）
  const handleSearchByType = (type: 'song' | 'artist' | 'album' | 'playlist') => {
    setSearchType(type)
  }

  // 加载更多结果
  const handleLoadMore = async () => {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const newCount = displayCount + SEARCH_PAGE_SIZE
      const newSongs = allResults.slice(displayCount, newCount)
      
      // 如果是网易云，需要加载这批歌曲的封面
      if ((platform === 'netease' || platform === 'fused') && newSongs.length > 0) {
        const songsWithCovers = await loadAlbumCovers(newSongs)
        
        // 更新allResults中的封面
        const updatedResults = [...allResults]
        songsWithCovers.forEach((song, index) => {
          updatedResults[displayCount + index] = song
        })
        setAllResults(updatedResults)
        setDisplayedResults(updatedResults.slice(0, newCount))
      } else {
        setDisplayedResults(allResults.slice(0, newCount))
      }
      
      setDisplayCount(newCount)
    } catch (error) {
      console.error('加载更多失败:', error)
    } finally {
      setLoadingMore(false)
    }
  }

  // 触底自动续载：距底部 320px 内即预取下一页，替代原先的手动「加载更多」按钮。
  // 用 ref 记录上一次触发时的结果长度，避免滚动过程中重复调度同一批。
  const lastAutoLoadRef = useRef(0)
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    if (loading || loadingMore) return
    if (displayedResults.length >= allResults.length) return
    if (allResults.length === 0) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 320) return
    if (lastAutoLoadRef.current === displayedResults.length) return
    lastAutoLoadRef.current = displayedResults.length
    void handleLoadMore()
  }

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
        // 选择了建议项
        handleSuggestionClick(suggestions[selectedIndex])
      } else {
        // 直接搜索
        handleSearch()
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (showSuggestions && suggestions.length > 0) {
        setSelectedIndex(prev => (prev + 1) % suggestions.length)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (showSuggestions && suggestions.length > 0) {
        setSelectedIndex(prev => (prev - 1 + suggestions.length) % suggestions.length)
      }
    } else if (e.key === 'Escape') {
      // Esc 逐级后退：先收联想词 → 再清空已输入关键词 → 最后才关闭整个面板
      if (showSuggestions || suggestions.length > 0) {
        setShowSuggestions(false)
        setSelectedIndex(-1)
      } else if (keyword) {
        setKeyword('')
        setSelectedIndex(-1)
      } else {
        onClose()
      }
    }
  }

  const handleSuggestionClick = (suggestion: SearchSuggestion) => {
    setKeyword(suggestion.keyword)
    setShowSuggestions(false)
    setSelectedIndex(-1)
    setSuggestions([]) // 清空建议列表
    // 自动搜索，不需要再次手动点击搜索按钮或焦点
    handleSearch(suggestion.keyword)
  }

  const formatDuration = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  // 后端各平台归一化偶尔会把对象/数组塞进本应是字符串的字段（如 album.name），
  // 直接渲染会触发「Objects are not valid as a React child」并让整棵结果树崩溃。
  // 这里统一收敛为纯字符串，脏数据只退化文案，不再炸渲染树。
  const songText = (value: unknown, fallback = ''): string => {
    if (typeof value === 'string') return value || fallback
    if (typeof value === 'number') return String(value)
    const nested = (value as { name?: unknown } | null | undefined)?.name
    if (typeof nested === 'string' && nested) return nested
    return fallback
  }

  const songArtists = (song: Song): string => {
    if (!Array.isArray(song.artists)) return '未知艺人'
    const names = song.artists
      .map(artist => songText(artist, ''))
      .filter(name => name.length > 0)
    return names.length > 0 ? names.join(', ') : '未知艺人'
  }

  const entitlementLabel = (sourcePlatform: MusicPlatform) => {
    const loggedIn = sourcePlatform === 'qq' ? qqSessionActive : neteaseSessionActive
    const vip = sourcePlatform === 'qq' ? qqVip : neteaseVip
    if (vip) return 'VIP · 优先展示'
    if (loggedIn) return '已登录 · 非会员'
    return '未登录'
  }

  const platformText = (platforms: MusicPlatform[]) => {
    const unique = Array.from(new Set(platforms))
    if (unique.length > 1) return `${unique.length} 个平台`
    return platformLabel(unique[0])
  }

  const renderSongSourceChoice = (song: Song) => {
    const preferredPlatform: MusicPlatform = song.platform || 'netease'
    const sources = Array.from(new Set(
      (song.fusedSources || [{ platform: preferredPlatform }]).map(source => source.platform),
    ))
    const preferredVip = preferredPlatform === 'qq' ? qqVip : neteaseVip
    const meta = PLATFORM_VISUAL_METADATA[preferredPlatform]
    return (
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* 首选平台用品牌色小方块，避免「首选 QQ音乐 · VIP」这类长文案把行撑高 */}
        <span
          className="px-1.5 py-px rounded text-[10px] font-semibold leading-4"
          style={{ backgroundColor: meta?.background, color: meta?.color }}
          title={`首选 ${platformLabel(preferredPlatform)}${preferredVip ? ' · 会员可完好播放' : ''}`}
        >
          {meta?.shortLabel || platformLabel(preferredPlatform)}
          {preferredVip && <span className="ml-0.5 opacity-80">VIP</span>}
        </span>
        {sources.length > 1 && (
          <span className={`${textTertiary} text-[10px] leading-4`} title={`共 ${sources.length} 个平台有此曲目`}>
            +{sources.length - 1}
          </span>
        )}
      </div>
    )
  }

  const renderFusedEntitySections = () => (
    <div className="space-y-2.5 mb-2">
      {artistResults.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <User className={`w-3.5 h-3.5 ${textTertiary}`} />
            <span className={`${textPrimary} text-[13px] font-medium`}>相关艺人</span>
            <span className={`${textTertiary} text-xs`}>{artistResults.length} 位 · 最多 6 位</span>
          </div>
          <div className="grid gap-2" style={entityGridStyle}>
            {artistResults.map(artist => {
              const sourcePlatform: MusicPlatform = artist.platform || 'netease'
              return (
                <motion.button
                  type="button"
                  key={`fused-artist-${artist.platform}-${entityId(artist)}`}
                  whileHover={{ y: -1 }}
                  onClick={() => setSelectedArtist(artist)}
                  className={`${bgCard} border ${borderColor} rounded-lg p-2 text-left flex items-center gap-2.5 transition-colors ${hoverBg} min-w-0`}
                >
                  <div className="w-10 h-10 rounded-full overflow-hidden bg-white/5 flex-shrink-0">
                    {artist.picUrl ? (
                      <CachedImage src={getProxiedImageUrl(artist.picUrl)} alt={artist.name} className="w-full h-full object-cover" role="compact" size={128} priority="visible" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><User className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} /></div>
                    )}
                  </div>
                  <div className={`${textPrimary} text-[13px] font-medium truncate flex-1 min-w-0`}>{songText(artist.name, '未知艺人')}</div>
                  <span className={`text-[11px] leading-4 flex-shrink-0 ${sourcePlatform === 'qq' ? 'text-green-300/80' : 'text-red-300/80'}`}>
                    {platformLabel(sourcePlatform)}
                  </span>
                </motion.button>
              )
            })}
          </div>
        </section>
      )}

      {albumResults.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-1.5 px-1">
            <Disc className={`w-3.5 h-3.5 ${textTertiary}`} />
            <span className={`${textPrimary} text-[13px] font-medium`}>相关专辑</span>
            <span className={`${textTertiary} text-xs`}>{albumResults.length} 张 · 最多 6 张</span>
          </div>
          <div className="grid gap-2" style={entityGridStyle}>
            {albumResults.map(album => (
              <motion.button
                type="button"
                key={`fused-album-${album.platform}-${entityId(album)}`}
                whileHover={{ y: -1 }}
                onClick={() => setSelectedAlbum(album)}
                className={`${bgCard} border ${borderColor} rounded-lg p-2 text-left flex items-center gap-2.5 transition-colors ${hoverBg} min-w-0`}
              >
                <div className="w-10 h-10 rounded-md overflow-hidden bg-white/5 flex-shrink-0">
                  {album.picUrl ? (
                    <CachedImage src={getProxiedImageUrl(album.picUrl)} alt={album.name} className="w-full h-full object-cover" role="compact" size={128} priority="visible" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><Disc className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} /></div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`${textPrimary} text-[13px] font-medium truncate`}>{songText(album.name, '未知专辑')}</div>
                  <div className={`${textTertiary} text-[11px] leading-4 truncate`}>{songText(album.artist?.name, '') || '未知艺人'}</div>
                </div>
                <span className={`${textTertiary} text-[10px] leading-4 flex-shrink-0 max-w-16 text-right`}>
                  {platformText(album.sourcePlatforms || [album.platform || 'netease'])}
                </span>
              </motion.button>
            ))}
          </div>
        </section>
      )}
    </div>
  )

  return (
    <>
    <motion.div
      data-tv-scope
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={instantClose ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 sm:p-6"
      style={{
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        backgroundColor: playerTheme === 'dark' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.35)',
      }}
      onClick={(e) => {
        debugLog('🖱️ SearchPanel 背景被点击，准备关闭')
        onClose()
      }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => {
          debugLog('🖱️ SearchPanel 内容区域被点击，阻止冒泡')
          e.stopPropagation()
        }}
        className="rounded-2xl shadow-2xl w-full max-w-[min(1800px,94vw)] h-[86vh] max-h-[calc(100vh-3rem)] flex flex-col overflow-hidden relative"
      >
        {/* 液态玻璃背景层 */}
        <div className="absolute inset-0 rounded-2xl overflow-hidden">
          {/* 主背景 */}
          <div
            className="absolute inset-0"
            style={{
              background: playerTheme === 'dark'
                ? 'linear-gradient(135deg, rgba(0,0,0,0.90) 0%, rgba(20,20,30,0.95) 50%, rgba(0,0,0,0.92) 100%)'
                : 'linear-gradient(135deg, rgba(252,252,250,0.92) 0%, rgba(246,246,244,0.95) 50%, rgba(250,250,248,0.93) 100%)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
            }}
          />

          {/* 光泽层 */}
          <div
            className="absolute inset-0"
            style={{
              background: playerTheme === 'dark'
                ? 'radial-gradient(circle at 25% 20%, rgba(255,255,255,0.1) 0%, transparent 50%)'
                : 'radial-gradient(circle at 25% 20%, rgba(255,255,255,0.65) 0%, transparent 50%)',
              pointerEvents: 'none',
            }}
          />

          {/* 边框高光 */}
          <div
            className="absolute inset-0 rounded-2xl"
            style={{
              border: playerTheme === 'dark' ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(0,0,0,0.1)',
              boxShadow: playerTheme === 'dark' ? 'inset 0 1px 1px rgba(255,255,255,0.1)' : 'inset 0 1px 1px rgba(255,255,255,0.8)',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Content area：弹窗高度固定，内容区弹性填充 + min-h-0，
            保证下方结果区的 overflow-y-auto 能正确滚动 */}
        <div className="relative z-10 flex flex-col flex-1 min-h-0">
        {/* 头部 */}
        <div className={`px-5 sm:px-6 pt-4 pb-3 border-b ${borderColor} flex-shrink-0`}>
          <div className="flex items-center justify-between mb-3">
            <h2 className={`text-lg font-semibold ${textPrimary}`}>搜索音乐</h2>
            <button
              onClick={onClose}
              className={`p-1.5 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
            >
              <X className={`w-5 h-5 ${textPrimary}/60`} />
            </button>
          </div>

          {/* 平台切换 + 类型筛选：同一行内 flex-wrap，窄窗口自动换行 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => setPlatform('fused')}
              className={platformChipClass(platform === 'fused', 'bg-gradient-to-r from-violet-600 to-blue-600')}
              title="融合搜索：自动识别艺人、专辑与歌曲"
            >
              <Sparkles className="w-3.5 h-3.5" />
              融合搜索
            </button>
            {isPlatformVisible('netease') && (
              <button onClick={() => setPlatform('netease')} className={platformChipClass(platform === 'netease', 'bg-red-600')}>
                网易云音乐
              </button>
            )}
            {isPlatformVisible('qq') && (
              <button onClick={() => setPlatform('qq')} className={platformChipClass(platform === 'qq', 'bg-green-600')}>
                QQ音乐
              </button>
            )}
            {isPlatformVisible('apple') && (
              <button onClick={() => setPlatform('apple')} className={platformChipClass(platform === 'apple', 'bg-pink-600')}>
                Apple Music
              </button>
            )}
            {isPlatformVisible('spotify') && (
              <button onClick={() => setPlatform('spotify')} className={platformChipClass(platform === 'spotify', 'bg-emerald-500')}>
                Spotify
              </button>
            )}
            {isPlatformVisible('kugou') && (
              <button onClick={() => setPlatform('kugou')} className={platformChipClass(platform === 'kugou', 'bg-orange-500')}>
                酷狗音乐
              </button>
            )}
            {isPlatformVisible('soda') && (
              <button onClick={() => setPlatform('soda')} className={platformChipClass(platform === 'soda', 'bg-sky-500')}>
                汽水音乐
              </button>
            )}

            {!isFused && (
              <>
                <div className={`w-px h-4 mx-1 ${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`} />
                <button onClick={() => handleSearchByType('artist')} disabled={loading} className={typeChipClass(searchType === 'artist', 'bg-purple-600')}>
                  <User className="w-3.5 h-3.5" />
                  搜艺人
                </button>
                <button onClick={() => handleSearchByType('album')} disabled={loading} className={typeChipClass(searchType === 'album', 'bg-blue-600')}>
                  <Disc className="w-3.5 h-3.5" />
                  搜专辑
                </button>
                <button onClick={() => handleSearchByType('song')} disabled={loading} className={typeChipClass(searchType === 'song', 'bg-green-600')}>
                  <Music className="w-3.5 h-3.5" />
                  搜歌曲
                </button>
                <button onClick={() => handleSearchByType('playlist')} disabled={loading} className={typeChipClass(searchType === 'playlist', 'bg-amber-600')}>
                  <ListMusic className="w-3.5 h-3.5" />
                  搜歌单
                </button>
              </>
            )}

            {isFused && (
              <span className={`ml-auto text-[11px] leading-4 ${playerTheme === 'dark' ? 'text-violet-200/60' : 'text-violet-700/60'}`}>
                自动识别艺人、专辑与歌曲 · QQ：{entitlementLabel('qq')} · 网易云：{entitlementLabel('netease')}
              </span>
            )}
          </div>

          {/* 搜索框 */}
          <div className="flex gap-2 relative flex-shrink-0 mt-3">
            <div className="flex-1 relative">
              <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 ${textPrimary}/40`} />
              <input
                type="text"
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value)
                  // 输入时重置searched状态，以便重新显示搜索建议
                  setSearched(false)
                }}
                onKeyDown={handleKeyPress}
                placeholder={platform === 'fused' ? '搜索歌曲、艺人、专辑…（融合全部平台）'
                  : searchType === 'artist' ? `在${platformLabel(platform)}搜索艺人…`
                    : searchType === 'album' ? `在${platformLabel(platform)}搜索专辑…`
                      : searchType === 'playlist' ? `在${platformLabel(platform)}搜索歌单…`
                        : `在${platformLabel(platform)}搜索歌曲…`}
                className={`w-full ${bgCard} border ${borderColor} rounded-lg pl-9 pr-9 py-2 text-sm ${textPrimary} ${playerTheme === 'dark' ? 'placeholder-white/40 focus:border-white/30' : 'placeholder-black/35 focus:border-black/30'} focus:outline-none transition-colors`}
                autoFocus
              />
              {/* 清空按钮 */}
              {keyword && (
                <button
                  onClick={() => {
                    setKeyword('')
                    setSearched(false)
                    setDisplayedResults([])
                    setAllResults([])
                    setArtistResults([])
                    setAlbumResults([])
                  setPlaylistResults([])
                  setSearchError('')
                  }}
                  className={`absolute right-3 top-1/2 transform -translate-y-1/2 p-1 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                >
                  <X className={`w-3.5 h-3.5 ${textPrimary}/40 hover:${textPrimary}/60`} />
                </button>
              )}
              
              {/* 搜索建议下拉框 */}
              {showSuggestions && suggestions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  onMouseDown={(e) => e.preventDefault()} // 防止输入框失焦
                  className="absolute top-full left-0 right-0 mt-2 rounded-xl z-10 shadow-2xl scrollbar-thin"
                  style={{
                    maxHeight: '312px', // 约 6 条建议（每条约 52px）即出现内滚动
                    overflowY: 'auto',
                    scrollbarWidth: 'thin',
                    scrollbarColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.2) transparent' : 'rgba(0,0,0,0.25) transparent',
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(20,20,30,0.92) 0%, rgba(0,0,0,0.95) 100%)'
                      : 'linear-gradient(135deg, rgba(250,250,248,0.94) 0%, rgba(244,244,242,0.96) 100%)',
                    backdropFilter: 'blur(20px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(20px) saturate(150%)',
                    border: playerTheme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
                  }}
                >
                  {suggestions.map((suggestion, index) => (
                    <div
                      key={`${suggestion.keyword}-${index}`}
                      onMouseDown={(e) => {
                        e.preventDefault() // 防止输入框失焦
                        handleSuggestionClick(suggestion)
                      }}
                      className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors border-b last:border-b-0 ${
                        playerTheme === 'dark' ? 'border-white/5' : 'border-black/5'
                      } ${
                        index === selectedIndex
                          ? `${playerTheme === 'dark' ? 'bg-white/10' : 'bg-black/8'} ${textPrimary}`
                          : `${playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'} ${textPrimary}/80`
                      }`}
                    >
                      {/* 官网联想：建议词显示放大镜，topResults（歌曲/专辑等）显示封面并带「类型 · 艺人」副标题 */}
                      {suggestion.artworkUrl ? (
                        <CachedImage
                          src={suggestion.artworkUrl}
                          alt=""
                          className="h-7 w-7 shrink-0 rounded"
                          platform={platform === 'apple' ? 'apple' : undefined}
                          role="compact"
                        />
                      ) : (
                        <Search className={`w-3.5 h-3.5 ml-1.5 mr-0.5 flex-shrink-0 ${textPrimary}/40`} />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${textPrimary}`}>{suggestion.keyword}</span>
                        {suggestion.subtitle && (
                          <span className={`block truncate text-xs ${textTertiary}`}>{suggestion.subtitle}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </motion.div>
              )}
            </div>
            
            {/* 搜索按钮 */}
            <button
              onClick={() => handleSearch()}
              disabled={loading}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex-shrink-0 ${
                playerTheme === 'dark'
                  ? 'bg-white text-black hover:bg-white/90'
                  : 'bg-black text-white hover:bg-black/85'
              }`}
            >
              {loading ? '搜索中..' : '搜索'}
            </button>
          </div>
        </div>

        {/* 搜索结果：始终 flex-1 + min-h-0，独占滚动区 */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 pb-5 pt-3"
          style={{
            scrollbarWidth: 'thin',
            scrollbarColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.3) transparent' : 'rgba(0,0,0,0.3) transparent'
          }}
        >
          {searchError && !loading && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200/85">
              <span>{searchError}</span>
              <button type="button" onClick={() => void handleSearch()} className="shrink-0 rounded-full border border-rose-200/20 px-3 py-1.5 text-xs hover:bg-rose-100/10">重试</button>
            </div>
          )}
          {!loading && isFused && fusionUnavailablePlatforms.length > 0 && (
            <div className="mb-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-400/20 text-amber-200/80 text-sm">
              {fusionUnavailablePlatforms.map(item => item === 'netease' ? '网易云音乐' : 'QQ音乐').join('、')} 的部分结果暂时不可用，已展示成功返回的内容。
            </div>
          )}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-16">
              {/* 加载动画 */}
              <motion.div
                className="relative w-12 h-12 mb-3"
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                <div className="absolute inset-0 border-[3px] border-white/10 rounded-full" />
                <div className="absolute inset-0 border-[3px] border-transparent border-t-white/60 rounded-full" />
              </motion.div>
              <motion.div 
                className={`${textPrimary}/60 text-sm`}
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                搜索中...
              </motion.div>
            </div>
          ) : !isFused && searchType === 'artist' && artistResults.length > 0 ? (
            // 艺人搜索结果：窄卡 + 更高列数，一屏铺满更多命中
            <div className="grid gap-3" style={cardGridStyle}>
            {artistResults.map((artist, index) => {
                return (
                <motion.div
                  key={`artist-${index}`}
                  onClick={() => setSelectedArtist(artist)}
                  className={`group ${bgCard} rounded-xl p-3 cursor-pointer transition-all duration-200 border ${borderColor} ring-0 hover:ring-1 ${hoverRing} ${hoverBg} ${hoverLift}`}
                >
                  <div className={`relative aspect-square rounded-lg overflow-hidden mb-2 ${playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                    {artist.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(artist.picUrl)} 
                        alt={artist.name}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
                        role="compact"
                        size={256}
                        priority="visible"
                        fallback={
                          <div className="w-full h-full flex items-center justify-center bg-white/5">
                            <User className={`w-12 h-12 ${textPrimary}/20`} />
                          </div>
                        }
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5">
                        <User className={`w-12 h-12 ${textPrimary}/20`} />
                      </div>
                    )}
                    {/* 悬停浮层：右下角打开指示，与歌单/专辑卡片统一的交互语言 */}
                    <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </div>
                  <h3 className={`${textPrimary} text-[15px] font-medium truncate`}>{songText(artist.name, '未知艺人')}</h3>
                  <div className={`${textTertiary} text-[13px] mt-0.5 space-x-2 truncate`}>
                    {artist.musicSize !== undefined && (
                      <span>{artist.musicSize} 首</span>
                    )}
                    {artist.albumSize !== undefined && (
                      <span>{artist.albumSize} 专辑</span>
                    )}
                  </div>
                </motion.div>
                )
              })}
          </div>
          ) : !isFused && searchType === 'playlist' && playlistResults.length > 0 ? (
            // 歌单搜索结果：与艺人/歌曲一致的自适应高密度网格
            <div className="grid gap-3" style={cardGridStyle}>
              {playlistResults.map((playlist, index) => (
                <div
                  key={`playlist-${index}`}
                  onClick={() => {
                    if (playlist.id) {
                      if (onOpenPlaylist) {
                        // 内部歌单详情面板打开（web/桌面都可用）
                        onOpenPlaylist(playlist)
                      } else {
                        // 未接内部打开时回退为外部浏览器打开
                        const w = (window as any).waveforge
                        if (w?.openExternal) void w.openExternal(`https://y.qq.com/n/ryqq_v2/playlist/${playlist.id}`)
                      }
                    }
                  }}
                  className={`group ${bgCard} rounded-xl p-3 cursor-pointer transition-all duration-200 border ${borderColor} ring-0 hover:ring-1 ${hoverRing} ${hoverBg} ${hoverLift}`}
                >
                  <div className={`relative aspect-square rounded-lg overflow-hidden mb-2 ${playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                    {playlist.coverImgUrl ? (
                      <CachedImage
                        src={getProxiedImageUrl(playlist.coverImgUrl)}
                        alt={playlist.name}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
                        role="compact"
                        size={256}
                        priority="visible"
                        fallback={<div className="w-full h-full flex items-center justify-center bg-white/5"><ListMusic className={`w-12 h-12 ${textPrimary}/20`} /></div>}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5"><ListMusic className={`w-12 h-12 ${textPrimary}/20`} /></div>
                    )}
                    {/* 悬停浮层：右下角打开指示，点明「整卡可点」 */}
                    <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </div>
                  <h3 className={`${textPrimary} text-[15px] font-medium truncate`}>{songText(playlist.name, '未命名歌单')}</h3>
                  <p className={`${textTertiary} text-[13px] mt-0.5 truncate`}>{songText(playlist.creator, '') || `${playlist.trackCount || 0} 首`}</p>
                </div>
              ))}
            </div>
          ) : !isFused && searchType === 'album' && albumResults.length > 0 ? (
            // 专辑搜索结果：与艺人/歌单一致的自适应高密度网格
            <div className="grid gap-3" style={cardGridStyle}>
              {albumResults.map((album, index) => (
                <div
                  key={`album-${index}`}
                  onClick={() => setSelectedAlbum(album)}
                  className={`group ${bgCard} rounded-xl p-3 cursor-pointer transition-all duration-200 border ${borderColor} ring-0 hover:ring-1 ${hoverRing} ${hoverBg} ${hoverLift}`}
                >
                  <div className={`relative aspect-square rounded-lg overflow-hidden mb-2 ${playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                    {album.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(album.picUrl)} 
                        alt={album.name}
                        className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
                        role="compact"
                        size={256}
                        priority="visible"
                        fallback={
                          <div className="w-full h-full flex items-center justify-center bg-white/5">
                            <Disc className={`w-12 h-12 ${textPrimary}/20`} />
                          </div>
                        }
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5">
                        <Disc className={`w-12 h-12 ${textPrimary}/20`} />
                      </div>
                    )}
                    {/* 悬停浮层：右下角打开指示，统一下方卡片交互语言 */}
                    <div className="pointer-events-none absolute inset-0 flex items-end justify-end bg-gradient-to-t from-black/45 via-transparent to-transparent p-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </span>
                    </div>
                  </div>
                  <h3 className={`${textPrimary} text-[15px] font-medium truncate`}>{songText(album.name, '未知专辑')}</h3>
                  <p className={`${textTertiary} text-[13px] mt-0.5 truncate`}>{songText(album.artist?.name, '') || '未知艺人'}</p>
                </div>
              ))}
            </div>
          ) : displayedResults.length > 0 ? (
            <div className="space-y-2">
              {isFused && (
                <>
                  <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 rounded-lg ${bgCard} border ${borderColor}`}>
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-violet-300" />
                      <span className={`${textPrimary} text-xs font-medium`}>融合搜索 · 已跨平台去重</span>
                    </span>
                    <span className={`${textTertiary} text-xs`}>
                      {qqVip ? 'QQ音乐 VIP 优先' : neteaseVip ? '网易云音乐 VIP 优先' : '匹配度与可播放性优先'}
                    </span>
                    <span className="ml-auto flex items-center gap-2 text-[11px] leading-4">
                      <span className="text-green-400/70">QQ {platformCounts.qq}</span>
                      <span className="text-red-400/70">网易云 {platformCounts.netease}</span>
                      <span className="text-pink-400/70">Apple {platformCounts.apple}</span>
                      {platformCounts.other > 0 && <span className="text-emerald-400/70">其他 {platformCounts.other}</span>}
                    </span>
                  </div>
                  {renderFusedEntitySections()}
                  <div className={`flex items-center gap-2 px-1 pt-1`}>
                    <Music className={`w-3.5 h-3.5 ${textTertiary}`} />
                    <span className={`${textPrimary} text-[13px] font-medium`}>歌曲</span>
                    <span className={`${textTertiary} text-xs`}>{allResults.length} 首</span>
                  </div>
                </>
              )}
              {/* 歌曲列表：宽屏最多两列。之前 2xl 强上三列，单行被压成细长条，
                  封面与文字都显小；两列 + 更大的行高更符合「歌曲条目」的阅读节奏 */}
              <div className="grid grid-cols-1 gap-x-3 gap-y-1 xl:grid-cols-2">
                {displayedResults.map((song, index) => {
                  const isCurrentSong = isSameSong(song, currentSong)
                  return (
                <motion.div
                  key={`search-result-${song.platform}-${song.mid || song.id}-${index}`}
                  data-song-index={index}
                  data-song-id={song.id || song.mid}
                  onContextMenu={(event) => openSongContextMenu(event, song)}
                  onClick={() => {
                    const songPlatform: MusicPlatform = song.platform || 'netease'
                    setInstantClose(true)
                    onSongSelect(song, allResults, { surface: 'search', platform: songPlatform, searchMode: platform })
                    onClose()
                  }}
                  className={`flex min-w-0 items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-all duration-200 group border ${
                    isCurrentSong 
                      ? 'bg-blue-500/20 border-blue-500/50' 
                      : `border-transparent ${hoverBg} hover:ring-1 ${hoverRing}`
                  }`}
                >
                  {/* 序号：非当前播放项在悬停时切换为播放图标，明确「点击即播放」 */}
                  <div className="w-6 flex-shrink-0 flex items-center justify-center">
                    {isCurrentSong ? (
                      <span className="text-[13px] font-semibold tabular-nums text-blue-400">{index + 1}</span>
                    ) : (
                      <>
                        <span className={`text-[13px] tabular-nums group-hover:hidden ${textTertiary}`}>{index + 1}</span>
                        <Play className={`hidden h-4 w-4 group-hover:block ${textPrimary}`} />
                      </>
                    )}
                  </div>

                  {/* 封面 */}
                  <div className={`w-12 h-12 rounded-md overflow-hidden ${bgCard} flex-shrink-0`}>
                    {song.album?.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(song.album.picUrl)} 
                        alt={songText(song.name, '歌曲封面')} 
                        className="w-full h-full object-cover"
                        role="compact"
                        size={128}
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

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className={`font-medium truncate text-[15px] ${
                        isCurrentSong 
                          ? 'text-blue-400' 
                          : `${textPrimary} group-hover:${textPrimary}/90`
                      }`}>
                        {songText(song.name, '未知歌曲')}
                      </h3>
                      {/* VIP标识 - 只有当歌曲需要VIP且用户不是VIP时才显示 */}
                      {song.vip && !isVipForPlatform(song.platform) && (
                        <span className="flex-shrink-0 px-1.5 py-px text-[10px] font-bold rounded border border-yellow-500 text-yellow-500 leading-4">
                          VIP
                        </span>
                      )}
                      {/* 无版权标识 */}
                      {song.noCopyright && (
                        <span className={`flex-shrink-0 px-1.5 py-px text-[10px] font-medium rounded bg-gray-600/80 ${textPrimary}/80 leading-4`}>
                          无版权
                        </span>
                      )}
                      {isFused && renderSongSourceChoice(song)}
                    </div>
                    <p className={`text-[13px] truncate ${
                      isCurrentSong 
                        ? 'text-blue-300' 
                        : `${textPrimary}/50`
                    }`}>
                      {songArtists(song)}
                      {songText(song.album?.name, '') && (
                        <span className={`${textPrimary}/30`}> · {songText(song.album?.name, '')}</span>
                      )}
                    </p>
                  </div>

                  {/* 时长 */}
                  <div className={`${textPrimary}/40 text-[13px] tabular-nums flex-shrink-0`}>
                    {formatDuration(song.duration)}
                  </div>
                </motion.div>
                )})}
                
                {/* 触底自动续载的兜底提示（滚动到底仍未触发时也可点击） */}
                {displayedResults.length < allResults.length && (
                  <div className={`col-span-full flex items-center justify-center gap-2 py-3 ${textTertiary} text-xs`}>
                    {loadingMore ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-current/30 border-t-current rounded-full animate-spin" />
                        加载中…
                      </>
                    ) : (
                      <button type="button" onClick={() => void handleLoadMore()} className="hover:underline">
                        加载更多（还有 {allResults.length - displayedResults.length} 首）
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : isFused && (artistResults.length > 0 || albumResults.length > 0) ? (
            <div>
              {renderFusedEntitySections()}
              <div className={`flex items-center justify-center py-8 ${textTertiary}`}>
                <Music className="w-5 h-5 mr-2 opacity-40" />
                没有找到相关歌曲
              </div>
            </div>
          ) : searched ? (
            <div className={`flex flex-col items-center justify-center py-14 ${textPrimary}/40`}>
              {isFused ? (
                <>
                  <Sparkles className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">所有平台都没有找到「{keyword.trim()}」</p>
                  <p className={`${textTertiary} text-xs mt-1`}>换个关键词，或试试单平台搜索</p>
                </>
              ) : searchType === 'artist' ? (
                <>
                  <User className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">没有找到相关艺人</p>
                  <p className={`${textTertiary} text-xs mt-1`}>「{keyword.trim()}」无匹配结果</p>
                </>
              ) : searchType === 'album' ? (
                <>
                  <Disc className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">没有找到相关专辑</p>
                  <p className={`${textTertiary} text-xs mt-1`}>「{keyword.trim()}」无匹配结果</p>
                </>
              ) : searchType === 'playlist' ? (
                <>
                  <ListMusic className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">没有找到相关歌单</p>
                  <p className={`${textTertiary} text-xs mt-1`}>「{keyword.trim()}」无匹配结果</p>
                </>
              ) : (
                <>
                  <Music className="w-12 h-12 mb-3 opacity-20" />
                  <p className="text-sm">没有找到相关歌曲</p>
                  <p className={`${textTertiary} text-xs mt-1`}>「{keyword.trim()}」无匹配结果</p>
                </>
              )}
            </div>
          ) : keyword.trim() === '' && (hotSearch.length > 0 || searchHistory.length > 0) ? (
            /* 未搜索且输入为空时的发现区：热词 + 历史以内嵌双栏铺满宽屏，
               替代原先挂在输入框下方的窄浮层（宽屏下会被拉成细长条） */
            <div className="grid gap-x-6 gap-y-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              {/* 热门搜索 */}
              <section className="min-w-0">
                <div className="mb-3 flex items-center gap-2">
                  <TrendingUp className={`w-4 h-4 ${textSecondary}`} />
                  <h3 className={`${textPrimary} text-sm font-medium`}>
                    {platform === 'fused' ? '热门搜索' : '搜索热词'}
                  </h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  {hotSearch.map((item: any, i: number) => {
                    const word = item.first || item.k || item.word || item.keyword || item.hotWord || item.query || item.sKey || ''
                    if (!word) return null
                    return (
                      <button
                        key={`hot-${i}`}
                        onClick={() => {
                          setKeyword(word)
                          void handleSearch(word)
                        }}
                        className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                          i < 3 ? 'font-semibold' : ''
                        } ${playerTheme === 'dark'
                          ? 'bg-white/8 hover:bg-white/16 text-white/80'
                          : 'bg-black/6 hover:bg-black/12 text-black/75'}`}
                      >
                        {word}
                      </button>
                    )
                  })}
                </div>
              </section>

              {/* 搜索历史 */}
              <section className="min-w-0">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Clock className={`w-4 h-4 ${textSecondary}`} />
                    <h3 className={`${textPrimary} text-sm font-medium`}>搜索历史</h3>
                  </div>
                  {searchHistory.length > 0 && (
                    <button
                      onClick={clearSearchHistory}
                      className={`${textTertiary} hover:${textPrimary} text-xs transition-colors`}
                    >
                      清空
                    </button>
                  )}
                </div>
                {searchHistory.length > 0 ? (
                  <div className="space-y-0.5">
                    {searchHistory.map((item, index) => (
                      <button
                        key={`history-${index}`}
                        onClick={() => {
                          setKeyword(item)
                          void handleSearch(item)
                        }}
                        className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${textPrimary}/80 hover:${textPrimary} ${hoverBg}`}
                      >
                        <History className={`w-3.5 h-3.5 flex-shrink-0 ${textTertiary}`} />
                        <span className="truncate">{item}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className={`${textTertiary} text-xs`}>暂无搜索历史</p>
                )}
              </section>
            </div>
          ) : (
            <div className={`flex flex-col items-center justify-center py-16 ${textPrimary}/40`}>
              <Search className="w-12 h-12 mb-3 opacity-20" />
              <p className="text-sm">搜索你喜欢的音乐</p>
              <p className={`${textTertiary} text-xs mt-1`}>支持歌曲 / 艺人 / 专辑 / 歌单，回车即可搜索</p>
            </div>
          )}
          {/* 滚动辅助按钮 */}
          {(isFused || searchType === 'song') && displayedResults.length > 0 && (
            <>
              <ScrollToTop 
                scrollContainerRef={scrollContainerRef}
                theme={playerTheme}
              />
              <ScrollToCurrentSong
                scrollContainerRef={scrollContainerRef}
                currentSongIndex={currentSong ? displayedResults.findIndex(song => isSameSong(song, currentSong)) : -1}
                theme={playerTheme}
              />
            </>
          )}
        </div> {/* 关闭搜索结果区域 */}
        </div> {/* 关闭内容区 */}
      </motion.div>
    </motion.div>
    {/* 艺人详情模态框 */}
    {songContextMenu.song && (
      <SongContextMenu
        show={songContextMenu.show}
        x={songContextMenu.x}
        y={songContextMenu.y}
        song={songContextMenu.song}
        onClose={() => setSongContextMenu(previous => ({ ...previous, show: false }))}
        onPlayNow={(song) => {
          const songPlatform: MusicPlatform = song.platform || 'netease'
          setInstantClose(true)
          onSongSelect(song, allResults, { surface: 'search', platform: songPlatform, searchMode: platform })
          onClose()
        }}
        onPlayNext={onPlayNext}
        onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites}
        onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments}
        onViewAlbum={(song) => {
          const songPlatform = song.platform || 'netease'
          void resolveSongAlbumIdentifier(song, songPlatform).then(albumId => {
            if (albumId) onOpenAlbum?.(albumId, songPlatform)
          })
        }}
        onViewArtist={(song) => {
          const songPlatform = song.platform || 'netease'
          const artist = song.artists?.[0]
          // 汽水无艺人 ID，约定传歌手名
        const artistId = songPlatform === 'soda' ? (artist?.name || artist?.mid || artist?.id)
          : songPlatform === 'qq' ? (artist?.mid || artist?.id)
            : songPlatform === 'apple' ? (artist?.appleId || artist?.id) : (artist?.mid || artist?.id)
          if (artistId) onOpenArtist?.(String(artistId), songPlatform)
        }}
        onCopyInfo={onCopyInfo}
        userPlaylists={contextUserPlaylists}
        platform={songContextMenu.song.platform || 'netease'}
      />
    )}

    <AnimatePresence>
      {selectedArtist && entityId(selectedArtist) && (
        <ArtistDetailModal
          artistId={entityId(selectedArtist)}
          platform={selectedArtistPlatform}
          onClose={() => {
            setSelectedArtist(null)
            setSelectedArtistAlbumId(undefined)
            onRestoreConsumed?.()
          }}
          onSongSelect={(song, songs) => {
            // 纵深防御：无论艺人弹窗内部回调是否触发，选歌播放时一律关闭艺人弹窗与整个搜索面板，
            // 避免播放页出现后搜索/艺人/专辑界面还叠在上面
            setInstantClose(true)
            setSelectedArtist(null)
            setSelectedArtistAlbumId(undefined)
            onClose()
            onSongSelect(song, songs, {
              surface: selectedArtistAlbumId ? 'search-artist-album' : 'search-artist',
              platform: selectedArtistPlatform,
              searchMode: platform,
              artistId: entityId(selectedArtist),
              albumId: selectedArtistAlbumId,
              artistTab: selectedArtistTab,
            })
          }}
          initialAlbumId={selectedArtistAlbumId}
          onAlbumOpen={setSelectedArtistAlbumId}
          initialTab={selectedArtistTab || 'hotSongs'}
          onTabChange={setSelectedArtistTab}
          playerTheme={playerTheme}
          neteaseVip={neteaseVip}
          qqVip={qqVip}
          currentSong={currentSong}
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

    {/* 专辑详情模态框 */}
    <AnimatePresence>
      {selectedAlbum && entityId(selectedAlbum) && (
        <AlbumDetailModal
          albumId={entityId(selectedAlbum)}
          platform={selectedAlbumPlatform}
          onClose={() => {
            setSelectedAlbum(null)
            onRestoreConsumed?.()
          }}
          onSongSelect={(song, songs) => {
            // 纵深防御：选歌播放时关闭专辑弹窗与整个搜索面板，避免播放页出现后界面还叠在上面
            setInstantClose(true)
            setSelectedAlbum(null)
            onClose()
            onSongSelect(song, songs, {
              surface: 'search-album',
              platform: selectedAlbumPlatform,
              searchMode: platform,
              albumId: entityId(selectedAlbum),
            })
          }}
          playerTheme={playerTheme}
          neteaseVip={neteaseVip}
          qqVip={qqVip}
          currentSong={currentSong}
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
    </>
  )
}
