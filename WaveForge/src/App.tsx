import { useState, useCallback, useEffect, useRef } from 'react'
import AlbumCoverPlayer from './components/AlbumCoverPlayer'
import LyricsDisplay from './components/LyricsDisplay'
import PlayerControls from './components/PlayerControls'
import SearchPanel from './components/SearchPanel'
import UpNextNotification from './components/UpNextNotification'
import SettingsPanel from './components/SettingsPanel'
import ControlMenu from './components/ControlMenu'
import PlaylistPanel from './components/PlaylistPanel'
import HomeView from './components/HomeView'
import LoginView from './components/LoginView'
import ProfileView from './components/ProfileView'
import MiniPlayer from './components/MiniPlayer'
import ImmersiveControls from './components/ImmersiveControls'
import TranslationDisplay from './components/TranslationDisplay'
import QuickSettings from './components/QuickSettings'
import Toast from './components/Toast'
import { useColorThief } from './hooks/useColorThief'
import { useAudioPlayer } from './hooks/useAudioPlayer'
import { useAudioAnalyzer } from './hooks/useAudioAnalyzer'
import { Song, getSongUrl, getLyrics, getProxiedImageUrl } from './services/musicApi'
import { cacheManager } from './services/cacheManager'
import { motion, AnimatePresence } from 'framer-motion'
import { Home } from 'lucide-react'

interface Track {
  id?: number
  title: string
  artist: string
  album: string
  coverUrl: string
  duration: number
  url?: string
}

function App() {
  const [currentTrack, setCurrentTrack] = useState<Track>({
    title: 'WaveForge',
    artist: '点击搜索按钮开始',
    album: 'Demo Album',
    coverUrl: 'https://picsum.photos/800/800',
    duration: 240,
  })

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1.0) // 默认100%音量
  const [showSearch, setShowSearch] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPlaylist, setShowPlaylist] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [loginPlatform, setLoginPlatform] = useState<'netease' | 'qq'>('netease')
  const [showProfile, setShowProfile] = useState(false)
  const [profileInitialPlatform, setProfileInitialPlatform] = useState<'netease' | 'qq'>('netease')
  const [showHome, setShowHome] = useState(true) // 是否显示首页
  const [lyrics, setLyrics] = useState<{ time: number; text: string }[]>([])
  const [playlist, setPlaylist] = useState<Song[]>([])
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [showUpNext, setShowUpNext] = useState(false)
  const [upNextEnabled, setUpNextEnabled] = useState(() => {
    const saved = localStorage.getItem('upNextEnabled')
    return saved !== null ? JSON.parse(saved) : true
  })
  const upNextTime = 8 // 提前8秒显示下一首
  
  // Toast通知状态
  // Toast消息管理（支持多个Toast堆叠）
  const [toasts, setToasts] = useState<Array<{
    id: number
    message: string
    type: 'success' | 'error' | 'info'
  }>>([])
  const toastIdRef = useRef(0)
  
  // 添加Toast的辅助函数
  const addToast = (message: string, type: 'success' | 'error' | 'info') => {
    const id = toastIdRef.current++
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4000)
  }
  
  // 歌词翻译设置
  const [translationEnabled, setTranslationEnabled] = useState(() => {
    const saved = localStorage.getItem('translationEnabled')
    return saved !== null ? JSON.parse(saved) : false
  })
  const [translationPosition, setTranslationPosition] = useState<'traditional' | 'bottom-right'>(() => {
    const saved = localStorage.getItem('translationPosition')
    return (saved as 'traditional' | 'bottom-right') || 'traditional'
  })
  const [currentTranslation, setCurrentTranslation] = useState('')
  
  // 检查当前歌曲是否有翻译
  const hasTranslation = lyrics.some(lyric => lyric.translation)
  
  // 主题色
  const [playerTheme, setPlayerTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('playerTheme')
    return (saved as 'dark' | 'light') || 'dark'
  })
  
  // 背景效果
  const [backgroundEffect, setBackgroundEffect] = useState<'transparent' | 'blur' | 'immersive'>(() => {
    const saved = localStorage.getItem('backgroundEffect')
    return (saved as 'transparent' | 'blur' | 'immersive') || 'blur'
  })
  
  // 切歌过渡状态
  const [isTransitioning, setIsTransitioning] = useState(false)
  
  // 当前播放的歌曲
  const currentSong = currentIndex >= 0 && currentIndex < playlist.length ? playlist[currentIndex] : null
  
  // 登录状态
  const [neteaseLoggedIn, setNeteaseLoggedIn] = useState(false)
  const [neteaseUsername, setNeteaseUsername] = useState('')
  const [neteaseAvatar, setNeteaseAvatar] = useState('')
  const [neteaseUserId, setNeteaseUserId] = useState('')
  const [neteaseVip, setNeteaseVip] = useState(false)
  const [_neteaseCookie, setNeteaseCookie] = useState('')
  const [qqLoggedIn, setQQLoggedIn] = useState(false)
  const [qqUsername, setQQUsername] = useState('')
  const [qqAvatar, setQQAvatar] = useState('')
  const [qqUserId, setQQUserId] = useState('')
  const [qqVip, setQQVip] = useState(false)
  const [_qqCookie, setQQCookie] = useState('')
  
  // 使用新的音频播放器
  const audioPlayer = useAudioPlayer(useCallback((state) => {
    if (state.isPlaying !== undefined) setIsPlaying(state.isPlaying)
    if (state.currentTime !== undefined) {
      setCurrentTime(state.currentTime)
      
      // 检查是否接近结束，显示"即将播放"提示
      if (upNextEnabled && duration > 0 && duration - state.currentTime <= upNextTime && duration - state.currentTime > 0) {
        if (!showUpNext && playlist.length > 0 && currentIndex < playlist.length - 1) {
          setShowUpNext(true)
        }
      } else {
        if (showUpNext) setShowUpNext(false)
      }
    }
    if (state.duration !== undefined) setDuration(state.duration)
    if (state.volume !== undefined) setVolume(state.volume)
    
    // 歌曲播放结束，自动播放下一首
    if (state.ended && playlist.length > 0) {
      console.log('歌曲结束，准备播放下一首')
      handleNext()
    }
  }, [duration, upNextTime, upNextEnabled, showUpNext, playlist.length, currentIndex]))
  
  // 封面律动效果
  const [coverPulseEnabled, setCoverPulseEnabled] = useState(() => {
    const saved = localStorage.getItem('coverPulseEnabled')
    return saved !== null ? JSON.parse(saved) : false
  })
  
  // 使用音频分析
  const audioAnalyzer = useAudioAnalyzer(
    audioPlayer.audioElement, 
    coverPulseEnabled && isPlaying
  )
  
  // 监听封面律动设置变化
  useEffect(() => {
    const handleCoverPulseChange = (e: CustomEvent) => {
      console.log('Cover pulse changed:', e.detail)
      setCoverPulseEnabled(e.detail)
    }
    
    window.addEventListener('coverPulseChanged', handleCoverPulseChange as EventListener)
    
    return () => {
      window.removeEventListener('coverPulseChanged', handleCoverPulseChange as EventListener)
    }
  }, [])
  
  // 监听即将播放设置变化
  useEffect(() => {
    const handleUpNextEnabledChange = () => {
      const saved = localStorage.getItem('upNextEnabled')
      setUpNextEnabled(saved !== null ? JSON.parse(saved) : true)
    }
    
    window.addEventListener('upNextEnabledChanged', handleUpNextEnabledChange)
    
    return () => {
      window.removeEventListener('upNextEnabledChanged', handleUpNextEnabledChange)
    }
  }, [])
  
  // 监听歌词翻译设置变化
  useEffect(() => {
    const handleTranslationChange = () => {
      const savedEnabled = localStorage.getItem('translationEnabled')
      const savedPosition = localStorage.getItem('translationPosition')
      setTranslationEnabled(savedEnabled !== null ? JSON.parse(savedEnabled) : false)
      setTranslationPosition((savedPosition as 'traditional' | 'bottom-right') || 'traditional')
    }
    
    window.addEventListener('translationSettingsChanged', handleTranslationChange)
    window.addEventListener('translationPositionChanged', handleTranslationChange)
    
    return () => {
      window.removeEventListener('translationSettingsChanged', handleTranslationChange)
      window.removeEventListener('translationPositionChanged', handleTranslationChange)
    }
  }, [])
  
  // 全局错误处理
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      console.error('全局错误:', event.error)
      cacheManager.logError(event.error)
    }
    
    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      console.error('未处理的Promise拒绝:', event.reason)
      cacheManager.logError(event.reason)
    }
    
    const handleBeforeUnload = () => {
      // 关闭软件时清理缓存
      cacheManager.clearOnClose()
    }
    
    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)
    window.addEventListener('beforeunload', handleBeforeUnload)
    
    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
  
  // 监听主题变化
  useEffect(() => {
    const handleThemeChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setPlayerTheme(customEvent.detail)
    }
    
    const handleBackgroundEffectChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setBackgroundEffect(customEvent.detail)
    }
    
    window.addEventListener('playerThemeChanged', handleThemeChange as EventListener)
    window.addEventListener('backgroundEffectChanged', handleBackgroundEffectChange as EventListener)
    
    return () => {
      window.removeEventListener('playerThemeChanged', handleThemeChange as EventListener)
      window.removeEventListener('backgroundEffectChanged', handleBackgroundEffectChange as EventListener)
    }
  }, [])
  
  // 切换翻译显示
  const handleTranslationToggle = () => {
    const newValue = !translationEnabled
    setTranslationEnabled(newValue)
    localStorage.setItem('translationEnabled', JSON.stringify(newValue))
  }
  
  // 提取封面主色调
  const { dominantColor } = useColorThief(currentTrack.coverUrl)

  // 处理歌曲选择
  const handleSongSelect = async (song: Song, playlistFromSource?: Song[]) => {
    console.log('选择歌曲:', song)
    console.log('封面URL:', song.album?.picUrl, song.album)
    
    // 如果提供了播放列表，直接使用
    if (playlistFromSource && playlistFromSource.length > 0) {
      setPlaylist(playlistFromSource)
      const index = playlistFromSource.findIndex(s => s.id === song.id)
      setCurrentIndex(index >= 0 ? index : 0)
    } else {
      // 更新播放列表（如果不在列表中）
      setPlaylist(prev => {
        const exists = prev.find(s => s.id === song.id)
        if (!exists) {
          const newList = [...prev, song]
          setCurrentIndex(newList.length - 1)
          return newList
        } else {
          const index = prev.findIndex(s => s.id === song.id)
          setCurrentIndex(index)
          return prev
        }
      })
    }

    // 关闭所有界面，进入播放页面
    setShowHome(false)
    setShowProfile(false)
    setShowSearch(false)
    await loadAndPlaySong(song)
  }

  // 加载并播放歌曲
  const loadAndPlaySong = async (song: Song) => {
    try {
      const platform = song.platform || 'netease'
      const songId = platform === 'qq' ? (song.mid || song.id) : song.id
      
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log(`🎵 开始加载歌曲`)
      console.log(`  平台: ${platform === 'qq' ? 'QQ音乐' : '网易云音乐'}`)
      console.log(`  歌名: ${song.name}`)
      console.log(`  歌手: ${song.artists.map(a => a.name).join(', ')}`)
      console.log(`  ID: ${songId}`)
      console.log(`  VIP标识: ${song.vip}`)
      console.log(`  Fee字段: ${song.fee}`)
      if (platform === 'qq') {
        const cookie = localStorage.getItem('qq_cookie')
        console.log(`  Cookie状态: ${cookie ? '已设置 (长度:' + cookie.length + ')' : '未设置'}`)
      }
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      
      // 使用代理后的封面URL
      console.log('🖼️ 原始封面URL:', song.album?.picUrl)
      const proxiedCoverUrl = song.album?.picUrl ? getProxiedImageUrl(song.album.picUrl) : ''
      console.log('🖼️ 代理后封面URL:', proxiedCoverUrl)
      
      console.log('📡 开始并行请求播放URL和歌词...')
      
      // 并行获取播放URL和歌词
      const [url, songLyrics] = await Promise.all([
        getSongUrl(songId, platform),
        getLyrics(songId, platform)
      ])
      
      console.log('📥 播放URL获取结果:', url ? '成功' : '失败')
      if (url) {
        console.log('🔗 完整URL:', url)
      }
      
      if (!url) {
        console.error('❌ 无法获取播放链接')
        console.error('  可能原因:')
        console.error('  1. VIP歌曲且未登录VIP账号')
        console.error('  2. 版权限制')
        console.error('  3. Cookie过期或无效')
        console.error('  4. API返回错误')
        alert('无法获取播放链接，可能是VIP歌曲或版权限制')
        return
      }
      
      console.log('✅ 歌词加载完成，共', songLyrics.length, '行')

      // 立即更新曲目信息和封面，避免延迟
      const newTrack: Track = {
        id: song.id,
        title: song.name,
        artist: song.artists.map(a => a.name).join(', '),
        album: song.album.name,
        coverUrl: proxiedCoverUrl,
        duration: song.duration / 1000,
        url,
      }
      
      setCurrentTrack(newTrack)
      setCurrentTime(0)
      
      // 平滑切换歌词 - 先淡出再淡入
      setIsTransitioning(true)
      setTimeout(() => {
        setLyrics(songLyrics)
        setTimeout(() => {
          setIsTransitioning(false)
        }, 50)
      }, 300)
      
      // 使用新的音频播放器
      await audioPlayer.loadAndPlay(url, volume)
    } catch (error) {
      console.error('加载歌曲失败:', error)
      alert('加载歌曲失败')
    }
  }

  // 上一曲
  const handlePrevious = () => {
    if (playlist.length === 0) return
    // 先重置时间和歌词，避免显示错误的歌词索引
    setCurrentTime(0)
    setLyrics([])
    const newIndex = currentIndex > 0 ? currentIndex - 1 : playlist.length - 1
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex])
  }

  // 下一曲
  const handleNext = () => {
    if (playlist.length === 0) return
    // 先重置时间和歌词
    setCurrentTime(0)
    setLyrics([])
    const newIndex = currentIndex < playlist.length - 1 ? currentIndex + 1 : 0
    setCurrentIndex(newIndex)
    loadAndPlaySong(playlist[newIndex])
  }

  const handlePlayPause = () => {
    audioPlayer.togglePlay()
  }

  const handleSeek = (time: number) => {
    audioPlayer.seek(time)
  }

  const handleVolumeChange = (newVolume: number) => {
    audioPlayer.setVolume(newVolume)
  }

  // 登录处理
  const handleNeteaseLogin = async (cookie: string, showToastMessage = true) => {
    setNeteaseCookie(cookie)
    setNeteaseLoggedIn(true)
    localStorage.setItem('netease_cookie', cookie)
    
    // 获取用户信息
    try {
      const res = await fetch(`http://localhost:3001/api/netease/user/account?cookie=${encodeURIComponent(cookie)}`)
      const data = await res.json()
      if (data.profile) {
        setNeteaseUsername(data.profile.nickname || '网易云用户')
        setNeteaseAvatar(data.profile.avatarUrl || '')
        setNeteaseUserId(data.profile.userId?.toString() || '')
        setNeteaseVip(data.profile.vipType > 0)
      }
    } catch (error) {
      console.error('获取用户信息失败:', error)
      setNeteaseUsername('网易云用户')
    }
    
    console.log('✅ 网易云登录成功')
    
    // 显示登录成功Toast（只在主动登录时显示，不在页面加载时显示）
    if (showToastMessage) {
      addToast('网易云音乐登录成功', 'info')
    }
  }

  const handleNeteaseLogout = () => {
    setNeteaseLoggedIn(false)
    setNeteaseUsername('')
    setNeteaseAvatar('')
    setNeteaseUserId('')
    setNeteaseVip(false)
    setNeteaseCookie('')
    localStorage.removeItem('netease_cookie')
    console.log('👋 网易云已登出')
  }

  const handleQQLogin = async (cookie: string, showToastMessage = true) => {
    setQQCookie(cookie)
    setQQLoggedIn(true)
    localStorage.setItem('qq_cookie', cookie)
    localStorage.setItem('qq_logged_in', 'true')  // 添加这行
    
    try {
      // 1. 先设置Cookie到服务器
      console.log('📤 正在设置QQ音乐Cookie...')
      const setCookieRes = await fetch('http://localhost:3001/api/qq/user/setCookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: cookie })
      })
      const setCookieData = await setCookieRes.json()
      console.log('📥 Cookie设置响应:', setCookieData)
      
      if (setCookieData.result === 100 && setCookieData.data?.uin) {
        const uin = setCookieData.data.uin
        console.log('✅ QQ音乐Cookie设置成功，用户ID:', uin)
        setQQUserId(uin)
        localStorage.setItem('qq_user_id', uin)  // 添加这行
        
        // 2. 获取用户详细信息
        console.log('📤 正在获取QQ音乐用户详情...')
        const userDetailRes = await fetch(`http://localhost:3001/api/qq/user/detail?id=${uin}`)
        const userDetailData = await userDetailRes.json()
        console.log('📥 用户详情响应:', userDetailData)
        
        // qq-music-api返回的数据直接就是数据对象，没有result字段
        if (userDetailData.creator) {
          const user = userDetailData.creator
          console.log('👤 用户数据:', user)
          
          const username = user.nick || user.nickname || user.name || `QQ用户${uin}`
          const avatar = user.headpic || user.avatarUrl || user.avatar || ''
          const isVip = user.lvinfo?.some((lv: any) => lv.iconurl?.includes('svip')) || false
          
          setQQUsername(username)
          setQQAvatar(avatar)
          setQQVip(isVip)
          
          // 保存到localStorage
          localStorage.setItem('qq_username', username)
          localStorage.setItem('qq_avatar', avatar)
          localStorage.setItem('qq_vip', isVip.toString())
          
          console.log('✅ QQ音乐用户信息获取成功:', username, 'VIP:', isVip)
          
          // 显示登录成功Toast（只在主动登录时显示）
          if (showToastMessage) {
            addToast('QQ音乐登录成功', 'success')
          }
        } else {
          // 如果获取详情失败，至少设置基本信息
          console.warn('⚠️ 获取QQ音乐用户详情失败，使用默认信息')
          console.warn('响应数据:', userDetailData)
          setQQUsername(`QQ用户${uin}`)
          setQQAvatar('')
          setQQVip(false)
          localStorage.setItem('qq_username', `QQ用户${uin}`)
        }
      } else {
        throw new Error('设置Cookie失败')
      }
    } catch (error) {
      console.error('❌ QQ音乐登录失败:', error)
      // 登录失败时设置默认值
      setQQUsername('QQ音乐用户')
      setQQAvatar('')
      setQQUserId('')
      setQQVip(false)
    }
  }

  const handleQQLogout = () => {
    setQQLoggedIn(false)
    setQQUsername('')
    setQQAvatar('')
    setQQUserId('')
    setQQVip(false)
    setQQCookie('')
    localStorage.removeItem('qq_cookie')
    console.log('👋 QQ音乐已登出')
  }

  // 启动时检查并恢复登录状态
  useEffect(() => {
    const restoreLoginState = async () => {
      // 恢复网易云登录
      const neteaseCookie = localStorage.getItem('netease_cookie')
      if (neteaseCookie) {
        console.log('🔄 恢复网易云登录状态...')
        await handleNeteaseLogin(neteaseCookie, false) // 不显示Toast
      }

      // 恢复QQ音乐登录
      const qqCookie = localStorage.getItem('qq_cookie')
      if (qqCookie) {
        console.log('🔄 恢复QQ音乐登录状态...')
        handleQQLogin(qqCookie, false) // 不显示Toast
      }
    }

    restoreLoginState()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // 仅在组件挂载时执行一次

  // 根据主题获取背景样式 - 简约主题
  const getBackgroundStyle = () => {
    // 如果是浅色主题，使用温暖的米色背景
    if (playerTheme === 'light') {
      return dominantColor 
        ? `linear-gradient(135deg, ${dominantColor}20 0%, #f5f5f0 50%, #e8e8e0 100%)`
        : 'linear-gradient(135deg, #f5f5f0 0%, #e8e8e0 100%)'
    }
    // 深色主题保持原样
    return dominantColor 
      ? `linear-gradient(135deg, ${dominantColor}15 0%, #000 100%)`
      : 'linear-gradient(135deg, #0a0a0a 0%, #000 100%)'
  }

  return (
    <div 
      className={`h-screen w-full flex items-center justify-center overflow-hidden relative ${!currentSong ? '' : 'p-8'}`}
    >
      {/* Toast通知 - 支持多个Toast堆叠 */}
      <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[100000] flex flex-col gap-3 pointer-events-none">
        {toasts.map((toast, index) => (
          <Toast 
            key={toast.id}
            show={true}
            message={toast.message}
            type={toast.type}
            style={{ 
              animationDelay: `${index * 50}ms` // 每个Toast延迟50ms出现，产生层叠效果
            }}
          />
        ))}
      </div>

      {/* 默认背景层 - 始终存在 */}
      <div 
        className="absolute inset-0"
        style={{
          background: getBackgroundStyle()
        }}
      />

      {/* 封面背景层 - 在默认背景之上 */}
      <AnimatePresence>
        {currentTrack.coverUrl && currentTrack.coverUrl.trim() !== '' && !currentTrack.coverUrl.includes('picsum.photos') && (
          <motion.div
            key={`cover-${currentSong?.id || 'default'}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: "easeInOut" }}
            className="absolute inset-0"
          >
            {/* 封面背景 */}
            <div 
              className="absolute inset-0 bg-cover bg-center transition-all duration-500"
              style={{
                backgroundImage: `url(${currentTrack.coverUrl})`,
                filter: backgroundEffect === 'transparent' 
                  ? coverPulseEnabled && isPlaying
                    ? `blur(20px) brightness(${1.1 + audioAnalyzer.overall * 0.1})`
                    : 'blur(20px) brightness(1.1)' 
                  : backgroundEffect === 'blur'
                  ? coverPulseEnabled && isPlaying
                    ? `blur(60px) brightness(${1 + audioAnalyzer.overall * 0.08})`
                    : 'blur(60px)'
                  : coverPulseEnabled && isPlaying
                  ? `blur(80px) saturate(${1.3 + audioAnalyzer.overall * 0.15}) brightness(${1 + audioAnalyzer.bass * 0.1})`
                  : 'blur(80px) saturate(1.3)',
                transform: coverPulseEnabled && isPlaying
                  ? `scale(${1.2 + audioAnalyzer.overall * 0.08})`
                  : backgroundEffect === 'immersive' ? 'scale(1.3)' : 'scale(1.2)',
                opacity: 1,
                transition: coverPulseEnabled && isPlaying
                  ? 'transform 0.15s ease-out, filter 0.15s ease-out, opacity 0.5s' 
                  : 'all 0.5s',
              }}
            />
            {/* 渐变遮罩 */}
            <div 
              className="absolute inset-0 bg-gradient-to-b transition-all duration-500"
              style={{
                backgroundImage: playerTheme === 'dark'
                  ? backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.05), rgba(0,0,0,0.05), rgba(0,0,0,0.05))'  // 深色透明模式：5%遮罩
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(0,0,0,0.65), rgba(0,0,0,0.55), rgba(0,0,0,0.7))'  // 深色模糊：中等压暗
                    : 'linear-gradient(135deg, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0.75) 50%, rgba(0,0,0,0.6) 100%)'  // 深色沉浸：强压暗+渐变
                  : backgroundEffect === 'transparent'
                    ? 'linear-gradient(to bottom, rgba(255,255,255,0.05), rgba(255,255,255,0.05), rgba(255,255,255,0.05))'  // 浅色透明模式：5%遮罩
                    : backgroundEffect === 'blur'
                    ? 'linear-gradient(to bottom, rgba(255,255,255,0.55), rgba(255,255,255,0.45), rgba(255,255,255,0.6))'  // 浅色模糊：明显白雾
                    : 'linear-gradient(135deg, rgba(255,255,255,0.4) 0%, rgba(255,255,255,0.65) 50%, rgba(255,255,255,0.5) 100%)'  // 浅色沉浸：强白雾+渐变
              }}
            />
            {/* 沉浸模式额外效果 - 边缘渐变和光晕 */}
            {backgroundEffect === 'immersive' && (
              <>
                <div 
                  className="absolute inset-0"
                  style={{
                    background: 'radial-gradient(circle at 30% 40%, rgba(255,255,255,0.15) 0%, transparent 50%)',
                  }}
                />
                <div 
                  className="absolute inset-0"
                  style={{
                    boxShadow: 'inset 0 0 200px rgba(0,0,0,0.3)',
                  }}
                />
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 内容层 */}
      <div className="relative z-10 w-full h-full flex flex-col">
        {/* 顶部栏 - 只在HomeView显示 */}
        {(!currentSong || showHome) && (
          <>
            {/* 菜单按钮 - 右上角 */}
            <div className="fixed top-6 right-6 z-50">
              <ControlMenu
                onSettingsClick={() => setShowSettings(true)}
                onProfileClick={() => {
                  // 默认使用已登录的平台，优先网易云
                  setProfileInitialPlatform(neteaseLoggedIn ? 'netease' : 'qq')
                  setShowProfile(true)
                }}
              />
            </div>
            
            {/* 搜索按钮 - 菜单按钮下方，垂直对齐 */}
            <div className="fixed top-[100px] right-6 z-50">
              <button
                onClick={() => setShowSearch(true)}
                className="relative w-[52px] h-[52px] flex items-center justify-center rounded-full shadow-2xl hover:scale-110 transition-all duration-300 overflow-hidden group"
                style={{
                  background: 'linear-gradient(135deg, rgba(15,15,25,0.75) 0%, rgba(0,0,0,0.85) 100%)',
                  backdropFilter: 'blur(60px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(60px) saturate(180%)',
                  border: '1px solid rgba(255,255,255,0.2)',
                  boxShadow: '0 8px 32px 0 rgba(0,0,0,0.5), inset 0 1px 2px rgba(255,255,255,0.15), 0 0 0 1px rgba(255,255,255,0.05)',
                }}
                title="搜索音乐"
              >
                {/* 动态光晕 */}
                <div
                  className="absolute inset-0 rounded-full pointer-events-none opacity-60"
                  style={{
                    background: 'radial-gradient(circle at 25% 25%, rgba(100,150,255,0.15) 0%, transparent 50%)',
                    animation: 'pulse 3s ease-in-out infinite',
                  }}
                />
                
                {/* 顶部高光 */}
                <div
                  className="absolute top-0 left-0 right-0 h-1/2 rounded-full pointer-events-none"
                  style={{
                    background: 'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 100%)',
                  }}
                />
                
                <svg 
                  className="w-5 h-5 text-white relative z-10" 
                  fill="none" 
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
            </div>
          </>
        )}

        {/* 搜索面板 */}
        <AnimatePresence>
          {showSearch && (
            <SearchPanel 
              onSongSelect={(song, searchResults) => {
                // 更新播放列表为搜索结果列表
                if (searchResults && searchResults.length > 0) {
                  setPlaylist(searchResults)
                  const index = searchResults.findIndex(s => s.id === song.id)
                  setCurrentIndex(index >= 0 ? index : 0)
                }
                handleSongSelect(song)
              }}
              onClose={() => setShowSearch(false)}
              playerTheme={playerTheme}
              neteaseVip={neteaseVip}
              qqVip={qqVip}
            />
          )}
        </AnimatePresence>

        {/* 设置面板 */}
        <SettingsPanel
          show={showSettings}
          onClose={() => setShowSettings(false)}
          neteaseLoggedIn={neteaseLoggedIn}
          neteaseUsername={neteaseUsername}
          onNeteaseLogin={handleNeteaseLogin}
          onNeteaseLogout={handleNeteaseLogout}
          qqLoggedIn={qqLoggedIn}
          qqUsername={qqUsername}
          onQQLogin={handleQQLogin}
          onQQLogout={handleQQLogout}
          playerTheme={playerTheme}
        />
        
        {/* 即将播放提示 */}
        {playlist.length > 0 && currentIndex >= 0 && currentIndex < playlist.length - 1 && (
          <UpNextNotification
            show={showUpNext}
            nextSong={playlist[currentIndex + 1]}
            secondsRemaining={duration - currentTime}
          />
        )}

        {/* 主内容区 */}
        <div className="flex-1 flex items-center justify-center">
          {!currentSong || showHome ? (
            /* 未选择歌曲时或点击首页按钮时显示主页 */
            <HomeView 
              onSongSelect={handleSongSelect}
              neteaseLoggedIn={neteaseLoggedIn}
              neteaseUsername={neteaseUsername}
              neteaseAvatar={neteaseAvatar}
              neteaseUserId={neteaseUserId}
              neteaseVip={neteaseVip}
              onNeteaseLogout={handleNeteaseLogout}
              qqLoggedIn={qqLoggedIn}
              qqUsername={qqUsername}
              qqAvatar={qqAvatar}
              qqUserId={qqUserId}
              qqVip={qqVip}
              onQQLogout={handleQQLogout}
              onNeteaseLoginClick={() => {
                setLoginPlatform('netease')
                setShowLogin(true)
              }}
              onQQLoginClick={() => {
                setLoginPlatform('qq')
                setShowLogin(true)
              }}
              onProfileClick={(platform) => {
                setProfileInitialPlatform(platform)
                setShowProfile(true)
              }}
            />
          ) : (
            <>
              {/* 沉浸式控制按钮组 - 右上角 */}
              <ImmersiveControls
                onHomeClick={() => setShowHome(true)}
                onTranslationToggle={handleTranslationToggle}
                translationEnabled={translationEnabled}
                hasTranslation={hasTranslation}
                playerTheme={playerTheme}
              />

              {(() => {
            // 判断是否为纯音乐：1. 检查前2句歌词是否包含"纯音乐" 2. 没有歌词（QQ音乐无歌词情况）
            const isPureMusic = !lyrics || lyrics.length === 0 || 
              (lyrics.length > 0 && lyrics.slice(0, 2).some(lyric => lyric.text.includes('纯音乐')))
            
            return isPureMusic ? (
              /* 纯音乐时居中显示 */
              <motion.div
                key={`no-lyrics-${currentSong.id}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="flex flex-col items-center justify-center gap-8"
              >
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                  >
                    <AlbumCoverPlayer
                      coverUrl={currentTrack.coverUrl}
                      isPlaying={isPlaying}
                      dominantColor={dominantColor}
                    />
                  </motion.div>

                  {/* 歌曲信息 */}
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 }}
                    className="text-center space-y-3"
                  >
                    <h1 className="text-4xl font-bold text-white drop-shadow-lg">{currentSong.name}</h1>
                    <p className="text-xl text-white/80 drop-shadow-md">{currentSong.artists.map((a: any) => a.name).join(', ')}</p>
                  </motion.div>
                </motion.div>
              ) : (
                /* 有歌词时左右布局 */
                <motion.div
                  key={`with-lyrics-${currentSong.id}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="w-full max-w-7xl h-[85vh] flex gap-12 items-center"
                >
                  {/* 左侧：封面展示区 */}
                  <motion.div
                    key={`cover-${currentSong.id}`}
                    initial={{ opacity: 0, x: -30 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -30 }}
                    transition={{ duration: 0.3 }}
                    className="flex-1 flex flex-col items-center justify-center gap-6"
                  >
                    <AlbumCoverPlayer
                      coverUrl={currentTrack.coverUrl}
                      isPlaying={isPlaying}
                      dominantColor={dominantColor}
                    />
                    
                    {/* 歌曲信息 */}
                    <div className="text-center space-y-2">
                      <h1 className="text-3xl font-bold text-white drop-shadow-lg">{currentSong.name}</h1>
                      <p className="text-lg text-white/80 drop-shadow-md">{currentSong.artists.map((a: any) => a.name).join(', ')}</p>
                    </div>
                  </motion.div>

                  {/* 右侧：歌词显示区 */}
                  <motion.div
                    key={`lyrics-${currentSong.id}`}
                    initial={{ opacity: 0, x: 30 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 30 }}
                    transition={{ duration: 0.3 }}
                    className="flex-1 flex flex-col justify-between h-full py-8"
                  >
                    {/* 歌词显示 */}
                    <div className="flex-1 flex items-center justify-center">
                      <AnimatePresence mode="wait">
                        <motion.div
                          key={currentSong.id}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: isTransitioning ? 0 : 1, y: 0 }}
                          exit={{ opacity: 0, y: -20 }}
                          transition={{ duration: 0.3 }}
                          className="w-full"
                        >
                          <LyricsDisplay
                            lyrics={lyrics}
                            currentTime={currentTime}
                            isPlaying={isPlaying}
                            accentColor={dominantColor || '#fff'}
                            translationEnabled={translationEnabled}
                            translationPosition={translationPosition}
                            onCurrentTranslationChange={setCurrentTranslation}
                            onSeek={audioPlayer.seek}
                          />
                        </motion.div>
                      </AnimatePresence>
                    </div>

                    {/* 右下角翻译显示 */}
                    <TranslationDisplay
                      translation={currentTranslation}
                      show={translationEnabled && translationPosition === 'bottom-right'}
                    />
                  </motion.div>
                </motion.div>
              )
          })()}
            </>
          )}
        </div>

        {/* 全局播放控制器 - 固定在底部 */}
        {currentSong && !showHome && (
          <PlayerControls
            isPlaying={isPlaying}
            currentTime={currentTime}
            duration={duration}
            volume={volume}
            onPlayPause={handlePlayPause}
            onSeek={handleSeek}
            onVolumeChange={handleVolumeChange}
            onPrevious={handlePrevious}
            onNext={handleNext}
            onPlaylistClick={() => setShowPlaylist(true)}
            accentColor={dominantColor || '#fff'}
            playerTheme={playerTheme}
            backgroundEffect={backgroundEffect}
          />
        )}

        {/* 迷你播放器 - 在首页时显示 */}
        <MiniPlayer
          show={showHome && !!currentSong}
          coverUrl={currentTrack.coverUrl}
          isPlaying={isPlaying}
          currentTime={currentTime}
          duration={duration}
          accentColor={dominantColor || '#fff'}
          onPlayPause={handlePlayPause}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onClick={() => setShowHome(false)}
        />
      </div>

      {/* 播放列表面板 */}
      <PlaylistPanel
        show={showPlaylist}
        onClose={() => setShowPlaylist(false)}
        playlist={playlist}
        currentIndex={currentIndex}
        onSongSelect={(index) => {
          setCurrentIndex(index)
          loadAndPlaySong(playlist[index])
          setShowPlaylist(false)
        }}
      />

      {/* 登录视图 */}
      <AnimatePresence>
        {showLogin && (
          <LoginView
            platform={loginPlatform}
            onCancel={() => setShowLogin(false)}
            onLoginSuccess={(cookie) => {
              if (loginPlatform === 'netease') {
                handleNeteaseLogin(cookie)
              } else {
                handleQQLogin(cookie)
              }
              setShowLogin(false)
            }}
          />
        )}
      </AnimatePresence>

      {/* 个人中心视图 */}
      <AnimatePresence>
        {showProfile && (neteaseLoggedIn || qqLoggedIn) && (
          <ProfileView
            initialPlatform={profileInitialPlatform}
            canSwitchPlatform={neteaseLoggedIn && qqLoggedIn}
            userId={profileInitialPlatform === 'netease' ? neteaseUserId : qqUserId}
            cookie={profileInitialPlatform === 'netease' ? _neteaseCookie : _qqCookie}
            onClose={() => setShowProfile(false)}
            onSongSelect={handleSongSelect}
            handleSwitchPlatform={() => {
              setProfileInitialPlatform(prev => prev === 'netease' ? 'qq' : 'netease')
            }}
            onLogout={(platform) => {
              if (platform === 'netease') {
                handleNeteaseLogout()
              } else {
                handleQQLogout()
              }
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default App
