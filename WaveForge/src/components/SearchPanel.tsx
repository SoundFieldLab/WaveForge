import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, X, Music, History, Clock, User, Disc, Sparkles, TrendingUp, ListMusic } from 'lucide-react'
import { searchSongs, searchSuggest, searchArtists, searchAlbums, searchQuick, searchPlaylists, Song, Artist, Album, SearchSuggestion, getProxiedImageUrl, loadAlbumCovers, resolveSongAlbumIdentifier, searchHot } from '../services/musicApi'
import { mergeFusedSearchResults, type FusedSearchIntent, type MusicPlatform } from '../services/fusedSearch'
import { isPlatformVisible } from '../services/platforms'
import { useTvBack } from '../tv/tvCore'
import CachedImage from './CachedImage'
import ArtistDetailModal from './ArtistDetailModal'
import AlbumDetailModal from './AlbumDetailModal'
import ScrollToTop from './ScrollToTop'
import ScrollToCurrentSong from './ScrollToCurrentSong'
import type { PlaybackOrigin, SongSelectHandler } from '../types/playbackNavigation'
import SongContextMenu from './SongContextMenu'
import { getUserPlaylists } from '../services/playlistService'
import { searchAppleSongsAsSongs, searchAppleCatalogArtists, searchAppleCatalogAlbums, getAppleLibraryPlaylists } from '../services/appleCatalog'
import { parseStoredArray } from '../utils/storage'

interface SearchPanelProps {
  onSongSelect: SongSelectHandler
  onClose: () => void
  restorePlaybackOrigin?: (PlaybackOrigin & { revision: number }) | null
  playerTheme?: 'light' | 'dark'
  neteaseVip?: boolean
  qqVip?: boolean
  neteaseLoggedIn?: boolean
  qqLoggedIn?: boolean
  currentSong?: Song | null
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void | Promise<unknown>
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onViewComments?: (song: Song) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
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
// 搜索结果缓存上限：每次搜索缓存完整结果集（约 100 首歌对象），面板是常驻单例，
// 不加上限会导致 Map 无限增长（内存泄漏）。超出上限时按 LRU 淘汰最旧的 cacheKey。
const SEARCH_CACHE_MAX = 10
type SearchPlatform = MusicPlatform | 'fused'

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
  currentSong = null,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onOpenArtist,
  onOpenAlbum,
  onCopyInfo,
  onRestoreConsumed
}: SearchPanelProps) {
  // TV 遥控器 BACK：关闭搜索面板
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('🔍 SearchPanel 渲染')
  console.log('  playerTheme:', playerTheme)
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  
  // 根据主题生成颜色类名
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const hoverBg = playerTheme === 'dark' ? 'hover:bg-white/5' : 'hover:bg-black/5'
  
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
  const [loadingMore, setLoadingMore] = useState(false) // 加载更多状态
  const [searched, setSearched] = useState(() => {
    const saved = sessionStorage.getItem('waveforge_search_searched')
    return saved === 'true'
  })
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1) // 键盘选择的索引
  const [displayCount, setDisplayCount] = useState(() => {
    const saved = sessionStorage.getItem('waveforge_search_display_count')
    return saved ? parseInt(saved) : 20
  })
  const [isInputFocused, setIsInputFocused] = useState(false) // 输入框是否聚焦
  const scrollContainerRef = useRef<HTMLDivElement>(null) // 滚动容器引用
  const searchRequestRef = useRef(0)
  // 搜索结果缓存 per platform，避免切换平台后重新搜索
  const searchCacheRef = useRef<Map<string, {
    allResults: Song[]; artistResults: Artist[]; albumResults: Album[];
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
    const userId = songPlatform === 'qq'
      ? localStorage.getItem('qq_user_id') || ''
      : localStorage.getItem('netease_user_id') || ''
    if (!userId) return
    const username = songPlatform === 'qq'
      ? localStorage.getItem('qq_username') || ''
      : localStorage.getItem('netease_username') || ''
    void getUserPlaylists(songPlatform, userId, username)
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
    if (song1.mid && song2.mid) return song1.mid === song2.mid
    if (song1.id && song2.id) return song1.id === song2.id
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
  const selectedArtistPlatform: MusicPlatform = selectedArtist?.platform === 'qq' ? 'qq' : 'netease'
  const selectedAlbumPlatform: MusicPlatform = selectedAlbum?.platform === 'qq' ? 'qq' : 'netease'
  const [selectedArtistAlbumId, setSelectedArtistAlbumId] = useState<string | number | undefined>()
  const [selectedArtistTab, setSelectedArtistTab] = useState<PlaybackOrigin['artistTab']>('hotSongs')

  useEffect(() => {
    if (!restorePlaybackOrigin?.surface.startsWith('search')) return
    const restoredPlatform: SearchPlatform = restorePlaybackOrigin.searchMode === 'fused'
      ? 'fused'
      : (restorePlaybackOrigin.platform === 'apple' ? 'netease' : (restorePlaybackOrigin.platform || platform))
    if (restoredPlatform !== platform) setPlatform(restoredPlatform)

    if (restorePlaybackOrigin.surface === 'search-album' && restorePlaybackOrigin.albumId) {
      const restoredAlbum = albumResults.find(album => String(album.mid || album.id) === String(restorePlaybackOrigin.albumId))
        || ({
          id: restorePlaybackOrigin.platform === 'netease' ? Number(restorePlaybackOrigin.albumId) : 0,
          mid: restorePlaybackOrigin.platform === 'qq' ? String(restorePlaybackOrigin.albumId) : undefined,
          name: '',
          picUrl: '',
          platform: restorePlaybackOrigin.platform,
        } as Album)
      setSelectedArtist(null)
      setSelectedAlbum(restoredAlbum)
      return
    }

    if ((restorePlaybackOrigin.surface === 'search-artist' || restorePlaybackOrigin.surface === 'search-artist-album') && restorePlaybackOrigin.artistId) {
      const restoredArtist = artistResults.find(artist => String(artist.mid || artist.id) === String(restorePlaybackOrigin.artistId))
        || ({
          id: restorePlaybackOrigin.platform === 'netease' ? Number(restorePlaybackOrigin.artistId) : 0,
          mid: restorePlaybackOrigin.platform === 'qq' ? String(restorePlaybackOrigin.artistId) : undefined,
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
  useEffect(() => {
    sessionStorage.setItem('waveforge_search_keyword', keyword)
    sessionStorage.setItem('waveforge_search_searched', searched.toString())
    sessionStorage.setItem('waveforge_search_platform', platform)
    sessionStorage.setItem('waveforge_search_type', searchType)
    sessionStorage.setItem('waveforge_search_display_count', displayCount.toString())
    sessionStorage.setItem('waveforge_search_fusion_intent', fusionIntent)
    
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
  }, [keyword, searched, platform, searchType, displayCount, allResults, displayedResults, artistResults, albumResults, fusionIntent])

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
        console.log('🔍 正在获取搜索建议:', keyword.trim(), platform)
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
            : await searchSuggest(keyword.trim(), platform)
        if (!active) return
        console.log('📝 搜索建议结果:', result)
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
    setSearched(true)
    setShowSuggestions(false)
    setSelectedIndex(-1)
    setDisplayCount(20) // 重置显示数量
    
    // 检查缓存：同一平台+同一关键词的搜索结果
    const cacheKey = `${platform}:${finalKeyword}`
    const cached = searchCacheRef.current.get(cacheKey)
    if (cached) {
      setArtistResults(cached.artistResults)
      setAlbumResults(cached.albumResults)
      setAllResults(cached.allResults)
      setDisplayedResults(cached.allResults.slice(0, 20))
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
        // 融合搜索覆盖全部可搜索平台（soda 接口暂不可用，跳过避免无效请求）
        const platforms: MusicPlatform[] = ['netease', 'qq', 'apple', 'spotify', 'kugou']
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
            apple: { loggedIn: false, vip: false },
            spotify: { loggedIn: false, vip: false },
            kugou: { loggedIn: false, vip: false },
            soda: { loggedIn: false, vip: false },
          },
        })
        setFusionUnavailablePlatforms(unavailable)
        setFusionIntent(fused.intent)
        setArtistResults(fused.artists)
        setAlbumResults(fused.albums)
        setAllResults(fused.songs)
        setDisplayedResults(fused.songs.slice(0, 20))
        // 缓存结果（LRU，超出上限自动淘汰最旧条目）
        setLruCache(searchCacheRef.current, cacheKey, {
          allResults: fused.songs, artistResults: fused.artists, albumResults: fused.albums,
          artists: fused.artists, albums: fused.albums, unavailable, intent: fused.intent
        }, SEARCH_CACHE_MAX)
      } else if (platform === 'apple') {
        // Apple Music 目录搜索（iTunes Search，免 token；storefront 决定地区）
        const storefront = localStorage.getItem('appleStorefront') || 'cn'
        if (searchType === 'song') {
          const songs = await searchAppleSongsAsSongs(finalKeyword, storefront, 50)
          if (requestId !== searchRequestRef.current) return
          setAllResults(songs)
          setDisplayedResults(songs.slice(0, 20))
        } else if (searchType === 'artist') {
          const artists = await searchAppleCatalogArtists(finalKeyword, storefront)
          if (requestId !== searchRequestRef.current) return
          setArtistResults(artists.map(artist => ({
            id: Number(artist.id) || 0,
            name: artist.name,
            picUrl: artist.artworkUrl || '',
            platform: 'apple',
          })))
        } else if (searchType === 'album') {
          const albums = await searchAppleCatalogAlbums(finalKeyword, storefront)
          if (requestId !== searchRequestRef.current) return
          setAlbumResults(albums.map(album => ({
            id: Number(album.id) || 0,
            name: album.name,
            picUrl: album.artworkUrl || '',
            artist: { name: album.artistName },
            platform: 'apple',
          })))
        } else if (searchType === 'playlist') {
          // Apple 无歌单搜索接口（编辑精选歌单走探索页）
          setPlaylistResults([])
        }
      } else if (searchType === 'song') {
        const songResult = await searchSongs(finalKeyword, 100, platform)
        if (requestId !== searchRequestRef.current) return
        console.log('🔍 搜索结果:', { songs: songResult.songs.length })
        setAllResults(songResult.songs)
        setDisplayedResults(songResult.songs.slice(0, 20))
      } else if (searchType === 'artist') {
        const artists = await searchArtists(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        console.log('🔍 艺人搜索结果:', { artists: artists.length })
        setArtistResults(artists)
      } else if (searchType === 'album') {
        console.log('🔍 开始搜索专辑:', finalKeyword, 'platform:', platform)
        const albums = await searchAlbums(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        console.log('🔍 专辑搜索结果:', { albums: albums.length, data: albums })
        console.log('🔍 第一个专辑数据:', albums[0])
        setAlbumResults(albums)
        console.log('🔍 专辑结果已设置，调用 setAlbumResults，长度:', albums.length)
      } else if (searchType === 'playlist') {
        console.log('🔍 开始搜索歌单:', finalKeyword, 'platform:', platform)
        const data = await searchPlaylists(finalKeyword, platform)
        if (requestId !== searchRequestRef.current) return
        const raw = platform === 'qq' ? (data?.playlists || []) : (data?.result?.playlists || [])
        setPlaylistResults(Array.isArray(raw) ? raw.map((p: any) => ({
          id: String(p.id || ''),
          name: p.name || '',
          coverImgUrl: p.coverImgUrl || p.picUrl || '',
          trackCount: Number(p.trackCount ?? p.trackNumber ?? 0),
          creator: p.creator?.nickname || p.creator?.nick || p.creator || '',
          platform,
        })) : [])
        console.log('🔍 歌单搜索结果:', raw.length)
      }
    } catch (error) {
      console.error('❌ 搜索失败:', error)
    } finally {
      console.log('🔍 搜索完成，设置 loading = false')
      if (requestId === searchRequestRef.current) setLoading(false)
    }
  }

  // 切换搜索类型（不立即搜索）
  const handleSearchByType = (type: 'song' | 'artist' | 'album' | 'playlist') => {
    setSearchType(type)
  }

  // 加载更多结果
  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const newCount = displayCount + 20
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
      setShowSuggestions(false)
      setSelectedIndex(-1)
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

  const entitlementLabel = (sourcePlatform: MusicPlatform) => {
    const loggedIn = sourcePlatform === 'qq' ? qqSessionActive : neteaseSessionActive
    const vip = sourcePlatform === 'qq' ? qqVip : neteaseVip
    if (vip) return 'VIP · 优先展示'
    if (loggedIn) return '已登录 · 非会员'
    return '未登录'
  }

  const platformText = (platforms: MusicPlatform[]) => {
    const unique = Array.from(new Set(platforms))
    if (unique.length > 1) return '双平台'
    return unique[0] === 'qq' ? 'QQ音乐' : '网易云'
  }

  const renderSongSourceChoice = (song: Song) => {
    const preferredPlatform: MusicPlatform = song.platform === 'qq' ? 'qq' : 'netease'
    const sources = Array.from(new Set(
      (song.fusedSources || [{ platform: preferredPlatform }]).map(source => source.platform),
    ))
    const preferredVip = preferredPlatform === 'qq' ? qqVip : neteaseVip
    return (
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium border ${
          preferredPlatform === 'qq'
            ? 'bg-green-500/15 text-green-300 border-green-400/20'
            : 'bg-red-500/15 text-red-300 border-red-400/20'
        }`}>
          首选 {preferredPlatform === 'qq' ? 'QQ音乐' : '网易云'}{preferredVip ? ' · VIP' : ''}
        </span>
        {sources.length > 1 && <span className={`${textTertiary} text-[11px]`}>双平台</span>}
      </div>
    )
  }

  const renderFusedEntitySections = () => (
    <div className="space-y-4 mb-4">
      {artistResults.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <User className={`w-4 h-4 ${textSecondary}`} />
            <h3 className={`${textPrimary} font-semibold`}>相关艺人</h3>
            <span className={`${textTertiary} text-xs`}>智能命中 {artistResults.length} 位 · 最多 6 位</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {artistResults.map(artist => {
              const sourcePlatform: MusicPlatform = artist.platform === 'qq' ? 'qq' : 'netease'
              return (
                <motion.button
                  type="button"
                  key={`fused-artist-${artist.platform}-${artist.mid || artist.id}`}
                  whileHover={{ y: -1 }}
                  onClick={() => setSelectedArtist(artist)}
                  className={`${bgCard} border ${borderColor} rounded-lg p-2 text-left flex items-center gap-2 transition-colors ${hoverBg} min-w-0`}
                >
                  <div className="w-10 h-10 rounded-full overflow-hidden bg-white/5 flex-shrink-0">
                    {artist.picUrl ? (
                      <CachedImage src={getProxiedImageUrl(artist.picUrl)} alt={artist.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><User className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} /></div>
                    )}
                  </div>
                  <div className={`${textPrimary} text-sm font-medium truncate flex-1 min-w-0`}>{artist.name}</div>
                  <span className={`text-[11px] flex-shrink-0 ${sourcePlatform === 'qq' ? 'text-green-300/80' : 'text-red-300/80'}`}>
                    {sourcePlatform === 'qq' ? 'QQ音乐' : '网易云'}
                  </span>
                </motion.button>
              )
            })}
          </div>
        </section>
      )}

      {albumResults.length > 0 && (
        <section>
          <div className="flex items-center gap-2 mb-2">
            <Disc className={`w-4 h-4 ${textSecondary}`} />
            <h3 className={`${textPrimary} font-semibold`}>相关专辑</h3>
            <span className={`${textTertiary} text-xs`}>智能命中 {albumResults.length} 张 · 最多 6 张</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {albumResults.map(album => (
              <motion.button
                type="button"
                key={`fused-album-${album.platform}-${album.mid || album.id}`}
                whileHover={{ y: -1 }}
                onClick={() => setSelectedAlbum(album)}
                className={`${bgCard} border ${borderColor} rounded-lg p-2 text-left flex items-center gap-2 transition-colors ${hoverBg} min-w-0`}
              >
                <div className="w-10 h-10 rounded-md overflow-hidden bg-white/5 flex-shrink-0">
                  {album.picUrl ? (
                    <CachedImage src={getProxiedImageUrl(album.picUrl)} alt={album.name} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><Disc className={`w-5 h-5 ${playerTheme === 'dark' ? 'text-white/20' : 'text-black/20'}`} /></div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className={`${textPrimary} text-sm font-medium truncate`}>{album.name}</div>
                  <div className={`${textSecondary} text-xs truncate`}>{album.artist?.name || '未知艺人'}</div>
                </div>
                <span className={`${textTertiary} text-[11px] flex-shrink-0 max-w-20 text-right leading-4`}>
                  {platformText(album.sourcePlatforms || [album.platform === 'qq' ? 'qq' : 'netease'])}
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
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-8"
      style={{
        backdropFilter: 'blur(2px)',
        WebkitBackdropFilter: 'blur(2px)',
        backgroundColor: playerTheme === 'dark' ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.35)',
      }}
      onClick={(e) => {
        console.log('🖱️ SearchPanel 背景被点击，准备关闭')
        onClose()
      }}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        onClick={(e) => {
          console.log('🖱️ SearchPanel 内容区域被点击，阻止冒泡')
          e.stopPropagation()
        }}
        className="rounded-3xl shadow-2xl w-full max-w-5xl max-h-[85vh] flex flex-col overflow-hidden relative"
      >
        {/* 液态玻璃背景层 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden">
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
            className="absolute inset-0 rounded-3xl"
            style={{
              border: playerTheme === 'dark' ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(0,0,0,0.1)',
              boxShadow: playerTheme === 'dark' ? 'inset 0 1px 1px rgba(255,255,255,0.1)' : 'inset 0 1px 1px rgba(255,255,255,0.8)',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Content area */}
        <div className="relative z-10 flex flex-col h-full">
        {/* 头部 */}
        <div className={`p-6 border-b ${borderColor}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-2xl font-bold ${textPrimary}`}>搜索音乐</h2>
            <button
              onClick={onClose}
              className={`p-2 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
            >
              <X className={`w-6 h-6 ${textPrimary}/60`} />
            </button>
          </div>

          {/* 平台切换 */}
          <div className="flex flex-wrap items-start gap-2 mb-4">
            <button
              onClick={() => setPlatform('fused')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg flex items-center gap-2 ${
                platform === 'fused'
                  ? 'bg-gradient-to-r from-violet-600/95 to-blue-600/95 text-white shadow-violet-500/20'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              <Sparkles className="w-4 h-4" />
              融合搜索
            </button>
            {isPlatformVisible('netease') && (
            <button
              onClick={() => setPlatform('netease')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'netease'
                  ? 'bg-red-600/90 text-white hover:bg-red-600'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              网易云音乐
            </button>
            )}
            {isPlatformVisible('qq') && (
            <button
              onClick={() => setPlatform('qq')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'qq'
                  ? 'bg-green-600/90 text-white hover:bg-green-600'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              QQ音乐
            </button>
            )}
            {isPlatformVisible('apple') && (
            <button
              onClick={() => setPlatform('apple')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'apple'
                  ? 'bg-pink-600/90 text-white hover:bg-pink-600'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              Apple Music
            </button>
            )}
            {isPlatformVisible('spotify') && (
            <button
              onClick={() => setPlatform('spotify')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'spotify'
                  ? 'bg-emerald-500/90 text-white hover:bg-emerald-500'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              Spotify
            </button>
            )}
            {isPlatformVisible('kugou') && (
            <button
              onClick={() => setPlatform('kugou')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'kugou'
                  ? 'bg-orange-500/90 text-white hover:bg-orange-500'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              酷狗音乐
            </button>
            )}
            {isPlatformVisible('soda') && (
            <button
              onClick={() => setPlatform('soda')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'soda'
                  ? 'bg-sky-500/90 text-white hover:bg-sky-500'
                  : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
              }`}
            >
              汽水音乐
            </button>
            )}
            <div className="flex-1 min-w-4" />
            {isFused ? (
              <div className={`px-4 py-2 rounded-2xl bg-violet-500/10 border border-violet-400/20 text-xs leading-5 ${playerTheme === 'dark' ? 'text-violet-200/80' : 'text-violet-700/80'}`}>
                自动识别艺人、专辑与歌曲<br />
                QQ：{entitlementLabel('qq')} · 网易云：{entitlementLabel('netease')}
              </div>
            ) : <div className="flex flex-col gap-2">
              {/* 搜艺人和搜专辑按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleSearchByType('artist')}
                  disabled={loading}
                  className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg disabled:opacity-50 ${
                    searchType === 'artist'
                      ? 'bg-purple-600/90 text-white hover:bg-purple-600'
                      : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
                  }`}
                >
                  <User className="w-4 h-4 inline-block mr-1" />
                  搜艺人
                </button>
                <button
                  onClick={() => handleSearchByType('album')}
                  disabled={loading}
                  className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg disabled:opacity-50 ${
                    searchType === 'album'
                      ? 'bg-blue-600/90 text-white hover:bg-blue-600'
                      : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
                  }`}
                >
                  <Disc className="w-4 h-4 inline-block mr-1" />
                  搜专辑
                </button>
                <button
                  onClick={() => handleSearchByType('song')}
                  disabled={loading}
                  className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg disabled:opacity-50 ${
                    searchType === 'song'
                      ? 'bg-green-600/90 text-white hover:bg-green-600'
                      : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
                  }`}
                >
                  <Music className="w-4 h-4 inline-block mr-1" />
                  搜歌曲
                </button>
                <button
                  onClick={() => handleSearchByType('playlist')}
                  disabled={loading}
                  className={`px-4 py-2 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg disabled:opacity-50 ${
                    searchType === 'playlist'
                      ? 'bg-amber-600/90 text-white hover:bg-amber-600'
                      : playerTheme === 'dark'
                    ? 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
                    : 'bg-black/10 text-black/60 hover:bg-black/15 hover:text-black'
                  }`}
                >
                  <ListMusic className="w-4 h-4 inline-block mr-1" />
                  搜歌单
                </button>
              </div>
            </div>}
          </div>

          {/* 搜索框 */}
          <div className="flex gap-3 relative">
            <div className="flex-1 relative">
              <Search className={`absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 ${textPrimary}/40`} />
              <input
                type="text"
                value={keyword}
                onChange={(e) => {
                  setKeyword(e.target.value)
                  // 输入时重置searched状态，以便重新显示搜索建议
                  setSearched(false)
                }}
                onFocus={() => setIsInputFocused(true)}
                onBlur={() => {
                  // 延迟关闭，以便点击事件能够触发
                  setTimeout(() => setIsInputFocused(false), 200)
                }}
                onKeyDown={handleKeyPress}
                placeholder="搜索歌曲、艺术家..."
                className={`w-full ${bgCard} border ${borderColor} rounded-xl pl-12 pr-12 py-3 ${textPrimary} ${playerTheme === 'dark' ? 'placeholder-white/40 focus:border-white/30' : 'placeholder-black/35 focus:border-black/30'} focus:outline-none transition-colors`}
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
                  }}
                  className={`absolute right-4 top-1/2 transform -translate-y-1/2 p-1 rounded-full transition-colors ${playerTheme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'}`}
                >
                  <X className={`w-4 h-4 ${textPrimary}/40 hover:${textPrimary}/60`} />
                </button>
              )}
              
              {/* 搜索热词 + 搜索历史（合并显示） */}
              {isInputFocused && !searched && keyword.trim() === '' && (hotSearch.length > 0 || searchHistory.length > 0) && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute top-full left-0 right-0 mt-2 rounded-xl overflow-hidden z-10 shadow-2xl"
                  style={{
                    background: playerTheme === 'dark'
                      ? 'linear-gradient(135deg, rgba(20,20,30,0.92) 0%, rgba(0,0,0,0.95) 100%)'
                      : 'linear-gradient(135deg, rgba(250,250,248,0.94) 0%, rgba(244,244,242,0.96) 100%)',
                    backdropFilter: 'blur(20px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(20px) saturate(150%)',
                    border: playerTheme === 'dark' ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.08)',
                  }}
                >
                  <div className={`flex ${platform === 'fused' ? '' : ''}`}>
                    {/* 搜索热词列 */}
                    {hotSearch.length > 0 && (
                      <div className={`${platform === 'fused' ? 'w-1/2' : 'w-1/2'} border-r ${playerTheme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
                        <div className={`flex items-center gap-2 px-4 py-2 border-b ${playerTheme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
                          <TrendingUp className={`w-4 h-4 ${textPrimary}/60`} />
                          <span className={`${textPrimary}/60 text-sm`}>
                            {platform === 'fused' ? '热门搜索' : '搜索热词'}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-2 px-4 py-3">
                          {hotSearch.map((item: any, i: number) => {
                            const word = item.first || item.k || item.word || item.keyword || item.hotWord || item.query || item.sKey || ''
                            return word ? (
                              <button
                                key={i}
                                onClick={() => {
                                  setKeyword(word)
                                  handleSearch(word)
                                }}
                                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                                  i < 3 ? 'font-semibold' : ''
                                } ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/20 text-white/80' : 'bg-black/8 hover:bg-black/15 text-black/80'}`}
                                style={i < 3 ? { backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)', fontWeight: 600 } : {}}
                              >
                                {word}
                              </button>
                            ) : null
                          })}
                        </div>
                      </div>
                    )}
                    {/* 搜索历史列 */}
                    {searchHistory.length > 0 && (
                      <div className={`${hotSearch.length > 0 ? 'w-1/2' : 'w-full'}`}>
                        <div className={`flex items-center justify-between px-4 py-2 border-b ${playerTheme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
                          <div className={`flex items-center gap-2 ${textPrimary}/60 text-sm`}>
                            <Clock className="w-4 h-4" />
                            <span>搜索历史</span>
                          </div>
                          <button onClick={clearSearchHistory} className={`${textPrimary}/40 hover:${textPrimary}/60 text-xs transition-colors`}>
                            清空
                          </button>
                        </div>
                        {searchHistory.map((item, index) => (
                          <div
                            key={index}
                            onClick={() => {
                              setKeyword(item)
                              handleSearch(item)
                            }}
                            className={`flex items-center px-4 py-3 cursor-pointer transition-colors border-b ${playerTheme === 'dark' ? 'border-white/5' : 'border-black/5'} last:border-b-0 hover:${bgCard} ${textPrimary}/80 hover:${textPrimary}`}
                          >
                            <History className={`w-4 h-4 mr-2 flex-shrink-0 ${textPrimary}/40`} />
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
              
              {/* 搜索建议下拉框 */}
              {showSuggestions && suggestions.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  onMouseDown={(e) => e.preventDefault()} // 防止输入框失焦
                  className="absolute top-full left-0 right-0 mt-2 rounded-xl z-10 shadow-2xl scrollbar-thin"
                  style={{
                    maxHeight: '288px', // 6个建议 * 48px高度 = 288px
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
                  {suggestions.map((suggestion, index) => {
                    // 暂时都显示为搜索图标，因为后端suggest接口不返回准确的类型
                    const Icon = Search
                    
                    return (
                      <div
                        key={index}
                        onMouseDown={(e) => {
                          e.preventDefault() // 防止输入框失焦
                          handleSuggestionClick(suggestion)
                        }}
                        className={`flex items-center px-4 py-3 cursor-pointer transition-colors border-b border-white/5 last:border-b-0 ${
                          index === selectedIndex
                            ? `bg-white/10 ${textPrimary}`
                            : `hover:bg-white/5 ${textPrimary}/80`
                        }`}
                      >
                        <Icon className={`w-4 h-4 mr-2 flex-shrink-0 ${textPrimary}/40`} />
                        <span className={`${textPrimary} truncate`}>{suggestion.keyword}</span>
                      </div>
                    )
                  })}
                </motion.div>
              )}
            </div>
            
            {/* 搜索按钮 */}
            <button
              onClick={() => handleSearch()}
              disabled={loading}
              className="px-6 py-3 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-colors disabled:opacity-50"
            >
              {loading ? '搜索中..' : '搜索'}
            </button>
          </div>
        </div>

        {/* 搜索结果 */}
        <div 
          className="flex-1 px-6 pb-6 pt-2 overflow-hidden"
        >
          <div
            ref={scrollContainerRef}
            className="h-full pr-2"
            style={{
              overflowY: 'auto',
              minHeight: searched ? 'calc(85vh - 240px)' : '380px', // 缩短高度，往上收
              maxHeight: 'calc(85vh - 240px)',
              scrollbarWidth: 'thin',
              scrollbarColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.3) transparent' : 'rgba(0,0,0,0.3) transparent'
            }}
          >
          {!loading && isFused && fusionUnavailablePlatforms.length > 0 && (
            <div className="mb-3 px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-400/20 text-amber-200/80 text-sm">
              {fusionUnavailablePlatforms.map(item => item === 'netease' ? '网易云音乐' : 'QQ音乐').join('、')} 的部分结果暂时不可用，已展示成功返回的内容。
            </div>
          )}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-20">
              {/* 加载动画 */}
              <motion.div
                className="relative w-16 h-16 mb-4"
                animate={{ rotate: 360 }}
                transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
              >
                <div className="absolute inset-0 border-4 border-white/10 rounded-full" />
                <div className="absolute inset-0 border-4 border-transparent border-t-white/60 rounded-full" />
              </motion.div>
              <motion.div 
                className={`${textPrimary}/60`}
                animate={{ opacity: [0.5, 1, 0.5] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              >
                搜索中...
              </motion.div>
            </div>
          ) : !isFused && searchType === 'artist' && artistResults.length > 0 ? (
            // 艺人搜索结果
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {artistResults.map((artist, index) => (
                <motion.div
                  key={`artist-${index}`}
                  whileHover={{ scale: 1.02 }}
                  onClick={() => setSelectedArtist(artist)}
                  className={`${bgCard} rounded-xl p-4 cursor-pointer transition-all hover:shadow-lg border ${borderColor}`}
                >
                  <div className="aspect-square rounded-lg overflow-hidden mb-3">
                    {artist.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(artist.picUrl)} 
                        alt={artist.name}
                        className="w-full h-full object-cover"
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
                  </div>
                  <h3 className={`${textPrimary} font-medium truncate`}>{artist.name}</h3>
                  <div className={`${textSecondary} text-sm mt-1 space-x-3`}>
                    {artist.musicSize !== undefined && (
                      <span>单曲: {artist.musicSize}</span>
                    )}
                    {artist.albumSize !== undefined && (
                      <span>专辑: {artist.albumSize}</span>
                    )}
                  </div>
                </motion.div>
              ))}
            </div>
          ) : !isFused && searchType === 'playlist' && playlistResults.length > 0 ? (
            // 歌单搜索结果
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {playlistResults.map((playlist, index) => (
                <motion.div
                  key={`playlist-${index}`}
                  whileHover={{ scale: 1.02 }}
                  onClick={() => {
                    if (playlist.id) {
                      const w = (window as any).waveforge
                      if (w?.openExternal) void w.openExternal(`https://y.qq.com/n/ryqq_v2/playlist/${playlist.id}`)
                    }
                  }}
                  className={`${bgCard} rounded-xl p-4 cursor-pointer transition-all hover:shadow-lg border ${borderColor}`}
                >
                  <div className="aspect-square rounded-lg overflow-hidden mb-3">
                    {playlist.coverImgUrl ? (
                      <CachedImage
                        src={getProxiedImageUrl(playlist.coverImgUrl)}
                        alt={playlist.name}
                        className="w-full h-full object-cover"
                        fallback={<div className="w-full h-full flex items-center justify-center bg-white/5"><ListMusic className={`w-12 h-12 ${textPrimary}/20`} /></div>}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-white/5"><ListMusic className={`w-12 h-12 ${textPrimary}/20`} /></div>
                    )}
                  </div>
                  <h3 className={`${textPrimary} font-medium truncate`}>{playlist.name}</h3>
                  <p className={`${textSecondary} text-sm mt-1 truncate`}>{playlist.creator || `${playlist.trackCount || 0} 首`}</p>
                </motion.div>
              ))}
            </div>
          ) : !isFused && searchType === 'album' && albumResults.length > 0 ? (
            // 专辑搜索结果
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
              {albumResults.map((album, index) => (
                <motion.div
                  key={`album-${index}`}
                  whileHover={{ scale: 1.02 }}
                  onClick={() => setSelectedAlbum(album)}
                  className={`${bgCard} rounded-xl p-4 cursor-pointer transition-all hover:shadow-lg border ${borderColor}`}
                >
                  <div className="aspect-square rounded-lg overflow-hidden mb-3">
                    {album.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(album.picUrl)} 
                        alt={album.name}
                        className="w-full h-full object-cover"
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
                  </div>
                  <h3 className={`${textPrimary} font-medium truncate`}>{album.name}</h3>
                  <p className={`${textSecondary} text-sm mt-1 truncate`}>{album.artist?.name || '未知艺人'}</p>
                </motion.div>
              ))}
            </div>
          ) : displayedResults.length > 0 ? (
            <div className="space-y-4">
              {isFused && (
                <>
                  <div className={`flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl ${bgCard} border ${borderColor}`}>
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-violet-300" />
                      <span className={`${textPrimary} text-sm font-medium`}>已合并并去除跨平台重复内容</span>
                    </div>
                    <div className={`${textTertiary} text-xs`}>
                      {qqVip ? 'QQ音乐 VIP 优先' : neteaseVip ? '网易云音乐 VIP 优先' : '匹配度与可播放性优先'}
                    </div>
                  </div>
                  {renderFusedEntitySections()}
                  <div className="flex items-center gap-2">
                    <Music className={`w-4 h-4 ${textSecondary}`} />
                    <h3 className={`${textPrimary} font-semibold`}>歌曲</h3>
                    <span className={`${textTertiary} text-xs`}>{allResults.length} 首融合结果</span>
                    <span className="text-[11px] text-green-300/70">QQ {allResults.filter(song => song.platform === 'qq').length}</span>
                    <span className="text-[11px] text-red-300/70">网易云 {allResults.filter(song => song.platform !== 'qq').length}</span>
                  </div>
                </>
              )}
              {/* 歌曲列表 */}
              <div className="space-y-2">
                {displayedResults.map((song, index) => {
                  const isCurrentSong = isSameSong(song, currentSong)
                  return (
                <motion.div
                  key={`search-result-${song.platform}-${song.mid || song.id}-${index}`}
                  data-song-index={index}
                  data-song-id={song.id || song.mid}
                  whileHover={{ scale: 1.01 }}
                  onContextMenu={(event) => openSongContextMenu(event, song)}
                  onClick={() => {
                    const songPlatform: MusicPlatform = song.platform === 'qq' ? 'qq' : 'netease'
                    onSongSelect(song, allResults, { surface: 'search', platform: songPlatform, searchMode: platform })
                    onClose()
                  }}
                  className={`flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-colors group ${
                    isCurrentSong 
                      ? 'bg-blue-500/20 border border-blue-500/50' 
                      : `hover:${bgCard}`
                  }`}
                >
                  {/* 封面 */}
                  <div className={`w-14 h-14 rounded-lg overflow-hidden ${bgCard} flex-shrink-0`}>
                    {song.album?.picUrl ? (
                      <CachedImage 
                        src={getProxiedImageUrl(song.album.picUrl)} 
                        alt={song.name} 
                        className="w-full h-full object-cover"
                        fallback={
                          <div className="w-full h-full flex items-center justify-center">
                            <Music className={`w-6 h-6 ${textPrimary}/20`} />
                          </div>
                        }
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Music className={`w-6 h-6 ${textPrimary}/20`} />
                      </div>
                    )}
                  </div>

                  {/* 信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className={`font-medium truncate ${
                        isCurrentSong 
                          ? 'text-blue-400' 
                          : `${textPrimary} group-hover:${textPrimary}/90`
                      }`}>
                        {song.name}
                      </h3>
                      {/* VIP标识 - 只有当歌曲需要VIP且用户不是VIP时才显示 */}
                      {song.vip && !isVipForPlatform(song.platform) && (
                        <span className="flex-shrink-0 px-2 py-0.5 text-xs font-bold rounded border border-yellow-500 text-yellow-500">
                          VIP
                        </span>
                      )}
                      {/* 无版权标识 */}
                      {song.noCopyright && (
                        <span className={`flex-shrink-0 px-2 py-0.5 text-xs font-medium rounded bg-gray-600/80 ${textPrimary}/80`}>
                          无版权
                        </span>
                      )}
                      {isFused && renderSongSourceChoice(song)}
                    </div>
                    <p className={`text-sm truncate ${
                      isCurrentSong 
                        ? 'text-blue-300' 
                        : `${textPrimary}/50`
                    }`}>
                      {Array.isArray(song.artists) ? song.artists.map(a => a.name).join(', ') : '未知艺人'}
                    </p>
                  </div>

                  {/* 时长 */}
                  <div className={`${textPrimary}/40 text-sm`}>
                    {formatDuration(song.duration)}
                  </div>
                </motion.div>
                )})}
                
                {/* 加载更多按钮 */}
                {displayedResults.length < allResults.length && (
                  <div className="flex justify-center pt-4">
                    <button
                      onClick={handleLoadMore}
                      disabled={loadingMore}
                      className={`px-6 py-3 bg-white/10 ${textPrimary} rounded-xl font-medium hover:bg-white/15 transition-colors disabled:opacity-50`}
                    >
                      {loadingMore ? '加载中..' : `加载更多 (还有 ${allResults.length - displayedResults.length} 首)`}
                    </button>
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
            <div className={`flex flex-col items-center justify-center py-12 ${textPrimary}/40`}>
              {isFused ? (
                <>
                  <Sparkles className="w-16 h-16 mb-4 opacity-20" />
                  <p>两个平台都没有找到相关内容</p>
                </>
              ) : searchType === 'artist' ? (
                <>
                  <User className="w-16 h-16 mb-4 opacity-20" />
                  <p>没有找到相关艺人</p>
                </>
              ) : searchType === 'album' ? (
                <>
                  <Disc className="w-16 h-16 mb-4 opacity-20" />
                  <p>没有找到相关专辑</p>
                </>
              ) : (
                <>
                  <Music className="w-16 h-16 mb-4 opacity-20" />
                  <p>没有找到相关歌曲</p>
                </>
              )}
            </div>
          ) : (
            <div className={`flex flex-col items-center justify-center py-12 ${textPrimary}/40`}>
              <Search className="w-16 h-16 mb-4 opacity-20" />
              <p>搜索你喜欢的音乐</p>
            </div>
          )}
          </div> {/* 关闭滚动容器 */}
          
          {/* 滚动辅助按钮 */}
          {(isFused || searchType === 'song') && displayedResults.length > 0 && (
            <>
              <ScrollToTop 
                scrollContainerRef={scrollContainerRef}
                theme={playerTheme}
              />
              <ScrollToCurrentSong
                scrollContainerRef={scrollContainerRef}
                currentSongIndex={currentSong ? displayedResults.findIndex(song => song.id === currentSong.id && song.mid === currentSong.mid) : -1}
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
          const songPlatform: MusicPlatform = song.platform === 'qq' ? 'qq' : 'netease'
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
          const artistId = songPlatform === 'qq' ? (artist?.mid || artist?.id) : artist?.id
          if (artistId) onOpenArtist?.(String(artistId), songPlatform)
        }}
        onCopyInfo={onCopyInfo}
        userPlaylists={contextUserPlaylists}
        platform={songContextMenu.song.platform || 'netease'}
      />
    )}

    <AnimatePresence>
      {selectedArtist && (selectedArtistPlatform === 'qq' ? !!selectedArtist.mid : selectedArtist.id !== undefined) && (
        <ArtistDetailModal
          artistId={selectedArtistPlatform === 'qq' ? selectedArtist.mid! : selectedArtist.id!}
          platform={selectedArtistPlatform}
          onClose={() => {
            setSelectedArtist(null)
            setSelectedArtistAlbumId(undefined)
            onRestoreConsumed?.()
          }}
          onSongSelect={(song, songs) => onSongSelect(song, songs, {
            surface: selectedArtistAlbumId ? 'search-artist-album' : 'search-artist',
            platform: selectedArtistPlatform,
            searchMode: platform,
            artistId: selectedArtistPlatform === 'qq' ? selectedArtist.mid : selectedArtist.id,
            albumId: selectedArtistAlbumId,
            artistTab: selectedArtistTab,
          })}
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
      {selectedAlbum && (selectedAlbumPlatform === 'qq' ? !!selectedAlbum.mid : selectedAlbum.id !== undefined) && (
        <AlbumDetailModal
          albumId={selectedAlbumPlatform === 'qq' ? selectedAlbum.mid! : selectedAlbum.id!}
          platform={selectedAlbumPlatform}
          onClose={() => {
            setSelectedAlbum(null)
            onRestoreConsumed?.()
          }}
          onSongSelect={(song, songs) => onSongSelect(song, songs, {
            surface: 'search-album',
            platform: selectedAlbumPlatform,
            searchMode: platform,
            albumId: selectedAlbumPlatform === 'qq' ? selectedAlbum.mid : selectedAlbum.id,
          })}
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
