import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Music, TrendingUp, Flame, Clock, LogOut, Crown, User, Heart } from 'lucide-react'
import { Song } from '../services/musicApi'
import PlaylistDetailPanel from './PlaylistDetailPanel'
import { cacheManager } from '../services/cacheManager'

interface HomeViewProps {
  onSongSelect: (song: Song, playlist?: Song[]) => void
  neteaseLoggedIn: boolean
  neteaseUsername: string
  neteaseAvatar?: string
  neteaseUserId?: string
  neteaseVip?: boolean
  onNeteaseLogout: () => void
  qqLoggedIn: boolean
  qqUsername: string
  qqAvatar?: string
  qqUserId?: string
  qqVip?: boolean
  onQQLogout: () => void
  onNeteaseLoginClick: () => void
  onQQLoginClick: () => void
  onProfileClick: (platform: 'netease' | 'qq') => void
}

type ChartType = 'new' | 'hot' | 'rising'

// 首页模块类型定义
type HomeModuleType = 
  | 'netease_new_songs'
  | 'netease_hot_songs'
  | 'netease_rising_songs'
  | 'netease_daily_recommend'
  | 'netease_radar'
  | 'netease_playlists'
  | 'qq_guess_you_like'
  | 'qq_daily_30'
  | 'qq_playlists'

interface HomeModule {
  id: HomeModuleType
  name: string
  platform: 'netease' | 'qq'
  type: 'song-list' | 'playlist-grid'
}

export default function HomeView({ 
  onSongSelect,
  neteaseLoggedIn,
  neteaseUsername,
  neteaseAvatar,
  neteaseUserId,
  neteaseVip,
  onNeteaseLogout,
  qqLoggedIn,
  qqUsername,
  qqAvatar,
  qqUserId,
  qqVip,
  onQQLogout,
  onNeteaseLoginClick,
  onQQLoginClick,
  onProfileClick
}: HomeViewProps) {
  const [leftChartType, setLeftChartType] = useState<ChartType>('new')
  // 从 localStorage 恢复上次选择的平台
  const [platform, setPlatform] = useState<'netease' | 'qq'>(() => {
    const saved = localStorage.getItem('selectedPlatform')
    return (saved === 'qq' || saved === 'netease') ? saved : 'netease'
  })
  const [chartSongs, setChartSongs] = useState<Song[]>([])
  const [userPlaylists, setUserPlaylists] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  
  // 首页自定义模块（分平台）
  const [neteaseModules, setNeteaseModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_netease')
    return saved ? JSON.parse(saved) : ['netease_new_songs', 'netease_hot_songs', 'netease_rising_songs']
  })
  
  const [qqModules, setQQModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_qq')
    return saved ? JSON.parse(saved) : []
  })
  
  const [currentNeteaseIndex, setCurrentNeteaseIndex] = useState(0)
  const [currentQQIndex, setCurrentQQIndex] = useState(0)
  const [moduleSongs, setModuleSongs] = useState<Song[]>([])
  const [modulePlaylists, setModulePlaylists] = useState<any[]>([])
  const [moduleLoading, setModuleLoading] = useState(true)
  const [forceReload, setForceReload] = useState(0)
  
  // 歌单详情面板状态
  const [showPlaylistDetail, setShowPlaylistDetail] = useState(false)
  const [selectedPlaylist, setSelectedPlaylist] = useState<any>(null)
  const [playlistSongs, setPlaylistSongs] = useState<Song[]>([])
  const [loadingPlaylistSongs, setLoadingPlaylistSongs] = useState(false)

  // 点击歌单，获取歌单详情并显示面板
  const handlePlaylistClick = async (playlist: any) => {
    setSelectedPlaylist(playlist)
    setShowPlaylistDetail(true)
    setLoadingPlaylistSongs(true)
    setPlaylistSongs([])
    
    try {
      let response, data
      
      // 使用歌单自己的平台属性
      const playlistPlatform = playlist.platform || platform
      
      if (playlistPlatform === 'netease') {
        response = await fetch(`http://localhost:3001/api/netease/playlist/detail?id=${playlist.id}`)
        data = await response.json()
        
        if (data.playlist && data.playlist.tracks) {
          const songs: Song[] = data.playlist.tracks.map((track: any) => ({
            id: track.id,
            name: track.name,
            artists: track.ar || track.artists || [],
            album: track.al || track.album || {},
            duration: track.dt || track.duration || 0,
            platform: 'netease',
            vip: track.vip || false,
            fee: track.fee || 0
          }))
          
          setPlaylistSongs(songs)
        }
      } else if (playlistPlatform === 'qq') {
        console.log('📤 正在获取QQ音乐歌单详情，ID:', playlist.id)
        // 需要cookie来访问私人歌单
        const cookie = localStorage.getItem('qq_cookie') || ''
        response = await fetch(`http://localhost:3001/api/qq/playlist/detail?id=${playlist.id}&cookie=${encodeURIComponent(cookie)}`)
        data = await response.json()
        
        console.log('📥 QQ音乐歌单详情:', data)
        
        // QQ音乐歌单详情直接返回songlist字段
        if (data.songlist && Array.isArray(data.songlist)) {
          const songs: Song[] = data.songlist.map((track: any) => ({
            id: track.songid || track.id,
            mid: track.songmid || track.mid,
            name: track.songname || track.name,
            artists: track.singer || [],
            album: {
              name: track.albumname || track.album?.name || '',
              picUrl: track.albumpic || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg`
            },
            duration: (track.interval || 0) * 1000,
            platform: 'qq',
            vip: track.pay?.payplay === 1 || false
          }))
          
          console.log('✅ 解析到', songs.length, '首歌曲')
          setPlaylistSongs(songs)
        } else {
          console.warn('⚠️ 未找到songlist字段')
        }
      }
    } catch (error) {
      console.error('获取歌单详情失败:', error)
    } finally {
      setLoadingPlaylistSongs(false)
    }
  }

  // 加载榜单歌曲
  useEffect(() => {
    loadChartSongs()
  }, [platform, leftChartType])

  // 加载用户歌单
  useEffect(() => {
    console.log('🔄 检查是否需要加载歌单:', { 
      neteaseLoggedIn, 
      qqLoggedIn, 
      platform,
      neteaseUserId,
      qqUserId,
      shouldLoad: neteaseLoggedIn || qqLoggedIn
    })
    if (neteaseLoggedIn || qqLoggedIn) {
      loadUserPlaylists()
    }
  }, [neteaseLoggedIn, qqLoggedIn, platform, neteaseUserId, qqUserId])
  
  // 保存平台选择到 localStorage
  useEffect(() => {
    localStorage.setItem('selectedPlatform', platform)
    console.log('💾 已保存平台选择:', platform)
  }, [platform])
  
  // 监听首页模块变化
  useEffect(() => {
    const handleModulesChange = () => {
      const savedNetease = localStorage.getItem('homeModules_netease')
      const savedQQ = localStorage.getItem('homeModules_qq')
      if (savedNetease) {
        setNeteaseModules(JSON.parse(savedNetease))
        setCurrentNeteaseIndex(0)
      }
      if (savedQQ) {
        setQQModules(JSON.parse(savedQQ))
        setCurrentQQIndex(0)
      }
    }
    
    window.addEventListener('homeModulesChanged', handleModulesChange)
    return () => window.removeEventListener('homeModulesChanged', handleModulesChange)
  }, [])
  
  // 根据登录状态更新默认模块
  useEffect(() => {
    const saved = localStorage.getItem('homeModules_netease')
    if (!saved) {
      // 如果没有保存的配置，根据登录状态设置默认模块
      if (neteaseLoggedIn) {
        // 登录用户：显示每日推荐、私人雷达、推荐歌单
        setNeteaseModules(['netease_daily_recommend', 'netease_radar', 'netease_playlists'])
      } else {
        // 未登录用户：显示三个榜单
        setNeteaseModules(['netease_new_songs', 'netease_hot_songs', 'netease_rising_songs'])
      }
      setCurrentNeteaseIndex(0)
      setForceReload(prev => prev + 1)  // 强制重新加载
    }
  }, [neteaseLoggedIn])
  
  // 加载当前模块数据（根据平台）
  useEffect(() => {
    if (platform === 'netease' && neteaseModules.length > 0) {
      loadModuleData(neteaseModules[currentNeteaseIndex])
    } else if (platform === 'qq' && qqModules.length > 0) {
      loadModuleData(qqModules[currentQQIndex])
    }
  }, [platform, neteaseModules, qqModules, currentNeteaseIndex, currentQQIndex, forceReload])
  
  // 当登录状态变化时，重新加载需要登录的模块
  useEffect(() => {
    if (neteaseLoggedIn && platform === 'netease' && neteaseModules.length > 0) {
      const currentModule = neteaseModules[currentNeteaseIndex]
      // 检查当前模块是否需要登录
      const needsLoginModules = ['netease_daily_recommend', 'netease_radar', 'netease_playlists']
      if (needsLoginModules.includes(currentModule)) {
        console.log(`✅ 登录成功，重新加载模块: ${currentModule}`)
        loadModuleData(currentModule)
      }
    }
  }, [neteaseLoggedIn])
  
  // QQ音乐登录状态变化时重新加载
  useEffect(() => {
    if (qqLoggedIn && platform === 'qq' && qqModules.length > 0) {
      const currentModule = qqModules[currentQQIndex]
      // 检查当前模块是否需要登录
      const needsLoginModules = ['qq_guess_you_like', 'qq_daily_30']
      if (needsLoginModules.includes(currentModule)) {
        console.log(`✅ QQ音乐登录成功，重新加载模块: ${currentModule}`)
        loadModuleData(currentModule)
      }
    }
  }, [qqLoggedIn])

  const loadModuleData = async (moduleId: HomeModuleType) => {
    console.log(`🔄 loadModuleData 被调用，模块ID: ${moduleId}`)
    setModuleLoading(true)
    setModuleSongs([])
    setModulePlaylists([])
    
    try {
      let url = ''
      let isPlaylistModule = false
      let needsLogin = false
      
      // 根据模块类型确定API URL
      switch (moduleId) {
        case 'netease_new_songs':
          url = 'http://localhost:3001/api/netease/personalized/newsong?limit=30'
          break
        case 'netease_hot_songs':
          url = 'http://localhost:3001/api/netease/top/song?type=0'
          break
        case 'netease_rising_songs':
          url = 'http://localhost:3001/api/netease/top/song?type=1'
          break
        case 'netease_daily_recommend':
          url = 'http://localhost:3001/api/netease/recommend/songs'
          needsLogin = true
          break
        case 'netease_radar':
          // 私人雷达：从推荐歌单中找到雷达歌单
          url = 'http://localhost:3001/api/netease/recommend/resource'
          needsLogin = true
          break
        case 'netease_playlists':
          url = 'http://localhost:3001/api/netease/recommend/resource'
          isPlaylistModule = true
          needsLogin = true
          break
        case 'qq_guess_you_like':
          // QQ音乐：猜你喜欢（使用每日推荐）
          url = 'http://localhost:3001/api/qq/recommend/daily'
          needsLogin = true
          break
        case 'qq_daily_30':
          // QQ音乐：每日30首（使用每日推荐）
          url = 'http://localhost:3001/api/qq/recommend/daily'
          needsLogin = true
          break
        case 'qq_playlists':
          // QQ音乐：推荐歌单
          url = 'http://localhost:3001/api/qq/recommend/playlist'
          isPlaylistModule = true
          break
      }
      
      // 如果需要登录但用户未登录，跳过加载
      if (needsLogin) {
        const isNeteaseModule = moduleId.startsWith('netease_')
        const isQQModule = moduleId.startsWith('qq_')
        
        if (isNeteaseModule && !neteaseLoggedIn) {
          console.log(`⚠️ 模块 ${moduleId} 需要登录`)
          setModuleLoading(false)
          return
        }
        
        if (isQQModule && !qqLoggedIn) {
          console.log(`⚠️ 模块 ${moduleId} 需要登录`)
          setModuleLoading(false)
          return
        }
      }
      
      // 添加 Cookie 参数（如果需要）
      if (needsLogin) {
        const isNeteaseModule = moduleId.startsWith('netease_')
        const isQQModule = moduleId.startsWith('qq_')
        
        if (isNeteaseModule) {
          const neteaseCookie = localStorage.getItem('netease_cookie')
          if (neteaseCookie) {
            url += `${url.includes('?') ? '&' : '?'}cookie=${encodeURIComponent(neteaseCookie)}`
          }
        }
        
        if (isQQModule) {
          const qqCookie = localStorage.getItem('qq_cookie')
          if (qqCookie) {
            url += `${url.includes('?') ? '&' : '?'}cookie=${encodeURIComponent(qqCookie)}`
          }
        }
      }
      
      const res = await fetch(url)
      const data = await res.json()
      
      console.log(`📥 模块数据 (${moduleId}):`, data)
      console.log(`🔍 数据结构检查:`)
      console.log(`  - data.data:`, data.data ? '存在' : '不存在')
      console.log(`  - data.data.dailySongs:`, data.data?.dailySongs ? `存在 (${data.data.dailySongs.length}首)` : '不存在')
      console.log(`  - data.recommend:`, data.recommend ? `存在 (${data.recommend.length}个)` : '不存在')
      
      // 特殊处理：私人雷达需要从推荐歌单中找到雷达歌单
      if (moduleId === 'netease_radar' && data.recommend) {
        console.log('🎯 正在查找私人雷达歌单...')
        const radarPlaylist = data.recommend.find((item: any) => 
          item.name?.includes('雷达') || item.name?.includes('私人')
        )
        
        if (radarPlaylist) {
          console.log('✅ 找到私人雷达歌单:', radarPlaylist.name, 'ID:', radarPlaylist.id)
          
          // 获取该歌单的详情
          const neteaseCookie = localStorage.getItem('netease_cookie')
          const playlistRes = await fetch(`http://localhost:3001/api/netease/playlist/detail?id=${radarPlaylist.id}&cookie=${encodeURIComponent(neteaseCookie || '')}`)
          const playlistData = await playlistRes.json()
          
          console.log('📥 私人雷达歌单详情:', playlistData)
          
          if (playlistData.playlist?.tracks) {
            const songs: Song[] = playlistData.playlist.tracks.slice(0, 30).map((track: any) => ({
              id: track.id,
              name: track.name,
              artists: track.ar || track.artists || [],
              album: {
                name: track.al?.name || track.album?.name || '',
                picUrl: track.al?.picUrl || track.album?.picUrl || ''
              },
              duration: track.dt || track.duration || 0,
              platform: 'netease' as const,
              vip: track.fee === 1 || false,
              fee: track.fee || 0
            }))
            
            setModuleSongs(songs)
            setModuleLoading(false)
            return
          }
        } else {
          console.warn('⚠️ 未找到私人雷达歌单')
        }
      }
      
      if (isPlaylistModule) {
        // 处理歌单数据
        let playlists: any[] = []
        
        if (moduleId === 'netease_playlists' && data.recommend) {
          // 推荐歌单
          playlists = data.recommend.map((item: any) => ({
            id: item.id,
            name: item.name,
            coverImgUrl: item.picUrl,
            trackCount: item.trackCount || item.playCount || 0,
            platform: 'netease'
          }))
        } else if (moduleId === 'qq_playlists') {
          // QQ音乐推荐歌单
          const list = data.data?.list || []
          playlists = list.map((item: any) => ({
            id: item.content_id || item.dissid || item.tid || item.id,
            name: item.title || item.dissname || item.name,
            coverImgUrl: item.cover || item.cover_url_big || item.imgurl,
            trackCount: item.song_cnt || item.listen_num || 0,
            platform: 'qq'
          }))
          console.log('✅ QQ音乐歌单数量:', playlists.length)
        }
        
        setModulePlaylists(playlists)
      } else {
        // 处理歌曲数据
        let songs: Song[] = []
        const platform = moduleId.startsWith('netease_') ? 'netease' : 'qq'
        
        if (platform === 'netease') {
          if (moduleId === 'netease_new_songs' && data.result) {
            songs = data.result.map((item: any) => ({
              id: item.id,
              name: item.name,
              artists: item.song?.artists || item.artists || [],
              album: {
                name: item.song?.album?.name || item.album?.name || '',
                picUrl: item.picUrl || item.song?.album?.picUrl || item.album?.picUrl
              },
              duration: item.song?.duration || item.duration || 0,
              platform: 'netease' as const,
              vip: item.vip || item.song?.vip || false,
              fee: item.fee || item.song?.fee || 0
            }))
          } else if (moduleId === 'netease_daily_recommend' && data.data?.dailySongs) {
            // 每日推荐
            songs = data.data.dailySongs.slice(0, 30).map((item: any) => ({
              id: item.id,
              name: item.name,
              artists: item.ar || item.artists || [],
              album: {
                name: item.al?.name || item.album?.name || '',
                picUrl: item.al?.picUrl || item.album?.picUrl || ''
              },
              duration: item.dt || item.duration || 0,
              platform: 'netease' as const,
              vip: item.fee === 1 || false,
              fee: item.fee || 0
            }))
          } else if (data.data && Array.isArray(data.data)) {
            songs = data.data.slice(0, 30).map((item: any) => ({
              id: item.id,
              name: item.name,
              artists: item.ar || item.artists || [],
              album: {
                name: item.al?.name || item.album?.name || '',
                picUrl: item.al?.picUrl || item.album?.picUrl || ''
              },
              duration: item.dt || item.duration || 0,
              platform: 'netease' as const,
              vip: item.vip || false,
              fee: item.fee || 0
            }))
          } else if (data.recommend && Array.isArray(data.recommend)) {
            songs = data.recommend.slice(0, 30).map((item: any) => ({
              id: item.id,
              name: item.name,
              artists: item.artists || [],
              album: item.album || {},
              duration: item.duration || 0,
              platform: 'netease' as const,
              vip: item.privilege?.fee === 1 || false,
              fee: item.privilege?.fee || 0
            }))
          }
        } else {
          // QQ音乐数据处理
          if (moduleId === 'qq_guess_you_like' || moduleId === 'qq_daily_30') {
            // QQ音乐每日推荐 - recommend/daily 返回的是歌单详情
            // 尝试多种可能的字段名：songlist, song_list, list
            const songList = data.data?.songlist || data.data?.song_list || data.data?.list || []
            
            console.log(`[QQ音乐每日推荐] 数据字段检查:`)
            console.log(`  - data.data.songlist: ${data.data?.songlist ? `存在 (${data.data.songlist.length})` : '不存在'}`)
            console.log(`  - data.data.song_list: ${data.data?.song_list ? `存在 (${data.data.song_list.length})` : '不存在'}`)
            console.log(`  - data.data.list: ${data.data?.list ? `存在 (${data.data.list.length})` : '不存在'}`)
            console.log(`  - 最终使用的列表长度: ${songList.length}`)
            
            if (Array.isArray(songList) && songList.length > 0) {
              songs = songList.slice(0, 30).map((song: any) => ({
                id: song.songid || song.id,
                mid: song.songmid || song.mid,
                name: song.songname || song.name,
                artists: song.singer || [],
                album: {
                  name: song.albumname || song.album?.name || '',
                  picUrl: song.albumpic || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
                },
                duration: (song.interval || 0) * 1000,
                platform: 'qq' as const,
                vip: song.pay?.payplay === 1 || false
              }))
              console.log(`✅ QQ音乐每日推荐歌曲数量: ${songs.length}`)
            } else {
              console.warn(`⚠️ QQ音乐每日推荐: 未找到有效的歌曲列表`)
            }
          } else if (data.data?.list && Array.isArray(data.data.list)) {
            songs = data.data.list.slice(0, 30).map((song: any) => ({
              id: song.songid || song.id,
              mid: song.songmid || song.mid,
              name: song.songname || song.name,
              artists: song.singer || [],
              album: {
                name: song.albumname || song.album?.name || '',
                picUrl: song.albumpic || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albummid}.jpg`
              },
              duration: (song.interval || 0) * 1000,
              platform: 'qq' as const,
              vip: song.pay?.payplay === 1 || false
            }))
          }
        }
        
        setModuleSongs(songs)
      }
    } catch (error) {
      console.error('加载模块数据失败:', error)
    } finally {
      setModuleLoading(false)
    }
  }

  const loadChartSongs = async () => {
    setLoading(true)
    try {
      let url = ''
      if (platform === 'netease') {
        switch (leftChartType) {
          case 'new':
            url = 'http://localhost:3001/api/netease/personalized/newsong?limit=30'
            break
          case 'hot':
            url = 'http://localhost:3001/api/netease/top/song?type=0'
            break
          case 'rising':
            url = 'http://localhost:3001/api/netease/top/song?type=1'
            break
        }
      } else {
        switch (leftChartType) {
          case 'new':
            url = 'http://localhost:3001/api/qq/new/songs'
            break
          case 'hot':
            url = 'http://localhost:3001/api/qq/top?id=26'
            break
          case 'rising':
            url = 'http://localhost:3001/api/qq/top?id=4'
            break
        }
      }

      const res = await fetch(url)
      const data = await res.json()
      
      console.log(`📥 ${platform} 榜单数据 (${leftChartType}):`, data)

      let songs: Song[] = []
      if (platform === 'netease') {
        if (leftChartType === 'new' && data.result) {
          songs = data.result.map((item: any) => ({
            id: item.id,
            name: item.name,
            artists: item.song?.artists || item.artists || [],
            album: {
              name: item.song?.album?.name || item.album?.name || '',
              picUrl: item.picUrl || item.song?.album?.picUrl || item.album?.picUrl
            },
            duration: item.song?.duration || item.duration || 0,
            platform: 'netease' as const,
            vip: item.vip || item.song?.vip || false,
            fee: item.fee || item.song?.fee || 0
          }))
        } else if (data.data) {
          songs = data.data.slice(0, 30).map((item: any) => ({
            id: item.id,
            name: item.name,
            artists: item.ar || item.artists || [],
            album: {
              name: item.al?.name || item.album?.name || '',
              picUrl: item.al?.picUrl || item.album?.picUrl || ''
            },
            duration: item.dt || item.duration || 0,
            platform: 'netease' as const,
            vip: item.vip || false,
            fee: item.fee || 0
          }))
        }
      } else {
        console.log('🔍 QQ音乐数据结构检查:')
        console.log('- data.tracks:', data.tracks)
        console.log('- data.data:', data.data)
        console.log('- data.data.song_list:', data.data?.song_list)
        console.log('- data.songlist:', data.songlist)
        
        if (data.data?.song_list && Array.isArray(data.data.song_list)) {
          console.log('✅ 使用 data.data.song_list，长度:', data.data.song_list.length)
          songs = data.data.song_list.slice(0, 30).map((song: any) => ({
            id: song.id || song.mid,
            mid: song.mid,
            name: song.name || song.title,
            artists: song.singer || [],
            album: {
              name: song.album?.name || '',
              picUrl: song.album?.pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid}.jpg` : ''
            },
            duration: song.interval ? song.interval * 1000 : 0,
            platform: 'qq' as const,
            vip: song.pay?.payplay === 1 || false
          }))
        } else if (data.tracks && Array.isArray(data.tracks)) {
          console.log('✅ 使用 data.tracks，长度:', data.tracks.length)
          songs = data.tracks.slice(0, 30).map((song: any) => ({
            id: song.id || song.mid,
            mid: song.mid,
            name: song.name || song.title,
            artists: song.singer || [],
            album: {
              name: song.album?.name || '',
              picUrl: song.album?.pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid}.jpg` : ''
            },
            duration: song.interval ? song.interval * 1000 : 0,
            platform: 'qq' as const,
            vip: song.pay?.payplay === 1 || false
          }))
        } else if (data.data && Array.isArray(data.data)) {
          console.log('✅ 使用 data.data，长度:', data.data.length)
          songs = data.data.slice(0, 30).map((song: any) => ({
            id: song.id || song.mid,
            mid: song.mid,
            name: song.name || song.title,
            artists: song.singer || [],
            album: {
              name: song.album?.name || '',
              picUrl: song.album?.pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid}.jpg` : ''
            },
            duration: song.interval ? song.interval * 1000 : 0,
            platform: 'qq' as const,
            vip: song.pay?.payplay === 1 || false
          }))
        } else if (data.songlist && Array.isArray(data.songlist)) {
          console.log('✅ 使用 data.songlist，长度:', data.songlist.length)
          songs = data.songlist.slice(0, 30).map((song: any) => ({
            id: song.id || song.mid,
            mid: song.mid,
            name: song.name || song.title,
            artists: song.singer || [],
            album: {
              name: song.album?.name || '',
              picUrl: song.album?.pmid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.album.pmid}.jpg` : ''
            },
            duration: song.interval ? song.interval * 1000 : 0,
            platform: 'qq' as const,
            vip: song.pay?.payplay === 1 || false
          }))
        } else {
          console.warn('⚠️ QQ音乐数据格式不匹配，无法解析')
        }
      }

      console.log(`✅ 解析到 ${songs.length} 首歌曲`)
      setChartSongs(songs)
    } catch (error) {
      console.error('加载榜单失败:', error)
    } finally {
      setLoading(false)
    }
  }

  const loadUserPlaylists = async () => {
    console.log('🔄 loadUserPlaylists 被调用，当前平台:', platform)
    setPlaylistLoading(true)
    setUserPlaylists([]) // 清空旧数据，避免显示错误的歌单
    
    try {
      if (platform === 'netease') {
        // 网易云：必须登录且有用户ID
        if (!neteaseLoggedIn || !neteaseUserId) {
          console.warn('⚠️ 网易云未登录，跳过加载歌单')
          return
        }
        
        console.log('✅ 进入网易云分支，用户ID:', neteaseUserId)
        
        // 尝试从缓存加载
        const cachedPlaylists = await cacheManager.getCachedPlaylist(neteaseUserId, 'netease')
        if (cachedPlaylists) {
          console.log('✅ 从缓存加载网易云歌单:', cachedPlaylists.length, '个')
          setUserPlaylists(cachedPlaylists)
          setPlaylistLoading(false)
          // 继续后台更新
        }
        
        const res = await fetch(`http://localhost:3001/api/netease/user/playlist?uid=${neteaseUserId}`)
        const data = await res.json()
        if (data.playlist) {
          console.log('✅ 网易云歌单数量:', data.playlist.length)
          setUserPlaylists(data.playlist)
          // 缓存歌单列表
          await cacheManager.cachePlaylist(neteaseUserId, 'netease', data.playlist)
        }
      } else if (platform === 'qq') {
        // QQ音乐：必须登录且有用户ID
        if (!qqLoggedIn || !qqUserId) {
          console.warn('⚠️ QQ音乐未登录，跳过加载歌单', { qqLoggedIn, qqUserId })
          return
        }
        
        console.log('✅ 进入QQ音乐分支，用户ID:', qqUserId)
        
        // 尝试从缓存加载
        const cachedPlaylists = await cacheManager.getCachedPlaylist(qqUserId, 'qq')
        if (cachedPlaylists) {
          console.log('✅ 从缓存加载QQ音乐歌单:', cachedPlaylists.length, '个')
          setUserPlaylists(cachedPlaylists)
          setPlaylistLoading(false)
          // 继续后台更新
        }
        
        // 获取QQ音乐用户歌单（自建 + 收藏）
        console.log('📤 正在获取QQ音乐歌单（自建+收藏），用户ID:', qqUserId)
        
        let createdData: any = {}
        let collectedData: any = {}
        
        // 获取自建歌单
        try {
          const createdRes = await fetch(`http://localhost:3001/api/qq/user/playlist?id=${qqUserId}`)
          createdData = await createdRes.json()
          console.log('📥 QQ音乐自建歌单:', createdData)
        } catch (error) {
          console.error('❌ 获取QQ音乐自建歌单失败:', error)
        }
        
        // 获取收藏歌单（可能失败）
        try {
          const collectedRes = await fetch(`http://localhost:3001/api/qq/user/collect?id=${qqUserId}`)
          if (collectedRes.ok) {
            collectedData = await collectedRes.json()
            console.log('📥 QQ音乐收藏歌单:', collectedData)
          } else {
            console.warn('⚠️ 收藏歌单接口不可用，仅显示自建歌单')
          }
        } catch (error) {
          console.warn('⚠️ 获取收藏歌单失败，仅显示自建歌单:', error)
        }
        
        let allPlaylists: any[] = []
        let likePlaylist: any = null
        
        // 解析歌单数据
        const parsePlaylistData = (data: any, source: 'created' | 'collected' = 'created') => {
          let parsed: any[] = []
          
          // 自建歌单：data.list (disslist 格式)
          if (source === 'created' && data.list && Array.isArray(data.list)) {
            parsed = data.list
              .filter((item: any) => {
                const name = item.diss_name || item.title || item.dissname
                return name !== 'QZone背景音乐' && name !== '本地上传'
              })
              .map((item: any) => ({
                id: item.tid || item.dissid || item.disstid,
                name: item.diss_name || item.title || item.dissname,
                coverImgUrl: item.diss_cover || item.picurl || item.logo,
                trackCount: item.song_cnt || 0,
                platform: 'qq',
                isLike: (item.diss_name || item.title || item.dissname) === '我喜欢'
              }))
          }
          // 收藏歌单：data.data.list 或 data.list (cdlist 格式)
          else if (source === 'collected') {
            const list = data.data?.list || data.list || []
            if (Array.isArray(list)) {
              parsed = list
                .filter((item: any) => {
                  const name = item.dissname || item.diss_name || item.title
                  return name !== 'QZone背景音乐' && name !== '本地上传'
                })
                .map((item: any) => ({
                  id: item.dissid || item.tid || item.disstid,
                  name: item.dissname || item.diss_name || item.title,
                  coverImgUrl: item.logo || item.diss_cover || item.picurl,
                  trackCount: item.songnum || item.song_cnt || 0,
                  platform: 'qq',
                  isCollected: true
                }))
            }
          }
          
          return parsed
        }
        
        // 合并自建和收藏
        const createdPlaylists = parsePlaylistData(createdData, 'created')
        const collectedPlaylists = parsePlaylistData(collectedData, 'collected')
        
        allPlaylists = [...createdPlaylists, ...collectedPlaylists]
        
        // 去重（根据ID）
        let uniquePlaylists = Array.from(
          new Map(allPlaylists.map(item => [item.id, item])).values()
        )
        
        // 找到"我喜欢"歌单并特殊处理
        const likeIndex = uniquePlaylists.findIndex(p => p.isLike)
        if (likeIndex !== -1) {
          likePlaylist = uniquePlaylists[likeIndex]
          uniquePlaylists.splice(likeIndex, 1) // 从原位置移除
          
          // 修改名称为"[用户昵称]喜欢的音乐"
          likePlaylist.name = `${qqUsername}喜欢的音乐`
          
          // 获取第一首歌的封面作为歌单封面
          try {
            console.log('📤 正在获取我喜欢歌单详情，ID:', likePlaylist.id)
            const detailRes = await fetch(`http://localhost:3001/api/qq/playlist/detail?id=${likePlaylist.id}`)
            const detailData = await detailRes.json()
            console.log('📥 我喜欢歌单详情:', detailData)
            
            // 尝试多种数据结构
            let songlist = null
            if (detailData.data?.songlist && Array.isArray(detailData.data.songlist)) {
              songlist = detailData.data.songlist
            } else if (detailData.songlist && Array.isArray(detailData.songlist)) {
              songlist = detailData.songlist
            } else if (detailData.cdlist && Array.isArray(detailData.cdlist) && detailData.cdlist[0]?.songlist) {
              songlist = detailData.cdlist[0].songlist
            }
            
            if (songlist && songlist.length > 0) {
              const firstSong = songlist[0]
              console.log('🎵 第一首歌:', firstSong)
              console.log('📀 专辑信息:', firstSong.album)
              
              // 使用第一首歌的封面
              if (firstSong.album?.pmid) {
                const newCoverUrl = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${firstSong.album.pmid}.jpg`
                console.log('✅ 新封面URL:', newCoverUrl)
                likePlaylist.coverImgUrl = newCoverUrl
              } else if (firstSong.albummid) {
                // 备选：使用 albummid
                const newCoverUrl = `https://y.gtimg.cn/music/photo_new/T002R300x300M000${firstSong.albummid}.jpg`
                console.log('✅ 新封面URL (使用albummid):', newCoverUrl)
                likePlaylist.coverImgUrl = newCoverUrl
              } else {
                console.warn('⚠️ 第一首歌没有专辑pmid或albummid')
              }
            } else {
              console.warn('⚠️ 歌单详情中没有歌曲列表，数据结构:', Object.keys(detailData))
            }
          } catch (error) {
            console.error('❌ 获取我喜欢歌单详情失败:', error)
          }
          
          // 将"我喜欢"放到第一个
          uniquePlaylists.unshift(likePlaylist)
        }
        
        if (uniquePlaylists.length > 0) {
          console.log(`✅ HomeView解析到 ${uniquePlaylists.length} 个QQ音乐歌单（自建: ${createdPlaylists.length}, 收藏: ${collectedPlaylists.length}）`)
          setUserPlaylists(uniquePlaylists)
          // 缓存歌单列表
          await cacheManager.cachePlaylist(qqUserId, 'qq', uniquePlaylists)
        } else {
          console.warn('⚠️ QQ音乐歌单数据为空')
          setUserPlaylists([])
        }
      }
    } catch (error) {
      console.error('加载用户歌单失败:', error)
    } finally {
      setPlaylistLoading(false)
    }
  }

  const getChartIcon = (type: ChartType) => {
    switch (type) {
      case 'new': return <Clock className="w-4 h-4" />
      case 'hot': return <Flame className="w-4 h-4" />
      case 'rising': return <TrendingUp className="w-4 h-4" />
    }
  }

  const getChartName = (type: ChartType) => {
    switch (type) {
      case 'new': return '新歌榜'
      case 'hot': return '热歌榜'
      case 'rising': return '飙升榜'
    }
  }

  const isLoggedIn = platform === 'netease' ? neteaseLoggedIn : qqLoggedIn
  const username = platform === 'netease' ? neteaseUsername : qqUsername
  const avatar = platform === 'netease' ? neteaseAvatar : qqAvatar
  const userId = platform === 'netease' ? neteaseUserId : qqUserId
  const isVip = platform === 'netease' ? neteaseVip : qqVip

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden">
      {/* 粉色渐变背景 - 添加动画 */}
      <motion.div 
        className="absolute inset-0"
        animate={{
          background: [
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #3d1b2d 0%, #2e0f1a 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
          ]
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 动态光晕效果 - 增强亮度 */}
      <motion.div
        className="absolute w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 105, 180, 0.6) 0%, rgba(219, 112, 147, 0.4) 40%, transparent 70%)',
          filter: 'blur(80px)',
          top: '20%',
          left: '15%',
        }}
        animate={{
          scale: [1, 1.3, 1.1, 1],
          x: [0, 60, -20, 0],
          y: [0, 40, -30, 0],
          rotate: [0, 90, 180, 360],
        }}
        transition={{
          duration: 12,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      <motion.div
        className="absolute w-[45vw] h-[45vw] max-w-[600px] max-h-[600px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(186, 85, 211, 0.5) 0%, rgba(147, 112, 219, 0.35) 40%, transparent 70%)',
          filter: 'blur(90px)',
          bottom: '15%',
          right: '20%',
        }}
        animate={{
          scale: [1, 1.4, 1.2, 1],
          x: [0, -50, 30, 0],
          y: [0, -60, 20, 0],
          rotate: [0, -120, -240, -360],
        }}
        transition={{
          duration: 15,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      <motion.div
        className="absolute w-[35vw] h-[35vw] max-w-[400px] max-h-[400px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 20, 147, 0.5) 0%, rgba(199, 21, 133, 0.3) 40%, transparent 70%)',
          filter: 'blur(70px)',
          top: '45%',
          right: '30%',
        }}
        animate={{
          scale: [1, 1.25, 1.15, 1],
          x: [0, 40, -30, 0],
          y: [0, -40, 30, 0],
          rotate: [0, 60, 120, 180],
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 额外的流动光晕 */}
      <motion.div
        className="absolute w-[30vw] h-[30vw] max-w-[350px] max-h-[350px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(218, 112, 214, 0.4) 0%, transparent 70%)',
          filter: 'blur(60px)',
          top: '60%',
          left: '40%',
        }}
        animate={{
          scale: [1, 1.2, 1, 1.1, 1],
          x: [0, -40, 20, -10, 0],
          y: [0, 30, -20, 40, 0],
        }}
        transition={{
          duration: 13,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />

      {/* 第五个光晕 - 右上角 */}
      <motion.div
        className="absolute w-[35vw] h-[35vw] max-w-[450px] max-h-[450px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 182, 193, 0.45) 0%, transparent 70%)',
          filter: 'blur(75px)',
          top: '10%',
          right: '10%',
        }}
        animate={{
          scale: [1, 1.35, 1.15, 1],
          x: [0, -30, 20, 0],
          y: [0, 50, -30, 0],
          rotate: [0, 180, 360],
        }}
        transition={{
          duration: 14,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 减轻遮罩透明度 */}
      <div className="absolute inset-0 bg-black/10" />

      {/* 内容区 */}
      <div className="relative z-10 w-full h-full flex items-center justify-center px-2 md:px-4 py-4 md:py-6">
        <div className="w-full h-full flex flex-col md:flex-row gap-3 md:gap-4 overflow-hidden">
        {/* 左栏：自定义模块 - 如果当前平台没有模块则隐藏 */}
        {(platform === 'netease' ? neteaseModules : qqModules).length > 0 && (
          <motion.div
            initial={{ opacity: 0, x: -50 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -50 }}
            className="w-full md:w-80 lg:w-96 min-h-0 flex flex-col flex-shrink-0"
            style={{
              background: 'rgba(0, 0, 0, 0.3)',
              backdropFilter: 'blur(40px) saturate(180%)',
              WebkitBackdropFilter: 'blur(40px) saturate(180%)',
              borderRadius: '24px',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
            }}
          >
          {/* 头部：模块切换 */}
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">首页推荐</h2>
            </div>

            {/* 模块标签切换 */}
            <div className="flex gap-2 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
              {(platform === 'netease' ? neteaseModules : qqModules).map((moduleId, index) => {
                const moduleInfo = {
                  'netease_new_songs': { name: '新歌榜', platform: 'netease' },
                  'netease_hot_songs': { name: '热歌榜', platform: 'netease' },
                  'netease_rising_songs': { name: '飙升榜', platform: 'netease' },
                  'netease_daily_recommend': { name: '每日推荐', platform: 'netease' },
                  'netease_radar': { name: '私人雷达', platform: 'netease' },
                  'netease_playlists': { name: '推荐歌单', platform: 'netease' },
                  'qq_guess_you_like': { name: '猜你喜欢', platform: 'qq' },
                  'qq_daily_30': { name: '每日三十首', platform: 'qq' },
                  'qq_playlists': { name: '歌单推荐', platform: 'qq' },
                }[moduleId]
                
                const currentIndex = platform === 'netease' ? currentNeteaseIndex : currentQQIndex
                const setCurrentIndex = platform === 'netease' ? setCurrentNeteaseIndex : setCurrentQQIndex
                
                return (
                  <button
                    key={moduleId}
                    onClick={() => setCurrentIndex(index)}
                    className={`flex-shrink-0 px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
                      currentIndex === index
                        ? 'bg-white/20 text-white'
                        : 'bg-white/5 text-white/60 hover:bg-white/10'
                    }`}
                  >
                    <div className={`w-2 h-2 rounded-full ${
                      moduleInfo?.platform === 'netease' ? 'bg-red-500' : 'bg-green-500'
                    }`} />
                    {moduleInfo?.name || moduleId}
                  </button>
                )
              })}
            </div>
          </div>

          {/* 内容区域 */}
          <div 
            className="flex-1 overflow-y-auto rounded-b-[24px]"
            style={{
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent'
            }}
          >
            <div className="p-4 pb-6">
              {moduleLoading ? (
                <div className="flex items-center justify-center h-full">
                  <div className="text-white/60">加载中...</div>
                </div>
              ) : (
                <>
                  {/* 歌曲列表模式 */}
                  {moduleSongs.length > 0 && (
                    <div className="space-y-1">
                      {moduleSongs.map((song, index) => (
                        <motion.div
                          key={`${song.id || song.mid || 'song'}-${index}`}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.01 }}
                          whileHover={{ scale: 1.02 }}
                          onClick={() => onSongSelect(song, moduleSongs)}
                          className="flex items-center gap-3 p-2 rounded-lg hover:bg-white/10 cursor-pointer transition-all group"
                        >
                          {/* 排名 */}
                          <div className={`w-6 text-center font-bold text-sm ${
                            index < 3 ? 'text-yellow-400' : 'text-white/40'
                          }`}>
                            {index + 1}
                          </div>

                          {/* 封面 */}
                          <div className="w-10 h-10 rounded-md overflow-hidden bg-white/10 flex-shrink-0">
                            {song.album?.picUrl ? (
                              <img src={song.album.picUrl} alt={song.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-4 h-4 text-white/20" />
                              </div>
                            )}
                          </div>

                          {/* 歌曲信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <div className="text-white text-sm font-medium truncate">{song.name}</div>
                              {(song.vip || song.fee === 1 || song.fee === 4) && !isVip && (
                                <Crown className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                              )}
                            </div>
                            <div className="text-white/50 text-xs truncate">
                              {song.artists.map(a => a.name).join(', ')}
                            </div>
                          </div>

                          {/* 播放按钮 */}
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                            <Play className="w-4 h-4 text-white" />
                          </div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                  
                  {/* 歌单网格模式 */}
                  {modulePlaylists.length > 0 && (
                    <div className="grid grid-cols-2 gap-3">
                      {modulePlaylists.map((playlist, index) => (
                        <motion.div
                          key={`module-playlist-${playlist.id || index}`}
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ delay: index * 0.05 }}
                          whileHover={{ scale: 1.05 }}
                          onClick={() => handlePlaylistClick(playlist)}
                          className="bg-white/5 hover:bg-white/10 rounded-xl p-3 cursor-pointer transition-all"
                        >
                          <div className="w-full aspect-square rounded-lg overflow-hidden mb-2 bg-white/10">
                            {playlist.coverImgUrl ? (
                              <img src={playlist.coverImgUrl} alt={playlist.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center">
                                <Music className="w-6 h-6 text-white/20" />
                              </div>
                            )}
                          </div>
                          <div className="text-white text-xs font-medium truncate">{playlist.name}</div>
                          <div className="text-white/50 text-[10px]">{playlist.trackCount} 首</div>
                        </motion.div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </motion.div>
        )}

        {/* 中栏：用户歌单 */}
        <motion.div
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          layout
          transition={{
            layout: { type: "spring", stiffness: 300, damping: 30 }
          }}
          className="flex-1 min-h-0 flex flex-col"
          style={{
            background: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
          }}
        >
          <div className="p-6 border-b border-white/10">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-white">我的歌单</h2>
              
              {/* 平台切换按钮 */}
              <div className="flex gap-2">
                <button
                  onClick={() => setPlatform('netease')}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    platform === 'netease'
                      ? 'bg-red-600 text-white'
                      : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  网易云
                </button>
                <button
                  onClick={() => setPlatform('qq')}
                  className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all ${
                    platform === 'qq'
                      ? 'bg-green-600 text-white'
                      : 'bg-white/10 text-white/60 hover:bg-white/20'
                  }`}
                >
                  QQ音乐
                </button>
              </div>
            </div>
          </div>

          <div 
            className="flex-1 overflow-y-auto rounded-b-[24px]"
            style={{
              scrollbarWidth: 'thin',
              scrollbarColor: 'rgba(255, 255, 255, 0.3) transparent'
            }}
          >
            {!isLoggedIn ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <Music className="w-16 h-16 text-white/20" />
                <p className="text-white/60 mb-4">登录后查看你的歌单</p>
                <button
                  onClick={platform === 'netease' ? onNeteaseLoginClick : onQQLoginClick}
                  className={`px-6 py-3 ${
                    platform === 'netease' 
                      ? 'bg-red-600 hover:bg-red-700' 
                      : 'bg-green-600 hover:bg-green-700'
                  } text-white rounded-full font-medium transition-colors`}
                >
                  {platform === 'netease' ? '网易云登录' : 'QQ音乐登录'}
                </button>
              </div>
            ) : playlistLoading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-white/60">加载中...</div>
              </div>
            ) : userPlaylists.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <Music className="w-16 h-16 text-white/20" />
                <p className="text-white/60">暂无歌单</p>
              </div>
            ) : (
              <div className="p-4 pb-6">
                {/* 根据是否有推荐模块调整网格列数 */}
                <div className="grid gap-4" style={{
                gridTemplateColumns: (platform === 'netease' ? neteaseModules : qqModules).length === 0 
                  ? 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))' // 无推荐模块：更大的卡片
                  : 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', // 有推荐模块：正常大小
                maxWidth: '100%'
              }}>
                <AnimatePresence mode="popLayout">
                {userPlaylists.map((playlist: any, index: number) => (
                  <motion.div
                    key={`${platform}-${playlist.id || `playlist-${index}`}`}
                    layout
                    initial={{ opacity: 0, scale: 0.8, y: 20 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8, y: -20 }}
                    transition={{
                      layout: { type: "spring", stiffness: 300, damping: 30 },
                      opacity: { duration: 0.2 },
                      scale: { duration: 0.2 },
                      delay: index * 0.03
                    }}
                    whileHover={{ scale: 1.02 }}
                    onClick={() => handlePlaylistClick(playlist)}
                    className="bg-white/5 hover:bg-white/10 rounded-xl overflow-hidden cursor-pointer transition-all"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gridTemplateRows: 'auto auto',
                      gap: '0.75rem',
                      padding: '0.75rem'
                    }}
                  >
                    {/* 封面 */}
                    <div 
                      className="rounded-lg overflow-hidden bg-white/10 relative"
                      style={{
                        width: (platform === 'netease' ? neteaseModules : qqModules).length === 0 ? '100px' : '80px',
                        height: (platform === 'netease' ? neteaseModules : qqModules).length === 0 ? '100px' : '80px',
                        gridRow: '1 / 3',
                        flexShrink: 0
                      }}
                    >
                      {playlist.coverImgUrl ? (
                        <>
                          <img src={playlist.coverImgUrl} alt={playlist.name} className="w-full h-full object-cover" />
                          {/* 如果是"我喜欢"歌单，添加爱心描边 */}
                          {playlist.isLike && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <Heart 
                                className="w-12 h-12 fill-white/40" 
                                strokeWidth={0}
                                style={{
                                  backdropFilter: 'blur(2px)',
                                  filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 0.2))',
                                  WebkitBackdropFilter: 'blur(2px)'
                                }}
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className="w-6 h-6 text-white/20" />
                        </div>
                      )}
                    </div>
                    
                    {/* 歌单名称 */}
                    <div className="text-white text-sm font-medium line-clamp-2 leading-tight" title={playlist.name}>
                      {playlist.name}
                    </div>
                    
                    {/* 歌曲数量 */}
                    <div className="text-white/50 text-xs self-end">
                      {playlist.trackCount} 首歌曲
                    </div>
                  </motion.div>
                ))}
                </AnimatePresence>
              </div>
              </div>
            )}
          </div>
        </motion.div>

        {/* 右栏：用户信息 */}
        <motion.div
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          className="w-full md:w-80 min-h-0 flex flex-col flex-shrink-0"
          style={{
            background: 'rgba(0, 0, 0, 0.3)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
          }}
        >
          <div className="p-6 border-b border-white/10">
            <h2 className="text-xl font-bold text-white">个人信息</h2>
          </div>

          <div className="flex-1 flex flex-col items-center justify-center p-6">
            {!isLoggedIn ? (
              <div className="text-center">
                <div className="w-20 h-20 rounded-full bg-white/10 flex items-center justify-center mx-auto mb-4">
                  <Music className="w-10 h-10 text-white/20" />
                </div>
                <p className="text-white/60">未登录</p>
              </div>
            ) : (
              <div className="w-full text-center">
                {/* 头像 */}
                <div className="w-24 h-24 rounded-full overflow-hidden mx-auto mb-4 border-2 border-white/20">
                  {avatar ? (
                    <img src={avatar} alt={username} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full bg-white/10 flex items-center justify-center">
                      <Music className="w-12 h-12 text-white/20" />
                    </div>
                  )}
                </div>

                {/* 昵称 */}
                <div className="mb-2 flex items-center justify-center gap-2">
                  <h3 className={`text-xl font-bold ${isVip ? 'text-yellow-400' : 'text-white'}`}>
                    {username}
                  </h3>
                  {isVip && <Crown className="w-5 h-5 text-yellow-400" />}
                </div>

                {/* 账号ID */}
                {userId && (
                  <p className="text-white/50 text-sm mb-6">
                    {platform === 'netease' ? '网易云ID' : 'QQ号'}: {userId}
                  </p>
                )}

                {/* 操作按钮 */}
                <div className="space-y-3 w-full px-4">
                  <button
                    onClick={() => onProfileClick(platform)}
                    className="w-full px-6 py-3 bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-700 hover:to-purple-700 text-white rounded-full font-medium transition-all flex items-center justify-center gap-2"
                  >
                    <User className="w-4 h-4" />
                    个人中心
                  </button>
                  
                  <button
                    onClick={platform === 'netease' ? onNeteaseLogout : onQQLogout}
                    className="w-full px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-full font-medium transition-all flex items-center justify-center gap-2"
                  >
                    <LogOut className="w-4 h-4" />
                    退出登录
                  </button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
        </div>
      </div>

      {/* 歌单详情面板 */}
      <PlaylistDetailPanel
        show={showPlaylistDetail}
        playlist={selectedPlaylist}
        songs={playlistSongs}
        loading={loadingPlaylistSongs}
        onClose={() => setShowPlaylistDetail(false)}
        onSongSelect={onSongSelect}
      />
    </div>
  )
}
