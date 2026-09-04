/**
 * B 站「看歌」交互面板（右下角小电视按钮打开）
 *
 * - 点赞 / 投币 / 收藏（弹收藏夹选择）
 * - 发弹幕（当前播放时间，同步 B 站；自己发的弹幕描边框突出）
 * - 评论区：最热/最新排序、评论数、分页加载、发评论（新评论置顶）、回复、点赞、删除本人
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X, ThumbsUp, Coins, Star, Send, Trash2, Reply, LogIn, ChevronDown, ChevronRight, MessageCircle, Loader2, Check } from 'lucide-react'
import BilibiliLoginPanel from './BilibiliLoginPanel'
import DeleteCommentModal from './DeleteCommentModal'
import {
  getBilibiliInteraction,
  likeBilibiliVideo,
  coinBilibiliVideo,
  favBilibiliVideo,
  sendBilibiliDanmaku,
  getBilibiliComments,
  getBilibiliCommentReplies,
  postBilibiliComment,
  deleteBilibiliComment,
  likeBilibiliComment,
  getBilibiliView,
  isBilibiliLoggedIn,
  getBilibiliCookie,
  type BilibiliComment,
  type BilibiliInteractionState,
} from '../services/bilibiliApi'

interface BilibiliInteractPanelProps {
  bvid: string
  aid: number
  cid: number
  title: string
  author?: string
  play?: number
  danmaku?: number
  playerTheme?: 'light' | 'dark'
  getCurrentTime: () => number
  onDanmakuSent?: (text: string, time: number, mode: number, color: number) => void
  onClose: () => void
  /** 视频封面 URL（弹窗左上角展示当前歌曲封面） */
  coverUrl?: string
}

const cm = (c: BilibiliComment): string => (c.content?.message || c.message || '').trim()

const timeAgo = (ts: number): string => {
  if (!ts) return ''
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  return new Date(ts * 1000).toLocaleDateString()
}

const fmtCount = (n?: number): string => {
  if (!n) return '0'
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

type SortMode = 'hot' | 'new'

export default function BilibiliInteractPanel({
  bvid,
  aid,
  cid,
  title,
  author,
  play,
  danmaku,
  playerTheme = 'dark',
  getCurrentTime,
  onDanmakuSent,
  onClose,
  coverUrl,
}: BilibiliInteractPanelProps) {
  const dark = playerTheme !== 'light'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/65' : 'text-black/60'
  const textTertiary = dark ? 'text-white/40' : 'text-black/40'
  const bgCard = dark ? 'bg-white/[0.045]' : 'bg-black/[0.04]'
  const borderColor = dark ? 'border-white/[0.09]' : 'border-black/10'
  const inputBg = dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.05)'
  const accent = '#FB7299'
  // 内联样式必须用真实颜色值（不能用 Tailwind 类名，否则 color:'text-white/65' 非法被忽略 → 黑字）
  const pal = {
    primary: dark ? '#fff' : '#141414',
    secondary: dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.6)',
    tertiary: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
    border: dark ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)',
  }

  const [loginReady, setLoginReady] = useState(() => isBilibiliLoggedIn())
  const [showLogin, setShowLogin] = useState(false)
  const [interaction, setInteraction] = useState<BilibiliInteractionState | null>(null)
  const [coinLoading, setCoinLoading] = useState(false)
  const [likeLoading, setLikeLoading] = useState(false)
  const [favLoading, setFavLoading] = useState(false)
  const [showFavPicker, setShowFavPicker] = useState(false)
  const [desc, setDesc] = useState('')

  // 弹幕
  const [dmText, setDmText] = useState('')
  const [dmSending, setDmSending] = useState(false)
  const [dmColor, setDmColor] = useState(0xffffff)
  const [dmMode, setDmMode] = useState<1 | 4 | 5>(1)

  // 评论
  const [comments, setComments] = useState<BilibiliComment[]>([])
  const [commentsPn, setCommentsPn] = useState(1)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [commentTotal, setCommentTotal] = useState(0)
  const [sort, setSort] = useState<SortMode>('hot')
  const [commentText, setCommentText] = useState('')
  const [commentSending, setCommentSending] = useState(false)
  const [replyingTo, setReplyingTo] = useState<{ rpid: number; uname: string } | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<Record<number, BilibiliComment[]>>({})
  const [repliesLoading, setRepliesLoading] = useState<Record<number, boolean>>({})
  const [deleteTarget, setDeleteTarget] = useState<BilibiliComment | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [toast, setToast] = useState('')

  const myMidRef = useRef<number | null>(null)
  const sortRef = useRef<SortMode>('hot')
  sortRef.current = sort
  const toastTimerRef = useRef<number | null>(null)

  useEffect(() => () => { if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current) }, [])

  const showToast = useCallback((msg: string) => {
    setToast(msg)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => { toastTimerRef.current = null; setToast('') }, 2200)
  }, [])

  const myMid = useCallback((): number | null => {
    if (myMidRef.current !== null) return myMidRef.current
    const cookie = getBilibiliCookie()
    const mid = cookie ? Number(cookie.match(/DedeUserID=(\d+)/)?.[1] || 0) || null : null
    myMidRef.current = mid
    return mid
  }, [])

  const loadInteraction = useCallback(async () => {
    try {
      const res = await getBilibiliInteraction(aid)
      if (res.code === 0 && res.data) {
        setInteraction(res.data)
        setLoginReady(isBilibiliLoggedIn())
      }
    } catch { /* 静默 */ }
  }, [aid])

  const loadComments = useCallback(async (pn: number, mode: SortMode, append: boolean) => {
    setCommentsLoading(true)
    try {
      const res = await getBilibiliComments(aid, pn)
      if (res.code === 0 && Array.isArray(res.replies)) {
        const mid = myMid()
        const mapped = res.replies.map((c) => ({ ...c, isMine: Number(c.mid) === mid }))
        // 最新排序：按 ctime 倒序
        const sorted = mode === 'new' ? [...mapped].sort((a, b) => b.ctime - a.ctime) : mapped
        setComments((prev) => (append ? [...prev, ...sorted] : sorted))
        setCommentsPn(pn)
        // 评论总数（页数据未含 total 时用 rcount 汇总兜底）
        const total = res.replies.reduce((acc, c) => acc + (Number(c.rcount) || 0), 0)
        setCommentTotal((prev) => (pn === 1 ? total : Math.max(prev, total)))
      }
    } catch { /* 静默 */ } finally {
      setCommentsLoading(false)
    }
  }, [aid, myMid])

  useEffect(() => {
    void loadInteraction()
    void loadComments(1, sortRef.current, false)
    // 拉取视频简介（描述）
    void getBilibiliView(bvid).then((v) => {
      if (v.code === 0 && v.data?.desc) setDesc(v.data.desc)
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aid])

  const handleSortChange = (mode: SortMode) => {
    if (mode === sort) return
    setSort(mode)
    void loadComments(1, mode, false)
  }

  const handleLoginSuccess = useCallback(() => {
    setLoginReady(true)
    setShowLogin(false)
    showToast('已登录 B 站')
    void loadInteraction()
    void loadComments(1, sortRef.current, false)
  }, [loadInteraction, loadComments, showToast])

  // 视频点赞/取消
  const handleLike = async () => {
    if (!loginReady) { showToast('请先登录 B 站'); return }
    setLikeLoading(true)
    try {
      const next = interaction?.isLike ? 2 : 1
      const res = await likeBilibiliVideo(aid, next as 1 | 2)
      if (res.code === 0) {
        setInteraction((p) => p ? { ...p, isLike: next === 1 ? 1 : 0 } : p)
        showToast(next === 1 ? '已点赞' : '已取消点赞')
      } else {
        showToast(res.message || '点赞失败')
      }
    } finally {
      setLikeLoading(false)
    }
  }

  // 投币（1 枚，同步点赞）
  const handleCoin = async () => {
    if (!loginReady) { showToast('请先登录 B 站'); return }
    setCoinLoading(true)
    try {
      const res = await coinBilibiliVideo(aid, 1, 1)
      if (res.code === 0) {
        showToast('已投 1 枚硬币（并点赞）')
        void loadInteraction()
      } else {
        showToast(res.message || '投币失败')
      }
    } finally {
      setCoinLoading(false)
    }
  }

  // 收藏（弹出收藏夹选择）
  const handleFavClick = () => {
    if (!loginReady) { showToast('请先登录 B 站'); return }
    setShowFavPicker(true)
  }
  const handleFav = async (folderId: number) => {
    setFavLoading(true)
    setShowFavPicker(false)
    try {
      const res = await favBilibiliVideo(aid, { addMediaIds: folderId })
      if (res.code === 0) {
        setInteraction((p) => p ? { ...p, favoured: 1 } : p)
        showToast('已收藏')
      } else {
        showToast(res.message || '收藏失败')
      }
    } finally {
      setFavLoading(false)
    }
  }
  const handleUnfav = async () => {
    setFavLoading(true)
    setShowFavPicker(false)
    try {
      const res = await favBilibiliVideo(aid, { delMediaIds: 0 })
      if (res.code === 0) {
        setInteraction((p) => p ? { ...p, favoured: 0 } : p)
        showToast('已取消收藏')
      } else {
        showToast(res.message || '取消收藏失败')
      }
    } finally {
      setFavLoading(false)
    }
  }

  // 发弹幕
  const handleSendDanmaku = async () => {
    const msg = dmText.trim()
    if (!msg) return
    if (!loginReady) { showToast('请先登录 B 站'); return }
    setDmSending(true)
    try {
      const time = getCurrentTime()
      const res = await sendBilibiliDanmaku({ cid, bvid, aid, msg, progress: time, color: dmColor, mode: dmMode })
      if (res.code === 0) {
        showToast('弹幕已发送')
        onDanmakuSent?.(msg, time, dmMode, dmColor)
        setDmText('')
      } else {
        showToast(res.message || '发送弹幕失败')
      }
    } finally {
      setDmSending(false)
    }
  }

  // 发评论/回复
  const handleSendComment = async () => {
    const msg = commentText.trim()
    if (!msg) return
    if (!loginReady) { showToast('请先登录 B 站'); return }
    setCommentSending(true)
    try {
      const res = replyingTo
        ? await postBilibiliComment({ aid, message: msg, root: replyingTo.rpid, parent: replyingTo.rpid })
        : await postBilibiliComment({ aid, message: msg })
      if (res.code === 0) {
        showToast(replyingTo ? '回复已发送' : '评论已发送')
        setCommentText('')
        const replied = replyingTo
        setReplyingTo(null)
        if (replied) {
          void loadReplies(replied.rpid)
        } else {
          // 乐观置顶：把自己的评论立即插到评论区第一个（B 站 API 有缓存，刷新未必立刻包含新评论）
          const mid = myMid()
          setComments((prev) => [
            {
              rpid: Date.now(), // 临时 id（B 站 rpid 为时间戳量级，本地唯一即可）
              mid: mid || 0,
              root: 0,
              parent: 0,
              count: 0,
              rcount: 0,
              like: 0,
              action: 0,
              ctime: Math.floor(Date.now() / 1000),
              content: { message: msg },
              member: { uname: '我' },
              isMine: true,
            },
            ...prev,
          ])
          // 后台再刷新一次拿真实列表（含新评论 rpid，供后续删除）
          void loadComments(1, sortRef.current, false)
        }
      } else {
        showToast(res.message || '发送失败')
      }
    } finally {
      setCommentSending(false)
    }
  }

  // 删除评论：先弹确认框，确认后执行
  const openDeleteConfirm = (comment: BilibiliComment) => {
    setDeleteTarget(comment)
  }
  const confirmDelete = async () => {
    const target = deleteTarget
    if (!target) return
    setDeleteLoading(true)
    try {
      const res = await deleteBilibiliComment(aid, target.rpid)
      if (res.code === 0) {
        showToast('评论已删除')
        setComments((p) => p.filter((c) => c.rpid !== target.rpid && c.parent !== target.rpid))
        setExpandedReplies((p) => { const n = { ...p }; delete n[target.rpid]; return n })
        setDeleteTarget(null)
      } else {
        showToast(res.message || '删除失败')
      }
    } finally {
      setDeleteLoading(false)
    }
  }

  const handleLikeComment = async (rpid: number, liked: boolean) => {
    if (!loginReady) { showToast('请先登录 B 站'); return }
    try {
      const res = await likeBilibiliComment(aid, rpid, liked ? 2 : 1)
      if (res.code === 0) {
        setComments((p) => p.map((c) => c.rpid === rpid ? { ...c, like: c.like + (liked ? -1 : 1), action: liked ? 0 : 1 } : c))
        showToast(liked ? '已取消赞' : '已点赞')
      } else {
        showToast(res.message || '评论点赞失败')
      }
    } catch {
      showToast('评论点赞失败')
    }
  }

  const loadReplies = async (rpid: number) => {
    setRepliesLoading((p) => ({ ...p, [rpid]: true }))
    try {
      const res = await getBilibiliCommentReplies(aid, rpid)
      if (res.code === 0 && Array.isArray(res.replies)) {
        const mid = myMid()
        setExpandedReplies((p) => ({ ...p, [rpid]: res.replies!.map((c) => ({ ...c, isMine: Number(c.mid) === mid })) }))
      }
    } finally {
      setRepliesLoading((p) => ({ ...p, [rpid]: false }))
    }
  }

  const dmColors = [
    { label: '白色', value: 0xffffff },
    { label: '红色', value: 0xff0000 },
    { label: '橙色', value: 0xff8c00 },
    { label: '黄色', value: 0xffff00 },
    { label: '绿色', value: 0x00ff00 },
    { label: '蓝色', value: 0x00aaff },
    { label: '紫色', value: 0xa020f0 },
    { label: '粉色', value: 0xff69b4 },
  ]

  const favFolders = useMemo(() => interaction?.favFolders || [], [interaction])

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 pointer-events-auto">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px]" onClick={onClose} />
      <div
        className={`relative w-full max-w-2xl h-[88vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden ${borderColor}`}
        style={{
          backgroundColor: dark ? 'rgba(19,20,27,0.97)' : 'rgba(248,248,250,0.98)',
          backdropFilter: 'blur(30px) saturate(160%)',
          WebkitBackdropFilter: 'blur(30px) saturate(160%)',
        }}
      >
        {/* 头部：当前歌曲封面 */}
        <div className={`flex items-center gap-3 px-5 py-3.5 border-b shrink-0 ${borderColor}`}>
          {coverUrl ? (
            <img
              src={coverUrl.replace(/^\/\//, 'https://')}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="w-9 h-9 rounded-lg shrink-0 object-cover bg-white/10"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          ) : (
            <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#FB7299,#FCB1A0)' }}>
              哔
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className={`text-sm font-medium truncate ${textPrimary}`}>{title || 'B 站视频'}</div>
            <div className={`text-[11px] mt-0.5 truncate ${textTertiary}`}>
              {[author ? `UP：${author}` : '', play ? `${fmtCount(play)} 播放` : '', danmaku ? `${fmtCount(danmaku)} 弹幕` : ''].filter(Boolean).join(' · ')}
            </div>
            {desc && (
              <div className={`text-[11px] mt-1 leading-relaxed line-clamp-2 ${textTertiary}`}>{desc}</div>
            )}
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-white/10 transition-colors text-white/50 hover:text-white" aria-label="关闭">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* 互动区 */}
          <div className={`flex items-center gap-2 ${bgCard} rounded-xl p-2.5 border ${borderColor}`}>
            <button
              type="button"
              onClick={() => void handleLike()}
              disabled={likeLoading}
              title={interaction?.isLike ? '取消点赞' : '点赞'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
              style={interaction?.isLike
                ? { backgroundColor: accent, color: '#fff', borderColor: 'transparent' }
                : { backgroundColor: 'rgba(255,255,255,0.05)', color: pal.secondary, borderColor: pal.border }}
            >
              <ThumbsUp size={15} />
              点赞
            </button>
            <button
              type="button"
              onClick={() => void handleCoin()}
              disabled={coinLoading}
              title="投 1 枚硬币（并点赞）"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
              style={{ backgroundColor: 'rgba(251,114,153,0.13)', color: accent, borderColor: 'rgba(251,114,153,0.3)' }}
            >
              {coinLoading ? <Loader2 size={14} className="animate-spin" /> : <Coins size={15} />}
              投币{interaction && interaction.coin > 0 ? ` ×${interaction.coin}` : ''}
            </button>
            <button
              type="button"
              onClick={interaction?.favoured ? () => void handleUnfav() : handleFavClick}
              disabled={favLoading}
              title={interaction?.favoured ? '取消收藏' : '收藏到收藏夹'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
              style={interaction?.favoured
                ? { backgroundColor: '#F5C518', color: '#1a1a1a', borderColor: 'transparent' }
                : { backgroundColor: 'rgba(255,255,255,0.05)', color: pal.secondary, borderColor: pal.border }}
            >
              <Star size={15} />
              {interaction?.favoured ? '已收藏' : '收藏'}
            </button>
            {!loginReady && (
              <button
                type="button"
                onClick={() => setShowLogin(true)}
                className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
                style={{ backgroundColor: 'rgba(0,161,214,0.16)', color: '#00A1D6', borderColor: 'rgba(0,161,214,0.35)' }}
              >
                <LogIn size={14} />B 站登录
              </button>
            )}
          </div>

          {/* 发弹幕 */}
          <div className={`${bgCard} rounded-xl p-3.5 border ${borderColor}`}>
            <div className="flex items-center gap-2 mb-2.5">
              <MessageCircle size={14} style={{ color: accent }} />
              <span className={`text-xs font-medium ${textSecondary}`}>发弹幕</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                value={dmText}
                onChange={(e) => setDmText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSendDanmaku() }}
                placeholder="输入弹幕内容…"
                className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#FB7299]/60 transition-colors"
                style={{ backgroundColor: inputBg, color: pal.primary, borderColor: pal.border }}
              />
              {/* 模式选择（chip 按钮，替代原生下拉框，避免黑字不可读） */}
              <div className={`flex items-center rounded-lg border overflow-hidden shrink-0 ${borderColor}`}>
                {([1, 5, 4] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setDmMode(m)}
                    className="px-2 py-1.5 text-[11px] transition-colors"
                    style={dmMode === m ? { backgroundColor: accent, color: '#fff' } : { color: pal.secondary }}
                  >
                    {m === 1 ? '滚动' : m === 5 ? '顶部' : '底部'}
                  </button>
                ))}
              </div>
              {/* 颜色选择 */}
              <div className="flex items-center gap-1 shrink-0">
                {dmColors.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    title={c.label}
                    onClick={() => setDmColor(c.value)}
                    className="w-4 h-4 rounded-full transition-transform hover:scale-110"
                    style={{
                      backgroundColor: `#${c.value.toString(16).padStart(6, '0')}`,
                      boxShadow: dmColor === c.value ? `0 0 0 2px ${accent}` : 'none',
                      transform: dmColor === c.value ? 'scale(1.15)' : undefined,
                    }}
                  />
                ))}
              </div>
              <button
                type="button"
                onClick={() => void handleSendDanmaku()}
                disabled={dmSending || !dmText.trim()}
                className="flex items-center gap-1 px-3.5 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50 shrink-0"
                style={{ backgroundColor: accent, color: '#fff' }}
              >
                {dmSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                发送
              </button>
            </div>
          </div>

          {/* 评论区 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className={`text-sm font-semibold ${textPrimary}`}>评论</span>
              <span className={`text-[11px] ${textTertiary}`}>{fmtCount(commentTotal)}</span>
              <div className="ml-auto flex items-center rounded-lg border overflow-hidden shrink-0" style={{ borderColor: pal.border }}>
                {(['hot', 'new'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleSortChange(m)}
                    className="px-2.5 py-1 text-[11px] transition-colors"
                    style={sort === m ? { backgroundColor: accent, color: '#fff' } : { color: pal.secondary }}
                  >
                    {m === 'hot' ? '最热' : '最新'}
                  </button>
                ))}
              </div>
            </div>

            {/* 发评论 */}
            <div className={`flex items-center gap-2 mb-3 ${bgCard} rounded-xl p-2 border ${borderColor}`}>
              {replyingTo && (
                <span className={`text-[11px] px-2 py-1 rounded-full shrink-0 ${textSecondary}`} style={{ backgroundColor: 'rgba(0,161,214,0.14)' }}>
                  回复 @{replyingTo.uname}
                  <button type="button" className="ml-1.5 opacity-70 hover:opacity-100" onClick={() => setReplyingTo(null)} aria-label="取消回复">×</button>
                </span>
              )}
              <input
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSendComment() }}
                placeholder={replyingTo ? `回复 @${replyingTo.uname}…` : '发个友善的评论…'}
                className="flex-1 min-w-0 rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#FB7299]/60 transition-colors"
                style={{ backgroundColor: inputBg, color: pal.primary, borderColor: pal.border }}
              />
              <button
                type="button"
                onClick={() => void handleSendComment()}
                disabled={commentSending || !commentText.trim()}
                className="flex items-center gap-1 px-3.5 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50 shrink-0"
                style={{ backgroundColor: accent, color: '#fff' }}
              >
                {commentSending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                {replyingTo ? '回复' : '评论'}
              </button>
            </div>

            {commentsLoading && comments.length === 0 ? (
              <div className="py-10 text-center text-xs text-white/35">加载中…</div>
            ) : comments.length === 0 ? (
              <div className="py-10 text-center text-xs text-white/35">暂无评论</div>
            ) : (
              <div className="space-y-3">
                {comments.map((c) => (
                  <div key={c.rpid} className={`${bgCard} rounded-xl p-3.5 border ${borderColor}`}>
                    <div className="flex items-start gap-3">
                      {/* 头像 */}
                      <img
                        src={c.member?.avatar ? c.member.avatar.replace(/^\/\//, 'https://') : undefined}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="w-8 h-8 rounded-full shrink-0 bg-white/10 object-cover"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium ${textPrimary}`}>{c.member?.uname || '用户'}</span>
                          {c.member?.level_info?.current_level ? (
                            <span className="text-[10px] px-1 rounded" style={{ color: '#00A1D6', backgroundColor: 'rgba(0,161,214,0.12)' }}>
                              Lv{c.member.level_info.current_level}
                            </span>
                          ) : null}
                          <span className={`text-[11px] ${textTertiary}`}>{timeAgo(c.ctime)}</span>
                          {c.isMine && (
                            <span className="text-[10px] px-1 rounded" style={{ backgroundColor: 'rgba(251,114,153,0.15)', color: accent }}>我</span>
                          )}
                        </div>
                        {/* 评论正文（content.message） */}
                        <div className={`text-sm mt-1.5 break-words whitespace-pre-wrap leading-relaxed ${textPrimary}`}>{cm(c)}</div>
                        <div className="flex items-center gap-4 mt-2">
                          <button
                            type="button"
                            onClick={() => void handleLikeComment(c.rpid, c.action === 1)}
                            className="flex items-center gap-1 text-[11px] transition-colors"
                            style={c.action === 1 ? { color: accent } : { color: pal.tertiary }}
                          >
                            <ThumbsUp size={12} />{c.like > 0 ? fmtCount(c.like) : '赞'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setReplyingTo({ rpid: c.rpid, uname: c.member?.uname || '用户' })}
                            className="flex items-center gap-1 text-[11px] transition-colors"
                            style={{ color: pal.tertiary }}
                          >
                            <Reply size={12} />回复
                          </button>
                          {c.count > 0 && (
                            <button
                              type="button"
                              onClick={() => {
                                if (!expandedReplies[c.rpid]) {
                                  if (!repliesLoading[c.rpid]) void loadReplies(c.rpid)
                                  setExpandedReplies((p) => ({ ...p, [c.rpid]: p[c.rpid] || [] }))
                                } else {
                                  setExpandedReplies((p) => { const n = { ...p }; delete n[c.rpid]; return n })
                                }
                              }}
                              className="flex items-center gap-1 text-[11px] transition-colors"
                              style={{ color: pal.tertiary }}
                            >
                              {expandedReplies[c.rpid] ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              {fmtCount(c.count)} 回复
                            </button>
                          )}
                          {c.isMine && (
                            <button
                              type="button"
                              onClick={() => openDeleteConfirm(c)}
                              className="flex items-center gap-1 text-[11px] text-red-400/70 hover:text-red-400 transition-colors"
                            >
                              <Trash2 size={12} />删除
                            </button>
                          )}
                        </div>
                        {expandedReplies[c.rpid] && (
                          <div className="mt-2.5 pl-3 border-l-2 space-y-2.5" style={{ borderColor: 'rgba(251,114,153,0.25)' }}>
                            {repliesLoading[c.rpid] ? (
                              <div className="text-[11px] text-white/35">加载回复…</div>
                            ) : (expandedReplies[c.rpid] || []).length === 0 ? (
                              <div className="text-[11px] text-white/35">暂无回复</div>
                            ) : expandedReplies[c.rpid]!.map((r) => (
                              <div key={r.rpid} className="flex items-start gap-2">
                                <img
                                  src={r.member?.avatar ? r.member.avatar.replace(/^\/\//, 'https://') : undefined}
                                  alt=""
                                  loading="lazy"
                                  referrerPolicy="no-referrer"
                                  className="w-5 h-5 rounded-full shrink-0 bg-white/10 object-cover"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                                />
                                <div className="flex-1 min-w-0">
                                  <div className={`text-[11px] font-medium ${textPrimary}`}>{r.member?.uname || '用户'}</div>
                                  <div className={`text-xs mt-0.5 break-words ${textSecondary}`}>{cm(r)}</div>
                                </div>
                                {r.isMine && (
                                  <button type="button" onClick={() => openDeleteConfirm(r)} className="text-red-400/70 hover:text-red-400 shrink-0">
                                    <Trash2 size={11} />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => void loadComments(commentsPn + 1, sortRef.current, true)}
                  disabled={commentsLoading}
                  className="w-full py-2.5 rounded-xl text-xs font-medium transition-colors border disabled:opacity-50"
                  style={{ color: pal.secondary, borderColor: pal.border, backgroundColor: 'rgba(255,255,255,0.03)' }}
                >
                  {commentsLoading ? '加载中…' : '加载更多评论'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* toast */}
        {toast && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full text-xs text-white shadow-lg z-20"
            style={{ backgroundColor: 'rgba(0,0,0,0.78)' }}>
            {toast}
          </div>
        )}

        {/* 收藏夹选择弹层 */}
        {showFavPicker && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/50" onClick={() => setShowFavPicker(false)}>
            <div className="w-72 rounded-2xl border border-white/10 bg-[#1a1b23] p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="text-white text-sm font-medium mb-3 flex items-center gap-2">
                <Star size={15} style={{ color: '#F5C518' }} /> 收藏到收藏夹
              </div>
              <div className="space-y-1.5 max-h-64 overflow-y-auto">
                {favFolders.length === 0 && (
                  <div className="text-xs text-white/40 px-1 py-2">暂无收藏夹，将使用默认收藏夹</div>
                )}
                {favFolders.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => void handleFav(f.id)}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm text-white/85 hover:bg-white/10 transition-colors"
                  >
                    <Star size={13} style={{ color: '#F5C518' }} />
                    {f.name}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => void handleFav(0)}
                className="mt-2 w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ backgroundColor: 'rgba(251,114,153,0.15)', color: '#FB7299' }}
              >
                <Check size={13} /> 使用默认收藏夹
              </button>
            </div>
          </div>
        )}

        {/* 登录覆盖层 */}
        {showLogin && (
          <div className="absolute inset-0 z-40 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60" onClick={() => setShowLogin(false)} />
            <div className="relative w-80 rounded-2xl border border-white/10 bg-[#14161d] p-6 shadow-2xl">
              <BilibiliLoginPanel onClose={() => setShowLogin(false)} onLoginSuccess={handleLoginSuccess} />
            </div>
          </div>
        )}

        {/* 删除评论确认弹窗（复用音乐评论区同款） */}
        <DeleteCommentModal
          show={Boolean(deleteTarget)}
          loading={deleteLoading}
          onClose={() => { if (!deleteLoading) setDeleteTarget(null) }}
          onConfirm={() => void confirmDelete()}
        />
      </div>
    </div>
  )
}
