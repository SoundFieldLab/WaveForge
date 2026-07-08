import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, X, Music, History, Clock, User, Disc } from 'lucide-react'
import { searchSongs, searchSuggest, searchArtists, searchAlbums, Song, Artist, Album, SearchSuggestion, getProxiedImageUrl, loadAlbumCovers } from '../services/musicApi'

interface SearchPanelProps {
  onSongSelect: (song: Song, searchResults?: Song[]) => void
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  neteaseVip?: boolean
  qqVip?: boolean
}

// 搜索历史本地存储key
const SEARCH_HISTORY_KEY_NETEASE = 'waveforge_search_history_netease'
const SEARCH_HISTORY_KEY_QQ = 'waveforge_search_history_qq'
const MAX_HISTORY = 5

export default function SearchPanel({ onSongSelect, onClose, playerTheme = 'dark', neteaseVip = false, qqVip = false }: SearchPanelProps) {
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
  
  const [keyword, setKeyword] = useState('')
  const [allResults, setAllResults] = useState<Song[]>([]) // 所有搜索结果
  const [displayedResults, setDisplayedResults] = useState<Song[]>([]) // 当前显示的结果
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [searchHistory, setSearchHistory] = useState<string[]>([]) // 搜索历史
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false) // 加载更多状态
  const [searched, setSearched] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [platform, setPlatform] = useState<'netease' | 'qq'>('netease')
  const [selectedIndex, setSelectedIndex] = useState(-1) // 键盘选择的索引
  const [displayCount, setDisplayCount] = useState(20) // 当前显示数量
  
  // 根据当前平台判断用户是否是VIP
  const isVip = platform === 'netease' ? neteaseVip : qqVip
  
  // 歌手和专辑搜索结果
  const [topArtist, setTopArtist] = useState<Artist | null>(null) // 最匹配的歌手
  const [topAlbum, setTopAlbum] = useState<Album | null>(null) // 最匹配的专辑

  // 加载搜索历史
  useEffect(() => {
    const key = platform === 'qq' ? SEARCH_HISTORY_KEY_QQ : SEARCH_HISTORY_KEY_NETEASE
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

  // 保存搜索历史
  const saveSearchHistory = (query: string) => {
    const key = platform === 'qq' ? SEARCH_HISTORY_KEY_QQ : SEARCH_HISTORY_KEY_NETEASE
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
    const key = platform === 'qq' ? SEARCH_HISTORY_KEY_QQ : SEARCH_HISTORY_KEY_NETEASE
    setSearchHistory([])
    localStorage.removeItem(key)
  }

  // 监听平台切换，如果已搜索过则重新搜索
  useEffect(() => {
    if (searched && keyword.trim()) {
      handleSearch()
    }
  }, [platform])

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

    const timer = setTimeout(async () => {
      // 再次检查是否已搜索，防止搜索后建议重新出现
      if (searched) {
        setShowSuggestions(false)
        setSuggestions([])
        return
      }
      
      try {
        console.log('🔍 正在获取搜索建议:', keyword.trim(), platform)
        const result = await searchSuggest(keyword.trim(), platform)
        console.log('📝 搜索建议结果:', result)
        setSuggestions(result)
        setShowSuggestions(result.length > 0)
        setSelectedIndex(-1)
      } catch (error) {
        console.error('获取搜索建议失败:', error)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [keyword, platform, searched])

  const handleSearch = async (searchKeyword?: string) => {
    const finalKeyword = searchKeyword || keyword
    if (!finalKeyword.trim()) return
    
    setLoading(true)
    setSearched(true)
    setShowSuggestions(false)
    setSelectedIndex(-1)
    setDisplayCount(20) // 重置显示数量
    
    // 重置歌手和专辑
    setTopArtist(null)
    setTopAlbum(null)
    
    // 保存搜索历史
    saveSearchHistory(finalKeyword)
    
    try {
      // 暂时只搜索歌曲，歌手和专辑搜索功能待后端API修复后再启用
      const songResult = await searchSongs(finalKeyword, 100, platform)
      
      console.log('🔍 搜索结果:', { songs: songResult.songs.length })
      
      setAllResults(songResult.songs)
      setDisplayedResults(songResult.songs.slice(0, 20)) // 只显示前20首
      
      // TODO: 等后端API修复type参数后，再启用歌手和专辑搜索
      // const [songResult, artists, albums] = await Promise.all([
      //   searchSongs(finalKeyword, 100, platform),
      //   searchArtists(finalKeyword, platform),
      //   searchAlbums(finalKeyword, platform)
      // ])
      // if (artists.length > 0) setTopArtist(artists[0])
      // if (albums.length > 0) setTopAlbum(albums[0])
    } catch (error) {
      console.error('搜索失败:', error)
    } finally {
      setLoading(false)
    }
  }

  // 加载更多结果
  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      const newCount = displayCount + 20
      const newSongs = allResults.slice(displayCount, newCount)
      
      // 如果是网易云，需要加载这批歌曲的封面
      if (platform === 'netease' && newSongs.length > 0) {
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

  console.log('🎨 SearchPanel 准备渲染UI')
  console.log('  搜索结果数:', displayedResults.length)
  console.log('  是否正在加载:', loading)
  console.log('  是否已搜索:', searched)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-8"
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
              background: 'linear-gradient(135deg, rgba(0,0,0,0.75) 0%, rgba(20,20,30,0.85) 50%, rgba(0,0,0,0.80) 100%)',
              backdropFilter: 'blur(60px) saturate(180%)',
              WebkitBackdropFilter: 'blur(60px) saturate(180%)',
            }}
          />
          
          {/* 动态光晕1 */}
          <motion.div
            className="absolute w-[500px] h-[500px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(59, 130, 246, 0.15) 0%, transparent 70%)',
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
          
          {/* 动态光晕2 */}
          <motion.div
            className="absolute w-[400px] h-[400px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(168, 85, 247, 0.12) 0%, transparent 70%)',
              filter: 'blur(50px)',
              bottom: '-10%',
              right: '-5%',
            }}
            animate={{
              x: [0, -40, 0],
              y: [0, -25, 0],
              scale: [1, 1.15, 1],
            }}
            transition={{
              duration: 12,
              repeat: Infinity,
              ease: 'easeInOut',
            }}
          />
          
          {/* 光泽层 */}
          <div
            className="absolute inset-0"
            style={{
              background: 'radial-gradient(circle at 25% 20%, rgba(255,255,255,0.1) 0%, transparent 50%)',
              pointerEvents: 'none',
            }}
          />
          
          {/* 边框高光 */}
          <div 
            className="absolute inset-0 rounded-3xl"
            style={{
              border: '1px solid rgba(255,255,255,0.15)',
              boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.1)',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* 内容�?*/}
        <div className="relative z-10 flex flex-col h-full">
        {/* 头部 */}
        <div className={`p-6 border-b ${borderColor}`}>
          <div className="flex items-center justify-between mb-4">
            <h2 className={`text-2xl font-bold ${textPrimary}`}>搜索音乐</h2>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className={`w-6 h-6 ${textPrimary}/60`} />
            </button>
          </div>

          {/* 平台切换 */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setPlatform('netease')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'netease'
                  ? 'bg-red-600/90 text-white hover:bg-red-600'
                  : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
              }`}
            >
              网易云音乐
            </button>
            <button
              onClick={() => setPlatform('qq')}
              className={`px-6 py-3 rounded-2xl text-sm font-medium transition-all backdrop-blur-xl shadow-lg ${
                platform === 'qq'
                  ? 'bg-green-600/90 text-white hover:bg-green-600'
                  : 'bg-white/10 text-white/60 hover:bg-white/20 hover:text-white'
              }`}
            >
              QQ音乐
            </button>
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
                onKeyDown={handleKeyPress}
                placeholder="搜索歌曲、艺术家..."
                className={`w-full ${bgCard} border ${borderColor} rounded-xl pl-12 pr-4 py-3 ${textPrimary} placeholder-white/40 focus:outline-none focus:border-white/30 transition-colors`}
                autoFocus
              />
              
              {/* 搜索历史 */}
              {!searched && keyword.trim() === '' && searchHistory.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute top-full left-0 right-0 mt-2 rounded-xl overflow-hidden z-10 shadow-2xl"
                  style={{
                    background: 'linear-gradient(135deg, rgba(20,20,30,0.95) 0%, rgba(0,0,0,0.98) 100%)',
                    backdropFilter: 'blur(40px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(40px) saturate(150%)',
                    border: '1px solid rgba(255,255,255,0.1)',
                  }}
                >
                  <div className="flex items-center justify-between px-4 py-2 border-b border-white/5">
                    <div className={`flex items-center gap-2 ${textPrimary}/60 text-sm`}>
                      <Clock className="w-4 h-4" />
                      <span>搜索历史</span>
                    </div>
                    <button
                      onClick={clearSearchHistory}
                      className={`${textPrimary}/40 hover:${textPrimary}/60 text-xs transition-colors`}
                    >
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
                      className={`flex items-center px-4 py-3 cursor-pointer transition-colors border-b border-white/5 last:border-b-0 hover:${bgCard} ${textPrimary}/80 hover:${textPrimary}`}
                    >
                      <History className={`w-4 h-4 mr-2 flex-shrink-0 ${textPrimary}/40`} />
                      <span>{item}</span>
                    </div>
                  ))}
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
                    scrollbarColor: 'rgba(255,255,255,0.2) transparent',
                    background: 'linear-gradient(135deg, rgba(20,20,30,0.95) 0%, rgba(0,0,0,0.98) 100%)',
                    backdropFilter: 'blur(40px) saturate(150%)',
                    WebkitBackdropFilter: 'blur(40px) saturate(150%)',
                    border: '1px solid rgba(255,255,255,0.1)',
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
            className="h-full pr-2"
            style={{
              overflowY: 'auto',
              minHeight: searched ? 'calc(85vh - 240px)' : '380px', // 缩短高度，往上收
              maxHeight: 'calc(85vh - 240px)',
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255,255,255,0.3) transparent'
            }}
          >
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
          ) : displayedResults.length > 0 ? (
            <div className="space-y-4">
              {/* TODO: 顶部歌手和专辑卡片功能待后端API修复后再启用 */}
              {/* {(topArtist || topAlbum) && (
                <div className="space-y-3 pb-4 border-b border-white/10">
                  歌手卡片和专辑卡片代码...
                </div>
              )} */}
              
              {/* 歌曲列表 */}
              <div className="space-y-2">
                {displayedResults.map((song, index) => (
                <motion.div
                  key={song.id || song.mid || `search-song-${index}`}
                  whileHover={{ scale: 1.01 }}
                  onClick={() => {
                    onSongSelect(song, allResults)
                    onClose()
                  }}
                  className={`flex items-center gap-4 p-4 rounded-xl hover:${bgCard} cursor-pointer transition-colors group`}
                >
                  {/* 封面 */}
                  <div className={`w-14 h-14 rounded-lg overflow-hidden ${bgCard} flex-shrink-0`}>
                    {song.album?.picUrl ? (
                      <img 
                        src={getProxiedImageUrl(song.album.picUrl)} 
                        alt={song.name} 
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                          e.currentTarget.parentElement!.innerHTML = '<div class="w-full h-full flex items-center justify-center"><svg class="w-6 h-6 ${textPrimary}/20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3"></path></svg></div>'
                        }}
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
                      <h3 className={`${textPrimary} font-medium truncate group-hover:${textPrimary}/90`}>
                        {song.name}
                      </h3>
                      {/* VIP标识 - 只有当歌曲需要VIP且用户不是VIP时才显示 */}
                      {song.vip && !isVip && (
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
                    </div>
                    <p className={`${textPrimary}/50 text-sm truncate`}>
                      {song.artists?.map(a => a.name).join(', ')}
                    </p>
                  </div>

                  {/* 时长 */}
                  <div className={`${textPrimary}/40 text-sm`}>
                    {formatDuration(song.duration)}
                  </div>
                </motion.div>
                ))}
                
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
          ) : searched ? (
            <div className={`flex flex-col items-center justify-center py-12 ${textPrimary}/40`}>
              <Music className="w-16 h-16 mb-4 opacity-20" />
              <p>没有找到相关歌曲</p>
            </div>
          ) : (
            <div className={`flex flex-col items-center justify-center py-12 ${textPrimary}/40`}>
              <Search className="w-16 h-16 mb-4 opacity-20" />
              <p>搜索你喜欢的音乐</p>
            </div>
          )}
          </div> {/* 关闭滚动容器 */}
        </div> {/* 关闭搜索结果区域 */}
        </div> {/* 关闭内容区 */}
      </motion.div>
    </motion.div>
  )
}

