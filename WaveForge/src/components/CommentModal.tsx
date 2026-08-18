import { useState, useEffect, useRef, useCallback, useMemo, memo, type ReactElement } from 'react'
import { List, useDynamicRowHeight, type ListImperativeAPI, type RowComponentProps } from 'react-window'
import { motion, AnimatePresence } from 'framer-motion'
import { Song } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { getProxiedImageUrl } from '../services/musicApi'
import { ThumbsUp, MessageCircle, Trash2, Send, ChevronDown, Edit3 } from 'lucide-react'
import ScrollToTop from './ScrollToTop'
import DeleteCommentModal from './DeleteCommentModal'

interface PlaylistCommentResource {
  id: number | string
  name: string
  coverImgUrl?: string
  description?: string
  desc?: string
  creator?: { userId?: number | string; nickname?: string; avatarUrl?: string }
  tags?: string[]
  createTime?: number
  commentCount?: number
  platform?: MusicPlatform
}

interface CommentModalProps {
  isOpen: boolean
  onClose: () => void
  song?: Song | null
  playlist?: PlaylistCommentResource | null
  resourceType?: 'song' | 'playlist'
}

interface Reply {
  replyId: string
  content: string
  user: {
    nickname: string
    avatarUrl: string
    userId?: string
  }
  time: number
  beRepliedUser?: string
}

interface Comment {
  commentId: string
  content: string
  user: {
    nickname: string
    avatarUrl: string
    userId?: string
  }
  time: number
  likedCount: number
  replyCount: number
  replies?: Reply[]
  isLiked?: boolean
  isOwn?: boolean
  replyPage?: number
  hasMoreReplies?: boolean
}

type ViewMode = 'hot' | 'latest'

function normalizeDescriptionText(value?: string): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/&nbsp;|&#0*160;?|&#x0*a0;?/gi, ' ')
    .replace(/&#(\d+);?/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);?/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function mapQQComments(rawComments: any[]): Comment[] {
  const commentMap = new Map<string, Comment>()

  rawComments.forEach((raw) => {
    const rootId = String(raw.rootcommentid || raw.commentid || raw.time || '')
    if (!rootId) return

    const isReplyEnvelope = Boolean(raw.commentid && raw.rootcommentid && raw.commentid !== raw.rootcommentid)
    const middleReplies = Array.isArray(raw.middlecommentcontent) ? raw.middlecommentcontent : []
    const mappedReplies: Reply[] = middleReplies.map((reply: any) => ({
      replyId: String(reply.subcommentid || raw.commentid || `${rootId}-${reply.replynick || ''}`),
      content: reply.subcommentcontent || '',
      user: {
        nickname: String(reply.replynick || raw.nick || '匿名用户').replace(/^@/, ''),
        avatarUrl: isReplyEnvelope ? String(raw.avatarurl || '').replace(/^http:/, 'https:') : '',
        userId: reply.encrypt_replyuin || reply.replyuin || raw.encrypt_uin || ''
      },
      time: Number(raw.time || 0) * 1000,
      beRepliedUser: String(reply.replyednick || raw.rootcommentnick || '').replace(/^@/, '') || undefined
    }))

    const existing = commentMap.get(rootId)
    if (existing) {
      const knownReplyIds = new Set(existing.replies?.map(reply => reply.replyId) || [])
      existing.replies = [
        ...(existing.replies || []),
        ...mappedReplies.filter(reply => !knownReplyIds.has(reply.replyId))
      ]
      existing.replyCount = existing.replies.length
      existing.time = Math.max(existing.time, Number(raw.time || 0) * 1000)
      return
    }

    commentMap.set(rootId, {
      commentId: rootId,
      content: raw.rootcommentcontent || '',
      user: {
        nickname: String(isReplyEnvelope ? raw.rootcommentnick : raw.nick || '匿名用户').replace(/^@/, ''),
        // 回复包中的 avatarurl 属于回复者，不能错误地展示成主评论头像。
        avatarUrl: isReplyEnvelope ? '' : String(raw.avatarurl || '').replace(/^http:/, 'https:'),
        userId: isReplyEnvelope
          ? (raw.encrypt_rootcommentuin || raw.rootcommentuin || '')
          : (raw.encrypt_uin || raw.uin || '')
      },
      time: Number(raw.time || 0) * 1000,
      likedCount: Number(raw.praisenum || 0),
      replyCount: mappedReplies.length,
      replies: mappedReplies,
      isLiked: Number(raw.ispraise) === 1,
      isOwn: Number(raw.root_enable_delete ?? raw.enable_delete) === 1
    })
  })

  return Array.from(commentMap.values())
}

function isQQCommentMutationSuccessful(result: any): boolean {
  const message = String(
    result?.error || result?.message || result?.errMsg ||
    result?.data?.error || result?.data?.message || result?.data?.errMsg || ''
  )
  if (/失败|invalid|error|过期|失效/i.test(message)) return false
  if (/成功/.test(message)) return true
  return [result?.result, result?.code, result?.data?.result, result?.data?.code]
    .some(value => value === 0 || value === 100 || value === 200)
}

function formatTime(timestamp: number) {
  if (!timestamp || isNaN(timestamp)) return '未知时间'

  const date = new Date(timestamp)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 0) return '刚刚'

  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const months = Math.floor(days / 30)
  const years = Math.floor(days / 365)

  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  if (hours < 24) return `${hours}小时前`
  if (days < 30) return `${days}天前`
  if (months < 12) return `${months}个月前`
  return `${years}年前`
}

// 挂载动画只作用于首屏 N 条评论，避免每条评论都重复创建 framer-motion 入场动画
const COMMENT_ANIMATE_LIMIT = 20

interface CommentItemProps {
  comment: Comment
  index: number
  expanded: boolean
  isLoggedIn: boolean
  canDelete: boolean
  onLike: (comment: Comment) => void
  onReply: (comment: Comment) => void
  onDelete: (comment: Comment) => void
  onToggleReplies: (comment: Comment) => void
}

// 独立 memo 组件：点赞/删除/展开回复时只有目标评论的对象引用变化，
// 其余行的 comment prop 引用不变，可跳过重渲染（避免整表重建）。
const CommentItem = memo(function CommentItem({
  comment, index, expanded, isLoggedIn, canDelete,
  onLike, onReply, onDelete, onToggleReplies,
}: CommentItemProps) {
  const shouldAnimate = index < COMMENT_ANIMATE_LIMIT
  const visibleReplies = expanded ? comment.replies : comment.replies?.slice(0, 1)

  return (
    <motion.div
      {...(shouldAnimate ? { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 } } : {})}
      className="p-4 hover:bg-white/3 transition-colors"
    >
      <div className="flex items-start space-x-3">
        <img
          src={comment.user.avatarUrl ? `http://localhost:3001/api/proxy-image?url=${encodeURIComponent(comment.user.avatarUrl)}` : ''}
          alt={comment.user.nickname}
          className="w-10 h-10 rounded-full object-cover flex-shrink-0"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            target.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="40" height="40"%3E%3Crect fill="%23374151" width="40" height="40"/%3E%3Ctext x="50%25" y="50%25" text-anchor="middle" dy=".3em" fill="%239CA3AF" font-size="16"%3E?%3C/text%3E%3C/svg%3E';
          }}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline space-x-2 mb-1">
            <span className="text-sm font-medium text-blue-400">
              {comment.user.nickname}
            </span>
            <span className="text-xs text-gray-500">
              {formatTime(comment.time)}
            </span>
          </div>
          <p className="text-sm text-gray-200 leading-relaxed mb-3">
            {comment.content}
          </p>

          {/* 操作按钮 */}
          <div className="flex items-center space-x-4 text-xs">
            {isLoggedIn && (
              <button
                onClick={() => onLike(comment)}
                className={`flex items-center space-x-1 transition-colors ${
                  comment.isLiked ? 'text-pink-400' : 'text-gray-400 hover:text-pink-400'
                }`}
              >
                <ThumbsUp className={`w-4 h-4 ${comment.isLiked ? 'fill-current' : ''}`} />
                <span>{comment.likedCount > 0 ? comment.likedCount : '赞'}</span>
              </button>
            )}

            {!isLoggedIn && (
              <div className="flex items-center space-x-1 text-gray-400">
                <ThumbsUp className="w-4 h-4" />
                <span>{comment.likedCount > 0 ? comment.likedCount : '赞'}</span>
              </div>
            )}

            {isLoggedIn && (
              <button
                onClick={() => onReply(comment)}
                className="flex items-center space-x-1 text-gray-400 hover:text-blue-400 transition-colors"
              >
                <MessageCircle className="w-4 h-4" />
                <span>回复</span>
              </button>
            )}

            {canDelete && isLoggedIn && (
              <button
                onClick={() => onDelete(comment)}
                className="flex items-center space-x-1 text-gray-400 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
                <span>删除</span>
              </button>
            )}
          </div>

          {/* 回复列表 */}
          {comment.replyCount > 0 && (
            <div className="mt-3 bg-white/5 rounded-lg p-3">
              {comment.replies && comment.replies.length > 0 && (
                <div className="space-y-2">
                  {visibleReplies?.map((reply) => (
                    <div key={reply.replyId} className="text-sm">
                      <span className="text-blue-400">{reply.user.nickname}</span>
                      {reply.beRepliedUser && (
                        <>
                          <span className="text-gray-500 mx-1">回复</span>
                          <span className="text-blue-400">{reply.beRepliedUser}</span>
                        </>
                      )}
                      <span className="text-gray-500">: </span>
                      <span className="text-gray-300">{reply.content}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* 展开当前接口已经返回的楼中楼回复。 */}
              {comment.replyCount > 1 && (
                <button
                  onClick={() => onToggleReplies(comment)}
                  className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                >
                  {expanded ? '收起回复' : `查看${comment.replyCount}条回复`}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  )
})

// ===== 评论虚拟化 =====
// 评论行高可变（内容行数、展开楼中楼回复、回复输入框），采用扁平行数组 +
// useDynamicRowHeight（ResizeObserver 实测行高）。行类型涵盖：热评段标题、
// 热评、分隔线、全部评论标题、普通评论、加载更多按钮、没有更多提示。
type CommentRow =
  | { kind: 'hot-header' }
  | { kind: 'hot-comment'; comment: Comment; index: number }
  | { kind: 'divider' }
  | { kind: 'all-header' }
  | { kind: 'comment'; comment: Comment; index: number }
  | { kind: 'load-more' }
  | { kind: 'no-more' }

type CommentRowData = {
  rows: CommentRow[]
  expandedReplies: Set<string>
  isLoggedIn: boolean
  currentUserId: string
  isPlaylistResource: boolean
  onLike: (comment: Comment) => void
  onReply: (comment: Comment) => void
  onDelete: (comment: Comment) => void
  onToggleReplies: (comment: Comment) => void
  isLoadingMore: boolean
  onLoadMore: () => void
}

// 虚拟行：按 kind 渲染；评论行复用已 memo 的 CommentItem（点赞/删除/展开仅目标行重渲染）。
function CommentVirtualRow({ index, style, ...data }: RowComponentProps<CommentRowData>): ReactElement | null {
  const row = data.rows[index]
  if (!row) return null
  if (row.kind === 'comment' || row.kind === 'hot-comment') {
    const comment = row.comment
    return (
      <div style={style}>
        <CommentItem
          comment={comment}
          index={row.index}
          expanded={data.expandedReplies.has(comment.commentId)}
          isLoggedIn={data.isLoggedIn}
          canDelete={Boolean(comment.isOwn || (data.currentUserId && comment.user.userId === data.currentUserId))}
          onLike={data.onLike}
          onReply={data.onReply}
          onDelete={data.onDelete}
          onToggleReplies={data.onToggleReplies}
        />
      </div>
    )
  }
  if (row.kind === 'hot-header') {
    return (
      <div style={style} className="flex items-center gap-2 px-2 py-3 text-gray-400 text-sm border-b border-white/5">
        <span className="text-yellow-500">★</span>
        <span>精彩评论</span>
      </div>
    )
  }
  if (row.kind === 'divider') {
    return <div style={style} className="border-t border-white/5 my-3" />
  }
  if (row.kind === 'all-header') {
    return (
      <div style={style} className="flex items-center gap-2 px-2 py-2 text-gray-400 text-sm">
        <span>全部评论</span>
      </div>
    )
  }
  if (row.kind === 'load-more') {
    return (
      <div style={style} className="flex items-center justify-center py-6">
        <button
          onClick={data.onLoadMore}
          disabled={data.isLoadingMore}
          className="px-6 py-2.5 bg-white/10 hover:bg-white/20 backdrop-blur-sm text-white rounded-full transition-all flex items-center space-x-2 border border-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {data.isLoadingMore ? (
            <>
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              <span>加载中...</span>
            </>
          ) : (
            <>
              <span>加载更多评论</span>
              <ChevronDown className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    )
  }
  // no-more
  return (
    <div style={style} className="flex items-center justify-center py-6 text-gray-500 text-sm">
      没有更多评论了
    </div>
  )
}

export default function CommentModal({ isOpen, onClose, song = null, playlist = null, resourceType = 'song' }: CommentModalProps) {
  const isPlaylistResource = resourceType === 'playlist'
  const resourcePlatform = isPlaylistResource ? (playlist?.platform || 'netease') : (song?.platform || 'netease')
  // QQ 评论接口的 topid 使用数字 songid，不是歌曲 MID。
  const resourceId = isPlaylistResource ? playlist?.id : song?.id
  const commentType = isPlaylistResource ? 2 : 0
  const qqCommentBizType = isPlaylistResource ? 3 : 1
  const resourceCoverUrl = isPlaylistResource ? (playlist?.coverImgUrl || '') : (song?.album?.picUrl || '')
  const resourceName = isPlaylistResource ? (playlist?.name || '歌单详情') : (song?.name || '')
  const resourceSubtitle = isPlaylistResource
    ? (playlist?.creator?.nickname || (resourcePlatform === 'qq' ? 'QQ音乐歌单' : '网易云歌单'))
    : (song?.artists?.map((artist: any) => artist.name).join('、') || '')
  const playlistDescription = normalizeDescriptionText(playlist?.description || playlist?.desc) || '当前歌单暂无简介'
  const [allComments, setAllComments] = useState<Comment[]>([])
  const [hotComments, setHotComments] = useState<Comment[]>([])

  // 自动加载更多 refs（在变量声明后同步）
  const hasMoreCommentsRef = useRef(false)
  const isLoadingMoreRef = useRef(false)
  const loadingRef = useRef(false)
  const loadCommentsRef = useRef<(reset?: boolean) => Promise<void>>(async () => {})
  // rAF 合并滚动续页检查：滚动事件高频触发，这里只在下一帧执行一次判定
  const scrollCheckFrameRef = useRef<number | null>(null)
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (!hasMoreCommentsRef.current || isLoadingMoreRef.current || loadingRef.current) return
    if (scrollCheckFrameRef.current !== null) return
    scrollCheckFrameRef.current = window.requestAnimationFrame(() => {
      scrollCheckFrameRef.current = null
      const container = scrollContainerRef.current
      if (!container) return
      if (!hasMoreCommentsRef.current || isLoadingMoreRef.current || loadingRef.current) return
      if (container.scrollHeight - container.scrollTop - container.clientHeight < 200) {
        loadCommentsRef.current(false)
      }
    })
  }, [])

  // 卸载时取消尚未执行的滚动续页 rAF 帧
  useEffect(() => () => {
    if (scrollCheckFrameRef.current !== null) {
      cancelAnimationFrame(scrollCheckFrameRef.current)
      scrollCheckFrameRef.current = null
    }
  }, [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionSuccess, setActionSuccess] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [commentRefreshKey, setCommentRefreshKey] = useState(0)
  const [pendingDeleteComment, setPendingDeleteComment] = useState<Comment | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('hot')
  const [showAllHot, setShowAllHot] = useState(false)
  const [newComment, setNewComment] = useState('')
  const [replyingTo, setReplyingTo] = useState<{ commentId: string, username: string } | null>(null)
  const [expandedReplies, setExpandedReplies] = useState<Set<string>>(new Set())
  const [showCommentInput, setShowCommentInput] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const scrollSentinelRef = useRef<HTMLDivElement>(null)
  
  // 分页相关状态
  const [currentPage, setCurrentPage] = useState(0)
  const [hasMoreComments, setHasMoreComments] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [cursor, setCursor] = useState<string>('-1') // 网易云时间排序首屏使用 -1，后续使用服务端 cursor
  
  // 获取登录状态和cookie
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [userCookie, setUserCookie] = useState('')
  const [currentUserId, setCurrentUserId] = useState<string>('')
  
  // 检查登录状态并获取用户ID
  useEffect(() => {
    const getUserInfo = async () => {
      if (resourcePlatform === 'netease') {
        const neteaseCookie = localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
        setUserCookie(neteaseCookie)
        setIsLoggedIn(!!neteaseCookie)
        
        // 获取当前用户ID
        if (neteaseCookie) {
          try {
            const res = await fetch(`http://localhost:3001/api/netease/user/account?cookie=${encodeURIComponent(neteaseCookie)}`)
            const data = await res.json()
            if (data.profile?.userId) {
              setCurrentUserId(data.profile.userId.toString())
            }
          } catch (error) {
            console.error('获取用户信息失败:', error)
          }
        }
      } else if (resourcePlatform === 'qq') {
        const qqCookie = localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
        setUserCookie(qqCookie)
        setIsLoggedIn(!!qqCookie)
        
        // QQ音乐获取用户ID
        if (qqCookie) {
          try {
            const res = await fetch('http://localhost:3001/api/qq/user/setCookie', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: qqCookie })
            })
            const data = await res.json()
            if (data.result === 100 && data.data?.uin) {
              setCurrentUserId(data.data.uin)
            }
          } catch (error) {
            console.error('获取QQ用户信息失败:', error)
          }
        }
      }
    }
    
    getUserInfo()
  }, [resourcePlatform])

  useEffect(() => {
    if (!currentUserId) return
    setAllComments(previous => previous.map(comment => ({
      ...comment,
      isOwn: comment.user.userId === currentUserId
    })))
  }, [currentUserId])
  
  // 模拟当前用户信息
  const currentUser = {
    nickname: '我',
    avatarUrl: 'http://localhost:3001/api/proxy-image?url=' + encodeURIComponent('https://p1.music.126.net/VnZiScyynLG7atLIZ2YPkw==/18686200114669622.jpg')
  }

  useEffect(() => {
    if (isOpen && resourceId) {
      setCurrentPage(0)
      setHasMoreComments(true)
      setCursor('-1') // 重置cursor
      setShowCommentInput(false) // 关闭评论输入框
      setNewComment('') // 清空评论内容
      setReplyingTo(null) // 清空回复状态
      loadComments(true)
    }
  }, [isOpen, resourceId, viewMode, userCookie, commentRefreshKey])

  // 同步加载更多 refs
  useEffect(() => {
    hasMoreCommentsRef.current = hasMoreComments
    isLoadingMoreRef.current = isLoadingMore
    loadingRef.current = loading
    loadCommentsRef.current = loadComments
  })

  const loadComments = async (reset = false) => {
    if (!resourceId) return
    // Apple 无公开评论接口：不请求平台评论
    if (resourcePlatform === 'apple') {
      setLoading(false)
      setIsLoadingMore(false)
      setError(null)
      return
    }
    
    if (reset) {
      setLoading(true)
      setAllComments([])
      setCurrentPage(0)
    } else {
      setIsLoadingMore(true)
    }
    
    setError(null)
    
    try {
      const platform = resourcePlatform
      const songId = resourceId
      const pageToLoad = reset ? 0 : currentPage + 1
      const limit = 20
      const offset = pageToLoad * limit
      
      // 网易云音乐: sortType 99=推荐排序, 2=热度排序, 3=时间排序
      const sortType = viewMode === 'hot' ? 2 : 3
      
      // 构建请求URL
      let endpoint = ''
      if (platform === 'netease') {
        // 最新评论使用cursor分页，精彩评论使用offset分页
        if (viewMode === 'latest') {
          const cursorToUse = reset ? '-1' : cursor
          endpoint = `http://localhost:3001/api/netease/comment/music?id=${encodeURIComponent(String(songId))}&limit=${limit}&offset=${offset}&sortType=${sortType}&cursor=${cursorToUse}&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
        } else {
          endpoint = `http://localhost:3001/api/netease/comment/music?id=${encodeURIComponent(String(songId))}&limit=${limit}&offset=${offset}&sortType=${sortType}&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
        }
      } else {
        endpoint = `http://localhost:3001/api/qq/comment?id=${encodeURIComponent(String(songId))}&pagenum=${pageToLoad}&pagesize=${limit}&type=${viewMode}&biztype=${qqCommentBizType}&cookie=${encodeURIComponent(userCookie)}`
      }
      
      console.log(`[评论加载] 平台: ${platform}, 歌曲ID: ${songId}, 页码: ${pageToLoad}`)
      
      const response = await fetch(endpoint)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const data = await response.json()
      
      let comments: Comment[] = []
      
      if (platform === 'netease') {
        if (data.code === 200) {
          // 新版API返回的数据在 data.comments 中
          const sourceComments = data.data?.comments || []
          
          // 网易云热评（精彩评论）单独展示
          if (data.data?.hotComments && Array.isArray(data.data.hotComments)) {
            setHotComments(data.data.hotComments.map((c: any) => ({
              commentId: c.commentId,
              content: c.content,
              user: {
                nickname: c.user?.nickname || '匿名用户',
                avatarUrl: c.user?.avatarUrl || '',
                userId: c.user?.userId?.toString()
              },
              time: c.time,
              likedCount: c.likedCount || 0,
              rootCommentId: c.beReplied?.[0]?.beRepliedCommentId,
              replyCount: 0,
              replies: []
            })).filter(Boolean))
          }
          
          // 保存cursor用于下次加载（仅最新评论需要）
          if (viewMode === 'latest' && data.data?.cursor) {
            setCursor(String(data.data.cursor))
          }
          
          // 检查是否还有更多评论
          const hasMore = data.data?.hasMore || false
          if (!hasMore) {
            setHasMoreComments(false)
          }
          
          comments = sourceComments.map((c: any) => ({
            commentId: c.commentId,
            content: c.content,
            user: {
              nickname: c.user?.nickname || '匿名用户',
              avatarUrl: c.user?.avatarUrl || '',
              userId: c.user?.userId?.toString()
            },
            time: c.time,
            likedCount: c.likedCount || 0,
            replyCount: c.showFloorComment?.replyCount || 0,
            // 网易云API默认不返回回复内容，需要单独请求
            replies: [],
            isLiked: c.liked || false,
            isOwn: currentUserId && c.user?.userId ? c.user.userId.toString() === currentUserId : false
          }))
          
          // 对于有回复的评论，自动加载前2条回复作为预览
          const commentsWithReplies = comments.filter(c => c.replyCount > 0)
          if (commentsWithReplies.length > 0) {
            // 并行加载所有有回复的评论的楼中楼数据
            const replyPromises = commentsWithReplies.map(async (comment) => {
              try {
                const floorResponse = await fetch(
                  `http://localhost:3001/api/netease/comment/floor?id=${encodeURIComponent(String(songId))}&parentCommentId=${comment.commentId}&limit=2&type=${commentType}&cookie=${encodeURIComponent(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || '')}`
                )
                if (floorResponse.ok) {
                  const floorData = await floorResponse.json()
                  if (floorData.code === 200 && floorData.data?.comments) {
                    return {
                      commentId: comment.commentId,
                      replies: floorData.data.comments.map((r: any) => ({
                        replyId: r.commentId,
                        content: r.content,
                        user: {
                          nickname: r.user?.nickname || '匿名用户',
                          avatarUrl: r.user?.avatarUrl || ''
                        },
                        time: r.time,
                        beRepliedUser: r.beReplied?.[0]?.user?.nickname
                      }))
                    }
                  }
                }
              } catch (error) {
                console.error(`[加载回复预览] 评论${comment.commentId}失败:`, error)
              }
              return null
            })
            
            const replyResults = await Promise.all(replyPromises)
            
            // 更新评论的回复数据
            replyResults.forEach(result => {
              if (result) {
                const commentIndex = comments.findIndex(c => c.commentId === result.commentId)
                if (commentIndex !== -1) {
                  comments[commentIndex].replies = result.replies
                }
              }
            })
          }
        }
      } else {
        // QQ音乐
        console.log('[QQ音乐评论] 原始数据:', JSON.stringify(data, null, 2))
        
        if (data.result === 0 && data.data) {
          const rawComments = data.data.comments || []
          console.log('[QQ音乐评论] 评论数组:', rawComments)
          
          if (rawComments.length > 0) {
            // QQ 的 middlecommentcontent 是回复数组，并非独立的扁平评论项。
            comments = mapQQComments(rawComments)
            
            // 如果是最新评论，按时间降序排序
            if (viewMode === 'latest') {
              comments.sort((a, b) => b.time - a.time)
            }
            
            console.log('[QQ音乐评论] 处理后的评论:', comments)
          }
          
          // QQ 评论：热评模式下 hotComments 是精选热评，comments 是全部评论；最新模式下 hotComments 是附带的热评
          if (platform === 'qq') {
            if (data.data?.hotComments && data.data.hotComments.length > 0) {
              const hotRaw = data.data.hotComments
              const hotMapped = Array.isArray(hotRaw) ? mapQQComments(hotRaw) : []
              setHotComments(hotMapped)
            } else {
              setHotComments([])
            }
          } else {
            setHotComments([])
          }
          
          // 设置hasMore
          setHasMoreComments(data.data.hasMore || false)
        } else {
          console.log('[QQ音乐评论] 无效的响应数据')
        }
      }
      
      if (comments.length === 0 && reset) {
        setHasMoreComments(false)
        setAllComments([])
        return
      }
      
      // 更新评论列表
      if (reset) {
        setAllComments(viewMode === 'latest' ? [...comments].sort((a, b) => b.time - a.time) : comments)
        window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
      } else {
        setAllComments(prev => {
          const merged = new Map(prev.map(comment => [comment.commentId, comment]))
          comments.forEach(comment => merged.set(comment.commentId, comment))
          const next = Array.from(merged.values())
          return viewMode === 'latest' ? next.sort((a, b) => b.time - a.time) : next
        })
      }
      
      setCurrentPage(pageToLoad)
      
    } catch (err) {
      console.error('加载评论失败:', err)
      setError('加载评论失败，请重试')
    } finally {
      if (reset) {
        setLoading(false)
      } else {
        setIsLoadingMore(false)
      }
    }
  }

  // 获取当前视图的评论列表
  const getDisplayComments = () => {
    // 新版API已经在服务端进行了排序，直接返回
    return allComments
  }

  const displayComments = getDisplayComments()

  // ===== 评论虚拟化：扁平行数组 + 动态行高 =====
  const commentRows = useMemo<CommentRow[]>(() => {
    const rows: CommentRow[] = []
    // 热评区网易云/QQ 共用：热评展示在顶部，下方是全部评论
    if (hotComments.length > 0) {
      rows.push({ kind: 'hot-header' })
      hotComments.forEach((comment, index) => rows.push({ kind: 'hot-comment', comment, index }))
      rows.push({ kind: 'divider' }, { kind: 'all-header' })
    }
    displayComments.forEach((comment, index) => rows.push({ kind: 'comment', comment, index }))
    if (hasMoreComments && !loading) rows.push({ kind: 'load-more' })
    else if (!hasMoreComments && displayComments.length > 0) rows.push({ kind: 'no-more' })
    return rows
  }, [hotComments, displayComments, hasMoreComments, loading])

  // 变高行：ResizeObserver 实测每行高度；估算值用于首帧定位
  const dynamicRowHeight = useDynamicRowHeight({ defaultRowHeight: 96 })
  // 评论列表虚拟化后 List 外层 div 即滚动容器，同步给 scrollContainerRef
  // （供续页判断与 ScrollToTop 使用）
  const commentListRef = useRef<ListImperativeAPI | null>(null)
  const commentOuterRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (isOpen && !loading && !error) {
      const listEl = commentListRef.current?.element ?? null
      if (listEl) scrollContainerRef.current = listEl
    }
    return () => {
      scrollContainerRef.current = commentOuterRef.current
    }
  }, [isOpen, loading, error, commentRows.length])

  // 点赞评论
  const handleLike = async (commentId: string) => {
    if (!isLoggedIn) {
      setActionError('请先登录后再进行点赞操作')
      return
    }

    const comment = allComments.find(c => c.commentId === commentId)
    if (!comment) return

    const newLikeState = !comment.isLiked

    try {
      const platform = resourcePlatform
      
      if (platform === 'netease') {
        const response = await fetch('http://localhost:3001/api/netease/comment/like', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            commentId: commentId,
            like: newLikeState,
            cookie: userCookie
          })
        })

        const result = await response.json()
        
        if (response.ok && result.code === 200) {
          // 点赞成功，仅更新目标评论（其余行的 comment 引用不变，避免整表重建）
          setAllComments(previous => previous.map(c => (
            c.commentId === commentId
              ? { ...c, isLiked: newLikeState, likedCount: newLikeState ? c.likedCount + 1 : c.likedCount - 1 }
              : c
          )))
        } else {
          setActionError('点赞操作失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐
        const response = await fetch('http://localhost:3001/api/qq/comment/like', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            commentId: commentId,
            like: newLikeState,
            cookie: userCookie
          })
        })

        const result = await response.json()
        
        if (isQQCommentMutationSuccessful(result)) {
          // 点赞成功，仅更新目标评论（其余行的 comment 引用不变，避免整表重建）
          setAllComments(previous => previous.map(c => (
            c.commentId === commentId
              ? { ...c, isLiked: newLikeState, likedCount: newLikeState ? c.likedCount + 1 : c.likedCount - 1 }
              : c
          )))
        } else {
          setActionError('点赞操作失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('点赞操作失败:', error)
      setActionError('点赞操作失败，请重试')
    }
  }

  // 删除评论
  const handleDelete = async (commentId: string) => {
    setDeleteLoading(true)
    setActionError(null)
    setActionSuccess(null)
    try {
      const platform = resourcePlatform
      
      if (platform === 'netease') {
        // 调用网易云API删除评论
        const response = await fetch('http://localhost:3001/api/netease/comment/delete', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            commentId: commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          // 删除成功，立即从列表中移除
          setAllComments(previous => previous.filter(c => c.commentId !== commentId))
          setPendingDeleteComment(null)
        } else {
          setActionError('删除评论失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐删除评论API
        const response = await fetch('http://localhost:3001/api/qq/comment/del', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            commentId: commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (isQQCommentMutationSuccessful(result)) {
          // 删除成功，立即从列表中移除
          setAllComments(previous => previous.filter(c => c.commentId !== commentId))
          setPendingDeleteComment(null)
        } else {
          setActionError('删除评论失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('删除评论失败:', error)
      setActionError('删除评论失败，请重试')
    } finally {
      setDeleteLoading(false)
    }
  }

  const finishCommentMutation = (message: string) => {
    setNewComment('')
    setReplyingTo(null)
    setShowCommentInput(false)
    setActionError(null)
    setActionSuccess(message)
    setViewMode('latest')
    window.requestAnimationFrame(() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' }))
    // 等平台完成评论索引后，再由最新视图自己的闭包刷新，避免旧的“精彩评论”请求覆盖列表。
    window.setTimeout(() => setCommentRefreshKey(value => value + 1), 900)
    window.setTimeout(() => setActionSuccess(null), 3500)
  }

  // 发布评论
  const handleSubmitComment = async () => {
    if (!newComment.trim()) return

    if (!isLoggedIn) {
      setActionError('请先登录后再发表评论')
      return
    }

    setActionError(null)
    setActionSuccess(null)
    setIsSubmitting(true)
    try {
      const platform = resourcePlatform
      
      if (platform === 'netease') {
        // 调用网易云API发布评论
        const response = await fetch('http://localhost:3001/api/netease/comment/add', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            content: newComment,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          finishCommentMutation('评论发表成功，已切换到最新评论')
        } else {
          setActionError('评论发布失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ音乐发布评论API
        const response = await fetch('http://localhost:3001/api/qq/comment/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            content: newComment,
            biztype: qqCommentBizType,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (isQQCommentMutationSuccessful(result)) {
          finishCommentMutation('评论发表成功，已切换到最新评论')
        } else {
          setActionError('评论发布失败：' + (result.error || result.message || '未知错误'))
        }
      }
    } catch (error) {
      console.error('发布评论失败:', error)
      setActionError(error instanceof Error ? error.message : '发布评论失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }

  // 回复评论
  const handleReply = async (commentId: string) => {
    if (!newComment.trim()) return

    if (!isLoggedIn) {
      setActionError('请先登录后再回复评论')
      return
    }

    setActionError(null)
    setActionSuccess(null)
    setIsSubmitting(true)
    try {
      const platform = resourcePlatform
      
      if (platform === 'netease') {
        // 调用网易云API回复评论
        const response = await fetch('http://localhost:3001/api/netease/comment/reply', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            id: resourceId,
            type: commentType,
            content: newComment,
            commentId: commentId,
            cookie: userCookie
          })
        })

        const result = await response.json()

        if (response.ok && result.code === 200) {
          finishCommentMutation('回复发表成功，已切换到最新评论')
        } else {
          setActionError('回复发布失败：' + (result.message || result.error || '未知错误'))
        }
      } else {
        // QQ 回复与顶级评论共用接口，但必须携带根评论和父评论 ID 才能形成楼中楼。
        const response = await fetch('http://localhost:3001/api/qq/comment/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: resourceId,
            content: newComment,
            biztype: qqCommentBizType,
            rootCommentId: commentId,
            parentCommentId: commentId,
            cookie: userCookie
          })
        })
        const result = await response.json()
        if (!isQQCommentMutationSuccessful(result)) {
          throw new Error(result.error || '回复发布失败')
        }
        finishCommentMutation('回复发表成功，已切换到最新评论')
      }
    } catch (error) {
      console.error('回复评论失败:', error)
      setActionError(error instanceof Error ? error.message : '回复评论失败，请重试')
    } finally {
      setIsSubmitting(false)
    }
  }

  const toggleReplies = async (comment: Comment) => {
    const willExpand = !expandedReplies.has(comment.commentId)
    setExpandedReplies(previous => {
      const next = new Set(previous)
      if (willExpand) next.add(comment.commentId)
      else next.delete(comment.commentId)
      return next
    })

    if (!willExpand || resourcePlatform !== 'netease' || (comment.replies?.length || 0) >= comment.replyCount) return

    try {
      const response = await fetch(
        `http://localhost:3001/api/netease/comment/floor?id=${encodeURIComponent(String(resourceId))}&parentCommentId=${comment.commentId}&limit=${Math.min(comment.replyCount, 50)}&type=${commentType}&cookie=${encodeURIComponent(userCookie)}`
      )
      const result = await response.json()
      if (!response.ok || result.code !== 200) throw new Error(result.message || result.error || '加载回复失败')
      const replies: Reply[] = (result.data?.comments || []).map((reply: any) => ({
        replyId: String(reply.commentId),
        content: reply.content || '',
        user: {
          nickname: reply.user?.nickname || '匿名用户',
          avatarUrl: reply.user?.avatarUrl || '',
          userId: reply.user?.userId?.toString()
        },
        time: Number(reply.time || 0),
        beRepliedUser: reply.beReplied?.[0]?.user?.nickname
      }))
      setAllComments(previous => previous.map(item => (
        item.commentId === comment.commentId ? { ...item, replies } : item
      )))
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '加载回复失败，请重试')
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        data-tv-scope
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ type: 'spring', damping: 25, stiffness: 300 }}
          className="relative w-[92vw] max-w-3xl max-h-[88vh] rounded-2xl shadow-2xl overflow-hidden border border-white/10 flex flex-col"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: resourceCoverUrl
              ? `linear-gradient(rgba(0, 0, 0, 0.85), rgba(0, 0, 0, 0.9)), url(${resourceCoverUrl})`
              : 'rgba(0, 0, 0, 0.9)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundBlendMode: 'darken'
          }}
        >
          {/* 内部模糊背景层 */}
          <div className="absolute inset-0 backdrop-blur-[100px] -z-10" />
          
          {/* 头部 */}
          <div className="flex-shrink-0 bg-black/20 backdrop-blur-xl border-b border-white/10 px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                {resourceCoverUrl && (
                  <img
                    src={resourceCoverUrl}
                    alt={resourceName}
                    className="w-12 h-12 rounded-lg object-cover shadow-lg"
                  />
                )}
                <div>
                  <h2 className="text-lg font-semibold text-white">{resourceName}</h2>
                  <p className="text-sm text-gray-300">{resourceSubtitle}</p>
                </div>
              </div>
              
              <div className="flex items-center space-x-2">
                {/* 发表评论按钮 - 仅登录后显示 */}
                {isLoggedIn && (
                  <button
                    onClick={() => {
                      setShowCommentInput(!showCommentInput)
                      setReplyingTo(null)
                      setTimeout(() => inputRef.current?.focus(), 100)
                    }}
                    className="px-4 py-1.5 bg-gradient-to-r from-pink-500 to-orange-500 hover:from-pink-600 hover:to-orange-600 text-white text-sm rounded-full transition-all flex items-center space-x-1"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    <span>{isPlaylistResource ? '发表评价' : '发表评论'}</span>
                  </button>
                )}
                
                {/* 关闭按钮 */}
                <button
                  onClick={onClose}
                  className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-white/10 transition-colors"
                >
                  <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            {isPlaylistResource && playlist && (
              <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-4 space-y-3 text-sm text-white/75">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {playlist.creator?.avatarUrl && (
                    <img src={playlist.creator.avatarUrl} alt={playlist.creator.nickname || '创建者'} className="w-7 h-7 rounded-full object-cover" />
                  )}
                  <span>创建者：{playlist.creator?.nickname || '未知用户'}</span>
                  {playlist.createTime && <span>创建日期：{new Date(playlist.createTime).toLocaleDateString('zh-CN')}</span>}
                  {typeof playlist.commentCount === 'number' && <span>评价：{playlist.commentCount}</span>}
                </div>
                <div className="whitespace-pre-wrap leading-6 text-white/70">
                  {playlistDescription}
                </div>
                {Array.isArray(playlist.tags) && playlist.tags.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {playlist.tags.map(tag => (
                      <span key={tag} className="px-2.5 py-1 rounded-full bg-white/10 text-xs text-white/75">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 视图切换按钮 */}
            <div className="flex items-center space-x-2 mt-3">
              <button
                onClick={() => setViewMode('hot')}
                className={`px-4 py-1.5 rounded-full text-sm transition-all ${
                  viewMode === 'hot'
                    ? 'bg-white/20 text-white font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-white/10'
                }`}
              >
                {isPlaylistResource ? '热门评价' : '精彩评论'}
              </button>
              <button
                onClick={() => setViewMode('latest')}
                className={`px-4 py-1.5 rounded-full text-sm transition-all ${
                  viewMode === 'latest'
                    ? 'bg-white/20 text-white font-medium'
                    : 'text-gray-400 hover:text-white hover:bg-white/10'
                }`}
              >
                {isPlaylistResource ? '最新评价' : '最新评论'}
              </button>
            </div>
            {actionError && (
              <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                <span>{actionError}</span>
                <button onClick={() => setActionError(null)} className="text-red-200/70 hover:text-white" aria-label="关闭错误提示">×</button>
              </div>
            )}
            {actionSuccess && (
              <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
                <span>{actionSuccess}</span>
                <button onClick={() => setActionSuccess(null)} className="text-emerald-200/70 hover:text-white" aria-label="关闭成功提示">×</button>
              </div>
            )}
          </div>

          {/* 发表评论输入框 */}
          <AnimatePresence>
            {showCommentInput && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="flex-shrink-0 bg-black/30 backdrop-blur-xl border-b border-white/10 px-6 py-4 overflow-hidden"
              >
                {replyingTo && (
                  <div className="mb-2 flex items-center justify-between text-xs text-blue-400 bg-blue-500/10 px-3 py-2 rounded-lg">
                    <span>回复 @{replyingTo.username}</span>
                    <button
                      onClick={() => {
                        setReplyingTo(null)
                        setShowCommentInput(false)
                        setNewComment('')
                      }}
                      className="text-gray-400 hover:text-white"
                    >
                      取消
                    </button>
                  </div>
                )}
                <div className="flex items-end space-x-2">
                  <textarea
                    ref={inputRef}
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder={replyingTo ? `回复 @${replyingTo.username}` : (isPlaylistResource ? '发表歌单评价...' : '发表评论...')}
                    className="flex-1 bg-white/10 border border-white/20 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-pink-500 focus:border-transparent resize-none"
                    rows={2}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        if (replyingTo) {
                          handleReply(replyingTo.commentId)
                        } else {
                          handleSubmitComment()
                        }
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      if (replyingTo) {
                        handleReply(replyingTo.commentId)
                      } else {
                        handleSubmitComment()
                      }
                    }}
                    disabled={!newComment.trim() || isSubmitting}
                    className="px-4 py-2 bg-gradient-to-r from-pink-500 to-orange-500 hover:from-pink-600 hover:to-orange-600 disabled:from-gray-600 disabled:to-gray-600 text-white rounded-lg transition-all flex items-center space-x-1 disabled:cursor-not-allowed"
                  >
                    <Send className="w-4 h-4" />
                    <span>{isSubmitting ? '发送中…' : '发送'}</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 评论列表 */}
          <div ref={(el) => { commentOuterRef.current = el }} onScroll={handleScroll} className="flex-1 overflow-y-auto custom-scrollbar">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-8 h-8 border-4 border-pink-500 border-t-transparent rounded-full animate-spin mb-3"></div>
                <p className="text-gray-300">加载评论中...</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-12">
                <svg className="w-16 h-16 text-gray-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-gray-300">{error}</p>
              </div>
            ) : displayComments.length === 0 && hotComments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <svg className="w-16 h-16 text-gray-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-gray-300">
                  {isPlaylistResource ? '暂无评价，快来发表第一条评价吧' : '暂无评论，快来发表第一条评论吧'}
                </p>
              </div>
            ) : (
              <List<CommentRowData>
                listRef={commentListRef}
                className="custom-scrollbar"
                style={{ height: '100%', width: '100%' }}
                onScroll={handleScroll}
                rowCount={commentRows.length}
                rowHeight={dynamicRowHeight}
                overscanCount={6}
                rowComponent={CommentVirtualRow}
                rowProps={{
                  rows: commentRows,
                  expandedReplies,
                  isLoggedIn,
                  currentUserId,
                  isPlaylistResource,
                  onLike: (target) => void handleLike(target.commentId),
                  onReply: (target) => {
                    setReplyingTo({ commentId: target.commentId, username: target.user.nickname })
                    setShowCommentInput(true)
                    setTimeout(() => inputRef.current?.focus(), 100)
                  },
                  onDelete: (target) => setPendingDeleteComment(target),
                  onToggleReplies: (target) => void toggleReplies(target),
                  isLoadingMore,
                  onLoadMore: () => loadComments(false),
                }}
              />
            )}
          </div>
        </motion.div>
      </motion.div>

      <DeleteCommentModal
        show={Boolean(pendingDeleteComment)}
        loading={deleteLoading}
        onClose={() => {
          if (!deleteLoading) setPendingDeleteComment(null)
        }}
        onConfirm={() => {
          if (pendingDeleteComment) void handleDelete(pendingDeleteComment.commentId)
        }}
      />

      {/* 回到顶部按钮 - 相对于评论弹窗定位 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[110] flex items-center justify-center"
        style={{ pointerEvents: 'none' }}
      >
        <div className="relative w-[92vw] max-w-3xl max-h-[88vh]" style={{ pointerEvents: 'none' }}>
          <div className="absolute -right-16 bottom-0" style={{ pointerEvents: 'auto' }}>
            <ScrollToTop 
              containerRef={scrollContainerRef} 
              threshold={200}
              playerTheme="dark"
              position="absolute"
              offsetRight={0}
              offsetBottom={0}
            />
          </div>
        </div>
      </motion.div>

      {/* 自定义滚动条样式 */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 8px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.05);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.2);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.3);
        }
      `}</style>
    </AnimatePresence>
  )
}
