import { memo, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, User, Music, ListMusic, Users } from 'lucide-react'
import { getUserDetail, getUserPlaylistList, getQQUserProfile, subscribeQQUser } from '../services/musicApi'

interface UserProfileModalProps {
  platform: 'netease' | 'qq'
  userId: string // 网易云数字 uid / QQ EncUin
  nickname?: string
  avatarUrl?: string
  signature?: string
  accentColor?: string
  onClose: () => void
  onPlayPlaylist?: (playlist: any, platform: 'netease' | 'qq') => void
  onOpenUser?: (userId: string, nickname?: string, avatarUrl?: string) => void // 点击列表用户打开其主页（递归）
}

interface PlaylistItem {
  id: string
  name: string
  coverImgUrl: string
  trackCount: number
}

interface QqRelationItem {
  encUin: string
  mid: string
  name: string
  desc: string
  avatarUrl: string
  isFollow: boolean
  isSelf: boolean
}

export default memo(function UserProfileModal({
  platform,
  userId,
  nickname: initialNickname,
  avatarUrl: initialAvatar,
  signature: initialSignature,
  accentColor = '#3B82F6',
  onClose,
  onPlayPlaylist,
  onOpenUser,
}: UserProfileModalProps) {
  const [nickname, setNickname] = useState(initialNickname || '未知用户')
  const [avatar, setAvatar] = useState(initialAvatar || '')
  const [signature, setSignature] = useState(initialSignature || '')
  const [playlists, setPlaylists] = useState<PlaylistItem[]>([])
  const [loading, setLoading] = useState(platform === 'netease')

  // QQ 用户主页数据（关注/粉丝数 + 关注/粉丝列表，EncUin 可查他人）
  const [qqFollowNum, setQqFollowNum] = useState<number | null>(null)
  const [qqFansNum, setQqFansNum] = useState<number | null>(null)
  const [qqFollows, setQqFollows] = useState<QqRelationItem[]>([])
  const [qqFans, setQqFans] = useState<QqRelationItem[]>([])

  useEffect(() => {
    if (platform === 'netease') {
      let cancelled = false
      getUserDetail(userId).then((data) => {
        if (cancelled || !data?.profile) return
        setNickname(data.profile.nickname || '未知用户')
        setAvatar(data.profile.avatarUrl || '')
        setSignature(data.profile.signature || '')
      })
      getUserPlaylistList(userId).then((data) => {
        if (cancelled) return
        const list = data?.playlist || []
        setPlaylists(Array.isArray(list) ? list.map((p: any) => ({
          id: String(p.id || ''),
          name: p.name || '未命名歌单',
          coverImgUrl: p.coverImgUrl || '',
          trackCount: Number(p.trackCount ?? p.trackNumber ?? 0),
        })) : [])
        setLoading(false)
      })
      return () => { cancelled = true }
    }

    // QQ：查关注/粉丝数与列表
    let cancelled = false
    getQQUserProfile(userId).then((data) => {
      if (cancelled || !data?.data) return
      const d = data.data
      setQqFollowNum(d.followNum ?? null)
      setQqFansNum(d.fansNum ?? null)
      setQqFollows(Array.isArray(d.follows) ? d.follows.map((u: any) => ({
        encUin: u.EncUin || '',
        mid: u.MID || '',
        name: u.Name || '未知用户',
        desc: u.Desc || '',
        avatarUrl: u.AvatarUrl || '',
        isFollow: Boolean(u.IsFollow),
        isSelf: Boolean(u.OtherInfo?.IsSelf),
      })) : [])
      setQqFans(Array.isArray(d.fans) ? d.fans.map((u: any) => ({
        encUin: u.EncUin || '',
        mid: u.MID || '',
        name: u.Name || '未知用户',
        desc: u.Desc || '',
        avatarUrl: u.AvatarUrl || '',
        isFollow: Boolean(u.IsFollow),
        isSelf: Boolean(u.OtherInfo?.IsSelf),
      })) : [])
    })
    return () => { cancelled = true }
  }, [platform, userId])

  const renderRelationList = (items: QqRelationItem[], emptyText: string, onToggle: (item: QqRelationItem, next: boolean) => void) => (
    items.length === 0 ? (
      <div className="py-6 text-center text-white/40 text-xs">{emptyText}</div>
    ) : (
      <div className="space-y-1">
        {items.map((u, index) => (
          <div
            key={`${u.encUin || u.mid}-${index}`}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
            onClick={() => { if (u.encUin && onOpenUser) onOpenUser(u.encUin, u.name, u.avatarUrl) }}
            title={u.mid ? '歌手' : '点击查看用户主页'}
          >
            <div className="w-9 h-9 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
              {u.avatarUrl ? <img src={u.avatarUrl} alt={u.name} className="w-full h-full object-cover" /> : <User className="w-5 h-5 m-auto mt-2 text-white/30" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white/90 text-xs font-medium truncate">{u.name}</p>
              <p className="text-white/40 text-[11px] truncate">{u.desc || (u.mid ? '歌手' : '用户')}</p>
            </div>
            {!u.mid && !u.isSelf && u.encUin && (
              <button
                type="button"
                className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] transition-colors ${u.isFollow ? 'text-white/50 hover:text-white/80' : 'text-white'}`}
                style={u.isFollow ? { background: 'rgba(255,255,255,0.1)' } : { background: `${accentColor}55`, border: `1px solid ${accentColor}88` }}
                onClick={(event) => {
                  event.stopPropagation()
                  onToggle(u, !u.isFollow)
                }}
              >
                {u.isFollow ? '已关注' : '回关'}
              </button>
            )}
          </div>
        ))}
      </div>
    )
  )

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 26, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-3xl shadow-2xl max-h-[85vh] flex flex-col"
        style={{ background: 'rgba(14,17,24,0.9)', border: '1px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(30px)' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4 shrink-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div className="flex items-center gap-2">
            <User className="w-5 h-5" style={{ color: accentColor }} />
            <h2 className="text-base font-semibold text-white">用户主页</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
            <X className="w-5 h-5 text-white/60" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {/* 用户资料 */}
          <div className="flex items-center gap-4 mb-6">
            <div className="w-20 h-20 rounded-full overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.1)' }}>
              {avatar ? <img src={avatar} alt={nickname} className="w-full h-full object-cover" /> : <User className="w-10 h-10 m-auto mt-5 text-white/30" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-white text-xl font-semibold truncate">{nickname}</p>
              <p className="text-white/50 text-sm truncate mt-1">{signature || '这个人很懒，什么都没写'}</p>
              <span className="inline-block mt-2 px-2 py-0.5 rounded-full text-xs" style={{ background: `${accentColor}33`, border: `1px solid ${accentColor}88`, color: '#fff' }}>
                {platform === 'netease' ? '网易云音乐' : 'QQ 音乐'}
              </span>
              {platform === 'qq' && (qqFollowNum !== null || qqFansNum !== null) && (
                <span className="ml-2 text-white/50 text-xs">
                  {qqFollowNum !== null ? `${qqFollowNum} 关注` : ''} {qqFansNum !== null ? `· ${qqFansNum} 粉丝` : ''}
                </span>
              )}
            </div>
          </div>

          {/* 歌单区（网易云可查） */}
          {platform === 'netease' && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <ListMusic className="w-4 h-4 text-white/60" />
                <h3 className="text-sm font-medium text-white/80">歌单（{playlists.length}）</h3>
              </div>
              {loading ? (
                <div className="py-8 text-center text-white/40 text-sm">加载中...</div>
              ) : playlists.length === 0 ? (
                <div className="py-8 text-center text-white/40 text-sm">暂无歌单</div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {playlists.map((p, index) => (
                    <div
                      key={`${p.id}-${index}`}
                      className="rounded-xl p-2 cursor-pointer transition-all"
                      style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                      onClick={() => { if (p.id && onPlayPlaylist) { onClose(); onPlayPlaylist({ ...p, id: Number(p.id) }, 'netease') } }}
                      title="点击播放歌单"
                    >
                      <div className="relative w-full aspect-square rounded-lg overflow-hidden mb-2" style={{ background: 'rgba(255,255,255,0.08)' }}>
                        {p.coverImgUrl ? <img src={p.coverImgUrl} alt={p.name} className="w-full h-full object-cover" /> : <Music className="w-8 h-8 m-auto text-white/20" />}
                      </div>
                      <p className="text-white/90 text-xs font-medium truncate">{p.name}</p>
                      <p className="text-white/40 text-[11px] truncate mt-0.5">{p.trackCount} 首</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* QQ 关注/粉丝列表 */}
          {platform === 'qq' && (
            <>
              <div className="mb-4">
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-white/60" />
                  <h3 className="text-sm font-medium text-white/80">关注（{qqFollows.length}）</h3>
                </div>
                {renderRelationList(qqFollows, '暂无关注', (item, next) => {
                  void subscribeQQUser(item.encUin, next).then((result) => {
                    if (result?.result === 100 || result?.code === 200) {
                      setQqFollows(prev => prev.map(i => i.encUin === item.encUin ? { ...i, isFollow: next } : i))
                    }
                  })
                })}
              </div>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-white/60" />
                  <h3 className="text-sm font-medium text-white/80">粉丝（{qqFans.length}）</h3>
                </div>
                {renderRelationList(qqFans, '暂无粉丝', (item, next) => {
                  void subscribeQQUser(item.encUin, next).then((result) => {
                    if (result?.result === 100 || result?.code === 200) {
                      setQqFans(prev => prev.map(i => i.encUin === item.encUin ? { ...i, isFollow: next } : i))
                    }
                  })
                })}
              </div>
            </>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
})
