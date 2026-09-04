/**
 * B 站个人主页（个人中心）—— 全新视觉版
 *
 * - 顶部横幅英雄区：同步用户皮肤横幅（top_photo）+ 头像/昵称/认证/粉丝数据
 * - 粉色系分段标签：收藏夹 / 历史 / 投稿 / 关注
 * - 视频卡片：圆角缩略图 + 时长角标 + 播放量/UP主/日期；收藏夹为网格卡片
 * - 收藏夹视频独立弹窗（分批加载 + 回到顶部）
 * - 视频点播 → BilibiliVideoPlayerOverlay（DASH 音画分离）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  X, ChevronLeft, Eye, PlayCircle, FolderHeart, History, Upload, Users, Loader2, BadgeCheck, Crown, RefreshCw, ArrowUp, ChevronRight, FolderOpen, Heart, Clock3,
} from 'lucide-react'
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
const PAGE_SIZE = 20

function formatCount(n: number): string {
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n || 0)
}

/**
 * B 站图片尺寸后缀：hdslb 图床支持 @Ww_Hh_1c.webp 缩略图。
 * 列表页封面全尺寸可达数 MB/张，几十条会严重卡顿；按网格尺寸拉缩略图。
 * 已有 @ / ? 参数（如顶栏图）或非 hdslb 域名则原样返回。
 */
function biliPic(url: string, w = 320, h = 180): string {
  const base = resolveBiliPic(url)
  if (!base) return ''
  if (base.includes('@') || base.includes('?') || !base.includes('hdslb.com')) return base
  return `${base}@${w}w_${h}h_1c.webp`
}

export default function BilibiliProfileModal({ initialMid, onClose, playerTheme = 'dark', currentSongContext }: BilibiliProfileModalProps) {
  useTvBack(() => {
    if (folderModal) {
      setFolderModal(null)
      return true
    }
    onClose()
    return true
  })

  const dark = playerTheme === 'dark'
  const [loginReady, setLoginReady] = useState(() => isBilibiliLoggedIn())
  const [showLogin, setShowLogin] = useState(false)

  const [stack, setStack] = useState<{ mid: number; name: string }[]>([])
  const currentMid = stack.length ? stack[stack.length - 1].mid : (initialMid ?? getStoredBilibiliUser()?.mid ?? 0)
  const isSelf = stack.length === 0 && !initialMid

  const [user, setUser] = useState<BilibiliSpaceUser | null>(null)
  const [userLoading, setUserLoading] = useState(true)
  const [userError, setUserError] = useState('')
  const [tab, setTab] = useState<ProfileTab>('fav')
  const [uploadCount, setUploadCount] = useState(0)

  // 收藏夹
  const [folders, setFolders] = useState<BilibiliFavFolder[]>([])
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [foldersError, setFoldersError] = useState('')
  const [folderModal, setFolderModal] = useState<{ id: number; title: string } | null>(null)
  // 收藏夹封面兜底：B 站文件夹接口 cover 常为空 → 用收藏夹内第一个视频的封面
  const [folderCoverMap, setFolderCoverMap] = useState<Record<number, string>>({})
  const [favVideos, setFavVideos] = useState<BilibiliSpaceVideo[]>([])
  const [favLoading, setFavLoading] = useState(false)
  const [favPage, setFavPage] = useState(1)
  const [favTotal, setFavTotal] = useState(0)

  // 历史（B 站 cursor 分页：max/view_at 游标，不用 pn）
  const [history, setHistory] = useState<BilibiliHistoryItem[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyCursor, setHistoryCursor] = useState<{ max?: number; viewAt?: number } | null>(null)
  const [historyHasMore, setHistoryHasMore] = useState(false)

  // 投稿
  const [uploads, setUploads] = useState<BilibiliSpaceVideo[]>([])
  const [uploadsLoading, setUploadsLoading] = useState(false)
  const [uploadsPage, setUploadsPage] = useState(1)
  const [uploadsError, setUploadsError] = useState('')

  // 关注
  const [followings, setFollowings] = useState<BilibiliFollowUser[]>([])
  const [followingsLoading, setFollowingsLoading] = useState(false)
  const [followingsError, setFollowingsError] = useState('')
  const [followingsPage, setFollowingsPage] = useState(1)
  const [followingsTotal, setFollowingsTotal] = useState(0)

  // 播放
  const [playing, setPlaying] = useState<{ bvid: string; title?: string; initialSeek?: number } | null>(null)

  const loadTokenRef = useRef(0)
  const folderScrollRef = useRef<HTMLDivElement>(null)

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
    setFolderModal(null)
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

  const loadHistory = useCallback(async (cursor: { max?: number; viewAt?: number } | null) => {
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const r = await getBilibiliHistory(cursor, PAGE_SIZE)
      if (r.code === 0) {
        const list = r.data.list || []
        setHistory(cursor ? (prev) => [...prev, ...list] : list)
        setHistoryCursor(r.data.cursor || null)
        setHistoryHasMore(r.data.hasMore === true)
      } else if (r.code === -101) setHistoryError('需要登录后查看观看历史')
      else setHistoryError('加载历史失败')
    } catch {
      setHistoryError('加载历史失败')
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  const loadFollowings = useCallback(async (page = 1) => {
    if (!currentMid) return
    setFollowingsLoading(true)
    setFollowingsError('')
    try {
      const r = await getBilibiliFollowings(currentMid, page, PAGE_SIZE)
      if (r.code === 0) {
        const list = r.data.list || []
        setFollowings(page === 1 ? list : (prev) => [...prev, ...list])
        setFollowingsTotal(r.data.total || 0)
        setFollowingsPage(page)
      } else if (r.code === -101) setFollowingsError('需要登录后查看关注列表')
      else setFollowingsError('加载关注失败')
    } catch {
      setFollowingsError('加载关注失败')
    } finally {
      setFollowingsLoading(false)
    }
  }, [currentMid])

  useEffect(() => {
    if (tab === 'fav') void loadFolders()
    else if (tab === 'history') void loadHistory(null)
    else if (tab === 'following') void loadFollowings(1)
  }, [tab, loadFolders, loadHistory, loadFollowings])

  // 收藏夹封面兜底：folder.cover 为空时取该收藏夹第一个视频的封面（已请求过的文件夹去重，避免切 Tab 反复拉取）
  const folderCoverRequestedRef = useRef<Set<number>>(new Set())
  useEffect(() => {
    const pending = folders.filter((f) => !f.cover && f.mediaCount > 0 && !folderCoverRequestedRef.current.has(f.id))
    if (!pending.length) return
    pending.slice(0, 8).forEach((f) => folderCoverRequestedRef.current.add(f.id))
    let cancelled = false
    for (const folder of pending.slice(0, 8)) {
      void getBilibiliFavList(folder.id, 1, 1)
        .then((r) => {
          if (cancelled || r.code !== 0) return
          const first = (r.data?.list || [])[0]
          if (first?.pic) {
            setFolderCoverMap((prev) => (prev[folder.id] ? prev : { ...prev, [folder.id]: first.pic }))
          }
        })
        .catch(() => undefined)
    }
    return () => {
      cancelled = true
    }
  }, [folders])

  // 收藏夹内容（弹窗，分批加载）
  const openFolderVideos = async (folder: BilibiliFavFolder) => {
    setFolderModal({ id: folder.id, title: folder.title })
    setFavVideos([])
    setFavPage(1)
    setFavTotal(0)
    setFavLoading(true)
    try {
      const r = await getBilibiliFavList(folder.id, 1, PAGE_SIZE)
      if (r.code === 0) {
        setFavVideos(r.data.list || [])
        setFavTotal(r.data.total || 0)
      }
    } catch {
      // 空态
    } finally {
      setFavLoading(false)
    }
  }

  const loadMoreFav = async () => {
    if (!folderModal || favLoading) return
    const next = favPage + 1
    setFavLoading(true)
    try {
      const r = await getBilibiliFavList(folderModal.id, next, PAGE_SIZE)
      if (r.code === 0) {
        setFavVideos((prev) => [...prev, ...(r.data.list || [])])
        setFavPage(next)
      }
    } catch {
      // 忽略
    } finally {
      setFavLoading(false)
    }
  }

  const loadMoreHistory = () => void loadHistory(historyCursor)
  const loadMoreFollowings = () => void loadFollowings(followingsPage + 1)

  const loadMoreUploads = async () => {
    const next = uploadsPage + 1
    setUploadsLoading(true)
    setUploadsError('')
    try {
      const r = await getBilibiliSpaceVideos(currentMid, next, 10)
      if (r.code === 0) {
        if (!r.data.list?.length) {
          // 已无更多内容（计数可能含失效/删除的视频）→ 收尾，隐藏"加载更多"
          setUploadCount(uploads.length)
          return
        }
        setUploads((prev) => [...prev, ...r.data.list])
        setUploadsPage(next)
      } else {
        setUploadsError(r.code === -352 ? '触发风控，稍后再试' : '加载更多失败')
      }
    } catch {
      setUploadsError('加载更多失败，请重试')
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

  /** 视频卡片（全新视觉：圆角缩略图 + 时长角标 + 两行标题 + 元信息） */
  const renderVideoCard = (v: BilibiliSpaceVideo, extra?: { progress?: number; duration?: number; viewAt?: number }) => (
    <button
      key={v.bvid}
      type="button"
      onClick={() => {
        if (!v.bvid) return // 空 bvid 不可播，避免"bvid 必填"
        setPlaying({ bvid: v.bvid, title: v.title, initialSeek: extra?.progress })
      }}
      className={`group w-full text-left transition-all hover:scale-[1.01] active:scale-[0.99] rounded-2xl overflow-hidden ${bgCard} border ${borderColor}`}
    >
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-white/10">
        {v.pic ? (
          <img
            src={biliPic(v.pic, 360, 200)}
            alt=""
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
            onError={(e) => { e.currentTarget.style.display = 'none' }}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-pink-500/30 to-purple-600/20">
            <PlayCircle size={28} className="text-white/50" />
          </div>
        )}
        {v.duration > 0 && (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {formatBiliTime(v.duration)}
          </span>
        )}
        <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/35 transition-colors">
          <span className="rounded-full bg-pink-500/90 p-2.5 text-white opacity-0 group-hover:opacity-100 transition-opacity">
            <PlayCircle size={22} />
          </span>
        </span>
        {typeof extra?.progress === 'number' && extra.duration && extra.duration > 0 && (
          <span className="absolute bottom-0 left-0 h-[3px] bg-pink-500" style={{ width: `${Math.min(100, (extra.progress / extra.duration) * 100)}%` }} />
        )}
      </div>
      <div className="p-2.5">
        <p className={`text-sm font-medium leading-snug line-clamp-2 ${textPrimary}`}>{v.title}</p>
        <p className={`mt-1.5 flex items-center gap-3 text-[11px] ${textTertiary}`}>
          <span className="flex items-center gap-1"><Eye size={11} />{formatCount(v.play)}</span>
          {v.author && <span className="truncate">{v.author}</span>}
          {extra?.viewAt && <span className="flex items-center gap-0.5"><Clock3 size={10} />{new Date(extra.viewAt * 1000).toLocaleDateString()}</span>}
        </p>
      </div>
    </button>
  )

  const renderLoadMore = ({ loading, count, total, onLoad }: { loading: boolean; count: number; total: number; onLoad: () => void }) =>
    count < total ? (
      <button
        type="button"
        onClick={onLoad}
        className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm w-full ${textSecondary} ${bgCard} border ${borderColor} hover:opacity-80`}
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        加载更多（{formatCount(count)}/{formatCount(total)}）
      </button>
    ) : null

  const renderLoginGate = () => (
    <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
      <div className="p-4 rounded-2xl bg-gradient-to-br from-pink-500 to-rose-500 shadow-lg shadow-pink-500/30">
        <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
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
        className="rounded-xl px-6 py-2.5 text-sm font-semibold text-white transition-transform hover:scale-105 bg-gradient-to-r from-pink-500 to-rose-500 shadow-lg shadow-pink-500/30"
      >
        扫码登录
      </button>
    </div>
  )

  const renderTabContent = () => {
    if (tab === 'fav') {
      return (
        <div>
          {foldersLoading ? (
            <SkeletonRow count={4} />
          ) : foldersError ? (
            <EmptyRow label={foldersError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
          ) : folders.length ? (
            <div className="grid grid-cols-2 gap-3">
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => void openFolderVideos(f)}
                  className={`group text-left overflow-hidden rounded-2xl border ${borderColor} ${bgCard} transition-all hover:scale-[1.02] active:scale-[0.99]`}
                >
                  <div className="relative aspect-[16/9] w-full overflow-hidden bg-white/10">
                    {(f.cover || folderCoverMap[f.id]) ? (
                      <img src={biliPic(f.cover || folderCoverMap[f.id], 360, 200)} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none' }} />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-pink-500/30 to-purple-600/20">
                        <FolderHeart size={30} className="text-white/50" />
                      </div>
                    )}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
                      <FolderOpen size={26} className="text-white opacity-0 group-hover:opacity-100" />
                    </span>
                  </div>
                  <div className="p-2.5">
                    <p className={`text-sm font-medium truncate ${textPrimary}`}>{f.title}</p>
                    <p className={`text-[11px] mt-0.5 flex items-center gap-1 ${textTertiary}`}>
                      <Heart size={10} /> {formatCount(f.mediaCount)} 个内容
                    </p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyRow label="暂无收藏夹" />
          )}
        </div>
      )
    }
    if (tab === 'history') {
      return (
        <div className="flex flex-col gap-3">
          {historyLoading && history.length === 0 ? (
            <SkeletonRow count={3} />
          ) : historyError ? (
            <EmptyRow label={historyError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
          ) : history.length ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {history.filter((h) => h.bvid).map((h) => renderVideoCard(h, { progress: h.progress, duration: h.duration, viewAt: h.viewAt }))}
              </div>
              {historyHasMore && renderLoadMore({ loading: historyLoading, count: history.length, total: history.length + 1, onLoad: loadMoreHistory })}
            </>
          ) : (
            <EmptyRow label="暂无观看历史" />
          )}
        </div>
      )
    }
    if (tab === 'uploads') {
      return (
        <div className="flex flex-col gap-3">
          {uploadsLoading && uploads.length === 0 ? (
            <SkeletonRow count={3} />
          ) : uploads.length ? (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {uploads.map((v) => renderVideoCard(v, { viewAt: v.pubdate }))}
              </div>
              {uploads.length < uploadCount && (
                <button
                  type="button"
                  onClick={() => void loadMoreUploads()}
                  className={`flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm ${textSecondary} ${bgCard} border ${borderColor} hover:opacity-80`}
                >
                  {uploadsLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  加载更多（{formatCount(uploads.length)}/{formatCount(uploadCount)}）
                </button>
              )}
              {uploadsError && (
                <p className={`text-center text-xs mt-1 ${textTertiary}`}>{uploadsError}</p>
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
      <div className="flex flex-col gap-3">
        {followingsLoading && followings.length === 0 ? (
          <SkeletonRow count={4} />
        ) : followingsError ? (
          <EmptyRow label={followingsError} action={loginReady ? undefined : () => setShowLogin(true)} actionLabel={loginReady ? undefined : '去登录'} />
        ) : followings.length ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {followings.map((u) => (
                <button
                  key={u.mid}
                  type="button"
                  onClick={() => pushUser(u)}
                  className={`group flex items-center gap-3 rounded-2xl p-3 border ${borderColor} ${bgCard} transition-all hover:scale-[1.02] active:scale-[0.99] text-left`}
                >
                  <div className="w-11 h-11 rounded-full overflow-hidden bg-white/10 flex-shrink-0 ring-2 ring-pink-500/30">
                    {u.face ? (
                      <img src={biliPic(u.face, 96, 96)} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-pink-500/30 to-purple-600/20"><Users size={18} className="text-white/50" /></div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm font-medium ${textPrimary}`}>{u.uname}</p>
                    {u.sign && <p className={`truncate text-[11px] mt-0.5 ${textTertiary}`}>{u.sign}</p>}
                  </div>
                  <ChevronRight size={16} className={`${textTertiary} flex-shrink-0`} />
                </button>
              ))}
            </div>
            {renderLoadMore({ loading: followingsLoading, count: followings.length, total: followingsTotal || followings.length + 1, onLoad: loadMoreFollowings })}
          </>
        ) : (
          <EmptyRow label="暂无关注" />
        )}
      </div>
    )
  }

  const SkeletonRow = ({ count }: { count: number }) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className={`animate-pulse rounded-2xl border ${borderColor} ${bgCard} overflow-hidden`}>
          <div className={`aspect-[16/9] w-full ${dark ? 'bg-white/10' : 'bg-black/10'}`} />
          <div className="p-2.5 space-y-1.5">
            <div className={`h-3 rounded ${dark ? 'bg-white/15' : 'bg-black/10'}`} />
            <div className={`h-2.5 w-2/3 rounded ${dark ? 'bg-white/10' : 'bg-black/10'}`} />
          </div>
        </div>
      ))}
    </div>
  )

  const EmptyRow = ({ label, action, actionLabel }: { label: string; action?: () => void; actionLabel?: string }) => (
    <div className={`flex flex-col items-center gap-3 py-14 text-sm ${textTertiary}`}>
      <span>{label}</span>
      {action && (
        <button type="button" onClick={action} className="rounded-lg px-4 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-pink-500 to-rose-500">
          {actionLabel}
        </button>
      )}
    </div>
  )

  const bannerUrl = user?.topPhoto ? biliPic(user.topPhoto, 1280, 200) : ''
  const heroVisible = !userLoading && Boolean(user)

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
        className={`w-full max-w-4xl max-h-[90vh] rounded-3xl border overflow-hidden flex flex-col shadow-2xl relative ${
          dark ? 'bg-[#14161f]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'
        }`}
      >
        {/* 横幅英雄区 */}
        {heroVisible && (
          <div className="relative h-40 sm:h-44 flex-shrink-0 overflow-hidden">
            {bannerUrl ? (
              <img src={bannerUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={(e) => { e.currentTarget.style.display = 'none' }} />
            ) : (
              <div className="w-full h-full bg-gradient-to-r from-pink-500 via-rose-500 to-purple-600" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/10" />

            {/* 返回/关闭 */}
            <div className="absolute top-0 left-0 right-0 flex items-center justify-between p-3">
              <div className="flex items-center gap-2">
                {(stack.length > 0 || initialMid) && (
                  <button type="button" onClick={popStack} className="p-2 rounded-full bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors" title="返回上一级">
                    <ChevronLeft size={18} />
                  </button>
                )}
                <span className="px-2.5 py-1 rounded-full bg-black/40 backdrop-blur-md text-white/85 text-xs">哔哩哔哩</span>
              </div>
              <button type="button" onClick={onClose} className="p-2 rounded-full bg-black/40 backdrop-blur-md text-white hover:bg-black/60 transition-colors">
                <X size={18} />
              </button>
            </div>

            {/* 头像 + 昵称 + 认证 + 数据 */}
            {user && (
              <div className="absolute bottom-0 left-0 right-0 flex items-end gap-3 p-4">
                <div className="relative flex-shrink-0">
                  <img
                    src={biliPic(user.face, 160, 160)}
                    alt=""
                    referrerPolicy="no-referrer"
                    className="w-16 h-16 sm:w-20 sm:h-20 rounded-full object-cover bg-white/10 border-4 border-white/40"
                    style={{ boxShadow: '0 4px 20px rgba(0,0,0,0.4)' }}
                  />
                  {user.vipType > 0 && <Crown size={20} className="absolute -bottom-1 -right-1 text-yellow-400 bg-black/60 rounded-full p-0.5" />}
                </div>
                <div className="min-w-0 flex-1 pb-0.5">
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg sm:text-xl font-bold text-white truncate drop-shadow">{user.name}</h3>
                    {user.officialVerify === 2 && <BadgeCheck size={18} className="text-sky-400 flex-shrink-0" />}
                    {user.vipType > 0 && (
                      <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold text-white flex-shrink-0 bg-gradient-to-r from-pink-500 to-rose-500">大会员</span>
                    )}
                  </div>
                  <p className="text-xs text-white/70 mt-0.5 truncate">Lv{user.level} {user.sign || '这个人很神秘，什么都没有写'}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {[
                      { label: '关注', value: formatCount(user.attention) },
                      { label: '粉丝', value: formatCount(user.fans) },
                      { label: '投稿', value: uploadCount > 0 ? formatCount(uploadCount) : null },
                      { label: '获赞', value: user.likes > 0 ? formatCount(user.likes) : null },
                    ].filter((s) => s.value !== null).map((s) => (
                      <span key={s.label} className="rounded-full bg-white/15 backdrop-blur-md px-2.5 py-0.5 text-[11px] text-white">
                        <b className="font-semibold">{s.value}</b> {s.label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* 未加载出资料时顶部也有返回/关闭 */}
        {!heroVisible && (
          <div className={`flex items-center justify-between px-5 py-4 border-b ${borderColor}`}>
            <div className="flex items-center gap-2 min-w-0">
              {(stack.length > 0 || initialMid) && (
                <button type="button" onClick={popStack} className={`p-1.5 rounded-lg ${textSecondary} hover:opacity-70`} title="返回上一级">
                  <ChevronLeft size={18} />
                </button>
              )}
              <h2 className={`text-lg font-bold truncate ${textPrimary}`}>{user?.name || '哔哩哔哩个人主页'}</h2>
            </div>
            <button type="button" onClick={onClose} className={`p-1.5 rounded-lg ${dark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
              <X size={18} />
            </button>
          </div>
        )}

        {!loginReady && isSelf ? (
          renderLoginGate()
        ) : (
          <>
            {/* 左侧按钮栏 + 右侧数据区（不再是上下结构） */}
            <div className="flex flex-1 min-h-0">
              <nav
                className={`flex-shrink-0 w-32 sm:w-40 border-r px-2.5 py-3 flex flex-col gap-1.5 overflow-y-auto ${borderColor}`}
                aria-label="个人中心导航"
              >
                {([
                  ['fav', '收藏夹', FolderHeart],
                  ...(isSelf ? [['history', '历史', History] as const] : []),
                  ['uploads', '投稿', Upload],
                  ['following', '关注', Users],
                ] as const).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-all border text-left ${
                      tab === key
                        ? 'text-white border-transparent bg-gradient-to-r from-pink-500 to-rose-500 shadow-md shadow-pink-500/25'
                        : `${textSecondary} border-transparent hover:bg-white/10`
                    }`}
                  >
                    <Icon size={16} className="flex-shrink-0" />
                    {label}
                  </button>
                ))}
              </nav>

              {/* 右侧内容区 */}
              <div className="flex-1 overflow-y-auto p-4">{renderTabContent()}</div>
            </div>
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

      {/* 收藏夹视频弹窗 */}
      <AnimatePresence>
        {folderModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 sm:p-10"
            onClick={(e) => {
              // 只关收藏夹子弹窗；不冒泡到个人中心根容器（否则点空白会把整个个人中心也关掉）
              e.stopPropagation()
              setFolderModal(null)
            }}
          >
            <motion.div
              initial={{ scale: 0.96, y: 14 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 14 }}
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-3xl max-h-[84vh] rounded-3xl border overflow-hidden flex flex-col shadow-2xl ${
                dark ? 'bg-[#14161f]/[0.98] border-white/10' : 'bg-white/[0.98] border-black/10'
              }`}
            >
              <div className={`flex items-center justify-between px-5 py-4 border-b ${borderColor}`}>
                <div className="flex items-center gap-2 min-w-0">
                  <button type="button" onClick={() => setFolderModal(null)} className={`p-1.5 rounded-full ${textSecondary} hover:bg-white/10 transition-colors`} title="返回">
                    <ChevronLeft size={18} />
                  </button>
                  <h3 className={`text-base font-bold truncate ${textPrimary}`}>{folderModal.title}</h3>
                  {favTotal > 0 && <span className={`text-xs ${textTertiary}`}>· {formatCount(favTotal)} 个视频</span>}
                </div>
                <button type="button" onClick={() => setFolderModal(null)} className={`p-1.5 rounded-full ${dark ? 'hover:bg-white/10 text-white/60' : 'hover:bg-black/5 text-black/50'}`}>
                  <X size={18} />
                </button>
              </div>
              <div ref={folderScrollRef} className="flex-1 overflow-y-auto p-4 relative">
                {favLoading && favVideos.length === 0 ? (
                  <SkeletonRow count={3} />
                ) : favVideos.length ? (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {favVideos.map((v) => renderVideoCard(v))}
                    </div>
                    {renderLoadMore({ loading: favLoading, count: favVideos.length, total: favTotal || favVideos.length + 1, onLoad: () => void loadMoreFav() })}
                  </>
                ) : (
                  <EmptyRow label="这个收藏夹是空的或未公开" />
                )}
                {/* 回到顶部 */}
                {favVideos.length > 8 && (
                  <button
                    type="button"
                    onClick={() => folderScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                    className="fixed bottom-6 right-8 z-[75] p-2.5 rounded-full text-white shadow-xl transition-transform hover:scale-110 bg-gradient-to-r from-pink-500 to-rose-500 shadow-pink-500/30"
                    title="回到顶部"
                  >
                    <ArrowUp size={18} />
                  </button>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

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
