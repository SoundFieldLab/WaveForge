import { memo, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, User, Music, ListMusic, Users, Heart } from 'lucide-react'
import {
  getUserDetail,
  getUserPlaylistList,
  getUserFollows,
  getUserFolloweds,
  getQQUserProfile,
  getQQFans,
  subscribeQQUser,
} from '../services/musicApi'

interface UserProfileViewProps {
  platform: 'netease' | 'qq'
  userId: string // 网易云数字 uid / QQ EncUin
  nickname?: string
  avatarUrl?: string
  signature?: string
  accentColor?: string
  onClose: () => void
  onOpenUser: (userId: string, nickname?: string, avatarUrl?: string) => void // 递归打开下一层个人中心
  onOpenArtist?: (artistId: string, platform: 'netease' | 'qq') => void
  onPlayPlaylist?: (playlist: any, platform: 'netease' | 'qq') => void
}

interface RelationItem {
  encUin: string
  mid: string
  name: string
  desc: string
  avatarUrl: string
  isFollow: boolean
  isSelf: boolean
}

interface PlaylistItem {
  id: string
  name: string
  coverImgUrl: string
  trackCount: number
}

type TabKey = 'overview' | 'follows' | 'fans'

export default memo(function UserProfileView({
  platform,
  userId,
  nickname: initialNickname,
  avatarUrl: initialAvatar,
  signature: initialSignature,
  accentColor = '#3B82F6',
  onClose,
  onOpenUser,
  onOpenArtist,
  onPlayPlaylist,
}: UserProfileViewProps) {
  const [nickname, setNickname] = useState(initialNickname || '未知用户')
  const [avatar, setAvatar] = useState(initialAvatar || '')
  const [signature, setSignature] = useState(initialSignature || '')
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [loading, setLoading] = useState(true)

  // 网易云：歌单
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([])
  // 关注/粉丝
  const [follows, setFollows] = useState<RelationItem[]>([])
  const [fans, setFans] = useState<RelationItem[]>([])
  const [followNum, setFollowNum] = useState<number | null>(null)
  const [fansNum, setFansNum] = useState<number | null>(null)
  // 当前登录用户的粉丝 EncUin 集合——用于判断"TA 是否关注了我"（决定按钮显示 关注/回关）
  const [myFansSet, setMyFansSet] = useState<Set<string>>(new Set())

  // 加载当前登录用户的粉丝列表（判断回关）
  useEffect(() => {
    let cancelled = false
    void getQQFans().then((data) => {
      if (cancelled) return
      const list = data?.data?.list || []
      setMyFansSet(new Set((Array.isArray(list) ? list : []).map((u: any) => u.EncUin || '').filter(Boolean)))
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    if (platform === 'netease') {
      // 网易云：资料 + 歌单 + 关注/粉丝（公开可查任意用户）
      void getUserDetail(userId).then((data) => {
        if (cancelled || !data?.profile) return
        setNickname(data.profile.nickname || '未知用户')
        setAvatar(data.profile.avatarUrl || '')
        setSignature(data.profile.signature || '')
        setFollowNum(data.profile.follows ?? null)
        setFansNum(data.profile.followeds ?? null)
      })
      void getUserPlaylistList(userId).then((data) => {
        if (cancelled) return
        const list = data?.playlist || []
        setPlaylists(Array.isArray(list) ? list.map((p: any) => ({
          id: String(p.id || ''),
          name: p.name || '未命名歌单',
          coverImgUrl: p.coverImgUrl || '',
          trackCount: Number(p.trackCount ?? p.trackNumber ?? 0),
        })) : [])
      })
      void getUserFollows(userId).then((data) => {
        if (cancelled) return
        const raw = data?.follow || []
        setFollows(Array.isArray(raw) ? raw.map((u: any) => ({
          encUin: '',
          mid: '',
          name: u.nickname || '未知用户',
          desc: u.signature || '',
          avatarUrl: u.avatarUrl || '',
          isFollow: false,
          isSelf: false,
        })) : [])
      })
      void getUserFolloweds(userId).then((data) => {
        if (cancelled) return
        const raw = data?.followeds || []
        setFans(Array.isArray(raw) ? raw.map((u: any) => ({
          encUin: '',
          mid: '',
          name: u.nickname || '未知用户',
          desc: u.signature || '',
          avatarUrl: u.avatarUrl || '',
          isFollow: false,
          isSelf: false,
        })) : [])
        setLoading(false)
      })
    } else {
      // QQ：资料（列表传入）+ 关注/粉丝（RelationList HostUin=EncUin）
      void getQQUserProfile(userId).then((data) => {
        if (cancelled || !data?.data) return
        const d = data.data
        setFollowNum(d.followNum ?? null)
        setFansNum(d.fansNum ?? null)
        setFollows(Array.isArray(d.follows) ? d.follows.map((u: any) => ({
          encUin: u.EncUin || '',
          mid: u.MID || '',
          name: u.Name || '未知用户',
          desc: u.Desc || '',
          avatarUrl: u.AvatarUrl || '',
          isFollow: Boolean(u.IsFollow),
          isSelf: Boolean(u.OtherInfo?.IsSelf),
        })) : [])
        setFans(Array.isArray(d.fans) ? d.fans.map((u: any) => ({
          encUin: u.EncUin || '',
          mid: u.MID || '',
          name: u.Name || '未知用户',
          desc: u.Desc || '',
          avatarUrl: u.AvatarUrl || '',
          isFollow: Boolean(u.IsFollow),
          isSelf: Boolean(u.OtherInfo?.IsSelf),
        })) : [])
        setLoading(false)
      })
    }
    return () => { cancelled = true }
  }, [platform, userId])

  // 网易云用户主页打开（music.163.com 无应用内用户主页，网易云用户点击后递归显示其个人中心）
  const openNeteaseUser = (u: { name: string; avatarUrl: string; userId?: string }) => {
    if (u.userId) onOpenUser(u.userId, u.name, u.avatarUrl)
  }

  const renderRelationCard = (u: RelationItem) => {
    const isSinger = Boolean(u.mid) // QQ 关注列表里带 mid 的是歌手
    const handleClick = () => {
      if (platform === 'qq') {
        if (isSinger && u.mid && onOpenArtist) onOpenArtist(u.mid, 'qq')
        else if (u.encUin) onOpenUser(u.encUin, u.name, u.avatarUrl)
      } else {
        // 网易云：没有 uin 字段时无法继续下钻，仅展示
      }
    }
    return (
      <div
        key={`${u.encUin || u.mid || u.name}-${u.name}`}
        className="rounded-xl p-4 transition-all cursor-pointer"
        style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
        onClick={handleClick}
        title={isSinger ? '点击打开歌手详情' : '点击查看个人中心'}
      >
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }}>
            {u.avatarUrl ? <img src={u.avatarUrl} alt={u.name} className="w-full h-full object-cover" /> : <User className="w-6 h-6 m-auto mt-3 text-white/30" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-white text-sm font-medium truncate">{u.name}</p>
            <p className="text-white/40 text-xs truncate mt-0.5">{u.desc || (isSinger ? '歌手' : '这个人很懒，什么都没写')}</p>
          </div>
          {platform === 'qq' && !isSinger && !u.isSelf && u.encUin && (
            <button
              type="button"
              className={`shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors ${u.isFollow ? 'text-white/50 hover:text-white/80' : 'text-white'}`}
              style={u.isFollow ? { background: 'rgba(255,255,255,0.1)' } : { background: `${accentColor}55`, border: `1px solid ${accentColor}88` }}
              onClick={(event) => {
                event.stopPropagation()
                const next = !u.isFollow
                // 乐观更新
                setFollows(prev => prev.map(i => i.encUin === u.encUin ? { ...i, isFollow: next } : i))
                setFans(prev => prev.map(i => i.encUin === u.encUin ? { ...i, isFollow: next } : i))
                void subscribeQQUser(u.encUin, next).then((result) => {
                  if (!(result?.result === 100 || result?.code === 200)) {
                    setFollows(prev => prev.map(i => i.encUin === u.encUin ? { ...i, isFollow: u.isFollow } : i))
                    setFans(prev => prev.map(i => i.encUin === u.encUin ? { ...i, isFollow: u.isFollow } : i))
                  }
                })
              }}
            >
              {u.isFollow ? '已关注' : (myFansSet.has(u.encUin) ? '回关' : '关注')}
            </button>
          )}
        </div>
      </div>
    )
  }

  const renderRelationGrid = (items: RelationItem[], emptyText: string) => (
    items.length === 0 ? (
      <div className="py-14 text-center text-white/45 text-sm">{emptyText}</div>
    ) : (
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {items.map(u => renderRelationCard(u))}
      </div>
    )
  )

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'overview', label: '概览' },
    { key: 'follows', label: `关注${followNum != null ? ` (${followNum})` : ''}` },
    { key: 'fans', label: `粉丝${fansNum != null ? ` (${fansNum})` : ''}` },
  ]

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(10px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 14 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 14 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl overflow-hidden rounded-3xl shadow-2xl max-h-[90vh] flex flex-col"
        style={{ background: 'rgba(14,17,24,0.92)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(30px)' }}
      >
        {/* 顶部栏 */}
        <div className="flex items-center gap-3 px-5 py-4 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15" aria-label="返回">
            <ArrowLeft className="w-5 h-5 text-white/70" />
          </button>
          <h2 className="text-base font-semibold text-white flex-1 truncate">个人中心</h2>
          <span className="px-2 py-0.5 rounded-full text-xs text-white" style={{ background: `${accentColor}33`, border: `1px solid ${accentColor}88` }}>
            {platform === 'netease' ? '网易云音乐' : 'QQ 音乐'}
          </span>
        </div>

        {/* 资料区 */}
        <div className="px-6 pt-6 pb-4 shrink-0" style={{ background: `linear-gradient(160deg, ${accentColor}2e 0%, transparent 55%)` }}>
          <div className="flex items-center gap-4">
            <div className="w-20 h-20 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.1)', border: `2px solid ${accentColor}66` }}>
              {avatar ? <img src={avatar} alt={nickname} className="w-full h-full object-cover" /> : <User className="w-10 h-10 m-auto mt-5 text-white/30" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-xl font-bold truncate">{nickname}</p>
              <p className="text-white/50 text-sm truncate mt-1">{signature || '这个人很懒，什么都没写'}</p>
              {(followNum != null || fansNum != null) && (
                <div className="flex gap-4 mt-2 text-sm">
                  <span className="text-white/70">{followNum ?? 0} <span className="text-white/40">关注</span></span>
                  <span className="text-white/70">{fansNum ?? 0} <span className="text-white/40">粉丝</span></span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* tab */}
        <div className="flex px-6 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === tab.key ? 'text-white' : 'text-white/55 hover:text-white'}`}
              style={activeTab === tab.key ? { borderBottom: `2px solid ${accentColor}`, color: '#fff' } : {}}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="py-16 text-center text-white/45 text-sm">加载中...</div>
          ) : activeTab === 'overview' ? (
            <div>
              {platform === 'netease' && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <ListMusic className="w-4 h-4 text-white/60" />
                    <h3 className="text-sm font-medium text-white/80">歌单（{playlists.length}）</h3>
                  </div>
                  {playlists.length === 0 ? (
                    <div className="py-10 text-center text-white/40 text-sm">暂无歌单</div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                      {playlists.map((p, index) => (
                        <div
                          key={`${p.id}-${index}`}
                          className="rounded-xl p-2.5 cursor-pointer transition-all"
                          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                          onClick={() => { if (p.id && onPlayPlaylist) { onClose(); onPlayPlaylist({ ...p, id: Number(p.id) }, 'netease') } }}
                          title="点击播放歌单"
                        >
                          <div className="relative w-full aspect-square rounded-lg overflow-hidden mb-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            {p.coverImgUrl ? <img src={p.coverImgUrl} alt={p.name} className="w-full h-full object-cover" /> : <Music className="w-8 h-8 m-auto text-white/20" />}
                            {p.name.includes('喜欢的音乐') && (
                              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                                <Heart className="h-[42%] w-[42%] fill-white/75 text-white/75" strokeWidth={0} style={{ filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.28)) blur(0.7px)' }} />
                              </div>
                            )}
                          </div>
                          <p className="text-white/90 text-xs font-medium truncate">{p.name}</p>
                          <p className="text-white/40 text-[11px] truncate mt-0.5">{p.trackCount} 首</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {platform === 'qq' && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <ListMusic className="w-4 h-4 text-white/60" />
                    <h3 className="text-sm font-medium text-white/80">完整个人中心（网页版）</h3>
                  </div>
                  <div className="rounded-xl overflow-hidden h-[480px]" style={{ border: '1px solid rgba(255,255,255,0.1)' }}>
                    <iframe
                      src={`https://y.qq.com/n/ryqq_v2/profile?uin=${encodeURIComponent(userId)}`}
                      className="w-full h-full"
                      style={{ background: '#fff' }}
                      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                      title="QQ音乐个人中心"
                    />
                  </div>
                  <p className="text-white/35 text-xs mt-2">
                    此处嵌入网页版完整个人中心（我喜欢 / 创建歌单 / 关注 / 粉丝）；下方的「关注」「粉丝」标签为应用内数据，可交互关注/回关。
                  </p>
                </div>
              )}
            </div>
          ) : activeTab === 'follows' ? (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Users className="w-4 h-4 text-white/60" />
                <h3 className="text-sm font-medium text-white/80">关注（{follows.length}）</h3>
              </div>
              {renderRelationGrid(follows, '暂无关注')}
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Users className="w-4 h-4 text-white/60" />
                <h3 className="text-sm font-medium text-white/80">粉丝（{fans.length}）</h3>
              </div>
              {renderRelationGrid(fans, '暂无粉丝')}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
})
