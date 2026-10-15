// 官方 PC 客户端风格评论面板（歌曲/歌单共用，嵌入二级页的区块，不弹全局弹窗）。
//
// 数据链路与旧版 TraditionalComments 完全一致（网易云 /netease/comment/music、QQ /qq/comment、
// 汽水 fetchSodaComments），只是换成本基件的皮肤：精彩评论 + 最新评论两段 + 总数 + 加载更多。
// 点赞/回复：仓库没有对应的服务层包装（CommentModal 是裸 fetch 的私有实现），按约定保持只读，
// 点赞数仅作展示。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Heart } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { getProxiedImageUrl } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'
import { getPlatformCookie } from '../../services/platforms'
import { fetchSodaComments, type SodaComment } from '../../services/sodaService'
import { createTtlCache } from '../../utils/ttlCache'
import { getApiBase } from '../../services/apiConfig'
import { PcEmpty, PcGhostButton, PcListFooter, pcTheme, type PcSkin, type PcTone } from './pcKit'
import type { PcActions } from './types'
import { cookieHeaders } from '../../services/cookieRequest'

interface CommentItem {
  commentId: string
  content: string
  user: { nickname: string; avatarUrl: string; userId?: string }
  time: number | string // 毫秒时间戳或现成显示文本（汽水评论两者皆有可能）
  likedCount: number
  replyCount: number
}

export interface PcCommentsProps {
  platform: MusicPlatform
  /** 歌曲评论资源 id（resourceIdKind='song' 时使用） */
  songId?: string | number
  /** 评论资源 id：歌单评论传歌单 id；歌曲评论可与 songId 二选一 */
  resourceId?: string | number
  resourceIdKind: 'song' | 'playlist'
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  /** 预留：评论区的跨页动作（本期评论只读，未消费） */
  actions?: PcActions
  /** 隐藏保活页为 false：跳过取数 */
  active?: boolean
}

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

/** 汽水评论 → 组件展示结构（简版：列表+游标分页，无点赞/回复交互） */
function normalizeSoda(raw: SodaComment): CommentItem | null {
  const content = String(raw.content || '')
  if (!content || !raw.id) return null
  return {
    commentId: String(raw.id),
    content,
    user: {
      nickname: String(raw.user?.name || '匿名用户'),
      avatarUrl: String(raw.user?.avatarUrl || ''),
    },
    time: raw.time,
    likedCount: Number(raw.likes || 0),
    replyCount: Array.isArray(raw.replies) ? raw.replies.length : 0,
  }
}

// 评论首页（重置页）的本会话缓存：同一个资源反复进入评论页签不该重打接口。
// 只存成功且非空的结果，不落盘；分页游标一并存，缓存命中后「加载更多」仍能续上。
type CommentsPage = { comments: CommentItem[]; hotComments: CommentItem[]; hasMore: boolean; total?: number; cursor?: string }
const commentsCache = createTtlCache<CommentsPage>({ ttlMs: 60 * 1000, maxEntries: 12 })

/** 网易云评论 type：0=歌曲、2=歌单；QQ 的 BizType：1=歌曲、3=歌单（与 CommentModal 同口径）。 */
const neteaseCommentType = (kind: 'song' | 'playlist') => (kind === 'playlist' ? 2 : 0)
const qqCommentBizType = (kind: 'song' | 'playlist') => (kind === 'playlist' ? 3 : 1)

function PcComments({ platform, songId, resourceId, resourceIdKind, chrome, actions, active = true }: PcCommentsProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  // 评论资源 id：歌单用歌单 id，歌曲用 songId（汽水的 Song.id 是截断数值，真实曲目 id 在 mid —— 但汽水不进 PC 页，保留防御）
  const resourceKey = String(resourceId ?? songId ?? '')
  const [comments, setComments] = useState<CommentItem[]>([])
  const [hotComments, setHotComments] = useState<CommentItem[]>([])
  const [total, setTotal] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)
  const offsetRef = useRef(0)
  const pageRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const loadedKeyRef = useRef('')
  // 汽水评论游标：soda 接口为游标分页（与上方页码分页不同），组件内部自行维护
  const sodaCursorRef = useRef<string | undefined>(undefined)

  const cacheKey = `${platform}:${resourceIdKind}:${resourceKey}`

  const load = useCallback(async (reset: boolean) => {
    if (!resourceKey) return
    const request = ++requestRef.current
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setError('')
    if (reset) setLoading(true)
    try {
      let list: CommentItem[] = []
      let hot: CommentItem[] = []
      let more = false
      let nextTotal: number | undefined
      if (platform === 'netease') {
        // 精彩评论优先（sortType=2），comments 列表随之返回；offset 页码分页
        const endpoint = `${getApiBase()}/netease/comment/music?id=${encodeURIComponent(resourceKey)}&limit=30&offset=${reset ? 0 : offsetRef.current}&sortType=2&type=${neteaseCommentType(resourceIdKind)}`
        const response = await fetch(endpoint, { signal: controller.signal, headers: cookieHeaders(getPlatformCookie('netease')) })
        const data = await response.json()
        // 失败要落到 error/重试态，不能静默渲染成「还没有评论」
        if (!response.ok || data.code !== 200) throw new Error(data?.message || data?.error || '网易云评论加载失败')
        hot = (data.data?.hotComments || []).map(normalizeNetease).filter(Boolean) as CommentItem[]
        list = (data.data?.comments || []).map(normalizeNetease).filter(Boolean) as CommentItem[]
        more = Boolean(data.data?.hasMore)
        nextTotal = Number(data.data?.total || data.data?.totalCount || 0) || undefined
      } else if (platform === 'qq') {
        // QQ：pagenum 页码分页（0 起，服务端会把 pagenum 映射成上游 pageNo=pagenum+1）；
        // 歌单走 biztype=3。首页必须传 0，传 1 会直接跳过第一条评论。
        const pageNumber = reset ? 0 : pageRef.current + 1
        const endpoint = `${getApiBase()}/qq/comment?id=${encodeURIComponent(resourceKey)}&pagenum=${pageNumber}&pagesize=20&type=hot&biztype=${qqCommentBizType(resourceIdKind)}`
        const response = await fetch(endpoint, { signal: controller.signal, headers: cookieHeaders(getPlatformCookie('qq')) })
        const data = await response.json()
        if (!response.ok || data.result !== 0 || !data.data) throw new Error(data?.message || 'QQ 音乐评论加载失败')
        hot = (data.data?.hotComments || []).map(normalizeQQ).filter(Boolean) as CommentItem[]
        list = (data.data?.comments || []).map(normalizeQQ).filter(Boolean) as CommentItem[]
        more = Boolean(data.data.hasMore)
        nextTotal = Number(data.data?.total || 0) || undefined
      } else if (platform === 'soda' && resourceIdKind === 'song') {
        // 汽水：游标分页（首页不传 cursor）；只有歌曲评论
        const requestCursor = reset ? undefined : sodaCursorRef.current
        const page = await fetchSodaComments(resourceKey, requestCursor, 20)
        if (request !== requestRef.current) return
        sodaCursorRef.current = page.cursor ?? undefined
        list = page.comments.map(normalizeSoda).filter(Boolean) as CommentItem[]
        more = page.hasMore
      }
      if (request !== requestRef.current || controller.signal.aborted) return
      // 加载更多时若没有新内容，说明已到底，停止继续翻页
      const effectiveMore = reset ? more : (more && list.length > 0)
      if (reset) {
        setComments(list)
        setHotComments(hot)
        setTotal(nextTotal)
        offsetRef.current = 30
        pageRef.current = 0
        // 只缓存成功且非空的首页结果（空/失败不缓存，下次仍会重试）
        if (list.length > 0 || hot.length > 0) {
          commentsCache.set(cacheKey, { comments: list, hotComments: hot, hasMore: effectiveMore, total: nextTotal, cursor: sodaCursorRef.current })
        }
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
      // 晚到/被 abort 的旧请求静默丢弃
      if (request !== requestRef.current || controller.signal.aborted) return
      setError('加载评论失败，请重试')
    } finally {
      if (request === requestRef.current && !controller.signal.aborted) setLoading(false)
    }
  }, [resourceKey, platform, resourceIdKind, cacheKey])

  useEffect(() => {
    if (!active) return
    offsetRef.current = 0
    pageRef.current = 0
    sodaCursorRef.current = undefined
    const cached = commentsCache.get(cacheKey)
    if (cached) {
      // 本会话刚看过同一资源的评论：直接复用，不再打接口
      loadedKeyRef.current = cacheKey
      offsetRef.current = 30
      pageRef.current = 1
      sodaCursorRef.current = cached.cursor
      setComments(cached.comments)
      setHotComments(cached.hotComments)
      setTotal(cached.total)
      setHasMore(cached.hasMore)
      setError('')
      setLoading(false)
      return
    }
    // 同 key 重跑（保活下的重放等）保留已有列表，不先清空；换了资源才清空
    if (loadedKeyRef.current !== cacheKey) {
      setComments([])
      setHotComments([])
      setHasMore(false)
      setTotal(undefined)
    }
    loadedKeyRef.current = cacheKey
    void load(true)
  }, [active, cacheKey, load])

  // 卸载时中断进行中的请求，避免 setState 到已卸载组件
  useEffect(() => () => controllerRef.current?.abort(), [])

  const totalCount = total ?? (hotComments.length + comments.length)
  const totalLabel = totalCount > 0 ? `共 ${totalCount} 条` : ''

  if (!resourceKey) {
    return <PcEmpty theme={theme} title="暂无评论" description="没有可用的评论资源" />
  }

  return (
    <div className="pb-2">
      {/* 标题行：评论 + 总数 */}
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className={`text-[17px] font-semibold ${theme.text}`}>评论</h2>
        {totalLabel ? <span className={`text-[12px] ${theme.faint}`}>{totalLabel}</span> : null}
      </div>

      {error ? (
        <PcEmpty
          theme={theme}
          title="加载评论失败"
          description="网络似乎不太顺畅，稍后再试试"
          action={<PcGhostButton label="重试" theme={theme} onClick={() => void load(true)} />}
        />
      ) : (
        <>
          {loading && comments.length === 0 && hotComments.length === 0 && (
            <div className={`py-14 text-center text-[13px] ${theme.faint}`}>正在加载评论…</div>
          )}

          {hotComments.length > 0 && (
            <section className="mb-5">
              <div className={`mb-2 text-[12px] font-medium ${theme.subtle}`}>精彩评论</div>
              <div className="space-y-3">
                {hotComments.map((comment, index) => (
                  <CommentRow key={`hot-${comment.commentId}-${index}`} comment={comment} theme={theme} accent={accent} />
                ))}
              </div>
            </section>
          )}

          {comments.length > 0 && (
            <section>
              <div className={`mb-2 text-[12px] font-medium ${theme.subtle}`}>最新评论{totalCount > 0 ? ` · ${totalCount}` : ''}</div>
              <div className="space-y-3">
                {comments.map((comment, index) => (
                  <CommentRow key={`${comment.commentId}-${index}`} comment={comment} theme={theme} accent={accent} />
                ))}
              </div>
            </section>
          )}

          {comments.length === 0 && hotComments.length === 0 && !loading && !error && (
            <PcEmpty theme={theme} title="还没有评论" description="抢首条评论吧" />
          )}

          {hasMore ? (
            <div className="py-4 text-center">
              <PcGhostButton label={loading ? '加载中…' : '加载更多'} theme={theme} disabled={loading} onClick={() => void load(false)} />
            </div>
          ) : comments.length + hotComments.length > 0 ? (
            <PcListFooter theme={theme} label="暂无更多评论" />
          ) : null}
        </>
      )}
    </div>
  )
}

/** 单条评论（只读展示：头像 / 昵称 / 时间 / 内容 / 点赞数 / 回复数）。 */
function CommentRow({ comment, theme, accent }: { comment: CommentItem; theme: ReturnType<typeof pcTheme>; accent: string }) {
  return (
    <div className={`flex gap-3 rounded-lg p-3 ${theme.surface}`}>
      {comment.user.avatarUrl ? (
        <CachedImage
          src={getProxiedImageUrl(comment.user.avatarUrl)}
          alt={comment.user.nickname}
          className="h-8 w-8 shrink-0 rounded-full object-cover"
          role="card"
          fallback={(
            <span className="flex h-8 w-8 items-center justify-center rounded-full text-[12px] text-white" style={{ background: accent }}>
              {comment.user.nickname.slice(0, 1) || '友'}
            </span>
          )}
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] text-white" style={{ background: accent }}>
          {comment.user.nickname.slice(0, 1) || '友'}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={`truncate text-[12px] font-medium ${theme.text}`}>{comment.user.nickname}</span>
          <span className={`shrink-0 text-[10px] ${theme.faint}`}>{formatTime(comment.time)}</span>
        </div>
        <p className={`mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 ${theme.text}`}>{comment.content}</p>
        <div className={`mt-1.5 flex items-center gap-3 text-[10px] ${theme.faint}`}>
          {/* 只读点赞数：仓库没有评论点赞的服务层包装，不做假交互 */}
          <span className="flex items-center gap-1"><Heart className="h-3 w-3" />{comment.likedCount || ''}</span>
          {comment.replyCount > 0 && <span>{comment.replyCount} 条回复</span>}
        </div>
      </div>
    </div>
  )
}

export default memo(PcComments)
