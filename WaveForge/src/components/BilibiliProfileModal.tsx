/**
 * B 站个人主页（个人中心）
 *
 * - 本人主页（默认）：资料 + 收藏夹 / 观看历史 / 我的投稿 / 关注 四个 tab
 * - 他人主页（关注列表点入）：资料 + 投稿（公开）；收藏/关注尝试加载，未登录/未公开显示提示
 * - 收藏夹/历史/关注为登录接口（看歌本身要求登录）；未登录显示登录引导
 * - 视频点播 → BilibiliVideoPlayerOverlay 全屏播放（历史支持续播进度）
 * - 视频浮层可"设为当前歌曲 MV"（写入 override，回到看歌自动播放）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ChevronLeft, Eye, Clock, PlayCircle, FolderHeart, History, Upload, Users, Loader2, BadgeCheck, Crown, RefreshCw } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import {
  getBilibiliSpaceAcc,
  getBilibiliSpaceVideos,
  getBilibiliFavFolders,
  getBilibiliFavList,
  getBilibiliHistory,
  getBilibiliFollowings,
  isBilibiliLoggedIn,
  getStoredBilibiliUser,
  formatBiliTime,
  resolveBiliPic,
  type BilibiliSpaceUser,
  type BilibiliSpaceVideo,
  type BilibiliFavFolder,
  type BilibiliHistoryItem,
  type BilibiliFollowUser,
} from '../services/bilibiliApi'
import BilibiliLoginPanel from './BilibiliLoginPanel'
import BilibiliVideoPlayerOverlay from './BilibiliVideoPlayerOverlay'

interface BilibiliProfileModalProps {
  /** 为空 = 当前登录用户主页 */
  initialMid?: number
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  /** 提供后视频浮层可"设为当前歌曲 MV" */
  currentSongContext?: { songKey: string; songTitle: string } | null
}

type ProfileTab = 'fav' | 'history' | 'uploads' | 'following'

const BILI_PINK = '#FB7299'

function formatCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n || 0)
}

export default function BilibiliProfileModal({ initialMid, onClose, playerTheme = 'dark', currentSongContext }: BilibiliProfileModalProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const dark = playerTheme === 'dark'

  // ===== 登录态 =====
  const [loginReady, setLoginReady] = useState(() => isBilibiliLoggedIn())
  const [showLogin, setShowLogin] = useState(false)

  // ===== 导航栈（他人主页） =====
  const [stack, setStack] = useState<{ mid: number; name: string }[]>([])
  const selfMid = getStoredBilibiliUser()?.mid || 0
  const currentMid = stack.length ? stack[stack.length - 1].mid : initialMid || selfMid
  const isSelf = !stack.length && !initialMid

  // ===== 数据 =====
  const [user, setUser] = useState<BilibiliSpaceUser | null>(null)
  const [userLoading, setUserLoading] = useState(true)
  const [userError, setUserError] = useState('')
  const [tab, setTab] = useState<ProfileTab>('fav')
  const [uploadCount, setUploadCount] = useState(0)

  // 收藏夹
  const [folders, setFolders] = useState<BilibiliFavFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [foldersError, setFoldersError] = useState('')
  const [openFolder, setOpenFolder] = useState<{ id: number; title: string } | null>(null)
  const [favVideos, setFavVideos] = useState<BilibiliSpaceVideo[]>([])
  const [favLoading, setFavLoading] = useState(false)

  // 历史
  const [history, setHistory] = useState<BilibiliHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')

  // 投稿
  const [uploads, setUploads] = useState<BilibiliSpaceVideo[]>([])
  const [uploadsLoading, setUploadsLoading] = useState(false)
  const [uploadsPage, setUploadsPage] = useState(1)

  // 关注
  const [followings, setFollowings] = useState<BilibiliFollowUser[]>([])
  const [followingsLoading, setFollowingsLoading] = useState(false)
  const [followingsError, setFollowingsError] = useState('')

  // 播放
  const [playing, setPlaying] = useState<{ bvid: string; title?: string; initialSeek?: number } | null>(null)

  const loadTokenRef = useRef(0)

  const reloadLogin = useCallback(() => {
    setLoginReady(isBilibiliLoggedIn())
  }, [])

  useEffect(() => {
    const onAuth = () => reloadLogin()
    window.addEventListener('bilibili-auth-changed', onAuth as EventListener)
    return () => window.removeEventListener('bilibili-auth-changed', onAuth as EventListener)
  }, [reloadLogin])

  // ===== 加载当前用户资料 + 投稿数 =====
  useEffect(() => {
    const token = ++loadTokenRef.current
    if (!currentMid) {
      setUser(null)
      setUserLoading(false)
      return
    }
    setUserLoading(true)
    setUserError('')
    setUploads([])
    setUploadsPage(1)
    setTab('fav')
    setOpenFolder(null)
    void (async () => {
      try {
        const [acc, videos] = await Promise.all([
          getBilibiliSpaceAcc(currentMid).catch(() => null),
          getBilibiliSpaceVideos(currentMid, 1, 6).catch(() => null),
        ])
        if (token !== loadTokenRef.current) return
        if (acc && acc.code === 0) setUser(acc.data)
        if (videos && videos.code === 0) {
          setUploads(videos.data.list)
          setUploadCount(videos.data.total || 0)
        }
        setUserLoading(false)
      } catch {
        if (token === loadTokenRef.current) {
          setUserError('加载用户资料失败')
          setUserLoading(false)
        }
      }
    })()
  }, [currentMid])

  // ===== Tab 数据加载 =====
  const loadFolders = useCallback(async () => {
    if (!currentMid) return
    setFoldersLoading(true)
    setFoldersError('')
    try {
      const r = await getBilibiliFavFolders(currentMid)
      if (r.code === 0) setFolders(r.data.list || [])
      else if (r.code === -101) setFoldersError('需要登录后查看收藏夹')
      else setFoldersError(r.code === -1 ? '' : '加载收藏夹失败')
    } catch {
      setFoldersError('加载收藏夹失败')
    } finally {
      setFoldersLoading(false)
    }
  }, [currentMid])

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const r = await getBilibiliHistory(1, 15)
      if (r.code === 0) setHistory(r.data.list || [])
      else if (r.code === -101) setHistoryError('需要登录后查看观看历史')
      else setHistoryError('加载历史失败')
    } catch {
      setHistoryError('加载历史失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadFollowings = useCallback(async () => {
    if (!currentMid) return
    setFollowingsLoading(true)
    setFollowingsError('')
    try {
      const r = await getBilibiliFollowings(currentMid, 1, 12)
      if (r.code === 0) setFollowings(r.data.list || [])
      else if (r.code === -101) setFollowingsError('需要登录后查看关注列表')
      else setFollowingsError('加载关注失败')
    } catch {
      setFollowingsError('加载关注失败')
    } finally {
      setFollowingsLoading(false)
    }
  }, [currentMid])

  useEffect(() => {
    if (tab === 'fav') void loadFolders()
    else if (tab === 'history') void loadHistory()
    else if (tab === 'following') void loadFollowings()
  }, [tab, loadFolders, loadHistory, loadFollowings])

  // 收藏夹内容
  const openFolderVideos = async (folder: BilibiliFavFolder) => {
    setOpenFolder({ id: folder.id, title: folder.title })
    setFavLoading(true)
    setFavVideos([])
    try {
      const r = await getBilibiliFavList(folder.id, 1, 12)
      if (r.code === 0) setFavVideos(r.data.list || [])
    } catch {
      // 空态
    } finally {
      setFavLoading(false)
    }
  }

  // 投稿加载更多
  const loadMoreUploads = async () => {
    const next = uploadsPage + 1
    setUploadsLoading(true)
    try {
      const r = await getBilibiliSpaceVideos(currentMid, next, 10)
      if (r.code === 0) {
        setUploads((prev) => [...prev, ...r.data.list])
        setUploadsPage(next)
      }
    } catch {
      // 忽略
    } finally {
      setUploadsLoading(false)
    }
  }

  const pushUser = (u: BilibiliFollowUser) => {
    setStack((prev) => [...prev, { mid: u.mid, name: u.uname }])
  }

  const popStack = () => {
    if (stack.length) setStack((prev) => prev.slice(0, -1))
  }

  // ===== 渲染工具 =====

  const textPrimary = dark ? 'text-white' : 'text-black/90'
  const textSecondary = dark ? 'text-white/60' : 'text-black/55'
  const textTertiary = dark ? 'text-white/40' : 'text-black/40'
  const bgCard = dark ? 'bg-white/[0.05]' : 'bg-black/[0.03]'
  const borderColor = dark ? 'border-white/10' : 'border-black/10'

  const renderVideoItem = (v: BilibiliSpaceVideo, extra?: { progress?: number; duration?: number; viewAt?: number }) => (
    <button
      key={v.bvid}
      type="button"
      onClick={() => setPlaying({ bvid: v.bvid, title: v.title, initialSeek: extra?.progress })}
      className={`group flex items-center gap-3 rounded-xl p-2 text-left transition-colors ${bgCard} hover:opacity-85 w-full`}
    >
      <div className="relative flex-shrink-0">
        <img
          src={resolveBiliPic(v.pic)}
          alt=""
          className="w-24 h-14 object-cover rounded-lg bg-white/10"
          loading="lazy"
          onError={(e) => {
            const el = e.currentTarget
            el.onerror = null
            el.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"%3E%3Crect width="24" height="24" rx="4" fill="rgba(255,255,255,0.08)"/%3E%3Cpath d="M9 18V5l12-2v13" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1.5"/%3E%3C/svg%3E'
          }}
        />
        {v.duration > 0 && (
          <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 py-0.5 text-[10px] text-white">
            {formatBiliTime(v.duration)}
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors rounded-lg">
          <PlayCircle size={26} className="text-white opacity-0 group-hover:opacity-100" />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <p className={`truncate text-sm font-medium ${textPrimary}`}>{v.title}</p>
        <p className={`mt-0.5 flex items-center gap-3 text-xs ${textTertiary}`}>
          <span className="flex items-center gap-1"><Eye size={12} />{formatCount(v.play)}</span>
          {v.author && <span className="truncate">{v.author}</span>}
          {extra?.viewAt && <span>{new Date(extra.viewAt * 1000).toLocaleDateString()}</span>}
        </p>
        {typeof extra?.progress === 'number' && extra.duration && extra.duration > 0 && (
          <div className="mt-1.5 h-1 rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.min(100, (extra.progress / extra.duration) * 100)}%`, backgroundColor: BILI_PINK }}
            />
          </div>
        )}
      </div>
    </button>
  )

  const renderLoginGate = () => (
    <div className="flex flex-col items-center justify-center gap-4 py-14 text-center">
      <div className="p-3 rounded-2xl" style={{ backgroundColor: BILI_PINK }}>
        <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor">
          <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.765-1.56 3.761-1.004.996-2.263 1.52-3.773 1.574h-.854c-1.51-.054-2.769-.578-3.773-1.574-.996-.996-1.51-2.251-1.542-3.76v-1.804h-4.996v1.804c-.032 1.509-.546 2.764-1.542 3.76-1.004.996-2.263 1.52-3.773 1.574h-.854C1.75 20.554.491 20.03-.513 19.034c-1.004-.996-1.524-2.251-1.56-3.76v-7.36c.036-1.511.556-2.765 1.56-3.761C.49 2.157 1.75 1.633 3.26 1.58h.854c1.51.054 2.769.578 3.773 1.574.996.996 1.51 2.251 1.542 3.76v1.804h4.996V6.914c.032-1.509.546-2.764 1.542-3.76 1.004-.996 2.263-1.52 3.773-1.574z" />
        </svg>
      </div>
      <div>
        <h3 className={`text-lg font-bold ${textPrimary}`}>登录哔哩哔哩查看个人主页</h3>
        <p className={`text-sm mt-1 max-w-xs ${textSecondary}`}>收藏夹、观看历史与关注列表需要 B 站登录态</p>
      </div>
      <button
        type="button"
        onClick={() => setShowLogin(true)}
        className="rounded-xl px-6 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-105"
        style={{ backgroundColor: BILI_PINK }}
      >
        扫码登录
      </button>
    </div>
  )

  const renderTabContent = () => {
    if (tab === 'fav') {
      if (openFolder) {
        return (
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setOpenFolder(null)}
              className={`flex items-center gap-1 text-xs ${textSecondary} hover:opacity-75 w-fit`}
            >
              <ChevronLeft size={14} /> 返回收藏夹列表
            </button>
            <h4 className={`text-sm font-semibold ${textPrimary}`}>{openFolder.title}</h4>
            {favLoading ? (
              <LoadingRow label="加载收藏内容…" />
            ) : favVideos.length ? (
              favVideos.map((v) => renderVideoItem(v))
            ) : (
              <EmptyRow label="这个收藏夹是空的或未公开" />
            )}
          </div>
        )
      }
      return (
        <div className="flex flex-col gap-2">
          {foldersLoading ? (
            <LoadingRow label="加载收藏夹…" />
          ) : foldersError ? (
            <EmptyRow label={foldersError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
          ) : folders.length ? (
            folders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => void openFolderVideos(f)}
                className={`group flex items-center gap-3 rounded-xl p-2 text-left transition-colors ${bgCard} hover:opacity-85 w-full`}
              >
                <img
                  src={resolveBiliPic(f.cover)}
                  alt=""
                  className="w-16 h-16 object-cover rounded-lg bg-white/10 flex-shrink-0"
                  loading="lazy"
                />
                <div className="flex-1 min-w-0">
                  <p className={`truncate text-sm font-medium ${textPrimary}`}>{f.title}</p>
                  <p className={`text-xs mt-0.5 ${textTertiary}`}>{formatCount(f.mediaCount)} 个内容</p>
                </div>
                <FolderHeart size={18} className={`${textTertiary} group-hover:opacity-80`} />
              </button>
            ))
          ) : (
            <EmptyRow label="暂无收藏夹" />
          )}
        </div>
      )
    }
    if (tab === 'history') {
      return (
        <div className="flex flex-col gap-2">
          {historyLoading ? (
            <LoadingRow label="加载观看历史…" />
          ) : historyError ? (
            <EmptyRow label={historyError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
          ) : history.length ? (
            history.map((h) => renderVideoItem(h, { progress: h.progress, duration: h.duration, viewAt: h.viewAt }))
          ) : (
            <EmptyRow label="暂无观看历史" />
          )}
        </div>
      )
    }
    if (tab === 'uploads') {
      return (
        <div className="flex flex-col gap-2">
          {uploadsLoading && uploads.length === 0 ? (
            <LoadingRow label="加载投稿…" />
          ) : uploads.length ? (
            <>
              {uploads.map((v) => renderVideoItem(v, { viewAt: v.pubdate }))}
              {uploads.length < uploadCount && (
                <button
                  type="button"
                  onClick={() => void loadMoreUploads()}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm ${textSecondary} ${bgCard} hover:opacity-80`}
                >
                  {uploadsLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  加载更多（{formatCount(uploads.length)}/{formatCount(uploadCount)}）
                </button>
              )}
            </>
          ) : (
            <EmptyRow label="暂无投稿" />
          )}
        </div>
      )
    }
    // following
    return (
      <div className="flex flex-col gap-2">
        {followingsLoading ? (
          <LoadingRow label="加载关注列表…" />
        ) : followingsError ? (
          <EmptyRow label={followingsError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
        ) : followings.length ? (
          followings.map((u) => (
            <button
              key={u.mid}
              type="button"
              onClick={() => pushUser(u)}
              className={`group flex items-center gap-3 rounded-xl p-2 text-left transition-colors ${bgCard} hover:opacity-85 w-full`}
            >
              <img
                src={resolveBiliPic(u.face)}
                alt=""
                className="w-10 h-10 rounded-full bg-white/10 object-cover flex-shrink-0"
                loading="lazy"
              />
              <div className="flex-1 min-w-0">
                <p className={`truncate text-sm font-medium ${textPrimary}`}>{u.uname}</p>
                {u.sign && <p className={`truncate text-xs mt-0.5 ${textTertiary}`}>{u.sign}</p>}
              </div>
              <ChevronLeft size={16} className={`${textTertiary} rotate-180 group-hover:opacity-80`} />
            </button>
          ))
        ) : (
          <EmptyRow label="暂无关注" />
        )}
      </div>
    )
  }

  const LoadingRow = ({ label }: { label: string }) => (
    <div className={`flex items-center justify-center gap-2 py-10 text-sm ${textTertiary}`}>
      <Loader2 size={16} className="animate-spin" style={{ color: BILI_PINK }} />
      {label}
    </div>
  )

  const EmptyRow = ({ label, action, actionLabel }: { label: string; action?: () => void; actionLabel?: string }) => (
    <div className={`flex flex-col items-center gap-3 py-10 text-sm ${textTertiary}`}>
      <span>{label}</span>
      {action && (
        <button type="button" onClick={action} className="rounded-lg px-4 py-1.5 text-xs font-medium text-white" style={{ backgroundColor: BILI_PINK }}>
          {actionLabel}
        </button>
      )}
    </div>
  )

  // ===== 渲染 =====
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 sm:p-8"
      data-tv-scope
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.96, y: 14 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 14 }}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-3xl max-h-[88vh] rounded-2xl border overflow-hidden flex flex-col shadow-2xl ${dark ? 'bg-[#0c0e1a]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'}`}
      >
        {/* 头部 */}
        <div className={`flex items-center justify-between px-5 py-4 border-b ${borderColor}`}>
          <div className="flex items-center gap-2 min-w-0">
            {(stack.length > 0 || initialMid) && (
              <button type="button" onClick={popStack} className={`p-1.5 rounded-lg ${textSecondary} hover:opacity-70`} title="返回上一级">
                <ChevronLeft size={18} />
              </button>
            )}
            <h2 className={`text-lg font-bold truncate ${textPrimary}`}>
              {user?.name || (stack.length ? stack[stack.length - 1].name : '哔哩哔哩个人主页')}
            </h2>
            {stack.length > 0 && <span className={`text-xs ${textTertiary}`}>· 查看他人主页</span>}
          </div>
          <button type="button" onClick={onClose} className={`p-1.5 rounded-lg ${dark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
            <X size={18} />
          </button>
        </div>

        {!loginReady && isSelf ? (
          renderLoginGate()
        ) : (
          <>
            {/* 用户信息区 */}
            <div className={`px-5 py-4 border-b ${borderColor} flex items-center gap-4`}>
              {userLoading ? (
                <Loader2 size={20} className="animate-spin" style={{ color: BILI_PINK }} />
              ) : user ? (
                <>
                  <div className="relative flex-shrink-0">
                    <img src={resolveBiliPic(user.face)} alt="" className="w-16 h-16 rounded-full object-cover bg-white/10 border-2" style={{ borderColor: user.vipType > 0 ? BILI_PINK : 'rgba(255,255,255,0.15)' }} />
                    {user.vipType > 0 && <Crown size={16} className="absolute -bottom-1 -right-1 text-yellow-400 bg-black/60 rounded-full p-0.5" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className={`text-base font-bold truncate ${textPrimary}`}>{user.name}</h3>
                      {user.officialVerify === 2 && <BadgeCheck size={16} className="text-sky-400 flex-shrink-0" />}
                      {user.vipType > 0 && (
                        <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white flex-shrink-0" style={{ backgroundColor: BILI_PINK }}>
                          大会员
                        </span>
                      )}
                    </div>
                    <p className={`text-xs mt-0.5 ${textTertiary}`}>Lv{user.level} {user.sign || '这个人很神秘，什么都没有写'}</p>
                    <p className={`text-xs mt-1.5 ${textSecondary}`}>
                      关注 <span className={textPrimary}>{formatCount(user.attention)}</span> · 粉丝 <span className={textPrimary}>{formatCount(user.fans)}</span>
                      {uploadCount > 0 && <> · 投稿 <span className={textPrimary}>{formatCount(uploadCount)}</span></>}
                      {user.likes > 0 && <> · 获赞 <span className={textPrimary}>{formatCount(user.likes)}</span></>}
                    </p>
                  </div>
                </>
              ) : (
                <p className={`text-sm ${textTertiary}`}>{userError || '用户不存在'}</p>
              )}
            </div>

            {/* Tab 栏 */}
            <div className={`flex items-center gap-1 px-4 pt-3 border-b ${borderColor} overflow-x-auto`}>
              <TabButton active={tab === 'fav'} icon={<FolderHeart size={14} />} label="收藏夹" onClick={() => setTab('fav')} />
              {isSelf && <TabButton active={tab === 'history'} icon={<History size={14} />} label="历史" onClick={() => setTab('history')} />}
              <TabButton active={tab === 'uploads'} icon={<Upload size={14} />} label="投稿" onClick={() => setTab('uploads')} />
              <TabButton active={tab === 'following'} icon={<Users size={14} />} label="关注" onClick={() => setTab('following')} />
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto p-4">{renderTabContent()}</div>
          </>
        )}
      </motion.div>

      {/* 登录弹窗 */}
      {showLogin && (
        <BilibiliLoginPanel
          onClose={() => setShowLogin(false)}
          onLoginSuccess={() => {
            setShowLogin(false)
            reloadLogin()
          }}
        />
      )}

      {/* 视频播放浮层 */}
      <AnimatePresence>
        {playing && (
          <BilibiliVideoPlayerOverlay
            bvid={playing.bvid}
            title={playing.title}
            initialSeek={playing.initialSeek}
            onClose={() => setPlaying(null)}
            setAsMvContext={currentSongContext}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-t-lg px-3.5 py-2 text-sm font-medium transition-colors border-b-2 ${
        active ? 'text-white border-transparent' : 'text-white/50 hover:text-white/80 border-transparent'
      }`}
      style={{ borderBottomColor: active ? '#FB7299' : 'transparent', color: active ? '#FB7299' : undefined }}
    >
      {icon}
      {label}
    </button>
  )
}
