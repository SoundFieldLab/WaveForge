// 传统模式独立评论弹层：不复用全局 CommentModal，数据仍走本地 API，
// 但渲染完全采用传统模式自己的设计语言（纯展示 + 分页，不实现点赞/回复交互）。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Heart, MessageCircle, X } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getProxiedImageUrl } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import { platformLabel } from '../services/platforms'
import { fetchSodaComments, type SodaComment } from '../services/sodaService'

interface CommentItem {
  commentId: string
  content: string
  user: { nickname: string; avatarUrl: string; userId?: string }
  time: number | string // 毫秒时间戳或现成显示文本（汽水评论两者皆有可能）
  likedCount: number
  replyCount: number
}

const API_BASE = 'http://localhost:3001'
const getCookie = () => localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''

const formatDate = (ms: number) => {
  const date = new Date(Number.isFinite(ms) ? ms : 0)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

// 评论时间展示：兼容毫秒时间戳与「3天前」等现成文本（汽水评论的 time 两者皆有可能）
const formatTime = (value: number | string) => {
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return ''
    // 纯数字字符串视为毫秒时间戳，其余原样展示
    return /^\d+$/.test(text) ? formatDate(Number(text)) : text
  }
  return formatDate(value)
}

function normalizeNetease(raw: any): CommentItem | null {
  if (!raw || !raw.content) return null
  return {
    commentId: String(raw.commentId || raw.commentid || ''),
    content: String(raw.content || ''),
    user: {
      nickname: String(raw.user?.nickname || raw.nickname || '匿名用户'),
      avatarUrl: String(raw.user?.avatarUrl || raw.avatarurl || ''),
      userId: String(raw.user?.userId ?? ''),
    },
    // 网易云 time 为毫秒（v1/v2 一致）；兼容个别秒级返回
    time: Number(raw.time || 0) >= 1e12 ? Number(raw.time) : Number(raw.time || 0) * 1000,
    likedCount: Number(raw.likedCount || 0),
    replyCount: Number(raw.showFloorComment?.replyCount || raw.replyCount || 0),
  }
}

function normalizeQQ(raw: any): CommentItem | null {
  if (!raw) return null
  const rootId = String(raw.rootcommentid || raw.commentid || raw.time || '')
  const content = String(raw.rootcommentcontent || raw.commentcontent || '')
  if (!content) return null
  const isReplyEnvelope = Boolean(raw.commentid && raw.rootcommentid && raw.commentid !== raw.rootcommentid)
  return {
    commentId: rootId,
    content,
    user: {
      nickname: String(isReplyEnvelope ? raw.rootcommentnick : raw.nick || '匿名用户').replace(/^@/, ''),
      avatarUrl: isReplyEnvelope ? '' : String(raw.avatarurl || '').replace(/^http:/, 'https:'),
      userId: String(isReplyEnvelope ? raw.encrypt_rootcommentuin || raw.rootcommentuin || '' : raw.encrypt_uin || raw.uin || ''),
    },
    time: Number(raw.time || 0) * 1000,
    likedCount: Number(raw.praisenum || raw.likeNum || raw.like || 0),
    replyCount: Number(raw.middlecommentcontent?.length || 0),
  }
}

/** 汽水评论 → 组件展示结构（简版：列表+分页，无点赞/回复交互，与该组件其它平台能力对齐） */
function normalizeSoda(raw: SodaComment): CommentItem | null {
  const content = String(raw.content || '')
  if (!content || !raw.id) return null
  return {
    commentId: String(raw.id),
    content,
    user: {
      nickname: String(raw.user?.name || '匿名用户'),
      avatarUrl: String(raw.user?.avatarUrl || '')
    },
    time: raw.time,
    likedCount: Number(raw.likes || 0),
    replyCount: Array.isArray(raw.replies) ? raw.replies.length : 0
  }
}

interface TraditionalCommentsProps {
  song: Song
  accent: string
  isDark: boolean
  onClose: () => void
}

type CommentView = 'hot' | 'latest'

function TraditionalComments({ song, accent, isDark, onClose }: TraditionalCommentsProps) {
  const [view, setView] = useState<CommentView>('hot')
  const [comments, setComments] = useState<CommentItem[]>([])
  const [hotComments, setHotComments] = useState<CommentItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const offsetRef = useRef(0)
  const pageRef = useRef(0)
  const requestRef = useRef(0)
  // 汽水评论游标：soda 接口为游标分页（与上方页码分页不同），组件内部自行维护
  const sodaCursorRef = useRef<string | undefined>(undefined)

  const platform = (song?.platform || 'netease') as MusicPlatform
  const muted = isDark ? 'text-white/50' : 'text-slate-500'


  const load = useCallback(async (reset: boolean) => {
    if (!song) return
    const requestId = ++requestRef.current
    // 汽水的 Song.id 是截断数值，真实曲目 id 保存在 mid
    const songId = platform === 'soda' ? String(song.mid || song.id || '') : (song.id || song.mid || '')
    setError('')
    if (reset) setLoading(true)
    try {
      let list: CommentItem[] = []
      let hot: CommentItem[] = []
      let more = false
      if (platform === 'netease') {
        const sortType = view === 'hot' ? 2 : 3
        const endpoint = `${API_BASE}/api/netease/comment/music?id=${encodeURIComponent(String(songId))}&limit=30&offset=${reset ? 0 : offsetRef.current}&sortType=${sortType}&type=0&cookie=${encodeURIComponent(getCookie())}`
        const response = await fetch(endpoint)
        const data = await response.json()
        if (data.code === 200) {
          hot = (data.data?.hotComments || []).map(normalizeNetease).filter(Boolean) as CommentItem[]
          list = (data.data?.comments || []).map(normalizeNetease).filter(Boolean) as CommentItem[]
          more = Boolean(data.data?.hasMore)
        }
      } else if (platform === 'qq') {
        const endpoint = `${API_BASE}/api/qq/comment?id=${encodeURIComponent(String(songId))}&pagenum=${reset ? 1 : pageRef.current + 1}&pagesize=20&type=${view}&biztype=1&cookie=${encodeURIComponent(getCookie())}`
        const response = await fetch(endpoint)
        const data = await response.json()
        if (data.result === 0 && data.data) {
          hot = (data.data?.hotComments || []).map(normalizeQQ).filter(Boolean) as CommentItem[]
          list = (data.data?.comments || []).map(normalizeQQ).filter(Boolean) as CommentItem[]
          more = Boolean(data.data.hasMore)
        }
      } else if (platform === 'soda') {
        // 汽水：游标分页（首页不传 cursor）；热门/最新视图共用同一份列表
        const requestCursor = reset ? undefined : sodaCursorRef.current
        const page = await fetchSodaComments(String(songId), requestCursor, 20)
        if (requestId !== requestRef.current) return
        sodaCursorRef.current = page.cursor ?? undefined
        list = page.comments.map(normalizeSoda).filter(Boolean) as CommentItem[]
        more = page.hasMore
      }
      if (requestId !== requestRef.current) return
      // 加载更多时若没有新内容，说明已到底，停止继续翻页
      const effectiveMore = reset ? more : (more && list.length > 0)
      if (reset) {
        setComments(list)
        setHotComments(hot)
        offsetRef.current = 30
        pageRef.current = 1
      } else {
        setComments(prev => {
          const merged = new Map(prev.map(item => [item.commentId, item]))
          list.forEach(item => merged.set(item.commentId, item))
          return Array.from(merged.values())
        })
        offsetRef.current += 30
        pageRef.current += 1
      }
      setHasMore(effectiveMore)
    } catch {
      if (requestId === requestRef.current) setError('加载评论失败，请重试')
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [song, platform, view])

  useEffect(() => {
    offsetRef.current = 0
    pageRef.current = 0
    sodaCursorRef.current = undefined
    setComments([])
    setHotComments([])
    void load(true)
  }, [song, view, load])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex h-16 shrink-0 items-center gap-3 border-b px-5 ${isDark ? 'border-white/10' : 'border-slate-200'}`}>
        <button type="button" onClick={onClose} className="rounded-full p-2 transition hover:bg-black/10" aria-label="关闭评论"><X className="h-5 w-5" /></button>
        <div className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${accent}22` }}><MessageCircle className="h-4 w-4" style={{ color: accent }} /></div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{song?.name}</div>
          <div className={`truncate text-xs ${muted}`}>{song?.artists?.map(artist => artist.name).join(' / ')} · {platformLabel(platform)}评论</div>
        </div>
      </header>
      <div className={`flex items-center gap-1 border-b px-5 py-2 ${isDark ? 'border-white/10' : 'border-slate-100'}`}>
        {(['hot', 'latest'] as CommentView[]).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => setView(value)}
            className="rounded-full px-3.5 py-1.5 text-xs transition"
            style={view === value ? { background: accent, color: '#fff' } : undefined}
          >
            {value === 'hot' ? '热门' : '最新'}
          </button>
        ))}
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {error && <div className={`py-10 text-center text-sm ${muted}`}>{error}</div>}
        {loading && comments.length === 0 && <div className={`py-14 text-center text-sm ${muted}`}>正在加载评论...</div>}
        {hotComments.length > 0 && (
          <section className="mb-5">
            <div className={`mb-2 text-xs font-medium ${muted}`}>精彩评论</div>
            <div className="space-y-3">
              {hotComments.map((comment, index) => <CommentRow key={`hot-${comment.commentId}-${index}`} comment={comment} accent={accent} isDark={isDark} />)}
            </div>
          </section>
        )}
        {comments.length > 0 && (
          <section>
            <div className={`mb-2 text-xs font-medium ${muted}`}>全部评论 · {comments.length}</div>
            <div className="space-y-3">
              {comments.map((comment, index) => <CommentRow key={`${comment.commentId}-${index}`} comment={comment} accent={accent} isDark={isDark} />)}
            </div>
          </section>
        )}
        {comments.length === 0 && !loading && !error && (
          <div className={`py-14 text-center text-sm ${muted}`}>还没有评论</div>
        )}
        {hasMore && (
          <div className="py-4 text-center">
            <button type="button" onClick={() => void load(false)} className="rounded-full border px-5 py-2 text-xs transition hover:bg-white/10" disabled={loading}>
              {loading ? '加载中...' : '加载更多'}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function CommentRow({ comment, accent, isDark }: { comment: CommentItem; accent: string; isDark: boolean }) {
  const muted = isDark ? 'text-white/50' : 'text-slate-500'
  return (
    <div className={`flex gap-3 rounded-2xl border p-3 ${isDark ? 'border-white/10 bg-white/[.03]' : 'border-slate-100 bg-slate-50/60'}`}>
      {comment.user.avatarUrl ? (
        <img src={getProxiedImageUrl(comment.user.avatarUrl)} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs text-white" style={{ background: accent }}>{comment.user.nickname.slice(0, 1)}</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{comment.user.nickname}</span>
          <span className={`shrink-0 text-[10px] ${muted}`}>{formatTime(comment.time)}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{comment.content}</p>
        <div className={`mt-1.5 flex items-center gap-3 text-[10px] ${muted}`}>
          <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{comment.likedCount}</span>
          {comment.replyCount > 0 && <span>{comment.replyCount} 条回复</span>}
        </div>
      </div>
    </div>
  )
}

export default memo(TraditionalComments)
