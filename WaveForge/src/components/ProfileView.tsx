import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Heart, List, User, Crown, Calendar, MapPin, RefreshCw, LogOut } from 'lucide-react'
import { Song } from '../services/musicApi'
import PlaylistDetailPanel from './PlaylistDetailPanel'

interface Playlist {
  id: number
  name: string
  coverImgUrl: string
  trackCount: number
  playCount?: number
  creator?: {
    nickname: string
  }
}

interface UserDetail {
  nickname: string
  avatarUrl: string
  userId: string
  signature?: string
  vipType?: number
  city?: string
  birthday?: number
  followeds?: number  // 粉丝数（网易云）
  follows?: number    // 关注数（网易云）
  playlistCount?: number
  level?: number
  // 网易云特有字段
  eventCount?: number      // 动态数
  newFollows?: number      // 新关注数
  listenSongs?: number     // 累计听歌
  createTime?: number      // 注册时间
  gender?: number          // 性别：0-保密, 1-男, 2-女
  province?: number        // 省份代码
  backgroundUrl?: string   // 背景图
  // QQ音乐特有字段
  visitornum?: number     // 访客数
  fansnum?: number        // 粉丝数
  follownum?: number      // 关注总数
  followusernum?: number  // 关注用户数
  followsingernum?: number // 关注歌手数
  listenLevel?: string    // 听歌等级图标
}

interface ProfileViewProps {
  initialPlatform: 'netease' | 'qq'  // 初始显示的平台
  canSwitchPlatform: boolean  // 是否可以切换平台
  userId: string  // 当前平台的用户ID
  cookie: string  // 当前平台的Cookie
  onClose: () => void
  onSongSelect: (song: Song, playlist?: Song[]) => void
  handleSwitchPlatform: () => void  // 切换平台的回调
  onLogout: (platform: 'netease' | 'qq') => void  // 退出登录回调
}

export default function ProfileView({ 
  initialPlatform,
  canSwitchPlatform,
  userId,
  cookie,
  onClose, 
  onSongSelect,
  handleSwitchPlatform,
  onLogout
}: ProfileViewProps) {
  const [currentPlatform, setCurrentPlatform] = useState<'netease' | 'qq'>(initialPlatform)
  const [activeTab, setActiveTab] = useState<'created' | 'subscribed' | 'detail'>('created')
  const [createdPlaylists, setCreatedPlaylists] = useState<Playlist[]>([])
  const [subscribedPlaylists, setSubscribedPlaylists] = useState<Playlist[]>([])
  const [userDetail, setUserDetail] = useState<UserDetail | null>(null)
  const [loading, setLoading] = useState(true)

  // 获取当前平台
  const platform = currentPlatform
  
  // 性别显示
  const getGenderText = (gender?: number) => {
    if (gender === 1) return '男'
    if (gender === 2) return '女'
    return '保密'
  }
  
  // 格式化注册时间
  const formatCreateTime = (timestamp?: number) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    const years = new Date().getFullYear() - date.getFullYear()
    return `${date.getFullYear()}年${date.getMonth() + 1}月 (${years}年)`
  }

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
      
      if (platform === 'netease') {
        response = await fetch(`http://localhost:3001/api/netease/playlist/detail?id=${playlist.id}`)
        data = await response.json()
        
        if (data.playlist && data.playlist.tracks) {
          const songs: Song[] = data.playlist.tracks.map((track: any) => ({
            id: track.id,
            name: track.name,
            artists: track.ar || track.artists || [],
            album: track.al || track.album || {},
            duration: track.dt || track.duration || 0,
            platform: 'netease'
          }))
          
          setPlaylistSongs(songs)
        }
      } else if (platform === 'qq') {
        console.log('📤 正在获取QQ音乐歌单详情，ID:', playlist.id)
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
            platform: 'qq'
          }))
          
          console.log('✅ 解析到', songs.length, '首歌曲')
          setPlaylistSongs(songs)
        } else if (data.data && data.data.songlist) {
          // 备用：检查是否在data.songlist里
          const songs: Song[] = data.data.songlist.map((track: any) => ({
            id: track.songid || track.id,
            mid: track.songmid || track.mid,
            name: track.songname || track.name,
            artists: track.singer || [],
            album: {
              name: track.albumname || track.album?.name || '',
              picUrl: track.albumpic || `https://y.gtimg.cn/music/photo_new/T002R300x300M000${track.albummid}.jpg`
            },
            duration: (track.interval || 0) * 1000,
            platform: 'qq'
          }))
          
          console.log('✅ 解析到', songs.length, '首歌曲')
          setPlaylistSongs(songs)
        } else {
          console.warn('⚠️ 未找到songlist字段')
        }
      }
    } catch (error) {
      console.error('❌ 获取歌单详情失败:', error)
    } finally {
      setLoadingPlaylistSongs(false)
    }
  }

  useEffect(() => {
    fetchUserData()
  }, [currentPlatform, userId])  // 当切换平台或userId变化时重新加载

  // 同步initialPlatform的变化
  useEffect(() => {
    setCurrentPlatform(initialPlatform)
  }, [initialPlatform])

  // 切换平台
  const handlePlatformSwitch = () => {
    handleSwitchPlatform()  // 调用父组件的回调
    setActiveTab('created')  // 切换平台时重置到创建的歌单标签
  }

  const fetchUserData = async () => {
    setLoading(true)
    
    if (platform === 'netease') {
      try {
        // 获取用户歌单
        const playlistRes = await fetch(`http://localhost:3001/api/netease/user/playlist?uid=${userId}&cookie=${encodeURIComponent(cookie)}`)
        const playlistData = await playlistRes.json()
        
        if (playlistData.playlist) {
          const created = playlistData.playlist.filter((p: any) => p.userId?.toString() === userId)
          const subscribed = playlistData.playlist.filter((p: any) => p.userId?.toString() !== userId)
          setCreatedPlaylists(created)
          setSubscribedPlaylists(subscribed)
        }

        // 获取用户详情
        const detailRes = await fetch(`http://localhost:3001/api/netease/user/detail?uid=${userId}`)
        const detailData = await detailRes.json()
        
        if (detailData.profile) {
          setUserDetail({
            nickname: detailData.profile.nickname,
            avatarUrl: detailData.profile.avatarUrl,
            userId: detailData.profile.userId?.toString(),
            signature: detailData.profile.signature,
            vipType: detailData.profile.vipType,
            city: detailData.profile.city,
            birthday: detailData.profile.birthday,
            followeds: detailData.profile.followeds,
            follows: detailData.profile.follows,
            playlistCount: detailData.profile.playlistCount,
            level: detailData.level,
            // 网易云特有数据
            eventCount: detailData.profile.eventCount,
            newFollows: detailData.profile.newFollows,
            listenSongs: detailData.listenSongs,
            createTime: detailData.profile.createTime,
            gender: detailData.profile.gender,
            province: detailData.profile.province,
            backgroundUrl: detailData.profile.backgroundUrl
          })
        }
      } catch (error) {
        console.error('获取网易云用户数据失败:', error)
      }
    } else if (platform === 'qq') {
      try {
        console.log('📤 正在获取QQ音乐用户数据...')
        
        // 获取用户详情（包含歌单）
        const detailRes = await fetch(`http://localhost:3001/api/qq/user/detail?id=${userId}`)
        const detailData = await detailRes.json()
        
        console.log('📥 QQ音乐用户详情:', detailData)
        console.log('📥 detailData.creator:', detailData.creator)
        console.log('📥 detailData.mydiss:', detailData.mydiss)
        
        if (detailData.creator) {
          // 设置用户详情
          const isVip = detailData.creator.lvinfo?.some((lv: any) => lv.iconurl?.includes('svip')) || false
          
          setUserDetail({
            nickname: detailData.creator.nick || 'QQ音乐用户',
            avatarUrl: detailData.creator.headpic || '',
            userId: userId,
            vipType: isVip ? 1 : 0,
            signature: '',
            playlistCount: detailData.mydiss?.num || 0,
            // QQ音乐特有数据
            visitornum: detailData.creator.nums?.visitornum,
            fansnum: detailData.creator.nums?.fansnum,
            follownum: detailData.creator.nums?.follownum,
            followusernum: detailData.creator.nums?.followusernum,
            followsingernum: detailData.creator.nums?.followsingernum,
            listenLevel: detailData.creator.listeninfo?.iconurl
          })
          
          // 解析歌单数据
          console.log('🔍 检查歌单数据:', detailData.mydiss?.list)
          if (detailData.mydiss?.list && Array.isArray(detailData.mydiss.list)) {
            const playlists = detailData.mydiss.list.map((item: any) => {
              console.log('🎵 歌单项:', item)
              return {
                id: item.dissid,
                name: item.title,
                coverImgUrl: item.picurl,
                trackCount: parseInt(item.subtitle?.split('首')[0]) || 0,
                userId: userId // QQ音乐的歌单都是用户自己创建的
              }
            })
            
            console.log('✅ 解析到', playlists.length, '个QQ音乐歌单:', playlists)
            setCreatedPlaylists(playlists)
            setSubscribedPlaylists([]) // QQ音乐API不区分创建和收藏
          } else {
            console.warn('⚠️ mydiss.list 不存在或不是数组')
          }
        } else {
          console.warn('⚠️ detailData.creator 不存在')
        }
      } catch (error) {
        console.error('❌ 获取QQ音乐用户数据失败:', error)
        setUserDetail({
          nickname: 'QQ音乐用户',
          avatarUrl: '',
          userId: userId
        })
      }
    }
    
    setLoading(false)
  }

  return (
    <div className="fixed inset-0 w-full h-full overflow-hidden z-50">
      {/* 动态背景 */}
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
      
      {/* 动态光晕 */}
      <motion.div
        className="absolute w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 105, 180, 0.5) 0%, transparent 70%)',
          filter: 'blur(80px)',
          top: '20%',
          left: '15%',
        }}
        animate={{
          scale: [1, 1.3, 1],
          x: [0, 60, 0],
          y: [0, 40, 0],
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
          background: 'radial-gradient(circle, rgba(186, 85, 211, 0.5) 0%, transparent 70%)',
          filter: 'blur(90px)',
          bottom: '15%',
          right: '20%',
        }}
        animate={{
          scale: [1, 1.4, 1],
          x: [0, -50, 0],
          y: [0, -60, 0],
        }}
        transition={{
          duration: 15,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/20" />

      {/* 内容区 */}
      <div className="relative z-10 w-full h-full flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className="relative w-full h-full max-w-7xl max-h-[90vh] flex flex-col"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
          }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-white/10">
            <div className="flex items-center gap-3">
              <User className="w-6 h-6 text-white" />
              <h2 className="text-2xl font-bold text-white">个人中心</h2>
            </div>
            
            <div className="flex items-center gap-2">
              {/* 平台切换按钮 - 仅在两个平台都登录时显示 */}
              {canSwitchPlatform && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={handlePlatformSwitch}
                  className={`px-4 py-2 rounded-full font-medium text-sm transition-all flex items-center gap-2 ${
                    platform === 'netease'
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-red-600 hover:bg-red-700 text-white'
                  }`}
                >
                  <RefreshCw className="w-4 h-4" />
                  切换到{platform === 'netease' ? 'QQ音乐' : '网易云'}
                </motion.button>
              )}
              
              {/* 关闭按钮 */}
              <motion.button
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                onClick={onClose}
                className="p-2 hover:bg-white/10 rounded-full transition-colors"
              >
                <X className="w-6 h-6 text-white/60" />
              </motion.button>
            </div>
          </div>

          {/* 标签栏 */}
          <div className="flex border-b border-white/10">
            <button
              onClick={() => setActiveTab('created')}
              className={`flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'created'
                  ? 'text-white bg-white/10 border-b-2 border-pink-500'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <List className="w-5 h-5" />
              我创建的歌单 ({createdPlaylists.length})
            </button>
            <button
              onClick={() => setActiveTab('subscribed')}
              className={`flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'subscribed'
                  ? 'text-white bg-white/10 border-b-2 border-pink-500'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <Heart className="w-5 h-5" />
              收藏的歌单 ({subscribedPlaylists.length})
            </button>
            <button
              onClick={() => setActiveTab('detail')}
              className={`flex-1 px-6 py-4 text-center font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === 'detail'
                  ? 'text-white bg-white/10 border-b-2 border-pink-500'
                  : 'text-white/60 hover:text-white hover:bg-white/5'
              }`}
            >
              <User className="w-5 h-5" />
              用户信息
            </button>
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="text-white/60">加载中...</div>
              </div>
            ) : (
              <>
                {/* 我创建的歌单 */}
                {activeTab === 'created' && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {createdPlaylists.map((playlist, index) => (
                      <motion.div
                        key={`created-${playlist.id || index}`}
                        whileHover={{ scale: 1.05 }}
                        onClick={() => handlePlaylistClick(playlist)}
                        className="bg-white/5 hover:bg-white/10 rounded-xl p-4 cursor-pointer transition-all"
                      >
                        <div className="w-full aspect-square rounded-lg overflow-hidden mb-3 bg-white/10">
                          {playlist.coverImgUrl ? (
                            <img src={playlist.coverImgUrl} alt={playlist.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-8 h-8 text-white/20" />
                            </div>
                          )}
                        </div>
                        <div className="text-white text-sm font-medium truncate mb-1">{playlist.name}</div>
                        <div className="text-white/50 text-xs">{playlist.trackCount} 首歌曲</div>
                      </motion.div>
                    ))}
                  </div>
                )}

                {/* 收藏的歌单 */}
                {activeTab === 'subscribed' && (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {subscribedPlaylists.map((playlist, index) => (
                      <motion.div
                        key={`subscribed-${playlist.id || index}`}
                        whileHover={{ scale: 1.05 }}
                        onClick={() => handlePlaylistClick(playlist)}
                        className="bg-white/5 hover:bg-white/10 rounded-xl p-4 cursor-pointer transition-all"
                      >
                        <div className="w-full aspect-square rounded-lg overflow-hidden mb-3 bg-white/10">
                          {playlist.coverImgUrl ? (
                            <img src={playlist.coverImgUrl} alt={playlist.name} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <Music className="w-8 h-8 text-white/20" />
                            </div>
                          )}
                        </div>
                        <div className="text-white text-sm font-medium truncate mb-1">{playlist.name}</div>
                        <div className="text-white/50 text-xs">{playlist.trackCount} 首歌曲</div>
                        {playlist.creator && (
                          <div className="text-white/40 text-xs mt-1">by {playlist.creator.nickname}</div>
                        )}
                      </motion.div>
                    ))}
                  </div>
                )}

                {/* 用户详情 */}
                {activeTab === 'detail' && userDetail && (
                  <div className="max-w-2xl mx-auto">
                    <div className="flex flex-col items-center mb-8">
                      {/* 大头像 */}
                      <div className="w-32 h-32 rounded-full overflow-hidden mb-4 border-4 border-white/20">
                        {userDetail.avatarUrl ? (
                          <img src={userDetail.avatarUrl} alt={userDetail.nickname} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-white/10 flex items-center justify-center">
                            <User className="w-16 h-16 text-white/20" />
                          </div>
                        )}
                      </div>
                      
                      {/* 昵称和VIP */}
                      <div className="flex items-center gap-2 mb-2">
                        {userDetail.vipType !== undefined && userDetail.vipType > 0 && (
                          <Crown className="w-6 h-6 text-yellow-400" />
                        )}
                        <h3 className={`text-3xl font-bold ${userDetail.vipType && userDetail.vipType > 0 ? 'text-yellow-400' : 'text-white'}`}>
                          {userDetail.nickname}
                        </h3>
                      </div>

                      {/* 个性签名 */}
                      {userDetail.signature && (
                        <p className="text-white/60 text-center mb-4">{userDetail.signature}</p>
                      )}
                    </div>

                    {/* 详细信息卡片 */}
                    <div className="bg-white/5 rounded-xl p-6 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white/5 rounded-lg p-4">
                          <div className="text-white/50 text-sm mb-1">用户ID</div>
                          <div className="text-white font-medium">{userDetail.userId}</div>
                        </div>

                        {userDetail.level !== undefined && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">等级</div>
                            <div className="text-white font-medium">Lv.{userDetail.level}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：听歌等级 */}
                        {userDetail.listenLevel && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">听歌等级</div>
                            <img src={userDetail.listenLevel} alt="听歌等级" className="h-6" />
                          </div>
                        )}

                        {/* 网易云：粉丝数 */}
                        {userDetail.followeds !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">粉丝</div>
                            <div className="text-white font-medium">{userDetail.followeds.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：粉丝数 */}
                        {userDetail.fansnum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">粉丝</div>
                            <div className="text-white font-medium">{userDetail.fansnum.toLocaleString()}</div>
                          </div>
                        )}

                        {/* 网易云：关注数 */}
                        {userDetail.follows !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注</div>
                            <div className="text-white font-medium">{userDetail.follows.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：关注用户数 */}
                        {userDetail.followusernum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注用户</div>
                            <div className="text-white font-medium">{userDetail.followusernum.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：关注歌手数 */}
                        {userDetail.followsingernum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">关注歌手</div>
                            <div className="text-white font-medium">{userDetail.followsingernum.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* QQ音乐：访客数 */}
                        {userDetail.visitornum !== undefined && platform === 'qq' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">访客</div>
                            <div className="text-white font-medium">{userDetail.visitornum.toLocaleString()}</div>
                          </div>
                        )}

                        {userDetail.playlistCount !== undefined && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">歌单数</div>
                            <div className="text-white font-medium">{userDetail.playlistCount}</div>
                          </div>
                        )}
                        
                        {/* 网易云：动态数 */}
                        {userDetail.eventCount !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">动态</div>
                            <div className="text-white font-medium">{userDetail.eventCount.toLocaleString()}</div>
                          </div>
                        )}
                        
                        {/* 网易云：累计听歌 */}
                        {userDetail.listenSongs !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">累计听歌</div>
                            <div className="text-white font-medium">{userDetail.listenSongs.toLocaleString()} 首</div>
                          </div>
                        )}
                        
                        {/* 网易云：性别 */}
                        {userDetail.gender !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1">性别</div>
                            <div className="text-white font-medium">{getGenderText(userDetail.gender)}</div>
                          </div>
                        )}
                        
                        {/* 网易云：注册时间 */}
                        {userDetail.createTime !== undefined && platform === 'netease' && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              注册时间
                            </div>
                            <div className="text-white font-medium">{formatCreateTime(userDetail.createTime)}</div>
                          </div>
                        )}

                        {userDetail.city && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <MapPin className="w-3 h-3" />
                              所在地
                            </div>
                            <div className="text-white font-medium">{userDetail.city}</div>
                          </div>
                        )}

                        {userDetail.birthday && (
                          <div className="bg-white/5 rounded-lg p-4">
                            <div className="text-white/50 text-sm mb-1 flex items-center gap-1">
                              <Calendar className="w-3 h-3" />
                              生日
                            </div>
                            <div className="text-white font-medium">
                              {new Date(userDetail.birthday).toLocaleDateString('zh-CN')}
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {/* 退出登录按钮 */}
                      <div className="mt-8">
                        <button
                          onClick={() => {
                            if (confirm(`确定要退出${platform === 'netease' ? '网易云音乐' : 'QQ音乐'}登录吗？`)) {
                              onLogout(platform)
                              onClose()
                            }
                          }}
                          className="w-full py-3 px-4 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-400 hover:text-red-300 font-medium transition-all flex items-center justify-center gap-2"
                        >
                          <LogOut className="w-5 h-5" />
                          退出登录
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </motion.div>
      </div>

      {/* 歌单详情面板 */}
      <PlaylistDetailPanel
        show={showPlaylistDetail}
        playlist={selectedPlaylist}
        songs={playlistSongs}
        loading={loadingPlaylistSongs}
        onClose={() => setShowPlaylistDetail(false)}
        onSongSelect={(song, songs) => {
          onSongSelect(song, songs)
          setShowPlaylistDetail(false)
        }}
        neteaseVip={platform === 'netease' ? vipType > 0 : false}
        qqVip={platform === 'qq' ? vipType > 0 : false}
        currentPlatform={platform}
      />
    </div>
  )
}
